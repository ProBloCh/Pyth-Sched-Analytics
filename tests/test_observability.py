"""
Observability tests (PR-9).

Covers the three surfaces exposed by ``observability.py``:

* X-Request-ID round-trip + auto-generation
* JSON log formatter shape
* per-request access log emission

The auth gate is bypassed for the entire session via the
``PYTH_AUTH_DISABLED`` env var set in ``tests/conftest.py``.  The auth
gate's interaction with the request ID is exercised by the explicit
401 / 503 tests below where we re-enable auth via monkeypatch.
"""

import json
import logging
import re

import pytest

from app import app
from observability import ACCESS_LOG_FIELDS, _JsonFormatter

UUID4_RE = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
)


@pytest.fixture
def client():
    app.config['TESTING'] = True
    return app.test_client()


# ---------------------------------------------------------------------------
# X-Request-ID round-trip
# ---------------------------------------------------------------------------

def test_request_id_is_generated_when_absent(client):
    """No X-Request-ID on the way in -> server generates a UUID4."""
    resp = client.get('/health')
    rid = resp.headers.get('X-Request-ID')
    assert rid is not None
    assert UUID4_RE.match(rid), f'not a UUID4: {rid!r}'


def test_request_id_echoes_when_supplied(client):
    """Client-supplied X-Request-ID is preserved (multi-service tracing)."""
    custom = 'trace-abc-123'
    resp = client.get('/health', headers={'X-Request-ID': custom})
    assert resp.headers.get('X-Request-ID') == custom


def test_request_id_present_on_auth_failure(monkeypatch):
    """Auth-gate 401/503 responses still carry X-Request-ID -- the
    observability before_request runs before the auth before_request
    so g.request_id is always set."""
    monkeypatch.setenv('PYTH_AUTH_DISABLED', 'false')
    monkeypatch.setenv('PYTH_API_KEYS', 'live-key')
    app.config['TESTING'] = True
    c = app.test_client()
    resp = c.post('/graph-metrics', json={'nodes': [], 'links': []})
    assert resp.status_code == 401
    assert resp.headers.get('X-Request-ID') is not None


def test_request_id_present_on_503_when_auth_unconfigured(monkeypatch):
    monkeypatch.setenv('PYTH_AUTH_DISABLED', 'false')
    monkeypatch.delenv('PYTH_API_KEYS', raising=False)
    app.config['TESTING'] = True
    c = app.test_client()
    resp = c.post('/graph-metrics', json={'nodes': [], 'links': []})
    assert resp.status_code == 503
    assert resp.headers.get('X-Request-ID') is not None


# ---------------------------------------------------------------------------
# JSON log formatter shape
# ---------------------------------------------------------------------------

def test_json_formatter_emits_valid_json():
    rec = logging.LogRecord(
        name='test', level=logging.INFO, pathname='', lineno=0,
        msg='hello %s', args=('world',), exc_info=None,
    )
    out = _JsonFormatter().format(rec)
    payload = json.loads(out)  # Will raise if not valid JSON
    assert payload['level'] == 'INFO'
    assert payload['logger'] == 'test'
    assert payload['message'] == 'hello world'
    assert 'timestamp' in payload


def test_json_formatter_promotes_extras():
    rec = logging.LogRecord(
        name='test', level=logging.INFO, pathname='', lineno=0,
        msg='m', args=(), exc_info=None,
    )
    rec.request_id = 'abc-123'
    rec.method = 'POST'
    out = json.loads(_JsonFormatter().format(rec))
    assert out['request_id'] == 'abc-123'
    assert out['method'] == 'POST'


def test_json_formatter_excludes_stdlib_internals():
    """filename / lineno / pathname etc. must NOT appear in output --
    log queries are cleaner without them."""
    rec = logging.LogRecord(
        name='test', level=logging.INFO, pathname='/tmp/x.py', lineno=42,
        msg='m', args=(), exc_info=None,
    )
    out = json.loads(_JsonFormatter().format(rec))
    assert 'pathname' not in out
    assert 'lineno' not in out
    assert 'filename' not in out


# ---------------------------------------------------------------------------
# Per-request access log
# ---------------------------------------------------------------------------

def test_access_log_emitted_on_request(client, caplog):
    """One log line per request from the pyth.request logger with
    all documented ACCESS_LOG_FIELDS present."""
    caplog.set_level(logging.INFO, logger='pyth.request')
    resp = client.get('/health')
    assert resp.status_code == 200

    request_records = [r for r in caplog.records
                       if r.name == 'pyth.request']
    assert len(request_records) == 1
    rec = request_records[0]
    for field in ACCESS_LOG_FIELDS:
        assert hasattr(rec, field), f'access log record missing {field!r}'

    # Spot-check a few fields
    assert rec.method == 'GET'
    assert rec.path == '/health'
    assert rec.status == 200
    assert isinstance(rec.latency_ms, float)
    assert rec.latency_ms >= 0


def test_access_log_request_id_matches_response_header(client, caplog):
    """The request_id in the log line equals the X-Request-ID on the
    response -- this is the correlation contract."""
    caplog.set_level(logging.INFO, logger='pyth.request')
    resp = client.get('/health', headers={'X-Request-ID': 'corr-xyz'})

    request_records = [r for r in caplog.records
                       if r.name == 'pyth.request']
    assert len(request_records) == 1
    assert request_records[0].request_id == 'corr-xyz'
    assert resp.headers['X-Request-ID'] == 'corr-xyz'
