"""
Tests for the /paths blueprint and its underlying modules.

Covers:
  - enumerate: exact DFS + longest-first strategies
  - enumerate: structural diversity / independence filters
  - driving_graph: critical + near-critical chain extraction
  - distances: shortest/longest to start and to end with FS/SS/FF/SF + lag
  - calendar_slack: CPM + calendar projection to ISO
  - HTTP endpoints: validation, happy path, caching
"""

import pytest

from paths.calendar_slack import compute_calendar_slack
from paths.distances import (
    distances_to_end,
    distances_to_start,
    near_critical_mask,
)
from paths.diversity import (
    DiversityConfig,
    auto_tune_config,
    branch_signature,
    containment_overlap,
    deviation_signature,
    edge_set,
    full_signature,
    midpoint_signature,
    select_independent_near_critical,
    select_structurally_diverse,
)
from paths.driving_graph import (
    DrivingGraphConfig,
    compute_pred_rankings,
    extract_driving_graph,
)
from paths.enumerate import (
    enumerate_all_paths_exact,
    enumerate_longest_paths_first,
    find_all_paths,
    path_duration,
)
from solver.dag import build_dag

# =====================================================================
# Fixtures local to this suite
# =====================================================================

@pytest.fixture
def parallel_schedule():
    """
        A -> B -> F
        A -> C -> F
        A -> D -> F
        A -> E -> F

    Four parallel branches of different duration.  Durations chosen so
    B-path is critical (42), C/D/E are near-critical (41/40/39).
    """
    nodes = [
        {'ID': 'A', 'Duration': 5},
        {'ID': 'B', 'Duration': 30},
        {'ID': 'C', 'Duration': 29},
        {'ID': 'D', 'Duration': 28},
        {'ID': 'E', 'Duration': 27},
        {'ID': 'F', 'Duration': 7},
    ]
    links = [
        {'source': 'A', 'target': 'B'},
        {'source': 'A', 'target': 'C'},
        {'source': 'A', 'target': 'D'},
        {'source': 'A', 'target': 'E'},
        {'source': 'B', 'target': 'F'},
        {'source': 'C', 'target': 'F'},
        {'source': 'D', 'target': 'F'},
        {'source': 'E', 'target': 'F'},
    ]
    return nodes, links


@pytest.fixture
def ss_ff_schedule():
    """Covers non-FS relationships.

        A(10) --SS,lag=2--> B(5)
        A(10) --FS,lag=0--> C(8)
        B, C both point to D(3) via FS.
    """
    nodes = [
        {'ID': 'A', 'Duration': 10},
        {'ID': 'B', 'Duration': 5},
        {'ID': 'C', 'Duration': 8},
        {'ID': 'D', 'Duration': 3},
    ]
    links = [
        {'source': 'A', 'target': 'B', 'type': 'SS', 'lag': 2},
        {'source': 'A', 'target': 'C', 'type': 'FS'},
        {'source': 'B', 'target': 'D', 'type': 'FS'},
        {'source': 'C', 'target': 'D', 'type': 'FS'},
    ]
    return nodes, links


# =====================================================================
# Distances
# =====================================================================

class TestDistances:

    def test_linear_distances(self, linear_schedule):
        nodes, links = linear_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        ds = distances_to_start(state)
        de = distances_to_end(state)
        # A -> B -> C with durations 10, 20, 5.  Along an FS chain,
        # shortest == longest since there's only one path.
        assert ds['shortest'][idx['A']] == 0.0
        assert ds['longest'][idx['A']] == 0.0
        assert ds['shortest'][idx['B']] == 10.0
        assert ds['longest'][idx['B']] == 10.0
        assert ds['shortest'][idx['C']] == 30.0
        assert ds['longest'][idx['C']] == 30.0

        assert de['longest'][idx['A']] == 30.0  # 10 + 20 (B dur + C dur - but not A)
        assert de['longest'][idx['C']] == 0.0

    def test_diamond_shortest_vs_longest(self, diamond_schedule):
        nodes, links = diamond_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        ds = distances_to_start(state)
        # D can be reached via B (dur 15) or C (dur 8).
        # Longest = 10 + 15 = 25 (matches CPM ES for D).
        # Shortest = 10 + 8 = 18.
        assert ds['longest'][idx['D']] == 25.0
        assert ds['shortest'][idx['D']] == 18.0

    def test_ss_relationship(self, ss_ff_schedule):
        nodes, links = ss_ff_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        ds = distances_to_start(state)
        # A -> B via SS lag 2: distance(B) = distance(A) + lag = 2.
        assert ds['longest'][idx['B']] == 2.0

    def test_near_critical_mask(self, parallel_schedule):
        nodes, links = parallel_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        # Critical: A, B, F; near-critical (TF <= 24h): add C (TF=1), D (TF=2), E (TF=3).
        mask = near_critical_mask(state, tolerance_hours=24.0)
        assert mask[idx['A']]
        assert mask[idx['B']]
        assert mask[idx['C']]
        assert mask[idx['D']]
        assert mask[idx['E']]
        assert mask[idx['F']]


# =====================================================================
# Calendar slack
# =====================================================================

class TestCalendarSlack:

    def test_no_calendar(self, diamond_schedule):
        nodes, links = diamond_schedule
        r = compute_calendar_slack(nodes, links)
        assert r['makespan_hours'] == 42.0
        assert r['critical_count'] == 4  # A, B, D, E
        assert r['project_finish'] is None
        # Each node has TF but no date projection.
        for n in r['nodes']:
            assert n['ES_date'] is None
            assert n['EF_date'] is None

    def test_with_calendar(self, diamond_schedule):
        nodes, links = diamond_schedule
        r = compute_calendar_slack(
            nodes, links,
            project_start='2026-01-05T00:00:00Z',  # Monday
            calendar_config={'hours_per_day': 8},
        )
        assert r['makespan_hours'] == 42.0
        # 42h / 8h per working day = 5.25 working days from Mon:
        # Mon(8)+Tue(8)+Wed(8)+Thu(8)+Fri(8)+Sat/Sun off + Mon(2) = 2026-01-12T02:00
        assert r['project_finish'].startswith('2026-01-12T02:00')

    def test_durations_in_days(self):
        nodes = [
            {'ID': 'X', 'Duration': 1, 'TimeUnits': 'days'},
            {'ID': 'Y', 'Duration': 2, 'TimeUnits': 'days'},
        ]
        links = [{'source': 'X', 'target': 'Y', 'type': 'FS'}]
        r = compute_calendar_slack(nodes, links,
                                   calendar_config={'hours_per_day': 8})
        # 1d + 2d = 3d = 24h at 8h/day
        assert r['makespan_hours'] == 24.0


# =====================================================================
# Enumeration
# =====================================================================

class TestEnumerateExact:

    def test_linear(self, linear_schedule):
        nodes, links = linear_schedule
        r = find_all_paths(nodes, links, 'A', 'C')
        assert r['method'] == 'exact'
        assert r['paths'] == [['A', 'B', 'C']]
        assert r['durations'] == [35.0]

    def test_diamond(self, diamond_schedule):
        nodes, links = diamond_schedule
        r = find_all_paths(nodes, links, 'A', 'E')
        assert r['method'] == 'exact'
        assert len(r['paths']) == 2
        # Longest first.
        assert r['paths'][0] == ['A', 'B', 'D', 'E']
        assert r['durations'][0] == 42.0
        assert r['paths'][1] == ['A', 'C', 'D', 'E']
        assert r['durations'][1] == 35.0

    def test_parallel_four_paths(self, parallel_schedule):
        nodes, links = parallel_schedule
        r = find_all_paths(nodes, links, 'A', 'F', max_paths=100,
                           branch_balanced=False)
        assert r['method'] == 'exact'
        assert len(r['paths']) == 4
        # Durations descending (all end with F); each path == 5+branch+7.
        assert r['durations'] == [42.0, 41.0, 40.0, 39.0]

    def test_max_paths_cap(self, parallel_schedule):
        nodes, links = parallel_schedule
        r = find_all_paths(nodes, links, 'A', 'F', max_paths=2)
        assert len(r['paths']) <= 2

    def test_invalid_endpoints(self, diamond_schedule):
        nodes, links = diamond_schedule
        r = find_all_paths(nodes, links, 'A', 'ZZZ')
        assert 'error' in r
        assert r['paths'] == []


class TestEnumerateLongestFirst:

    def test_longest_first_finds_critical(self, parallel_schedule):
        """Force the longest-first branch and verify it still finds
        the critical path first."""
        nodes, links = parallel_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        paths, _truncated = enumerate_longest_paths_first(
            state, idx['A'], idx['F'],
            max_paths=10, critical_mask=state.critical_mask,
        )
        # First path returned should be the longest (A->B->F = 42).
        assert len(paths) >= 1
        first_dur = path_duration(state, paths[0])
        assert first_dur == 42.0

    def test_path_duration_with_ss(self, ss_ff_schedule):
        """path_duration honours SS + lag per JS calculatePathDuration."""
        nodes, links = ss_ff_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        # A -> B -> D: A starts at 0, B (SS lag 2) starts at 2,
        # B finishes at 7, D (FS) starts at 7, D finishes at 10.
        dur = path_duration(state, (idx['A'], idx['B'], idx['D']))
        assert dur == 10.0

    def test_longest_first_drains_organically(self, parallel_schedule):
        """When max_paths exceeds the true number of source->sink
        paths, longest-first must drain the heap and report
        truncated=False -- the strategy was sampled but the corpus
        ended up exhaustive (round 14 fix to corpus_truncated)."""
        nodes, links = parallel_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        # Only 4 distinct A->F paths in this fixture; ask for 50.
        paths, truncated = enumerate_longest_paths_first(
            state, idx['A'], idx['F'],
            max_paths=50, critical_mask=state.critical_mask,
        )
        assert len(paths) == 4
        assert truncated is False

    def test_longest_first_truncates_on_budget_exit(self, parallel_schedule):
        """When the heap is non-empty at exit because the
        ``max_expansions`` budget ran out, truncated must be True."""
        nodes, links = parallel_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        # Force an immediate budget exit so the heap still has the
        # initial start_path entry waiting -- no path will ever land
        # in the tracker.
        paths, truncated = enumerate_longest_paths_first(
            state, idx['A'], idx['F'],
            max_paths=10, critical_mask=state.critical_mask,
            max_expansions=1,
        )
        assert truncated is True

    def test_longest_first_truncates_on_tracker_eviction(
        self, parallel_schedule,
    ):
        """When the Top-K tracker fills and evicts a real completion
        (or rejects a new completion because the tracker is full of
        better paths), truncated must be True even though the heap
        drains organically (Copilot review #604, round 15:
        enumerate.py:499)."""
        nodes, links = parallel_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        # 4 distinct A->F paths, ask for only 1 -- the tracker evicts
        # at least once (longer paths displace shorter, or shorter
        # paths get rejected against the seated longest).
        paths, truncated = enumerate_longest_paths_first(
            state, idx['A'], idx['F'],
            max_paths=1, critical_mask=state.critical_mask,
        )
        assert len(paths) == 1
        assert truncated is True

    def test_longest_first_truncates_on_heap_trim(self):
        """When the blow-up guard slices frontier states, truncated
        must be True even when the search ultimately drains the
        remaining heap (Copilot review #604, round 15:
        enumerate.py:499)."""
        # Wide fan-out from a single source so the per-expansion push
        # rate exceeds 4 * max_paths quickly.  Three layers of fan-out
        # before sink: many candidate prefixes survive on the heap,
        # max_paths=2 means heap > 8 forces a trim.
        nodes = [{'ID': 'S'}]
        links = []
        # Layer 1: 30 children of S.
        for i in range(30):
            nid = f"L1_{i}"
            nodes.append({'ID': nid})
            links.append({'source': 'S', 'target': nid})
        # Layer 2: each L1 has 3 children that all converge on E.
        nodes.append({'ID': 'E'})
        for i in range(30):
            for j in range(3):
                mid = f"L2_{i}_{j}"
                nodes.append({'ID': mid})
                links.append({'source': f"L1_{i}", 'target': mid})
                links.append({'source': mid, 'target': 'E'})
        state, idx = build_dag(nodes, links, default_duration=1.0)
        paths, truncated = enumerate_longest_paths_first(
            state, idx['S'], idx['E'],
            max_paths=2, critical_mask=state.critical_mask,
        )
        # 30 * 3 = 90 distinct paths exist; we asked for 2.  Either
        # the heap-trim or tracker-eviction signal fires (often both).
        assert truncated is True

    def test_exact_not_truncated_when_capped_at_real_count(
        self, parallel_schedule,
    ):
        """When exact DFS returns exactly max_paths AND no further
        unique suffixes are pending, the corpus is exhaustive --
        truncated must be False even though len(out) == max_paths
        (round 14: was previously a heuristic false-positive)."""
        nodes, links = parallel_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        paths, truncated = enumerate_all_paths_exact(
            state, idx['A'], idx['F'], max_paths=4,
        )
        assert len(paths) == 4
        assert truncated is False

    def test_exact_truncated_when_below_real_count(self, parallel_schedule):
        """Exact DFS asked for fewer paths than exist must report
        truncated=True."""
        nodes, links = parallel_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        paths, truncated = enumerate_all_paths_exact(
            state, idx['A'], idx['F'], max_paths=2,
        )
        assert len(paths) == 2
        assert truncated is True

    def test_find_all_paths_corpus_truncated_false_on_organic_drain(
        self, parallel_schedule,
    ):
        """Smoke-test the dispatcher's corpus_truncated wiring: a
        small DAG run through exact DFS that returns the full set
        should flag corpus_truncated=False, not the previous
        len(raw) >= max_paths heuristic."""
        nodes, links = parallel_schedule
        result = find_all_paths(
            nodes, links, 'A', 'F', max_paths=4,
        )
        assert result['method'] == 'exact'
        assert len(result['paths']) == 4
        assert result['corpus_truncated'] is False


# =====================================================================
# Diversity
# =====================================================================

class TestDiversitySignatures:

    def test_branch_sig(self):
        assert branch_signature(['A', 'B', 'C', 'D'], 2) == 'A->B'
        assert branch_signature([], 4) == ''
        assert branch_signature(['A'], 4) == 'A'

    def test_midpoint_sig_short(self):
        # Fewer than 5 nodes -> "short".
        assert midpoint_signature(['A', 'B', 'C', 'D'], 3) == 'short'

    def test_midpoint_sig_long(self):
        p = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
        sig = midpoint_signature(p, 3)
        # Mid=3, start=2, end=5 -> C->D->E
        assert sig == 'C->D->E'

    def test_full_sig(self):
        assert full_signature(['A', 'B']) == 'A->B'

    def test_deviation_sig(self):
        ref = ['A', 'B', 'C', 'D', 'E']
        pos = {n: i for i, n in enumerate(ref)}
        # Path diverges at B (B->X instead of B->C), never rejoins.
        path = ['A', 'B', 'X', 'Y']
        sig = deviation_signature(path, ref, pos)
        assert sig.startswith('DV@1:B->X')
        assert 'RJ@none' in sig

    def test_deviation_rejoin(self):
        ref = ['A', 'B', 'C', 'D', 'E']
        pos = {n: i for i, n in enumerate(ref)}
        # Diverge at B (B->X), rejoin at D.
        path = ['A', 'B', 'X', 'D', 'E']
        sig = deviation_signature(path, ref, pos)
        assert 'DV@1:B->X' in sig
        assert 'RJ@3:D' in sig

    def test_edge_set(self):
        es = edge_set(['A', 'B', 'C'])
        assert es == {'A->B', 'B->C'}

    def test_containment_overlap(self):
        a = {'A->B', 'B->C'}
        b = {'A->B', 'B->C', 'C->D'}
        # min(|A|,|B|)=2, intersection=2 -> 1.0
        assert containment_overlap(a, b) == 1.0

        c = {'X->Y'}
        assert containment_overlap(a, c) == 0.0


class TestDiversitySelectors:

    def test_structural_diverse_picks_each_branch(self, parallel_schedule):
        """With 4 parallel branches, structural diversity selects each."""
        nodes, links = parallel_schedule
        r = find_all_paths(nodes, links, 'A', 'F', max_paths=20)
        cfg = DiversityConfig(max_paths=4, enable_auto_tune=False,
                              branch_depth=2, min_paths_per_branch=1)
        sel = select_structurally_diverse(r['paths'], r['durations'], cfg)
        assert len(sel.paths) == 4
        # The middle node of each path (B/C/D/E) should each appear once.
        middles = {p[1] for p in sel.paths}
        assert middles == {'B', 'C', 'D', 'E'}

    def test_independent_suppresses_micro_variants(self):
        """When many paths share the same backbone, independence picks a few."""
        # Synthetic: backbone S -> core -> T with small variants.
        paths = [
            ['S', 'a', 'b', 'c', 'd', 'T'],
            ['S', 'a', 'b', 'c', 'd', 'T'],  # duplicate
            ['S', 'a', 'x', 'c', 'd', 'T'],  # one-node variant
            ['S', 'z', 'y', 'w', 'v', 'T'],  # independent branch
        ]
        durations = [100.0, 100.0, 99.0, 95.0]
        cfg = DiversityConfig(max_paths=3, enable_auto_tune=False,
                              branch_depth=2, min_unique_edges=2,
                              overlap_threshold=0.80)
        sel = select_independent_near_critical(paths, durations, config=cfg)
        # The fully-duplicated path shouldn't appear twice; the
        # independent branch SHOULD appear.
        sigs = {tuple(p) for p in sel.paths}
        assert tuple(['S', 'z', 'y', 'w', 'v', 'T']) in sigs

    def test_auto_tune_scales_with_size(self):
        cfg = DiversityConfig()
        many_paths = [['A', 'B', 'C', 'D']] * 50
        tuned = auto_tune_config(cfg, many_paths,
                                 node_count=10000, link_count=30000)
        # Tuned cap shrinks for big schedules.
        assert tuned.candidate_cap <= 15000


# =====================================================================
# Driving graph
# =====================================================================

class TestDrivingGraph:

    def test_critical_chain_found(self, diamond_schedule):
        nodes, links = diamond_schedule
        r = extract_driving_graph(nodes, links, 'A', 'E')
        assert r.project_finish_hours == 42.0
        # Critical chain A->B->D->E must appear.
        crit_sigs = {tuple(p) for p in r.critical_chains}
        assert ('A', 'B', 'D', 'E') in crit_sigs
        # Near-critical set should at least include the critical chain,
        # and may also include A->C->D->E if C's float is within
        # near_critical_float_tol_hours (24 by default).  C has TF=7.
        near_sigs = {tuple(p) for p in r.near_critical_chains}
        assert ('A', 'B', 'D', 'E') in near_sigs
        assert ('A', 'C', 'D', 'E') in near_sigs

    def test_pred_ranking(self, diamond_schedule):
        nodes, links = diamond_schedule
        state, idx = build_dag(nodes, links, default_duration=0.0)
        idx_to_id = {i: nid for nid, i in idx.items()}
        rankings = compute_pred_rankings(state, idx_to_id)
        # D has two predecessors (B, C); B should be the binding one
        # (delta_hours == 0).
        d_ranks = rankings[idx['D']]
        assert len(d_ranks) == 2
        by_pred = {r.pred_id: r for r in d_ranks}
        assert by_pred['B'].delta_hours == 0.0
        # C is 7h behind B.
        assert abs(by_pred['C'].delta_hours - 7.0) < 1e-9

    def test_selection_outliers_mode(self, parallel_schedule):
        """With enough novelty, outlier mode returns multiple chains."""
        nodes, links = parallel_schedule
        cfg = DrivingGraphConfig(
            near_critical_float_tol_hours=24.0,  # includes C/D/E
            max_display_chains=5,
            min_jaccard_novelty=0.10,
        )
        r = extract_driving_graph(nodes, links, 'A', 'F', cfg)
        # Should include the critical path and at least one alternate.
        assert len(r.paths) >= 2

    def test_invalid_endpoints(self, diamond_schedule):
        nodes, links = diamond_schedule
        r = extract_driving_graph(nodes, links, 'A', 'ZZZ')
        assert r.paths == []
        assert 'error' in r.explainability


# =====================================================================
# HTTP endpoints
# =====================================================================

class TestEndpointsHealth:

    def test_health(self, client):
        r = client.get('/paths/health')
        assert r.status_code == 200
        body = r.get_json()
        assert body['status'] == 'healthy'
        assert '/paths/enumerate' in body['endpoints']


class TestEndpointEnumerate:

    def test_happy_path(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links,
            'start_id': 'A', 'end_id': 'E',
            'selection': 'raw',
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['method'] == 'exact'
        assert body['paths'][0] == ['A', 'B', 'D', 'E']
        assert body['durations'][0] == 42.0

    def test_default_endpoints(self, client, diamond_schedule):
        """Falls back to predecessor-less / successor-less when '0' and
        a numeric max are not present."""
        nodes, links = diamond_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links, 'selection': 'raw',
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['start_id'] == 'A'
        assert body['end_id'] == 'E'

    def test_default_endpoints_nan_inf_ids_ignored(self, client):
        """Malicious or malformed IDs parsing as NaN/Inf must not be
        selected as the max-numeric end anchor.  Without the isfinite
        filter, NaN-first ordering in max() would pick the NaN entry."""
        nodes = [
            {'ID': 'nan', 'Duration': 1},
            {'ID': '5',   'Duration': 2},
            {'ID': 'inf', 'Duration': 3},
            {'ID': '99',  'Duration': 4},
        ]
        links = [
            {'source': '5', 'target': '99'},
        ]
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links, 'selection': 'raw',
        })
        assert r.status_code == 200
        body = r.get_json()
        # End must be '99' (max finite numeric ID), not 'nan' or 'inf'.
        assert body['end_id'] == '99'

    def test_default_endpoints_app_convention(self, client):
        """Main-app convention: start='0', end=max numeric ID."""
        nodes = [
            {'ID': '0', 'Duration': 0},
            {'ID': '1', 'Duration': 5},
            {'ID': '2', 'Duration': 3},
            {'ID': '99', 'Duration': 0},   # the artificial end
        ]
        links = [
            {'source': '0', 'target': '1'},
            {'source': '1', 'target': '2'},
            {'source': '2', 'target': '99'},
        ]
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links, 'selection': 'raw',
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['start_id'] == '0'
        assert body['end_id'] == '99'

    def test_independence_filter(self, client, parallel_schedule):
        nodes, links = parallel_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links,
            'start_id': 'A', 'end_id': 'F',
            'selection': 'independent',
            'diversity': {'max_paths': 4, 'enable_auto_tune': False,
                          'branch_depth': 2, 'min_paths_per_branch': 1,
                          'enable_independence_filter': False},
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['selection'] == 'independent'
        assert len(body['paths']) <= 4

    def test_payload_validation(self, client):
        # Missing nodes
        r = client.post('/paths/enumerate', json={'links': []})
        assert r.status_code == 400

    def test_unknown_link_target(self, client):
        r = client.post('/paths/enumerate', json={
            'nodes': [{'ID': 'A', 'Duration': 1}],
            'links': [{'source': 'A', 'target': 'UNKNOWN'}],
        })
        assert r.status_code == 400

    def test_root_must_be_object(self, client):
        r = client.post('/paths/enumerate', json=[1, 2, 3])
        assert r.status_code == 400

    def test_max_paths_non_integer_returns_400(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links,
            'max_paths': 'abc',
        })
        assert r.status_code == 400

    def test_diversity_must_be_object(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links,
            'diversity': [1, 2, 3],
        })
        assert r.status_code == 400


class TestEndpointValidation:
    """Type-guard regression tests for the four POST endpoints."""

    def test_driving_graph_config_must_be_object(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/driving-graph', json={
            'nodes': nodes, 'links': links, 'config': 'oops',
        })
        assert r.status_code == 400

    def test_calendar_must_be_object(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/calendar-slack', json={
            'nodes': nodes, 'links': links, 'calendar': [1, 2],
        })
        assert r.status_code == 400

    def test_distances_near_tol_non_numeric(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/distances', json={
            'nodes': nodes, 'links': links,
            'near_critical_tol_hours': 'foo',
        })
        assert r.status_code == 400

    def test_distances_near_tol_negative(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/distances', json={
            'nodes': nodes, 'links': links,
            'near_critical_tol_hours': -5,
        })
        assert r.status_code == 400

    def test_milestone_duration_accepted(self, client):
        """ID '0' / Duration '' / 0 must be accepted (matches solver.dag)."""
        r = client.post('/paths/distances', json={
            'nodes': [
                {'ID': '0', 'Duration': ''},
                {'ID': '1', 'Duration': 5},
                {'ID': '2', 'Duration': None},
            ],
            'links': [
                {'source': '0', 'target': '1'},
                {'source': '1', 'target': '2'},
            ],
        })
        assert r.status_code == 200

    def test_zero_id_is_not_clobbered(self, client):
        """start_id='0' must NOT be replaced by the inferred anchor."""
        r = client.post('/paths/enumerate', json={
            'nodes': [
                {'ID': '0', 'Duration': 1},
                {'ID': '1', 'Duration': 2},
            ],
            'links': [{'source': '0', 'target': '1'}],
            'start_id': '0', 'end_id': '1',
            'selection': 'raw',
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['start_id'] == '0'

    def test_unknown_selection_rejected(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links, 'selection': 'mysterious',
        })
        assert r.status_code == 400

    def test_diversity_field_type_validated(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links,
            'diversity': {'overlap_threshold': 'not-a-number'},
        })
        assert r.status_code == 400

    def test_driving_graph_field_type_validated(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/driving-graph', json={
            'nodes': nodes, 'links': links,
            'config': {'epsilon_hours': 'huh'},
        })
        assert r.status_code == 400

    def test_calendar_garbage_inputs_dont_500(self, client, diamond_schedule):
        """Malformed hours_per_day / working_days fall back to defaults
        rather than crashing the request."""
        nodes, links = diamond_schedule
        r = client.post('/paths/calendar-slack', json={
            'nodes': nodes, 'links': links,
            'calendar': {'hours_per_day': 'eight', 'working_days': 'mtwf'},
        })
        assert r.status_code == 200

    def test_diversity_null_field_uses_default(self, client, diamond_schedule):
        """Sending an explicit null for a diversity field must drop the
        key (using the dataclass default) rather than crashing in
        math.isnan(None)."""
        nodes, links = diamond_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links,
            'diversity': {'overlap_threshold': None, 'max_paths': None},
        })
        assert r.status_code == 200

    def test_enumerate_start_equals_end_returns_200(self, client, diamond_schedule):
        """When start_id == end_id, the engine reports zero paths but no
        error; the route should return 200 with an empty result set
        (NOT the degenerate single-node path)."""
        nodes, links = diamond_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links,
            'start_id': 'A', 'end_id': 'A',
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['paths'] == []
        assert body['durations'] == []
        assert body['raw_path_count'] == 0

    def test_enumerate_unknown_endpoint_returns_400(self, client, diamond_schedule):
        """find_all_paths reports start/end-not-in-schedule via an error
        payload; the route must surface that as 4xx, not 200."""
        nodes, links = diamond_schedule
        r = client.post('/paths/enumerate', json={
            'nodes': nodes, 'links': links,
            'start_id': 'A', 'end_id': 'NOT_A_NODE',
        })
        assert r.status_code == 400

    def test_driving_graph_max_expansions_capped(self, client, diamond_schedule):
        """Range bounds prevent abuse like config.max_expansions=10**9."""
        nodes, links = diamond_schedule
        r = client.post('/paths/driving-graph', json={
            'nodes': nodes, 'links': links,
            'config': {'max_expansions': 1_000_000_000},
        })
        assert r.status_code == 400

    def test_calendar_slack_project_start_must_parse(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/calendar-slack', json={
            'nodes': nodes, 'links': links,
            'project_start': 'not-a-date',
        })
        assert r.status_code == 400

    def test_calendar_slack_project_start_must_be_string(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/calendar-slack', json={
            'nodes': nodes, 'links': links,
            'project_start': 123,
        })
        assert r.status_code == 400

    def test_driving_graph_selection_mode_allowlist(self, client, diamond_schedule):
        """selection_mode must be one of {raw, outliers}."""
        nodes, links = diamond_schedule
        r = client.post('/paths/driving-graph', json={
            'nodes': nodes, 'links': links,
            'config': {'selection_mode': 'mystery'},
        })
        assert r.status_code == 400

    def test_driving_graph_returns_400_when_endpoint_unreachable(self, client):
        """Disconnected start/end -> engine signals 'no active subgraph';
        route should return 400."""
        nodes = [
            {'ID': 'a', 'Duration': 1},
            {'ID': 'b', 'Duration': 1},
        ]
        links = []  # no link, so b is unreachable from a
        r = client.post('/paths/driving-graph', json={
            'nodes': nodes, 'links': links,
            'start_id': 'a', 'end_id': 'b',
        })
        assert r.status_code == 400


class TestEndpointDrivingGraph:

    def test_happy_path(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/driving-graph', json={
            'nodes': nodes, 'links': links,
            'start_id': 'A', 'end_id': 'E',
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['project_finish_hours'] == 42.0
        assert body['active_node_count'] == 5
        # Critical chain should be present.
        sigs = {tuple(p) for p in body['critical_chains']}
        assert ('A', 'B', 'D', 'E') in sigs

    def test_explainability(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/driving-graph', json={
            'nodes': nodes, 'links': links,
            'start_id': 'A', 'end_id': 'E',
        })
        body = r.get_json()
        expl = body['explainability']
        assert 'pred_rankings' in expl
        # D's predecessor ranking lists B and C.
        d_ranks = expl['pred_rankings'].get('D', [])
        pred_ids = {r['pred_id'] for r in d_ranks}
        assert pred_ids == {'B', 'C'}


class TestEndpointDistances:

    def test_happy_path(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/distances', json={
            'nodes': nodes, 'links': links,
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['makespan_hours'] == 42.0
        # Find D in the output.
        by_id = {n['ID']: n for n in body['nodes']}
        assert by_id['D']['longest_to_start'] == 25.0
        assert by_id['D']['shortest_to_start'] == 18.0
        assert by_id['D']['TF'] == 0.0


class TestEndpointCalendarSlack:

    def test_happy_path(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/calendar-slack', json={
            'nodes': nodes, 'links': links,
            'project_start': '2026-01-05T00:00:00Z',
            'calendar': {'hours_per_day': 8},
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['makespan_hours'] == 42.0
        assert body['project_finish'].startswith('2026-01-12T02:00')

    def test_no_calendar(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        r = client.post('/paths/calendar-slack', json={
            'nodes': nodes, 'links': links,
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['makespan_hours'] == 42.0
        assert body['project_finish'] is None
