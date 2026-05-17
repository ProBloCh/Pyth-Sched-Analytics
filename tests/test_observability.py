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


# ---------------------------------------------------------------------------
# Prometheus /metrics endpoint
# ---------------------------------------------------------------------------

def test_metrics_endpoint_returns_prometheus_text(client):
    """`/metrics` returns text/plain Prometheus exposition format."""
    # Hit at least one endpoint so the histogram has a sample.
    client.get('/health')
    resp = client.get('/metrics')
    assert resp.status_code == 200
    assert resp.mimetype.startswith('text/plain')
    body = resp.get_data(as_text=True)
    assert 'pyth_request_duration_seconds' in body
    assert '# HELP' in body  # Prometheus exposition format marker


def test_metrics_records_request_latency(client):
    """A request to /health increments the latency histogram."""
    client.get('/health')
    client.get('/health')
    body = client.get('/metrics').get_data(as_text=True)
    # The _count for the health endpoint should be >= 2.
    health_lines = [line for line in body.splitlines()
                    if line.startswith('pyth_request_duration_seconds_count')
                    and 'health' in line]
    assert health_lines, body
    # Sum the counts across any matching label sets.
    total = 0
    for line in health_lines:
        # e.g. pyth_request_duration_seconds_count{endpoint="health",...} 2.0
        total += float(line.rsplit(' ', 1)[-1])
    assert total >= 2


def test_metrics_excludes_self_scrape(client):
    """/metrics scrapes don't appear as labels in the histogram --
    avoids recursive cardinality + skewed buckets."""
    # Do a clean scrape, then look at the body.
    body = client.get('/metrics').get_data(as_text=True)
    metrics_lines = [line for line in body.splitlines()
                     if 'pyth_request_duration_seconds' in line
                     and 'prometheus_metrics' in line]
    assert not metrics_lines, metrics_lines


def test_metrics_token_required_when_set(monkeypatch):
    """When PYTH_METRICS_TOKEN is set, /metrics requires the matching
    X-Metrics-Token header."""
    monkeypatch.setenv('PYTH_METRICS_TOKEN', 'scrape-token')
    app.config['TESTING'] = True
    c = app.test_client()

    # No token -> 401
    resp = c.get('/metrics')
    assert resp.status_code == 401

    # Wrong token -> 401
    resp = c.get('/metrics', headers={'X-Metrics-Token': 'wrong'})
    assert resp.status_code == 401

    # Correct token -> 200
    resp = c.get('/metrics', headers={'X-Metrics-Token': 'scrape-token'})
    assert resp.status_code == 200


def test_metrics_token_unset_means_open(monkeypatch):
    """When PYTH_METRICS_TOKEN is unset, /metrics is open (private-
    network scrape pattern).  Locks in the default."""
    monkeypatch.delenv('PYTH_METRICS_TOKEN', raising=False)
    app.config['TESTING'] = True
    c = app.test_client()
    resp = c.get('/metrics')
    assert resp.status_code == 200


def test_metrics_endpoint_is_auth_exempt(monkeypatch):
    """Even with PYTH_API_KEYS set, /metrics doesn't require X-API-Key."""
    monkeypatch.setenv('PYTH_AUTH_DISABLED', 'false')
    monkeypatch.setenv('PYTH_API_KEYS', 'real-key')
    app.config['TESTING'] = True
    c = app.test_client()
    resp = c.get('/metrics')
    assert resp.status_code == 200


def test_cache_event_counter_increments_on_opt_in():
    """A route that sets ``g.cache_event = 'hit'`` bumps the counter.

    Drives ``_after_request`` directly inside a test request context
    rather than registering a runtime route -- Flask 3 forbids
    add_url_rule after the first request.
    """
    import time

    from flask import Response, g

    from observability import _CACHE_EVENTS, _after_request

    before = _CACHE_EVENTS.labels(outcome='hit')._value.get()

    with app.test_request_context('/whatever', method='GET'):
        g.request_id = 'test-cache-rid'
        g.request_start_ts = time.time() - 0.001  # 1 ms ago
        g.cache_event = 'hit'
        _after_request(Response('ok', status=200))

    after = _CACHE_EVENTS.labels(outcome='hit')._value.get()
    assert after == before + 1


def test_cache_event_counter_ignores_unknown_outcome():
    """A route that sets a typo'd ``g.cache_event`` does NOT silently
    create a new label dimension -- the outcome label is closed."""
    import time

    from flask import Response, g

    from observability import _CACHE_EVENTS, _after_request

    with app.test_request_context('/whatever', method='GET'):
        g.request_id = 'test-cache-bad-rid'
        g.request_start_ts = time.time() - 0.001
        g.cache_event = 'cached'  # not in the allowed set
        _after_request(Response('ok', status=200))

    # The counter for 'cached' was never created.  Confirm by checking
    # the registry's known label values.
    for sample in _CACHE_EVENTS.collect():
        for s in sample.samples:
            assert s.labels.get('outcome') != 'cached', sample.samples
