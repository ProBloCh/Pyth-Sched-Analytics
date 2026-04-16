"""
solver/stochastic.py - Monte Carlo ensemble with risk-tiered distributions.

Matches the frontend's four-tier uncertainty model:
  < 6%  risk:  no perturbation (below noise floor)
  6-18% risk:  triangular (right-skewed, bounded)
  18-55% risk: normal (σ ∝ risk, moderate tails)
  ≥ 55% risk:  Birnbaum-Saunders (fat tail for extreme overruns)

Supply-chain activities (equipment, material, services) hit the fat-tail
threshold earlier.  Duration-sensitive caps prevent unrealistic multipliers
on short low-risk activities while allowing long high-risk activities
the range they need.

Uses Sobol quasi-Monte Carlo sequences (scipy.stats.qmc) for better
space-filling.  Includes black swan and dragon king detection.
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

# Supply-chain activities hit the fat-tail threshold earlier
_FAT_TAIL_THRESHOLDS = {
    'equipment': 0.35,
    'material':  0.40,
    'materials': 0.40,
    'services':  0.45,
    'service':   0.45,
}
_DEFAULT_FAT_TAIL = 0.55


# ---------------------------------------------------------------------------
# Sample generation (Sobol QMC → uniform [0,1])
# ---------------------------------------------------------------------------

def _generate_samples(M, n, antithetic, seed=42):
    """
    Generate uniform [0,1] samples using Sobol QMC when feasible.

    Antithetic variates use u and (1-u) pairs, which map to opposite
    tails regardless of the target distribution.
    """
    if n <= _SOBOL_MAX_DIM:
        from scipy.stats.qmc import Sobol

        if antithetic:
            half = max(M // 2, 1)
            half_pow2 = 1 << max(int(np.ceil(np.log2(max(half, 1)))), 0)
            sobol = Sobol(d=n, scramble=True, seed=seed)
            u = sobol.random(half_pow2)
            u_all = np.concatenate([u, 1.0 - u], axis=0)
            M_actual = 2 * half_pow2
        else:
            M_pow2 = 1 << max(int(np.ceil(np.log2(max(M, 1)))), 0)
            sobol = Sobol(d=n, scramble=True, seed=seed)
            u_all = sobol.random(M_pow2)
            M_actual = M_pow2

        logger.info("Sobol QMC: requested M=%d, actual M=%d, n=%d, "
                     "antithetic=%s", M, M_actual, n, antithetic)
    else:
        rng = np.random.default_rng(seed=seed)
        if antithetic:
            half = max(M // 2, 1)
            u = rng.random((half, n))
            u_all = np.concatenate([u, 1.0 - u], axis=0)
            M_actual = 2 * half
        else:
            u_all = rng.random((M, n))
            M_actual = M

        logger.info("Pseudorandom MC (n=%d > Sobol max %d): M=%d",
                     n, _SOBOL_MAX_DIM, M_actual)

    # Clip boundaries to avoid ppf singularities at 0 and 1
    u_all = np.clip(u_all, 1e-10, 1.0 - 1e-10)
    return u_all, M_actual


# ---------------------------------------------------------------------------
# Distribution helpers (vectorised)
# ---------------------------------------------------------------------------

def _triangular_ppf(u, low, mode, high):
    """Vectorised triangular distribution inverse CDF."""
    span = np.maximum(high - low, 1e-12)
    fc = (mode - low) / span
    x = np.empty_like(u, dtype=np.float64)
    left = u < fc
    right = ~left
    if np.any(left):
        x[left] = low[left] + np.sqrt(
            u[left] * span[left] * (mode[left] - low[left]))
    if np.any(right):
        x[right] = high[right] - np.sqrt(
            (1.0 - u[right]) * span[right] * (high[right] - mode[right]))
    return x


def _bs_ppf(u, alpha, beta):
    """Vectorised Birnbaum-Saunders inverse CDF.

    BS was originally a fatigue-life model (materials failing under
    cyclic stress) — maps naturally to schedule activities that can
    "fail" under accumulated project stress.
    """
    from scipy.stats import norm as _norm
    z = _norm.ppf(u)
    half_az = alpha * z / 2.0
    return beta * (half_az + np.sqrt(half_az ** 2 + 1.0)) ** 2


# ---------------------------------------------------------------------------
# Risk-tiered perturbation
# ---------------------------------------------------------------------------

def _fat_tail_thresholds(activity_types, n):
    """Per-activity fat-tail threshold (supply-chain adjusted)."""
    thresh = np.full(n, _DEFAULT_FAT_TAIL)
    if activity_types and len(activity_types) == n:
        for i, atype in enumerate(activity_types):
            if atype in _FAT_TAIL_THRESHOLDS:
                thresh[i] = _FAT_TAIL_THRESHOLDS[atype]
    return thresh


def _compute_raw_multipliers(u, risk, fat_thresh):
    """
    Per-activity raw duration multipliers from the four-tier model.

    Risk thresholds match the frontend (Completionprediction.js):
      < 6%:       noise floor → multiplier = 1.0
      6–18%:      triangular (right-skewed, bounded)
      18–fat_t:   normal (σ = risk)
      ≥ fat_t:    Birnbaum-Saunders (α = 0.25+0.65r, β = 1.0+0.1r)
    """
    n = len(risk)
    mult = np.ones(n, dtype=np.float64)

    # Tier masks
    tri_mask    = (risk >= 0.06) & (risk < 0.18)
    norm_mask   = (risk >= 0.18) & (risk < fat_thresh)
    bs_mask     = risk >= fat_thresh

    # Tier 2: triangular (right-skewed)
    if np.any(tri_mask):
        r = risk[tri_mask]
        low  = np.maximum(0.9, 1.0 - r)
        mode = np.ones_like(r)
        high = 1.0 + 2.0 * r
        mult[tri_mask] = _triangular_ppf(u[tri_mask], low, mode, high)

    # Tier 3: normal (σ proportional to risk)
    if np.any(norm_mask):
        from scipy.stats import norm as _norm
        r = risk[norm_mask]
        z = _norm.ppf(u[norm_mask])
        mult[norm_mask] = np.maximum(0.5, 1.0 + z * r)

    # Tier 4: Birnbaum-Saunders (fat tail)
    if np.any(bs_mask):
        r = risk[bs_mask]
        alpha = 0.25 + 0.65 * r
        beta  = 1.00 + 0.10 * r
        mult[bs_mask] = _bs_ppf(u[bs_mask], alpha, beta)

    return np.maximum(mult, 0.1)  # absolute floor


def _compute_caps(risk, durations):
    """Duration-sensitive caps: lerp(2.0, 6.0, risk * dur_fraction).

    Short low-risk activities: capped at ~2×.
    Long high-risk activities: allowed up to 6×.
    """
    max_dur = np.max(durations) if len(durations) > 0 else 1.0
    dur_frac = durations / max(max_dur, 1e-9)
    return 2.0 + 4.0 * np.minimum(1.0, risk * dur_frac)


# ---------------------------------------------------------------------------
# Black swan / dragon king detection
# ---------------------------------------------------------------------------

def _detect_extremes(raw_max, raw_mean, raw_std, cap_hits, M, caps,
                     risk_scores, activity_types, ids):
    """
    Identify extreme-risk activities from MC multiplier statistics.

    Black swans:  activities that regularly hit the duration cap —
                  extreme overruns are not rare but recurring.
    Dragon kings: activities where the worst-case scenario dwarfs
                  even the expected tail behaviour (outlier among
                  outliers).
    """
    n = len(ids)
    risk = np.clip(risk_scores / 10.0, 0.0, 1.0)

    black_swans = []
    dragon_kings = []

    for i in range(n):
        # Skip noise-floor activities
        if risk[i] < 0.06:
            continue

        cap_rate = cap_hits[i] / max(M, 1)

        # Black swan: cap is hit in ≥ 10% of scenarios
        if cap_rate >= 0.10:
            tier = _tier_label(risk[i],
                               activity_types[i] if activity_types else '')
            black_swans.append({
                'activity_id':    ids[i],
                'risk_score':     round(float(risk_scores[i]), 2),
                'risk_tier':      tier,
                'cap_hit_rate':   round(float(cap_rate), 3),
                'max_multiplier': round(float(raw_max[i]), 3),
                'mean_multiplier': round(float(raw_mean[i]), 3),
                'cap_value':      round(float(caps[i]), 2),
            })

        # Dragon king: max is > 4σ above the mean AND exceeds 2×
        if raw_std[i] > 1e-9:
            sigma_excess = (raw_max[i] - raw_mean[i]) / raw_std[i]
            if sigma_excess > 4.0 and raw_max[i] > 2.0:
                dragon_kings.append({
                    'activity_id':    ids[i],
                    'risk_score':     round(float(risk_scores[i]), 2),
                    'max_multiplier': round(float(raw_max[i]), 3),
                    'mean_multiplier': round(float(raw_mean[i]), 3),
                    'sigma_excess':   round(float(sigma_excess), 1),
                })

    black_swans.sort(key=lambda x: x['cap_hit_rate'], reverse=True)
    dragon_kings.sort(key=lambda x: x['sigma_excess'], reverse=True)
    return black_swans, dragon_kings


def _tier_label(risk_norm, activity_type):
    """Human-readable risk tier label."""
    fat_t = _FAT_TAIL_THRESHOLDS.get(
        activity_type.lower() if isinstance(activity_type, str) else '',
        _DEFAULT_FAT_TAIL)
    if risk_norm < 0.06:
        return 'noise_floor'
    if risk_norm < 0.18:
        return 'triangular'
    if risk_norm < fat_t:
        return 'normal'
    return 'birnbaum_saunders'


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_ensemble(dag_state, params, project_ctx, config):
    """
    Monte Carlo ensemble over duration uncertainty using risk-tiered
    distributions.

    Returns {
        objectives_mean, objectives_std,
        gradients_mean, gradients_std,
        n_samples,
        black_swans, dragon_kings
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

    u_all, M = _generate_samples(M, n, config.antithetic_variates)

    # Pre-compute risk parameters
    risk = np.clip(params.risk_scores / 10.0, 0.0, 1.0)
    fat_thresh = _fat_tail_thresholds(params.activity_types, n)
    caps = _compute_caps(risk, params.durations)

    # Resource FD gradients are O(n) CPM runs per sample.  When the total
    # cost n*M is large, compute them once on the original state and keep
    # only the cheap analytical disciplines inside the MC loop.
    _FD_BUDGET = 50_000
    expensive_fd = 'resources' in disciplines and n * M > _FD_BUDGET
    loop_disciplines = ([d for d in disciplines if d != 'resources']
                        if expensive_fd else disciplines)

    obj_samples  = {d: [] for d in disciplines}
    grad_dur_acc = {d: [] for d in disciplines}
    grad_res_acc = {d: [] for d in disciplines}

    # Multiplier statistics for extreme-event detection (O(n) memory)
    raw_max    = np.zeros(n, dtype=np.float64)
    raw_sum    = np.zeros(n, dtype=np.float64)
    raw_sum_sq = np.zeros(n, dtype=np.float64)
    cap_hits   = np.zeros(n, dtype=np.int64)

    # Save original array references so we can restore aliasing after the loop.
    orig_dag_dur   = dag_state.durations
    orig_param_dur = params.durations
    saved_values   = orig_dag_dur.copy()

    for m in range(M):
        # Risk-tiered multipliers (matching Completionprediction.js tiers)
        raw_mult = _compute_raw_multipliers(u_all[m], risk, fat_thresh)
        capped_mult = np.minimum(raw_mult, caps)
        capped_mult = np.maximum(capped_mult, 0.1)

        # Track raw statistics for black-swan / dragon-king detection
        raw_max    = np.maximum(raw_max, raw_mult)
        raw_sum   += raw_mult
        raw_sum_sq += raw_mult ** 2
        cap_hits  += (raw_mult >= caps * 0.95).astype(np.int64)

        perturbed = saved_values * capped_mult
        perturbed = np.maximum(perturbed, params.min_durations)

        run_cpm(dag_state, perturbed)
        params.durations = perturbed

        objs  = compute_objectives(dag_state, params, project_ctx, disciplines)
        grads = compute_gradients(dag_state, params, project_ctx,
                                  loop_disciplines)

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

    # Objective / gradient statistics
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

    # Extreme-event detection
    raw_mean = raw_sum / max(M, 1)
    raw_var  = raw_sum_sq / max(M, 1) - raw_mean ** 2
    raw_std  = np.sqrt(np.maximum(raw_var, 0.0))

    black_swans, dragon_kings = _detect_extremes(
        raw_max, raw_mean, raw_std, cap_hits, M, caps,
        params.risk_scores, params.activity_types, params.ids)

    result['black_swans']  = black_swans
    result['dragon_kings'] = dragon_kings

    logger.info("MC ensemble done: %d samples, %d black swans, "
                "%d dragon kings, %.1fs",
                M, len(black_swans), len(dragon_kings), time.time() - t0)
    return result


def _empty(disciplines):
    return {
        'objectives_mean': {d: 0.0 for d in disciplines},
        'objectives_std':  {d: 0.0 for d in disciplines},
        'gradients_mean':  {},
        'gradients_std':   {},
        'n_samples':       0,
        'black_swans':     [],
        'dragon_kings':    [],
    }
