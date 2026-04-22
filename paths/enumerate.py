"""
paths/enumerate.py - Path enumeration on top of solver.dag.DAGState.

Ports three JS algorithms from PathScripts.js:

* ``enumerateAllPathsExact`` (lines 3252-3313) -- DFS + suffix
  memoisation.  For a DAG with U uniquely reachable suffixes from a
  given node, the memo amortises the cost of building paths that
  share a tail: each unique suffix is built once.  Used when
  ``n <= node_threshold`` and ``E <= link_threshold`` (the JS
  dispatcher limits 700 / 1000).

* ``enumerateLongestPathsFirst`` (lines 3389-3515) -- best-first search
  ordered by ``(est_duration, critical_count, length)``.  Each state is
  an (immutable) path tuple; heapq is the priority queue.  Full path
  signature memoisation avoids the
  "different-visits-same-key" collision that the JS bugfix comment on
  line 3422-3428 calls out.

* ``calculatePathDuration`` (lines 3030-3142) -- per-hop FS/SS/FF/SF
  duration accumulation.  Used as the tie-breaker after enumeration.

The dispatcher ``find_all_paths`` picks the strategy the same way JS
does, so behaviour is comparable.  All compute stays on NumPy arrays
held by the DAGState -- no re-walk of JSON.
"""

from __future__ import annotations

import heapq
import logging
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from solver.dag import build_dag, DAGState


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Thresholds -- match PathScripts.js constants so clients get familiar
# behaviour.  Caller can override via arguments.
# ---------------------------------------------------------------------------
NODE_THRESHOLD = 700
LINK_THRESHOLD = 1000
MAX_PATHS_TO_RETURN = 10_000
MAX_PATHS_PER_NODE = 10_000     # exact enumeration safety limit
DEFAULT_MAX_EXPANSIONS = 100_000

# Branch-balance defaults (JS BRANCH_BALANCE_CONFIG, line 643).
_BRANCH_MAX_PER = 100
_BRANCH_PENALTY = 0.5


# ---------------------------------------------------------------------------
# Path duration with FS/SS/FF/SF semantics
# ---------------------------------------------------------------------------

_FS = 'FS'
_SS = 'SS'
_FF = 'FF'
_SF = 'SF'


def _succ_edge_lookup(state: DAGState, src: int, tgt: int):
    """Return (lag, rel) for the src->tgt edge, or None."""
    succs = state.succ[src]
    for k, s in enumerate(succs):
        if s == tgt:
            return state.succ_edges[src][k]
    return None


def path_duration(state: DAGState, path: Sequence[int]) -> float:
    """
    Duration of a single path using exact FS/SS/FF/SF + lag arithmetic.

    Mirrors JS ``calculatePathDuration`` line-for-line but operates on
    node indices and NumPy duration array.
    """
    L = len(path)
    if L <= 1:
        return 0.0

    d = state.durations
    start_times = {path[0]: 0.0}
    finish_times = {path[0]: float(d[path[0]])}

    for i in range(L - 1):
        cur = path[i]
        nxt = path[i + 1]
        cs = start_times[cur]
        cf = finish_times[cur]
        dur_n = float(d[nxt])

        edge = _succ_edge_lookup(state, cur, nxt)
        if edge is None:
            # No direct edge -- JS falls back to FS with zero lag.  Happens
            # when a caller asks the duration of an arbitrary node path
            # that doesn't correspond to real dependencies.
            ns, nf = cf, cf + dur_n
        else:
            lag, rel = edge
            if rel == _FS:
                ns = cf + lag
                nf = ns + dur_n
            elif rel == _SS:
                ns = cs + lag
                nf = ns + dur_n
            elif rel == _FF:
                nf = cf + lag
                ns = max(0.0, nf - dur_n)
            elif rel == _SF:
                nf = cs + lag
                ns = max(0.0, nf - dur_n)
            else:
                ns = cf + lag
                nf = ns + dur_n

        if ns < 0.0:
            ns = 0.0
        if nf < ns + dur_n:
            nf = ns + dur_n
        start_times[nxt] = ns
        finish_times[nxt] = nf

    return finish_times[path[-1]]


# ---------------------------------------------------------------------------
# Exact enumeration (small DAGs)
# ---------------------------------------------------------------------------

def enumerate_all_paths_exact(
    state: DAGState,
    start_idx: int,
    end_idx: int,
    max_paths: int = MAX_PATHS_TO_RETURN,
) -> List[Tuple[int, ...]]:
    """
    Enumerate every path from start to end via DFS with suffix memoisation.

    A "suffix" is a list of node-index tuples each starting at a given
    node and ending at ``end_idx``.  Memoising per start-node lets
    shared tails be built once, not per prefix.

    Returns paths as tuples of int indices (hashable for de-dup by caller).
    The recursion skips ``visited`` nodes to keep the JS parity --
    DAGs can't cycle, but disconnected sub-DAGs produced by the cycle
    breaker can re-enter a node along an alias; guarding is cheap.
    """
    if state.n == 0 or start_idx < 0 or end_idx < 0:
        return []

    succ = state.succ
    memo: Dict[int, List[Tuple[int, ...]]] = {}

    # Iterative DFS with explicit stack -- Python recursion tops out
    # around 1,000 frames and real schedules comfortably exceed that.
    # We still emulate the JS "visited" set to guard against aliasing.
    def dfs(u: int) -> List[Tuple[int, ...]]:
        if u == end_idx:
            return [(u,)]
        if u in memo:
            return memo[u]

        stack: List[Tuple[int, int, List[Tuple[int, ...]]]] = []
        path_set = set()

        # Frames: (node, next_child_index, accumulated_suffixes_for_children)
        stack.append((u, 0, []))
        path_set.add(u)

        result_for: Dict[int, List[Tuple[int, ...]]] = {}

        while stack:
            node, ci, acc = stack[-1]
            children = succ[node]
            advanced = False
            while ci < len(children):
                nbr = int(children[ci])
                ci += 1
                if nbr == end_idx:
                    acc.append((node, end_idx))
                    if len(acc) >= MAX_PATHS_PER_NODE:
                        break
                    continue
                if nbr in path_set:
                    continue
                if nbr in memo:
                    for suf in memo[nbr]:
                        acc.append((node,) + suf)
                        if len(acc) >= MAX_PATHS_PER_NODE:
                            break
                    if len(acc) >= MAX_PATHS_PER_NODE:
                        break
                    continue
                # Descend.  Save ci for when we come back.
                stack[-1] = (node, ci, acc)
                stack.append((nbr, 0, []))
                path_set.add(nbr)
                advanced = True
                break
            if advanced:
                continue

            # Done processing this frame.
            path_set.discard(node)
            memo[node] = acc
            result_for[node] = acc
            stack.pop()
            if stack:
                parent, pci, pacc = stack[-1]
                for suf in acc:
                    pacc.append((parent,) + suf)
                    if len(pacc) >= MAX_PATHS_PER_NODE:
                        break
                stack[-1] = (parent, pci, pacc)

        return result_for.get(u, memo.get(u, []))

    all_suffixes = dfs(start_idx)
    # De-dup and cap to max_paths.  Suffixes are already tuples so set-ok.
    seen = set()
    out: List[Tuple[int, ...]] = []
    for p in all_suffixes:
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
        if len(out) >= max_paths:
            break
    return out


# ---------------------------------------------------------------------------
# Longest-first enumeration (large DAGs)
# ---------------------------------------------------------------------------

class _PathTracker:
    """Top-K longest paths via min-heap eviction.  Matches JS PathTracker."""

    __slots__ = ('max_paths', 'paths', '_heap', '_counter')

    def __init__(self, max_paths: int):
        self.max_paths = max_paths
        self.paths: Dict[Tuple[int, ...], float] = {}
        # Heap entries: (duration, counter, signature) -- counter for stable
        # ordering when durations tie.
        self._heap: List[Tuple[float, int, Tuple[int, ...]]] = []
        self._counter = 0

    def __len__(self):
        return len(self.paths)

    def is_full(self):
        return len(self.paths) >= self.max_paths

    def add(self, path: Tuple[int, ...], duration: float) -> bool:
        if path in self.paths:
            return False
        if len(self.paths) >= self.max_paths:
            # Lazy-evict: pop until we find a live entry.  If the new path
            # is no better than the shortest live one, drop it.
            while self._heap:
                min_dur, _ct, min_sig = self._heap[0]
                if min_sig in self.paths and self.paths[min_sig] == min_dur:
                    break
                heapq.heappop(self._heap)
            if self._heap:
                min_dur, _ct, min_sig = self._heap[0]
                if duration <= min_dur:
                    return False
                heapq.heappop(self._heap)
                self.paths.pop(min_sig, None)
        self.paths[path] = duration
        self._counter += 1
        heapq.heappush(self._heap, (duration, self._counter, path))
        return True

    def min_duration(self) -> Optional[float]:
        while self._heap:
            dur, _ct, sig = self._heap[0]
            if sig in self.paths and self.paths[sig] == dur:
                return dur
            heapq.heappop(self._heap)
        return None

    def items(self):
        return list(self.paths.items())


def enumerate_longest_paths_first(
    state: DAGState,
    start_idx: int,
    end_idx: int,
    max_paths: int = MAX_PATHS_TO_RETURN,
    critical_mask: Optional[np.ndarray] = None,
    branch_balanced: bool = True,
    max_expansions: int = DEFAULT_MAX_EXPANSIONS,
) -> List[Tuple[int, ...]]:
    """
    Best-first search ordered by estimated duration.

    Heap key: ``(-est_duration, -critical_count, -length)``.  Negative so
    ``heapq.heappop`` returns the highest-ranked state first.

    ``critical_mask`` (optional) lets the priority favour paths rich in
    critical activities -- matches the JS ``criticalCount`` tie-breaker.
    ``branch_balanced=True`` reproduces JS BranchBalancedQueue's penalty:
    once a branch (identified by the second node) has more than
    ``_BRANCH_MAX_PER`` states in flight, further pushes on that branch
    get their priority multiplied by ``_BRANCH_PENALTY`` to keep sibling
    branches competitive.
    """
    if state.n == 0 or start_idx < 0 or end_idx < 0:
        return []

    if critical_mask is None:
        critical_mask = state.critical_mask

    # Per-edge heuristic weight is computed inline below as
    # ``durations[last] + lag`` -- no need for an O(E) precomputed dict.
    durations = state.durations
    heap: List = []

    # Stable tie-break counter (heapq doesn't allow custom cmp).
    counter = 0
    start_path: Tuple[int, ...] = (start_idx,)
    start_crit = 1 if bool(critical_mask[start_idx]) else 0

    def push(path: Tuple[int, ...], est: float, crit: int):
        nonlocal counter
        priority_est = est
        if branch_balanced and len(path) >= 2:
            br = path[1]
            cnt = branch_counts.get(br, 0)
            if cnt >= _BRANCH_MAX_PER:
                priority_est *= _BRANCH_PENALTY
        counter += 1
        heapq.heappush(
            heap,
            (-priority_est, -crit, -len(path), counter, path, est, crit),
        )

    branch_counts: Dict[int, int] = {}

    def _branch_inc(p: Tuple[int, ...]):
        if len(p) >= 2:
            branch_counts[p[1]] = branch_counts.get(p[1], 0) + 1

    def _branch_dec(p: Tuple[int, ...]):
        if len(p) >= 2:
            br = p[1]
            cur = branch_counts.get(br, 0)
            if cur <= 1:
                branch_counts.pop(br, None)
            else:
                branch_counts[br] = cur - 1

    push(start_path, 0.0, start_crit)
    _branch_inc(start_path)

    tracker = _PathTracker(max_paths)
    state_cache: Dict[Tuple[int, ...], float] = {}
    expansions = 0
    # Convergence guard: once the tracker is full, allow a bounded run of
    # additional expansions to give the eviction logic a chance to swap in
    # higher-est completions discovered later.  Since est accumulates only
    # realised edge weights (no "remaining-to-end" admissible heuristic),
    # heap-top est cannot upper-bound future completions, so we cap by
    # number of expansions without improvement instead.
    no_improvement_cap = max(max_paths * 2, 2000)
    expansions_since_improve = 0

    while heap and expansions < max_expansions:
        _pe, _pc, _pl, _ct, path, est, crit = heapq.heappop(heap)
        _branch_dec(path)
        expansions += 1
        if tracker.is_full():
            expansions_since_improve += 1
            if expansions_since_improve >= no_improvement_cap:
                break

        # Skip memoised if we've seen this exact path with >= est.
        prev = state_cache.get(path)
        if prev is not None and prev >= est:
            continue
        state_cache[path] = est

        last = path[-1]
        if last == end_idx:
            # Track by heuristic estimate (JS PathTracker keys on est;
            # exact durations are computed by find_all_paths for final sort).
            if tracker.add(path, est):
                expansions_since_improve = 0
            continue

        # Expand neighbours.  solver.dag.build_dag prunes edges so they
        # always go forward in topo order and drops self-loops (see the
        # cycle-break block in build_dag), so a successor cannot already
        # appear in the current path -- no membership check needed in the
        # hot loop.
        # FS-based heuristic weight per hop = dur(last) + lag.  Computing
        # this inline avoids a precomputed O(E) dict and one (tuple, dict)
        # lookup per expansion (JS findAllPaths line 3517-3532 equivalent).
        last_dur = float(durations[last])
        for k, s in enumerate(state.succ[last]):
            nbr = int(s)
            lag, _rel = state.succ_edges[last][k]
            new_path = path + (nbr,)
            new_est = est + last_dur + float(lag)
            new_crit = crit + (1 if bool(critical_mask[nbr]) else 0)
            push(new_path, new_est, new_crit)
            _branch_inc(new_path)

        # Trim: heap blow-up guard (JS line 3472).  Re-derive branch_counts
        # from survivors so penalties don't count dropped states.
        if len(heap) > max_paths * 4:
            heap.sort()
            del heap[max_paths * 2:]
            heapq.heapify(heap)
            branch_counts.clear()
            for entry in heap:
                _branch_inc(entry[4])

    # Sort results by duration desc; tie-break by path length.
    items = tracker.items()
    items.sort(key=lambda kv: (-kv[1], len(kv[0])))
    return [p for p, _d in items]


# ---------------------------------------------------------------------------
# Dispatcher -- mirrors JS findAllPaths (line 3149)
# ---------------------------------------------------------------------------

def find_all_paths(
    nodes: List[dict],
    links: List[dict],
    start_id,
    end_id,
    max_paths: int = MAX_PATHS_TO_RETURN,
    node_threshold: int = NODE_THRESHOLD,
    link_threshold: int = LINK_THRESHOLD,
    include_durations: bool = True,
    branch_balanced: bool = True,
) -> dict:
    """
    Enumerate paths from ``start_id`` to ``end_id``.

    Picks exact DFS for small DAGs and longest-first for large ones,
    matching JS ``findAllPaths``.  Returns paths as lists of node IDs
    (strings) so the API shape stays consumer-friendly.

    Returns ``{'paths': [...], 'durations': [...], 'method': 'exact'|'longest_first',
               'raw_path_count': int, 'start_id': str, 'end_id': str}``.
    """
    state, id_to_idx = build_dag(nodes, links, default_duration=0.0)
    s = str(start_id)
    e = str(end_id)
    if s not in id_to_idx or e not in id_to_idx:
        return {
            'paths': [], 'durations': [], 'method': 'none',
            'raw_path_count': 0, 'start_id': s, 'end_id': e,
            'error': 'start or end ID not in schedule',
        }
    start_idx = id_to_idx[s]
    end_idx = id_to_idx[e]

    is_large = (state.n > node_threshold) or (len(links) > link_threshold)

    if not is_large:
        raw = enumerate_all_paths_exact(state, start_idx, end_idx, max_paths)
        method = 'exact'
    else:
        raw = enumerate_longest_paths_first(
            state, start_idx, end_idx,
            max_paths=max_paths,
            branch_balanced=branch_balanced,
        )
        method = 'longest_first'

    idx_to_id = {i: nid for nid, i in id_to_idx.items()}
    path_ids: List[List[str]] = [[idx_to_id[i] for i in p] for p in raw]

    if include_durations:
        durations = [path_duration(state, p) for p in raw]
    else:
        durations = []

    if durations:
        order = sorted(range(len(raw)), key=lambda i: -durations[i])
        path_ids = [path_ids[i] for i in order]
        durations = [durations[i] for i in order]

    return {
        'paths': path_ids,
        'durations': durations,
        'method': method,
        'raw_path_count': len(raw),
        'start_id': s,
        'end_id': e,
        'makespan_hours': float(state.makespan),
    }
