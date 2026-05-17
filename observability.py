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

import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

from flask import Flask, Response, g, request

_REQUEST_LOGGER_NAME = 'pyth.request'

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
    g.request_id = incoming if incoming else str(uuid.uuid4())
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
    latency_ms = round((time.time() - start) * 1000, 2) if start else None

    cache_hit = getattr(g, 'cache_hit', None)

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

    logging.getLogger(_REQUEST_LOGGER_NAME).info(
        f'{request.method} {request.path} -> {response.status_code}',
        extra=record,
    )
    return response


def init_observability(app: Flask) -> None:
    """Register the JSON formatter + request-ID hooks on the Flask app."""
    level = logging.DEBUG if app.debug else logging.INFO
    _install_root_logger(level)
    app.before_request(_before_request)
    app.after_request(_after_request)
    logging.info(
        'observability initialised',
        extra={
            'json_logs': _json_logs_enabled(),
            'request_logger': _REQUEST_LOGGER_NAME,
        },
    )
