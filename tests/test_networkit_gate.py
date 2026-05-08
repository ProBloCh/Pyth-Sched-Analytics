"""
NetworkKit startup gate tests (PR-3).

A bad deploy that lost the C++ wheel previously fell back to NetworkX
silently -- timing characteristics (and on legacy O(n^2) paths,
correctness) changed without any visible signal.  PR-3 closes the
gap with two surfaces:

1. ``/health`` reports ``networkit_available`` at the top level so
   uptime probes can branch.
2. ``PYTH_REQUIRE_NETWORKKIT=true`` exits 78 (EX_CONFIG) at boot when
   NetworkKit is unimportable.
"""

import os
import subprocess
import sys
import textwrap

import pytest

from app import app, _NK


def test_health_reports_networkit_at_top_level():
    """``/health`` carries the boolean at the top level."""
    app.config['TESTING'] = True
    client = app.test_client()
    resp = client.get('/health')
    assert resp.status_code == 200
    body = resp.get_json()
    assert 'networkit_available' in body
    assert body['networkit_available'] is _NK


def test_health_features_block_still_carries_networkit():
    """Backwards-compat: the existing ``features.networkit`` key remains."""
    app.config['TESTING'] = True
    client = app.test_client()
    body = client.get('/health').get_json()
    assert body['features']['networkit'] is _NK


@pytest.mark.skipif(_NK, reason='NetworkKit is installed; gate is unreachable')
def test_require_networkit_exits_when_missing():
    """With NetworkKit absent and PYTH_REQUIRE_NETWORKKIT=true, app exits 78."""
    code = textwrap.dedent("""
        import os, sys
        os.environ['PYTH_REQUIRE_NETWORKKIT'] = 'true'
        os.environ['PYTH_AUTH_DISABLED'] = 'true'
        try:
            import app  # noqa: F401
        except SystemExit as exc:
            sys.exit(exc.code)
        # Reaching this line means the gate failed to fire.
        sys.exit(0)
    """)
    proc = subprocess.run(
        [sys.executable, '-c', code],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        capture_output=True,
        timeout=30,
    )
    assert proc.returncode == 78, (
        f'expected exit 78 (EX_CONFIG), got {proc.returncode}\n'
        f'stdout: {proc.stdout.decode()}\nstderr: {proc.stderr.decode()}')


def test_default_does_not_require_networkit():
    """With PYTH_REQUIRE_NETWORKKIT unset, app boots regardless of NK."""
    # Importing ``app`` at module top already proves boot succeeded
    # under the default env.  This test just locks the default in
    # place against a future regression.
    assert app is not None


@pytest.mark.skipif(not _NK, reason='requires NetworkKit installed')
def test_require_networkit_passes_when_present():
    """With PYTH_REQUIRE_NETWORKKIT=true and NK installed, app boots."""
    code = textwrap.dedent("""
        import os, sys
        os.environ['PYTH_REQUIRE_NETWORKKIT'] = 'true'
        os.environ['PYTH_AUTH_DISABLED'] = 'true'
        import app  # noqa: F401
        sys.exit(0)
    """)
    proc = subprocess.run(
        [sys.executable, '-c', code],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        capture_output=True,
        timeout=30,
    )
    assert proc.returncode == 0, (
        f'expected clean exit, got {proc.returncode}\n'
        f'stderr: {proc.stderr.decode()}')
