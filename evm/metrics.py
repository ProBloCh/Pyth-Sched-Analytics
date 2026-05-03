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

import logging
import math

from datetime import timedelta
import numpy as np

from .helpers import (
    Bounds, clamp, safe_date, convert_to_hours,
    normalize_percent_complete, difference_in_calendar_days,
)

logger = logging.getLogger(__name__)

# Rate-limited warning flag for compute_acwp dirty-data paths.
# Process-level: once per process, logs the first unexpected shape so
# field diagnostics are possible without flooding logs on a 10K-node
# project with many malformed rows.
_ACWP_WARNED = {'emitted': False}


def _acwp_warn_once(node, exc):
    if _ACWP_WARNED['emitted']:
        return
    try:
        nid = str(node.get('ID', node.get('id', '<unknown>')))
    except Exception:
        nid = '<unreadable>'
    logger.warning(
        'compute_acwp: skipping node id=%s due to unexpected data shape '
        '(%s: %s); further warnings suppressed for this process.',
        nid, type(exc).__name__, exc)
    _ACWP_WARNED['emitted'] = True


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
# Earned Schedule (Lipke 2003)
# ---------------------------------------------------------------------------
#
# The standard SPI = EV / PV degenerates to 1.0 at project completion
# regardless of how late the project actually finished, because once all
# work is earned both EV and PV equal BAC.  Earned Schedule (Lipke,
# "Schedule Is Different", The Measurable News, 2003) fixes this by
# projecting EV horizontally onto the planned PV curve to find the
# **time** at which the work currently earned should have been completed.
#
#   ES   = the date on which planned PV first equals current EV
#   AT   = elapsed time since project start (the actual time)
#   SPI(t) = ES / AT   -- a time-based SPI; stays <1 if the project is
#                         late, even at completion
#   TEAC(t) = AT + (PD - ES) / SPI(t) = PD / SPI(t)   (when AT > 0)
#
# This is purely additive to the existing cost-based EVM metrics and
# does not change any existing field in the response.
#
# ---------------------------------------------------------------------------

# Cap the date grid for very large projects to keep ES O(N + D) bounded.
# 500 points across the project horizon is far finer than any chart can
# usefully display; PV is monotone so the linear-interp error between
# samples is small even with subsampling.  See evm/distributions.py
# (_significant_dates) for the same pattern.
_ES_MAX_DATES = 500


def _significant_evm_dates(nodes, must_include=None):
    """Sorted unique list of activity Start / Finish dates, capped.

    BCWS is piecewise-linear in time: each activity contributes a linear
    ramp from Start to Finish.  Sampling BCWS at every Start/Finish
    boundary captures every breakpoint, so linear interpolation between
    samples is exact for projects up to ``_ES_MAX_DATES`` activities.
    Larger projects subsample the grid uniformly, accepting a small
    interpolation error in exchange for bounded compute.

    ``must_include`` is an optional iterable of dates (e.g. the EVM
    status_date) that the caller needs preserved in the grid even if
    capping would otherwise drop them.  Including them here -- before
    the cap -- guarantees ``len(result) <= _ES_MAX_DATES`` while still
    letting AT readings line up with a sample.  Without this, a
    later insertion would push the count to ``_ES_MAX_DATES + 1``
    and break the broadcast-size ceiling in ``_vectorised_pv_curve``.
    """
    out = set()
    for n in nodes or []:
        s = safe_date(n.get('Start'))
        f = safe_date(n.get('Finish'))
        if s is not None:
            out.add(s.replace(hour=0, minute=0, second=0, microsecond=0))
        if f is not None:
            out.add(f.replace(hour=0, minute=0, second=0, microsecond=0))
    must = set()
    for d in (must_include or []):
        dt = safe_date(d)
        if dt is not None:
            must.add(dt.replace(hour=0, minute=0, second=0, microsecond=0))
    out |= must

    sorted_dates = sorted(out)
    if len(sorted_dates) > _ES_MAX_DATES:
        idx = np.linspace(0, len(sorted_dates) - 1,
                          _ES_MAX_DATES).astype(int)
        kept = {sorted_dates[i] for i in idx}
        # Project first/last must survive the swap below: ES uses them
        # to compute project_start, project_finish, and PD; dropping
        # either would corrupt all downstream calculations on large
        # capped projects.  ``linspace(0, N-1, K)`` always includes
        # index 0 and N-1 so they're in ``kept`` initially -- we just
        # have to refuse to drop them in the swap.
        protected = set(must)
        if sorted_dates:
            protected.add(sorted_dates[0])
            protected.add(sorted_dates[-1])
        # Guarantee the must-include dates survive the subsample by
        # swapping them in for an arbitrary kept neighbour (chosen
        # deterministically from the sorted interior to keep behaviour
        # reproducible across runs).
        for m in must:
            if m in kept:
                continue
            droppable = next(
                (k for k in sorted(kept) if k not in protected), None)
            if droppable is not None:
                kept.discard(droppable)
                kept.add(m)
                # Once swapped in, ``m`` itself becomes protected so
                # it isn't picked as a droppable on a later iteration.
                protected.add(m)
        sorted_dates = sorted(kept)
    return sorted_dates


def _vectorised_pv_curve(nodes, dates, hours_per_day, working_days_per_week):
    """Cumulative planned hours at each ``date`` -- one vectorised pass.

    Each activity contributes a linearly-ramped slab between its Start
    and Finish dates: ``planned_hrs * clip((d - start) / (finish - start),
    0, 1)``.  Degenerate spans (``finish <= start``, including
    milestones with ``finish == start``) are handled as a step
    function -- the scalar reference ``compute_bcws_hours`` gives full
    credit when ``sd_time >= f``, and the vectorised path matches by
    using ``(d >= f).astype(float)`` for those activities.

    We stack activity arrays once, broadcast against the (D,) date
    grid, and reduce along the activity axis -- replacing the O(N*D)
    Python loop the scalar version did when called per date.  Memory
    is **O(N*D)** during the broadcast (D is capped to 500 by
    ``_significant_evm_dates``, keeping the array bounded in
    practice), with output O(D).

    Returns an (D,) numpy array of cumulative hours, aligned with the
    input ``dates`` list.
    """
    starts_ms = []
    finishes_ms = []
    planned_hrs = []
    for n in nodes or []:
        dur_raw = n.get('Duration', n.get('duration', 0))
        if dur_raw in (0, '0'):
            continue
        s = safe_date(n.get('Start'))
        f = safe_date(n.get('Finish'))
        h = convert_to_hours(
            dur_raw, n.get('TimeUnits', 'Hours'),
            hours_per_day, working_days_per_week)
        if s is None or f is None or h <= 0:
            continue
        starts_ms.append(s.timestamp() * 1000.0)
        finishes_ms.append(f.timestamp() * 1000.0)
        planned_hrs.append(h)

    D = len(dates)
    if not planned_hrs or D == 0:
        return np.zeros(D, dtype=np.float64)

    s_arr = np.asarray(starts_ms, dtype=np.float64)         # (N,)
    f_arr = np.asarray(finishes_ms, dtype=np.float64)       # (N,)
    p_arr = np.asarray(planned_hrs, dtype=np.float64)       # (N,)
    d_arr = np.array(
        [d.timestamp() * 1000.0 for d in dates], dtype=np.float64)  # (D,)

    # Build the per-activity contribution matrix in a single (N, D)
    # buffer to keep peak memory at one such array (~80 MB at N=10K,
    # D=500).  An earlier draft built `linear`, `step`, and `frac` as
    # three independent (N, D) arrays plus the boolean intermediate,
    # tripling the peak.
    span = f_arr - s_arr
    span_safe = np.where(span > 0, span, 1.0)
    frac = (d_arr[None, :] - s_arr[:, None]) / span_safe[:, None]
    np.clip(frac, 0.0, 1.0, out=frac)

    # Step function for finish <= start (milestones and degenerate
    # f == s data): overwrite only those rows with the (d >= f) step
    # so the matching scalar `sd_time >= f` semantic is preserved.
    # Building the step submatrix only for the degenerate rows keeps
    # the extra allocation O(n_degenerate * D), typically tiny.
    deg_mask = span <= 0
    if np.any(deg_mask):
        deg_idx = np.where(deg_mask)[0]
        frac[deg_idx] = (
            d_arr[None, :] >= f_arr[deg_idx, None]
        ).astype(np.float64)

    pv = (frac * p_arr[:, None]).sum(axis=0)
    return pv


def compute_earned_schedule(nodes, status_date, hours_per_day: float = 8.0,
                            working_days_per_week: float = 5.0) -> dict:
    """Lipke (2003) Earned Schedule, SPI(t), and time-based EAC.

    Returns a dict with:
        earnedScheduleDays   : ES in calendar days from project start
        actualTimeDays       : AT (status_date - project_start) in days
        plannedDurationDays  : PD (project_finish - project_start) in days
        SPI_t                : raw  ES / AT  (Inf when AT == 0 and ES > 0)
        SPI_t_model          : clamped to evm Bounds.MIN_SPI..MAX_SPI
        earnedScheduleDate   : ISO date when current EV was planned
        TEAC_days            : PD / SPI(t), clamped >= AT  (Lipke
                               Independent Estimate at Completion (time))
        TEAC_date            : project_start + TEAC_days, ISO
        flags                : diagnostics (no_baseline / completed /
                               not_started / status_before_start)

    Uses calendar days throughout to match the project's planned-date
    arithmetic in difference_in_calendar_days.  EV/PV are accumulated
    in the same hour-units that compute_bcwp_hours / compute_bcws_hours
    use, so the curves are dimensionally consistent for interpolation.
    """
    sd = safe_date(status_date)

    flags = {}
    # Preliminary scan for project start/finish to feed must_include.
    # _significant_evm_dates is cheap (single pass over nodes) but we
    # only need its first/last elements at this point.
    bare = _significant_evm_dates(nodes)
    if not bare:
        flags['no_baseline'] = True
        return _empty_es(flags)
    project_start = bare[0]
    project_finish = bare[-1]
    pd_days = max(
        difference_in_calendar_days(project_finish, project_start), 0.0)

    if sd is None:
        sd = project_start
        flags['status_date_missing'] = True

    sd_mid = sd.replace(hour=0, minute=0, second=0, microsecond=0)

    # Build the date grid with status_date guaranteed in -- before
    # capping -- so len(significant) <= _ES_MAX_DATES holds even when
    # status_date isn't a natural breakpoint and would otherwise have
    # required a post-cap insertion.
    significant = _significant_evm_dates(nodes, must_include=[sd_mid])

    ev_hours = compute_bcwp_hours(
        nodes, hours_per_day, working_days_per_week)

    # Sample cumulative PV at every breakpoint via a single vectorised
    # numpy pass.  Builds one (N, D) frac matrix in place (clip +
    # scatter), so peak memory is bounded by a single (N*D*8) byte
    # array; D is capped to _ES_MAX_DATES = 500 by
    # _significant_evm_dates so for N=10K that's an 80 MB peak,
    # well within the per-request budget.  Replaces the previous
    # scalar loop that called compute_bcws_hours per date in pure
    # Python and hit a wall on 10K-activity projects.
    pv_arr = _vectorised_pv_curve(
        nodes, significant, hours_per_day, working_days_per_week)
    pv_curve = list(zip(significant, pv_arr.tolist()))
    pv_total = pv_curve[-1][1] if pv_curve else 0.0

    at_days = max(
        difference_in_calendar_days(sd_mid, project_start), 0.0)
    if at_days <= 0:
        flags['status_before_start'] = True

    # ES: smallest date at which cumulative PV >= EV.  Linear interp
    # between samples (PV is piecewise-linear so this is exact).
    es_days = 0.0
    es_date = project_start
    if ev_hours <= 0:
        flags['not_started'] = True
        es_days = 0.0
        es_date = project_start
    elif pv_total <= 0:
        flags['no_baseline'] = True
        es_days = 0.0
        es_date = project_start
    elif ev_hours >= pv_total:
        flags['completed'] = True
        es_days = pd_days
        es_date = project_finish
    else:
        for k in range(len(pv_curve) - 1):
            d0, pv0 = pv_curve[k]
            d1, pv1 = pv_curve[k + 1]
            if pv0 <= ev_hours <= pv1:
                span = pv1 - pv0
                if span > 0:
                    frac = (ev_hours - pv0) / span
                else:
                    frac = 0.0
                day_span = difference_in_calendar_days(d1, d0)
                es_days = (
                    difference_in_calendar_days(d0, project_start)
                    + frac * day_span)
                es_date = d0 + timedelta(days=frac * day_span)
                break

    # SPI(t): raw can be Inf if AT == 0 with ES > 0.  SPI_t_model is
    # the stabilised variant: ``clamp(SPI_t, MIN_SPI, MAX_SPI)`` when
    # finite, else 1.0 (neutral).  Mirrors the non-finite convention
    # already in use for SPI_model and CPIcum_model in
    # compute_evm_metrics -- not a strict clamp, since clamping Inf
    # to MAX_SPI would produce a TEAC of PD/MAX_SPI rather than the
    # neutral PD that consumers expect when no time has elapsed.
    if at_days > 0:
        spi_t = es_days / at_days
    elif es_days > 0:
        spi_t = math.inf
    else:
        spi_t = 1.0
    spi_t_model = (clamp(spi_t, Bounds.MIN_SPI, Bounds.MAX_SPI)
                   if math.isfinite(spi_t) else 1.0)

    # Time-based EAC: Lipke IEAC(t) = PD / SPI(t), where SPI(t) is the
    # **clamped** SPI_t_model -- not the raw SPI_t.  This stabilises
    # against extreme values (raw can be Inf when AT=0 with EV>0, or
    # near zero on tiny ES) the same way compute_eac uses CPIcum_model
    # and SPI_model.  Clamped >= AT because a project that's already
    # taken AT days cannot finish in fewer than AT days.
    if pd_days <= 0 or spi_t_model <= 0:
        teac_days = 0.0
    else:
        teac_days = max(at_days, pd_days / spi_t_model)
    teac_date = project_start + timedelta(days=teac_days)

    return {
        'earnedScheduleDays':  es_days,
        'actualTimeDays':      at_days,
        'plannedDurationDays': pd_days,
        'SPI_t':               spi_t,
        'SPI_t_model':         spi_t_model,
        'earnedScheduleDate':  es_date.strftime('%Y-%m-%d'),
        'TEAC_days':           teac_days,
        'TEAC_date':           teac_date.strftime('%Y-%m-%d'),
        'projectStartDate':    project_start.strftime('%Y-%m-%d'),
        'projectFinishDate':   project_finish.strftime('%Y-%m-%d'),
        'flags':               flags,
    }


def _empty_es(flags):
    return {
        'earnedScheduleDays':  0.0,
        'actualTimeDays':      0.0,
        'plannedDurationDays': 0.0,
        'SPI_t':               1.0,
        'SPI_t_model':         1.0,
        'earnedScheduleDate':  None,
        'TEAC_days':           0.0,
        'TEAC_date':           None,
        'projectStartDate':    None,
        'projectFinishDate':   None,
        'flags':               flags,
    }


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
        except Exception as exc:
            # Match the JS reference: log once per unexpected shape
            # (e.g. corrupt date string, non-numeric Duration) so field
            # diagnostics are possible; then skip the node.  Rate-
            # limited via module-level flag so a 10K-node project with
            # dirty data doesn't flood the logs.
            _acwp_warn_once(node, exc)
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
