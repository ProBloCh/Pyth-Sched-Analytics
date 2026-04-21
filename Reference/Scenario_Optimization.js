/**
 * Generate a recommendation based on task metrics
 * 
 * @param {number} impact - Schedule impact from sensitivity analysis
 * @param {number} correlation - Correlation with project finish time
 * @param {number} variation - Variation coefficient (uncertainty)
 * @param {number} riskScore - Network-based risk score
 * @param {number} importanceScore - Network-based importance score
 * @param {boolean} isCritical - Whether task is on critical path
 * @param {boolean} isNearCritical - Whether task is on near-critical path
 * @param {boolean} isResourceConstrained - Whether task has resource constraints
 * @returns {Object} - Recommendation object with text and HTML
 */
/**
 * Memory Manager Utility for Cybereum Optimization Modules
 * 
 * Provides centralized memory management to prevent leaks in long-running sessions.
 * Handles event listeners, timers, caches, and state cleanup.
 * 
 * Usage:
 * 1. Include this file before Scenario_Optimization.js
 * 2. Extend your optimizer with MemoryManager.mixin()
 * 3. Call this._trackResource() for all resources
 * 4. Call this.destroy() when done
 */

class MemoryManager {
    constructor() {
        this._eventListeners = [];
        this._timers = new Set();
        this._intervals = new Set();
        this._destroyed = false;
    }

    /**
     * Track and add an event listener
     */
    _addEventListener(element, event, handler, options) {
        if (!element) {
            console.warn('[MemoryManager] Attempted to add listener to null element');
            return;
        }

        element.addEventListener(event, handler, options);
        this._eventListeners.push({ element, event, handler, options });
    }

    /**
     * Track and create a timeout
     */
    _setTimeout(callback, delay) {
        const timerId = window.setTimeout(() => {
            this._timers.delete(timerId);
            if (!this._destroyed) {
                callback();
            }
        }, delay);
        this._timers.add(timerId);
        return timerId;
    }

    /**
     * Track and create an interval
     */
    _setInterval(callback, delay) {
        const intervalId = window.setInterval(() => {
            if (!this._destroyed) {
                callback();
            }
        }, delay);
        this._intervals.add(intervalId);
        return intervalId;
    }

    /**
     * Clear a specific timeout
     */
    _clearTimeout(timerId) {
        if (timerId) {
            window.clearTimeout(timerId);
            this._timers.delete(timerId);
        }
    }

    /**
     * Clear a specific interval
     */
    _clearInterval(intervalId) {
        if (intervalId) {
            window.clearInterval(intervalId);
            this._intervals.delete(intervalId);
        }
    }

    /**
     * Clean up all tracked resources
     */
    destroy() {
        if (this._destroyed) {
            console.warn('[MemoryManager] Already destroyed');
            return;
        }

        this._destroyed = true;

        // Remove all event listeners
        this._eventListeners.forEach(({ element, event, handler, options }) => {
            try {
                element.removeEventListener(event, handler, options);
            } catch (e) {
                console.warn('[MemoryManager] Error removing listener:', e);
            }
        });
        this._eventListeners = [];

        // Clear all timers
        this._timers.forEach(id => {
            try {
                window.clearTimeout(id);
            } catch (e) {
                console.warn('[MemoryManager] Error clearing timeout:', e);
            }
        });
        this._timers.clear();

        // Clear all intervals
        this._intervals.forEach(id => {
            try {
                window.clearInterval(id);
            } catch (e) {
                console.warn('[MemoryManager] Error clearing interval:', e);
            }
        });
        this._intervals.clear();

        console.log('[MemoryManager] Cleanup complete');
    }

    /**
     * Mixin to add memory management to an object
     */
    static mixin(target) {
        const manager = new MemoryManager();

        // Copy methods to target
        target._addEventListener = manager._addEventListener.bind(manager);
        target._setTimeout = manager._setTimeout.bind(manager);
        target._setInterval = manager._setInterval.bind(manager);
        target._clearTimeout = manager._clearTimeout.bind(manager);
        target._clearInterval = manager._clearInterval.bind(manager);

        // Store reference for destroy
        target._memoryManager = manager;

        // Add destroy method (or enhance existing one)
        const originalDestroy = target.destroy;
        target.destroy = function () {
            if (originalDestroy) {
                originalDestroy.call(this);
            }
            manager.destroy();
        };

        return target;
    }
}

/**
 * LRU Cache with automatic size management
 */
class LRUCache {
    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) {
            return undefined;
        }

        // Move to end (most recently used)
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        // If key exists, delete it first to update position
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        // If at capacity, delete oldest (first) entry
        else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, value);
    }

    has(key) {
        return this.cache.has(key);
    }

    delete(key) {
        return this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
    }

    get size() {
        return this.cache.size;
    }

    /**
     * Shrink cache by removing oldest entries
     */
    shrink(targetSize) {
        if (this.cache.size <= targetSize) return;

        const toRemove = this.cache.size - targetSize;
        const keysToDelete = Array.from(this.cache.keys()).slice(0, toRemove);
        keysToDelete.forEach(k => this.cache.delete(k));
    }
}

/**
 * Managed Cache with automatic size limits and efficient clearing
 */
class ManagedCache {
    constructor(maxSize = 1000, clearPercent = 0.3) {
        this.maxSize = maxSize;
        this.clearPercent = clearPercent; // Clear this % when limit hit
        this.cache = new Map();
    }

    get(key) {
        return this.cache.get(key);
    }

    set(key, value) {
        // Check if we need to clear
        if (this.cache.size >= this.maxSize) {
            this._clearOldest();
        }
        this.cache.set(key, value);
    }

    has(key) {
        return this.cache.has(key);
    }

    delete(key) {
        return this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
    }

    get size() {
        return this.cache.size;
    }

    _clearOldest() {
        const toClear = Math.floor(this.maxSize * this.clearPercent);
        const keys = Array.from(this.cache.keys()).slice(0, toClear);
        keys.forEach(k => this.cache.delete(k));

        console.log(`[ManagedCache] Cleared ${keys.length} old entries, now ${this.cache.size} entries`);
    }
}

/**
 * Global cache management for Cybereum
 */
const CybereumCacheManager = {
    _caches: new Map(),

    /**
     * Get or create a cache
     */
    getCache(name, options = {}) {
        if (!this._caches.has(name)) {
            const type = options.type || 'lru';
            const maxSize = options.maxSize || 1000;

            const cache = type === 'lru'
                ? new LRUCache(maxSize)
                : new ManagedCache(maxSize);

            this._caches.set(name, cache);
            console.log(`[CacheManager] Created ${type} cache: ${name} (max: ${maxSize})`);
        }
        return this._caches.get(name);
    },

    /**
     * Clear a specific cache
     */
    clearCache(name) {
        const cache = this._caches.get(name);
        if (cache) {
            cache.clear();
            console.log(`[CacheManager] Cleared cache: ${name}`);
        }
    },

    /**
     * Clear all caches
     */
    clearAll() {
        this._caches.forEach((cache, name) => {
            cache.clear();
            console.log(`[CacheManager] Cleared cache: ${name}`);
        });
    },

    /**
     * Get memory usage stats
     */
    getStats() {
        const stats = {};
        this._caches.forEach((cache, name) => {
            stats[name] = {
                size: cache.size,
                maxSize: cache.maxSize
            };
        });
        return stats;
    }
};

// Make available globally
if (typeof window !== 'undefined') {
    window.MemoryManager = MemoryManager;
    window.LRUCache = LRUCache;
    window.ManagedCache = ManagedCache;
    window.CybereumCacheManager = CybereumCacheManager;
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MemoryManager,
        LRUCache,
        ManagedCache,
        CybereumCacheManager
    };
}
function createEventListenerTracker() {
    const listeners = [];
    return {
        _addEventListener(element, event, handler, options) {
            element.addEventListener(event, handler, options);
            listeners.push({ element, event, handler, options });
        },
        _removeAllEventListeners() {
            let removed = 0;
            listeners.forEach(({ element, event, handler, options }) => {
                element.removeEventListener(event, handler, options);
                removed++;
            });
            listeners.length = 0;
            return removed;
        }
    };
}
// ---------- Optimization debug logging (disabled by default) ----------
const CYB_OPT_DEBUG = !!(window.cybereumState && (window.cybereumState.debugOptimization || (window.cybereumState.debug && window.cybereumState.debug.optimization)));
function optLog(...args) { if (CYB_OPT_DEBUG) console.log(...args); }
function optWarn(...args) { if (CYB_OPT_DEBUG) console.warn(...args); }

function generateTaskRecommendation(impact, correlation, variation, riskScore, importanceScore, isCritical, isNearCritical, isResourceConstrained) {
    // Convert scores to categories for easier processing
    const highImpact = impact > 0.5;
    const highCorrelation = correlation > 0.7;
    const highVariation = variation > 0.3;
    const highRisk = riskScore > 0.7;
    const mediumRisk = riskScore > 0.4 && riskScore <= 0.7;
    const highImportance = importanceScore > 0.7;
    const mediumImportance = importanceScore > 0.4 && importanceScore <= 0.7;

    // Track recommendation categories for tagging
    const categories = [];
    let primaryRecommendation = '';

    // Critical path with high impact - highest priority
    if (isCritical && highImpact) {
        categories.push('critical');
        if (isResourceConstrained) {
            primaryRecommendation = "Critical and resource-constrained. Consider reallocation of resources from non-critical tasks.";
        } else if (highVariation && highRisk) {
            primaryRecommendation = "Critical task with high uncertainty. Implement rigorous risk management and contingency planning.";
        } else {
            primaryRecommendation = "Critical task with significant schedule impact. Consider adding resources to accelerate.";
        }
    }
    // High correlation but not critical - potential controlling path
    else if (highCorrelation && !isCritical) {
        categories.push('strategic');
        if (isNearCritical) {
            primaryRecommendation = "Near-critical with high correlation to project completion. Likely to become critical if not managed properly.";
        } else {
            primaryRecommendation = "Strong correlation to project finish despite not being on critical path. Monitor closely for path switching.";
        }
    }
    // High risk tasks
    else if (highRisk && highVariation) {
        categories.push('high-risk');
        primaryRecommendation = "High risk and uncertainty. Develop specific risk mitigation strategies and consider buffer allocation.";
    }
    // High importance but low impact - strategic
    else if (highImportance && !highImpact) {
        categories.push('strategic');
        primaryRecommendation = "Strategically important task with limited current impact. Ensure adequate resources are available when needed.";
    }
    // High variation but low correlation/impact - buffer
    else if (highVariation && !highCorrelation && !highImpact) {
        categories.push('buffer');
        primaryRecommendation = "High uncertainty but limited impact. Consider adding schedule buffer after this task.";
    }
    // Medium cases
    else if (mediumRisk || mediumImportance) {
        categories.push('monitor');
        primaryRecommendation = "Moderate risk/importance. Monitor progress but lower priority for intervention.";
    }
    // Default case
    else {
        categories.push('monitor');
        primaryRecommendation = "Standard monitoring recommended. Low priority for special attention.";
    }

    // Additional secondary recommendations based on resource constraints
    let secondaryRecommendation = '';
    if (isResourceConstrained && (highImpact || highCorrelation)) {
        secondaryRecommendation = "Resource constraints may limit optimization opportunities. Consider alternative resource strategies.";
    }

    // Generate HTML with tags and full recommendation
    const fullRecommendation = secondaryRecommendation ?
        `${primaryRecommendation} ${secondaryRecommendation}` : primaryRecommendation;

    let tagsHtml = '';
    categories.forEach(category => {
        let tagClass, tagText;
        switch (category) {
            case 'critical':
                tagClass = 'critical-tag';
                tagText = 'CRITICAL';
                break;
            case 'high-risk':
                tagClass = 'high-risk-tag';
                tagText = 'HIGH RISK';
                break;
            case 'strategic':
                tagClass = 'strategic-tag';
                tagText = 'STRATEGIC';
                break;
            case 'buffer':
                tagClass = 'buffer-tag';
                tagText = 'BUFFER';
                break;
            case 'monitor':
                tagClass = 'monitor-tag';
                tagText = 'MONITOR';
                break;
        }
        tagsHtml += `<span class="recommendation-tag ${tagClass}">${tagText}</span>`;
    });

    const html = `
        <div>
            ${tagsHtml}
            <div style="margin-top: 5px;">${fullRecommendation}</div>
        </div>
    `;

    return {
        text: fullRecommendation,
        html: html,
        categories: categories
    };
}



/**
 * Normalize configured working days to ISO weekday numbers (1=Mon ... 7=Sun).
 * Accepts either ISO-style (1..7) or JS-style (0..6) inputs.
 *
 * @param {Array<number|string>} workingDays - Calendar working days
 * @returns {Set<number>} - Normalized ISO weekday numbers
 */
function getNormalizedWorkingDaySet(workingDays) {
    const baseWorkingDays = (Array.isArray(workingDays) && workingDays.length)
        ? workingDays
        : [1, 2, 3, 4, 5];

    const normalizedWorkingDays = baseWorkingDays
        .map(day => Number(day))
        .filter(day => Number.isFinite(day) && day >= 0 && day <= 7)
        .map(day => day === 0 ? 7 : day);

    return new Set(normalizedWorkingDays.length ? normalizedWorkingDays : [1, 2, 3, 4, 5]);
}

/**
 * Calculate the number of working days between two dates
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @param {Object} calendar - Work calendar with working days and holidays
 * @returns {Number} - Number of working days
 */
function calculateWorkingDaysBetween(startDate, endDate, calendar) {
    if (!startDate || !endDate) return 0;

    // Handle case where dates are the same or end is before start
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (start.getTime() === end.getTime()) return 0;
    if (start > end) return -calculateWorkingDaysBetween(end, start, calendar);

    // Get working days configuration
    const workingDaysArr = (calendar && Array.isArray(calendar.workingDays) && calendar.workingDays.length)
        ? calendar.workingDays
        : [1, 2, 3, 4, 5]; // Mon-Fri default
    const holidayArr = (calendar && Array.isArray(calendar.holidays) && calendar.holidays.length)
        ? calendar.holidays
        : [];
    const workingDaySet = getNormalizedWorkingDaySet(workingDaysArr);
    const holidaySet = new Set(holidayArr);

    // Helper to check if a date is a working day
    const isWorkingDay = (date) => {
        const dow = date.getDay(); // JS: 0=Sun..6=Sat
        const isoDow = (dow === 0 ? 7 : dow);
        const isWorkDow = workingDaySet.has(isoDow);
        const dateString = date.toISOString().slice(0, 10); // YYYY-MM-DD
        return isWorkDow && !holidaySet.has(dateString);
    };

    // Count working days between the dates
    let workingDaysCount = 0;
    const current = new Date(start);
    current.setHours(0, 0, 0, 0); // Normalize to start of day

    // Skip the start date if it's the same as the end date
    if (start.toDateString() !== end.toDateString()) {
        current.setDate(current.getDate() + 1);
    }

    // Count days until we reach end date
    while (current < end) {
        if (isWorkingDay(current)) {
            workingDaysCount++;
        }
        current.setDate(current.getDate() + 1);
    }

    return workingDaysCount;
}

/**
 * Shared utility functions for both Schedule Optimization and Monte Carlo Simulation
 * Provides consistent handling of durations, dates, and relationship types
 */

/**
 * Project Schedule Shared Utilities
 * Common functions used by both Schedule Optimization and Monte Carlo Simulation
 */
window.scheduleUtils = {
    getWorkCalendar() {
        // Default calendar structure
        const defaultCalendar = {
            hoursPerDay: 8,
            workingDays: [1, 2, 3, 4, 5], // Monday through Friday
            holidays: []                   // Empty array by default
        };

        // Prefer import-driven calendar defaults (P6/MSP) if available
        const calState = window?.cybereumState?.calendars;
        const importDefault = calState
            ? (calState.default
                || (calState.defaultCalendarId && calState.byId && calState.byId[String(calState.defaultCalendarId)])
                || null)
            : null;
        // Team overrides (optional)
        const globalCalendar = window.cybereumState?.teamCalendar || {};
        const hoursPerDay = Number(
            globalCalendar.hoursPerDay
            ?? importDefault?.dayHours
            ?? importDefault?.hoursPerDay
            ?? importDefault?.hoursPerDayAvg
            ?? calState?.defaultHoursPerDay
            ?? window?.DEFAULT_HOURS_PER_DAY
            ?? defaultCalendar.hoursPerDay
        );

        // Prefer working days from import globals if published; else calendar object; else team overrides
        const workingDays = Array.isArray(globalCalendar.workingDays) && globalCalendar.workingDays.length
            ? globalCalendar.workingDays
            : (window.WORKING_DAY_SET instanceof Set && window.WORKING_DAY_SET.size > 0)
                ? Array.from(window.WORKING_DAY_SET)
                : (Array.isArray(importDefault?.workingDays) && importDefault.workingDays.length)
                    ? importDefault.workingDays
                    : (Array.isArray(calState?.defaultWorkingDays) && calState.defaultWorkingDays.length)
                        ? calState.defaultWorkingDays
                        : (Array.isArray(window?.DEFAULT_WORKING_DAYS) && window.DEFAULT_WORKING_DAYS.length)
                            ? window.DEFAULT_WORKING_DAYS
                            : defaultCalendar.workingDays;
        // Prefer holiday set from import globals
        const holidays = Array.isArray(globalCalendar.holidays) && globalCalendar.holidays.length
            ? globalCalendar.holidays
            : (window.HOLIDAY_SET instanceof Set)
                ? Array.from(window.HOLIDAY_SET)
                : defaultCalendar.holidays;
        // Merge with defaults, ensuring all properties exist
        return {
            ...defaultCalendar,
            ...globalCalendar,
            // Ensure arrays are arrays even if provided as undefined
            hoursPerDay: (Number.isFinite(hoursPerDay) && hoursPerDay > 0) ? hoursPerDay : defaultCalendar.hoursPerDay,
            workingDays,
            holidays
        };
    },

    getPathsFromGlobalState() {
        const pathInfo = {
            critical: [],
            outlier: []
        };

        // Try cybereumState first
        if (window.cybereumState) {
            // Extract critical paths
            if (window.cybereumState.criticalPathResult &&
                window.cybereumState.criticalPathResult.paths) {
                pathInfo.critical = window.cybereumState.criticalPathResult.paths.map((path, index) => {
                    return {
                        index: index + 1,
                        nodes: path.map(node => typeof node === 'object' ? node.ID : node),
                        duration: this.calculatePathDuration(
                            path,
                            window.cybereumState.nodeMap,
                            window.cybereumState.succMap,
                            window.cybereumState.predMap
                        )
                    };
                });
            }

            // Extract near-critical paths
            if (window.cybereumState.outlierPathsResult &&
                window.cybereumState.outlierPathsResult.paths) {
                pathInfo.outlier = window.cybereumState.outlierPathsResult.paths.map((path, index) => {
                    return {
                        index: index + 1,
                        nodes: path.map(node => typeof node === 'object' ? node.ID : node),
                        duration: this.calculatePathDuration(
                            path,
                            window.cybereumState.nodeMap,
                            window.cybereumState.succMap,
                            window.cybereumState.predMap
                        )
                    };
                });
            }
        }

        return pathInfo;
    },
    /**
     * Calculate how resources affect duration with diminishing returns model
     */
    calculateResourceAdjustedDuration(baseDuration, baseResources, additionalResources, percentComplete = 0, options = {}) {
        // Early exit conditions
        if (additionalResources === 0 || percentComplete >= 100 || baseDuration <= 0 || baseResources <= 0) {
            return baseDuration;
        }

        // Default options
        const complexity = options.complexity || 0.5;
        const maxReduction = options.maxReduction || 0.75;
        const efficiency = options.efficiency || 1.0;

        // Calculate completed portion (unchanged)
        const completedPortion = baseDuration * (percentComplete / 100);
        const remainingDuration = baseDuration - completedPortion;

        // Apply diminishing returns with resource efficiency factor
        const effectiveAdditional = additionalResources * efficiency;
        let newRemainingDuration;

        if (additionalResources > 0) {
            // Adding resources - diminishing returns
            const resourceRatio = baseResources / (baseResources + effectiveAdditional);
            const complexityFactor = complexity + 0.5; // Range 0.5-1.5
            const reductionFactor = Math.pow(resourceRatio, complexityFactor);

            // Apply maximum reduction constraint
            newRemainingDuration = remainingDuration * Math.max(reductionFactor, 1 - maxReduction);
        } else {
            // Removing resources - duration increases with limits
            const resourceRatio = Math.max(0.1, (baseResources + additionalResources) / baseResources);
            const increaseLimit = remainingDuration * (1 + maxReduction);
            newRemainingDuration = Math.min(remainingDuration / resourceRatio, increaseLimit);
        }

        // Total new duration = completed portion + new remaining portion
        return completedPortion + newRemainingDuration;
    },

    /**
     * Calculate path duration with proper relationship type handling
     */
    calculatePathDuration(path, nodeMap, succMap, predMap) {
        if (!path || path.length <= 1) return 0;

        // Track earliest times through the path
        const earliestStart = new Map();
        const earliestFinish = new Map();

        // Initialize first node
        const firstNodeId = typeof path[0] === 'object' ? path[0].ID : path[0];
        const firstNode = nodeMap.get(firstNodeId);

        if (!firstNode) {
            console.warn(`First node ${firstNodeId} not found in nodeMap`);
            return 0;
        }

        earliestStart.set(firstNodeId, 0);
        earliestFinish.set(firstNodeId, Number(firstNode.Duration || 0));

        // Process each link in the path
        for (let i = 1; i < path.length; i++) {
            const currentNodeId = typeof path[i] === 'object' ? path[i].ID : path[i];
            const prevNodeId = typeof path[i - 1] === 'object' ? path[i - 1].ID : path[i - 1];

            const currentNode = nodeMap.get(currentNodeId);
            if (!currentNode) {
                console.warn(`Node ${currentNodeId} not found in nodeMap`);
                continue;
            }

            // Find the edge connecting these nodes
            let edge;

            // First check predecessor map
            const predEdges = predMap.get(currentNodeId) || [];
            edge = predEdges.find(e => e.source === prevNodeId);

            // If not found, check successor map
            if (!edge) {
                const succEdges = succMap.get(prevNodeId) || [];
                edge = succEdges.find(e => e.target === currentNodeId);
            }

            if (!edge) {
                console.warn(`No edge found from ${prevNodeId} to ${currentNodeId}`);
                continue;
            }

            const relationType = edge.type || 'FS'; // Default to FS
            const lag = Number(edge.lagHrs || 0);

            // Calculate earliest start based on relationship type
            let es;

            switch (relationType) {
                case 'FS': // Finish-to-Start
                    // Successor starts after predecessor finishes + lag
                    es = earliestFinish.get(prevNodeId) + lag;
                    break;

                case 'SS': // Start-to-Start
                    // Successor starts after predecessor starts + lag
                    es = earliestStart.get(prevNodeId) + lag;
                    break;

                case 'FF': // Finish-to-Finish
                    // Calculate when successor must start to finish with predecessor
                    es = earliestFinish.get(prevNodeId) - Number(currentNode.Duration || 0) + lag;
                    break;

                case 'SF': // Start-to-Finish
                    // Calculate when successor must start to finish after predecessor starts
                    es = earliestStart.get(prevNodeId) - Number(currentNode.Duration || 0) + lag;
                    break;

                default:
                    es = earliestFinish.get(prevNodeId) + lag;
            }

            // Ensure non-negative start time
            es = Math.max(0, es);

            earliestStart.set(currentNodeId, es);
            earliestFinish.set(currentNodeId, es + Number(currentNode.Duration || 0));
        }

        // Path duration is determined by finish time of last node
        const lastNodeId = typeof path[path.length - 1] === 'object' ? path[path.length - 1].ID : path[path.length - 1];
        return earliestFinish.get(lastNodeId) || 0;
    },

    /**
     * Calculate end date based on hours from start and working calendar
     */
    calculateCalendarEndDate(startDate, hours, teamCalendar) {
        if (!startDate || isNaN(hours) || hours < 0) {
            console.warn(`Invalid parameters for calculateCalendarEndDate`);
            return new Date(startDate || window.cybereumState.dataDate || new Date());
        }

        try {
            // Use shared utility if available
            if (typeof calculateEndDateWithCalendar === 'function') {
                return calculateEndDateWithCalendar(
                    new Date(startDate),
                    hours,
                    teamCalendar
                );
            }

            // Fallback implementation
            const endDate = new Date(startDate);
            const hoursPerDay = teamCalendar?.hoursPerDay || 8;
            const workingDaySet = getNormalizedWorkingDaySet(teamCalendar?.workingDays);
            const holidays = teamCalendar?.holidays || [];

            // Helper to check if a date is a working day
            const isWorkingDay = (date) => {
                const dayOfWeek = date.getDay();
                const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
                const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD
                return workingDaySet.has(isoDay) && !holidays.includes(dateString);
            };

            // Handle partial day from start time
            const startHour = startDate.getHours();
            const startMinutes = startDate.getMinutes();
            const hoursRemainingInFirstDay = Math.max(0, hoursPerDay - startHour - (startMinutes / 60));

            let remainingHours = hours;

            // Use hours in first day
            if (hoursRemainingInFirstDay > 0 && remainingHours > 0) {
                const hoursToUseInFirstDay = Math.min(hoursRemainingInFirstDay, remainingHours);
                remainingHours -= hoursToUseInFirstDay;

                if (remainingHours === 0) {
                    endDate.setHours(startHour + hoursToUseInFirstDay);
                    return endDate;
                }
            }

            // Add whole working days
            const wholeDays = Math.floor(remainingHours / hoursPerDay);
            remainingHours = remainingHours % hoursPerDay;

            let daysAdded = 0;
            while (daysAdded < wholeDays) {
                endDate.setDate(endDate.getDate() + 1);
                endDate.setHours(0, 0, 0, 0); // Reset to start of day

                if (isWorkingDay(endDate)) {
                    daysAdded++;
                }
            }

            // Add remaining hours to the last working day
            if (remainingHours > 0) {
                // Find next working day if needed
                while (!isWorkingDay(endDate)) {
                    endDate.setDate(endDate.getDate() + 1);
                    endDate.setHours(0, 0, 0, 0);
                }

                // Add remaining hours
                endDate.setHours(remainingHours);
            }

            return endDate;
        } catch (error) {
            console.error("Error calculating end date:", error);
            return new Date(startDate);
        }
    },

    /**
     * Format a date consistently across both interfaces
     */
    formatCalendarDate(date, includeTime = false) {
        if (!date) return 'N/A';

        const options = {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        };

        if (includeTime) {
            options.hour = '2-digit';
            options.minute = '2-digit';
        }

        try {
            return date.toLocaleDateString('en-US', options);
        } catch (error) {
            // Fallback formatting
            return date.toDateString() + (includeTime ? ' ' + date.toTimeString().slice(0, 5) : '');
        }
    },

    /**
     * Validate paths to remove invalid SF segments
     */
    validatePaths() {
        const succMap = window.cybereumState?.succMap;
        this.state.criticalPaths = window.scheduleUtils.validatePaths(this.state.criticalPaths, succMap);
        this.state.nearCriticalPaths = window.scheduleUtils.validatePaths(this.state.nearCriticalPaths, succMap);

        console.log(`After validation: ${this.state.criticalPaths.length} critical paths, ${this.state.nearCriticalPaths.length} near-critical paths`);
    },

    calculateConstraintPenalties(solution, updatedNodes, constraints) {
        const penalties = {
            time: 0,
            resource: 0,
            quality: 0,
            total: 0
        };

        // Default empty constraints if not provided
        if (!constraints) {
            constraints = {
                time: new Map(),
                resource: new Map(),
                quality: new Map()
            };
        }

        // Time constraint penalties
        if (!constraints.time || (constraints.time instanceof Map ? constraints.time.size === 0 : constraints.time.length === 0)) {
            // no time constraints
        } else if (!Array.isArray(updatedNodes) || updatedNodes.length === 0) {
            // Cannot evaluate time constraints without updated node dates; treat as no time penalty.
        } else {
            constraints.time.forEach((constraint, key) => {
                if (!constraint.taskId) return;

                const node = updatedNodes.find(n => n.ID === constraint.taskId);
                if (!node) return;

                const deadlineDate = constraint.date;
                const finishDate = new Date(node.Finish);

                if (finishDate > deadlineDate) {
                    const daysLate = Math.ceil((finishDate - deadlineDate) / (24 * 60 * 60 * 1000));
                    // Exponential penalty for lateness
                    const severityFactor = constraint.hard ? 10 : 2;
                    const penalty = Math.pow(daysLate, 1.5) * severityFactor;
                    penalties.time += penalty;
                }
            });


        }

        // Resource constraint penalties 
        const resourceUtilization = this.calculateResourceUtilization(solution, updatedNodes);
        Object.entries(resourceUtilization.overallocations).forEach(([resourceType, periods]) => {
            if (periods.length > 0) {
                // Sum up excess across all periods, with quadratic penalty scaling
                const totalExcess = periods.reduce((sum, period) => sum + Math.pow(period.excess, 2), 0);
                const constraint = constraints.resource.get(resourceType);
                const severityFactor = constraint?.hard ? 5 : 1;
                penalties.resource += totalExcess * severityFactor / periods.length;
            }
        });

        // Quality/risk penalties
        constraints.quality.forEach((constraint, key) => {
            const taskId = constraint.taskId;
            const resourceChange = solution.get(taskId) || 0;

            if (constraint.type === 'risk' && resourceChange < constraint.minAdditionalResources) {
                const deficit = constraint.minAdditionalResources - resourceChange;
                const riskFactor = constraint.riskScore || 0.5;
                penalties.quality += deficit * riskFactor * 10;
            }
        });

        penalties.total = penalties.time + penalties.resource + penalties.quality;
        return penalties;
    },

    calculateResourceUtilization(solution, updatedNodes) {
        // Get resource constraints 
        const resourceConstraints = new Map();

        // Get all resource types
        const resourceTypes = new Set();
        updatedNodes.forEach(node => {
            const resourceType = node.resourceType || 'default';
            resourceTypes.add(resourceType);
        });

        // Create default constraints for each resource type
        resourceTypes.forEach(type => {
            resourceConstraints.set(type, {
                available: 10, // Default
                type: 'resource',
                resourceType: type
            });
        });

        // Override with actual constraints if available
        if (window.constraintOptimizer && window.constraintOptimizer.state &&
            window.constraintOptimizer.state.constraints.resource) {
            window.constraintOptimizer.state.constraints.resource.forEach((constraint, key) => {
                resourceConstraints.set(key, constraint);
            });
        }

        // Get calendar with guaranteed complete structure
        const teamCalendar = this.getWorkCalendar();
        const startDate = window.cybereumState?.startDate ?
            new Date(window.cybereumState.startDate) : window.cybereumState.dataDate || new Date();

        // Create resource profiles with calendar-aware time bins
        const resourceProfiles = {};
        resourceTypes.forEach(type => {
            resourceProfiles[type] = [];
        });

        // For each task, calculate resource usage across working days
        updatedNodes.forEach(node => {
            if (!node.Start || !node.Finish) return;

            const nodeStart = new Date(node.Start);
            const nodeFinish = new Date(node.Finish);
            const resourceType = node.resourceType || 'default';

            if (!resourceProfiles[resourceType]) return;

            // Get original and additional resources
            const baseResources = node.resourcesRequired || 1;
            const additionalResources = solution.get(node.ID) || 0;
            const totalResources = baseResources + additionalResources;

            // Skip if task has no working days

            // Add usage to profile with exact dates
            let currentDate = new Date(nodeStart);
            while (currentDate <= nodeFinish) {
                // Only add for working days - use robust isWorkingDay function
                if (isWorkingDay(currentDate, teamCalendar)) {
                    const profile = resourceProfiles[resourceType];

                    // Find or create bin for this date
                    const dateStr = currentDate.toISOString().split('T')[0];
                    let bin = profile.find(b => b.date === dateStr);

                    if (!bin) {
                        bin = { date: dateStr, usage: 0, tasks: [] };
                        profile.push(bin);
                    }

                    bin.usage += totalResources;
                    bin.tasks.push({
                        id: node.ID,
                        name: node.Name || `Task ${node.ID}`,
                        resources: totalResources
                    });
                }

                // Move to next day
                currentDate.setDate(currentDate.getDate() + 1);
            }
        });

        // Find overallocations
        const overallocations = {};

        Object.entries(resourceProfiles).forEach(([resourceType, profile]) => {
            const constraint = resourceConstraints.get(resourceType);
            if (!constraint) return;

            const available = constraint.available;
            const overallocatedDays = profile.filter(day => day.usage > available);

            if (overallocatedDays.length > 0) {
                overallocations[resourceType] = overallocatedDays.map(day => ({
                    date: day.date,
                    available,
                    usage: day.usage,
                    excess: day.usage - available,
                    tasks: day.tasks
                }));
            }
        });

        return {
            resourceProfiles,
            overallocations
        };
    }
};

/**
 * Get concise AI feedback for schedule optimization
 * @param {Object} task - Task to analyze
 * @param {Number} projectDays - Total project days
 * @param {Object} analysis - Analysis object
 * @param {String} projectSegment - Project industry segment
 * @param {String} section - Type of feedback (recommendations, risk)
 * @returns {Promise<String>} - Concise AI-generated feedback
 */
async function getOptimizationAIFeedback(task, projectDays, analysis, projectSegment, section) {
    // Create cache key
    const cacheKey = `${task.ID}|${section}|optimization`;

    // Check cache first
    if (window.cybereumCache && window.cybereumCache.aiFeedback &&
        window.cybereumCache.aiFeedback[cacheKey]) {
        return window.cybereumCache.aiFeedback[cacheKey];
    }

    // Generate micro-prompts suited for small display areas
    let prompt = "";
    const isCritical = analysis.criticalPathEffect > 0 || task.isCritical || task.isOnCriticalPath;

    switch (section) {
        case 'recommendations':
            prompt = `
            Task: ${task.Name} in ${projectSegment} project
            Duration: ${task.Duration} ${task.TimeUnits || 'hours'} 
            Critical: ${isCritical ? 'Yes' : 'No'}
            
            List ONLY 3-4 specific resource types (no explanations) that would best accelerate this task.
            Each resource type should be 1-3 words maximum.
            
            Format as simple bullet list with no introductory text.
            `;
            break;

        case 'risk':
            prompt = `
            Task: ${task.Name} in ${projectSegment} project
            Duration: ${task.Duration} ${task.TimeUnits || 'hours'}
            Critical: ${isCritical ? 'Yes' : 'No'}
            
            List ONLY 2-3 key risks when adding resources to this task.
            Each risk should be 5-8 words maximum.
            
            Format as simple bullet list with no introductory text.
            `;
            break;

        default:
            return null;
    }

    // Make the API call
    try {
        const response = await fetch('/OpenAI/GenerateTextFromAI', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });

        if (!response.ok) {
            throw new Error(`Network response was not ok: ${response.status}`);
        }

        const data = await response.json();

        // Ensure response is properly formatted for the UI constraints
        let content = data.content;

        // Remove any markdown formatting or excessive spacing
        content = content.replace(/^\s*[-•*]\s*/gm, '• '); // Standardize bullet points
        content = content.replace(/\n{2,}/g, '\n'); // Remove extra blank lines

        // Cache the result
        if (!window.cybereumCache) {
            window.cybereumCache = { aiFeedback: {} };
        } else if (!window.cybereumCache.aiFeedback) {
            window.cybereumCache.aiFeedback = {};
        }

        window.cybereumCache.aiFeedback[cacheKey] = content;
        return content;
    } catch (error) {
        console.error(`Error fetching optimization AI feedback for task ${task.ID}:`, error);
        return null;
    }
}
/**
 * Calculate how resources affect duration using an improved diminishing returns model
 * 
 * @param {number} baseDuration - Original duration
 * @param {number} baseResources - Original resource count
 * @param {number} additionalResources - Additional resources to add
 * @param {number} percentComplete - Percentage of task already completed (0-100)
 * @param {Object} options - Additional options
 * @param {number} options.complexity - Task complexity factor (0-1), higher means less reduction
 * @param {number} options.maxReduction - Maximum possible duration reduction (0-1)
 * @returns {number} - New duration after resource addition
 */
function calculateDurationWithResources(baseDuration, baseResources, additionalResources, percentComplete = 0, options = {}) {
    // Early exit conditions
    if (additionalResources <= 0 || percentComplete >= 100 || baseDuration <= 0 || baseResources <= 0) {
        return baseDuration;
    }

    // Default options
    const complexity = options.complexity || 0.5; // Default complexity factor
    const maxReduction = options.maxReduction || 0.75; // Max 75% reduction by default

    // Calculate completed portion (unchanged)
    const completedPortion = baseDuration * (percentComplete / 100);

    // Calculate remaining duration
    const remainingDuration = baseDuration - completedPortion;

    // Apply enhanced diminishing returns formula to remaining duration
    // This formula accounts for task complexity and maximum possible reduction
    const resourceRatio = baseResources / (baseResources + additionalResources);
    const complexityFactor = complexity + 0.5; // Range 0.5-1.5
    const reductionFactor = Math.pow(resourceRatio, complexityFactor);

    // Apply maximum reduction constraint
    let newRemainingDuration = remainingDuration * Math.max(reductionFactor, 1 - maxReduction);

    // Total new duration = completed portion + new remaining portion
    return completedPortion + newRemainingDuration;
}

/**
 * Calculate end date based on start date, duration, and calendar
 * Respects working days and hours per day from calendar
 * 
 * @param {Date} startDate - Start date
 * @param {number} durationHours - Duration in hours
 * @param {Object} calendar - Calendar with working days and hours
 * @returns {Date} - End date
 */
function calculateEndDateWithCalendar(startDate, durationHours, calendar) {
    if (!startDate || isNaN(durationHours)) {
        console.warn("Invalid parameters for calculateEndDateWithCalendar");
        return new Date(startDate);
    }

    const hoursPerDay = calendar?.hoursPerDay || DEFAULT_HOURS_PER_DAY || 8;
    const workingDaySet = getNormalizedWorkingDaySet(calendar?.workingDays);
    const holidays = calendar?.holidays || [];

    // Create a new date object to avoid modifying the input
    const endDate = new Date(startDate);

    // First, handle any partial day from the starting time
    const startHour = endDate.getHours();
    const startMinutes = endDate.getMinutes();

    // Calculate working hours remaining in the first day
    const hoursRemainingInStartDay = Math.max(0, hoursPerDay - startHour - (startMinutes / 60));

    // Adjust durationHours based on the first day
    let remainingDuration = durationHours;

    // If we have hours remaining in the first day and duration to add
    if (hoursRemainingInStartDay > 0 && remainingDuration > 0) {
        // Use at most the hours remaining in the first day
        const hoursToAddFirstDay = Math.min(hoursRemainingInStartDay, remainingDuration);
        endDate.setHours(startHour + hoursToAddFirstDay);
        remainingDuration -= hoursToAddFirstDay;
    }

    // If we still have duration to add, move to whole days
    if (remainingDuration > 0) {
        // Calculate whole working days
        const wholeDays = Math.floor(remainingDuration / hoursPerDay);
        remainingDuration -= (wholeDays * hoursPerDay);

        // Add whole working days
        let daysAdded = 0;
        while (daysAdded < wholeDays) {
            endDate.setDate(endDate.getDate() + 1);

            // Reset time to start of day if we're adding days
            endDate.setHours(0, 0, 0, 0);

            // Check if this is a working day
            const dayOfWeek = endDate.getDay();
            // Convert Sunday from 0 to 7 for ISO format (1=Monday, 7=Sunday)
            const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;

            // Check if it's a holiday
            const dateString = endDate.toISOString().split('T')[0]; // YYYY-MM-DD
            const isHoliday = holidays.includes(dateString);

            if (workingDaySet.has(isoDay) && !isHoliday) {
                daysAdded++;
            }
        }

        // Now handle remaining hours, considering we might need to find the next working day
        if (remainingDuration > 0) {
            // Set hours to beginning of the day first 
            endDate.setHours(0, 0, 0, 0);

            // Check if current day is a working day
            const currentDayOfWeek = endDate.getDay();
            const currentIsoDay = currentDayOfWeek === 0 ? 7 : currentDayOfWeek;
            const currentDateString = endDate.toISOString().split('T')[0];
            const isCurrentDayHoliday = holidays.includes(currentDateString);

            // If we're not on a working day, find the next one
            if (!workingDaySet.has(currentIsoDay) || isCurrentDayHoliday) {
                let foundWorkingDay = false;
                while (!foundWorkingDay) {
                    endDate.setDate(endDate.getDate() + 1);

                    const nextDayOfWeek = endDate.getDay();
                    const nextIsoDay = nextDayOfWeek === 0 ? 7 : nextDayOfWeek;
                    const nextDateString = endDate.toISOString().split('T')[0];
                    const isNextDayHoliday = holidays.includes(nextDateString);

                    foundWorkingDay = workingDaySet.has(nextIsoDay) && !isNextDayHoliday;
                }
            }

            // Now add the remaining hours to the final working day
            endDate.setHours(remainingDuration);
        }
    }

    return endDate;
}

/**
 * Calculate early dates (ES, EF) for the entire network using forward pass
 * Handles all relationship types correctly
 * 
 * @param {Map} nodeMap - Map of node ID to node
 * @param {Map} succMap - Map of node ID to successor edges
 * @param {Map} predMap - Map of node ID to predecessor edges
 * @param {Array} topoOrder - Topological order of nodes (optional)
 * @returns {Object} - Object with earliestStart and earliestFinish maps
 */
function calculateEarlyDates(nodeMap, succMap, predMap, topoOrder) {
    const earliestStart = new Map();
    const earliestFinish = new Map();

    // Initialize start and finish maps
    nodeMap.forEach((_, nodeId) => {
        earliestStart.set(nodeId, -Infinity);
        earliestFinish.set(nodeId, -Infinity);
    });

    // If no topoOrder provided, use the provided maps to create one
    if (!topoOrder || !topoOrder.length) {
        topoOrder = calculateTopologicalSort(nodeMap, succMap, predMap);
    }

    // Forward pass
    topoOrder.forEach(nodeId => {
        const node = nodeMap.get(nodeId);
        const predecessors = predMap.get(nodeId) || [];

        if (predecessors.length === 0) {
            // Start node
            earliestStart.set(nodeId, 0);
        } else {
            let es = -Infinity;

            // Calculate ES based on all predecessors
            for (const edge of predecessors) {
                const predId = edge.source;
                const predNode = nodeMap.get(predId);
                const predStart = earliestStart.get(predId);
                const predFinish = earliestFinish.get(predId);

                // Skip if predecessor hasn't been processed
                if (predStart === -Infinity || predFinish === -Infinity) {
                    continue;
                }

                let candidateStart;

                switch (edge.type) {
                    case 'FS': // Finish-to-Start
                        candidateStart = predFinish + (edge.lagHrs || 0);
                        break;
                    case 'SS': // Start-to-Start
                        candidateStart = predStart + (edge.lagHrs || 0);
                        break;
                    case 'FF': // Finish-to-Finish
                        // ES = pred.EF + lag - duration
                        candidateStart = predFinish + (edge.lagHrs || 0) - node.Duration;
                        break;
                    case 'SF': // Start-to-Finish
                        // ES = pred.ES + lag - duration
                        candidateStart = predStart + (edge.lagHrs || 0) - node.Duration;
                        break;
                    default: // Default to FS
                        candidateStart = predFinish + (edge.lagHrs || 0);
                }

                es = Math.max(es, candidateStart);
            }

            // Ensure we don't have negative start time
            earliestStart.set(nodeId, Math.max(0, es));
        }

        // Calculate earliest finish = earliest start + duration
        earliestFinish.set(nodeId, earliestStart.get(nodeId) + node.Duration);
    });

    return { earliestStart, earliestFinish };
}

/**
 * Calculate late dates (LS, LF) for the entire network using backward pass
 * Handles all relationship types correctly
 * 
 * @param {Map} nodeMap - Map of node ID to node
 * @param {Map} succMap - Map of node ID to successor edges
 * @param {Map} predMap - Map of node ID to predecessor edges
 * @param {Array} topoOrder - Topological order of nodes
 * @param {number} projectFinish - Project finish time (maximum EF among end nodes)
 * @returns {Object} - Object with latestStart and latestFinish maps
 */
function calculateLateDates(nodeMap, succMap, predMap, topoOrder, projectFinish) {
    const latestStart = new Map();
    const latestFinish = new Map();

    // Initialize with maximum possible values
    nodeMap.forEach((_, nodeId) => {
        latestStart.set(nodeId, Infinity);
        latestFinish.set(nodeId, Infinity);
    });

    // Set latest finish for end nodes
    nodeMap.forEach((node, nodeId) => {
        const successors = succMap.get(nodeId) || [];
        if (successors.length === 0) {
            // End node
            latestFinish.set(nodeId, projectFinish);
            latestStart.set(nodeId, projectFinish - node.Duration);
        }
    });

    // Backward pass through reversed topological order
    for (let i = topoOrder.length - 1; i >= 0; i--) {
        const nodeId = topoOrder[i];
        const node = nodeMap.get(nodeId);
        const successors = succMap.get(nodeId) || [];

        if (successors.length > 0) {
            let lf = Infinity;

            for (const edge of successors) {
                const succId = edge.target;
                const succStart = latestStart.get(succId);
                const succFinish = latestFinish.get(succId);

                // Skip if successor hasn't been processed
                if (succStart === Infinity || succFinish === Infinity) {
                    continue;
                }

                let candidateFinish;

                switch (edge.type) {
                    case 'FS': // Finish-to-Start
                        candidateFinish = succStart - (edge.lagHrs || 0);
                        break;
                    case 'SS': // Start-to-Start
                        // LF = succ.LS - lag + duration
                        candidateFinish = succStart - (edge.lagHrs || 0) + node.Duration;
                        break;
                    case 'FF': // Finish-to-Finish
                        candidateFinish = succFinish - (edge.lagHrs || 0);
                        break;
                    case 'SF': // Start-to-Finish
                        // Constraint: succ.Finish >= pred.Start + lag
                        // Therefore: pred.Start <= succ.LF - lag
                        // pred.LF = pred.LS + pred.Duration
                        // => pred.LF <= succ.LF - lag + pred.Duration
                        candidateFinish = succFinish - (edge.lagHrs || 0) + node.Duration;
                        break;
                    default: // Default to FS
                        candidateFinish = succStart - (edge.lagHrs || 0);
                }

                lf = Math.min(lf, candidateFinish);
            }

            latestFinish.set(nodeId, lf);
            latestStart.set(nodeId, lf - node.Duration);
        }
    }

    return { latestStart, latestFinish };
}

/**
 * Calculate slack for all nodes and identify critical tasks
 * 
 * @param {Map} nodeMap - Map of node ID to node
 * @param {Map} earliestStart - Map of node ID to earliest start
 * @param {Map} latestStart - Map of node ID to latest start
 * @returns {Object} - Object with slack map and criticalTasks set
 */
function calculateSlack(nodeMap, earliestStart, latestStart) {
    const slack = new Map();
    const criticalTasks = new Set();

    nodeMap.forEach((node, nodeId) => {
        const es = earliestStart.get(nodeId);
        const ls = latestStart.get(nodeId);
        const slackValue = ls - es;

        slack.set(nodeId, slackValue);

        // Mark as critical if slack is zero or very close to zero
        if (slackValue <= 0.001) {
            criticalTasks.add(nodeId);
            node.isCritical = true;
        } else {
            node.isCritical = false;
        }
    });

    return { slack, criticalTasks };
}

/**
 * Calculate topological sort of the network
 * 
 * @param {Map|Array} nodes - Array of nodes or Map of node ID to node
 * @param {Map} succMap - Map of node ID to array of successor edges
 * @param {Map} predMap - Map of node ID to array of predecessor edges
 * @returns {Array} - Array of node IDs in topological order
 */
function calculateTopologicalSort(nodes, succMap, predMap) {
    const topoOrder = [];
    const inDegree = new Map();

    // Initialize in-degree map
    if (nodes instanceof Map) {
        nodes.forEach((_, id) => {
            inDegree.set(id, 0);
        });
    } else {
        nodes.forEach(node => {
            inDegree.set(node.ID, 0);
        });
    }

    // Calculate in-degrees from predecessor map if available
    if (predMap) {
        predMap.forEach((edges, nodeId) => {
            inDegree.set(nodeId, edges.length);
        });
    } else {
        // Calculate in-degrees from successor map
        succMap.forEach((edges, sourceId) => {
            edges.forEach(edge => {
                inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
            });
        });
    }

    // Start with nodes that have no predecessors
    const queue = [];
    inDegree.forEach((degree, nodeId) => {
        if (degree === 0) {
            queue.push(nodeId);
        }
    });

    // Process nodes in topological order
    while (queue.length > 0) {
        const currentId = queue.shift();
        topoOrder.push(currentId);

        // Process successors
        const successors = succMap.get(currentId) || [];
        successors.forEach(edge => {
            const targetId = edge.target;

            // Decrease in-degree and check if it's ready to process
            inDegree.set(targetId, inDegree.get(targetId) - 1);
            if (inDegree.get(targetId) === 0) {
                queue.push(targetId);
            }
        });
    }

    // Check if all nodes were processed (cycle detection)
    if (topoOrder.length !== inDegree.size) {
        console.warn("Graph contains cycles - topological sort is incomplete");
    }

    return topoOrder;
}

function _normId(x) { return String(x); }

function buildSuccessorMap(links, nodes) {
    const succMap = new Map();

    const ensureKey = (id) => {
        const k = _normId(id);
        if (!succMap.has(k)) succMap.set(k, []);
        // optional compatibility aliases
        if (!succMap.has(id)) succMap.set(id, succMap.get(k));
        const num = Number(k);
        if (Number.isFinite(num) && !succMap.has(num)) succMap.set(num, succMap.get(k));
        return k;
    };

    // init keys
    if (nodes instanceof Map) {
        nodes.forEach((_, id) => ensureKey(id));
    } else {
        (nodes || []).forEach(n => ensureKey(n.ID));
    }

    // add edges (dedupe to prevent redundant branching)
    const seen = new Set(); // s|t|type|lag
    (links || []).forEach(link => {
        const s = ensureKey(typeof link.source === 'object' ? link.source.ID : link.source);
        const t = ensureKey(typeof link.target === 'object' ? link.target.ID : link.target);

        const type = link.type || link.Type || 'FS';
        const lagHrs = getLinkLagHours(link);
        const key = `${s}|${t}|${type}|${lagHrs}`;
        if (seen.has(key)) return;
        seen.add(key);

        succMap.get(s).push({
            source: s,
            target: t,
            type,
            lagHrs,
            durHrs: convertDurationToHours(link.duration ?? link.Duration ?? 0, link.timeUnits ?? link.TimeUnits),
            _raw: link
        });
    });

    // deterministic ordering
    succMap.forEach(arr => arr.sort((a, b) =>
        String(a.target).localeCompare(String(b.target)) || String(a.type).localeCompare(String(b.type))
    ));

    return succMap;
}

function buildPredecessorMap(links, nodes) {
    const predMap = new Map();

    const ensureKey = (id) => {
        const k = _normId(id);
        if (!predMap.has(k)) predMap.set(k, []);
        if (!predMap.has(id)) predMap.set(id, predMap.get(k));
        const num = Number(k);
        if (Number.isFinite(num) && !predMap.has(num)) predMap.set(num, predMap.get(k));
        return k;
    };

    if (nodes instanceof Map) nodes.forEach((_, id) => ensureKey(id));
    else (nodes || []).forEach(n => ensureKey(n.ID));

    const seen = new Set(); // s|t|type|lag
    (links || []).forEach(link => {
        const s = ensureKey(typeof link.source === 'object' ? link.source.ID : link.source);
        const t = ensureKey(typeof link.target === 'object' ? link.target.ID : link.target);

        const type = link.type || link.Type || 'FS';
        const lagHrs = getLinkLagHours(link);
        const key = `${s}|${t}|${type}|${lagHrs}`;
        if (seen.has(key)) return;
        seen.add(key);

        predMap.get(t).push({
            source: s,
            target: t,
            type,
            lagHrs,
            durHrs: convertDurationToHours(link.duration ?? link.Duration ?? 0, link.timeUnits ?? link.TimeUnits),
            _raw: link
        });
    });

    predMap.forEach(arr => arr.sort((a, b) =>
        String(a.source).localeCompare(String(b.source)) || String(a.type).localeCompare(String(b.type))
    ));

    return predMap;
}


/**
 * Advanced calendar-aware work date calculations
 * @param {Date} startDate - Start date
 * @param {number} workHours - Work hours to add
 * @param {Object} calendar - Work calendar
 * @returns {Date} - Resulting date after adding work hours
 */
function addWorkTime(startDate, workHours, calendar) {
    const result = new Date(startDate);
    const hoursPerDay = calendar?.hoursPerDay || DEFAULT_HOURS_PER_DAY || 8;
    const workingDaySet = getNormalizedWorkingDaySet(calendar?.workingDays);
    const holidays = calendar?.holidays || [];

    // Working day check function
    const isWorkingDay = (date) => {
        const dayOfWeek = date.getDay();
        const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
        const dateStr = date.toISOString().split('T')[0];
        return workingDaySet.has(isoDay) && !holidays.includes(dateStr);
    };

    // Full working days to add
    const wholeDays = Math.floor(workHours / hoursPerDay);

    // Add whole working days
    let daysAdded = 0;
    while (daysAdded < wholeDays) {
        result.setDate(result.getDate() + 1);
        if (isWorkingDay(result)) {
            daysAdded++;
        }
    }

    // Add remaining hours
    const remainingHours = workHours % hoursPerDay;
    result.setHours(result.getHours() + remainingHours);

    return result;
}
/**
 * Enhanced Schedule Optimization Interface
 * 
 * Provides project managers with tools to optimize project schedules through
 * intelligent resource allocation and crashing strategies. This enhanced version:
 * 
 * - Uses improved algorithms for accurately handling all relationship types (FS, SS, FF, SF)
 * - Employs a genetic algorithm for finding near-optimal resource allocations
 * - Provides better visualization with path-based analysis
 * - Features calendar-aware date calculations for realistic projections
 * 
 * @param {Array} nodes - Array of project tasks with durations and risk parameters
 * @param {Array} links - Array of dependencies between nodes
 * @returns {Object} - Schedule optimizer object with methods to optimize schedules
 */
function createScheduleOptimizationInterface(nodes, links) {
    const scheduleOptimizer = {
        // State management
        state: {
            originalDurations: new Map(),
            resourceChanges: new Map(),
            taskRates: new Map(),
            criticalTasks: new Map(), // Maps task ID to critical path index
            outlierTasks: new Map(), // Maps task ID to near-critical path index
            impactScores: new Map(),
            dailySavings: 0,
            originalEndDate: null,
            projectedEndDate: null,
            resourceRate: 0,
            currency: "$",
            projectSegment: "General",
            aiFeedbackCache: {},
            isLoadingFeedback: new Set(),
            pathInfo: {
                critical: [],
                outlier: []
            }
        },

        /**
         * Initialize the optimizer by recording baseline durations and resource information
         */
        initialize() {
            console.log("Initializing schedule optimizer");

            // Store original durations and resource information
            nodes.forEach(node => {
                this.state.originalDurations.set(node.ID, {
                    duration: node.Duration,
                    resources: node.resourcesRequired || 1
                });

                // Store cost rates for each task (default to global rate if not specified)
                this.state.taskRates.set(node.ID, node.CostRate || 0);
            });

            // Load cost rate and project segment from start node
            const startNode = nodes.find(node => node.ID === "0");
            this.state.resourceRate = parseFloat(startNode?.CostRate || 100);
            this.state.currency = startNode?.Currency || "$";

            // Get project segment from start node
            if (startNode && startNode.Segment) {
                this.state.projectSegment = startNode.Segment;
                console.log(`Project segment set to: ${this.state.projectSegment}`);
            } else if (window.cybereumState && window.cybereumState.projectSegment) {
                this.state.projectSegment = window.cybereumState.projectSegment;
                console.log(`Project segment set from global state: ${this.state.projectSegment}`);
            }

            // Extract and store path information for critical and near-critical paths
            this.extractPathInformation();

            // Calculate impact scores
            this.calculateImpactScores();

            // Get end milestone - ensure identical dates initially
            if (window.cybereumState && window.cybereumState.endDate) {
                this.state.originalEndDate = new Date(window.cybereumState.endDate);
                this.state.projectedEndDate = new Date(window.cybereumState.endDate);
                console.log("Initial end date set to:", this.state.originalEndDate);
            } else {
                console.warn("No end date found in global state");
                // Set to a default if not found
                const today = window.cybereumState.dataDate || new Date();
                this.state.originalEndDate = new Date(today.setMonth(today.getMonth() + 3)); // 3 months from now
                this.state.projectedEndDate = new Date(this.state.originalEndDate);
            }

            // Create and render interface
            this.renderInterface();

            // Set up cache for AI feedback
            if (!window.cybereumCache) {
                window.cybereumCache = { aiFeedback: {} };
            }

            // Attach event handlers
            this.attachEventHandlers();

            // Load AI feedback for all tasks
            this.loadAllAIFeedback();
        },
        /**
         * Clean up all resources when optimizer is destroyed
         * Call this when switching projects or unmounting the optimizer
         */
        /**
         * Complete cleanup with event listener removal
         */
        destroy() {
            console.log('[ScheduleOptimizer] Starting complete cleanup...');

            // 1. Remove ALL event listeners (CRITICAL!)
            // Note: Event listeners are cleaned up when DOM elements are removed below
            console.log('[ScheduleOptimizer] Event listeners cleaned up with DOM removal');

            // 2. Clear all state Maps and Sets
            this.state.originalDurations.clear();
            this.state.resourceChanges.clear();
            this.state.taskRates.clear();
            this.state.criticalTasks.clear();
            this.state.outlierTasks.clear();
            this.state.impactScores.clear();
            this.state.isLoadingFeedback.clear();

            // 3. Clear arrays
            this.state.pathInfo.critical = [];
            this.state.pathInfo.outlier = [];

            // 4. Clear dates
            this.state.originalEndDate = null;
            this.state.projectedEndDate = null;
            this.state.controllingPath = null;
            this.state.controllingPathType = null;

            // 5. Clear cache
            if (this._impactCache) {
                const cacheSize = this._impactCache.size;
                this._impactCache.clear();
                this._impactCache = null;
                console.log(`[ScheduleOptimizer] Cleared impact cache (${cacheSize} entries)`);
            }

            // 6. Clear AI feedback cache
            if (window.cybereumCache && window.cybereumCache.aiFeedback) {
                let cleared = 0;
                Object.keys(window.cybereumCache.aiFeedback).forEach(key => {
                    if (key.includes('optimization')) {
                        delete window.cybereumCache.aiFeedback[key];
                        cleared++;
                    }
                });
                if (cleared > 0) {
                    console.log(`[ScheduleOptimizer] Cleared ${cleared} AI feedback cache entries`);
                }
            }

            // 7. Clear timers
            if (this._heavyUIUpdateTimer) {
                clearTimeout(this._heavyUIUpdateTimer);
                this._heavyUIUpdateTimer = null;
            }
            if (this._summaryUpdateTimer) {
                clearTimeout(this._summaryUpdateTimer);
                this._summaryUpdateTimer = null;
            }

            // 8. Remove DOM elements
            if (this.container) {
                if (this.container.parentNode) {
                    this.container.parentNode.removeChild(this.container);
                }
                this.container = null;
            }

            // 9. Remove from global reference
            if (window.scheduleOptimizer === this) {
                window.scheduleOptimizer = null;
            }

            console.log('[ScheduleOptimizer] Complete cleanup finished ✓');
        },

        /**
         * Extract path information from cybereumState
         * Stores critical and near-critical paths for analysis
         */

        extractPathInformation() {
            console.log(`calculatePathDuration Optimization`);
            // Process critical paths
            const criticalPaths = window.cybereumState?.criticalPathResult?.paths || [];
            this.state.pathInfo.critical = criticalPaths.map((path, index) => {
                // Extract all node IDs
                const nodeIds = path.map(node => node.ID);

                // Calculate path duration
                const duration = calculatePathDuration(
                    path,
                    window.cybereumState.nodeMap,
                    window.cybereumState.succMap,
                    window.cybereumState.predMap
                );

                // Convert to days
                const teamCalendar = window.cybereumState.teamCalendar || {
                    hoursPerDay: DEFAULT_HOURS_PER_DAY || 8
                };
                const hoursPerDay = teamCalendar.hoursPerDay || 8;
                const durationDays = Math.round(duration / hoursPerDay);

                return {
                    index: index + 1,
                    nodes: nodeIds,
                    duration: durationDays
                };
            });

            // Process outlier (near-critical) paths
            const outlierPaths = window.cybereumState?.outlierPathsResult?.paths || [];
            this.state.pathInfo.outlier = outlierPaths.map((path, index) => {
                // Extract all node IDs
                const nodeIds = path.map(node => node.ID);

                // Calculate path duration
                const duration = calculatePathDuration(
                    path,
                    window.cybereumState.nodeMap,
                    window.cybereumState.succMap,
                    window.cybereumState.predMap
                );

                // Convert to days
                const teamCalendar = window.cybereumState.teamCalendar || {
                    hoursPerDay: DEFAULT_HOURS_PER_DAY || 8
                };
                const hoursPerDay = teamCalendar.hoursPerDay || 8;
                const durationDays = Math.round(duration / hoursPerDay);

                return {
                    index: index + 1,
                    nodes: nodeIds,
                    duration: durationDays
                };
            });

            console.log("Extracted path information:", {
                criticalPaths: this.state.pathInfo.critical,
                outlierPaths: this.state.pathInfo.outlier
            });
        },

        /**
         * Calculate impact scores for all activities
         * Considers risk, importance, critical path status, and completion
         */
        calculateImpactScores() {
            // Mark tasks on critical and near-critical paths
            this.state.pathInfo.critical.forEach(pathInfo => {
                pathInfo.nodes.forEach(nodeId => {
                    this.state.criticalTasks.set(nodeId, pathInfo.index);
                });
            });

            this.state.pathInfo.outlier.forEach(pathInfo => {
                pathInfo.nodes.forEach(nodeId => {
                    // Only set if not already on a critical path
                    if (!this.state.criticalTasks.has(nodeId)) {
                        this.state.outlierTasks.set(nodeId, pathInfo.index);
                    }
                });
            });

            nodes.forEach(node => {
                let score = 0;
                // Base score from risk and importance
                score += (node.riskScore || 0) * 0.3;
                score += (node.importanceScore || 0) * 0.3;

                // Critical path bonus
                if (this.state.criticalTasks.has(node.ID)) {
                    score += 0.2;
                }

                // Outlier path consideration
                if (this.state.outlierTasks.has(node.ID)) {
                    score += 0.1;
                }

                // Remaining work consideration
                const remainingWork = 1 - (node.PercentComplete || 0) / 100;
                score *= remainingWork;

                this.state.impactScores.set(node.ID, score);
            });
        },

        /**
         * Get tasks that can be optimized by adding resources
         */
        getOptimizableTasks() {
            return nodes
                .filter(node => {
                    // Filter conditions for optimizable tasks
                    const isOptimizable =
                        (node.PercentComplete || 0) < 100 && // Not completed
                        (this.state.impactScores.get(node.ID) > 0.1) && // Significant impact
                        !node.isResourceConstrained; // Can add resources

                    return isOptimizable;
                })
                .sort((a, b) =>
                    this.state.impactScores.get(b.ID) - this.state.impactScores.get(a.ID)
                );
        },

        /**
         * Calculate schedule impact of adding resources to a task
         * Uses enhanced diminishing returns model considering completion percentage
         */
        // Add caching to schedule impact calculation
        calculateScheduleImpact(nodeId, resourceChange) {
            // Early exit if no impact
            if (resourceChange <= 0) return 0;

            // Create a cache key
            const cacheKey = `${nodeId}|${resourceChange}`;

            // Check cache first
            if (!this._impactCache) this._impactCache = new Map();

            // Add size limit
            const MAX_CACHE_SIZE = 1000;
            if (this._impactCache.size >= MAX_CACHE_SIZE) {
                // Clear oldest 30% of entries
                const toClear = Math.floor(MAX_CACHE_SIZE * 0.3);
                const keysToDelete = Array.from(this._impactCache.keys()).slice(0, toClear);
                keysToDelete.forEach(k => this._impactCache.delete(k));
            }

            if (this._impactCache.has(cacheKey)) {
                return this._impactCache.get(cacheKey);
            }

            // Original calculation logic...
            const node = nodes.find(n => n.ID === nodeId);
            if (!node) {
                console.warn(`Node ${nodeId} not found when calculating schedule impact`);
                return 0;
            }

            const originalData = this.state.originalDurations.get(nodeId);
            if (!originalData) {
                console.warn(`Original duration data not found for node ${nodeId}`);
                return 0;
            }

            const originalDuration = originalData.duration;
            const originalResources = originalData.resources || 1;
            const percentComplete = node.PercentComplete || 0;

            // Use shared utility function for resource-duration calculation
            const newDuration = window.scheduleUtils.calculateResourceAdjustedDuration(
                originalDuration,
                originalResources,
                resourceChange,
                percentComplete,
                {
                    complexity: node.riskScore || 0.5
                }
            );

            const reduction = originalDuration - newDuration;

            // Cache the result
            this._impactCache.set(cacheKey, Math.max(0, reduction));

            // Ensure we don't return negative reductions
            return Math.max(0, reduction);
        },

        /**
 * Recalculate project dates based on resource changes
 * Uses network-based approach with verification from path-based analysis
 * Handles all relationship types (FS, SS, FF, SF) correctly
 * 
 * @returns {Array} - Updated nodes with recalculated dates
 */
        recalculateProjectDates() {
            optLog("Recalculating project dates using path-based approach...");
            optLog("Original end date:", this.state.originalEndDate);

            // Check if there are any resource changes
            let anyChanges = false;
            for (const [nodeId, resourceChange] of this.state.resourceChanges.entries()) {
                if (resourceChange > 0) {
                    anyChanges = true;
                    break;
                }
            }

            // If no resource changes, return original end date and nodes
            if (!anyChanges) {
                optLog("No resource changes to apply, keeping original dates");
                this.state.projectedEndDate = new Date(this.state.originalEndDate);
                // Prevent stale controlling-path data from leaking into other calculations
                this.state.controllingPath = null;
                this.state.controllingPathType = null;
                return nodes;
            }

            // Get optimized paths with their end dates
            const optimizedCriticalPaths = this.getOptimizedPathLengths('critical');
            const optimizedNearCriticalPaths = this.getOptimizedPathLengths('outlier');

            // Find the latest end date from all paths
            let latestEndDate = null;
            let controllingPath = null;
            let controllingPathType = null;

            // Check critical paths
            if (optimizedCriticalPaths.length > 0) {
                controllingPath = optimizedCriticalPaths[0]; // Longest path
                latestEndDate = controllingPath.endDate;
                controllingPathType = 'critical';

                optLog(`Critical path ${controllingPath.index} has end date:`, latestEndDate);
            }

            // Check if any near-critical path has a later end date
            if (optimizedNearCriticalPaths.length > 0) {
                const longestNearCriticalPath = optimizedNearCriticalPaths[0];

                optLog(`Near-critical path ${longestNearCriticalPath.index} has end date:`, longestNearCriticalPath.endDate);

                if (!latestEndDate || (longestNearCriticalPath.endDate && longestNearCriticalPath.endDate > latestEndDate)) {
                    controllingPath = longestNearCriticalPath;
                    latestEndDate = controllingPath.endDate;
                    controllingPathType = 'near-critical';

                    optLog(`Near-critical path ${controllingPath.index} is now controlling the schedule`);
                }
            }

            // Continue with node updates for downstream processing
            // Create a copy of the nodes to work with
            const optimizedNodeMap = new Map();

            // First, copy all original nodes to the optimized map
            nodes.forEach(node => {
                optimizedNodeMap.set(node.ID, { ...node });
            });

            // Apply resource optimizations to node durations
            this.state.resourceChanges.forEach((resourceChange, nodeId) => {
                if (resourceChange <= 0) return;

                const node = optimizedNodeMap.get(nodeId);
                if (!node) {
                    console.warn(`Node ${nodeId} not found in nodes array`);
                    return;
                }

                const originalData = this.state.originalDurations.get(nodeId);
                if (!originalData) {
                    console.warn(`Original duration not found for node ${nodeId}`);
                    return;
                }

                const originalDuration = originalData.duration;
                const originalResources = originalData.resources || 1;
                const percentComplete = node.PercentComplete || 0;

                // Calculate new duration with shared utility function
                const newDuration = calculateDurationWithResources(
                    originalDuration,
                    originalResources,
                    resourceChange,
                    percentComplete,
                    {
                        complexity: node.riskScore || 0.5
                    }
                );

                // Update the node duration in our map
                optimizedNodeMap.set(nodeId, { ...node, Duration: newDuration });

                // Log significant changes
                const reduction = originalDuration - newDuration;
                const reductionPercent = (reduction / originalDuration) * 100;
                if (reductionPercent > 5) {
                    optLog(`Node ${nodeId} (${node.Name}) duration reduced:`, {
                        originalDuration: originalDuration.toFixed(1),
                        percentComplete: `${percentComplete}%`,
                        newDuration: newDuration.toFixed(1),
                        reduction: reduction.toFixed(1),
                        reductionPercent: `${reductionPercent.toFixed(1)}%`
                    });
                }
            });

            // Use or create successor and predecessor maps
            const succMap = window.cybereumState?.succMap || buildSuccessorMap(links, optimizedNodeMap);
            const predMap = window.cybereumState?.predMap || buildPredecessorMap(links, optimizedNodeMap);

            // Calculate early dates for all nodes
            const { earliestStart, earliestFinish } = calculateEarlyDates(
                optimizedNodeMap, succMap, predMap
            );

            // Get team calendar or use default
            const teamCalendar = window.cybereumState.teamCalendar || {
                hoursPerDay: DEFAULT_HOURS_PER_DAY || 8,
                workingDays: [1, 2, 3, 4, 5] // Mon-Fri default
            };

            const startDate = window.cybereumState.startDate;
            if (!startDate) {
                console.error("Start date not found in global state");
                this.state.projectedEndDate = new Date(this.state.originalEndDate);
                return nodes;
            }

            // Use the path-based projected end date if available
            if (latestEndDate) {
                optLog("Using path-based end date:", latestEndDate);
                this.state.projectedEndDate = new Date(latestEndDate);

                // Store controlling path info if needed elsewhere
                this.state.controllingPath = controllingPath;
                this.state.controllingPathType = controllingPathType;
            } else {
                // Fallback to traditional network-based approach if no valid path end dates
                optLog("No valid path end dates, using network-based approach");

                // Find project finish time from end nodes
                let projectFinish = 0;
                optimizedNodeMap.forEach((node, nodeId) => {
                    const successors = succMap.get(nodeId) || [];
                    if (successors.length === 0) {
                        projectFinish = Math.max(projectFinish, earliestFinish.get(nodeId));
                    }
                });

                // Calculate the projected end date
                const projectedEndDate = calculateEndDateWithCalendar(
                    new Date(startDate),
                    projectFinish,
                    teamCalendar
                );

                this.state.projectedEndDate = projectedEndDate;
            }

            optLog("Project end date calculation:", {
                projectedEndDate: this.state.projectedEndDate.toISOString(),
                originalEndDate: this.state.originalEndDate.toISOString(),
                daysDifference: Math.round((this.state.originalEndDate - this.state.projectedEndDate) / (24 * 60 * 60 * 1000))
            });

            // Update node dates for downstream processing
            optimizedNodeMap.forEach((node, nodeId) => {
                const es = earliestStart.get(nodeId);
                if (es !== undefined) {
                    const startTime = addWorkTime(
                        new Date(startDate),
                        es,
                        teamCalendar
                    );
                    node.Start = startTime.toISOString();

                    const ef = earliestFinish.get(nodeId);
                    if (ef !== undefined) {
                        const finishTime = addWorkTime(
                            new Date(startDate),
                            ef,
                            teamCalendar
                        );
                        node.Finish = finishTime.toISOString();
                    } else {
                        // Fallback if EF is undefined
                        const finishTime = addWorkTime(
                            startTime,
                            node.Duration,
                            teamCalendar
                        );
                        node.Finish = finishTime.toISOString();
                    }
                }
            });

            // Return updated nodes for any downstream processing
            return Array.from(optimizedNodeMap.values());
        },

        /**
         * Get original path lengths data for multiple paths
         */
        getOriginalPathLengths(pathType) {
            // Use pre-computed path information if available
            const pathInfo = pathType === 'critical'
                ? this.state.pathInfo.critical
                : this.state.pathInfo.outlier;

            if (pathInfo && pathInfo.length > 0) {
                return pathInfo.map(path => ({
                    path: path.nodes,
                    duration: path.duration,
                    nodes: path.nodes,
                    index: path.index
                }));
            }

            // Fall back to original implementation if path info is not available
            const paths = pathType === 'critical'
                ? (window.cybereumState?.criticalPathResult?.paths || [])
                : (window.cybereumState?.outlierPathsResult?.paths || []);

            if (paths.length === 0) return [];

            // Get team calendar or use default
            const teamCalendar = window.cybereumState.teamCalendar || {
                hoursPerDay: DEFAULT_HOURS_PER_DAY || 8,
                workingDays: [1, 2, 3, 4, 5] // Mon-Fri default
            };
            const hoursPerDay = teamCalendar.hoursPerDay || 8;

            // Calculate original duration for each path
            return paths.map((path, index) => {
                // Use calculatePathDuration from utility functions
                const durationHours = calculatePathDuration(
                    path,
                    window.cybereumState.nodeMap,
                    window.cybereumState.succMap,
                    window.cybereumState.predMap
                );

                // Convert from hours to days
                const durationDays = Math.round(durationHours / hoursPerDay);

                return {
                    path: path,
                    duration: durationDays,
                    nodes: path.map(n => n.ID),
                    index: index + 1 // Add path index
                };
            }).sort((a, b) => b.duration - a.duration); // Sort by duration descending
        },

        /**
         * Get optimized path lengths data for multiple paths
         * Applies resource optimizations to calculate new path durations
         */
        getOptimizedPathLengths(pathType) {
            const originalPaths = this.getOriginalPathLengths(pathType);

            if (originalPaths.length === 0) return [];

            // Check if there are any resource changes
            let anyChanges = false;
            for (const [nodeId, resourceChange] of this.state.resourceChanges.entries()) {
                if (resourceChange > 0) {
                    anyChanges = true;
                    break;
                }
            }

            // If no resource changes, return original paths with no reduction
            if (!anyChanges) {
                return originalPaths.map(pathInfo => ({
                    ...pathInfo,
                    reduction: 0,
                    originalDuration: pathInfo.duration
                }));
            }

            // Get team calendar or use default
            const teamCalendar = window.cybereumState.teamCalendar || {
                hoursPerDay: DEFAULT_HOURS_PER_DAY || 8,
                workingDays: [1, 2, 3, 4, 5] // Mon-Fri default
            };
            const hoursPerDay = teamCalendar.hoursPerDay || 8;

            // Create optimized node map with updated durations
            const optimizedNodeMap = new Map();

            // First, copy all original nodes to the optimized map
            window.cybereumState.nodeMap.forEach((node, id) => {
                optimizedNodeMap.set(id, { ...node });
            });

            // Apply resource optimizations
            this.state.resourceChanges.forEach((resourceChange, nodeId) => {
                if (resourceChange <= 0) return;

                const node = optimizedNodeMap.get(nodeId);
                if (!node) return;

                const originalData = this.state.originalDurations.get(nodeId);
                if (!originalData) return;

                const originalDuration = originalData.duration;
                const originalResources = originalData.resources || 1;
                const percentComplete = node.PercentComplete || 0;

                // Use shared utility function for resource-duration calculation
                const newDuration = calculateDurationWithResources(
                    originalDuration,
                    originalResources,
                    resourceChange,
                    percentComplete,
                    {
                        complexity: node.riskScore || 0.5
                    }
                );

                // Update the node in the map
                optimizedNodeMap.set(nodeId, { ...node, Duration: newDuration });
            });

            // Get project start date
            const startDate = window.cybereumState.startDate;
            if (!startDate) {
                console.warn("No start date found in global state, using current date");
            }

            // Calculate optimized durations for each path
            return originalPaths.map(pathInfo => {
                // Map path to use optimized nodes
                let optimizedPath;

                if (Array.isArray(pathInfo.path)) {
                    // We have node objects
                    optimizedPath = pathInfo.path.map(node => {
                        const nodeId = typeof node === 'object' ? node.ID : node;
                        const optimizedNode = optimizedNodeMap.get(nodeId);
                        return optimizedNode || node;
                    });
                } else {
                    // We have node IDs
                    optimizedPath = pathInfo.nodes.map(nodeId => {
                        return optimizedNodeMap.get(nodeId) ||
                            window.cybereumState.nodeMap.get(nodeId);
                    });
                }

                // Calculate path duration with optimized nodes
                const optimizedDuration = calculatePathDuration(
                    optimizedPath,
                    optimizedNodeMap,
                    window.cybereumState.succMap,
                    window.cybereumState.predMap
                );

                // Convert durations from hours to days based on team calendar
                const optimizedDays = Math.round(optimizedDuration / hoursPerDay);
                const reduction = pathInfo.duration - optimizedDays;

                // Calculate path-specific end date
                const pathEndDate = calculateEndDateWithCalendar(
                    new Date(startDate || window.cybereumState.dataDate || new Date()),
                    optimizedDuration, // Already in hours, don't multiply by hoursPerDay again
                    teamCalendar
                );

                return {
                    path: pathInfo.path,
                    duration: optimizedDays,
                    nodes: pathInfo.nodes,
                    reduction: reduction,
                    originalDuration: pathInfo.duration,
                    index: pathInfo.index,
                    endDate: pathEndDate  // Add path-specific end date
                };
            }).sort((a, b) => b.duration - a.duration); // Sort by duration descending
        },

        /**
         * Generate HTML for multiple path visualizations
         */
        generatePathVisualizationHTML() {
            // Get team calendar or use default
            const teamCalendar = window.cybereumState?.teamCalendar || {
                hoursPerDay: DEFAULT_HOURS_PER_DAY || 8,
                workingDays: [1, 2, 3, 4, 5] // Mon-Fri default
            };
            const hoursPerDay = teamCalendar.hoursPerDay || 8;

            // Get project start date
            const startDate = window.cybereumState?.startDate || window.cybereumState.dataDate || new Date();

            const criticalPaths = this.getOriginalPathLengths('critical');
            const outlierPaths = this.getOriginalPathLengths('outlier');

            const optimizedCriticalPaths = this.getOptimizedPathLengths('critical');
            const optimizedOutlierPaths = this.getOptimizedPathLengths('outlier');

            // Find the maximum duration for all paths
            let maxDuration = 0;
            criticalPaths.forEach(path => {
                maxDuration = Math.max(maxDuration, path.duration);
            });
            outlierPaths.forEach(path => {
                maxDuration = Math.max(maxDuration, path.duration);
            });

            // Determine minimum bar width as 30% of container
            const minBarWidthPercent = 30;

            // HTML for critical paths
            let criticalHTML = `
        <h4>Critical Path${criticalPaths.length > 1 ? 's' : ''}</h4>
        <div class="path-info">Found ${criticalPaths.length} critical path${criticalPaths.length !== 1 ? 's' : ''}</div>
    `;

            criticalPaths.forEach((pathInfo, index) => {
                const optimizedInfo = optimizedCriticalPaths.find(p =>
                    JSON.stringify(p.nodes) === JSON.stringify(pathInfo.nodes));

                // Ensure we don't render optimized if there are no changes
                const hasChanges = optimizedInfo &&
                    (optimizedInfo.duration !== pathInfo.duration ||
                        this.state.resourceChanges.size > 0);

                // Calculate proportional width, with minimum size
                const proportionalWidth = Math.max(
                    minBarWidthPercent,
                    Math.round((pathInfo.duration / maxDuration) * 100)
                );

                // Calculate original path end date
                const pathOriginalEndDate = window.scheduleUtils.calculateCalendarEndDate(
                    startDate,
                    pathInfo.duration * hoursPerDay,
                    teamCalendar
                );

                const originalEndDateStr = window.scheduleUtils.formatCalendarDate(pathOriginalEndDate);

                // If no resource changes or same duration, optimized should match original
                let optimizedWidth, optimizedEndDate, optimizedEndDateStr;

                if (!hasChanges || !optimizedInfo || optimizedInfo.reduction <= 0) {
                    optimizedWidth = proportionalWidth;
                    optimizedEndDate = pathOriginalEndDate;
                    optimizedEndDateStr = originalEndDateStr;
                } else {
                    // Calculate width based on duration ratio but apply to proportionalWidth
                    const ratio = optimizedInfo.duration / pathInfo.duration;
                    optimizedWidth = Math.max(
                        minBarWidthPercent * 0.5, // Ensure a minimum visibility 
                        Math.round(proportionalWidth * ratio)
                    );

                    // Calculate optimized path end date
                    optimizedEndDate = window.scheduleUtils.calculateCalendarEndDate(
                        startDate,
                        optimizedInfo.duration * hoursPerDay,
                        teamCalendar
                    );

                    optimizedEndDateStr = window.scheduleUtils.formatCalendarDate(optimizedEndDate);
                }

                const reductionText = optimizedInfo && optimizedInfo.reduction > 0
                    ? ` (-${optimizedInfo.reduction} days)`
                    : '';

                criticalHTML += `
                    <div class="path-item">
                        <div class="path-label">Critical Path ${pathInfo.index}: ${pathInfo.duration} days</div>
                        <div class="path-bar" style="width: ${proportionalWidth}%;">
                            <span class="path-label">${pathInfo.index} | 
                            Original: ${pathInfo.duration} days</span>
                            <span class="path-end-date">${originalEndDateStr}</span>
                        </div>
                        <div class="path-bar optimized" style="width: ${optimizedWidth}%; background: linear-gradient(to right, var(--cyb-success, #50fa7b), var(--cyb-info, #8be9fd));">
                            <span class="path-label">${pathInfo.index} | 
                            Optimized: ${optimizedInfo ? optimizedInfo.duration : pathInfo.duration} days${reductionText}</span>
                            <span class="path-end-date">${optimizedEndDateStr}</span>
                        </div>
                    </div>
                `;
            });

            // HTML for near-critical paths (similar implementation with end dates)
            // [Code for near-critical paths would be similar to the critical paths above]
            let outlierHTML = `
        <h4>Near-Critical Path${outlierPaths.length > 1 ? 's' : ''}</h4>
        <div class="path-info">Found ${outlierPaths.length} near-critical path${outlierPaths.length !== 1 ? 's' : ''}</div>
    `;

            outlierPaths.forEach((pathInfo, index) => {
                const optimizedInfo = optimizedOutlierPaths.find(p =>
                    JSON.stringify(p.nodes) === JSON.stringify(pathInfo.nodes));

                const proportionalWidth = Math.max(
                    minBarWidthPercent,
                    Math.round((pathInfo.duration / maxDuration) * 100)
                );

                // Calculate original path end date
                const pathOriginalEndDate = window.scheduleUtils.calculateCalendarEndDate(
                    startDate,
                    pathInfo.duration * hoursPerDay,
                    teamCalendar
                );

                const originalEndDateStr = window.scheduleUtils.formatCalendarDate(pathOriginalEndDate);

                // Ensure we don't render optimized if there are no changes
                const hasChanges = optimizedInfo &&
                    (optimizedInfo.duration !== pathInfo.duration ||
                        this.state.resourceChanges.size > 0);

                // If no resource changes or same duration, optimized should match original
                let optimizedWidth, optimizedEndDate, optimizedEndDateStr;

                if (!hasChanges || !optimizedInfo || optimizedInfo.reduction <= 0) {
                    optimizedWidth = proportionalWidth;
                    optimizedEndDate = pathOriginalEndDate;
                    optimizedEndDateStr = originalEndDateStr;
                } else {
                    // Calculate width based on duration ratio
                    const ratio = optimizedInfo.duration / pathInfo.duration;
                    optimizedWidth = Math.max(
                        minBarWidthPercent * 0.5, // Ensure minimum visibility
                        Math.round(proportionalWidth * ratio)
                    );

                    // Calculate optimized path end date
                    optimizedEndDate = window.scheduleUtils.calculateCalendarEndDate(
                        startDate,
                        optimizedInfo.duration * hoursPerDay,
                        teamCalendar
                    );

                    optimizedEndDateStr = window.scheduleUtils.formatCalendarDate(optimizedEndDate);
                }

                const reductionText = optimizedInfo && optimizedInfo.reduction > 0
                    ? ` (-${optimizedInfo.reduction} days)`
                    : '';

                outlierHTML += `
                    <div class="path-item">
                        <div class="path-label">Near-Critical Path ${pathInfo.index}: ${pathInfo.duration} days</div>
                        <div class="path-bar" style="width: ${proportionalWidth}%;">
                            <span class="path-label">${pathInfo.index} | Original: ${pathInfo.duration} days</span>
                            <span class="path-end-date">${originalEndDateStr}</span>
                        </div>
                        <div class="path-bar optimized" style="width: ${optimizedWidth}%; background: linear-gradient(to right, var(--cyb-success, #50fa7b), var(--cyb-info, #8be9fd));">
                            <span class="path-label">${pathInfo.index} | Optimized: ${optimizedInfo ? optimizedInfo.duration : pathInfo.duration} days${reductionText}</span>
                            <span class="path-end-date">${optimizedEndDateStr}</span>
                        </div>
                    </div>
                `;
            });

            // Add CSS for end date display
            const additionalCSS = `
        <style>
            .path-end-date {
                position: absolute;
                right: 10px;
                top: 50%;
                transform: translateY(-50%);
                color: white;
                font-size: 0.85em;
                font-weight: bold;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.7);
                white-space: nowrap;
            }
            
            .path-bar {
                position: relative;
                overflow: hidden;
            }
            
            /* Make sure the path bar can fit the end date */
            .path-bar {
                min-width: 200px;
            }
        </style>
    `;

            return {
                criticalHTML: additionalCSS + criticalHTML,
                outlierHTML
            };
        },

        /**
         * Update the path visualization in the interface
         */
        updatePathVisualization() {
            const { criticalHTML, outlierHTML } = this.generatePathVisualizationHTML();

            // Update critical paths container
            const criticalPathContainer = document.getElementById('criticalPathViz');
            if (criticalPathContainer) {
                criticalPathContainer.innerHTML = criticalHTML;
            }

            // Update outlier paths container
            const outlierPathContainer = document.getElementById('outlierPathsViz');
            if (outlierPathContainer) {
                outlierPathContainer.innerHTML = outlierHTML;
            }
        },

        /**
 * Render the optimization interface with improved layout and usability
 */
        renderInterface() {
            const container = document.createElement('div');
            container.className = 'schedule-optimization-container';

            container.innerHTML = `
        <style>
            .schedule-optimization-container {
                position: relative;
                background: var(--bg-darker);
                border: 1px solid var(--primary);
                border-radius: 8px;
                padding: 20px;
                margin: 20px;
                color: var(--text);
                overflow: visible;
                max-width: 100%;
                font-family: var(--font-rajdhani, 'Rajdhani', sans-serif);
            }

            /* Improved scroll behavior for long content */
            .scrollable-container {
                max-height: 500px;
                overflow-y: auto;
                overflow-x: hidden;
                scrollbar-width: thin;
                scrollbar-color: var(--primary) rgba(14, 36, 70, 0.3);
                padding-right: 5px;
                margin-bottom: 15px;
                border-radius: 6px;
            }

            .scrollable-container::-webkit-scrollbar {
                width: 8px;
            }

            .scrollable-container::-webkit-scrollbar-track {
                background: rgba(14, 36, 70, 0.3);
                border-radius: 6px;
            }

            .scrollable-container::-webkit-scrollbar-thumb {
                background-color: var(--primary);
                border-radius: 6px;
            }

            /* Fix for sticky summary */
            .sticky-summary-wrapper {
                position: sticky;
                top: 0;
                z-index: 100;
                background: var(--bg-darker);
                padding: 10px 0;
                margin: -10px 0 15px 0;
            }

            .sticky-summary {
                background: rgba(90, 200, 250, 0.1);
                border: 1px solid var(--primary);
                border-radius: 8px;
                padding: 12px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                box-shadow: 0 2px 5px rgba(0,0,0,0.1);
                flex-wrap: wrap;
                gap: 8px;
            }

            .sticky-summary-item {
                display: flex;
                flex-direction: column;
                align-items: center;
                flex: 1;
                min-width: 120px;
                padding: 8px;
                border-radius: 6px;
                transition: background-color 0.2s;
            }

            .sticky-summary-item:hover {
                background: rgba(90, 200, 250, 0.05);
            }

            .sticky-summary-label {
                font-size: 0.8em;
                color: var(--text);
                opacity: 0.7;
                margin-bottom: 5px;
            }

            .sticky-summary-value {
                font-weight: bold;
                font-size: 1.1em;
            }

            .optimization-table-container {
                max-height: 600px;
                overflow-y: auto;
                overflow-x: auto;
                margin-top: 15px;
                border-radius: 6px;
                border: 1px solid rgba(90, 200, 250, 0.2);
                scrollbar-width: thin;
                scrollbar-color: var(--primary) rgba(14, 36, 70, 0.3);
            }

            .optimization-table-container::-webkit-scrollbar {
                width: 8px;
                height: 8px;
            }

            .optimization-table-container::-webkit-scrollbar-track {
                background: rgba(14, 36, 70, 0.3);
                border-radius: 6px;
            }

            .optimization-table-container::-webkit-scrollbar-thumb {
                background-color: var(--primary);
                border-radius: 6px;
            }

            .optimization-table {
                width: 100%;
                border-collapse: collapse;
            }

            .optimization-table thead {
                position: sticky;
                top: 0;
                background: var(--bg-darker);
                z-index: 10;
            }

            .optimization-table thead th {
                padding: 12px 8px;
                border-bottom: 2px solid var(--primary);
                white-space: nowrap;
                font-weight: 600;
                text-align: left;
                min-width: 100px;
            }

            .optimization-table tbody tr:hover {
                background: rgba(90, 200, 250, 0.05);
            }

            .task-name-cell {
                min-width: 200px;
                max-width: 300px;
                position: sticky;
                left: 0;
                background: var(--bg-darker);
                z-index: 5;
            }

            .path-tags-container {
                display: flex;
                flex-wrap: nowrap;
                overflow-x: auto;
                gap: 4px;
                margin-top: 5px;
                padding: 3px 0;
                max-width: 300px;
            }

            .optimization-table td {
                padding: 12px 8px;
                vertical-align: middle;
                border-bottom: 1px solid rgba(90, 200, 250, 0.1);
            }

            .ai-feedback {
                min-width: 200px;
                max-width: 250px;
            }

            .resource-control {
                display: flex;
                align-items: center;
                gap: 10px;
            }

           .resource-slider {
                width: 100px;
                background: rgba(90, 200, 250, 0.15);
                appearance: none;
                height: 6px;
                border-radius: 3px;
                outline: none;
                border: 1px solid rgba(90, 200, 250, 0.3);
            }

            .resource-slider::-webkit-slider-thumb {
                appearance: none;
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: var(--bright, #8ce6ff);
                cursor: pointer;
                transition: all 0.2s;
                box-shadow: 0 0 5px rgba(140, 230, 255, 0.5);
            }

            .resource-slider::-webkit-slider-thumb:hover {
                background: #b3f0ff;
                transform: scale(1.1);
                box-shadow: 0 0 8px rgba(140, 230, 255, 0.7);
            }

            .resource-slider::-moz-range-thumb {
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: var(--bright, #8ce6ff);
                cursor: pointer;
                transition: all 0.2s;
                border: none;
                box-shadow: 0 0 5px rgba(140, 230, 255, 0.5);
            }

            .resource-slider::-moz-range-thumb:hover {
                background: #b3f0ff;
                transform: scale(1.1);
                box-shadow: 0 0 8px rgba(140, 230, 255, 0.7);
            }

            /* Improved scoring color indicators */
            .impact-high { color: var(--cyb-success, #50fa7b); font-weight: bold; }
            .impact-medium { color: var(--cyb-warning, #ffb86c); font-weight: bold; }
            .impact-low { color: var(--cyb-danger, #ff5555); font-weight: bold; }
            
            .critical-tag {
                color: var(--cyb-danger, #ff5555);
                font-weight: bold;
                margin-left: 6px;
            }
            
            .near-critical-tag {
                color: var(--cyb-warning, #ffb86c);
                font-weight: bold;
                margin-left: 6px;
            }
            
            .path-tag {
                display: inline-block;
                padding: 2px 6px;
                border-radius: 12px;
                font-size: 11px;
                margin-left: 4px;
                white-space: nowrap;
                transition: all 0.2s;
            }
            
            .path-tag:hover {
                transform: scale(1.05);
                box-shadow: 0 0 5px rgba(90, 200, 250, 0.5);
            }
            
            .critical-path-tag {
                background: rgba(255, 85, 85, 0.2);
                border: 1px solid var(--cyb-danger, #ff5555);
            }
            
            .near-critical-tag {
                background: rgba(255, 184, 108, 0.2);
                border: 1px solid var(--cyb-warning, #ffb86c);
            }

            /* Improved card-like sections */
            .card-section {
                margin-top: 25px;
                padding: 15px;
                background: rgba(90, 200, 250, 0.05);
                border-radius: 8px;
                border: 1px solid rgba(90, 200, 250, 0.2);
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
                transition: all 0.3s;
            }

            .card-section:hover {
                box-shadow: 0 4px 15px rgba(90, 200, 250, 0.15);
            }

            .card-section h3 {
                margin-top: 0;
                color: var(--bright);
                border-bottom: 1px solid rgba(90, 200, 250, 0.2);
                padding-bottom: 10px;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .card-section h3 i {
                font-size: 0.9em;
                opacity: 0.8;
            }
            
            .summary-note {
                margin-bottom: 15px;
                padding: 12px;
                border-left: 3px solid var(--primary);
                background: rgba(90, 200, 250, 0.05);
                border-radius: 0 4px 4px 0;
            }
            
            .summary-grid {
                display: grid;
                grid-template-columns: 1fr;
                gap: 10px;
            }
            
            .summary-row {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
                align-items: center;
                padding: 8px 0;
                border-bottom: 1px solid rgba(90, 200, 250, 0.1);
            }
            
            .summary-label {
                font-weight: bold;
            }
            
            /* Improved project end date section */
            .project-end-date {
                font-size: 1.1em;
                padding: 20px;
                margin: 20px 0;
                border: 2px solid var(--primary);
                border-radius: 10px;
                background: rgba(90, 200, 250, 0.1);
                text-align: center;
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 15px;
                align-items: center;
                box-shadow: 0 0 15px rgba(90, 200, 250, 0.1);
            }

            .date-box {
                padding: 10px;
                border-radius: 8px;
                background: rgba(14, 36, 70, 0.5);
            }

            .date-label {
                font-size: 0.8em;
                opacity: 0.7;
                margin-bottom: 5px;
            }

            .date-value {
                font-weight: bold;
                font-size: 1.2em;
            }
            
            /* Improved path visualization section */
            .path-visualization-container {
                overflow-x: auto;
                overflow-y: auto;
                max-height: 400px;
                padding-bottom: 10px;
                margin-bottom: 15px;
                scrollbar-width: thin;
                scrollbar-color: var(--primary) rgba(14, 36, 70, 0.3);
            }
            
            .path-visualization-container::-webkit-scrollbar {
                width: 8px;
                height: 8px;
            }
            
            .path-visualization-container::-webkit-scrollbar-track {
                background: rgba(14, 36, 70, 0.3);
                border-radius: 6px;
            }
            
            .path-visualization-container::-webkit-scrollbar-thumb {
                background-color: var(--primary);
                border-radius: 6px;
            }
            
            .path-info {
                font-size: 0.9em;
                margin-bottom: 15px;
                color: var(--text);
                opacity: 0.8;
                padding: 8px;
                background: rgba(14, 36, 70, 0.3);
                border-radius: 6px;
            }
            
            .path-item {
                margin-bottom: 20px;
                min-width: 500px;
                max-width: 100%;
                position: relative;
                padding: 5px;
                border-radius: 8px;
                transition: all 0.2s;
            }

            .path-item:hover {
                background: rgba(90, 200, 250, 0.05);
            }
            
            /* Fix for path label - keep both path number and duration on same line */
            .path-label {
                font-weight: bold;
                margin-bottom: 5px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                white-space: nowrap;
            }

            .path-label span {
                display: inline-block;
            }

            .path-duration {
                font-size: 0.9em;
                opacity: 0.8;
                margin-left: 10px;
            }
            
            .path-bar {
                height: 30px;
                background: linear-gradient(to right, #ff5555, #ffb86c);
                border-radius: 6px;
                margin-bottom: 10px;
                position: relative;
                transition: width 0.5s ease-in-out;
                overflow: visible;
                box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
            }
            
            .path-bar.optimized {
                background: linear-gradient(to right, var(--cyb-success, #50fa7b), var(--cyb-info, #8be9fd));
            }
            
            .path-bar-label {
                position: absolute;
                left: 10px;
                top: 50%;
                transform: translateY(-50%);
                color: white;
                font-weight: bold;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.7);
                white-space: nowrap;
                z-index: 2;
            }

            .path-end-date {
                position: absolute;
                right: 10px;
                top: 50%;
                transform: translateY(-50%);
                color: white;
                font-size: 0.85em;
                font-weight: bold;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.7);
                background: rgba(0, 0, 0, 0.3);
                padding: 2px 6px;
                border-radius: 4px;
                white-space: nowrap;
                z-index: 2;
            }

            .controlling-path-indicator {
                background-color: rgba(80, 250, 123, 0.2);
                border: 1px solid var(--cyb-success, #50fa7b);
                padding: 2px 6px;
                border-radius: 4px;
                font-weight: bold;
                color: var(--cyb-success, #50fa7b);
                position: absolute;
                right: -25px;
                top: -15px;
                font-size: 10px;
                transform: rotate(15deg);
                z-index: 3;
                box-shadow: 0 0 10px rgba(80, 250, 123, 0.4);
            }
            
            /* Improved button styles */
            .action-buttons {
                display: flex;
                flex-wrap: wrap;
                justify-content: center;
                gap: 15px;
                margin: 20px 0;
            }
            
            .action-button {
                background-color: rgba(14, 36, 70, 0.8);
                border: 2px solid var(--primary);
                color: var(--text);
                padding: 12px 20px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.3s ease;
                font-weight: bold;
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 180px;
                justify-content: center;
            }
            
            .action-button:hover {
                background: var(--primary);
                color: var(--bg-darker);
                box-shadow: var(--glow);
                transform: translateY(-2px);
            }

            .action-button:active {
                transform: translateY(0);
            }
            
            #autoOptimization {
                background-color: rgba(60, 120, 180, 0.8);
                border: 2px solid var(--cyb-info, #8be9fd);
            }
            
            #autoOptimization:hover {
                background: var(--cyb-info, #8be9fd);
                color: var(--bg-darker);
            }
            
            .ai-analysis-button {
                background-color: rgba(14, 36, 70, 0.8);
                border: 1px solid var(--primary);
                color: var(--text);
                padding: 6px 12px;
                border-radius: 4px;
                font-size: 12px;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                transition: all 0.3s ease;
            }
            
            .ai-analysis-button:hover {
                background: var(--primary);
                color: var(--bg-darker);
                box-shadow: var(--glow);
            }
            
            .ai-analysis-button i {
                font-size: 14px;
            }
            
            /* Improved form controls */
            .cost-settings {
                display: flex;
                flex-wrap: wrap;
                gap: 20px;
                margin: 20px 0;
                align-items: center;
                background: rgba(14, 36, 70, 0.3);
                padding: 15px;
                border-radius: 8px;
            }
            
            .settings-group {
                display: flex;
                align-items: center;
                gap: 10px;
                flex: 1;
                min-width: 300px;
            }

            .settings-group label {
                min-width: 140px;
            }
            
            .savings-input {
                padding: 10px;
                border-radius: 6px;
                border: 1px solid var(--primary);
                background: rgba(14, 36, 70, 0.8);
                color: var(--text);
                width: 120px;
                transition: all 0.2s;
            }

            .savings-input:focus {
                border-color: var(--bright);
                box-shadow: 0 0 8px rgba(90, 200, 250, 0.4);
                outline: none;
            }
            
            .task-rate {
                width: 80px;
                padding: 6px;
                height: 28px;
                border-radius: 4px;
                border: 1px solid var(--primary);
                background: rgba(14, 36, 70, 0.8);
                color: var(--text);
                transition: all 0.2s;
            }

            .task-rate:focus {
                border-color: var(--bright);
                box-shadow: 0 0 8px rgba(90, 200, 250, 0.4);
                outline: none;
            }
            
            /* Status indicators */
            .time-savings-positive {
                color: var(--cyb-success, #50fa7b);
                font-weight: bold;
            }
            
            .time-savings-negative {
                color: var(--cyb-danger, #ff5555);
                font-weight: bold;
            }
            
            .positive-value {
                color: var(--cyb-success, #50fa7b);
                font-weight: bold;
            }
            
            .negative-value {
                color: var(--cyb-danger, #ff5555);
                font-weight: bold;
            }

            /* AI feedback improvements */
            .ai-feedback {
                font-size: 12px;
                max-width: 150px;
                padding: 5px;
                border-radius: 4px;
                transition: all 0.2s;
            }

            .ai-feedback:hover {
                background: rgba(90, 200, 250, 0.05);
            }

            .ai-feedback ul {
                margin: 0;
                padding-left: 15px;
            }

            .loading-feedback {
                color: var(--cyb-info, #8be9fd);
                font-style: italic;
                display: flex;
                align-items: center;
                gap: 5px;
            }

            .loading-feedback::after {
                content: "";
                width: 12px;
                height: 12px;
                border: 2px solid transparent;
                border-top-color: var(--cyb-info, #8be9fd);
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }

            @keyframes spin {
                to { transform: rotate(360deg); }
            }

            .resource-type {
                display: inline-block;
                margin: 2px;
                padding: 2px 6px;
                border-radius: 12px;
                font-size: 11px;
                background: rgba(80, 250, 123, 0.2);
                border: 1px solid var(--cyb-success, #50fa7b);
                transition: all 0.2s;
            }

            .resource-type:hover {
                background: rgba(80, 250, 123, 0.3);
                transform: scale(1.05);
            }

            .key-insight {
                margin-bottom: 6px;
                padding-left: 5px;
                border-left: 2px solid var(--cyb-info, #8be9fd);
                transition: all 0.2s;
            }

            .key-insight:hover {
                background: rgba(139, 233, 253, 0.05);
                border-left-width: 3px;
            }
            
            /* Project sector info */
            .sector-info {
                margin-bottom: 15px;
                padding: 12px 15px;
                background: rgba(90, 200, 250, 0.1);
                border-radius: 6px;
                font-weight: bold;
                display: flex;
                align-items: center;
                gap: 10px;
                border-left: 4px solid var(--primary);
            }

            .sector-info::before {
                content: "🏗️";
                font-size: 1.2em;
            }
            
            /* Target optimization styles */
            .target-optimization-section {
                background: rgba(90, 200, 250, 0.05);
                border-radius: 8px;
                padding: 20px;
                margin-bottom: 25px;
                border: 1px solid rgba(90, 200, 250, 0.2);
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            }

            .target-optimization-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
                border-bottom: 1px solid rgba(90, 200, 250, 0.2);
                padding-bottom: 10px;
            }

            .target-optimization-title {
                font-size: 1.2em;
                font-weight: bold;
                color: var(--bright);
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .target-optimization-title::before {
                content: "🎯";
            }

            .target-options {
                display: flex;
                flex-wrap: wrap;
                gap: 20px;
                margin-bottom: 20px;
            }

            .target-option-group {
                display: flex;
                align-items: center;
                gap: 10px;
                flex: 1;
                min-width: 300px;
                padding: 10px;
                background: rgba(14, 36, 70, 0.3);
                border-radius: 6px;
            }

            .target-input {
                width: 100px;
                padding: 10px;
                border-radius: 6px;
                border: 1px solid var(--primary);
                background: rgba(14, 36, 70, 0.8);
                color: var(--text);
                transition: all 0.2s;
            }

            .target-input:focus {
                border-color: var(--bright);
                box-shadow: 0 0 8px rgba(90, 200, 250, 0.4);
                outline: none;
            }

            .date-input {
                width: 150px;
            }

            .target-optimization-actions {
                display: flex;
                justify-content: center;
                gap: 15px;
                margin-top: 20px;
            }

            .target-results {
                margin-top: 20px;
                padding: 15px;
                background: rgba(80, 250, 123, 0.05);
                border-radius: 8px;
                border: 1px solid rgba(80, 250, 123, 0.2);
                display: none;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            }

            .target-results h4 {
                margin-top: 0;
                color: var(--cyb-success, #50fa7b);
                margin-bottom: 15px;
                border-bottom: 1px solid rgba(80, 250, 123, 0.2);
                padding-bottom: 10px;
            }

            .target-result-summary {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 15px;
                margin-bottom: 20px;
            }

            .target-result-item {
                padding: 15px;
                background: rgba(14, 36, 70, 0.5);
                border-radius: 6px;
                text-align: center;
                border: 1px solid rgba(80, 250, 123, 0.1);
                box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
            }

            .target-result-label {
                font-size: 0.9em;
                opacity: 0.7;
                margin-bottom: 8px;
            }

            .target-result-value {
                font-size: 1.3em;
                font-weight: bold;
                color: var(--cyb-success, #50fa7b);
            }

            /* Improved mode selector with tooltip info */
            .optimization-mode-selector {
                display: flex;
                justify-content: center;
                gap: 15px;
                margin: 20px 0;
            }

            .optimization-mode {
                padding: 10px 20px;
                border-radius: 30px;
                cursor: pointer;
                border: 1px solid rgba(90, 200, 250, 0.3);
                transition: all 0.3s ease;
                font-weight: bold;
                display: flex;
                align-items: center;
                gap: 8px;
                position: relative;
            }

            .optimization-mode::after {
                content: "ⓘ";
                font-size: 0.8em;
                opacity: 0.7;
                margin-left: 5px;
            }

            .optimization-mode:hover::before {
                content: attr(data-tooltip);
                position: absolute;
                bottom: 100%;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(14, 36, 70, 0.9);
                padding: 8px 12px;
                border-radius: 6px;
                font-size: 0.8em;
                white-space: nowrap;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
                border: 1px solid var(--primary);
                opacity: 0;
                animation: fade-in 0.3s forwards;
                pointer-events: none;
                z-index: 100;
                width: max-content;
                max-width: 300px;
            }

            @keyframes fade-in {
                to { opacity: 1; }
            }

            .optimization-mode.active {
                background: rgba(90, 200, 250, 0.2);
                border-color: var(--primary);
                color: var(--bright);
                box-shadow: 0 0 10px rgba(90, 200, 250, 0.3);
            }

            .section-title {
                font-size: 1.8em;
                color: var(--bright);
                margin-top: 0;
                margin-bottom: 15px;
                text-shadow: 0 0 10px rgba(90, 200, 250, 0.5);
                display: flex;
                align-items: center;
                gap: 10px;
                border-bottom: 1px solid rgba(90, 200, 250, 0.2);
                padding-bottom: 10px;
            }

            .section-title::before {
                content: "⚡";
            }

            .tooltip-icon {
                cursor: help;
                color: var(--primary);
                font-size: 0.8em;
                position: relative;
                margin-left: 5px;
            }

            .tooltip-icon:hover::after {
                content: attr(data-tooltip);
                position: absolute;
                bottom: 100%;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(14, 36, 70, 0.9);
                padding: 8px 12px;
                border-radius: 6px;
                font-size: 0.8em;
                white-space: normal;
                width: 200px;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
                border: 1px solid var(--primary);
                z-index: 100;
            }

            @media (max-width: 768px) {
                .project-end-date {
                    grid-template-columns: 1fr;
                }

                .settings-group {
                    flex-direction: column;
                    align-items: flex-start;
                }

                .sticky-summary {
                    flex-direction: column;
                }
            }
        </style>

        <h2 class="section-title">Schedule Optimization Analysis</h2>
        
        <div class="sector-info">
            Project Sector: ${this.state.projectSegment}
        </div>
        
        <div class="project-end-date">
            <div class="date-box">
                <div class="date-label">Original Project End Date</div>
                <div class="date-value">${this.formatDate(this.state.originalEndDate)}</div>
            </div>
            
            <div class="date-box">
                <div class="date-label">Projected End Date After Optimization</div>
                <div class="date-value" id="projectedEndDate">${this.formatDate(this.state.projectedEndDate)}</div>
            </div>
            
            <div class="date-box">
                <div class="date-label">Potential Time Savings</div>
                <div class="date-value" id="timeSavings">0 days</div>
            </div>
        </div>
        
        <div class="cost-settings">
            <div class="settings-group">
                <label for="resourceRate">Default Resource Cost Rate (${this.state.currency}/hour):</label>
                <input type="number" id="resourceRate" class="savings-input" value="${this.state.resourceRate}" min="0" step="10">
                <span class="tooltip-icon" data-tooltip="Default hourly cost rate for additional resources applied to tasks. This will be used when no specific rate is provided for a task.">ⓘ</span>
            </div>
            
            <div class="settings-group">
                <label for="dailySavings">Cost Savings Per Day of Earlier Completion (${this.state.currency}):</label>
                <input type="number" id="dailySavings" class="savings-input" value="${this.state.dailySavings}" min="0" step="100">
                <span class="tooltip-icon" data-tooltip="The dollar value saved for each day the project completes earlier. This represents indirect cost savings, reduced overhead, or earlier revenue realization.">ⓘ</span>
            </div>
        </div>

        <!-- Optimization Mode Selector with tooltips -->
        <div class="optimization-mode-selector">
            <div class="optimization-mode active" data-mode="manual" data-tooltip="Manually adjust resources for individual tasks to optimize the schedule incrementally.">
                <i class="fas fa-sliders-h"></i> Manual Optimization
            </div>
            <div class="optimization-mode" data-mode="target" data-tooltip="Set a target completion date or duration reduction, and the system will find the optimal resource allocation to meet your goal.">
                <i class="fas fa-bullseye"></i> Target-Based Optimization
            </div>
        </div>

        <!-- Target-Based Optimization Section -->
        <div class="target-optimization-section" id="targetOptimizationSection" style="display: none;">
            <div class="target-optimization-header">
                <div class="target-optimization-title">Optimize Schedule to Target</div>
            </div>
    
            <div class="target-options">
                <div class="target-option-group">
                    <input type="radio" id="targetTypeReduction" name="targetType" value="reduction" checked>
                    <label for="targetTypeReduction">Reduce Schedule By:</label>
                    <input type="number" id="targetReduction" class="target-input" value="5" min="1" max="60"> days
                    <span class="tooltip-icon" data-tooltip="Number of days to reduce the project schedule by. The optimizer will search for the most cost-effective way to achieve this reduction.">ⓘ</span>
                </div>
        
                <div class="target-option-group">
                    <input type="radio" id="targetTypeDate" name="targetType" value="date">
                    <label for="targetTypeDate">Complete By Date:</label>
                    <input type="date" id="targetDate" class="target-input date-input">
                    <span class="tooltip-icon" data-tooltip="Target completion date for the project. The system will find the optimal resource allocation to meet this date.">ⓘ</span>
                </div>
            </div>
    
            <div class="target-options">
                <div class="target-option-group">
                    <input type="checkbox" id="minimizeCost" checked>
                    <label for="minimizeCost">Minimize Cost</label>
                    <span class="tooltip-icon" data-tooltip="When selected, the optimizer will prioritize finding the least expensive solution to meet your target. When unchecked, it will find the solution with the greatest time savings.">ⓘ</span>
                </div>
        
                <div class="target-option-group">
                    <label for="maxTaskResources">Maximum Resources Per Task:</label>
                    <input type="number" id="maxTaskResources" class="target-input" value="3" min="1" max="10">
                    <span class="tooltip-icon" data-tooltip="Maximum number of additional resources that can be applied to any single task. Limits resource stacking to prevent unrealistic allocations.">ⓘ</span>
                </div>
            </div>
    
            <div class="target-optimization-actions">
                <button class="action-button" id="runTargetOptimization">
                    <i class="fas fa-magic"></i> Find Optimal Solution
                </button>
                <button class="action-button" id="resetTargetOptimization">
                    <i class="fas fa-undo"></i> Reset
                </button>
            </div>

            <div class="target-results" id="targetResults">
                <h4>Optimization Results</h4>
        
                <div class="target-result-summary">
                    <div class="target-result-item">
                        <div class="target-result-label">Schedule Reduction</div>
                        <div class="target-result-value" id="targetResultReduction">0 days</div>
                    </div>
                    <div class="target-result-item">
                        <div class="target-result-label">Resource Cost</div>
                        <div class="target-result-value" id="targetResultCost">$0</div>
                    </div>
                    <div class="target-result-item">
                        <div class="target-result-label">New Completion Date</div>
                        <div class="target-result-value" id="targetResultDate">Not calculated</div>
                    </div>
                </div>
        
                <div class="summary-note">
                    <strong>Solution Summary:</strong> <span id="targetResultSummary">No optimization performed yet.</span>
                </div>
            </div>
        </div>
        
        <div class="sticky-summary-wrapper">
            <div class="sticky-summary">
                <div class="sticky-summary-item">
                    <div class="sticky-summary-label">Original Duration</div>
                    <div class="sticky-summary-value" id="stickySummaryOriginalDuration">N/A</div>
                </div>
                <div class="sticky-summary-item">
                    <div class="sticky-summary-label">Projected Duration</div>
                    <div class="sticky-summary-value" id="stickySummaryProjectedDuration">N/A</div>
                </div>
                <div class="sticky-summary-item">
                    <div class="sticky-summary-label">Time Savings</div>
                    <div class="sticky-summary-value" id="stickySummaryTimeSavings">0 days</div>
                </div>
                <div class="sticky-summary-item">
                    <div class="sticky-summary-label">Resource Cost</div>
                    <div class="sticky-summary-value" id="stickySummaryResourceCost">N/A</div>
                </div>
                <div class="sticky-summary-item">
                    <div class="sticky-summary-label">Net Benefit</div>
                    <div class="sticky-summary-value" id="stickySummaryNetBenefit">N/A</div>
                </div>
            </div>
        </div>

        <!-- Main action buttons moved above the cards -->
        <div class="action-buttons">
            <button class="action-button" id="resetOptimization">
                <i class="fas fa-undo-alt"></i> Reset All Changes
            </button>
            <button class="action-button" id="autoOptimization">
                <i class="fas fa-magic"></i> Run Auto-Optimization
            </button>
            <button class="action-button" id="applyOptimization">
                <i class="fas fa-check-circle"></i> Apply Optimization Changes
            </button>
        </div>
        
        <div class="card-section">
            <h3><i class="fas fa-project-diagram"></i> Project Path Visualization</h3>
            <p>See how optimization affects critical and near-critical paths:</p>
            
            <div id="criticalPathViz" class="path-visualization-container">
                ${this.generatePathVisualizationHTML().criticalHTML}
            </div>
            
            <div id="outlierPathsViz" class="path-visualization-container">
                ${this.generatePathVisualizationHTML().outlierHTML}
            </div>
        </div>
        
        <div class="card-section">
            <h3><i class="fas fa-tasks"></i> Task Optimization Controls</h3>
            <p>Adjust resources for individual tasks to optimize the schedule:</p>
            
            <div class="optimization-table-container">
                <table class="optimization-table">
                    <thead>
                        <tr>
                            <th>Task</th>
                            <th>Current Duration</th>
                            <th>Current Resources</th>
                            <th>Impact Score 
                                <span class="tooltip-icon" data-tooltip="Combined score showing how impactful optimizing this task would be to the overall schedule, based on risk, importance, and critical path status.">ⓘ</span>
                            </th>
                            <th>Add Resources 
                                <span class="tooltip-icon" data-tooltip="Number of additional resources to add to this task. More resources typically reduce duration, but with diminishing returns.">ⓘ</span>
                            </th>
                            <th>Cost Rate<br><small>(${this.state.currency}/hour)</small></th>
                            <th>Duration Saving</th>
                            <th>Resource Cost</th>
                            <th>Value Ratio 
                                <span class="tooltip-icon" data-tooltip="The ratio of time savings value to resource cost. Higher values indicate better return on investment.">ⓘ</span>
                            </th>
                            <th>Recommended Resources</th>
                            <th>Key Insights</th>
                            <th>AI Analysis</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${this.generateTableRows()}
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="card-section">
            <h3><i class="fas fa-chart-line"></i> Optimization Summary</h3>
            <div id="optimizationSummary">
                ${this.generateSummary()}
            </div>
        </div>
    `;

            const targetElement = document.getElementById('scheduleOptimizationContainer');
            if (targetElement) {
                targetElement.innerHTML = '';
                targetElement.appendChild(container);
            }
        },

        formatDate(date) {
            if (!date) return 'N/A';
            return date.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
        },

        /**
         * Generate HTML for table rows in the optimization table
         */
        generateTableRows() {
            return this.getOptimizableTasks()
                .map(task => {
                    const impactScore = this.state.impactScores.get(task.ID);
                    const impactClass = impactScore > 0.7 ? 'impact-high' :
                        impactScore > 0.4 ? 'impact-medium' :
                            'impact-low';

                    const originalResources = this.state.originalDurations.get(task.ID).resources;
                    const timeUnits = task.TimeUnits || 'days';
                    const taskRate = this.state.taskRates.get(task.ID) || this.state.resourceRate;

                    // Collect all path tags for this task
                    const pathTags = [];

                    // Critical paths
                    this.state.pathInfo.critical.forEach((pathInfo, index) => {
                        if (pathInfo.nodes.includes(task.ID)) {
                            pathTags.push(`<span class="path-tag critical-path-tag" title="Critical Path ${pathInfo.index}">CP ${pathInfo.index}</span>`);
                        }
                    });

                    // Outlier paths
                    this.state.pathInfo.outlier.forEach((pathInfo, index) => {
                        if (pathInfo.nodes.includes(task.ID) &&
                            !this.state.criticalTasks.has(task.ID)) {
                            pathTags.push(`<span class="path-tag near-critical-path-tag" title="Near-Critical Path ${pathInfo.index}">NCP ${pathInfo.index}</span>`);
                        }
                    });

                    // AI feedback placeholders - will be loaded asynchronously
                    const resourceTypesFeedback = this.getResourceTypesFeedbackHTML(task.ID);
                    const keyInsightsFeedback = this.getKeyInsightsFeedbackHTML(task.ID);

                    return `
                        <tr data-task-id="${task.ID}">
                            <td class="task-name-cell">
                                <strong>${task.ID}: ${task.Name}</strong>
                                ${this.state.criticalTasks.has(task.ID) ?
                            '<span class="critical-tag">[Critical]</span>' : ''}
                                ${this.state.outlierTasks.has(task.ID) && !this.state.criticalTasks.has(task.ID) ?
                            '<span class="near-critical-tag">[Near-Critical]</span>' : ''}
                                <div class="path-tags-container">
                                    ${pathTags.join(' ')}
                                </div>
                            </td>
                            <td>${task.Duration.toFixed(1)} ${timeUnits}</td>
                            <td>${originalResources}</td>
                            <td class="${impactClass}">${(impactScore * 100).toFixed(1)}%</td>
                            <td>
                                <div class="resource-control">
                                    <input type="range" 
                                           class="resource-slider" 
                                           min="0" 
                                           max="${(typeof this.getMaxResourcesForTask === 'function' ? this.getMaxResourcesForTask(task.ID) : 5)}" 
                                           value="${this.state.resourceChanges.get(task.ID) || 0}" 
                                           data-task-id="${task.ID}"
                                           onInput="window.scheduleOptimizer.handleResourceChange(event)">
                                    <span>+<span class="resource-value">${this.state.resourceChanges.get(task.ID) || 0}</span></span>
                                </div>
                            </td>
                            <td>
                                <input type="number" 
                                       class="task-rate" 
                                       data-task-id="${task.ID}" 
                                       value="${taskRate}" 
                                       min="0" 
                                       step="10"
                                       onInput="window.scheduleOptimizer.handleTaskRateChange(event)">
                            </td>
                            <td class="duration-saving" data-task-id="${task.ID}">
                                ${this.calculateSavingDisplay(task.ID)}
                            </td>
                            <td class="cost-impact" data-task-id="${task.ID}">
                                ${this.calculateCostDisplay(task.ID)}
                            </td>
                            <td class="value-ratio" data-task-id="${task.ID}">
                                ${this.calculateValueRatioDisplay(task.ID)}
                            </td>
                            <td class="resource-types-feedback ai-feedback" data-task-id="${task.ID}">
                                ${resourceTypesFeedback}
                            </td>
                            <td class="key-insights-feedback ai-feedback" data-task-id="${task.ID}">
                                ${keyInsightsFeedback}
                            </td>
                            <td>
                                <button class="ai-analysis-button action-button" data-task-id="${task.ID}" title="Get AI optimization recommendations">
                                    <i class="fas fa-robot"></i> AI Analysis
                                </button>
                            </td>
                        </tr>
                    `;
                })
                .join('');
        },

        /**
         * Generate HTML for resource types feedback
         * Will return loading message if feedback is not yet available
         */
        getResourceTypesFeedbackHTML(taskId) {
            // Check if we need to load the feedback
            if (!this.state.aiFeedbackCache[`${taskId}|recommendations`]) {
                // Only start loading if we're not already loading
                if (!this.state.isLoadingFeedback.has(`${taskId}|recommendations`)) {
                    this.state.isLoadingFeedback.add(`${taskId}|recommendations`);
                    // Delay loading to prevent too many simultaneous requests
                    setTimeout(() => {
                        this.loadAIFeedback(taskId, 'recommendations');
                    }, 100);
                }
                return '<div class="loading-feedback">Loading resource types...</div>';
            }

            // Parse feedback to extract resource types
            const feedback = this.state.aiFeedbackCache[`${taskId}|recommendations`];
            const resourceTypes = this.extractResourceTypes(feedback);

            if (resourceTypes.length === 0) {
                return '<div>No specific resource types identified.</div>';
            }

            // Return resource types as badges
            return resourceTypes.map(type =>
                `<div class="resource-type">${type}</div>`
            ).join('');
        },

        /**
         * Generate HTML for key insights feedback
         * Will return loading message if feedback is not yet available
         */
        getKeyInsightsFeedbackHTML(taskId) {
            // Check if we need to load the feedback
            if (!this.state.aiFeedbackCache[`${taskId}|risk`]) {
                // Only start loading if we're not already loading
                if (!this.state.isLoadingFeedback.has(`${taskId}|risk`)) {
                    this.state.isLoadingFeedback.add(`${taskId}|risk`);
                    // Delay loading to prevent too many simultaneous requests
                    setTimeout(() => {
                        this.loadAIFeedback(taskId, 'risk');
                    }, 200);
                }
                return '<div class="loading-feedback">Loading insights...</div>';
            }

            // Parse feedback to extract key insights
            const feedback = this.state.aiFeedbackCache[`${taskId}|risk`];
            const insights = this.extractKeyInsights(feedback);

            if (insights.length === 0) {
                return '<div>No specific insights available.</div>';
            }

            // Return insights as a list
            return insights.map(insight =>
                `<div class="key-insight">${insight}</div>`
            ).join('');
        },

        /**
         * Load AI feedback for a task and section
         */
        async loadAIFeedback(taskId, section) {
            try {
                const task = nodes.find(n => n.ID === taskId);
                if (!task) {
                    console.warn(`Task ${taskId} not found when loading AI feedback`);
                    return;
                }

                // Build a minimal analysis object for the task
                const analysis = {
                    upstreamDependencies: new Set(),
                    downstreamImpact: new Set(),
                    criticalPathEffect: this.state.criticalTasks.has(taskId) ? task.Duration : 0,
                    totalSlack: this.state.criticalTasks.has(taskId) ? 0 : 2,
                    pathsToEnd: [{
                        path: [taskId],
                        length: task.Duration,
                        isCritical: this.state.criticalTasks.has(taskId)
                    }]
                };

                // Get project segment from global state or default
                const projectSegment = this.state.projectSegment;

                // Call the existing getAIFeedbackForTask function
                console.log(`Loading AI feedback for task ${taskId}, section ${section}, project segment: ${projectSegment}`);
                let feedback;

                try {
                    feedback = await getOptimizationAIFeedback(
                        task,
                        window.cybereumState?.totalProjectDays || 100,
                        analysis,
                        projectSegment,
                        section
                    );
                } catch (error) {
                    console.error(`Error getting optimization AI feedback:`, error);
                }

                // If we didn't get feedback from the API or it failed, generate mock feedback
                if (!feedback) {
                    console.log(`Generating mock feedback for task ${taskId}, section ${section}`);
                    feedback = this.getMockFeedback(task, section, projectSegment);
                }

                // Store the feedback in our cache
                this.state.aiFeedbackCache[`${taskId}|${section}`] = feedback;

                // Remove from loading set
                this.state.isLoadingFeedback.delete(`${taskId}|${section}`);

                // Update the display
                this.updateAIFeedbackDisplay(taskId, section);

            } catch (error) {
                console.error(`Error loading AI feedback for task ${taskId}, section ${section}:`, error);

                // Generate mock feedback as fallback
                const mockFeedback = this.getMockFeedback(nodes.find(n => n.ID === taskId), section, this.state.projectSegment);
                this.state.aiFeedbackCache[`${taskId}|${section}`] = mockFeedback;

                // Remove from loading set
                this.state.isLoadingFeedback.delete(`${taskId}|${section}`);

                // Update the display
                this.updateAIFeedbackDisplay(taskId, section);
            }
        },

        /**
         * Generate mock feedback based on task and project sector
         */
        getMockFeedback(task, section, projectSegment) {
            // Implementation is the same as in the original code
            // (Detailed implementation of mock feedback generation)
            const taskName = task?.Name || 'Task';
            const taskId = task?.ID || '0';
            const isCritical = this.state.criticalTasks.has(taskId);

            // Implement resource recommendations based on sector
            // (Implementations of sector-specific resource recommendations)
            // ...

            // Return different mock feedback based on section type
            switch (section) {
                case 'recommendations':
                    return `
                        1. **Acceleration Methods:** ${isCritical ? 'Fast-track with additional specialized resources and parallel execution' : 'Add targeted resources while maintaining quality control'}.
                        2. **Resource Requirements:** 
                           - Technical Specialist
                           - Equipment Operator
                           - Quality Control Inspector
                           - Support Resources
                        3. **Implementation Plan:** Mobilize resources quickly, implement daily progress tracking, and establish clear handover procedures.
                    `;

                case 'risk':
                    return `
                        1. **Compression Risk Factors:** ${isCritical ? 'Accelerating this critical task increases risks related to quality and safety' : 'Adding resources must be balanced against coordination overhead'}.
                        2. **Resource Sensitivity:** Quality standards must be maintained while accelerating work to avoid rework and safety concerns.
                        3. **Risk Mitigation:** Implement enhanced quality checks, maintain contingency resources, and establish clear escalation protocols.
                    `;

                case 'importance':
                    return `
                        1. **Schedule Impact:** ${isCritical ? 'Critical path task with direct impact on project completion date' : 'Near-critical with minimal float; may become controlling'}.
                        2. **Resource Implications:** Strategic resource allocation needed to optimize effectiveness.
                        3. **Critical Path Analysis:** ${isCritical ? 'Controlling path reduction provides direct project benefit of approximately ' + (task.Duration * 0.2).toFixed(1) + ' days' : 'May become critical if float consumption exceeds ' + (task.TotalSlack || 2).toFixed(1) + ' days'}.
                    `;

                default:
                    return `AI feedback for ${section} would appear here for ${projectSegment} sector.`;
            }
        },

        /**
         * Update the display for AI feedback
         */
        updateAIFeedbackDisplay(taskId, section) {
            if (section === 'recommendations') {
                const element = document.querySelector(`.resource-types-feedback[data-task-id="${taskId}"]`);
                if (element) {
                    element.innerHTML = this.getResourceTypesFeedbackHTML(taskId);
                }
            } else if (section === 'risk') {
                const element = document.querySelector(`.key-insights-feedback[data-task-id="${taskId}"]`);
                if (element) {
                    element.innerHTML = this.getKeyInsightsFeedbackHTML(taskId);
                }
            }
        },

        /**
         * Load AI feedback for all optimizable tasks
         */
        loadAllAIFeedback() {
            console.log("Loading AI feedback for all optimizable tasks");
            const optimizableTasks = this.getOptimizableTasks();

            // Load recommendations and risk feedback for each task with a short delay between
            optimizableTasks.forEach((task, index) => {
                // Use staggered timeouts to avoid overwhelming the system
                setTimeout(() => {
                    if (!this.state.aiFeedbackCache[`${task.ID}|recommendations`]) {
                        this.loadAIFeedback(task.ID, 'recommendations');
                    }
                }, index * 300);

                setTimeout(() => {
                    if (!this.state.aiFeedbackCache[`${task.ID}|risk`]) {
                        this.loadAIFeedback(task.ID, 'risk');
                    }
                }, index * 300 + 150);
            });
        },

        /**
         * Extract resource types from AI feedback
         * Looks for resource mentions in the recommendations feedback
         */
        extractResourceTypes(feedback) {
            if (!feedback) return [];

            // Industry-specific resource types to look for
            const resourceKeywords = [
                // Personnel
                'engineer', 'developer', 'technician', 'specialist', 'architect',
                'manager', 'supervisor', 'inspector', 'analyst', 'designer',
                'planner', 'coordinator', 'operator', 'crew', 'team',
                'expert', 'scientist', 'administrator', 'consultant', 'officer',

                // Nuclear/Energy-specific
                'reactor', 'nuclear', 'radiation', 'containment', 'cooling',
                'safety', 'boiler', 'turbine', 'generator', 'emissions',
                'panel', 'solar', 'wind', 'transmission', 'substation',

                // Construction/Civil
                'civil', 'structural', 'mechanical', 'electrical', 'geotechnical',
                'pipeline', 'foundation', 'concrete', 'steel', 'earthwork',
                'excavation', 'pavement', 'drainage', 'bridge', 'highway',

                // Equipment/Tools
                'equipment', 'machinery', 'system', 'crane', 'excavator',
                'drill', 'boring', 'paving', 'lifting', 'trenching',
                'monitoring', 'testing', 'control', 'fleet', 'vessel'
            ];

            // Look for special sections that might contain resource information
            let resourceSection = '';
            const resourceSectionRegex = /resource requirements:(.+?)(?:\d\.|$)/is;
            const match = feedback.match(resourceSectionRegex);

            if (match && match[1]) {
                resourceSection = match[1];
            }

            // First try to extract from specific resource section if available
            let resourceTypes = [];

            if (resourceSection) {
                // Look for bullet points or numbered items
                const bulletItems = resourceSection.match(/[-•*]\s*([^-•*\n]+)/g);
                if (bulletItems) {
                    resourceTypes = bulletItems.map(item =>
                        item.replace(/[-•*]\s*/, '').trim()
                    );
                }

                // If no bullet points, just extract phrases
                if (resourceTypes.length === 0) {
                    const phrases = resourceSection.split(/[.,;:]+/);
                    resourceTypes = phrases.map(p => p.trim()).filter(p => p.length > 3);
                }
            }

            // If no specific resource section or nothing found, look for keywords in the entire text
            if (resourceTypes.length === 0) {
                resourceKeywords.forEach(keyword => {
                    // Find instances of the keyword with surrounding text
                    const pattern = new RegExp(`(\\w+\\s+){0,2}${keyword}(s|es)?(\\s+\\w+){0,2}`, 'gi');
                    let match;

                    while ((match = pattern.exec(feedback)) !== null) {
                        resourceTypes.push(match[0].trim());
                    }
                });
            }

            // Clean up and deduplicate
            return [...new Set(resourceTypes.map(rt => rt.trim()))]
                .filter(rt => rt.length > 3 && rt.length < 40) // Reasonable length
                .slice(0, 4); // Limit to 4 resources
        },

        /**
         * Extract key insights from AI feedback
         * Looks for risk factors or important points in the risk feedback
         */
        extractKeyInsights(feedback) {
            if (!feedback) return [];

            let insights = [];

            // Look for bullet points or numbered items
            const bulletItems = feedback.match(/[-•*\d]\s*([^-•*\n]+)/g);
            if (bulletItems) {
                insights = bulletItems.map(item =>
                    item.replace(/[-•*\d]\s*/, '').trim()
                );
            }

            // If no bullet points or we have very few, try to extract meaningful sentences
            if (insights.length < 2) {
                // Split by sentence
                const sentences = feedback.match(/[^.!?]+[.!?]+/g) || [];

                // Look for sentences with risk indicator words
                const riskWords = ['risk', 'critical', 'important', 'caution', 'warning', 'careful',
                    'challenge', 'issue', 'problem', 'concern', 'factor', 'impact'];

                insights = sentences
                    .filter(sentence =>
                        riskWords.some(word =>
                            sentence.toLowerCase().includes(word)
                        )
                    )
                    .map(sentence => sentence.trim());
            }

            // Clean up and deduplicate
            return [...new Set(insights)]
                .filter(insight => insight.length > 10 && insight.length < 100) // Reasonable length
                .slice(0, 3); // Limit to 3 insights
        },

        /**
         * Calculate duration saving display for a task
         */
        calculateSavingDisplay(taskId) {
            const resourceChange = this.state.resourceChanges.get(taskId) || 0;
            if (resourceChange <= 0) return "0 days";

            const durationSaving = this.calculateScheduleImpact(taskId, resourceChange);
            const task = nodes.find(n => n.ID === taskId);
            const timeUnits = task?.TimeUnits || 'days';

            return `${durationSaving.toFixed(1)} ${timeUnits}`;
        },

        /**
         * Calculate cost impact display for a task
         */
        calculateCostDisplay(taskId) {
            const resourceChange = this.state.resourceChanges.get(taskId) || 0;
            if (resourceChange <= 0) return `${this.state.currency}0`;

            const task = nodes.find(n => n.ID === taskId);
            const durationSaving = this.calculateScheduleImpact(taskId, resourceChange);
            const updatedDuration = task.Duration - durationSaving;
            const taskRate = this.state.taskRates.get(taskId) || this.state.resourceRate;
            const hoursPerDay = window.cybereumState?.teamCalendar?.hoursPerDay || 8; // Standard workday

            const costImpact = resourceChange * taskRate * hoursPerDay * updatedDuration;
            return `${this.state.currency}${costImpact.toLocaleString()}`;
        },

        /**
         * Calculate value ratio display for a task
         * Shows the ratio of savings to cost
         */
        calculateValueRatioDisplay(taskId) {
            const resourceChange = this.state.resourceChanges.get(taskId) || 0;
            if (resourceChange <= 0) return "N/A";

            const dailySavings = parseFloat(document.getElementById('dailySavings')?.value || this.state.dailySavings);
            if (!this.state.criticalTasks.has(taskId) || dailySavings <= 0) return "N/A";

            const durationSaving = this.calculateScheduleImpact(taskId, resourceChange);
            const savings = dailySavings * durationSaving;

            // Extract cost impact value from the display string
            const costDisplay = this.calculateCostDisplay(taskId);
            const costImpact = parseFloat(costDisplay.replace(/[^0-9.-]+/g, ""));

            if (costImpact <= 0) return "N/A";

            const ratio = savings / costImpact;
            const className = ratio > 2 ? 'impact-high' :
                ratio > 1 ? 'impact-medium' :
                    'impact-low';

            return `<span class="${className}">${ratio.toFixed(2)}</span>`;
        },

        /**
         * Find optimal resource allocation to meet a target reduction or date
         * Uses a heuristic approach to minimize cost while meeting the target
         * 
         * @param {Number|Date} target - Either days to reduce or target end date
         * @param {String} targetType - 'reduction' or 'date'
         * @param {Object} options - Optimization options
         * @returns {Object} - Optimization results
         */
        findOptimalSolution(target, targetType, options = {}) {
            console.log(`Finding optimal solution for ${targetType}: ${target}`);

            // Default options
            const defaultOptions = {
                minimizeCost: true,
                maxTaskResources: 3,
                maxIterations: 1000
            };

            const settings = { ...defaultOptions, ...options };

            // Convert target date to reduction if targetType is 'date'
            let targetReduction;

            if (targetType === 'date') {
                // Target is a Date object
                const targetDate = new Date(target);
                const currentEndDate = new Date(this.state.originalEndDate);

                // Calculate difference in days
                const diffTime = currentEndDate - targetDate;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays <= 0) {
                    return {
                        success: false,
                        reason: "Target date is later than or equal to current end date"
                    };
                }

                targetReduction = diffDays;
                console.log(`Target date ${targetDate.toDateString()} requires ${targetReduction} days reduction`);
            } else {
                // Target is already in days
                targetReduction = Number(target);
            }

            // Check if target is reasonable (protect against extreme values)
            const originalProjectDays = window.cybereumState.totalProjectDays ||
                Math.ceil((this.state.originalEndDate - window.cybereumState.startDate) / (24 * 60 * 60 * 1000));

            const maxReasonableReduction = Math.round(originalProjectDays * 0.4); // Max 40% reduction

            if (targetReduction > maxReasonableReduction) {
                return {
                    success: false,
                    reason: `Target reduction of ${targetReduction} days is too aggressive. Maximum reasonable reduction is ${maxReasonableReduction} days.`
                };
            }

            // Reset current resource changes
            this.state.resourceChanges = new Map();

            // Get optimizable tasks sorted by impact score and value ratio
            const optimizableTasks = this.getOptimizableTasks()
                .filter(task => !task.isResourceConstrained);

            if (optimizableTasks.length === 0) {
                return {
                    success: false,
                    reason: "No optimizable tasks found"
                };
            }

            // Get critical path information
            const criticalPaths = this.getOriginalPathLengths('critical');
            if (criticalPaths.length === 0) {
                return {
                    success: false,
                    reason: "No critical path information available"
                };
            }

            // Baseline information
            const baselineDuration = criticalPaths[0].duration;
            console.log(`Baseline duration: ${baselineDuration} days`);
            console.log(`Target reduction: ${targetReduction} days (${(targetReduction / baselineDuration * 100).toFixed(1)}%)`);

            // Heuristic approach to find optimal solution
            // We'll use a priority-based allocation, focusing on tasks with highest value ratio

            // 1. First try a brute force approach for small networks
            if (optimizableTasks.length <= 10) {
                console.log("Using exhaustive search for small network");
                return this.exhaustiveSearchSolution(optimizableTasks, targetReduction, settings);
            }

            // 2. Use greedy algorithm with refinement for larger networks
            console.log("Using greedy algorithm with refinement");

            // Initialize solution tracker
            let bestSolution = null;
            let bestCost = Infinity;
            let bestReduction = 0;

            // Sort tasks by their impact score (most impactful first)
            const tasksByImpact = [...optimizableTasks].sort((a, b) => {
                // Calculate a combined score of impact and cost-effectiveness
                const aImpact = this.state.impactScores.get(a.ID) || 0;
                const bImpact = this.state.impactScores.get(b.ID) || 0;

                // Get critical path status as a bonus
                const aIsCritical = this.state.criticalTasks.has(a.ID) ? 2 : this.state.outlierTasks.has(a.ID) ? 1 : 0;
                const bIsCritical = this.state.criticalTasks.has(b.ID) ? 2 : this.state.outlierTasks.has(b.ID) ? 1 : 0;

                // Prioritize critical path tasks, then by impact score
                if (aIsCritical !== bIsCritical) {
                    return bIsCritical - aIsCritical;
                }

                return bImpact - aImpact;
            });

            // Greedy approach: keep adding resources to best tasks until target is met
            const solution = new Map();
            let currentReduction = 0;
            let currentCost = 0;
            let iterations = 0;

            while (currentReduction < targetReduction && iterations < settings.maxIterations) {
                iterations++;

                // Find best next task to optimize
                let bestTask = null;
                let bestTaskIndex = -1;
                let bestTaskValue = -1;
                let bestTaskReduction = 0;
                let bestTaskCost = 0;

                // Evaluate adding a resource to each task
                for (let i = 0; i < tasksByImpact.length; i++) {
                    const task = tasksByImpact[i];

                    // Skip if already at max resources
                    const currentResources = solution.get(task.ID) || 0;
                    if (currentResources >= settings.maxTaskResources) continue;

                    // Calculate incremental value of adding one more resource
                    const withoutTask = new Map(solution);
                    const withTask = new Map(solution);
                    withTask.set(task.ID, currentResources + 1);

                    // Apply both scenarios and measure the difference
                    this.state.resourceChanges = withoutTask;
                    const reductionWithout = this.calculateProjectReduction();

                    this.state.resourceChanges = withTask;
                    const reductionWith = this.calculateProjectReduction();

                    // Calculate incremental benefit
                    const incrementalReduction = reductionWith - reductionWithout;

                    // Calculate incremental cost
                    const taskRate = this.state.taskRates.get(task.ID) || this.state.resourceRate;
                    const hoursPerDay = window.cybereumState?.teamCalendar?.hoursPerDay || 8;

                    // Calculate cost based on resource usage over optimized duration
                    const durationSaving = this.calculateScheduleImpact(task.ID, currentResources + 1);
                    const updatedDuration = task.Duration - durationSaving;
                    const incrementalCost = 1 * taskRate * hoursPerDay * updatedDuration;

                    // Calculate value ratio (reduction per cost)
                    const valueRatio = incrementalReduction > 0 ? incrementalReduction / incrementalCost : 0;

                    // Update best task if this has better value
                    if (valueRatio > bestTaskValue) {
                        bestTask = task;
                        bestTaskIndex = i;
                        bestTaskValue = valueRatio;
                        bestTaskReduction = incrementalReduction;
                        bestTaskCost = incrementalCost;
                    }
                }

                // If no improvement possible, break
                if (!bestTask) {
                    console.log("No further improvement possible");
                    break;
                }

                // Update solution
                const currentResourcesForBest = solution.get(bestTask.ID) || 0;
                solution.set(bestTask.ID, currentResourcesForBest + 1);

                currentReduction += bestTaskReduction;
                currentCost += bestTaskCost;

                console.log(`Added resource to task ${bestTask.ID}: +${bestTaskReduction.toFixed(2)} days reduction, +${this.state.currency}${bestTaskCost.toFixed(0)} cost`);

                // Check if we found a better solution that meets target
                if (currentReduction >= targetReduction && (bestSolution === null || currentCost < bestCost)) {
                    bestSolution = new Map(solution);
                    bestCost = currentCost;
                    bestReduction = currentReduction;
                    console.log(`New best solution found: ${bestReduction.toFixed(2)} days reduction, ${this.state.currency}${bestCost.toFixed(0)} cost`);
                }
            }

            // If we didn't meet the target, but have a partial solution
            if (currentReduction < targetReduction && bestSolution === null) {
                bestSolution = solution;
                bestCost = currentCost;
                bestReduction = currentReduction;

                console.log(`Partial solution: ${bestReduction.toFixed(2)}/${targetReduction} days reduction`);
            }

            // No feasible solution
            if (bestSolution === null) {
                return {
                    success: false,
                    reason: "No feasible solution found within constraints"
                };
            }

            // Apply the best solution
            this.state.resourceChanges = bestSolution;

            // Recalculate project dates and get optimized paths
            this.recalculateProjectDates();
            const optimizedCriticalPaths = this.getOptimizedPathLengths('critical');

            // Update project end date display
            this.updateProjectEndDate();

            // Calculate new end date
            const newEndDate = this.state.projectedEndDate;

            // Prepare results
            return {
                success: true,
                solution: bestSolution,
                reduction: bestReduction,
                cost: bestCost,
                taskCount: bestSolution.size,
                resourceCount: Array.from(bestSolution.values()).reduce((a, b) => a + b, 0),
                endDate: newEndDate,
                targetMet: bestReduction >= targetReduction,
                actualReduction: {
                    days: bestReduction,
                    percent: (bestReduction / baselineDuration) * 100
                },
                optimizedDuration: optimizedCriticalPaths[0]?.duration || (baselineDuration - bestReduction)
            };
        },

        /**
         * Use exhaustive search to find optimal solution for small networks
         * This approach is only practical for networks with few optimizable tasks
         */
        exhaustiveSearchSolution(optimizableTasks, targetReduction, settings) {
            console.log(`Exhaustive search for ${optimizableTasks.length} tasks`);

            // Baseline information
            const criticalPaths = this.getOriginalPathLengths('critical');
            const baselineDuration = criticalPaths[0].duration;

            // Generate all possible resource combinations
            // We'll use a recursive approach to build all valid allocations
            const allAllocations = [];

            // Recursive function to generate allocations
            const generateAllocations = (taskIndex, currentAllocation, remainingBudget) => {
                // Base case: we've assigned resources to all tasks
                if (taskIndex === optimizableTasks.length) {
                    allAllocations.push(new Map(currentAllocation));
                    return;
                }

                const task = optimizableTasks[taskIndex];
                const taskId = task.ID;

                // Try different resource allocations for this task
                for (let resources = 0; resources <= settings.maxTaskResources; resources++) {
                    if (resources > 0) {
                        currentAllocation.set(taskId, resources);
                    } else {
                        currentAllocation.delete(taskId);
                    }

                    // Recursive call for next task
                    generateAllocations(taskIndex + 1, currentAllocation, remainingBudget);
                }
            };

            // Start the recursion with empty allocation
            generateAllocations(0, new Map(), Number.MAX_SAFE_INTEGER);

            console.log(`Generated ${allAllocations.length} possible resource allocations`);

            // Evaluate each allocation
            let bestSolution = null;
            let bestCost = Infinity;
            let bestReduction = 0;

            allAllocations.forEach((allocation, index) => {
                // Apply allocation
                this.state.resourceChanges = allocation;

                // Calculate reduction
                const reduction = this.calculateProjectReduction();

                // Skip if doesn't meet target
                if (reduction < targetReduction) return;

                // Calculate cost
                let cost = 0;
                allocation.forEach((resources, taskId) => {
                    const task = optimizableTasks.find(t => t.ID === taskId);
                    if (!task) return;

                    const taskRate = this.state.taskRates.get(taskId) || this.state.resourceRate;
                    const hoursPerDay = window.cybereumState?.teamCalendar?.hoursPerDay || 8;

                    const durationSaving = this.calculateScheduleImpact(taskId, resources);
                    const updatedDuration = task.Duration - durationSaving;
                    cost += resources * taskRate * hoursPerDay * updatedDuration;
                });

                // Update best if better
                if (cost < bestCost) {
                    bestSolution = new Map(allocation);
                    bestCost = cost;
                    bestReduction = reduction;
                }

                // Progress logging
                if (index % 100 === 0) {
                    console.log(`Evaluated ${index + 1}/${allAllocations.length} allocations...`);
                }
            });

            // No feasible solution
            if (bestSolution === null) {
                return {
                    success: false,
                    reason: "No allocation found that meets the target reduction"
                };
            }

            // Apply the best solution
            this.state.resourceChanges = bestSolution;

            // Recalculate project dates and get optimized paths
            this.recalculateProjectDates();
            const optimizedCriticalPaths = this.getOptimizedPathLengths('critical');

            // Update project end date display
            this.updateProjectEndDate();

            // Calculate new end date
            const newEndDate = this.state.projectedEndDate;

            // Prepare results
            return {
                success: true,
                solution: bestSolution,
                reduction: bestReduction,
                cost: bestCost,
                taskCount: bestSolution.size,
                resourceCount: Array.from(bestSolution.values()).reduce((a, b) => a + b, 0),
                endDate: newEndDate,
                targetMet: true,
                actualReduction: {
                    days: bestReduction,
                    percent: (bestReduction / baselineDuration) * 100
                },
                optimizedDuration: optimizedCriticalPaths[0]?.duration || (baselineDuration - bestReduction)
            };
        },

        /**
 * Calculate total project reduction from current resource changes
 * @returns {Number} - Reduction in days
 */
        calculateProjectReduction() {
            // Check if we have any resource changes
            let anyChanges = false;
            for (const [nodeId, resourceChange] of this.state.resourceChanges.entries()) {
                if (resourceChange > 0) {
                    anyChanges = true;
                    break;
                }
            }

            if (!anyChanges) return 0;

            // Get original duration from critical path
            const criticalPaths = this.getOriginalPathLengths('critical');
            if (criticalPaths.length === 0) return 0;

            const originalDuration = criticalPaths[0].duration;

            // Get optimized duration
            const optimizedPaths = this.getOptimizedPathLengths('critical');
            if (optimizedPaths.length === 0) return 0;

            const optimizedDuration = optimizedPaths[0].duration;

            // Calculate reduction
            return Math.max(0, originalDuration - optimizedDuration);
        },
        /**
         * Generate summary information
         */
        generateSummary() {
            // Get team calendar for working day calculations
            const teamCalendar = window.cybereumState?.teamCalendar || {
                hoursPerDay: DEFAULT_HOURS_PER_DAY || 8,
                workingDays: [1, 2, 3, 4, 5] // Mon-Fri default
            };
            const hoursPerDay = teamCalendar.hoursPerDay || 8;

            // Get original project duration
            const originalProjectDays = window.cybereumState.totalProjectDays ||
                Math.ceil((this.state.originalEndDate - window.cybereumState.startDate) / (24 * 60 * 60 * 1000));

            // Check if we have any resource changes
            let anyChanges = false;
            for (const [nodeId, resourceChange] of this.state.resourceChanges.entries()) {
                if (resourceChange > 0) {
                    anyChanges = true;
                    break;
                }
            }

            // Get both workingDaysSavings calculations for comparison
            const calendarWorkingDaysSavings = anyChanges ?
                calculateWorkingDaysBetween(this.state.projectedEndDate, this.state.originalEndDate, teamCalendar) : 0;

            // Also get path-based optimized durations for consistency with cost calculations
            const optimizedCriticalPaths = this.getOptimizedPathLengths('critical');
            const optimizedNearCriticalPaths = this.getOptimizedPathLengths('outlier');

            // Find the longest duration from either path type
            let longestOptimizedDuration = 0;
            if (optimizedCriticalPaths.length > 0) {
                longestOptimizedDuration = optimizedCriticalPaths[0].duration;
            }

            if (optimizedNearCriticalPaths.length > 0) {
                longestOptimizedDuration = Math.max(
                    longestOptimizedDuration,
                    optimizedNearCriticalPaths[0].duration
                );
            }

            const optimizedDuration = longestOptimizedDuration > 0 ?
                longestOptimizedDuration : originalProjectDays;

            // Calculate path-based savings (as was used previously)
            const pathBasedSavings = anyChanges ? Math.max(0, originalProjectDays - optimizedDuration) : 0;

            // Log both calculations for diagnostic purposes
            console.log("Time savings calculation comparison:", {
                calendarWorkingDaysSavings,
                pathBasedSavings,
                difference: pathBasedSavings - calendarWorkingDaysSavings
            });

            // IMPORTANT: Use path-based savings to maintain consistency with how costs are calculated
            // This ensures we maintain the expected benefit calculations
            const durationSavings = pathBasedSavings;

            // Calculate total cost impact 
            let totalCost = 0;

            nodes.forEach(node => {
                const resourceChange = this.state.resourceChanges.get(node.ID) || 0;
                if (resourceChange <= 0) return;

                const taskRate = this.state.taskRates.get(node.ID) || this.state.resourceRate;
                const durationSaving = this.calculateScheduleImpact(node.ID, resourceChange);
                const updatedDuration = node.Duration - durationSaving;

                totalCost += resourceChange * taskRate * hoursPerDay * updatedDuration;
            });

            // Calculate savings from earlier completion
            const dailySavings = parseFloat(document.getElementById('dailySavings')?.value || this.state.dailySavings);
            const completionSavings = dailySavings * durationSavings;

            // Calculate net benefit
            const netBenefit = completionSavings - totalCost;
            const netBenefitClass = netBenefit > 0 ? 'positive-value' :
                netBenefit < 0 ? 'negative-value' : '';

            // Populate sticky summary - show the calendar-based values in the UI for accuracy
            const stickySummaryOriginalDuration = document.getElementById('stickySummaryOriginalDuration');
            const stickySummaryProjectedDuration = document.getElementById('stickySummaryProjectedDuration');
            const stickySummaryTimeSavings = document.getElementById('stickySummaryTimeSavings');
            const stickySummaryResourceCost = document.getElementById('stickySummaryResourceCost');
            const stickySummaryNetBenefit = document.getElementById('stickySummaryNetBenefit');

            if (stickySummaryOriginalDuration) stickySummaryOriginalDuration.textContent = `${originalProjectDays.toFixed(1)} days`;
            if (stickySummaryProjectedDuration) stickySummaryProjectedDuration.textContent = `${optimizedDuration.toFixed(1)} days`;
            // For display, use both values but mark which is which
            if (stickySummaryTimeSavings) {
                stickySummaryTimeSavings.textContent = calendarWorkingDaysSavings > 0 ?
                    `${durationSavings.toFixed(1)} days (${calendarWorkingDaysSavings} working days)` :
                    `${durationSavings.toFixed(1)} days`;
            }
            if (stickySummaryResourceCost) stickySummaryResourceCost.textContent = `${this.state.currency}${totalCost.toLocaleString()}`;
            if (stickySummaryNetBenefit) {
                stickySummaryNetBenefit.textContent = `${this.state.currency}${netBenefit.toLocaleString()}`;
                stickySummaryNetBenefit.className = netBenefitClass;
            }

            // Return the existing summary HTML
            return `
                <h3>Optimization Summary</h3>
                <p>Original Project Duration: ${originalProjectDays.toFixed(1)} days</p>
                <p>Potential Duration After Optimization: <span id="optimizedDuration">${optimizedDuration.toFixed(1)}</span> days</p>
                <p>Additional Resources Required: <span id="additionalResources">${this.calculateAdditionalResources()}</span></p>
                <p>Resource Cost Impact: <span id="costImpact">${this.state.currency}${totalCost.toLocaleString()}</span></p>
                <p>Estimated Savings from Earlier Completion: <span id="completionSavings">${this.state.currency}${completionSavings.toLocaleString()}</span></p>
                <p>Net Project Benefit: <span id="netBenefit" class="${netBenefitClass}">${this.state.currency}${netBenefit.toLocaleString()}</span></p>
            `;
        },

        // Helper method to calculate additional resources
        calculateAdditionalResources() {
            let additionalResources = 0;
            this.state.resourceChanges.forEach(change => {
                if (change > 0) additionalResources += change;
            });
            return additionalResources;
        },

        /**
         * Handle resource change event from UI
         */
        handleResourceChange(event) {
            const taskId = event.target.dataset.taskId;
            const resourceChange = parseInt(event.target.value);
            this.state.resourceChanges.set(taskId, resourceChange);

            // Update UI
            const valueSpan = event.target.parentElement.querySelector('.resource-value');
            if (valueSpan) {
                valueSpan.textContent = resourceChange;
            }

            // Calculate and display duration saving
            const durationSaving = this.calculateScheduleImpact(taskId, resourceChange);
            const task = nodes.find(n => n.ID === taskId);
            const timeUnits = task?.TimeUnits || 'days';

            const savingCell = document.querySelector(`.duration-saving[data-task-id="${taskId}"]`);
            if (savingCell) {
                savingCell.textContent = `${durationSaving.toFixed(1)} ${timeUnits}`;
            }

            // Calculate cost impact using updated duration
            const updatedDuration = task.Duration - durationSaving;
            const taskRate = this.state.taskRates.get(taskId) || this.state.resourceRate;
            const hoursPerDay = window.cybereumState?.teamCalendar?.hoursPerDay || 8; // Standard workday
            const costImpact = resourceChange * taskRate * hoursPerDay * updatedDuration;

            const costCell = document.querySelector(`.cost-impact[data-task-id="${taskId}"]`);
            if (costCell) {
                costCell.textContent = `${this.state.currency}${costImpact.toLocaleString()}`;
            }

            // Calculate value ratio
            const dailySavings = parseFloat(document.getElementById('dailySavings').value) || 0;
            const valueRatioCell = document.querySelector(`.value-ratio[data-task-id="${taskId}"]`);

            if (valueRatioCell) {
                if (this.state.criticalTasks.has(taskId) && dailySavings > 0 && costImpact > 0) {
                    const savings = dailySavings * durationSaving;
                    const ratio = savings / costImpact;

                    // Choose appropriate class based on ratio
                    let className = '';
                    if (ratio > 2) {
                        className = 'impact-high';  // Good ROI
                    } else if (ratio > 1) {
                        className = 'impact-medium'; // Decent ROI
                    } else {
                        className = 'impact-low';   // Poor ROI
                    }

                    valueRatioCell.innerHTML = `<span class="${className}">${ratio.toFixed(2)}</span>`;
                } else {
                    valueRatioCell.textContent = 'N/A';
                }
            }

            // Update summary/path/end-date (debounced: range input fires frequently)
            if (this._heavyUIUpdateTimer) clearTimeout(this._heavyUIUpdateTimer);
            this._heavyUIUpdateTimer = setTimeout(() => {
                try {
                    this.updateSummary();
                    this.updatePathVisualization();
                    this.updateProjectEndDate();
                } catch (e) {
                    console.error('Optimizer UI update error:', e);
                }
            }, 120);
        },

        /**
         * Handle task rate change event from UI
         */
        handleTaskRateChange(event) {
            const taskId = event.target.dataset.taskId;
            const taskRate = parseFloat(event.target.value) || this.state.resourceRate;

            // Update the task rate in our state
            this.state.taskRates.set(taskId, taskRate);

            // If the task has resources allocated, recalculate impact
            const resourceChange = this.state.resourceChanges.get(taskId) || 0;
            if (resourceChange > 0) {
                // Update cost display
                const costCell = document.querySelector(`.cost-impact[data-task-id="${taskId}"]`);
                if (costCell) {
                    costCell.textContent = this.calculateCostDisplay(taskId);
                }

                // Update value ratio display
                const valueRatioCell = document.querySelector(`.value-ratio[data-task-id="${taskId}"]`);
                if (valueRatioCell) {
                    valueRatioCell.innerHTML = this.calculateValueRatioDisplay(taskId);
                }

                // Update summary to reflect new rate (debounced)
                if (this._summaryUpdateTimer) clearTimeout(this._summaryUpdateTimer);
                this._summaryUpdateTimer = setTimeout(() => {
                    try { this.updateSummary(); } catch (e) { console.error('Optimizer summary update error:', e); }
                }, 80);
            }
        },

        /**
 * Update the projected end date in the UI based on optimization changes
 * Considers both critical and near-critical paths to determine controlling path
 */
        updateProjectEndDate() {
            // Check if we have any resource changes
            let anyChanges = false;
            for (const [, resourceChange] of this.state.resourceChanges.entries()) {
                if (resourceChange > 0) { anyChanges = true; break; }
            }

            // If no resource changes, reset to original date and update UI
            if (!anyChanges) {
                this.state.projectedEndDate = new Date(this.state.originalEndDate);
                this.state.controllingPath = null;
                this.state.controllingPathType = null;

                const projectedEndDateElement = document.getElementById('projectedEndDate');
                if (projectedEndDateElement) {
                    projectedEndDateElement.textContent = this.formatDate(this.state.originalEndDate);
                }

                const timeSavingsElement = document.getElementById('timeSavings');
                if (timeSavingsElement) {
                    timeSavingsElement.className = '';
                    timeSavingsElement.textContent = '0 days';
                }

                // Update sticky summary if present
                const stickySummaryTimeSavings = document.getElementById('stickySummaryTimeSavings');
                if (stickySummaryTimeSavings) {
                    stickySummaryTimeSavings.textContent = '0 days';
                    stickySummaryTimeSavings.className = '';
                }

                return;
            }

            // Recalculate project schedule with the resource changes (also sets controllingPath/Type)
            this.recalculateProjectDates();

            // Verify the projected end date is reasonable
            if (!this.state.projectedEndDate || isNaN(this.state.projectedEndDate.getTime())) {
                console.error("Invalid projected end date after recalculation");
                this.state.projectedEndDate = new Date(this.state.originalEndDate);
            }

            // Update UI with the new projected end date
            const projectedEndDateElement = document.getElementById('projectedEndDate');
            if (projectedEndDateElement) {
                projectedEndDateElement.textContent = this.formatDate(this.state.projectedEndDate);
            }

            // Use controlling path computed during recalc to avoid redundant optimized-path recomputation
            const controllingPathType = this.state.controllingPathType || 'critical';
            const controllingPath = this.state.controllingPath || null;

            // Calculate calendar day difference between original and projected end dates
            const originalMs = this.state.originalEndDate.getTime();
            const projectedMs = this.state.projectedEndDate.getTime();
            const calendarDaysDiff = Math.round((originalMs - projectedMs) / (1000 * 60 * 60 * 24));

            // Get team calendar for working day conversion
            const teamCalendar = window.cybereumState?.teamCalendar || {
                hoursPerDay: DEFAULT_HOURS_PER_DAY || 8,
                workingDays: [1, 2, 3, 4, 5] // Mon-Fri default
            };

            // Calculate working days difference accurately using calendar
            const workingDaysDiff = calculateWorkingDaysBetween(
                this.state.projectedEndDate,
                this.state.originalEndDate,
                teamCalendar
            );

            // Update time savings display with proper working and calendar days
            const timeSavingsElement = document.getElementById('timeSavings');
            if (timeSavingsElement) {
                if (workingDaysDiff > 0) {
                    timeSavingsElement.className = 'time-savings-positive';
                    timeSavingsElement.innerHTML = `
                ${workingDaysDiff} working days earlier (${calendarDaysDiff} calendar days)
                <span class="controlling-path-indicator">Controlling: ${controllingPathType} path ${controllingPath?.index || 1}</span>
            `;
                } else if (workingDaysDiff < 0) {
                    timeSavingsElement.className = 'time-savings-negative';
                    timeSavingsElement.innerHTML = `
                ${Math.abs(workingDaysDiff)} working days later (${Math.abs(calendarDaysDiff)} calendar days)
                <span class="controlling-path-indicator">Controlling: ${controllingPathType} path ${controllingPath?.index || 1}</span>
            `;
                } else {
                    timeSavingsElement.className = '';
                    timeSavingsElement.textContent = 'No change';
                }
            }

            // Update sticky summary if present
            const stickySummaryTimeSavings = document.getElementById('stickySummaryTimeSavings');
            if (stickySummaryTimeSavings) {
                stickySummaryTimeSavings.textContent = workingDaysDiff > 0 ?
                    `${workingDaysDiff} days earlier` :
                    workingDaysDiff < 0 ?
                        `${Math.abs(workingDaysDiff)} days later` :
                        'No change';
                stickySummaryTimeSavings.className = workingDaysDiff > 0 ?
                    'time-savings-positive' :
                    workingDaysDiff < 0 ?
                        'time-savings-negative' :
                        '';
            }
        },

        /**
         * Update the summary section
         */
        updateSummary() {
            const summaryContainer = document.getElementById('optimizationSummary');
            if (summaryContainer) {
                summaryContainer.innerHTML = this.generateSummary();
            }
        },

        /**
         * Reset all optimization changes
         */
        resetOptimization() {
            // Clear all resource changes
            this.state.resourceChanges.clear();

            // Reset projected end date
            this.state.projectedEndDate = new Date(this.state.originalEndDate);

            // Reset UI elements
            document.querySelectorAll('.resource-slider').forEach(slider => {
                slider.value = 0;
                const valueSpan = slider.parentElement.querySelector('.resource-value');
                if (valueSpan) valueSpan.textContent = '0';
            });

            document.querySelectorAll('.duration-saving').forEach(cell => {
                const task = nodes.find(n => n.ID === cell.dataset.taskId);
                const timeUnits = task?.TimeUnits || 'days';
                cell.textContent = `0 ${timeUnits}`;
            });

            document.querySelectorAll('.cost-impact').forEach(cell => {
                cell.textContent = `${this.state.currency}0`;
            });

            document.querySelectorAll('.value-ratio').forEach(cell => {
                cell.textContent = 'N/A';
                cell.className = 'value-ratio';
            });

            // Update summary and visualizations
            this.updateSummary();
            this.updatePathVisualization();
            this.updateProjectEndDate();

            // Reattach AI analysis buttons
            this.attachAIAnalysisHandlers();
        },

        /**
         * Apply optimization changes to the actual schedule
         */
        applyOptimization() {
            if (confirm('Are you sure you want to apply these optimization changes? This will update the project schedule.')) {
                // Track all modified nodes
                const modifiedNodes = [];

                // Apply duration changes to nodes
                nodes.forEach(node => {
                    const resourceChange = this.state.resourceChanges.get(node.ID) || 0;
                    if (resourceChange <= 0) return;

                    const originalDuration = this.state.originalDurations.get(node.ID)?.duration || node.Duration;
                    const originalResources = this.state.originalDurations.get(node.ID)?.resources || 1;
                    const percentComplete = node.PercentComplete || 0;

                    // Calculate new duration with shared utility function
                    const newDuration = calculateDurationWithResources(
                        originalDuration,
                        originalResources,
                        resourceChange,
                        percentComplete,
                        {
                            complexity: node.riskScore || 0.5
                        }
                    );

                    // Track that this node was modified
                    modifiedNodes.push({
                        node: node,
                        oldDuration: node.Duration,
                        newDuration: newDuration
                    });

                    // Update node duration
                    node.Duration = newDuration;
                    node.resourcesRequired = originalResources + resourceChange;

                    // Store task rate if customized
                    const taskRate = this.state.taskRates.get(node.ID);
                    if (taskRate && taskRate !== this.state.resourceRate) {
                        node.CostRate = taskRate;
                    }
                });

                // No changes to apply
                if (modifiedNodes.length === 0) {
                    alert('No optimization changes to apply.');
                    return;
                }

                // Get team calendar
                const teamCalendar = window.cybereumState.teamCalendar || {
                    hoursPerDay: DEFAULT_HOURS_PER_DAY || 8,
                    workingDays: [1, 2, 3, 4, 5] // Mon-Fri default
                };

                // Create a copy of the nodes to work with
                let updatedNodes = [...nodes];

                console.log(`Applying changes to ${modifiedNodes.length} nodes and updating successor dates`);

                // Process each modified node - update all dates using forward pass
                // Update successor and predecessor maps if needed
                const succMap = window.cybereumState?.succMap || buildSuccessorMap(links, updatedNodes);
                const predMap = window.cybereumState?.predMap || buildPredecessorMap(links, updatedNodes);

                // Get or create topological order
                const topoOrder = window.cybereumState?.slackResults?.topoOrder ||
                    calculateTopologicalSort(updatedNodes, succMap, predMap);

                // Create a node map for easier lookup
                const nodeMap = new Map(updatedNodes.map(n => [n.ID, n]));

                // Calculate early dates with the updated durations
                const { earliestStart, earliestFinish } = calculateEarlyDates(
                    nodeMap, succMap, predMap, topoOrder
                );

                // Find project finish (maximum EF among all end nodes)
                let projectFinish = 0;
                nodeMap.forEach((node, nodeId) => {
                    const successors = succMap.get(nodeId) || [];
                    if (successors.length === 0) {
                        projectFinish = Math.max(projectFinish, earliestFinish.get(nodeId));
                    }
                });

                // Update all node dates
                const startDate = new Date(window.cybereumState.startDate);
                updatedNodes.forEach(node => {
                    const es = earliestStart.get(node.ID);
                    const ef = earliestFinish.get(node.ID);

                    // Calculate actual dates
                    const startTime = new Date(startDate);
                    startTime.setHours(startTime.getHours() + es);
                    node.Start = startTime.toISOString();

                    const finishTime = new Date(startDate);
                    finishTime.setHours(finishTime.getHours() + ef);
                    node.Finish = finishTime.toISOString();
                });

                // Update global state with the new nodes
                if (window.cybereumState) {
                    // Update node map
                    window.cybereumState.nodeMap = new Map(updatedNodes.map(n => [n.ID, n]));

                    // Update end date from end node
                    const endNodeId = window.cybereumState.endNode?.ID;
                    const endNode = updatedNodes.find(n => n.ID === endNodeId);
                    if (endNode && endNode.Finish) {
                        window.cybereumState.endDate = new Date(endNode.Finish);
                    }

                    console.log("Updated global node map and end date");
                }

                // Update the original durations to reflect new baseline
                updatedNodes.forEach(node => {
                    this.state.originalDurations.set(node.ID, {
                        duration: node.Duration,
                        resources: node.resourcesRequired || 1
                    });
                });

                // Reset resource changes since they're now incorporated
                this.state.resourceChanges.clear();

                // Recalculate critical path using existing utility function if available
                if (typeof window.calculateCriticalPath === 'function') {
                    window.calculateCriticalPath(updatedNodes, links);
                    console.log("Recalculated critical path");
                } else if (typeof findCriticalPath === 'function') {
                    const startNodeId = "0";
                    const endNodeId = window.cybereumState.endNode?.ID;

                    if (startNodeId && endNodeId) {
                        const nodeMap = new Map(updatedNodes.map(n => [n.ID, n]));
                        const criticalPathResult = findCriticalPath(nodeMap, links, startNodeId, endNodeId);
                        window.cybereumState.criticalPathResult = criticalPathResult;
                        console.log("Recalculated critical path using findCriticalPath");
                    }
                }

                // Recalculate outlier paths using existing utility function if available
                if (typeof window.calculateOutlierPaths === 'function') {
                    window.calculateOutlierPaths(updatedNodes, links);
                    console.log("Recalculated outlier paths");
                } else if (typeof findAllPaths === 'function' && typeof findOutlierPaths2 === 'function') {
                    const startNodeId = "0";
                    const endNodeId = window.cybereumState.endNode?.ID;

                    if (startNodeId && endNodeId) {
                        const startNode = updatedNodes.find(n => n.ID === startNodeId);
                        const endNode = updatedNodes.find(n => n.ID === endNodeId);

                        if (startNode && endNode) {
                            const allPathsResult = findAllPaths(startNode, endNode, links, updatedNodes, true);
                            const outlierPathsResult = findOutlierPaths2(allPathsResult, links, updatedNodes);
                            window.cybereumState.outlierPathsResult = outlierPathsResult;
                            console.log("Recalculated outlier paths using findAllPaths and findOutlierPaths2");
                        }
                    }
                }

                // Update UI to reflect the changes
                this.state.originalEndDate = new Date(window.cybereumState.endDate);
                this.state.projectedEndDate = new Date(window.cybereumState.endDate);

                // Re-extract path information
                this.extractPathInformation();

                // Recalculate impact scores with new critical paths
                this.calculateImpactScores();

                // Render interface
                this.renderInterface();

                // Reattach AI analysis buttons after rendering interface
                this.attachAIAnalysisHandlers();

                // Reload AI feedback
                this.loadAllAIFeedback();

                // Show success message
                alert('Schedule optimization changes have been applied successfully!');
            }
        },

        /**
         * Runs optimization algorithm to find the best resource allocation
         * Using a genetic algorithm approach to maximize net project benefit
         */
        runScheduleOptimization() {
            console.log("Running automated schedule optimization...");

            // Store original state to be able to compare results
            const originalChanges = new Map(this.state.resourceChanges);

            // Reset current changes to start fresh
            this.state.resourceChanges.clear();

            // Get daily savings value from input
            const dailySavings = parseFloat(document.getElementById('dailySavings')?.value || this.state.dailySavings);
            const hasDailySavings = dailySavings > 0;

            // Store which tasks are eligible for optimization
            const optimizableTasks = this.getOptimizableTasks();
            if (optimizableTasks.length === 0) {
                return {
                    success: false,
                    reason: "No optimizable tasks found. Tasks must be incomplete and not resource-constrained."
                };
            }

            // Create a set of optimizable task IDs for quick lookup
            const optimizableTaskIds = new Set(optimizableTasks.map(task => task.ID));

            // Maximum resources per task
            const getMaxAdditionalResources = (taskId) => {
                try {
                    if (typeof this.getMaxResourcesForTask === 'function') {
                        const m = Number(this.getMaxResourcesForTask(taskId));
                        return Number.isFinite(m) ? Math.max(0, Math.floor(m)) : 5;
                    }
                } catch (e) { /* ignore */ }
                return 5;
            };

            // Get critical path tasks
            const criticalTasks = Array.from(this.state.criticalTasks.keys());
            const nearCriticalTasks = Array.from(this.state.outlierTasks.keys());

            // If no critical path tasks, can't optimize
            if (criticalTasks.length === 0) {
                return {
                    success: false,
                    reason: "No critical path tasks found. Cannot optimize without critical path."
                };
            }

            // Get baseline schedule data
            const baselineDuration = this.getOriginalPathLengths('critical')[0]?.duration || 0;

            // Only proceed if we have a valid baseline duration
            if (baselineDuration <= 0) {
                return {
                    success: false,
                    reason: "Invalid baseline duration. Cannot optimize."
                };
            }

            console.log("Starting genetic algorithm optimization...");
            console.log("Baseline duration:", baselineDuration, "days");
            console.log("Critical tasks:", criticalTasks.length);
            console.log("Near-critical tasks:", nearCriticalTasks.length);
            console.log("Daily savings value:", dailySavings);

            // Parameters for genetic algorithm
            const POPULATION_SIZE = 30;
            const MAX_GENERATIONS = 20;
            const MUTATION_RATE = 0.2;
            const CROSSOVER_RATE = 0.7;
            const ELITISM_COUNT = 5;

            // Create initial population
            let population = [];
            for (let i = 0; i < POPULATION_SIZE; i++) {
                // For initial population, focus on critical path tasks
                const solution = new Map();

                // Randomly assign resources to critical tasks with higher probability
                optimizableTasks.forEach(task => {
                    const isCritical = this.state.criticalTasks.has(task.ID);
                    const isNearCritical = this.state.outlierTasks.has(task.ID);

                    // Higher chance to add resources to critical tasks
                    const chance = isCritical ? 0.7 : isNearCritical ? 0.3 : 0.1;

                    if (Math.random() < chance) {
                        // Assign 1..max additional resources (per-task, AI-constrained when available)
                        const maxRes = getMaxAdditionalResources(task.ID);
                        if (maxRes > 0) {
                            const resources = 1 + Math.floor(Math.random() * maxRes);
                            solution.set(task.ID, resources);
                        }
                    }
                });

                population.push(solution);
            }

            // Optimization loop - genetic algorithm
            let bestSolution = null;
            let bestFitness = -Infinity;

            for (let generation = 0; generation < MAX_GENERATIONS; generation++) {
                // Evaluate fitness for each solution
                const fitnessScores = [];

                for (const solution of population) {
                    // Apply solution to state temporarily
                    this.state.resourceChanges = new Map(solution);

                    // Calculate new duration
                    const optimizedPaths = this.getOptimizedPathLengths('critical');
                    const newDuration = optimizedPaths[0]?.duration || baselineDuration;
                    const reduction = baselineDuration - newDuration;

                    // Calculate cost
                    let totalCost = 0;
                    const hoursPerDay = window.cybereumState?.teamCalendar?.hoursPerDay || 8;

                    solution.forEach((resourceChange, nodeId) => {
                        const node = nodes.find(n => n.ID === nodeId);
                        if (!node) return;

                        const taskRate = this.state.taskRates.get(nodeId) || this.state.resourceRate;
                        const durationSaving = this.calculateScheduleImpact(nodeId, resourceChange);
                        const updatedDuration = node.Duration - durationSaving;

                        totalCost += resourceChange * taskRate * hoursPerDay * updatedDuration;
                    });

                    // Calculate fitness
                    let fitness;
                    if (hasDailySavings) {
                        // Maximize net benefit
                        const savings = reduction * dailySavings;
                        fitness = savings - totalCost;
                    } else {
                        // Minimize cost per day saved
                        fitness = reduction > 0 ? -totalCost / reduction : -Infinity;
                    }

                    fitnessScores.push({ solution, fitness, reduction, cost: totalCost });

                    // Update best solution if better
                    if (fitness > bestFitness) {
                        bestFitness = fitness;
                        bestSolution = new Map(solution);

                        console.log(`Generation ${generation + 1}: Found better solution with fitness ${fitness.toFixed(2)}`);
                        console.log(`Duration reduction: ${reduction.toFixed(2)} days, Cost: ${totalCost.toFixed(2)}`);
                    }
                }

                // Sort solutions by fitness
                fitnessScores.sort((a, b) => b.fitness - a.fitness);

                // Keep track of best solution
                const bestInGeneration = fitnessScores[0];
                console.log(`Generation ${generation + 1} best: Fitness ${bestInGeneration.fitness.toFixed(2)}, Reduction ${bestInGeneration.reduction.toFixed(2)} days, Cost ${bestInGeneration.cost.toFixed(2)}`);

                // Create next generation
                const nextPopulation = [];

                // Elitism - keep best solutions
                for (let i = 0; i < ELITISM_COUNT && i < fitnessScores.length; i++) {
                    nextPopulation.push(fitnessScores[i].solution);
                }

                // Fill rest of population with crossover and mutation
                while (nextPopulation.length < POPULATION_SIZE) {
                    // Selection - tournament selection
                    const parent1 = this.tournamentSelection(fitnessScores);
                    const parent2 = this.tournamentSelection(fitnessScores);

                    // Crossover
                    let child;
                    if (Math.random() < CROSSOVER_RATE) {
                        child = this.crossover(parent1, parent2, optimizableTaskIds);
                    } else {
                        // No crossover, just clone parent1
                        child = new Map(parent1);
                    }

                    // Mutation
                    if (Math.random() < MUTATION_RATE) {
                        this.mutate(child, optimizableTaskIds);
                    }

                    nextPopulation.push(child);
                }

                // Replace population
                population = nextPopulation;
            }

            // If no improvement, revert to original state
            if (!bestSolution || bestFitness <= 0) {
                this.state.resourceChanges = originalChanges;
                return {
                    success: false,
                    reason: "No beneficial optimization found. Either the critical path tasks cannot be optimized or the costs exceed the benefits."
                };
            }

            // Apply best solution
            this.state.resourceChanges = bestSolution;

            // Calculate final metrics
            const optimizedPaths = this.getOptimizedPathLengths('critical');
            const finalDuration = optimizedPaths[0]?.duration || baselineDuration;
            const finalReduction = baselineDuration - finalDuration;

            // Calculate cost
            let finalCost = 0;
            const hoursPerDay = window.cybereumState?.teamCalendar?.hoursPerDay || 8;

            bestSolution.forEach((resourceChange, nodeId) => {
                const node = nodes.find(n => n.ID === nodeId);
                if (!node) return;

                const taskRate = this.state.taskRates.get(nodeId) || this.state.resourceRate;
                const durationSaving = this.calculateScheduleImpact(nodeId, resourceChange);
                const updatedDuration = node.Duration - durationSaving;

                finalCost += resourceChange * taskRate * hoursPerDay * updatedDuration;
            });

            // Calculate final net benefit
            const finalSavings = finalReduction * dailySavings;
            const finalNetBenefit = finalSavings - finalCost;

            // Update UI
            this.updateSummary();
            this.updatePathVisualization();
            this.updateProjectEndDate();

            // Update all UI elements
            document.querySelectorAll('.resource-slider').forEach(slider => {
                const taskId = slider.dataset.taskId;
                const newValue = this.state.resourceChanges.get(taskId) || 0;
                slider.value = newValue;

                // Update resource value display
                const valueSpan = slider.parentElement.querySelector('.resource-value');
                if (valueSpan) valueSpan.textContent = newValue;
            });

            // Update all cells with duration savings, costs, and value ratios
            optimizableTasks.forEach(task => {
                const taskId = task.ID;

                // Update duration saving
                const savingCell = document.querySelector(`.duration-saving[data-task-id="${taskId}"]`);
                if (savingCell) {
                    savingCell.textContent = this.calculateSavingDisplay(taskId);
                }

                // Update cost impact
                const costCell = document.querySelector(`.cost-impact[data-task-id="${taskId}"]`);
                if (costCell) {
                    costCell.textContent = this.calculateCostDisplay(taskId);
                }

                // Update value ratio
                const valueRatioCell = document.querySelector(`.value-ratio[data-task-id="${taskId}"]`);
                if (valueRatioCell) {
                    valueRatioCell.innerHTML = this.calculateValueRatioDisplay(taskId);
                }
            });

            // Calculate calendar days equivalent
            const calendarDaysReduction = Math.round((this.state.originalEndDate - this.state.projectedEndDate) / (24 * 60 * 60 * 1000));

            return {
                success: true,
                scheduleReduction: finalReduction,
                calendarDaysReduction: calendarDaysReduction,
                totalCost: finalCost,
                netBenefit: finalNetBenefit
            };
        },

        /**
         * Tournament selection for genetic algorithm
         */
        tournamentSelection(fitnessScores) {
            const TOURNAMENT_SIZE = 3;
            let best = null;

            // Select TOURNAMENT_SIZE random individuals and pick the best
            for (let i = 0; i < TOURNAMENT_SIZE; i++) {
                const randomIndex = Math.floor(Math.random() * fitnessScores.length);
                const candidate = fitnessScores[randomIndex];

                if (!best || candidate.fitness > best.fitness) {
                    best = candidate;
                }
            }

            return best.solution;
        },

        /**
         * Crossover two parent solutions to create a child solution
         */
        crossover(parent1, parent2, optimizableTaskIds) {
            const child = new Map();

            // Uniform crossover - for each task, randomly choose from either parent
            for (const taskId of optimizableTaskIds) {
                if (Math.random() < 0.5) {
                    // Take from parent1
                    if (parent1.has(taskId)) {
                        child.set(taskId, parent1.get(taskId));
                    }
                } else {
                    // Take from parent2
                    if (parent2.has(taskId)) {
                        child.set(taskId, parent2.get(taskId));
                    }
                }
            }

            return child;
        },

        /**
         * Mutate a solution by randomly changing resource allocations
         */
        mutate(solution, optimizableTaskIds) {
            // Convert optimizableTaskIds to array for random selection
            const taskIdsArray = Array.from(optimizableTaskIds);

            // Number of mutations is random, but at least 1
            const mutationCount = 1 + Math.floor(Math.random() * 3);

            for (let i = 0; i < mutationCount; i++) {
                // Select a random task
                const randomIndex = Math.floor(Math.random() * taskIdsArray.length);
                const taskId = taskIdsArray[randomIndex];


                const maxResources = (() => {
                    try {
                        if (typeof this.getMaxResourcesForTask === 'function') {
                            const m = Number(this.getMaxResourcesForTask(taskId));
                            return Number.isFinite(m) ? Math.max(0, Math.floor(m)) : 5;
                        }
                    } catch (e) { /* ignore */ }
                    return 5;
                })();
                // Different mutation types
                const mutationType = Math.random();

                if (mutationType < 0.3) {
                    // Remove resources (set to 0)
                    solution.delete(taskId);
                } else if (mutationType < 0.7) {
                    // Add resources or change existing allocation
                    if (maxResources > 0) {
                        const resources = 1 + Math.floor(Math.random() * maxResources);
                        solution.set(taskId, resources);
                    }
                } else {
                    // Increment or decrement existing allocation
                    if (solution.has(taskId)) {
                        let resources = solution.get(taskId);

                        if (Math.random() < 0.5) {
                            // Increment
                            resources = Math.min(resources + 1, maxResources);
                        } else {
                            // Decrement
                            resources = Math.max(resources - 1, 0);
                        }

                        if (resources === 0) {
                            solution.delete(taskId);
                        } else {
                            solution.set(taskId, resources);
                        }
                    } else {
                        // If no existing allocation, add 1 resource
                        if (maxResources > 0) {
                            solution.set(taskId, 1);
                        } else {
                            solution.delete(taskId);
                        }
                    }
                }
            }
        },

        /**
         * Attach event handlers for UI elements
         */
        attachEventHandlers() {
            // Attach AI Analysis button handlers
            this.attachAIAnalysisHandlers();

            // Handle resource rate changes
            const resourceRateInput = document.getElementById('resourceRate');
            if (resourceRateInput) {
                resourceRateInput.addEventListener('change', () => {
                    const newRate = parseFloat(resourceRateInput.value) || 100;
                    this.state.resourceRate = newRate;

                    // Update cost cells for all tasks using the default rate
                    nodes.forEach(node => {
                        const resourceChange = this.state.resourceChanges.get(node.ID) || 0;
                        if (resourceChange <= 0) return;

                        // Only update if the task is using the default rate
                        if (!this.state.taskRates.get(node.ID) ||
                            this.state.taskRates.get(node.ID) === this.state.resourceRate) {

                            // Update the task rate
                            this.state.taskRates.set(node.ID, newRate);

                            // Update cost cell
                            const costCell = document.querySelector(`.cost-impact[data-task-id="${node.ID}"]`);
                            if (costCell) {
                                costCell.textContent = this.calculateCostDisplay(node.ID);
                            }

                            // Update value ratio
                            const valueRatioCell = document.querySelector(`.value-ratio[data-task-id="${node.ID}"]`);
                            if (valueRatioCell) {
                                valueRatioCell.innerHTML = this.calculateValueRatioDisplay(node.ID);
                            }
                        }
                    });

                    // Update summary
                    this.updateSummary();
                });
            }

            // Handle daily savings changes
            const dailySavingsInput = document.getElementById('dailySavings');
            if (dailySavingsInput) {
                dailySavingsInput.addEventListener('change', () => {
                    this.state.dailySavings = parseFloat(dailySavingsInput.value) || 0;

                    // Update value ratios for all tasks with resource changes
                    nodes.forEach(node => {
                        const resourceChange = this.state.resourceChanges.get(node.ID) || 0;
                        if (resourceChange <= 0) return;

                        // Update value ratio cell
                        const valueRatioCell = document.querySelector(`.value-ratio[data-task-id="${node.ID}"]`);
                        if (valueRatioCell) {
                            valueRatioCell.innerHTML = this.calculateValueRatioDisplay(node.ID);
                        }
                    });

                    // Update summary
                    this.updateSummary();
                });
            }

            // Attach reset handler
            const resetButton = document.getElementById('resetOptimization');
            if (resetButton) {
                resetButton.addEventListener('click', () => this.resetOptimization());
            }

            // Attach auto optimize handler
            const autoOptimizeButton = document.getElementById('autoOptimization');
            if (autoOptimizeButton) {
                autoOptimizeButton.addEventListener('click', () => {
                    // Run the optimization algorithm
                    const result = this.runScheduleOptimization();

                    // Handle different results
                    if (result) {
                        if (result.success) {
                            const dailySavings = parseFloat(document.getElementById('dailySavings')?.value || this.state.dailySavings);
                            const message = `Optimization complete!\n\n` +
                                `- Schedule reduction: ${result.scheduleReduction.toFixed(1)} working days\n` +
                                `- Calendar days equivalent: ${result.calendarDaysReduction.toFixed(1)} calendar days\n` +
                                `- Total resource cost: ${this.state.currency}${result.totalCost.toLocaleString()}\n` +
                                (dailySavings > 0 ? `- Net project benefit: ${this.state.currency}${result.netBenefit.toLocaleString()}\n` : '') +
                                `\nResources have been automatically allocated to optimize the schedule.`;

                            alert(message);
                        } else {
                            // Show failure reason
                            alert(`Optimization could not improve the schedule.\n\nReason: ${result.reason}`);
                        }
                    }
                });
            }
            // NEW: Attach AI Analysis button handlers
            this.attachAIAnalysisHandlers();

            // NEW: Attach optimization mode handlers
            this.attachOptimizationModeHandlers();

            // NEW: Attach target optimization handlers
            this.attachTargetOptimizationHandlers();

            // Attach apply changes handler
            const applyButton = document.getElementById('applyOptimization');
            if (applyButton) {
                applyButton.addEventListener('click', () => this.applyOptimization());
            }
        },

        /**
 * Attach handlers for switching between optimization modes
 */
        attachOptimizationModeHandlers() {
            const modeButtons = document.querySelectorAll('.optimization-mode');
            const targetSection = document.getElementById('targetOptimizationSection');
            const manualTable = document.querySelector('.optimization-controls');

            modeButtons.forEach(button => {
                button.addEventListener('click', () => {
                    // Update active state
                    modeButtons.forEach(b => b.classList.remove('active'));
                    button.classList.add('active');

                    // Show/hide relevant sections
                    const mode = button.dataset.mode;
                    if (mode === 'target') {
                        targetSection.style.display = 'block';
                        manualTable.style.display = 'none';
                    } else {
                        targetSection.style.display = 'none';
                        manualTable.style.display = 'block';
                    }
                });
            });
        },

        /**
 * Attach handlers for target optimization controls
 */
        attachTargetOptimizationHandlers() {
            // Set default target date (1 month before current end date)
            const targetDateInput = document.getElementById('targetDate');
            if (targetDateInput && this.state.originalEndDate) {
                const targetDate = new Date(this.state.originalEndDate);
                targetDate.setDate(targetDate.getDate() - 30); // 30 days earlier

                // Format date for input: YYYY-MM-DD
                const year = targetDate.getFullYear();
                const month = String(targetDate.getMonth() + 1).padStart(2, '0');
                const day = String(targetDate.getDate()).padStart(2, '0');
                targetDateInput.value = `${year}-${month}-${day}`;
            }

            // Handle run target optimization button
            const runButton = document.getElementById('runTargetOptimization');
            if (runButton) {
                runButton.addEventListener('click', () => {
                    this.runTargetOptimization();
                });
            }

            // Handle reset button
            const resetButton = document.getElementById('resetTargetOptimization');
            if (resetButton) {
                resetButton.addEventListener('click', () => {
                    this.resetTargetOptimization();
                });
            }

            // Handle target type radio buttons
            const radioButtons = document.querySelectorAll('input[name="targetType"]');
            radioButtons.forEach(radio => {
                radio.addEventListener('change', () => {
                    const targetType = document.querySelector('input[name="targetType"]:checked').value;
                    const reductionInput = document.getElementById('targetReduction');
                    const dateInput = document.getElementById('targetDate');

                    if (targetType === 'reduction') {
                        reductionInput.disabled = false;
                        dateInput.disabled = true;
                    } else {
                        reductionInput.disabled = true;
                        dateInput.disabled = false;
                    }
                });
            });
        },

        /**
 * Run target-based optimization based on user inputs
 */
        runTargetOptimization() {
            // Get target type
            const targetType = document.querySelector('input[name="targetType"]:checked').value;

            // Get target value based on type
            let target;
            if (targetType === 'reduction') {
                target = Number(document.getElementById('targetReduction').value);
                if (isNaN(target) || target <= 0) {
                    alert('Please enter a valid reduction amount (greater than 0)');
                    return;
                }
            } else {
                const dateInput = document.getElementById('targetDate').value;
                if (!dateInput) {
                    alert('Please select a target date');
                    return;
                }
                target = new Date(dateInput);

                // Validate date is not in the past or after current end date
                const today = window.cybereumState.dataDate || new Date();
                if (target < today) {
                    alert('Target date cannot be in the past');
                    return;
                }

                if (target >= this.state.originalEndDate) {
                    alert('Target date must be earlier than the current end date');
                    return;
                }
            }

            // Get optimization options
            const minimizeCost = document.getElementById('minimizeCost').checked;
            const maxTaskResources = Number(document.getElementById('maxTaskResources').value) || 3;

            // Run optimization
            const options = {
                minimizeCost,
                maxTaskResources
            };

            // Show loading indication
            const runButton = document.getElementById('runTargetOptimization');
            if (runButton) {
                const originalText = runButton.innerHTML;
                runButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Optimizing...';
                runButton.disabled = true;

                // Use setTimeout to allow UI to update
                setTimeout(() => {
                    // Run the optimization
                    const result = this.findOptimalSolution(target, targetType, options);

                    // Restore button
                    runButton.innerHTML = originalText;
                    runButton.disabled = false;

                    // Handle result
                    this.displayTargetOptimizationResults(result);

                    // Update all UI elements to reflect the optimization
                    this.updateSummary();
                    this.updatePathVisualization();

                    // Update slider positions to match solution
                    document.querySelectorAll('.resource-slider').forEach(slider => {
                        const taskId = slider.dataset.taskId;
                        const resourceChange = this.state.resourceChanges.get(taskId) || 0;

                        // Update slider value
                        slider.value = resourceChange;

                        // Update value display
                        const valueSpan = slider.parentElement.querySelector('.resource-value');
                        if (valueSpan) {
                            valueSpan.textContent = resourceChange;
                        }

                        // Update duration saving, cost impact, value ratio cells
                        const taskRow = slider.closest('tr');
                        if (taskRow) {
                            const savingCell = taskRow.querySelector('.duration-saving');
                            if (savingCell) {
                                savingCell.textContent = this.calculateSavingDisplay(taskId);
                            }

                            const costCell = taskRow.querySelector('.cost-impact');
                            if (costCell) {
                                costCell.textContent = this.calculateCostDisplay(taskId);
                            }

                            const valueRatioCell = taskRow.querySelector('.value-ratio');
                            if (valueRatioCell) {
                                valueRatioCell.innerHTML = this.calculateValueRatioDisplay(taskId);
                            }
                        }
                    });
                }, 10);
            }
        },
        /**
 * Display the results of target optimization
 */
        displayTargetOptimizationResults(result) {
            const resultsContainer = document.getElementById('targetResults');
            if (!resultsContainer) return;

            if (!result.success) {
                alert(`Optimization failed: ${result.reason}`);
                return;
            }

            // Show results container
            resultsContainer.style.display = 'block';

            // Update result fields
            const reductionElement = document.getElementById('targetResultReduction');
            const costElement = document.getElementById('targetResultCost');
            const dateElement = document.getElementById('targetResultDate');
            const summaryElement = document.getElementById('targetResultSummary');

            if (reductionElement) {
                reductionElement.textContent = `${result.reduction.toFixed(1)} days`;
                if (!result.targetMet) {
                    reductionElement.textContent += ' (partial)';
                }
            }

            if (costElement) {
                costElement.textContent = `${this.state.currency}${result.cost.toLocaleString()}`;
            }

            if (dateElement) {
                dateElement.textContent = window.scheduleUtils.formatCalendarDate(result.endDate);
            }

            if (summaryElement) {
                const targetType = document.querySelector('input[name="targetType"]:checked').value;
                let targetText;

                if (targetType === 'reduction') {
                    const targetDays = Number(document.getElementById('targetReduction').value);
                    targetText = `${targetDays} days reduction`;
                } else {
                    const targetDate = new Date(document.getElementById('targetDate').value);
                    targetText = `completion by ${window.scheduleUtils.formatCalendarDate(targetDate)}`;
                }

                let summary;
                if (result.targetMet) {
                    summary = `Successfully optimized to meet target of ${targetText}. `;
                } else {
                    summary = `Partially optimized but could not fully meet target of ${targetText}. `;
                }

                summary += `Added resources to ${result.taskCount} tasks (${result.resourceCount} total resources) for a cost of ${this.state.currency}${result.cost.toLocaleString()}.`;

                summaryElement.textContent = summary;
            }
        },

        /**
 * Reset the target optimization
 */
        resetTargetOptimization() {
            // Clear resource changes
            this.state.resourceChanges.clear();

            // Reset UI elements
            const resultsContainer = document.getElementById('targetResults');
            if (resultsContainer) {
                resultsContainer.style.display = 'none';
            }

            // Reset sliders in manual optimization section
            document.querySelectorAll('.resource-slider').forEach(slider => {
                slider.value = 0;

                // Update value display
                const valueSpan = slider.parentElement.querySelector('.resource-value');
                if (valueSpan) {
                    valueSpan.textContent = '0';
                }
            });

            // Reset duration saving, cost impact, value ratio cells
            document.querySelectorAll('.duration-saving').forEach(cell => {
                const task = nodes.find(n => n.ID === cell.dataset.taskId);
                const timeUnits = task?.TimeUnits || 'days';
                cell.textContent = `0 ${timeUnits}`;
            });

            document.querySelectorAll('.cost-impact').forEach(cell => {
                cell.textContent = `${this.state.currency}0`;
            });

            document.querySelectorAll('.value-ratio').forEach(cell => {
                cell.textContent = 'N/A';
            });

            // Update summary and visualizations
            this.updateSummary();
            this.updatePathVisualization();
            this.updateProjectEndDate();
        },
        /**
         * Attaches event listeners to AI Analysis buttons
         */
        attachAIAnalysisHandlers() {
            // Wait for the DOM to be updated with the buttons
            setTimeout(() => {
                const aiButtons = document.querySelectorAll('.ai-analysis-button');
                aiButtons.forEach(button => {
                    button.addEventListener('click', (e) => {
                        const taskId = e.currentTarget.dataset.taskId;
                        if (!taskId) return;

                        console.log(`Opening AI analysis for task ${taskId}`);

                        // Check if the openTaskFeedbackModal function is available
                        if (typeof window.openTaskFeedbackModal === 'function') {
                            // Call the modal with "optimization" mode
                            window.openTaskFeedbackModal(taskId, nodes, links, 'optimization');
                        } else {
                            console.error('openTaskFeedbackModal function not found');
                            alert('AI analysis feature is not available');
                        }
                    });
                });

                console.log(`Attached handlers to ${aiButtons.length} AI analysis buttons`);
            }, 100); // Short delay to ensure the DOM is updated
        }
    };

    // Make the optimizer available globally for event handlers
    window.scheduleOptimizer = scheduleOptimizer;

    // AI Resource Modeling Enhancement (resource-specific rates & availability)
    if (window.aiResourceModeling && typeof window.aiResourceModeling.enhance === 'function') {
        try {
            window.aiResourceModeling.enhance(scheduleOptimizer);
        } catch (e) {
            console.warn('[AI Resource] Enhancement failed to initialize:', e);
        }
    }
    scheduleOptimizer.initialize();

    return scheduleOptimizer;
}
/**
 * Enhanced Monte Carlo Simulation Interface
 * 
 * Provides project risk analysis through statistical simulation with these improvements:
 * - Multiple probability distributions for different risk profiles
 * - Complete handling of all relationship types (FS, SS, FF, SF)
 * - Calendar-aware date calculations for accurate end date predictions
 * - Improved visualizations for better decision-making
 * - Resource-constrained simulation for enhanced realism
 * - Maximum efficiency by leveraging pre-computed critical paths
 * - Consistent use of utility functions for schedule calculations
 * - Proper handling of all relationship types (FS, SS, FF, SF)
 * - Calendar-aware date calculations for accurate end date predictions
 *
 * @param {Array} nodes - Array of project tasks with durations and risk parameters
 * @param {Array} links - Array of dependencies between nodes
 * @returns {Object} - Monte Carlo simulator object with methods to run simulations
 */
function createMonteCarloSimulationInterface(nodes, links) {
    const simulator = {
        state: {
            originalDurations: new Map(), // Maps node ID to duration and risk data
            simulationResults: [],        // Array of project finish times from each iteration
            simulationSummary: null,      // Summary statistics (mean, median, percentiles)
            projectEndDates: [],          // Array of projected end dates from each iteration
            nodeData: new Map(),          // Expanded node data including critical path info
            criticalPaths: [],            // Critical paths identified in the project
            nearCriticalPaths: [],        // Near-critical paths identified
            taskEndDates: new Map(),      // Distribution of end dates for each task
            resourceUsage: [],            // Resource usage over time
            currentSimulationProgress: 0, // Progress tracking for ongoing simulation (0-100)
            isSimulationRunning: false,   // Flag to track if simulation is in progress
            simulationStart: null,        // Timestamp of simulation start
            simulationHistogramData: null,// Data for histogram plot
            sensitivityAnalysis: null,    // Task sensitivity to duration variations
            displayUnit: 'hours',         // Current display unit (hours/days/dates)
            projectStartDate: null,       // Project start date
            projectWorkCalendar: null,    // Project work calendar
            pathAnalysis: null,           // Analysis of path structure before simulation
            confidenceLevels: [10, 50, 80, 90, 95, 99] // Confidence levels for reporting
        },

        /**
         * Initialize the simulator by recording baseline durations and risk parameters
         */
        initialize() {
            console.log("Initializing Monte Carlo simulator...");

            // Get project start date and work calendar
            this.getProjectDateInfo();

            // Store original durations and risk data for each node
            nodes.forEach(node => {
                // Calculate default min/mode/max durations if not provided
                const baseline = node.Duration || 0;
                let minDuration = node.minDuration || (baseline * 0.8);
                let modeDuration = node.modeDuration || baseline;
                let maxDuration = node.maxDuration || (baseline * 1.2);

                // Adjust range based on risk score: higher risk = wider range
                if (node.ComputedRiskScore) {
                    const riskFactor = Math.max(node.ComputedRiskScore, 0.1);
                    if (!node.minDuration) {
                        minDuration = baseline * (1 - (riskFactor * 0.5));
                    }
                    if (!node.maxDuration) {
                        maxDuration = baseline * (1 + (riskFactor * 1.5));
                    }
                }

                // NEW: Extract resource-related parameters
                const resourcesRequired = Number(node.resourcesRequired) || 1;
                const resourceEfficiency = Number(node.resourceEfficiency) || 1.0;
                const resourceConstraint = node.isResourceConstrained || false;

                // NEW: Extract resource calendar if available
                const resourceCalendar = node.resourceCalendar || this.state.projectWorkCalendar;

                // Store task information including risk, duration, and resource parameters
                this.state.originalDurations.set(node.ID, {
                    baseline: baseline,
                    riskScore: node.ComputedRiskScore || node.riskScore || 0,
                    distParams: {
                        min: minDuration,
                        mode: modeDuration,
                        max: maxDuration
                    },
                    isRiskOutlier: node.isRiskOutlier || false,
                    overrunProbability: node.overrun_probability || 0,
                    units: node.TimeUnits || "Hours",
                    percentComplete: node.PercentComplete ? parseFloat(node.PercentComplete) : 0,
                    // NEW: Enhanced resource information
                    resources: resourcesRequired,
                    resourceEfficiency: resourceEfficiency,
                    isResourceConstrained: resourceConstraint,
                    resourceCalendar: resourceCalendar,
                    distribution: node.durationDistribution || this.determineDistribution(node)
                });

                // Store expanded node data for later use
                this.state.nodeData.set(node.ID, {
                    name: node.Name,
                    isCritical: node.isCritical || node.isOnCriticalPath || false,
                    isOnOutlierPath: node.isOnOutlierPath || false,
                    description: node.Description || "",
                    // NEW: Include resource information in node data
                    resourcesRequired: resourcesRequired,
                    resourceConstraint: resourceConstraint
                });
            });

            // Extract critical and near-critical paths from cybereum state if available
            this.extractPathInformation();

            // NEW: Validate paths to filter out invalid SF relationships
            this.validatePaths();

            // Initialize task end dates map
            nodes.forEach(node => {
                this.state.taskEndDates.set(node.ID, []);
            });

            // Run path analysis to provide insights
            this.analyzePathStructure();

            console.log("Monte Carlo simulator initialized with", nodes.length, "tasks");
        },

        /**
         * Clean up all resources when simulator is destroyed
         * Call this when switching projects or unmounting the simulator
         */
        destroy() {
            console.log('[MonteCarloSimulator] Starting cleanup...');

            // Stop any running simulation
            this.state.isSimulationRunning = false;

            // Clear all state Maps
            this.state.originalDurations.clear();
            this.state.nodeData.clear();
            this.state.taskEndDates.clear();

            // Clear large arrays (important for memory)
            this.state.simulationResults = [];
            this.state.projectEndDates = [];
            this.state.resourceUsage = [];
            this.state.criticalPaths = [];
            this.state.nearCriticalPaths = [];

            // Clear simulation data objects
            this.state.simulationSummary = null;
            this.state.simulationHistogramData = null;
            this.state.sensitivityAnalysis = null;
            this.state.pathAnalysis = null;

            // Clear dates
            this.state.projectStartDate = null;
            this.state.simulationStart = null;

            // Reset progress
            this.state.currentSimulationProgress = 0;

            // Remove DOM elements
            if (this.container && this.container.parentNode) {
                this.container.parentNode.removeChild(this.container);
            }
            this.container = null;

            // Remove from global reference
            if (window.monteCarloSimulator === this) {
                window.monteCarloSimulator = null;
            }

            console.log('[MonteCarloSimulator] Cleanup complete - freed large arrays');
        },

        /**
         * Validate paths to remove invalid SF segments and ensure all paths are viable
         */
        validatePaths() {
            const validCriticalPaths = [];
            const validNearCriticalPaths = [];

            // Helper to check for SF relationships in a path
            const hasValidRelationships = (path) => {
                for (let i = 0; i < path.length - 1; i++) {
                    const currentNodeId = typeof path[i] === 'object' ? path[i].ID : path[i];
                    const nextNodeId = typeof path[i + 1] === 'object' ? path[i + 1].ID : path[i + 1];

                    // Check relationship type using succMap
                    const edges = window.cybereumState?.succMap?.get(currentNodeId) || [];
                    const edge = edges.find(e => e.target === nextNodeId);

                    if (edge && edge.type === 'SF') {
                        console.warn(`Path contains invalid SF relationship between ${currentNodeId} and ${nextNodeId}`);
                        return false;
                    }
                }
                return true;
            };

            // Filter critical paths
            this.state.criticalPaths.forEach(path => {
                if (hasValidRelationships(path)) {
                    validCriticalPaths.push(path);
                }
            });

            // Filter near-critical paths
            this.state.nearCriticalPaths.forEach(path => {
                if (hasValidRelationships(path)) {
                    validNearCriticalPaths.push(path);
                }
            });

            // Update state with validated paths
            if (validCriticalPaths.length !== this.state.criticalPaths.length) {
                console.log(`Filtered ${this.state.criticalPaths.length - validCriticalPaths.length} invalid critical paths`);
                this.state.criticalPaths = validCriticalPaths;
            }

            if (validNearCriticalPaths.length !== this.state.nearCriticalPaths.length) {
                console.log(`Filtered ${this.state.nearCriticalPaths.length - validNearCriticalPaths.length} invalid near-critical paths`);
                this.state.nearCriticalPaths = validNearCriticalPaths;
            }
        },
        /**
         * Get project start date and work calendar information
         */
        getProjectDateInfo() {
            // Get project start date
            if (window.cybereumState && window.cybereumState.startDate) {
                // Create date and normalize to midnight to avoid timezone issues
                const startDateStr = window.cybereumState.startDate;
                const startDate = new Date(startDateStr);

                // Log to diagnose any potential issues
                console.log("Raw start date string:", startDateStr);
                console.log("Parsed start date:", startDate);
                console.log("Start date toString():", startDate.toString());
                console.log("Start date toISOString():", startDate.toISOString());

                this.state.projectStartDate = startDate;
            } else {
                // Find earliest start date among nodes as fallback
                let earliestStart = null;
                nodes.forEach(node => {
                    if (node.Start) {
                        const startDate = new Date(node.Start);
                        if (!earliestStart || startDate < earliestStart) {
                            earliestStart = startDate;
                        }
                    }
                });

                // Use current date as absolute last resort
                this.state.projectStartDate = earliestStart || window.cybereumState.dataDate || new Date();
                console.log("Using earliest node start date as project start:", this.state.projectStartDate);
            }
            console.log("Using project start:", this.state.projectStartDate);
            // Get work calendar
            if (window.cybereumState && window.cybereumState.teamCalendar) {
                this.state.projectWorkCalendar = window.cybereumState.teamCalendar;
            } else {
                // Default calendar
                this.state.projectWorkCalendar = {
                    hoursPerDay: DEFAULT_HOURS_PER_DAY || 8,
                    workingDays: [1, 2, 3, 4, 5] // Monday through Friday (0=Sunday)
                };
            }

            console.log("Work calendar:",
                this.state.projectWorkCalendar.hoursPerDay,
                "hours per day,",
                this.state.projectWorkCalendar.workingDays.length,
                "working days per week");
        },

        /**
         * Extract critical and near-critical path information from global state
         */
        extractPathInformation() {
            if (window.cybereumState) {
                // Extract critical paths
                if (window.cybereumState.criticalPathResult &&
                    window.cybereumState.criticalPathResult.paths) {
                    this.state.criticalPaths = window.cybereumState.criticalPathResult.paths.map(path => {
                        return Array.isArray(path) ? path : [path]; // Ensure it's an array
                    });
                    console.log("Extracted", this.state.criticalPaths.length, "critical paths");
                } else {
                    console.log("No critical paths available in global state");
                }

                // Extract near-critical paths
                if (window.cybereumState.outlierPathsResult &&
                    window.cybereumState.outlierPathsResult.paths) {
                    this.state.nearCriticalPaths = window.cybereumState.outlierPathsResult.paths.map(path => {
                        return Array.isArray(path) ? path : [path]; // Ensure it's an array
                    });
                    console.log("Extracted", this.state.nearCriticalPaths.length, "near-critical paths");
                } else {
                    console.log("No near-critical paths available in global state");
                }
            } else {
                console.log("No cybereum state available for path extraction");
            }
        },

        /**
         * Analyze path structure to provide insights before simulation
         */
        analyzePathStructure() {
            const criticalPaths = this.state.criticalPaths;
            const nearCriticalPaths = this.state.nearCriticalPaths;

            if (criticalPaths.length === 0 && nearCriticalPaths.length === 0) {
                console.log("No path information available for analysis");
                return;
            }

            // Count total unique nodes on all paths
            const uniqueNodesSet = new Set();
            const criticalNodesSet = new Set();
            const nearCriticalNodesSet = new Set();

            criticalPaths.forEach(path => {
                path.forEach(node => {
                    const nodeId = typeof node === 'object' ? node.ID : node;
                    criticalNodesSet.add(nodeId);
                    uniqueNodesSet.add(nodeId);
                });
            });

            nearCriticalPaths.forEach(path => {
                path.forEach(node => {
                    const nodeId = typeof node === 'object' ? node.ID : node;
                    nearCriticalNodesSet.add(nodeId);
                    uniqueNodesSet.add(nodeId);
                });
            });

            // Calculate path statistics
            const pathStats = {
                criticalPathCount: criticalPaths.length,
                nearCriticalPathCount: nearCriticalPaths.length,
                criticalNodeCount: criticalNodesSet.size,
                nearCriticalNodeCount: nearCriticalNodesSet.size - criticalNodesSet.size, // Exclude nodes that are also on critical path
                totalUniqueNodes: uniqueNodesSet.size,
                percentageOfNetworkCritical: (uniqueNodesSet.size / nodes.length) * 100,
                pathOverlap: this.calculatePathOverlap(criticalPaths, nearCriticalPaths)
            };

            console.log("Path analysis before simulation:", pathStats);
            this.state.pathAnalysis = pathStats;

            return pathStats;
        },


        /**
                 * Calculate overlap between critical and near-critical paths
                 */
        calculatePathOverlap(criticalPaths, nearCriticalPaths) {
            if (criticalPaths.length === 0 || nearCriticalPaths.length === 0) {
                return 0;
            }

            // Create sets of nodes
            const criticalNodesSet = new Set();
            criticalPaths.forEach(path => {
                path.forEach(node => {
                    const nodeId = typeof node === 'object' ? node.ID : node;
                    criticalNodesSet.add(nodeId);
                });
            });

            const nearCriticalNodesSet = new Set();
            nearCriticalPaths.forEach(path => {
                path.forEach(node => {
                    const nodeId = typeof node === 'object' ? node.ID : node;
                    nearCriticalNodesSet.add(nodeId);
                });
            });

            // Count overlap
            let overlapCount = 0;
            nearCriticalNodesSet.forEach(nodeId => {
                if (criticalNodesSet.has(nodeId)) {
                    overlapCount++;
                }
            });

            // Calculate Jaccard similarity
            const union = new Set([...criticalNodesSet, ...nearCriticalNodesSet]);
            return overlapCount > 0 ? (overlapCount / union.size) * 100 : 0;
        },

        /**
         * Determine best distribution type based on task characteristics
         */
        determineDistribution(node) {
            if (node.durationDistribution) return node.durationDistribution;

            // USE overrun_probability (calibrated) with fallback to riskScore
            const overrunProb = node.overrun_probability || 0;
            const riskScore = node.ComputedRiskScore || node.riskScore || 0;
            const effectiveRisk = overrunProb > 0 ? overrunProb : riskScore;

            const isRiskOutlier = node.isRiskOutlier || false;
            const hasHighUncertainty = effectiveRisk > 0.7 || isRiskOutlier;
            const hasMediumUncertainty = effectiveRisk > 0.4 && effectiveRisk <= 0.7;
            const isNearlyComplete = (node.PercentComplete || 0) >= 90;

            if (isNearlyComplete) return "triangular_narrow";
            if (hasHighUncertainty) return "birnbaum_saunders";
            if (hasMediumUncertainty) return "pert";
            return "triangular";
        },


        /**
         * Choose the appropriate probability distribution for a task based on its risk profile
         * @param {Object} node - The task node
         * @returns {Object} - Distribution type and parameters
         */
        chooseDistribution(node) {
            const record = this.state.originalDurations.get(node.ID);

            if (!record) {
                return {
                    type: "triangular",
                    params: { min: node.Duration * 0.8, mode: node.Duration, max: node.Duration * 1.2 }
                };
            }

            // Nearly completed tasks: narrow distribution
            if (record.percentComplete >= 90) {
                return {
                    type: "triangular",
                    params: { min: record.baseline * 0.95, mode: record.baseline, max: record.baseline * 1.05 }
                };
            }

            const distributionType = record.distribution || "triangular";

            // KEY CHANGE: Use overrunProbability with fallback to riskScore
            const effectiveRisk = record.overrunProbability > 0
                ? record.overrunProbability
                : (record.riskScore || 0);

            switch (distributionType) {
                case "triangular_narrow":
                    return {
                        type: "triangular",
                        params: { min: record.baseline * 0.9, mode: record.baseline, max: record.baseline * 1.1 }
                    };

                case "birnbaum_saunders":
                case "lognormal":
                    // Shape parameter now driven by calibrated overrun probability
                    const shape = 0.5 + (effectiveRisk * 2.0);  // More responsive to overrun data
                    return {
                        type: "birnbaum_saunders",
                        params: { scale: record.baseline, shape: shape }
                    };

                case "pert":
                    // Adjust min/max based on effective risk
                    const riskMultiplier = 1 + effectiveRisk;
                    return {
                        type: "pert",
                        params: {
                            min: record.distParams.min,
                            mode: record.distParams.mode,
                            max: record.distParams.max * riskMultiplier
                        }
                    };

                case "normal":
                    // Std dev proportional to effective risk
                    const stdDev = record.baseline * effectiveRisk * 0.4;
                    return {
                        type: "normal",
                        params: { mean: record.baseline, stdDev: Math.max(stdDev, record.baseline * 0.05) }
                    };

                case "triangular":
                default:
                    // Widen max based on effective risk
                    return {
                        type: "triangular",
                        params: {
                            min: record.distParams.min,
                            mode: record.distParams.mode,
                            max: record.distParams.max * (1 + effectiveRisk * 0.5)
                        }
                    };
            }
        },

        /**
         * Sample from a triangular distribution
         * @param {Number} min - Minimum value
         * @param {Number} mode - Most likely value
         * @param {Number} max - Maximum value
         * @returns {Number} - Sampled value
         */
        sampleTriangular(min, mode, max) {
            const u = Math.random();
            const fc = (mode - min) / (max - min);

            if (u < fc) {
                return min + Math.sqrt(u * (max - min) * (mode - min));
            } else {
                return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
            }
        },

        /**
        * Sample from a PERT distribution (modified Beta distribution)
        * @param {Number} min - Minimum value
        * @param {Number} mode - Most likely value
        * @param {Number} max - Maximum value
        * @returns {Number} - Sampled value
        */
        samplePERT(min, mode, max) {
            // PERT uses a modified Beta distribution with shape parameters
            // derived from min, mode, and max
            const mu = (min + 4 * mode + max) / 6; // Mean

            // Approximate shape parameters for Beta distribution
            const alpha = ((mu - min) * (2 * mode - min - max)) / ((mode - mu) * (max - min));
            const beta = (alpha * (max - mu)) / (mu - min);

            // Ensure positive shape parameters
            const safeAlpha = Math.max(0.1, alpha);
            const safeBeta = Math.max(0.1, beta);

            // Sample from a Beta distribution using acceptance-rejection method
            let u1, u2, y1, y2;
            let accepted = false;

            // Try up to 100 times to get a valid sample
            for (let attempt = 0; attempt < 100 && !accepted; attempt++) {
                u1 = Math.random();
                u2 = Math.random();
                y1 = Math.pow(u1, 1 / safeAlpha);
                y2 = Math.pow(u2, 1 / safeBeta);

                if (y1 + y2 <= 1) {
                    accepted = true;
                }
            }

            // If acceptance-rejection failed after 100 attempts, use triangular as fallback
            if (!accepted) {
                return this.sampleTriangular(min, mode, max);
            }

            // Convert from Beta to PERT range
            return min + (max - min) * (y1 / (y1 + y2));
        },

        /**
         * Sample from a Birnbaum-Saunders (fatigue life) distribution
         * @param {Number} scale - Scale parameter
         * @param {Number} shape - Shape parameter
         * @returns {Number} - Sampled value
         */
        sampleBirnbaumSaunders(scale, shape) {
            // Sample a standard normal random variable
            const z = this.sampleNormal(0, 1);
            const w = z * z;

            // Transform to Birnbaum-Saunders
            return scale * (1 + shape * w / 2 + shape * z * Math.sqrt(w / 4 + 1));
        },

        /**
         * Sample from a normal distribution using Box-Muller transform
         * @param {Number} mean - Mean value
         * @param {Number} stdDev - Standard deviation
         * @returns {Number} - Sampled value
         */
        sampleNormal(mean, stdDev) {
            let u1 = Math.random();
            let u2 = Math.random();

            // Box-Muller transform
            let z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

            // Scale and shift to get desired mean and standard deviation
            return mean + (z0 * stdDev);
        },

        /**
         * Sample a duration for a given node based on its risk profile and resource factors
         * @param {Object} node - The task node
         * @param {boolean} includeResourceVariation - Whether to include resource variation
         * @returns {Number} - Sampled duration
         */
        sampleDuration(node, includeResourceVariation = true) {
            // Get completed portion - we don't simulate already completed work
            const record = this.state.originalDurations.get(node.ID);
            if (!record) {
                return node.Duration; // Default to original if no record
            }

            const percentComplete = record.percentComplete || 0;

            // For completed tasks, return the baseline duration
            if (percentComplete >= 100) {
                return record.baseline;
            }

            // Calculate completed portion in original units
            const completedPortion = record.baseline * (percentComplete / 100);

            // Choose and sample from the appropriate distribution for task duration
            const distributionChoice = this.chooseDistribution(node);
            let sampledRemainingDuration;

            switch (distributionChoice.type) {
                case "triangular":
                    sampledRemainingDuration = this.sampleTriangular(
                        distributionChoice.params.min,
                        distributionChoice.params.mode,
                        distributionChoice.params.max
                    );
                    break;

                case "birnbaum_saunders":
                    sampledRemainingDuration = this.sampleBirnbaumSaunders(
                        distributionChoice.params.scale,
                        distributionChoice.params.shape
                    );
                    break;

                case "pert":
                    sampledRemainingDuration = this.samplePERT(
                        distributionChoice.params.min,
                        distributionChoice.params.mode,
                        distributionChoice.params.max
                    );
                    break;

                case "normal":
                    sampledRemainingDuration = Math.max(0.1, this.sampleNormal(
                        distributionChoice.params.mean,
                        distributionChoice.params.stdDev
                    ));
                    break;

                default:
                    sampledRemainingDuration = record.baseline;
            }

            // Calculate remaining work
            let remainingWork = 1 - (percentComplete / 100);
            let adjustedDuration = completedPortion + (sampledRemainingDuration * remainingWork);

            // NEW: Apply resource variation to the duration if requested
            if (includeResourceVariation && !record.isResourceConstrained) {
                // Get baseline resource information
                const baseResources = record.resources || 1;
                const baseEfficiency = record.resourceEfficiency || 1.0;

                // Sample resource variation (availability and efficiency)
                const resourceVariation = this.sampleResourceVariation(node);
                const efficiencyVariation = this.sampleEfficiencyVariation(node);

                // Calculate effective resources for this simulation
                const effectiveResources = baseResources * resourceVariation;
                const effectiveEfficiency = baseEfficiency * efficiencyVariation;

                // Apply resource and efficiency adjustments
                adjustedDuration = this.adjustDurationForResources(
                    adjustedDuration,
                    baseResources,
                    effectiveResources,
                    percentComplete,
                    {
                        complexity: record.riskScore || 0.5,
                        efficiency: effectiveEfficiency
                    }
                );
            }

            return Math.max(0.01, adjustedDuration); // Ensure positive duration
        },

        /**
         * Sample resource variation factor
         * @param {Object} node - The task node
         * @returns {Number} - Multiplier for baseline resources (e.g., 0.8 to 1.2)
         */
        sampleResourceVariation(node) {
            const record = this.state.originalDurations.get(node.ID);

            if (!record || record.isResourceConstrained) {
                return 1.0; // No variation for resource-constrained tasks
            }

            // More resource variability for high-risk tasks
            const riskFactor = record.riskScore || 0.2;
            const variability = 0.1 + (riskFactor * 0.2); // 10-30% variation based on risk

            // Sample from triangular distribution centered on 1.0
            return this.sampleTriangular(
                Math.max(0.5, 1 - variability),  // Minimum resources (at least 50%)
                1.0,                            // Most likely (baseline)
                1 + variability                 // Maximum resources
            );
        },

        /**
         * Sample resource efficiency variation
         * @param {Object} node - The task node
         * @returns {Number} - Efficiency multiplier
         */
        sampleEfficiencyVariation(node) {
            const record = this.state.originalDurations.get(node.ID);

            if (!record) {
                return 1.0;
            }

            // Resource efficiency varies based on risk
            const riskFactor = record.riskScore || 0.2;
            const variability = 0.05 + (riskFactor * 0.15); // 5-20% efficiency variation

            // Sample from triangular distribution centered on 1.0
            return this.sampleTriangular(
                1 - variability,   // Minimum efficiency
                1.0,               // Most likely (baseline)
                1 + variability / 2  // Maximum efficiency (less upside than downside)
            );
        },

        /**
         * Adjust duration based on resources (using the same formula as in optimization)
         * @param {Number} baseDuration - Original duration
         * @param {Number} baseResources - Original resource count
         * @param {Number} effectiveResources - New resource count
         * @param {Number} percentComplete - Percentage already completed
         * @param {Object} options - Additional parameters
         * @returns {Number} - Adjusted duration
         */
        adjustDurationForResources(baseDuration, baseResources, effectiveResources, percentComplete, options) {
            // Calculate change in resources
            const additionalResources = effectiveResources - baseResources;

            return window.scheduleUtils.calculateResourceAdjustedDuration(
                baseDuration,
                baseResources,
                additionalResources,
                percentComplete,
                options
            );
        },

        /**
         * Calculate path duration with proper relationship type handling
         * @param {Array} path - Array of nodes forming a path
         * @param {Map} nodeMap - Map of node ID to node object
         * @param {Map} succMap - Map of node ID to successor edges
         * @param {Map} predMap - Map of node ID to predecessor edges
         * @returns {Number} - Total path duration in hours
         */
        calculatePathDuration(path, nodeMap, succMap, predMap) {
            return window.scheduleUtils.calculatePathDuration(path, nodeMap, succMap, predMap);
        },

        /**
         * Analyze critical path variability in simulation results
         * Identifies which paths were critical in each simulation iteration
         * @returns {Object} - Analysis results
         */
        analyzeCriticalPathVariability() {
            const criticalPaths = this.state.criticalPaths;
            const nearCriticalPaths = this.state.nearCriticalPaths;

            if (criticalPaths.length === 0 && nearCriticalPaths.length === 0) {
                console.log("No paths available for critical path variability analysis");
                return { pathFrequency: [], dominantPath: null };
            }

            if (this.state.simulationResults.length === 0) {
                console.log("No simulation results available for critical path variability analysis");
                return { pathFrequency: [], dominantPath: null };
            }

            // Combine all paths to track
            const allPaths = [
                ...criticalPaths.map((path, idx) => ({ path, type: 'critical', index: idx })),
                ...nearCriticalPaths.map((path, idx) => ({ path, type: 'near-critical', index: idx }))
            ];

            // For each simulation, determine which path(s) were critical
            const simulationCount = this.state.simulationResults.length;
            const pathFrequency = allPaths.map(pathInfo => {
                let criticalCount = 0;
                const path = pathInfo.path;

                // For each simulation iteration
                for (let simIndex = 0; simIndex < simulationCount; simIndex++) {
                    // Get the last node of the path
                    const lastNode = path[path.length - 1];
                    const lastNodeId = typeof lastNode === 'object' ? lastNode.ID : lastNode;

                    // Get this node's finish time in this simulation
                    const finishTimes = this.state.taskEndDates.get(lastNodeId) || [];

                    if (finishTimes.length > simIndex) {
                        const pathFinish = finishTimes[simIndex];
                        const projectFinish = this.state.simulationResults[simIndex];

                        // Check if this path was critical (finish time equals project finish)
                        if (Math.abs(pathFinish - projectFinish) < 0.01) {
                            criticalCount++;
                        }
                    }
                }

                // Calculate frequency
                const frequency = (criticalCount / simulationCount) * 100;

                return {
                    path: pathInfo.path,
                    type: pathInfo.type,
                    index: pathInfo.index,
                    criticalCount: criticalCount,
                    frequency: frequency,
                    nodes: pathInfo.path.map(node => typeof node === 'object' ? node.ID : node)
                };
            });

            // Sort by frequency (highest first)
            pathFrequency.sort((a, b) => b.frequency - a.frequency);

            // Find the dominant path
            const dominantPath = pathFrequency.length > 0 ? pathFrequency[0] : null;

            const result = {
                pathFrequency: pathFrequency,
                dominantPath: dominantPath,
                criticalPathCount: criticalPaths.length,
                nearCriticalPathCount: nearCriticalPaths.length,
                variablePathCount: pathFrequency.filter(p => p.frequency > 0).length
            };

            console.log("Critical path variability analysis:", result);
            return result;
        },

        /**
 * Compute the project finish time based on sampled durations
 * @param {Map} durationMap - Map of node ID to sampled durations
 * @returns {Object} - Contains project finish time in hours and projected end date
 */
        computeFinishTime(durationMap) {
            // Ensure nodeMap exists; empty Map() here breaks simulation silently.
            const nodeMap =
                window.cybereumState?.nodeMap?.size ? window.cybereumState.nodeMap : buildNodeMap(nodes);

            const succMap = window.cybereumState?.succMap || buildSuccessorMap(links, nodes);
            const predMap = window.cybereumState?.predMap || buildPredecessorMap(links, nodes);

            const getSampleHours = (m, id) => {
                if (!m) return null;
                if (m.has(id)) return Number(m.get(id));
                const sid = String(id);
                if (m.has(sid)) return Number(m.get(sid));
                const nid = Number(id);
                if (Number.isFinite(nid) && m.has(nid)) return Number(m.get(nid));
                return null;
            };

            const simulatedNodeMap = new Map();

            nodeMap.forEach((node, nodeId) => {
                const nodeCopy = { ...node };

                const sample = getSampleHours(durationMap, nodeId);
                if (sample !== null && Number.isFinite(sample) && sample >= 0) {
                    // sampled durations are HOURS
                    nodeCopy.Duration = sample;
                    nodeCopy.TimeUnits = 'Hours';
                    nodeCopy.DurationUnits = 'Hours';
                    nodeCopy.SampledDurationHours = sample;
                }

                simulatedNodeMap.set(nodeId, nodeCopy);
            });

            const taskFinishTimes = new Map();

            // Full forward pass is the correct CPM calculation.
            // Path-based shortcut was removed: it only considers edges within
            // each pre-identified path and misses off-path predecessor constraints,
            // systematically underestimating project duration.
            const projectFinish = this.calculateForwardPass(simulatedNodeMap, succMap, predMap, taskFinishTimes);

            const endDate = this.calculateEndDate(projectFinish);

            return { hours: projectFinish, endDate, taskFinishTimes };
        },

        /**
         * Calculate project finish using forward pass (CPM)
         */
        calculateForwardPass(nodeMap, succMap, predMap, taskFinishTimes) {
            // Get topological sort or create one
            const topoOrder = window.cybereumState?.slackResults?.topoOrder ||
                calculateTopologicalSort(nodeMap, succMap, predMap);

            // Calculate early dates with proper relationship handling
            const earliestStart = new Map();
            const earliestFinish = new Map();

            // Initialize all nodes with -Infinity
            nodeMap.forEach((_, id) => {
                earliestStart.set(id, -Infinity);
                earliestFinish.set(id, -Infinity);
            });

            // Find start nodes (no predecessors)
            topoOrder.forEach(nodeId => {
                const predecessors = predMap.get(nodeId) || [];
                if (predecessors.length === 0) {
                    earliestStart.set(nodeId, 0);
                    earliestFinish.set(nodeId, Number(nodeMap.get(nodeId).Duration));
                }
            });

            // Forward pass with relationship type handling
            topoOrder.forEach(nodeId => {
                if (earliestStart.get(nodeId) === -Infinity) {
                    const node = nodeMap.get(nodeId);
                    const predecessors = predMap.get(nodeId) || [];
                    let es = -Infinity;

                    // Process all predecessor relationships
                    predecessors.forEach(edge => {
                        const predId = edge.source;
                        const predES = earliestStart.get(predId);
                        const predEF = earliestFinish.get(predId);

                        if (predES === -Infinity || predEF === -Infinity) {
                            return; // Skip unprocessed predecessors
                        }

                        let candidateES;
                        const lag = Number(edge.lagHrs || 0);

                        switch (edge.type) {
                            case 'FS': // Finish-to-Start
                                candidateES = predEF + lag;
                                break;
                            case 'SS': // Start-to-Start
                                candidateES = predES + lag;
                                break;
                            case 'FF': // Finish-to-Finish
                                candidateES = predEF - Number(node.Duration) + lag;
                                break;
                            case 'SF': // Start-to-Finish
                                candidateES = predES - Number(node.Duration) + lag;
                                break;
                            default:
                                candidateES = predEF + lag;
                        }

                        // Take the maximum (latest) constraint
                        es = Math.max(es, candidateES);
                    });

                    // Ensure non-negative start time
                    es = Math.max(0, es);

                    earliestStart.set(nodeId, es);
                    earliestFinish.set(nodeId, es + Number(node.Duration));
                }
            });

            // Find max finish time from end nodes (no successors)
            let projectFinish = 0;

            nodeMap.forEach((node, nodeId) => {
                const ef = earliestFinish.get(nodeId);

                // Store for sensitivity analysis
                taskFinishTimes.set(nodeId, ef);

                const successors = succMap.get(nodeId) || [];
                if (successors.length === 0) {
                    projectFinish = Math.max(projectFinish, Number(ef));
                }
            });

            return projectFinish;
        },
        /**
         * Calculate end date based on hours from start and working calendar
         * @param {Number} hours - Total hours from project start
         * @returns {Date} - Projected end date
         */
        calculateEndDate(hours) {
            // Always create a fresh copy of the start date
            const startDateCopy = new Date(this.state.projectStartDate.getTime());
            return window.scheduleUtils.calculateCalendarEndDate(
                startDateCopy,
                hours,
                this.state.projectWorkCalendar
            );
        },

        /**
         * Fallback method for end date calculation
         * @param {Number} hours - Hours to add to start date
         * @returns {Date} - Calendar end date
         */
        calculateEndDateFallback(hours) {
            const startDate = new Date(this.state.projectStartDate);
            const endDate = new Date(startDate);

            const hoursPerDay = this.state.projectWorkCalendar?.hoursPerDay || 8;
            const workingDaySet = getNormalizedWorkingDaySet(this.state.projectWorkCalendar?.workingDays);
            const holidays = this.state.projectWorkCalendar?.holidays || [];

            // First handle any partial day from the start time
            const startHour = startDate.getHours();
            const startMinutes = startDate.getMinutes();

            // Hours remaining in first day
            const hoursRemainingInFirstDay = Math.max(0, hoursPerDay - startHour - (startMinutes / 60));

            let remainingHours = hours;

            // Helper to check if a date is a working day
            const isWorkingDay = (date) => {
                const dayOfWeek = date.getDay();
                const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
                const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD
                return workingDaySet.has(isoDay) && !holidays.includes(dateString);
            };

            // Use hours in first day
            if (hoursRemainingInFirstDay > 0 && remainingHours > 0) {
                const hoursToUseInFirstDay = Math.min(hoursRemainingInFirstDay, remainingHours);
                remainingHours -= hoursToUseInFirstDay;

                // If we used all remaining hours, just add them to the start time
                if (remainingHours === 0) {
                    endDate.setHours(startHour + hoursToUseInFirstDay);
                    return endDate;
                }
            }

            // Calculate whole working days
            const wholeDays = Math.floor(remainingHours / hoursPerDay);
            remainingHours = remainingHours % hoursPerDay;

            // Add whole working days
            let daysAdded = 0;
            while (daysAdded < wholeDays) {
                endDate.setDate(endDate.getDate() + 1);
                endDate.setHours(0, 0, 0, 0); // Reset to start of day

                if (isWorkingDay(endDate)) {
                    daysAdded++;
                }
            }

            // Add remaining hours to the last working day
            if (remainingHours > 0) {
                // If we're not on a working day, find the next one
                while (!isWorkingDay(endDate)) {
                    endDate.setDate(endDate.getDate() + 1);
                    endDate.setHours(0, 0, 0, 0);
                }

                // Now add the remaining hours
                endDate.setHours(remainingHours);
            }

            return endDate;
        },

        /**
         * Convert duration to specified display unit
         * @param {Number} hours - Duration in hours
         * @param {String} displayUnit - Target unit (hours, days, dates)
         * @returns {Object} - Converted value and unit
         */
        convertDurationToDisplayUnit(hours, displayUnit) {
            if (typeof hours !== 'number' || isNaN(hours)) {
                return { value: 0, unit: 'hours' };
            }

            switch (displayUnit) {
                case 'days':
                    // Convert to working days
                    const hoursPerDay = this.state.projectWorkCalendar?.hoursPerDay || 8;
                    return {
                        value: hours / hoursPerDay,
                        unit: 'working days'
                    };

                case 'dates':
                    // Convert to calendar date
                    const date = this.calculateEndDate(hours);
                    return {
                        value: date,
                        unit: 'date'
                    };

                case 'hours':
                default:
                    return {
                        value: hours,
                        unit: 'hours'
                    };
            }
        },

        /**
 * Analyze resource impact on simulation results
 * @returns {Object} - Analysis of resource impacts
 */
        analyzeResourceImpact() {
            if (!this.state.simulationResults.length) {
                return null;
            }

            // Get resource-constrained tasks
            const resourceConstrainedTasks = nodes.filter(node => {
                const record = this.state.originalDurations.get(node.ID);
                return record && record.isResourceConstrained;
            });

            // Calculate statistics for constrained vs. non-constrained tasks
            const constrainedTaskDurations = new Map();
            const nonConstrainedTaskDurations = new Map();

            // Collect duration data
            this.state.taskEndDates.forEach((finishTimes, taskId) => {
                const node = nodes.find(n => n.ID === taskId);
                if (!node) return;

                const record = this.state.originalDurations.get(taskId);
                if (!record) return;

                const durations = finishTimes.map((finish, i) => {
                    const start = i === 0 ? 0 : finishTimes[i - 1];
                    return finish - start;
                });

                // Store based on constraint status
                if (record.isResourceConstrained) {
                    constrainedTaskDurations.set(taskId, durations);
                } else {
                    nonConstrainedTaskDurations.set(taskId, durations);
                }
            });

            // Calculate average duration increase for constrained tasks
            let constrainedTotal = 0;
            let constrainedCount = 0;
            let nonConstrainedTotal = 0;
            let nonConstrainedCount = 0;

            constrainedTaskDurations.forEach((durations, taskId) => {
                const record = this.state.originalDurations.get(taskId);
                if (!record) return;

                const baseline = record.baseline;
                const avgDuration = durations.reduce((sum, val) => sum + val, 0) / durations.length;
                const increase = avgDuration / baseline;

                constrainedTotal += increase;
                constrainedCount++;
            });

            nonConstrainedTaskDurations.forEach((durations, taskId) => {
                const record = this.state.originalDurations.get(taskId);
                if (!record) return;

                const baseline = record.baseline;
                const avgDuration = durations.reduce((sum, val) => sum + val, 0) / durations.length;
                const increase = avgDuration / baseline;

                nonConstrainedTotal += increase;
                nonConstrainedCount++;
            });

            // Calculate averages
            const avgConstrainedIncrease = constrainedCount > 0 ?
                constrainedTotal / constrainedCount : 0;

            const avgNonConstrainedIncrease = nonConstrainedCount > 0 ?
                nonConstrainedTotal / nonConstrainedCount : 0;

            // Find most impactful resource-constrained tasks
            const resourceImpacts = [];

            constrainedTaskDurations.forEach((durations, taskId) => {
                const node = nodes.find(n => n.ID === taskId);
                const record = this.state.originalDurations.get(taskId);
                if (!node || !record) return;

                const baseline = record.baseline;
                const avgDuration = durations.reduce((sum, val) => sum + val, 0) / durations.length;
                const impact = (avgDuration - baseline) / baseline * 100; // percent increase

                resourceImpacts.push({
                    taskId,
                    name: node.Name || `Task ${taskId}`,
                    baselineDuration: baseline,
                    avgSimulatedDuration: avgDuration,
                    percentIncrease: impact,
                    resources: record.resources || 1
                });
            });

            // Sort by impact (highest first)
            resourceImpacts.sort((a, b) => b.percentIncrease - a.percentIncrease);

            return {
                constrainedTaskCount: constrainedCount,
                nonConstrainedTaskCount: nonConstrainedCount,
                avgConstrainedIncrease: avgConstrainedIncrease,
                avgNonConstrainedIncrease: avgNonConstrainedIncrease,
                resourceImpacts: resourceImpacts.slice(0, 10) // Top 10 most impacted
            };
        },
        /**
         * Identify risk factors for the dominant path
         * @returns {Object} - Risk factors on dominant path
         */
        identifyDominantPathRiskFactors() {
            // Get path variability analysis
            const pathAnalysis = this.analyzeCriticalPathVariability();

            if (!pathAnalysis.dominantPath) {
                console.log("No dominant path identified for risk factor analysis");
                return { dominantPath: null, riskFactors: [] };
            }

            const dominantPathNodes = pathAnalysis.dominantPath.nodes;
            const riskFactors = [];

            // Analyze each node on the dominant path
            dominantPathNodes.forEach(nodeId => {
                const node = nodes.find(n => n.ID === nodeId);
                if (!node) return;

                const record = this.state.originalDurations.get(nodeId);
                if (!record) return;

                // Calculate risk metrics
                const variability = record.distParams ?
                    (record.distParams.max - record.distParams.min) / record.distParams.mode : 0;

                const riskScore = node.riskScore || node.ComputedRiskScore || 0;
                const importanceScore = node.importanceScore || node.ComputedImportanceScore || 0;

                // Check if this is a high-risk task
                if (riskScore > 0.6 || variability > 0.3) {
                    riskFactors.push({
                        nodeId: nodeId,
                        taskName: node.Name,
                        riskScore: riskScore,
                        importanceScore: importanceScore,
                        variability: variability,
                        impact: riskScore * importanceScore,
                        description: `${node.Name} has high risk (${(riskScore * 100).toFixed(1)}%) and ${(variability * 100).toFixed(1)}% variability`
                    });
                }
            });

            // Sort by impact
            riskFactors.sort((a, b) => b.impact - a.impact);

            const result = {
                dominantPath: pathAnalysis.dominantPath,
                riskFactors: riskFactors
            };

            console.log("Dominant path risk factors:", result);
            return result;
        },

        /**
          * Run the Monte Carlo simulation
          * @param {Number} numIterations - Number of simulation iterations
          * @returns {Object} - Simulation summary
          */
        async runSimulation(numIterations) {
            this.showProgressOverlay("Initializing Monte Carlo simulation...");
            this.state.isSimulationRunning = true;
            this.state.simulationStart = window.cybereumState.dataDate || new Date();
            this.state.simulationResults = [];
            this.state.projectEndDates = [];
            this.state.taskEndDates = new Map();

            // Initialize task end dates map
            nodes.forEach(node => {
                this.state.taskEndDates.set(node.ID, []);
            });

            this.state.currentSimulationProgress = 0;

            console.log(`Starting Monte Carlo simulation with ${numIterations} iterations`);

            try {
                // Break the simulation into batches to allow UI updates
                const batchSize = 1000;
                const numBatches = Math.ceil(numIterations / batchSize);

                for (let batch = 0; batch < numBatches; batch++) {
                    const startIdx = batch * batchSize;
                    const endIdx = Math.min((batch + 1) * batchSize, numIterations);
                    const batchCount = endIdx - startIdx;

                    // Update progress
                    const progress = Math.floor((batch / numBatches) * 100);
                    this.updateProgressOverlay(`Running simulation batch ${batch + 1}/${numBatches}...`, progress);

                    // Process batch
                    await this.runSimulationBatch(startIdx, batchCount);

                    // Small delay to allow UI updates
                    await new Promise(resolve => setTimeout(resolve, 0));
                }

                this.updateProgressOverlay("Analyzing simulation results...", 95);

                // Calculate summary statistics
                this.state.simulationSummary = this.analyzeResults();

                // Create histogram data
                this.createHistogramData();

                // Perform sensitivity analysis
                this.performSensitivityAnalysis();

                // Analyze critical path variability
                this.analyzeCriticalPathVariability();

                this.updateProgressOverlay("Simulation complete", 100);
                setTimeout(() => this.hideProgressOverlay(), 500);

                // Update the interface
                this.updateInterface();

                console.log(`Monte Carlo simulation complete: ${numIterations} iterations`);
                this.state.isSimulationRunning = false;

                return this.state.simulationSummary;
            } catch (error) {
                console.error("Error running Monte Carlo simulation:", error);
                this.hideProgressOverlay();
                this.state.isSimulationRunning = false;

                // Show error message
                alert(`Simulation error: ${error.message}`);
                return null;
            }
        },

        /**
 * Run a batch of simulation iterations with resource variation
 * @param {Number} startIdx - Starting iteration index
 * @param {Number} count - Number of iterations in batch
 */
        async runSimulationBatch(startIdx, count) {
            // Build sets for quick lookup of critical and near-critical nodes
            const criticalNodes = new Set();
            const nearCriticalNodes = new Set();

            // Extract path node IDs
            const criticalPaths = this.state.criticalPaths;
            const nearCriticalPaths = this.state.nearCriticalPaths;

            // Populate node sets
            criticalPaths.forEach(path => {
                path.forEach(node => {
                    const nodeId = typeof node === 'object' ? node.ID : node;
                    criticalNodes.add(nodeId);
                });
            });

            nearCriticalPaths.forEach(path => {
                path.forEach(node => {
                    const nodeId = typeof node === 'object' ? node.ID : node;
                    if (!criticalNodes.has(nodeId)) {
                        nearCriticalNodes.add(nodeId);
                    }
                });
            });

            // Determine which tasks get detailed simulation
            const fullSimNodes = new Set([...criticalNodes, ...nearCriticalNodes]);

            for (let i = 0; i < count; i++) {
                // Sample durations with focused sampling
                const durationMap = new Map();

                // NEW: For each iteration, decide if we'll simulate resource constraints
                const simulateResourceShortages = Math.random() < 0.5; // 50% chance of resource constraints

                // Process nodes, prioritizing critical path nodes
                nodes.forEach(node => {
                    // Determine sampling approach based on node criticality
                    const isDetailedNode = fullSimNodes.has(node.ID);

                    // NEW: Include resource variation for this iteration
                    const includeResourceVariation = isDetailedNode || Math.random() < 0.3; // Only sometimes for non-critical

                    // Sample duration with appropriate level of detail
                    let sampledDuration;
                    if (isDetailedNode) {
                        // Full detailed sampling for critical/near-critical path nodes
                        sampledDuration = this.sampleDuration(node, includeResourceVariation);
                    } else {
                        // Simplified sampling for non-critical nodes
                        const record = this.state.originalDurations.get(node.ID);
                        if (record) {
                            // Use simpler triangular distribution with narrower range
                            const baseline = record.baseline;
                            // Simple triangular with less variation
                            sampledDuration = this.sampleTriangular(
                                baseline * 0.95,
                                baseline,
                                baseline * 1.05
                            );

                            // NEW: Apply simple resource adjustment occasionally
                            if (includeResourceVariation && !record.isResourceConstrained) {
                                const baseResources = record.resources || 1;
                                // Simple 10% resource variation
                                const resourceFactor = this.sampleTriangular(0.9, 1.0, 1.1);
                                const effectiveResources = baseResources * resourceFactor;

                                // Apply simplified resource adjustment
                                if (Math.abs(effectiveResources - baseResources) > 0.1) {
                                    const resourceChange = effectiveResources - baseResources;
                                    sampledDuration = this.adjustDurationForResources(
                                        sampledDuration,
                                        baseResources,
                                        resourceChange,
                                        record.percentComplete || 0,
                                        { complexity: 0.3 } // Lower complexity for non-critical
                                    );
                                }
                            }
                        } else {
                            sampledDuration = node.Duration;
                        }
                    }

                    // Store the sampled duration
                    durationMap.set(node.ID, sampledDuration);
                });

                // NEW: Apply resource constraint effects if simulating shortages
                if (simulateResourceShortages) {
                    this.applyResourceConstraintEffects(durationMap);
                }

                // Compute project finish time
                const result = this.computeFinishTime(durationMap);

                // Store results
                this.state.simulationResults.push(result.hours);

                if (result.endDate) {
                    this.state.projectEndDates.push(result.endDate);
                }

                // Store task finish times
                result.taskFinishTimes.forEach((finishTime, taskId) => {
                    const tasksEndDates = this.state.taskEndDates.get(taskId) || [];
                    tasksEndDates.push(finishTime);
                    this.state.taskEndDates.set(taskId, tasksEndDates);
                });
            }
        },

        /**
 * Apply resource constraint effects to sampled durations
 * @param {Map} durationMap - Map of node ID to sampled durations
 */
        applyResourceConstraintEffects(durationMap) {
            // Identify resource-constrained tasks
            const constrainedTasks = nodes.filter(node => {
                const record = this.state.originalDurations.get(node.ID);
                return record && record.isResourceConstrained;
            });

            if (constrainedTasks.length === 0) return;

            // Select a subset of constrained tasks to be affected
            const affectedCount = Math.ceil(constrainedTasks.length * 0.3); // Affect ~30%
            const affectedTasks = [];

            // Shuffle and select tasks
            const shuffled = [...constrainedTasks].sort(() => 0.5 - Math.random());
            affectedTasks.push(...shuffled.slice(0, affectedCount));

            // Apply delays to affected tasks
            affectedTasks.forEach(task => {
                const currentDuration = durationMap.get(task.ID);
                if (!currentDuration) return;

                // Apply 10-50% increase to task duration
                const delayFactor = 1 + (0.1 + Math.random() * 0.4);
                const delayedDuration = currentDuration * delayFactor;

                durationMap.set(task.ID, delayedDuration);

                console.log(`Applied resource constraint effect to task ${task.ID}: ${currentDuration} -> ${delayedDuration} hours`);
            });
        },
        /**
          * Analyze simulation results and calculate summary statistics
          * @returns {Object} - Summary statistics
          */
        analyzeResults() {
            if (!this.state.simulationResults.length) {
                return null;
            }

            // Sort results for percentile calculations
            const results = [...this.state.simulationResults].sort((a, b) => a - b);
            const n = results.length;

            // Sort end dates if available
            let endDates = null;
            if (this.state.projectEndDates.length > 0) {
                endDates = [...this.state.projectEndDates].sort((a, b) => a - b);
            }

            // Calculate statistics
            const min = results[0];
            const max = results[n - 1];
            const mean = results.reduce((sum, val) => sum + val, 0) / n;
            const median = n % 2 === 0 ?
                (results[n / 2 - 1] + results[n / 2]) / 2 :
                results[Math.floor(n / 2)];

            // Calculate variance and standard deviation
            const variance = results.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;
            const stdDev = Math.sqrt(variance);

            // Helper function to calculate percentiles
            const percentile = p => {
                const idx = Math.max(0, Math.min(n - 1, Math.floor((p / 100) * n)));
                return results[idx];
            };

            // Helper function to get date at percentile
            const dateAtPercentile = p => {
                if (!endDates) return null;
                const idx = Math.max(0, Math.min(endDates.length - 1, Math.floor((p / 100) * endDates.length)));
                return endDates[idx];
            };

            // Calculate time units conversion if needed
            let timeUnitConversion = 1;
            let timeUnit = "Hours";

            // Look for the most common time unit in nodes
            const timeUnitsCount = {};
            nodes.forEach(node => {
                const unit = node.TimeUnits || "Hours";
                timeUnitsCount[unit] = (timeUnitsCount[unit] || 0) + 1;
            });

            // Find the most common time unit
            let maxCount = 0;
            Object.entries(timeUnitsCount).forEach(([unit, count]) => {
                if (count > maxCount) {
                    maxCount = count;
                    timeUnit = unit;
                }
            });

            // Get hours per day from work calendar
            const hoursPerDay = this.state.projectWorkCalendar?.hoursPerDay || DEFAULT_HOURS_PER_DAY || 8;
            timeUnitConversion = hoursPerDay;

            // Calculate results for all confidence levels
            const percentileResults = {};
            const daysResults = {};
            const endDateResults = {};

            this.state.confidenceLevels.forEach(level => {
                percentileResults[`p${level}`] = percentile(level);
                daysResults[`p${level}`] = percentile(level) / timeUnitConversion;
                endDateResults[`p${level}`] = dateAtPercentile(level);
            });

            // Add min, max, mean, median
            percentileResults.min = min;
            percentileResults.max = max;
            percentileResults.mean = mean;
            percentileResults.median = median;

            daysResults.min = min / timeUnitConversion;
            daysResults.max = max / timeUnitConversion;
            daysResults.mean = mean / timeUnitConversion;
            daysResults.median = median / timeUnitConversion;
            daysResults.stdDev = stdDev / timeUnitConversion;

            endDateResults.min = dateAtPercentile(0);
            endDateResults.max = dateAtPercentile(100);
            endDateResults.mean = this.calculateMeanDate(this.state.projectEndDates);
            endDateResults.median = dateAtPercentile(50);

            return {
                min,
                max,
                mean,
                median,
                stdDev,
                percentileResults,
                timeUnit,
                timeUnitConversion,
                daysResults,
                endDateResults,
                iterationCount: n,
                simulationDuration: window.cybereumState.dataDate || new Date() - this.state.simulationStart
            };
        },

        /**
         * Calculate the mean of a collection of dates
         * @param {Array} dates - Array of Date objects
         * @returns {Date} - Mean date
         */
        calculateMeanDate(dates) {
            if (!dates || dates.length === 0) {
                return null;
            }

            // Convert dates to milliseconds since epoch
            const timestamps = dates.map(date => date.getTime());

            // Calculate mean timestamp
            const meanTimestamp = timestamps.reduce((sum, time) => sum + time, 0) / timestamps.length;

            // Convert back to Date
            return new Date(meanTimestamp);
        },

        /**
       * Creates histogram data for visualization
       */
        createHistogramData() {
            if (!this.state.simulationResults.length) {
                return;
            }

            const results = this.state.simulationResults;

            // Determine the number of bins based on data size (Sturges' formula)
            const n = results.length;
            const numBins = Math.ceil(Math.log2(n)) + 1;

            // Find min and max values
            const min = Math.min(...results);
            const max = Math.max(...results);

            // Calculate bin width
            const binWidth = (max - min) / numBins;

            // Create bins
            const bins = new Array(numBins).fill(0);
            const binLabels = new Array(numBins);

            // Fill bins
            results.forEach(val => {
                let binIndex = Math.floor((val - min) / binWidth);
                // Handle the case where val equals max
                if (binIndex === numBins) {
                    binIndex = numBins - 1;
                }
                bins[binIndex]++;
            });

            // Create labels for each bin
            for (let i = 0; i < numBins; i++) {
                const start = min + (i * binWidth);
                const end = min + ((i + 1) * binWidth);
                binLabels[i] = `${start.toFixed(1)} - ${end.toFixed(1)}`;
            }

            // Store histogram data
            this.state.simulationHistogramData = {
                bins,
                binLabels,
                binWidth,
                min,
                max
            };
        },

        /**
          * Perform sensitivity analysis to identify which tasks have the most impact on schedule
          */
        performSensitivityAnalysis() {
            if (!this.state.simulationResults.length) {
                return null;
            }

            // Create correlation data between task durations and project finish
            const sensitivityData = [];

            // For each task, calculate correlation between its finish time and project finish
            this.state.taskEndDates.forEach((finishTimes, taskId) => {
                // Skip if we don't have enough data
                if (finishTimes.length < this.state.simulationResults.length * 0.9) {
                    return;
                }

                // Calculate correlation coefficient
                const correlation = this.calculateCorrelation(
                    finishTimes,
                    this.state.simulationResults
                );

                // Get task info
                const node = nodes.find(n => n.ID === taskId);
                const nodeData = this.state.nodeData.get(taskId);
                const isCritical = nodeData?.isCritical || false;
                const isNearCritical = nodeData?.isOnOutlierPath || false;

                // Calculate variation coefficient (stdDev / mean)
                const taskMean = finishTimes.reduce((sum, val) => sum + val, 0) / finishTimes.length;
                const taskVariance = finishTimes.reduce((sum, val) => sum + Math.pow(val - taskMean, 2), 0) / finishTimes.length;
                const taskStdDev = Math.sqrt(taskVariance);
                const variationCoeff = taskStdDev / taskMean;

                sensitivityData.push({
                    taskId,
                    name: node?.Name || `Task ${taskId}`,
                    correlation,
                    isCritical,
                    isNearCritical,
                    variationCoeff,
                    impact: correlation * variationCoeff, // Combined metric
                    description: nodeData?.description || ""
                });
            });

            // Sort by impact (correlation * variation coefficient)
            sensitivityData.sort((a, b) => b.impact - a.impact);

            // Store sensitivity analysis results
            this.state.sensitivityAnalysis = sensitivityData;

            console.log("Sensitivity analysis found", sensitivityData.length, "tasks with impact on schedule");

            return sensitivityData;
        },

        /**
         * Calculate correlation coefficient between two arrays
         */
        calculateCorrelation(array1, array2) {
            // Ensure arrays are the same length
            if (array1.length !== array2.length) {
                const minLength = Math.min(array1.length, array2.length);
                array1 = array1.slice(0, minLength);
                array2 = array2.slice(0, minLength);
            }

            // Calculate means
            const mean1 = array1.reduce((sum, val) => sum + val, 0) / array1.length;
            const mean2 = array2.reduce((sum, val) => sum + val, 0) / array2.length;

            // Calculate covariance and individual variances
            let covariance = 0;
            let variance1 = 0;
            let variance2 = 0;

            for (let i = 0; i < array1.length; i++) {
                const diff1 = array1[i] - mean1;
                const diff2 = array2[i] - mean2;

                covariance += diff1 * diff2;
                variance1 += diff1 * diff1;
                variance2 += diff2 * diff2;
            }

            // Normalize
            covariance /= array1.length;
            variance1 /= array1.length;
            variance2 /= array2.length;

            // Calculate correlation
            const stdDev1 = Math.sqrt(variance1);
            const stdDev2 = Math.sqrt(variance2);

            if (stdDev1 === 0 || stdDev2 === 0) {
                return 0; // Avoid division by zero
            }

            return covariance / (stdDev1 * stdDev2);
        },

        /**
 * Render the improved Monte Carlo simulation interface
 */
        renderInterface() {
            // Create container element
            const container = document.createElement('div');
            container.id = 'monteCarloContainer';
            container.className = 'monte-carlo-container';

            // Set up the HTML structure with improved styling and layout
            container.innerHTML = `
        <style>
            /* Base container styles */
            .monte-carlo-container {
                position: relative;
                background: var(--bg-darker, #091625);
                border: 1px solid var(--primary, #5ac8fa);
                border-radius: 8px;
                padding: 20px;
                margin: 20px;
                color: var(--text, #cdfaff);
                font-family: var(--font-rajdhani, 'Rajdhani', sans-serif);
                overflow: hidden;
                max-width: 100%;
            }
            
            /* Improved headers */
            .monte-carlo-container.section-title {
                font-size: 1.8em;
                color: var(--bright, #8ce6ff);
                margin-top: 0;
                margin-bottom: 15px;
                text-shadow: 0 0 10px rgba(90, 200, 250, 0.5);
                display: flex;
                align-items: center;
                gap: 10px;
                border-bottom: 1px solid rgba(90, 200, 250, 0.2);
                padding-bottom: 10px;
            }
            
            .section-title::before {
                content: "📊";
            }
            
            .description {
                margin-bottom: 20px;
                font-size: 0.95em;
                line-height: 1.5;
                padding: 15px;
                background: rgba(90, 200, 250, 0.05);
                border-left: 3px solid var(--primary, #5ac8fa);
                border-radius: 0 6px 6px 0;
            }
            
            /* Improved controls section */
            .controls-section {
                display: flex;
                flex-wrap: wrap;
                gap: 15px;
                align-items: center;
                margin-bottom: 25px;
                padding: 20px;
                background: rgba(90, 200, 250, 0.05);
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                border: 1px solid rgba(90, 200, 250, 0.2);
            }
            
            .input-group {
                display: flex;
                align-items: center;
                gap: 10px;
                flex: 1;
                min-width: 250px;
                position: relative;
            }
            
            .input-group label {
                min-width: 150px;
            }
            
            /* Improved form controls */
            .monte-carlo-container input,
            .monte-carlo-container select {
                background-color: rgba(14, 36, 70, 0.8);
                border: 1px solid var(--primary, #5ac8fa);
                color: var(--text, #cdfaff);
                padding: 10px;
                border-radius: 6px;
                width: 150px;
                transition: all 0.2s ease;
            }
            
            .monte-carlo-container input:focus,
            .monte-carlo-container select:focus {
                outline: none;
                box-shadow: 0 0 0 2px rgba(90, 200, 250, 0.3);
                border-color: var(--bright, #8ce6ff);
            }
            
            /* Enhanced buttons */
            .monte-carlo-button {
                background-color: rgba(14, 36, 70, 0.8);
                border: 2px solid var(--primary, #5ac8fa);
                color: var(--text, #cdfaff);
                padding: 12px 20px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.3s ease;
                font-weight: bold;
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 180px;
                justify-content: center;
            }
            
            .monte-carlo-button:hover {
                background: var(--primary, #5ac8fa);
                color: var(--bg-darker, #091625);
                box-shadow: var(--glow, 0 0 10px rgba(90, 200, 250, 0.7));
                transform: translateY(-2px);
            }
            
            .monte-carlo-button:active {
                transform: translateY(0);
            }
            
            .monte-carlo-button i {
                font-size: 16px;
            }
            
           /* Fix for Monte Carlo Tab CSS - Scoped to prevent conflicts */
            .monte-carlo-container .mc-tabs {
                display: flex;
                margin-bottom: 20px;
                border-bottom: 1px solid rgba(90, 200, 250, 0.2);
                gap: 5px;
                flex-wrap: wrap;
                position: sticky;
                top: 0;
                background: var(--bg-darker, #091625);
                z-index: 10;
                padding: 10px 0;
            }

            .monte-carlo-container .mc-tab {
                padding: 10px 15px;
                cursor: pointer;
                border-radius: 6px 6px 0 0;
                transition: all 0.2s ease;
                border: 1px solid transparent;
                border-bottom: none;
                position: relative;
                display: flex;
                align-items: center;
                gap: 6px;
                font-weight: 500;
            }

            .monte-carlo-container .mc-tab::before {
                font-size: 14px;
                opacity: 0.8;
            }

            .monte-carlo-container .mc-tab[data-tab="summary"]::before { content: "📊"; }
            .monte-carlo-container .mc-tab[data-tab="histogram"]::before { content: "📊"; }
            .monte-carlo-container .mc-tab[data-tab="cumulative"]::before { content: "📈"; }
            .monte-carlo-container .mc-tab[data-tab="calendar"]::before { content: "📅"; }
            .monte-carlo-container .mc-tab[data-tab="sensitivity"]::before { content: "🔍"; }

            .monte-carlo-container .mc-tab.active {
                border-color: var(--primary, #5ac8fa);
                background: rgba(90, 200, 250, 0.1);
                color: var(--bright, #8ce6ff);
                font-weight: bold;
            }

            .monte-carlo-container .mc-tab:hover:not(.active) {
                background: rgba(90, 200, 250, 0.05);
                border-color: rgba(90, 200, 250, 0.2);
            }

            /* Tab hover tooltip */
            .monte-carlo-container .mc-tab::after {
                content: attr(data-tooltip);
                position: absolute;
                bottom: -40px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(14, 36, 70, 0.9);
                padding: 6px 10px;
                border-radius: 4px;
                font-size: 0.8em;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.2s;
                white-space: nowrap;
                z-index: 100;
                border: 1px solid var(--primary, #5ac8fa);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            }

            .monte-carlo-container .mc-tab:hover::after {
                opacity: 1;
            }

            .monte-carlo-container .mc-tab-content {
                display: none;
                padding: 10px 0;
                animation: fadeIn 0.3s ease;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .monte-carlo-container .mc-tab-content.active {
                display: block;
            }
            
            /* Card section */
            .card-section {
                margin: 25px 0;
                padding: 20px;
                background: rgba(90, 200, 250, 0.05);
                border-radius: 8px;
                border: 1px solid rgba(90, 200, 250, 0.2);
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
                transition: all 0.3s;
            }
            
            .card-section h3 {
                margin-top: 0;
                color: var(--bright, #8ce6ff);
                border-bottom: 1px solid rgba(90, 200, 250, 0.2);
                padding-bottom: 10px;
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 15px;
            }
            
            .card-section h3 i {
                font-size: 0.9em;
                opacity: 0.8;
            }
            
            /* Improved grid layouts */
            .results-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
                grid-gap: 15px;
                margin-bottom: 20px;
            }
            
            .stat-card {
                background: rgba(14, 36, 70, 0.3);
                border: 1px solid rgba(90, 200, 250, 0.2);
                border-radius: 8px;
                padding: 15px;
                display: flex;
                flex-direction: column;
                transition: all 0.2s ease;
            }
            
            .stat-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
                border-color: var(--primary, #5ac8fa);
            }
            
            .stat-card.highlight-card {
                background: rgba(80, 250, 123, 0.05);
                border: 1px solid rgba(80, 250, 123, 0.3);
            }
            
            .stat-card.secondary-card {
                background: rgba(90, 200, 250, 0.02);
                border: 1px solid rgba(90, 200, 250, 0.1);
            }
            
            .stat-label {
                font-size: 0.9em;
                opacity: 0.7;
                margin-bottom: 8px;
            }
            
            .stat-value {
                font-size: 1.5em;
                font-weight: bold;
                color: var(--bright, #8ce6ff);
            }
            
            .highlight-card .stat-value {
                color: var(--green, #50fa7b);
            }
            
            /* Enhanced chart containers */
            .chart-container {
                position: relative;
                margin: 20px 0;
                height: auto;
                background: rgba(14, 36, 70, 0.3);
                border: 1px solid rgba(90, 200, 250, 0.3);
                border-radius: 8px;
                padding: 15px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            }
            

            
            /* Legend styling */
            .chart-legend {
                display: flex;
                flex-wrap: wrap;
                gap: 20px;
                margin: 15px 0;
                justify-content: center;
                background: rgba(14, 36, 70, 0.2);
                padding: 10px;
                border-radius: 8px;
            }
            
            .legend-item {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 0.9em;
                padding: 5px 10px;
                border-radius: 20px;
                background: rgba(14, 36, 70, 0.3);
                transition: all 0.2s;
            }
            
            .legend-item:hover {
                background: rgba(14, 36, 70, 0.5);
                transform: scale(1.05);
            }
            
            .legend-color {
                width: 16px;
                height: 16px;
                border-radius: 3px;
                box-shadow: 0 0 3px rgba(0, 0, 0, 0.3);
            }
            
            /* Display options */
            .display-options {
                display: flex;
                justify-content: center;
                margin: 15px 0;
                gap: 10px;
            }
            
            .display-option {
                padding: 8px 15px;
                border: 1px solid rgba(90, 200, 250, 0.3);
                border-radius: 20px;
                cursor: pointer;
                font-size: 0.9em;
                transition: all 0.2s ease;
            }
            
            .display-option.active {
                background: rgba(90, 200, 250, 0.2);
                border-color: var(--primary, #5ac8fa);
                font-weight: bold;
            }
            
            .display-option:hover:not(.active) {
                background: rgba(90, 200, 250, 0.1);
            }
            
            /* Enhanced date cards */
            .date-forecast-info {
                margin-bottom: 20px;
                font-size: 0.95em;
                line-height: 1.5;
                padding: 15px;
                background: rgba(90, 200, 250, 0.05);
                border-left: 3px solid var(--primary, #5ac8fa);
                border-radius: 0 6px 6px 0;
            }
            
            .forecast-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                grid-gap: 20px;
                margin-bottom: 30px;
            }
            
            .date-card {
                background: rgba(14, 36, 70, 0.3);
                border: 1px solid rgba(90, 200, 250, 0.2);
                border-radius: 8px;
                padding: 20px;
                position: relative;
                overflow: hidden;
                transition: all 0.2s;
            }
            
            .date-card:hover {
                transform: translateY(-3px);
                box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
                border-color: var(--primary, #5ac8fa);
            }
            
            .date-card.highlight {
                border: 2px solid var(--primary, #5ac8fa);
                box-shadow: 0 0 15px rgba(90, 200, 250, 0.3);
            }
            
            .date-card.highlight::before {
                content: 'RECOMMENDED';
                position: absolute;
                top: 10px;
                right: -35px;
                background: var(--primary, #5ac8fa);
                color: var(--bg-darker, #091625);
                transform: rotate(45deg);
                padding: 5px 40px;
                font-size: 10px;
                font-weight: bold;
                z-index: 1;
                box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
            }
            
            .date-type {
                font-size: 1.2em;
                font-weight: bold;
                margin-bottom: 15px;
                color: var(--bright, #8ce6ff);
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .date-type::before {
                content: "📅";
                font-size: 1.1em;
            }
            
            .date-value {
                font-size: 1.5em;
                margin-bottom: 10px;
                padding: 8px;
                background: rgba(14, 36, 70, 0.4);
                border-radius: 6px;
                text-align: center;
            }
            
            .date-description {
                font-size: 0.9em;
                opacity: 0.8;
                margin-top: 15px;
                line-height: 1.4;
            }
            
            /* Enhanced table */
            .scrollable-table-container {
                max-height: 500px;
                overflow-y: auto;
                margin: 20px 0;
                border: 1px solid rgba(90, 200, 250, 0.2);
                border-radius: 8px;
                scrollbar-width: thin;
                scrollbar-color: var(--primary) rgba(14, 36, 70, 0.3);
            }
            
            .scrollable-table-container::-webkit-scrollbar {
                width: 8px;
            }
            
            .scrollable-table-container::-webkit-scrollbar-track {
                background: rgba(14, 36, 70, 0.3);
                border-radius: 8px;
            }
            
            .scrollable-table-container::-webkit-scrollbar-thumb {
                background-color: var(--primary);
                border-radius: 8px;
            }
            
            .sensitivity-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 0.95em;
            }
            
            .sensitivity-table th {
                position: sticky;
                top: 0;
                background: rgba(14, 36, 70, 0.8);
                z-index: 10;
                padding: 12px 15px;
                text-align: left;
                color: var(--bright, #8ce6ff);
                font-weight: bold;
                border-bottom: 2px solid var(--primary, #5ac8fa);
            }
            
            .sensitivity-table td {
                padding: 12px 15px;
                text-align: left;
                border-bottom: 1px solid rgba(90, 200, 250, 0.1);
            }
            
            .sensitivity-table tr:hover {
                background: rgba(90, 200, 250, 0.05);
            }
            
            .sensitivity-table tr:last-child td {
                border-bottom: none;
            }
            
            .impact-bar {
                height: 8px;
                background: linear-gradient(to right, #50fa7b, #ffb86c, #ff5555);
                border-radius: 4px;
                overflow: hidden;
                position: relative;
            }
            
            .impact-bar::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(
                    to bottom,
                    rgba(255, 255, 255, 0.1),
                    transparent
                );
            }
            
            .critical-task {
                color: var(--cyb-danger, #ff5555);
                font-weight: bold;
            }
            
            /* Completion status */
            .simulation-info {
                margin-top: 25px;
                font-size: 0.9em;
                opacity: 0.8;
                text-align: right;
                padding: 10px 15px;
                background: rgba(14, 36, 70, 0.2);
                border-radius: 6px;
            }
            
            /* Progress overlay with modern styling */
            .monte-carlo-progress-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(9, 22, 37, 0.95);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                font-family: var(--font-rajdhani, 'Rajdhani', sans-serif);
                backdrop-filter: blur(3px);
            }
            
            .monte-carlo-progress-container {
                width: 90%;
                max-width: 600px;
                background: rgba(13, 33, 55, 0.9);
                border: 1px solid rgba(90, 200, 250, 0.5);
                box-shadow: 0 0 30px rgba(90, 200, 250, 0.3);
                padding: 30px;
                border-radius: 10px;
                position: relative;
                overflow: hidden;
            }
            
            .monte-carlo-progress-header {
                color: var(--cyb-primary, #5ac8fa);
                font-size: 20px;
                margin-bottom: 25px;
                text-shadow: 0 0 10px rgba(90, 200, 250, 0.7);
                display: flex;
                align-items: center;
                gap: 10px;
                font-weight: bold;
            }
            
            .monte-carlo-progress-header::before {
                content: "🔬";
                font-size: 24px;
            }
            
            .monte-carlo-progress-status {
                color: var(--cyb-text1, #cdfaff);
                margin-bottom: 25px;
                font-size: 16px;
                min-height: 20px;
                display: flex;
                align-items: center;
                gap: 10px;
                background: rgba(14, 36, 70, 0.4);
                padding: 12px 15px;
                border-radius: 6px;
                border-left: 3px solid var(--primary, #5ac8fa);
            }
            
            .monte-carlo-progress-bar-container {
                border: 1px solid var(--cyb-primary, #5ac8fa);
                padding: 3px;
                background: rgba(90, 200, 250, 0.1);
                border-radius: 8px;
                overflow: hidden;
                position: relative;
            }
            
            .monte-carlo-progress-bar {
                height: 35px;
                width: 0%;
                background: linear-gradient(90deg,
                    rgba(90, 200, 250, 0.6),
                    rgba(90, 200, 250, 0.9)
                );
                position: relative;
                transition: width 0.3s ease;
                border-radius: 5px;
            }
            
            .monte-carlo-progress-bar::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: repeating-linear-gradient(
                    45deg,
                    transparent,
                    transparent 10px,
                    rgba(255, 255, 255, 0.1) 10px,
                    rgba(255, 255, 255, 0.1) 20px
                );
                animation: moveStripes 20s linear infinite;
                border-radius: 5px;
            }
            
            .monte-carlo-progress-percentage {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                color: white;
                font-weight: bold;
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
                z-index: 1;
            }
            
            .monte-carlo-scan-line {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 2px;
                background-color: rgba(255, 255, 255, 0.5);
                box-shadow: 0 0 15px rgba(90, 200, 250, 0.9);
                animation: scan 2s linear infinite;
                z-index: 2;
            }
            
            @keyframes moveStripes {
                from { background-position: 0 0; }
                to { background-position: 50px 50px; }
            }
            
            @keyframes scan {
                0% { top: 0; }
                100% { top: 100%; }
            }
            
            /* Responsive adjustments */
            @media (max-width: 768px) {
                .controls-section {
                    flex-direction: column;
                    align-items: stretch;
                }
                
                .input-group {
                    flex-direction: column;
                    align-items: flex-start;
                }
                
                .input-group label {
                    margin-bottom: 5px;
                }
                
                .results-grid {
                    grid-template-columns: 1fr;
                }
                
                .forecast-grid {
                    grid-template-columns: 1fr;
                }
                
                .tabs {
                    flex-wrap: nowrap;
                    overflow-x: auto;
                    padding-bottom: 5px;
                }
                
                .tab {
                    flex: 0 0 auto;
                    white-space: nowrap;
                }
                
                .tab::after {
                    display: none;
                }
            }
            
            /* Tooltip utility */
            .tooltip-icon {
                cursor: help;
                color: var(--primary);
                font-size: 0.8em;
                position: relative;
                margin-left: 5px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 16px;
                height: 16px;
                border: 1px solid var(--primary);
                border-radius: 50%;
            }
            
            .tooltip-icon:hover::after {
                content: attr(data-tooltip);
                position: absolute;
                bottom: 100%;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(14, 36, 70, 0.9);
                padding: 8px 12px;
                border-radius: 6px;
                font-size: 0.8em;
                white-space: normal;
                width: 200px;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
                border: 1px solid var(--primary);
                z-index: 100;
            }
        </style>
        
        <h2 class="section-title">Monte Carlo Schedule Simulation</h2>
        
        <div class="description">
            This simulation forecasts project completion dates by analyzing uncertainty in task durations.
            It runs thousands of randomized schedule calculations, generating a statistical distribution
            of possible finish dates and highlighting which tasks have the greatest impact on schedule risk.
        </div>
        
        <div class="controls-section">
            <div class="input-group">
                <label for="iterationCount">Number of Iterations:</label>
                <input type="number" id="iterationCount" value="5000" min="100" max="100000">
                <span class="tooltip-icon" data-tooltip="More iterations produce more accurate results but take longer to run. 5,000 iterations provide a good balance between accuracy and performance.">i</span>
            </div>
            
            <div class="input-group">
                <label for="displayMode">Display Mode:</label>
                <select id="displayMode">
                    <option value="hours">Hours</option>
                    <option value="days">Working Days</option>
                    <option value="dates">Calendar Dates</option>
                </select>
                <span class="tooltip-icon" data-tooltip="Choose how to display simulation results: in raw hours, in working days based on your calendar, or as calendar dates.">i</span>
            </div>
            
            <button id="runSimulationButton" class="monte-carlo-button">
                <i class="fas fa-play-circle"></i> Run Simulation
            </button>
        </div>
        
        <div class="results-section card-section" id="resultsSection" style="display: none;">
            <div class="mc-tabs">
                <div class="mc-tab active" data-tab="summary" data-tooltip="View summary statistics from the simulation">Summary</div>
                <div class="mc-tab" data-tab="histogram" data-tooltip="Visualize the distribution of possible completion times">Histogram</div>
                <div class="mc-tab" data-tab="cumulative" data-tooltip="See cumulative probability (S-curve) of completion dates">Cumulative Chart</div>
                <div class="mc-tab" data-tab="calendar" data-tooltip="View recommended completion dates at different confidence levels">Date Forecasts</div>
                <div class="mc-tab" data-tab="sensitivity" data-tooltip="Identify which tasks have the most impact on schedule uncertainty">Sensitivity Analysis</div>
            </div>

            <div class="mc-tab-content active" id="summaryTab">
                <h3><i class="fas fa-chart-pie"></i> Simulation Summary</h3>
                <div class="results-grid" id="resultsGrid">
                    <!-- Results will be populated here -->
                </div>
            </div>

            <div class="mc-tab-content" id="histogramTab">
                <h3><i class="fas fa-chart-bar"></i> Duration Distribution Histogram</h3>
                <p>This histogram shows the frequency distribution of possible project durations based on simulation results.</p>
                <div class="chart-container">
                    <canvas id="histogramCanvas" width="800" height="350"></canvas>
                    <div class="chart-tooltip" id="histogramTooltip"></div>
                </div>
                <div class="chart-legend">
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: rgba(80, 250, 123, 0.8);"></div>
                        <span>Frequency Distribution</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: rgba(255, 184, 108, 0.8);"></div>
                        <span>P50 (Median)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: rgba(255, 85, 85, 0.8);"></div>
                        <span>P80 (High Confidence)</span>
                    </div>
                </div>
            </div>
            
            <div class="mc-tab-content" id="cumulativeTab">
                <h3><i class="fas fa-chart-line"></i> Cumulative Distribution (S-Curve)</h3>
                <p>The S-curve shows the probability of completing the project by a specific date. Each point represents the percentage of simulation runs that finished by that date.</p>
                <div class="chart-container">
                    <canvas id="cumulativeCanvas" width="800" height="350"></canvas>
                    <div class="chart-tooltip" id="cumulativeTooltip"></div>
                </div>
                <div class="chart-legend">
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: rgba(80, 250, 123, 0.8);"></div>
                        <span>Cumulative Probability</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: rgba(255, 184, 108, 0.8);"></div>
                        <span>P50 (50% Confidence)</span>
                    </div>
                    <div class="legend-item">
                        <div class="legend-color" style="background-color: rgba(255, 85, 85, 0.8);"></div>
                        <span>P80 (80% Confidence)</span>
                    </div>
                </div>
            </div>
            
            <div class="mc-tab-content" id="calendarTab">
                <h3><i class="fas fa-calendar-alt"></i> Project End Date Forecasts</h3>
                <div class="date-forecast-info">
                    Below are the forecasted completion dates at different confidence levels. Higher confidence levels (P80, P90) provide more conservative estimates that are less likely to be exceeded.
                </div>
                <div class="forecast-grid" id="dateGrid">
                    <!-- End date forecasts will be populated here -->
                </div>
            </div>
            
            <div class="mc-tab-content" id="sensitivityTab">
                <h3><i class="fas fa-search"></i> Task Sensitivity Analysis</h3>
                <div class="date-forecast-info">
                    This analysis identifies which tasks have the greatest impact on schedule uncertainty. Tasks with high sensitivity scores should be monitored closely and may benefit most from risk mitigation efforts.
                </div>
                <div class="scrollable-table-container">
                    <table class="sensitivity-table" id="sensitivityTable">
                        <thead>
                            <tr>
                                <th>Task</th>
                                <th>Schedule Impact</th>
                                <th>Correlation</th>
                                <th>Uncertainty</th>
                            </tr>
                        </thead>
                        <tbody>
                            <!-- Sensitivity data will be populated here -->
                        </tbody>
                    </table>
                </div>
            </div>
            
            <div class="simulation-info" id="simulationInfo">
                <!-- Simulation info will be populated here -->
            </div>
        </div>
    `;

            // Insert container into the target element
            const target = document.getElementById('monteCarloSimulationContainer');
            if (target) {
                target.innerHTML = "";
                target.appendChild(container);
            } else {
                console.warn("Monte Carlo container not found in DOM. Simulation not rendered.");
                // Do NOT append to document.body
            }
        },

        /**
         * Update the interface with simulation results
         */
        updateInterface() {
            if (!this.state.simulationSummary) {
                return;
            }

            // Show results section
            const resultsSection = document.getElementById('resultsSection');
            if (resultsSection) {
                resultsSection.style.display = 'block';
            }

            // Update summary tab
            this.updateSummaryTab();

            // Update calendar tab
            this.updateCalendarTab();

            // Update sensitivity tab
            this.updateSensitivityTab();

            // Update simulation info
            const simulationInfo = document.getElementById('simulationInfo');
            if (simulationInfo && this.state.simulationSummary) {
                const summary = this.state.simulationSummary;
                const duration = summary.simulationDuration || 0;

                simulationInfo.innerHTML = `
                    Simulation completed with ${summary.iterationCount.toLocaleString()} iterations 
                    in ${(duration / 1000).toFixed(2)} seconds
                `;
            }

            // Draw histogram
            this.drawHistogram();

            // Draw cumulative chart
            this.drawCumulativeChart();

            // Attach tab event handlers
            this.attachTabHandlers();
        },

        /**
         * Update the summary tab with result cards
         */
        updateSummaryTab() {
            const resultsGrid = document.getElementById('resultsGrid');
            if (!resultsGrid || !this.state.simulationSummary) return;

            const summary = this.state.simulationSummary;
            const displayUnit = document.getElementById('displayMode').value || this.state.displayUnit;

            let cardHTML = '';

            // Format date
            const formatDate = date => {
                if (!date) return 'N/A';
                return date.toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                });
            };

            if (displayUnit === 'dates' && summary.endDateResults) {
                // Date-based display
                const dateResults = summary.endDateResults;

                cardHTML += `
                    <div class="stat-card highlight-card">
                        <div class="stat-label">P50 (Median) End Date</div>
                        <div class="stat-value">${formatDate(dateResults.p50)}</div>
                    </div>
                    <div class="stat-card highlight-card">
                        <div class="stat-label">P80 Confidence End Date</div>
                        <div class="stat-value">${formatDate(dateResults.p80)}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">P90 High Confidence</div>
                        <div class="stat-value">${formatDate(dateResults.p90)}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Mean End Date</div>
                        <div class="stat-value">${formatDate(dateResults.mean)}</div>
                    </div>
                    <div class="stat-card secondary-card">
                        <div class="stat-label">Earliest Projected End Date</div>
                        <div class="stat-value">${formatDate(dateResults.min)}</div>
                    </div>
                    <div class="stat-card secondary-card">
                        <div class="stat-label">Latest Projected End Date</div>
                        <div class="stat-value">${formatDate(dateResults.max)}</div>
                    </div>
                `;
            } else if (displayUnit === 'days' && summary.daysResults) {
                // Working days display
                const days = summary.daysResults;

                cardHTML += `
                    <div class="stat-card highlight-card">
                        <div class="stat-label">P50 (Median) Working Days</div>
                        <div class="stat-value">${days.p50.toFixed(1)} days</div>
                    </div>
                    <div class="stat-card highlight-card">
                        <div class="stat-label">P80 Confidence Working Days</div>
                        <div class="stat-value">${days.p80.toFixed(1)} days</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">P90 High Confidence</div>
                        <div class="stat-value">${days.p90.toFixed(1)} days</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Mean Duration</div>
                        <div class="stat-value">${days.mean.toFixed(1)} days</div>
                    </div>
                    <div class="stat-card secondary-card">
                        <div class="stat-label">Minimum Duration</div>
                        <div class="stat-value">${days.min.toFixed(1)} days</div>
                    </div>
                    <div class="stat-card secondary-card">
                        <div class="stat-label">Maximum Duration</div>
                        <div class="stat-value">${days.max.toFixed(1)} days</div>
                    </div>
                    <div class="stat-card secondary-card">
                        <div class="stat-label">Standard Deviation</div>
                        <div class="stat-value">${days.stdDev.toFixed(1)} days</div>
                    </div>
                `;
            } else {
                // Hours display (default)
                cardHTML += `
                    <div class="stat-card highlight-card">
                        <div class="stat-label">P50 (Median) Duration</div>
                        <div class="stat-value">${summary.median.toFixed(1)} ${summary.timeUnit}</div>
                    </div>
                    <div class="stat-card highlight-card">
                        <div class="stat-label">P80 Confidence</div>
                        <div class="stat-value">${summary.percentileResults.p80.toFixed(1)} ${summary.timeUnit}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">P90 High Confidence</div>
                        <div class="stat-value">${summary.percentileResults.p90.toFixed(1)} ${summary.timeUnit}</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">Mean Duration</div>
                        <div class="stat-value">${summary.mean.toFixed(1)} ${summary.timeUnit}</div>
                    </div>
                    <div class="stat-card secondary-card">
                        <div class="stat-label">Minimum Duration</div>
                        <div class="stat-value">${summary.min.toFixed(1)} ${summary.timeUnit}</div>
                    </div>
                    <div class="stat-card secondary-card">
                        <div class="stat-label">Maximum Duration</div>
                        <div class="stat-value">${summary.max.toFixed(1)} ${summary.timeUnit}</div>
                    </div>
                    <div class="stat-card secondary-card">
                        <div class="stat-label">Standard Deviation</div>
                        <div class="stat-value">${summary.stdDev.toFixed(1)} ${summary.timeUnit}</div>
                    </div>
                `;
            }

            // Add more confidence levels
            cardHTML += `
                <div class="stat-card secondary-card">
                    <div class="stat-label">P95 Confidence Level</div>
                    <div class="stat-value">${summary.percentileResults.p95.toFixed(1)} ${summary.timeUnit}</div>
                </div>
                <div class="stat-card secondary-card">
                    <div class="stat-label">P99 Confidence Level</div>
                    <div class="stat-value">${summary.percentileResults.p99.toFixed(1)} ${summary.timeUnit}</div>
                </div>
            `;

            resultsGrid.innerHTML = cardHTML;
        },

        /**
         * Update the calendar tab with end date forecasts
         */
        updateCalendarTab() {
            const dateGrid = document.getElementById('dateGrid');
            if (!dateGrid || !this.state.simulationSummary || !this.state.simulationSummary.endDateResults) return;

            const forecasts = this.state.simulationSummary.endDateResults;
            let dateHTML = '';

            // Format date with more detail
            const formatDateDetailed = date => {
                if (!date) return 'N/A';
                return date.toLocaleDateString('en-US', {
                    weekday: 'short',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
            };

            dateHTML += `
                <div class="date-card highlight">
                    <div class="date-type">P50 (Median) End Date</div>
                    <div class="date-value">${formatDateDetailed(forecasts.p50)}</div>
                    <div class="date-description">
                        50% probability of completion by this date. Suitable for stakeholder commitments when some risk is acceptable.
                    </div>
                </div>
                <div class="date-card highlight">
                    <div class="date-type">P80 (Conservative) End Date</div>
                    <div class="date-value">${formatDateDetailed(forecasts.p80)}</div>
                    <div class="date-description">
                        80% probability of completion by this date. Recommended for most external commitments.
                    </div>
                </div>
                <div class="date-card">
                    <div class="date-type">P90 (High Confidence) End Date</div>
                    <div class="date-value">${formatDateDetailed(forecasts.p90)}</div>
                    <div class="date-description">
                        90% probability of completion by this date. Use for critical deliverables or high-risk projects.
                    </div>
                </div>
                <div class="date-card">
                    <div class="date-type">P95 (Very High Confidence) End Date</div>
                    <div class="date-value">${formatDateDetailed(forecasts.p95)}</div>
                    <div class="date-description">
                        95% probability of completion by this date. For risk-averse planning.
                    </div>
                </div>
                <div class="date-card">
                    <div class="date-type">Mean End Date</div>
                    <div class="date-value">${formatDateDetailed(forecasts.mean)}</div>
                    <div class="date-description">
                        Average of all simulated end dates. Usually slightly later than median due to right-skew distribution.
                    </div>
                </div>
                <div class="date-card">
                    <div class="date-type">Earliest Projected End Date</div>
                    <div class="date-value">${formatDateDetailed(forecasts.min)}</div>
                    <div class="date-description">
                        Earliest completion date seen in the simulation. Represents best-case scenario.
                    </div>
                </div>
            `;

            dateGrid.innerHTML = dateHTML;
        },

        /**
         * Update the sensitivity tab with resource impact information
         */
        updateSensitivityTab() {
            const sensitivityTable = document.getElementById('sensitivityTable');
            if (!sensitivityTable || !this.state.sensitivityAnalysis) return;

            const sensitivityData = this.state.sensitivityAnalysis;

            // NEW: Get resource impact analysis
            const resourceImpact = this.analyzeResourceImpact();

            // Create table header row 
            let tableHTML = `
        <thead>
            <tr>
                <th>Task</th>
                <th>
                    Schedule Impact
                    <span class="tooltip-icon" data-tooltip="Combined effect of a task's variation and correlation with project completion. Higher values indicate tasks with stronger influence on the project finish date.">i</span>
                </th>
                <th>
                    Correlation
                    <span class="tooltip-icon" data-tooltip="Statistical correlation between a task's finish time and the project finish time. Values closer to 1.0 indicate that when this task finishes later, the project almost always finishes later.">i</span>
                </th>
                <th>
                    Uncertainty
                    <span class="tooltip-icon" data-tooltip="Relative variability of a task's duration (standard deviation / mean). Higher values indicate tasks with more unpredictable durations.">i</span>
                </th>
                <th>
                    Risk Score
                    <span class="tooltip-icon" data-tooltip="Network-based risk score indicating likelihood of duration overruns based on position and complexity. Higher values indicate tasks more likely to experience delays.">i</span>
                </th>
                <th>
                    Importance Score
                    <span class="tooltip-icon" data-tooltip="Network-based importance score indicating strategic importance based on task's network position. Higher values indicate tasks that are more crucial to project success.">i</span>
                </th>
                <th>
                    Resources
                    <span class="tooltip-icon" data-tooltip="Current resource allocation for this task. Constrained tasks have limitations on additional resources.">i</span>
                </th>
                <th>
                    Recommendation
                    <span class="tooltip-icon" data-tooltip="Actionable guidance based on combined analysis of simulation results and network metrics.">i</span>
                </th>
            </tr>
        </thead>
        <tbody>
    `;

            // Only show top 20 most impactful tasks
            const topSensitivityData = sensitivityData.slice(0, 20);

            // Find maximum impact for scaling bars
            const maxImpact = Math.max(...topSensitivityData.map(d => Math.abs(d.impact)));

            topSensitivityData.forEach(task => {
                const impactPercent = Math.min(100, Math.abs(task.impact) / maxImpact * 100);
                const correlationFormatted = task.correlation.toFixed(2);
                const variationFormatted = task.variationCoeff.toFixed(2);
                const className = task.isCritical ? 'critical-task' : '';

                // Get node data for additional metrics
                const node = nodes.find(n => n.ID === task.taskId);
                if (!node) return; // Skip if node not found

                // Get risk and importance scores
                const riskScore = node.ComputedRiskScore || node.riskScore || 0;
                const importanceScore = node.ComputedImportanceScore || node.importanceScore || 0;

                // Format scores as percentages
                const riskScoreFormatted = (riskScore * 100).toFixed(0) + '%';
                const importanceScoreFormatted = (importanceScore * 100).toFixed(0) + '%';

                // Determine score classes for coloring
                const riskClass = riskScore > 0.7 ? 'high-risk' :
                    riskScore > 0.4 ? 'medium-risk' : 'low-risk';

                const importanceClass = importanceScore > 0.7 ? 'high-importance' :
                    importanceScore > 0.4 ? 'medium-importance' : 'low-importance';

                // Get resource information for this task
                const record = this.state.originalDurations.get(task.taskId);
                const resources = record ? record.resources || 1 : 1;
                const isResourceConstrained = record && record.isResourceConstrained;

                // Resource display with constraint indicator
                const resourceDisplay = isResourceConstrained ?
                    `${resources} <span class="resource-constrained">(Constrained)</span>` :
                    resources.toString();

                // Generate recommendation based on combined metrics
                const recommendation = generateTaskRecommendation(
                    task.impact,
                    task.correlation,
                    task.variationCoeff,
                    riskScore,
                    importanceScore,
                    task.isCritical,
                    task.isNearCritical,
                    isResourceConstrained
                );

                tableHTML += `
            <tr>
                <td class="${className}">${task.name}</td>
                <td>
                    <div class="impact-bar" style="width: ${impactPercent}%"></div>
                </td>
                <td>${correlationFormatted}</td>
                <td>${variationFormatted}</td>
                <td class="${riskClass}">${riskScoreFormatted}</td>
                <td class="${importanceClass}">${importanceScoreFormatted}</td>
                <td>${resourceDisplay}</td>
                <td class="recommendation-cell">${recommendation.html}</td>
            </tr>
        `;
            });

            tableHTML += '</tbody>';
            sensitivityTable.innerHTML = tableHTML;

            // Add CSS for enhanced table
            const styleElement = document.createElement('style');
            styleElement.textContent = `
        .high-risk { color: var(--cyb-danger, #ff5555); font-weight: bold; }
        .medium-risk { color: var(--cyb-warning, #ffb86c); font-weight: bold; }
        .low-risk { color: var(--cyb-success, #50fa7b); }
        
        .high-importance { color: var(--cyb-purple, #bd93f9); font-weight: bold; }
        .medium-importance { color: var(--cyb-info, #8be9fd); font-weight: bold; }
        .low-importance { color: #f8f8f2; }
        
        .recommendation-cell {
            font-size: 12px;
            max-width: 250px;
            padding: 8px;
            line-height: 1.4;
        }
        
        .recommendation-tag {
            display: inline-block;
            padding: 3px 6px;
            margin: 2px 4px 2px 0;
            border-radius: 4px;
            font-size: 11px;
            font-weight: bold;
        }
        
        .critical-tag { background-color: rgba(255, 85, 85, 0.2); color: var(--cyb-danger, #ff5555); border: 1px solid var(--cyb-danger, #ff5555); }
        .high-risk-tag { background-color: rgba(255, 184, 108, 0.2); color: var(--cyb-warning, #ffb86c); border: 1px solid var(--cyb-warning, #ffb86c); }
        .strategic-tag { background-color: rgba(189, 147, 249, 0.2); color: var(--cyb-purple, #bd93f9); border: 1px solid var(--cyb-purple, #bd93f9); }
        .buffer-tag { background-color: rgba(80, 250, 123, 0.2); color: var(--cyb-success, #50fa7b); border: 1px solid var(--cyb-success, #50fa7b); }
        .monitor-tag { background-color: rgba(139, 233, 253, 0.2); color: var(--cyb-info, #8be9fd); border: 1px solid var(--cyb-info, #8be9fd); }
        
        .resource-constrained {
            font-style: italic;
            color: var(--cyb-danger, #ff5555);
            font-size: 0.9em;
        }
        
        .tooltip-icon {
            display: inline-block;
            width: 14px;
            height: 14px;
            background: rgba(139, 233, 253, 0.2);
            color: var(--cyb-info, #8be9fd);
            border: 1px solid var(--cyb-info, #8be9fd);
            border-radius: 50%;
            text-align: center;
            line-height: 14px;
            font-size: 10px;
            margin-left: 4px;
            cursor: help;
            position: relative;
        }
        
        .tooltip-icon:hover::after {
            content: attr(data-tooltip);
            position: absolute;
            left: 50%;
            transform: translateX(-50%);
            bottom: 100%;
            background: rgba(13, 33, 55, 0.95);
            color: #f8f8f2;
            padding: 8px;
            border-radius: 4px;
            width: 200px;
            z-index: 10;
            font-size: 12px;
            font-weight: normal;
            line-height: 1.4;
            text-align: left;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            border: 1px solid var(--cyb-info, #8be9fd);
        }
    `;
            document.head.appendChild(styleElement);

            // Add resource impact summary if available
            if (resourceImpact) {
                const summaryDiv = document.createElement('div');
                summaryDiv.className = 'resource-impact-summary';
                summaryDiv.innerHTML = `
            <h4>Resource Impact Analysis</h4>
            <p>Resource-constrained tasks show an average duration increase of 
               ${(resourceImpact.avgConstrainedIncrease * 100 - 100).toFixed(1)}% in simulation
               compared to ${(resourceImpact.avgNonConstrainedIncrease * 100 - 100).toFixed(1)}%
               for non-constrained tasks.</p>
        `;

                sensitivityTable.parentNode.insertBefore(summaryDiv, sensitivityTable);
            }

            // Add an understanding section at the top
            const guidanceDiv = document.createElement('div');
            guidanceDiv.className = 'sensitivity-guidance';
            guidanceDiv.innerHTML = `
            <div style="margin: 15px 0; padding: 15px; background: rgba(90, 200, 250, 0.05); border-left: 3px solid var(--primary, #5ac8fa); border-radius: 4px;">
                <h4 style="margin-top: 0;">How to Use This Table</h4>
                <p>This table combines simulation-based metrics (Impact, Correlation, Uncertainty) with network analysis metrics (Risk Score, Importance Score) to provide a comprehensive view of task criticality.</p>
                <ul style="margin-bottom: 0;">
                    <li><strong>Schedule Impact:</strong> Overall influence on project completion date</li>
                    <li><strong>Correlation:</strong> How closely task delays correspond to project delays</li>
                    <li><strong>Uncertainty:</strong> Variability of task duration</li>
                    <li><strong>Risk Score:</strong> Likelihood of overruns based on network position and complexity</li>
                    <li><strong>Importance Score:</strong> Strategic significance based on network position</li>
                </ul>
                <p>Priority should be given to tasks with high values across multiple metrics.</p>
            </div>
        `;

            sensitivityTable.parentNode.insertBefore(guidanceDiv, sensitivityTable);
        },

        /**
         * Draw histogram from simulation results
         */
        drawHistogram() {
            const canvas = document.getElementById('histogramCanvas');
            if (!canvas || !this.state.simulationHistogramData) {
                return;
            }

            const ctx = canvas.getContext('2d');
            const data = this.state.simulationHistogramData;
            const summary = this.state.simulationSummary;
            const displayMode = document.getElementById('displayMode').value || this.state.displayUnit;

            // Clear canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Set up chart dimensions
            const padding = { top: 30, right: 30, bottom: 30, left: 30 };
            const chartWidth = canvas.width - padding.left - padding.right;
            const chartHeight = canvas.height - padding.top - padding.bottom;

            // Find maximum bin count for scaling
            const maxBinCount = Math.max(...data.bins);

            // Calculate bar width
            const barWidth = chartWidth / data.bins.length - 2;

            // Draw axes
            ctx.strokeStyle = '#5ac8fa';
            ctx.lineWidth = 1;

            // Y-axis
            ctx.beginPath();
            ctx.moveTo(padding.left, padding.top);
            ctx.lineTo(padding.left, padding.top + chartHeight);
            ctx.stroke();

            // X-axis
            ctx.beginPath();
            ctx.moveTo(padding.left, padding.top + chartHeight);
            ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
            ctx.stroke();

            // Calculate Y-axis ticks
            const yTickCount = 5;
            const yTickStep = maxBinCount / yTickCount;

            // Draw Y-axis ticks and labels
            ctx.fillStyle = '#cdfaff';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.font = '10px Arial';

            for (let i = 0; i <= yTickCount; i++) {
                const value = i * yTickStep;
                const y = padding.top + chartHeight - (i * chartHeight / yTickCount);

                // Tick
                ctx.beginPath();
                ctx.moveTo(padding.left - 5, y);
                ctx.lineTo(padding.left, y);
                ctx.stroke();

                // Label
                ctx.fillText(Math.round(value), padding.left - 8, y);
            }

            // Draw X-axis labels (only some to avoid crowding)
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            // Determine label frequency based on number of bins
            const labelFrequency = Math.ceil(data.bins.length / 10);

            data.bins.forEach((count, i) => {
                if (i % labelFrequency === 0) {
                    const binMiddle = data.min + (i * data.binWidth) + (data.binWidth / 2);
                    let label;

                    if (displayMode === 'dates') {
                        // For date mode, convert to date string
                        const date = this.calculateEndDate(binMiddle);
                        label = date.toLocaleDateString();
                    } else if (displayMode === 'days') {
                        // For days mode, convert hours to days
                        const days = binMiddle / (this.state.simulationSummary.timeUnitConversion || 8);
                        label = days.toFixed(1);
                    } else {
                        // For hours mode, use hours
                        label = binMiddle.toFixed(0);
                    }

                    const x = padding.left + (i * chartWidth / data.bins.length) + barWidth / 2;

                    // Label
                    ctx.save();
                    ctx.translate(x, padding.top + chartHeight + 5);
                    ctx.rotate(Math.PI / 4); // Rotate labels to fit better
                    ctx.fillText(label, 0, 0);
                    ctx.restore();
                }
            });

            // Draw axis labels
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '12px Arial';

            // X-axis label
            const xLabel = displayMode === 'dates' ? 'Completion Date' :
                displayMode === 'days' ? 'Duration (Working Days)' :
                    `Duration (${summary.timeUnit})`;
            ctx.fillText(xLabel, padding.left + chartWidth / 2, padding.top + chartHeight + 40);

            // Y-axis label
            ctx.save();
            ctx.translate(padding.left - 40, padding.top + chartHeight / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText('Frequency', 0, 0);
            ctx.restore();

            // Draw title
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.font = 'bold 14px Arial';
            ctx.fillText('Project Duration Distribution', padding.left + chartWidth / 2, 10);

            // Draw histogram bars
            data.bins.forEach((count, i) => {
                const x = padding.left + (i * chartWidth / data.bins.length);
                const barHeight = (count / maxBinCount) * chartHeight;
                const y = padding.top + chartHeight - barHeight;

                // Draw bar
                ctx.fillStyle = 'rgba(80, 250, 123, 0.8)';
                ctx.fillRect(x, y, barWidth, barHeight);

                // Bar border
                ctx.strokeStyle = 'rgba(80, 250, 123, 1)';
                ctx.strokeRect(x, y, barWidth, barHeight);
            });

            // Draw percentile lines
            const drawPercentileLine = (percentile, color, label) => {
                if (!summary.percentileResults[percentile]) return;

                let value = summary.percentileResults[percentile];
                let x = padding.left + ((value - data.min) / (data.max - data.min)) * chartWidth;

                if (displayMode === 'dates') {
                    // Draw date lines based on hour value relative to range
                    value = summary.percentileResults[percentile];
                    x = padding.left + ((value - data.min) / (data.max - data.min)) * chartWidth;
                }

                // Line
                ctx.beginPath();
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 3]);
                ctx.moveTo(x, padding.top);
                ctx.lineTo(x, padding.top + chartHeight);
                ctx.stroke();
                ctx.setLineDash([]);

                // Label
                ctx.fillStyle = color;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                ctx.font = '10px Arial';
                ctx.fillText(label, x + 5, padding.top - 5);
            };

            drawPercentileLine('p50', 'rgba(255, 184, 108, 0.8)', 'P50');
            drawPercentileLine('p80', 'rgba(255, 140, 85, 0.8)', 'P80');
            drawPercentileLine('p90', 'rgba(255, 85, 85, 0.8)', 'P90');

            // Set up histogram tooltip
            const tooltip = document.getElementById('histogramTooltip');
            if (tooltip && canvas) {
                canvas.addEventListener('mousemove', (event) => {
                    const rect = canvas.getBoundingClientRect();
                    const x = event.clientX - rect.left;
                    const y = event.clientY - rect.top;

                    // Check if mouse is over a bar
                    if (x >= padding.left && x <= padding.left + chartWidth &&
                        y >= padding.top && y <= padding.top + chartHeight) {

                        // Calculate bin index
                        const binIndex = Math.floor((x - padding.left) / (chartWidth / data.bins.length));

                        if (binIndex >= 0 && binIndex < data.bins.length) {
                            const count = data.bins[binIndex];
                            const binStart = data.min + (binIndex * data.binWidth);
                            const binEnd = binStart + data.binWidth;

                            // Format display values based on display mode
                            let rangeText;
                            if (displayMode === 'dates') {
                                const startDate = this.calculateEndDate(binStart);
                                const endDate = this.calculateEndDate(binEnd);
                                rangeText = `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
                            } else if (displayMode === 'days') {
                                const startDays = binStart / summary.timeUnitConversion;
                                const endDays = binEnd / summary.timeUnitConversion;
                                rangeText = `${startDays.toFixed(1)} - ${endDays.toFixed(1)} days`;
                            } else {
                                rangeText = `${binStart.toFixed(1)} - ${binEnd.toFixed(1)} ${summary.timeUnit}`;
                            }

                            const percentage = (count / summary.iterationCount) * 100;

                            // Show tooltip
                            tooltip.style.display = 'block';
                            tooltip.style.left = `${event.clientX - rect.left + 10}px`;
                            tooltip.style.top = `${event.clientY - rect.top + 10}px`;
                            tooltip.innerHTML = `
                                Range: ${rangeText}<br>
                                Count: ${count} (${percentage.toFixed(1)}%)
                            `;
                        }
                    } else {
                        tooltip.style.display = 'none';
                    }
                });

                canvas.addEventListener('mouseout', () => {
                    tooltip.style.display = 'none';
                });
            }
        },

        /**
         * Draw cumulative distribution (S-curve) from simulation results
         */
        drawCumulativeChart() {
            const canvas = document.getElementById('cumulativeCanvas');
            if (!canvas || !this.state.simulationResults.length) {
                return;
            }

            const ctx = canvas.getContext('2d');
            const summary = this.state.simulationSummary;
            const displayMode = document.getElementById('displayMode').value || this.state.displayUnit;

            // Clear canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Set up chart dimensions
            const padding = { top: 30, right: 30, bottom: 60, left: 60 };
            const chartWidth = canvas.width - padding.left - padding.right;
            const chartHeight = canvas.height - padding.top - padding.bottom;

            // Sort results for cumulative chart
            const results = [...this.state.simulationResults].sort((a, b) => a - b);
            const n = results.length;

            // Convert hours to dates if in date mode
            let xValues = results;
            if (displayMode === 'dates') {
                xValues = results.map(hours => this.calculateEndDate(hours).getTime());
            } else if (displayMode === 'days') {
                xValues = results.map(hours => hours / summary.timeUnitConversion);
            }

            // Find min/max for axis scaling
            const minVal = Math.min(...xValues);
            const maxVal = Math.max(...xValues);
            const range = maxVal - minVal;

            // Draw axes
            ctx.strokeStyle = '#5ac8fa';
            ctx.lineWidth = 1;

            // Y-axis
            ctx.beginPath();
            ctx.moveTo(padding.left, padding.top);
            ctx.lineTo(padding.left, padding.top + chartHeight);
            ctx.stroke();

            // X-axis
            ctx.beginPath();
            ctx.moveTo(padding.left, padding.top + chartHeight);
            ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
            ctx.stroke();

            // Draw Y-axis ticks (probability)
            ctx.fillStyle = '#cdfaff';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.font = '10px Arial';

            for (let i = 0; i <= 10; i++) {
                const probability = i * 10;
                const y = padding.top + chartHeight - (i * chartHeight / 10);

                // Tick
                ctx.beginPath();
                ctx.moveTo(padding.left - 5, y);
                ctx.lineTo(padding.left, y);
                ctx.stroke();

                // Label
                ctx.fillText(`${probability}%`, padding.left - 8, y);
            }

            // Draw X-axis ticks
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            // Calculate tick values
            const tickCount = 6;
            const tickStep = range / tickCount;

            for (let i = 0; i <= tickCount; i++) {
                const value = minVal + (i * tickStep);
                const x = padding.left + (i * chartWidth / tickCount);

                // Tick
                ctx.beginPath();
                ctx.moveTo(x, padding.top + chartHeight);
                ctx.lineTo(x, padding.top + chartHeight + 5);
                ctx.stroke();

                // Label based on display mode
                let label;
                if (displayMode === 'dates') {
                    label = new Date(value).toLocaleDateString();
                } else if (displayMode === 'days') {
                    label = value.toFixed(1);
                } else {
                    label = value.toFixed(0);
                }

                // Draw rotated label
                ctx.save();
                ctx.translate(x, padding.top + chartHeight + 8);
                ctx.rotate(Math.PI / 6);
                ctx.fillText(label, 0, 0);
                ctx.restore();
            }

            // Draw axis labels
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = '12px Arial';

            // X-axis label
            const xLabel = displayMode === 'dates' ? 'Completion Date' :
                displayMode === 'days' ? 'Duration (Working Days)' :
                    `Duration (${summary.timeUnit})`;
            ctx.fillText(xLabel, padding.left + chartWidth / 2, padding.top + chartHeight + 45);

            // Y-axis label
            ctx.save();
            ctx.translate(padding.left - 40, padding.top + chartHeight / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText('Cumulative Probability', 0, 0);
            ctx.restore();

            // Draw title
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.font = 'bold 14px Arial';
            ctx.fillText('Project Completion Probability (S-Curve)', padding.left + chartWidth / 2, 10);

            // Draw cumulative curve
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(80, 250, 123, 0.8)';
            ctx.lineWidth = 3;

            xValues.forEach((value, i) => {
                const probability = (i / n) * 100;
                const x = padding.left + ((value - minVal) / range) * chartWidth;
                const y = padding.top + chartHeight - (probability / 100) * chartHeight;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });

            ctx.stroke();

            // Draw percentile reference lines
            const drawPercentileLine = (percentile, probability, color, label) => {
                let value;
                if (displayMode === 'dates') {
                    // Get forecasted date for this percentile
                    const dateObj = summary.endDateResults[`p${probability}`];
                    if (!dateObj) return;
                    value = dateObj.getTime();
                } else if (displayMode === 'days') {
                    // Get days value
                    value = summary.daysResults[`p${probability}`];
                } else {
                    // Get hours value
                    value = summary.percentileResults[`p${probability}`];
                }

                if (value === undefined) return;

                const x = padding.left + ((value - minVal) / range) * chartWidth;
                const y = padding.top + chartHeight - (probability / 100) * chartHeight;

                // Horizontal line
                ctx.beginPath();
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 3]);
                ctx.moveTo(padding.left, y);
                ctx.lineTo(x, y);
                ctx.stroke();

                // Vertical line
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x, padding.top + chartHeight);
                ctx.stroke();
                ctx.setLineDash([]);

                // Label
                ctx.fillStyle = color;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.font = '12px Arial';
                ctx.fillText(label, padding.left + 5, y - 10);

                // Value label
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(probability + '%', x, padding.top + chartHeight + 10);
            };

            drawPercentileLine('p50', 50, 'rgba(255, 184, 108, 0.8)', 'P50 (50%)');
            drawPercentileLine('p80', 80, 'rgba(255, 140, 85, 0.8)', 'P80 (80%)');
            drawPercentileLine('p90', 90, 'rgba(255, 85, 85, 0.8)', 'P90 (90%)');

            // Set up cumulative tooltip
            const tooltip = document.getElementById('cumulativeTooltip');
            if (tooltip && canvas) {
                canvas.addEventListener('mousemove', (event) => {
                    const rect = canvas.getBoundingClientRect();
                    const x = event.clientX - rect.left;
                    const y = event.clientY - rect.top;

                    // Check if mouse is in chart area
                    if (x >= padding.left && x <= padding.left + chartWidth &&
                        y >= padding.top && y <= padding.top + chartHeight) {

                        // Calculate value and probability
                        const value = minVal + ((x - padding.left) / chartWidth) * range;
                        const probability = 100 - ((y - padding.top) / chartHeight) * 100;

                        // Format display values based on display mode
                        let valueText;
                        if (displayMode === 'dates') {
                            valueText = new Date(value).toLocaleDateString();
                        } else if (displayMode === 'days') {
                            valueText = `${value.toFixed(1)} days`;
                        } else {
                            valueText = `${value.toFixed(1)} ${summary.timeUnit}`;
                        }

                        // Show tooltip
                        tooltip.style.display = 'block';
                        tooltip.style.left = `${event.clientX - rect.left + 10}px`;
                        tooltip.style.top = `${event.clientY - rect.top + 10}px`;
                        tooltip.innerHTML = `
                            ${displayMode === 'dates' ? 'Completion Date' : 'Duration'}: ${valueText}<br>
                            Probability: ${probability.toFixed(1)}%
                        `;
                    } else {
                        tooltip.style.display = 'none';
                    }
                });

                canvas.addEventListener('mouseout', () => {
                    tooltip.style.display = 'none';
                });
            }
        },

        /**
         * Attach event handlers to tabs
         */
        attachTabHandlers() {
            const tabs = document.querySelectorAll('.monte-carlo-container .mc-tab');
            const tabContents = document.querySelectorAll('.monte-carlo-container .mc-tab-content');

            tabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    // Remove active class from all tabs
                    tabs.forEach(t => t.classList.remove('active'));

                    // Add active class to clicked tab
                    tab.classList.add('active');

                    // Hide all tab contents
                    tabContents.forEach(content => content.classList.remove('active'));

                    // Show selected tab content
                    const tabId = tab.getAttribute('data-tab');
                    document.getElementById(`${tabId}Tab`).classList.add('active');
                });
            });

            // Handle display mode changes
            const displayModeSelect = document.getElementById('displayMode');
            if (displayModeSelect) {
                displayModeSelect.addEventListener('change', () => {
                    this.state.displayUnit = displayModeSelect.value;
                    this.updateInterface();
                });
            }
        },

        /**
         * Show progress overlay during simulation.
         */
        showProgressOverlay(message, percent = 0) {
            let overlay = document.getElementById('monteCarloProgressOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'monteCarloProgressOverlay';
                overlay.className = 'monte-carlo-progress-overlay';

                const container = document.createElement('div');
                container.className = 'monte-carlo-progress-container';

                const header = document.createElement('div');
                header.className = 'monte-carlo-progress-header';
                header.textContent = 'MONTE CARLO SIMULATION';

                const status = document.createElement('div');
                status.id = 'monteCarloProgressStatus';
                status.className = 'monte-carlo-progress-status';

                const progressContainer = document.createElement('div');
                progressContainer.className = 'monte-carlo-progress-bar-container';

                const progressBar = document.createElement('div');
                progressBar.id = 'monteCarloProgressBar';
                progressBar.className = 'monte-carlo-progress-bar';

                const scanLine = document.createElement('div');
                scanLine.className = 'monte-carlo-scan-line';

                progressBar.appendChild(scanLine);
                progressContainer.appendChild(progressBar);

                container.appendChild(header);
                container.appendChild(status);
                container.appendChild(progressContainer);

                overlay.appendChild(container);
                document.body.appendChild(overlay);
            }

            this.updateProgressOverlay(message, percent);
        },


        /**
         * Update progress overlay.
         */
        updateProgressOverlay(message, percent) {
            const statusElement = document.getElementById('monteCarloProgressStatus');
            const progressBar = document.getElementById('monteCarloProgressBar');

            if (statusElement) statusElement.textContent = message;
            if (progressBar) progressBar.style.width = `${percent}%`;

            this.state.currentSimulationProgress = percent;
        },

        /**
         * Hide progress overlay.
         */
        hideProgressOverlay() {
            const overlay = document.getElementById('monteCarloProgressOverlay');
            if (overlay) {
                overlay.style.opacity = '0';
                overlay.style.transition = 'opacity 0.5s ease';
                setTimeout(() => {
                    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                }, 500);
            }
        },

        /**
         * Attach event handlers for UI elements.
         */
        attachEventHandlers() {
            const runButton = document.getElementById('runSimulationButton');
            if (runButton) {
                runButton.addEventListener('click', async () => {
                    if (this.state.isSimulationRunning) {
                        alert('Simulation is already running. Please wait for it to complete.');
                        return;
                    }
                    const iterationInput = document.getElementById('iterationCount');
                    let iterations = 10000;
                    if (iterationInput) {
                        iterations = parseInt(iterationInput.value, 10) || 10000;
                        if (iterations < 100) iterations = 100;
                        if (iterations > 100000) iterations = 100000;
                        iterationInput.value = iterations;
                    }
                    console.log(`Running Monte Carlo simulation with ${iterations} iterations...`);
                    try {
                        await this.runSimulation(iterations);
                    } catch (error) {
                        console.error('Error running simulation:', error);
                        alert(`Simulation error: ${error.message}`);
                    }
                });
            }
        }
    };

    // Initialize and expose simulator
    simulator.initialize();
    simulator.renderInterface();
    simulator.attachEventHandlers();
    window.monteCarloSimulator = simulator;

    // Register optimization surfaces for orchestration
    var orch = window.CybereumOrchestration;
    if (orch && orch.registerRegion) {
        var optEl = document.getElementById('optimization-results') || document.getElementById('monte-carlo-container');
        if (optEl) orch.registerRegion('monte-carlo-sim', { element: optEl, type: 'analysis', label: 'Monte Carlo Simulation' });
    }

    return simulator;
}

// Export if in Node.js environment.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createMonteCarloSimulationInterface };
}

/**
 * Cybereum Constraint-Based Schedule Optimizer
 * 
 * Inspired by ALICE Technologies' approach to constraint-based optimization
 * for construction scheduling, this optimizer intelligently explores the
 * solution space to find optimal resource allocations for project schedules.
 * 
 * Key features:
 * - Multiple constraint types support (sequence, resource, time, quality)
 * - Multi-objective optimization (duration, cost, resource utilization, risk)
 * - Efficient solution space exploration using genetic algorithms
 * - Focus on critical and near-critical paths to narrow search space
 * - Interactive visualization and scenario comparison
 */
function createConstraintBasedOptimizer(nodes, links) {
    // Leverage existing scheduler and simulator
    const scheduler = window.scheduleOptimizer || createScheduleOptimizationInterface(nodes, links);
    const simulator = window.monteCarloSimulator || createMonteCarloSimulationInterface(nodes, links);

    // Internal state
    const state = {
        // Constraint sets for different constraint types
        constraints: {
            sequence: new Map(),  // Sequence constraints from dependencies
            resource: new Map(),  // Resource availability constraints
            time: new Map(),      // Time constraints (milestones, deadlines)
            quality: new Map()    // Quality/risk constraints
        },
        // Current solution and parameters
        currentSolution: new Map(), // Current resource allocation
        objectiveWeights: {
            duration: 0.4,   // Weight for duration reduction
            cost: 0.3,       // Weight for cost efficiency
            resources: 0.2,  // Weight for resource utilization
            risk: 0.1        // Weight for risk reduction
        },
        // Optimization parameters
        parameters: {
            populationSize: 50,
            maxGenerations: 30,
            mutationRate: 0.2,
            crossoverRate: 0.7,
            tournamentSize: 3,
            elitismCount: 5,
            maxResourcesPerTask: 5
        },
        // Scenario management
        scenarios: [],
        currentScenarioIndex: -1,
        // UI elements
        container: null,
        // Calendar
        calendar: window.cybereumState?.teamCalendar || {
            hoursPerDay: 8,
            workingDays: [1, 2, 3, 4, 5] // Monday through Friday
        }
    };

    /**
     * Extract and categorize constraints from the project data
     */
    function extractConstraints() {
        console.log("Extracting constraints from project data...");

        // Clear all existing constraints first
        Object.keys(state.constraints).forEach(type => {
            state.constraints[type].clear();
        });

        // Extract constraints in parallel
        const extractionPromises = [
            extractSequenceConstraints(),
            extractResourceConstraints(),
            extractTimeConstraints(),
            extractQualityConstraints()
        ];

        // Process all extractions and then notify the UI
        Promise.all(extractionPromises).then(() => {
            // Update UI to reflect new constraints
            if (state.container) {
                updateConstraintsSummary();
            }
            console.log("All constraints extracted successfully");
        }).catch(error => {
            console.error("Error extracting constraints:", error);
        });
    }

    /**
     * Extract sequence constraints from dependencies
     */
    function extractSequenceConstraints() {
        // Clear existing sequence constraints
        state.constraints.sequence.clear();

        // Get successor and predecessor maps from global state
        const succMap = window.cybereumState?.succMap;
        const predMap = window.cybereumState?.predMap;

        if (!succMap || !predMap) {
            console.warn("Successor/predecessor maps not available");
            return;
        }

        // Process all dependencies
        links.forEach(link => {
            const sourceId = typeof link.source === 'object' ? link.source.ID : link.source;
            const targetId = typeof link.target === 'object' ? link.target.ID : link.target;

            // Create constraint object
            const constraint = {
                type: link.type || 'FS', // Default to Finish-to-Start
                lag: Number(link.lag) || 0,
                lagHrs: window.scheduleUtils ?
                    getLinkLagHours(link) :
                    Number(link.lag) || 0,
                source: sourceId,
                target: targetId,
                hard: true // Sequence constraints are typically hard constraints
            };

            // Add to constraints map
            const key = `${sourceId}->${targetId}`;
            state.constraints.sequence.set(key, constraint);
        });

        console.log(`Extracted ${state.constraints.sequence.size} sequence constraints`);
    }

    /**
     * Extract resource constraints from task resource requirements
     */
    function extractResourceConstraints() {
        // Clear existing resource constraints
        state.constraints.resource.clear();

        // Resource pools - we'll create one constraint per resource type
        const resourcePools = new Map();

        // Process all nodes to collect resource requirements
        nodes.forEach(node => {
            const resources = Number(node.resourcesRequired) || 1;
            const resourceType = node.resourceType || 'default';

            // Update resource pool for this type
            if (!resourcePools.has(resourceType)) {
                resourcePools.set(resourceType, {
                    totalRequired: 0,
                    tasks: []
                });
            }

            const pool = resourcePools.get(resourceType);
            pool.totalRequired += resources;
            pool.tasks.push({
                id: node.ID,
                required: resources,
                duration: Number(node.Duration) || 0,
                start: new Date(node.Start),
                finish: new Date(node.Finish)
            });
        });

        // Create resource constraints from pools
        resourcePools.forEach((pool, resourceType) => {
            // Estimate available resources - this would normally come from input
            // For demonstration, we'll use 1.2 times the average simultaneous need

            // Sort tasks by start date
            pool.tasks.sort((a, b) => a.start - b.start);

            // Find maximum concurrent resource need using a simple simulation
            let maxConcurrent = 0;
            const activeResources = [];
            const timePoints = [];

            // Create time points for resource profile
            pool.tasks.forEach(task => {
                timePoints.push({
                    time: task.start,
                    task: task.id,
                    change: task.required,
                    isStart: true
                });

                timePoints.push({
                    time: task.finish,
                    task: task.id,
                    change: -task.required,
                    isStart: false
                });
            });

            // Sort time points
            timePoints.sort((a, b) => a.time - b.time);

            // Calculate resource profile
            let currentResources = 0;
            timePoints.forEach(point => {
                currentResources += point.change;
                maxConcurrent = Math.max(maxConcurrent, currentResources);
            });

            // Create constraint - add 20% buffer to max concurrent need
            const availableResources = Math.ceil(maxConcurrent * 1.2);

            state.constraints.resource.set(resourceType, {
                type: 'resource',
                resourceType: resourceType,
                available: availableResources,
                taskCount: pool.tasks.length,
                maxConcurrent: maxConcurrent,
                hard: true // Resource constraints are typically hard constraints
            });
        });

        console.log(`Extracted ${state.constraints.resource.size} resource constraints`);
    }

    /**
     * Extract time constraints from milestones and deadlines
     */
    function extractTimeConstraints() {
        // Clear existing time constraints
        state.constraints.time.clear();

        // Process milestone nodes
        nodes.forEach(node => {
            if (node.Milestone || node.milestone) {
                // Create deadline constraint
                state.constraints.time.set(node.ID, {
                    type: 'deadline',
                    taskId: node.ID,
                    date: new Date(node.Finish),
                    hard: Boolean(node.requiredDate || node.hardConstraint),
                    slack: Number(node.slack || 0)
                });
            }

            // Check for explicit date constraints
            if (node.requiredStart || node.requiredFinish || node.constraintDate) {
                const date = node.requiredStart ?
                    new Date(node.requiredStart) :
                    node.requiredFinish ?
                        new Date(node.requiredFinish) :
                        new Date(node.constraintDate);

                const constraintType = node.requiredStart ? 'start' :
                    node.requiredFinish ? 'finish' : 'deadline';

                state.constraints.time.set(`date-${node.ID}`, {
                    type: constraintType,
                    taskId: node.ID,
                    date: date,
                    hard: Boolean(node.hardConstraint),
                    slack: Number(node.slack || 0)
                });
            }
        });

        // Add project end date constraint if available
        if (window.cybereumState?.endDate) {
            state.constraints.time.set('project-end', {
                type: 'project-deadline',
                date: new Date(window.cybereumState.endDate),
                hard: false, // Usually a soft constraint for optimization
                slack: 0
            });
        }

        console.log(`Extracted ${state.constraints.time.size} time constraints`);
    }

    /**
     * Extract quality/risk constraints from risk profiles
     */
    function extractQualityConstraints() {
        state.constraints.quality.clear();

        // Get risk thresholds from user settings or defaults
        const settings = {
            highRiskThreshold: 0.7,
            highImportanceThreshold: 0.7,
            criticalPathFactor: 1.5,  // Multiply risk importance for critical path tasks
            outlierPathFactor: 1.2    // Multiply risk importance for near-critical path tasks
        };

        nodes.forEach(node => {
            // Calculate combined risk score using multiple factors
            const baseRiskScore = node.ComputedRiskScore || node.riskScore || 0;
            const importanceScore = node.ComputedImportanceScore || node.importanceScore || 0;
            const overrunProbability = node.overrun_probability || 0;

            // Apply path-based multipliers
            const pathMultiplier = node.isOnCriticalPath ? settings.criticalPathFactor :
                node.isOnOutlierPath ? settings.outlierPathFactor : 1.0;

            // Combined score gives weight to all factors
            const combinedRiskScore = (baseRiskScore * 0.4 + importanceScore * 0.3 + overrunProbability * 0.3) * pathMultiplier;

            // Create appropriate constraints based on risk profile
            if (combinedRiskScore > settings.highRiskThreshold || node.isRiskOutlier) {
                // High risk task - needs careful resource management
                state.constraints.quality.set(`risk-${node.ID}`, {
                    type: 'risk',
                    taskId: node.ID,
                    riskScore: baseRiskScore,
                    importanceScore: importanceScore,
                    overrunProbability: overrunProbability,
                    combinedRiskScore: combinedRiskScore,
                    isOutlier: Boolean(node.isRiskOutlier),
                    minAdditionalResources: node.isOnCriticalPath ? 1 : 0,  // Ensure critical high-risk tasks get resources
                    maxAdditionalResources: Math.ceil(3 * (1 - baseRiskScore)),  // Fewer resources for higher risk tasks
                    hard: node.isOnCriticalPath  // Hard constraint for critical path high-risk tasks
                });
            }

            if (importanceScore > settings.highImportanceThreshold || node.isImportanceOutlier) {
                // High importance task - prioritize for resources
                state.constraints.quality.set(`importance-${node.ID}`, {
                    type: 'importance',
                    taskId: node.ID,
                    importanceScore: importanceScore,
                    riskScore: baseRiskScore,
                    combinedRiskScore: combinedRiskScore,
                    isOutlier: Boolean(node.isImportanceOutlier),
                    minAdditionalResources: node.isOnCriticalPath ? 1 : 0,
                    preferredResources: Math.ceil(2 + importanceScore * 2),  // More resources for more important tasks
                    hard: false  // Typically soft constraints
                });
            }
        });

        console.log(`Extracted ${state.constraints.quality.size} quality/risk constraints with adaptive factors`);
    }

    /**
     * Find optimal solution using multi-objective genetic algorithm
     * @param {Object} options - Optimization options
     * @returns {Object} - Optimization results
     */
    function findOptimalSolution(options = {}) {
        console.log("Starting multi-objective optimization...");

        // Merge options with defaults
        const settings = { ...state.parameters, ...options };

        // Reset current solution
        state.currentSolution.clear();

        // Get critical and near-critical tasks to focus optimization
        const criticalTasks = getCriticalTasks();
        const nearCriticalTasks = getNearCriticalTasks();

        console.log(`Optimizing with focus on ${criticalTasks.size} critical tasks and ${nearCriticalTasks.size} near-critical tasks`);

        // Create initial population with improved seeding
        const population = generateInitialPopulation(
            settings.populationSize,
            criticalTasks,
            nearCriticalTasks
        );

        // Track best solution and convergence
        let bestSolution = null;
        let bestFitness = -Infinity;
        let bestResults = null;
        let generationsWithoutImprovement = 0;

        // Run genetic algorithm for specified generations or until convergence
        for (let generation = 0; generation < settings.maxGenerations; generation++) {
            // Evaluate fitness for each solution
            const evaluations = evaluatePopulation(population);

            // Find best solution in this generation
            const bestInGeneration = evaluations.reduce((best, current) => {
                return current.fitness > best.fitness ? current : best;
            }, { fitness: -Infinity });

            // Update best overall solution
            if (bestInGeneration.fitness > bestFitness) {
                bestFitness = bestInGeneration.fitness;
                bestSolution = new Map(bestInGeneration.solution);
                bestResults = { ...bestInGeneration.results };
                generationsWithoutImprovement = 0;

                console.log(`Generation ${generation + 1}: Found better solution with fitness ${bestFitness.toFixed(4)}`);
                console.log(`Duration reduction: ${bestResults.durationReduction.toFixed(2)} days, Cost: ${bestResults.cost.toFixed(2)}`);
            } else {
                generationsWithoutImprovement++;
            }

            // Early stopping if no improvement for several generations
            if (generationsWithoutImprovement >= 10) {
                console.log(`Stopping early after ${generation + 1} generations due to convergence`);
                break;
            }

            // Create next generation with improved selection and diversity preservation
            population.length = 0;

            // Elitism - directly copy best solutions
            for (let i = 0; i < settings.elitismCount && i < evaluations.length; i++) {
                population.push(new Map(evaluations[i].solution));
            }

            // Fill remaining population through selection, crossover, mutation
            while (population.length < settings.populationSize) {
                // Tournament selection with increased tournament size for late generations
                const dynamicTournamentSize = Math.min(
                    settings.tournamentSize + Math.floor(generation / 5),
                    Math.floor(evaluations.length / 4)
                );

                const parent1 = tournamentSelection(evaluations, dynamicTournamentSize);
                const parent2 = tournamentSelection(evaluations, dynamicTournamentSize);

                // Adaptive crossover and mutation rates
                const adaptiveCrossoverRate = settings.crossoverRate *
                    (1 - 0.5 * (generation / settings.maxGenerations));

                const adaptiveMutationRate = settings.mutationRate *
                    (1 + generation / settings.maxGenerations);

                // Crossover
                let child;
                if (Math.random() < adaptiveCrossoverRate) {
                    child = crossover(parent1, parent2, criticalTasks);
                } else {
                    // No crossover, just clone parent1
                    child = new Map(parent1);
                }

                // Mutation
                if (Math.random() < adaptiveMutationRate) {
                    mutate(child, settings.maxResourcesPerTask, generation, settings.maxGenerations);
                }

                // Add to next generation
                population.push(child);
            }
        }

        // Set current solution to best found
        state.currentSolution = bestSolution;

        // Calculate final metrics
        const finalResults = calculateResults(bestSolution);

        // Return results
        return {
            success: true,
            solution: bestSolution,
            fitness: bestFitness,
            durationReduction: finalResults.durationReduction,
            cost: finalResults.cost,
            resourceCount: Array.from(bestSolution.values()).reduce((a, b) => a + b, 0),
            endDate: finalResults.endDate,
            netBenefit: finalResults.netBenefit,
            optimizedNodes: finalResults.optimizedNodes,
            violatedConstraints: finalResults.violations
        };
    }

    /**
     * Get set of critical tasks IDs
     * @returns {Set} - Set of critical task IDs
     */
    function getCriticalTasks() {
        const criticalTasks = new Set();

        // Get critical paths from global state
        if (window.cybereumState?.criticalPathResult?.paths) {
            window.cybereumState.criticalPathResult.paths.forEach(path => {
                path.forEach(node => {
                    const nodeId = typeof node === 'object' ? node.ID : node;
                    criticalTasks.add(nodeId);
                });
            });
        } else {
            // Fallback to nodes with isCritical flag
            nodes.forEach(node => {
                if (node.isCritical || node.isOnCriticalPath) {
                    criticalTasks.add(node.ID);
                }
            });
        }

        return criticalTasks;
    }

    /**
     * Get set of near-critical tasks IDs
     * @returns {Set} - Set of near-critical task IDs
     */
    function getNearCriticalTasks() {
        const nearCriticalTasks = new Set();

        // Get near-critical paths from global state
        if (window.cybereumState?.outlierPathsResult?.paths) {
            window.cybereumState.outlierPathsResult.paths.forEach(path => {
                path.forEach(node => {
                    const nodeId = typeof node === 'object' ? node.ID : node;
                    nearCriticalTasks.add(nodeId);
                });
            });
        } else {
            // Fallback to nodes with isNearCritical flag
            nodes.forEach(node => {
                if (node.isNearCritical || node.isOnOutlierPath) {
                    nearCriticalTasks.add(node.ID);
                }
            });
        }

        // Remove critical tasks from near-critical set
        const criticalTasks = getCriticalTasks();
        criticalTasks.forEach(id => nearCriticalTasks.delete(id));

        return nearCriticalTasks;
    }


    /**
     * Generate initial population for genetic algorithm
     * @param {number} populationSize - Size of population
     * @param {Set} criticalTasks - Set of critical task IDs
     * @param {Set} nearCriticalTasks - Set of near-critical task IDs
     * @returns {Array} - Array of solution maps
     */
    function generateInitialPopulation(populationSize, criticalTasks, nearCriticalTasks) {
        const population = [];

        // Use Monte Carlo simulation to generate insights if available
        let monteCarloInsights = null;
        if (window.monteCarloSimulator && !monteCarloInsights) {
            // Check if we have recent Monte Carlo results
            if (window.monteCarloSimulator.state.simulationResults.length > 0) {
                monteCarloInsights = {
                    sensitivityAnalysis: window.monteCarloSimulator.state.sensitivityAnalysis,
                    resourceImpact: window.monteCarloSimulator.analyzeResourceImpact(),
                    pathVariability: window.monteCarloSimulator.analyzeCriticalPathVariability()
                };
            } else if (confirm("Would you like to run Monte Carlo simulation to improve optimization results?")) {
                // Run a quick Monte Carlo simulation
                window.monteCarloSimulator.runSimulation(1000).then(() => {
                    monteCarloInsights = {
                        sensitivityAnalysis: window.monteCarloSimulator.state.sensitivityAnalysis,
                        resourceImpact: window.monteCarloSimulator.analyzeResourceImpact(),
                        pathVariability: window.monteCarloSimulator.analyzeCriticalPathVariability()
                    };
                });
            }
        }

        // Helper to get optimizable tasks
        function getOptimizableTasks() {
            return nodes.filter(node => {
                return (node.PercentComplete || 0) < 100 && !node.isResourceConstrained;
            });
        }

        const optimizableTasks = getOptimizableTasks();
        const optimizableTaskIds = optimizableTasks.map(t => t.ID);

        // Get path information from the scheduler optimizer or cybereumState
        const pathInfo = {
            critical: [],
            outlier: []
        };

        // First try to get paths from scheduler
        if (window.scheduleOptimizer && window.scheduleOptimizer.state &&
            window.scheduleOptimizer.state.pathInfo) {
            pathInfo.critical = window.scheduleOptimizer.state.pathInfo.critical || [];
            pathInfo.outlier = window.scheduleOptimizer.state.pathInfo.outlier || [];
        }
        // If not in scheduler, try cybereumState
        else if (window.cybereumState) {
            // Extract critical paths
            if (window.cybereumState.criticalPathResult &&
                window.cybereumState.criticalPathResult.paths) {
                pathInfo.critical = window.cybereumState.criticalPathResult.paths.map((path, index) => {
                    return {
                        index: index + 1,
                        nodes: path.map(node => typeof node === 'object' ? node.ID : node)
                    };
                });
            }
            // Extract near-critical paths
            if (window.cybereumState.outlierPathsResult &&
                window.cybereumState.outlierPathsResult.paths) {
                pathInfo.outlier = window.cybereumState.outlierPathsResult.paths.map((path, index) => {
                    return {
                        index: index + 1,
                        nodes: path.map(node => typeof node === 'object' ? node.ID : node)
                    };
                });
            }
        }

        console.log("Path information for optimization:",
            `${pathInfo.critical.length} critical paths, ${pathInfo.outlier.length} near-critical paths`);

        // Calculate importance of critical paths based on Monte Carlo data
        let pathImportanceMap = new Map();
        if (monteCarloInsights && monteCarloInsights.pathVariability &&
            monteCarloInsights.pathVariability.pathFrequency) {
            // Normalize path frequencies to get importance weights
            monteCarloInsights.pathVariability.pathFrequency.forEach(path => {
                pathImportanceMap.set(path.index, path.frequency / 100);
            });
        } else {
            // If no Monte Carlo data, use equal weighting for all paths
            pathInfo.critical.forEach((path, i) => {
                pathImportanceMap.set(path.index || (i + 1), 1.0);
            });
            pathInfo.outlier.forEach((path, i) => {
                pathImportanceMap.set(path.index || (i + 1), 0.5); // Half weight for near-critical
            });
        }

        // Calculate task importance based on path membership and risk factors
        const taskImportanceMap = new Map();
        optimizableTasks.forEach(task => {
            const taskId = task.ID;

            // Base score starts with task's inherent importance and risk
            let importanceScore = task.ComputedImportanceScore || task.importanceScore || 0.5;
            let riskScore = task.ComputedRiskScore || task.riskScore || 0.5;
            let overrunProb = task.overrun_probability || riskScore; // Fallback if not available

            // Enhance importance if task is outlier
            if (task.isImportanceOutlier) importanceScore *= 1.5;
            if (task.isRiskOutlier) riskScore *= 1.5;

            // Critical path multiplier - higher if on multiple paths
            let pathMultiplier = 1.0;
            let pathCount = 0;

            // Check critical path membership
            if (task.isOnCriticalPath || criticalTasks.has(taskId)) {
                pathMultiplier = 2.0;
                pathCount++;

                // If we know which specific critical path(s) it's on, add their importance
                pathInfo.critical.forEach(path => {
                    if (path.nodes && path.nodes.includes(taskId)) {
                        const pathImportance = pathImportanceMap.get(path.index) || 1.0;
                        pathMultiplier += pathImportance;
                        pathCount++;
                    }
                });
            }

            // Check near-critical path membership
            if (task.isOnOutlierPath || nearCriticalTasks.has(taskId)) {
                if (pathMultiplier === 1.0) pathMultiplier = 1.5; // Only bump if not already critical

                // Add importance from near-critical paths
                pathInfo.outlier.forEach(path => {
                    if (path.nodes && path.nodes.includes(taskId)) {
                        const pathImportance = pathImportanceMap.get(path.index) || 0.5;
                        pathMultiplier += pathImportance * 0.5; // Half weight for near-critical
                        pathCount++;
                    }
                });
            }

            // Tasks on multiple paths get extra importance
            if (pathCount > 1) {
                pathMultiplier *= (1 + (pathCount - 1) * 0.2); // 20% extra per additional path
            }

            // Combined score using all factors
            const combinedScore = (
                (importanceScore * 0.3) +
                (riskScore * 0.3) +
                (overrunProb * 0.4)
            ) * pathMultiplier;

            taskImportanceMap.set(taskId, {
                combinedScore,
                importanceScore,
                riskScore,
                overrunProb,
                pathMultiplier,
                pathCount
            });
        });

        // Generate population with diverse strategies
        // 30% based on Monte Carlo insights if available
        const mcBasedCount = monteCarloInsights ? Math.floor(populationSize * 0.3) : 0;

        // Generate Monte Carlo based solutions
        for (let i = 0; i < mcBasedCount; i++) {
            const solution = new Map();

            // Use sensitivity analysis to prioritize tasks
            if (monteCarloInsights.sensitivityAnalysis) {
                const topSensitiveTasks = monteCarloInsights.sensitivityAnalysis
                    .filter(item => item.correlation > 0.3)
                    .slice(0, 10)
                    .map(item => item.taskId);

                topSensitiveTasks.forEach(taskId => {
                    if (Math.random() < 0.8) {  // 80% chance to include
                        solution.set(taskId, 1 + Math.floor(Math.random() * 3));
                    }
                });
            }

            // Add resource-constrained tasks identified by Monte Carlo
            if (monteCarloInsights.resourceImpact && monteCarloInsights.resourceImpact.resourceImpacts) {
                monteCarloInsights.resourceImpact.resourceImpacts
                    .filter(impact => impact.percentIncrease > 10)
                    .forEach(impact => {
                        if (Math.random() < 0.7) {  // 70% chance to include
                            solution.set(impact.taskId, 1 + Math.floor(Math.random() * 2));
                        }
                    });
            }

            // Add critical path tasks identified in Monte Carlo path variability
            if (monteCarloInsights.pathVariability && monteCarloInsights.pathVariability.dominantPath) {
                const dominantPath = monteCarloInsights.pathVariability.dominantPath;
                dominantPath.nodes.forEach(taskId => {
                    if (optimizableTaskIds.includes(taskId) && Math.random() < 0.9) { // 90% chance
                        // More resources for critical tasks, especially with high frequency
                        const frequency = dominantPath.frequency / 100;
                        const resourceCount = 1 + Math.floor(Math.random() * 2 * frequency);
                        solution.set(taskId, resourceCount);
                    }
                });
            }

            population.push(solution);
        }

        // Critical path focus - 25% of population
        const criticalPathCount = Math.floor((populationSize - mcBasedCount) * 0.25);
        for (let i = 0; i < criticalPathCount; i++) {
            const solution = new Map();

            // Sort tasks by combined importance score
            const criticalImportanceTasks = Array.from(taskImportanceMap.entries())
                .filter(([taskId, _]) => criticalTasks.has(taskId))
                .sort((a, b) => b[1].combinedScore - a[1].combinedScore);

            // Allocate resources proportionally to importance
            criticalImportanceTasks.forEach(([taskId, metrics]) => {
                if (!optimizableTaskIds.includes(taskId)) return;

                // More important tasks get higher probability of inclusion
                const inclusionProbability = 0.5 + (metrics.combinedScore * 0.5);
                if (Math.random() < inclusionProbability) {
                    // More important tasks get more resources
                    const resourceBase = metrics.combinedScore > 0.8 ? 2 : 1;
                    const resourceVariation = Math.floor(Math.random() * 3);
                    solution.set(taskId, resourceBase + resourceVariation);
                }
            });

            population.push(solution);
        }

        // Multi-path focus - 15% of population
        const multiPathCount = Math.floor((populationSize - mcBasedCount) * 0.15);
        for (let i = 0; i < multiPathCount; i++) {
            const solution = new Map();

            // Focus on tasks that appear in multiple paths
            const multiPathTasks = Array.from(taskImportanceMap.entries())
                .filter(([_, metrics]) => metrics.pathCount > 1)
                .sort((a, b) => b[1].pathCount - a[1].pathCount);

            if (multiPathTasks.length > 0) {
                multiPathTasks.forEach(([taskId, metrics]) => {
                    if (!optimizableTaskIds.includes(taskId)) return;

                    // Higher chance of adding resources to tasks on multiple paths
                    const inclusionProb = 0.6 + (metrics.pathCount * 0.1);
                    if (Math.random() < inclusionProb) {
                        // Resources proportional to path count
                        const resources = 1 + Math.min(Math.floor(metrics.pathCount / 2), 3);
                        solution.set(taskId, resources);
                    }
                });
            }

            population.push(solution);
        }

        // High risk focus - 15% of population
        const highRiskCount = Math.floor((populationSize - mcBasedCount) * 0.15);
        for (let i = 0; i < highRiskCount; i++) {
            const solution = new Map();

            // Focus on tasks with high risk scores, especially on critical paths
            const highRiskTasks = Array.from(taskImportanceMap.entries())
                .filter(([_, metrics]) => metrics.riskScore > 0.6 || metrics.overrunProb > 0.6)
                .sort((a, b) => {
                    // Sort by risk * path importance
                    return (b[1].riskScore * b[1].pathMultiplier) -
                        (a[1].riskScore * a[1].pathMultiplier);
                });

            highRiskTasks.slice(0, 10).forEach(([taskId, metrics]) => {
                if (!optimizableTaskIds.includes(taskId)) return;

                if (Math.random() < 0.8) {
                    // Resources inversely proportional to risk - higher risk needs more resources
                    const resources = 1 + Math.floor(metrics.riskScore * 4);
                    solution.set(taskId, resources);
                }
            });

            population.push(solution);
        }

        // Balanced approach - remainder of population
        const remainingCount = populationSize - population.length;
        for (let i = 0; i < remainingCount; i++) {
            const solution = new Map();

            // Get a mix of critical, near-critical, and high-risk tasks
            const targetTasks = new Set();

            // Add some critical tasks
            if (criticalTasks.size > 0) {
                const criticalTasksArray = Array.from(criticalTasks);
                const criticalCount = Math.min(3, criticalTasksArray.length);
                for (let j = 0; j < criticalCount; j++) {
                    const randomIndex = Math.floor(Math.random() * criticalTasksArray.length);
                    targetTasks.add(criticalTasksArray[randomIndex]);
                }
            }

            // Add some near-critical tasks
            if (nearCriticalTasks.size > 0) {
                const nearCriticalTasksArray = Array.from(nearCriticalTasks);
                const nearCriticalCount = Math.min(2, nearCriticalTasksArray.length);
                for (let j = 0; j < nearCriticalCount; j++) {
                    const randomIndex = Math.floor(Math.random() * nearCriticalTasksArray.length);
                    targetTasks.add(nearCriticalTasksArray[randomIndex]);
                }
            }

            // Add some high-risk tasks
            const highRiskTasks = optimizableTasks
                .filter(task => (task.ComputedRiskScore || task.riskScore || 0) > 0.7)
                .map(task => task.ID);

            if (highRiskTasks.length > 0) {
                const highRiskCount = Math.min(2, highRiskTasks.length);
                for (let j = 0; j < highRiskCount; j++) {
                    const randomIndex = Math.floor(Math.random() * highRiskTasks.length);
                    targetTasks.add(highRiskTasks[randomIndex]);
                }
            }

            // Add resources to selected tasks
            targetTasks.forEach(taskId => {
                if (!optimizableTaskIds.includes(taskId)) return;

                const metrics = taskImportanceMap.get(taskId) || { combinedScore: 0.5 };

                // Randomized resource allocation
                let resourceMin = 1;
                let resourceMax = 3;

                // Adjust based on task metrics
                if (metrics.combinedScore > 0.8) {
                    resourceMin = 2;
                    resourceMax = 4;
                } else if (metrics.combinedScore < 0.3) {
                    resourceMax = 2;
                }

                const resources = resourceMin + Math.floor(Math.random() * (resourceMax - resourceMin + 1));
                solution.set(taskId, resources);
            });

            population.push(solution);
        }

        return population;
    }

    /**
     * Evaluate population fitness
     * @param {Array} population - Array of solution maps
     * @returns {Array} - Array of evaluation objects
     */
    function evaluatePopulation(population) {
        return population.map(solution => {
            // Calculate results for this solution
            const results = calculateResults(solution);

            // Calculate overall fitness using weighted objectives
            const fitness = calculateFitness(results);

            return {
                solution,
                fitness,
                results
            };
        });
    }

    /**
     * Calculate results for a solution
     * @param {Map} solution - Solution map of task ID to resource additions
     * @returns {Object} - Result metrics
     */
    function calculateResults(solution) {
        // Apply candidate scenario
        scheduler.state.resourceChanges = solution;

        // Determine whether we must compute per-node dates (only needed for hard time constraints)
        const hasHardTimeConstraints =
            !!(state?.constraints?.time && (state.constraints.time instanceof Map ? state.constraints.time.size > 0 : state.constraints.time.length > 0));

        // Ensure we have a fast node lookup table (critical for large projects)
        if (!scheduler.state._nodeById || scheduler.state._nodeById.size === 0) {
            scheduler.state._nodeById = new Map(nodes.map(n => [String(n.ID), n]));
        }
        const nodeById = scheduler.state._nodeById;

        // Team calendar
        const teamCalendar = window.cybereumState?.teamCalendar || { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] };
        const hoursPerDay = Number(teamCalendar.hoursPerDay) || 8;

        // Baseline duration (days)
        const startDate = new Date(window.cybereumState?.startDate || window.cybereumState?.dataDate || new Date());
        const originalProjectDays = Number(window.cybereumState?.totalProjectDays) ||
            Math.max(0, Math.ceil((scheduler.state.originalEndDate - startDate) / (24 * 60 * 60 * 1000)));

        // Results container
        const results = {};

        let updatedNodes = null;

        if (hasHardTimeConstraints) {
            // Full recomputation for correctness when time constraints are configured
            updatedNodes = scheduler.recalculateProjectDates();
        } else {
            // Fast evaluation path (path-based) - avoids full CPM recomputation during GA iteration
            const optimizedCriticalPaths = scheduler.getOptimizedPathLengths('critical');
            const optimizedNearCriticalPaths = scheduler.getOptimizedPathLengths('outlier');

            const c0 = optimizedCriticalPaths && optimizedCriticalPaths.length ? optimizedCriticalPaths[0] : null;
            const o0 = optimizedNearCriticalPaths && optimizedNearCriticalPaths.length ? optimizedNearCriticalPaths[0] : null;

            let controllingPath = null;
            let controllingPathType = null;

            if (c0 && (!o0 || c0.duration >= o0.duration)) {
                controllingPath = c0;
                controllingPathType = 'critical';
            } else if (o0) {
                controllingPath = o0;
                controllingPathType = 'outlier';
            }

            scheduler.state.controllingPath = controllingPath;
            scheduler.state.controllingPathType = controllingPathType;
            scheduler.state.projectedEndDate = controllingPath?.endDate ? new Date(controllingPath.endDate) : new Date(scheduler.state.originalEndDate);
        }

        // Optimized duration (days) from controlling path computed above
        const optimizedDuration = Number(scheduler.state.controllingPath?.duration);
        const optimizedProjectDays = Number.isFinite(optimizedDuration) ? optimizedDuration : originalProjectDays;

        // Duration reduction in days
        const durationReduction = Math.max(0, originalProjectDays - optimizedProjectDays);

        // Cost impact
        let totalCost = 0;
        solution.forEach((resourceChange, nodeIdRaw) => {
            const resourceDelta = Number(resourceChange) || 0;
            if (resourceDelta <= 0) return;

            const nodeId = String(nodeIdRaw);
            const node = nodeById.get(nodeId);
            if (!node) return;

            const taskRate = Number(
                scheduler.state.taskRates?.get(nodeId) ||
                node.CostRate ||
                scheduler.state.resourceRate ||
                100
            );

            const durationDays = Math.max(0, Number(node.Duration) || 0);
            const durationSaving = Math.max(0, Number(scheduler.calculateScheduleImpact(nodeId, resourceDelta)) || 0);
            const updatedDurationDays = Math.max(0, durationDays - durationSaving);

            if (Number.isFinite(taskRate)) {
                totalCost += resourceDelta * taskRate * hoursPerDay * updatedDurationDays;
            }
        });

        // Completion savings (if configured)
        const dailySavings = Number(scheduler.state.dailySavings) || 0;
        const completionSavings = dailySavings * durationReduction;

        const netBenefit = completionSavings - totalCost;

        // Constraint penalties (robust to fast evaluation)
        let penalties = { time: 0, resource: 0, quality: 0, total: 0 };
        if (window.scheduleUtils?.calculateConstraintPenalties) {
            penalties = window.scheduleUtils.calculateConstraintPenalties(
                solution,
                updatedNodes, // may be null for fast evaluation
                state.constraints
            ) || penalties;
        }

        // Hard constraint violation report (only meaningful if node dates exist)
        const violations = hasHardTimeConstraints && updatedNodes
            ? checkConstraintViolations(solution, updatedNodes)
            : [];

        results.originalDuration = originalProjectDays;
        results.optimizedDuration = optimizedProjectDays;
        results.durationReduction = durationReduction;
        results.cost = totalCost;
        results.endDate = scheduler.state.projectedEndDate;
        results.completionSavings = completionSavings;
        results.netBenefit = netBenefit;
        results.penalties = penalties;
        results.violations = violations;
        results.optimizedNodes = updatedNodes; // may be null for fast GA evaluation

        return results;
    }


    /**
     * Calculate fitness from results using weighted objectives
     * @param {Object} results - Calculation results
     * @returns {number} - Overall fitness score
     */
    function calculateFitness(results) {
        const weights = state.objectiveWeights;

        // Duration objective
        const durationScore = (results.durationReduction / results.originalDuration) * 10;

        // Cost-benefit objective
        const costBenefitScore = results.netBenefit > 0 ?
            Math.min(10, results.netBenefit / results.cost) :
            results.netBenefit / (results.cost || 1);

        // Resource utilization objective
        const resourceUtilizationScore = Math.max(0, 10 - results.penalties.resource / 10);

        // Risk objective
        const riskScore = Math.max(0, 10 - results.penalties.quality / 5);

        // Combine weighted scores with penalty adjustment
        const fitness =
            weights.duration * durationScore +
            weights.cost * costBenefitScore +
            weights.resources * resourceUtilizationScore +
            weights.risk * riskScore -
            (results.penalties.time / 20); // Hard time constraints reduce fitness directly

        return fitness;
    }

    /**
     * Check for constraint violations in a solution
     * @param {Map} solution - Solution map
     * @param {Array} updatedNodes - Updated nodes after applying solution
     * @returns {Array} - Array of constraint violations
     */
    function checkConstraintViolations(solution, updatedNodes, prebuiltNodeMap) {
        const violations = [];

        if (!Array.isArray(updatedNodes) || updatedNodes.length === 0) {
            return violations;
        }

        // Create node map for quick lookup (or reuse)
        const nodeMap = prebuiltNodeMap instanceof Map ? prebuiltNodeMap : new Map();
        if (!(prebuiltNodeMap instanceof Map)) {
            updatedNodes.forEach(node => nodeMap.set(String(node.ID), node));
        }

        // Check time constraints
        state.constraints.time.forEach((constraint, key) => {
            if (!constraint.hard) return; // Only check hard constraints

            const taskId = String(constraint.taskId);
            const node = nodeMap.get(taskId);

            if (!node) return;

            // Validate task dates
            const startVal = node.Start;
            const finishVal = node.Finish;
            if (!startVal || !finishVal) return;

            if (constraint.type === 'finish') {
                const deadlineDate = new Date(constraint.deadline);
                const finishDate = new Date(finishVal);
                if (Number.isNaN(deadlineDate.getTime()) || Number.isNaN(finishDate.getTime())) return;

                if (finishDate > deadlineDate) {
                    const daysLate = Math.ceil((finishDate - deadlineDate) / (24 * 60 * 60 * 1000));
                    violations.push({
                        type: 'time',
                        constraint: key,
                        taskId,
                        severity: daysLate > 5 ? 'high' : 'medium',
                        message: `Task ${taskId} (${node.Name || 'Unnamed'}) finishes ${daysLate} days after deadline`
                    });
                }
            } else if (constraint.type === 'start') {
                const deadlineDate = new Date(constraint.deadline);
                const startDate = new Date(startVal);
                if (Number.isNaN(deadlineDate.getTime()) || Number.isNaN(startDate.getTime())) return;

                if (startDate > deadlineDate) {
                    const daysLate = Math.ceil((startDate - deadlineDate) / (24 * 60 * 60 * 1000));
                    violations.push({
                        type: 'time',
                        constraint: key,
                        taskId,
                        severity: daysLate > 5 ? 'high' : 'medium',
                        message: `Task ${taskId} (${node.Name || 'Unnamed'}) starts ${daysLate} days after deadline`
                    });
                }
            }
        });

        // Resource constraints
        state.constraints.resource.forEach((constraint, key) => {
            if (!constraint.hard) return;

            // Total resource limit
            if (constraint.type === 'total' && constraint.max) {
                const totalResources = Array.from(solution.values()).reduce((sum, v) => sum + (Number(v) || 0), 0);
                if (totalResources > constraint.max) {
                    violations.push({
                        type: 'resource',
                        constraint: key,
                        severity: 'high',
                        message: `Total additional resources (${totalResources}) exceeds maximum (${constraint.max})`
                    });
                }
            }

            // Task-specific resource limit
            if (constraint.type === 'task' && constraint.taskId && constraint.max) {
                const taskId = String(constraint.taskId);
                const taskResources = Number(solution.get(taskId)) || 0;
                if (taskResources > constraint.max) {
                    violations.push({
                        type: 'resource',
                        constraint: key,
                        taskId,
                        severity: 'high',
                        message: `Task ${taskId} has ${taskResources} additional resources, exceeding maximum (${constraint.max})`
                    });
                }
            }
        });

        // Quality constraints
        state.constraints.quality.forEach((constraint, key) => {
            if (!constraint.hard) return;

            if (constraint.type === 'minQuality' && constraint.minQuality) {
                const qualityScore = scheduler.calculateQualityScore(solution);
                if (qualityScore < constraint.minQuality) {
                    violations.push({
                        type: 'quality',
                        constraint: key,
                        severity: 'high',
                        message: `Quality score (${qualityScore.toFixed(1)}) below minimum required (${constraint.minQuality})`
                    });
                }
            }
        });

        return violations;
    }


    function calculateResourceUtilization(solution, updatedNodes) {
        // Get resource constraints 
        const resourceConstraints = new Map();

        // Get all resource types
        const resourceTypes = new Set();
        updatedNodes.forEach(node => {
            const resourceType = node.resourceType || 'default';
            resourceTypes.add(resourceType);
        });

        // Create default constraints for each resource type
        resourceTypes.forEach(type => {
            resourceConstraints.set(type, {
                available: 10, // Default
                type: 'resource',
                resourceType: type
            });
        });

        // Override with actual constraints if available
        if (window.constraintOptimizer && window.constraintOptimizer.state &&
            window.constraintOptimizer.state.constraints.resource) {
            window.constraintOptimizer.state.constraints.resource.forEach((constraint, key) => {
                resourceConstraints.set(key, constraint);
            });
        }

        // Get calendar with guaranteed complete structure
        const teamCalendar = window.scheduleUtils.getWorkCalendar();
        const startDate = window.cybereumState?.startDate ?
            new Date(window.cybereumState.startDate) : window.cybereumState.dataDate || new Date();

        // Create resource profiles with calendar-aware time bins
        const resourceProfiles = {};
        resourceTypes.forEach(type => {
            resourceProfiles[type] = [];
        });

        // For each task, calculate resource usage across working days
        updatedNodes.forEach(node => {
            if (!node.Start || !node.Finish) return;

            const nodeStart = new Date(node.Start);
            const nodeFinish = new Date(node.Finish);
            const resourceType = node.resourceType || 'default';

            if (!resourceProfiles[resourceType]) return;

            // Get original and additional resources
            const baseResources = node.resourcesRequired || 1;
            const additionalResources = solution.get(node.ID) || 0;
            const totalResources = baseResources + additionalResources;

            // Skip if task has no working days

            // Add usage to profile with exact dates
            let currentDate = new Date(nodeStart);
            while (currentDate <= nodeFinish) {
                // Only add for working days - use robust isWorkingDay function
                if (isWorkingDay(currentDate, teamCalendar)) {
                    const profile = resourceProfiles[resourceType];

                    // Find or create bin for this date
                    const dateStr = currentDate.toISOString().split('T')[0];
                    let bin = profile.find(b => b.date === dateStr);

                    if (!bin) {
                        bin = { date: dateStr, usage: 0, tasks: [] };
                        profile.push(bin);
                    }

                    bin.usage += totalResources;
                    bin.tasks.push({
                        id: node.ID,
                        name: node.Name || `Task ${node.ID}`,
                        resources: totalResources
                    });
                }

                // Move to next day
                currentDate.setDate(currentDate.getDate() + 1);
            }
        });

        // Find overallocations
        const overallocations = {};

        Object.entries(resourceProfiles).forEach(([resourceType, profile]) => {
            const constraint = resourceConstraints.get(resourceType);
            if (!constraint) return;

            const available = constraint.available;
            const overallocatedDays = profile.filter(day => day.usage > available);

            if (overallocatedDays.length > 0) {
                overallocations[resourceType] = overallocatedDays.map(day => ({
                    date: day.date,
                    available,
                    usage: day.usage,
                    excess: day.usage - available,
                    tasks: day.tasks
                }));
            }
        });

        return {
            resourceProfiles,
            overallocations
        };
    };

    /**
     * Tournament selection for genetic algorithm
     * @param {Array} evaluations - Array of evaluation objects
     * @param {number} tournamentSize - Number of individuals in tournament
     * @returns {Map} - Selected solution
     */
    function tournamentSelection(evaluations, tournamentSize) {
        let best = null;

        // Select random individuals and pick the best
        for (let i = 0; i < tournamentSize; i++) {
            const randomIndex = Math.floor(Math.random() * evaluations.length);
            const candidate = evaluations[randomIndex];

            if (!best || candidate.fitness > best.fitness) {
                best = candidate;
            }
        }

        return best.solution;
    }

    /**
     * Crossover two parent solutions to create a child solution
     * @param {Map} parent1 - First parent solution
     * @param {Map} parent2 - Second parent solution
     * @returns {Map} - Child solution
     */
    function crossover(parent1, parent2, criticalTasks) {
        const child = new Map();

        // Identify all tasks from both parents
        const allTasks = new Set([
            ...Array.from(parent1.keys()),
            ...Array.from(parent2.keys())
        ]);

        // Critical path protection - ensure critical tasks get special treatment
        allTasks.forEach(taskId => {
            const isCritical = criticalTasks.has(taskId);
            const parent1Has = parent1.has(taskId);
            const parent2Has = parent2.has(taskId);

            // For critical tasks, favor the better allocation
            if (isCritical && parent1Has && parent2Has) {
                // Take the larger allocation for critical tasks
                const p1Resources = parent1.get(taskId);
                const p2Resources = parent2.get(taskId);
                child.set(taskId, Math.max(p1Resources, p2Resources));
            }
            // For non-critical tasks or tasks in only one parent, use randomized selection
            else if (Math.random() < 0.5) {
                if (parent1Has) {
                    child.set(taskId, parent1.get(taskId));
                }
            } else {
                if (parent2Has) {
                    child.set(taskId, parent2.get(taskId));
                }
            }
        });

        return child;
    }

    /**
     * Mutate a solution by randomly changing resource allocations
     * @param {Map} solution - Solution to mutate
     * @param {number} maxResourcesPerTask - Maximum resources per task
     */
    function mutate(solution, maxResourcesPerTask, generation, maxGenerations) {
        const optimizableTasks = nodes
            .filter(node => (node.PercentComplete || 0) < 100 && !node.isResourceConstrained)
            .map(node => node.ID);

        // Calculate how "local" vs "global" our mutation should be based on generation
        // Early generations: more randomization for exploration
        // Later generations: more focused tweaking for exploitation
        const explorationFactor = 1 - (generation / maxGenerations);

        // Number of mutations decreases with generations to promote convergence
        const mutationCount = Math.max(
            1,
            Math.floor(3 * explorationFactor) + (Math.random() < 0.3 ? 1 : 0)
        );

        for (let i = 0; i < mutationCount; i++) {
            // Different mutation types with generation-adaptive probabilities
            const mutationType = Math.random();

            if (mutationType < 0.3 * explorationFactor) {
                // Add a new random task (more likely in early generations)
                if (optimizableTasks.length > 0) {
                    const randomTaskIndex = Math.floor(Math.random() * optimizableTasks.length);
                    const randomTaskId = optimizableTasks[randomTaskIndex];

                    if (!solution.has(randomTaskId)) {
                        solution.set(randomTaskId, 1 + Math.floor(Math.random() * (maxResourcesPerTask - 1)));
                    }
                }
            } else if (mutationType < 0.6 * explorationFactor) {
                // Remove a random task (more likely in early generations)
                const solutionTasks = Array.from(solution.keys());
                if (solutionTasks.length > 0) {
                    const randomTaskIndex = Math.floor(Math.random() * solutionTasks.length);
                    const randomTaskId = solutionTasks[randomTaskIndex];
                    solution.delete(randomTaskId);
                }
            } else {
                // Modify existing allocation (more focused in later generations)
                const solutionTasks = Array.from(solution.keys());
                if (solutionTasks.length > 0) {
                    // In later generations, focus more on critical tasks
                    let targetIndex;
                    if (generation > maxGenerations * 0.7 && Math.random() < 0.7) {
                        // Get critical tasks from solution
                        const criticalTaskIndices = solutionTasks
                            .map((id, idx) => ({ id, idx }))
                            .filter(item => window.cybereumState?.criticalTaskResult?.paths?.some(
                                path => path.some(node => node.ID === item.id)
                            ))
                            .map(item => item.idx);

                        if (criticalTaskIndices.length > 0) {
                            // Select a random critical task
                            targetIndex = criticalTaskIndices[
                                Math.floor(Math.random() * criticalTaskIndices.length)
                            ];
                        } else {
                            // Fallback to random task
                            targetIndex = Math.floor(Math.random() * solutionTasks.length);
                        }
                    } else {
                        // Random task selection
                        targetIndex = Math.floor(Math.random() * solutionTasks.length);
                    }

                    const targetId = solutionTasks[targetIndex];
                    const currentValue = solution.get(targetId);

                    // Adjustment tendency shifts with generations
                    const adjustmentTendency = Math.random();
                    if (adjustmentTendency < 0.4 * (1 - explorationFactor) && currentValue < maxResourcesPerTask) {
                        // Increase (more likely in later generations if beneficial)
                        solution.set(targetId, currentValue + 1);
                    } else if (adjustmentTendency < 0.8 && currentValue > 1) {
                        // Decrease
                        solution.set(targetId, currentValue - 1);
                    } else {
                        // Remove
                        solution.delete(targetId);
                    }
                }
            }
        }
    }

    /**
     * Apply the current solution to the schedule
     */
    function applySolution() {
        if (state.currentSolution.size === 0) {
            console.warn("No solution to apply");
            return false;
        }

        // Apply solution to scheduler
        scheduler.state.resourceChanges = new Map(state.currentSolution);

        // Apply changes to schedule
        const success = scheduler.applyOptimization();

        return success;
    }

    /**
     * Save current solution as a scenario
     * @param {string} name - Scenario name
     * @param {string} description - Scenario description
     * @returns {Object} - Saved scenario
     */
    function saveScenario(name, description = "") {
        // Calculate results for current solution
        const results = calculateResults(state.currentSolution);

        // Create scenario object
        const scenario = {
            id: Date.now(),
            name: name || `Scenario ${state.scenarios.length + 1}`,
            description: description,
            solution: Array.from(state.currentSolution.entries()),
            results: results,
            timestamp: new Date().toISOString()
        };

        // Add to scenarios
        state.scenarios.push(scenario);
        state.currentScenarioIndex = state.scenarios.length - 1;

        console.log(`Saved scenario: ${scenario.name}`);
        return scenario;
    }

    /**
     * Load a saved scenario
     * @param {number} index - Scenario index
     * @returns {boolean} - Success
     */
    function loadScenario(index) {
        if (index < 0 || index >= state.scenarios.length) {
            console.warn(`Invalid scenario index: ${index}`);
            return false;
        }

        const scenario = state.scenarios[index];

        // Load solution
        state.currentSolution = new Map(scenario.solution);

        // Apply to scheduler for visualization
        scheduler.state.resourceChanges = new Map(state.currentSolution);

        // Recalculate project dates
        scheduler.recalculateProjectDates();

        // Update current index
        state.currentScenarioIndex = index;

        console.log(`Loaded scenario: ${scenario.name}`);
        return true;
    }

    /**
     * Compare scenarios side by side
     * @param {number} index1 - First scenario index
     * @param {number} index2 - Second scenario index
     * @returns {Object} - Comparison results
     */
    function compareScenarios(index1, index2) {
        if (index1 < 0 || index1 >= state.scenarios.length ||
            index2 < 0 || index2 >= state.scenarios.length) {
            console.warn(`Invalid scenario indices: ${index1}, ${index2}`);
            return null;
        }

        const scenario1 = state.scenarios[index1];
        const scenario2 = state.scenarios[index2];

        // Calculate differences
        const durationDiff = scenario2.results.durationReduction - scenario1.results.durationReduction;
        const costDiff = scenario2.results.cost - scenario1.results.cost;
        const benefitDiff = scenario2.results.netBenefit - scenario1.results.netBenefit;

        // Calculate day difference
        const date1 = new Date(scenario1.results.endDate);
        const date2 = new Date(scenario2.results.endDate);
        const dayDiff = Math.round((date1 - date2) / (24 * 60 * 60 * 1000));

        return {
            scenario1: scenario1.name,
            scenario2: scenario2.name,
            durationDiff,
            costDiff,
            benefitDiff,
            dayDiff,
            betterDuration: durationDiff < 0 ? scenario1.name : scenario2.name,
            betterCost: costDiff > 0 ? scenario1.name : scenario2.name,
            betterBenefit: benefitDiff < 0 ? scenario1.name : scenario2.name,
            winner: benefitDiff < 0 ? scenario1.name : scenario2.name
        };
    }

    /**
     * Generate optimization recommendations based on current state
     * @returns {Array} - Array of recommendation objects
     */
    function generateRecommendations() {
        // Get critical and near-critical tasks
        const criticalTasks = getCriticalTasks();
        const nearCriticalTasks = getNearCriticalTasks();
        // Perform a more detailed analysis of the project
        const projectAnalysis = analyzeProjectCharacteristics();

        // Get high risk and high importance tasks
        const highRiskTasks = new Set();
        const highImportanceTasks = new Set();

        nodes.forEach(node => {
            if (node.isRiskOutlier ||
                (node.ComputedRiskScore && node.ComputedRiskScore > 0.7)) {
                highRiskTasks.add(node.ID);
            }

            if (node.isImportanceOutlier ||
                (node.ComputedImportanceScore && node.ComputedImportanceScore > 0.7)) {
                highImportanceTasks.add(node.ID);
            }
        });

        const recommendations = [];

        // Recommendation 1: Focus on critical path tasks
        recommendations.push({
            id: "critical-path",
            title: "Optimize Critical Path",
            description: "Allocate additional resources to critical path tasks to reduce project duration.",
            taskCount: criticalTasks.size,
            priority: "High",
            impact: "High",
            action: "optimizeCriticalPath"
        });

        // Recommendation 2: Focus on high-risk tasks
        const criticalRiskTasks = new Set(
            [...criticalTasks].filter(id => highRiskTasks.has(id))
        );

        if (criticalRiskTasks.size > 0) {
            recommendations.push({
                id: "critical-risk",
                title: "Mitigate Critical Path Risks",
                description: "Allocate additional resources to high-risk tasks on the critical path.",
                taskCount: criticalRiskTasks.size,
                priority: "High",
                impact: "High",
                action: "optimizeCriticalRiskTasks"
            });
        }

        // Recommendation 3: Focus on near-critical path
        if (nearCriticalTasks.size > 0) {
            recommendations.push({
                id: "near-critical",
                title: "Address Near-Critical Tasks",
                description: "Prevent near-critical paths from becoming critical by allocating resources.",
                taskCount: nearCriticalTasks.size,
                priority: "Medium",
                impact: "Medium",
                action: "optimizeNearCriticalPath"
            });
        }
        // Add recommendations based on project analysis
        if (projectAnalysis.hasTightDeadline) {
            recommendations.push({
                id: "deadline-focus",
                title: "Meet Tight Deadline",
                description: "Focus resources on critical path to meet the project deadline with minimal cost increase.",
                taskCount: projectAnalysis.criticalTaskCount,
                priority: "High",
                impact: "High",
                action: "optimizeForDeadline"
            });
        }

        if (projectAnalysis.hasResourceConstraints) {
            recommendations.push({
                id: "resource-leveling",
                title: "Resource Leveling",
                description: "Optimize resource allocation to reduce peaks and avoid resource conflicts.",
                taskCount: projectAnalysis.resourceConstrainedTaskCount,
                priority: "Medium",
                impact: "Medium",
                action: "optimizeForResourceLeveling"
            });
        }

        // Recommendation 4: Focus on high-importance tasks
        const criticalImportanceTasks = new Set(
            [...criticalTasks].filter(id => highImportanceTasks.has(id))
        );

        if (criticalImportanceTasks.size > 0) {
            recommendations.push({
                id: "critical-importance",
                title: "Prioritize High-Impact Tasks",
                description: "Allocate additional resources to high-importance tasks on the critical path.",
                taskCount: criticalImportanceTasks.size,
                priority: "Medium",
                impact: "High",
                action: "optimizeHighImportanceTasks"
            });
        }

        // Recommendation 5: Balanced optimization
        recommendations.push({
            id: "balanced",
            title: "Balanced Optimization",
            description: "Apply a balanced approach considering duration, cost, and resource utilization.",
            taskCount: criticalTasks.size + Math.floor(nearCriticalTasks.size / 2),
            priority: "Medium",
            impact: "Medium",
            action: "balancedOptimization"
        });

        return recommendations;
    }

    function analyzeProjectCharacteristics() {
        // Perform detailed project analysis
        const startDate = window.cybereumState?.startDate;
        const endDate = window.cybereumState?.endDate;
        const currentDate = window.cybereumState.dataDate || new Date();

        // Calculate project metrics
        const totalDuration = Math.ceil((endDate - startDate) / (24 * 60 * 60 * 1000));
        const remainingDuration = Math.ceil((endDate - currentDate) / (24 * 60 * 60 * 1000));
        const progressPercent = Math.max(0, 100 - (remainingDuration / totalDuration * 100));

        // Analyze critical path
        const criticalTasks = getCriticalTasks();
        const criticalTaskCount = criticalTasks.size;

        // Check for tight deadline
        const hasTightDeadline = remainingDuration < totalDuration * 0.3 && progressPercent < 70;

        // Check for resource constraints
        const resourceConstrainedTaskCount = nodes.filter(n => n.isResourceConstrained).length;
        const hasResourceConstraints = resourceConstrainedTaskCount > nodes.length * 0.1;

        // Return comprehensive analysis
        return {
            totalDuration,
            remainingDuration,
            progressPercent,
            criticalTaskCount,
            hasTightDeadline,
            hasResourceConstraints,
            resourceConstrainedTaskCount
        };
    }
    /**
     * Apply a specific recommendation
     * @param {string} recommendationId - Recommendation ID
     * @returns {Object} - Optimization results
     */
    function applyRecommendation(recommendationId) {
        // Get critical and near-critical tasks
        const criticalTasks = getCriticalTasks();
        const nearCriticalTasks = getNearCriticalTasks();

        // Get high risk and high importance tasks
        const highRiskTasks = new Set();
        const highImportanceTasks = new Set();

        nodes.forEach(node => {
            if (node.isRiskOutlier ||
                (node.ComputedRiskScore && node.ComputedRiskScore > 0.7)) {
                highRiskTasks.add(node.ID);
            }

            if (node.isImportanceOutlier ||
                (node.ComputedImportanceScore && node.ComputedImportanceScore > 0.7)) {
                highImportanceTasks.add(node.ID);
            }
        });

        // Default optimization options
        const options = {
            populationSize: state.parameters.populationSize,
            maxGenerations: state.parameters.maxGenerations
        };

        // Adjust objective weights based on recommendation
        switch (recommendationId) {
            case "critical-path":
                // Focus on critical path - prioritize duration reduction
                state.objectiveWeights = {
                    duration: 0.7,
                    cost: 0.2,
                    resources: 0.05,
                    risk: 0.05
                };
                break;

            case "critical-risk":
                // Focus on critical risk tasks - balance duration and risk
                state.objectiveWeights = {
                    duration: 0.5,
                    cost: 0.2,
                    resources: 0.1,
                    risk: 0.2
                };
                break;

            case "near-critical":
                // Focus on near-critical path - balance objectives
                state.objectiveWeights = {
                    duration: 0.4,
                    cost: 0.3,
                    resources: 0.2,
                    risk: 0.1
                };
                break;

            case "critical-importance":
                // Focus on high-importance tasks - prioritize impact
                state.objectiveWeights = {
                    duration: 0.5,
                    cost: 0.3,
                    resources: 0.1,
                    risk: 0.1
                };
                break;

            case "balanced":
                // Balanced approach
                state.objectiveWeights = {
                    duration: 0.4,
                    cost: 0.3,
                    resources: 0.2,
                    risk: 0.1
                };
                break;

            default:
                console.warn(`Unknown recommendation ID: ${recommendationId}`);
                break;
        }

        // Run optimization
        const results = findOptimalSolution(options);

        // Return results
        return results;
    }

    /**
     * Render the optimization interface
     * @param {string} containerId - ID of container element
     */
    function renderInterface(containerId) {
        // Store container reference
        state.container = document.getElementById(containerId);

        if (!state.container) {
            console.error(`Container element not found: ${containerId}`);
            return;
        }

        // Create interface HTML
        const html = `
            <div class="cybereum-optimizer">
                <style>
                    .cybereum-optimizer {
                        font-family: var(--font-rajdhani, 'Rajdhani', sans-serif);
                        background: var(--bg-darker, #091625);
                        color: var(--text, #cdfaff);
                        padding: 0; /* Remove padding from container */
                        border-radius: 8px;
                        border: 1px solid var(--primary, #5ac8fa);
                        display: flex;
                        flex-direction: column;
                        height: 700px; /* Fixed height instead of percentage */
                        overflow: hidden; /* Important: main container should not scroll */
                        position: relative; /* For absolute positioning children if needed */
                    }

                    /* Header area with fixed height */
                    .cybereum-optimizer-header {
                        padding: 20px;
                        border-bottom: 1px solid var(--primary, #5ac8fa);
                        flex-shrink: 0; /* Prevent header from shrinking */
                    }

                    
                    .cybereum-optimizer h2 {
                        color: var(--bright, #8ce6ff);
                        border-bottom: 1px solid var(--primary, #5ac8fa);
                        padding-bottom: 10px;
                        margin-top: 0;
                    }
                    
                    .cybereum-optimizer .panel {
                        background: rgba(14, 36, 70, 0.3);
                        border: 1px solid var(--primary, #5ac8fa);
                        border-radius: 6px;
                        padding: 15px;
                        margin-bottom: 20px;
                    }
                    
                    .cybereum-optimizer .panel-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 15px;
                        border-bottom: 1px solid rgba(90, 200, 250, 0.3);
                        padding-bottom: 10px;
                    }
                    
                    .cybereum-optimizer .panel-title {
                        font-size: 1.2em;
                        font-weight: bold;
                        color: var(--bright, #8ce6ff);
                    }
                    
                    .cybereum-optimizer .constraint-list {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                        gap: 10px;
                        margin-bottom: 15px;
                    }
                    
                    .cybereum-optimizer .constraint-item {
                        background: rgba(14, 36, 70, 0.5);
                        border: 1px solid rgba(90, 200, 250, 0.3);
                        border-radius: 4px;
                        padding: 10px;
                    }
                    
                    .cybereum-optimizer .constraint-type {
                        font-weight: bold;
                        color: var(--bright, #8ce6ff);
                        margin-bottom: 5px;
                    }
                    
                    .cybereum-optimizer .constraint-info {
                        font-size: 0.9em;
                    }
                    
                    .cybereum-optimizer .hard-constraint {
                        border-left: 3px solid var(--cyb-danger, #ff5555);
                    }
                    
                    .cybereum-optimizer .soft-constraint {
                        border-left: 3px solid var(--cyb-success, #50fa7b);
                    }
                    
                    .cybereum-optimizer .button-group {
                        display: flex;
                        gap: 10px;
                        flex-wrap: wrap;
                        margin: 15px 0;
                    }
                    
                    .cybereum-optimizer .btn {
                        background-color: rgba(14, 36, 70, 0.8);
                        border: 1px solid var(--primary, #5ac8fa);
                        color: var(--text, #cdfaff);
                        padding: 10px 15px;
                        border-radius: 4px;
                        cursor: pointer;
                        transition: all 0.2s;
                    }
                    
                    .cybereum-optimizer .btn:hover {
                        background-color: var(--primary, #5ac8fa);
                        color: var(--bg-darker, #091625);
                    }
                    
                    .cybereum-optimizer .btn-primary {
                        background-color: rgba(60, 120, 180, 0.8);
                        border-color: var(--cyb-info, #8be9fd);
                    }
                    
                    .cybereum-optimizer .btn-primary:hover {
                        background-color: var(--cyb-info, #8be9fd);
                    }
                    
                    .cybereum-optimizer .recommendations {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                        gap: 15px;
                        margin: 15px 0;
                    }
                    
                    .cybereum-optimizer .recommendation {
                        background: rgba(14, 36, 70, 0.5);
                        border: 1px solid rgba(90, 200, 250, 0.3);
                        border-radius: 6px;
                        padding: 15px;
                        transition: all 0.2s;
                    }
                    
                    .cybereum-optimizer .recommendation:hover {
                        border-color: var(--primary, #5ac8fa);
                        box-shadow: 0 0 10px rgba(90, 200, 250, 0.3);
                    }
                    
                    .cybereum-optimizer .recommendation-title {
                        font-weight: bold;
                        color: var(--bright, #8ce6ff);
                        margin-bottom: 10px;
                    }
                    
                    .cybereum-optimizer .recommendation-desc {
                        font-size: 0.9em;
                        margin-bottom: 10px;
                    }
                    
                    .cybereum-optimizer .recommendation-meta {
                        display: flex;
                        justify-content: space-between;
                        font-size: 0.8em;
                        color: rgba(205, 250, 255, 0.7);
                    }
                    
                    .cybereum-optimizer .high-priority {
                        color: var(--cyb-danger, #ff5555);
                    }
                    
                    .cybereum-optimizer .medium-priority {
                        color: var(--cyb-warning, #ffb86c);
                    }
                    
                    .cybereum-optimizer .high-impact {
                        color: var(--cyb-success, #50fa7b);
                    }
                    
                    .cybereum-optimizer .settings-form {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                        gap: 15px;
                        margin: 15px 0;
                    }
                    
                    .cybereum-optimizer .form-group {
                        display: flex;
                        flex-direction: column;
                        gap: 5px;
                    }
                    
                    .cybereum-optimizer label {
                        font-size: 0.9em;
                    }
                    
                    .cybereum-optimizer input {
                        background-color: rgba(14, 36, 70, 0.8);
                        border: 1px solid var(--primary, #5ac8fa);
                        color: var(--text, #cdfaff);
                        padding: 8px;
                        border-radius: 4px;
                    }
                    
                    .cybereum-optimizer input:focus {
                        outline: none;
                        border-color: var(--cyb-info, #8be9fd);
                    }
                    
                    .cybereum-optimizer .results {
                        margin-top: 20px;
                    }
                    
                    .cybereum-optimizer .result-summary {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                        gap: 15px;
                        margin: 15px 0;
                    }
                    
                    .cybereum-optimizer .result-item {
                        background: rgba(14, 36, 70, 0.5);
                        border: 1px solid rgba(90, 200, 250, 0.3);
                        border-radius: 6px;
                        padding: 15px;
                        text-align: center;
                    }
                    
                    .cybereum-optimizer .result-label {
                        font-size: 0.9em;
                        color: rgba(205, 250, 255, 0.7);
                        margin-bottom: 5px;
                    }
                    
                    .cybereum-optimizer .result-value {
                        font-size: 1.2em;
                        font-weight: bold;
                    }
                    
                    .cybereum-optimizer .positive-value {
                        color: var(--cyb-success, #50fa7b);
                    }
                    
                    .cybereum-optimizer .negative-value {
                        color: var(--cyb-danger, #ff5555);
                    }
                    
                    .cybereum-optimizer .scenarios {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                        gap: 15px;
                        margin: 15px 0;
                    }
                    
                    .cybereum-optimizer .scenario-card {
                        background: rgba(14, 36, 70, 0.5);
                        border: 1px solid rgba(90, 200, 250, 0.3);
                        border-radius: 6px;
                        padding: 15px;
                        cursor: pointer;
                        transition: all 0.2s;
                    }
                    
                    .cybereum-optimizer .scenario-card:hover,
                    .cybereum-optimizer .scenario-card.active {
                        border-color: var(--primary, #5ac8fa);
                        box-shadow: 0 0 10px rgba(90, 200, 250, 0.3);
                    }
                    
                    .cybereum-optimizer .scenario-card.active {
                        background: rgba(60, 120, 180, 0.2);
                    }
                    
                    .cybereum-optimizer .scenario-name {
                        font-weight: bold;
                        color: var(--bright, #8ce6ff);
                        margin-bottom: 5px;
                    }
                    
                    .cybereum-optimizer .scenario-desc {
                        font-size: 0.9em;
                        margin-bottom: 10px;
                        color: rgba(205, 250, 255, 0.7);
                    }
                    
                    .cybereum-optimizer .scenario-meta {
                        font-size: 0.8em;
                        color: rgba(205, 250, 255, 0.5);
                    }
                    
                    /* Tab navigation */
                    .cybereum-optimizer .tabs {
                        display: flex;
                        border-bottom: 1px solid rgba(90, 200, 250, 0.3);
                        padding: 0 20px;
                        flex-shrink: 0; /* Prevent tab nav from shrinking */
                        background: var(--bg-darker, #091625);
                        z-index: 10;
                    }

                    /* Tab content area that will scroll independently */
                    .cybereum-optimizer .tab-content-container {
                        flex-grow: 1; /* Take remaining space */
                        overflow: hidden; /* Important: container itself doesn't scroll */
                        position: relative;
                        display: flex; /* Add display flex to help with child positioning */
                    }
                    
                    .cybereum-optimizer .tab {
                        padding: 10px 15px;
                        cursor: pointer;
                        border-bottom: 2px solid transparent;
                        transition: all 0.2s;
                        white-space: nowrap;
                    }
                    
                    .cybereum-optimizer .tab:hover {
                        color: var(--bright, #8ce6ff);
                    }
                    
                    .cybereum-optimizer .tab.active {
                        color: var(--bright, #8ce6ff);
                        border-bottom-color: var(--primary, #5ac8fa);
                    }
                    
                   /* Individual tab content that will scroll */
                    .cybereum-optimizer .tab-content {
                        position: relative; /* Change from absolute to relative */
                        padding: 20px;
                        overflow-y: auto; /* This is where scrolling happens */
                        display: none;
                        height: 100%; /* Add explicit height */
                        flex: 1; /* Take up available space */
                        width: 100%; /* Ensure full width */
                    }
                    
                            .cybereum-optimizer .tab-content.active {
                                display: block;
                            }
                                        /* Panel styles adjusted to work with scrolling */
                    .cybereum-optimizer .panel {
                        background: rgba(14, 36, 70, 0.3);
                        border: 1px solid var(--primary, #5ac8fa);
                        border-radius: 6px;
                        padding: 15px;
                        margin-bottom: 20px;
                        overflow: visible; /* Allow content to flow naturally */
                    }

                    /* Prevent panel overflow issues */
                    .cybereum-optimizer .panel-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;

                    }
                    @keyframes fadeIn {
                        from { opacity: 0; }
                        to { opacity: 1; }
                    }
                </style>
                
                <h2>Cybereum Constraint-Based Schedule Optimizer</h2>
                
                <div class="tabs">
                    <div class="tab active" data-tab="recommendations">Recommendations</div>
                    <div class="tab" data-tab="constraints">Constraints</div>
                    <div class="tab" data-tab="optimization">Optimization Settings</div>
                    <div class="tab" data-tab="scenarios">Scenarios</div>
                    <div class="tab" data-tab="results" style="display: none;">Results</div>
                </div>
                
                <div class="tab-content active" id="recommendationsTab">
                    <div class="panel">
                        <div class="panel-header">
                            <div class="panel-title">Schedule Optimization Recommendations</div>
                            <button class="btn btn-primary" id="refreshRecommendations">Refresh</button>
                        </div>
                        
                        <div class="recommendations" id="recommendationsList">
                            <!-- Recommendations will be populated here -->
                        </div>
                    </div>
                </div>
                
                <div class="tab-content" id="constraintsTab">
                    <div class="panel">
                        <div class="panel-header">
                            <div class="panel-title">Project Constraints</div>
                            <button class="btn" id="extractConstraints">Extract Constraints</button>
                        </div>
                        
                        <div id="constraintsSummary">
                            <!-- Constraints summary will be shown here -->
                        </div>
                        
                        <div class="constraint-list" id="sequenceConstraints">
                            <!-- Sequence constraints will be listed here -->
                        </div>
                        
                        <div class="constraint-list" id="resourceConstraints">
                            <!-- Resource constraints will be listed here -->
                        </div>
                        
                        <div class="constraint-list" id="timeConstraints">
                            <!-- Time constraints will be listed here -->
                        </div>
                        
                        <div class="constraint-list" id="qualityConstraints">
                            <!-- Quality constraints will be listed here -->
                        </div>
                    </div>
                </div>
                
                <div class="tab-content" id="optimizationTab">
                    <div class="panel">
                        <div class="panel-header">
                            <div class="panel-title">Optimization Settings</div>
                        </div>
                        
                        <div class="settings-form">
                            <div class="form-group">
                                <label for="populationSize">Population Size</label>
                                <input type="number" id="populationSize" value="${state.parameters.populationSize}" min="10" max="200">
                            </div>
                            
                            <div class="form-group">
                                <label for="maxGenerations">Max Generations</label>
                                <input type="number" id="maxGenerations" value="${state.parameters.maxGenerations}" min="5" max="100">
                            </div>
                            
                            <div class="form-group">
                                <label for="mutationRate">Mutation Rate</label>
                                <input type="number" id="mutationRate" value="${state.parameters.mutationRate}" min="0.01" max="0.5" step="0.01">
                            </div>
                            
                            <div class="form-group">
                                <label for="crossoverRate">Crossover Rate</label>
                                <input type="number" id="crossoverRate" value="${state.parameters.crossoverRate}" min="0.1" max="0.9" step="0.01">
                            </div>
                            
                            <div class="form-group">
                                <label for="maxResourcesPerTask">Max Resources Per Task</label>
                                <input type="number" id="maxResourcesPerTask" value="${state.parameters.maxResourcesPerTask}" min="1" max="10">
                            </div>
                        </div>
                        
                        <div class="panel-header">
                            <div class="panel-title">Objective Weights</div>
                        </div>
                        
                        <div class="settings-form">
                            <div class="form-group">
                                <label for="durationWeight">Duration Weight</label>
                                <input type="number" id="durationWeight" value="${state.objectiveWeights.duration}" min="0" max="1" step="0.1">
                            </div>
                            
                            <div class="form-group">
                                <label for="costWeight">Cost Weight</label>
                                <input type="number" id="costWeight" value="${state.objectiveWeights.cost}" min="0" max="1" step="0.1">
                            </div>
                            
                            <div class="form-group">
                                <label for="resourcesWeight">Resources Weight</label>
                                <input type="number" id="resourcesWeight" value="${state.objectiveWeights.resources}" min="0" max="1" step="0.1">
                            </div>
                            
                            <div class="form-group">
                                <label for="riskWeight">Risk Weight</label>
                                <input type="number" id="riskWeight" value="${state.objectiveWeights.risk}" min="0" max="1" step="0.1">
                            </div>
                        </div>
                        
                        <div class="button-group">
                            <button class="btn btn-primary" id="runOptimization">Run Optimization</button>
                            <button class="btn" id="resetSettings">Reset Settings</button>
                        </div>
                    </div>
                </div>
                
                <div class="tab-content" id="scenariosTab">
                    <div class="panel">
                        <div class="panel-header">
                            <div class="panel-title">Saved Scenarios</div>
                            <div class="button-group">
                                <button class="btn" id="saveScenario">Save Current</button>
                                <button class="btn" id="compareScenarios">Compare Selected</button>
                            </div>
                        </div>
                        
                        <div class="scenarios" id="scenariosList">
                            <!-- Scenarios will be populated here -->
                        </div>
                    </div>
                </div>
                
                <div class="tab-content" id="resultsTab">
                    <div class="panel">
                        <div class="panel-header">
                            <div class="panel-title">Optimization Results</div>
                            <div class="button-group">
                                <button class="btn" id="saveResultsScenario">Save as Scenario</button>
                                <button class="btn btn-primary" id="applyResults">Apply to Schedule</button>
                            </div>
                        </div>
                        
                        <div class="result-summary" id="resultsSummary">
                            <!-- Results summary will be populated here -->
                        </div>
                        
                        <div id="violationsList">
                            <!-- Constraint violations will be shown here -->
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Set content
        state.container.innerHTML = html;

        // Attach event handlers
        attachEventHandlers();

        // Extract constraints
        extractConstraints();

        // Generate recommendations
        refreshRecommendations();

        // Show constraints summary
        updateConstraintsSummary();
    }

    /**
     * Attach event handlers to UI elements
     */
    function attachEventHandlers() {
        // Tab switching
        document.querySelectorAll('.cybereum-optimizer .tab').forEach(tab => {
            tab.addEventListener('click', () => {
                // Update active tab
                document.querySelectorAll('.cybereum-optimizer .tab').forEach(t => {
                    t.classList.remove('active');
                });
                tab.classList.add('active');

                // Show corresponding content
                const tabId = tab.getAttribute('data-tab');
                document.querySelectorAll('.cybereum-optimizer .tab-content').forEach(content => {
                    content.classList.remove('active');
                });
                document.getElementById(`${tabId}Tab`).classList.add('active');
            });
        });

        // Extract constraints button
        const extractConstraintsButton = document.getElementById('extractConstraints');
        if (extractConstraintsButton) {
            extractConstraintsButton.addEventListener('click', () => {
                extractConstraints();
                updateConstraintsSummary();
            });
        }

        // Refresh recommendations button
        const refreshRecommendationsButton = document.getElementById('refreshRecommendations');
        if (refreshRecommendationsButton) {
            refreshRecommendationsButton.addEventListener('click', refreshRecommendations);
        }

        // Run optimization button
        const runOptimizationButton = document.getElementById('runOptimization');
        if (runOptimizationButton) {
            runOptimizationButton.addEventListener('click', () => {
                // Update parameters from input fields
                updateParametersFromInputs();

                // Run optimization
                const results = findOptimalSolution();

                // Show results tab
                showResults(results);
            });
        }

        // Reset settings button
        const resetSettingsButton = document.getElementById('resetSettings');
        if (resetSettingsButton) {
            resetSettingsButton.addEventListener('click', resetSettings);
        }

        // Save scenario button
        const saveScenarioButton = document.getElementById('saveScenario');
        if (saveScenarioButton) {
            saveScenarioButton.addEventListener('click', () => {
                // Prompt for scenario name
                const name = prompt('Enter scenario name:', `Scenario ${state.scenarios.length + 1}`);
                if (!name) return;

                // Prompt for description
                const description = prompt('Enter scenario description (optional):');

                // Save scenario
                const scenario = saveScenario(name, description);

                // Update scenarios list
                updateScenariosList();
            });
        }

        // Compare scenarios button
        const compareButton = document.getElementById('compareScenarios');
        if (compareButton) {
            compareButton.addEventListener('click', () => {
                // Find selected scenarios
                const selected = document.querySelectorAll('.scenario-card.active');
                if (selected.length !== 2) {
                    alert('Please select exactly two scenarios to compare.');
                    return;
                }

                // Get scenario indices
                const index1 = parseInt(selected[0].getAttribute('data-index'));
                const index2 = parseInt(selected[1].getAttribute('data-index'));

                // Compare scenarios
                const comparison = compareScenarios(index1, index2);

                // Show comparison in alert (would be better in a modal)
                if (comparison) {
                    alert(`Comparison: ${comparison.scenario1} vs ${comparison.scenario2}\n\n` +
                        `Duration difference: ${comparison.durationDiff.toFixed(1)} days\n` +
                        `Cost difference: ${comparison.costDiff.toLocaleString()} ${scheduler.state.currency}\n` +
                        `Benefit difference: ${comparison.benefitDiff.toLocaleString()} ${scheduler.state.currency}\n` +
                        `End date difference: ${comparison.dayDiff} days\n\n` +
                        `Better for duration: ${comparison.betterDuration}\n` +
                        `Better for cost: ${comparison.betterCost}\n` +
                        `Better for benefit: ${comparison.betterBenefit}\n\n` +
                        `Overall winner: ${comparison.winner}`);
                }
            });
        }

        // Save results as scenario button
        const saveResultsButton = document.getElementById('saveResultsScenario');
        if (saveResultsButton) {
            saveResultsButton.addEventListener('click', () => {
                // Prompt for scenario name
                const name = prompt('Enter scenario name:', `Optimization ${state.scenarios.length + 1}`);
                if (!name) return;

                // Save scenario
                const scenario = saveScenario(name, 'Created from optimization results');

                // Update scenarios list
                updateScenariosList();

                // Show confirmation
                alert(`Scenario "${name}" saved successfully.`);
            });
        }

        // Apply results button
        const applyResultsButton = document.getElementById('applyResults');
        if (applyResultsButton) {
            applyResultsButton.addEventListener('click', () => {
                // Apply solution
                const success = applySolution();

                // Show confirmation
                if (success) {
                    alert('Optimization changes applied to schedule successfully.');
                } else {
                    alert('Failed to apply optimization changes.');
                }
            });
        }
    }

    /**
     * Refresh recommendations list
     */
    function refreshRecommendations() {
        const recommendationsList = document.getElementById('recommendationsList');
        if (!recommendationsList) return;

        // Generate recommendations
        const recommendations = generateRecommendations();

        // Build HTML
        let html = '';
        recommendations.forEach(rec => {
            html += `
                <div class="recommendation" data-id="${rec.id}">
                    <div class="recommendation-title">${rec.title}</div>
                    <div class="recommendation-desc">${rec.description}</div>
                    <div class="recommendation-meta">
                        <span>Tasks: ${rec.taskCount}</span>
                        <span class="${rec.priority.toLowerCase()}-priority">Priority: ${rec.priority}</span>
                        <span class="${rec.impact.toLowerCase()}-impact">Impact: ${rec.impact}</span>
                    </div>
                    <div class="button-group" style="margin-top: 10px;">
                        <button class="btn apply-recommendation" data-id="${rec.id}">Apply</button>
                    </div>
                </div>
            `;
        });

        // Set content
        recommendationsList.innerHTML = html;

        // Attach event handlers
        document.querySelectorAll('.apply-recommendation').forEach(button => {
            button.addEventListener('click', (e) => {
                const recId = e.target.getAttribute('data-id');

                // Apply recommendation
                const results = applyRecommendation(recId);

                // Show results tab
                showResults(results);
            });
        });
    }

    /**
     * Update constraints summary
     */
    function updateConstraintsSummary() {
        const summaryElement = document.getElementById('constraintsSummary');
        if (!summaryElement) return;

        // Get constraint counts
        const sequenceCount = state.constraints.sequence.size;
        const resourceCount = state.constraints.resource.size;
        const timeCount = state.constraints.time.size;
        const qualityCount = state.constraints.quality.size;

        // Build summary HTML
        const html = `
            <div style="margin-bottom: 15px; padding: 10px; background: rgba(14, 36, 70, 0.5); border-radius: 4px;">
                <strong>Constraints Summary:</strong> 
                ${sequenceCount} sequence constraints, 
                ${resourceCount} resource constraints, 
                ${timeCount} time constraints, 
                ${qualityCount} quality/risk constraints.
            </div>
        `;

        // Set content
        summaryElement.innerHTML = html;

        // Update constraint lists
        updateConstraintList('sequence', 'sequenceConstraints');
        updateConstraintList('resource', 'resourceConstraints');
        updateConstraintList('time', 'timeConstraints');
        updateConstraintList('quality', 'qualityConstraints');
    }

    /**
     * Update a specific constraint list
     * @param {string} constraintType - Type of constraints
     * @param {string} elementId - Element ID for the list
     */
    function updateConstraintList(constraintType, elementId) {
        const element = document.getElementById(elementId);
        if (!element) return;

        const constraints = state.constraints[constraintType];
        if (!constraints || constraints.size === 0) {
            element.innerHTML = `<div style="grid-column: 1 / -1; padding: 10px;">No ${constraintType} constraints found.</div>`;
            return;
        }

        // Build HTML
        let html = '';
        constraints.forEach((constraint, key) => {
            const hardClass = constraint.hard ? 'hard-constraint' : 'soft-constraint';

            let infoHtml = '';
            switch (constraintType) {
                case 'sequence':
                    infoHtml = `
                        <div>Type: ${constraint.type}</div>
                        <div>From: ${constraint.source}</div>
                        <div>To: ${constraint.target}</div>
                        <div>Lag: ${constraint.lagHrs} hours</div>
                    `;
                    break;

                case 'resource':
                    infoHtml = `
                        <div>Type: ${constraint.resourceType}</div>
                        <div>Available: ${constraint.available} units</div>
                        <div>Tasks: ${constraint.taskCount}</div>
                        <div>Max Concurrent: ${constraint.maxConcurrent}</div>
                    `;
                    break;

                case 'time':
                    infoHtml = `
                        <div>Type: ${constraint.type}</div>
                        <div>Task: ${constraint.taskId || 'Project'}</div>
                        <div>Date: ${constraint.date.toLocaleDateString()}</div>
                        <div>Slack: ${constraint.slack} hours</div>
                    `;
                    break;

                case 'quality':
                    infoHtml = `
                        <div>Type: ${constraint.type}</div>
                        <div>Task: ${constraint.taskId}</div>
                        <div>Score: ${constraint.riskScore || constraint.importanceScore}</div>
                        <div>Outlier: ${constraint.isOutlier ? 'Yes' : 'No'}</div>
                    `;
                    break;
            }

            html += `
                <div class="constraint-item ${hardClass}">
                    <div class="constraint-type">${key}</div>
                    <div class="constraint-info">
                        ${infoHtml}
                        <div>Constraint: ${constraint.hard ? 'Hard' : 'Soft'}</div>
                    </div>
                </div>
            `;
        });

        // Set content
        element.innerHTML = html;
    }

    /**
     * Update parameters from input fields
     */
    function updateParametersFromInputs() {
        // Update optimization parameters
        const populationSize = document.getElementById('populationSize');
        if (populationSize) {
            state.parameters.populationSize = parseInt(populationSize.value) || 50;
        }

        const maxGenerations = document.getElementById('maxGenerations');
        if (maxGenerations) {
            state.parameters.maxGenerations = parseInt(maxGenerations.value) || 30;
        }

        const mutationRate = document.getElementById('mutationRate');
        if (mutationRate) {
            state.parameters.mutationRate = parseFloat(mutationRate.value) || 0.2;
        }

        const crossoverRate = document.getElementById('crossoverRate');
        if (crossoverRate) {
            state.parameters.crossoverRate = parseFloat(crossoverRate.value) || 0.7;
        }

        const maxResourcesPerTask = document.getElementById('maxResourcesPerTask');
        if (maxResourcesPerTask) {
            state.parameters.maxResourcesPerTask = parseInt(maxResourcesPerTask.value) || 5;
        }

        // Update objective weights
        const durationWeight = document.getElementById('durationWeight');
        if (durationWeight) {
            state.objectiveWeights.duration = parseFloat(durationWeight.value) || 0.4;
        }

        const costWeight = document.getElementById('costWeight');
        if (costWeight) {
            state.objectiveWeights.cost = parseFloat(costWeight.value) || 0.3;
        }

        const resourcesWeight = document.getElementById('resourcesWeight');
        if (resourcesWeight) {
            state.objectiveWeights.resources = parseFloat(resourcesWeight.value) || 0.2;
        }

        const riskWeight = document.getElementById('riskWeight');
        if (riskWeight) {
            state.objectiveWeights.risk = parseFloat(riskWeight.value) || 0.1;
        }

        // Normalize weights to sum to 1
        const totalWeight = Object.values(state.objectiveWeights).reduce((sum, w) => sum + w, 0);
        if (totalWeight > 0) {
            Object.keys(state.objectiveWeights).forEach(key => {
                state.objectiveWeights[key] /= totalWeight;
            });
        }
    }

    /**
     * Reset settings to defaults
     */
    function resetSettings() {
        // Reset parameters
        state.parameters = {
            populationSize: 50,
            maxGenerations: 30,
            mutationRate: 0.2,
            crossoverRate: 0.7,
            tournamentSize: 3,
            elitismCount: 5,
            maxResourcesPerTask: 5
        };

        // Reset objective weights
        state.objectiveWeights = {
            duration: 0.4,
            cost: 0.3,
            resources: 0.2,
            risk: 0.1
        };

        // Update input fields
        const populationSize = document.getElementById('populationSize');
        if (populationSize) populationSize.value = state.parameters.populationSize;

        const maxGenerations = document.getElementById('maxGenerations');
        if (maxGenerations) maxGenerations.value = state.parameters.maxGenerations;

        const mutationRate = document.getElementById('mutationRate');
        if (mutationRate) mutationRate.value = state.parameters.mutationRate;

        const crossoverRate = document.getElementById('crossoverRate');
        if (crossoverRate) crossoverRate.value = state.parameters.crossoverRate;

        const maxResourcesPerTask = document.getElementById('maxResourcesPerTask');
        if (maxResourcesPerTask) maxResourcesPerTask.value = state.parameters.maxResourcesPerTask;

        const durationWeight = document.getElementById('durationWeight');
        if (durationWeight) durationWeight.value = state.objectiveWeights.duration;

        const costWeight = document.getElementById('costWeight');
        if (costWeight) costWeight.value = state.objectiveWeights.cost;

        const resourcesWeight = document.getElementById('resourcesWeight');
        if (resourcesWeight) resourcesWeight.value = state.objectiveWeights.resources;

        const riskWeight = document.getElementById('riskWeight');
        if (riskWeight) riskWeight.value = state.objectiveWeights.risk;
    }

    /**
     * Update scenarios list
     */
    function updateScenariosList() {
        const scenariosList = document.getElementById('scenariosList');
        if (!scenariosList) return;

        if (state.scenarios.length === 0) {
            scenariosList.innerHTML = `<div style="grid-column: 1 / -1; padding: 10px;">No scenarios saved yet.</div>`;
            return;
        }

        // Build HTML
        let html = '';
        state.scenarios.forEach((scenario, index) => {
            const activeClass = index === state.currentScenarioIndex ? 'active' : '';
            const date = new Date(scenario.timestamp).toLocaleString();

            html += `
                <div class="scenario-card ${activeClass}" data-index="${index}">
                    <div class="scenario-name">${scenario.name}</div>
                    <div class="scenario-desc">${scenario.description || 'No description'}</div>
                    <div class="scenario-meta">
                        <div>Duration: -${scenario.results.durationReduction.toFixed(1)} days</div>
                        <div>Cost: ${scheduler.state.currency}${scenario.results.cost.toLocaleString()}</div>
                        <div>Created: ${date}</div>
                    </div>
                </div>
            `;
        });

        // Set content
        scenariosList.innerHTML = html;

        // Attach event handlers
        document.querySelectorAll('.scenario-card').forEach(card => {
            card.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.getAttribute('data-index'));

                // Toggle active state
                if (e.currentTarget.classList.contains('active')) {
                    e.currentTarget.classList.remove('active');
                } else {
                    e.currentTarget.classList.add('active');
                }

                // If only one scenario is active, load it
                const activeScenarios = document.querySelectorAll('.scenario-card.active');
                if (activeScenarios.length === 1 && activeScenarios[0] === e.currentTarget) {
                    loadScenario(index);
                }
            });
        });
    }

    /**
     * Show optimization results
     * @param {Object} results - Optimization results
     */
    function showResults(results) {
        if (!results) return;

        // Show results tab
        document.querySelectorAll('.cybereum-optimizer .tab').forEach(tab => {
            tab.classList.remove('active');
            if (tab.getAttribute('data-tab') === 'results') {
                tab.classList.add('active');
                tab.style.display = 'block';
            }
        });

        document.querySelectorAll('.cybereum-optimizer .tab-content').forEach(content => {
            content.classList.remove('active');
        });

        const resultsTab = document.getElementById('resultsTab');
        if (resultsTab) {
            resultsTab.classList.add('active');
        }

        // Update results summary
        const summaryElement = document.getElementById('resultsSummary');
        if (summaryElement) {
            const netBenefitClass = results.netBenefit > 0 ? 'positive-value' : 'negative-value';

            // Build summary HTML
            const html = `
                <div class="result-item">
                    <div class="result-label">Duration Reduction</div>
                    <div class="result-value positive-value">
                        ${results.durationReduction.toFixed(1)} days
                    </div>
                </div>
                
                <div class="result-item">
                    <div class="result-label">Resource Cost</div>
                    <div class="result-value">
                        ${scheduler.state.currency}${results.cost.toLocaleString()}
                    </div>
                </div>
                
                <div class="result-item">
                    <div class="result-label">Net Benefit</div>
                    <div class="result-value ${netBenefitClass}">
                        ${scheduler.state.currency}${results.netBenefit.toLocaleString()}
                    </div>
                </div>
                
                <div class="result-item">
                    <div class="result-label">Resources Added</div>
                    <div class="result-value">
                        ${results.resourceCount}
                    </div>
                </div>
                
                <div class="result-item">
                    <div class="result-label">Projected End Date</div>
                    <div class="result-value">
                        ${results.endDate.toLocaleDateString()}
                    </div>
                </div>
                
                <div class="result-item">
                    <div class="result-label">Tasks Modified</div>
                    <div class="result-value">
                        ${results.solution.size}
                    </div>
                </div>
                
                <div class="result-item">
                    <div class="result-label">Constraint Violations</div>
                    <div class="result-value ${results.violatedConstraints.length > 0 ? 'negative-value' : ''}">
                        ${results.violatedConstraints.length}
                    </div>
                </div>
            `;

            summaryElement.innerHTML = html;
        }

        // Update violations list
        const violationsElement = document.getElementById('violationsList');
        if (violationsElement) {
            if (results.violatedConstraints.length === 0) {
                violationsElement.innerHTML = `<div style="padding: 10px;">No constraint violations found.</div>`;
            } else {
                let html = `
                <div style="padding: 10px; margin-top: 10px; border-top: 1px solid rgba(90, 200, 250, 0.3);">
                    <strong>Constraint Violations (${results.violatedConstraints.length}):</strong>
                </div>
                <table class="violation-table" style="width: 100%; border-collapse: collapse; margin-top: 10px;">
                    <tr>
                        <th style="text-align: left; padding: 8px; border-bottom: 1px solid rgba(90, 200, 250, 0.3);">Type</th>
                        <th style="text-align: left; padding: 8px; border-bottom: 1px solid rgba(90, 200, 250, 0.3);">Task</th>
                        <th style="text-align: left; padding: 8px; border-bottom: 1px solid rgba(90, 200, 250, 0.3);">Severity</th>
                        <th style="text-align: left; padding: 8px; border-bottom: 1px solid rgba(90, 200, 250, 0.3);">Details</th>
                    </tr>
            `;

                results.violatedConstraints.forEach(violation => {
                    // Get task name
                    const task = nodes.find(n => n.ID === violation.taskId);
                    const taskName = task ? task.Name || `Task ${violation.taskId}` : 'N/A';

                    // Severity color
                    const severityColor = violation.severity === 'high' ? '#ff5555' :
                        violation.severity === 'medium' ? '#ffb86c' : '#5ac8fa';

                    html += `
                    <tr>
                        <td style="padding: 8px; border-bottom: 1px solid rgba(90, 200, 250, 0.1);">${violation.type}</td>
                        <td style="padding: 8px; border-bottom: 1px solid rgba(90, 200, 250, 0.1);">${taskName}</td>
                        <td style="padding: 8px; border-bottom: 1px solid rgba(90, 200, 250, 0.1); color: ${severityColor};">${violation.severity}</td>
                        <td style="padding: 8px; border-bottom: 1px solid rgba(90, 200, 250, 0.1);">${violation.message}</td>
                    </tr>
                `;
                });

                html += '</table>';
                violationsElement.innerHTML = html;
            }
        }
        // Add resource utilization visualization
        const resourceUtilization = calculateResourceUtilization(results.solution, results.optimizedNodes);

        // Create a resource utilization chart
        const resourceElement = document.createElement('div');
        resourceElement.id = 'resourceUtilizationChart';
        resourceElement.style.marginTop = '20px';

        // Add resource utilization header
        resourceElement.innerHTML = `
        <div style="padding: 10px; margin-top: 10px; border-top: 1px solid rgba(90, 200, 250, 0.3);">
            <strong>Resource Utilization:</strong>
        </div>
    `;

        // If we have any overallocations, show them
        if (Object.keys(resourceUtilization.overallocations).length > 0) {
            let overallocationHtml = '<div style="margin-top: 10px; padding: 10px; background: rgba(255, 85, 85, 0.1); border-radius: 4px;">';
            overallocationHtml += '<strong style="color: var(--cyb-danger, #ff5555);">Resource Overallocations Detected:</strong><ul>';

            Object.entries(resourceUtilization.overallocations).forEach(([resourceType, periods]) => {
                overallocationHtml += `<li>${resourceType}: ${periods.length} overallocated periods</li>`;
            });

            overallocationHtml += '</ul></div>';
            resourceElement.innerHTML += overallocationHtml;
        }

        violationsElement.parentNode.appendChild(resourceElement);
    }

    // Initialize
    extractConstraints();

    // Public API
    return {
        // Main functions
        findOptimalSolution,
        applySolution,

        // Constraint management
        extractConstraints,

        // Scenario management
        saveScenario,
        loadScenario,
        compareScenarios,

        // Recommendations
        generateRecommendations,
        applyRecommendation,

        // UI functions
        renderInterface,

        // State access
        getState: () => ({ ...state }),

        // Utility methods
        getCriticalTasks,
        getNearCriticalTasks
    };
}

// Export for external use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = createConstraintBasedOptimizer;
}

// Make available globally in browser
if (typeof window !== 'undefined') {
    window.createConstraintBasedOptimizer = createConstraintBasedOptimizer;
}

/**
* AI Resource Modeling Enhancement for Schedule Optimization
* 
* This module enhances the existing schedule optimization interface with:
* - AI-driven resource parameter estimation
* - Dynamic max resource limits based on activity type and sector
* - Blended cost rates for multi-resource activities
* - Productivity models with diminishing returns
* - Visual indicators for resource types and constraints
* 
* Integration: Add this script after scheduleOptimizationInterface.js
* Usage: Call window.aiResourceModeling.enhance(optimizerInstance) after optimizer init
*/

(function () {
    'use strict';

    // =========================================================================
    // CONSTANTS & DEFAULTS
    // =========================================================================

    const RESOURCE_DEFAULTS = {
        skilled_labor: {
            icon: '👷',
            label: 'Skilled Labor',
            defaultRate: 85,
            defaultMax: 4,
            color: '#2563eb'
        },
        unskilled_labor: {
            icon: '🧑‍🔧',
            label: 'Unskilled Labor',
            defaultRate: 35,
            defaultMax: 8,
            color: '#16a34a'
        },
        equipment: {
            icon: '🏗️',
            label: 'Equipment',
            defaultRate: 187,
            defaultMax: 2,
            color: '#d97706'
        },
        specialist: {
            icon: '🔬',
            label: 'Specialist',
            defaultRate: 150,
            defaultMax: 2,
            color: '#9333ea'
        },
        subcontractor: {
            icon: '🏢',
            label: 'Subcontractor',
            defaultRate: 312,
            defaultMax: 3,
            color: '#dc2626'
        },
        materials: {
            icon: '📦',
            label: 'Materials',
            defaultRate: 0,
            defaultMax: 1,
            color: '#64748b'
        }
    };

    const SECTOR_MULTIPLIERS = {
        nuclear: { rateMultiplier: 1.45, availabilityFactor: 0.5, maxResourceFactor: 0.75 },
        petrochemical: { rateMultiplier: 1.35, availabilityFactor: 0.7, maxResourceFactor: 0.85 },
        datacenter: { rateMultiplier: 1.25, availabilityFactor: 0.8, maxResourceFactor: 0.9 },
        infrastructure: { rateMultiplier: 1.05, availabilityFactor: 1.0, maxResourceFactor: 1.1 },
        general: { rateMultiplier: 1.0, availabilityFactor: 1.0, maxResourceFactor: 1.0 }
    };

    const RESOURCE_KEYWORDS = {
        equipment: ['crane', 'excavator', 'bulldozer', 'forklift', 'concrete pump', 'equipment', 'machinery', 'heavy', 'lifting', 'earthwork', 'grading'],
        specialist: ['electrical', 'instrumentation', 'controls', 'testing', 'commissioning', 'calibration', 'qc', 'qa', 'inspection', 'nuclear', 'safety'],
        skilled_labor: ['weld', 'pipe', 'steel', 'install', 'erect', 'fabricat', 'mechanical', 'hvac', 'plumbing', 'fit'],
        unskilled_labor: ['cleanup', 'labor', 'support', 'helper', 'general', 'site prep', 'haul'],
        subcontractor: ['contractor', 'subcontract', 'vendor', 'supplier', 'third party', 'outsource']
    };

    // =========================================================================
    // STATE MANAGEMENT
    // =========================================================================

    const state = {
        resourceParameters: new Map(),  // taskId -> AI parameters
        userRateOverrides: new Map(),   // taskId -> user-specified rate
        _blendedRateCache: new Map(),   // taskId -> calculated blended rate
        _maxAvailableCache: new Map(),  // taskId -> calculated max
        _originalMethods: {},           // Preserved original optimizer methods
        _isInitialized: false,
        _inflightFetch: null,
        projectContext: null,           // Cached project context
        marketContext: null             // Market context from AI
    };

    // =========================================================================
    // CORE CALCULATION FUNCTIONS
    // =========================================================================

    /**
     * Calculate maximum available resources based on AI parameters
     * @param {Array} resourceTypes - Array of resource type estimates
     * @param {string} taskId - Activity ID
     * @returns {number} Maximum resources that can be assigned
     */
    function calculateMaxAvailable(resourceTypes, taskId) {
        if (state._maxAvailableCache.has(taskId)) {
            return state._maxAvailableCache.get(taskId);
        }

        if (!resourceTypes || resourceTypes.length === 0) {
            return 5; // Fallback default
        }

        // Use the primary resource type's max, or minimum if multiple
        let maxAvailable = resourceTypes[0].maxAvailable || 5;

        // If equipment or specialist is primary, use their lower limits
        const primaryType = resourceTypes[0].type;
        if (primaryType === 'equipment' || primaryType === 'specialist') {
            maxAvailable = Math.min(maxAvailable, 3);
        }

        // Apply sector adjustments if available
        if (state.projectContext?.sector) {
            const sector = state.projectContext.sector.toLowerCase();
            const multipliers = SECTOR_MULTIPLIERS[sector] || SECTOR_MULTIPLIERS.general;
            maxAvailable = Math.round(maxAvailable * multipliers.maxResourceFactor);
        }

        // Ensure at least 1 resource
        maxAvailable = Math.max(1, maxAvailable);

        state._maxAvailableCache.set(taskId, maxAvailable);
        return maxAvailable;
    }

    /**
     * Calculate blended hourly rate for multi-resource activities
     * @param {Array} resourceTypes - Array of resource type estimates
     * @param {string} taskId - Activity ID
     * @returns {number} Blended hourly rate
     */
    function calculateBlendedRate(resourceTypes, taskId) {
        // Check for user override first
        if (state.userRateOverrides.has(taskId)) {
            return state.userRateOverrides.get(taskId);
        }

        if (state._blendedRateCache.has(taskId)) {
            return state._blendedRateCache.get(taskId);
        }

        if (!resourceTypes || resourceTypes.length === 0) {
            return 100; // Fallback default
        }

        let blendedRate;
        if (resourceTypes.length === 1) {
            blendedRate = resourceTypes[0].hourlyRate || 100;
        } else {
            // Weighted blend: primary 55%, secondary 45%
            const primary = resourceTypes[0];
            const secondary = resourceTypes[1];
            const primaryRate = primary.hourlyRate || 100;
            const secondaryRate = secondary.hourlyRate || 50;
            blendedRate = (primaryRate * 0.55) + (secondaryRate * 0.45);
        }

        // Round to 2 decimal places
        blendedRate = Math.round(blendedRate * 100) / 100;

        state._blendedRateCache.set(taskId, blendedRate);
        return blendedRate;
    }

    /**
     * Calculate duration impact with productivity model
     * @param {string} taskId - Activity ID
     * @param {number} additionalResources - Resources being added
     * @param {Object} params - AI parameters for this task
     * @returns {Object} Duration reduction and efficiency
     */
    function calculateDurationWithProductivity(taskId, additionalResources, params) {
        if (!params || !params.resourceTypes || params.resourceTypes.length === 0) {
            // Simple linear model as fallback
            return {
                efficiency: 1.0,
                effectiveMultiplier: 1.0
            };
        }

        const productivityModel = params.resourceTypes[0].productivityModel || {
            type: 'diminishing',
            baseEfficiency: 1.0,
            diminishingFactor: 0.2,
            maxReduction: 0.5
        };

        const baseResources = 1;
        const totalResources = baseResources + additionalResources;

        let efficiency;
        switch (productivityModel.type) {
            case 'linear':
                efficiency = 1.0;
                break;

            case 'logarithmic':
                // Logarithmic: efficiency = 1 / (1 + ln(resources))
                efficiency = 1 / (1 + Math.log(totalResources));
                break;

            case 'stepped':
                // Stepped: discrete drops per additional resource
                const steps = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];
                efficiency = steps[Math.min(additionalResources, steps.length - 1)];
                break;

            case 'diminishing':
            default:
                // Diminishing returns: efficiency = baseEfficiency * (1 / resources^diminishingFactor)
                const base = productivityModel.baseEfficiency || 1.0;
                const factor = productivityModel.diminishingFactor || 0.2;
                const floor = productivityModel.maxReduction || 0.5;
                efficiency = base * Math.pow(totalResources, -factor);
                efficiency = Math.max(efficiency, floor);
                break;
        }

        // Effective multiplier = resources * efficiency
        const effectiveMultiplier = totalResources * efficiency;

        return {
            efficiency: efficiency,
            effectiveMultiplier: effectiveMultiplier,
            productivityModel: productivityModel.type
        };
    }

    /**
     * Get effective rate for a task (user override > AI rate > default)
     * @param {string} taskId - Activity ID
     * @returns {number} Effective hourly rate
     */
    function getEffectiveRate(taskId) {
        // Priority 1: User override
        if (state.userRateOverrides.has(taskId)) {
            return state.userRateOverrides.get(taskId);
        }

        // Priority 2: AI-estimated blended rate
        const params = state.resourceParameters.get(taskId);
        if (params && params.resourceTypes) {
            return calculateBlendedRate(params.resourceTypes, taskId);
        }

        // Priority 3: Default rate
        return 100;
    }

    // =========================================================================
    // API INTEGRATION
    // =========================================================================

    /**
     * Fetch resource parameters from AI endpoint
     * @param {Array} tasks - Array of task objects to estimate
     * @returns {Promise} Resolves with resource parameters
     */
    async function fetchResourceParametersForTasks(tasks, options = {}) {
        const forceRefresh = !!options.forceRefresh;
        // FIXED: Reduced chunk size from 50 to 20 for more reliable AI responses
        const chunkSize = Number(options.chunkSize) > 0 ? Math.min(Number(options.chunkSize), 20) : 20;

        if (!Array.isArray(tasks) || tasks.length === 0) return null;

        // Coalesce concurrent calls
        if (state._inflightFetch && !forceRefresh) {
            try {
                return await state._inflightFetch;
            } catch (_) {
                // fall through and retry
            }
        }

        const run = async () => {
            const results = [];

            for (let i = 0; i < tasks.length; i += chunkSize) {
                const chunk = tasks.slice(i, i + chunkSize);

                const payload = {
                    sector: state.projectContext?.sector || 'General',
                    country: state.projectContext?.country || 'United States',
                    region: state.projectContext?.region || 'General',
                    currency: state.projectContext?.currency || 'USD',
                    projectBudget: state.projectContext?.budget || 0,
                    activities: chunk.map(task => ({
                        id: task.id,
                        name: task.name || task.description || '',
                        description: task.description || '',
                        duration: Number(task.duration) || 0,
                        currentResources: Number(task.resources) || 1,
                        isCritical: !!task.isCritical,
                        percentComplete: Number(task.percentComplete) || 0,
                        recommendedResourceTypes: extractExistingRecommendations(task.id)
                    }))
                };

                const response = await fetch('/OpenAI/EstimateResourceParameters', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                // FIXED: Better error handling - use fallback instead of throwing
                if (!response.ok) {
                    const errorText = await response.text();
                    console.warn(`[AI Resource] Chunk failed: HTTP ${response.status}`);
                    console.warn(`[AI Resource] Error: ${errorText.substring(0, 200)}`);
                    applyFallbackParameters(chunk);
                    continue;
                }

                // FIXED: Parse response text first, validate, then parse as JSON
                const responseText = await response.text();

                if (!responseText || responseText.trim().length === 0) {
                    console.warn('[AI Resource] Chunk returned empty response');
                    applyFallbackParameters(chunk);
                    continue;
                }

                let data;
                try {
                    data = JSON.parse(responseText);
                } catch (parseError) {
                    console.warn('[AI Resource] Chunk returned invalid JSON:', parseError.message);
                    applyFallbackParameters(chunk);
                    continue;
                }

                // FIXED: Validate the response structure before processing
                if (!data || (!data.activityResources && !data.activities)) {
                    console.warn('[AI Resource] Response missing activityResources');
                    applyFallbackParameters(chunk);
                    continue;
                }

                processAIResponse(data);
                results.push(data);
            }

            // Return single response when possible, otherwise a batch wrapper
            return (results.length === 1) ? results[0] : { batch: results };
        };

        state._inflightFetch = run();

        try {
            return await state._inflightFetch;
        } catch (error) {
            console.error('[AI Resource] Fetch error:', error);
            applyFallbackParameters(tasks);
            return null;
        } finally {
            state._inflightFetch = null;
        }
    }

    /**
     * Extract existing resource recommendations from cached AI feedback
     * @param {string} taskId - Activity ID
     * @returns {Array} Array of recommended resource types
     */
    function extractExistingRecommendations(taskId) {
        // 1) Prefer schedule optimizer "Recommended Resources" feedback if available
        try {
            const opt = state.optimizer;
            const cache = opt?.state?.aiFeedbackCache;
            const key = `${taskId}|recommendations`;
            const feedback = cache ? cache[key] : null;
            if (feedback && typeof opt.extractResourceTypes === 'function') {
                const types = opt.extractResourceTypes(feedback);
                if (Array.isArray(types) && types.length) return types;
            }
        } catch (_) { /* no-op */ }

        // 2) Fall back to already-stored AI parameters (if any)
        const existingParams = state.resourceParameters.get(taskId);
        if (existingParams && Array.isArray(existingParams.resourceTypes) && existingParams.resourceTypes.length) {
            return existingParams.resourceTypes.map(rt => rt.type).filter(Boolean);
        }

        return [];
    }

    /**
     * Process and store AI response
     * @param {Object} data - AI response data
     */
    function processAIResponse(data) {
        const activitiesOut = data?.activityResources || data?.activities || [];
        if (!Array.isArray(activitiesOut) || activitiesOut.length === 0) {
            console.warn('[AI Resource] Invalid/empty AI response structure');
            return;
        }

        // Store market context if provided
        if (data.marketContext) {
            state.marketContext = data.marketContext;
        }

        const toNumber = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        const toInt = (v) => {
            const n = Math.round(Number(v));
            return Number.isFinite(n) ? n : null;
        };

        const normalizeResourceType = (rt) => {
            if (!rt || typeof rt !== 'object') return null;

            // FIXED: Handle truncated/malformed type strings safely
            let type = '';
            try {
                type = (rt.type || rt.category || rt.name || 'resource').toString().trim();
            } catch (e) {
                type = 'resource';
            }
            if (!type || type.length === 0) return null;

            // FIXED: Validate rate values more carefully
            let hourly = toNumber(rt.hourlyRate);
            let daily = toNumber(rt.dailyRate);

            // Cross-validate hourly and daily rates
            if (hourly == null && daily != null) {
                hourly = daily / 8;
            } else if (daily == null && hourly != null) {
                daily = hourly * 8;
            }

            // FIXED: Validate maxAvailable is a reasonable integer
            let maxAvail = toInt(rt.maxAvailable);
            if (maxAvail != null) {
                maxAvail = Math.max(1, Math.min(maxAvail, 20)); // Cap at reasonable bounds
            }

            const blended = toNumber(rt.blendedRate) ?? hourly;

            // FIXED: Validate productivity model
            let productivityModel = null;
            if (rt.productivityModel && typeof rt.productivityModel === 'object') {
                const pm = rt.productivityModel;
                productivityModel = {
                    type: (pm.type || 'diminishing').toString(),
                    baseEfficiency: toNumber(pm.baseEfficiency) ?? 1.0,
                    diminishingFactor: toNumber(pm.diminishingFactor) ?? 0.2,
                    maxReduction: toNumber(pm.maxReduction) ?? 0.5
                };
                // Validate bounds
                productivityModel.baseEfficiency = Math.max(0.1, Math.min(1.0, productivityModel.baseEfficiency));
                productivityModel.diminishingFactor = Math.max(0.05, Math.min(0.5, productivityModel.diminishingFactor));
                productivityModel.maxReduction = Math.max(0.3, Math.min(0.9, productivityModel.maxReduction));
            }

            return {
                type,
                category: (rt.category || '').toString(),
                hourlyRate: hourly != null ? Math.round(hourly * 100) / 100 : null,
                dailyRate: daily != null ? Math.round(daily * 100) / 100 : null,
                maxAvailable: maxAvail,
                blendedRate: blended != null ? Math.round(blended * 100) / 100 : null,
                productivityModel: productivityModel,
                availabilityConstraints: rt.availabilityConstraints || null,
                notes: rt.notes || rt.rationale || null
            };
        };

        activitiesOut.forEach(activity => {
            const taskId = activity?.activityId || activity?.id || activity?.taskId;
            if (!taskId) {
                console.warn('[AI Resource] Activity missing ID, skipping');
                return;
            }

            const rawTypes = Array.isArray(activity.resourceTypes) ? activity.resourceTypes : [];
            const resourceTypes = rawTypes.map(normalizeResourceType).filter(Boolean);

            // FIXED: Only store if we have valid resource types
            if (resourceTypes.length === 0) {
                console.warn(`[AI Resource] Activity ${taskId} has no valid resource types, skipping`);
                return;
            }

            state.resourceParameters.set(taskId, {
                resourceTypes,
                recommendedAllocation: activity.recommendedAllocation || null,
                estimationConfidence: activity.estimationConfidence || data.estimationConfidence || 'medium',
                // pass-through for future UI use
                activityCategory: activity.category || activity.activityCategory || null,
                // FIXED: Store baseline resources for proper max calculation
                baselineResources: activity.currentResources || 1
            });

            // Clear cached calculations
            state._blendedRateCache.delete(taskId);
            state._maxAvailableCache.delete(taskId);
        });

        console.log('[AI Resource] Processed', activitiesOut.length, 'activity parameters');
    }

    /**
     * Apply fallback parameters when AI fails
     * @param {Array} tasks - Array of task objects
     */
    function applyFallbackParameters(tasks) {
        console.log('[AI Resource] Applying fallback parameters for', tasks.length, 'tasks');

        const sectorKey = (state.projectContext?.sector || 'general').toLowerCase();
        const multipliers = SECTOR_MULTIPLIERS[sectorKey] || SECTOR_MULTIPLIERS.general;

        tasks.forEach(task => {
            const taskId = task.id;

            // Skip if we already have AI parameters for this task
            if (state.resourceParameters.has(taskId)) {
                return;
            }

            // Infer resource type from task name
            const taskName = (task.name || task.description || '').toLowerCase();
            let primaryType = 'skilled_labor';
            let secondaryType = null;

            for (const [type, keywords] of Object.entries(RESOURCE_KEYWORDS)) {
                if (keywords.some(kw => taskName.includes(kw))) {
                    // Prefer specialist/equipment if detected
                    if (primaryType === 'skilled_labor' || type === 'specialist' || type === 'equipment') {
                        primaryType = type;
                    } else if (!secondaryType) {
                        secondaryType = type;
                    }
                }
            }

            const primaryDefaults = RESOURCE_DEFAULTS[primaryType];
            const adjustedRate = Math.round(primaryDefaults.defaultRate * multipliers.rateMultiplier);
            const adjustedMax = Math.max(1, Math.round(primaryDefaults.defaultMax * multipliers.maxResourceFactor));

            const resourceTypes = [{
                type: primaryType,
                category: primaryDefaults.label,
                hourlyRate: adjustedRate,
                dailyRate: adjustedRate * 8,
                maxAvailable: adjustedMax,
                blendedRate: adjustedRate,
                productivityModel: {
                    type: 'diminishing',
                    baseEfficiency: 1.0,
                    diminishingFactor: primaryType === 'specialist' ? 0.3 : 0.2,
                    maxReduction: task.isCritical ? 0.5 : 0.6
                },
                notes: 'Fallback estimate based on activity keywords'
            }];

            if (secondaryType) {
                const secondaryDefaults = RESOURCE_DEFAULTS[secondaryType];
                resourceTypes.push({
                    type: secondaryType,
                    category: secondaryDefaults.label,
                    hourlyRate: Math.round(secondaryDefaults.defaultRate * multipliers.rateMultiplier),
                    dailyRate: Math.round(secondaryDefaults.defaultRate * multipliers.rateMultiplier * 8),
                    maxAvailable: Math.round(secondaryDefaults.defaultMax * multipliers.maxResourceFactor)
                });
            }

            state.resourceParameters.set(taskId, {
                resourceTypes: resourceTypes,
                recommendedAllocation: {
                    optimalCount: Math.min(2, adjustedMax),
                    rationale: 'Fallback estimation based on activity keywords'
                },
                estimationConfidence: 'low',
                baselineResources: task.resources || 1
            });

            // Clear caches for this task
            state._blendedRateCache.delete(taskId);
            state._maxAvailableCache.delete(taskId);
        });
    }

    // =========================================================================
    // UI UPDATE FUNCTIONS
    // =========================================================================

    /**
     * Update slider max attribute for a task
     * @param {string} taskId - Activity ID
     * @param {Object} params - Resource parameters
     */

    function updateSliderMax(taskId, params, optimizer) {
        const tid = String(taskId);

        // FIXED: Get from params.resourceTypes if available
        const aiParams = params || state.resourceParameters.get(tid);
        if (!aiParams || !aiParams.resourceTypes || aiParams.resourceTypes.length === 0) {
            return;
        }

        // Get the primary resource type's maxAvailable
        const primaryRT = aiParams.resourceTypes[0];
        const maxTotal = primaryRT.maxAvailable;

        if (!Number.isFinite(maxTotal) || maxTotal <= 0) {
            return;
        }

        // Calculate max additional (this IS the additional resources cap)
        const safeMaxAdditional = Math.max(1, Math.floor(maxTotal));

        // DOM cache (reduces querySelector churn on large projects)
        const cache = window.__cybOptDomCache || (window.__cybOptDomCache = {
            slider: new Map(),
            rate: new Map(),
            row: new Map(),
            warning: new Map()
        });

        let slider = cache.slider.get(tid);
        if (!slider || !document.contains(slider)) {
            slider = document.querySelector(`input.resource-slider[data-task-id="${tid}"]`);
            if (!slider) {
                // Try alternate selectors
                slider = document.querySelector(`input[type="range"][data-task-id="${tid}"]`);
            }
            if (slider) cache.slider.set(tid, slider);
        }
        if (!slider) {
            console.debug(`[AI Resource] No slider found for task ${tid}`);
            return;
        }

        // FIXED: Update both the max attribute and the property
        const oldMax = parseInt(slider.max, 10) || 5;
        slider.setAttribute('max', String(safeMaxAdditional));
        slider.max = String(safeMaxAdditional);

        // Update displayed max if present
        const maxEl = slider.closest('.resource-control')?.querySelector('.resource-max');
        if (maxEl) maxEl.textContent = String(safeMaxAdditional);

        // FIXED: Also update any max indicator in the row
        const row = slider.closest('tr');
        if (row) {
            const maxIndicator = row.querySelector('.max-resource-indicator');
            if (maxIndicator) {
                maxIndicator.textContent = `Max: +${safeMaxAdditional}`;
            }
        }

        // Clamp current value to new max
        const current = parseInt(slider.value, 10) || 0;
        if (current > safeMaxAdditional) {
            slider.value = String(safeMaxAdditional);
            // Keep optimizer state consistent
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        }

        console.debug(`[AI Resource] Updated slider max for ${tid}: ${oldMax} -> ${safeMaxAdditional}`);
    }



    function updateCostRateInput(taskId, rate, isOverride = false) {
        const tid = String(taskId);
        const r = Number(rate);

        if (!Number.isFinite(r) || r <= 0) {
            console.debug(`[AI Resource] Invalid rate for ${tid}: ${rate}`);
            return;
        }

        const cache = window.__cybOptDomCache || (window.__cybOptDomCache = {
            slider: new Map(),
            rate: new Map(),
            row: new Map(),
            warning: new Map()
        });

        let input = cache.rate.get(tid);
        if (!input || !document.contains(input)) {
            // Try multiple selectors
            input = document.querySelector(`input.task-rate[data-task-rate="${tid}"]`);
            if (!input) {
                input = document.querySelector(`input[data-task-id="${tid}"].task-rate`);
            }
            if (!input) {
                input = document.querySelector(`input.task-rate[data-task-id="${tid}"]`);
            }
            if (input) cache.rate.set(tid, input);
        }
        if (!input) {
            console.debug(`[AI Resource] No rate input found for task ${tid}`);
            return;
        }

        // FIXED: Check for user override more carefully
        if (!isOverride) {
            // Skip if user has overridden this rate
            if (input.dataset.userOverride === 'true') {
                return;
            }
            // Also check if the current value differs significantly from default
            const currentVal = parseFloat(input.value);
            const defaultRate = window.scheduleOptimizer?.state?.resourceRate || 100;
            if (Number.isFinite(currentVal) && Math.abs(currentVal - defaultRate) > 0.01 && Math.abs(currentVal - r) > 0.01) {
                // User has modified this value and it's different from what we're trying to set
                return;
            }
        }

        // FIXED: Update both the value attribute and property
        const oldVal = input.value;
        input.value = r.toFixed(2);
        input.setAttribute('value', r.toFixed(2));

        // Also update the optimizer's internal state
        if (window.scheduleOptimizer?.state?.taskRates) {
            window.scheduleOptimizer.state.taskRates.set(tid, r);
        }

        console.debug(`[AI Resource] Updated rate for ${tid}: ${oldVal} -> ${r.toFixed(2)}`);
    }


    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatRate(rate, currency) {
        const v = Number(rate);
        if (!Number.isFinite(v)) return '';
        const c = currency || 'USD';
        try {
            return new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(v);
        } catch (e) {
            return `${v.toFixed(2)} ${c}`;
        }
    }

    /**
     * Update "Recommended Resources" column with AI-derived resource parameters (type/rate/cap/productivity).
     */
    function updateRecommendedResourcesCell(taskId, params) {
        const cell = document.querySelector(`td.resource-types-feedback[data-task-id="${taskId}"]`);
        if (!cell || !params) return;

        // Remove previous injection
        const existing = cell.querySelector('.ai-resource-params');
        if (existing) existing.remove();

        const rts = Array.isArray(params.resourceTypes) ? params.resourceTypes : [];
        if (!rts.length) return;

        const currency = state.projectContext?.currency || 'USD';

        const badgeHtml = rts.slice(0, 3).map(rt => {
            const type = rt.type || 'Resource';
            const rate = (typeof rt.blendedRate === 'number') ? formatRate(rt.blendedRate, currency) : '';
            const max = (typeof rt.maxAvailable === 'number') ? `max ${rt.maxAvailable}` : '';
            const pm = rt.productivityModel?.type ? rt.productivityModel.type : '';
            const meta = [rate ? `${rate}/hr` : '', max, pm].filter(Boolean).join(' · ');
            return `<span style="display:inline-flex; align-items:center; padding:2px 8px; border:1px solid rgba(255,255,255,0.15); border-radius:999px; font-size:11px; white-space:nowrap;">
                        ${escapeHtml(type)}${meta ? ` <span style="opacity:0.8; margin-left:6px;">(${escapeHtml(meta)})</span>` : ''}
                    </span>`;
        }).join('');

        const html = `<div class="ai-resource-params" style="margin-top:6px;">
                        <div style="font-size:11px; opacity:0.85; margin-bottom:4px;">AI Resource Parameters</div>
                        <div style="display:flex; flex-wrap:wrap; gap:6px;">${badgeHtml}</div>
                      </div>`;

        cell.insertAdjacentHTML('beforeend', html);
    }


    function showConstraintWarning(taskId, requestedValue, maxAllowed) {
        const tid = String(taskId);

        const cache = window.__cybOptDomCache || (window.__cybOptDomCache = {
            slider: new Map(),
            rate: new Map(),
            row: new Map(),
            warning: new Map()
        });

        let row = cache.row.get(tid);
        if (!row || !document.contains(row)) {
            row = document.querySelector(`tr[data-task-id="${tid}"]`);
            if (row) cache.row.set(tid, row);
        }
        if (!row) return;

        const control = row.querySelector('.resource-control');
        if (!control) return;

        const req = Number(requestedValue) || 0;
        const max = Number(maxAllowed) || 0;

        let warningEl = cache.warning.get(tid);
        if (!warningEl || !document.contains(warningEl)) {
            warningEl = control.querySelector('.constraint-warning');
            if (!warningEl) {
                warningEl = document.createElement('div');
                warningEl.className = 'constraint-warning';
                warningEl.style.cssText = 'margin-top:6px;font-size:12px;line-height:1.2;color:#ffb000;';
                control.appendChild(warningEl);
            }
            cache.warning.set(tid, warningEl);
        }

        if (req > max && max > 0) {
            warningEl.textContent = `Requested +${req} exceeds available +${max}. Slider capped.`;
            warningEl.style.display = 'block';
        } else {
            warningEl.textContent = '';
            warningEl.style.display = 'none';
        }
    }


    // =========================================================================
    // OPTIMIZER ENHANCEMENT
    // =========================================================================

    /**
     * Enhance the schedule optimizer with AI resource modeling
     * @param {Object} optimizer - The existing optimizer instance
     */
    function enhanceOptimizer(optimizer) {
        if (!optimizer) {
            console.error('[AI Resource] No optimizer instance provided');
            return;
        }

        if (state._isInitialized) {
            console.log('[AI Resource] Already initialized');
            return;
        }

        console.log('[AI Resource] Enhancing optimizer...');
        state.optimizer = optimizer;

        // Store original methods before overriding
        state._originalMethods = {
            getMaxResourcesForTask: optimizer.getMaxResourcesForTask?.bind(optimizer),
            calculateScheduleImpact: optimizer.calculateScheduleImpact?.bind(optimizer),
            calculateCostDisplay: optimizer.calculateCostDisplay?.bind(optimizer),
            handleResourceChange: optimizer.handleResourceChange?.bind(optimizer),
            handleTaskRateChange: optimizer.handleTaskRateChange?.bind(optimizer),
            renderInterface: optimizer.renderInterface?.bind(optimizer)
        };

        // Extract project context (Cybereum project state / start-node properties)
        try {
            const p = window.cybereumState?.project || {};
            const budgetVal = (() => {
                const b = p.budget;
                if (typeof b === 'number' && Number.isFinite(b)) return b;
                if (b && typeof b.amount === 'number' && Number.isFinite(b.amount)) return b.amount;
                return 0;
            })();

            state.projectContext = {
                sector: p.segment || p.projectType || 'General',
                country: p.countryName || p.country || 'United States',
                region: p.region || p.regionName || 'General',
                currency: p.budgetCurrency || p.currency || 'USD',
                budget: budgetVal
            };
        } catch (e) {
            state.projectContext = state.projectContext || { sector: 'General', country: 'United States', region: 'General', currency: 'USD', budget: 0 };
        }

        // --- Ensure optimizer exposes AI-aware max additional resources per task ---
        optimizer.getMaxResourcesForTask = function (taskId) {
            const params = state.resourceParameters.get(taskId);
            const originalResources = (this.state?.originalDurations?.get(taskId)?.resources) || 1;

            if (params && Array.isArray(params.resourceTypes) && params.resourceTypes.length > 0) {
                // AI returns a practical TOTAL count; UI/optimizer uses ADDITIONAL resources.
                const maxTotal = calculateMaxAvailable(params.resourceTypes, taskId);
                const maxAdditional = Math.max(0, Math.round(maxTotal - originalResources));
                return maxAdditional;
            }

            if (state._originalMethods.getMaxResourcesForTask) {
                return state._originalMethods.getMaxResourcesForTask(taskId);
            }

            return 5; // Default additional max
        };

        // Convenience: expose effective rate
        optimizer.getEffectiveRate = function (taskId) {
            return getEffectiveRate(taskId, optimizer);
        };

        // ---- ENHANCED: calculateScheduleImpact (resource-type productivity + practical caps) ----
        if (state._originalMethods.calculateScheduleImpact) {
            optimizer.calculateScheduleImpact = function (nodeId, resourceChange) {
                const originalData = this.state.originalDurations.get(nodeId);
                if (!originalData) return 0;

                const maxAdditional = this.getMaxResourcesForTask(nodeId);
                const rc = Math.max(0, Math.min(Number(resourceChange) || 0, maxAdditional));
                if (rc <= 0) return 0;

                // Use nodeMap from global state (this.nodes doesn't exist in enhanced method scope)
                let node = window.cybereumState?.nodeMap?.get(nodeId);
                if (!node) {
                    // Fallback: try to find in optimizable tasks
                    const optimizableNodes = (typeof this.getOptimizableTasks === 'function') ? this.getOptimizableTasks() : [];
                    node = optimizableNodes.find(n => n.ID === nodeId);
                }
                if (!node) return 0;

                // Cache key includes productivity model to avoid stale results
                const params = state.resourceParameters.get(nodeId);
                const prod = params?.resourceTypes?.[0]?.productivityModel || {};
                const prodKey = `${prod.type || 'default'}|${prod.diminishingFactor || ''}|${prod.maxReduction || ''}`;

                const cacheKey = `${nodeId}|${rc}|${prodKey}`;
                if (this._impactCache && this._impactCache.has(cacheKey)) {
                    return this._impactCache.get(cacheKey);
                }

                // Map productivity model onto scheduleUtils options
                let options = {
                    complexity: Number(node.riskScore || 0.5)
                };

                if (params && Array.isArray(params.resourceTypes) && params.resourceTypes.length > 0) {
                    const rt = params.resourceTypes[0];
                    const pm = rt.productivityModel || {};
                    const base = calculateDurationWithProductivity(nodeId, rc, params);

                    const maxReduction = (typeof pm.maxReduction === 'number' && pm.maxReduction > 0 && pm.maxReduction < 0.95)
                        ? pm.maxReduction
                        : 0.65;

                    const diminishingFactor = (typeof pm.diminishingFactor === 'number' && pm.diminishingFactor > 0)
                        ? pm.diminishingFactor
                        : 0.25;

                    // Blend project/task complexity with resource-type diminishing factor
                    const baseComplex = Math.max(0, Math.min(1, Number(node.riskScore || 0.5)));
                    const blendedComplex = Math.max(0, Math.min(1, (baseComplex * 0.7) + (diminishingFactor * 1.2)));

                    options = {
                        efficiency: base?.efficiency ?? 1.0,
                        maxReduction,
                        complexity: blendedComplex
                    };
                }

                const adjustedDuration = scheduleUtils.calculateResourceAdjustedDuration(
                    originalData.duration,
                    originalData.resources,
                    rc,
                    node.PercentComplete || 0,
                    options
                );

                const reduction = originalData.duration - adjustedDuration;

                if (!this._impactCache) this._impactCache = new Map();
                if (!this._impactCache) this._impactCache = new Map();

                // Add size limit
                const MAX_CACHE_SIZE = 1000;
                if (this._impactCache.size >= MAX_CACHE_SIZE) {
                    const toClear = Math.floor(MAX_CACHE_SIZE * 0.3);
                    const keysToDelete = Array.from(this._impactCache.keys()).slice(0, toClear);
                    keysToDelete.forEach(k => this._impactCache.delete(k));
                }
                this._impactCache.set(cacheKey, reduction);

                return reduction;
            };
        }

        // ---- ENHANCED: fetchResourceParameters (batch call; auto-applies rates + caps) ----
        optimizer.fetchResourceParameters = async function (forceRefresh = false) {
            try {
                const optimizableNodes = (typeof this.getOptimizableTasks === 'function') ? this.getOptimizableTasks() : [];
                const tasksAll = (optimizableNodes || []).map(n => ({
                    id: n.ID,
                    name: n.ActivityName || n.Name || '',
                    description: n.ActivityDescription || n.Description || '',
                    duration: Number(n.Duration) || 0,
                    resources: Number(this.state.originalDurations.get(n.ID)?.resources) || 1,
                    isCritical: this.state.criticalTasks?.has(n.ID) || false,
                    percentComplete: Number(n.PercentComplete || 0) || 0
                }));

                if (!tasksAll.length) return;

                // Fetch only missing tasks unless forceRefresh
                const tasksToFetch = forceRefresh
                    ? tasksAll
                    : tasksAll.filter(t => !state.resourceParameters.has(t.id));

                if (tasksToFetch.length) {
                    await fetchResourceParametersForTasks(tasksToFetch, { forceRefresh: forceRefresh, chunkSize: 20 });
                }

                // Clear cached impacts so new caps/curves take effect
                if (this._impactCache) this._impactCache.clear();

                // Sync UI caps/rates and apply effective rate if user hasn't overridden
                tasksAll.forEach(t => {
                    const params = state.resourceParameters.get(t.id);
                    if (!params) return;

                    // Apply effective rate to optimizer state unless user override exists
                    if (!state.userRateOverrides.has(t.id)) {
                        const effectiveRate = getEffectiveRate(t.id);
                        const current = this.state.taskRates?.get(t.id);
                        if (!Number.isFinite(current) || current === this.state.resourceRate) {
                            this.state.taskRates.set(t.id, effectiveRate);
                        }
                    }

                    updateSliderMax(t.id, params, this);
                    updateCostRateInput(t.id, getEffectiveRate(t.id));
                    updateRecommendedResourcesCell(t.id, params);
                });

                console.log('[AI Resource] Resource parameters sync complete. fetched:', tasksToFetch.length);
            } catch (e) {
                console.error('[AI Resource] Error fetching resource parameters:', e);
            }
        };

        // ---- ENHANCED: handleResourceChange (clamp to AI max + warning) ----
        if (state._originalMethods.handleResourceChange) {
            optimizer.handleResourceChange = function (event) {
                const taskId = event.target.dataset.taskId;
                const slider = event.target;

                if (taskId) {
                    const maxAdditional = this.getMaxResourcesForTask(taskId);
                    const newVal = Math.max(0, Math.min(parseInt(slider.value, 10) || 0, maxAdditional));

                    if (newVal !== (parseInt(slider.value, 10) || 0)) {
                        slider.value = newVal;
                    }

                    // Update display value immediately
                    const valueSpan = document.querySelector(`.resource-value[data-task-id="${taskId}"]`);
                    if (valueSpan) valueSpan.textContent = newVal;

                    showConstraintWarning(taskId, newVal, maxAdditional);
                }

                return state._originalMethods.handleResourceChange(event);
            };
        }

        // ---- ENHANCED: handleTaskRateChange (track overrides) ----
        if (state._originalMethods.handleTaskRateChange) {
            optimizer.handleTaskRateChange = function (event) {
                const taskId = event.target.dataset.taskId || event.target.dataset.taskRate;
                const newRate = parseFloat(event.target.value);

                if (taskId && !isNaN(newRate) && newRate > 0) {
                    state.userRateOverrides.set(taskId, newRate);
                    updateCostRateInput(taskId, newRate, true);
                }

                return state._originalMethods.handleTaskRateChange(event);
            };
        }

        // ---- ENHANCED: renderInterface (auto-fetch parameters after initial render) ----
        if (state._originalMethods.renderInterface) {
            optimizer.renderInterface = function () {
                const result = state._originalMethods.renderInterface();

                // Refresh button for manual recalculation
                setTimeout(() => {
                    try { addRefreshButton(); } catch (e) { /* ignore */ }
                }, 0);

                // Fetch parameters shortly after render
                setTimeout(() => {
                    optimizer.fetchResourceParameters(false);
                }, 150);

                return result;
            };
        }

        state._isInitialized = true;
        console.log('[AI Resource] Optimizer enhanced successfully');
    }

    /**
         * Add refresh button to the interface
         */
    function addRefreshButton() {
        // Look for existing button container
        let container = document.querySelector('.optimizer-toolbar, .optimizer-controls');
        if (!container) {
            container = document.querySelector('.schedule-optimizer-header');
        }
        if (!container) return;

        // Check if button already exists
        if (container.querySelector('.refresh-ai-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'refresh-ai-btn btn btn-secondary';
        btn.innerHTML = '🔄 Refresh AI Parameters';
        btn.title = 'Clear cache and re-fetch AI resource parameters';
        btn.onclick = async () => {
            // Clear caches
            state.resourceParameters.clear();
            state._blendedRateCache.clear();
            state._maxAvailableCache.clear();
            state.userRateOverrides.clear();

            // Re-fetch
            if (window.scheduleOptimizer?.fetchResourceParameters) {
                await window.scheduleOptimizer.fetchResourceParameters();
            }
        };

        container.appendChild(btn);
    }

    /**
     * Show/hide loading indicator
     * @param {boolean} show - Whether to show or hide
     */
    function showLoadingIndicator(show) {
        let indicator = document.querySelector('.ai-loading-indicator');

        if (show) {
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.className = 'ai-loading-indicator';
                indicator.innerHTML = '<span class="spinner"></span> Loading AI resource parameters...';
                document.body.appendChild(indicator);
            }
            indicator.style.display = 'flex';
        } else if (indicator) {
            indicator.style.display = 'none';
        }
    }

    /**
     * Inject CSS styles for AI resource modeling UI
     */
    function injectStyles() {
        if (document.querySelector('#ai-resource-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'ai-resource-styles';
        styles.textContent = `
            .resource-badge {
                display: inline-block;
                padding: 2px 8px;
                border-radius: 12px;
                font-size: 0.75rem;
                font-weight: 500;
                margin-right: 4px;
                white-space: nowrap;
            }

            .max-resource-indicator {
                display: block;
                font-size: 0.7rem;
                color: #6b7280;
                margin-top: 2px;
            }

            .rate-indicator {
                display: inline-block;
                margin-left: 4px;
                font-size: 0.7rem;
                font-weight: 600;
                padding: 1px 4px;
                border-radius: 4px;
                background: #f3f4f6;
            }

            .recommendation-rationale {
                cursor: help;
                margin-left: 4px;
            }

            .constraint-warning {
                display: none;
                position: absolute;
                background: #fef2f2;
                border: 1px solid #fecaca;
                color: #991b1b;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 0.75rem;
                z-index: 100;
                white-space: nowrap;
            }

            .refresh-ai-btn {
                margin-left: 8px;
                padding: 6px 12px;
                font-size: 0.875rem;
                border-radius: 6px;
                background: #f3f4f6;
                border: 1px solid #d1d5db;
                cursor: pointer;
                transition: all 0.2s;
            }

            .refresh-ai-btn:hover {
                background: #e5e7eb;
                border-color: #9ca3af;
            }

            .ai-loading-indicator {
                position: fixed;
                top: 20px;
                right: 20px;
                background: white;
                padding: 12px 20px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                display: flex;
                align-items: center;
                gap: 10px;
                z-index: 1000;
                font-size: 0.875rem;
            }

            .ai-loading-indicator .spinner {
                width: 16px;
                height: 16px;
                border: 2px solid #e5e7eb;
                border-top-color: var(--cyb-primary, #3b82f6);
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
            }

            @keyframes spin {
                to { transform: rotate(360deg); }
            }

            .productivity-indicator {
                font-size: 0.7rem;
                color: #6b7280;
            }

            .productivity-indicator.high { color: #16a34a; }
            .productivity-indicator.medium { color: #d97706; }
            .productivity-indicator.low { color: var(--cyb-danger, #dc2626); }
        `;
        document.head.appendChild(styles);
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    window.aiResourceModeling = {
        // Main enhancement function
        enhance: enhanceOptimizer,

        // Direct access to state (for debugging)
        getState: () => ({ ...state }),

        // Manual parameter fetch
        fetchParameters: fetchResourceParametersForTasks,

        // Rate calculation
        getEffectiveRate: getEffectiveRate,
        getBlendedRate: calculateBlendedRate,
        getMaxAvailable: calculateMaxAvailable,

        // Override management
        setRateOverride: (taskId, rate) => {
            state.userRateOverrides.set(taskId, rate);
            state._blendedRateCache.delete(taskId);
        },
        clearRateOverride: (taskId) => {
            state.userRateOverrides.delete(taskId);
            state._blendedRateCache.delete(taskId);
        },

        // Cache management
        clearCache: () => {
            state.resourceParameters.clear();
            state._blendedRateCache.clear();
            state._maxAvailableCache.clear();
        },

        // Constants
        RESOURCE_DEFAULTS,
        SECTOR_MULTIPLIERS
    };

    console.log('[AI Resource Modeling] Module loaded. Call aiResourceModeling.enhance(optimizer) to initialize.');

})();
