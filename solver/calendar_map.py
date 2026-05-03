"""
solver/calendar_map.py - Map abstract solver makespan to a calendar date.

The solver's CPM operates in abstract time units (whatever Duration units
the request supplied -- conventionally working hours).  Real-world
deployments need to know *when* the optimised plan finishes.  This module
provides an additive mapping when the request supplies a project
start_date plus at least one calendar field (hours_per_day, working_days,
holidays) -- matching the gating used by completion/monte_carlo so the
two endpoint families behave consistently.

Reuses the vectorised WorkingCalendar from completion/calendar.py so the
calendar advance honours weekends and holidays consistently across the
two endpoint families.

When the calendar can't be built (no start_date, no calendar fields, or
unparseable start_date), returns None and the solver responses simply
omit the date fields -- existing callers see a byte-identical response
shape modulo additive keys.

TimeUnits handling
------------------
The solver's makespan inherits whatever TimeUnits the request's Duration
fields use.  Before mapping to a calendar we convert makespan to working
hours via ``evm.helpers.convert_to_hours`` using the **dominant**
TimeUnits across all activities (mode of node ``TimeUnits``, default
'Hours').  When the schedule mixes TimeUnits, only the dominant value
is used and a ``mixed_time_units`` warning is emitted in the response so
downstream callers can detect the heterogeneity.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import logging

from completion.calendar import (
    WorkingCalendar, advance_working_ms, estimate_horizon_days,
)
from evm.helpers import convert_to_hours

logger = logging.getLogger(__name__)


_CALENDAR_FIELDS = ('hours_per_day', 'working_days', 'holidays')


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


_DEFAULT_TIME_UNITS = 'Hours'


def _dominant_time_units(nodes):
    """Mode of node TimeUnits across the schedule.

    Returns (units_string, mixed_flag).

    Activities without an explicit ``TimeUnits`` field vote for the
    default 'Hours' -- matching the rest of the codebase's silent
    fallback (``evm.helpers.convert_to_hours`` defaults to 'Hours' when
    units are absent).  Without this, a single explicitly-tagged
    'Days' activity in a project of 99 untagged activities would
    incorrectly dominate the conversion.

    Comparison is **case-insensitive** (mode counts use the lower-cased
    form), so 'Hours' / 'hours' / 'HOURS' coalesce and don't falsely
    trigger ``mixed_time_units``.  Cross-alias mixing
    (e.g. 'Hours' vs 'h' vs 'hr') is **not** coalesced -- the keys
    stay distinct and ``mixed_time_units`` fires.  This is intentional:
    alias-aware coalescing would require probing
    ``evm.helpers.convert_to_hours`` per pair and is out of scope
    here.  ``convert_to_hours`` itself handles the full alias table
    downstream, so the conversion result is still correct -- only the
    flag is conservative.
    """
    if not nodes:
        return _DEFAULT_TIME_UNITS, False

    # Map normalised key -> canonical-cased representative; pick the
    # first variant we see so the public field reflects what the
    # caller actually wrote.
    canon_for = {}
    counts = Counter()
    for n in nodes:
        u = n.get('TimeUnits') or n.get('timeUnits')
        if u is None or u == '':
            key = _DEFAULT_TIME_UNITS.lower()
            canon_for.setdefault(key, _DEFAULT_TIME_UNITS)
        else:
            stripped = str(u).strip()
            key = stripped.lower()
            canon_for.setdefault(key, stripped)
        counts[key] += 1

    if not counts:
        return _DEFAULT_TIME_UNITS, False
    dom_key, _dom_n = counts.most_common(1)[0]
    mixed = len(counts) > 1
    return canon_for[dom_key], mixed


def map_makespan_to_date(makespan, project_ctx, project_ctx_dict=None,
                         nodes=None):
    """Compute the calendar end date for a given makespan.

    Args:
        makespan:           solver makespan in the **same time units as
                            the request's Duration fields** (typically
                            hours, but see TimeUnits handling below).
        project_ctx:        ProjectContext (start_date, hours_per_day,
                            working_days, holidays).
        project_ctx_dict:   raw project_context dict from the request,
                            used only to gate on whether at least one
                            calendar field was explicitly supplied
                            (matches completion/monte_carlo gating).
        nodes:              the request's activity list; used to detect
                            the dominant TimeUnits so the makespan can
                            be converted to working hours before being
                            handed to the WorkingCalendar.

    Returns:
        dict with end-date and calendar metadata, or None when the
        mapping cannot be built (no start_date, no calendar fields,
        unparseable start_date, or invalid makespan).

    The mapping is gated on **both** start_date AND at least one
    calendar field being explicitly present in the request, so it
    matches the completion/monte_carlo behaviour.  Callers that pass
    only start_date with no calendar fields get None, signalling
    that the response should omit the calendar block.
    """
    if makespan is None or makespan < 0:
        return None
    start_ms = _parse_iso_to_ms(getattr(project_ctx, 'start_date', None))
    if start_ms is None:
        return None

    cal_cfg = (project_ctx_dict or {}).get('calendar') or {}
    has_calendar_fields = any(k in cal_cfg for k in _CALENDAR_FIELDS)
    if not has_calendar_fields:
        return None

    hours_per_day = float(getattr(project_ctx, 'hours_per_day', 8.0) or 8.0)
    working_days = getattr(project_ctx, 'working_days', None) or [1, 2, 3, 4, 5]
    holidays = getattr(project_ctx, 'holidays', None) or []

    # Convert makespan to working hours using the dominant TimeUnits.
    # Without this step a project whose Durations are in days would map
    # day-counts straight into ``advance_working_ms`` (which expects
    # hours), producing end dates many factors off from reality.
    wd_count = sum(1 for d in working_days
                   if isinstance(d, (int, float)) and 1 <= int(d) <= 7) or 5
    units, mixed_units = _dominant_time_units(nodes)
    makespan_hours = convert_to_hours(
        float(makespan), units, hours_per_day, wd_count)
    if not (makespan_hours is not None and makespan_hours >= 0):
        return None

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
        'makespan_working_hours': float(makespan_hours),
        'time_units':             units,
        # Always present so consumers can read the flag without a
        # ``in`` check; True when the schedule mixed TimeUnits across
        # activities (case-insensitive, after coalescing missing /
        # empty values to the default 'Hours').
        'mixed_time_units':       mixed_units,
    }
