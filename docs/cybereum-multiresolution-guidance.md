# Cybereum Multi-Resolution Community Detection Guidance (Review)

## Purpose and intent
The guidance describes a shift from a single-pass Louvain run (default `γ=1.0`) to a multi-resolution pipeline that produces a structural hierarchy from the schedule dependency network. The goal is to distinguish **structural coupling** from administrative WBS groupings, yielding a hierarchy that maps to macro systems → systems → sub-systems → work fronts. This hierarchy is intended to be consumed by the `CommunityGroups.js` frontend as a nested JSON structure.

## Key design points to carry into implementation
- **Resolution ladder (coarse → fine)** tuned to capital project structure, not linear increments. Example tiers:
  - `γ=0.3`: macro systems (5–10 groups)
  - `γ=1.0`: systems (~25–40 groups)
  - `γ=2.5`: work packages (100–200 groups)
  - `γ=4.0`: work fronts (crew-level clusters)
- **Adaptive ladder** based on schedule size:
  - For small schedules (<500 activities), skip the finest levels.
  - For very large schedules (>20K activities), add an ultra-coarse level (`γ=0.1`).
- **Stability analysis** via NMI across multiple Louvain runs at each resolution to detect stochastic variance and select the best partition.
- **Hierarchy construction** using containment (overlap threshold ~70%) between adjacent tiers to create a nested tree for the frontend “zoom” UX.
- **Graph construction** should capture coupling strength with weighted edges using relationship type and lag decay; the graph is undirected for Louvain.
- **Metrics** to compute per group at each resolution include internal density, boundary edges, gateway/bridge score, and critical-path concentration, plus meta-network centrality metrics.

## Expected outputs
- **Hierarchical JSON** containing:
  - `graph_stats`
  - `levels` (tiers, modularity, stability, group membership + metrics)
  - `hierarchy` (containment mapping + roots)
  - `stable_cores` (activity sets that stay together across all tiers)

## Integration implications for this repository
- The repository should incorporate a Python pipeline module that:
  - Builds a weighted undirected NetworkX graph from schedule links.
  - Runs Louvain across the resolution ladder with stability checks.
  - Produces a hierarchical JSON contract for the frontend.
- The UI/consumer should treat `γ=1.0` as the primary view, while enabling drill-down/up to other tiers.
- Any data export or API surface should include `computation_ms` and `graph_stats` to support diagnostics and profiling.

## Notes for future implementation
- Prefer a dedicated pipeline module (e.g., `multi_resolution_pipeline.py`) to keep the implementation cohesive and testable.
- Consider surfacing configuration overrides through API request payloads to support per-project tuning.
