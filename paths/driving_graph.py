"""
paths/driving_graph.py - CPM-derived driving graph and chain extraction.

Ports the ``cybDG_*`` helpers from PathScripts.js (lines 6871-7431) --
a deterministic, O(N+E) alternative to exponential path enumeration.
For each node on the driving graph we compute the predecessor ranking
by "impact on ES" (how much each predecessor contributed to the
earliest start).  The chain enumeration then walks backwards from the
sink, only following predecessors whose contribution was within
``epsilon_hours`` (critical chains) or ``near_driving_tol_hours``
(near-critical chains) of the binding predecessor.  A Jaccard novelty
filter keeps the output compact and structurally distinct.

Pipeline:
    build_dag (full graph)
        -> active subgraph (reachable from start ∩ can reach end)
        -> rebuild DAG on active subgraph so ES/EF/LS/LF/TF are correct
           relative to the start/end window
        -> predecessor rankings per node, deltaHrs vs the binding
           candidate_ES
        -> driving / near-driving predecessor sets
        -> restrict to critical / near-critical nodes by TF
        -> backwards DFS from end to start
        -> Jaccard novelty selection
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

import numpy as np

from solver.dag import build_dag, DAGState
from .enumerate import path_duration


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class DrivingGraphConfig:
    """Matches JS CYB_DG_DEFAULT (line 6871)."""
    epsilon_hours: float = 0.01
    critical_float_tol_hours: float = 0.01
    near_critical_float_tol_hours: float = 24.0
    near_driving_tol_hours: float = 8.0
    max_critical_chains: int = 80
    max_near_critical_chains: int = 200
    max_expansions: int = 250_000
    max_depth_guard: int = 20_000
    selection_mode: str = 'outliers'   # 'raw' or 'outliers'
    max_display_chains: int = 15
    min_jaccard_novelty: float = 0.25


# ---------------------------------------------------------------------------
# Active subgraph
# ---------------------------------------------------------------------------

def _reachable(start_idx: int, succ: List[List[int]], n: int) -> np.ndarray:
    seen = np.zeros(n, dtype=bool)
    stack = [start_idx]
    seen[start_idx] = True
    while stack:
        u = stack.pop()
        for v in succ[u]:
            if not seen[v]:
                seen[v] = True
                stack.append(v)
    return seen


def _can_reach(end_idx: int, pred: List[List[int]], n: int) -> np.ndarray:
    seen = np.zeros(n, dtype=bool)
    stack = [end_idx]
    seen[end_idx] = True
    while stack:
        u = stack.pop()
        for p in pred[u]:
            if not seen[p]:
                seen[p] = True
                stack.append(p)
    return seen


def _filter_graph_to_active(nodes: List[dict], links: List[dict],
                            active_ids: Set[str]) -> Tuple[List[dict], List[dict]]:
    kept_nodes = [n for n in nodes
                  if str(n.get('ID', n.get('id', ''))) in active_ids]
    kept_links = []
    for ln in links:
        s = str(ln.get('source', ''))
        t = str(ln.get('target', ''))
        if s in active_ids and t in active_ids:
            kept_links.append(ln)
    return kept_nodes, kept_links


# ---------------------------------------------------------------------------
# Predecessor ranking
# ---------------------------------------------------------------------------

def _candidate_es(p_idx: int, j_idx: int, lag: float, rel: str,
                  ES: np.ndarray, EF: np.ndarray, d: np.ndarray) -> float:
    if rel == 'SS':
        return ES[p_idx] + lag
    if rel == 'FF':
        return EF[p_idx] + lag - d[j_idx]
    if rel == 'SF':
        return ES[p_idx] + lag - d[j_idx]
    return EF[p_idx] + lag  # FS default


@dataclass
class PredRank:
    pred_idx: int
    pred_id: str
    type: str
    lag_hours: float
    candidate_es: float
    delta_hours: float


def compute_pred_rankings(state: DAGState, idx_to_id: Dict[int, str]
                          ) -> Dict[int, List[PredRank]]:
    """Rank each node's predecessors by how close they came to fixing ES[j]."""
    rankings: Dict[int, List[PredRank]] = {}
    for j in range(state.n):
        preds = state.pred[j]
        if not preds:
            rankings[j] = []
            continue

        # Aggregate by predecessor index; keep the most constraining edge.
        best_es = -np.inf
        by_pred: Dict[int, Tuple[float, float, str]] = {}
        for k, p in enumerate(preds):
            lag, rel = state.pred_edges[j][k]
            cand = _candidate_es(p, j, lag, rel,
                                 state.ES, state.EF, state.durations)
            if cand > best_es:
                best_es = cand
            cur = by_pred.get(p)
            if cur is None or cand > cur[0]:
                by_pred[p] = (cand, lag, rel)

        arr = []
        for p, (cand, lag, rel) in by_pred.items():
            arr.append(PredRank(
                pred_idx=p,
                pred_id=idx_to_id.get(p, str(p)),
                type=rel,
                lag_hours=float(lag),
                candidate_es=float(cand),
                delta_hours=float(best_es - cand),
            ))
        arr.sort(key=lambda r: -r.candidate_es)
        rankings[j] = arr
    return rankings


def _build_driving_pred_sets(rankings: Dict[int, List[PredRank]],
                             cfg: DrivingGraphConfig
                             ) -> Tuple[Dict[int, List[PredRank]],
                                        Dict[int, List[PredRank]]]:
    driving: Dict[int, List[PredRank]] = {}
    near_driving: Dict[int, List[PredRank]] = {}
    for j, r in rankings.items():
        driving[j] = [x for x in r if x.delta_hours <= cfg.epsilon_hours]
        near_driving[j] = [x for x in r if x.delta_hours <= cfg.near_driving_tol_hours]
    return driving, near_driving


# ---------------------------------------------------------------------------
# Backwards chain enumeration
# ---------------------------------------------------------------------------

def enumerate_chains_backwards(
    start_idx: int,
    end_idx: int,
    pred_sets: Dict[int, List[PredRank]],
    cfg: DrivingGraphConfig,
    max_chains: int,
) -> List[Tuple[int, ...]]:
    """Walk back from ``end_idx`` following driving predecessors.

    Iterative DFS that tries the most-driving predecessor first (smallest
    delta) and bails once ``max_chains`` is reached.  Iterative because
    ``cfg.max_depth_guard`` defaults to 20,000 -- well past Python's
    recursion limit.
    """
    out: List[Tuple[int, ...]] = []
    if start_idx < 0 or end_idx < 0:
        return out

    path: List[int] = [end_idx]
    path_set: Set[int] = {end_idx}
    expansions = 0

    # Frame: [node, ordered_preds_or_None, next_child_idx]
    stack: List[List] = [[end_idx, None, 0]]

    while stack and len(out) < max_chains:
        if expansions > cfg.max_expansions:
            break

        node, ordered, child_idx = stack[-1]

        if ordered is None:
            expansions += 1
            if len(path) > cfg.max_depth_guard:
                stack.pop()
                if stack:
                    path.pop()
                    path_set.discard(node)
                continue
            if node == start_idx:
                out.append(tuple(reversed(path)))
                stack.pop()
                if stack:
                    path.pop()
                    path_set.discard(node)
                continue
            preds = pred_sets.get(node, [])
            ordered = sorted(preds, key=lambda r: r.delta_hours)
            stack[-1][1] = ordered
            if not ordered:
                stack.pop()
                if stack:
                    path.pop()
                    path_set.discard(node)
                continue

        if child_idx >= len(ordered):
            stack.pop()
            if stack:
                path.pop()
                path_set.discard(node)
            continue

        p = ordered[child_idx]
        stack[-1][2] = child_idx + 1
        pid = p.pred_idx
        if pid in path_set:
            continue
        path.append(pid)
        path_set.add(pid)
        stack.append([pid, None, 0])

    return out


# ---------------------------------------------------------------------------
# Jaccard novelty selection
# ---------------------------------------------------------------------------

def _jaccard(a: Set[int], b: Set[int]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a) + len(b) - inter
    return inter / union if union else 0.0


def select_outliers_by_novelty(
    chains: Sequence[Tuple[int, ...]],
    durations: Sequence[float],
    cfg: DrivingGraphConfig,
) -> Tuple[List[Tuple[int, ...]], List[float]]:
    """Greedy selection: accept a chain only if it's sufficiently novel
    vs. every already-selected chain.  Matches JS ``cybDG_selectOutliers``.
    """
    if not chains:
        return [], []
    order = sorted(range(len(chains)),
                   key=lambda i: -(durations[i] if i < len(durations) else 0.0))
    sel: List[Tuple[int, ...]] = []
    sel_dur: List[float] = []
    sel_sets: List[Set[int]] = []

    for i in order:
        if len(sel) >= cfg.max_display_chains:
            break
        p = chains[i]
        d = durations[i] if i < len(durations) else 0.0
        if not p:
            continue
        s = set(p)
        if not sel:
            sel.append(p)
            sel_dur.append(d)
            sel_sets.append(s)
            continue
        max_sim = max((_jaccard(s, ss) for ss in sel_sets), default=0.0)
        if max_sim <= (1.0 - cfg.min_jaccard_novelty):
            sel.append(p)
            sel_dur.append(d)
            sel_sets.append(s)
    return sel, sel_dur


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------

@dataclass
class DrivingGraphResult:
    paths: List[List[str]]
    durations: List[float]
    critical_chains: List[List[str]]
    near_critical_chains: List[List[str]]
    explainability: Dict = field(default_factory=dict)
    raw_candidate_count: int = 0
    active_node_count: int = 0
    project_finish_hours: float = 0.0


def extract_driving_graph(
    nodes: List[dict],
    links: List[dict],
    start_id,
    end_id,
    config: Optional[DrivingGraphConfig] = None,
) -> DrivingGraphResult:
    """Compute the CPM-derived driving graph and extract chains.

    Returns node-ID paths (strings) ready for JSON serialisation.
    """
    cfg = config or DrivingGraphConfig()
    s_id = str(start_id)
    e_id = str(end_id)

    # Full-graph DAG to identify reachability.
    full_state, full_idx = build_dag(nodes, links, default_duration=0.0)
    if s_id not in full_idx or e_id not in full_idx:
        return DrivingGraphResult(
            paths=[], durations=[],
            critical_chains=[], near_critical_chains=[],
            explainability={'error': 'start/end not in schedule'},
        )

    s_full = full_idx[s_id]
    e_full = full_idx[e_id]
    reach = _reachable(s_full, full_state.succ, full_state.n)
    can_reach = _can_reach(e_full, full_state.pred, full_state.n)
    active_mask = reach & can_reach
    if not np.any(active_mask):
        return DrivingGraphResult(
            paths=[], durations=[],
            critical_chains=[], near_critical_chains=[],
            explainability={'error': 'no active subgraph'},
        )

    # Rebuild DAG on active subgraph so ES/EF/LS/LF reflect the real window.
    idx_to_full_id = {i: nid for nid, i in full_idx.items()}
    active_ids = {idx_to_full_id[i]
                  for i in np.where(active_mask)[0].tolist()}
    sub_nodes, sub_links = _filter_graph_to_active(nodes, links, active_ids)
    state, idx = build_dag(sub_nodes, sub_links, default_duration=0.0)

    if s_id not in idx or e_id not in idx:
        # Shouldn't happen -- defensive.
        return DrivingGraphResult(
            paths=[], durations=[],
            critical_chains=[], near_critical_chains=[],
            explainability={'error': 'active subgraph rebuild failed'},
        )
    start_idx = idx[s_id]
    end_idx = idx[e_id]
    idx_to_id = {i: nid for nid, i in idx.items()}

    rankings = compute_pred_rankings(state, idx_to_id)
    driving, near_driving = _build_driving_pred_sets(rankings, cfg)

    # Critical / near-critical node masks based on TF.
    tf = state.TF
    crit_tol = cfg.critical_float_tol_hours + cfg.epsilon_hours
    near_tol = cfg.near_critical_float_tol_hours + cfg.epsilon_hours
    crit_node = set(int(i) for i in range(state.n) if tf[i] <= crit_tol)
    near_node = set(int(i) for i in range(state.n) if tf[i] <= near_tol)

    # Restrict predecessor sets to critical / near-critical nodes.
    crit_pred_sets: Dict[int, List[PredRank]] = {}
    near_pred_sets: Dict[int, List[PredRank]] = {}
    for j in range(state.n):
        if j in crit_node:
            crit_pred_sets[j] = [r for r in driving.get(j, [])
                                 if r.pred_idx in crit_node]
        else:
            crit_pred_sets[j] = []
        if j in near_node:
            near_pred_sets[j] = [r for r in near_driving.get(j, [])
                                 if r.pred_idx in near_node]
        else:
            near_pred_sets[j] = []

    critical_chains = enumerate_chains_backwards(
        start_idx, end_idx, crit_pred_sets, cfg, cfg.max_critical_chains)
    near_critical_chains = enumerate_chains_backwards(
        start_idx, end_idx, near_pred_sets, cfg, cfg.max_near_critical_chains)

    # Dedupe and merge.
    by_sig: Dict[Tuple[int, ...], Tuple[int, ...]] = {}
    for p in critical_chains:
        by_sig.setdefault(p, p)
    for p in near_critical_chains:
        by_sig.setdefault(p, p)

    candidates = list(by_sig.values())
    cand_durations = [path_duration(state, p) for p in candidates]

    if cfg.selection_mode == 'raw':
        sel_paths, sel_dur = list(candidates), list(cand_durations)
    else:
        sel_paths, sel_dur = select_outliers_by_novelty(
            candidates, cand_durations, cfg)

    def _to_ids(p: Tuple[int, ...]) -> List[str]:
        return [idx_to_id[i] for i in p]

    # Explainability: per-node top predecessors (for tooltip-style UI).
    explainability = {
        'start_id': s_id,
        'end_id': e_id,
        'project_finish_hours': float(state.makespan),
        'critical_chain_count': len(critical_chains),
        'near_critical_chain_count': len(near_critical_chains),
        'pred_rankings': {
            idx_to_id[j]: [
                {
                    'pred_id': r.pred_id,
                    'type': r.type,
                    'lag_hours': r.lag_hours,
                    'delta_hours': r.delta_hours,
                }
                for r in rankings[j][:cfg.max_display_chains]
            ]
            for j in range(state.n)
        },
    }

    return DrivingGraphResult(
        paths=[_to_ids(p) for p in sel_paths],
        durations=[float(d) for d in sel_dur],
        critical_chains=[_to_ids(p) for p in critical_chains],
        near_critical_chains=[_to_ids(p) for p in near_critical_chains],
        explainability=explainability,
        raw_candidate_count=len(candidates),
        active_node_count=int(np.count_nonzero(active_mask)),
        project_finish_hours=float(state.makespan),
    )
