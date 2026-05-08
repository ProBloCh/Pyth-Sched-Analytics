# Roadmap to 10/10

A sequenced, PR-sized plan to push every reviewed dimension of
Pyth-Sched-Analytics from its current rating to 10/10.

| Dimension | Current | Drivers in this plan |
|---|---|---|
| Domain ambition / analytical depth | 9 | Tier 6 |
| Algorithmic sophistication | 9 | Tier 5 |
| Test confidence | 8.5 | Tier 1, Tier 3 |
| Production readiness | 7 | Tier 0, Tier 1, Tier 2 |
| Maintainability / platform engineering | 6.5–7 | Tier 1, Tier 4 |

## How to use this document

Each numbered item below is a single pull request.  PRs inside a tier are
independent unless **Depends on** is specified.  Tiers are ordered by
risk-weighted impact — finish Tier *N* before opening Tier *N+1* PRs except
where a parallel track is explicitly called out.

Each PR section contains:

- **Why** — the gap it closes.
- **Files** — concrete paths the diff is expected to touch.
- **Checklist** — copy this into the PR description.
- **Done when** — verifiable acceptance criteria.
- **Depends on** — earlier PRs that must land first.
- **Effort** — S (≤ 1 day), M (1–3 days), L (≥ 1 week).

Scope discipline: a PR that grows past its checklist gets split, never
expanded.  The tier ordering depends on small, mergeable units.

---

## Tier 0 — Production blockers

These ship before any new external consumer touches the service.  All four
are correctness or security gaps that today's tests do not catch.

### PR-1 · Authentication layer + CORS allowlist (S, security)

**Why.** No auth decorator anywhere in the codebase; `app.py:75-78` has
`{"origins": "*"}`.  Every endpoint, including the 10 MB-payload
optimizer, is reachable from any browser.

**Files.**
- `app.py` (CORS config, before-request hook registration)
- `auth.py` (new, ≤ 80 LOC)
- `requirements.txt` (no new deps; use stdlib `hmac`/`secrets`)
- `tests/test_auth.py` (new)
- `docs/api/README.md` (auth header documented)

**Checklist.**
- [ ] Add `auth.py` exposing `require_api_key()` Flask `before_request`
  hook that compares `X-API-Key` against `PYTH_API_KEYS` env var
  (comma-separated, hashed via `hmac.compare_digest`).
- [ ] Whitelist `/health`, `/solver/health`, `/cors-test` for unauth
  access.
- [ ] Replace wildcard CORS with `origins=os.environ['PYTH_CORS_ORIGINS'].split(',')`
  (fail-closed: empty list ⇒ no CORS).
- [ ] Add `WWW-Authenticate: ApiKey` to 401 responses.
- [ ] `tests/test_auth.py`: 401 without key, 401 with bad key, 200 with
  good key, 200 on whitelisted health endpoints.
- [ ] `docs/api/README.md` and each endpoint doc: state required header.
- [ ] Add `PYTH_API_KEYS` and `PYTH_CORS_ORIGINS` to deployment notes.

**Done when.** All existing 803 tests pass with `PYTH_API_KEYS` set in
the test fixture; new auth tests pass; manual curl without header
returns 401.

**Depends on.** Nothing.

### PR-2 · Cache schema versioning (S, correctness)

**Why.** `solver/routes.py::_cache_key` and `app.py`'s `/graph-metrics`
cache key hash request payloads but not response shape.  Any future
response-shape change silently corrupts cache entries until expiry.
CLAUDE.md explicitly warns about this in *Caching and API Contract*.

**Files.**
- `app.py` (cache key prefix)
- `solver/routes.py` (`_cache_key` helper)
- `completion/routes.py` (cache calls)
- `evm/routes.py`, `paths/routes.py`, `interface/routes.py` (any caches)
- `_cache_version.py` (new, single-line module)
- `tests/test_cache_versioning.py` (new)

**Checklist.**
- [ ] `_cache_version.py`: define `RESPONSE_SCHEMA_VERSION = 'v1.0.0'`.
- [ ] Update every `_cache_key` (or equivalent) to prefix the digest
  with `RESPONSE_SCHEMA_VERSION`.
- [ ] Add a CHANGELOG comment in `_cache_version.py` listing the bump
  protocol: any response-shape change ⇒ bump minor.
- [ ] Test: hash for the same payload differs across two distinct
  versions, identical inside one version.
- [ ] Update `CLAUDE.md` *Caching and API Contract* to reference the
  bump protocol.

**Done when.** Bumping the constant produces a different cache key
(verified by test); existing tests unaffected.

**Depends on.** Nothing.

### PR-3 · NetworkKit startup gate (S, correctness)

**Why.** `app.py:33-37` falls back to NetworkX with `_NK = False` and
no startup signal.  A bad deploy silently degrades community detection
and centrality timing.  CLAUDE.md flags NetworkKit as "essential for
production."

**Files.**
- `app.py` (post-import gate; `/health` payload)
- `tests/test_health.py` (assert key)
- `docs/api/health.md` (new field)

**Checklist.**
- [ ] After NetworkKit import block, read `PYTH_REQUIRE_NETWORKKIT`
  (default `'true'` in production env, `'false'` in test).  When true
  and `_NK is False`, log `CRITICAL` and `raise SystemExit(78)` (
  `EX_CONFIG`).
- [ ] Add `'networkit_available': _NK` to `/health` response (already
  partially present; extend to top level too).
- [ ] Test that `_NK` truthiness is reflected in the health payload.
- [ ] Document the env var and exit code in `docs/api/health.md`.

**Done when.** Manual test with `pip uninstall networkit && PYTH_REQUIRE_NETWORKKIT=true python app.py`
exits 78 with a single CRITICAL log line; existing tests pass with
`PYTH_REQUIRE_NETWORKKIT=false`.

**Depends on.** Nothing.

### PR-4 · Hard-fail option for constraint violations (S, correctness)

**Why.** `/solver/optimize` with `max_makespan` may return a violating
solution with `satisfied: false`.  A consumer that ignores the
`constraints` block ships a result that violates the bound the
customer supplied.  CLAUDE.md *High priority — Soft-penalty constraint
enforcement* documents the gap.

**Files.**
- `solver/optimizer.py` (penalty path is unchanged)
- `solver/routes.py` (post-solve gate)
- `solver/models.py` (request schema field)
- `docs/api/solver.md` (new field)
- `tests/test_solver_constraints.py` (new)

**Checklist.**
- [ ] Add request field `config.fail_on_violation: bool = False`.
- [ ] After optimizer returns, when `fail_on_violation is True` and
  any `satisfied is False`, return HTTP `409 Conflict` with the
  `constraints` block as the body.
- [ ] Default `False` preserves backward compatibility.
- [ ] Document the field, the new error code, and the expected client
  flow in `docs/api/solver.md`.
- [ ] Test: violating run with flag ⇒ 409, with constraints block;
  same run without flag ⇒ 200 with `satisfied: false`.

**Done when.** New tests pass; existing solver tests unchanged.

**Depends on.** Nothing.

---

## Tier 1 — Automated quality gates

Mechanical PRs.  Each one wires a gate into `.github/workflows/main_python-sched-analytics.yml`
so future regressions are caught at PR time.  Land them in any order after
Tier 0; do not skip.

### PR-5 · `pyproject.toml` + ruff (S, maintainability)

**Why.** No lint config exists.  `ruff` is the single highest-leverage
gate for a Python project of this size.

**Files.**
- `pyproject.toml` (new)
- `.github/workflows/main_python-sched-analytics.yml`
- `requirements-dev.txt` (new) — keep prod requirements untouched.

**Checklist.**
- [ ] Create `pyproject.toml` with ruff rules: E, F, I, B, UP, SIM,
  RUF; line-length 100; target-version py312.
- [ ] Run `ruff check --fix` once and commit *only the autofixes that
  change zero behaviour* (imports, unused vars, f-string upgrades).
  Anything semantic is deferred to its own PR.
- [ ] Add a `lint` job to the workflow: `ruff check .` and
  `ruff format --check .`.
- [ ] Document the local invocation in `CLAUDE.md` *Running Locally*.

**Done when.** CI lint job passes; no behavioural diff in tests.

**Depends on.** Nothing.

### PR-6 · `bandit` + `pip-audit` security gates (S, prod readiness)

**Why.** No supply-chain or static-security checks today.  Both tools
run in seconds; failure modes are well understood.

**Files.**
- `requirements-dev.txt`
- `.github/workflows/main_python-sched-analytics.yml`
- `pyproject.toml` (`[tool.bandit]` config)

**Checklist.**
- [ ] Add a `security` job that runs `bandit -r . -x tests,Reference`
  and `pip-audit -r requirements.txt`.
- [ ] Allow-list any current bandit findings only after triage; record
  rationale inline (`# nosec` with reason) — do not blanket-disable.
- [ ] Workflow: report `pip-audit` advisories as failure on `HIGH` or
  above; warning otherwise.
- [ ] Document override protocol in `CLAUDE.md`.

**Done when.** Both jobs green on `main`; deliberate vulnerable
dependency in a draft PR turns the job red.

**Depends on.** PR-5 (shares `pyproject.toml`).

### PR-7 · Coverage threshold gate (S, test confidence)

**Why.** 803 tests is high; coverage % is unknown.  A threshold gate
freezes that quality forward.

**Files.**
- `requirements-dev.txt` (`pytest-cov`)
- `pyproject.toml` (`[tool.coverage]`)
- `.github/workflows/main_python-sched-analytics.yml`

**Checklist.**
- [ ] Run `pytest --cov` once locally to measure the baseline.
- [ ] Set `fail_under` to `floor(baseline) - 1` (no race-to-bottom
  ratchet without explicit consent).
- [ ] CI publishes a coverage badge artifact.
- [ ] Document threshold-bump protocol in `CLAUDE.md`.

**Done when.** CI fails on a deliberate untested code addition; passes
on `main`.

**Depends on.** PR-5.

### PR-8 · Incremental type checking with `pyright` (M, maintainability)

**Why.** No static typing today.  Adding `pyright` in `basic` mode
catches whole-file errors without forcing a global annotation pass.

**Files.**
- `pyproject.toml` (`[tool.pyright]`)
- `.github/workflows/...`
- `solver/models.py`, `solver/dag.py` — these already have type hints;
  fix any errors pyright surfaces.

**Checklist.**
- [ ] Run `pyright --stats` to baseline.
- [ ] Configure `typeCheckingMode = "basic"`, `strictListInference`,
  `reportMissingImports = "error"`.
- [ ] Add `# pyright: ignore[code]` only where a third-party stub is
  missing; never blanket-disable a file.
- [ ] Add a `typecheck` CI job (non-blocking initially: `continue-on-error: true`).
- [ ] Track delta in `docs/typing-progress.md` (new): module-by-module
  check-mark when fully strict-clean.

**Done when.** Baseline clean in basic mode; one strict-clean module
documented.

**Depends on.** PR-5.

---

## Tier 2 — Observability

These three PRs make production failures debuggable.  Required before
external customers; not required for internal use, hence Tier 2.

### PR-9 · Request IDs + structured logging (M, prod readiness)

**Why.** Logs today are unstructured and lack correlation IDs.
Multi-endpoint flows (e.g. graph-metrics → solver/optimize) cannot be
correlated across log lines.

**Files.**
- `app.py` (logging setup)
- `observability.py` (new, `before_request` / `after_request` hooks)
- Every blueprint's `routes.py` (one decorator import each)
- `tests/test_observability.py` (new)

**Checklist.**
- [ ] `observability.py`: `before_request` generates `X-Request-ID`
  if absent (uuid4); stores on `flask.g`; `after_request` echoes it.
- [ ] Logging: switch to JSON formatter (stdlib `logging` +
  `json.dumps`, no new dep) emitting `request_id`, `endpoint`,
  `latency_ms`, `status`, `cache_hit`.
- [ ] Test: assert `X-Request-ID` round-trips; assert log contains
  `request_id` field on a captured handler.
- [ ] Document log schema in `docs/observability.md` (new).

**Done when.** `curl -i` shows `X-Request-ID`; logs are valid JSON.

**Depends on.** PR-5.

### PR-10 · Prometheus `/metrics` endpoint (M, prod readiness)

**Why.** No latency, error-rate, or throughput visibility today.

**Files.**
- `requirements.txt` (`prometheus-client`)
- `observability.py`
- `app.py` (route registration)

**Checklist.**
- [ ] Add Prometheus histograms: `pyth_request_duration_seconds{endpoint,status}`,
  `pyth_cache_events_total{outcome}` (`hit`/`miss`/`store`/`error`).
- [ ] `/metrics` endpoint, auth-exempt but bound to a separate
  `PYTH_METRICS_TOKEN` if `PYTH_API_KEYS` is set.
- [ ] Test: hit any endpoint, scrape `/metrics`, assert non-zero
  histogram.
- [ ] Document scrape config in `docs/observability.md`.

**Done when.** `/metrics` exposes histograms; CI scrape test passes.

**Depends on.** PR-1, PR-9.

### PR-11 · Solver / Monte-Carlo internal metrics (M, prod readiness)

**Why.** Optimizer iteration counts, MC sample counts, BFGS convergence
flag, and ensemble timing are not surfaced.  An L-BFGS-B that hits its
`maxiter` ceiling silently returns a sub-optimal answer today.

**Files.**
- `solver/optimizer.py`, `solver/stochastic.py`, `solver/routes.py`
- `completion/monte_carlo.py`, `completion/routes.py`
- `observability.py`

**Checklist.**
- [ ] New gauges: `pyth_solver_iterations`, `pyth_solver_converged`,
  `pyth_solver_constraint_violations`, `pyth_mc_samples`,
  `pyth_mc_truncations`.
- [ ] Add `optimizer_diagnostics` block to `/solver/optimize`
  response: `{iterations, converged, terminated_reason, max_iter_hit}`.
- [ ] Test: a deliberately under-budgeted optimizer run reports
  `max_iter_hit: true`.
- [ ] Update `docs/api/solver.md`.

**Done when.** Existing tests untouched; new diagnostic block present
on every solver response.

**Depends on.** PR-10.

---

## Tier 3 — Test depth

The 803-test suite is broad but has gaps in determinism, edge cases,
and load.

### PR-12 · Determinism guard tests (S, test confidence)

**Why.** `seed=42` is hard-coded but no test asserts that two runs
with identical input yield byte-identical output.

**Files.**
- `tests/test_determinism.py` (new)

**Checklist.**
- [ ] For each of `/graph-metrics`, `/solver/sensitivity`,
  `/solver/optimize`, `/solver/pareto`, `/completion/monte-carlo`,
  `/evm/analyze`, run twice on a shared fixture and assert
  `json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)`
  on every numeric field that should be reproducible.
- [ ] Where ordering may legitimately differ (e.g. dict-key order in
  Python 3.6+), normalise before compare.
- [ ] Add `@pytest.mark.determinism` so the suite can be filtered.

**Done when.** All six endpoints pass byte-equality determinism.

**Depends on.** Nothing.

### PR-13 · Edge case test pack (M, test confidence)

**Why.** Empty graphs, single-node graphs, all-completed projects,
status-after-completion, and zero-variance risk inputs are not
systematically covered.

**Files.**
- `tests/test_edge_cases.py` (new)

**Checklist.**
- [ ] Empty `nodes` ⇒ 400 with structured error.
- [ ] Single node, no links ⇒ 200 with degenerate but valid response
  on every endpoint.
- [ ] All `% Complete = 100` ⇒ `flags.all_completed: true` everywhere
  it's documented.
- [ ] Status date after latest activity finish ⇒ documented clamp
  applied; `teac` block carries `note`.
- [ ] Zero-variance risk on every activity ⇒ MC returns a degenerate
  band (P10 == P90 ± epsilon).
- [ ] Cyclic input graph ⇒ documented cycle-break behaviour
  (`docs/api/graph-metrics.md`).

**Done when.** Six new test classes pass; any failures triage to
either a documented behaviour clarification PR or a real bug.

**Depends on.** Nothing.

### PR-14 · Performance regression harness (M, test confidence)

**Why.** No automated detection of performance regressions.  The
benchmark table in `CLAUDE.md` is hand-maintained.

**Files.**
- `tests/perf/bench_endpoints.py` (new)
- `tests/perf/fixtures/` (new — synthetic 2.5K, 5K, 10K, 15K node
  graphs generated deterministically)
- `.github/workflows/perf.yml` (new, nightly only — not blocking on
  PRs)

**Checklist.**
- [ ] `pytest-benchmark`-based runner over `/graph-metrics`,
  `/completion/monte-carlo`, `/evm/analyze`, `/solver/optimize`.
- [ ] Persist median-of-5 timings to `docs/benchmarks/<git-sha>.json`.
- [ ] Nightly job posts a comment to the latest commit if any
  endpoint regresses > 25 % vs the trailing 7-day median.
- [ ] Document fixture-generation seeds (deterministic, reproducible
  outside CI).

**Done when.** Nightly perf job runs and posts a comment; baseline
JSON committed.

**Depends on.** PR-9 (uses request-ID header for log correlation).

---

## Tier 4 — Module hygiene

Four files breach 900 LOC.  Decomposition is mechanical but high-risk
because internal imports change.  Land each split as its own PR after
all preceding tiers so reviewer attention is undivided.

### PR-15 · Decompose `completion/monte_carlo.py` (M, maintainability)

Current size: 1436 LOC.

**Files.**
- `completion/monte_carlo.py` (shrinks)
- `completion/_monte_carlo/_calibration.py` (new) — `_build_calibration_warnings`
  and helpers.
- `completion/_monte_carlo/_teac.py` (new) — `_compose_teac_block`.
- `completion/_monte_carlo/_propagate.py` (new) — sampler core.
- `completion/__init__.py` (re-exports preserve the public surface).

**Checklist.**
- [ ] Identify three lifted modules by responsibility (calibration,
  TEAC composition, sampling); keep call signatures identical.
- [ ] Re-export from `completion.monte_carlo` so external imports
  (`from completion.monte_carlo import X`) keep working.
- [ ] No behaviour change; diff harness must remain green.
- [ ] Update `CLAUDE.md` architecture section to list the submodules.

**Done when.** All 803 tests pass unchanged; `completion/monte_carlo.py`
≤ 600 LOC.

**Depends on.** Tiers 0–2 fully landed.

### PR-16 · Decompose `paths/routes.py` (M, maintainability)

Current size: 1130 LOC across 5+ endpoints.

**Files.**
- `paths/routes.py` (becomes a thin registration shell)
- `paths/_routes/enumerate.py`, `_routes/distances.py`,
  `_routes/calendar_slack.py`, `_routes/driving_graph.py`,
  `_routes/subpath_patterns.py` (new — one per endpoint)

**Checklist.**
- [ ] One Flask view per file; shared validators stay in
  `paths/routes.py`.
- [ ] Lazy-import `app.py` cache helpers in each new module (preserve
  the existing circular-import workaround documented in CLAUDE.md).
- [ ] No URL changes; route map identical pre/post.
- [ ] Update `CLAUDE.md` *paths/ rules*.

**Done when.** All path tests + diff harness pass; `paths/routes.py`
≤ 250 LOC.

**Depends on.** PR-15 (proves the splitting pattern).

### PR-17 · Decompose `app.py` (L, maintainability)

Current size: 1446 LOC.

**Files.**
- `app.py` (becomes Flask factory + blueprint registration)
- `descriptive/` (new package)
  - `descriptive/__init__.py`
  - `descriptive/routes.py` (graph-metrics endpoint)
  - `descriptive/community.py` (community helpers)
  - `descriptive/centrality.py`
  - `descriptive/work_packages.py`
  - `descriptive/cpm.py`
  - `descriptive/risk.py`
- `tests/test_app_smoke.py` (new — hard pin on import surface)

**Checklist.**
- [ ] Move the `os.environ.setdefault` thread-limit block into
  `app.py` *and* duplicate the rationale comment — its position is
  load-bearing.
- [ ] Lift the `analyse()` body and its private helpers into
  `descriptive/`; keep `analyse` in `app.py` as a one-line wrapper if
  any existing test imports it directly.
- [ ] Smoke test that imports every public module and asserts the
  Flask app registers all expected URL rules.
- [ ] `app.py` ≤ 250 LOC.
- [ ] Update `CLAUDE.md` *Architecture* section.

**Done when.** All 803 tests pass; CI matrix green; no consumer-visible
import path broken (verified by smoke test).

**Depends on.** PR-15, PR-16.

### PR-18 · CLAUDE.md drift sweep (S, maintainability)

**Why.** CLAUDE.md says "157 tests" in one paragraph and "803 tests"
in another; the running totals now drift on every feature PR.

**Files.**
- `CLAUDE.md`
- `scripts/check_claude_md.py` (new — counts tests, asserts the
  number in CLAUDE.md matches)
- `.github/workflows/main_python-sched-analytics.yml`

**Checklist.**
- [ ] Replace every hard-coded test count with one canonical value.
- [ ] Verify benchmark table figures against PR-14's baseline.
- [ ] CI step `python scripts/check_claude_md.py` fails if the test
  count in CLAUDE.md ≠ collected count.
- [ ] Same gate for module LOC ceilings called out in CLAUDE.md (e.g.
  "app.py reaches line 1446" auto-checked).

**Done when.** CI catches a deliberate counter-edit.

**Depends on.** PR-14, PR-17.

---

## Tier 5 — Algorithm hardening

Each PR closes a documented gap in `CLAUDE.md` *Future Improvements*.

### PR-19 · Hard constraint enforcement via Augmented Lagrangian (L, algo)

**Why.** Soft penalty (Tier 0 PR-4 documents but does not fix this) is
the architecturally correct stopgap; full hard enforcement is the
referenced *true* fix.

**Files.**
- `solver/optimizer.py` (new outer loop)
- `solver/_aug_lagrangian.py` (new)
- `tests/test_solver_augmented_lagrangian.py` (new)

**Checklist.**
- [ ] Implement Augmented Lagrangian outer loop wrapping the existing
  L-BFGS-B inner solve.  Each outer iteration: solve, update
  multipliers `λ_k+1 = λ_k + μ * violation`, increase `μ` if
  violation did not improve.
- [ ] Add `config.constraint_mode: 'soft' | 'augmented_lagrangian'`
  (default `'soft'` to preserve compat).
- [ ] When `'augmented_lagrangian'`, return only feasible solutions
  (else 409 with diagnostic block).
- [ ] Convergence test on the canonical test fixture: violation
  ≤ 1e-6 in ≤ 5 outer iterations.
- [ ] Update `docs/api/solver.md`.

**Done when.** Augmented Lagrangian path passes new tests; soft path
unchanged.

**Depends on.** PR-4, PR-11.

### PR-20 · Calendar-aware CPM in solver (L, algo)

**Why.** `CLAUDE.md` *High priority — Calendar-aware scheduling inside
the solver CPM*.  The edge mapping is done; the substantive gap is
honouring non-working days during the forward/backward pass.

**Files.**
- `solver/dag.py` (`run_cpm` signature gains optional calendar)
- `solver/calendar_map.py` (already exists; promote helpers)
- `tests/test_solver_calendar_cpm.py` (new)
- `tests/diff_harness/run_js_solver.js` (new — JS reference parity)

**Checklist.**
- [ ] Honour `WorkingCalendar.skip_non_working_days` per activity in
  ES/EF/LS/LF.
- [ ] FF / SF lags consume working-time, not wall-clock.
- [ ] Aliasing contract preserved (analytic adjoints still close on
  finite difference within `1e-6`).
- [ ] JS-vs-Python parity (existing harness pattern) for a fixture
  with weekend + holiday.
- [ ] Update `docs/api/solver.md`.

**Done when.** Calendar fixture passes; existing solver tests
unchanged.

**Depends on.** PR-19.

### PR-21 · Leiden algorithm option (M, algo + domain)

**Why.** Provably avoids Louvain's resolution limit (Traag 2019);
flagged in `CLAUDE.md` *Lower priority* — promoted here because the
risk is low, the proof of correctness is published, and it gives a
+1 on algorithmic sophistication without touching CPM.

**Files.**
- `requirements.txt` (`leidenalg`, `python-igraph`)
- `multi_resolution_pipeline.py` (`COMMUNITY_ALGORITHM` env var:
  `'louvain'` | `'leiden'`, default `'louvain'`)
- `tests/test_multi_resolution.py`

**Checklist.**
- [ ] Conditional import; gracefully degrade to Louvain if leidenalg
  fails to load.
- [ ] When `'leiden'`, use `leidenalg.find_partition` with the
  same resolution ladder.
- [ ] Test: NMI between Leiden and Louvain communities ≥ 0.7 on a
  synthetic clustered graph (sanity, not equality).
- [ ] Document the toggle in `docs/cybereum-multiresolution-guidance.md`.

**Done when.** New tests pass on both backends; default behaviour
unchanged.

**Depends on.** PR-3.

---

## Tier 6 — Empirical credibility

The single biggest lever for the *Domain ambition* score.  These are
the PRs that move a forecast service from "implements the math" to
"validated against ground truth."

### PR-22 · Calibration loop wired through TEAC band (L, domain)

**Why.** `CLAUDE.md` *Residual backlog #5*: `response.teac` is not
read by `/completion/register-outcome` or `/completion/calibration-report`.
Calibration today is on raw finish dates, not on the TEAC band.

**Files.**
- `completion/outcomes.py` (consume `teac` block)
- `completion/calibration.py` (new — extract from outcomes.py if too
  coupled)
- `tests/test_calibration_teac.py` (new)
- `docs/calibration.md` (new)

**Checklist.**
- [ ] `/completion/register-outcome` accepts `actual_finish_date` and
  stores per-percentile prediction error vs the recorded `teac` band
  (P10..P95).
- [ ] `/completion/calibration-report` returns
  `{percentile, predicted_count, actual_within_count, calibration_score}`
  for the trailing N predictions.
- [ ] At ≥ 30 outcomes, surface a calibration warning if the empirical
  P80 hit-rate falls outside `[70%, 90%]`.
- [ ] Document the loop and the warning thresholds.

**Done when.** Loop demonstrable end-to-end on a synthetic
30-prediction sequence.

**Depends on.** PR-2 (cache versioning — calibration history must not
be mixed across schema versions).

### PR-23 · Reference class provenance audit (M, domain)

**Why.** `solver/reference_classes.py` (803 LOC) bundles 19 named
classes from multiple papers.  No machine-readable provenance.  If a
paper is updated/retracted there is no way to track downstream impact.

**Files.**
- `solver/reference_classes.py`
- `solver/_reference_provenance.py` (new)
- `tests/test_reference_provenance.py` (new)
- `docs/reference-classes.md` (new — audit table)

**Checklist.**
- [ ] Add a `provenance` field per class:
  `{paper_doi, page, equation_label, last_reviewed_iso}`.
- [ ] CI gate: every entry must have non-empty provenance; missing ⇒ red.
- [ ] `/completion/reference-classes` response includes provenance
  block per class.
- [ ] Audit doc lists all 19 classes with citation, equation, and
  empirical-validation status.

**Done when.** All 19 classes documented; CI provenance gate green.

**Depends on.** PR-7.

### PR-24 · Lipke ES from MC-sampled EV/PV (M, domain + algo)

**Why.** `CLAUDE.md` *Residual backlog #1*: stochastic TEAC composes
the MC remaining-work CPM, not Lipke ES from EV/PV.  The two diverge
on in-progress, out-of-sequence projects.  This PR makes the
stochastic TEAC use the same time-base as `/evm/analyze`.

**Files.**
- `completion/monte_carlo.py` (already split per PR-15)
- `evm/metrics.py` (extract sampler interface)
- `tests/test_teac_evm_parity.py` (new)

**Checklist.**
- [ ] Per-percentile MC sample now also samples EV(t) / PV(t)
  intersection ⇒ Lipke ES.
- [ ] `response.teac.deterministic.lipke_es_date` exposes the
  alternative midpoint.
- [ ] Parity test: deterministic Lipke ES from MC matches
  `/evm/analyze.actual.earnedSchedule.TEAC_date` to within 1 day on
  no-progress baseline (current divergence point).
- [ ] Document the new field and the relationship to the MC
  remaining-work midpoint.

**Done when.** Parity test passes; existing TEAC tests unchanged.

**Depends on.** PR-15, PR-22.

---

## Tier 7 — API contract maturity

Lowest-risk, last-touch.  Both PRs are cosmetic for current consumers
but raise the maturity score and unlock multi-tenant deployments.

### PR-25 · `/v1/` namespacing (M, prod readiness)

**Why.** Every endpoint today is at the root.  A future breaking
change has no escape valve.  Adding `/v1/` *now* (with root paths
preserved as 308-redirect aliases) is an additive change.

**Files.**
- `app.py`, every blueprint's `routes.py`
- `docs/api/README.md`

**Checklist.**
- [ ] Register every existing route under both `/<endpoint>` and
  `/v1/<endpoint>`.
- [ ] Root paths return `Deprecation: true` and
  `Link: </v1/...>; rel="successor-version"` headers.
- [ ] Document the deprecation timeline (12 months).
- [ ] Test: every existing test now also runs against the `/v1/`
  variant via parametrize.

**Done when.** Existing C# / JS consumers unaffected; new consumers
can target `/v1/`.

**Depends on.** PR-9 (request IDs help track v1 vs root traffic).

### PR-26 · OpenAPI generation (M, prod readiness)

**Why.** `docs/api/*.md` is the contract source today.  An OpenAPI
schema generated from request/response models gives consuming teams
typed clients in any language.

**Files.**
- `requirements-dev.txt` (`apispec`, `apispec-webframeworks`)
- `solver/models.py` (extract to dataclasses + marshmallow schemas)
- `docs/api/openapi.yaml` (generated, committed)
- `scripts/generate_openapi.py` (new)
- CI step

**Checklist.**
- [ ] Each blueprint exports request/response schemas; existing
  validators stay authoritative at runtime.
- [ ] `scripts/generate_openapi.py` walks the Flask app, emits
  `docs/api/openapi.yaml`.
- [ ] CI gate: regenerate, assert no diff vs committed file.
- [ ] Add a Swagger UI route at `/docs` (auth-exempt only behind
  `PYTH_ENABLE_DOCS=true`).

**Done when.** `openapi.yaml` validates with `openapi-spec-validator`;
generated TypeScript client compiles against current consumer code.

**Depends on.** PR-25.

---

## Sequencing summary

```
Tier 0  PR-1  PR-2  PR-3  PR-4         (parallel; security + correctness blockers)
        │
Tier 1  PR-5 → PR-6, PR-7, PR-8         (PR-5 first; then parallel)
        │
Tier 2  PR-9 → PR-10 → PR-11
        │
Tier 3  PR-12  PR-13  PR-14             (parallel)
        │
Tier 4  PR-15 → PR-16 → PR-17 → PR-18
        │
Tier 5  PR-19 → PR-20    PR-21          (PR-21 parallel after Tier 0)
        │
Tier 6  PR-22 → PR-24    PR-23          (PR-23 parallel after PR-7)
        │
Tier 7  PR-25 → PR-26
```

## Tracking

- One PR per checklist; no scope creep.
- Each PR description embeds its checklist verbatim; reviewer
  unticks any item that was not delivered.
- Tiers 0–2 should land in 4–6 weeks of focused work; Tiers 3–7 are
  the multi-quarter horizon.
- This roadmap is the source of truth.  Changes to the plan land as
  PRs against this file before the work itself.
