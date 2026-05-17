"""
API key authentication + CORS allowlist.

Wired in by ``init_auth(app)`` from ``app.py``.  Reads two env vars at
request time (cheap, monkey-patchable from tests):

* ``PYTH_API_KEYS`` -- comma-separated list of accepted keys.  When empty
  and auth is not explicitly disabled, every protected request is
  refused with HTTP 503 -- fail-closed by design so a misconfigured
  deploy is loud, not silently open.
* ``PYTH_AUTH_DISABLED=true`` -- bypass the gate entirely.  Intended for
  local dev and the test suite (set in ``tests/conftest.py``).  Never
  set this in production.

CORS origins come from ``PYTH_CORS_ORIGINS`` (comma-separated, or the
literal ``*`` to opt back into the previous wildcard behaviour for
local dev).  Empty / unset means same-origin only.
"""

from __future__ import annotations

import hmac
import logging
import os

from flask import Flask, jsonify, request

# Health + diagnostic endpoints that do NOT require auth -- consumed by
# load balancers, uptime monitors, Prometheus scrapers, and the Azure
# Web Apps probes.  /metrics has its own optional X-Metrics-Token
# gate in observability.py; bypassing X-API-Key here lets the
# scraper hit the endpoint without a customer-facing key.
#
# /test-cors is intentionally NOT whitelisted: it echoes the
# attacker-controlled Origin header in its response body, which
# (while benign in plain JSON) is a reflective unauth surface we
# don't need in production.  Devs verifying CORS pass their dev key.
WHITELIST_PATHS = frozenset({
    '/',
    '/health',
    '/metrics',
    '/solver/health',
    '/completion/health',
    '/evm/health',
    '/paths/health',
    '/interface/health',
    '/v1/health',
    '/v1/solver/health',
    '/v1/completion/health',
    '/v1/evm/health',
    '/v1/paths/health',
    '/v1/interface/health',
})


def _load_keys() -> list[str]:
    raw = os.environ.get('PYTH_API_KEYS', '').strip()
    if not raw:
        return []
    return [k.strip() for k in raw.split(',') if k.strip()]


def _auth_disabled() -> bool:
    return os.environ.get('PYTH_AUTH_DISABLED', '').strip().lower() == 'true'


def _compare_any(presented: str, valid: list[str]) -> bool:
    # Per-key compare_digest is constant-time, but iterating over
    # ``valid`` makes the total wall-clock leak the configured key
    # count (early miss = shorter total time when ``presented`` is
    # all-different lengths).  The leak is negligible: PYTH_API_KEYS
    # is operator-supplied at deploy time (not an attacker-derivable
    # secret), and the count rarely exceeds 2-3 distinct keys.  If
    # the key count ever becomes sensitive, switch to comparing
    # against a fixed-length digest set instead.
    if not presented:
        return False
    presented_b = presented.encode('utf-8')
    return any(hmac.compare_digest(presented_b, k.encode('utf-8')) for k in valid)


def _auth_hook():
    # CORS preflights must reach Flask-CORS without an API key.
    if request.method == 'OPTIONS':
        return None

    # Health probes and the root descriptor stay public.
    if request.path in WHITELIST_PATHS:
        return None

    if _auth_disabled():
        return None

    valid = _load_keys()
    if not valid:
        # Fail-closed: a deploy that forgot PYTH_API_KEYS is loud, not
        # silently open.  Same status the LB will surface as 'unhealthy'.
        return (
            jsonify({'error': 'auth not configured',
                     'detail': 'set PYTH_API_KEYS to enable the API'}),
            503,
            {'WWW-Authenticate': 'ApiKey'},
        )

    presented = request.headers.get('X-API-Key', '')
    if not _compare_any(presented, valid):
        return (
            jsonify({'error': 'unauthorized'}),
            401,
            {'WWW-Authenticate': 'ApiKey'},
        )

    return None


def load_cors_origins() -> list[str] | str:
    """Return the configured CORS origins.

    * ``[]``           -- no CORS (same-origin only); safe default.
    * ``'*'``          -- wildcard, opt-in only via the literal env value.
    * ``[origin, ...]`` -- explicit allowlist.
    """
    raw = os.environ.get('PYTH_CORS_ORIGINS', '').strip()
    if not raw:
        return []
    if raw == '*':
        logging.warning(
            "PYTH_CORS_ORIGINS='*' -- wildcard CORS is enabled.  Acceptable "
            "for local dev only; set explicit origins in production.")
        return '*'
    return [o.strip() for o in raw.split(',') if o.strip()]


def init_auth(app: Flask) -> None:
    """Register the API-key gate as a ``before_request`` hook."""
    app.before_request(_auth_hook)
    if _auth_disabled():
        logging.info("auth: disabled via PYTH_AUTH_DISABLED")
    elif _load_keys():
        logging.info("auth: enabled with %d configured key(s)", len(_load_keys()))
    else:
        logging.warning(
            "auth: enabled but PYTH_API_KEYS is empty -- every protected "
            "request will return 503 until keys are configured.")
