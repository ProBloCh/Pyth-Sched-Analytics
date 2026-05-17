# Observability

Pyth-Sched-Analytics emits **structured JSON logs** with **request-ID
correlation** on every endpoint.  Shipped in PR-9 (Tier 2).

## Log format

One JSON object per line on stdout.  Required fields:

| Field | Type | Notes |
|---|---|---|
| `timestamp` | ISO-8601 UTC | Always present. |
| `level` | string | `DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL`. |
| `logger` | string | Logger name.  `pyth.request` for access logs; module name (e.g. `completion.outcomes`) for application logs. |
| `message` | string | Human-readable summary. |
| `request_id` | string | UUID4 or client-supplied.  **Absent** for boot-time logs (no request context). |

Per-request access log lines (one per request, `logger=pyth.request`)
additionally carry:

| Field | Type | Notes |
|---|---|---|
| `method` | string | HTTP method. |
| `path` | string | Request path. |
| `status` | int | Response status code. |
| `latency_ms` | float | Wall-clock latency in milliseconds. |
| `content_length` | int / null | Response body size. |
| `cache_hit` | bool | **Conditional.**  Routes opt in by setting `flask.g.cache_hit = True/False`.  Absent when the route doesn't participate. |

Application code can attach extra fields to any log line via the
standard `logging` `extra={}` kwarg:

```python
import logging
logger = logging.getLogger(__name__)
logger.info('solver converged', extra={
    'iterations': 47,
    'converged': True,
})
```

Each `extra` key becomes a top-level JSON field on the resulting log
line.

## Request-ID correlation

Every response carries an `X-Request-ID` header:

* **Client supplies** `X-Request-ID: <value>` -> the value is preserved
  on the response and stamped onto every log line emitted during the
  request.  Use this to correlate logs across upstream services.
* **Client omits the header** -> the server generates a UUID4 and
  returns it on the response.  Capture and surface it in client error
  messages so support can find the matching log lines.

The auth gate's 401/503 responses **also** carry `X-Request-ID` --
the observability `before_request` hook runs before the auth gate so
the correlation field exists regardless of auth state.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PYTH_JSON_LOGS` | `true` | Set to `false` for human-readable text logs (local dev). |

There is no `PYTH_LOG_LEVEL` knob today; the Flask `app.debug` flag
controls the level (`DEBUG` when debug mode, `INFO` otherwise).  Add
one if needed.

## Log queries (Azure Monitor / Application Insights)

The JSON shape parses cleanly with KQL:

```kql
// All requests with their latency
traces
| extend body = parse_json(message)
| where body.logger == "pyth.request"
| project
    timestamp,
    request_id = tostring(body.request_id),
    method = tostring(body.method),
    path = tostring(body.path),
    status = toint(body.status),
    latency_ms = todouble(body.latency_ms)
| order by timestamp desc

// Latency P95 per endpoint
traces
| extend body = parse_json(message)
| where body.logger == "pyth.request"
| summarize p95 = percentile(todouble(body.latency_ms), 95) by tostring(body.path)
| order by p95 desc

// Trace by request ID across the service mesh
traces
| extend body = parse_json(message)
| where body.request_id == "<paste-id-from-client-error>"
| order by timestamp asc
```

## Prometheus `/metrics`

Scrape-format endpoint shipped in PR-10.  Available at
`GET /metrics`, returns the standard `text/plain; version=0.0.4`
exposition format.

### Available series

| Name | Type | Labels | Notes |
|---|---|---|---|
| `pyth_request_duration_seconds` | Histogram | `endpoint`, `method`, `status` | Wall-clock request latency.  Buckets cover ~25 ms through 120 s (matches the documented `analyse()` envelope for graphs up to 15K nodes).  The `/metrics` scrape itself is excluded so the histogram doesn't get skewed. |
| `pyth_cache_events_total` | Counter | `outcome` | Cache lookup outcomes.  Routes opt in by setting `flask.g.cache_event = 'hit' \| 'miss' \| 'store' \| 'error'`.  Unknown values are silently ignored (label closed). |

### Authentication

`/metrics` is **exempt from `X-API-Key`** -- Prometheus scrapers
should be able to reach it without a customer-facing credential.

Optionally protected by a separate token:

| Env var | Default | Effect |
|---|---|---|
| `PYTH_METRICS_TOKEN` | unset | When set, `/metrics` requires `X-Metrics-Token: <value>` (returns 401 otherwise).  When unset, `/metrics` is open -- suitable for private-network scrapes (Azure VNet, k8s Service). |

### Scrape config example

```yaml
# prometheus.yml
scrape_configs:
  - job_name: pyth-sched-analytics
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ['python-sched-analytics.azurewebsites.net:443']
    scheme: https
    # Only needed when PYTH_METRICS_TOKEN is set:
    authorization:
      type: ApiKey
      credentials: <PYTH_METRICS_TOKEN-value>
    # Custom header name to match our gate:
    headers:
      X-Metrics-Token: <PYTH_METRICS_TOKEN-value>
```

### What `/metrics` does NOT do

* Does not surface solver iteration counts or MC sample counts --
  that's PR-11 (`pyth_solver_iterations`, `pyth_solver_converged`,
  `pyth_mc_samples`, etc.).
* Does not emit per-route cache size / TTL metrics.

## What's NOT in PR-9 / PR-10

* No solver / Monte-Carlo internal metrics (PR-11 in the roadmap).
* No structured error logging on exceptions -- the existing
  `logger.exception()` calls work but their tracebacks land in the
  `exc_info` JSON field, not as structured stack frames.
* `cache_hit` (the log field) and `cache_event` (the counter) are
  opt-in per route.  Routes that set them today: none.  Wire as
  needed.
