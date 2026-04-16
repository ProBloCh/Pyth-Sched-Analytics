"""
solver/core.py - Orchestration layer for the CADJ-P solver.

Coordinates DAG construction, objective evaluation, gradient computation,
stochastic analysis, optimisation, and Pareto sweeps.  Each public function
corresponds to one API endpoint and returns a JSON-serialisable dict.
"""

import logging
import time

from .models import SolverConfig, ProjectContext, build_activity_params
from .dag import build_dag, get_critical_path_indices
from .objectives import compute_objectives
from .adjoints import compute_gradients
from .stochastic import run_ensemble
from .optimizer import optimize
from .pareto import run_pareto as _run_pareto
from .analysis import compute_analysis

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# POST /solver/sensitivity
# ---------------------------------------------------------------------------

def run_sensitivity(nodes, links, solver_config_dict,
                    activity_metadata, project_context_dict):
    """Single-pass sensitivity analysis at the current schedule state."""
    t0 = time.time()

    project_ctx = ProjectContext.from_dict(project_context_dict)
    config = SolverConfig.from_dict(solver_config_dict, phase=project_ctx.phase)

    logger.info("Sensitivity: %d nodes, %d links, disciplines=%s, "
                "phase=%s, stochastic=%s",
                len(nodes), len(links), config.disciplines,
                project_ctx.phase, config.stochastic)

    dag_state, id_to_idx = build_dag(nodes, links)
    params = build_activity_params(nodes, activity_metadata)

    if dag_state.n == 0:
        return _empty_sensitivity(config.disciplines, t0)

    objectives = compute_objectives(dag_state, params, project_ctx,
                                    config.disciplines)
    gradients  = compute_gradients(dag_state, params, project_ctx,
                                   config.disciplines)
    analysis   = compute_analysis(gradients, config, params)

    stochastic = None
    if config.stochastic:
        stochastic = run_ensemble(dag_state, params, project_ctx, config)

    sensitivity_table = _build_sensitivity_table(dag_state, params,
                                                 gradients, config)
    cp_ids = [params.ids[i] for i in get_critical_path_indices(dag_state)
              if i < params.n]

    elapsed_ms = round((time.time() - t0) * 1000, 1)
    logger.info("Sensitivity done: makespan=%.1f, critical_path_len=%d, "
                "%.1fms", dag_state.makespan, len(cp_ids), elapsed_ms)

    result = {
        'objectives':     {d: float(v) for d, v in objectives.items()},
        'makespan':       dag_state.makespan,
        'critical_path':  cp_ids,
        'sensitivity':    sensitivity_table,
        'analysis':       analysis,
        'config': {
            'disciplines': config.disciplines,
            'weights':     config.weights,
        },
        'computation_ms': elapsed_ms,
    }

    if stochastic:
        result['stochastic'] = {
            'objectives_mean': stochastic['objectives_mean'],
            'objectives_std':  stochastic['objectives_std'],
            'n_samples':       stochastic['n_samples'],
            'black_swans':     stochastic.get('black_swans', []),
            'dragon_kings':    stochastic.get('dragon_kings', []),
        }

    return result


# ---------------------------------------------------------------------------
# POST /solver/optimize
# ---------------------------------------------------------------------------

def run_optimize(nodes, links, solver_config_dict,
                 activity_metadata, project_context_dict):
    """Full gradient-descent optimisation."""
    t0 = time.time()

    project_ctx = ProjectContext.from_dict(project_context_dict)
    config = SolverConfig.from_dict(solver_config_dict, phase=project_ctx.phase)

    logger.info("Optimize: %d nodes, %d links, disciplines=%s, "
                "max_iter=%d, stochastic=%s",
                len(nodes), len(links), config.disciplines,
                config.max_iterations, config.stochastic)

    dag_state, _ = build_dag(nodes, links)
    params = build_activity_params(nodes, activity_metadata)

    if dag_state.n == 0:
        return _empty_optimize(config.disciplines, t0)

    opt = optimize(dag_state, params, project_ctx, config)

    stochastic = None
    if config.stochastic:
        stochastic = run_ensemble(dag_state, params, project_ctx, config)

    activity_changes = []
    for i in range(dag_state.n):
        bd = float(params.baseline_durations[i])
        od = float(params.durations[i])
        activity_changes.append({
            'activity_id':        params.ids[i],
            'baseline_duration':  bd,
            'optimized_duration': od,
            'duration_change_pct': round((od - bd) / max(bd, 1e-9) * 100, 2),
            'on_critical_path':   bool(dag_state.critical_mask[i]),
        })

    elapsed_ms = round((time.time() - t0) * 1000, 1)

    result = {
        'initial_objectives': opt['initial_objectives'],
        'final_objectives':   opt['final_objectives'],
        'improvement': {
            d: round(
                (opt['initial_objectives'].get(d, 0)
                 - opt['final_objectives'].get(d, 0))
                / max(abs(opt['initial_objectives'].get(d, 0)), 1e-12)
                * 100, 2)
            for d in config.disciplines
        },
        'makespan':          dag_state.makespan,
        'activity_changes':  activity_changes,
        'iterations':        opt['iterations'],
        'converged':         opt['converged'],
        'history':           opt['history'],
        'config': {
            'disciplines':   config.disciplines,
            'weights':       config.weights,
            'max_iterations': config.max_iterations,
        },
        'computation_ms': elapsed_ms,
    }

    if stochastic:
        result['stochastic'] = {
            'objectives_mean': stochastic['objectives_mean'],
            'objectives_std':  stochastic['objectives_std'],
            'n_samples':       stochastic['n_samples'],
            'black_swans':     stochastic.get('black_swans', []),
            'dragon_kings':    stochastic.get('dragon_kings', []),
        }

    logger.info("Optimize done: %d iterations, converged=%s, "
                "makespan=%.1f, %.1fms",
                opt['iterations'], opt['converged'],
                dag_state.makespan, elapsed_ms)

    return result


# ---------------------------------------------------------------------------
# POST /solver/pareto
# ---------------------------------------------------------------------------

def run_pareto_endpoint(nodes, links, solver_config_dict,
                        activity_metadata, project_context_dict):
    """Pareto frontier sweep across weight vectors."""
    t0 = time.time()

    project_ctx = ProjectContext.from_dict(project_context_dict)
    config = SolverConfig.from_dict(solver_config_dict, phase=project_ctx.phase)
    n_vec = int((solver_config_dict or {}).get('pareto_vectors', 30))

    pareto = _run_pareto(nodes, links, activity_metadata,
                         project_ctx, config, n_vec)

    return {
        'frontier':    pareto['frontier'],
        'n_frontier':  pareto['n_frontier'],
        'n_explored':  pareto['n_vectors'],
        'config': {
            'disciplines': config.disciplines,
            'n_vectors':   n_vec,
        },
        'computation_ms': round((time.time() - t0) * 1000, 1),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_sensitivity_table(dag_state, params, gradients, config):
    """Per-activity sensitivity rankings sorted by composite score."""
    table = []

    for i in range(dag_state.n):
        entry = {
            'activity_id':    params.ids[i],
            'duration':       float(params.durations[i]),
            'total_float':    float(dag_state.TF[i]),
            'on_critical_path': bool(dag_state.critical_mask[i]),
            'crash_potential': float(params.crash_max_fractions[i]),
            'sensitivities':  {},
        }
        composite = 0.0
        for d in config.disciplines:
            if d in gradients:
                dg = float(gradients[d]['duration'][i])
                rg = float(gradients[d]['resources'][i])
                entry['sensitivities'][d] = {
                    'duration_gradient':  round(dg, 6),
                    'resource_gradient':  round(rg, 6),
                }
                composite += config.weights.get(d, 0.0) * (abs(dg) + abs(rg))

        entry['composite_sensitivity'] = round(composite, 6)
        table.append(entry)

    table.sort(key=lambda x: x['composite_sensitivity'], reverse=True)
    for rank, entry in enumerate(table):
        entry['rank'] = rank + 1

    return table


def _empty_sensitivity(disciplines, t0):
    return {
        'objectives': {d: 0.0 for d in disciplines},
        'makespan': 0.0,
        'critical_path': [],
        'sensitivity': [],
        'analysis': {'conflicts_and_synergies': [], 'interventions': []},
        'config': {'disciplines': disciplines, 'weights': {}},
        'computation_ms': round((time.time() - t0) * 1000, 1),
    }


def _empty_optimize(disciplines, t0):
    return {
        'initial_objectives': {d: 0.0 for d in disciplines},
        'final_objectives':   {d: 0.0 for d in disciplines},
        'improvement':        {d: 0.0 for d in disciplines},
        'makespan': 0.0,
        'activity_changes': [],
        'iterations': 0,
        'converged': True,
        'history': [],
        'config': {'disciplines': disciplines, 'weights': {}},
        'computation_ms': round((time.time() - t0) * 1000, 1),
    }
