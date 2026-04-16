"""
completion/routes.py - Flask Blueprint for the completion-forecast service.

Endpoints:
    POST /completion/monte-carlo  - remaining-work MC finish-date forecast
    GET  /completion/health       - health check

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


def _cache_key(data):
    raw = json.dumps(data, sort_keys=True, default=str)
    return f"completion:mc:{hashlib.sha256(raw.encode()).hexdigest()}"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate(data):
    """Return error string or None."""
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

    if not data.get('status_date'):
        return 'status_date is required (ISO-8601)'

    # Node ID uniqueness + duration sanity (mirrors solver validation)
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

        dur = node.get('Duration', node.get('duration', 0))
        try:
            dur_f = float(dur)
        except (TypeError, ValueError):
            return f'nodes[{i}] (ID={nid}): Duration is not numeric'
        if math.isnan(dur_f) or math.isinf(dur_f) or dur_f < 0:
            return f'nodes[{i}] (ID={nid}): Duration must be a finite non-negative number'

    for i, link in enumerate(links):
        if not isinstance(link, dict):
            return f'links[{i}] must be an object'
        src = link.get('source')
        tgt = link.get('target')
        if src is None or tgt is None:
            return f'links[{i}] missing source or target'
        if str(src) not in seen_ids:
            return f'links[{i}] references unknown source: {src}'
        if str(tgt) not in seen_ids:
            return f'links[{i}] references unknown target: {tgt}'

    cfg = data.get('config')
    if cfg and isinstance(cfg, dict):
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
    key = _cache_key(data)
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


@completion_bp.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'module': 'completion-forecast',
        'endpoints': ['/completion/monte-carlo'],
    })
