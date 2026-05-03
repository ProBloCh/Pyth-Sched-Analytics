# EVM Endpoint

Earned Value Management analysis: CPI, SPI, EAC, duration-weighted
progress, schedule-delay prediction, and time-phased cumulative +
period distributions (planned / actual / earned / predicted).

Served by the `evm/` Flask Blueprint (prefix `/evm`).  Extracted from
`Reference/EVM.js` (~3,100 LOC) -- the deterministic computation core
is now backend, while chart rendering, DOM updates and the `evmInit`
event stay frontend.

**Consumers:**
- JS frontend EVM tab (via `getCumulativeDistributionAsync` /
  `createActualEVMChartAsync` wrappers; original sync functions remain
  as fallback)
- `Reference/Completionprediction.js` line ~4871 reads
  `window.evmMetrics.actual.CPIcum` as a side-effect of the EVM tab
  being populated.  The `/evm/analyze` response preserves that key
  exactly so the read path is unchanged.

---

## POST /evm/analyze

Runs the full EVM computation and returns a dict that the JS wrapper
can drop into `window.evmMetrics` unchanged.  The response keys are
already camelCase (matching the existing `window.evmMetrics` shape)
so no key conversion is required on the JS side.

### Request

```jsonc
{
  "nodes": [
    {
      "ID": "1",                        // Required.  Unique.  Milestone
                                        //   conventionally has ID "0".
      "Start":     "2025-01-01",        // Baseline planned start.
      "Finish":    "2025-01-11",        // Baseline planned finish.
      "Duration":  10,                  // Required; 0 for milestones.
      "TimeUnits": "days",              // Optional.  "h"/"d"/"w"/"mo"/"y".
                                        //   Default: "Hours".
      "PercentComplete": 50,            // Optional.  0..100 (P6/MSP).
      "ActualStart":     "2025-01-01",  // Optional.  Progress-case 2.
      "ActualFinish":    "2025-01-08",  // Optional.  Progress-case 1.
      "ActualCost":      1200,          // Optional.  Used verbatim when
                                        //   positive; else imputed.
      "CostRate":        100,           // Optional.  Per-hour rate.
      "riskAdjustedStart": "2025-01-02",// Optional.  Forecasted branch.
      "riskAdjustedEnd":   "2025-01-15",
      "riskAdjustedDuration": 13,
      "predictedStart":    "2025-01-02",// Optional.  Case-4 future EV.
      "predictedEnd":      "2025-01-20",
      "Milestone": 0
    }
  ],
  "links": [
    { "source": "0", "target": "1",
      "type": "FS", "lag": 0, "lagUnits": "h" }
  ],
  "options": {
    "statusDate":         "2025-01-06T00:00:00Z",  // Required for dated metrics.
    "costRate":           100,                     // Project-default; per-node
                                                   //   CostRate overrides.
    "currency":           "USD",
    "project": { "sector": "construction" },       // Drives sector overrun lookup.
    "hoursPerDay":        8.0,
    "workingDaysPerWeek": 5.0
  }
}
```

### Response (200)

```jsonc
{
  "forecasted": {                 // Drop-in shape for evmMetrics.forecasted
    "BCWS": 40.0, "BCWP": 40.0, "ACWP": 4000.0, "BAC": 120.0, "EAC": 140.0,
    "SV": 0.0, "CV": -3960.0,
    "SPI": 1.0, "SPI_model": 1.0,       // Raw is null when PV=0 & EV>0 (JSON
                                        //   can't represent Infinity).  Treat
                                        //   null as "non-finite, use *_model".
    "CPIcum": 0.01, "CPIcum_model": 0.05,
    "flags": { "pvZeroWithEV": false, "acZeroWithEV": false },
    "percentComplete": 33.33,           // 0..100 scale
    "statusDate":   "2025-01-06T00:00:00+00:00",
    "currency":     "USD",
    "timeUnits":    "Hours",
    "distributionPlanned":           [{ "date": "2025-01-01", "hours": 0.0 }, ...],
    "distributionPlannedCost":       [{ "date": "2025-01-01", "cost":  0.0 }, ...],
    "distributionWithOverrun":       [{ "date": "...", "hours": ... }, ...],
    "distributionWithOverrunCost":   [...],
    "evDistribution":                [...],
    "evDistributionCost":            [...],
    "nonCumulativeDistributionPlanned":     [...],
    "nonCumulativeDistributionWithOverrun": [...],
    "nonCumulativeEvDistribution":          [...],
    "allDates": ["2025-01-01", "2025-01-08", ...]
  },
  "actual": {                     // Drop-in shape for evmMetrics.actual
    "BCWS": ..., "BCWP": ..., "ACWP": ..., "BAC": ..., "EAC": ...,
    "SV": ..., "CV": ..., "SPI": ..., "SPI_model": ...,
    "CPIcum": ..., "CPIcum_model": ...,      // <-- Read by Completionprediction.js
    "flags":            { ... },
    "percentComplete":  33.33,
    "statusDate":       "2025-01-06T00:00:00+00:00",
    "currency":         "USD",
    "durationWeightedProgress": {
      "plannedProgressPct":     33.3,
      "actualProgressPct":      33.3,
      "durationWeightedSPI":    1.0,
      "durationWeightedSPI_model": 1.0,
      "totalPlannedHours":      120.0,
      "plannedCompletedHours":  40.0,
      "actualCompletedHours":   40.0
    },
    "earnedSchedule": {                       // Lipke (2003) time-based EVM
      "earnedScheduleDays":  10.0,            // ES: where on the plan the
                                              //   current EV would have been earned
      "actualTimeDays":      14.0,            // AT: status_date - project_start
      "plannedDurationDays": 32.0,            // PD: project_finish - project_start
      "SPI_t":               0.714,           // ES / AT  -- raw, may be Inf
      "SPI_t_model":         0.714,           //   clamped to MIN_SPI..MAX_SPI
      "earnedScheduleDate":  "2025-01-11",    // ISO date of ES on the plan
      "TEAC_days":           44.8,            // Time-based EAC = max(AT, PD/SPI(t))
      "TEAC_date":           "2025-02-15",    // project_start + TEAC_days
      "projectStartDate":    "2025-01-01",
      "projectFinishDate":   "2025-02-02",
      "flags":               {}               // not_started, completed,
                                              //   no_baseline, status_before_start
    },
    "sectorScheduleOverrun":    0.25,        // From project.sector lookup
    "scheduleMultiplier":       1.0,
    "slipDays":                 0,
    "performanceDelta":         1.0,
    "actualDelayFactor":        1.0,
    "forecastedDelayFactor":    1.25,
    "frontierNodes":            ["1"],       // IDs of last-active activities
    "distributionActual":       [...],
    "distributionActualCost":   [...],
    "distributionEarned":       [...],
    "distributionEarnedCost":   [...],
    "distributionPredicted":    [...],
    "distributionPredictedCost":[...],
    "nonCumulativeDistributionActual":  [...],
    "nonCumulativeDistributionEarned":  [...],
    "allDates":                 [...],
    "transitionPointIndex":     27            // Index where future begins
  },
  "currency":       "USD",
  "computation_ms": 12.3,
  "cache_hit":      false
}
```

### Response (400)

```json
{ "error": "No nodes provided" }
```

Validation: nodes must be a non-empty list, no duplicate IDs, no
negative durations, links are objects, `options` is an object (or
absent).  Values that are "weird but survivable" on the JS side
(unknown link source/target, ActualCost of wrong type, etc.) are
handled gracefully inside the engine rather than rejected -- matching
the JS tolerance.

### Response (500)

Internal compute errors: `{"error": "Internal EVM service error"}`.

---

## Algorithm Notes (for reviewers)

### Four-case EV time-phasing

Matches `calculateTimePhasedEV` (EVM.js lines 215-299).  For each
activity and each date:

1. **Completed**: `ActualFinish <= day` -> full planned hours credited.
2. **In-progress (actual start known)**:
   - If `ActualFinish` also known -> linear interpolation over actual
     duration.
   - Else if `PercentComplete > 0` -> interpolate from `ActualStart`
     to `statusDate`, factor `PercentComplete` in.
3. **Has progress, no actual dates, `day <= statusDate`**: time-phase
   on planned dates, cap by `PercentComplete`.
4. **Future (`day > statusDate`)**: use `predictedStart` /
   `predictedEnd`; full credit once past the predicted end.

### Earned Schedule (Lipke 2003)

The cost-based `SPI = EV / PV` collapses to 1.0 at completion regardless
of how late the project actually finished, because once all work is
earned both EV and PV equal BAC.  Earned Schedule fixes this by
projecting EV horizontally onto the planned PV curve to find the **time**
at which the work currently earned should have been completed.

```
ES        = date on the planned curve where cumulative PV first equals current EV
AT        = (status_date - project_start) in calendar days
SPI(t)    = ES / AT                  // stays < 1 if the project is late, even at finish
TEAC(t)   = max(AT, PD / SPI(t))     // Lipke's IEAC(t); clamped >= AT
```

Implemented in `evm/metrics.py::compute_earned_schedule`.  Surfaced on
`actual.earnedSchedule` (additive; cost-SPI fields are unchanged).
Project start / finish dates are inferred as the earliest activity
`Start` and the latest activity `Finish`; the BCWS curve is sampled at
every Start/Finish boundary so linear interpolation between samples is
exact (BCWS is piecewise-linear in time).

### EAC tiers

Matches `calculateEAC` (EVM.js lines 1131-1161):

| % complete | Formula |
|---|---|
| < 10% | `BAC * 1.15` (early pessimistic) |
| > 90% | `AC + remaining` (trust actuals) |
| CPI outside `[0.8, 1.2]` | `AC + remaining / (CPI * SPI)` (blended) |
| else | `AC + remaining / CPI` (stable) |

Result clamped to `[max(AC, 0.8 * BAC), BAC * (2.5 if pct > 50 else 3.0)]`.

### Sector schedule overrun

Static table from EVM.js lines 731-770, derived from Flyvbjerg et al.
Oxford megaproject studies.  Lookup precedence:

1. Exact (lowercased) match on `project.sector` / `.projectType` /
   `.category` / `.industry`.
2. Substring match (e.g. "Oil and Gas Development" -> "oil and gas").
3. Explicit `project.scheduleOverrun > 0` fallback.
4. Default: 0.25 (25%).

### Infinity preservation on raw SPI / CPI

`SPI` and `CPIcum` (raw fields) return `Infinity` when PV or AC is
zero but EV is positive -- a data-quality signal matching EVM.js v5.
The `*_model` suffixed fields are clamped to the EVM config bounds
(`[0.05, 10]` for SPI, `[0.05, 20]` for CPI) and are what downstream
computation should use.

### Auto-complete start milestone

If any node has `ActualStart` set, a node with `ID == "0"` and
`Duration == 0` is treated as 100% complete (matches EVM.js FIX #9,
lines 1279-1319).  The backend clones the input nodes before patching
so the caller's list is never mutated.

### Predicted-date propagation

After computing schedule delay, the engine populates
`predictedStart` / `predictedEnd` / `predictedDuration` on each
activity by:

1. **Initial assignment** -- per-node 4-case logic (completed /
   100%-no-dates / in-progress / not-started).  Not-started nodes get
   shifted by `slipDays` and scaled by `performanceDelta`.
2. **Distance decay** -- BFS from frontier nodes (last-active
   activities); per-node performance delta is decayed by
   `0.85^distance`, so far-future activities don't carry the full
   slip multiplier.
3. **Topological propagation** -- walks the DAG and pushes each
   successor's `predictedStart` forward to satisfy FS/SS/FF/SF +
   lag constraints.

These dates feed the case-4 branch of `time_phased_ev`, which draws
the **predicted** portion of the actual-branch curve beyond the status
date.  Without this propagation, the predicted curve would be flat at
zero past `statusDate`.

### `riskAdjustedDatesProvided` flag

Top-level field on the response.  `true` when at least one node
carries `riskAdjustedStart`, `riskAdjustedEnd`, or
`riskAdjustedDuration`; otherwise `false`.  When `false`, the
forecasted branch is identical to the planned branch (BCWS / BCWP /
ACWP fall back to `Start` / `Finish` silently).  Consumers that show
"forecast vs plan" curves should hide the forecast trace when this
flag is `false`.

---

## JS Bugs Fixed (2026-04)

The Python port originally aimed for byte-for-byte parity with
`Reference/EVM.js`.  Diff testing revealed three real bugs in the JS
that produced different numbers in environments where they manifested.
Fixed in **both** implementations together:

### 1. Forecasted ACWP double-multiplied by `CostRate`

`getCumulativeDistribution` line 1723 originally:

```js
const ACWP = calculateForecastedACWP(workingNodes, statusDate) * CostRate;
```

`calculateForecastedACWP` already multiplies the per-node
`riskDuration` by `node.CostRate || 1`, so the second multiplication
inflated ACWP by the project `CostRate` factor whenever any node
carried an explicit `CostRate`.  Result: forecasted CPI looked
artificially low (project appeared over budget by a factor of the
cost rate).

Fix: drop the spurious second multiplication.  The actual branch
(line 1859) was already correct, so this only needed to change in the
forecasted branch.  Python engine never had the bug and now mirrors
the corrected JS pattern.

### 2. `calculateACWP` used `new Date()` instead of the status date

The cost-multiplier "expected progress" check (line 1108):

```js
const today = new Date();   // <-- wall clock!
const elapsedDays = differenceInCalendarDays(today, nodeStart);
```

Made the analysis **non-idempotent** -- running the same fixture two
days apart produced different ACWP because the wall-clock advanced.
The correct anchor for "what should be complete by now" is the
project's status date.

Fix: `calculateACWP` accepts an explicit `statusDate` parameter,
falling back to `window.cybereumState.dataDate` and finally to
`new Date()` for legacy callers.  The sync call site in
`createActualEVMChart` now passes `statusDate` explicitly.  Python
engine already used the status date; this brings JS to parity.

### 3. Distance decay silently skipped when `succMap` was missing

`updatePredictedValues_Improved` checked
`window.cybereumState?.succMap` and **skipped the distance-decay
step entirely** when it wasn't externally precomputed.  The
topological-propagation step had a Kahn's-algorithm fallback for
`topoOrder`, but decay had no equivalent.  Result: in environments
where the caller hadn't pre-populated `cybereumState.succMap` (unit
tests, isolated harnesses, possibly some load orderings of the main
app), all not-started activities used the full `plannedH * perfDelta`
instead of the distance-decayed `riskH * decayedDelta`.

Fix: build `succMap` inline from `links` when it isn't precomputed.
Distance decay now always runs.  Python engine already builds its
own succ_map; this brings JS to parity.

### Diff-test harness

`tests/test_evm_diff.py` (with helper `tests/diff_harness/run_js_evm.js`)
runs the JS reference implementation under Node.js on each fixture in
`tests/diff_harness/fixture_*.json` and asserts every scalar metric
matches the Python engine within `1e-6` relative tolerance, frontier
node sets are identical, and predicted dates agree within 24 h.
Skips automatically when Node.js is unavailable.

---

## Limits

| Limit | Value |
|---|---|
| Max payload | 10 MB |
| Max nodes | 20,000 |
| Max links | 100,000 |

## Caching

Lazy Redis / LRU bridge (shared with `solver/` and `completion/`).  Key:
`evm:analyze:<sha256 of request body>`.  Cached responses return with
`cache_hit: true`.

## GET /evm/health

```json
{ "status": "healthy", "module": "evm", "endpoints": ["/evm/analyze"] }
```

## What stays in the JS frontend

Out of scope for this endpoint (intentional):

- Chart.js rendering (`createSingleEVMChart`, cumulative vs.
  non-cumulative dual-chart logic).
- DOM updates (tables, insight panels, `#forecastedEVMetrics` /
  `#actualEVMetrics` HTML).
- Tab UI (`initializeEVMUI`, `evmInit` custom event).
- Currency / locale formatting.

The JS wrapper drops the response into `window.evmMetrics` and
`window.cybereumState.evmMetrics`, then calls the existing chart +
DOM helpers unchanged.
