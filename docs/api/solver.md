# Solver Endpoints

CADJ-P multi-objective prescriptive analytics.  Three endpoints share a
common request format and are served by the `solver/` Flask Blueprint
(prefix `/solver`).

**Consumers:** C# backend (`ComputeMetrics.cs`), JS frontend

---

## Common Request Format

All three solver endpoints accept the same JSON body.  The `solver_config`
fields control which analysis runs.

```
POST /solver/{sensitivity|optimize|pareto}
Content-Type: application/json
```

### Body

```jsonc
{
  "nodes": [                          // Required. Activity list.
    {
      "ID": "A1",                     // Required. Unique identifier (string or number).
      "Duration": 10,                 // Optional. Duration in time units. Default: 1.
      "TaskType": "construction"      // Optional. Used for supply-chain type detection.
    }
  ],
  "links": [                          // Optional. Dependency relationships.
    {
      "source": "A0",                 // Required. Predecessor activity ID.
      "target": "A1",                 // Required. Successor activity ID.
      "type": "FS",                   // Optional. "FS", "SS", "FF", "SF". Default: "FS".
      "lag": 0                        // Optional. Lag duration. Default: 0.
    }
  ],
  "solver_config": {                  // Optional. Solver configuration.
    "disciplines": [                  // Optional. Subset of: "schedule", "cost", "risk",
      "schedule", "cost", "risk",     //   "resources", "quality".
      "resources", "quality"          //   Default: all five.
    ],
    "weights": {                      // Optional. Per-discipline weights (auto-normalized).
      "schedule": 0.35,               //   Default: phase-dependent (see below).
      "cost": 0.25,
      "risk": 0.20,
      "resources": 0.15,
      "quality": 0.05
    },
    "stochastic": false,              // Optional. Enable Monte Carlo ensemble. Default: false.
    "monte_carlo_samples": 100,       // Optional. MC sample count (1-1000). Default: 100.
    "max_iterations": 50,             // Optional. Optimizer iterations (1-500). Default: 50.
    "convergence_threshold": 0.001,   // Optional. Early-stop threshold. Default: 0.001.
    "learning_rate": 0.01,            // Optional. Accepted but unused by L-BFGS-B. Default: 0.01.
    "antithetic_variates": true,      // Optional. Use antithetic pairs in MC. Default: true.
    "pareto_vectors": 30              // Optional. Weight vectors for Pareto sweep (2-100). Default: 30.
  },
  "activity_metadata": {             // Optional. Per-activity enrichment.
    "A1": {
      "resource_count": 3.0,          // Optional. Number of resources. Default: 1.0.
      "baseline_cost": 50000.0,       // Optional. Baseline cost. Default: duration * 1000.
      "resource_rate": 85.0,          // Optional. Cost per resource per time unit. Default: 85.0.
      "crash_max_fraction": 0.2,      // Optional. Max fractional duration reduction (0-1). Default: 0.2.
      "combined_risk_score": 5.0,     // Optional. Risk score (0-10). Default: 0.5.
      "activity_type": "equipment"    // Optional. Supply-chain type. Affects fat-tail thresholds.
    }
  },
  "project_context": {               // Optional. Project-level settings.
    "phase": "construction",          // Optional. Phase for default weights. One of:
                                      //   "planning", "design", "procurement",
                                      //   "construction", "commissioning". Default: "construction".
    "calendar": {
      "hours_per_day": 8.0,           // Optional. Parsed but not yet applied. Default: 8.0.
      "working_days": [1,2,3,4,5]     // Optional. Parsed but not yet applied. Default: Mon-Fri.
    },
    "resource_capacities": {          // Optional. Per-pool capacity. Default: {"default": 10}.
      "default": 10
    },
    "constraints": {
      "max_end_date": "2025-12-31",   // Optional. Parsed but not yet enforced.
      "max_budget": 5000000.0         // Optional. Parsed but not yet enforced.
    }
  }
}
```

### Phase-Dependent Default Weights

If `weights` is omitted, defaults are chosen by `phase`:

| Phase | schedule | cost | risk | resources | quality |
|---|---|---|---|---|---|
| planning | 0.20 | 0.30 | 0.25 | 0.15 | 0.10 |
| design | 0.25 | 0.25 | 0.20 | 0.20 | 0.10 |
| procurement | 0.30 | 0.30 | 0.20 | 0.15 | 0.05 |
| construction | 0.35 | 0.25 | 0.20 | 0.15 | 0.05 |
| commissioning | 0.40 | 0.20 | 0.25 | 0.10 | 0.05 |

### Validation Limits

| Field | Limit |
|---|---|
| Payload size | 10 MB |
| `nodes` count | 20,000 |
| `links` count | 100,000 |
| `max_iterations` | 1-500 |
| `monte_carlo_samples` | 1-1,000 |
| `pareto_vectors` | 2-100 |

### Caching

All solver endpoints cache results in Redis (key prefix `solver:<endpoint>:<hash>`).
Cached responses include `cache_hit: true`.

---

## POST /solver/sensitivity

Single-pass sensitivity analysis.  Computes objectives, per-activity gradients,
conflict/synergy analysis, and intervention rankings at the current schedule
state.  Optionally runs a Monte Carlo ensemble for stochastic analysis.

### Response

```
200 OK
Content-Type: application/json
```

#### Top-Level Keys

| Key | Type | Presence | Description |
|---|---|---|---|
| `objectives` | `object` | Always | Current objective values keyed by discipline. |
| `makespan` | `float` | Always | Project duration (critical path length). |
| `critical_path` | `array<string>` | Always | Activity IDs on the critical path. |
| `sensitivity` | `array<object>` | Always | Per-activity sensitivity rankings (see [Sensitivity Entry](#sensitivity-entry)). Sorted by `composite_sensitivity` descending. |
| `analysis` | `object` | Always | Conflict/synergy analysis (see [Analysis](#analysis)). |
| `config` | `object` | Always | Echo of active config: `{disciplines, weights}`. |
| `computation_ms` | `float` | Always | Wall-clock milliseconds. |
| `cache_hit` | `boolean` | Always | `true` if served from cache. |
| `stochastic` | `object` | Conditional | Monte Carlo results. **Present only when** `stochastic: true`. See [Stochastic](#stochastic). |

#### `objectives` Object

```jsonc
{
  "schedule": 145.0,     // Makespan
  "cost": 2500000.0,     // Total cost
  "risk": 0.42,          // Aggregate risk score
  "resources": 3.2,      // Resource utilization metric
  "quality": 0.95        // Quality score
}
```

Only the requested `disciplines` are included.

#### Sensitivity Entry

```jsonc
{
  "activity_id": "A1",
  "duration": 10.0,
  "total_float": 0.0,
  "on_critical_path": true,
  "crash_potential": 0.2,            // crash_max_fraction for this activity
  "sensitivities": {
    "schedule": {
      "duration_gradient": -1.0,     // d(objective)/d(duration)
      "resource_gradient": 0.003     // d(objective)/d(resources)
    },
    "cost": {
      "duration_gradient": 850.0,
      "resource_gradient": 100.0
    }
    // ... one entry per active discipline
  },
  "composite_sensitivity": 0.8543,   // Weighted sum of |gradients| across disciplines
  "rank": 1                          // 1 = most sensitive activity
}
```

#### Analysis

```jsonc
{
  "conflicts_and_synergies": [
    {
      "pair": ["schedule", "cost"],
      "cosine_similarity": -0.72,      // Duration gradient alignment (-1 to 1)
      "relationship": "conflict",      // "conflict" (<-0.3), "synergy" (>0.3), "independent"
      "description": "schedule and cost improvements oppose each other"
    }
  ],
  "interventions": [
    {
      "activity_id": "A1",
      "rank": 1,                       // 1 = highest leverage
      "score": 1.234,                  // Weighted gradient magnitude
      "normalized_score": 1.0,         // Normalized to [0, 1]
      "per_discipline": {              // Raw gradient magnitude per discipline
        "schedule": 0.85,
        "cost": 0.38
      },
      "recommendation": "high_priority"  // "high_priority" (>0.7), "moderate_priority" (>0.3), "low_priority"
    }
  ]
}
```

---

## POST /solver/optimize

L-BFGS-B gradient-descent optimization.  Adjusts activity durations to
minimize the weighted multi-objective function subject to crash constraints.
Optionally runs a Monte Carlo ensemble on the optimized state.

### Response

```
200 OK
Content-Type: application/json
```

#### Top-Level Keys

| Key | Type | Presence | Description |
|---|---|---|---|
| `initial_objectives` | `object` | Always | Pre-optimization objective values keyed by discipline. |
| `final_objectives` | `object` | Always | Post-optimization objective values. |
| `improvement` | `object` | Always | Per-discipline improvement percentage. Positive = improved. |
| `makespan` | `float` | Always | Final project duration. |
| `activity_changes` | `array<object>` | Always | Per-activity duration adjustments (see [Activity Change](#activity-change)). |
| `iterations` | `int` | Always | Actual iterations completed (`<= max_iterations`). |
| `converged` | `boolean` | Always | `true` if stopped before hitting `max_iterations`. |
| `history` | `array<object>` | Always | Per-iteration objective snapshot (see [History Entry](#history-entry)). |
| `config` | `object` | Always | Echo of active config: `{disciplines, weights, max_iterations}`. |
| `computation_ms` | `float` | Always | Wall-clock milliseconds. |
| `cache_hit` | `boolean` | Always | `true` if served from cache. |
| `stochastic` | `object` | Conditional | Monte Carlo results on optimized state. **Present only when** `stochastic: true`. See [Stochastic](#stochastic). |

#### Activity Change

```jsonc
{
  "activity_id": "A1",
  "baseline_duration": 10.0,
  "optimized_duration": 8.0,
  "duration_change_pct": -20.0,      // Negative = shortened
  "on_critical_path": true
}
```

#### History Entry

```jsonc
{
  "iteration": 1,
  "objectives": {
    "schedule": 140.0,
    "cost": 2550000.0
    // ... per active discipline
  }
}
```

---

## POST /solver/pareto

Pareto frontier sweep using augmented Tchebycheff scalarization across
weight vectors.  Returns only non-dominated (Pareto-optimal) solutions.

### Response

```
200 OK
Content-Type: application/json
```

#### Top-Level Keys

| Key | Type | Presence | Description |
|---|---|---|---|
| `frontier` | `array<object>` | Always | Pareto-optimal solutions (see [Frontier Point](#frontier-point)). |
| `n_frontier` | `int` | Always | Number of Pareto-optimal points. |
| `n_explored` | `int` | Always | Total weight vectors evaluated. |
| `config` | `object` | Always | Echo of active config: `{disciplines, n_vectors}`. |
| `computation_ms` | `float` | Always | Wall-clock milliseconds. |
| `cache_hit` | `boolean` | Always | `true` if served from cache. |

#### Frontier Point

```jsonc
{
  "index": 0,                        // Position in the weight vector sweep
  "weights": {                       // Weight vector for this solution
    "schedule": 0.8,
    "cost": 0.2
  },
  "objectives": {                    // Final objective values at this point
    "schedule": 130.0,
    "cost": 2800000.0
  },
  "durations": [8.0, 5.0, 12.0],    // Optimized duration per activity (index-aligned)
  "resources": [3.0, 2.0, 4.0],     // Optimized resource count per activity (index-aligned)
  "converged": true,
  "iterations": 35
}
```

**Note:** `durations` and `resources` arrays are index-aligned with the
input `nodes` array.

---

## Stochastic

Present in `sensitivity` and `optimize` responses when `stochastic: true`.
Uses Sobol quasi-Monte Carlo with five-tier risk distributions.

| Key | Type | Description |
|---|---|---|
| `objectives_mean` | `object` | Mean objective value per discipline over MC samples. |
| `objectives_std` | `object` | Standard deviation per discipline. |
| `n_samples` | `int` | Number of MC samples run. |
| `black_swans` | `array<object>` | Activities with extreme tail behavior (see below). |
| `dragon_kings` | `array<object>` | Outlier-among-outliers per Sornette (2009) (see below). |
| `sra` | `object` | Schedule Risk Analysis indices (see [SRA](#sra)). |
| `cost_schedule_joint` | `object` or `null` | 2D cost-schedule clustering. `null` if `cost` not in disciplines. See [Cost-Schedule Joint](#cost-schedule-joint). |

### Black Swan Entry

```jsonc
{
  "activity_id": "A5",
  "max_multiplier": 3.2,       // Largest raw duration multiplier observed
  "exceedance_count": 12,      // Samples near the cap (>= 95% of cap)
  "cap_hit_fraction": 0.12     // Fraction of samples near cap
}
```

### Dragon King Entry

```jsonc
{
  "activity_id": "A5",
  "multiplier": 3.2,            // The extreme multiplier value
  "sigma_above_mean": 4.1       // Standard deviations above the mean multiplier
}
```

### SRA

Schedule Risk Analysis indices from Monte Carlo simulation.

| Key | Type | Description |
|---|---|---|
| `criticality_index` | `object` | `{activity_id: float}`. Fraction of samples where the activity was on the critical path (Van Slyke, 1963). Range: 0.0-1.0. |
| `cruciality_index` | `object` | `{activity_id: float}`. Pearson correlation between activity duration multiplier and project makespan (Williams, 1992). Range: -1.0 to 1.0. |
| `makespan_mean` | `float` | Mean makespan across MC samples. |
| `makespan_std` | `float` | Standard deviation of makespan. |

### Cost-Schedule Joint

2D clustering of cost and schedule overruns (Natarajan et al., PMJ 2022).
`null` when `cost` is not in the active disciplines.

| Key | Type | Description |
|---|---|---|
| `clusters` | `array` | K-means cluster assignments and centroids. |
| `correlation` | `float` | Pearson correlation between schedule and cost overruns. |
| `schedule_overrun` | `object` | `{mean, std, p95}` — schedule overrun statistics. |
| `cost_overrun` | `object` | `{mean, std, p95}` — cost overrun statistics. |

---

## Error Responses

All solver endpoints share the same error format.

| Status | Body | Condition |
|---|---|---|
| `400` | `{"error": "<message>"}` | Validation failure (missing nodes, bad types, limit exceeded). |
| `413` | `{"error": "Payload too large (limit: 10 MB)"}` | Content-Length exceeds 10 MB. |
| `500` | `{"error": "Internal solver error"}` | Unhandled exception during analysis. |

### Validation Error Examples

```jsonc
{"error": "No nodes provided"}
{"error": "nodes[3] (ID=X): Duration must be a finite non-negative number"}
{"error": "Too many nodes (25000); limit is 20000"}
{"error": "links[5] references unknown source: Z99"}
{"error": "Duplicate activity ID: A1"}
{"error": "max_iterations must be 1-500"}
{"error": "monte_carlo_samples must be 1-1000"}
{"error": "disciplines must be a list of strings"}
```
