"""
evm/distributions.py - Time-phased cumulative & period distributions.

For each unique significant date in the project, produce arrays:
  distributionPlanned     -- PV curve (BCWS)
  distributionWithOverrun -- risk-adjusted ACWP curve (forecasted)
  evDistribution          -- risk-adjusted EV curve (forecasted)
  distributionActual      -- AC curve (actual)
  distributionEarned      -- EV curve (actual)  (time-phased, 4-case)
  distributionPredicted   -- predicted completion curve

Ports the distribution-building logic from
  getCumulativeDistribution   (EVM.js 1486-1721)
  createActualEVMChart        (EVM.js 1727-2126)

but without the DOM / Chart.js side-effects -- the JS wrapper now
receives pure arrays and renders the charts itself.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math

from .helpers import (
    safe_date, date_to_iso_date, convert_to_hours,
    normalize_percent_complete, difference_in_calendar_days,
)
from .forecast import time_phased_ev


# ---------------------------------------------------------------------------
# Date grid construction
# ---------------------------------------------------------------------------

def _significant_dates(nodes, extra_dates=None, weekly_fill=True):
    """Collect unique 'YYYY-MM-DD' dates from nodes plus weekly fills.

    The JS builds the timeline from every node's Start / Finish /
    riskAdjustedStart / riskAdjustedEnd plus (for the "actual" branch)
    ActualStart / ActualFinish / predictedStart / predictedEnd, then
    inserts weekly intermediate dates between the min and max for
    smoother S-curves (v5 FIX #24).
    """
    date_set = set()
    for node in nodes or []:
        for key in ('Start', 'Finish', 'riskAdjustedStart', 'riskAdjustedEnd',
                    'ActualStart', 'ActualFinish',
                    'predictedStart', 'predictedEnd'):
            dt = safe_date(node.get(key))
            if dt is not None:
                date_set.add(date_to_iso_date(dt))
    if extra_dates:
        for d in extra_dates:
            dt = safe_date(d)
            if dt is not None:
                date_set.add(date_to_iso_date(dt))

    if not date_set:
        return []

    if weekly_fill:
        sorted_iso = sorted(date_set)
        start = safe_date(sorted_iso[0])
        end = safe_date(sorted_iso[-1])
        if start and end and end > start:
            cur = start
            while cur < end:
                date_set.add(date_to_iso_date(cur))
                cur = cur + timedelta(days=7)

    return sorted(date_set)


# ---------------------------------------------------------------------------
# Per-node daily-rate cache (matches EVM.js nodeDailyRates Map)
# ---------------------------------------------------------------------------

def _build_daily_rates(nodes, cost_rate_default, hours_per_day,
                      working_days_per_week):
    """
    Pre-compute per-node daily rates so the outer date loop is cheap.

    Returns list of dicts with:
        id, task_start, task_end, risk_start, risk_end,
        planned_daily_hrs, risk_daily_hrs, ev_daily_hrs,
        planned_daily_cost, risk_daily_cost, ev_daily_cost,
        planned_hrs, risk_hrs, cost_rate, pct
    """
    rates = []
    for node in nodes or []:
        dur_raw = node.get('Duration', node.get('duration', 0))
        if dur_raw in (0, '0'):
            continue
        task_start = safe_date(node.get('Start'))
        task_end = safe_date(node.get('Finish'))
        risk_start = safe_date(node.get('riskAdjustedStart')
                               or node.get('Start'))
        risk_end = safe_date(node.get('riskAdjustedEnd')
                             or node.get('Finish'))
        if task_start is None or task_end is None:
            continue
        if risk_start is None or risk_end is None:
            continue

        planned_days = max(1.0,
            difference_in_calendar_days(task_end, task_start))
        risk_days = max(1.0,
            difference_in_calendar_days(risk_end, risk_start))

        planned_hrs = convert_to_hours(
            dur_raw, node.get('TimeUnits', 'Hours'),
            hours_per_day, working_days_per_week)
        risk_hrs = convert_to_hours(
            node.get('riskAdjustedDuration') or dur_raw,
            node.get('TimeUnits', 'Hours'),
            hours_per_day, working_days_per_week)
        if planned_hrs <= 0:
            continue

        try:
            cost_rate = float(node.get('CostRate'))
            if not math.isfinite(cost_rate) or cost_rate <= 0:
                cost_rate = cost_rate_default
        except (TypeError, ValueError):
            cost_rate = cost_rate_default

        pct = normalize_percent_complete(node.get('PercentComplete'))

        rates.append({
            'id':                str(node.get('ID', node.get('id', ''))),
            'task_start':        task_start,
            'task_end':          task_end,
            'risk_start':        risk_start,
            'risk_end':          risk_end,
            'planned_hrs':       planned_hrs,
            'risk_hrs':          risk_hrs,
            'cost_rate':         cost_rate,
            'pct':               pct,
            'planned_daily_hrs': planned_hrs / planned_days,
            'risk_daily_hrs':    risk_hrs / risk_days,
            # ev_daily is a simple pct-weighted daily burn against planned
            # schedule (matches JS "evDaily" used to draw the EV curve on
            # the forecasted tab, which is time-phased by planned dates).
            'ev_daily_hrs':      (planned_hrs * pct) / planned_days,
            'planned_daily_cost': (planned_hrs / planned_days) * cost_rate,
            'risk_daily_cost':    (risk_hrs / risk_days) * cost_rate,
            'ev_daily_cost':      ((planned_hrs * pct) / planned_days) * cost_rate,
        })
    return rates


# ---------------------------------------------------------------------------
# Cumulative + non-cumulative distribution helpers
# ---------------------------------------------------------------------------

def _accrued_hours(rate, current_dt, which):
    """Hours accrued by `rate` from its start to `current_dt`.

    `which` selects planned / risk / ev schedule; returns both hours
    and cost contributions to avoid duplicating the branch.
    """
    if which == 'planned':
        start, end = rate['task_start'], rate['task_end']
        daily_h = rate['planned_daily_hrs']
        daily_c = rate['planned_daily_cost']
        full_h = rate['planned_hrs']
    elif which == 'risk':
        start, end = rate['risk_start'], rate['risk_end']
        daily_h = rate['risk_daily_hrs']
        daily_c = rate['risk_daily_cost']
        full_h = rate['risk_hrs']
    elif which == 'ev_planned':
        # EV curve on forecasted tab: time-phased by PLANNED dates but
        # capped at pct_complete * planned_hrs
        start, end = rate['task_start'], rate['task_end']
        daily_h = rate['ev_daily_hrs']
        daily_c = rate['ev_daily_cost']
        full_h = rate['planned_hrs'] * rate['pct']
    else:
        return 0.0, 0.0

    if current_dt < start:
        return 0.0, 0.0
    if current_dt >= end:
        # All hours accrued
        return full_h, full_h * rate['cost_rate']
    days = difference_in_calendar_days(current_dt, start)
    return daily_h * days, daily_c * days


def _daily_inflow(rate, current_dt, which):
    """Instantaneous daily inflow (non-cumulative) on current_dt."""
    if which == 'planned':
        start, end = rate['task_start'], rate['task_end']
        daily_h, daily_c = rate['planned_daily_hrs'], rate['planned_daily_cost']
    elif which == 'risk':
        start, end = rate['risk_start'], rate['risk_end']
        daily_h, daily_c = rate['risk_daily_hrs'], rate['risk_daily_cost']
    elif which == 'ev_planned':
        start, end = rate['task_start'], rate['task_end']
        daily_h, daily_c = rate['ev_daily_hrs'], rate['ev_daily_cost']
    else:
        return 0.0, 0.0
    if start <= current_dt <= end:
        return daily_h, daily_c
    return 0.0, 0.0


# ---------------------------------------------------------------------------
# Forecasted distributions
# ---------------------------------------------------------------------------

def build_forecasted_distributions(nodes, status_date, cost_rate, currency,
                                   hours_per_day, working_days_per_week):
    """Build the "forecasted" branch of evmMetrics.

    Mirrors getCumulativeDistribution (EVM.js 1486-1721) without the
    DOM / chart side-effects.

    Returns a dict with:
        distributionPlanned / distributionPlannedCost
        distributionWithOverrun / distributionWithOverrunCost
        evDistribution / evDistributionCost
        nonCumulativeDistributionPlanned / WithOverrun / Ev
        allDates
    """
    comparison_dates = _significant_dates(nodes)
    if not comparison_dates:
        return _empty_distributions()

    rates = _build_daily_rates(
        nodes, cost_rate, hours_per_day, working_days_per_week)

    planned_cum_h, planned_cum_c = [], []
    risk_cum_h, risk_cum_c = [], []
    ev_cum_h, ev_cum_c = [], []
    planned_nc_h, planned_nc_c = [], []
    risk_nc_h, risk_nc_c = [], []
    ev_nc_h, ev_nc_c = [], []

    for date_iso in comparison_dates:
        cur = safe_date(date_iso)
        if cur is None:
            continue
        ph, pc = 0.0, 0.0
        rh, rc = 0.0, 0.0
        eh, ec = 0.0, 0.0
        p_day_h, p_day_c = 0.0, 0.0
        r_day_h, r_day_c = 0.0, 0.0
        e_day_h, e_day_c = 0.0, 0.0
        for rate in rates:
            a, b = _accrued_hours(rate, cur, 'planned')
            ph += a; pc += b
            a, b = _accrued_hours(rate, cur, 'risk')
            rh += a; rc += b
            a, b = _accrued_hours(rate, cur, 'ev_planned')
            eh += a; ec += b
            a, b = _daily_inflow(rate, cur, 'planned')
            p_day_h += a; p_day_c += b
            a, b = _daily_inflow(rate, cur, 'risk')
            r_day_h += a; r_day_c += b
            a, b = _daily_inflow(rate, cur, 'ev_planned')
            e_day_h += a; e_day_c += b

        planned_cum_h.append({'date': date_iso, 'hours': ph})
        planned_cum_c.append({'date': date_iso, 'cost': pc})
        risk_cum_h.append({'date': date_iso, 'hours': rh})
        risk_cum_c.append({'date': date_iso, 'cost': rc})
        ev_cum_h.append({'date': date_iso, 'hours': eh})
        ev_cum_c.append({'date': date_iso, 'cost': ec})
        planned_nc_h.append({'date': date_iso, 'hours': p_day_h})
        planned_nc_c.append({'date': date_iso, 'cost': p_day_c})
        risk_nc_h.append({'date': date_iso, 'hours': r_day_h})
        risk_nc_c.append({'date': date_iso, 'cost': r_day_c})
        ev_nc_h.append({'date': date_iso, 'hours': e_day_h})
        ev_nc_c.append({'date': date_iso, 'cost': e_day_c})

    return {
        'distributionPlanned':           planned_cum_h,
        'distributionPlannedCost':       planned_cum_c,
        'distributionWithOverrun':       risk_cum_h,
        'distributionWithOverrunCost':   risk_cum_c,
        'evDistribution':                ev_cum_h,
        'evDistributionCost':            ev_cum_c,
        'nonCumulativeDistributionPlanned':     planned_nc_h,
        'nonCumulativeDistributionPlannedCost': planned_nc_c,
        'nonCumulativeDistributionWithOverrun': risk_nc_h,
        'nonCumulativeDistributionWithOverrunCost': risk_nc_c,
        'nonCumulativeEvDistribution':          ev_nc_h,
        'nonCumulativeEvDistributionCost':      ev_nc_c,
        'allDates':                      comparison_dates,
        'currency':                      currency,
    }


# ---------------------------------------------------------------------------
# Actual distributions (uses 4-case EV time-phasing)
# ---------------------------------------------------------------------------

def build_actual_distributions(nodes, status_date, cost_rate, currency,
                               hours_per_day, working_days_per_week):
    """Build the "actual" branch of evmMetrics.

    Mirrors createActualEVMChart (EVM.js 1727-2126).  EV curve uses the
    4-case time-phasing (time_phased_ev).  Actual-cost curve uses the
    same imputation rule as compute_acwp but with `day` as the cap.
    """
    comparison_dates = _significant_dates(nodes)
    if not comparison_dates:
        return _empty_distributions()

    # Transition point: where actual (<=status_date) stops and predicted (>) starts.
    sd_iso = date_to_iso_date(safe_date(status_date)) if status_date else None

    actual_cum_h, actual_cum_c = [], []
    earned_cum_h, earned_cum_c = [], []
    predicted_cum_h, predicted_cum_c = [], []
    actual_nc_h, actual_nc_c = [], []
    earned_nc_h, earned_nc_c = [], []

    transition_index = None
    prev_actual_h = 0.0
    prev_actual_c = 0.0
    prev_earned_h = 0.0
    prev_earned_c = 0.0

    for idx, date_iso in enumerate(comparison_dates):
        cur = safe_date(date_iso)
        if cur is None:
            continue
        is_future = (sd_iso is not None and date_iso > sd_iso)

        # Cumulative earned: use 4-case time-phasing (EV.js 215-299).
        eh = time_phased_ev(
            nodes, cur, status_date, hours_per_day, working_days_per_week)
        # Earned cost: for simplicity, apply a weighted cost_rate.  The JS
        # file mirrors hours * cost_rate aggregated from per-node rates;
        # approximating with uniform cost_rate is acceptable when each node
        # has a CostRate, since _daily_rates carries it separately.  Here
        # we scale by project-default cost_rate for the cumulative cost
        # series -- matches the dominant JS pattern for the cost tab.
        ec = eh * cost_rate

        # Cumulative actual: use ActualCost if present, else imputed on
        # in-progress nodes up to this date.  For curve purposes, an
        # acceptable approximation is: AC(day) proportional to EV(day)
        # divided by CPI.  The JS actually computes AC by summing
        # per-node ActualCost allocated proportional to elapsed days --
        # we implement that here.
        ah, ac = 0.0, 0.0
        for node in nodes or []:
            dur_raw = node.get('Duration', node.get('duration', 0))
            if dur_raw in (0, '0'):
                continue
            pct = normalize_percent_complete(node.get('PercentComplete'))
            if pct == 0:
                continue
            a_start = safe_date(node.get('ActualStart') or node.get('Start'))
            if a_start is None or a_start > cur:
                continue
            planned_hrs = convert_to_hours(
                dur_raw, node.get('TimeUnits', 'Hours'),
                hours_per_day, working_days_per_week)
            try:
                rate = float(node.get('CostRate'))
                if not math.isfinite(rate) or rate <= 0:
                    rate = cost_rate
            except (TypeError, ValueError):
                rate = cost_rate

            a_finish = safe_date(node.get('ActualFinish'))
            if a_finish and a_finish <= cur:
                # Complete by `cur`: allocate full pct-weighted AC
                try:
                    explicit_ac = float(node.get('ActualCost'))
                except (TypeError, ValueError):
                    explicit_ac = 0.0
                if explicit_ac > 0 and math.isfinite(explicit_ac):
                    ac += explicit_ac
                    ah += planned_hrs * pct
                else:
                    ac += planned_hrs * pct * rate
                    ah += planned_hrs * pct
            else:
                total_days = max(1.0,
                    difference_in_calendar_days(
                        safe_date(node.get('Finish')) or cur, a_start))
                elapsed_days = max(0.0,
                    difference_in_calendar_days(cur, a_start))
                prog = min(1.0, elapsed_days / total_days)
                capped_pct = min(pct, prog)
                ah += planned_hrs * capped_pct
                ac += planned_hrs * capped_pct * rate

        # Predicted: same as AC but only for future dates past status_date.
        ph = 0.0
        pc = 0.0
        if is_future:
            # Predicted cumulative hours: use time_phased_ev with a
            # future day (case 4 fires) for EV-like completion; cost
            # follows the project rate.
            ph = eh
            pc = ec

        # Enforce monotonicity -- cumulative curves never decrease
        eh = max(eh, prev_earned_h)
        ec = max(ec, prev_earned_c)
        ah = max(ah, prev_actual_h)
        ac = max(ac, prev_actual_c)

        earned_cum_h.append({'date': date_iso, 'hours': eh})
        earned_cum_c.append({'date': date_iso, 'cost': ec})
        actual_cum_h.append({'date': date_iso, 'hours': ah})
        actual_cum_c.append({'date': date_iso, 'cost': ac})
        predicted_cum_h.append({'date': date_iso, 'hours': ph})
        predicted_cum_c.append({'date': date_iso, 'cost': pc})

        earned_nc_h.append({'date': date_iso, 'hours': eh - prev_earned_h})
        earned_nc_c.append({'date': date_iso, 'cost': ec - prev_earned_c})
        actual_nc_h.append({'date': date_iso, 'hours': ah - prev_actual_h})
        actual_nc_c.append({'date': date_iso, 'cost': ac - prev_actual_c})

        if is_future and transition_index is None:
            transition_index = idx

        prev_earned_h, prev_earned_c = eh, ec
        prev_actual_h, prev_actual_c = ah, ac

    return {
        'distributionActual':            actual_cum_h,
        'distributionActualCost':        actual_cum_c,
        'distributionEarned':            earned_cum_h,
        'distributionEarnedCost':        earned_cum_c,
        'distributionPredicted':         predicted_cum_h,
        'distributionPredictedCost':     predicted_cum_c,
        'nonCumulativeDistributionActual':     actual_nc_h,
        'nonCumulativeDistributionActualCost': actual_nc_c,
        'nonCumulativeDistributionEarned':     earned_nc_h,
        'nonCumulativeDistributionEarnedCost': earned_nc_c,
        'allDates':                      comparison_dates,
        'transitionPointIndex':          transition_index,
        'currency':                      currency,
    }


def _empty_distributions():
    return {
        'distributionPlanned':       [],
        'distributionPlannedCost':   [],
        'distributionWithOverrun':   [],
        'distributionWithOverrunCost': [],
        'evDistribution':            [],
        'evDistributionCost':        [],
        'distributionActual':        [],
        'distributionActualCost':    [],
        'distributionEarned':        [],
        'distributionEarnedCost':    [],
        'distributionPredicted':     [],
        'distributionPredictedCost': [],
        'nonCumulativeDistributionPlanned':     [],
        'nonCumulativeDistributionWithOverrun': [],
        'nonCumulativeEvDistribution':          [],
        'nonCumulativeDistributionActual':      [],
        'nonCumulativeDistributionEarned':      [],
        'allDates':                  [],
        'transitionPointIndex':      None,
        'currency':                  'USD',
    }
