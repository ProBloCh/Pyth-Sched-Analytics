"""
solver/stochastic.py - Monte Carlo ensemble with risk-tiered distributions.

Five-tier uncertainty model grounded in Natarajan & Flyvbjerg (PMJ, 2022)
and Flyvbjerg et al. (JMIS, 2022):
  < 6%  risk:  no perturbation (below noise floor)
  6-18% risk:  triangular (right-skewed, bounded)
  18-BS% risk: normal (σ ∝ risk, moderate tails)
  BS-P% risk:  Birnbaum-Saunders (fat tail — best fit for offshore O&G
               overruns per Natarajan et al., KS p=.89 schedule, p=.14 cost)
  ≥ P%  risk:  Pareto power-law (polynomial tail decay — captures the
               α≈2.35 regime from Flyvbjerg's IT project empirical data
               and the infinite-variance regime of Olympics-class projects)

Supply-chain activities (equipment, material, services) hit the fat-tail
and power-law thresholds earlier.  Duration-sensitive caps prevent
unrealistic multipliers on short low-risk activities while allowing long
high-risk activities the range they need.

Uses Sobol quasi-Monte Carlo sequences (scipy.stats.qmc) for better
space-filling.  Includes black swan / dragon king detection and
2D cost-schedule extreme-event clustering (matching Natarajan et al.
Figures 15-17).
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

# Pareto tier activates this many points above the BS threshold.
# Standard: BS from 0.55, Pareto from 0.80
# Equipment: BS from 0.35, Pareto from 0.60
_PARETO_OFFSET = 0.25


# ---------------------------------------------------------------------------
# Sample generation (Sobol QMC → uniform [0,1])
# ---------------------------------------------------------------------------

def _generate_samples(M, n, antithetic, seed=42):
    """
    Generate uniform [0,1] samples using Sobol QMC when feasible.

    Antithetic variates use u and (1-u) pairs, which map to opposite
    tails regardless of the target distribution.  Sobol sequences are
    generated at power-of-2 counts for optimal discrepancy, then
    truncated to the requested M to avoid inflating computation time.
    """
    if M <= 0:
        return np.empty((0, max(n, 1)), dtype=np.float64), 0

    if n <= _SOBOL_MAX_DIM:
        from scipy.stats.qmc import Sobol

        if antithetic:
            half = max(M // 2, 1)
            half_pow2 = 1 << max(int(np.ceil(np.log2(max(half, 1)))), 0)
            sobol = Sobol(d=n, scramble=True, seed=seed)
            u = sobol.random(half_pow2)[:half]  # truncate to requested
            u_all = np.concatenate([u, 1.0 - u], axis=0)
            M_actual = 2 * half
        else:
            M_pow2 = 1 << max(int(np.ceil(np.log2(max(M, 1)))), 0)
            sobol = Sobol(d=n, scramble=True, seed=seed)
            u_all = sobol.random(M_pow2)[:M]  # truncate to requested
            M_actual = M

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


def _bs_ppf_z(z, alpha, beta):
    """Vectorised Birnbaum-Saunders quantile from precomputed z ~ N(0,1).

    BS was originally a fatigue-life model (materials failing under
    cyclic stress) — maps naturally to schedule activities that can
    "fail" under accumulated project stress.
    """
    half_az = alpha * z / 2.0
    return beta * (half_az + np.sqrt(half_az ** 2 + 1.0)) ** 2


def _bs_ppf(u, alpha, beta):
    """Birnbaum-Saunders inverse CDF from uniform u ∈ (0,1)."""
    from scipy.special import ndtri
    return _bs_ppf_z(ndtri(u), alpha, beta)


def _pareto_ppf(u, alpha):
    """Vectorised Pareto (Type I) inverse CDF with x_min=1.

    Power-law tails: P(X > x) ~ x^{-α}.  Empirically validated for
    IT projects at α≈2.35 (Flyvbjerg et al., JMIS 2022).  For α < 2
    the variance is infinite (Olympics regime).

    Parameterisation:
      α = 2.0 + 1.5*(1-risk)  →  risk 0.80 ⇒ α=2.3, risk 1.0 ⇒ α=2.0
    """
    return (1.0 - u) ** (-1.0 / alpha)


def _lognormal_ppf(u, sigma=0.25, mu=0.0):
    """Vectorised lognormal inverse CDF.

    Used as the tier-4 distribution for thin-tailed reference classes
    (roads, standard buildings, solar, onshore wind, battery storage)
    where Birnbaum-Saunders is empirically inappropriate -- those
    sectors don't fit a fatigue-life model and have lighter upper
    tails than BS would imply.

    Parameterisation: lognormal(μ, σ) on the log scale, returning
    multipliers centred near 1.0 with σ controlling the spread.
    Defaults give a moderate right-skewed bump matching Cantarelli /
    Flyvbjerg's observation that thin-tailed sectors still have a
    lognormal-like shape on the upper side.
    """
    from scipy.special import ndtri
    z = ndtri(u)
    return np.exp(mu + sigma * z)


# ---------------------------------------------------------------------------
# Risk-tiered perturbation
# ---------------------------------------------------------------------------

def _fat_tail_thresholds(activity_types, n, default_fat_tail=_DEFAULT_FAT_TAIL):
    """Per-activity fat-tail threshold (supply-chain adjusted).

    Supply-chain activities (equipment/material/services) hit the
    fat-tail threshold earlier than the configurable ``default_fat_tail``
    for all other activity types.
    """
    thresh = np.full(n, default_fat_tail)
    if activity_types and len(activity_types) == n:
        for i, atype in enumerate(activity_types):
            if atype in _FAT_TAIL_THRESHOLDS:
                thresh[i] = _FAT_TAIL_THRESHOLDS[atype]
    return thresh


def _compute_raw_multipliers(u, z, risk, fat_thresh,
                             noise_floor=0.06, normal_from=0.18,
                             pareto_offset=None,
                             tier_4_distribution='birnbaum_saunders',
                             pareto_alpha_range=None):
    """
    Per-activity raw duration multipliers from the five-tier model.

    *z* is the precomputed standard-normal transform of *u* (via
    scipy.special.ndtri), passed in to avoid recomputing it inside
    the MC loop.

    Tiers (risk as fraction 0-1):
      < noise_floor:                no perturbation, multiplier = 1
      noise_floor .. normal_from:   triangular (right-skewed, bounded)
      normal_from .. fat_thresh:    normal (sigma proportional to risk)
      fat_thresh .. pareto_thresh:  TIER 4 distribution (per below)
      >= pareto_thresh:             Pareto power-law

    Tier 4 selection:
      'birnbaum_saunders' (default): historic Natarajan-validated fit
                                     for offshore O&G; α=0.25+0.65r,
                                     β=1.0+0.1r.  Use for fat-tailed
                                     sectors with finite mean.
      'lognormal':                   Thin-tailed sectors (roads, solar,
                                     standard buildings, batteries)
                                     where Flyvbjerg & Gardner 2023
                                     classify the sector as
                                     non-fat-tailed.  σ scales with
                                     risk: σ = 0.05 + 0.5*r.
      'direct_normal_to_pareto'      Reference classes with α <= 1 (IT,
                  (or 'skip'):       Olympics) where Birnbaum-Saunders
                                     cannot represent infinite mean.
                                     The normal tier extends to
                                     ``pareto_thresh`` and Pareto takes
                                     over directly; no separate tier-4
                                     window.  ``'skip'`` is preserved
                                     as a back-compat alias.

    Pareto α:
      pareto_alpha_range=(lo, hi) clamps α per reference class.  When
      None, falls back to the global formula α = 2.0 + 1.5*(1-r).
      Lower α = fatter tail.

    pareto_offset: distance between fat-tail threshold and Pareto
      threshold.  When None, falls back to module default _PARETO_OFFSET
      (0.25).  IT / Olympics use 0.05 to put almost everything in
      the Pareto tail.

    All defaults preserve historic behaviour for callers (solver
    sensitivity / optimize / pareto endpoints) that don't pass class
    overrides.
    """
    n = len(risk)
    mult = np.ones(n, dtype=np.float64)
    if pareto_offset is None:
        pareto_offset = _PARETO_OFFSET
    pareto_thresh = fat_thresh + pareto_offset

    # Tier masks
    tri_mask    = (risk >= noise_floor) & (risk < normal_from)
    # 'skip' is the back-compat alias for 'direct_normal_to_pareto'.
    if tier_4_distribution in ('direct_normal_to_pareto', 'skip'):
        # No tier 4 -- normal tier extends all the way to the Pareto
        # threshold, then Pareto takes over.  Used for IT / Olympics
        # where BS is empirically wrong (alpha <= 1 regimes).
        norm_mask = (risk >= normal_from) & (risk < pareto_thresh)
        bs_mask   = np.zeros(n, dtype=bool)
    else:
        norm_mask = (risk >= normal_from) & (risk < fat_thresh)
        bs_mask   = (risk >= fat_thresh) & (risk < pareto_thresh)
    pareto_mask = risk >= pareto_thresh

    # Tier 2: triangular (right-skewed)
    if np.any(tri_mask):
        r = risk[tri_mask]
        low  = np.maximum(0.9, 1.0 - r)
        mode = np.ones_like(r)
        high = 1.0 + 2.0 * r
        mult[tri_mask] = _triangular_ppf(u[tri_mask], low, mode, high)

    # Tier 3: normal (sigma proportional to risk)
    if np.any(norm_mask):
        r = risk[norm_mask]
        mult[norm_mask] = np.maximum(0.5, 1.0 + z[norm_mask] * r)

    # Tier 4: per-class fat-tail distribution
    if np.any(bs_mask):
        r = risk[bs_mask]
        if tier_4_distribution == 'birnbaum_saunders':
            alpha = 0.25 + 0.65 * r
            beta  = 1.00 + 0.10 * r
            mult[bs_mask] = _bs_ppf_z(z[bs_mask], alpha, beta)
        elif tier_4_distribution == 'lognormal':
            # σ scales gently with risk; mu=0 keeps the median at 1.0
            # and the right tail is naturally bounded vs BS.
            sigma = 0.05 + 0.50 * r
            mult[bs_mask] = _lognormal_ppf(u[bs_mask], sigma=sigma, mu=0.0)
        else:
            # Unknown tier 4 type -> safe fallback to BS so existing
            # behaviour is preserved (defensive; configs are validated
            # at the routes layer).
            alpha = 0.25 + 0.65 * r
            beta  = 1.00 + 0.10 * r
            mult[bs_mask] = _bs_ppf_z(z[bs_mask], alpha, beta)

    # Tier 5: Pareto power-law
    if np.any(pareto_mask):
        r = risk[pareto_mask]
        if pareto_alpha_range is not None:
            alpha_lo, alpha_hi = pareto_alpha_range
            # Linearly interpolate alpha within the class's range as
            # risk goes from pareto_thresh -> 1.0.  Higher risk -> lower
            # alpha -> fatter tail.  Mask pareto_thresh to match r's
            # shape so the broadcast works on tiled inputs.
            pthresh_r = pareto_thresh[pareto_mask]
            t = np.clip((r - pthresh_r) / np.maximum(1.0 - pthresh_r, 1e-9),
                        0.0, 1.0)
            alpha = alpha_hi - (alpha_hi - alpha_lo) * t
            alpha = np.maximum(alpha, 0.5)  # numerical safety
        else:
            alpha = 2.0 + 1.5 * (1.0 - r)
        mult[pareto_mask] = _pareto_ppf(u[pareto_mask], alpha)

    return np.maximum(mult, 0.1)  # absolute floor


def _compute_caps(risk, durations, fat_thresh,
                  pareto_offset=None, max_multiplier_cap=None):
    """Duration-sensitive caps with elevated range for Pareto-tier activities.

    Defaults (no reference class):
      Standard:  lerp(2.0, 6.0, risk × dur_fraction)   -- short low-risk ~2x,
                                                          long high-risk up to 6x
      Pareto:    lerp(4.0, 10.0, risk × dur_fraction)  -- up to 10x for
                                                          Thunderhorse-class
                                                          cascading failures
                                                          (Natarajan PMJ 2022)

    Per-reference-class:
      max_multiplier_cap replaces the Pareto-tier 10x ceiling.  Olympics
      and IT can run 50x; nuclear new build 20x; thin-tailed sectors
      (roads, solar) 3-5x.  See solver/reference_classes.py.
      The standard-tier ceiling scales proportionally so the cap
      hierarchy stays consistent.
    """
    max_dur = np.max(durations) if len(durations) > 0 else 1.0
    dur_frac = durations / max(max_dur, 1e-9)
    blend = np.minimum(1.0, risk * dur_frac)

    if pareto_offset is None:
        pareto_offset = _PARETO_OFFSET
    pareto_thresh = fat_thresh + pareto_offset
    is_pareto = risk >= pareto_thresh

    if max_multiplier_cap is None:
        pareto_ceiling = 10.0
        std_ceiling = 6.0
    else:
        pareto_ceiling = float(max_multiplier_cap)
        # Scale standard-tier ceiling proportionally to keep the
        # 6:10 ratio used in the historic cap design.
        std_ceiling = pareto_ceiling * (6.0 / 10.0)

    # Clamp lerp bases so caps stay monotone (non-decreasing) in blend
    # when a thin-tailed sector sets max_multiplier_cap below the
    # default bases.  Without clamping, pareto_ceiling=3 gave
    # caps = 4.0 at blend=0 -> 3.0 at blend=1 (decreasing), and the
    # standard tier went 2.0 -> 1.8.  With clamping, a cap below the
    # default base flattens the lerp to a constant = ceiling.
    pareto_base = min(4.0, pareto_ceiling)
    std_base    = min(2.0, std_ceiling)

    caps = np.where(
        is_pareto,
        pareto_base + (pareto_ceiling - pareto_base) * blend,
        std_base    + (std_ceiling    - std_base)    * blend,
    )
    return caps


# ---------------------------------------------------------------------------
# Black swan / dragon king detection
# ---------------------------------------------------------------------------

def _detect_extremes(raw_max, raw_mean, raw_std, cap_hits, M, caps,
                     risk_scores, activity_types, ids):
    """
    Identify extreme-risk activities from MC multiplier statistics.

    Black swans:  activities that regularly hit the duration cap
                  (within 5% of cap value) in ≥ 10% of scenarios —
                  extreme overruns are not rare but recurring.
    Dragon kings: activities where the worst-case scenario dwarfs
                  even the expected tail behaviour (outlier among
                  outliers, max > mean + 4σ).
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


def _detect_2d_extremes(obj_samples, disciplines, initial_objectives):
    """
    2D cost-schedule extreme-event clustering.

    Matches Natarajan et al. (PMJ 2022, Figures 15-17): K-means on the
    joint (schedule_overrun, cost_overrun) distribution to identify
    whether extreme scenarios are cost-dominated, schedule-dominated,
    or coupled.  Three clusters (optimal per the paper's WCSS elbow)
    naturally separate the nominal region from the two overrun axes.
    """
    if 'schedule' not in disciplines or 'cost' not in disciplines:
        return None

    sched = np.array(obj_samples['schedule'])
    cost = np.array(obj_samples['cost'])
    M = len(sched)

    if M < 6:
        return None

    # Overrun ratios relative to baseline (initial) objectives
    s_base = max(initial_objectives.get('schedule', 1.0), 1e-9)
    c_base = max(initial_objectives.get('cost', 1.0), 1e-9)
    s_overrun = (sched - s_base) / s_base
    c_overrun = (cost - c_base) / c_base

    from sklearn.cluster import KMeans as _KMeans
    X = np.column_stack([s_overrun, c_overrun])
    k = min(3, M)
    labels = _KMeans(n_clusters=k, n_init='auto', random_state=0).fit_predict(X)

    clusters = []
    for cid in range(k):
        mask = labels == cid
        n_k = int(np.sum(mask))
        if n_k == 0:
            continue
        s_mean = float(np.mean(s_overrun[mask]))
        c_mean = float(np.mean(c_overrun[mask]))

        # Label: which overrun axis dominates?
        if s_mean + c_mean < 0.10:
            label = 'nominal'
        elif s_mean > c_mean * 1.5:
            label = 'schedule_dominated'
        elif c_mean > s_mean * 1.5:
            label = 'cost_dominated'
        else:
            label = 'coupled'

        clusters.append({
            'cluster_id':            cid,
            'label':                 label,
            'n_scenarios':           n_k,
            'pct_scenarios':         round(n_k / M, 3),
            'schedule_overrun_mean': round(s_mean, 3),
            'schedule_overrun_max':  round(float(np.max(s_overrun[mask])), 3),
            'cost_overrun_mean':     round(c_mean, 3),
            'cost_overrun_max':      round(float(np.max(c_overrun[mask])), 3),
        })

    clusters.sort(key=lambda c: c['schedule_overrun_mean'] + c['cost_overrun_mean'])

    corr = float(np.corrcoef(s_overrun, c_overrun)[0, 1]) if M > 2 else 0.0

    return {
        'clusters':   clusters,
        'correlation': round(corr, 3),
        'schedule_overrun': {
            'mean': round(float(np.mean(s_overrun)), 3),
            'std':  round(float(np.std(s_overrun)), 3),
            'p95':  round(float(np.percentile(s_overrun, 95)), 3),
        },
        'cost_overrun': {
            'mean': round(float(np.mean(c_overrun)), 3),
            'std':  round(float(np.std(c_overrun)), 3),
            'p95':  round(float(np.percentile(c_overrun, 95)), 3),
        },
    }


def _tier_label(risk_norm, activity_type):
    """Human-readable risk tier label."""
    fat_t = _FAT_TAIL_THRESHOLDS.get(
        activity_type.lower() if isinstance(activity_type, str) else '',
        _DEFAULT_FAT_TAIL)
    pareto_t = fat_t + _PARETO_OFFSET
    if risk_norm < 0.06:
        return 'noise_floor'
    if risk_norm < 0.18:
        return 'triangular'
    if risk_norm < fat_t:
        return 'normal'
    if risk_norm < pareto_t:
        return 'birnbaum_saunders'
    return 'pareto'


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

    # Baseline objectives for 2D overrun clustering
    initial_objs = compute_objectives(dag_state, params, project_ctx,
                                      disciplines)

    # Pre-compute risk parameters
    risk = np.clip(params.risk_scores / 10.0, 0.0, 1.0)
    fat_thresh = _fat_tail_thresholds(params.activity_types, n)
    caps = _compute_caps(risk, params.durations, fat_thresh)

    # Precompute standard-normal transform once (avoids scipy overhead
    # per-sample inside _compute_raw_multipliers — Copilot review #3).
    from scipy.special import ndtri
    z_all = ndtri(u_all)

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

    # SRA accumulators — Criticality Index (Van Slyke 1963) and
    # Cruciality Index (Williams 1992), computed online in O(n) memory.
    # Uses capped multipliers for cruciality (same values that drive CPM).
    crit_count     = np.zeros(n, dtype=np.int64)   # times on critical path
    makespan_sum   = 0.0
    makespan_sumsq = 0.0
    cross_sum      = np.zeros(n, dtype=np.float64)  # Σ(capped_mult_i * makespan)
    cap_sum        = np.zeros(n, dtype=np.float64)   # Σ(capped_mult_i)
    cap_sum_sq     = np.zeros(n, dtype=np.float64)   # Σ(capped_mult_i²)

    # Save original array references so we can restore aliasing after the loop.
    orig_dag_dur   = dag_state.durations
    orig_param_dur = params.durations
    saved_values   = orig_dag_dur.copy()

    for m in range(M):
        # Risk-tiered multipliers (matching Completionprediction.js tiers)
        raw_mult = _compute_raw_multipliers(u_all[m], z_all[m], risk, fat_thresh)
        capped_mult = np.minimum(raw_mult, caps)
        capped_mult = np.maximum(capped_mult, 0.1)

        # Track raw statistics for black-swan / dragon-king detection
        raw_max    = np.maximum(raw_max, raw_mult)
        raw_sum   += raw_mult
        raw_sum_sq += raw_mult ** 2
        cap_hits  += (raw_mult >= caps * 0.95).astype(np.int64)  # 95% soft threshold

        perturbed = saved_values * capped_mult
        perturbed = np.maximum(perturbed, params.min_durations)

        run_cpm(dag_state, perturbed)
        params.durations = perturbed

        # SRA: accumulate criticality and makespan-correlation data
        crit_count    += dag_state.critical_mask.astype(np.int64)
        ms             = dag_state.makespan
        makespan_sum  += ms
        makespan_sumsq += ms * ms
        cross_sum     += capped_mult * ms
        cap_sum       += capped_mult
        cap_sum_sq    += capped_mult ** 2

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

    # Schedule Risk Analysis indices (Van Slyke 1963; Williams 1992)
    criticality_index = crit_count / max(M, 1)

    # Cruciality index: Pearson correlation between activity multiplier
    # and project makespan, computed from online accumulators.
    ms_mean = makespan_sum / max(M, 1)
    ms_var  = makespan_sumsq / max(M, 1) - ms_mean ** 2
    ms_std  = np.sqrt(max(ms_var, 0.0))

    # Use capped multipliers (same values that drove CPM) for consistent
    # correlation.  raw_sum/raw_sum_sq are only for extreme-event detection.
    mult_mean = cap_sum / max(M, 1)
    mult_var  = cap_sum_sq / max(M, 1) - mult_mean ** 2
    mult_std  = np.sqrt(np.maximum(mult_var, 0.0))

    if ms_std > 1e-12:
        cov = cross_sum / max(M, 1) - mult_mean * ms_mean
        denom = mult_std * ms_std
        safe_denom = np.where(denom > 1e-12, denom, 1.0)
        cruciality_index = np.where(denom > 1e-12, cov / safe_denom, 0.0)
    else:
        cruciality_index = np.zeros(n, dtype=np.float64)

    result['sra'] = {
        'criticality_index': {
            params.ids[i]: round(float(criticality_index[i]), 4)
            for i in range(n)
        },
        'cruciality_index': {
            params.ids[i]: round(float(cruciality_index[i]), 4)
            for i in range(n)
        },
        'makespan_mean': round(float(ms_mean), 2),
        'makespan_std':  round(float(ms_std), 2),
    }

    # 2D cost-schedule clustering (Natarajan et al., PMJ 2022, Figs. 15-17)
    result['cost_schedule_joint'] = _detect_2d_extremes(
        obj_samples, disciplines, initial_objs)

    logger.info("MC ensemble done: %d samples, %d black swans, "
                "%d dragon kings, %.1fs",
                M, len(black_swans), len(dragon_kings), time.time() - t0)
    return result


def _empty(disciplines):
    return {
        'objectives_mean':      {d: 0.0 for d in disciplines},
        'objectives_std':       {d: 0.0 for d in disciplines},
        'gradients_mean':       {},
        'gradients_std':        {},
        'n_samples':            0,
        'black_swans':          [],
        'dragon_kings':         [],
        'sra':                  {'criticality_index': {}, 'cruciality_index': {},
                                 'makespan_mean': 0.0, 'makespan_std': 0.0},
        'cost_schedule_joint':  None,
    }
