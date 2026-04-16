"""
solver/stochastic.py - Monte Carlo ensemble with Sobol quasi-random sequences.

Uses Sobol low-discrepancy sequences (scipy.stats.qmc) for better
space-filling than pseudorandom sampling.  Falls back to pseudorandom
for dimensions beyond the Sobol limit.  Antithetic variates remain
available as a complementary variance-reduction technique.
"""

import logging
import time
import numpy as np
from .dag import run_cpm
from .objectives import compute_objectives
from .adjoints import compute_gradients

logger = logging.getLogger(__name__)

# scipy.stats.qmc.Sobol supports up to 21201 dimensions
_SOBOL_MAX_DIM = 21201


def _generate_samples(M, n, antithetic, seed=42):
    """
    Generate standard-normal samples.

    Uses Sobol QMC when n <= 21201 (better space-filling, lower
    discrepancy).  Falls back to pseudorandom for higher dimensions
    where QMC benefits diminish.  Returns (z_all, M_actual).
    """
    if n <= _SOBOL_MAX_DIM:
        from scipy.stats.qmc import Sobol
        from scipy.stats import norm

        if antithetic:
            half = max(M // 2, 1)
            half_pow2 = 1 << max(int(np.ceil(np.log2(max(half, 1)))), 0)
            sobol = Sobol(d=n, scramble=True, seed=seed)
            u = sobol.random(half_pow2)
            z = norm.ppf(np.clip(u, 1e-10, 1 - 1e-10))
            z_all = np.concatenate([z, -z], axis=0)
            M_actual = 2 * half_pow2
        else:
            M_pow2 = 1 << max(int(np.ceil(np.log2(max(M, 1)))), 0)
            sobol = Sobol(d=n, scramble=True, seed=seed)
            u = sobol.random(M_pow2)
            z_all = norm.ppf(np.clip(u, 1e-10, 1 - 1e-10))
            M_actual = M_pow2

        logger.info("Sobol QMC: requested M=%d, actual M=%d, n=%d, "
                     "antithetic=%s", M, M_actual, n, antithetic)
    else:
        # Fallback: pseudorandom (QMC benefit diminishes in very high dim)
        rng = np.random.default_rng(seed=seed)
        if antithetic:
            half = max(M // 2, 1)
            z = rng.standard_normal((half, n))
            z_all = np.concatenate([z, -z], axis=0)
            M_actual = 2 * half
        else:
            z_all = rng.standard_normal((M, n))
            M_actual = M

        logger.info("Pseudorandom MC (n=%d > Sobol max %d): M=%d",
                     n, _SOBOL_MAX_DIM, M_actual)

    return z_all, M_actual


def run_ensemble(dag_state, params, project_ctx, config):
    """
    Monte Carlo ensemble over duration uncertainty.

    Returns {
        objectives_mean, objectives_std,
        gradients_mean, gradients_std,
        n_samples
    }
    """
    t0 = time.time()
    M = config.monte_carlo_samples
    disciplines = config.disciplines
    n = dag_state.n

    if n == 0:
        return _empty(disciplines)

    logger.info("MC ensemble start: M=%d, n=%d, antithetic=%s",
                M, n, config.antithetic_variates)

    z_all, M = _generate_samples(M, n, config.antithetic_variates)
    sigma = 0.15  # 15 % CV on durations (log-normal)

    # Resource FD gradients are O(n) CPM runs per sample.  When the total
    # cost n*M is large, compute them once on the original state and keep
    # only the cheap analytical disciplines inside the MC loop.
    _FD_BUDGET = 50_000
    expensive_fd = 'resources' in disciplines and n * M > _FD_BUDGET
    loop_disciplines = [d for d in disciplines if d != 'resources'] if expensive_fd else disciplines

    obj_samples  = {d: [] for d in disciplines}
    grad_dur_acc = {d: [] for d in disciplines}
    grad_res_acc = {d: [] for d in disciplines}

    # Save original array references so we can restore aliasing after the loop.
    orig_dag_dur   = dag_state.durations
    orig_param_dur = params.durations
    saved_values   = orig_dag_dur.copy()

    for m in range(M):
        perturbed = saved_values * np.exp(sigma * z_all[m])
        perturbed = np.maximum(perturbed, params.min_durations)

        run_cpm(dag_state, perturbed)
        params.durations = perturbed

        objs  = compute_objectives(dag_state, params, project_ctx, disciplines)
        grads = compute_gradients(dag_state, params, project_ctx, loop_disciplines)

        for d in disciplines:
            obj_samples[d].append(objs.get(d, 0.0))
            if d in grads:
                grad_dur_acc[d].append(grads[d]['duration'].copy())
                grad_res_acc[d].append(grads[d]['resources'].copy())

    # Restore original state: write values back into original arrays
    # and re-alias dag_state.durations to the original reference.
    np.copyto(orig_dag_dur, saved_values)
    np.copyto(orig_param_dur, saved_values)
    run_cpm(dag_state, orig_dag_dur)
    params.durations = orig_param_dur

    # Compute resource FD gradients once on the original state when they
    # were excluded from the per-sample loop to avoid O(M*n) CPM runs.
    if expensive_fd:
        logger.info("Resource FD budget exceeded (n*M=%d > %d); "
                    "computing resource gradients on original/nominal state",
                    n * M, _FD_BUDGET)
        res_grads = compute_gradients(dag_state, params, project_ctx,
                                      ['resources'])
        if 'resources' in res_grads:
            grad_dur_acc['resources'] = [res_grads['resources']['duration']]
            grad_res_acc['resources'] = [res_grads['resources']['resources']]

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

    logger.info("MC ensemble done: %d samples, %.1fs", M, time.time() - t0)
    return result


def _empty(disciplines):
    return {
        'objectives_mean': {d: 0.0 for d in disciplines},
        'objectives_std':  {d: 0.0 for d in disciplines},
        'gradients_mean':  {},
        'gradients_std':   {},
        'n_samples': 0,
    }
