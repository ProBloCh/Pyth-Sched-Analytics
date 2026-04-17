"""
evm/metrics.py - EVM metric calculations (CPI, SPI, EAC,
duration-weighted SPI).

Scalar ports of EVM.js:
  calculateEVMetrics       -> compute_evm_metrics          (lines 1164-1198)
  calculateEAC             -> compute_eac                  (lines 1131-1161)
  calculateDurationWeightedProgress
                           -> compute_duration_weighted    (lines 2143-2229)

Each function returns native floats / dicts; routes.py handles JSON
serialisation.  Infinities are preserved on the raw SPI/CPI fields
(per JS v5 comment, line 1181-1183) so callers can detect data-quality
issues; the `_model` variants are clamped to evmConfig.bounds for
downstream use.
"""

from __future__ import annotations

import math

from .helpers import (
    Bounds, clamp, safe_date, convert_to_hours,
    normalize_percent_complete, difference_in_calendar_days,
)


# ---------------------------------------------------------------------------
# Core EVM metrics
# ---------------------------------------------------------------------------

def compute_evm_metrics(bcwp: float, acwp: float, bcws: float) -> dict:
    """Port of calculateEVMetrics (EVM.js 1164-1198).

    Returns the same shape the JS exposes on `window.evmMetrics.*`:
    SV, CV, SPI (raw), SPI_model (clamped), CPIcum (raw),
    CPIcum_model (clamped), flags.
    """
    if not (math.isfinite(bcwp) and math.isfinite(acwp) and math.isfinite(bcws)):
        return {
            'SV': 0.0, 'CV': 0.0,
            'SPI': 1.0, 'SPI_model': 1.0,
            'CPIcum': 1.0, 'CPIcum_model': 1.0,
            'flags': {'invalidInputs': True},
        }

    sv = bcwp - bcws
    cv = bcwp - acwp

    # Raw SPI: preserve Infinity when PV is 0 but EV > 0 (data-quality signal)
    if bcws > 0:
        spi = bcwp / bcws
    elif bcwp > 0:
        spi = math.inf
    else:
        spi = 1.0

    if acwp > 0:
        cpi = bcwp / acwp
    elif bcwp > 0:
        cpi = math.inf
    else:
        cpi = 1.0

    spi_model = clamp(spi, Bounds.MIN_SPI, Bounds.MAX_SPI) if math.isfinite(spi) else 1.0
    cpi_model = clamp(cpi, Bounds.MIN_CPI, Bounds.MAX_CPI) if math.isfinite(cpi) else 1.0

    return {
        'SV': sv,
        'CV': cv,
        'SPI': spi,
        'SPI_model': spi_model,
        'CPIcum': cpi,
        'CPIcum_model': cpi_model,
        'flags': {
            'pvZeroWithEV': (bcws <= 0 and bcwp > 0),
            'acZeroWithEV': (acwp <= 0 and bcwp > 0),
        },
    }


# ---------------------------------------------------------------------------
# Estimate at Completion
# ---------------------------------------------------------------------------

def compute_eac(bac: float, cpi: float, spi: float = 1.0,
                percent_complete: float = 0.0) -> float:
    """Port of calculateEAC (EVM.js 1131-1161).

    Tiered logic:
      < 10% complete  -> BAC * 1.15 (early pessimistic)
      > 90% complete  -> AC + remaining (near complete, trust actuals)
      CPI outside [0.8, 1.2] -> AC + remaining / (CPI * SPI) (blended)
      else            -> AC + remaining / CPI (stable performance)

    `percent_complete` is on the 0..100 scale (NOT 0..1) -- matches JS.
    """
    if not math.isfinite(bac) or bac <= 0:
        return 0.0

    cpi_c = clamp(cpi, Bounds.MIN_CPI, Bounds.MAX_CPI) if math.isfinite(cpi) else 1.0
    spi_c = clamp(spi, Bounds.MIN_SPI, Bounds.MAX_SPI) if math.isfinite(spi) else 1.0
    pct = clamp(percent_complete, 0.0, 100.0)

    ev = bac * (pct / 100.0)
    ac = ev / cpi_c if cpi_c > 0 else ev
    remaining = bac - ev

    if pct < 10.0:
        eac = bac * 1.15
    elif pct > 90.0:
        eac = ac + remaining
    elif cpi_c < 0.8 or cpi_c > 1.2:
        denom = cpi_c * spi_c
        eac = ac + (remaining / denom) if denom > 0 else ac + remaining
    else:
        eac = ac + (remaining / cpi_c) if cpi_c > 0 else ac + remaining

    lower = max(ac, bac * Bounds.MIN_EAC_FACTOR)
    upper = bac * (2.5 if pct > 50.0 else Bounds.MAX_EAC_FACTOR)
    return clamp(eac, lower, upper)


# ---------------------------------------------------------------------------
# Duration-weighted progress (FIX #18)
# ---------------------------------------------------------------------------

def compute_duration_weighted(nodes, status_date, hours_per_day: float = 8.0,
                              working_days_per_week: float = 5.0) -> dict:
    """Port of calculateDurationWeightedProgress (EVM.js 2143-2229).

    Compares actual hours completed vs. what the baseline says should
    be done by `status_date`.  The returned `durationWeightedSPI` is
    considered more robust than cost-based SPI when the baseline has
    heterogeneous activities (short-expensive vs long-cheap).
    """
    sd = safe_date(status_date) or safe_date('1970-01-01')
    sd_time = sd.timestamp() if sd else 0.0

    total_planned_hrs = 0.0
    planned_completed_hrs = 0.0
    actual_completed_hrs = 0.0

    for node in nodes or []:
        dur_raw = node.get('Duration', node.get('duration', 0))
        if dur_raw in (0, '0', 0.0, '0.0'):
            continue

        planned_hrs = convert_to_hours(
            dur_raw,
            node.get('TimeUnits', node.get('timeUnits', 'Hours')),
            hours_per_day, working_days_per_week)
        if planned_hrs <= 0:
            continue

        planned_start = safe_date(node.get('Start'))
        planned_finish = safe_date(node.get('Finish'))
        actual_finish = safe_date(node.get('ActualFinish'))
        pct = normalize_percent_complete(node.get('PercentComplete'))

        # If actual finish on/before status date, treat as 100%
        if actual_finish and actual_finish <= sd:
            pct = 1.0

        total_planned_hrs += planned_hrs
        actual_completed_hrs += planned_hrs * pct

        if planned_start is None or planned_finish is None:
            continue

        start_t = planned_start.timestamp()
        finish_t = planned_finish.timestamp()
        if sd_time >= finish_t:
            planned_completed_hrs += planned_hrs
        elif sd_time > start_t:
            total_duration = finish_t - start_t
            if total_duration > 0:
                progress = min(1.0, (sd_time - start_t) / total_duration)
                planned_completed_hrs += planned_hrs * progress
        # else: not yet started per baseline -- contributes 0

    planned_pct = (planned_completed_hrs / total_planned_hrs * 100.0
                   if total_planned_hrs > 0 else 0.0)
    actual_pct = (actual_completed_hrs / total_planned_hrs * 100.0
                  if total_planned_hrs > 0 else 0.0)

    if planned_completed_hrs > 0:
        dw_spi = actual_completed_hrs / planned_completed_hrs
    elif actual_completed_hrs > 0:
        dw_spi = 2.0  # ahead of baseline, cap at 2x
    else:
        dw_spi = 1.0

    return {
        'plannedProgressPct':     planned_pct,
        'actualProgressPct':      actual_pct,
        'durationWeightedSPI':    dw_spi,
        'durationWeightedSPI_model': clamp(dw_spi, Bounds.MIN_SPI, Bounds.MAX_SPI),
        'totalPlannedHours':      total_planned_hrs,
        'plannedCompletedHours':  planned_completed_hrs,
        'actualCompletedHours':   actual_completed_hrs,
    }


# ---------------------------------------------------------------------------
# Aggregated computations (BCWS, BCWP, ACWP, BAC)
# ---------------------------------------------------------------------------

def compute_bcws_hours(nodes, status_date, hours_per_day: float = 8.0,
                       working_days_per_week: float = 5.0) -> float:
    """Port of calculateBCWS_Hours (EVM.js 1022-1050).

    Planned value at `status_date` -- the sum over activities of:
      - full planned hours if planned_finish <= status_date
      - planned_hours * (elapsed / total) if in progress
      - 0 otherwise
    """
    sd = safe_date(status_date)
    if sd is None:
        return 0.0
    sd_time = sd.timestamp()

    bcws = 0.0
    for node in nodes or []:
        dur_raw = node.get('Duration', node.get('duration', 0))
        if dur_raw in (0, '0'):
            continue
        planned_start = safe_date(node.get('Start'))
        planned_finish = safe_date(node.get('Finish'))
        planned_hrs = convert_to_hours(
            dur_raw, node.get('TimeUnits', 'Hours'),
            hours_per_day, working_days_per_week)
        if planned_start is None or planned_finish is None or planned_hrs <= 0:
            continue

        s = planned_start.timestamp()
        f = planned_finish.timestamp()
        if sd_time >= f:
            bcws += planned_hrs
        elif sd_time > s and sd_time < f and (f - s) > 0:
            bcws += planned_hrs * ((sd_time - s) / (f - s))
    return bcws


def compute_bcwp_hours(nodes, hours_per_day: float = 8.0,
                       working_days_per_week: float = 5.0) -> float:
    """Port of calculateBCWP_Hours (EVM.js 1053-1062).

    Simple daily snapshot: EV = sum(BAC_i * pct_i).
    """
    s = 0.0
    for n in nodes or []:
        dur_raw = n.get('Duration', n.get('duration', 0))
        if dur_raw in (0, '0'):
            continue
        pct = normalize_percent_complete(n.get('PercentComplete'))
        s += convert_to_hours(
            dur_raw, n.get('TimeUnits', 'Hours'),
            hours_per_day, working_days_per_week) * pct
    return s


def compute_bac_hours(nodes, hours_per_day: float = 8.0,
                     working_days_per_week: float = 5.0) -> float:
    """Port of calculateBAC_Hours (EVM.js 1120-1128)."""
    s = 0.0
    for n in nodes or []:
        dur_raw = n.get('Duration', n.get('duration', 0))
        if dur_raw in (0, '0'):
            continue
        s += convert_to_hours(
            dur_raw, n.get('TimeUnits', 'Hours'),
            hours_per_day, working_days_per_week)
    return s


def compute_acwp(nodes, cost_rate: float = 1.0, status_date=None,
                 hours_per_day: float = 8.0,
                 working_days_per_week: float = 5.0,
                 apply_cost_rate: bool = True) -> float:
    """Port of calculateACWP (EVM.js 1065-1117).

    If ActualCost is set and positive, use it directly (assumed to be in
    cost units; will be passed through as hours when ``apply_cost_rate``
    is False by dividing by ``cost_rate``).  Otherwise impute from
    planned hours * pct, with a cost multiplier (1.0 .. 2.0) when the
    activity is behind expected linear progress.

    BUG FIX (vs original JS): the JS file mixes units -- it returns ACWP
    in cost dollars but feeds it into ``calculateEVMetrics(BCWP_hours,
    ACWP_dollars, BCWS_hours)`` which makes CPI = hours / dollars,
    off by a factor of CostRate.

    The ``apply_cost_rate`` flag controls which branch:
      True  (default): legacy behaviour, returns dollars (cost).
                       Used for cost-distribution arrays.
      False:           returns hours (no cost rate applied).  Used for
                       the metrics call so CPI = EV/AC is in consistent
                       units.

    The JS now has a sibling ``calculateACWP_Hours`` mirroring the
    False branch and feeds it into ``calculateEVMetrics``.
    """
    from datetime import datetime, timezone
    today = safe_date(status_date) or datetime.now(tz=timezone.utc)
    total = 0.0

    for node in nodes or []:
        try:
            dur_raw = node.get('Duration', node.get('duration', 0))
            if dur_raw in (0, '0'):
                continue
            pct = normalize_percent_complete(node.get('PercentComplete'))
            if pct == 0:
                continue

            ac_raw = node.get('ActualCost')
            try:
                ac_val = float(ac_raw) if ac_raw is not None else 0.0
            except (TypeError, ValueError):
                ac_val = 0.0
            if ac_val > 0 and math.isfinite(ac_val):
                if apply_cost_rate:
                    total += ac_val
                else:
                    # Convert dollars back to hours using node CostRate (best
                    # effort).  Falls back to project default cost_rate.
                    try:
                        node_rate = float(node.get('CostRate'))
                        if not math.isfinite(node_rate) or node_rate <= 0:
                            node_rate = cost_rate
                    except (TypeError, ValueError):
                        node_rate = cost_rate
                    total += ac_val / max(node_rate, 1e-9)
                continue

            node_start = safe_date(node.get('ActualStart') or node.get('Start'))
            if node_start is None:
                continue
            planned_hrs = convert_to_hours(
                dur_raw, node.get('TimeUnits', 'Hours'),
                hours_per_day, working_days_per_week)
            if not math.isfinite(planned_hrs) or planned_hrs <= 0:
                continue
            try:
                node_cost_rate = float(node.get('CostRate'))
                if not math.isfinite(node_cost_rate) or node_cost_rate <= 0:
                    node_cost_rate = cost_rate
            except (TypeError, ValueError):
                node_cost_rate = cost_rate

            cost_multiplier = 1.0
            if pct < 1.0:
                planned_finish = safe_date(node.get('Finish'))
                elapsed_days = difference_in_calendar_days(today, node_start)
                planned_days = max(1.0,
                    difference_in_calendar_days(planned_finish, node_start)
                    if planned_finish else 1.0)
                if elapsed_days > 0 and planned_days > 0:
                    expected_progress = min(1.0, elapsed_days / planned_days)
                    if pct < expected_progress and expected_progress > 0:
                        cost_multiplier = clamp(
                            expected_progress / pct, 1.0, 2.0)
            base = planned_hrs * pct * cost_multiplier
            total += base * (node_cost_rate if apply_cost_rate else 1.0)
        except Exception:
            continue
    return total


def compute_acwp_hours(nodes, status_date=None, hours_per_day: float = 8.0,
                       working_days_per_week: float = 5.0,
                       cost_rate: float = 1.0) -> float:
    """ACWP in hours, used for the unit-consistent CPI calculation.

    Convenience wrapper for ``compute_acwp(..., apply_cost_rate=False)``.
    Mirrors JS ``calculateACWP_Hours``.
    """
    return compute_acwp(nodes, cost_rate, status_date,
                        hours_per_day, working_days_per_week,
                        apply_cost_rate=False)


# ---------------------------------------------------------------------------
# Forecasted variants (use risk-adjusted dates / durations)
# ---------------------------------------------------------------------------

def compute_forecasted_bcwp(nodes, status_date, hours_per_day: float = 8.0,
                            working_days_per_week: float = 5.0) -> float:
    """Port of calculateForecastedBCWP (EVM.js 1201-1229).

    Same as BCWS_Hours but uses riskAdjustedStart / riskAdjustedEnd when
    present, falling back to Start / Finish.
    """
    sd = safe_date(status_date)
    if sd is None:
        return 0.0
    sd_time = sd.timestamp()
    bcwp = 0.0
    for node in nodes or []:
        dur_raw = node.get('Duration', node.get('duration', 0))
        if dur_raw in (0, '0'):
            continue
        rstart = safe_date(node.get('riskAdjustedStart') or node.get('Start'))
        rend = safe_date(node.get('riskAdjustedEnd') or node.get('Finish'))
        planned_hrs = convert_to_hours(
            dur_raw, node.get('TimeUnits', 'Hours'),
            hours_per_day, working_days_per_week)
        if rstart is None or rend is None or planned_hrs <= 0:
            continue
        s = rstart.timestamp()
        f = rend.timestamp()
        if sd_time >= f:
            bcwp += planned_hrs
        elif sd_time > s and (f - s) > 0:
            bcwp += planned_hrs * ((sd_time - s) / (f - s))
    return bcwp


def compute_forecasted_acwp(nodes, status_date, cost_rate: float = 1.0,
                            hours_per_day: float = 8.0,
                            working_days_per_week: float = 5.0,
                            apply_cost_rate: bool = True) -> float:
    """Port of calculateForecastedACWP (EVM.js 1232-1264).

    BUG FIX (matches compute_acwp): ``apply_cost_rate=False`` returns
    hours instead of dollars so the CPI calculation has consistent
    units.  Engine uses False for the metrics call and True for the
    cost-distribution display.
    """
    sd = safe_date(status_date)
    if sd is None:
        return 0.0
    sd_time = sd.timestamp()
    acwp = 0.0
    for node in nodes or []:
        dur_raw = node.get('Duration', node.get('duration', 0))
        if dur_raw in (0, '0'):
            continue
        rstart = safe_date(node.get('riskAdjustedStart') or node.get('Start'))
        rend = safe_date(node.get('riskAdjustedEnd') or node.get('Finish'))
        risk_hrs = convert_to_hours(
            node.get('riskAdjustedDuration') or dur_raw,
            node.get('TimeUnits', 'Hours'),
            hours_per_day, working_days_per_week)
        try:
            node_rate = float(node.get('CostRate'))
            if not math.isfinite(node_rate) or node_rate <= 0:
                node_rate = cost_rate
        except (TypeError, ValueError):
            node_rate = cost_rate
        if rstart is None or rend is None or risk_hrs <= 0:
            continue
        s = rstart.timestamp()
        f = rend.timestamp()
        rate_factor = node_rate if apply_cost_rate else 1.0
        if sd_time >= f:
            acwp += risk_hrs * rate_factor
        elif sd_time > s and (f - s) > 0:
            acwp += risk_hrs * rate_factor * ((sd_time - s) / (f - s))
    return acwp


def compute_forecasted_acwp_hours(nodes, status_date,
                                  hours_per_day: float = 8.0,
                                  working_days_per_week: float = 5.0) -> float:
    """Forecasted ACWP in hours.  Mirrors JS calculateForecastedACWP_Hours."""
    return compute_forecasted_acwp(nodes, status_date,
                                   cost_rate=1.0,
                                   hours_per_day=hours_per_day,
                                   working_days_per_week=working_days_per_week,
                                   apply_cost_rate=False)
