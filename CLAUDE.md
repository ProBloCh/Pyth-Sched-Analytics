# CLAUDE.md — Pyth-Sched-Analytics

## Project Overview

Flask-based API for analyzing schedule dependency networks in capital project
management. Detects community structures, critical paths, repeating patterns,
and work packages from activity graphs. Deployed to Azure via GitHub Actions.

**Tech stack:** Python 3.12, Flask, NetworkX + NetworkKit (C++ acceleration),
NumPy, Pandas, scikit-learn, SciPy, Redis (optional caching).

**Architecture:** Single-file backend (`app.py`, ~1,070 LOC, 28 functions).
One main endpoint (`POST /graph-metrics`) receives nodes + links JSON and
returns structural analysis results.

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

Touch only what you must. This is critical — the codebase is a single file
with no test suite to catch collateral damage.

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

**Note:** This project currently has no automated tests. Verification means
running the app and checking endpoint responses, reviewing outputs for
correctness, or adding tests when the scope warrants it. The CI pipeline has
a placeholder for tests — prefer filling that gap over working without a
safety net.

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

### Single-File Architecture

All backend logic lives in `app.py`. Read and understand the relevant
functions before editing — changes to imports, module-level state, or shared
helpers affect the entire file. When the scope of work calls for a new module
(e.g., the multi-resolution pipeline), create a separate file as recommended
in `docs/cybereum-multiresolution-guidance.md`.

### Multi-Resolution Pipeline

The guidance doc (`docs/cybereum-multiresolution-guidance.md`) describes a
planned multi-resolution community detection pipeline. This is a design
document — it is **not implemented** in the current codebase. The current code
runs single-resolution Louvain at `gamma=1.0` only. Do not confuse planned
design with current state.

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

Response dicts are serialized with `pickle` into Redis (or LRU in-memory).
Changing the structure of values returned by analytical functions can make
cached entries incompatible — callers may get stale or malformed data until
the cache expires or is flushed.

The `POST /graph-metrics` response is consumed by a frontend
(`CommunityGroups.js`). Renaming or removing response keys is a breaking
change. Add new keys freely; modify or remove existing keys only with
explicit intent to change the API contract.

### Deployment

Pushes to `main` trigger automatic deployment to Azure production. Treat
`main` accordingly — no experimental changes, no untested algorithm rewrites.

## Tradeoff Note

These guidelines bias toward caution over speed. For trivial tasks (typo fixes,
obvious one-liners), use judgment — not every change needs the full rigor. The
goal is reducing costly mistakes on non-trivial work.
