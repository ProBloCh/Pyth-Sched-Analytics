"""
solver/optimizer.py - L-BFGS-B optimisation with box constraints.

Uses scipy.optimize.minimize(method='L-BFGS-B') for quasi-Newton
convergence with built-in Wolfe-condition line search.  Supports
weighted-sum and augmented Tchebycheff scalarisation (the latter
can find points on non-convex Pareto frontiers).
"""

import logging
import time
import numpy as np
from scipy.optimize import minimize as sp_minimize
from .dag import run_cpm
from .objectives import compute_objectives
from .adjoints import compute_gradients

logger = logging.getLogger(__name__)

WALL_TIME_LIMIT = 120  # seconds — safety net; Gunicorn --timeout is primary

# Quadratic-penalty weight for hard constraints (max_makespan, max_budget).
# The penalty is normalised by the constraint's bound so it is dimensionless,
# i.e. a 100% violation contributes ``CONSTRAINT_PENALTY_LAMBDA`` to the
# weighted objective.  50.0 is a moderate setting -- large enough to dominate
# the discipline weights when the bound is meaningfully exceeded, small
# enough that a feasible interior solution still sees the discipline tradeoff.
CONSTRAINT_PENALTY_LAMBDA = 50.0


def optimize(dag_state, params, project_ctx, config, deadline=None,
             utopia=None, augmentation_rho=0.05):
    """
    Run L-BFGS-B optimisation with box constraints.

    When *utopia* is provided, uses augmented Tchebycheff scalarisation
    (smooth-max approximation) so the Pareto sweep can reach non-convex
    frontier regions.  Otherwise uses the standard weighted sum.

    Returns {
        optimized_durations, optimized_resources,
        initial_objectives, final_objectives,
        iterations, converged, history
    }
    """
    n = dag_state.n
    disciplines = config.disciplines
    weights = config.weights

    if n == 0:
        return _empty(disciplines)

    t0 = time.time()
    if deadline is None:
        deadline = t0 + WALL_TIME_LIMIT

    # Initial objectives and normalisation scales
    initial = compute_objectives(dag_state, params, project_ctx, disciplines)
    scales = {d: max(abs(initial.get(d, 0.0)), 1.0) for d in disciplines}

    history = []
    _best = {'x': None, 'f': float('inf')}

    # ---- Pack / unpack durations + resources into a flat vector ----------
    def pack():
        return np.concatenate([params.durations.copy(),
                               params.resource_counts.copy()])

    def unpack(x):
        params.durations[:] = x[:n]
        params.resource_counts[:] = x[n:]

    # ---- Box bounds ------------------------------------------------------
    bounds = list(zip(
        np.concatenate([params.min_durations, np.ones(n)]),
        np.concatenate([params.baseline_durations, np.full(n, 1e12)]),
    ))

    # ---- Tchebycheff constants -------------------------------------------
    _kappa = 20.0    # smooth-max sharpness (log-sum-exp)

    # ---- Hard-constraint setup ------------------------------------------
    max_makespan = getattr(project_ctx, 'max_makespan', None)
    max_budget = getattr(project_ctx, 'max_budget', None)
    constraints_active = (max_makespan is not None) or (max_budget is not None)
    if constraints_active:
        logger.info(
            "Hard constraints active: max_makespan=%s, max_budget=%s, "
            "lambda=%.1f",
            max_makespan, max_budget, CONSTRAINT_PENALTY_LAMBDA)

    # ---- Objective + gradient callback -----------------------------------
    def func_and_grad(x):
        if time.time() > deadline:
            raise _Timeout()

        unpack(x)
        run_cpm(dag_state, params.durations)

        objs = compute_objectives(dag_state, params, project_ctx, disciplines)
        grads = compute_gradients(dag_state, params, project_ctx, disciplines)

        dur_g = np.zeros(n, dtype=np.float64)
        res_g = np.zeros(n, dtype=np.float64)

        if utopia is not None:
            # Augmented Tchebycheff: smooth_max(terms) + rho * sum(terms)
            terms = np.array([
                weights.get(d, 0.0)
                * (objs.get(d, 0.0) - utopia.get(d, 0.0))
                / scales[d]
                for d in disciplines
            ])
            # Numerically stable log-sum-exp
            t_max = np.max(terms)
            exp_s = np.exp(_kappa * (terms - t_max))
            sum_exp = np.sum(exp_s)
            lse = t_max + np.log(sum_exp) / _kappa
            w_obj = float(lse + augmentation_rho * np.sum(terms))

            softmax = exp_s / sum_exp
            for idx, d in enumerate(disciplines):
                coeff = ((softmax[idx] + augmentation_rho)
                         * weights.get(d, 0.0) / scales[d])
                if d in grads:
                    dur_g += coeff * grads[d]['duration']
                    res_g += coeff * grads[d]['resources']
        else:
            # Standard weighted sum
            w_obj = float(sum(
                weights.get(d, 0.0) * objs.get(d, 0.0) / scales[d]
                for d in disciplines
            ))
            for d in disciplines:
                coeff = weights.get(d, 0.0) / scales[d]
                if d in grads:
                    dur_g += coeff * grads[d]['duration']
                    res_g += coeff * grads[d]['resources']

        # ---- Constraint penalties (added on top of the scalarised obj) --
        # The penalty writes its gradient contribution directly into
        # dur_g / res_g (in-place) so we don't allocate two extra
        # O(n) temporaries on every L-BFGS-B evaluation.
        if constraints_active:
            w_obj += _constraint_penalty(
                dag_state, params, project_ctx, objs,
                max_makespan, max_budget, grads,
                dur_g, res_g)

        history.append({
            'iteration': len(history),
            'weighted_objective': w_obj,
            'objectives': {d: float(objs.get(d, 0.0)) for d in disciplines},
        })

        if w_obj < _best['f']:
            _best['x'] = x.copy()
            _best['f'] = w_obj

        return w_obj, np.concatenate([dur_g, res_g])

    # ---- Run L-BFGS-B ----------------------------------------------------
    logger.info("Optimizer start (L-BFGS-B): %d activities, %d disciplines, "
                "max_iter=%d, tchebycheff=%s",
                n, len(disciplines), config.max_iterations,
                utopia is not None)

    x0 = pack()
    converged = False

    try:
        result = sp_minimize(
            func_and_grad, x0, method='L-BFGS-B', jac=True,
            bounds=bounds,
            options={
                'maxiter': config.max_iterations,
                'ftol': config.convergence_threshold,
                'gtol': config.convergence_threshold,
                'maxfun': config.max_iterations * 5,
            },
        )
        unpack(result.x)
        run_cpm(dag_state, params.durations)
        converged = result.success
    except _Timeout:
        logger.warning("Optimizer hit wall-time limit after %d evaluations "
                       "(%.1fs)", len(history), time.time() - t0)
        if _best['x'] is not None:
            unpack(_best['x'])
        _project(params)
        run_cpm(dag_state, params.durations)

    elapsed = time.time() - t0
    logger.info("Optimizer done: %d evaluations, converged=%s, %.1fs",
                len(history), converged, elapsed)

    final = compute_objectives(dag_state, params, project_ctx, disciplines)

    constraints_report = None
    if constraints_active:
        constraints_report = build_constraints_report(
            dag_state, params, final, max_makespan, max_budget)

    return {
        'optimized_durations':  params.durations.copy(),
        'optimized_resources':  params.resource_counts.copy(),
        'initial_objectives':   {d: float(v) for d, v in initial.items()},
        'final_objectives':     {d: float(v) for d, v in final.items()},
        'iterations': len(history),
        'converged':  converged,
        'history':    history,
        'constraints': constraints_report,
    }


class _Timeout(Exception):
    """Raised when wall-time limit is exceeded during optimisation."""


def _project(params):
    """Box-constraint projection (safety net for timeout recovery)."""
    np.clip(params.durations,
            params.min_durations, params.baseline_durations,
            out=params.durations)
    np.maximum(params.resource_counts, 1.0, out=params.resource_counts)


def _empty(disciplines):
    return {
        'optimized_durations':  np.array([]),
        'optimized_resources':  np.array([]),
        'initial_objectives':   {d: 0.0 for d in disciplines},
        'final_objectives':     {d: 0.0 for d in disciplines},
        'iterations': 0,
        'converged':  True,
        'history':    [],
        'constraints': None,
    }


def _constraint_penalty(dag_state, params, project_ctx, objs,
                        max_makespan, max_budget, grads,
                        out_dur_g, out_res_g):
    """Quadratic-penalty contribution from hard constraints.

    Adds the penalty's gradient contribution **in place** to the
    caller's ``out_dur_g`` / ``out_res_g`` buffers (which already
    hold the discipline-objective gradients), and returns just the
    scalar penalty value.  This avoids two fresh ``np.zeros(n)``
    allocations per L-BFGS-B evaluation -- on a 10K-activity project
    with 50 iterations, that's 100 wasted O(n) allocations otherwise.

    Each constraint contributes
        L * max(0, val - bound)^2 / bound^2
    so the magnitude is dimensionless and a 100% overshoot adds ``L``
    to the weighted objective.  Gradients reuse the analytic schedule
    and cost gradients already in ``grads`` -- no additional CPM
    evaluations needed.
    """
    pen = 0.0
    L = CONSTRAINT_PENALTY_LAMBDA

    if max_makespan is not None and max_makespan > 0:
        violation = dag_state.makespan - max_makespan
        if violation > 0:
            inv_b2 = 1.0 / (max_makespan * max_makespan)
            pen += L * violation * violation * inv_b2
            coeff = 2.0 * L * violation * inv_b2
            sched = grads.get('schedule')
            if sched is not None:
                out_dur_g += coeff * sched['duration']
                out_res_g += coeff * sched['resources']
            else:
                # Fallback: schedule not in disciplines.  Use the
                # critical mask directly (dMakespan/dd_i = 1 on CP).
                out_dur_g[dag_state.critical_mask] += coeff

    if max_budget is not None and max_budget > 0:
        cost = float(objs.get('cost', 0.0))
        if 'cost' not in objs:
            # Compute cost on demand if not in disciplines.
            cost = float(np.sum(
                params.resource_rates * params.resource_counts
                * params.durations))
        violation = cost - max_budget
        if violation > 0:
            inv_b2 = 1.0 / (max_budget * max_budget)
            pen += L * violation * violation * inv_b2
            coeff = 2.0 * L * violation * inv_b2
            cost_g = grads.get('cost')
            if cost_g is not None:
                out_dur_g += coeff * cost_g['duration']
                out_res_g += coeff * cost_g['resources']
            else:
                # Analytic cost gradients (reproduce adjoints.cost_adj_*).
                out_dur_g += coeff * (params.resource_rates
                                      * params.resource_counts)
                out_res_g += coeff * (params.resource_rates
                                      * params.durations)

    return pen


def build_constraints_report(dag_state, params, final_objs,
                             max_makespan, max_budget):
    """Per-constraint feasibility status for the response.

    Reused by both /solver/optimize (which reports the post-
    optimisation state) and /solver/sensitivity (which reports the
    current-baseline state without applying any penalty -- useful as a
    pre-flight feasibility check before kicking off the optimiser).
    """
    out = {}
    if max_makespan is not None:
        violation = max(0.0, dag_state.makespan - max_makespan)
        out['max_makespan'] = {
            'bound':         float(max_makespan),
            'final_value':   float(dag_state.makespan),
            'violation':     float(violation),
            'satisfied':     violation <= 1e-6 * max(max_makespan, 1.0),
        }
    if max_budget is not None:
        if 'cost' in final_objs:
            cost = float(final_objs['cost'])
        else:
            # Cost wasn't an active discipline; compute analytically so
            # the report still reflects the actual final-state spend.
            cost = float(np.sum(
                params.resource_rates * params.resource_counts
                * params.durations))
        violation = max(0.0, cost - max_budget)
        out['max_budget'] = {
            'bound':         float(max_budget),
            'final_value':   cost,
            'violation':     float(violation),
            'satisfied':     violation <= 1e-6 * max(max_budget, 1.0),
        }
    return out or None
