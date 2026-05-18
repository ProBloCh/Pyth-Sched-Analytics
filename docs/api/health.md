# Health Endpoints

Two independent health checks: one for the main app, one for the solver module.

---

## GET /health

Main application health check.  Reports system status, cache state, feature
flags, and runtime settings.

### Response

```
200 OK
Content-Type: application/json
```

| Key | Type | Description |
|---|---|---|
| `status` | `string` | `"healthy"` or `"degraded"`. Degraded when Redis is configured but unreachable. |
| `timestamp` | `string` | ISO 8601 UTC datetime (e.g., `"2024-06-15T14:30:00+00:00"`). |
| `networkit_available` | `boolean` | `true` when the C++ NetworkKit acceleration is loaded.  Mirrored at `features.networkit` for backwards compatibility. |
| `instance` | `object` | Azure instance metadata. |
| `cache` | `object` | Cache subsystem status. |
| `features` | `object` | Feature flags. |
| `settings` | `object` | Runtime configuration values. |

### Production gate: `PYTH_REQUIRE_NETWORKKIT`

When `PYTH_REQUIRE_NETWORKKIT=true` is set in the environment and the
NetworkKit wheel is unimportable, the app exits with status `78`
(`EX_CONFIG`) at boot before any request is served.  The Azure load
balancer then marks the instance unhealthy rather than routing traffic
to the slower NetworkX-only path.  Default is unset, so dev / CI
environments without the C++ wheel still boot and degrade silently.

### `instance`

| Key | Type | Description |
|---|---|---|
| `site` | `string` or `null` | Azure `WEBSITE_SITE_NAME`. `null` outside Azure. |
| `instance_id` | `string` or `null` | Azure `WEBSITE_INSTANCE_ID`. `null` outside Azure. |
| `region` | `string` | Azure `REGION_NAME` or `"unknown"`. |

### `cache`

| Key | Type | Description |
|---|---|---|
| `redis` | `boolean` | `true` if Redis is responding to ping. |
| `redis_configured` | `boolean` | `true` if `REDIS_URL` env var is set. |
| `lru` | `object` | In-memory LRU cache stats. |

### `cache.lru`

| Key | Type | Description |
|---|---|---|
| `size` | `int` | Current number of cached entries. |
| `hits` | `int` | Total cache hits since startup. |
| `misses` | `int` | Total cache misses since startup. |
| `hit_rate` | `string` | Formatted percentage (e.g., `"45.2%"`). `"0%"` if no requests. |

### `features`

| Key | Type | Description |
|---|---|---|
| `networkit` | `boolean` | `true` if NetworkKit C++ library is available. |
| `redis` | `boolean` | `true` if Redis client is configured. |
| `silhouette_optimization` | `boolean` | `true` if silhouette-based community optimization is enabled. |

### `settings`

| Key | Type | Description |
|---|---|---|
| `small_graph_threshold` | `int` | Node count boundary between small/large graph code paths. |
| `max_pattern_nodes` | `int` | Max nodes for pattern detection. |
| `cache_size` | `int` | LRU cache capacity. |
| `debug` | `boolean` | Debug mode flag. |
| `community_resolution` | `float` | Louvain resolution parameter for single-resolution community detection. |

### Example

```json
{
  "status": "healthy",
  "timestamp": "2024-06-15T14:30:00+00:00",
  "instance": {
    "site": "pyth-sched-analytics",
    "instance_id": "abc123",
    "region": "eastus"
  },
  "cache": {
    "redis": true,
    "redis_configured": true,
    "lru": {
      "size": 12,
      "hits": 340,
      "misses": 58,
      "hit_rate": "85.4%"
    }
  },
  "features": {
    "networkit": true,
    "redis": true,
    "silhouette_optimization": true
  },
  "settings": {
    "small_graph_threshold": 5000,
    "max_pattern_nodes": 500,
    "cache_size": 128,
    "debug": false,
    "community_resolution": 1.0
  }
}
```

---

## GET /solver/health

Solver module health check.  Confirms the solver Blueprint is registered
and lists its endpoints.

### Response

```
200 OK
Content-Type: application/json
```

| Key | Type | Description |
|---|---|---|
| `status` | `string` | Always `"healthy"` if the endpoint responds. |
| `module` | `string` | Always `"cadj-p-solver"`. |
| `endpoints` | `array<string>` | List of solver endpoint paths. |

### Example

```json
{
  "status": "healthy",
  "module": "cadj-p-solver",
  "endpoints": [
    "/solver/sensitivity",
    "/solver/optimize",
    "/solver/pareto"
  ]
}
```
