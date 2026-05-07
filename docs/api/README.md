# API Documentation

Reference contracts for all Pyth-Sched-Analytics endpoints.  These documents
are the canonical source of truth for consuming applications (C# backend
`ComputeMetrics.cs`, JS frontend `CommunityGroups.js`, and any future
consumers).

## Capability domains

Each endpoint answers a specific PM-level decision question.  Use this
table to pick the right endpoint without reading every schema doc.  The
**Wired** column reflects the .NET app integration -- endpoints marked
"shipped, unwired" are net-new agentic surface area callable directly
from any consumer (MCP, agent, third-party).

| # | Decision question | Endpoint(s) | Wired in .NET app |
|---|---|---|---|
| 1 | "What's the topology and structure of this schedule right now?" (centrality, clustering, communities, density, risk propagation) | `POST /graph-metrics` (per-node centrality + clustering + Louvain + risk propagation + coupling density) | C# + JS for centrality overlay; `propagated_risk` / `risk_transmission` / `coupling_density` shipped, unwired |
| 2 | "How should this schedule be grouped -- what are the natural work packages and stable cores?" | `POST /graph-metrics` (`work_packages`, `multi_resolution_communities` with `stable_cores`, `DependencyCluster`) | `multi_resolution_communities` consumed by `CommunityGroups.js`; `work_packages` + `stable_cores` shipped, unwired |
| 3 | "What repeating activity patterns / templates exist in this schedule?" | `POST /graph-metrics` (`templates`) | Shipped, unwired |
| 4 | "Is this schedule healthy by industry standards (DCMA 14-point)?" | `POST /graph-metrics` (`schedule_health`) | Wired (C# + JS) |
| 5 | "Which sequences of work matter most? Give me the critical / near-critical path corpus, distances, and calendar-aware slack." | `POST /paths/enumerate`, `POST /paths/distances`, `POST /paths/calendar-slack`, `POST /paths/driving-graph` | Shipped, unwired (covers ~30% of `PathScripts.js`; remaining ~70% stays client-side by design) |
| 6 | "Which corridors of activities recur across many critical / near-critical paths and are bracketed by structural junctions or risk transitions?" | `POST /paths/recurring-subpaths` (PR #604) | Wired (frontend `PathPatterns.js` -> "Recurring Corridors" card on `Pathdistribution.cshtml`) |
| 7 | "When will we finish, with what confidence (P20/P50/P80/P95), and what's the percentile-band TEAC?" | `POST /completion/monte-carlo` | Wired (`Completionprediction.js`) |
| 8 | "What ranked recovery options can we pull (crash candidates, lag compression, fast-track)?" | `POST /completion/recovery-options` | Wired (`Completionprediction.js`) |
| 9 | "Calibrate the forecast against actual outcomes -- register, report, and look up reference-class priors." | `POST /completion/register-outcome`, `GET /completion/calibration-report`, `GET /completion/reference-classes` | Shipped, unwired (foundation of the recursive self-improvement roadmap) |
| 10 | "How is cost + schedule actually performing vs plan? CPI/SPI, EAC/ETC/TCPI, Earned Schedule, sector overrun." | `POST /evm/analyze` | Wired (`EVM.js` async wrappers) |
| 11 | "Which interventions across cost / schedule / risk / resources / quality move the project most? Run sensitivity, optimize, sweep the Pareto frontier -- with hard constraints (`max_makespan`, `max_budget`) under soft-penalty enforcement and stochastic-event entries (Black Swan / Dragon King / SRA / cost-schedule joint)." | `POST /solver/sensitivity`, `POST /solver/optimize`, `POST /solver/pareto` | Shipped, unwired |

## Endpoints

| Endpoint | Method | Doc | Description |
|---|---|---|---|
| `/graph-metrics` | POST | [graph-metrics.md](graph-metrics.md) | Descriptive analytics: community detection, centrality, CPM, risk propagation, DCMA health |
| `/solver/sensitivity` | POST | [solver.md](solver.md#post-solversensitivity) | Single-pass CADJ-P sensitivity analysis |
| `/solver/optimize` | POST | [solver.md](solver.md#post-solveroptimize) | L-BFGS-B gradient-descent optimization |
| `/solver/pareto` | POST | [solver.md](solver.md#post-solverpareto) | Pareto frontier sweep (Tchebycheff scalarization) |
| `/completion/monte-carlo` | POST | [completion.md](completion.md#post-completionmonte-carlo) | Remaining-work MC finish-date forecast (P20/P50/P80) |
| `/completion/recovery-options` | POST | [completion.md](completion.md#post-completionrecovery-options) | Ranked crash + lag-compression options |
| `/completion/reference-classes` | GET | [completion.md](completion.md#discovery-endpoint) | List built-in + env-loaded reference classes for sector dropdowns |
| `/completion/register-outcome` | POST | [completion.md](completion.md#post-completionregister-outcome) | Register a closed-project predicted-vs-actual outcome for calibration |
| `/completion/calibration-report` | GET | [completion.md](completion.md#get-completioncalibration-report) | Aggregate accumulated outcomes into per-class calibration ratios + advisories |
| `/evm/analyze` | POST | [evm.md](evm.md#post-evmanalyze) | EVM analysis: CPI/SPI/EAC + time-phased distributions |
| `/paths/recurring-subpaths` | POST | [paths.md](paths.md#post-pathsrecurring-subpaths) | Recurring-subpath ("key work glue") mining over the critical / near-critical corpus |
| `/health` | GET | [health.md](health.md#get-health) | Main app health check |
| `/solver/health` | GET | [health.md](health.md#get-solverhealth) | Solver module health check |
| `/completion/health` | GET | [completion.md](completion.md#get-completionhealth) | Completion module health check |
| `/evm/health` | GET | [evm.md](evm.md#get-evmhealth) | EVM module health check |

## API Stability Rules

1. **Adding keys is safe.**  Consumers must tolerate unknown keys.
2. **Renaming or removing existing keys is a breaking change.**  Coordinate
   with all consumers before making such changes.
3. **Changing a value's type** (e.g., `float` to `string`) is a breaking
   change.
4. **Optional/conditional keys** (marked "conditional" in the docs) may be
   absent.  Consumers must handle their absence.
5. **Cached responses** are stored in Redis as JSON.  Structural changes
   can make cached entries incompatible.  After breaking changes, flush
   the cache or use a new cache-key prefix (see `redis_key` in `app.py`).

## Consuming Applications

| Consumer | Language | Entry Point | Keys Used |
|---|---|---|---|
| Frontend | JavaScript | `CommunityGroups.js` | `nodes`, `links`, `work_packages`, `critical_path`, `multi_resolution_communities`, `schedule_health`, `templates` |
| Backend | C# | `ComputeMetrics.cs` | `/solver/sensitivity`, `/solver/optimize`, `/solver/pareto` responses |

## Maintaining These Docs

When you modify the API (new keys, changed structures, new endpoints):

1. **Update the contract doc first.**  Change the relevant `.md` file in
   `docs/api/` before or alongside the code change.
2. **Mark new keys** with the PR or version that introduced them.
3. **Mark deprecated keys** with a `Deprecated` note and the planned
   removal timeline.  Do not remove them from the doc until they are
   actually removed from the code.
4. **Run the test suite** (`python -m pytest tests/ -v`) to verify the
   endpoint still returns the documented structure.
5. **Review diff of docs/** in your PR to confirm the contract change is
   intentional and complete.

### Checklist for API Changes

```
- [ ] Updated the relevant docs/api/*.md file
- [ ] New keys documented with type, description, and example
- [ ] No existing keys renamed or removed without coordination
- [ ] Tests pass and cover the new/changed response structure
- [ ] CLAUDE.md still accurate (if architectural change)
```
