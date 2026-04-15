"""
Shared fixtures for solver tests.
"""

import pytest


# ---------------------------------------------------------------------------
# Sample schedule data (reused across test modules)
# ---------------------------------------------------------------------------

@pytest.fixture
def linear_schedule():
    """A -> B -> C  (simple chain, all critical)."""
    nodes = [
        {'ID': 'A', 'Duration': 10},
        {'ID': 'B', 'Duration': 20},
        {'ID': 'C', 'Duration': 5},
    ]
    links = [
        {'source': 'A', 'target': 'B'},
        {'source': 'B', 'target': 'C'},
    ]
    return nodes, links


@pytest.fixture
def diamond_schedule():
    """
    A -> B -> D -> E
    A -> C -> D -> E

    Critical path: A(10) -> B(15) -> D(12) -> E(5) = 42
    C has float = 7  (path through C = 10+8+12+5 = 35)
    """
    nodes = [
        {'ID': 'A', 'Duration': 10},
        {'ID': 'B', 'Duration': 15},
        {'ID': 'C', 'Duration': 8},
        {'ID': 'D', 'Duration': 12},
        {'ID': 'E', 'Duration': 5},
    ]
    links = [
        {'source': 'A', 'target': 'B'},
        {'source': 'A', 'target': 'C'},
        {'source': 'B', 'target': 'D'},
        {'source': 'C', 'target': 'D'},
        {'source': 'D', 'target': 'E'},
    ]
    return nodes, links


@pytest.fixture
def diamond_metadata():
    """Activity metadata matching diamond_schedule."""
    return {
        'A': {'baseline_cost': 50000, 'resource_count': 2,
              'resource_rate': 100, 'crash_max_fraction': 0.3,
              'combined_risk_score': 0.4},
        'B': {'baseline_cost': 80000, 'resource_count': 3,
              'resource_rate': 120, 'crash_max_fraction': 0.25,
              'combined_risk_score': 0.7},
        'C': {'baseline_cost': 30000, 'resource_count': 1,
              'resource_rate': 90, 'crash_max_fraction': 0.2,
              'combined_risk_score': 0.3},
        'D': {'baseline_cost': 60000, 'resource_count': 2,
              'resource_rate': 110, 'crash_max_fraction': 0.15,
              'combined_risk_score': 0.8},
        'E': {'baseline_cost': 20000, 'resource_count': 1,
              'resource_rate': 80, 'crash_max_fraction': 0.1,
              'combined_risk_score': 0.2},
    }


@pytest.fixture
def single_node():
    """Trivial schedule: one activity, no links."""
    return [{'ID': 'X', 'Duration': 7}], []


@pytest.fixture
def flask_app():
    """Flask test app with solver blueprint registered."""
    from app import app
    app.config['TESTING'] = True
    return app


@pytest.fixture
def client(flask_app):
    """Flask test client."""
    return flask_app.test_client()
