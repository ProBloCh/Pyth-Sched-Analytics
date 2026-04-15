"""
solver/optimizer.py - Projected gradient descent.

Minimises a weighted sum of objectives subject to box constraints:
  - duration:  min_duration_i  <=  d_i  <=  baseline_duration_i
  - resources: r_i >= 1
"""

import logging
import numpy as np
from .dag import run_cpm
from .objectives import compute_objectives
from .adjoints import compute_gradients

logger = logging.getLogger(__name__)


def optimize(dag_state, params, project_ctx, config):
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

    # Initial objectives and normalisation scales
    initial = compute_objectives(dag_state, params, project_ctx, disciplines)
    scales = {d: max(abs(initial.get(d, 0.0)), 1e-12) for d in disciplines}

    lr = config.learning_rate
    history = []
    converged = False
    prev_w = None

    for it in range(config.max_iterations):
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
