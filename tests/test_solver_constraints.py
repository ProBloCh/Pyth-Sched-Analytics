"""
Hard-fail-on-violation gate tests (PR-4).

The existing soft-penalty path returns 200 with ``constraints.{...}.satisfied = False``
when a bound can't be honoured.  A consumer that doesn't read the
constraints block ships a result that violates the bound.  PR-4 adds
an opt-in ``project_context.constraints.fail_on_violation`` flag that
turns the violation into a 409 Conflict response, so a careless
consumer fails closed instead of silently shipping bad numbers.
"""

import pytest

from app import app


@pytest.fixture
def client():
    app.config['TESTING'] = True
    return app.test_client()


def _violating_payload(extra_constraints=None):
    """Chain that takes 33 time units; we'll cap at 25 so the bound is unsatisfiable."""
    constraints = {"max_makespan": 25.0}
    if extra_constraints:
        constraints.update(extra_constraints)
    return {
        "nodes": [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 10},
            {"ID": "2", "Duration": 15},
            {"ID": "3", "Duration": 8},
        ],
        "links": [
            {"source": "0", "target": "1"},
            {"source": "1", "target": "2"},
            {"source": "2", "target": "3"},
        ],
        "solver_config": {"max_iterations": 5},
        "project_context": {"constraints": constraints},
    }


def _feasible_payload(extra_constraints=None):
    """Same chain but cap at 1000 so the bound is trivially satisfied."""
    constraints = {"max_makespan": 1000.0}
    if extra_constraints:
        constraints.update(extra_constraints)
    return {
        "nodes": [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 10},
            {"ID": "2", "Duration": 15},
            {"ID": "3", "Duration": 8},
        ],
        "links": [
            {"source": "0", "target": "1"},
            {"source": "1", "target": "2"},
            {"source": "2", "target": "3"},
        ],
        "solver_config": {"max_iterations": 5},
        "project_context": {"constraints": constraints},
    }


# ---------------------------------------------------------------------------
# Default behaviour: flag absent or false -> existing 200 + satisfied=false
# ---------------------------------------------------------------------------

def test_optimize_violation_without_flag_returns_200(client):
    resp = client.post('/solver/optimize', json=_violating_payload())
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['constraints']['max_makespan']['satisfied'] is False


def test_sensitivity_violation_without_flag_returns_200(client):
    resp = client.post('/solver/sensitivity', json=_violating_payload())
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['constraints']['max_makespan']['satisfied'] is False


def test_optimize_violation_with_flag_false_returns_200(client):
    resp = client.post('/solver/optimize',
                       json=_violating_payload({'fail_on_violation': False}))
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Hard-fail behaviour: flag true + violation -> 409
# ---------------------------------------------------------------------------

def test_optimize_violation_with_flag_returns_409(client):
    resp = client.post('/solver/optimize',
                       json=_violating_payload({'fail_on_violation': True}))
    assert resp.status_code == 409
    body = resp.get_json()
    assert body['error'] == 'constraint_violation'
    assert 'max_makespan' in body['violated']
    assert body['constraints']['max_makespan']['satisfied'] is False


def test_sensitivity_violation_with_flag_returns_409(client):
    resp = client.post('/solver/sensitivity',
                       json=_violating_payload({'fail_on_violation': True}))
    assert resp.status_code == 409
    body = resp.get_json()
    assert body['error'] == 'constraint_violation'
    assert 'max_makespan' in body['violated']


# ---------------------------------------------------------------------------
# Feasible runs: flag true + no violation -> 200
# ---------------------------------------------------------------------------

def test_optimize_feasible_with_flag_returns_200(client):
    resp = client.post('/solver/optimize',
                       json=_feasible_payload({'fail_on_violation': True}))
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['constraints']['max_makespan']['satisfied'] is True


def test_sensitivity_feasible_with_flag_returns_200(client):
    resp = client.post('/solver/sensitivity',
                       json=_feasible_payload({'fail_on_violation': True}))
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['constraints']['max_makespan']['satisfied'] is True


# ---------------------------------------------------------------------------
# No bounds at all + flag true -> 200 (nothing to violate)
# ---------------------------------------------------------------------------

def test_no_constraints_with_flag_returns_200(client):
    payload = {
        "nodes": [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 10},
        ],
        "links": [{"source": "0", "target": "1"}],
        "solver_config": {"max_iterations": 5},
        "project_context": {"constraints": {"fail_on_violation": True}},
    }
    resp = client.post('/solver/optimize', json=payload)
    assert resp.status_code == 200
    body = resp.get_json()
    assert body.get('constraints') is None
