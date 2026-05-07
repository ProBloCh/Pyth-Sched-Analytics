"""
paths/routes.py - Flask Blueprint for path analysis services.

Endpoints (mirrors the solver/completion/evm blueprint pattern):

    POST /paths/enumerate      -- enumerate all / longest-first paths
                                  + structural-diversity / independence filter
    POST /paths/driving-graph  -- CPM-derived deterministic driving chains
                                  with predecessor-ranking explainability
    POST /paths/distances      -- shortest/longest distance-to-start and
                                  distance-to-end maps
    POST /paths/calendar-slack -- CPM + calendar-projected ISO dates
    GET  /paths/health         -- liveness probe

All POST endpoints accept the same ``{nodes, links}`` payload shape as
/solver and /completion.  Extra fields are endpoint-specific (see
per-route docstrings).

Caching: lazy bridge to app.py's Redis cache.  When Redis is not
configured (``app.redis_client is None``), ``_cache()`` returns
``(None, None)`` and the route skips both the cache key SHA-256 and the
get/set callbacks entirely.  No in-process LRU fallback; this matches
the solver/completion/evm pattern.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import asdict

import numpy as np
from flask import Blueprint, request, jsonify

from solver.dag import build_dag
from ._constants import MAX_NODES
from .distances import distances_to_start, distances_to_end, near_critical_mask
from .calendar_slack import compute_calendar_slack
from .enumerate import (
    find_all_paths, MAX_PATHS_TO_RETURN,
    NODE_THRESHOLD, LINK_THRESHOLD,
)
from .diversity import (
    DiversityConfig, auto_tune_config,
    select_independent_near_critical, select_structurally_diverse,
)
from .driving_graph import DrivingGraphConfig, extract_driving_graph
from .subpath_patterns import SubpathConfig, mine_recurring_subpaths


logger = logging.getLogger(__name__)

paths_bp = Blueprint('paths', __name__, url_prefix='/paths')


# ---------------------------------------------------------------------------
# Config -- line up with solver/routes.py limits
# ---------------------------------------------------------------------------

MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
MAX_LINKS = 100_000


@paths_bp.record_once
def _set_max_content_length(state):
    state.app.config.setdefault('MAX_CONTENT_LENGTH', MAX_PAYLOAD_BYTES)


# ---------------------------------------------------------------------------
# Lazy caching bridge (avoids circular import at module-load time)
# ---------------------------------------------------------------------------

_cache_fns = None  # (get_fn, set_fn) | (None, None)


def _cache():
    """Return ``(get_fn, set_fn)`` only when a backing store is actually
    configured.  When Redis isn't connected, ``app.get_cached_result``
    always returns None on lookup and ``set_cached_result`` is a no-op,
    so calling them just wastes cycles -- and the SHA-256 over a large
    nodes/links payload is the dominant cost.  Returning ``(None, None)``
    here lets callers skip the cache key computation entirely.
    """
    global _cache_fns
    if _cache_fns is None:
        try:
            from app import get_cached_result, set_cached_result, redis_client
            if redis_client is None:
                _cache_fns = (None, None)
            else:
                _cache_fns = (get_cached_result, set_cached_result)
        except Exception as exc:
            logger.info("Caching not available for /paths: %s", exc)
            _cache_fns = (None, None)
    return _cache_fns


def _cache_key(prefix: str, data) -> str:
    raw = json.dumps(data, sort_keys=True, default=str)
    return f"paths:{prefix}:{hashlib.sha256(raw.encode()).hexdigest()}"


# ---------------------------------------------------------------------------
# Shared validation
# ---------------------------------------------------------------------------

def _validate_nodes_links(data):
    nodes = data.get('nodes')
    if not isinstance(nodes, list) or not nodes:
        return 'nodes must be a non-empty list'
    if len(nodes) > MAX_NODES:
        return f'Too many nodes ({len(nodes)}); limit is {MAX_NODES}'

    links = data.get('links', [])
    if not isinstance(links, list):
        return 'links must be a list'
    if len(links) > MAX_LINKS:
        return f'Too many links ({len(links)}); limit is {MAX_LINKS}'

    seen = set()
    for i, n in enumerate(nodes):
        if not isinstance(n, dict):
            return f'nodes[{i}] must be an object'
        nid = n.get('ID', n.get('id'))
        if nid is None:
            return f'nodes[{i}] missing ID'
        sid = str(nid)
        if sid in seen:
            return f'duplicate node ID: {nid}'
        seen.add(sid)
        dur = n.get('Duration', n.get('duration', 0))
        # Milestone sentinels mean "no work" and are accepted across the
        # repo (solver.dag, completion/, evm/).  Treat them as 0.
        if dur in ('', None):
            df = 0.0
        else:
            try:
                df = float(dur)
            except (TypeError, ValueError):
                return f'nodes[{i}] Duration not numeric'
        if math.isnan(df) or math.isinf(df) or df < 0:
            return f'nodes[{i}] Duration must be finite and non-negative'
    for i, ln in enumerate(links):
        if not isinstance(ln, dict):
            return f'links[{i}] must be an object'
        if ln.get('source') is None or ln.get('target') is None:
            return f'links[{i}] missing source/target'
        if str(ln.get('source')) not in seen:
            return f'links[{i}] unknown source: {ln.get("source")}'
        if str(ln.get('target')) not in seen:
            return f'links[{i}] unknown target: {ln.get("target")}'
    return None


def _parse_request():
    if request.content_length and request.content_length > MAX_PAYLOAD_BYTES:
        return None, (jsonify({'error': 'Payload too large (limit: 10 MB)'}), 413)
    data = request.get_json(force=True, silent=True)
    if data is None:
        return None, (jsonify({'error': 'Invalid or missing JSON body'}), 400)
    if not isinstance(data, dict):
        return None, (jsonify({'error': 'JSON root must be an object'}), 400)
    err = _validate_nodes_links(data)
    if err:
        return None, (jsonify({'error': err}), 400)
    return data, None


def _serialise(obj):
    if isinstance(obj, dict):
        return {k: _serialise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialise(v) for v in obj]
    if isinstance(obj, np.ndarray):
        # Recurse over tolist() so NaN/Inf inside the array map to null,
        # matching completion/routes.py::_serialise behaviour.
        return [_serialise(v) for v in obj.tolist()]
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        v = float(obj)
        if math.isinf(v) or math.isnan(v):
            return None
        return v
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, float):
        if math.isinf(obj) or math.isnan(obj):
            return None
    return obj


def _coerce_int(value, default, field, min_val=None, max_val=None):
    """Return ``(int, None)`` or ``(None, jsonify-err)``.  Keeps bad client
    input from turning into a 500.

    Rejects ``bool`` (``int(True) == 1`` would silently coerce JSON
    ``true`` past type validation) and ``float`` (``int(1.9) == 1``
    would silently narrow the documented integer contract).
    """
    if value is None:
        if default is None:
            return None, None  # treat as "unset" so caller can drop it
        v = default
    else:
        # Reject bool first -- isinstance(True, int) is True in Python.
        if isinstance(value, bool):
            return None, (jsonify({
                'error': f'{field} must be an integer (got bool)'}), 400)
        # Reject float -- int(1.9) silently truncates.
        if isinstance(value, float):
            return None, (jsonify({
                'error': f'{field} must be an integer (got float)'}), 400)
        try:
            v = int(value)
        except (TypeError, ValueError):
            return None, (jsonify({'error': f'{field} must be an integer'}), 400)
    if min_val is not None and v < min_val:
        return None, (jsonify({'error': f'{field} must be >= {min_val}'}), 400)
    if max_val is not None and v > max_val:
        return None, (jsonify({'error': f'{field} must be <= {max_val}'}), 400)
    return v, None


def _coerce_float(value, default, field, min_val=None, max_val=None):
    if value is None:
        # When caller has no default (i.e. wants the field treated as
        # "unset"), short-circuit with (None, None) so downstream can drop
        # the key.  math.isnan(None) would otherwise raise TypeError.
        if default is None:
            return None, None
        v = default
    else:
        # Reject bool -- ``float(True) == 1.0`` would otherwise let
        # JSON ``true`` slip past type validation.
        if isinstance(value, bool):
            return None, (jsonify({
                'error': f'{field} must be a number (got bool)'}), 400)
        try:
            v = float(value)
        except (TypeError, ValueError):
            return None, (jsonify({'error': f'{field} must be a number'}), 400)
    if math.isnan(v) or math.isinf(v):
        return None, (jsonify({'error': f'{field} must be finite'}), 400)
    if min_val is not None and v < min_val:
        return None, (jsonify({'error': f'{field} must be >= {min_val}'}), 400)
    if max_val is not None and v > max_val:
        return None, (jsonify({'error': f'{field} must be <= {max_val}'}), 400)
    return v, None


def _coerce_bool(value, default, field):
    if value is None:
        return default, None
    if isinstance(value, bool):
        return value, None
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value), None
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ('true', '1', 'yes', 'on'):
            return True, None
        if s in ('false', '0', 'no', 'off'):
            return False, None
    return None, (jsonify({'error': f'{field} must be a boolean'}), 400)


def _coerce_dict_overrides(value, field):
    """Accept None or a JSON object; reject anything else with 400."""
    if value is None:
        return {}, None
    if isinstance(value, dict):
        return value, None
    return None, (jsonify({'error': f'{field} must be an object'}), 400)


def _resolve_start_end(start_id, end_id, nodes, links):
    """Default start/end IDs only when the caller omitted them.

    ``id == 0`` / ``"0"`` are valid in real schedules (P6/MSP imports), so
    we cannot use truthiness here -- only ``None`` and ``""`` count as
    "missing" and trigger the inferred-anchor fallback.
    """
    def _missing(v):
        return v is None or v == '' or v == b''
    if _missing(start_id) or _missing(end_id):
        d_start, d_end = _default_start_end(nodes, links)
        if _missing(start_id):
            start_id = d_start
        if _missing(end_id):
            end_id = d_end
    return start_id, end_id


def _coerce_dataclass_overrides(raw, dc_type, field, bounds=None,
                                allowed_values=None):
    """Validate per-field types for dataclass override dicts.

    Iterates the dataclass annotations; coerces ints/floats/bools/strings
    into the expected primitive type and rejects malformed values with
    a 400.  Unknown keys are silently dropped (matches the existing
    behaviour but stays type-safe).

    ``bounds``: optional dict ``{field_name: (min, max)}`` enforced on
    numeric fields to prevent resource-exhaustion abuse (e.g.,
    ``max_expansions: 1_000_000_000``).
    ``allowed_values``: optional dict ``{field_name: {valid, ...}}``
    for enum-like string fields.
    """
    overrides, err = _coerce_dict_overrides(raw, field)
    if err:
        return None, err
    bounds = bounds or {}
    allowed_values = allowed_values or {}
    out = {}
    fields = dc_type.__dataclass_fields__
    for k, v in overrides.items():
        if k not in fields:
            continue
        ann = fields[k].type
        # Annotation may be a class or a string (PEP 563 future-annotations).
        ann_name = ann.__name__ if hasattr(ann, '__name__') else str(ann)
        lo, hi = bounds.get(k, (None, None))
        if ann_name == 'bool' or ann is bool:
            cv, e = _coerce_bool(v, None, f'{field}.{k}')
            if e:
                return None, e
            if cv is None:
                continue
            out[k] = cv
        elif ann_name == 'int' or ann is int:
            cv, e = _coerce_int(v, None, f'{field}.{k}',
                                min_val=lo, max_val=hi)
            if e:
                return None, e
            if cv is None:
                continue   # explicit null -> use dataclass default
            out[k] = cv
        elif ann_name == 'float' or ann is float:
            cv, e = _coerce_float(v, None, f'{field}.{k}',
                                  min_val=lo, max_val=hi)
            if e:
                return None, e
            if cv is None:
                continue   # explicit null -> use dataclass default
            out[k] = cv
        elif ann_name == 'str' or ann is str:
            if not isinstance(v, str):
                return None, (jsonify({
                    'error': f'{field}.{k} must be a string'}), 400)
            allowed = allowed_values.get(k)
            if allowed is not None and v not in allowed:
                return None, (jsonify({
                    'error': f'{field}.{k} must be one of: '
                             + ', '.join(sorted(allowed))}), 400)
            out[k] = v
        else:
            # Unrecognised annotation: pass through (DiversityConfig and
            # DrivingGraphConfig only use primitives today).
            out[k] = v
    return out, None


# Per-config bounds and enum-allowlists.  Defaults come from the
# dataclasses; here we cap user overrides to defensible operational
# ranges so a malicious or buggy client can't request 1B expansions.
_DRIVING_GRAPH_BOUNDS = {
    'epsilon_hours': (0.0, 1_000.0),
    'critical_float_tol_hours': (0.0, 100_000.0),
    'near_critical_float_tol_hours': (0.0, 100_000.0),
    'near_driving_tol_hours': (0.0, 100_000.0),
    'max_critical_chains': (1, 10_000),
    'max_near_critical_chains': (1, 10_000),
    'max_expansions': (1, 5_000_000),
    'max_depth_guard': (1, 100_000),
    'max_display_chains': (1, 1_000),
    'min_jaccard_novelty': (0.0, 1.0),
    'max_pred_rankings_per_node': (1, 500),
}
_DRIVING_GRAPH_ALLOWED = {
    'selection_mode': {'raw', 'outliers'},
}

_DIVERSITY_BOUNDS = {
    'max_paths': (1, 1_000),
    'branch_depth': (1, 30),
    'midpoint_depth': (1, 8),
    'min_paths_per_branch': (1, 200),
    'max_paths_per_branch': (1, 200),
    'overlap_threshold': (0.0, 1.0),
    'min_unique_edges': (0, 200),
    'max_per_family': (1, 200),
    'candidate_multiplier': (1, 50),
    'candidate_cap': (1, 50_000),
}

# Recurring-subpath mining bounds.  Mirrors SubpathConfig.__post_init__
# in paths/subpath_patterns.py so direct Python callers and HTTP callers
# reject the same inputs.  Keep the two in sync.
_SUBPATH_BOUNDS = {
    'Lmin': (2, MAX_NODES),
    'Lmax': (2, MAX_NODES),
    'top_k': (1, 200),
    'max_anchor_pairs': (1, 200_000),
    'fallback_min_anchors': (0, 1_000),
    'anchor_z_threshold': (0.0, 10.0),
    'fallback_salience_threshold': (-10.0, 10.0),
}


def _default_start_end(nodes, links):
    """If caller didn't specify start/end, pick project anchors.

    The main app maintains a DAG between an artificial start (ID '0')
    and end (the largest numeric ID).  Match that convention exactly --
    same as JS ``findPathsToAndFromNode`` (Reference/PathScripts.js
    lines 6720-6721): ``start = node with ID '0'``,
    ``end = node with max numeric ID``.

    Falls back to the predecessor-less / successor-less heuristic only
    when neither anchor is present (e.g. user-supplied subgraphs that
    don't follow the convention).
    """
    ids = [str(n.get('ID', n.get('id', ''))) for n in nodes]
    if not ids:
        return None, None

    # Primary: app convention (start='0', end=max numeric ID).
    start = '0' if '0' in ids else None
    numeric_ids = []
    for nid in ids:
        try:
            v = float(nid)
        except (TypeError, ValueError):
            continue
        # Reject NaN/Inf: ``float('nan')`` slipping through would break
        # ``max()`` (NaN comparisons make max return whatever appears
        # first), and ``inf`` would always win even against legitimate
        # numeric IDs.
        if math.isfinite(v):
            numeric_ids.append((v, nid))
    end = max(numeric_ids, key=lambda item: item[0])[1] if numeric_ids else None

    # Fallback for non-conforming inputs: predecessor-less / successor-less.
    if start is None or end is None:
        has_pred = set()
        has_succ = set()
        for ln in links:
            s = str(ln.get('source', ''))
            t = str(ln.get('target', ''))
            has_succ.add(s)
            has_pred.add(t)
        if start is None:
            start = next((i for i in ids if i not in has_pred), ids[0])
        if end is None:
            end_candidates = [i for i in ids if i not in has_succ]
            end = end_candidates[-1] if end_candidates else ids[-1]

    return start, end


# ---------------------------------------------------------------------------
# POST /paths/enumerate
# ---------------------------------------------------------------------------

@paths_bp.route('/enumerate', methods=['POST', 'OPTIONS'])
def enumerate_paths():
    """Enumerate paths with optional diversity / independence filtering.

    Request body:
        {
          "nodes": [...],
          "links": [...],
          "start_id":       optional str (default: first predecessor-less node),
          "end_id":         optional str (default: last successor-less node),
          "max_paths":      optional int (default 10000),
          "selection":      "raw" | "diverse" | "independent" (default "independent"),
          "branch_balanced": bool (default true),
          "diversity":      optional DiversityConfig overrides,
        }
    """
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})
    data, err = _parse_request()
    if err:
        return err

    nodes = data['nodes']
    links = data.get('links', [])
    start_id, end_id = _resolve_start_end(
        data.get('start_id'), data.get('end_id'), nodes, links,
    )

    max_paths, err_ = _coerce_int(data.get('max_paths'), MAX_PATHS_TO_RETURN,
                                  'max_paths', min_val=1,
                                  max_val=MAX_PATHS_TO_RETURN)
    if err_:
        return err_
    selection = str(data.get('selection', 'independent')).lower()
    if selection not in ('raw', 'diverse', 'independent'):
        return jsonify({'error': (
            "selection must be one of 'raw', 'diverse', 'independent'"
        )}), 400
    branch_balanced, err_ = _coerce_bool(data.get('branch_balanced'), True,
                                         'branch_balanced')
    if err_:
        return err_
    diversity_overrides, err_ = _coerce_dataclass_overrides(
        data.get('diversity'), DiversityConfig, 'diversity',
        bounds=_DIVERSITY_BOUNDS,
    )
    if err_:
        return err_

    get_fn, set_fn = _cache()
    key = None
    if get_fn or set_fn:
        key = _cache_key('enumerate', {
            'nodes': nodes, 'links': links,
            'start_id': start_id, 'end_id': end_id,
            'max_paths': max_paths, 'selection': selection,
            'branch_balanced': branch_balanced,
            'diversity': diversity_overrides or None,
        })
    if get_fn and key is not None:
        cached = get_fn(key)
        if cached is not None:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        base = find_all_paths(
            nodes, links, start_id, end_id,
            max_paths=max_paths,
            branch_balanced=branch_balanced,
        )

        result = {
            'start_id': base['start_id'],
            'end_id': base['end_id'],
            'method': base['method'],
            'makespan_hours': base.get('makespan_hours', 0.0),
            'raw_path_count': base['raw_path_count'],
        }
        if base.get('error'):
            # Engine-side client-input errors (e.g. start/end not in
            # schedule) deserve a 4xx so callers can branch on it.
            result['error'] = base['error']
            result['paths'] = []
            result['durations'] = []
            result['cache_hit'] = False
            return jsonify(_serialise(result)), 400

        raw_paths = base['paths']
        raw_dur = base['durations']

        if selection == 'raw' or not raw_paths:
            result['paths'] = raw_paths
            result['durations'] = raw_dur
            result['selection'] = 'raw'
        else:
            cfg = DiversityConfig(**diversity_overrides)
            cfg = auto_tune_config(
                cfg, raw_paths,
                node_count=len(nodes), link_count=len(links),
            )
            if selection == 'diverse':
                sel = select_structurally_diverse(raw_paths, raw_dur, cfg)
                result['selection'] = 'diverse'
            else:
                sel = select_independent_near_critical(
                    raw_paths, raw_dur,
                    ref_path=raw_paths[0] if raw_paths else None,
                    config=cfg,
                )
                result['selection'] = 'independent'
            result['paths'] = sel.paths
            result['durations'] = sel.durations
            result['diversity_info'] = sel.info
            result['diversity_config'] = asdict(cfg)

        result['cache_hit'] = False
        payload = _serialise(result)
        if set_fn and key is not None:
            set_fn(key, payload)
        return jsonify(payload)
    except Exception as e:
        logger.exception("/paths/enumerate failed: %s", e)
        return jsonify({'error': 'Internal path-enumeration error'}), 500


# ---------------------------------------------------------------------------
# POST /paths/driving-graph
# ---------------------------------------------------------------------------

@paths_bp.route('/driving-graph', methods=['POST', 'OPTIONS'])
def driving_graph():
    """CPM-derived driving chains with predecessor-ranking explainability.

    Request body:
        {
          "nodes": [...], "links": [...],
          "start_id": optional, "end_id": optional,
          "config":   optional DrivingGraphConfig overrides,
        }
    """
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})
    data, err = _parse_request()
    if err:
        return err

    nodes = data['nodes']
    links = data.get('links', [])
    start_id, end_id = _resolve_start_end(
        data.get('start_id'), data.get('end_id'), nodes, links,
    )

    cfg_overrides, err_ = _coerce_dataclass_overrides(
        data.get('config'), DrivingGraphConfig, 'config',
        bounds=_DRIVING_GRAPH_BOUNDS,
        allowed_values=_DRIVING_GRAPH_ALLOWED,
    )
    if err_:
        return err_
    cfg = DrivingGraphConfig(**cfg_overrides)

    get_fn, set_fn = _cache()
    key = None
    if get_fn or set_fn:
        key = _cache_key('driving-graph', {
            'nodes': nodes, 'links': links,
            'start_id': start_id, 'end_id': end_id,
            'config': cfg_overrides or None,
        })
    if get_fn and key is not None:
        cached = get_fn(key)
        if cached is not None:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        res = extract_driving_graph(nodes, links, start_id, end_id, cfg)
        result = {
            'paths': res.paths,
            'durations': res.durations,
            'critical_chains': res.critical_chains,
            'near_critical_chains': res.near_critical_chains,
            'explainability': res.explainability,
            'raw_candidate_count': res.raw_candidate_count,
            'active_node_count': res.active_node_count,
            'project_finish_hours': res.project_finish_hours,
            'config': asdict(cfg),
            'cache_hit': False,
        }
        # Surface client-input errors (start/end not in schedule) as 400.
        if isinstance(res.explainability, dict) and res.explainability.get('error'):
            return jsonify(_serialise(result)), 400
        payload = _serialise(result)
        if set_fn and key is not None:
            set_fn(key, payload)
        return jsonify(payload)
    except Exception as e:
        logger.exception("/paths/driving-graph failed: %s", e)
        return jsonify({'error': 'Internal driving-graph error'}), 500


# ---------------------------------------------------------------------------
# POST /paths/distances
# ---------------------------------------------------------------------------

@paths_bp.route('/distances', methods=['POST', 'OPTIONS'])
def distances():
    """Per-node shortest/longest distance-to-start and -to-end.

    Request body:
        {"nodes": [...], "links": [...],
         "near_critical_tol_hours": optional float (default 24)}
    """
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})
    data, err = _parse_request()
    if err:
        return err

    nodes = data['nodes']
    links = data.get('links', [])
    near_tol, err_ = _coerce_float(data.get('near_critical_tol_hours'),
                                   24.0, 'near_critical_tol_hours',
                                   min_val=0.0, max_val=1_000_000.0)
    if err_:
        return err_

    get_fn, set_fn = _cache()
    key = None
    if get_fn or set_fn:
        key = _cache_key('distances', {
            'nodes': nodes, 'links': links, 'near_tol': near_tol,
        })
    if get_fn and key is not None:
        cached = get_fn(key)
        if cached is not None:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        state, id_to_idx = build_dag(nodes, links, default_duration=0.0)
        idx_to_id = {i: nid for nid, i in id_to_idx.items()}
        d_start = distances_to_start(state)
        d_end = distances_to_end(state)
        near = near_critical_mask(state, tolerance_hours=near_tol)

        def _coerce(v):
            v = float(v)
            if math.isinf(v) or math.isnan(v):
                return None
            return v

        nodes_out = []
        for i in range(state.n):
            nodes_out.append({
                'ID': idx_to_id[i],
                'duration_hours': float(state.durations[i]),
                'shortest_to_start': _coerce(d_start['shortest'][i]),
                'longest_to_start': _coerce(d_start['longest'][i]),
                'shortest_to_end': _coerce(d_end['shortest'][i]),
                'longest_to_end': _coerce(d_end['longest'][i]),
                'TF': float(state.TF[i]),
                'is_critical': bool(state.critical_mask[i]),
                'is_near_critical': bool(near[i]),
            })

        result = {
            'nodes': nodes_out,
            'makespan_hours': float(state.makespan),
            'critical_count': int(np.count_nonzero(state.critical_mask)),
            'near_critical_count': int(np.count_nonzero(near)),
            'near_critical_tol_hours': near_tol,
            'cache_hit': False,
        }
        payload = _serialise(result)
        if set_fn and key is not None:
            set_fn(key, payload)
        return jsonify(payload)
    except Exception as e:
        logger.exception("/paths/distances failed: %s", e)
        return jsonify({'error': 'Internal distance-compute error'}), 500


# ---------------------------------------------------------------------------
# POST /paths/calendar-slack
# ---------------------------------------------------------------------------

@paths_bp.route('/calendar-slack', methods=['POST', 'OPTIONS'])
def calendar_slack():
    """CPM + optional working-calendar projection to ISO dates.

    Request body:
        {"nodes": [...], "links": [...],
         "project_start": optional ISO string,
         "calendar": {"hours_per_day": 8, "working_days": [1..5], "holidays": [...]}}
    """
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})
    data, err = _parse_request()
    if err:
        return err

    nodes = data['nodes']
    links = data.get('links', [])
    project_start = data.get('project_start')
    if project_start is not None:
        if not isinstance(project_start, str):
            return jsonify({
                'error': 'project_start must be a string ISO timestamp'}), 400
        # Lazy import to keep the route module light at top level.
        from completion.monte_carlo import _parse_iso_to_ms
        if _parse_iso_to_ms(project_start) is None:
            return jsonify({
                'error': 'project_start must be a valid ISO timestamp'}), 400
    calendar_cfg, err_ = _coerce_dict_overrides(data.get('calendar'),
                                                'calendar')
    if err_:
        return err_

    get_fn, set_fn = _cache()
    key = None
    if get_fn or set_fn:
        key = _cache_key('calendar-slack', {
            'nodes': nodes, 'links': links,
            'project_start': project_start, 'calendar': calendar_cfg or None,
        })
    if get_fn and key is not None:
        cached = get_fn(key)
        if cached is not None:
            cached['cache_hit'] = True
            return jsonify(cached)

    try:
        result = compute_calendar_slack(
            nodes, links,
            project_start=project_start,
            calendar_config=calendar_cfg,
        )
        result['cache_hit'] = False
        payload = _serialise(result)
        if set_fn and key is not None:
            set_fn(key, payload)
        return jsonify(payload)
    except Exception as e:
        logger.exception("/paths/calendar-slack failed: %s", e)
        return jsonify({'error': 'Internal calendar-slack error'}), 500


# ---------------------------------------------------------------------------
# POST /paths/recurring-subpaths
# ---------------------------------------------------------------------------

# Top-level enumeration kwargs that must NOT coexist with a precomputed
# ``paths`` corpus -- silently ignoring them whenever ``paths`` was set
# let stale request payloads mine the wrong corpus with a 200 response.
_ENUMERATION_KWARGS = ('start_id', 'end_id', 'max_paths', 'branch_balanced')


def _normalise_id(value):
    """Coerce a node-ID-shaped value to its canonical string form.

    Cache keys must hash equivalently for equivalent inputs, so int IDs
    and string IDs need to land on the same key.  ``None`` passes
    through so callers can distinguish "absent" from "present-as-string".
    """
    if value is None:
        return None
    return str(value)


def _normalise_node_for_cache(n):
    """Cache-key shape: collapse the ``id`` alias into ``ID`` and coerce
    ID-typed values to strings so int-IDs and string-IDs hash identically.
    """
    out = dict(n)
    if 'id' in out and 'ID' not in out:
        out['ID'] = out.pop('id')
    elif 'id' in out and 'ID' in out:
        # Both present -- prefer 'ID' but drop the alias from the key.
        out.pop('id')
    if 'ID' in out:
        out['ID'] = _normalise_id(out['ID'])
    return out


def _normalise_link_for_cache(ln):
    out = dict(ln)
    if 'source' in out:
        out['source'] = _normalise_id(out['source'])
    if 'target' in out:
        out['target'] = _normalise_id(out['target'])
    return out


@paths_bp.route('/recurring-subpaths', methods=['POST', 'OPTIONS'])
def recurring_subpaths():
    """Mine recurring subpaths over the critical / near-critical corpus.

    Request body:
        {
          "nodes": [...], "links": [...],
          "paths":          optional precomputed corpus (list of list of
                            node IDs; mutually exclusive with the four
                            enumeration kwargs below),
          "start_id":       optional, forwarded to find_all_paths,
          "end_id":         optional, forwarded to find_all_paths,
          "max_paths":      optional int (1..MAX_PATHS_TO_RETURN),
          "branch_balanced": optional bool (default False),
          "config":         optional SubpathConfig overrides.
        }
    """
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})
    data, err = _parse_request()
    if err:
        return err

    nodes = data['nodes']
    links = data.get('links', [])

    # Precomputed corpus.  ``paths`` absent OR explicit ``null`` both
    # mean "enumerate" (JSON ``null`` is the canonical "no value"
    # signal; rejecting it as malformed would surprise callers who
    # build payloads programmatically).  ``paths == []`` is distinct:
    # it means "explicit empty corpus, do NOT re-enumerate" -- a
    # caller-controlled no-op rather than an absent field.
    raw_paths_field = data.get('paths')
    paths_provided = 'paths' in data and raw_paths_field is not None
    paths = raw_paths_field if paths_provided else None

    # Mutual-exclusion guard: precomputed paths cannot coexist with
    # enumeration kwargs.  Listing the conflicting kwarg names in the
    # error helps the caller find the stale field in their payload.
    if paths_provided:
        conflicts = [k for k in _ENUMERATION_KWARGS if k in data]
        if conflicts:
            return jsonify({'error': (
                f"'paths' and enumeration kwargs ({', '.join(conflicts)}) "
                f"are mutually exclusive"
            )}), 400

    # Top-level paths shape validation.  Runs BEFORE cache-key
    # normalisation so malformed entries can't alias to a cached valid
    # request via str() coercion (e.g. ``paths: ['AB']`` would otherwise
    # hash the same as ``paths: [['A', 'B']]``).
    if paths_provided:
        if not isinstance(paths, list):
            return jsonify({'error': 'paths must be a list'}), 400
        for i, p in enumerate(paths):
            if isinstance(p, (str, bytes, bytearray)):
                return jsonify({
                    'error': f'paths[{i}] must be a list of node IDs'}), 400
            if not isinstance(p, list):
                return jsonify({
                    'error': f'paths[{i}] must be a list of node IDs'}), 400
            if len(p) < 2:
                return jsonify({
                    'error': f'paths[{i}] must contain at least 2 node IDs'}), 400

    # Top-level max_paths -- bool/float guard via _coerce_int.
    max_paths, err_ = _coerce_int(
        data.get('max_paths'), None, 'max_paths',
        min_val=1, max_val=MAX_PATHS_TO_RETURN,
    )
    if err_:
        return err_

    # Top-level branch_balanced (default False so support counts stay
    # unbiased; caller can opt back into branch balancing explicitly).
    branch_balanced, err_ = _coerce_bool(
        data.get('branch_balanced'), False, 'branch_balanced',
    )
    if err_:
        return err_

    # Config validation.  ``Lmax`` has Optional[int] annotation which
    # the generic dispatcher doesn't recognise, so coerce it explicitly
    # before delegating the rest to _coerce_dataclass_overrides.
    config_raw = data.get('config')
    if config_raw is not None and not isinstance(config_raw, dict):
        return jsonify({'error': 'config must be an object'}), 400
    config_overrides_input = dict(config_raw) if config_raw else {}
    lmax_provided = 'Lmax' in config_overrides_input
    lmax_value = None
    if lmax_provided:
        lmax_raw = config_overrides_input.pop('Lmax')
        if lmax_raw is not None:
            lmax_value, err_ = _coerce_int(
                lmax_raw, None, 'config.Lmax',
                min_val=_SUBPATH_BOUNDS['Lmax'][0],
                max_val=_SUBPATH_BOUNDS['Lmax'][1],
            )
            if err_:
                return err_

    cfg_overrides, err_ = _coerce_dataclass_overrides(
        config_overrides_input, SubpathConfig, 'config',
        bounds=_SUBPATH_BOUNDS,
    )
    if err_:
        return err_
    if lmax_provided:
        cfg_overrides['Lmax'] = lmax_value

    try:
        cfg = SubpathConfig(**cfg_overrides)
    except (ValueError, TypeError) as exc:
        # Cross-field validation lives in SubpathConfig.__post_init__
        # (e.g. Lmax >= Lmin).  Surface as 400 with the engine's
        # descriptive message.
        return jsonify({'error': str(exc)}), 400

    # Pre-normalise path IDs to strings exactly once -- the cache key,
    # the route's hop-validation block, and the original ``paths`` value
    # passed downstream all need the same string form.  Doing it once
    # here is meaningfully faster on large corpora than re-calling
    # ``str(x)`` per check.
    norm_paths = (
        None if paths is None
        else [[str(x) for x in p] for p in paths]
    )

    # Cache key with id-alias / numeric-ID normalisation.  Equivalent
    # payloads (``{'id': 1}`` vs ``{'ID': '1'}``) must share an entry,
    # otherwise one of the two request shapes always misses the cache
    # and re-runs the full mining pipeline.
    get_fn, set_fn = _cache()
    key = None
    if get_fn or set_fn:
        key = _cache_key('recurring-subpaths', {
            'nodes': [_normalise_node_for_cache(n) for n in nodes],
            'links': [_normalise_link_for_cache(ln) for ln in links],
            'paths': norm_paths,
            'paths_provided': paths_provided,
            'start_id': _normalise_id(data.get('start_id')),
            'end_id': _normalise_id(data.get('end_id')),
            'max_paths': max_paths,
            'branch_balanced': branch_balanced,
            'config': cfg_overrides or None,
        })
    if get_fn and key is not None:
        cached = get_fn(key)
        if cached is not None:
            # Copy the dict so the cache_hit mutation can never bleed
            # back into the in-memory store (Redis returns a fresh
            # dict on every get; an LRU shim would not).
            cached = dict(cached)
            cached['cache_hit'] = True
            return jsonify(cached)

    # Build a DAG once for route-level hop validation when paths are
    # supplied -- avoids paying the build cost a second time inside
    # mine_recurring_subpaths via the dag_state passthrough.  Skipped
    # entirely for empty / absent paths (mine short-circuits on empty
    # corpus before its own build_dag call).
    dag_state = None
    id_to_idx = None
    if paths_provided and len(norm_paths) > 0:
        try:
            dag_state, id_to_idx = build_dag(nodes, links, default_duration=0.0)
        except Exception as exc:
            logger.exception(
                '/paths/recurring-subpaths build_dag failed: %s', exc)
            return jsonify({
                'error': 'Failed to build DAG from nodes/links'}), 500
        idx_to_id = {i: nid for nid, i in id_to_idx.items()}
        known = set(id_to_idx.keys())
        dag_edges = {
            (idx_to_id[u], idx_to_id[int(v)])
            for u in range(dag_state.n)
            for v in dag_state.succ[u]
        }
        for i, sp in enumerate(norm_paths):
            for nid in sp:
                if nid not in known:
                    return jsonify({
                        'error': (
                            f'paths[{i}] references unknown node ID: {nid!r}'
                        )}), 400
            for j in range(len(sp) - 1):
                hop = (sp[j], sp[j + 1])
                if hop not in dag_edges:
                    return jsonify({
                        'error': (
                            f'paths[{i}] hop {hop[0]}->{hop[1]} is not a '
                            f'valid DAG edge (cycle-broken back-edges are '
                            f'not enumerable)'
                        )}), 400

    # Enumerate kwargs are forwarded only when the caller didn't supply
    # a precomputed corpus (mutual-exclusion check above ensures this).
    enumerate_kwargs = None
    if not paths_provided:
        enumerate_kwargs = {'branch_balanced': branch_balanced}
        if 'start_id' in data:
            enumerate_kwargs['start_id'] = data['start_id']
        if 'end_id' in data:
            enumerate_kwargs['end_id'] = data['end_id']
        if max_paths is not None:
            enumerate_kwargs['max_paths'] = max_paths

    try:
        result = mine_recurring_subpaths(
            nodes, links,
            paths=paths,
            config=cfg,
            enumerate_kwargs=enumerate_kwargs,
            dag_state=dag_state,
            id_to_idx=id_to_idx,
        )
    except ValueError as exc:
        # Engine validation (per-hop, shape) reaching the route is a
        # safety net -- the route's own validation should have caught
        # it.  Still surface as 400 with the engine's message.
        return jsonify({'error': str(exc)}), 400
    except Exception as exc:
        logger.exception('/paths/recurring-subpaths failed: %s', exc)
        return jsonify({'error': 'Internal recurring-subpaths error'}), 500

    if 'error' in result:
        # Engine surfaced a client-input error (e.g. start/end not in
        # schedule via find_all_paths).  Mirror the other paths routes
        # by returning 400.
        result['cache_hit'] = False
        return jsonify(_serialise(result)), 400

    result['cache_hit'] = False
    payload = _serialise(result)
    if set_fn and key is not None:
        set_fn(key, payload)
    return jsonify(payload)


# ---------------------------------------------------------------------------
# GET /paths/health
# ---------------------------------------------------------------------------

@paths_bp.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'module': 'paths',
        'endpoints': [
            '/paths/enumerate',
            '/paths/driving-graph',
            '/paths/distances',
            '/paths/calendar-slack',
            '/paths/recurring-subpaths',
        ],
        'limits': {
            'max_nodes': MAX_NODES,
            'max_links': MAX_LINKS,
            'max_payload_bytes': MAX_PAYLOAD_BYTES,
            'node_threshold_small_dag': NODE_THRESHOLD,
            'link_threshold_small_dag': LINK_THRESHOLD,
            'max_paths_return': MAX_PATHS_TO_RETURN,
        },
    })
