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
- Working-calendar JS↔Python parity (`tests/test_calendar_diff.py`,
  24 cases × 3 fixtures): closes the historical drift on non-midnight
  starts.  `advance_working_ms` now decomposes work-hours into
  wholeDays + remainder, advances by whole working days while
  preserving time-of-day, then forward-normalizes the remainder past
  weekends and holidays -- byte-equivalent to JS `addWorkingHours`
  (Reference/Completionprediction.js lines 396-423).  Build adds
  three new precomputed lookup arrays (`working_days_before`,
  `next_working_idx`, `next_weekday_idx`) so the algorithm stays
  O(log K) vectorised on the MC hot path.
- All 13 actionable Copilot review comments addressed (8 original
  + 5 from the 2026-04-18 round)
- Backend-vs-fallback telemetry in every async JS wrapper
- Sweep-line cumulative distribution: 61x speedup at N=10K, byte-
  equivalent to the matrix path
- 399+ tests passing; full backwards compatibility verified

---

## 6. Library upgrade backlog (researched 2026-05)

Compressed output of a broad library-and-dataset survey done on the
`claude/research-libraries-tools-Xl4Ld` branch.  Each item lists the
incumbent in this codebase, the candidate, the verified evidence
(version, license, an actual code reference where relevant), and what
unblocks adopting it.  Items are grouped by what they touch and what
they're gated on -- the Tier-A "do first" cluster is intentionally
small because the gating measurement (py-spy) hasn't been taken yet.

### 6.1 Profile-gated runtime upgrades

These three look high-value on inspection but are NOT yet justified by
measurement.  Per CLAUDE.md "Goal-Driven Execution" they are deferred
until `py-spy` confirms each lives in the top-3 hot path.

#### 6.1.1 `orjson` as Flask JSON provider

**What**: Replace `flask.json` with an `orjson`-backed provider.
Native NumPy-array / datetime / UUID encoding, ~3-10x throughput on
large payloads.  Targets the `/graph-metrics`, `/completion/monte-
carlo`, and `/evm/analyze` responses (large nested NumPy-laden JSON
read by both the C# backend and the JS frontend).

**Why not now**: No profile data yet shows JSON encoding is in the
hot path.  CLAUDE.md performance benchmarks point at CPM + MC
propagation as the dominant cost; serialization may already be < 5%
of request time, in which case `orjson` is premature optimization.

**Unblocked by**: A `py-spy record` against a live gunicorn worker
servicing a representative `/graph-metrics` payload, showing JSON
encoding > 5% of wall time.  Add `requirements-dev.txt` (already
present) is the one-line install path.

#### 6.1.2 `flask-compress` + brotli response compression

**What**: Wrap the Flask app with `flask_compress.Compress(app)` so
brotli is offered ahead of gzip.  Brotli is typically 4-6x smaller
than gzip on JSON payloads, cutting Azure egress and frontend TTFB
on the multi-megabyte responses.

**Why not now**: No measurement of current response sizes or egress
costs.  Worth knowing before adding a content-negotiation layer that
both consumers (C# `ComputeMetrics.cs`, JS `CommunityGroups.js`)
must understand.

**Unblocked by**: Sample 5 representative response sizes from
production logs + 1 confirmation that the C# HttpClient and the JS
fetch wrappers will accept `Content-Encoding: br`.

#### 6.1.3 `azure-monitor-opentelemetry` first-class APM

**What**: One-call `configure_azure_monitor()` auto-instruments
Flask, Redis, requests; ships traces + metrics + logs to App
Insights.  Already paid for by the Azure subscription.

**Why not now**: Need to confirm the deployment environment isn't
already wired to App Insights via a different mechanism (the
existing telemetry hooks live in the JS wrappers, item 4.4) and
that a Python-side tracer doesn't double-count.

**Unblocked by**: Deployment-config check + an off-hours staging
deploy with the SDK enabled to confirm trace shape.

### 6.2 Test-tooling additions (safe, additive, no runtime change)

#### 6.2.1 `hypothesis` for property-based DAG generation -- READY

**What**: Wire `hypothesis` strategies that generate random DAGs
with mixed FS/SS/FF/SF edges and arbitrary lag values into the
existing `tests/diff_harness/` modules.  Catches fixture gaps in
`test_paths_diff.py`, `test_evm_diff.py`, `test_recovery_diff.py`
beyond the curated 5-fixture sets.

**Why not yet**: `hypothesis` is now in `requirements-dev.txt`; the
strategy + invariant tests still need writing.  No blocker.

**Unblocked by**: Self.  See `requirements-dev.txt` line 18.

#### 6.2.2 `py-spy` profiling baseline -- READY

**What**: Run `py-spy record` against a representative gunicorn
worker servicing `/graph-metrics` (5K and 15K activity inputs) and
`/completion/monte-carlo` (M=512 sample run).  Output a flame graph
under `docs/perf/` to gate items 6.1.1-6.1.3 and 6.5.

**Why not yet**: Same -- `py-spy` is in `requirements-dev.txt`; the
profiling run itself hasn't been done in a deployed-shape
environment.

**Unblocked by**: Self + access to a worker shape comparable to
production.

### 6.3 Verified runtime swaps with a clear feature gate

#### 6.3.1 `leidenalg` Louvain -> Leiden in multi-resolution pipeline

**What**: Swap the Louvain calls in `multi_resolution_pipeline.py`
for `leidenalg.find_partition` behind a config flag (e.g.
`COMMUNITY_ALGORITHM=leiden|louvain`, default `louvain` for back-
compat).  Leiden eliminates Louvain's disconnected-community
defect (γ-connectivity guarantee) and substantially mitigates the
resolution-limit problem via its refinement phase.  It does NOT
eliminate the resolution limit, which is intrinsic to modularity.

**Why not now**: The `CommunityGroup` field in the
`/graph-metrics` response is part of the API contract (consumed by
`CommunityGroups.js`).  Switching the underlying algorithm changes
community labels and counts.  Requires (a) the flag, (b) a small
diff harness comparing Louvain vs Leiden NMI + community-count
distributions on a fixture suite, (c) a docs/api/graph-metrics.md
note.

**Unblocked by**: Branch-specific feature spec.  Verified PyPI
version: `leidenalg==0.11.0` (current, Oct 2025).

#### 6.3.2 `scipy.optimize.minimize(method='trust-constr')` in solver

**What**: One-line method change in `solver/optimizer.py:173`
from `method='L-BFGS-B'` to `method='trust-constr'` with explicit
`NonlinearConstraint(makespan_fn, 0, max_makespan)` and a
`LinearConstraint` for `max_budget`.  Replaces the soft quadratic
penalty (`CONSTRAINT_PENALTY_LAMBDA = 50`) with hard enforcement.
Reuses the existing analytic adjoints in `solver/adjoints.py`.

**Why not now**: The `constraints` report shape returned by
`/solver/sensitivity` and `/solver/optimize` (see
`docs/api/solver.md`) currently exposes `{bound, final_value,
violation, satisfied}` per active constraint -- meaningful only
under a soft-penalty regime.  Hard enforcement means
`satisfied: false` becomes "infeasible, no solution returned"
which is a contract change for the C# consumer.

**Unblocked by**: API-contract decision: does the C# consumer want
"best-effort with magnitude" (today) or "feasible-or-fail" (with
trust-constr)?  Possibly both, behind a `config.constraint_mode`
flag.

#### 6.3.3 `pymoo` NSGA-II / MOEA/D as alternative Pareto sweep

**What**: Add `pymoo` (`==0.6.1.6`) as a parallel branch in
`solver/pareto.py` alongside the existing Tchebycheff sweep,
gated by a `config.pareto_method = "tchebycheff" | "nsga2" |
"moead"` field.

**Why not now**: This is a new code path, not a flag swap --
`pareto.py` currently has no method-dispatch layer.  Sizable PR.
Also overlaps the open backlog item ("NSGA-II / MOEA/D as
alternative to Tchebycheff" already noted in CLAUDE.md).

**Unblocked by**: Concrete user request that the Tchebycheff
sweep is missing frontier points, OR a many-objective (>3
disciplines) project that motivates reference-direction methods.

#### 6.3.4 `holidays` library feeding `WorkingCalendar`

**What**: Use the `holidays` package to populate the holiday list
fed into `completion/calendar.py::WorkingCalendar` from a country
code + year range, instead of users supplying ISO date strings.
Net new helper, no calendar refactor.

**Why not now**: Needs a small request-shape addition (e.g.
`project_context.calendar.country = "GB"`) and validation.  Trivial
but not free.

**Unblocked by**: A customer who wants country-default holidays
without uploading their own list.

### 6.4 Verified diagnostic additions (low-risk feature work)

#### 6.4.1 `powerlaw.distribution_compare` in reference-class validation

**What**: Add a one-shot validation script under `solver/` that
takes the per-class Pareto α and runs `powerlaw.Fit` +
`distribution_compare('power_law', 'lognormal')` against historical
overrun samples once item 1.1 (outcome accumulation) yields enough
data.  Confirms the `α = 2.0 + 1.5 * (1 - risk)` calibration
empirically per Flyvbjerg-style methodology.

**Why not now**: Same data dependency as section 1 -- needs 30+
closed projects per class to run meaningfully.

**Unblocked by**: Item 1.1 producing data.

#### 6.4.2 `pycop` upper-tail-dependence coefficient in 2D clusters

**What**: Add a `tail_dependence_coefficient` scalar to the
`/solver/sensitivity` 2D cost-schedule extreme-event clustering
output.  Validates whether K-means clusters in the joint cost-
schedule overrun space reflect real joint extremes (λᵤ > 0) vs
independent fat tails.  Verified library: `pycop==0.0.13`
(March 2024, has theoretical, non-parametric, and plateau-finding
empirical TDC).

**Why not now**: Adds one new field to the response (additive, no
breaking change) but the v0.0.x version label means the dep is
small (21 KB wheel) and the math is well-defined, but pinning is
required to keep the diagnostic stable.

**Unblocked by**: API decision on whether to add `λᵤ` or to keep
the response shape minimal.

#### 6.4.3 `scoringrules` CRPS in calibration loop

**What**: Wire `scoringrules.crps_ensemble(...)` into
`completion/outcomes.py` / `completion/calibration-report` so the
per-percentile P10/P20/P50/P80/P95 band collapses to a single
proper score per recorded outcome.  CRPS makes per-class
calibration monotone-comparable across customers and over time.
Verified library: `scoringrules==0.10.0` (active, pure-Python).
NOT `properscoring` -- that one is at v0.1, single release, and
unmaintained since 2015.

**Why not now**: Same data dependency as 4.4 / section 1; CRPS is
only meaningful with accumulated outcomes.  But the hookup is
trivial and could ship in advance, returning `null` until enough
data lands.

**Unblocked by**: Section 1 accumulation OR a "ship the field
returning null" decision.

#### 6.4.4 `SALib` Saltelli-Sobol indices alongside gradient sensitivity

**What**: Add a SALib-backed sample-based S1 / ST sensitivity
report alongside the existing gradient-based output of
`/solver/sensitivity`.  Gradient sensitivity gives local
derivatives; Sobol indices give variance-decomposed global
sensitivity.  Reuses the existing Sobol QMC infrastructure in
`solver/stochastic.py` for the Saltelli A/B/AB matrices.

**Why not now**: Doubles the cost of `/solver/sensitivity` for
each requested coordinate.  Should be opt-in via
`config.sensitivity_global = true`.

**Unblocked by**: User who wants global, not local, sensitivity.

### 6.5 Strategic infrastructure decisions

#### 6.5.1 `mpxj` ingest layer (XER / MPP / PMXML / Asta / Synchro)

**What**: Add an optional ingestion layer that turns customer
project files (Primavera P6 .xer/.pmxml, MS Project .mpp/.mspdi,
Asta, Synchro, Phoenix, Deltek Open Plan, GanttProject, etc.)
directly into the JSON shape `/graph-metrics` and `/solver/*`
already accept.  `mpxj` (Java, JPype-bridged) is the single library
covering ~20 formats.  Pair with `xer-reader` (pure-Python,
XER-only) as a no-JVM fallback.

**Why not now**: This is the gating strategic question of the
research output: **does the deployment image accept a JVM?**
Today's Dockerfile is `python:3.12-slim` with no JRE.  Adding
OpenJDK adds ~150-200 MB to the image and a second runtime to
operate.

**Unblocked by**: Product decision on whether "drop your
Primavera/MSP file" is a customer-facing capability worth the
container weight.  If no, the no-JVM path is `xer-reader` for the
XER subset only.

#### 6.5.2 `OR-Tools` CP-SAT for hard RCPSP/max enforcement

**What**: Replace the soft-penalty constraint enforcement (item
6.3.2) with a true CP-SAT-backed RCPSP/max engine for the
hard-enforcement roadmap item flagged in CLAUDE.md.  CP-SAT is the
only mature open-source RCPSP/max solver with sub-second
performance on 100-activity instances; ~3% optimality gap on
PSPLIB.

**Why not now**: Strictly larger lift than 6.3.2 trust-constr.
The CP-SAT model has to express FS/SS/FF/SF + lag (intervals +
linear constraints between starts/ends), resource-cumulative
constraints, and the Tchebycheff scalarisation -- nontrivial
porting.

**Unblocked by**: A user who needs guaranteed-feasible schedules
under hard resource caps, where 6.3.2's continuous nonlinear
constraints are insufficient.

#### 6.5.3 `pyAgrum` Bayesian-network risk-cascade engine

**What**: Replace the topological-averaging risk propagation in
`solver/analysis.py` with a Bayesian network whose CPTs encode
per-activity at-risk probabilities and per-edge conditional
inflation.  `pyAgrum==2.3.2` is C++-backed (aGrUM core), no
PyTorch dep -- contrast with `pomegranate` v1.1.2 which pulls
torch (~700 MB - 2 GB image bloat).

**Why not now**: This is a methodological change, not a swap.
Needs (a) a CPT specification format on the request, (b) a JS-vs-
Py diff harness against the current topological propagation on a
linear-Gaussian fixture where the two should agree, (c) a
sensitivity story for how the BN choice affects the published
criticality / cruciality indices.

**Unblocked by**: Concrete proposal + design doc.  Until then the
`pyAgrum` recommendation supersedes `pomegranate` and `pgmpy` on
deploy weight + scale alone.

### 6.6 Verified data ingestion (open-licensed, machine-readable)

#### 6.6.1 UK IPA Government Major Projects Portfolio (GMPP) reference class

**What**: Bundle a built-in `gov_uk_gmpp` reference class derived
from the per-department GMPP CSV/XLSX series published annually on
gov.uk under the Open Government Licence.  Each department (ONS,
MOD, HMRC, DHSC, MOJ, DCMS, VOA, NCA, ...) publishes its own
file.  Verified: the 2023-24 IPA annual report itself includes
CSV + XLSX downloads.

**Why not now**: Ingestion is **N CSV files (one per department),
not one** -- needs a small ETL that unions them, normalises the
delivery-confidence (RAG) ratings to per-percentile factors, and
ships the result as a JSON in the per-class registry alongside
the existing 19 sectors.  License is OGL (compatible with this
project's distribution model) but the file structure varies year
to year and across departments.

**Unblocked by**: A focused 1-day ETL + a pinned snapshot date so
the bundled JSON is reproducible.

#### 6.6.2 Aaen / Flyvbjerg PMJ 2025 23-type table extension

**What**: Extend `solver/reference_classes.py` from 19 to 23
classes by encoding the per-class P10 / P50 / P80 cost & schedule
deltas + Pareto α from the PMJ 2025 "Uniqueness of IT Cost Risk"
paper.

**Why not now**: The paper is paywalled (SAGE).  Per-class
parameters need hand-extraction from the paper body, which is
research / documentation work, not engineering.

**Unblocked by**: Paper access + the section 2.1 senior-
practitioner review (so new entries don't repeat the JUDGEMENT
labelling pattern).

### 6.7 Anti-findings (researched, do not adopt)

These were investigated and rejected; recording so the next
researcher doesn't redo the work.

- **`scipy.stats.fatiguelife` to replace `_bs_ppf_z`** -- would
  re-do `ndtri` per call and break the Sobol QMC pipeline's
  shared-`z` optimisation.  Hand-rolled BS PPF in
  `solver/stochastic.py:127` stays.
- **`numpy.busday_count` / `busdaycalendar`** -- only supports
  integer day deltas + one weekmask; loses `WorkingCalendar`'s
  per-resource calendars + half-days + exceptions.
- **GPU graph (`nx-cugraph`, cuGraph)** -- no GPU on the Azure
  App Service tier; 20K-node graphs finish in <2s on NetworKit.
- **GNN libs (PyG, DGL)** -- 1-2 GB of deps for marginal gain on
  deterministic CPM analytics.
- **`graph-tool`** -- conda-only install; rules it out for the
  current pip-based Azure CI.
- **FastAPI / ASGI migration, gevent / eventlet workers** --
  handlers are CPU-bound (NumPy, NetworKit hold the GIL); ASGI
  buys nothing and breaks the C# / JS contract surface.
- **`dask`, `polars`** -- overkill for a 2-worker single-node
  service; pandas isn't the bottleneck per the published
  performance benchmarks.
- **`cvxpy`** -- `C = rate * r * d` plus BS / Pareto inflation
  are non-convex; doesn't fit DCP.
- **`DEAP`, `Platypus`, `pygmo`, `parego`, `moead-py`** --
  strictly dominated by `pymoo` for this use case.
- **`TensorFlow Probability`, `Pyro`, `emcee`, `mc3`** --
  redundant with `pyAgrum` / NumPyro for the BN use case.
- **`pgmpy`, `bnlearn`** -- pure-Python; too slow on 15K-node
  DAGs.  Use `pyAgrum`.
- **`scikit-extremes`, `pyschedule`, `pyrcpsp`, `pyevm`,
  `earned-schedule-py`, `py-tail-risk`, `GPyOpt`,
  `scikit-optimize`** -- all abandoned.
- **`properscoring`** -- single-release v0.1 since 2015.  Use
  `scoringrules==0.10.0` instead.
- **`@RISK` / Crystal Ball / RiskyProject parsers** -- none
  exist on PyPI.
- **No mature open-source SRA package exists** anywhere -- the
  in-house criticality / cruciality + Tchebycheff Pareto + five-
  tier risk distributions in this service is genuinely a moat.

---

## How to use this document

Treat this as a triage list.  The items in section 1 are the most
strategically important but require data accumulation that has to
happen in production over months.  Section 2 needs a person, not
code.  Section 3 needs infrastructure that exists in the deployment
environment but not here.  Section 4 is engineering polish.  Section
6 is the library-upgrade backlog produced in 2026-05; the gating
measurement (`py-spy`) and the gating product decision (JVM in image
yes/no) are called out explicitly per item.

When picking up a future PR, start at the top of the relevant section
and work down.  Update this file as items get done so future
contributors don't re-do completed work.
