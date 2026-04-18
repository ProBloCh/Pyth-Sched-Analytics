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

### 4.1 Sweep-line cumulative distribution -- O(N log N + D log N)

**What**: The vectorised distributions in `evm/distributions.py` are
O(N × D).  For 10K+ activity projects D scales linearly with N giving
effective O(N²) and ~14 s runtime at n=5K (extrapolating to ~60 s
at n=10K).

A sweep-line implementation:
- Build (2N) start/end events with ±daily_rate deltas
- Sort once
- `cumsum` to get running rate after each event
- Cumulative hours at each event = prior rate × segment length
- Per query date: `searchsorted` + interpolate

Would bring 10K activities under 1 s.

**Why not now**: Mitigated for now via `config.max_distribution_points`
which subsamples the date grid (default unlimited; customers with
10K+ projects should set it to ~500 -- chart rendering can't display
more anyway).  The sweep-line implementation is ~200 LOC with subtle
edge cases around inclusive vs exclusive event boundaries; deferred
to a focused PR with its own diff coverage.

**Unblocked by**: A focused implementation session + extending the
EVM diff harness with a 5K-activity fixture to lock byte-equivalence
during the rewrite.

### 4.2 Diff harness for `/evm/analyze` distributions

**What**: The existing EVM diff harness (`tests/test_evm_diff.py`)
covers scalar metrics + predicted dates.  It does NOT diff the actual
distribution arrays (planned / risk / EV cumulative + non-cumulative
hours / cost arrays at every comparison date).

**Why not now**: The distribution arrays are large (D points × ~12
arrays per branch) and the JS-side cumulative computation is
intermixed with chart construction.  Extracting them cleanly takes
an extra harness pass.

**Unblocked by**: An extension of `run_js_evm.js` to surface the
distribution arrays + a Python comparator with appropriate tolerance
(distributions can drift slightly from rounding without indicating a
real bug).

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

### 4.4 Telemetry on backend-vs-fallback rates

**What**: The JS wrappers fall back to sync JS on any backend
failure.  This is good for resilience but means a slowly degrading
backend (e.g., 30% 500 rate) could go unnoticed -- the user sees
inconsistent results rather than an error.

Add a `window.cybereumState.completionPredictionTelemetry = {
  backend_calls, backend_successes, fallback_count, last_error
}` so the main app can surface a "backend service degraded" banner.

**Why not now**: Small addition; not done because no one has asked.

**Unblocked by**: ~30 LOC in each async wrapper.

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
- JS↔Python diff harnesses for EVM (20 invariants × 5 fixtures) and
  recovery (4 invariants on classification + lag conversion)
- All 8 actionable Copilot review comments addressed
- 392+ tests passing; full backwards compatibility verified

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
