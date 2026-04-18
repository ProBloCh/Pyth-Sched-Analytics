#!/usr/bin/env node
/*
 * tests/diff_harness/run_js_evm.js
 *
 * Loads the pure-math functions from Reference/PathScripts.js and
 * Reference/EVM.js inside a stubbed browser-like context and runs them
 * on a JSON fixture passed via argv.  Emits the resulting EVM scalar
 * metrics as JSON on stdout.
 *
 * Used by tests/test_evm_diff.py to verify byte-for-byte parity
 * between the JS reference implementation and the Python port.
 *
 * Usage: node run_js_evm.js fixture.json > js_out.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

if (process.argv.length < 3) {
    console.error('Usage: node run_js_evm.js <fixture.json>');
    process.exit(2);
}

const fixturePath = process.argv[2];
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// -----------------------------------------------------------------------
// Stubbed browser context (window/document/Chart/etc.) so the JS files
// load without throwing.  The functions we exercise are pure and don't
// touch the DOM, but the file-level globals reference window.
// -----------------------------------------------------------------------

// Send all console output to stderr so stdout stays a clean JSON document.
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
    fetch: undefined,             // disable async wrapper paths
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

// Some files reference cybereumState
sandbox.window.cybereumState = fixture.cybereumState || {};

vm.createContext(sandbox);

// -----------------------------------------------------------------------
// Load the JS files in dependency order.  PathScripts.js first
// (provides convertToHours, differenceInCalendarDays, etc.) then EVM.js.
// -----------------------------------------------------------------------

const REF_DIR = path.resolve(__dirname, '..', '..', 'Reference');

function loadScript(filename) {
    const fullPath = path.join(REF_DIR, filename);
    const code = fs.readFileSync(fullPath, 'utf8');
    try {
        vm.runInContext(code, sandbox, { filename });
    } catch (err) {
        // Many files have top-level DOMContentLoaded calls or other
        // browser-only side-effects; ignore them as long as the function
        // declarations are now in the sandbox.
        process.stderr.write(`[harness] non-fatal load error in ${filename}: `
                             + err.message + '\n');
    }
}

loadScript('PathScripts.js');
loadScript('EVM.js');

// -----------------------------------------------------------------------
// Run the pure functions on the fixture.
// -----------------------------------------------------------------------

const nodes = fixture.nodes;
const links = fixture.links || [];
const opts = fixture.options || {};
const statusDate = new Date(opts.statusDate || '2025-01-01T00:00:00Z');
const costRate = +opts.costRate || 1;
const currency = opts.currency || 'USD';

// Sync the calendar from fixture's cybereumState.teamCalendar
sandbox.window.cybereumState.dataDate = statusDate;
sandbox.window.cybereumState.project = opts.project || sandbox.window.cybereumState.project;
const calendar = opts.calendar || {
    hoursPerDay: opts.hoursPerDay || 8,
    workingDays: [1, 2, 3, 4, 5],
    holidays: [],
};
sandbox.window.cybereumState.teamCalendar = calendar;

// EVM.js _evmGetWorkingDaySet and _evmGetHolidaySet read these globals
// directly (not from cybereumState) -- populate them so the working-day
// and holiday-skipping arithmetic in addDurationToDate matches what the
// fixture specifies.  Without this, the JS defaults (Mon-Fri, empty
// holiday set) would apply and the diff would miss holiday-induced shifts.
sandbox.window.DEFAULT_WORKING_DAYS = Array.isArray(calendar.workingDays)
    ? calendar.workingDays.slice() : [1, 2, 3, 4, 5];
sandbox.window.WORKING_DAY_SET = new Set(sandbox.window.DEFAULT_WORKING_DAYS);

function _dateKey(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return null;
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
const holidayKeys = new Set();
for (const h of (calendar.holidays || [])) {
    const key = (typeof h === 'string' && h.length === 10) ? h
              : _dateKey(h && h.date ? h.date : h);
    if (key) holidayKeys.add(key);
}
sandbox.window.HOLIDAY_SET = holidayKeys;

// Update CONFIG (used by convertToHours)
if (sandbox.CONFIG) {
    sandbox.CONFIG.WORKING_HOURS_PER_DAY = opts.hoursPerDay || 8;
    sandbox.CONFIG.WORKING_DAYS_PER_WEEK = opts.workingDaysPerWeek || 5;
}

// Helper: extract pure scalars + key distribution lengths for diff
const calls = vm.runInContext('({' +
    'calculateBCWS_Hours,' +
    'calculateBCWP_Hours,' +
    'calculateACWP,' +
    'calculateACWP_Hours,' +
    'calculateBAC_Hours,' +
    'calculateForecastedBCWP,' +
    'calculateForecastedACWP,' +
    'calculateForecastedACWP_Hours,' +
    'calculateEVMetrics,' +
    'calculateEAC,' +
    'calculateDurationWeightedProgress,' +
    'getSectorScheduleOverrun,' +
    'computeScheduleDelayImproved,' +
    'findLastActiveActivities,' +
    'normalizePercentComplete,' +
    'autoCompleteStartMilestone,' +
    'createNodeMap,' +
    'buildPredecessorMap,' +
    'updatePredictedValues_Improved,' +
    'calculateTimePhasedEV,' +
    'convertToHours,' +
    'differenceInCalendarDays,' +
    'safeDate,' +
    'formatDateLocal' +
    '})', sandbox);

// Apply auto-complete-start-milestone (FIX #9) like the engine does
calls.autoCompleteStartMilestone(nodes);

// === Forecasted branch (mirrors fixed getCumulativeDistribution flow) ===
const totalPlanned = calls.calculateBAC_Hours(nodes);
const BAC_f = totalPlanned * costRate;
const BCWS_f_h = calls.calculateForecastedBCWP(nodes, statusDate);
const BCWP_f_h = calls.calculateBCWP_Hours(nodes);
const BCWS_f = BCWS_f_h * costRate;
const BCWP_f = BCWP_f_h * costRate;
// Bug-fixed: NO double multiplication
const ACWP_f = calls.calculateForecastedACWP(nodes, statusDate);
const m_f = calls.calculateEVMetrics(BCWP_f, ACWP_f, BCWS_f);
const pct_f = BAC_f > 0 ? (BCWP_f / BAC_f) * 100 : 0;
const EAC_f = calls.calculateEAC(BAC_f, m_f.CPIcum_model, m_f.SPI_model, pct_f);

// === Actual branch (mirrors createActualEVMChart flow) ===
const BCWS_a_h = calls.calculateBCWS_Hours(nodes, statusDate);
const BCWP_a_h = calls.calculateBCWP_Hours(nodes);
const BAC_a_h = calls.calculateBAC_Hours(nodes);
const BCWS_a = BCWS_a_h * costRate;
const BCWP_a = BCWP_a_h * costRate;
const BAC_a = BAC_a_h * costRate;
const ACWP_a = calls.calculateACWP(nodes, costRate, true, statusDate);
const m_a = calls.calculateEVMetrics(BCWP_a, ACWP_a, BCWS_a);
const pct_a = BAC_a > 0 ? (BCWP_a / BAC_a) * 100 : 0;
const EAC_a = calls.calculateEAC(BAC_a, m_a.CPIcum_model, m_a.SPI_model, pct_a);
const dw = calls.calculateDurationWeightedProgress(nodes, statusDate);
const sectorOverrun = calls.getSectorScheduleOverrun(opts.project || {});

// Find latest planned/forecasted ends
let plannedEnd = null, forecastedEnd = null;
for (const n of nodes) {
    const pe = n.Finish && new Date(n.Finish);
    const fe = (n.riskAdjustedEnd || n.Finish) && new Date(n.riskAdjustedEnd || n.Finish);
    if (pe && (!plannedEnd || pe > plannedEnd)) plannedEnd = pe;
    if (fe && (!forecastedEnd || fe > forecastedEnd)) forecastedEnd = fe;
}
const sd = calls.computeScheduleDelayImproved(
    statusDate, plannedEnd, forecastedEnd,
    m_a.SPI_model, sectorOverrun, nodes);

// Frontier nodes (matching engine semantics)
const nodeMap = calls.createNodeMap(nodes);
const succMap = new Map();
for (const link of links) {
    const src = String(link.source);
    if (!succMap.has(src)) succMap.set(src, []);
    succMap.get(src).push(link);
}
const frontierNodeObjs = calls.findLastActiveActivities(nodes, succMap, nodeMap);
const frontier = frontierNodeObjs.map(n => String(n.ID || n));

// Predicted-date propagation (mutates nodes in place)
calls.updatePredictedValues_Improved(
    nodes, statusDate,
    sd.scheduleMultiplier, sd.slipDays, sd.performanceDelta,
    links, nodeMap, frontierNodeObjs);

// Time-phased EV at status date (sample point for diff)
const evAtStatus = calls.calculateTimePhasedEV(nodes, statusDate, statusDate);

// === Forecasted cumulative + period distributions =====================
// Mirrors the JS getCumulativeDistribution daily-iteration algorithm
// (EVM.js lines 1682-1730).  Inlined here (not called directly) so the
// harness stays DOM-free and doesn't depend on evmMetrics globals.
function _buildForecastedDistributions(nodes, costRate) {
    const workingNodes = [...nodes].sort(
        (a, b) => parseInt(a.ID) - parseInt(b.ID));
    const startNode = workingNodes.find(n => n.ID === '0') || workingNodes[0];
    const endNode = workingNodes.reduce(
        (a, b) => (Number(a.ID) > Number(b.ID)) ? a : b);
    const startDate = calls.safeDate(workingNodes[0].Start);
    const endDate = calls.safeDate(endNode.riskAdjustedEnd || endNode.Finish);
    const plannedEndDate = calls.safeDate(endNode.Finish);
    if (!startDate || !endDate) return null;

    // Collect significant comparison dates.
    const dateSet = new Set();
    workingNodes.forEach(n => {
        [n.Start, n.riskAdjustedStart, n.Finish, n.riskAdjustedEnd].forEach(d => {
            const dt = calls.safeDate(d);
            if (dt) dateSet.add(calls.formatDateLocal(dt));
        });
    });
    const compDateSet = new Set(dateSet);

    // Pre-cache per-node daily rates.
    const nodeDailyRates = new Map();
    workingNodes.forEach(node => {
        if (node.Duration === 0 || node.Duration === '0') return;
        const taskStart = calls.safeDate(node.Start);
        const taskEnd   = calls.safeDate(node.Finish);
        const riskStart = calls.safeDate(node.riskAdjustedStart || node.Start);
        const riskEnd   = calls.safeDate(node.riskAdjustedEnd || node.Finish);
        if (!taskStart || !taskEnd || !riskStart || !riskEnd) return;
        const plannedDays = Math.max(
            1, calls.differenceInCalendarDays(taskEnd, taskStart));
        const riskDays = Math.max(
            1, calls.differenceInCalendarDays(riskEnd, riskStart));
        const plannedHours = calls.convertToHours(
            node.Duration, node.TimeUnits || 'Hours');
        const riskHours = calls.convertToHours(
            node.riskAdjustedDuration || node.Duration, node.TimeUnits || 'Hours');
        nodeDailyRates.set(node.ID, {
            plannedDaily: plannedHours / plannedDays,
            riskDaily:    riskHours / riskDays,
            evDaily:      plannedHours / riskDays,
            taskStart, taskEnd, riskStart, riskEnd,
        });
    });

    const dist = { planned: [], withOverrun: [], ev: [],
                   nonCumPlanned: [], nonCumOverrun: [], nonCumEv: [] };
    let cumHours = 0, cumOverrun = 0, cumEv = 0;
    let currentDate = new Date(startDate);

    while (currentDate <= endDate) {
        let dailyPlanned = 0, dailyOverrun = 0, dailyEv = 0;
        nodeDailyRates.forEach(r => {
            if (r.taskStart <= currentDate && currentDate <= r.taskEnd) {
                dailyPlanned += r.plannedDaily;
            }
            if (r.riskStart <= currentDate && currentDate <= r.riskEnd) {
                dailyOverrun += r.riskDaily;
                dailyEv      += r.evDaily;
            }
        });
        cumHours += dailyPlanned;
        cumOverrun += dailyOverrun;
        cumEv += dailyEv;
        const dateStr = calls.formatDateLocal(currentDate);
        if (compDateSet.has(dateStr)) {
            if (currentDate <= plannedEndDate) {
                dist.planned.push({ date: dateStr, hours: cumHours });
            }
            dist.withOverrun.push({ date: dateStr, hours: cumOverrun });
            dist.ev.push({ date: dateStr, hours: cumEv });
            dist.nonCumPlanned.push({ date: dateStr, hours: dailyPlanned });
            dist.nonCumOverrun.push({ date: dateStr, hours: dailyOverrun });
            dist.nonCumEv.push({ date: dateStr, hours: dailyEv });
        }
        currentDate.setDate(currentDate.getDate() + 1);
    }
    return dist;
}

const forecastedDist = _buildForecastedDistributions(nodes, costRate);

// Helper to make values JSON-safe (Infinity -> null, NaN -> null)
function safe(v) {
    if (typeof v === 'number') {
        if (!isFinite(v)) return null;
        return v;
    }
    return v;
}

const out = {
    forecasted: {
        BCWS: safe(BCWS_f), BCWP: safe(BCWP_f), ACWP: safe(ACWP_f),
        BAC:  safe(BAC_f),  EAC:  safe(EAC_f),
        BCWS_hours: safe(BCWS_f_h), BCWP_hours: safe(BCWP_f_h),
        BAC_hours:  safe(totalPlanned),
        SV: safe(m_f.SV), CV: safe(m_f.CV),
        SPI: safe(m_f.SPI), SPI_model: safe(m_f.SPI_model),
        CPIcum: safe(m_f.CPIcum), CPIcum_model: safe(m_f.CPIcum_model),
        percentComplete: safe(pct_f),
    },
    actual: {
        BCWS: safe(BCWS_a), BCWP: safe(BCWP_a), ACWP: safe(ACWP_a),
        BAC:  safe(BAC_a),  EAC:  safe(EAC_a),
        BCWS_hours: safe(BCWS_a_h), BCWP_hours: safe(BCWP_a_h),
        BAC_hours:  safe(BAC_a_h),
        SV: safe(m_a.SV), CV: safe(m_a.CV),
        SPI: safe(m_a.SPI), SPI_model: safe(m_a.SPI_model),
        CPIcum: safe(m_a.CPIcum), CPIcum_model: safe(m_a.CPIcum_model),
        percentComplete: safe(pct_a),
        sectorScheduleOverrun: safe(sectorOverrun),
        scheduleMultiplier:    safe(sd.scheduleMultiplier),
        slipDays:              safe(sd.slipDays),
        performanceDelta:      safe(sd.performanceDelta),
        actualDelayFactor:     safe(sd.actualDelayFactor),
        forecastedDelayFactor: safe(sd.forecastedDelayFactor),
        durationWeightedProgress: {
            plannedProgressPct:   safe(dw.plannedProgressPct),
            actualProgressPct:    safe(dw.actualProgressPct),
            durationWeightedSPI:  safe(dw.durationWeightedSPI),
            totalPlannedHours:    safe(dw.totalPlannedHours),
            plannedCompletedHours: safe(dw.plannedCompletedHours),
            actualCompletedHours: safe(dw.actualCompletedHours),
        },
        frontierNodes: frontier,
    },
    timePhasedEvAtStatus: safe(evAtStatus),
    distributions: forecastedDist ? {
        planned:       forecastedDist.planned,
        withOverrun:   forecastedDist.withOverrun,
        ev:            forecastedDist.ev,
        nonCumPlanned: forecastedDist.nonCumPlanned,
        nonCumOverrun: forecastedDist.nonCumOverrun,
        nonCumEv:      forecastedDist.nonCumEv,
    } : null,
    predictedDates: nodes.map(n => ({
        id:                String(n.ID),
        predictedStart:    n.predictedStart instanceof Date
                           ? n.predictedStart.toISOString() : null,
        predictedEnd:      n.predictedEnd instanceof Date
                           ? n.predictedEnd.toISOString() : null,
        predictedDuration: safe(n.predictedDuration),
    })),
};

process.stdout.write(JSON.stringify(out, null, 2));
