"""
JS<->Python diff harness for /completion/recovery-options.

Verifies byte-equivalence on the deterministic core of the recovery
engine: crash-profile classification (kind + max_frac per activity)
and lag-unit conversion (lag_hours per link).  The engine's filter /
score / packaging steps build on these primitives, so locking these
to the JS reference catches the most common regression risk.

What it does NOT diff (yet):
  - Score computation (depends on importance / float / risk inputs that
    aren't always present in the JS data flow we test against)
  - Recovery option packaging (depends on target_hours which itself
    depends on the MC P80, which has its own diff harness)

Run only when Node.js is installed (auto-skip otherwise).
"""

import json
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest

from completion.recovery import (
    _normalise_link_lags,
    classify_crash_profile,
)
from evm.helpers import convert_to_hours, normalize_percent_complete

HARNESS_DIR = Path(__file__).parent / 'diff_harness'
JS_HARNESS = HARNESS_DIR / 'run_js_recovery.js'

NODE_BIN = shutil.which('node')
pytestmark = pytest.mark.skipif(
    NODE_BIN is None,
    reason='node not installed; install Node.js to run JS<->Py diff tests')


# Cache by fixture path: the recovery diff suite invokes this 4x per
# fixture (one per invariant), and each Node spawn is ~200-400 ms.
# The harness output is deterministic for a given fixture and the
# tests don't mutate the returned dict, so caching is safe.
@lru_cache(maxsize=None)
def _run_js(fixture_path):
    env = dict(os.environ)
    env['TZ'] = 'UTC'
    proc = subprocess.run(
        [NODE_BIN, str(JS_HARNESS), str(fixture_path)],
        capture_output=True, timeout=60, text=True, env=env)
    if proc.returncode != 0:
        raise RuntimeError(
            f'Node harness exited {proc.returncode}\n'
            f'STDOUT: {proc.stdout[:500]}\n'
            f'STDERR: {proc.stderr[:500]}')
    return json.loads(proc.stdout)


def _approx(a, b, rel=1e-6, abs_=1e-6):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if abs(a - b) <= abs_:
        return True
    if max(abs(a), abs(b)) > 0:
        return abs(a - b) / max(abs(a), abs(b)) <= rel
    return a == b


FIXTURES = sorted(HARNESS_DIR.glob('recovery_fixture_*.json'))


@pytest.fixture(params=FIXTURES, ids=lambda p: p.stem)
def fixture_path(request):
    return request.param


def test_classifications_match_js(fixture_path):
    """Per-activity (kind, max_frac) from classify_crash_profile must
    match JS classifyCrashProfile byte-for-byte.

    Locks down: the regex name patterns + supplier-type override +
    default_max_crash_fraction default + the deliberately-preserved
    `/sign/ matches "design"` quirk.
    """
    js = _run_js(fixture_path)
    with open(fixture_path) as f:
        fixture = json.load(f)

    failures = []
    for node in fixture['nodes']:
        nid = str(node['ID'])
        js_cls = js['classifications'][nid]
        py_profile = classify_crash_profile(
            node.get('Name'),
            node.get('SupplierType') or node.get('supplierType'))
        if py_profile['kind'] != js_cls['kind']:
            failures.append(
                f'  {nid}.kind: js={js_cls["kind"]!r} py={py_profile["kind"]!r}')
        if not _approx(py_profile['max_frac'], js_cls['max_frac']):
            failures.append(
                f'  {nid}.max_frac: js={js_cls["max_frac"]} '
                f'py={py_profile["max_frac"]}')

    assert not failures, (
        f'Crash classification diverged on {len(failures)} activities:\n'
        + '\n'.join(failures))


def test_pct_normalisation_matches_js(fixture_path):
    """normalize_percent_complete must match the JS heuristic exactly."""
    js = _run_js(fixture_path)
    with open(fixture_path) as f:
        fixture = json.load(f)

    failures = []
    for node in fixture['nodes']:
        nid = str(node['ID'])
        js_pct = js['classifications'][nid]['normalized_pct']
        py_pct = normalize_percent_complete(node.get('PercentComplete'))
        if not _approx(py_pct, js_pct):
            failures.append(
                f'  {nid}: js={js_pct} py={py_pct}')

    assert not failures, '\n'.join(failures)


def test_planned_hours_match_js(fixture_path):
    """convertToHours produces same result for each (Duration, TimeUnits) pair."""
    js = _run_js(fixture_path)
    with open(fixture_path) as f:
        fixture = json.load(f)

    failures = []
    for node in fixture['nodes']:
        nid = str(node['ID'])
        js_hrs = js['classifications'][nid]['planned_hrs']
        py_hrs = convert_to_hours(
            node.get('Duration'), node.get('TimeUnits'))
        if not _approx(py_hrs, js_hrs):
            failures.append(
                f'  {nid}: js={js_hrs} py={py_hrs}')

    assert not failures, '\n'.join(failures)


def test_lag_hours_match_js(fixture_path):
    """getLagInHours <-> _normalise_link_lags conversion must agree."""
    js = _run_js(fixture_path)
    with open(fixture_path) as f:
        fixture = json.load(f)

    py_links = _normalise_link_lags(fixture.get('links', []))
    py_lookup = {f"{l['source']}->{l['target']}": l['lag']
                 for l in py_links}

    failures = []
    for link_id, js_hrs in js['lag_hours'].items():
        py_hrs = py_lookup.get(link_id)
        if not _approx(py_hrs, js_hrs):
            failures.append(
                f'  {link_id}: js={js_hrs} py={py_hrs}')

    assert not failures, (
        f'Lag-unit conversion diverged on {len(failures)} links:\n'
        + '\n'.join(failures))
