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
    "calendar": {                     // Optional.  Enables working-calendar
                                      //   arithmetic when present.  Omit the
                                      //   whole "calendar" key (or all three
                                      //   fields below) for wall-clock mode.
      "hours_per_day": 8.0,           // Optional.  Working hours per working
                                      //   day.  Default: 8.0.
      "working_days": [1,2,3,4,5],    // Optional.  ISO weekdays that count as
                                      //   working (Mon=1..Sun=7).
                                      //   Default: [1,2,3,4,5].
      "holidays": [                   // Optional.  Dates that are NOT working
        "2025-07-04",                 //   days even if their weekday is.
        "2025-12-25"                  //   Accept "YYYY-MM-DD" or objects with
                                      //   a `.date` field.
      ]
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
  "teac": {                         // Stochastic Earned Schedule (Lipke 2003).
    "projectStartDate":    "2024-12-01T00:00:00+00:00",   // min(node.Start), null if absent
    "projectFinishDate":   "2025-03-01T00:00:00+00:00",   // max(node.Finish), null if absent
    "plannedDurationDays": 90.0,    // PD = baseline finish - baseline start.
                                    //   null when EITHER side missing
                                    //   (no synthesized PD from forecasts).
    "statusDate":          "2025-01-15T00:00:00+00:00",
    "actualTimeDays":      45.0,    // AT = max(0, status - project_start).
    "percentiles": {                // TEAC band per percentile, anchored at
                                    //   projectStartDate (NOT status_date).
      "p10": {"label": "P10",  "teac_days": 92.5,  "teac_date": "...",
              "spi_t": 0.973,  "spi_t_model": 0.973,  "impact_days": -3.5},
      // spi_t / spi_t_model are null when plannedDurationDays is null
      // (no baseline to compare against).
      "p20": {"...": "..."},
      "p50": {"label": "P50",  "teac_days": 102.3, "teac_date": "...",
              "spi_t": 0.880,  "spi_t_model": 0.880,  "impact_days": 11.3},
      "p80": {"label": "P80",  "teac_days": 115.0, "teac_date": "...",
              "spi_t": 0.783,  "spi_t_model": 0.783,  "impact_days": 24.0},
      "p95": {"...": "..."}
    },
    "deterministic": {              // No-risk-multiplier CPM midpoint of
                                    //   the MC band.  NOT the same number
                                    //   as /evm/analyze.actual.earnedSchedule
                                    //   .TEAC_date -- see `note` field.
      "teac_days":   100.0,
      "teac_date":   "2025-03-11T00:00:00+00:00",
      "spi_t":       0.900,
      "spi_t_model": 0.900,
      "source":      "mc_no_risk_cpm",
      "note":        "..."
    },
    "flags": {                      // Optional; absent fields are false.
      "no_baseline":         false, // True when no Start/Finish anywhere.
      "status_before_start": false, // True when status < project_start.
      "all_completed":       false  // True when nothing is in MC scope.
    },
    "method": "lipke_2003_stochastic",
    "crossReference": {             // Pointer back to the deterministic
                                    //   Lipke TEAC on the EVM endpoint.
      "evm_endpoint": "/evm/analyze",
      "evm_field":    "actual.earnedSchedule",
      "note":         "..."
    }
  },
  "computation_ms": 180.3,
  "cache_hit":      false
}
```

#### Stochastic TEAC composition

The `teac` block recasts the per-percentile finish dates as Lipke
(2003) time-based Estimate at Completion values:

```
TEAC_p_days   = (finish_p_date - projectStartDate) calendar days
SPI(t)_p      = plannedDurationDays / TEAC_p_days
                  (spi_t_model clamps to evm Bounds.MIN_SPI..MAX_SPI;
                   imported from evm.helpers.Bounds, currently 0.05..10.0,
                   so the clamp matches /evm/analyze atomically if the
                   bounds ever change)
impact_days_p = (finish_p_date - expected_finish) days
```

Reuses the same sorted MC samples that drive `p20_finish` /
`p50_finish` / `p80_finish` — no second pass.  The contribution is
**(a)** anchoring the percentiles at a baseline `projectStartDate`
(so duration is meaningful and an implied SPI(t) is computable) and
**(b)** surfacing the band as Lipke Earned Schedule, which lets a
consumer plot it next to the deterministic
`/evm/analyze.actual.earnedSchedule.TEAC_date`.

##### `deterministic` is NOT the same as `/evm/analyze`'s TEAC

`response.teac.deterministic.teac_date` is the **MC remaining-work
midpoint**: the CPM forward pass with all risk multipliers set to 1.
That is not the same number as `/evm/analyze.actual.earnedSchedule.
TEAC_date`, which is `max(AT, PD / SPI_t_model)` derived from the
cost-side EV vs PV intersection.  The two agree when no progress has
been recorded and `ExpectedStart == Start`, but diverge for in-progress,
out-of-sequence, or status-after-completion projects because they are
different computations.  `/evm/analyze` remains the authoritative
deterministic TEAC; this block's deterministic field exists so the
percentile band has a natural midpoint readable in one response.

This closes the loop on the codebase's research identity: instead of
a single deterministic SPI(t) clamped through evm Bounds, the customer
sees the five-tier-risk-model uncertainty band around it.  All the
existing fields (`p20_finish`, `expected_finish`, `spread_days`, ...)
stay byte-identical so the contract is purely additive.

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

## Reference-Class Calibration (Empirical Distribution Selection)

When `config.reference_class` is supplied, the MC switches from the
generic five-tier model to a sector-calibrated one drawn from
`solver/reference_classes.py`.  Each class encodes:

- **Tier-4 distribution choice**: `birnbaum_saunders` (Natarajan-validated
  for offshore O&G), `lognormal` (thin-tailed sectors per Flyvbjerg &
  Gardner 2023 — roads, solar, batteries), or `skip` (for IT / Olympics
  where α ≤ 1 makes BS empirically wrong; the normal tier extends
  directly to a low-α Pareto).
- **Pareto α range**: clamps the tail thickness per sector instead of
  the global `α = 2.0 + 1.5(1-r)` formula.  Lower α = fatter tail.
- **Max multiplier cap**: replaces the global 10× ceiling.  Olympics /
  IT can run 50×; nuclear new build 20×; thin-tailed sectors 3-5×.
- **Per-percentile inflation factors** (P50/P80/P95/P99): published RCF
  values from Flyvbjerg / Cantarelli / TII / Sovacool tables.  Applied
  to the OVERRUN portion of each percentile after the MC, so the
  deterministic baseline stays anchored at `expected_finish`.

### Supported reference classes (built-in)

`oil_gas_offshore`, `oil_gas_onshore_lng`, `nuclear_new_build`,
`nuclear_decommissioning`, `rail`, `tunnels`, `bridges_fixed_links`,
`roads`, `buildings_standard`, `buildings_nonstandard`, `defense_mdap`,
`it_software`, `olympics`, `mining`, `solar_pv`, `wind_onshore`,
`wind_offshore`, `battery_storage`, `data_centre_hyperscale`.  Common
aliases (`oil and gas` → `oil_gas_offshore`, `infrastructure` → `rail`,
`nuclear` → `nuclear_new_build`, etc.) are accepted.  Use the
discovery endpoint (below) to fetch the live list, including
environment-loaded extensions.

### Extensibility (5 mechanisms)

The 19 built-ins won't fit every customer.  Five layers of extension
are available, with later layers winning over earlier ones:

| Mechanism | Who controls | Persistence | Use case |
|---|---|---|---|
| Built-in 19 sectors | Pyth team (source code) | committed | published RCF data |
| `PYTH_REFERENCE_CLASSES_PATH` env var | Ops at deploy time | per-environment | customer-tenant calibrations bundled with deploy |
| `config.custom_reference_classes` request field | API caller | per-request | one-off custom class without ops involvement |
| `config.reference_class_overrides` (`{base, overrides}`) | API caller | per-request | tweak a built-in for a single project |
| `GET /completion/reference-classes` discovery | Frontend | read-only | populate sector dropdowns dynamically |

#### Env-var extension

Set `PYTH_REFERENCE_CLASSES_PATH=/etc/pyth/customer_classes.json` in
the deploy environment.  The file is a JSON object mapping class
names to parameter dicts (same schema as the built-in entries).
Loaded once at module import.  Invalid entries are skipped with a
log warning so one bad row doesn't break loading.

#### Per-request custom classes

```jsonc
{
  "config": {
    "reference_class": "customer_acme_petrochem",
    "custom_reference_classes": {
      "customer_acme_petrochem": {
        "fat_tail_from":      0.50,
        "pareto_offset":      0.20,
        "pareto_alpha_range": [1.7, 2.3],
        "tier_4_distribution": "birnbaum_saunders",
        "percentile_factors": {"P50": 1.15, "P80": 1.40,
                                "P95": 1.85, "P99": 2.80},
        "max_multiplier_cap": 12.0,
        "mean_overrun":       0.40,
        "is_fat_tailed":      true,
        "has_finite_mean":    true,
        "citations":          ["ACME internal portfolio analysis 2026"]
      }
    }
  }
}
```

A custom class with the same name as a built-in **shadows** the
built-in for that request.  Validated against the same schema as
built-ins; malformed entries return a 400 with the specific field
that broke (e.g. `fat_tail_from must be in [0, 1] (got 1.5)`).

#### Per-request overrides

For a one-off tweak of a built-in:

```jsonc
{
  "config": {
    "reference_class_overrides": {
      "base": "rail",
      "overrides": {
        "percentile_factors": {"P95": 2.5, "P99": 4.0}
      }
    }
  }
}
```

The `overrides` dict is deep-merged onto a copy of the base class.
`percentile_factors` is merged at the per-percentile level so you
can override just P95 without rewriting P50/P80.  The merged result
is validated; any out-of-range value is rejected.

#### Discovery endpoint

```
GET /completion/reference-classes  →  200
{
  "classes": [
    {
      "name": "data_centre_hyperscale",
      "mean_overrun": 0.30,
      "is_fat_tailed": true,
      "has_finite_mean": true,
      "tier_4_distribution": "birnbaum_saunders",
      "pareto_alpha_range": [1.9, 2.6],
      "max_multiplier_cap": 8.0,
      "percentile_factors": {"P50": 1.10, "P80": 1.40,
                              "P95": 1.85, "P99": 2.75},
      "citations": ["JLL 2026 Global Data Center Outlook", ...],
      "version": null
    },
    ...
  ],
  "aliases": {"oil_and_gas": "oil_gas_offshore", ...},
  "builtin_count": 19,
  "external_count": 0,
  "external_path": ""
}
```

Frontends should call this once on page load and cache it.  A JS
helper `window.fetchReferenceClasses()` is provided in
`Reference/Completionprediction.js` that does the fetch + caches.

### Error handling

Invalid `reference_class` returns 400 with a fuzzy suggestion when
one exists:

```
config.reference_class "oilgaz" not recognised. did you mean: oil_gas_offshore?
```

When no fuzzy match crosses the 0.5 ratio cutoff, the full list of
supported classes is included instead.  Custom-class validation
errors enumerate every broken field:

```
config.custom_reference_classes: class 'broken': missing required key
'pareto_offset'; class 'broken': missing required key 'tier_4_distribution';
class 'broken': fat_tail_from must be in [0, 1] (got 1.5); class
'broken': pareto_alpha_range values should be in [0.5, 5.0]
```

Partial classes (missing some percentile factors) are accepted with
a `partial_percentile_factors` warning in `calibration_warnings[]`;
missing factors default to 1.0 (no calibration shift) and `P99`
defaults to `null`.

When set, the response gains a `reference_class_calibrated` companion
with the empirically-corrected percentiles AND the citations behind
each parameter.  When NOT set, the response carries a
`no_reference_class` info-level entry in `calibration_warnings[]`.

### What this addresses

Empirical project research (Flyvbjerg & Bester 2021; Aaen, Flyvbjerg
et al. 2025; Cantarelli RCF review 2025; Project Production Institute
2024) has shown that judgment-derived MC inputs produce P80 estimates
that empirically behave like P10-P20.  The reference-class layer
addresses this in three complementary ways:

1. **Per-class Pareto α and looser caps** mean the MC samples actually
   reach the empirical tail extremes for fat-tailed sectors.
2. **Per-percentile factors** anchor the reported P50/P80/P95 to
   published outturn distributions, not just the model's internal
   percentiles.
3. **Calibration warnings** surface the input-quality concerns the
   critics name (judgment-default risk, no supply-chain
   classification, infinite-mean reference class, judgement parameters
   for sectors without peer-reviewed fits like data centres).

Per Aaen / Flyvbjerg 2025: for IT and Olympics (α ≤ 1, infinite mean
& variance), **any single percentile is unstable**.  The response
reports `p99_finish: null` with the `infinite_mean_reference_class`
warning rather than fabricating a number.  The recommended action in
those classes is to cap exposure (modular delivery, stop-loss) rather
than predict the tail.

### Percentile-factor semantics (honest caveat)

The percentile-factor calibration scales the **overrun portion** of
each percentile, not the absolute finish date.  Concretely:

```
calibrated_p80 = expected_finish + (model_p80 - expected_finish) * factor_P80
```

Two implications worth being explicit about:

1. **The published Flyvbjerg / Cantarelli / TII tables were calibrated
   against deterministic point estimates** (e.g. "to absorb a 20% chance
   of overrun, multiply your point estimate by X").  We're applying
   them to MC-output overrun.  If the underlying MC already produces
   a wider-than-baseline distribution, this could partially
   double-count uncertainty.  Without a customer-specific calibration
   loop (see `/completion/calibration-report`), we don't yet know the
   magnitude of this bias for any given sector.

2. **When `model_finish == expected_finish`** (no model-side overrun),
   the calibrated finish equals the model finish regardless of factor.
   This is intentional -- the calibration shouldn't manufacture
   overrun where the model says there is none -- but it also means
   for very early-phase / very low-risk projects the calibrated
   percentiles can look identical to the raw model.

The honest end-state is to use the **empirical CDF transform**
(option (h) from the design discussion) rather than per-percentile
factors: take the customer's accumulated outcome distribution from
`/completion/calibration-report` and remap MC percentiles directly.
That's not implemented yet -- documented in `REMAINING_WORK.md`.

### Outcome registration (foundation for empirical calibration)

`POST /completion/register-outcome` stores per-project predicted-vs-
actual records; `GET /completion/calibration-report` aggregates them
into ratios per reference class.  When the mean ratio for a class
exceeds 1.3, the report emits a "P80 acts like P10" advisory --
the LinkedIn-discussion signature -- and the customer can tighten
the corresponding `percentile_factors` via a custom class or
override.

### Model vs reality

Even with reference-class calibration in place, the published P80 is a
model prediction of the 80th percentile of the assumed distribution
for the chosen reference class.  It is not a guarantee about your
specific project.  Three structural caveats remain:

- **Inputs are still partly judgmental.**  The activity-level
  `riskScore` is an analyst-assigned 0..1 value, not an empirical
  probability.  The `calibration_warnings[]` field flags when scores
  cluster at the 0.5 default or have low variance.
- **Distributions vary with time and culture.**  The published
  parameters are calibrated to historical megaproject data; your
  organisation's recent performance may differ.  Without per-customer
  outcome ingestion (a planned future endpoint), the model cannot
  Bayesian-update from your actuals.
- **Reference-class fit per sector is uneven.**  Birnbaum-Saunders is
  Natarajan-validated only for offshore O&G; other "BS" assignments
  in the table are by analogy.  Data centres / hyperscale have no
  peer-reviewed distribution fit — the parameters there are
  practitioner-report-calibrated and flagged
  (`reference_class_judgement` warning).

These limits mirror the ones that David Porter, Roger Bradfield,
Andrew Cooper, Michael Trumper and André Cavalcanti raised in their
2026 LinkedIn discussion on MC misuse in capital projects.  The
reference-class layer is the practical step we can take without
customer-specific historical data; full Bayesian calibration would
require a register-outcome endpoint and 6-12 months of in-flight
project tracking before becoming meaningful.

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

## Calendar Semantics

**When `project_context.calendar` is supplied** (any of `hours_per_day`,
`working_days`, `holidays` present), durations are interpreted as working
time and propagation skips non-working days:

- `Duration: 10, TimeUnits: "days"` with `hours_per_day: 8` means 10
  working days = 80 working hours.  At a 5×8 calendar this lands on the
  second Monday after the start (10 Mon–Fri work days).
- `TimeUnits: "weeks"` → `Duration × hours_per_day × 5` (working weeks).
- `TimeUnits: "months"` → `Duration × hours_per_day × 21` (working months,
  matching the frontend `convertToHours` convention).
- Link `lag` is always interpreted as **working hours** when a calendar
  is present (matching the JS `lagUsesWorkingCalendar` default).
- Non-working `earliest_start` values are normalised forward to the start
  of the next working day (matching JS `_normalizeWeekendForward`).

**When `project_context.calendar` is absent or empty**, durations are
wall-clock (1 day = 24 hours, 1 week = 7 days, 1 month = 30 days); lag
is wall-clock hours.  This is the V1 backwards-compatible path.

The deterministic CPM finish returned in `expected_finish` uses the same
calendar logic as the Monte Carlo propagation, so P20/P50/P80 deltas
(`p20_impact_days` etc.) reflect pure stochastic risk, not calendar
drift.

## Differences From the Frontend Implementation

The Python backend produces calendar-equivalent results to
`Reference/Completionprediction.js` (same weekend/holiday skipping, same
working-hour interpretation), but with one deliberate RNG difference:

- **RNG**: uses Sobol quasi-Monte Carlo (`scipy.stats.qmc.Sobol`, scrambled
  with `seed`) instead of the Murmur3/FNV-1a hash used in the browser.
  Sobol has lower discrepancy at the same iteration count, so percentile
  estimates stabilise faster.  Individual sample values will differ from
  JS, but the percentile distribution converges to the same answer.

## Limits

| Limit | Value |
|---|---|
| Max payload | 10 MB |
| Max nodes | 20,000 |
| Max links | 100,000 |
| Max iterations | 5,000 |

---

## POST /completion/recovery-options

Produces a ranked list of schedule-recovery options -- crash candidates
and lag-compression opportunities -- targeting the gap between the
expected project finish and the baseline plan, plus an optional
P80-based risk buffer.

Extracted from `Reference/Completionprediction.js`
(`buildCrashOptions`, lines ~2062-2300).  Designed to compose with
`/completion/monte-carlo` output: pass the MC's `p80_finish` to include
a risk buffer in the target; omit it for a pure overrun-only target.

### Request

```jsonc
{
  "nodes": [                          // Required.  Same schema as /monte-carlo
    {                                 //   (Duration, TimeUnits, PercentComplete,
      "ID": "A1",                     //   ActualFinish, Name, SupplierType).
      "Duration": 10,
      "TimeUnits": "days",
      "PercentComplete": 0.25,
      "ActualFinish": null,
      "Name": "Install Foundation",   // Optional.  Used for crash-profile
                                      //   classification (regex-matched).
      "SupplierType": "external_equipment",  // Optional.  Overrides name
                                      //   classification with a tighter
                                      //   max-crash fraction.
      "ComputedImportanceScore": 0.7, // Optional.  0..1.  Factors into crash
                                      //   score: score ~= remaining_hrs *
                                      //   leverage * (0.55 + 0.45*importance).
      "Milestone": false              // Optional.  Milestones are excluded.
    }
  ],
  "links": [                          // Optional.  Same schema as /monte-carlo
    {                                 //   plus optional "lagUnits" ("h"/"d"/"w"),
      "source": "A0",                 //   default "h" to match
      "target": "A1",                 //   Reference/Completionprediction.js
      "type": "FS",                   //   getLagInHours().
      "lag": 48,
      "lagUnits": "h"
    }
  ],
  "status_date": "2025-01-15T00:00:00Z",   // Required.  Same semantics as
                                      //   /monte-carlo (anchor for remaining
                                      //   work).
  "planned_finish":   "2025-02-20T00:00:00Z",  // Optional.  Baseline plan date.
                                      //   overrun_days = max(0, expected - planned).
                                      //   If absent, overrun_days = 0 (scenario mode).
  "expected_finish":  "2025-03-01T00:00:00Z",  // Optional.  Deterministic CPM
                                      //   finish (risk off).  If absent,
                                      //   backend computes it via
                                      //   run_completion_mc(enable_risk=false).
  "p80_finish":       "2025-03-15T00:00:00Z",  // Optional.  From prior
                                      //   /completion/monte-carlo call.
                                      //   risk_buffer_days = min(cap, p80 - expected).
                                      //   If absent, risk_buffer_days = 0.
  "activity_metadata": { "...": "..." },   // Optional.  Same schema as
                                      //   /monte-carlo (importance_score,
                                      //   supplier_type).
  "project_context": {                // Optional.  Calendar is reused
    "calendar": {                     //   identically to /monte-carlo
      "hours_per_day": 8.0,           //   (target_hours = target_days * hpd,
      "working_days": [1,2,3,4,5],    //   lag unit-conversion).
      "holidays": ["2025-07-04"]
    }
  },
  "config": {                         // Optional.  All numeric, all bounded.
    "max_risk_buffer_days":         10,    // Cap on (p80 - expected). Default: 10.
    "max_recovery_options":         18,    // Top-N crash options returned.  Default: 18.
    "max_lag_options":              10,    // Top-N lag options returned.  Default: 10.
    "min_crashable_hours":          16,    // Filter: remaining_hrs must be >=. Default: 16.
    "min_lag_days_for_compression": 2,     // Filter: lag_days must be >=. Default: 2.
    "lag_compression_factor":       0.5    // savings = lag * factor.  Default: 0.5.
  }
}
```

### Response (200)

```jsonc
{
  "status_date":      "2025-01-15T00:00:00+00:00",
  "planned_finish":   "2025-02-20T00:00:00+00:00",  // null if not supplied.
  "expected_finish":  "2025-03-01T00:00:00+00:00",  // echoed or CPM-computed.
  "p80_finish":       "2025-03-15T00:00:00+00:00",  // null if not supplied.
  "overrun_days":       9.0,         // max(0, expected - planned) wall-clock days.
  "risk_buffer_days":  10.0,         // min(max_risk_buffer_days, max(0, p80-expected)).
  "target_days":       19.0,         // overrun + capped buffer (or buffer only if
                                     //   no overrun -- "scenario mode").
  "target_hours":     152.0,         // target_days * hours_per_day.
  "achieved_days":     12.5,         // Approximate recovery from the packaged
                                     //   options (sum crash_hours / hpd).
  "achieved_hours":   100.0,
  "is_scenario_mode": false,         // True iff overrun_days == 0.  When true,
                                     //   options surface compressible activities
                                     //   for proactive planning rather than a
                                     //   fixed recovery target.
  "recovery_options": [              // Top-N crash options.  Packaged from the
    {                                //   highest-scoring crash_candidates until
      "id":                   "crash_A1",    // target_hours is consumed.
      "type":                 "duration_crash",
      "title":                "Crash: Install Foundation",
      "target_activity_id":   "A1",
      "activity_name":        "Install Foundation",
      "kind":                 "construction",
      "crash_hours":          33.6,
      "potential_savings_days": 4,   // max(1, round(crash_hours / hpd)).
      "leverage":             1.0,
      "is_on_critical_path":  true,
      "float_days":           0.0,
      "effort":               "medium",   // low (<3d) / medium (3-7d) / high (>=7d).
      "risk":                 "high",     // high if score > 200, else medium.
      "rationale":            ["On critical path", "construction"]
    }
  ],
  "lag_options": [                   // Top-N lag-compression options.
    {
      "id":                    "lag_0",
      "type":                  "lag_compression",
      "title":                 "Install A -> Install B",
      "edge_id":               "A1->B1",
      "source_id":             "A1",
      "target_id":             "B1",
      "relation_type":         "FS",
      "current_lag_hours":     48.0,
      "current_lag_days":      6.0,
      "potential_savings_days": 3,   // max(1, round(savings_hrs / hpd)).
      "is_on_critical_path":   true,
      "effort":                "low",
      "risk":                  "medium"
    }
  ],
  "crash_candidates": [              // Raw, unpackaged list.  All crash
    { "id": "A1", "kind": "construction", "remaining_hrs": 120.0,
      "max_crash_hrs": 33.6, "leverage": 1.0, "is_on_critical_path": true,
      "float_days": 0.0, "score": 93.0, "importance": 0.5, "name": "..." }
  ],                                 //   candidates that passed all filters,
                                     //   sorted by score desc.  Kept for
                                     //   downstream UI / enrichment.
  "lag_candidates":   [ "..." ],     // Raw lag list, same pattern.
  "notes": "Target: recover 9d delay + 10d risk buffer",  // Human-readable.
  "config":  { "...": "..." },       // Echo of resolved config.
  "computation_ms": 2.1,
  "cache_hit": false
}
```

### Filtering Rules (applied in the engine)

**Crash candidates:**
1. Activity must have an ID in the graph.
2. Not a milestone (`Milestone` truthy).
3. `ActualFinish` not set.
4. `remaining_hrs >= config.min_crashable_hours` (default 16).
5. `max_crash_hrs >= 8` after applying the crash-profile fraction.
6. If **not on the critical path** and `float_days > 10`, dropped (too
   much slack to make the option worth surfacing).

**Lag candidates:**
1. Both endpoints in the graph.
2. `lag_days >= config.min_lag_days_for_compression` (default 2).
3. If **not a critical-path edge** and `lag_days < 5`, dropped.

### Crash Profiles

Classification precedence: explicit `SupplierType` > regex on
`Name` > default.  Matches the JS `classifyCrashProfile`.

| Input | `kind` | `max_frac` |
|---|---|---|
| `SupplierType = "external_equipment"` | external_equipment | 0.03 |
| `SupplierType = "external_material"`  | external_material  | 0.05 |
| `SupplierType = "external_service"`   | external_service   | 0.10 |
| Name matches `/permit\|approval\|regulat\|review\|sign/i` | governance | 0.08 |
| Name matches `/procure\|purchase\|delivery\|ship\|vendor/i` | procurement | 0.12 |
| Name matches `/design\|engineer\|ifc\|draw\|model/i` | engineering | 0.18 |
| Name matches `/fabricat\|shop\|weld\|machine\|prefab/i` | fabrication | 0.22 |
| Name matches `/install\|erect\|construct\|civil\|mech\|elect\|pipe/i` | construction | 0.28 |
| Name matches `/test\|commission\|start.?up\|turnover/i` | commissioning | 0.20 |
| (no match) | generic | 0.25 |

**Known quirk (preserved for JS parity):** the governance regex includes
`sign`, which accidentally matches `de-sign`.  An activity named "Design
Drawings" classifies as **governance** (8%), not **engineering** (18%).
To force engineering classification, use a name like "Engineering
Drawings" or supply an explicit metadata entry.

### Response (400)

```json
{ "error": "status_date is required (ISO-8601)" }
```

Validation covers: missing nodes / status_date, duplicate IDs, negative
durations, unknown link source/target, non-string date fields, and
out-of-range config values (`max_risk_buffer_days` 0..365,
`lag_compression_factor` 0..1, etc.).

### What is NOT Included

The JS `buildCrashOptions` also triggers two frontend-specific flows
that are intentionally out of scope for this endpoint:

- **AI enrichment** against `/OpenAI/EnrichCrashCandidates` and
  `/OpenAI/EnrichRiskCandidates`.  Those stay in the frontend (rate-limit
  sensitive, UI-scoped).
- **`riskMitigationOptions`** (risk-register cards).  Separate concern
  from recovery; different data source.

Callers that need enrichment can take the `crash_candidates` /
`lag_candidates` arrays from the response and feed them into the
enrichment pipeline themselves.

---

## GET /completion/health

```json
{
  "status": "healthy",
  "module": "completion-forecast",
  "endpoints": [
    "/completion/monte-carlo",
    "/completion/recovery-options"
  ]
}
```

## Caching

Responses are cached via the same Redis / LRU bridge as the solver
endpoints (lazy-imported from `app.py`).  Cache keys:
`completion:mc:<sha256>` and `completion:recovery:<sha256>` over the
respective request bodies.  Cached responses return with
`cache_hit: true`.
