"""
Cache schema versioning tests (PR-2).

Bumping ``_cache_version.RESPONSE_SCHEMA_VERSION`` MUST change the
cache key every blueprint emits for the same payload.  Without this,
a response-shape change silently corrupts cache entries until the
TTL expires and consumers see malformed data.

All six cache-key sites get exercised:

* solver/routes.py
* completion/routes.py
* evm/routes.py
* paths/routes.py
* interface/routes.py
* app.py (graph-metrics)
"""

import importlib
import sys

import pytest

CACHE_KEY_SITES = [
    # (module path, attr name, callable signature)
    ('solver.routes', '_cache_key', lambda fn, payload: fn('sensitivity', payload)),
    ('completion.routes', '_cache_key', lambda fn, payload: fn('mc', payload)),
    ('evm.routes', '_cache_key', lambda fn, payload: fn(payload)),
    ('paths.routes', '_cache_key', lambda fn, payload: fn('enumerate', payload)),
    ('interface.routes', '_cache_key', lambda fn, payload: fn('analytics', payload)),
]


@pytest.fixture
def reload_with_version(monkeypatch, request):
    """Reload _cache_version + the dependent modules with a fresh version
    string.  Restores them to the real ``RESPONSE_SCHEMA_VERSION`` value
    at teardown so subsequent tests in the same process don't observe
    a stale ``'v2.0.0'`` baked into the reloaded route modules.
    Copilot review finding #20.
    """
    def _restore():
        # monkeypatch already restored the constant; re-reload the
        # route modules so their import-by-value of
        # RESPONSE_SCHEMA_VERSION reverts to the real value.
        for mod_path, _, _ in CACHE_KEY_SITES:
            if mod_path in sys.modules:
                importlib.reload(sys.modules[mod_path])

    request.addfinalizer(_restore)

    def _reload(version: str):
        import _cache_version
        monkeypatch.setattr(_cache_version, 'RESPONSE_SCHEMA_VERSION', version)
        # Re-import the route modules so they pick up the patched symbol
        # (they import RESPONSE_SCHEMA_VERSION at module load).
        for mod_path, _, _ in CACHE_KEY_SITES:
            if mod_path in sys.modules:
                importlib.reload(sys.modules[mod_path])
    return _reload


@pytest.mark.parametrize('mod_path,attr,call', CACHE_KEY_SITES)
def test_cache_key_includes_schema_version(mod_path, attr, call):
    """Every blueprint's cache key contains the current schema version."""
    import _cache_version
    mod = importlib.import_module(mod_path)
    fn = getattr(mod, attr)
    payload = {'nodes': [{'ID': 'A', 'Duration': 1}], 'links': []}
    key = call(fn, payload)
    assert _cache_version.RESPONSE_SCHEMA_VERSION in key, (
        f'{mod_path}._cache_key did not embed the schema version: {key}')


@pytest.mark.parametrize('mod_path,attr,call', CACHE_KEY_SITES)
def test_cache_key_changes_when_version_bumps(
    mod_path, attr, call, reload_with_version
):
    """Same payload, different version, MUST yield different cache key."""
    payload = {'nodes': [{'ID': 'A', 'Duration': 1}], 'links': []}

    reload_with_version('v1.0.0')
    mod = importlib.import_module(mod_path)
    key_a = call(getattr(mod, attr), payload)

    reload_with_version('v2.0.0')
    mod = importlib.import_module(mod_path)
    key_b = call(getattr(mod, attr), payload)

    assert key_a != key_b, (
        f'{mod_path}._cache_key returned the same key across versions -- '
        f'a response-shape change would silently corrupt cache entries. '
        f'Got: {key_a}')


@pytest.mark.parametrize('mod_path,attr,call', CACHE_KEY_SITES)
def test_cache_key_stable_within_version(mod_path, attr, call):
    """Same payload, same version, MUST yield the same cache key."""
    payload = {'nodes': [{'ID': 'A', 'Duration': 1}], 'links': []}
    mod = importlib.import_module(mod_path)
    fn = getattr(mod, attr)
    assert call(fn, payload) == call(fn, payload)


def test_graph_metrics_cache_key_includes_schema_version(monkeypatch):
    """The /graph-metrics path in app.py uses the same version
    constant.  Captures the actual cache key the handler constructs
    by intercepting ``get_cached_result`` -- catches the contract
    behaviourally rather than via fragile source-string regex (a
    refactor that extracts the key into a helper would now still
    pass for the right reason).
    """
    import _cache_version
    import app as app_mod

    captured_keys = []

    def fake_get_cached_result(key):
        captured_keys.append(key)
        return None  # force the handler to run the full analyse path

    monkeypatch.setattr(app_mod, 'get_cached_result', fake_get_cached_result)
    app_mod.app.config['TESTING'] = True
    client = app_mod.app.test_client()
    resp = client.post(
        '/graph-metrics',
        json={'nodes': [{'ID': 'A', 'Duration': 1}], 'links': []},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert captured_keys, 'get_cached_result was not invoked'
    key = captured_keys[0]
    assert _cache_version.RESPONSE_SCHEMA_VERSION in key, (
        f'/graph-metrics cache key {key!r} does not embed the '
        f'schema version {_cache_version.RESPONSE_SCHEMA_VERSION!r}')
    assert key.startswith(f'graph:{_cache_version.RESPONSE_SCHEMA_VERSION}:'), (
        f'/graph-metrics cache key {key!r} is not in the expected '
        f'graph:<version>:<digest> shape')
