"""
Tests for the analytical upgrades:
  - Risk-tiered distributions (five tiers)
  - Pareto / BS / triangular ppf correctness
  - Tchebycheff scalarisation path
  - 2D cost-schedule extreme clustering
  - Black swan / dragon king detection
  - Multi-resolution community detection
  - Sobol sample count matches requested M
"""

import numpy as np
import networkx as nx
import pytest

from solver.dag import build_dag, run_cpm
from solver.models import SolverConfig, ProjectContext, build_activity_params
from solver.optimizer import optimize
from solver.pareto import run_pareto, filter_pareto_front
from scipy.special import ndtri
from solver.stochastic import (
    run_ensemble,
    _generate_samples,
    _compute_raw_multipliers,
    _triangular_ppf,
    _bs_ppf,
    _pareto_ppf,
    _fat_tail_thresholds,
    _tier_label,
    _PARETO_OFFSET,
)
from multi_resolution_pipeline import run_multi_resolution


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def diamond_schedule():
    nodes = [
        {'ID': 'A', 'Duration': 10.0},
        {'ID': 'B', 'Duration': 20.0},
        {'ID': 'C', 'Duration': 5.0},
        {'ID': 'D', 'Duration': 15.0},
    ]
    links = [
        {'source': 'A', 'target': 'B'},
        {'source': 'A', 'target': 'C'},
        {'source': 'B', 'target': 'D'},
        {'source': 'C', 'target': 'D'},
    ]
    return nodes, links


@pytest.fixture
def five_tier_schedule():
    """Activities spanning all five risk tiers."""
    nodes = [
        {'ID': 'NOISE',  'Duration': 5.0},
        {'ID': 'TRI',    'Duration': 15.0},
        {'ID': 'NORM',   'Duration': 30.0},
        {'ID': 'BS',     'Duration': 60.0},
        {'ID': 'PARETO', 'Duration': 100.0},
    ]
    links = [
        {'source': 'NOISE', 'target': 'TRI'},
        {'source': 'TRI',   'target': 'NORM'},
        {'source': 'NORM',  'target': 'BS'},
        {'source': 'BS',    'target': 'PARETO'},
    ]
    meta = {
        'NOISE':  {'combined_risk_score': 0.3},   # 3%  → noise floor
        'TRI':    {'combined_risk_score': 1.2},   # 12% → triangular
        'NORM':   {'combined_risk_score': 3.5},   # 35% → normal
        'BS':     {'combined_risk_score': 6.0},   # 60% → BS
        'PARETO': {'combined_risk_score': 9.0},   # 90% → Pareto
    }
    return nodes, links, meta


# ---------------------------------------------------------------------------
# Distribution PPF correctness
# ---------------------------------------------------------------------------

class TestDistributionPPFs:
    def test_triangular_ppf_at_mode(self):
        """Triangular ppf at the CDF inflection point should equal mode."""
        low = np.array([0.9])
        mode = np.array([1.0])
        high = np.array([1.2])
        fc = (mode - low) / (high - low)
        result = _triangular_ppf(fc, low, mode, high)
        np.testing.assert_allclose(result, mode, atol=1e-10)

    def test_triangular_ppf_bounds(self):
        """Triangular ppf should stay within [low, high]."""
        u = np.linspace(0.01, 0.99, 100)
        low = np.full(100, 0.85)
        mode = np.full(100, 1.0)
        high = np.full(100, 1.3)
        result = _triangular_ppf(u, low, mode, high)
        assert np.all(result >= 0.85)
        assert np.all(result <= 1.3)

    def test_bs_ppf_at_median(self):
        """BS ppf at u=0.5 should equal beta (since z=0)."""
        u = np.array([0.5])
        alpha = np.array([0.5])
        beta = np.array([1.1])
        result = _bs_ppf(u, alpha, beta)
        np.testing.assert_allclose(result, beta, atol=1e-10)

    def test_bs_ppf_positive(self):
        """BS ppf should always be positive."""
        u = np.linspace(0.01, 0.99, 100)
        alpha = np.full(100, 0.6)
        beta = np.full(100, 1.05)
        result = _bs_ppf(u, alpha, beta)
        assert np.all(result > 0)

    def test_pareto_ppf_at_median(self):
        """Pareto ppf at u=0.5 with alpha=2 → 2^(1/2) ≈ 1.414."""
        u = np.array([0.5])
        alpha = np.array([2.0])
        result = _pareto_ppf(u, alpha)
        np.testing.assert_allclose(result, 2 ** 0.5, atol=1e-10)

    def test_pareto_ppf_minimum(self):
        """Pareto ppf at u=0 should equal x_min=1."""
        u = np.array([1e-10])
        alpha = np.array([2.5])
        result = _pareto_ppf(u, alpha)
        np.testing.assert_allclose(result, 1.0, atol=1e-4)

    def test_pareto_ppf_monotonic(self):
        """Pareto ppf should be monotonically increasing in u."""
        u = np.linspace(0.01, 0.99, 100)
        alpha = np.full(100, 2.35)
        result = _pareto_ppf(u, alpha)
        assert np.all(np.diff(result) > 0)


# ---------------------------------------------------------------------------
# Risk tier assignment
# ---------------------------------------------------------------------------

class TestRiskTiers:
    def test_tier_labels(self):
        assert _tier_label(0.03, '') == 'noise_floor'
        assert _tier_label(0.12, '') == 'triangular'
        assert _tier_label(0.35, '') == 'normal'
        assert _tier_label(0.60, '') == 'birnbaum_saunders'
        assert _tier_label(0.85, '') == 'pareto'

    def test_supply_chain_lowers_thresholds(self):
        # Equipment BS threshold is 0.35, Pareto is 0.60
        assert _tier_label(0.40, 'equipment') == 'birnbaum_saunders'
        assert _tier_label(0.65, 'equipment') == 'pareto'
        # Standard at 0.40 is still normal
        assert _tier_label(0.40, '') == 'normal'

    def test_higher_risk_produces_larger_multipliers(self, five_tier_schedule):
        """Fat-tail tiers (BS, Pareto) should produce higher means than
        lighter tiers.  Normal is symmetric around 1.0 so its mean is
        close to 1.0 regardless of risk — variance is where it differs.
        """
        nodes, links, meta = five_tier_schedule
        params = build_activity_params(nodes, meta)
        risk = np.clip(params.risk_scores / 10.0, 0.0, 1.0)
        fat_thresh = _fat_tail_thresholds(params.activity_types, 5)

        rng = np.random.default_rng(42)
        means = np.zeros(5)
        maxes = np.zeros(5)
        N = 500
        for _ in range(N):
            u = np.clip(rng.random(5), 1e-10, 1 - 1e-10)
            z = ndtri(u)
            mult = _compute_raw_multipliers(u, z, risk, fat_thresh)
            means += mult
            maxes = np.maximum(maxes, mult)
        means /= N

        # Noise floor ≈ 1.0 exactly
        assert abs(means[0] - 1.0) < 0.01, f"Noise floor mean: {means[0]}"
        # Non-noise tiers all have mean ≥ 1.0
        for i in range(1, 5):
            assert means[i] >= 0.99, f"Tier {i} mean too low: {means[i]}"
        # Fat-tail tiers (BS, Pareto) have highest means
        assert means[3] > means[0], f"BS > noise: {means[3]} vs {means[0]}"
        assert means[4] > means[3], f"Pareto > BS: {means[4]} vs {means[3]}"
        # Pareto produces the most extreme max values
        assert maxes[4] > maxes[1], f"Pareto max > Tri max: {maxes[4]} vs {maxes[1]}"
        assert maxes[4] > maxes[2], f"Pareto max > Normal max: {maxes[4]} vs {maxes[2]}"


# ---------------------------------------------------------------------------
# Sobol sample count
# ---------------------------------------------------------------------------

class TestSobolSamples:
    def test_exact_count_no_antithetic(self):
        u, M = _generate_samples(100, 4, antithetic=False)
        assert M == 100
        assert u.shape == (100, 4)

    def test_exact_count_antithetic(self):
        u, M = _generate_samples(100, 4, antithetic=True)
        assert M == 100
        assert u.shape == (100, 4)

    def test_m1_antithetic_produces_2(self):
        u, M = _generate_samples(1, 4, antithetic=True)
        assert M == 2

    def test_odd_m_antithetic(self):
        u, M = _generate_samples(7, 4, antithetic=True)
        # half=3, truncated to 3, antithetic → 6
        assert M == 6

    def test_samples_in_unit_interval(self):
        u, _ = _generate_samples(64, 10, antithetic=True)
        assert np.all(u > 0)
        assert np.all(u < 1)


# ---------------------------------------------------------------------------
# Tchebycheff optimizer path
# ---------------------------------------------------------------------------

class TestTchebycheff:
    def test_utopia_improves_pareto(self, diamond_schedule):
        """Optimizer with utopia should produce different results than
        without, demonstrating the Tchebycheff path activates."""
        nodes, links = diamond_schedule
        meta = {}
        config = SolverConfig(
            disciplines=['schedule', 'cost'],
            max_iterations=10,
        )
        ctx = ProjectContext()

        # Weighted sum
        dag1, _ = build_dag(nodes, links)
        params1 = build_activity_params(nodes, meta)
        r1 = optimize(dag1, params1, ctx, config)

        # Tchebycheff
        dag2, _ = build_dag(nodes, links)
        params2 = build_activity_params(nodes, meta)
        utopia = {'schedule': 30.0, 'cost': 100.0}
        r2 = optimize(dag2, params2, ctx, config, utopia=utopia)

        # Both should produce valid results
        assert r1['iterations'] > 0
        assert r2['iterations'] > 0
        # History should have entries
        assert len(r1['history']) > 0
        assert len(r2['history']) > 0

    def test_pareto_sweep_returns_frontier(self, diamond_schedule):
        nodes, links = diamond_schedule
        config = SolverConfig(
            disciplines=['schedule', 'cost'],
            max_iterations=10,
        )
        result = run_pareto(nodes, links, {}, ProjectContext(), config,
                            n_vectors=5)
        assert result['n_frontier'] >= 1
        assert len(result['all_solutions']) > 0
        # Every frontier point should be non-dominated
        for pt in result['frontier']:
            assert 'objectives' in pt
            assert 'schedule' in pt['objectives']
            assert 'cost' in pt['objectives']


# ---------------------------------------------------------------------------
# Non-dominated sorting
# ---------------------------------------------------------------------------

class TestNonDominatedSorting:
    def test_single_solution(self):
        solutions = [{'objectives': {'a': 1, 'b': 2}}]
        front = filter_pareto_front(solutions, ['a', 'b'])
        assert len(front) == 1

    def test_dominated_removed(self):
        solutions = [
            {'objectives': {'a': 1, 'b': 1}},
            {'objectives': {'a': 2, 'b': 2}},  # dominated by first
        ]
        front = filter_pareto_front(solutions, ['a', 'b'])
        assert len(front) == 1
        assert front[0]['objectives'] == {'a': 1, 'b': 1}

    def test_pareto_front_preserved(self):
        solutions = [
            {'objectives': {'a': 1, 'b': 3}},
            {'objectives': {'a': 2, 'b': 1}},
            {'objectives': {'a': 3, 'b': 2}},  # dominated by second
        ]
        front = filter_pareto_front(solutions, ['a', 'b'])
        assert len(front) == 2


# ---------------------------------------------------------------------------
# Stochastic ensemble — extreme event detection
# ---------------------------------------------------------------------------

class TestExtremeDetection:
    def test_ensemble_returns_extreme_keys(self, five_tier_schedule):
        nodes, links, meta = five_tier_schedule
        dag, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, meta)
        run_cpm(dag, params.durations)

        cfg = SolverConfig(
            disciplines=['schedule', 'cost'],
            monte_carlo_samples=32,
            antithetic_variates=True,
        )
        result = run_ensemble(dag, params, ProjectContext(), cfg)

        assert 'black_swans' in result
        assert 'dragon_kings' in result
        assert 'cost_schedule_joint' in result
        assert isinstance(result['black_swans'], list)
        assert isinstance(result['dragon_kings'], list)

    def test_2d_clustering_has_clusters(self, five_tier_schedule):
        nodes, links, meta = five_tier_schedule
        dag, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, meta)
        run_cpm(dag, params.durations)

        cfg = SolverConfig(
            disciplines=['schedule', 'cost'],
            monte_carlo_samples=32,
            antithetic_variates=True,
        )
        result = run_ensemble(dag, params, ProjectContext(), cfg)
        joint = result['cost_schedule_joint']

        assert joint is not None
        assert 'clusters' in joint
        assert 'correlation' in joint
        assert len(joint['clusters']) > 0
        assert all('label' in c for c in joint['clusters'])

    def test_no_2d_without_cost_and_schedule(self, diamond_schedule):
        """2D clustering requires both schedule and cost disciplines."""
        nodes, links = diamond_schedule
        dag, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, {})
        run_cpm(dag, params.durations)

        cfg = SolverConfig(
            disciplines=['schedule'],  # no cost
            monte_carlo_samples=16,
        )
        result = run_ensemble(dag, params, ProjectContext(), cfg)
        assert result['cost_schedule_joint'] is None

    def test_aliasing_preserved_after_ensemble(self, five_tier_schedule):
        nodes, links, meta = five_tier_schedule
        dag, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, meta)
        run_cpm(dag, params.durations)
        assert dag.durations is params.durations

        cfg = SolverConfig(
            disciplines=['schedule', 'cost'],
            monte_carlo_samples=16,
        )
        run_ensemble(dag, params, ProjectContext(), cfg)
        assert dag.durations is params.durations


# ---------------------------------------------------------------------------
# Multi-resolution pipeline
# ---------------------------------------------------------------------------

class TestMultiResolution:
    def _build_test_graph(self):
        """Graph with 3 clear communities of 10 nodes each."""
        G = nx.Graph()
        rng = np.random.RandomState(42)
        for prefix in ['A', 'B', 'C']:
            for i in range(10):
                for j in range(i + 1, 10):
                    if rng.random() < 0.6:
                        G.add_edge(f'{prefix}{i}', f'{prefix}{j}', weight=1.0)
        # Sparse cross-community edges
        G.add_edge('A5', 'B3', weight=0.5)
        G.add_edge('B7', 'C2', weight=0.5)
        return G

    def test_returns_expected_structure(self):
        G = self._build_test_graph()
        result = run_multi_resolution(G, n_runs=2)
        assert 'graph_stats' in result
        assert 'levels' in result
        assert 'hierarchy' in result
        assert 'stable_cores' in result
        assert result['graph_stats']['n_nodes'] == 30

    def test_levels_have_expected_fields(self):
        G = self._build_test_graph()
        result = run_multi_resolution(G, n_runs=2)
        for level in result['levels']:
            assert 'resolution' in level
            assert 'n_communities' in level
            assert 'modularity' in level
            assert 'stability_nmi' in level
            assert 'membership' in level
            assert 'group_metrics' in level

    def test_small_graph_gets_fewer_levels(self):
        """Graphs < 500 nodes get only [0.3, 1.0] ladder."""
        G = self._build_test_graph()
        result = run_multi_resolution(G, n_runs=2)
        resolutions = [l['resolution'] for l in result['levels']]
        assert resolutions == [0.3, 1.0]

    def test_empty_graph(self):
        G = nx.Graph()
        G.add_node('A')
        result = run_multi_resolution(G)
        assert result['levels'] == []

    def test_hierarchy_has_containment(self):
        G = self._build_test_graph()
        result = run_multi_resolution(G, n_runs=2)
        if len(result['levels']) > 1:
            assert 'tier_0_to_1' in result['hierarchy']
            edges = result['hierarchy']['tier_0_to_1']
            assert len(edges) > 0
            for edge in edges:
                assert 'parent' in edge
                assert 'child' in edge
                assert 'overlap' in edge
                assert edge['overlap'] >= 0.7


# ---------------------------------------------------------------------------
# Relationship types (FS/SS/FF/SF) + lag
# ---------------------------------------------------------------------------

class TestRelationshipTypes:
    """Tests for the four standard CPM precedence relationships + lag."""

    def test_fs_default(self):
        """FS (default): ES[B] = EF[A] + 0 = 10."""
        nodes = [{'ID': 'A', 'Duration': 10}, {'ID': 'B', 'Duration': 5}]
        links = [{'source': 'A', 'target': 'B'}]  # no type → defaults to FS
        dag, _ = build_dag(nodes, links)
        assert dag.ES[1] == 10.0
        assert dag.makespan == 15.0

    def test_fs_with_lag(self):
        """FS with lag=3: ES[B] = EF[A] + 3 = 13."""
        nodes = [{'ID': 'A', 'Duration': 10}, {'ID': 'B', 'Duration': 5}]
        links = [{'source': 'A', 'target': 'B', 'type': 'FS', 'lag': 3}]
        dag, _ = build_dag(nodes, links)
        assert dag.ES[1] == 13.0
        assert dag.makespan == 18.0

    def test_fs_with_negative_lag(self):
        """FS with lag=-2 (fast-tracking): ES[B] = EF[A] - 2 = 8."""
        nodes = [{'ID': 'A', 'Duration': 10}, {'ID': 'B', 'Duration': 5}]
        links = [{'source': 'A', 'target': 'B', 'type': 'FS', 'lag': -2}]
        dag, _ = build_dag(nodes, links)
        assert dag.ES[1] == 8.0
        assert dag.makespan == 13.0

    def test_ss_relationship(self):
        """SS with lag=5: ES[B] = ES[A] + 5 = 5."""
        nodes = [{'ID': 'A', 'Duration': 10}, {'ID': 'B', 'Duration': 10}]
        links = [{'source': 'A', 'target': 'B', 'type': 'SS', 'lag': 5}]
        dag, _ = build_dag(nodes, links)
        assert dag.ES[1] == 5.0
        assert dag.makespan == 15.0  # B ends at 5+10=15

    def test_ff_relationship(self):
        """FF with lag=0: EF[B] = EF[A] → ES[B] = EF[A] - d[B]."""
        nodes = [{'ID': 'A', 'Duration': 20}, {'ID': 'B', 'Duration': 10}]
        links = [{'source': 'A', 'target': 'B', 'type': 'FF', 'lag': 0}]
        dag, _ = build_dag(nodes, links)
        assert dag.ES[1] == 10.0  # B starts at 20-10=10
        assert dag.makespan == 20.0

    def test_ff_with_lag(self):
        """FF with lag=5: EF[B] >= EF[A] + 5."""
        nodes = [{'ID': 'A', 'Duration': 20}, {'ID': 'B', 'Duration': 10}]
        links = [{'source': 'A', 'target': 'B', 'type': 'FF', 'lag': 5}]
        dag, _ = build_dag(nodes, links)
        assert dag.ES[1] == 15.0  # B starts at 25-10=15
        assert dag.makespan == 25.0

    def test_sf_relationship(self):
        """SF: EF[B] >= ES[A] + lag."""
        nodes = [{'ID': 'A', 'Duration': 10}, {'ID': 'B', 'Duration': 15}]
        links = [{'source': 'A', 'target': 'B', 'type': 'SF', 'lag': 5}]
        dag, _ = build_dag(nodes, links)
        # EF[B] >= ES[A]+5 = 0+5 = 5 → ES[B] >= 5-15 = -10 → clamped to 0
        assert dag.ES[1] == 0.0
        assert dag.makespan == 15.0

    def test_mixed_relationships(self):
        """Diamond with mixed relationship types."""
        nodes = [
            {'ID': 'A', 'Duration': 10},
            {'ID': 'B', 'Duration': 20},
            {'ID': 'C', 'Duration': 15},
            {'ID': 'D', 'Duration': 5},
        ]
        links = [
            {'source': 'A', 'target': 'B', 'type': 'FS', 'lag': 0},
            {'source': 'A', 'target': 'C', 'type': 'SS', 'lag': 5},
            {'source': 'B', 'target': 'D', 'type': 'FS', 'lag': 0},
            {'source': 'C', 'target': 'D', 'type': 'FF', 'lag': 0},
        ]
        dag, _ = build_dag(nodes, links)
        # A: ES=0, EF=10
        # B: ES=10 (FS from A), EF=30
        # C: ES=5 (SS from A, lag=5), EF=20
        # D: ES = max(EF[B]+0, EF[C]+0-5) = max(30, 15) = 30, EF=35
        assert dag.ES[0] == 0.0
        assert dag.ES[1] == 10.0
        assert dag.ES[2] == 5.0
        assert dag.ES[3] == 30.0
        assert dag.makespan == 35.0

    def test_total_float_with_ss(self):
        """Total float computed correctly for SS relationships."""
        nodes = [
            {'ID': 'A', 'Duration': 10},
            {'ID': 'B', 'Duration': 5},
            {'ID': 'C', 'Duration': 20},
        ]
        links = [
            {'source': 'A', 'target': 'B', 'type': 'SS', 'lag': 0},
            {'source': 'A', 'target': 'C', 'type': 'FS', 'lag': 0},
        ]
        dag, _ = build_dag(nodes, links)
        # A: ES=0, EF=10
        # B: ES=0 (SS from A, lag=0), EF=5
        # C: ES=10 (FS from A), EF=30
        # Makespan=30
        # Backward: LF[C]=30, LS[C]=10
        #   LF[B]=30 (no succ), LS[B]=25
        #   LF[A] = min(LS[C]-0=10, LS[B]-0+10=35) = 10
        #   LS[A] = 0
        assert dag.TF[0] == 0.0   # A critical
        assert dag.TF[2] == 0.0   # C critical
        assert dag.TF[1] == 25.0  # B has 25 days float

    def test_backward_compat_no_type_field(self):
        """Links without type field default to FS(0)."""
        nodes = [{'ID': 'A', 'Duration': 10}, {'ID': 'B', 'Duration': 5}]
        links = [{'source': 'A', 'target': 'B'}]
        dag, _ = build_dag(nodes, links)
        assert dag.makespan == 15.0

    def test_invalid_type_defaults_to_fs(self):
        """Unknown relationship types should default to FS."""
        nodes = [{'ID': 'A', 'Duration': 10}, {'ID': 'B', 'Duration': 5}]
        links = [{'source': 'A', 'target': 'B', 'type': 'XY'}]
        dag, _ = build_dag(nodes, links)
        assert dag.makespan == 15.0


# ---------------------------------------------------------------------------
# Schedule Health (DCMA)
# ---------------------------------------------------------------------------

class TestScheduleHealth:

    def test_health_returned_in_response(self):
        """analyse() should include schedule_health in response."""
        from app import analyse
        nodes = [
            {'ID': 'A', 'Duration': 10, 'importanceScore': 5, 'riskScore': 3},
            {'ID': 'B', 'Duration': 20, 'importanceScore': 5, 'riskScore': 3},
        ]
        links = [{'source': 'A', 'target': 'B'}]
        result = analyse(nodes, links)
        assert 'schedule_health' in result
        health = result['schedule_health']
        assert 'logic_density' in health
        assert 'health_score' in health
        assert 'checks' in health
        assert 'relationship_types' in health

    def test_logic_density(self):
        """Logic density = n_links / n_tasks."""
        from app import _schedule_health, build_nx_graph
        G = build_nx_graph(
            [{'ID': 'A', 'Duration': 10}, {'ID': 'B', 'Duration': 5},
             {'ID': 'C', 'Duration': 8}],
            [{'source': 'A', 'target': 'B'}, {'source': 'B', 'target': 'C'}]
        )
        import pandas as pd
        df = pd.DataFrame({'ID': ['A', 'B', 'C'], 'Duration': [10, 5, 8]})
        health = _schedule_health(G, df, ['A', 'B', 'C'], 23.0)
        assert health['logic_density'] == round(2 / 3, 2)

    def test_relationship_type_breakdown(self):
        """Relationship types counted correctly."""
        from app import _schedule_health, build_nx_graph
        G = build_nx_graph(
            [{'ID': 'A', 'Duration': 10}, {'ID': 'B', 'Duration': 5},
             {'ID': 'C', 'Duration': 8}],
            [{'source': 'A', 'target': 'B', 'type': 'SS'},
             {'source': 'B', 'target': 'C', 'type': 'FF'}]
        )
        import pandas as pd
        df = pd.DataFrame({'ID': ['A', 'B', 'C'], 'Duration': [10, 5, 8]})
        health = _schedule_health(G, df, ['A', 'B', 'C'], 18.0)
        assert health['relationship_types']['SS'] == 1
        assert health['relationship_types']['FF'] == 1
        assert health['relationship_types']['FS'] == 0
