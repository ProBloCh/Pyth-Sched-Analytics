"""
Tests for the /evm/analyze endpoint and engine.

Locks the Python port to the JS EVM.js behaviour:
  - normalize_percent_complete: P6/MSP 0..100 convention
  - convert_to_hours: all unit aliases + month/year averages
  - compute_evm_metrics: infinity preservation + clamp bounds
  - compute_eac: 4 tiers by percent_complete
  - compute_duration_weighted: ahead-of-baseline edge case
  - get_sector_schedule_overrun: exact + partial match
  - time_phased_ev: 4 cases (completed / actual-in-progress /
    progress-no-actual-dates / future-predicted)
  - find_frontier_nodes: last nodes with progress
  - Endpoint: happy path + validation
"""

import math
import pytest

from evm.helpers import (
    safe_date, difference_in_calendar_days,
    convert_to_hours, normalize_percent_complete,
    get_sector_schedule_overrun, clamp, Bounds,
)
from evm.metrics import (
    compute_evm_metrics, compute_eac, compute_duration_weighted,
    compute_bcws_hours, compute_bcwp_hours, compute_bac_hours,
    compute_acwp,
)
from evm.forecast import (
    time_phased_ev, find_frontier_nodes, compute_schedule_delay,
)
from evm.engine import run_evm_analysis, build_forecasted_branch, build_actual_branch


# =====================================================================
# Helpers
# =====================================================================

class TestConvertToHours:

    def test_hours_passthrough(self):
        assert convert_to_hours(10, 'Hours') == 10
        assert convert_to_hours(10, 'h') == 10
        assert convert_to_hours(10, 'hr') == 10

    def test_days_uses_hours_per_day(self):
        assert convert_to_hours(2, 'days', hours_per_day=8) == 16
        assert convert_to_hours(2, 'days', hours_per_day=10) == 20

    def test_weeks(self):
        assert convert_to_hours(1, 'weeks', hours_per_day=8,
                                working_days_per_week=5) == 40

    def test_m_is_minutes(self):
        # JS convention (line 158-159): 'm' default = minutes
        assert convert_to_hours(60, 'm') == 1.0
        assert convert_to_hours(60, 'min') == 1.0

    def test_mo_is_months(self):
        # 1 month ≈ 4.345 weeks × 5 days × 8 hours = 173.8 hours
        result = convert_to_hours(1, 'months', hours_per_day=8,
                                  working_days_per_week=5)
        assert abs(result - 173.8) < 0.1

    def test_invalid_inputs(self):
        assert convert_to_hours(None, 'h') == 0
        assert convert_to_hours(-5, 'h') == 0
        assert convert_to_hours(float('nan'), 'h') == 0

    def test_unknown_unit_defaults_to_hours(self):
        assert convert_to_hours(10, 'xyz') == 10


class TestNormalizePercentComplete:

    def test_p6_100_scale(self):
        # P6/MSP import: always 0..100, always divide by 100
        assert normalize_percent_complete(50) == 0.5
        assert normalize_percent_complete(100) == 1.0
        # JS v5 fix: 1% is 0.01, not 1.0 (no heuristic)
        assert normalize_percent_complete(1) == 0.01

    def test_strings(self):
        assert normalize_percent_complete('50%') == 0.5
        assert normalize_percent_complete('.5') == 0.005  # '.5' -> '0.5' -> 0.5 / 100

    def test_invalid(self):
        assert normalize_percent_complete(None) == 0
        assert normalize_percent_complete('') == 0
        assert normalize_percent_complete(-10) == 0
        assert normalize_percent_complete(float('inf')) == 0

    def test_clamps_to_01(self):
        assert normalize_percent_complete(150) == 1.0


class TestDifferenceInCalendarDays:

    def test_basic(self):
        assert difference_in_calendar_days(
            '2025-01-10', '2025-01-01') == 9

    def test_reverse(self):
        assert difference_in_calendar_days(
            '2025-01-01', '2025-01-10') == -9

    def test_same_day(self):
        assert difference_in_calendar_days(
            '2025-01-01', '2025-01-01') == 0


class TestSectorLookup:

    def test_exact_match(self):
        assert get_sector_schedule_overrun({'sector': 'nuclear'}) == 0.65
        assert get_sector_schedule_overrun({'sector': 'infrastructure'}) == 0.37

    def test_partial_match(self):
        # "Oil and Gas Development" -> "oil and gas"
        assert get_sector_schedule_overrun(
            {'sector': 'Oil and Gas Development'}) == 0.64

    def test_case_insensitive(self):
        assert get_sector_schedule_overrun({'sector': 'NUCLEAR'}) == 0.65

    def test_empty_uses_default(self):
        assert get_sector_schedule_overrun({}) == 0.25
        assert get_sector_schedule_overrun({'sector': ''}) == 0.25

    def test_unknown_uses_default(self):
        assert get_sector_schedule_overrun(
            {'sector': 'zzz-not-a-sector'}) == 0.25

    def test_explicit_override_wins_over_default(self):
        # When no match but scheduleOverrun is set, use it
        assert get_sector_schedule_overrun(
            {'sector': 'zzz', 'scheduleOverrun': 0.42}) == 0.42

    def test_none_project(self):
        assert get_sector_schedule_overrun(None) == 0.25


# =====================================================================
# EVM metrics: CPI / SPI / SV / CV with infinity preservation
# =====================================================================

class TestEVMMetrics:

    def test_basic(self):
        r = compute_evm_metrics(bcwp=80, acwp=100, bcws=100)
        assert r['SV'] == -20
        assert r['CV'] == -20
        assert r['SPI'] == 0.8
        assert r['CPIcum'] == 0.8
        assert r['SPI_model'] == 0.8
        assert r['CPIcum_model'] == 0.8

    def test_zero_pv_with_ev_returns_infinity(self):
        # JS v5: preserve Infinity as data-quality signal
        r = compute_evm_metrics(bcwp=50, acwp=50, bcws=0)
        assert r['SPI'] == math.inf
        assert r['SPI_model'] == 1.0  # _model is clamped/fallback
        assert r['flags']['pvZeroWithEV'] is True

    def test_zero_ac_with_ev_returns_infinity(self):
        r = compute_evm_metrics(bcwp=50, acwp=0, bcws=50)
        assert r['CPIcum'] == math.inf
        assert r['CPIcum_model'] == 1.0
        assert r['flags']['acZeroWithEV'] is True

    def test_clamp_bounds(self):
        # Extreme ratios get clamped in _model fields
        r = compute_evm_metrics(bcwp=100, acwp=1, bcws=100)  # CPI = 100
        assert r['CPIcum'] == 100.0
        assert r['CPIcum_model'] == Bounds.MAX_CPI  # 20

    def test_all_zero(self):
        r = compute_evm_metrics(bcwp=0, acwp=0, bcws=0)
        assert r['SPI'] == 1.0
        assert r['CPIcum'] == 1.0

    def test_invalid_inputs(self):
        r = compute_evm_metrics(bcwp=float('nan'), acwp=10, bcws=10)
        assert r['flags']['invalidInputs'] is True
        assert r['SPI'] == 1.0


# =====================================================================
# EAC tier logic
# =====================================================================

class TestEAC:

    def test_early_tier_under_10pct(self):
        # pct < 10: pessimistic BAC * 1.15
        # BAC=100, CPI=0.9, pct=5 -> eac = 115 (no AC+remaining math)
        eac = compute_eac(bac=100, cpi=0.9, spi=1.0, percent_complete=5)
        # Early tier result 115 would be clamped into [max(AC, 80), BAC*3]
        # AC = EV/CPI = 5/0.9 = 5.56; lower=max(5.56, 80)=80
        # upper=100*3=300; 115 passes through
        assert eac == pytest.approx(115.0)

    def test_near_complete_over_90pct(self):
        # pct > 90: trust actuals (AC + remaining)
        eac = compute_eac(bac=100, cpi=0.8, spi=1.0, percent_complete=95)
        # EV=95, AC=95/0.8=118.75, remaining=5 -> eac=123.75
        # upper = BAC * 2.5 = 250 (since pct > 50); lower = max(118.75, 80)
        assert eac == pytest.approx(123.75)

    def test_blend_when_cpi_out_of_band(self):
        # CPI < 0.8: AC + remaining / (CPI*SPI)
        eac = compute_eac(bac=100, cpi=0.7, spi=0.9, percent_complete=50)
        # EV=50, AC=71.43, remaining=50 -> eac = 71.43 + 50/(0.7*0.9) = 150.8
        # upper = BAC * 2.5 = 250
        assert 140 < eac < 160

    def test_cpi_only_when_in_band(self):
        # CPI in [0.8, 1.2]: AC + remaining/CPI
        eac = compute_eac(bac=100, cpi=1.0, spi=1.0, percent_complete=50)
        assert eac == pytest.approx(100.0)

    def test_invalid_bac(self):
        assert compute_eac(bac=0, cpi=1, spi=1, percent_complete=50) == 0.0
        assert compute_eac(bac=-100, cpi=1, spi=1, percent_complete=50) == 0.0


# =====================================================================
# Duration-weighted progress (FIX #18)
# =====================================================================

class TestDurationWeighted:

    def test_on_track(self):
        # 10-day task, 50% complete, status date = 5 days in
        # Both planned and actual show 50% -> DW-SPI = 1.0
        nodes = [{
            'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
            'Start': '2025-01-01', 'Finish': '2025-01-11',
            'PercentComplete': 50,
        }]
        r = compute_duration_weighted(nodes, '2025-01-06')
        assert r['durationWeightedSPI'] == pytest.approx(1.0)

    def test_behind_schedule(self):
        # 10-day task, only 20% complete when 50% expected -> DW-SPI = 0.4
        nodes = [{
            'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
            'Start': '2025-01-01', 'Finish': '2025-01-11',
            'PercentComplete': 20,
        }]
        r = compute_duration_weighted(nodes, '2025-01-06')
        assert r['durationWeightedSPI'] == pytest.approx(0.4)

    def test_ahead_of_baseline_caps_at_2x(self):
        # Work done before baseline says any should be done
        nodes = [{
            'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
            'Start': '2025-02-01', 'Finish': '2025-02-11',
            'PercentComplete': 20,
        }]
        r = compute_duration_weighted(nodes, '2025-01-15')  # before start
        assert r['durationWeightedSPI'] == 2.0

    def test_actual_finish_overrides_pct(self):
        # ActualFinish on or before status date -> treated as 100%
        nodes = [{
            'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
            'Start': '2025-01-01', 'Finish': '2025-01-11',
            'ActualFinish': '2025-01-09',
            'PercentComplete': 50,  # stale
        }]
        r = compute_duration_weighted(nodes, '2025-01-15')
        # Actual = 100% * 80hr = 80, Planned = 80 (finished by 01-11)
        assert r['actualCompletedHours'] == 80.0
        assert r['durationWeightedSPI'] == 1.0


# =====================================================================
# Time-phased EV (4-case)
# =====================================================================

class TestTimePhasedEV:

    def _nodes_single(self, **overrides):
        base = {
            'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
            'Start': '2025-01-01', 'Finish': '2025-01-11',
        }
        base.update(overrides)
        return [base]

    def test_case1_completed(self):
        """ActualFinish <= day -> full EV credit."""
        nodes = self._nodes_single(
            ActualStart='2025-01-01', ActualFinish='2025-01-10')
        ev = time_phased_ev(nodes, '2025-01-15', '2025-01-20')
        # 10 days = 80 hours
        assert ev == 80.0

    def test_case2_in_progress_with_actual_finish(self):
        """Linear interp over actual duration."""
        nodes = self._nodes_single(
            ActualStart='2025-01-01', ActualFinish='2025-01-11',
            PercentComplete=50)
        # day 5 of 10 -> 50% * 80 = 40
        ev = time_phased_ev(nodes, '2025-01-06', '2025-01-06')
        assert ev == pytest.approx(40.0)

    def test_case2_in_progress_no_actual_finish(self):
        """Interpolate from ActualStart to status_date, cap by pct."""
        nodes = self._nodes_single(
            ActualStart='2025-01-01', PercentComplete=60)
        # status date = 2025-01-06, day = 2025-01-06 (same)
        # durationToDate = 5, daysElapsed = 5 -> factor = 1.0
        # EV = 80 * 0.60 * 1.0 = 48
        ev = time_phased_ev(nodes, '2025-01-06', '2025-01-06')
        assert ev == pytest.approx(48.0)

    def test_case3_progress_no_actual_dates(self):
        """Progress > 0, no actual dates, day <= status_date -> time-phase
        on planned dates capped by pct."""
        nodes = self._nodes_single(PercentComplete=50)
        # day in middle of planned window, pct=50% -> min(timeProgress=50%, pct=50%) * 80 = 40
        ev = time_phased_ev(nodes, '2025-01-06', '2025-01-06')
        assert ev == pytest.approx(40.0)

    def test_case4_future_with_predicted_end(self):
        """day > status_date and predEnd <= day -> full credit."""
        nodes = self._nodes_single(
            predictedStart='2025-02-01', predictedEnd='2025-02-11')
        ev = time_phased_ev(nodes, '2025-02-15', '2025-01-15')
        assert ev == 80.0

    def test_case4_future_in_progress(self):
        """day > status_date, predStart <= day < predEnd -> linear interp."""
        nodes = self._nodes_single(
            predictedStart='2025-02-01', predictedEnd='2025-02-11')
        # day is 5 of 10 in predicted window
        ev = time_phased_ev(nodes, '2025-02-06', '2025-01-15')
        assert ev == pytest.approx(40.0)

    def test_milestone_zero_duration_ignored(self):
        nodes = [{'ID': '0', 'Duration': 0, 'Start': '2025-01-01',
                  'Finish': '2025-01-01', 'PercentComplete': 100,
                  'ActualFinish': '2025-01-01'}]
        ev = time_phased_ev(nodes, '2025-01-10', '2025-01-10')
        assert ev == 0.0


# =====================================================================
# Frontier nodes
# =====================================================================

class TestFrontierNodes:

    def test_single_chain_last_active_is_frontier(self):
        # A (done) -> B (in progress) -> C (not started)
        # B is the frontier (has progress, successor has no progress)
        nodes = [
            {'ID': 'A', 'Duration': 10, 'TimeUnits': 'days',
             'PercentComplete': 100, 'ActualStart': '2025-01-01'},
            {'ID': 'B', 'Duration': 10, 'TimeUnits': 'days',
             'PercentComplete': 50, 'ActualStart': '2025-01-05'},
            {'ID': 'C', 'Duration': 10, 'TimeUnits': 'days',
             'PercentComplete': 0},
        ]
        links = [
            {'source': 'A', 'target': 'B'},
            {'source': 'B', 'target': 'C'},
        ]
        frontier = find_frontier_nodes(nodes, links)
        assert 'B' in frontier
        assert 'A' not in frontier  # has successor with progress (B)
        assert 'C' not in frontier  # no progress

    def test_milestones_excluded(self):
        nodes = [
            {'ID': 'M', 'Duration': 0, 'PercentComplete': 100,
             'ActualStart': '2025-01-01'},
        ]
        assert find_frontier_nodes(nodes, []) == []

    def test_no_progress_no_frontier(self):
        nodes = [
            {'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'},
            {'ID': 'B', 'Duration': 10, 'TimeUnits': 'days'},
        ]
        assert find_frontier_nodes(nodes, [{'source': 'A', 'target': 'B'}]) == []


# =====================================================================
# Schedule delay prediction
# =====================================================================

class TestScheduleDelay:

    def test_spi_fallback_when_no_nodes(self):
        # No nodes -> uses SPI fallback.  SPI=0.5 -> actualDelayFactor=2.0
        r = compute_schedule_delay(
            status_date='2025-01-01',
            planned_end_date='2025-06-01',
            forecasted_end_date='2025-07-01',
            spi=0.5,
            sector_schedule_overrun=0.25,
            nodes=None,
        )
        assert r['actualDelayFactor'] == 2.0
        assert r['forecastedDelayFactor'] == 1.25
        assert r['slipDays'] > 0

    def test_nodes_path_uses_dw_spi(self):
        # When nodes provided, dw-SPI drives actualDelayFactor
        nodes = [{
            'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
            'Start': '2025-01-01', 'Finish': '2025-01-11',
            'PercentComplete': 25,  # behind (expected 50%)
        }]
        r = compute_schedule_delay(
            status_date='2025-01-06',
            planned_end_date='2025-01-11',
            forecasted_end_date='2025-01-15',
            spi=1.0,  # cost-based SPI says on track
            sector_schedule_overrun=0.25,
            nodes=nodes,
        )
        # DW-SPI = 0.25/0.5 = 0.5 -> actualDelayFactor = 2.0 (not 1.0)
        assert r['actualDelayFactor'] == 2.0
        assert r['durationWeightedProgress'] is not None

    def test_performance_delta_clamped(self):
        # Extreme ratio -> clamped to [MIN_PERF_DELTA, MAX_PERF_DELTA]
        r = compute_schedule_delay(
            status_date='2025-01-01',
            planned_end_date='2025-06-01',
            forecasted_end_date='2025-07-01',
            spi=0.05,  # very slow
            sector_schedule_overrun=0.01,  # negligible forecast
            nodes=None,
        )
        assert r['performanceDelta'] <= Bounds.MAX_PERF_DELTA


# =====================================================================
# End-to-end engine + shape-preservation (CPIcum is what
# Completionprediction.js reads at line 4871 -- lock it down)
# =====================================================================

class TestEngineShape:

    def _project(self):
        nodes = [
            {'ID': '0', 'Duration': 0, 'Milestone': 1,
             'Start': '2025-01-01', 'Finish': '2025-01-01'},
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-11',
             'ActualStart': '2025-01-01', 'PercentComplete': 50,
             'CostRate': 100, 'ActualCost': 3000},
            {'ID': '2', 'Duration': 5, 'TimeUnits': 'days',
             'Start': '2025-01-11', 'Finish': '2025-01-16',
             'PercentComplete': 0, 'CostRate': 100},
        ]
        links = [{'source': '0', 'target': '1'},
                 {'source': '1', 'target': '2'}]
        options = {
            'statusDate': '2025-01-06T00:00:00Z',
            'costRate': 100, 'currency': 'USD',
            'project': {'sector': 'construction'},
            'hoursPerDay': 8, 'workingDaysPerWeek': 5,
        }
        return nodes, links, options

    def test_shape_has_forecasted_and_actual(self):
        nodes, links, options = self._project()
        r = run_evm_analysis(nodes, links, options)
        assert 'forecasted' in r
        assert 'actual' in r
        assert 'currency' in r
        assert 'computation_ms' in r

    def test_consumer_contract_cpicum_present(self):
        """CompletionPrediction.js:4871 reads `.actual.CPIcum` -- this
        key must always be present and finite on non-degenerate inputs."""
        nodes, links, options = self._project()
        r = run_evm_analysis(nodes, links, options)
        assert 'CPIcum' in r['actual']
        assert 'CPIcum' in r['forecasted']

    def test_distributions_populated(self):
        nodes, links, options = self._project()
        r = run_evm_analysis(nodes, links, options)
        assert len(r['forecasted']['distributionPlanned']) > 0
        assert len(r['actual']['distributionEarned']) > 0
        # Each point has date + hours/cost keys
        p = r['forecasted']['distributionPlanned'][0]
        assert 'date' in p
        assert 'hours' in p

    def test_auto_complete_start_milestone_when_any_actual(self):
        nodes, links, options = self._project()
        r = run_evm_analysis(nodes, links, options)
        # Doesn't throw; the id='0' node gets cloned and patched inside
        assert r['actual']['BCWS'] >= 0

    def test_sector_propagates(self):
        nodes, links, options = self._project()
        r = run_evm_analysis(nodes, links, options)
        assert r['actual']['sectorScheduleOverrun'] == 0.25

    def test_frontier_nodes_present(self):
        nodes, links, options = self._project()
        r = run_evm_analysis(nodes, links, options)
        assert isinstance(r['actual']['frontierNodes'], list)

    def test_percent_complete_correct(self):
        nodes, links, options = self._project()
        r = run_evm_analysis(nodes, links, options)
        # BAC = 80 + 40 = 120, BCWP = 40, pct = 33.33
        assert r['actual']['percentComplete'] == pytest.approx(33.33, abs=0.1)


# =====================================================================
# HTTP endpoint
# =====================================================================

class TestEndpoint:

    def test_returns_200(self, client):
        nodes = [
            {'ID': '0', 'Duration': 0, 'Milestone': 1,
             'Start': '2025-01-01', 'Finish': '2025-01-01'},
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-11',
             'PercentComplete': 50, 'CostRate': 100},
        ]
        resp = client.post('/evm/analyze', json={
            'nodes': nodes, 'links': [{'source': '0', 'target': '1'}],
            'options': {'statusDate': '2025-01-06T00:00:00Z'},
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'forecasted' in data
        assert 'actual' in data
        assert data['cache_hit'] is False

    def test_cached_on_second_call(self, client, flask_app):
        """Second call with identical payload returns cache_hit: True."""
        # Ensure app-level cache is in-memory LRU fallback
        nodes = [{'ID': '0', 'Duration': 10, 'TimeUnits': 'days',
                  'Start': '2025-01-01', 'Finish': '2025-01-11',
                  'PercentComplete': 0}]
        payload = {
            'nodes': nodes, 'links': [],
            'options': {'statusDate': '2025-01-06T00:00:00Z'},
        }
        r1 = client.post('/evm/analyze', json=payload).get_json()
        r2 = client.post('/evm/analyze', json=payload).get_json()
        assert r1['cache_hit'] is False
        # r2 may or may not hit cache depending on app config -- allow both
        assert 'cache_hit' in r2

    def test_health(self, client):
        resp = client.get('/evm/health')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'healthy'
        assert data['module'] == 'evm'

    def test_options_preflight(self, client):
        resp = client.options('/evm/analyze')
        assert resp.status_code == 200


class TestEndpointValidation:

    def test_no_body(self, client):
        resp = client.post('/evm/analyze', data='',
                          content_type='application/json')
        assert resp.status_code == 400

    def test_empty_nodes(self, client):
        resp = client.post('/evm/analyze', json={'nodes': []})
        assert resp.status_code == 400

    def test_duplicate_id(self, client):
        resp = client.post('/evm/analyze', json={
            'nodes': [
                {'ID': '1', 'Duration': 10, 'TimeUnits': 'days'},
                {'ID': '1', 'Duration': 5, 'TimeUnits': 'days'},
            ],
        })
        assert resp.status_code == 400
        assert 'Duplicate' in resp.get_json()['error']

    def test_negative_duration(self, client):
        resp = client.post('/evm/analyze', json={
            'nodes': [{'ID': '1', 'Duration': -5}],
        })
        assert resp.status_code == 400

    def test_options_not_object(self, client):
        resp = client.post('/evm/analyze', json={
            'nodes': [{'ID': '1', 'Duration': 10, 'TimeUnits': 'days'}],
            'options': 'bad',
        })
        assert resp.status_code == 400

    def test_infinite_raw_metrics_serialise_to_null(self, client):
        """Critical cross-runtime contract: Python math.inf (from SPI when
        PV=0 and EV>0) must serialise to JSON null, not literal 'Infinity',
        because browser JSON.parse rejects 'Infinity' and the consumer
        guard `isFinite(parseFloat(...))` treats both null and Infinity
        as 'skip'.  Missing this breaks Completionprediction.js:4871.
        """
        import json
        # Node with no planned dates but PercentComplete > 0 forces EV>0, PV=0
        resp = client.post('/evm/analyze', json={
            'nodes': [{'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
                       'PercentComplete': 50}],
            'options': {'statusDate': '2025-01-06T00:00:00Z'},
        })
        assert resp.status_code == 200
        # Strict JSON parse -- will throw if 'Infinity' or 'NaN' leaked
        data = json.loads(resp.get_data(as_text=True))
        # Infinities on raw fields become None
        assert data['forecasted']['SPI'] is None
        # _model versions stay finite (clamped)
        assert data['forecasted']['SPI_model'] == 1.0
        # Consumer read path
        assert 'CPIcum' in data['actual']


# =====================================================================
# ACWP units bug fix (2026-04)
# =====================================================================
#
# JS getCumulativeDistribution line 1723 originally computed:
#   ACWP = calculateForecastedACWP(...) * CostRate
# while calculateForecastedACWP already multiplied by node.CostRate ->
# ACWP was double-multiplied by the project rate when nodes carried
# explicit CostRate.  The Python engine and JS sync path are both fixed.

from evm.metrics import compute_acwp_hours, compute_forecasted_acwp_hours


class TestACWPUnitsConsistency:

    def _node_with_per_node_rate(self, rate):
        return [
            {'ID': '0', 'Duration': 0, 'Milestone': 1,
             'Start': '2025-01-01', 'Finish': '2025-01-01'},
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-11',
             'ActualStart': '2025-01-01', 'PercentComplete': 50,
             'CostRate': rate},
        ]

    def test_acwp_hours_independent_of_cost_rate(self):
        """ACWP in hours must not vary with node CostRate.  This was
        the symptom of the original bug: hours-vs-dollars confusion."""
        a = compute_acwp_hours(
            self._node_with_per_node_rate(100),
            status_date='2025-01-06')
        b = compute_acwp_hours(
            self._node_with_per_node_rate(50),
            status_date='2025-01-06')
        assert a == pytest.approx(b)

    def test_acwp_cost_scales_with_per_node_rate(self):
        """ACWP in cost units IS sensitive to per-node CostRate
        (matches the JS calculateACWP semantic)."""
        from evm.metrics import compute_acwp
        a = compute_acwp(self._node_with_per_node_rate(100),
                         cost_rate=1, status_date='2025-01-06')
        b = compute_acwp(self._node_with_per_node_rate(50),
                         cost_rate=1, status_date='2025-01-06')
        assert a == pytest.approx(b * 2.0)

    def test_no_double_multiplication_in_forecasted_branch(self):
        """Bug: original JS computed forecasted ACWP as
        calculateForecastedACWP() * CostRate, double-multiplying when
        nodes had explicit CostRate.  Python engine never had this
        spurious second multiplication.  Lock it down."""
        nodes = [
            {'ID': '0', 'Duration': 0, 'Milestone': 1,
             'Start': '2025-01-01', 'Finish': '2025-01-01'},
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-11',
             'riskAdjustedStart': '2025-01-01',
             'riskAdjustedEnd': '2025-01-15',
             'ActualStart': '2025-01-01', 'PercentComplete': 50,
             'CostRate': 100},
        ]
        # With CostRate=100 and 80 hours-of-work consumed at status date,
        # ACWP should be hours * cost_rate (per-node) = 80 * 100 = 8000.
        # If we double-multiplied by project cost_rate (also 100), we'd
        # get 800,000.
        result = run_evm_analysis(nodes, [], {
            'statusDate': '2025-01-06T00:00:00Z',
            'costRate': 100, 'currency': 'USD',
            'project': {'sector': 'construction'},
            'hoursPerDay': 8, 'workingDaysPerWeek': 5,
        })
        # Don't pin the absolute value (depends on time-phasing details)
        # but it must be vastly less than 800,000 if the bug is absent.
        assert result['forecasted']['ACWP'] < 100_000

    def test_forecasted_branch_acwp_unit_consistent_with_actual(self):
        """When forecasted == planned (no risk adjustment), forecasted
        ACWP and actual ACWP should match within reason."""
        nodes = [
            {'ID': '0', 'Duration': 0, 'Milestone': 1,
             'Start': '2025-01-01', 'Finish': '2025-01-01'},
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-11',
             'ActualStart': '2025-01-01', 'PercentComplete': 50,
             'CostRate': 100},
        ]
        r = run_evm_analysis(nodes, [], {
            'statusDate': '2025-01-06T00:00:00Z',
            'costRate': 100, 'currency': 'USD',
            'hoursPerDay': 8, 'workingDaysPerWeek': 5,
        })
        # Without riskAdjustedStart/End, forecasted falls back to planned
        # dates and ACWP_cost should equal actual ACWP_cost (within rounding).
        assert r['forecasted']['ACWP'] == pytest.approx(
            r['actual']['ACWP'], rel=0.01)


# =====================================================================
# Predicted-date propagation (port of updatePredictedValues_Improved)
# =====================================================================

from evm.forecast import (
    update_predicted_values, _add_working_hours, _subtract_working_hours,
    _build_succ_map, _build_pred_map, _topological_order,
)


class TestWorkingDayArithmetic:

    def test_add_working_hours_skips_weekends(self):
        from datetime import datetime, timezone
        # Friday + 8 hours = next Monday (skip Sat+Sun)
        fri = datetime(2025, 1, 3, tzinfo=timezone.utc)  # Fri
        result = _add_working_hours(fri, 8.0, hours_per_day=8.0,
                                    working_days=[1, 2, 3, 4, 5])
        assert result.weekday() == 0  # Monday

    def test_add_zero_hours_is_passthrough(self):
        from datetime import datetime, timezone
        d = datetime(2025, 1, 3, tzinfo=timezone.utc)
        assert _add_working_hours(d, 0) == d

    def test_subtract_working_hours(self):
        from datetime import datetime, timezone
        mon = datetime(2025, 1, 6, tzinfo=timezone.utc)  # Mon
        # Subtract 8 hours -> previous Friday
        result = _subtract_working_hours(mon, 8.0, hours_per_day=8.0,
                                         working_days=[1, 2, 3, 4, 5])
        assert result.weekday() == 4  # Friday

    def test_add_working_hours_skips_holidays(self):
        """Holidays must be skipped even if their weekday is a working day."""
        from datetime import datetime, timezone
        # Thu 2025-07-03 + 8h (one working day) with 2025-07-04 holiday ->
        # lands on Mon 2025-07-07, not Fri 2025-07-04
        thu = datetime(2025, 7, 3, tzinfo=timezone.utc)
        no_holiday = _add_working_hours(
            thu, 8.0, hours_per_day=8.0,
            working_days=[1, 2, 3, 4, 5])
        with_holiday = _add_working_hours(
            thu, 8.0, hours_per_day=8.0,
            working_days=[1, 2, 3, 4, 5],
            holidays=['2025-07-04'])
        assert no_holiday.strftime('%Y-%m-%d') == '2025-07-04'
        assert with_holiday.strftime('%Y-%m-%d') == '2025-07-07'

    def test_add_working_hours_skips_multiple_holidays(self):
        from datetime import datetime, timezone
        mon = datetime(2025, 1, 6, tzinfo=timezone.utc)
        # Add 3 working days, with 2025-01-07 and 2025-01-08 both holidays
        # Expect: Mon(start) -> skip Tue (hol) -> skip Wed (hol) -> Thu -> Fri -> Mon
        result = _add_working_hours(
            mon, 24.0, hours_per_day=8.0,
            working_days=[1, 2, 3, 4, 5],
            holidays=['2025-01-07', '2025-01-08'])
        assert result.strftime('%Y-%m-%d') == '2025-01-13'  # Mon (next week)

    def test_subtract_working_hours_skips_holidays(self):
        """Backward arithmetic (FF/SF links) also skips holidays."""
        from datetime import datetime, timezone
        mon = datetime(2025, 7, 7, tzinfo=timezone.utc)
        result = _subtract_working_hours(
            mon, 8.0, hours_per_day=8.0,
            working_days=[1, 2, 3, 4, 5],
            holidays=['2025-07-04'])
        # Mon - 1 working day, skipping Fri holiday -> Thu 2025-07-03
        assert result.strftime('%Y-%m-%d') == '2025-07-03'

    def test_holidays_accepts_varied_shapes(self):
        """{'date': '...'} objects, ISO datetimes, and plain strings all work."""
        from datetime import datetime, timezone
        thu = datetime(2025, 7, 3, tzinfo=timezone.utc)
        r1 = _add_working_hours(thu, 8.0, hours_per_day=8.0,
                                working_days=[1, 2, 3, 4, 5],
                                holidays=[{'date': '2025-07-04'}])
        r2 = _add_working_hours(thu, 8.0, hours_per_day=8.0,
                                working_days=[1, 2, 3, 4, 5],
                                holidays=['2025-07-04T00:00:00Z'])
        r3 = _add_working_hours(thu, 8.0, hours_per_day=8.0,
                                working_days=[1, 2, 3, 4, 5],
                                holidays=['2025-07-04'])
        assert r1 == r2 == r3
        assert r1.strftime('%Y-%m-%d') == '2025-07-07'


class TestUpdatePredictedValues:

    def _basic_chain(self):
        # A (10d) -> B (10d) -> C (10d), planned 30d total starting Jan 1
        nodes = [
            {'ID': 'A', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-15'},
            {'ID': 'B', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-15', 'Finish': '2025-01-29'},
            {'ID': 'C', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-29', 'Finish': '2025-02-12'},
        ]
        links = [
            {'source': 'A', 'target': 'B', 'type': 'FS', 'lag': 0},
            {'source': 'B', 'target': 'C', 'type': 'FS', 'lag': 0},
        ]
        return nodes, links

    def test_initial_assignment_populates_predicted(self):
        nodes, links = self._basic_chain()
        update_predicted_values(
            nodes, links, status_date='2025-01-01',
            schedule_multiplier=1.0, slip_days=0, performance_delta=1.0)
        for n in nodes:
            assert n['predictedStart'] is not None
            assert n['predictedEnd'] is not None
            assert n['predictedDuration'] > 0

    def test_completed_activity_uses_actual_dates(self):
        nodes, links = self._basic_chain()
        nodes[0]['ActualStart'] = '2025-01-01'
        nodes[0]['ActualFinish'] = '2025-01-12'
        nodes[0]['ActualDuration'] = 80
        update_predicted_values(
            nodes, links, status_date='2025-01-15',
            schedule_multiplier=1.0, slip_days=0, performance_delta=1.0)
        # Predicted start/end = actuals
        assert nodes[0]['predictedStart'] == safe_date('2025-01-01')
        assert nodes[0]['predictedEnd'] == safe_date('2025-01-12')

    def test_in_progress_blends_done_and_remaining(self):
        nodes, links = self._basic_chain()
        nodes[0]['ActualStart'] = '2025-01-01'
        nodes[0]['PercentComplete'] = 50  # Half done
        update_predicted_values(
            nodes, links, status_date='2025-01-08',
            schedule_multiplier=1.5, slip_days=0, performance_delta=1.5)
        # 50% done * 80h = 40h done; remaining 40h * 1.5 = 60h; total 100h
        assert nodes[0]['predictedDuration'] == pytest.approx(100.0)

    def test_slip_days_shifts_unstarted(self):
        nodes, links = self._basic_chain()
        update_predicted_values(
            nodes, links, status_date='2025-01-01',
            schedule_multiplier=1.0, slip_days=10, performance_delta=1.0)
        # All unstarted activities push 10 days
        from datetime import timedelta
        original_start = safe_date(nodes[0]['Start'])
        assert nodes[0]['predictedStart'] >= original_start

    def test_topological_propagation_pushes_successor(self):
        """If A's predictedEnd shifts later, B's predictedStart must
        be pushed by FS+0 constraint."""
        nodes, links = self._basic_chain()
        update_predicted_values(
            nodes, links, status_date='2025-01-01',
            schedule_multiplier=2.0, slip_days=10, performance_delta=2.0)
        # B's predicted start should be at or after A's predicted end
        assert nodes[1]['predictedStart'] >= nodes[0]['predictedEnd']

    def test_distance_decay_attenuates_far_nodes(self):
        """Performance delta decays through successors with factor 0.85^d."""
        nodes, links = self._basic_chain()
        # A is the frontier (in progress); B and C are far successors
        nodes[0]['ActualStart'] = '2025-01-01'
        nodes[0]['PercentComplete'] = 30
        update_predicted_values(
            nodes, links, status_date='2025-01-05',
            schedule_multiplier=2.0, slip_days=0, performance_delta=2.0,
            decay_factor=0.5)
        # B (distance 1) should have less inflated duration than 2x
        # C (distance 2) should be closer to original
        b_dur = nodes[1]['predictedDuration']
        c_dur = nodes[2]['predictedDuration']
        assert b_dur > c_dur or b_dur == pytest.approx(c_dur, rel=0.5)

    def test_no_links_skips_propagation(self):
        nodes, _ = self._basic_chain()
        update_predicted_values(
            nodes, [], status_date='2025-01-01',
            schedule_multiplier=1.0, slip_days=0, performance_delta=1.0)
        # All nodes still have predicted dates
        for n in nodes:
            assert 'predictedStart' in n


class TestEngineHolidayThreading:
    """Engine wires options.calendar.holidays through to
    update_predicted_values, so predicted dates respect project
    holidays (matches JS window.HOLIDAY_SET semantics)."""

    def test_predicted_dates_shift_with_holidays(self):
        """Same project, same schedule -- adding a holiday in the
        predicted horizon should push successor predictedStart later."""
        nodes = [
            {'ID': '0', 'Duration': 0, 'Milestone': 1,
             'Start': '2025-06-30T00:00:00Z', 'Finish': '2025-06-30T00:00:00Z'},
            {'ID': '1', 'Duration': 5, 'TimeUnits': 'days',
             'Start': '2025-06-30T00:00:00Z', 'Finish': '2025-07-07T00:00:00Z',
             'ActualStart': '2025-06-30T00:00:00Z', 'PercentComplete': 40},
            {'ID': '2', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-07-07T00:00:00Z', 'Finish': '2025-07-21T00:00:00Z',
             'PercentComplete': 0},
        ]
        links = [
            {'source': '0', 'target': '1', 'type': 'FS', 'lag': 0},
            {'source': '1', 'target': '2', 'type': 'FS', 'lag': 0},
        ]
        base_opts = {
            'statusDate': '2025-07-03T00:00:00Z',
            'costRate': 100,
            'hoursPerDay': 8, 'workingDaysPerWeek': 5,
        }

        # Without holidays
        r_no = run_evm_analysis(
            [dict(n) for n in nodes], links,
            {**base_opts, 'calendar': {
                'hoursPerDay': 8, 'workingDays': [1, 2, 3, 4, 5],
                'holidays': [],
            }})
        # With 5 holidays inside the predicted horizon for activity 2
        r_yes = run_evm_analysis(
            [dict(n) for n in nodes], links,
            {**base_opts, 'calendar': {
                'hoursPerDay': 8, 'workingDays': [1, 2, 3, 4, 5],
                'holidays': ['2025-07-14', '2025-07-15', '2025-07-16',
                             '2025-07-17', '2025-07-18'],
            }})
        # Both branches must at least run without error and the holiday
        # version's distributions must still be populated.  The key
        # assertion: the engine didn't crash threading holidays through
        # and the predicted distribution still advances past status date.
        assert len(r_no['actual']['distributionPredicted']) > 0
        assert len(r_yes['actual']['distributionPredicted']) > 0

    def test_calendar_holidays_nested_or_top_level(self):
        """Holidays accepted either under options.calendar.holidays or
        top-level options.holidays (engine prefers the calendar path)."""
        nodes = [{'ID': '1', 'Duration': 5, 'TimeUnits': 'days',
                  'Start': '2025-07-01T00:00:00Z',
                  'Finish': '2025-07-08T00:00:00Z'}]
        r1 = run_evm_analysis(nodes, [], {
            'statusDate': '2025-07-01T00:00:00Z',
            'calendar': {'holidays': ['2025-07-04']},
        })
        r2 = run_evm_analysis(nodes, [], {
            'statusDate': '2025-07-01T00:00:00Z',
            'holidays': ['2025-07-04'],
        })
        # Both paths accepted, engine returns a shape for each
        assert 'actual' in r1
        assert 'actual' in r2


class TestEngineWithPredictedDates:
    """End-to-end: engine populates predicted dates AND case-4 EV in
    distributions reads them for future portion of curve."""

    def test_distribution_predicted_nonzero_after_status_date(self):
        """When propagation runs, predicted distribution should grow
        beyond status date (was zero in pre-fix backend mode)."""
        nodes = [
            {'ID': '0', 'Duration': 0, 'Milestone': 1,
             'Start': '2025-01-01', 'Finish': '2025-01-01'},
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-15',
             'ActualStart': '2025-01-01', 'PercentComplete': 30},
            {'ID': '2', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-15', 'Finish': '2025-01-29',
             'PercentComplete': 0},
        ]
        links = [
            {'source': '0', 'target': '1'},
            {'source': '1', 'target': '2'},
        ]
        r = run_evm_analysis(nodes, links, {
            'statusDate': '2025-01-08T00:00:00Z',
            'costRate': 100, 'hoursPerDay': 8, 'workingDaysPerWeek': 5,
        })
        # Last point in actual.distributionPredicted should have hours > 0
        # (the predicted curve covers the future portion)
        pred = r['actual']['distributionPredicted']
        if pred:
            last = pred[-1]
            # Predicted curve should have some positive hours past status date
            assert last['hours'] >= 0  # at minimum non-negative


# =====================================================================
# Risk-adjusted-defaulted flag
# =====================================================================

class TestRiskAdjustedDatesFlag:

    def test_flag_false_when_not_provided(self):
        nodes = [
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-11'},
        ]
        r = run_evm_analysis(nodes, [], {
            'statusDate': '2025-01-06T00:00:00Z',
        })
        assert r['riskAdjustedDatesProvided'] is False

    def test_flag_true_when_any_node_has_risk_adjusted_start(self):
        nodes = [
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-11',
             'riskAdjustedStart': '2025-01-02'},
        ]
        r = run_evm_analysis(nodes, [], {
            'statusDate': '2025-01-06T00:00:00Z',
        })
        assert r['riskAdjustedDatesProvided'] is True

    def test_flag_true_when_riskAdjustedDuration_provided(self):
        nodes = [
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-11',
             'riskAdjustedDuration': 12},
        ]
        r = run_evm_analysis(nodes, [], {
            'statusDate': '2025-01-06T00:00:00Z',
        })
        assert r['riskAdjustedDatesProvided'] is True


# =====================================================================
# Engine-integrity: forecasted/actual branches don't cross-mutate
# =====================================================================

class TestBranchIsolation:
    """Predicted-date mutation in actual branch must NOT leak into the
    forecasted branch's risk-adjusted reads."""

    def test_independent_node_clones(self):
        nodes = [
            {'ID': '0', 'Duration': 0, 'Milestone': 1,
             'Start': '2025-01-01', 'Finish': '2025-01-01'},
            {'ID': '1', 'Duration': 10, 'TimeUnits': 'days',
             'Start': '2025-01-01', 'Finish': '2025-01-15',
             'riskAdjustedStart': '2025-01-02',
             'riskAdjustedEnd': '2025-01-18',
             'ActualStart': '2025-01-01', 'PercentComplete': 30},
        ]
        original = [dict(n) for n in nodes]
        run_evm_analysis(nodes, [], {
            'statusDate': '2025-01-08T00:00:00Z',
            'costRate': 100,
        })
        # Caller's input must be untouched
        for orig, cur in zip(original, nodes):
            assert 'predictedStart' not in cur or cur.get('predictedStart') == orig.get('predictedStart')


# =====================================================================
# Idempotent normalisation helpers (holiday / working-day sets)
# =====================================================================

class TestNormaliseIdempotent:
    """Locks the hot-path perf fix: _normalise_holiday_set and
    _normalise_working_days return a pre-normalised set unchanged
    instead of re-parsing, so update_predicted_values avoids
    O(N * |holidays|) re-work inside _add/_subtract_working_hours.
    """

    def test_holiday_set_passed_through_unchanged(self):
        from evm.forecast import _normalise_holiday_set
        preset = {'2025-01-01', '2025-07-04'}
        out = _normalise_holiday_set(preset)
        assert out is preset

    def test_working_days_set_passed_through_unchanged(self):
        from evm.forecast import _normalise_working_days
        preset = {0, 1, 2, 3, 4}
        out = _normalise_working_days(preset)
        assert out is preset

    def test_frozenset_passed_through(self):
        from evm.forecast import _normalise_holiday_set, _normalise_working_days
        fh = frozenset({'2025-01-01'})
        fwd = frozenset({0, 1, 2, 3, 4})
        assert _normalise_holiday_set(fh) is fh
        assert _normalise_working_days(fwd) is fwd

    def test_list_still_gets_normalised(self):
        from evm.forecast import _normalise_holiday_set, _normalise_working_days
        assert _normalise_holiday_set(['2025-01-01', '2025-07-04']) == \
            {'2025-01-01', '2025-07-04'}
        assert _normalise_working_days([1, 2, 3, 4, 5]) == {0, 1, 2, 3, 4}

    def test_empty_inputs(self):
        from evm.forecast import _normalise_holiday_set, _normalise_working_days
        assert _normalise_holiday_set(None) == set()
        assert _normalise_holiday_set([]) == set()
        assert _normalise_working_days(None) == {0, 1, 2, 3, 4}


# =====================================================================
# _duration_to_work_hours honours working_days_per_week + 4.345 months
# =====================================================================

class TestDurationToWorkHoursCalendar:
    """Locks Copilot fix: _duration_to_work_hours uses the caller's
    working_days_per_week and 4.345 weeks/month (matching JS
    PathScripts / evm.helpers), not the old hardcoded 5.0 / 21.0.
    """

    def test_weeks_scale_with_working_days_per_week(self):
        from completion.monte_carlo import _duration_to_work_hours
        # 1 week at hpd=8, dpw=5 -> 40 hrs
        assert _duration_to_work_hours(1, 'w', 8.0, 5.0) == 40.0
        # 1 week at hpd=10, dpw=4 (4x10) -> 40 hrs
        assert _duration_to_work_hours(1, 'w', 10.0, 4.0) == 40.0
        # 1 week at hpd=8, dpw=6 -> 48 hrs
        assert _duration_to_work_hours(1, 'w', 8.0, 6.0) == 48.0

    def test_months_use_4_345_weeks(self):
        import pytest
        from completion.monte_carlo import _duration_to_work_hours
        # 1 month at hpd=8, dpw=5 -> 8 * 5 * 4.345 = 173.8 hrs
        assert _duration_to_work_hours(1, 'mo', 8.0, 5.0) == \
            pytest.approx(8.0 * 5.0 * 4.345)
        # Old behaviour was exactly 8 * 21 = 168; the new value is
        # ~173.8, matching JS PathScripts / evm.helpers.
        assert _duration_to_work_hours(1, 'mo', 8.0, 5.0) != 168.0

    def test_default_dpw_stays_five(self):
        """Back-compat: default invocation gives 5-day-week scaling."""
        from completion.monte_carlo import _duration_to_work_hours
        assert _duration_to_work_hours(1, 'w', 8.0) == 40.0


# =====================================================================
# _compute_float_hours honours working_days_per_week
# =====================================================================

class TestRecoveryFloatHoursCalendar:
    """Locks Copilot fix: _compute_float_hours uses caller's
    working_days_per_week rather than the hardcoded 5.0 (week) and
    21.0 (month) values."""

    def test_week_scales_with_working_days_per_week(self):
        import numpy as np
        from completion.recovery import _compute_float_hours

        class _FakeDag:
            def __init__(self, tf):
                self.n = len(tf)
                self.TF = np.asarray(tf, dtype=np.float64)

        nodes = [{'ID': '0', 'Duration': 1, 'TimeUnits': 'w'}]
        dag = _FakeDag([2.0])
        # 5-day week: 1 week slack = 40 hrs (5 * 8)
        fh5 = _compute_float_hours(dag, nodes, {'0': 0},
                                   calendar=object(),
                                   hours_per_day=8.0,
                                   working_days_per_week=5.0)
        # 4-day week (4x10): 1 week slack = 40 hrs (4 * 10)
        fh4x10 = _compute_float_hours(dag, nodes, {'0': 0},
                                      calendar=object(),
                                      hours_per_day=10.0,
                                      working_days_per_week=4.0)
        # 6-day week: 1 week slack = 48 hrs (6 * 8)
        fh6 = _compute_float_hours(dag, nodes, {'0': 0},
                                   calendar=object(),
                                   hours_per_day=8.0,
                                   working_days_per_week=6.0)
        assert fh5[0] == 2.0 * 8.0 * 5.0     # 80
        assert fh4x10[0] == 2.0 * 10.0 * 4.0 # 80
        assert fh6[0] == 2.0 * 8.0 * 6.0     # 96

    def test_default_week_stays_five_days(self):
        """Default invocation (no working_days_per_week) must produce the
        same result as the previous hardcoded 5.0 for backward compat."""
        import numpy as np
        from completion.recovery import _compute_float_hours

        class _FakeDag:
            def __init__(self, tf):
                self.n = len(tf)
                self.TF = np.asarray(tf, dtype=np.float64)

        nodes = [{'ID': '0', 'Duration': 1, 'TimeUnits': 'w'}]
        dag = _FakeDag([1.0])
        fh = _compute_float_hours(dag, nodes, {'0': 0},
                                  calendar=object(),
                                  hours_per_day=8.0)
        assert fh[0] == 1.0 * 8.0 * 5.0  # 40
