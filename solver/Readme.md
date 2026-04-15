# CADJ-P Solver (Cybereum Adjoint Project Solver)

Multi-objective sensitivity analysis, optimisation, and Pareto frontier
generation for schedule dependency networks. Implemented as a Flask Blueprint
integrated into the Pyth-Sched-Analytics service.

## Package structure

```
solver/
├── __init__.py       # exports solver_bp
├── routes.py         # Flask Blueprint — 3 POST endpoints + health
├── core.py           # Orchestration layer (one function per endpoint)
├── models.py         # SolverConfig, ActivityParams, ProjectContext
├── dag.py            # DAG construction + NumPy-vectorised CPM engine
├── objectives.py     # 5 forward objective functions
├── adjoints.py       # Adjoint (gradient) engine
├── stochastic.py     # Monte Carlo ensemble with antithetic variates
├── optimizer.py      # Projected gradient descent
├── pareto.py         # Pareto frontier generation
└── analysis.py       # Conflict/synergy/intervention analysis
```

## Registration in app.py

Two lines after the `CORS(app, ...)` block:

```python
from solver import solver_bp
app.register_blueprint(solver_bp)
```

## Dependencies

No new packages. Uses NumPy, SciPy, and pandas already in `requirements.txt`.

## Caching integration

The solver routes lazily import `get_cached_result` and `set_cached_result`
from `app.py` on first request (not at import time, to avoid circular
dependency). Redis caching works transparently. If caching functions aren't
importable (e.g., standalone testing), the solver falls back to no caching.

## Endpoints

### POST /solver/sensitivity

Single-pass sensitivity analysis. Fast (~200ms for 100 activities, ~1.5s for
1000).

**When to call:** On every schedule load or parameter change. Answers "what
levers matter most?"

**Returns:** Objectives at current state, per-activity gradient rankings,
conflict/synergy analysis between objective pairs, critical path, and
optionally Monte Carlo uncertainty statistics.

### POST /solver/optimize

Full gradient descent with optional Monte Carlo. Medium latency (~1s–60s
depending on stochastic mode).

**When to call:** User clicks "Optimize". Returns optimised parameter set
with before/after comparison and convergence history.

### POST /solver/pareto

Pareto frontier sweep. Long-running (~30s–5min depending on project size and
weight vectors).

**When to call:** User explores trade-off space. Consider async pattern for
large projects.

### GET /solver/health

Health check for the solver module.

## Request schema

All three POST endpoints accept the same schema:

```json
{
  "nodes": [/* same schema as /graph-metrics */],
  "links": [/* same schema as /graph-metrics */],
  "solver_config": {
    "disciplines": ["schedule", "cost", "risk", "resources", "quality"],
    "weights": { "schedule": 0.35, "cost": 0.25, "risk": 0.20, "resources": 0.15, "quality": 0.05 },
    "stochastic": false,
    "monte_carlo_samples": 100,
    "max_iterations": 50,
    "convergence_threshold": 0.001,
    "antithetic_variates": true,
    "learning_rate": 0.01,
    "pareto_vectors": 30
  },
  "activity_metadata": {
    "<activity_id>": {
      "baseline_cost": 150000,
      "resource_count": 3,
      "resource_rate": 85.0,
      "crash_max_fraction": 0.28,
      "external_risk_score": 0.45,
      "combined_risk_score": 0.62
    }
  },
  "project_context": {
    "calendar": { "hours_per_day": 8, "working_days": [1,2,3,4,5] },
    "phase": "construction",
    "resource_capacities": { "default": 10 },
    "constraints": { "max_end_date": "2027-06-15", "max_budget": 50000000 }
  }
}
```

All fields except `nodes` are optional. Defaults are applied per project phase
(planning/design/procurement/construction/commissioning) — see `PHASE_WEIGHTS`
in `models.py`.

## Calling from the Cybereum app

### C# backend (ComputeMetrics.cs pattern)

Same pattern as `GetGraphMetrics()` — POST JSON, deserialise response:

```csharp
public async Task<SolverSensitivityResult> GetSolverSensitivity(
    List<ProjectActivity> nodes, List<ProjectLink> links,
    Dictionary<string, ActivityMetadata> metadata)
{
    var payload = new {
        nodes = ConvertToJsonFormat(nodes, links).nodes,
        links = ConvertToJsonFormat(nodes, links).links,
        solver_config = new { disciplines = new[] { "schedule", "cost", "risk" } },
        activity_metadata = metadata,
        project_context = new { phase = "construction" }
    };

    var content = new StringContent(
        JsonConvert.SerializeObject(payload), Encoding.UTF8, "application/json");
    var response = await _httpClient.PostAsync(
        "https://python-sched-analytics.azurewebsites.net/solver/sensitivity", content);
    var json = await response.Content.ReadAsStringAsync();
    return JsonConvert.DeserializeObject<SolverSensitivityResult>(json);
}
```

### JavaScript frontend (fetch pattern)

Same pattern as `NetworkGraph.cshtml` calls to `/graph-metrics`:

```javascript
async function runSensitivity(nodes, links) {
    const payload = {
        nodes: nodes,
        links: links,
        solver_config: {
            disciplines: ['schedule', 'cost', 'risk'],
            weights: window.cybereumState.solverWeights || { schedule: 0.35, cost: 0.25, risk: 0.20 }
        },
        activity_metadata: buildActivityMetadata(nodes),
        project_context: {
            phase: window.cybereumState.projectPhase || 'construction',
            calendar: window.cybereumState.teamCalendar
        }
    };

    const resp = await fetch(
        'https://python-sched-analytics.azurewebsites.net/solver/sensitivity',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    return resp.json();
}
```

## Architecture notes

- **NumPy-vectorised CPM.** The DAG forward/backward pass is implemented in
  NumPy arrays with topological iteration — same algorithm as PathScripts.js
  but vectorised.
- **Resource adjoint uses finite differences** (not analytical gradient) per
  the design review's recommendation (section 1.5). The resource objective
  involves non-differentiable step functions at activity boundaries; the
  smoothed trapezoidal profile approach provides acceptable gradients.
- **Cost adjoint includes cross-terms** per review section 1.3 correction
  (resource_factor in dC/dd, duration_factor in dC/dr).
- **Stochastic adjoint uses antithetic variates** per review section 1.8
  recommendation for variance reduction.
- **Phase-dependent default weights** from the design doc are built into
  `models.py` (`PHASE_WEIGHTS` dict).
- **Lazy caching import** in `routes.py` avoids the circular dependency
  between `app.py` and `solver/__init__.py`.

## Five objective functions

| Discipline | Objective | Gradient method |
|---|---|---|
| `schedule` | Project makespan | Analytical (critical-mask) |
| `cost` | Sum of rate * resources * duration | Analytical (with cross-terms) |
| `risk` | Criticality-weighted risk scores | Analytical |
| `resources` | Squared overallocation penalty | Finite differences |
| `quality` | Quadratic crash-fraction penalty | Analytical |

## Performance targets

| Endpoint | 100 activities | 500 activities | 1000 activities |
|---|---|---|---|
| `/solver/sensitivity` | ~200ms | ~500ms | ~1.5s |
| `/solver/optimize` (deterministic) | ~1s | ~4s | ~9s |
| `/solver/optimize` (MC, M=100) | ~8s | ~30s | ~55s |
| `/solver/pareto` (30 vectors) | ~30s | ~2min | ~4.5min |
