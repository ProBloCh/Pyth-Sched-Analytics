"""
JS-vs-Python diff harness for the EVM service.

For each fixture in tests/diff_harness/fixture_*.json:
  1. Invokes node tests/diff_harness/run_js_evm.js on the fixture and
     captures the resulting JS-side EVM scalars + predicted dates.
  2. Runs the Python evm.engine.run_evm_analysis on the same fixture.
  3. Asserts numerical equivalence (within 1e-6 relative tolerance) on
     every scalar field of forecasted/actual branches; date fields
     within 24h tolerance (to absorb working-calendar edge cases on
     period boundaries).

Skips automatically when Node.js is not installed in the environment.
"""

import json
import math
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from evm.engine import run_evm_analysis


HARNESS_DIR = Path(__file__).parent / 'diff_harness'
JS_HARNESS = HARNESS_DIR / 'run_js_evm.js'

# Skip the entire module if node is not on PATH
NODE_BIN = shutil.which('node')
pytestmark = pytest.mark.skipif(
    NODE_BIN is None,
    reason='node not installed; install Node.js to run JS<->Py diff tests')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_js(fixture_path):
    """Invoke the Node harness; returns parsed JSON.

    Runs with TZ=UTC so JS Date's local-time arithmetic (setDate,
    getDate, getFullYear used by _evmDateKey) produces the same keys
    the UTC ISO fixtures use.  Without this, holidays specified as
    'YYYY-MM-DD' wouldn't match on non-UTC hosts.
    """
    env = dict(os.environ)
    env['TZ'] = 'UTC'
    proc = subprocess.run(
        [NODE_BIN, str(JS_HARNESS), str(fixture_path)],
        capture_output=True, timeout=60, text=True, env=env)
    if proc.returncode != 0:
        raise RuntimeError(
            f'Node harness exited {proc.returncode}\n'
            f'STDOUT: {proc.stdout[:500]}\n'
            f'STDERR: {proc.stderr[:500]}')
    return json.loads(proc.stdout)


def _run_py(fixture_path):
    """Run the Python engine on the same fixture file."""
    with open(fixture_path) as f:
        fixture = json.load(f)
    return run_evm_analysis(
        nodes=fixture['nodes'],
        links=fixture.get('links', []),
        options=fixture.get('options', {}))


def _approx(a, b, rel=1e-6, abs_=1e-6):
    """Equality with both relative and absolute tolerance.  Matches
    pytest.approx semantics but works for both numbers and None.
    """
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if not (math.isfinite(a) and math.isfinite(b)):
        return a == b  # both inf/nan or both None handled above
    if abs(a - b) <= abs_:
        return True
    if max(abs(a), abs(b)) > 0:
        return abs(a - b) / max(abs(a), abs(b)) <= rel
    return a == b


# ---------------------------------------------------------------------------
# Fixture discovery + parametrisation
# ---------------------------------------------------------------------------

FIXTURES = sorted(HARNESS_DIR.glob('fixture_*.json'))


@pytest.fixture(params=FIXTURES, ids=lambda p: p.stem)
def fixture_path(request):
    return request.param


# ---------------------------------------------------------------------------
# Diff tests
# ---------------------------------------------------------------------------

# Scalar fields to compare on each branch
_SCALAR_FIELDS = [
    'BCWS', 'BCWP', 'ACWP', 'BAC', 'EAC',
    'BCWS_hours', 'BCWP_hours', 'BAC_hours',
    'SV', 'CV',
    'SPI', 'SPI_model',
    'CPIcum', 'CPIcum_model',
    'percentComplete',
]

_ACTUAL_ONLY_SCALARS = [
    'sectorScheduleOverrun',
    'scheduleMultiplier',
    'slipDays',
    'performanceDelta',
    'actualDelayFactor',
    'forecastedDelayFactor',
]

_DW_FIELDS = [
    'plannedProgressPct', 'actualProgressPct', 'durationWeightedSPI',
    'totalPlannedHours', 'plannedCompletedHours', 'actualCompletedHours',
]


def test_forecasted_branch_matches_js(fixture_path):
    js = _run_js(fixture_path)
    py = _run_py(fixture_path)

    js_f = js['forecasted']
    py_f = py['forecasted']

    failures = []
    for k in _SCALAR_FIELDS:
        if not _approx(js_f.get(k), py_f.get(k)):
            failures.append(
                f'  {k}: js={js_f.get(k)!r} py={py_f.get(k)!r}')
    assert not failures, (
        f'forecasted branch diverged on {len(failures)} fields:\n'
        + '\n'.join(failures))


def test_actual_branch_matches_js(fixture_path):
    js = _run_js(fixture_path)
    py = _run_py(fixture_path)

    js_a = js['actual']
    py_a = py['actual']

    failures = []
    for k in _SCALAR_FIELDS + _ACTUAL_ONLY_SCALARS:
        if not _approx(js_a.get(k), py_a.get(k)):
            failures.append(
                f'  {k}: js={js_a.get(k)!r} py={py_a.get(k)!r}')

    js_dw = js_a.get('durationWeightedProgress', {})
    py_dw = py_a.get('durationWeightedProgress', {})
    for k in _DW_FIELDS:
        if not _approx(js_dw.get(k), py_dw.get(k)):
            failures.append(
                f'  durationWeightedProgress.{k}: '
                f'js={js_dw.get(k)!r} py={py_dw.get(k)!r}')

    assert not failures, (
        f'actual branch diverged on {len(failures)} fields:\n'
        + '\n'.join(failures))


def test_frontier_nodes_match(fixture_path):
    js = _run_js(fixture_path)
    py = _run_py(fixture_path)
    js_set = set(js['actual']['frontierNodes'])
    py_set = set(py['actual']['frontierNodes'])
    assert js_set == py_set, (
        f'frontier nodes diverged: js={js_set} py={py_set}')


def test_predicted_dates_within_one_day(fixture_path):
    """Predicted dates should match within 24h tolerance.  Working-day
    arithmetic on weekend/holiday boundaries can produce ±1d
    discrepancies that don't affect chart shapes; tighter than this
    is fragile across implementations."""
    from datetime import datetime
    js = _run_js(fixture_path)
    py = _run_py(fixture_path)

    js_pred = {p['id']: p for p in js['predictedDates']}

    failures = []
    # Reconstruct predicted dates from Python actual branch -- the engine
    # mutates its internal clones so we need to re-run with explicit access.
    # Easiest: rerun update_predicted_values directly.
    with open(fixture_path) as f:
        fixture = json.load(f)
    from evm.engine import _auto_complete_start_milestone, _has_risk_adjusted_dates
    from evm.metrics import compute_evm_metrics
    from evm.forecast import (
        compute_schedule_delay, find_frontier_nodes,
        update_predicted_values, get_sector_schedule_overrun,
    )
    from evm.metrics import (
        compute_bcws_hours, compute_bcwp_hours, compute_acwp,
        compute_bac_hours, compute_duration_weighted,
    )
    from evm.helpers import safe_date

    nodes = _auto_complete_start_milestone(fixture['nodes'])
    nodes_actual = [dict(n) for n in nodes]
    links = fixture.get('links', [])
    opts = fixture.get('options', {})
    hpd = float(opts.get('hoursPerDay', 8.0))
    dpw = float(opts.get('workingDaysPerWeek', 5.0))
    cost_rate = float(opts.get('costRate', 1.0))
    status_date = opts.get('statusDate')
    project = opts.get('project') or {}
    cal = opts.get('calendar') or {}
    working_days = (opts.get('workingDays') or opts.get('working_days')
                    or cal.get('workingDays') or cal.get('working_days'))
    holidays = cal.get('holidays') or opts.get('holidays')

    bcws = compute_bcws_hours(nodes_actual, status_date, hpd, dpw)
    bcwp = compute_bcwp_hours(nodes_actual, hpd, dpw)
    acwp = compute_acwp(nodes_actual, cost_rate, status_date, hpd, dpw)
    bac = compute_bac_hours(nodes_actual, hpd, dpw)
    bcws_c = bcws * cost_rate
    bcwp_c = bcwp * cost_rate
    metrics = compute_evm_metrics(bcwp_c, acwp, bcws_c)
    sector = get_sector_schedule_overrun(project)

    planned_end = forecasted_end = None
    for n in nodes_actual:
        pe = safe_date(n.get('Finish'))
        fe = safe_date(n.get('riskAdjustedEnd') or n.get('Finish'))
        if pe and (planned_end is None or pe > planned_end):
            planned_end = pe
        if fe and (forecasted_end is None or fe > forecasted_end):
            forecasted_end = fe

    sd_res = compute_schedule_delay(
        status_date, planned_end, forecasted_end,
        metrics['SPI_model'], sector, nodes_actual, hpd, dpw)
    frontier = find_frontier_nodes(nodes_actual, links)
    update_predicted_values(
        nodes_actual, links, status_date,
        schedule_multiplier=sd_res['scheduleMultiplier'],
        slip_days=sd_res['slipDays'],
        performance_delta=sd_res['performanceDelta'],
        hours_per_day=hpd, working_days_per_week=dpw,
        working_days=working_days,
        holidays=holidays,
        precomputed_frontier=frontier)

    for n in nodes_actual:
        nid = str(n.get('ID'))
        js_p = js_pred.get(nid)
        if js_p is None:
            continue
        py_start = n.get('predictedStart')
        py_end = n.get('predictedEnd')
        js_start = (datetime.fromisoformat(js_p['predictedStart'].replace('Z', '+00:00'))
                    if js_p.get('predictedStart') else None)
        js_end = (datetime.fromisoformat(js_p['predictedEnd'].replace('Z', '+00:00'))
                  if js_p.get('predictedEnd') else None)

        if py_start and js_start:
            diff = abs((py_start - js_start).total_seconds()) / 86400.0
            if diff > 1.0:
                failures.append(
                    f'  {nid}.predictedStart: js={js_start} py={py_start} '
                    f'diff={diff:.2f}d')
        if py_end and js_end:
            diff = abs((py_end - js_end).total_seconds()) / 86400.0
            if diff > 1.0:
                failures.append(
                    f'  {nid}.predictedEnd: js={js_end} py={py_end} '
                    f'diff={diff:.2f}d')

        # Predicted duration must match within rounding (hours)
        if (n.get('predictedDuration') is not None
                and js_p.get('predictedDuration') is not None):
            if not _approx(n['predictedDuration'],
                           js_p['predictedDuration'], rel=1e-3, abs_=0.1):
                failures.append(
                    f'  {nid}.predictedDuration: '
                    f'js={js_p["predictedDuration"]} py={n["predictedDuration"]}')

    assert not failures, (
        f'{len(failures)} predicted-date diffs (>1d or duration mismatch):\n'
        + '\n'.join(failures))
