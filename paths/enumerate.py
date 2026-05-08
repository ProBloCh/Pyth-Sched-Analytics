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

from solver.dag import DAGState, build_dag

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


def build_succ_edge_index(state: DAGState):
    """Build a per-node ``{tgt: (lag, rel)}`` lookup for O(1) hop access.

    Returns a list ``idx`` where ``idx[src][tgt]`` is the edge metadata.
    Callers that need to compute many path_duration() values for the same
    DAGState should build this once per request and pass it explicitly --
    do NOT keep a process-wide cache keyed on ``id(state)``: id() can be
    reused after GC and would silently return the wrong index.
    """
    idx: List[Dict[int, Tuple[float, str]]] = [None] * state.n  # type: ignore[list-item]
    for u in range(state.n):
        m: Dict[int, Tuple[float, str]] = {}
        for k, v in enumerate(state.succ[u]):
            m[int(v)] = state.succ_edges[u][k]
        idx[u] = m
    return idx


def path_duration(state: DAGState, path: Sequence[int],
                  edge_index=None) -> float:
    """
    Duration of a single path using exact FS/SS/FF/SF + lag arithmetic.

    Mirrors JS ``calculatePathDuration`` line-for-line but operates on
    node indices and NumPy duration array.

    ``edge_index``: optional per-node ``{tgt: (lag, rel)}`` lookup built
    via :func:`build_succ_edge_index`.  When provided, the per-hop edge
    lookup is O(1).  When ``None`` (e.g. from a one-off caller), the
    function falls back to a linear scan of ``state.succ[src]`` -- still
    correct, just slower for high out-degree graphs.
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

        if edge_index is not None:
            edge = edge_index[cur].get(nxt)
        else:
            # One-off caller: linear scan over successors.
            edge = None
            succs = state.succ[cur]
            for k, s in enumerate(succs):
                if s == nxt:
                    edge = state.succ_edges[cur][k]
                    break
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
) -> Tuple[List[Tuple[int, ...]], bool]:
    """
    Enumerate every path from start to end via DFS with suffix memoisation.

    A "suffix" is a list of node-index tuples each starting at a given
    node and ending at ``end_idx``.  Memoising per start-node lets
    shared tails be built once, not per prefix.

    Returns ``(paths, truncated)``: paths as tuples of int indices
    (hashable for de-dup by caller), and a bool that is True only when
    enumeration actually stopped early -- either the per-node
    ``MAX_PATHS_PER_NODE`` cap fired during DFS, or the final cap to
    ``max_paths`` left additional unique paths un-emitted.  Hitting
    ``max_paths`` exactly with no further suffixes available is
    exhaustive and reports ``truncated=False``.
    """
    if state.n == 0 or start_idx < 0 or end_idx < 0:
        return [], False

    succ = state.succ
    memo: Dict[int, List[Tuple[int, ...]]] = {}
    # Set to True the moment any per-node accumulator hits
    # MAX_PATHS_PER_NODE -- at that point we've abandoned suffixes
    # we would otherwise have emitted, so the corpus is no longer
    # exhaustive.
    cap_fired = [False]

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
                        cap_fired[0] = True
                        break
                    continue
                if nbr in path_set:
                    continue
                if nbr in memo:
                    for suf in memo[nbr]:
                        acc.append((node,) + suf)
                        if len(acc) >= MAX_PATHS_PER_NODE:
                            cap_fired[0] = True
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
                        cap_fired[0] = True
                        break
                stack[-1] = (parent, pci, pacc)

        return result_for.get(u, memo.get(u, []))

    all_suffixes = dfs(start_idx)
    # De-dup and cap to max_paths.  Suffixes are already tuples so set-ok.
    # Track whether we *stopped* before consuming all unique suffixes --
    # hitting max_paths exactly with no leftover paths is exhaustive.
    seen = set()
    out: List[Tuple[int, ...]] = []
    final_cap_fired = False
    for p in all_suffixes:
        if p in seen:
            continue
        if len(out) >= max_paths:
            final_cap_fired = True
            break
        seen.add(p)
        out.append(p)
    truncated = cap_fired[0] or final_cap_fired
    return out, truncated


# ---------------------------------------------------------------------------
# Longest-first enumeration (large DAGs)
# ---------------------------------------------------------------------------

class _PathTracker:
    """Top-K longest paths via min-heap eviction.  Matches JS PathTracker."""

    __slots__ = ('max_paths', 'paths', '_heap', '_counter', 'dropped')

    def __init__(self, max_paths: int):
        self.max_paths = max_paths
        self.paths: Dict[Tuple[int, ...], float] = {}
        # Heap entries: (duration, counter, signature) -- counter for stable
        # ordering when durations tie.
        self._heap: List[Tuple[float, int, Tuple[int, ...]]] = []
        self._counter = 0
        # Count of *real* path drops -- either we evicted an existing
        # tracked completion to make room for a longer one, or we
        # rejected the new completion because the tracker was already
        # full of better candidates.  Duplicate-add skips do NOT count
        # (same path, no information lost).  Read by
        # ``enumerate_longest_paths_first`` to set the truncation
        # signal even when the heap drains.
        self.dropped = 0

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
                    # New candidate rejected -- a real completion path
                    # the search would otherwise have surfaced.
                    self.dropped += 1
                    return False
                heapq.heappop(self._heap)
                self.paths.pop(min_sig, None)
                # Old completion evicted in favour of the new one.
                self.dropped += 1
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
) -> Tuple[List[Tuple[int, ...]], bool]:
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

    Returns ``(paths, truncated)``.  ``truncated`` is True when any of
    the three sampling events fired during the search:

    * **Budget exit.**  The loop exited with the heap non-empty
      because the no-improvement counter (``no_improvement_cap``) or
      the global ``max_expansions`` cap fired.
    * **Tracker eviction or rejection.**  The Top-K tracker dropped a
      real completion path -- either evicting an existing tracked
      path in favour of a longer one, or rejecting the new candidate
      because the tracker was already full of better paths.  Both
      mean a viable end-to-end path was reached but not returned.
    * **Heap trim.**  The blow-up guard (``len(heap) > max_paths * 4``)
      sliced frontier states out of the priority queue.  Dropped
      states could have completed into real paths that the search now
      will never explore.

    A graph whose heap drains organically with no eviction and no
    trim (e.g. a single-branch DAG with one path to the end) reports
    ``truncated=False`` even on the longest-first strategy.
    """
    if state.n == 0 or start_idx < 0 or end_idx < 0:
        return [], False

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
    #
    # Budget: a small constant so the extra post-fill work stays bounded
    # even for large ``max_paths``.  Earlier we used ``max(max_paths * 2,
    # 2000)``, which meant a default ``max_paths=10000`` paid up to 20k
    # extra pops per request.  The flat cap keeps worst-case latency
    # predictable at the cost of occasionally missing a late improvement
    # on very high-fanout graphs -- an acceptable trade since the JS
    # reference breaks immediately on first fill anyway.
    no_improvement_cap = 2000
    expansions_since_improve = 0

    # Three independent truncation events feed the returned signal:
    #   - budget_exit: loop exited with the heap non-empty because the
    #     no-improvement counter or max_expansions cap fired.
    #   - tracker.dropped: a completion path was evicted to make room
    #     for a longer one, OR a completion was rejected because the
    #     tracker was already full of better candidates.
    #   - heap_trim_dropped: the blow-up guard sliced frontier states
    #     out of the heap.  Each dropped state could have produced a
    #     real path that we never expanded.
    # All three indicate the returned corpus is a sample, not exhaustive.
    budget_exit = False
    heap_trim_dropped = 0
    while heap and expansions < max_expansions:
        _pe, _pc, _pl, _ct, path, est, crit = heapq.heappop(heap)
        _branch_dec(path)
        expansions += 1
        if tracker.is_full():
            expansions_since_improve += 1
            if expansions_since_improve >= no_improvement_cap:
                budget_exit = True
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
            before = len(heap)
            heap.sort()
            del heap[max_paths * 2:]
            heapq.heapify(heap)
            heap_trim_dropped += before - len(heap)
            branch_counts.clear()
            for entry in heap:
                _branch_inc(entry[4])

    # If we exited the loop because expansions hit max_expansions while
    # the heap was non-empty, that's also a budget-cap exit.
    if heap and expansions >= max_expansions:
        budget_exit = True

    truncated = (
        budget_exit
        or tracker.dropped > 0
        or heap_trim_dropped > 0
    )

    # Sort results by duration desc; tie-break by path length.
    items = tracker.items()
    items.sort(key=lambda kv: (-kv[1], len(kv[0])))
    return [p for p, _d in items], truncated


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
    return_internal_state: bool = False,
) -> dict:
    """
    Enumerate paths from ``start_id`` to ``end_id``.

    Picks exact DFS for small DAGs and longest-first for large ones,
    matching JS ``findAllPaths``.  Returns paths as lists of node IDs
    (strings) so the API shape stays consumer-friendly.

    Returns a dict with keys:
      ``paths``            : list of paths, each a list of node-ID strings
      ``durations``        : per-path durations (when ``include_durations``)
      ``method``           : 'exact' | 'longest_first' | 'none'
      ``raw_path_count``   : int -- count of paths the chosen strategy
                             produced (post-cap, pre-trim).
      ``corpus_truncated`` : bool -- True only when enumeration
                             actually dropped paths.  For exact DFS:
                             a per-node ``MAX_PATHS_PER_NODE`` cap
                             fired during DFS, or the final
                             ``max_paths`` cut left additional unique
                             paths un-emitted.  For longest-first:
                             the heap exited non-empty due to a
                             budget cap, OR the Top-K tracker
                             evicted/rejected a real completion
                             path, OR the heap-trim guard sliced
                             frontier states.  A graph that drains
                             organically with no drops (e.g. a
                             single-branch DAG) reports ``False``
                             regardless of strategy.  Callers running
                             frequency-style metrics over the result
                             should treat True as sampling-dependent.
      ``start_id``, ``end_id`` : the resolved boundary IDs (as strings).
      ``makespan_hours``   : float, project finish in hours.
      ``_dag_state``, ``_id_to_idx`` : present ONLY when called with
                             ``return_internal_state=True``.  Live
                             ``DAGState`` + index map -- non-serialisable
                             and heavy.  Intended as a private reuse hint
                             for in-process consumers (e.g. a follow-up
                             metric pass that would otherwise rebuild
                             the same DAG); JSON-emitting callers should
                             leave the default ``False``.
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

    # Self-loop endpoint: there is no meaningful s -> e path other than
    # the singleton {s}.  Return an empty result set rather than the
    # degenerate one-node path; callers expect no engine error here.
    if start_idx == end_idx:
        return {
            'paths': [], 'durations': [], 'method': 'none',
            'raw_path_count': 0, 'start_id': s, 'end_id': e,
            'makespan_hours': float(state.makespan),
        }

    is_large = (state.n > node_threshold) or (len(links) > link_threshold)

    if not is_large:
        raw, enum_truncated = enumerate_all_paths_exact(
            state, start_idx, end_idx, max_paths,
        )
        method = 'exact'
    else:
        raw, enum_truncated = enumerate_longest_paths_first(
            state, start_idx, end_idx,
            max_paths=max_paths,
            branch_balanced=branch_balanced,
        )
        method = 'longest_first'

    idx_to_id = {i: nid for nid, i in id_to_idx.items()}
    path_ids: List[List[str]] = [[idx_to_id[i] for i in p] for p in raw]

    if include_durations:
        edge_index = build_succ_edge_index(state) if raw else None
        durations = [path_duration(state, p, edge_index) for p in raw]
    else:
        durations = []

    if durations:
        order = sorted(range(len(raw)), key=lambda i: -durations[i])
        path_ids = [path_ids[i] for i in order]
        durations = [durations[i] for i in order]

    # ``corpus_truncated`` reflects whether enumeration *actually*
    # stopped early.  For exact DFS that means a per-node
    # ``MAX_PATHS_PER_NODE`` cap fired or the final ``max_paths``
    # cut left additional unique paths un-emitted.  For longest-first
    # that means the heap still had candidates when expansions hit the
    # no-improvement / max_expansions budget.  A single-branch DAG
    # whose only path is enumerated and the heap drains organically
    # reports ``truncated=False`` even on the longest-first strategy,
    # and an exact DFS that returns exactly ``max_paths`` when only
    # ``max_paths`` real paths exist also reports ``False``.
    corpus_truncated = bool(enum_truncated)
    out = {
        'paths': path_ids,
        'durations': durations,
        'method': method,
        'raw_path_count': len(raw),
        'corpus_truncated': corpus_truncated,
        'start_id': s,
        'end_id': e,
        'makespan_hours': float(state.makespan),
    }
    # Live DAG state is heavy and non-JSON-serialisable.  Expose it
    # only when the caller explicitly opts in via
    # ``return_internal_state=True`` -- otherwise existing Python
    # callers that forward / cache the whole result wouldn't be
    # surprised by the round-10 perf hint (Copilot review #604).
    if return_internal_state:
        out['_dag_state'] = state
        out['_id_to_idx'] = id_to_idx
    return out
