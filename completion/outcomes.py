"""
completion/outcomes.py - Project-outcome registry.

Stores per-project predicted-vs-actual records so a customer's
real outcomes can be cross-checked against the model's percentiles
over time.  This is the foundation for empirical calibration --
without it, the reference-class table is "trust the literature";
with it, customers can validate (or refute) our P80 against their
own portfolio.

V1 storage: Redis when available (TTL-bounded), otherwise an
in-process dict with the same TTL semantics.  Both are intentionally
simple: this is data accumulation, not a calibration loop yet.

Outcome record schema::

    {
      'project_id':        '<customer-supplied stable ID>',
      'reference_class':   'oil_gas_offshore' | None,
      'submitted_at':      ISO-8601 UTC,

      # What the model predicted (one snapshot at the time the
      # decision was made -- e.g. at FEL-3 baseline freeze)
      'predicted': {
          'p50_finish': ISO,
          'p80_finish': ISO,
          'p95_finish': ISO,
          'baseline_finish': ISO,
          'iterations': int,
          'seed': int,
      },

      # What actually happened
      'actual': {
          'finish': ISO,
          'cost_overrun_pct': float | None,
          'schedule_overrun_pct': float | None,
      },

      # Free-form metadata for retrospectives
      'metadata': dict,
    }

The calibration-report endpoint aggregates these into a per-class
empirical CDF the customer can compare against the published
reference-class factors.

NOT YET IMPLEMENTED (documented in REMAINING_WORK.md):
  - Bayesian update of distribution parameters from these outcomes
  - Per-customer reference-class derivation
  - Long-horizon storage beyond Redis TTL
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections import defaultdict
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# Default TTL for outcome records: 5 years.  Long enough for capital
# project lifecycles; deployers can override via env var.
_DEFAULT_TTL_SECONDS = int(
    os.environ.get('PYTH_OUTCOMES_TTL_SECONDS', 5 * 365 * 24 * 3600))

# Maximum outcomes returned by the calibration report; defends against
# a customer with millions of historical records loading the full set.
_MAX_REPORT_OUTCOMES = int(
    os.environ.get('PYTH_OUTCOMES_MAX_REPORT', 10_000))


# ---------------------------------------------------------------------------
# Storage backends
# ---------------------------------------------------------------------------

class _InProcStore:
    """Fallback when Redis isn't available.  TTL-honouring in-process
    dict.  Lost on process restart; never use as the only store in
    production."""

    def __init__(self):
        self._data = {}  # key -> (expiry_ts, value)

    def set(self, key, value, ttl=None):
        expiry = time.time() + (ttl or _DEFAULT_TTL_SECONDS)
        self._data[key] = (expiry, value)

    def get(self, key):
        rec = self._data.get(key)
        if rec is None:
            return None
        expiry, value = rec
        if time.time() > expiry:
            self._data.pop(key, None)
            return None
        return value

    def keys(self, pattern):
        # Pattern is glob-style 'outcome:CLASS:*'; we match by prefix.
        prefix = pattern.rstrip('*')
        now = time.time()
        return [k for k, (exp, _) in list(self._data.items())
                if k.startswith(prefix) and exp > now]


_inproc = _InProcStore()


def _store():
    """Return (redis_client, fallback_store).  Redis preferred; falls
    through to in-process when not configured / not reachable.

    Uses the same Redis client pattern as solver/routes._cache so a
    single REDIS_URL configures both cache and outcomes.
    """
    try:
        from app import redis_client
        if redis_client is not None:
            return (redis_client, None)
    except Exception:
        pass
    return (None, _inproc)


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------

_REQUIRED_TOP = ('project_id', 'predicted', 'actual')
_REQUIRED_PREDICTED = ('p80_finish',)
_REQUIRED_ACTUAL = ('finish',)


def validate_outcome(record):
    """Returns list of error strings (empty -> valid)."""
    errs = []
    if not isinstance(record, dict):
        return ['outcome record must be an object']
    for k in _REQUIRED_TOP:
        if k not in record:
            errs.append(f'missing required field {k!r}')
    pid = record.get('project_id')
    if pid is not None and (not isinstance(pid, str) or not pid.strip()):
        errs.append('project_id must be a non-empty string')

    pred = record.get('predicted') or {}
    if not isinstance(pred, dict):
        errs.append('predicted must be an object')
    else:
        for k in _REQUIRED_PREDICTED:
            if k not in pred:
                errs.append(f'predicted.{k} is required')
        # Validate ISO parseability for the timestamps we'll later need
        # in calibration_report.  Without this, malformed strings slip
        # through validation and silently reduce calibration signal.
        for k in ('p80_finish', 'p50_finish', 'p95_finish', 'baseline_finish'):
            v = pred.get(k)
            if v is not None and (not isinstance(v, str) or
                                  _parse_iso(v) is None):
                errs.append(f'predicted.{k} is not a parseable ISO-8601 '
                            f'timestamp: {v!r}')

    actual = record.get('actual') or {}
    if not isinstance(actual, dict):
        errs.append('actual must be an object')
    else:
        for k in _REQUIRED_ACTUAL:
            if k not in actual:
                errs.append(f'actual.{k} is required')
        a_finish = actual.get('finish')
        if a_finish is not None and (not isinstance(a_finish, str) or
                                     _parse_iso(a_finish) is None):
            errs.append(f'actual.finish is not a parseable ISO-8601 '
                        f'timestamp: {a_finish!r}')

    rc = record.get('reference_class')
    if rc is not None and not isinstance(rc, str):
        errs.append('reference_class must be a string or null')

    return errs


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def register_outcome(record, ttl=None):
    """Store an outcome.  Returns the canonical record (with
    submitted_at filled in if absent).  Caller must have validated
    via validate_outcome first."""
    redis_cli, fallback = _store()
    rec = dict(record)
    rec.setdefault('submitted_at',
                   datetime.now(tz=timezone.utc).isoformat())
    rc_key = rec.get('reference_class') or 'unspecified'
    pid = rec['project_id']
    key = f'outcomes:{rc_key}:{pid}'

    payload = json.dumps(rec, default=str)
    storage = 'redis' if redis_cli is not None else 'in_process'
    try:
        if redis_cli is not None:
            redis_cli.set(key, payload, ex=(ttl or _DEFAULT_TTL_SECONDS))
        else:
            fallback.set(key, payload, ttl=ttl)
        logger.info('Registered outcome project=%s class=%s', pid, rc_key)
    except Exception as exc:
        # Redis unavailable mid-flight: degrade to in-proc so the
        # request still succeeds.  When Redis is primary, fallback is
        # None -- reach for _inproc directly so the recovery path is
        # unconditional.  We surface the degraded mode via the returned
        # `storage` field so the route layer can include it in the
        # JSON response (the route currently passes the record through
        # unchanged; with this field it can flag the in-proc fallback
        # to the caller).
        logger.warning('Outcome storage failed (%s); using in-proc fallback',
                       exc)
        _inproc.set(key, payload, ttl=ttl)
        storage = 'in_process_after_redis_failure'
    rec['storage'] = storage
    return rec


def list_outcomes(reference_class=None, limit=_MAX_REPORT_OUTCOMES):
    """Yield outcome records.  When reference_class is set, only that
    class's records are returned.  Limit caps the total to avoid
    pathological responses."""
    redis_cli, fallback = _store()
    rc_key = reference_class or '*'
    pattern = f'outcomes:{rc_key}:*' if reference_class else 'outcomes:*'

    keys = []
    # Track whether we've been forced into the in-proc fallback by a
    # Redis error so the per-key GET loop below reads from the right
    # store.  Without this, a `scan_iter` failure would re-scan _inproc
    # keys but then try to `redis_cli.get` them, finding nothing.
    reading_from_redis = redis_cli is not None
    try:
        if redis_cli is not None:
            # SCAN is preferred over KEYS for production Redis but we
            # keep it simple here -- the report endpoint is rate-limited
            # by the cap.
            for k in redis_cli.scan_iter(match=pattern, count=500):
                if isinstance(k, bytes):
                    k = k.decode('utf-8')
                keys.append(k)
                if len(keys) >= limit:
                    break
        else:
            keys = fallback.keys(pattern)[:limit]
    except Exception as exc:
        # When Redis is primary, fallback is None -- reach for _inproc
        # directly so the recovery path is unconditional.
        logger.warning('Failed to list outcomes: %s', exc)
        keys = _inproc.keys(pattern)[:limit]
        reading_from_redis = False

    for k in keys:
        try:
            if reading_from_redis:
                raw = redis_cli.get(k)
                if isinstance(raw, bytes):
                    raw = raw.decode('utf-8')
            else:
                raw = (fallback or _inproc).get(k)
            if raw:
                yield json.loads(raw)
        except Exception:
            continue


def calibration_report(reference_class=None):
    """Aggregate accumulated outcomes into a calibration summary.

    Returns dict with:
      - n: total outcome records
      - by_class: {class_name: {n, predicted_actual_ratio_p50, p80, p95}}
      - notes: list of advisory strings
    """
    by_class = defaultdict(list)
    n_total = 0
    for rec in list_outcomes(reference_class):
        n_total += 1
        rc = rec.get('reference_class') or 'unspecified'
        try:
            actual = _parse_iso(rec['actual']['finish'])
            pred_p80 = _parse_iso(rec['predicted'].get('p80_finish'))
            baseline = _parse_iso(rec['predicted'].get('baseline_finish'))
            if actual is None or pred_p80 is None:
                continue
            # If baseline is provided, ratio = overrun_actual / overrun_p80.
            # If model was well-calibrated, ratio averages near 1.0.
            # If ratio > 1, project ran longer than predicted P80
            # (the LinkedIn critique signature).
            if baseline is not None and pred_p80 > baseline:
                actual_overrun_days = (actual - baseline).total_seconds() / 86400
                pred_overrun_days = (pred_p80 - baseline).total_seconds() / 86400
                if pred_overrun_days > 0:
                    ratio = actual_overrun_days / pred_overrun_days
                    by_class[rc].append(ratio)
        except (KeyError, ValueError, TypeError):
            continue

    summary = {}
    for rc, ratios in by_class.items():
        if not ratios:
            continue
        ratios_sorted = sorted(ratios)
        n = len(ratios_sorted)
        summary[rc] = {
            'n': n,
            'p50_ratio': ratios_sorted[int(0.5 * (n - 1))],
            'p80_ratio': ratios_sorted[int(0.8 * (n - 1))],
            'p95_ratio': ratios_sorted[int(0.95 * (n - 1))] if n >= 5 else None,
            'mean_ratio': sum(ratios_sorted) / n,
        }

    notes = []
    if n_total < 30:
        notes.append(
            f'Only {n_total} outcomes registered; calibration ratios '
            f'are noisy below ~30 records per class.')
    for rc, stats in summary.items():
        if stats['mean_ratio'] > 1.3:
            notes.append(
                f'{rc}: mean actual overrun is {stats["mean_ratio"]:.1f}x '
                f'the predicted P80 -- the LinkedIn-style "P80 acts like '
                f'P10" signature.  Consider tightening the reference-class '
                f'percentile factors or switching to a fatter-tail class.')
        elif stats['mean_ratio'] < 0.7:
            notes.append(
                f'{rc}: mean actual overrun is {stats["mean_ratio"]:.1f}x '
                f'the predicted P80 -- model is too pessimistic for this '
                f'class.  Consider relaxing the percentile factors.')

    return {
        'n': n_total,
        'by_class': summary,
        'notes': notes,
        'storage': 'redis' if _store()[0] is not None else 'in_process',
    }


def _parse_iso(s):
    """Parse an ISO-8601 string, always returning a timezone-aware UTC
    datetime (or None on failure).  Naive inputs -- e.g. '2025-01-01' or
    '2025-01-01T00:00:00' without a tz suffix -- are assumed UTC.  Inputs
    with a non-UTC offset (e.g. '2025-01-01T00:00:00+05:00') are
    converted to UTC so day-delta computations in calibration_report
    don't skew on customers who submit local-time timestamps.  Matches
    the repo-wide "naive => UTC, aware => convert to UTC" convention
    (evm.helpers.safe_date)."""
    if s is None:
        return None
    try:
        clean = str(s).replace('Z', '+00:00')
        dt = datetime.fromisoformat(clean)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt


__all__ = [
    'register_outcome',
    'list_outcomes',
    'calibration_report',
    'validate_outcome',
]
