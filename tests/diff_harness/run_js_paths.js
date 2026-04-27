#!/usr/bin/env node
/*
 * tests/diff_harness/run_js_paths.js
 *
 * Loads Reference/PathScripts.js inside a stubbed browser context and
 * runs the path-analysis algorithms on a JSON fixture.  Emits JSON
 * results on stdout for tests/test_paths_diff.py to compare against
 * the Python implementations in paths/.
 *
 * Fixture shape:
 *   {
 *     "nodes": [{"ID": "A", "Duration": 10, "TimeUnits": "Hours"}, ...],
 *     "links": [{"source": "A", "target": "B", "type": "FS", "lag": 0}, ...],
 *     "start_id": "A",
 *     "end_id": "E",
 *     "max_paths": 200       (optional)
 *   }
 *
 * Usage: node run_js_paths.js fixture.json > js_out.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

if (process.argv.length < 3) {
    console.error('Usage: node run_js_paths.js <fixture.json>');
    process.exit(2);
}

const fixturePath = process.argv[2];
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// -----------------------------------------------------------------------
// Stubbed browser context (mirrors run_js_evm.js).  All console output
// goes to stderr so stdout stays a clean JSON document.
// -----------------------------------------------------------------------

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
        style: {},
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        appendChild: () => {}, removeChild: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
    }),
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
    readyState: 'complete',
};
sandbox.Chart = function () { return { destroy: () => {} }; };
sandbox.Chart.getChart = () => null;

// PathScripts reads window.cybereumState in many places; provide a clean slate.
sandbox.window.cybereumState = {};
sandbox.window.cybereumConfig = {
    // Force the legacy enumerator (not the cybDG_* driving-graph fallback)
    // when comparing findAllPaths -- driving graph is tested separately.
    paths: { useDrivingGraph: false, selectionMode: 'raw' },
};

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

// -----------------------------------------------------------------------
// Build nodeMap / succMap / predMap the way PathScripts expects them.
// -----------------------------------------------------------------------

const nodes = fixture.nodes;
const links = fixture.links || [];
const startId = String(fixture.start_id);
const endId = String(fixture.end_id);
const maxPaths = fixture.max_paths || 1000;

const calls = vm.runInContext(
    '({ findAllPaths, findDistancesToStart, findDistancesToEnd, '
    + 'extractDrivingGraphPathsFromCPM, getPredSuccMap, calculateCPMDates, '
    + 'getNodeDurationHours })',
    sandbox);

// Disable the structural-diversity post-filter for findAllPaths so the
// raw enumeration sets match what the Python exact-path enumerator
// returns.  Without this, large DAGs pass through the JS independent /
// outlier selectors which apply non-deterministic tie-breaking.
sandbox.window.cybereumConfig.paths.selectionMode = 'raw';
// And turn the structural-diversity feature flag off for parity.
vm.runInContext(
    'try { ENABLE_STRUCTURAL_DIVERSITY_SELECTION = false; } catch (e) {}',
    sandbox);

// Build maps via the JS helper to avoid drift.
const maps = calls.getPredSuccMap(nodes, links);

// findDistancesToStart/End call ``buildPredecessorMap`` / ``buildSuccessorMap``
// (defined in another JS file in the main app, not in PathScripts.js) when
// ``window.cybereumState.predMap`` / ``.succMap`` aren't populated.  Populate
// them up-front so the distance helpers run without ReferenceError.
sandbox.window.cybereumState.nodeMap = maps.nodeMap;
sandbox.window.cybereumState.predMap = maps.predMap;
sandbox.window.cybereumState.succMap = maps.succMap;

// findAllPaths(startNode, endNode, links, nodes, includeDurations,
//              nodeMap, succMap, predMap)
const startNode = maps.nodeMap.get(startId);
const endNode = maps.nodeMap.get(endId);

// -----------------------------------------------------------------------
// 1. findAllPaths (raw enumeration, no diversity selection).
// -----------------------------------------------------------------------
let pathsResult = null;
let pathsErr = null;
try {
    const r = calls.findAllPaths(
        startNode, endNode, links, nodes, /*includeDurations*/ true,
        maps.nodeMap, maps.succMap, maps.predMap);
    if (Array.isArray(r)) {
        pathsResult = {
            paths: r.map(p => p.map(n => String(n.ID))),
            durations: [],
        };
    } else if (r && Array.isArray(r.paths)) {
        pathsResult = {
            paths: r.paths.map(p => p.map(n => String(n.ID))),
            durations: r.durations || [],
        };
    } else {
        pathsResult = { paths: [], durations: [] };
    }
    // Honour the fixture's max_paths cap so the JS side matches Python's
    // find_all_paths(max_paths=...) truncation.  PathScripts.findAllPaths
    // has no maxPaths parameter (it caps at MAX_PATHS_TO_RETURN=10000), so
    // we clip post-hoc.
    if (Number.isFinite(maxPaths) && pathsResult.paths.length > maxPaths) {
        pathsResult.paths = pathsResult.paths.slice(0, maxPaths);
        if (pathsResult.durations.length > maxPaths) {
            pathsResult.durations = pathsResult.durations.slice(0, maxPaths);
        }
    }
} catch (err) {
    pathsErr = err.message;
}

// -----------------------------------------------------------------------
// 2. findDistancesToStart / findDistancesToEnd
// -----------------------------------------------------------------------
function mapToObj(m) {
    const out = {};
    if (!m) return out;
    if (m instanceof Map) {
        for (const [k, v] of m.entries()) {
            // JS uses Infinity / -Infinity for unreachable; convert to null
            // for symmetric JSON comparison with Python's coercion.
            const num = (typeof v === 'number' && isFinite(v)) ? v : null;
            out[String(k)] = num;
        }
    }
    return out;
}

let distStart = null;
let distStartErr = null;
try {
    const ds = calls.findDistancesToStart(startNode, links, nodes);
    distStart = {
        shortest: mapToObj(ds.shortestDistances),
        longest:  mapToObj(ds.longestDistances),
    };
} catch (err) {
    distStartErr = err.message;
}

let distEnd = null;
let distEndErr = null;
try {
    const de = calls.findDistancesToEnd(startNode, endNode, links, nodes);
    distEnd = {
        shortest: mapToObj(de.shortestDistances),
        longest:  mapToObj(de.longestDistances),
    };
} catch (err) {
    distEndErr = err.message;
}

// -----------------------------------------------------------------------
// 3. extractDrivingGraphPathsFromCPM -- critical chains only.
// -----------------------------------------------------------------------
let driving = null;
let drivingErr = null;
try {
    const dg = calls.extractDrivingGraphPathsFromCPM(
        startNode, endNode, nodes, links, maps.nodeMap, maps.succMap, maps.predMap,
        // Force "raw" so we get all critical+near-critical without Jaccard pruning,
        // mirroring how the Python test compares full chain sets.
        { selectionMode: 'raw' });
    const cpm = sandbox.window.cybereumState.drivingGraphExplainability?.cpm || {};
    driving = {
        // dg.paths is the merged + selected set (raw mode = candidates).
        paths: (dg.paths || []).map(p => p.map(n => String(n.ID))),
        active_node_count: dg.drivingGraph?.activeNodeCount || 0,
        project_finish_hours: dg.drivingGraph?.projectFinish || 0,
        critical_chain_count: dg.drivingGraph?.criticalChainCount || 0,
        near_critical_chain_count: dg.drivingGraph?.nearCriticalChainCount || 0,
        es: cpm.ES || {},
        ef: cpm.EF || {},
        tf: cpm.TF || {},
    };
} catch (err) {
    drivingErr = err.message;
}

// -----------------------------------------------------------------------
// 4. CPM scalars from calculateCPMDates -- exposes ES/EF/LS/LF/TF for
//    direct numerical comparison with solver.dag.run_cpm output.
// -----------------------------------------------------------------------
let cpm = null;
let cpmErr = null;
try {
    const r = calls.calculateCPMDates(maps.nodeMap, maps.succMap, maps.predMap);
    cpm = {
        ES: mapToObj(r.earliestStart),
        EF: mapToObj(r.earliestFinish),
        LS: mapToObj(r.latestStart),
        LF: mapToObj(r.latestFinish),
        project_finish: r.projectFinish,
    };
} catch (err) {
    cpmErr = err.message;
}

// -----------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------
process.stdout.write(JSON.stringify({
    start_id: startId,
    end_id: endId,
    paths: pathsResult,
    paths_error: pathsErr,
    distances_to_start: distStart,
    distances_to_start_error: distStartErr,
    distances_to_end: distEnd,
    distances_to_end_error: distEndErr,
    driving: driving,
    driving_error: drivingErr,
    cpm: cpm,
    cpm_error: cpmErr,
}, null, 2));
process.stdout.write('\n');
