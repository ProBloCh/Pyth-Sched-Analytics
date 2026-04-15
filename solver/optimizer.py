"""
solver/optimizer.py - Projected gradient descent.

Minimises a weighted sum of objectives subject to box constraints:
  - duration:  min_duration_i  <=  d_i  <=  baseline_duration_i
  - resources: r_i >= 1
"""

import logging
import time
import numpy as np
from .dag import run_cpm
from .objectives import compute_objectives
from .adjoints import compute_gradients

logger = logging.getLogger(__name__)

WALL_TIME_LIMIT = 120  # seconds — safety net; Gunicorn --timeout is primary


def optimize(dag_state, params, project_ctx, config, deadline=None):
    """
    Run projected gradient descent.

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
    # Floor of 1.0 prevents near-zero objectives (e.g. quality=0 at
    # baseline) from producing enormous normalisation coefficients that
    # would artificially dominate the weighted sum.
    scales = {d: max(abs(initial.get(d, 0.0)), 1.0) for d in disciplines}

    lr = config.learning_rate
    history = []
    converged = False
    timed_out = False
    prev_w = None

    logger.info("Optimizer start: %d activities, %d disciplines, "
                "max_iter=%d, lr=%.4f",
                n, len(disciplines), config.max_iterations, lr)

    for it in range(config.max_iterations):
        # Wall-time guard
        if time.time() > deadline:
            logger.warning("Optimizer hit wall-time limit after %d iterations "
                           "(%.1fs)", it, time.time() - t0)
            timed_out = True
            break

        objs = compute_objectives(dag_state, params, project_ctx, disciplines)
        w_obj = sum(weights.get(d, 0.0) * objs.get(d, 0.0) / scales[d]
                    for d in disciplines)

        history.append({
            'iteration': it,
            'weighted_objective': float(w_obj),
            'objectives': {d: float(objs.get(d, 0.0)) for d in disciplines},
        })

        # Convergence
        if prev_w is not None:
            rel = abs(w_obj - prev_w) / max(abs(prev_w), 1e-12)
            if rel < config.convergence_threshold:
                converged = True
                logger.info("Optimizer converged at iteration %d "
                            "(rel_change=%.2e)", it, rel)
                break
        prev_w = w_obj

        # Gradients
        grads = compute_gradients(dag_state, params, project_ctx, disciplines)
        dur_g = np.zeros(n, dtype=np.float64)
        res_g = np.zeros(n, dtype=np.float64)
        for d in disciplines:
            coeff = weights.get(d, 0.0) / scales[d]
            if d in grads:
                dur_g += coeff * grads[d]['duration']
                res_g += coeff * grads[d]['resources']

        # Step
        params.durations      -= lr * dur_g
        params.resource_counts -= lr * res_g

        # Project onto feasible set
        _project(params)
        run_cpm(dag_state, params.durations)

    elapsed = time.time() - t0
    logger.info("Optimizer done: %d iterations, converged=%s, %.1fs",
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


def _project(params):
    """Box-constraint projection."""
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
