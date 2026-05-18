"""
solver/dag.py - DAG construction and CPM (Critical Path Method) engine.

Supports all four standard precedence relationships with lags
(Elmaghraby, 1977; PMI Practice Standard for Scheduling):
  FS (Finish-to-Start):  ES[s] >= EF[p] + lag   (default)
  SS (Start-to-Start):   ES[s] >= ES[p] + lag
  FF (Finish-to-Finish): EF[s] >= EF[p] + lag
  SF (Start-to-Finish):  EF[s] >= ES[p] + lag

NumPy-vectorised forward/backward pass operating on contiguous arrays.
"""

import collections
import logging
import threading

import numpy as np

logger = logging.getLogger(__name__)

# Relationship type constants (interned for fast comparison in inner loop)
_FS = 'FS'
_SS = 'SS'
_FF = 'FF'
_SF = 'SF'


class DAGState:
    """Immutable-ish snapshot of a CPM computation."""
    __slots__ = (
        'n', 'topo_order', 'reverse_topo', 'pred', 'succ',
        'pred_edges', 'succ_edges',
        'durations', 'ES', 'EF', 'LS', 'LF', 'TF',
        'critical_mask', 'makespan',
        # Re-entry guard for solver/adjoints.py::resource_adj_dur so a
        # future parallelism PR that hands the same state to multiple
        # threads raises immediately instead of silently corrupting
        # ES/EF mid-FD-loop.  threading.Lock + non-blocking acquire is
        # atomic; the earlier bool-sentinel could TOCTOU between two
        # concurrent threads (Copilot finding #9).  CLAUDE.md
        # "Numerical correctness in adjoints" documents the contract.
        '_resource_adj_dur_lock',
    )

    def __init__(self, n, topo_order, pred, succ, durations,
                 pred_edges=None, succ_edges=None):
        self.n = n
        self.topo_order = topo_order
        self.reverse_topo = topo_order[::-1]
        self.pred = pred
        self.succ = succ
        self.pred_edges = pred_edges if pred_edges else [[] for _ in range(n)]
        self.succ_edges = succ_edges if succ_edges else [[] for _ in range(n)]
        self.durations = durations
        self._resource_adj_dur_lock = threading.Lock()
        self.ES = np.zeros(n, dtype=np.float64)
        self.EF = np.zeros(n, dtype=np.float64)
        self.LS = np.zeros(n, dtype=np.float64)
        self.LF = np.zeros(n, dtype=np.float64)
        self.TF = np.zeros(n, dtype=np.float64)
        self.critical_mask = np.zeros(n, dtype=bool)
        self.makespan = 0.0


def build_dag(nodes, links, default_duration=1.0):
    """
    Build a DAG from nodes/links and run CPM.

    Returns (DAGState, id_to_idx dict).

    ``default_duration`` is used when a node has no Duration field at
    all.  The solver endpoints (/solver/*) pass the default 1.0 --
    their fixtures always carry a Duration, and a missing one
    historically meant "unknown, assume 1 unit".  The completion
    endpoints (/completion/*) pass 0.0 because their validators
    treat a missing Duration as a milestone (no remaining work); a
    1.0 default here would otherwise diverge from the engine's
    scope-building logic and skew CPM / critical-path detection.
    Cycles are broken by Kahn's algorithm (back-edges silently dropped).
    """
    ids = [str(n.get('ID', n.get('id', i))) for i, n in enumerate(nodes)]
    id_to_idx = {aid: i for i, aid in enumerate(ids)}
    n = len(ids)

    if n == 0:
        state = DAGState(0, np.array([], dtype=np.int64), [], [],
                         np.array([], dtype=np.float64))
        return state, id_to_idx

    # Adjacency lists + per-edge metadata (lag, relationship type)
    pred = [[] for _ in range(n)]
    succ = [[] for _ in range(n)]
    pred_edges = [[] for _ in range(n)]
    succ_edges = [[] for _ in range(n)]

    for link in links:
        src = str(link.get('source', ''))
        tgt = str(link.get('target', ''))
        if src in id_to_idx and tgt in id_to_idx:
            si, ti = id_to_idx[src], id_to_idx[tgt]
            if si != ti:
                try:
                    lag = float(link.get('lag', 0))
                except (TypeError, ValueError):
                    lag = 0.0
                rel = str(link.get('type', 'FS')).upper()
                if rel not in (_FS, _SS, _FF, _SF):
                    rel = _FS
                succ[si].append(ti)
                pred[ti].append(si)
                succ_edges[si].append((lag, rel))
                pred_edges[ti].append((lag, rel))

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
            topo.append(node)
            visited[node] = True

        # Prune pred/succ so every edge goes forward in topo order.
        order_pos = np.empty(n, dtype=np.int64)
        for pos, node in enumerate(topo):
            order_pos[node] = pos
        for node in range(n):
            keep_p = [(p, pred_edges[node][k])
                      for k, p in enumerate(pred[node])
                      if order_pos[p] < order_pos[node]]
            pred[node] = [x[0] for x in keep_p]
            pred_edges[node] = [x[1] for x in keep_p]

            keep_s = [(s, succ_edges[node][k])
                      for k, s in enumerate(succ[node])
                      if order_pos[node] < order_pos[s]]
            succ[node] = [x[0] for x in keep_s]
            succ_edges[node] = [x[1] for x in keep_s]

    topo_arr = np.array(topo, dtype=np.int64)

    # Rate-limited warning for malformed non-sentinel Duration values
    # so field diagnostics surface "Duration = 'abc'" rather than
    # silently turning a real activity into a zero-duration milestone.
    # The route-layer validators catch this before we get here in the
    # normal flow; this is defense-in-depth + observability for any
    # internal caller that bypasses the route validator.
    _DUR_WARNED = {'emitted': False}

    def _dur(node):
        v = node.get('Duration', node.get('duration', default_duration))
        # Explicit milestone sentinels -> 0.0 silently.
        if v in ('', None, 0, 0.0, '0'):
            return 0.0
        try:
            return float(v)
        except (TypeError, ValueError):
            if not _DUR_WARNED['emitted']:
                logger.warning(
                    "build_dag: node id=%s has non-numeric Duration=%r; "
                    "treating as zero (further warnings suppressed for "
                    "this build).",
                    node.get('ID', node.get('id', '<unknown>')), v)
                _DUR_WARNED['emitted'] = True
            return 0.0
    durations = np.array([_dur(nodes[i]) for i in range(n)],
                         dtype=np.float64)

    state = DAGState(n, topo_arr, pred, succ, durations,
                     pred_edges, succ_edges)
    run_cpm(state)
    return state, id_to_idx


def run_cpm(state, durations=None):
    """Run forward/backward CPM passes with FS/SS/FF/SF + lag support.

    Relationship semantics (Elmaghraby, 1977):
      FS:  ES[s] >= EF[p] + lag     (Finish-to-Start, the default)
      SS:  ES[s] >= ES[p] + lag     (Start-to-Start)
      FF:  EF[s] >= EF[p] + lag  →  ES[s] >= EF[p] + lag - d[s]
      SF:  EF[s] >= ES[p] + lag  →  ES[s] >= ES[p] + lag - d[s]

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

    # ---- Forward pass ----
    ES[:] = 0.0
    for j in state.topo_order:
        max_es = 0.0
        for idx, p in enumerate(state.pred[j]):
            lag, rel = state.pred_edges[j][idx]
            if rel == _FS:
                max_es = max(max_es, EF[p] + lag)
            elif rel == _SS:
                max_es = max(max_es, ES[p] + lag)
            elif rel == _FF:
                max_es = max(max_es, EF[p] + lag - d[j])
            elif rel == _SF:
                max_es = max(max_es, ES[p] + lag - d[j])
        ES[j] = max_es
        EF[j] = ES[j] + d[j]

    state.makespan = float(np.max(EF)) if n > 0 else 0.0

    # ---- Backward pass ----
    #   FS:  LF[i] <= LS[s] - lag
    #   SS:  LF[i] <= LS[s] - lag + d[i]
    #   FF:  LF[i] <= LF[s] - lag
    #   SF:  LF[i] <= LF[s] - lag + d[i]
    LF[:] = state.makespan
    for i in state.reverse_topo:
        min_lf = state.makespan
        for idx, s in enumerate(state.succ[i]):
            lag, rel = state.succ_edges[i][idx]
            if rel == _FS:
                min_lf = min(min_lf, LS[s] - lag)
            elif rel == _SS:
                min_lf = min(min_lf, LS[s] - lag + d[i])
            elif rel == _FF:
                min_lf = min(min_lf, LF[s] - lag)
            elif rel == _SF:
                min_lf = min(min_lf, LF[s] - lag + d[i])
        LF[i] = min_lf
        LS[i] = LF[i] - d[i]

    state.TF = LS - ES
    state.critical_mask = np.abs(state.TF) < 1e-9
    return state


def get_critical_path_indices(state):
    """Single contiguous critical path, in topological order.

    When multiple critical paths exist, follows the first critical
    successor at each step (deterministic, reproducible).
    """
    if state.n == 0:
        return []

    # Find the start: critical activity with no critical predecessors
    crit_set = set(int(i) for i in state.topo_order if state.critical_mask[i])
    if not crit_set:
        return []

    # Start from the first critical node in topological order
    start = None
    for i in state.topo_order:
        if int(i) in crit_set:
            has_crit_pred = any(int(p) in crit_set for p in state.pred[i])
            if not has_crit_pred:
                start = int(i)
                break

    if start is None:
        start = min(crit_set)

    # Follow critical successors
    path = [start]
    current = start
    while True:
        next_crit = None
        for s in state.succ[current]:
            if int(s) in crit_set:
                next_crit = int(s)
                break
        if next_crit is None:
            break
        path.append(next_crit)
        current = next_crit

    return path
