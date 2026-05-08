"""
completion/calendar.py - Vectorised working-hour calendar.

Replaces the frontend addWorkingHours() helper (Completionprediction.js
line 381) with a NumPy-vectorised equivalent.  Advancing a start time
by W working hours skips weekends and holidays and clamps partial days
to the configured working-hours-per-day window.

Algorithm:
    1. Precompute two arrays over the project horizon [day 0 .. day K-1]:
         day_epoch_ms[k]      : epoch ms of UTC 00:00 on day k
         work_hours_before[k] : cumulative working hours accrued before
                                the start of day k (monotone nondecreasing)
    2. Advancing (start_ms, work_hours) becomes:
         target = work_hours_before[k_start] + intraday_hours + work_hours
         k_end  = searchsorted(work_hours_before, target, side='right') - 1
         frac   = (target - work_hours_before[k_end]) * ms_per_hour
         finish = day_epoch_ms[k_end] + frac
    3. This is O(log K) per advance, vectorises trivially over M samples.

Weekday convention: ISO (Mon=1..Sun=7), matching solver.models.ProjectContext.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np

logger = logging.getLogger(__name__)


_MS_PER_HOUR = 3_600_000.0
_MS_PER_DAY = 86_400_000.0

# Mirror CONFIG.maxWorkingHoursToAdd from Reference/Completionprediction.js
# line 131.  JS clamps work_hours to this before doing arithmetic to
# bound finish dates and avoid Chart.js overflow; matching it keeps
# JS-Py parity at the extreme end of the input range.
_MAX_WORKING_HOURS_TO_ADD = 100_000.0

# Rate-limit the horizon-clip warnings so a single MC run with thousands
# of out-of-horizon advances doesn't spam the log.  One warning per
# process is plenty; the caller is usually the same bug each time.
_HORIZON_WARNING_EMITTED = {'start': False, 'target': False}


def _parse_holiday(value):
    """Accept 'YYYY-MM-DD' strings or objects with a .date field.

    Returns UTC midnight epoch ms of the holiday day, or None on failure.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        value = value.get('date') or value.get('Date')
        if value is None:
            return None
    try:
        s = str(value).replace('Z', '+00:00')
        # Accept bare YYYY-MM-DD too
        if 'T' not in s and len(s) == 10:
            s = s + 'T00:00:00+00:00'
        dt = datetime.fromisoformat(s)
        # astimezone(timezone.utc) raises on naive datetimes and would
        # silently drop the holiday; treat naive input as UTC to match
        # the repo-wide "naive => UTC" convention (see evm.helpers.safe_date).
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        midnight = dt.replace(hour=0, minute=0, second=0, microsecond=0)
        return midnight.timestamp() * 1000.0
    except Exception:
        return None


def _utc_midnight_ms(epoch_ms):
    """Floor an epoch-ms timestamp to the start of its UTC day."""
    return (int(epoch_ms) // int(_MS_PER_DAY)) * _MS_PER_DAY


@dataclass
class WorkingCalendar:
    """Precomputed working-hour calendar.

    Construct via ``WorkingCalendar.build(...)``; the initialiser fields
    hold already-computed NumPy arrays.
    """
    hours_per_day: float
    working_days: frozenset           # ISO weekdays: {1..7}
    epoch_start_ms: float             # UTC midnight of day 0
    day_epoch_ms: np.ndarray          # (K,)  start-of-day ms
    is_working: np.ndarray            # (K,)  bool
    work_hours_before: np.ndarray     # (K+1,) cumulative working hours
    # Working-day count cumulative (matches JS _addWorkdaysO1: advance by N
    # *working days*, preserving the input's wall-clock time-of-day).
    working_days_before: np.ndarray   # (K+1,) cumulative working-day count
    # Vectorised next-working-day lookup (skips weekends AND holidays).
    # Mirrors JS _addWorkdaysO1's holiday-aware start normalization.
    next_working_idx: np.ndarray      # (K,)  idx of self if working else next
    # Vectorised next-weekday lookup (skips weekends ONLY, ignoring
    # holidays).  Mirrors JS _normalizeWeekendForward in the wholeDays<=0
    # branch of _addWorkdaysO1.
    next_weekday_idx: np.ndarray      # (K,)  idx of self if weekday else next

    @classmethod
    def build(cls, hours_per_day, working_days, holidays,
              start_ms, horizon_days):
        """
        Build a calendar covering [start_ms, start_ms + horizon_days).

        start_ms is floored to its UTC midnight so day boundaries align.
        """
        if hours_per_day is None or hours_per_day <= 0:
            hours_per_day = 8.0
        if not working_days:
            working_days = frozenset({1, 2, 3, 4, 5})
        else:
            # Clamp to ISO range, drop duplicates
            working_days = frozenset(
                int(d) for d in working_days
                if isinstance(d, (int, float)) and 1 <= int(d) <= 7
            )
            if not working_days:
                working_days = frozenset({1, 2, 3, 4, 5})

        K = max(int(horizon_days), 1)
        epoch0 = float(_utc_midnight_ms(start_ms))
        day_epoch = epoch0 + np.arange(K, dtype=np.float64) * _MS_PER_DAY

        # ISO weekday for each day
        # Python: datetime(epoch0).isoweekday() -> Mon=1..Sun=7
        base_dt = datetime.fromtimestamp(epoch0 / 1000.0, tz=timezone.utc)
        base_iso = base_dt.isoweekday()
        iso = ((np.arange(K) + (base_iso - 1)) % 7) + 1  # (K,) in {1..7}

        is_working = np.isin(iso, np.fromiter(working_days, dtype=np.int64))

        # Subtract holidays (UTC midnights)
        if holidays:
            holiday_ms = set()
            for h in holidays:
                hms = _parse_holiday(h)
                if hms is not None:
                    holiday_ms.add(hms)
            if holiday_ms:
                h_arr = np.fromiter(sorted(holiday_ms), dtype=np.float64)
                idx = np.searchsorted(day_epoch, h_arr)
                in_range = (idx >= 0) & (idx < K) & (day_epoch[np.clip(idx, 0, K - 1)] == h_arr)
                if np.any(in_range):
                    is_working[idx[in_range]] = False

        # Cumulative working hours: work_hours_before[k] is sum over days 0..k-1
        per_day = np.where(is_working, hours_per_day, 0.0)
        work_hours_before = np.empty(K + 1, dtype=np.float64)
        work_hours_before[0] = 0.0
        np.cumsum(per_day, out=work_hours_before[1:])

        # Cumulative working-DAY count: working_days_before[k] is the number
        # of working days in [0..k-1].  Used by advance_working_ms to land
        # on the (N+1)-th working day from the start_norm_idx.
        working_days_before = np.empty(K + 1, dtype=np.int64)
        working_days_before[0] = 0
        np.cumsum(is_working.astype(np.int64), out=working_days_before[1:])

        # Vectorised next-working-day lookup (skips weekends + holidays).
        # For each day k, next_working_idx[k] is the smallest j >= k with
        # is_working[j] == True.  Where no forward match exists (k past
        # the last working day in the horizon) we point at K-1 -- the
        # horizon edge -- NOT at the last working day.  This matters
        # because the post-remainder normalization in advance_working_ms
        # adds (day_epoch[next_working_idx] - day_epoch[final_day_idx]);
        # if we pointed to a previous working day, that shift would be
        # NEGATIVE and the finish time would move backward.  Routing
        # through K-1 makes the shift a no-op at the horizon edge -- the
        # finish stays where it landed and the horizon-overflow warning
        # carries the rest of the diagnostic.
        wp = np.flatnonzero(is_working)
        if wp.size == 0:
            next_working_idx = np.full(K, K - 1, dtype=np.int64)
        else:
            raw_pos = np.searchsorted(wp, np.arange(K), side='left')
            no_forward_match = raw_pos >= wp.size
            pos = np.clip(raw_pos, 0, wp.size - 1)
            next_working_idx = np.where(no_forward_match,
                                        K - 1, wp[pos]).astype(np.int64)

        # Vectorised next-weekday lookup (skips weekends only -- ignores
        # holidays).  Mirrors JS _normalizeWeekendForward as called in
        # _addWorkdaysO1's wholeDays<=0 branch, which normalizes
        # weekends only.  Same no-forward-match guard as
        # next_working_idx -- see comment above.
        is_weekday = np.isin(iso, np.fromiter(working_days, dtype=np.int64))
        wd = np.flatnonzero(is_weekday)
        if wd.size == 0:
            next_weekday_idx = np.full(K, K - 1, dtype=np.int64)
        else:
            raw_pos = np.searchsorted(wd, np.arange(K), side='left')
            no_forward_match = raw_pos >= wd.size
            pos = np.clip(raw_pos, 0, wd.size - 1)
            next_weekday_idx = np.where(no_forward_match,
                                        K - 1, wd[pos]).astype(np.int64)

        return cls(
            hours_per_day=float(hours_per_day),
            working_days=working_days,
            epoch_start_ms=epoch0,
            day_epoch_ms=day_epoch,
            is_working=is_working,
            work_hours_before=work_hours_before,
            working_days_before=working_days_before,
            next_working_idx=next_working_idx,
            next_weekday_idx=next_weekday_idx,
        )

    @property
    def K(self):
        return len(self.day_epoch_ms)

    @property
    def end_ms(self):
        return self.epoch_start_ms + self.K * _MS_PER_DAY


# ---------------------------------------------------------------------------
# Vectorised advance
# ---------------------------------------------------------------------------

def advance_working_ms(start_ms, work_hours, cal):
    """
    Advance start_ms by work_hours using the working calendar.

    Args:
        start_ms:    scalar float or (M,) array of epoch ms
        work_hours:  scalar float or (M,) array of working hours to add
        cal:         WorkingCalendar

    Returns:
        finish_ms: same shape as inputs, epoch ms.

    Algorithm (JS-parity with
    Reference/Completionprediction.js::addWorkingHours):

        1. Decompose work_hours into wholeDays + remainder via
           ``floor(h / hpd)``.
        2. Advance the day index by ``wholeDays`` *working days*, while
           preserving the input's wall-clock time-of-day (the JS code
           does this naturally because ``Date.setDate`` only changes the
           date component).
              - When wholeDays > 0, start is normalized to the next
                day that is BOTH a weekday AND not a holiday (matches
                JS ``_addWorkdaysO1``'s holiday-aware loop).
              - When wholeDays == 0, start is normalized to the next
                weekday only -- holidays are not skipped at this stage
                (matches JS ``_addWorkdaysO1(d, 0)`` calling
                ``_normalizeWeekendForward``).
        3. Add the remainder as raw wall-clock hours.
        4. If the result lands on a weekend or holiday, shift forward
           to the next working day, preserving time-of-day (mirrors the
           JS post-remainder ``_normalizeWeekendForward`` + holiday
           bump loop).

    Currently the JS reference's ``_normalizeWeekendForward`` hardcodes
    Sat/Sun via ``getDay()``; if the calendar uses a non-Mon-Fri
    working-week (e.g. Sun-Thu), the Python side will produce its own
    self-consistent result but there is no JS counterpart to diff
    against.  The JS↔Py harness in ``tests/test_calendar_diff.py``
    therefore only exercises Mon-Fri fixtures.

    Semantics:
        - If work_hours == 0, finish_ms = start_ms (pass-through), even
          if start is on a weekend.  Matches JS addWorkingHours's early
          ``if (h <= 0) return new Date(date);`` short-circuit.
        - If work_hours > _MAX_WORKING_HOURS_TO_ADD (100K), the input
          is clamped to that ceiling, matching JS CONFIG.
          maxWorkingHoursToAdd.  Without this clamp, runaway values
          diverge from JS by decades.
        - If the horizon is exhausted, the result is clipped to the
          last day of the calendar and a warning is logged (once per
          process per clip type, to avoid flooding during vectorised
          Monte Carlo batches).  When the horizon itself ends on a
          non-working day, the post-remainder normalization is a no-op
          at the edge (rather than a backward shift); the finish
          preserves the unshifted landing.  Rely on horizon sizing
          (``estimate_horizon_days``), not normalization, to avoid
          this case.

    JS parity is verified by ``tests/test_calendar_diff.py``, which
    runs the JS implementation under Node.js on shared fixtures and
    asserts < 1ms equivalence.
    """
    start_arr = np.asarray(start_ms, dtype=np.float64)
    work_arr = np.asarray(work_hours, dtype=np.float64)

    scalar_in = (start_arr.ndim == 0 and work_arr.ndim == 0)
    if scalar_in:
        start_arr = start_arr.reshape(1)
        work_arr = work_arr.reshape(1)

    start_arr, work_arr = np.broadcast_arrays(start_arr, work_arr)

    # Zero-work passthrough: match JS short-circuit exactly.
    zero_work = work_arr <= 0.0

    # Upper-clamp to match JS line 400 (h > maxWorkingHoursToAdd).
    # Without this, a runaway work_hours value diverges from JS by
    # decades for inputs above 100K hours.
    work_arr = np.minimum(work_arr, _MAX_WORKING_HOURS_TO_ADD)

    # Clip start into calendar range; rate-limited warning when any
    # start falls outside the horizon (indicates stale calendar or
    # activities with dates past the planning window).
    out_of_range = ((start_arr < cal.epoch_start_ms)
                    | (start_arr >= cal.end_ms))
    if (np.any(out_of_range)
            and not _HORIZON_WARNING_EMITTED['start']):
        n_oor = int(np.count_nonzero(out_of_range))
        logger.warning(
            "advance_working_ms: %d start_ms values clipped into "
            "calendar [%s .. %s); consider extending the horizon. "
            "Suppressing further warnings.",
            n_oor,
            datetime.fromtimestamp(cal.epoch_start_ms / 1000.0,
                                   tz=timezone.utc).isoformat(),
            datetime.fromtimestamp(cal.end_ms / 1000.0,
                                   tz=timezone.utc).isoformat())
        _HORIZON_WARNING_EMITTED['start'] = True
    start_clipped = np.clip(start_arr,
                            cal.epoch_start_ms,
                            cal.end_ms - 1.0)

    day_idx = np.floor(
        (start_clipped - cal.epoch_start_ms) / _MS_PER_DAY
    ).astype(np.int64)
    day_idx = np.clip(day_idx, 0, cal.K - 1)

    # Preserve raw intraday wall-clock offset.  JS keeps date.getTime()
    # mod _MS_PER_DAY untouched across both the day-advance step and
    # the remainder-add step.
    intraday_ms = start_clipped - cal.day_epoch_ms[day_idx]

    hpd = cal.hours_per_day
    whole_days = np.floor(work_arr / hpd).astype(np.int64)
    rem_hours = work_arr - whole_days.astype(np.float64) * hpd

    # Start normalization differs by branch (mirrors JS _addWorkdaysO1):
    #   wholeDays == 0: JS calls _normalizeWeekendForward only.
    #   wholeDays  > 0 with holidays: JS loops until _isWorkingDay.
    #   wholeDays  > 0 no holidays: JS calls _normalizeWeekendForward.
    # Our `next_working_idx` includes holidays in `is_working`, so when
    # there are NO holidays it equals `next_weekday_idx` and the fast-
    # path / slow-path JS split collapses cleanly.
    only_remainder = whole_days == 0
    start_norm_idx = np.where(only_remainder,
                              cal.next_weekday_idx[day_idx],
                              cal.next_working_idx[day_idx])

    # Target working-day count: working_days_before[start_norm_idx] + N.
    target_wd = cal.working_days_before[start_norm_idx] + whole_days
    max_wd = int(cal.working_days_before[-1])
    if (np.any(target_wd > max_wd)
            and not _HORIZON_WARNING_EMITTED['target']):
        n_oor = int(np.count_nonzero(target_wd > max_wd))
        logger.warning(
            "advance_working_ms: %d advances exceed calendar horizon "
            "(max %d working days); finish clipped to last day. "
            "Suppressing further warnings.", n_oor, max_wd)
        _HORIZON_WARNING_EMITTED['target'] = True
    target_wd = np.clip(target_wd, 0, max_wd)

    # side='right' - 1 gives the smallest index k where
    # working_days_before[k] == target_wd, landing at the START of the
    # (N+1)-th working day from start_norm_idx.
    end_idx_search = np.searchsorted(
        cal.working_days_before, target_wd, side='right') - 1
    end_idx_search = np.clip(end_idx_search, 0, cal.K - 1)
    # When only_remainder (whole_days == 0), end_idx must equal
    # start_norm_idx, NOT the searchsorted result -- if start_norm_idx
    # is a holiday-weekday, working_days_before plateaus there and
    # side='right' jumps past, double-counting the day advance once
    # the intraday + rem crosses midnight.  Holidays at this stage are
    # left for the post-remainder next_working_idx step to bump,
    # matching JS _addWorkdaysO1(d, 0).
    end_idx = np.where(only_remainder, start_norm_idx, end_idx_search)

    finish_ms = (cal.day_epoch_ms[end_idx]
                 + intraday_ms
                 + rem_hours * _MS_PER_HOUR)

    # Post-remainder forward-normalization (JS lines 410-420):
    # if the wall-clock remainder pushed us onto a weekend or holiday,
    # shift to the next working day, preserving time-of-day.  next_
    # working_idx already encodes weekend+holiday skipping.
    final_day_idx = np.floor(
        (finish_ms - cal.epoch_start_ms) / _MS_PER_DAY
    ).astype(np.int64)
    final_day_idx = np.clip(final_day_idx, 0, cal.K - 1)
    final_norm_idx = cal.next_working_idx[final_day_idx]
    finish_ms = finish_ms + (cal.day_epoch_ms[final_norm_idx]
                             - cal.day_epoch_ms[final_day_idx])

    # Preserve zero-work passthrough exactly (including weekend starts,
    # matching JS line 399 short-circuit).
    finish_ms = np.where(zero_work, start_arr, finish_ms)

    if scalar_in:
        return float(finish_ms[0])
    return finish_ms


# ---------------------------------------------------------------------------
# Horizon sizing
# ---------------------------------------------------------------------------

def estimate_horizon_days(remaining_hours_total, hours_per_day,
                          safety_factor=None, min_days=30, max_days=3650,
                          max_multiplier_cap=None):
    """
    Days of calendar to precompute.

    Heuristic: deterministic_remaining_working_days * safety_factor.
    The safety factor is derived from the configured Pareto-tier cap
    (``max_multiplier_cap``) so thin-tailed sectors get a smaller
    horizon and fat-tailed classes (Olympics/IT with 50x caps, nuclear
    new build with 20x caps) get enough to avoid ``advance_working_ms``
    clipping.  Formula: max(6, ceil(cap * 1.5)) -- covers cap x blend=1
    plus 50% weekend/holiday padding.  Fallback is 6 (the historic
    default, sized for a 10x Pareto cap).

    Explicit ``safety_factor`` overrides the derivation; pass None
    (default) to let the cap drive it.

    Capped at 10 years to bound memory (3650 days = ~29 KB of arrays).
    """
    if hours_per_day <= 0 or remaining_hours_total <= 0:
        return min_days
    if safety_factor is None:
        if max_multiplier_cap is not None and max_multiplier_cap > 0:
            safety_factor = max(6.0, float(max_multiplier_cap) * 1.5)
        else:
            safety_factor = 6.0
    det_days = remaining_hours_total / hours_per_day
    return int(np.clip(np.ceil(det_days * safety_factor), min_days, max_days))
