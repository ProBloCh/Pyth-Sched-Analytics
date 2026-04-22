"""
paths/calendar_slack.py - CPM + calendar-aware ES/EF/LS/LF dates.

Ports PathScripts.js ``calculateSlackWithCalendar_Optimized`` (lines
6201-6570) into Python, reusing two existing primitives:

  * solver/dag.py ``build_dag`` / ``run_cpm`` for the forward/backward
    CPM pass with FS/SS/FF/SF + lag.
  * completion/calendar.py ``WorkingCalendar.advance_working_ms`` for
    O(log K) vectorised projection of working-hour offsets onto
    wall-clock UTC dates, skipping weekends and holidays.

The JS version only used the ``teamCalendar`` to normalise link
durations from days to hours -- its ES/EF/LS/LF stayed in raw hours.
Here we go further: after the CPM we also return per-node ISO
timestamps for ES/EF/LS/LF so the frontend can display wall-clock
dates without a second roundtrip.

Slack (TF) is always reported in working hours, matching JS
``slackValues``.  Callers that want calendar-days can divide by
``hours_per_day``.
"""

import numpy as np

from solver.dag import build_dag
from completion.calendar import (
    WorkingCalendar, advance_working_ms, estimate_horizon_days,
)
from completion.monte_carlo import _parse_iso_to_ms, _ms_to_iso
from evm.helpers import convert_to_hours


# Sensible defaults when caller doesn't supply project_start / horizon.
_DEFAULT_HOURS_PER_DAY = 8.0
_DEFAULT_WORKING_DAYS = frozenset({1, 2, 3, 4, 5})  # ISO Mon-Fri
_DEFAULT_HORIZON_MIN_DAYS = 365


def _normalise_durations_to_hours(nodes, hours_per_day, working_days_per_week):
    """Rewrite each node's Duration in working hours (as solver/dag.py expects).

    Delegates to ``evm.helpers.convert_to_hours`` so the unit map (minutes,
    seconds, weeks, months, years, plus prefix fallbacks) and the
    JS-compatible ``m`` ambiguity (minutes vs months) stay in one place.
    """
    out = []
    for n in nodes:
        m = dict(n)
        units = m.get('TimeUnits', m.get('timeUnits', 'Hours'))
        m['Duration'] = convert_to_hours(
            m.get('Duration', m.get('duration', 0)), units,
            hours_per_day=hours_per_day,
            working_days_per_week=working_days_per_week,
        )
        m['TimeUnits'] = 'Hours'
        out.append(m)
    return out


def _normalise_link_lags_to_hours(links, hours_per_day, working_days_per_week):
    """Lag conversion via the same ``convert_to_hours`` helper as node
    durations, so any future unit additions stay consistent."""
    out = []
    for link in links:
        m = dict(link)
        units = (m.get('lagUnits')
                 or m.get('timeUnits')
                 or m.get('TimeUnits')
                 or 'Hours')
        m['lag'] = convert_to_hours(
            m.get('lag', 0), units,
            hours_per_day=hours_per_day,
            working_days_per_week=working_days_per_week,
        )
        out.append(m)
    return out


def compute_calendar_slack(nodes, links, project_start=None,
                           calendar_config=None):
    """
    Run CPM and return per-node ES/EF/LS/LF/TF in working hours + ISO dates.

    Args:
        nodes: list of activity dicts (ID, Duration, TimeUnits).
        links: list of link dicts (source, target, type, lag, lagUnits).
        project_start: ISO timestamp (or None to skip wall-clock projection).
        calendar_config: dict with optional keys:
            hours_per_day (default 8)
            working_days  (list of ISO weekdays, default [1..5])
            holidays      (list of ISO dates)

    Returns:
        {
            'nodes':           list of ``{ID, ES, EF, LS, LF, TF,
                                          is_critical, ES_date, EF_date,
                                          LS_date, LF_date, slack_days}``,
            'makespan_hours':  float,
            'critical_count':  int,
            'project_start':   ISO string or None,
            'project_finish':  ISO string or None,
            'hours_per_day':   float,
        }
    """
    cfg = calendar_config or {}

    # Validate hours_per_day defensively -- ``calendar_config`` is
    # forwarded straight from the HTTP body so values like ``[]`` or
    # ``"eight"`` would otherwise blow up float() with a 500.  Fall back
    # to the default on any malformed input.
    raw_hpd = cfg.get('hours_per_day', _DEFAULT_HOURS_PER_DAY)
    try:
        hpd = float(raw_hpd)
    except (TypeError, ValueError):
        hpd = _DEFAULT_HOURS_PER_DAY
    if not (hpd > 0) or hpd != hpd:  # rejects 0, negatives, NaN
        hpd = _DEFAULT_HOURS_PER_DAY

    # Coerce working_days to a sanitised set of ISO weekdays {1..7}.
    raw_wd = cfg.get('working_days')
    if isinstance(raw_wd, (list, tuple, set)):
        working_days = sorted({
            int(d) for d in raw_wd
            if isinstance(d, (int, float)) and 1 <= int(d) <= 7
        })
    else:
        working_days = []
    if not working_days:
        working_days = sorted(_DEFAULT_WORKING_DAYS)

    raw_h = cfg.get('holidays')
    holidays = list(raw_h) if isinstance(raw_h, (list, tuple)) else []

    # Use the configured working-week length so weeks/months/years
    # convert consistently with the calendar (e.g. 6-day weeks won't get
    # silently scaled by the 5-day default in convert_to_hours).
    wdpw = float(len(working_days))

    # ---- CPM in working hours ------------------------------------------------
    nodes_h = _normalise_durations_to_hours(nodes, hpd, wdpw)
    links_h = _normalise_link_lags_to_hours(links, hpd, wdpw)
    state, id_to_idx = build_dag(nodes_h, links_h, default_duration=0.0)

    n = state.n
    result_nodes = [None] * n
    idx_to_id = {i: nid for nid, i in id_to_idx.items()}

    # ---- Optional wall-clock projection via WorkingCalendar ------------------
    start_ms = None
    cal = None
    if project_start is not None and n > 0:
        start_ms = _parse_iso_to_ms(project_start)
        if start_ms is not None:
            total_work = float(state.makespan)
            # Horizon: enough to cover LF on the sinks plus a safety factor.
            # We size it off makespan (not LF max) because LF <= makespan by
            # construction for well-formed DAGs and caller can't give us
            # a target finish date.
            horizon = estimate_horizon_days(
                total_work, hpd, safety_factor=2.0,
                min_days=_DEFAULT_HORIZON_MIN_DAYS)
            cal = WorkingCalendar.build(
                hours_per_day=hpd,
                working_days=working_days,
                holidays=holidays,
                start_ms=start_ms,
                horizon_days=horizon,
            )

    def _project(hours):
        if cal is None or start_ms is None:
            return None
        return _ms_to_iso(float(advance_working_ms(start_ms, hours, cal)))

    for i in range(n):
        es = float(state.ES[i])
        ef = float(state.EF[i])
        ls = float(state.LS[i])
        lf = float(state.LF[i])
        tf = float(state.TF[i])
        result_nodes[i] = {
            'ID': idx_to_id[i],
            'ES': es, 'EF': ef, 'LS': ls, 'LF': lf,
            'TF': tf,
            'slack_days': tf / hpd if hpd else 0.0,
            'is_critical': bool(state.critical_mask[i]),
            'ES_date': _project(es),
            'EF_date': _project(ef),
            'LS_date': _project(ls),
            'LF_date': _project(lf),
        }

    critical_count = int(np.count_nonzero(state.critical_mask))
    project_finish_iso = _project(float(state.makespan))

    return {
        'nodes': result_nodes,
        'makespan_hours': float(state.makespan),
        'critical_count': critical_count,
        'project_start': project_start if start_ms is not None else None,
        'project_finish': project_finish_iso,
        'hours_per_day': hpd,
    }
