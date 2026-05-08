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


# ---------------------------------------------------------------------------
# Symmetric coverage: max_budget violations should behave like max_makespan
# ---------------------------------------------------------------------------

def _budget_violating_payload(extra_constraints=None):
    """Same chain as _violating_payload but the bound that fails is
    cost-side -- the resource_count * resource_rate * duration term
    integrates to ~33000, so we cap budget at 100 to guarantee a
    violation regardless of how the optimiser crashes durations."""
    constraints = {"max_budget": 100.0}
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
        "activity_metadata": {
            "1": {"baseline_cost": 10000, "resource_count": 5,
                  "resource_rate": 100},
            "2": {"baseline_cost": 15000, "resource_count": 5,
                  "resource_rate": 100},
            "3": {"baseline_cost": 8000, "resource_count": 5,
                  "resource_rate": 100},
        },
        "project_context": {"constraints": constraints},
    }


def test_optimize_budget_violation_with_flag_returns_409(client):
    resp = client.post(
        '/solver/optimize',
        json=_budget_violating_payload({'fail_on_violation': True}),
    )
    assert resp.status_code == 409
    body = resp.get_json()
    assert body['error'] == 'constraint_violation'
    assert 'max_budget' in body['violated']
    assert body['constraints']['max_budget']['satisfied'] is False


def test_optimize_budget_violation_without_flag_returns_200(client):
    resp = client.post('/solver/optimize',
                       json=_budget_violating_payload())
    assert resp.status_code == 200
    body = resp.get_json()
    assert body['constraints']['max_budget']['satisfied'] is False


# ---------------------------------------------------------------------------
# Multi-violation determinism: ``violated`` must sort alphabetically
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# /solver/pareto: fail_on_violation contract.
# ---------------------------------------------------------------------------
# /pareto returns a frontier of Pareto-optimal points, not a single
# constraints block, so the post-solve violation gate (which assumes
# one ``constraints`` field) does not currently apply to /pareto.
# This is documented behaviour: a customer who sets
# ``fail_on_violation: true`` on a /pareto request gets the existing
# 200 response with the full frontier, NOT a 409.
#
# The test below locks that contract in.  When a future PR
# implements /pareto-aware violation handling (e.g. "fail if no point
# satisfies the bounds"), it must update this test in the same
# commit -- otherwise a quiet behaviour change goes out the door.
# ---------------------------------------------------------------------------

def test_pareto_fail_on_violation_currently_ignored(client):
    payload = {
        "nodes": [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 100},
            {"ID": "2", "Duration": 80},
        ],
        "links": [
            {"source": "0", "target": "1"},
            {"source": "1", "target": "2"},
        ],
        "solver_config": {"max_iterations": 5, "pareto_vectors": 3},
        # Bound that the Pareto sweep cannot satisfy at any point.
        "project_context": {
            "constraints": {
                "max_makespan": 1.0,
                "fail_on_violation": True,
            },
        },
    }
    resp = client.post('/solver/pareto', json=payload)
    # Current contract: /pareto does NOT honour the flag; response is
    # the regular 200 with a frontier object.  When this changes,
    # update both the route handler and this test together.
    assert resp.status_code == 200, (
        'pareto endpoint started honouring fail_on_violation -- '
        'update both the route handler and this test')


def test_multi_violation_409_sorts_violated_alphabetically(client):
    """When both bounds fail, ``violated`` is sorted so consumers can
    rely on stable iteration order across cached and fresh responses."""
    payload = {
        "nodes": [
            {"ID": "0", "Duration": 0},
            {"ID": "1", "Duration": 100},
        ],
        "links": [{"source": "0", "target": "1"}],
        "solver_config": {"max_iterations": 5},
        "activity_metadata": {
            "1": {"baseline_cost": 1000000, "resource_count": 5,
                  "resource_rate": 100},
        },
        "project_context": {
            "constraints": {
                "max_makespan": 10.0,
                "max_budget": 100.0,
                "fail_on_violation": True,
            },
        },
    }
    resp = client.post('/solver/optimize', json=payload)
    assert resp.status_code == 409
    body = resp.get_json()
    assert body['violated'] == ['max_budget', 'max_makespan']
