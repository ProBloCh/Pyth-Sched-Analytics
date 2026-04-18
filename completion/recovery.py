"""
completion/recovery.py - Schedule recovery option generator.

Extracts the crash + lag ranking logic from Completionprediction.js
(``buildCrashOptions``, lines ~2062-2300) to the backend.  Produces a
ranked list of crash candidates and lag-compression opportunities to
close the gap between the expected and planned project finish, plus an
optional risk-buffer.

Composability: this endpoint is designed to reuse
``/completion/monte-carlo`` output.  The caller typically passes the
``p80_finish`` from the prior MC call so the risk buffer is accurate;
absent that, the endpoint still functions (risk_buffer_days = 0).  The
``expected_finish`` can be supplied or computed locally from
deterministic CPM.

What is *not* extracted:
  - AI enrichment against OpenAI endpoints (frontend-specific)
  - buildRiskWeightedCandidates / risk-mitigation option cards
    (UI-layer risk-register concern, separate from recovery)
"""

from dataclasses import dataclass, field
import logging
import re
import time
from typing import Optional

import numpy as np

from solver.dag import build_dag

from .calendar import advance_working_ms, WorkingCalendar
from evm.helpers import convert_to_hours

from .monte_carlo import (
    _parse_iso_to_ms, _ms_to_iso,
    _duration_to_ms, _duration_to_work_hours,
    _maybe_build_calendar,
    _MS_PER_DAY, _MS_PER_HOUR,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Crash profile classification (ports classifyCrashProfile from the JS)
# ---------------------------------------------------------------------------

# Default per-activity max fraction of remaining duration that can be crashed.
# Matches CONFIG.maxCrashFractionDefault in the JS.
DEFAULT_MAX_CRASH_FRACTION = 0.25

# Supply-chain overrides -- external vendors can only be marginally expedited.
_SUPPLIER_PROFILES = {
    'external_equipment': {'max_frac': 0.03, 'kind': 'external_equipment'},
    'external_material':  {'max_frac': 0.05, 'kind': 'external_material'},
    'external_service':   {'max_frac': 0.10, 'kind': 'external_service'},
}

# Name-based heuristic profiles (first match wins, checked in JS order).
_NAME_PROFILES = [
    (re.compile(r'permit|approval|regulat|review|sign', re.IGNORECASE),
        {'max_frac': 0.08, 'kind': 'governance'}),
    (re.compile(r'procure|purchase|delivery|ship|vendor', re.IGNORECASE),
        {'max_frac': 0.12, 'kind': 'procurement'}),
    (re.compile(r'design|engineer|ifc|draw|model', re.IGNORECASE),
        {'max_frac': 0.18, 'kind': 'engineering'}),
    (re.compile(r'fabricat|shop|weld|machine|prefab', re.IGNORECASE),
        {'max_frac': 0.22, 'kind': 'fabrication'}),
    (re.compile(r'install|erect|construct|civil|mech|elect|pipe', re.IGNORECASE),
        {'max_frac': 0.28, 'kind': 'construction'}),
    (re.compile(r'test|commission|start.?up|turnover', re.IGNORECASE),
        {'max_frac': 0.20, 'kind': 'commissioning'}),
]


def classify_crash_profile(name, supplier_type, default_max_frac=DEFAULT_MAX_CRASH_FRACTION):
    """
    Return a {'max_frac', 'kind'} dict for an activity.

    Precedence: supplier_type override > name regex > default.
    """
    st = (supplier_type or '').strip().lower()
    if st in _SUPPLIER_PROFILES:
        return dict(_SUPPLIER_PROFILES[st])
    if name:
        for rx, profile in _NAME_PROFILES:
            if rx.search(name):
                return dict(profile)
    return {'max_frac': float(default_max_frac), 'kind': 'generic'}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class RecoveryConfig:
    max_risk_buffer_days: float = 10.0
    max_recovery_options: int = 18
    max_lag_options: int = 10
    min_crashable_hours: float = 16.0
    min_crashable_hours_after_profile: float = 8.0
    min_lag_days_for_compression: float = 2.0
    non_chain_min_lag_days: float = 5.0
    lag_compression_factor: float = 0.5
    non_chain_float_threshold_days: float = 10.0
    non_chain_leverage_window_days: float = 12.0
    non_chain_leverage_min: float = 0.2
    non_chain_leverage_max: float = 0.75
    default_max_crash_fraction: float = DEFAULT_MAX_CRASH_FRACTION
    default_importance: float = 0.5
    hours_per_day: float = 8.0  # populated from project_context when present

    @classmethod
    def from_dict(cls, d):
        if not d:
            return cls()
        fields = {
            'max_risk_buffer_days', 'max_recovery_options', 'max_lag_options',
            'min_crashable_hours', 'min_crashable_hours_after_profile',
            'min_lag_days_for_compression', 'non_chain_min_lag_days',
            'lag_compression_factor', 'non_chain_float_threshold_days',
            'non_chain_leverage_window_days', 'non_chain_leverage_min',
            'non_chain_leverage_max', 'default_max_crash_fraction',
            'default_importance',
        }
        kwargs = {k: v for k, v in d.items() if k in fields}
        return cls(**kwargs)


# ---------------------------------------------------------------------------
# Per-activity state (similar to _build_scope but recovery-specific)
# ---------------------------------------------------------------------------

def _importance_01(node, metadata_entry, default):
    for key in ('ComputedImportanceScore', 'importanceScore', 'importance'):
        v = node.get(key)
        if v is not None:
            try:
                fv = float(v)
                if np.isfinite(fv):
                    return float(np.clip(fv, 0.0, 1.0))
            except (TypeError, ValueError):
                pass
    if metadata_entry:
        v = metadata_entry.get('importance_score')
        if v is not None:
            try:
                fv = float(v)
                if np.isfinite(fv):
                    return float(np.clip(fv, 0.0, 1.0))
            except (TypeError, ValueError):
                pass
    return float(default)


def _is_milestone(node):
    m = node.get('Milestone', node.get('milestone'))
    return m in (True, 1, '1', 'true', 'True')


def _node_name(node):
    return node.get('Name') or node.get('name') or str(node.get('ID', ''))


def _supplier_type(node, metadata_entry):
    for key in ('SupplierType', 'supplierType'):
        v = node.get(key)
        if v:
            return str(v).lower()
    if metadata_entry:
        v = metadata_entry.get('supplier_type') or metadata_entry.get('activity_type')
        if v:
            return str(v).lower()
    return ''


def _days_between_ms(a_ms, b_ms):
    """Wall-clock days between two epoch-ms timestamps (b - a)."""
    if a_ms is None or b_ms is None:
        return 0.0
    return (float(b_ms) - float(a_ms)) / _MS_PER_DAY


# ---------------------------------------------------------------------------
# Deterministic CPM slack (float in hours)
# ---------------------------------------------------------------------------

def _compute_float_hours(dag_state, nodes, id_to_idx, calendar, hours_per_day,
                         working_days_per_week=5.0):
    """
    Per-activity total float in hours, aligned to DAG indices.

    The solver's CPM runs in the activity's native duration unit (i.e.,
    the Duration value with no unit conversion).  We convert that slack
    back to *hours* so the frontend's ``floatDays = floatHrs / hpd``
    semantics apply cleanly.  Week/month conversions honour the
    caller's calendar (``working_days_per_week``) so 4x10 and 6-day
    schedules produce correct float/leverage values.
    """
    n = dag_state.n
    wpw = float(working_days_per_week) if working_days_per_week else 5.0
    # Month = ~4.33 working weeks (matches evm/helpers.convert_to_hours)
    month_days = wpw * 4.33
    # Determine per-activity time-unit scale to hours
    per_unit_hrs = np.ones(n, dtype=np.float64)
    for node in nodes:
        nid = str(node.get('ID', node.get('id', '')))
        if nid not in id_to_idx:
            continue
        j = id_to_idx[nid]
        units = str(node.get('TimeUnits', node.get('timeUnits', 'h')) or 'h').lower()
        if calendar is not None:
            # Solver duration was passed through as nominal units; convert
            # those units to working hours to match remaining-work units.
            if units in ('h', 'hr', 'hrs', 'hour', 'hours'):
                per_unit_hrs[j] = 1.0
            elif units in ('d', 'day', 'days'):
                per_unit_hrs[j] = float(hours_per_day)
            elif units in ('w', 'wk', 'week', 'weeks'):
                per_unit_hrs[j] = float(hours_per_day) * wpw
            elif units in ('m', 'mo', 'month', 'months'):
                per_unit_hrs[j] = float(hours_per_day) * month_days
            else:
                per_unit_hrs[j] = 1.0
        else:
            # Wall-clock path: hours = ms / 3.6e6; slack stays in the same
            # (abstract) unit.  Convert to hours using the same mapping,
            # assuming 'days' == 24h wall-clock.
            if units in ('h', 'hr', 'hrs', 'hour', 'hours'):
                per_unit_hrs[j] = 1.0
            elif units in ('d', 'day', 'days'):
                per_unit_hrs[j] = 24.0
            elif units in ('w', 'wk', 'week', 'weeks'):
                per_unit_hrs[j] = 24.0 * 7.0
            elif units in ('m', 'mo', 'month', 'months'):
                per_unit_hrs[j] = 24.0 * 30.0
            else:
                per_unit_hrs[j] = 1.0

    return np.asarray(dag_state.TF, dtype=np.float64) * per_unit_hrs


# ---------------------------------------------------------------------------
# Target hours computation
# ---------------------------------------------------------------------------

def _compute_target(planned_ms, expected_ms, p80_ms, max_risk_buffer_days,
                    hours_per_day):
    """
    Derive (target_days, target_hours, overrun_days, risk_buffer_days).

    Mirrors the JS targetDays calculation:
        overrun_days = max(0, expected - planned)
        risk_buffer_days = min(max_risk_buffer_days,
                               max(0, p80 - expected))
        target_days = overrun_days + risk_buffer_days   if overrun_days > 0
                      risk_buffer_days                   otherwise
    """
    overrun = max(0.0, _days_between_ms(planned_ms, expected_ms)
                  ) if planned_ms is not None and expected_ms is not None else 0.0
    raw_buf = max(0.0, _days_between_ms(expected_ms, p80_ms)
                  ) if p80_ms is not None and expected_ms is not None else 0.0
    risk_buf = min(float(max_risk_buffer_days), raw_buf)
    target_days = (overrun + risk_buf) if overrun > 0 else risk_buf
    target_hours = target_days * float(hours_per_day)
    return target_days, target_hours, overrun, risk_buf


# ---------------------------------------------------------------------------
# Crash candidate construction
# ---------------------------------------------------------------------------

def _build_crash_candidates(nodes, dag_state, id_to_idx, activity_metadata,
                            calendar, hours_per_day, critical_set,
                            float_hrs, config,
                            working_days_per_week=5.0):
    """
    Produce a list of dicts (raw, unsorted before return):
        {id, name, kind, remaining_hrs, max_crash_hrs, leverage,
         is_on_critical_path, float_days, score, importance}
    """
    candidates = []
    hpd = float(hours_per_day)
    dpw = float(working_days_per_week) if working_days_per_week else 5.0

    for node in nodes:
        nid = str(node.get('ID', node.get('id', '')))
        if nid not in id_to_idx:
            continue
        j = id_to_idx[nid]

        if _is_milestone(node):
            continue
        if _parse_iso_to_ms(node.get('ActualFinish')) is not None:
            continue

        meta = (activity_metadata or {}).get(nid, {})

        # Compute total duration in working hours
        dur_val = node.get('Duration', node.get('duration', 0))
        dur_units = node.get('TimeUnits', node.get('timeUnits'))
        if calendar is not None:
            total_hrs = _duration_to_work_hours(
                dur_val, dur_units, hpd, working_days_per_week=dpw)
        else:
            # Wall-clock path: convert ms-of-duration back to hours using
            # 24h/day.  This preserves the JS "1 day = 8 hours" intent
            # only when a calendar is in play; without one, we keep things
            # consistent with the wall-clock MC (1 day = 24h).
            ms = _duration_to_ms(dur_val, dur_units)
            total_hrs = ms / _MS_PER_HOUR
        if total_hrs <= 0:
            continue

        pct_raw = node.get('PercentComplete', node.get('percentComplete', 0))
        try:
            pct = float(pct_raw)
        except (TypeError, ValueError):
            pct = 0.0
        if pct > 1.0:
            pct /= 100.0
        pct = max(0.0, min(1.0, pct))

        remaining_hrs = max(0.0, total_hrs * (1.0 - pct))
        if remaining_hrs < config.min_crashable_hours:
            continue

        profile = classify_crash_profile(
            _node_name(node), _supplier_type(node, meta),
            default_max_frac=config.default_max_crash_fraction)
        max_crash_hrs = remaining_hrs * profile['max_frac']
        if max_crash_hrs < config.min_crashable_hours_after_profile:
            continue

        is_chain = bool(j in critical_set)
        f_hrs = float(float_hrs[j]) if j < len(float_hrs) else 0.0
        float_days = f_hrs / max(hpd, 1e-9)

        if not is_chain and float_days > config.non_chain_float_threshold_days:
            continue

        if is_chain:
            leverage = 1.0
        else:
            leverage = float(np.clip(
                1.0 - float_days / max(config.non_chain_leverage_window_days, 1e-9),
                config.non_chain_leverage_min,
                config.non_chain_leverage_max,
            ))

        importance = _importance_01(node, meta, config.default_importance)
        score = remaining_hrs * leverage * (0.55 + 0.45 * importance)

        candidates.append({
            'id': nid,
            'name': _node_name(node),
            'kind': profile['kind'],
            'remaining_hrs': round(remaining_hrs, 2),
            'max_crash_hrs': round(max_crash_hrs, 2),
            'leverage': round(leverage, 4),
            'is_on_critical_path': is_chain,
            'float_days': round(float_days, 2),
            'score': round(score, 2),
            'importance': round(importance, 4),
        })

    candidates.sort(key=lambda c: c['score'], reverse=True)
    return candidates


# ---------------------------------------------------------------------------
# Lag candidate construction
# ---------------------------------------------------------------------------

def _build_lag_candidates(links, id_to_idx, node_by_id, critical_set,
                          hours_per_day, config,
                          working_days_per_week=5.0):
    """
    Produce a list of dicts (unsorted before return):
        {id, source, target, type, lag_hrs, lag_days,
         potential_savings_hrs, is_on_critical_path, leverage, score}

    Lag is interpreted as hours (matching solver/dag.py and
    getLagInHours() in the JS; the JS normalises to working hours and
    calls this value lagHrs).
    """
    candidates = []
    hpd = float(hours_per_day)

    for link in links or []:
        src = str(link.get('source', ''))
        tgt = str(link.get('target', ''))
        if src not in id_to_idx or tgt not in id_to_idx:
            continue

        try:
            lag_raw = float(link.get('lag', 0))
        except (TypeError, ValueError):
            lag_raw = 0.0
        if not np.isfinite(lag_raw) or lag_raw <= 0:
            continue

        # Links arriving here normally passed through _normalise_link_lags
        # at the top of run_recovery_options, which sets lagUnits='h' and
        # converts to working hours using the same working_days_per_week
        # the CPM / float path uses.  Defensive fallback uses convert_to_hours
        # with the same calendar so a direct caller that skips normalisation
        # doesn't get a stale hardcoded 5-day-week answer.
        lag_units = str(link.get('lagUnits') or link.get('TimeUnits') or 'h').lower()
        if lag_units in ('h', 'hr', 'hrs', 'hour', 'hours'):
            lag_hrs = lag_raw
        else:
            try:
                lag_hrs = convert_to_hours(
                    lag_raw, lag_units, hpd, float(working_days_per_week))
            except Exception:
                lag_hrs = lag_raw

        lag_days = lag_hrs / max(hpd, 1e-9)
        if lag_days < config.min_lag_days_for_compression:
            continue

        si, ti = id_to_idx[src], id_to_idx[tgt]
        is_chain_edge = (si in critical_set) and (ti in critical_set)
        if not is_chain_edge and lag_days < config.non_chain_min_lag_days:
            continue

        leverage = 1.0 if is_chain_edge else 0.6
        potential_savings_hrs = lag_hrs * float(config.lag_compression_factor)
        score = potential_savings_hrs * leverage

        candidates.append({
            'id': f'{src}->{tgt}',
            'source': src,
            'target': tgt,
            'source_name': node_by_id.get(src, {}).get('Name', src),
            'target_name': node_by_id.get(tgt, {}).get('Name', tgt),
            'relation_type': str(link.get('type', 'FS')).upper(),
            'lag_hrs': round(lag_hrs, 2),
            'lag_days': round(lag_days, 2),
            'potential_savings_hrs': round(potential_savings_hrs, 2),
            'is_on_critical_path': is_chain_edge,
            'leverage': round(leverage, 4),
            'score': round(score, 2),
        })

    candidates.sort(key=lambda c: c['score'], reverse=True)
    return candidates


def _normalise_link_lags(links, hours_per_day=8.0, working_days_per_week=5.0):
    """Convert ``(lag, lagUnits)`` pairs to lag-in-hours on a copy.

    solver/dag.py reads ``lag`` as an abstract scalar (no unit
    awareness), so if callers supply lagUnits != hours, the CPM slack
    and critical-path detection would disagree with the
    _build_lag_candidates downstream filter (which uses
    ``convert_to_hours``).  Harmonising here prevents the two paths
    from diverging.

    Input links are shallow-copied so the caller's list is never
    mutated; downstream code reads ``lag`` as hours and can ignore
    ``lagUnits``.
    """
    out = []
    for link in links or []:
        if not isinstance(link, dict):
            out.append(link)
            continue
        raw = link.get('lag', 0) or 0
        units = link.get('lagUnits') or link.get('TimeUnits') or 'h'
        try:
            hrs = convert_to_hours(raw, units, hours_per_day,
                                   working_days_per_week)
        except Exception:
            hrs = raw
        copy = dict(link)
        copy['lag'] = hrs
        copy['lagUnits'] = 'h'
        out.append(copy)
    return out


# ---------------------------------------------------------------------------
# Package into recovery options
# ---------------------------------------------------------------------------

def _package_recovery_options(crash_candidates, target_hours, is_scenario_mode,
                              config, hours_per_day):
    options = []
    remaining_need = float(target_hours)
    achieved_hrs = 0.0
    hpd = float(hours_per_day)

    for c in crash_candidates:
        if is_scenario_mode:
            if len(options) >= config.max_recovery_options:
                break
        else:
            if remaining_need <= 0 or len(options) >= config.max_recovery_options:
                break

        crash_hrs = (c['max_crash_hrs'] if is_scenario_mode
                     else min(c['max_crash_hrs'], remaining_need))
        if crash_hrs <= 0:
            continue

        achieved_hrs += crash_hrs
        remaining_need -= crash_hrs
        crash_days = crash_hrs / max(hpd, 1e-9)

        if crash_days >= 7:
            effort = 'high'
        elif crash_days >= 3:
            effort = 'medium'
        else:
            effort = 'low'

        options.append({
            'id': 'crash_' + c['id'],
            'type': 'duration_crash',
            'title': 'Crash: ' + c['name'],
            'target_activity_id': c['id'],
            'activity_name': c['name'],
            'kind': c['kind'],
            'crash_hours': round(crash_hrs, 2),
            'potential_savings_days': max(1, round(crash_days)),
            'leverage': c['leverage'],
            'is_on_critical_path': c['is_on_critical_path'],
            'float_days': c['float_days'],
            'effort': effort,
            'risk': 'high' if c['score'] > 200 else 'medium',
            'rationale': [
                'On critical path' if c['is_on_critical_path'] else 'Near-critical',
                c['kind'],
            ],
        })

    return options, achieved_hrs


def _package_lag_options(lag_candidates, config, hours_per_day):
    hpd = float(hours_per_day)
    top = lag_candidates[:config.max_lag_options]
    out = []
    for idx, l in enumerate(top):
        out.append({
            'id': 'lag_' + str(idx),
            'type': 'lag_compression',
            'title': f"{l['source_name']} -> {l['target_name']}",
            'edge_id': l['id'],
            'source_id': l['source'],
            'target_id': l['target'],
            'source_name': l['source_name'],
            'target_name': l['target_name'],
            'relation_type': l['relation_type'],
            'current_lag_hours': round(l['lag_hrs'], 2),
            'current_lag_days': round(l['lag_days'], 2),
            'potential_savings_days': max(
                1, round(l['potential_savings_hrs'] / max(hpd, 1e-9))),
            'is_on_critical_path': l['is_on_critical_path'],
            'effort': 'low',
            'risk': 'medium',
        })
    return out


# ---------------------------------------------------------------------------
# Expected-finish helper (deterministic forward pass, calendar-aware)
# ---------------------------------------------------------------------------

def _compute_expected_finish_ms(nodes, links, status_date, activity_metadata,
                                project_context):
    """
    Run the same deterministic forward pass as the MC (risk off) and
    return the project finish in epoch ms.  Used when the caller does
    not supply ``expected_finish``.
    """
    from .monte_carlo import run_completion_mc
    r = run_completion_mc(
        nodes, links, status_date,
        activity_metadata=activity_metadata,
        project_context=project_context,
        config={'iterations': 1, 'enable_risk': False})
    return _parse_iso_to_ms(r.get('expected_finish'))


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_recovery_options(nodes, links, status_date,
                         planned_finish=None,
                         expected_finish=None,
                         p80_finish=None,
                         activity_metadata=None,
                         project_context=None,
                         config=None):
    """
    Build schedule-recovery options: ranked crash candidates and lag
    compressions targeting (overrun + capped risk buffer) days.

    See docs/api/completion.md for the request / response contract.
    """
    t0 = time.time()

    if isinstance(config, dict) or config is None:
        config = RecoveryConfig.from_dict(config or {})

    status_ms = _parse_iso_to_ms(status_date)
    if status_ms is None:
        raise ValueError("status_date must be a valid ISO-8601 date string")

    # Extract calendar values from project_context first so link-lag
    # normalisation below and CPM/float calculations all use the same
    # hours_per_day / working_days_per_week.
    cal_cfg = ((project_context or {}).get('calendar') or {}) if isinstance(
        project_context, dict) else {}
    hours_per_day = float(cal_cfg.get('hours_per_day',
                                      config.hours_per_day))
    working_days_per_week = float(cal_cfg.get('working_days_per_week', 5.0))

    # Normalise link lag units BEFORE build_dag, so the CPM slack /
    # critical-path calculation uses the same lag interpretation as
    # the lag-compression candidate filter downstream.  solver/dag.py
    # treats ``lag`` abstractly (no unit awareness), so we convert
    # here while lagUnits is still available.
    links = _normalise_link_lags(links, hours_per_day, working_days_per_week)

    # Calendar reuse: same construction as the MC endpoint
    dag_state, id_to_idx = build_dag(nodes, links)
    n = dag_state.n
    if n == 0:
        return _empty_result(status_date, config, t0)

    calendar = _maybe_build_calendar(
        nodes, dag_state, id_to_idx, status_ms, activity_metadata,
        project_context)

    # Deterministic CPM (already run inside build_dag) gives TF.
    # Critical-path set: nodes with TF ~= 0.
    critical_set = set(int(i) for i in range(n) if dag_state.critical_mask[i])
    float_hrs = _compute_float_hours(dag_state, nodes, id_to_idx,
                                     calendar, hours_per_day,
                                     working_days_per_week)

    node_by_id = {str(node.get('ID', node.get('id', ''))): node
                  for node in nodes}

    # Fill in expected_finish from deterministic CPM when absent
    planned_ms = _parse_iso_to_ms(planned_finish)
    expected_ms = _parse_iso_to_ms(expected_finish)
    p80_ms = _parse_iso_to_ms(p80_finish)

    if expected_ms is None:
        expected_ms = _compute_expected_finish_ms(
            nodes, links, status_date, activity_metadata, project_context)

    target_days, target_hours, overrun_days, risk_buffer_days = _compute_target(
        planned_ms, expected_ms, p80_ms,
        config.max_risk_buffer_days, hours_per_day)
    is_scenario_mode = overrun_days <= 0

    crash_candidates = _build_crash_candidates(
        nodes, dag_state, id_to_idx, activity_metadata,
        calendar, hours_per_day, critical_set, float_hrs, config,
        working_days_per_week)

    lag_candidates = _build_lag_candidates(
        links, id_to_idx, node_by_id, critical_set,
        hours_per_day, config, working_days_per_week)

    recovery_options, achieved_hrs = _package_recovery_options(
        crash_candidates, target_hours, is_scenario_mode,
        config, hours_per_day)
    lag_options = _package_lag_options(
        lag_candidates, config, hours_per_day)

    achieved_days = achieved_hrs / max(hours_per_day, 1e-9)

    if overrun_days > 0:
        notes = f'Target: recover {round(overrun_days)}d delay'
        if risk_buffer_days > 0:
            notes += f' + {round(risk_buffer_days)}d risk buffer'
    else:
        notes = ('Scenario planning -- compressible activities identified '
                 'for proactive schedule management')

    logger.info(
        "Recovery: n=%d, crash_candidates=%d, lag_candidates=%d, "
        "target_days=%.1f, achieved_days=%.1f, scenario_mode=%s",
        n, len(crash_candidates), len(lag_candidates),
        target_days, achieved_days, is_scenario_mode)

    return {
        'status_date':        _ms_to_iso(status_ms),
        'planned_finish':     _ms_to_iso(planned_ms) if planned_ms else None,
        'expected_finish':    _ms_to_iso(expected_ms) if expected_ms else None,
        'p80_finish':         _ms_to_iso(p80_ms) if p80_ms else None,
        'overrun_days':       round(overrun_days, 2),
        'risk_buffer_days':   round(risk_buffer_days, 2),
        'target_days':        round(target_days, 2),
        'target_hours':       round(target_hours, 2),
        'achieved_days':      round(achieved_days, 2),
        'achieved_hours':     round(achieved_hrs, 2),
        'is_scenario_mode':   is_scenario_mode,
        'recovery_options':   recovery_options,
        'lag_options':        lag_options,
        'crash_candidates':   crash_candidates,
        'lag_candidates':     lag_candidates,
        'notes':              notes,
        'config': {
            'max_risk_buffer_days':      config.max_risk_buffer_days,
            'max_recovery_options':      config.max_recovery_options,
            'max_lag_options':           config.max_lag_options,
            'lag_compression_factor':    config.lag_compression_factor,
            'hours_per_day':             hours_per_day,
        },
        'computation_ms':     round((time.time() - t0) * 1000, 1),
    }


def _empty_result(status_date, config, t0):
    iso = _ms_to_iso(_parse_iso_to_ms(status_date))
    return {
        'status_date':        iso,
        'planned_finish':     None,
        'expected_finish':    None,
        'p80_finish':         None,
        'overrun_days':       0,
        'risk_buffer_days':   0,
        'target_days':        0,
        'target_hours':       0,
        'achieved_days':      0,
        'achieved_hours':     0,
        'is_scenario_mode':   True,
        'recovery_options':   [],
        'lag_options':        [],
        'crash_candidates':   [],
        'lag_candidates':     [],
        'notes':              'No activities to analyse',
        'config': {
            'max_risk_buffer_days':      config.max_risk_buffer_days,
            'max_recovery_options':      config.max_recovery_options,
            'max_lag_options':           config.max_lag_options,
            'lag_compression_factor':    config.lag_compression_factor,
            'hours_per_day':             config.hours_per_day,
        },
        'computation_ms':     round((time.time() - t0) * 1000, 1),
    }
