"""
evm/engine.py - Orchestrator for /evm/analyze.

Ports the top-level flow of EVM.js:
  getCumulativeDistribution   (lines 1486-1721) -> build_forecasted_branch
  createActualEVMChart        (lines 1727-2126) -> build_actual_branch

The shape of the returned dict matches `window.evmMetrics` one-for-one
(camelCase nested keys) so the JS wrapper can cache it directly with
zero post-processing for downstream consumers
(Completionprediction.js:4871 reads `.actual.CPIcum`).
"""

from __future__ import annotations

import logging
import time

from .helpers import (
    safe_date, date_to_iso, date_to_iso_date,
    get_sector_schedule_overrun,
)
from .metrics import (
    compute_evm_metrics, compute_eac, compute_duration_weighted,
    compute_bcws_hours, compute_bcwp_hours, compute_bac_hours,
    compute_acwp, compute_forecasted_bcwp, compute_forecasted_acwp,
)
from .forecast import (
    compute_schedule_delay, find_frontier_nodes,
)
from .distributions import (
    build_forecasted_distributions, build_actual_distributions,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Auto-complete start milestone (EVM.js FIX #9, lines 1279-1319)
# ---------------------------------------------------------------------------

def _auto_complete_start_milestone(nodes):
    """If ID='0' is a milestone AND any task has ActualStart, mark it
    complete.  Returns a new list so the caller's input isn't mutated.
    """
    if not nodes:
        return nodes
    any_progress = any(n.get('ActualStart') for n in nodes)
    if not any_progress:
        return [dict(n) for n in nodes]

    start_id = '0'
    out = []
    for node in nodes:
        if str(node.get('ID', node.get('id', ''))) == start_id and (
                node.get('Duration') in (0, '0', 0.0)):
            patched = dict(node)
            patched['PercentComplete'] = 100
            patched['ActualStart'] = patched.get('Start') or patched.get('ActualStart')
            patched['ActualFinish'] = patched.get('Start') or patched.get('ActualFinish')
            patched['ActualDuration'] = 0
            out.append(patched)
        else:
            out.append(dict(node))
    return out


# ---------------------------------------------------------------------------
# Build forecasted branch (matches window.evmMetrics.forecasted)
# ---------------------------------------------------------------------------

def build_forecasted_branch(nodes, links, options):
    """Returns the dict that ends up at evmMetrics.forecasted."""
    status_date = options.get('statusDate') or options.get('status_date')
    cost_rate = float(options.get('costRate', options.get('cost_rate', 1.0)))
    currency = options.get('currency', 'USD')
    hpd = float(options.get('hoursPerDay', options.get('hours_per_day', 8.0)))
    dpw = float(options.get('workingDaysPerWeek',
                            options.get('working_days_per_week', 5.0)))

    bcws = compute_forecasted_bcwp(  # BCWS using risk-adjusted dates per
                                     # getCumulativeDistribution (forecasted view)
        nodes, status_date, hpd, dpw)
    bcwp = compute_bcwp_hours(nodes, hpd, dpw)
    acwp = compute_forecasted_acwp(nodes, status_date, cost_rate, hpd, dpw)
    bac = compute_bac_hours(nodes, hpd, dpw)

    metrics = compute_evm_metrics(bcwp, acwp, bcws)
    percent_complete_100 = (bcwp / bac * 100.0) if bac > 0 else 0.0
    eac = compute_eac(
        bac, metrics['CPIcum_model'], metrics['SPI_model'],
        percent_complete_100)

    distributions = build_forecasted_distributions(
        nodes, status_date, cost_rate, currency, hpd, dpw)

    out = {
        'BCWS':            bcws,
        'BCWP':            bcwp,
        'ACWP':            acwp,
        'BAC':             bac,
        'EAC':             eac,
        'SV':              metrics['SV'],
        'CV':              metrics['CV'],
        'SPI':             metrics['SPI'],
        'SPI_model':       metrics['SPI_model'],
        'CPIcum':          metrics['CPIcum'],
        'CPIcum_model':    metrics['CPIcum_model'],
        'flags':           metrics['flags'],
        'percentComplete': percent_complete_100,
        'statusDate':      date_to_iso(safe_date(status_date)),
        'currency':        currency,
        'timeUnits':       'Hours',
    }
    out.update(distributions)
    return out


# ---------------------------------------------------------------------------
# Build actual branch (matches window.evmMetrics.actual)
# ---------------------------------------------------------------------------

def build_actual_branch(nodes, links, options):
    """Returns the dict that ends up at evmMetrics.actual."""
    status_date = options.get('statusDate') or options.get('status_date')
    cost_rate = float(options.get('costRate', options.get('cost_rate', 1.0)))
    currency = options.get('currency', 'USD')
    hpd = float(options.get('hoursPerDay', options.get('hours_per_day', 8.0)))
    dpw = float(options.get('workingDaysPerWeek',
                            options.get('working_days_per_week', 5.0)))
    project = options.get('project') or {}

    bcws = compute_bcws_hours(nodes, status_date, hpd, dpw)
    bcwp = compute_bcwp_hours(nodes, hpd, dpw)
    acwp = compute_acwp(nodes, cost_rate, status_date, hpd, dpw)
    bac = compute_bac_hours(nodes, hpd, dpw)

    metrics = compute_evm_metrics(bcwp, acwp, bcws)
    percent_complete_100 = (bcwp / bac * 100.0) if bac > 0 else 0.0
    eac = compute_eac(
        bac, metrics['CPIcum_model'], metrics['SPI_model'],
        percent_complete_100)

    # Duration-weighted progress + schedule-delay prediction
    dw = compute_duration_weighted(nodes, status_date, hpd, dpw)
    sector_overrun = get_sector_schedule_overrun(project)

    # Find latest planned / forecasted end dates among nodes for the
    # schedule-delay call (matches EVM.js uses of plannedEndDate /
    # forecastedEndDate in createActualEVMChart).
    planned_end = None
    forecasted_end = None
    for node in nodes or []:
        pe = safe_date(node.get('Finish'))
        fe = safe_date(node.get('riskAdjustedEnd') or node.get('Finish'))
        if pe and (planned_end is None or pe > planned_end):
            planned_end = pe
        if fe and (forecasted_end is None or fe > forecasted_end):
            forecasted_end = fe

    schedule_delay = compute_schedule_delay(
        status_date, planned_end, forecasted_end,
        metrics['SPI_model'], sector_overrun, nodes, hpd, dpw)

    frontier = find_frontier_nodes(nodes, links)

    distributions = build_actual_distributions(
        nodes, status_date, cost_rate, currency, hpd, dpw)

    out = {
        'BCWS':            bcws,
        'BCWP':            bcwp,
        'ACWP':            acwp,
        'BAC':             bac,
        'EAC':             eac,
        'SV':              metrics['SV'],
        'CV':              metrics['CV'],
        'SPI':             metrics['SPI'],
        'SPI_model':       metrics['SPI_model'],
        'CPIcum':          metrics['CPIcum'],
        'CPIcum_model':    metrics['CPIcum_model'],
        'flags':           metrics['flags'],
        'percentComplete': percent_complete_100,
        'statusDate':      date_to_iso(safe_date(status_date)),
        'currency':        currency,
        'timeUnits':       'Hours',
        'durationWeightedProgress':  dw,
        'sectorScheduleOverrun':     sector_overrun,
        'scheduleMultiplier':        schedule_delay['scheduleMultiplier'],
        'slipDays':                  schedule_delay['slipDays'],
        'performanceDelta':          schedule_delay['performanceDelta'],
        'actualDelayFactor':         schedule_delay['actualDelayFactor'],
        'forecastedDelayFactor':     schedule_delay['forecastedDelayFactor'],
        'frontierNodes':             frontier,
    }
    out.update(distributions)
    return out


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_evm_analysis(nodes, links, options):
    """Produces the full window.evmMetrics-shaped dict.

    Returns {
        'forecasted':     {...},     # everything the JS puts on evmMetrics.forecasted
        'actual':         {...},     # everything the JS puts on evmMetrics.actual
        'currency':       'USD',
        'computation_ms': float,
    }
    """
    t0 = time.time()

    # Clone + auto-complete the start milestone (JS FIX #9)
    cloned_nodes = _auto_complete_start_milestone(nodes)

    forecasted = build_forecasted_branch(cloned_nodes, links, options)
    actual = build_actual_branch(cloned_nodes, links, options)

    logger.info(
        "EVM analysis: n=%d, SPI=%.3f, CPI=%.3f, EAC=%.0f, %.1fms",
        len(cloned_nodes),
        actual.get('SPI_model', 1.0),
        actual.get('CPIcum_model', 1.0),
        actual.get('EAC', 0.0),
        (time.time() - t0) * 1000.0)

    return {
        'forecasted':     forecasted,
        'actual':         actual,
        'currency':       options.get('currency', 'USD'),
        'computation_ms': round((time.time() - t0) * 1000.0, 1),
    }
