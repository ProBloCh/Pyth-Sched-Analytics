"""
JS-vs-Python diff harness for the working-calendar primitive
``completion.calendar.advance_working_ms``.

For each fixture in tests/diff_harness/calendar_fixture_*.json:
  1. Invokes ``node tests/diff_harness/run_js_calendar.js`` on the
     fixture and captures the JS-side finish epoch-ms for each case.
  2. Runs the Python ``advance_working_ms`` on the same case with a
     calendar built from the fixture's calendar block.
  3. Asserts the finish times match within 1 ms (calendars work in
     epoch-ms; there is no fractional drift to absorb).

The fixtures cover:
  * midnight and non-midnight starts
  * intraday remainders and whole-day advances
  * Friday-evening remainder bumps that cross weekends
  * holiday-aware slow path (Wed holiday) and start-day-is-holiday
    (Mon holiday)
  * zero-hour passthrough

Skips automatically when Node.js is not installed.
"""

import json
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest

from completion.calendar import (
    WorkingCalendar, advance_working_ms, _parse_holiday)


HARNESS_DIR = Path(__file__).parent / 'diff_harness'
JS_HARNESS = HARNESS_DIR / 'run_js_calendar.js'

NODE_BIN = shutil.which('node')
pytestmark = pytest.mark.skipif(
    NODE_BIN is None,
    reason='node not installed; install Node.js to run JS<->Py diff tests')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@lru_cache(maxsize=None)
def _run_js(fixture_path):
    """Invoke the Node harness once per fixture; return parsed JSON.

    TZ=UTC ensures that JS local-time getters (used by _dateKey in
    Completionprediction.js) produce the same 'YYYY-MM-DD' keys that
    the fixture's holiday strings use.
    """
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


def _parse_iso_to_ms(iso):
    """Parse 'YYYY-MM-DDTHH:MM:SSZ' (or +00:00) to UTC epoch ms."""
    from datetime import datetime, timezone
    s = iso.replace('Z', '+00:00')
    return datetime.fromisoformat(s).timestamp() * 1000.0


def _build_cal(fixture, horizon_days=120):
    """Build a Python WorkingCalendar from the fixture's calendar block.

    Horizon defaults to 120 days -- more than enough for our 200h cases
    (25 working days = 5 calendar weeks).
    """
    cal_cfg = fixture.get('calendar', {})
    hpd = float(cal_cfg.get('hours_per_day', 8))
    working_days = frozenset(int(d) for d in cal_cfg.get(
        'working_days', [1, 2, 3, 4, 5]))
    holidays = list(cal_cfg.get('holidays', []))

    # Use the earliest start_iso as the calendar epoch so day 0 covers
    # the first case.  Floor to UTC midnight via _parse_holiday (handles
    # the YYYY-MM-DD short form).
    cases = fixture.get('cases', [])
    start_mss = [_parse_iso_to_ms(c['start_iso']) for c in cases]
    start_ms = min(start_mss) if start_mss else _parse_iso_to_ms(
        '2025-01-01T00:00:00Z')
    return WorkingCalendar.build(hpd, working_days, holidays,
                                 start_ms, horizon_days=horizon_days)


# ---------------------------------------------------------------------------
# Fixture discovery + parametrisation
# ---------------------------------------------------------------------------

FIXTURE_PATHS = sorted(HARNESS_DIR.glob('calendar_fixture_*.json'))


def _parametrize_cases():
    """Yield (fixture_path, case_index, case_name) for every case in
    every fixture.  Done eagerly at collection time so pytest reports
    each case as a separate test ID.
    """
    out = []
    for fp in FIXTURE_PATHS:
        with open(fp) as f:
            fixture = json.load(f)
        for i, c in enumerate(fixture.get('cases', [])):
            out.append((fp, i, c.get('name', f'case_{i}')))
    return out


CASES = _parametrize_cases()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    'fixture_path,case_idx,case_name',
    CASES,
    ids=[f'{fp.stem}::{name}' for fp, _, name in CASES])
def test_js_py_calendar_parity(fixture_path, case_idx, case_name):
    """JS addWorkingHours and Python advance_working_ms must agree on
    finish epoch-ms within 1 ms.

    The 1 ms tolerance absorbs any IEEE-754 floating-point rounding
    from the Python side's arithmetic; the JS side uses Date.getTime()
    which is an integer ms internally, so a strict equality assertion
    would also hold today, but 1 ms keeps us robust against future
    intraday-fraction refinements.
    """
    js_out = _run_js(fixture_path)
    js_result = js_out['results'][case_idx]

    with open(fixture_path) as f:
        fixture = json.load(f)
    case = fixture['cases'][case_idx]

    cal = _build_cal(fixture)
    start_ms = _parse_iso_to_ms(case['start_iso'])
    py_finish = float(advance_working_ms(start_ms, case['work_hours'], cal))
    js_finish = float(js_result['finish_ms'])

    assert abs(py_finish - js_finish) <= 1.0, (
        f"JS-Py drift on case '{case_name}': "
        f"JS={js_result['finish_iso']} ({js_finish:.0f} ms) vs "
        f"Py={py_finish:.0f} ms "
        f"(delta={py_finish - js_finish:.3f} ms)")
