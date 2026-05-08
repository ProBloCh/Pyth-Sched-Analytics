"""
paths/subpath_patterns.py - Recurring subpath mining across the
critical / near-critical path corpus.

Surfaces contiguous subpaths that appear in many distinct paths and that
are bracketed by *outlier* nodes -- high-betweenness or high-degree DAG
junctions, or high-risk / high-importance activities.  These are
candidates for "key work glues": corridors that a large fraction of
viable schedules must traverse and that carry operational consequence.

Pipeline (single strategy, with a small fallback):

1. Strip envelope nodes from each path: by default each path's *own*
   first and last node are dropped (round-10 change; was previously
   the schedule envelope ID '0' / max-numeric per CLAUDE.md).  The
   per-path strip handles subgraph scopes and pre-computed corpora
   where path boundaries do not match the global envelope, and avoids
   trivial slices anchored on user-selected start/end IDs dominating
   the support counts.  Disable via ``SubpathConfig(strip_envelope=False)``.
2. Compute median + MAD z-scores per node for betweenness, in-degree,
   out-degree, risk, importance, overrun-probability.  MAD-based z is
   robust to the heavy-tailed centrality / risk distributions that
   schedule DAGs typically produce.
3. Tag a node as an *anchor* if any z >= ``anchor_z_threshold``.
4. Anchor-pair search: for each path, extract every contiguous slice
   (v_1..v_L) where v_1 and v_L are anchors and Lmin <= L <= Lmax.
5. Score each candidate by ``supp + junc + sal - maxpen`` (each in [0,1]).
6. Return top-K with per-component breakdown so callers can re-rank.

Fallback fires in two cases:
- Fewer anchors than ``fallback_min_anchors`` exist (default 2 --
  the algorithmic floor, since anchor-pair extraction needs at
  least two anchors on the same path).
- Anchors exist but are split across alternative paths so anchor-pair
  extraction yields zero candidates -- e.g. one anchor on path A,
  another on path B, no overlap.  Total anchor count alone is not
  sufficient to predict whether anchor-pair will produce output.

When the fallback fires, it extracts the longest contiguous slice
per path whose mean salience z exceeds the configured threshold,
keeping the endpoint behaviourally useful instead of returning
nothing.

Network metric ownership: betweenness, PageRank, etc. are owned by C#
``ComputeMetrics.cs`` and projected onto the node payload.  This module
*reads* whatever centrality fields the caller provides; it does not
recompute them.  In/out-degree is computed locally from ``links``
because it's cheap and the C# projection doesn't always include it.
"""

from __future__ import annotations

import logging
import math
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

from solver.dag import build_dag

from ._constants import MAX_NODES
from .enumerate import MAX_PATHS_TO_RETURN, find_all_paths

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class SubpathConfig:
    """Knobs for recurring-subpath mining.

    Defaults are deliberately neutral: no magic-number weights, derived
    bounds where possible.  Calibration weights belong in a follow-up
    once we have outcome labels (see docs/recursive-self-improvement-roadmap.md).
    """
    Lmin: int = 3
    Lmax: Optional[int] = None             # None => derive from median path length
    anchor_z_threshold: float = 2.0
    top_k: int = 10
    include_components: bool = True
    max_anchor_pairs: int = 5_000          # defensive cap on candidates
    # Fallback fires only when fewer than this many anchors exist, since
    # anchor-pair extraction needs at least two anchors on the same path
    # to emit any candidate at all.  Higher values trigger the fallback
    # more eagerly; 2 keeps it as a true safety net.
    fallback_min_anchors: int = 2
    fallback_salience_threshold: float = 1.0
    strip_envelope: bool = True

    def __post_init__(self):
        # Mirror the route layer's _SUBPATH_BOUNDS exactly so direct
        # Python callers and HTTP callers reject the same inputs
        # (Copilot review #604).  Type checks fail fast with ValueError
        # instead of crashing later in arithmetic or comparison with
        # TypeError.  Float fields also reject NaN/Inf since downstream
        # comparisons with NaN are always False and would silently fall
        # back to no anchors.
        for name, val in (
            ('Lmin', self.Lmin), ('top_k', self.top_k),
            ('max_anchor_pairs', self.max_anchor_pairs),
            ('fallback_min_anchors', self.fallback_min_anchors),
        ):
            if not isinstance(val, int) or isinstance(val, bool):
                raise ValueError(
                    f"SubpathConfig.{name} must be int, got {type(val).__name__}"
                )
        if self.Lmax is not None and (
            not isinstance(self.Lmax, int) or isinstance(self.Lmax, bool)
        ):
            raise ValueError(
                f"SubpathConfig.Lmax must be int or None, "
                f"got {type(self.Lmax).__name__}"
            )
        for name, val in (
            ('anchor_z_threshold', self.anchor_z_threshold),
            ('fallback_salience_threshold', self.fallback_salience_threshold),
        ):
            if not isinstance(val, (int, float)) or isinstance(val, bool):
                raise ValueError(
                    f"SubpathConfig.{name} must be a number, "
                    f"got {type(val).__name__}"
                )
            if not math.isfinite(val):
                raise ValueError(
                    f"SubpathConfig.{name} must be finite, got {val}"
                )
        for name, val in (
            ('include_components', self.include_components),
            ('strip_envelope', self.strip_envelope),
        ):
            if not isinstance(val, bool):
                raise ValueError(
                    f"SubpathConfig.{name} must be bool, "
                    f"got {type(val).__name__}"
                )

        # Range checks -- mirror routes._SUBPATH_BOUNDS.
        # Lmin / Lmax upper bound mirrors routes._SUBPATH_BOUNDS
        # (= MAX_NODES) so direct callers can't request unbounded
        # O(n*Lmax) work in-process.  MAX_NODES lives in
        # paths/_constants.py so route + helper stay in sync.
        if self.Lmin < 2 or self.Lmin > MAX_NODES:
            raise ValueError(
                f"SubpathConfig.Lmin ({self.Lmin}) must be in [2, {MAX_NODES}]"
            )
        if self.Lmax is not None:
            if self.Lmax < 2 or self.Lmax > MAX_NODES:
                raise ValueError(
                    f"SubpathConfig.Lmax ({self.Lmax}) must be in "
                    f"[2, {MAX_NODES}]"
                )
            if self.Lmax < self.Lmin:
                raise ValueError(
                    f"SubpathConfig.Lmax ({self.Lmax}) must be >= Lmin "
                    f"({self.Lmin})"
                )
        if self.top_k < 1 or self.top_k > 200:
            raise ValueError(
                f"SubpathConfig.top_k ({self.top_k}) must be in [1, 200]"
            )
        if self.max_anchor_pairs < 1 or self.max_anchor_pairs > 200_000:
            raise ValueError(
                f"SubpathConfig.max_anchor_pairs ({self.max_anchor_pairs}) "
                f"must be in [1, 200000]"
            )
        if self.fallback_min_anchors < 0 or self.fallback_min_anchors > 1_000:
            raise ValueError(
                f"SubpathConfig.fallback_min_anchors "
                f"({self.fallback_min_anchors}) must be in [0, 1000]"
            )
        if not (0.0 <= self.anchor_z_threshold <= 10.0):
            raise ValueError(
                f"SubpathConfig.anchor_z_threshold "
                f"({self.anchor_z_threshold}) must be in [0.0, 10.0]"
            )
        if not (-10.0 <= self.fallback_salience_threshold <= 10.0):
            raise ValueError(
                f"SubpathConfig.fallback_salience_threshold "
                f"({self.fallback_salience_threshold}) must be in [-10.0, 10.0]"
            )


# ---------------------------------------------------------------------------
# Field aliasing (matches monte_carlo.py / recovery.py conventions)
# ---------------------------------------------------------------------------

_RISK_KEYS = ('riskScore', 'ComputedRiskScore', 'RiskScore', 'risk_score')
_IMPORTANCE_KEYS = (
    'ComputedImportanceScore', 'importanceScore', 'ImportanceScore',
    'importance_score', 'importance',
)
_OVERRUN_KEYS = (
    'Overrun_Probability', 'overrunProbability', 'overrun_probability',
)
_BETWEENNESS_KEYS = (
    'Betweenness', 'betweenness', 'betweenness_centrality',
    'BetweennessCentrality',
)


def _first_finite(node: dict, keys: Sequence[str]) -> Optional[float]:
    for k in keys:
        if k not in node:
            continue
        v = node[k]
        if v is None or v == '':
            continue
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if math.isfinite(f):
            return f
    return None


# ---------------------------------------------------------------------------
# Median + MAD z-scores
# ---------------------------------------------------------------------------

def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    if n % 2 == 1:
        return float(s[n // 2])
    return float(s[n // 2 - 1] + s[n // 2]) / 2.0


def _mad_z(values_by_id: Dict[str, float]) -> Dict[str, float]:
    """Median + MAD z-score per node ID, with mean+stdev fallback.

    The 1.4826 scale factor maps MAD to a normal-distribution stdev
    equivalent so thresholds like z=2 keep their usual interpretation.

    MAD has a 50% breakdown point but degenerates to zero when more
    than half of the values are tied at the median (a single outlier
    against four identical values, for instance).  In that case we
    fall back to mean+stdev: still rejects the trivially-uniform case
    (stdev > 0 only when there's real variation) but recovers the
    outlier-anchor signal that MAD silently dropped.  Returns all-zero
    only when the metric is genuinely flat across the corpus.
    """
    if not values_by_id:
        return {}
    vals = list(values_by_id.values())
    med = _median(vals)
    abs_dev = [abs(v - med) for v in vals]
    mad = _median(abs_dev)
    if mad > 0.0:
        scale = 1.4826 * mad
        return {nid: (v - med) / scale for nid, v in values_by_id.items()}

    # MAD degenerate: fall back to mean+stdev.
    n = len(vals)
    mean = sum(vals) / n
    var = sum((v - mean) ** 2 for v in vals) / n
    if var <= 0.0:
        return {nid: 0.0 for nid in values_by_id}
    stdev = math.sqrt(var)
    return {nid: (v - mean) / stdev for nid, v in values_by_id.items()}


def _sigma(z: float) -> float:
    """Bounded positive-z transform: clamp([0, 3]) / 3, in [0, 1]."""
    if z <= 0.0:
        return 0.0
    if z >= 3.0:
        return 1.0
    return z / 3.0


# ---------------------------------------------------------------------------
# Envelope stripping
# ---------------------------------------------------------------------------

def _envelope_ids(
    nodes: Sequence[dict],
    links: Optional[Sequence[dict]] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """Apply the CLAUDE.md schedule-envelope rule with the same
    predecessor-less / successor-less fallback the HTTP route uses
    (paths/routes.py::_default_start_end).  Mirroring it here keeps
    the direct-callable Python helper consistent with the route on
    non-conforming schedules.

    Start = ID '0' if present, else the first predecessor-less node.
    End = ID with the largest finite numeric value if present, else
    the last successor-less node.  Returns ``(start, end)`` as strings,
    or ``None`` for each that can't be inferred.
    """
    ids = [str(n.get('ID', n.get('id', ''))) for n in nodes]
    if not ids:
        return None, None
    start: Optional[str] = '0' if '0' in ids else None
    numeric = []
    for nid in ids:
        try:
            v = float(nid)
        except (TypeError, ValueError):
            continue
        if math.isfinite(v):
            numeric.append((v, nid))
    end: Optional[str] = max(numeric, key=lambda t: t[0])[1] if numeric else None

    # Predecessor-less / successor-less fallback for non-conforming
    # schedules (no '0' anchor, no numeric IDs).
    if (start is None or end is None) and links is not None:
        has_pred: Set[str] = set()
        has_succ: Set[str] = set()
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


def _strip_envelope_from_paths(
    paths: Sequence[Sequence[str]],
    start_id: Optional[str],
    end_id: Optional[str],
) -> List[List[str]]:
    """Drop envelope milestones from each path at fixed positions only.

    The envelope milestones appear at fixed positions in every enumerated
    path (start at index 0, end at index -1).  Removing them prevents
    them from dominating support counts for trivial reasons.

    Strips ONLY positionally -- ``start_id`` is removed iff it equals
    ``path[0]``; ``end_id`` is removed iff it equals ``path[-1]``.
    Interior occurrences of either ID are preserved.  Cyclic-input
    schedules and pre-computed corpora that re-use envelope IDs as
    interior nodes therefore retain their interior structure
    (Copilot review #604, round 16: subpath_patterns.py:343).

    The mining pipeline itself uses an inline ``p[1:-1]`` strip on
    the raw corpus (round-10 change, see ``mine_recurring_subpaths``);
    this helper exists for direct callers that already have the
    canonical envelope IDs to hand and want explicit endpoint
    matching rather than a blind first/last drop.
    """
    out: List[List[str]] = []
    for p in paths:
        sp = [str(x) for x in p]
        # Strip end first so the index-0 strip below doesn't shift
        # the position we'd otherwise check (`-1` would still work,
        # but explicit ordering avoids any future-edit confusion).
        if end_id is not None and sp and sp[-1] == str(end_id):
            sp = sp[:-1]
        if start_id is not None and sp and sp[0] == str(start_id):
            sp = sp[1:]
        out.append(sp)
    return out


# ---------------------------------------------------------------------------
# Per-node metric extraction
# ---------------------------------------------------------------------------

@dataclass
class _NodeMetrics:
    z_betw: Dict[str, float] = field(default_factory=dict)
    z_in_deg: Dict[str, float] = field(default_factory=dict)
    z_out_deg: Dict[str, float] = field(default_factory=dict)
    z_risk: Dict[str, float] = field(default_factory=dict)
    z_imp: Dict[str, float] = field(default_factory=dict)
    z_overrun: Dict[str, float] = field(default_factory=dict)


def _compute_node_metrics(
    nodes: Sequence[dict],
    dag_edges: Set[Tuple[str, str]],
    eligible_ids: Set[str],
) -> _NodeMetrics:
    """Build z-score lookups for the metrics that drive anchoring.

    ``eligible_ids`` excludes envelope milestones so they don't pull
    medians toward zero.

    ``dag_edges`` is the post-cycle-break adjacency.  Walking it
    instead of the raw ``links`` payload keeps in/out-degree z-scores
    consistent with the edges the corpus actually traverses -- on
    cyclic schedules, raw ``links`` would let dropped back-edges still
    push nodes to anchor status (Copilot review #604).
    """
    betw: Dict[str, float] = {}
    risk: Dict[str, float] = {}
    imp: Dict[str, float] = {}
    over: Dict[str, float] = {}
    in_deg: Dict[str, int] = {nid: 0 for nid in eligible_ids}
    out_deg: Dict[str, int] = {nid: 0 for nid in eligible_ids}

    for n in nodes:
        nid = str(n.get('ID', n.get('id', '')))
        if nid not in eligible_ids:
            continue
        b = _first_finite(n, _BETWEENNESS_KEYS)
        if b is not None:
            betw[nid] = b
        r = _first_finite(n, _RISK_KEYS)
        if r is not None:
            risk[nid] = r
        ip = _first_finite(n, _IMPORTANCE_KEYS)
        if ip is not None:
            imp[nid] = ip
        ov = _first_finite(n, _OVERRUN_KEYS)
        if ov is not None:
            over[nid] = ov

    for s, t in dag_edges:
        if s in eligible_ids:
            out_deg[s] = out_deg.get(s, 0) + 1
        if t in eligible_ids:
            in_deg[t] = in_deg.get(t, 0) + 1

    return _NodeMetrics(
        z_betw=_mad_z(betw),
        z_in_deg=_mad_z({k: float(v) for k, v in in_deg.items()}),
        z_out_deg=_mad_z({k: float(v) for k, v in out_deg.items()}),
        z_risk=_mad_z(risk),
        z_imp=_mad_z(imp),
        z_overrun=_mad_z(over),
    )


# ---------------------------------------------------------------------------
# Anchor identification
# ---------------------------------------------------------------------------

def _is_anchor(nid: str, m: _NodeMetrics, threshold: float) -> Tuple[bool, List[str]]:
    """Return ``(is_anchor, reasons)`` -- which metrics flagged the node.

    Only metrics that the node actually has count.  Using ``get(nid, 0.0)``
    would falsely flag nodes-without-the-metric as anchors when
    ``threshold == 0`` (the route allows that value), since 0 >= 0
    (Copilot review #604).
    """
    reasons: List[str] = []
    for label, lookup in (
        ('betweenness', m.z_betw),
        ('in_degree', m.z_in_deg),
        ('out_degree', m.z_out_deg),
        ('risk', m.z_risk),
        ('importance', m.z_imp),
        ('overrun', m.z_overrun),
    ):
        if nid not in lookup:
            continue
        if lookup[nid] >= threshold:
            reasons.append(label)
    return (len(reasons) > 0), reasons


def _identify_anchors(
    eligible_ids: Set[str],
    metrics: _NodeMetrics,
    threshold: float,
) -> Dict[str, List[str]]:
    """Map ``node_id -> reasons`` for every anchor."""
    out: Dict[str, List[str]] = {}
    for nid in eligible_ids:
        ok, reasons = _is_anchor(nid, metrics, threshold)
        if ok:
            out[nid] = reasons
    return out


# ---------------------------------------------------------------------------
# Subpath extraction (anchor-pair primary)
# ---------------------------------------------------------------------------

def _resolve_lmax(stripped_paths: Sequence[Sequence[str]],
                  lmin: int,
                  lmax_override: Optional[int]) -> int:
    """Resolve Lmax.  Override is returned as-is so a malformed Lmax<Lmin
    surfaces as zero candidates rather than a silently-widened search
    space; the route layer enforces Lmax>=Lmin before this is called.
    Derived value (no override) clamps to Lmin so a tiny corpus doesn't
    yield a useless zero."""
    if lmax_override is not None:
        return lmax_override
    lengths = [len(p) for p in stripped_paths if len(p) >= lmin]
    if not lengths:
        return lmin
    median_len = _median([float(x) for x in lengths])
    return max(lmin, int(median_len // 2))


_SAMPLE_PATH_LIMIT = 5
_MAX_ANCHORS_PER_PATH = 64
_PER_PATH_PAIR_BUDGET = 5000  # only downsample when predicted work exceeds this


@dataclass
class _CandidateRecord:
    node_ids: Tuple[str, ...]
    # Path-support is tracked as an int + bounded sample list rather than
    # a full Set[int].  Set[int] for large corpora dominated memory
    # (~80B/int * 10K corpus * 5K candidates ~= GBs); replacing with a
    # plain counter keeps memory linear in candidate count.
    support_count: int = 0
    sample_paths: List[int] = field(default_factory=list)
    # For maxpen: track which neighbours appear immediately before / after
    # this slice in containing paths, and how many paths support each.
    left_neighbour_supp: Dict[str, int] = field(default_factory=dict)
    right_neighbour_supp: Dict[str, int] = field(default_factory=dict)
    # Per-path dedup: ``support_count`` and the neighbour maps must
    # measure path-support, not occurrence-support.  A precomputed
    # path containing the same slice twice (e.g. cyclic input) would
    # otherwise drive maxpen above 1 and double-count support.
    # Paths are processed in order, so a single int is enough -- we
    # only need to know if the current path_idx already touched this
    # candidate.
    _last_path_idx: int = -1

    def record_occurrence(
        self,
        path_idx: int,
        left: Optional[str] = None,
        right: Optional[str] = None,
    ) -> None:
        if path_idx == self._last_path_idx:
            return  # already counted this path
        self._last_path_idx = path_idx
        self.support_count += 1
        if len(self.sample_paths) < _SAMPLE_PATH_LIMIT:
            self.sample_paths.append(path_idx)
        if left is not None:
            self.left_neighbour_supp[left] = (
                self.left_neighbour_supp.get(left, 0) + 1
            )
        if right is not None:
            self.right_neighbour_supp[right] = (
                self.right_neighbour_supp.get(right, 0) + 1
            )


def _extract_anchor_subpaths(
    stripped_paths: Sequence[Sequence[str]],
    anchors: Dict[str, List[str]],
    lmin: int,
    lmax: int,
    max_pairs: int,
) -> Tuple[Dict[Tuple[str, ...], _CandidateRecord], bool]:
    """Anchor-pair contiguous-slice extraction.

    For each path, walk its anchor positions; for every pair (i, j) with
    i < j and j-i+1 in [Lmin..Lmax], emit P[i:j+1] as a candidate.

    Two defensive bounds:
      - per-path anchor cap (_MAX_ANCHORS_PER_PATH): with a permissive
        threshold (e.g. ``anchor_z_threshold=0``) every node becomes an
        anchor and the inner loops would do O(n * Lmax) work per path,
        which scales to seconds on long corpora.  Sampling anchor
        positions evenly above the cap keeps work bounded with minimal
        loss of coverage.
      - global ``max_pairs`` cap: bounds distinct candidate count.
        Newly-encountered subpaths past the cap are dropped while
        support continues to accrue on already-tracked candidates --
        downstream caller sees the ``truncated`` flag in the response
        so the ranking caveat (per Copilot review #604) is visible.

    Returns ``(candidates, truncated)``.
    """
    candidates: Dict[Tuple[str, ...], _CandidateRecord] = {}
    truncated = False
    for path_idx, p in enumerate(stripped_paths):
        anchor_positions = [i for i, nid in enumerate(p) if nid in anchors]
        if len(anchor_positions) < 2:
            continue
        # Per-path defensive downsample, but only when actual predicted
        # work exceeds the budget.  Two upper bounds on the inner-loop
        # pair count:
        #   - per-anchor: at most ``Lmax - Lmin + 1`` pairs before
        #     ``length > lmax`` breaks the inner loop.  But ``Lmax`` can
        #     legitimately exceed the path length, in which case the
        #     real cap is ``len(p) - 1`` (the longest possible slice).
        #     Use ``min(lmax, len(p)) - lmin + 1`` so dense-anchor paths
        #     with permissive Lmax don't get downsampled when the exact
        #     loop would have stayed cheap (Copilot review #604,
        #     subpath_patterns.py:564).
        #   - total: bounded by ``n_anchors * (n_anchors - 1) / 2``
        #     when every pair is in range.  Take the tighter of the
        #     two so we don't overestimate work and downsample
        #     unnecessarily.
        n_anchors = len(anchor_positions)
        per_anchor_cap = max(1, min(lmax, len(p)) - lmin + 1)
        triangle = n_anchors * (n_anchors - 1) // 2
        predicted_pairs = min(n_anchors * per_anchor_cap, triangle)
        if (n_anchors > _MAX_ANCHORS_PER_PATH
                and predicted_pairs > _PER_PATH_PAIR_BUDGET):
            # Even-stride downsampling that *includes both endpoints*.
            # Map k=0..cap-1 to indices 0..len-1 inclusive, otherwise
            # the rightmost anchor is systematically dropped and we
            # miss every candidate ending at the path's last anchor.
            cap = _MAX_ANCHORS_PER_PATH
            anchor_positions = [
                anchor_positions[round(k * (n_anchors - 1) / (cap - 1))]
                for k in range(cap)
            ]
            truncated = True
        for ai in range(len(anchor_positions)):
            i = anchor_positions[ai]
            for aj in range(ai + 1, len(anchor_positions)):
                j = anchor_positions[aj]
                length = j - i + 1
                if length < lmin:
                    continue
                if length > lmax:
                    break
                key = tuple(p[i:j + 1])
                rec = candidates.get(key)
                if rec is None:
                    if len(candidates) >= max_pairs:
                        truncated = True
                        continue
                    rec = _CandidateRecord(node_ids=key)
                    candidates[key] = rec
                left = p[i - 1] if i > 0 else None
                right = p[j + 1] if j < len(p) - 1 else None
                rec.record_occurrence(path_idx, left=left, right=right)
    if truncated:
        logger.info(
            "Subpath extraction truncated (max_pairs=%d, "
            "max_anchors_per_path=%d).",
            max_pairs, _MAX_ANCHORS_PER_PATH,
        )
    return candidates, truncated


# ---------------------------------------------------------------------------
# Fallback extraction (no anchors / too few)
# ---------------------------------------------------------------------------

_FALLBACK_LMAX_CAP = 100  # bounds fallback iteration on large schedules


def _extract_fallback_subpaths(
    stripped_paths: Sequence[Sequence[str]],
    metrics: _NodeMetrics,
    salience_threshold: float,
    lmin: int,
    lmax: int,
) -> Tuple[Dict[Tuple[str, ...], _CandidateRecord], int]:
    """One subpath per path: longest contiguous slice with mean salience z > threshold.

    Uses prefix-sum window means so per-path cost is O(n * Lmax_eff)
    rather than O(n * Lmax^2).  ``Lmax_eff = min(lmax, _FALLBACK_LMAX_CAP)``
    -- the user's Lmax can legitimately reach MAX_NODES for the
    anchor-pair extraction, but the fallback's window scan would
    otherwise tie up a worker on a 20K-node request with few anchors
    (~200M window checks).  The fallback already exists as a "no
    anchor signal" last resort; a generous-but-bounded cap there
    doesn't constrain typical use.

    Returns ``(candidates, effective_lmax)`` so the caller can surface
    the clamp in ``config_resolved`` and ``truncated`` -- previously
    the response reported the caller's original Lmax even when the
    fallback's window scan only considered a fraction of it
    (Copilot review #604).

    ``effective_lmax`` is the lesser of ``lmax`` and the cap, but is
    further raised back to ``lmin`` when the cap would otherwise
    invert the loop (round 16: requests with ``Lmin`` > 100 used to
    silently return zero candidates and report ``Lmax < Lmin`` in
    ``config_resolved``).  Honouring the floor at ``lmin`` keeps the
    advertised ``[2, MAX_NODES]`` range valid for the fallback path.
    """
    effective_lmax = min(lmax, _FALLBACK_LMAX_CAP)
    if effective_lmax < lmin:
        effective_lmax = lmin
    candidates: Dict[Tuple[str, ...], _CandidateRecord] = {}
    for path_idx, p in enumerate(stripped_paths):
        if len(p) < lmin:
            continue
        n = len(p)
        # prefix[k] = sum of salience z for p[:k]
        prefix = [0.0] * (n + 1)
        for k, nid in enumerate(p):
            prefix[k + 1] = prefix[k] + _node_salience_z(nid, metrics)
        best_slice: Optional[Tuple[int, int, float]] = None
        for length in range(min(effective_lmax, n), lmin - 1, -1):
            for start in range(0, n - length + 1):
                window_sum = prefix[start + length] - prefix[start]
                mean_sal = window_sum / length
                if mean_sal < salience_threshold:
                    continue
                if best_slice is None or mean_sal > best_slice[2]:
                    best_slice = (start, start + length, mean_sal)
            if best_slice is not None:
                break  # longest length found that satisfies threshold
        if best_slice is None:
            continue
        s, e, _ = best_slice
        key = tuple(p[s:e])
        rec = candidates.setdefault(key, _CandidateRecord(node_ids=key))
        left = p[s - 1] if s > 0 else None
        right = p[e] if e < len(p) else None
        rec.record_occurrence(path_idx, left=left, right=right)
    return candidates, effective_lmax


def _node_salience_z(nid: str, m: _NodeMetrics) -> float:
    return (
        m.z_risk.get(nid, 0.0)
        + m.z_imp.get(nid, 0.0)
        + m.z_overrun.get(nid, 0.0)
    ) / 3.0


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def _score_components(
    rec: _CandidateRecord,
    metrics: _NodeMetrics,
    corpus_size: int,
) -> Dict[str, float]:
    """Compute the four scoring components for a candidate.

    Each is in [0, 1]:
      supp   : path-support fraction
      junc   : endpoint structural strength (asymmetric: in-deg @ v1, out-deg @ vL)
      sal    : ``mean(sigma(z))`` -- per-node salience z is clamped to
               [0, 1] via _sigma *first*, then averaged.  This is
               deliberately not ``sigma(mean(z))``: averaging-then-clamping
               lets a single negative-z node pull the mean down before the
               clamp, which would penalise corridors that contain one
               neutral or negative node alongside several outliers.
               Clamping per-node bounds each contribution individually
               so a single extreme outlier doesn't dominate either.
      maxpen : fraction of *containing paths* where the most-common
               single-neighbour extension fires -- penalises trivially
               non-maximal cuts.  A subpath always extended the same
               way scores maxpen=1.0 regardless of support level.
    """
    nids = rec.node_ids
    v1, vL = nids[0], nids[-1]
    supp = (rec.support_count / corpus_size) if corpus_size > 0 else 0.0

    junc_in = max(metrics.z_betw.get(v1, 0.0), metrics.z_in_deg.get(v1, 0.0))
    junc_out = max(metrics.z_betw.get(vL, 0.0), metrics.z_out_deg.get(vL, 0.0))
    junc = 0.5 * _sigma(junc_in) + 0.5 * _sigma(junc_out)

    sal = sum(_sigma(_node_salience_z(n, metrics)) for n in nids) / len(nids)

    # Maximality: a candidate is "trivially non-maximal" when the same
    # extension neighbour appears in many of its *containing paths* --
    # the longer subpath captures the same evidence.  Divide by
    # support_count (containing paths), NOT corpus_size, so the
    # penalty measures domination *within the candidate's own support
    # set* per the PR contract.  Corpus-relative would let a fully
    # dominated low-support candidate (3 paths, all extended by X)
    # escape with maxpen=3/N when it should be 1.0 (Copilot review
    # #604).  Extension support is always <= base support (extension
    # is more constrained), so this fraction is always in [0, 1].
    best_left = max(rec.left_neighbour_supp.values(), default=0)
    best_right = max(rec.right_neighbour_supp.values(), default=0)
    best_ext = max(best_left, best_right)
    maxpen = (best_ext / rec.support_count) if rec.support_count > 0 else 0.0

    return {'supp': supp, 'junc': junc, 'sal': sal, 'maxpen': maxpen}


def _aggregate(components: Dict[str, float]) -> float:
    """Equal-weight aggregate.  See module docstring re: calibration."""
    return (
        components['supp']
        + components['junc']
        + components['sal']
        - components['maxpen']
    )


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------

def mine_recurring_subpaths(
    nodes: Sequence[dict],
    links: Sequence[dict],
    paths: Optional[Sequence[Sequence[str]]] = None,
    config: Optional[SubpathConfig] = None,
    enumerate_kwargs: Optional[dict] = None,
    dag_state=None,
    id_to_idx: Optional[Dict[str, int]] = None,
) -> dict:
    """Mine recurring subpaths over the critical / near-critical corpus.

    Parameters
    ----------
    nodes, links : the schedule.  Node fields used for anchoring:
        Betweenness, RiskScore, ImportanceScore, Overrun_Probability
        (and their snake_case / camelCase aliases).  In/out degree is
        derived from the post-cycle-break DAG.
    paths : optional precomputed corpus.  When omitted, this calls
        ``find_all_paths`` to enumerate the project envelope.
    config : :class:`SubpathConfig` overrides.
    enumerate_kwargs : passed through to ``find_all_paths`` (e.g.
        ``start_id``, ``end_id``, ``max_paths``, ``branch_balanced``).
    dag_state, id_to_idx : optional pre-built DAG (output of
        ``solver.dag.build_dag``).  When the caller has already paid
        the build cost (the Flask route does so to validate
        precomputed paths), passing it here avoids a second
        ``build_dag`` call.  When omitted, the helper builds it on
        demand.

    Returns
    -------
    dict with the following keys (always present):
      - ``subpaths``: ranked list of candidates (top_k of them)
      - ``corpus_size``: int
      - ``anchor_count``: int
      - ``fallback_used``: bool -- the salience-window fallback fired
        because anchor-pair extraction yielded nothing
      - ``truncated``: bool -- the result is approximate.  Set when
        any of the following fire:
          * mining-side ``max_anchor_pairs`` cap hit (new candidates
            silently dropped past the cap)
          * per-path anchor downsample fired (>``_MAX_ANCHORS_PER_PATH``
            anchors stride-sampled)
          * fallback clamped Lmax to ``_FALLBACK_LMAX_CAP``
          * find_all_paths reported ``corpus_truncated`` (longest-first
            heuristic on large DAGs OR exact DFS hit ``max_paths``)
        Callers who need to know whether support counts are over an
        exhaustive corpus must treat truncated=True as
        sampling-dependent.
      - ``config_resolved``: dict snapshot of the effective config
        (Lmax surfaced as the resolved int, never None)
    Each subpath entry has ``node_ids``, ``score``, ``support_count``,
    ``components`` (when enabled), ``endpoint_anchors``,
    ``sample_paths``.
    """
    cfg = config or SubpathConfig()
    # SubpathConfig.__post_init__ now validates Lmin/Lmax/top_k bounds,
    # so we don't repeat the checks here.

    # Pre-resolve the config snapshot we'll surface in every return path.
    # The empty-corpus and error fast paths still need to surface Lmax as
    # an int so the response shape stays stable -- previously they leaked
    # ``Lmax: null`` whenever the caller omitted it (Copilot review #604).
    resolved_cfg_base = asdict(cfg)
    if resolved_cfg_base.get('Lmax') is None:
        resolved_cfg_base['Lmax'] = cfg.Lmin

    def _empty_response(error: Optional[str] = None) -> dict:
        out = {
            'subpaths': [], 'corpus_size': 0, 'anchor_count': 0,
            'fallback_used': False, 'truncated': False,
            'config_resolved': dict(resolved_cfg_base),
        }
        if error is not None:
            out['error'] = error
        return out

    # Track whether the enumeration step itself truncated the corpus
    # (find_all_paths' longest-first heuristic on large DAGs stops at
    # max_paths).  This is independent of the mining-side max_anchor_pairs
    # / per-path-anchor caps; surfacing it lets clients distinguish
    # exact mining over a sampled corpus from approximate mining over
    # the full corpus (Copilot review #604).
    enumeration_truncated = False

    # 1. Acquire path corpus.  Diversity selectors would prune the corpus
    # before mining and bias support counts, so we always start from raw
    # enumeration.  Two enumerator settings matter for support validity:
    #   - branch_balanced: defaults False here (and at the route layer),
    #     since BranchBalancedQueue down-ranks overrepresented branches
    #     and would make support counts sampling-dependent.  We honor
    #     the caller's explicit choice -- they can opt back into
    #     balancing by passing branch_balanced=True.
    #   - include_durations=False: we never use per-path durations, so
    #     skipping the FS/SS/FF/SF computation + sort saves work
    #     proportional to the corpus on every cold call.
    # Direct Python callers may not supply start/end -- fall back to the
    # CLAUDE.md schedule-envelope convention so the documented
    # ``mine_recurring_subpaths(nodes, links)`` happy path works without
    # requiring callers to thread envelope IDs through enumerate_kwargs.
    if paths is None:
        kw = dict(enumerate_kwargs or {})
        start_id = kw.get('start_id')
        end_id = kw.get('end_id')
        # Treat both None and '' as "missing" so request-shaped kwargs
        # passed in-process behave the same as the route's
        # _resolve_start_end (Copilot review #604).
        def _is_missing(v):
            return v is None or v == '' or v == b''
        if _is_missing(start_id) or _is_missing(end_id):
            env_start, env_end = _envelope_ids(nodes, links)
            if _is_missing(start_id):
                start_id = env_start
            if _is_missing(end_id):
                end_id = env_end
        # Coerce request-shaped scalar kwargs.  The route layer already
        # coerces these via _coerce_int / _coerce_bool before invoking
        # the helper, but direct callers reusing JSON-shaped kwargs
        # in-process would otherwise forward raw strings to
        # find_all_paths -- ``'1000'`` trips the numeric comparisons,
        # ``'false'`` is truthy and silently enables branch balancing
        # (Copilot review #604).
        def _coerce_int_kw(v, default, name):
            if v is None:
                return default
            if isinstance(v, bool):
                raise ValueError(
                    f"enumerate_kwargs.{name} must be int, got bool"
                )
            if isinstance(v, int):
                return v
            if isinstance(v, str):
                try:
                    return int(v)
                except ValueError:
                    raise ValueError(
                        f"enumerate_kwargs.{name} ({v!r}) must be an integer"
                    )
            raise ValueError(
                f"enumerate_kwargs.{name} must be int, "
                f"got {type(v).__name__}"
            )

        def _coerce_bool_kw(v, default, name):
            if v is None:
                return default
            if isinstance(v, bool):
                return v
            if isinstance(v, str):
                low = v.strip().lower()
                if low in ('true', '1', 'yes', 'on'):
                    return True
                if low in ('false', '0', 'no', 'off'):
                    return False
            raise ValueError(
                f"enumerate_kwargs.{name} must be bool, "
                f"got {type(v).__name__}"
            )

        max_paths = _coerce_int_kw(kw.get('max_paths'), MAX_PATHS_TO_RETURN, 'max_paths')
        # Mirror the route's 1..MAX_PATHS_TO_RETURN bounds so direct
        # callers can't request enumeration of 0 / negative / billions
        # of paths and bypass the endpoint's safety cap (Copilot
        # review #604).
        if max_paths < 1 or max_paths > MAX_PATHS_TO_RETURN:
            raise ValueError(
                f"enumerate_kwargs.max_paths ({max_paths}) must be in "
                f"[1, {MAX_PATHS_TO_RETURN}]"
            )
        branch_balanced = _coerce_bool_kw(
            kw.get('branch_balanced'), False, 'branch_balanced')
        result = find_all_paths(
            nodes, links,
            start_id=start_id,
            end_id=end_id,
            max_paths=max_paths,
            branch_balanced=branch_balanced,
            include_durations=False,
            # Reuse the DAG that find_all_paths already built (private
            # hint via ``_dag_state``/``_id_to_idx``).  Avoids a second
            # build_dag call for degree counting on the default
            # frontend flow where ``paths`` is omitted.  Opt-in so
            # other callers' return shape stays JSON-serialisable.
            return_internal_state=True,
        )
        if result.get('error'):
            return _empty_response(error=result['error'])
        raw_paths: List[List[str]] = [list(p) for p in result.get('paths', [])]
        # Reuse the DAG that find_all_paths already built (private
        # hint via ``_dag_state``/``_id_to_idx``).  Avoids a second
        # build_dag call for degree counting on the default frontend
        # flow where ``paths`` is omitted -- noticeable on the 20K
        # node schedules this endpoint targets (Copilot review #604).
        if dag_state is None and id_to_idx is None:
            dag_state = result.get('_dag_state')
            id_to_idx = result.get('_id_to_idx')
        # find_all_paths now reports ``corpus_truncated`` directly
        # (True for longest-first heuristic OR exact DFS that hit
        # max_paths).  Round 10 used method=='longest_first' which
        # missed exact-DFS-capped corpora; round 11 used
        # raw_path_count>=max_paths which falsely flagged exhaustive
        # corpora that just happened to land at the cap.  The
        # canonical signal lives in find_all_paths itself now
        # (Copilot review #604, subpath_patterns:945).
        if result.get('corpus_truncated'):
            enumeration_truncated = True
    else:
        # Path shape validation: must run regardless of whether the
        # caller supplied ``dag_state``.  A cached DAG is only a build
        # cost optimisation -- it doesn't certify the corpus shape, so
        # gating these checks on ``dag_state is None`` would let
        # malformed inputs like ``paths=['AB']`` (string -> chars) or
        # ``paths=[['A']]`` (single-node) slip through into the str()
        # normalisation and silently mine nonsense (Copilot review
        # #604, subpath_patterns.py:941).
        # Accept any non-string Sequence (list, tuple, ...) per the
        # public ``Sequence[Sequence[str]]`` annotation -- requiring
        # exactly ``list`` would reject tuple-form callers that
        # satisfy the annotated contract (Copilot review #604:967).
        from collections.abc import Sequence as _Seq
        for i, p in enumerate(paths):
            if isinstance(p, str) or isinstance(p, (bytes, bytearray)):
                raise ValueError(
                    f"paths[{i}] must be a sequence of node IDs, "
                    f"got {type(p).__name__}"
                )
            if not isinstance(p, _Seq):
                raise ValueError(
                    f"paths[{i}] must be a sequence of node IDs, "
                    f"got {type(p).__name__}"
                )
            if len(p) < 2:
                raise ValueError(
                    f"paths[{i}] must contain at least 2 node IDs"
                )
        # Normalise precomputed path IDs to strings on ingest so direct
        # Python callers passing integer IDs get the same behaviour as
        # HTTP callers (the route normalises in its cache key).
        raw_paths = [[str(x) for x in p] for p in paths]

    if not raw_paths:
        return _empty_response()

    # 2. Strip the corpus boundaries (the start/end nodes of each
    # path) -- per-path so a precomputed corpus with mixed boundaries
    # doesn't silently strip wrong nodes from non-canonical paths
    # (Copilot review #604, subpath_patterns.py:964).  For canonical
    # enumerated corpora every path shares a start/end pair, so
    # per-path stripping is identical to global stripping there.
    if cfg.strip_envelope:
        stripped = []
        for p in raw_paths:
            if len(p) >= 2:
                # Drop p[0] and p[-1].  The mining pipeline requires
                # Lmin>=2 anyway, so a path of length 1 contributes
                # nothing and a path of length 2 strips to empty.
                stripped.append(p[1:-1])
            else:
                stripped.append(list(p))
    else:
        stripped = [list(p) for p in raw_paths]

    # Eligible IDs = everything in the stripped corpus.  Restricting to
    # corpus members keeps medians representative of the activities that
    # actually appear in critical / near-critical paths.
    eligible_ids: Set[str] = set()
    for p in stripped:
        eligible_ids.update(p)

    # 3. Compute z-scores and identify anchors.  Use the post-cycle-break
    # DAG adjacency for in/out-degree counting so cycle-broken back-edges
    # don't inflate anchor scores for nodes whose corpus traversals never
    # use those edges.  Reuse a caller-supplied DAG when available
    # (the Flask route already builds one to validate precomputed paths
    # -- threading it through here avoids paying that cost twice).
    locally_built_dag = dag_state is None or id_to_idx is None
    dag_build_ok = True
    try:
        if locally_built_dag:
            dag_state, id_to_idx = build_dag(nodes, links, default_duration=0.0)
        idx_to_id = {idx: nid for nid, idx in id_to_idx.items()}
        dag_edges: Set[Tuple[str, str]] = {
            (idx_to_id[u], idx_to_id[int(v)])
            for u in range(dag_state.n) for v in dag_state.succ[u]
        }
    except Exception:
        # Only fall back to raw-link adjacency when WE built the DAG
        # ourselves (locally_built_dag) -- a build_dag failure on
        # nodes/links that already passed the route's structural
        # validation is a recoverable degenerate-input case.  If the
        # caller supplied ``dag_state`` / ``id_to_idx`` and *that*
        # raised (e.g. stale or malformed snapshot from a direct
        # caller), the right response is to propagate so the caller
        # sees their bad input -- otherwise we'd silently mine over
        # raw-link adjacency that may not match the corpus's actual
        # DAG, AND skip the path-validation block below because
        # ``dag_build_ok`` becomes False (Copilot review #604).
        if not locally_built_dag:
            raise
        logger.exception("build_dag failed in mine_recurring_subpaths; "
                         "falling back to raw links for degree counting")
        dag_build_ok = False
        dag_edges = {
            (str(ln.get('source', '')), str(ln.get('target', '')))
            for ln in links
        }
    metrics = _compute_node_metrics(nodes, dag_edges, eligible_ids)
    anchors = _identify_anchors(eligible_ids, metrics, cfg.anchor_z_threshold)

    # Per-hop validation against the DAG.  Runs whenever the caller
    # supplied a precomputed corpus, regardless of whether
    # ``dag_state`` was also supplied -- the optimisation hook is a
    # performance shortcut for the *DAG build* only, not a promise
    # that the corpus was already validated upstream (Copilot review
    # #604: passing dag_state could otherwise let direct callers
    # accidentally mine impossible paths via the route's optimisation
    # hook).  Skipped only when DAG construction itself failed.
    # Known-ID check runs even when ``dag_edges`` is empty (a schedule
    # with no links still has well-defined node IDs); only the per-hop
    # check requires non-empty adjacency.
    if paths is not None and dag_build_ok:
        known = {idx_to_id[u] for u in range(dag_state.n)}
        for i, p in enumerate(raw_paths):
            for nid in p:
                if nid not in known:
                    raise ValueError(
                        f"paths[{i}] references unknown node ID: {nid!r}"
                    )
            for j in range(len(p) - 1):
                hop = (p[j], p[j + 1])
                if hop not in dag_edges:
                    raise ValueError(
                        f"paths[{i}] hop {hop[0]}->{hop[1]} is not a "
                        f"valid DAG edge (cycle-broken back-edges are "
                        f"not enumerable)"
                    )

    # 4. Resolve Lmax.
    lmax = _resolve_lmax(stripped, cfg.Lmin, cfg.Lmax)

    # 5. Extract candidates.  Try anchor-pair first; fall back when
    # either too few anchors exist OR the anchors are split across
    # different paths so anchor-pair extraction yields no candidates.
    candidates: Dict[Tuple[str, ...], _CandidateRecord] = {}
    truncated = False
    if len(anchors) >= cfg.fallback_min_anchors:
        candidates, truncated = _extract_anchor_subpaths(
            stripped, anchors,
            lmin=cfg.Lmin, lmax=lmax, max_pairs=cfg.max_anchor_pairs,
        )

    fallback_used = not candidates
    effective_lmax = lmax  # surfaced via config_resolved below
    if fallback_used:
        candidates, fallback_lmax = _extract_fallback_subpaths(
            stripped, metrics,
            salience_threshold=cfg.fallback_salience_threshold,
            lmin=cfg.Lmin, lmax=lmax,
        )
        if fallback_lmax < lmax:
            # Fallback clamped Lmax internally; reflect that in
            # config_resolved and surface via truncated so clients
            # know the effective search width.
            effective_lmax = fallback_lmax
            truncated = True

    # 6. Score and rank.
    corpus_size = len(stripped)
    scored: List[Tuple[float, _CandidateRecord, Dict[str, float]]] = []
    for rec in candidates.values():
        components = _score_components(rec, metrics, corpus_size)
        scored.append((_aggregate(components), rec, components))
    # Highest score first; tie-break by support then by length descending
    # so longer corridors win when scores tie exactly.
    scored.sort(
        key=lambda triple: (
            -triple[0],
            -triple[1].support_count,
            -len(triple[1].node_ids),
        ),
    )

    top_k = max(1, cfg.top_k)
    out_subpaths = []
    for score, rec, components in scored[:top_k]:
        v1, vL = rec.node_ids[0], rec.node_ids[-1]
        endpoint_anchors = {
            'v1': anchors.get(v1, []),
            'vL': anchors.get(vL, []),
        }
        entry: dict = {
            'node_ids': list(rec.node_ids),
            'score': score,
            'support_count': rec.support_count,
            'corpus_size': corpus_size,
            'endpoint_anchors': endpoint_anchors,
            'sample_paths': sorted(rec.sample_paths),
        }
        if cfg.include_components:
            entry['components'] = components
        out_subpaths.append(entry)

    resolved_cfg = asdict(cfg)
    # Surface the effective Lmax that the extraction actually used.
    # Anchor-pair extraction uses the full ``lmax``; the fallback may
    # have clamped it to ``_FALLBACK_LMAX_CAP``.
    resolved_cfg['Lmax'] = effective_lmax

    return {
        'subpaths': out_subpaths,
        'corpus_size': corpus_size,
        'anchor_count': len(anchors),
        'fallback_used': fallback_used,
        'truncated': truncated or enumeration_truncated,
        'config_resolved': resolved_cfg,
    }
