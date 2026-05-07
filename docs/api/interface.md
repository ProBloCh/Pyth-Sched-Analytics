# Interface Endpoint

Boundary-crossing interface intelligence: per-group hotspots,
cross-group dependency matrix, top-N highest-risk activities for
recovery-board grounding.

Served by the `interface/` Flask Blueprint (prefix `/interface`).
Source-agnostic engine -- consumes Cybereum-native `{nodes, links}`
payloads regardless of origin (P6 XER, MSP XML, native authoring).
The engine only requires that nodes carry the chosen grouping field.

**Why a separate Blueprint:** `/graph-metrics` already covers
centrality, communities, DCMA `schedule_health`, and risk propagation.
`/interface/analytics` is purely about boundary-crossing statistics for
whatever grouping the caller chooses.  Run both for a full picture --
they're complementary lenses, not competitors.

**Consumers:**
- JS frontend `Cybereum/Scripts/InterfaceHotspots.js` POSTs to
  `/interface/analytics` directly via
  `window.CybereumInterface.{fetchAnalytics, generateRecoveryBoard,
  fetchAndExplain}`.
- C# `OpenAIController.GenerateInterfaceRecoveryBoard` consumes the
  output and runs an LLM prompt to produce a decision-grade markdown
  recovery board.

---

## POST /interface/analytics

Compute hotspots, cross-group matrix, summary, warnings, and top-sample
activities.

### Request

```jsonc
{
  "nodes": [
    {
      "ID": "1",                    // Required.  Unique node ID
                                    //   (string or number; coerced to
                                    //   string).  Lowercase "id" alias
                                    //   is accepted.
      "Name": "Foundation",         // Optional.  Cosmetic.
      "Code": "F-001",              // Optional.
      "WBS_Path": "Plant / Mech",   // Required when grouping_field is
                                    //   omitted (or matches the
                                    //   fallback chain).  Pick any
                                    //   field that buckets activities
                                    //   meaningfully.
      "Contract": "C-12",           // Optional alternate grouping.
      "Phase": "Construction",      // Optional alternate grouping.
      "Asset": "Pump-A",            // Optional alternate grouping.
      "Discipline": "Mechanical",   // Optional alternate grouping.
      "risk_score": 0.7,            // Optional.  Drives the hotspot
                                    //   composite score's risk
                                    //   component.  Aliases: RiskScore,
                                    //   Risk_Score.
      "total_float": 0,             // Optional.  Used for top-sample
                                    //   tie-breaking.  Aliases:
                                    //   total_float_days, Slack, Float.
      "Milestone": 0                // Optional.  Accepts 0/1 strings,
                                    //   ints, booleans.
    }
  ],
  "links": [
    { "source": "1", "target": "2",
      "type": "FS", "lag": 0 }      // FS/SS/FF/SF + lag accepted but
                                    //   not required for boundary
                                    //   counting.
  ],
  "grouping_field": "WBS_Path",     // Optional.  When omitted, the
                                    //   engine walks a fallback chain
                                    //   WBS_Path -> WBS_Name -> WBS ->
                                    //   WBS_ID and picks the first
                                    //   populated field.  Any node
                                    //   attribute is accepted; vary it
                                    //   to ask different questions
                                    //   (Contract, Phase, Asset,
                                    //   Discipline, Location, ...).
  "weights": {                      // Optional.  Override the
                                    //   composite-score weights.  All
                                    //   default to the values from the
                                    //   original P6 review code.
    "w_incoming":      0.35,
    "w_distinct_pred": 0.20,
    "w_outgoing":      0.25,
    "w_distinct_succ": 0.10,
    "w_risk":          0.10
  },
  "max_hotspots": 100,              // Optional.  Cap on returned
                                    //   hotspot rows (after sort).
                                    //   Bounds [1, 5000].
  "top_samples_per_hotspot": 5      // Optional.  Per-hotspot example-
                                    //   activity count (incoming +
                                    //   outgoing).  Bounds [0, 50].
                                    //   0 returns empty lists with
                                    //   stable shape.
}
```

### Response (200)

```jsonc
{
  "summary": {
    "grouping_field":             "WBS_Path",
    "populated_node_count":       42,    // Nodes carrying the
                                         //   resolved grouping field.
    "total_nodes":                42,
    "total_groups":               5,     // Distinct grouping values.
    "total_links":                73,
    "cross_group_links":          12,    // Links whose endpoints fall
                                         //   in different buckets.
    "cross_group_ratio":          0.16,
    "groups_with_incoming_cross": 3,
    "groups_with_outgoing_cross": 4
  },
  "hotspots": [
    {
      "group":                    "Plant / Elec",
      "incoming_cross_group":     7,     // Cross-boundary links INTO
                                         //   this group.
      "distinct_pred_groups":     3,     // Distinct upstream groups.
      "outgoing_cross_group":     2,     // Cross-boundary links OUT
                                         //   of this group.
      "distinct_succ_groups":     1,     // Distinct downstream groups.
      "min_float_days":           0,
      "avg_float_days":           1.4,
      "max_risk":                 0.9,
      "avg_risk":                 0.55,
      "max_downstream_risk":      0.7,
      "avg_downstream_risk":      0.4,
      "interface_hotspot_score":  87.4,  // 0-100 composite.  See
                                         //   "Algorithm" below for
                                         //   the formula.
      "top_incoming": [                  // Top-N activities receiving
        {                                //   cross-boundary handoffs,
          "ID":           "E1",          //   ranked by risk_score desc,
          "Name":         "Elec 1",      //   ties broken by lowest
          "Code":         "",            //   total_float, then by Name.
          "group":        "Plant / Elec",
          "total_float":  2.0,
          "risk_score":   0.7
        }
      ],
      "top_outgoing": [...]              // Top-N activities sourcing
                                         //   cross-boundary handoffs,
                                         //   ranked the same way.
    }
  ],
  "matrix": [
    {
      "pred_group":              "Plant / Mech",
      "succ_group":              "Plant / Elec",
      "rel_count":               4,      // Cross-boundary link count.
      "min_succ_float_days":     0,
      "max_succ_risk":           0.9
    }
  ],
  "warnings": [
    "grouping_field auto-selected as 'WBS_Name' (populated on 38/42 nodes)"
  ],
  "cache_hit": false                     // True when the response came
                                         //   from Redis.
}
```

### Errors

| Status | Trigger |
|---|---|
| 400 | Malformed JSON; `nodes` empty or not a list; `links` not a list; node missing ID; duplicate node ID; `weights` not an object; `weights.w_*` non-numeric / negative / NaN / Inf; `grouping_field` not a string; `max_hotspots` out of bounds; `top_samples_per_hotspot` out of bounds |
| 413 | Payload exceeds 10 MB |
| 500 | Unexpected internal error |

### Algorithm

1. **Resolve grouping field.** Honour the caller's `grouping_field`
   when supplied (warn if no node carries it).  Otherwise walk the
   fallback chain `WBS_Path -> WBS_Name -> WBS -> WBS_ID` and pick the
   first field with at least one populated value.
2. **Build node + link frames** keyed by string ID.  Coerce mixed
   ID types to strings (P6 emits numeric strings; MSP can emit
   non-numeric).  Drop links whose endpoints aren't in `nodes`.
3. **Mark cross-boundary links** -- a link is cross-boundary when its
   source and target groups differ.  Self-loops are kept but flagged
   not-cross-group.
4. **Per-group aggregation.** Incoming side groups by successor end;
   outgoing side groups by predecessor end.  Risk + float metrics
   joined from the successor (the activity bearing the consequence).
5. **Composite hotspot score** in `[0, 100]`:
   ```
   score = 100 * (
       w_incoming      * norm(incoming_cross_group)
     + w_distinct_pred * norm(distinct_pred_groups)
     + w_outgoing      * norm(outgoing_cross_group)
     + w_distinct_succ * norm(distinct_succ_groups)
     + w_risk          * norm(max(max_risk, max_downstream_risk))
   )
   ```
   `norm` is min-max over the set of groups; constant or empty
   series score zero (single-bucket schedules report no hotspots
   rather than crash).
6. **Sort** by `interface_hotspot_score` descending (stable), then
   apply `max_hotspots` if set.
7. **Top-N samples** per hotspot, both directions: rank by
   `risk_score` desc, ties by lowest `total_float`, then by Name.

### Design boundaries

- **No re-implementation of `/graph-metrics`.** Centrality,
  communities, DCMA schedule health stay there.  Run both endpoints
  for a full picture.
- **No file I/O.** The engine returns JSON; no CSV / markdown exports.
- **No XER parsing.** The engine consumes Cybereum-native
  `{nodes, links}` only.  Server-side P6 XER ingest is a separate,
  deferred capability and should adapt XER -> Cybereum upstream of this
  endpoint, not duplicate the engine.
- **No common-mode clustering.** A regex-token approach was prototyped
  and explicitly deferred -- the supplied vocabulary was data-center-
  specific and didn't generalise.  The right form is sector-
  configurable profiles or n-gram / embedding-based extraction in a
  future scope.

### Caching

Redis-backed per-request fingerprint cache.  Cache key prefix
`interface:analytics:<sha256>`.  Equivalent payloads share an entry;
`cache_hit=true` short-circuits the engine and returns the stored
result with a fresh `cache_hit` flag.

### Programmatic API

The engine is callable directly without HTTP:

```python
from interface import compute_interface_analytics, InterfaceConfig, HotspotWeights

result = compute_interface_analytics(
    nodes, links,
    InterfaceConfig(
        grouping_field="Contract",
        weights=HotspotWeights(w_incoming=0.4, w_outgoing=0.3, w_risk=0.1),
        max_hotspots=50,
        top_samples_per_hotspot=10,
    ),
)
# result keys: summary, hotspots, matrix, warnings, _hotspot_records
```

The HTTP layer enriches each hotspot row with `top_incoming` /
`top_outgoing` from `_hotspot_records` (an internal handle, not part of
the API surface).  Direct callers either consume `_hotspot_records`
raw or perform the enrichment themselves.

Implemented in `interface/analytics.py`; route in
`interface/routes.py:analytics`.

---

## GET /interface/health

Liveness probe.

### Response (200)

```json
{
  "status":  "healthy",
  "module":  "interface",
  "endpoints": ["/interface/analytics"],
  "limits": {
    "max_nodes":         20000,
    "max_links":         100000,
    "max_payload_bytes": 10485760,
    "max_hotspots_cap":  5000,
    "max_top_samples":   50
  }
}
```
