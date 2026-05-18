# Typing progress

`pyright` runs on every push as a non-blocking CI job
(`continue-on-error: true`).  Configuration lives in `pyrightconfig.json`.
Project-wide mode is `basic`; individual modules may opt in to
**strict** mode by adding their path to the `strict` array in
`pyrightconfig.json`.

This document tracks which modules are strict-clean.  When a module
joins the strict list, add a row here with the PR that promoted it.

## Rules

* **Never blanket-disable a file.**  When a third-party stub is
  missing, annotate the specific line:
  `# pyright: ignore[reportMissingTypeStubs]` with a one-line reason.
* **Adding a strict-clean module** is its own PR.  CI must show zero
  pyright errors before the path is added to `pyrightconfig.json`.
* **Demoting a module** (removing it from the `strict` array) requires
  an explicit justification in the PR description; treat it like
  lowering the coverage threshold.

## Strict-clean modules

| Module | Promoted in | Notes |
|---|---|---|
| `auth.py` | PR-8 | New in PR-1; written strict-clean from day one. |
| `_cache_version.py` | PR-8 | New in PR-2; one-symbol module, trivially strict-clean. |

## Basic-mode error budget

PR-8 baseline: **239 errors** in 14 files.  This is the working
target — every PR should leave the count equal or lower.  Reductions
land as their own focused PRs (e.g. "annotate `solver/routes.py`
return types"); do not bundle typing fixes with feature work.

| File | Errors at PR-8 baseline |
|---|---|
| `app.py` | 59 |
| `paths/routes.py` | 45 |
| `interface/analytics.py` | 44 |
| `solver/routes.py` | 30 |
| `completion/routes.py` | 27 |
| `solver/models.py` | 9 |
| `evm/routes.py` | 9 |
| `interface/routes.py` | 8 |
| `paths/subpath_patterns.py` | 7 |
| `completion/monte_carlo.py` | 6 |
| `completion/outcomes.py` | 4 |
| `multi_resolution_pipeline.py` | 3 |
| `evm/distributions.py`, `evm/metrics.py` | 2 each |
