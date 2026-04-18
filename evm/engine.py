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
    compute_acwp, compute_acwp_hours,
    compute_forecasted_bcwp, compute_forecasted_acwp,
    compute_forecasted_acwp_hours,
)
from .forecast import (
    compute_schedule_delay, find_frontier_nodes, update_predicted_values,
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


def _has_risk_adjusted_dates(nodes):
    """Whether any node carries riskAdjusted{Start,End,Duration}.

    When False, the forecasted branch silently collapses to the planned
    branch (because compute_forecasted_bcwp/acwp fall back to Start/Finish).
    Surfacing this via _riskAdjustedDatesProvided lets consumers detect
    the situation rather than be surprised by identical curves.
    """
    if not nodes:
        return False
    for n in nodes:
        if (n.get('riskAdjustedStart') or n.get('riskAdjustedEnd')
                or n.get('riskAdjustedDuration') is not None):
            return True
    return False


# ---------------------------------------------------------------------------
# Build forecasted branch (matches window.evmMetrics.forecasted)
# ---------------------------------------------------------------------------

def build_forecasted_branch(nodes, links, options):
    """Returns the dict that ends up at evmMetrics.forecasted.

    BUG FIX (vs original JS line 1723): the JS forecasted branch
    computed ACWP as ``calculateForecastedACWP() * CostRate`` while the
    function already multiplied by node.CostRate -- giving ACWP a
    double-rate inflation when nodes carried explicit CostRate.  We
    use compute_forecasted_acwp once (per-node rate, like actual
    branch's calculateACWP) and expose it directly.  The JS sync path
    has been corrected to match.

    All metrics-path values (BCWS, BCWP, ACWP) are in DOLLARS so
    CPI = EV/AC is dimensionally consistent (mirrors the JS actual
    branch lines 1838-1846).
    """
    status_date = options.get('statusDate') or options.get('status_date')
    cost_rate = float(options.get('costRate', options.get('cost_rate', 1.0)))
    currency = options.get('currency', 'USD')
    hpd = float(options.get('hoursPerDay', options.get('hours_per_day', 8.0)))
    dpw = float(options.get('workingDaysPerWeek',
                            options.get('working_days_per_week', 5.0)))

    # Mirror JS getCumulativeDistribution (EVM.js line 1746-1747):
    #   BCWS = calculateBCWS_Hours(workingNodes, statusDate)
    #   BCWP = calculateForecastedBCWP(workingNodes, statusDate)
    # Earlier versions of this port had these two swapped, which meant
    # backend output silently disagreed with the JS fallback (which
    # defeats the "transparent fallback" goal).  The diff harness was
    # ALSO swapped in the same way, so JS<->Python parity passed while
    # both diverged from the live browser implementation.  Fixed in
    # both places in the same commit so the diff harness still passes.
    bcws_hours = compute_bcws_hours(nodes, status_date, hpd, dpw)
    bcwp_hours = compute_forecasted_bcwp(nodes, status_date, hpd, dpw)
    bac_hours = compute_bac_hours(nodes, hpd, dpw)

    # Convert to dollars uniformly via project cost_rate.
    # ACWP uses per-node rate (matching JS calculateForecastedACWP, but
    # WITHOUT the spurious second project-rate multiplication that the
    # original JS did at line 1723).
    bcws_cost = bcws_hours * cost_rate
    bcwp_cost = bcwp_hours * cost_rate
    bac_cost = bac_hours * cost_rate
    acwp_cost = compute_forecasted_acwp(
        nodes, status_date, cost_rate, hpd, dpw, apply_cost_rate=True)

    metrics = compute_evm_metrics(bcwp_cost, acwp_cost, bcws_cost)
    percent_complete_100 = (bcwp_hours / bac_hours * 100.0
                            ) if bac_hours > 0 else 0.0
    eac = compute_eac(
        bac_cost, metrics['CPIcum_model'], metrics['SPI_model'],
        percent_complete_100)

    distributions = build_forecasted_distributions(
        nodes, status_date, cost_rate, currency, hpd, dpw,
        max_distribution_points=options.get('maxDistributionPoints')
                                or options.get('max_distribution_points'))

    out = {
        # Dollars (unit-consistent for CPI/SPI/EAC)
        'BCWS':            bcws_cost,
        'BCWP':            bcwp_cost,
        'ACWP':            acwp_cost,
        'BAC':             bac_cost,
        'EAC':             eac,
        # Hours-only versions for callers that need them
        'BCWS_hours':      bcws_hours,
        'BCWP_hours':      bcwp_hours,
        'BAC_hours':       bac_hours,
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
    """Returns the dict that ends up at evmMetrics.actual.

    Pipeline:
      1. Compute scalar metrics (BCWS / BCWP / ACWP / BAC / EAC).
      2. Compute duration-weighted progress and schedule-delay prediction.
      3. **Mutate nodes in place** with predictedStart/End/Duration via
         update_predicted_values -- ports JS updatePredictedValues_Improved
         so case-4 of time_phased_ev (future EV) actually fires.
      4. Build cumulative + non-cumulative distributions (which now
         consume the updated predicted dates).

    UNIT CHOICE: after the forecasted-ACWP double-multiply fix, the
    metrics pipeline is dollars-consistent throughout: BCWS/BCWP are
    hours multiplied by project cost_rate, ACWP is per-node CostRate
    applied once (via compute_acwp), and compute_evm_metrics receives
    all three in dollars so CPI = EV/AC is dimensionally clean.
    Hours-only values are still exposed for callers that prefer them
    (BCWS_hours / BCWP_hours / BAC_hours fields in the response).
    """
    status_date = options.get('statusDate') or options.get('status_date')
    cost_rate = float(options.get('costRate', options.get('cost_rate', 1.0)))
    currency = options.get('currency', 'USD')
    hpd = float(options.get('hoursPerDay', options.get('hours_per_day', 8.0)))
    dpw = float(options.get('workingDaysPerWeek',
                            options.get('working_days_per_week', 5.0)))
    project = options.get('project') or {}
    working_days = options.get('workingDays') or options.get('working_days')
    # Calendar may carry working_days and holidays; prefer nested values
    # when the top-level fields are absent so either shape works.
    cal = options.get('calendar') or {}
    if not working_days:
        working_days = cal.get('workingDays') or cal.get('working_days')
    holidays = cal.get('holidays') or options.get('holidays')

    bcws_hours = compute_bcws_hours(nodes, status_date, hpd, dpw)
    bcwp_hours = compute_bcwp_hours(nodes, hpd, dpw)
    bac_hours = compute_bac_hours(nodes, hpd, dpw)

    # All-dollars metrics path, mirroring JS createActualEVMChart
    # (lines 1842-1846): BCWP/BCWS via project rate, ACWP via per-node rate.
    bcws_cost = bcws_hours * cost_rate
    bcwp_cost = bcwp_hours * cost_rate
    bac_cost = bac_hours * cost_rate
    acwp_cost = compute_acwp(nodes, cost_rate, status_date, hpd, dpw)

    metrics = compute_evm_metrics(bcwp_cost, acwp_cost, bcws_cost)
    percent_complete_100 = (bcwp_hours / bac_hours * 100.0
                            ) if bac_hours > 0 else 0.0
    eac = compute_eac(
        bac_cost, metrics['CPIcum_model'], metrics['SPI_model'],
        percent_complete_100)

    dw = compute_duration_weighted(nodes, status_date, hpd, dpw)
    sector_overrun = get_sector_schedule_overrun(project)

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

    # Mutate nodes in-place with predictedStart/End/Duration.  The
    # caller cloned the input list in _auto_complete_start_milestone so
    # this is safe.  Ports JS updatePredictedValues_Improved.
    update_predicted_values(
        nodes, links, status_date,
        schedule_multiplier=schedule_delay['scheduleMultiplier'],
        slip_days=schedule_delay['slipDays'],
        performance_delta=schedule_delay['performanceDelta'],
        hours_per_day=hpd, working_days_per_week=dpw,
        working_days=working_days,
        holidays=holidays,
        precomputed_frontier=frontier)

    distributions = build_actual_distributions(
        nodes, status_date, cost_rate, currency, hpd, dpw,
        max_distribution_points=options.get('maxDistributionPoints')
                                or options.get('max_distribution_points'))

    out = {
        # Dollars (unit-consistent for CPI/SPI/EAC)
        'BCWS':            bcws_cost,
        'BCWP':            bcwp_cost,
        'ACWP':            acwp_cost,
        'BAC':             bac_cost,
        'EAC':             eac,
        # Hours-only versions for callers that need them
        'BCWS_hours':      bcws_hours,
        'BCWP_hours':      bcwp_hours,
        'BAC_hours':       bac_hours,
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
    risk_provided = _has_risk_adjusted_dates(cloned_nodes)

    # build_forecasted_branch and build_actual_branch each get their own
    # cloned list so the predicted-date mutation in the actual branch
    # never leaks into the forecasted branch's risk-adjusted reads.
    forecasted = build_forecasted_branch(
        [dict(n) for n in cloned_nodes], links, options)
    actual = build_actual_branch(
        [dict(n) for n in cloned_nodes], links, options)

    logger.info(
        "EVM analysis: n=%d, SPI=%.3f, CPI=%.3f, EAC=%.0f, "
        "risk_adjusted_dates=%s, %.1fms",
        len(cloned_nodes),
        actual.get('SPI_model', 1.0),
        actual.get('CPIcum_model', 1.0),
        actual.get('EAC', 0.0),
        risk_provided,
        (time.time() - t0) * 1000.0)

    return {
        'forecasted':     forecasted,
        'actual':         actual,
        'currency':       options.get('currency', 'USD'),
        # Surfaces whether the caller supplied riskAdjustedStart/End/Duration.
        # When False, the forecasted branch is identical to the planned
        # branch (compute_forecasted_* fall back to Start/Finish silently).
        'riskAdjustedDatesProvided': risk_provided,
        'computation_ms': round((time.time() - t0) * 1000.0, 1),
    }
