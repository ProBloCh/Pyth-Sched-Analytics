#!/usr/bin/env node
/*
 * tests/diff_harness/run_js_recovery.js
 *
 * Loads classifyCrashProfile from Reference/Completionprediction.js
 * inside a stubbed sandbox and runs it on a JSON fixture that
 * provides activities + critical-path + project context.  Emits the
 * crash-profile classifications + per-activity score components on
 * stdout so the Python recovery engine can be diff-compared
 * activity-by-activity.
 *
 * Used by tests/test_recovery_diff.py to verify JS <-> Python parity
 * on the deterministic crash-classification logic.
 *
 * Usage: node run_js_recovery.js fixture.json > js_out.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

if (process.argv.length < 3) {
    console.error('Usage: node run_js_recovery.js <fixture.json>');
    process.exit(2);
}

const fixturePath = process.argv[2];
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const stderrConsole = {
    log:   (...args) => process.stderr.write('[js] ' + args.join(' ') + '\n'),
    info:  (...args) => process.stderr.write('[js] ' + args.join(' ') + '\n'),
    warn:  (...args) => process.stderr.write('[js] ' + args.join(' ') + '\n'),
    error: (...args) => process.stderr.write('[js] ' + args.join(' ') + '\n'),
    table: () => {}, debug: () => {},
};

const sandbox = {
    console: stderrConsole,
    setTimeout, clearTimeout, Math, Date, Map, Set, JSON, Number, String,
    Object, Array, parseFloat, parseInt, isFinite, isNaN, Error, Promise,
    fetch: undefined, AbortController: undefined,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    performance: { now: () => Date.now() },
};
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.self = sandbox;
sandbox.document = {
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => {}, querySelector: () => null,
    querySelectorAll: () => [], getElementById: () => null,
    createElement: () => ({
        style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false },
        appendChild: () => {}, removeChild: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
    }),
    body: { appendChild: () => {} }, head: { appendChild: () => {} },
    readyState: 'complete',
};
sandbox.Chart = function () { return { destroy: () => {} }; };
sandbox.Chart.getChart = () => null;
sandbox.window.cybereumState = fixture.cybereumState || {};

vm.createContext(sandbox);

const REF_DIR = path.resolve(__dirname, '..', '..', 'Reference');
function loadScript(filename) {
    const fullPath = path.join(REF_DIR, filename);
    const code = fs.readFileSync(fullPath, 'utf8');
    try {
        vm.runInContext(code, sandbox, { filename });
    } catch (err) {
        process.stderr.write(`[harness] non-fatal load error in ${filename}: `
                             + err.message + '\n');
    }
}
loadScript('PathScripts.js');
loadScript('Completionprediction.js');

// Internal functions are wrapped in an IIFE; reach them via the
// _internals debug export.
const calls = vm.runInContext(
    'window.CompletionPrediction._internals', sandbox);

// For each activity in the fixture, classify it and emit the
// (kind, max_frac).  The recovery diff focuses on this deterministic
// classification + lag conversion, which is the part of buildCrashOptions
// that's purely a function of node fields (no DAG dependency).
const out = {
    classifications: {},
    lag_hours: {},
};

for (const node of fixture.nodes || []) {
    const profile = calls.classifyCrashProfile(
        node.Name, node.SupplierType || node.supplierType);
    out.classifications[String(node.ID)] = {
        kind: profile.kind,
        max_frac: profile.maxFrac,
        normalized_pct: calls.normalizePercentComplete(node.PercentComplete),
        planned_hrs: calls.convertToHours(node.Duration, node.TimeUnits),
    };
}

for (const link of fixture.links || []) {
    const id = `${link.source}->${link.target}`;
    out.lag_hours[id] = calls.getLagInHours(link);
}

process.stdout.write(JSON.stringify(out, null, 2));
