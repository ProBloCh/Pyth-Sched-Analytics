"""
Tests for paths/subpath_patterns.py and the /paths/recurring-subpaths
HTTP endpoint.

Covers:
  - envelope stripping (start='0', end=max numeric ID)
  - median + MAD z-scores (robustness on uniform / heavy-tailed)
  - anchor identification across multiple metric families
  - anchor-pair extraction with Lmin / Lmax filtering
  - scoring components (supp, junc, sal, maxpen)
  - maxpen penalty when an extension dominates support
  - fallback path when too few anchors
  - HTTP: happy path, validation, precomputed corpus, config bounds
"""

import pytest

from paths.subpath_patterns import (
    SubpathConfig,
    _compute_node_metrics,
    _envelope_ids,
    _extract_anchor_subpaths,
    _identify_anchors,
    _mad_z,
    _median,
    _score_components,
    _strip_envelope_from_paths,
    mine_recurring_subpaths,
)

# =====================================================================
# Fixtures
# =====================================================================

@pytest.fixture
def envelope_corpus():
    """Three paths sharing the same envelope and a shared interior corridor.

    All paths: 0 -> A -> B -> C -> D -> {variant} -> 99
    Shared corridor: A, B, C, D
    """
    nodes = [
        {'ID': '0',  'Duration': 0},
        {'ID': 'A',  'Duration': 5, 'Betweenness': 0.2, 'RiskScore': 0.4},
        {'ID': 'B',  'Duration': 5, 'Betweenness': 0.9, 'RiskScore': 0.5},
        {'ID': 'C',  'Duration': 5, 'Betweenness': 0.9, 'RiskScore': 0.6},
        {'ID': 'D',  'Duration': 5, 'Betweenness': 0.8, 'RiskScore': 0.4,
         'ImportanceScore': 0.9},
        {'ID': 'X1', 'Duration': 1, 'Betweenness': 0.05, 'RiskScore': 0.1},
        {'ID': 'X2', 'Duration': 1, 'Betweenness': 0.05, 'RiskScore': 0.1},
        {'ID': 'X3', 'Duration': 1, 'Betweenness': 0.05, 'RiskScore': 0.1},
        {'ID': '99', 'Duration': 0},
    ]
    links = [
        {'source': '0', 'target': 'A'},
        {'source': 'A', 'target': 'B'},
        {'source': 'B', 'target': 'C'},
        {'source': 'C', 'target': 'D'},
        {'source': 'D', 'target': 'X1'},
        {'source': 'D', 'target': 'X2'},
        {'source': 'D', 'target': 'X3'},
        {'source': 'X1', 'target': '99'},
        {'source': 'X2', 'target': '99'},
        {'source': 'X3', 'target': '99'},
    ]
    return nodes, links


@pytest.fixture
def envelope_paths():
    """Hand-built corpus matching envelope_corpus to make assertions exact."""
    return [
        ['0', 'A', 'B', 'C', 'D', 'X1', '99'],
        ['0', 'A', 'B', 'C', 'D', 'X2', '99'],
        ['0', 'A', 'B', 'C', 'D', 'X3', '99'],
    ]


# =====================================================================
# Pure functions
# =====================================================================

class TestEnvelopeStripping:

    def test_envelope_ids_app_convention(self, envelope_corpus):
        nodes, _ = envelope_corpus
        start, end = _envelope_ids(nodes)
        assert start == '0'
        assert end == '99'

    def test_envelope_ids_no_zero(self):
        nodes = [{'ID': '5'}, {'ID': '7'}, {'ID': '9'}]
        start, end = _envelope_ids(nodes)
        assert start is None
        assert end == '9'

    def test_strip_envelope_removes_start_and_end(self, envelope_paths):
        stripped = _strip_envelope_from_paths(envelope_paths, '0', '99')
        assert all('0' not in p and '99' not in p for p in stripped)
        assert stripped[0] == ['A', 'B', 'C', 'D', 'X1']

    def test_strip_envelope_no_op_when_missing(self, envelope_paths):
        stripped = _strip_envelope_from_paths(envelope_paths, None, None)
        assert stripped == [list(p) for p in envelope_paths]

    def test_strip_envelope_preserves_interior_envelope_ids(self):
        """Round 16 fix: positional strip only.  Envelope IDs that
        appear *interior* to a path must NOT be dropped -- otherwise
        cyclic schedules and precomputed corpora that reuse boundary
        IDs as legitimate interior nodes get their structure
        corrupted (Copilot review #604, round 16:
        subpath_patterns.py:343)."""
        # '0' appears as an interior node here, not just at index 0.
        paths = [['0', 'A', '0', 'B', '99']]
        stripped = _strip_envelope_from_paths(paths, '0', '99')
        # Position-0 '0' and position-(-1) '99' get stripped; interior
        # '0' at index 2 (which is index 1 after the start strip)
        # must remain.
        assert stripped == [['A', '0', 'B']]

    def test_strip_envelope_only_strips_when_endpoint_matches(self):
        """If the path's first/last nodes don't match start_id/end_id,
        nothing is stripped -- a precomputed corpus on a non-canonical
        subgraph keeps every node."""
        paths = [['A', 'B', 'C']]
        stripped = _strip_envelope_from_paths(paths, '0', '99')
        assert stripped == [['A', 'B', 'C']]


class TestMedianMAD:

    def test_median_odd(self):
        assert _median([1.0, 2.0, 3.0]) == 2.0

    def test_median_even(self):
        assert _median([1.0, 2.0, 3.0, 4.0]) == 2.5

    def test_mad_z_uniform_returns_zero(self):
        """When MAD is zero (everyone equal), z must be zero -- avoid NaN."""
        z = _mad_z({'a': 1.0, 'b': 1.0, 'c': 1.0})
        assert all(v == 0.0 for v in z.values())

    def test_mad_z_outlier_high(self):
        """An outlier gets a positive z, even when MAD degenerates to zero
        (4 of 5 tied values).  Falls back to mean+stdev: z('e') = 2.0
        exactly for this configuration."""
        z = _mad_z({'a': 1.0, 'b': 1.0, 'c': 1.0, 'd': 1.0, 'e': 10.0})
        assert z['e'] >= 2.0
        # The four tied values are below the mean (2.8) so they get
        # a small negative z; the test only cares that they aren't
        # mistakenly flagged as positive outliers.
        assert z['a'] < 0.0
        assert z['d'] < 0.0

    def test_mad_z_outlier_with_real_mad(self):
        """When MAD > 0, use the robust MAD path."""
        z = _mad_z({'a': 1.0, 'b': 2.0, 'c': 3.0, 'd': 4.0, 'e': 50.0})
        assert z['e'] > 5.0  # well past anchor threshold


class TestAnchorIdentification:

    def test_anchors_picked_by_betweenness(self, envelope_corpus):
        nodes, links = envelope_corpus
        eligible = {'A', 'B', 'C', 'D', 'X1', 'X2', 'X3'}
        # _compute_node_metrics now expects post-build_dag edge tuples,
        # not the raw links payload (Copilot review #604, tests:144 --
        # the previous test passed raw links and silently skipped the
        # in/out-degree code path).
        dag_edges = {
            (str(ln['source']), str(ln['target'])) for ln in links
        }
        m = _compute_node_metrics(nodes, dag_edges, eligible)
        anchors = _identify_anchors(eligible, m, threshold=2.0)
        # B, C have the highest betweenness (0.9) vs the X-fork (0.05).
        # MAD-based z should make them anchors; D (with ImportanceScore
        # outlier) should also flag.
        assert 'B' in anchors or 'C' in anchors
        # X-fork siblings should not all be anchors (they're equal-low).
        assert {'X1', 'X2', 'X3'}.isdisjoint(anchors)
        # And the in/out-degree path now actually runs: D's out-degree
        # (3 children X1/X2/X3) is the only fan-out outlier, so D
        # should be flagged.
        assert 'D' in anchors


# =====================================================================
# Subpath extraction
# =====================================================================

class TestAnchorPairExtraction:

    def test_extracts_only_anchor_to_anchor(self):
        """If only B and D are anchors, only B..D-bracketed slices emit."""
        paths = [['A', 'B', 'C', 'D', 'E']]
        anchors = {'B': ['betweenness'], 'D': ['importance']}
        cands, _ = _extract_anchor_subpaths(paths, anchors,
                                            lmin=2, lmax=10, max_pairs=100)
        keys = set(cands.keys())
        assert ('B', 'C', 'D') in keys
        # 'A'..'E' would not (A and E aren't anchors)
        assert ('A', 'B', 'C', 'D', 'E') not in keys

    def test_lmin_filter(self):
        paths = [['A', 'B', 'C', 'D']]
        anchors = {'A': ['x'], 'B': ['x'], 'C': ['x'], 'D': ['x']}
        cands, _ = _extract_anchor_subpaths(paths, anchors,
                                            lmin=3, lmax=10, max_pairs=100)
        assert ('A', 'B') not in cands
        assert ('A', 'B', 'C') in cands

    def test_lmax_filter(self):
        paths = [['A', 'B', 'C', 'D', 'E']]
        anchors = {'A': ['x'], 'B': ['x'], 'C': ['x'], 'D': ['x'], 'E': ['x']}
        cands, _ = _extract_anchor_subpaths(paths, anchors,
                                            lmin=2, lmax=3, max_pairs=100)
        # Length-2 and length-3 slices only
        assert all(2 <= len(k) <= 3 for k in cands)

    def test_neighbour_tracking(self):
        """Left / right neighbour counts must populate correctly."""
        paths = [['A', 'B', 'C', 'D', 'E']]
        anchors = {'B': ['x'], 'D': ['x']}
        cands, _ = _extract_anchor_subpaths(paths, anchors,
                                            lmin=2, lmax=10, max_pairs=100)
        rec = cands[('B', 'C', 'D')]
        assert rec.left_neighbour_supp == {'A': 1}
        assert rec.right_neighbour_supp == {'E': 1}

    def test_small_lmax_skips_downsampling(self):
        """Round-7 refinement: dense-anchor paths with small Lmax don't
        trigger downsampling because the per-pair work is already
        bounded by the ``length > lmax`` break (Copilot review #604,
        subpath_patterns.py:467).  Same path that triggers downsampling
        with Lmax=60 must NOT trigger it with Lmax=2."""
        from paths.subpath_patterns import _MAX_ANCHORS_PER_PATH
        n = _MAX_ANCHORS_PER_PATH + 32
        path = [f'N{i}' for i in range(n)]
        anchors = {nid: ['x'] for nid in path}
        # With Lmax=2, predicted = n * 1 << budget; downsample is skipped.
        cands, truncated = _extract_anchor_subpaths(
            [path], anchors, lmin=2, lmax=2, max_pairs=100_000,
        )
        assert truncated is False
        # All n-1 length-2 windows present (no downsampling means
        # full anchor coverage).
        assert len(cands) == n - 1

    def test_record_occurrence_dedups_per_path(self):
        """The same slice appearing twice in one path must count as
        one path-support, not two -- otherwise a precomputed corpus
        with cyclic input could push maxpen above 1.0 and turn
        path-support into occurrence-support (Copilot review #604,
        subpath_patterns.py:357)."""
        from paths.subpath_patterns import _CandidateRecord
        rec = _CandidateRecord(node_ids=('A', 'B'))
        rec.record_occurrence(0, left='X', right='Y')
        rec.record_occurrence(0, left='X', right='Y')  # same path
        rec.record_occurrence(0, left='X', right='Y')  # same path
        rec.record_occurrence(1, left='X', right='Y')  # new path
        assert rec.support_count == 2
        assert rec.left_neighbour_supp == {'X': 2}
        assert rec.right_neighbour_supp == {'Y': 2}

    def test_anchor_downsampling_keeps_endpoints(self):
        """Stride downsampling must include both the first and last
        anchor positions; the previous formula
        ``int(k * n / cap)`` always dropped the last position, so
        every candidate ending at the path's last anchor was
        systematically missing from the result set
        (Copilot review #604, subpath_patterns.py:400).

        Lmax is chosen large enough that
        n_anchors * (lmax-lmin+1) > _PER_PATH_PAIR_BUDGET, otherwise
        the round-7 optimization correctly skips downsampling and
        the test wouldn't be exercising the path it claims."""
        from paths.subpath_patterns import (
            _MAX_ANCHORS_PER_PATH,
            _PER_PATH_PAIR_BUDGET,
        )
        n = _MAX_ANCHORS_PER_PATH * 3  # well over the cap
        # Pick Lmax so predicted pairs comfortably exceed the budget.
        lmax = max(30, _PER_PATH_PAIR_BUDGET // n + 5)
        path = [f'N{i}' for i in range(n)]
        anchors = {nid: ['x'] for nid in path}
        cands, truncated = _extract_anchor_subpaths(
            [path], anchors, lmin=2, lmax=lmax, max_pairs=100_000,
        )
        assert truncated is True
        # Some candidate must end at the path's last anchor (N{n-1}).
        last_id = f'N{n - 1}'
        assert any(k[-1] == last_id for k in cands), (
            f'Anchor downsampling dropped the last position; '
            f'no candidate ends at {last_id}'
        )

    def test_per_path_anchor_cap_keeps_work_bounded(self):
        """A path with > _MAX_ANCHORS_PER_PATH anchors AND total
        predicted work > _PER_PATH_PAIR_BUDGET gets stride-sampled
        so inner-loop work stays bounded.  Refinements over
        round-7's predictor: take the tighter of (n_anchors *
        per_anchor_cap) and (n_anchors * (n_anchors-1) / 2), and
        cap per_anchor_cap by the actual path length so dense-anchor
        paths with permissive Lmax don't get downsampled when the
        exact loop would have stayed cheap (Copilot review #604,
        subpath_patterns.py:564)."""
        from paths.subpath_patterns import (
            _MAX_ANCHORS_PER_PATH,
        )
        # Pick n large enough that the triangular bound alone exceeds
        # the budget: n*(n-1)/2 > _PER_PATH_PAIR_BUDGET requires
        # n > ~sqrt(2 * budget) (~= 101 for budget=5000).
        n = _MAX_ANCHORS_PER_PATH * 2  # 128 -> triangle = 8128
        lmax = n + 5   # per-anchor cap >= triangle, so triangle dominates
        path = [f'N{i}' for i in range(n)]
        anchors = {nid: ['x'] for nid in path}
        cands, truncated = _extract_anchor_subpaths(
            [path], anchors, lmin=2, lmax=lmax, max_pairs=100_000,
        )
        assert truncated is True
        # Pair count is bounded by the per-path cap.
        assert len(cands) < n * lmax

    def test_max_pairs_cap(self):
        """Past the cap, no new candidates are inserted -- existing ones
        keep accruing support; the truncated flag fires."""
        paths = [['A', 'B', 'C', 'D', 'E', 'F', 'G']] * 2
        anchors = {nid: ['x'] for nid in 'ABCDEFG'}
        cands, truncated = _extract_anchor_subpaths(paths, anchors,
                                                    lmin=2, lmax=10,
                                                    max_pairs=3)
        assert len(cands) == 3
        assert truncated is True


# =====================================================================
# Scoring
# =====================================================================

class TestScoring:

    def test_supp_is_path_support(self, envelope_corpus, envelope_paths):
        nodes, links = envelope_corpus
        # B, C, D are the high-betweenness / high-importance anchors;
        # A and the X-fork are not.  The shared corridor (B, C, D) is
        # the only anchor-bracketed subpath of length >=3 the corpus
        # offers, and it must appear in all 3 paths.
        cfg = SubpathConfig(Lmin=3, Lmax=4, anchor_z_threshold=1.0,
                            top_k=20, strip_envelope=True)
        out = mine_recurring_subpaths(nodes, links, paths=envelope_paths,
                                      config=cfg)
        assert out['corpus_size'] == 3
        ids = [tuple(s['node_ids']) for s in out['subpaths']]
        by_ids = {tuple(s['node_ids']): s for s in out['subpaths']}
        assert ('B', 'C', 'D') in ids
        assert by_ids[('B', 'C', 'D')]['support_count'] == 3
        assert by_ids[('B', 'C', 'D')]['components']['supp'] == 1.0

    def test_maxpen_penalises_dominated_subpath(self, envelope_corpus,
                                                envelope_paths):
        """B..C should carry maxpen > 0 because its extension B..C..D
        appears in all the same paths -- ``B..C`` is trivially
        non-maximal.  Asserts unconditionally so a future change that
        drops ('B','C') from the result set fails the test rather than
        silently passing (Copilot review #604, tests:246)."""
        nodes, links = envelope_corpus
        cfg = SubpathConfig(Lmin=2, Lmax=5, anchor_z_threshold=0.5,
                            top_k=50, strip_envelope=True)
        out = mine_recurring_subpaths(nodes, links, paths=envelope_paths,
                                      config=cfg)
        by_ids = {tuple(s['node_ids']): s for s in out['subpaths']}
        assert ('B', 'C') in by_ids, (
            f"('B','C') should be in the candidate set so its maxpen "
            f"can be verified; got {sorted(by_ids.keys())}"
        )
        assert by_ids[('B', 'C')]['components']['maxpen'] > 0.0

    def test_maxpen_uses_support_count_not_corpus_size(self):
        """maxpen must divide by ``rec.support_count`` (containing
        paths) per the PR contract, not ``corpus_size``.  A fully
        dominated low-support candidate should score maxpen=1.0
        regardless of corpus size, otherwise the scoring quietly
        diverges from the documented behaviour (Copilot review #604,
        subpath_patterns.py:622)."""
        from paths.subpath_patterns import (
            _CandidateRecord,
            _NodeMetrics,
        )
        # Candidate appears in 2 paths out of 100; both paths extend
        # it the same way (right neighbour 'X' -> 2 occurrences).
        rec = _CandidateRecord(
            node_ids=('A', 'B'),
            support_count=2,
            right_neighbour_supp={'X': 2},
        )
        metrics = _NodeMetrics()
        comps = _score_components(rec, metrics, corpus_size=100)
        # Pre-fix (corpus-relative): 2/100 = 0.02 -- candidate looks
        # almost-maximal even though every containing path extends it.
        # Post-fix (support-relative): 2/2 = 1.0 -- correctly flagged
        # as fully dominated.
        assert comps['maxpen'] == pytest.approx(1.0)

    def test_score_components_sum(self):
        """Aggregate score equals supp + junc + sal - maxpen."""
        from paths.subpath_patterns import _aggregate
        c = {'supp': 0.5, 'junc': 0.3, 'sal': 0.2, 'maxpen': 0.1}
        assert _aggregate(c) == pytest.approx(0.9)

    def test_sal_is_mean_of_sigma_not_sigma_of_mean(self):
        """``sal`` must be ``mean(sigma(z))``, not ``sigma(mean(z))``.
        Difference matters when one node is an outlier and others are
        negative -- the two formulas disagree, and the chosen one
        (per-node clamp first) is part of the contract.  Pin it
        explicitly so a future refactor can't silently swap them
        (Copilot review #604, tests:317)."""
        from paths.subpath_patterns import (
            _CandidateRecord,
            _NodeMetrics,
            _sigma,
        )
        # Three-node candidate.  z values (after metric extraction):
        #   v1: z_risk=6, z_imp=0, z_overrun=0  -> _node_salience_z = 2.0
        #   v2: z_risk=-3, z_imp=0, z_overrun=0 -> _node_salience_z = -1.0
        #   v3: z_risk=0, z_imp=0, z_overrun=0  -> _node_salience_z = 0.0
        # mean(z) = (2 + -1 + 0)/3 = 0.333  -> sigma(mean) = 0.111
        # mean(sigma) = (sigma(2) + sigma(-1) + sigma(0)) / 3
        #             = (2/3 + 0 + 0) / 3 = 0.222
        metrics = _NodeMetrics(
            z_risk={'v1': 6.0, 'v2': -3.0, 'v3': 0.0},
        )
        rec = _CandidateRecord(
            node_ids=('v1', 'v2', 'v3'), support_count=1,
        )
        comps = _score_components(rec, metrics, corpus_size=1)
        # Implementation must match mean(sigma); reject sigma(mean).
        expected = (_sigma(2.0) + _sigma(-1.0) + _sigma(0.0)) / 3
        assert comps['sal'] == pytest.approx(expected)
        assert comps['sal'] != pytest.approx(_sigma(1.0 / 3))

    def test_mine_resolves_envelope_when_endpoints_omitted(self):
        """``mine_recurring_subpaths(nodes, links)`` without
        enumerate_kwargs must resolve start/end from the schedule
        envelope (CLAUDE.md convention).  Previously this produced
        ``error: 'start or end ID not in schedule'`` because only the
        Flask route resolved defaults (Copilot review #604,
        subpath_patterns.py:629)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        nodes = [
            {'ID': '0', 'Duration': 0},
            {'ID': '1', 'Duration': 5, 'Betweenness': 5.0},
            {'ID': '2', 'Duration': 5, 'Betweenness': 5.0},
            {'ID': '99', 'Duration': 0},
        ]
        links = [
            {'source': '0', 'target': '1'},
            {'source': '1', 'target': '2'},
            {'source': '2', 'target': '99'},
        ]
        out = mine_recurring_subpaths(nodes, links)
        assert 'error' not in out
        assert out['corpus_size'] >= 1

    def test_subpath_config_validates_top_k(self):
        """SubpathConfig.__post_init__ rejects top_k outside [1, 200]
        so direct Python callers fail fast (Copilot review #604,
        subpath_patterns.py:856)."""
        with pytest.raises(ValueError, match='top_k.*must be in'):
            SubpathConfig(top_k=0)
        with pytest.raises(ValueError, match='top_k.*must be in'):
            SubpathConfig(top_k=-1)
        with pytest.raises(ValueError, match='top_k.*must be in'):
            SubpathConfig(top_k=300)

    def test_subpath_config_validates_lmin(self):
        """Lmin must lie in [2, 20000] -- mirrors routes._SUBPATH_BOUNDS
        for the helper API (Copilot review #604)."""
        with pytest.raises(ValueError, match='Lmin.*must be in'):
            SubpathConfig(Lmin=1)
        with pytest.raises(ValueError, match='Lmin.*must be in'):
            SubpathConfig(Lmin=10**9)

    def test_subpath_config_validates_lmax_upper_bound(self):
        """Lmax must lie in [2, 20000] -- direct callers were
        previously able to request unbounded O(n*Lmax) work
        (Copilot review #604, subpath_patterns.py:137)."""
        with pytest.raises(ValueError, match='Lmax.*must be in'):
            SubpathConfig(Lmax=10**9)

    def test_enumerate_kwargs_max_paths_bounded(self, monkeypatch):
        """``enumerate_kwargs.max_paths`` must enforce the same
        1..MAX_PATHS_TO_RETURN bounds the route layer enforces, so
        direct callers can't bypass the endpoint's safety cap
        (Copilot review #604, subpath_patterns.py:887)."""
        from paths import subpath_patterns as sp
        monkeypatch.setattr(sp, 'find_all_paths',
                            lambda *a, **kw: pytest.fail(
                                'find_all_paths should not run for invalid bounds'))
        nodes = [{'ID': 'A'}, {'ID': 'B'}]
        links = [{'source': 'A', 'target': 'B'}]
        with pytest.raises(ValueError, match='max_paths.*must be in'):
            sp.mine_recurring_subpaths(
                nodes, links, enumerate_kwargs={'max_paths': 0})
        with pytest.raises(ValueError, match='max_paths.*must be in'):
            sp.mine_recurring_subpaths(
                nodes, links, enumerate_kwargs={'max_paths': -1})
        with pytest.raises(ValueError, match='max_paths.*must be in'):
            sp.mine_recurring_subpaths(
                nodes, links, enumerate_kwargs={'max_paths': 10**9})

    def test_enumerate_kwargs_coerces_request_shaped_values(self,
                                                            monkeypatch):
        """Direct callers reusing request-shaped kwargs (string values
        like ``'1000'`` / ``'false'``) must get clean coercion or a
        clear ValueError, not silent type-comparison crashes inside
        find_all_paths or accidentally-truthy branch balancing
        (Copilot review #604, subpath_patterns.py:849)."""
        from paths import subpath_patterns as sp
        captured = {}

        def fake_find(*args, **kwargs):
            captured.update(kwargs)
            return {
                'paths': [['A', 'B']], 'durations': [],
                'method': 'exact', 'raw_path_count': 1,
                'start_id': 'A', 'end_id': 'B', 'makespan_hours': 0.0,
            }

        monkeypatch.setattr(sp, 'find_all_paths', fake_find)
        nodes = [{'ID': 'A'}, {'ID': 'B'}]
        links = [{'source': 'A', 'target': 'B'}]
        sp.mine_recurring_subpaths(
            nodes, links,
            enumerate_kwargs={'max_paths': '1000', 'branch_balanced': 'false'},
        )
        assert captured['max_paths'] == 1000
        assert captured['branch_balanced'] is False
        # Bad values raise.
        with pytest.raises(ValueError, match='max_paths.*integer'):
            sp.mine_recurring_subpaths(
                nodes, links,
                enumerate_kwargs={'max_paths': 'oops'},
            )
        with pytest.raises(ValueError, match='branch_balanced.*bool'):
            sp.mine_recurring_subpaths(
                nodes, links,
                enumerate_kwargs={'branch_balanced': 'maybe'},
            )

    def test_subpath_config_rejects_nan_inf(self):
        """Float fields reject NaN/Inf -- downstream comparisons would
        silently fall back to no anchors otherwise (Copilot review
        #604, subpath_patterns.py:117)."""
        with pytest.raises(ValueError, match='must be finite'):
            SubpathConfig(anchor_z_threshold=float('nan'))
        with pytest.raises(ValueError, match='must be finite'):
            SubpathConfig(anchor_z_threshold=float('inf'))
        with pytest.raises(ValueError, match='must be finite'):
            SubpathConfig(fallback_salience_threshold=float('-inf'))

    def test_subpath_config_enforces_route_upper_bounds(self):
        """SubpathConfig now mirrors routes._SUBPATH_BOUNDS upper
        bounds too, not just lower bounds (Copilot review #604,
        subpath_patterns.py:91)."""
        with pytest.raises(ValueError, match='max_anchor_pairs.*must be in'):
            SubpathConfig(max_anchor_pairs=500_000)
        with pytest.raises(ValueError, match='anchor_z_threshold.*must be in'):
            SubpathConfig(anchor_z_threshold=99.0)
        with pytest.raises(ValueError, match='anchor_z_threshold.*must be in'):
            SubpathConfig(anchor_z_threshold=-1.0)
        with pytest.raises(ValueError, match='fallback_min_anchors.*must be in'):
            SubpathConfig(fallback_min_anchors=10_000)

    def test_anchor_requires_metric_to_be_present(self):
        """When ``anchor_z_threshold=0``, nodes-without-the-metric
        must NOT be flagged as anchors for that metric (Copilot
        review #604, subpath_patterns.py:394).  Pre-fix:
        ``lookup.get(nid, 0.0) >= 0.0`` was always True for missing
        metrics, producing bogus anchor reasons."""
        from paths.subpath_patterns import (
            _is_anchor,
            _NodeMetrics,
        )
        # Node 'X' has only betweenness; no risk / importance / overrun.
        m = _NodeMetrics(
            z_betw={'X': 5.0},  # crosses threshold
            # All other lookups omit 'X'
        )
        ok, reasons = _is_anchor('X', m, threshold=0.0)
        assert ok is True
        assert reasons == ['betweenness'], (
            f"missing metrics should not contribute anchor reasons; "
            f"got {reasons}"
        )

    def test_subpath_config_validates_field_types(self):
        """Mistyped numeric fields fail fast with a clear ValueError
        instead of crashing later in arithmetic / comparison with
        TypeError (Copilot review #604, subpath_patterns.py:98)."""
        with pytest.raises(ValueError, match='anchor_z_threshold.*must be'):
            SubpathConfig(anchor_z_threshold='abc')
        with pytest.raises(ValueError, match='Lmin.*must be int'):
            SubpathConfig(Lmin='3')
        with pytest.raises(ValueError, match='strip_envelope.*must be bool'):
            SubpathConfig(strip_envelope=1)

    def test_direct_helper_validates_unknown_id_when_no_links(self):
        """When the schedule has no links the DAG edge set is empty.
        The known-ID check must still run so direct callers can't pass
        precomputed paths referencing unknown IDs (Copilot review
        #604, subpath_patterns.py:853 -- earlier guard
        ``if ... and dag_edges`` skipped the entire validation block)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        nodes = [{'ID': 'A'}, {'ID': 'B'}]
        links = []  # no links
        with pytest.raises(ValueError, match='unknown node ID'):
            mine_recurring_subpaths(
                nodes, links, paths=[['A', 'GHOST']],
                config=SubpathConfig(strip_envelope=False, Lmin=2),
            )

    def test_direct_helper_treats_empty_string_as_missing_endpoint(
            self, monkeypatch):
        """Direct callers reusing request-shaped kwargs may pass
        ``start_id='', end_id=''``.  Helper must treat those as
        missing and fall back to the envelope -- otherwise it forwards
        empty strings to find_all_paths and gets ``start or end ID
        not in schedule``, diverging from the HTTP route which
        already accepts empty strings as omitted (Copilot review
        #604, subpath_patterns.py:743)."""
        from paths import subpath_patterns as sp
        captured = {}

        def fake_find(*args, **kwargs):
            captured.update(kwargs)
            return {
                'paths': [['0', 'A', '99']], 'durations': [],
                'method': 'exact', 'raw_path_count': 1,
                'start_id': '0', 'end_id': '99', 'makespan_hours': 0.0,
            }

        monkeypatch.setattr(sp, 'find_all_paths', fake_find)
        nodes = [
            {'ID': '0', 'Duration': 0},
            {'ID': 'A', 'Duration': 1},
            {'ID': '99', 'Duration': 0},
        ]
        links = [
            {'source': '0', 'target': 'A'},
            {'source': 'A', 'target': '99'},
        ]
        sp.mine_recurring_subpaths(
            nodes, links,
            enumerate_kwargs={'start_id': '', 'end_id': ''},
        )
        # Empty strings should have been resolved to the envelope IDs.
        assert captured['start_id'] == '0'
        assert captured['end_id'] == '99'

    def test_direct_helper_validates_precomputed_paths(self):
        """Direct callers passing malformed precomputed paths must
        get a clear ValueError rather than silently mining impossible
        results (e.g. ``['AB']`` getting split into characters).
        The HTTP route rejects these with 400; the helper now
        matches (Copilot review #604, subpath_patterns.py:763)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        nodes = [
            {'ID': 'A', 'Duration': 1},
            {'ID': 'B', 'Duration': 1},
        ]
        links = [{'source': 'A', 'target': 'B'}]
        # Non-sequence path entry (string is iterable but rejected
        # explicitly so it doesn't split into chars).
        with pytest.raises(ValueError, match='must be a sequence'):
            mine_recurring_subpaths(nodes, links, paths=['AB'])
        # Tuple is now accepted per the public Sequence[Sequence[str]]
        # annotation -- regression for round 13.
        try:
            mine_recurring_subpaths(
                nodes, links, paths=[('A', 'B')],
                config=SubpathConfig(strip_envelope=False, Lmin=2),
            )
        except ValueError as e:
            if 'must be a sequence' in str(e):
                pytest.fail(f'tuple-form path was rejected: {e}')
        # Single-node path.
        with pytest.raises(ValueError, match='at least 2'):
            mine_recurring_subpaths(nodes, links, paths=[['A']])
        # Unknown node ID.
        with pytest.raises(ValueError, match='unknown node ID'):
            mine_recurring_subpaths(nodes, links, paths=[['A', 'GHOST']])
        # Invalid DAG hop.
        with pytest.raises(ValueError, match='not a valid DAG edge'):
            mine_recurring_subpaths(nodes, links, paths=[['B', 'A']])

    def test_direct_helper_normalises_int_path_ids(self):
        """Direct callers passing integer path IDs must get the same
        result as string IDs.  Without the on-ingest str() the rest
        of the pipeline (eligible_ids, dag_edges) used strings while
        the corpus used ints, silently producing empty results
        (Copilot review #604, subpath_patterns.py:751)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        nodes = [
            {'ID': '0', 'Duration': 0},
            {'ID': '1', 'Duration': 1, 'Betweenness': 5.0},
            {'ID': '2', 'Duration': 1, 'Betweenness': 5.0},
            {'ID': '99', 'Duration': 0},
        ]
        links = [
            {'source': '0', 'target': '1'},
            {'source': '1', 'target': '2'},
            {'source': '2', 'target': '99'},
        ]
        out_int = mine_recurring_subpaths(
            nodes, links, paths=[[0, 1, 2, 99]],
            config=SubpathConfig(strip_envelope=True, Lmin=2, Lmax=3,
                                 anchor_z_threshold=0.5),
        )
        out_str = mine_recurring_subpaths(
            nodes, links, paths=[['0', '1', '2', '99']],
            config=SubpathConfig(strip_envelope=True, Lmin=2, Lmax=3,
                                 anchor_z_threshold=0.5),
        )
        # Same result regardless of input ID type.
        assert out_int['corpus_size'] == out_str['corpus_size']
        assert out_int['anchor_count'] == out_str['anchor_count']
        assert len(out_int['subpaths']) == len(out_str['subpaths'])

    def test_direct_helper_rejects_lmax_lt_lmin(self):
        """Direct Python callers must get a hard ValueError when Lmax<Lmin
        rather than silently producing an empty/fallback result.  HTTP
        callers already get a 400 from the route layer; the helper
        should match that contract (Copilot review #604,
        subpath_patterns.py:366)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        with pytest.raises(ValueError, match='Lmax.*must be >= Lmin'):
            mine_recurring_subpaths(
                [{'ID': 'A'}, {'ID': 'B'}],
                [{'source': 'A', 'target': 'B'}],
                config=SubpathConfig(Lmin=5, Lmax=3),
            )

    def test_envelope_fallback_uses_predless_succless(self):
        """Non-conforming schedules (no '0' anchor, no numeric IDs)
        must still resolve via the predecessor-less / successor-less
        fallback so the Python helper agrees with the HTTP route on
        the same input (Copilot review #604, subpath_patterns.py:657)."""
        from paths.subpath_patterns import _envelope_ids
        nodes = [{'ID': 'alpha'}, {'ID': 'beta'}, {'ID': 'gamma'}]
        links = [
            {'source': 'alpha', 'target': 'beta'},
            {'source': 'beta', 'target': 'gamma'},
        ]
        # No '0' and no numeric IDs -- raw envelope rule yields (None, None).
        assert _envelope_ids(nodes) == (None, None)
        # With links, fallback identifies alpha as predless, gamma as succless.
        start, end = _envelope_ids(nodes, links)
        assert start == 'alpha'
        assert end == 'gamma'

    def test_degree_zscore_uses_dag_not_raw_links(self):
        """On cyclic schedules build_dag drops back-edges; the request
        must still complete cleanly with the DAG-pruned adjacency in
        play (Copilot review #604, subpath_patterns.py:276)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        nodes = [
            {'ID': 'A', 'Duration': 1},
            {'ID': 'B', 'Duration': 1},
            {'ID': 'C', 'Duration': 1},
        ]
        links = [
            {'source': 'A', 'target': 'B'},
            {'source': 'B', 'target': 'C'},
            {'source': 'C', 'target': 'A'},   # back-edge dropped by build_dag
        ]
        out = mine_recurring_subpaths(
            nodes, links, paths=[['A', 'B', 'C']],
            config=SubpathConfig(strip_envelope=False, Lmin=2, Lmax=3,
                                 anchor_z_threshold=0.5, top_k=5),
        )
        assert 'error' not in out

    def test_fallback_lmax_clamp_surfaces_in_response(self):
        """When fallback fires AND Lmax > _FALLBACK_LMAX_CAP, the
        response must reflect the effective clamp via
        ``config_resolved.Lmax`` and ``truncated=True``.  Otherwise
        clients believe the full requested search width was used
        (Copilot review #604, subpath_patterns.py:522)."""
        from paths.subpath_patterns import (
            _FALLBACK_LMAX_CAP,
            mine_recurring_subpaths,
        )
        # Force fallback path: 0 anchors via uniform metrics.
        nodes = [
            {'ID': str(i), 'Duration': 1, 'RiskScore': 0.5}
            for i in range(20)
        ]
        links = [{'source': str(i), 'target': str(i + 1)} for i in range(19)]
        paths = [[str(i) for i in range(20)]]
        cfg = SubpathConfig(
            Lmin=3, Lmax=_FALLBACK_LMAX_CAP * 5, top_k=5,
            anchor_z_threshold=10.0,  # nothing realistic crosses
            strip_envelope=False,
            fallback_min_anchors=0,
            fallback_salience_threshold=-9.0,
        )
        out = mine_recurring_subpaths(nodes, links, paths=paths, config=cfg)
        assert out['fallback_used'] is True
        assert out['truncated'] is True
        assert out['config_resolved']['Lmax'] == _FALLBACK_LMAX_CAP

    def test_fallback_lmax_capped(self):
        """The fallback's window-scan must not iterate at the user's
        full Lmax on huge schedules.  Pin _FALLBACK_LMAX_CAP so a
        future removal fails the suite (Copilot review #604,
        routes.py:388)."""
        import paths.subpath_patterns as sp
        assert sp._FALLBACK_LMAX_CAP <= 200, (
            f"_FALLBACK_LMAX_CAP={sp._FALLBACK_LMAX_CAP} is too large; "
            f"the fallback is O(n * Lmax) per path and must stay bounded "
            f"on schedules where the user's Lmax is in the thousands."
        )

    def test_empty_corpus_resolves_lmax_in_response(self):
        """The empty-corpus fast path must surface ``Lmax`` as an int,
        not None.  Otherwise clients see ``Lmax: null`` only on empty
        results -- inconsistent shape forces special-casing (Copilot
        review #604, subpath_patterns.py:645)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        out = mine_recurring_subpaths(
            [{'ID': 'X', 'Duration': 1}], [],
            paths=[],   # explicit empty corpus
        )
        assert out['corpus_size'] == 0
        assert out['config_resolved']['Lmax'] is not None
        assert isinstance(out['config_resolved']['Lmax'], int)


# =====================================================================
# Fallback path
# =====================================================================

class TestFallback:

    def test_fallback_used_when_anchors_split_across_paths(self):
        """Two anchors exist (>= fallback_min_anchors=2) but on different
        paths.  Anchor-pair extraction yields zero candidates because
        no single path contains both anchors.  The fallback must still
        fire instead of returning empty (Copilot review #604,
        subpath_patterns.py:599).

        Pre-fix: ``fallback_used = len(anchors) < fallback_min_anchors``
        evaluated to False (2 anchors >= floor of 2), anchor-pair
        extraction returned nothing, and the endpoint silently produced
        no subpaths.  Post-fix: anchor-pair runs first; if it yields
        nothing the fallback fires regardless of total anchor count.
        """
        # Long paths with transit nodes so anchor-pair candidates
        # (A..Z, A..R) exceed Lmax and aren't emitted.  All eligible
        # nodes appear in the corpus so z-scores see a 9-node sample
        # that pushes Z, R betweenness outliers above the threshold.
        nodes = [
            {'ID': 'A', 'Duration': 1, 'Betweenness': 0.0},
            {'ID': 'N0', 'Duration': 1, 'Betweenness': 0.0},
            {'ID': 'N1', 'Duration': 1, 'Betweenness': 0.0},
            {'ID': 'N2', 'Duration': 1, 'Betweenness': 0.0},
            {'ID': 'N3', 'Duration': 1, 'Betweenness': 0.0},
            {'ID': 'N4', 'Duration': 1, 'Betweenness': 0.0},
            {'ID': 'N5', 'Duration': 1, 'Betweenness': 0.0},
            {'ID': 'Z', 'Duration': 1, 'Betweenness': 50.0},
            {'ID': 'R', 'Duration': 1, 'Betweenness': 50.0},
        ]
        links = [
            {'source': 'A', 'target': 'N0'},
            {'source': 'N0', 'target': 'N1'},
            {'source': 'N1', 'target': 'N2'},
            {'source': 'N2', 'target': 'Z'},
            {'source': 'A', 'target': 'N3'},
            {'source': 'N3', 'target': 'N4'},
            {'source': 'N4', 'target': 'N5'},
            {'source': 'N5', 'target': 'R'},
        ]
        paths = [
            ['A', 'N0', 'N1', 'N2', 'Z'],
            ['A', 'N3', 'N4', 'N5', 'R'],
        ]
        cfg = SubpathConfig(Lmin=2, Lmax=3, anchor_z_threshold=1.5,
                            top_k=5, strip_envelope=False,
                            fallback_min_anchors=2,
                            fallback_salience_threshold=0.5)
        out = mine_recurring_subpaths(nodes, links, paths=paths, config=cfg)
        # Anchors flagged via betweenness on Z and R; they're on
        # different paths so anchor-pair finds nothing and the
        # fallback must fire.
        assert out['anchor_count'] >= 2
        assert out['fallback_used'] is True

    def test_fallback_used_when_too_few_anchors(self):
        """A perfectly uniform corpus has no MAD outliers -> fallback path."""
        nodes = [
            {'ID': str(i), 'Duration': 5, 'RiskScore': 0.5,
             'Betweenness': 0.5, 'ImportanceScore': 0.5}
            for i in range(6)
        ]
        links = [{'source': str(i), 'target': str(i + 1)} for i in range(5)]
        paths = [[str(i) for i in range(6)]]
        cfg = SubpathConfig(Lmin=3, Lmax=4, anchor_z_threshold=2.0,
                            top_k=5, strip_envelope=False,
                            fallback_min_anchors=4,
                            fallback_salience_threshold=-1.0)
        out = mine_recurring_subpaths(nodes, links, paths=paths, config=cfg)
        assert out['fallback_used'] is True


# =====================================================================
# HTTP endpoint
# =====================================================================

class TestEndpoint:

    def test_health_lists_endpoint(self, client):
        r = client.get('/paths/health')
        assert r.status_code == 200
        body = r.get_json()
        assert '/paths/recurring-subpaths' in body['endpoints']

    def test_happy_path_with_precomputed_paths(self, client, envelope_corpus,
                                               envelope_paths):
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'paths': envelope_paths,
            'config': {'Lmin': 3, 'Lmax': 4, 'anchor_z_threshold': 0.5,
                       'top_k': 5},
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['corpus_size'] == 3
        assert body['cache_hit'] is False
        assert isinstance(body['subpaths'], list)
        assert body['config_resolved']['Lmax'] == 4
        if body['subpaths']:
            top = body['subpaths'][0]
            assert 'components' in top
            assert 'endpoint_anchors' in top
            assert 'support_count' in top

    def test_enumerates_when_paths_omitted(self, client, envelope_corpus):
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {'Lmin': 3, 'top_k': 5},
        })
        assert r.status_code == 200
        body = r.get_json()
        # Three parallel paths through X1/X2/X3 give 3 enumerations.
        assert body['corpus_size'] == 3

    def test_validation_missing_nodes(self, client):
        r = client.post('/paths/recurring-subpaths', json={'links': []})
        assert r.status_code == 400

    def test_validation_paths_must_be_list(self, client, envelope_corpus):
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'paths': 'oops',
        })
        assert r.status_code == 400

    def test_validation_path_entry_must_be_list(self, client, envelope_corpus):
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'paths': [['A', 'B'], 'oops'],
        })
        assert r.status_code == 400

    def test_validation_lmax_bounds(self, client, envelope_corpus):
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {'Lmax': 5_000_000},
        })
        assert r.status_code == 400

    def test_route_rejects_bool_for_max_paths(self, client, envelope_corpus):
        """``max_paths`` is at the top level of the request body (not
        inside ``config``) and goes through its own _coerce_int call.
        That path also needs the bool/float guards (Copilot review
        #604, routes.py:956)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'max_paths': True,
        })
        assert r.status_code == 400
        assert 'max_paths' in r.get_json()['error']

    def test_route_rejects_float_for_max_paths(self, client, envelope_corpus):
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'max_paths': 100.5,
        })
        assert r.status_code == 400
        assert 'max_paths' in r.get_json()['error']

    def test_route_rejects_paths_plus_enumeration_kwargs(
        self, client, envelope_corpus, envelope_paths,
    ):
        """``paths`` and enumeration kwargs (start_id / end_id /
        max_paths / branch_balanced) are mutually exclusive per the
        endpoint contract.  Silently ignoring the enumeration kwargs
        whenever ``paths`` was present let stale request payloads
        mine the wrong corpus with a 200 response (Copilot review
        #604, round 16: routes.py:990)."""
        nodes, links = envelope_corpus
        for kw in (
            {'start_id': '0'},
            {'end_id': '99'},
            {'max_paths': 100},
            {'branch_balanced': True},
        ):
            r = client.post('/paths/recurring-subpaths', json={
                'nodes': nodes, 'links': links,
                'paths': envelope_paths,
                **kw,
            })
            assert r.status_code == 400
            err = r.get_json()['error']
            assert 'mutually exclusive' in err
            for k in kw:
                assert k in err

    def test_fallback_lmax_cap_respects_lmin(self, client, envelope_corpus):
        """Round 16 fix: when the caller's Lmin exceeds the internal
        fallback cap (``_FALLBACK_LMAX_CAP=100``), the fallback was
        silently producing zero candidates and reporting
        ``Lmax < Lmin`` in ``config_resolved``.  effective_lmax is
        now floored at lmin, keeping the advertised
        ``Lmin: [2, MAX_NODES]`` range valid (Copilot review #604,
        round 16: subpath_patterns.py:665)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {
                'Lmin': 150,                     # > _FALLBACK_LMAX_CAP
                'Lmax': 200,
                # Force the fallback branch -- no anchors will exist
                # at this z threshold for the trivial fixture.
                'anchor_z_threshold': 10.0,
                'fallback_min_anchors': 1000,
            },
        })
        assert r.status_code == 200
        body = r.get_json()
        # config_resolved Lmax must never be smaller than Lmin even
        # when the fallback fires.
        assert body['config_resolved']['Lmax'] >= body['config_resolved']['Lmin']

    def test_strip_envelope_handles_mixed_boundary_corpus(self):
        """Per-path strip handles a precomputed corpus where different
        paths have different start/end IDs.  Round 9's strip-from-
        first-path approach would silently strip wrong nodes from
        non-canonical paths (Copilot review #604, subpath_patterns:964)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        nodes = [{'ID': c, 'Duration': 1, 'Betweenness': 5.0}
                 for c in ['A', 'B', 'C', 'D', 'E', 'F']]
        links = [
            {'source': 'A', 'target': 'B'}, {'source': 'B', 'target': 'C'},
            {'source': 'C', 'target': 'D'}, {'source': 'D', 'target': 'E'},
            {'source': 'E', 'target': 'F'},
        ]
        # Two paths with different boundaries.
        paths = [['A', 'B', 'C', 'D'], ['C', 'D', 'E', 'F']]
        out = mine_recurring_subpaths(
            nodes, links, paths=paths,
            config=SubpathConfig(strip_envelope=True, Lmin=2, Lmax=3,
                                 anchor_z_threshold=0.5),
        )
        # Each path's own first/last get stripped: path 1 leaves [B,C],
        # path 2 leaves [D,E].  A, D-as-end-of-path-1, C-as-start-of-
        # path-2, F should NOT appear in mined subpaths because they
        # were boundaries of their own path.
        for sp in out['subpaths']:
            ids = sp['node_ids']
            assert 'A' not in ids, f"path-1 start 'A' leaked: {ids}"
            assert 'F' not in ids, f"path-2 end 'F' leaked: {ids}"

    def test_truncated_propagates_corpus_truncated_signal(self, monkeypatch):
        """Round 12 moves the truncation signal into find_all_paths
        itself (``corpus_truncated`` field).  mine_recurring_subpaths
        must propagate it to the response truncated flag verbatim --
        works for both exact-DFS-capped and longest-first cases.

        Note: this loses round 11's exhaustive-coincidence
        false-positive guarantee.  ``corpus_truncated=True`` from
        find_all_paths covers both 'capped' and 'exactly at cap by
        coincidence' for exact DFS; the latter is rare enough that
        the lossy approximation is acceptable, and ``truncated``
        is documented as a may-be-approximate hint, not a
        sample-vs-exhaustive certificate."""
        from paths import subpath_patterns as sp
        def fake_find_truncated(*args, **kwargs):
            mp = kwargs.get('max_paths', 10000)
            return {
                'paths': [['A', 'B']] * mp, 'durations': [],
                'method': 'exact', 'raw_path_count': mp,
                'corpus_truncated': True,
                'start_id': 'A', 'end_id': 'B', 'makespan_hours': 0.0,
            }
        monkeypatch.setattr(sp, 'find_all_paths', fake_find_truncated)
        out = sp.mine_recurring_subpaths(
            [{'ID': 'A'}, {'ID': 'B'}],
            [{'source': 'A', 'target': 'B'}],
            enumerate_kwargs={'max_paths': 3},
            config=SubpathConfig(strip_envelope=False, Lmin=2,
                                 anchor_z_threshold=0.0,
                                 fallback_min_anchors=0),
        )
        assert out['truncated'] is True

    def test_truncated_false_when_corpus_not_truncated(self, monkeypatch):
        """Exhaustive enumeration that happens to return ``max_paths``
        paths but reports ``corpus_truncated=False`` should NOT be
        flagged truncated (no mining-side cap fires either).  Pin
        the propagate-don't-second-guess contract."""
        from paths import subpath_patterns as sp
        def fake_find_exhaustive(*args, **kwargs):
            mp = kwargs.get('max_paths', 10000)
            return {
                'paths': [['A', 'B']] * mp, 'durations': [],
                'method': 'exact', 'raw_path_count': mp,
                'corpus_truncated': False,
                'start_id': 'A', 'end_id': 'B', 'makespan_hours': 0.0,
            }
        monkeypatch.setattr(sp, 'find_all_paths', fake_find_exhaustive)
        out = sp.mine_recurring_subpaths(
            [{'ID': 'A'}, {'ID': 'B'}],
            [{'source': 'A', 'target': 'B'}],
            enumerate_kwargs={'max_paths': 3},
            config=SubpathConfig(strip_envelope=False, Lmin=2,
                                 anchor_z_threshold=0.0,
                                 fallback_min_anchors=0),
        )
        assert out['truncated'] is False

    def test_supplied_dag_state_failure_propagates(self):
        """A direct caller supplying a stale / malformed
        ``dag_state`` should see the resulting AttributeError (or
        similar) propagate -- not be silently swallowed into a
        best-effort raw-link fallback that mines over wrong adjacency
        AND skips path validation (Copilot review #604,
        subpath_patterns:1029)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        nodes = [{'ID': 'A'}, {'ID': 'B'}]
        links = [{'source': 'A', 'target': 'B'}]
        # ``dag_state`` is intentionally malformed: a plain string
        # instead of a real DAGState object, so the iteration over
        # ``dag_state.n`` will raise.
        bad_dag_state = 'not a dag state'
        bad_id_to_idx = {'A': 0, 'B': 1}
        with pytest.raises(Exception):
            mine_recurring_subpaths(
                nodes, links, paths=[['A', 'B']],
                dag_state=bad_dag_state, id_to_idx=bad_id_to_idx,
                config=SubpathConfig(strip_envelope=False, Lmin=2),
            )

    def test_truncated_reflects_enumeration_sampling(self, monkeypatch):
        """When find_all_paths uses the longest-first heuristic OR
        returns a corpus capped at max_paths, the engine is sampling
        the full critical/near-critical set.  ``truncated`` must
        reflect that so callers know support counts are sampling-
        dependent (Copilot review #604, subpath_patterns:929)."""
        from paths import subpath_patterns as sp
        # Stub find_all_paths to surface the new ``corpus_truncated``
        # signal directly (round 12 moved the canonical signal into
        # find_all_paths itself).
        def fake_find_lf(*args, **kwargs):
            return {
                'paths': [['A', 'B']], 'durations': [],
                'method': 'longest_first', 'raw_path_count': 1,
                'corpus_truncated': True,
                'start_id': 'A', 'end_id': 'B', 'makespan_hours': 0.0,
            }
        monkeypatch.setattr(sp, 'find_all_paths', fake_find_lf)
        out = sp.mine_recurring_subpaths(
            [{'ID': 'A'}, {'ID': 'B'}],
            [{'source': 'A', 'target': 'B'}],
            config=SubpathConfig(strip_envelope=False, Lmin=2,
                                 anchor_z_threshold=0.0,
                                 fallback_min_anchors=0),
        )
        assert out['truncated'] is True

    def test_strip_envelope_uses_corpus_boundaries_not_schedule_envelope(self):
        """When the caller scopes enumeration to a subgraph (custom
        ``start_id`` / ``end_id``), envelope-strip must remove THOSE
        boundary IDs, not the schedule envelope ('0' / max-numeric).
        Otherwise the user-selected boundaries stay in every path and
        dominate support counts with trivial slices (Copilot review
        #604, subpath_patterns.py:951)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        # Schedule with envelope 0..99 plus a subgraph of interest A..D.
        nodes = [
            {'ID': '0', 'Duration': 0},
            {'ID': 'A', 'Duration': 1, 'Betweenness': 5.0},
            {'ID': 'B', 'Duration': 1, 'Betweenness': 5.0},
            {'ID': 'C', 'Duration': 1, 'Betweenness': 5.0},
            {'ID': 'D', 'Duration': 1, 'Betweenness': 5.0},
            {'ID': '99', 'Duration': 0},
        ]
        links = [
            {'source': '0', 'target': 'A'},
            {'source': 'A', 'target': 'B'},
            {'source': 'B', 'target': 'C'},
            {'source': 'C', 'target': 'D'},
            {'source': 'D', 'target': '99'},
        ]
        # Subgraph scope: enumerate from A to D, not 0..99.
        out = mine_recurring_subpaths(
            nodes, links,
            enumerate_kwargs={'start_id': 'A', 'end_id': 'D'},
            config=SubpathConfig(strip_envelope=True, Lmin=2, Lmax=3,
                                 anchor_z_threshold=0.5),
        )
        # The corpus paths are [A,B,C,D].  After strip we should
        # remove A and D (the subgraph boundaries), leaving [B, C]
        # in eligible_ids.  A and D should NOT appear as anchors in
        # the returned subpaths because they were stripped.
        for sp in out['subpaths']:
            ids = sp['node_ids']
            assert 'A' not in ids, (
                f"subgraph start 'A' leaked into mined subpath {ids} -- "
                f"strip-envelope should have removed the corpus boundary"
            )
            assert 'D' not in ids, (
                f"subgraph end 'D' leaked into mined subpath {ids}"
            )

    def test_helper_validates_paths_even_with_dag_state(self):
        """Passing ``dag_state`` is purely a build-cost optimisation;
        it must NOT suppress per-hop or shape validation.  Direct
        callers reusing the optimisation hook with malformed paths
        must still get ValueError -- the route does the same
        validation upstream but the helper must not depend on that
        contract for safety (Copilot review #604, subpath_patterns.py:1004
        + 941)."""
        from paths.subpath_patterns import mine_recurring_subpaths
        from solver.dag import build_dag
        nodes = [{'ID': 'A', 'Duration': 1}, {'ID': 'B', 'Duration': 1}]
        links = [{'source': 'A', 'target': 'B'}]
        dag_state, id_to_idx = build_dag(nodes, links, default_duration=0.0)
        cfg = SubpathConfig(strip_envelope=False, Lmin=2)
        # 1. Per-hop validation runs (unknown node ID).
        with pytest.raises(ValueError, match='unknown node ID'):
            mine_recurring_subpaths(
                nodes, links, paths=[['A', 'GHOST']],
                dag_state=dag_state, id_to_idx=id_to_idx, config=cfg,
            )
        # 2. Shape validation runs: bare string ``'AB'`` would otherwise
        # split into ['A', 'B'] characters under str() normalisation.
        with pytest.raises(ValueError, match='must be a sequence'):
            mine_recurring_subpaths(
                nodes, links, paths=['AB'],
                dag_state=dag_state, id_to_idx=id_to_idx, config=cfg,
            )
        # 3. Single-node path also rejected.
        with pytest.raises(ValueError, match='at least 2'):
            mine_recurring_subpaths(
                nodes, links, paths=[['A']],
                dag_state=dag_state, id_to_idx=id_to_idx, config=cfg,
            )

    def test_route_rejects_float_for_int_config_field(self, client,
                                                      envelope_corpus):
        """JSON floats for integer fields must 400.  Without the
        reject, ``_coerce_int``'s ``int(1.9) == 1`` would silently
        narrow the search window from the documented integer
        contract (Copilot review #604, routes.py:323/896)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {'top_k': 1.9},
        })
        assert r.status_code == 400
        assert 'float' in r.get_json()['error']
        # Same path for the inline Lmax coerce.
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {'Lmax': 2.9},
        })
        assert r.status_code == 400
        assert 'Lmax' in r.get_json()['error']
        assert 'float' in r.get_json()['error']

    def test_route_rejects_bool_for_lmax(self, client, envelope_corpus):
        """``config.Lmax`` goes through a separate _coerce_int call from
        the rest of SubpathConfig (because of its Optional[int]
        annotation).  That path also needs the bool-reject so callers
        get a clean type error instead of the misleading
        ``must be >= 2`` from the bounds check (Copilot review #604,
        routes.py:886)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {'Lmax': True},
        })
        assert r.status_code == 400
        assert 'Lmax' in r.get_json()['error']
        assert 'integer' in r.get_json()['error']

    def test_helper_handles_build_dag_failure_gracefully(self,
                                                         monkeypatch):
        """When ``build_dag`` raises and the caller passed precomputed
        paths, the helper must not crash with UnboundLocalError trying
        to read ``idx_to_id`` / ``dag_state.n`` for per-hop validation
        (Copilot review #604, subpath_patterns.py:919).  The fallback
        path falls back to raw-link adjacency for degree counting; the
        per-hop validation block correctly skips because the DAG
        wasn't built."""
        from paths import subpath_patterns as sp

        def fake_build_dag(*args, **kwargs):
            raise RuntimeError('synthetic build_dag failure')

        monkeypatch.setattr(sp, 'build_dag', fake_build_dag)
        nodes = [{'ID': 'A', 'Duration': 1}, {'ID': 'B', 'Duration': 1}]
        links = [{'source': 'A', 'target': 'B'}]
        # Should return a result dict rather than UnboundLocalError.
        out = sp.mine_recurring_subpaths(
            nodes, links, paths=[['A', 'B']],
            config=SubpathConfig(strip_envelope=False, Lmin=2, Lmax=2,
                                 anchor_z_threshold=0.5),
        )
        assert isinstance(out, dict)
        assert 'subpaths' in out

    def test_route_rejects_bool_for_int_config_field(self, client,
                                                     envelope_corpus):
        """JSON ``{"top_k": true}`` must 400 instead of being silently
        coerced to ``top_k=1``.  Without the fix, _coerce_int's
        ``int(True)=1`` would let bools slip past type validation
        (Copilot review #604, routes:883)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {'top_k': True},
        })
        assert r.status_code == 400
        assert 'must be an integer' in r.get_json()['error']

    def test_route_rejects_bool_for_float_config_field(self, client,
                                                      envelope_corpus):
        """Same as above for float fields."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {'anchor_z_threshold': False},
        })
        assert r.status_code == 400
        assert 'must be a number' in r.get_json()['error']

    def test_lmax_above_old_1000_cap_now_accepted(self, client,
                                                  envelope_corpus):
        """The previous Lmax<=1000 bound contradicted the PR's
        no-fixed-cap claim.  Bound now tracks MAX_NODES (the schedule
        size limit) so large projects aren't blocked
        (Copilot review #604, routes.py:850)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {'Lmin': 2, 'Lmax': 5000},
        })
        assert r.status_code == 200

    def test_precomputed_path_back_edge_rejected(self, client):
        """When the schedule contains a cycle, build_dag drops the
        back-edge.  A precomputed path using that dropped edge must
        be rejected -- otherwise the endpoint mines subpaths from a
        path the engine itself would never enumerate
        (Copilot review #604, routes.py:890)."""
        # A->B->C->A is cyclic; build_dag drops one back-edge.
        nodes = [
            {'ID': 'A', 'Duration': 1},
            {'ID': 'B', 'Duration': 1},
            {'ID': 'C', 'Duration': 1},
        ]
        links = [
            {'source': 'A', 'target': 'B'},
            {'source': 'B', 'target': 'C'},
            {'source': 'C', 'target': 'A'},   # back-edge
        ]
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'paths': [['C', 'A', 'B']],   # uses the broken back-edge
        })
        assert r.status_code == 400
        assert 'not a valid DAG edge' in r.get_json()['error']

    def test_validation_config_must_be_object(self, client, envelope_corpus):
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'config': 'oops',
        })
        assert r.status_code == 400

    def test_options_preflight(self, client):
        r = client.open('/paths/recurring-subpaths', method='OPTIONS')
        assert r.status_code == 200

    def test_empty_paths_list_is_not_re_enumerated(self, client,
                                                   envelope_corpus):
        """An explicit ``"paths": []`` must return an empty result --
        it cannot collapse to "paths omitted, re-enumerate" semantics
        (Copilot review #604, routes.py:912)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'paths': [],
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['corpus_size'] == 0
        assert body['subpaths'] == []
        assert body['anchor_count'] == 0

    def test_empty_paths_skips_dag_build(self, client, monkeypatch,
                                         envelope_corpus):
        """An empty ``paths: []`` is a no-op; the route must not pay
        the build_dag cost for it (Copilot review #604, routes:997)."""
        import paths.routes as pr
        build_calls = []
        original_build = pr.build_dag

        def spy_build(*args, **kwargs):
            build_calls.append(True)
            return original_build(*args, **kwargs)

        monkeypatch.setattr(pr, 'build_dag', spy_build)
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'paths': [],
        })
        assert r.status_code == 200
        # Route's per-request build_dag should not have run.
        # mine_recurring_subpaths ALSO short-circuits on empty paths
        # before its own build_dag call, so total = 0.
        assert build_calls == []

    def test_precomputed_path_unknown_node_rejected(self, client,
                                                    envelope_corpus):
        """Precomputed paths referencing unknown node IDs must 400 --
        otherwise the endpoint would return "recurring" subpaths the
        schedule doesn't actually support (Copilot review #604,
        routes.py:871)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'paths': [['A', 'B', 'GHOST']],
        })
        assert r.status_code == 400
        assert 'unknown node ID' in r.get_json()['error']

    def test_precomputed_path_invalid_hop_rejected(self, client,
                                                   envelope_corpus):
        """Precomputed paths with hops not present in ``links`` (or
        in the post-cycle-break DAG) must 400.  Catches paths that
        name only known nodes but stitch them in an order the
        schedule's DAG doesn't permit."""
        nodes, links = envelope_corpus
        # A and D both exist, but A->D is not a link in the schedule.
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'paths': [['A', 'D']],
        })
        assert r.status_code == 400
        assert 'not a valid DAG edge' in r.get_json()['error']

    def test_empty_precomputed_path_rejected(self, client, envelope_corpus):
        """An empty path entry ``[]`` would dilute support fractions.
        Reject up front rather than counting it as a corpus member
        (Copilot review #604, routes.py:893)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'paths': [['A', 'B'], []],
        })
        assert r.status_code == 400
        assert 'at least 2 node IDs' in r.get_json()['error']

    def test_branch_balanced_kwarg_reaches_enumerator(self, monkeypatch,
                                                      envelope_corpus):
        """``branch_balanced`` must reach ``find_all_paths`` rather than
        being silently dropped.  Spy on the enumerator at the
        unit-function level."""
        from paths import subpath_patterns as sp
        captured = {}

        def fake_find(*args, **kwargs):
            captured.update(kwargs)
            return {
                'paths': [['A', 'B']], 'durations': [],
                'method': 'exact', 'raw_path_count': 1,
                'start_id': 'A', 'end_id': 'B', 'makespan_hours': 0.0,
            }

        monkeypatch.setattr(sp, 'find_all_paths', fake_find)
        sp.mine_recurring_subpaths(
            [{'ID': 'A'}, {'ID': 'B'}],
            [{'source': 'A', 'target': 'B'}],
            enumerate_kwargs={'branch_balanced': True},
        )
        assert captured.get('branch_balanced') is True
        assert captured.get('include_durations') is False

        captured.clear()
        sp.mine_recurring_subpaths(
            [{'ID': 'A'}, {'ID': 'B'}],
            [{'source': 'A', 'target': 'B'}],
            enumerate_kwargs={'branch_balanced': False},
        )
        assert captured.get('branch_balanced') is False

    def test_malformed_path_entry_rejected_before_cache_key(
            self, client, envelope_corpus):
        """A non-list entry in ``paths`` must 400 before cache-key
        normalisation runs, otherwise round-8's ``str(x) for x in p``
        crashes (``paths: [123]``) or aliases to a cached valid
        request (``paths: ['AB']`` -> hashes the same as
        ``[['A','B']]``) (Copilot review #604, routes:950)."""
        nodes, links = envelope_corpus
        # Non-list entry.
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'paths': [123],
        })
        assert r.status_code == 400
        assert 'must be a list of node IDs' in r.get_json()['error']
        # String (iterable but not list) entry must also be rejected
        # rather than aliasing to a valid hop sequence.
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'paths': ['AB'],
        })
        assert r.status_code == 400

    def test_cache_hit_short_circuits(self, client, monkeypatch,
                                      envelope_corpus):
        """Force the cache layer to return a stored payload and verify
        the route short-circuits with cache_hit=True instead of
        re-running mining.  Protects the in-place ``cached['cache_hit']
        = True`` mutation and the early-return branch (Copilot review
        #604, routes.py:942)."""
        import paths.routes as pr
        canned = {
            'subpaths': [{'node_ids': ['A', 'B'], 'score': 0.5,
                          'support_count': 1, 'corpus_size': 1,
                          'endpoint_anchors': {'v1': [], 'vL': []},
                          'sample_paths': [0]}],
            'corpus_size': 1, 'anchor_count': 0,
            'fallback_used': False, 'truncated': False,
            'config_resolved': {'Lmin': 3, 'Lmax': 4},
        }

        def fake_cache():
            return (lambda key: dict(canned)), (lambda key, val: None)

        monkeypatch.setattr(pr, '_cache', fake_cache)
        # Also block any actual mining work to prove the route really
        # short-circuited rather than computing the same result.
        monkeypatch.setattr(
            pr, 'mine_recurring_subpaths',
            lambda *a, **kw: pytest.fail(
                'mine_recurring_subpaths should not run on cache hit'),
        )
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
        })
        assert r.status_code == 200
        body = r.get_json()
        assert body['cache_hit'] is True
        assert body['corpus_size'] == 1

    def test_cache_key_normalises_id_alias(self, client, monkeypatch):
        """Cache key must collapse the lowercase ``id`` alias into
        the canonical ``ID`` key so ``{'id': 1}`` and ``{'ID': '1'}``
        share a cache entry.  Otherwise one of the two request shapes
        always misses the cache and re-runs full mining (Copilot
        review #604, routes.py:952)."""
        import paths.routes as pr
        captured_keys = []

        def fake_cache():
            def _get(k):
                captured_keys.append(k)
                return None
            return _get, lambda k, v: None

        monkeypatch.setattr(pr, '_cache', fake_cache)
        # Same logical schedule, different ID-key spelling.
        r1 = client.post('/paths/recurring-subpaths', json={
            'nodes': [{'id': 'A', 'Duration': 1},
                      {'id': 'B', 'Duration': 1}],
            'links': [{'source': 'A', 'target': 'B'}],
            'paths': [['A', 'B']],
        })
        r2 = client.post('/paths/recurring-subpaths', json={
            'nodes': [{'ID': 'A', 'Duration': 1},
                      {'ID': 'B', 'Duration': 1}],
            'links': [{'source': 'A', 'target': 'B'}],
            'paths': [['A', 'B']],
        })
        assert r1.status_code == 200 and r2.status_code == 200
        assert captured_keys[0] == captured_keys[1], (
            'lowercase id-keyed and ID-keyed payloads should share a cache key'
        )

    def test_cache_key_normalises_node_id_types(self, client, monkeypatch):
        """Equivalent requests using int IDs vs string IDs should hash
        to the same cache key so they share a cache entry.  Spy on the
        cache get/set to verify both calls hit the same key (Copilot
        review #604, routes.py:934)."""
        import paths.routes as pr
        captured_keys = []

        def fake_cache():
            def _get(k):
                captured_keys.append(('get', k))
                return None
            def _set(k, v):
                captured_keys.append(('set', k))
            return _get, _set

        monkeypatch.setattr(pr, '_cache', fake_cache)
        nodes_int = [{'ID': 1, 'Duration': 1}, {'ID': 2, 'Duration': 1}]
        links_int = [{'source': 1, 'target': 2}]
        r1 = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes_int, 'links': links_int,
            'paths': [[1, 2]],
        })
        nodes_str = [{'ID': '1', 'Duration': 1}, {'ID': '2', 'Duration': 1}]
        links_str = [{'source': '1', 'target': '2'}]
        r2 = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes_str, 'links': links_str,
            'paths': [['1', '2']],
        })
        assert r1.status_code == 200
        assert r2.status_code == 200
        get_keys = [k for op, k in captured_keys if op == 'get']
        assert len(get_keys) == 2
        assert get_keys[0] == get_keys[1], (
            'int-ID and string-ID payloads should share a cache key'
        )

    def test_branch_balanced_flows_through_route_json(self, client,
                                                     monkeypatch,
                                                     envelope_corpus):
        """A route-level test: send ``branch_balanced`` as a JSON field
        on the actual HTTP request and verify it reaches find_all_paths
        with the right value.  Catches route-layer regressions
        (mis-coercion, wrong default, silent drop) that the unit-level
        spy on mine_recurring_subpaths can't see (Copilot review #604,
        tests:718)."""
        from paths import subpath_patterns as sp
        captured = {}

        def fake_find(*args, **kwargs):
            captured.update(kwargs)
            return {
                'paths': [['0', 'A', '99']], 'durations': [],
                'method': 'exact', 'raw_path_count': 1,
                'start_id': '0', 'end_id': '99', 'makespan_hours': 0.0,
            }

        monkeypatch.setattr(sp, 'find_all_paths', fake_find)
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'branch_balanced': True,
        })
        assert r.status_code == 200
        assert captured.get('branch_balanced') is True

        captured.clear()
        # Default omitted -> should be False (the route's documented
        # unbiased-corpus default).
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
        })
        assert r.status_code == 200
        assert captured.get('branch_balanced') is False

    def test_lmax_lt_lmin_rejected(self, client, envelope_corpus):
        """Lmax<Lmin must 400 instead of being silently widened
        (Copilot review #604, subpath_patterns.py:325)."""
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links,
            'config': {'Lmin': 5, 'Lmax': 3},
        })
        assert r.status_code == 400
        body = r.get_json()
        assert 'Lmax' in body['error'] and 'Lmin' in body['error']

    def test_default_lmax_is_derived(self, client, envelope_corpus,
                                     envelope_paths):
        nodes, links = envelope_corpus
        r = client.post('/paths/recurring-subpaths', json={
            'nodes': nodes, 'links': links, 'paths': envelope_paths,
            'config': {'Lmin': 2, 'anchor_z_threshold': 0.5},
        })
        assert r.status_code == 200
        body = r.get_json()
        # Stripped paths are length 5 (e.g. A,B,C,D,X1).  Median = 5,
        # derived Lmax = max(Lmin=2, 5//2) = 2.
        assert body['config_resolved']['Lmax'] == 2
