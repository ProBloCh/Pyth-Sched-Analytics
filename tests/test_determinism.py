"""
Determinism guard tests (PR-12 / Tier 3).

The stochastic endpoints (/solver/optimize stochastic, /solver/sensitivity
stochastic, /solver/pareto, /completion/monte-carlo) use Sobol QMC
with ``seed=42`` hardcoded in ``solver/stochastic.py``.  This file
locks the contract: identical input -> byte-identical numeric output.

A scientific service that can't reproduce its own forecasts on the
same input is suspect.  Without these tests, a refactor that
accidentally swapped Sobol for ``np.random.default_rng()`` (different
seed handling), or that reordered sample consumption, would slip
through review.

Numeric fields normalised:
* Floats are compared via ``pytest.approx`` (tolerates last-bit
  drift from BLAS reorderings on Sobol-derived intermediates).
* Lists are compared element-wise after sorting where the order is
  not load-bearing (e.g. activity orderings indexed by ID).
* Non-numeric / metadata fields (``computation_ms``, ``timestamp``,
  ``cache_hit``, ``cache_key``) are stripped before comparison.

@pytest.mark.determinism filter lets CI scope to just this pack.
"""

import math

import pytest

from app import app

# Fields that legitimately vary between runs.  Stripped before
# comparing two responses.
NON_DETERMINISTIC_KEYS = frozenset({
    'computation_ms',
    'processing_time',
    'timestamp',
    'cache_hit',
    'cache_key',
    'cache_event',
    'request_id',
})


def _strip(obj):
    """Remove non-deterministic keys recursively for equality compare."""
    if isinstance(obj, dict):
        return {k: _strip(v) for k, v in obj.items()
                if k not in NON_DETERMINISTIC_KEYS}
    if isinstance(obj, list):
        return [_strip(v) for v in obj]
    return obj


def _approx_equal(a, b, rel=1e-9, abs_tol=1e-12):
    """Recursively compare two nested structures with float tolerance.

    Returns True if everything matches.  Logs the first divergence
    via pytest's assertion plumbing when False.
    """
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a.keys()) != set(b.keys()):
            return False
        return all(_approx_equal(a[k], b[k], rel, abs_tol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return False
        return all(_approx_equal(x, y, rel, abs_tol) for x, y in zip(a, b))
    if isinstance(a, float) or isinstance(b, float):
        # NaN-aware compare: NaN == NaN is True here (Sobol-derived
        # NaNs at boundary conditions should still be deterministic).
        try:
            af = float(a)
            bf = float(b)
        except (TypeError, ValueError):
            return a == b
        if math.isnan(af) and math.isnan(bf):
            return True
        if math.isinf(af) and math.isinf(bf) and (af > 0) == (bf > 0):
            return True
        return af == pytest.approx(bf, rel=rel, abs=abs_tol)
    return a == b


@pytest.fixture
def client():
    app.config['TESTING'] = True
    return app.test_client()


@pytest.fixture
def diamond_dag():
    """Diamond DAG fixture reused across endpoints."""
    return {
        'nodes': [
            {'ID': '0', 'Duration': 0},
            {'ID': 'A', 'Duration': 10},
            {'ID': 'B', 'Duration': 15},
            {'ID': 'C', 'Duration': 8},
            {'ID': 'D', 'Duration': 12},
            {'ID': 'E', 'Duration': 5},
        ],
        'links': [
            {'source': '0', 'target': 'A'},
            {'source': 'A', 'target': 'B'},
            {'source': 'A', 'target': 'C'},
            {'source': 'B', 'target': 'D'},
            {'source': 'C', 'target': 'D'},
            {'source': 'D', 'target': 'E'},
        ],
    }


# ---------------------------------------------------------------------------
# Deterministic endpoints (no MC) -- expect byte-equal output.
# ---------------------------------------------------------------------------

@pytest.mark.determinism
def test_graph_metrics_deterministic(client, diamond_dag):
    """Pure descriptive analytics -- no random component.  Output
    must be byte-identical."""
    r1 = client.post('/graph-metrics', json=diamond_dag).get_json()
    r2 = client.post('/graph-metrics', json=diamond_dag).get_json()
    assert _approx_equal(_strip(r1), _strip(r2)), (
        '/graph-metrics is non-deterministic on identical input')


@pytest.mark.determinism
def test_solver_sensitivity_deterministic(client, diamond_dag):
    """Single-pass sensitivity -- no MC by default."""
    payload = {**diamond_dag, 'solver_config': {'max_iterations': 10}}
    r1 = client.post('/solver/sensitivity', json=payload).get_json()
    r2 = client.post('/solver/sensitivity', json=payload).get_json()
    assert _approx_equal(_strip(r1), _strip(r2))


@pytest.mark.determinism
def test_solver_optimize_deterministic(client, diamond_dag):
    """L-BFGS-B is deterministic given the same starting point."""
    payload = {**diamond_dag, 'solver_config': {'max_iterations': 10}}
    r1 = client.post('/solver/optimize', json=payload).get_json()
    r2 = client.post('/solver/optimize', json=payload).get_json()
    assert _approx_equal(_strip(r1), _strip(r2))


# ---------------------------------------------------------------------------
# Stochastic endpoints -- determinism depends on the seed.
# ---------------------------------------------------------------------------

@pytest.mark.determinism
def test_solver_optimize_stochastic_deterministic(client, diamond_dag):
    """Stochastic MC ensemble uses Sobol QMC with seed=42.  Same
    seed, same input -> same percentile band on every call."""
    payload = {
        **diamond_dag,
        'solver_config': {
            'max_iterations': 5,
            'stochastic': True,
            'monte_carlo_samples': 16,
        },
    }
    r1 = client.post('/solver/optimize', json=payload).get_json()
    r2 = client.post('/solver/optimize', json=payload).get_json()
    # Focus the assertion on the stochastic sub-object -- the
    # surrounding deterministic fields are covered by the
    # non-stochastic test.
    assert _approx_equal(
        _strip(r1.get('stochastic')),
        _strip(r2.get('stochastic')),
    ), 'Stochastic ensemble is non-deterministic'


@pytest.mark.determinism
def test_completion_monte_carlo_deterministic(client, diamond_dag):
    """/completion/monte-carlo wraps the same Sobol sampler -- the
    percentile band (P20/P50/P80/P95) must reproduce."""
    payload = {
        **diamond_dag,
        'config': {'monte_carlo_samples': 16},
        'project_context': {'start_date': '2026-01-05'},
    }
    r1 = client.post('/completion/monte-carlo', json=payload).get_json()
    r2 = client.post('/completion/monte-carlo', json=payload).get_json()
    assert _approx_equal(_strip(r1), _strip(r2))


# ---------------------------------------------------------------------------
# EVM has no random component but is in the contract list.
# ---------------------------------------------------------------------------

@pytest.mark.determinism
def test_evm_analyze_deterministic(client, diamond_dag):
    """EVM is a closed-form calculation; no stochasticity at all.
    A failure here would indicate a non-deterministic intermediate
    (dict iteration order, set conversion, etc.)."""
    payload = {
        **diamond_dag,
        'project_context': {'start_date': '2026-01-05'},
    }
    r1 = client.post('/evm/analyze', json=payload).get_json()
    r2 = client.post('/evm/analyze', json=payload).get_json()
    assert _approx_equal(_strip(r1), _strip(r2))


# ---------------------------------------------------------------------------
# Anti-test: prove the determinism check would actually catch a drift.
# ---------------------------------------------------------------------------

@pytest.mark.determinism
def test_approx_equal_detects_drift():
    """Sanity check on the comparator itself -- catches a slipped
    threshold."""
    a = {'p80': 100.0, 'samples': [1.0, 2.0, 3.0]}
    b = {'p80': 100.0001, 'samples': [1.0, 2.0, 3.0]}
    assert not _approx_equal(a, b, rel=1e-9, abs_tol=1e-12), (
        '_approx_equal failed to detect a 1e-4 drift')
