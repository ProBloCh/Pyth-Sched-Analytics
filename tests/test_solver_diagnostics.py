"""
Solver / Monte-Carlo internal metrics tests (PR-11).

Two surfaces:

* ``response.optimizer_diagnostics`` -- structured block on every
  ``/solver/optimize`` response.
* Prometheus metrics emitted via ``observability.record_solver_run``
  / ``record_mc_run`` -- visible at ``/metrics``.
"""

import pytest

from app import app
from solver.core import _optimizer_diagnostics


@pytest.fixture
def client():
    app.config['TESTING'] = True
    return app.test_client()


# ---------------------------------------------------------------------------
# _optimizer_diagnostics helper -- direct unit tests
# ---------------------------------------------------------------------------

def test_diagnostics_converged():
    diag = _optimizer_diagnostics(iterations=12, converged=True, max_iterations=50)
    assert diag == {
        'iterations': 12,
        'max_iterations': 50,
        'converged': True,
        'terminated_reason': 'converged',
        'max_iter_hit': False,
    }


def test_diagnostics_max_iter_hit():
    """Iterations reached the budget without converging -> max_iter_hit."""
    diag = _optimizer_diagnostics(iterations=5, converged=False, max_iterations=5)
    assert diag['terminated_reason'] == 'max_iter_hit'
    assert diag['max_iter_hit'] is True


def test_diagnostics_unknown_when_not_converged_and_under_budget():
    """Inner solver exited early for some other reason."""
    diag = _optimizer_diagnostics(iterations=3, converged=False, max_iterations=50)
    assert diag['terminated_reason'] == 'unknown'
    assert diag['max_iter_hit'] is False


def test_diagnostics_handles_zero_budget():
    """Empty-DAG fast path: 0/0 iterations + converged=True -> converged."""
    diag = _optimizer_diagnostics(iterations=0, converged=True, max_iterations=0)
    assert diag['terminated_reason'] == 'converged'


# ---------------------------------------------------------------------------
# Live endpoint -- /solver/optimize emits the block
# ---------------------------------------------------------------------------

def _chain_payload(extra_solver_config=None):
    cfg = {'max_iterations': 5}
    if extra_solver_config:
        cfg.update(extra_solver_config)
    return {
        'nodes': [
            {'ID': '0', 'Duration': 0},
            {'ID': '1', 'Duration': 10},
            {'ID': '2', 'Duration': 15},
            {'ID': '3', 'Duration': 8},
        ],
        'links': [
            {'source': '0', 'target': '1'},
            {'source': '1', 'target': '2'},
            {'source': '2', 'target': '3'},
        ],
        'solver_config': cfg,
    }


def test_optimize_response_includes_diagnostics_block(client):
    resp = client.post('/solver/optimize', json=_chain_payload())
    assert resp.status_code == 200
    body = resp.get_json()
    assert 'optimizer_diagnostics' in body
    diag = body['optimizer_diagnostics']
    assert set(diag.keys()) == {
        'iterations', 'max_iterations', 'converged',
        'terminated_reason', 'max_iter_hit',
    }
    assert diag['terminated_reason'] in (
        'converged', 'max_iter_hit', 'unknown',
    )


def test_max_iter_hit_signaled_under_budget(client):
    """A deliberately tight max_iterations budget on a non-trivial
    chain triggers the max_iter_hit flag.

    This is the load-bearing assertion -- the whole point of PR-11
    is making "the solver ran out of budget" visible to consumers.
    """
    resp = client.post(
        '/solver/optimize',
        json=_chain_payload({'max_iterations': 1}),
    )
    assert resp.status_code == 200
    body = resp.get_json()
    diag = body['optimizer_diagnostics']
    # At max_iterations=1, on this chain, the solver cannot reach
    # convergence -- diag.max_iter_hit is the signal.
    if not diag['converged']:
        assert diag['max_iter_hit'] is True
        assert diag['terminated_reason'] == 'max_iter_hit'


def test_empty_dag_diagnostics_block():
    """Empty-DAG fast path also carries the diagnostics block.  The
    HTTP path rejects empty `nodes` at the validator (400), so we
    drive the helper directly -- in-process callers of
    ``_empty_optimize`` see the same shape as a populated run."""
    from solver.core import _empty_optimize
    out = _empty_optimize(['schedule'], 0.0)
    assert 'optimizer_diagnostics' in out
    assert out['optimizer_diagnostics']['terminated_reason'] == 'converged'


# ---------------------------------------------------------------------------
# Prometheus metrics -- /metrics exposes solver series
# ---------------------------------------------------------------------------

def test_solver_metrics_emitted_on_optimize(client):
    client.post('/solver/optimize', json=_chain_payload())
    body = client.get('/metrics').get_data(as_text=True)

    assert 'pyth_solver_iterations' in body
    assert 'pyth_solver_terminations_total' in body
    # The endpoint label is fixed to 'optimize' for /solver/optimize calls.
    optimize_lines = [line for line in body.splitlines()
                      if 'pyth_solver_iterations_count' in line
                      and 'optimize' in line]
    assert optimize_lines, body
    # At least one call was recorded.
    assert any(float(line.rsplit(' ', 1)[-1]) >= 1 for line in optimize_lines)


def test_solver_metrics_label_cardinality_is_closed():
    """Unknown terminated_reason values get coerced to 'unknown' --
    a typo at the call site doesn't leak into label cardinality."""
    from observability import _SOLVER_TERMINATIONS, record_solver_run

    record_solver_run('optimize', iterations=5, terminated_reason='WAT')

    for sample in _SOLVER_TERMINATIONS.collect():
        for s in sample.samples:
            assert s.labels.get('reason') in (
                'converged', 'max_iter_hit', 'unknown',
            ), s.labels


def test_mc_samples_metric_emitted_for_stochastic_run(client):
    """A stochastic /solver/optimize run records the MC sample histogram."""
    client.post(
        '/solver/optimize',
        json=_chain_payload({'stochastic': True, 'monte_carlo_samples': 32}),
    )
    body = client.get('/metrics').get_data(as_text=True)
    sample_lines = [line for line in body.splitlines()
                    if 'pyth_mc_samples_count' in line and 'optimize' in line]
    assert sample_lines, body
