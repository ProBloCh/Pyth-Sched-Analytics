"""
Observability: request IDs + structured JSON logging.

PR-9 (Tier 2).  Wired in by ``init_observability(app)`` from ``app.py``
after ``init_auth``.  Three surfaces:

1. **Request IDs.**  Every request gets a UUID4 ``X-Request-ID`` if
   the client didn't supply one.  The value is round-tripped on the
   response header and stamped onto every log record emitted during
   that request, so multi-endpoint flows (graph-metrics ->
   solver/optimize) can be correlated in a single log query.

2. **Structured JSON logging.**  The root logger is reconfigured to
   emit one JSON object per record: ``{timestamp, level, logger,
   message, request_id, ...extras}``.  Routes can attach additional
   structured fields by passing ``extra={...}`` to the standard
   ``logging`` API or by setting ``flask.g.log_extras = {...}``.

3. **Per-request access log.**  An ``after_request`` hook emits one
   structured record per request with ``request_id``, ``method``,
   ``path``, ``status``, ``latency_ms``, ``content_length``.  Routes
   that hit a cache should set ``flask.g.cache_hit = True/False`` so
   the field surfaces in the log line; unset = field absent.

The module has no external dependencies.  ``PYTH_JSON_LOGS=false``
disables JSON formatting (falls back to the original human-readable
format) for local dev.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone

from flask import Flask, Response, g, jsonify, request
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)

# X-Request-ID accepted from clients only if it matches this pattern.
# 1-128 chars, ASCII letters / digits / hyphen / underscore / dot / colon.
# Rejects: log-injection via CRLF, oversized values that inflate every
# JSON log line, attacker-controlled control bytes that confuse the
# JSON formatter.  Off-pattern values trigger a fresh UUID4.
_VALID_REQUEST_ID = re.compile(r'^[A-Za-z0-9._:-]{1,128}$')

_REQUEST_LOGGER_NAME = 'pyth.request'
_METRICS_PATH = '/metrics'

# Dedicated registry so the /metrics output is deterministic in tests
# (the default process_collector / platform_collector add hostname /
# pid labels that change between runs).
#
# RELOAD-SAFETY CONTRACT: the Histogram / Counter declarations below
# register at module-import time.  ``importlib.reload(observability)``
# WILL RAISE ``ValueError: Duplicated timeseries in CollectorRegistry``.
# Tests that need a fresh registry must monkey-patch ``_REGISTRY`` or
# call ``CollectorRegistry().unregister(...)`` -- never reload the
# module.  Production code never reloads modules; this only matters
# for test infrastructure.
_REGISTRY = CollectorRegistry()

# Latency histogram.  Bucket boundaries cover the documented
# performance envelope in CLAUDE.md: ~100 ms for small graphs through
# ~12 s for 15K-node analyse().  The +Inf bucket Prometheus adds
# captures runaway requests.
_REQUEST_DURATION = Histogram(
    'pyth_request_duration_seconds',
    'Wall-clock request duration in seconds, labelled by endpoint, '
    'method, and status code.',
    labelnames=('endpoint', 'method', 'status'),
    buckets=(0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0,
             60.0, 120.0),
    registry=_REGISTRY,
)

# Cache outcome counter.  Routes opt in by setting one of
# ``flask.g.cache_event = 'hit' | 'miss' | 'store' | 'error'`` during
# request handling; absent = no increment.  Keeps the counter
# meaningful (routes that don't use the cache aren't pulled into the
# zero-bucket).
_CACHE_EVENTS = Counter(
    'pyth_cache_events_total',
    'Cache lookup outcomes per request.  Routes opt in by setting '
    'flask.g.cache_event.',
    labelnames=('outcome',),
    registry=_REGISTRY,
)

# Solver internal metrics (PR-11).  Recorded by solver/core.py via
# record_solver_run() / record_mc_run() below so the metrics module
# stays the single owner of the prometheus-client surface.
_SOLVER_ITERATIONS = Histogram(
    'pyth_solver_iterations',
    'L-BFGS-B iteration count per /solver/optimize call.',
    labelnames=('endpoint',),
    buckets=(1, 5, 10, 25, 50, 100, 250, 500),
    registry=_REGISTRY,
)

_SOLVER_TERMINATIONS = Counter(
    'pyth_solver_terminations_total',
    'Optimiser termination reason per call -- converged, max_iter_hit, '
    'or unknown.  An over-budgeted run that hits max_iterations '
    'without converging surfaces as max_iter_hit, the signal that the '
    'solver returned a suboptimal answer.',
    labelnames=('endpoint', 'reason'),
    registry=_REGISTRY,
)

_MC_SAMPLES = Histogram(
    'pyth_mc_samples',
    'Monte Carlo sample count per stochastic solver / completion run.',
    labelnames=('endpoint',),
    buckets=(1, 10, 32, 100, 256, 1000),
    registry=_REGISTRY,
)


def record_solver_run(endpoint: str, iterations: int,
                      terminated_reason: str) -> None:
    """Emit solver metrics for a single /solver/optimize call.

    ``endpoint`` is the solver entry point name (typically
    ``'optimize'``).  ``terminated_reason`` must be one of
    ``{'converged', 'max_iter_hit', 'unknown'}``; unknown values are
    silently coerced to ``'unknown'`` so a typo doesn't leak into
    label cardinality.
    """
    _SOLVER_ITERATIONS.labels(endpoint=endpoint).observe(max(0, int(iterations)))
    reason = terminated_reason if terminated_reason in (
        'converged', 'max_iter_hit', 'unknown',
    ) else 'unknown'
    _SOLVER_TERMINATIONS.labels(endpoint=endpoint, reason=reason).inc()


def record_mc_run(endpoint: str, n_samples: int) -> None:
    """Emit MC sample-count histogram for a stochastic run."""
    _MC_SAMPLES.labels(endpoint=endpoint).observe(max(0, int(n_samples)))

# Fields stamped onto every record from the request context.  Any
# additional fields passed via logger.info(..., extra={...}) or via
# flask.g.log_extras are merged in by the formatter below.
_CONTEXT_FIELDS = ('request_id',)

# Fields the per-request access log emits.  Listed here so the test
# can assert the contract.
ACCESS_LOG_FIELDS = (
    'request_id', 'method', 'path', 'status', 'latency_ms',
    'content_length',
)


class _RequestContextFilter(logging.Filter):
    """Stamp ``request_id`` (and any flask.g.log_extras) onto every record.

    Outside a Flask request context (e.g. boot-time logs), the fields
    are simply absent from the record — the formatter handles that
    case cleanly.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            rid = g.get('request_id', None)
        except RuntimeError:
            # No app/request context (boot-time, background thread, etc.)
            return True
        if rid is not None and not hasattr(record, 'request_id'):
            record.request_id = rid
        try:
            extras = g.get('log_extras', None)
        except RuntimeError:
            extras = None
        if isinstance(extras, dict):
            for k, v in extras.items():
                if not hasattr(record, k):
                    setattr(record, k, v)
        return True


class _JsonFormatter(logging.Formatter):
    """Emit one JSON object per record.

    Extras (anything stamped on the record beyond the stdlib defaults)
    are merged at the top level.  We intentionally do NOT promote
    stdlib internals (filename, lineno, funcName, etc.) -- they're
    available via ``record.__dict__`` if a future PR wants them, but
    today's log queries are cleaner without them.
    """

    _RESERVED = frozenset({
        'name', 'msg', 'args', 'levelname', 'levelno', 'pathname',
        'filename', 'module', 'exc_info', 'exc_text', 'stack_info',
        'lineno', 'funcName', 'created', 'msecs', 'relativeCreated',
        'thread', 'threadName', 'processName', 'process', 'message',
        'asctime', 'taskName',
    })

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            'timestamp': datetime.fromtimestamp(record.created,
                                                tz=timezone.utc).isoformat(),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
        }
        # Any non-reserved attribute stamped on the record (via
        # logger.info(..., extra={...}) or our filter) becomes a
        # top-level JSON key.
        for k, v in record.__dict__.items():
            if k in self._RESERVED or k.startswith('_'):
                continue
            if k not in payload:
                payload[k] = v
        if record.exc_info:
            payload['exc_info'] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def _json_logs_enabled() -> bool:
    return os.environ.get('PYTH_JSON_LOGS', 'true').strip().lower() != 'false'


def _install_root_logger(level: int) -> None:
    """Replace the root logger's handlers with one JSON-formatted handler.

    Called from init_observability so the swap is deterministic vs.
    whatever logging.basicConfig was called with earlier.
    """
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)

    handler = logging.StreamHandler()
    if _json_logs_enabled():
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s » %(message)s"))
    handler.addFilter(_RequestContextFilter())
    root.addHandler(handler)
    root.setLevel(level)


def _before_request() -> None:
    incoming = request.headers.get('X-Request-ID', '').strip()
    # Reject anything outside the whitelist so the value can be safely
    # echoed in headers and embedded in JSON log lines without
    # log-injection / control-byte / oversized-string concerns.
    if _VALID_REQUEST_ID.match(incoming):
        g.request_id = incoming
    else:
        g.request_id = str(uuid.uuid4())
    g.request_start_ts = time.time()


def _after_request(response: Response) -> Response:
    # Echo request ID even when before_request is short-circuited
    # (e.g. auth returned 401 before we set g.request_id -- in that
    # case Flask still ran before_request hooks in order, so the ID
    # exists, but we guard for safety).
    rid = getattr(g, 'request_id', None)
    if rid is not None:
        response.headers.setdefault('X-Request-ID', rid)

    start = getattr(g, 'request_start_ts', None)
    latency_seconds = (time.time() - start) if start else None
    latency_ms = round(latency_seconds * 1000, 2) if latency_seconds is not None else None

    cache_hit = getattr(g, 'cache_hit', None)
    cache_event = getattr(g, 'cache_event', None)

    # Metrics: record latency + cache outcome.  Don't record metrics
    # for the /metrics scrape itself (recursive cardinality + skews
    # histogram buckets toward fast scrape responses).
    if latency_seconds is not None and request.path != _METRICS_PATH:
        # Use request.endpoint (Flask handler name) for bounded
        # cardinality.  Unmatched routes (404s) have endpoint=None;
        # bucketing them as 'unmatched' prevents attacker-controlled
        # path values from inflating the histogram's label set (which
        # would otherwise enable a scrape-DoS / memory-growth vector).
        endpoint = request.endpoint or 'unmatched'
        _REQUEST_DURATION.labels(
            endpoint=endpoint,
            method=request.method,
            status=str(response.status_code),
        ).observe(latency_seconds)
        if isinstance(cache_event, str) and cache_event in (
            'hit', 'miss', 'store', 'error',
        ):
            _CACHE_EVENTS.labels(outcome=cache_event).inc()

    record = {
        'request_id': rid,
        'method': request.method,
        'path': request.path,
        'status': response.status_code,
        'latency_ms': latency_ms,
        'content_length': response.calculate_content_length(),
    }
    if cache_hit is not None:
        record['cache_hit'] = cache_hit
    if cache_event is not None:
        record['cache_event'] = cache_event

    # Don't log the /metrics scrape -- it'd spam the access log with
    # one line per scrape interval (typically every 15s).  Operators
    # who want scrape audit can read the Prometheus side.
    if request.path != _METRICS_PATH:
        logging.getLogger(_REQUEST_LOGGER_NAME).info(
            f'{request.method} {request.path} -> {response.status_code}',
            extra=record,
        )
    return response


def _check_metrics_token() -> Response | None:
    """Optional X-Metrics-Token gate.

    When ``PYTH_METRICS_TOKEN`` is set, every ``/metrics`` request
    must present a matching ``X-Metrics-Token`` header.  When unset,
    ``/metrics`` is open -- suitable for private-network Prometheus
    scrapes; production deployments exposed to the internet should
    set the token.
    """
    expected = os.environ.get('PYTH_METRICS_TOKEN', '').strip()
    if not expected:
        return None
    presented = request.headers.get('X-Metrics-Token', '')
    if presented and hmac.compare_digest(
        presented.encode('utf-8'), expected.encode('utf-8'),
    ):
        return None
    return (
        jsonify({'error': 'unauthorized'}),
        401,
        {'WWW-Authenticate': 'MetricsToken'},
    )


def _metrics_endpoint():
    """Return the Prometheus text-format scrape body."""
    blocked = _check_metrics_token()
    if blocked is not None:
        return blocked
    body = generate_latest(_REGISTRY)
    return Response(body, mimetype=CONTENT_TYPE_LATEST)


def init_observability(app: Flask) -> None:
    """Register the JSON formatter, request-ID hooks, and /metrics route."""
    level = logging.DEBUG if app.debug else logging.INFO
    _install_root_logger(level)
    app.before_request(_before_request)
    app.after_request(_after_request)
    app.add_url_rule(
        _METRICS_PATH,
        endpoint='prometheus_metrics',
        view_func=_metrics_endpoint,
        methods=['GET'],
    )
    logging.info(
        'observability initialised',
        extra={
            'json_logs': _json_logs_enabled(),
            'request_logger': _REQUEST_LOGGER_NAME,
            'metrics_path': _METRICS_PATH,
            'metrics_token_required': bool(
                os.environ.get('PYTH_METRICS_TOKEN', '').strip()
            ),
        },
    )
