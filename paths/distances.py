"""
paths/distances.py - Shortest / longest distance maps over a DAGState.

Ports PathScripts.js ``findDistancesToStart`` and ``findDistancesToEnd``
(lines 5980-6187).  Both sweep the graph in (reverse-)topological order
and propagate link-type-aware edge weights:

    FS:  d(s) = d(p) + dur(p) + lag
    SS:  d(s) = d(p) + lag
    FF:  d(s) = d(p) + max(0, dur(p) + lag - dur(s))
    SF:  d(s) = d(p) + max(0, lag - dur(s))

For each node we keep both the shortest (min over alternate paths) and
longest (max; equivalent to CPM forward) distance.  The resulting
arrays are the foundation for near-critical selection, driving-graph
filtering, and UI heat maps without having to enumerate paths.

Runs in O(N + E) on the existing DAGState -- no graph rebuild.
"""

import numpy as np

# Kept in sync with solver/dag.py.  Interned strings let us compare
# with `is` in the hot loop (micro-win vs. tuple unpack equality).
_FS = 'FS'
_SS = 'SS'
_FF = 'FF'
_SF = 'SF'


def _edge_weights_forward(p_idx, s_idx, lag, rel, d):
    """Forward edge weight: how much d(s) grows over d(p)."""
    dp = d[p_idx]
    ds = d[s_idx]
    if rel == _FS:
        return dp + lag
    if rel == _SS:
        return lag
    if rel == _FF:
        v = dp + lag - ds
        return v if v > 0.0 else 0.0
    if rel == _SF:
        v = lag - ds
        return v if v > 0.0 else 0.0
    return dp + lag


def distances_to_start(state):
    """
    Per-node shortest + longest distance FROM the project start.

    Start nodes (no predecessors) get distance 0.  For all others we
    sweep ``state.topo_order`` once, folding over each predecessor.

    Returns:
        dict {
            'shortest': (N,) float64 -- min path length from any start,
            'longest':  (N,) float64 -- max (matches CPM ES for FS-only DAGs).
        }
    """
    n = state.n
    if n == 0:
        return {'shortest': np.zeros(0), 'longest': np.zeros(0)}

    d = state.durations
    INF = np.inf
    NINF = -np.inf

    shortest = np.full(n, INF, dtype=np.float64)
    longest = np.full(n, NINF, dtype=np.float64)

    # Seed every predecessor-less node with 0.  The topo-sort Kahn's
    # produces only feeds these into the sweep below, so we pre-seed
    # to keep the inner loop branch-free.
    for j in state.topo_order:
        if not state.pred[j]:
            shortest[j] = 0.0
            longest[j] = 0.0

    for j_np in state.topo_order:
        j = int(j_np)
        preds = state.pred[j]
        if not preds:
            continue
        best_short = shortest[j]
        best_long = longest[j]
        for k, p in enumerate(preds):
            lag, rel = state.pred_edges[j][k]
            w = _edge_weights_forward(p, j, lag, rel, d)
            sp = shortest[p]
            lp = longest[p]
            if sp != INF:
                cand = sp + w
                if cand < best_short:
                    best_short = cand
            if lp != NINF:
                cand = lp + w
                if cand > best_long:
                    best_long = cand
        shortest[j] = best_short
        longest[j] = best_long

    # Unreachable nodes keep sentinel (Inf / -Inf); callers that want 0
    # should coerce, matching the JS convention (node.shortestDistanceToStart
    # = finite ? v : 0).
    return {'shortest': shortest, 'longest': longest}


def _edge_weights_backward(p_idx, s_idx, lag, rel, d):
    """Backward edge weight: how much d(p) grows over d(s) looking back.

    JS semantics (findDistancesToEnd):
        FS:  d(p) = d(s) + dur(p) + lag
        SS:  d(p) = max(dur(p), lag + d(s))
        FF:  d(p) = max(dur(p), max(0, dur(p) + lag - dur(s)) + d(s))
        SF:  d(p) = max(dur(p), max(0, lag - dur(s)) + d(s))
    """
    dp = d[p_idx]
    ds = d[s_idx]
    # ``p_idx`` here is the *predecessor* (node we're updating); ``s_idx``
    # the *successor*.  JS builds this map from the successor backward.


def distances_to_end(state):
    """
    Per-node shortest + longest distance TO the project end.

    Sweeps ``state.reverse_topo``.  Sink nodes (no successors) get 0.
    Returns the same dict shape as ``distances_to_start``.
    """
    n = state.n
    if n == 0:
        return {'shortest': np.zeros(0), 'longest': np.zeros(0)}

    d = state.durations
    INF = np.inf
    NINF = -np.inf

    shortest = np.full(n, INF, dtype=np.float64)
    longest = np.full(n, NINF, dtype=np.float64)

    for i in state.reverse_topo:
        if not state.succ[int(i)]:
            shortest[int(i)] = 0.0
            longest[int(i)] = 0.0

    for i_np in state.reverse_topo:
        i = int(i_np)
        succs = state.succ[i]
        if not succs:
            continue
        best_short = shortest[i]
        best_long = longest[i]
        dur_i = d[i]
        for k, s in enumerate(succs):
            lag, rel = state.succ_edges[i][k]
            dur_s = d[s]
            ss = shortest[s]
            ls = longest[s]
            # FS:   w = dur(i) + lag                (node+lag adds to path)
            # SS:   w' via max(dur(i), lag + child_dist)
            # FF:   w' via max(dur(i), max(0, dur(i)+lag-dur(s)) + child_dist)
            # SF:   w' via max(dur(i), max(0, lag - dur(s)) + child_dist)
            if rel == _FS:
                add = dur_i + lag
                if ss != INF:
                    cand = ss + add
                    if cand < best_short:
                        best_short = cand
                if ls != NINF:
                    cand = ls + add
                    if cand > best_long:
                        best_long = cand
            elif rel == _SS:
                if ss != INF:
                    cand = max(dur_i, lag + ss)
                    if cand < best_short:
                        best_short = cand
                if ls != NINF:
                    cand = max(dur_i, lag + ls)
                    if cand > best_long:
                        best_long = cand
            elif rel == _FF:
                overlap = max(0.0, dur_i + lag - dur_s)
                if ss != INF:
                    cand = max(dur_i, overlap + ss)
                    if cand < best_short:
                        best_short = cand
                if ls != NINF:
                    cand = max(dur_i, overlap + ls)
                    if cand > best_long:
                        best_long = cand
            elif rel == _SF:
                overlap = max(0.0, lag - dur_s)
                if ss != INF:
                    cand = max(dur_i, overlap + ss)
                    if cand < best_short:
                        best_short = cand
                if ls != NINF:
                    cand = max(dur_i, overlap + ls)
                    if cand > best_long:
                        best_long = cand
            else:
                add = dur_i + lag
                if ss != INF:
                    cand = ss + add
                    if cand < best_short:
                        best_short = cand
                if ls != NINF:
                    cand = ls + add
                    if cand > best_long:
                        best_long = cand
        shortest[i] = best_short
        longest[i] = best_long

    return {'shortest': shortest, 'longest': longest}


def near_critical_mask(state, tolerance_hours=24.0):
    """Nodes whose total float is within ``tolerance_hours`` of zero.

    Cheap alternative to re-enumerating paths when the UI just needs to
    shade near-critical activities.  Matches the ``nearCriticalFloatTolHours``
    default from PathScripts.js CYB_DG_DEFAULT.
    """
    if state.n == 0:
        return np.zeros(0, dtype=bool)
    return state.TF <= (tolerance_hours + 1e-9)
