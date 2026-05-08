"""
Auth gate tests (PR-1).

Covers the four states of ``auth.py``:

1. ``PYTH_AUTH_DISABLED=true`` -- bypass (the conftest default).
2. Auth enabled, ``PYTH_API_KEYS`` set, request carries valid key -> 200.
3. Auth enabled, ``PYTH_API_KEYS`` set, request carries no/wrong key -> 401.
4. Auth enabled, ``PYTH_API_KEYS`` empty -> 503 (fail-closed).

Health endpoints stay public regardless of state.
"""

import pytest

from app import app

# Endpoints used as the "any protected endpoint" probe.  Picking
# /graph-metrics keeps the dependency surface tiny -- a malformed body
# triggers the auth gate before validation runs.
PROTECTED_ENDPOINT = '/graph-metrics'

PUBLIC_ENDPOINTS = [
    '/health',
    '/solver/health',
    '/completion/health',
    '/evm/health',
    '/paths/health',
    '/interface/health',
]


@pytest.fixture
def auth_client(monkeypatch):
    """Test client with auth ENABLED and one valid key configured."""
    monkeypatch.setenv('PYTH_AUTH_DISABLED', 'false')
    monkeypatch.setenv('PYTH_API_KEYS', 'test-key-abc, test-key-def')
    app.config['TESTING'] = True
    return app.test_client()


@pytest.fixture
def unconfigured_client(monkeypatch):
    """Test client with auth ENABLED but no keys -- the fail-closed path."""
    monkeypatch.setenv('PYTH_AUTH_DISABLED', 'false')
    monkeypatch.delenv('PYTH_API_KEYS', raising=False)
    app.config['TESTING'] = True
    return app.test_client()


def test_protected_endpoint_rejects_request_without_key(auth_client):
    resp = auth_client.post(PROTECTED_ENDPOINT, json={'nodes': [], 'links': []})
    assert resp.status_code == 401
    assert resp.headers.get('WWW-Authenticate') == 'ApiKey'
    assert resp.get_json()['error'] == 'unauthorized'


def test_protected_endpoint_rejects_wrong_key(auth_client):
    resp = auth_client.post(
        PROTECTED_ENDPOINT,
        json={'nodes': [], 'links': []},
        headers={'X-API-Key': 'not-a-real-key'},
    )
    assert resp.status_code == 401
    assert resp.headers.get('WWW-Authenticate') == 'ApiKey'


def test_protected_endpoint_accepts_valid_key(auth_client):
    # Body is intentionally minimal -- we just need to clear the auth
    # gate; downstream validation may still 400, which is fine.
    resp = auth_client.post(
        PROTECTED_ENDPOINT,
        json={'nodes': [{'ID': 'A', 'Duration': 1}], 'links': []},
        headers={'X-API-Key': 'test-key-abc'},
    )
    assert resp.status_code != 401, resp.get_data(as_text=True)
    assert resp.status_code != 503, resp.get_data(as_text=True)


def test_protected_endpoint_accepts_second_valid_key(auth_client):
    resp = auth_client.post(
        PROTECTED_ENDPOINT,
        json={'nodes': [{'ID': 'A', 'Duration': 1}], 'links': []},
        headers={'X-API-Key': 'test-key-def'},
    )
    assert resp.status_code != 401
    assert resp.status_code != 503


def test_unconfigured_auth_returns_503(unconfigured_client):
    resp = unconfigured_client.post(
        PROTECTED_ENDPOINT, json={'nodes': [], 'links': []}
    )
    assert resp.status_code == 503
    body = resp.get_json()
    assert body['error'] == 'auth not configured'


@pytest.mark.parametrize('path', PUBLIC_ENDPOINTS)
def test_health_endpoints_are_public(auth_client, path):
    resp = auth_client.get(path)
    assert resp.status_code == 200, f'{path} returned {resp.status_code}'


@pytest.mark.parametrize('path', PUBLIC_ENDPOINTS)
def test_health_endpoints_public_when_auth_unconfigured(unconfigured_client, path):
    resp = unconfigured_client.get(path)
    assert resp.status_code == 200, f'{path} returned {resp.status_code}'


def test_options_preflight_bypasses_auth(auth_client):
    """CORS preflight must reach Flask-CORS without an API key."""
    resp = auth_client.options(PROTECTED_ENDPOINT)
    assert resp.status_code in (200, 204), resp.status_code
