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
from .optimizer import optimize, build_constraints_report
from .pareto import run_pareto as _run_pareto
from .analysis import compute_analysis
from .calendar_map import map_makespan_to_date

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

    calendar_mapping = map_makespan_to_date(
        dag_state.makespan, project_ctx,
        project_ctx_dict=project_context_dict, nodes=nodes)

    # Sensitivity is a single-pass analysis (no optimisation), so the
    # constraints report describes the current-baseline feasibility:
    # how far the unmodified schedule sits from the supplied bounds.
    # Useful as a pre-flight check before kicking off /solver/optimize.
    constraints_report = None
    if (project_ctx.max_makespan is not None
            or project_ctx.max_budget is not None):
        constraints_report = build_constraints_report(
            dag_state, params, objectives,
            project_ctx.max_makespan, project_ctx.max_budget)
    warnings = _resolve_constraint_warnings(
        project_ctx, project_context_dict)

    result = {
        'objectives':     {d: float(v) for d, v in objectives.items()},
        'makespan':       dag_state.makespan,
        'critical_path':  cp_ids,
        'sensitivity':    sensitivity_table,
        'analysis':       analysis,
        'constraints':    constraints_report,
        'config': {
            'disciplines': config.disciplines,
            'weights':     config.weights,
        },
        'computation_ms': elapsed_ms,
    }
    if calendar_mapping is not None:
        result['calendar'] = calendar_mapping
    if warnings:
        result['warnings'] = warnings

    if stochastic:
        result['stochastic'] = {
            'objectives_mean':      stochastic['objectives_mean'],
            'objectives_std':       stochastic['objectives_std'],
            'n_samples':            stochastic['n_samples'],
            'black_swans':          stochastic.get('black_swans', []),
            'dragon_kings':         stochastic.get('dragon_kings', []),
            'sra':                  stochastic.get('sra', {}),
            'cost_schedule_joint':  stochastic.get('cost_schedule_joint'),
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
    calendar_mapping = map_makespan_to_date(
        dag_state.makespan, project_ctx,
        project_ctx_dict=project_context_dict, nodes=nodes)

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
        'constraints':       opt.get('constraints'),
        'config': {
            'disciplines':   config.disciplines,
            'weights':       config.weights,
            'max_iterations': config.max_iterations,
        },
        'computation_ms': elapsed_ms,
    }
    if calendar_mapping is not None:
        result['calendar'] = calendar_mapping

    # Surface a warning when callers supplied a constraint that we
    # couldn't resolve to a numeric bound so they don't silently get
    # an unconstrained run.  The helper inspects the raw input to
    # tailor the warning code/message to the actual failure mode --
    # e.g. ISO date with no start_date, malformed string, end-before-
    # start -- rather than emitting a single generic warning that
    # implies the wrong cause.
    optimize_warnings = _resolve_constraint_warnings(
        project_ctx, project_context_dict)
    if optimize_warnings:
        result.setdefault('warnings', []).extend(optimize_warnings)

    if stochastic:
        result['stochastic'] = {
            'objectives_mean':      stochastic['objectives_mean'],
            'objectives_std':       stochastic['objectives_std'],
            'n_samples':            stochastic['n_samples'],
            'black_swans':          stochastic.get('black_swans', []),
            'dragon_kings':         stochastic.get('dragon_kings', []),
            'sra':                  stochastic.get('sra', {}),
            'cost_schedule_joint':  stochastic.get('cost_schedule_joint'),
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
    """Empty-DAG response shape.  Mirrors the populated path's keys
    (constraints / calendar / warnings) with ``None`` / absent values
    so consumers don't see a different shape on degenerate inputs."""
    return {
        'objectives': {d: 0.0 for d in disciplines},
        'makespan': 0.0,
        'critical_path': [],
        'sensitivity': [],
        'analysis': {'conflicts_and_synergies': [], 'interventions': []},
        'constraints': None,
        'config': {'disciplines': disciplines, 'weights': {}},
        'computation_ms': round((time.time() - t0) * 1000, 1),
    }


def _empty_optimize(disciplines, t0):
    """Empty-DAG response shape.  Mirrors the populated path's keys
    (constraints / calendar / warnings) with ``None`` / absent values
    so consumers don't see a different shape on degenerate inputs."""
    return {
        'initial_objectives': {d: 0.0 for d in disciplines},
        'final_objectives':   {d: 0.0 for d in disciplines},
        'improvement':        {d: 0.0 for d in disciplines},
        'makespan': 0.0,
        'activity_changes': [],
        'iterations': 0,
        'converged': True,
        'history': [],
        'constraints': None,
        'config': {'disciplines': disciplines, 'weights': {}},
        'computation_ms': round((time.time() - t0) * 1000, 1),
    }


def _looks_like_iso_date(value):
    """Heuristic: caller intended ISO when the value is non-numeric and
    parses as a datetime."""
    if value is None:
        return False
    try:
        float(value)
        return False  # numeric -> not ISO intent
    except (TypeError, ValueError):
        pass
    try:
        from datetime import datetime
        datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return True
    except (TypeError, ValueError):
        return False


def _resolve_constraint_warnings(project_ctx, project_context_dict):
    """Tailor warnings to the *actual* failure mode of constraint
    resolution rather than emitting a single generic message.

    Cases:
      - ISO max_end_date supplied AND start_date missing:
            -> ``unresolved_max_end_date_no_start``
      - ISO max_end_date supplied AND start_date present but unparseable:
            -> ``unresolved_max_end_date_bad_start``
      - max_end_date supplied but neither numeric nor ISO-parseable:
            -> ``malformed_max_end_date``
      - Both ISO but end <= start:
            -> ``max_end_date_before_start``
      - Anything else (max_makespan resolved cleanly): no warning.
    """
    # Only emit warnings when max_makespan failed to resolve.  If
    # resolution succeeded, the caller has the bound they wanted.
    if project_ctx.max_makespan is not None:
        return []
    raw = project_ctx.max_end_date
    if raw is None:
        return []

    cdict = project_context_dict or {}
    constraints = cdict.get('constraints') or {}
    raw = constraints.get('max_end_date', raw)
    start_raw = (cdict.get('start_date')
                 or (cdict.get('calendar') or {}).get('start_date')
                 or (cdict.get('project') or {}).get('start_date'))

    iso_intent = _looks_like_iso_date(raw)

    # max_end_date is non-numeric, non-ISO -> caller passed a malformed value.
    if not iso_intent:
        try:
            float(raw)
            # Numeric but non-positive (filtered earlier as None).
            return [{
                'code': 'malformed_max_end_date',
                'message': ('constraints.max_end_date is numeric but '
                            'non-positive; the constraint was ignored.'),
            }]
        except (TypeError, ValueError):
            return [{
                'code': 'malformed_max_end_date',
                'message': ('constraints.max_end_date is neither numeric '
                            'nor a parseable ISO date; the constraint was '
                            'ignored.  Use a positive number (in solver time '
                            'units) or an ISO 8601 date string with a '
                            'project start_date.'),
            }]

    # ISO max_end_date but no start_date -> can't compute the difference.
    if start_raw is None:
        return [{
            'code': 'unresolved_max_end_date_no_start',
            'message': ('constraints.max_end_date is an ISO date but no '
                        'project start_date was supplied; the constraint '
                        'was ignored.  Pass either '
                        'constraints.max_makespan (numeric) or both '
                        'constraints.max_end_date and start_date as ISO '
                        'dates.'),
        }]

    # Start_date supplied but unparseable.
    if not _looks_like_iso_date(start_raw):
        return [{
            'code': 'unresolved_max_end_date_bad_start',
            'message': ('constraints.max_end_date is an ISO date but '
                        'project start_date is not parseable as ISO; '
                        'the constraint was ignored.'),
        }]

    # Both ISO and parseable.  The remaining failure modes are:
    #   (a) end <= start  -> max_end_date_before_start
    #   (b) calendar config (hours_per_day / working_days) malformed
    #       so working_hours computes to 0/NaN inside
    #       _resolve_max_makespan -> malformed_calendar_config
    # Distinguish them by re-parsing here and checking the date span
    # directly rather than assuming (a).
    try:
        from datetime import datetime, timezone
        end = datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
        start = datetime.fromisoformat(str(start_raw).replace('Z', '+00:00'))
        end = end if end.tzinfo is not None else end.replace(tzinfo=timezone.utc)
        start = (start if start.tzinfo is not None
                 else start.replace(tzinfo=timezone.utc))
    except (TypeError, ValueError):
        # Parsing failed despite _looks_like_iso_date passing -- treat
        # as malformed (defensive; shouldn't happen in practice).
        return [{
            'code': 'malformed_max_end_date',
            'message': ('constraints.max_end_date or start_date failed '
                        'to parse as ISO 8601; the constraint was '
                        'ignored.'),
        }]
    if (end - start).total_seconds() <= 0:
        return [{
            'code': 'max_end_date_before_start',
            'message': ('constraints.max_end_date is on or before '
                        'project start_date; the constraint was '
                        'ignored.'),
        }]
    return [{
        'code': 'malformed_calendar_config',
        'message': ('constraints.max_end_date and start_date are '
                    'both valid ISO dates but the calendar '
                    'configuration produced a non-positive working-'
                    'hour bound (check hours_per_day and '
                    'working_days for zero / NaN / out-of-range '
                    'values); the constraint was ignored.'),
    }]
