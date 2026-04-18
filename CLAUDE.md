# CLAUDE.md — Pyth-Sched-Analytics

## Project Overview

Flask-based API for analyzing schedule dependency networks in capital project
management.  Grounded in Natarajan et al. (PMJ, 2022) on reference class
forecasting for offshore O&G megaprojects and Flyvbjerg et al. (JMIS, 2022)
on fat-tailed overrun distributions.  Two capability layers:

1. **Descriptive analytics** (`POST /graph-metrics`) — community detection
   (single + multi-resolution), centrality, HDBSCAN clustering, full CPM
   with FS/SS/FF/SF + lag, risk propagation through the dependency network,
   DCMA schedule health metrics, work packages, pattern detection.
2. **Prescriptive analytics** (`solver/` package) — CADJ-P multi-objective
   sensitivity analysis, L-BFGS-B optimization with Tchebycheff Pareto
   sweeps, five-tier risk distributions (triangular → normal →
   Birnbaum-Saunders → Pareto power-law), SRA criticality/cruciality
   indices, black swan / dragon king detection, and 2D cost-schedule
   extreme-event clustering.

Deployed to Azure via GitHub Actions.

**Tech stack:** Python 3.12, Flask, NetworkX + NetworkKit (C++ acceleration),
NumPy, Pandas, scikit-learn, SciPy, Redis (optional caching).

**Architecture:** `app.py` (~1,400 LOC) handles descriptive analytics.
`multi_resolution_pipeline.py` (~335 LOC) handles hierarchical community
detection.  `solver/` (10 modules, ~2,400 LOC) is a Flask Blueprint
registered in `app.py` that provides three prescriptive endpoints plus a
health check.  `completion/` (5 modules: `__init__`, `routes`,
`monte_carlo`, `calendar`, `recovery`) is a second Flask Blueprint
serving `/completion/monte-carlo` (remaining-work finish-date forecast
wrapping `solver/stochastic.py`'s five-tier distribution) and
`/completion/recovery-options` (ranked crash + lag-compression options
composing with the MC P80).  `evm/` (6 modules: `__init__`, `routes`,
`engine`, `metrics`, `forecast`, `distributions`, `helpers`) serves
`/evm/analyze` -- a full Earned Value Management analysis (CPI, SPI,
EAC, duration-weighted progress, schedule-delay prediction, and
time-phased cumulative + period distributions) ported from the JS
`Reference/EVM.js`; output shape mirrors `window.evmMetrics` so
downstream consumers (notably `Completionprediction.js` reading
`.actual.CPIcum`) work unchanged.  Tests: 343 across 7 test files,
including a JS-vs-Python diff harness
(`tests/test_evm_diff.py` + `tests/diff_harness/run_js_evm.js`) that
runs the JS reference implementation under Node.js on shared fixtures
(basic / complete / overrun / complex / with_holidays) and asserts
every scalar metric agrees within `1e-6` relative tolerance and
predicted dates within 24 h, including holiday-skipping via the full
working-calendar path.

## Four Principles

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- **State assumptions explicitly.** If uncertain about intent, ask rather than
  guess. This is a scientific computing codebase — wrong assumptions produce
  plausible but incorrect analytical results.
- **Present multiple interpretations** when ambiguity exists. Don't pick
  silently.
- **Push back when warranted.** If a simpler approach exists, say so.
- **Stop when confused.** Name what's unclear and ask for clarification.

### 2. Simplicity First

Maintain the existing simplicity. Don't add speculative complexity.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite it.
- The codebase uses direct function calls and env-var config — maintain this
  pattern. No factories, registries, or dependency injection unless explicitly
  requested.

### 3. Surgical Changes

Touch only what you must.  The test suite (157 tests) catches regressions,
but collateral damage in untested paths is still possible.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated issues, mention them — don't fix them silently.
- When your changes create orphans (unused imports, variables, functions),
  clean up only what YOUR changes made unused.
- **Every changed line should trace directly to the request.**

### 4. Goal-Driven Execution

Define success criteria. Verify before declaring done.

- For bug fixes: describe the root cause, explain the fix, verify the endpoint
  still responds correctly.
- For new features: state what "done" looks like before writing code.
- For algorithm changes: compare outputs before and after with representative
  data.
- For multi-step work, state a brief plan:
  1. [Step] -> verify: [check]
  2. [Step] -> verify: [check]

**Note:** The project has 157 automated tests (pytest).  Run with
`python -m pytest tests/ -v`.  Verification means running the tests,
checking endpoint responses, and reviewing outputs for correctness.
When adding new features, add corresponding tests.

## Running Locally

```bash
# Install dependencies
pip install -r requirements.txt

# Run in debug mode (Flask dev server, port 5000)
DEBUG=true python app.py

# Run production-like (Gunicorn, port 8000)
gunicorn --workers 2 --threads 2 --bind 0.0.0.0:8000 --timeout 120 app:app

# Health check
curl http://localhost:8000/health
```

## Project-Specific Rules

### Dual Graph Library Paths

The codebase supports NetworkKit (C++ acceleration) with a NetworkX fallback.
Any change to graph algorithms must account for both paths. Search for `_NK`
to find the branching points.

### Numerical Correctness

Do not "simplify" or "clean up" scientific computing operations (NumPy, SciPy,
scikit-learn calls) without verifying output equivalence. Subtle changes to
matrix operations, clustering parameters, or graph traversals can silently
alter analytical results.

### Architecture: app.py + solver/ package

Descriptive analytics lives in `app.py` (single file). Prescriptive analytics
lives in `solver/` (10-module Flask Blueprint). The solver is registered in
`app.py` via two lines after `CORS(app, ...)`:

```python
from solver import solver_bp
app.register_blueprint(solver_bp)
```

**`app.py` rules:** Read and understand the relevant functions before editing —
changes to imports, module-level state, or shared helpers affect the entire
file.

**`solver/` rules:** The package has clear module boundaries (models, dag,
objectives, adjoints, stochastic, optimizer, pareto, analysis, core, routes).
Changes to shared interfaces (e.g., `DAGState`, `ActivityParams`,
`compute_gradients` signatures) ripple across modules. The `routes.py` uses
a lazy import for caching functions from `app.py` to avoid circular
dependencies — do not convert this to a top-level import.

### Multi-Resolution Pipeline

The guidance doc (`docs/cybereum-multiresolution-guidance.md`) describes the
multi-resolution community detection pipeline.  The implementation lives in
`multi_resolution_pipeline.py` and is called from `analyse()` in `app.py`
for graphs with ≥ 50 nodes.  It runs Louvain at an adaptive resolution
ladder (γ = 0.3, 1.0, 2.5, 4.0), performs NMI stability analysis across
multiple runs per tier, and builds a containment hierarchy.  The result is
added to the `/graph-metrics` response under the `multi_resolution_communities`
key (additive — does not affect the existing `CommunityGroup` column, which
remains single-resolution at `COMMUNITY_RESOLUTION`).  Uses NetworkKit
when available; falls back to NetworkX.

### Performance Awareness

This code processes large graphs (potentially 20K+ nodes). Algorithm choices
matter:
- Respect the `SMALL_GRAPH_THRESHOLD` boundary between small/big graph paths.
- Prefer sparse matrix operations for large graphs.
- Be aware of O(n^2) vs O(n) implications in any loop or matrix operation.
- Thread-count env vars (`OMP_NUM_THREADS`, etc.) are set to `1` deliberately
  to prevent CPU contention under Gunicorn — do not remove them.

### Import Order Is Load-Bearing

The `os.environ.setdefault` calls for thread-count limits (`OMP_NUM_THREADS`,
etc.) **must** appear before `numpy`, `scipy`, and `sklearn` imports. These
libraries read the env vars at import time. If imports are reorganized above
the `setdefault` block, thread limiting silently stops working. Do not
reorder the top of `app.py`.

### Caching and API Contract

Response dicts are serialized with JSON into Redis (or LRU in-memory).
Changing the structure of values returned by analytical functions can make
cached entries incompatible — callers may get stale or malformed data until
the cache expires or is flushed.

The `POST /graph-metrics` response is consumed by a frontend
(`CommunityGroups.js`). Renaming or removing response keys is a breaking
change. Add new keys freely; modify or remove existing keys only with
explicit intent to change the API contract.

The solver endpoints (`/solver/sensitivity`, `/solver/optimize`,
`/solver/pareto`) use the same Redis caching via lazy import. Their response
contracts are consumed by the C# backend (`ComputeMetrics.cs`) and JS
frontend. The same rule applies: add new keys freely, don't rename/remove
existing ones.

**Canonical API contracts live in `docs/api/`.**  Every request/response
field, its type, presence rules, and nesting is documented there:

- [`docs/api/README.md`](docs/api/README.md) — overview, stability rules,
  consumer map, and maintenance checklist.
- [`docs/api/graph-metrics.md`](docs/api/graph-metrics.md) — `POST
  /graph-metrics` request and response contract.
- [`docs/api/solver.md`](docs/api/solver.md) — all three solver endpoint
  contracts, shared request format, phase-dependent weights, validation
  limits, and the stochastic sub-object.
- [`docs/api/health.md`](docs/api/health.md) — `GET /health` and `GET
  /solver/health` contracts.

**When changing any endpoint's request or response shape, update the
corresponding `docs/api/*.md` file in the same PR.**  The docs are the
reference that consuming teams (C#, JS) rely on — keeping them current
prevents integration drift.

### Solver-Specific Rules

- **L-BFGS-B optimizer** (`optimizer.py`): Uses `scipy.optimize.minimize`
  with box constraints.  Supports augmented Tchebycheff scalarization
  (via `utopia` parameter) for Pareto sweeps.  The `learning_rate` config
  field is accepted but unused by L-BFGS-B (retained for API compat).
- **CPM with relationship types** (`dag.py`): Forward/backward passes
  handle FS/SS/FF/SF + lag.  Per-edge metadata stored in `pred_edges`
  and `succ_edges` lists on `DAGState`.  The aliasing contract (see
  docstring on `run_cpm`) must be preserved — finite-difference gradients
  depend on it.
- **Five-tier risk distributions** (`stochastic.py`): Noise floor →
  triangular → normal → Birnbaum-Saunders → Pareto power-law.  The BS
  tier is empirically validated for offshore O&G overruns (Natarajan et
  al., PMJ 2022, KS p=.89).  The Pareto tier uses α=2.0+1.5*(1-risk),
  calibrated to Flyvbjerg's IT project α≈2.35.  Supply-chain activities
  (equipment/material/services) hit fat-tail thresholds earlier.
- **Reference-class calibration** (`solver/reference_classes.py`):
  per-sector tier-4 distribution choice (`birnbaum_saunders` /
  `lognormal` / `skip`), Pareto α range, max multiplier cap, and
  per-percentile inflation factors for 19 named classes (oil & gas,
  nuclear, rail, tunnels, defense MDAP, IT, Olympics, mining, solar,
  wind, batteries, data centres, etc.).  **Five extension mechanisms**:
  (1) built-in source-code edit, (2) env var
  `PYTH_REFERENCE_CLASSES_PATH=/path/to.json` for ops-managed
  customer calibrations bundled with deploy, (3) per-request
  `config.custom_reference_classes` for one-off custom classes,
  (4) per-request `config.reference_class_overrides = {base, overrides}`
  for tweaking a built-in without registering a full custom class,
  (5) `GET /completion/reference-classes` discovery endpoint for
  frontend dropdowns.  Each class definition is schema-validated
  (`validate_class_definition`) at module load (built-ins, fail-fast on
  dev errors) and per-request (custom classes, return 400 with the
  specific field that broke).  Unknown class names return 400 with
  fuzzy-matched suggestion ("did you mean oil_gas_offshore?") via
  `difflib`.  Driven by `config.reference_class` on
  `/completion/monte-carlo`; emits a `reference_class_calibrated`
  companion in the response with empirically-corrected percentiles
  and citations.  When unset, the
  response carries a `no_reference_class` info warning and the
  historic global tier model applies (byte-equivalent to pre-2026-04).
  Sources: Flyvbjerg & Bester 2021; Aaen, Flyvbjerg et al. PMJ 2025;
  Cantarelli RCF review 2025; Sovacool & Gilbert 2014; HM Treasury
  Green Book; TII RCF guidelines.  Empty `tier_4_distribution =
  'skip'` semantics: for IT (α ≤ 1) and Olympics, BS cannot represent
  infinite mean; normal tier extends directly to Pareto.  Thin-tailed
  sectors (roads, solar, batteries) use `lognormal` instead of BS per
  Flyvbjerg & Gardner 2023 classification.
- **Calibration warnings** (`completion/monte_carlo._build_calibration_warnings`):
  surfaces input-quality concerns in every response
  (`zero_variance_risk`, `judgment_based_risk_default`,
  `no_supply_chain_classification`, `small_scope_mc`,
  `infinite_mean_reference_class`, `reference_class_judgement`,
  `no_reference_class`).  Each carries `code`, `severity`, and a
  human-readable `message`.  Mirrors the LinkedIn-discussion critique
  that judgment-derived MC inputs get laundered into misleading P80s.
- **Numerical correctness in adjoints:** The resource adjoint uses finite
  differences (review section 1.5) because the smoothed trapezoidal profile
  has non-differentiable step boundaries.  The risk adjoint is a first-order
  approximation that ignores the d(criticality)/d(makespan) feedback term
  (documented in the docstring).
- **Cost adjoint cross-terms:** `dC/dd` includes the resource factor and
  `dC/dr` includes the duration factor (review section 1.3). These are not
  bugs — they are the correct partial derivatives for `C = rate * r * d`.
- **State mutation in finite differences:** `resource_adj_dur` in
  `adjoints.py` temporarily mutates `DAGState` via `run_cpm` and restores
  it. This is safe for single-threaded Flask/Gunicorn workers but is not
  thread-safe. Do not call from concurrent threads on the same state object.
- **Sobol QMC:** Monte Carlo uses Sobol quasi-random sequences (`seed=42`)
  with `scipy.special.ndtri` precomputed once for the full sample matrix.
  Antithetic variates use `u` and `1-u` pairs (not `z`/`-z`).  Sample
  counts match the requested M exactly (Sobol generated at power-of-2,
  then truncated).

### Performance Benchmarks (with NetworkKit)

| Module | 2,500 | 5,000 | 10,000 | 15,000 |
|---|---|---|---|---|
| Full `analyse()` | 1.4s | 2.7s | 6.5s | 11.3s |
| Community detection | 96ms | 84ms | 193ms | 277ms |
| Multi-resolution | 131ms | 284ms | 749ms | 1.0s |
| Centralities | 136ms | 320ms | 785ms | 1.5s |
| Solver: sensitivity | 37ms | 73ms | 235ms | 436ms |
| Solver: optimize (20 iter) | 125ms | 192ms | 312ms | 441ms |
| Solver: MC ensemble (M=32) | 423ms | 574ms | 1.2s | 1.7s |

**NetworkKit is essential for production.**  Without it, `analyse()` at
15K activities takes ~12s (Louvain fallback) instead of 11.3s — acceptable.
But the old O(n²) dependency-grouping fallback (now guarded) would have
taken ~164s, exceeding the Gunicorn timeout.

### Deployment

Pushes to `main` trigger automatic deployment to Azure production. Treat
`main` accordingly — no experimental changes, no untested algorithm rewrites.

## Research Foundations

| Component | Method | Source |
|---|---|---|
| CPM with PDM | FS/SS/FF/SF + lag | Elmaghraby (1977), PMI Practice Standard |
| Birnbaum-Saunders distribution | Fatigue-life model for O&G overruns | Natarajan et al. (PMJ 2022), KS p=.89 |
| Pareto power-law | Fat-tailed overruns (α≈2.35 IT) | Flyvbjerg et al. (JMIS 2022) |
| Dragon king detection | Outlier-among-outliers | Sornette (2009), Natarajan et al. (PMJ 2022) |
| 2D cost-schedule clustering | K-means on joint overrun space | Natarajan et al. (PMJ 2022, Figs 15-17) |
| Criticality Index | MC critical-path frequency | Van Slyke (1963) |
| Cruciality Index | Duration-makespan correlation | Williams (1992) |
| DCMA schedule health | 14-point assessment | DCMA, GAO Schedule Assessment Guide |
| Multi-resolution communities | NMI stability + hierarchy | Lancichinetti & Fortunato (2012) |
| L-BFGS-B optimizer | Quasi-Newton with box constraints | Nocedal & Wright (2006) |
| Augmented Tchebycheff | Non-convex Pareto points | Steuer & Choo (1983) |
| Sobol QMC | Low-discrepancy sampling | Sobol' (1967) |
| HDBSCAN | Density-based clustering | Campello et al. (2013) |

## Future Improvements

### High priority (use data already flowing in)

- **Calendar-aware scheduling in the solver:** `/completion/monte-carlo`
  now supports a full working-calendar (`completion/calendar.py`,
  `hours_per_day` / `working_days` / `holidays`) via vectorised
  cumulative-sum + searchsorted advancement.  The solver CPM
  (`solver/dag.py`) still treats durations as abstract time units.
  Extending `solver/dag.run_cpm` to accept the same `WorkingCalendar`
  would make `/solver/*` output match real-world dates.
- **Hard constraint enforcement:** `max_end_date` and `max_budget` are
  parsed but never enforced in the optimizer.  These could be added as
  penalty terms or hard bounds in L-BFGS-B.
- **Link type awareness in app.py graph construction:** `build_nx_graph`
  stores `type` and `lag` as edge attributes, and `calculate_critical_path`
  now uses them via solver.dag.  But other analytics (dependency grouping,
  work packages) still treat all edges as uniform.
- **Resource-pool analytics:** The `Resources` field is only used for
  pattern detection.  Grouping activities by resource pool and computing
  per-pool criticality would leverage data already flowing in.
- **Temporal risk clustering:** `Start`/`End` dates are only used for
  work-package temporal bounds.  Date-based risk clustering (groups of
  high-risk activities bunched in time) would surface schedule hot spots.

### Medium priority (extend existing capabilities)

- **Earned Value Management (EVM):** SPI(t), CPI, EAC metrics.  Requires
  execution data (actual start/finish/cost), not just the plan.
- **Reference class integration:** The user's PMJ paper demonstrates RCF
  uplifts for O&G offshore projects (P10: 89% cost, 72% schedule).  The
  reference class dataset lives in a separate app; the solver should
  accept externally-provided uplift distributions as prior corrections.
- **Copulas for joint cost-schedule dependence:** Replace the K-means
  clustering with proper copula models (Clayton, Gumbel) for more
  rigorous dependence structure modeling.
- **Leiden algorithm:** Provably avoids Louvain's resolution limit
  (Traag et al., 2019).  Not yet in NetworkKit; would need a separate
  `leidenalg` dependency.

### Lower priority (deeper architectural changes)

- **Activity-type-specific crash curves:** Different cost-duration
  trade-offs for equipment vs labor activities.  Requires extending
  the solver's crash model beyond the current uniform `crash_max_fraction`.
- **Bayesian Network risk propagation:** Replace the topological
  averaging with conditional probability inference for more rigorous
  cascade modeling.
- **NSGA-II / MOEA/D:** Evolutionary multi-objective optimization as
  an alternative to the Tchebycheff sweep for very high-dimensional
  objective spaces.
- **Stochastic scheduling with resource constraints:** Full resource-
  constrained project scheduling under uncertainty (RCPSP/max).

## Tradeoff Note

These guidelines bias toward caution over speed. For trivial tasks (typo fixes,
obvious one-liners), use judgment — not every change needs the full rigor. The
goal is reducing costly mistakes on non-trivial work.
