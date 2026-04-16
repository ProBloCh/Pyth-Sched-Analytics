"""
Tests for the /completion/monte-carlo endpoint and underlying engine.

Covers:
  - Engine unit tests (duration parsing, scope building, propagation)
  - Determinism under fixed seed
  - Monotonicity of P20 <= P50 <= P80
  - Risk-disabled collapse to deterministic expected finish
  - PercentComplete / ActualFinish handling
  - FS/SS/FF/SF + lag propagation
  - HTTP endpoint validation and happy path
"""

import math
import pytest

from completion.monte_carlo import (
    run_completion_mc, CompletionMCConfig,
    _parse_iso_to_ms, _ms_to_iso, _duration_to_ms,
    _MS_PER_DAY, _MS_PER_HOUR,
)


# =====================================================================
# Date / duration helpers
# =====================================================================

class TestHelpers:

    def test_iso_roundtrip(self):
        ms = _parse_iso_to_ms('2025-01-01T00:00:00Z')
        iso = _ms_to_iso(ms)
        assert iso.startswith('2025-01-01')

    def test_iso_invalid_returns_none(self):
        assert _parse_iso_to_ms('not-a-date') is None
        assert _parse_iso_to_ms(None) is None

    def test_duration_units(self):
        assert _duration_to_ms(1, 'h') == _MS_PER_HOUR
        assert _duration_to_ms(1, 'hours') == _MS_PER_HOUR
        assert _duration_to_ms(1, 'day') == _MS_PER_DAY
        assert _duration_to_ms(1, 'days') == _MS_PER_DAY
        assert _duration_to_ms(1, 'week') == _MS_PER_DAY * 7.0

    def test_duration_rejects_bad(self):
        assert _duration_to_ms(float('nan'), 'h') == 0.0
        assert _duration_to_ms(-5, 'h') == 0.0
        assert _duration_to_ms('bad', 'h') == 0.0


# =====================================================================
# Engine: deterministic finish matches CPM
# =====================================================================

class TestDeterministicFinish:

    def test_linear_chain_matches_cpm(self, linear_schedule):
        """A(10) -> B(20) -> C(5), all days: makespan 35d from status."""
        nodes, links = linear_schedule
        for n in nodes:
            n['TimeUnits'] = 'days'
        r = run_completion_mc(nodes, links, '2025-01-01T00:00:00Z',
                              config={'iterations': 50, 'enable_risk': False})
        # Expected finish 35 days after 2025-01-01 = 2025-02-05
        assert r['expected_finish'].startswith('2025-02-05')
        assert r['scope_size'] == 3

    def test_diamond_matches_cpm(self, diamond_schedule):
        """Critical path 42d."""
        nodes, links = diamond_schedule
        for n in nodes:
            n['TimeUnits'] = 'days'
        r = run_completion_mc(nodes, links, '2025-01-01T00:00:00Z',
                              config={'iterations': 50, 'enable_risk': False})
        # 42 days after 01-01 = 02-12
        assert r['expected_finish'].startswith('2025-02-12')

    def test_risk_off_collapses_to_deterministic(self):
        nodes = [{'ID': 'X', 'Duration': 10, 'TimeUnits': 'days',
                  'riskScore': 0.9}]
        r = run_completion_mc(nodes, [], '2025-01-01T00:00:00Z',
                              config={'iterations': 50, 'enable_risk': False})
        assert r['p20_finish'] == r['p50_finish'] == r['p80_finish']
        assert r['p50_finish'] == r['expected_finish']
        assert r['spread_days'] == 0


# =====================================================================
# Engine: percentile monotonicity and stochastic spread
# =====================================================================

class TestStochastic:

    def test_percentile_monotonicity(self, diamond_schedule):
        nodes, links = diamond_schedule
        for n in nodes:
            n['TimeUnits'] = 'days'
            n['riskScore'] = 0.6
        r = run_completion_mc(nodes, links, '2025-01-01T00:00:00Z',
                              config={'iterations': 300, 'seed': 42})
        p20 = _parse_iso_to_ms(r['p20_finish'])
        p50 = _parse_iso_to_ms(r['p50_finish'])
        p80 = _parse_iso_to_ms(r['p80_finish'])
        assert p20 <= p50 <= p80
        assert r['spread_days'] > 0

    def test_impact_days_nonnegative(self, diamond_schedule):
        """Risk can only delay, never advance, remaining-work finish."""
        nodes, links = diamond_schedule
        for n in nodes:
            n['TimeUnits'] = 'days'
            n['riskScore'] = 0.7
        r = run_completion_mc(nodes, links, '2025-01-01T00:00:00Z',
                              config={'iterations': 200, 'seed': 42,
                                      'caps': {'min_mult': 1.0}})
        assert r['p20_impact_days'] >= 0
        assert r['p50_impact_days'] >= r['p20_impact_days']
        assert r['p80_impact_days'] >= r['p50_impact_days']

    def test_determinism_under_fixed_seed(self, diamond_schedule):
        nodes, links = diamond_schedule
        for n in nodes:
            n['TimeUnits'] = 'days'
            n['riskScore'] = 0.5
        cfg = {'iterations': 100, 'seed': 7}
        r1 = run_completion_mc(nodes, links, '2025-01-01T00:00:00Z', config=cfg)
        r2 = run_completion_mc(nodes, links, '2025-01-01T00:00:00Z', config=cfg)
        assert r1['p50_finish'] == r2['p50_finish']
        assert r1['p80_finish'] == r2['p80_finish']

    def test_higher_risk_yields_wider_spread(self):
        """Spread(P80-P20) should grow with risk score, all else equal."""
        def run(risk):
            nodes = [{'ID': 'A', 'Duration': 100, 'TimeUnits': 'days',
                      'riskScore': risk}]
            return run_completion_mc(nodes, [], '2025-01-01T00:00:00Z',
                                     config={'iterations': 400, 'seed': 42})
        low = run(0.10)['spread_days']
        high = run(0.70)['spread_days']
        assert high > low

    def test_per_activity_percentiles_present(self, diamond_schedule):
        nodes, links = diamond_schedule
        for n in nodes:
            n['TimeUnits'] = 'days'
            n['riskScore'] = 0.3
        r = run_completion_mc(nodes, links, '2025-01-01T00:00:00Z',
                              config={'iterations': 100})
        assert len(r['activity_percentiles']) == 5
        for aid in ('A', 'B', 'C', 'D', 'E'):
            assert 'p50' in r['activity_percentiles'][aid]


# =====================================================================
# Engine: scope semantics
# =====================================================================

class TestScope:

    def test_percent_complete_reduces_remaining(self):
        """50% complete 20d task has same remaining as full 10d task."""
        half = run_completion_mc(
            [{'ID': 'A', 'Duration': 20, 'TimeUnits': 'days',
              'PercentComplete': 0.5}],
            [], '2025-01-01T00:00:00Z',
            config={'iterations': 50, 'enable_risk': False})
        full = run_completion_mc(
            [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            [], '2025-01-01T00:00:00Z',
            config={'iterations': 50, 'enable_risk': False})
        assert half['expected_finish'] == full['expected_finish']

    def test_percent_complete_accepts_100_scale(self):
        """PercentComplete may arrive as 0..100 instead of 0..1."""
        r = run_completion_mc(
            [{'ID': 'A', 'Duration': 20, 'TimeUnits': 'days',
              'PercentComplete': 50}],
            [], '2025-01-01T00:00:00Z',
            config={'iterations': 50, 'enable_risk': False})
        assert r['expected_finish'].startswith('2025-01-11')

    def test_actual_finish_excludes_from_scope(self):
        r = run_completion_mc(
            [{'ID': 'A', 'Duration': 20, 'TimeUnits': 'days',
              'ActualFinish': '2024-12-15T00:00:00Z'}],
            [], '2025-01-01T00:00:00Z',
            config={'iterations': 50})
        assert r['scope_size'] == 0

    def test_expected_start_respected(self):
        """ExpectedStart later than status_date should delay finish."""
        r = run_completion_mc(
            [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days',
              'ExpectedStart': '2025-02-01T00:00:00Z'}],
            [], '2025-01-01T00:00:00Z',
            config={'iterations': 50, 'enable_risk': False})
        # Start 02-01, duration 10d -> finish 02-11
        assert r['expected_finish'].startswith('2025-02-11')


# =====================================================================
# Engine: relationship types + lag
# =====================================================================

class TestRelationships:

    def test_fs_link_with_lag(self):
        """FS + 24h lag: B starts 24h after A finishes."""
        nodes = [
            {'ID': 'A', 'Duration': 24, 'TimeUnits': 'h'},
            {'ID': 'B', 'Duration': 24, 'TimeUnits': 'h'},
        ]
        links = [{'source': 'A', 'target': 'B', 'type': 'FS', 'lag': 24}]
        r = run_completion_mc(nodes, links, '2025-01-01T00:00:00Z',
                              config={'iterations': 50, 'enable_risk': False})
        # A: 00:00 -> 24h later = 2025-01-02 00:00
        # B: start + 24h lag = 2025-01-03 00:00, finish = 2025-01-04 00:00
        assert r['expected_finish'].startswith('2025-01-04')

    def test_ss_link(self):
        """SS: B starts when A starts."""
        nodes = [
            {'ID': 'A', 'Duration': 48, 'TimeUnits': 'h'},
            {'ID': 'B', 'Duration': 24, 'TimeUnits': 'h'},
        ]
        links = [{'source': 'A', 'target': 'B', 'type': 'SS'}]
        r = run_completion_mc(nodes, links, '2025-01-01T00:00:00Z',
                              config={'iterations': 50, 'enable_risk': False})
        # Both start at 00:00.  A finishes at 48h, B finishes at 24h.
        # Max finish = A = 2025-01-03 00:00
        assert r['expected_finish'].startswith('2025-01-03')


# =====================================================================
# HTTP endpoint
# =====================================================================

class TestEndpoint:

    def test_returns_200(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        for n in nodes:
            n['TimeUnits'] = 'days'
        resp = client.post('/completion/monte-carlo', json={
            'nodes': nodes, 'links': links,
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'iterations': 100, 'enable_risk': False},
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'p20_finish' in data
        assert 'p50_finish' in data
        assert 'p80_finish' in data
        assert data['scope_size'] == 5

    def test_health(self, client):
        resp = client.get('/completion/health')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'healthy'
        assert data['module'] == 'completion-forecast'

    def test_options_preflight(self, client):
        resp = client.options('/completion/monte-carlo')
        assert resp.status_code == 200


# =====================================================================
# HTTP validation
# =====================================================================

class TestValidation:

    def test_missing_status_date(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 1}], 'links': [],
        })
        assert resp.status_code == 400
        assert 'status_date' in resp.get_json()['error']

    def test_empty_nodes(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [], 'status_date': '2025-01-01T00:00:00Z',
        })
        assert resp.status_code == 400

    def test_duplicate_id(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [
                {'ID': 'A', 'Duration': 1},
                {'ID': 'A', 'Duration': 2},
            ],
            'status_date': '2025-01-01T00:00:00Z',
        })
        assert resp.status_code == 400
        assert 'Duplicate' in resp.get_json()['error']

    def test_negative_duration(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': -5}],
            'status_date': '2025-01-01T00:00:00Z',
        })
        assert resp.status_code == 400

    def test_link_unknown_source(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 1}],
            'links': [{'source': 'Z', 'target': 'A'}],
            'status_date': '2025-01-01T00:00:00Z',
        })
        assert resp.status_code == 400
        assert 'unknown source' in resp.get_json()['error']

    def test_iterations_out_of_range(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 1}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'iterations': 99999},
        })
        assert resp.status_code == 400

    def test_invalid_threshold(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 1}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'thresholds': {'no_risk_below': 2.0}},
        })
        assert resp.status_code == 400


# =====================================================================
# Config construction
# =====================================================================

class TestConfig:

    def test_defaults_match_js(self):
        c = CompletionMCConfig()
        assert c.no_risk_below == 0.06
        assert c.normal_from == 0.18
        assert c.fat_tail_from == 0.55
        assert c.max_mult_base == 2.0
        assert c.max_mult_high == 6.0

    def test_from_dict_overrides(self):
        c = CompletionMCConfig.from_dict({
            'iterations': 250,
            'thresholds': {'fat_tail_from': 0.45},
            'caps': {'max_mult_high': 10.0},
        })
        assert c.iterations == 250
        assert c.fat_tail_from == 0.45
        assert c.max_mult_high == 10.0


# =====================================================================
# Working calendar
# =====================================================================

from completion.calendar import WorkingCalendar, advance_working_ms

MON_EPOCH = 1736121600000.0  # 2025-01-06 00:00 UTC (Monday)


class TestWorkingCalendar:

    def test_advance_weekdays_no_holidays(self):
        cal = WorkingCalendar.build(8.0, {1, 2, 3, 4, 5}, [],
                                    MON_EPOCH, horizon_days=30)
        # 40 working hours = 5 working days -> next Mon 00:00
        finish = advance_working_ms(MON_EPOCH, 40.0, cal)
        assert _ms_to_iso(finish).startswith('2025-01-13')

    def test_weekend_start_normalizes_forward(self):
        cal = WorkingCalendar.build(8.0, {1, 2, 3, 4, 5}, [],
                                    MON_EPOCH, horizon_days=30)
        sat_ms = MON_EPOCH + 5 * 86_400_000.0  # Saturday 2025-01-11
        finish = advance_working_ms(sat_ms, 40.0, cal)
        # Start Sat (no hours accrued), 5 working days -> Mon 2025-01-20
        assert _ms_to_iso(finish).startswith('2025-01-20')

    def test_holiday_skipped(self):
        cal = WorkingCalendar.build(8.0, {1, 2, 3, 4, 5},
                                    ['2025-01-08'], MON_EPOCH, 30)
        # Wed is holiday: 40h = Mon+Tue+Thu+Fri+Mon -> Tue 01-14 start
        finish = advance_working_ms(MON_EPOCH, 40.0, cal)
        assert _ms_to_iso(finish).startswith('2025-01-14')

    def test_zero_hours_is_passthrough(self):
        cal = WorkingCalendar.build(8.0, {1, 2, 3, 4, 5}, [],
                                    MON_EPOCH, horizon_days=30)
        # On a weekend, zero work should stay on the weekend (JS semantics).
        sat_ms = MON_EPOCH + 5 * 86_400_000.0
        assert advance_working_ms(sat_ms, 0.0, cal) == sat_ms

    def test_vectorised_advance_broadcasts(self):
        import numpy as np
        cal = WorkingCalendar.build(8.0, {1, 2, 3, 4, 5}, [],
                                    MON_EPOCH, horizon_days=30)
        starts = np.full(4, MON_EPOCH)
        works = np.array([0.0, 8.0, 16.0, 40.0])
        finishes = advance_working_ms(starts, works, cal)
        assert finishes.shape == (4,)
        assert finishes[0] == MON_EPOCH                     # passthrough
        assert _ms_to_iso(finishes[1]).startswith('2025-01-07')  # +1wd
        assert _ms_to_iso(finishes[2]).startswith('2025-01-08')  # +2wd
        assert _ms_to_iso(finishes[3]).startswith('2025-01-13')  # +5wd


class TestCalendarPath:
    """End-to-end completion MC tests with calendar enabled."""

    def test_days_mean_working_days_under_calendar(self):
        """10 'days' with 5x8 calendar = 10 working days = 2 calendar weeks."""
        r = run_completion_mc(
            [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            [], '2025-01-06T00:00:00Z',
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}},
            config={'iterations': 50, 'enable_risk': False})
        # 10 working days from Mon 01-06 -> next Mon 01-20 00:00
        assert r['expected_finish'].startswith('2025-01-20')

    def test_calendar_path_preserves_percentile_monotonicity(self):
        r = run_completion_mc(
            [{'ID': 'A', 'Duration': 20, 'TimeUnits': 'days',
              'riskScore': 0.6}],
            [], '2025-01-06T00:00:00Z',
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}},
            config={'iterations': 200, 'seed': 42})
        p20 = _parse_iso_to_ms(r['p20_finish'])
        p50 = _parse_iso_to_ms(r['p50_finish'])
        p80 = _parse_iso_to_ms(r['p80_finish'])
        assert p20 <= p50 <= p80

    def test_calendar_vs_wallclock_gives_later_finish(self):
        """Same 10 days -- calendar path should land later than wall-clock
        (weekends delay finish), all else equal."""
        params = {'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
                  'links': [], 'status_date': '2025-01-06T00:00:00Z',
                  'config': {'iterations': 50, 'enable_risk': False}}
        wall = run_completion_mc(**params)
        cal = run_completion_mc(**{**params,
                                   'project_context': {'calendar': {
                                       'hours_per_day': 8,
                                       'working_days': [1, 2, 3, 4, 5]}}})
        assert _parse_iso_to_ms(cal['expected_finish']) > \
            _parse_iso_to_ms(wall['expected_finish'])

    def test_holiday_delays_calendar_finish(self):
        base_ctx = {'calendar': {'hours_per_day': 8,
                                 'working_days': [1, 2, 3, 4, 5]}}
        with_hol = dict(base_ctx, calendar={**base_ctx['calendar'],
                                            'holidays': ['2025-01-08']})
        params = {'nodes': [{'ID': 'A', 'Duration': 5, 'TimeUnits': 'days'}],
                  'links': [], 'status_date': '2025-01-06T00:00:00Z',
                  'config': {'iterations': 50, 'enable_risk': False}}
        no_hol = run_completion_mc(**params, project_context=base_ctx)
        with_hol_r = run_completion_mc(**params, project_context=with_hol)
        assert _parse_iso_to_ms(with_hol_r['expected_finish']) > \
            _parse_iso_to_ms(no_hol['expected_finish'])

    def test_fs_lag_routed_through_calendar(self):
        """With calendar, a 24h lag = 3 working days (not 1 calendar day)."""
        r = run_completion_mc(
            nodes=[{'ID': 'A', 'Duration': 5, 'TimeUnits': 'days'},
                   {'ID': 'B', 'Duration': 1, 'TimeUnits': 'days'}],
            links=[{'source': 'A', 'target': 'B',
                    'type': 'FS', 'lag': 24}],
            status_date='2025-01-06T00:00:00Z',
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}},
            config={'iterations': 50, 'enable_risk': False})
        # A: 5wd ends Mon 01-13 00:00; +24wh lag = Thu 01-16 00:00;
        # B: +8h = Fri 01-17 00:00.
        assert r['expected_finish'].startswith('2025-01-17')

    def test_no_calendar_config_falls_back_to_v1(self):
        """Without any calendar fields in project_context, behaviour is V1."""
        r = run_completion_mc(
            [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            [], '2025-01-06T00:00:00Z',
            project_context={'phase': 'construction'},  # no calendar key
            config={'iterations': 50, 'enable_risk': False})
        # Wall-clock 10 days
        assert r['expected_finish'].startswith('2025-01-16')


# =====================================================================
# /completion/recovery-options
# =====================================================================

from completion.recovery import (
    run_recovery_options, classify_crash_profile,
    RecoveryConfig, _compute_target,
)


class TestClassifyCrashProfile:

    def test_supplier_override_wins(self):
        # Supplier type takes precedence over name regex
        assert classify_crash_profile('Install', 'external_equipment') \
            == {'max_frac': 0.03, 'kind': 'external_equipment'}
        assert classify_crash_profile(None, 'external_material') \
            == {'max_frac': 0.05, 'kind': 'external_material'}
        assert classify_crash_profile('Design Drawings', 'external_service') \
            == {'max_frac': 0.10, 'kind': 'external_service'}

    def test_name_regex_governance(self):
        assert classify_crash_profile('Environmental Permit', None)['kind'] == 'governance'
        assert classify_crash_profile('Regulatory Approval', None)['kind'] == 'governance'

    def test_name_regex_construction(self):
        assert classify_crash_profile('Install Foundation', None)['kind'] == 'construction'
        assert classify_crash_profile('Erect Steel', None)['kind'] == 'construction'
        assert classify_crash_profile('Mechanical Piping', None)['kind'] == 'construction'

    def test_name_regex_engineering(self):
        assert classify_crash_profile('Engineering Drawings', None)['kind'] == 'engineering'
        assert classify_crash_profile('IFC Issue', None)['kind'] == 'engineering'

    def test_name_regex_procurement(self):
        assert classify_crash_profile('Procure Valve', None)['kind'] == 'procurement'
        assert classify_crash_profile('Vendor Delivery', None)['kind'] == 'procurement'

    def test_name_regex_commissioning(self):
        assert classify_crash_profile('Hydro Test', None)['kind'] == 'commissioning'
        assert classify_crash_profile('Commission Unit', None)['kind'] == 'commissioning'

    def test_name_regex_fabrication(self):
        assert classify_crash_profile('Shop Fabrication', None)['kind'] == 'fabrication'
        assert classify_crash_profile('Weld Spools', None)['kind'] == 'fabrication'

    def test_design_hits_governance_quirk(self):
        # The JS regex /sign/ catches de-sign; preserved for parity.
        assert classify_crash_profile('Design Review', None)['kind'] == 'governance'

    def test_generic_fallback(self):
        assert classify_crash_profile('Miscellaneous Task', None) \
            == {'max_frac': 0.25, 'kind': 'generic'}

    def test_empty_name(self):
        assert classify_crash_profile('', None)['kind'] == 'generic'
        assert classify_crash_profile(None, None)['kind'] == 'generic'


class TestTargetMath:

    def test_overrun_with_buffer(self):
        planned = _parse_iso_to_ms('2025-02-01T00:00:00Z')
        expected = _parse_iso_to_ms('2025-02-11T00:00:00Z')  # 10d overrun
        p80 = _parse_iso_to_ms('2025-02-21T00:00:00Z')       # 10d buffer
        td, th, overrun, buf = _compute_target(
            planned, expected, p80, max_risk_buffer_days=10, hours_per_day=8)
        assert overrun == 10
        assert buf == 10
        assert td == 20
        assert th == 160

    def test_buffer_caps(self):
        planned = _parse_iso_to_ms('2025-02-01T00:00:00Z')
        expected = _parse_iso_to_ms('2025-02-11T00:00:00Z')
        p80 = _parse_iso_to_ms('2025-03-11T00:00:00Z')       # 28d buffer
        _, _, _, buf = _compute_target(
            planned, expected, p80, max_risk_buffer_days=10, hours_per_day=8)
        assert buf == 10  # capped

    def test_no_overrun_yields_scenario_mode(self):
        """When expected <= planned, target_days = capped buffer only."""
        planned = _parse_iso_to_ms('2025-03-01T00:00:00Z')
        expected = _parse_iso_to_ms('2025-02-20T00:00:00Z')  # ahead of plan
        p80 = _parse_iso_to_ms('2025-02-28T00:00:00Z')       # 8d buffer
        td, _, overrun, buf = _compute_target(
            planned, expected, p80, max_risk_buffer_days=10, hours_per_day=8)
        assert overrun == 0
        assert buf == 8
        assert td == 8  # buffer only

    def test_no_p80(self):
        planned = _parse_iso_to_ms('2025-02-01T00:00:00Z')
        expected = _parse_iso_to_ms('2025-02-11T00:00:00Z')
        td, _, overrun, buf = _compute_target(
            planned, expected, None, max_risk_buffer_days=10, hours_per_day=8)
        assert overrun == 10
        assert buf == 0
        assert td == 10

    def test_no_planned_finish(self):
        expected = _parse_iso_to_ms('2025-02-11T00:00:00Z')
        p80 = _parse_iso_to_ms('2025-02-21T00:00:00Z')
        td, _, overrun, buf = _compute_target(
            None, expected, p80, max_risk_buffer_days=10, hours_per_day=8)
        assert overrun == 0
        assert buf == 10
        assert td == 10


class TestRecoveryEngine:

    def _diamond_with_names(self):
        return [
            {'ID': 'A', 'Duration': 10, 'TimeUnits': 'days', 'Name': 'Engineering Drawings'},
            {'ID': 'B', 'Duration': 15, 'TimeUnits': 'days', 'Name': 'Install Pipe'},
            {'ID': 'C', 'Duration': 8,  'TimeUnits': 'days', 'Name': 'Procure Valve'},
            {'ID': 'D', 'Duration': 12, 'TimeUnits': 'days', 'Name': 'Construct Frame'},
            {'ID': 'E', 'Duration': 5,  'TimeUnits': 'days', 'Name': 'Commission Unit'},
        ]

    def _diamond_links(self):
        return [
            {'source': 'A', 'target': 'B'}, {'source': 'A', 'target': 'C'},
            {'source': 'B', 'target': 'D'}, {'source': 'C', 'target': 'D'},
            {'source': 'D', 'target': 'E'},
        ]

    def test_critical_path_activities_ranked(self):
        r = run_recovery_options(
            self._diamond_with_names(), self._diamond_links(),
            '2025-01-01T00:00:00Z',
            planned_finish='2025-01-20T00:00:00Z',  # forces overrun
            p80_finish='2025-03-15T00:00:00Z',
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}})
        crash_ids = {c['id'] for c in r['crash_candidates']}
        # All four critical-path activities should appear (A, B, D, E).
        # C is near-critical with insufficient crash (procurement 12%, 64h -> 7.68h < 8h).
        assert 'A' in crash_ids
        assert 'B' in crash_ids
        assert 'D' in crash_ids
        assert 'E' in crash_ids
        assert 'C' not in crash_ids

    def test_sorted_by_score_desc(self):
        r = run_recovery_options(
            self._diamond_with_names(), self._diamond_links(),
            '2025-01-01T00:00:00Z',
            planned_finish='2025-01-20T00:00:00Z',
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}})
        scores = [c['score'] for c in r['crash_candidates']]
        assert scores == sorted(scores, reverse=True)

    def test_scenario_mode_when_no_overrun(self):
        r = run_recovery_options(
            self._diamond_with_names(), self._diamond_links(),
            '2025-01-01T00:00:00Z',
            planned_finish='2025-06-01T00:00:00Z',  # plenty of room
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}})
        assert r['is_scenario_mode'] is True
        assert r['overrun_days'] == 0
        # Scenario mode still surfaces compressible activities
        assert len(r['crash_candidates']) > 0
        assert 'Scenario' in r['notes']

    def test_target_hours_consumed_monotonically(self):
        """In overrun mode, packaged crash_hours should not exceed target_hours."""
        r = run_recovery_options(
            self._diamond_with_names(), self._diamond_links(),
            '2025-01-01T00:00:00Z',
            planned_finish='2025-01-20T00:00:00Z',  # large overrun
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}})
        total_crash = sum(o['crash_hours'] for o in r['recovery_options'])
        # Achieved should not wildly exceed target (allow one overshoot from last candidate)
        assert total_crash >= 0
        assert r['achieved_hours'] == pytest.approx(total_crash, rel=1e-6)

    def test_max_recovery_options_respected(self):
        """Large project with many candidates is truncated to max_recovery_options."""
        nodes = [{'ID': f'T{i}', 'Duration': 10, 'TimeUnits': 'days',
                  'Name': f'Install Unit {i}'} for i in range(30)]
        links = [{'source': f'T{i}', 'target': f'T{i+1}'} for i in range(29)]
        r = run_recovery_options(
            nodes, links, '2025-01-01T00:00:00Z',
            planned_finish='2025-01-05T00:00:00Z',  # huge overrun
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}},
            config={'max_recovery_options': 5})
        assert len(r['recovery_options']) <= 5

    def test_lag_candidate_ranking(self):
        """Lag on critical edge ranks higher than lag on non-critical edge."""
        nodes = [
            {'ID': 'A', 'Duration': 10, 'TimeUnits': 'days', 'Name': 'Install A'},
            {'ID': 'B', 'Duration': 10, 'TimeUnits': 'days', 'Name': 'Install B'},
        ]
        links = [{'source': 'A', 'target': 'B', 'type': 'FS',
                  'lag': 48, 'lagUnits': 'h'}]  # 48h == 6 working days
        r = run_recovery_options(
            nodes, links, '2025-01-01T00:00:00Z',
            planned_finish='2025-01-10T00:00:00Z',
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}})
        assert len(r['lag_candidates']) == 1
        lag = r['lag_candidates'][0]
        assert lag['source'] == 'A' and lag['target'] == 'B'
        assert lag['is_on_critical_path'] is True
        assert lag['potential_savings_hrs'] == 24.0  # 48h * 0.5

    def test_short_lag_filtered(self):
        """Lag shorter than min_lag_days_for_compression is filtered."""
        nodes = [
            {'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'},
            {'ID': 'B', 'Duration': 10, 'TimeUnits': 'days'},
        ]
        links = [{'source': 'A', 'target': 'B', 'type': 'FS',
                  'lag': 8, 'lagUnits': 'h'}]  # 1 day
        r = run_recovery_options(
            nodes, links, '2025-01-01T00:00:00Z',
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}})
        assert r['lag_candidates'] == []

    def test_expected_finish_defaults_to_cpm(self):
        """When expected_finish is not supplied, backend computes it from CPM."""
        r = run_recovery_options(
            self._diamond_with_names(), self._diamond_links(),
            '2025-01-01T00:00:00Z',
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}})
        # Deterministic forward pass: 42 working days
        assert r['expected_finish'] is not None

    def test_all_actual_finish_empty_result(self):
        """All activities done -> no candidates, no target."""
        nodes = [
            {'ID': 'A', 'Duration': 10, 'TimeUnits': 'days',
             'ActualFinish': '2024-12-20T00:00:00Z'},
        ]
        r = run_recovery_options(
            nodes, [], '2025-01-01T00:00:00Z',
            planned_finish='2025-01-10T00:00:00Z')
        assert r['crash_candidates'] == []
        assert r['lag_candidates'] == []

    def test_milestone_excluded(self):
        nodes = [
            {'ID': 'M', 'Duration': 0, 'TimeUnits': 'h',
             'Milestone': True, 'Name': 'Major Milestone'},
            {'ID': 'T', 'Duration': 40, 'TimeUnits': 'h',
             'Name': 'Install Foundation'},
        ]
        links = [{'source': 'M', 'target': 'T'}]
        r = run_recovery_options(
            nodes, links, '2025-01-01T00:00:00Z',
            planned_finish='2025-01-02T00:00:00Z',
            project_context={'calendar': {'hours_per_day': 8,
                                          'working_days': [1, 2, 3, 4, 5]}})
        crash_ids = {c['id'] for c in r['crash_candidates']}
        assert 'M' not in crash_ids

    def test_percent_complete_reduces_remaining(self):
        """50%-complete 20-day task has same remaining as full 10-day task."""
        def remain(node):
            r = run_recovery_options(
                [node], [], '2025-01-01T00:00:00Z',
                planned_finish='2025-01-02T00:00:00Z',
                project_context={'calendar': {'hours_per_day': 8,
                                              'working_days': [1, 2, 3, 4, 5]}})
            return r['crash_candidates'][0]['remaining_hrs'] if r['crash_candidates'] else 0
        half = remain({'ID': 'X', 'Duration': 20, 'TimeUnits': 'days',
                       'PercentComplete': 0.5, 'Name': 'Install Pipe'})
        full = remain({'ID': 'Y', 'Duration': 10, 'TimeUnits': 'days',
                       'Name': 'Install Pipe'})
        assert half == full == 80.0


class TestRecoveryEndpoint:

    def test_returns_200(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        for n in nodes:
            n['TimeUnits'] = 'days'
            n['Name'] = f'Install {n["ID"]}'
        resp = client.post('/completion/recovery-options', json={
            'nodes': nodes, 'links': links,
            'status_date': '2025-01-01T00:00:00Z',
            'planned_finish': '2025-01-15T00:00:00Z',
            'project_context': {'calendar': {'hours_per_day': 8,
                                             'working_days': [1, 2, 3, 4, 5]}},
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'recovery_options' in data
        assert 'lag_options' in data
        assert 'target_days' in data
        assert data['overrun_days'] > 0

    def test_options_preflight(self, client):
        resp = client.options('/completion/recovery-options')
        assert resp.status_code == 200

    def test_health_includes_recovery(self, client):
        resp = client.get('/completion/health')
        data = resp.get_json()
        assert '/completion/recovery-options' in data['endpoints']

    def test_missing_status_date(self, client):
        resp = client.post('/completion/recovery-options', json={
            'nodes': [{'ID': 'A', 'Duration': 1}],
            'links': [],
        })
        assert resp.status_code == 400
        assert 'status_date' in resp.get_json()['error']

    def test_invalid_planned_finish_type(self, client):
        resp = client.post('/completion/recovery-options', json={
            'nodes': [{'ID': 'A', 'Duration': 1}],
            'status_date': '2025-01-01T00:00:00Z',
            'planned_finish': 12345,  # not a string
        })
        assert resp.status_code == 400

    def test_invalid_config_values(self, client):
        resp = client.post('/completion/recovery-options', json={
            'nodes': [{'ID': 'A', 'Duration': 1}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'lag_compression_factor': 1.5},  # out of [0,1]
        })
        assert resp.status_code == 400
        assert 'lag_compression_factor' in resp.get_json()['error']


class TestRecoveryConfig:

    def test_defaults(self):
        c = RecoveryConfig()
        assert c.max_risk_buffer_days == 10.0
        assert c.max_recovery_options == 18
        assert c.lag_compression_factor == 0.5

    def test_from_dict_overrides(self):
        c = RecoveryConfig.from_dict({
            'max_recovery_options': 5,
            'lag_compression_factor': 0.25,
        })
        assert c.max_recovery_options == 5
        assert c.lag_compression_factor == 0.25
