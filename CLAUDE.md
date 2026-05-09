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
`.actual.CPIcum`) work unchanged.

`paths/` (9 modules: `__init__`, `_constants`, `routes`, `enumerate`,
`distances`, `calendar_slack`, `diversity`, `driving_graph`,
`subpath_patterns`) is a fifth Flask Blueprint serving five POST
endpoints plus a health check, all ported from `Reference/PathScripts.js`.
`/paths/enumerate` returns the critical / near-critical path corpus
(exact DFS for small DAGs, longest-first best-search for large ones,
with structural-diversity / independence selectors).
`/paths/driving-graph` returns CPM-derived deterministic driving chains
with predecessor-ranking explainability.  `/paths/distances` returns
shortest / longest distance-to-start and -to-end maps.
`/paths/calendar-slack` projects CPM ES/EF onto ISO dates via the
working-calendar path.  `/paths/recurring-subpaths` mines contiguous
"key work glue" corridors that recur across the corpus, anchored at
outlier nodes in centrality (betweenness, in/out-degree from the
post-cycle-break DAG) or salience (risk, importance, overrun-
probability).  Anchor identification uses median + MAD z-scores (with
mean+stdev fallback when MAD degenerates), candidates are scored by
`supp + junc + sal − maxpen` with per-node sigma-then-mean for the
salience component, and a fallback window-scan fires when fewer than
`fallback_min_anchors` exist or anchor-pair extraction yields nothing.

`interface/` (3 modules: `__init__`, `analytics`, `routes`) is a sixth
Flask Blueprint serving `/interface/analytics` (boundary-crossing
intelligence) plus `/interface/health`.  Source-agnostic over Cybereum-
native `{nodes, links}` payloads regardless of origin (P6 XER, MSP XML,
native authoring) -- only requires that nodes carry the chosen
`grouping_field`.  Auto-resolves the grouping field via fallback chain
`WBS_Path → WBS_Name → WBS → WBS_ID` when omitted.  Returns per-group
hotspot rows with composite score in `[0, 100]`, cross-group dependency
matrix, and top-N highest-risk activities per hotspot for downstream
LLM grounding.  Engine is pure pandas/numpy with no Flask deps;
re-callable via `compute_interface_analytics`.

Tests: **803 across 9 test files**, including a JS-vs-Python diff
harness (`tests/test_evm_diff.py` + `tests/diff_harness/run_js_evm.js`,
plus `tests/test_paths_diff.py` + `tests/diff_harness/run_js_paths.js`)
that runs the JS reference implementations under Node.js on shared
fixtures and asserts numerical equivalence within `1e-6` relative
tolerance.  EVM diff covers basic / complete / overrun / complex /
with_holidays fixtures with predicted dates within 24 h including
holiday-skipping via the full working-calendar path.

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

### JS Reference, Python Service, Frontend Fallback

Several backend services in this repo are direct ports of frontend
algorithms from `Reference/*.js` (EVM.js, Completionprediction.js,
PathScripts.js, etc.).  The same pattern recurs and should be followed
for any new port:

1. **JS is the source of truth** for the algorithm.  When porting,
   match its semantics function-for-function -- including known
   bugfixes documented in the JS comments.  When in doubt about
   intended behaviour, the JS implementation wins.

2. **Python service replicates the algorithm** behind a Flask
   blueprint endpoint (one of `/solver/*`, `/completion/*`, `/evm/*`,
   `/paths/*`).  The response shape must match what the frontend
   consumer (`window.evmMetrics`, `findAllPaths` callers, etc.)
   expects, so the JS callers don't need to change.

3. **JS-vs-Py diff harness in `tests/diff_harness/`** verifies parity
   on shared JSON fixtures.  Pattern:
   * `tests/diff_harness/run_js_<area>.js` -- a Node CLI that loads
     `Reference/*.js` in a stubbed browser sandbox, runs the JS
     functions on the fixture, emits JSON.
   * `tests/diff_harness/<area>_fixture_*.json` -- shared fixtures
     covering the analytical edge cases (linear, diamond, parallel
     branches, mixed FS/SS/FF/SF + lag, etc.).
   * `tests/test_<area>_diff.py` -- pytest module that spawns the
     Node harness via subprocess, runs the Python implementation on
     the same fixtures, asserts numerical equivalence within
     `1e-6` relative tolerance.  Skips automatically when Node isn't
     installed (`shutil.which('node')`).

   Existing examples: `tests/test_evm_diff.py` (EVM scalars, working
   calendar, distributions), `tests/test_recovery_diff.py`,
   `tests/test_paths_diff.py` (path enumeration, CPM, distances,
   driving graph).

4. **Divergence policy.**  When the harness reports a JS-vs-Py
   mismatch, treat it as **investigate which side is right before
   adjusting**.  The Python port is sometimes more correct than the
   JS reference (e.g., JS `findDistancesToStart` only seeds
   `startNode` at 0 while Python seeds every predecessor-less node).
   Document expected divergences inline in the test with the JS
   line number and a short justification, then guard the assertion
   accordingly -- don't silently relax the Python behaviour to match
   a JS bug.

5. **JS retained as a fallback.**  We do not delete the JS once a
   Python service exists.  The frontend calling pattern is:

       try {
           result = await callPythonService(...);   // /paths/enumerate, etc.
       } catch (err) {
           console.warn('Backend unavailable, falling back to JS', err);
           result = findAllPaths(...);              // JS reference
       }

   This keeps the app functional during deploys, Azure outages, or
   when the service hits validation/timeout limits.  For this to
   work the JS and Py outputs must remain shape-compatible, which
   the diff harness enforces.

6. **Updated JS files are copied back to the frontend.**  When a port
   surfaces a JS bug (or a frontend caller needs a tweak to match the
   new Python service), the corrected JS goes both into
   `Reference/*.js` (so the diff harness exercises it) and into the
   main app's vendored copy.  Both paths must stay in sync; the diff
   harness will catch drift on the next CI run.

### Project DAG Convention: Start ID '0', End = Max Numeric ID

The main app maintains every project graph as a DAG between an artificially
created start node (ID `'0'`) and end node (the largest numeric ID).  Treat
this as the canonical convention across blueprints:

* Default-anchor selection in routes (e.g. `paths/routes.py::_default_start_end`,
  matching `Reference/PathScripts.js::findPathsToAndFromNode` lines 6720-6721)
  must prefer `'0'` for start and the max numeric ID for end before falling
  back to predecessor-less / successor-less heuristics.
* `'0'` and `0` are valid IDs -- never use truthiness checks (`if not start_id`,
  `start_id or default`) on user-supplied or inferred IDs; use explicit
  `is None` / empty-string checks instead.
* Activities with these IDs are typically zero-duration milestones; validators
  must accept `Duration` sentinels `('', None, 0, '0')` as `0.0` (matches
  `solver/dag.py::build_dag`, `completion/`, `evm/`).

### Architecture: app.py + blueprint packages

Descriptive analytics lives in `app.py` (single file).  Each prescriptive
or specialised capability lives in its own Flask Blueprint package
registered in `app.py` after `CORS(app, ...)` via the same defensive
`try/except` wrapper:

```python
from solver import solver_bp
app.register_blueprint(solver_bp)
# ...similarly for completion_bp, evm_bp, paths_bp, interface_bp
```

The wrapper logs a warning and continues if a package fails to import,
so a partial install never knocks the whole service offline.

**`app.py` rules:** Read and understand the relevant functions before editing —
changes to imports, module-level state, or shared helpers affect the entire
file.

**`solver/` rules:** The package has clear module boundaries (models, dag,
objectives, adjoints, stochastic, optimizer, pareto, analysis, core, routes).
Changes to shared interfaces (e.g., `DAGState`, `ActivityParams`,
`compute_gradients` signatures) ripple across modules.  The `routes.py` uses
a lazy import for caching functions from `app.py` to avoid circular
dependencies — do not convert this to a top-level import.

**`paths/` rules:** Module boundaries: `routes` (HTTP), `enumerate` (the
two enumeration strategies + dispatcher), `distances`, `calendar_slack`,
`diversity` (independence / structural-diversity selectors),
`driving_graph` (CPM-derived chains + explainability),
`subpath_patterns` (recurring corridor mining), `_constants`
(`MAX_NODES = 20_000`, leaf module so `routes.py` and
`subpath_patterns.py` can both reference it without an import cycle).
The `routes.py` lazy-imports cache functions from `app.py` for the same
reason as `solver/`.  `find_all_paths` exposes an opt-in
`return_internal_state=True` that surfaces the live `DAGState` +
`id_to_idx` for in-process consumers (used by `subpath_patterns.py` to
avoid a second `build_dag` call); JSON-emitting callers must leave the
default `False` to keep the response shape stable.  The truncation
contract on `paths/enumerate.py` is **load-bearing**:
`enumerate_all_paths_exact` and `enumerate_longest_paths_first` return
`(paths, truncated)` tuples; `find_all_paths` surfaces `corpus_truncated`
as the OR of three independent counters (per-node DFS cap, longest-first
budget exit + tracker eviction, heap-trim drops).  Don't reintroduce the
old heuristic (`method == 'longest_first'` or `len(raw) >= max_paths`) —
it was a false-positive on organic drains and a false-negative on
small-corpus exhaustive runs.

**`interface/` rules:** Three modules: `routes` (HTTP), `analytics`
(pandas/numpy engine — no Flask deps), `__init__` (re-exports the
blueprint plus `InterfaceConfig`, `HotspotWeights`,
`compute_interface_analytics` so the engine is callable directly without
HTTP).  Source-agnostic over `{nodes, links}` payloads regardless of
origin.  `grouping_field` is configurable per request; when omitted the
engine walks `WBS_Path → WBS_Name → WBS → WBS_ID` and picks the first
populated field, with a warning on partial population.  Engine returns
an internal `_hotspot_records` handle that the routes layer uses to
attach `top_incoming` / `top_outgoing` activity samples to each hotspot
row — not part of the API surface, do NOT expose it.  Composite hotspot
score uses min-max normalisation per group; constant or empty series
score zero (single-bucket schedules report no hotspots rather than
crash).  `/graph-metrics` and `/interface/analytics` are complementary
lenses, not competitors — don't fold interface logic into graph-metrics.

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

### Algorithm Selection: Augment with Switches, Not Replace

Lifted from `docs/exceed-alice-roadmap.md` because it governs every PR
on this codebase, not only the items in that roadmap.

When a PR adds a new algorithm or method that overlaps with an existing
one, the default should be **augment with a switch**, not replace.  The
existing algorithm stays the default; the new one becomes opt-in via a
config field, env var, or new tier.  A scientific computing service's
value is partly in exposing the menu of methods so the analyst can pick
the right tool — not in adopting whatever the latest paper said.

Concrete examples already in this codebase:

| Existing | Switchable addition | Default |
|---|---|---|
| K-means 2D extreme-event clustering (`solver/stochastic.py::_detect_2d_extremes`) | Copulas (when D1.3 lands) | K-means stays the descriptive lens; copulas augment for generative sampling |
| Topological-averaging risk propagation (`solver/analysis.py`) | Bayesian network (when `RW-§6.5.3` lands) | Topo averaging is the default (O(V+E), unbiased on linear-Gaussian) |
| Soft-penalty constraints (`solver/optimizer.py:CONSTRAINT_PENALTY_LAMBDA`) | CP-SAT hard mode (when D5B lands) / `trust-constr` | `constraint_mode="soft"` is the default forever — bounds may be aspirational, not hard |
| Louvain community detection (`multi_resolution_pipeline.py`) | Leiden (when `RW-§6.3.1` lands) | Louvain stays default; Leiden behind `COMMUNITY_ALGORITHM` flag |
| L-BFGS-B + Tchebycheff (`solver/optimizer.py`) | NSGA-II / MOEA/D (`RW-§6.3.3`), CP-SAT (D5B) | All three exposed; consumer picks per `solver_used` field |
| Heuristic dragon-king threshold (`solver/analysis.py`) | Permutation-test p-value (when D2.3 lands) | Threshold gives the binary flag; p-value attaches confidence — both side by side |

Defended against replacement: the triangular tier in the 5-tier risk
model.  Triangular is the right estimator for low-information regimes
(only min/mode/max known); it is not a placeholder for something
better, it is the optimal choice for its information regime.

### Compute and Payload Budget

Lifted from `docs/exceed-alice-roadmap.md`.  Every additive field
grows response payloads, fills Redis, and lengthens p99.  Without a
budget, responses sprawl.

| Concern | Budget | Mechanism |
|---|---|---|
| `/solver/optimize` p99 | ≤ 8 s for 5K-activity project (current ~6.5 s for 10K — see Performance Benchmarks above) | Pareto sweep parallelism, guard CP-SAT for n > 1000 |
| `/completion/monte-carlo` response size | ≤ 250 KB pre-gzip on a 1K-activity project | Top-N truncation on `pools` (default 20, configurable), nested objects elided when empty |
| `/solver/sensitivity` response size | ≤ 150 KB pre-gzip on a 1K-activity project | Same top-N rule; `pools` mirrors `interface/` shape so consumers reuse parsers |
| Redis per-response | ≤ 1 MB | LRU eviction guards this; informational threshold |
| Image size | ≤ 1.2 GB (currently ~900 MB) | `ortools` (D5B) and `pymoo` (D3.2) gated behind `EXTRAS=...`; lean default unchanged |

When proposing a new response field, sanity-check against the relevant
budget row.  When proposing a new dependency that adds >100 MB to the
image, gate it behind `EXTRAS=`.

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

- **Calendar-aware scheduling inside the solver CPM (full parity):**
  `/solver/sensitivity` and `/solver/optimize` now expose an additive,
  opt-in `calendar.makespan_end_date` mapping (gated on
  `project_context.start_date` plus any calendar field) that converts
  the abstract makespan to a real end date via the same vectorised
  `WorkingCalendar` used by `/completion/monte-carlo`
  (`solver/calendar_map.py`).  This is the **edge mapping** only --
  the response-side translation of one abstract scalar to one ISO
  date.  The solver CPM (`solver/dag.py`) itself still treats
  durations as abstract time units, so per-activity ES/EF do **not**
  map to dates and FF/SF lags do **not** respect non-working days.
  Extending `run_cpm` to honour the calendar during the
  forward/backward pass -- so per-activity dates are real and the
  Gantt-chart view is exact -- remains the substantive gap.
- **Soft-penalty constraint enforcement (DONE; hard enforcement
  remains future work):** `solver/optimizer.py` applies a normalised
  quadratic penalty (`CONSTRAINT_PENALTY_LAMBDA = 50`) for
  `max_makespan` and `max_budget`, with gradients reusing the analytic
  schedule and cost adjoints (no extra CPM evaluation).  Both
  `/solver/sensitivity` and `/solver/optimize` surface a `constraints`
  report with `{bound, final_value, violation, satisfied}` per active
  constraint, plus a `warnings` array using one of six specific codes
  when an `max_end_date` can't be resolved:
  `unresolved_max_end_date_no_start`,
  `unresolved_max_end_date_bad_start`, `malformed_max_end_date`,
  `max_end_date_before_start`, `max_end_date_too_far_in_future`,
  `malformed_calendar_config`.  See `docs/api/solver.md` for the full
  code semantics.  **Note:** the penalty is **soft** -- an infeasible
  bound produces a best-effort solution with `satisfied: false` and a
  `violation` magnitude, not a hard refusal or a guaranteed-feasible
  output.  True hard enforcement (Augmented Lagrangian, active-set
  SQP, or projection) is deferred.
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

- **Earned Value Management (EVM) — Earned Schedule (DONE):**
  `/evm/analyze` returns an `actual.earnedSchedule` block with the
  Lipke (2003) `ES`, `SPI(t) = ES / AT`, and `TEAC(t) = max(AT, PD /
  SPI_t_model)`, alongside the existing cost-based SPI/CPI/EAC.
  `compute_earned_schedule` in `evm/metrics.py` samples cumulative PV
  at every activity Start/Finish boundary (BCWS is piecewise-linear,
  so linear interpolation between samples is exact) and returns flags
  for the `not_started`, `completed`, `no_baseline`, and
  `status_before_start` edge cases.  The cost-based SPI fields are
  unchanged (additive only).  The block carries an `uncertaintyHint`
  pointer to `/completion/monte-carlo` for the stochastic counterpart.
- **Stochastic TEAC composition (DONE):**
  `/completion/monte-carlo` returns a `teac` block that composes the
  per-percentile MC finish dates with a baseline `projectStartDate`
  anchor to produce Lipke-style time-based EAC values per percentile
  (`P10` / `P20` / `P50` / `P80` / `P95`), each with `teac_days`,
  `teac_date`, raw and clamped `SPI(t)`, and `impact_days` vs the
  deterministic baseline.  `_compose_teac_block` in
  `completion/monte_carlo.py` reuses the already-sorted samples (no
  second pass) and surfaces a `deterministic.teac_date` companion
  representing the **MC remaining-work CPM midpoint** (no risk
  multipliers).  This is intentionally NOT the same number as
  `/evm/analyze.actual.earnedSchedule.TEAC_date`, which uses
  `max(AT, PD / SPI_t_model)` from the cost-side EV vs PV
  intersection; the two agree at no-progress baseline but diverge
  for in-progress, out-of-sequence, or status-after-completion
  projects because they're different computations.  `/evm/analyze`
  remains the authoritative deterministic TEAC; the MC's
  deterministic field exists so the percentile band has a natural
  midpoint readable in one response.  A `crossReference` block points
  back to the EVM endpoint and the divergence is documented in
  `response.teac.deterministic.note`.  Closes the deterministic-vs-
  stochastic loop the research foundation (Natarajan PMJ 2022,
  Flyvbjerg JMIS 2022) demands: Earned Schedule is no longer a single
  number a customer could mistake for a forecast — it's a five-tier-
  risk-model band around the deterministic midpoint.

  **Residual backlog after this PR (deferred, all non-blocking):**
  1. **Stochastic TEAC composes the MC remaining-work CPM, not Lipke
     ES from EV/PV.**  `response.teac.deterministic` ≠
     `/evm/analyze.actual.earnedSchedule.TEAC_date` for in-progress,
     out-of-sequence, or status-after-completion projects.  A natural
     follow-up would be to compute Lipke ES from MC-sampled
     EV-vs-PV intersections (per percentile), so the stochastic TEAC
     and EVM TEAC use the same time-base.  Acceptable today: docs and
     `note` field call out the divergence; consumers wanting the
     EVM-form TEAC can read it from `/evm/analyze`.
  2. **Calendar-aware percentile dates.**  The stochastic TEAC reuses
     the MC propagation, which respects working calendars when
     `project_context.calendar` is supplied.  When it isn't,
     `teac_days` are wall-clock calendar days, not working days.
     Consistent with `evm.metrics.compute_earned_schedule` (also
     calendar-day based by default), but a customer wanting working-
     day TEAC would need to set the calendar.
  3. **All-completed Lipke clamp diverges from public iso fields.**
     For `flags.all_completed && status_date > latest ActualFinish`,
     the `teac` block clamps to `status_date` while public
     `expected_finish`/`p*_finish` keep the actual completion.
     Documented as the regular-vs-edge-case relationship; both views
     are deliberately exposed so consumers can pick the right one.
  4. **Per-activity TEAC bands.**  `response.activity_percentiles`
     gives per-activity P20/P50/P80 finish dates but no TEAC view
     (no anchoring at activity-baseline-start).  Trivial extension
     when a customer asks for it.
  5. **Calibration-loop integration.**  `response.teac` is not yet
     read by `/completion/register-outcome` /
     `/completion/calibration-report`; calibration today is on raw
     finish dates, not on the TEAC band.  Useful for closing the
     empirical loop but not required for the band itself.
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
