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
import math

import numpy as np
from flask import Blueprint, jsonify, request

from _cache_version import RESPONSE_SCHEMA_VERSION

from .core import run_optimize, run_pareto_endpoint, run_sensitivity

logger = logging.getLogger(__name__)

solver_bp = Blueprint('solver', __name__, url_prefix='/solver')


@solver_bp.record_once
def _set_max_content_length(state):
    """Enforce server-side payload limit (covers chunked encoding too)."""
    state.app.config.setdefault('MAX_CONTENT_LENGTH', 10 * 1024 * 1024)


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

MAX_PAYLOAD_BYTES = 10 * 1024 * 1024   # 10 MB
MAX_NODES         = 20_000             # matches SMALL_GRAPH_THRESHOLD ceiling
MAX_LINKS         = 100_000
MAX_ITERATIONS    = 500
MAX_MC_SAMPLES    = 1_000
MAX_PARETO_VEC    = 100

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
        except Exception as exc:
            logger.info("Caching functions not available; solver running "
                        "without cache: %s", exc)
            _cache_fns = (None, None)
    return _cache_fns


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cache_key(prefix, data):
    raw = json.dumps(data, sort_keys=True, default=str)
    return f"solver:{RESPONSE_SCHEMA_VERSION}:{prefix}:{hashlib.sha256(raw.encode()).hexdigest()}"


def _parse_request():
    """Parse, size-check, and validate a solver request."""
    # Payload size guard
    if request.content_length and request.content_length > MAX_PAYLOAD_BYTES:
        return None, (jsonify({'error': 'Payload too large (limit: 10 MB)'}), 413)

    data = request.get_json(force=True, silent=True)
    if not data:
        return None, (jsonify({'error': 'Invalid or missing JSON body'}), 400)
    if not data.get('nodes'):
        return None, (jsonify({'error': 'No nodes provided'}), 400)

    err = _validate(data)
    if err:
        return None, (jsonify({'error': err}), 400)

    return data, None


def _validate(data):
    """Deep validation of solver request.  Returns error string or None."""
    nodes = data['nodes']
    if not isinstance(nodes, list):
        return 'nodes must be a list'
    if len(nodes) > MAX_NODES:
        return f'Too many nodes ({len(nodes)}); limit is {MAX_NODES}'

    links = data.get('links', [])
    if not isinstance(links, list):
        return 'links must be a list'
    if len(links) > MAX_LINKS:
        return f'Too many links ({len(links)}); limit is {MAX_LINKS}'

    # Node validation: ID required, Duration must be a finite non-negative number
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

        dur = node.get('Duration', node.get('duration', 1.0))
        try:
            dur_f = float(dur)
        except (TypeError, ValueError):
            return f'nodes[{i}] (ID={nid}): Duration is not numeric'
        if math.isnan(dur_f) or math.isinf(dur_f) or dur_f < 0:
            return f'nodes[{i}] (ID={nid}): Duration must be a finite non-negative number'

    # Link validation
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

    # Solver config validation
    cfg = data.get('solver_config')
    if cfg and isinstance(cfg, dict):
        err = _validate_config(cfg)
        if err:
            return err

    return None


def _validate_config(cfg):
    """Validate solver_config fields.  Returns error string or None."""
    mi = cfg.get('max_iterations')
    if mi is not None:
        try:
            mi = int(mi)
        except (TypeError, ValueError):
            return 'max_iterations must be an integer'
        if mi < 1 or mi > MAX_ITERATIONS:
            return f'max_iterations must be 1–{MAX_ITERATIONS}'

    mc = cfg.get('monte_carlo_samples')
    if mc is not None:
        try:
            mc = int(mc)
        except (TypeError, ValueError):
            return 'monte_carlo_samples must be an integer'
        if mc < 1 or mc > MAX_MC_SAMPLES:
            return f'monte_carlo_samples must be 1–{MAX_MC_SAMPLES}'

    pv = cfg.get('pareto_vectors')
    if pv is not None:
        try:
            pv = int(pv)
        except (TypeError, ValueError):
            return 'pareto_vectors must be an integer'
        if pv < 2 or pv > MAX_PARETO_VEC:
            return f'pareto_vectors must be 2–{MAX_PARETO_VEC}'

    lr = cfg.get('learning_rate')
    if lr is not None:
        try:
            lr = float(lr)
        except (TypeError, ValueError):
            return 'learning_rate must be a number'
        if lr <= 0 or math.isnan(lr) or math.isinf(lr):
            return 'learning_rate must be a positive finite number'

    ct = cfg.get('convergence_threshold')
    if ct is not None:
        try:
            ct = float(ct)
        except (TypeError, ValueError):
            return 'convergence_threshold must be a number'
        if ct <= 0 or math.isnan(ct) or math.isinf(ct):
            return 'convergence_threshold must be a positive finite number'

    disciplines = cfg.get('disciplines')
    if disciplines is not None:
        if not isinstance(disciplines, list):
            return 'disciplines must be a list of strings'
        if not all(isinstance(d, str) for d in disciplines):
            return 'disciplines must be a list of strings'

    weights = cfg.get('weights')
    if weights is not None:
        if not isinstance(weights, dict):
            return 'weights must be an object'
        for k, v in weights.items():
            try:
                fv = float(v)
            except (TypeError, ValueError):
                return f'weight for {k} must be a number'
            if math.isnan(fv) or math.isinf(fv) or fv < 0:
                return f'weight for {k} must be a non-negative finite number'

    return None


def _fail_on_violation(data) -> bool:
    """Read the opt-in hard-fail flag from the request.

    Lives at ``project_context.constraints.fail_on_violation`` -- next
    to the bounds it applies to.  Default ``False`` preserves the
    existing soft-penalty contract.
    """
    pc = data.get('project_context') or {}
    cons = pc.get('constraints') or {}
    return bool(cons.get('fail_on_violation', False))


def _violation_response(result):
    """If any constraint is unsatisfied, return a 409 tuple; else ``None``.

    The check is data-driven from the result's own ``constraints``
    block (built by ``solver.optimizer.build_constraints_report``), so
    a future constraint type that lands in that block is gated for
    free.
    """
    cons = result.get('constraints') or {}
    violated = {k: v for k, v in cons.items()
                if isinstance(v, dict) and not v.get('satisfied', True)}
    if not violated:
        return None
    return jsonify({
        'error': 'constraint_violation',
        'detail': ('one or more bounds were not satisfied; '
                   'fail_on_violation=true was set in the request'),
        'constraints': cons,
        'violated': sorted(violated.keys()),
    }), 409


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
    fail_on_violation = _fail_on_violation(data)
    if get_fn:
        cached = get_fn(key)
        if cached:
            cached['cache_hit'] = True
            if fail_on_violation:
                resp = _violation_response(cached)
                if resp is not None:
                    return resp
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
        if fail_on_violation:
            resp = _violation_response(result)
            if resp is not None:
                return resp
        return jsonify(result)
    except Exception as e:
        logger.exception("Sensitivity analysis failed: %s", e)
        return jsonify({'error': 'Internal solver error'}), 500


@solver_bp.route('/optimize', methods=['POST', 'OPTIONS'])
def optimize_endpoint():
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})

    data, err = _parse_request()
    if err:
        return err

    get_fn, set_fn = _cache()
    key = _cache_key('optimize', data)
    fail_on_violation = _fail_on_violation(data)
    if get_fn:
        cached = get_fn(key)
        if cached:
            cached['cache_hit'] = True
            if fail_on_violation:
                resp = _violation_response(cached)
                if resp is not None:
                    return resp
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
        if fail_on_violation:
            resp = _violation_response(result)
            if resp is not None:
                return resp
        return jsonify(result)
    except Exception as e:
        logger.exception("Optimisation failed: %s", e)
        return jsonify({'error': 'Internal solver error'}), 500


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
        return jsonify({'error': 'Internal solver error'}), 500


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
