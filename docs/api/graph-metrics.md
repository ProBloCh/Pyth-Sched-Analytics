# POST /graph-metrics

Descriptive analytics for schedule dependency networks.  Performs community
detection, centrality analysis, HDBSCAN clustering, CPM (FS/SS/FF/SF + lag),
risk propagation, DCMA schedule health assessment, work package grouping, and
pattern detection.

**Consumers:** JS frontend (`CommunityGroups.js`)

---

## Request

```
POST /graph-metrics
Content-Type: application/json
```

### Body

```jsonc
{
  "nodes": [                    // Required. Array of activity objects.
    {
      "ID": "A1",               // Required. Unique activity identifier (string or number).
      "Duration": 10,           // Optional. Duration in time units. Default: 1.
      "importanceScore": 7,     // Optional. 1-10 scale. Default: 5.
      "riskScore": 6,           // Optional. 1-10 scale. Default: 5.
      "avgWeightedRisk": 4.2,   // Optional. Weighted risk score. Default: 0.
      "Resources": "Crew A",    // Optional. Resource assignment text. Default: "".
      "Dependencies": "A0",     // Optional. Comma-separated predecessor IDs. Default: "".
      "TaskType": "Task",       // Optional. Activity type label. Default: "Task".
      "Start": "2024-01-15",    // Optional. Planned start date (ISO 8601). Used for work packages.
      "End": "2024-02-15"       // Optional. Planned end date (ISO 8601). Used for work packages.
      // Additional fields are preserved and returned in the response nodes.
    }
  ],
  "links": [                    // Optional. Dependency relationships.
    {
      "source": "A0",           // Required. Predecessor activity ID.
      "target": "A1",           // Required. Successor activity ID.
      "type": "FS",             // Optional. Relationship type: "FS", "SS", "FF", "SF". Default: "FS".
      "lag": 0                  // Optional. Lag duration (negative = lead). Default: 0.
    }
  ]
}
```

### Validation

- Returns `400` with `{"error": "No nodes provided"}` if `nodes` is empty or missing.

### Caching

Responses are cached by a SHA-256 hash of `[nodes, links]`.  Cache layers:
1. **Redis** (shared across instances) — key prefix `graph:v2:<hash>`
2. **LRU in-memory** (per-instance) — keyed on JSON-serialized input

Identical requests return cached results with `cache_hit: true`.

---

## Response

```
200 OK
Content-Type: application/json
```

### Top-Level Keys

| Key | Type | Presence | Description |
|---|---|---|---|
| `nodes` | `array<object>` | Always | Enriched activity records (see [Node Object](#node-object)). |
| `links` | `array<object>` | Always | Original links with any null-cleaned fields. |
| `work_packages` | `object` | Always | Work package groupings (see [Work Packages](#work-packages)). |
| `critical_path` | `array<string>` | Always | Ordered list of activity IDs on the critical path. Empty if graph is not a DAG. |
| `critical_path_length` | `float` | Always | Total duration of the critical path. `0` if no critical path. |
| `templates` | `object` | Always | Repeating activity patterns detected (see [Templates](#templates)). |
| `schedule_health` | `object` | Always | DCMA 14-point schedule health assessment (see [Schedule Health](#schedule-health)). |
| `multi_resolution_communities` | `object` | Conditional | Multi-resolution community hierarchy. **Present only when** `n_nodes >= 50` and `edges > 0`. See [Multi-Resolution Communities](#multi-resolution-communities). |
| `cache_key` | `string` | Always | SHA-256 hash of the input. |
| `cache_hit` | `boolean` | Always | `true` if result was served from cache. |
| `processing_time` | `float` | Always | Wall-clock seconds for the request. |

---

### Node Object

Each object in the `nodes` array contains all original input fields plus
computed fields.  NaN values are serialized as `null`.

| Key | Type | Description |
|---|---|---|
| `ID` | `string` | Activity identifier. |
| `Duration` | `float` | Activity duration. |
| `importanceScore` | `float` | Importance score (input or default). |
| `riskScore` | `float` | Risk score (input or default). |
| `avgWeightedRisk` | `float` | Average weighted risk (input or default). |
| `Resources` | `string` | Resource assignment text. |
| `Dependencies` | `string` | Comma-separated predecessor IDs. |
| `TaskType` | `string` | Activity type label. |
| `CommunityGroup` | `int` or `string` | Single-resolution community ID (Louvain at `COMMUNITY_RESOLUTION`). |
| `DependencyGroup` | `string` | Dependency-based group label. |
| `DependencyGroupType` | `string` | Grouping method used (`"component"`, `"louvain"`, etc.). |
| `PC1` | `float` | First PCA component (risk/importance space). |
| `PC2` | `float` | Second PCA component. |
| `PC3` | `float` | Third PCA component. |
| `hdbscan_cluster` | `int` | HDBSCAN cluster ID. `-1` for outliers. |
| `is_outlier` | `boolean` | `true` if classified as HDBSCAN outlier. |
| `centrality_betweenness` | `float` | Betweenness centrality. |
| `centrality_closeness` | `float` | Closeness centrality. |
| `centrality_pagerank` | `float` | PageRank centrality. |
| `centrality_eigenvector` | `float` | Eigenvector centrality. |
| `risk_propagated` | `float` | Risk score after network propagation. |
| `total_float` | `float` | Total float (slack) from CPM. `0` if CPM did not run. |

**Note:** Any additional fields present in the input nodes are preserved
and returned as-is.

---

### Work Packages

Object keyed by work package name.

```jsonc
{
  "WP-001": {
    "activities": ["A1", "A2", "A3"],       // Activity IDs in this package.
    "duration": 45.0,                        // Sum of activity durations.
    "float": 5.0,                            // Minimum float in the package.
    "critical": true,                        // true if any activity is on the critical path.
    "start_date": "2024-01-15",              // Earliest start date (from input Start fields).
    "end_date": "2024-03-01",                // Latest end date (from input End fields).
    "dependencies": ["A0", "B2"],            // All predecessor IDs outside this package.
    "external_dependencies": ["A0", "B2"],   // Same as dependencies (external only).
    "internal_dependencies": ["A1"]          // Predecessors within this package.
  }
}
```

---

### Templates

Object keyed by template name.  Contains repeating activity patterns
detected via name/type similarity.

```jsonc
{
  "Install Equipment": {
    "instances": ["A1", "A5", "A9"],  // Activity IDs matching this pattern.
    "similarity_score": 0.85          // Cosine similarity of the group.
  }
}
```

---

### Schedule Health

DCMA-based schedule health assessment.

| Key | Type | Description |
|---|---|---|
| `logic_density` | `float` | Relationships per task (ideal: 1.5-2.5). |
| `n_tasks` | `int` | Total number of activities. |
| `n_relationships` | `int` | Total number of links. |
| `relationship_types` | `object` | Counts by type: `{"FS": n, "SS": n, "FF": n, "SF": n}`. |
| `n_lags` | `int` | Number of links with non-zero lag. |
| `n_negative_lags` | `int` | Number of links with negative lag (leads). |
| `missing_predecessors` | `int` | Activities with no predecessors. |
| `missing_successors` | `int` | Activities with no successors. |
| `high_float_activities` | `int` | Activities with total float > 44 days. |
| `high_duration_activities` | `int` | Activities with duration > 44 days. |
| `resource_gaps` | `int` | Activities with no resource assignment. |
| `critical_path_length_tasks` | `int` | Number of activities on the critical path. |
| `critical_path_length_duration` | `float` | Duration of the critical path. |
| `critical_path_ratio` | `float` | `critical_path_length_tasks / n_tasks`. |
| `checks` | `object` | Per-check boolean results (see below). |
| `health_score` | `float` | `0.0`-`1.0`. Fraction of checks passing. |

**`checks` object:**

| Key | Type | Description |
|---|---|---|
| `logic_density_ok` | `boolean` | `1.5 <= logic_density <= 2.5` |
| `missing_predecessors` | `boolean` | `<= 5%` of tasks |
| `missing_successors` | `boolean` | `<= 5%` of tasks |
| `no_negative_lags` | `boolean` | Zero negative lags |
| `high_float_ok` | `boolean` | `<= 5%` of tasks |
| `high_duration_ok` | `boolean` | `<= 5%` of tasks |
| `resources_assigned` | `boolean` | `<= 5%` unassigned |
| `critical_path_exists` | `boolean` | At least one critical-path activity |

---

### Multi-Resolution Communities

**Conditional:** Only present when `n_nodes >= 50` and the graph has edges.

| Key | Type | Description |
|---|---|---|
| `hierarchy` | `array` | Containment hierarchy across resolution tiers. |
| `resolutions` | `array` | Community assignments at each resolution level. |
| `resolution_values` | `array<float>` | Gamma values used (default: `[0.3, 1.0, 2.5, 4.0]`). |
| `stability_scores` | `array<float>` | NMI stability score for each resolution. |
| `best_resolution` | `int` | Index of the most stable resolution in `resolution_values`. |

---

## Error Responses

| Status | Body | Condition |
|---|---|---|
| `400` | `{"error": "No nodes provided"}` | Missing or empty `nodes` array. |
| `500` | `{"error": "<message>"}` | Unhandled analysis error. |
