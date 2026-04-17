"""
evm/forecast.py - Time-phased earned value + schedule-delay prediction.

Ports the two high-signal algorithms from EVM.js:
  calculateTimePhasedEV        -> time_phased_ev          (lines 215-299)
  computeScheduleDelayImproved -> compute_schedule_delay  (lines 2298-2364)
  findLastActiveActivities     -> find_frontier_nodes     (lines 2240-2285)

The time-phased EV function implements a 4-case branch that matches
actual, in-progress (with or without ActualFinish), partial-progress
without actual dates, and future predictions -- see EVM.js v5 FIX
comments at the top of the file (lines 41-46).
"""

from __future__ import annotations

import math

from .helpers import (
    Bounds, clamp, safe_date, convert_to_hours,
    normalize_percent_complete, difference_in_calendar_days,
    get_sector_schedule_overrun,
)
from .metrics import compute_duration_weighted


# ---------------------------------------------------------------------------
# Time-phased cumulative EV at a given day
# ---------------------------------------------------------------------------

def time_phased_ev(nodes, day, status_date, hours_per_day: float = 8.0,
                   working_days_per_week: float = 5.0) -> float:
    """Port of calculateTimePhasedEV (EVM.js 215-299).

    Four cases, in priority order:

      1. ActualFinish on/before `day` -> full EV credit.
      2. ActualStart on/before `day`, still in progress -> linear
         interpolation.  If ActualFinish known, linear over actual
         duration.  If only PercentComplete known, interpolate to
         status_date and factor pct.
      3. Progress > 0 but no actual dates and `day` <= status_date ->
         linear on planned dates, capped by PercentComplete.
      4. `day` > status_date (future) -> use predictedStart /
         predictedEnd; if predEnd passed on `day`, full credit.

    Returns cumulative EV in hours across all nodes.
    """
    day_dt = safe_date(day)
    sd_dt = safe_date(status_date)
    if day_dt is None or sd_dt is None:
        return 0.0

    cum = 0.0
    for node in nodes or []:
        dur_raw = node.get('Duration', node.get('duration', 0))
        if dur_raw in (0, '0'):
            continue
        planned_hrs = convert_to_hours(
            dur_raw, node.get('TimeUnits', 'Hours'),
            hours_per_day, working_days_per_week)
        if planned_hrs <= 0:
            continue

        pct = normalize_percent_complete(node.get('PercentComplete'))
        actual_start = safe_date(node.get('ActualStart'))
        actual_finish = safe_date(node.get('ActualFinish'))

        # CASE 1: Completed
        if actual_finish and actual_finish <= day_dt:
            cum += planned_hrs
            continue

        # CASE 2: In progress (has ActualStart, on/before day)
        if actual_start and actual_start <= day_dt:
            if actual_finish:
                total_days = max(1.0,
                    difference_in_calendar_days(actual_finish, actual_start))
                elapsed_days = max(0.0,
                    difference_in_calendar_days(day_dt, actual_start))
                progress = min(1.0, elapsed_days / total_days)
                cum += planned_hrs * progress
            elif pct > 0:
                # Interpolate linearly from ActualStart up to status_date
                duration_to_date = max(1.0,
                    difference_in_calendar_days(sd_dt, actual_start))
                days_elapsed = max(0.0,
                    difference_in_calendar_days(day_dt, actual_start))
                interp = min(1.0, days_elapsed / duration_to_date)
                cum += (planned_hrs * pct) * interp
            continue

        # CASE 3: Has progress but no actual dates, day <= status_date
        if pct > 0 and day_dt <= sd_dt:
            p_start = safe_date(node.get('riskAdjustedStart')
                                or node.get('Start'))
            p_finish = safe_date(node.get('riskAdjustedEnd')
                                 or node.get('Finish'))
            if p_finish and p_finish <= day_dt:
                cum += planned_hrs * pct
            elif p_start and p_start <= day_dt:
                if p_finish:
                    total_days = max(1.0,
                        difference_in_calendar_days(p_finish, p_start))
                    elapsed_days = max(0.0,
                        difference_in_calendar_days(day_dt, p_start))
                    time_prog = min(1.0, elapsed_days / total_days)
                    cum += planned_hrs * min(time_prog, pct)
                else:
                    cum += planned_hrs * pct
            continue

        # CASE 4: Future -- use predicted dates
        if day_dt > sd_dt:
            pred_end = safe_date(node.get('predictedEnd'))
            pred_start = safe_date(node.get('predictedStart')
                                   or node.get('Start'))
            if pred_end and pred_end <= day_dt:
                cum += planned_hrs
            elif (pred_start and pred_start <= day_dt and pred_end
                  and day_dt < pred_end):
                total_days = max(1.0,
                    difference_in_calendar_days(pred_end, pred_start))
                elapsed_days = max(0.0,
                    difference_in_calendar_days(day_dt, pred_start))
                cum += planned_hrs * min(1.0, elapsed_days / total_days)
    return cum


# ---------------------------------------------------------------------------
# Frontier nodes
# ---------------------------------------------------------------------------

def find_frontier_nodes(nodes, links) -> list:
    """Port of findLastActiveActivities (EVM.js 2240-2285).

    Returns the list of node IDs that:
      - are not milestones,
      - have progress (ActualStart or PercentComplete > 0),
      - have no successor that has progress.

    These are the "leading edge" of the work, useful for chain-based
    prediction propagation.
    """
    # Build successor map by ID (string keys, as JS does)
    succ = {}
    for link in links or []:
        src = str(link.get('source', ''))
        tgt = str(link.get('target', ''))
        if not src or not tgt:
            continue
        succ.setdefault(src, []).append(tgt)

    node_by_id = {str(n.get('ID', n.get('id', ''))): n
                  for n in nodes or []}

    frontier = []
    for node in nodes or []:
        dur_raw = node.get('Duration', node.get('duration', 0))
        if dur_raw in (0, '0'):
            continue
        pct = normalize_percent_complete(node.get('PercentComplete'))
        has_progress = bool(node.get('ActualStart')) or pct > 0
        if not has_progress:
            continue

        nid = str(node.get('ID', node.get('id', '')))
        succs = succ.get(nid, [])
        has_succ_with_progress = False
        for sid in succs:
            succ_node = node_by_id.get(str(sid))
            if succ_node is None:
                continue
            s_pct = normalize_percent_complete(succ_node.get('PercentComplete'))
            if s_pct > 0 or succ_node.get('ActualStart'):
                has_succ_with_progress = True
                break

        if not has_succ_with_progress:
            frontier.append(nid)

    return frontier


# ---------------------------------------------------------------------------
# Schedule-delay prediction (FIX #18, #16)
# ---------------------------------------------------------------------------

def compute_schedule_delay(status_date, planned_end_date, forecasted_end_date,
                           spi, sector_schedule_overrun: float = 0.0,
                           nodes=None,
                           hours_per_day: float = 8.0,
                           working_days_per_week: float = 5.0) -> dict:
    """Port of computeScheduleDelayImproved (EVM.js 2298-2364).

    Returns:
        scheduleMultiplier : bounded [0.6, 2.0]
        slipDays           : bounded [-180, 365]
        performanceDelta   : bounded [MIN_PERF_DELTA, MAX_PERF_DELTA]
        actualDelayFactor  : bounded [0.5, 3.0]
        forecastedDelayFactor
        durationWeightedProgress : the full dict, or None if no nodes
    """
    sd = safe_date(status_date)
    planned = safe_date(planned_end_date) or sd
    forecasted = safe_date(forecasted_end_date) or planned

    forecasted_delay_factor = 1.0 + float(sector_schedule_overrun or 0.0)

    dw = None
    if nodes:
        dw = compute_duration_weighted(
            nodes, sd, hours_per_day, working_days_per_week)
        dw_spi = dw['durationWeightedSPI']
        actual_delay_factor = (clamp(1.0 / dw_spi, 0.5, 3.0)
                               if dw_spi > 0 else forecasted_delay_factor)
    else:
        safe_spi = spi if (spi is not None and math.isfinite(spi)) else 1.0
        actual_delay_factor = (clamp(1.0 / safe_spi, 0.5, 3.0)
                               if safe_spi > 0 else forecasted_delay_factor)

    raw_delta = (actual_delay_factor / forecasted_delay_factor
                 if forecasted_delay_factor > 0 else actual_delay_factor)
    performance_delta = clamp(
        raw_delta, Bounds.MIN_PERF_DELTA, Bounds.MAX_PERF_DELTA)

    schedule_multiplier = clamp(performance_delta, 0.6, 2.0)

    forecasted_remaining_days = max(0,
        math.ceil(difference_in_calendar_days(forecasted, sd)))
    predicted_remaining_days = forecasted_remaining_days * schedule_multiplier
    slip_days = clamp(
        round(predicted_remaining_days - forecasted_remaining_days),
        -180, 365)

    return {
        'scheduleMultiplier':      schedule_multiplier,
        'slipDays':                int(slip_days),
        'performanceDelta':        performance_delta,
        'actualDelayFactor':       actual_delay_factor,
        'forecastedDelayFactor':   forecasted_delay_factor,
        'durationWeightedProgress': dw,
    }


# Re-export for the engine
__all__ = [
    'time_phased_ev', 'find_frontier_nodes', 'compute_schedule_delay',
    'get_sector_schedule_overrun',
]
