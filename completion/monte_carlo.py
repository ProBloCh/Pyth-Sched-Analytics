"""
completion/monte_carlo.py - Remaining-work Monte Carlo simulation.

Extracts Completionprediction.js runMonteCarloRemaining() to the backend.
Operates on remaining work (respects PercentComplete and ExpectedStart),
anchored to a status date, and returns calendar-based finish-date
percentiles.

Reuses the validated five-tier risk distribution machinery from
solver/stochastic.py (Sobol QMC, triangular -> normal ->
Birnbaum-Saunders -> Pareto, Natarajan KS p=.89).  Unlike the JS
implementation, samples are Sobol-QMC rather than Murmur3/FNV-1a hash
uniforms -- same math, better space-filling at equal iteration count.

Vectorisation: multiplier sampling is a single tiled call into
_compute_raw_multipliers over the full (M*n) matrix.  The topological
walk then processes one activity at a time but broadcasts over all M
samples simultaneously, keeping the inner loop in C-level NumPy.
"""

from dataclasses import dataclass, field
import logging
import time

import numpy as np

from solver.dag import build_dag
from solver.stochastic import (
    _generate_samples,
    _compute_raw_multipliers,
    _fat_tail_thresholds,
)
from .calendar import (
    WorkingCalendar, advance_working_ms, estimate_horizon_days,
)

logger = logging.getLogger(__name__)

_MS_PER_HOUR = 3_600_000.0
_MS_PER_DAY = 86_400_000.0


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class CompletionMCConfig:
    iterations: int = 500
    seed: int = 42
    antithetic: bool = True
    # Risk gating thresholds (match JS CONFIG.mc* defaults)
    no_risk_below: float = 0.06
    normal_from: float = 0.18
    fat_tail_from: float = 0.55
    # Caps (duration-sensitive max multiplier, min floor)
    min_mult: float = 0.95
    max_mult_base: float = 2.0
    max_mult_high: float = 6.0
    enable_risk: bool = True

    @classmethod
    def from_dict(cls, d):
        if not d:
            return cls()
        th = d.get('thresholds', {}) or {}
        caps = d.get('caps', {}) or {}
        return cls(
            iterations=int(d.get('iterations', 500)),
            seed=int(d.get('seed', 42)),
            antithetic=bool(d.get('antithetic', True)),
            no_risk_below=float(th.get('no_risk_below', 0.06)),
            normal_from=float(th.get('normal_from', 0.18)),
            fat_tail_from=float(th.get('fat_tail_from', 0.55)),
            min_mult=float(caps.get('min_mult', 0.95)),
            max_mult_base=float(caps.get('max_mult_base', 2.0)),
            max_mult_high=float(caps.get('max_mult_high', 6.0)),
            enable_risk=bool(d.get('enable_risk', True)),
        )


# ---------------------------------------------------------------------------
# Date / duration helpers
# ---------------------------------------------------------------------------

def _parse_iso_to_ms(s):
    """ISO-8601 string -> epoch milliseconds.  Returns None on failure."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    try:
        from datetime import datetime
        # Accept trailing Z
        clean = str(s).replace('Z', '+00:00')
        dt = datetime.fromisoformat(clean)
        return dt.timestamp() * 1000.0
    except Exception:
        return None


def _ms_to_iso(ms):
    """Epoch milliseconds -> ISO-8601 UTC string."""
    if ms is None or not np.isfinite(ms):
        return None
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()


def _duration_to_ms(dur, time_units):
    """Convert (Duration, TimeUnits) to wall-clock milliseconds.

    Used on the no-calendar path -- durations in 'days' map to 24-hour
    calendar days.
    """
    try:
        d = float(dur)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(d) or d < 0:
        return 0.0
    unit = str(time_units or 'h').strip().lower()
    if unit in ('h', 'hr', 'hrs', 'hour', 'hours'):
        return d * _MS_PER_HOUR
    if unit in ('d', 'day', 'days'):
        return d * _MS_PER_DAY
    if unit in ('w', 'wk', 'week', 'weeks'):
        return d * _MS_PER_DAY * 7.0
    if unit in ('m', 'mo', 'month', 'months'):
        return d * _MS_PER_DAY * 30.0
    return d * _MS_PER_HOUR


def _duration_to_work_hours(dur, time_units, hours_per_day):
    """Convert (Duration, TimeUnits) to working hours.

    Used on the calendar path -- durations in 'days' map to working days
    (e.g., 8 hours under a standard 5x8 calendar).  Matches the frontend
    convertToHours() convention (PathScripts.js): weeks = hpd * 5,
    months = hpd * 21.
    """
    try:
        d = float(dur)
    except (TypeError, ValueError):
        return 0.0
    if not np.isfinite(d) or d < 0:
        return 0.0
    unit = str(time_units or 'h').strip().lower()
    if unit in ('h', 'hr', 'hrs', 'hour', 'hours'):
        return d
    if unit in ('d', 'day', 'days'):
        return d * hours_per_day
    if unit in ('w', 'wk', 'week', 'weeks'):
        return d * hours_per_day * 5.0
    if unit in ('m', 'mo', 'month', 'months'):
        return d * hours_per_day * 21.0
    return d  # unknown -> treat as hours


def _risk_01(node, metadata_entry):
    """Unified 0..1 risk score.

    Precedence (matches JS baseline-building in Completionprediction.js):
      1. node.riskScore  (frontend combined risk, 0..1)
      2. node.ComputedRiskScore (legacy, 0..1)
      3. metadata.combined_risk_score / 10  (solver convention, 0..10)
      4. 0.0
    """
    for key in ('riskScore', 'ComputedRiskScore'):
        v = node.get(key)
        if v is not None:
            try:
                fv = float(v)
                if np.isfinite(fv):
                    return float(np.clip(fv, 0.0, 1.0))
            except (TypeError, ValueError):
                pass
    if metadata_entry:
        v = metadata_entry.get('combined_risk_score')
        if v is not None:
            try:
                fv = float(v)
                if np.isfinite(fv):
                    # Solver uses 0..10; normalise if value > 1
                    return float(np.clip(fv / 10.0 if fv > 1.0 else fv, 0.0, 1.0))
            except (TypeError, ValueError):
                pass
    return 0.0


def _activity_type(node, metadata_entry):
    if metadata_entry:
        t = metadata_entry.get('activity_type') or metadata_entry.get('supply_chain_type')
        if t:
            return str(t).lower()
    for key in ('SupplierType', 'supplierType', 'TaskType', 'ActivityType'):
        v = node.get(key)
        if v:
            return str(v).lower()
    return 'standard'


# ---------------------------------------------------------------------------
# Scope & per-activity state
# ---------------------------------------------------------------------------

def _build_scope(nodes, dag_state, id_to_idx, status_ms, activity_metadata,
                 calendar):
    """
    Build per-activity arrays aligned to DAG indices.

    When *calendar* is None, ``remaining`` is in wall-clock milliseconds.
    When *calendar* is a WorkingCalendar, ``remaining`` is in working
    hours (to be advanced through the calendar by the propagation
    helpers).

    Returns:
        remaining      : (n,) float64  -- ms (no-calendar) or work-hrs (calendar)
        earliest_start : (n,) float64  -- ms, clamped to status_ms
        risk           : (n,) float64  -- 0..1
        activity_types : list[str]     -- lowercased
        in_scope       : (n,) bool     -- True iff activity has remaining work
        actual_finish  : (n,) float64  -- NaN unless ActualFinish given
    """
    n = dag_state.n
    remaining = np.zeros(n, dtype=np.float64)
    earliest_start = np.full(n, status_ms, dtype=np.float64)
    risk = np.zeros(n, dtype=np.float64)
    activity_types = ['standard'] * n
    in_scope = np.zeros(n, dtype=bool)
    actual_finish_ms = np.full(n, np.nan, dtype=np.float64)

    for node in nodes:
        nid = str(node.get('ID', node.get('id', '')))
        if nid not in id_to_idx:
            continue
        j = id_to_idx[nid]
        meta = (activity_metadata or {}).get(nid, {})

        af = _parse_iso_to_ms(node.get('ActualFinish'))
        if af is not None:
            actual_finish_ms[j] = af
            continue

        dur_val = node.get('Duration', node.get('duration', 0))
        dur_units = node.get('TimeUnits', node.get('timeUnits'))
        if calendar is None:
            total = _duration_to_ms(dur_val, dur_units)
        else:
            total = _duration_to_work_hours(dur_val, dur_units,
                                            calendar.hours_per_day)

        pct_raw = node.get('PercentComplete', node.get('percentComplete', 0))
        try:
            pct = float(pct_raw)
        except (TypeError, ValueError):
            pct = 0.0
        if pct > 1.0:
            pct /= 100.0
        pct = max(0.0, min(1.0, pct))

        rem = total * (1.0 - pct) if pct > 0 else total
        if rem <= 0:
            continue

        remaining[j] = rem
        in_scope[j] = True

        exp_start = _parse_iso_to_ms(node.get('ExpectedStart',
                                              node.get('expectedStart')))
        earliest_start[j] = max(status_ms,
                                exp_start if exp_start is not None else status_ms)

        risk[j] = _risk_01(node, meta)
        activity_types[j] = _activity_type(node, meta)

    return (remaining, earliest_start, risk, activity_types, in_scope,
            actual_finish_ms)


# ---------------------------------------------------------------------------
# Multiplier sampling & caps
# ---------------------------------------------------------------------------

def _duration_sensitive_cap(risk, dur_days, base, high):
    """JS durationSensitiveMaxMult -- more leeway for long/high-risk tasks.

    longness = clamp01((durDays - 30) / 180)  -- 0 at 30d, 1 at ~210d
    highness = clamp01((risk - 0.5) / 0.5)    -- 0 at 0.5, 1 at 1.0
    t        = clamp01(0.6*highness + 0.4*longness)
    cap      = lerp(base, high, t)
    """
    longness = np.clip((dur_days - 30.0) / 180.0, 0.0, 1.0)
    highness = np.clip((risk - 0.5) / 0.5, 0.0, 1.0)
    t = np.clip(0.6 * highness + 0.4 * longness, 0.0, 1.0)
    return base + (high - base) * t


def _sample_multipliers(risk, activity_types, remaining, calendar, config):
    """
    Generate an (M, n) matrix of capped duration multipliers via the
    five-tier model from solver/stochastic.py.

    ``remaining`` is either wall-clock ms (no calendar) or working hours
    (calendar); *calendar* disambiguates when computing the per-activity
    duration in days for the cap heuristic.
    """
    n = len(risk)
    if not config.enable_risk or n == 0:
        return np.ones((config.iterations, n), dtype=np.float64), config.iterations

    u_all, M = _generate_samples(config.iterations, n, config.antithetic,
                                 seed=config.seed)
    from scipy.special import ndtri
    z_all = ndtri(u_all)

    # Honour config.thresholds.fat_tail_from by passing it as the
    # supply-type default (supply-chain activities still use their
    # tighter 0.35 / 0.40 / 0.45 thresholds).
    fat_thresh = _fat_tail_thresholds(
        activity_types, n, default_fat_tail=config.fat_tail_from)

    risk_tile = np.tile(risk, M)
    fat_tile = np.tile(fat_thresh, M)
    mult_flat = _compute_raw_multipliers(
        u_all.ravel(), z_all.ravel(), risk_tile, fat_tile,
        noise_floor=config.no_risk_below,
        normal_from=config.normal_from,
    )
    mult = mult_flat.reshape(M, n)

    if calendar is None:
        dur_days = remaining / _MS_PER_DAY
    else:
        # Working hours -> working-day count (matches JS durDays definition).
        dur_days = remaining / max(calendar.hours_per_day, 1e-9)
    caps = _duration_sensitive_cap(risk, dur_days,
                                   config.max_mult_base, config.max_mult_high)
    below_floor = risk <= config.no_risk_below
    if np.any(below_floor):
        mult[:, below_floor] = 1.0

    mult = np.minimum(mult, caps[np.newaxis, :])
    mult = np.maximum(mult, config.min_mult)

    return mult, M


# ---------------------------------------------------------------------------
# Vectorised topological propagation
# ---------------------------------------------------------------------------

def _advance(start_ms, work, calendar):
    """
    Advance start_ms by the per-activity work amount.

    On the no-calendar path, *work* is milliseconds and we add directly.
    On the calendar path, *work* is working hours and we route through
    ``advance_working_ms``.  Link lag is always interpreted as working
    hours when a calendar is present (matching the JS
    lagUsesWorkingCalendar default), otherwise as wall-clock hours
    converted to ms.  That conversion happens at the call site, not
    here -- this helper only knows about the per-activity duration step.
    """
    if calendar is None:
        return start_ms + work
    return advance_working_ms(start_ms, work, calendar)


def _propagate_finish_ms(dag_state, remaining, earliest_start_ms,
                         status_ms, mult_all, calendar):
    """
    Walk the DAG in topological order, broadcasting start/finish times
    over all M samples simultaneously.

    ``remaining`` is ms (no-calendar path) or working hours (calendar
    path); ``mult_all`` multiplies it element-wise.

    Returns sim_start_ms, sim_finish_ms of shape (M, n).
    """
    M, n = mult_all.shape
    sim_start = np.empty((M, n), dtype=np.float64)
    sim_finish = np.empty((M, n), dtype=np.float64)

    for j in dag_state.topo_order:
        base_start = earliest_start_ms[j]
        start = np.full(M, base_start, dtype=np.float64)
        req_finish = np.full(M, -np.inf, dtype=np.float64)

        for idx, p in enumerate(dag_state.pred[j]):
            lag, rel = dag_state.pred_edges[j][idx]
            if calendar is None:
                lag_shift_from_finish = sim_finish[:, p] + lag * _MS_PER_HOUR
                lag_shift_from_start = sim_start[:, p] + lag * _MS_PER_HOUR
            else:
                lag_shift_from_finish = advance_working_ms(
                    sim_finish[:, p], lag, calendar)
                lag_shift_from_start = advance_working_ms(
                    sim_start[:, p], lag, calendar)

            if rel == 'FS':
                np.maximum(start, lag_shift_from_finish, out=start)
            elif rel == 'SS':
                np.maximum(start, lag_shift_from_start, out=start)
            elif rel == 'FF':
                np.maximum(req_finish, lag_shift_from_finish, out=req_finish)
            elif rel == 'SF':
                np.maximum(req_finish, lag_shift_from_start, out=req_finish)

        np.maximum(start, status_ms, out=start)
        sim_start[:, j] = start

        finish = _advance(start, remaining[j] * mult_all[:, j], calendar)
        np.maximum(finish, req_finish, out=finish)
        sim_finish[:, j] = finish

    return sim_start, sim_finish


def _deterministic_finish_ms(dag_state, remaining, earliest_start_ms,
                             status_ms, calendar):
    """Single forward pass with multiplier = 1.0 (no risk inflation)."""
    n = dag_state.n
    start = np.empty(n, dtype=np.float64)
    finish = np.empty(n, dtype=np.float64)

    for j in dag_state.topo_order:
        s = earliest_start_ms[j]
        rf = -np.inf
        for idx, p in enumerate(dag_state.pred[j]):
            lag, rel = dag_state.pred_edges[j][idx]
            if calendar is None:
                pf = finish[p] + lag * _MS_PER_HOUR
                ps = start[p] + lag * _MS_PER_HOUR
            else:
                pf = float(advance_working_ms(finish[p], lag, calendar))
                ps = float(advance_working_ms(start[p], lag, calendar))
            if rel == 'FS':
                s = max(s, pf)
            elif rel == 'SS':
                s = max(s, ps)
            elif rel == 'FF':
                rf = max(rf, pf)
            elif rel == 'SF':
                rf = max(rf, ps)
        s = max(s, status_ms)
        start[j] = s
        f = float(_advance(np.array([s]), np.array([remaining[j]]),
                           calendar)[0]) if calendar is not None \
            else s + remaining[j]
        if np.isfinite(rf):
            f = max(f, rf)
        finish[j] = f
    return start, finish


# ---------------------------------------------------------------------------
# Calendar construction
# ---------------------------------------------------------------------------

def _maybe_build_calendar(nodes, dag_state, id_to_idx, status_ms,
                          activity_metadata, project_context):
    """
    Build a WorkingCalendar if project_context.calendar is supplied with
    sufficient information, else return None (wall-clock fall-back).

    A calendar is constructed when the context contains any of
    ``hours_per_day``, ``working_days``, or ``holidays``; if none are
    present the endpoint behaves as V1 (wall-clock time).
    """
    ctx = project_context or {}
    if not isinstance(ctx, dict):
        return None
    cal_cfg = ctx.get('calendar') or {}
    if not isinstance(cal_cfg, dict):
        return None
    has_fields = any(k in cal_cfg for k in ('hours_per_day', 'working_days',
                                            'holidays'))
    if not has_fields:
        return None

    hours_per_day = float(cal_cfg.get('hours_per_day', 8.0))
    working_days = cal_cfg.get('working_days', [1, 2, 3, 4, 5])
    holidays = cal_cfg.get('holidays', [])

    # Estimate horizon from total remaining working hours (deterministic).
    total_work_hrs = 0.0
    for node in nodes:
        nid = str(node.get('ID', node.get('id', '')))
        if nid not in id_to_idx:
            continue
        if _parse_iso_to_ms(node.get('ActualFinish')) is not None:
            continue
        dur_val = node.get('Duration', node.get('duration', 0))
        dur_units = node.get('TimeUnits', node.get('timeUnits'))
        total = _duration_to_work_hours(dur_val, dur_units, hours_per_day)
        pct_raw = node.get('PercentComplete', node.get('percentComplete', 0))
        try:
            pct = float(pct_raw)
        except (TypeError, ValueError):
            pct = 0.0
        if pct > 1.0:
            pct /= 100.0
        pct = max(0.0, min(1.0, pct))
        total_work_hrs += total * (1.0 - pct)

    horizon_days = estimate_horizon_days(total_work_hrs, hours_per_day)

    return WorkingCalendar.build(
        hours_per_day=hours_per_day,
        working_days=working_days,
        holidays=holidays,
        start_ms=status_ms,
        horizon_days=horizon_days,
    )


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_completion_mc(nodes, links, status_date,
                      activity_metadata=None,
                      project_context=None,
                      config=None):
    """
    Run remaining-work Monte Carlo simulation and return finish-date
    percentiles.

    Args:
        nodes: list of activity dicts (ID, Duration, TimeUnits,
               PercentComplete, ExpectedStart, ActualFinish, riskScore,
               SupplierType, ActivityPhase, ...)
        links: list of dependency dicts (source, target, type, lag)
        status_date: ISO-8601 string -- the anchor for remaining work
        activity_metadata: optional dict {activity_id: metadata}
        project_context: optional dict with 'calendar.hours_per_day'
        config: CompletionMCConfig instance or dict

    Returns:
        dict with P20/P50/P80 finish dates, per-activity percentiles,
        deterministic expected finish, and distribution stats.
    """
    t0 = time.time()

    if isinstance(config, dict) or config is None:
        config = CompletionMCConfig.from_dict(config or {})

    status_ms = _parse_iso_to_ms(status_date)
    if status_ms is None:
        raise ValueError("status_date must be a valid ISO-8601 date string")

    dag_state, id_to_idx = build_dag(nodes, links)
    n = dag_state.n

    if n == 0:
        return _empty_result(status_date, t0)

    # Build working calendar from project_context when supplied.  Absence
    # falls back to V1 wall-clock semantics (see _duration_to_ms).
    calendar = _maybe_build_calendar(
        nodes, dag_state, id_to_idx, status_ms, activity_metadata,
        project_context)

    (remaining, earliest_start_ms, risk, activity_types,
     in_scope, actual_finish_ms) = _build_scope(
        nodes, dag_state, id_to_idx, status_ms, activity_metadata,
        calendar)

    if not np.any(in_scope):
        # Nothing left to simulate -- all activities have ActualFinish
        latest = float(np.nanmax(actual_finish_ms)) if np.any(
            np.isfinite(actual_finish_ms)) else status_ms
        iso = _ms_to_iso(latest)
        return {
            'status_date':        _ms_to_iso(status_ms),
            'expected_finish':    iso,
            'p20_finish':         iso,
            'p50_finish':         iso,
            'p80_finish':         iso,
            'spread_days':        0,
            'p20_impact_days':    0,
            'p50_impact_days':    0,
            'p80_impact_days':    0,
            'distribution_stats': {
                'mean_finish': iso, 'std_days': 0.0,
                'min_finish': iso, 'max_finish': iso,
            },
            'activity_percentiles': {},
            'scope_size':           0,
            'iterations':           0,
            'seed':                 config.seed,
            'computation_ms':       round((time.time() - t0) * 1000, 1),
        }

    # Deterministic baseline for expected-finish delta
    det_start, det_finish = _deterministic_finish_ms(
        dag_state, remaining, earliest_start_ms, status_ms, calendar)
    expected_finish_ms = float(np.max(det_finish[in_scope]))

    # Sample multipliers (M, n) and propagate through DAG
    mult_all, M_actual = _sample_multipliers(
        risk, activity_types, remaining, calendar, config)
    logger.info("Completion MC: n=%d, scope=%d, M=%d, calendar=%s",
                n, int(np.sum(in_scope)), M_actual,
                'yes' if calendar is not None else 'no')

    sim_start, sim_finish = _propagate_finish_ms(
        dag_state, remaining, earliest_start_ms, status_ms, mult_all,
        calendar)

    # Project finish per sample = max finish over in-scope activities
    scope_idx = np.where(in_scope)[0]
    proj_finish = np.max(sim_finish[:, scope_idx], axis=1)  # (M,)
    proj_sorted = np.sort(proj_finish)

    p20 = float(proj_sorted[int(0.20 * (M_actual - 1))])
    p50 = float(proj_sorted[int(0.50 * (M_actual - 1))])
    p80 = float(proj_sorted[int(0.80 * (M_actual - 1))])

    # Per-activity percentiles (only in-scope ones)
    idx_to_id = {v: k for k, v in id_to_idx.items()}
    act_pct = {}
    for j in scope_idx:
        col = np.sort(sim_finish[:, j])
        aid = idx_to_id[int(j)]
        act_pct[aid] = {
            'p20': _ms_to_iso(float(col[int(0.20 * (M_actual - 1))])),
            'p50': _ms_to_iso(float(col[int(0.50 * (M_actual - 1))])),
            'p80': _ms_to_iso(float(col[int(0.80 * (M_actual - 1))])),
            'mean_days_from_status': round(
                float(np.mean(col) - status_ms) / _MS_PER_DAY, 2),
        }

    mean_f = float(np.mean(proj_finish))
    std_ms = float(np.std(proj_finish))

    result = {
        'status_date':      _ms_to_iso(status_ms),
        'expected_finish':  _ms_to_iso(expected_finish_ms),
        'p20_finish':       _ms_to_iso(p20),
        'p50_finish':       _ms_to_iso(p50),
        'p80_finish':       _ms_to_iso(p80),
        'spread_days':      round((p80 - p20) / _MS_PER_DAY, 1),
        'p20_impact_days':  round((p20 - expected_finish_ms) / _MS_PER_DAY, 1),
        'p50_impact_days':  round((p50 - expected_finish_ms) / _MS_PER_DAY, 1),
        'p80_impact_days':  round((p80 - expected_finish_ms) / _MS_PER_DAY, 1),
        'distribution_stats': {
            'mean_finish': _ms_to_iso(mean_f),
            'std_days':    round(std_ms / _MS_PER_DAY, 2),
            'min_finish':  _ms_to_iso(float(proj_sorted[0])),
            'max_finish':  _ms_to_iso(float(proj_sorted[-1])),
        },
        'activity_percentiles': act_pct,
        'scope_size':           int(np.sum(in_scope)),
        'iterations':           int(M_actual),
        'seed':                 config.seed,
        'config': {
            'antithetic':    config.antithetic,
            'enable_risk':   config.enable_risk,
            'no_risk_below': config.no_risk_below,
            'normal_from':   config.normal_from,
            'fat_tail_from': config.fat_tail_from,
        },
        'computation_ms': round((time.time() - t0) * 1000, 1),
    }
    return result


def _empty_result(status_date, t0):
    iso = _ms_to_iso(_parse_iso_to_ms(status_date))
    return {
        'status_date':      iso,
        'expected_finish':  iso,
        'p20_finish':       iso,
        'p50_finish':       iso,
        'p80_finish':       iso,
        'spread_days':      0,
        'p20_impact_days':  0,
        'p50_impact_days':  0,
        'p80_impact_days':  0,
        'distribution_stats': {
            'mean_finish': iso, 'std_days': 0.0,
            'min_finish': iso, 'max_finish': iso,
        },
        'activity_percentiles': {},
        'scope_size':           0,
        'iterations':           0,
        'seed':                 42,
        'computation_ms':       round((time.time() - t0) * 1000, 1),
    }
