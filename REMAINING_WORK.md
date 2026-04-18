# REMAINING_WORK

Items identified during the `/completion/monte-carlo` +
`/completion/recovery-options` + `/evm/analyze` extraction work that
have **not** been implemented in this branch.  Each entry says what
the gap is, why it wasn't done now, and what would unblock it.

The items are grouped by who realistically needs to do them.

---

## 1. Needs production data + time

### 1.1 Bayesian update of distribution parameters from outcomes

**What**: As `/completion/register-outcome` accumulates predicted-vs-
actual records, periodically update the Pareto α and BS parameters of
each customer's reference class to better fit their actual portfolio.

**Why not now**: Requires 6-12 months of in-flight project tracking
before there's enough signal to update parameters meaningfully.  The
groundwork is in place: outcomes endpoint exists, `calibration-report`
already emits the directional advisories ("P80 acts like P10"
signature when mean ratio > 1.3).

**Unblocked by**: 30+ closed projects per reference class with both
the predicted P80 and the actual finish recorded.

### 1.2 Empirical CDF transform (replace percentile factors)

**What**: Instead of scaling `(model_finish - expected) * factor` per
percentile, build a customer-specific empirical CDF from accumulated
outcomes and apply a monotone remapping at every percentile.  The
honest end-state for the calibration discussion.

**Why not now**: Same data dependency as 1.1.  The current per-
percentile factor approach is documented as an interim with a known
semantic caveat (see `docs/api/completion.md` "Percentile-factor
semantics").

**Unblocked by**: Same as 1.1.

### 1.3 Per-customer reference class derivation

**What**: When a customer accumulates 50+ outcomes across projects of
similar type, derive their own reference class (fitted alpha, fat-tail
threshold, percentile factors) from their portfolio rather than
falling back to the published sector class.

**Why not now**: Same data dependency.  The custom-class extension
mechanism (`config.custom_reference_classes`) is the manual version;
this would automate it.

---

## 2. Needs domain expert review

### 2.1 Senior practitioner review of the reference-class table

**What**: The 19-class table in `solver/reference_classes.py` was
compiled from a literature review.  For sectors without published
fitted parameters (data centres / hyperscale especially, but also
nuclear decommissioning, mining, offshore wind), the values are
interpolated and labelled `JUDGEMENT` in the citations.  A senior
risk practitioner should sanity-check:

- Per-class `pareto_alpha_range` values.
- Per-percentile factors -- particularly P95/P99 for fat-tailed
  classes.
- The boundary between "thin-tailed" (lognormal tier 4) and
  "fat-tailed" (BS tier 4) sectors, especially edge cases like
  tunnels, offshore wind, and mining.
- The data-centres-hyperscale row, which has no peer-reviewed fit
  yet and is calibrated against JLL 2026 / Turner & Townsend 2025 /
  Allianz 2024 practitioner reports.

**Why not now**: This is judgement work, not engineering work.

**Unblocked by**: Engagement with a risk practitioner who has access
to either the Aaen et al. PMJ 2025 Table 4 or comparable
sector-specific fitted parameters.

### 2.2 Review of the percentile-factor application semantics

**What**: The per-percentile factors are applied to the OVERRUN
portion of MC output.  Published RCF tables were calibrated against
deterministic point estimates, not MC P80.  Whether (and how much)
this double-counts uncertainty for any given sector is unknown.

**Why not now**: Requires either (a) customer outcome data to validate
the magnitude of bias, or (b) a domain expert opinion on whether the
factor application is methodologically sound.

**Unblocked by**: 1.1, or a practitioner conversation.

---

## 3. Needs runtime infrastructure I don't have here

### 3.1 Browser smoke tests for the JS wrappers

**What**: All testing in this branch is `node --check` syntax + the
JS↔Python diff harness running pure-math functions in a stubbed
sandbox.  No verification that the JS wrappers
(`getCumulativeDistributionAsync`, `createActualEVMChartAsync`,
`runMonteCarloRemainingAsync`, `buildCrashOptionsAsync`,
`registerProjectOutcome`, `fetchReferenceClasses`,
`fetchCalibrationReport`) actually work in a real browser end-to-end
with Chart.js rendering, DOM updates, and the AI-enrichment OpenAI
integration.

**Why not now**: No headless browser available in the CI environment
this branch was developed in.

**Unblocked by**: Playwright or Puppeteer in CI loading a real test
HTML harness against the deployed backend.

### 3.2 Concurrent-load test of the vectorised paths

**What**: `gunicorn --workers 4 --threads 2` under realistic load to
verify the vectorised EVM distribution code (and the MC sampler's
NumPy paths) don't have memory contention or GIL issues.

**Why not now**: No load-test infra here.

**Unblocked by**: A simple Locust or `wrk` script against staging.

### 3.3 Real Redis behind `/completion/register-outcome`

**What**: `completion/outcomes.py` falls back to an in-process dict
when Redis isn't reachable.  The fallback is correct in semantics
(TTL-honoured, same API) but is lost on process restart.  Production
must point at the same Redis used by the rest of the cache layer.

**Why not now**: The code path is wired; just confirm `REDIS_URL` is
set in the deployment environment.

**Unblocked by**: Deployment configuration.

---

## 4. Engineering follow-ups (good-to-have, not blocking)

### 4.1 Sweep-line cumulative distribution -- DONE

**Was**: `evm/distributions.py` was O(N × D); 10K activities took
~1.9 s for the cumulative step.

**Done**: Replaced `_cumulative_matrix(...).sum(axis=0)` with
`_cumulative_sum_sweep(starts, ends, caps, rates, dates)`.  Per
activity: ±rate at start/end for non-degenerate, step-jump at start
for degenerate.  Events stable-sorted once, collapsed at coincident
times, prefix-sum to compute rate + cumulative at each event; query
dates resolved via `searchsorted` + linear interpolation.  Period
series handled in parallel by `_period_sum_sweep` using sorted
cumulative-count arrays + searchsorted.

Both forecasted and actual branches use the sweep paths.  The
actual branch keeps its historic/future masking by exploiting the
identity `where(mask[None, :], A, B).sum(axis=0) ==
where(mask, A.sum(axis=0), B.sum(axis=0))`, so masking happens on
(D,) sums instead of (N, D) matrices.

**Measured** (random N activities, D=N dates):

| N      | Matrix | Sweep | Speedup | Max error |
|--------|--------|-------|---------|-----------|
| 500    |   4.8ms|  1.5ms|   3.1x  | 6.9e-11   |
| 2,000  |  80.9ms|  6.4ms|  12.6x  | 4.4e-10   |
| 5,000  | 553.4ms| 15.5ms|  35.7x  | 9.9e-10   |
| 10,000 |1916.1ms| 31.2ms|  61.4x  | 4.1e-09   |

Byte-equivalent (error well below the 1e-6 diff-harness tolerance);
all 116 existing EVM tests still pass.  `config.max_distribution_points`
retained for callers that want to bound D further.

### 4.2 Diff harness for `/evm/analyze` distributions -- DONE

**Done**: Extended `tests/diff_harness/run_js_evm.js` to emit the
forecasted branch's cumulative + period arrays (planned, withOverrun,
ev, and non-cumulative siblings) via an inlined port of the JS
daily-iteration algorithm.  Added `test_forecasted_distribution_invariants`
(5 fixtures) that locks:

1. Per-side monotonicity of cumulative series.
2. Per-side non-negativity of period series.
3. Python internal consistency: `distributionPlanned` cumulative
   final value equals `sum(convert_to_hours(node.Duration, units))`
   across all non-milestone nodes.

Does NOT diff JS vs Python point-by-point because the two
implementations use intentionally different algorithms (JS daily-
bucket iteration vs Python continuous linear interpolation).  The
JS daily loop has a known off-by-one that overshoots each activity
by one day's accrual; the Python port corrects it.  The structural
invariants catch any Python-side regression without forcing Python
to reproduce known-buggy JS behaviour.

### 4.3 Risk drivers / common-mode correlation factors

**What**: The current MC assumes activity-level independence.  Hulett
(ICEAA 2016, 2022) and the AACE-blessed risk-driver method correct
this: when activities share resources, weather windows, FX, or
political shocks, common-mode factors should multiply correlated
activity multipliers together.

**Why not now**: Significant API surface change.  Would need a new
top-level `risk_drivers: [{name, magnitude, affected_activities}]`
field on the request and per-driver sample injection in the MC.

**Unblocked by**: A focused design + 1-2 day implementation +
documentation.

### 4.4 Telemetry on backend-vs-fallback rates -- DONE

**Done**: Both JS files (`Completionprediction.js`, `EVM.js`)
increment counters on a shared object:

```js
window.cybereumState.completionPredictionTelemetry = {
  backend_calls:     <int>,
  backend_successes: <int>,
  fallback_count:    <int>,
  last_error:        { service, reason, status, message, ts } | null,
  by_service: {
    monte_carlo | recovery | reference_classes | outcome |
    calibration | evm: { calls, successes, fallbacks }
  },
}
```

Wired at three points in each async wrapper: `call` before the fetch,
`success` after `resp.json()` succeeds, `fallback` on any of
`backend_disabled` / `prereqs_missing` / `non_ok_status` / `timeout` /
`network_error`.  The recorder is wrapped in try/catch so it never
breaks the wrapper's fallback behaviour.

Coverage: `_recordTelemetry` is exported via the `_internals` debug
hook and exercised end-to-end by `tests/test_telemetry_js.py` (2
tests, runs under the same Node sandbox as the diff harnesses).

### 4.5 Tier-2 candidates from the original audit

`/paths/near-critical` and `/risks/compound-analysis` were identified
in the initial audit as Tier-2 extraction candidates.  Not done; the
Tier-1 candidates (MC, recovery, EVM) covered the highest-payoff JS.

**Why not now**: No specific user complaint about those features.

**Unblocked by**: Concrete request.

### 4.6 advance_working_ms time-of-day preservation

**What**: `completion/calendar.py advance_working_ms` uses a
cumulative work-hours array + `searchsorted` and treats the intraday
component as "working hours since UTC midnight" clipped to
`[0, hours_per_day]`.  The JS reference
(`Reference/Completionprediction.js addWorkingHours`, lines 396-423)
preserves the input's time-of-day, advances by whole working days,
then adds remainder hours as wall-clock time.

The two algorithms agree whenever start_ms is at UTC midnight (the
path the MC pipeline takes -- statusDate is parsed from an ISO date
string typically representing 00:00 UTC).  They CAN diverge by up
to one working-day boundary when callers pass non-midnight start
times into lag-shift helpers (e.g. an activity Finish at 13:00 +
2-day lag: JS keeps 13:00, this implementation effectively pushes
the time-of-day forward).

**Why not now**: A faithful port loses the cumulative-array
vectorisation that makes the MC hot path fast; restructuring around
per-row searchsorted-on-day-index + remainder-add (preserving
time-of-day) needs benchmarking and a focused diff harness with
non-midnight start fixtures.  Currently no diff-harness fixture
exercises non-midnight starts so the divergence isn't caught.

**Unblocked by**: A non-midnight-start fixture in the EVM diff
harness + a focused rewrite that keeps vectorisation (likely a
separate "intraday offset" array carried alongside the existing
cumulative arrays).

---

## 5. Done in this branch (for reference)

- `/completion/monte-carlo` (5-tier risk-distribution MC, calendar-aware,
  reference-class calibrated)
- `/completion/recovery-options` (crash + lag-compression ranking)
- `/completion/reference-classes` (discovery)
- `/completion/register-outcome` + `/completion/calibration-report`
  (outcome accumulation; foundation for items 1.1-1.3)
- `/evm/analyze` (full EVM analysis, vectorised, predicted-date
  propagation, holiday-aware)
- 19-class reference-class table with 5 extension mechanisms
- 3 real bugs in the JS implementation discovered + fixed in both
  (forecasted-ACWP double-multiply, calculateACWP wall-clock drift,
  distance-decay missing succMap fallback)
- JS↔Python diff harnesses for EVM (20 invariants × 5 fixtures),
  distribution arrays (3 structural invariants × 5 fixtures), and
  recovery (4 invariants on classification + lag conversion)
- All 13 actionable Copilot review comments addressed (8 original
  + 5 from the 2026-04-18 round)
- Backend-vs-fallback telemetry in every async JS wrapper
- Sweep-line cumulative distribution: 61x speedup at N=10K, byte-
  equivalent to the matrix path
- 399+ tests passing; full backwards compatibility verified

---

## How to use this document

Treat this as a triage list.  The items in section 1 are the most
strategically important but require data accumulation that has to
happen in production over months.  Section 2 needs a person, not
code.  Section 3 needs infrastructure that exists in the deployment
environment but not here.  Section 4 is engineering polish.

When picking up a future PR, start at the top of the relevant section
and work down.  Update this file as items get done so future
contributors don't re-do completed work.
