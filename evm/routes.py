"""
evm/routes.py - Flask Blueprint for the EVM service.

Endpoints:
    POST /evm/analyze   - full EVM analysis (forecasted + actual branches,
                          metrics + distributions)
    GET  /evm/health    - health check

Caching: lazy-imports get_cached_result / set_cached_result from the
main app module, same pattern as solver/ and completion/.
"""

import hashlib
import json
import logging
import math

import numpy as np
from flask import Blueprint, request, jsonify

from .engine import run_evm_analysis

logger = logging.getLogger(__name__)

evm_bp = Blueprint('evm', __name__, url_prefix='/evm')


@evm_bp.record_once
def _set_max_content_length(state):
    state.app.config.setdefault('MAX_CONTENT_LENGTH', 10 * 1024 * 1024)


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
MAX_NODES         = 20_000
MAX_LINKS         = 100_000


# ---------------------------------------------------------------------------
# Lazy caching bridge (same pattern as solver/ and completion/)
# ---------------------------------------------------------------------------

_cache_fns = None


def _cache():
    global _cache_fns
    if _cache_fns is None:
        try:
            from app import get_cached_result, set_cached_result
            _cache_fns = (get_cached_result, set_cached_result)
        except Exception as exc:
            logger.info("Caching functions not available; evm running "
                        "without cache: %s", exc)
            _cache_fns = (None, None)
    return _cache_fns


def _cache_key(data):
    raw = json.dumps(data, sort_keys=True, default=str)
    return f"evm:analyze:{hashlib.sha256(raw.encode()).hexdigest()}"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate(data):
    nodes = data.get('nodes')
    if not isinstance(nodes, list):
        return 'nodes must be a list'
    if len(nodes) == 0:
        return 'No nodes provided'
    if len(nodes) > MAX_NODES:
        return f'Too many nodes ({len(nodes)}); limit is {MAX_NODES}'

    links = data.get('links', [])
    if not isinstance(links, list):
        return 'links must be a list'
    if len(links) > MAX_LINKS:
        return f'Too many links ({len(links)}); limit is {MAX_LINKS}'

    seen_ids = set()
    for i, node in enumerate(nodes):
        if not isinstance(node, dict):
            return f'nodes[{i}] must be an object'
        nid = node.get('ID', node.get('id'))
        if nid is None:
            return f'nodes[{i}] missing ID'
        sid = str(nid)
        if sid in seen_ids:
            return f'Duplicate activity ID: {nid}'
        seen_ids.add(sid)

        # Duration is optional -- milestones have 0, treated gracefully
        dur = node.get('Duration', node.get('duration', 0))
        if dur not in (0, '0', '', None):
            try:
                dur_f = float(dur)
            except (TypeError, ValueError):
                return f'nodes[{i}] (ID={nid}): Duration is not numeric'
            if math.isnan(dur_f) or math.isinf(dur_f) or dur_f < 0:
                return f'nodes[{i}] (ID={nid}): Duration must be non-negative'

    # Links need not be checked as aggressively -- unknown sources/targets
    # just drop quietly in the engine (matches JS graceful behaviour).
    for i, link in enumerate(links):
        if not isinstance(link, dict):
            return f'links[{i}] must be an object'

    options = data.get('options')
    if options is not None and not isinstance(options, dict):
        return 'options must be an object'

    # statusDate is required for deterministic results.  Without it,
    # downstream ACWP / predicted-date code can fall back to wall-clock
    # now() and silently produce non-deterministic output -- exactly
    # the bug the explicit-statusDate refactor was supposed to fix.
    opts = options or {}
    sd_raw = opts.get('statusDate', opts.get('status_date'))
    if sd_raw is None or sd_raw == '':
        return ('options.statusDate is required (ISO-8601 string); '
                'omitting it would silently produce non-deterministic results')
    if not isinstance(sd_raw, str):
        return 'options.statusDate must be an ISO-8601 string'
    from .helpers import safe_date
    if safe_date(sd_raw) is None:
        return f'options.statusDate is not parseable ISO-8601: {sd_raw!r}'

    # Validate the numeric fields too so engine-side bare float(...)
    # calls can't surface as 500s on client-side typos (null, empty
    # string, non-numeric).
    for key, lo, hi in (
            ('costRate',            0.0,   1e9),
            ('hoursPerDay',         0.01,  24.0),
            ('workingDaysPerWeek',  0.01,  7.0)):
        v = opts.get(key)
        if v is None:
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            return f'options.{key} must be a number'
        if (not math.isfinite(fv)) or fv < lo or fv > hi:
            return f'options.{key} must be in [{lo}, {hi}]'

    # maxDistributionPoints gates the time-phased distributions sampler
    # (_significant_dates).  It's forwarded into the engine without
    # coercion; a non-numeric / negative / zero value would surface as
    # a 500.  Accept camelCase and snake_case for consistency with the
    # rest of the options block.
    mdp_raw = opts.get('maxDistributionPoints',
                       opts.get('max_distribution_points'))
    if mdp_raw is not None:
        try:
            mdp = int(mdp_raw)
        except (TypeError, ValueError):
            return 'options.maxDistributionPoints must be an integer'
        if mdp < 2:
            return 'options.maxDistributionPoints must be >= 2'

    return None


def _parse_request():
    if request.content_length and request.content_length > MAX_PAYLOAD_BYTES:
        return None, (jsonify({'error': 'Payload too large (limit: 10 MB)'}), 413)

    data = request.get_json(force=True, silent=True)
    # Use `is None` rather than truthiness so an empty-but-valid `{}`
    # body proceeds to _validate, which returns a useful field-level
    # error (e.g., "nodes must be a list") instead of the misleading
    # "Invalid or missing JSON body".
    if data is None:
        return None, (jsonify({'error': 'Invalid or missing JSON body'}), 400)
    if not isinstance(data, dict):
        # _validate calls data.get(...); a bare list/string body would
        # raise AttributeError and turn a client error into a 500.
        return None, (jsonify({
            'error': 'JSON root must be an object'}), 400)

    err = _validate(data)
    if err:
        return None, (jsonify({'error': err}), 400)
    return data, None


def _serialise(obj):
    """Recursively convert numpy types + non-finite floats to JSON-safe values.

    Infinity and NaN become `null`.  This matches the consumer guard
    on the JS side: `isFinite(parseFloat(null)) === false`, which is
    the same branch the JS takes when it sees its own Infinity from
    raw SPI/CPIcum.  Standard JSON.parse rejects `Infinity` literals,
    so serialising them to null is the only safe cross-runtime choice.
    """
    if isinstance(obj, dict):
        return {k: _serialise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialise(v) for v in obj]
    if isinstance(obj, np.ndarray):
        # tolist() preserves NaN / Infinity which json.dumps emits as
        # invalid JSON literals (NaN / Infinity).  Recurse so the float
        # branch below scrubs each element to null.
        return [_serialise(v) for v in obj.tolist()]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        obj = float(obj)
    if isinstance(obj, float):
        if not math.isfinite(obj):
            return None
        return obj
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@evm_bp.route('/analyze', methods=['POST', 'OPTIONS'])
def analyze():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})

    data, err = _parse_request()
    if err:
        return err

    get_fn, set_fn = _cache()
    # Skip the SHA256(json.dumps(sort_keys)) work entirely when caching
    # is disabled / unavailable -- on a 20K-node payload the hash alone
    # adds noticeable wall time for no benefit.
    key = _cache_key(data) if (get_fn or set_fn) else None
    if get_fn and key is not None:
        cached = get_fn(key)
        # `is not None` rather than truthiness so an empty dict (or
        # any falsey payload) still registers as a hit.  Matches the
        # `data is None` guard upstream.
        if cached is not None:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        result = run_evm_analysis(
            nodes=data['nodes'],
            links=data.get('links', []),
            options=data.get('options', {}),
        )
        result = _serialise(result)
        result['cache_hit'] = False
        if set_fn and key is not None:
            set_fn(key, result)
        return jsonify(result)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        logger.exception("EVM analysis failed: %s", e)
        return jsonify({'error': 'Internal EVM service error'}), 500


@evm_bp.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'module': 'evm',
        'endpoints': ['/evm/analyze'],
    })
