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
import math

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
        # Zero-Duration milestones don't carry meaningful unit
        # information (a milestone is a point in time, unit-agnostic),
        # so they're excluded from the unit vote.  Without this, a
        # project of mostly Days-units activities plus a single
        # milestone would tie at (Hours-via-default, Days-explicit) and
        # pick Hours by insertion order, skewing the calendar mapping.
        # Coerce to float so any zero-equivalent representation
        # (0, 0.0, '0', '0.0', '0.00', etc.) is caught -- the static
        # sentinel set used elsewhere in the codebase misses '0.0'.
        # Default to 1.0 (NOT 0) when Duration is absent: matches
        # solver/dag.build_dag's default_duration=1.0 for solver
        # endpoints, so a node the CPM treats as a real activity is
        # also counted in the unit vote here.
        dur_raw = n.get('Duration', n.get('duration', 1.0))
        if dur_raw in ('', None):
            continue
        try:
            if float(dur_raw) <= 0:
                continue
        except (TypeError, ValueError):
            # Non-numeric Duration: keep voting (the activity still
            # has TimeUnits intent), conversion-side handles the bad
            # value.
            pass
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
    if makespan is None or makespan < 0 or not math.isfinite(makespan):
        logger.info(
            "calendar mapping skipped: makespan=%r is missing or non-finite",
            makespan)
        return None
    raw_start = getattr(project_ctx, 'start_date', None)
    start_ms = _parse_iso_to_ms(raw_start)
    if start_ms is None:
        # Only log when the caller actually tried to provide one --
        # absent start_date is the gating signal, not a config error.
        if raw_start is not None:
            logger.warning(
                "calendar mapping skipped: start_date=%r is not parseable as ISO",
                raw_start)
        return None

    cal_cfg = (project_ctx_dict or {}).get('calendar') or {}
    has_calendar_fields = any(k in cal_cfg for k in _CALENDAR_FIELDS)
    if not has_calendar_fields:
        return None

    # Defensive parsing of hours_per_day: a non-numeric value
    # ('"eight"') would raise inside ``float()`` and crash the solver
    # endpoint, and NaN/+-Inf would propagate through advance_working_ms
    # and WorkingCalendar.build's cumulative-hours array to produce
    # nonsense epoch ms.  Reject any of those by skipping the mapping
    # (returning None) -- consistent with the unparseable-start_date
    # path above.
    raw_hpd = getattr(project_ctx, 'hours_per_day', 8.0)
    try:
        hours_per_day = float(raw_hpd) if raw_hpd is not None else 8.0
    except (TypeError, ValueError):
        logger.warning(
            "calendar mapping skipped: hours_per_day=%r is not numeric",
            raw_hpd)
        return None
    if not math.isfinite(hours_per_day) or hours_per_day <= 0:
        logger.warning(
            "calendar mapping skipped: hours_per_day=%r is non-finite or "
            "non-positive", raw_hpd)
        return None

    working_days = getattr(project_ctx, 'working_days', None) or [1, 2, 3, 4, 5]
    holidays = getattr(project_ctx, 'holidays', None) or []

    # Match completion.calendar.WorkingCalendar.build's filtering: clamp
    # to ISO weekdays 1..7 and deduplicate so ``[1,1,2,8]`` doesn't
    # over-count.  Also use the same canonical list in the response so
    # ``calendar_working_days`` reflects what the calendar actually
    # used, not the raw caller input.
    canonical_wd = sorted({int(d) for d in working_days
                           if isinstance(d, (int, float))
                           and 1 <= int(d) <= 7}) or [1, 2, 3, 4, 5]
    wd_count = len(canonical_wd)
    units, mixed_units = _dominant_time_units(nodes)
    makespan_hours = convert_to_hours(
        float(makespan), units, hours_per_day, wd_count)
    # convert_to_hours can yield +Inf on extreme inputs (e.g. very large
    # Duration values combined with Year units).  Building a
    # WorkingCalendar long enough to advance Inf hours would either OOM
    # or wrap around, and advance_working_ms would return nonsense.
    # Guard explicitly.
    if not (math.isfinite(makespan_hours) and makespan_hours >= 0):
        logger.warning(
            "calendar mapping skipped: post-conversion makespan_hours=%r "
            "is non-finite (Duration=%r, units=%r)",
            makespan_hours, makespan, units)
        return None

    horizon_days = estimate_horizon_days(
        max(makespan_hours, 1.0), hours_per_day,
        # Solver doesn't carry stochastic Pareto caps to this layer, so
        # use a moderate 2x safety factor (covers MC P80 inflation in
        # realistic ranges).  Fat-tailed sectors using
        # /completion/monte-carlo derive their own larger horizon.
        # Scale by 7 / wd_count so non-5-day calendars
        # (e.g. working_days=[1,3,5] = 3 wd/wk, or [1] = 1 wd/wk) get
        # enough calendar days to fit the working-hour budget.
        # Without this scaling, advance_working_ms would clip past
        # the precomputed horizon and return an incorrect end date.
        safety_factor=2.0 * (7.0 / max(wd_count, 1)),
    )

    cal = WorkingCalendar.build(
        hours_per_day=hours_per_day,
        working_days=canonical_wd,
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
        'calendar_working_days':  list(canonical_wd),
        'holidays_count':         len(holidays or []),
        'makespan_working_hours': float(makespan_hours),
        'time_units':             units,
        # Always present so consumers can read the flag without a
        # ``in`` check; True when the schedule mixed TimeUnits across
        # activities (case-insensitive, after coalescing missing /
        # empty values to the default 'Hours').
        'mixed_time_units':       mixed_units,
    }
