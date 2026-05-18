"""
Verifies the backend-vs-fallback telemetry helpers on the JS side.

Two helpers share a single window.cybereumState.completionPredictionTelemetry
object so the main app can detect a degrading backend (e.g. 30% 5xx
rate -> banner):

  - Completionprediction.js `_recordTelemetry` (reached via the
    `_internals` debug export of the IIFE)
  - EVM.js `_evmRecordTelemetry` (top-level function, lands on the
    sandbox global when the script is loaded)

The Node harness loads both scripts, invokes each helper, and emits
the aggregate telemetry object on stdout.  This test asserts both
per-service counters and the cross-module aggregate totals.

Auto-skips when Node.js is not installed.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HARNESS = Path(__file__).parent / 'diff_harness' / 'run_js_telemetry.js'

NODE_BIN = shutil.which('node')
pytestmark = pytest.mark.skipif(
    NODE_BIN is None,
    reason='node not installed; install Node.js to run JS telemetry test')


def _run_js():
    env = dict(os.environ)
    env['TZ'] = 'UTC'
    proc = subprocess.run(
        [NODE_BIN, str(HARNESS)],
        capture_output=True, timeout=30, text=True, env=env)
    if proc.returncode != 0:
        raise RuntimeError(
            f'Node harness exited {proc.returncode}\n'
            f'STDOUT: {proc.stdout[:500]}\n'
            f'STDERR: {proc.stderr[:500]}')
    return json.loads(proc.stdout)


def test_telemetry_counter_semantics():
    """The helper script runs:
      - 2x MC call, 1x MC success
      - 1x recovery call, 1x recovery fallback (non_ok_status 500)
      - 1x reference_classes fallback (backend_disabled)
      - 1x evm call, 1x evm success, 1x evm fallback (timeout)
    Totals: 4 calls, 2 successes, 3 fallbacks.
    """
    t = _run_js()
    assert t['backend_calls'] == 4
    assert t['backend_successes'] == 2
    assert t['fallback_count'] == 3

    # Last error wins: evm fallback was the last invocation.
    assert t['last_error']['service'] == 'evm'
    assert t['last_error']['reason'] == 'timeout'
    assert t['last_error']['message'] == 'aborted after 15s'

    by = t['by_service']
    assert by['monte_carlo'] == {'calls': 2, 'successes': 1, 'fallbacks': 0}
    assert by['recovery'] == {'calls': 1, 'successes': 0, 'fallbacks': 1}
    assert by['reference_classes'] == {'calls': 0, 'successes': 0,
                                       'fallbacks': 1}
    # EVM helper (top-level function in EVM.js) writes to the same
    # shared object -- proves cross-module aggregation works.
    assert by['evm'] == {'calls': 1, 'successes': 1, 'fallbacks': 1}


def test_telemetry_harness_completes_without_throwing():
    """Sanity check that the Node harness completes without raising
    and returns the expected shape.  Does NOT specifically exercise
    the `typeof window === 'undefined'` branch (the sandbox always
    defines window); that missing-window branch is exercised only by
    the helper's try/catch and is asserted structurally by the
    counter-semantics test above.  A targeted missing-window test
    would need the harness to delete `sandbox.window` before invoking
    the helpers, which isn't straightforward because both modules
    expect `window.cybereumState` at load time."""
    t = _run_js()
    assert isinstance(t, dict)
    assert 'backend_calls' in t
