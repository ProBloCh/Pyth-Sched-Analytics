"""
Enterprise Middleware for Pyth-Sched-Analytics
================================================
Provides: authentication, rate limiting, input validation,
request-ID tracking, and audit logging.
"""

import json
import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from functools import wraps
from threading import Lock

from flask import Request, g, jsonify, request

from config import Config

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Request-ID tracking
# ---------------------------------------------------------------------------

def attach_request_id():
    """Assign a unique request ID (or honour the caller's X-Request-ID)."""
    g.request_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    g.request_start = time.time()


def append_request_id_header(response):
    """Echo the request ID back in every response."""
    rid = getattr(g, "request_id", None)
    if rid:
        response.headers["X-Request-ID"] = rid
    return response


# ---------------------------------------------------------------------------
# API-key authentication
# ---------------------------------------------------------------------------

# Paths that never require authentication
_PUBLIC_PATHS = frozenset(["/", "/health", "/test-cors"])


def authenticate():
    """Verify the API key if REQUIRE_AUTH is enabled.

    Accepts the key via:
      - ``Authorization: Bearer <key>``
      - ``X-API-Key: <key>``

    Returns None on success, or a Flask response tuple on failure.
    """
    if not Config.REQUIRE_AUTH:
        return None

    # Skip auth for public endpoints
    if request.path in _PUBLIC_PATHS:
        return None

    # Skip auth for OPTIONS preflight
    if request.method == "OPTIONS":
        return None

    api_key = None

    # Try Authorization header first
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        api_key = auth_header[7:].strip()

    # Fall back to X-API-Key header
    if not api_key:
        api_key = request.headers.get("X-API-Key", "").strip()

    if not api_key:
        _audit("auth_failure", detail="missing API key")
        return (
            jsonify({
                "error": "Authentication required",
                "code": "AUTH_MISSING",
                "request_id": getattr(g, "request_id", None),
            }),
            401,
        )

    if api_key not in Config.API_KEYS:
        _audit("auth_failure", detail="invalid API key")
        return (
            jsonify({
                "error": "Invalid API key",
                "code": "AUTH_INVALID",
                "request_id": getattr(g, "request_id", None),
            }),
            403,
        )

    g.authenticated = True
    return None


# ---------------------------------------------------------------------------
# In-process sliding-window rate limiter
# ---------------------------------------------------------------------------

class _RateLimiter:
    """Thread-safe in-process sliding-window rate limiter keyed by IP."""

    def __init__(self):
        self._windows: dict[str, list[float]] = defaultdict(list)
        self._lock = Lock()

    def is_allowed(self, key: str, max_requests: int, window_sec: int) -> tuple[bool, dict]:
        now = time.time()
        cutoff = now - window_sec

        with self._lock:
            bucket = self._windows[key]
            # Prune expired timestamps
            self._windows[key] = bucket = [t for t in bucket if t > cutoff]
            remaining = max(0, max_requests - len(bucket))

            if len(bucket) >= max_requests:
                retry_after = int(bucket[0] - cutoff) + 1
                return False, {
                    "X-RateLimit-Limit": str(max_requests),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(int(cutoff + window_sec)),
                    "Retry-After": str(retry_after),
                }

            bucket.append(now)
            return True, {
                "X-RateLimit-Limit": str(max_requests),
                "X-RateLimit-Remaining": str(remaining - 1),
                "X-RateLimit-Reset": str(int(cutoff + window_sec)),
            }


_limiter = _RateLimiter()


def rate_limit():
    """Enforce per-IP rate limiting. Returns None or error response."""
    if not Config.RATE_LIMIT_ENABLED:
        return None

    # Only rate-limit the heavy analytics endpoint
    if request.path not in ("/graph-metrics", "/api/v1/graph-metrics"):
        return None

    client_ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown")
    # Take first IP if behind multiple proxies
    client_ip = client_ip.split(",")[0].strip()

    allowed, headers = _limiter.is_allowed(
        client_ip, Config.RATE_LIMIT_REQUESTS, Config.RATE_LIMIT_WINDOW
    )

    if not allowed:
        _audit("rate_limited", detail=f"ip={client_ip}")
        resp = jsonify({
            "error": "Rate limit exceeded",
            "code": "RATE_LIMITED",
            "request_id": getattr(g, "request_id", None),
        })
        resp.status_code = 429
        for k, v in headers.items():
            resp.headers[k] = v
        return resp

    # Attach rate-limit headers to successful responses later
    g.rate_limit_headers = headers
    return None


def append_rate_limit_headers(response):
    """Add rate-limit headers to every response."""
    for k, v in getattr(g, "rate_limit_headers", {}).items():
        response.headers[k] = v
    return response


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

_NODE_REQUIRED_FIELDS = {"ID"}
_LINK_REQUIRED_FIELDS = {"source", "target"}


def validate_graph_payload(data: dict) -> tuple[bool, str | None]:
    """Validate the graph-metrics request payload.

    Returns (is_valid, error_message).
    """
    nodes = data.get("nodes")
    links = data.get("links")

    if nodes is None:
        return False, "Missing 'nodes' field in request body"

    if not isinstance(nodes, list):
        return False, "'nodes' must be an array"

    if not isinstance(links, (list, type(None))):
        return False, "'links' must be an array or null"

    links = links or []

    # Size limits
    if len(nodes) > Config.MAX_NODES:
        return False, f"Node count {len(nodes)} exceeds maximum of {Config.MAX_NODES}"

    if len(links) > Config.MAX_LINKS:
        return False, f"Link count {len(links)} exceeds maximum of {Config.MAX_LINKS}"

    if len(nodes) == 0:
        return False, "No nodes provided"

    # Spot-check first few nodes and links for required fields
    sample_size = min(5, len(nodes))
    for i in range(sample_size):
        node = nodes[i]
        if not isinstance(node, dict):
            return False, f"Node at index {i} is not an object"
        missing = _NODE_REQUIRED_FIELDS - set(node.keys())
        if missing:
            return False, f"Node at index {i} missing required fields: {missing}"

    sample_links = min(5, len(links))
    for i in range(sample_links):
        link = links[i]
        if not isinstance(link, dict):
            return False, f"Link at index {i} is not an object"
        missing = _LINK_REQUIRED_FIELDS - set(link.keys())
        if missing:
            return False, f"Link at index {i} missing required fields: {missing}"

    return True, None


# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------

_audit_logger = logging.getLogger("audit")


def _audit(event: str, detail: str = ""):
    """Write a structured audit log entry."""
    if not Config.AUDIT_LOG_ENABLED:
        return

    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "request_id": getattr(g, "request_id", None),
        "ip": request.headers.get("X-Forwarded-For", request.remote_addr),
        "method": request.method,
        "path": request.path,
        "detail": detail,
    }
    _audit_logger.info(json.dumps(entry, default=str))


def audit_request():
    """Log every incoming request for audit trail."""
    if not Config.AUDIT_LOG_ENABLED:
        return
    _audit("request_received")


def audit_response(response):
    """Log response metadata for audit trail."""
    if not Config.AUDIT_LOG_ENABLED:
        return response

    elapsed = time.time() - getattr(g, "request_start", time.time())
    _audit(
        "request_completed",
        detail=f"status={response.status_code} elapsed={elapsed:.3f}s",
    )
    return response


# ---------------------------------------------------------------------------
# Structured JSON logging setup
# ---------------------------------------------------------------------------

class JSONFormatter(logging.Formatter):
    """Emit log records as single-line JSON for structured log aggregation."""

    def format(self, record):
        log_entry = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(g, "request_id", None) if _has_app_context() else None,
        }
        if record.exc_info and record.exc_info[0]:
            log_entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_entry, default=str)


def _has_app_context():
    try:
        from flask import has_app_context
        return has_app_context()
    except Exception:
        return False


def setup_logging():
    """Configure logging based on Config.LOG_FORMAT."""
    root = logging.getLogger()
    root.setLevel(getattr(logging, Config.LOG_LEVEL.upper(), logging.WARNING))

    # Remove existing handlers
    for h in root.handlers[:]:
        root.removeHandler(h)

    handler = logging.StreamHandler()

    if Config.LOG_FORMAT == "json":
        handler.setFormatter(JSONFormatter())
    else:
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
        )

    root.addHandler(handler)

    # Audit logger – always INFO level
    audit = logging.getLogger("audit")
    audit.setLevel(logging.INFO)
    if Config.AUDIT_LOG_FILE:
        fh = logging.FileHandler(Config.AUDIT_LOG_FILE)
        if Config.LOG_FORMAT == "json":
            fh.setFormatter(JSONFormatter())
        else:
            fh.setFormatter(logging.Formatter("%(message)s"))
        audit.addHandler(fh)
