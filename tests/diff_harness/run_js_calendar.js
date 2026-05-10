#!/usr/bin/env node
/*
 * tests/diff_harness/run_js_calendar.js
 *
 * Loads Reference/Completionprediction.js inside a stubbed browser-like
 * sandbox and invokes `addWorkingHours` on each case in a JSON fixture.
 * Emits the JS-side finish epoch-ms for each case as JSON on stdout.
 *
 * Used by tests/test_calendar_diff.py to verify JS-Python parity of
 * completion/calendar.py advance_working_ms against the canonical JS
 * implementation (Reference/Completionprediction.js lines 396-423).
 *
 * Limitation: the JS reference's _normalizeWeekendForward hardcodes
 * Sat=6 / Sun=0 via getDay() (Reference/Completionprediction.js
 * _isWorkingDay), so a fixture with `working_days` != [1..5] would
 * produce an apples-to-oranges comparison.  The Python side supports
 * arbitrary working_day sets; the JS side does not.  Don't add
 * non-Mon-Fri fixtures to this harness without first extending the JS
 * reference to honour CONFIG.workingDays.
 *
 * Fixture format:
 *   {
 *     "calendar": {
 *       "hours_per_day": 8,
 *       "working_days": [1, 2, 3, 4, 5],
 *       "holidays": ["2025-01-08", ...]
 *     },
 *     "cases": [
 *       { "name": "mon-1pm-16h", "start_iso": "...", "work_hours": 16.0 },
 *       ...
 *     ]
 *   }
 *
 * Output format:
 *   {
 *     "results": [
 *       { "name": "...", "start_ms": 1234, "work_hours": 16,
 *         "finish_ms": 5678, "finish_iso": "..." },
 *       ...
 *     ]
 *   }
 *
 * Usage: node run_js_calendar.js fixture.json > js_out.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

if (process.argv.length < 3) {
    console.error('Usage: node run_js_calendar.js <fixture.json>');
    process.exit(2);
}

const fixturePath = process.argv[2];
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// ---------------------------------------------------------------------------
// Stubbed browser sandbox (window/document/etc.).  The CompletionPrediction
// IIFE registers global.CompletionPrediction on whatever object we pass as
// `global`, so all we need is a window-like object.
// ---------------------------------------------------------------------------

const stderrConsole = {
    log:   (...args) => process.stderr.write('[js] ' + args.join(' ') + '\n'),
    info:  (...args) => process.stderr.write('[js] ' + args.join(' ') + '\n'),
    warn:  (...args) => process.stderr.write('[js] ' + args.join(' ') + '\n'),
    error: (...args) => process.stderr.write('[js] ' + args.join(' ') + '\n'),
    table: () => {},
    debug: () => {},
};

const sandbox = {
    console: stderrConsole,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Math: Math,
    Date: Date,
    Map: Map,
    Set: Set,
    JSON: JSON,
    Number: Number,
    String: String,
    Object: Object,
    Array: Array,
    parseFloat: parseFloat,
    parseInt: parseInt,
    isFinite: isFinite,
    isNaN: isNaN,
    Error: Error,
    Promise: Promise,
    fetch: undefined,
    AbortController: undefined,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    performance: { now: () => Date.now() },
};
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.self = sandbox;
sandbox.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({
        style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false },
        appendChild: () => {}, removeChild: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
    }),
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
    readyState: 'complete',
};
sandbox.Chart = function () { return { destroy: () => {} }; };
sandbox.Chart.getChart = () => null;
sandbox.window.cybereumState = {};

vm.createContext(sandbox);

// ---------------------------------------------------------------------------
// Configure the JS-side working calendar BEFORE loading the IIFE.  The
// _getHolidaySet helper caches on first call, so HOLIDAY_SET must be set
// up before any fixture case runs.
// ---------------------------------------------------------------------------

const cal = fixture.calendar || {};
const hpd = +cal.hours_per_day || 8;
const workingDays = Array.isArray(cal.working_days) && cal.working_days.length
    ? cal.working_days.slice()
    : [1, 2, 3, 4, 5];

// HOLIDAY_SET is keyed by 'YYYY-MM-DD' via _dateKey (local-time getters).
// We launch node with TZ=UTC from the Python harness so the local-time
// keys match UTC ISO dates.
sandbox.window.HOLIDAY_SET = new Set(cal.holidays || []);

// teamCalendar is the fallback path inside _getHolidaySet -- populate it
// too for defensive parity with the real frontend wiring.
sandbox.window.cybereumState.teamCalendar = {
    hoursPerDay: hpd,
    workingDays: workingDays,
    holidays: (cal.holidays || []).map(d => ({ date: d })),
};

// Load the JS reference.  CompletionPrediction lives inside an IIFE that
// registers itself on `global` (= window in this sandbox).
const REF_DIR = path.resolve(__dirname, '..', '..', 'Reference');
function loadScript(filename) {
    const fullPath = path.join(REF_DIR, filename);
    const code = fs.readFileSync(fullPath, 'utf8');
    try {
        vm.runInContext(code, sandbox, { filename });
    } catch (err) {
        // Top-level DOMContentLoaded hooks etc. are non-fatal; the function
        // declarations register either way.
        process.stderr.write(`[harness] non-fatal load error in ${filename}: `
                             + err.message + '\n');
    }
}
// PathScripts.js exposes convertToHours and other helpers that
// Completionprediction.js's `_internals` block references at IIFE
// load time (Reference/Completionprediction.js line 6472).  Load it
// first so the IIFE registers successfully.
loadScript('PathScripts.js');
loadScript('Completionprediction.js');

const CP = sandbox.window.CompletionPrediction;
if (!CP || !CP._internals || !CP._internals.addWorkingHours) {
    console.error('CompletionPrediction._internals.addWorkingHours not exposed; '
                  + 'verify Reference/Completionprediction.js exports it.');
    process.exit(3);
}

// Sync CONFIG.workingHoursPerDay (the JS reads this inside addWorkingHours).
CP.CONFIG.workingHoursPerDay = hpd;

// ---------------------------------------------------------------------------
// Run each case.
// ---------------------------------------------------------------------------

const addWorkingHours = CP._internals.addWorkingHours;
const cases = Array.isArray(fixture.cases) ? fixture.cases : [];
const results = cases.map((c, i) => {
    const startMs = Date.parse(c.start_iso);
    if (!isFinite(startMs)) {
        throw new Error(`case ${i} (${c.name || '?'}): invalid start_iso `
                        + JSON.stringify(c.start_iso));
    }
    const startDate = new Date(startMs);
    const finishDate = addWorkingHours(startDate, +c.work_hours);
    const finishMs = finishDate ? finishDate.getTime() : null;
    return {
        name: c.name || `case_${i}`,
        start_ms: startMs,
        work_hours: +c.work_hours,
        finish_ms: finishMs,
        finish_iso: finishDate ? finishDate.toISOString() : null,
    };
});

process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
