"""
evm/helpers.py - Shared helpers for the EVM service.

Ports the exact semantics of EVM.js (safeDate / normalizePercentComplete
/ convertToHours) and PathScripts.js (differenceInCalendarDays).  Unit
tests lock these to the JS behaviour; do not "improve" them without
verifying the downstream metrics stay identical.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional
import math


# ---------------------------------------------------------------------------
# Bounds (matches EVM.js evmConfig.bounds, lines 698-711)
# ---------------------------------------------------------------------------

class Bounds:
    MIN_CPI = 0.05
    MAX_CPI = 20.0
    MIN_SPI = 0.05
    MAX_SPI = 10.0
    MIN_EAC_FACTOR = 0.8
    MAX_EAC_FACTOR = 3.0
    MAX_DELAY_DAYS = 365
    MIN_PERF_DELTA = 0.5
    MAX_PERF_DELTA = 2.0


def clamp(v: float, lo: float, hi: float) -> float:
    """Match JS clampNum(v, lo, hi)."""
    if not math.isfinite(v):
        return lo
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# Date parsing (matches EVM.js safeDate)
# ---------------------------------------------------------------------------

_MS_PER_DAY = 86_400_000.0


def safe_date(value) -> Optional[datetime]:
    """Parse a date-like input to a UTC datetime.  Returns None on failure.

    Accepts: datetime, ISO-8601 strings, 'YYYY-MM-DD', epoch numbers.
    Matches the JS safeDate behaviour: anything unparseable returns None
    (JS returns null).
    """
    if value is None or value == '':
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        # Assume epoch milliseconds if large, else seconds
        if abs(value) > 1e11:
            return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc)
        return datetime.fromtimestamp(value, tz=timezone.utc)
    try:
        s = str(value).strip()
        if not s:
            return None
        s = s.replace('Z', '+00:00')
        if 'T' not in s and len(s) == 10:
            s = s + 'T00:00:00+00:00'
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError):
        return None


def date_to_iso_date(dt: Optional[datetime]) -> Optional[str]:
    """Format as 'YYYY-MM-DD' -- matches EVM.js formatDateLocal output."""
    if dt is None:
        return None
    return dt.strftime('%Y-%m-%d')


def date_to_iso(dt: Optional[datetime]) -> Optional[str]:
    """Full ISO-8601 with timezone."""
    if dt is None:
        return None
    return dt.isoformat()


def difference_in_calendar_days(a, b) -> float:
    """Calendar days between two dates (a - b).  Matches date-fns /
    PathScripts.js differenceInCalendarDays: floors each date to UTC
    midnight before subtracting, so DST and time-of-day don't shift the
    result.
    """
    ad = safe_date(a)
    bd = safe_date(b)
    if ad is None or bd is None:
        return 0.0
    a_mid = ad.replace(hour=0, minute=0, second=0, microsecond=0)
    b_mid = bd.replace(hour=0, minute=0, second=0, microsecond=0)
    return (a_mid - b_mid).total_seconds() / 86400.0


# ---------------------------------------------------------------------------
# Duration conversion (matches PathScripts.js convertToHours, lines 115-215)
# ---------------------------------------------------------------------------

_WEEKS_PER_MONTH = 4.345
_WEEKS_PER_YEAR = 52.14


def convert_to_hours(duration, time_units, hours_per_day: float = 8.0,
                    working_days_per_week: float = 5.0,
                    max_hours: float = 100_000.0) -> float:
    """Ported convertToHours.  Same unit aliases, same month/year averages.

    `m` is interpreted as **minutes** (JS comment line 158-159) unless
    the string clearly starts with 'mo'/'mon'/'month'.
    """
    try:
        d = float(duration)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(d) or d <= 0:
        return 0.0

    u_raw = str(time_units if time_units is not None else 'Hours').strip().lower()
    if not u_raw:
        return min(d, max_hours)

    # Fast-path exact matches
    if u_raw in ('h', 'hr', 'hrs', 'hour', 'hours'):
        return d
    if u_raw in ('s', 'sec', 'secs', 'second', 'seconds'):
        return d / 3600.0
    if u_raw in ('min', 'mins', 'minute', 'minutes', 'm'):
        return d / 60.0
    if u_raw in ('d', 'day', 'days'):
        return d * hours_per_day
    if u_raw in ('w', 'wk', 'wks', 'week', 'weeks'):
        return d * working_days_per_week * hours_per_day
    if u_raw in ('mo', 'mon', 'mons', 'month', 'months'):
        return d * _WEEKS_PER_MONTH * working_days_per_week * hours_per_day
    if u_raw in ('y', 'yr', 'yrs', 'year', 'years'):
        return d * _WEEKS_PER_YEAR * working_days_per_week * hours_per_day

    # Prefix fallbacks (matches JS default branch, lines 194-214)
    c0 = u_raw[0]
    if c0 == 'h':
        return d
    if c0 == 'd':
        return d * hours_per_day
    if c0 == 'w':
        return d * working_days_per_week * hours_per_day
    if c0 == 'y':
        return d * _WEEKS_PER_YEAR * working_days_per_week * hours_per_day
    if c0 == 'm':
        if (u_raw.startswith('mo') or u_raw.startswith('mon')
                or u_raw.startswith('month')):
            return d * _WEEKS_PER_MONTH * working_days_per_week * hours_per_day
        return d / 60.0
    # Unknown -> treat as hours
    return d


# ---------------------------------------------------------------------------
# Percent complete (matches EVM.js normalizePercentComplete, lines 152-168)
# ---------------------------------------------------------------------------

def normalize_percent_complete(raw) -> float:
    """Always 0..1.  Input is expected on the 0..100 scale (P6/MSP
    convention), matches the v5 fix comment in EVM.js line 165.
    """
    if raw is None or raw == '':
        return 0.0
    value = raw
    if isinstance(value, str):
        value = value.strip().replace('%', '')
        if value.startswith('.'):
            value = '0' + value
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v) or v < 0:
        return 0.0
    return min(1.0, max(0.0, v / 100.0))


# ---------------------------------------------------------------------------
# Sector schedule overrun table
# (EVM.js lines 731-770 verbatim; do not reorder, longest-first partial
# match matters for "oil and gas development" -> "oil and gas")
# ---------------------------------------------------------------------------

SECTOR_SCHEDULE_OVERRUN = {
    # High-complexity sectors
    'nuclear':        0.65,
    'nuclear energy': 0.65,
    'oil and gas':    0.64,
    'oil & gas':      0.64,
    'oilgas':         0.64,
    'o&g':            0.64,
    'lng':            0.58,
    'petrochemical':  0.55,
    # Infrastructure
    'infrastructure': 0.37,
    'epc':            0.37,
    'civil':          0.35,
    'transportation': 0.40,
    'rail':           0.45,
    'mining':         0.42,
    # Construction
    'construction':   0.25,
    'commercial':     0.20,
    'buildings':      0.20,
    'residential':    0.15,
    'industrial':     0.30,
    # Defense & government
    'defense':        0.50,
    'government':     0.45,
    'federal':        0.45,
    'military':       0.50,
    # Technology
    'technology':     0.25,
    'software':       0.30,
    'it':             0.28,
    # Default
    'default':        0.25,
}


def get_sector_schedule_overrun(project: Optional[dict]) -> float:
    """Ported getSectorScheduleOverrun (EVM.js lines 777-811)."""
    if not isinstance(project, dict):
        project = {}
    sector_tag = (project.get('sector') or project.get('projectType')
                  or project.get('category') or project.get('industry')
                  or '')
    normalized = str(sector_tag).lower().strip()

    # Exact match
    if normalized in SECTOR_SCHEDULE_OVERRUN:
        return SECTOR_SCHEDULE_OVERRUN[normalized]

    # Partial match -- iterate insertion order (Python 3.7+ preserves dict order
    # which matches the JS object insertion order).
    if normalized:
        for key, value in SECTOR_SCHEDULE_OVERRUN.items():
            if key == 'default':
                continue
            if normalized in key or key in normalized:
                return value

    # Explicit scheduleOverrun fallback
    override = project.get('scheduleOverrun')
    if override is not None:
        try:
            v = float(override)
            if v > 0:
                return v
        except (TypeError, ValueError):
            pass

    return SECTOR_SCHEDULE_OVERRUN['default']
