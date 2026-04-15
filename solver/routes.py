"""
solver/routes.py - Flask Blueprint for the CADJ-P solver.

Endpoints:
    POST /solver/sensitivity  - single-pass sensitivity analysis
    POST /solver/optimize     - gradient descent optimisation
    POST /solver/pareto       - Pareto frontier sweep
    GET  /solver/health       - health check

Caching: lazily imports get_cached_result / set_cached_result from the
main app module.  The lazy import avoids the circular dependency
(app.py -> solver -> routes.py -> app.py) because caching functions are
defined early in app.py but the solver blueprint is imported later.
"""

import hashlib
import json
import logging

import numpy as np
from flask import Blueprint, request, jsonify

from .core import run_sensitivity, run_optimize, run_pareto_endpoint

logger = logging.getLogger(__name__)

solver_bp = Blueprint('solver', __name__, url_prefix='/solver')

# ---------------------------------------------------------------------------
# Lazy caching bridge (avoids circular import at module-load time)
# ---------------------------------------------------------------------------

_cache_fns = None  # (get_fn, set_fn) | (None, None)


def _cache():
    """Return (get_cached_result, set_cached_result) or (None, None)."""
    global _cache_fns
    if _cache_fns is None:
        try:
            from app import get_cached_result, set_cached_result
            _cache_fns = (get_cached_result, set_cached_result)
        except ImportError:
            logger.info("Caching functions not available; solver running "
                        "without cache")
            _cache_fns = (None, None)
    return _cache_fns


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cache_key(prefix, data):
    raw = json.dumps(data, sort_keys=True, default=str)
    return f"solver:{prefix}:{hashlib.sha256(raw.encode()).hexdigest()}"


def _parse_request():
    """Validate common request structure.  Returns (data, error_tuple|None)."""
    data = request.get_json(force=True, silent=True)
    if not data:
        return None, (jsonify({'error': 'Invalid or missing JSON body'}), 400)
    if not data.get('nodes'):
        return None, (jsonify({'error': 'No nodes provided'}), 400)
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

@solver_bp.route('/sensitivity', methods=['POST', 'OPTIONS'])
def sensitivity():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})

    data, err = _parse_request()
    if err:
        return err

    get_fn, set_fn = _cache()
    key = _cache_key('sensitivity', data)
    if get_fn:
        cached = get_fn(key)
        if cached:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        result = run_sensitivity(
            nodes=data['nodes'],
            links=data.get('links', []),
            solver_config_dict=data.get('solver_config', {}),
            activity_metadata=data.get('activity_metadata', {}),
            project_context_dict=data.get('project_context', {}),
        )
        result = _serialise(result)
        result['cache_hit'] = False
        if set_fn:
            set_fn(key, result)
        return jsonify(result)
    except Exception as e:
        logger.exception("Sensitivity analysis failed: %s", e)
        return jsonify({'error': str(e)}), 500


@solver_bp.route('/optimize', methods=['POST', 'OPTIONS'])
def optimize_endpoint():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})

    data, err = _parse_request()
    if err:
        return err

    get_fn, set_fn = _cache()
    key = _cache_key('optimize', data)
    if get_fn:
        cached = get_fn(key)
        if cached:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        result = run_optimize(
            nodes=data['nodes'],
            links=data.get('links', []),
            solver_config_dict=data.get('solver_config', {}),
            activity_metadata=data.get('activity_metadata', {}),
            project_context_dict=data.get('project_context', {}),
        )
        result = _serialise(result)
        result['cache_hit'] = False
        if set_fn:
            set_fn(key, result)
        return jsonify(result)
    except Exception as e:
        logger.exception("Optimisation failed: %s", e)
        return jsonify({'error': str(e)}), 500


@solver_bp.route('/pareto', methods=['POST', 'OPTIONS'])
def pareto():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})

    data, err = _parse_request()
    if err:
        return err

    get_fn, set_fn = _cache()
    key = _cache_key('pareto', data)
    if get_fn:
        cached = get_fn(key)
        if cached:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        result = run_pareto_endpoint(
            nodes=data['nodes'],
            links=data.get('links', []),
            solver_config_dict=data.get('solver_config', {}),
            activity_metadata=data.get('activity_metadata', {}),
            project_context_dict=data.get('project_context', {}),
        )
        result = _serialise(result)
        result['cache_hit'] = False
        if set_fn:
            set_fn(key, result)
        return jsonify(result)
    except Exception as e:
        logger.exception("Pareto analysis failed: %s", e)
        return jsonify({'error': str(e)}), 500


@solver_bp.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'module': 'cadj-p-solver',
        'endpoints': [
            '/solver/sensitivity',
            '/solver/optimize',
            '/solver/pareto',
        ],
    })
