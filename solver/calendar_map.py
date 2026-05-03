"""
solver/calendar_map.py - Map abstract solver makespan to a calendar date.

The solver's CPM operates in abstract time units (whatever Duration units
the request supplied -- conventionally working hours).  Real-world
deployments need to know *when* the optimised plan finishes.  This module
provides an additive mapping when the request supplies a project
start_date plus calendar fields (hours_per_day, working_days, holidays).

Reuses the vectorised WorkingCalendar from completion/calendar.py so the
calendar advance honours weekends and holidays consistently across the
two endpoint families.

When called without sufficient calendar inputs, returns None and the
solver responses simply omit the date fields -- existing callers see a
byte-identical response shape modulo additive keys.
"""

from __future__ import annotations

from datetime import datetime, timezone
import logging

from completion.calendar import (
    WorkingCalendar, advance_working_ms, estimate_horizon_days,
)

logger = logging.getLogger(__name__)


def _parse_iso_to_ms(value):
    """Parse an ISO date/datetime string to UTC epoch ms; None on failure."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = (value if value.tzinfo is not None
              else value.replace(tzinfo=timezone.utc))
        return dt.timestamp() * 1000.0
    try:
        s = str(value).replace('Z', '+00:00')
        if 'T' not in s and len(s) == 10:
            s = s + 'T00:00:00+00:00'
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000.0
    except (TypeError, ValueError):
        return None


def map_makespan_to_date(makespan_hours, project_ctx):
    """Compute the calendar end date for a given makespan.

    Args:
        makespan_hours: solver makespan, interpreted as **working hours**.
        project_ctx:    ProjectContext (start_date, hours_per_day,
                        working_days, holidays).

    Returns:
        dict with keys
            makespan_end_date_ms     (epoch ms)
            makespan_end_date        (ISO date 'YYYY-MM-DD')
            project_start_date       (ISO)
            calendar_hours_per_day
            calendar_working_days
            holidays_count
        or None when start_date is missing or unparseable.

    Convention: ``makespan_hours`` is treated as working hours.  Callers
    whose Durations are in days must multiply by hours_per_day before
    invoking the solver, OR pass start_date in matching units.  This
    matches how completion/monte_carlo aligns time units to the
    calendar (see completion/monte_carlo.py:_duration_to_work_hours).
    """
    if makespan_hours is None or makespan_hours < 0:
        return None
    start_ms = _parse_iso_to_ms(getattr(project_ctx, 'start_date', None))
    if start_ms is None:
        return None

    hours_per_day = float(getattr(project_ctx, 'hours_per_day', 8.0) or 8.0)
    working_days = getattr(project_ctx, 'working_days', None) or [1, 2, 3, 4, 5]
    holidays = getattr(project_ctx, 'holidays', None) or []

    horizon_days = estimate_horizon_days(
        max(makespan_hours, 1.0), hours_per_day,
        # Solver doesn't carry stochastic Pareto caps to this layer, so
        # use a moderate 2x safety factor (covers MC P80 inflation in
        # realistic ranges).  Fat-tailed sectors using
        # /completion/monte-carlo derive their own larger horizon.
        safety_factor=2.0,
    )

    cal = WorkingCalendar.build(
        hours_per_day=hours_per_day,
        working_days=working_days,
        holidays=holidays,
        start_ms=start_ms,
        horizon_days=horizon_days,
    )

    end_ms = float(advance_working_ms(start_ms, float(makespan_hours), cal))
    end_dt = datetime.fromtimestamp(end_ms / 1000.0, tz=timezone.utc)
    start_dt = datetime.fromtimestamp(start_ms / 1000.0, tz=timezone.utc)

    return {
        'makespan_end_date_ms':   end_ms,
        'makespan_end_date':      end_dt.strftime('%Y-%m-%d'),
        'project_start_date':     start_dt.strftime('%Y-%m-%d'),
        'calendar_hours_per_day': hours_per_day,
        'calendar_working_days':  list(working_days),
        'holidays_count':         len(holidays or []),
    }
