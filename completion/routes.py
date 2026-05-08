"""
completion/routes.py - Flask Blueprint for the completion-forecast service.

Endpoints:
    POST /completion/monte-carlo      - remaining-work MC finish-date forecast
    POST /completion/recovery-options - ranked crash + lag compression options
    GET  /completion/health           - health check

Caching: lazy-imports get_cached_result / set_cached_result from the main
app module, matching solver/routes.py.  Key is sha256 over the request
body.
"""

import hashlib
import json
import logging
import math
import os

import numpy as np
from flask import Blueprint, request, jsonify

from .monte_carlo import run_completion_mc, CompletionMCConfig
from .recovery import run_recovery_options, RecoveryConfig

logger = logging.getLogger(__name__)

completion_bp = Blueprint('completion', __name__, url_prefix='/completion')


@completion_bp.record_once
def _set_max_content_length(state):
    state.app.config.setdefault('MAX_CONTENT_LENGTH', 10 * 1024 * 1024)


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

MAX_PAYLOAD_BYTES = 10 * 1024 * 1024   # 10 MB
MAX_NODES         = 20_000
MAX_LINKS         = 100_000
MAX_ITERATIONS    = 5_000              # higher than solver's 1_000 -- MC only,
                                       # no per-sample CPM adjoint cost


# ---------------------------------------------------------------------------
# Lazy caching bridge (matches solver/routes.py)
# ---------------------------------------------------------------------------

_cache_fns = None


def _cache():
    global _cache_fns
    if _cache_fns is None:
        try:
            from app import get_cached_result, set_cached_result
            _cache_fns = (get_cached_result, set_cached_result)
        except Exception as exc:
            logger.info("Caching functions not available; completion "
                        "running without cache: %s", exc)
            _cache_fns = (None, None)
    return _cache_fns


from _cache_version import RESPONSE_SCHEMA_VERSION


def _cache_key(prefix, data):
    raw = json.dumps(data, sort_keys=True, default=str)
    return f"completion:{RESPONSE_SCHEMA_VERSION}:{prefix}:{hashlib.sha256(raw.encode()).hexdigest()}"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate_common(data):
    """Validate fields shared by /monte-carlo and /recovery-options.

    Returns (seen_ids, err_string_or_None).
    """
    nodes = data.get('nodes')
    if not isinstance(nodes, list):
        return None, 'nodes must be a list'
    if len(nodes) == 0:
        return None, 'No nodes provided'
    if len(nodes) > MAX_NODES:
        return None, f'Too many nodes ({len(nodes)}); limit is {MAX_NODES}'

    links = data.get('links', [])
    if not isinstance(links, list):
        return None, 'links must be a list'
    if len(links) > MAX_LINKS:
        return None, f'Too many links ({len(links)}); limit is {MAX_LINKS}'

    sd_raw = data.get('status_date')
    if not sd_raw:
        return None, 'status_date is required (ISO-8601)'
    # Validate parseability up-front so downstream monte_carlo /
    # recovery modules don't raise ValueError on a client typo and
    # surface it as a 500.  _parse_iso_to_ms treats naive inputs as
    # UTC, matching evm.helpers.safe_date, so results are stable
    # regardless of server timezone.
    if not isinstance(sd_raw, str):
        return None, 'status_date must be an ISO-8601 string'
    from .monte_carlo import _parse_iso_to_ms
    if _parse_iso_to_ms(sd_raw) is None:
        return None, f'status_date is not parseable ISO-8601: {sd_raw!r}'

    # Type-guard project_context.calendar numeric fields so the engine's
    # bare float(...) coercion can't turn client-side typos (null,
    # empty string, non-numeric) into 500s.
    pctx = data.get('project_context')
    if pctx is not None:
        if not isinstance(pctx, dict):
            return None, 'project_context must be an object'
        cal = pctx.get('calendar')
        if cal is not None:
            if not isinstance(cal, dict):
                return None, 'project_context.calendar must be an object'
            for key, lo, hi in (
                    ('hours_per_day',         0.01, 24.0),
                    ('working_days_per_week', 0.01, 7.0)):
                v = cal.get(key)
                if v is None:
                    continue
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    return None, (f'project_context.calendar.{key} '
                                  f'must be a number')
                if (not math.isfinite(fv)) or fv < lo or fv > hi:
                    return None, (f'project_context.calendar.{key} '
                                  f'must be in [{lo}, {hi}]')

    seen_ids = set()
    for i, node in enumerate(nodes):
        if not isinstance(node, dict):
            return None, f'nodes[{i}] must be an object'
        nid = node.get('ID', node.get('id'))
        if nid is None:
            return None, f'nodes[{i}] missing ID'
        sid = str(nid)
        if sid in seen_ids:
            return None, f'Duplicate activity ID: {nid}'
        seen_ids.add(sid)

        # Allow (0, '0', '', None) as milestone-zero -- matches the
        # EVM blueprint's _validate() in evm/routes.py and the MC /
        # recovery engines, which treat blank duration as zero rather
        # than rejecting.
        dur = node.get('Duration', node.get('duration', 0))
        if dur not in (0, '0', '', None):
            try:
                dur_f = float(dur)
            except (TypeError, ValueError):
                return None, f'nodes[{i}] (ID={nid}): Duration is not numeric'
            if math.isnan(dur_f) or math.isinf(dur_f) or dur_f < 0:
                return None, (f'nodes[{i}] (ID={nid}): Duration must be a '
                              f'finite non-negative number')

    for i, link in enumerate(links):
        if not isinstance(link, dict):
            return None, f'links[{i}] must be an object'
        src = link.get('source')
        tgt = link.get('target')
        if src is None or tgt is None:
            return None, f'links[{i}] missing source or target'
        if str(src) not in seen_ids:
            return None, f'links[{i}] references unknown source: {src}'
        if str(tgt) not in seen_ids:
            return None, f'links[{i}] references unknown target: {tgt}'

    return seen_ids, None


def _validate_mc_config(data):
    cfg = data.get('config')
    if not (cfg and isinstance(cfg, dict)):
        return None
    iters = cfg.get('iterations')
    if iters is not None:
        try:
            iters = int(iters)
        except (TypeError, ValueError):
            return 'config.iterations must be an integer'
        if iters < 1 or iters > MAX_ITERATIONS:
            return f'config.iterations must be 1-{MAX_ITERATIONS}'

    # Only default to {} when the key is truly absent / None -- `or {}`
    # would silently accept falsey non-dict values like `[]` / `""`.
    # A non-dict thresholds value (e.g. `[...]` or `"abc"`) would
    # otherwise AttributeError on `.get(...)` and surface as a 500;
    # reject up-front with a clear 400.
    thresholds = cfg.get('thresholds')
    if thresholds is None:
        thresholds = {}
    elif not isinstance(thresholds, dict):
        return 'config.thresholds must be an object'
    thresh_vals = {}
    for key in ('no_risk_below', 'normal_from', 'fat_tail_from'):
        v = thresholds.get(key)
        if v is not None:
            try:
                fv = float(v)
            except (TypeError, ValueError):
                return f'config.thresholds.{key} must be a number'
            if math.isnan(fv) or math.isinf(fv) or fv < 0 or fv > 1:
                return f'config.thresholds.{key} must be in [0, 1]'
            thresh_vals[key] = fv

    # Ordering: no_risk_below <= normal_from <= fat_tail_from.  Mixed
    # orderings silently produce nonsensical tier assignments.
    if ('no_risk_below' in thresh_vals and 'normal_from' in thresh_vals
            and thresh_vals['no_risk_below'] > thresh_vals['normal_from']):
        return ('config.thresholds.no_risk_below must be '
                '<= normal_from')
    if ('normal_from' in thresh_vals and 'fat_tail_from' in thresh_vals
            and thresh_vals['normal_from'] > thresh_vals['fat_tail_from']):
        return ('config.thresholds.normal_from must be <= fat_tail_from')

    # Same falsey-coerce guard as thresholds above.
    caps = cfg.get('caps')
    if caps is None:
        caps = {}
    elif not isinstance(caps, dict):
        return 'config.caps must be an object'
    cap_checks = [
        ('min_mult',      0.0,  10.0),
        ('max_mult_base', 1.0,  100.0),
        ('max_mult_high', 1.0,  1000.0),
    ]
    cap_vals = {}
    for key, lo, hi in cap_checks:
        if key not in caps:
            continue
        try:
            fv = float(caps[key])
        except (TypeError, ValueError):
            return f'config.caps.{key} must be a number'
        if math.isnan(fv) or math.isinf(fv) or fv < lo or fv > hi:
            return f'config.caps.{key} must be in [{lo}, {hi}]'
        cap_vals[key] = fv
    if ('min_mult' in cap_vals and 'max_mult_base' in cap_vals
            and cap_vals['min_mult'] > cap_vals['max_mult_base']):
        return 'config.caps.min_mult must be <= max_mult_base'
    if ('max_mult_base' in cap_vals and 'max_mult_high' in cap_vals
            and cap_vals['max_mult_base'] > cap_vals['max_mult_high']):
        return 'config.caps.max_mult_base must be <= max_mult_high'

    # Custom classes can extend / shadow the built-in registry for one
    # request.  Validate first so reference_class lookup below resolves
    # against the merged registry.
    custom = cfg.get('custom_reference_classes')
    if custom is not None:
        from solver.reference_classes import validate_custom_classes
        errs = validate_custom_classes(custom)
        if errs:
            return 'config.custom_reference_classes: ' + '; '.join(errs[:5])

    overrides = cfg.get('reference_class_overrides')
    if overrides is not None:
        if not isinstance(overrides, dict):
            return 'config.reference_class_overrides must be an object'
        if 'base' not in overrides or not isinstance(overrides['base'], str):
            return ('config.reference_class_overrides.base is required '
                    'and must be a string')
        if 'overrides' in overrides and not isinstance(overrides['overrides'], dict):
            return 'config.reference_class_overrides.overrides must be an object'
        # Try resolving the base eagerly so the user gets a clear error
        # at request time (not deep inside the MC).
        from solver.reference_classes import (
            get_reference_class, suggest_reference_class, effective_registry,
        )
        merged = effective_registry(custom_classes=custom)
        base_class = get_reference_class(overrides['base'], registry=merged)
        if base_class is None:
            suggestions = suggest_reference_class(
                overrides['base'], registry=merged)
            hint = (f' did you mean: {", ".join(suggestions)}?'
                    if suggestions else '')
            return (f'config.reference_class_overrides.base '
                    f'"{overrides["base"]}" not recognised.{hint}')

    rc = cfg.get('reference_class')
    if rc is not None:
        if not isinstance(rc, str) or not rc:
            return 'config.reference_class must be a non-empty string'
        from solver.reference_classes import (
            get_reference_class, suggest_reference_class, effective_registry,
        )
        merged = effective_registry(custom_classes=custom)
        if get_reference_class(rc, registry=merged) is None:
            suggestions = suggest_reference_class(rc, registry=merged)
            if suggestions:
                hint = f' did you mean: {", ".join(suggestions)}?'
            else:
                # Only spell out the full list when no useful suggestion
                # exists -- keeps error messages from being walls of text.
                hint = (' supported classes: '
                        + ', '.join(sorted(merged.keys())))
            return (f'config.reference_class "{rc}" not recognised.'
                    + hint)
    return None


def _validate_recovery_config(data):
    cfg = data.get('config')
    if not (cfg and isinstance(cfg, dict)):
        return None
    # (key, lo, hi, integer_only).  Integer-only fields are used as
    # slice / count indices downstream and must not accept 10.5 -- that
    # previously turned a client error into a 500 at `candidates[:cfg.x]`.
    checks = [
        ('max_risk_buffer_days',         0.0,  365.0,    False),
        ('max_recovery_options',         1,    200,      True),
        ('max_lag_options',              0,    200,      True),
        ('min_crashable_hours',          0.0,  10_000.0, False),
        ('min_lag_days_for_compression', 0.0,  365.0,    False),
        ('lag_compression_factor',       0.0,  1.0,      False),
    ]
    for key, lo, hi, int_only in checks:
        if key not in cfg:
            continue
        try:
            fv = float(cfg[key])
        except (TypeError, ValueError):
            return f'config.{key} must be a number'
        if math.isnan(fv) or math.isinf(fv) or fv < lo or fv > hi:
            return f'config.{key} must be in [{lo}, {hi}]'
        if int_only and not float(fv).is_integer():
            return f'config.{key} must be an integer'
    return None


def _validate(data):
    """Validation for /completion/monte-carlo."""
    _, err = _validate_common(data)
    if err:
        return err
    return _validate_mc_config(data)


def _validate_recovery(data):
    """Validation for /completion/recovery-options."""
    _, err = _validate_common(data)
    if err:
        return err
    # Parse the optional finish fields here rather than accepting any
    # non-empty string -- the engine silently coerces unparseable dates
    # to None (which makes risk_buffer_days collapse to 0 and hides the
    # caller's mistake), so treat a malformed ISO as a 400.
    from .monte_carlo import _parse_iso_to_ms
    for key in ('planned_finish', 'expected_finish', 'p80_finish'):
        v = data.get(key)
        if v is None:
            continue
        if not isinstance(v, str) or not v:
            return f'{key} must be an ISO-8601 date string or null'
        if _parse_iso_to_ms(v) is None:
            return f'{key} is not a parseable ISO-8601 date: {v!r}'
    return _validate_recovery_config(data)


def _parse_request(validator=_validate):
    if request.content_length and request.content_length > MAX_PAYLOAD_BYTES:
        return None, (jsonify({'error': 'Payload too large (limit: 10 MB)'}), 413)

    data = request.get_json(force=True, silent=True)
    # Use `is None` rather than truthiness so an empty-but-valid `{}`
    # body proceeds to validator, which returns a useful field-level
    # error instead of the misleading "Invalid or missing JSON body".
    if data is None:
        return None, (jsonify({'error': 'Invalid or missing JSON body'}), 400)
    if not isinstance(data, dict):
        # validators do data.get(...); a bare list/string body would
        # raise AttributeError and turn a client error into a 500.
        return None, (jsonify({
            'error': 'JSON root must be an object'}), 400)

    err = validator(data)
    if err:
        return None, (jsonify({'error': err}), 400)
    return data, None


def _serialise(obj):
    """Recursively convert numpy types + non-finite floats to JSON-safe
    values.  NaN and Infinity become `null` because browser JSON.parse
    rejects 'NaN' / 'Infinity' literals; callers should treat null as
    a non-finite indicator.  Mirrors evm/routes.py::_serialise so both
    services have the same cross-runtime contract.
    """
    if isinstance(obj, dict):
        return {k: _serialise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialise(v) for v in obj]
    if isinstance(obj, np.ndarray):
        # Recurse so each element is scrubbed (tolist() preserves
        # NaN / Infinity which json.dumps then emits as invalid JSON).
        return [_serialise(v) for v in obj.tolist()]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        obj = float(obj)
    if isinstance(obj, float):
        if not math.isfinite(obj):
            return None
        return obj
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@completion_bp.route('/monte-carlo', methods=['POST', 'OPTIONS'])
def monte_carlo():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})

    data, err = _parse_request()
    if err:
        return err

    get_fn, set_fn = _cache()
    # Skip the SHA256(json.dumps(sort_keys)) work entirely when caching
    # is disabled / unavailable -- avoids hashing a 20K-node payload
    # for nothing.
    key = _cache_key('mc', data) if (get_fn or set_fn) else None
    if get_fn and key is not None:
        cached = get_fn(key)
        # `is not None` so an empty dict (or any falsey payload)
        # still counts as a hit; matches the `data is None` parse guard.
        if cached is not None:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        result = run_completion_mc(
            nodes=data['nodes'],
            links=data.get('links', []),
            status_date=data['status_date'],
            activity_metadata=data.get('activity_metadata', {}),
            project_context=data.get('project_context', {}),
            config=CompletionMCConfig.from_dict(data.get('config', {})),
        )
        result = _serialise(result)
        result['cache_hit'] = False
        if set_fn and key is not None:
            set_fn(key, result)
        return jsonify(result)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.exception("Completion MC failed: %s", e)
        return jsonify({'error': 'Internal completion-service error'}), 500


@completion_bp.route('/recovery-options', methods=['POST', 'OPTIONS'])
def recovery_options():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})

    data, err = _parse_request(validator=_validate_recovery)
    if err:
        return err

    get_fn, set_fn = _cache()
    key = _cache_key('recovery', data) if (get_fn or set_fn) else None
    if get_fn and key is not None:
        cached = get_fn(key)
        # `is not None` so an empty dict (or any falsey payload)
        # still counts as a hit; matches the `data is None` parse guard.
        if cached is not None:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        result = run_recovery_options(
            nodes=data['nodes'],
            links=data.get('links', []),
            status_date=data['status_date'],
            planned_finish=data.get('planned_finish'),
            expected_finish=data.get('expected_finish'),
            p80_finish=data.get('p80_finish'),
            activity_metadata=data.get('activity_metadata', {}),
            project_context=data.get('project_context', {}),
            config=RecoveryConfig.from_dict(data.get('config', {})),
        )
        result = _serialise(result)
        result['cache_hit'] = False
        if set_fn and key is not None:
            set_fn(key, result)
        return jsonify(result)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.exception("Recovery options failed: %s", e)
        return jsonify({'error': 'Internal completion-service error'}), 500


@completion_bp.route('/register-outcome', methods=['POST', 'OPTIONS'])
def register_outcome_route():
    """Store a project outcome record (predicted-vs-actual) for later
    calibration analysis.  See completion/outcomes.py for the schema.

    Lightweight: validates + writes; doesn't itself update any
    distribution parameters.  The calibration-report endpoint
    aggregates accumulated outcomes into ratios the customer can use
    to validate (or refute) the reference-class percentiles.
    """
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})
    # Same payload-size guard the heavy-compute endpoints use, so the
    # outcome registry isn't an unbounded ingestion path.  Outcome
    # records are small (kilobytes); a 10 MB ceiling rejects clearly-
    # abusive payloads without rejecting any legitimate use.
    if (request.content_length is not None
            and request.content_length > MAX_PAYLOAD_BYTES):
        return jsonify({'error': 'Payload too large (limit: 10 MB)'}), 413
    data = request.get_json(force=True, silent=True)
    # Same `is None` guard as the shared _parse_request -- `{}` is a
    # valid root that should fall through to validate_outcome and
    # surface a missing-fields error.
    if data is None:
        return jsonify({'error': 'Invalid or missing JSON body'}), 400
    if not isinstance(data, dict):
        return jsonify({'error': 'JSON root must be an object'}), 400
    from .outcomes import validate_outcome, register_outcome
    errs = validate_outcome(data)
    if errs:
        return jsonify({'error': '; '.join(errs)}), 400
    try:
        stored = register_outcome(data)
        return jsonify({'status': 'stored', 'record': stored})
    except Exception as exc:
        logger.exception('register_outcome failed: %s', exc)
        return jsonify({'error': 'Internal storage error'}), 500


@completion_bp.route('/calibration-report', methods=['GET', 'OPTIONS'])
def calibration_report_route():
    """Aggregated empirical calibration of accumulated outcomes.

    Query params:
        ?reference_class=oil_gas_offshore  -- filter to one class

    Returns ratios of (actual_overrun_days / predicted_P80_overrun_days)
    per reference class.  A mean ratio >> 1 is the LinkedIn-discussion
    signature ("P80 acts like P10") -- the customer can decide whether
    to tighten the corresponding percentile_factors in their custom
    classes or pick a fatter-tail base.
    """
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})
    rc = request.args.get('reference_class')
    # Reject Redis SCAN glob metacharacters in the query param before
    # forwarding to calibration_report.  Prevents a caller from
    # widening the scan to other classes via `*`/`?`/`[`.
    if rc is not None:
        from .outcomes import _is_safe_id
        if rc and not _is_safe_id(rc):
            return jsonify({
                'error': "reference_class must contain only letters, "
                         "digits, '_', '-', '.'"}), 400
    from .outcomes import calibration_report
    try:
        return jsonify(calibration_report(reference_class=rc))
    except Exception as exc:
        logger.exception('calibration_report failed: %s', exc)
        return jsonify({'error': 'Internal report error'}), 500


@completion_bp.route('/reference-classes', methods=['GET', 'OPTIONS'])
def reference_classes():
    """Discovery endpoint: list all built-in + env-loaded reference
    classes with their metadata + citations.

    Useful for the frontend to populate a "project sector" dropdown
    without hardcoding the list, and for ops to verify which classes
    a given environment has loaded (env-var extension visibility).
    """
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})
    from solver.reference_classes import (
        list_reference_classes, REFERENCE_CLASS_TIERS,
        EXTERNAL_CLASS_TIERS, ALIASES, effective_registry,
    )
    # Don't leak the server filesystem path -- expose only whether an
    # external registry is configured.  The actual location is an
    # operator-side concern; the frontend only needs to know whether
    # additional classes might be present beyond the built-ins.
    return jsonify({
        'classes':            list_reference_classes(effective_registry()),
        'aliases':            ALIASES,
        'builtin_count':      len(REFERENCE_CLASS_TIERS),
        'external_count':     len(EXTERNAL_CLASS_TIERS),
        'external_configured': bool(
            os.environ.get('PYTH_REFERENCE_CLASSES_PATH')),
    })


@completion_bp.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'module': 'completion-forecast',
        'endpoints': [
            '/completion/monte-carlo',
            '/completion/recovery-options',
            '/completion/reference-classes',
            '/completion/register-outcome',
            '/completion/calibration-report',
        ],
    })
