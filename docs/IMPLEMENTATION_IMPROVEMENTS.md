# Implementation & Improvement Backlog

Single source of truth for implementation tasks and improvements in
Pyth-Sched-Analytics.

## Scope
This backlog is intentionally tied to the current repository architecture:
- Main Flask app (`app.py`) and `/graph-metrics` endpoint.
- Solver blueprint (`solver/`) with `/solver/sensitivity`, `/solver/optimize`,
  `/solver/pareto`, and health endpoints.
- API contract docs in `docs/api/`.

## How to use this file
- Keep priorities ordered (**P0 highest**).
- Each item should include: rationale, concrete deliverables, and acceptance criteria.
- When complete, append date + PR link in the item and the changelog section.

---

## P0 — Must do next (reliability, safety, operability)

### 1) Async execution for long `/solver/pareto` workloads
**Rationale**
`/solver/pareto` is documented as potentially long-running; synchronous handling
risks request timeout and poor UX for large inputs.

**Deliverables**
- Add async job API:
  - `POST /solver/pareto/jobs`
  - `GET /solver/pareto/jobs/{job_id}`
- Persist job state (queued/running/succeeded/failed) in Redis.
- Return correlation id in every job response.
- Add cleanup policy for stale jobs.

**Acceptance criteria**
- Pareto requests no longer block client connection for long-running jobs.
- Job status endpoint exposes progress and terminal result/error.
- Tests cover success, failure, missing job id, and expiry behavior.

---

### 2) Input guardrails and consistent error contracts
**Rationale**
The API accepts potentially large graphs; explicit limits and predictable errors
are needed for stability and client integration quality.

**Deliverables**
- Define maximum `nodes` / `links` per endpoint.
- Validate required fields and types before compute-heavy stages.
- Standardize error JSON shape across all endpoints.
- Document limits and error examples in `docs/api/*.md`.

**Acceptance criteria**
- Oversized or malformed payloads fail fast with clear 4xx responses.
- Error body schema is identical across app and solver routes.
- Contract tests enforce documented error structure.

---

### 3) Idempotency support for solver POST endpoints
**Rationale**
Retries from clients/load balancers can duplicate expensive computations.

**Deliverables**
- Support `Idempotency-Key` on:
  - `/solver/sensitivity`
  - `/solver/optimize`
  - `/solver/pareto` (sync and async submission)
- Cache/replay responses for same `(key + normalized payload + route)`.
- Define conflict behavior when same key is reused with different payload.

**Acceptance criteria**
- Duplicate submissions with same key return same response body + status.
- Key reuse with different payload returns deterministic conflict response.
- Behavior is documented and covered by integration tests.

---

## P1 — High value (analytics depth and explainability)

### 4) Standardize multi-resolution community output in `/graph-metrics`
**Rationale**
`/graph-metrics` already returns multi-resolution community data via
`multi_resolution_communities`, including `levels`, `hierarchy`, and
`stable_cores`. The remaining work is to make this a clearly documented,
stable first-class contract for frontend drill-down and client integrations.

**Deliverables**
- Explicitly document that `levels`, `hierarchy`, and `stable_cores` are
  already present under `multi_resolution_communities`, and define whether
  they should remain nested there or be promoted/aliased as standardized
  `/graph-metrics` response fields.
- Add computation timing metadata for the multi-resolution stage.
- Add request-level config overrides (resolution ladder, run count).
- Add schema docs, compatibility notes, and response examples in
  `docs/api/graph-metrics.md`.

**Acceptance criteria**
- Response contract for multi-resolution output is explicit, stable, and
  documented.
- Existing clients remain compatible (additive changes only, or documented
  aliasing/promotion strategy).
- Endpoint tests verify shape, timing metadata presence, and basic semantic
  validity.

---

### 5) Explainability payloads for optimization outputs
**Rationale**
Users need to understand why recommendations changed objective values.

**Deliverables**
- Add per-objective contribution summaries for top changed activities.
- Add optimization diagnostics:
  - convergence status
  - stopping reason
  - final gradient norm
  - iteration count
- Add human-readable intervention summary block.

**Acceptance criteria**
- `/solver/optimize` returns machine-readable and human-readable explanation fields.
- Explanations are deterministic for fixed seed/config.
- API docs include a worked example.

---

## P2 — Performance & observability

### 6) Benchmark harness and CI performance budgets
**Rationale**
Need regression detection as compute logic evolves.

**Deliverables**
- Add benchmark runner with standard dataset sizes (1k/5k/10k+ activities).
- Persist benchmark artifact in CI.
- Define per-endpoint latency budgets and fail CI on severe regressions.

**Acceptance criteria**
- CI reports median/p95 latency trends.
- Budget breaches are visible and block merge when above threshold.

---

### 7) Tracing and runtime metrics
**Rationale**
Current behavior is hard to diagnose without structured telemetry.

**Deliverables**
- Add tracing spans for: parse/validate, graph build, community detection,
  solver core, stochastic loop, caching.
- Export service metrics (latency, cache hit rate, error classes, payload size).
- Add basic dashboard/runbook in `docs/`.

**Acceptance criteria**
- Each request has trace correlation id in logs and response headers.
- Key SLO metrics are visible without code inspection.

---

## P3 — API and developer experience

### 8) Publish OpenAPI contract for all endpoints
**Rationale**
A single machine-readable contract reduces integration drift.

**Deliverables**
- Add `docs/api/openapi.yaml` covering all current routes.
- Generate and commit example clients/types for JS + C# usage.
- Validate OpenAPI in CI.

**Acceptance criteria**
- OpenAPI file is complete, valid, and versioned.
- Contract tests compare runtime responses to OpenAPI schema.

---

### 9) Strengthen request/response schema validation
**Rationale**
Validation is currently spread across route logic and implicit assumptions.

**Deliverables**
- Centralize schema definitions for payloads and key responses.
- Add uniform validation middleware/helpers.
- Return standardized field-level validation errors.

**Acceptance criteria**
- Invalid payloads consistently return actionable field messages.
- Validation logic is reusable across app and solver routes.

---

## P4 — Test maturity and change safety

### 10) Property-based/fuzz coverage for graph and solver inputs
**Deliverables**
- Add Hypothesis tests for DAG edge cases, relationship types, and lag handling.
- Add fuzz tests for malformed/partial payloads.

**Acceptance criteria**
- Tests catch invalid graph states without crashing service.
- Coverage includes both `/graph-metrics` and `/solver/*` paths.

---

### 11) Deterministic stochastic regression suite
**Deliverables**
- Seeded fixtures for stochastic solver modes.
- Numeric tolerance checks for key output metrics.

**Acceptance criteria**
- Re-runs on same commit remain within tolerance bounds.
- Drift alerts are clear when algorithm changes are intentional/unintentional.

---

### 12) API contract drift checks
**Deliverables**
- Add tests that assert `docs/api/` examples match runtime response keys/types.
- Add CI step that fails on undocumented response changes.

**Acceptance criteria**
- No breaking API change merges without docs update.

---

## Icebox (not committed to roadmap yet)
- Portfolio-level cross-project optimization.
- Learning-to-rank for intervention recommendation feedback.
- Scenario library/versioning UI support.

---

## Changelog
- 2026-04-17: Initial backlog document added.
- 2026-04-17: Backlog rewritten with acceptance criteria and repository-grounded deliverables.
