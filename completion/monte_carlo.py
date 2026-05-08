"""
completion/monte_carlo.py - Remaining-work Monte Carlo simulation.

Extracts Completionprediction.js runMonteCarloRemaining() to the backend.
Operates on remaining work (respects PercentComplete and ExpectedStart),
anchored to a status date, and returns calendar-based finish-date
percentiles.

Reuses the validated five-tier risk distribution machinery from
solver/stochastic.py (Sobol QMC, triangular -> normal ->
Birnbaum-Saunders -> Pareto, Natarajan KS p=.89).  Unlike the JS
implementation, samples are Sobol-QMC rather than Murmur3/FNV-1a hash
uniforms -- same math, better space-filling at equal iteration count.

Vectorisation: multiplier sampling is a single tiled call into
_compute_raw_multipliers over the full (M*n) matrix.  The topological
walk then processes one activity at a time but broadcasts over all M
samples simultaneously, keeping the inner loop in C-level NumPy.
"""

import logging
import time
from dataclasses import dataclass

import numpy as np

from solver.dag import build_dag
from solver.stochastic import (
    _compute_raw_multipliers,
    _fat_tail_thresholds,
    _generate_samples,
)

from .calendar import (
    WorkingCalendar,
    advance_working_ms,
    estimate_horizon_days,
)

logger = logging.getLogger(__name__)

_MS_PER_HOUR = 3_600_000.0
_MS_PER_DAY = 86_400_000.0


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class CompletionMCConfig:
    iterations: int = 500
    seed: int = 42
    antithetic: bool = True
    # Risk gating thresholds (match JS CONFIG.mc* defaults)
    no_risk_below: float = 0.06
    normal_from: float = 0.18
    fat_tail_from: float = 0.55
    # Caps (duration-sensitive max multiplier, min floor)
    min_mult: float = 0.95
    max_mult_base: float = 2.0
    max_mult_high: float = 6.0
    enable_risk: bool = True
    # Reference class: when set, overrides fat_tail_from, max_mult_high,
    # tier-4 distribution choice, and Pareto alpha range with empirically-
    # calibrated values from solver/reference_classes.py.  Also drives
    # post-MC percentile calibration (output _calibrated fields).
    # Names are case-insensitive; see solver/reference_classes.py for
    # the canonical list.
    reference_class: str = None
    # Per-request extension to the registry: {name: params, ...}
    # Validated at the routes layer; passed through here so callers
    # can use a one-off custom class without committing it to source.
    custom_reference_classes: dict = None
    # Per-request override of an existing class:
    #   {'base': 'rail', 'overrides': {'percentile_factors': {'P95': 2.5}}}
    # The merged class takes precedence over reference_class when both
    # are set.  Useful for tuning without registering a full new class.
    reference_class_overrides: dict = None

    @classmethod
    def from_dict(cls, d):
        if not d:
            return cls()
        th = d.get('thresholds', {}) or {}
        caps = d.get('caps', {}) or {}
        return cls(
            iterations=int(d.get('iterations', 500)),
            seed=int(d.get('seed', 42)),
            antithetic=bool(d.get('antithetic', True)),
            no_risk_below=float(th.get('no_risk_below', 0.06)),
            normal_from=float(th.get('normal_from', 0.18)),
            fat_tail_from=float(th.get('fat_tail_from', 0.55)),
            min_mult=float(caps.get('min_mult', 0.95)),
            max_mult_base=float(caps.get('max_mult_base', 2.0)),
            max_mult_high=float(caps.get('max_mult_high', 6.0)),
            enable_risk=bool(d.get('enable_risk', True)),
            reference_class=d.get('reference_class'),
            custom_reference_classes=d.get('custom_reference_classes'),
            reference_class_overrides=d.get('reference_class_overrides'),
        )


# ---------------------------------------------------------------------------
# Date / duration helpers
# ---------------------------------------------------------------------------

def _parse_iso_to_ms(s):
    """ISO-8601 string -> epoch milliseconds.  Returns None on failure.

    Naive inputs (no tz suffix -- e.g. '2025-01-01' or
    '2025-01-01T00:00:00') are treated as UTC, matching the repo-wide
    convention (evm.helpers.safe_date, completion.outcomes._parse_iso,
    completion.calendar._parse_holiday).  Without this, the same
    status_date string produced timezone-dependent epoch ms across
    deployments -- making /completion/monte-carlo and /recovery-options
    non-deterministic on otherwise-identical requests.
    """
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    try:
        from datetime import datetime, timezone
        clean = str(s).replace('Z', '+00:00')
        # Bare YYYY-MM-DD -> UTC midnight
        if 'T' not in clean and len(clean) == 10:
            clean = clean + 'T00:00:00+00:00'
        dt = datetime.fromisoformat(clean)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000.0
    except Exception:
        return None


def _ms_to_iso(ms):
    """Epoch milliseconds -> ISO-8601 UTC string."""
    if ms is None or not np.isfinite(ms):
        return None
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()


def _duration_to_ms(dur, time_units):
    """Convert (Duration, TimeUnits) to wall-clock milliseconds.

    Used on the no-calendar path -- durations in 'days' map to 24-hour
    calendar days.
    """
    try:
        d = float(dur)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(d) or d < 0:
        return 0.0
    unit = str(time_units or 'h').strip().lower()
    if unit in ('h', 'hr', 'hrs', 'hour', 'hours'):
        return d * _MS_PER_HOUR
    if unit in ('s', 'sec', 'secs', 'second', 'seconds'):
        return d * 1000.0
    # 'm' is minutes per the canonical JS convertToHours (PathScripts.js
    # line 158); months are 'mo'/'mon'/'month(s)' only.
    if unit in ('m', 'min', 'mins', 'minute', 'minutes'):
        return d * _MS_PER_HOUR / 60.0
    if unit in ('d', 'day', 'days'):
        return d * _MS_PER_DAY
    if unit in ('w', 'wk', 'wks', 'week', 'weeks'):
        return d * _MS_PER_DAY * 7.0
    if unit in ('mo', 'mon', 'mons', 'month', 'months'):
        return d * _MS_PER_DAY * 30.0
    if unit in ('y', 'yr', 'yrs', 'year', 'years'):
        return d * _MS_PER_DAY * 365.0
    return d * _MS_PER_HOUR


_WEEKS_PER_MONTH = 4.345  # matches evm.helpers._WEEKS_PER_MONTH + JS PathScripts


def _duration_to_work_hours(dur, time_units, hours_per_day,
                            working_days_per_week=5.0):
    """Convert (Duration, TimeUnits) to working hours.

    Used on the calendar path -- durations in 'days' map to working days
    (e.g., 8 hours under a standard 5x8 calendar).  Matches the frontend
    convertToHours() convention (PathScripts.js / evm.helpers) that
    weeks = working_days_per_week working days, months = 4.345 weeks
    (so a 5-day week is ~21.725 days, not the previous hardcoded 21).

    ``working_days_per_week`` defaults to 5 for backwards compatibility
    with callers that didn't previously specify a calendar; callers on
    the calendar path should pass ``len(calendar.working_days)`` so the
    conversion matches the CPM / float path.
    """
    try:
        d = float(dur)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(d) or d < 0:
        return 0.0
    dpw = float(working_days_per_week) if working_days_per_week else 5.0
    unit = str(time_units or 'h').strip().lower()
    if unit in ('h', 'hr', 'hrs', 'hour', 'hours'):
        return d
    if unit in ('s', 'sec', 'secs', 'second', 'seconds'):
        return d / 3600.0
    # 'm' is minutes per the canonical JS convertToHours (PathScripts.js
    # line 158); months are 'mo'/'mon'/'month(s)' only.
    if unit in ('m', 'min', 'mins', 'minute', 'minutes'):
        return d / 60.0
    if unit in ('d', 'day', 'days'):
        return d * hours_per_day
    if unit in ('w', 'wk', 'wks', 'week', 'weeks'):
        return d * hours_per_day * dpw
    if unit in ('mo', 'mon', 'mons', 'month', 'months'):
        return d * hours_per_day * dpw * _WEEKS_PER_MONTH
    if unit in ('y', 'yr', 'yrs', 'year', 'years'):
        return d * hours_per_day * dpw * 52.14
    return d  # unknown -> treat as hours


def _risk_01(node, metadata_entry):
    """Unified 0..1 risk score.

    Precedence (matches JS baseline-building in Completionprediction.js):
      1. node.riskScore  (frontend combined risk, 0..1)
      2. node.ComputedRiskScore (legacy, 0..1)
      3. metadata.combined_risk_score / 10  (solver convention, 0..10)
      4. 0.0
    """
    for key in ('riskScore', 'ComputedRiskScore'):
        v = node.get(key)
        if v is not None:
            try:
                fv = float(v)
                if np.isfinite(fv):
                    return float(np.clip(fv, 0.0, 1.0))
            except (TypeError, ValueError):
                pass
    if metadata_entry:
        v = metadata_entry.get('combined_risk_score')
        if v is not None:
            try:
                fv = float(v)
                if np.isfinite(fv):
                    # Solver uses 0..10; normalise if value > 1
                    return float(np.clip(fv / 10.0 if fv > 1.0 else fv, 0.0, 1.0))
            except (TypeError, ValueError):
                pass
    return 0.0


def _activity_type(node, metadata_entry):
    if metadata_entry:
        t = metadata_entry.get('activity_type') or metadata_entry.get('supply_chain_type')
        if t:
            return str(t).lower()
    for key in ('SupplierType', 'supplierType', 'TaskType', 'ActivityType'):
        v = node.get(key)
        if v:
            return str(v).lower()
    return 'standard'


# ---------------------------------------------------------------------------
# Scope & per-activity state
# ---------------------------------------------------------------------------

def _build_scope(nodes, dag_state, id_to_idx, status_ms, activity_metadata,
                 calendar):
    """
    Build per-activity arrays aligned to DAG indices.

    When *calendar* is None, ``remaining`` is in wall-clock milliseconds.
    When *calendar* is a WorkingCalendar, ``remaining`` is in working
    hours (to be advanced through the calendar by the propagation
    helpers).

    Returns:
        remaining      : (n,) float64  -- ms (no-calendar) or work-hrs (calendar)
        earliest_start : (n,) float64  -- ms, clamped to status_ms
        risk           : (n,) float64  -- 0..1
        activity_types : list[str]     -- lowercased
        in_scope       : (n,) bool     -- True iff activity has remaining work
        actual_finish  : (n,) float64  -- NaN unless ActualFinish given
    """
    n = dag_state.n
    remaining = np.zeros(n, dtype=np.float64)
    earliest_start = np.full(n, status_ms, dtype=np.float64)
    risk = np.zeros(n, dtype=np.float64)
    activity_types = ['standard'] * n
    in_scope = np.zeros(n, dtype=bool)
    actual_finish_ms = np.full(n, np.nan, dtype=np.float64)

    for node in nodes:
        nid = str(node.get('ID', node.get('id', '')))
        if nid not in id_to_idx:
            continue
        j = id_to_idx[nid]
        meta = (activity_metadata or {}).get(nid, {})

        af = _parse_iso_to_ms(node.get('ActualFinish'))
        if af is not None:
            actual_finish_ms[j] = af
            continue

        dur_val = node.get('Duration', node.get('duration', 0))
        dur_units = node.get('TimeUnits', node.get('timeUnits'))
        if calendar is None:
            total = _duration_to_ms(dur_val, dur_units)
        else:
            total = _duration_to_work_hours(
                dur_val, dur_units, calendar.hours_per_day,
                working_days_per_week=len(calendar.working_days))

        pct_raw = node.get('PercentComplete', node.get('percentComplete', 0))
        try:
            pct = float(pct_raw)
        except (TypeError, ValueError):
            pct = 0.0
        if pct > 1.0:
            pct /= 100.0
        pct = max(0.0, min(1.0, pct))

        rem = total * (1.0 - pct) if pct > 0 else total
        if rem <= 0:
            continue

        remaining[j] = rem
        in_scope[j] = True

        exp_start = _parse_iso_to_ms(node.get('ExpectedStart',
                                              node.get('expectedStart')))
        earliest_start[j] = max(status_ms,
                                exp_start if exp_start is not None else status_ms)

        risk[j] = _risk_01(node, meta)
        activity_types[j] = _activity_type(node, meta)

    return (remaining, earliest_start, risk, activity_types, in_scope,
            actual_finish_ms)


# ---------------------------------------------------------------------------
# Multiplier sampling & caps
# ---------------------------------------------------------------------------

def _duration_sensitive_cap(risk, dur_days, base, high):
    """JS durationSensitiveMaxMult -- more leeway for long/high-risk tasks.

    longness = clamp01((durDays - 30) / 180)  -- 0 at 30d, 1 at ~210d
    highness = clamp01((risk - 0.5) / 0.5)    -- 0 at 0.5, 1 at 1.0
    t        = clamp01(0.6*highness + 0.4*longness)
    cap      = lerp(base, high, t)
    """
    longness = np.clip((dur_days - 30.0) / 180.0, 0.0, 1.0)
    highness = np.clip((risk - 0.5) / 0.5, 0.0, 1.0)
    t = np.clip(0.6 * highness + 0.4 * longness, 0.0, 1.0)
    return base + (high - base) * t


def _resolve_reference_class(config):
    """Resolve a reference class for this MC run, honouring (in order):

      1. ``config.reference_class_overrides`` -- {base, overrides} merge.
         Wins over plain reference_class when both are set.
      2. ``config.reference_class`` looked up in the merged registry of
         built-ins + env-loaded + per-request custom classes.

    Returns the parameter dict, or None if no class was selected.
    Raises ValueError on a malformed override (caller should already
    have run validate_custom_classes; this is the second line of
    defence).
    """
    from solver.reference_classes import (
        effective_registry,
        get_reference_class,
        merge_class_definitions,
    )
    custom = getattr(config, 'custom_reference_classes', None)
    registry = effective_registry(custom_classes=custom)

    overrides_spec = getattr(config, 'reference_class_overrides', None)
    if overrides_spec and isinstance(overrides_spec, dict):
        base_name = overrides_spec.get('base')
        if base_name:
            base = get_reference_class(base_name, registry=registry)
            if base is None:
                raise ValueError(
                    f'reference_class_overrides.base {base_name!r} '
                    f'not in registry')
            return merge_class_definitions(
                base, overrides_spec.get('overrides') or {},
                name=f'{base_name}__overridden')

    name = getattr(config, 'reference_class', None)
    return get_reference_class(name, registry=registry)


def _apply_percentile_factor(model_finish_ms, expected_ms, factor):
    """Scale a model-output finish-date toward later by a published
    reference-class factor.

    The factor is applied to the IMPACT (model finish - deterministic
    expected finish), not to the absolute finish date.  Logic:

      impact_days  = model_finish - expected
      adjusted_imp = impact_days * factor
      adjusted_fin = expected + adjusted_imp

    This keeps the deterministic baseline anchored at the expected
    finish (where there's no overrun, the calibrated finish equals the
    raw finish) and only inflates the OVERRUN portion.  Matches how
    Flyvbjerg / TII publish their tables: "to absorb a P% chance of
    overrun, multiply your overrun by X".
    """
    if (model_finish_ms is None or expected_ms is None
            or factor is None or not np.isfinite(factor)):
        return model_finish_ms
    impact = model_finish_ms - expected_ms
    return expected_ms + impact * float(factor)


def _build_calibration_warnings(nodes, in_scope, risk, ref_params,
                                status_ms, project_dates):
    """Detect input-quality concerns and surface them in the response.

    These are NOT validation errors.  They flag things the caller can
    see in the payload that suggest the resulting percentiles are less
    trustworthy than the precision implies.  Mirrors the LinkedIn
    critique that judgment-based MC inputs get laundered into
    misleading P80s.

    Each warning is a dict with `code` (machine-readable),
    `severity` ('info' | 'warning'), and `message`.
    """
    warnings = []
    n_scope = int(np.sum(in_scope)) if in_scope is not None else 0

    # 1. Zero-variance / default-clustered risk scores
    if n_scope >= 5 and len(risk) > 0:
        scope_risk = risk[in_scope] if in_scope is not None else risk
        if len(scope_risk) > 0:
            risk_std = float(np.std(scope_risk))
            risk_mean = float(np.mean(scope_risk))
            # All-identical or near-default-clustered
            if risk_std < 0.05:
                warnings.append({
                    'code': 'zero_variance_risk',
                    'severity': 'warning',
                    'message': (f'All {n_scope} in-scope activities have '
                                f'near-identical risk scores '
                                f'(std={risk_std:.3f}).  Suggests judgment-'
                                f'based defaults rather than per-activity '
                                f'assessment; MC spread will be artificial.'),
                })
            elif abs(risk_mean - 0.5) < 0.05 and risk_std < 0.15:
                warnings.append({
                    'code': 'judgment_based_risk_default',
                    'severity': 'info',
                    'message': (f'Risk scores cluster near the 0.5 default '
                                f'(mean={risk_mean:.2f}, std={risk_std:.2f}).  '
                                f'Consider per-activity risk scoring for '
                                f'sharper percentiles.'),
                })

    # 2. Supply-chain classification missing on every activity
    has_supplier = any(
        n.get('SupplierType') or n.get('supplierType')
        for n in nodes or [])
    if not has_supplier and n_scope > 0:
        warnings.append({
            'code': 'no_supply_chain_classification',
            'severity': 'info',
            'message': ('No SupplierType set on any activity.  Supply-'
                        'chain activities (equipment / material / service) '
                        'use tighter fat-tail thresholds and would produce '
                        'more accurate percentiles for procurement-heavy '
                        'projects.'),
        })

    # 3. Small-scope MC instability
    if 0 < n_scope < 30:
        warnings.append({
            'code': 'small_scope_mc',
            'severity': 'warning',
            'message': (f'Only {n_scope} activities in MC scope.  '
                        f'Percentile estimates are noisy below ~30 '
                        f'activities; treat P95 / P99 as illustrative.'),
        })

    # 4. Extreme horizon (well outside the calibration range)
    if project_dates:
        days = (project_dates['max'] - project_dates['min']) / _MS_PER_DAY
        if days < 30:
            warnings.append({
                'code': 'extreme_horizon_short',
                'severity': 'info',
                'message': (f'Project horizon is {days:.0f} days.  '
                            f'Reference-class tables (Flyvbjerg, '
                            f'Cantarelli) are validated on multi-year '
                            f'megaprojects; short-horizon factors are '
                            f'extrapolations.'),
            })
        elif days > 365 * 10:
            warnings.append({
                'code': 'extreme_horizon_long',
                'severity': 'info',
                'message': (f'Project horizon is {days:.0f} days '
                            f'(>10y).  Distribution parameters drift '
                            f'with technology / regulation over decadal '
                            f'spans; treat tail percentiles as model '
                            f'predictions, not empirical guarantees.'),
            })

    # 5. Reference-class advisories
    if ref_params is not None:
        # Partial custom classes / overrides can miss percentile
        # factors; we silently default them to 1.0 in the result-builder
        # but the user should see WHY their calibrated P95 looks the
        # same as their model P95.
        pf = ref_params.get('percentile_factors') or {}
        missing_pcts = [k for k in ('P50', 'P80', 'P95')
                        if k not in pf]
        if missing_pcts:
            warnings.append({
                'code': 'partial_percentile_factors',
                'severity': 'info',
                'message': (
                    f'Reference class has no factor for: '
                    f'{", ".join(missing_pcts)}.  Those calibrated '
                    f'percentiles default to factor 1.0 (no shift).'),
            })
        if not ref_params.get('has_finite_mean', True):
            warnings.append({
                'code': 'infinite_mean_reference_class',
                'severity': 'warning',
                'message': (
                    'Reference class has formally infinite mean '
                    '(alpha <= 1; e.g. IT, Olympics).  Per Flyvbjerg / '
                    'Aaen 2025, ANY single percentile is unstable; the '
                    'P99 is reported as a hard cap, not an empirical '
                    'measurement.  Recommended: cap exposure rather '
                    'than predict the tail.'),
            })
        # Judgement / no peer-reviewed fit -- surface the specific
        # source statement so the customer sees exactly which parts
        # of the parameter table aren't on solid empirical ground.
        judgement_notes = [
            cit for cit in ref_params.get('citations', [])
            if 'JUDGEMENT' in cit
        ]
        if judgement_notes:
            warnings.append({
                'code': 'reference_class_judgement',
                'severity': 'info',
                'message': (
                    'Reference class parameters include judgement calls; '
                    'no peer-reviewed distribution fit yet.  Source notes:\n  '
                    + '\n  '.join(judgement_notes)),
                'notes': judgement_notes,
            })

    # 6. Honest blanket caveat when no reference class is set
    if ref_params is None and n_scope > 0:
        warnings.append({
            'code': 'no_reference_class',
            'severity': 'info',
            'message': (
                'No reference_class supplied; using global default '
                'tier model.  Per Flyvbjerg & Bester 2021 and the '
                '2025 Cantarelli RCF review, sector-specific reference '
                'classes give better-calibrated percentiles.  See '
                'solver/reference_classes.py for the supported '
                'classes.'),
        })

    return warnings


def _sample_multipliers(risk, activity_types, remaining, calendar, config):
    """
    Generate an (M, n) matrix of capped duration multipliers via the
    five-tier model from solver/stochastic.py.

    ``remaining`` is either wall-clock ms (no calendar) or working hours
    (calendar); *calendar* disambiguates when computing the per-activity
    duration in days for the cap heuristic.

    Reference-class overrides: when ``config.reference_class`` resolves
    via solver/reference_classes.get_reference_class, the class's
    fat_tail_from / pareto_offset / pareto_alpha_range / tier_4
    distribution / max_multiplier_cap override the defaults for THIS
    MC run.  Without a class, behaviour is byte-identical to before.

    Custom classes / overrides:
      - config.custom_reference_classes: per-request extension dict.
      - config.reference_class_overrides: {base, overrides} merge.
    Both are honoured; per-request always wins over the env-loaded
    extensions which win over the built-ins.
    """
    n = len(risk)
    if not config.enable_risk or n == 0:
        return np.ones((config.iterations, n), dtype=np.float64), config.iterations

    u_all, M = _generate_samples(config.iterations, n, config.antithetic,
                                 seed=config.seed)
    from scipy.special import ndtri
    z_all = ndtri(u_all)

    # Resolve the reference class once.  When None, we use the historic
    # (config.fat_tail_from, default tier 4 = BS, default Pareto alpha
    # formula, default 6/10x cap) behaviour.
    ref = _resolve_reference_class(config)

    fat_default = ref['fat_tail_from'] if ref else config.fat_tail_from
    pareto_offset = ref['pareto_offset'] if ref else None
    tier_4 = ref['tier_4_distribution'] if ref else 'birnbaum_saunders'
    alpha_range = ref['pareto_alpha_range'] if ref else None

    fat_thresh = _fat_tail_thresholds(
        activity_types, n, default_fat_tail=fat_default)

    risk_tile = np.tile(risk, M)
    fat_tile = np.tile(fat_thresh, M)
    mult_flat = _compute_raw_multipliers(
        u_all.ravel(), z_all.ravel(), risk_tile, fat_tile,
        noise_floor=config.no_risk_below,
        normal_from=config.normal_from,
        pareto_offset=pareto_offset,
        tier_4_distribution=tier_4,
        pareto_alpha_range=alpha_range,
    )
    mult = mult_flat.reshape(M, n)

    if calendar is None:
        dur_days = remaining / _MS_PER_DAY
    else:
        # Working hours -> working-day count (matches JS durDays definition).
        dur_days = remaining / max(calendar.hours_per_day, 1e-9)

    # When a reference class is set, its max_multiplier_cap replaces
    # config.max_mult_high (the latter remains the upper bound for
    # callers without a reference class -- backwards compatible).
    high_cap = ref['max_multiplier_cap'] if ref else config.max_mult_high
    caps = _duration_sensitive_cap(risk, dur_days,
                                   config.max_mult_base, high_cap)
    below_floor = risk <= config.no_risk_below
    if np.any(below_floor):
        mult[:, below_floor] = 1.0

    mult = np.minimum(mult, caps[np.newaxis, :])
    mult = np.maximum(mult, config.min_mult)

    return mult, M


# ---------------------------------------------------------------------------
# Vectorised topological propagation
# ---------------------------------------------------------------------------

def _advance(start_ms, work, calendar):
    """
    Advance start_ms by the per-activity work amount.

    On the no-calendar path, *work* is milliseconds and we add directly.
    On the calendar path, *work* is working hours and we route through
    ``advance_working_ms``.  Link lag is always interpreted as working
    hours when a calendar is present (matching the JS
    lagUsesWorkingCalendar default), otherwise as wall-clock hours
    converted to ms.  That conversion happens at the call site, not
    here -- this helper only knows about the per-activity duration step.
    """
    if calendar is None:
        return start_ms + work
    return advance_working_ms(start_ms, work, calendar)


def _propagate_finish_ms(dag_state, remaining, earliest_start_ms,
                         status_ms, mult_all, calendar):
    """
    Walk the DAG in topological order, broadcasting start/finish times
    over all M samples simultaneously.

    ``remaining`` is ms (no-calendar path) or working hours (calendar
    path); ``mult_all`` multiplies it element-wise.

    Returns sim_start_ms, sim_finish_ms of shape (M, n).
    """
    M, n = mult_all.shape
    sim_start = np.empty((M, n), dtype=np.float64)
    sim_finish = np.empty((M, n), dtype=np.float64)

    for j in dag_state.topo_order:
        base_start = earliest_start_ms[j]
        start = np.full(M, base_start, dtype=np.float64)
        req_finish = np.full(M, -np.inf, dtype=np.float64)

        for idx, p in enumerate(dag_state.pred[j]):
            lag, rel = dag_state.pred_edges[j][idx]
            if calendar is None:
                lag_shift_from_finish = sim_finish[:, p] + lag * _MS_PER_HOUR
                lag_shift_from_start = sim_start[:, p] + lag * _MS_PER_HOUR
            else:
                lag_shift_from_finish = advance_working_ms(
                    sim_finish[:, p], lag, calendar)
                lag_shift_from_start = advance_working_ms(
                    sim_start[:, p], lag, calendar)

            if rel == 'FS':
                np.maximum(start, lag_shift_from_finish, out=start)
            elif rel == 'SS':
                np.maximum(start, lag_shift_from_start, out=start)
            elif rel == 'FF':
                np.maximum(req_finish, lag_shift_from_finish, out=req_finish)
            elif rel == 'SF':
                np.maximum(req_finish, lag_shift_from_start, out=req_finish)

        np.maximum(start, status_ms, out=start)
        sim_start[:, j] = start

        finish = _advance(start, remaining[j] * mult_all[:, j], calendar)
        np.maximum(finish, req_finish, out=finish)
        sim_finish[:, j] = finish

    return sim_start, sim_finish


def _deterministic_finish_ms(dag_state, remaining, earliest_start_ms,
                             status_ms, calendar):
    """Single forward pass with multiplier = 1.0 (no risk inflation)."""
    n = dag_state.n
    start = np.empty(n, dtype=np.float64)
    finish = np.empty(n, dtype=np.float64)

    for j in dag_state.topo_order:
        s = earliest_start_ms[j]
        rf = -np.inf
        for idx, p in enumerate(dag_state.pred[j]):
            lag, rel = dag_state.pred_edges[j][idx]
            if calendar is None:
                pf = finish[p] + lag * _MS_PER_HOUR
                ps = start[p] + lag * _MS_PER_HOUR
            else:
                pf = float(advance_working_ms(finish[p], lag, calendar))
                ps = float(advance_working_ms(start[p], lag, calendar))
            if rel == 'FS':
                s = max(s, pf)
            elif rel == 'SS':
                s = max(s, ps)
            elif rel == 'FF':
                rf = max(rf, pf)
            elif rel == 'SF':
                rf = max(rf, ps)
        s = max(s, status_ms)
        start[j] = s
        f = float(_advance(np.array([s]), np.array([remaining[j]]),
                           calendar)[0]) if calendar is not None \
            else s + remaining[j]
        if np.isfinite(rf):
            f = max(f, rf)
        finish[j] = f
    return start, finish


def deterministic_expected_finish_ms(nodes, dag_state, id_to_idx, status_ms,
                                     activity_metadata, calendar):
    """Single deterministic forward pass + project-finish reduction.

    Reuses pre-built ``dag_state`` and (optional) ``calendar`` so callers
    that already paid for `build_dag` / `_maybe_build_calendar` don't
    rebuild them.  Used by ``completion/recovery.py`` when the caller
    omits ``expected_finish`` -- previously this re-ran the full MC
    pipeline (iterations=1, enable_risk=False), which was wasteful.

    Returns the project finish in epoch ms, or status_ms if no
    activity is in scope.
    """
    (remaining, earliest_start_ms, _risk, _atypes,
     in_scope, _af) = _build_scope(
        nodes, dag_state, id_to_idx, status_ms, activity_metadata, calendar)

    if not np.any(in_scope):
        return float(status_ms)

    _det_start, det_finish = _deterministic_finish_ms(
        dag_state, remaining, earliest_start_ms, status_ms, calendar)
    return float(np.max(det_finish[in_scope]))


# ---------------------------------------------------------------------------
# Calendar construction
# ---------------------------------------------------------------------------

def _maybe_build_calendar(nodes, dag_state, id_to_idx, status_ms,
                          activity_metadata, project_context,
                          max_multiplier_cap=None):
    """
    Build a WorkingCalendar if project_context.calendar is supplied with
    sufficient information, else return None (wall-clock fall-back).

    A calendar is constructed when the context contains any of
    ``hours_per_day``, ``working_days``, or ``holidays``; if none are
    present the endpoint behaves as V1 (wall-clock time).

    ``max_multiplier_cap`` is forwarded to ``estimate_horizon_days`` so
    the precomputed calendar covers the worst-case Pareto-tier
    multiplier.  Olympics/IT with 50x caps need a much longer horizon
    than thin-tailed sectors with 3x caps.
    """
    ctx = project_context or {}
    if not isinstance(ctx, dict):
        return None
    cal_cfg = ctx.get('calendar') or {}
    if not isinstance(cal_cfg, dict):
        return None
    has_fields = any(k in cal_cfg for k in ('hours_per_day', 'working_days',
                                            'holidays'))
    if not has_fields:
        return None

    hours_per_day = float(cal_cfg.get('hours_per_day', 8.0))
    working_days = cal_cfg.get('working_days', [1, 2, 3, 4, 5])
    holidays = cal_cfg.get('holidays', [])
    # Count just the ISO weekdays in the provided list so weeks/months
    # scale with the caller's calendar rather than the hardcoded 5-day week.
    try:
        dpw_hint = sum(1 for d in (working_days or [])
                       if isinstance(d, (int, float)) and 1 <= int(d) <= 7)
        if dpw_hint <= 0:
            dpw_hint = 5
    except Exception:
        dpw_hint = 5

    # Estimate horizon from total remaining working hours (deterministic).
    total_work_hrs = 0.0
    for node in nodes:
        nid = str(node.get('ID', node.get('id', '')))
        if nid not in id_to_idx:
            continue
        if _parse_iso_to_ms(node.get('ActualFinish')) is not None:
            continue
        dur_val = node.get('Duration', node.get('duration', 0))
        dur_units = node.get('TimeUnits', node.get('timeUnits'))
        total = _duration_to_work_hours(
            dur_val, dur_units, hours_per_day,
            working_days_per_week=dpw_hint)
        pct_raw = node.get('PercentComplete', node.get('percentComplete', 0))
        try:
            pct = float(pct_raw)
        except (TypeError, ValueError):
            pct = 0.0
        if pct > 1.0:
            pct /= 100.0
        pct = max(0.0, min(1.0, pct))
        total_work_hrs += total * (1.0 - pct)

    horizon_days = estimate_horizon_days(
        total_work_hrs, hours_per_day,
        max_multiplier_cap=max_multiplier_cap)

    return WorkingCalendar.build(
        hours_per_day=hours_per_day,
        working_days=working_days,
        holidays=holidays,
        start_ms=status_ms,
        horizon_days=horizon_days,
    )


# ---------------------------------------------------------------------------
# Stochastic TEAC (Lipke time-based Estimate at Completion, per percentile)
# ---------------------------------------------------------------------------
#
# The deterministic Earned Schedule (evm/metrics.compute_earned_schedule)
# returns a single TEAC value clamped through Bounds.MIN_SPI/MAX_SPI.
# That sits awkwardly in a codebase whose research identity is fat-tailed
# overruns: for an offshore O&G project at the P80, the 50/50 chance of
# overrun isn't a one-number SPI(t), it's a five-tier distribution.
#
# This block reuses the per-percentile finish dates already produced by
# the MC propagation and recasts them as Lipke-style TEAC values:
#
#   TEAC_p_days = (finish_p_date - project_start_date) calendar days
#   SPI(t)_p    = PD / TEAC_p   (clamped to Bounds.MIN_SPI..MAX_SPI for the
#                                model variant; raw kept as well)
#   impact_p    = (finish_p_date - expected_finish_date) days  (delta from
#                                deterministic baseline)
#
# It does NOT recompute the percentiles -- those are the same sorted
# samples /completion/monte-carlo already exposes via p20_finish /
# p50_finish / p80_finish.  The contribution is to (a) anchor them to a
# baseline project_start so the duration is meaningful, and (b) emit the
# implied SPI(t) so consumers reading evmMetrics.actual.earnedSchedule
# can see the uncertainty band around its single deterministic SPI(t).

# Mirror evm.helpers.Bounds.MIN_SPI / MAX_SPI so the clamped SPI(t)_model
# emitted here matches what /evm/analyze emits for the same SPI(t).  An
# earlier draft hardcoded 0.1 / 5.0, which silently diverged once
# Bounds was widened to 0.05 / 10.0 -- making /evm/analyze.actual.
# earnedSchedule.SPI_t_model and response.teac.percentiles.*.spi_t_model
# disagree on the same project.  Importing from the canonical source
# means a future Bounds change updates both endpoints atomically.
from evm.helpers import Bounds as _EVM_BOUNDS

_TEAC_MIN_SPI = _EVM_BOUNDS.MIN_SPI
_TEAC_MAX_SPI = _EVM_BOUNDS.MAX_SPI


def _baseline_project_start_ms(nodes, fallback_ms):
    """Earliest baseline ``Start`` across nodes, or ``fallback_ms`` when
    none is parseable.  Mirrors evm.metrics._significant_evm_dates(...)[0]
    but uses the milliseconds path that the rest of monte_carlo.py
    operates in.
    """
    earliest = None
    for n in nodes or []:
        s_ms = _parse_iso_to_ms(n.get('Start') or n.get('start'))
        if s_ms is None:
            continue
        if earliest is None or s_ms < earliest:
            earliest = s_ms
    return float(earliest) if earliest is not None else float(fallback_ms)


def _baseline_project_finish_ms(nodes, fallback_ms):
    """Latest baseline ``Finish`` across nodes, or ``fallback_ms``."""
    latest = None
    for n in nodes or []:
        f_ms = _parse_iso_to_ms(n.get('Finish') or n.get('finish'))
        if f_ms is None:
            continue
        if latest is None or f_ms > latest:
            latest = f_ms
    return float(latest) if latest is not None else float(fallback_ms)


def _spi_t_from_pd_and_teac(pd_days, teac_days):
    """Implied SPI(t) = PD / TEAC, with raw + clamped variants.

    Returns ``(None, None)`` when ``pd_days <= 0`` -- the most common
    cause is partial baseline (Start without Finish, or vice versa),
    where PD has no defined value and reporting any SPI(t) would imply
    a baseline comparison the data doesn't support.

    Raw is preserved (Inf when teac_days == 0 with pd_days > 0).  Model
    is clamped to [_TEAC_MIN_SPI, _TEAC_MAX_SPI] for use in downstream
    EAC arithmetic; matches the convention in
    evm.metrics.compute_earned_schedule.
    """
    if pd_days <= 0:
        return None, None
    if teac_days > 0:
        raw = pd_days / teac_days
    else:
        raw = float('inf')
    if not np.isfinite(raw):
        model = 1.0
    else:
        model = float(np.clip(raw, _TEAC_MIN_SPI, _TEAC_MAX_SPI))
    return raw, model


def _teac_percentile(label, finish_ms, project_start_ms, expected_finish_ms,
                     pd_days):
    """Build one percentile entry for the TEAC block.

    All day quantities are calendar days (clock-time deltas / 86_400_000)
    to match the rest of /completion/monte-carlo's day reporting
    (spread_days, p20_impact_days, ...).  This differs by < 1 day from
    evm.metrics' midnight-floored difference_in_calendar_days under
    typical inputs but stays internally consistent within the response.
    """
    teac_days = max(0.0, (finish_ms - project_start_ms) / _MS_PER_DAY)
    impact_days = (finish_ms - expected_finish_ms) / _MS_PER_DAY
    spi_t, spi_t_model = _spi_t_from_pd_and_teac(pd_days, teac_days)
    return {
        'label':       label,
        'teac_days':   round(teac_days, 2),
        'teac_date':   _ms_to_iso(finish_ms),
        'spi_t':       (None if (spi_t is None or not np.isfinite(spi_t))
                        else round(spi_t, 4)),
        'spi_t_model': (None if spi_t_model is None
                        else round(spi_t_model, 4)),
        'impact_days': round(impact_days, 2),
    }


def _compose_teac_block(nodes, status_ms, expected_finish_ms,
                        proj_finish_sorted, M_actual, in_scope_count):
    """Build the stochastic TEAC block from MC finish-date samples.

    Composes the existing /completion/monte-carlo per-percentile finish
    dates with a baseline project_start anchor to produce Lipke-style
    time-based EAC values.  Reuses the sorted samples computed for
    p20/p50/p80 -- no extra MC pass.
    """
    has_baseline_start = any(
        _parse_iso_to_ms(n.get('Start') or n.get('start')) is not None
        for n in nodes or [])
    has_baseline_finish = any(
        _parse_iso_to_ms(n.get('Finish') or n.get('finish')) is not None
        for n in nodes or [])
    has_full_baseline = has_baseline_start and has_baseline_finish

    project_start_ms = _baseline_project_start_ms(nodes, fallback_ms=status_ms)
    project_finish_ms = _baseline_project_finish_ms(
        nodes, fallback_ms=expected_finish_ms)

    # PD = baseline_finish - baseline_start.  Only well-defined when BOTH
    # sides are recorded.  If only one is present, the missing anchor
    # falls back to a forecast date (status_ms / expected_finish_ms),
    # which would make PD a synthetic number compared against itself --
    # the deterministic SPI(t) would lock to 1.0 even for a project with
    # no baseline duration to compare against.  Treat partial baseline
    # as "no baseline" for the purposes of PD / SPI(t) reporting.
    if has_full_baseline:
        pd_days = max(0.0, (project_finish_ms - project_start_ms)
                      / _MS_PER_DAY)
    else:
        pd_days = 0.0

    raw_at_days = (status_ms - project_start_ms) / _MS_PER_DAY
    at_days = max(0.0, raw_at_days)

    flags = {}
    # `no_baseline` fires when EITHER Start or Finish is absent project-
    # wide (not just both).  Partial baselines are not enough to anchor
    # PD / SPI(t).
    if not has_full_baseline:
        flags['no_baseline'] = True
    if raw_at_days < 0:
        flags['status_before_start'] = True
    if in_scope_count == 0:
        flags['all_completed'] = True

    # Percentile finish dates: reuse the already-sorted MC samples.
    # P10 and P95 are added on top of the existing P20/P50/P80 contract
    # because TEAC bands are commonly reported at the P10 (best case)
    # and P95 (Flyvbjerg-table cap) extremes.
    def _pct(p):
        if M_actual <= 0:
            return float(expected_finish_ms)
        idx = int(p * (M_actual - 1))
        return float(proj_finish_sorted[idx])

    p10_ms = _pct(0.10)
    p20_ms = _pct(0.20)
    p50_ms = _pct(0.50)
    p80_ms = _pct(0.80)
    p95_ms = _pct(0.95)

    percentiles = {
        'p10': _teac_percentile('P10', p10_ms, project_start_ms,
                                expected_finish_ms, pd_days),
        'p20': _teac_percentile('P20', p20_ms, project_start_ms,
                                expected_finish_ms, pd_days),
        'p50': _teac_percentile('P50', p50_ms, project_start_ms,
                                expected_finish_ms, pd_days),
        'p80': _teac_percentile('P80', p80_ms, project_start_ms,
                                expected_finish_ms, pd_days),
        'p95': _teac_percentile('P95', p95_ms, project_start_ms,
                                expected_finish_ms, pd_days),
    }

    # MC deterministic midpoint: the no-risk-multiplier CPM forward pass
    # finish, in TEAC form.  This is NOT the same number as
    # /evm/analyze.actual.earnedSchedule.TEAC_date.  EVM's TEAC is
    # `max(AT, PD / SPI_t_model)` where SPI(t) comes from the EV/PV
    # intersection (cost-side Earned Schedule).  This block's deterministic
    # value comes from a CPM forward pass through the remaining-work DAG.
    # The two agree when no progress has been recorded and ExpectedStart
    # equals Start, but diverge under in-progress / out-of-sequence /
    # status-after-completion conditions because they are different
    # computations.  Surfacing it here gives consumers the natural
    # midpoint of the MC band so the percentile spread can be read in
    # one response; the EVM endpoint remains the authoritative deterministic
    # ES TEAC.
    det_teac_days = max(0.0, (expected_finish_ms - project_start_ms)
                        / _MS_PER_DAY)
    det_spi_t, det_spi_t_model = _spi_t_from_pd_and_teac(
        pd_days, det_teac_days)

    # When the baseline is partial / absent, projectFinishDate falls back
    # to expected_finish_ms (a forecast date).  Don't echo that synthetic
    # value as if it were a recorded baseline; emit None so consumers see
    # the missing data rather than treating a forecast as a baseline.
    project_finish_emit = (_ms_to_iso(project_finish_ms)
                           if has_full_baseline else None)
    project_start_emit = (_ms_to_iso(project_start_ms)
                          if has_baseline_start else None)

    return {
        'projectStartDate':    project_start_emit,
        'projectFinishDate':   project_finish_emit,
        'plannedDurationDays': (round(pd_days, 2) if has_full_baseline
                                else None),
        'statusDate':          _ms_to_iso(status_ms),
        'actualTimeDays':      round(at_days, 2),
        'percentiles':         percentiles,
        'deterministic': {
            'teac_days':   round(det_teac_days, 2),
            'teac_date':   _ms_to_iso(expected_finish_ms),
            'spi_t':       (None if (det_spi_t is None
                                     or not np.isfinite(det_spi_t))
                            else round(det_spi_t, 4)),
            'spi_t_model': (None if det_spi_t_model is None
                            else round(det_spi_t_model, 4)),
            'source':      'mc_no_risk_cpm',
            'note':        ('No-risk-multiplier CPM midpoint of the MC '
                            'band.  Equals top-level expected_finish on '
                            'the regular MC path; clamps forward to '
                            'statusDate on the all-completed stale-status '
                            'edge case so TEAC >= AT (Lipke).  Differs '
                            'from /evm/analyze.actual.earnedSchedule.'
                            'TEAC_date, which uses max(AT, PD / '
                            'SPI_t_model) on the cost-side EV/PV '
                            'intersection.'),
        },
        'flags':                flags,
        'method':               'lipke_2003_stochastic',
        'crossReference': {
            'evm_endpoint':  '/evm/analyze',
            'evm_field':     'actual.earnedSchedule',
            'note':          ('Authoritative deterministic Lipke ES / '
                              'SPI(t) / TEAC live on /evm/analyze (cost-'
                              'side EV vs PV intersection).  This block '
                              'provides the five-tier risk-model '
                              'uncertainty band around the MC '
                              'remaining-work midpoint, which uses the '
                              'CPM forward pass and may diverge from '
                              'the EVM TEAC under in-progress / out-of-'
                              'sequence / status-after-completion data.'),
        },
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_completion_mc(nodes, links, status_date,
                      activity_metadata=None,
                      project_context=None,
                      config=None):
    """
    Run remaining-work Monte Carlo simulation and return finish-date
    percentiles.

    Args:
        nodes: list of activity dicts (ID, Duration, TimeUnits,
               PercentComplete, ExpectedStart, ActualFinish, riskScore,
               SupplierType, ActivityPhase, ...)
        links: list of dependency dicts (source, target, type, lag)
        status_date: ISO-8601 string -- the anchor for remaining work
        activity_metadata: optional dict {activity_id: metadata}
        project_context: optional dict with 'calendar.hours_per_day'
        config: CompletionMCConfig instance or dict

    Returns:
        dict with P20/P50/P80 finish dates, per-activity percentiles,
        deterministic expected finish, and distribution stats.
    """
    t0 = time.time()

    if isinstance(config, dict) or config is None:
        config = CompletionMCConfig.from_dict(config or {})

    status_ms = _parse_iso_to_ms(status_date)
    if status_ms is None:
        raise ValueError("status_date must be a valid ISO-8601 date string")

    # default_duration=0.0 so a missing Duration field is treated as a
    # milestone (matches the route validator), not a 1-unit activity.
    dag_state, id_to_idx = build_dag(nodes, links, default_duration=0.0)
    n = dag_state.n

    if n == 0:
        return _empty_result(status_date, t0)

    # Resolve the effective Pareto-tier cap so the horizon sizing below
    # covers the worst-case multiplier for this reference class.
    # Falls back to config.max_mult_high when no class is set.
    try:
        _ref_for_cap = _resolve_reference_class(config)
    except Exception:
        _ref_for_cap = None
    effective_cap = (_ref_for_cap['max_multiplier_cap']
                     if _ref_for_cap else config.max_mult_high)

    # Build working calendar from project_context when supplied.  Absence
    # falls back to V1 wall-clock semantics (see _duration_to_ms).
    calendar = _maybe_build_calendar(
        nodes, dag_state, id_to_idx, status_ms, activity_metadata,
        project_context, max_multiplier_cap=effective_cap)

    (remaining, earliest_start_ms, risk, activity_types,
     in_scope, actual_finish_ms) = _build_scope(
        nodes, dag_state, id_to_idx, status_ms, activity_metadata,
        calendar)

    if not np.any(in_scope):
        # Nothing left to simulate -- all activities have ActualFinish.
        # Pre-existing finish-date fields (expected_finish, p20/p50/p80)
        # report the actual completion date as-is, regardless of where
        # status_date is.  This preserves the historical contract:
        # consumers reading p80_finish for a closed-out project must
        # still see the recorded completion, not the caller's status.
        # Only the new `teac` block clamps to status_ms (via
        # `teac_completion_ms` below), mirroring evm.metrics's
        # `teac_days = max(at_days, ...)` so AT > TEAC > SPI(t) > 1
        # can't fire on a stale-status report.
        latest = float(np.nanmax(actual_finish_ms)) if np.any(
            np.isfinite(actual_finish_ms)) else status_ms
        iso = _ms_to_iso(latest)
        # TEAC-internal clamp: the new teac block's percentiles, the
        # deterministic midpoint, and AT all reference status_ms; if
        # the project actually finished earlier, the TEAC view is
        # "you've spent at least AT, so TEAC >= AT".  Doesn't touch
        # the public iso fields above.
        teac_completion_ms = max(latest, status_ms)
        teac_block = _compose_teac_block(
            nodes=nodes,
            status_ms=status_ms,
            expected_finish_ms=teac_completion_ms,
            proj_finish_sorted=np.array(
                [teac_completion_ms], dtype=np.float64),
            M_actual=1,
            in_scope_count=0)
        return {
            'status_date':        _ms_to_iso(status_ms),
            'expected_finish':    iso,
            'p20_finish':         iso,
            'p50_finish':         iso,
            'p80_finish':         iso,
            'spread_days':        0,
            'p20_impact_days':    0,
            'p50_impact_days':    0,
            'p80_impact_days':    0,
            'distribution_stats': {
                'mean_finish': iso, 'std_days': 0.0,
                'min_finish': iso, 'max_finish': iso,
            },
            'activity_percentiles': {},
            'scope_size':           0,
            'iterations':           0,
            'seed':                 config.seed,
            'teac':                 teac_block,
            'computation_ms':       round((time.time() - t0) * 1000, 1),
        }

    # Deterministic baseline for expected-finish delta
    det_start, det_finish = _deterministic_finish_ms(
        dag_state, remaining, earliest_start_ms, status_ms, calendar)
    expected_finish_ms = float(np.max(det_finish[in_scope]))

    # Sample multipliers (M, n) and propagate through DAG
    mult_all, M_actual = _sample_multipliers(
        risk, activity_types, remaining, calendar, config)
    logger.info("Completion MC: n=%d, scope=%d, M=%d, calendar=%s",
                n, int(np.sum(in_scope)), M_actual,
                'yes' if calendar is not None else 'no')

    sim_start, sim_finish = _propagate_finish_ms(
        dag_state, remaining, earliest_start_ms, status_ms, mult_all,
        calendar)

    # Project finish per sample = max finish over in-scope activities
    scope_idx = np.where(in_scope)[0]
    proj_finish = np.max(sim_finish[:, scope_idx], axis=1)  # (M,)
    proj_sorted = np.sort(proj_finish)

    p20 = float(proj_sorted[int(0.20 * (M_actual - 1))])
    p50 = float(proj_sorted[int(0.50 * (M_actual - 1))])
    p80 = float(proj_sorted[int(0.80 * (M_actual - 1))])

    # Per-activity percentiles (only in-scope ones)
    idx_to_id = {v: k for k, v in id_to_idx.items()}
    act_pct = {}
    for j in scope_idx:
        col = np.sort(sim_finish[:, j])
        aid = idx_to_id[int(j)]
        act_pct[aid] = {
            'p20': _ms_to_iso(float(col[int(0.20 * (M_actual - 1))])),
            'p50': _ms_to_iso(float(col[int(0.50 * (M_actual - 1))])),
            'p80': _ms_to_iso(float(col[int(0.80 * (M_actual - 1))])),
            'mean_days_from_status': round(
                float(np.mean(col) - status_ms) / _MS_PER_DAY, 2),
        }

    mean_f = float(np.mean(proj_finish))
    std_ms = float(np.std(proj_finish))

    # P95 alongside P50/P80 for the calibrated companion (Flyvbjerg-
    # style tables publish at P95).
    p95 = float(proj_sorted[int(0.95 * (M_actual - 1))])

    # Reference-class calibration: when set, attach percentile-specific
    # adjusted finish dates per the table in solver/reference_classes.py.
    # The raw model fields stay unchanged so consumers reading the
    # existing contract (CompletionPrediction.js etc.) are unaffected.
    # _resolve_reference_class honours custom classes + overrides.
    try:
        ref_params = _resolve_reference_class(config)
    except ValueError as exc:
        # Defensive: validate_custom_classes / validate_class_definition
        # at the routes layer should already have caught this.  Log + None
        # so the request still returns the raw model output.
        logger.warning("Failed to resolve reference class: %s", exc)
        ref_params = None
    calibrated = None
    if ref_params is not None:
        # Defensive: missing percentile factors default to 1.0 (no
        # calibration shift) rather than crashing the response; surfaces
        # via calibration_warnings below so the partial config is
        # visible to the caller.
        factors = ref_params.get('percentile_factors') or {}
        f50 = factors.get('P50', 1.0)
        f80 = factors.get('P80', 1.0)
        f95 = factors.get('P95', 1.0)
        f99 = factors.get('P99')
        calibrated = {
            'p50_finish': _ms_to_iso(_apply_percentile_factor(
                p50, expected_finish_ms, f50)),
            'p80_finish': _ms_to_iso(_apply_percentile_factor(
                p80, expected_finish_ms, f80)),
            'p95_finish': _ms_to_iso(_apply_percentile_factor(
                p95, expected_finish_ms, f95)),
            # P99 may be Inf for IT / Olympics or missing for partial
            # custom classes; render as None and surface via
            # calibration_warnings instead.
            'p99_finish': (
                _ms_to_iso(_apply_percentile_factor(
                    p95, expected_finish_ms, f99))
                if (f99 is not None and np.isfinite(f99))
                else None),
            'reference_class':  (config.reference_class
                                 or (config.reference_class_overrides
                                     or {}).get('base')),
            'percentile_factors': factors,
            'mean_overrun_published': ref_params.get('mean_overrun'),
            'is_fat_tailed':         ref_params.get('is_fat_tailed'),
            'has_finite_mean':       ref_params.get('has_finite_mean', True),
            'tier_4_distribution':   ref_params.get('tier_4_distribution'),
            'pareto_alpha_range':    ref_params.get('pareto_alpha_range'),
            'max_multiplier_cap':    ref_params.get('max_multiplier_cap'),
            'citations':             ref_params.get('citations', []),
        }

    project_dates = None
    if len(proj_finish) > 0:
        project_dates = {
            'min': float(np.min(proj_finish)),
            'max': float(np.max(proj_finish)),
        }
    calibration_warnings = _build_calibration_warnings(
        nodes, in_scope, risk, ref_params, status_ms, project_dates)

    # Stochastic TEAC block: composes the MC finish-date distribution
    # with a baseline project_start anchor to produce Lipke-style
    # time-based EAC values per percentile.  Reuses the already-sorted
    # samples (no second pass) and the same expected_finish baseline
    # that drives p20_impact_days etc.
    teac_block = _compose_teac_block(
        nodes=nodes,
        status_ms=status_ms,
        expected_finish_ms=expected_finish_ms,
        proj_finish_sorted=proj_sorted,
        M_actual=M_actual,
        in_scope_count=int(np.sum(in_scope)))

    result = {
        'status_date':      _ms_to_iso(status_ms),
        'expected_finish':  _ms_to_iso(expected_finish_ms),
        'p20_finish':       _ms_to_iso(p20),
        'p50_finish':       _ms_to_iso(p50),
        'p80_finish':       _ms_to_iso(p80),
        'spread_days':      round((p80 - p20) / _MS_PER_DAY, 1),
        'p20_impact_days':  round((p20 - expected_finish_ms) / _MS_PER_DAY, 1),
        'p50_impact_days':  round((p50 - expected_finish_ms) / _MS_PER_DAY, 1),
        'p80_impact_days':  round((p80 - expected_finish_ms) / _MS_PER_DAY, 1),
        'distribution_stats': {
            'mean_finish': _ms_to_iso(mean_f),
            'std_days':    round(std_ms / _MS_PER_DAY, 2),
            'min_finish':  _ms_to_iso(float(proj_sorted[0])),
            'max_finish':  _ms_to_iso(float(proj_sorted[-1])),
        },
        'activity_percentiles': act_pct,
        'scope_size':           int(np.sum(in_scope)),
        'iterations':           int(M_actual),
        'seed':                 config.seed,
        'config': {
            'antithetic':      config.antithetic,
            'enable_risk':     config.enable_risk,
            'no_risk_below':   config.no_risk_below,
            'normal_from':     config.normal_from,
            'fat_tail_from':   config.fat_tail_from,
            'reference_class': config.reference_class,
        },
        'reference_class_calibrated': calibrated,
        'calibration_warnings':       calibration_warnings,
        'teac':                       teac_block,
        'computation_ms': round((time.time() - t0) * 1000, 1),
    }
    return result


def _empty_result(status_date, t0):
    iso = _ms_to_iso(_parse_iso_to_ms(status_date))
    status_ms = _parse_iso_to_ms(status_date)
    # Empty-project TEAC: no nodes, fallback project_start = status_ms,
    # zero PD / zero AT, all percentiles at status.  Uniform shape lets
    # consumers blindly read .teac without a presence check.
    teac_block = _compose_teac_block(
        nodes=[],
        status_ms=status_ms if status_ms is not None else 0.0,
        expected_finish_ms=status_ms if status_ms is not None else 0.0,
        proj_finish_sorted=np.array(
            [status_ms if status_ms is not None else 0.0], dtype=np.float64),
        M_actual=1,
        in_scope_count=0)
    return {
        'status_date':      iso,
        'expected_finish':  iso,
        'p20_finish':       iso,
        'p50_finish':       iso,
        'p80_finish':       iso,
        'spread_days':      0,
        'p20_impact_days':  0,
        'p50_impact_days':  0,
        'p80_impact_days':  0,
        'distribution_stats': {
            'mean_finish': iso, 'std_days': 0.0,
            'min_finish': iso, 'max_finish': iso,
        },
        'activity_percentiles': {},
        'scope_size':           0,
        'iterations':           0,
        'seed':                 42,
        'teac':                 teac_block,
        'computation_ms':       round((time.time() - t0) * 1000, 1),
    }
