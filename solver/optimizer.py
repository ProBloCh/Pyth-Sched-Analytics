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

    return {
        'optimized_durations':  params.durations.copy(),
        'optimized_resources':  params.resource_counts.copy(),
        'initial_objectives':   {d: float(v) for d, v in initial.items()},
        'final_objectives':     {d: float(v) for d, v in final.items()},
        'iterations': len(history),
        'converged':  converged,
        'history':    history,
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
    }
