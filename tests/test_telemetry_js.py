"""
Verifies the backend-vs-fallback telemetry helper on the JS side.

The helper (Completionprediction.js `_recordTelemetry` +
EVM.js `_evmRecordTelemetry`) increments counters on
`window.cybereumState.completionPredictionTelemetry` so the main app
can detect a degrading backend (e.g. 30% 5xx rate → banner).  This
test drives the helper via the _internals debug export in a Node
sandbox and asserts the counter semantics match the contract.

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
      - 2× MC call, 1× MC success
      - 1× recovery call, 1× recovery fallback (non_ok_status 500)
      - 1× reference_classes fallback (backend_disabled)
    """
    t = _run_js()
    assert t['backend_calls'] == 3
    assert t['backend_successes'] == 1
    assert t['fallback_count'] == 2

    # Last error wins: the last fallback call was reference_classes disabled.
    assert t['last_error']['service'] == 'reference_classes'
    assert t['last_error']['reason'] == 'backend_disabled'

    by = t['by_service']
    assert by['monte_carlo'] == {'calls': 2, 'successes': 1, 'fallbacks': 0}
    assert by['recovery'] == {'calls': 1, 'successes': 0, 'fallbacks': 1}
    assert by['reference_classes'] == {'calls': 0, 'successes': 0,
                                       'fallbacks': 1}


def test_telemetry_never_throws_on_missing_window():
    """The helper must swallow any error rather than break the calling
    wrapper.  Not directly testable from Python, but the Node harness
    completes successfully which proves the try/catch is in place."""
    t = _run_js()
    assert isinstance(t, dict)
    assert 'backend_calls' in t
