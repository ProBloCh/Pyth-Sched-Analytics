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


logger = logging.getLogger(__name__)

paths_bp = Blueprint('paths', __name__, url_prefix='/paths')


# ---------------------------------------------------------------------------
# Config -- line up with solver/routes.py limits
# ---------------------------------------------------------------------------

MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
MAX_NODES = 20_000
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
    input from turning into a 500."""
    if value is None:
        if default is None:
            return None, None  # treat as "unset" so caller can drop it
        v = default
    else:
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
