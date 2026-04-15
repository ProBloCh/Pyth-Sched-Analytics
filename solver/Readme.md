The solver/ package implements the CADJ-P (Cybereum Adjoint Project Solver) as a Flask Blueprint with 3 new endpoints. It integrates into the existing Pyth-Sched-Analytics service alongside the /graph-metrics endpoint.
Pyth-Sched-Analytics/
├── app.py              ← existing
├── solver/             ← NEW — copy this directory
│   ├── __init__.py
│   ├── routes.py       ← Flask Blueprint (3 endpoints)
│   ├── core.py         ← Orchestration layer
│   ├── models.py       ← Request/response data models
│   ├── dag.py          ← DAG + CPM engine (NumPy)
│   ├── objectives.py   ← 5 forward objective functions
│   ├── adjoints.py     ← Adjoint (gradient) engine
│   ├── stochastic.py   ← Monte Carlo ensemble
│   ├── optimizer.py    ← Projected gradient descent
│   ├── pareto.py       ← Pareto frontier generation
│   └── analysis.py     ← Conflict/synergy/intervention analysis
├── requirements.txt    ← update (see below)
└── ...
 Dependencies
The solver uses the same dependencies as the existing service (NumPy, SciPy, pandas). No new packages required. Verify these are in requirements.txt:
numpy
scipy
pandas
 Caching integration
The solver routes automatically import get_cached_result and set_cached_result from app.py if available. Redis caching works transparently — no configuration needed.

If caching functions aren't importable (e.g., during standalone testing), the solver falls back to no caching.

Endpoints
POST /solver/sensitivity
Single-pass sensitivity analysis. Fast (~200ms for 100 activities, ~1.5s for 1000).

When to call: On every schedule load or parameter change. Gives "what levers matter most?" insight.

POST /solver/optimize
Full gradient descent with optional Monte Carlo. Medium latency (~1s-60s depending on stochastic mode).

When to call: User clicks "Optimize" button. Returns optimized parameter set.

POST /solver/pareto
Pareto frontier sweep. Long-running (~30s-5min depending on project size and weight vectors).

When to call: User explores trade-off space. Consider async pattern for large projects.

GET /solver/health
Health check for the solver module.

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
    "antithetic_variates": true
  },
  "activity_metadata": {
    "<activity_id>": {
      "baseline_cost": 150000,
      "resource_count": 3,
      "resource_rate": 85.0,
      "activity_type": "construction",
      "crash_max_fraction": 0.28,
      "external_risk_score": 0.45,
      "combined_risk_score": 0.62,
      "schwerpunkt_score": 78,
      "supplier_type": null
    }
  },
  "project_context": {
    "calendar": { "hours_per_day": 8, "working_days": [1,2,3,4,5] },
    "phase": "construction",
    "resource_capacities": { "default": 10 },
    "constraints": { "max_end_date": "2027-06-15", "max_budget": 50000000 }
  }
}


Calling from the Cybereum app
C# backend (ComputeMetrics.cs pattern)
Same pattern as GetGraphMetrics() — POST JSON, deserialize response:

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

JavaScript frontend (fetch pattern)
Same pattern as NetworkGraph.cshtml calls to /graph-metrics:

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
Architecture Notes
No new dependencies. Uses NumPy/SciPy/pandas already in the service.
NumPy vectorized CPM. The DAG forward/backward pass is implemented in NumPy arrays with topological iteration — same algorithm as PathScripts.js but vectorized.
Resource adjoint uses finite differences (not analytical gradient) per the design review's recommendation (§1.5). The resource objective involves non-differentiable step functions at activity boundaries; the smoothed trapezoidal profile approach provides acceptable gradients.
Cost adjoint includes cross-terms per review §1.3 correction (resource_factor in ∂C/∂d, duration_factor in ∂C/∂r).
Stochastic adjoint uses antithetic variates per review §1.8 recommendation for variance reduction.
Phase-dependent default weights from the design doc are built into the models.
Performance Targets
Endpoint	100 activities	500 activities	1000 activities
/solver/sensitivity	~200ms	~500ms	~1.5s
/solver/optimize (deterministic)	~1s	~4s	~9s
/solver/optimize (MC, M=100)	~8s	~30s	~55s
/solver/pareto (30 vectors)	~30s	~2min	~4.5min
