# Completion Forecast Endpoint

Remaining-work Monte Carlo simulation producing calendar-based P20/P50/P80
project finish dates.  Served by the `completion/` Flask Blueprint (prefix
`/completion`).

Backed by the same five-tier risk distribution model used in
`/solver/sensitivity` (Natarajan & Flyvbjerg, PMJ 2022; Flyvbjerg et al.,
JMIS 2022) and extracted from the previous frontend implementation in
`Reference/Completionprediction.js` (`runMonteCarloRemaining`).

**Consumers:** JS frontend (replacing in-browser MC loop), C# backend

---

## POST /completion/monte-carlo

Simulates remaining work from a given status date, perturbing each
activity's remaining duration by a risk-gated random multiplier, and
returns finish-date percentiles for the project and each in-scope
activity.

### Request

```jsonc
{
  "nodes": [                          // Required.  Activity list.
    {
      "ID": "A1",                     // Required.  Unique identifier.
      "Duration": 10,                 // Required.  Total duration (see TimeUnits).
      "TimeUnits": "days",            // Optional.  "h"/"hours", "d"/"days",
                                      //   "w"/"weeks", "m"/"months". Default: hours.
      "PercentComplete": 0.4,         // Optional.  0..1 or 0..100.  Default: 0.
      "ExpectedStart": "2025-02-01T00:00:00Z",  // Optional.  ISO-8601.  If later
                                      //   than status_date, delays start.
      "ActualFinish": "2025-01-10T00:00:00Z",   // Optional.  If set, activity
                                      //   is excluded from MC scope.
      "riskScore": 0.4,               // Optional.  0..1 combined risk (matches
                                      //   JS convention).  Falls back to
                                      //   ComputedRiskScore, then to
                                      //   activity_metadata.combined_risk_score/10.
      "SupplierType": "external_equipment"  // Optional.  Triggers lower fat-tail
                                      //   thresholds.  Values: "external_equipment",
                                      //   "external_material", "external_service".
    }
  ],
  "links": [                          // Optional.  Dependency relationships.
    {
      "source": "A0",                 // Required.  Predecessor activity ID.
      "target": "A1",                 // Required.  Successor activity ID.
      "type": "FS",                   // Optional.  "FS"/"SS"/"FF"/"SF". Default: "FS".
      "lag": 0                        // Optional.  Lag in hours.  Default: 0.
    }
  ],
  "status_date": "2025-01-15T00:00:00Z",  // Required.  Anchor for remaining
                                      //   work.  All simulated starts are
                                      //   clamped to this date.
  "activity_metadata": {              // Optional.  Per-activity enrichment.
    "A1": {
      "combined_risk_score": 5.0,     // Optional.  0..10 (solver convention).
                                      //   Used only if node.riskScore absent.
      "activity_type": "equipment"    // Optional.  Lowercased, used for fat-tail
                                      //   threshold (equipment 0.35, material 0.40,
                                      //   service 0.45, default 0.55).
    }
  },
  "project_context": {                // Optional.  Project-level settings.
    "calendar": {
      "hours_per_day": 8.0            // Optional.  Reserved for a future
                                      //   working-calendar extension.
                                      //   V1 treats durations as wall-clock.
    }
  },
  "config": {                         // Optional.  MC configuration.
    "iterations": 500,                // Optional.  1..5000.  Default: 500.
    "seed": 42,                       // Optional.  Sobol QMC seed.  Default: 42.
    "antithetic": true,               // Optional.  Use antithetic pairs. Default: true.
    "enable_risk": true,              // Optional.  If false, collapses to
                                      //   deterministic CPM (P20=P50=P80). Default: true.
    "thresholds": {                   // Optional.  Risk-tier gates (0..1).
      "no_risk_below": 0.06,          //   Default: 0.06.
      "normal_from": 0.18,            //   Default: 0.18.
      "fat_tail_from": 0.55           //   Default: 0.55.
    },
    "caps": {                         // Optional.  Duration-multiplier caps.
      "min_mult": 0.95,               //   Floor.  Default: 0.95.
      "max_mult_base": 2.0,           //   Low/moderate cap.  Default: 2.0.
      "max_mult_high": 6.0            //   High-risk / long-lead cap.  Default: 6.0.
    }
  }
}
```

### Response (200)

```jsonc
{
  "status_date":      "2025-01-15T00:00:00+00:00",  // Echo of input (normalized).
  "expected_finish":  "2025-03-01T00:00:00+00:00",  // Deterministic CPM finish
                                                    //   from status_date (risk off).
  "p20_finish":       "2025-03-04T12:00:00+00:00",  // 20th-percentile finish.
  "p50_finish":       "2025-03-12T08:00:00+00:00",  // Median finish.
  "p80_finish":       "2025-03-25T00:00:00+00:00",  // 80th-percentile finish.
  "spread_days":      20.5,                         // (P80 - P20) in days.
  "p20_impact_days":  3.5,                          // (P20 - expected) in days.
  "p50_impact_days":  11.3,                         // (P50 - expected) in days.
  "p80_impact_days":  24.0,                         // (P80 - expected) in days.
  "distribution_stats": {
    "mean_finish": "2025-03-12T18:00:00+00:00",
    "std_days":    7.4,
    "min_finish":  "2025-03-01T00:00:00+00:00",
    "max_finish":  "2025-04-15T00:00:00+00:00"
  },
  "activity_percentiles": {                         // Per-activity finish percentiles.
    "A1": {                                         //   Only in-scope activities appear.
      "p20": "2025-01-25T00:00:00+00:00",
      "p50": "2025-01-27T12:00:00+00:00",
      "p80": "2025-02-01T00:00:00+00:00",
      "mean_days_from_status": 13.2                 //   Mean finish offset from status_date.
    }
  },
  "scope_size":     42,             // Number of activities with remaining work.
  "iterations":     500,            // Actual MC samples executed (may differ
                                    //   from requested when antithetic=true,
                                    //   rounded to even count).
  "seed":           42,
  "config":         { "...": "..." },  // Echo of resolved config.
  "computation_ms": 180.3,
  "cache_hit":      false
}
```

### Response (400)

Returned when the request fails validation.  Body:

```json
{ "error": "status_date is required (ISO-8601)" }
```

Validation errors include: missing `nodes` / `status_date`, duplicate IDs,
negative durations, unknown link source/target, `config.iterations` out of
range (1..5000), and threshold values outside [0, 1].

### Response (500)

Unexpected internal errors return `{"error": "Internal completion-service
error"}` with HTTP 500.  Consult server logs for the stack trace.

---

## Scope Rules

An activity is **in scope** (subject to MC perturbation) iff:

1. It has no `ActualFinish` field, AND
2. Its remaining duration (`Duration * (1 - PercentComplete)`) is > 0.

Activities with `ActualFinish` are treated as complete and do not
contribute to the simulated finish date (but remain as potential
predecessors in the DAG — their stored `ActualFinish` is not currently
used to anchor successor starts; this is a known gap and matches the
Reference frontend behavior).

When **all** activities are finished, the endpoint returns `scope_size: 0`
with P20 = P50 = P80 = latest `ActualFinish` and `spread_days: 0`.

## Risk-Tier Model

Same five-tier model as `solver/stochastic.py`:

| Risk range          | Distribution         | Source |
|---------------------|----------------------|---|
| `< no_risk_below`   | No perturbation (mult = 1) | — |
| `< normal_from`     | Triangular (right-skewed, bounded) | — |
| `< fat_tail_from`   | Normal (σ ∝ risk) | — |
| `< fat_tail_from + 0.25` | Birnbaum-Saunders | Natarajan et al., PMJ 2022 (KS p=.89 O&G) |
| `≥ fat_tail_from + 0.25` | Pareto power-law | Flyvbjerg et al., JMIS 2022 (α ≈ 2.35) |

Supply-chain activities (`activity_type` ∈ {equipment, material,
materials, service, services}) hit the fat-tail threshold earlier
(equipment: 0.35, material: 0.40, service: 0.45).

## Caps

Duration-sensitive caps prevent unrealistic multipliers:

- Short / low-risk activities: capped at `max_mult_base` (default 2.0×).
- Long (≥ 210 days) and high-risk (≥ 1.0): capped at `max_mult_high`
  (default 6.0×).
- Interpolation blend:
  `t = 0.6 * clamp01((risk - 0.5)/0.5) + 0.4 * clamp01((dur_days - 30)/180)`
  `cap = lerp(max_mult_base, max_mult_high, t)`

## Differences From the Frontend Implementation

The Python backend produces equivalent distributional results but differs
from `Reference/Completionprediction.js` in two ways:

1. **RNG**: uses Sobol quasi-Monte Carlo (`scipy.stats.qmc.Sobol`, scrambled
   with `seed`) instead of the Murmur3/FNV-1a hash used in the browser.
   Sobol gives better space-filling at the same iteration count, so
   percentile estimates stabilize faster.
2. **Calendar**: V1 treats durations as wall-clock time (24-hour days).
   The frontend uses a working-hour calendar (`addWorkingHours`).  A
   future extension can plug into `_duration_to_ms` and the propagation
   loop to add working-calendar awareness.

## Limits

| Limit | Value |
|---|---|
| Max payload | 10 MB |
| Max nodes | 20,000 |
| Max links | 100,000 |
| Max iterations | 5,000 |

---

## GET /completion/health

```json
{
  "status": "healthy",
  "module": "completion-forecast",
  "endpoints": ["/completion/monte-carlo"]
}
```

## Caching

Responses are cached via the same Redis / LRU bridge as the solver
endpoints (lazy-imported from `app.py`).  Cache key: `completion:mc:<sha256
of request body>`.  Cached responses return with `cache_hit: true`.
