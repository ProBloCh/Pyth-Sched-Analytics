# Exceed-Alice Roadmap (within scope of this repo)

**Branch:** `claude/expand-alice-scope-7vbWP`
**Lens:** strategic gap analysis vs Alice Technologies, mapped to concrete
file-level milestones in this repo.
**Scope boundary:** this is a Flask analytics service.  We do not compete on
UI, 4D-BIM rendering, or asset management — those are out of scope.  We
compete on **decision quality per cubic centimetre of math**.

This document is the strategic complement to `REMAINING_WORK.md`.  Items
referenced as `RW-§X.Y` map to section numbers there; we don't restate the
library-pinning detail.

---

## TL;DR — Sequencing

Two dimensions are top-priority because they're (a) the only places Alice
has substantive math we don't, and (b) unblock follow-on work in 4 other
dimensions:

```
D4 (Calendar-aware CPM)   ─┬─► D7 (calendar-aware percentile dates)
                            ├─► D9 (recovery options report real ISO dates)
                            └─► D8 (calibration loop on real-date residuals)

D5 (RCPSP + per-pool      ─┬─► D3 (NSGA-II Pareto becomes meaningful)
     criticality)           ├─► D9 (resource re-allocation recommendations)
                            └─► D6 (pool-level community detection)

D1 (copulas) ───────────────► D2 (joint tail risk vs marginal)
```

Everything else is incremental; we can ship copulas, Leiden, CRPS, Bayesian
risk, etc. independently as additive responses.

---

## Dimension 4 — Calendar-Aware CPM in `solver/dag.py`

> **Alice's offer:** every activity has a real start/finish ISO date that
> respects working calendars and holidays.
>
> **Our position:** `solver/dag.py::run_cpm` operates in abstract time units.
> Only the makespan scalar is mapped to a date via `solver/calendar_map.py`
> (the "edge mapping").  Per-activity ES/EF therefore can't be projected to
> ISO dates without a second pass, and FF/SF lag-respecting non-working days
> isn't modelled at all.

### Goal

The forward and backward CPM passes operate in **working-hour space** when
a calendar is supplied.  Per-activity ES/EF/LS/LF map to ISO datetimes
via a stable, monotone calendar advance.  All CPM-derived analytics
(critical mask, total float, cruciality, recovery options) reflect
calendar reality.

### Definition of Done

- [ ] `DAGState` carries optional `es_ms`, `ef_ms`, `ls_ms`, `lf_ms` numpy
      arrays (epoch-ms, `float64`) populated when `WorkingCalendar` is
      attached at build time.
- [ ] `run_cpm(state, durations=None, calendar=None)` accepts an optional
      `WorkingCalendar` argument.  When supplied, the forward pass
      computes `EF[j]_ms = advance_working_ms(ES[j]_ms, d[j])` instead of
      `ES[j] + d[j]`, and the backward pass uses `retreat_working_ms`
      (new helper, the inverse of `advance_working_ms`).
- [ ] Float metrics (`TF`, critical mask) computed in working-hour space:
      `TF[i] = (LS[i]_ms - ES[i]_ms) / ms_per_working_hour` then compared
      against `1e-9` as today.
- [ ] `solver/calendar_map.py` becomes `dag-aware`: it can either project
      a single makespan scalar (as today, for back-compat) or attach a
      pre-built `WorkingCalendar` to the build call.
- [ ] `/solver/sensitivity` and `/solver/optimize` responses gain a
      `calendar.activity_dates` block: `{id: {ES_iso, EF_iso, LS_iso,
      LF_iso}}` when calendar attached, omitted otherwise.
- [ ] `/paths/calendar-slack` (currently a separate post-processing pass
      in `paths/calendar_slack.py`) becomes a thin caller — feeds in the
      same `WorkingCalendar`, reads `state.es_ms` directly.
- [ ] Existing 1.0-tolerance JS-vs-Py diff harnesses keep passing
      byte-identically when no calendar is passed.

### Concrete Milestones

| # | Task | Files | Verification |
|---|---|---|---|
| 4.1 | Add `retreat_working_ms` (inverse of `advance_working_ms`) | `completion/calendar.py` | new unit test: round-trip `advance(retreat(t, h)) == t` within 1ms |
| 4.2 | Extend `DAGState` slots with `es_ms`, `ef_ms`, `ls_ms`, `lf_ms`, `calendar` | `solver/dag.py:27` | existing solver tests still pass; new slots `None` by default |
| 4.3 | Calendar-aware forward pass | `solver/dag.py:209-226` | new fixture in `tests/test_solver.py`: 3-activity chain with weekend hits the next Monday |
| 4.4 | Calendar-aware backward pass + TF in working hours | `solver/dag.py:228-250` | total float of an activity straddling a weekend matches manual calculation |
| 4.5 | Threading the calendar from request → `build_dag` → `run_cpm` | `solver/core.py:69-99,161-189`, `solver/dag.py:55` | `/solver/sensitivity` with a calendar returns ISO dates per activity |
| 4.6 | Adjoint correctness under calendar | `solver/adjoints.py` | finite-difference check: `schedule_adj_dur` ≈ FD on a calendar-attached state to within `1e-4` relative |
| 4.7 | `paths/calendar_slack.py` consumes `state.es_ms` directly | `paths/calendar_slack.py` | existing diff harness in `tests/test_paths_diff.py` still passes |
| 4.8 | Update `docs/api/solver.md` with the `calendar.activity_dates` block | `docs/api/solver.md` | render check; consumer note added |

### Adjoint Story (the load-bearing risk)

`schedule_adj_dur` is currently `1.0` on the critical path because
`d(makespan)/d(d_i) = 1` when activity `i` is critical.  With a calendar,
the true derivative is `dh/dt × 1` where `h = working hours` and `t` =
duration.  Inside a working day this is 1.0, so we keep `g[critical] = 1.0`
as a first-order approximation — **identical to today** unless an
activity's perturbation pushes its EF across a non-working interval.  When
that happens, FD will differ from the analytic gradient; we accept the
approximation and document it in the docstring (matching the existing
treatment of the risk adjoint).  Hard requirement: a calendar-attached
finite-difference test in `tests/test_solver.py` confirms agreement to
`1e-3` relative on a representative project (so the optimiser still
converges).

### Performance Budget

`advance_working_ms` is O(log K) where K = horizon days.  The forward
pass is currently O(E) edges with O(1) work per edge; under the calendar
it becomes O(E·log K).  For K ≤ 3650 (`MAX_ISO_HORIZON_DAYS`) and a 10K-
activity project with ~30K edges, that's ~360K log lookups ≈ 5–10 ms.
Acceptable.

### Risks & Rollback

- **Aliasing contract** (`solver/dag.py:191`): the calendar attachment
  cannot break the "swap durations, restore reference" pattern that the
  finite-difference adjoints depend on.  Mitigation: `WorkingCalendar` is
  immutable post-build; only `durations` swap.
- **Cache compatibility:** Redis-cached responses gain new keys, never
  remove old ones — additive per the API stability rule.
- **Rollback:** every code path is gated on `calendar is not None`.
  Setting that to `None` reverts to today's behaviour byte-identically.

---

## Dimension 5 — Resource-Constrained Scheduling + Pool Criticality

> **Alice's offer:** schedules respect crew/equipment availability.
> Re-allocation recommendations are first-class.  This is Alice's core
> moat.
>
> **Our position:** `Resources` is a free-text field used only for
> `pattern detection` in `app.py:211-251`.  The solver has a
> `resource_objective` (smoothed trapezoidal overallocation penalty) but
> nothing that resembles RCPSP/max.  The optimiser can crash a duration
> below resource feasibility and silently return an infeasible plan.

### Goal

The repo gains two complementary capabilities: **(a)** an optional hard
resource-cap path via OR-Tools CP-SAT (`RW-§6.5.2`); **(b)** an additive
**pool-level analytics layer** that runs immediately on existing soft-
penalty data (no infrastructure decisions needed).

We sequence (b) first — it's pure-Python, additive, and ships on its own.
(a) is a strategic infrastructure decision (Java-free CP-SAT now ships
as `ortools` with a Python wheel, so deployment weight is bounded), but
it's a sizable PR; it follows.

### Sub-dimension 5A — Per-Pool Analytics (no infra change)

#### Goal

Every solver / completion / interface response gains a `pools` block:
per-resource-pool criticality, cruciality, peak demand, and overrun
risk, plus a "boundary activities" list — activities that cross pools
(handled mostly via `interface/` infra, lifted here).

#### Definition of Done

- [ ] New module `solver/pools.py` with `compute_pool_metrics(dag_state,
      params, nodes) -> dict[pool_id, PoolMetrics]`.
- [ ] `PoolMetrics` carries: `criticality` (fraction of pool-activity
      duration on the critical path), `cruciality` (Spearman ρ of
      pool-aggregate duration vs makespan across the existing MC
      ensemble), `peak_demand`, `peak_demand_window_iso`,
      `overrun_p80`, `boundary_activity_ids`.
- [ ] `solver/stochastic.py::run_monte_carlo` aggregates per-pool
      duration sums per sample (vectorised — one extra `np.add.at` per
      sample, no algorithmic cost change).
- [ ] `/solver/sensitivity`, `/solver/optimize`, `/completion/monte-carlo`
      gain an additive `pools` field.  Pool key resolution mirrors
      `interface/analytics.py`: `Resources` field tokenised on
      `,;|`, then trimmed (one activity → multiple pools).
- [ ] `/graph-metrics` gains a `pool_summary` array (descriptive view —
      simpler shape, consumer-facing).

#### Milestones

| # | Task | Files | Verification |
|---|---|---|---|
| 5A.1 | Pool tokeniser + `PoolMetrics` dataclass | `solver/pools.py` (new) | unit tests on the tokeniser: `"crane, welder; PMs"` → 3 pools |
| 5A.2 | Per-sample pool aggregation in MC | `solver/stochastic.py` | golden test: pool-aggregate sum equals `sum(activity_durations[pool_mask])` |
| 5A.3 | Cruciality = Spearman ρ of `pool_total[m]` vs `makespan[m]` | `solver/pools.py` | property test: pool containing only the critical chain has ρ ≈ 1 |
| 5A.4 | Wire into solver + completion + interface responses | `solver/core.py`, `completion/monte_carlo.py`, `interface/analytics.py` | new tests in `tests/test_solver.py` and `tests/test_interface.py` |
| 5A.5 | Pool overrun P80 — apply existing 5-tier risk model per pool | `solver/pools.py` | matches sum-of-activity P80 within 5% on triangular fixtures |
| 5A.6 | `/graph-metrics.pool_summary` (descriptive twin) | `app.py` | additive field; existing snapshot tests untouched |
| 5A.7 | Boundary activities = activities with `pool ≠ pred.pool` for any pred | reuse `interface/analytics.py` infra | reuse existing interface tests |
| 5A.8 | Update `docs/api/solver.md` and add `docs/api/pools.md` | docs | render check |

#### Why this is high-leverage

The solver already runs MC ensembles with calibrated 5-tier distributions.
Re-aggregating those samples by pool is **free at the inner loop**
(one `np.add.at` per sample) and unlocks the question every project
manager asks first: *"which crew is going to blow my schedule?"*  Alice
shows you a Gantt; we'd return the answer as a ranked list with the
fat-tail upside quantified.

### Sub-dimension 5B — Hard RCPSP/max via OR-Tools CP-SAT

#### Goal

`/solver/optimize` accepts `config.constraint_mode = "soft" | "hard"`.
Under `hard`, the L-BFGS-B path is replaced with a CP-SAT model that
encodes FS/SS/FF/SF + lag, cumulative resource constraints from
`project_ctx.resource_capacities`, and a multi-objective aggregation
matching the existing Tchebycheff scalarisation.

#### Definition of Done

- [ ] `solver/cp_sat.py` (new) wraps `ortools.sat.python.cp_model`.
      Builds intervals, no-overlap / cumulative constraints, lag
      constraints between starts/ends, and a piecewise-linear
      cost objective (the only nonlinear piece — schedule and
      resource are native CP-SAT primitives).
- [ ] Falls back to L-BFGS-B with a `solver_used: "lbfgsb"` field in the
      response when `ortools` isn't importable (matches the defensive
      blueprint registration pattern in `app.py`).
- [ ] Returns the same response shape as the soft path; new field
      `solver_used: "cp_sat"`.
- [ ] `constraints` report under hard mode: each bound either
      `satisfied: true` or the response is a 422 with
      `{infeasible: true, reason: "max_makespan", witness: ...}` (CP-
      SAT infeasibility certificates are first-class).
- [ ] New diff harness: feasibility-only test where soft and hard paths
      agree on activity start order for a no-resource-conflict project.

#### Milestones

| # | Task | Files | Verification |
|---|---|---|---|
| 5B.1 | Add `ortools>=9.10` to `requirements.txt`, gated import | `requirements.txt`, `solver/__init__.py` | image size delta ≤ 80 MB (verified via `docker images`) |
| 5B.2 | CP-SAT model builder for FS/SS/FF/SF + lag | `solver/cp_sat.py` | round-trip test: build → solve linear chain → matches `run_cpm` makespan |
| 5B.3 | Cumulative resource constraints from `Resources` tokens + capacities | `solver/cp_sat.py` | resource-conflict fixture (2 crews, 3 parallel activities, capacity 1) — order matches manual solve |
| 5B.4 | Piecewise-linear cost via `AddPiecewiseLinear` | `solver/cp_sat.py` | matches `cost_objective` to within CP-SAT discretisation tolerance |
| 5B.5 | Tchebycheff aggregation in objective | `solver/cp_sat.py` | matches `optimize.py` Tchebycheff on a no-conflict fixture |
| 5B.6 | Wire into `/solver/optimize` behind `constraint_mode` | `solver/core.py`, `solver/routes.py` | new fixture in `tests/test_solver.py` exercising both modes |
| 5B.7 | Infeasibility 422 + witness in route layer | `solver/routes.py`, `docs/api/solver.md` | infeasible fixture returns 422 with witness; soft mode returns 200 with violation |
| 5B.8 | Performance guard: skip CP-SAT for n > 1000 with explanatory error | `solver/core.py` | guard test |

#### Risks & Rollback

- **Image weight:** `ortools` Python wheel is ~75 MB.  Acceptable but
  meaningful — gate behind `EXTRAS=ortools` in CI to keep the lean
  build path.
- **Solver time variance:** CP-SAT is heuristic, sub-second on PSPLIB-100
  but pathological cases exist.  Wall-clock budget: reuse the existing
  `WALL_TIME_LIMIT = 120` from `optimizer.py:20`, return best-found
  solution with `optimal: false` flag.
- **Adjoint compatibility:** L-BFGS-B path keeps existing analytic
  adjoints.  CP-SAT has no gradients, but doesn't need them.  Pareto
  sweep must still use the L-BFGS-B path until 5B.5 lands — gated.
- **Rollback:** `constraint_mode` defaults to `"soft"`.  Setting it
  there reverts to today byte-identically.

---

## Dimension 1 — Forecasting Rigour (already exceeds; small extensions)

| # | Task | Why | Cross-ref |
|---|---|---|---|
| 1.1 | Bayesian update of per-class parameters from registered outcomes | Closes the empirical loop the literature (Flyvbjerg & Bester 2021) demands | `RW-§1.1` |
| 1.2 | Empirical-CDF transform replacing percentile factors | Eliminates the parametric-form artefact at extreme tails | `RW-§1.2` |
| 1.3 | Copulas (Clayton, Gumbel) for joint cost-schedule dependence | Replaces K-means clustering with a parametric joint model — quantifies tail dependence λᵤ | `RW-§6.4.2` for the diagnostic; copula choice is new |
| 1.4 | `powerlaw.distribution_compare` empirical α validation | Validates the `α = 2.0 + 1.5(1 - risk)` calibration | `RW-§6.4.1` |
| 1.5 | UK GMPP reference class (open-licensed, machine-readable) | Adds a 20th built-in class, government-validated | `RW-§6.6.1` |
| 1.6 | Aaen/Flyvbjerg PMJ 2025 23-type table extension | Grows from 19 to 23 classes per the latest published taxonomy | `RW-§6.6.2` |

#### Milestones (Copulas — the one item not already in `RW`)

- [ ] New module `solver/joint_distributions.py` with `fit_clayton`,
      `fit_gumbel`, `sample_clayton`, `sample_gumbel`.
- [ ] `solver/stochastic.py::run_monte_carlo` accepts
      `config.joint_dependence = "independent" | "clayton" | "gumbel"`.
- [ ] Joint cost-schedule samples drawn from the chosen copula coupling
      the cost and schedule marginals (kept as today's 5-tier).
- [ ] Tail-dependence coefficient λᵤ surfaced in the response under
      `tail_dependence`.
- [ ] Default remains `"independent"` for back-compat.

---

## Dimension 2 — Tail-Risk Detection (already exceeds; refinements)

| # | Task | File |
|---|---|---|
| 2.1 | Sector-specific Pareto α intervals (per-class min/max not just scalar) | `solver/reference_classes.py` |
| 2.2 | Conditional VaR / Expected Shortfall under each percentile in MC response | `completion/monte_carlo.py` |
| 2.3 | Dragon-king p-value via permutation test (currently heuristic threshold) | `solver/analysis.py` |

These are 50–150 LOC each; no architectural lift.

---

## Dimension 3 — Optimisation Sophistication

| # | Task | Cross-ref |
|---|---|---|
| 3.1 | Multi-start L-BFGS-B (Sobol-seeded, top-K results) | new |
| 3.2 | NSGA-II / MOEA/D alongside Tchebycheff via `pymoo` | `RW-§6.3.3` |
| 3.3 | Hard constraint enforcement via `trust-constr` (intermediate step before 5B) | `RW-§6.3.2` |
| 3.4 | Activity-type-specific crash curves (equipment vs labour) | new |

#### Why 3.1 first

It's pure-Python, requires no new dependency, and gets us 80% of the
optioneering benefit Alice sells.  K Sobol starts × existing L-BFGS-B
converges in parallel; return the top-K Pareto-non-dominated results.
~120 LOC in `solver/optimizer.py`.

---

## Dimension 6 — Network-Topology Intelligence (already exceeds)

| # | Task | Cross-ref |
|---|---|---|
| 6.1 | Leiden behind `COMMUNITY_ALGORITHM` flag | `RW-§6.3.1` |
| 6.2 | Temporal risk clustering on Start/End dates | `CLAUDE.md` future-improvements |
| 6.3 | Pool-level community detection (D5A unblocks this) | new |

---

## Dimension 7 — EVM & Earned Schedule (already exceeds; D4 unblocks the rest)

| # | Task | Status |
|---|---|---|
| 7.1 | Lipke ES from MC-sampled EV-vs-PV intersections | deferred (CLAUDE.md residual #1) |
| 7.2 | Calendar-aware percentile dates | unblocked by D4 |
| 7.3 | Per-activity TEAC bands in `activity_percentiles` | deferred (CLAUDE.md residual #4) |

#### 7.1 Sketch

`evm/engine.py::compute_earned_schedule` samples cumulative PV at every
activity Start/Finish boundary (linear interp).  Same algorithm runs per
MC sample with sample-specific finish dates → ES samples → percentile
band of TEAC values.  Aligns the stochastic TEAC and EVM TEAC time-bases
(closes the divergence currently documented in
`response.teac.deterministic.note`).

---

## Dimension 8 — Calibration & Empirical Closure

| # | Task | Cross-ref |
|---|---|---|
| 8.1 | Calibration loop reads `response.teac` (not just raw finishes) | new |
| 8.2 | Bayesian update of class priors from registered outcomes | `RW-§1.1` |
| 8.3 | CRPS proper score per outcome | `RW-§6.4.3` |
| 8.4 | Per-customer reference-class derivation | `RW-§1.3` |

---

## Dimension 9 — Recovery & Recommendation

| # | Task | Unblocked by |
|---|---|---|
| 9.1 | Resource re-allocation recommendations | D5A |
| 9.2 | Path-corridor recovery — leverage `paths/subpath_patterns` | none — ready now |
| 9.3 | Dragon-king-aware recommendations: rank by tail contribution | D2.3 |

#### 9.2 Sketch (ready now)

`paths/subpath_patterns.find_recurring_subpaths` already returns
high-recurrence corridors anchored at outliers.  Lift those into
`completion/recovery.py` as a third recovery class alongside crash and
lag-compression: a "corridor intervention" recommends parallelising a
recurring high-criticality corridor.  Pure additive — ~100 LOC,
1 weekend.

---

## Dimension 10 — API Surface & Integration (already exceeds)

| # | Task | Cross-ref |
|---|---|---|
| 10.1 | OpenAPI / JSON Schema generation from `docs/api/*.md` contracts | new |
| 10.2 | `mpxj` ingest for XER / MPP / PMXML / Asta / Synchro | `RW-§6.5.1` (gated on JVM decision) |
| 10.3 | Streaming endpoints for >20K-activity graphs | new |

---

## Cross-Cutting: New Test Infrastructure

The plan adds three test modules, all following the existing JS-vs-Py
diff-harness pattern:

| File | Covers |
|---|---|
| `tests/test_solver_calendar.py` | D4 — calendar-attached CPM, adjoint correctness, ISO date emission |
| `tests/test_pools.py` | D5A — pool aggregation, criticality, cruciality, boundary activities |
| `tests/test_cp_sat.py` | D5B — CP-SAT vs L-BFGS-B agreement on no-conflict fixtures, infeasibility certificates |

All fixtures live under `tests/fixtures/` (existing convention).  No new
JS reference is required — these are Python-only capabilities.

---

## Quarter-Sized Milestones

| Quarter | Ship | Result |
|---|---|---|
| Q1 | D4 + D9.2 + D1.3 (copulas) | Real ISO dates everywhere, corridor recovery, joint tail risk. *Feature-parity with Alice on date realism.* |
| Q2 | D5A + D7.2 + D7.3 + D3.1 (multi-start) | Pool-level analytics, calendar-aware TEAC, K-best optioneering. *Opens up Alice's adjacent territory.* |
| Q3 | D5B + D3.3 (trust-constr) + D8.2 (Bayesian classes) | Hard RCPSP/max + adaptive priors. *We now do everything Alice does, with empirical tail risk Alice doesn't.* |
| Q4 | D6.1 (Leiden), D2.3, D10.1 (OpenAPI), D5B-ingest decision | Polish, integration, productisation. |

After Q3 we have the analytical superset: every Alice capability that
falls within "decision quality per cubic centimetre of math," plus the
peer-reviewed fat-tail science that's our existing moat.

---

## What this plan deliberately does NOT include

- **4D BIM / spatial reasoning** — out of scope (no geometry kernel).
- **A schedule editor UI** — out of scope (we're a backend service).
- **Asset / equipment lifecycle tracking** — different product.
- **Vendor / subcontractor portal** — different product.
- **Automated takeoff from drawings** — different product.

Holding this line is what keeps the plan executable.  Everything above
maps to a concrete Python module, an existing or near-existing
dependency, and a verifiable acceptance test.
