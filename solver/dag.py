"""
solver/dag.py - DAG construction and CPM (Critical Path Method) engine.

NumPy-vectorised forward/backward pass.  Same algorithm as PathScripts.js
but operating on contiguous arrays for performance.
"""

import collections
import logging
import numpy as np

logger = logging.getLogger(__name__)


class DAGState:
    """Immutable-ish snapshot of a CPM computation."""
    __slots__ = (
        'n', 'topo_order', 'reverse_topo', 'pred', 'succ',
        'durations', 'ES', 'EF', 'LS', 'LF', 'TF',
        'critical_mask', 'makespan',
    )

    def __init__(self, n, topo_order, pred, succ, durations):
        self.n = n
        self.topo_order = topo_order
        self.reverse_topo = topo_order[::-1]
        self.pred = pred
        self.succ = succ
        self.durations = durations
        self.ES = np.zeros(n, dtype=np.float64)
        self.EF = np.zeros(n, dtype=np.float64)
        self.LS = np.zeros(n, dtype=np.float64)
        self.LF = np.zeros(n, dtype=np.float64)
        self.TF = np.zeros(n, dtype=np.float64)
        self.critical_mask = np.zeros(n, dtype=bool)
        self.makespan = 0.0


def build_dag(nodes, links):
    """
    Build a DAG from nodes/links and run CPM.

    Returns (DAGState, id_to_idx dict).
    Cycles are broken by Kahn's algorithm (back-edges silently dropped).
    """
    ids = [str(n.get('ID', n.get('id', i))) for i, n in enumerate(nodes)]
    id_to_idx = {aid: i for i, aid in enumerate(ids)}
    n = len(ids)

    if n == 0:
        state = DAGState(0, np.array([], dtype=np.int64), [], [],
                         np.array([], dtype=np.float64))
        return state, id_to_idx

    # Adjacency lists
    pred = [[] for _ in range(n)]
    succ = [[] for _ in range(n)]

    for link in links:
        src = str(link.get('source', ''))
        tgt = str(link.get('target', ''))
        if src in id_to_idx and tgt in id_to_idx:
            si, ti = id_to_idx[src], id_to_idx[tgt]
            if si != ti:
                succ[si].append(ti)
                pred[ti].append(si)

    # Kahn's topological sort (also handles cycles gracefully)
    in_deg = np.array([len(p) for p in pred], dtype=np.int64)
    queue = collections.deque(np.where(in_deg == 0)[0])
    topo = []
    visited = np.zeros(n, dtype=bool)

    while queue:
        node = queue.popleft()
        if visited[node]:
            continue
        visited[node] = True
        topo.append(node)
        for s in succ[node]:
            in_deg[s] -= 1
            if in_deg[s] == 0:
                queue.append(s)

    # Nodes caught in cycles: append them so we don't lose data
    if len(topo) < n:
        remaining = [i for i in range(n) if not visited[i]]
        logger.warning("DAG has cycles involving %d nodes; back-edges dropped",
                       len(remaining))
        for node in remaining:
            pred[node] = [p for p in pred[node] if visited[p]]
            topo.append(node)
            visited[node] = True

    topo_arr = np.array(topo, dtype=np.int64)

    durations = np.array(
        [float(nodes[i].get('Duration', nodes[i].get('duration', 1.0)))
         for i in range(n)],
        dtype=np.float64,
    )

    state = DAGState(n, topo_arr, pred, succ, durations)
    run_cpm(state)
    return state, id_to_idx


def run_cpm(state, durations=None):
    """Run forward/backward CPM passes.  Updates *state* in place.

    Aliasing contract: when *durations* is provided, ``state.durations``
    is set to that exact array (reference, not copy).  Callers that
    temporarily swap durations (e.g. finite-difference loops) must
    restore the original reference when done.
    """
    if state.n == 0:
        return state

    if durations is not None:
        state.durations = durations

    n = state.n
    d  = state.durations
    ES = state.ES
    EF = state.EF
    LS = state.LS
    LF = state.LF

    # Forward pass
    ES[:] = 0.0
    for j in state.topo_order:
        if state.pred[j]:
            ES[j] = max(EF[p] for p in state.pred[j])
        EF[j] = ES[j] + d[j]

    state.makespan = float(np.max(EF)) if n > 0 else 0.0

    # Backward pass
    LF[:] = state.makespan
    for i in state.reverse_topo:
        if state.succ[i]:
            LF[i] = min(LS[s] for s in state.succ[i])
        LS[i] = LF[i] - d[i]

    state.TF = LS - ES
    state.critical_mask = np.abs(state.TF) < 1e-9
    return state


def get_critical_path_indices(state):
    """Activity indices on the critical path, in topological order."""
    if state.n == 0:
        return []
    return [int(i) for i in state.topo_order if state.critical_mask[i]]
