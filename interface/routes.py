"""interface/routes.py - Flask Blueprint for boundary-crossing analytics.

Endpoints
---------

    POST /interface/analytics  -- hotspots + cross-group matrix
    GET  /interface/health     -- liveness probe

Request body for /interface/analytics::

    {
      "nodes": [...],                # Cybereum-native nodes
      "links": [...],                # Cybereum-native links (FS/SS/FF/SF + lag ok)
      "grouping_field": "WBS_Path",  # optional; default chooses from
                                     # WBS_Path -> WBS_Name -> WBS -> WBS_ID
      "weights": {                   # optional override of composite-score weights
        "w_incoming": 0.35, "w_distinct_pred": 0.20,
        "w_outgoing": 0.25, "w_distinct_succ": 0.10,
        "w_risk": 0.10
      },
      "max_hotspots": 100,           # optional cap on returned hotspot rows
      "top_samples_per_hotspot": 5   # optional per-hotspot example-activity count
    }

Response::

    {
      "summary":  {...},
      "hotspots": [ {group, incoming_cross_group, ..., interface_hotspot_score,
                     top_incoming: [...], top_outgoing: [...]}, ... ],
      "matrix":   [ {pred_group, succ_group, rel_count, ...}, ... ],
      "warnings": [...],
      "cache_hit": bool
    }

Caching: lazy bridge to the host app's Redis cache, mirroring the
solver / completion / evm / paths blueprint pattern.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from typing import Any

import numpy as np
from flask import Blueprint, jsonify, request

from _cache_version import RESPONSE_SCHEMA_VERSION

from .analytics import (
    HotspotWeights,
    InterfaceConfig,
    compute_interface_analytics,
)

logger = logging.getLogger(__name__)

interface_bp = Blueprint("interface", __name__, url_prefix="/interface")


# ---------------------------------------------------------------------------
# Limits -- match paths/routes.py
# ---------------------------------------------------------------------------

MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
MAX_NODES = 20_000
MAX_LINKS = 100_000
MAX_HOTSPOTS_CAP = 5_000
MAX_TOP_SAMPLES = 50


@interface_bp.record_once
def _set_max_content_length(state):
    state.app.config.setdefault("MAX_CONTENT_LENGTH", MAX_PAYLOAD_BYTES)


# ---------------------------------------------------------------------------
# Lazy caching bridge
# ---------------------------------------------------------------------------

_cache_fns = None  # (get_fn, set_fn) | (None, None)


def _cache():
    global _cache_fns
    if _cache_fns is None:
        try:
            from app import get_cached_result, redis_client, set_cached_result
            if redis_client is None:
                _cache_fns = (None, None)
            else:
                _cache_fns = (get_cached_result, set_cached_result)
        except Exception as exc:
            logger.info("Caching not available for /interface: %s", exc)
            _cache_fns = (None, None)
    return _cache_fns


def _cache_key(prefix: str, data) -> str:
    raw = json.dumps(data, sort_keys=True, default=str)
    return f"interface:{RESPONSE_SCHEMA_VERSION}:{prefix}:{hashlib.sha256(raw.encode()).hexdigest()}"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate_nodes_links(data) -> str | None:
    nodes = data.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        return "nodes must be a non-empty list"
    if len(nodes) > MAX_NODES:
        return f"Too many nodes ({len(nodes)}); limit is {MAX_NODES}"

    links = data.get("links", [])
    if not isinstance(links, list):
        return "links must be a list"
    if len(links) > MAX_LINKS:
        return f"Too many links ({len(links)}); limit is {MAX_LINKS}"

    seen = set()
    for i, n in enumerate(nodes):
        if not isinstance(n, dict):
            return f"nodes[{i}] must be an object"
        nid = n.get("ID", n.get("id"))
        if nid is None:
            return f"nodes[{i}] missing ID"
        sid = str(nid)
        if sid in seen:
            return f"duplicate node ID: {nid}"
        seen.add(sid)
    for i, ln in enumerate(links):
        if not isinstance(ln, dict):
            return f"links[{i}] must be an object"
        if ln.get("source") is None or ln.get("target") is None:
            return f"links[{i}] missing source/target"
        # Soft-tolerant: links pointing to unknown nodes are dropped at
        # compute time rather than rejected -- matches /graph-metrics
        # behaviour for upstream tools that emit dangling refs.
    return None


def _parse_request():
    if request.content_length and request.content_length > MAX_PAYLOAD_BYTES:
        return None, (jsonify({"error": "Payload too large (limit: 10 MB)"}), 413)
    data = request.get_json(force=True, silent=True)
    if data is None:
        return None, (jsonify({"error": "Invalid or missing JSON body"}), 400)
    if not isinstance(data, dict):
        return None, (jsonify({"error": "JSON root must be an object"}), 400)
    err = _validate_nodes_links(data)
    if err:
        return None, (jsonify({"error": err}), 400)
    return data, None


def _coerce_weights(raw) -> tuple[HotspotWeights | None, Any]:
    if raw is None:
        return HotspotWeights(), None
    if not isinstance(raw, dict):
        return None, (jsonify({"error": "weights must be an object"}), 400)
    out = HotspotWeights()
    for key in ("w_incoming", "w_distinct_pred", "w_outgoing",
                "w_distinct_succ", "w_risk"):
        if key not in raw:
            continue
        v_raw = raw[key]
        # Reject bool -- ``float(True) == 1.0`` would otherwise let
        # JSON ``true`` slip past type validation as a unit weight.
        if isinstance(v_raw, bool):
            return None, (jsonify({
                "error": f"weights.{key} must be a number (got bool)"}), 400)
        try:
            v = float(v_raw)
        except (TypeError, ValueError):
            return None, (jsonify({
                "error": f"weights.{key} must be a number"}), 400)
        if math.isnan(v) or math.isinf(v) or v < 0.0:
            return None, (jsonify({
                "error": f"weights.{key} must be a finite, non-negative number"}), 400)
        setattr(out, key, v)
    return out, None


def _coerce_int(value, default, field, *, min_val=None, max_val=None):
    """Return ``(int, None)`` or ``(None, jsonify-err)``.

    Mirrors the bool/float guards in paths/routes.py::_coerce_int so
    JSON ``true`` and ``1.9`` don't silently coerce past type
    validation.
    """
    if value is None:
        return default, None
    # Reject bool first -- isinstance(True, int) is True in Python.
    if isinstance(value, bool):
        return None, (jsonify({
            "error": f"{field} must be an integer (got bool)"}), 400)
    # Reject float -- int(1.9) silently truncates.
    if isinstance(value, float):
        return None, (jsonify({
            "error": f"{field} must be an integer (got float)"}), 400)
    try:
        v = int(value)
    except (TypeError, ValueError):
        return None, (jsonify({"error": f"{field} must be an integer"}), 400)
    if min_val is not None and v < min_val:
        return None, (jsonify({"error": f"{field} must be >= {min_val}"}), 400)
    if max_val is not None and v > max_val:
        return None, (jsonify({"error": f"{field} must be <= {max_val}"}), 400)
    return v, None


def _coerce_grouping_field(value) -> tuple[str | None, Any]:
    if value is None:
        return None, None
    if not isinstance(value, str):
        return None, (jsonify({
            "error": "grouping_field must be a string"}), 400)
    s = value.strip()
    if not s:
        # Empty string is "use the default chain", same as None.
        return None, None
    return s, None


# ---------------------------------------------------------------------------
# Serialisation -- numpy/pandas types -> JSON
# ---------------------------------------------------------------------------

def _serialise(obj):
    if isinstance(obj, dict):
        return {k: _serialise(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_serialise(v) for v in obj]
    if isinstance(obj, np.ndarray):
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


# ---------------------------------------------------------------------------
# POST /interface/analytics
# ---------------------------------------------------------------------------

@interface_bp.route("/analytics", methods=["POST", "OPTIONS"])
def analytics():
    if request.method == "OPTIONS":
        return jsonify({"status": "ok"})
    data, err = _parse_request()
    if err:
        return err

    nodes = data["nodes"]
    links = data.get("links", [])

    grouping_field, err_ = _coerce_grouping_field(data.get("grouping_field"))
    if err_:
        return err_

    weights, err_ = _coerce_weights(data.get("weights"))
    if err_:
        return err_

    max_hotspots, err_ = _coerce_int(
        data.get("max_hotspots"), None, "max_hotspots",
        min_val=1, max_val=MAX_HOTSPOTS_CAP,
    )
    if err_:
        return err_

    top_samples, err_ = _coerce_int(
        data.get("top_samples_per_hotspot"), 5, "top_samples_per_hotspot",
        min_val=0, max_val=MAX_TOP_SAMPLES,
    )
    if err_:
        return err_

    config = InterfaceConfig(
        grouping_field=grouping_field,
        weights=weights,
        max_hotspots=max_hotspots,
        top_samples_per_hotspot=top_samples,
    )

    get_fn, set_fn = _cache()
    key = None
    if get_fn or set_fn:
        key = _cache_key("analytics", {
            "nodes": nodes, "links": links,
            "grouping_field": grouping_field,
            "weights": vars(weights),
            "max_hotspots": max_hotspots,
            "top_samples_per_hotspot": top_samples,
        })
    if get_fn and key is not None:
        cached = get_fn(key)
        if cached is not None:
            # Copy the dict so the cache_hit mutation can never bleed
            # back into an in-memory store (Redis returns a fresh dict
            # on every get; an LRU shim would not).
            cached = dict(cached)
            cached["cache_hit"] = True
            return jsonify(cached)

    try:
        result = compute_interface_analytics(nodes, links, config)
        records = result.pop("_hotspot_records", {})
        # Attach top-N example activities to each hotspot row -- the
        # routes layer is responsible for shape because the engine
        # itself is JSON-shape-agnostic.
        for row in result.get("hotspots", []):
            grp = row.get("group")
            samples = records.get(str(grp), {}) if grp is not None else {}
            row["top_incoming"] = samples.get("top_incoming", [])
            row["top_outgoing"] = samples.get("top_outgoing", [])
        result["cache_hit"] = False
        payload = _serialise(result)
        if set_fn and key is not None:
            set_fn(key, payload)
        return jsonify(payload)
    except Exception as e:
        logger.exception("/interface/analytics failed: %s", e)
        return jsonify({"error": "Internal interface-analytics error"}), 500


# ---------------------------------------------------------------------------
# GET /interface/health
# ---------------------------------------------------------------------------

@interface_bp.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "healthy",
        "module": "interface",
        "endpoints": ["/interface/analytics"],
        "limits": {
            "max_nodes": MAX_NODES,
            "max_links": MAX_LINKS,
            "max_payload_bytes": MAX_PAYLOAD_BYTES,
            "max_hotspots_cap": MAX_HOTSPOTS_CAP,
            "max_top_samples": MAX_TOP_SAMPLES,
        },
    })
