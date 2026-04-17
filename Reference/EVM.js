/********************
 * FINAL EVM.js - Earned Value Management Engine
 * 
 * Key Fixes in this version:
 * 1. Corrected EV calculation to properly track cumulative earned value
 * 2. Removed duplicate function definitions
 * 3. Centralized percent complete normalization
 * 4. Simplified ACWP calculation with clearer logic
 * 5. Added comprehensive input validation
 * 6. Improved date handling with validation
 * 7. Fixed chart initialization race conditions
 * 
 * ADDITIONAL FIXES (v2):
 * 8. Predicted dates now properly compare actual vs forecasted performance
 * 9. Start milestone automatically set to 100% when actual progress exists
 * 10. Prediction logic correctly shows faster completion when actual delays < forecasted
 * 11. Performance delta between actual and forecasted properly calculated
 *
 * FINAL OPTIMIZATIONS (v3):
 * 12. Fixed O(n) array lookups in dependency enforcement -> O(1) Map lookup
 * 13. Fixed O(n) comparisonDates.includes() -> O(1) Set lookup
 * 14. Prevented duplicate autoCompleteStartMilestone calls
 * 15. Cached safeDate results to avoid repeated parsing
 * 16. Fixed performanceDelta edge case validation
 *
 * PREDICTION IMPROVEMENTS (v4):
 * 17. Sector-based schedule overrun lookup (nuclear, oil&gas, infrastructure, etc.)
 * 18. Duration-weighted progress comparison (apples-to-apples: planned vs actual)
 *     - Uses hours-based SPI: actualCompletedHours / plannedCompletedHours
 *     - Handles ActualFinish dates even when PercentComplete not set
 *     - Proper edge case handling for ahead-of-schedule work
 * 19. findLastActiveActivities identifies frontier nodes for chain-based prediction
 *     - O(1) nodeMap lookups instead of O(n) find
 *     - Returns full node objects, not just IDs
 * 20. Full dependency type support (FS, SS, FF, SF) in prediction propagation
 *     - Added subtractDurationFromDate for proper FF/SF back-calculation
 *     - Working-day aware (accounts for weekends)
 * 21. Enhanced evmMetrics export with durationWeightedProgress, frontierNodes
 * 22. Null-safe SPI handling in fallback branch
 *
 * EV CURVE FIX (v5):
 * 23. FIXED: Abrupt EV jump caused by missing branch for activities with
 *     PercentComplete > 0 but no ActualStart/ActualFinish dates
 *     - Added date imputation for EV calc (mirrors AC calculation logic)
 *     - Added CASE 3: Activities with progress but no dates now time-phased
 *     - EV now credits progressively instead of jumping at statusDate
 * 24. Added weekly intermediate dates to timeline for smoother S-curves
 *     - Prevents step-function appearance from sparse date sampling
 ********************/

/********************
 * UTILITY FUNCTIONS
 ********************/

// OPTIMIZATION: Memoization for expensive calculations
const calculationCache = new Map();

// Batched data quality warnings (flushed as summary instead of per-task spam)
let _evmDataQualityWarnings = [];


// ---- Calendar-aware working time accessors (import-driven) ----
(function syncEvmCalendarFromImport() {
    try { if (typeof window !== 'undefined' && typeof window.syncWorkingCalendarFromImport === 'function') window.syncWorkingCalendarFromImport(); } catch (e) { }
})();

function _evmHoursPerDay() {
    return (window.CONFIG && Number.isFinite(window.CONFIG.WORKING_HOURS_PER_DAY) ? window.CONFIG.WORKING_HOURS_PER_DAY
        : (typeof window.DEFAULT_HOURS_PER_DAY !== 'undefined' ? window.DEFAULT_HOURS_PER_DAY : 8));
}
function _evmDaysPerWeek() {
    return (window.CONFIG && Number.isFinite(window.CONFIG.WORKING_DAYS_PER_WEEK) ? window.CONFIG.WORKING_DAYS_PER_WEEK
        : (typeof window.DEFAULT_WORKING_DAYS !== 'undefined' ? window.DEFAULT_WORKING_DAYS.length : 5));
}

/** Get Set of working day-of-week numbers for calendar-aware date arithmetic */
function _evmGetWorkingDaySet() {
    if (window.WORKING_DAY_SET instanceof Set && window.WORKING_DAY_SET.size > 0) return window.WORKING_DAY_SET;
    const days = Array.isArray(window.DEFAULT_WORKING_DAYS) && window.DEFAULT_WORKING_DAYS.length
        ? window.DEFAULT_WORKING_DAYS : [1, 2, 3, 4, 5];
    return (window.WORKING_DAY_SET = new Set(days));
}

/** Get Set of holiday date strings from imported calendar exceptions */
function _evmGetHolidaySet() {
    if (window.HOLIDAY_SET instanceof Set) return window.HOLIDAY_SET;
    return (window.HOLIDAY_SET = new Set());
}

/** Format Date to 'YYYY-MM-DD' for holiday lookup */
function _evmDateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}


function memoize(fn, keyGen) {
    return function (...args) {
        const key = keyGen ? keyGen(args) : JSON.stringify(args);
        if (calculationCache.has(key)) {
            return calculationCache.get(key);
        }
        const result = fn(...args);
        calculationCache.set(key, result);
        return result;
    };
}

// Clear cache when new data is loaded
function clearCalculationCache() {
    calculationCache.clear();
}

// OPTIMIZATION: Date cache to avoid repeated parsing
const dateCache = new Map();

function safeDate(dateInput) {
    if (!dateInput) return null;

    // Check cache first
    const cacheKey = String(dateInput);
    if (dateCache.has(cacheKey)) {
        return dateCache.get(cacheKey);
    }

    const date = new Date(dateInput);
    const result = isFinite(date.getTime()) ? date : null;

    // Cache the result (limit cache size to prevent memory issues)
    // Cache the result (limit cache size to prevent memory issues)
    if (dateCache.size >= 10000) {
        // FIXED: Clear oldest 30% (3000 entries) at once instead of just 1
        const toClear = 3000;
        const keysToDelete = Array.from(dateCache.keys()).slice(0, toClear);
        keysToDelete.forEach(k => dateCache.delete(k));
        if ((typeof CYB_OPT_DEBUG !== 'undefined' && CYB_OPT_DEBUG) || window.cybereumState?.debug?.caches) {
            console.log(`[EVM] Date cache cleared: ${keysToDelete.length} entries, ${dateCache.size} remaining`);
        }
    }
    dateCache.set(cacheKey, result);

    return result;
}

// Clear date cache when loading new project
function clearDateCache() {
    dateCache.clear();
}

// Centralized percent complete normalization
function normalizePercentComplete(raw) {
    if (raw === null || raw === undefined || raw === "") return 0;

    let value = raw;
    if (typeof value === 'string') {
        value = value.trim().replace('%', '');
        if (value.startsWith('.')) value = '0' + value;
    }

    value = parseFloat(value);
    if (!isFinite(value) || value < 0) return 0;

    // FIX: Import always produces 0-100 range (P6 and MSP). Previous heuristic (<=1 = decimal)
    // misinterpreted 1% as 100%. Always divide by 100 and clamp to [0, 1].
    return Math.min(1, Math.max(0, value / 100));
}

function clampNum(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

// Format date in local timezone (YYYY-MM-DD)
function formatDateLocal(date) {
    if (!date || !isFinite(date.getTime())) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Format currency with proper handling
function formatCurrency(value, currency = 'USD') {
    if (!isFinite(value)) return '$0';
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency,
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(value);
    } catch (error) {
        return `${Math.round(value).toLocaleString()}`;
    }
}

function roundValue(value) {
    if (!isFinite(value)) return '0';
    return Math.round(value).toLocaleString();
}

function formatValue(value, decimals = 2) {
    if (value === null || value === undefined) return '—';
    if (value === Infinity) return '∞';
    if (value === -Infinity) return '-∞';
    if (Number.isNaN(value)) return 'NaN';
    if (!isFinite(value)) return '—';
    return value.toFixed(decimals);
}

/**
 * Calculate cumulative EV with proper time-phasing to eliminate abrupt jumps.
 * Instead of crediting full EV at completion, distribute it over the activity duration.
 */
function calculateTimePhasedEV(nodes, day, statusDate) {
    let cumEarnedHours = 0;

    for (const node of nodes) {
        if (node.Duration === 0 || node.Duration === "0") continue;

        const plannedHours = convertToHours(
            Number(node.Duration) || 0,
            node.TimeUnits || "Hours"
        );
        if (plannedHours === 0) continue;

        const pct = normalizePercentComplete(node.PercentComplete);
        const actualStart = safeDate(node.ActualStart);
        const actualFinish = safeDate(node.ActualFinish);

        // CASE 1: Activity is 100% complete (has ActualFinish)
        if (actualFinish && actualFinish <= day) {
            // Fully completed - credit all earned value
            cumEarnedHours += plannedHours;
        }
        // CASE 2: Activity is in progress (has ActualStart, EV accrues over duration)
        else if (actualStart && actualStart <= day) {
            if (actualFinish) {
                // We know the finish date - distribute EV linearly over actual duration
                const totalDays = Math.max(1, differenceInCalendarDays(actualFinish, actualStart));
                const elapsedDays = Math.max(0, differenceInCalendarDays(day, actualStart));
                const progress = Math.min(1, elapsedDays / totalDays);
                cumEarnedHours += plannedHours * progress;
            } else if (pct > 0) {
                // CORRECTION: Interpolate EV linearly from Actual Start up to Status Date

                // 1. Calculate the total duration from Start to "Today" (Status Date)
                const durationToDate = Math.max(1, differenceInCalendarDays(statusDate, actualStart));

                // 2. Calculate how far along 'day' is in that timeframe
                const daysElapsed = Math.max(0, differenceInCalendarDays(day, actualStart));

                // 3. Determine the interpolation factor (0.0 to 1.0)
                // We clamp at 1.0 to ensure we don't project past the current % complete for dates after Status Date
                const interpolationFactor = Math.min(1, daysElapsed / durationToDate);

                // 4. Apply the factor to the Total Earned Value
                cumEarnedHours += (plannedHours * pct) * interpolationFactor;
            }
        }
        // CASE 3: Has progress but no actual dates - use planned dates for time-phasing
        // (mirrors the inline EV logic in createActualEVMChart)
        else if (pct > 0 && day <= statusDate) {
            const plannedStart = safeDate(node.riskAdjustedStart || node.Start);
            const plannedFinish = safeDate(node.riskAdjustedEnd || node.Finish);

            if (plannedFinish && plannedFinish <= day) {
                cumEarnedHours += plannedHours * pct;
            } else if (plannedStart && plannedStart <= day) {
                if (plannedFinish) {
                    const totalDays = Math.max(1, differenceInCalendarDays(plannedFinish, plannedStart));
                    const elapsedDays = Math.max(0, differenceInCalendarDays(day, plannedStart));
                    const timeProgress = Math.min(1, elapsedDays / totalDays);
                    cumEarnedHours += plannedHours * Math.min(timeProgress, pct);
                } else {
                    cumEarnedHours += plannedHours * pct;
                }
            }
        }
        // CASE 4: Future dates - use predicted values
        else if (day > statusDate) {
            const predEnd = safeDate(node.predictedEnd);
            const predStart = safeDate(node.predictedStart || node.Start);

            if (predEnd && predEnd <= day) {
                // Predicted to be complete by this date
                cumEarnedHours += plannedHours;
            } else if (predStart && predStart <= day && predEnd && day < predEnd) {
                // Predicted to be in progress
                const totalDays = Math.max(1, differenceInCalendarDays(predEnd, predStart));
                const elapsedDays = Math.max(0, differenceInCalendarDays(day, predStart));
                const predictedProgress = Math.min(1, elapsedDays / totalDays);
                cumEarnedHours += plannedHours * predictedProgress;
            }
        }
    }

    return cumEarnedHours;
}


// =============================================================================
// FIX 2: Topological Order-Based Prediction Propagation
// Replace the dependency enforcement loop in updatePredictedValues_Improved
// =============================================================================

/**
 * Propagate predicted dates in topological order for correct chain-based predictions.
 * This ensures activities further down the chain respect all predecessor constraints.
 */
function propagatePredictionsTopologically(nodes, links, nodeMap) {
    // Try to use pre-computed topological order from PathScripts
    let topoOrder = window.cybereumState?.topoOrder || window.cybereumState?.cpm?.topoOrder; // FIX: check both top-level and cpm sub-object

    if (!topoOrder || topoOrder.length === 0) {
        // Fallback: compute simple topological order via Kahn's algorithm
        topoOrder = computeTopologicalOrder(nodes, links, nodeMap);
    }

    // Build predecessor map for quick lookup
    const predMap = window.cybereumState?.predMap || window.cybereumState?.cpm?.predMap || buildPredecessorMap(links); // FIX: cpm fallback

    // Process nodes in topological order
    for (const nodeId of topoOrder) {
        const node = nodeMap.get(String(nodeId));
        if (!node) continue;

        // Skip if activity already has actual start (can't adjust started activities)
        if (node.ActualStart) continue;

        // Get all predecessor links
        const predLinks = predMap.get(String(nodeId)) || [];

        let maxRequiredStart = null;

        for (const link of predLinks) {
            const pred = nodeMap.get(String(link.source));
            if (!pred) continue;

            // Calculate lag in hours
            const lagHours = getLinkLagHours(link);

            // Handle all relationship types
            const linkType = (link.type || link.linkType || 'FS').toUpperCase();
            let reqStart = null;

            switch (linkType) {
                case 'FS':  // Finish-to-Start
                    reqStart = addDurationToDate(pred.predictedEnd, lagHours, _evmHoursPerDay(), _evmDaysPerWeek(), "Hours");
                    break;
                case 'SS':  // Start-to-Start
                    reqStart = addDurationToDate(pred.predictedStart, lagHours, _evmHoursPerDay(), _evmDaysPerWeek(), "Hours");
                    break;
                case 'FF':  // Finish-to-Finish
                    const reqEnd = addDurationToDate(pred.predictedEnd, lagHours, _evmHoursPerDay(), _evmDaysPerWeek(), "Hours");
                    if (reqEnd && node.predictedDuration > 0) {
                        reqStart = subtractDurationFromDate(reqEnd, node.predictedDuration, _evmHoursPerDay(), _evmDaysPerWeek(), "Hours");
                    }
                    break;
                case 'SF':  // Start-to-Finish
                    const reqEnd2 = addDurationToDate(pred.predictedStart, lagHours, _evmHoursPerDay(), _evmDaysPerWeek(), "Hours");
                    if (reqEnd2 && node.predictedDuration > 0) {
                        reqStart = subtractDurationFromDate(reqEnd2, node.predictedDuration, _evmHoursPerDay(), _evmDaysPerWeek(), "Hours");
                    }
                    break;
                default:
                    reqStart = addDurationToDate(pred.predictedEnd, lagHours, _evmHoursPerDay(), _evmDaysPerWeek(), "Hours");
            }

            // Track the latest required start from all predecessors
            if (reqStart && (!maxRequiredStart || reqStart > maxRequiredStart)) {
                maxRequiredStart = reqStart;
            }
        }

        // Apply constraint if needed
        if (maxRequiredStart && maxRequiredStart > node.predictedStart) {
            node.predictedStart = maxRequiredStart;
            node.predictedEnd = addDurationToDate(
                maxRequiredStart,
                node.predictedDuration, _evmHoursPerDay(), _evmDaysPerWeek(),
                "Hours"
            );
        }
    }
}

/**
 * Compute topological order using Kahn's algorithm.
 * Fallback if window.cybereumState.topoOrder is not available.
 */
function computeTopologicalOrder(nodes, links, nodeMap) {
    const inDegree = new Map();
    const adjList = new Map();

    // Initialize
    for (const node of nodes) {
        const id = String(node.ID);
        inDegree.set(id, 0);
        adjList.set(id, []);
    }

    // Build adjacency list and in-degrees
    for (const link of links) {
        const source = String(link.source);
        const target = String(link.target);

        if (adjList.has(source)) {
            adjList.get(source).push(target);
        }
        if (inDegree.has(target)) {
            inDegree.set(target, inDegree.get(target) + 1);
        }
    }

    // Kahn's algorithm
    const queue = [];
    const result = [];

    // Start with nodes having no predecessors
    for (const [id, degree] of inDegree) {
        if (degree === 0) {
            queue.push(id);
        }
    }

    while (queue.length > 0) {
        const current = queue.shift();
        result.push(current);

        for (const neighbor of (adjList.get(current) || [])) {
            const newDegree = inDegree.get(neighbor) - 1;
            inDegree.set(neighbor, newDegree);

            if (newDegree === 0) {
                queue.push(neighbor);
            }
        }
    }

    // If result doesn't contain all nodes, there's a cycle
    if (result.length !== nodes.length) {
        console.warn('[EVM] Topological sort incomplete - possible cycle in dependencies');
    }

    return result;
}

/**
 * Build predecessor map from links array.
 * Fallback if window.cybereumState.predMap is not available.
 */
function buildPredecessorMap(links) {
    const predMap = new Map();

    for (const link of links) {
        const target = String(link.target);
        if (!predMap.has(target)) {
            predMap.set(target, []);
        }
        predMap.get(target).push(link);
    }

    return predMap;
}


// =============================================================================
// FIX 3: Distance Decay for Activity Predictions
// Add this function and call it after initial prediction assignment
// =============================================================================

/**
 * Apply distance-based decay to predictions.
 * Activities closer to actual progress (frontier nodes) get stronger adjustments.
 * Activities farther down the chain use values closer to the forecasted baseline.
 * 
 * @param {Array} nodes - All project nodes
 * @param {Array} frontierNodes - Nodes with actual progress at the frontier
 * @param {Map} nodeMap - Node lookup map
 * @param {Map} succMap - Successor map from PathScripts
 * @param {number} performanceDelta - Current performance delta
 * @param {number} decayFactor - How quickly to decay (0.8 = 80% per hop)
 */
function applyDistanceDecay(nodes, frontierNodes, nodeMap, succMap, performanceDelta, decayFactor = 0.85) {
    if (!frontierNodes || frontierNodes.length === 0) {
        console.log('[Distance Decay] No frontier nodes - skipping decay');
        return;
    }

    // BFS to compute distance from frontier nodes
    const distanceFromFrontier = new Map();
    const queue = [];

    // Initialize with frontier nodes at distance 0
    for (const fn of frontierNodes) {
        const fnId = String(fn.ID || fn);
        distanceFromFrontier.set(fnId, 0);
        queue.push(fnId);
    }

    // BFS traversal
    while (queue.length > 0) {
        const nodeId = queue.shift();
        const dist = distanceFromFrontier.get(nodeId);
        const successors = succMap?.get(nodeId) || [];

        for (const succ of successors) {
            const succId = String(succ.target || succ);
            if (!distanceFromFrontier.has(succId)) {
                distanceFromFrontier.set(succId, dist + 1);
                queue.push(succId);
            }
        }
    }

    // Apply decayed performance delta
    let adjustedCount = 0;

    for (const [nodeId, dist] of distanceFromFrontier) {
        const node = nodeMap.get(nodeId);
        if (!node) continue;

        // Skip completed or in-progress activities
        if (node.ActualStart || node.ActualFinish) continue;
        if (normalizePercentComplete(node.PercentComplete) > 0) continue;

        // Calculate decayed performance delta
        // At distance 0: full performanceDelta
        // At distance 1: decayFactor * performanceDelta + (1-decayFactor) * 1
        // At distance n: decayFactor^n * performanceDelta + (1-decayFactor^n) * 1
        const decayedWeight = Math.pow(decayFactor, dist);
        const decayedDelta = decayedWeight * performanceDelta + (1 - decayedWeight) * 1;

        // Recalculate predicted duration with decay
        const plannedH = convertToHours(Number(node.Duration) || 0, node.TimeUnits || "Hours");
        const riskH = convertToHours(
            Number(node.riskAdjustedDuration ?? node.Duration) || 0,
            node.TimeUnits || "Hours"
        );
        const baseH = riskH || plannedH;

        // Apply decayed performance delta
        const originalPredicted = node.predictedDuration;
        node.predictedDuration = baseH * decayedDelta;

        // Recalculate end date
        if (node.predictedStart) {
            node.predictedEnd = addDurationToDate(
                node.predictedStart,
                node.predictedDuration, _evmHoursPerDay(), _evmDaysPerWeek(),
                "Hours"
            );
        }

        adjustedCount++;

        if (dist <= 3) {  // Log first few levels
            console.log(`[Distance Decay] Node ${nodeId}: dist=${dist}, ` +
                `decay=${decayedWeight.toFixed(3)}, ` +
                `delta=${decayedDelta.toFixed(3)}, ` +
                `dur: ${originalPredicted?.toFixed(0)} → ${node.predictedDuration?.toFixed(0)}`);
        }
    }

    console.log(`[Distance Decay] Adjusted ${adjustedCount} nodes with decay factor ${decayFactor}`);
}


// =============================================================================
// FIX 4: Data Source Accessor Functions for Backward Compatibility
// =============================================================================

/**
 * Unified accessor for EVM data sources.
 * Provides backward compatibility with older naming conventions.
 * 
 * @param {string} type - The data type to retrieve
 * @returns {Array|Object|null} - The requested data
 */
function getEVMDataSource(type) {
    const metrics = window.cybereumState?.evmMetrics || evmMetrics;

    switch (type) {
        // Planned data
        case 'planned.cumulative':
            return metrics.distributionPlanned || [];
        case 'planned.cumulative.cost':
            return metrics.distributionPlannedCost || [];
        case 'planned.timephased':
            return convertCumulativeToTimephased(metrics.distributionPlanned);

        // Actual data
        case 'actual.cumulative':
            return metrics.actual?.distributionActual || [];
        case 'actual.cumulative.cost':
            return metrics.actual?.distributionActualCost || [];
        case 'actual.timephased':
            return metrics.actual?.nonCumulativeDistributionActual || [];

        // Earned value
        case 'earned.cumulative':
            return metrics.actual?.distributionEarned || [];
        case 'earned.cumulative.cost':
            return metrics.actual?.distributionEarnedCost || [];
        case 'earned.timephased':
            return metrics.actual?.nonCumulativeDistributionEarned || [];

        // Predicted
        case 'predicted.cumulative':
            return metrics.actual?.distributionPredicted || [];
        case 'predicted.cumulative.cost':
            return metrics.actual?.distributionPredictedCost || [];

        // Forecasted
        case 'forecasted.cumulative':
            return metrics.forecasted?.distributionWithOverrun || [];
        case 'forecasted.ev':
            return metrics.forecasted?.evDistribution || [];

        // Periods (generated)
        case 'periods':
            return generatePeriodsFromMetrics(metrics);

        // S-curve data (alias)
        case 'sCurveData':
            return {
                planned: metrics.distributionPlanned,
                actual: metrics.actual?.distributionActual,
                earned: metrics.actual?.distributionEarned,
                predicted: metrics.actual?.distributionPredicted,
                dates: metrics.allDates
            };

        default:
            console.warn(`[EVM] Unknown data source type: ${type}`);
            return null;
    }
}

/**
 * Convert cumulative distribution to timephased (non-cumulative).
 */
function convertCumulativeToTimephased(cumulativeData) {
    if (!Array.isArray(cumulativeData) || cumulativeData.length === 0) {
        return [];
    }

    const timephased = [];
    let prevValue = 0;

    for (const point of cumulativeData) {
        const value = point.hours || point.cost || 0;
        timephased.push({
            date: point.date,
            value: value - prevValue,
            hours: (point.hours || 0) - prevValue,
            cost: (point.cost || 0) - prevValue
        });
        prevValue = value;
    }

    return timephased;
}

/**
 * Generate period data from metrics (for backward compatibility with periods[] source).
 */
function generatePeriodsFromMetrics(metrics) {
    const dates = metrics.allDates || [];
    const periods = [];

    for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        periods.push({
            date: date,
            period: i + 1,
            planned: findValueAtDate(metrics.distributionPlanned, date, 'hours'),
            actual: findValueAtDate(metrics.actual?.distributionActual, date, 'hours'),
            earned: findValueAtDate(metrics.actual?.distributionEarned, date, 'hours'),
            predicted: findValueAtDate(metrics.actual?.distributionPredicted, date, 'hours')
        });
    }

    return periods;
}

/**
 * Helper to find value at a specific date in a distribution array.
 */
function findValueAtDate(distribution, date, key) {
    if (!Array.isArray(distribution)) return null;
    const point = distribution.find(d => d.date === date);
    return point ? (point[key] || point.value || 0) : null;
}

// Backend EVM service configuration (Pyth-Sched-Analytics /evm/analyze).
// When true and the endpoint responds successfully, metrics and
// distributions are computed backend-side; the in-browser EVM functions
// (getCumulativeDistribution, createActualEVMChart) are used as
// transparent fallback on any failure (network, non-200, timeout).
// Set useBackendEVM = false to force the legacy in-browser path.
const evmBackendConfig = {
    useBackendEVM: true,
    evmEndpoint: '/evm/analyze',
    evmRequestTimeoutMs: 15000,
};

// Configuration object for customization
const evmConfig = {
    bounds: {
        minCPI: 0.05,
        maxCPI: 20,
        minSPI: 0.05,
        maxSPI: 10,
        minEAC: 0.8,  // As factor of BAC
        maxEAC: 3.0,  // As factor of BAC
        maxDelayDays: 365,
        maxPerformanceFactor: 2.0,
        minPerformanceDelta: 0.5,  // FIX: Added minimum bound
        maxPerformanceDelta: 2.0
    },
    performance: {
        warnThreshold: 1000,  // Warn if processing > 1000 nodes
        enableCache: true,
        logPerformance: false
    },
    validation: {
        strictMode: false,
        requireActualDates: false,
        minDuration: 0
    },
    display: {
        maxTableRows: 100,
        chartHeight: 600,
        minChartWidth: 800
    }
};

// FIX #17: Sector schedule overrun lookup table
// Based on industry research (Oxford megaproject studies, Flyvbjerg et al.)
const SECTOR_SCHEDULE_OVERRUN = {
    // High-complexity sectors
    'nuclear': 0.65,   // 65% average schedule overrun
    'nuclear energy': 0.65,
    'oil and gas': 0.64,   // 64% average schedule overrun
    'oil & gas': 0.64,
    'oilgas': 0.64,
    'o&g': 0.64,
    'lng': 0.58,   // LNG slightly lower
    'petrochemical': 0.55,

    // Infrastructure sectors
    'infrastructure': 0.37,   // 37% average
    'epc': 0.37,
    'civil': 0.35,
    'transportation': 0.40,
    'rail': 0.45,
    'mining': 0.42,

    // Construction sectors
    'construction': 0.25,
    'commercial': 0.20,   // 20% average
    'buildings': 0.20,
    'residential': 0.15,
    'industrial': 0.30,

    // Defense and government
    'defense': 0.50,   // 50% average
    'government': 0.45,
    'federal': 0.45,
    'military': 0.50,

    // Technology
    'technology': 0.25,
    'software': 0.30,
    'it': 0.28,

    // Default
    'default': 0.25    // Conservative default
};

/**
 * FIX #17: Get sector schedule overrun from project sector tag
 * @param {Object} project - Project object with sector property
 * @returns {number} Schedule overrun as decimal (e.g., 0.65 = 65%)
 */
function getSectorScheduleOverrun(project) {
    // Try multiple possible locations for sector tag
    const sectorTag = project?.sector ||
        project?.projectType ||
        project?.category ||
        project?.industry ||
        window.cybereumState?.project?.sector ||
        '';

    // Normalize: lowercase and trim
    const normalizedSector = String(sectorTag).toLowerCase().trim();

    // Direct match
    if (SECTOR_SCHEDULE_OVERRUN[normalizedSector] !== undefined) {
        console.log(`[Sector Lookup] Found exact match: "${normalizedSector}" → ${(SECTOR_SCHEDULE_OVERRUN[normalizedSector] * 100).toFixed(0)}% overrun`);
        return SECTOR_SCHEDULE_OVERRUN[normalizedSector];
    }

    // Partial match (e.g., "Oil and Gas Development" matches "oil and gas")
    for (const [key, value] of Object.entries(SECTOR_SCHEDULE_OVERRUN)) {
        if (normalizedSector.includes(key) || key.includes(normalizedSector)) {
            console.log(`[Sector Lookup] Found partial match: "${sectorTag}" → "${key}" → ${(value * 100).toFixed(0)}% overrun`);
            return value;
        }
    }

    // Fallback to explicit scheduleOverrun if set
    if (project?.scheduleOverrun != null && project.scheduleOverrun > 0) {
        console.log(`[Sector Lookup] Using explicit scheduleOverrun: ${(project.scheduleOverrun * 100).toFixed(0)}%`);
        return project.scheduleOverrun;
    }

    console.warn(`[Sector Lookup] No match for "${sectorTag}", using default ${(SECTOR_SCHEDULE_OVERRUN.default * 100).toFixed(0)}%`);
    return SECTOR_SCHEDULE_OVERRUN.default;
}

// Comprehensive input validation with helpful messages
function validateNodes(nodes) {
    const errors = [];
    const warnings = [];

    if (!Array.isArray(nodes)) {
        errors.push('Nodes must be an array');
        return { isValid: false, errors, warnings };
    }

    if (nodes.length === 0) {
        errors.push('Nodes array is empty');
        return { isValid: false, errors, warnings };
    }

    // Check for start node
    const startNode = nodes.find(n => String(n.ID) === "0");
    if (!startNode) {
        errors.push('Missing start node (ID="0")');
    }

    // Validate each node
    nodes.forEach((node, idx) => {
        if (node.ID === undefined || node.ID === null || node.ID === "") {
            errors.push(`Node at index ${idx} missing ID`);
        }

        if (!node.Start) {
            errors.push(`Node ${node.ID || idx} missing Start date`);
        } else if (!safeDate(node.Start)) {
            errors.push(`Node ${node.ID || idx} has invalid Start date: ${node.Start}`);
        }

        if (!node.Finish) {
            errors.push(`Node ${node.ID || idx} missing Finish date`);
        } else if (!safeDate(node.Finish)) {
            errors.push(`Node ${node.ID || idx} has invalid Finish date: ${node.Finish}`);
        }

        if (node.Duration === undefined || node.Duration === null) {
            warnings.push(`Node ${node.ID || idx} missing Duration`);
        } else if (parseFloat(node.Duration) < 0) {
            errors.push(`Node ${node.ID || idx} has negative Duration: ${node.Duration}`);
        }

        // Validate date logic
        const start = safeDate(node.Start);
        const finish = safeDate(node.Finish);
        if (start && finish && start > finish) {
            errors.push(`Node ${node.ID || idx} Start date is after Finish date`);
        }

        // Check for actual data consistency
        if (node.ActualStart && node.ActualFinish) {
            const aStart = safeDate(node.ActualStart);
            const aFinish = safeDate(node.ActualFinish);
            if (aStart && aFinish && aStart > aFinish) {
                errors.push(`Node ${node.ID || idx} ActualStart is after ActualFinish`);
            }
        }

        // Validate percent complete
        const pct = normalizePercentComplete(node.PercentComplete);
        if (pct > 1) {
            warnings.push(`Node ${node.ID || idx} has invalid percent complete after normalization`);
        }
    });

    // Check for circular dependencies (basic check)
    const nodeIds = new Set(nodes.map(n => String(n.ID)));

    // Check for actual data availability
    const hasActualData = nodes.some(n =>
        n.ActualStart || n.ActualFinish ||
        (normalizePercentComplete(n.PercentComplete) > 0)
    );

    return {
        isValid: errors.length === 0,
        errors,
        warnings,
        hasActualData
    };
}

// OPTIMIZATION: Create node lookup map for O(1) access
function createNodeMap(nodes) {
    const map = new Map();
    for (const node of nodes) {
        map.set(String(node.ID), node);
    }
    return map;
}

// Performance tracking wrapper
function withPerformanceTracking(fn, label = 'operation') {
    return function (...args) {
        const startTime = evmConfig.performance.logPerformance ? performance.now() : 0;
        const result = fn.apply(this, args);
        if (evmConfig.performance.logPerformance) {
            console.log(`[EVM Performance] ${label}: ${(performance.now() - startTime).toFixed(2)}ms`);
        }
        return result;
    };
}

/********************
 * HELPER FUNCTIONS
 ********************/



// Difference in calendar days
function differenceInCalendarDays(dateA, dateB) {
    if (!dateA || !dateB) return 0;
    const a = safeDate(dateA);
    const b = safeDate(dateB);
    if (!a || !b) return 0;
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.round((a - b) / msPerDay);
}

/**
 * Adds a duration to a date, skipping weekends (Sat/Sun).
 * Uses global convertDurationToHours for normalization.
 */
function addDurationToDate(startDate, duration, hoursPerDay, daysPerWeek, timeUnits = "Hours") {
    const start = safeDate(startDate);
    if (!start) return null;

    // Normalize input to hours using existing script helper
    const h = convertToHours(duration, timeUnits);

    // Calculate total working days to add
    // Note: We ceil because even 1 hour of work spills into a new day in this simple model
    const daysToAdd = Math.ceil(h / hoursPerDay);

    let workDaysAdded = 0;
    const current = new Date(start);

    // If adding 0 duration, return start date
    if (daysToAdd <= 0) return current;

    // Use calendar working days instead of hardcoded Sat/Sun
    const wdSet = _evmGetWorkingDaySet();
    const holidays = _evmGetHolidaySet();

    while (workDaysAdded < daysToAdd) {
        // Move forward one day
        current.setDate(current.getDate() + 1);
        const dow = current.getDay();
        const dk = _evmDateKey(current);

        if (wdSet.has(dow) && !holidays.has(dk)) {
            workDaysAdded++;
        }
    }

    return current;
}

/**
 * Subtracts a duration from a date, skipping weekends (Sat/Sun) in reverse.
 * Required for "Finish-to-Finish" and "Start-to-Finish" backward passes.
 */
function subtractDurationFromDate(endDate, duration, hoursPerDay = 8, daysPerWeek = 5, timeUnits = "Hours") {
    const end = safeDate(endDate);
    if (!end) return null;

    const h = convertToHours(duration, timeUnits);
    const daysToSubtract = Math.ceil(h / hoursPerDay);

    let workDaysSubtracted = 0;
    const current = new Date(end);

    if (daysToSubtract <= 0) return current;

    // Use calendar working days instead of hardcoded Sat/Sun
    const wdSet = _evmGetWorkingDaySet();
    const holidays = _evmGetHolidaySet();

    while (workDaysSubtracted < daysToSubtract) {
        // Move backward one day
        current.setDate(current.getDate() - 1);
        const dow = current.getDay();
        const dk = _evmDateKey(current);

        if (wdSet.has(dow) && !holidays.has(dk)) {
            workDaysSubtracted++;
        }
    }

    return current;
}

// Check if actual data is available
function checkIfActualDataAvailable(nodes) {
    if (!Array.isArray(nodes)) return false;
    return nodes.some(n =>
        (n.ActualStart || n.ActualFinish) ||
        (normalizePercentComplete(n.PercentComplete) > 0 && n.ID !== "0")
    );
}

/********************
 * CORE EVM CALCULATIONS
 ********************/

// Calculate BCWS (Budgeted Cost of Work Scheduled) - in HOURS
function calculateBCWS_Hours(nodes, statusDate) {
    if (!Array.isArray(nodes) || !statusDate) return 0;

    const statusTime = safeDate(statusDate)?.getTime();
    if (!statusTime) return 0;

    let bcws = 0;

    nodes.forEach(node => {
        if (node.Duration === 0 || node.Duration === "0") return;

        const plannedStart = safeDate(node.Start)?.getTime();
        const plannedEnd = safeDate(node.Finish)?.getTime();
        const plannedDuration = convertToHours(node.Duration, node.TimeUnits || "Hours");

        if (!plannedStart || !plannedEnd || !plannedDuration) return;

        if (statusTime >= plannedEnd) {
            bcws += plannedDuration;
        } else if (statusTime > plannedStart && statusTime < plannedEnd) {
            const totalDuration = plannedEnd - plannedStart;
            const elapsed = statusTime - plannedStart;
            const progress = elapsed / totalDuration;
            bcws += plannedDuration * progress;
        }
    });

    return bcws;
}

// Calculate actual BCWP (Earned Value) - in HOURS
function calculateBCWP_Hours(nodes) {
    if (!Array.isArray(nodes)) return 0;
    let sum = 0;
    for (const n of nodes) {
        if (n.Duration === 0 || n.Duration === "0") continue;
        const pct = normalizePercentComplete(n.PercentComplete);
        sum += convertToHours(Number(n.Duration) || 0, n.TimeUnits || "Hours") * pct;
    }
    return sum;
}

// Calculate ACWP with simplified logic
function calculateACWP(nodes, CostRate = 1) {
    if (!Array.isArray(nodes)) return 0;

    let totalACWP = 0;
    const today = new Date();

    nodes.forEach(node => {
        try {
            if (node.Duration === 0 || node.Duration === "0") return;

            const pct = normalizePercentComplete(node.PercentComplete);
            if (pct === 0) return;

            const actualCost = parseFloat(node.ActualCost);
            if (actualCost && isFinite(actualCost) && actualCost > 0) {
                totalACWP += actualCost;
            } else {
                const nodeStart = safeDate(node.ActualStart || node.Start);
                if (!nodeStart) return;

                const plannedHours = convertToHours(
                    parseFloat(node.Duration) || 0,
                    node.TimeUnits || "Hours"
                );
                const plannedCostRate = parseFloat(node.CostRate) || CostRate;

                if (isFinite(plannedHours)) {
                    let costMultiplier = 1.0;

                    if (pct < 1) {
                        const plannedFinish = safeDate(node.Finish);
                        const elapsedDays = differenceInCalendarDays(today, nodeStart);
                        const plannedDays = plannedFinish ?
                            Math.max(1, differenceInCalendarDays(plannedFinish, nodeStart)) : 1;

                        if (elapsedDays > 0 && plannedDays > 0) {
                            const expectedProgress = Math.min(1, elapsedDays / plannedDays);
                            if (pct < expectedProgress && expectedProgress > 0) {
                                costMultiplier = clampNum(expectedProgress / pct, 1.0, 2.0);
                            }
                        }
                    }

                    totalACWP += plannedHours * pct * plannedCostRate * costMultiplier;
                }
            }
        } catch (error) {
            console.warn(`Error processing node ${node.ID} in calculateACWP:`, error);
        }
    });

    return totalACWP;
}

// Calculate Budget at Completion (BAC) - in HOURS
function calculateBAC_Hours(nodes) {
    if (!Array.isArray(nodes)) return 0;
    let sum = 0;
    for (const n of nodes) {
        if (n.Duration === 0 || n.Duration === "0") continue;
        sum += convertToHours(Number(n.Duration) || 0, n.TimeUnits || "Hours");
    }
    return sum;
}

// Simplified EAC calculation with clearer bounds
function calculateEAC(BAC, CPI, SPI = 1, percentComplete = 0) {
    if (!isFinite(BAC) || BAC <= 0) {
        console.warn("Invalid BAC for EAC calculation:", BAC);
        return 0;  // Cannot estimate completion cost without valid budget
    }

    CPI = isFinite(CPI) ? clampNum(CPI, evmConfig.bounds.minCPI, evmConfig.bounds.maxCPI) : 1;
    SPI = isFinite(SPI) ? clampNum(SPI, evmConfig.bounds.minSPI, evmConfig.bounds.maxSPI) : 1;
    percentComplete = clampNum(percentComplete, 0, 100);

    const EV = BAC * (percentComplete / 100);
    const AC = CPI > 0 ? EV / CPI : EV;
    const remaining = BAC - EV;

    let eac;

    if (percentComplete < 10) {
        eac = BAC * 1.15;
    } else if (percentComplete > 90) {
        eac = AC + remaining;
    } else if (CPI < 0.8 || CPI > 1.2) {
        eac = AC + (remaining / (CPI * SPI));
    } else {
        eac = AC + (remaining / CPI);
    }

    const lowerBound = Math.max(AC, BAC * 0.8);
    const upperBound = BAC * (percentComplete > 50 ? 2.5 : 3.0);

    return clampNum(eac, lowerBound, upperBound);
}

// Calculate EVM performance metrics
function calculateEVMetrics(BCWP, ACWP, BCWS) {
    if (!isFinite(BCWP) || !isFinite(ACWP) || !isFinite(BCWS)) {
        console.error("Invalid inputs to calculateEVMetrics");
        return {
            SV: 0,
            CV: 0,
            SPI: 1,
            SPI_model: 1,
            CPIcum: 1,
            CPIcum_model: 1,
            flags: { invalidInputs: true }
        };
    }

    const SV = BCWP - BCWS;
    const CV = BCWP - ACWP;

    // SPI (raw): EV / PV. Do NOT clamp here—clamping belongs in the model/UI layer.
    // If PV is zero but EV exists, surface the anomaly as Infinity (data-quality / phasing issue).
    const SPI = BCWS > 0 ? (BCWP / BCWS) : (BCWP > 0 ? Infinity : 1);

    // CPI (raw): EV / AC. If AC is zero but EV exists, surface as Infinity (missing actuals).
    const CPIcum = ACWP > 0 ? (BCWP / ACWP) : (BCWP > 0 ? Infinity : 1);

    // Model-safe versions (unified bounds)
    const SPI_model = isFinite(SPI) ? clampNum(SPI, evmConfig.bounds.minSPI, evmConfig.bounds.maxSPI) : 1;
    const CPIcum_model = isFinite(CPIcum) ? clampNum(CPIcum, evmConfig.bounds.minCPI, evmConfig.bounds.maxCPI) : 1;

    const flags = {
        pvZeroWithEV: (BCWS <= 0 && BCWP > 0),
        acZeroWithEV: (ACWP <= 0 && BCWP > 0)
    };

    return { SV, CV, SPI, SPI_model, CPIcum, CPIcum_model, flags };
}

// Forecasted BCWP using risk-adjusted dates
function calculateForecastedBCWP(nodes, statusDate) {
    if (!Array.isArray(nodes) || !statusDate) return 0;

    const statusTime = safeDate(statusDate)?.getTime();
    if (!statusTime) return 0;

    let bcwp = 0;

    nodes.forEach(node => {
        if (node.Duration === 0 || node.Duration === "0") return;

        const riskStart = safeDate(node.riskAdjustedStart || node.Start)?.getTime();
        const riskEnd = safeDate(node.riskAdjustedEnd || node.Finish)?.getTime();
        const plannedDuration = convertToHours(node.Duration, node.TimeUnits || "Hours");

        if (!riskStart || !riskEnd || !plannedDuration) return;

        if (statusTime >= riskEnd) {
            bcwp += plannedDuration;
        } else if (statusTime > riskStart && statusTime < riskEnd) {
            const totalDuration = riskEnd - riskStart;
            const elapsed = statusTime - riskStart;
            const progress = elapsed / totalDuration;
            bcwp += plannedDuration * progress;
        }
    });

    return bcwp;
}

// Forecasted ACWP using risk-adjusted durations
function calculateForecastedACWP(nodes, statusDate) {
    if (!Array.isArray(nodes) || !statusDate) return 0;

    const statusTime = safeDate(statusDate)?.getTime();
    if (!statusTime) return 0;

    let acwp = 0;

    nodes.forEach(node => {
        if (node.Duration === 0 || node.Duration === "0") return;

        const riskStart = safeDate(node.riskAdjustedStart || node.Start)?.getTime();
        const riskEnd = safeDate(node.riskAdjustedEnd || node.Finish)?.getTime();
        const riskDuration = convertToHours(
            node.riskAdjustedDuration || node.Duration,
            node.TimeUnits || "Hours"
        );
        const costRate = parseFloat(node.CostRate) || 1;

        if (!riskStart || !riskEnd || !riskDuration) return;

        if (statusTime >= riskEnd) {
            acwp += riskDuration * costRate;
        } else if (statusTime > riskStart && statusTime < riskEnd) {
            const totalDuration = riskEnd - riskStart;
            const elapsed = statusTime - riskStart;
            const progress = elapsed / totalDuration;
            acwp += riskDuration * costRate * progress;
        }
    });

    return acwp;
}

/********************
 * AUTO-COMPLETE START MILESTONE
 * FIX #9: Automatically set start milestone to 100% when actual progress exists
 * FIX #14: Track completion to prevent duplicate calls
 ********************/

// Track if start milestone has been auto-completed for current data set
let startMilestoneAutoCompleted = false;

function resetStartMilestoneTracking() {
    startMilestoneAutoCompleted = false;
}

function autoCompleteStartMilestone(nodes) {
    if (!Array.isArray(nodes)) return;

    // FIX #14: Prevent duplicate auto-completion
    if (startMilestoneAutoCompleted) return;

    const startNode = nodes.find(n => n.ID === "0" || String(n.ID) === "0");
    if (!startNode) return;

    const hasActualProgress = checkIfActualDataAvailable(nodes);

    if (hasActualProgress) {
        // Find earliest actual start date in the project
        let earliestActualStart = null;
        nodes.forEach(n => {
            if (n.ID === "0" || String(n.ID) === "0") return;
            const aStart = safeDate(n.ActualStart);
            if (aStart && (!earliestActualStart || aStart < earliestActualStart)) {
                earliestActualStart = aStart;
            }
        });

        // Set start milestone to 100% complete (stored in 0-100 scale)
        startNode.PercentComplete = 100;

        if (!startNode.ActualStart) {
            startNode.ActualStart = earliestActualStart || safeDate(startNode.Start) || new Date();
        }
        if (!startNode.ActualFinish) {
            startNode.ActualFinish = startNode.ActualStart;
        }

        if (startNode.Duration === undefined || startNode.Duration === null) {
            startNode.Duration = 0;
        }
        startNode.ActualDuration = 0;

        startMilestoneAutoCompleted = true;
        console.log('[EVM] Auto-completed start milestone (ID=0) to 100%');
    }
}

/********************
 * GLOBAL STATE
 ********************/

let evmInitDispatched = false;
const evmInitEvent = new Event('evmInit');

let evmMetrics = {
    distributionPlanned: null,
    distributionPlannedCost: null,
    forecasted: null,
    actual: null,
    allDates: null,
    currency: 'USD'
};

let copiedNodes = [];
let forecastedMetrics = null;
let actualMetrics = null;
let singleEVMChart = null;
let singleEVMCostChart = null;
let singleActualEVMChart = null;
let singleActualEVMCostChart = null;

function initializeEVMUI(nodes) {
    const forecastedTab = document.getElementById('forecasted-tab');
    const actualTab = document.getElementById('actual-tab');
    const forecastedPane = document.getElementById('forecasted');
    const actualPane = document.getElementById('actual');

    if (!forecastedTab || !actualTab || !forecastedPane || !actualPane) {
        // EVM.js is shared across multiple dashboards; only initialize tab UI
        // when the EVM tab structure is present in the current page.
        // Warn only when an EVM tab container exists but the expected tab nodes are malformed.
        // For pages that intentionally do not render EVM tabs, silently skip initialization.
        const hasEVMContainer = !!document.getElementById('evmTab') || !!document.getElementById('evmChartContainer');
        if (hasEVMContainer) {
            console.warn('[EVM] EVM UI container found but required tab elements are missing.');
        }
        return;
    }

    copiedNodes = Array.isArray(nodes) ? [...nodes] : [];
    const hasActualData = checkIfActualDataAvailable(nodes);

    if (!window.evmChartsInitialized) {
        if (evmMetrics.forecasted?.allDates?.length) {
            createEVMCharts(evmMetrics, 'forecasted', 'Cumulative');
        }

        if (hasActualData && evmMetrics.actual?.distributionActual?.length) {
            createEVMCharts(evmMetrics, 'actual', 'Cumulative');
        }
        window.evmChartsInitialized = true;
    }

    function showForecastedTab() {
        forecastedTab.classList.add('active');
        actualTab.classList.remove('active');
        forecastedPane.style.display = 'block';
        actualPane.style.display = 'none';

        if (evmMetrics.forecasted) {
            displayForecastedEVMetrics(
                evmMetrics.forecasted.BCWP,
                evmMetrics.forecasted.ACWP,
                evmMetrics.forecasted.BCWS,
                evmMetrics.forecasted.SPI,
                evmMetrics.forecasted.SV,
                evmMetrics.forecasted.CV,
                evmMetrics.forecasted.CPIcum,
                evmMetrics.forecasted.EAC
            );
        }
    }

    function showActualTab() {
        actualTab.classList.add('active');
        forecastedTab.classList.remove('active');
        actualPane.style.display = 'block';
        forecastedPane.style.display = 'none';

        const noMetricsMessage = document.getElementById('noMetricsMessage');
        if (noMetricsMessage) noMetricsMessage.style.display = 'none';

        const canShowActual = hasActualData &&
            evmMetrics.actual?.distributionActual?.length > 0;

        if (canShowActual) {
            const actualMetrics = document.getElementById('actualEVMetrics');
            const actualTable = document.querySelector('#actualEVMTable');
            if (actualMetrics) actualMetrics.style.display = 'flex';
            if (actualTable?.parentElement) actualTable.parentElement.style.display = 'block';

            const forecastedMetrics = document.getElementById('forecastedEVMetrics');
            const forecastedTable = document.querySelector('#forecastedEVMTable');
            if (forecastedMetrics) forecastedMetrics.style.display = 'none';
            if (forecastedTable?.parentElement) forecastedTable.parentElement.style.display = 'none';

            displayActualEVMetrics(
                evmMetrics.actual.BCWP,
                evmMetrics.actual.ACWP,
                evmMetrics.actual.BCWS,
                evmMetrics.actual.SPI,
                evmMetrics.actual.SV,
                evmMetrics.actual.CV,
                evmMetrics.actual.CPIcum,
                evmMetrics.actual.EAC
            );
        } else {
            const noMetricsMessage = document.getElementById('noMetricsMessage');
            if (noMetricsMessage) noMetricsMessage.style.display = 'block';
        }
    }

    const newForecastedTab = forecastedTab.cloneNode(true);
    const newActualTab = actualTab.cloneNode(true);
    forecastedTab.parentNode.replaceChild(newForecastedTab, forecastedTab);
    actualTab.parentNode.replaceChild(newActualTab, actualTab);

    newForecastedTab.addEventListener('click', (e) => {
        e.preventDefault();
        showForecastedTab();
    });

    newActualTab.addEventListener('click', (e) => {
        e.preventDefault();
        showActualTab();
    });

    showForecastedTab();

    if (evmMetrics.actual?.CPIcum && hasActualData) {
        populateEVMInsights(
            evmMetrics.actual.CPIcum,
            evmMetrics.actual.SPI,
            evmMetrics.actual.EAC,
            evmMetrics.actual.SV,
            evmMetrics.actual.CV
        );
    } else if (evmMetrics.forecasted) {
        populateEVMInsights(
            evmMetrics.forecasted.CPIcum,
            evmMetrics.forecasted.SPI,
            evmMetrics.forecasted.EAC,
            evmMetrics.forecasted.SV,
            evmMetrics.forecasted.CV
        );
    }
}

document.addEventListener('evmInit', () => {
    if (evmInitDispatched) return;
    evmInitDispatched = true;

    const nodes = (window.currentNodes && window.currentNodes.length) ?
        window.currentNodes : copiedNodes;

    initializeEVMUI(nodes);
});

/********************
 * FORECASTED DISTRIBUTION
 ********************/

function getCumulativeDistribution(nodes, links) {
    // Reset tracking for new calculation
    resetStartMilestoneTracking();

    // FIX #9: Auto-complete start milestone before processing
    autoCompleteStartMilestone(nodes);

    // Validate inputs before processing
    const validation = validateNodes(nodes);

    if (!validation.isValid) {
        console.error('Node validation failed:', validation.errors);

        const statsContainer = document.querySelector('#forecastedEVMetrics');
        if (statsContainer) {
            statsContainer.innerHTML = `
                <div class="error-message" style="color: #dc3545; padding: 20px; background: #f8d7da; border-radius: 4px;">
                    <strong>Unable to calculate EVM metrics</strong><br>
                    ${validation.errors.slice(0, 5).map(e => `• ${e}`).join('<br>')}
                    ${validation.errors.length > 5 ? `<br>• ... and ${validation.errors.length - 5} more errors` : ''}
                </div>
            `;
        }
        return;
    }

    if (validation.warnings.length > 0) {
        console.warn('Node validation warnings:', validation.warnings);
    }

    if (nodes.length > evmConfig.performance.warnThreshold) {
        console.warn(`Processing ${nodes.length} nodes - this may take a moment...`);
    }

    // Clear caches for fresh calculation
    if (evmConfig.performance.enableCache) {
        clearCalculationCache();
        clearDateCache();
    }

    const processDistribution = withPerformanceTracking(() => {
        if (!Array.isArray(nodes) || nodes.length === 0) {
            console.error("Invalid nodes array");
            return;
        }

        const workingNodes = [...nodes].sort((a, b) => parseInt(a.ID) - parseInt(b.ID));

        const startNode = workingNodes.find(n => n.ID === "0");
        const endNode = workingNodes.reduce((a, b) =>
            (Number(a.ID) > Number(b.ID)) ? a : b
        );

        if (!startNode || !endNode) {
            console.error("Missing start or end node");
            return;
        }

        const CostRate = parseFloat(startNode.CostRate) || 1;
        const currency = startNode.Currency || 'USD';

        const startDate = safeDate(workingNodes[0].Start);
        const endDate = safeDate(endNode.riskAdjustedEnd || endNode.Finish);
        const plannedEndDate = safeDate(endNode.Finish);

        if (!startDate || !endDate) {
            console.error("Invalid start or end date");
            return;
        }

        // Collect all significant dates
        const dateSet = new Set();
        workingNodes.forEach(node => {
            [node.Start, node.riskAdjustedStart, node.Finish, node.riskAdjustedEnd].forEach(d => {
                const date = safeDate(d);
                if (date) dateSet.add(formatDateLocal(date));
            });
        });

        const comparisonDates = Array.from(dateSet).sort();

        // FIX #13: Use Set for O(1) lookups instead of O(n) includes
        const comparisonDateSet = new Set(comparisonDates);

        // Pre-calculate daily rates for efficiency
        const nodeDailyRates = new Map();
        workingNodes.forEach(node => {
            if (node.Duration === 0 || node.Duration === "0") return;

            const taskStart = safeDate(node.Start);
            const taskEnd = safeDate(node.Finish);
            const riskStart = safeDate(node.riskAdjustedStart || node.Start);
            const riskEnd = safeDate(node.riskAdjustedEnd || node.Finish);

            if (!taskStart || !taskEnd || !riskStart || !riskEnd) return;

            const plannedDays = Math.max(1, differenceInCalendarDays(taskEnd, taskStart));
            const riskDays = Math.max(1, differenceInCalendarDays(riskEnd, riskStart));

            const plannedHours = convertToHours(node.Duration, node.TimeUnits || "Hours");
            const riskHours = convertToHours(
                node.riskAdjustedDuration || node.Duration,
                node.TimeUnits || "Hours"
            );

            nodeDailyRates.set(node.ID, {
                plannedDaily: plannedHours / plannedDays,
                riskDaily: riskHours / riskDays,
                evDaily: plannedHours / riskDays,
                taskStart,
                taskEnd,
                riskStart,
                riskEnd
            });
        });

        // Build distributions
        const distributions = {
            planned: [], withOverrun: [], ev: [],
            plannedCost: [], withOverrunCost: [], evCost: [],
            nonCumPlanned: [], nonCumOverrun: [], nonCumEv: [],
            nonCumPlannedCost: [], nonCumOverrunCost: [], nonCumEvCost: []
        };

        let cumHours = 0, cumOverrun = 0, cumEv = 0;
        let currentDate = new Date(startDate);

        while (currentDate <= endDate) {
            let dailyPlanned = 0, dailyOverrun = 0, dailyEv = 0;

            // OPTIMIZATION: Use pre-cached dates from nodeDailyRates
            nodeDailyRates.forEach((rates, nodeId) => {
                if (rates.taskStart <= currentDate && currentDate <= rates.taskEnd) {
                    dailyPlanned += rates.plannedDaily;
                }

                if (rates.riskStart <= currentDate && currentDate <= rates.riskEnd) {
                    dailyOverrun += rates.riskDaily;
                    dailyEv += rates.evDaily;
                }
            });

            cumHours += dailyPlanned;
            cumOverrun += dailyOverrun;
            cumEv += dailyEv;

            const dateStr = formatDateLocal(currentDate);

            // FIX #13: O(1) Set lookup instead of O(n) includes
            if (comparisonDateSet.has(dateStr)) {
                if (currentDate <= plannedEndDate) {
                    distributions.planned.push({ date: dateStr, hours: cumHours });
                    distributions.plannedCost.push({ date: dateStr, cost: cumHours * CostRate });
                }
                distributions.withOverrun.push({ date: dateStr, hours: cumOverrun });
                distributions.ev.push({ date: dateStr, hours: cumEv });
                distributions.withOverrunCost.push({ date: dateStr, cost: cumOverrun * CostRate });
                distributions.evCost.push({ date: dateStr, cost: cumEv * CostRate });

                distributions.nonCumPlanned.push({ date: dateStr, hours: dailyPlanned });
                distributions.nonCumOverrun.push({ date: dateStr, hours: dailyOverrun });
                distributions.nonCumEv.push({ date: dateStr, hours: dailyEv });
                distributions.nonCumPlannedCost.push({ date: dateStr, cost: dailyPlanned * CostRate });
                distributions.nonCumOverrunCost.push({ date: dateStr, cost: dailyOverrun * CostRate });
                distributions.nonCumEvCost.push({ date: dateStr, cost: dailyEv * CostRate });
            }

            currentDate.setDate(currentDate.getDate() + 1);
        }

        // Calculate totals
        let totalPlanned = 0, totalForecasted = 0;
        workingNodes.forEach(node => {
            if (node.Duration === 0 || node.Duration === "0") return;
            totalPlanned += convertToHours(node.Duration, node.TimeUnits || "Hours");
            totalForecasted += convertToHours(
                node.riskAdjustedDuration || node.Duration,
                node.TimeUnits || "Hours"
            );
        });

        // Calculate EVM metrics at today
        const statusDate = window.cybereumState?.dataDate || new Date();
        const BAC = totalPlanned * CostRate;
        const BCWS = calculateBCWS_Hours(workingNodes, statusDate) * CostRate;
        const BCWP = calculateForecastedBCWP(workingNodes, statusDate) * CostRate;
        const ACWP = calculateForecastedACWP(workingNodes, statusDate) * CostRate;

        const { SV, CV, SPI, SPI_model, CPIcum, CPIcum_model, flags: evmFlags } = calculateEVMetrics(BCWP, ACWP, BCWS);
        const percentComplete = BAC > 0 ? (BCWP / BAC) * 100 : 0;
        const EAC = calculateEAC(BAC, CPIcum_model, SPI_model, percentComplete);

        // Store global distributions
        evmMetrics.distributionPlanned = distributions.planned;
        evmMetrics.distributionPlannedCost = distributions.plannedCost;
        evmMetrics.allDates = comparisonDates;
        evmMetrics.currency = currency;

        // Store forecasted metrics
        evmMetrics.forecasted = {
            BAC, BCWP, ACWP, BCWS, SPI, SV, CV, CPIcum, EAC,
            timeUnits: workingNodes[0]?.TimeUnits || "Hours",
            currency, statusDate, percentComplete,
            distributionWithOverrun: distributions.withOverrun,
            evDistribution: distributions.ev,
            distributionWithOverrunCost: distributions.withOverrunCost,
            evDistributionCost: distributions.evCost,
            nonCumulativeDistributionWithOverrun: distributions.nonCumOverrun,
            nonCumulativeEvDistribution: distributions.nonCumEv,
            nonCumulativeDistributionWithOverrunCost: distributions.nonCumOverrunCost,
            nonCumulativeEvDistributionCost: distributions.nonCumEvCost,
            allDates: comparisonDates
        };

        forecastedMetrics = evmMetrics.forecasted;

        // Export evmMetrics to window so downstream consumers (e.g. ExecutiveDashboard)
        // can access forecasted EVM data even when createActualEVMChart is not called.
        window.cybereumState = window.cybereumState || {};
        window.cybereumState.evmMetrics = evmMetrics;
        window.evmMetrics = evmMetrics;

        // Display results
        displayForecastedEVMetrics(BCWP, ACWP, BCWS, SPI, SV, CV, CPIcum, EAC);
        populateForecastedEVMTable(
            distributions.planned,
            distributions.withOverrun,
            distributions.ev,
            comparisonDates
        );

        copiedNodes = [...workingNodes];
    }, 'getCumulativeDistribution');

    processDistribution();
}

/********************
 * ACTUAL + PREDICTED CHART
 ********************/

function createActualEVMChart(nodes, links) {
    // FIX #14: autoCompleteStartMilestone is already called in getCumulativeDistribution
    // Only call if not already done (tracked by startMilestoneAutoCompleted flag)
    if (!startMilestoneAutoCompleted) {
        autoCompleteStartMilestone(nodes);
    }

    const validation = validateNodes(nodes);

    if (!validation.isValid) {
        console.error('Cannot create actual EVM chart:', validation.errors);

        const statsContainer = document.querySelector('#actualEVMetrics');
        if (statsContainer) {
            statsContainer.innerHTML = `
                <div class="error-message" style="color: #dc3545; padding: 20px; background: #f8d7da; border-radius: 4px;">
                    <strong>Unable to calculate actual EVM metrics</strong><br>
                    ${validation.errors.slice(0, 3).map(e => `• ${e}`).join('<br>')}
                </div>
            `;
        }
        return;
    }

    if (!validation.hasActualData) {
        console.warn('No actual data available for actual EVM chart');
        const noMetricsMessage = document.getElementById('noMetricsMessage');
        if (noMetricsMessage) {
            noMetricsMessage.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #666;">
                    <h4>No Actual Data Available</h4>
                    <p>Import actual progress data to see EVM performance metrics.</p>
                </div>
            `;
            noMetricsMessage.style.display = 'block';
        }
        return;
    }

    const processActualChart = withPerformanceTracking(() => {
        const workingNodes = [...nodes].sort((a, b) => parseInt(a.ID) - parseInt(b.ID));

        // FIX #12: Create node map for O(1) lookups
        const nodeMap = createNodeMap(workingNodes);

        const startNode = workingNodes.find(n => n.ID === "0");
        const endNode = workingNodes.reduce((a, b) =>
            (Number(a.ID) > Number(b.ID)) ? a : b
        );

        if (!startNode || !endNode) {
            console.error("Missing start or end node for actual chart");
            return;
        }

        const CostRate = parseFloat(startNode.CostRate) || 1;
        const currency = startNode.Currency || 'USD';
        const statusDate = window.cybereumState?.dataDate || new Date();

        // Calculate actual EVM metrics
        const BCWS_h = calculateBCWS_Hours(workingNodes, statusDate);
        const BCWP_h = calculateBCWP_Hours(workingNodes);
        const ACWP_c = calculateACWP(workingNodes, CostRate);

        const BCWP = BCWP_h * CostRate;
        const BCWS = BCWS_h * CostRate;
        const ACWP = ACWP_c;

        const { SPI, SPI_model, SV, CV, CPIcum, CPIcum_model, flags: evmFlags } = calculateEVMetrics(BCWP, ACWP, BCWS);

        const BAC_h = calculateBAC_Hours(workingNodes);
        const BAC = BAC_h * CostRate;
        const percentComplete = BAC > 0 ? (BCWP / BAC) * 100 : 0;
        const EAC = calculateEAC(BAC, CPIcum_model, SPI_model, percentComplete);

        // FIX #8, #10, #11: Apply IMPROVED prediction model
        const plannedEndDate = safeDate(endNode.Finish);
        const forecastedEndDate = safeDate(endNode.riskAdjustedEnd || endNode.Finish);

        // FIX #17: Use sector lookup to get schedule overrun based on project tag
        const sectorScheduleOverrun = getSectorScheduleOverrun(window.cybereumState?.project);

        // FIX #18: Pass nodes for duration-weighted progress calculation
        const { scheduleMultiplier, slipDays, performanceDelta, durationWeightedProgress } = computeScheduleDelayImproved(
            statusDate,
            plannedEndDate,
            forecastedEndDate,
            SPI,
            sectorScheduleOverrun,
            workingNodes  // FIX #18: Enable duration-weighted progress comparison
        );

        // FIX #19: Identify frontier nodes (last activities with progress) for future chain-based prediction
        const succMap = window.cybereumState?.succMap || window.cybereumState?.cpm?.succMap; // FIX: check cpm sub-object
        const frontierNodes = succMap ? findLastActiveActivities(workingNodes, succMap, nodeMap) : [];

        // FIX #12: Pass nodeMap and pre-computed frontierNodes for efficient lookups
        updatePredictedValues_Improved(workingNodes, statusDate, scheduleMultiplier, slipDays, performanceDelta, links, nodeMap, frontierNodes);

        // Build timeline - ENHANCED: Add weekly intermediate dates for smoother curves
        const dateSet = new Set();
        let minDate = null;
        let maxDate = null;

        workingNodes.forEach(n => {
            [n.Start, n.Finish, n.ActualStart, n.ActualFinish,
            n.predictedStart, n.predictedEnd, n.riskAdjustedStart, n.riskAdjustedEnd]
                .forEach(d => {
                    const date = safeDate(d);
                    if (date) {
                        dateSet.add(formatDateLocal(date));
                        if (!minDate || date < minDate) minDate = new Date(date);
                        if (!maxDate || date > maxDate) maxDate = new Date(date);
                    }
                });
        });
        dateSet.add(formatDateLocal(statusDate));
        if (!minDate || statusDate < minDate) minDate = new Date(statusDate);
        if (!maxDate || statusDate > maxDate) maxDate = new Date(statusDate);

        // Add weekly intermediate dates for smoother S-curves
        if (minDate && maxDate) {
            const INTERVAL_DAYS = 7; // Weekly intervals
            const current = new Date(minDate);
            while (current <= maxDate) {
                dateSet.add(formatDateLocal(current));
                current.setDate(current.getDate() + INTERVAL_DAYS);
            }
        }

        const comparisonDates = Array.from(dateSet).sort();

        // Build distributions
        const distributions = {
            actual: [], earned: [], predicted: [],
            actualCost: [], earnedCost: [], predictedCost: [],
            nonCumActual: [], nonCumEarned: [], nonCumPredicted: [],
            nonCumActualCost: [], nonCumEarnedCost: [], nonCumPredictedCost: []
        };

        let cumActualHours = 0, cumActualCost = 0;
        let baseActualHours = 0, baseActualCost = 0;
        let cumPredictedFromStatus = 0, cumPredictedCostFromStatus = 0;
        let lastActualIndex = -1;

        for (let i = 0; i < comparisonDates.length; i++) {
            const dateStr = comparisonDates[i];
            const day = safeDate(dateStr);
            if (!day) continue;

            let dailyActual = 0, dailyPredicted = 0;
            let cumEarnedHours = 0;

            workingNodes.forEach(node => {
                if (node.Duration === 0 || node.Duration === "0") return;

                const plannedHours = convertToHours(
                    Number(node.Duration) || 0,
                    node.TimeUnits || "Hours"
                );
                if (plannedHours === 0) return;

                const pct = normalizePercentComplete(node.PercentComplete);

                // Calculate EV - FIXED: Handle all cases including activities with progress but no actual dates
                // Get actual dates, or impute them if missing but activity has progress
                let evActualStart = safeDate(node.ActualStart);
                let evActualFinish = safeDate(node.ActualFinish);

                // CRITICAL FIX: Impute dates for activities with progress but missing actual dates
                // This mirrors the logic used for AC calculation (lines 1776-1782)
                if (pct > 0 && (!evActualStart || !evActualFinish)) {
                    if (!evActualStart) {
                        evActualStart = safeDate(node.riskAdjustedStart || node.Start);
                    }
                    if (!evActualFinish && pct === 1) {
                        // 100% complete - impute finish date
                        evActualFinish = safeDate(node.riskAdjustedEnd || node.Finish);
                        // Cap at status date if imputed finish is in future
                        if (evActualFinish && evActualFinish > statusDate) {
                            evActualFinish = new Date(statusDate);
                        }
                    }
                }

                // CASE 1: Activity has a finish date (actual or imputed)
                if (evActualFinish) {
                    if (evActualFinish <= day) {
                        // Activity completed by this date - credit full EV (or pct if not 100%)
                        cumEarnedHours += plannedHours * (pct > 0 ? pct : 1);
                    } else if (evActualStart && evActualStart <= day) {
                        // Activity in progress - time-phase EV over duration
                        const totalDays = Math.max(1, differenceInCalendarDays(evActualFinish, evActualStart));
                        const elapsedDays = Math.max(0, differenceInCalendarDays(day, evActualStart));
                        const timeProgress = Math.min(1, elapsedDays / totalDays);
                        // Use lesser of time-based progress and actual pct (if available)
                        const effectiveProgress = pct > 0 ? Math.min(timeProgress, pct) : timeProgress;
                        cumEarnedHours += plannedHours * effectiveProgress;
                    }
                }
                // CASE 2: Has start date and progress, but no finish date
                else if (evActualStart && pct > 0 && evActualStart <= day) {
                    cumEarnedHours += plannedHours * pct;
                }
                // CASE 3: Has progress but no dates at all - use planned dates for time-phasing
                else if (pct > 0 && day <= statusDate) {
                    const plannedStart = safeDate(node.riskAdjustedStart || node.Start);
                    const plannedFinish = safeDate(node.riskAdjustedEnd || node.Finish);

                    if (plannedFinish && plannedFinish <= day) {
                        // Should be complete per plan - credit actual progress
                        cumEarnedHours += plannedHours * pct;
                    } else if (plannedStart && plannedStart <= day) {
                        // In progress per plan - time-phase the actual progress
                        if (plannedFinish) {
                            const totalDays = Math.max(1, differenceInCalendarDays(plannedFinish, plannedStart));
                            const elapsedDays = Math.max(0, differenceInCalendarDays(day, plannedStart));
                            const timeProgress = Math.min(1, elapsedDays / totalDays);
                            // Credit lesser of time progress and actual pct
                            cumEarnedHours += plannedHours * Math.min(timeProgress, pct);
                        } else {
                            cumEarnedHours += plannedHours * pct;
                        }
                    }
                }
                // CASE 4: Future dates - use predicted values
                else if (day > statusDate) {
                    const predEnd = safeDate(node.predictedEnd);
                    const predStart = safeDate(node.predictedStart || node.Start);

                    if (predEnd && predEnd <= day) {
                        cumEarnedHours += plannedHours;
                    } else if (predStart && predStart <= day && predEnd && day < predEnd) {
                        const totalDays = Math.max(1, differenceInCalendarDays(predEnd, predStart));
                        const elapsedDays = Math.max(0, differenceInCalendarDays(day, predStart));
                        const predictedProgress = Math.min(1, elapsedDays / totalDays);
                        cumEarnedHours += plannedHours * predictedProgress;
                    }
                }

                // Calculate daily actuals
                let actualStart = safeDate(node.ActualStart);
                let actualFinish = safeDate(node.ActualFinish);

                if (pct === 1 && (!actualStart || !actualFinish)) {
                    actualStart = safeDate(node.riskAdjustedStart || node.Start);
                    actualFinish = safeDate(node.riskAdjustedEnd || node.Finish);
                    if (actualFinish && actualFinish > statusDate) {
                        actualFinish = new Date(statusDate);
                    }
                }

                if (actualStart) {
                    const effectiveEnd = actualFinish || statusDate;
                    let actualHours = null;

                    if (node.ActualDuration != null) {
                        actualHours = convertToHours(
                            Number(node.ActualDuration) || 0,
                            node.TimeUnits || "Hours"
                        );
                    } else if (pct > 0) {
                        actualHours = plannedHours * pct;
                    }

                    if (actualHours && actualStart <= day && day <= effectiveEnd) {
                        const spanDays = Math.max(1, differenceInCalendarDays(effectiveEnd, actualStart));
                        dailyActual += actualHours / spanDays;
                    }
                }

                // Predicted future work
                const predStart = safeDate(node.predictedStart);
                const predEnd = safeDate(node.predictedEnd);

                if (predStart && predEnd && predStart <= day && day <= predEnd && day > statusDate) {
                    const predHours = node.predictedDuration != null ?
                        convertToHours(Number(node.predictedDuration) || 0, node.TimeUnits || "Hours") :
                        plannedHours;
                    const predDays = Math.max(1, differenceInCalendarDays(predEnd, predStart));
                    dailyPredicted += predHours / predDays;
                }
            });

            const cumEarnedCost = cumEarnedHours * CostRate;

            cumActualHours += dailyActual;
            cumActualCost += dailyActual * CostRate;

            if (formatDateLocal(day) === formatDateLocal(statusDate)) {
                baseActualHours = cumActualHours;
                baseActualCost = cumActualCost;
            }

            if (day > statusDate) {
                cumPredictedFromStatus += dailyPredicted;
                cumPredictedCostFromStatus += dailyPredicted * CostRate;
            }

            const predictedHours = (day <= statusDate) ?
                cumActualHours :
                (baseActualHours + cumPredictedFromStatus);
            const predictedCost = (day <= statusDate) ?
                cumActualCost :
                (baseActualCost + cumPredictedCostFromStatus);

            const prevEarnedHours = i > 0 ? distributions.earned[i - 1]?.hours || 0 : 0;
            const dailyEarnedHours = cumEarnedHours - prevEarnedHours;
            const dailyEarnedCost = dailyEarnedHours * CostRate;

            distributions.actual.push({ date: dateStr, hours: cumActualHours });
            distributions.earned.push({ date: dateStr, hours: cumEarnedHours });
            distributions.predicted.push({ date: dateStr, hours: predictedHours });

            distributions.actualCost.push({ date: dateStr, cost: cumActualCost });
            distributions.earnedCost.push({ date: dateStr, cost: cumEarnedCost });
            distributions.predictedCost.push({ date: dateStr, cost: predictedCost });

            distributions.nonCumActual.push({ date: dateStr, hours: dailyActual });
            distributions.nonCumEarned.push({ date: dateStr, hours: dailyEarnedHours });
            distributions.nonCumPredicted.push({ date: dateStr, hours: (day > statusDate ? dailyPredicted : 0) });

            distributions.nonCumActualCost.push({ date: dateStr, cost: dailyActual * CostRate });
            distributions.nonCumEarnedCost.push({ date: dateStr, cost: dailyEarnedCost });
            distributions.nonCumPredictedCost.push({ date: dateStr, cost: (day > statusDate ? dailyPredicted * CostRate : 0) });

            if (dailyActual > 0) lastActualIndex = i;
        }

        // Validation
        const finalEV = distributions.earned[distributions.earned.length - 1]?.hours || 0;
        const evDelta = Math.abs(finalEV - BAC_h);
        const evMatch = evDelta < 1;

        console.log(`[EV Validation] Final EV: ${finalEV.toFixed(2)}, BAC: ${BAC_h.toFixed(2)}, Delta: ${evDelta.toFixed(2)}, Match: ${evMatch}`);

        if (!evMatch && evDelta > BAC_h * 0.05) {
            console.warn(`EV validation failed: ${((evDelta / BAC_h) * 100).toFixed(1)}% difference from BAC`);
        }

        const statusDateStr = formatDateLocal(statusDate);
        const statusIdx = comparisonDates.indexOf(statusDateStr);
        const transitionIdx = lastActualIndex >= 0 ? lastActualIndex :
            (statusIdx >= 0 ? statusIdx : distributions.actual.length - 1);

        evmMetrics.actual = {
            BCWP, ACWP, BCWS, SPI, CV, SV, CPIcum, EAC, BAC,
            timeUnits: workingNodes[0]?.TimeUnits || "Hours",
            currency,
            // FIX #18: Include duration-weighted progress for createBarChart
            durationWeightedProgress,
            scheduleMultiplier,
            slipDays,
            performanceDelta,
            // FIX #19: Include frontier nodes for advanced analysis
            frontierNodes: frontierNodes.map(n => n.ID),
            distributionActual: distributions.actual,
            distributionEarned: distributions.earned,
            distributionPredicted: distributions.predicted,
            distributionActualCost: distributions.actualCost,
            distributionEarnedCost: distributions.earnedCost,
            distributionPredictedCost: distributions.predictedCost,
            nonCumulativeDistributionActual: distributions.nonCumActual,
            nonCumulativeDistributionEarned: distributions.nonCumEarned,
            nonCumulativeDistributionPredicted: distributions.nonCumPredicted,
            nonCumulativeDistributionActualCost: distributions.nonCumActualCost,
            nonCumulativeDistributionEarnedCost: distributions.nonCumEarnedCost,
            nonCumulativeDistributionPredictedCost: distributions.nonCumPredictedCost,
            allDates: comparisonDates,
            transitionPointIndex: transitionIdx
        };

        // FIX #18: Export evmMetrics to window for downstream consumers
        window.cybereumState = window.cybereumState || {};
        window.cybereumState.evmMetrics = evmMetrics;
        window.evmMetrics = evmMetrics;

        actualMetrics = evmMetrics.actual;

        displayActualEVMetrics(BCWP, ACWP, BCWS, SPI, SV, CV, CPIcum, EAC);

        populateActualEVMTable(
            evmMetrics.distributionPlanned || [],
            distributions.actual,
            distributions.earned,
            distributions.predicted,
            evmMetrics.distributionPlannedCost || [],
            distributions.actualCost,
            distributions.earnedCost,
            distributions.predictedCost,
            comparisonDates,
            transitionIdx,
            currency
        );

        createActualSingleEVMChart(evmMetrics, 'actual', 'Cumulative');
    }, 'createActualEVMChart');

    processActualChart();
}

/********************
 * BACKEND-FIRST EVM WRAPPERS (Pyth-Sched-Analytics /evm/analyze)
 *
 * Transparent offload of metric + distribution computation to the
 * backend service.  Both entry points (getCumulativeDistribution,
 * createActualEVMChart) have async siblings (...Async) that:
 *   1. Short-circuit to the sync JS path when disabled / unavailable.
 *   2. Otherwise POST to /evm/analyze and populate window.evmMetrics
 *      with BOTH branches (forecasted + actual) in a single round trip.
 *   3. Fall through to the original sync implementation on ANY error
 *      (network, non-200, timeout, parse failure).
 *
 * Shape parity: the response maps directly onto the existing
 * window.evmMetrics contract (camelCase keys, same nested layout,
 * same top-level distributionPlanned / allDates / currency).  This
 * means Completionprediction.js:4871 (which reads
 * window.evmMetrics.actual.CPIcum) works unchanged.
 *
 * Fetch dedup: both async wrappers share a single in-flight Promise
 * keyed on a cheap fingerprint.  When the user clicks between the
 * "Forecasted" and "Actual" tabs in rapid succession, only one HTTP
 * request goes out; the second wrapper awaits the same promise.
 ********************/

// Module-scoped dedup cache: { fingerprint: string, promise: Promise }
let _evmInFlight = null;

function _evmFingerprint(nodes, links) {
    // Cheap fingerprint that changes when the project data changes but
    // not when the user just switches tabs.  Includes a monotonic
    // version flag that callers can bump to force-refresh.
    const statusDate = (window.cybereumState && window.cybereumState.dataDate)
        ? String(window.cybereumState.dataDate) : 'now';
    const sector = (window.cybereumState && window.cybereumState.project
                    && window.cybereumState.project.sector) || '';
    return JSON.stringify({
        n: (nodes || []).length,
        l: (links || []).length,
        sd: statusDate,
        sc: sector,
        v: window.evmInvalidationKey || 0,
    });
}

function _evmBuildRequestBody(nodes, links) {
    const teamCal = (window.cybereumState && window.cybereumState.teamCalendar) || null;
    const hpd = (teamCal && teamCal.hoursPerDay) || evmConfig.WORKING_HOURS_PER_DAY
        || CONFIG?.WORKING_HOURS_PER_DAY || 8;
    const dpw = (teamCal && Array.isArray(teamCal.workingDays) && teamCal.workingDays.length)
        || evmConfig.WORKING_DAYS_PER_WEEK || CONFIG?.WORKING_DAYS_PER_WEEK || 5;
    const startNode = (nodes || []).find(n => String(n.ID) === '0') || (nodes || [])[0] || {};
    const statusDate = (window.cybereumState && window.cybereumState.dataDate)
        ? new Date(window.cybereumState.dataDate).toISOString()
        : new Date().toISOString();

    return {
        nodes: nodes || [],
        links: links || [],
        options: {
            statusDate,
            costRate: parseFloat(startNode.CostRate) || 1,
            currency: startNode.Currency || 'USD',
            project: (window.cybereumState && window.cybereumState.project) || null,
            hoursPerDay: hpd,
            workingDaysPerWeek: typeof dpw === 'number' ? dpw : 5,
        },
    };
}

async function _ensureEvmAnalysis(nodes, links) {
    // De-duplicate concurrent calls; single round-trip populates both branches.
    const fp = _evmFingerprint(nodes, links);
    if (_evmInFlight && _evmInFlight.fingerprint === fp) {
        return _evmInFlight.promise;
    }

    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = controller ? setTimeout(
        () => controller.abort(),
        +evmBackendConfig.evmRequestTimeoutMs || 15000) : null;

    const promise = (async () => {
        try {
            const body = _evmBuildRequestBody(nodes, links);
            const resp = await fetch(evmBackendConfig.evmEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller ? controller.signal : undefined,
            });
            if (timer) clearTimeout(timer);
            if (!resp.ok) {
                throw new Error('backend returned ' + resp.status);
            }
            return await resp.json();
        } finally {
            if (timer) clearTimeout(timer);
        }
    })();

    _evmInFlight = { fingerprint: fp, promise };
    // Clear cache after settle so subsequent unrelated calls re-fetch
    promise.finally(() => {
        if (_evmInFlight && _evmInFlight.fingerprint === fp) _evmInFlight = null;
    });
    return promise;
}

function _applyBackendEvmToWindow(result) {
    // Merge backend result into the SAME shape window.evmMetrics has
    // always had, so every downstream consumer (charts, tables,
    // Completionprediction.js .actual.CPIcum read, etc.) keeps working.
    const evmMetrics = window.evmMetrics || {};
    evmMetrics.forecasted = result.forecasted || evmMetrics.forecasted;
    evmMetrics.actual = result.actual || evmMetrics.actual;
    // Top-level (legacy) fields that downstream code also reads
    if (result.forecasted) {
        evmMetrics.distributionPlanned = result.forecasted.distributionPlanned || [];
        evmMetrics.distributionPlannedCost = result.forecasted.distributionPlannedCost || [];
        evmMetrics.allDates = result.forecasted.allDates || [];
    }
    evmMetrics.currency = result.currency || evmMetrics.currency || 'USD';
    evmMetrics.source = 'backend';
    evmMetrics.computation_ms = result.computation_ms;

    window.cybereumState = window.cybereumState || {};
    window.cybereumState.evmMetrics = evmMetrics;
    window.evmMetrics = evmMetrics;
    return evmMetrics;
}

async function getCumulativeDistributionAsync(nodes, links) {
    const disabled = !evmBackendConfig.useBackendEVM
        || typeof fetch !== 'function'
        || !evmBackendConfig.evmEndpoint;
    if (disabled) {
        return getCumulativeDistribution(nodes, links);
    }
    try {
        const result = await _ensureEvmAnalysis(nodes, links);
        _applyBackendEvmToWindow(result);

        const f = result.forecasted;
        if (f && typeof displayForecastedEVMetrics === 'function') {
            try {
                displayForecastedEVMetrics(
                    f.BCWP, f.ACWP, f.BCWS, f.SPI_model, f.SV, f.CV,
                    f.CPIcum_model, f.EAC);
            } catch (e) { console.warn('[EVM] displayForecastedEVMetrics:', e); }
        }
        if (f && typeof populateForecastedEVMTable === 'function') {
            try {
                populateForecastedEVMTable(
                    f.distributionPlanned, f.distributionWithOverrun,
                    f.evDistribution, f.allDates);
            } catch (e) { console.warn('[EVM] populateForecastedEVMTable:', e); }
        }
        console.log('[EVM] Backend forecasted branch applied:', {
            SPI: f?.SPI_model, CPI: f?.CPIcum_model, EAC: f?.EAC,
            computation_ms: result.computation_ms,
            cache_hit: result.cache_hit,
        });
    } catch (err) {
        console.warn('[EVM] Backend failed (',
                     err?.name || 'error', err?.message || err,
                     ') -- falling back to JS getCumulativeDistribution');
        return getCumulativeDistribution(nodes, links);
    }
}

async function createActualEVMChartAsync(nodes, links) {
    const disabled = !evmBackendConfig.useBackendEVM
        || typeof fetch !== 'function'
        || !evmBackendConfig.evmEndpoint;
    if (disabled) {
        return createActualEVMChart(nodes, links);
    }
    try {
        const result = await _ensureEvmAnalysis(nodes, links);
        _applyBackendEvmToWindow(result);

        const a = result.actual;
        if (a && typeof displayActualEVMetrics === 'function') {
            try {
                displayActualEVMetrics(
                    a.BCWP, a.ACWP, a.BCWS, a.SPI_model, a.SV, a.CV,
                    a.CPIcum_model, a.EAC);
            } catch (e) { console.warn('[EVM] displayActualEVMetrics:', e); }
        }
        if (a && typeof populateActualEVMTable === 'function') {
            try {
                populateActualEVMTable(
                    (window.evmMetrics && window.evmMetrics.distributionPlanned) || [],
                    a.distributionActual, a.distributionEarned,
                    a.distributionPredicted,
                    (window.evmMetrics && window.evmMetrics.distributionPlannedCost) || [],
                    a.distributionActualCost, a.distributionEarnedCost,
                    a.distributionPredictedCost,
                    a.allDates, a.transitionPointIndex,
                    result.currency);
            } catch (e) { console.warn('[EVM] populateActualEVMTable:', e); }
        }
        console.log('[EVM] Backend actual branch applied:', {
            SPI: a?.SPI_model, CPI: a?.CPIcum_model, EAC: a?.EAC,
            dwSPI: a?.durationWeightedProgress?.durationWeightedSPI,
            slipDays: a?.slipDays,
            frontierCount: (a?.frontierNodes || []).length,
            computation_ms: result.computation_ms,
            cache_hit: result.cache_hit,
        });
    } catch (err) {
        console.warn('[EVM] Backend failed (',
                     err?.name || 'error', err?.message || err,
                     ') -- falling back to JS createActualEVMChart');
        return createActualEVMChart(nodes, links);
    }
}

// Expose async wrappers on window so the main app's tab-click handlers
// can switch over gradually (preserve the sync globals for existing code).
if (typeof window !== 'undefined') {
    window.getCumulativeDistributionAsync = getCumulativeDistributionAsync;
    window.createActualEVMChartAsync = createActualEVMChartAsync;
}

/********************
 * PREDICTION LOGIC - IMPROVED
 * FIX #8, #10, #11: Properly compare actual vs forecasted performance
 * FIX #18: Duration-weighted progress comparison
 * FIX #19: Chain-based prediction from last active activities
 ********************/

/**
 * FIX #18: Calculate duration-weighted progress for apples-to-apples comparison.
 * Compares what SHOULD be complete by data date vs what IS actually complete.
 * 
 * @param {Array} nodes - Project activities
 * @param {Date} statusDate - Data date
 * @returns {Object} { plannedProgressPct, actualProgressPct, durationWeightedSPI, totalPlannedHours, plannedCompletedHours, actualCompletedHours }
 */
function calculateDurationWeightedProgress(nodes, statusDate) {
    const sd = safeDate(statusDate) || new Date();
    const sdTime = sd.getTime();

    let totalPlannedHours = 0;
    let plannedCompletedHours = 0;  // What SHOULD be complete by data date
    let actualCompletedHours = 0;    // What IS actually complete

    for (const node of nodes) {
        // Skip milestones
        if (node.Duration === 0 || node.Duration === "0") continue;

        const plannedHours = convertToHours(Number(node.Duration) || 0, node.TimeUnits || "Hours");
        if (plannedHours === 0) continue;

        const plannedStart = safeDate(node.Start);
        const plannedFinish = safeDate(node.Finish);
        const actualFinish = safeDate(node.ActualFinish);
        let pct = normalizePercentComplete(node.PercentComplete);

        // If ActualFinish exists and is before/on data date, treat as 100% complete
        // (handles cases where PercentComplete might not be set correctly)
        if (actualFinish && actualFinish <= sd) {
            pct = 1;
        }

        // Sum total planned work
        totalPlannedHours += plannedHours;

        // Calculate actual completed work
        actualCompletedHours += plannedHours * pct;

        // Calculate what SHOULD be complete by data date
        if (!plannedStart || !plannedFinish) {
            // Can't determine planned progress without dates
            continue;
        }

        const startTime = plannedStart.getTime();
        const finishTime = plannedFinish.getTime();

        if (sdTime >= finishTime) {
            // Activity should be 100% complete by data date
            plannedCompletedHours += plannedHours;
        } else if (sdTime > startTime) {
            // Activity is in progress - calculate linear progress
            const totalDuration = finishTime - startTime;
            const elapsed = sdTime - startTime;
            const plannedProgress = Math.min(1, elapsed / totalDuration);
            plannedCompletedHours += plannedHours * plannedProgress;
        }
        // else: sdTime <= startTime, activity shouldn't have started yet
    }

    // Calculate percentages
    const plannedProgressPct = totalPlannedHours > 0 ?
        (plannedCompletedHours / totalPlannedHours) * 100 : 0;
    const actualProgressPct = totalPlannedHours > 0 ?
        (actualCompletedHours / totalPlannedHours) * 100 : 0;

    // Duration-weighted SPI: what IS done / what SHOULD be done
    let durationWeightedSPI;
    if (plannedCompletedHours > 0) {
        durationWeightedSPI = actualCompletedHours / plannedCompletedHours;
    } else if (actualCompletedHours > 0) {
        // Work done ahead of schedule (nothing should be complete yet but work is done)
        durationWeightedSPI = 2.0;  // Cap at 2x (ahead of schedule)
    } else {
        // Nothing should be complete and nothing is complete
        durationWeightedSPI = 1.0;  // On track
    }

    console.log(`[DW-Progress] Planned Progress: ${plannedProgressPct.toFixed(1)}%, ` +
        `Actual Progress: ${actualProgressPct.toFixed(1)}%, ` +
        `DW-SPI: ${durationWeightedSPI.toFixed(3)}` +
        (plannedCompletedHours === 0 && actualCompletedHours > 0 ? ' (ahead of baseline)' : ''));

    return {
        plannedProgressPct,
        actualProgressPct,
        durationWeightedSPI: durationWeightedSPI,
        durationWeightedSPI_model: clampNum(durationWeightedSPI, evmConfig.bounds.minSPI, evmConfig.bounds.maxSPI),
        totalPlannedHours,
        plannedCompletedHours,
        actualCompletedHours
    };
}

/**
 * FIX #19: Find last activities with actual progress (frontier nodes).
 * These are activities that have started but whose successors haven't started yet.
 * 
 * @param {Array} nodes - Project activities
 * @param {Map} succMap - Successor map (from PathScripts or created here)
 * @param {Map} nodeMap - Node lookup map for O(1) access
 * @returns {Array} Array of frontier node objects (not just IDs)
 */
function findLastActiveActivities(nodes, succMap, nodeMap) {
    const frontierNodes = [];

    // Create nodeMap if not provided
    const lookupMap = nodeMap || createNodeMap(nodes);

    for (const node of nodes) {
        // Skip milestones
        if (node.Duration === 0 || node.Duration === "0") continue;

        // Check if this node has actual progress
        const pct = normalizePercentComplete(node.PercentComplete);
        const hasActualStart = !!node.ActualStart;
        const hasProgress = hasActualStart || pct > 0;

        if (!hasProgress) continue;

        // Check if any successor has progress - use O(1) lookup
        const successors = succMap?.get(String(node.ID)) || [];
        let hasSuccessorWithProgress = false;

        for (const succLink of successors) {
            const succId = String(succLink.target || succLink);
            // FIX: Use O(1) Map lookup instead of O(n) find
            const succNode = lookupMap.get(succId);
            if (succNode) {
                const succPct = normalizePercentComplete(succNode.PercentComplete);
                const succHasStart = !!succNode.ActualStart;
                if (succPct > 0 || succHasStart) {
                    hasSuccessorWithProgress = true;
                    break;
                }
            }
        }

        // If this node has progress but no successor has progress, it's a frontier node
        if (!hasSuccessorWithProgress) {
            frontierNodes.push(node);  // Push full node object, not just ID
        }
    }

    if (frontierNodes.length > 0) {
        console.log(`[Frontier] Found ${frontierNodes.length} last active activities: [${frontierNodes.map(n => n.ID).join(', ')}]`);
    }
    return frontierNodes;
}

/**
 * Compute schedule delay parameters that compare ACTUAL performance against FORECASTED (sector-based) delays.
 * 
 * @param {Date} statusDate - Current status date
 * @param {Date} plannedEndDate - Original planned end date
 * @param {Date} forecastedEndDate - Risk-adjusted/sector-based forecasted end date
 * @param {number} SPI - Schedule Performance Index from actual performance (fallback)
 * @param {number} sectorScheduleOverrun - Expected schedule overrun from sector data (e.g., 0.37 = 37%)
 * @param {Array} nodes - Optional: Project nodes for duration-weighted calculation
 * @returns {Object} { scheduleMultiplier, slipDays, performanceDelta }
 */
function computeScheduleDelayImproved(statusDate, plannedEndDate, forecastedEndDate, SPI, sectorScheduleOverrun = 0, nodes = null) {
    const sd = safeDate(statusDate) || new Date();
    const planned = safeDate(plannedEndDate) || new Date();
    const forecasted = safeDate(forecastedEndDate) || planned;

    const remainingPlannedDays = Math.max(0, Math.ceil(differenceInCalendarDays(planned, sd)));

    // Forecasted delay factor from sector data
    const forecastedDelayFactor = 1 + sectorScheduleOverrun;

    // FIX #18: Use duration-weighted SPI if nodes provided, otherwise fall back to cost-based SPI
    let actualDelayFactor;
    let dwProgress = null;

    if (nodes && Array.isArray(nodes) && nodes.length > 0) {
        // Calculate duration-weighted progress comparison
        dwProgress = calculateDurationWeightedProgress(nodes, sd);
        const dwSPI = dwProgress.durationWeightedSPI;
        actualDelayFactor = dwSPI > 0 ? clampNum(1 / dwSPI, 0.5, 3.0) : forecastedDelayFactor;

        console.log(`[Prediction] Using Duration-Weighted SPI: ${dwSPI.toFixed(3)} ` +
            `(Planned: ${dwProgress.plannedProgressPct.toFixed(1)}%, Actual: ${dwProgress.actualProgressPct.toFixed(1)}%)`);
    } else {
        // Fallback to cost-based SPI
        const safeSPI = isFinite(SPI) ? SPI : 1;
        actualDelayFactor = safeSPI > 0 ? clampNum(1 / safeSPI, 0.5, 3.0) : forecastedDelayFactor;
        console.log(`[Prediction] Using Cost-Based SPI: ${safeSPI.toFixed(3)} (no nodes provided)`);
    }

    // FIX #16: Properly clamp performanceDelta with configured bounds
    const rawPerformanceDelta = forecastedDelayFactor > 0 ?
        actualDelayFactor / forecastedDelayFactor :
        actualDelayFactor;

    const performanceDelta = clampNum(
        rawPerformanceDelta,
        evmConfig.bounds.minPerformanceDelta,
        evmConfig.bounds.maxPerformanceDelta
    );

    const scheduleMultiplier = clampNum(performanceDelta, 0.6, 2.0);

    const forecastedRemainingDays = Math.max(0, Math.ceil(differenceInCalendarDays(forecasted, sd)));
    const predictedRemainingDays = forecastedRemainingDays * scheduleMultiplier;
    const slipDays = clampNum(
        Math.round(predictedRemainingDays - forecastedRemainingDays),
        -180,
        365
    );

    // Enhanced logging
    const perfStatus = performanceDelta < 0.95 ? 'BETTER' : performanceDelta > 1.05 ? 'WORSE' : 'MATCHING';
    console.log(`[Prediction] Sector Overrun: ${(sectorScheduleOverrun * 100).toFixed(1)}%, ` +
        `Forecasted Delay Factor: ${forecastedDelayFactor.toFixed(2)}, ` +
        `Actual Delay Factor: ${actualDelayFactor.toFixed(2)}, ` +
        `Performance Delta: ${performanceDelta.toFixed(2)} (${perfStatus} than forecast), ` +
        `Slip Days: ${slipDays} (${slipDays < 0 ? 'EARLIER' : slipDays > 0 ? 'LATER' : 'ON TIME'} than forecasted)`);

    return {
        scheduleMultiplier,
        slipDays,
        performanceDelta,
        actualDelayFactor,
        forecastedDelayFactor,
        durationWeightedProgress: dwProgress
    };
}

/**
 * Original function kept for backward compatibility
 */
function computeScheduleDelay(statusDate, plannedEndDate, SPI) {
    const scheduleMultiplier = clampNum(
        SPI > 0 ? 1 / SPI : 1,
        0.8,
        2.0
    );

    const remainingDays = Math.max(0, Math.ceil(
        differenceInCalendarDays(new Date(plannedEndDate), new Date(statusDate))
    ));

    const slipDays = clampNum(
        Math.round(remainingDays * (scheduleMultiplier - 1)),
        -90,
        365
    );

    return { scheduleMultiplier, slipDays };
}

/**
 * IMPROVED prediction function with O(1) dependency lookups
 * FIX #12: Accept nodeMap parameter for efficient lookups
 */
function updatePredictedValues_Improved(nodes, statusDate, scheduleMultiplier, slipDays, performanceDelta, links, nodeMap, precomputedFrontier) {
    const hoursPerDay = _evmHoursPerDay(); // FIX: was hardcoded 8
    const daysPerWeek = _evmDaysPerWeek(); // FIX: was hardcoded 5
    const sd = safeDate(statusDate) || window.cybereumState?.dataDate || new Date();

    // Get pre-computed data structures from PathScripts
    const succMap = window.cybereumState?.succMap || window.cybereumState?.cpm?.succMap; // FIX: cpm fallback
    const predMap = window.cybereumState?.predMap || window.cybereumState?.cpm?.predMap; // FIX: cpm fallback

    // Ensure nodeMap exists
    const lookupMap = nodeMap || createNodeMap(nodes);

    // Ensure performanceDelta is bounded
    const safePerformanceDelta = clampNum(
        performanceDelta || 1,
        evmConfig.bounds.minPerformanceDelta,
        evmConfig.bounds.maxPerformanceDelta
    );

    // STEP 1: Use pre-computed frontier nodes if available, otherwise compute
    const frontierNodes = precomputedFrontier && precomputedFrontier.length > 0
        ? precomputedFrontier
        : (succMap ? findLastActiveActivities(nodes, succMap, lookupMap) : []);

    // STEP 2: Initial prediction assignment (same as before)
    for (const n of nodes) {
        const baseStart = safeDate(n.riskAdjustedStart || n.Start);
        const baseEnd = safeDate(n.riskAdjustedEnd || n.Finish);
        const plannedH = convertToHours(Number(n.Duration) || 0, n.TimeUnits || "Hours");
        const riskH = convertToHours(
            Number(n.riskAdjustedDuration ?? n.Duration) || 0,
            n.TimeUnits || "Hours"
        );
        const plannedStart = safeDate(n.Start);
        const plannedEnd = safeDate(n.Finish);

        // Initialize from forecasted dates
        n.predictedDuration = riskH || plannedH || 0;
        n.predictedStart = baseStart || plannedStart || sd;
        n.predictedEnd = addDurationToDate(n.predictedStart, n.predictedDuration, hoursPerDay, daysPerWeek, "Hours");

        const pct = normalizePercentComplete(n.PercentComplete);

        // CASE 1: COMPLETED
        const hasActualSpan = !!(n.ActualStart && n.ActualFinish && n.ActualDuration != null);
        if (hasActualSpan) {
            n.predictedStart = safeDate(n.ActualStart) || n.predictedStart;
            n.predictedEnd = safeDate(n.ActualFinish) || n.predictedEnd;

            let actualHours = convertToHours(Number(n.ActualDuration) || 0, n.TimeUnits || "Hours");
            const plannedHours = convertToHours(Number(n.Duration) || 0, n.TimeUnits || "Hours");

            // VALIDATION: Account for multi-resource ActualDuration (P6 exports crew-hours)
            const resources = Math.max(1, Number(n.resourcesRequired) || 1);
            const effectiveRatio = plannedHours > 0 ? actualHours / (plannedHours * resources) : 0;
            if (effectiveRatio > 5) {
                _evmDataQualityWarnings.push(
                    `Task ${n.ID} "${n.Name}": ${effectiveRatio.toFixed(1)}× (${actualHours.toFixed(0)}h / ${plannedHours.toFixed(0)}h × ${resources} res)`
                );
            }

            n.predictedDuration = actualHours;
            continue;
        }

        // CASE 2: 100% complete but missing dates
        if (pct === 1 && (!n.ActualStart || !n.ActualFinish)) {
            const imputedStart = baseStart || plannedStart || sd;
            let imputedFinish = baseEnd || plannedEnd || sd;
            if (imputedFinish > sd) imputedFinish = sd;

            n.predictedStart = imputedStart;
            n.predictedEnd = imputedFinish;
            n.predictedDuration = riskH || plannedH || 0;
            continue;
        }

        // CASE 3: IN-PROGRESS
        if (n.ActualStart && pct > 0 && pct < 1) {
            const doneH = plannedH * pct;
            const remH = Math.max(0, plannedH - doneH) * safePerformanceDelta;
            n.predictedDuration = doneH + remH;
            n.predictedStart = safeDate(n.ActualStart) || n.predictedStart;
            n.predictedEnd = addDurationToDate(n.predictedStart, n.predictedDuration, hoursPerDay, daysPerWeek, "Hours");
            continue;
        }

        // CASE 4: NOT STARTED - will be adjusted by decay and propagation
        let shiftedStart = new Date(Math.max(+baseStart, +sd));
        if (slipDays !== 0) {
            shiftedStart.setDate(shiftedStart.getDate() + slipDays);
        }

        n.predictedDuration = plannedH * safePerformanceDelta;
        n.predictedStart = shiftedStart;
        n.predictedEnd = addDurationToDate(shiftedStart, n.predictedDuration, hoursPerDay, daysPerWeek, "Hours");
    }

    // STEP 3: Apply distance decay if we have frontier nodes
    if (frontierNodes.length > 0 && succMap) {
        applyDistanceDecay(nodes, frontierNodes, lookupMap, succMap, safePerformanceDelta, 0.85);
    }

    // STEP 4: Propagate in topological order
    if (Array.isArray(links) && links.length > 0) {
        propagatePredictionsTopologically(nodes, links, lookupMap);
    }

    // Flush batched data quality warnings as single summary
    if (_evmDataQualityWarnings.length > 0) {
        console.warn(`[EVM] ${_evmDataQualityWarnings.length} tasks with ActualDuration >5× resource-adjusted planned:\n  ` +
            _evmDataQualityWarnings.slice(0, 5).join('\n  ') +
            (_evmDataQualityWarnings.length > 5 ? `\n  ... and ${_evmDataQualityWarnings.length - 5} more` : ''));
        _evmDataQualityWarnings = [];
    }

    console.log(`[Prediction] Enhanced prediction complete: ${frontierNodes.length} frontier nodes, ` +
        `performanceDelta=${safePerformanceDelta.toFixed(3)}, slipDays=${slipDays}`);
}

/**
 * Original updatePredictedValues_Simple kept for backward compatibility
 */
function updatePredictedValues_Simple(nodes, statusDate, scheduleMultiplier, slipDays, links) {
    const hoursPerDay = _evmHoursPerDay(); // FIX: was hardcoded 8
    const daysPerWeek = _evmDaysPerWeek(); // FIX: was hardcoded 5
    const nodeMap = createNodeMap(nodes);

    for (const n of nodes) {
        const baseStart = safeDate(n.riskAdjustedStart || n.Start);
        const baseEnd = safeDate(n.riskAdjustedEnd || n.Finish);
        const plannedH = convertToHours(Number(n.Duration) || 0, n.TimeUnits || "Hours");
        const riskH = convertToHours(
            Number(n.riskAdjustedDuration ?? n.Duration) || 0,
            n.TimeUnits || "Hours"
        );

        n.predictedDuration = riskH || plannedH || 0;
        n.predictedStart = baseStart || safeDate(n.Start) || window.cybereumState?.dataDate || new Date();
        n.predictedEnd = addDurationToDate(
            n.predictedStart,
            n.predictedDuration,
            hoursPerDay,
            daysPerWeek,
            "Hours"
        );

        const pct = normalizePercentComplete(n.PercentComplete);

        const hasActualSpan = !!(n.ActualStart && n.ActualFinish && n.ActualDuration != null);
        if (hasActualSpan) {
            n.predictedStart = safeDate(n.ActualStart) || n.predictedStart;
            n.predictedEnd = safeDate(n.ActualFinish) || n.predictedEnd;
            n.predictedDuration = convertToHours(
                Number(n.ActualDuration) || 0,
                n.TimeUnits || "Hours"
            );
            continue;
        }

        if (pct === 1 && (!n.ActualStart || !n.ActualFinish)) {
            const imputedStart = baseStart || safeDate(n.Start) || window.cybereumState?.dataDate || new Date();
            let imputedFinish = baseEnd || safeDate(n.Finish) || window.cybereumState?.dataDate || new Date();
            const sd = safeDate(statusDate);
            if (sd && imputedFinish > sd) imputedFinish = sd;

            n.predictedStart = imputedStart;
            n.predictedEnd = imputedFinish;
            n.predictedDuration = riskH || plannedH || 0;
            continue;
        }

        if (n.ActualStart && pct > 0) {
            const doneH = plannedH * pct;
            const remH = Math.max(0, plannedH - doneH) * scheduleMultiplier;
            n.predictedDuration = doneH + remH;
            n.predictedStart = safeDate(n.ActualStart) || n.predictedStart;
            n.predictedEnd = addDurationToDate(
                n.predictedStart,
                n.predictedDuration,
                hoursPerDay,
                daysPerWeek,
                "Hours"
            );
            continue;
        }

        const sd = safeDate(statusDate) || window.cybereumState?.dataDate || new Date();
        const shiftedStart = new Date(Math.max(+baseStart, +sd));
        shiftedStart.setDate(shiftedStart.getDate() + slipDays);

        n.predictedDuration = plannedH * scheduleMultiplier;
        n.predictedStart = shiftedStart;
        n.predictedEnd = addDurationToDate(
            shiftedStart,
            n.predictedDuration,
            hoursPerDay,
            daysPerWeek,
            "Hours"
        );
    }

    // FIX #12: Use O(1) lookups
    if (Array.isArray(links)) {
        for (let iter = 0; iter < 3; iter++) {
            let adjusted = false;
            for (const l of links) {
                const pred = nodeMap.get(String(l.source));
                const succ = nodeMap.get(String(l.target));
                if (!pred || !succ) continue;

                const lagHours = getLinkLagHours(l);

                const reqStart = addDurationToDate(
                    pred.predictedEnd,
                    lagHours, _evmHoursPerDay(), _evmDaysPerWeek(),
                    "Hours"
                );

                if (!succ.ActualStart && reqStart > succ.predictedStart) {
                    succ.predictedStart = reqStart;
                    succ.predictedEnd = addDurationToDate(
                        reqStart,
                        succ.predictedDuration, _evmHoursPerDay(), _evmDaysPerWeek(),
                        "Hours"
                    );
                    adjusted = true;
                }
            }
            if (!adjusted) break;
        }
    }
}

/********************
 * CHART RENDERING
 ********************/

function createEVMCharts(metrics, scenario, chartType) {
    const chartConfigs = [
        {
            canvasId: chartType === 'Cumulative' ?
                (scenario === 'forecasted' ? 'cumulativeHoursChart' : 'actualCumulativeHoursChart') :
                `${scenario}NonCumulativeHoursChart`,
            dataKey: 'hours',
            yAxisLabel: `${chartType === 'Cumulative' ? 'Cumulative' : 'Daily'} Hours`,
            tooltipLabel: ' hours'
        },
        {
            canvasId: chartType === 'Cumulative' ?
                (scenario === 'forecasted' ? 'cumulativeHoursChartCost' : 'actualCumulativeHoursChartCost') :
                `${scenario}NonCumulativeHoursChartCost`,
            dataKey: 'cost',
            yAxisLabel: `${chartType === 'Cumulative' ? 'Cumulative' : 'Daily'} Cost (${metrics.currency})`,
            tooltipLabel: ''
        }
    ];

    const renderedCount = chartConfigs.reduce((count, config) => (
        createSingleEVMChart(metrics, scenario, chartType, config) ? count + 1 : count
    ), 0);

    if (renderedCount === 0) {
        console.warn(`[EVM] Skipped ${scenario} ${chartType} chart render: target canvas elements are not present on this page.`);
    }
}

function createSingleEVMChart(metrics, scenario, chartType, config) {
    const scenarioMetrics = scenario === 'forecasted' ? metrics.forecasted : metrics.actual;

    const canvas = document.getElementById(config.canvasId);
    if (!canvas) {
        return false;
    }

    const container = canvas.parentElement;
    const chartHeight = 600;
    const chartWidth = Math.max(800, container.getBoundingClientRect().width - 40);

    canvas.width = chartWidth;
    canvas.height = chartHeight;
    canvas.style.width = chartWidth + 'px';
    canvas.style.height = chartHeight + 'px';

    const ctx = canvas.getContext('2d');

    // Destroy existing chart
    if (config.canvasId === 'cumulativeHoursChart' && singleEVMChart) {
        singleEVMChart.destroy();
        singleEVMChart = null;
    } else if (config.canvasId === 'cumulativeHoursChartCost' && singleEVMCostChart) {
        singleEVMCostChart.destroy();
        singleEVMCostChart = null;
    } else if (config.canvasId === 'actualCumulativeHoursChart' && singleActualEVMChart) {
        singleActualEVMChart.destroy();
        singleActualEVMChart = null;
    } else if (config.canvasId === 'actualCumulativeHoursChartCost' && singleActualEVMCostChart) {
        singleActualEVMCostChart.destroy();
        singleActualEVMCostChart = null;
    }

    const dates = scenario === 'forecasted' ?
        metrics.allDates :
        (metrics.actual?.allDates || metrics.allDates);

    const transitionIdx = (scenario === 'actual' && metrics.actual) ?
        metrics.actual.transitionPointIndex : -1;

    const getData = (distributionKey) => {
        let distribution;

        if (distributionKey === 'distributionPlanned') {
            distribution = config.dataKey === 'cost' ?
                metrics.distributionPlannedCost :
                metrics.distributionPlanned;
        } else {
            const key = `${chartType === 'NonCumulative' ? 'nonCumulative' : ''}${distributionKey}${config.dataKey === 'cost' ? 'Cost' : ''}`;
            distribution = scenario === 'forecasted' ?
                metrics.forecasted[key] :
                metrics.actual[key];
        }

        if (!distribution || !Array.isArray(dates)) return [];

        const byDate = new Map(distribution.map(d => [d.date, d[config.dataKey]]));

        const isActualSeries = distributionKey.includes('Actual');
        const isPredSeries = distributionKey.includes('Predicted');

        return dates.map((date, idx) => {
            if (scenario === 'actual' && isActualSeries && transitionIdx >= 0 && idx > transitionIdx)
                return { x: new Date(date), y: null };

            if (scenario === 'actual' && isPredSeries && transitionIdx >= 0 && idx < transitionIdx)
                return { x: new Date(date), y: null };

            const v = byDate.get(date);
            return { x: new Date(date), y: (v == null ? null : v) };
        }).filter(pt => pt.y !== null);
    };

    const datasets = [
        {
            label: 'Planned Value (PV)',
            data: getData('distributionPlanned'),
            borderColor: 'rgba(255, 99, 132, 1)',
            backgroundColor: 'rgba(255, 99, 132, 0.2)',
            fill: false,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 5,
            borderWidth: 2
        },
        {
            label: scenario === 'actual' ? 'Actual Cost (AC)' : 'Forecasted Actual Cost (AC)',
            data: getData(scenario === 'actual' ? 'distributionActual' : 'distributionWithOverrun'),
            borderColor: 'rgba(54, 162, 235, 1)',
            backgroundColor: 'rgba(54, 162, 235, 0.2)',
            fill: false,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 5,
            borderWidth: 2
        },
        {
            label: scenario === 'actual' ? 'Earned Value (EV)' : 'Forecasted Earned Value (EV)',
            data: getData(scenario === 'actual' ? 'distributionEarned' : 'evDistribution'),
            borderColor: 'rgba(75, 192, 192, 1)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
            fill: false,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 5,
            borderWidth: 2
        }
    ];

    if (scenario === 'actual') {
        const predictedData = getData('distributionPredicted');
        if (predictedData.length > 0) {
            datasets.push({
                label: 'Predicted Value',
                data: predictedData,
                borderColor: 'rgba(153, 102, 255, 1)',
                backgroundColor: 'rgba(153, 102, 255, 0.2)',
                borderDash: [5, 5],
                fill: false,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 5,
                borderWidth: 2
            });
        }
    }

    const chartConfig = {
        type: 'line',
        data: { datasets },
        options: {
            responsive: false,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'month',
                        displayFormats: { month: 'MMM yyyy' }
                    },
                    title: {
                        display: true,
                        text: 'Date'
                    }
                },
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: config.yAxisLabel
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: function (context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                if (config.dataKey === 'cost') {
                                    label += formatCurrency(context.parsed.y, metrics.currency);
                                } else {
                                    label += formatValue(context.parsed.y, 0) + config.tooltipLabel;
                                }
                            }
                            return label;
                        }
                    }
                }
            }
        }
    };

    const chart = new Chart(ctx, chartConfig);

    if (config.canvasId === 'cumulativeHoursChart') singleEVMChart = chart;
    else if (config.canvasId === 'cumulativeHoursChartCost') singleEVMCostChart = chart;
    else if (config.canvasId === 'actualCumulativeHoursChart') singleActualEVMChart = chart;
    else if (config.canvasId === 'actualCumulativeHoursChartCost') singleActualEVMCostChart = chart;

    return true;
}

function createActualSingleEVMChart(metrics, scenario, chartType) {
    const chartConfigs = [
        {
            canvasId: 'actualCumulativeHoursChart',
            dataKey: 'hours',
            yAxisLabel: 'Cumulative Hours',
            tooltipLabel: ' hours'
        },
        {
            canvasId: 'actualCumulativeHoursChartCost',
            dataKey: 'cost',
            yAxisLabel: `Cumulative Cost (${metrics.actual?.currency || metrics.currency || 'USD'})`,
            tooltipLabel: ''
        }
    ];

    chartConfigs.forEach(config => {
        createSingleEVMChart(metrics, 'actual', 'Cumulative', config);
    });
}

/********************
 * DISPLAY FUNCTIONS
 ********************/

function displayForecastedEVMetrics(BCWP, ACWP, BCWS, SPI, SV, CV, CPIcum, EAC) {
    const statsContainer = document.querySelector('#forecastedEVMetrics');
    if (!statsContainer) return;

    const cur = evmMetrics?.forecasted?.currency || 'USD';

    statsContainer.innerHTML = `
        <div class="stats-item"><div class="stats-label">Planned Value (PV)</div><div class="stats-value">${formatCurrency(BCWS, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Earned Value (EV)</div><div class="stats-value">${formatCurrency(BCWP, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Actual Cost (AC)</div><div class="stats-value">${formatCurrency(ACWP, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Cost Performance Index (CPI)</div><div class="stats-value">${formatValue(CPIcum, 2)}</div></div>
        <div class="stats-item"><div class="stats-label">Schedule Performance Index (SPI)</div><div class="stats-value">${formatValue(SPI, 2)}</div></div>
        <div class="stats-item"><div class="stats-label">Estimate at Completion (EAC)</div><div class="stats-value">${formatCurrency(EAC, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Schedule Variance (SV)</div><div class="stats-value">${formatCurrency(SV, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Cost Variance (CV)</div><div class="stats-value">${formatCurrency(CV, cur)}</div></div>
    `;
}

function displayActualEVMetrics(BCWP, ACWP, BCWS, SPI, SV, CV, CPIcum, EAC) {
    const statsContainer = document.querySelector('#actualEVMetrics');
    if (!statsContainer) return;

    const cur = evmMetrics?.actual?.currency || 'USD';

    statsContainer.innerHTML = `
        <div class="stats-item"><div class="stats-label">Planned Value (PV)</div><div class="stats-value">${formatCurrency(BCWS, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Earned Value (EV)</div><div class="stats-value">${formatCurrency(BCWP, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Actual Cost (AC)</div><div class="stats-value">${formatCurrency(ACWP, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Cost Performance Index (CPI)</div><div class="stats-value">${formatValue(CPIcum, 2)}</div></div>
        <div class="stats-item"><div class="stats-label">Schedule Performance Index (SPI)</div><div class="stats-value">${formatValue(SPI, 2)}</div></div>
        <div class="stats-item"><div class="stats-label">Estimate at Completion (EAC)</div><div class="stats-value">${formatCurrency(EAC, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Schedule Variance (SV)</div><div class="stats-value">${formatCurrency(SV, cur)}</div></div>
        <div class="stats-item"><div class="stats-label">Cost Variance (CV)</div><div class="stats-value">${formatCurrency(CV, cur)}</div></div>
        <button class="learn-more-btn" onclick="openModal('importanceScoreDistributionModal')">Learn More</button>
    `;
}

/********************
 * TABLE POPULATION
 ********************/

function populateForecastedEVMTable(distributionPlanned, distributionWithOverrun, evDistribution, allDates) {
    const table = document.querySelector('#forecastedEVMTable tbody');
    if (!table) return;

    table.innerHTML = "";

    // FIX: O(1) Map lookups instead of O(n) .find() per date
    const plannedMap = new Map(distributionPlanned.map(d => [d.date, d.hours]));
    const overrunMap = new Map(distributionWithOverrun.map(d => [d.date, d.hours]));
    const evMap = new Map(evDistribution.map(d => [d.date, d.hours]));

    const combinedData = allDates.map(date => ({
        date,
        plannedValue: plannedMap.get(date) ?? null,
        overrunValue: overrunMap.get(date) ?? null,
        evValue: evMap.get(date) ?? null
    }));

    const maxRows = 100;
    const reducedData = combinedData.length > maxRows ?
        combinedData.filter((_, i) => i % Math.ceil(combinedData.length / maxRows) === 0) :
        combinedData;

    reducedData.forEach(data => {
        const row = `
            <tr>
                <td>${data.date}</td>
                <td>${data.plannedValue !== null ? roundValue(data.plannedValue) : '-'}</td>
                <td>${data.overrunValue !== null ? roundValue(data.overrunValue) : '-'}</td>
                <td>${data.evValue !== null ? roundValue(data.evValue) : '-'}</td>
            </tr>`;
        table.innerHTML += row;
    });
}

function populateActualEVMTable(
    distributionPlanned, distributionActual, distributionEarned, distributionPredicted,
    distributionPlannedCost, distributionActualCost, distributionEarnedCost, distributionPredictedCost,
    allDates, transitionPointIndex, currency
) {
    const table = document.querySelector('#actualEVMTable tbody');
    if (!table) return;

    table.innerHTML = "";

    // FIX: O(1) Map lookups instead of O(n) .find() per date (8 lookups × n dates)
    const plannedMap = new Map(distributionPlanned.map(d => [d.date, d.hours]));
    const actualMap = new Map(distributionActual.map(d => [d.date, d.hours]));
    const earnedMap = new Map(distributionEarned.map(d => [d.date, d.hours]));
    const predictedMap = new Map(distributionPredicted.map(d => [d.date, d.hours]));
    const plannedCostMap = new Map(distributionPlannedCost.map(d => [d.date, d.cost]));
    const actualCostMap = new Map(distributionActualCost.map(d => [d.date, d.cost]));
    const earnedCostMap = new Map(distributionEarnedCost.map(d => [d.date, d.cost]));
    const predictedCostMap = new Map(distributionPredictedCost.map(d => [d.date, d.cost]));

    const combinedData = allDates.map((date, idx) => ({
        date,
        idx,
        plannedValue: plannedMap.get(date) ?? null,
        actualValue: actualMap.get(date) ?? null,
        earnedValue: earnedMap.get(date) ?? null,
        predictedValue: predictedMap.get(date) ?? null,
        plannedCostValue: plannedCostMap.get(date) ?? null,
        actualCostValue: actualCostMap.get(date) ?? null,
        earnedCostValue: earnedCostMap.get(date) ?? null,
        predictedCostValue: predictedCostMap.get(date) ?? null
    }));

    const maxRows = 100;
    const reducedData = combinedData.length > maxRows ?
        combinedData.filter((_, i) => i % Math.ceil(combinedData.length / maxRows) === 0) :
        combinedData;

    reducedData.forEach(data => {
        //let rowStyle = data.idx > transitionPointIndex ?
        //    'style="background-color: #fcf8e3;"' :
        //    (data.actualValue ? 'style="background-color: #dff0d8;"' : 'style="background-color: #f9f9f9;"');

        const row = `
            <tr>
                <td>${data.date}</td>
                <td>${data.plannedValue !== null ? roundValue(data.plannedValue) : '-'}</td>
                <td>${data.actualValue !== null ? roundValue(data.actualValue) : '-'}</td>
                <td>${data.earnedValue !== null ? roundValue(data.earnedValue) : '-'}</td>
                <td>${data.predictedValue !== null ? roundValue(data.predictedValue) : '-'}</td>
                <td>${data.plannedCostValue !== null ? formatCurrency(data.plannedCostValue, currency) : '-'}</td>
                <td>${data.actualCostValue !== null ? formatCurrency(data.actualCostValue, currency) : '-'}</td>
                <td>${data.earnedCostValue !== null ? formatCurrency(data.earnedCostValue, currency) : '-'}</td>
                <td>${data.predictedCostValue !== null ? formatCurrency(data.predictedCostValue, currency) : '-'}</td>
            </tr>`;
        table.innerHTML += row;
    });
}

/********************
 * INSIGHTS
 ********************/

function EVMClustercolorScale(cluster) {
    const colors = {
        1: '#ff9999', 2: '#ffcc99', 3: '#99ccff',
        4: '#ff9966', 5: '#66cc66'
    };
    return colors[cluster] || '#cccccc';
}

function populateEVMInsights(CPI, SPI, EAC, SV, CV) {
    const insights = [];

    if (CPI < 1.0) {
        insights.push({
            cluster: 1,
            text: `Cost overruns are likely, with a CPI of ${CPI.toFixed(2)}. Review cost control measures.`
        });
    }

    if (SPI < 1.0) {
        insights.push({
            cluster: 2,
            text: `Schedule delays detected with SPI of ${SPI.toFixed(2)}. Review critical path and identify bottlenecks.`
        });
    }

    if (EAC > 0) {
        insights.push({
            cluster: 3,
            text: `Project forecasted to complete with EAC of ${roundValue(EAC)}. Compare with original budget.`
        });
    }

    if (SV < 0) {
        insights.push({
            cluster: 4,
            text: `Negative schedule variance (${roundValue(SV)}). Project is behind schedule.`
        });
    }

    if (CV < 0) {
        insights.push({
            cluster: 5,
            text: `Negative cost variance (${roundValue(CV)}). Project is over budget.`
        });
    }

    const container = document.getElementById("evminsights");
    if (container) {
        container.innerHTML = "";
        insights.forEach(insight => {
            const div = document.createElement("div");
            div.className = "insight";
            div.innerHTML = `<span style="color: ${EVMClustercolorScale(insight.cluster)};">EVM Insight ${insight.cluster}:</span> ${insight.text}`;
            container.appendChild(div);
        });
    }
}

// Dispatch initialization once the DOM is ready so required elements exist.
if (!evmInitDispatched) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            document.dispatchEvent(evmInitEvent);
        }, { once: true });
    } else {
        document.dispatchEvent(evmInitEvent);
    }
}
