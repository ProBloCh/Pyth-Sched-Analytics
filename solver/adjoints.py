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
# Resources
#
# resource_adj_res is analytic via logsumexp-smoothed objective (E1).
# resource_adj_dur is still FD because durations affect the resource
# profile through ES/EF (CPM forward pass) -- the smoothing makes the
# outer function differentiable but not CPM itself.  Reverse-mode AD
# through CPM is the eventual fix; out of scope for E1.
# ---------------------------------------------------------------------------

_FD_EPS = 0.1   # perturbation size (time units) for resource_adj_dur
_FD_MAX_N = 500  # cap on resource_adj_dur (each FD probe runs CPM)


def resource_adj_dur(dag_state, params, project_ctx=None):
    """dResourcePenalty/dd_i via finite differences over CPM.

    Durations affect the resource profile through ES/EF, so each FD
    probe must re-run CPM.  The smoothed objective (E1) is well-
    conditioned at the existing _FD_EPS but doesn't eliminate the
    O(n) CPM evaluations -- the cap stays.
    """
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
    """dResourcePenalty/dr_i analytically.  No FD, no cap.

    Per roadmap item E1.  The smoothed resource_objective (see
    solver/objectives.py) is everywhere differentiable.  Chain rule:

        ∂penalty/∂r_i = Σ_{k ∈ active(i)} (∂penalty/∂profile_k) · 1

    where ``active(i) = [sb_i, eb_i)`` is the half-open bin range
    covered by activity *i* (∂profile_k/∂r_i = 1 over that range,
    0 elsewhere).

    Per-bin gradient of the smoothed penalty:

        ∂penalty/∂profile_k =
            2 · softplus(profile_k - cap, β) · sigmoid(β·(profile_k - cap))
              · bin_width

    where softplus comes from numpy.logaddexp and sigmoid from
    scipy.special.expit (numerically stable canonical primitives).
    """
    from scipy.special import expit
    from .objectives import (
        _build_resource_profile, RESOURCE_SMOOTHING_BETA,
    )

    n = dag_state.n
    grad = np.zeros(n, dtype=np.float64)
    built = _build_resource_profile(dag_state, params, project_ctx)
    if built is None:
        return grad

    profile, capacity, bin_width, activity_bins = built
    delta = RESOURCE_SMOOTHING_BETA * (profile - capacity)
    softplus_over_beta = np.logaddexp(0.0, delta) / RESOURCE_SMOOTHING_BETA
    sigmoid = expit(delta)
    per_bin_grad = 2.0 * softplus_over_beta * sigmoid * bin_width

    for i in range(n):
        rc = params.resource_counts[i]
        if rc <= 0:
            continue
        sb, eb = activity_bins[i]
        if eb > sb:
            grad[i] = float(per_bin_grad[sb:eb].sum())

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
