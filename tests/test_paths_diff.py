"""
JS-vs-Python diff harness for the /paths blueprint.

For each fixture in tests/diff_harness/path_fixture_*.json:
  1. Invokes node tests/diff_harness/run_js_paths.js on the fixture and
     captures the JS-side outputs (path enumeration, distance maps,
     CPM dates, driving graph).
  2. Runs the Python implementations in paths/ on the same fixture.
  3. Asserts equivalence within tolerance.

Skips automatically when Node.js is not installed.

Divergence policy
-----------------
When the two impls disagree, the spec is the JS reference (PathScripts.js)
**unless** the divergence reflects a JS bug.  Two known/expected
divergences are tolerated below; both are documented inline with a
pointer to the JS line and a justification of why the Python answer is
the correct one.  See:

  * ``test_distances_to_start_match`` -- JS findDistancesToStart never
    initialises ``shortestDistances`` for predecessor-less nodes that
    aren't ``startNode``, leaving them at ``Infinity``; Python seeds 0
    for any node with no predecessors so paths from those orphans are
    reachable.  The test compares only the connected sub-DAG.
"""

import json
import math
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest

from paths.distances import distances_to_end, distances_to_start
from paths.driving_graph import DrivingGraphConfig, extract_driving_graph
from paths.enumerate import find_all_paths
from solver.dag import build_dag

HARNESS_DIR = Path(__file__).parent / 'diff_harness'
JS_HARNESS = HARNESS_DIR / 'run_js_paths.js'

NODE_BIN = shutil.which('node')
pytestmark = pytest.mark.skipif(
    NODE_BIN is None,
    reason='node not installed; install Node.js to run JS<->Py diff tests')

FIXTURES = sorted(HARNESS_DIR.glob('path_fixture_*.json'))


# ---------------------------------------------------------------------------
# Spawn / cache helpers
# ---------------------------------------------------------------------------

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


def _load_fixture(fixture_path):
    with open(fixture_path) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Comparison helpers
# ---------------------------------------------------------------------------

def _approx(a, b, rel=1e-6, abs_=1e-6):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if not (math.isfinite(a) and math.isfinite(b)):
        return a == b
    return abs(a - b) <= max(abs_, rel * max(abs(a), abs(b)))


def _path_set(paths):
    """Tuple of node IDs is hashable; collapse a path list into a set
    for order-independent comparison."""
    return {tuple(p) for p in (paths or [])}


def _path_to_dur(paths, durations):
    """Map path tuples -> rounded duration so we can spot mismatches."""
    out = {}
    for p, d in zip(paths or [], durations or []):
        out[tuple(p)] = round(float(d), 6)
    return out


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('fixture_path', FIXTURES,
                         ids=[p.stem for p in FIXTURES])
def test_find_all_paths_match(fixture_path):
    """Path set + per-path durations agree byte-for-byte on small DAGs."""
    js = _run_js(fixture_path)
    fx = _load_fixture(fixture_path)

    py = find_all_paths(
        fx['nodes'], fx['links'],
        fx['start_id'], fx['end_id'],
        max_paths=fx.get('max_paths', 1000),
        branch_balanced=False,
    )
    # /paths/enumerate raw mode -- diversity post-filter disabled in JS too.
    js_paths = js['paths']['paths']
    js_durs = js['paths']['durations']

    assert _path_set(py['paths']) == _path_set(js_paths), (
        f'path-set diverges:\n  py: {sorted(_path_set(py["paths"]))}\n'
        f'  js: {sorted(_path_set(js_paths))}'
    )

    py_pd = _path_to_dur(py['paths'], py['durations'])
    js_pd = _path_to_dur(js_paths, js_durs)
    for sig in py_pd:
        assert _approx(py_pd[sig], js_pd.get(sig)), (
            f'duration diverges for {sig}: py={py_pd[sig]} js={js_pd.get(sig)}'
        )


@pytest.mark.parametrize('fixture_path', FIXTURES,
                         ids=[p.stem for p in FIXTURES])
def test_cpm_es_ef_match(fixture_path):
    """ES/EF/LS/LF from JS calculateCPMDates vs solver.dag.run_cpm.

    These are the foundation that every other path algorithm builds on,
    so disagreement here would cascade into every other test.
    """
    js = _run_js(fixture_path)
    fx = _load_fixture(fixture_path)
    state, id_to_idx = build_dag(fx['nodes'], fx['links'],
                                 default_duration=0.0)
    js_cpm = js['cpm']

    for nid, idx in id_to_idx.items():
        py_es = float(state.ES[idx])
        py_ef = float(state.EF[idx])
        js_es = js_cpm['ES'].get(nid)
        js_ef = js_cpm['EF'].get(nid)
        assert _approx(py_es, js_es), (
            f'ES[{nid}] py={py_es} js={js_es}')
        assert _approx(py_ef, js_ef), (
            f'EF[{nid}] py={py_ef} js={js_ef}')

    assert _approx(float(state.makespan), js_cpm['project_finish']), (
        f'makespan py={state.makespan} js={js_cpm["project_finish"]}'
    )


@pytest.mark.parametrize('fixture_path', FIXTURES,
                         ids=[p.stem for p in FIXTURES])
def test_distances_to_start_match(fixture_path):
    """Per-node shortest+longest distance from start.

    The JS findDistancesToStart only seeds startNode at 0 and leaves
    every other predecessor-less node at Infinity (they're never
    relaxed); Python seeds *all* nodes-with-no-predecessors at 0.  For
    fixtures with a single source (start_id) this is identical, which
    is what every fixture in this suite uses.  The check restricts to
    nodes the JS marked finite to absorb that behavioural difference
    if a future fixture has multiple sources.
    """
    js = _run_js(fixture_path)
    fx = _load_fixture(fixture_path)
    state, id_to_idx = build_dag(fx['nodes'], fx['links'],
                                 default_duration=0.0)
    py_d = distances_to_start(state)
    js_short = js['distances_to_start']['shortest']
    js_long = js['distances_to_start']['longest']

    for nid, idx in id_to_idx.items():
        if js_short.get(nid) is None and js_long.get(nid) is None:
            continue   # JS marked unreachable; skip
        py_s = float(py_d['shortest'][idx])
        py_l = float(py_d['longest'][idx])
        if math.isinf(py_s):
            continue
        assert _approx(py_s, js_short.get(nid)), (
            f'shortestToStart[{nid}] py={py_s} js={js_short.get(nid)}'
        )
        assert _approx(py_l, js_long.get(nid)), (
            f'longestToStart[{nid}] py={py_l} js={js_long.get(nid)}'
        )


@pytest.mark.parametrize('fixture_path', FIXTURES,
                         ids=[p.stem for p in FIXTURES])
def test_distances_to_end_match(fixture_path):
    """Per-node distance to end (the longest variant equals
    ``project_finish - EF[node]`` for FS-only DAGs but is general)."""
    js = _run_js(fixture_path)
    fx = _load_fixture(fixture_path)
    state, id_to_idx = build_dag(fx['nodes'], fx['links'],
                                 default_duration=0.0)
    py_d = distances_to_end(state)
    js_long = js['distances_to_end']['longest']

    for nid, idx in id_to_idx.items():
        if js_long.get(nid) is None:
            continue
        py_l = float(py_d['longest'][idx])
        if math.isinf(py_l):
            continue
        assert _approx(py_l, js_long.get(nid)), (
            f'longestToEnd[{nid}] py={py_l} js={js_long.get(nid)}'
        )


@pytest.mark.parametrize('fixture_path', FIXTURES,
                         ids=[p.stem for p in FIXTURES])
def test_driving_graph_chains_match(fixture_path):
    """Driving + near-driving chain sets agree (raw selection).

    JS extractDrivingGraphPathsFromCPM with selectionMode='raw' returns
    the full deduplicated candidate set (critical + near-critical chains
    merged).  Python extract_driving_graph with the same config option
    returns the same set.  Both pipelines build their CPM on the active
    subgraph (reachable from start INTERSECT can-reach end).
    """
    js = _run_js(fixture_path)
    fx = _load_fixture(fixture_path)
    cfg = DrivingGraphConfig(selection_mode='raw')
    py_dg = extract_driving_graph(fx['nodes'], fx['links'],
                                  fx['start_id'], fx['end_id'], cfg)
    js_paths = js['driving']['paths']

    assert _path_set(py_dg.paths) == _path_set(js_paths), (
        f'driving chain set diverges:\n'
        f'  py: {sorted(_path_set(py_dg.paths))}\n'
        f'  js: {sorted(_path_set(js_paths))}'
    )
    assert _approx(py_dg.project_finish_hours,
                   js['driving']['project_finish_hours']), (
        f'driving project finish py={py_dg.project_finish_hours} '
        f'js={js["driving"]["project_finish_hours"]}'
    )
    assert py_dg.active_node_count == js['driving']['active_node_count'], (
        f'active node count py={py_dg.active_node_count} '
        f'js={js["driving"]["active_node_count"]}'
    )
