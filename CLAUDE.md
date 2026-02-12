# CLAUDE.md — Pyth-Sched-Analytics

## Project Overview

Flask web service for analyzing project scheduling networks using graph analytics, community detection, and critical path analysis. Extracts insights from project dependencies, identifies risk clusters, and generates work package hierarchies.

**Stack:** Python 3.12, Flask 3.0, NetworkX, NetworkKit (C++ accelerated), scikit-learn, pandas, numpy, scipy, Redis, Gunicorn

**Deployment:** Azure Web Apps via Docker container

## Repository Structure

```
.
├── app.py                  # Monolithic Flask application (all business logic)
├── Dockerfile              # Python 3.12-slim container with C++ build tools
├── requirements.txt        # Pinned Python dependencies
├── README.md               # Brief project description
├── docs/
│   └── cybereum-multiresolution-guidance.md  # Design doc for future multi-resolution Louvain
└── .github/
    └── workflows/
        └── main_python-sched-analytics.yml   # Azure CI/CD pipeline
```

The entire application lives in `app.py` (~1,100 lines). There are no separate modules, test files, or config files beyond what is listed above.

## Build & Run Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run locally (dev server, port 5000)
python app.py

# Run with Gunicorn (production, port 8000)
gunicorn --workers 2 --threads 2 --bind 0.0.0.0:8000 app:app

# Docker build and run
docker build -t python-sched-analytics .
docker run -p 8000:8000 python-sched-analytics
```

**No test suite exists.** There are no pytest, unittest, or any other test configurations.

**No linter/formatter is configured.** There is no flake8, pylint, black, ruff, or similar tooling.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/graph-metrics` | Primary analytics endpoint — accepts `{"nodes": [...], "links": [...]}` and returns enriched graph data with clustering, centrality, critical path, and work packages |
| `GET` | `/health` | Health check with Redis/cache stats and feature availability |
| `GET` | `/test-cors` | CORS verification |
| `GET` | `/` | Root status |

### Expected Input Schema (POST /graph-metrics)

Nodes must include: `ID`, `Duration`, `Start`, `importanceScore`, `riskScore`, `TaskType`, `Resources`, `Dependencies`, `Milestone`, `isImportanceOutlier`, `isOnCriticalPath`, `isOnOutlierPath`, `isRiskOutlier`

Links must include: `source`, `target`, `duration`, `type` (FS/SS/FF/SF), `lag`

## Architecture & Key Patterns

### app.py Internal Organization

| Lines (approx) | Section |
|-----------------|---------|
| 1–58 | Environment config, BLAS thread limits, constants |
| 64–77 | Flask app setup, CORS, logging |
| 83–143 | Redis + LRU dual-level caching layer |
| 149–197 | Pattern detection (recurring task identification) |
| 203–221 | Critical path calculation (DAG longest path) |
| 227–323 | Work package generation from clusters |
| 329–456 | Graph building (NetworkX DiGraph, vectorized pandas) |
| 462–670 | Clustering: K-means risk clustering, NetworkKit Louvain (large graphs), sparse matrix hierarchical (small graphs) |
| 672–749 | Centrality metrics (PageRank, closeness, degree, clustering coefficient) |
| 751–817 | Community detection (multi-resolution Louvain) |
| 823–918 | Main `analyse_graph()` orchestrator |
| 924–1087 | Flask route handlers |
| 1092–1095 | Entry point |

### Design Patterns

- **Two-level caching:** Redis (distributed, 1hr TTL) with LRU in-process fallback. Cache key is SHA256 of request payload.
- **Adaptive algorithm selection:** Graph size thresholds (`SMALL_GRAPH_THRESHOLD` ~50–100 nodes) determine whether to use NetworkKit (C++) or NetworkX (Python) algorithms.
- **Graceful degradation:** NetworkKit is imported with try/except; all algorithms fall back to NetworkX equivalents if unavailable.
- **Vectorized operations:** Heavy use of pandas/numpy instead of Python loops for performance.
- **Environment-driven configuration:** All tuning parameters come from env vars with sensible defaults (see constants at top of `app.py`).

## Code Conventions

### Naming

- **Functions:** `snake_case` — e.g., `build_nx_graph`, `analyse_graph`
- **Private functions:** Leading underscore — e.g., `_sha`, `_cached`, `_centralities_nx`, `_cluster_risk_kmeans`
- **Constants:** `UPPER_CASE` — e.g., `SMALL_GRAPH_THRESHOLD`, `MAX_PATTERNS`, `REDIS_CACHE_TTL`
- **Variables:** `snake_case`
- **DataFrame columns:** Mixed — some `PascalCase` (`Cluster`, `Milestone`), some `camelCase` (`isImportanceOutlier`, `importanceScore`)

### Style

- Minimal type hints (occasional type comments in signatures)
- Sparse docstrings (single-line comments preferred)
- Robust exception handling with debug logging and fallback behavior
- Logging format: `"%(asctime)s %(levelname)s » %(message)s"` — WARNING in production, DEBUG when `DEBUG=true`

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEBUG` | `false` | Enable debug logging and Flask debug mode |
| `PORT` | `8000` | Server port |
| `WEB_CONCURRENCY` | `2` | Gunicorn worker count |
| `REDIS_URL` | (none) | Redis connection string; falls back to LRU if unset |
| `REDIS_CACHE_TTL` | `3600` | Cache TTL in seconds |
| `LRU_MAXSIZE` | `32` | In-process LRU cache size |
| `SMALL_GRAPH_THRESHOLD` | `50` | Node count threshold for algorithm selection |
| `MAX_PATTERNS` | `50` | Max recurring patterns to detect |
| `OMP_NUM_THREADS` | `1` | BLAS thread limit (prevents Gunicorn contention) |

## Known Issues & Gaps

- **No tests** — No test framework, no test files, no CI test step
- **No linting** — No formatter or linter configured
- **Python version mismatch** — Dockerfile uses 3.12, CI workflow uses 3.11
- **Multi-resolution pipeline** — Designed in `docs/cybereum-multiresolution-guidance.md` but not yet implemented in code
- **No authentication** — API is public with no auth middleware
- **CORS allows all origins** — `"origins": "*"`

## CI/CD

GitHub Actions workflow (`.github/workflows/main_python-sched-analytics.yml`):
- Triggers on push to `main` or manual dispatch
- Builds a Python 3.11 venv, installs deps, zips artifact
- Deploys to Azure Web Apps via OIDC service principal
- **Does not run tests or linting**
