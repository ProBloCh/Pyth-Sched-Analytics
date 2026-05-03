"""
Unit tests for the CADJ-P solver modules.

Covers: dag (CPM correctness), objectives, adjoints (gradient correctness),
models (config construction), optimizer (convergence), and analysis.
"""

import numpy as np
import pytest

from solver.models import (
    SolverConfig, ProjectContext, ActivityParams,
    build_activity_params, PHASE_WEIGHTS,
)
from solver.dag import build_dag, run_cpm, get_critical_path_indices
from solver.objectives import (
    schedule_objective, cost_objective, risk_objective,
    quality_objective, resource_objective, compute_objectives,
)
from solver.adjoints import (
    schedule_adj_dur, cost_adj_dur, cost_adj_res,
    quality_adj_dur, resource_adj_dur, compute_gradients,
)
from solver.optimizer import optimize
from solver.stochastic import run_ensemble
from solver.analysis import (
    analyze_conflicts_and_synergies, rank_interventions, compute_analysis,
)
from solver.core import run_sensitivity, run_optimize


# =====================================================================
# DAG / CPM
# =====================================================================

class TestDAG:

    def test_linear_cpm(self, linear_schedule):
        """A(10) -> B(20) -> C(5): makespan = 35, all critical."""
        nodes, links = linear_schedule
        state, id_map = build_dag(nodes, links)

        assert state.n == 3
        assert state.makespan == 35.0

        # All on critical path
        assert state.critical_mask[id_map['A']]
        assert state.critical_mask[id_map['B']]
        assert state.critical_mask[id_map['C']]

        # Total float = 0 for all
        np.testing.assert_allclose(state.TF, 0.0, atol=1e-9)

    def test_diamond_cpm(self, diamond_schedule):
        """Diamond: critical path A->B->D->E = 42, C has float = 7."""
        nodes, links = diamond_schedule
        state, id_map = build_dag(nodes, links)

        assert state.makespan == 42.0

        # Critical path activities
        assert state.critical_mask[id_map['A']]
        assert state.critical_mask[id_map['B']]
        assert state.critical_mask[id_map['D']]
        assert state.critical_mask[id_map['E']]

        # C is NOT critical
        assert not state.critical_mask[id_map['C']]

        # C has total float = 42 - 35 = 7
        assert abs(state.TF[id_map['C']] - 7.0) < 1e-9

    def test_diamond_early_late_times(self, diamond_schedule):
        """Verify ES/EF/LS/LF for the diamond schedule."""
        nodes, links = diamond_schedule
        state, id_map = build_dag(nodes, links)

        # A: ES=0, EF=10
        assert state.ES[id_map['A']] == 0.0
        assert state.EF[id_map['A']] == 10.0

        # B: ES=10, EF=25
        assert state.ES[id_map['B']] == 10.0
        assert state.EF[id_map['B']] == 25.0

        # C: ES=10, EF=18 (not critical, LS=17, LF=25)
        assert state.ES[id_map['C']] == 10.0
        assert state.EF[id_map['C']] == 18.0
        assert state.LS[id_map['C']] == 17.0
        assert state.LF[id_map['C']] == 25.0

        # D: ES=25, EF=37
        assert state.ES[id_map['D']] == 25.0
        assert state.EF[id_map['D']] == 37.0

        # E: ES=37, EF=42
        assert state.ES[id_map['E']] == 37.0
        assert state.EF[id_map['E']] == 42.0

    def test_single_node(self, single_node):
        """Single node: makespan = duration, trivially critical."""
        nodes, links = single_node
        state, _ = build_dag(nodes, links)

        assert state.n == 1
        assert state.makespan == 7.0
        assert state.critical_mask[0]

    def test_empty_graph(self):
        """Empty input: no crash, zero makespan."""
        state, _ = build_dag([], [])
        assert state.n == 0
        assert state.makespan == 0.0

    def test_recompute_cpm(self, linear_schedule):
        """run_cpm with new durations updates state correctly."""
        nodes, links = linear_schedule
        state, _ = build_dag(nodes, links)

        assert state.makespan == 35.0

        # Shorten B from 20 to 10
        new_dur = state.durations.copy()
        new_dur[1] = 10.0
        run_cpm(state, new_dur)

        assert state.makespan == 25.0  # 10 + 10 + 5

    def test_critical_path_indices(self, diamond_schedule):
        """get_critical_path_indices returns correct topo-ordered indices."""
        nodes, links = diamond_schedule
        state, id_map = build_dag(nodes, links)
        cp = get_critical_path_indices(state)

        cp_ids = {list(id_map.keys())[list(id_map.values()).index(i)]
                  for i in cp}
        assert cp_ids == {'A', 'B', 'D', 'E'}

    def test_disconnected_nodes(self):
        """Disconnected nodes are included in the DAG."""
        nodes = [
            {'ID': 'A', 'Duration': 5},
            {'ID': 'B', 'Duration': 10},
            {'ID': 'C', 'Duration': 3},  # no links
        ]
        links = [{'source': 'A', 'target': 'B'}]
        state, _ = build_dag(nodes, links)

        assert state.n == 3
        # Makespan is max of all finish times
        assert state.makespan == 15.0  # A(5) + B(10)

    def test_unknown_link_targets_ignored(self):
        """Links referencing non-existent nodes are silently skipped."""
        nodes = [{'ID': 'A', 'Duration': 5}]
        links = [{'source': 'A', 'target': 'Z'}]  # Z doesn't exist
        state, _ = build_dag(nodes, links)

        assert state.n == 1
        assert state.makespan == 5.0


# =====================================================================
# Objectives
# =====================================================================

class TestObjectives:

    def _make(self, diamond_schedule, diamond_metadata):
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        return state, params

    def test_schedule_is_makespan(self, diamond_schedule, diamond_metadata):
        state, params = self._make(diamond_schedule, diamond_metadata)
        assert schedule_objective(state, params) == 42.0

    def test_cost_formula(self, diamond_schedule, diamond_metadata):
        """Cost = sum(rate * resource_count * duration)."""
        state, params = self._make(diamond_schedule, diamond_metadata)
        expected = (100*2*10 + 120*3*15 + 90*1*8 + 110*2*12 + 80*1*5)
        assert abs(cost_objective(state, params) - expected) < 1e-6

    def test_quality_zero_at_baseline(self, diamond_schedule, diamond_metadata):
        """No crashing -> zero quality penalty."""
        state, params = self._make(diamond_schedule, diamond_metadata)
        assert quality_objective(state, params) == 0.0

    def test_quality_increases_with_crashing(self, diamond_schedule,
                                             diamond_metadata):
        state, params = self._make(diamond_schedule, diamond_metadata)
        params.durations[0] = params.baseline_durations[0] * 0.8  # 20% crash
        assert quality_objective(state, params) > 0.0

    def test_risk_positive(self, diamond_schedule, diamond_metadata):
        state, params = self._make(diamond_schedule, diamond_metadata)
        assert risk_objective(state, params) > 0.0

    def test_resource_objective_no_overalloc(self):
        """No overallocation -> zero penalty."""
        nodes = [{'ID': 'A', 'Duration': 10}]
        state, _ = build_dag(nodes, [])
        params = build_activity_params(nodes, {
            'A': {'resource_count': 2, 'resource_rate': 100}
        })
        ctx = ProjectContext(resource_capacities={'default': 10})
        assert resource_objective(state, params, ctx) == 0.0

    def test_compute_objectives_dispatch(self, diamond_schedule,
                                         diamond_metadata):
        state, params = self._make(diamond_schedule, diamond_metadata)
        result = compute_objectives(state, params, None,
                                    ['schedule', 'cost'])
        assert 'schedule' in result
        assert 'cost' in result
        assert 'risk' not in result


# =====================================================================
# Adjoints (gradient correctness)
# =====================================================================

class TestAdjoints:

    def _make(self, diamond_schedule, diamond_metadata):
        nodes, links = diamond_schedule
        state, id_map = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        return state, params, id_map

    def test_schedule_gradient_on_critical(self, diamond_schedule,
                                           diamond_metadata):
        """Critical activities have dMakespan/dd = 1."""
        state, params, id_map = self._make(diamond_schedule, diamond_metadata)
        grad = schedule_adj_dur(state, params)
        assert grad[id_map['A']] == 1.0
        assert grad[id_map['B']] == 1.0
        assert grad[id_map['D']] == 1.0
        assert grad[id_map['E']] == 1.0

    def test_schedule_gradient_off_critical(self, diamond_schedule,
                                            diamond_metadata):
        """Non-critical activities have dMakespan/dd = 0."""
        state, params, id_map = self._make(diamond_schedule, diamond_metadata)
        grad = schedule_adj_dur(state, params)
        assert grad[id_map['C']] == 0.0

    def test_cost_gradient_cross_terms(self, diamond_schedule,
                                       diamond_metadata):
        """dC/dd = rate * resources;  dC/dr = rate * duration."""
        state, params, id_map = self._make(diamond_schedule, diamond_metadata)

        dur_grad = cost_adj_dur(state, params)
        res_grad = cost_adj_res(state, params)

        a = id_map['A']
        # dC/dd_A = rate(100) * resources(2) = 200
        assert abs(dur_grad[a] - 200.0) < 1e-9
        # dC/dr_A = rate(100) * duration(10) = 1000
        assert abs(res_grad[a] - 1000.0) < 1e-9

    def test_quality_gradient_sign(self, diamond_schedule, diamond_metadata):
        """Increasing duration reduces crash -> negative gradient."""
        state, params, _ = self._make(diamond_schedule, diamond_metadata)
        # Crash activity A by 20%
        params.durations[0] = params.baseline_durations[0] * 0.8
        grad = quality_adj_dur(state, params)
        # Gradient should be negative (increasing duration improves quality)
        assert grad[0] < 0.0

    def test_quality_gradient_zero_at_baseline(self, diamond_schedule,
                                                diamond_metadata):
        """No crashing -> zero quality gradient."""
        state, params, _ = self._make(diamond_schedule, diamond_metadata)
        grad = quality_adj_dur(state, params)
        np.testing.assert_allclose(grad, 0.0, atol=1e-9)

    def test_schedule_gradient_finite_diff_check(self, diamond_schedule,
                                                  diamond_metadata):
        """Verify analytical schedule gradient against finite differences."""
        state, params, _ = self._make(diamond_schedule, diamond_metadata)
        analytical = schedule_adj_dur(state, params)

        eps = 0.01
        fd_grad = np.zeros(state.n)
        baseline = params.baseline_durations.copy()
        run_cpm(state, baseline.copy())
        base_obj = schedule_objective(state, params)

        for i in range(state.n):
            perturbed = baseline.copy()
            perturbed[i] += eps
            run_cpm(state, perturbed)
            fd_grad[i] = (schedule_objective(state, params) - base_obj) / eps

        # Restore
        run_cpm(state, baseline.copy())

        # Analytical and FD should agree on critical mask
        for i in range(state.n):
            if analytical[i] > 0.5:
                assert fd_grad[i] > 0.5, f"Activity {i}: analytical=1 but FD={fd_grad[i]}"

    def test_cost_gradient_finite_diff_check(self, diamond_schedule,
                                              diamond_metadata):
        """Verify cost duration gradient against finite differences."""
        state, params, _ = self._make(diamond_schedule, diamond_metadata)
        analytical = cost_adj_dur(state, params)

        eps = 0.001
        fd_grad = np.zeros(state.n)
        base_cost = cost_objective(state, params)

        for i in range(state.n):
            orig = params.durations[i]
            params.durations[i] += eps
            fd_grad[i] = (cost_objective(state, params) - base_cost) / eps
            params.durations[i] = orig

        np.testing.assert_allclose(analytical, fd_grad, rtol=1e-3)

    def test_compute_gradients_dispatch(self, diamond_schedule,
                                        diamond_metadata):
        state, params, _ = self._make(diamond_schedule, diamond_metadata)
        grads = compute_gradients(state, params, None, ['schedule', 'cost'])
        assert 'schedule' in grads
        assert 'cost' in grads
        assert 'duration' in grads['schedule']
        assert 'resources' in grads['schedule']


# =====================================================================
# Models
# =====================================================================

class TestModels:

    def test_config_defaults(self):
        cfg = SolverConfig.from_dict({})
        assert len(cfg.disciplines) == 5
        assert abs(sum(cfg.weights.values()) - 1.0) < 1e-9
        assert cfg.stochastic is False

    def test_config_phase_weights(self):
        cfg = SolverConfig.from_dict({}, phase='planning')
        assert cfg.weights['schedule'] < cfg.weights['cost']  # planning: cost > schedule

    def test_config_weight_normalisation(self):
        """Weights are normalised to active disciplines only."""
        cfg = SolverConfig.from_dict({
            'disciplines': ['schedule', 'cost'],
            'weights': {'schedule': 1, 'cost': 1, 'risk': 5}
        })
        # Only schedule + cost active, each should be 0.5
        assert abs(cfg.weights['schedule'] - 0.5) < 1e-9
        assert abs(cfg.weights['cost'] - 0.5) < 1e-9
        assert 'risk' not in cfg.weights

    def test_config_invalid_discipline_filtered(self):
        cfg = SolverConfig.from_dict({'disciplines': ['schedule', 'bogus']})
        assert 'bogus' not in cfg.disciplines
        assert 'schedule' in cfg.disciplines

    def test_activity_params_properties(self, diamond_schedule,
                                        diamond_metadata):
        nodes, _ = diamond_schedule
        params = build_activity_params(nodes, diamond_metadata)

        assert params.n == 5
        assert len(params.ids) == 5

        # At baseline, crash fractions should be 0
        np.testing.assert_allclose(params.crash_fractions, 0.0, atol=1e-9)

        # Min durations = baseline * (1 - crash_max)
        expected_min = params.baseline_durations * (1 - params.crash_max_fractions)
        np.testing.assert_allclose(params.min_durations, expected_min)

    def test_activity_params_defaults(self):
        """Missing metadata uses sensible defaults."""
        nodes = [{'ID': 'X', 'Duration': 10}]
        params = build_activity_params(nodes, {})
        assert params.resource_counts[0] == 1.0
        assert params.crash_max_fractions[0] == 0.2
        assert params.resource_rates[0] == 85.0

    def test_project_context_defaults(self):
        ctx = ProjectContext.from_dict(None)
        assert ctx.phase == 'construction'
        assert ctx.hours_per_day == 8.0


# =====================================================================
# Optimizer
# =====================================================================

class TestOptimizer:

    def test_converges(self, diamond_schedule, diamond_metadata):
        """Optimizer should converge on a small problem."""
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        ctx = ProjectContext()
        cfg = SolverConfig.from_dict({
            'disciplines': ['schedule', 'cost'],
            'max_iterations': 30,
        })

        result = optimize(state, params, ctx, cfg)
        assert result['iterations'] > 0
        assert result['converged'] or result['iterations'] == 30

    def test_durations_within_bounds(self, diamond_schedule, diamond_metadata):
        """Optimised durations must respect box constraints."""
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        cfg = SolverConfig.from_dict({
            'disciplines': ['schedule', 'cost'],
            'max_iterations': 20,
        })

        result = optimize(state, params, ProjectContext(), cfg)
        opt_dur = result['optimized_durations']
        min_dur = params.baseline_durations * (1 - params.crash_max_fractions)

        assert np.all(opt_dur >= min_dur - 1e-9)
        assert np.all(opt_dur <= params.baseline_durations + 1e-9)

    def test_resources_at_least_one(self, diamond_schedule, diamond_metadata):
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        cfg = SolverConfig.from_dict({'max_iterations': 10})

        result = optimize(state, params, ProjectContext(), cfg)
        assert np.all(result['optimized_resources'] >= 1.0)

    def test_empty_graph(self):
        """Optimizer handles empty input gracefully."""
        state, _ = build_dag([], [])
        params = build_activity_params([], {})
        cfg = SolverConfig.from_dict({})
        result = optimize(state, params, ProjectContext(), cfg)
        assert result['converged'] is True
        assert result['iterations'] == 0


# =====================================================================
# Analysis
# =====================================================================

class TestAnalysis:

    def test_synergy_detection(self, diamond_schedule, diamond_metadata):
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)

        grads = compute_gradients(state, params, None,
                                  ['schedule', 'cost', 'risk'])
        pairs = analyze_conflicts_and_synergies(
            grads, ['schedule', 'cost', 'risk'], params)

        assert len(pairs) == 3  # C(3,2) = 3 pairs
        for p in pairs:
            assert 'cosine_similarity' in p
            assert p['relationship'] in ('synergy', 'conflict', 'independent')

    def test_intervention_ranking(self, diamond_schedule, diamond_metadata):
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        cfg = SolverConfig.from_dict({'disciplines': ['schedule', 'cost']})
        grads = compute_gradients(state, params, None, cfg.disciplines)

        interventions = rank_interventions(grads, cfg, params)
        assert len(interventions) == 5
        # Ranks should be 1..5
        ranks = [iv['rank'] for iv in interventions]
        assert sorted(ranks) == [1, 2, 3, 4, 5]
        # Each has a recommendation
        for iv in interventions:
            assert iv['recommendation'] in (
                'high_priority', 'moderate_priority', 'low_priority')


# =====================================================================
# Core orchestration (integration-level)
# =====================================================================

class TestCore:

    def test_sensitivity_returns_expected_keys(self, diamond_schedule,
                                               diamond_metadata):
        nodes, links = diamond_schedule
        result = run_sensitivity(nodes, links, {}, diamond_metadata, {})

        assert 'objectives' in result
        assert 'makespan' in result
        assert 'critical_path' in result
        assert 'sensitivity' in result
        assert 'analysis' in result
        assert 'computation_ms' in result
        assert result['makespan'] == 42.0

    def test_optimize_returns_expected_keys(self, diamond_schedule,
                                            diamond_metadata):
        nodes, links = diamond_schedule
        result = run_optimize(nodes, links,
                              {'max_iterations': 5}, diamond_metadata, {})

        assert 'initial_objectives' in result
        assert 'final_objectives' in result
        assert 'improvement' in result
        assert 'activity_changes' in result
        assert 'converged' in result
        assert 'computation_ms' in result

    def test_sensitivity_empty_graph(self):
        result = run_sensitivity([], [], {}, {}, {})
        assert result['makespan'] == 0.0
        assert result['sensitivity'] == []


# =====================================================================
# Regression tests for bug fixes
# =====================================================================

class TestBugfixRegressions:

    def test_optimizer_zero_scale_quality(self, diamond_schedule,
                                          diamond_metadata):
        """Quality=0 at baseline must not dominate the weighted sum.

        Previously scales used floor=1e-12, so quality's normalisation
        coefficient became ~5e10, swamping every other discipline.
        With floor=1.0 the coefficient is just the weight value.
        """
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        ctx = ProjectContext()
        cfg = SolverConfig.from_dict({
            'disciplines': ['schedule', 'cost', 'quality'],
            'max_iterations': 20,
        })

        result = optimize(state, params, ctx, cfg)

        # Schedule should actually improve (makespan goes down).
        # With the old bug quality dominated and schedule barely moved.
        sched_init = result['initial_objectives']['schedule']
        sched_final = result['final_objectives']['schedule']
        assert sched_final < sched_init, (
            f"Schedule did not improve: {sched_init} -> {sched_final}")

    def test_antithetic_m1_produces_samples(self, diamond_schedule,
                                             diamond_metadata):
        """M=1 with antithetic variates must produce at least 2 samples,
        not zero (the old half=M//2=0 bug).
        """
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        ctx = ProjectContext()
        cfg = SolverConfig.from_dict({
            'monte_carlo_samples': 1,
            'disciplines': ['schedule'],
        })
        cfg.stochastic = True

        result = run_ensemble(state, params, ctx, cfg)
        assert result['n_samples'] >= 2

    def test_antithetic_odd_m(self, diamond_schedule, diamond_metadata):
        """Odd M with antithetic floors to complete pairs (min 1 pair)."""
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        cfg = SolverConfig.from_dict({
            'monte_carlo_samples': 3,
            'disciplines': ['schedule'],
        })

        result = run_ensemble(state, params, ProjectContext(), cfg)
        # 3 // 2 = 1 pair -> 2 samples (not 0)
        assert result['n_samples'] == 2

    def test_ensemble_restores_duration_references(self, diamond_schedule,
                                                    diamond_metadata):
        """run_ensemble must not break aliasing between dag_state.durations
        and params.durations.
        """
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        # Establish alias (as the optimizer does)
        from solver.dag import run_cpm
        run_cpm(state, params.durations)
        assert state.durations is params.durations

        cfg = SolverConfig.from_dict({
            'monte_carlo_samples': 4,
            'disciplines': ['schedule'],
        })
        run_ensemble(state, params, ProjectContext(), cfg)

        # After ensemble, the original arrays should still be the same objects
        assert state.durations is params.durations

    def test_resource_adj_dur_preserves_reference(self, diamond_schedule,
                                                   diamond_metadata):
        """resource_adj_dur must restore dag_state.durations to the original
        array reference, not a local copy.
        """
        nodes, links = diamond_schedule
        state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, diamond_metadata)
        original_ref = state.durations

        resource_adj_dur(state, params)

        assert state.durations is original_ref
        np.testing.assert_array_equal(state.durations, original_ref)

    def test_quality_gradient_zero_baseline_activity(self):
        """Activities with baseline_duration=0 must have zero quality
        gradient (the objective contribution is identically zero).
        """
        nodes = [
            {'ID': 'A', 'Duration': 10},
            {'ID': 'Z', 'Duration': 0},   # zero-baseline activity
        ]
        state, _ = build_dag(nodes, [])
        params = build_activity_params(nodes, {})

        grad = quality_adj_dur(state, params)

        # A has positive baseline -> gradient may be non-zero
        # Z has zero baseline -> gradient MUST be zero
        assert grad[1] == 0.0, (
            f"Zero-baseline activity got non-zero quality gradient: {grad[1]}")

    def test_quality_gradient_matches_fd_with_zero_baseline(self):
        """Finite-difference check: quality gradient for a zero-baseline
        activity should match the analytical gradient (both zero).
        """
        nodes = [
            {'ID': 'A', 'Duration': 5},
            {'ID': 'Z', 'Duration': 0},
        ]
        state, _ = build_dag(nodes, [])
        params = build_activity_params(nodes, {})
        # Crash A by 20% to make quality non-trivial for at least one activity
        params.durations[0] = 4.0

        analytical = quality_adj_dur(state, params)

        eps = 1e-4
        fd = np.zeros(2)
        base = quality_objective(state, params)
        for i in range(2):
            orig = params.durations[i]
            params.durations[i] = orig + eps
            fd[i] = (quality_objective(state, params) - base) / eps
            params.durations[i] = orig

        np.testing.assert_allclose(analytical, fd, atol=1e-3)


# =====================================================================
# Hard constraints (max_makespan / max_budget) + calendar mapping
# =====================================================================

class TestHardConstraints:
    """Quadratic-penalty enforcement of max_makespan and max_budget,
    plus the unresolved-constraint warning path."""

    def _chain(self):
        nodes = [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 10},
            {"ID": "2", "Duration": 15},
            {"ID": "3", "Duration": 8},
        ]
        links = [
            {"source": "0", "target": "1", "type": "FS", "lag": 0},
            {"source": "1", "target": "2", "type": "FS", "lag": 0},
            {"source": "2", "target": "3", "type": "FS", "lag": 0},
        ]
        return nodes, links

    def test_unconstrained_response_omits_constraints(self):
        nodes, links = self._chain()
        result = run_optimize(nodes, links, {"max_iterations": 20}, {}, {})
        assert result.get("constraints") is None

    def test_max_makespan_active_reports_violation(self):
        nodes, links = self._chain()
        # baseline 33, crash floor ~26.4; 25 is infeasible -> violation > 0
        result = run_optimize(nodes, links, {"max_iterations": 60}, {},
                              {"constraints": {"max_makespan": 25.0}})
        c = result["constraints"]["max_makespan"]
        assert c["bound"] == 25.0
        assert c["violation"] > 0
        assert c["satisfied"] is False

    def test_max_makespan_satisfied(self):
        nodes, links = self._chain()
        # 100 is far above the 33 baseline -> satisfied
        result = run_optimize(nodes, links, {"max_iterations": 20}, {},
                              {"constraints": {"max_makespan": 100.0}})
        c = result["constraints"]["max_makespan"]
        assert c["satisfied"] is True
        assert c["violation"] == 0.0

    def test_max_budget_active(self):
        nodes, links = self._chain()
        meta = {"1": {"resource_count": 5.0}, "2": {"resource_count": 5.0},
                "3": {"resource_count": 5.0}}
        result = run_optimize(nodes, links,
            {"max_iterations": 30, "disciplines": ["schedule"],
             "weights": {"schedule": 1.0}},
            meta, {"constraints": {"max_budget": 1000.0}})
        c = result["constraints"]["max_budget"]
        # final_value computed even though cost is not in disciplines
        assert c["final_value"] > 0
        assert c["bound"] == 1000.0

    def test_max_budget_actually_moves_solution(self):
        """The constraint penalty must demonstrably push the optimizer.

        Setup: disciplines = schedule + risk (NOT cost), so the only
        force pulling resources down is the budget penalty itself.
        Schedule and risk both still pull *durations* down via the
        crash mechanism, so the unconstrained run also reduces cost
        somewhat -- the test asserts that the constrained run goes
        materially further, which only the penalty can deliver.
        Avoids the "vacuous test" failure mode where the optimizer
        sits at a bound for unrelated reasons.
        """
        nodes = [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 20},
            {"ID": "2", "Duration": 25},
        ]
        links = [
            {"source": "0", "target": "1"},
            {"source": "1", "target": "2"},
        ]
        meta = {
            "1": {"resource_count": 8.0, "resource_rate": 100.0,
                  "crash_max_fraction": 0.1},
            "2": {"resource_count": 8.0, "resource_rate": 100.0,
                  "crash_max_fraction": 0.1},
        }
        cfg = {"max_iterations": 80, "disciplines": ["schedule", "risk"],
               "weights": {"schedule": 0.5, "risk": 0.5}}

        # Compute the unconstrained final cost from activity_changes.
        # Schedule and risk both have zero gradient on resources, so
        # unconstrained resources stay at their baseline (8.0); only
        # durations move (slightly, via crash).  This means the
        # unconstrained final cost is materially indistinguishable from
        # the baseline 36000 -- the assertion below isolates the
        # constraint's effect from incidental crash-driven savings.
        unconstrained = run_optimize(nodes, links, cfg, meta, {})
        unconstrained_dur = {
            row['activity_id']: row['optimized_duration']
            for row in unconstrained['activity_changes']
        }
        unconstrained_cost = (
            100.0 * 8.0 * unconstrained_dur['1']
            + 100.0 * 8.0 * unconstrained_dur['2']
        )

        constrained = run_optimize(nodes, links, cfg, meta,
                                   {"constraints": {"max_budget": 30000.0}})
        constrained_cost = constrained["constraints"]["max_budget"]["final_value"]

        # Constraint must add at least 5000 of cost reduction over and
        # above whatever the unconstrained run already achieved.  Smoke
        # run: unconstrained ~35960, constrained ~26180 -> ~9780 delta;
        # 5000 leaves margin without being so tight that L-BFGS-B
        # convergence noise can flake it.
        assert constrained_cost < unconstrained_cost - 5000.0, (
            f"Penalty did not move solution: unconstrained={unconstrained_cost}, "
            f"constrained={constrained_cost}")
        assert constrained["constraints"]["max_budget"]["satisfied"] is True

    def test_iso_max_end_date_with_start_date_resolves(self):
        nodes, links = self._chain()
        # 33 working hrs at 8 hpd over Mon-Fri ~= 7 calendar days
        result = run_optimize(nodes, links, {"max_iterations": 20}, {}, {
            "start_date": "2026-01-05",
            "calendar": {"hours_per_day": 8.0, "working_days": [1,2,3,4,5]},
            "constraints": {"max_end_date": "2027-01-05"},
        })
        # max_makespan in the report exists (not None)
        assert result["constraints"] is not None
        assert "max_makespan" in result["constraints"]

    def test_iso_max_end_date_without_start_warns(self):
        nodes, links = self._chain()
        result = run_optimize(nodes, links, {"max_iterations": 20}, {}, {
            "constraints": {"max_end_date": "2026-12-31"},
        })
        assert result.get("constraints") is None
        warnings = result.get("warnings", [])
        codes = [w.get("code") for w in warnings]
        assert "unresolved_max_end_date" in codes

    def test_invalid_max_budget_silently_ignored(self):
        nodes, links = self._chain()
        result = run_optimize(nodes, links, {"max_iterations": 20}, {},
                              {"constraints": {"max_budget": "not-a-number"}})
        assert result.get("constraints") is None

    def test_negative_max_budget_silently_ignored(self):
        nodes, links = self._chain()
        result = run_optimize(nodes, links, {"max_iterations": 20}, {},
                              {"constraints": {"max_budget": -100.0}})
        assert result.get("constraints") is None


class TestCalendarMapping:
    """Opt-in mapping from abstract makespan to a calendar end date."""

    def _chain(self):
        nodes = [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 80},
            {"ID": "2", "Duration": 120},
            {"ID": "3", "Duration": 64},
        ]
        links = [
            {"source": "0", "target": "1"}, {"source": "1", "target": "2"},
            {"source": "2", "target": "3"},
        ]
        return nodes, links

    def test_no_calendar_returns_no_mapping(self):
        nodes, links = self._chain()
        result = run_sensitivity(nodes, links, {}, {}, {})
        assert "calendar" not in result

    def test_calendar_mapping_basic(self):
        nodes, links = self._chain()
        result = run_sensitivity(nodes, links, {}, {}, {
            "start_date": "2026-01-05",
            "calendar": {"hours_per_day": 8.0, "working_days": [1,2,3,4,5]},
        })
        cal = result["calendar"]
        assert cal["project_start_date"] == "2026-01-05"
        assert cal["makespan_end_date"] is not None
        # 264 hrs / 8 hpd = 33 working days; ~7 calendar weeks
        from datetime import datetime
        end = datetime.strptime(cal["makespan_end_date"], "%Y-%m-%d")
        start = datetime.strptime(cal["project_start_date"], "%Y-%m-%d")
        delta_days = (end - start).days
        assert 40 <= delta_days <= 55

    def test_holidays_push_end_date_later(self):
        nodes, links = self._chain()
        ctx_no = {
            "start_date": "2026-01-05",
            "calendar": {"hours_per_day": 8.0, "working_days": [1, 2, 3, 4, 5]},
        }
        ctx_h = {
            "start_date": "2026-01-05",
            "calendar": {
                "hours_per_day": 8.0, "working_days": [1, 2, 3, 4, 5],
                "holidays": ["2026-01-19", "2026-02-16", "2026-02-17"],
            },
        }
        r1 = run_sensitivity(nodes, links, {}, {}, ctx_no)
        r2 = run_sensitivity(nodes, links, {}, {}, ctx_h)
        assert r2["calendar"]["makespan_end_date"] >= r1["calendar"]["makespan_end_date"]
        assert r2["calendar"]["holidays_count"] == 3

    def test_optimize_includes_calendar_mapping(self):
        nodes, links = self._chain()
        result = run_optimize(nodes, links, {"max_iterations": 20}, {}, {
            "start_date": "2026-01-05",
            "calendar": {"hours_per_day": 8.0, "working_days": [1, 2, 3, 4, 5]},
        })
        assert "calendar" in result
        assert result["calendar"]["makespan_end_date"] is not None

    def test_unparseable_start_date_skips_mapping(self):
        nodes, links = self._chain()
        result = run_sensitivity(nodes, links, {}, {}, {
            "start_date": "not-a-date",
            "calendar": {"hours_per_day": 8.0, "working_days": [1, 2, 3, 4, 5]},
        })
        assert "calendar" not in result

    def test_start_date_alone_does_not_trigger(self):
        """Gating consistency with completion/monte_carlo: start_date
        alone (no calendar fields) does NOT enable the mapping.  Both
        endpoint families should make the same gate decision so callers
        get predictable behaviour.
        """
        nodes, links = self._chain()
        result = run_sensitivity(nodes, links, {}, {}, {
            "start_date": "2026-01-05",
        })
        assert "calendar" not in result

    def test_days_units_converted_to_working_hours(self):
        """When Duration is in days, the mapping must convert to
        working hours via the dominant TimeUnits before advancing the
        WorkingCalendar -- otherwise day-counts are silently treated as
        hours and the end date is many factors off.
        """
        # Same project as _chain but expressed in days (Duration=10)
        # vs hours (Duration=80).  Both should map to the same end date.
        nodes_h = [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 80, "TimeUnits": "Hours"},
            {"ID": "2", "Duration": 120, "TimeUnits": "Hours"},
            {"ID": "3", "Duration": 64, "TimeUnits": "Hours"},
        ]
        nodes_d = [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 10, "TimeUnits": "Days"},
            {"ID": "2", "Duration": 15, "TimeUnits": "Days"},
            {"ID": "3", "Duration": 8,  "TimeUnits": "Days"},
        ]
        links = [
            {"source": "0", "target": "1"}, {"source": "1", "target": "2"},
            {"source": "2", "target": "3"},
        ]
        ctx = {
            "start_date": "2026-01-05",
            "calendar": {"hours_per_day": 8.0, "working_days": [1, 2, 3, 4, 5]},
        }
        rh = run_sensitivity(nodes_h, links, {}, {}, ctx)
        rd = run_sensitivity(nodes_d, links, {}, {}, ctx)
        # Both projects represent the same plan -- end dates must match.
        assert rh["calendar"]["makespan_end_date"] == rd["calendar"]["makespan_end_date"]
        # Reported time_units distinguishes the two requests.
        assert rh["calendar"]["time_units"] == "Hours"
        assert rd["calendar"]["time_units"] == "Days"
        # Working-hours conversion lands on the same value (264 hrs).
        assert rh["calendar"]["makespan_working_hours"] == pytest.approx(
            rd["calendar"]["makespan_working_hours"], abs=1e-6)

    def test_mixed_time_units_emits_warning(self):
        """Heterogeneous TimeUnits across activities is a real-world
        data-quality issue; the response should flag it so downstream
        consumers know the makespan/end-date mapping is approximate."""
        nodes = [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 80, "TimeUnits": "Hours"},
            {"ID": "2", "Duration": 15, "TimeUnits": "Days"},
        ]
        links = [
            {"source": "0", "target": "1"}, {"source": "1", "target": "2"},
        ]
        result = run_sensitivity(nodes, links, {}, {}, {
            "start_date": "2026-01-05",
            "calendar": {"hours_per_day": 8.0, "working_days": [1, 2, 3, 4, 5]},
        })
        assert result["calendar"]["mixed_time_units"] is True

    def test_mixed_time_units_false_when_homogeneous(self):
        """mixed_time_units must always be present (not absent-when-false)
        so consumers can read it without an `in` guard.  This locks the
        contract change away from the previous present-only-when-true
        behaviour."""
        nodes = [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 80, "TimeUnits": "Hours"},
            {"ID": "2", "Duration": 120, "TimeUnits": "Hours"},
        ]
        links = [
            {"source": "0", "target": "1"}, {"source": "1", "target": "2"},
        ]
        result = run_sensitivity(nodes, links, {}, {}, {
            "start_date": "2026-01-05",
            "calendar": {"hours_per_day": 8.0, "working_days": [1, 2, 3, 4, 5]},
        })
        cal = result["calendar"]
        assert "mixed_time_units" in cal
        assert cal["mixed_time_units"] is False

    def test_mixed_case_time_units_not_falsely_flagged(self):
        """Mixing case of the same token (`Hours` and `hours`) is
        case-folding, not unit-mixing.  The flag should stay False.

        Note: this normalises case only -- cross-alias mixing
        (`Hours` vs `h` vs `hr`) still flags as mixed even though
        ``convert_to_hours`` resolves all of them to the same unit.
        Alias-aware coalescing would require probing convert_to_hours
        per pair and is out of scope here.
        """
        nodes = [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 80, "TimeUnits": "Hours"},
            {"ID": "2", "Duration": 120, "TimeUnits": "hours"},
            {"ID": "3", "Duration": 64, "TimeUnits": "HOURS"},
        ]
        links = [
            {"source": "0", "target": "1"}, {"source": "1", "target": "2"},
            {"source": "2", "target": "3"},
        ]
        result = run_sensitivity(nodes, links, {}, {}, {
            "start_date": "2026-01-05",
            "calendar": {"hours_per_day": 8.0, "working_days": [1, 2, 3, 4, 5]},
        })
        # Same token, different cases -> coalesced; flag stays False.
        assert result["calendar"]["mixed_time_units"] is False
        # Canonical representative is the first-seen casing.
        assert result["calendar"]["time_units"] == "Hours"

    def test_missing_time_units_votes_default_hours(self):
        """An activity without an explicit TimeUnits field votes for
        the default 'Hours' (matching evm.helpers.convert_to_hours
        behaviour) rather than abstaining.  Without this, a single
        explicit 'Days' activity in a project of otherwise-untagged
        activities would incorrectly dominate."""
        nodes = [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 80},                              # no units
            {"ID": "2", "Duration": 120},                             # no units
            {"ID": "3", "Duration": 5, "TimeUnits": "Days"},          # tagged
        ]
        links = [
            {"source": "0", "target": "1"}, {"source": "1", "target": "2"},
            {"source": "2", "target": "3"},
        ]
        result = run_sensitivity(nodes, links, {}, {}, {
            "start_date": "2026-01-05",
            "calendar": {"hours_per_day": 8.0, "working_days": [1, 2, 3, 4, 5]},
        })
        # 2 untagged (vote Hours) + 1 explicit Hours-equivalent + 1 Days
        # -> Hours wins as the dominant canonical representative.
        assert result["calendar"]["time_units"] == "Hours"
        # Mix-of-units flag still fires (Days is present alongside Hours).
        assert result["calendar"]["mixed_time_units"] is True
