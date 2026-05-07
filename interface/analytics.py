"""interface/analytics.py - Boundary-crossing interface intelligence.

Source-agnostic engine that, given a Cybereum-native ``{nodes, links}``
payload plus a ``grouping_field``, identifies cross-boundary hotspots,
the cross-group dependency matrix, and the inputs needed to drive a
decision-grade interface recovery board.

The grouping field is a node attribute that names the "bucket" each
activity belongs to.  The engine treats any link whose endpoints are in
different buckets as a *cross-boundary handoff*.  By varying the
grouping field, the same engine answers different business questions:

    grouping_field    Question
    ----------------  -------------------------------------------------
    WBS_Path          Which package boundaries concentrate handoff risk?
    Contract          Which contractor handoffs concentrate risk?
    Phase             Which phase transitions are the weak point?
    Asset / System    Which system handoffs delay commissioning?
    Discipline        Which discipline interfaces (mech/elec) are risky?

The engine is intentionally source-agnostic: it does not care whether
the schedule originated from P6 XER, MSP XML, or native Cybereum
authoring -- only that nodes carry the chosen grouping field.

Outputs
-------
``compute_interface_analytics`` returns a dict with:

    summary    -- counts, ratios, grouping field used, warnings
    hotspots   -- per-group hotspot rows + composite hotspot score
    matrix     -- pred_group -> succ_group cross-traffic rows
    warnings   -- non-fatal advisories (missing-field, fallback used, ...)

No I/O.  Routes layer handles serialisation and HTTP.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

#: Field-name fallback chain used when the caller does not specify a
#: ``grouping_field`` and we have to pick something sensible.  Order
#: matters: ``WBS_Path`` is the richest signal (full hierarchical
#: path), ``WBS_Name`` is the leaf, ``WBS_ID`` and ``WBS`` are last
#: resorts.
DEFAULT_GROUPING_FALLBACK_CHAIN: Tuple[str, ...] = (
    "WBS_Path", "WBS_Name", "WBS", "WBS_ID",
)

#: Sentinel bucket name for nodes missing the grouping field.  Surfaced
#: in hotspots so users can see how much of the schedule lacks
#: structure -- often itself a finding.
UNASSIGNED_BUCKET = "(unassigned)"

#: Number of top per-direction sample activities surfaced per hotspot,
#: used by the recovery-board prompt to ground its answer.
TOP_SAMPLES_PER_HOTSPOT = 5


@dataclass
class HotspotWeights:
    """Composite hotspot score weighting (sums to 1.0 by convention).

    The score is::

        score = 100 * (
              w_incoming        * norm(incoming_cross_group)
            + w_distinct_pred   * norm(distinct_pred_groups)
            + w_outgoing        * norm(outgoing_cross_group)
            + w_distinct_succ   * norm(distinct_succ_groups)
            + w_risk            * norm(max(max_risk, max_downstream_risk))
        )

    All weights default to the values from the original P6 review code,
    which were tuned on a data-center capital project and have proven
    reasonable across other sectors.  Callers may override.
    """
    w_incoming: float = 0.35
    w_distinct_pred: float = 0.20
    w_outgoing: float = 0.25
    w_distinct_succ: float = 0.10
    w_risk: float = 0.10


@dataclass
class InterfaceConfig:
    grouping_field: Optional[str] = None
    weights: HotspotWeights = field(default_factory=HotspotWeights)
    #: Optional cap on the number of hotspot rows returned (after sort).
    #: ``None`` means no cap.  Useful for very large schedules where the
    #: caller only needs the top-N for display.
    max_hotspots: Optional[int] = None
    #: Fallback chain used when ``grouping_field`` is None.
    fallback_chain: Tuple[str, ...] = DEFAULT_GROUPING_FALLBACK_CHAIN
    #: Per-hotspot top-sample count for recovery-board grounding.
    top_samples_per_hotspot: int = TOP_SAMPLES_PER_HOTSPOT


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _norm(s: pd.Series) -> pd.Series:
    """Min-max normalise to [0, 1]; constant-or-empty -> all zeros."""
    s = pd.to_numeric(s, errors="coerce").replace([np.inf, -np.inf], np.nan).fillna(0.0)
    if s.empty:
        return s
    mn = float(s.min())
    mx = float(s.max())
    if mx <= mn:
        return pd.Series(0.0, index=s.index)
    return (s - mn) / (mx - mn)


def _coerce_id(value: Any) -> str:
    """Coerce a node-ID-ish value to a stable string key.

    Mirrors the convention enforced elsewhere in the service -- IDs are
    compared as strings (P6 uses int-castable strings, MSP can emit
    non-numeric).  Returns ``""`` for None / NaN so they collide into a
    single "missing" bucket the caller can detect.
    """
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value)


def _node_field(node: Dict[str, Any], field_name: str) -> Any:
    """Look up a field on a node dict, treating empty strings and NaN
    as missing.  Returns ``None`` when missing so callers can rely on
    falsy-checks without worrying about string-empty edge cases.
    """
    if not field_name:
        return None
    val = node.get(field_name)
    if val is None:
        return None
    if isinstance(val, float) and math.isnan(val):
        return None
    if isinstance(val, str) and not val.strip():
        return None
    return val


def _resolve_grouping_field(
    nodes: Sequence[Dict[str, Any]],
    config: InterfaceConfig,
    warnings: List[str],
) -> Tuple[str, int]:
    """Pick the grouping field.  Returns ``(field_name, populated_count)``.

    If the caller specified a field, honour it -- but surface a warning
    if no node carries that field, so the response signals "you asked
    for X, the schedule has no X".  Otherwise walk the fallback chain
    (``WBS_Path`` -> ``WBS_Name`` -> ``WBS`` -> ``WBS_ID``) and pick the
    first field with at least one populated value.
    """
    def _populated(name: str) -> int:
        if not name:
            return 0
        return sum(1 for n in nodes if _node_field(n, name) is not None)

    requested = config.grouping_field
    if requested:
        count = _populated(requested)
        if count == 0:
            warnings.append(
                f"grouping_field='{requested}' is not populated on any node; "
                f"all activities will collapse into a single bucket"
            )
        return requested, count

    for candidate in config.fallback_chain:
        count = _populated(candidate)
        if count > 0:
            if count < len(nodes):
                warnings.append(
                    f"grouping_field auto-selected as '{candidate}' "
                    f"(populated on {count}/{len(nodes)} nodes)"
                )
            return candidate, count

    # Nothing populated anywhere.  Use the first candidate so output
    # shape stays stable; the count==0 branch above already warned.
    fallback = config.fallback_chain[0] if config.fallback_chain else "WBS_Path"
    warnings.append(
        f"no grouping field populated on any node "
        f"(tried {', '.join(config.fallback_chain)}); "
        f"all activities will collapse into a single bucket"
    )
    return fallback, 0


def _build_node_frame(
    nodes: Sequence[Dict[str, Any]],
    grouping_field: str,
) -> pd.DataFrame:
    """Build a DataFrame keyed by string ID with the columns the engine
    needs.  Missing optional columns get neutral defaults (NaN for
    floats, empty string for grouping)."""
    if not nodes:
        return pd.DataFrame(columns=[
            "ID", "Name", "Code", "group", "is_milestone",
            "total_float", "risk_score",
        ])

    rows: List[Dict[str, Any]] = []
    for n in nodes:
        nid = _coerce_id(n.get("ID", n.get("id")))
        if not nid:
            continue
        group_raw = _node_field(n, grouping_field)
        group = str(group_raw) if group_raw is not None else UNASSIGNED_BUCKET

        # Milestone normalisation.  Cybereum P6 import emits
        # Milestone='1'/'0' strings; MSP emits 1/0 ints; native may
        # emit booleans.  Treat any of these forms uniformly.
        ms_raw = n.get("Milestone", n.get("isMilestone", n.get("is_milestone", 0)))
        is_milestone = str(ms_raw).strip().lower() in ("1", "true", "yes")

        # Optional fields; absent -> NaN so downstream agg ignores cleanly.
        tf = _to_float(
            n.get("total_float",
                  n.get("total_float_days",
                        n.get("Slack",
                              n.get("Float"))))
        )
        rs = _to_float(
            n.get("risk_score",
                  n.get("RiskScore",
                        n.get("Risk_Score")))
        )

        rows.append({
            "ID": nid,
            "Name": n.get("Name", n.get("task_name", "")),
            "Code": n.get("Code", n.get("task_code", "")),
            "group": group,
            "is_milestone": is_milestone,
            "total_float": tf,
            "risk_score": rs,
        })
    return pd.DataFrame(rows)


def _to_float(value: Any) -> float:
    if value is None:
        return float("nan")
    try:
        v = float(value)
    except (TypeError, ValueError):
        return float("nan")
    if math.isinf(v):
        return float("nan")
    return v


def _build_link_frame(
    links: Sequence[Dict[str, Any]],
    nodes_df: pd.DataFrame,
) -> pd.DataFrame:
    """Build a link DataFrame joined with grouping for source and
    target.  Links whose endpoints aren't in ``nodes_df`` are dropped
    silently -- the validation layer in routes.py is responsible for
    rejecting unresolvable references before we get here.
    """
    if not links:
        return pd.DataFrame(columns=[
            "source", "target", "type", "lag",
            "pred_group", "succ_group", "is_cross_group",
        ])

    rec = []
    for ln in links:
        s = _coerce_id(ln.get("source", ln.get("Source")))
        t = _coerce_id(ln.get("target", ln.get("Target")))
        if not s or not t:
            continue
        rec.append({
            "source": s,
            "target": t,
            "type": ln.get("type", ln.get("Type", "FS")),
            "lag": _to_float(ln.get("lag", ln.get("Lag", 0))),
        })
    if not rec:
        return pd.DataFrame(columns=[
            "source", "target", "type", "lag",
            "pred_group", "succ_group", "is_cross_group",
        ])

    rel = pd.DataFrame(rec)
    grp_map = nodes_df.set_index("ID")["group"]
    rel["pred_group"] = rel["source"].map(grp_map)
    rel["succ_group"] = rel["target"].map(grp_map)
    # Drop rows where either endpoint isn't a known node.
    rel = rel.dropna(subset=["pred_group", "succ_group"]).copy()
    # Self-loops cannot be cross-group; safe to keep for completeness
    # but mark not cross-group.
    rel["is_cross_group"] = (rel["pred_group"] != rel["succ_group"])
    return rel


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def compute_interface_analytics(
    nodes: Sequence[Dict[str, Any]],
    links: Sequence[Dict[str, Any]],
    config: Optional[InterfaceConfig] = None,
) -> Dict[str, Any]:
    """Compute boundary-crossing interface intelligence.

    See module docstring for output shape.
    """
    config = config or InterfaceConfig()
    warnings: List[str] = []

    grouping_field, populated_count = _resolve_grouping_field(
        nodes, config, warnings,
    )
    nodes_df = _build_node_frame(nodes, grouping_field)
    rel_df = _build_link_frame(links, nodes_df)
    # Join succ-side risk/float onto every link row once, so both
    # hotspots and matrix see the same enriched frame and stay in sync
    # on edge cases (a future change that drops a row from one side
    # would otherwise silently desync them).
    enriched_rel = _join_succ_attrs(rel_df, nodes_df)

    summary = _build_summary(nodes_df, enriched_rel, grouping_field,
                             populated_count)
    hotspots, hotspot_records = _compute_hotspots(
        nodes_df, enriched_rel, config, warnings,
    )
    matrix = _compute_matrix(enriched_rel)

    return {
        "summary": summary,
        "hotspots": hotspots,
        "matrix": matrix,
        "warnings": warnings,
        # Internal handle the routes layer uses to enrich hotspots with
        # top-sample activity names; not serialised on the API surface.
        "_hotspot_records": hotspot_records,
    }


def _build_summary(
    nodes_df: pd.DataFrame,
    rel_df: pd.DataFrame,
    grouping_field: str,
    populated_count: int,
) -> Dict[str, Any]:
    cross = rel_df[rel_df["is_cross_group"]] if not rel_df.empty else rel_df
    total_links = int(len(rel_df))
    cross_links = int(len(cross))
    return {
        "grouping_field": grouping_field,
        "populated_node_count": int(populated_count),
        "total_nodes": int(len(nodes_df)),
        "total_groups": int(nodes_df["group"].nunique()) if not nodes_df.empty else 0,
        "total_links": total_links,
        "cross_group_links": cross_links,
        "cross_group_ratio": float(cross_links / total_links) if total_links else 0.0,
        "groups_with_incoming_cross": int(
            cross["succ_group"].nunique()
        ) if cross_links else 0,
        "groups_with_outgoing_cross": int(
            cross["pred_group"].nunique()
        ) if cross_links else 0,
    }


def _join_succ_attrs(
    rel_df: pd.DataFrame,
    nodes_df: pd.DataFrame,
) -> pd.DataFrame:
    """Attach successor-side risk/float onto every link row.

    Done once at the top of ``compute_interface_analytics`` so all
    downstream aggregations see the same enriched frame.  Empty input
    returns an empty frame with the joined columns added so callers
    can rely on a stable schema.
    """
    if rel_df.empty:
        out = rel_df.copy()
        out["succ_total_float"] = pd.Series(dtype=float)
        out["succ_risk_score"] = pd.Series(dtype=float)
        return out
    succ_attrs = nodes_df.set_index("ID")[["total_float", "risk_score"]]
    return rel_df.join(succ_attrs.rename(columns={
        "total_float": "succ_total_float",
        "risk_score": "succ_risk_score",
    }), on="target")


def _compute_hotspots(
    nodes_df: pd.DataFrame,
    rel_df: pd.DataFrame,
    config: InterfaceConfig,
    warnings: List[str],
) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """Compute per-group hotspot rows + composite score.

    Returns ``(rows, records)`` where ``rows`` is the JSON-friendly
    payload and ``records`` is an internal-only dict keyed by group
    name carrying the activity DataFrames the routes layer uses to add
    top-N sample activities for the recovery-board prompt.
    """
    if rel_df.empty or not rel_df["is_cross_group"].any():
        return [], {}

    cross = rel_df[rel_df["is_cross_group"]].copy()

    # Incoming side (group is the SUCCESSOR end).
    in_agg = cross.groupby("succ_group", dropna=False).agg(
        incoming_cross_group=("source", "count"),
        distinct_pred_groups=("pred_group", "nunique"),
        min_float_days=("succ_total_float", "min"),
        avg_float_days=("succ_total_float", "mean"),
        max_risk=("succ_risk_score", "max"),
        avg_risk=("succ_risk_score", "mean"),
    ).rename_axis("group").reset_index()

    # Outgoing side (group is the PREDECESSOR end).  Downstream metrics
    # use the successor's risk -- "what happens when this group ships
    # late" is governed by the risk concentration of what's waiting on
    # it.
    out_agg = cross.groupby("pred_group", dropna=False).agg(
        outgoing_cross_group=("target", "count"),
        distinct_succ_groups=("succ_group", "nunique"),
        max_downstream_risk=("succ_risk_score", "max"),
        avg_downstream_risk=("succ_risk_score", "mean"),
    ).rename_axis("group").reset_index()

    hotspots = in_agg.merge(out_agg, on="group", how="outer")
    # Numeric columns: missing means "no traffic on this side"; zero is
    # the right neutral.  Float columns we leave as NaN for the API to
    # serialise to null (nothing is more wrong than reporting "0 days
    # of float" when in fact we have no data).
    for col, default in [
        ("incoming_cross_group", 0),
        ("distinct_pred_groups", 0),
        ("outgoing_cross_group", 0),
        ("distinct_succ_groups", 0),
    ]:
        if col in hotspots.columns:
            hotspots[col] = hotspots[col].fillna(default).astype(int)

    # Composite hotspot score.  ``_norm`` returns zero for constant or
    # empty series, so single-group schedules score zero rather than
    # crash.
    w = config.weights
    risk_combined = pd.concat([
        hotspots.get("max_risk", pd.Series(dtype=float)),
        hotspots.get("max_downstream_risk", pd.Series(dtype=float)),
    ], axis=1).max(axis=1)
    score = 100.0 * (
          w.w_incoming        * _norm(hotspots.get("incoming_cross_group", 0))
        + w.w_distinct_pred   * _norm(hotspots.get("distinct_pred_groups", 0))
        + w.w_outgoing        * _norm(hotspots.get("outgoing_cross_group", 0))
        + w.w_distinct_succ   * _norm(hotspots.get("distinct_succ_groups", 0))
        + w.w_risk            * _norm(risk_combined)
    )
    hotspots["interface_hotspot_score"] = score
    hotspots = hotspots.sort_values(
        "interface_hotspot_score", ascending=False, kind="stable",
    ).reset_index(drop=True)

    if config.max_hotspots is not None and config.max_hotspots > 0:
        hotspots = hotspots.head(config.max_hotspots)

    # Build per-group activity records the routes layer uses to surface
    # top-N example activities (decision-board grounding).
    records = _build_hotspot_records(cross, nodes_df, config)

    return hotspots.replace({np.nan: None}).to_dict("records"), records


def _build_hotspot_records(
    cross: pd.DataFrame,
    nodes_df: pd.DataFrame,
    config: InterfaceConfig,
) -> Dict[str, Dict[str, Any]]:
    """For each group, surface the top-N highest-risk cross-boundary
    activities on the incoming and outgoing sides.

    "Top" is by ``risk_score`` desc, ties broken by lowest float, then
    by Name for determinism.  When ``risk_score`` is missing we fall
    back to lowest float, then Name.  When both are missing we just
    return the first N by Name.
    """
    # ``top_samples_per_hotspot=0`` is a valid "skip top-samples"
    # signal; negative values are clamped to 0 by the validation layer.
    n = max(0, int(config.top_samples_per_hotspot))
    if n == 0:
        # Still emit the keys so downstream consumers see a stable
        # shape -- just with empty lists.
        empty: Dict[str, Dict[str, Any]] = {}
        for grp in cross["succ_group"].dropna().unique():
            empty.setdefault(str(grp), {})["top_incoming"] = []
        for grp in cross["pred_group"].dropna().unique():
            empty.setdefault(str(grp), {})["top_outgoing"] = []
        return empty
    nodes_idx = nodes_df.set_index("ID")
    records: Dict[str, Dict[str, Any]] = {}

    def _attach_attrs(ids: Iterable[str]) -> List[Dict[str, Any]]:
        out = []
        for nid in ids:
            if nid not in nodes_idx.index:
                continue
            row = nodes_idx.loc[nid]
            out.append({
                "ID": nid,
                "Name": row.get("Name", "") or "",
                "Code": row.get("Code", "") or "",
                "group": row.get("group", "") or "",
                "total_float": _nan_to_none(row.get("total_float")),
                "risk_score": _nan_to_none(row.get("risk_score")),
            })
        return out

    def _top(df: pd.DataFrame, id_col: str) -> List[str]:
        if df.empty:
            return []
        # Stable, deterministic ordering: high risk -> low float -> Name.
        df = df.copy()
        df["_neg_risk"] = -df["succ_risk_score"].fillna(-np.inf)
        df["_float_rank"] = df["succ_total_float"].fillna(np.inf)
        df = df.sort_values(["_neg_risk", "_float_rank"], kind="stable")
        return list(df[id_col].drop_duplicates().head(n))

    # Incoming: ranked by SUCCESSOR risk (the activity *receiving* the
    # cross-boundary handoff is the one that bears the consequence).
    for grp, sub in cross.groupby("succ_group", dropna=False):
        records.setdefault(str(grp), {})["top_incoming"] = _attach_attrs(
            _top(sub, "target"),
        )

    # Outgoing: again ranked by SUCCESSOR risk (the predecessor's
    # blast radius is determined by what's downstream).
    for grp, sub in cross.groupby("pred_group", dropna=False):
        records.setdefault(str(grp), {})["top_outgoing"] = _attach_attrs(
            _top(sub, "target"),
        )

    return records


def _compute_matrix(rel_df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Cross-group dependency matrix -- one row per (pred_group,
    succ_group) edge in the meta-graph.  Sorted by traffic count
    descending, ties broken by max successor risk."""
    if rel_df.empty or not rel_df["is_cross_group"].any():
        return []
    cross = rel_df[rel_df["is_cross_group"]].copy()
    matrix = cross.groupby(["pred_group", "succ_group"], dropna=False).agg(
        rel_count=("source", "count"),
        min_succ_float_days=("succ_total_float", "min"),
        max_succ_risk=("succ_risk_score", "max"),
    ).reset_index()
    matrix = matrix.sort_values(
        ["rel_count", "max_succ_risk"], ascending=False, kind="stable",
    ).reset_index(drop=True)
    return matrix.replace({np.nan: None}).to_dict("records")


def _nan_to_none(value: Any) -> Optional[float]:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v
