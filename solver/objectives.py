"""
solver/objectives.py - Five forward objective functions.

Each returns a scalar (lower is better).  All operate on DAGState +
ActivityParams so they can be evaluated cheaply inside optimisation loops.
"""

import numpy as np


# Sharpness of the softplus smoothing in resource_objective.  At β=10
# the deviation from np.maximum is < 1e-2 for |profile - cap| ≥ 1
# and below double-precision zero for cap - profile ≥ 8.  See
# docs/research/sketches/e1_logsumexp_resource.py for the derivation.
RESOURCE_SMOOTHING_BETA = 10.0


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


def _resolve_resource_capacity(project_ctx):
    """Look up the active resource capacity, defaulting to 10."""
    capacity = 10.0
    if project_ctx and project_ctx.resource_capacities:
        try:
            cap = float(next(iter(project_ctx.resource_capacities.values())))
            if np.isfinite(cap) and cap > 0:
                capacity = cap
        except (TypeError, ValueError, StopIteration):
            pass
    return capacity


def _build_resource_profile(dag_state, params, project_ctx=None):
    """Build the per-bin resource demand profile.

    Returns ``(profile, capacity, bin_width, activity_bins)`` or
    ``None`` when there's nothing to evaluate (n==0 or makespan<=0
    or n_bins<=0).

    ``activity_bins[i] = (start_bin, end_bin)`` is the half-open bin
    range activity *i* contributes to, exposed so the analytic
    adjoint (resource_adj_res) can map per-bin gradients back to
    per-activity gradients without re-deriving the floor/ceil math.
    """
    if dag_state.n == 0 or dag_state.makespan <= 0:
        return None

    capacity = _resolve_resource_capacity(project_ctx)

    makespan = dag_state.makespan
    n_bins = min(int(np.ceil(makespan)), 500)
    if n_bins <= 0:
        return None

    bin_width = makespan / n_bins
    profile = np.zeros(n_bins, dtype=np.float64)
    activity_bins = [(0, 0)] * dag_state.n

    for i in range(dag_state.n):
        es, ef = dag_state.ES[i], dag_state.EF[i]
        rc = params.resource_counts[i]
        if ef <= es or rc <= 0:
            continue
        sb = max(0, min(int(np.floor(es / bin_width)), n_bins - 1))
        eb = max(sb + 1, min(int(np.ceil(ef / bin_width)), n_bins))
        profile[sb:eb] += rc
        activity_bins[i] = (sb, eb)

    return profile, capacity, bin_width, activity_bins


def resource_objective(dag_state, params, project_ctx=None):
    """Resource overallocation penalty.

    Per roadmap item E1: the overallocation ``max(profile - cap, 0)``
    is replaced with the everywhere-differentiable softplus

        softplus(x, β) = log(1 + exp(β x)) / β
                       = np.logaddexp(0, β x) / β   (numerically stable)

    Pointwise softplus(x, β) ≥ max(x, 0) and converges pointwise to
    max(x, 0) as β → ∞.  At β = ``RESOURCE_SMOOTHING_BETA`` = 10 the
    deviation from max() is < 1e-2 for |x| ≥ 1 and below double-
    precision zero for x ≤ -8 -- so a feasible profile (every bin
    ≥ 1 unit below capacity) yields a numerically-zero penalty,
    matching the previous formulation byte-for-byte on the existing
    test fixture (resource_count=2, cap=10).

    The smooth form is what makes ``resource_adj_res`` analytic
    instead of FD -- see solver/adjoints.py.
    """
    built = _build_resource_profile(dag_state, params, project_ctx)
    if built is None:
        return 0.0
    profile, capacity, bin_width, _ = built

    delta = RESOURCE_SMOOTHING_BETA * (profile - capacity)
    smooth_over = np.logaddexp(0.0, delta) / RESOURCE_SMOOTHING_BETA
    return float(np.sum(smooth_over ** 2) * bin_width)


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
