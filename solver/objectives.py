"""
solver/objectives.py - Five forward objective functions.

Each returns a scalar (lower is better).  All operate on DAGState +
ActivityParams so they can be evaluated cheaply inside optimisation loops.
"""

import numpy as np


def schedule_objective(dag_state, params, project_ctx=None):
    """Project makespan (total duration)."""
    return dag_state.makespan


def cost_objective(dag_state, params, project_ctx=None):
    """
    Total project cost.
    C = sum(rate_i * resource_count_i * duration_i)
    """
    return float(np.sum(params.resource_rates * params.resource_counts
                        * params.durations))


def risk_objective(dag_state, params, project_ctx=None):
    """
    Weighted risk.  Activities closer to the critical path (less float)
    contribute more via a criticality multiplier in [1, 2].
    """
    if dag_state.n == 0:
        return 0.0
    makespan = max(dag_state.makespan, 1e-9)
    normalised_float = np.clip(dag_state.TF / makespan, 0.0, 1.0)
    criticality = 2.0 - normalised_float
    return float(np.sum(params.risk_scores * criticality * params.durations))


def resource_objective(dag_state, params, project_ctx=None):
    """
    Resource overallocation penalty via smoothed trapezoidal profiles.
    Discretises the timeline and penalises bins that exceed capacity.
    """
    if dag_state.n == 0 or dag_state.makespan <= 0:
        return 0.0

    capacity = 10.0
    if project_ctx and project_ctx.resource_capacities:
        try:
            cap = float(next(iter(project_ctx.resource_capacities.values())))
            if np.isfinite(cap) and cap > 0:
                capacity = cap
        except (TypeError, ValueError, StopIteration):
            pass

    makespan = dag_state.makespan
    n_bins = min(int(np.ceil(makespan)), 500)
    if n_bins <= 0:
        return 0.0

    bin_width = makespan / n_bins
    profile = np.zeros(n_bins, dtype=np.float64)

    for i in range(dag_state.n):
        es, ef = dag_state.ES[i], dag_state.EF[i]
        rc = params.resource_counts[i]
        if ef <= es or rc <= 0:
            continue
        sb = max(0, min(int(np.floor(es / bin_width)), n_bins - 1))
        eb = max(sb + 1, min(int(np.ceil(ef / bin_width)), n_bins))
        profile[sb:eb] += rc

    overalloc = np.maximum(profile - capacity, 0.0)
    return float(np.sum(overalloc ** 2) * bin_width)


def quality_objective(dag_state, params, project_ctx=None):
    """
    Quality penalty from crashing.  Quadratic in crash fraction so the
    optimiser prefers spreading crash effort across many activities.
    Q = sum(crash_frac_i^2 * sensitivity_i * baseline_dur_i)
    """
    cf = params.crash_fractions
    return float(np.sum(cf ** 2 * params.quality_sensitivities
                        * params.baseline_durations))


# ---- dispatch ---------------------------------------------------------------

OBJECTIVE_FNS = {
    'schedule':  schedule_objective,
    'cost':      cost_objective,
    'risk':      risk_objective,
    'resources': resource_objective,
    'quality':   quality_objective,
}


def compute_objectives(dag_state, params, project_ctx, disciplines):
    """Evaluate requested objectives.  Returns {discipline: scalar}."""
    return {d: OBJECTIVE_FNS[d](dag_state, params, project_ctx)
            for d in disciplines if d in OBJECTIVE_FNS}
