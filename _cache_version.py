"""
Single source of truth for the cache key schema version.

Bump ``RESPONSE_SCHEMA_VERSION`` whenever any endpoint's response shape
changes (new keys at existing nesting levels do NOT require a bump --
adding keys is backward-compatible per docs/api/README.md "API
Stability Rules").  Required bumps:

* renaming an existing response key
* removing an existing response key
* changing an existing key's type
* changing an existing key's nesting level
* changing the meaning of an existing key (e.g. unit change)

The version string is prefixed onto every cache key (Redis or in-process
LRU) so a deploy that ships a shape change automatically invalidates
stale entries instead of returning malformed data to consumers until
the TTL expires.

Version format: ``vMAJOR.MINOR.PATCH``.  Increment MINOR for additive
changes that DO require invalidation (rare).  Increment MAJOR for
breaking shape changes.  PATCH is reserved for bugfix re-issues that
must invalidate without a public version bump.
"""

RESPONSE_SCHEMA_VERSION = 'v1.1.0'

# Changelog:
#   v1.0.0 -- initial centralised cache-key schema version (PR-2).
#   v1.1.0 -- deterministic cycle-handling rewrite on /graph-metrics
#             (main #26) adds top-level cycles_removed / warnings keys
#             AND alters existing values in cyclic-graph cases.  The
#             new keys are additive (no bump needed in isolation) but
#             the value-semantics shift earns a minor bump so legacy
#             v1.0.0 cache entries don't serve stale results during
#             rolling deploys.
