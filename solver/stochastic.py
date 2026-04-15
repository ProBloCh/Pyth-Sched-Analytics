"""
solver/stochastic.py - Monte Carlo ensemble with antithetic variates.

Perturbs activity durations stochastically and computes ensemble statistics
for objectives and gradients.  Antithetic variates (review section 1.8)
halve variance at negligible extra cost.
"""

import numpy as np
from .dag import run_cpm
from .objectives import compute_objectives
from .adjoints import compute_gradients


def run_ensemble(dag_state, params, project_ctx, config):
    """
    Monte Carlo ensemble over duration uncertainty.

    Returns {
        objectives_mean, objectives_std,
        gradients_mean, gradients_std,
        n_samples
    }
    """
    M = config.monte_carlo_samples
    disciplines = config.disciplines
    n = dag_state.n

    if n == 0:
        return _empty(disciplines)

    rng = np.random.default_rng(seed=42)
    sigma = 0.15  # 15 % CV on durations (log-normal)

    if config.antithetic_variates:
        half = M // 2
        z = rng.standard_normal((half, n))
        z_all = np.concatenate([z, -z], axis=0)
        M = 2 * half
    else:
        z_all = rng.standard_normal((M, n))

    obj_samples  = {d: [] for d in disciplines}
    grad_dur_acc = {d: [] for d in disciplines}
    grad_res_acc = {d: [] for d in disciplines}

    saved_dur   = dag_state.durations.copy()
    saved_param = params.durations.copy()

    for m in range(M):
        perturbed = saved_dur * np.exp(sigma * z_all[m])
        perturbed = np.maximum(perturbed, params.min_durations)

        run_cpm(dag_state, perturbed)
        params.durations = perturbed

        objs  = compute_objectives(dag_state, params, project_ctx, disciplines)
        grads = compute_gradients(dag_state, params, project_ctx, disciplines)

        for d in disciplines:
            obj_samples[d].append(objs.get(d, 0.0))
            if d in grads:
                grad_dur_acc[d].append(grads[d]['duration'].copy())
                grad_res_acc[d].append(grads[d]['resources'].copy())

    # Restore original state
    run_cpm(dag_state, saved_dur)
    params.durations = saved_param

    # Statistics
    result = {
        'objectives_mean': {},
        'objectives_std':  {},
        'gradients_mean':  {},
        'gradients_std':   {},
        'n_samples': M,
    }

    for d in disciplines:
        arr = np.array(obj_samples[d])
        result['objectives_mean'][d] = float(np.mean(arr))
        result['objectives_std'][d]  = float(np.std(arr))

        if grad_dur_acc[d]:
            dur_m = np.array(grad_dur_acc[d])
            res_m = np.array(grad_res_acc[d])
            result['gradients_mean'][d] = {
                'duration':  np.mean(dur_m, axis=0),
                'resources': np.mean(res_m, axis=0),
            }
            result['gradients_std'][d] = {
                'duration':  float(np.mean(np.std(dur_m, axis=0))),
                'resources': float(np.mean(np.std(res_m, axis=0))),
            }

    return result


def _empty(disciplines):
    return {
        'objectives_mean': {d: 0.0 for d in disciplines},
        'objectives_std':  {d: 0.0 for d in disciplines},
        'gradients_mean':  {},
        'gradients_std':   {},
        'n_samples': 0,
    }
