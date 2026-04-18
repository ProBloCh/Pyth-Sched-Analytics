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

    return None


def _parse_request():
    if request.content_length and request.content_length > MAX_PAYLOAD_BYTES:
        return None, (jsonify({'error': 'Payload too large (limit: 10 MB)'}), 413)

    data = request.get_json(force=True, silent=True)
    if not data:
        return None, (jsonify({'error': 'Invalid or missing JSON body'}), 400)

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
    key = _cache_key(data)
    if get_fn:
        cached = get_fn(key)
        if cached:
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
        if set_fn:
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
