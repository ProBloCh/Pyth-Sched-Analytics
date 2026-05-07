# Paths Endpoint

Path enumeration and pattern mining over the schedule DAG: critical /
near-critical path corpus extraction, driving-graph chains, distance
metrics, calendar-aware slack, and recurring-subpath ("key work glue")
mining.

Served by the `paths/` Flask Blueprint (prefix `/paths`).  Ports the
deterministic Tier 1 algorithms from `Reference/PathScripts.js` to
NumPy.  The Tier 2 / 3 algorithms (risk-adjustment math, overrun-
probability semantics, calendar resolution, visualization) remain
client-side and have no server analog by design.

**Consumers:**
- JS frontend `Cybereum/Scripts/PathPatterns.js` (Recurring Corridors
  card on `Pathdistribution.cshtml`) calls `/paths/recurring-subpaths`.
- Other `/paths/*` endpoints are shipped but currently unwired by
  C# / JS callers (see `CLAUDE.md` integration table for the
  per-endpoint status row).

---

## POST /paths/recurring-subpaths

Mines contiguous subpaths that recur across the critical / near-
critical path corpus, anchored at structural junctions (high
betweenness / degree fan) or salient activities (high risk /
importance / overrun-probability).  Returns a ranked list of
candidate "key work glues" -- corridors a large fraction of viable
schedules must traverse and that carry operational consequence.

### Request

```jsonc
{
  "nodes": [
    {
      "ID": "1",                // Required.  Unique node ID (string or
                                //   number; coerced to string).  Lowercase
                                //   "id" alias is accepted and normalised
                                //   to "ID" for cache-key parity.
      "Name": "Foundation",     // Optional.  Cosmetic.
      "Duration": 10,           // Optional.
      "Betweenness": 0.42,      // Optional.  Centrality fields read by
      "InDegree": 3,            //   the mining engine for anchor scoring.
      "OutDegree": 2,           //   Names match the C# projection on
      "RiskScore": 0.7,         //   ProjectActivity (case-insensitive
      "ImportanceScore": 0.55,  //   match -- snake_case and PascalCase
      "Overrun_Probability": 0.3//   both work).
    }
  ],
  "links": [
    { "source": "0", "target": "1",
      "type": "FS", "lag": 0 }
  ],

  // EITHER pre-computed corpus OR enumeration parameters, not both.

  "paths": [                    // Optional.  Pre-computed corpus.
    ["0", "1", "2", "..."]      //   Each entry must be a list of >=2
  ],                            //   known node IDs forming a valid hop
                                //   chain in the post-cycle-break DAG.

  // The fields below apply only when "paths" is omitted -- the engine
  // calls find_all_paths() to build the corpus.
  "start_id":  "0",             // Optional.  Defaults to schedule
                                //   envelope start (ID '0') per
                                //   CLAUDE.md convention.
  "end_id":    "999",           // Optional.  Defaults to max-numeric ID.
  "max_paths": 10000,           // Optional.  Caps enumeration.  Bounds
                                //   [1, MAX_PATHS_TO_RETURN].
  "branch_balanced": false,     // Optional.  Default false.  When true,
                                //   forwards to find_all_paths so the
                                //   BranchBalancedQueue down-ranks
                                //   over-represented branches on large
                                //   DAGs.  Default false keeps support
                                //   counts unbiased for mining.

  "config": {                   // Optional.  SubpathConfig overrides.
    "Lmin": 3,                  //   Min subpath length.  Bounds [2, MAX_NODES].
    "Lmax": null,               //   Max subpath length.  Bounds [2, MAX_NODES]
                                //     or null => derive from median(|P|)/2.
    "anchor_z_threshold": 2.0,  //   z-score threshold for anchor flag.
                                //     Bounds [0.0, 10.0].
    "top_k": 10,                //   Top-K candidates to return.  Bounds
                                //     [1, 200].
    "include_components": true, //   Include per-component score breakdown.
    "max_anchor_pairs": 5000,   //   Defensive cap on candidate pairs.
                                //     Bounds [1, 200000].
    "fallback_min_anchors": 2,  //   Fallback fires below this anchor count.
                                //     Bounds [0, 1000].
    "fallback_salience_threshold": 1.0,  // z-score gate for fallback
                                //     window mean.  Bounds [-10.0, 10.0].
    "strip_envelope": true      //   Drop each path's own first/last node
                                //     before mining.  Off if you've
                                //     already stripped envelope nodes.
  }
}
```

### Response (200)

```jsonc
{
  "subpaths": [
    {
      "node_ids": ["12", "27", "33"],     // Subpath as ordered node IDs.
      "score": 1.42,                      // supp + junc + sal - maxpen.
      "support_count": 17,                // Distinct paths in the corpus
                                          //   that contain this subpath.
      "corpus_size": 40,                  // Total corpus size for context.
      "endpoint_anchors": {               // Why each endpoint qualified
        "v1": ["betweenness"],            //   as an anchor.  Reasons are
        "vL": ["risk", "out_degree"]      //   the metric names that
      },                                  //   crossed the z-threshold.
      "sample_paths": [3, 7, 12],         // Indices into the corpus
                                          //   (subset of paths containing
                                          //   the subpath).
      "components": {                     // Present when
        "supp": 0.42,                     //   include_components=true.
        "junc": 0.91,                     //   Per-component scores in
        "sal":  0.55,                     //   [0,1].  Equal-weight sum
        "maxpen": 0.10                    //   produces "score" above.
      }
    }
  ],
  "corpus_size":   40,
  "anchor_count":  14,
  "fallback_used": false,                 // True when the salience-window
                                          //   fallback fired (anchor count
                                          //   below threshold OR all
                                          //   anchors split across paths).
  "truncated":     false,                 // Sampling indicator.  True when
                                          //   ANY of:
                                          //     - mining-side
                                          //       max_anchor_pairs hit
                                          //     - per-path anchor
                                          //       downsample fired
                                          //     - fallback clamped Lmax
                                          //       to its internal cap
                                          //     - find_all_paths reported
                                          //       corpus_truncated
                                          //   When true, support counts /
                                          //   rankings are sampling-
                                          //   dependent and should not be
                                          //   compared as-is to other
                                          //   runs over the same DAG.
  "config_resolved": {                    // Effective config after merge
    "Lmin": 3, "Lmax": 12, "...": "..."   //   + clamps + derived defaults.
  },
  "cache_hit":     false                  // True when the response came
                                          //   from Redis (request
                                          //   fingerprint match).
}
```

### Errors

| Status | Trigger |
|---|---|
| 400 | Malformed JSON, missing nodes/links, unknown ID in `paths`, invalid hop in `paths`, invalid `Lmin` / `Lmax` / `top_k` / `max_paths` / `branch_balanced` (bool/float types are rejected explicitly before integer coercion), `paths[i]` shorter than 2 nodes |
| 413 | Payload exceeds 10 MB |
| 500 | DAG build failure (cycle break can't resolve) or unexpected internal error |

### Algorithm

1. **Strip corpus boundaries** (default `strip_envelope=true`) -- each
   path's *own* first and last node are dropped.  This handles
   schedule-envelope corpora (`'0'` / max-numeric per CLAUDE.md), user-
   selected subgraph scopes (custom `start_id`/`end_id`), and
   pre-computed corpora with mixed boundaries.  Disable when the
   caller has already stripped envelope nodes and wants every node to
   participate in scoring.
2. **Median + MAD z-scores** per node for betweenness, in-degree,
   out-degree, risk, importance, overrun-probability.  Falls back to
   mean+stdev when MAD degenerates to zero (>=half values tied) -- MAD
   has a 50% breakdown point and tied baselines are common on small
   schedules.
3. **Anchor identification** -- a node is flagged when any of its
   metric z-scores meets `anchor_z_threshold`.  The set of metrics
   that crossed is captured per node and surfaced on
   `endpoint_anchors`.  `anchor_z_threshold=0` triggers a presence
   guard so nodes missing all metric fields don't accidentally
   qualify.
4. **Anchor-pair extraction** -- for each path, emit every contiguous
   slice `(v_1..v_L)` where both endpoints are anchors and
   `Lmin <= L <= Lmax`.  Per-path anchor cap predicted from a
   triangular bound to keep work bounded on dense corpora.
5. **Scoring** -- each component in `[0, 1]`, equal weights:
   - `supp`: path-support fraction (distinct paths containing the
     subpath / corpus size)
   - `junc`: endpoint structural strength (asymmetric:
     in-deg / betweenness at `v_1`; out-deg / betweenness at `v_L`)
   - `sal`: mean over **every node in the candidate (both endpoints
     plus any interior)** of
     `sigma((z_risk + z_imp + z_overrun) / 3)`.  This is `mean(sigma(z))`,
     deliberately not `sigma(mean(z))` -- per-node clamping bounds each
     contribution individually so a single extreme outlier doesn't
     dominate, and a single negative-z node can't pull the pre-clamp
     mean below zero before the clamp.
   - `maxpen`: fraction of *containing paths* whose extension is the
     same neighbour -- penalises trivially non-maximal cuts
6. **Top-K** by `score`, with `support_count` as tie-breaker.
7. **Fallback** fires when fewer than `fallback_min_anchors` exist OR
   anchor-pair extraction yields zero candidates: emit the longest
   contiguous slice per path whose mean salience z exceeds
   `fallback_salience_threshold`.  `Lmax` is internally clamped in
   this branch (a 20K-node request with no anchors otherwise scans
   every window length); when this fires `truncated=true` and the
   resolved `Lmax` is reported in `config_resolved`.

### Caching

Redis-backed per-request fingerprint cache.  Cache key normalises:
- `id` -> `ID` (lowercase alias)
- numeric IDs -> string (so `1` and `"1"` hash the same)
- start_id / end_id of `enumerate_kwargs` -> string

Equivalent payloads share an entry; `cache_hit=true` short-circuits
mining and returns the stored result with a fresh `cache_hit` flag.

### Scope notes

- **Diversity selectors are bypassed.**  The diversity / independence
  filters in `paths/diversity.py` would prune the corpus before
  mining, biasing support counts.  This endpoint always mines from
  the raw enumeration output (or a caller-supplied raw corpus).
- **Frontend does not pre-pass paths.**  `PathScripts.findAllPaths`
  returns a structurally-diverse selection on large schedules, not
  the raw corpus the support metric is defined over.  The Recurring
  Corridors button on `Pathdistribution.cshtml` lets the backend
  re-enumerate from raw nodes/links so the cache delivers warm calls
  fast.
- **Equal weights, not tuned weights.**  Per-component scores are in
  the response so callers can re-rank against their own weights.
  Calibration belongs in a follow-up that registers labelled
  outcomes via the `/completion/register-outcome` pattern.

Implemented in `paths/subpath_patterns.py`; route in
`paths/routes.py:recurring_subpaths`.

---

## Other `/paths/*` endpoints

The blueprint also exposes `/paths/enumerate`, `/paths/driving-graph`,
`/paths/distances`, and `/paths/calendar-slack`.  These are part of
the Tier 1 PathScripts.js port and are documented in the route
docstrings; full schemas pending integration on the .NET side.  See
`paths/routes.py` for current contracts.
