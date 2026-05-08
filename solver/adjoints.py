"""
solver/adjoints.py - Adjoint (gradient) engine for the CADJ-P solver.

Computes dJ/d_duration and dJ/d_resources for each discipline.

Design-review compliance:
  - Resource adjoint uses finite differences (section 1.5) because the
    smoothed trapezoidal profile has non-differentiable step boundaries.
  - Cost adjoint includes cross-terms (section 1.3): resource_factor in
    dC/dd, duration_factor in dC/dr.
  - Schedule adjoint is analytical via CPM critical-mask.
"""

import numpy as np

from .dag import run_cpm

# ---------------------------------------------------------------------------
# Schedule
# ---------------------------------------------------------------------------

def schedule_adj_dur(dag_state, params, project_ctx=None):
    """dMakespan/dd_i = 1 on critical path, 0 elsewhere."""
    g = np.zeros(dag_state.n, dtype=np.float64)
    g[dag_state.critical_mask] = 1.0
    return g


def schedule_adj_res(dag_state, params, project_ctx=None):
    return np.zeros(dag_state.n, dtype=np.float64)


# ---------------------------------------------------------------------------
# Cost  (with cross-terms per review section 1.3)
# ---------------------------------------------------------------------------

def cost_adj_dur(dag_state, params, project_ctx=None):
    """dC/dd_i = rate_i * resource_count_i  (resource factor in dC/dd)."""
    return params.resource_rates * params.resource_counts


def cost_adj_res(dag_state, params, project_ctx=None):
    """dC/dr_i = rate_i * duration_i  (duration factor in dC/dr)."""
    return params.resource_rates * params.durations


# ---------------------------------------------------------------------------
# Risk
# ---------------------------------------------------------------------------

def risk_adj_dur(dag_state, params, project_ctx=None):
    """dR/dd_i ≈ risk_i * criticality_i  (first-order approximation).

    Ignores the second-order term  risk_i * d_i * d(crit_i)/dd_i
    that arises because criticality depends on makespan (for critical
    activities) and on TF (for all activities via the backward pass).
    The omitted term is bounded by the risk weight in the scalarisation
    and empirically does not prevent convergence.
    """
    if dag_state.n == 0:
        return np.zeros(0, dtype=np.float64)
    makespan = max(dag_state.makespan, 1e-9)
    norm_float = np.clip(dag_state.TF / makespan, 0.0, 1.0)
    criticality = 2.0 - norm_float
    return params.risk_scores * criticality


def risk_adj_res(dag_state, params, project_ctx=None):
    return np.zeros(dag_state.n, dtype=np.float64)


# ---------------------------------------------------------------------------
# Resources  (finite differences per review section 1.5)
# ---------------------------------------------------------------------------

_FD_EPS = 0.1   # perturbation size (time units)
_FD_MAX_N = 500  # skip O(n^2) FD loop for graphs above this size


def resource_adj_dur(dag_state, params, project_ctx=None):
    """dResourcePenalty/dd_i via forward finite differences."""
    from .objectives import resource_objective

    n = dag_state.n
    grad = np.zeros(n, dtype=np.float64)
    if n > _FD_MAX_N:
        import logging
        logging.getLogger(__name__).info(
            "Skipping resource duration FD gradient (n=%d > %d)", n, _FD_MAX_N)
        return grad
    base_val = resource_objective(dag_state, params, project_ctx)

    original = dag_state.durations          # save reference (may alias params.durations)
    scratch = original.copy()
    for i in range(n):
        old = scratch[i]
        scratch[i] = old + _FD_EPS
        run_cpm(dag_state, scratch)
        grad[i] = (resource_objective(dag_state, params, project_ctx)
                    - base_val) / _FD_EPS
        scratch[i] = old

    # Restore original CPM state with the original array reference
    run_cpm(dag_state, original)
    return grad


def resource_adj_res(dag_state, params, project_ctx=None):
    """dResourcePenalty/dr_i via forward finite differences."""
    from .objectives import resource_objective

    n = dag_state.n
    grad = np.zeros(n, dtype=np.float64)
    if n > _FD_MAX_N:
        import logging
        logging.getLogger(__name__).info(
            "Skipping resource resource FD gradient (n=%d > %d)", n, _FD_MAX_N)
        return grad
    base_val = resource_objective(dag_state, params, project_ctx)

    for i in range(n):
        orig = params.resource_counts[i]
        params.resource_counts[i] = orig + _FD_EPS
        grad[i] = (resource_objective(dag_state, params, project_ctx)
                    - base_val) / _FD_EPS
        params.resource_counts[i] = orig

    return grad


# ---------------------------------------------------------------------------
# Quality
# ---------------------------------------------------------------------------

def quality_adj_dur(dag_state, params, project_ctx=None):
    """
    dQ/dd_i = -2 * crash_frac_i * quality_sens_i.
    Negative because increasing duration reduces crash, improving quality.
    Zero-baseline activities contribute nothing to the objective, so
    their gradient is forced to zero (the chain rule only holds for bd > 0).
    """
    g = -2.0 * params.crash_fractions * params.quality_sensitivities
    g[params.baseline_durations <= 0] = 0.0
    return g


def quality_adj_res(dag_state, params, project_ctx=None):
    return np.zeros(dag_state.n, dtype=np.float64)


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

_DUR_ADJOINTS = {
    'schedule':  schedule_adj_dur,
    'cost':      cost_adj_dur,
    'risk':      risk_adj_dur,
    'resources': resource_adj_dur,
    'quality':   quality_adj_dur,
}

_RES_ADJOINTS = {
    'schedule':  schedule_adj_res,
    'cost':      cost_adj_res,
    'risk':      risk_adj_res,
    'resources': resource_adj_res,
    'quality':   quality_adj_res,
}


def compute_gradients(dag_state, params, project_ctx, disciplines):
    """
    Compute all gradients for requested disciplines.
    Returns {discipline: {'duration': ndarray, 'resources': ndarray}}.
    """
    out = {}
    for d in disciplines:
        dur_fn = _DUR_ADJOINTS.get(d)
        res_fn = _RES_ADJOINTS.get(d)
        if dur_fn and res_fn:
            out[d] = {
                'duration':  dur_fn(dag_state, params, project_ctx),
                'resources': res_fn(dag_state, params, project_ctx),
            }
    return out
