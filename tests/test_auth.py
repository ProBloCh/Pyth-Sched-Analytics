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


# ---------------------------------------------------------------------------
# CORS allowlist actually filters the cross-origin headers.  Without
# this guard, a future regression that re-introduced wildcard CORS
# would only show up in production.
#
# CORS resolution happens at app import time (flask-cors reads the
# resources= dict once).  We reload the app module under the relevant
# env to exercise each branch.
# ---------------------------------------------------------------------------

def _reload_app_with_cors(monkeypatch, value):
    """Reload ``app`` so CORS picks up the new PYTH_CORS_ORIGINS."""
    import importlib

    import app as app_mod
    monkeypatch.setenv('PYTH_AUTH_DISABLED', 'true')
    monkeypatch.setenv('PYTH_CORS_ORIGINS', value)
    importlib.reload(app_mod)
    app_mod.app.config['TESTING'] = True
    return app_mod.app.test_client()


def test_cors_allowlist_admits_listed_origin(monkeypatch):
    client = _reload_app_with_cors(monkeypatch, 'https://app.example.com')
    resp = client.options(
        PROTECTED_ENDPOINT,
        headers={
            'Origin': 'https://app.example.com',
            'Access-Control-Request-Method': 'POST',
        },
    )
    assert resp.headers.get('Access-Control-Allow-Origin') == 'https://app.example.com'


def test_cors_allowlist_rejects_unlisted_origin(monkeypatch):
    client = _reload_app_with_cors(monkeypatch, 'https://app.example.com')
    resp = client.options(
        PROTECTED_ENDPOINT,
        headers={
            'Origin': 'https://evil.example.com',
            'Access-Control-Request-Method': 'POST',
        },
    )
    # No ACAO header for an origin outside the allowlist; the browser
    # will treat this as a cross-origin failure and refuse the
    # follow-up POST.
    assert resp.headers.get('Access-Control-Allow-Origin') is None


def test_cors_empty_allowlist_blocks_all_cross_origin(monkeypatch):
    """PYTH_CORS_ORIGINS unset -> same-origin only.  No browser
    cross-origin request gets the allow header."""
    client = _reload_app_with_cors(monkeypatch, '')
    resp = client.options(
        PROTECTED_ENDPOINT,
        headers={
            'Origin': 'https://anywhere.example.com',
            'Access-Control-Request-Method': 'POST',
        },
    )
    assert resp.headers.get('Access-Control-Allow-Origin') is None


def test_cors_wildcard_opt_in(monkeypatch):
    """Literal '*' is the explicit dev opt-in -- regression guard so a
    future refactor doesn't accidentally drop the ability to set it."""
    client = _reload_app_with_cors(monkeypatch, '*')
    resp = client.options(
        PROTECTED_ENDPOINT,
        headers={
            'Origin': 'https://anywhere.example.com',
            'Access-Control-Request-Method': 'POST',
        },
    )
    # flask-cors reflects the request origin or returns '*' depending
    # on configuration; either is a successful wildcard allow.
    acao = resp.headers.get('Access-Control-Allow-Origin')
    assert acao in ('*', 'https://anywhere.example.com'), acao


# ---------------------------------------------------------------------------
# Direct unit tests on auth._load_keys parsing.  Catches regressions
# where a misconfigured PYTH_API_KEYS would silently authenticate
# requests presenting empty / whitespace tokens.
# ---------------------------------------------------------------------------

def test_load_keys_strips_whitespace(monkeypatch):
    from auth import _load_keys
    monkeypatch.setenv('PYTH_API_KEYS', ' key-a , key-b ,key-c')
    assert _load_keys() == ['key-a', 'key-b', 'key-c']


def test_load_keys_drops_empty_entries(monkeypatch):
    """Stray commas / empty entries between commas must not produce
    an empty-string key (which compare_digest would never match but
    would still inflate the configured-keys count)."""
    from auth import _load_keys
    monkeypatch.setenv('PYTH_API_KEYS', 'key-a,,key-b,')
    assert _load_keys() == ['key-a', 'key-b']


def test_load_keys_returns_empty_for_whitespace_only(monkeypatch):
    """``PYTH_API_KEYS=' , '`` must read as fail-closed (no keys
    configured -> 503) rather than ' ' being a usable key."""
    from auth import _load_keys
    monkeypatch.setenv('PYTH_API_KEYS', ' , ')
    assert _load_keys() == []


def test_load_keys_returns_empty_when_unset(monkeypatch):
    from auth import _load_keys
    monkeypatch.delenv('PYTH_API_KEYS', raising=False)
    assert _load_keys() == []


def test_whitespace_only_keys_trigger_503_at_request_time(monkeypatch):
    """Integration counterpart: a deploy that set PYTH_API_KEYS to
    a whitespace-only value must return 503 (not 200) on a protected
    request.  Locks in the fail-closed behaviour end-to-end."""
    monkeypatch.setenv('PYTH_AUTH_DISABLED', 'false')
    monkeypatch.setenv('PYTH_API_KEYS', ' , ')
    app.config['TESTING'] = True
    resp = app.test_client().post(
        PROTECTED_ENDPOINT,
        json={'nodes': [], 'links': []},
        headers={'X-API-Key': ''},
    )
    assert resp.status_code == 503


# ---------------------------------------------------------------------------
# Diagnostic endpoints.
# ---------------------------------------------------------------------------

def test_root_endpoint_is_public(auth_client):
    """The root path is a service-discovery endpoint, intentionally public."""
    resp = auth_client.get('/')
    assert resp.status_code == 200


def test_test_cors_requires_auth(auth_client):
    """/test-cors echoes the Origin header in its response body.  We
    removed it from WHITELIST_PATHS so the reflective surface stays
    auth-gated in production (devs verifying CORS pass their dev key
    via X-API-Key)."""
    resp = auth_client.get('/test-cors')
    assert resp.status_code == 401, (
        f'/test-cors is in WHITELIST_PATHS again?  Got {resp.status_code}')


def test_test_cors_accessible_with_key(auth_client):
    """With a valid X-API-Key, /test-cors is reachable -- the
    capability isn't removed, just gated."""
    resp = auth_client.get(
        '/test-cors',
        headers={'X-API-Key': 'test-key-abc'},
    )
    assert resp.status_code == 200
