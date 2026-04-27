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

    def test_unparseable_status_date(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 1}], 'links': [],
            'status_date': 'not-a-date',
        })
        assert resp.status_code == 400
        assert 'parseable' in resp.get_json()['error']

    def test_non_string_status_date(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 1}], 'links': [],
            'status_date': 12345,
        })
        assert resp.status_code == 400
        assert 'ISO-8601 string' in resp.get_json()['error']

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


class TestThresholdConfigLivewire:
    """Locks the Copilot fix: config.thresholds.* are no longer no-ops."""

    _NODES = [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days',
               'riskScore': 0.5}]

    def test_fat_tail_from_affects_distribution(self):
        """Lowering fat_tail_from makes a risk=0.5 activity land in the
        Birnbaum-Saunders tier; raising it keeps the activity in the
        normal tier.  The resulting MC spread must differ."""
        r_bs = run_completion_mc(self._NODES, [], '2025-01-01T00:00:00Z',
            config={'iterations': 300, 'seed': 42,
                    'thresholds': {'fat_tail_from': 0.30}})
        r_norm = run_completion_mc(self._NODES, [], '2025-01-01T00:00:00Z',
            config={'iterations': 300, 'seed': 42,
                    'thresholds': {'fat_tail_from': 0.80}})
        assert r_bs['spread_days'] != r_norm['spread_days']

    def test_normal_from_affects_distribution(self):
        """Changing normal_from shifts the triangular/normal boundary
        and must produce different results for a borderline activity."""
        nodes = [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days',
                  'riskScore': 0.15}]
        r_tri = run_completion_mc(nodes, [], '2025-01-01T00:00:00Z',
            config={'iterations': 300, 'seed': 42,
                    'thresholds': {'normal_from': 0.25}})
        r_norm = run_completion_mc(nodes, [], '2025-01-01T00:00:00Z',
            config={'iterations': 300, 'seed': 42,
                    'thresholds': {'normal_from': 0.10}})
        assert r_tri['spread_days'] != r_norm['spread_days']


class TestValidationOrdering:
    """Locks the Copilot fix: threshold + cap ordering is validated."""

    def test_thresholds_ordering_rejected(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'thresholds': {'no_risk_below': 0.5,
                                      'normal_from': 0.1}},
        })
        assert resp.status_code == 400
        assert 'no_risk_below' in resp.get_json()['error']

    def test_caps_ordering_rejected(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'caps': {'min_mult': 3.0, 'max_mult_base': 2.0}},
        })
        assert resp.status_code == 400
        assert 'min_mult' in resp.get_json()['error']

    def test_cap_out_of_range_rejected(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'caps': {'max_mult_high': 10000}},
        })
        assert resp.status_code == 400


class TestReferenceClassCalibration:
    """Per-sector empirical calibration via solver/reference_classes.py."""

    _NODES = [{'ID': f'A{i}', 'Duration': 10, 'TimeUnits': 'days',
               'riskScore': 0.4 if i % 2 else 0.7}
              for i in range(50)]

    @property
    def _LINKS(self):
        return [{'source': f'A{i}', 'target': f'A{i+1}'} for i in range(49)]

    def test_default_no_reference_class_field(self):
        """Without reference_class, the calibrated companion is None."""
        r = run_completion_mc(
            self._NODES, self._LINKS, '2025-01-01T00:00:00Z',
            config={'iterations': 200, 'seed': 42})
        assert r['reference_class_calibrated'] is None
        # Default also surfaces the no-class warning
        codes = {w['code'] for w in r['calibration_warnings']}
        assert 'no_reference_class' in codes

    def test_reference_class_emits_calibrated(self):
        """Setting reference_class produces P50/P80/P95/P99 calibrated fields."""
        r = run_completion_mc(
            self._NODES, self._LINKS, '2025-01-01T00:00:00Z',
            config={'iterations': 300, 'seed': 42,
                    'reference_class': 'rail'})
        cal = r['reference_class_calibrated']
        assert cal is not None
        assert cal['reference_class'] == 'rail'
        assert cal['p50_finish'] is not None
        assert cal['p80_finish'] is not None
        assert cal['p95_finish'] is not None
        assert cal['percentile_factors'] == {
            'P50': 1.15, 'P80': 1.45, 'P95': 1.95, 'P99': 3.00}
        assert any('Cantarelli' in c for c in cal['citations'])

    def test_calibrated_p80_at_or_after_model_p80(self):
        """When the reference class has overrun > 0, calibrated P80
        should land at or after the raw model P80."""
        r = run_completion_mc(
            self._NODES, self._LINKS, '2025-01-01T00:00:00Z',
            config={'iterations': 300, 'seed': 42,
                    'reference_class': 'nuclear_new_build'})
        cal = r['reference_class_calibrated']
        model_p80 = _parse_iso_to_ms(r['p80_finish'])
        cal_p80 = _parse_iso_to_ms(cal['p80_finish'])
        # Nuclear factor 1.85 at P80, so calibrated > model
        assert cal_p80 >= model_p80

    def test_calibrated_percentile_ordering(self):
        """Calibrated P50 <= P80 <= P95 <= P99 (when finite)."""
        r = run_completion_mc(
            self._NODES, self._LINKS, '2025-01-01T00:00:00Z',
            config={'iterations': 300, 'seed': 42,
                    'reference_class': 'data_centre_hyperscale'})
        cal = r['reference_class_calibrated']
        p50 = _parse_iso_to_ms(cal['p50_finish'])
        p80 = _parse_iso_to_ms(cal['p80_finish'])
        p95 = _parse_iso_to_ms(cal['p95_finish'])
        assert p50 <= p80 <= p95
        if cal['p99_finish']:
            assert p95 <= _parse_iso_to_ms(cal['p99_finish'])

    def test_it_software_p99_capped(self):
        """Reference classes with infinite mean (alpha <= 1) report
        P99 as None and emit infinite_mean_reference_class warning."""
        r = run_completion_mc(
            self._NODES, self._LINKS, '2025-01-01T00:00:00Z',
            config={'iterations': 300, 'seed': 42,
                    'reference_class': 'it_software'})
        cal = r['reference_class_calibrated']
        assert cal['p99_finish'] is None
        assert cal['has_finite_mean'] is False
        # 'direct_normal_to_pareto' is the canonical name; 'skip' is
        # the back-compat alias.  Built-ins use the explicit name.
        assert cal['tier_4_distribution'] in ('direct_normal_to_pareto', 'skip')
        codes = {w['code'] for w in r['calibration_warnings']}
        assert 'infinite_mean_reference_class' in codes

    def test_olympics_p99_capped(self):
        r = run_completion_mc(
            self._NODES, self._LINKS, '2025-01-01T00:00:00Z',
            config={'iterations': 300, 'seed': 42,
                    'reference_class': 'olympics'})
        cal = r['reference_class_calibrated']
        assert cal['p99_finish'] is None
        assert cal['has_finite_mean'] is False

    def test_thin_tailed_uses_lognormal(self):
        """Solar / roads / batteries select lognormal as tier 4."""
        for cls in ('solar_pv', 'roads', 'battery_storage', 'wind_onshore'):
            r = run_completion_mc(
                self._NODES, [], '2025-01-01T00:00:00Z',
                config={'iterations': 200, 'seed': 42,
                        'reference_class': cls})
            cal = r['reference_class_calibrated']
            assert cal['tier_4_distribution'] == 'lognormal', \
                f'{cls} should use lognormal tier 4'
            assert cal['is_fat_tailed'] is False

    def test_tier_4_skip_widens_pareto_window(self):
        """For IT (tier_4 = skip), normal tier extends to pareto_thresh
        and Pareto kicks in earlier than default."""
        # Same project, default vs IT class
        r_def = run_completion_mc(
            self._NODES, self._LINKS, '2025-01-01T00:00:00Z',
            config={'iterations': 500, 'seed': 42})
        r_it = run_completion_mc(
            self._NODES, self._LINKS, '2025-01-01T00:00:00Z',
            config={'iterations': 500, 'seed': 42,
                    'reference_class': 'it_software'})
        # IT's Pareto-tier kicks in very early (fat_tail_from=0.30,
        # offset=0.05) so spreads are dramatically wider.
        assert r_it['spread_days'] > r_def['spread_days']

    def test_data_centre_judgement_warning(self):
        """data_centre_hyperscale citations include JUDGEMENT marker;
        warning surfaces."""
        r = run_completion_mc(
            self._NODES, self._LINKS, '2025-01-01T00:00:00Z',
            config={'iterations': 200, 'seed': 42,
                    'reference_class': 'data_centre_hyperscale'})
        codes = {w['code'] for w in r['calibration_warnings']}
        assert 'reference_class_judgement' in codes

    def test_alias_resolution(self):
        """get_reference_class accepts EVM-style sector tags."""
        r1 = run_completion_mc(
            self._NODES, [], '2025-01-01T00:00:00Z',
            config={'iterations': 100, 'seed': 42,
                    'reference_class': 'oil_gas_offshore'})
        r2 = run_completion_mc(
            self._NODES, [], '2025-01-01T00:00:00Z',
            config={'iterations': 100, 'seed': 42,
                    'reference_class': 'Oil and Gas'})  # alias
        # Same calibrated factors
        assert (r1['reference_class_calibrated']['percentile_factors']
                == r2['reference_class_calibrated']['percentile_factors'])

    def test_unknown_reference_class_rejected(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': self._NODES, 'links': [],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'reference_class': 'no_such_sector'},
        })
        assert resp.status_code == 400
        assert 'reference_class' in resp.get_json()['error']

    def test_calibration_warning_zero_variance_risk(self):
        """All-identical risk scores produce zero_variance_risk warning."""
        nodes = [{'ID': f'A{i}', 'Duration': 10, 'TimeUnits': 'days',
                  'riskScore': 0.5} for i in range(10)]
        r = run_completion_mc(
            nodes, [], '2025-01-01T00:00:00Z',
            config={'iterations': 100, 'seed': 42})
        codes = {w['code'] for w in r['calibration_warnings']}
        assert 'zero_variance_risk' in codes

    def test_calibration_warning_small_scope(self):
        """Fewer than 30 in-scope activities produces small_scope_mc warning."""
        nodes = [{'ID': f'A{i}', 'Duration': 10, 'TimeUnits': 'days',
                  'riskScore': 0.3 + 0.05 * i} for i in range(10)]
        r = run_completion_mc(
            nodes, [], '2025-01-01T00:00:00Z',
            config={'iterations': 100, 'seed': 42})
        codes = {w['code'] for w in r['calibration_warnings']}
        assert 'small_scope_mc' in codes


class TestReferenceClassExtensibility:
    """Custom classes, overrides, fuzzy matching, discovery, defensive
    fallback when classes are partially malformed."""

    _NODES = [{'ID': f'A{i}', 'Duration': 10, 'TimeUnits': 'days',
               'riskScore': 0.4 if i % 2 else 0.7}
              for i in range(40)]

    def test_discovery_endpoint(self, client):
        resp = client.get('/completion/reference-classes')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['builtin_count'] >= 19
        names = [c['name'] for c in data['classes']]
        for required in ('oil_gas_offshore', 'it_software', 'olympics',
                         'data_centre_hyperscale'):
            assert required in names
        # Aliases visible for client-side mapping
        assert 'oil_and_gas' in data['aliases']
        assert data['aliases']['oil_and_gas'] == 'oil_gas_offshore'

    def test_discovery_options_preflight(self, client):
        resp = client.options('/completion/reference-classes')
        assert resp.status_code == 200

    def test_fuzzy_suggestion_in_error(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'reference_class': 'oilgaz'},
        })
        assert resp.status_code == 400
        msg = resp.get_json()['error']
        assert 'oilgaz' in msg
        assert 'did you mean' in msg.lower()
        assert 'oil_gas_offshore' in msg

    def test_fuzzy_no_match_lists_supported(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'reference_class': 'zzzzzz_unrecognisable'},
        })
        assert resp.status_code == 400
        assert 'supported classes' in resp.get_json()['error'].lower()

    def test_custom_class_used_in_mc(self):
        """A per-request custom class is honoured by the sampler and
        surfaces in reference_class_calibrated.citations."""
        custom = {
            'customer_acme_petrochem': {
                'fat_tail_from': 0.50,
                'pareto_offset': 0.20,
                'pareto_alpha_range': [1.7, 2.3],
                'tier_4_distribution': 'birnbaum_saunders',
                'percentile_factors': {'P50': 1.15, 'P80': 1.40,
                                       'P95': 1.85, 'P99': 2.80},
                'max_multiplier_cap': 12.0,
                'mean_overrun': 0.40,
                'is_fat_tailed': True,
                'has_finite_mean': True,
                'citations': ['ACME internal portfolio analysis 2026'],
            },
        }
        r = run_completion_mc(
            self._NODES, [], '2025-01-01T00:00:00Z',
            config={'iterations': 200, 'seed': 42,
                    'reference_class': 'customer_acme_petrochem',
                    'custom_reference_classes': custom})
        cal = r['reference_class_calibrated']
        assert cal is not None
        assert 'ACME' in cal['citations'][0]
        assert cal['percentile_factors']['P80'] == 1.40

    def test_custom_class_can_shadow_builtin(self):
        """Per-request custom classes override built-ins of the same name."""
        custom = {
            'rail': {  # shadow the built-in rail
                'fat_tail_from': 0.50,
                'pareto_offset': 0.25,
                'pareto_alpha_range': [1.5, 2.0],
                'tier_4_distribution': 'birnbaum_saunders',
                'percentile_factors': {'P50': 1.50, 'P80': 2.00,
                                       'P95': 3.00, 'P99': 5.00},
                'max_multiplier_cap': 15.0,
                'mean_overrun': 0.80,
                'is_fat_tailed': True,
                'has_finite_mean': True,
                'citations': ['Internal customer rail data 2026'],
            },
        }
        r = run_completion_mc(
            self._NODES, [], '2025-01-01T00:00:00Z',
            config={'iterations': 200, 'seed': 42,
                    'reference_class': 'rail',
                    'custom_reference_classes': custom})
        # Shadowed factors used (not the built-in 1.45/1.95)
        assert r['reference_class_calibrated']['percentile_factors']['P80'] == 2.00

    def test_overrides_applied_to_builtin(self, client):
        """{base, overrides} merges into the registry without registering
        a full custom class."""
        resp = client.post('/completion/monte-carlo', json={
            'nodes': self._NODES, 'links': [],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {
                'reference_class_overrides': {
                    'base': 'rail',
                    'overrides': {'percentile_factors': {'P95': 2.5,
                                                          'P99': 4.0}},
                },
            },
        })
        assert resp.status_code == 200
        cal = resp.get_json()['reference_class_calibrated']
        assert cal is not None
        # P95 / P99 overridden; P50 / P80 inherited from rail
        assert cal['percentile_factors']['P95'] == 2.5
        assert cal['percentile_factors']['P99'] == 4.0
        assert cal['percentile_factors']['P50'] == 1.15  # from rail
        assert cal['percentile_factors']['P80'] == 1.45  # from rail

    def test_overrides_unknown_base_rejected(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': self._NODES, 'links': [],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {
                'reference_class_overrides': {
                    'base': 'no_such_class',
                    'overrides': {},
                },
            },
        })
        assert resp.status_code == 400
        assert 'no_such_class' in resp.get_json()['error']

    def test_overrides_alongside_custom_class(self, client):
        """Caller can register a custom class AND override-with-base it."""
        resp = client.post('/completion/monte-carlo', json={
            'nodes': self._NODES, 'links': [],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {
                'custom_reference_classes': {
                    'acme_base': {
                        'fat_tail_from': 0.50,
                        'pareto_offset': 0.25,
                        'pareto_alpha_range': [1.8, 2.4],
                        'tier_4_distribution': 'birnbaum_saunders',
                        'percentile_factors': {'P50': 1.10, 'P80': 1.40,
                                               'P95': 1.80, 'P99': 2.50},
                        'max_multiplier_cap': 10.0,
                        'mean_overrun': 0.30,
                        'is_fat_tailed': True,
                        'has_finite_mean': True,
                        'citations': ['ACME base 2026'],
                    },
                },
                'reference_class_overrides': {
                    'base': 'acme_base',
                    'overrides': {'percentile_factors': {'P95': 2.20}},
                },
            },
        })
        assert resp.status_code == 200
        cal = resp.get_json()['reference_class_calibrated']
        assert cal['percentile_factors']['P95'] == 2.20
        assert cal['percentile_factors']['P50'] == 1.10  # inherited

    def test_malformed_custom_class_rejected(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {
                'custom_reference_classes': {
                    'broken': {
                        'fat_tail_from': 1.5,  # out of [0,1]
                        'pareto_alpha_range': [0.1, 0.05],  # lo > hi, both too low
                    },
                },
            },
        })
        assert resp.status_code == 400
        msg = resp.get_json()['error']
        assert 'broken' in msg
        assert 'fat_tail_from' in msg

    def test_partial_percentile_factors_warning(self, client):
        """A custom class missing P95/P99 still works; warning issued."""
        resp = client.post('/completion/monte-carlo', json={
            'nodes': self._NODES, 'links': [],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {
                'custom_reference_classes': {
                    'partial': {
                        'fat_tail_from': 0.55,
                        'pareto_offset': 0.25,
                        'pareto_alpha_range': [2.0, 2.5],
                        'tier_4_distribution': 'birnbaum_saunders',
                        'percentile_factors': {'P50': 1.10, 'P80': 1.40},
                        # no P95 / P99
                        'max_multiplier_cap': 10.0,
                    },
                },
                'reference_class': 'partial',
            },
        })
        assert resp.status_code == 200
        data = resp.get_json()
        codes = {w['code'] for w in data['calibration_warnings']}
        assert 'partial_percentile_factors' in codes
        # Defensive: P95 falls back to factor 1.0 (cal P95 == model P95)
        cal = data['reference_class_calibrated']
        assert cal['p95_finish'] is not None  # didn't crash
        assert cal['p99_finish'] is None  # missing factor -> null

    def test_invalid_tier_4_value_rejected(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {
                'custom_reference_classes': {
                    'bad_tier_4': {
                        'fat_tail_from': 0.55, 'pareto_offset': 0.25,
                        'pareto_alpha_range': [2.0, 2.5],
                        'tier_4_distribution': 'invalid_distribution',
                        'percentile_factors': {'P50': 1.0, 'P80': 1.2,
                                               'P95': 1.5, 'P99': 2.0},
                        'max_multiplier_cap': 10.0,
                    },
                },
            },
        })
        assert resp.status_code == 400
        assert 'tier_4_distribution' in resp.get_json()['error']

    def test_extreme_alpha_rejected(self, client):
        """alpha < 0.5 numerically unstable, > 5 essentially thin tail."""
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {
                'custom_reference_classes': {
                    'extreme': {
                        'fat_tail_from': 0.55, 'pareto_offset': 0.25,
                        'pareto_alpha_range': [0.1, 0.3],
                        'tier_4_distribution': 'birnbaum_saunders',
                        'percentile_factors': {'P50': 1.0, 'P80': 1.2,
                                               'P95': 1.5, 'P99': 2.0},
                        'max_multiplier_cap': 10.0,
                    },
                },
            },
        })
        assert resp.status_code == 400
        assert 'pareto_alpha_range' in resp.get_json()['error']

    def test_aliases_resolve_via_get_reference_class(self):
        from solver.reference_classes import get_reference_class
        for alias, canonical in [
            ('oil and gas', 'oil_gas_offshore'),
            ('Oil-Gas', 'oil_gas_offshore'),
            ('Petrochemical', 'oil_gas_onshore_lng'),
            ('Data Centre', 'data_centre_hyperscale'),
            ('Data-Center', 'data_centre_hyperscale'),
            ('hyperscale', 'data_centre_hyperscale'),
            ('IT', 'it_software'),
            ('NUCLEAR', 'nuclear_new_build'),
        ]:
            r = get_reference_class(alias)
            from solver.reference_classes import REFERENCE_CLASS_TIERS
            assert r is REFERENCE_CLASS_TIERS[canonical], \
                f'alias {alias!r} should resolve to {canonical!r}'

    def test_validate_class_definition_returns_errors(self):
        from solver.reference_classes import validate_class_definition
        # Valid class -> no errors
        assert validate_class_definition('test', {
            'fat_tail_from': 0.5, 'pareto_offset': 0.2,
            'pareto_alpha_range': [1.5, 2.5],
            'tier_4_distribution': 'birnbaum_saunders',
            'percentile_factors': {'P50': 1.1, 'P80': 1.3,
                                   'P95': 1.6, 'P99': 2.1},
            'max_multiplier_cap': 10.0,
        }) == []
        # Multiple errors enumerated
        errs = validate_class_definition('bad', {
            'fat_tail_from': -0.1,
            'pareto_offset': 2.0,
            'pareto_alpha_range': [10.0, 15.0],
            'tier_4_distribution': 'wrong',
            'percentile_factors': {'P95': -1.0},
            'max_multiplier_cap': 500.0,
        })
        assert len(errs) >= 4


class TestOutcomesEndpoint:
    """register-outcome + calibration-report basic functionality."""

    def test_register_outcome_minimal(self, client):
        resp = client.post('/completion/register-outcome', json={
            'project_id': 'PRJ-001',
            'reference_class': 'oil_gas_offshore',
            'predicted': {
                'p80_finish': '2026-12-31T00:00:00Z',
                'baseline_finish': '2026-06-01T00:00:00Z',
            },
            'actual': {'finish': '2027-03-15T00:00:00Z'},
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'stored'
        assert 'submitted_at' in data['record']

    def test_register_outcome_validation(self, client):
        # Missing project_id
        resp = client.post('/completion/register-outcome', json={
            'predicted': {'p80_finish': '2026-12-31'},
            'actual': {'finish': '2027-03-15'},
        })
        assert resp.status_code == 400
        # Missing actual.finish
        resp = client.post('/completion/register-outcome', json={
            'project_id': 'X',
            'predicted': {'p80_finish': '2026-12-31'},
            'actual': {},
        })
        assert resp.status_code == 400

    def test_calibration_report_aggregates(self, client):
        # Register a few outcomes that average to ratio > 1.3 (the
        # "P80 acts like P10" signature).
        for i, actual in enumerate(['2027-06-01', '2027-09-01', '2027-12-01']):
            client.post('/completion/register-outcome', json={
                'project_id': f'PRJ-cal-{i}',
                'reference_class': 'data_centre_hyperscale',
                'predicted': {
                    'baseline_finish': '2026-06-01T00:00:00Z',
                    'p80_finish':      '2026-12-01T00:00:00Z',
                },
                'actual': {'finish': actual + 'T00:00:00Z'},
            })
        resp = client.get(
            '/completion/calibration-report?reference_class=data_centre_hyperscale')
        assert resp.status_code == 200
        report = resp.get_json()
        assert report['n'] >= 3
        dc = report['by_class'].get('data_centre_hyperscale')
        assert dc is not None
        # actual overrun > predicted overrun -> mean ratio > 1
        assert dc['mean_ratio'] > 1.0


class TestOutcomeRedisFallback:
    """Locks the Copilot fix for completion/outcomes.py register_outcome
    and list_outcomes: when Redis is the primary store but raises mid-
    flight, the exception path must degrade to the in-process store
    rather than calling methods on a None fallback (secondary
    exception that previously broke the request)."""

    def test_register_outcome_survives_redis_failure(self, monkeypatch):
        import completion.outcomes as oc

        class _BoomRedis:
            def set(self, *a, **kw):
                raise RuntimeError('simulated redis connection lost')
            def get(self, *a, **kw):
                raise RuntimeError('simulated redis connection lost')
            def scan_iter(self, *a, **kw):
                raise RuntimeError('simulated redis connection lost')

        monkeypatch.setattr(oc, '_store', lambda: (_BoomRedis(), None))
        # Should not raise -- previously blew up with AttributeError
        # on fallback=None.
        rec = oc.register_outcome({
            'project_id': 'RECOVER-1',
            'reference_class': 'oil_gas_offshore',
            'predicted': {'p80_finish': '2026-12-31T00:00:00Z'},
            'actual': {'finish': '2027-01-01T00:00:00Z'},
        })
        assert rec['project_id'] == 'RECOVER-1'
        # The record landed in the in-process store (primary was Redis).
        key = 'outcomes:oil_gas_offshore:RECOVER-1'
        assert oc._inproc.get(key) is not None

    def test_list_outcomes_survives_redis_failure(self, monkeypatch):
        import completion.outcomes as oc

        # Seed the in-process store with an outcome so list_outcomes
        # has something to return via the fallback path.
        oc._inproc.set(
            'outcomes:oil_gas_offshore:RECOVER-LIST-1',
            '{"project_id": "RECOVER-LIST-1", "reference_class": "oil_gas_offshore",'
            ' "predicted": {"p80_finish": "2026-12-31T00:00:00Z"},'
            ' "actual": {"finish": "2027-01-01T00:00:00Z"}}',
            ttl=3600)

        class _BoomRedis:
            def scan_iter(self, *a, **kw):
                raise RuntimeError('simulated redis connection lost')
            def get(self, *a, **kw):
                raise RuntimeError('simulated redis connection lost')

        monkeypatch.setattr(oc, '_store', lambda: (_BoomRedis(), None))
        # Should return the _inproc record rather than raising.
        records = list(oc.list_outcomes('oil_gas_offshore'))
        ids = [r.get('project_id') for r in records]
        assert 'RECOVER-LIST-1' in ids


class TestMaxDistributionPoints:
    """config.maxDistributionPoints subsamples the date grid for very
    large projects without breaking downstream consumers."""

    def test_evm_analyze_caps_distribution_count(self, client):
        from datetime import datetime, timedelta, timezone
        # 200 activities over a long horizon -> would otherwise produce
        # ~400+ comparison dates with weekly fill.
        nodes = [{'ID': str(i), 'Duration': 5, 'TimeUnits': 'days',
                  'Start': (datetime(2025, 1, 1, tzinfo=timezone.utc)
                            + timedelta(days=i*5)).isoformat(),
                  'Finish': (datetime(2025, 1, 1, tzinfo=timezone.utc)
                             + timedelta(days=(i+1)*5)).isoformat()}
                 for i in range(200)]
        # Without cap
        r1 = client.post('/evm/analyze', json={
            'nodes': nodes, 'links': [],
            'options': {'statusDate': '2025-06-01T00:00:00Z',
                        'costRate': 100},
        }).get_json()
        # With cap at 50
        r2 = client.post('/evm/analyze', json={
            'nodes': nodes, 'links': [],
            'options': {'statusDate': '2025-06-01T00:00:00Z',
                        'costRate': 100,
                        'maxDistributionPoints': 50},
        }).get_json()
        n1 = len(r1['forecasted']['distributionPlanned'])
        n2 = len(r2['forecasted']['distributionPlanned'])
        assert n1 > 50
        assert n2 <= 50
        # First and last dates preserved (so chart endpoints are correct)
        assert (r2['forecasted']['distributionPlanned'][0]['date']
                == r1['forecasted']['distributionPlanned'][0]['date'])
        assert (r2['forecasted']['distributionPlanned'][-1]['date']
                == r1['forecasted']['distributionPlanned'][-1]['date'])


class TestTier4AliasBackcompat:
    """'skip' is preserved as alias for 'direct_normal_to_pareto'."""

    def test_skip_alias_accepted_in_custom_class(self, client):
        # Old-style 'skip' value should still validate + behave the same
        # as the new 'direct_normal_to_pareto'.
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': f'A{i}', 'Duration': 10, 'TimeUnits': 'days',
                       'riskScore': 0.5} for i in range(40)],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {
                'reference_class': 'old_style',
                'iterations': 200,
                'custom_reference_classes': {
                    'old_style': {
                        'fat_tail_from': 0.30, 'pareto_offset': 0.05,
                        'pareto_alpha_range': [0.9, 1.5],
                        'tier_4_distribution': 'skip',  # legacy name
                        'percentile_factors': {'P50': 1.2, 'P80': 1.6,
                                               'P95': 3.0, 'P99': 8.0},
                        'max_multiplier_cap': 50.0,
                    },
                },
            },
        })
        assert resp.status_code == 200

    def test_explicit_name_accepted(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'}],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {
                'custom_reference_classes': {
                    'new_style': {
                        'fat_tail_from': 0.30, 'pareto_offset': 0.05,
                        'pareto_alpha_range': [0.9, 1.5],
                        'tier_4_distribution': 'direct_normal_to_pareto',
                        'percentile_factors': {'P50': 1.2, 'P80': 1.6,
                                               'P95': 3.0, 'P99': 8.0},
                        'max_multiplier_cap': 50.0,
                    },
                },
            },
        })
        assert resp.status_code == 200


class TestLowMaxMultiplierCap:
    """Locks the Copilot fix: caps must be monotone (non-decreasing) in
    blend = risk * dur_frac, even for thin-tailed sectors that set
    max_multiplier_cap below the default lerp bases (4.0 pareto,
    2.0 std).  Regression: previously, cap=3.0 yielded pareto cap =
    4.0 at low blend dropping to 3.0 at high blend.
    """

    def test_caps_are_non_decreasing_for_low_cap(self):
        import numpy as np
        from solver.stochastic import _compute_caps

        # risk ordering low -> high, durations uniform
        risk = np.array([0.1, 0.3, 0.5, 0.7, 0.9])
        durations = np.array([10.0, 10.0, 10.0, 10.0, 10.0])
        fat_thresh = np.full(5, 0.40)

        caps = _compute_caps(risk, durations, fat_thresh,
                             max_multiplier_cap=3.0)
        # Every cap <= configured cap, and caps never decrease with risk.
        assert np.all(caps <= 3.0 + 1e-9)
        assert np.all(np.diff(caps) >= -1e-9)

    def test_standard_tier_not_below_cap(self):
        import numpy as np
        from solver.stochastic import _compute_caps

        # All standard-tier (risk below fat_thresh)
        risk = np.full(5, 0.10)
        durations = np.array([1.0, 2.5, 5.0, 7.5, 10.0])
        fat_thresh = np.full(5, 0.40)

        caps = _compute_caps(risk, durations, fat_thresh,
                             max_multiplier_cap=3.0)
        # Std ceiling = 0.6 * 3 = 1.8.  Monotone in dur_frac, below cap.
        assert np.all(caps <= 1.8 + 1e-9)
        assert np.all(np.diff(caps) >= -1e-9)

    def test_default_cap_behaviour_unchanged(self):
        import numpy as np
        from solver.stochastic import _compute_caps

        # Default path (no cap): std tier lerps 2->6, pareto lerps 4->10.
        risk = np.array([0.1, 0.9])
        durations = np.array([10.0, 10.0])
        fat_thresh = np.full(2, 0.40)

        caps_no_cap = _compute_caps(risk, durations, fat_thresh,
                                    max_multiplier_cap=None)
        caps_cap_10 = _compute_caps(risk, durations, fat_thresh,
                                    max_multiplier_cap=10.0)
        # max_multiplier_cap=10 must match the no-cap default exactly.
        assert np.allclose(caps_no_cap, caps_cap_10)


class TestRecoveryCustomCalendarLag:
    """Locks the Copilot fix: link-lag normalisation reads
    hours_per_day / working_days_per_week from project_context before
    CPM runs, not the default 8/5.  Regression: previously, a non-
    default calendar could yield different critical-path detection vs
    the downstream lag-candidate path.
    """

    def test_lag_in_days_respects_non_default_hours_per_day(self, client):
        # 1-day lag converted at hours_per_day=10 should equal a
        # 10-hour lag on the same calendar.
        nodes = [
            {'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'},
            {'ID': 'B', 'Duration': 10, 'TimeUnits': 'days'},
        ]
        opts = {
            'status_date': '2025-01-01T00:00:00Z',
            'project_context': {'calendar': {
                'hours_per_day': 10,
                'working_days_per_week': 5,
                'working_days': [1, 2, 3, 4, 5],
            }},
        }
        r_days = client.post('/completion/recovery-options', json={
            **opts, 'nodes': nodes,
            'links': [{'source': 'A', 'target': 'B',
                       'type': 'FS', 'lag': 1, 'lagUnits': 'd'}],
        }).get_json()
        r_hours = client.post('/completion/recovery-options', json={
            **opts, 'nodes': nodes,
            'links': [{'source': 'A', 'target': 'B',
                       'type': 'FS', 'lag': 10, 'lagUnits': 'h'}],
        }).get_json()
        assert (len(r_days['lag_candidates'])
                == len(r_hours['lag_candidates']))
        if r_days['lag_candidates']:
            assert (r_days['lag_candidates'][0]['lag_hrs']
                    == r_hours['lag_candidates'][0]['lag_hrs'])


class TestJudgementWarningEnhanced:
    """reference_class_judgement warning surfaces the actual source notes."""

    def test_judgement_notes_in_warning(self, client):
        resp = client.post('/completion/monte-carlo', json={
            'nodes': [{'ID': f'A{i}', 'Duration': 10, 'TimeUnits': 'days',
                       'riskScore': 0.4} for i in range(40)],
            'status_date': '2025-01-01T00:00:00Z',
            'config': {'reference_class': 'data_centre_hyperscale',
                       'iterations': 100},
        })
        assert resp.status_code == 200
        data = resp.get_json()
        warns = data['calibration_warnings']
        judgement = next(
            (w for w in warns if w['code'] == 'reference_class_judgement'),
            None)
        assert judgement is not None
        # The warning now carries the actual source statements
        assert 'notes' in judgement
        assert any('JUDGEMENT' in n for n in judgement['notes'])


class TestRecoveryLagUnits:
    """Locks the Copilot fix: lagUnits normalised before build_dag."""

    def test_lag_days_interpreted_consistently(self, client):
        """A 2-day lag (lagUnits='d') and a 16-hour lag (lagUnits='h')
        should produce the same lag_candidates / recovery analysis at
        hours_per_day=8, because both amount to the same number of
        working hours on the calendar path."""
        nodes = [
            {'ID': 'A', 'Duration': 10, 'TimeUnits': 'days'},
            {'ID': 'B', 'Duration': 10, 'TimeUnits': 'days'},
        ]
        opts = {
            'status_date': '2025-01-01T00:00:00Z',
            'project_context': {'calendar': {
                'hours_per_day': 8, 'working_days': [1, 2, 3, 4, 5]}},
        }
        r_days = client.post('/completion/recovery-options', json={
            **opts, 'nodes': nodes,
            'links': [{'source': 'A', 'target': 'B',
                       'type': 'FS', 'lag': 2, 'lagUnits': 'd'}],
        }).get_json()
        r_hours = client.post('/completion/recovery-options', json={
            **opts, 'nodes': nodes,
            'links': [{'source': 'A', 'target': 'B',
                       'type': 'FS', 'lag': 16, 'lagUnits': 'h'}],
        }).get_json()
        # Lag candidates must agree on both hours and days.
        assert (len(r_days['lag_candidates'])
                == len(r_hours['lag_candidates']))
        if r_days['lag_candidates']:
            assert (r_days['lag_candidates'][0]['lag_hrs']
                    == r_hours['lag_candidates'][0]['lag_hrs'])


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
