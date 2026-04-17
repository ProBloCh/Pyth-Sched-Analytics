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
