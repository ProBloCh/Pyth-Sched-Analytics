# Pyth-Sched-Analytics

Flask-based API for analysing schedule dependency networks in capital project
management. Deployed to Azure via GitHub Actions.

## Endpoints

### Descriptive analytics

| Endpoint | Method | Description |
|---|---|---|
| `POST /graph-metrics` | POST | Community detection, centrality, clustering, critical path, work packages |
| `GET /health` | GET | Service health + cache stats |

### Prescriptive analytics (CADJ-P Solver)

| Endpoint | Method | Description |
|---|---|---|
| `POST /solver/sensitivity` | POST | Single-pass gradient analysis — ranks activities by multi-objective sensitivity |
| `POST /solver/optimize` | POST | Projected gradient descent with optional Monte Carlo |
| `POST /solver/pareto` | POST | Pareto frontier sweep across objective weight vectors |
| `GET /solver/health` | GET | Solver module health check |

The solver endpoints accept the same `nodes`/`links` schema as `/graph-metrics`
plus optional `solver_config`, `activity_metadata`, and `project_context`
fields. See [`solver/Readme.md`](solver/Readme.md) for payload schema,
architecture notes, and performance targets.

## Running locally

```bash
pip install -r requirements.txt

# Development (Flask, port 5000)
DEBUG=true python app.py

# Production-like (Gunicorn, port 8000)
gunicorn --workers 2 --threads 2 --bind 0.0.0.0:8000 --timeout 120 app:app

# Health checks
curl http://localhost:8000/health
curl http://localhost:8000/solver/health
```

## Project structure

```
app.py              # Main Flask app — graph-metrics endpoint (~1,070 LOC)
solver/             # CADJ-P solver package (Flask Blueprint)
  __init__.py       #   exports solver_bp
  routes.py         #   3 POST endpoints + health
  core.py           #   orchestration layer
  models.py         #   config, activity params, project context
  dag.py            #   DAG construction + NumPy CPM engine
  objectives.py     #   5 forward objective functions
  adjoints.py       #   adjoint (gradient) engine
  stochastic.py     #   Monte Carlo ensemble with antithetic variates
  optimizer.py      #   projected gradient descent
  pareto.py         #   Pareto frontier generation
  analysis.py       #   conflict/synergy/intervention analysis
docs/               # Design documents
requirements.txt    # Python dependencies (no solver-specific additions)
Dockerfile          # Container build
```

## Guidance
- [Cybereum multi-resolution community detection guidance (review)](docs/cybereum-multiresolution-guidance.md)
- [CADJ-P solver architecture and API](solver/Readme.md)
- [World-class readiness scorecard](docs/world-class-scorecard.md)
