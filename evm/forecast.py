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


# ---------------------------------------------------------------------------
# Predicted-date propagation (FIX #20, #19, #18 chain)
# ---------------------------------------------------------------------------
#
# Port of updatePredictedValues_Improved (EVM.js 2630-2748) plus its
# helpers applyDistanceDecay (EVM.js 486-568) and
# propagatePredictionsTopologically (EVM.js 312-389).
#
# Why this matters: time_phased_ev case-4 (future EV) reads
# node.predictedStart / node.predictedEnd to draw the "predicted" curve
# beyond status_date.  Without this populated, future EV is 0 and the
# actual-branch chart falls off a cliff at the status date.
#
# Algorithm (per JS comments):
#   STEP 1: Initial assignment per node based on actuals + risk-adjusted
#           dates + scheduleMultiplier (4 cases: completed / 100%-no-dates /
#           in-progress / not-started).
#   STEP 2: Distance decay -- for each frontier node, BFS through
#           successors and decay performance_delta by 0.85^distance so
#           far-future activities don't get the full slip multiplier.
#   STEP 3: Topological propagation -- walk the DAG and push each
#           successor's predictedStart forward to satisfy the latest
#           predecessor constraint (FS / SS / FF / SF + lag).
#
# Mutates the cloned nodes in place (caller passes already-cloned list).
# ---------------------------------------------------------------------------


def _normalise_holiday_set(holidays):
    """Accept iterable of 'YYYY-MM-DD' strings, ISO datetimes, or {'date': ...}
    dicts; return set of 'YYYY-MM-DD' strings.  Mirrors the JS
    _evmDateKey format so holiday lookups match.
    """
    if not holidays:
        return set()
    out = set()
    for h in holidays:
        if h is None:
            continue
        if isinstance(h, dict):
            h = h.get('date') or h.get('Date')
            if h is None:
                continue
        dt = safe_date(h)
        if dt is not None:
            out.add(dt.strftime('%Y-%m-%d'))
    return out


def _normalise_working_days(working_days):
    """Accept JS getDay() or ISO weekday convention [1..5] = Mon-Fri;
    returns a set of Python weekday() values (Mon=0..Sun=6).

    Both conventions agree on 1-5 meaning Mon-Fri.  For Sun, JS uses 0
    and ISO uses 7; ``(d - 1) % 7`` correctly maps both to Python 6.
    """
    if not working_days:
        return {0, 1, 2, 3, 4}
    out = set()
    for d in working_days:
        try:
            out.add((int(d) - 1) % 7)
        except (TypeError, ValueError):
            continue
    return out or {0, 1, 2, 3, 4}


def _add_working_hours(start_dt, hours, calendar=None,
                       hours_per_day=8.0, working_days=None,
                       holidays=None):
    """Working-day-aware date advance.

    Mirrors EVM.js addDurationToDate (lines 951-984): adds
    ``ceil(hours / hours_per_day)`` working days, skipping weekends and
    holidays.

    Args:
        start_dt      : datetime
        hours         : working hours to add (ceil'd to whole days)
        calendar      : reserved for future WorkingCalendar integration
        hours_per_day : divisor for converting hours -> days
        working_days  : JS getDay() or ISO weekday list (default Mon-Fri)
        holidays      : iterable of 'YYYY-MM-DD' / ISO / {'date': ...}
                        entries that are NOT working days even if their
                        weekday is.

    Returns a new datetime; never mutates ``start_dt``.
    """
    if start_dt is None:
        return None
    if not math.isfinite(hours) or hours <= 0:
        return start_dt

    from datetime import timedelta
    days_to_add = int(math.ceil(hours / max(hours_per_day, 1e-9)))
    if days_to_add <= 0:
        return start_dt

    wd_set = _normalise_working_days(working_days)
    holiday_set = _normalise_holiday_set(holidays)

    cur = start_dt
    work_days_added = 0
    # Safety bound -- worst case is years of weekend+holiday chains;
    # 10x the requested span is plenty.
    max_iter = max(days_to_add * 10, 365 * 3)
    iters = 0
    while work_days_added < days_to_add and iters < max_iter:
        cur = cur + timedelta(days=1)
        iters += 1
        if cur.weekday() not in wd_set:
            continue
        if holiday_set and cur.strftime('%Y-%m-%d') in holiday_set:
            continue
        work_days_added += 1
    return cur


def _subtract_working_hours(end_dt, hours, hours_per_day=8.0,
                            working_days=None, holidays=None):
    """Reverse of _add_working_hours (for FF/SF backward passes)."""
    if end_dt is None:
        return None
    if not math.isfinite(hours) or hours <= 0:
        return end_dt
    from datetime import timedelta
    days_to_sub = int(math.ceil(hours / max(hours_per_day, 1e-9)))
    if days_to_sub <= 0:
        return end_dt
    wd_set = _normalise_working_days(working_days)
    holiday_set = _normalise_holiday_set(holidays)
    cur = end_dt
    sub = 0
    max_iter = max(days_to_sub * 10, 365 * 3)
    iters = 0
    while sub < days_to_sub and iters < max_iter:
        cur = cur - timedelta(days=1)
        iters += 1
        if cur.weekday() not in wd_set:
            continue
        if holiday_set and cur.strftime('%Y-%m-%d') in holiday_set:
            continue
        sub += 1
    return cur


def _build_succ_map(links):
    succ = {}
    for link in links or []:
        src = str(link.get('source', ''))
        tgt = str(link.get('target', ''))
        if not src or not tgt:
            continue
        succ.setdefault(src, []).append({
            'target': tgt,
            'type': str(link.get('type', 'FS')).upper(),
            'lag': float(link.get('lag', 0) or 0),
            'lagUnits': link.get('lagUnits') or link.get('TimeUnits') or 'h',
        })
    return succ


def _build_pred_map(links):
    pred = {}
    for link in links or []:
        src = str(link.get('source', ''))
        tgt = str(link.get('target', ''))
        if not src or not tgt:
            continue
        pred.setdefault(tgt, []).append({
            'source': src,
            'type': str(link.get('type', 'FS')).upper(),
            'lag': float(link.get('lag', 0) or 0),
            'lagUnits': link.get('lagUnits') or link.get('TimeUnits') or 'h',
        })
    return pred


def _topological_order(nodes, succ_map, node_by_id):
    """Kahn's algorithm; matches JS computeTopologicalOrder fallback."""
    in_deg = {str(n.get('ID', n.get('id', ''))): 0 for n in nodes or []}
    for src, edges in succ_map.items():
        for e in edges:
            tgt = e['target']
            if tgt in in_deg:
                in_deg[tgt] += 1
    queue = [nid for nid, d in in_deg.items() if d == 0]
    order = []
    while queue:
        nid = queue.pop(0)
        order.append(nid)
        for e in succ_map.get(nid, []):
            tgt = e['target']
            if tgt in in_deg:
                in_deg[tgt] -= 1
                if in_deg[tgt] == 0:
                    queue.append(tgt)
    # Append cycle stragglers
    for nid in in_deg:
        if nid not in order:
            order.append(nid)
    return order


def _link_lag_hours(link, hours_per_day, working_days_per_week):
    """Mirror PathScripts.getLinkLagHours: lag value with lagUnits aware."""
    return convert_to_hours(
        link.get('lag', 0),
        link.get('lagUnits', 'h'),
        hours_per_day, working_days_per_week)


def _initial_predict(node, status_dt, schedule_multiplier, slip_days,
                     safe_perf_delta, hours_per_day, working_days,
                     holidays=None):
    """Step 1: initial per-node prediction (matches EVM.js 2655-2726)."""
    base_start = safe_date(node.get('riskAdjustedStart') or node.get('Start'))
    base_end = safe_date(node.get('riskAdjustedEnd') or node.get('Finish'))
    planned_h = convert_to_hours(
        node.get('Duration', 0), node.get('TimeUnits', 'Hours'),
        hours_per_day, len(working_days) if working_days else 5)
    risk_h = convert_to_hours(
        node.get('riskAdjustedDuration') if node.get('riskAdjustedDuration') is not None
        else node.get('Duration', 0),
        node.get('TimeUnits', 'Hours'),
        hours_per_day, len(working_days) if working_days else 5)
    planned_start = safe_date(node.get('Start'))
    planned_end = safe_date(node.get('Finish'))

    # Initialize from forecasted dates
    node['predictedDuration'] = risk_h or planned_h or 0
    node['predictedStart'] = base_start or planned_start or status_dt
    node['predictedEnd'] = _add_working_hours(
        node['predictedStart'], node['predictedDuration'],
        hours_per_day=hours_per_day, working_days=working_days,
        holidays=holidays)

    pct = normalize_percent_complete(node.get('PercentComplete'))

    # CASE 1: Has actual span (completed)
    actual_start = safe_date(node.get('ActualStart'))
    actual_finish = safe_date(node.get('ActualFinish'))
    actual_duration = node.get('ActualDuration')
    has_actual_span = (actual_start is not None and actual_finish is not None
                       and actual_duration is not None)
    if has_actual_span:
        node['predictedStart'] = actual_start
        node['predictedEnd'] = actual_finish
        node['predictedDuration'] = convert_to_hours(
            actual_duration, node.get('TimeUnits', 'Hours'),
            hours_per_day, len(working_days) if working_days else 5)
        return

    # CASE 2: 100% complete but missing dates -> impute clamped to status_date
    if pct >= 1.0 and (not actual_start or not actual_finish):
        imputed_start = base_start or planned_start or status_dt
        imputed_finish = base_end or planned_end or status_dt
        if imputed_finish > status_dt:
            imputed_finish = status_dt
        node['predictedStart'] = imputed_start
        node['predictedEnd'] = imputed_finish
        node['predictedDuration'] = risk_h or planned_h or 0
        return

    # CASE 3: In-progress (ActualStart, 0 < pct < 1)
    if actual_start and 0.0 < pct < 1.0:
        done_h = planned_h * pct
        rem_h = max(0.0, planned_h - done_h) * safe_perf_delta
        node['predictedDuration'] = done_h + rem_h
        node['predictedStart'] = actual_start
        node['predictedEnd'] = _add_working_hours(
            node['predictedStart'], node['predictedDuration'],
            hours_per_day=hours_per_day, working_days=working_days,
            holidays=holidays)
        return

    # CASE 4: Not started -- shift by slip_days, scale duration
    from datetime import timedelta
    bs = base_start if base_start else status_dt
    shifted_start = bs if bs > status_dt else status_dt
    if slip_days != 0:
        shifted_start = shifted_start + timedelta(days=slip_days)
    node['predictedDuration'] = planned_h * safe_perf_delta
    node['predictedStart'] = shifted_start
    node['predictedEnd'] = _add_working_hours(
        shifted_start, node['predictedDuration'],
        hours_per_day=hours_per_day, working_days=working_days,
        holidays=holidays)


def _apply_distance_decay(nodes, frontier_ids, node_by_id, succ_map,
                          performance_delta, hours_per_day, working_days,
                          decay_factor=0.85, holidays=None):
    """Step 2: BFS distance decay (EVM.js 486-568)."""
    if not frontier_ids:
        return

    distance = {}
    queue = []
    for fid in frontier_ids:
        sid = str(fid)
        distance[sid] = 0
        queue.append(sid)

    while queue:
        nid = queue.pop(0)
        d = distance[nid]
        for edge in succ_map.get(nid, []):
            sid = edge['target']
            if sid not in distance:
                distance[sid] = d + 1
                queue.append(sid)

    for nid, dist in distance.items():
        node = node_by_id.get(nid)
        if node is None:
            continue
        # Skip completed / in-progress
        if node.get('ActualStart') or node.get('ActualFinish'):
            continue
        if normalize_percent_complete(node.get('PercentComplete')) > 0:
            continue

        decayed_weight = decay_factor ** dist
        decayed_delta = decayed_weight * performance_delta + (1 - decayed_weight) * 1.0

        planned_h = convert_to_hours(
            node.get('Duration', 0), node.get('TimeUnits', 'Hours'),
            hours_per_day, len(working_days) if working_days else 5)
        risk_h = convert_to_hours(
            node.get('riskAdjustedDuration') if node.get('riskAdjustedDuration') is not None
            else node.get('Duration', 0),
            node.get('TimeUnits', 'Hours'),
            hours_per_day, len(working_days) if working_days else 5)
        base_h = risk_h or planned_h
        node['predictedDuration'] = base_h * decayed_delta

        if node.get('predictedStart'):
            node['predictedEnd'] = _add_working_hours(
                node['predictedStart'], node['predictedDuration'],
                hours_per_day=hours_per_day, working_days=working_days,
                holidays=holidays)


def _propagate_topologically(nodes, links, node_by_id,
                             hours_per_day, working_days_per_week,
                             working_days, holidays=None):
    """Step 3: walk in topological order, satisfy predecessor constraints.

    Mirror EVM.js propagatePredictionsTopologically (lines 312-389).
    Supports FS / SS / FF / SF with lag.  Working-day arithmetic
    honours the optional ``holidays`` set.
    """
    succ_map = _build_succ_map(links)
    pred_map = _build_pred_map(links)
    topo = _topological_order(nodes, succ_map, node_by_id)

    for nid in topo:
        node = node_by_id.get(nid)
        if node is None:
            continue
        if node.get('ActualStart'):
            continue  # cannot adjust started activities

        max_required_start = None
        for plink in pred_map.get(nid, []):
            pred = node_by_id.get(plink['source'])
            if pred is None:
                continue
            lag_hours = _link_lag_hours(
                plink, hours_per_day, working_days_per_week)
            link_type = plink['type']
            req_start = None

            if link_type == 'FS':
                req_start = _add_working_hours(
                    pred.get('predictedEnd'), lag_hours,
                    hours_per_day=hours_per_day, working_days=working_days,
                    holidays=holidays)
            elif link_type == 'SS':
                req_start = _add_working_hours(
                    pred.get('predictedStart'), lag_hours,
                    hours_per_day=hours_per_day, working_days=working_days,
                    holidays=holidays)
            elif link_type == 'FF':
                req_end = _add_working_hours(
                    pred.get('predictedEnd'), lag_hours,
                    hours_per_day=hours_per_day, working_days=working_days,
                    holidays=holidays)
                if req_end is not None and node.get('predictedDuration', 0) > 0:
                    req_start = _subtract_working_hours(
                        req_end, node['predictedDuration'],
                        hours_per_day=hours_per_day,
                        working_days=working_days,
                        holidays=holidays)
            elif link_type == 'SF':
                req_end2 = _add_working_hours(
                    pred.get('predictedStart'), lag_hours,
                    hours_per_day=hours_per_day, working_days=working_days,
                    holidays=holidays)
                if req_end2 is not None and node.get('predictedDuration', 0) > 0:
                    req_start = _subtract_working_hours(
                        req_end2, node['predictedDuration'],
                        hours_per_day=hours_per_day,
                        working_days=working_days,
                        holidays=holidays)
            else:  # default to FS
                req_start = _add_working_hours(
                    pred.get('predictedEnd'), lag_hours,
                    hours_per_day=hours_per_day, working_days=working_days,
                    holidays=holidays)

            if req_start is not None and (max_required_start is None
                                          or req_start > max_required_start):
                max_required_start = req_start

        if (max_required_start is not None and node.get('predictedStart')
                and max_required_start > node['predictedStart']):
            node['predictedStart'] = max_required_start
            node['predictedEnd'] = _add_working_hours(
                max_required_start, node.get('predictedDuration', 0),
                hours_per_day=hours_per_day, working_days=working_days,
                holidays=holidays)


def update_predicted_values(nodes, links, status_date, schedule_multiplier,
                            slip_days, performance_delta,
                            hours_per_day=8.0,
                            working_days_per_week=5.0,
                            working_days=None,
                            holidays=None,
                            precomputed_frontier=None,
                            decay_factor=0.85):
    """Mutates ``nodes`` in place adding / updating ``predictedStart``,
    ``predictedEnd``, ``predictedDuration``.

    Caller MUST pass already-cloned nodes (the engine does this in
    ``_auto_complete_start_milestone`` so the caller's input is safe).

    All three propagation stages (initial assignment, distance decay,
    topological constraint) honour the optional ``holidays`` set,
    matching EVM.js addDurationToDate / subtractDurationFromDate
    behaviour that reads window.HOLIDAY_SET.

    Mirrors EVM.js updatePredictedValues_Improved.
    """
    if not nodes:
        return

    status_dt = safe_date(status_date)
    if status_dt is None:
        from datetime import datetime, timezone
        status_dt = datetime.now(tz=timezone.utc)

    safe_perf_delta = clamp(
        performance_delta if performance_delta else 1.0,
        Bounds.MIN_PERF_DELTA, Bounds.MAX_PERF_DELTA)

    if working_days is None:
        working_days = [1, 2, 3, 4, 5]

    # Pre-normalise the holiday set once so every call site uses the same
    # 'YYYY-MM-DD' canonical form (saves per-call conversion overhead).
    holiday_set = _normalise_holiday_set(holidays)

    node_by_id = {str(n.get('ID', n.get('id', ''))): n for n in nodes}

    # STEP 1: initial per-node assignment
    for n in nodes:
        _initial_predict(
            n, status_dt, schedule_multiplier, slip_days, safe_perf_delta,
            hours_per_day, working_days, holidays=holiday_set)

    # STEP 2: distance decay from frontier
    succ_map = _build_succ_map(links)
    if precomputed_frontier is not None and len(precomputed_frontier) > 0:
        frontier_ids = [str(f) for f in precomputed_frontier]
    else:
        frontier_ids = find_frontier_nodes(nodes, links)
    if frontier_ids:
        _apply_distance_decay(
            nodes, frontier_ids, node_by_id, succ_map,
            safe_perf_delta, hours_per_day, working_days,
            decay_factor=decay_factor, holidays=holiday_set)

    # STEP 3: topological propagation under FS/SS/FF/SF + lag
    if links:
        _propagate_topologically(
            nodes, links, node_by_id,
            hours_per_day, working_days_per_week, working_days,
            holidays=holiday_set)


# Re-export for the engine
__all__ = [
    'time_phased_ev', 'find_frontier_nodes', 'compute_schedule_delay',
    'get_sector_schedule_overrun', 'update_predicted_values',
]
