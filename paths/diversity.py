"""
paths/diversity.py - Structurally-independent near-critical path selection.

Suppressing thousands of micro-variants around the same backbone is
essential for a useful UI.  PathScripts.js (lines 5300-5773) handles this
with three layered techniques; this module ports them verbatim:

1. **Signatures** -- branch (first K nodes), midpoint (K nodes around
   the middle), full, and deviation-relative-to-reference.
2. **Family collapse** -- group by ``(branchSig, devSig)``, keep the
   longest representative per family.  Kills O(10^3) near-identical
   variants of the same backbone.
3. **Independence filter** -- containment overlap on edge sets
   (|A∩B| / min(|A|,|B|)) plus a minimum-unique-edges threshold
   against every already-selected path.

Auto-tune (`auto_tune_config`) adapts the overlap threshold and
minimum-unique-edges to the path length distribution, matching the JS
``_autoTuneStructuralDiversity`` heuristic.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Sequence, Set, Tuple


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class DiversityConfig:
    """Mirrors JS STRUCTURAL_DIVERSITY_CONFIG (line 673)."""
    max_paths: int = 200
    enable_auto_tune: bool = True
    branch_depth: int = 4
    midpoint_depth: int = 3
    min_paths_per_branch: int = 3
    max_paths_per_branch: int = 30
    enable_independence_filter: bool = True
    overlap_threshold: float = 0.92
    min_unique_edges: int = 5
    family_collapse: bool = True
    max_per_family: int = 1
    candidate_multiplier: int = 20
    candidate_cap: int = 20_000


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# Signatures
# ---------------------------------------------------------------------------

def branch_signature(path: Sequence[str], depth: int) -> str:
    if not path:
        return ''
    d = min(depth, len(path))
    return '->'.join(str(x) for x in path[:d])


def midpoint_signature(path: Sequence[str], depth: int) -> str:
    if len(path) < 5:
        return 'short'
    mid = len(path) // 2
    start = max(0, mid - depth // 2)
    end = min(len(path), start + depth)
    return '->'.join(str(x) for x in path[start:end])


def full_signature(path: Sequence[str]) -> str:
    return '->'.join(str(x) for x in path)


def deviation_signature(path: Sequence[str], ref_path: Sequence[str],
                        ref_pos: Dict[str, int], max_scan: int = 500) -> str:
    """Where ``path`` first diverges from ``ref_path``, and the first rejoin.

    Returns ``'ON_REF'`` if no divergence is seen in the first
    ``max_scan`` nodes (in which case caller should fall back to
    midpoint / full for dedup).
    """
    if len(path) < 2 or len(ref_path) < 2:
        return 'UNSPEC'

    scan_limit = min(len(path) - 1, max_scan)
    for j in range(scan_limit):
        nid = str(path[j])
        ref_idx = ref_pos.get(nid)
        if ref_idx is None or ref_idx >= len(ref_path) - 1:
            continue
        ref_next_id = str(ref_path[ref_idx + 1])
        next_id = str(path[j + 1])
        if next_id == ref_next_id:
            continue

        # Divergence found -- hunt for earliest rejoin.
        rejoin: Optional[Tuple[int, str]] = None
        for k in range(j + 1, len(path)):
            rn_id = str(path[k])
            rn = ref_pos.get(rn_id)
            if rn is not None and rn > ref_idx:
                rejoin = (rn, rn_id)
                break

        rejoin_part = f'RJ@{rejoin[0]}:{rejoin[1]}' if rejoin else 'RJ@none'
        return f'DV@{ref_idx}:{nid}->{next_id}|{rejoin_part}'

    return 'ON_REF'


def _ref_position_map(ref_path: Sequence[str]) -> Dict[str, int]:
    return {str(nid): i for i, nid in enumerate(ref_path)}


# ---------------------------------------------------------------------------
# Edge sets + overlap
# ---------------------------------------------------------------------------

def edge_set(path: Sequence[str]) -> Set[str]:
    if len(path) < 2:
        return set()
    return {f'{path[i]}->{path[i + 1]}' for i in range(len(path) - 1)}


def containment_overlap(a: Set[str], b: Set[str]) -> float:
    """|A∩B| / min(|A|,|B|)  -- kinder to unequal sizes than Jaccard."""
    if not a or not b:
        return 0.0
    small, big = (a, b) if len(a) <= len(b) else (b, a)
    inter = sum(1 for e in small if e in big)
    return inter / min(len(a), len(b))


def unique_edge_count(candidate: Set[str],
                      selected_edges: Sequence[Set[str]]) -> int:
    """Edges in ``candidate`` that don't appear in the MOST-overlapping selected path."""
    if not candidate:
        return 0
    max_inter = 0
    for se in selected_edges:
        small, big = (candidate, se) if len(candidate) <= len(se) else (se, candidate)
        inter = sum(1 for e in small if e in big)
        if inter > max_inter:
            max_inter = inter
    return len(candidate) - max_inter


# ---------------------------------------------------------------------------
# Auto-tune
# ---------------------------------------------------------------------------

def auto_tune_config(base: DiversityConfig, paths: Sequence[Sequence[str]],
                     node_count: int = 0,
                     link_count: int = 0) -> DiversityConfig:
    """Adjust overlap / min-unique-edges / branch-depth based on schedule shape.

    Mirrors JS ``_autoTuneStructuralDiversity`` (line 869) with the
    pragmatic slice: we use path-length distribution + schedule size to
    pick knobs, then hand back a tuned copy of the config.  The full JS
    auto-tune also scans prefix uniqueness to pick branch_depth; we use
    a cheaper approximation (depth 4 default unless paths are very long).
    """
    if not base.enable_auto_tune or not paths:
        return base

    tuned = DiversityConfig(**asdict(base))

    lengths = sorted(len(p) - 1 for p in paths if len(p) > 1)
    if not lengths:
        return tuned

    def pct(q: float) -> int:
        idx = min(len(lengths) - 1, max(0, int(q * (len(lengths) - 1))))
        return lengths[idx]

    median_edges = pct(0.5)
    p90_edges = pct(0.9)

    # max_paths: scale with schedule size.
    if node_count:
        if node_count < 600:
            mp = 80
        elif node_count < 1500:
            mp = 120
        elif node_count < 4000:
            mp = 180
        elif node_count < 12000:
            mp = 220
        else:
            mp = 260
    else:
        mp = 120 if p90_edges <= 120 else (180 if p90_edges <= 300 else 220)

    if node_count and link_count:
        density = link_count / max(1, node_count)
        if density > 3.5:
            mp = min(320, mp + 40)
        elif density > 2.5:
            mp = min(300, mp + 20)
    tuned.max_paths = _clamp(mp, 40, 400)

    # overlap_threshold + min_unique_edges driven by typical path length.
    L = max(median_edges, 0)
    if L < 60:
        mu = 4
    elif L < 120:
        mu = 5
    elif L < 250:
        mu = 8
    elif L < 500:
        mu = 12
    else:
        mu = 15
    tuned.min_unique_edges = mu

    if L < 80:
        ov = 0.90
    elif L < 200:
        ov = 0.92
    elif L < 450:
        ov = 0.94
    else:
        ov = 0.95
    tuned.overlap_threshold = ov

    # Candidate cap: tighten on very large schedules to cap work.
    if node_count > 12000 or link_count > 35000:
        tuned.candidate_cap = 12_000
    elif node_count > 8000:
        tuned.candidate_cap = 15_000

    # Midpoint depth: short paths don't have room for a 3-wide midpoint.
    if L < 80:
        tuned.midpoint_depth = 2

    # Bounds-safety clamps.
    tuned.max_paths = _clamp(tuned.max_paths, 1, 1000)
    tuned.branch_depth = _clamp(tuned.branch_depth, 2, 30)
    tuned.midpoint_depth = _clamp(tuned.midpoint_depth, 1, 8)
    tuned.min_paths_per_branch = _clamp(tuned.min_paths_per_branch, 1, 20)
    tuned.max_paths_per_branch = _clamp(tuned.max_paths_per_branch,
                                        tuned.min_paths_per_branch, 200)
    tuned.candidate_multiplier = _clamp(tuned.candidate_multiplier, 3, 50)
    tuned.candidate_cap = _clamp(tuned.candidate_cap, tuned.max_paths, 50_000)
    tuned.overlap_threshold = _clamp(tuned.overlap_threshold, 0.70, 0.99)
    tuned.min_unique_edges = _clamp(tuned.min_unique_edges, 0, 200)
    return tuned


# ---------------------------------------------------------------------------
# Selectors
# ---------------------------------------------------------------------------

@dataclass
class DiversitySelection:
    paths: List[List[str]]
    durations: List[float]
    info: Dict = field(default_factory=dict)


def select_structurally_diverse(
    paths: Sequence[Sequence[str]],
    durations: Sequence[float],
    config: Optional[DiversityConfig] = None,
) -> DiversitySelection:
    """Simpler branch+midpoint-quota selection.

    Mirrors JS ``extractStructurallyDiversePaths`` (line 5662).
    """
    cfg = config or DiversityConfig()
    if not paths:
        return DiversitySelection([], [], {'total_branches': 0})

    structures = []
    for i, p in enumerate(paths):
        structures.append({
            'index': i,
            'duration': float(durations[i]) if i < len(durations) else 0.0,
            'branch_sig': branch_signature(p, cfg.branch_depth),
            'mid_sig': midpoint_signature(p, cfg.midpoint_depth),
            'full_sig': full_signature(p),
        })

    branch_groups: Dict[str, List[dict]] = {}
    for s in structures:
        branch_groups.setdefault(s['branch_sig'], []).append(s)
    for arr in branch_groups.values():
        arr.sort(key=lambda s: -s['duration'])

    total_branches = max(len(branch_groups), 1)
    min_per_branch = cfg.min_paths_per_branch
    if total_branches * min_per_branch > cfg.max_paths:
        min_per_branch = 1

    sorted_branches = sorted(
        branch_groups.items(),
        key=lambda kv: -(kv[1][0]['duration'] if kv[1] else 0.0),
    )
    per_branch_quota = max(
        min_per_branch,
        min(cfg.max_paths_per_branch, -(-cfg.max_paths // total_branches)),
    )

    selected_idx: Set[int] = set()
    selected_full: Set[str] = set()
    contributions = []

    for sig, members in sorted_branches:
        if len(selected_idx) >= cfg.max_paths:
            break
        quota = min(per_branch_quota, cfg.max_paths - len(selected_idx))
        picked = _diverse_within_branch(members, quota)
        added = 0
        for idx in picked:
            if len(selected_idx) >= cfg.max_paths:
                break
            fsig = structures[idx]['full_sig']
            if not fsig or fsig in selected_full:
                continue
            selected_idx.add(idx)
            selected_full.add(fsig)
            added += 1
        contributions.append({
            'branch': sig, 'total_paths': len(members),
            'selected': added,
            'max_duration': max((m['duration'] for m in members), default=0.0),
        })

    # Fallback fill.
    if len(selected_idx) < cfg.max_paths:
        for _sig, members in sorted_branches:
            if len(selected_idx) >= cfg.max_paths:
                break
            for m in members:
                if len(selected_idx) >= cfg.max_paths:
                    break
                if m['index'] in selected_idx:
                    continue
                if m['full_sig'] in selected_full:
                    continue
                selected_idx.add(m['index'])
                selected_full.add(m['full_sig'])

    ordered = sorted(
        selected_idx,
        key=lambda i: -(durations[i] if i < len(durations) else 0.0),
    )
    return DiversitySelection(
        paths=[list(paths[i]) for i in ordered],
        durations=[float(durations[i]) for i in ordered if i < len(durations)],
        info={
            'selection_method': 'structural_diversity',
            'total_branches': total_branches,
            'per_branch_quota': per_branch_quota,
            'branch_contributions': contributions,
        },
    )


def _diverse_within_branch(members: List[dict], max_select: int) -> List[int]:
    if not members:
        return []
    if len(members) <= max_select:
        return [m['index'] for m in members]
    selected: List[int] = []
    seen_mid: Set[str] = set()
    # Pass 1: one per unique midpoint.
    for m in members:
        if len(selected) >= max_select:
            break
        if m['mid_sig'] not in seen_mid:
            selected.append(m['index'])
            seen_mid.add(m['mid_sig'])
    # Pass 2: fill with remaining in duration order.
    for m in members:
        if len(selected) >= max_select:
            break
        if m['index'] not in selected:
            selected.append(m['index'])
    return selected


def select_independent_near_critical(
    paths: Sequence[Sequence[str]],
    durations: Sequence[float],
    ref_path: Optional[Sequence[str]] = None,
    config: Optional[DiversityConfig] = None,
) -> DiversitySelection:
    """Family-collapse + branch quota + containment-overlap filter.

    Ports JS ``extractIndependentNearCriticalPaths`` (line 5416).
    The reference path defaults to the first (longest) input path.
    """
    cfg = config or DiversityConfig()
    if not paths:
        return DiversitySelection(
            [], [],
            {'selection_method': 'independent', 'total_branches': 0},
        )

    # Candidate gating.
    candidate_limit = min(
        len(paths),
        cfg.candidate_cap,
        max(cfg.max_paths * cfg.candidate_multiplier, cfg.max_paths * 3),
    )
    cand_paths = list(paths[:candidate_limit])
    cand_durations = list(durations[:candidate_limit]) if durations else []

    ref = list(ref_path) if ref_path is not None else list(cand_paths[0])
    ref_pos = _ref_position_map(ref)

    structures = []
    for i, p in enumerate(cand_paths):
        structures.append({
            'index': i,
            'duration': float(cand_durations[i]) if i < len(cand_durations) else 0.0,
            'branch_sig': branch_signature(p, cfg.branch_depth),
            'mid_sig': midpoint_signature(p, cfg.midpoint_depth),
            'dev_sig': deviation_signature(p, ref, ref_pos),
        })

    family_stats = None
    if cfg.family_collapse:
        fam_map: Dict[str, dict] = {}
        for s in structures:
            key = f"{s['branch_sig']}|{s['dev_sig']}"
            cur = fam_map.get(key)
            if cur is None:
                fam_map[key] = {'best': s, 'count': 1}
            else:
                cur['count'] += 1
                if s['duration'] > cur['best']['duration']:
                    cur['best'] = s
        reps = [v['best'] for v in fam_map.values()]
        reps.sort(key=lambda s: -s['duration'])

        max_family = max((v['count'] for v in fam_map.values()), default=1)
        family_stats = {
            'family_count': len(fam_map),
            'total_candidates': len(structures),
            'max_family_size': max_family,
        }

        # Dynamic tightening when a single family dominates.
        dominance = max_family / max(1, len(structures))
        fratio = len(fam_map) / max(1, len(structures))
        if max_family >= 200 or dominance >= 0.25 or fratio <= 0.40:
            cfg = DiversityConfig(**asdict(cfg))
            cfg.overlap_threshold = min(cfg.overlap_threshold, 0.90)
            cfg.min_unique_edges = max(cfg.min_unique_edges, 10)
            cfg.max_paths_per_branch = min(cfg.max_paths_per_branch, 20)
        elif max_family <= 10 and fratio >= 0.85:
            cfg = DiversityConfig(**asdict(cfg))
            cfg.overlap_threshold = max(cfg.overlap_threshold, 0.94)
            cfg.min_unique_edges = max(4, min(cfg.min_unique_edges, 8))
    else:
        reps = list(structures)

    branch_groups: Dict[str, List[dict]] = {}
    for r in reps:
        branch_groups.setdefault(r['branch_sig'], []).append(r)
    for arr in branch_groups.values():
        arr.sort(key=lambda s: -s['duration'])

    branch_count = max(len(branch_groups), 1)
    min_per = cfg.min_paths_per_branch
    if branch_count * min_per > cfg.max_paths:
        min_per = 1

    sorted_branches = sorted(
        branch_groups.items(),
        key=lambda kv: -(kv[1][0]['duration'] if kv[1] else 0.0),
    )
    base_quota = cfg.max_paths // branch_count
    remainder = cfg.max_paths % branch_count

    preselect_target = min(len(reps), max(cfg.max_paths * 3, cfg.max_paths + 10))
    preselected: List[dict] = []

    for i, (_sig, members) in enumerate(sorted_branches):
        if len(preselected) >= preselect_target:
            break
        quota = base_quota + (1 if i < remainder else 0)
        quota = max(min_per, min(cfg.max_paths_per_branch, quota))
        quota = min(len(members), max(quota, (quota * 3 + 1) // 2))

        chosen: List[dict] = []
        seen_mid: Set[str] = set()
        for m in members:
            if len(chosen) >= quota:
                break
            if m['mid_sig'] not in seen_mid:
                chosen.append(m)
                seen_mid.add(m['mid_sig'])
        for m in members:
            if len(chosen) >= quota:
                break
            if m not in chosen:
                chosen.append(m)

        for m in chosen:
            if len(preselected) >= preselect_target:
                break
            preselected.append(m)

    preselected.sort(key=lambda s: -s['duration'])

    info = {
        'selection_method': 'independent_near_critical',
        'total_candidates': len(structures),
        'candidate_limit': candidate_limit,
        'branches': branch_count,
    }
    if family_stats:
        info.update(family_stats)

    if cfg.enable_independence_filter:
        selected: List[dict] = []
        selected_edges: List[Set[str]] = []
        edge_cache: Dict[int, Set[str]] = {}

        def get_edges(s):
            if s['index'] in edge_cache:
                return edge_cache[s['index']]
            es = edge_set(cand_paths[s['index']])
            edge_cache[s['index']] = es
            return es

        for s in preselected:
            if len(selected) >= cfg.max_paths:
                break
            c_edges = get_edges(s)
            if not c_edges:
                continue

            max_overlap = 0.0
            for se in selected_edges:
                ov = containment_overlap(c_edges, se)
                if ov > max_overlap:
                    max_overlap = ov
                if max_overlap >= cfg.overlap_threshold:
                    break
            if max_overlap >= cfg.overlap_threshold:
                continue

            uniq = unique_edge_count(c_edges, selected_edges)
            if selected_edges and uniq < cfg.min_unique_edges:
                continue

            selected.append(s)
            selected_edges.append(c_edges)

        if len(selected) < min(cfg.max_paths, len(preselected)):
            selected_idx = {s['index'] for s in selected}
            for s in preselected:
                if len(selected) >= cfg.max_paths:
                    break
                if s['index'] in selected_idx:
                    continue
                selected.append(s)
                selected_idx.add(s['index'])
            info['fallback_fill'] = True

        info['selected'] = len(selected)
        final = selected
    else:
        final = preselected[:cfg.max_paths]
        info['selected'] = len(final)

    out_paths = [list(cand_paths[s['index']]) for s in final]
    out_durations = [
        float(cand_durations[s['index']]) if s['index'] < len(cand_durations) else 0.0
        for s in final
    ]
    return DiversitySelection(paths=out_paths, durations=out_durations, info=info)
