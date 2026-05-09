# Library Pulls for the Priority Roadmap Items

For each priority item from `docs/exceed-alice-roadmap.md`, this doc names
the **trusted library primitive** to use directly.  Don't roll your own;
don't wrap; don't write helper functions for things `numpy` / `scipy` /
`pandas` already provide.

Sources are pinned to the library version in `requirements.txt` unless
otherwise noted.  Every entry below has been verified against the
current scipy/numpy/pandas reference docs at the time of writing.

---

## D4 — Calendar-Aware CPM

| Need | Pull |
|---|---|
| Working-hour advance (already implemented) | `completion/calendar.py::advance_working_ms` -- our custom code matching the JS `Reference/Completionprediction.js` (line 381).  Don't swap to pandas `CustomBusinessHour`; it would break the JS-vs-Py diff harness in `tests/test_paths_diff.py`. |
| Working-hour retreat (D4 needs this for the backward CPM pass) | Extend `completion/calendar.py` with the inverse of `advance_working_ms`.  Symmetric searchsorted on the same `work_hours_before` array; ~30 LOC.  Don't pull from a third party -- staying consistent with `advance_working_ms` is the whole point. |
| ISO-date arithmetic in CPM forward/backward pass | `numpy.searchsorted` -- already used in `WorkingCalendar`.  No new code. |

## E1 — Logsumexp Smoothing of `resource_objective`

| Need | Pull |
|---|---|
| Numerically-stable softplus | `numpy.logaddexp(0, β*x) / β` -- canonical, no wrapper needed |
| Sigmoid (gradient) | `scipy.special.expit(β*x)` -- canonical, no wrapper needed |

Reference E1 substitution: see `docs/research/sketches/e1_logsumexp_resource.py`.
The "implementation" of E1 is a one-line composition of these two primitives.

## D5A — Pool Analytics

| Need | Pull |
|---|---|
| Pool grouping | `interface/analytics.py::compute_interface_analytics(grouping_field="Resources")` -- already grouping-field agnostic (lines 160-207) |
| Cruciality (Spearman ρ of pool-aggregate duration vs makespan) | `scipy.stats.spearmanr(pool_total_per_sample, makespan_per_sample)` -- direct call, no wrapper |
| Per-sample pool aggregation in MC | `numpy.add.at(pool_totals[:, sample_idx], pool_indices, sample_durations)` -- one line, vectorised |
| Top-N hotspot ranking | Already done by `interface/analytics.py::_compute_hotspots` -- reuse |

## D7.1 — Stochastic Earned Schedule (Lipke ES per MC sample)

| Need | Pull |
|---|---|
| Linear interpolation between Start/Finish boundary samples | `numpy.interp(at_target, sorted_pv_times, sorted_pv_values)` -- canonical, vectorised |
| Per-sample loop over MC ensemble | Existing `evm/metrics.py::compute_earned_schedule` already does the deterministic intersection.  Wrap in a loop over MC samples; ~30 LOC. |

## D9.2 — Salience-Anchored Recovery

| Need | Pull |
|---|---|
| Recurring corridors anchored on configurable salience | `paths/subpath_patterns.py::find_recurring_subpaths(salience_field=...)` -- already configurable.  Lift into `completion/recovery.py`. |
| Per-activity tail contribution (anchor field for dragon-king-aware variant) | `numpy.percentile(samples, [50, 95], axis=0)` then differences -- canonical |

## D3.1 — Multi-start L-BFGS-B (Sobol-Seeded)

| Need | Pull |
|---|---|
| Low-discrepancy starting points | `scipy.stats.qmc.Sobol` -- already used by `solver/stochastic.py::_generate_samples`; reuse, don't re-instantiate |
| L-BFGS-B inner solve | `scipy.optimize.minimize(method="L-BFGS-B")` -- already used by `solver/optimizer.py:172` |
| Parallel inner solves | `concurrent.futures.ThreadPoolExecutor` (stdlib) -- L-BFGS-B releases the GIL via scipy's BLAS calls |
| Pareto skyline filter (top-K non-dominated from K starts) | `paretoset` PyPI package (BSD, ~500 LOC, well-tested).  Add to `requirements.txt` only if D3.1 is picked up.  Alternative: `pymoo.util.dominator.fast_non_dominated_sort` -- but pymoo is heavier (~10 MB), use only if D3.2 (NSGA-II) is also planned. |

## E3 — KKT-Residual Check in Adjoint Validation

| Need | Pull |
|---|---|
| L-BFGS-B termination state (gradient at the optimum) | The `result.jac` field returned by `scipy.optimize.minimize(...)` -- already available in `solver/optimizer.py:182`; just expose it in the response under `kkt_residual` |

No new dep; the residual is already computed as a side effect of the existing solver call.

## E4 — Augmented Lagrangian for Hard Constraints

| Need | Pull |
|---|---|
| Augmented-Lagrangian outer loop | `scipy.optimize.minimize(method="trust-constr")` with `NonlinearConstraint` -- scipy's implementation (used by `RW-§6.3.2`).  Don't write the dual-variable update loop ourselves; scipy's `trust-constr` does it. |

If the team specifically wants a separate augmented-Lagrangian outer loop with L-BFGS-B inner (per the textbook formulation), the cleanest existing implementation is `nlopt` (`pip install nlopt`, `nlopt.LD_AUGLAG`).  But trust-constr is the smaller dep change.

## E5 — Subset Simulation for P95+ Tails

| Need | Pull |
|---|---|
| Subset-simulation chain (Au & Beck 2001) | `UQpy.SubsetSimulation` (`pip install UQpy`) -- tested implementation by the original Au-Beck research group's collaborators.  Don't port from the Matlab reference; the Python port exists. |
| Conditional-event sampling between levels | Provided by `UQpy.SubsetSimulation` directly |

If `UQpy` is too heavy, the lighter alternative is to write the chain ourselves -- ~200 LOC -- but only if there's a deployment-image-size objection.

## R1 — Generalized Pareto Distribution at the Tail (Research-Gated)

| Need | Pull |
|---|---|
| GPD PPF / fitting | `scipy.stats.genpareto` -- canonical implementation; ξ, σ, threshold u parameters all native |
| Threshold selection diagnostics (Hill plot, mean residual life) | `scipy.stats.genpareto` doesn't include these; pull `pyextremes` (`pip install pyextremes`) for the diagnostics layer |

## R2 — Vine Copulas (Research-Gated)

| Need | Pull |
|---|---|
| Vine copula construction + sampling | `pyvinecopulib` -- C++-backed Python bindings, BSD-licensed.  Maintained by Aas/Czado-affiliated research group. |

## R4 — SVGD for Posterior Approximation (Research-Gated)

| Need | Pull |
|---|---|
| Stein Variational Gradient Descent | `numpyro.infer.SVGD` -- the JAX-backed implementation in NumPyro is the canonical Python port.  Drop-in for D8.2 once `RW-§1.1` lands. |

Pulling NumPyro is heavy (~70 MB with JAX).  If we need a lighter footprint, write SVGD from scratch -- it's ~80 LOC -- but only after R4 is committed.

---

## Validation: hand-rolled vs library

The 5-tier risk model in `solver/stochastic.py` hand-rolls four PPFs
(`_triangular_ppf`, `_bs_ppf`, `_pareto_ppf`, `_lognormal_ppf`) for
hot-path vectorisation.  These should be cross-checked against the
canonical scipy implementations:

| Hand-rolled | Canonical scipy |
|---|---|
| `_triangular_ppf` | `scipy.stats.triang.ppf` |
| `_bs_ppf` | `scipy.stats.fatiguelife.ppf` |
| `_pareto_ppf` | `scipy.stats.pareto.ppf` |
| `_lognormal_ppf` | `scipy.stats.lognorm.ppf` |

Validation harness: `docs/research/sketches/validate_5tier_distributions.py`.
Fails loudly (assertion) if any hand-rolled function deviates from the
scipy canonical form by more than 1e-10 relative tolerance across
5,000 probe points.  Run before any change to `solver/stochastic.py`.

---

## What this doc deliberately does NOT add

Each entry above either uses a primitive **already in `requirements.txt`**
or notes a single PyPI dep that's pulled **only when the relevant roadmap
item is committed**.  No speculative dependencies, no wrapper packages,
no helper utilities for things scipy/numpy already provide.
