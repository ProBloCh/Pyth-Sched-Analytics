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


def _cache_key(prefix, data):
    raw = json.dumps(data, sort_keys=True, default=str)
    return f"completion:{prefix}:{hashlib.sha256(raw.encode()).hexdigest()}"


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

    if not data.get('status_date'):
        return None, 'status_date is required (ISO-8601)'

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

        dur = node.get('Duration', node.get('duration', 0))
        try:
            dur_f = float(dur)
        except (TypeError, ValueError):
            return None, f'nodes[{i}] (ID={nid}): Duration is not numeric'
        if math.isnan(dur_f) or math.isinf(dur_f) or dur_f < 0:
            return None, f'nodes[{i}] (ID={nid}): Duration must be a finite non-negative number'

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

    for key in ('no_risk_below', 'normal_from', 'fat_tail_from'):
        v = (cfg.get('thresholds') or {}).get(key)
        if v is not None:
            try:
                fv = float(v)
            except (TypeError, ValueError):
                return f'config.thresholds.{key} must be a number'
            if math.isnan(fv) or math.isinf(fv) or fv < 0 or fv > 1:
                return f'config.thresholds.{key} must be in [0, 1]'
    return None


def _validate_recovery_config(data):
    cfg = data.get('config')
    if not (cfg and isinstance(cfg, dict)):
        return None
    checks = [
        ('max_risk_buffer_days',         0.0,  365.0),
        ('max_recovery_options',         1,    200),
        ('max_lag_options',              0,    200),
        ('min_crashable_hours',          0.0,  10_000.0),
        ('min_lag_days_for_compression', 0.0,  365.0),
        ('lag_compression_factor',       0.0,  1.0),
    ]
    for key, lo, hi in checks:
        if key not in cfg:
            continue
        try:
            fv = float(cfg[key])
        except (TypeError, ValueError):
            return f'config.{key} must be a number'
        if math.isnan(fv) or math.isinf(fv) or fv < lo or fv > hi:
            return f'config.{key} must be in [{lo}, {hi}]'
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
    for key in ('planned_finish', 'expected_finish', 'p80_finish'):
        v = data.get(key)
        if v is None:
            continue
        if not isinstance(v, str) or not v:
            return f'{key} must be an ISO-8601 date string or null'
    return _validate_recovery_config(data)


def _parse_request(validator=_validate):
    if request.content_length and request.content_length > MAX_PAYLOAD_BYTES:
        return None, (jsonify({'error': 'Payload too large (limit: 10 MB)'}), 413)

    data = request.get_json(force=True, silent=True)
    if not data:
        return None, (jsonify({'error': 'Invalid or missing JSON body'}), 400)

    err = validator(data)
    if err:
        return None, (jsonify({'error': err}), 400)
    return data, None


def _serialise(obj):
    """Recursively convert numpy types to native Python for JSON."""
    if isinstance(obj, dict):
        return {k: _serialise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialise(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
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
    key = _cache_key('mc', data)
    if get_fn:
        cached = get_fn(key)
        if cached:
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
        if set_fn:
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
    key = _cache_key('recovery', data)
    if get_fn:
        cached = get_fn(key)
        if cached:
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
        if set_fn:
            set_fn(key, result)
        return jsonify(result)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.exception("Recovery options failed: %s", e)
        return jsonify({'error': 'Internal completion-service error'}), 500


@completion_bp.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'module': 'completion-forecast',
        'endpoints': [
            '/completion/monte-carlo',
            '/completion/recovery-options',
        ],
    })
