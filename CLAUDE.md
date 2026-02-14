# CLAUDE.md

## Project Overview

Pyth-Sched-Analytics is a Flask-based web service for analyzing project scheduling networks (DAGs). It accepts schedule data (nodes with durations/dates, links with dependencies) and returns enriched analytics: critical path, community detection, centrality metrics, work packages, risk/importance clustering, and repeating pattern detection.

**Deployed to:** Azure App Service via GitHub Actions CI/CD.

## Repository Structure

```
├── app.py                  # Entire application (single-file monolith, ~1070 lines)
├── requirements.txt        # Python dependencies (pip)
├── Dockerfile              # Production container (Python 3.12-slim, port 8000)
├── .github/workflows/
│   └── main_python-sched-analytics.yml  # CI/CD: build + deploy to Azure
├── docs/
│   └── cybereum-multiresolution-guidance.md  # Multi-resolution community detection spec
└── README.md
```

All application logic lives in `app.py`. There are no separate modules, tests, or package structure.

## Tech Stack

- **Python 3.12** with Flask 3.0.0 + Flask-CORS
- **Graph processing:** NetworkX 3.2.1 (primary), NetworkKit 11.0 (C++ accelerated, optional)
- **Scientific computing:** NumPy, SciPy, Pandas, scikit-learn
- **Caching:** Redis (optional) + in-memory LRU
- **Production server:** Gunicorn

## Common Commands

```bash
# Install dependencies
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Run locally (debug mode, port 5000)
python app.py

# Run production-style
gunicorn --workers 2 --threads 2 --bind 0.0.0.0:8000 --timeout 120 app:app

# Docker build and run
docker build -t pyth-sched-analytics .
docker run -p 8000:8000 pyth-sched-analytics
```

**No test suite or linter is configured.** The CI/CD workflow has a placeholder comment for tests but does not run any.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/graph-metrics` | Main analysis endpoint — accepts `{nodes, links}` JSON, returns enriched analytics |
| GET | `/health` | Health check with cache stats, feature flags, config |
| GET | `/test-cors` | CORS verification |
| GET | `/` | Status check (`{"status": "ok"}`) |

## Architecture & Key Patterns

### Single-file layout
`app.py` is organized into sections by comment headers:
1. **Configuration** — environment variables and constants
2. **Caching** — Redis + LRU dual-layer cache helpers
3. **Graph building** — `build_graph()` constructs NetworkX DiGraph from input
4. **Analytics** — centrality, community detection, clustering, critical path, pattern detection
5. **Response builders** — `build_node_attributes()`, `define_work_packages()`
6. **Routes** — Flask route handlers

### Performance acceleration
- NetworkKit is used for graphs above threshold sizes (100+ nodes for centrality, 50+ for communities, 2000+ for large-graph algorithms)
- Falls back gracefully to NetworkX if NetworkKit is unavailable
- Sparse matrices (scipy.sparse) for adjacency representations
- Explicit `gc.collect()` for graphs >5000 nodes
- Categorical dtypes in Pandas for pattern detection memory efficiency

### Caching strategy
- **Level 1:** Redis (if `REDIS_URL` is set), keyed by SHA256 of input JSON, TTL 3600s
- **Level 2:** `functools.lru_cache` (32 entries) for repeated computations
- Cache metrics exposed via `/health`

### Environment variables
| Variable | Default | Purpose |
|----------|---------|---------|
| `SMALL_GRAPH_THRESHOLD` | 2000 | Node count threshold for algorithm switching |
| `MAX_PATTERN_NODES` | 1000 | Sample limit for pattern detection |
| `MAX_PATTERNS` | 10 | Max repeating patterns returned |
| `CACHE_SIZE` | 32 | LRU cache entries |
| `REQUEST_TIMEOUT` | 120 | Gunicorn timeout (seconds) |
| `DEBUG` | false | Enable debug logging |
| `ENABLE_SILHOUETTE_OPTIMIZATION` | false | K-means cluster count optimization |
| `COMMUNITY_RESOLUTION` | 1.0 | Louvain resolution parameter |
| `REDIS_URL` | None | Redis connection string |
| `REDIS_CACHE_TTL` | 3600 | Redis cache TTL (seconds) |
| `PORT` | 8000 | Server port |
| `WEB_CONCURRENCY` | 2 | Gunicorn worker count |

## Development Conventions

- **No tests exist.** Changes should be manually verified against the `/graph-metrics` endpoint with sample data.
- **Single-file architecture.** All changes go in `app.py`. Do not split into separate modules without explicit direction.
- **Defensive fallbacks.** Always provide a fallback path (e.g., NetworkKit → NetworkX, Redis → in-memory). Never let an optional dependency failure crash the service.
- **Vectorized operations.** Prefer NumPy/Pandas vectorized operations over Python loops for data processing.
- **Main branch is `main`** (remote). Local default branch is `master`.

## Deployment

CI/CD runs on push to `main` via GitHub Actions:
1. Sets up Python 3.12 with pip caching
2. Creates venv, installs dependencies
3. Zips the release artifact
4. Deploys to Azure Web App using OIDC authentication

The Dockerfile uses `python:3.12-slim`, installs C++ build tools (for NetworkKit compilation), and runs Gunicorn on port 8000 with a health check at `/health`.
