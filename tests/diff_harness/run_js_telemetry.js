#!/usr/bin/env node
/*
 * tests/diff_harness/run_js_telemetry.js
 *
 * Loads Completionprediction.js in the same stubbed sandbox used by
 * run_js_recovery.js and exercises the _recordTelemetry helper via
 * the _internals debug export.  Emits the resulting
 * window.cybereumState.completionPredictionTelemetry object on stdout
 * so the Python test can assert counter semantics.
 *
 * Usage: node run_js_telemetry.js > out.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const stderrConsole = {
    log:   (...a) => process.stderr.write('[js] ' + a.join(' ') + '\n'),
    info:  (...a) => process.stderr.write('[js] ' + a.join(' ') + '\n'),
    warn:  (...a) => process.stderr.write('[js] ' + a.join(' ') + '\n'),
    error: (...a) => process.stderr.write('[js] ' + a.join(' ') + '\n'),
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
sandbox.window.cybereumState = {};

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

// Drive the telemetry helper through all three code paths.
vm.runInContext(`
    const rec = window.CompletionPrediction._internals._recordTelemetry;
    rec('monte_carlo', 'call');
    rec('monte_carlo', 'call');
    rec('monte_carlo', 'success');
    rec('recovery', 'call');
    rec('recovery', 'fallback', { reason: 'non_ok_status', status: 500 });
    rec('reference_classes', 'fallback', { reason: 'backend_disabled' });
`, sandbox);

process.stdout.write(JSON.stringify(
    sandbox.window.cybereumState.completionPredictionTelemetry, null, 2));
