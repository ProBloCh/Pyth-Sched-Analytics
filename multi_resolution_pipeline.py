"""
multi_resolution_pipeline.py - Multi-resolution community detection.

Implements the pipeline described in docs/cybereum-multiresolution-guidance.md:
  - Adaptive resolution ladder (coarse → fine)
  - NMI stability analysis across multiple Louvain runs per tier
  - Hierarchy construction via containment overlap between adjacent tiers
  - Stable-core detection (activities that cluster together at every tier)

Output contract:
  {
    graph_stats: {n_nodes, n_edges, density},
    levels: [{resolution, n_communities, modularity, stability_nmi, membership}, ...],
    hierarchy: {tier_0_to_1: [{parent, child, overlap}, ...], ...},
    stable_cores: [[activity_id, ...], ...],
  }
"""

import logging

import networkx as nx
import numpy as np

logger = logging.getLogger(__name__)

# NetworkKit acceleration (optional)
try:
    import networkit as nk
    from networkit import nxadapter as nka
    _NK = True
except ImportError:
    _NK = False


# ---------------------------------------------------------------------------
# Resolution ladder
# ---------------------------------------------------------------------------

# Default tiers per guidance doc:
#   γ=0.3  macro systems  (5–10 groups)
#   γ=1.0  systems        (25–40 groups)
#   γ=2.5  work packages  (100–200 groups)
#   γ=4.0  work fronts    (crew-level clusters)
_DEFAULT_LADDER = [0.3, 1.0, 2.5, 4.0]


def _adaptive_ladder(n):
    """Adapt resolution ladder based on schedule size."""
    if n < 500:
        return [0.3, 1.0]              # skip fine levels for small schedules
    if n > 20_000:
        return [0.1, 0.3, 1.0, 2.5, 4.0]  # add ultra-coarse for very large
    return list(_DEFAULT_LADDER)


# ---------------------------------------------------------------------------
# Louvain with multiple runs
# ---------------------------------------------------------------------------

def _run_louvain_multi(G_undirected, resolution, n_runs=5):
    """
    Run Louvain *n_runs* times at a given resolution.

    Returns a list of partition dicts {node_id: community_int}.
    Uses NetworkKit (C++) when available for speed.
    """
    nodes = list(G_undirected.nodes())
    n = len(nodes)
    partitions = []

    if _NK and n > 100:
        try:
            G_nk = nka.nx2nk(G_undirected)
            for _ in range(n_runs):
                algo = nk.community.PLM(G_nk, gamma=resolution)
                algo.run()
                pk = algo.getPartition()
                part = {nodes[i]: pk.subsetOf(i) for i in range(n)}
                partitions.append(part)
            return partitions
        except Exception as e:
            logger.info("NetworkKit PLM failed at γ=%.2f (%s); "
                        "falling back to NetworkX", resolution, e)

    for seed in range(n_runs):
        try:
            communities = nx.algorithms.community.louvain_communities(
                G_undirected, weight='weight', resolution=resolution,
                seed=seed,
            )
        except AttributeError:
            # Older NetworkX without louvain_communities
            communities = nx.algorithms.community.greedy_modularity_communities(
                G_undirected, weight='weight',
            )
        part = {}
        for cid, member_set in enumerate(communities):
            for node in member_set:
                part[node] = cid
        partitions.append(part)

    return partitions


# ---------------------------------------------------------------------------
# NMI stability
# ---------------------------------------------------------------------------

def _nmi(part_a, part_b, nodes):
    """Normalised Mutual Information between two partitions."""
    from sklearn.metrics import normalized_mutual_info_score
    la = [part_a.get(nd, -1) for nd in nodes]
    lb = [part_b.get(nd, -1) for nd in nodes]
    return normalized_mutual_info_score(la, lb)


def _stability_select(partitions, nodes):
    """Select the partition with highest average NMI to all others.

    Returns (best_partition, avg_nmi_score).
    """
    k = len(partitions)
    if k <= 1:
        return (partitions[0] if partitions else {}), 1.0

    avg_nmi = np.zeros(k)
    for i in range(k):
        for j in range(i + 1, k):
            score = _nmi(partitions[i], partitions[j], nodes)
            avg_nmi[i] += score
            avg_nmi[j] += score
    avg_nmi /= (k - 1)

    best = int(np.argmax(avg_nmi))
    return partitions[best], float(avg_nmi[best])


# ---------------------------------------------------------------------------
# Hierarchy construction
# ---------------------------------------------------------------------------

def _build_hierarchy(levels, nodes, overlap_threshold=0.7):
    """Build containment edges between adjacent resolution tiers.

    A fine-grained community *child* is assigned to coarse-grained
    community *parent* when >= *overlap_threshold* of its members
    belong to that parent.
    """
    hierarchy = {}

    for t in range(len(levels) - 1):
        coarse = levels[t]['partition']
        fine = levels[t + 1]['partition']

        # For each coarse community, tally which fine communities its
        # members belong to (and vice versa).
        fine_in_coarse = {}          # {fine_id: {coarse_id: count}}
        for nd in nodes:
            cg = coarse.get(nd, -1)
            fg = fine.get(nd, -1)
            fine_in_coarse.setdefault(fg, {})
            fine_in_coarse[fg][cg] = fine_in_coarse[fg].get(cg, 0) + 1

        containment = []
        for fg, parents in fine_in_coarse.items():
            total = sum(parents.values())
            for cg, count in parents.items():
                frac = count / total
                if frac >= overlap_threshold:
                    containment.append({
                        'parent': int(cg),
                        'child':  int(fg),
                        'overlap': round(frac, 3),
                    })
        hierarchy[f"tier_{t}_to_{t + 1}"] = containment

    return hierarchy


# ---------------------------------------------------------------------------
# Stable cores
# ---------------------------------------------------------------------------

def _find_stable_cores(levels, nodes):
    """Activity sets that cluster together across every tier."""
    if not levels:
        return []

    # Group nodes by the finest-tier community
    finest = levels[-1]['partition']
    fine_groups = {}
    for nd in nodes:
        cid = finest.get(nd, -1)
        fine_groups.setdefault(cid, []).append(nd)

    cores = []
    for group in fine_groups.values():
        if len(group) < 2:
            continue
        # Check coarser tiers: all nodes must share the same community
        stable = True
        for lvl in levels[:-1]:
            part = lvl['partition']
            if len({part.get(nd, -1) for nd in group}) > 1:
                stable = False
                break
        if stable:
            cores.append(sorted(str(nd) for nd in group))

    return cores


# ---------------------------------------------------------------------------
# Per-group metrics
# ---------------------------------------------------------------------------

def _group_metrics(G_undirected, partition, resolution):
    """Compute per-group density and boundary-edge counts."""
    groups = {}
    for nd, cid in partition.items():
        groups.setdefault(cid, set()).add(nd)

    metrics = {}
    for cid, members in groups.items():
        subg = G_undirected.subgraph(members)
        internal = subg.number_of_edges()
        n_m = len(members)
        max_edges = n_m * (n_m - 1) / 2 if n_m > 1 else 1
        density = internal / max_edges if max_edges > 0 else 0.0

        boundary = 0
        for nd in members:
            for nbr in G_undirected.neighbors(nd):
                if nbr not in members:
                    boundary += 1

        metrics[int(cid)] = {
            'size': n_m,
            'internal_edges': internal,
            'boundary_edges': boundary,
            'density': round(density, 4),
        }
    return metrics


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run_multi_resolution(G_undirected, n_runs=5):
    """
    Run multi-resolution community detection pipeline.

    Parameters
    ----------
    G_undirected : nx.Graph
        Undirected schedule dependency graph (weighted edges preferred).
    n_runs : int
        Number of Louvain runs per resolution for stability analysis.

    Returns
    -------
    dict  Hierarchical JSON structure per guidance doc.
    """
    nodes = list(G_undirected.nodes())
    n = len(nodes)

    if n < 2 or G_undirected.number_of_edges() == 0:
        return _empty(n)

    ladder = _adaptive_ladder(n)
    levels = []

    for gamma in ladder:
        partitions = _run_louvain_multi(G_undirected, gamma, n_runs=n_runs)
        best_part, stability = _stability_select(partitions, nodes)

        # Community sets for modularity computation
        comm_sets = {}
        for nd, cid in best_part.items():
            comm_sets.setdefault(cid, set()).add(nd)
        community_list = list(comm_sets.values())

        try:
            modularity = nx.algorithms.community.quality.modularity(
                G_undirected, community_list, resolution=gamma,
            )
        except Exception:
            modularity = 0.0

        gm = _group_metrics(G_undirected, best_part, gamma)

        levels.append({
            'resolution':    gamma,
            'n_communities': len(community_list),
            'modularity':    round(modularity, 4),
            'stability_nmi': round(stability, 4),
            'partition':     best_part,
            'membership':    {str(nd): int(cid) for nd, cid in best_part.items()},
            'group_metrics': gm,
        })

    hierarchy = _build_hierarchy(levels, nodes)
    stable_cores = _find_stable_cores(levels, nodes)

    # Strip internal partition dicts before returning
    api_levels = []
    for lvl in levels:
        api_levels.append({
            'resolution':    lvl['resolution'],
            'n_communities': lvl['n_communities'],
            'modularity':    lvl['modularity'],
            'stability_nmi': lvl['stability_nmi'],
            'membership':    lvl['membership'],
            'group_metrics': lvl['group_metrics'],
        })

    return {
        'graph_stats': {
            'n_nodes': n,
            'n_edges': G_undirected.number_of_edges(),
            'density': round(nx.density(G_undirected), 6),
        },
        'levels':       api_levels,
        'hierarchy':    hierarchy,
        'stable_cores': stable_cores,
    }


def _empty(n):
    return {
        'graph_stats': {'n_nodes': n, 'n_edges': 0, 'density': 0.0},
        'levels':       [],
        'hierarchy':    {},
        'stable_cores': [],
    }
