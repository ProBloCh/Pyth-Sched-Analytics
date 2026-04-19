#!/usr/bin/env node
/*
 * tests/diff_harness/run_js_telemetry.js
 *
 * Loads Completionprediction.js AND EVM.js in a stubbed sandbox and
 * exercises both telemetry helpers (_recordTelemetry from
 * Completionprediction.js, _evmRecordTelemetry from EVM.js) on the
 * shared window.cybereumState.completionPredictionTelemetry object.
 * Emits the result on stdout so the Python test can assert counter
 * semantics and cross-module sharing.
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
loadScript('EVM.js');

// Drive both telemetry helpers.  _evmRecordTelemetry is a top-level
// function in EVM.js so it lands on the sandbox global; _recordTelemetry
// lives inside Completionprediction.js's IIFE and is reached via the
// _internals debug export.  Both write to the same shared
// window.cybereumState.completionPredictionTelemetry object, so the
// aggregate counters reflect usage from either side.
vm.runInContext(`
    const rec = window.CompletionPrediction._internals._recordTelemetry;
    rec('monte_carlo', 'call');
    rec('monte_carlo', 'call');
    rec('monte_carlo', 'success');
    rec('recovery', 'call');
    rec('recovery', 'fallback', { reason: 'non_ok_status', status: 500 });
    rec('reference_classes', 'fallback', { reason: 'backend_disabled' });

    // EVM side: _evmRecordTelemetry writes under the 'evm' service key.
    _evmRecordTelemetry('call');
    _evmRecordTelemetry('success');
    _evmRecordTelemetry('fallback', { reason: 'timeout',
                                      message: 'aborted after 15s' });
`, sandbox);

process.stdout.write(JSON.stringify(
    sandbox.window.cybereumState.completionPredictionTelemetry, null, 2));
