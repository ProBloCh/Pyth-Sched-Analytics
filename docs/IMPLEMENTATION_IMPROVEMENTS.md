# Implementation & Improvement Backlog

A practical, prioritized backlog for Pyth-Sched-Analytics based on current
architecture and docs.

## How to use this file
- Keep this list ordered by impact (P0 highest).
- Convert selected items into GitHub issues/PRs and link them back here.
- Mark items complete with date + PR number.

---

## P0 — High-impact reliability and scalability

- [ ] **Add async job pattern for long-running `/solver/pareto` requests.**
  - Why: current docs note Pareto can run 30s–5min and suggest async for large projects.
  - Deliverables:
    - `POST /solver/pareto/jobs` to enqueue work and return job id.
    - `GET /solver/pareto/jobs/<id>` for status/result.
    - Optional webhook callback support.
    - Redis-backed job state + TTL cleanup.

- [ ] **Introduce request-level idempotency keys for solver endpoints.**
  - Why: prevent duplicate expensive computations on retries.
  - Deliverables:
    - `Idempotency-Key` support.
    - Response replay from cache for matching payload + key.

- [ ] **Add rate limiting and payload guardrails.**
  - Why: protect service from accidental overload and abuse.
  - Deliverables:
    - Per-IP and per-route quotas.
    - Explicit hard limits on nodes/links for each endpoint.
    - Structured 429/413 responses with guidance.

---

## P1 — Analytics quality and model fidelity

- [ ] **Fully integrate multi-resolution pipeline into `/graph-metrics` response.**
  - Why: guidance expects hierarchy/stability outputs and front-end drill-down.
  - Deliverables:
    - Include `levels`, `hierarchy`, `stable_cores`, and timing metadata.
    - Support request-level overrides for resolution ladder and run counts.

- [ ] **Expose explainability payloads for optimization decisions.**
  - Why: users need trustable “why” behind recommendations.
  - Deliverables:
    - Top positive/negative contributors per objective.
    - Constraint binding report and shadow-price-like indicators.
    - Human-readable intervention suggestions.

- [ ] **Calibrate risk-distribution tiers by project domain.**
  - Why: industry-specific risk behavior differs materially.
  - Deliverables:
    - Domain presets (e.g., data center, O&G, infrastructure).
    - Validation notebook + calibration dataset contract.

---

## P2 — Performance and operations

- [ ] **Add benchmark suite and performance budgets in CI.**
  - Why: prevent regressions as features grow.
  - Deliverables:
    - Baseline scenarios (1K/5K/10K/15K activities).
    - Max latency budgets per endpoint.
    - Trend report artifact per CI run.

- [ ] **Add OpenTelemetry tracing + structured metrics.**
  - Why: better production diagnostics.
  - Deliverables:
    - Trace spans for graph build, community, solver phases, Monte Carlo.
    - Prometheus metrics for latency, cache hit rate, queue depth, error classes.

- [ ] **Improve cache strategy with versioned keys.**
  - Why: safer schema evolution without manual flushes.
  - Deliverables:
    - Cache key prefix by API/schema version.
    - Optional per-endpoint TTL overrides.

---

## P3 — API and developer experience

- [ ] **Publish an OpenAPI spec and generate client SDKs.**
  - Why: improves integration quality for C# and JS consumers.
  - Deliverables:
    - `openapi.yaml` checked into repo.
    - Generated typed clients and usage examples.

- [ ] **Expand docs with cookbook examples and failure modes.**
  - Why: reduce integration ambiguity.
  - Deliverables:
    - “Small/medium/large schedule” request templates.
    - Error-handling matrix for 4xx/5xx.

- [ ] **Add typed schema validation for all payloads.**
  - Why: fail fast and produce predictable error responses.
  - Deliverables:
    - Centralized validator module.
    - Consistent error envelope format.

---

## P4 — Testing and quality gates

- [ ] **Increase property-based and fuzz tests for graph + solver inputs.**
  - Why: schedule data can be messy and adversarial.
  - Deliverables:
    - Hypothesis tests for DAG/link edge cases.
    - Randomized payload stress tests.

- [ ] **Add deterministic replay tests for stochastic modes.**
  - Why: ensure reproducibility under fixed seeds.
  - Deliverables:
    - Seeded regression fixtures.
    - Tolerance bands for probabilistic outputs.

- [ ] **Add contract tests for documented API structures.**
  - Why: keep `docs/api/` and live responses in sync.
  - Deliverables:
    - Response key/type assertions per endpoint.
    - CI check that fails on undocumented response drift.

---

## Nice-to-have innovation items

- [ ] **Scenario manager for what-if planning bundles.**
  - Save/compare optimization scenarios with versioned assumptions.

- [ ] **Human-in-the-loop recommendation ranking.**
  - Capture user acceptance/rejection to improve intervention ranking over time.

- [ ] **Portfolio-level optimizer (multi-project coupling).**
  - Extend from single schedule to cross-project shared-resource optimization.

---

## Changelog for this backlog
- 2026-04-17: Initial backlog created.
