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
1. **Redis** (shared across instances) — key prefix `graph:v3:<hash>`
2. **LRU in-memory** (per-instance) — keyed on JSON-serialized input

Identical requests return cached results with `cache_hit: true`.

The Redis key prefix was bumped from `v2` to `v3` alongside the
deterministic cycle-handling rewrite, which added the top-level
`cycles_removed` and `warnings` fields.  Older `v2:` entries are
ignored on read and let to expire naturally.

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
| `cycles_removed` | `array<object>` | Always | Edges removed by `ensure_dag` to sanitize the input into a DAG. Empty array when the input was already acyclic. See [Cycles Removed](#cycles-removed). |
| `warnings` | `array<object>` | Always | Structured advisories about how the analysis ran (e.g. cycle removal, residual cycles).  Empty array when nothing is worth flagging.  See [Warnings](#warnings). |
| `cache_key` | `string` | Always | SHA-256 hash of the input. |
| `cache_hit` | `boolean` | Always | `true` if result was served from cache. |
| `processing_time` | `float` | Always | Wall-clock seconds for the request. |

---

### Node Object

Each object in the `nodes` array contains all original input fields plus
computed fields.  NaN values are serialized as `null`.

#### Input Fields (preserved)

| Key | Type | Description |
|---|---|---|
| `ID` | `string` | Activity identifier. |
| `Duration` | `float` | Activity duration. |
| `importanceScore` | `float` | Importance score (input or default 5). |
| `riskScore` | `float` | Risk score (input or default 5). |
| `avgWeightedRisk` | `float` | Average weighted risk (input or default 0). |
| `Resources` | `string` | Resource assignment text. |
| `Dependencies` | `string` | Comma-separated predecessor IDs. |
| `TaskType` | `string` | Activity type label. |

Any additional fields present in the input nodes are preserved and
returned as-is.

#### Computed Fields

| Key | Type | Description |
|---|---|---|
| `Cluster` | `int` | HDBSCAN cluster ID (falls back to K-means). Noise points are reassigned to nearest cluster. |
| `pca1` | `float` | First PCA component (risk/importance space). |
| `pca2` | `float` | Second PCA component. |
| `DependencyCluster` | `int` | Dependency-based group ID (Louvain on dependency graph). |
| `CommunityGroup` | `int` | Single-resolution community ID (Louvain at `COMMUNITY_RESOLUTION`). |
| `PageRank` | `float` | PageRank centrality (damping 0.9). |
| `closeness_centrality` | `float` | Closeness centrality (harmonic for directed graphs). |
| `degree_centrality` | `float` | Normalized degree centrality. |
| `Clustering_Coefficient` | `float` | Local clustering coefficient (on undirected projection). |
| `propagated_risk` | `float` | Risk after network propagation (intrinsic + inherited). |
| `risk_transmission` | `float` | Outgoing risk flow to successors. |
| `coupling_density` | `float` | Fraction of community members that are direct neighbours. |
| `total_float` | `float` | Total float (slack) from CPM. `0` if CPM did not run. |

---

### Work Packages

Object keyed by package name (`Package_{cluster_id}`).  Packages are
derived from HDBSCAN clustering — each cluster becomes a work package.
Packages are only created for clusters that have valid start/end dates.

```jsonc
{
  "Package_0": {
    "tasks": ["A1", "A2", "A3"],             // Activity IDs in this package.
    "critical_path": ["A1", "A3"],           // Longest path within the package subgraph.
    "critical_path_length": 25.0,            // Duration of the package's internal critical path.
    "start": "2024-01-15T00:00:00",          // Earliest start date (ISO 8601). null if no dates.
    "end": "2024-03-01T00:00:00"             // Latest end date (ISO 8601). null if no dates.
  }
}
```

---

### Templates

Object keyed by template name (`Template_{index}`).  Contains repeating
activity patterns detected via name/type similarity.

```jsonc
{
  "Template_0": {
    "average_duration": 12.5,                  // Mean duration of matched activities.
    "duration_variance": 4.2,                  // Variance of durations (0.0 if single match).
    "most_common_resources": ["Crew A"],       // Mode of resource assignments.
    "dependency_links": ["A0"],                // Mode of dependency strings.
    "task_frequency": 5                        // Number of activities matching this pattern.
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
| `graph_stats` | `object` | `{n_nodes, n_edges, density}` — basic graph statistics. |
| `levels` | `array<object>` | Community assignments at each resolution level (see below). |
| `hierarchy` | `object` | Containment hierarchy across adjacent tiers (see below). |
| `stable_cores` | `array<array<string>>` | Groups of activity IDs that cluster together at every resolution tier. |

**Level entry** (one per resolution in the adaptive ladder, default
gamma = 0.3, 1.0, 2.5, 4.0):

```jsonc
{
  "resolution": 1.0,                          // Louvain gamma value
  "n_communities": 8,                         // Number of communities at this resolution
  "modularity": 0.42,                         // Louvain modularity score
  "stability_nmi": 0.85,                      // NMI stability across n_runs
  "membership": {"A1": 0, "A2": 0, "A3": 1}, // Node-to-community mapping
  "group_metrics": {                          // Per-community metrics
    "0": {
      "size": 15,                             // Number of members
      "internal_edges": 28,                   // Edges within community
      "boundary_edges": 12,                   // Edges crossing community boundary
      "density": 0.267                        // Internal edge density
    }
  }
}
```

**Hierarchy** — keyed by `tier_{i}_to_{i+1}`, each value is an array of
containment edges between adjacent resolution tiers:

```jsonc
{
  "tier_0_to_1": [
    {"parent": 0, "child": 2, "overlap": 0.85},
    {"parent": 0, "child": 3, "overlap": 0.72}
  ]
}
```

---

## Error Responses

| Status | Body | Condition |
|---|---|---|
| `400` | `{"error": "No nodes provided"}` | Missing or empty `nodes` array. |
| `500` | `{"error": "<message>"}` | Unhandled analysis error. |

---

### Cycles Removed

`cycles_removed` lists the edges that `ensure_dag` deleted to turn the
input into a DAG so CPM, risk propagation, and community detection have
well-defined output.  Each entry:

| Key | Type | Description |
|---|---|---|
| `source` | `string` | Source activity ID of the removed edge. |
| `target` | `string` | Target activity ID of the removed edge. |
| `type` | `string` | Original link type (`FS` / `SS` / `FF` / `SF`). |
| `lag` | `float` | Original lag in input time units (`0` when absent). |

When the input is already a DAG, the array is empty.

Edge selection is canonical *within each discovered cycle*: at each
cycle-break step the lexicographically smallest `(source, target, type,
lag)` tuple in the found cycle is removed.  This guarantees the same
input link ordering produces the same `cycles_removed` list across runs
and NetworkX versions.  Two semantically-equivalent inputs whose links
are permuted may still produce different removed-edge orderings — full
canonicalisation across input permutations is part of P-3 (cache
canonicalisation) and is intentionally out of scope here.

A guard caps the number of removal iterations at `max(|edges| / 2, 1)`.
If the cap is reached and cycles still remain, a `cycles_remaining`
entry is appended to `warnings` and analytics proceed on the partially-
sanitized graph (`_risk_propagation` then routes through SCC
condensation to keep its output deterministic).

---

### Warnings

`warnings` is a structured advisory channel for issues that didn't
prevent the response from being computed but that callers should react
to.  Each entry:

| Key | Type | Description |
|---|---|---|
| `code` | `string` | Stable, machine-readable identifier. |
| `severity` | `string` | Either `info` or `warning`. |
| `message` | `string` | Human-readable detail. |

| Code | Severity | Meaning |
|---|---|---|
| `cycles_removed` | `info` | One or more edges were removed to break input cycles.  Inspect `cycles_removed` for specifics. |
| `cycles_remaining` | `warning` | The cycle-removal cap was reached and the graph still contained cycles when analytics began. |
| `self_loop_dropped` | `info` | One or more self-edges (`A → A`) were excluded from the `propagated_risk` inflow.  Self-edges don't represent network risk inheritance. |
| `scc_non_convergent` | `warning` | One or more residual cyclic components did not reach the propagation fixed-point within the iteration cap.  Their `propagated_risk` values are bounded and deterministic but not converged; treat as advisory rather than absolute. |

The array is empty when nothing is worth flagging.  New codes may be
added in future revisions; consumers should treat unknown codes as
opaque rather than failing.
