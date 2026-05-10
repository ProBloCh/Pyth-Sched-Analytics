/**
 * ================================================================================
 * COMPLETIONPREDICTION.js v7.2 - PRODUCTION READY
 * ================================================================================
 * 
 * v7.2 ENHANCEMENTS:
 * 1. P20 (Optimistic) percentile added to Monte Carlo results
 * 2. P20 curve displayed on S-curve chart (green dashed)
 * 3. Cone of uncertainty visualization (P20-P80 range)
 * 4. Spread days calculation for forecast confidence
 * 5. Risk-weighted activity panel with TIS scoring
 * 6. Downstream impact viewer (click any activity)
 * 7. AI enrichment for both crash and risk candidates
 * 8. Click-to-mitigate with Monte Carlo recalculation
 * 
 * v7.0 CRITICAL FIXES:
 * 1. ACTUAL CURVE: Fixed calculation to use PercentComplete for in-progress activities
 *    instead of assuming 100% complete. Now correctly shows actual weighted progress.
 * 2. RECOVERY CURVE: Rebuilt to maintain proper S-curve shape instead of linear
 * 3. CSS LAYOUT: Fixed z-index and overflow to prevent panel overlap
 * 4. Added comprehensive diagnostics for curve verification
 * 
 * v6.9 FIXES:
 * - CSS z-index and overflow fixes
 * - Memory cleanup for event listeners
 * - Container-specific canvas IDs
 * - Enhanced driving chain diagnostics
 * 
 * v6.8 FIXES:
 * - Fixed risk schedule calculation for activities with ActualStart but 0% complete
 * 
 * CORE FEATURES:
 * - O(1) Date Arithmetic & O(N) Graph Traversal
 * - Monte Carlo Risk Simulation (P50/P80)
 * - Near-Critical Envelope Analysis
 * - Megaproject Recovery Optimizer (Crash + Lag Compression)
 * - Confidence Cloud Visualization
 * - Primary Delay Driver Identification
 */

(function (global) {
    'use strict';

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    const CONFIG = {
        workingHoursPerDay: 8,
        workingDaysPerWeek: 5,
        scurveSamplingDays: 1,
        chartEndBufferDays: 30,
        monteCarloEnabled: true,
        monteCarloIterations: 1500,
        monteCarloSeed: 42,
        monteCarloMaxActivities: 12000,
        // Backend Monte Carlo offload (Pyth-Sched-Analytics /completion/monte-carlo).
        // When true and the endpoint responds, the backend runs the five-tier
        // risk-distribution MC and the JS version is used only as a fallback.
        // Set to false to force the legacy in-browser MC.
        useBackendCompletion: true,
        completionEndpoint: '/completion/monte-carlo',
        completionRequestTimeoutMs: 15000,
        // Backend recovery-option offload
        // (Pyth-Sched-Analytics /completion/recovery-options).
        // Same backend-first pattern: buildCrashOptions falls through to the
        // in-browser implementation on any failure.  AI enrichment still runs
        // on the returned crash_candidates if aiEnrichmentEnabled is true.
        useBackendRecovery: true,
        recoveryEndpoint: '/completion/recovery-options',
        recoveryRequestTimeoutMs: 10000,
        // Add to CONFIG object:
        mcNoRiskBelow: 0.06,    // Below this risk score, no inflation
        mcNormalFrom: 0.18,     // Above this, use normal distribution
        mcFatTailFrom: 0.55,    // Above this, use fat-tail
        mcMinMult: 0.95,        // Minimum multiplier (allow small underruns)
        mcMaxMultBase: 2.0,     // Base cap for moderate risk
        mcMaxMultHigh: 6.0,     // Cap for high-risk, long-duration
        riskEnabled: true,
        // Risk index weights for Monte Carlo duration inflation.
        // Determines how much each risk signal contributes to the composite
        // risk index that drives simulation variability.
        //
        // Theoretical grounding:
        //   computedRisk (0.40): The enhanced composite risk score from ComputeMetrics
        //       incorporating betweenness/SSI, merge bias, eigenvector centrality,
        //       and slack deficit (Vanhoucke 2010, Elshaer 2013, Williams 1992).
        //       Reduced from 0.45 — the other signals now carry improved information.
        //   overrunProb (0.30): Path-weighted overrun probability from critical and
        //       near-critical path analysis. Increased from 0.25 — Batselier &
        //       Vanhoucke (2017) showed path-based forecasting outperforms
        //       activity-level alone.
        //   outlier (0.15): Whether the activity sits on an outlier (near-critical)
        //       path. These paths frequently become critical under perturbation
        //       (Vanhoucke 2010).
        //   corrAbs (0.15): Absolute correlation with project end date from
        //       reference-class analysis. Captures empirical sensitivity that
        //       structural metrics may miss (Flyvbjerg 2014).
        riskIndexWeights: {
            computedRisk: 0.40,
            overrunProb: 0.30,
            outlier: 0.15,
            corrAbs: 0.15
        },
        p50BaseUplift: 0.05,
        p50MaxUplift: 0.20,
        p80BaseUplift: 0.12,
        p80MaxUplift: 0.45,
        activeRiskDampening: 0.6,
        estimatePctFromElapsedWhenZero: true,
        relaxationMaxIterations: 10,
        scopeMaxNodes: 8000,
        scopeFloatEnvelopeDays: 30,
        scopeTopRiskNodes: 400,
        scopeTopImportanceNodes: 250,
        maxRecoveryOptions: 18,
        maxLagOptions: 10,
        minCrashableHours: 16,
        maxCrashFractionDefault: 0.25,
        maxRiskBufferDaysForRecovery: 10,
        maxCurveSamplePoints: 500,
        minLagDaysForCompression: 2,
        // Recovery scenario parameters
        lagCompressionFactor: 0.5,
        lagUsesWorkingCalendar: true,
        scenarioNearCriticalDays: 30,
        floatHoursThreshold: 200,
        minCompressionFactor: 0.3,
        // Date bounds to prevent Chart.js overflow
        minValidYear: 1990,
        maxValidYear: 2100,
        maxWorkingHoursToAdd: 100000,
        // AI Enrichment Settings
        aiEnrichmentEnabled: true,              // Master toggle
        aiEnrichmentEndpoint: '/OpenAI/EnrichCrashCandidates',
        riskEnrichmentEndpoint: '/OpenAI/EnrichRiskCandidates',
        aiEnrichmentTimeoutMs: 8000,            // 8 second timeout
        riskEnrichmentTimeoutMs: 12000,         // 12 second timeout
        aiEnrichmentMaxCandidates: 25,          // Max to send to AI
        aiEnrichmentMinRemainingDays: 3,        // Don't enrich tiny activities
        // Risk-weighted candidates
        maxRiskCandidates: 12,
        minRiskScoreForCandidate: 0.20,
        // Cone of uncertainty confidence thresholds (spread in days)
        coneHighConfidence: 14,
        coneMediumConfidence: 45,
        coneLowConfidence: 90,
        chartColors: (function () {
            var P = (window.CybereumDesign && window.CybereumDesign.palette) || {};
            return {
                planned: P.accent || '#46b9fa',
                actual: P.success || '#50fa7b',
                expected: P.warning || '#ffb86c',
                riskP20: P.success || '#50fa7b',
                riskP50: P.yellow || '#fbbf24',
                riskP80: P.orange || '#f97316',
                riskCloud: 'rgba(251, 191, 36, 0.15)',
                recovery: P.pink || '#ff79c6',
                text: P.text1 || '#cdfaff'
            };
        })()
    };

    // =========================================================================
    // PRIVATE STATE
    // =========================================================================
    let _lastAnalysis = null;
    let _cachedWeights = null;
    let _stylesInjected = false;
    let _eventCleanups = [];
    const MS_PER_DAY = 86400000;
    const MS_PER_HOUR = 3600000;
    const EMPTY_ARRAY = Object.freeze([]);

    // Precomputed date bounds
    const MIN_VALID_DATE = new Date(CONFIG.minValidYear, 0, 1);
    const MAX_VALID_DATE = new Date(CONFIG.maxValidYear, 11, 31);
    const MIN_VALID_TIME = MIN_VALID_DATE.getTime();
    const MAX_VALID_TIME = MAX_VALID_DATE.getTime();

    // =========================================================================
    // UTILITY FUNCTIONS - O(1) OPTIMIZED
    // =========================================================================

    function parseP6DateString(s) {
        // Handles Primavera-like strings e.g. "2025-02-03 08:00" (no timezone)
        // Parse as local time to avoid browser-dependent parsing and timezone jitter.
        if (typeof s !== 'string') return null;
        const str = s.trim();
        if (!str) return null;

        // ISO strings (with T) or explicit timezone are safe to pass through.
        if (str.includes('T') || /Z$|[+-]\d\d:?\d\d$/.test(str)) {
            const dIso = new Date(str);
            return isFinite(dIso.getTime()) ? dIso : null;
        }

        const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
        if (!m) return null;

        const y = +m[1], mo = +m[2], da = +m[3];
        const hh = +(m[4] || 0), mm = +(m[5] || 0), ss = +(m[6] || 0);

        // Construct as local time.
        const d = new Date(y, mo - 1, da, hh, mm, ss, 0);
        return isFinite(d.getTime()) ? d : null;
    }

    function safeDate(dateInput) {
        if (!dateInput) return null;

        let d = null;
        if (dateInput instanceof Date) {
            d = dateInput;
        } else if (typeof dateInput === 'number') {
            d = new Date(dateInput);
        } else {
            d = parseP6DateString(dateInput) || new Date(dateInput);
        }

        const t = d.getTime();
        if (!isFinite(t)) return null;

        if (t < MIN_VALID_TIME || t > MAX_VALID_TIME) {
            console.warn(`[CompletionPrediction] Date out of bounds: ${d.toISOString?.() || String(d)}, clamping to valid range`);
            if (t < MIN_VALID_TIME) return new Date(MIN_VALID_DATE);
            if (t > MAX_VALID_TIME) return new Date(MAX_VALID_DATE);
        }

        return d;
    }

    const toDate = safeDate;

    function clampDate(date) {
        if (!date) return null;
        const t = date.getTime();
        if (!isFinite(t)) return null;
        if (t < MIN_VALID_TIME) return new Date(MIN_VALID_DATE);
        if (t > MAX_VALID_TIME) return new Date(MAX_VALID_DATE);
        return date;
    }

    function isValidDate(date) {
        if (!date) return false;
        const t = date.getTime();
        return isFinite(t) && t >= MIN_VALID_TIME && t <= MAX_VALID_TIME;
    }

    function maxDate(a, b) {
        if (!a) return b;
        if (!b) return a;
        return a > b ? a : b;
    }

    function clamp(v, lo, hi) {
        return v < lo ? lo : v > hi ? hi : v;
    }

    function clamp01(v) {
        return v < 0 ? 0 : v > 1 ? 1 : v;
    }
    // Apply compound risk amplification when multiple external signal types converge
    function applyCompoundAmplification(externalRisk, compoundAnalysis) {
        if (compoundAnalysis && compoundAnalysis.hasCompoundRisk && externalRisk > 0) {
            return clamp01(externalRisk * compoundAnalysis.amplification);
        }
        return externalRisk;
    }
    // FIX #2: Holiday support — format date as 'YYYY-MM-DD' for holiday Set lookup
    // Matches EVM.js _evmDateKey() format.
    function _dateKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    // Cached holiday set for the current analysis run. Rebuilt once per analyze() call.
    let _holidaySet = null;

    function _getHolidaySet() {
        if (_holidaySet instanceof Set) return _holidaySet;
        // Use window.HOLIDAY_SET populated by P6/MSP import, or build from teamCalendar
        if (typeof window !== 'undefined' && window.HOLIDAY_SET instanceof Set && window.HOLIDAY_SET.size > 0) {
            _holidaySet = window.HOLIDAY_SET;
            return _holidaySet;
        }
        const holidays = window.cybereumState?.teamCalendar?.holidays;
        if (Array.isArray(holidays) && holidays.length > 0) {
            _holidaySet = new Set(holidays.map(h => {
                const d = safeDate(h.date || h);
                return d ? _dateKey(d) : null;
            }).filter(Boolean));
            return _holidaySet;
        }
        _holidaySet = new Set();
        return _holidaySet;
    }

    function _isWorkingDay(d, holidays) {
        const dow = d.getDay();
        if (dow === 0 || dow === 6) return false; // weekend
        if (holidays && holidays.size > 0 && holidays.has(_dateKey(d))) return false;
        return true;
    }

    function _normalizeWeekendForward(d) {
        const dow = d.getDay();
        if (dow === 6) d.setDate(d.getDate() + 2);
        else if (dow === 0) d.setDate(d.getDate() + 1);
        return d;
    }

    function _normalizeWeekendBackward(d) {
        const dow = d.getDay();
        if (dow === 6) d.setDate(d.getDate() - 1);
        else if (dow === 0) d.setDate(d.getDate() - 2);
        return d;
    }

    function _addWorkdaysO1(date, workdays) {
        const d = new Date(date);
        let days = Math.floor(workdays);
        if (days <= 0) { _normalizeWeekendForward(d); return d; }

        const holidays = _getHolidaySet();

        // FIX #2: When holidays exist, fall back to day-by-day iteration
        // so holidays are properly skipped. Keep O(1) fast path when no holidays.
        if (holidays.size > 0) {
            // Normalize start to a working day first (consistent with O(1) path)
            while (!_isWorkingDay(d, holidays)) d.setDate(d.getDate() + 1);
            let added = 0;
            while (added < days) {
                d.setDate(d.getDate() + 1);
                if (_isWorkingDay(d, holidays)) added++;
            }
            return d;
        }

        // Fast O(1) path — no holidays, just skip weekends
        _normalizeWeekendForward(d);
        const fullWeeks = Math.floor(days / 5);
        if (fullWeeks) {
            d.setDate(d.getDate() + fullWeeks * 7);
            days -= fullWeeks * 5;
        }

        if (days) {
            const dow = d.getDay(); // Mon=1..Fri=5
            const left = 5 - dow;
            if (days <= left) d.setDate(d.getDate() + days);
            else d.setDate(d.getDate() + days + 2);
        }

        return _normalizeWeekendForward(d);
    }

    function _subWorkdaysO1(date, workdays) {
        const d = new Date(date);
        let days = Math.floor(workdays);
        if (days <= 0) { _normalizeWeekendBackward(d); return d; }

        const holidays = _getHolidaySet();

        // FIX #2: When holidays exist, fall back to day-by-day iteration
        if (holidays.size > 0) {
            // Normalize start to a working day first (consistent with O(1) path)
            while (!_isWorkingDay(d, holidays)) d.setDate(d.getDate() - 1);
            let subtracted = 0;
            while (subtracted < days) {
                d.setDate(d.getDate() - 1);
                if (_isWorkingDay(d, holidays)) subtracted++;
            }
            return d;
        }

        // Fast O(1) path — no holidays, just skip weekends
        _normalizeWeekendBackward(d);
        const fullWeeks = Math.floor(days / 5);
        if (fullWeeks) {
            d.setDate(d.getDate() - fullWeeks * 7);
            days -= fullWeeks * 5;
        }

        if (days) {
            const dow = d.getDay(); // Mon=1..Fri=5
            const sinceMon = dow - 1;
            if (days <= sinceMon) d.setDate(d.getDate() - days);
            else d.setDate(d.getDate() - (days + 2));
        }

        return _normalizeWeekendBackward(d);
    }

    function addWorkingHours(date, hours) {
        if (!date) return null;
        let h = +hours || 0;
        if (h <= 0) return new Date(date);
        if (h > CONFIG.maxWorkingHoursToAdd) h = CONFIG.maxWorkingHoursToAdd;

        const hpd = CONFIG.workingHoursPerDay;

        const wholeDays = Math.floor(h / hpd);
        const remHours = h - wholeDays * hpd;

        let d = _addWorkdaysO1(date, wholeDays);
        if (remHours) {
            d = new Date(d.getTime() + remHours * 3600_000);
            _normalizeWeekendForward(d);
            // FIX L5: After weekend normalization, also skip holidays for the
            // remainder portion. _addWorkdaysO1 handles holidays for whole days,
            // but the fractional-hour remainder only normalized for weekends.
            const holidays = _getHolidaySet();
            if (holidays.size > 0) {
                while (holidays.has(_dateKey(d))) {
                    d.setDate(d.getDate() + 1);
                    _normalizeWeekendForward(d);
                }
            }
        }
        return clampDate(d);
    }

    function subtractWorkingHours(date, hours) {
        if (!date) return null;
        let h = +hours || 0;
        if (h <= 0) return new Date(date);
        if (h > CONFIG.maxWorkingHoursToAdd) h = CONFIG.maxWorkingHoursToAdd;

        const hpd = CONFIG.workingHoursPerDay;

        const wholeDays = Math.floor(h / hpd);
        const remHours = h - wholeDays * hpd;

        let d = _subWorkdaysO1(date, wholeDays);
        if (remHours) {
            d = new Date(d.getTime() - remHours * 3600_000);
            _normalizeWeekendBackward(d);
        }
        return clampDate(d);
    }



    const addHours = addWorkingHours;

    function diffHours(a, b) {
        if (!a || !b) return 0;
        // Count working hours between two datetimes, excluding weekends/holidays
        // and prorating partial first/last days instead of counting every touched
        // working day as a full CONFIG.workingHoursPerDay.
        var start = new Date(Math.min(a, b));
        var end = new Date(Math.max(a, b));
        if (end <= start) return 0;

        var hpd = CONFIG.workingHoursPerDay;
        var holidays = _getHolidaySet();
        var hours = 0;
        var current = new Date(start.getFullYear(), start.getMonth(), start.getDate());

        while (current < end) {
            var nextDay = new Date(current);
            nextDay.setDate(nextDay.getDate() + 1);

            if (_isWorkingDay(current, holidays)) {
                var overlapStart = start > current ? start : current;
                var overlapEnd = end < nextDay ? end : nextDay;

                if (overlapEnd > overlapStart) {
                    var overlapMs = overlapEnd - overlapStart;
                    hours += hpd * (overlapMs / MS_PER_DAY);
                }
            }

            current = nextDay;
        }
        return hours;
    }

    function daysBetween(a, b) {
        if (!a || !b) return 0;
        return Math.round((b - a) / MS_PER_DAY);
    }

    function addDays(date, days) {
        if (!date) return null;
        const d = new Date(date);
        d.setDate(d.getDate() + Math.round(days));
        return clampDate(d);
    }

    function parsePercentComplete(value) {
        if (value == null) return 0;
        const p = +value;
        return isNaN(p) ? 0 : p;
    }

    function normalizePercentComplete(raw) {
        const v = parsePercentComplete(raw);
        if (!Number.isFinite(v) || v < 0) return 0;
        // FIX: Import always produces 0-100 range (P6 and MSP). Previous heuristic
        // (<=1 = decimal) misinterpreted 1% as 100%. Always divide by 100 and clamp.
        // Matches EVM.js normalizePercentComplete fix.
        return clamp(v / 100, 0, 1);
    }

    function estimatePercentFromElapsed(actualStart, statusDate, durHours) {
        if (!actualStart || !statusDate) return 0;
        const elapsedHrs = Math.max(0, (statusDate.getTime() - actualStart.getTime()) / 3600000);
        if (!isFinite(elapsedHrs) || elapsedHrs <= 0) return 0;
        // Rough working-time adjustment (avoid heavy calendar math): scale calendar hours -> working hours.
        const workingElapsedHrs = elapsedHrs * (5 / 7);
        if (!durHours || !isFinite(durHours) || durHours <= 0) return 0;
        return clamp(workingElapsedHrs / durHours, 0, 0.99);
    }

    function effectivePercentComplete(node, maps) {
        const pct = normalizePercentComplete(node?.PercentComplete);
        if (pct > 0) return pct;

        if (!CONFIG.estimatePctFromElapsedWhenZero) return pct;

        const { actualStart, actualFinish } = getSanitizedActuals(node?.ID, maps);
        if (!actualStart || actualFinish) return pct;

        const durH = convertToHours(node?.Duration, node?.TimeUnits);
        const est = estimatePercentFromElapsed(actualStart, maps.statusDate, durH);
        return est > 0 ? est : pct;
    }



    function isMilestone(node) {
        const m = node?.Milestone;
        return m === "1" || m === 1 || m === true;
    }

    function formatDate(date) {
        if (!date) return '—';
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function getLagInHours(link) {
        if (!link) return 0;
        if (typeof link.lagHrs === 'number') return Math.min(link.lagHrs, CONFIG.maxWorkingHoursToAdd);
        return convertToHours(link.lag ?? 0, link.lagUnits || link.TimeUnits || 'Hours');
    }

    function getNodePlannedStart(n) {
        return n?.Start || n?.PlannedStart || n?.EarlyStart || null;
    }

    function getNodePlannedFinish(n) {
        return n?.Finish || n?.PlannedFinish || n?.EarlyFinish || null;
    }
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
 * Capitalize first letter.
 */
    function capitalizeFirst(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /**
     * Format date in short form (Mar 15).
     */
    function formatDateShort(date) {
        if (!date) return '—';
        const d = safeDate(date);
        if (!d) return '—';
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function getConfidenceLevel(spreadDays) {
        if (spreadDays <= CONFIG.coneHighConfidence) {
            return { level: 'high', message: '🎯 High confidence — tight forecast range' };
        } else if (spreadDays <= CONFIG.coneMediumConfidence) {
            return { level: 'medium', message: '📊 Moderate uncertainty — monitor risk activities' };
        } else if (spreadDays <= CONFIG.coneLowConfidence) {
            return { level: 'low', message: '⚠️ Wide uncertainty — significant schedule risk' };
        } else {
            return { level: 'critical', message: '🚨 Critical uncertainty — schedule at high risk' };
        }
    }

    function buildConeSummaryHtml(risk) {
        if (!risk?.p20Finish || !risk?.p50Finish || !risk?.p80Finish) return '';

        const spreadDays = risk.spreadDays || Math.round((risk.p80Finish - risk.p20Finish) / (1000 * 60 * 60 * 24));
        const confidence = getConfidenceLevel(spreadDays);

        const p50Offset = Math.round((risk.p50Finish - risk.p20Finish) / (1000 * 60 * 60 * 24));
        const p50Pct = spreadDays > 0 ? Math.round((p50Offset / spreadDays) * 100) : 50;

        return `
            <div class="cp7-cone-summary">
                <div class="cp7-cone-header">
                    <strong>Forecast Range</strong>
                    <span class="cp7-cone-spread cp7-confidence-${confidence.level}">${spreadDays}d spread</span>
                </div>
                <div class="cp7-cone-bar">
                    <div class="cp7-cone-p20">P20</div>
                    <div class="cp7-cone-fill">
                        <div class="cp7-cone-p50-marker" style="left: ${p50Pct}%"></div>
                    </div>
                    <div class="cp7-cone-p80">P80</div>
                </div>
                <div class="cp7-cone-dates">
                    <span>${formatDateShort(risk.p20Finish)}</span>
                    <span class="cp7-cone-date-p50">${formatDateShort(risk.p50Finish)}</span>
                    <span>${formatDateShort(risk.p80Finish)}</span>
                </div>
                <div class="cp7-cone-interpretation">${confidence.message}</div>
            </div>
        `;
    }

    // =========================================================================
    // STATE ACQUISITION (NO MUTATION OF INPUT DATA)
    // =========================================================================

    function getStateMaps(nodes, links) {
        if (!nodes || !nodes.length) {
            console.warn('[CompletionPrediction] No nodes provided');
            return null;
        }
        if (!links) links = [];

        const cState = (typeof window !== 'undefined' ? window.cybereumState : global.cybereumState) || {};

        // Build nodeMap
        const nodeMap = new Map();
        for (const n of nodes) nodeMap.set(String(n.ID), n);

        // Always rebuild succ/pred maps from the passed links for this analysis run.
        // Cached maps in global state can become stale across imports/views and can also
        // carry non-string keys, which breaks string-ID lookups and truncates driving chain.
        const succMap = new Map();
        const predMap = new Map();
        for (const id of nodeMap.keys()) {
            succMap.set(id, []);
            predMap.set(id, []);
        }
        for (const link of links) {
            const sID = String(typeof link.source === 'object' ? link.source?.ID : link.source);
            const tID = String(typeof link.target === 'object' ? link.target?.ID : link.target);
            if (!nodeMap.has(sID) || !nodeMap.has(tID)) continue;

            const edge = {
                source: sID,
                target: tID,
                type: String(link.type || 'FS').toUpperCase(),
                lagHrs: getLagInHours(link)
            };
            succMap.get(sID).push(edge);
            predMap.get(tID).push(edge);
        }

        // Topo order + cycle flag (derived from rebuilt maps)
        const result = computeTopoOrderOptimized(nodeMap, succMap, predMap);
        const topoOrder = result.order;
        const hasCycle = !!result.hasCycle;

        const startNode = nodeMap.get(String(cState.startNode?.ID)) || findStartNode(nodes, nodeMap);
        const endNode = nodeMap.get(String(cState.endNode?.ID)) || findEndNode(nodes, succMap);

        //const maps = { nodeMap, predMap, succMap, topoOrder, hasCycle, startNode, endNode };

        // Status / data date (must be computed AFTER maps exists)
        const explicitDataDate = safeDate(cState.dataDate) || safeDate(cState.dataDateIso);
        const statusDate = explicitDataDate || inferStatusDate(nodes);

        const slackMap = buildSlackMap(cState.slackResults);

        const sanitizedDates = new Map();
        for (const n of nodes) {
            const id = String(n.ID);
            const as = safeDate(n.ActualStart);
            const af = safeDate(n.ActualFinish);
            sanitizedDates.set(id, {
                actualStart: (as && as > statusDate) ? null : as,
                actualFinish: (af && af > statusDate) ? null : af
            });
        }

        return {
            nodeMap, succMap, predMap, topoOrder, startNode, endNode,
            statusDate, slackMap, hasCycle, sanitizedDates
        };
    }


    function resolveNode(ref, nodeMap) {
        if (!ref) return null;
        if (typeof ref === 'object' && ref.ID !== undefined) return ref;
        return nodeMap.get(String(ref)) || null;
    }

    function findStartNode(nodes, nodeMap) {
        if (nodeMap.has('0')) return nodeMap.get('0');
        let best = null, bestTime = Infinity;
        for (const n of nodes) {
            const s = safeDate(n.Start) || safeDate(n.ActualStart);
            if (s && s.getTime() < bestTime) {
                best = n;
                bestTime = s.getTime();
            }
        }
        return best || nodes[0];
    }

    function findEndNode(nodes, succMap) {
        // FIX #4: Use structural detection — end node is the terminal node
        // (zero successors) with the latest planned finish. The old max-numeric-ID
        // heuristic breaks when activities are added after the end milestone or
        // when IDs are non-sequential (e.g., WBS-based "3.2.1.5").
        let best = null, bestFinish = -Infinity;
        for (const n of nodes) {
            const id = String(n.ID);
            const succs = succMap?.get(id);
            if (succs && succs.length > 0) continue; // has successors, not terminal
            const f = safeDate(n.Finish)?.getTime() || 0;
            if (f > bestFinish) { best = n; bestFinish = f; }
        }
        // Fallback: if no terminal node found (e.g., cyclic graph), use latest finish
        if (!best) {
            for (const n of nodes) {
                const f = safeDate(n.Finish)?.getTime() || 0;
                if (f > bestFinish) { best = n; bestFinish = f; }
            }
        }
        return best || nodes[nodes.length - 1];
    }

    function findEarliestStart(nodes) {
        let best = null;
        for (const n of nodes) {
            const s = safeDate(n.Start) || safeDate(n.ActualStart);
            if (s && (!best || s < best)) best = s;
        }
        return best;
    }

    function inferStatusDate(nodes) {
        const now = Date.now();
        let maxTime = 0;

        for (const n of nodes) {
            // Use raw PercentComplete (don’t depend on maps here)
            const pct = normalizePercentComplete(n?.PercentComplete);
            if (pct <= 0) continue;

            const af = safeDate(n?.ActualFinish);
            const as = safeDate(n?.ActualStart);
            const t = (af || as)?.getTime?.() || 0;

            if (t > 0 && t <= now && t > maxTime) maxTime = t;
        }

        return maxTime ? new Date(maxTime) : new Date();
    }


    function computeTopoOrderOptimized(nodeMap, succMap, predMap) {
        const n = nodeMap.size;
        const indeg = new Map();
        for (const id of nodeMap.keys()) {
            const preds = predMap.get(id);
            indeg.set(id, preds ? preds.length : 0);
        }

        const queue = [];
        for (const [id, deg] of indeg) {
            if (deg === 0) queue.push(id);
        }

        const order = [];
        let qi = 0;
        while (qi < queue.length) {
            const u = queue[qi++];
            order.push(u);
            const succs = succMap.get(u);
            if (!succs) continue;
            for (let i = 0; i < succs.length; i++) {
                const v = succs[i].target;
                const newDeg = indeg.get(v) - 1;
                indeg.set(v, newDeg);
                if (newDeg === 0) queue.push(v);
            }
        }

        const hasCycle = order.length !== n;
        if (hasCycle) {
            const inOrder = new Set(order);
            for (const id of nodeMap.keys()) {
                if (!inOrder.has(id)) order.push(id);
            }
        }
        return { order, hasCycle };
    }

    function buildSlackMap(slackResults) {
        const m = new Map();
        if (!slackResults) return m;
        if (slackResults instanceof Map) {
            for (const [k, v] of slackResults) m.set(String(k), v);
        } else if (Array.isArray(slackResults)) {
            for (const r of slackResults) {
                const id = r?.ID ?? r?.id ?? r?.nodeId;
                if (id != null) m.set(String(id), r);
            }
        } else if (typeof slackResults === 'object') {
            for (const k in slackResults) m.set(k, slackResults[k]);
        }
        return m;
    }

    function getTotalFloatHours(node, slackMap) {
        const rec = slackMap.get(String(node.ID));
        const tf = rec?.TotalFloat ?? rec?.totalFloat ?? rec?.slack ?? node.TotalFloat ?? node.slack ?? 0;
        const v = +tf;
        if (!isFinite(v)) return 0;
        return v;
    }

    function getSanitizedActuals(nodeId, maps) {
        const rec = maps.sanitizedDates.get(String(nodeId));
        return rec || { actualStart: null, actualFinish: null };
    }

    // =========================================================================
    // ACTIVE ACTIVITIES + REACHABILITY
    // =========================================================================

    function identifyActiveActivities(nodes, maps) {
        const active = [];
        for (const n of nodes) {
            if (isMilestone(n)) continue;
            const { actualStart, actualFinish } = getSanitizedActuals(n.ID, maps);
            if (!actualStart || actualFinish) continue;
            active.push({ id: String(n.ID), node: n, actualStart });
        }
        return active;
    }

    function buildReachabilitySets(maps, nodes, drivingChain) {
        const { nodeMap, succMap, predMap, slackMap, endNode } = maps;
        const endId = String(endNode.ID);

        const canReachEnd = new Set([endId]);
        const stack = [endId];
        while (stack.length) {
            const cur = stack.pop();
            const preds = predMap.get(cur);
            if (!preds) continue;
            for (let i = 0; i < preds.length; i++) {
                const pid = preds[i].source;
                if (!canReachEnd.has(pid)) {
                    canReachEnd.add(pid);
                    stack.push(pid);
                }
            }
        }

        const incompleteToEnd = new Set([endId]);
        for (const n of nodes) {
            const id = String(n.ID);
            if (!canReachEnd.has(id)) continue;
            const { actualFinish } = getSanitizedActuals(n.ID, maps);
            const pct = effectivePercentComplete(n, maps);
            if (actualFinish || pct >= 1) continue;
            incompleteToEnd.add(id);
        }

        const maxNodes = CONFIG.scopeMaxNodes;
        let scope;

        if (incompleteToEnd.size <= maxNodes) {
            scope = incompleteToEnd;
        } else {
            const must = new Set();

            if (drivingChain) {
                for (const item of drivingChain) {
                    const id = String(item.ID || item);
                    if (incompleteToEnd.has(id)) must.add(id);
                }
            }

            const floatThresholdHrs = CONFIG.scopeFloatEnvelopeDays * CONFIG.workingHoursPerDay;
            for (const n of nodes) {
                const id = String(n.ID);
                if (!incompleteToEnd.has(id)) continue;
                if (n.isCritical || n.isOnOutlierPath) {
                    must.add(id);
                    continue;
                }
                const tf = getTotalFloatHours(n, slackMap);
                if (tf <= floatThresholdHrs) must.add(id);
            }

            const closed = new Set(must);
            const toProcess = Array.from(must);

            let pi = 0;
            while (pi < toProcess.length) {
                const cur = toProcess[pi++];
                const preds = predMap.get(cur);
                if (preds) {
                    for (let i = 0; i < preds.length; i++) {
                        const pid = preds[i].source;
                        if (canReachEnd.has(pid) && !closed.has(pid)) {
                            closed.add(pid);
                            toProcess.push(pid);
                        }
                    }
                }
                const succs = succMap.get(cur);
                if (succs) {
                    for (let i = 0; i < succs.length; i++) {
                        const sid = succs[i].target;
                        if (canReachEnd.has(sid) && !closed.has(sid)) {
                            closed.add(sid);
                            toProcess.push(sid);
                        }
                    }
                }
            }
            scope = closed;
            scope.add(endId);
        }

        return { canReachEnd, incompleteToEnd, scopeToEnd: scope };
    }

    // =========================================================================
    // EXPECTED SCHEDULE COMPUTATION
    // =========================================================================

    function computeExpectedSchedule(nodes, links, maps, overrides) {
        const { nodeMap, predMap, succMap, topoOrder, statusDate, endNode, hasCycle } = maps;
        const plannedFinish = toDate(endNode.Finish);

        const crashHoursById = overrides?.crashHoursById || null;
        const lagReductionHrsByEdgeKey = overrides?.lagReductionHrsByEdgeKey || null;

        const linkIndex = new Map();
        for (const l of links || []) {
            const sID = String(typeof l.source === 'object' ? l.source.ID : l.source);
            const tID = String(typeof l.target === 'object' ? l.target.ID : l.target);
            const edgeKey = `${sID}|${tID}`;
            let lagHrs = getLagInHours(l);
            if (lagReductionHrsByEdgeKey && lagReductionHrsByEdgeKey.has(edgeKey)) {
                lagHrs = Math.max(0, lagHrs - (lagReductionHrsByEdgeKey.get(edgeKey) || 0));
            }
            linkIndex.set(edgeKey, {
                type: (l.type || 'FS').toUpperCase(),
                lagHrs
            });
        }

        const expectedMap = new Map();
        const statusTime = statusDate.getTime();

        for (const n of nodes) {
            const id = String(n.ID);
            const pct = effectivePercentComplete(n, maps);
            const { actualStart, actualFinish } = getSanitizedActuals(id, maps);
            const plannedStart = safeDate(getNodePlannedStart(n));
            const plannedFinishN = safeDate(getNodePlannedFinish(n));

            let expStart, expFinish;

            const crashHrs = crashHoursById ? (crashHoursById.get(id) || 0) : 0;

            if (actualFinish || pct >= 1) {
                expStart = actualStart || plannedStart || statusDate;
                expFinish = actualFinish || plannedFinishN || expStart;
                n.ExpectedDurationHours = convertToHours(n.Duration, n.TimeUnits);
            } else if (actualStart || (pct > 0 && pct < 1)) {
                // IN PROGRESS LOGIC
                const durH = convertToHours(n.Duration, n.TimeUnits);
                const baseRemH = Math.max(0, durH * (1 - (pct || 0)));
                const remH = Math.max(0, baseRemH - crashHrs);

                expStart = actualStart || plannedStart || statusDate;

                // Remaining work must occur AFTER status date
                const effectiveStart = maxDate(statusDate, expStart);
                expFinish = addHours(effectiveStart, remH);

                n.ExpectedRemainingHours = remH;
                n.ExpectedDurationHours = durH;
            } else {
                // NOT STARTED
                const durH0 = convertToHours(n.Duration, n.TimeUnits);
                const durH = Math.max(0, durH0 - crashHrs);
                n.ExpectedDurationHours = durH;
                n.ExpectedRemainingHours = durH;

                if (plannedStart && plannedStart.getTime() > statusTime) {
                    expStart = plannedStart;
                    expFinish = plannedFinishN || addHours(expStart, durH);
                } else {
                    expStart = statusDate;
                    if (plannedFinishN && plannedFinishN.getTime() >= expStart.getTime()) {
                        expFinish = plannedFinishN;
                    } else {
                        expFinish = addHours(expStart, durH);
                    }
                }
            }

            if (expStart && expFinish && expFinish < expStart) expFinish = expStart;

            expectedMap.set(id, { s: expStart, f: expFinish });
            n.ExpectedStart = expStart?.toISOString?.() || null;
            n.ExpectedFinish = expFinish?.toISOString?.() || null;

            delete n.predictedStart;
            delete n.predictedEnd;
            delete n.expectedDrivingPredId;
            delete n.expectedDrivingRelType;
        }

        const isComplete = (n) => {
            const { actualFinish } = getSanitizedActuals(n.ID, maps);
            return !!actualFinish || effectivePercentComplete(n, maps) >= 1;
        };
        const isStarted = (n) => {
            const { actualStart } = getSanitizedActuals(n.ID, maps);
            return !!actualStart || effectivePercentComplete(n, maps) > 0;
        };

        function propagate(predId, succId) {
            const succ = nodeMap.get(succId);
            if (!succ || isComplete(succ)) return false;

            const predRec = expectedMap.get(predId);
            const succRec = expectedMap.get(succId);
            if (!predRec?.f || !succRec) return false;

            const rel = linkIndex.get(`${predId}|${succId}`) || { type: 'FS', lagHrs: 0 };
            const pF = predRec.f;
            const pS = predRec.s;
            let sS = succRec.s;
            let sF = succRec.f;
            const durH = Math.max(0, convertToHours(succ.Duration, succ.TimeUnits));
            const remH = Math.max(0, +(succ.ExpectedRemainingHours ?? succ.ExpectedDurationHours ?? durH));
            let newStart = null;

            if (rel.type === 'FS') {
                newStart = addHours(pF, rel.lagHrs);
            } else if (rel.type === 'SS') {
                newStart = pS ? addHours(pS, rel.lagHrs) : null;
            } else if (rel.type === 'FF') {
                const reqFinish = addHours(pF, rel.lagHrs);
                if (reqFinish && (!sF || reqFinish > sF)) {
                    sF = reqFinish;
                    if (!isStarted(succ)) sS = subtractWorkingHours(sF, durH);
                    expectedMap.set(succId, { s: sS, f: sF });
                    succ.expectedDrivingPredId = predId;
                    succ.expectedDrivingRelType = rel.type;
                    succ.ExpectedStart = sS?.toISOString?.() || null;
                    succ.ExpectedFinish = sF?.toISOString?.() || null;
                    return true;
                }
                return false;
            } else if (rel.type === 'SF') {
                const reqFinish = pS ? addHours(pS, rel.lagHrs) : null;
                if (reqFinish && (!sF || reqFinish > sF)) {
                    sF = reqFinish;
                    if (!isStarted(succ)) sS = subtractWorkingHours(sF, durH);
                    expectedMap.set(succId, { s: sS, f: sF });
                    succ.expectedDrivingPredId = predId;
                    succ.expectedDrivingRelType = rel.type;
                    succ.ExpectedStart = sS?.toISOString?.() || null;
                    succ.ExpectedFinish = sF?.toISOString?.() || null;
                    return true;
                }
                return false;
            }

            if (newStart && !isStarted(succ)) {
                const constrainedStart = maxDate(statusDate, newStart);
                if (constrainedStart && (!sS || constrainedStart > sS)) {
                    sS = constrainedStart;
                    sF = addHours(sS, remH);
                    expectedMap.set(succId, { s: sS, f: sF });
                    succ.expectedDrivingPredId = predId;
                    succ.expectedDrivingRelType = rel.type;
                    succ.ExpectedStart = sS?.toISOString?.() || null;
                    succ.ExpectedFinish = sF?.toISOString?.() || null;
                    return true;
                }
            }
            return false;
        }

        if (!hasCycle) {
            for (const id of topoOrder) {
                const succs = succMap.get(id);
                if (!succs) continue;
                for (let i = 0; i < succs.length; i++) {
                    propagate(id, succs[i].target);
                }
            }
        } else {
            for (let iter = 0; iter < CONFIG.relaxationMaxIterations; iter++) {
                let changed = false;
                for (const l of links || EMPTY_ARRAY) {
                    const sID = String(typeof l.source === 'object' ? l.source.ID : l.source);
                    const tID = String(typeof l.target === 'object' ? l.target.ID : l.target);
                    if (propagate(sID, tID)) changed = true;
                }
                if (!changed) break;
            }
        }

        // ── Post-propagation: Identify driving predecessors for ALL non-complete nodes ──
        // The propagation loop only sets expectedDrivingPredId when it pushes dates later.
        // For on-time schedules, no dates get pushed, so the driving chain is never built.
        // Fix: For each non-complete node that has predecessors but no driving pred set,
        // find the predecessor whose constraint produces the latest start/finish.
        for (const id of (hasCycle ? Array.from(nodeMap.keys()) : topoOrder)) {
            const n = nodeMap.get(id);
            if (!n || n.expectedDrivingPredId) continue; // already has a driving pred

            const preds = predMap.get(id);
            if (!preds || preds.length === 0) continue;

            let bestPredId = null;
            let bestTime = -Infinity;

            for (let i = 0; i < preds.length; i++) {
                const edge = preds[i];
                const predId = edge.source;
                const predRec = expectedMap.get(predId);
                if (!predRec?.f) continue;

                const rel = linkIndex.get(`${predId}|${id}`) || { type: 'FS', lagHrs: 0 };
                let constraintTime;

                if (rel.type === 'FS') {
                    constraintTime = addHours(predRec.f, rel.lagHrs)?.getTime?.() || 0;
                } else if (rel.type === 'SS') {
                    constraintTime = predRec.s ? (addHours(predRec.s, rel.lagHrs)?.getTime?.() || 0) : 0;
                } else if (rel.type === 'FF') {
                    constraintTime = addHours(predRec.f, rel.lagHrs)?.getTime?.() || 0;
                } else if (rel.type === 'SF') {
                    constraintTime = predRec.s ? (addHours(predRec.s, rel.lagHrs)?.getTime?.() || 0) : 0;
                } else {
                    constraintTime = predRec.f?.getTime?.() || 0;
                }

                if (constraintTime > bestTime) {
                    bestTime = constraintTime;
                    bestPredId = predId;
                }
            }

            if (bestPredId) {
                const rel = linkIndex.get(`${bestPredId}|${id}`) || { type: 'FS', lagHrs: 0 };
                n.expectedDrivingPredId = bestPredId;
                n.expectedDrivingRelType = rel.type;
            }
        }

        const endRec = expectedMap.get(String(endNode.ID));
        const expectedFinish = endRec?.f || plannedFinish;
        const variance = (plannedFinish && expectedFinish) ? daysBetween(plannedFinish, expectedFinish) : 0;

        return {
            statusDate,
            plannedProjectFinish: plannedFinish,
            expectedProjectFinish: expectedFinish,
            projectVariance: variance,
            isOverrun: variance > 0,
            expectedMap,
            endNode
        };
    }

    function getExpectedDrivingChain(endNode, nodeMap) {
        const chain = [];
        const seen = new Set();
        let cur = endNode ? String(endNode.ID) : null;

        while (cur && nodeMap.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            const n = nodeMap.get(cur);
            if (!isMilestone(n)) chain.push(n);
            cur = n.expectedDrivingPredId ? String(n.expectedDrivingPredId) : null;
        }

        chain.reverse();
        return chain;
    }

    // =========================================================================
    // RISK / MONTE CARLO
    // =========================================================================

    function getRiskWeightsCached() {
        if (_cachedWeights) return _cachedWeights;
        const base = CONFIG.riskIndexWeights;
        const override = global.cybereumState?.completionRiskIndexWeights;
        // FIX M16: Use explicit null/undefined checks instead of || so that
        // zero values are respected (|| treats 0 as falsy, falling through to base).
        _cachedWeights = override ? {
            computedRisk: (override.computedRisk != null ? +override.computedRisk : base.computedRisk),
            overrunProb: (override.overrunProb != null ? +override.overrunProb : base.overrunProb),
            outlier: (override.outlier != null ? +override.outlier : base.outlier),
            corrAbs: (override.corrAbs != null ? +override.corrAbs : base.corrAbs)
        } : base;
        return _cachedWeights;
    }

    function computeRiskIndex(node) {
        if (!node) return 0;
        const w = getRiskWeightsCached();
        const sum = w.computedRisk + w.overrunProb + w.outlier + w.corrAbs;
        const riskScore = clamp(+(node.ComputedRiskScore ?? node.riskScore ?? 0), 0, 1);
        const overrunProb = clamp(+(node.overrun_probability ?? 0), 0, 1);
        const outlier = node.isOnOutlierPath ? 1 : clamp(+(node.OutlierScoreNormalized ?? 0), 0, 1);
        const corrAbs = clamp(Math.abs(+(node.scheduleCorrelation ?? 0)), 0, 1);
        return clamp(
            (riskScore * w.computedRisk + overrunProb * w.overrunProb + outlier * w.outlier + corrAbs * w.corrAbs) / sum,
            0, 1
        );
    }

    function seededRng(seed) {
        let a = (seed >>> 0) || 0x12345678;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function triangular(rng, min, mode, max) {
        const u = rng();
        const f = (mode - min) / (max - min);
        return u < f
            ? min + Math.sqrt(u * (mode - min) * (max - min))
            : max - Math.sqrt((1 - u) * (max - mode) * (max - min));
    }

    /**
     * Monte Carlo (Remaining) — deterministic, per-activity/per-iteration RNG (no correlated draws)
     * - Uses node.riskScore (0..1) to decide IF and HOW MUCH to inflate
     * - Chooses distribution (triangular / normal / fat-tail) based on riskScore (and optionally duration)
     * - Uses working-calendar addWorkingHours() consistently for BOTH durations and lags
     * - Avoids correlated RNG streams by hashing (seed, iteration, activityId, drawIndex) -> U(0,1)
     */
    function runMonteCarloRemaining(nodes, links, maps, expected, reachability, drivingChain, opts = {}) {
        if (!CONFIG.monteCarloEnabled || !CONFIG.riskEnabled) return null;

        const { nodeMap, predMap, topoOrder, endNode, statusDate } = maps || {};
        const scope = reachability?.scopeToEnd;

        if (!nodeMap || !predMap || !topoOrder || !endNode || !statusDate) return null;
        if (!scope || scope.size === 0) return null;
        if (scope.size > CONFIG.monteCarloMaxActivities) return null;

        const statusMs = statusDate.getTime();
        const seed = (opts.seed ?? CONFIG.monteCarloSeed ?? Date.now()) >>> 0;

        // ---------------------------------------------------------------------
        // Build link index (relationship types + lag hours)
        // ---------------------------------------------------------------------
        const linkIndex = new Map();
        for (const l of (links || EMPTY_ARRAY)) {
            const sID = String(typeof l.source === 'object' ? l.source.ID : l.source);
            const tID = String(typeof l.target === 'object' ? l.target.ID : l.target);
            linkIndex.set(`${sID}|${tID}`, {
                type: String(l.type || 'FS').toUpperCase(),
                lagHrs: getLagInHours(l)
            });
        }

        // ---------------------------------------------------------------------
        // Baseline: eligible nodes in topo order, in scope, not already finished
        // ---------------------------------------------------------------------
        const baseline = new Map();
        const orderedIds = [];

        // Hoist compound risk lookup — constant across all nodes
        const compoundAnalysis = window.cybereumState?.compoundRiskAnalysis;

        for (const id0 of (topoOrder || EMPTY_ARRAY)) {
            const id = String(id0);
            if (!scope.has(id)) continue;

            const n = nodeMap.get(id);
            if (!n) continue;

            const { actualFinish } = getSanitizedActuals(id, maps);
            if (actualFinish) continue; // done tasks have no remaining uncertainty

            orderedIds.push(id);

            const pct = effectivePercentComplete(n, maps);
            const durHrs = convertToHours(n.Duration, n.TimeUnits);

            const remainingHrs = (pct > 0) ? Math.max(0, durHrs * (1 - pct)) : durHrs;

            // Anchor earliest start to deterministic expected start (or status date)
            const expStart = safeDate(n.ExpectedStart) || statusDate;
            const startMs = Math.max(statusMs, expStart.getTime());

            // Primary risk signal (0..1). Most should be near 0.
            // In baseline building, replace the riskScore line with:

            const internalRisk = clamp01(+(n.riskScore ?? n.ComputedRiskScore ?? 0));
            const externalRisk = applyCompoundAmplification(
                clamp01(+(n.externalScheduleRisk ?? n.ExternalScheduleRisk ?? 0)),
                compoundAnalysis
            );

            // Combined risk: use the unified computeCombinedRisk if available
            // (phase-aware, confidence-weighted), otherwise fall back to
            // multiplicative independence: P(problem) = 1 - P(no internal) × P(no external)
            var riskScore;
            if (typeof computeCombinedRisk === 'function') {
                riskScore = computeCombinedRisk(internalRisk, externalRisk, {
                    phase: n.ActivityPhase || null,
                    confidence: (typeof n.externalRiskConfidence === 'number') ? n.externalRiskConfidence : 0.5,
                    isOnCriticalPath: !!(n.isOnCriticalPath || n.is_oncriticalpath),
                    compoundAmplification: 1.0  // already applied via applyCompoundAmplification above
                });
            } else {
                riskScore = 1 - (1 - internalRisk) * (1 - externalRisk);
            }

            // Duration can optionally influence distribution choice (but your note says riskScore already accounts for duration)
            // Still useful for "leeway" scaling / tail selection.
            const durDays = remainingHrs / (CONFIG.workingHoursPerDay || 8);

            // Active tasks: damp volatility (you already did this — keep it)
            const isActive = pct > 0 && pct < 1;

            // Supply chain classification: external supplier activities have
            // fundamentally different uncertainty profiles (step-function delivery,
            // not compressible, vendor-controlled timeline)
            const supplierType = n.SupplierType || n.supplierType || null;

            baseline.set(id, {
                startMs,
                remainingHrs,
                riskScore,
                durDays,
                isActive,
                supplierType
            });
        }

        if (baseline.size === 0) return null;

        const endId = String(endNode?.ID ?? '');
        const iterations = opts.iterations ?? CONFIG.monteCarloIterations;

        const finishSamples = new Float64Array(iterations);

        // ---------------------------------------------------------------------
        // Performance: reuse maps instead of allocating new ones each iteration
        // ---------------------------------------------------------------------
        const simStartMs = new Map();
        const simFinishMs = new Map();

        // ---------------------------------------------------------------------
        // Helper: apply lag as working-hours (calendar-consistent)
        // ---------------------------------------------------------------------
        function addLagMs(baseMs, lagHrs) {
            if (!Number.isFinite(baseMs)) return baseMs;
            const lh = +lagHrs || 0;
            if (lh === 0) return baseMs;

            if (CONFIG.lagUsesWorkingCalendar) {
                const dt = addWorkingHours(new Date(baseMs), lh);
                return dt ? dt.getTime() : baseMs;
            }

            return baseMs + lh * 3600_000;
        }

        // ---------------------------------------------------------------------
        // ✅ FIX 1: deterministic, independent-ish RNG per (seed, iter, activity, drawIndex)
        // ---------------------------------------------------------------------
        function hash32(x) {
            // Murmur-inspired finalizer (fast, good bit diffusion)
            x |= 0;
            x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
            x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
            x = (x ^ (x >>> 16)) >>> 0;
            return x;
        }

        function hashIdTo32(str) {
            // FNV-1a 32-bit
            let h = 0x811c9dc5;
            for (let i = 0; i < str.length; i++) {
                h ^= str.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
            return h >>> 0;
        }

        function u01(seed32, it, idHash32, drawIdx) {
            // Combine and diffuse
            const x = hash32(seed32 ^ Math.imul((it + 1) >>> 0, 0x9e3779b1) ^ Math.imul((drawIdx + 1) >>> 0, 0x85ebca6b) ^ idHash32);
            // Convert to (0,1); avoid exact 0 for Box-Muller
            return (x + 1) / 4294967297; // 2^32 + 1
        }

        function normal01(seed32, it, idHash32, drawBase) {
            // Box-Muller using two uniforms
            const u1 = u01(seed32, it, idHash32, drawBase);
            const u2 = u01(seed32, it, idHash32, drawBase + 1);
            const r = Math.sqrt(-2.0 * Math.log(u1));
            const theta = 2.0 * Math.PI * u2;
            return r * Math.cos(theta); // ~N(0,1)
        }

        function triangular01(seed32, it, idHash32, drawIdx) {
            // Triangular with min=0, mode=0.5, max=1 (then remap)
            // For triangular(a,m,b), you can transform U, but we’ll just use U directly in triangular() below.
            return u01(seed32, it, idHash32, drawIdx);
        }

        function birnbaumSaundersMultiplier(seed32, it, idHash32, alpha, beta, drawBase) {
            const z = normal01(seed32, it, idHash32, drawBase);
            const term = (alpha * z) / 2;
            const x = beta * Math.pow(term + Math.sqrt(term * term + 1), 2);
            return Math.max(0, x);
        }

        // ---------------------------------------------------------------------
        // ✅ FIX 2: risk-gated distribution selection + leeway on max multiplier for select nodes
        // ---------------------------------------------------------------------
        const MC = {
            // Risk gating thresholds (tune as you like)
            noRiskBelow: opts.noRiskBelow ?? CONFIG.mcNoRiskBelow ?? 0.06,   // <6% risk => mult = 1.0
            normalFrom: opts.normalFrom ?? CONFIG.mcNormalFrom ?? 0.18,  // >=18% => can use normal
            fatTailFrom: opts.fatTailFrom ?? CONFIG.mcFatTailFrom ?? 0.55,  // >=55% => fat-tail
            // Leeway caps
            maxMultBase: opts.maxMultBase ?? CONFIG.mcMaxMultBase ?? 2.0, // low/moderate cap
            maxMultHigh: opts.maxMultHigh ?? CONFIG.mcMaxMultHigh ?? 6.0, // high-risk / long-lead cap
            minMult: opts.minMult ?? CONFIG.mcMinMult ?? 0.95 // allow small underruns (or set 1.0)
        };

        function lerp(a, b, t) { return a + (b - a) * t; }

        function durationSensitiveMaxMult(risk, durDays) {
            // More leeway for high risk AND long remaining work (optional)
            // risk already “accounts for duration” — this just gives extra headroom to the few long/high-risk nodes
            const longness = clamp01((durDays - 30) / 180);          // 0 at 30d, 1 at ~210d
            const highness = clamp01((risk - 0.5) / 0.5);            // 0 at 0.5, 1 at 1.0
            const t = clamp01(0.6 * highness + 0.4 * longness);
            return lerp(MC.maxMultBase, MC.maxMultHigh, t);
        }

        function sampleMultiplier(seed32, it, idHash32, risk, durDays, isActive, supplierType) {
            // Gate: most nodes get no inflation
            if (risk <= MC.noRiskBelow) return 1.0;

            // Active tasks: damp volatility
            const damp = isActive ? 0.75 : 1.0;

            // Supply chain adjustment: external equipment has inherently higher
            // uncertainty (vendor-controlled, step-function delivery, not compressible).
            // Lower the fat-tail threshold so equipment activities use heavier-tailed
            // distributions even at moderate risk scores.
            let effectiveFatTailFrom = MC.fatTailFrom;
            let effectiveNormalFrom = MC.normalFrom;
            if (supplierType === 'external_equipment') {
                effectiveFatTailFrom = Math.min(MC.fatTailFrom, 0.35);  // fat-tail from 35% risk
                effectiveNormalFrom = Math.min(MC.normalFrom, 0.10);    // normal from 10% risk
            } else if (supplierType === 'external_material') {
                effectiveFatTailFrom = Math.min(MC.fatTailFrom, 0.40);  // between equipment and service
                effectiveNormalFrom = Math.min(MC.normalFrom, 0.12);
            } else if (supplierType === 'external_service') {
                effectiveFatTailFrom = Math.min(MC.fatTailFrom, 0.45);
            }

            // Local caps: more leeway for select nodes
            const maxCap = durationSensitiveMaxMult(risk, durDays);
            const minCap = Math.min(1.0, MC.minMult);

            // Decide distribution
            // - Low/moderate risk: triangular (bounded, skewed up)
            // - Mid risk: normal around 1 with sigma ~ risk
            // - High risk: Birnbaum–Saunders fat-tail
            let mult;

            if (risk >= effectiveFatTailFrom) {
                // Fat-tail: alpha drives tail thickness (0.25..0.90), beta sets baseline >1
                const alpha = 0.25 + 0.65 * risk;         // 0.25..0.90
                const beta = 1.00 + 0.10 * risk;         // ~1.00..1.10
                mult = birnbaumSaundersMultiplier(seed32, it, idHash32, alpha * damp, beta, 10);
            } else if (risk >= effectiveNormalFrom) {
                // Normal: mean slightly >1, sigma proportional to risk
                const z = normal01(seed32, it, idHash32, 20);
                const mu = 1.00 + 0.06 * risk * damp;     // mild upward bias
                const sigma = 0.10 + 0.35 * risk * damp;  // 0.16..0.45-ish
                mult = mu + z * sigma;
            } else {
                // Triangular: bounded and skewed upward with risk
                const maxUp = 0.05 + 0.80 * risk * damp; // increases with risk
                const modeUp = 0.02 + 0.35 * risk * damp;
                // Use your existing triangular(rng, a, m, b) but feed it a deterministic U
                // We don’t want to refactor triangular() signature, so we implement local triangular using U.
                const u = triangular01(seed32, it, idHash32, 30);

                const a = 1.0;
                const m = 1.0 + modeUp;
                const b = 1.0 + maxUp;

                const c = (m - a) / (b - a);
                if (u < c) mult = a + Math.sqrt(u * (b - a) * (m - a));
                else mult = b - Math.sqrt((1 - u) * (b - a) * (b - m));
            }

            // Guardrails
            if (!Number.isFinite(mult)) mult = 1.0;
            if (mult < minCap) mult = minCap;
            if (mult > maxCap) mult = maxCap;

            return mult;
        }

        // Pre-hash ids once (speed)
        const idHash = new Map();
        for (const id of orderedIds) idHash.set(id, hashIdTo32(id));

        for (let it = 0; it < iterations; it++) {
            simStartMs.clear();
            simFinishMs.clear();

            for (const id of orderedIds) {
                const b = baseline.get(id);
                if (!b) continue;

                let startMs = b.startMs;
                let reqFinishMs = null;

                const preds = predMap?.get(id);
                if (preds && preds.length) {
                    for (let i = 0; i < preds.length; i++) {
                        const p = preds[i];
                        const predId = String(p.source);

                        const pS = simStartMs.get(predId);
                        const pF = simFinishMs.get(predId);

                        const rel = linkIndex.get(`${predId}|${id}`) || {
                            type: String(p.type || 'FS').toUpperCase(),
                            lagHrs: +p.lagHrs || 0
                        };

                        const lagHrs = +rel.lagHrs || 0;

                        if (rel.type === 'FS') {
                            if (pF != null) startMs = Math.max(startMs, addLagMs(pF, lagHrs));
                        } else if (rel.type === 'SS') {
                            if (pS != null) startMs = Math.max(startMs, addLagMs(pS, lagHrs));
                        } else if (rel.type === 'FF') {
                            if (pF != null) reqFinishMs = Math.max(reqFinishMs ?? -Infinity, addLagMs(pF, lagHrs));
                        } else if (rel.type === 'SF') {
                            if (pS != null) reqFinishMs = Math.max(reqFinishMs ?? -Infinity, addLagMs(pS, lagHrs));
                        } else {
                            if (pF != null) startMs = Math.max(startMs, addLagMs(pF, lagHrs));
                        }
                    }
                }

                startMs = Math.max(startMs, statusMs);
                simStartMs.set(id, startMs);

                // Sample multiplier using (seed, iteration, activityId)
                const h = idHash.get(id) >>> 0;
                const mult = sampleMultiplier(seed, it, h, b.riskScore, b.durDays, b.isActive, b.supplierType);

                const simDurHrs = b.remainingHrs * mult;

                // Working-calendar add for duration
                const finishDt = addWorkingHours(new Date(startMs), simDurHrs);
                let finishMs = finishDt ? finishDt.getTime() : startMs;

                // FF / SF requirements
                if (reqFinishMs != null && Number.isFinite(reqFinishMs)) {
                    finishMs = Math.max(finishMs, reqFinishMs);
                }

                if (finishMs > MAX_VALID_TIME) finishMs = MAX_VALID_TIME;

                simFinishMs.set(id, finishMs);
            }

            // Choose sample finish
            let sampleFinish = simFinishMs.get(endId);

            // If endId not simulated, fall back to max finish
            if (sampleFinish == null) {
                let maxF = -Infinity;
                for (const v of simFinishMs.values()) {
                    if (v != null && v > maxF) maxF = v;
                }
                sampleFinish = Number.isFinite(maxF)
                    ? maxF
                    : (expected?.expectedProjectFinish?.getTime?.() || statusMs);
            }

            finishSamples[it] = sampleFinish;
        }

        finishSamples.sort();

        const p20Idx = Math.floor(0.20 * (finishSamples.length - 1));
        const p50Idx = Math.floor(0.50 * (finishSamples.length - 1));
        const p80Idx = Math.floor(0.80 * (finishSamples.length - 1));

        const p20Finish = clampDate(new Date(finishSamples[p20Idx]));
        const p50Finish = clampDate(new Date(finishSamples[p50Idx]));
        const p80Finish = clampDate(new Date(finishSamples[p80Idx]));

        const spreadDays = Math.round((p80Finish - p20Finish) / (1000 * 60 * 60 * 24));

        const results = {
            p20Finish,
            p50Finish,
            p80Finish,
            spreadDays,
            iterations,
            seed,
            finishSamples: Array.from(finishSamples)
        };

        console.log('[CompletionPrediction] runMonteCarloRemaining results:', {
            p20: results.p20Finish?.toISOString?.().split?.('T')?.[0],
            p50: results.p50Finish?.toISOString?.().split?.('T')?.[0],
            p80: results.p80Finish?.toISOString?.().split?.('T')?.[0],
            spreadDays: results.spreadDays,
            scopeSize: baseline.size,
            iterations,
            seed,
            gates: {
                noRiskBelow: MC.noRiskBelow,
                normalFrom: MC.normalFrom,
                fatTailFrom: MC.fatTailFrom,
                minMult: MC.minMult,
                maxMultBase: MC.maxMultBase,
                maxMultHigh: MC.maxMultHigh
            }
        });

        return results;

    }

    // =========================================================================
    // BACKEND-FIRST MONTE CARLO WRAPPER
    // =========================================================================
    //
    // Offloads the remaining-work MC to Pyth-Sched-Analytics'
    // /completion/monte-carlo endpoint when available.  The backend uses
    // the same five-tier risk-distribution model (triangular -> normal ->
    // Birnbaum-Saunders -> Pareto; Natarajan et al. PMJ 2022, Flyvbjerg
    // et al. JMIS 2022) but with Sobol QMC instead of Murmur3/FNV-1a
    // hashing, and full working-calendar support.
    //
    // Returns the same shape as runMonteCarloRemaining() -- Date objects,
    // camelCase keys -- so downstream code (buildRiskSchedules, etc.) is
    // unchanged.  On any failure (disabled, endpoint missing, non-200,
    // network error, timeout) the JS MC runs as a transparent fallback.
    //
    // finishSamples is intentionally omitted from the backend response
    // (raw samples can balloon payloads into the MB range).  Callers that
    // rely on finishSamples already guard with ``mc.finishSamples?.length``.

    // Telemetry: silent counters + last_error so the main app can detect
    // a degrading backend (e.g. 30% 5xx rate).  Never throws.
    function _recordTelemetry(service, kind, detail) {
        try {
            const root = (typeof window !== 'undefined') ? window : null;
            if (!root) return;
            root.cybereumState = root.cybereumState || {};
            const t = root.cybereumState.completionPredictionTelemetry =
                root.cybereumState.completionPredictionTelemetry || {
                    backend_calls: 0, backend_successes: 0,
                    fallback_count: 0, last_error: null,
                    by_service: {},
                };
            const per = t.by_service[service] =
                t.by_service[service] || { calls: 0, successes: 0, fallbacks: 0 };
            if (kind === 'call')        { t.backend_calls++;     per.calls++; }
            else if (kind === 'success'){ t.backend_successes++; per.successes++; }
            else if (kind === 'fallback') {
                t.fallback_count++; per.fallbacks++;
                if (detail) t.last_error = {
                    service,
                    reason: detail.reason || null,
                    status: (detail.status != null) ? detail.status : null,
                    message: detail.message || null,
                    ts: Date.now(),
                };
            }
        } catch (_) { /* never break the calling path */ }
    }

    async function runMonteCarloRemainingAsync(nodes, links, maps, expected,
                                               reachability, drivingChain, opts = {}) {
        const disabled = !CONFIG.useBackendCompletion
            || typeof fetch !== 'function'
            || !CONFIG.completionEndpoint;
        if (disabled) {
            _recordTelemetry('monte_carlo', 'fallback',
                             { reason: 'backend_disabled' });
            return runMonteCarloRemaining(nodes, links, maps, expected,
                                          reachability, drivingChain, opts);
        }

        // If prerequisites that the sync path also requires are missing, the
        // sync path returns null -- mirror that without ever hitting the network.
        const scope = reachability?.scopeToEnd;
        if (!maps?.statusDate || !maps?.endNode || !scope || scope.size === 0
            || scope.size > CONFIG.monteCarloMaxActivities) {
            _recordTelemetry('monte_carlo', 'fallback',
                             { reason: 'prereqs_missing' });
            return runMonteCarloRemaining(nodes, links, maps, expected,
                                          reachability, drivingChain, opts);
        }

        _recordTelemetry('monte_carlo', 'call');
        try {
            const body = _buildCompletionRequestBody(
                nodes, links, maps, reachability, opts);

            const controller = (typeof AbortController === 'function')
                ? new AbortController() : null;
            const timer = controller ? setTimeout(
                () => controller.abort(),
                +CONFIG.completionRequestTimeoutMs || 15000) : null;

            const resp = await fetch(CONFIG.completionEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller ? controller.signal : undefined,
            });

            if (timer) clearTimeout(timer);

            if (!resp.ok) {
                _recordTelemetry('monte_carlo', 'fallback',
                                 { reason: 'non_ok_status', status: resp.status });
                console.warn('[CompletionPrediction] Backend MC returned',
                             resp.status, '-- falling back to JS MC');
                return runMonteCarloRemaining(nodes, links, maps, expected,
                                              reachability, drivingChain, opts);
            }

            const payload = await resp.json();
            const mapped = _mapCompletionResponse(payload);
            _recordTelemetry('monte_carlo', 'success');

            console.log('[CompletionPrediction] Backend MC results:', {
                p20: mapped.p20Finish?.toISOString?.().split?.('T')?.[0],
                p50: mapped.p50Finish?.toISOString?.().split?.('T')?.[0],
                p80: mapped.p80Finish?.toISOString?.().split?.('T')?.[0],
                iterations: mapped.iterations,
                spreadDays: mapped.spreadDays,
                scopeSize: payload.scope_size,
                computationMs: payload.computation_ms,
                cacheHit: payload.cache_hit,
            });
            return mapped;

        } catch (err) {
            _recordTelemetry('monte_carlo', 'fallback', {
                reason: err?.name === 'AbortError' ? 'timeout' : 'network_error',
                message: err?.message || String(err),
            });
            console.warn('[CompletionPrediction] Backend MC failed (',
                         err?.name || 'error', err?.message || err,
                         ') -- falling back to JS MC');
            return runMonteCarloRemaining(nodes, links, maps, expected,
                                          reachability, drivingChain, opts);
        }
    }

    function _buildCompletionRequestBody(nodes, links, maps, reachability, opts) {
        const scope = reachability?.scopeToEnd;
        const statusDate = maps?.statusDate;

        // Send only nodes in the MC scope -- plus any predecessor to preserve
        // DAG integrity when the scope is a subset of the full graph.
        const includeIds = new Set();
        if (scope && scope.size > 0) {
            for (const id of scope) includeIds.add(String(id));
            // Pull in direct predecessors so lag propagation has something to
            // chain off.  Backend will treat ActualFinish-bearing nodes as
            // out-of-scope anchors.
            for (const id of Array.from(includeIds)) {
                const preds = maps?.predMap?.get(id);
                if (preds) for (const p of preds) includeIds.add(String(p.source));
            }
        } else {
            for (const n of nodes || EMPTY_ARRAY) includeIds.add(String(n.ID));
        }

        const sentNodes = [];
        for (const n of nodes || EMPTY_ARRAY) {
            const nid = String(n.ID);
            if (!includeIds.has(nid)) continue;
            sentNodes.push({
                ID: nid,
                Duration: n.Duration,
                TimeUnits: n.TimeUnits,
                PercentComplete: n.PercentComplete ?? n.percentComplete,
                ExpectedStart: _isoOrNull(n.ExpectedStart),
                ActualFinish: _isoOrNull(n.ActualFinish),
                riskScore: n.riskScore ?? n.ComputedRiskScore,
                SupplierType: n.SupplierType || n.supplierType,
                ActivityPhase: n.ActivityPhase || n.activityPhase,
            });
        }

        const sentLinks = [];
        for (const l of links || EMPTY_ARRAY) {
            const src = String(typeof l.source === 'object' ? l.source.ID : l.source);
            const tgt = String(typeof l.target === 'object' ? l.target.ID : l.target);
            if (!includeIds.has(src) || !includeIds.has(tgt)) continue;
            sentLinks.push({
                source: src,
                target: tgt,
                type: (l.type || 'FS').toUpperCase(),
                lag: getLagInHours(l),
            });
        }

        const teamCal = (typeof window !== 'undefined'
                         && window.cybereumState?.teamCalendar) || null;
        const holidays = Array.isArray(teamCal?.holidays)
            ? teamCal.holidays.map(h => (h && h.date) ? h.date : h).filter(Boolean)
            : [];

        // Reference class for empirical-distribution calibration.  When
        // set, the backend overrides tier-4 distribution / Pareto alpha /
        // max multiplier per published sector data and emits a
        // reference_class_calibrated companion alongside the model
        // percentiles (Flyvbjerg / Cantarelli / Sovacool sources).
        // Looks for explicit opt-in first, then maps cybereumState
        // sector tags to canonical class names.
        const project = (typeof window !== 'undefined'
                         && window.cybereumState?.project) || null;
        const referenceClass = opts.referenceClass
            ?? project?.referenceClass
            ?? project?.sector
            ?? project?.projectType
            ?? null;

        // Per-request extension of the registry.  Customers with their
        // own historical calibration can set
        // window.cybereumState.customReferenceClasses = {name: {...}, ...}
        // and reference one by name on the project.  Validated server
        // side so a malformed entry returns 400 with a specific field.
        const customClasses = opts.customReferenceClasses
            ?? (typeof window !== 'undefined'
                && window.cybereumState?.customReferenceClasses)
            ?? null;

        // {base, overrides} for one-off tweaks of a built-in class
        // without registering a full custom class.  Useful when a
        // single project deviates from the sector default for a
        // known reason (e.g. unusually long permitting cycle).
        const referenceClassOverrides = opts.referenceClassOverrides
            ?? (typeof window !== 'undefined'
                && window.cybereumState?.referenceClassOverrides)
            ?? null;

        const body = {
            nodes: sentNodes,
            links: sentLinks,
            status_date: _isoOrNull(statusDate) || new Date(statusDate).toISOString(),
            project_context: {
                calendar: {
                    hours_per_day: CONFIG.workingHoursPerDay || 8,
                    working_days: Array.isArray(teamCal?.workingDays) && teamCal.workingDays.length
                        ? teamCal.workingDays
                        : [1, 2, 3, 4, 5],
                    holidays: holidays,
                },
            },
            config: {
                iterations: opts.iterations ?? CONFIG.monteCarloIterations,
                seed: (opts.seed ?? CONFIG.monteCarloSeed) >>> 0,
                enable_risk: !!CONFIG.riskEnabled,
                thresholds: {
                    no_risk_below: opts.noRiskBelow ?? CONFIG.mcNoRiskBelow,
                    normal_from: opts.normalFrom ?? CONFIG.mcNormalFrom,
                    fat_tail_from: opts.fatTailFrom ?? CONFIG.mcFatTailFrom,
                },
                caps: {
                    min_mult: opts.minMult ?? CONFIG.mcMinMult,
                    max_mult_base: opts.maxMultBase ?? CONFIG.mcMaxMultBase,
                    max_mult_high: opts.maxMultHigh ?? CONFIG.mcMaxMultHigh,
                },
                reference_class: referenceClass,
                custom_reference_classes: customClasses,
                reference_class_overrides: referenceClassOverrides,
            },
        };
        return body;
    }

    function _mapCompletionResponse(payload) {
        const toDate = (iso) => {
            if (!iso) return null;
            const d = new Date(iso);
            return Number.isFinite(d.getTime()) ? clampDate(d) : null;
        };
        // Reference-class calibration: when the backend resolved a
        // class via config.reference_class (set from
        // cybereumState.project.referenceClass / sector / projectType),
        // it returns a `reference_class_calibrated` companion with
        // empirically-corrected percentiles + citations.  Mapped here
        // to camelCase so UI code can show "Model P80: X | Calibrated
        // P80: Y" alongside each other.
        const cal = payload.reference_class_calibrated || null;
        const calibrated = cal ? {
            p50Finish:           toDate(cal.p50_finish),
            p80Finish:           toDate(cal.p80_finish),
            p95Finish:           toDate(cal.p95_finish),
            p99Finish:           toDate(cal.p99_finish),
            referenceClass:      cal.reference_class,
            percentileFactors:   cal.percentile_factors,
            meanOverrunPublished: cal.mean_overrun_published,
            isFatTailed:         cal.is_fat_tailed,
            hasFiniteMean:       cal.has_finite_mean,
            tier4Distribution:   cal.tier_4_distribution,
            paretoAlphaRange:    cal.pareto_alpha_range,
            maxMultiplierCap:    cal.max_multiplier_cap,
            citations:           cal.citations,
        } : null;

        return {
            p20Finish: toDate(payload.p20_finish),
            p50Finish: toDate(payload.p50_finish),
            p80Finish: toDate(payload.p80_finish),
            spreadDays: Number.isFinite(payload.spread_days)
                ? Math.round(payload.spread_days) : 0,
            iterations: payload.iterations ?? 0,
            seed: payload.seed ?? 0,
            finishSamples: [],
            expectedFinish: toDate(payload.expected_finish),
            p20ImpactDays: payload.p20_impact_days,
            p50ImpactDays: payload.p50_impact_days,
            p80ImpactDays: payload.p80_impact_days,
            activityPercentiles: payload.activity_percentiles,
            referenceClassCalibrated: calibrated,
            calibrationWarnings: payload.calibration_warnings || [],
            source: 'backend',
        };
    }

    function _isoOrNull(value) {
        if (!value) return null;
        if (value instanceof Date) {
            return Number.isFinite(value.getTime()) ? value.toISOString() : null;
        }
        const d = safeDate(value);
        return d ? d.toISOString() : null;
    }

    // -------------------------------------------------------------------------
    // Reference-class discovery: fetch the list of available sectors from the
    // backend so a sector dropdown can populate dynamically (rather than
    // hardcoding the 19 built-ins in the frontend).  Cached on window after
    // the first call; memoised per page load.  Returns null on backend
    // failure so the caller can fall back to a static list.
    // -------------------------------------------------------------------------
    let _referenceClassesCache = null;
    async function fetchReferenceClasses() {
        if (_referenceClassesCache) return _referenceClassesCache;
        const disabled = !CONFIG.useBackendCompletion
            || typeof fetch !== 'function'
            || !CONFIG.completionEndpoint;
        if (disabled) {
            _recordTelemetry('reference_classes', 'fallback',
                             { reason: 'backend_disabled' });
            return null;
        }
        // Derive the discovery URL from the configured MC endpoint base
        // so callers don't need a second config knob.
        const base = CONFIG.completionEndpoint.replace(/\/monte-carlo\/?$/, '');
        const url = base + '/reference-classes';
        _recordTelemetry('reference_classes', 'call');
        try {
            const resp = await fetch(url, { method: 'GET' });
            if (!resp.ok) {
                _recordTelemetry('reference_classes', 'fallback',
                                 { reason: 'non_ok_status', status: resp.status });
                return null;
            }
            const data = await resp.json();
            _referenceClassesCache = data;
            _recordTelemetry('reference_classes', 'success');
            return data;
        } catch (err) {
            _recordTelemetry('reference_classes', 'fallback',
                             { reason: 'network_error', message: err?.message });
            console.warn('[CompletionPrediction] reference-class discovery failed:', err);
            return null;
        }
    }
    if (typeof window !== 'undefined') {
        window.fetchReferenceClasses = fetchReferenceClasses;
    }

    // -------------------------------------------------------------------------
    // Outcome registration: customers can submit project actuals so the
    // backend accumulates real predicted-vs-actual data.  Without this,
    // the reference-class table is "trust the literature"; with it, the
    // customer can validate their own portfolio over time.
    //
    // Call when a project closes out (or at any milestone with reliable
    // actuals).  Backend storage is best-effort -- backend failures
    // log a warning but don't block the calling UI.
    // -------------------------------------------------------------------------
    async function registerProjectOutcome(record) {
        const disabled = !CONFIG.useBackendCompletion
            || typeof fetch !== 'function'
            || !CONFIG.completionEndpoint;
        if (disabled) {
            _recordTelemetry('outcome', 'fallback',
                             { reason: 'backend_disabled' });
            console.warn('[CompletionPrediction] Backend disabled; outcome not registered');
            return null;
        }
        const base = CONFIG.completionEndpoint.replace(/\/monte-carlo\/?$/, '');
        _recordTelemetry('outcome', 'call');
        try {
            const resp = await fetch(base + '/register-outcome', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(record),
            });
            const data = await resp.json();
            if (!resp.ok) {
                _recordTelemetry('outcome', 'fallback',
                                 { reason: 'non_ok_status', status: resp.status,
                                   message: data && data.error });
                console.warn('[CompletionPrediction] register-outcome rejected:',
                             data && data.error);
                return null;
            }
            _recordTelemetry('outcome', 'success');
            return data;
        } catch (err) {
            _recordTelemetry('outcome', 'fallback',
                             { reason: 'network_error', message: err?.message });
            console.warn('[CompletionPrediction] register-outcome failed:', err);
            return null;
        }
    }

    async function fetchCalibrationReport(referenceClass) {
        const disabled = !CONFIG.useBackendCompletion
            || typeof fetch !== 'function'
            || !CONFIG.completionEndpoint;
        if (disabled) {
            _recordTelemetry('calibration', 'fallback',
                             { reason: 'backend_disabled' });
            return null;
        }
        const base = CONFIG.completionEndpoint.replace(/\/monte-carlo\/?$/, '');
        const url = referenceClass
            ? `${base}/calibration-report?reference_class=${encodeURIComponent(referenceClass)}`
            : `${base}/calibration-report`;
        _recordTelemetry('calibration', 'call');
        try {
            const resp = await fetch(url, { method: 'GET' });
            if (!resp.ok) {
                _recordTelemetry('calibration', 'fallback',
                                 { reason: 'non_ok_status', status: resp.status });
                return null;
            }
            const data = await resp.json();
            _recordTelemetry('calibration', 'success');
            return data;
        } catch (err) {
            _recordTelemetry('calibration', 'fallback',
                             { reason: 'network_error', message: err?.message });
            console.warn('[CompletionPrediction] calibration-report failed:', err);
            return null;
        }
    }

    if (typeof window !== 'undefined') {
        window.registerProjectOutcome = registerProjectOutcome;
        window.fetchCalibrationReport = fetchCalibrationReport;
    }

    // =========================================================================
    // BACKEND-FIRST RECOVERY OPTIONS WRAPPER
    // =========================================================================
    //
    // Offloads crash/lag candidate ranking to the Pyth-Sched-Analytics
    // /completion/recovery-options endpoint when available.  The backend
    // ports classifyCrashProfile + buildCrashOptions lines ~2062-2300;
    // on any failure (disabled, missing endpoint, non-200, network,
    // timeout) the original sync buildCrashOptions runs as a fallback.
    //
    // Shape parity: returns the same camelCase keys downstream consumers
    // expect (targetDays, recoveryOptions, lagOptions, _crashCandidates,
    // _enrichmentPending, etc.) so wireRiskMitigationClicks and the UI
    // renderers are unchanged.  AI enrichment is still kicked off on the
    // returned crash candidates when CONFIG.aiEnrichmentEnabled is true.

    async function buildCrashOptionsAsync(nodes, maps, expected, risk,
                                          reachability, drivingChain) {
        const disabled = !CONFIG.useBackendRecovery
            || typeof fetch !== 'function'
            || !CONFIG.recoveryEndpoint;
        if (disabled) {
            _recordTelemetry('recovery', 'fallback',
                             { reason: 'backend_disabled' });
            return buildCrashOptions(nodes, maps, expected, risk,
                                     reachability, drivingChain);
        }

        const scope = reachability?.scopeToEnd;
        if (!maps?.statusDate || !scope || scope.size === 0
            || scope.size > CONFIG.monteCarloMaxActivities) {
            _recordTelemetry('recovery', 'fallback',
                             { reason: 'prereqs_missing' });
            return buildCrashOptions(nodes, maps, expected, risk,
                                     reachability, drivingChain);
        }

        _recordTelemetry('recovery', 'call');
        try {
            const body = _buildRecoveryRequestBody(
                nodes, maps, expected, risk, reachability);

            const controller = (typeof AbortController === 'function')
                ? new AbortController() : null;
            const timer = controller ? setTimeout(
                () => controller.abort(),
                +CONFIG.recoveryRequestTimeoutMs || 10000) : null;

            const resp = await fetch(CONFIG.recoveryEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller ? controller.signal : undefined,
            });

            if (timer) clearTimeout(timer);

            if (!resp.ok) {
                _recordTelemetry('recovery', 'fallback',
                                 { reason: 'non_ok_status', status: resp.status });
                console.warn('[CompletionPrediction] Backend recovery returned',
                             resp.status, '-- falling back to JS buildCrashOptions');
                return buildCrashOptions(nodes, maps, expected, risk,
                                         reachability, drivingChain);
            }

            const payload = await resp.json();
            const mapped = _mapRecoveryResponse(payload, nodes, maps, expected,
                                                scope, risk, drivingChain);
            _recordTelemetry('recovery', 'success');

            // AI enrichment: reuse the existing sync helpers so the UI flow
            // (spinner + final replacement of recoveryOptions) continues to
            // work regardless of backend mode.
            if (CONFIG.aiEnrichmentEnabled && mapped._crashCandidates.length > 0) {
                mapped._enrichmentPromise = (async () => {
                    try {
                        const projectContext = {
                            sector: typeof inferProjectSector === 'function'
                                ? inferProjectSector(mapped._crashCandidates) : null,
                            overrunDays: Math.round(
                                (expected.expectedProjectFinish - expected.plannedProjectFinish)
                                / MS_PER_DAY),
                            spreadDays: risk?.spreadDays || 0
                        };
                        const assessments = await requestCrashEnrichment(
                            mapped._crashCandidates, projectContext);
                        if (assessments && assessments.size > 0) {
                            mapped.recoveryOptions = applyAIEnrichment(
                                mapped.recoveryOptions, assessments);
                            mapped._enrichmentComplete = true;
                            const newAchievedHrs = mapped.recoveryOptions.reduce(
                                (sum, o) => sum + (o.crashHours || 0), 0);
                            mapped.achievedDays = Math.round(
                                newAchievedHrs / CONFIG.workingHoursPerDay);
                        }
                    } catch (e) {
                        console.warn('[CompletionPrediction] Enrichment failed '
                                     + '(backend-recovery path):', e);
                    }
                })();
            }

            console.log('[CompletionPrediction] Backend recovery results:', {
                targetDays: mapped.targetDays,
                achievedDays: mapped.achievedDays,
                overrunDays: payload.overrun_days,
                recoveryOptions: mapped.recoveryOptions.length,
                lagOptions: mapped.lagOptions.length,
                scenarioMode: payload.is_scenario_mode,
                computationMs: payload.computation_ms,
                cacheHit: payload.cache_hit,
            });
            return mapped;

        } catch (err) {
            _recordTelemetry('recovery', 'fallback', {
                reason: err?.name === 'AbortError' ? 'timeout' : 'network_error',
                message: err?.message || String(err),
            });
            console.warn('[CompletionPrediction] Backend recovery failed (',
                         err?.name || 'error', err?.message || err,
                         ') -- falling back to JS buildCrashOptions');
            return buildCrashOptions(nodes, maps, expected, risk,
                                     reachability, drivingChain);
        }
    }

    function _buildRecoveryRequestBody(nodes, maps, expected, risk, reachability) {
        const scope = reachability?.scopeToEnd;
        const statusDate = maps?.statusDate;

        const includeIds = new Set();
        if (scope && scope.size > 0) {
            for (const id of scope) includeIds.add(String(id));
            for (const id of Array.from(includeIds)) {
                const preds = maps?.predMap?.get(id);
                if (preds) for (const p of preds) includeIds.add(String(p.source));
            }
        } else {
            for (const n of nodes || EMPTY_ARRAY) includeIds.add(String(n.ID));
        }

        const sentNodes = [];
        for (const n of nodes || EMPTY_ARRAY) {
            const nid = String(n.ID);
            if (!includeIds.has(nid)) continue;
            sentNodes.push({
                ID: nid,
                Name: n.Name || nid,
                Duration: n.Duration,
                TimeUnits: n.TimeUnits,
                PercentComplete: n.PercentComplete ?? n.percentComplete,
                ActualFinish: _isoOrNull(n.ActualFinish),
                SupplierType: n.SupplierType || n.supplierType,
                Milestone: n.Milestone === true || n.Milestone === 1 || n.Milestone === '1',
                ComputedImportanceScore: n.ComputedImportanceScore
                    ?? n.importanceScore ?? n.importance,
            });
        }

        const sentLinks = [];
        for (const l of (maps?.linkIndex ? null : null) || EMPTY_ARRAY) { /* placeholder */ }
        // Re-derive links from maps.predMap (frontend doesn't keep the
        // raw links list around in all code paths).
        if (maps?.predMap) {
            for (const [targetId, preds] of maps.predMap) {
                if (!includeIds.has(String(targetId))) continue;
                for (const p of preds) {
                    const srcId = String(p.source);
                    if (!includeIds.has(srcId)) continue;
                    sentLinks.push({
                        source: srcId,
                        target: String(targetId),
                        type: (p.type || 'FS').toUpperCase(),
                        lag: +p.lagHrs || 0,
                        lagUnits: 'h',
                    });
                }
            }
        }

        const teamCal = (typeof window !== 'undefined'
                         && window.cybereumState?.teamCalendar) || null;
        const holidays = Array.isArray(teamCal?.holidays)
            ? teamCal.holidays.map(h => (h && h.date) ? h.date : h).filter(Boolean)
            : [];

        return {
            nodes: sentNodes,
            links: sentLinks,
            status_date: _isoOrNull(statusDate) || new Date(statusDate).toISOString(),
            planned_finish:   _isoOrNull(expected?.plannedProjectFinish),
            expected_finish:  _isoOrNull(expected?.expectedProjectFinish),
            p80_finish:       _isoOrNull(risk?.p80Finish),
            project_context: {
                calendar: {
                    hours_per_day: CONFIG.workingHoursPerDay || 8,
                    working_days: Array.isArray(teamCal?.workingDays) && teamCal.workingDays.length
                        ? teamCal.workingDays
                        : [1, 2, 3, 4, 5],
                    holidays: holidays,
                },
            },
            config: {
                max_risk_buffer_days:         CONFIG.maxRiskBufferDaysForRecovery,
                max_recovery_options:         CONFIG.maxRecoveryOptions,
                max_lag_options:              CONFIG.maxLagOptions,
                min_crashable_hours:          CONFIG.minCrashableHours,
                min_lag_days_for_compression: CONFIG.minLagDaysForCompression,
                lag_compression_factor:       CONFIG.lagCompressionFactor,
            },
        };
    }

    function _mapRecoveryResponse(payload, nodes, maps, expected, scope, risk,
                                  drivingChain) {
        // Map snake_case backend fields to the camelCase JS contract.
        const recoveryOptions = (payload.recovery_options || []).map(o => ({
            id:                    o.id,
            type:                  o.type,
            title:                 o.title,
            targetActivityId:      o.target_activity_id,
            activityName:          o.activity_name,
            kind:                  o.kind,
            crashHours:            o.crash_hours,
            potentialSavingsDays:  o.potential_savings_days,
            leverage:              o.leverage,
            isOnDrivingChain:      o.is_on_critical_path,
            floatDays:             o.float_days,
            effort:                o.effort,
            risk:                  o.risk,
            rationale:             o.rationale,
        }));

        const lagOptions = (payload.lag_options || []).map(o => ({
            id:                    o.id,
            type:                  o.type,
            title:                 o.title,
            edgeId:                o.edge_id,
            sourceId:              o.source_id,
            targetId:              o.target_id,
            sourceName:            o.source_name,
            targetName:            o.target_name,
            relationType:          o.relation_type,
            currentLagHours:       o.current_lag_hours,
            currentLagDays:        o.current_lag_days,
            potentialSavingsDays:  o.potential_savings_days,
            isOnDrivingChain:      o.is_on_critical_path,
            effort:                o.effort,
            risk:                  o.risk,
        }));

        // Remap raw crash_candidates to the camelCase shape the AI
        // enrichment helper expects (requestCrashEnrichment).
        const crashCandidates = (payload.crash_candidates || []).map(c => ({
            id:           c.id,
            name:         c.name,
            kind:         c.kind,
            remainingHrs: c.remaining_hrs,
            maxCrashHrs:  c.max_crash_hrs,
            leverage:     c.leverage,
            isChain:      c.is_on_critical_path,
            floatDays:    c.float_days,
            score:        c.score,
            importance:   c.importance,
        }));

        return {
            recoveryOptions,
            lagOptions,
            // riskMitigationOptions stays empty in backend mode; the
            // risk-register path is JS-only (see CLAUDE.md).
            riskMitigationOptions: [],
            targetDays:     payload.target_days,
            achievedDays:   payload.achieved_days,
            notes:          payload.notes || '',
            _enrichmentPending:
                !!CONFIG.aiEnrichmentEnabled && crashCandidates.length > 0,
            _enrichmentComplete: false,
            _crashCandidates: crashCandidates,
            _scope:    scope,
            _maps:     maps,
            _expected: expected,
            source:    'backend',
        };
    }

    // =========================================================================
    // RISK SCHEDULES (P50/P80) - SINGLE PASS
    // =========================================================================

    function buildRiskSchedules(nodes, links, maps, expected, reachability, mc) {
        const { nodeMap, predMap, topoOrder, slackMap, statusDate, endNode } = maps;
        const endId = String(endNode.ID);
        const scope = reachability?.scopeToEnd || new Set(nodeMap.keys());

        const linkIndex = new Map();
        for (const l of links || EMPTY_ARRAY) {
            const sID = String(typeof l.source === 'object' ? l.source.ID : l.source);
            const tID = String(typeof l.target === 'object' ? l.target.ID : l.target);
            linkIndex.set(`${sID}|${tID}`, {
                type: (l.type || 'FS').toUpperCase(),
                lagHrs: getLagInHours(l)
            });
        }

        const baseCache = new Map();
        for (const id of scope) {
            const n = nodeMap.get(id);
            if (!n) continue;
            const rec = expected.expectedMap.get(id);
            baseCache.set(id, {
                s: rec?.s || toDate(n.ExpectedStart) || toDate(getNodePlannedStart(n)) || statusDate,
                f: rec?.f || toDate(n.ExpectedFinish) || toDate(getNodePlannedFinish(n)) || statusDate
            });
        }

        const isDone = (n) => {
            const { actualFinish } = getSanitizedActuals(n.ID, maps);
            return !!actualFinish || effectivePercentComplete(n, maps) >= 1;
        };
        const isActive = (n) => {
            const { actualStart } = getSanitizedActuals(n.ID, maps);
            const pct = effectivePercentComplete(n, maps);
            return (!!actualStart || pct > 0) && !isDone(n);
        };

        const floatEnvH = CONFIG.scopeFloatEnvelopeDays * CONFIG.workingHoursPerDay;
        const p50Finish = new Map();
        const p80Finish = new Map();
        // FIX M14: Track start dates so SS/SF links can use predecessor start
        const p50Start = new Map();
        const p80Start = new Map();

        const scopedOrder = [];
        for (const id of topoOrder) {
            if (scope.has(id)) scopedOrder.push(id);
        }

        for (const id of scopedOrder) {
            const n = nodeMap.get(id);
            if (!n) continue;

            const base = baseCache.get(id);
            if (!base) continue;

            if (isDone(n)) {
                const { actualFinish, actualStart: doneStart } = getSanitizedActuals(id, maps);
                const f = actualFinish || base.f;
                const s = doneStart || base.s;
                p50Finish.set(id, f);
                p80Finish.set(id, f);
                p50Start.set(id, s);
                p80Start.set(id, s);
                n.RiskP50Finish = f?.toISOString?.() || null;
                n.RiskP80Finish = f?.toISOString?.() || null;
                continue;
            }

            let s50 = base.s, s80 = base.s;
            const { actualStart } = getSanitizedActuals(id, maps);
            const started = !!actualStart || normalizePercentComplete(n.PercentComplete) > 0;

            // FIX M14: Pre-compute default duration for FF/SF back-calculation
            const baseRemHDefault = (typeof n.ExpectedRemainingHours === 'number' && n.ExpectedRemainingHours > 0)
                ? n.ExpectedRemainingHours
                : (typeof n.ExpectedDurationHours === 'number' && n.ExpectedDurationHours > 0)
                    ? n.ExpectedDurationHours * (1 - effectivePercentComplete(n, maps))
                    : Math.max(0, diffHours(base.s, base.f));

            if (!started) {
                const preds = predMap.get(id);
                if (preds) {
                    for (let i = 0; i < preds.length; i++) {
                        const pid = preds[i].source;
                        if (!scope.has(pid)) continue;
                        const rel = linkIndex.get(`${pid}|${id}`) || { type: 'FS', lagHrs: 0 };
                        // FIX M14: Respect link type instead of treating all as FS.
                        // SS/SF use predecessor start; FS/FF use predecessor finish.
                        const linkType = rel.type;
                        const useStart = (linkType === 'SS' || linkType === 'SF');

                        const pa50 = useStart ? p50Start.get(pid) : p50Finish.get(pid);
                        const pa80 = useStart ? p80Start.get(pid) : p80Finish.get(pid);

                        if (linkType === 'FF' || linkType === 'SF') {
                            // Constraint is on successor FINISH — derive start from finish - duration
                            if (pa50) {
                                const candF = addHours(pa50, rel.lagHrs);
                                const candS = subtractWorkingHours(candF, baseRemHDefault);
                                if (candS && candS > s50) s50 = candS;
                            }
                            if (pa80) {
                                const candF = addHours(pa80, rel.lagHrs);
                                const candS = subtractWorkingHours(candF, baseRemHDefault);
                                if (candS && candS > s80) s80 = candS;
                            }
                        } else {
                            // FS or SS: constraint is on successor START
                            if (pa50) {
                                const cand = addHours(pa50, rel.lagHrs);
                                if (cand && cand > s50) s50 = cand;
                            }
                            if (pa80) {
                                const cand = addHours(pa80, rel.lagHrs);
                                if (cand && cand > s80) s80 = cand;
                            }
                        }
                    }
                }
                s50 = maxDate(statusDate, s50);
                s80 = maxDate(statusDate, s80);
            } else {
                s50 = s80 = maxDate(statusDate, base.s);
            }

            const idx = computeRiskIndex(n);
            const imp = clamp01(+(n.ComputedImportanceScore) || 0);
            const tfH = getTotalFloatHours(n, slackMap);
            const floatFactor = clamp01(1 - tfH / (floatEnvH * 2));
            const impFactor = 0.15 + 0.85 * imp;
            let idxAdj = idx * floatFactor * impFactor;
            if (idxAdj < 0.08) idxAdj = 0;

            const activeM = isActive(n) ? CONFIG.activeRiskDampening : 1;
            const uplift50 = (CONFIG.p50BaseUplift + (CONFIG.p50MaxUplift - CONFIG.p50BaseUplift) * idxAdj) * activeM;
            const uplift80 = (CONFIG.p80BaseUplift + (CONFIG.p80MaxUplift - CONFIG.p80BaseUplift) * idxAdj) * activeM;

            const mult50 = clamp(1 + uplift50, 1, 1.6);
            const mult80 = clamp(1 + uplift80, 1, 2.2);

            let baseRemH;
            if (typeof n.ExpectedRemainingHours === 'number' && n.ExpectedRemainingHours > 0) {
                baseRemH = n.ExpectedRemainingHours;
            } else if (typeof n.ExpectedDurationHours === 'number' && n.ExpectedDurationHours > 0) {
                const pct = effectivePercentComplete(n, maps);
                baseRemH = n.ExpectedDurationHours * (1 - pct);
            } else {
                baseRemH = Math.max(0, diffHours(maxDate(statusDate, s50), base.f));
            }

            const f50 = addHours(s50, baseRemH * mult50);
            const f80 = addHours(s80, baseRemH * mult80);

            p50Finish.set(id, f50);
            p80Finish.set(id, f80);
            p50Start.set(id, s50);
            p80Start.set(id, s80);

            n.RiskP50Finish = f50?.toISOString?.() || null;
            n.RiskP80Finish = f80?.toISOString?.() || null;
        }

        const p50End = mc?.p50Finish || p50Finish.get(endId) || expected.expectedProjectFinish;
        const p80End = mc?.p80Finish || p80Finish.get(endId) || expected.expectedProjectFinish;

        return {
            p50Finish: p50End,
            p80Finish: p80End,
            p50FinishMap: p50Finish,
            p80FinishMap: p80Finish,
            p50ImpactDays: (p50End && expected.expectedProjectFinish) ? daysBetween(expected.expectedProjectFinish, p50End) : 0,
            p80ImpactDays: (p80End && expected.expectedProjectFinish) ? daysBetween(expected.expectedProjectFinish, p80End) : 0
        };
    }

    // =========================================================================
    // CRASH OPTIMIZER + LAG COMPRESSION
    // =========================================================================

    function classifyCrashProfile(name, supplierType) {
        // Supply chain override: external equipment/material can only be minimally expedited
        // (you cannot meaningfully accelerate a vendor's factory or a shipping route, only ~3-5%)
        if (supplierType === 'external_equipment') return { maxFrac: 0.03, kind: 'external_equipment' };
        if (supplierType === 'external_material') return { maxFrac: 0.05, kind: 'external_material' };
        if (supplierType === 'external_service') return { maxFrac: 0.10, kind: 'external_service' };

        const n = (name || '').toLowerCase();
        if (/permit|approval|regulat|review|sign/.test(n)) return { maxFrac: 0.08, kind: 'governance' };
        if (/procure|purchase|delivery|ship|vendor/.test(n)) return { maxFrac: 0.12, kind: 'procurement' };
        if (/design|engineer|ifc|draw|model/.test(n)) return { maxFrac: 0.18, kind: 'engineering' };
        if (/fabricat|shop|weld|machine|prefab/.test(n)) return { maxFrac: 0.22, kind: 'fabrication' };
        if (/install|erect|construct|civil|mech|elect|pipe/.test(n)) return { maxFrac: 0.28, kind: 'construction' };
        if (/test|commission|start.?up|turnover/.test(n)) return { maxFrac: 0.20, kind: 'commissioning' };
        return { maxFrac: CONFIG.maxCrashFractionDefault, kind: 'generic' };
    }

    function buildCrashOptions(nodes, maps, expected, risk, reachability, drivingChain) {
        const { nodeMap, slackMap, predMap } = maps;
        const plannedFinish = expected.plannedProjectFinish;
        const expectedFinish = expected.expectedProjectFinish;

        const overrunDays = (plannedFinish && expectedFinish) ? Math.max(0, daysBetween(plannedFinish, expectedFinish)) : 0;

        const riskBuffer = (risk?.p80Finish && expectedFinish) ? Math.max(0, daysBetween(expectedFinish, risk.p80Finish)) : 0;
        const targetDays = overrunDays > 0
            ? overrunDays + Math.min(CONFIG.maxRiskBufferDaysForRecovery, riskBuffer)
            : Math.min(CONFIG.maxRiskBufferDaysForRecovery, riskBuffer);
        const targetHours = targetDays * CONFIG.workingHoursPerDay;

        const chainSet = new Set((drivingChain || []).map(n => String(n.ID || n)));
        const scope = reachability.scopeToEnd;

        const crashCandidates = [];
        for (const id of scope) {
            const n = nodeMap.get(id);
            if (!n || isMilestone(n)) continue;
            const { actualFinish } = getSanitizedActuals(id, maps);
            if (actualFinish) continue;

            const durHrs = convertToHours(n.Duration, n.TimeUnits);
            if (durHrs <= 0) continue;

            const pct = normalizePercentComplete(n.PercentComplete);
            const remainingHrs = Math.max(0, durHrs * (1 - pct));
            if (remainingHrs < CONFIG.minCrashableHours) continue;

            const profile = classifyCrashProfile(n.Name, n.SupplierType || n.supplierType);
            const maxCrashHrs = remainingHrs * profile.maxFrac;
            if (maxCrashHrs < 8) continue;

            const isChain = chainSet.has(id);
            const floatDays = getTotalFloatHours(n, slackMap) / CONFIG.workingHoursPerDay;

            if (!isChain && floatDays > 10) continue;

            const importance = clamp(+(n.ComputedImportanceScore ?? 0), 0, 1);
            const leverage = isChain ? 1.0 : clamp(1 - floatDays / 12, 0.2, 0.75);
            const score = remainingHrs * leverage * (0.55 + 0.45 * importance);

            crashCandidates.push({
                id, name: n.Name || id, kind: profile.kind,
                remainingHrs, maxCrashHrs, leverage, isChain, floatDays, score
            });
        }
        crashCandidates.sort((a, b) => b.score - a.score);

        const lagCandidates = [];
        for (const id of scope) {
            const preds = predMap.get(id);
            if (!preds) continue;

            for (const edge of preds) {
                const pid = edge.source;
                if (!scope.has(pid)) continue;

                const lagHrs = edge.lagHrs || 0;
                if (lagHrs <= 0) continue;

                const lagDays = lagHrs / CONFIG.workingHoursPerDay;
                if (lagDays < CONFIG.minLagDaysForCompression) continue;

                const isChainEdge = chainSet.has(pid) && chainSet.has(id);
                if (!isChainEdge && lagDays < 5) continue;

                const leverage = isChainEdge ? 1.0 : 0.6;
                const potentialSavingsHrs = lagHrs * 0.5;
                const score = potentialSavingsHrs * leverage;

                lagCandidates.push({
                    id: `${pid}->${id}`,
                    source: pid,
                    target: id,
                    type: edge.type,
                    lagHrs,
                    lagDays: Math.round(lagDays),
                    potentialSavingsHrs,
                    isChainEdge,
                    leverage,
                    score
                });
            }
        }
        lagCandidates.sort((a, b) => b.score - a.score);

        const recoveryOptions = [];
        let remainingNeed = targetHours;
        let achievedHrs = 0;
        // When not in overrun, still show compressible activities for scenario planning
        const isScenarioMode = overrunDays <= 0;

        for (const c of crashCandidates) {
            if (isScenarioMode) {
                // In scenario mode, show all candidates up to maxRecoveryOptions
                if (recoveryOptions.length >= CONFIG.maxRecoveryOptions) break;
            } else {
                if (remainingNeed <= 0 || recoveryOptions.length >= CONFIG.maxRecoveryOptions) break;
            }

            const crashHrs = isScenarioMode ? c.maxCrashHrs : Math.min(c.maxCrashHrs, remainingNeed);
            if (crashHrs <= 0) continue;

            achievedHrs += crashHrs;
            remainingNeed -= crashHrs;
            const crashDays = crashHrs / CONFIG.workingHoursPerDay;

            recoveryOptions.push({
                id: 'crash_' + c.id,
                type: 'duration_crash',
                title: 'Crash: ' + c.name,
                targetActivityId: c.id,
                crashHours: Math.round(crashHrs),
                potentialSavingsDays: Math.max(1, Math.round(crashDays)),
                kind: c.kind,
                leverage: c.leverage,
                effort: crashDays >= 7 ? 'high' : crashDays >= 3 ? 'medium' : 'low',
                risk: c.score > 200 ? 'high' : 'medium',
                isOnDrivingChain: c.isChain,
                floatDays: Math.round(c.floatDays),
                rationale: [c.isChain ? 'On driving chain' : 'Near-critical', `${c.kind}`]
            });
        }

        const lagOptions = lagCandidates.slice(0, CONFIG.maxLagOptions).map((l, idx) => {
            const sourceNode = nodeMap.get(l.source);
            const targetNode = nodeMap.get(l.target);
            const sourceName = (sourceNode?.Name || l.source).substring(0, 35);
            const targetName = (targetNode?.Name || l.target).substring(0, 35);

            return {
                id: 'lag_' + idx,
                type: 'lag_compression',
                title: `${sourceName} → ${targetName}`,
                edgeId: l.id,
                sourceId: l.source,
                targetId: l.target,
                sourceName,
                targetName,
                relationType: l.type,
                currentLagHours: Math.round(l.lagHrs),
                currentLagDays: l.lagDays,
                potentialSavingsDays: Math.max(1, Math.round(l.potentialSavingsHrs / CONFIG.workingHoursPerDay)),
                isOnDrivingChain: l.isChainEdge,
                effort: 'low',
                risk: 'medium'
            };
        });

        // Build risk-weighted candidates BEFORE result object (synchronous)
        const crashCandidateIds = new Set(crashCandidates.map(c => c.id));
        const riskWeightedCandidates = buildRiskWeightedCandidates(
            maps.nodeMap, scope, maps, crashCandidateIds, CONFIG.maxRiskCandidates
        );

        const riskMitigationOptions = riskWeightedCandidates.map(c => ({
            ...c,
            id: 'risk_' + c.id,
            type: 'risk_mitigation',
            title: c.name,
            targetActivityId: c.id
        }));

        // Build result with enrichment state
        const result = {
            recoveryOptions,
            lagOptions,
            riskMitigationOptions,
            targetDays,
            achievedDays: Math.round(achievedHrs / CONFIG.workingHoursPerDay),
            notes: overrunDays > 0
                ? `Target: recover ${overrunDays}d delay` + (riskBuffer > 0 ? ` + ${Math.min(CONFIG.maxRiskBufferDaysForRecovery, riskBuffer)}d risk buffer` : '')
                : 'Scenario planning — compressible activities identified for proactive schedule management',
            // AI enrichment state
            _enrichmentPending: CONFIG.aiEnrichmentEnabled && crashCandidates.length > 0,
            _enrichmentComplete: false,
            _crashCandidates: crashCandidates,
            // Store references for recalculation
            _scope: scope,
            _maps: maps,
            _expected: expected
        };

        // Trigger async AI enrichment for BOTH crash and risk candidates
        if (CONFIG.aiEnrichmentEnabled) {
            result._enrichmentPromise = (async () => {
                try {
                    const projectContext = {
                        sector: inferProjectSector(crashCandidates),
                        overrunDays: Math.round((expected.expectedProjectFinish - expected.plannedProjectFinish) / MS_PER_DAY),
                        spreadDays: risk?.spreadDays || 0
                    };

                    // Parallel enrichment for both crash and risk
                    const [crashAssessments, riskAssessments] = await Promise.all([
                        crashCandidates.length > 0 ? requestCrashEnrichment(crashCandidates, projectContext) : Promise.resolve(new Map()),
                        riskWeightedCandidates.length > 0 ? requestRiskEnrichment(riskWeightedCandidates, projectContext) : Promise.resolve(new Map())
                    ]);

                    if (crashAssessments.size > 0) {
                        result.recoveryOptions = applyAIEnrichment(recoveryOptions, crashAssessments);
                        result._enrichmentComplete = true;
                        const newAchievedHrs = result.recoveryOptions.reduce((sum, o) => sum + (o.crashHours || 0), 0);
                        result.achievedDays = Math.round(newAchievedHrs / CONFIG.workingHoursPerDay);
                    }

                    if (riskAssessments.size > 0) {
                        result.riskMitigationOptions = applyRiskAIEnrichment(riskMitigationOptions, riskAssessments);
                        result._riskEnrichmentComplete = true;
                    }

                    console.log('[CompletionPrediction] AI enrichment complete');
                } catch (e) {
                    console.warn('[CompletionPrediction] Enrichment failed:', e);
                }
            })();
        }

        return result;
    }

    // ================================================================================
    // AI CRASH ENRICHMENT INTEGRATION
    // ================================================================================

    function isAbortLikeError(err) {
        if (!err) return false;
        if (err.name === 'AbortError' || err.code === 20) return true;
        const message = String(err.message || '').toLowerCase();
        return message.indexOf('aborted') >= 0 || message.indexOf('abort') >= 0;
    }

    /**
     * Request AI enrichment for crash candidates
     * @param {Array} crashCandidates - Raw crash candidates from buildCrashOptions
     * @param {Object} projectContext - Project metadata for context
     * @returns {Promise<Map>} - Map of candidate ID to AI assessment
     */
    async function requestCrashEnrichment(crashCandidates, projectContext) {
        if (!CONFIG.aiEnrichmentEnabled) return new Map();
        if (!crashCandidates || crashCandidates.length === 0) return new Map();

        // Filter to meaningful candidates
        const candidatesToEnrich = crashCandidates
            .filter(c => (c.remainingHrs / CONFIG.workingHoursPerDay) >= CONFIG.aiEnrichmentMinRemainingDays)
            .slice(0, CONFIG.aiEnrichmentMaxCandidates);

        if (candidatesToEnrich.length === 0) return new Map();

        if (!CONFIG.aiEnrichmentEndpoint) {
            console.info('[CompletionPrediction] AI enrichment endpoint not configured; skipping');
            return new Map();
        }

        console.log(`[CompletionPrediction] Requesting AI enrichment for ${candidatesToEnrich.length} crash candidates`);

        const payload = {
            candidates: candidatesToEnrich.map((c, idx) => ({
                index: idx + 1,
                id: c.id,
                name: c.name,
                kind: c.kind,
                remainingDays: Math.round(c.remainingHrs / CONFIG.workingHoursPerDay),
                isChain: c.isChain,
                floatDays: Math.round(c.floatDays),
                leverage: c.leverage
            })),
            projectContext: {
                type: projectContext?.type || 'capital project',
                sector: projectContext?.sector || inferProjectSector(crashCandidates),
                name: projectContext?.name || 'Project'
            }
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort('timeout'), CONFIG.aiEnrichmentTimeoutMs);

        try {
            const response = await fetch(CONFIG.aiEnrichmentEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            if (!response.ok) {
                console.warn(`[CompletionPrediction] AI enrichment failed: ${response.status}`);
                return new Map();
            }

            const result = await response.json();

            if (!result.ok || !result.assessments) {
                console.warn('[CompletionPrediction] AI enrichment returned invalid response');
                return new Map();
            }

            console.log(`[CompletionPrediction] AI enrichment complete: ${result.assessments.length} assessments, ${result.tokensUsed} tokens`);

            // Build lookup map by index (1-based from AI) to candidate ID
            const assessmentMap = new Map();
            for (const assessment of result.assessments) {
                const candidateIdx = (assessment.index || 0) - 1;
                if (candidateIdx >= 0 && candidateIdx < candidatesToEnrich.length) {
                    const candidateId = candidatesToEnrich[candidateIdx].id;
                    assessmentMap.set(candidateId, assessment);
                }
            }

            return assessmentMap;

        } catch (err) {
            if (isAbortLikeError(err)) {
                console.info('[CompletionPrediction] AI enrichment skipped due to timeout/cancel');
            } else {
                console.warn('[CompletionPrediction] AI enrichment error:', err.message);
            }
            return new Map();
        } finally {
            clearTimeout(timeoutId);
        }
    }
    // =========================================================================
    // AI RISK ENRICHMENT (Thinking Model)
    // =========================================================================

    async function requestRiskEnrichment(riskCandidates, projectContext) {
        if (!CONFIG.aiEnrichmentEnabled) return new Map();
        if (!riskCandidates || riskCandidates.length === 0) return new Map();

        const candidatesToEnrich = riskCandidates.slice(0, 15);

        if (!CONFIG.riskEnrichmentEndpoint) {
            console.info('[CompletionPrediction] Risk enrichment endpoint not configured; skipping');
            return new Map();
        }

        console.log(`[CompletionPrediction] Requesting AI risk enrichment for ${candidatesToEnrich.length} candidates`);

        const payload = {
            candidates: candidatesToEnrich.map((c, idx) => ({
                index: idx + 1,
                id: c.id,
                name: c.name,
                internalRisk: Math.round(c.internalRisk * 100),
                externalRisk: Math.round(c.externalRisk * 100),
                combinedRisk: Math.round(c.combinedRisk * 100),
                riskDriver: c.riskDriver,
                externalFactors: c.externalFactors,
                internalFactors: c.internalFactors,
                remainingDays: c.remainingDays,
                floatDays: c.floatDays,
                tis: Math.round(c.tis * 100)
            })),
            projectContext: {
                sector: projectContext?.sector || inferProjectSector(riskCandidates),
                type: 'capital project',
                overrunDays: projectContext?.overrunDays || 0,
                spreadDays: projectContext?.spreadDays || 0
            }
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort('timeout'), CONFIG.riskEnrichmentTimeoutMs); // thinking-model timeout

        try {
            const response = await fetch(CONFIG.riskEnrichmentEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            if (!response.ok) {
                console.warn(`[CompletionPrediction] Risk enrichment failed: ${response.status}`);
                return new Map();
            }

            const result = await response.json();
            if (!result.ok || !result.assessments) return new Map();

            console.log(`[CompletionPrediction] Risk enrichment complete: ${result.assessments.length} assessments`);

            const assessmentMap = new Map();
            for (const a of result.assessments) {
                const idx = (a.index || 0) - 1;
                if (idx >= 0 && idx < candidatesToEnrich.length) {
                    assessmentMap.set(candidatesToEnrich[idx].id, a);
                }
            }
            return assessmentMap;

        } catch (err) {
            if (isAbortLikeError(err)) {
                console.info('[CompletionPrediction] Risk enrichment skipped due to timeout/cancel');
            } else {
                console.warn('[CompletionPrediction] Risk enrichment error:', err.message);
            }
            return new Map();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    function applyRiskAIEnrichment(riskOptions, aiAssessments) {
        if (!aiAssessments || aiAssessments.size === 0) return riskOptions;

        return riskOptions.map(opt => {
            const activityId = opt.targetActivityId || opt.id.replace('risk_', '');
            const ai = aiAssessments.get(activityId);
            if (!ai) return opt;

            return {
                ...opt,
                aiEnriched: true,
                aiLikelihood: ai.likelihood || opt.urgency,
                aiLikelihoodScore: ai.likelihoodScore || 0,
                aiMitigations: ai.mitigations || [],
                aiRationale: ai.rationale || '',
                aiUrgency: ai.urgency || 'monitor',
                aiConfidence: ai.confidence || 0,
                // Replace heuristic mitigations with AI mitigations if available
                mitigations: ai.mitigations?.length > 0 ? ai.mitigations : opt.mitigations
            };
        });
    }
    /**
     * Infer project sector from activity names
     */
    function inferProjectSector(candidates) {
        const names = candidates.map(c => (c.name || '').toLowerCase()).join(' ');

        if (/refinery|petrochemical|lng|pipeline|offshore|upstream|downstream/.test(names)) return 'Oil & Gas';
        if (/pharma|gmp|cleanroom|bioreactor|fda/.test(names)) return 'Pharmaceutical';
        if (/substation|transmission|solar|wind|turbine|generator/.test(names)) return 'Power & Energy';
        if (/highway|bridge|tunnel|rail|transit/.test(names)) return 'Infrastructure';
        if (/warehouse|distribution|logistics|fulfillment/.test(names)) return 'Industrial';
        if (/hospital|healthcare|medical|clinic/.test(names)) return 'Healthcare';
        if (/data.?center|server|cooling|ups/.test(names)) return 'Data Center';
        if (/semiconductor|fab|cleanroom|wafer/.test(names)) return 'Semiconductor';

        return 'General Construction';
    }

    /**
     * Apply AI enrichment to crash options
     * @param {Array} recoveryOptions - Options from buildCrashOptions
     * @param {Map} aiAssessments - Map from requestCrashEnrichment
     * @returns {Array} - Enriched recovery options
     */
    function applyAIEnrichment(recoveryOptions, aiAssessments) {
        if (!aiAssessments || aiAssessments.size === 0) return recoveryOptions;

        return recoveryOptions.map(opt => {
            const assessment = aiAssessments.get(opt.targetActivityId);
            if (!assessment) return opt;

            // Apply AI adjustments
            const feasibility = clamp(assessment.crashFeasibility ?? 1.0, 0, 1);
            const maxCrashPct = clamp(assessment.maxCrashPercent ?? 25, 0, 50) / 100;

            // Recalculate crash potential based on AI assessment
            const originalCrashHours = opt.crashHours;
            const adjustedCrashHours = Math.round(originalCrashHours * feasibility);
            const adjustedSavingsDays = Math.max(1, Math.round(adjustedCrashHours / CONFIG.workingHoursPerDay));

            return {
                ...opt,
                crashHours: adjustedCrashHours,
                potentialSavingsDays: adjustedSavingsDays,
                // AI enrichment data
                aiEnriched: true,
                aiClassification: assessment.classification || opt.kind,
                aiFeasibility: feasibility,
                aiMechanism: assessment.crashMechanism,
                aiConstraints: assessment.constraints,
                aiConfidence: assessment.confidence ?? 0.5,
                aiRationale: assessment.rationale,
                // Update rationale to include AI insight
                rationale: [
                    ...(opt.rationale || []),
                    assessment.crashMechanism ? `AI: ${assessment.crashMechanism}` : null
                ].filter(Boolean)
            };
        }).filter(opt => opt.crashHours > 0); // Remove options with 0 crash potential
    }

    // =========================================================================
    // RISK-WEIGHTED CANDIDATES (High-risk activities not on driving chain)
    // =========================================================================

    function buildRiskWeightedCandidates(nodeMap, scope, maps, excludeIds, maxCandidates = 12) {
        if (!nodeMap || !scope || scope.size === 0) return [];

        const { slackMap } = maps || {};
        const candidates = [];
        const compoundAnalysisRisk = window.cybereumState?.compoundRiskAnalysis;

        for (const id of scope) {
            if (excludeIds?.has(id)) continue;

            const n = nodeMap.get(id);
            if (!n || isMilestone(n)) continue;

            const { actualFinish } = getSanitizedActuals(id, maps);
            if (actualFinish) continue;

            const internalRisk = clamp01(+(n.riskScore ?? n.ComputedRiskScore ?? 0));
            const externalRisk = applyCompoundAmplification(
                clamp01(+(n.externalScheduleRisk ?? n.ExternalScheduleRisk ?? 0)),
                compoundAnalysisRisk
            );

            const combinedRisk = 1 - (1 - internalRisk) * (1 - externalRisk);

            if (combinedRisk < CONFIG.minRiskScoreForCandidate) continue;

            const tis = clamp01(+(n.ComputedImportanceScore ?? n.TIS ?? 0));
            const isOutlier = n.isOnOutlierPath === true || n.IsOnOutlierPath === true;

            const durHrs = convertToHours(n.Duration, n.TimeUnits);
            if (durHrs <= 0) continue;

            const pct = normalizePercentComplete(n.PercentComplete);
            const remainingHrs = Math.max(0, durHrs * (1 - pct));
            if (remainingHrs < CONFIG.minCrashableHours) continue;

            const remainingDays = remainingHrs / CONFIG.workingHoursPerDay;
            const floatHrs = getTotalFloatHours(n, slackMap);
            const floatDays = floatHrs / CONFIG.workingHoursPerDay;
            const floatFactor = Math.max(0.15, 1 - (floatDays / 45));

            const tisWeight = 0.4 + 0.6 * (tis + (isOutlier ? 0.15 : 0));
            const impactScore = combinedRisk * remainingDays * floatFactor * tisWeight;

            const externalFactors = extractExternalRiskFactors(n);
            const internalFactors = extractInternalRiskFactors(n);

            let riskDriver = 'balanced';
            if (externalRisk > internalRisk + 0.12) riskDriver = 'external';
            else if (internalRisk > externalRisk + 0.12) riskDriver = 'internal';

            candidates.push({
                id, name: n.Name || id,
                internalRisk, externalRisk, combinedRisk, riskDriver,
                tis, isOutlier,
                isOnCriticalPath: n.isCritical || n.isOnCriticalPath || false,
                remainingDays: Math.round(remainingDays),
                floatDays: Math.round(floatDays),
                impactScore,
                externalFactors, internalFactors,
                allFactors: [...externalFactors, ...internalFactors].slice(0, 5),
                potentialDelayDays: Math.round(remainingDays * combinedRisk * (0.3 + 0.4 * tisWeight)),
                urgency: floatDays <= 5 && combinedRisk > 0.5 ? 'critical' :
                    floatDays <= 10 && combinedRisk > 0.35 ? 'high' : 'medium',
                mitigations: generateHeuristicMitigations(riskDriver, externalFactors, internalFactors)
            });
        }

        candidates.sort((a, b) => b.impactScore - a.impactScore);
        return candidates.slice(0, maxCandidates);
    }

    function extractExternalRiskFactors(node) {
        if (node.externalRiskFactors && Array.isArray(node.externalRiskFactors)) {
            return node.externalRiskFactors.slice(0, 4);
        }
        const factors = [];
        if ((node.supplyChainRisk ?? node.SupplyChainRisk) > 0.2) factors.push('Supply chain');
        if ((node.weatherRisk ?? node.WeatherRisk) > 0.2) factors.push('Weather');
        if ((node.regulatoryRisk ?? node.RegulatoryRisk) > 0.2) factors.push('Regulatory');
        if ((node.vendorRisk ?? node.VendorRisk) > 0.2) factors.push('Vendor dependency');
        if (factors.length > 0) return factors;

        const name = (node.Name || '').toLowerCase();
        if (/delivery|ship|transport|logistics/.test(name)) factors.push('Supply chain');
        if (/vendor|supplier|subcontract/.test(name)) factors.push('Vendor dependency');
        if (/permit|approval|regulatory/.test(name)) factors.push('Regulatory');
        if (/weather|offshore|marine/.test(name)) factors.push('Weather');
        return factors.length > 0 ? factors : ['External dependency'];
    }

    function extractInternalRiskFactors(node, maps) {
        const factors = [];

        const predCount = node.predecessorCount ?? node.PredecessorCount ?? 0;
        const succCount = node.successorCount ?? node.SuccessorCount ?? 0;

        if (predCount > 5) factors.push(`${predCount} predecessors`);
        if (succCount > 5) factors.push(`${succCount} successors`);

        const durHrs = convertToHours(node.Duration, node.TimeUnits);
        const durDays = durHrs / (CONFIG.workingHoursPerDay || 8);
        if (durDays > 60) factors.push('Long duration');

        const fcr = node.floatConsumptionRate ?? node.FloatConsumptionRate ?? 0;
        if (fcr > 0.4) factors.push('Float consumption');

        if (node.isCritical || node.isOnCriticalPath) factors.push('Critical path');
        else if (node.isOnOutlierPath) factors.push('Near-critical');

        if (node.isRiskOutlier || node.riskScore > 0.5) factors.push('High Risk');
        if (node.isImportanceOutlier || node.ImportanceScore > 0.5) factors.push('High Impact');

        if (node.resourceConstrained) factors.push('Resource constrained');

        return factors.length > 0 ? factors.slice(0, 4) : ['Schedule complexity'];
    }

    function generateHeuristicMitigations(riskDriver, extFactors, intFactors) {
        const mitigations = [];
        if (riskDriver !== 'internal') {
            for (const f of extFactors) {
                if (f.includes('Supply')) mitigations.push('Expedite vendor commitments');
                if (f.includes('Weather')) mitigations.push('Build weather contingency buffer');
                if (f.includes('Regulatory')) mitigations.push('Pre-submit for early review');
                if (f.includes('Vendor')) mitigations.push('Increase vendor oversight');
            }
        }
        if (riskDriver !== 'external') {
            for (const f of intFactors) {
                if (f.includes('predecessors')) mitigations.push('Add intermediate milestones');
                if (f.includes('Long duration')) mitigations.push('Break into smaller work packages');
                if (f.includes('Critical')) mitigations.push('Add resources to compress');
            }
        }
        return [...new Set(mitigations)].slice(0, 3);
    }

    function buildRiskMitigationPanel(riskOptions) {
        if (!riskOptions?.length) return '';

        const hasAI = riskOptions.some(o => o.aiEnriched);

        let html = `
            <div class="cp7-panel cp7-risk-mitigation">
                <h4>⚠️ Risk-Weighted Activities (${riskOptions.length})
                    ${hasAI ? '<span class="cp7-ai-badge">AI Enhanced</span>' : ''}
                </h4>
                <p class="cp7-subtitle">Click to apply mitigations and see impact on P20/P50/P80</p>
                <div class="cp7-risk-grid">`;

        for (const o of riskOptions) {
            const icon = o.riskDriver === 'external' ? '🌐' : o.riskDriver === 'internal' ? '🔧' : '⚖️';
            const urgencyBadge = (o.aiUrgency || o.urgency) === 'critical' || (o.aiUrgency || o.urgency) === 'immediate'
                ? '<span class="cp7-badge cp7-badge-critical">CRITICAL</span>'
                : (o.aiUrgency || o.urgency) === 'high' || (o.aiUrgency || o.urgency) === 'soon'
                    ? '<span class="cp7-badge cp7-badge-high-risk">HIGH</span>' : '';

            const aiRationale = o.aiRationale
                ? `<div class="cp7-ai-rationale">💡 ${o.aiRationale}</div>`
                : '';

            const mitigations = o.aiMitigations?.length > 0 ? o.aiMitigations : o.mitigations;

            html += `
                <div class="cp7-risk-card ${o.aiEnriched ? 'cp7-ai-enriched' : ''}" data-id="${o.id}">
                    <div class="cp7-risk-header">
                        <span>${icon}</span>
                        <span class="cp7-risk-title" title="${o.name}">${o.name.substring(0, 35)}${o.name.length > 35 ? '…' : ''}</span>
                        ${urgencyBadge}
                        ${o.aiEnriched ? '<span class="cp7-ai-badge">AI</span>' : ''}
                    </div>
                    ${aiRationale}
                    <div class="cp7-risk-scores">
                        <span class="cp7-tis-badge">TIS: ${Math.round(o.tis * 100)}%</span>
                        <span class="cp7-risk-score">${Math.round(o.combinedRisk * 100)}% risk</span>
                    </div>
                    <div class="cp7-risk-factors">
                        ${o.allFactors.map(f => `<span class="cp7-risk-factor">${f}</span>`).join('')}
                    </div>
                    <div class="cp7-risk-meta">
                        <span>${o.remainingDays}d rem</span>
                        <span class="${o.floatDays <= 5 ? 'cp7-float-critical' : ''}">${o.floatDays}d float</span>
                        <span class="cp7-risk-impact">⚡ ${o.potentialDelayDays}d impact</span>
                    </div>
                    <div class="cp7-risk-mitigations">
                        <div class="cp7-risk-mitigations-label">${o.aiEnriched ? '🤖 AI Mitigations:' : 'Suggested:'}</div>
                        ${mitigations.map(m => `<div class="cp7-risk-mitigation-item">→ ${m}</div>`).join('')}
                    </div>
                </div>`;
        }
        html += '</div></div>';
        return html;
    }

    // =========================================================================
    // DOWNSTREAM IMPACT VIEWER
    // =========================================================================

    function getDownstreamActivities(activityId, nodeMap, succMap, maxDepth = 10, maxActivities = 25) {
        if (!activityId || !nodeMap || !succMap) return [];

        const visited = new Set();
        const downstream = [];
        const queue = [{ id: activityId, depth: 0 }];

        while (queue.length > 0 && downstream.length < maxActivities) {
            const { id, depth } = queue.shift();
            if (visited.has(id) || depth > maxDepth) continue;
            visited.add(id);

            if (id === activityId) {
                const successors = succMap.get(id);
                if (successors) {
                    for (const edge of successors) queue.push({ id: edge.target, depth: depth + 1 });
                }
                continue;
            }

            const node = nodeMap.get(id);
            if (!node) continue;

            const expectedStart = safeDate(node.EarlyStart ?? node.earlyStart ?? node.PlannedStart);
            const expectedFinish = safeDate(node.EarlyFinish ?? node.earlyFinish ?? node.PlannedFinish);
            const baselineFinish = safeDate(node.PlannedFinish ?? node.plannedFinish);

            const finishVarianceDays = expectedFinish && baselineFinish
                ? Math.round((expectedFinish - baselineFinish) / (1000 * 60 * 60 * 24)) : null;

            const durHrs = convertToHours(node.Duration, node.TimeUnits);

            downstream.push({
                id, name: node.Name || id, depth,
                expectedStart, expectedFinish, finishVarianceDays,
                durationDays: Math.round(durHrs / CONFIG.workingHoursPerDay),
                isCritical: node.isCritical || node.isOnCriticalPath,
                successorCount: succMap.get(id)?.length || 0
            });

            const successors = succMap.get(id);
            if (successors) {
                for (const edge of successors) {
                    if (!visited.has(edge.target)) queue.push({ id: edge.target, depth: depth + 1 });
                }
            }
        }

        downstream.sort((a, b) => (a.expectedStart || 0) - (b.expectedStart || 0));
        return downstream;
    }

    function buildDownstreamPanel(sourceActivityName, downstream, containerId) {
        if (!downstream?.length) {
            return `<div class="cp7-panel cp7-downstream-panel" id="${containerId}-downstream">
                <h4>📊 Downstream Impact</h4>
                <p class="cp7-subtitle">Click any activity above to see downstream dependencies</p>
            </div>`;
        }

        const totalDownstream = downstream.length;
        const criticalCount = downstream.filter(d => d.isCritical).length;
        const delayedCount = downstream.filter(d => d.finishVarianceDays > 0).length;
        const maxDelay = Math.max(0, ...downstream.map(d => d.finishVarianceDays || 0));

        let html = `
            <div class="cp7-panel cp7-downstream-panel" id="${containerId}-downstream">
                <div class="cp7-downstream-header">
                    <h4>📊 Downstream Impact</h4>
                    <button class="cp7-close-btn" onclick="document.getElementById('${containerId}-downstream').innerHTML='<h4>📊 Downstream Impact</h4><p class=\\'cp7-subtitle\\'>Click any activity to see downstream</p>'">✕</button>
                </div>
                <p class="cp7-subtitle">Activities dependent on: <strong>${sourceActivityName}</strong></p>
                <div class="cp7-downstream-summary">
                    <span class="cp7-ds-stat"><span class="cp7-ds-stat-value">${totalDownstream}</span><span class="cp7-ds-stat-label">Downstream</span></span>
                    <span class="cp7-ds-stat"><span class="cp7-ds-stat-value cp7-critical">${criticalCount}</span><span class="cp7-ds-stat-label">Critical</span></span>
                    <span class="cp7-ds-stat"><span class="cp7-ds-stat-value ${delayedCount > 0 ? 'cp7-delayed' : ''}">${delayedCount}</span><span class="cp7-ds-stat-label">Delayed</span></span>
                    <span class="cp7-ds-stat"><span class="cp7-ds-stat-value ${maxDelay > 0 ? 'cp7-delayed' : ''}">${maxDelay > 0 ? '+' + maxDelay + 'd' : '—'}</span><span class="cp7-ds-stat-label">Max Slip</span></span>
                </div>
                <div class="cp7-downstream-table-wrapper">
                    <table class="cp7-table"><thead><tr>
                        <th>Activity</th><th>Exp Start</th><th>Exp Finish</th><th>Variance</th><th>Dur</th>
                    </tr></thead><tbody>`;

        for (const d of downstream) {
            const varianceHtml = d.finishVarianceDays > 0 ? `<span class="cp7-variance-late">+${d.finishVarianceDays}d</span>` :
                d.finishVarianceDays < 0 ? `<span class="cp7-variance-early">${d.finishVarianceDays}d</span>` :
                    d.finishVarianceDays === 0 ? '0d' : '—';

            html += `<tr class="${d.isCritical ? 'cp7-row-critical' : ''}">
                <td title="${d.name}">${d.name.substring(0, 30)}${d.name.length > 30 ? '…' : ''}${d.successorCount > 0 ? ` <span class="cp7-succ-count">+${d.successorCount}</span>` : ''}</td>
                <td>${d.expectedStart ? formatDateShort(d.expectedStart) : '—'}</td>
                <td>${d.expectedFinish ? formatDateShort(d.expectedFinish) : '—'}</td>
                <td>${varianceHtml}</td>
                <td>${d.durationDays}d</td>
            </tr>`;
        }

        html += '</tbody></table></div></div>';
        return html;
    }

    function showDownstreamImpact(activityId, activityName, maps, containerId) {
        const downstream = getDownstreamActivities(activityId, maps.nodeMap, maps.succMap);
        const panelHtml = buildDownstreamPanel(activityName, downstream, containerId);

        let panel = document.getElementById(`${containerId}-downstream`);
        if (panel) {
            panel.outerHTML = panelHtml;
        } else {
            const dashboard = document.getElementById(containerId);
            if (dashboard) {
                const wrapper = dashboard.querySelector('.cp7');
                if (wrapper) wrapper.insertAdjacentHTML('beforeend', panelHtml);
            }
        }
    }

    // =========================================================================
    // CURVES - v7.0 FIXED ACTUAL CALCULATION
    // =========================================================================

    function buildCurves(nodes, maps, expected, risk) {
        const { startNode, endNode, statusDate } = maps;

        const projectStart = clampDate(safeDate(startNode?.Start) || safeDate(startNode?.ActualStart) || findEarliestStart(nodes)) || statusDate;
        const plannedFinish = clampDate(expected.plannedProjectFinish || safeDate(endNode?.Finish)) || statusDate;
        const expectedFinish = clampDate(expected.expectedProjectFinish) || plannedFinish;
        const p20Finish = clampDate(risk?.p20Finish);
        const p50Finish = clampDate(risk?.p50Finish);
        const p80Finish = clampDate(risk?.p80Finish);

        const validDates = [statusDate];
        if (isValidDate(plannedFinish)) validDates.push(plannedFinish);
        if (isValidDate(expectedFinish)) validDates.push(expectedFinish);
        if (isValidDate(p20Finish)) validDates.push(p20Finish);
        if (isValidDate(p50Finish)) validDates.push(p50Finish);
        if (isValidDate(p80Finish)) validDates.push(p80Finish);

        const maxT = Math.max(...validDates.map(d => d.getTime()));
        const chartEnd = addDays(new Date(maxT), CONFIG.chartEndBufferDays);

        const chartSpanYears = (chartEnd - projectStart) / (365.25 * MS_PER_DAY);
        if (chartSpanYears > 50) {
            console.warn(`[CompletionPrediction] Chart span of ${chartSpanYears.toFixed(1)} years is unusually large.`);
        }

        // v7.0: Build node data with explicit status tracking
        const nodeData = [];
        let totalBudgetHours = 0;
        let completedHours = 0;
        let inProgressEarnedHours = 0;

        for (const n of nodes) {
            const durHrs = convertToHours(n.Duration, n.TimeUnits);
            if (durHrs <= 0) continue;
            totalBudgetHours += durHrs;

            const { actualStart, actualFinish } = getSanitizedActuals(n.ID, maps);
            const pct = effectivePercentComplete(n, maps);

            // Track actual progress for diagnostics
            if (actualFinish || pct >= 1) {
                completedHours += durHrs;
            } else if (actualStart || pct > 0) {
                inProgressEarnedHours += durHrs * pct;
            }

            nodeData.push({
                durHrs,
                pct,
                plannedStart: clampDate(safeDate(n.Start)),
                plannedFinish: clampDate(safeDate(n.Finish)),
                actualStart: clampDate(actualStart),
                actualFinish: clampDate(actualFinish),
                expectedStart: clampDate(safeDate(n.ExpectedStart)),
                expectedFinish: clampDate(safeDate(n.ExpectedFinish)),
                riskP50Finish: clampDate(safeDate(n.RiskP50Finish)),
                riskP80Finish: clampDate(safeDate(n.RiskP80Finish)),
                // v7.0: Explicit status flags
                isComplete: !!(actualFinish || pct >= 1),
                isInProgress: !!(actualStart || pct > 0) && !(actualFinish || pct >= 1),
                isNotStarted: !actualStart && pct === 0
            });
        }

        if (totalBudgetHours === 0) totalBudgetHours = 1;

        // v7.0: Correct actual percentage calculation
        const actualEarnedHours = completedHours + inProgressEarnedHours;
        const actualPct = (actualEarnedHours / totalBudgetHours) * 100;

        console.log('[CompletionPrediction] v7.0 Actual Progress Calculation:', {
            totalBudgetHours: Math.round(totalBudgetHours),
            completedHours: Math.round(completedHours),
            inProgressEarnedHours: Math.round(inProgressEarnedHours),
            actualEarnedHours: Math.round(actualEarnedHours),
            actualPct: actualPct.toFixed(1) + '%'
        });

        const totalDays = Math.max(1, Math.round((chartEnd - projectStart) / MS_PER_DAY));
        const stepDays = Math.max(1, Math.ceil(totalDays / CONFIG.maxCurveSamplePoints));

        const timeline = [];
        for (let d = new Date(projectStart); d <= chartEnd; d.setDate(d.getDate() + stepDays)) {
            timeline.push(new Date(d));
        }

        // Ensure the timeline contains an explicit point at the status date to avoid
        // a visual "gap" where Actual ends before the Data Date and Expected starts after.
        const statusTime = statusDate.getTime();
        if (!timeline.some(t => t.getTime() === statusTime)) {
            timeline.push(new Date(statusTime));
            timeline.sort((a, b) => a.getTime() - b.getTime());
        }

        // v7.0: Use corrected actual hours calculation
        const doneHoursAtStatus = actualEarnedHours;
        const statusPct = actualPct;

        const plannedCurve = [];
        const actualCurve = [];
        const expectedCurve = [];
        const riskP20Curve = [];
        const riskP50Curve = [];
        const riskP80Curve = [];

        const plannedTime = plannedFinish?.getTime() || Infinity;
        const expectedTime = expectedFinish?.getTime() || Infinity;
        const p20Time = p20Finish?.getTime() || Infinity;
        const p50Time = p50Finish?.getTime() || Infinity;
        const p80Time = p80Finish?.getTime() || Infinity;

        for (const t of timeline) {
            const tMs = t.getTime();

            // PLANNED curve - unchanged
            if (tMs <= plannedTime) {
                const h = computePlannedCumulativeHours(nodeData, tMs);
                plannedCurve.push({ x: t, y: clamp((h / totalBudgetHours) * 100, 0, 100) });
            }

            // v7.0: ACTUAL curve - use corrected calculation
            if (tMs <= statusTime) {
                const h = computeActualCumulativeHours(nodeData, tMs, statusTime);
                actualCurve.push({ x: t, y: clamp((h / totalBudgetHours) * 100, 0, 100) });
            }

            // EXPECTED curve - from status date onward
            if (tMs >= statusTime && tMs <= expectedTime) {
                const h = doneHoursAtStatus + computeRemainingHours(nodeData, tMs, statusTime, 'expected');
                expectedCurve.push({ x: t, y: clamp((h / totalBudgetHours) * 100, 0, 100) });
            }

            // P20 curve (optimistic) - same shape as expected but compressed in time
            // P20 finishes earlier, so progress at any given time is proportionally higher
            if (p20Finish && p20Time < Infinity && tMs >= statusTime && tMs <= p20Time) {
                const expectedDuration = expectedTime - statusTime;
                const p20Duration = p20Time - statusTime;

                if (expectedDuration > 0 && p20Duration > 0) {
                    // Map current time position to equivalent expected curve position
                    const p20Progress = (tMs - statusTime) / p20Duration;  // 0 to 1
                    const equivalentExpectedTime = statusTime + (p20Progress * expectedDuration);

                    // Get hours at the equivalent expected time
                    const h = doneHoursAtStatus + computeRemainingHours(nodeData, equivalentExpectedTime, statusTime, 'expected');
                    riskP20Curve.push({ x: t, y: clamp((h / totalBudgetHours) * 100, 0, 100) });
                }
            }

            // P50 curve
            if (tMs >= statusTime && tMs <= p50Time) {
                const h = doneHoursAtStatus + computeRemainingHours(nodeData, tMs, statusTime, 'riskP50');
                riskP50Curve.push({ x: t, y: clamp((h / totalBudgetHours) * 100, 0, 100) });
            }

            // P80 curve
            if (tMs >= statusTime && tMs <= p80Time) {
                const h = doneHoursAtStatus + computeRemainingHours(nodeData, tMs, statusTime, 'riskP80');
                riskP80Curve.push({ x: t, y: clamp((h / totalBudgetHours) * 100, 0, 100) });
            }
        }

        // Add final points
        if (plannedFinish) plannedCurve.push({ x: plannedFinish, y: 100 });
        if (expectedFinish) expectedCurve.push({ x: expectedFinish, y: 100 });
        if (p20Finish) riskP20Curve.push({ x: p20Finish, y: 100 });
        if (p50Finish) riskP50Curve.push({ x: p50Finish, y: 100 });
        if (p80Finish) riskP80Curve.push({ x: p80Finish, y: 100 });

        return {
            timeline, totalBudgetHours, statusDate, statusPct,
            projectStart, chartEnd, plannedFinish, expectedFinish, p20Finish, p50Finish, p80Finish,
            plannedCurve, actualCurve, expectedCurve, riskP20Curve, riskP50Curve, riskP80Curve,
            // v7.0: Additional diagnostics
            completedHours, inProgressEarnedHours, actualEarnedHours
        };
    }

    /**
     * v7.0: Compute planned cumulative hours at a given time
     */
    function computePlannedCumulativeHours(nodeData, targetMs) {
        let cum = 0;
        for (const nd of nodeData) {
            const sMs = nd.plannedStart?.getTime();
            const fMs = nd.plannedFinish?.getTime();

            if (!sMs || !fMs || sMs > targetMs) continue;

            if (targetMs >= fMs) {
                cum += nd.durHrs;
            } else {
                const span = fMs - sMs;
                if (span > 0) cum += nd.durHrs * ((targetMs - sMs) / span);
            }
        }
        return cum;
    }

    /**
     * v7.0: FIXED - Compute actual cumulative hours at a given time
     * 
     * Key fix: For in-progress activities, use PercentComplete instead of
     * assuming 100% complete just because we've reached the target time.
     */
    function computeActualCumulativeHours(nodeData, targetMs, statusMs) {
        let cum = 0;

        for (const nd of nodeData) {
            // Case 1: Activity is complete (has actualFinish)
            if (nd.actualFinish) {
                const fMs = nd.actualFinish.getTime();
                const sMs = nd.actualStart?.getTime() || fMs;

                if (targetMs >= fMs) {
                    // Past finish - add full duration
                    cum += nd.durHrs;
                } else if (targetMs >= sMs) {
                    // During execution - proportional
                    const span = fMs - sMs;
                    if (span > 0) {
                        cum += nd.durHrs * ((targetMs - sMs) / span);
                    }
                }
                continue;
            }

            // Case 2: Activity is in-progress (has actualStart but no actualFinish)
            if (nd.actualStart) {
                const sMs = nd.actualStart.getTime();

                if (targetMs >= sMs) {
                    // v7.0 FIX: Use PercentComplete for in-progress activities
                    // NOT the full duration just because we're past the start
                    if (targetMs >= statusMs) {
                        // At or past status date - use actual percent complete
                        cum += nd.durHrs * nd.pct;
                    } else {
                        // Before status date - interpolate from start to current pct
                        // This assumes linear progress from start to status date
                        const progressSpan = statusMs - sMs;
                        if (progressSpan > 0) {
                            const elapsed = targetMs - sMs;
                            const interpPct = nd.pct * (elapsed / progressSpan);
                            cum += nd.durHrs * Math.min(interpPct, nd.pct);
                        }
                    }
                }
                continue;
            }

            // P6 data quality gap: PercentComplete > 0 without ActualStart set.
            // Must include earned hours to avoid underreporting vs. status header.
            if (nd.pct > 0) {
                if (targetMs >= statusMs) {
                    cum += nd.durHrs * nd.pct;
                } else {
                    // Linearly prorate earned progress across planned window up to status date
                    const sMs = nd.plannedStart?.getTime();
                    if (sMs && targetMs >= sMs) {
                        const span = statusMs - sMs;
                        if (span > 0) {
                            cum += nd.durHrs * nd.pct * Math.min(1, (targetMs - sMs) / span);
                        }
                    }
                }
            }
        }

        return cum;
    }

    /**
     * Compute remaining hours progress for expected/risk curves
     */
    function computeRemainingHours(nodeData, targetMs, statusMs, mode) {
        let cum = 0;

        for (const nd of nodeData) {
            // Skip completed activities
            if (nd.isComplete) continue;

            // Calculate remaining hours
            const remaining = nd.isInProgress
                ? Math.max(0, nd.durHrs * (1 - nd.pct))
                : nd.durHrs;

            if (remaining <= 0) continue;

            let sMs, fMs;

            if (mode === 'expected') {
                sMs = Math.max(statusMs, nd.expectedStart?.getTime() || statusMs);
                fMs = nd.expectedFinish?.getTime() || sMs;
            } else if (mode === 'riskP20') {
                // P20 is optimistic - finishes ~12% faster than expected
                sMs = Math.max(statusMs, nd.expectedStart?.getTime() || statusMs);
                const expFinish = nd.expectedFinish?.getTime() || sMs;
                const optimisticDuration = (expFinish - sMs) * 0.88;
                fMs = sMs + optimisticDuration;
            } else if (mode === 'riskP50') {
                sMs = Math.max(statusMs, nd.expectedStart?.getTime() || statusMs);
                fMs = nd.riskP50Finish?.getTime() || nd.expectedFinish?.getTime() || sMs;
            } else if (mode === 'riskP80') {
                sMs = Math.max(statusMs, nd.expectedStart?.getTime() || statusMs);
                fMs = nd.riskP80Finish?.getTime() || nd.expectedFinish?.getTime() || sMs;
            } else {
                sMs = Math.max(statusMs, nd.expectedStart?.getTime() || statusMs);
                fMs = nd.expectedFinish?.getTime() || sMs;
            }

            if (targetMs <= sMs) continue;

            if (targetMs >= fMs) {
                cum += remaining;
            } else {
                const span = fMs - sMs;
                if (span > 0) cum += remaining * ((targetMs - sMs) / span);
            }
        }

        return cum;
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================

    function buildSummary(expected, risk, crashPlan, drivingChain, maps) {
        const planned = expected?.plannedProjectFinish ?? null;
        const exp = expected?.expectedProjectFinish ?? null;

        // Ensure variance is a finite number
        const varianceRaw = expected?.projectVariance;
        const variance = Number.isFinite(varianceRaw) ? varianceRaw : 0;

        const p80Impact = Number.isFinite(risk?.p80ImpactDays) ? risk.p80ImpactDays : 0;

        let primaryDriver = null;
        let maxContribution = 0;

        if (variance > 3 && Array.isArray(drivingChain) && drivingChain.length > 0) {
            for (const n of drivingChain) {
                const expF = safeDate(n?.ExpectedFinish);
                const plnF = safeDate(n?.Finish);
                if (!expF || !plnF) continue;

                const { actualFinish } = getSanitizedActuals(n.ID, maps);

                const slippage = daysBetween(plnF, expF);
                if (!Number.isFinite(slippage) || slippage <= 0) continue;

                const wasLate = !!(actualFinish && actualFinish > plnF);
                const isIncomplete = !actualFinish;

                if (slippage > maxContribution && (wasLate || isIncomplete)) {
                    maxContribution = slippage;
                    primaryDriver = {
                        id: n.ID,
                        name: n.Name || n.ID,
                        slippage: Math.round(slippage)
                    };
                }
            }
        }

        const driverText = primaryDriver
            ? `Primary Driver: ${primaryDriver.name} (+${primaryDriver.slippage}d)`
            : null;

        const base = {
            plannedFinish: planned,
            expectedFinish: exp,
            p50Finish: risk?.p50Finish,
            p80Finish: risk?.p80Finish,
            expectedVsPlanDays: variance,
            p80VsExpectedDays: p80Impact,
            primaryDriver
        };

        if (variance > 0) {
            const achievedDays = Number.isFinite(crashPlan?.achievedDays) ? crashPlan.achievedDays : 0;
            const targetDays = crashPlan?.targetDays;

            // If targetDays is not provided, we should not claim "recoverable".
            // Treat as unknown -> at_risk (or you can add a separate status like 'unknown').
            const canRecover = Number.isFinite(targetDays) ? (achievedDays >= targetDays) : false;

            return {
                ...base,
                status: canRecover ? 'recoverable' : 'at_risk',
                headline: `Project Late: +${Math.round(variance)} days`,
                detail: `Expected: ${formatDate(exp)}; Plan: ${formatDate(planned)}.${driverText ? ' ' + driverText : ''}`,
                cssClass: canRecover ? 'status-warning' : 'status-critical'
            };
        }

        if (variance < 0) {
            return {
                ...base,
                status: 'ahead',
                headline: `Project Ahead: ${Math.abs(Math.round(variance))} days`,
                detail: `Expected: ${formatDate(exp)}; Plan: ${formatDate(planned)}.`,
                cssClass: 'status-excellent'
            };
        }

        return {
            ...base,
            status: 'on_track',
            headline: 'Project On Track',
            detail: `Expected: ${formatDate(exp)}; Plan: ${formatDate(planned)}.`,
            cssClass: 'status-ok'
        };
    }


    // =========================================================================
    // RECOVERY ACTION CARD PAYLOAD
    // =========================================================================

    function buildRecoveryActionCardPayload(analysis) {
        const { expected, risk, crashPlan, maps } = analysis;
        const variance = expected.projectVariance;

        const actions = [];

        for (const opt of crashPlan.recoveryOptions || []) {
            actions.push({
                id: opt.id,
                type: 'CRASH',
                title: opt.title,
                activityId: opt.targetActivityId,
                savingsDays: opt.potentialSavingsDays,
                effort: opt.effort,
                risk: opt.risk,
                confidence: opt.isOnDrivingChain ? 'High' : 'Medium',
                lever: 'Duration Crash',
                rationale: opt.rationale?.join('; ') || ''
            });
        }

        for (const opt of crashPlan.lagOptions || []) {
            actions.push({
                id: opt.id,
                type: 'LAG_COMPRESS',
                title: opt.title,
                edgeId: opt.edgeId,
                savingsDays: opt.potentialSavingsDays,
                effort: opt.effort,
                risk: opt.risk,
                confidence: opt.isOnDrivingChain ? 'High' : 'Medium',
                lever: 'Lag Compression',
                rationale: opt.isOnDrivingChain ? 'On driving chain' : 'Near-critical path'
            });
        }

        return {
            schemaVersion: "1.0",
            generatedAtIso: new Date().toISOString(),
            statusDateIso: maps.statusDate?.toISOString(),
            headline: variance > 0 ? `${Math.round(variance)}d delay` : "On track",
            finish: {
                plannedIso: expected.plannedProjectFinish?.toISOString(),
                expectedIso: expected.expectedProjectFinish?.toISOString(),
                p50Iso: risk?.p50Finish?.toISOString(),
                p80Iso: risk?.p80Finish?.toISOString()
            },
            actions: actions.slice(0, 12)
        };
    }

    // =========================================================================
    // UI RENDERING - v7.0 with Fixed CSS Layout
    // =========================================================================
    function renderDashboard(containerId, analysis) {
        const el = document.getElementById(containerId);
        if (!el) return;

        if (!_stylesInjected) {
            injectStyles();
            _stylesInjected = true;
        }

        const canvasId = `${containerId}-chart`;

        const { expected, risk, summary, curves, activeActivities, crashPlan, maps, drivingChain } = analysis;
        const icon = summary.status === 'on_track' ? '✓' : summary.status === 'ahead' ? '⚡' : summary.status === 'recoverable' ? '⚠' : '❗';

        const varianceHtml = expected.projectVariance !== 0
            ? `<div class="${expected.projectVariance > 0 ? 'variance-negative' : 'variance-positive'}">
            Expected vs Plan: ${expected.projectVariance > 0 ? '+' : ''}${expected.projectVariance} days
           </div>`
            : '';

        const riskImpactHtml = (risk && risk.p80ImpactDays > 0)
            ? `<div style="opacity:0.7;font-size:12px;">Risk Buffer (P80): +${risk.p80ImpactDays} days</div>`
            : '';

        const activeFrontierHtml = buildEnhancedInProgressTable(activeActivities, maps, drivingChain);
        const recoveryHtml = buildEnhancedRecoveryPanel(crashPlan, expected.projectVariance > 0, containerId);
        const drivingChainHtml = buildDrivingChainSummary(drivingChain, maps);

        el.innerHTML = `
        <div class="cp7">
            <div class="cp7-status ${summary.cssClass}">
                <div class="cp7-icon">${icon}</div>
                <div class="cp7-status-text">
                    <h3>${summary.headline}</h3>
                    <p>${summary.detail}</p>
                </div>
                <div class="cp7-dates">
                    <div><strong>Data Date:</strong> ${formatDate(expected.statusDate)}</div>
                    <div><strong>Plan:</strong> ${formatDate(expected.plannedProjectFinish)}</div>
                    <div><strong>Expected:</strong> <span class="${expected.projectVariance > 0 ? 'variance-negative' : ''}">${formatDate(expected.expectedProjectFinish)}</span></div>
                    ${risk && risk.p20Finish ? `<div><strong>P20:</strong> <span class="p20">${formatDate(risk.p20Finish)}</span></div>` : ''}
                    ${risk && risk.p50Finish ? `<div><strong>P50:</strong> <span class="p50">${formatDate(risk.p50Finish)}</span></div>` : ''}
                    ${risk && risk.p80Finish ? `<div><strong>P80:</strong> <span class="p80">${formatDate(risk.p80Finish)}</span></div>` : ''}
                    ${buildConeSummaryHtml(risk)}
                    ${varianceHtml}
                    ${riskImpactHtml}
                    <div id="${containerId}-scenario-display" class="cp7-scenario" style="display:none;">
                        <strong>With Changes:</strong> <span id="${containerId}-scenario-date"></span>
                        <span id="${containerId}-scenario-savings" class="cp7-savings-badge"></span>
                    </div>
                </div>
            </div>
            
            <div class="cp7-panel cp7-chart-panel">
                <div style="text-align: center; margin-bottom: 16px;">
                    <div class="cyber-toggle">
                        <button class="toggle-btn active" id="${containerId}-scurve-tab" onclick="window._cpSwitchChartTab('${containerId}', 'scurve')">S-Curve</button>
                        <button class="toggle-btn" id="${containerId}-pdf-tab" onclick="window._cpSwitchChartTab('${containerId}', 'pdf')">Overrun Distribution</button>
                    </div>
                </div>
                <div id="${containerId}-scurve-panel" class="cp7-chart-tab-panel active">
                    <h4>S-Curve: Planned vs Actual vs Expected</h4>
                    <p class="cp7-subtitle">
                        Hours-weighted progress. Actual: ${curves.statusPct.toFixed(1)}% at status date.
                    </p>
                    <div class="cp7-chart-container">
                        <canvas id="${canvasId}"></canvas>
                    </div>
                </div>
                <div id="${containerId}-pdf-panel" class="cp7-chart-tab-panel" style="display:none;">
                    <h4>Overrun Probability Distribution</h4>
                    <p class="cp7-subtitle" id="${containerId}-pdf-chart-stats">
                        Schedule and cost overrun density from Monte Carlo simulation
                    </p>
                    <div class="cp7-chart-container">
                        <canvas id="${containerId}-pdf-chart"></canvas>
                    </div>
                </div>
            </div>
            
            <div class="cp7-grid">
                <div class="cp7-panel">
                    <h4>🔄 Active Frontier (${activeActivities.length})</h4>
                    <p class="cp7-subtitle">
                        Sorted by path priority and risk. 
                        <span class="cp7-legend">
                            <span class="cp7-badge cp7-badge-driving">D</span>Driving
                            <span class="cp7-badge cp7-badge-critical">C</span>Critical
                            <span class="cp7-badge cp7-badge-outlier">O</span>Outlier
                        </span>
                    </p>
                    ${activeFrontierHtml}
                </div>
                <div class="cp7-panel">
                    <h4>📍 Driving Chain (${drivingChain ? drivingChain.length : 0} activities)</h4>
                    <p class="cp7-subtitle">Critical path to completion</p>
                    <div id="${containerId}-driving-chain-table">${drivingChainHtml}</div>
                </div>
            </div>
            
            ${recoveryHtml}
            ${buildRiskMitigationPanel(crashPlan?.riskMitigationOptions)}
        </div>`;

        renderChart(canvasId, curves, analysis, containerId);
        renderPDFChart(`${containerId}-pdf-chart`, analysis);

        // Wire chart tab switching
        window._cpSwitchChartTab = function (cid, tab) {
            var scurvePanel = document.getElementById(cid + '-scurve-panel');
            var pdfPanel = document.getElementById(cid + '-pdf-panel');
            var scurveBtn = document.getElementById(cid + '-scurve-tab');
            var pdfBtn = document.getElementById(cid + '-pdf-tab');

            if (tab === 'scurve') {
                scurvePanel.style.display = '';
                scurvePanel.classList.add('active');
                pdfPanel.style.display = 'none';
                pdfPanel.classList.remove('active');
                scurveBtn.classList.add('active');
                pdfBtn.classList.remove('active');
            } else {
                scurvePanel.style.display = 'none';
                scurvePanel.classList.remove('active');
                pdfPanel.style.display = '';
                pdfPanel.classList.add('active');
                scurveBtn.classList.remove('active');
                pdfBtn.classList.add('active');
            }
        };

        wireRecoveryClicks(containerId, analysis);
        wireRiskMitigationClicks(containerId, analysis);
        // Wire downstream impact handlers
        wireDownstreamHandlers(containerId, maps);

        // Handle async AI enrichment update
        if (crashPlan._enrichmentPromise) {
            crashPlan._enrichmentPromise.then(() => {
                if (crashPlan._enrichmentComplete) {
                    console.log('[CompletionPrediction] Updating UI with AI-enriched crash options');

                    // Re-render just the recovery panel
                    const recoveryContainer = el.querySelector('.cp7-recovery');
                    if (recoveryContainer) {
                        const newRecoveryHtml = buildEnhancedRecoveryPanel(crashPlan, expected.projectVariance > 0, containerId);

                        // Create temp element to extract inner content
                        const temp = document.createElement('div');
                        temp.innerHTML = newRecoveryHtml;
                        const newPanel = temp.querySelector('.cp7-recovery');

                        if (newPanel) {
                            recoveryContainer.outerHTML = newPanel.outerHTML;
                            // Re-wire click handlers
                            wireRecoveryClicks(containerId, analysis);
                        }
                    }
                }
            }).catch(err => {
                console.warn('[CompletionPrediction] AI enrichment promise error:', err);
            });
        }
    }

    function injectStyles() {
        if (_stylesInjected) return;
        const common = (typeof window !== 'undefined' && window.CybereumDashCommon) ? window.CybereumDashCommon : null;
        const id = 'cp7-styles';

        // Resolve colors from design system, fallback to original values
        const P = (window.CybereumDesign && window.CybereumDesign.palette) || {};
        const T = (window.CybereumDesign && window.CybereumDesign.typography) || {};
        const _C = {
            text: P.text1 || '#cdfaff',
            text2: P.text2 || '#8ce6ff',
            muted: P.textTertiary || '#8ab4c4',
            success: P.success || '#50fa7b',
            danger: P.danger || '#ff5555',
            warning: P.warning || '#ffb86c',
            info: P.info || '#8be9fd',
            pink: P.pink || '#ff79c6',
            orange: P.orange || '#f97316',
            yellow: P.yellow || '#fbbf24',
            purple: P.purple || '#bd93f9',
            accent: P.accent || '#5ac8fa',
            font: T.body || "Inter, Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
            mono: T.mono || "'JetBrains Mono', 'Roboto Mono', monospace"
        };
        let cssText = `
            /* v7.1 CompletionPrediction Styles — CSS Custom Properties Architecture */
            .cp7 {
                /* ── Module-scoped tokens — cascade from :root via Common ── */
                --cp7-text: var(--cyb-text1, #cdfaff);
                --cp7-text2: var(--cyb-text2, #8ce6ff);
                --cp7-muted: var(--cyb-text3, #8ab4c4);
                --cp7-success: var(--cyb-success, #50fa7b);
                --cp7-danger: var(--cyb-danger, #ff5555);
                --cp7-warning: var(--cyb-warning, #ffb86c);
                --cp7-info: var(--cyb-info, #8be9fd);
                --cp7-pink: var(--cyb-pink, #ff79c6);
                --cp7-orange: var(--cyb-orange, #f97316);
                --cp7-yellow: var(--cyb-yellow, #fbbf24);
                --cp7-purple: var(--cyb-purple, #bd93f9);
                --cp7-accent: var(--cyb-accent, #5ac8fa);
                --cp7-border: var(--cyb-border, rgba(42,96,136,0.40));
                --cp7-bg-card: var(--cyb-bg-card, rgba(13,33,55,0.80));
                --cp7-font: var(--cyb-font-body, ${_C.font});
                --cp7-mono: var(--cyb-font-mono, ${_C.mono});
                font-family: var(--cp7-font);
                color: var(--cp7-text);
                padding: 20px;
                display: flex;
                flex-direction: column;
                gap: 16px;
            }
            
            /* Status Banner */
            .cp7-status {
                display: flex;
                padding: 20px;
                border-radius: 10px;
                background: rgba(14,36,70,0.5);
                border: 1px solid rgba(90,200,250,0.2);
                gap: 20px;
                align-items: center;
                flex-wrap: wrap;
            }
            .cp7-table {
                width: 100%;
                font-size: 12px;
                border-collapse: collapse;
            }
            .cp7-table th, .cp7-table td {
                padding: 6px 8px;
                text-align: left;
                border-bottom: 1px solid rgba(90,200,250,0.1);
            }
            .cp7-table th {
                color: #8ab4c4;
                font-weight: normal;
                font-size: 11px;
                text-transform: uppercase;
            }
            .cp7-lag-path {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
            }
            .cp7-lag-from, .cp7-lag-to {
                max-width: 120px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .cp7-lag-arrow {
                color: #8ab4c4;
                flex-shrink: 0;
            }
            .cp7-icon { font-size: 48px; flex-shrink: 0; }
            .cp7-status-text { flex: 1; min-width: 200px; }
            .cp7-status-text h3 { margin: 0 0 5px 0; font-size: 24px; }
            .cp7-status-text p { margin: 0; opacity: 0.8; font-size: 13px; }
            .cp7-dates { text-align: right; font-size: 12px; }
            .cp7-dates > div { margin-bottom: 2px; }
            
            /* Status variants */
            .cp7-status.status-ok { background: linear-gradient(135deg, rgba(80, 250, 123, 0.2), rgba(80, 250, 123, 0.05)); border-color: rgba(80, 250, 123, 0.4); }
            .cp7-status.status-excellent { background: linear-gradient(135deg, rgba(139, 233, 253, 0.2), rgba(139, 233, 253, 0.05)); border-color: rgba(139, 233, 253, 0.4); }
            .cp7-status.status-warning { background: linear-gradient(135deg, rgba(255, 184, 108, 0.2), rgba(255, 184, 108, 0.05)); border-color: rgba(255, 184, 108, 0.4); }
            .cp7-status.status-critical { background: linear-gradient(135deg, rgba(255, 85, 85, 0.2), rgba(255, 85, 85, 0.05)); border-color: rgba(255, 85, 85, 0.4); }
            
            .cp7 .p50 { color: #fbbf24; }
            .cp7 .p80 { color: #f97316; }
            .cp7 .variance-negative { color: #ff5555; font-weight: bold; }
            .cp7 .variance-positive { color: #50fa7b; font-weight: bold; }
            
            .cp7-scenario {
                margin-top: 8px;
                padding: 8px;
                background: rgba(255,121,198,0.1);
                border-left: 3px solid #ff79c6;
                border-radius: 4px;
            }
            .cp7-scenario span:first-of-type { color: #ff79c6; font-weight: bold; }
            .cp7-savings-badge {
                margin-left: 8px;
                padding: 2px 6px;
                background: rgba(80,250,123,0.2);
                color: #50fa7b;
                border-radius: 3px;
                font-size: 11px;
                font-weight: bold;
            }
            
            /* Panels */
            .cp7-panel {
                background: rgba(14,36,70,0.5);
                border: 1px solid rgba(90,200,250,0.2);
                border-radius: 8px;
                padding: 15px;
            }
            .cp7-panel h4 {
                margin: 0 0 5px 0;
                font-size: 14px;
                color: #8ce6ff;
            }
            .cp7-subtitle {
                margin: 0 0 12px 0;
                opacity: 0.7;
                font-size: 12px;
            }
            
            /* Chart Panel */
            .cp7-chart-panel {
                min-height: 400px;
            }
            .cp7-chart-container {
                height: 340px;
                position: relative;
            }
            .cp7-chart-container canvas {
                width: 100% !important;
                height: 100% !important;
            }

            /* Chart Tab Panels */
            .cp7-chart-tab-panel {
                display: none;
            }
            .cp7-chart-tab-panel.active {
                display: block;
            }

            /* Grid Layout */
            .cp7-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 16px;
            }
            @media (max-width: 1000px) {
                .cp7-grid { grid-template-columns: 1fr; }
            }
            .cp7-legend {
                margin-left: 8px;
                font-size: 10px;
            }
            .cp7-legend .cp7-badge {
                margin-left: 6px;
                margin-right: 2px;
                vertical-align: middle;
            }
            /* Tables */
            .cp7 table { width: 100%; font-size: 12px; border-collapse: collapse; }
            .cp7 th {
                text-align: left;
                color: #8ab4c4;
                font-weight: normal;
                font-size: 11px;
                text-transform: uppercase;
                padding: 8px 6px;
                border-bottom: 1px solid rgba(90,200,250,0.2);
                background: rgba(14, 36, 70, 0.95);
                position: sticky;
                top: 0;
            }
            .cp7 td { padding: 8px 6px; border-bottom: 1px solid rgba(90,200,250,0.1); }
            .cp7-table-wrapper { max-height: 260px; overflow: auto; }
            
            /* Badges */
            .cp7-badge {
                display: inline-block;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 10px;
                font-weight: bold;
                margin-right: 3px;
            }
            /* AI Enrichment Styles */
            .cp7-badge-ai {
                background: rgba(139, 233, 253, 0.3);
                color: #8be9fd;
                font-size: 10px;
                margin-left: 8px;
            }
            .cp7-badge-ai-pending {
                background: rgba(255, 184, 108, 0.2);
                color: #ffb86c;
                font-size: 10px;
                margin-left: 8px;
                animation: cybPulse 1.5s infinite;
            }
            /* @keyframes pulse removed — uses cybPulse from Common */
            .cp7-badge-ai-high {
                background: rgba(139, 233, 253, 0.3);
                color: #8be9fd;
                font-size: 9px;
                padding: 1px 4px;
            }
            .cp7-badge-ai-med {
                background: rgba(255, 184, 108, 0.3);
                color: #ffb86c;
                font-size: 9px;
                padding: 1px 4px;
            }
            .cp7-opt-limited {
                opacity: 0.6;
                border-left: 3px solid #ff5555;
            }
            .cp7-opt-constraint {
                font-size: 10px;
                color: #ffb86c;
                margin: 4px 0;
                padding: 4px 6px;
                background: rgba(255, 184, 108, 0.1);
                border-radius: 3px;
            }

            /* Lag path styles */
            .cp7-lag-path {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
            }
            .cp7-lag-from, .cp7-lag-to {
                max-width: 120px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .cp7-lag-arrow {
                color: #8ab4c4;
                flex-shrink: 0;
            }

            /* Legend styles */
            .cp7-legend {
                margin-left: 8px;
                font-size: 10px;
            }
            .cp7-legend .cp7-badge {
                margin-left: 6px;
                margin-right: 2px;
                vertical-align: middle;
            }

            /* Path badges */
            .cp7-badge-driving { background: rgba(255, 121, 198, 0.3); color: #ff79c6; }
            .cp7-badge-critical { background: rgba(255, 85, 85, 0.3); color: #ff5555; }
            .cp7-badge-outlier { background: rgba(249, 115, 22, 0.3); color: #f97316; }
            .cp7-badge-low-float { background: rgba(249, 115, 22, 0.3); color: #f97316; }
            .cp7-badge-high-risk { background: rgba(255, 85, 85, 0.25); color: #ff7777; }
            .cp7-badge-important { background: rgba(139, 233, 253, 0.3); color: #8be9fd; }
            .cp7-badge-active { background: rgba(80, 250, 123, 0.3); color: #50fa7b; }
            .cp7-badge-chain { background: rgba(255, 121, 198, 0.3); color: #ff79c6; }

            /* Cone of Uncertainty */
            .cp7-cone-summary { margin-top: 12px; padding: 10px; background: rgba(9,22,37,0.6); border: 1px solid rgba(90,200,250,0.2); border-radius: 6px; }
            .cp7-cone-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px; }
            .cp7-cone-spread { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: bold; }
            .cp7-confidence-high { background: rgba(80,250,123,0.2); color: #50fa7b; }
            .cp7-confidence-medium { background: rgba(251,191,36,0.2); color: #fbbf24; }
            .cp7-confidence-low { background: rgba(249,115,22,0.2); color: #f97316; }
            .cp7-confidence-critical { background: rgba(255,85,85,0.2); color: #ff5555; }
            .cp7-cone-bar { display: flex; align-items: center; height: 24px; font-size: 10px; }
            .cp7-cone-p20, .cp7-cone-p80 { padding: 2px 6px; border-radius: 3px; font-weight: bold; }
            .cp7-cone-p20 { background: rgba(80,250,123,0.3); color: #50fa7b; }
            .cp7-cone-p80 { background: rgba(249,115,22,0.3); color: #f97316; }
            .cp7-cone-fill { flex: 1; height: 8px; margin: 0 8px; background: linear-gradient(90deg, rgba(80,250,123,0.3), rgba(251,191,36,0.3), rgba(249,115,22,0.3)); border-radius: 4px; position: relative; }
            .cp7-cone-p50-marker { position: absolute; top: -4px; width: 3px; height: 16px; background: #fbbf24; border-radius: 2px; transform: translateX(-50%); }
            .cp7-cone-dates { display: flex; justify-content: space-between; font-size: 10px; color: #8ab4c4; margin-top: 4px; }
            .cp7-cone-date-p50 { color: #fbbf24; font-weight: bold; }
            .cp7-cone-interpretation { font-size: 11px; color: #8ab4c4; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(90,200,250,0.1); }
            .p20 { color: #50fa7b; }

            /* Risk-Weighted Panel */
            .cp7-risk-mitigation { margin-top: 16px; }
            .cp7-risk-mitigation h4 { color: #f97316; }
            .cp7-risk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
            .cp7-risk-card { padding: 12px; background: rgba(9,22,37,0.8); border: 1px solid rgba(249,115,22,0.25); border-radius: 6px; font-size: 12px; cursor: pointer; transition: all 0.2s; }
            .cp7-risk-card:hover { border-color: rgba(249,115,22,0.5); background: rgba(9,22,37,0.95); }
            .cp7-risk-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
            .cp7-risk-title { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .cp7-risk-scores { display: flex; gap: 12px; margin-bottom: 8px; }
            .cp7-tis-badge { padding: 2px 6px; background: rgba(139,92,246,0.2); color: #a78bfa; border-radius: 3px; font-size: 10px; font-weight: bold; }
            .cp7-risk-score { color: #f97316; font-weight: bold; }
            .cp7-risk-factors { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
            .cp7-risk-factor { padding: 2px 6px; background: rgba(90,200,250,0.1); border-radius: 3px; font-size: 10px; color: #8ab4c4; }
            .cp7-risk-meta { display: flex; gap: 12px; font-size: 11px; color: #8ab4c4; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid rgba(90,200,250,0.1); }
            .cp7-risk-impact { color: #f97316; }
            .cp7-float-critical { color: #ff5555; font-weight: bold; }
            .cp7-risk-mitigations { font-size: 11px; }
            .cp7-risk-mitigation-item { color: #50fa7b; padding: 2px 0; }
            .cp7-badge-high-risk { background: rgba(249,115,22,0.3); color: #f97316; }
            /* Risk mitigation selection */
            .cp7-risk-selected {
                border-color: #50fa7b !important;
                background: rgba(80, 250, 123, 0.15) !important;
                box-shadow: 0 0 10px rgba(80, 250, 123, 0.3);
            }
            .cp7-risk-selected::before {
                content: '✓';
                position: absolute;
                top: 8px;
                right: 8px;
                color: #50fa7b;
                font-weight: bold;
            }
            .cp7-risk-card { position: relative; }

            /* Mitigation impact banner */
            .cp7-mitigation-impact {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 20px;
                background: linear-gradient(90deg, rgba(80, 250, 123, 0.15), rgba(80, 250, 123, 0.05));
                border: 1px solid rgba(80, 250, 123, 0.3);
                border-radius: 8px;
                margin-bottom: 16px;
                color: #50fa7b;
                font-size: 13px;
            }
            .cp7-impact-dates {
                font-family: var(--cp7-mono);
                font-size: 12px;
            }

            /* AI enriched risk cards */
            .cp7-risk-card.cp7-ai-enriched {
                border-color: rgba(139, 233, 253, 0.3);
            }
            .cp7-ai-badge {
                background: rgba(139, 233, 253, 0.2);
                color: #8be9fd;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 9px;
                font-weight: bold;
            }
            .cp7-ai-rationale {
                font-size: 11px;
                color: #8be9fd;
                padding: 6px 8px;
                background: rgba(139, 233, 253, 0.1);
                border-radius: 4px;
                margin: 8px 0;
                font-style: italic;
            }
            /* Downstream Impact */
            .cp7-downstream-panel { margin-top: 16px; }
            .cp7-downstream-header { display: flex; justify-content: space-between; align-items: center; }
            .cp7-close-btn { background: rgba(255,85,85,0.2); border: none; color: #ff5555; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; }
            .cp7-downstream-summary { display: flex; gap: 24px; margin: 12px 0; padding: 10px 16px; background: rgba(9,22,37,0.5); border-radius: 6px; }
            .cp7-ds-stat { display: flex; flex-direction: column; align-items: center; }
            .cp7-ds-stat-value { font-size: 20px; font-weight: bold; color: #8be9fd; }
            .cp7-ds-stat-value.cp7-critical { color: #ff5555; }
            .cp7-ds-stat-value.cp7-delayed { color: #f97316; }
            .cp7-ds-stat-label { font-size: 10px; color: #8ab4c4; text-transform: uppercase; }
            .cp7-downstream-table-wrapper { max-height: 300px; overflow-y: auto; }
            .cp7-variance-late { color: #ff5555; font-weight: bold; }
            .cp7-variance-early { color: #50fa7b; }
            .cp7-succ-count { padding: 1px 5px; background: rgba(90,200,250,0.15); border-radius: 10px; font-size: 9px; color: #8ab4c4; }
            .cp7-row-critical { background: rgba(255,85,85,0.08) !important; }
            /* Recovery Section */
            .cp7-recovery h4 { color: #ff79c6; }
            .cp7-recovery-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                gap: 12px;
            }
            
            .cp7-opt {
                padding: 12px;
                background: rgba(9, 22, 37, 0.8);
                border: 1px solid rgba(90,200,250,0.2);
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                transition: all 0.2s ease;
            }
            .cp7-opt:hover {
                border-color: rgba(90, 200, 250, 0.5);
                transform: translateY(-2px);
            }
            .cp7-opt.selected {
                border-color: #ff79c6;
                background: rgba(255, 121, 198, 0.1);
            }

            .cp7-scn-nearcritical {
                margin-top: 14px;
                padding-top: 12px;
                border-top: 1px solid rgba(90,200,250,0.18);
            }
            .cp7-opt-header {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 6px;
            }
            .cp7-opt-icon { font-size: 18px; }
            .cp7-opt-title { flex: 1; font-weight: bold; }
            .cp7-opt-savings {
                background: rgba(80, 250, 123, 0.2);
                color: #50fa7b;
                padding: 2px 8px;
                border-radius: 4px;
                font-weight: bold;
            }
            .cp7-opt-desc { font-size: 11px; opacity: 0.8; margin-bottom: 8px; }
            .cp7-opt-meta { display: flex; gap: 8px; font-size: 10px; flex-wrap: wrap; }
            .cp7-opt-meta span { padding: 2px 6px; border-radius: 3px; }
            
            .cp7-effort-low, .cp7-risk-low { background: rgba(80, 250, 123, 0.2); color: #50fa7b; }
            .cp7-effort-medium, .cp7-risk-medium { background: rgba(255, 184, 108, 0.2); color: #ffb86c; }
            .cp7-effort-high, .cp7-risk-high { background: rgba(255, 85, 85, 0.2); color: #ff5555; }
            
            .cp7-opt-lag { border-left: 3px solid var(--cp7-muted); }
        `;
        // ── Palette bridge v3.0: hex → CSS custom property references ──
        // The .cp7 block defines --cp7-* vars that cascade from :root --cyb-*.
        // This bridge maps hardcoded hex in the template to var() references.
        // Result: runtime theme changes in :root propagate to all CP styles.
        const _hex = {
            '#8ab4c4': 'var(--cp7-muted)', '#8ce6ff': 'var(--cp7-text2)',
            '#cdfaff': 'var(--cp7-text)', '#50fa7b': 'var(--cp7-success)',
            '#ff5555': 'var(--cp7-danger)', '#ffb86c': 'var(--cp7-warning)',
            '#8be9fd': 'var(--cp7-info)', '#ff79c6': 'var(--cp7-pink)',
            '#f97316': 'var(--cp7-orange)', '#fbbf24': 'var(--cp7-yellow)',
            '#a78bfa': 'var(--cp7-purple)', '#ff7777': 'var(--cp7-danger)',
            '#5ac8fa': 'var(--cp7-accent)', '#bd93f9': 'var(--cp7-purple)'
        };
        for (const [k, v] of Object.entries(_hex)) cssText = cssText.split(k).join(v);
        // monospace bridge removed — now uses var(--cp7-mono) natively
        if (common && typeof common.ensureCss === 'function') {
            common.ensureCss(id, cssText);
        } else {
            if (!document.getElementById(id)) {
                const s = document.createElement('style');
                s.id = id;
                s.textContent = cssText;
                document.head.appendChild(s);
            }
        }
        _stylesInjected = true;
    }

    function buildEnhancedInProgressTable(actives, maps, drivingChain) {
        if (!actives || !actives.length) return '<p style="opacity:0.6;">No active activities</p>';

        const slackMap = maps?.slackMap;

        // Build driving chain lookup set
        const drivingChainIds = new Set(
            (drivingChain || []).map(n => String(n.ID || n))
        );

        // Sort: driving chain first, then critical, then lowest float, then highest risk
        const sorted = [...actives].sort((a, b) => {
            const aDriving = drivingChainIds.has(String(a.node.ID)) ? 1 : 0;
            const bDriving = drivingChainIds.has(String(b.node.ID)) ? 1 : 0;
            if (bDriving !== aDriving) return bDriving - aDriving;

            const aCrit = a.node.isCritical || a.node.isOnCriticalPath ? 1 : 0;
            const bCrit = b.node.isCritical || b.node.isOnCriticalPath ? 1 : 0;
            if (bCrit !== aCrit) return bCrit - aCrit;

            const aFloat = getTotalFloatHours(a.node, slackMap);
            const bFloat = getTotalFloatHours(b.node, slackMap);
            if (aFloat !== bFloat) return aFloat - bFloat;

            const aRisk = +(a.node.ComputedRiskScore || a.node.riskScore || 0);
            const bRisk = +(b.node.ComputedRiskScore || b.node.riskScore || 0);
            return bRisk - aRisk;
        });

        let html = '<div class="cp7-table-wrapper"><table><thead><tr>' +
            '<th>Activity</th>' +
            '<th>%</th>' +
            '<th>Planned Start</th>' +
            '<th>Planned Finish</th>' +
            '<th>Actual Start</th>' +
            '<th>Path</th>' +
            '<th>Float</th>' +
            '<th>Rem.</th>' +
            '</tr></thead><tbody>';

        for (const a of sorted) {
            const n = a.node;
            const id = String(n.ID);

            const pct = Math.round(normalizePercentComplete(n.PercentComplete) * 100);

            const plannedStart = safeDate(getNodePlannedStart(n));
            const plannedFinish = safeDate(getNodePlannedFinish(n));

            const { actualStart } = getSanitizedActuals(id, maps);
            const as = actualStart || a.actualStart || null;

            const floatDays = Math.round(getTotalFloatHours(n, slackMap) / CONFIG.workingHoursPerDay);

            const durHrs = convertToHours(n.Duration, n.TimeUnits);
            const remainingHrs = (typeof n.ExpectedRemainingHours === 'number' && n.ExpectedRemainingHours >= 0)
                ? n.ExpectedRemainingHours
                : Math.max(0, durHrs * (1 - normalizePercentComplete(n.PercentComplete)));
            const remDays = Math.max(0, Math.round(remainingHrs / CONFIG.workingHoursPerDay));

            // Build path badges
            const isOnDriving = drivingChainIds.has(id);
            const isOnCritical = n.isCritical === true || n.isOnCriticalPath === true;
            const isOnOutlier = n.isOnOutlierPath === true || n.IsOnOutlierPath === true;

            let pathBadges = '';
            if (isOnDriving) {
                pathBadges += '<span class="cp7-badge cp7-badge-driving" title="On Driving Path">D</span>';
            }
            if (isOnCritical) {
                pathBadges += '<span class="cp7-badge cp7-badge-critical" title="On Critical Path">C</span>';
            }
            if (isOnOutlier) {
                pathBadges += '<span class="cp7-badge cp7-badge-outlier" title="On Outlier Path">O</span>';
            }
            if (!pathBadges) {
                pathBadges = '<span style="opacity:0.4;">—</span>';
            }

            html += `<tr>
            <td data-id="${id}" title="${(n.Name || id)}">${(n.Name || id).substring(0, 42)}${(n.Name || '').length > 42 ? '...' : ''}</td>
            <td>${pct}%</td>
            <td>${plannedStart ? formatDate(plannedStart) : '—'}</td>
            <td>${plannedFinish ? formatDate(plannedFinish) : '—'}</td>
            <td>${as ? formatDate(as) : '—'}</td>
            <td>${pathBadges}</td>
            <td>${floatDays}d</td>
            <td>${remDays}d</td>
        </tr>`;
        }

        html += '</tbody></table></div>';
        return html;
    }

    function buildDrivingChainSummary(drivingChain, maps) {
        if (!drivingChain || !drivingChain.length) {
            return '<p style="opacity:0.6;">No driving chain identified</p>';
        }

        const relevant = drivingChain.filter(n => {
            const { actualFinish } = getSanitizedActuals(n.ID, maps);
            return !actualFinish && normalizePercentComplete(n.PercentComplete) < 1;
        }).slice(0, 15);

        if (!relevant.length) {
            return '<p style="opacity:0.6;">All driving activities complete</p>';
        }

        let html = '<div class="cp7-table-wrapper"><table><thead><tr>' +
            '<th>Activity</th>' +
            '<th>%</th>' +
            '<th>Planned Start</th>' +
            '<th>Planned Finish</th>' +
            '<th>Expected Finish</th>' +
            '<th>Duration</th>' +
            '</tr></thead><tbody>';

        for (const n of relevant) {
            const pct = Math.round(normalizePercentComplete(n.PercentComplete) * 100);
            const plS = safeDate(getNodePlannedStart(n));
            const plF = safeDate(getNodePlannedFinish(n));
            const expFinish = safeDate(n.ExpectedFinish);

            const durHrs = convertToHours(n.Duration, n.TimeUnits);
            const durDays = Math.round(durHrs / CONFIG.workingHoursPerDay);

            html += `<tr>
                <td title="${n.Name}">${(n.Name || n.ID).substring(0, 38)}${(n.Name || '').length > 38 ? '...' : ''}</td>
                <td>${pct}%</td>
                <td>${plS ? formatDate(plS) : '—'}</td>
                <td>${plF ? formatDate(plF) : '—'}</td>
                <td>${expFinish ? formatDate(expFinish) : '—'}</td>
                <td>${durDays}d</td>
            </tr>`;
        }

        html += '</tbody></table></div>';
        return html;
    }


    function buildEnhancedRecoveryPanel(plan, isOverrun, containerId) {
        if (!plan.recoveryOptions.length && !plan.lagOptions.length) {
            return `<div class="cp7-panel cp7-recovery">
            <h4>🔧 Recovery Options</h4>
            <p class="cp7-subtitle">${isOverrun ? `Target: ${plan.targetDays}d | Achievable: ${plan.achievedDays}d` : 'Project on schedule \u2014 options shown for proactive planning'}</p>
            <p style="opacity:0.6;">No viable recovery options identified for the current schedule.</p>
        </div>`;
        }

        // Check if any options have AI enrichment
        const hasAIEnrichment = plan.recoveryOptions.some(o => o.aiEnriched);
        const enrichmentBadge = hasAIEnrichment
            ? '<span class="cp7-badge cp7-badge-ai">AI Enhanced</span>'
            : (plan._enrichmentPending && !plan._enrichmentComplete ? '<span class="cp7-badge cp7-badge-ai-pending">AI analyzing...</span>' : '');

        const subtitleText = isOverrun
            ? `Target: ${plan.targetDays}d | Achievable: ${plan.achievedDays}d | Click to select`
            : `Scenario planning \u2014 ${plan.recoveryOptions.length + plan.lagOptions.length} compressible activities | Click to select`;

        let html = `<div class="cp7-panel cp7-recovery">
        <h4>🔧 Recovery Options (${plan.recoveryOptions.length + plan.lagOptions.length}) ${enrichmentBadge}</h4>
        <p class="cp7-subtitle">${subtitleText}</p>
        <div class="cp7-recovery-grid">`;

        for (const o of plan.recoveryOptions) {
            // Use AI classification if available, else fall back to heuristic
            const classification = o.aiClassification || o.kind;

            const icon = classification === 'constraint' ? '🚫' :
                classification === 'construction' ? '🏗️' :
                    classification === 'engineering' ? '📐' :
                        classification === 'procurement' ? '📦' :
                            classification === 'fabrication' ? '⚙️' :
                                classification === 'commissioning' ? '🔌' :
                                    classification === 'governance' ? '📋' : '⚡';

            // AI confidence badge
            const aiBadge = o.aiEnriched
                ? `<span class="cp7-badge ${o.aiConfidence >= 0.7 ? 'cp7-badge-ai-high' : 'cp7-badge-ai-med'}" title="AI Confidence: ${Math.round((o.aiConfidence || 0.5) * 100)}%">AI</span>`
                : '';

            // Constraint warning for low feasibility
            const constraintWarning = o.aiConstraints && (o.aiFeasibility || 1) < 0.3
                ? `<div class="cp7-opt-constraint">⚠️ ${o.aiConstraints}</div>`
                : '';

            // Description: prefer AI mechanism, then rationale
            const description = o.aiMechanism
                ? o.aiMechanism
                : (o.rationale ? o.rationale.filter(r => !r?.startsWith?.('AI:')).join(' • ') : 'Duration crash');

            // Dim low-feasibility options
            const limitedClass = o.aiEnriched && (o.aiFeasibility || 1) < 0.2 ? ' cp7-opt-limited' : '';

            html += `<div class="cp7-opt${limitedClass}" 
                      data-type="crash" 
                      data-kind="${classification}" 
                      data-days="${o.potentialSavingsDays}" 
                      data-id="${o.id}"
                      data-feasibility="${o.aiFeasibility ?? 1}">
            <div class="cp7-opt-header">
                <span class="cp7-opt-icon">${icon}</span>
                <span class="cp7-opt-title">${o.title.replace('Crash: ', '')}</span>
                ${aiBadge}
                <span class="cp7-opt-savings">-${o.potentialSavingsDays}d</span>
            </div>
            <div class="cp7-opt-desc">${description}</div>
            ${constraintWarning}
            <div class="cp7-opt-meta">
                <span class="cp7-effort-${o.effort}">Effort: ${o.effort}</span>
                <span class="cp7-risk-${o.risk}">Risk: ${o.risk}</span>
                ${o.isOnDrivingChain ? '<span class="cp7-badge-chain">Driving Chain</span>' : ''}
            </div>
        </div>`;
        }

        for (const o of plan.lagOptions) {
            html += `<div class="cp7-opt cp7-opt-lag" data-type="lag" data-days="${o.potentialSavingsDays}" data-id="${o.id}">
            <div class="cp7-opt-header">
                <span class="cp7-opt-icon">⏱️</span>
                <span class="cp7-opt-title">Compress ${o.currentLagDays}d ${o.relationType} Lag</span>
                <span class="cp7-opt-savings">-${o.potentialSavingsDays}d</span>
            </div>
            <div class="cp7-opt-desc cp7-lag-path">
                <span class="cp7-lag-from" title="${o.sourceName}">${o.sourceName}</span>
                <span class="cp7-lag-arrow">→</span>
                <span class="cp7-lag-to" title="${o.targetName}">${o.targetName}</span>
            </div>
            <div class="cp7-opt-meta">
                <span class="cp7-effort-${o.effort}">Effort: ${o.effort}</span>
                ${o.isOnDrivingChain ? '<span class="cp7-badge-chain">Driving Chain</span>' : ''}
            </div>
        </div>`;
        }

        // Scenario near-critical diagnostics
        if (containerId) {
            html += `</div>
            <div id="${containerId}-scenario-nearcritical" class="cp7-scn-nearcritical" style="display:none;"></div>
        </div>`;
        } else {
            html += '</div></div>';
        }

        return html;
    }

    // ============================================================================
    // PART 2: BUILD CONE OF UNCERTAINTY CURVES
    // ============================================================================
    //
    // The cone shows uncertainty narrowing as the project progresses.
    // Before status date: Actual data (no uncertainty)
    // After status date: Fan out from expected to P20/P80
    //
    // We approximate P20/P80 curves by time-scaling the expected curve.
    // ============================================================================

    /**
     * Build cone of uncertainty curves for chart visualization.
     * 
     * @param {Array} expectedCurve - The expected progress curve [{date, pct}, ...]
     * @param {Date} statusDate - Data date (where actual meets forecast)
     * @param {Object} risk - Monte Carlo results {p20Finish, p50Finish, p80Finish}
     * @param {Date} expectedFinish - Expected project finish date
     * @returns {Object} - {p20Curve, p80Curve} for chart datasets
     */
    function buildUncertaintyCone(expectedCurve, statusDate, risk, expectedFinish) {
        if (!expectedCurve || !expectedCurve.length || !risk) {
            return { p20Curve: [], p80Curve: [] };
        }

        const statusMs = statusDate?.getTime() || Date.now();
        const expectedFinishMs = expectedFinish?.getTime();
        const p20FinishMs = risk.p20Finish?.getTime();
        const p80FinishMs = risk.p80Finish?.getTime();

        if (!expectedFinishMs || !p20FinishMs || !p80FinishMs) {
            return { p20Curve: [], p80Curve: [] };
        }

        // Find the status date point in the curve (where cone starts)
        const statusPct = expectedCurve.find(p => p.date >= statusMs)?.pct || 0;

        // Duration from status to each finish
        const expectedDuration = expectedFinishMs - statusMs;
        const p20Duration = p20FinishMs - statusMs;
        const p80Duration = p80FinishMs - statusMs;

        if (expectedDuration <= 0) {
            return { p20Curve: [], p80Curve: [] };
        }

        // Scale factors for time compression/expansion
        const p20Scale = p20Duration / expectedDuration;  // < 1 (faster)
        const p80Scale = p80Duration / expectedDuration;  // > 1 (slower)

        const p20Curve = [];
        const p80Curve = [];

        for (const point of expectedCurve) {
            const pointMs = point.date;

            if (pointMs <= statusMs) {
                // Before status date: no uncertainty, curves converge
                // We don't add points here — cone starts at status date
                continue;
            }

            // Time elapsed since status date
            const elapsed = pointMs - statusMs;

            // Scale the elapsed time for P20/P80
            const p20Elapsed = elapsed * p20Scale;
            const p80Elapsed = elapsed * p80Scale;

            // Map back to dates
            const p20Date = statusMs + p20Elapsed;
            const p80Date = statusMs + p80Elapsed;

            // Progress at this point
            const pct = point.pct;

            // P20: same progress reached earlier
            p20Curve.push({ date: p20Date, pct });

            // P80: same progress reached later  
            p80Curve.push({ date: p80Date, pct });
        }

        // Ensure curves end at 100% at their respective finish dates
        if (p20Curve.length > 0 && p20Curve[p20Curve.length - 1].pct < 100) {
            p20Curve.push({ date: p20FinishMs, pct: 100 });
        }
        if (p80Curve.length > 0 && p80Curve[p80Curve.length - 1].pct < 100) {
            p80Curve.push({ date: p80FinishMs, pct: 100 });
        }

        // Add starting point at status date (cone apex)
        const startPoint = { date: statusMs, pct: statusPct };
        p20Curve.unshift(startPoint);
        p80Curve.unshift(startPoint);

        return { p20Curve, p80Curve };
    }

    function renderChart(canvasId, curves, analysis, containerId) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) {
            console.warn('[CompletionPrediction] Canvas not found:', canvasId);
            return;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx || typeof Chart === 'undefined') {
            console.warn('[CompletionPrediction] Chart.js not available');
            return;
        }

        const existingChart = Chart.getChart?.(canvas) || canvas._chartInstance;
        if (existingChart) existingChart.destroy();

        const datasets = [
            {
                label: 'Plan',
                data: curves.plannedCurve,
                borderColor: CONFIG.chartColors.planned,
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.1
            },
            {
                label: 'Actual',
                data: curves.actualCurve,
                borderColor: CONFIG.chartColors.actual,
                borderWidth: 3,
                pointRadius: 0,
                tension: 0.1
            },
            {
                label: 'Expected',
                data: curves.expectedCurve,
                borderColor: CONFIG.chartColors.expected,
                borderWidth: 2,
                borderDash: [5, 5],
                pointRadius: 0,
                tension: 0.1
            }
        ];

        // P20 curve (optimistic - green dashed)
        if (curves.riskP20Curve && curves.riskP20Curve.length > 0) {
            datasets.push({
                label: 'P20 (Optimistic)',
                data: curves.riskP20Curve,
                borderColor: CONFIG.chartColors.riskP20,
                borderWidth: 1.5,
                borderDash: [4, 4],
                pointRadius: 0,
                tension: 0.1,
                order: 5
            });
        }

        // P50 curve
        if (curves.riskP50Curve && curves.riskP50Curve.length > 0) {
            datasets.push({
                label: 'P50',
                data: curves.riskP50Curve,
                borderColor: CONFIG.chartColors.riskP50,
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.1,
                order: 4
            });
        }

        // P80 curve with cone fill to P20
        if (curves.riskP80Curve && curves.riskP80Curve.length > 0) {
            datasets.push({
                label: 'P80 (Risk)',
                data: curves.riskP80Curve,
                borderColor: CONFIG.chartColors.riskP80,
                borderWidth: 1.5,
                backgroundColor: 'rgba(251, 191, 36, 0.08)',
                fill: curves.riskP20Curve?.length > 0 ? '-2' : false,
                pointRadius: 0,
                tension: 0.1,
                order: 3
            });
        }

        const chart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        labels: { color: CONFIG.chartColors.text, boxWidth: 12, padding: 15 }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(14, 36, 70, 0.95)',
                        titleColor: CONFIG.chartColors.text,
                        bodyColor: CONFIG.chartColors.text,
                        borderColor: 'rgba(90, 200, 250, 0.3)',
                        borderWidth: 1
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: 'month' },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: CONFIG.chartColors.text }
                    },
                    y: {
                        min: 0,
                        max: 100,
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: CONFIG.chartColors.text, callback: v => v + '%' }
                    }
                }
            }
        });

        canvas._chartInstance = chart;
    }

    // =========================================================================
    // PDF (Probability Distribution Function) — Overrun Distribution Chart
    // =========================================================================

    /**
     * Gaussian kernel density estimation.
     * Returns an array of {x, y} points representing the estimated PDF.
     */
    function kernelDensityEstimate(samples, bandwidth, nPoints, xMin, xMax) {
        const points = [];
        const step = (xMax - xMin) / (nPoints - 1);
        const n = samples.length;
        const bw = bandwidth || 0.06;
        const coeff = 1 / (n * bw * Math.sqrt(2 * Math.PI));

        for (let i = 0; i < nPoints; i++) {
            const x = xMin + i * step;
            let sum = 0;
            for (let j = 0; j < n; j++) {
                const z = (x - samples[j]) / bw;
                sum += Math.exp(-0.5 * z * z);
            }
            points.push({ x: x, y: coeff * sum });
        }
        return points;
    }

    /**
     * Build histogram bins from samples.
     * Returns array of {x (bin center), y (density)} objects.
     */
    function buildHistogram(samples, nBins, xMin, xMax) {
        if (xMax <= xMin) {
            // All samples identical — return a single bin with density 1
            return { bars: [{ x: xMin, y: 1 }], binWidth: 1 };
        }
        const binWidth = (xMax - xMin) / nBins;
        const counts = new Array(nBins).fill(0);
        const n = samples.length;

        for (let i = 0; i < n; i++) {
            let bin = Math.floor((samples[i] - xMin) / binWidth);
            if (bin < 0) bin = 0;
            if (bin >= nBins) bin = nBins - 1;
            counts[bin]++;
        }

        const bars = [];
        for (let i = 0; i < nBins; i++) {
            bars.push({
                x: xMin + (i + 0.5) * binWidth,
                y: counts[i] / (n * binWidth) // probability density
            });
        }
        return { bars, binWidth };
    }

    /**
     * Render the Probability Distribution Function (PDF) chart
     * showing schedule overrun distribution from Monte Carlo samples.
     */
    function renderPDFChart(canvasId, analysis) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) {
            console.warn('[CompletionPrediction] PDF canvas not found:', canvasId);
            return;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx || typeof Chart === 'undefined') {
            console.warn('[CompletionPrediction] Chart.js not available for PDF chart');
            return;
        }

        const existingChart = Chart.getChart?.(canvas) || canvas._chartInstance;
        if (existingChart) existingChart.destroy();

        const { mc, expected, nodes, maps } = analysis;

        // --- Build schedule overrun samples from Monte Carlo ---
        const plannedFinishMs = expected.plannedProjectFinish ? expected.plannedProjectFinish.getTime() : null;
        const projectStartMs = maps.startNode
            ? (safeDate(maps.startNode.Start || maps.startNode.PlannedStart) || maps.statusDate).getTime()
            : maps.statusDate.getTime();
        // Clamp to at least 1 day (86400000 ms) to avoid division by zero/negative
        const rawDurationMs = plannedFinishMs ? (plannedFinishMs - projectStartMs) : 0;
        const plannedDurationMs = Math.max(rawDurationMs, 86400000);

        let scheduleOverruns = [];
        if (mc && mc.finishSamples && mc.finishSamples.length > 0 && plannedFinishMs) {
            scheduleOverruns = mc.finishSamples.map(function (finishMs) {
                return (finishMs - plannedFinishMs) / plannedDurationMs;
            });
        }

        // --- Build cost overrun estimates from project-level EVM CPI ---
        let costOverruns = [];
        var evmMetrics = window.evmMetrics || (window.cybereumState && window.cybereumState.evmMetrics);
        if (evmMetrics) {
            var projectCPI = parseFloat(
                (evmMetrics.actual && evmMetrics.actual.CPIcum) ||
                (evmMetrics.forecasted && evmMetrics.forecasted.CPIcum) ||
                evmMetrics.CPI ||
                evmMetrics.cpi
            );
            // Only use CPI in realistic range (0.3 to 3.0) to avoid chart blowout
            if (isFinite(projectCPI) && projectCPI >= 0.3 && projectCPI <= 3.0) {
                var baseCostOverrun = (1 / projectCPI) - 1;
                var nSamples = scheduleOverruns.length || 500;
                for (var si = 0; si < nSamples; si++) {
                    // Spread proportional to distance from 1.0 (more uncertainty when CPI is further from ideal)
                    var spread = Math.abs(1 - projectCPI) * 0.5 + 0.05;
                    var noise = (Math.random() - 0.5) * spread * 2;
                    costOverruns.push(Math.max(-0.99, baseCostOverrun + noise));
                }
            }
        }

        // If still no cost data, skip cost series
        var hasCost = costOverruns.length > 10;
        var hasSchedule = scheduleOverruns.length > 10;

        if (!hasSchedule && !hasCost) {
            // Show message instead of empty chart
            canvas.parentElement.innerHTML =
                '<div style="padding: 60px 20px; text-align: center; color: #8ab4c4;">' +
                '<p><strong style="color: #cdfaff;">Overrun Distribution</strong></p>' +
                '<p>Insufficient data. Run Monte Carlo simulation to generate distribution.</p>' +
                '</div>';
            return;
        }

        // --- Compute statistics ---
        function mean(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }
        function pctAbove(arr, v) { var c = 0; for (var i = 0; i < arr.length; i++) if (arr[i] > v) c++; return c / arr.length; }

        var schedMean = hasSchedule ? mean(scheduleOverruns) : 0;
        var costMean = hasCost ? mean(costOverruns) : 0;
        var schedPctDelayed = hasSchedule ? pctAbove(scheduleOverruns, 0) : 0;
        var costPctOver = hasCost ? pctAbove(costOverruns, 0) : 0;

        // --- Build histogram and KDE ---
        var allSamples = scheduleOverruns.concat(costOverruns);
        var dataMin = Math.min.apply(null, allSamples);
        var dataMax = Math.max.apply(null, allSamples);
        var range = dataMax - dataMin;
        var xMin = dataMin - range * 0.1;
        var xMax = dataMax + range * 0.1;
        var nBins = Math.min(40, Math.max(15, Math.round(Math.sqrt(allSamples.length))));

        var datasets = [];

        // Compute bar thickness in pixels from the number of bars that will actually render.
        // When range <= 0, buildHistogram collapses to a single bin, so size for one bar.
        var chartWidth = canvas.parentElement ? canvas.parentElement.clientWidth : 800;
        var effectiveBinCount = range > 0 ? nBins : 1;
        var barThickness = Math.max(4, Math.floor(chartWidth / effectiveBinCount * 0.85));

        // Schedule overrun histogram + KDE
        if (hasSchedule) {
            var schedHist = buildHistogram(scheduleOverruns, nBins, xMin, xMax);
            var schedBandwidth = range > 0 ? range / 12 : 0.06;
            var schedKDE = kernelDensityEstimate(scheduleOverruns, schedBandwidth, 200, xMin, xMax);

            datasets.push({
                type: 'bar',
                label: 'Schedule Overrun',
                data: schedHist.bars.map(function (b) { return { x: b.x, y: b.y }; }),
                backgroundColor: 'rgba(70, 185, 250, 0.4)',
                borderColor: 'rgba(70, 185, 250, 0.6)',
                borderWidth: 1,
                barThickness: barThickness,
                maxBarThickness: barThickness + 4,
                order: 2
            });

            datasets.push({
                type: 'line',
                label: 'Schedule KDE',
                data: schedKDE,
                borderColor: CONFIG.chartColors.planned,
                borderWidth: 2.5,
                pointRadius: 0,
                tension: 0.4,
                fill: false,
                order: 1
            });
        }

        // Cost overrun histogram + KDE
        if (hasCost) {
            var costHist = buildHistogram(costOverruns, nBins, xMin, xMax);
            var costBandwidth = range > 0 ? range / 12 : 0.06;
            var costKDE = kernelDensityEstimate(costOverruns, costBandwidth, 200, xMin, xMax);

            datasets.push({
                type: 'bar',
                label: 'Cost Overrun',
                data: costHist.bars.map(function (b) { return { x: b.x, y: b.y }; }),
                backgroundColor: 'rgba(255, 184, 108, 0.4)',
                borderColor: 'rgba(255, 184, 108, 0.6)',
                borderWidth: 1,
                barThickness: barThickness,
                maxBarThickness: barThickness + 4,
                order: 2
            });

            datasets.push({
                type: 'line',
                label: 'Cost KDE',
                data: costKDE,
                borderColor: CONFIG.chartColors.expected,
                borderWidth: 2.5,
                pointRadius: 0,
                tension: 0.4,
                fill: false,
                order: 1
            });
        }

        // --- Reference-class data (Flyvbjerg megaproject benchmarks) ---
        var REFERENCE_CLASS = {
            'Nuclear storage': { costOverrun: 2.38, scheduleOverrun: 0.65 },
            'Olympic Games': { costOverrun: 1.57, scheduleOverrun: 1.00 },
            'Nuclear power PWR': { costOverrun: 0.95, scheduleOverrun: 0.61 },
            'Nuclear power BWR': { costOverrun: 1.79, scheduleOverrun: 0.63 },
            'Nuclear power PHWR': { costOverrun: 1.60, scheduleOverrun: 1.25 },
            'Hydroelectric dams': { costOverrun: 0.75, scheduleOverrun: 0.18 },
            'IT': { costOverrun: 0.73, scheduleOverrun: 0.37 },
            'Buildings': { costOverrun: 0.62, scheduleOverrun: 0.20 },
            'Aerospace': { costOverrun: 0.60, scheduleOverrun: 0.57 },
            'Defense': { costOverrun: 0.53, scheduleOverrun: 0.22 },
            'Rail': { costOverrun: 0.39, scheduleOverrun: 0.43 },
            'Airports': { costOverrun: 0.39, scheduleOverrun: 0.62 },
            'Tunnels': { costOverrun: 0.37, scheduleOverrun: 0.34 },
            'Oil and gas': { costOverrun: 0.34, scheduleOverrun: 0.37 },
            'Ports': { costOverrun: 0.32, scheduleOverrun: 0.67 },
            'Hospitals, health': { costOverrun: 0.29, scheduleOverrun: 0.41 },
            'Mining': { costOverrun: 0.27, scheduleOverrun: 0.00 },
            'Bridges': { costOverrun: 0.26, scheduleOverrun: 0.00 },
            'Data Center': { costOverrun: 0.25, scheduleOverrun: 0.32 },
            'Water': { costOverrun: 0.20, scheduleOverrun: 0.32 },
            'Roads': { costOverrun: 0.16, scheduleOverrun: 0.63 },
            'Fossil thermal power': { costOverrun: 0.16, scheduleOverrun: 0.62 },
            'Bus rapid transit': { costOverrun: 0.40, scheduleOverrun: 0.10 },
            'Cruise Ship Terminal': { costOverrun: 0.15, scheduleOverrun: 0.25 },
            'Pipelines': { costOverrun: 0.14, scheduleOverrun: 0.37 },
            'Wind power': { costOverrun: 0.13, scheduleOverrun: 0.10 },
            'NOA Wind': { costOverrun: 0.30, scheduleOverrun: 0.35 },
            'Energy transmission': { costOverrun: 0.08, scheduleOverrun: 0.08 },
            'Solar power': { costOverrun: 0.01, scheduleOverrun: 0.01 }
        };

        // Look up sector benchmark
        var projectInfo = window.cybereumState && window.cybereumState.project;
        var sectorName = projectInfo ? projectInfo.segment : null;
        var sectorRef = sectorName ? REFERENCE_CLASS[sectorName] : null;

        // Compute cross-sector averages for general reference
        var refKeys = Object.keys(REFERENCE_CLASS);
        var avgSchedRef = 0, avgCostRef = 0;
        for (var ri = 0; ri < refKeys.length; ri++) {
            avgSchedRef += REFERENCE_CLASS[refKeys[ri]].scheduleOverrun;
            avgCostRef += REFERENCE_CLASS[refKeys[ri]].costOverrun;
        }
        avgSchedRef /= refKeys.length;
        avgCostRef /= refKeys.length;

        // --- Build Chart.js annotation plugin config for reference lines ---
        var annotationConfig = {};
        var hasAnnotationPlugin = Chart.registry && Chart.registry.plugins && Chart.registry.plugins.get('annotation');

        if (hasAnnotationPlugin) {
            var annotations = {
                zeroLine: {
                    type: 'line',
                    xMin: 0,
                    xMax: 0,
                    borderColor: 'rgba(255, 255, 255, 0.4)',
                    borderWidth: 1,
                    borderDash: [4, 4],
                    label: {
                        display: true,
                        content: 'On Time / On Budget',
                        position: 'start',
                        color: '#cdfaff',
                        font: { size: 10 }
                    }
                }
            };

            if (sectorRef) {
                if (hasSchedule && sectorRef.scheduleOverrun > 0) {
                    annotations.sectorSchedule = {
                        type: 'line',
                        xMin: sectorRef.scheduleOverrun,
                        xMax: sectorRef.scheduleOverrun,
                        borderColor: 'rgba(70, 185, 250, 0.6)',
                        borderWidth: 2,
                        borderDash: [6, 3],
                        label: {
                            display: true,
                            content: sectorName + ' Avg Sched +' + (sectorRef.scheduleOverrun * 100).toFixed(0) + '%',
                            position: 'start',
                            color: CONFIG.chartColors.planned,
                            font: { size: 9 },
                            backgroundColor: 'rgba(9, 22, 37, 0.8)',
                            padding: 3
                        }
                    };
                }
                if (hasCost && sectorRef.costOverrun > 0) {
                    annotations.sectorCost = {
                        type: 'line',
                        xMin: sectorRef.costOverrun,
                        xMax: sectorRef.costOverrun,
                        borderColor: 'rgba(255, 184, 108, 0.6)',
                        borderWidth: 2,
                        borderDash: [6, 3],
                        label: {
                            display: true,
                            content: sectorName + ' Avg Cost +' + (sectorRef.costOverrun * 100).toFixed(0) + '%',
                            position: 'end',
                            color: CONFIG.chartColors.expected,
                            font: { size: 9 },
                            backgroundColor: 'rgba(9, 22, 37, 0.8)',
                            padding: 3
                        }
                    };
                }
            }

            annotationConfig = { annotation: { annotations: annotations } };
        }

        // --- Custom plugin: draw reference-class markers even without annotation plugin ---
        var refLinePlugin = {
            id: 'refClassLines',
            afterDraw: function (chart) {
                var xAxis = chart.scales.x;
                var yAxis = chart.scales.y;
                var ctx2 = chart.ctx;
                if (!xAxis || !yAxis) return;

                function drawRefLine(xVal, color, label, yPos) {
                    var xPx = xAxis.getPixelForValue(xVal);
                    if (xPx < xAxis.left || xPx > xAxis.right) return;
                    ctx2.save();
                    ctx2.beginPath();
                    ctx2.setLineDash([6, 3]);
                    ctx2.strokeStyle = color;
                    ctx2.lineWidth = 1.5;
                    ctx2.moveTo(xPx, yAxis.top);
                    ctx2.lineTo(xPx, yAxis.bottom);
                    ctx2.stroke();
                    ctx2.setLineDash([]);
                    // Label
                    ctx2.font = '10px "Roboto Mono", monospace';
                    ctx2.fillStyle = color;
                    ctx2.textAlign = 'center';
                    ctx2.fillText(label, xPx, yAxis.top + yPos);
                    ctx2.restore();
                }

                // Always draw zero line
                drawRefLine(0, 'rgba(255,255,255,0.35)', 'On Time', 12);

                // Sector reference lines (only if annotation plugin is NOT available)
                if (!hasAnnotationPlugin && sectorRef) {
                    if (hasSchedule && sectorRef.scheduleOverrun > 0) {
                        drawRefLine(sectorRef.scheduleOverrun, 'rgba(70, 185, 250, 0.7)',
                            sectorName + ' +' + (sectorRef.scheduleOverrun * 100).toFixed(0) + '%', 24);
                    }
                    if (hasCost && sectorRef.costOverrun > 0) {
                        drawRefLine(sectorRef.costOverrun, 'rgba(255, 184, 108, 0.7)',
                            sectorName + ' +' + (sectorRef.costOverrun * 100).toFixed(0) + '%', 36);
                    }
                }
            }
        };

        var chart = new Chart(ctx, {
            type: 'bar',
            data: { datasets: datasets },
            plugins: [refLinePlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'nearest', intersect: false },
                plugins: Object.assign({
                    legend: {
                        labels: {
                            color: CONFIG.chartColors.text,
                            boxWidth: 12,
                            padding: 15,
                            filter: function (item) {
                                return item.text.indexOf('KDE') === -1;
                            }
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(14, 36, 70, 0.95)',
                        titleColor: CONFIG.chartColors.text,
                        bodyColor: CONFIG.chartColors.text,
                        borderColor: 'rgba(90, 200, 250, 0.3)',
                        borderWidth: 1,
                        callbacks: {
                            title: function (items) {
                                if (items.length > 0) {
                                    var v = items[0].parsed.x;
                                    return 'Overrun: ' + (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
                                }
                                return '';
                            },
                            label: function (item) {
                                return item.dataset.label + ': ' + item.parsed.y.toFixed(3);
                            }
                        }
                    }
                }, annotationConfig),
                scales: {
                    x: {
                        type: 'linear',
                        title: {
                            display: true,
                            text: 'Overrun',
                            color: CONFIG.chartColors.text,
                            font: { family: 'Orbitron, sans-serif', size: 12 }
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: {
                            color: CONFIG.chartColors.text,
                            callback: function (v) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + '%'; }
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Probability Density',
                            color: CONFIG.chartColors.text,
                            font: { family: 'Orbitron, sans-serif', size: 12 }
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        ticks: { color: CONFIG.chartColors.text },
                        beginAtZero: true
                    }
                }
            }
        });

        canvas._chartInstance = chart;

        // Update stats text
        var statsEl = document.getElementById(canvasId + '-stats');
        if (statsEl) {
            var parts = [];
            if (hasSchedule) {
                parts.push(
                    '<span style="color: ' + CONFIG.chartColors.planned + '; font-weight: bold;">Avg. schedule overrun: ' +
                    (schedMean >= 0 ? '+' : '') + (schedMean * 100).toFixed(1) + '%</span>'
                );
            }
            if (hasCost) {
                parts.push(
                    '<span style="color: ' + CONFIG.chartColors.expected + '; font-weight: bold;">Avg. cost overrun: ' +
                    (costMean >= 0 ? '+' : '') + (costMean * 100).toFixed(1) + '%</span>'
                );
            }
            if (hasSchedule || hasCost) {
                var delayPct = hasSchedule ? (schedPctDelayed * 100).toFixed(0) : '—';
                var overPct = hasCost ? (costPctOver * 100).toFixed(0) : '—';
                parts.push(
                    '<span style="color: #8ab4c4; font-size: 11px;">' +
                    delayPct + '% of simulations delayed' +
                    (hasCost ? ', ' + overPct + '% over budget' : '') +
                    '</span>'
                );
            }
            // Reference-class benchmark (HTML-escape sectorName to prevent XSS)
            if (sectorRef && sectorName) {
                var safeSector = sectorName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                parts.push(
                    '<span style="color: #bd93f9; font-size: 11px;">Reference class (' + safeSector + '): ' +
                    'schedule +' + (sectorRef.scheduleOverrun * 100).toFixed(0) + '%, ' +
                    'cost +' + (sectorRef.costOverrun * 100).toFixed(0) + '% (Flyvbjerg)</span>'
                );
            }
            statsEl.innerHTML = parts.join('<br>');
        }
    }

    function wireRiskMitigationClicks(containerId, analysis) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const selectedMitigations = new Set();

        container.querySelectorAll('.cp7-risk-card').forEach(card => {
            card.addEventListener('click', async (e) => {
                // Toggle selection
                const id = card.dataset.id;
                if (!id) return;

                if (selectedMitigations.has(id)) {
                    selectedMitigations.delete(id);
                    card.classList.remove('cp7-risk-selected');
                } else {
                    selectedMitigations.add(id);
                    card.classList.add('cp7-risk-selected');
                }

                // Recalculate Monte Carlo with mitigations -- backend-first
                // with JS fallback (see recalculateWithMitigationsAsync).
                if (selectedMitigations.size > 0) {
                    try {
                        const newRisk = await recalculateWithMitigationsAsync(
                            analysis, selectedMitigations);
                        updateRiskDisplay(containerId, newRisk, selectedMitigations.size);
                    } catch (err) {
                        console.warn('[CompletionPrediction] Async mitigation recalc failed; using sync path:', err);
                        const newRisk = recalculateWithMitigations(analysis, selectedMitigations);
                        updateRiskDisplay(containerId, newRisk, selectedMitigations.size);
                    }
                } else {
                    // Restore original
                    updateRiskDisplay(containerId, analysis.risk, 0);
                }
            });
        });
    }

    // =========================================================================
    // RISK MITIGATION SCENARIO CALCULATION
    // =========================================================================

    /**
     * Recalculate Monte Carlo with selected risk mitigations applied.
     * Mitigating a risk reduces that activity's risk score by a factor.
     */
    function recalculateWithMitigations(analysis, selectedMitigationIds) {
        if (!selectedMitigationIds || selectedMitigationIds.size === 0) {
            return analysis.risk; // No change
        }

        const { nodes, links, maps, expected, reachability, drivingChain } = analysis;

        // Create modified node map with reduced risk scores
        const modifiedNodeMap = new Map(maps.nodeMap);

        for (const [id, node] of modifiedNodeMap) {
            const mitigationId = 'risk_' + id;
            if (selectedMitigationIds.has(mitigationId)) {
                // Mitigating reduces risk by 60%
                const originalInternal = +(node.riskScore ?? node.ComputedRiskScore ?? 0);
                const originalExternal = +(node.externalScheduleRisk ?? node.ExternalScheduleRisk ?? 0);

                modifiedNodeMap.set(id, {
                    ...node,
                    riskScore: originalInternal * 0.4,
                    ComputedRiskScore: originalInternal * 0.4,
                    externalScheduleRisk: originalExternal * 0.4,
                    ExternalScheduleRisk: originalExternal * 0.4,
                    _mitigated: true
                });
            }
        }

        // Create modified maps
        const modifiedMaps = { ...maps, nodeMap: modifiedNodeMap };

        // Re-run Monte Carlo with mitigated risks
        const newRisk = runMonteCarloRemaining(
            nodes, links, modifiedMaps, expected, reachability, drivingChain,
            { seed: CONFIG.monteCarloSeed + selectedMitigationIds.size } // Different seed for variety
        );

        return newRisk;
    }

    // -------------------------------------------------------------------------
    // Backend-aware mitigation recalculation.  Identical shape to
    // recalculateWithMitigations() but awaits the /completion/monte-carlo
    // endpoint (with JS fallback) so mitigated-risk P20/P50/P80s stay
    // consistent with the initial analysis.
    // -------------------------------------------------------------------------
    async function recalculateWithMitigationsAsync(analysis, selectedMitigationIds) {
        if (!selectedMitigationIds || selectedMitigationIds.size === 0) {
            return analysis.risk;
        }

        const { nodes, links, maps, expected, reachability, drivingChain } = analysis;

        // The backend reads risk from node.riskScore / node.ComputedRiskScore
        // directly, so we build a modified *nodes list* (parallel to the
        // modifiedNodeMap) rather than trying to serialise a Map.  Nodes not
        // in the mitigation set pass through unchanged by reference.
        const modifiedNodeMap = new Map(maps.nodeMap);
        const modifiedNodes = (nodes || []).map((n) => {
            const mitigationId = 'risk_' + String(n.ID);
            if (!selectedMitigationIds.has(mitigationId)) return n;
            const originalInternal = +(n.riskScore ?? n.ComputedRiskScore ?? 0);
            const originalExternal = +(n.externalScheduleRisk ?? n.ExternalScheduleRisk ?? 0);
            const mitigated = {
                ...n,
                riskScore: originalInternal * 0.4,
                ComputedRiskScore: originalInternal * 0.4,
                externalScheduleRisk: originalExternal * 0.4,
                ExternalScheduleRisk: originalExternal * 0.4,
                _mitigated: true
            };
            modifiedNodeMap.set(String(n.ID), mitigated);
            return mitigated;
        });

        const modifiedMaps = { ...maps, nodeMap: modifiedNodeMap };

        return await runMonteCarloRemainingAsync(
            modifiedNodes, links, modifiedMaps, expected, reachability, drivingChain,
            { seed: CONFIG.monteCarloSeed + selectedMitigationIds.size }
        );
    }

    function updateRiskDisplay(containerId, risk, mitigationCount) {
        const container = document.getElementById(containerId);
        if (!container) return;

        // Update P20/P50/P80 dates
        const datesDiv = container.querySelector('.cp7-dates');
        if (datesDiv) {
            const p20El = datesDiv.querySelector('.p20')?.parentElement;
            const p50El = datesDiv.querySelector('.p50')?.parentElement;
            const p80El = datesDiv.querySelector('.p80')?.parentElement;

            if (p20El && risk.p20Finish) {
                p20El.innerHTML = `<strong>P20:</strong> <span class="p20">${formatDate(risk.p20Finish)}</span>`;
            }
            if (p50El && risk.p50Finish) {
                p50El.innerHTML = `<strong>P50:</strong> <span class="p50">${formatDate(risk.p50Finish)}</span>`;
            }
            if (p80El && risk.p80Finish) {
                p80El.innerHTML = `<strong>P80:</strong> <span class="p80">${formatDate(risk.p80Finish)}</span>`;
            }

            // Update cone summary
            const coneEl = container.querySelector('.cp7-cone-summary');
            if (coneEl) {
                coneEl.outerHTML = buildConeSummaryHtml(risk);
            }
        }

        // Show mitigation impact banner
        let impactBanner = container.querySelector('.cp7-mitigation-impact');
        if (mitigationCount > 0) {
            const spreadReduction = risk.spreadDays ? `Spread: ${risk.spreadDays}d` : '';
            const bannerHtml = `
                <div class="cp7-mitigation-impact">
                    <span>🛡️ ${mitigationCount} mitigation${mitigationCount > 1 ? 's' : ''} applied</span>
                    <span class="cp7-impact-dates">
                        P20: ${formatDate(risk.p20Finish)} | 
                        P50: ${formatDate(risk.p50Finish)} | 
                        P80: ${formatDate(risk.p80Finish)}
                        ${spreadReduction ? ` | ${spreadReduction}` : ''}
                    </span>
                </div>
            `;

            if (impactBanner) {
                impactBanner.outerHTML = bannerHtml;
            } else {
                const statusBanner = container.querySelector('.cp7-status');
                if (statusBanner) {
                    statusBanner.insertAdjacentHTML('afterend', bannerHtml);
                }
            }
        } else if (impactBanner) {
            impactBanner.remove();
        }

        // TODO: Update chart (requires chart instance reference)
        console.log('[CompletionPrediction] Risk display updated with mitigations:', {
            p20: risk.p20Finish?.toISOString?.().split('T')[0],
            p50: risk.p50Finish?.toISOString?.().split('T')[0],
            p80: risk.p80Finish?.toISOString?.().split('T')[0],
            spread: risk.spreadDays
        });
    }

    function wireDownstreamHandlers(containerId, maps) {
        const container = document.getElementById(containerId);
        if (!container) return;

        // Active Frontier rows
        container.querySelectorAll('.cp7-table tbody tr').forEach(row => {
            const nameCell = row.querySelector('td');
            if (!nameCell) return;
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => {
                const activityName = nameCell.textContent.trim();
                // Find activity ID from name (simplified - you may need to store data-id)
                const activityId = nameCell.getAttribute('data-id') || activityName;
                showDownstreamImpact(activityId, activityName, maps, containerId);
            });
        });

        // Risk cards
        container.querySelectorAll('.cp7-risk-card[data-id]').forEach(card => {
            card.style.cursor = 'pointer';
            card.addEventListener('click', (e) => {
                if (e.target.closest('.cp7-risk-mitigation-item')) return;
                const rawId = card.dataset.id;
                const activityId = rawId.startsWith('risk_') ? rawId.substring(5) : rawId;
                const titleEl = card.querySelector('.cp7-risk-title');
                const activityName = titleEl?.textContent?.trim() || activityId;
                showDownstreamImpact(activityId, activityName, maps, containerId);
            });
        });
    }

    function wireRecoveryClicks(containerId, analysis) {
        const el = document.getElementById(containerId);
        if (!el) return;

        const opts = el.querySelectorAll('.cp7-opt');
        opts.forEach(o => {
            const handler = function () {
                this.classList.toggle('selected');
                const selected = Array.from(opts).filter(x => x.classList.contains('selected'));
                const selectedIds = selected.map(x => String(x.dataset.id || '')).filter(Boolean);
                const totalSavings = selected.reduce((acc, x) => acc + parseFloat(x.dataset.days || 0), 0);
                updateRecoveryScenario(containerId, analysis, totalSavings, selectedIds);
            };
            o.addEventListener('click', handler);
            _eventCleanups.push(() => o.removeEventListener('click', handler));
        });
    }
    function buildRecoveryOverridesFromSelection(analysis, selectedOptionIds) {
        const crashHoursById = new Map();
        const lagReductionHrsByEdgeKey = new Map();

        const crashByOptId = new Map((analysis?.crashPlan?.recoveryOptions || []).map(o => [String(o.id), o]));
        const lagByOptId = new Map((analysis?.crashPlan?.lagOptions || []).map(o => [String(o.id), o]));

        for (const optId of selectedOptionIds || EMPTY_ARRAY) {
            const crash = crashByOptId.get(String(optId));
            if (crash?.type === 'duration_crash' && crash?.targetActivityId) {
                const actId = String(crash.targetActivityId);
                const prev = crashHoursById.get(actId) || 0;
                crashHoursById.set(actId, prev + Math.max(0, +(crash.crashHours || 0)));
                continue;
            }
            const lag = lagByOptId.get(String(optId));
            if (lag?.type === 'lag_compression' && lag?.sourceId && lag?.targetId) {
                const edgeKey = `${String(lag.sourceId)}|${String(lag.targetId)}`;
                const f = (typeof CONFIG.lagCompressionFactor === 'number') ? CONFIG.lagCompressionFactor : 0.5;
                const reduction = Math.max(0, Math.round((+(lag.currentLagHours || 0)) * clamp(f, 0, 1)));
                const prev = lagReductionHrsByEdgeKey.get(edgeKey) || 0;
                lagReductionHrsByEdgeKey.set(edgeKey, prev + reduction);
            }
        }

        return {
            crashHoursById,
            lagReductionHrsByEdgeKey
        };
    }

    function updateRecoveryScenario(containerId, analysis, savingsDays, selectedOptionIds) {
        const canvas = document.querySelector(`#${containerId} canvas`);
        const chart = canvas?._chartInstance;
        if (!chart) return;

        const { curves } = analysis;
        const recoveryIdx = chart.data.datasets.findIndex(d => d.label === 'Recovery');

        const scenarioDisplay = document.getElementById(`${containerId}-scenario-display`);
        const scenarioDate = document.getElementById(`${containerId}-scenario-date`);
        const scenarioSavings = document.getElementById(`${containerId}-scenario-savings`);
        const scenarioNCEl = document.getElementById(`${containerId}-scenario-nearcritical`);

        // Persist original driving chain HTML for quick restore
        if (!analysis._drivingChainHtmlOriginal) {
            const dcEl = document.getElementById(`${containerId}-driving-chain-table`);
            if (dcEl) analysis._drivingChainHtmlOriginal = dcEl.innerHTML;
        }

        // Persist original near-critical HTML for quick restore
        if (!analysis._nearCriticalHtmlOriginal && scenarioNCEl) {
            analysis._nearCriticalHtmlOriginal = scenarioNCEl.innerHTML;
        }

        if (savingsDays <= 0) {
            if (recoveryIdx > -1) chart.data.datasets.splice(recoveryIdx, 1);
            if (scenarioDisplay) scenarioDisplay.style.display = 'none';
            if (scenarioNCEl) scenarioNCEl.style.display = 'none';

            // Restore original driving chain
            const dcEl = document.getElementById(`${containerId}-driving-chain-table`);
            if (dcEl && analysis._drivingChainHtmlOriginal) dcEl.innerHTML = analysis._drivingChainHtmlOriginal;
            if (scenarioNCEl && analysis._nearCriticalHtmlOriginal) scenarioNCEl.innerHTML = analysis._nearCriticalHtmlOriginal;

            chart.update();
            return;
        }

        const expectedFinish = curves.expectedFinish;
        if (!expectedFinish) return;

        // Baseline fallback if scenario solve fails
        let recoveryFinish = addDays(expectedFinish, -savingsDays);
        let recoveryCurve = null;

        // Scenario solve using cloned state (avoid mutating baseline expected schedule)
        let scenarioMaps = null;
        let scenarioNodes = null;
        let scenarioExpected = null;
        let scenarioChain = null;
        let scenarioCurves = null;
        let overrides = null;

        if (analysis?.nodes && analysis?.links && analysis?.maps && selectedOptionIds?.length) {
            overrides = buildRecoveryOverridesFromSelection(analysis, selectedOptionIds);

            // Clone nodes so computeExpectedSchedule does not mutate baseline nodes
            scenarioNodes = (analysis.nodes || []).map(n => ({ ...n }));
            const scenarioNodeMap = new Map(scenarioNodes.map(n => [String(n.ID), n]));

            // Clone maps and ensure start/end nodes point at the cloned graph
            const startId = String(analysis.maps.startNode?.ID ?? '');
            const endId = String(analysis.maps.endNode?.ID ?? '');
            scenarioMaps = {
                ...analysis.maps,
                nodeMap: scenarioNodeMap,
                startNode: scenarioNodeMap.get(startId) || analysis.maps.startNode,
                endNode: scenarioNodeMap.get(endId) || analysis.maps.endNode
            };

            scenarioExpected = computeExpectedSchedule(scenarioNodes, analysis.links, scenarioMaps, overrides);
            scenarioChain = getExpectedDrivingChain(scenarioMaps.endNode, scenarioMaps.nodeMap);

            const scenarioEnd = scenarioExpected?.expectedProjectFinish;
            if (isValidDate(scenarioEnd)) recoveryFinish = scenarioEnd;

            // Build full scenario curves from recalculated schedule (not time-compressed)
            scenarioCurves = buildCurves(scenarioNodes, scenarioMaps, scenarioExpected, null);
            if (scenarioCurves?.expectedCurve?.length) {
                recoveryCurve = scenarioCurves.expectedCurve;
            }

            // Update driving chain table
            const dcEl = document.getElementById(`${containerId}-driving-chain-table`);
            if (dcEl) dcEl.innerHTML = buildDrivingChainSummary(scenarioChain, scenarioMaps);

            // Scenario near-critical diagnostics (fast proxy)
            if (scenarioNCEl) {
                const nc = computeScenarioNearCriticalProxy(scenarioNodes, scenarioMaps, scenarioExpected, overrides);
                scenarioNCEl.innerHTML = buildScenarioNearCriticalHtml(nc);
                scenarioNCEl.style.display = 'block';
            }
        }

        // Fallback: time-compress baseline expected curve if scenario curve not available
        if (!recoveryCurve) {
            const statusTime = curves.statusDate.getTime();
            const expectedTime = expectedFinish.getTime();
            const recoveryTime = recoveryFinish.getTime();
            const recoveryData = [];
            const expectedCurve = curves.expectedCurve;

            for (const pt of expectedCurve || EMPTY_ARRAY) {
                const ptTime = pt.x.getTime();
                if (ptTime <= statusTime) {
                    recoveryData.push({ x: new Date(pt.x), y: pt.y });
                    continue;
                }
                const originalProgress = (ptTime - statusTime) / Math.max(1, (expectedTime - statusTime));
                const newTime = statusTime + originalProgress * (recoveryTime - statusTime);
                if (newTime <= recoveryTime) recoveryData.push({ x: new Date(newTime), y: pt.y });
            }
            recoveryData.push({ x: recoveryFinish, y: 100 });
            recoveryCurve = recoveryData;
        }

        const recoveryDataset = {
            label: 'Recovery',
            data: recoveryCurve,
            borderColor: CONFIG.chartColors.recovery,
            borderWidth: 2,
            borderDash: [3, 3],
            pointRadius: 0,
            tension: 0.1
        };

        if (recoveryIdx > -1) chart.data.datasets[recoveryIdx] = recoveryDataset;
        else chart.data.datasets.push(recoveryDataset);

        if (scenarioDisplay && scenarioDate && scenarioSavings) {
            scenarioDisplay.style.display = 'block';
            scenarioDate.textContent = formatDate(recoveryFinish);
            scenarioSavings.textContent = `-${Math.round(savingsDays)}d`;
        }

        chart.update();
    }

    // Fast proxy: scenario near-critical set (O(N+E))
    function computeScenarioNearCriticalProxy(nodes, maps, scenarioExpected, overrides) {
        const { nodeMap, succMap, predMap, statusDate, endNode } = maps;
        const endId = String(endNode?.ID ?? '');
        const orderRes = computeTopoOrderOptimized(nodeMap, succMap, predMap);
        const topo = orderRes.order || EMPTY_ARRAY;

        const crash = overrides?.crashHoursById;
        const remH = new Map();

        for (const id of topo) {
            const n = nodeMap.get(id);
            if (!n) continue;
            const pct = effectivePercentComplete(n, maps);
            const baseH = convertToHours(n.Duration, n.TimeUnits);
            const crashH = crash ? (crash.get(String(n.ID)) || 0) : 0;
            const adjH = Math.max(0, baseH - crashH);
            let r = 0;
            if (pct >= 1 || safeDate(n.ActualFinish)) r = 0;
            else if (pct > 0 || safeDate(n.ActualStart)) r = adjH * (1 - clamp(pct, 0, 1));
            else r = adjH;
            remH.set(id, Math.max(0, r));
        }

        const distToEndH = new Map();
        for (let i = topo.length - 1; i >= 0; i--) {
            const id = topo[i];
            const self = remH.get(id) || 0;
            const succs = succMap.get(id) || EMPTY_ARRAY;
            let bestDown = 0;
            for (let j = 0; j < succs.length; j++) {
                const e = succs[j];
                const v = String(e.target);
                const down = distToEndH.get(v) || 0;
                const lag = Math.max(0, +(e.lagHrs || 0));
                if (lag + down > bestDown) bestDown = lag + down;
            }
            distToEndH.set(id, self + bestDown);
        }

        const scenarioFinish = safeDate(scenarioExpected?.expectedProjectFinish) || safeDate(maps.endNode?.ExpectedFinish);
        const scenarioFinishMs = scenarioFinish?.getTime() || 0;
        const statusMs = safeDate(statusDate)?.getTime() || Date.now();

        const envelopeDays = typeof CONFIG.scenarioNearCriticalDays === 'number' ? CONFIG.scenarioNearCriticalDays : 30;
        const out = [];

        for (const id of topo) {
            if (id === endId) continue;
            const exp = scenarioExpected?.expectedMap?.get(id);
            const sMs = exp?.s || exp?.startMs || null;
            const startMs = Math.max(statusMs, +(sMs || 0));
            if (!startMs || !scenarioFinishMs) continue;
            const pathH = distToEndH.get(id) || 0;
            const endFromId = addHours(new Date(startMs), pathH).getTime();
            const floatH = (scenarioFinishMs - endFromId) / (MS_PER_HOUR);
            const floatDays = floatH / CONFIG.workingHoursPerDay;
            if (!isFinite(floatDays)) continue;
            if (floatDays <= envelopeDays) {
                const n = nodeMap.get(id);
                out.push({
                    id,
                    name: (n?.Name || '').trim(),
                    floatDays: +floatDays.toFixed(1),
                    remDays: +(pathH / CONFIG.workingHoursPerDay).toFixed(1),
                    plannedFinish: safeDate(n?.Finish),
                    expectedFinish: safeDate(n?.ExpectedFinish)
                });
            }
        }

        out.sort((a, b) => a.floatDays - b.floatDays);
        return {
            envelopeDays,
            scenarioFinish,
            items: out.slice(0, 30)
        };
    }

    function buildScenarioNearCriticalHtml(nc) {
        if (!nc || !nc.items || !nc.items.length) {
            return `<div style="margin-top:10px;opacity:0.7;">No scenario near-critical activities within ${nc?.envelopeDays ?? ''}d envelope.</div>`;
        }
        let html = `<div style="margin-top:10px;">
            <h4 style="margin:0 0 6px 0;">🧭 Scenario Near-Critical (≤ ${nc.envelopeDays}d)</h4>
            <p class="cp7-subtitle" style="margin-top:0;">Fast proxy under selected recovery actions. Top ${nc.items.length} shown.</p>
            <table class="cp7-table">
                <thead><tr>
                    <th>ID</th><th>Name</th><th>Float (d)</th><th>Remain-to-End (d)</th>
                </tr></thead><tbody>`;
        for (const it of nc.items) {
            html += `<tr>
                <td>${escapeHtml(it.id)}</td>
                <td>${escapeHtml((it.name || '').slice(0, 64))}</td>
                <td>${it.floatDays}</td>
                <td>${it.remDays}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
        return html;
    }

    // =========================================================================
    // MAIN ENTRY POINT
    // =========================================================================

    function analyze(nodes, links, opts = {}) {
        _cachedWeights = null;
        _holidaySet = null; // Reset holiday cache for fresh rebuild

        // FIX #1: Sync calendar CONFIG from team calendar so date arithmetic
        // matches PathScripts.js convertToHours(). Without this, a 10hr/day
        // schedule would convert durations correctly but then add hours using
        // hardcoded 8hr/day, producing wrong dates.
        const teamCal = window.cybereumState?.teamCalendar;
        if (teamCal) {
            CONFIG.workingHoursPerDay = teamCal.hoursPerDay || 8;
            CONFIG.workingDaysPerWeek = teamCal.workingDays?.length || 5;
        }

        if (typeof convertToHours !== 'function') {
            console.error('[CompletionPrediction] convertToHours not available — PathScripts.js may not be loaded');
            return null;
        }

        const maps = getStateMaps(nodes, links || []);
        if (!maps) {
            console.error('[CompletionPrediction] Analysis failed: could not build state maps.');
            return null;
        }
        console.log('[CompletionPrediction] Maps Initialized:', {
            nodeCount: maps.nodeMap.size,
            statusDate: maps.statusDate,
            hasCycle: maps.hasCycle
        });

        const expected = computeExpectedSchedule(nodes, links || [], maps, null);
        console.log('[CompletionPrediction] Expected Schedule:', {
            plannedFinish: expected.plannedProjectFinish,
            expectedFinish: expected.expectedProjectFinish,
            varianceDays: expected.projectVariance
        });

        const drivingChain = getExpectedDrivingChain(maps.endNode, maps.nodeMap);
        console.log('[CompletionPrediction] Driving Chain length:', drivingChain.length, drivingChain);

        if (drivingChain.length > 0) {
            console.log('[CompletionPrediction] Driving Chain Details:');
            const chainTable = drivingChain.map((n, idx) => {
                const expF = safeDate(n.ExpectedFinish);
                const plnF = safeDate(n.Finish);
                const pct = effectivePercentComplete(n, maps);
                const durH = convertToHours(n.Duration, n.TimeUnits);
                return {
                    seq: idx + 1,
                    id: n.ID,
                    name: (n.Name || '').substring(0, 30),
                    pct: Math.round(pct * 100) + '%',
                    durDays: Math.round(durH / CONFIG.workingHoursPerDay),
                    plannedFinish: plnF ? formatDate(plnF) : '—',
                    expectedFinish: expF ? formatDate(expF) : '—',
                    slipDays: (plnF && expF) ? daysBetween(plnF, expF) : 0
                };
            });
            console.table(chainTable);
        }

        const activeActivities = identifyActiveActivities(nodes, maps);
        const reachability = buildReachabilitySets(maps, nodes, drivingChain);
        console.log('[CompletionPrediction] Scope identified:', {
            activeCount: activeActivities.length,
            nodesInScope: reachability.scopeToEnd.size
        });

        const mc = runMonteCarloRemaining(nodes, links, maps, expected, reachability, drivingChain, opts);
        if (mc) {
            console.log('[CompletionPrediction] Monte Carlo Results:', {
                p50: mc.p50Finish,
                p80: mc.p80Finish,
                iterations: mc.iterations
            });
        }

        const risk = buildRiskSchedules(nodes, links || [], maps, expected, reachability, mc);
        console.log('[CompletionPrediction] Risk Schedules built:', {
            p50Impact: risk.p50ImpactDays,
            p80Impact: risk.p80ImpactDays
        });

        const crashPlan = buildCrashOptions(nodes, maps, expected, risk, reachability, drivingChain);
        console.log('[CompletionPrediction] Recovery Optimizer:', {
            targetDays: crashPlan.targetDays,
            achievableDays: crashPlan.achievedDays,
            optionsFound: crashPlan.recoveryOptions.length + crashPlan.lagOptions.length
        });

        const curves = buildCurves(nodes, maps, expected, risk);
        console.log('[CompletionPrediction] Curve Diagnostics:', {
            totalBudgetHours: Math.round(curves.totalBudgetHours),
            completedHours: Math.round(curves.completedHours),
            inProgressEarned: Math.round(curves.inProgressEarnedHours),
            actualEarnedHours: Math.round(curves.actualEarnedHours),
            statusPct: curves.statusPct.toFixed(1) + '%',
            plannedCurvePoints: curves.plannedCurve.length,
            expectedCurvePoints: curves.expectedCurve.length
        });

        const summary = buildSummary(expected, risk, crashPlan, drivingChain, maps);
        console.log('[CompletionPrediction] Final Summary:', summary.headline);

        const analysis = {
            maps,
            // Keep references for scenario recomputation (recovery selection)
            nodes,
            links: links || [],
            expected,
            risk,
            mc,
            crashPlan,
            curves,
            summary,
            activeActivities,
            reachability,
            drivingChain
        };

        analysis.recoveryActionCardPayload = buildRecoveryActionCardPayload(analysis);
        _lastAnalysis = analysis;

        try {
            const globalState = (typeof window !== 'undefined' ? window.cybereumState : global.cybereumState) || {};
            globalState.completionPrediction = {
                statusDate: maps.statusDate,
                plannedFinish: summary.plannedFinish,
                expectedFinish: summary.expectedFinish,
                p50Finish: summary.p50Finish,
                p80Finish: summary.p80Finish
            };
            console.log('[CompletionPrediction] Global state updated.');
        } catch (e) {
            console.warn('[CompletionPrediction] Could not update global state:', e);
        }

        return analysis;
    }

    // -------------------------------------------------------------------------
    // analyzeAsync: identical to analyze() except the Monte Carlo call is
    // awaited against the Pyth-Sched-Analytics /completion/monte-carlo
    // backend (with the in-browser MC as a transparent fallback).  Exposed
    // as a separate function so the sync entry point (initSync) and any
    // other sync callers continue to work unchanged.
    // -------------------------------------------------------------------------
    async function analyzeAsync(nodes, links, opts = {}) {
        _cachedWeights = null;
        _holidaySet = null;

        const teamCal = window.cybereumState?.teamCalendar;
        if (teamCal) {
            CONFIG.workingHoursPerDay = teamCal.hoursPerDay || 8;
            CONFIG.workingDaysPerWeek = teamCal.workingDays?.length || 5;
        }

        if (typeof convertToHours !== 'function') {
            console.error('[CompletionPrediction] convertToHours not available — PathScripts.js may not be loaded');
            return null;
        }

        const maps = getStateMaps(nodes, links || []);
        if (!maps) {
            console.error('[CompletionPrediction] Analysis failed: could not build state maps.');
            return null;
        }
        console.log('[CompletionPrediction] Maps Initialized:', {
            nodeCount: maps.nodeMap.size,
            statusDate: maps.statusDate,
            hasCycle: maps.hasCycle
        });

        const expected = computeExpectedSchedule(nodes, links || [], maps, null);
        console.log('[CompletionPrediction] Expected Schedule:', {
            plannedFinish: expected.plannedProjectFinish,
            expectedFinish: expected.expectedProjectFinish,
            varianceDays: expected.projectVariance
        });

        const drivingChain = getExpectedDrivingChain(maps.endNode, maps.nodeMap);
        console.log('[CompletionPrediction] Driving Chain length:', drivingChain.length, drivingChain);

        if (drivingChain.length > 0) {
            console.log('[CompletionPrediction] Driving Chain Details:');
            const chainTable = drivingChain.map((n, idx) => {
                const expF = safeDate(n.ExpectedFinish);
                const plnF = safeDate(n.Finish);
                const pct = effectivePercentComplete(n, maps);
                const durH = convertToHours(n.Duration, n.TimeUnits);
                return {
                    seq: idx + 1,
                    id: n.ID,
                    name: (n.Name || '').substring(0, 30),
                    pct: Math.round(pct * 100) + '%',
                    durDays: Math.round(durH / CONFIG.workingHoursPerDay),
                    plannedFinish: plnF ? formatDate(plnF) : '—',
                    expectedFinish: expF ? formatDate(expF) : '—',
                    slipDays: (plnF && expF) ? daysBetween(plnF, expF) : 0
                };
            });
            console.table(chainTable);
        }

        const activeActivities = identifyActiveActivities(nodes, maps);
        const reachability = buildReachabilitySets(maps, nodes, drivingChain);
        console.log('[CompletionPrediction] Scope identified:', {
            activeCount: activeActivities.length,
            nodesInScope: reachability.scopeToEnd.size
        });

        const mc = await runMonteCarloRemainingAsync(
            nodes, links, maps, expected, reachability, drivingChain, opts);
        if (mc) {
            console.log('[CompletionPrediction] Monte Carlo Results:', {
                p50: mc.p50Finish,
                p80: mc.p80Finish,
                iterations: mc.iterations,
                source: mc.source || 'js'
            });
        }

        const risk = buildRiskSchedules(nodes, links || [], maps, expected, reachability, mc);
        console.log('[CompletionPrediction] Risk Schedules built:', {
            p50Impact: risk.p50ImpactDays,
            p80Impact: risk.p80ImpactDays
        });

        // Backend-first recovery options; falls back to JS buildCrashOptions
        // on any backend failure (see buildCrashOptionsAsync).
        const crashPlan = await buildCrashOptionsAsync(
            nodes, maps, expected, risk, reachability, drivingChain);
        console.log('[CompletionPrediction] Recovery Optimizer:', {
            targetDays: crashPlan.targetDays,
            achievableDays: crashPlan.achievedDays,
            optionsFound: crashPlan.recoveryOptions.length + crashPlan.lagOptions.length,
            source: crashPlan.source || 'js'
        });

        const curves = buildCurves(nodes, maps, expected, risk);
        console.log('[CompletionPrediction] Curve Diagnostics:', {
            totalBudgetHours: Math.round(curves.totalBudgetHours),
            completedHours: Math.round(curves.completedHours),
            inProgressEarned: Math.round(curves.inProgressEarnedHours),
            actualEarnedHours: Math.round(curves.actualEarnedHours),
            statusPct: curves.statusPct.toFixed(1) + '%',
            plannedCurvePoints: curves.plannedCurve.length,
            expectedCurvePoints: curves.expectedCurve.length
        });

        const summary = buildSummary(expected, risk, crashPlan, drivingChain, maps);
        console.log('[CompletionPrediction] Final Summary:', summary.headline);

        const analysis = {
            maps,
            nodes,
            links: links || [],
            expected,
            risk,
            mc,
            crashPlan,
            curves,
            summary,
            activeActivities,
            reachability,
            drivingChain
        };

        analysis.recoveryActionCardPayload = buildRecoveryActionCardPayload(analysis);
        _lastAnalysis = analysis;

        try {
            const globalState = (typeof window !== 'undefined' ? window.cybereumState : global.cybereumState) || {};
            globalState.completionPrediction = {
                statusDate: maps.statusDate,
                plannedFinish: summary.plannedFinish,
                expectedFinish: summary.expectedFinish,
                p50Finish: summary.p50Finish,
                p80Finish: summary.p80Finish
            };
            console.log('[CompletionPrediction] Global state updated.');
        } catch (e) {
            console.warn('[CompletionPrediction] Could not update global state:', e);
        }

        return analysis;
    }

    /** @private Paint yield — lets the loader animate before blocking computation */
    function _yield() { return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); }); }

    async function init(nodes, links, containerId = 'completion-content') {
        injectStyles();

        const el = document.getElementById(containerId);
        const loader = window.CybereumInsightsLoader || window.CybereumInsightsLoader1;
        var _loaderActive = false;
        try { _loaderActive = loader && loader.isActive && loader.isActive(); } catch (_) { }
        const useLoader = loader && typeof loader.start === 'function' && !_loaderActive;
        const UI = window.CybereumUI;
        const useInline = !useLoader && UI && UI.html;

        const steps = [
            'Building dependency maps',
            'Computing expected schedule',
            'Running Monte Carlo simulation',
            'Evaluating risk schedules',
            'Generating recovery options',
            'Rendering dashboard'
        ];

        // ── Show loader ──
        var _loaderReady = false;
        try {
            if (useLoader) {
                loader.start('Completion Prediction', steps, {
                    heading: 'COMPLETION PREDICTION ENGINE',
                    phase: 'INITIALIZING',
                    sources: [
                        { id: 'schedule', name: 'Schedule Data' },
                        { id: 'links', name: 'Dependencies' },
                        { id: 'risk', name: 'Risk Model' },
                        { id: 'mc', name: 'Monte Carlo' }
                    ]
                });
                _loaderReady = true;
            } else if (useInline && el) {
                el.innerHTML = '<div class="cp7">' + UI.html.loader(steps) + '</div>';
                _loaderReady = true;
            }
        } catch (_e) { console.warn('[CompletionPrediction] Loader init skipped:', _e.message); }

        await _yield(); // let loader paint

        try {
            // Step 0: Build maps
            if (_loaderReady && useLoader) { try { loader.markStep(0, 'working'); loader.markSource('schedule', true); } catch (_) { } }
            else if (_loaderReady && useInline && el) _advanceInlineStep(el, 0);

            // Async analyze -- Monte Carlo is offloaded to /completion/monte-carlo
            // when CONFIG.useBackendCompletion is true.  Falls back to in-browser
            // MC automatically on any backend failure.
            const analysis = await analyzeAsync(nodes, links);

            if (!analysis) {
                if (_loaderReady && useLoader) { try { loader.status('ERROR'); setTimeout(() => loader.hide(), 1500); } catch (_) { } }
                else if (el) el.innerHTML = '<div class="cp7" style="padding:24px;opacity:0.6;">Analysis could not be performed — insufficient data.</div>';
                return null;
            }

            // Mark intermediate steps as done (analyze already computed everything)
            if (_loaderReady && useLoader) {
                try {
                    loader.markStep(0, 'done'); loader.progress(15);
                    loader.markSource('links', true);
                    loader.markStep(1, 'working');
                    await _yield();
                    loader.markStep(1, 'done'); loader.progress(30);
                    loader.markStep(2, 'working'); loader.setPhase('SIMULATION');
                    loader.markSource('mc', true);
                    await _yield();
                    loader.markStep(2, 'done'); loader.progress(50);
                    loader.markStep(3, 'working'); loader.markSource('risk', true);
                    await _yield();
                    loader.markStep(3, 'done'); loader.progress(70);
                    loader.markStep(4, 'working');
                    await _yield();
                    loader.markStep(4, 'done'); loader.progress(85);
                    loader.markStep(5, 'working'); loader.setPhase('RENDERING');
                } catch (_) { }
            } else if (_loaderReady && useInline && el) {
                for (var i = 1; i <= 5; i++) _advanceInlineStep(el, i);
            }

            await _yield(); // let progress paint before render

            renderDashboard(containerId, analysis);

            if (_loaderReady && useLoader) {
                try { loader.markStep(5, 'done'); loader.finish(400, 'PREDICTION READY'); } catch (_) { }
            }

            return analysis;

        } catch (err) {
            console.error('[CompletionPrediction] Init failed:', err);
            if (_loaderReady && useLoader) { try { loader.status('ERROR'); loader.setPhase('FAILED'); setTimeout(() => loader.hide(), 2000); } catch (_) { } }
            else if (el) el.innerHTML = '<div class="cp7" style="padding:24px;color:#ff5555;">Error: ' + (err.message || 'Unknown') + '</div>';
            return null;
        }
    }

    /** @private Advance inline step loader visual state */
    function _advanceInlineStep(el, idx) {
        var steps = el.querySelectorAll('.cyb-loader-step');
        if (!steps.length) return;
        steps.forEach(function (s, i) {
            if (i < idx) { s.classList.remove('active'); s.classList.add('done'); }
            else if (i === idx) { s.classList.remove('done'); s.classList.add('active'); }
        });
    }

    /** Synchronous init — backward compatible for callers that can't await */
    function initSync(nodes, links, containerId = 'completion-content') {
        const analysis = analyze(nodes, links);
        if (analysis) renderDashboard(containerId, analysis);
        return analysis;
    }

    function destroy() {
        _eventCleanups.forEach(fn => { try { fn(); } catch (e) { } });
        _eventCleanups = [];

        _lastAnalysis = null;
        _cachedWeights = null;
        _stylesInjected = false;

        if (typeof document !== 'undefined') {
            const canvases = document.querySelectorAll('canvas[id$="-chart"]');
            canvases.forEach(canvas => {
                const chart = (typeof Chart !== 'undefined' && Chart.getChart?.(canvas)) || canvas._chartInstance;
                if (chart) chart.destroy();
            });

            const styleEl = document.getElementById('cp7-styles');
            if (styleEl) styleEl.remove();
        }
    }

    // Export
    global.CompletionPrediction = {
        version: '7.2-PROD',
        init,
        initSync,
        analyze,
        destroy,
        CONFIG,
        getLastAnalysis: () => _lastAnalysis,
        // Internal helpers exposed for the JS<->Python diff harness only.
        // Not part of the production API; using these from app code is
        // unsupported and may break across versions.
        _internals: {
            classifyCrashProfile,
            getLagInHours,
            normalizePercentComplete,
            convertToHours,
            _recordTelemetry,
            // Working-calendar primitives exposed for the JS<->Python
            // diff harness (tests/test_calendar_diff.py).  These are the
            // canonical implementations of the day-arithmetic that
            // completion/calendar.py advance_working_ms ports.
            addWorkingHours,
            subtractWorkingHours,
            _addWorkdaysO1,
            _normalizeWeekendForward,
            _isWorkingDay,
        },
    };

})(typeof window !== 'undefined' ? window : this);
