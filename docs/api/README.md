# API Documentation

Reference contracts for all Pyth-Sched-Analytics endpoints.  These documents
are the canonical source of truth for consuming applications (C# backend
`ComputeMetrics.cs`, JS frontend `CommunityGroups.js`, and any future
consumers).

## Endpoints

| Endpoint | Method | Doc | Description |
|---|---|---|---|
| `/graph-metrics` | POST | [graph-metrics.md](graph-metrics.md) | Descriptive analytics: community detection, centrality, CPM, risk propagation, DCMA health |
| `/solver/sensitivity` | POST | [solver.md](solver.md#post-solversensitivity) | Single-pass CADJ-P sensitivity analysis |
| `/solver/optimize` | POST | [solver.md](solver.md#post-solveroptimize) | L-BFGS-B gradient-descent optimization |
| `/solver/pareto` | POST | [solver.md](solver.md#post-solverpareto) | Pareto frontier sweep (Tchebycheff scalarization) |
| `/health` | GET | [health.md](health.md#get-health) | Main app health check |
| `/solver/health` | GET | [health.md](health.md#get-solverhealth) | Solver module health check |

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
