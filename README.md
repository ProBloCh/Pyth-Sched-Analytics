# Pyth-Sched-Analytics

## Guidance
- [Cybereum multi-resolution community detection guidance (review)](docs/cybereum-multiresolution-guidance.md)


## API contract hardening
- `POST /graph-metrics` now validates the request contract before analysis:
  - `nodes` and `links` must be arrays.
  - Node IDs must be unique.
  - Each link must include `source`/`target` and reference known node IDs.
  - Payload guardrails are enforced via `MAX_NODES` and `MAX_LINKS`.
- Responses now include `contract_version`, `graph_stats`, and `computation_ms` for stronger downstream integration guarantees.

- Cache serialization now uses JSON instead of Python pickle to reduce deserialization risk in shared infrastructure deployments.
- Request body size guardrail can be configured via `MAX_REQUEST_BYTES` (returns HTTP `413` when exceeded).

- Clustering/PCA now short-circuit on degenerate identical-point feature sets, reducing convergence/runtime warnings and avoiding unnecessary compute on low-information payloads.
