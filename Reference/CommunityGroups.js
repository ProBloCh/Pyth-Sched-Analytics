async function fetchCommunityGroupNames(nodes) {
    let communityGroupedNodes = Object.values(
        nodes.reduce((acc, current) => {
            acc[current.communityGroupName] = acc[current.communityGroupName] ?? [];
            acc[current.communityGroupName].push(current);
            return acc;
        }, {})
    );
    const communityGroupNames = [];
    for (var node of nodes) {
        let groupInfo = {};
        groupInfo.Name = node.communityGroupName;
        groupInfo.Description = node.communityGroupDescription;

        if (communityGroupNames.length > 0) {
            if (communityGroupNames.hasOwnProperty(node.CommunityGroup) == false) {
                communityGroupNames[node.CommunityGroup] = groupInfo;
            }
        }
        else {
            communityGroupNames[node.CommunityGroup] = groupInfo;
        }
    }

    const DepgroupedNodes = Object.values(
        nodes.reduce((acc, current) => {
            acc[current.dependencyGroupName] = acc[current.dependencyGroupName] ?? [];
            acc[current.dependencyGroupName].push(current);
            return acc;
        }, {})
    );

    const DepGroupNames = [];
    for (var node of nodes) {
        let groupInfo = {};
        groupInfo.Name = node.dependencyGroupName;
        groupInfo.Description = node.dependencyGroupDescription;
        if (DepGroupNames.length > 0) {
            if (DepGroupNames.hasOwnProperty(node.DependencyCluster) == false) {
                DepGroupNames[node.DependencyCluster] = groupInfo;
            }
        }
        else {
            DepGroupNames[node.DependencyCluster] = groupInfo;
        }
    }

    return { communityGroupedNodes, communityGroupNames, DepgroupedNodes, DepGroupNames };
}

// ============================================================================
// CYBEREUM PROJECT GROUP MANAGER v2.0 - ENHANCED WITH DESIGN SYSTEM
// ============================================================================
// Load this file BEFORE the original CommunityGroups.js, OR replace the header
// section (first ~1260 lines) with this enhanced version.
//
// Enhancements included:
//   1. CybereumDesign - Unified design tokens, colors, typography
//   2. MetricsCache - WeakMap-based caching for performance
//   3. ProjectGroup - Object model with lifecycle management
//   4. ProjectGroupRegistry - Central management of group objects
//   5. Enhanced cleanup registry with group-level cleanup
// ============================================================================

'use strict';

function buildFallbackGroupName({ groupType, groupId, groupNumber, phase, discipline, wbsPath }) {
    const normalizedType = groupType === 'CommunityGroup' ? 'Work Group' :
        groupType === 'DependencyCluster' ? 'Dependency Cluster' :
            groupType === 'WBS_ID' ? 'WBS Group' :
                (groupType || 'Activity Group');

    const basis = [phase, discipline, wbsPath].find(v => typeof v === 'string' && v.trim().length > 0);
    if (basis) return `${basis.trim()} ${normalizedType}`;

    const numericIdentifier = groupNumber || groupId;
    return `${normalizedType} ${numericIdentifier || 'Unnamed'}`;
}

function resolveGroupDisplayName(rawName, context = {}) {
    const cleaned = (rawName || '').toString().trim();
    const invalidNames = new Set(['unknown', 'n/a', 'na', 'none', 'null', 'undefined', 'tbd']);

    if (cleaned && !invalidNames.has(cleaned.toLowerCase())) {
        return cleaned;
    }

    return buildFallbackGroupName(context);
}

// ============================================================================
// 1. CYBEREUM DESIGN SYSTEM - Unified colors, typography, utilities
// ============================================================================
const CybereumDesign = window.CybereumDesign || (function () {
    // Fallback (should not normally run): minimal Cybereum design tokens.
    // Prefer loading CybereumDashboardUICommon.js before CommunityGroups.js.
    const palette = Object.freeze({
        bgDeep: '#0a1929',
        bgDark: '#0d2137',
        bgMid: '#102d50',
        bgLight: '#153a5e',
        bgGlass: 'rgba(14, 36, 70, 0.85)',
        primary: '#5ac8fa',
        primaryDim: '#3a98ca',
        primaryGlow: 'rgba(90, 200, 250, 0.4)',
        secondary: '#41afeb',
        accent1: '#ff4444',
        accent2: '#b4f5ff',
        accent3: '#287dc8',
        success: '#50fa7b',
        warning: '#ffb86c',
        danger: '#ff5555',
        info: '#8be9fd',
        text: '#cdfaff',
        textPrimary: '#cdfaff',
        textSecondary: '#8ce6ff',
        textMid: '#8ce6ff',
        textTertiary: '#5a8ab5',
        textLow: '#3292cd',
        highlight: '#46b9fa',
        border: '#46b9fa',
        red: '#ff5555',
        green: '#50fa7b',
        orange: '#ffb86c',
        yellow: '#ffeb3b',
        purple: '#bd93f9',
        pink: '#ff79c6',
        cyan: '#8be9fd'
    });

    const getHealthColor = (score) => {
        if (score >= 80) return palette.success;
        if (score >= 60) return palette.warning;
        if (score >= 40) return palette.orange;
        return palette.danger;
    };

    const getProgressColor = (p) => {
        if (p >= 90) return palette.success;
        if (p >= 70) return palette.primary;
        if (p >= 40) return palette.warning;
        return palette.danger;
    };

    return (window.CybereumDesign = {
        version: 'community-fallback',
        palette,
        typography: {
            display: "'Orbitron', system-ui, sans-serif",
            body: "'Inter', system-ui, sans-serif",
            mono: "'JetBrains Mono', monospace",
            size: Object.freeze({ xs: '10px', sm: '11px', base: '13px', lg: '15px', xl: '18px', '2xl': '24px' })
        },
        spacing: Object.freeze({ xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px', '2xl': '32px' }),
        radii: Object.freeze({ sm: '4px', md: '6px', lg: '8px', xl: '12px', full: '9999px' }),
        transitions: Object.freeze({ fast: '0.15s ease', normal: '0.25s ease', slow: '0.35s ease-out' }),
        shadows: Object.freeze({
            sm: '0 1px 2px rgba(0,0,0,0.3)',
            md: '0 4px 8px rgba(0,0,0,0.25)',
            lg: '0 8px 24px rgba(0,0,0,0.35)',
            glow: (color) => `0 0 20px ${color}40, 0 0 40px ${color}20`
        }),
        getHealthColor,
        getProgressColor
    });
})();;
window.CybereumDesign = CybereumDesign;

// ============================================================================
// 2. METRICS CACHE - WeakMap-based caching for calculateGroupMetrics
// ============================================================================
const MetricsCache = {
    _cache: new WeakMap(),
    _version: new WeakMap(),
    _globalVersion: 0,

    /**
     * Get cached metrics or calculate new ones
     * @param {Array} nodes - Activity nodes array
     * @param {Function} calculator - Function to calculate metrics
     * @returns {Object} Metrics object
     */
    get(nodes, calculator) {
        if (!nodes || !Array.isArray(nodes)) return null;

        const cached = this._cache.get(nodes);
        const version = this._version.get(nodes);

        if (cached && version === this._globalVersion) {
            return cached;
        }

        const metrics = calculator(nodes);
        this._cache.set(nodes, metrics);
        this._version.set(nodes, this._globalVersion);

        return metrics;
    },

    /** Invalidate cache for specific nodes */
    invalidate(nodes) {
        if (nodes) {
            this._cache.delete(nodes);
            this._version.delete(nodes);
        }
    },

    /** Invalidate all caches (call when data date changes) */
    invalidateAll() {
        this._globalVersion++;
    },

    /** Clear entire cache */
    clear() {
        this._cache = new WeakMap();
        this._version = new WeakMap();
        this._globalVersion++;
    }
};
window.MetricsCache = MetricsCache;

// ============================================================================
// 3. PROJECT GROUP CLASS - Object model with lifecycle management
// ============================================================================
class ProjectGroup {
    #disposed = false;
    #cleanupFns = new Set();
    #nodes = null;

    /**
     * Create a ProjectGroup
     * @param {Object} config
     */
    constructor(config) {
        this.id = config.id;
        this.groupType = config.groupType;
        this.groupNumber = config.groupNumber || 0;
        this.name = resolveGroupDisplayName(config.name, {
            groupType: config.groupType,
            groupId: config.id,
            groupNumber: config.groupNumber,
            phase: config.detectedTags?.phase,
            discipline: config.detectedTags?.discipline,
            wbsPath: config.wbsPath
        });
        this.description = config.description || '';
        this.wbsPath = config.wbsPath || '';
        this.detectedTags = config.detectedTags || null;
        this.networkMetrics = config.networkMetrics || null;
        this.aiInsight = config.aiInsight || null;

        this.#nodes = config.nodes || [];
        this.nodes = this.#nodes; // Legacy compatibility
    }

    /** Get activities array */
    get activities() { return this.#nodes; }

    /** Activity count */
    get activityCount() { return this.#nodes?.length || 0; }

    /** Composite key for lookups */
    get compositeKey() { return `${this.groupType}:${this.id}`; }

    /** Is this a commissioning group? */
    get isCommissioning() {
        const phase = this.detectedTags?.phase;
        return phase === 'Commissioning' || phase === 'Pre-Commissioning';
    }

    /** Is disposed? */
    get disposed() { return this.#disposed; }

    /** Get cached metrics */
    get metrics() {
        if (this.#disposed) return null;
        return MetricsCache.get(this.#nodes, (n) => {
            const manager = new ProjectGroupManager();
            return manager.calculateGroupMetrics(n);
        });
    }

    /** Health score shortcut */
    get healthScore() { return this.metrics?.healthScore || 0; }

    /** Progress shortcut */
    get progress() { return this.metrics?.aggregateProgress || 0; }

    /** Set nodes and invalidate cache */
    setNodes(nodes) {
        if (this.#disposed) throw new Error('Group is disposed');
        MetricsCache.invalidate(this.#nodes);
        this.#nodes = nodes;
        this.nodes = nodes;
    }

    /** Set AI insight */
    setAIInsight(insight) {
        this.aiInsight = insight;
        const analytics = window.cybereumState?.analytics;
        if (analytics?.setGroupInsight) {
            analytics.setGroupInsight(this.groupType, this.id, insight);
        }
    }

    /** Set network metrics */
    setNetworkMetrics(metrics) {
        this.networkMetrics = metrics;
    }

    /** Register cleanup function */
    onDispose(fn) {
        if (this.#disposed) {
            try { fn(); } catch (e) { }
            return () => { };
        }
        this.#cleanupFns.add(fn);
        return () => this.#cleanupFns.delete(fn);
    }

    /** Dispose group and cleanup resources */
    dispose() {
        if (this.#disposed) return;
        this.#disposed = true;

        for (const fn of this.#cleanupFns) {
            try { fn(); } catch (e) { }
        }
        this.#cleanupFns.clear();

        MetricsCache.invalidate(this.#nodes);
        this.#nodes = null;
        this.nodes = null;
        this.aiInsight = null;
        this.networkMetrics = null;
    }

    /** Serialize for export/AI */
    toJSON() {
        const m = this.metrics || {};
        return {
            id: this.id,
            groupType: this.groupType,
            groupNumber: this.groupNumber,
            name: this.name,
            activityCount: this.activityCount,
            healthScore: m.healthScore || 0,
            progress: m.aggregateProgress || 0,
            criticalCount: m.criticalTaskCount || 0,
            behindScheduleCount: m.behindScheduleCount || 0,
            schedulePerformance: m.schedulePerformance || 0,
            costPerformance: m.costPerformance || 0,
            detectedTags: this.detectedTags,
            aiInsightSummary: this.aiInsight?.actionableInsight || null
        };
    }

    /** Create from legacy group data */
    static fromLegacy(groupType, groupId, data, nodes) {
        return new ProjectGroup({
            id: groupId,
            groupType,
            groupNumber: data.groupNumber || data.GroupNumber || 0,
            name: resolveGroupDisplayName(data.name || data.Name || data.GroupName, {
                groupType,
                groupId,
                groupNumber: data.groupNumber || data.GroupNumber || 0,
                phase: data.detectedTags?.phase,
                discipline: data.detectedTags?.discipline,
                wbsPath: data.WBS_Path || data.wbsPath
            }),
            description: data.description || data.Description || '',
            wbsPath: data.WBS_Path || data.wbsPath || '',
            nodes: nodes || data.nodes || [],
            detectedTags: data.detectedTags || null,
            networkMetrics: data.networkMetrics || null
        });
    }
}
window.ProjectGroup = ProjectGroup;

// ============================================================================
// 4. PROJECT GROUP REGISTRY - Central management of group objects
// ============================================================================
const ProjectGroupRegistry = {
    _groups: new Map(),

    /** Register a ProjectGroup */
    register(group) {
        if (!(group instanceof ProjectGroup)) {
            throw new TypeError('Expected ProjectGroup instance');
        }
        const existing = this._groups.get(group.compositeKey);
        if (existing && !existing.disposed) existing.dispose();
        this._groups.set(group.compositeKey, group);
        return group;
    },

    /** Get ProjectGroup by type and ID */
    get(groupType, groupId) {
        const key = `${groupType}:${groupId}`;
        const pg = this._groups.get(key);
        if (pg && pg.disposed) {
            this._groups.delete(key);
            return null;
        }
        return pg || null;
    },

    /** Get or create ProjectGroup from state */
    getOrCreate(groupType, groupId) {
        let pg = this.get(groupType, groupId);
        if (pg) return pg;

        const data = window.cybereumState?.groups?.[groupType]?.[groupId];
        if (!data) return null;

        pg = ProjectGroup.fromLegacy(groupType, groupId, data, data.nodes);
        return this.register(pg);
    },

    /** Get all ProjectGroups for a type */
    getAll(groupType) {
        const result = [];
        for (const [key, pg] of this._groups) {
            if (key.startsWith(`${groupType}:`) && !pg.disposed) {
                result.push(pg);
            }
        }
        return result;
    },

    /** Get all commissioning groups */
    getCommissioningGroups() {
        return [...this._groups.values()].filter(g => !g.disposed && g.isCommissioning);
    },

    /** Dispose a specific group */
    dispose(groupType, groupId) {
        const key = `${groupType}:${groupId}`;
        const pg = this._groups.get(key);
        if (pg) {
            pg.dispose();
            this._groups.delete(key);
        }
    },

    /** Clear all groups */
    clear() {
        for (const pg of this._groups.values()) {
            if (!pg.disposed) pg.dispose();
        }
        this._groups.clear();
        MetricsCache.clear();
    },

    /** Get registry stats */
    getStats() {
        let active = 0, disposed = 0;
        for (const pg of this._groups.values()) {
            pg.disposed ? disposed++ : active++;
        }
        return { total: this._groups.size, active, disposed };
    }
};
window.ProjectGroupRegistry = ProjectGroupRegistry;

// Ensure global state exists before any references
window.cybereumState = window.cybereumState || {};

// Feature flags — set to true before loading schedule to enable
window.cybereumState.enableCommissioningNexus = window.cybereumState.enableCommissioningNexus || false;

// Debug logging — set to true for verbose console output
window.cybereumState.debug = window.cybereumState.debug ?? false;

function _log(...args) { if (window.cybereumState.debug) console.log(...args); }

_log('[CybereumDesign] v2.0 initialized with ProjectGroup model');

window.cybereumState.costEstimation = window.cybereumState.costEstimation || {
    isEstimating: false,
    currentEstimates: null,
    cbsData: null,
    controlAccounts: null,
    groupCBSData: {} // Store CBS data for each group
};

// ============================================================================
// CLEANUP REGISTRY - Enhanced with group-level cleanup and ProjectGroupRegistry
// ============================================================================
window.cybereumState.cleanupRegistry = window.cybereumState.cleanupRegistry || {
    listeners: [], observers: [], timers: [], graphCleanups: new Map(), tabCleanups: new Map(), groupCleanups: new Map(),
    addEventListener(el, t, h, o) { if (!el) return; el.addEventListener(t, h, o); this.listeners.push({ element: el, type: t, handler: h, options: o }); },
    addObserver(obs, tgt, cfg) { if (!obs || !tgt) return; obs.observe(tgt, cfg); this.observers.push({ observer: obs, target: tgt }); },
    addTimer(type, id) { this.timers.push({ type, id }); },
    setTimeout(fn, delay) { const id = setTimeout(fn, delay); this.addTimer('timeout', id); return id; },
    setInterval(fn, delay) { const id = setInterval(fn, delay); this.addTimer('interval', id); return id; },
    addGraphCleanup(gt, gid, fn) { const key = `${gt}:${gid}`; const existing = this.graphCleanups.get(key); if (existing) try { existing(); } catch (e) { } this.graphCleanups.set(key, fn); },
    addTabCleanup(tid, fn) { const existing = this.tabCleanups.get(tid); if (existing) try { existing(); } catch (e) { } this.tabCleanups.set(tid, fn); },
    addGroupCleanup(gt, gid, fn) { const key = `${gt}:${gid}`; if (!this.groupCleanups.has(key)) this.groupCleanups.set(key, new Set()); this.groupCleanups.get(key).add(fn); },
    cleanupTab(tid) { const c = this.tabCleanups.get(tid); if (c) { try { c(); } catch (e) { } this.tabCleanups.delete(tid); } },
    cleanupGraph(gt, gid) { const key = `${gt}:${gid}`; const c = this.graphCleanups.get(key); if (c) { try { c(); } catch (e) { } this.graphCleanups.delete(key); } },
    cleanupGroup(gt, gid) { const key = `${gt}:${gid}`; const cleanups = this.groupCleanups.get(key); if (cleanups) { cleanups.forEach(fn => { try { fn(); } catch (e) { } }); this.groupCleanups.delete(key); } this.cleanupGraph(gt, gid); if (window.ProjectGroupRegistry) window.ProjectGroupRegistry.dispose(gt, gid); },
    cleanupAll() { console.log('[Cleanup] Starting full cleanup...'); this.listeners.forEach(({ element: e, type: t, handler: h, options: o }) => { try { if (e && e.removeEventListener) e.removeEventListener(t, h, o); } catch (err) { } }); this.listeners = []; this.observers.forEach(({ observer: o }) => { try { if (o && o.disconnect) o.disconnect(); } catch (err) { } }); this.observers = []; this.timers.forEach(({ type: t, id: i }) => { try { t === 'timeout' ? clearTimeout(i) : clearInterval(i); } catch (err) { } }); this.timers = []; this.graphCleanups.forEach(c => { try { c(); } catch (err) { } }); this.graphCleanups.clear(); this.tabCleanups.forEach(c => { try { c(); } catch (err) { } }); this.tabCleanups.clear(); this.groupCleanups.forEach(cleanups => { cleanups.forEach(fn => { try { fn(); } catch (e) { } }); }); this.groupCleanups.clear(); if (window.ProjectGroupRegistry) window.ProjectGroupRegistry.clear(); if (window.MetricsCache) window.MetricsCache.clear(); console.log('[Cleanup] Complete'); },
    getStats() { return { listeners: this.listeners.length, observers: this.observers.length, timers: this.timers.length, graphs: this.graphCleanups.size, tabs: this.tabCleanups.size, groups: this.groupCleanups.size, projectGroups: window.ProjectGroupRegistry?.getStats() || {} }; }
};


// ============================================================================
// GROUPS STATE - Universal access to groups, activities, metrics, network analysis
// Enhanced with ProjectGroup integration
// ============================================================================
window.cybereumState.groups = window.cybereumState.groups || {
    // Group registry indexed by groupType then groupId
    WBS_ID: {},           // Work packages by WBS ID
    CommunityGroup: {},   // Community/work groups
    DependencyCluster: {}, // Dependency clusters

    // Quick lookup maps
    byId: new Map(),      // All groups by unique key (groupType:groupId)
    byNumber: new Map(),  // All groups by display number

    // Network metrics summary per groupType
    networkMetrics: {
        WBS_ID: null,
        CommunityGroup: null,
        DependencyCluster: null
    },

    // Helper methods
    getGroup(groupType, groupId) {
        return this[groupType]?.[groupId] || null;
    },

    getGroupByNumber(groupType, groupNumber) {
        const key = `${groupType}:${groupNumber}`;
        return this.byNumber.get(key) || null;
    },

    getAllGroups(groupType) {
        return Object.values(this[groupType] || {});
    },

    getGroupWithActivities(groupType, groupId) {
        const group = this.getGroup(groupType, groupId);
        if (!group) return null;
        return { ...group, activities: group.nodes || [] };
    },

    // NEW: Get or create ProjectGroup instance
    getProjectGroup(groupType, groupId) {
        return window.ProjectGroupRegistry?.getOrCreate(groupType, groupId) || null;
    },

    // NEW: Get all ProjectGroups for a type
    getAllProjectGroups(groupType) {
        return window.ProjectGroupRegistry?.getAll(groupType) || [];
    },

    // NEW: Get commissioning groups (any type with commissioning phase)
    getCommissioningGroups() {
        return window.ProjectGroupRegistry?.getCommissioningGroups() || [];
    },

    // Get groups formatted for AI/thinking model with network metrics
    getGroupsForAI(groupType) {
        return this.getAllGroups(groupType).map(g => ({
            id: g.id,
            groupNumber: g.groupNumber,
            name: g.name,
            activityCount: g.activityCount,
            metrics: g.metrics,
            networkMetrics: g.networkMetrics
        }));
    },

    // Clear all groups (call on new project load)
    clear() {
        // Clear ProjectGroupRegistry first
        if (window.ProjectGroupRegistry) window.ProjectGroupRegistry.clear();
        if (window.MetricsCache) window.MetricsCache.clear();

        this.WBS_ID = {};
        this.CommunityGroup = {};
        this.DependencyCluster = {};
        this.byId.clear();
        this.byNumber.clear();
        this.networkMetrics = { WBS_ID: null, CommunityGroup: null, DependencyCluster: null };

        // Clear cost estimation data
        if (window.cybereumState.costEstimation) {
            window.cybereumState.costEstimation.groupCBSData = {};
            window.cybereumState.costEstimation.currentEstimates = null;
            window.cybereumState.costEstimation.cbsData = null;
        }

        // Clear global estimates
        delete window._latestCBSEstimates;

        console.log('[CybereumState] Groups and cost data cleared');
    }
};

// Debug logging (after initialization)
_log('CommunityGroups.js v2.0 loaded - groups state initialized:', Object.keys(window.cybereumState.groups));
// ============================================================================
// CYBEREUM ANALYTICS STATE & SYNTHESIS PATCH
// Add this code to CommunityGroups.js after the existing window.cybereumState initialization (around line 77)
// ============================================================================

// ============================================================================
// ANALYTICS STATE MANAGEMENT - Track AI insights completion & store results
// ============================================================================
window.cybereumState.analytics = window.cybereumState.analytics || {
    // Individual group insights from WorkGroupInsights.fetch()
    groupInsights: {
        status: 'pending', // 'pending' | 'loading' | 'partial' | 'complete' | 'error'
        startTime: null,
        endTime: null,
        totalGroups: 0,
        completedGroups: 0,
        // NOTE: keys are composite "${groupType}:${groupId}" to prevent collisions across meta-group views.
        insights: {},      // Map of compositeKey -> insight object
        // Track totals per groupType to avoid overwriting global totals when multiple tabs are analyzed
        groupTypeTotals: {},
        errors: []
    },

    // Per-groupType group insights (prevents collisions and enables cross-view synthesis)
    groupInsightsByGroupType: {},

    // Project-level systems analysis from generateSystemsInsights()
    systemsAnalysis: {
        status: 'pending', // 'pending' | 'loading' | 'complete' | 'error'
        startTime: null,
        endTime: null,
        result: null,      // The full systems analysis response
        error: null
    },

    // Per-groupType portfolio analyses (multi-metagroup support)
    systemsAnalysisByGroupType: {},

    // If an analysis arrives before its tab content exists, store it here and render when tab loads
    pendingSystemsInsightsByGroupType: {},

    // Retry counters for delayed tab-content mounting (keyed by groupType)
    systemsInsightsRenderRetries: {},

    // Synthesized rollup combining both
    synthesis: {
        status: 'pending', // 'pending' | 'available' | 'loading' | 'complete' | 'error'
        startTime: null,
        endTime: null,
        result: null,      // The synthesized analysis
        error: null
    },

    // Helper methods
    isGroupInsightsComplete() {
        // Backward compatible (single-stream)
        if (this.groupInsights.status === 'complete') return true;
        if (this.groupInsights.status === 'partial' && this.groupInsights.totalGroups > 0 &&
            this.groupInsights.completedGroups >= this.groupInsights.totalGroups * 0.9) return true;

        // Multi-stream: if any groupType has a sufficiently-complete set, allow synthesis
        const trackers = this.groupInsightsByGroupType || {};
        for (const gt of Object.keys(trackers)) {
            const t = trackers[gt];
            if (!t) continue;
            if (t.status === 'complete') return true;
            if (t.status === 'partial' && t.totalGroups > 0 && t.completedGroups >= t.totalGroups * 0.9) return true;
        }
        return false;
    },

    isSystemsAnalysisComplete() {
        // Check both old single result and new per-groupType storage
        return this.systemsAnalysis.status === 'complete' ||
            (this.systemsAnalysisByGroupType && Object.keys(this.systemsAnalysisByGroupType).length > 0);
    },

    isSynthesisAvailable() {
        return this.isGroupInsightsComplete() && this.isSystemsAnalysisComplete();
    },

    // Update group insight (supports both legacy signature (groupId, insight) and new (groupType, groupId, insight))
    setGroupInsight(arg1, arg2, arg3) {
        const groupType = (typeof arg1 === 'string' && typeof arg2 === 'string') ? arg1 : null;
        const groupId = groupType ? arg2 : arg1;
        const insight = groupType ? arg3 : arg2;

        const safeGroupType = groupType || insight?.groupType || 'Unknown';
        const compositeKey = `${safeGroupType}:${groupId}`;

        // Ensure per-groupType tracker exists
        this.groupInsightsByGroupType = this.groupInsightsByGroupType || {};
        if (!this.groupInsightsByGroupType[safeGroupType]) {
            this.groupInsightsByGroupType[safeGroupType] = {
                status: 'partial', startTime: null, endTime: null,
                totalGroups: 0, completedGroups: 0, insights: {}, errors: []
            };
        }
        const tracker = this.groupInsightsByGroupType[safeGroupType];

        // Store insight with collision-safe keying
        const normalized = {
            ...insight,
            id: insight?.id ?? groupId,
            groupId: insight?.groupId ?? groupId,
            groupType: insight?.groupType ?? safeGroupType,
            receivedAt: new Date().toISOString()
        };

        this.groupInsights.insights[compositeKey] = normalized;
        tracker.insights[groupId] = normalized;

        // Update counts
        tracker.completedGroups = Object.keys(tracker.insights).length;
        this.groupInsights.completedGroups = Object.keys(this.groupInsights.insights).length;

        // Update status (per-groupType)
        if (tracker.totalGroups > 0 && tracker.completedGroups >= tracker.totalGroups) {
            tracker.status = 'complete';
            tracker.endTime = tracker.endTime || Date.now();
        } else if (tracker.completedGroups > 0) {
            tracker.status = 'partial';
        }

        // Update status (global aggregate)
        if (this.groupInsights.totalGroups > 0 && this.groupInsights.completedGroups >= this.groupInsights.totalGroups) {
            this.groupInsights.status = 'complete';
            this.groupInsights.endTime = Date.now();
        } else if (this.groupInsights.completedGroups > 0) {
            this.groupInsights.status = 'partial';
        }

        // Check if synthesis button should be enabled
        this.checkSynthesisAvailability();
    },

    // Update systems analysis
    setSystemsAnalysis(result) {
        this.systemsAnalysis.result = result;
        this.systemsAnalysis.status = 'complete';
        this.systemsAnalysis.endTime = Date.now();

        // Check if synthesis button should be enabled
        this.checkSynthesisAvailability();
    },

    // Check and update synthesis availability
    checkSynthesisAvailability() {
        if (this.isSynthesisAvailable() && this.synthesis.status === 'pending') {
            this.synthesis.status = 'available';
            const portfolioCount = this.systemsAnalysisByGroupType ? Object.keys(this.systemsAnalysisByGroupType).length : 0;
            // Dispatch event for UI updates
            window.dispatchEvent(new CustomEvent('cybereum:synthesisAvailable', {
                detail: {
                    groupInsightsCount: this.groupInsights.completedGroups,
                    systemsAnalysisPresent: !!this.systemsAnalysis.result,
                    portfolioAnalysesCount: portfolioCount,
                    portfolioGroupTypes: this.systemsAnalysisByGroupType ? Object.keys(this.systemsAnalysisByGroupType) : []
                }
            }));
        }
    },

    // Reset for new project
    reset() {
        this.groupInsights = {
            status: 'pending', startTime: null, endTime: null,
            totalGroups: 0, completedGroups: 0, insights: {}, groupTypeTotals: {}, errors: []
        };
        this.groupInsightsByGroupType = {};
        this.systemsAnalysis = {
            status: 'pending', startTime: null, endTime: null,
            result: null, error: null
        };
        this.systemsAnalysisByGroupType = {};
        this.pendingSystemsInsightsByGroupType = {};
        this.systemsInsightsRenderRetries = {};
        this.synthesis = {
            status: 'pending', startTime: null, endTime: null,
            result: null, error: null
        };
    },

    // Get timing info
    getTimingInfo() {
        const groupTime = this.groupInsights.endTime && this.groupInsights.startTime
            ? (this.groupInsights.endTime - this.groupInsights.startTime) / 1000
            : null;
        const systemsTime = this.systemsAnalysis.endTime && this.systemsAnalysis.startTime
            ? (this.systemsAnalysis.endTime - this.systemsAnalysis.startTime) / 1000
            : null;
        const synthesisTime = this.synthesis.endTime && this.synthesis.startTime
            ? (this.synthesis.endTime - this.synthesis.startTime) / 1000
            : null;

        return {
            groupInsights: groupTime ? `${groupTime.toFixed(1)}s` : 'pending',
            systemsAnalysis: systemsTime ? `${systemsTime.toFixed(1)}s` : 'pending',
            synthesis: synthesisTime ? `${synthesisTime.toFixed(1)}s` : 'pending'
        };
    }
};

_log('[CybereumState] Analytics state initialized');

function ensureAnalyticsState() {

    // If analytics is missing or malformed, recreate the minimum required surface
    let a = window.cybereumState.analytics;
    const needsInit =
        !a ||
        typeof a !== 'object' ||
        !a.groupInsights ||
        typeof a.setGroupInsight !== 'function' ||
        typeof a.setSystemsAnalysis !== 'function' ||
        typeof a.isSynthesisAvailable !== 'function' ||
        typeof a.getTimingInfo !== 'function';

    if (!needsInit) return a;

    // Preserve existing object if present, but backfill required fields/methods
    a = window.cybereumState.analytics = a && typeof a === 'object' ? a : {};

    a.groupInsights = a.groupInsights || {
        status: 'pending',
        startTime: null,
        endTime: null,
        totalGroups: 0,
        completedGroups: 0,
        insights: {},
        groupTypeTotals: {},
        errors: []
    };

    a.groupInsightsByGroupType = a.groupInsightsByGroupType || {};

    a.systemsAnalysis = a.systemsAnalysis || {
        status: 'pending',
        startTime: null,
        endTime: null,
        result: null,
        error: null
    };

    a.systemsAnalysisByGroupType = a.systemsAnalysisByGroupType || {};
    a.pendingSystemsInsightsByGroupType = a.pendingSystemsInsightsByGroupType || {};
    a.systemsInsightsRenderRetries = a.systemsInsightsRenderRetries || {};

    a.synthesis = a.synthesis || {
        status: 'pending',
        startTime: null,
        endTime: null,
        result: null,
        error: null
    };

    // Minimal compatibility methods (safe no-throw versions)
    a.isGroupInsightsComplete = a.isGroupInsightsComplete || function () {
        if (this.groupInsights?.status === 'complete') return true;
        const trackers = this.groupInsightsByGroupType || {};
        return Object.values(trackers).some(t => t && (t.status === 'complete' || (t.status === 'partial' && t.totalGroups > 0 && t.completedGroups >= t.totalGroups * 0.9)));
    };

    a.isSystemsAnalysisComplete = a.isSystemsAnalysisComplete || function () {
        return this.systemsAnalysis?.status === 'complete' ||
            (this.systemsAnalysisByGroupType && Object.keys(this.systemsAnalysisByGroupType).length > 0);
    };

    a.isSynthesisAvailable = a.isSynthesisAvailable || function () {
        return this.isGroupInsightsComplete() && this.isSystemsAnalysisComplete();
    };

    a.checkSynthesisAvailability = a.checkSynthesisAvailability || function () {
        // Don’t throw if UI listeners aren’t present
        try {
            if (this.isSynthesisAvailable() && this.synthesis?.status === 'pending') {
                this.synthesis.status = 'available';
                window.dispatchEvent(new CustomEvent('cybereum:synthesisAvailable', {
                    detail: {
                        groupInsightsCount: this.groupInsights?.completedGroups || 0,
                        systemsAnalysisPresent: !!this.systemsAnalysis?.result,
                        portfolioAnalysesCount: this.systemsAnalysisByGroupType ? Object.keys(this.systemsAnalysisByGroupType).length : 0,
                        portfolioGroupTypes: this.systemsAnalysisByGroupType ? Object.keys(this.systemsAnalysisByGroupType) : []
                    }
                }));
            }
        } catch (_) { /* noop */ }
    };

    a.setGroupInsight = a.setGroupInsight || function (groupType, groupId, insight) {
        const safeGroupType = groupType || insight?.groupType || 'Unknown';
        const compositeKey = `${safeGroupType}:${groupId}`;

        this.groupInsightsByGroupType = this.groupInsightsByGroupType || {};
        if (!this.groupInsightsByGroupType[safeGroupType]) {
            this.groupInsightsByGroupType[safeGroupType] = {
                status: 'partial',
                startTime: null,
                endTime: null,
                totalGroups: 0,
                completedGroups: 0,
                insights: {},
                errors: []
            };
        }
        const tracker = this.groupInsightsByGroupType[safeGroupType];

        const normalized = {
            ...insight,
            id: insight?.id ?? groupId,
            groupId: insight?.groupId ?? groupId,
            groupType: insight?.groupType ?? safeGroupType,
            receivedAt: new Date().toISOString()
        };

        this.groupInsights.insights[compositeKey] = normalized;
        tracker.insights[groupId] = normalized;

        tracker.completedGroups = Object.keys(tracker.insights).length;
        this.groupInsights.completedGroups = Object.keys(this.groupInsights.insights).length;

        this.checkSynthesisAvailability();
    };

    a.setSystemsAnalysis = a.setSystemsAnalysis || function (result) {
        this.systemsAnalysis = this.systemsAnalysis || {};
        this.systemsAnalysis.result = result;
        this.systemsAnalysis.status = 'complete';
        this.systemsAnalysis.endTime = Date.now();
        this.checkSynthesisAvailability();
    };

    a.getTimingInfo = a.getTimingInfo || function () {
        const gi = this.groupInsights;
        const sa = this.systemsAnalysis;
        const sy = this.synthesis;
        const fmt = (start, end) => (start && end) ? `${((end - start) / 1000).toFixed(1)}s` : 'pending';
        return {
            groupInsights: fmt(gi?.startTime, gi?.endTime),
            systemsAnalysis: fmt(sa?.startTime, sa?.endTime),
            synthesis: fmt(sy?.startTime, sy?.endTime)
        };
    };

    return a;
}


// ============================================================================
// WORK GROUP INSIGHTS TRACKER - Enhanced version with state tracking
// Replace or enhance the existing WorkGroupInsights implementation
// ============================================================================
window.WorkGroupInsights = window.WorkGroupInsights || {
    // Smaller batches + longer timeout improve completion rates for LLM-backed insights
    // on larger projects where request payloads can exceed the default latency budget.
    BATCH_SIZE: 2,
    TIMEOUT_MS: 120000,
    MAX_RETRIES: 3,

    async fetch(groupedNodes, groupNames, groupType, allNodes) {
        //const analytics = window.cybereumState.analytics;
        const analytics = ensureAnalyticsState();
        const groupIds = Object.keys(groupedNodes);

        // Initialize per-groupType tracking (prevents collisions across meta-group views)
        analytics.groupInsightsByGroupType = analytics.groupInsightsByGroupType || {};
        analytics.groupInsightsByGroupType[groupType] = {
            status: 'loading',
            startTime: Date.now(),
            endTime: null,
            totalGroups: groupIds.length,
            completedGroups: 0,
            insights: {},
            errors: []
        };

        // Maintain a global aggregate view without overwriting other meta-group runs
        analytics.groupInsights.status = 'loading';
        analytics.groupInsights.startTime = analytics.groupInsights.startTime || Date.now();
        analytics.groupInsights.groupTypeTotals = analytics.groupInsights.groupTypeTotals || {};
        analytics.groupInsights.groupTypeTotals[groupType] = groupIds.length;
        analytics.groupInsights.totalGroups = Object.values(analytics.groupInsights.groupTypeTotals).reduce((a, b) => a + (b || 0), 0);
        analytics.groupInsights.completedGroups = Object.keys(analytics.groupInsights.insights || {}).length;

        console.log(`[WorkGroupInsights] Starting analysis for ${groupIds.length} groups`);

        // Get project context
        const projectContext = this.buildProjectContext();

        // Process in batches
        const batches = [];
        for (let i = 0; i < groupIds.length; i += this.BATCH_SIZE) {
            batches.push(groupIds.slice(i, i + this.BATCH_SIZE));
        }

        _log(`[WorkGroupInsights] Processing ${batches.length} batches of ${this.BATCH_SIZE} groups`);

        // Process batches with controlled concurrency (1 at a time to avoid backend overload/timeouts)
        const CONCURRENT_BATCHES = 1;
        for (let i = 0; i < batches.length; i += CONCURRENT_BATCHES) {
            const batchPromises = batches.slice(i, i + CONCURRENT_BATCHES).map((batch, batchIndex) =>
                this.processBatch(batch, groupedNodes, groupNames, groupType, projectContext, i + batchIndex)
            );

            try {
                const results = await Promise.allSettled(batchPromises);

                results.forEach((result, idx) => {
                    if (result.status === 'fulfilled' && result.value) {
                        // Store successful insights
                        Object.entries(result.value).forEach(([groupId, insight]) => {
                            analytics.setGroupInsight(groupType, groupId, insight);
                            this.updateGroupUI(groupId, groupType, insight);

                            // Write semantic data back to cybereumState.groups for Nexus
                            const stateGroup = window.cybereumState?.groups?.[groupType]?.[groupId];
                            if (stateGroup) {
                                stateGroup.aiInsight = insight;
                                // Enrich detectedTags with AI understanding
                                if (insight.systemRole || insight.phase || insight.discipline) {
                                    stateGroup.detectedTags = stateGroup.detectedTags || {};
                                    if (insight.phase) stateGroup.detectedTags.phase = insight.phase;
                                    if (insight.discipline) stateGroup.detectedTags.discipline = insight.discipline;
                                    if (insight.systemRole) stateGroup.detectedTags.systemRole = insight.systemRole;
                                }
                            }
                        });
                    } else if (result.status === 'rejected') {
                        analytics.groupInsights.errors.push({
                            batchIndex: i + idx,
                            error: result.reason?.message || 'Unknown error'
                        });

                        // Track per-groupType errors
                        analytics.groupInsightsByGroupType[groupType]?.errors?.push({
                            batchIndex: i + idx,
                            error: result.reason?.message || 'Unknown error'
                        });

                        // Ensure the UI still receives insights for this batch even when AI request fails
                        const failedBatch = batches[i + idx] || [];
                        failedBatch.forEach(groupId => {
                            const fallbackInsight = this.buildFallbackInsight(groupId, groupedNodes, groupNames, groupType);
                            analytics.setGroupInsight(groupType, groupId, fallbackInsight);
                            this.updateGroupUI(groupId, groupType, fallbackInsight);
                        });
                    }
                });
            } catch (err) {
                console.error('[WorkGroupInsights] Batch processing error:', err);
            }
        }

        // Finalize status (per-groupType)
        const tracker = analytics.groupInsightsByGroupType[groupType];
        if (tracker) {
            tracker.completedGroups = Object.keys(tracker.insights || {}).length;
            if (tracker.completedGroups === tracker.totalGroups) tracker.status = 'complete';
            else if (tracker.completedGroups > 0) tracker.status = 'partial';
            else tracker.status = 'error';
            tracker.endTime = Date.now();
        }

        // Finalize status (global aggregate)
        const trackers = Object.values(analytics.groupInsightsByGroupType || {});
        if (trackers.length && trackers.every(t => t.status === 'complete')) {
            analytics.groupInsights.status = 'complete';
        } else if (analytics.groupInsights.completedGroups > 0) {
            analytics.groupInsights.status = 'partial';
        } else {
            analytics.groupInsights.status = 'error';
        }
        analytics.groupInsights.endTime = Date.now();

        const duration = ((analytics.groupInsights.endTime - analytics.groupInsights.startTime) / 1000).toFixed(1);
        const t = analytics.groupInsightsByGroupType?.[groupType];
        const perType = t ? `${t.completedGroups}/${t.totalGroups}` : `${analytics.groupInsights.completedGroups}/${analytics.groupInsights.totalGroups}`;
        console.log(`[WorkGroupInsights] Completed (${groupType}): ${perType} (global ${analytics.groupInsights.completedGroups}/${analytics.groupInsights.totalGroups}) in ${duration}s`);

        // Notify CommissioningNexus that semantic data is now available
        // Gated behind feature flag
        if (window.cybereumState?.enableCommissioningNexus &&
            window.CommissioningNexus?.onSemanticDataAvailable) {
            try {
                window.CommissioningNexus.onSemanticDataAvailable(groupType);
            } catch (e) {
                console.warn('[WorkGroupInsights] Nexus semantic update error:', e);
            }
        }

        return analytics.groupInsights.insights;
    },

    async processBatch(groupIds, groupedNodes, groupNames, groupType, projectContext, batchIndex) {
        const groups = groupIds.map(groupId => {
            const nodes = groupedNodes[groupId] || [];
            const nameInfo = groupNames[groupId] || {};
            const stateGroup = window.cybereumState.groups?.[groupType]?.[groupId];

            return {
                id: groupId,
                name: nameInfo.Name || `Group ${groupId}`,
                groupType: groupType,
                activityCount: nodes.length,
                metrics: stateGroup?.metrics || this.computeBasicMetrics(nodes),
                networkMetrics: stateGroup?.networkMetrics || null,
                detectedTags: this.detectTags(nameInfo, nodes),
                sampleActivities: this.getSampleActivities(nodes, 3)
            };
        });

        const payload = {
            project: projectContext,
            groups: groups
        };

        let lastError = null;

        for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

            try {
                const response = await fetch('/OpenAI/GenerateGroupInsightsBatch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
                }

                const result = await response.json();
                const insights = {};

                if (result.insights && Array.isArray(result.insights)) {
                    result.insights.forEach(insight => {
                        insights[insight.id] = insight;
                    });
                }

                clearTimeout(timeoutId);
                return insights;
            } catch (err) {
                clearTimeout(timeoutId);
                lastError = err;
                const isAbort = err?.name === 'AbortError';
                const message = isAbort ? 'request timeout' : (err?.message || String(err));
                console.warn(`[WorkGroupInsights] Batch ${batchIndex} attempt ${attempt + 1}/${this.MAX_RETRIES + 1} failed: ${message}`);

                if (attempt < this.MAX_RETRIES) {
                    const backoffMs = 900 * (attempt + 1);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                }
            }
        }

        console.error(`[WorkGroupInsights] Batch ${batchIndex} failed:`, lastError);
        throw lastError || new Error('Unknown insights batch failure');
    },

    buildFallbackInsight(groupId, groupedNodes, groupNames, groupType) {
        const nodes = groupedNodes[groupId] || [];
        const metrics = this.computeBasicMetrics(nodes);
        const name = groupNames[groupId]?.Name || `Group ${groupId}`;
        const isRisky = (metrics.behindScheduleCount || 0) > 0 || (metrics.criticalCount || 0) > 0;
        const progressValue = Number.isFinite(metrics.progress) ? metrics.progress : 0;
        const progress = Math.round(progressValue);

        const summary = isRisky
            ? `${name} is showing schedule pressure with ${metrics.behindScheduleCount || 0} delayed activities and ${metrics.criticalCount || 0} critical-path activities.`
            : `${name} is progressing with stable execution characteristics and no immediate schedule pressure signals.`;

        return {
            id: groupId,
            groupId,
            groupType,
            confidence: 0.35,
            summary,
            keyRisk: isRisky ? 'Monitor delayed and critical-path work to avoid slippage.' : 'No material risk detected from local metrics.',
            action: isRisky ? 'Prioritize recovery actions for delayed and near-critical activities.' : 'Continue monitoring while preserving current execution rhythm.',
            progress,
            isFallback: true
        };
    },

    buildProjectContext() {
        return {
            name: window.cybereumState.projectName || document.title || 'Project',
            sector: window.cybereumState.sector || 'General',
            region: window.cybereumState.region || '',
            country: window.cybereumState.country || '',
            dataDate: window.cybereumState.dataDate?.toISOString?.() || new Date().toISOString(),
            modelHint: 'fast' // Use GPT-4o for individual group insights (speed)
        };
    },

    computeBasicMetrics(nodes) {
        if (!nodes?.length) return {};

        let criticalCount = 0, totalProgress = 0, behindCount = 0;

        nodes.forEach(n => {
            if (n.isOnCriticalPath) criticalCount++;
            totalProgress += parseFloat(n.PercentComplete) || 0;
            if (n.IsDelayed || parseFloat(n.TotalSlack) < 0) behindCount++;
        });

        return {
            activityCount: nodes.length,
            criticalCount,
            nearCriticalCount: nodes.filter(n => n.isOnOutlierPath && !n.isOnCriticalPath).length,
            progress: totalProgress / nodes.length,
            behindScheduleCount: behindCount,
            healthScore: Math.max(0, 100 - (behindCount / nodes.length * 30) - (criticalCount / nodes.length * 10))
        };
    },

    detectTags(nameInfo, nodes) {
        const name = (nameInfo.Name || '').toLowerCase();
        const path = (nameInfo.Description || nameInfo.WBS_Path || '').toLowerCase();
        const combined = `${name} ${path}`;

        const normalizePhaseLabel = (rawPhase) => {
            const p = (rawPhase || '').toString().trim().toLowerCase();
            if (!p || p === 'other') return null;
            if (p.includes('pre') && p.includes('comm')) return 'Pre-Commissioning';
            if (p.includes('commission')) return 'Commissioning';
            if (p.includes('project controls') || p.includes('milestone') || p.includes('schedule control')) return 'Project Controls / Milestones';
            if (p.includes('planning') || p.includes('project management')) return 'Planning';
            if (p.includes('operations') || p.includes('handover') || p.includes('turnover')) return 'Operations / Handover';
            if (p.includes('engineer')) return 'Engineering';
            if (p.includes('procure') || p.includes('purchas')) return 'Procurement';
            if (p.includes('fabricat') || p.includes('manufactur')) return 'Fabrication';
            if (p.includes('construct') || p.includes('install')) return 'Construction';
            if (p.includes('test') || p.includes('qa') || p.includes('qc') || p.includes('inspect')) return 'Testing';
            return null;
        };

        // Phase: prefer ActivityPhaseClassifier output (per-node majority vote)
        let phase = null;
        if (Array.isArray(nodes) && nodes.length > 0) {
            const phaseCounts = {};
            for (const n of nodes) {
                const ap = normalizePhaseLabel(n?.ActivityPhase) || n?.ActivityPhase;
                if (ap && ap !== 'Other') {
                    phaseCounts[ap] = (phaseCounts[ap] || 0) + 1;
                }
            }
            const sorted = Object.entries(phaseCounts).sort((a, b) => b[1] - a[1]);
            const precomCount = phaseCounts['Pre-Commissioning'] || 0;
            const commCount = phaseCounts['Commissioning'] || 0;
            const commissioningShare = (precomCount + commCount) / nodes.length;

            // Keep late-stage commissioning visible in mixed groups.
            if (commissioningShare >= 0.15 && (precomCount + commCount) >= 2) {
                phase = precomCount >= commCount ? 'Pre-Commissioning' : 'Commissioning';
            } else if (sorted.length > 0 && sorted[0][1] >= nodes.length * 0.20) {
                phase = sorted[0][0]; // dominant phase (>=20% of nodes)
            }
        }

        // Fallback: regex on group name/path (only if classifier didn't provide)
        if (!phase) {
            const phases = {
                'Planning': /planning|project management|pm plan|master plan|execution plan|baseline|schedule update|look-?ahead|evm|earned value|progress report|controls/i,
                'Engineering': /engineering|design|feed|detail/i,
                'Procurement': /procurement|purchas|order|vendor|supplier/i,
                'Fabrication': /fabricat|manufacture|assembly|shop/i,
                'Construction': /construct|install|erect|build|civil/i,
                'Testing': /test|inspect|check|qc|qa/i,
                'Pre-Commissioning': /pre-?comm|precomm|loop|flush|clean|blow|megger|calibrat|walkdown|line check|leak test|pressure test/i,
                'Commissioning': /commission|start-?up|rfsu|ready for start|ready for startup|performance test|huc|handover|turnover/i,
                'Project Controls / Milestones': /project controls?|controls?|milestone|schedule|s-curve|critical path|forecast|reporting/i,
                'Operations / Handover': /operations?|o&m|closeout|as-?built|training|turnover package|cod|pac|fac/i
            };
            for (const [p, regex] of Object.entries(phases)) {
                if (regex.test(combined)) { phase = p; break; }
            }
        }

        // Discipline: regex-based (ActivityPhaseClassifier doesn't assign discipline)
        let discipline = null;
        const disciplines = {
            'Civil': /civil|concrete|foundation|excavat|piling|earthwork/i,
            'Structural': /structural|steel|beam|column|frame|erect/i,
            'Mechanical': /mechanical|mech|hvac|piping|vessel|pump|compressor/i,
            'Electrical': /electrical|elec|power|cable|substation|transformer/i,
            'Piping': /piping|pipe|valve|fitting|weld|hydrotest/i,
            'Instrumentation': /instrument|i&c|control|dcs|plc|sensor/i,
            'Process': /process|unit|reactor|distill|separation/i
        };
        for (const [d, regex] of Object.entries(disciplines)) {
            if (regex.test(combined)) { discipline = d; break; }
        }

        return {
            discipline,
            phase,
            workPackageType: /awp|iwp/i.test(combined) ? 'AWP' : null,
            functionalBackbone: null // Let AI determine this
        };
    },

    getSampleActivities(nodes, count) {
        // Prioritize: critical -> near-critical -> high-risk -> by progress
        const sorted = [...nodes].sort((a, b) => {
            if (a.isOnCriticalPath && !b.isOnCriticalPath) return -1;
            if (!a.isOnCriticalPath && b.isOnCriticalPath) return 1;
            if (a.isOnOutlierPath && !b.isOnOutlierPath) return -1;
            if (!a.isOnOutlierPath && b.isOnOutlierPath) return 1;
            const riskA = parseFloat(a.riskScore) || 0;
            const riskB = parseFloat(b.riskScore) || 0;
            if (riskA !== riskB) return riskB - riskA;
            return (parseFloat(a.PercentComplete) || 0) - (parseFloat(b.PercentComplete) || 0);
        });

        return sorted.slice(0, count).map(n => ({
            id: n.ID,
            name: n.Name,
            percentComplete: parseFloat(n.PercentComplete) || 0,
            isCritical: !!n.isOnCriticalPath,
            isNearCritical: !!n.isOnOutlierPath,
            riskScore: parseFloat(n.riskScore) || 0,
            slack: parseFloat(n.slack) || parseFloat(n.TotalSlack) || 0
        }));
    },

    updateGroupUI(groupId, groupType, insight) {
        const container = document.getElementById(`insights-${groupType}-${groupId}`);
        if (!container) {
            // Container not yet created (lazy rendering - group is collapsed).
            // Cache the insight so it renders on first expand.
            this._pendingGroupInsights = this._pendingGroupInsights || {};
            this._pendingGroupInsights[`${groupType}:${groupId}`] = { groupId, groupType, insight };
            return;
        }

        // Build HTML from insight
        const html = this.buildInsightHTML(insight);
        container.innerHTML = html;
        container.classList.add('insights-loaded');
    },

    /** Called by lazy-render when a group is first expanded - applies cached insight if available. */
    applyDeferredInsight(groupId, groupType) {
        const key = `${groupType}:${groupId}`;
        const pending = this._pendingGroupInsights?.[key];
        if (!pending) return;
        delete this._pendingGroupInsights[key];
        this.updateGroupUI(pending.groupId, pending.groupType, pending.insight);
    },

    buildInsightHTML(insight) {
        if (!insight) return '<div class="insight-error">Analysis unavailable</div>';

        const roleColor = insight.systemRole?.includes('Bridge') || insight.systemRole?.includes('Hub')
            ? '#ffb86c' : '#8ce6ff';

        return `
            <div class="wg-insight-card" style="display:flex;flex-direction:column;gap:8px;">
                <div class="insight-role" style="color:${roleColor};font-weight:bold;font-size:13px;">
                    🎯 ${insight.systemRole || 'Role analysis pending'}
                </div>
                ${insight.criticalPathPosition ? `
                <div class="insight-critical" style="color:#ff5555;font-size:12px;">
                    ⚠️ ${insight.criticalPathPosition}
                </div>` : ''}
                ${insight.trajectoryAssessment ? `
                <div class="insight-trajectory" style="color:#8be9fd;font-size:12px;">
                    📈 ${insight.trajectoryAssessment}
                </div>` : ''}
                ${insight.keyRisk ? `
                <div class="insight-risk" style="color:#ffb86c;font-size:12px;">
                    🔥 ${insight.keyRisk}
                </div>` : ''}
                ${insight.actionableInsight ? `
                <div class="insight-action" style="color:#50fa7b;font-size:12px;font-style:italic;">
                    💡 ${insight.actionableInsight}
                </div>` : ''}
            </div>
        `;
    }
};


// ============================================================================
// SYSTEMS INSIGHTS GENERATOR - Enhanced with state tracking
// Replace or enhance the existing generateSystemsInsights function
// ============================================================================
async function generateSystemsInsights(groupData, groupedNodes, groupType, allNodes) {
    // FIX v2.1: If Projectsystemsinsights.js is loaded, delegate to avoid duplicate AI calls
    if (typeof window.generateSystemsInsightsV3 === 'function') {
        _log(`[SystemsInsights] Delegating ${groupType} to Projectsystemsinsights.js v3.1`);
        try {
            return await window.generateSystemsInsightsV3(groupData, groupedNodes, groupType, allNodes);
        } catch (e) {
            console.warn(`[SystemsInsights] Delegation failed, falling back to local:`, e.message);
        }
    }

    //const analytics = window.cybereumState.analytics;
    const analytics = ensureAnalyticsState();

    // Initialize tracking
    analytics.systemsAnalysis.status = 'loading';
    analytics.systemsAnalysis.startTime = Date.now();

    console.log(`[SystemsInsights] Starting ${groupType} portfolio-level analysis (local)`);

    try {
        // Build portfolio summary for thinking model
        const portfolioSummary = buildPortfolioSummary(groupData, groupedNodes, groupType);

        const payload = {
            project: {
                name: window.cybereumState.projectName || 'Project',
                sector: window.cybereumState.sector || 'General',
                region: window.cybereumState.region || '',
                country: window.cybereumState.country || '',
                totalActivities: allNodes?.length || 0,
                dataDate: window.cybereumState.dataDate?.toISOString?.() || new Date().toISOString()
            },
            portfolio: portfolioSummary,
            groupType: groupType,
            networkMetrics: window.cybereumState.groups?.networkMetrics?.[groupType] || null,
            modelHint: 'thinking' // Use thinking model for deeper analysis
        };

        const response = await fetch('/OpenAI/GeneratePortfolioInsights', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const result = await response.json();

        // Store per-groupType for multi-metagroup support FIRST (so availability events can include correct counts)
        if (!analytics.systemsAnalysisByGroupType) {
            analytics.systemsAnalysisByGroupType = {};
        }
        analytics.systemsAnalysisByGroupType[groupType] = result;

        // Store in state (main tracker for backward compat)
        analytics.setSystemsAnalysis(result);

        // Update UI - pass groupType so it inserts into correct tab
        updateSystemsInsightsUI(result, groupType);

        console.log(`[SystemsInsights] ${groupType} analysis complete`);
        return result;

    } catch (err) {
        console.error(`[SystemsInsights] ${groupType} Error:`, err);
        analytics.systemsAnalysis.status = 'error';
        analytics.systemsAnalysis.error = err.message;
        analytics.systemsAnalysis.endTime = Date.now();
        throw err;
    }
}

function buildPortfolioSummary(groupData, groupedNodes, groupType) {
    const nameLookup = window.cybereumState?.projectAnalysis?.groupNameLookup || {};
    return groupData.map(g => ({
        id: g.GroupID,
        name: nameLookup[g.GroupID] || g.GroupName,
        groupType: groupType,
        activityCount: g.NumberOfActivities,
        healthScore: g.HealthScore,
        progress: parseFloat(g.OverallProgress),
        criticalCount: g.CriticalTaskCount,
        nearCriticalCount: g.NearCriticalCount,
        behindScheduleCount: g.BehindScheduleCount,
        minFloat: g.MinFloat,
        riskScore: g.RiskScore,
        wbsPath: g.WBSPath || null,
        networkRole: window.cybereumState.groups?.[groupType]?.[g.GroupID]?.networkMetrics?.networkRole || null,
        betweenness: window.cybereumState.groups?.[groupType]?.[g.GroupID]?.networkMetrics?.betweennessCentrality || null
    }));
}

function updateSystemsInsightsUI(result, groupType) {
    const analytics = window.cybereumState?.analytics;
    if (!analytics) return;

    const containerId = `systems-insights-container-${groupType}`;

    const findTabContent = () => {
        // Prefer tab content divs explicitly tagged with groupType
        let resolved = document.querySelector(`.cyb-group-tab-content[data-group-type="${groupType}"]`);

        // Fallback to legacy IDs (older DOMs)
        if (!resolved) {
            const tabIdMap = {
                'CommunityGroup': 'community-tab-content',
                'DependencyCluster': 'dependency-tab-content',
                'WBS_ID': 'wbs-tab-content'
            };
            const tabContentId = tabIdMap[groupType];
            if (tabContentId) resolved = document.getElementById(tabContentId);
        }

        return resolved;
    };

    let tabContent = findTabContent();

    // If the tab isn't loaded yet, store it and render when the tab is created
    if (!tabContent) {
        console.info(`[SystemsInsightsUI] Tab content for ${groupType} not found yet - caching and retrying render`);
        analytics.pendingSystemsInsightsByGroupType = analytics.pendingSystemsInsightsByGroupType || {};
        analytics.pendingSystemsInsightsByGroupType[groupType] = result;

        // Self-heal: if tab content appears shortly after async render completion,
        // apply pending insights automatically without requiring a manual tab switch.
        analytics.systemsInsightsRenderRetries = analytics.systemsInsightsRenderRetries || {};
        const retryCount = analytics.systemsInsightsRenderRetries[groupType] || 0;
        const maxRetries = 8;
        if (retryCount < maxRetries) {
            analytics.systemsInsightsRenderRetries[groupType] = retryCount + 1;
            setTimeout(() => {
                const retryTabContent = findTabContent();
                if (retryTabContent) {
                    analytics.systemsInsightsRenderRetries[groupType] = 0;
                    const pending = analytics.pendingSystemsInsightsByGroupType?.[groupType];
                    if (pending) {
                        updateSystemsInsightsUI(pending, groupType);
                        delete analytics.pendingSystemsInsightsByGroupType[groupType];
                    }
                }
            }, 350 * (retryCount + 1));
        }

        return;
    }

    if (analytics.systemsInsightsRenderRetries) {
        analytics.systemsInsightsRenderRetries[groupType] = 0;
    }

    // Find or create the systems insights container
    let container = document.getElementById(containerId);
    if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        container.style.cssText = `
            background: linear-gradient(135deg, rgba(16,45,80,0.95), rgba(13,33,55,0.98));
            border: 2px solid rgba(90,200,250,0.4);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 25px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        `;
    }

    // Ensure the container is placed under the correct tab content (avoid cross-tab leakage)
    if (!tabContent.contains(container)) {
        // If it exists elsewhere, move it.
        if (container.parentNode) {
            try { container.parentNode.removeChild(container); } catch (_) { /* noop */ }
        }
    }

    // Insert container immediately after the correct Gantt for this meta-group (or at top of tab as fallback)
    const ganttSelector = `#${String(groupType).toLowerCase()}-gantt-chart-div`;
    const ganttEl = tabContent.querySelector(ganttSelector);

    if (ganttEl && ganttEl.parentNode) {
        if (ganttEl.nextSibling !== container) {
            ganttEl.parentNode.insertBefore(container, ganttEl.nextSibling);
        }
    } else {
        if (tabContent.firstChild !== container) {
            tabContent.insertBefore(container, tabContent.firstChild);
        }
    }

    // Render analysis
    container.innerHTML = buildSystemsInsightsHTML(result, groupType);

    // Add synthesis button if available
    if (analytics.isSynthesisAvailable()) {
        addSynthesisButton(container, groupType);
    }
}

function buildSystemsInsightsHTML(result, groupType) {
    if (!result) return '<div style="color:#8ce6ff;">Systems analysis loading...</div>';

    const groupTypeLabel = groupType === 'CommunityGroup' ? 'Work Groups' :
        groupType === 'DependencyCluster' ? 'Dependency Clusters' :
            groupType === 'WBS_ID' ? 'WBS' : 'Portfolio';

    return `
        <div class="systems-insights">
            <h3 style="color:#5ac8fa;margin:0 0 15px 0;font-family:'Orbitron',sans-serif;display:flex;align-items:center;gap:10px;">
                🧠 ${groupTypeLabel} Portfolio Analysis
                <span style="font-size:11px;color:#8be9fd;font-family:Arial;">(${window.cybereumState.analytics.getTimingInfo().systemsAnalysis})</span>
            </h3>
            
            ${result.aiNarrative ? `
            <div class="ai-narrative" style="color:#cdfaff;line-height:1.6;margin-bottom:20px;padding:15px;background:rgba(0,0,0,0.2);border-radius:8px;">
                ${result.aiNarrative.replace(/\n/g, '<br>')}
            </div>` : ''}
            
            ${result.aiBackbones && result.aiBackbones.length > 0 ? `
            <div class="ai-backbones" style="margin-bottom:20px;">
                <h4 style="color:#ffb86c;margin:0 0 10px 0;">🔗 Functional Backbones</h4>
                <div style="display:flex;flex-wrap:wrap;gap:10px;">
                    ${result.aiBackbones.map(b => `
                        <div style="flex:1;min-width:280px;background:rgba(255,184,108,0.1);border:1px solid rgba(255,184,108,0.3);border-radius:8px;padding:12px;">
                            <div style="color:#ffb86c;font-weight:bold;margin-bottom:5px;">${b.name}</div>
                            <div style="color:#8be9fd;font-size:12px;margin-bottom:5px;">${b.role}</div>
                            ${b.networkLeverage ? `<div style="color:#50fa7b;font-size:11px;">📊 ${b.networkLeverage}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}
            
            ${result.aiGovernanceMoves && result.aiGovernanceMoves.length > 0 ? `
            <div class="ai-governance" style="margin-bottom:15px;">
                <h4 style="color:#50fa7b;margin:0 0 10px 0;">🎯 Governance Moves</h4>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    ${result.aiGovernanceMoves.slice(0, 5).map((m, i) => `
                        <div style="display:flex;gap:10px;align-items:flex-start;padding:10px;background:rgba(80,250,123,0.05);border-left:3px solid #50fa7b;border-radius:0 4px 4px 0;">
                            <span style="color:#50fa7b;font-weight:bold;min-width:20px;">${i + 1}.</span>
                            <div>
                                <div style="color:#cdfaff;font-weight:bold;">${m.title}</div>
                                <div style="color:#8be9fd;font-size:12px;margin-top:3px;">${m.detail}</div>
                                ${m.timing ? `<div style="color:#ffb86c;font-size:11px;margin-top:3px;">⏱ ${m.timing}</div>` : ''}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}
            
            <div id="synthesis-button-container-${groupType}" style="margin-top:15px;border-top:1px solid rgba(90,200,250,0.2);padding-top:15px;"></div>
        </div>
    `;
}


// ============================================================================
// SYNTHESIS FUNCTIONALITY - Combines group insights + systems analysis
// ============================================================================
function addSynthesisButton(container, groupType) {
    // Find the groupType-specific button container, or use the container itself
    const btnContainerId = groupType ? `synthesis-button-container-${groupType}` : 'synthesis-button-container';
    const btnContainer = container.querySelector(`#${btnContainerId}`) || container.querySelector('#synthesis-button-container') || container;

    //const analytics = window.cybereumState.analytics;
    const analytics = ensureAnalyticsState();

    const groupCount = analytics.groupInsights.completedGroups;

    // Count how many portfolio analyses we have
    const portfolioCount = analytics.systemsAnalysisByGroupType ? Object.keys(analytics.systemsAnalysisByGroupType).length : 0;
    const portfolioTypes = analytics.systemsAnalysisByGroupType ?
        Object.keys(analytics.systemsAnalysisByGroupType).map(gt =>
            gt === 'CommunityGroup' ? 'Work Groups' :
                gt === 'DependencyCluster' ? 'Dep. Clusters' :
                    gt === 'WBS_ID' ? 'WBS' : gt
        ).join(' + ') : '';

    const suffix = String(groupType || 'global').replace(/[^a-z0-9_-]/gi, '-');
    const btnId = `generate-synthesis-btn-${suffix}`;
    const resultId = `synthesis-result-container-${suffix}`;

    btnContainer.innerHTML = `
        <div style="display:flex;align-items:center;gap:15px;flex-wrap:wrap;">
            <button id="${btnId}" data-cyb-synthesis-btn="true" style="
                background: linear-gradient(135deg, #bd93f9, #ff79c6);
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                cursor: pointer;
                font-weight: bold;
                font-size: 14px;
                display: flex;
                align-items: center;
                gap: 8px;
                transition: all 0.2s ease;
                box-shadow: 0 4px 15px rgba(189,147,249,0.3);
            " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 20px rgba(189,147,249,0.4)'"
               onmouseout="this.style.transform='translateY(0)';this.style.boxShadow='0 4px 15px rgba(189,147,249,0.3)'">
                ✨ Generate Executive Synthesis
            </button>
            <div style="color:#8be9fd;font-size:12px;">
                Ready: ${groupCount} group insights + ${portfolioCount} portfolio${portfolioCount !== 1 ? 's' : ''} (${portfolioTypes || 'pending'})
            </div>
        </div>
        <div id="${resultId}" style="margin-top:15px;display:none;"></div>
    `;

    // Bind within the container (avoid collisions across tabs)
    const btn = btnContainer.querySelector(`#${btnId}`);
    if (btn) {
        btn.addEventListener('click', () => generateSynthesis(groupType));
    }
}

async function generateSynthesis(groupType) {
    const suffix = String(groupType || 'global').replace(/[^a-z0-9_-]/gi, '-');
    const btn = document.getElementById(`generate-synthesis-btn-${suffix}`) || document.querySelector('[data-cyb-synthesis-btn="true"]');
    const resultContainer = document.getElementById(`synthesis-result-container-${suffix}`);
    //const analytics = window.cybereumState.analytics;
    const analytics = ensureAnalyticsState();

    if (!btn || !resultContainer) {
        console.warn('[Synthesis] UI elements not found for groupType:', groupType);
        return;
    }

    // Update button state
    btn.disabled = true;
    btn.innerHTML = '⏳ Generating synthesis...';
    btn.style.background = 'linear-gradient(135deg, #6c757d, #495057)';

    analytics.synthesis.status = 'loading';
    analytics.synthesis.startTime = Date.now();

    try {
        // Collect ALL portfolio analyses from ALL groupTypes
        const allSystemsAnalyses = analytics.systemsAnalysisByGroupType || {};
        const groupTypesIncluded = Object.keys(allSystemsAnalyses);

        _log(`[Synthesis] Building payload with ${groupTypesIncluded.length} portfolio analyses:`, groupTypesIncluded);

        // Build synthesis payload with ALL data
        const payload = {
            project: {
                name: window.cybereumState.projectName || 'Project',
                sector: window.cybereumState.sector || 'General',
                region: window.cybereumState.region || '',
                country: window.cybereumState.country || ''
            },
            groupInsights: Object.values(analytics.groupInsights.insights || {}),
            // All portfolio analyses keyed by groupType (new)
            systemsAnalyses: allSystemsAnalyses,
            // Backward compat - send first available
            systemsAnalysis: Object.values(allSystemsAnalyses)[0] || analytics.systemsAnalysis.result,
            networkMetrics: window.cybereumState.groups?.networkMetrics || {},
            groupTypesIncluded: groupTypesIncluded,
            modelHint: 'thinking' // Use thinking model for synthesis
        };

        const response = await fetch('/OpenAI/GenerateInsightsSynthesis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const result = await response.json();

        // Store result
        analytics.synthesis.result = result;
        analytics.synthesis.status = 'complete';
        analytics.synthesis.endTime = Date.now();

        // Display result
        resultContainer.style.display = 'block';
        resultContainer.innerHTML = buildSynthesisHTML(result);

        // Update button
        btn.innerHTML = '✅ Synthesis Complete';
        btn.style.background = 'linear-gradient(135deg, #50fa7b, #22b573)';

        console.log('[Synthesis] Complete in', analytics.getTimingInfo().synthesis);

    } catch (err) {
        console.error('[Synthesis] Error:', err);
        analytics.synthesis.status = 'error';
        analytics.synthesis.error = err.message;
        analytics.synthesis.endTime = Date.now();

        btn.innerHTML = '❌ Synthesis Failed - Click to Retry';
        btn.style.background = 'linear-gradient(135deg, #ff5555, #cc4444)';
        btn.disabled = false;

        resultContainer.style.display = 'block';
        resultContainer.innerHTML = `
            <div style="color:#ff5555;padding:15px;background:rgba(255,85,85,0.1);border-radius:8px;">
                ⚠️ Synthesis failed: ${err.message}
            </div>
        `;
    }
}

function buildSynthesisHTML(result) {
    if (!result) return '';

    const analytics = ensureAnalyticsState();
    const portfolioTypes = analytics.systemsAnalysisByGroupType
        ? Object.keys(analytics.systemsAnalysisByGroupType).map(gt =>
            gt === 'CommunityGroup' ? 'Work Groups' : gt === 'DependencyCluster' ? 'Dep. Clusters' : gt === 'WBS_ID' ? 'WBS' : gt
        ).join(' + ') : 'Portfolio';
    const groupCount = analytics.groupInsights.completedGroups || 0;
    const timingStr = analytics.getTimingInfo ? analytics.getTimingInfo().synthesis : '';

    // Handle varied AI response field names gracefully
    const summary = result.executiveSummary || result.executive_summary || result.summary || '';
    const findings = result.criticalFindings || result.critical_findings || result.findings || [];
    const bottlenecks = result.structuralBottlenecks || result.structural_bottlenecks || result.bottlenecks || [];
    const actions = result.immediateActions || result.immediate_actions || result.actions || result.recommendations || [];
    const crossGroupPatterns = result.crossGroupPatterns || result.cross_group_patterns || result.patterns || [];

    return `
        <div class="synthesis-result" style="background:linear-gradient(135deg,rgba(189,147,249,0.08),rgba(255,121,198,0.08));border:2px solid rgba(189,147,249,0.4);border-radius:12px;padding:24px;margin:15px 0;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:8px;">
                <h3 style="color:#bd93f9;margin:0;font-family:'Orbitron',sans-serif;font-size:16px;display:flex;align-items:center;gap:10px;">
                    ✨ Cross-Group Executive Synthesis
                </h3>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:10px;padding:3px 8px;background:rgba(189,147,249,0.15);border:1px solid rgba(189,147,249,0.3);border-radius:4px;color:#bd93f9;">
                        ${portfolioTypes}
                    </span>
                    <span style="font-size:10px;padding:3px 8px;background:rgba(139,233,253,0.1);border:1px solid rgba(139,233,253,0.2);border-radius:4px;color:#8be9fd;">
                        ${groupCount} groups analyzed
                    </span>
                    ${timingStr ? `<span style="font-size:10px;padding:3px 8px;background:rgba(255,255,255,0.05);border-radius:4px;color:#6c7a89;">${timingStr}</span>` : ''}
                </div>
            </div>
            
            ${summary ? `
            <div style="color:#cdfaff;line-height:1.7;margin-bottom:20px;padding:15px;background:rgba(0,0,0,0.2);border-radius:8px;font-size:13px;">
                ${String(summary).replace(/\n/g, '<br>')}
            </div>` : ''}
            
            ${findings.length > 0 ? `
            <div style="margin-bottom:20px;">
                <h4 style="color:#ff5555;margin:0 0 10px 0;font-size:13px;">🚨 Critical Findings</h4>
                ${findings.map(f => {
        const title = f.title || f.finding || (typeof f === 'string' ? f : '');
        return `
                    <div style="padding:10px 12px;margin-bottom:8px;background:rgba(255,85,85,0.08);border-left:3px solid #ff5555;border-radius:0 6px 6px 0;">
                        <div style="color:#ff6b6b;font-weight:600;font-size:13px;">${title}</div>
                        ${f.impact ? `<div style="color:#ffb86c;font-size:12px;margin-top:5px;">⚠ Impact: ${f.impact}</div>` : ''}
                        ${f.recommendation ? `<div style="color:#50fa7b;font-size:12px;margin-top:3px;">→ ${f.recommendation}</div>` : ''}
                        ${f.affectedGroups ? `<div style="color:#8be9fd;font-size:11px;margin-top:3px;">Groups: ${Array.isArray(f.affectedGroups) ? f.affectedGroups.join(', ') : f.affectedGroups}</div>` : ''}
                    </div>`;
    }).join('')}
            </div>` : ''}
            
            ${crossGroupPatterns.length > 0 ? `
            <div style="margin-bottom:20px;">
                <h4 style="color:#8be9fd;margin:0 0 10px 0;font-size:13px;">🔄 Cross-Group Patterns</h4>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    ${crossGroupPatterns.map(p => {
        const name = p.pattern || p.name || p.title || (typeof p === 'string' ? p : '');
        return `
                        <div style="padding:10px 12px;background:rgba(139,233,253,0.06);border-left:3px solid #8be9fd;border-radius:0 6px 6px 0;">
                            <div style="color:#8be9fd;font-weight:600;font-size:12px;">${name}</div>
                            ${p.description || p.detail ? `<div style="color:#cdfaff;font-size:12px;margin-top:4px;">${p.description || p.detail}</div>` : ''}
                        </div>`;
    }).join('')}
                </div>
            </div>` : ''}

            ${bottlenecks.length > 0 ? `
            <div style="margin-bottom:20px;">
                <h4 style="color:#ffb86c;margin:0 0 10px 0;font-size:13px;">🔗 Structural Bottlenecks</h4>
                <div style="display:flex;flex-wrap:wrap;gap:10px;">
                    ${bottlenecks.map(b => `
                        <div style="flex:1;min-width:240px;padding:12px;background:rgba(255,184,108,0.08);border:1px solid rgba(255,184,108,0.25);border-radius:8px;">
                            <div style="color:#ffb86c;font-weight:600;font-size:12px;">${b.package || b.name || b.group || ''}</div>
                            <div style="color:#8be9fd;font-size:11px;margin-top:5px;">${b.reason || b.description || ''}</div>
                            ${b.networkRole ? `<div style="color:#bd93f9;font-size:10px;margin-top:3px;">Role: ${b.networkRole}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>` : ''}
            
            ${actions.length > 0 ? `
            <div>
                <h4 style="color:#50fa7b;margin:0 0 10px 0;font-size:13px;">⚡ Immediate Actions</h4>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    ${actions.map((a, i) => {
        const actionText = a.action || a.title || (typeof a === 'string' ? a : '');
        return `
                        <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 12px;background:rgba(80,250,123,0.05);border-radius:6px;">
                            <span style="color:#50fa7b;font-weight:700;min-width:18px;font-size:12px;">${i + 1}.</span>
                            <div>
                                <div style="color:#cdfaff;font-weight:600;font-size:12px;">${actionText}</div>
                                ${a.owner ? `<span style="color:#8be9fd;font-size:11px;">👤 ${a.owner}</span>` : ''}
                                ${a.deadline ? `<span style="color:#ffb86c;font-size:11px;margin-left:8px;">📅 ${a.deadline}</span>` : ''}
                                ${a.priority ? `<span style="color:${a.priority === 'critical' ? '#ff5555' : a.priority === 'high' ? '#ffb86c' : '#8be9fd'};font-size:10px;margin-left:8px;text-transform:uppercase;">${a.priority}</span>` : ''}
                            </div>
                        </div>`;
    }).join('')}
                </div>
            </div>` : ''}
        </div>
    `;
}


// ============================================================================
// v2.4: SYNTHESIS RETRY - ensures button appears even with timing races
// ============================================================================
function _retrySynthesisButtonInjection(groupType) {
    const analytics = ensureAnalyticsState();
    const maxRetries = 5;
    let attempt = 0;

    function tryInject() {
        attempt++;
        if (!analytics.isSynthesisAvailable()) {
            if (attempt < maxRetries) {
                _log(`[Synthesis] Not yet available, retry ${attempt}/${maxRetries} in 3s`);
                setTimeout(tryInject, 3000);
            }
            return;
        }

        // Find systems insights containers
        const containers = document.querySelectorAll('[id^="systems-insights-container-"]');
        let injected = false;
        containers.forEach(container => {
            if (!container.querySelector('[data-cyb-synthesis-btn="true"]')) {
                const gt = container.id.replace('systems-insights-container-', '');
                addSynthesisButton(container, gt);
                injected = true;
                _log(`[Synthesis] Button injected for ${gt} on attempt ${attempt}`);
            }
        });

        if (!injected && attempt < maxRetries) {
            setTimeout(tryInject, 3000);
        }
    }

    // Start after a short delay to let DOM settle
    setTimeout(tryInject, 2000);
}

// ============================================================================
// EVENT LISTENER FOR SYNTHESIS AVAILABILITY
// ============================================================================
// Idempotent synthesis listener to prevent duplicates on reload
if (!window._cybereumSynthesisListenerAttached) {
    window._cybereumSynthesisListenerAttached = true;
    window.addEventListener('cybereum:synthesisAvailable', (event) => {
        _log('[Synthesis] Available:', event.detail);

        // Find all systems insights containers (per-groupType)
        const containers = document.querySelectorAll('[id^="systems-insights-container-"]');
        containers.forEach(container => {
            if (!container.querySelector('[data-cyb-synthesis-btn="true"]')) {
                const groupType = container.id.replace('systems-insights-container-', '');
                addSynthesisButton(container, groupType);
            }
        });

        // Also check old-style container for backward compat
        const oldContainer = document.getElementById('systems-insights-container');
        if (oldContainer && !oldContainer.querySelector('[data-cyb-synthesis-btn="true"]')) {
            addSynthesisButton(oldContainer);
        }
    })
};

_log('[CommunityGroups] Analytics patch loaded');
// ============================================================================
// CBS (Cost Breakdown Structure) Configuration
// ============================================================================
const CBS_CATEGORIES = {
    DIRECT_LABOR: {
        name: 'Direct Labor',
        color: '#50fa7b',
        icon: '👷',
        fields: ['hours', 'rate'],
        calculate: (data) => (data.hours || 0) * (data.rate || 0)
    },
    DIRECT_MATERIAL: {
        name: 'Direct Materials',
        color: '#8be9fd',
        icon: '📦',
        fields: ['quantity', 'unitCost'],
        calculate: (data) => (data.quantity || 0) * (data.unitCost || 0)
    },
    EQUIPMENT: {
        name: 'Equipment',
        color: '#ffb86c',
        icon: '🏗️',
        fields: ['days', 'rate'],
        calculate: (data) => (data.days || 0) * (data.rate || 0)
    },
    SUBCONTRACTS: {
        name: 'Subcontracts',
        color: '#bd93f9',
        icon: '📄',
        fields: ['amount'],
        calculate: (data) => data.amount || 0
    },
    INDIRECT: {
        name: 'Indirect/Overhead',
        color: '#ff79c6',
        icon: '💼',
        fields: ['percentage'],
        calculate: (data, directTotal) => directTotal * (data.percentage || 10) / 100
    }
};

// ============================================================================
// PROJECT GROUP MANAGER CLASS - ENHANCED WITH ADVANCED PROJECT CONTROLS
// ============================================================================
class ProjectGroupManager {
    constructor() {
        // Use CybereumDesign palette if available, otherwise fallback
        const palette = window.CybereumDesign?.palette || {};
        this.colors = {
            bgDark: palette.bgDark || '#0d2137',
            bgLight: palette.bgMid || '#102d50',
            primary: palette.primary || '#5ac8fa',
            secondary: palette.secondary || '#41afeb',
            accent1: palette.accent1 || '#ff4444',
            accent2: palette.accent2 || '#b4f5ff',
            accent3: palette.accent3 || '#287dc8',
            text: palette.text || '#cdfaff',
            highlight: palette.highlight || '#46b9fa',
            red: palette.red || '#ff5555',
            green: palette.green || '#50fa7b',
            orange: palette.orange || '#ffb86c',
            yellow: palette.yellow || '#ffeb3b',
            purple: palette.purple || '#bd93f9',
            pink: palette.pink || '#ff79c6',
            cyan: palette.cyan || '#8be9fd'
        };

        // Project control thresholds
        this.thresholds = {
            criticalFloat: 10, // days
            nearCriticalFloat: 20, // days
            highRisk: 0.7,
            mediumRisk: 0.4,
            scheduleVariance: 0.1, // 10% variance threshold
            costVariance: 0.05 // 5% variance threshold
        };
    }

    // Enhanced group metrics with caching support
    calculateGroupMetrics(nodes) {
        // Use MetricsCache if available
        if (window.MetricsCache) {
            return window.MetricsCache.get(nodes, (n) => this._calculateGroupMetricsInternal(n));
        }
        return this._calculateGroupMetricsInternal(nodes);
    }

    // Invalidate cache for specific nodes
    invalidateMetricsCache(nodes) {
        if (window.MetricsCache) window.MetricsCache.invalidate(nodes);
    }

    // Internal metrics calculation
    _calculateGroupMetricsInternal(nodes) {
        // Initialize all metrics
        let metrics = {
            // Basic metrics
            totalDuration: 0,
            actualDuration: 0,
            completedProgress: 0,
            earliestStart: null,
            latestEnd: null,
            actualStart: null,
            actualFinish: null,
            predictedStart: null,
            predictedEnd: null,

            // Risk metrics
            totalRiskScore: 0,
            maxRiskScore: 0,
            validRiskCount: 0,
            highRiskCount: 0,
            mediumRiskCount: 0,

            // Critical path metrics
            criticalTaskCount: 0,
            nearCriticalCount: 0,
            totalFloat: 0,
            minFloat: Infinity,

            // Critical activities lists
            criticalActivities: [],
            nearCriticalActivities: [],

            // Earned Value metrics
            BAC: 0, // Budget at Completion
            BCWP: 0, // Budgeted Cost of Work Performed
            BCWS: 0, // Budgeted Cost of Work Scheduled
            ACWP: 0, // Actual Cost of Work Performed
            EAC: 0, // Estimate at Completion

            // Resource metrics
            totalResourcesRequired: 0,
            resourceUtilization: 0,
            resourceConflicts: 0,

            // Milestone metrics
            totalMilestones: 0,
            completedMilestones: 0,
            upcomingMilestones: 0,
            delayedMilestones: 0,

            // Work package metrics
            workPackageCount: 0,
            leafWBSCount: 0,

            // Performance metrics
            schedulePerformance: 0,
            costPerformance: 0,

            // Node details
            nodeCount: nodes.length,
            completedNodes: 0,
            inProgressNodes: 0,
            notStartedNodes: 0,

            // Schedule tracking
            behindScheduleCount: 0,
            onScheduleCount: 0,
            aheadScheduleCount: 0
        };

        // Calculate today's date for comparison
        const today = window.cybereumState.dataDate || new Date();

        nodes.forEach(node => {
            // Basic duration and progress
            const duration = parseFloat(node.Duration) || 0;
            const actualDuration = parseFloat(node.ActualDuration) || 0;
            const percentComplete = parseFloat(node.PercentComplete) || 0;

            metrics.totalDuration += duration;
            metrics.actualDuration += actualDuration;
            metrics.completedProgress += (percentComplete / 100) * duration;

            // Task status classification
            const isCompleted = percentComplete >= 100;
            if (isCompleted) {
                metrics.completedNodes++;
            } else if (percentComplete > 0) {
                metrics.inProgressNodes++;
            } else {
                metrics.notStartedNodes++;
            }

            // Critical path analysis and activity tracking - USE CORRECT PROPERTIES
            const isCritical = node.isOnCriticalPath === true;
            const isNearCritical = node.isOnOutlierPath === true;

            if (isCritical) {
                metrics.criticalTaskCount++;
                metrics.criticalActivities.push({
                    id: node.ID,
                    name: node.Name,
                    start: node.Start,
                    finish: node.Finish,
                    duration: duration,
                    percentComplete: percentComplete,
                    slack: parseFloat(node.slack) || 0,
                    actualStart: node.ActualStart,
                    actualFinish: node.ActualFinish,
                    predictedStart: node.predictedStart,
                    predictedEnd: node.predictedEnd
                });
            }

            if (isNearCritical && !isCritical) {
                metrics.nearCriticalCount++;
                metrics.nearCriticalActivities.push({
                    id: node.ID,
                    name: node.Name,
                    start: node.Start,
                    finish: node.Finish,
                    duration: duration,
                    percentComplete: percentComplete,
                    slack: parseFloat(node.slack) || 0,
                    actualStart: node.ActualStart,
                    actualFinish: node.ActualFinish,
                    predictedStart: node.predictedStart,
                    predictedEnd: node.predictedEnd
                });
            }

            // Risk analysis
            const riskScore = parseFloat(node.riskScore) || parseFloat(node.ComputedRiskScore) || 0;
            if (!isNaN(riskScore) && riskScore > 0) {
                metrics.totalRiskScore += riskScore;
                metrics.validRiskCount++;
                metrics.maxRiskScore = Math.max(metrics.maxRiskScore, riskScore);

                if (riskScore >= this.thresholds.highRisk) {
                    metrics.highRiskCount++;
                } else if (riskScore >= this.thresholds.mediumRisk) {
                    metrics.mediumRiskCount++;
                }
            }

            // Float/Slack analysis
            const slack = parseFloat(node.slack) || parseFloat(node.LF - node.EF) || 0;
            if (!isNaN(slack)) {
                metrics.totalFloat += slack;
                metrics.minFloat = Math.min(metrics.minFloat, slack);
            }

            // Earned Value metrics
            const bac = parseFloat(node.BAC) || 0;
            const bcwp = parseFloat(node.BCWP) || 0;
            const bcws = parseFloat(node.BCWS) || 0;
            const acwp = parseFloat(node.ACWP) || 0;
            const eac = parseFloat(node.EAC) || 0;

            metrics.BAC += bac;
            metrics.BCWP += bcwp;
            metrics.BCWS += bcws;
            metrics.ACWP += acwp;
            metrics.EAC += eac;

            // Resource analysis
            const resourcesRequired = parseFloat(node.resourcesRequired) || 0;
            metrics.totalResourcesRequired += resourcesRequired;

            // Milestone tracking
            if (node.Milestone === "1" || node.TaskType === "Milestone") {
                metrics.totalMilestones++;
                if (percentComplete >= 100) {
                    metrics.completedMilestones++;
                } else {
                    const finishDate = new Date(node.Finish);
                    if (!isNaN(finishDate.getTime())) {
                        if (finishDate > today) {
                            metrics.upcomingMilestones++;
                        } else if (percentComplete < 100) {
                            metrics.delayedMilestones++;
                        }
                    }
                }
            }

            // Work package analysis
            if (node.WorkPackage === 1) {
                metrics.workPackageCount++;
            }
            if (node.WBS_IsLeaf === 1) {
                metrics.leafWBSCount++;
            }

            // Date range tracking for group
            const startDate = new Date(node.Start);
            const finishDate = new Date(node.Finish);
            const actualStartDate = node.ActualStart ? new Date(node.ActualStart) : null;
            const actualFinishDate = node.ActualFinish ? new Date(node.ActualFinish) : null;
            const predictedStartDate = node.predictedStart ? new Date(node.predictedStart) : null;
            const predictedEndDate = node.predictedEnd ? new Date(node.predictedEnd) : null;

            // Track planned dates
            if (!isNaN(startDate.getTime())) {
                if (!metrics.earliestStart || startDate < metrics.earliestStart) {
                    metrics.earliestStart = startDate;
                }
            }

            if (!isNaN(finishDate.getTime())) {
                if (!metrics.latestEnd || finishDate > metrics.latestEnd) {
                    metrics.latestEnd = finishDate;
                }
            }

            // Track actual/predicted dates based on completion status
            if (isCompleted) {
                // For completed activities, use actual dates
                if (actualStartDate && !isNaN(actualStartDate.getTime())) {
                    if (!metrics.actualStart || actualStartDate < metrics.actualStart) {
                        metrics.actualStart = actualStartDate;
                    }
                }
                if (actualFinishDate && !isNaN(actualFinishDate.getTime())) {
                    if (!metrics.actualFinish || actualFinishDate > metrics.actualFinish) {
                        metrics.actualFinish = actualFinishDate;
                    }
                }
            } else {
                // For incomplete activities, use predicted dates
                const effectivePredictedStart = predictedStartDate || startDate;
                const effectivePredictedEnd = predictedEndDate || finishDate;

                if (effectivePredictedStart && !isNaN(effectivePredictedStart.getTime())) {
                    if (!metrics.predictedStart || effectivePredictedStart < metrics.predictedStart) {
                        metrics.predictedStart = effectivePredictedStart;
                    }
                }
                if (effectivePredictedEnd && !isNaN(effectivePredictedEnd.getTime())) {
                    if (!metrics.predictedEnd || effectivePredictedEnd > metrics.predictedEnd) {
                        metrics.predictedEnd = effectivePredictedEnd;
                    }
                }
            }

            // Schedule performance tracking - Enhanced for accuracy
            if (isCompleted) {
                // For completed tasks, check if they finished late
                const plannedFinish = new Date(node.Finish);
                if (actualFinishDate && actualFinishDate > plannedFinish) {
                    metrics.behindScheduleCount++;
                } else if (actualFinishDate && actualFinishDate < plannedFinish) {
                    metrics.aheadScheduleCount++;
                } else {
                    metrics.onScheduleCount++;
                }
            } else if (percentComplete > 0) {
                // For in-progress tasks, check predicted vs planned
                const plannedFinish = new Date(node.Finish);
                const currentPredictedEnd = predictedEndDate || plannedFinish;

                if (currentPredictedEnd > plannedFinish) {
                    metrics.behindScheduleCount++;
                } else if (currentPredictedEnd < plannedFinish) {
                    metrics.aheadScheduleCount++;
                } else {
                    metrics.onScheduleCount++;
                }
            } else {
                // For not-started tasks, check if start date has passed
                const plannedStart = new Date(node.Start);
                if (today > plannedStart) {
                    metrics.behindScheduleCount++;
                } else {
                    metrics.onScheduleCount++;
                }
            }
        });

        // Calculate aggregate metrics
        metrics.aggregateProgress = metrics.totalDuration > 0
            ? (metrics.completedProgress / metrics.totalDuration) * 100 : 0;

        metrics.normalizedRiskScore = metrics.validRiskCount > 0
            ? metrics.totalRiskScore / metrics.validRiskCount : 0;

        // Calculate performance indices
        if (metrics.BCWS > 0) {
            metrics.schedulePerformance = metrics.BCWP / metrics.BCWS; // SPI
        }
        if (metrics.BCWP > 0) {
            metrics.costPerformance = metrics.BCWP / metrics.ACWP; // CPI
        }

        // Calculate variance metrics
        metrics.scheduleVariance = metrics.BCWP - metrics.BCWS; // SV
        metrics.costVariance = metrics.BCWP - metrics.ACWP; // CV

        // Calculate estimates
        if (metrics.costPerformance > 0 && metrics.BAC > 0) {
            metrics.estimateToComplete = (metrics.BAC - metrics.BCWP) / metrics.costPerformance; // ETC
            metrics.estimateAtCompletion = metrics.ACWP + metrics.estimateToComplete; // EAC
            metrics.varianceAtCompletion = metrics.BAC - metrics.estimateAtCompletion; // VAC
        }

        // Resource utilization (if resource data available)
        if (metrics.totalResourcesRequired > 0) {
            metrics.resourceUtilization = (metrics.totalResourcesRequired / nodes.length) * 100;
        }

        // Fix Infinity values
        if (metrics.minFloat === Infinity) {
            metrics.minFloat = 0;
        }

        // Calculate health score (0-100)
        metrics.healthScore = this.calculateGroupHealthScore(metrics);

        return metrics;
    }

    // Calculate overall group health score - IMPROVED VERSION
    // Health score reflects: completion status, schedule performance, risk exposure, and critical path health
    calculateGroupHealthScore(metrics) {
        // If group is essentially complete (>95% progress), give high score with minor adjustments
        if (metrics.aggregateProgress >= 95) {
            let score = 95;
            // Minor penalty for any delayed milestones that occurred
            if (metrics.delayedMilestones > 0) score -= Math.min(5, metrics.delayedMilestones);
            // Minor penalty if completed late (SPI < 1 at completion)
            if (metrics.schedulePerformance > 0 && metrics.schedulePerformance < 0.9) score -= 5;
            return Math.max(85, Math.min(100, score));
        }

        // For incomplete groups, calculate health based on multiple factors
        let score = 100;
        const nodeCount = metrics.nodeCount || 1;

        // =========================================================================
        // 1. SCHEDULE HEALTH (40 points max penalty)
        // =========================================================================

        // 1a. Delayed activities ratio (up to 20 points)
        const delayedRatio = metrics.behindScheduleCount / nodeCount;
        if (delayedRatio >= 0.5) {
            score -= 20; // More than 50% delayed - severe
        } else if (delayedRatio >= 0.3) {
            score -= 15; // 30-50% delayed - serious
        } else if (delayedRatio >= 0.15) {
            score -= 10; // 15-30% delayed - concerning
        } else if (delayedRatio > 0) {
            score -= Math.round(delayedRatio * 30); // Proportional for small delays
        }

        // 1b. Progress vs expected timeline (up to 15 points)
        const today = window.cybereumState?.dataDate || new Date();
        const projectStart = metrics.earliestStart;
        const projectEnd = metrics.latestEnd;
        if (projectStart && projectEnd && projectEnd > projectStart) {
            const totalDuration = projectEnd - projectStart;
            const elapsed = Math.max(0, today - projectStart);
            const timeProgress = Math.min(100, (elapsed / totalDuration) * 100);
            const progressGap = timeProgress - metrics.aggregateProgress;

            if (progressGap > 20) {
                score -= 15; // More than 20% behind expected
            } else if (progressGap > 10) {
                score -= 10; // 10-20% behind
            } else if (progressGap > 5) {
                score -= 5;  // 5-10% behind
            }
            // Bonus if ahead of schedule
            if (progressGap < -10) {
                score += 5; // More than 10% ahead
            }
        }

        // 1c. SPI if available (up to 10 points)
        if (metrics.schedulePerformance > 0) {
            if (metrics.schedulePerformance < 0.7) {
                score -= 10; // SPI < 0.7 is critical
            } else if (metrics.schedulePerformance < 0.85) {
                score -= 7;
            } else if (metrics.schedulePerformance < 0.95) {
                score -= 3;
            }
        }

        // =========================================================================
        // 2. RISK EXPOSURE (25 points max penalty)
        // =========================================================================

        // 2a. Average risk score (up to 15 points)
        const avgRisk = metrics.normalizedRiskScore || 0;
        if (avgRisk >= 0.8) {
            score -= 15; // Very high average risk
        } else if (avgRisk >= 0.6) {
            score -= 12;
        } else if (avgRisk >= 0.4) {
            score -= 8;
        } else if (avgRisk >= 0.2) {
            score -= 4;
        }

        // 2b. High risk activity count (up to 10 points)
        const highRiskRatio = metrics.highRiskCount / nodeCount;
        if (highRiskRatio >= 0.3) {
            score -= 10; // 30%+ activities are high risk
        } else if (highRiskRatio >= 0.15) {
            score -= 7;
        } else if (highRiskRatio >= 0.05) {
            score -= 4;
        } else if (highRiskRatio > 0) {
            score -= 2;
        }

        // =========================================================================
        // 3. CRITICAL PATH HEALTH (20 points max penalty)
        // =========================================================================

        // 3a. Critical activities ratio (up to 10 points)
        // Having critical activities isn't inherently bad, but high concentration is concerning
        const criticalRatio = metrics.criticalTaskCount / nodeCount;
        if (criticalRatio >= 0.5) {
            score -= 10; // Half or more activities are critical
        } else if (criticalRatio >= 0.3) {
            score -= 6;
        } else if (criticalRatio >= 0.15) {
            score -= 3;
        }

        // 3b. Critical activities that are delayed (up to 10 points)
        // This is the most dangerous situation
        if (metrics.criticalActivities?.length > 0) {
            const delayedCritical = metrics.criticalActivities.filter(a => {
                const pct = a.percentComplete || 0;
                if (pct >= 100) return false; // Completed, not delayed
                // Check if behind schedule
                const slack = a.slack ?? 0;
                return slack < 0 || (pct < 50 && a.predictedEnd && new Date(a.predictedEnd) > new Date(a.finish));
            }).length;

            const delayedCriticalRatio = metrics.criticalTaskCount > 0 ? delayedCritical / metrics.criticalTaskCount : 0;
            if (delayedCriticalRatio >= 0.5) {
                score -= 10; // Half of critical path is delayed
            } else if (delayedCriticalRatio >= 0.25) {
                score -= 7;
            } else if (delayedCriticalRatio > 0) {
                score -= 4;
            }
        }

        // =========================================================================
        // 4. MILESTONE HEALTH (10 points max penalty)
        // =========================================================================
        if (metrics.totalMilestones > 0) {
            const milestoneDelayRatio = metrics.delayedMilestones / metrics.totalMilestones;
            if (milestoneDelayRatio >= 0.5) {
                score -= 10;
            } else if (milestoneDelayRatio >= 0.25) {
                score -= 7;
            } else if (milestoneDelayRatio > 0) {
                score -= Math.min(5, metrics.delayedMilestones * 2);
            }
        }

        // =========================================================================
        // 5. COST PERFORMANCE (5 points max penalty) - if available
        // =========================================================================
        if (metrics.costPerformance > 0) {
            if (metrics.costPerformance < 0.8) {
                score -= 5; // CPI < 0.8 is concerning
            } else if (metrics.costPerformance < 0.9) {
                score -= 3;
            } else if (metrics.costPerformance < 0.95) {
                score -= 1;
            }
        }

        // =========================================================================
        // 6. POSITIVE FACTORS (can add back up to 10 points)
        // =========================================================================

        // Good progress adds confidence
        if (metrics.aggregateProgress >= 75 && delayedRatio < 0.1) {
            score += 5; // Well progressed with few delays
        } else if (metrics.aggregateProgress >= 50 && delayedRatio < 0.15) {
            score += 3;
        }

        // Good completion rate of non-critical activities
        const completedRatio = metrics.completedNodes / nodeCount;
        if (completedRatio >= 0.5 && metrics.criticalTaskCount < nodeCount * 0.2) {
            score += 3; // Half done with manageable critical path
        }

        // All milestones on track
        if (metrics.totalMilestones > 0 && metrics.delayedMilestones === 0) {
            score += 2;
        }

        return Math.max(0, Math.min(100, Math.round(score)));
    }

    // Get health color based on score
    getHealthColor(healthScore) {
        if (healthScore >= 90) return this.colors.green;
        if (healthScore >= 75) return this.colors.cyan;
        if (healthScore >= 60) return this.colors.yellow;
        if (healthScore >= 40) return this.colors.orange;
        return this.colors.red;
    }

    // Format date for display
    formatDate(date) {
        if (!date || isNaN(date.getTime())) {
            return 'N/A';
        }
        return date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    // Get risk color based on score (0-1 range)
    getRiskColor(riskScore) {
        if (riskScore >= 0.7) return this.colors.red;
        if (riskScore >= 0.4) return this.colors.orange;
        if (riskScore >= 0.2) return this.colors.yellow;
        return this.colors.green;
    }

    // Create comprehensive control dashboard for a group
    createGroupControlDashboard(metrics, groupName) {
        const dashboard = document.createElement('div');
        dashboard.style.cssText = `
            background-color: ${this.colors.bgLight};
            border: 2px solid ${this.getHealthColor(metrics.healthScore)};
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 20px;
        `;

        // Metrics Grid (removed duplicate header and date sections)
        const metricsGrid = document.createElement('div');
        metricsGrid.style.cssText = `
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px;
            margin-bottom: 15px;
        `;

        // Add metric cards
        metricsGrid.appendChild(this.createMetricCard('Progress',
            `${metrics.aggregateProgress.toFixed(1)}%`,
            this.getProgressColor(metrics.aggregateProgress)));

        metricsGrid.appendChild(this.createMetricCard('Critical',
            `${metrics.criticalTaskCount}`,
            metrics.criticalTaskCount > 0 ? this.colors.red : this.colors.green));

        metricsGrid.appendChild(this.createMetricCard('Near-Critical',
            `${metrics.nearCriticalCount}`,
            metrics.nearCriticalCount > 0 ? this.colors.orange : this.colors.green));

        metricsGrid.appendChild(this.createMetricCard('Risk Level',
            `${(metrics.normalizedRiskScore * 100).toFixed(1)}%`,
            this.getRiskColor(metrics.normalizedRiskScore)));

        if (metrics.schedulePerformance > 0) {
            metricsGrid.appendChild(this.createMetricCard('SPI',
                metrics.schedulePerformance.toFixed(2),
                this.getPerformanceColor(metrics.schedulePerformance)));
        }

        if (metrics.costPerformance > 0) {
            metricsGrid.appendChild(this.createMetricCard('CPI',
                metrics.costPerformance.toFixed(2),
                this.getPerformanceColor(metrics.costPerformance)));
        }

        metricsGrid.appendChild(this.createMetricCard('Milestones',
            `${metrics.completedMilestones}/${metrics.totalMilestones}`,
            metrics.delayedMilestones > 0 ? this.colors.red : this.colors.green));

        const scheduleTotal = metrics.nodeCount - metrics.completedNodes;
        const scheduleFraction = scheduleTotal > 0 ? `${metrics.onScheduleCount}/${scheduleTotal}` : 'N/A';
        metricsGrid.appendChild(this.createMetricCard('Schedule',
            scheduleFraction,
            metrics.behindScheduleCount > 0 ? this.colors.orange : this.colors.green));

        dashboard.appendChild(metricsGrid);

        // Note: Critical and near-critical activity details are shown in the activity table on the right
        // The metrics cards above show the counts, and the table provides sortable details for all activities

        // Add control indicators bar
        const indicatorsBar = this.createControlIndicatorsBar(metrics);
        dashboard.appendChild(indicatorsBar);

        return dashboard;
    }

    // Create critical activities section
    createCriticalActivitiesSection(metrics) {
        const section = document.createElement('div');
        section.style.cssText = `
            margin: 15px 0;
            padding: 10px;
            background-color: ${this.colors.bgDark};
            border-radius: 6px;
            border: 1px solid ${this.colors.primary}33;
        `;

        const title = document.createElement('h4');
        title.textContent = 'Critical Path Activities';
        title.style.cssText = `
            color: ${this.colors.text};
            margin: 0 0 10px 0;
            font-size: 14px;
            font-family: 'Orbitron', sans-serif;
        `;
        section.appendChild(title);

        // Create tabs for critical and near-critical
        const tabContainer = document.createElement('div');
        tabContainer.style.cssText = `
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
        `;

        const criticalTab = document.createElement('button');
        criticalTab.textContent = `Critical (${metrics.criticalActivities.length})`;
        criticalTab.style.cssText = `
            padding: 5px 10px;
            background-color: ${this.colors.red}20;
            color: ${this.colors.red};
            border: 1px solid ${this.colors.red};
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        `;

        const nearCriticalTab = document.createElement('button');
        nearCriticalTab.textContent = `Near-Critical (${metrics.nearCriticalActivities.length})`;
        nearCriticalTab.style.cssText = `
            padding: 5px 10px;
            background-color: transparent;
            color: ${this.colors.orange};
            border: 1px solid ${this.colors.orange}50;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        `;

        const contentArea = document.createElement('div');
        contentArea.style.cssText = `
            max-height: 200px;
            overflow-y: auto;
            padding: 5px;
        `;

        // Function to display activities
        const displayActivities = (activities, isCritical) => {
            contentArea.innerHTML = '';

            if (activities.length === 0) {
                contentArea.innerHTML = `<div style="color: ${this.colors.text}; opacity: 0.6; text-align: center; padding: 20px;">No ${isCritical ? 'critical' : 'near-critical'} activities</div>`;
                return;
            }

            const table = document.createElement('table');
            table.style.cssText = `
                width: 100%;
                border-collapse: collapse;
                font-size: 11px;
            `;

            const thead = document.createElement('thead');
            thead.innerHTML = `
                <tr style="color: ${this.colors.primary}; border-bottom: 1px solid ${this.colors.primary}33;">
                    <th style="text-align: left; padding: 5px;">Activity</th>
                    <th style="text-align: center; padding: 5px;">Progress</th>
                    <th style="text-align: center; padding: 5px;">Slack</th>
                    <th style="text-align: center; padding: 5px;">Status</th>
                </tr>
            `;
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            activities.slice(0, 10).forEach(activity => {
                const row = document.createElement('tr');
                row.style.cssText = `
                    color: ${this.colors.text};
                    border-bottom: 1px solid ${this.colors.primary}11;
                `;

                const isComplete = activity.percentComplete >= 100;
                const statusColor = isComplete ? this.colors.green :
                    activity.percentComplete > 0 ? this.colors.yellow : this.colors.orange;
                const statusText = isComplete ? 'Complete' :
                    activity.percentComplete > 0 ? 'In Progress' : 'Not Started';

                row.innerHTML = `
                    <td style="padding: 5px; max-width: 200px; overflow: hidden; text-overflow: ellipsis;">
                        <div style="font-weight: bold;">${activity.name}</div>
                        <div style="opacity: 0.6; font-size: 10px;">ID: ${activity.id}</div>
                    </td>
                    <td style="text-align: center; padding: 5px; color: ${this.getProgressColor(activity.percentComplete)};">
                        ${activity.percentComplete.toFixed(0)}%
                    </td>
                    <td style="text-align: center; padding: 5px; color: ${activity.slack <= 0 ? this.colors.red : this.colors.cyan};">
                        ${activity.slack.toFixed(0)}d
                    </td>
                    <td style="text-align: center; padding: 5px;">
                        <span style="color: ${statusColor}; font-weight: bold;">${statusText}</span>
                    </td>
                `;
                tbody.appendChild(row);
            });

            table.appendChild(tbody);
            contentArea.appendChild(table);

            if (activities.length > 10) {
                const more = document.createElement('div');
                more.style.cssText = `
                    text-align: center;
                    color: ${this.colors.primary};
                    opacity: 0.7;
                    padding: 5px;
                    font-size: 11px;
                `;
                more.textContent = `... and ${activities.length - 10} more`;
                contentArea.appendChild(more);
            }
        };

        // Tab click handlers
        criticalTab.onclick = () => {
            criticalTab.style.backgroundColor = `${this.colors.red}20`;
            criticalTab.style.borderColor = this.colors.red;
            nearCriticalTab.style.backgroundColor = 'transparent';
            nearCriticalTab.style.borderColor = `${this.colors.orange}50`;
            displayActivities(metrics.criticalActivities, true);
        };

        nearCriticalTab.onclick = () => {
            nearCriticalTab.style.backgroundColor = `${this.colors.orange}20`;
            nearCriticalTab.style.borderColor = this.colors.orange;
            criticalTab.style.backgroundColor = 'transparent';
            criticalTab.style.borderColor = `${this.colors.red}50`;
            displayActivities(metrics.nearCriticalActivities, false);
        };

        tabContainer.appendChild(criticalTab);
        tabContainer.appendChild(nearCriticalTab);
        section.appendChild(tabContainer);
        section.appendChild(contentArea);

        // Display critical activities by default
        displayActivities(metrics.criticalActivities, true);

        return section;
    }

    // Create health indicator
    createHealthIndicator(healthScore) {
        const container = document.createElement('div');
        container.style.cssText = `
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 5px 15px;
            background-color: ${this.colors.bgDark};
            border: 2px solid ${this.getHealthColor(healthScore)};
            border-radius: 20px;
        `;

        const icon = document.createElement('span');
        icon.textContent = healthScore >= 75 ? '✓' : '⚠';
        icon.style.cssText = `
            color: ${this.getHealthColor(healthScore)};
            font-size: 18px;
            font-weight: bold;
        `;

        const text = document.createElement('span');
        text.textContent = `Health: ${healthScore.toFixed(0)}%`;
        text.style.cssText = `
            color: ${this.colors.text};
            font-weight: bold;
            font-size: 14px;
        `;

        container.appendChild(icon);
        container.appendChild(text);
        return container;
    }

    // Create metric card
    createMetricCard(label, value, color) {
        const card = document.createElement('div');
        card.style.cssText = `
            background-color: ${this.colors.bgDark};
            border: 1px solid ${color};
            border-radius: 6px;
            padding: 10px;
            text-align: center;
        `;

        const labelEl = document.createElement('div');
        labelEl.textContent = label;
        labelEl.style.cssText = `
            color: ${this.colors.text};
            font-size: 11px;
            opacity: 0.8;
            margin-bottom: 5px;
        `;

        const valueEl = document.createElement('div');
        valueEl.textContent = value;
        valueEl.style.cssText = `
            color: ${color};
            font-size: 18px;
            font-weight: bold;
        `;

        card.appendChild(labelEl);
        card.appendChild(valueEl);
        return card;
    }

    // Create control indicators bar
    createControlIndicatorsBar(metrics) {
        const bar = document.createElement('div');
        bar.style.cssText = `
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            padding-top: 10px;
            border-top: 1px solid ${this.colors.primary}33;
        `;

        // Critical activities indicator
        if (metrics.criticalTaskCount > 0) {
            bar.appendChild(this.createIndicatorBadge(
                `${metrics.criticalTaskCount} Critical`,
                this.colors.red
            ));
        }

        // Near critical indicator
        if (metrics.nearCriticalCount > 0) {
            bar.appendChild(this.createIndicatorBadge(
                `${metrics.nearCriticalCount} Near-Critical`,
                this.colors.orange
            ));
        }

        // High risk indicator
        if (metrics.highRiskCount > 0) {
            bar.appendChild(this.createIndicatorBadge(
                `${metrics.highRiskCount} High Risk`,
                this.colors.pink
            ));
        }

        // Behind schedule indicator
        if (metrics.behindScheduleCount > 0) {
            bar.appendChild(this.createIndicatorBadge(
                `${metrics.behindScheduleCount} Behind Schedule`,
                this.colors.red
            ));
        }

        // Delayed milestones
        if (metrics.delayedMilestones > 0) {
            bar.appendChild(this.createIndicatorBadge(
                `${metrics.delayedMilestones} Delayed MS`,
                this.colors.purple
            ));
        }

        // Work packages
        if (metrics.workPackageCount > 0) {
            bar.appendChild(this.createIndicatorBadge(
                `${metrics.workPackageCount} Work Packages`,
                this.colors.cyan
            ));
        }

        // Float status
        if (metrics.minFloat <= 0) {
            bar.appendChild(this.createIndicatorBadge(
                'Zero Float',
                this.colors.red
            ));
        }

        // Ahead of schedule indicator
        if (metrics.aheadScheduleCount > 0) {
            bar.appendChild(this.createIndicatorBadge(
                `${metrics.aheadScheduleCount} Ahead`,
                this.colors.green
            ));
        }

        return bar;
    }

    // Create indicator badge
    createIndicatorBadge(text, color) {
        const badge = document.createElement('span');
        badge.textContent = text;
        badge.style.cssText = `
            padding: 3px 8px;
            background-color: ${color}20;
            border: 1px solid ${color};
            border-radius: 12px;
            color: ${color};
            font-size: 11px;
            font-weight: bold;
        `;
        return badge;
    }

    // Get performance color
    getPerformanceColor(value) {
        if (value >= 1.0) return this.colors.green;
        if (value >= 0.95) return this.colors.cyan;
        if (value >= 0.90) return this.colors.yellow;
        if (value >= 0.80) return this.colors.orange;
        return this.colors.red;
    }

    // Get progress color
    getProgressColor(progress) {
        if (progress >= 90) return this.colors.green;
        if (progress >= 70) return this.colors.cyan;
        if (progress >= 50) return this.colors.primary;
        if (progress >= 30) return this.colors.yellow;
        return this.colors.orange;
    }

    // Create risk indicator element (original, kept for compatibility)
    createRiskIndicator(riskScore) {
        const container = document.createElement('div');
        container.style.cssText = `
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 4px 12px;
            background-color: ${this.colors.bgLight};
            border: 1px solid ${this.getRiskColor(riskScore)};
            border-radius: 4px;
            margin: 0 8px;
        `;

        const icon = document.createElement('span');
        icon.textContent = '⚠';
        icon.style.cssText = `
            color: ${this.getRiskColor(riskScore)};
            font-size: 16px;
        `;

        const text = document.createElement('span');
        text.textContent = `Risk: ${(riskScore * 100).toFixed(1)}%`;
        text.style.cssText = `
            color: ${this.colors.text};
            font-weight: bold;
            font-size: 12px;
        `;

        container.appendChild(icon);
        container.appendChild(text);
        return container;
    }

    // Create date range element (original, kept for compatibility)
    createDateRangeElement(earliestStart, latestEnd) {
        const container = document.createElement('div');
        container.style.cssText = `
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 4px 12px;
            background-color: ${this.colors.bgLight};
            border: 1px solid ${this.colors.primary};
            border-radius: 4px;
            margin: 0 8px;
        `;

        const icon = document.createElement('span');
        icon.textContent = '📅';
        icon.style.cssText = `font-size: 16px;`;

        const text = document.createElement('span');
        text.textContent = `${this.formatDate(earliestStart)} → ${this.formatDate(latestEnd)}`;
        text.style.cssText = `
            color: ${this.colors.text};
            font-size: 12px;
        `;

        container.appendChild(icon);
        container.appendChild(text);
        return container;
    }
}


// ============================================================================
// GROUP NODES BY WBS
// ============================================================================
function groupNodesByWBS(nodes) {
    const groupedNodes = {};

    nodes.forEach(node => {
        let wbsId = node.WBS_ID;
        if (wbsId == null || wbsId === '') {
            wbsId = 'Unassigned';
        }
        if (!groupedNodes[wbsId]) {
            groupedNodes[wbsId] = [];
        }
        groupedNodes[wbsId].push(node);
    });

    return groupedNodes;
}

// ============================================================================
// PREPARE GANTT DATA WITH ENHANCED METRICS
// ============================================================================
function prepareGanttData(groupedNodes, groupNames, groupManager) {
    const ganttData = [];
    let groupNumber = 1;

    Object.entries(groupedNodes).forEach(([groupId, nodes]) => {
        if (nodes.length > 0) {
            const groupName = (groupNames[groupId]?.Name || `Group ${groupId}`).toString();
            const metrics = groupManager.calculateGroupMetrics(nodes);

            // Validate dates
            if (!metrics.earliestStart || !metrics.latestEnd) {
                console.warn(`Group ${groupId} has invalid dates and will be skipped.`);
                groupNumber++;
                return;
            }

            // Create enhanced tooltip with critical info
            let tooltipContent = `${groupName}\n`;
            tooltipContent += `Progress: ${metrics.aggregateProgress.toFixed(1)}%\n`;
            tooltipContent += `Health: ${metrics.healthScore.toFixed(0)}%\n`;
            tooltipContent += `Critical: ${metrics.criticalTaskCount} | Near-Critical: ${metrics.nearCriticalCount}\n`;

            if (metrics.schedulePerformance > 0) {
                tooltipContent += `SPI: ${metrics.schedulePerformance.toFixed(2)} | `;
            }
            if (metrics.costPerformance > 0) {
                tooltipContent += `CPI: ${metrics.costPerformance.toFixed(2)}`;
            }

            // Enhanced Gantt data with full metrics + group number and ID for navigation
            ganttData.push([
                `Group_${groupId}`,       // [0] taskId
                groupName,                 // [1] taskName
                tooltipContent,            // [2] tooltip
                metrics.earliestStart,     // [3] startDate
                metrics.latestEnd,         // [4] endDate
                null,                      // [5] duration
                parseFloat(metrics.aggregateProgress.toFixed(2)), // [6] progress
                null,                      // [7] deps
                metrics,                   // [8] metrics object
                groupNumber,               // [9] group number for display
                groupId                    // [10] original groupId for navigation
            ]);
            groupNumber++;
        }
    });

    return ganttData;
}

// ============================================================================
// DRAW GROUP GANTT CHART - Enhanced with group numbers and click navigation
// ============================================================================
function drawGroupGanttChart(ganttData, containerId, groupType = 'WBS_ID') {
    const colors = {
        bgDark: '#0d2137',
        bgLight: '#102d50',
        primary: '#5ac8fa',
        secondary: '#41afeb',
        accent1: '#8ce6ff',
        accent2: '#b4f5ff',
        text: '#cdfaff',
        gridLine: 'rgba(92, 200, 250, 0.15)',
        critical: '#ff5555',
        complete: '#50fa7b',
        inProgress: '#ffb86c'
    };

    const container = document.getElementById(containerId);
    if (!container) {
        console.error(`Container with id ${containerId} not found.`);
        return;
    }

    container.innerHTML = '';

    const totalGroups = ganttData.length;
    _log(`[MetaGantt] Rendering ${totalGroups} groups`);

    // Configuration based on group count
    const config = {
        rowHeight: totalGroups > 100 ? 28 : totalGroups > 50 ? 32 : 40,
        barHeight: totalGroups > 100 ? 18 : totalGroups > 50 ? 22 : 28,
        labelWidth: totalGroups > 100 ? 140 : totalGroups > 50 ? 180 : 220,
        pageSize: totalGroups > 200 ? 50 : totalGroups > 100 ? 75 : totalGroups > 50 ? 100 : totalGroups,
        fontSize: totalGroups > 100 ? 10 : 11
    };

    // Sort data by start date
    const sortedData = [...ganttData].sort((a, b) => new Date(a[3]) - new Date(b[3]));

    // Find date range
    const minDate = new Date(Math.min(...sortedData.map(d => new Date(d[3]))));
    const maxDate = new Date(Math.max(...sortedData.map(d => new Date(d[4]))));
    const totalDays = Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)) + 1;

    // State management
    let currentPage = 0;
    const totalPages = Math.ceil(totalGroups / config.pageSize);

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        background: ${colors.bgDark};
        border-radius: 8px;
        overflow: hidden;
    `;
    container.appendChild(wrapper);

    // Header with controls
    const header = document.createElement('div');
    header.style.cssText = `
        padding: 12px 15px;
        background: linear-gradient(135deg, ${colors.bgLight}, ${colors.bgDark});
        border-bottom: 1px solid ${colors.primary};
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
    `;
    wrapper.appendChild(header);

    const title = document.createElement('div');
    title.innerHTML = `
        <span style="color: ${colors.primary}; font-weight: bold; font-size: 14px;">📊 Work Package Schedule</span>
        <span style="color: ${colors.text}; font-size: 12px; margin-left: 10px;">${totalGroups} groups</span>
    `;
    header.appendChild(title);

    // Pagination controls (if needed)
    if (totalPages > 1) {
        const pagination = document.createElement('div');
        pagination.style.cssText = `display: flex; align-items: center; gap: 8px;`;
        pagination.innerHTML = `
            <button id="${containerId}-prev" style="
                padding: 4px 10px;
                background: ${colors.bgLight};
                border: 1px solid ${colors.primary};
                border-radius: 4px;
                color: ${colors.text};
                cursor: pointer;
                font-size: 11px;
            ">◀ Prev</button>
            <span id="${containerId}-page-info" style="color: ${colors.text}; font-size: 11px;">
                Page 1 of ${totalPages}
            </span>
            <button id="${containerId}-next" style="
                padding: 4px 10px;
                background: ${colors.bgLight};
                border: 1px solid ${colors.primary};
                border-radius: 4px;
                color: ${colors.text};
                cursor: pointer;
                font-size: 11px;
            ">Next ▶</button>
        `;
        header.appendChild(pagination);
    }

    // Timeline header
    const timelineHeader = document.createElement('div');
    timelineHeader.style.cssText = `
        display: flex;
        background: ${colors.bgLight};
        border-bottom: 1px solid ${colors.gridLine};
        flex-shrink: 0;
    `;
    wrapper.appendChild(timelineHeader);

    // Label column header
    const labelHeader = document.createElement('div');
    labelHeader.style.cssText = `
        width: ${config.labelWidth}px;
        min-width: ${config.labelWidth}px;
        padding: 8px 10px;
        color: ${colors.primary};
        font-weight: bold;
        font-size: ${config.fontSize}px;
        border-right: 1px solid ${colors.gridLine};
    `;
    labelHeader.textContent = 'Work Package';
    timelineHeader.appendChild(labelHeader);

    // Date scale header
    const dateScaleContainer = document.createElement('div');
    dateScaleContainer.style.cssText = `
        flex: 1;
        display: flex;
        overflow: hidden;
    `;
    timelineHeader.appendChild(dateScaleContainer);

    // Generate date markers
    const numMarkers = Math.min(12, Math.ceil(totalDays / 30));
    for (let i = 0; i <= numMarkers; i++) {
        const markerDate = new Date(minDate.getTime() + (i / numMarkers) * (maxDate - minDate));
        const marker = document.createElement('div');
        marker.style.cssText = `
            flex: 1;
            padding: 8px 4px;
            text-align: center;
            color: ${colors.accent1};
            font-size: ${config.fontSize - 1}px;
            border-right: 1px solid ${colors.gridLine};
        `;
        marker.textContent = markerDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        dateScaleContainer.appendChild(marker);
    }

    // Content area
    const contentArea = document.createElement('div');
    contentArea.id = `${containerId}-content`;
    contentArea.style.cssText = `
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
    `;
    wrapper.appendChild(contentArea);

    // Render function
    function renderPage(page) {
        currentPage = page;
        const start = page * config.pageSize;
        const end = Math.min(start + config.pageSize, totalGroups);
        const pageData = sortedData.slice(start, end);

        contentArea.innerHTML = '';

        pageData.forEach((row, index) => {
            const [taskId, taskName, tooltip, startDate, endDate, duration, progress, deps, metrics, groupNumber, groupId] = row;

            const rowDiv = document.createElement('div');
            rowDiv.style.cssText = `
                display: flex;
                height: ${config.rowHeight}px;
                border-bottom: 1px solid ${colors.gridLine};
                background: ${index % 2 === 0 ? colors.bgDark : colors.bgLight};
                cursor: pointer;
                transition: background 0.15s ease;
            `;

            // Hover effect
            rowDiv.addEventListener('mouseenter', () => {
                rowDiv.style.background = 'rgba(90, 200, 250, 0.15)';
            });
            rowDiv.addEventListener('mouseleave', () => {
                rowDiv.style.background = index % 2 === 0 ? colors.bgDark : colors.bgLight;
            });

            // Click to navigate to group section
            rowDiv.addEventListener('click', () => {
                const sectionId = groupId || taskId.replace('Group_', '');
                const groupSection = document.getElementById(`group-section-${sectionId}`);
                if (groupSection) {
                    groupSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Highlight briefly
                    groupSection.style.boxShadow = '0 0 20px rgba(90, 200, 250, 0.5)';
                    setTimeout(() => { groupSection.style.boxShadow = ''; }, 2000);
                }
                _log(`[MetaGantt] Navigating to group: ${sectionId}`);
            });

            // Label with group number badge
            const label = document.createElement('div');
            label.style.cssText = `
                width: ${config.labelWidth}px;
                min-width: ${config.labelWidth}px;
                padding: 0 8px;
                display: flex;
                align-items: center;
                gap: 6px;
                color: ${colors.text};
                font-size: ${config.fontSize}px;
                border-right: 1px solid ${colors.gridLine};
                overflow: hidden;
            `;

            // Group number badge
            const numBadge = document.createElement('span');
            const displayNum = groupNumber || (index + 1 + start);
            numBadge.style.cssText = `
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 22px;
                height: 18px;
                padding: 0 4px;
                background: ${colors.primary};
                color: #0d2137;
                border-radius: 9px;
                font-size: ${config.fontSize - 1}px;
                font-weight: bold;
                flex-shrink: 0;
            `;
            numBadge.textContent = displayNum;
            label.appendChild(numBadge);

            // Group name (truncated)
            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = `
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            `;
            const maxNameLen = totalGroups > 100 ? 15 : totalGroups > 50 ? 18 : 22;
            nameSpan.textContent = taskName.length > maxNameLen ? taskName.substring(0, maxNameLen - 2) + '...' : taskName;
            nameSpan.title = taskName;
            label.appendChild(nameSpan);

            label.title = `#${displayNum}: ${taskName}\nClick to navigate`;
            rowDiv.appendChild(label);

            // Bar area
            const barArea = document.createElement('div');
            barArea.style.cssText = `
                flex: 1;
                position: relative;
                display: flex;
                align-items: center;
            `;

            // Calculate bar position and width
            const rowStartDate = new Date(startDate);
            const rowEndDate = new Date(endDate);
            const leftPercent = ((rowStartDate - minDate) / (maxDate - minDate)) * 100;
            const widthPercent = Math.max(1, ((rowEndDate - rowStartDate) / (maxDate - minDate)) * 100);

            // Background bar
            const bgBar = document.createElement('div');
            bgBar.style.cssText = `
                position: absolute;
                left: ${leftPercent}%;
                width: ${widthPercent}%;
                height: ${config.barHeight}px;
                background: rgba(90, 200, 250, 0.15);
                border-radius: 4px;
                border: 1px solid rgba(90, 200, 250, 0.3);
            `;
            barArea.appendChild(bgBar);

            // Progress bar
            const progressBar = document.createElement('div');
            const progressPercent = parseFloat(progress) || 0;
            const barColor = progressPercent >= 100 ? colors.complete :
                progressPercent >= 50 ? colors.primary : colors.inProgress;
            progressBar.style.cssText = `
                position: absolute;
                left: ${leftPercent}%;
                width: ${widthPercent * progressPercent / 100}%;
                height: ${config.barHeight}px;
                background: ${barColor};
                border-radius: 4px;
                transition: width 0.3s ease;
            `;
            barArea.appendChild(progressBar);

            // Progress text
            const progressText = document.createElement('div');
            progressText.style.cssText = `
                position: absolute;
                left: ${leftPercent + widthPercent / 2}%;
                transform: translateX(-50%);
                color: #fff;
                font-size: ${config.fontSize - 1}px;
                font-weight: bold;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.7);
                pointer-events: none;
            `;
            progressText.textContent = `${progressPercent.toFixed(0)}%`;
            barArea.appendChild(progressText);

            // Tooltip on hover
            rowDiv.title = tooltip || `#${displayNum}: ${taskName}\nProgress: ${progressPercent}%\nClick to navigate`;

            rowDiv.appendChild(barArea);
            contentArea.appendChild(rowDiv);
        });

        // Update pagination info
        if (totalPages > 1) {
            const pageInfo = document.getElementById(`${containerId}-page-info`);
            if (pageInfo) {
                pageInfo.textContent = `Page ${page + 1} of ${totalPages} (${start + 1}-${end} of ${totalGroups})`;
            }
        }
    }

    // Initial render
    renderPage(0);

    // Setup pagination events
    if (totalPages > 1) {
        const prevBtn = document.getElementById(`${containerId}-prev`);
        const nextBtn = document.getElementById(`${containerId}-next`);

        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                if (currentPage > 0) renderPage(currentPage - 1);
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                if (currentPage < totalPages - 1) renderPage(currentPage + 1);
            });
        }
    }

    // Add custom scrollbar styling
    const style = document.createElement('style');
    style.textContent = `
        #${containerId}-content::-webkit-scrollbar {
            width: 8px;
        }
        #${containerId}-content::-webkit-scrollbar-track {
            background: ${colors.bgLight};
        }
        #${containerId}-content::-webkit-scrollbar-thumb {
            background-color: ${colors.primary};
            border-radius: 4px;
        }
    `;
    document.head.appendChild(style);
}

// ============================================================================
// DRAW COMMUNITY GROUP GANTT - E
// ============================================================================
/**
 * Create a Gantt chart for a work group
 * This will be displayed to the right of the CBS table
 */
function createCompactGantt(activities) {
    const container = document.createElement('div');
    container.style.cssText = `
        padding: 15px;
        background: linear-gradient(135deg, rgba(90, 200, 250, 0.05) 0%, rgba(189, 147, 249, 0.05) 100%);
        border: 1px solid rgba(90, 200, 250, 0.3);
        border-radius: 8px;
        height: 100%;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
    `;

    // Get date range
    const sorted = [...activities].sort((a, b) =>
        new Date(a.Start || 0) - new Date(b.Start || 0)
    );

    const dates = sorted.reduce((acc, act) => {
        const start = new Date(act.Start);
        const end = new Date(act.Finish);
        if (!acc.min || start < acc.min) acc.min = start;
        if (!acc.max || end > acc.max) acc.max = end;
        return acc;
    }, { min: null, max: null });

    if (!dates.min || !dates.max) {
        container.innerHTML = '<div style="color: #8be9fd;">No valid dates</div>';
        return container;
    }

    const totalDays = Math.ceil((dates.max - dates.min) / (86400000)) + 14;

    // Generate date markers for X-axis
    const numMarkers = 5;
    const dateMarkers = [];
    for (let i = 0; i <= numMarkers; i++) {
        const position = (i / numMarkers) * 100;
        const markerDate = new Date(dates.min.getTime() + (i / numMarkers) * (dates.max - dates.min));
        dateMarkers.push({
            position: position,
            label: markerDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
        });
    }

    container.innerHTML = `
        <div style="margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid rgba(90, 200, 250, 0.3);">
            <div style="color: #5ac8fa; font-size: 14px; font-weight: bold;">📊 Gantt Schedule</div>
        </div>
        <div style="flex: 1; overflow-y: auto; overflow-x: hidden; position: relative;">
            <div style="min-width: 400px;">
                ${sorted.slice(0, 20).map(act => { // Limit to 20 for performance
        const start = new Date(act.Start);
        const end = new Date(act.Finish);
        const offset = ((start - dates.min) / 86400000 / totalDays) * 100;
        const width = ((end - start) / 86400000 / totalDays) * 100;
        const progress = parseFloat(act.PercentComplete) || 0;
        const color = act.Critical ? '#ff5555' :
            progress >= 100 ? '#50fa7b' : '#5ac8fa';

        return `
                        <div style="margin-bottom: 3px;">
                            <div style="font-size: 10px; color: #cdfaff; margin-bottom: 2px;">
                                ${(act.Name || act.name || '').substring(0, 30)}
                            </div>
                            <div style="position: relative; height: 15px; background: rgba(25, 90, 140, 0.3); border-radius: 2px;">
                                <div style="position: absolute; left: ${offset}%; width: ${width}%; height: 100%; background: ${color}; opacity: 0.3; border-radius: 2px;"></div>
                                <div style="position: absolute; left: ${offset}%; width: ${width * progress / 100}%; height: 100%; background: ${color}; border-radius: 2px;"></div>
                                <div style="position: absolute; right: 2px; top: 0; font-size: 9px; color: #fff; line-height: 15px;">${progress}%</div>
                            </div>
                        </div>
                    `;
    }).join('')}
                <div style="position: relative; height: 25px; margin-top: 10px; border-top: 1px solid rgba(90, 200, 250, 0.3);">
                    ${dateMarkers.map(marker => `
                        <div style="position: absolute; left: ${marker.position}%; transform: translateX(-50%); top: 5px; font-size: 9px; color: #8be9fd; white-space: nowrap;">
                            ${marker.label}
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;

    return container;
}

// ============================================================================
// DRAW COMMUNITY GROUP GRAPH - ENHANCED V2 WITH ADAPTIVE LAYOUT FOR LARGE GRAPHS
// ============================================================================
// Key improvements:
// 1. Adaptive layout strategies based on node count (force-directed vs hierarchical)
// 2. Properly scaled forces for large graphs (100s of groups)
// 3. Better space utilization with intelligent node sizing
// 4. Temporal ordering for hierarchical layout
// 5. Enhanced navigation controls (fit-to-view, zoom controls, mini-map)
// 6. Performance optimizations for large graphs
// ============================================================================
function drawCommunityGroupGraph(groupedNodes, allNodes, allLinks, container, groupType, groupNames = {}) {
    if (!(container instanceof HTMLElement)) {
        console.error('Invalid container element:', container);
        return;
    }

    const groupManager = new ProjectGroupManager();

    // Expose groupManager for Panopticon Schedule tab (if stash exists)
    if (window.cybereumState && window.cybereumState._panopticon) {
        window.cybereumState._panopticon.groupManager = groupManager;
    } else if (window.cybereumState && !window.cybereumState._panopticon) {
        window.cybereumState._panopticon = { groupManager: groupManager };
    }

    // Get container dimensions BEFORE clearing content
    const containerRect = container.getBoundingClientRect();

    // Use bounding rect dimensions (more accurate than clientWidth/Height)
    let width = Math.floor(containerRect.width) || 800;
    let height = Math.floor(containerRect.height) || 600;

    // Clear container content
    container.innerHTML = '';

    // Set container positioning for absolute children, but DON'T override dimensions
    container.style.position = 'relative';
    container.style.overflow = 'hidden';

    let groupNumberCounter = 1;
    const groupIdToNumberMap = {};
    const groupIdToOriginalMap = {};

    Object.keys(groupedNodes).forEach(groupId => {
        groupIdToNumberMap[groupId] = groupNumberCounter;
        groupIdToOriginalMap[groupNumberCounter] = groupId;
        groupNumberCounter++;
    });

    const groupNodes = [];
    const groupLinks = [];
    const groupIdToNodeMap = new Map();
    let totalProgress = 0;
    let totalDuration = 0;
    let completedGroupCount = 0;
    let inProgressGroupCount = 0;
    let notStartedGroupCount = 0;
    let totalActivities = 0;
    let completedActivities = 0;
    let inProgressActivities = 0;
    let notStartedActivities = 0;

    // First pass: calculate metrics and collect risk scores
    const riskScores = [];

    for (const [groupId, nodes] of Object.entries(groupedNodes)) {
        const groupNumber = groupIdToNumberMap[groupId];
        const metrics = groupManager.calculateGroupMetrics(nodes);

        totalProgress += metrics.aggregateProgress * metrics.totalDuration / 100;
        totalDuration += metrics.totalDuration;
        totalActivities += nodes.length;

        // Determine group status using consistent logic with Panopticon
        // Done: aggregateProgress >= 100
        // Active: aggregateProgress > 0 OR inProgressNodes > 0 OR completedNodes > 0
        // Pending: everything else (truly not started)
        let groupStatus;
        if (metrics.aggregateProgress >= 100) {
            completedGroupCount++;
            groupStatus = 'completed';
        } else if (metrics.aggregateProgress > 0 || metrics.inProgressNodes > 0 || metrics.completedNodes > 0) {
            inProgressGroupCount++;
            groupStatus = 'in-progress';
        } else {
            notStartedGroupCount++;
            groupStatus = 'not-started';
        }

        // Track activity counts
        completedActivities += metrics.completedNodes || 0;
        inProgressActivities += metrics.inProgressNodes || 0;
        notStartedActivities += metrics.notStartedNodes || 0;

        // Get group name from groupNames parameter
        let groupDisplayName = `Group ${groupNumber}`;
        if (groupType === 'WBS_ID' && nodes.length > 0 && nodes[0].WBS_Name) {
            groupDisplayName = nodes[0].WBS_Name;
        } else if (groupNames && groupNames[groupId] && groupNames[groupId].Name) {
            groupDisplayName = groupNames[groupId].Name;
        }

        const groupNode = {
            id: String(groupNumber),
            originalId: groupId,
            name: `Group ${groupNumber}`,
            displayName: groupDisplayName,
            nodes: nodes,
            numberOfActivities: nodes.length,
            totalDuration: metrics.totalDuration,
            progress: Math.round(metrics.aggregateProgress * 100) / 100,
            riskScore: metrics.normalizedRiskScore,
            earliestStart: metrics.earliestStart,
            latestEnd: metrics.latestEnd,
            isCritical: false,
            completedNodes: metrics.completedNodes,
            inProgressNodes: metrics.inProgressNodes,
            notStartedNodes: metrics.notStartedNodes,
            status: groupStatus  // 'completed', 'in-progress', or 'not-started'
        };
        groupNodes.push(groupNode);
        groupIdToNodeMap.set(String(groupNumber), groupNode);
        riskScores.push(metrics.normalizedRiskScore);
    }

    // Calculate relative risk scores (normalize to 0-1 range)
    const minRisk = Math.min(...riskScores);
    const maxRisk = Math.max(...riskScores);
    const riskRange = maxRisk - minRisk;

    _log('[MetaNetwork] Processing', groupNodes.length, 'groups. Risk range:', { minRisk, maxRisk, riskRange });

    // Normalize risk scores and assign relative risk
    groupNodes.forEach(node => {
        node.relativeRiskScore = riskRange > 0 ? (node.riskScore - minRisk) / riskRange : 0.5;
    });

    // Create color scale for relative risk (green -> yellow -> orange -> red)
    const riskColorScale = d3.scaleLinear()
        .domain([0, 0.33, 0.66, 1])
        .range(['#50fa7b', '#ffeb3b', '#ffb86c', '#ff5555'])
        .interpolate(d3.interpolateRgb);

    const overallProgress = totalDuration > 0 ? (totalProgress / totalDuration) * 100 : 0;

    // Process links — build ID lookup map for O(1) access (avoids O(n) find per link)
    const nodeById = new Map();
    for (let i = 0; i < allNodes.length; i++) {
        nodeById.set(allNodes[i].ID, allNodes[i]);
    }

    const linkCounts = new Map();

    allLinks.forEach(link => {
        const sourceNodeId = link.source.ID || link.source;
        const targetNodeId = link.target.ID || link.target;
        const sourceNode = nodeById.get(sourceNodeId);
        const targetNode = nodeById.get(targetNodeId);

        if (sourceNode && targetNode) {
            let sourceGroupId = sourceNode[groupType] || 'Unassigned';
            let targetGroupId = targetNode[groupType] || 'Unassigned';

            const sourceGroupNumber = groupIdToNumberMap[sourceGroupId];
            const targetGroupNumber = groupIdToNumberMap[targetGroupId];

            if (sourceGroupNumber !== targetGroupNumber) {
                const linkKey = `${sourceGroupNumber}->${targetGroupNumber}`;
                linkCounts.set(linkKey, (linkCounts.get(linkKey) || 0) + 1);
            }
        }
    });

    linkCounts.forEach((value, key) => {
        const [sourceGroupNumber, targetGroupNumber] = key.split('->');
        if (groupIdToNodeMap.has(sourceGroupNumber) && groupIdToNodeMap.has(targetGroupNumber)) {
            groupLinks.push({
                source: sourceGroupNumber,
                target: targetGroupNumber,
                value: value
            });
        }
    });

    const connectedNodeIds = new Set();
    groupLinks.forEach(link => {
        connectedNodeIds.add(link.source);
        connectedNodeIds.add(link.target);
    });

    const filteredGroupNodes = groupNodes.filter(node => connectedNodeIds.has(node.id));
    const nodeCount = filteredGroupNodes.length;

    _log('[MetaNetwork] Connected nodes:', nodeCount, 'Links:', groupLinks.length);

    // =========================================================================
    // COMPUTE NETWORK METRICS (Betweenness Centrality, Hub/Bridge Detection)
    // =========================================================================
    function computeGroupNetworkMetrics(nodes, links) {
        const metrics = { density: 0, avgDegree: 0, hubCount: 0, bridgeCount: 0, peripheralCount: 0 };
        if (nodes.length === 0) return metrics;

        // Build adjacency lists
        const adjacencyOut = new Map();
        const adjacencyIn = new Map();
        nodes.forEach(n => {
            adjacencyOut.set(n.id, new Set());
            adjacencyIn.set(n.id, new Set());
        });
        links.forEach(link => {
            const sourceId = link.source.id || link.source;
            const targetId = link.target.id || link.target;
            if (adjacencyOut.has(sourceId)) adjacencyOut.get(sourceId).add(targetId);
            if (adjacencyIn.has(targetId)) adjacencyIn.get(targetId).add(sourceId);
        });

        // Calculate degrees
        let totalDegree = 0;
        nodes.forEach(node => {
            node.inDegree = adjacencyIn.get(node.id)?.size || 0;
            node.outDegree = adjacencyOut.get(node.id)?.size || 0;
            node.totalDegree = node.inDegree + node.outDegree;
            totalDegree += node.totalDegree;
        });
        metrics.avgDegree = nodes.length > 0 ? totalDegree / nodes.length : 0;

        // Network density
        const maxPossibleLinks = nodes.length * (nodes.length - 1);
        metrics.density = maxPossibleLinks > 0 ? links.length / maxPossibleLinks : 0;

        // Simplified betweenness centrality (sampled for large graphs)
        const betweenness = new Map(nodes.map(n => [n.id, 0]));
        const nodesToProcess = nodes.length <= 100 ? nodes :
            nodes.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(40, Math.floor(nodes.length * 0.3)));

        nodesToProcess.forEach(sourceNode => {
            const dist = new Map(), sigma = new Map(), pred = new Map();
            const queue = [], stack = [];
            nodes.forEach(n => { dist.set(n.id, Infinity); sigma.set(n.id, 0); pred.set(n.id, []); });
            dist.set(sourceNode.id, 0); sigma.set(sourceNode.id, 1); queue.push(sourceNode.id);

            while (queue.length > 0) {
                const vId = queue.shift(); stack.push(vId);
                (adjacencyOut.get(vId) || new Set()).forEach(wId => {
                    if (dist.get(wId) === Infinity) { dist.set(wId, dist.get(vId) + 1); queue.push(wId); }
                    if (dist.get(wId) === dist.get(vId) + 1) { sigma.set(wId, sigma.get(wId) + sigma.get(vId)); pred.get(wId).push(vId); }
                });
            }
            const delta = new Map(nodes.map(n => [n.id, 0]));
            while (stack.length > 0) {
                const wId = stack.pop();
                pred.get(wId).forEach(vId => { delta.set(vId, delta.get(vId) + (sigma.get(vId) / sigma.get(wId)) * (1 + delta.get(wId))); });
                if (wId !== sourceNode.id) betweenness.set(wId, betweenness.get(wId) + delta.get(wId));
            }
        });

        // Scale and normalize
        const scaleFactor = nodes.length <= 100 ? 1 : nodes.length / nodesToProcess.length;
        const betweennessValues = Array.from(betweenness.values());
        const maxB = Math.max(...betweennessValues), minB = Math.min(...betweennessValues);

        nodes.forEach(node => {
            const rawB = (betweenness.get(node.id) || 0) * scaleFactor;
            node.betweennessCentrality = maxB > minB ? (rawB - minB) / (maxB - minB) : 0;
            node.isHub = node.outDegree >= metrics.avgDegree * 1.5;
            node.isBridge = node.betweennessCentrality >= 0.6;
            node.isPeripheral = node.totalDegree <= 2 && node.betweennessCentrality < 0.3;
            node.connectivityScore = (node.betweennessCentrality * 0.6) + (Math.min(1, node.totalDegree / (metrics.avgDegree * 2)) * 0.4);
            node.networkRole = node.isBridge ? 'Bridge' : node.isHub ? 'Hub' : node.isPeripheral ? 'Peripheral' : 'Standard';
            if (node.isHub) metrics.hubCount++;
            if (node.isBridge) metrics.bridgeCount++;
            if (node.isPeripheral) metrics.peripheralCount++;
        });
        return metrics;
    }

    const groupNetworkMetrics = computeGroupNetworkMetrics(filteredGroupNodes, groupLinks);
    _log('[MetaNetwork] Network metrics:', groupNetworkMetrics);

    // =========================================================================
    // COMPUTE INTER-GROUP METRICS (cross-boundary dependency analysis)
    // For each group: inbound/outbound link counts, upstream/downstream groups,
    // interface density, and highest fan-in cross-group nodes (handoff points)
    // =========================================================================
    function computeInterGroupMetrics(groupNodes, groupLinks, allNodes, allLinks, nodeById, groupType, groupIdToNumberMap, groupNameMap) {
        var interGroupMetrics = {};

        // Initialize per-group structures keyed by group number
        groupNodes.forEach(function (gn) {
            interGroupMetrics[gn.id] = {
                inboundLinks: 0,
                outboundLinks: 0,
                totalCrossGroupLinks: 0,
                internalLinks: 0,
                interfaceDensity: 0,
                upstreamGroups: [],
                downstreamGroups: [],
                handoffNodes: []
            };
        });

        // Count inbound/outbound cross-group links and collect group dependencies
        var upstreamMap = {};
        var downstreamMap = {};
        groupNodes.forEach(function (gn) {
            upstreamMap[gn.id] = {};
            downstreamMap[gn.id] = {};
        });

        groupLinks.forEach(function (link) {
            var sourceId = String(link.source.id || link.source);
            var targetId = String(link.target.id || link.target);
            var value = link.value || 1;

            if (interGroupMetrics[sourceId]) {
                interGroupMetrics[sourceId].outboundLinks += value;
                interGroupMetrics[sourceId].totalCrossGroupLinks += value;
                if (downstreamMap[sourceId]) {
                    downstreamMap[sourceId][targetId] = (downstreamMap[sourceId][targetId] || 0) + value;
                }
            }
            if (interGroupMetrics[targetId]) {
                interGroupMetrics[targetId].inboundLinks += value;
                interGroupMetrics[targetId].totalCrossGroupLinks += value;
                if (upstreamMap[targetId]) {
                    upstreamMap[targetId][sourceId] = (upstreamMap[targetId][sourceId] || 0) + value;
                }
            }
        });

        // Count internal links per group for interface density calculation
        allLinks.forEach(function (link) {
            var sourceNodeId = link.source.ID || link.source;
            var targetNodeId = link.target.ID || link.target;
            var sourceNode = nodeById.get(sourceNodeId);
            var targetNode = nodeById.get(targetNodeId);
            if (sourceNode && targetNode) {
                var sourceGroupId = sourceNode[groupType] || 'Unassigned';
                var targetGroupId = targetNode[groupType] || 'Unassigned';
                var sourceGroupNumber = groupIdToNumberMap[sourceGroupId];
                if (
                    sourceGroupId === targetGroupId &&
                    sourceGroupNumber !== undefined &&
                    sourceGroupNumber !== null &&
                    interGroupMetrics[sourceGroupNumber]
                ) {
                    interGroupMetrics[sourceGroupNumber].internalLinks++;
                }
            }
        });

        // Build upstream/downstream arrays and compute interface density
        var groupById = new Map(groupNodes.map(function (g) { return [g.id, g]; }));
        groupNodes.forEach(function (gn) {
            var m = interGroupMetrics[gn.id];
            if (!m) return;

            // Convert upstream/downstream maps to sorted arrays
            var upEntries = Object.entries(upstreamMap[gn.id] || {});
            upEntries.sort(function (a, b) { return b[1] - a[1]; });
            m.upstreamGroups = upEntries.slice(0, 5).map(function (entry) {
                var upGn = groupById.get(entry[0]);
                return {
                    groupNumber: entry[0],
                    groupName: upGn ? upGn.displayName : ('Group ' + entry[0]),
                    linkCount: entry[1]
                };
            });

            var downEntries = Object.entries(downstreamMap[gn.id] || {});
            downEntries.sort(function (a, b) { return b[1] - a[1]; });
            m.downstreamGroups = downEntries.slice(0, 5).map(function (entry) {
                var downGn = groupById.get(entry[0]);
                return {
                    groupNumber: entry[0],
                    groupName: downGn ? downGn.displayName : ('Group ' + entry[0]),
                    linkCount: entry[1]
                };
            });

            // Interface density = cross-group links / total links for this group
            var totalLinks = m.totalCrossGroupLinks + m.internalLinks;
            m.interfaceDensity = totalLinks > 0 ? m.totalCrossGroupLinks / totalLinks : 0;
        });

        // Identify handoff nodes: activity-level nodes at cross-group boundaries with highest fan-in
        var handoffCandidates = {};
        allLinks.forEach(function (link) {
            var sourceNodeId = link.source.ID || link.source;
            var targetNodeId = link.target.ID || link.target;
            var sourceNode = nodeById.get(sourceNodeId);
            var targetNode = nodeById.get(targetNodeId);
            if (sourceNode && targetNode) {
                var sourceGroupId = sourceNode[groupType] || 'Unassigned';
                var targetGroupId = targetNode[groupType] || 'Unassigned';
                if (sourceGroupId !== targetGroupId) {
                    var targetGroupNumber = groupIdToNumberMap[targetGroupId];
                    if (targetGroupNumber) {
                        if (!handoffCandidates[targetGroupNumber]) handoffCandidates[targetGroupNumber] = {};
                        if (!handoffCandidates[targetGroupNumber][targetNodeId]) {
                            handoffCandidates[targetGroupNumber][targetNodeId] = {
                                id: targetNodeId,
                                name: targetNode.Name || targetNode.name || targetNodeId,
                                crossGroupPredecessors: 0,
                                sourceGroups: []
                            };
                        }
                        handoffCandidates[targetGroupNumber][targetNodeId].crossGroupPredecessors++;
                        var srcGrpNum = groupIdToNumberMap[sourceGroupId];
                        if (srcGrpNum && handoffCandidates[targetGroupNumber][targetNodeId].sourceGroups.indexOf(srcGrpNum) === -1) {
                            handoffCandidates[targetGroupNumber][targetNodeId].sourceGroups.push(srcGrpNum);
                        }
                    }
                }
            }
        });

        // Attach top handoff nodes to each group (sorted by cross-group predecessor count)
        groupNodes.forEach(function (gn) {
            var candidates = handoffCandidates[gn.id];
            if (candidates) {
                var sorted = Object.values(candidates).sort(function (a, b) { return b.crossGroupPredecessors - a.crossGroupPredecessors; });
                interGroupMetrics[gn.id].handoffNodes = sorted.slice(0, 3);
            }
        });

        return interGroupMetrics;
    }

    var interGroupMetrics = computeInterGroupMetrics(groupNodes, groupLinks, allNodes, allLinks, nodeById, groupType, groupIdToNumberMap, groupNames);
    _log('[MetaNetwork] Inter-group metrics computed for', Object.keys(interGroupMetrics).length, 'groups');

    // =========================================================================
    // STORE GROUPS IN window.cybereumState.groups for universal access
    // =========================================================================
    // Re-initialize .groups if something overwrote cybereumState (e.g. drawCharts.js)

    if (!window.cybereumState.groups || typeof window.cybereumState.groups !== 'object'
        || !window.cybereumState.groups.byId) {
        console.warn('[CybereumState] groups was missing or corrupt — backfilling');
        // Preserve any existing data; only backfill what's missing
        const g = window.cybereumState.groups = (window.cybereumState.groups && typeof window.cybereumState.groups === 'object')
            ? window.cybereumState.groups : {};
        g.WBS_ID = g.WBS_ID || {};
        g.CommunityGroup = g.CommunityGroup || {};
        g.DependencyCluster = g.DependencyCluster || {};
        g.byId = (g.byId instanceof Map) ? g.byId : new Map();
        g.byNumber = (g.byNumber instanceof Map) ? g.byNumber : new Map();
        g.links = g.links || {};
        g.networkMetrics = g.networkMetrics || { WBS_ID: null, CommunityGroup: null, DependencyCluster: null };
    }

    // Clear existing groups of this type
    window.cybereumState.groups[groupType] = {};

    groupNodes.forEach(groupNode => {
        const filteredNode = filteredGroupNodes.find(fn => fn.id === groupNode.id);
        const fullGroupData = {
            id: groupNode.originalId,
            groupNumber: parseInt(groupNode.id),
            name: groupNode.displayName,
            groupType: groupType,
            nodes: groupNode.nodes,
            activityCount: groupNode.numberOfActivities,
            detectedTags: (window.WorkGroupInsights?.detectTags || function (ni, ns) {
                // Minimal fallback if WorkGroupInsights not yet loaded
                const nm = (ni?.Name || '').toLowerCase();
                const pt = (ni?.Description || ni?.WBS_Path || '').toLowerCase();
                const combined = `${nm} ${pt}`;
                let phase = null;
                // Check ActivityPhase from nodes (majority vote)
                if (Array.isArray(ns) && ns.length) {
                    const pc = {};
                    for (const n of ns) { const ap = n?.ActivityPhase; if (ap && ap !== 'Other') pc[ap] = (pc[ap] || 0) + 1; }
                    const s = Object.entries(pc).sort((a, b) => b[1] - a[1]);
                    if (s.length && s[0][1] >= ns.length * 0.25) phase = s[0][0];
                }
                return { discipline: null, phase, workPackageType: /awp|iwp/i.test(combined) ? 'AWP' : null };
            })(groupNames[groupNode.originalId] || { Name: groupNode.displayName }, groupNode.nodes),
            metrics: {
                progress: parseFloat(groupNode.progress),
                riskScore: groupNode.riskScore,
                relativeRiskScore: groupNode.relativeRiskScore,
                totalDuration: groupNode.totalDuration,
                earliestStart: groupNode.earliestStart,
                latestEnd: groupNode.latestEnd,
                completedNodes: groupNode.completedNodes,
                inProgressNodes: groupNode.inProgressNodes
            },
            networkMetrics: filteredNode ? {
                betweennessCentrality: filteredNode.betweennessCentrality || 0,
                inDegree: filteredNode.inDegree || 0,
                outDegree: filteredNode.outDegree || 0,
                totalDegree: filteredNode.totalDegree || 0,
                connectivityScore: filteredNode.connectivityScore || 0,
                isHub: filteredNode.isHub || false,
                isBridge: filteredNode.isBridge || false,
                isPeripheral: filteredNode.isPeripheral || false,
                networkRole: filteredNode.networkRole || 'Isolated'
            } : null,
            interGroupMetrics: interGroupMetrics[groupNode.id] || null
        };
        window.cybereumState.groups[groupType][groupNode.originalId] = fullGroupData;
        window.cybereumState.groups.byId.set(`${groupType}:${groupNode.originalId}`, fullGroupData);
        window.cybereumState.groups.byNumber.set(`${groupType}:${groupNode.id}`, fullGroupData);
    });

    window.cybereumState.groups.networkMetrics[groupType] = groupNetworkMetrics;

    // Store per-group inter-group metrics for cross-module consumption
    window.cybereumState.groups.interGroupMetrics = window.cybereumState.groups.interGroupMetrics || {};
    window.cybereumState.groups.interGroupMetrics[groupType] = interGroupMetrics;

    // Store inter-group dependency links — the temporal execution graph
    // Each link: { source: groupNumber, target: groupNumber, value: edgeCount }
    window.cybereumState.groups.links = window.cybereumState.groups.links || {};
    window.cybereumState.groups.links[groupType] = groupLinks.map(l => ({
        source: String(l.source.id || l.source),
        target: String(l.target.id || l.target),
        value: l.value
    }));
    _log(`[CybereumState] Stored ${groupLinks.length} inter-group links for ${groupType}`);

    const storedCount = Object.keys(window.cybereumState.groups[groupType]).length;
    _log(`[CybereumState] Stored ${storedCount} groups for ${groupType}`);

    // ── COMMISSIONING NEXUS: Build after groups are stored ──────────────
    // Gated behind feature flag — set window.cybereumState.enableCommissioningNexus = true to activate
    if (window.cybereumState.enableCommissioningNexus) {
        // Debounce so WBS + Community don't double-fire
        if (window._nexusBuildTimer) clearTimeout(window._nexusBuildTimer);
        window._nexusBuildTimer = setTimeout(() => {
            if (window.CommissioningNexus?.buildFromGroups) {
                const wbs = Object.keys(window.cybereumState.groups.WBS_ID || {}).length;
                const comm = Object.keys(window.cybereumState.groups.CommunityGroup || {}).length;
                console.log(`[CommissioningNexus] Groups stored → building Nexus (WBS=${wbs}, Community=${comm})`);
                if (wbs > 0 || comm > 0) {
                    try {
                        window.CommissioningNexus.buildFromGroups(null);
                        console.log('[CommissioningNexus] ✅ Nexus build complete');
                    } catch (e) {
                        console.warn('[CommissioningNexus] build error:', e);
                    }
                }
            }
        }, 800);
    }

    // =========================================================================
    // ADAPTIVE LAYOUT CONFIGURATION - Key improvement for large graphs
    // =========================================================================
    const layoutConfig = calculateAdaptiveLayoutConfig(nodeCount, width, height);

    function calculateAdaptiveLayoutConfig(count, w, h) {
        const area = w * h;
        const areaPerNode = area / Math.max(count, 1);

        // Calculate minimum radius needed to fit group number text
        // For count up to 9: 1 digit, up to 99: 2 digits, up to 999: 3 digits, 1000+: 4 digits
        const maxDigits = count >= 1000 ? 4 : count >= 100 ? 3 : count >= 10 ? 2 : 1;
        // Each digit needs ~6px width, so radius needs to be at least (digits * 6) / 2 + padding
        const minRadiusForText = (maxDigits * 6) / 2 + 4;

        // Calculate optimal node radius based on available area - INCREASED SIZES
        let nodeRadius;
        if (count <= 10) {
            nodeRadius = Math.min(45, Math.sqrt(areaPerNode) / 5);
        } else if (count <= 30) {
            nodeRadius = Math.min(35, Math.sqrt(areaPerNode) / 6);
        } else if (count <= 80) {
            nodeRadius = Math.min(28, Math.sqrt(areaPerNode) / 7);
        } else if (count <= 150) {
            nodeRadius = Math.min(22, Math.sqrt(areaPerNode) / 8);
        } else if (count <= 300) {
            nodeRadius = Math.min(18, Math.sqrt(areaPerNode) / 9);
        } else if (count <= 500) {
            nodeRadius = Math.min(15, Math.sqrt(areaPerNode) / 10);
        } else if (count <= 1000) {
            nodeRadius = Math.min(13, Math.sqrt(areaPerNode) / 12);
        } else {
            // 1000+ groups
            nodeRadius = Math.min(11, Math.sqrt(areaPerNode) / 14);
        }
        // Ensure minimum radius fits the text
        nodeRadius = Math.max(minRadiusForText, nodeRadius);

        // Calculate optimal spacing
        const spacing = nodeRadius * 3.5;

        // Determine layout strategy
        let layoutStrategy = 'force'; // Default
        if (count > 60) {
            layoutStrategy = 'hybrid'; // Use hierarchical with force refinement
        }
        if (count > 200) {
            layoutStrategy = 'hierarchical'; // Pure hierarchical for very large
        }

        // Calculate force parameters - SCALED PROPERLY for large graphs
        // The key insight: for large graphs, we need STRONGER repulsion and LONGER links
        let forceStrength, forceDistance, collisionRadius;

        if (count <= 10) {
            forceStrength = -800;
            forceDistance = 180;
            collisionRadius = nodeRadius + 25;
        } else if (count <= 30) {
            forceStrength = -600;
            forceDistance = 150;
            collisionRadius = nodeRadius + 20;
        } else if (count <= 80) {
            // Medium-large graphs - increase repulsion significantly
            forceStrength = -400 - (count * 2);
            forceDistance = 100 + (count * 0.8);
            collisionRadius = nodeRadius + 15;
        } else if (count <= 150) {
            // Large graphs - strong repulsion to spread nodes
            forceStrength = -300 - (count * 1.5);
            forceDistance = 80 + (count * 0.5);
            collisionRadius = nodeRadius + 10;
        } else if (count <= 500) {
            // Very large graphs
            forceStrength = -200 - (count * 0.8);
            forceDistance = 60 + (count * 0.3);
            collisionRadius = nodeRadius + 8;
        } else {
            // Massive graphs (500+ groups)
            forceStrength = -150 - (count * 0.5);
            forceDistance = 50 + (count * 0.2);
            collisionRadius = nodeRadius + 6;
        }

        // Calculate simulation parameters
        const simIterations = count > 500 ? 100 : count > 200 ? 150 : count > 100 ? 200 : count > 50 ? 250 : 300;
        const alpha = count > 100 ? 0.8 : 1;
        const alphaDecay = count > 500 ? 0.04 : count > 200 ? 0.03 : count > 100 ? 0.025 : 0.0228;

        // Calculate viewport expansion for large graphs
        // For large graphs, we expand the virtual canvas to prevent compression
        let virtualWidth = w;
        let virtualHeight = h;
        if (count > 50) {
            const expansionFactor = Math.min(6, 1 + (count - 50) / 80);
            virtualWidth = w * expansionFactor;
            virtualHeight = h * expansionFactor;
        }

        return {
            nodeRadius,
            spacing,
            layoutStrategy,
            forceStrength,
            forceDistance,
            collisionRadius,
            simIterations,
            alpha,
            alphaDecay,
            virtualWidth,
            virtualHeight,
            showLabels: count <= 80,
            showProgressText: count <= 60,
            linkOpacity: count > 300 ? 0.55 : count > 150 ? 0.65 : count > 80 ? 0.75 : 0.9,
            linkWidth: count > 300 ? 1.2 : count > 150 ? 1.5 : count > 80 ? 2.0 : 2.5
        };
    }

    const nodeRadius = layoutConfig.nodeRadius;

    // Create unique ID for this instance
    const uniqueId = `meta-graph-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const svg = d3.select(container)
        .append('svg')
        .style('width', '100%')
        .style('height', '100%')
        .style('display', 'block')
        .style('background', 'linear-gradient(135deg, #0a1929 0%, #0d2137 100%)')
        .attr('id', uniqueId);

    const defs = svg.append('defs');

    // Arrow marker - larger and more visible for clear direction indication
    const arrowSize = Math.max(8, Math.min(14, nodeRadius / 2));
    defs.append('marker')
        .attr('id', `arrowhead-${uniqueId}`)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 10)
        .attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', arrowSize)
        .attr('markerHeight', arrowSize)
        .append('path')
        .attr('d', 'M0,-4L10,0L0,4L2,0Z')  // Filled diamond-tipped arrow
        .attr('fill', groupManager.colors.primary)
        .style('stroke', 'none');

    // Glow filter for nodes
    const filter = defs.append('filter').attr('id', `glow-${uniqueId}`);
    filter.append('feGaussianBlur').attr('stdDeviation', '2').attr('result', 'coloredBlur');
    const feMerge = filter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Link glow filter for enhanced visibility
    const linkGlowFilter = defs.append('filter').attr('id', `link-glow-${uniqueId}`);
    linkGlowFilter.append('feGaussianBlur').attr('stdDeviation', '1.5').attr('result', 'linkBlur');
    const linkMerge = linkGlowFilter.append('feMerge');
    linkMerge.append('feMergeNode').attr('in', 'linkBlur');
    linkMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Main container group
    const root = svg.append('g').attr('class', 'main-container');

    // =========================================================================
    // ZOOM BEHAVIOR - Enhanced for large graphs
    // =========================================================================
    const zoomExtent = nodeCount > 100 ? [0.1, 6] : [0.3, 4];
    let currentTransform = d3.zoomIdentity;

    const zoom = d3.zoom()
        .scaleExtent(zoomExtent)
        .on('zoom', (event) => {
            const t = event.transform || d3.zoomIdentity;
            const validTransform = Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.k) && t.k > 0;
            if (!validTransform) {
                return;
            }
            currentTransform = t;
            root.attr('transform', t);
            updateMinimap();
        });

    svg.call(zoom);

    // =========================================================================
    // INITIAL POSITION CALCULATION - Spread nodes before simulation
    // =========================================================================
    function initializeNodePositions(nodes, strategy) {
        const vw = layoutConfig.virtualWidth;
        const vh = layoutConfig.virtualHeight;
        const centerX = vw / 2;
        const centerY = vh / 2;

        if (strategy === 'hierarchical' || strategy === 'hybrid') {
            // Sort nodes by earliest start date for temporal layout
            const sortedNodes = [...nodes].sort((a, b) => {
                const aStart = a.earliestStart ? new Date(a.earliestStart).getTime() : 0;
                const bStart = b.earliestStart ? new Date(b.earliestStart).getTime() : 0;
                return aStart - bStart;
            });

            // Calculate grid dimensions
            const cols = Math.ceil(Math.sqrt(nodes.length * (vw / vh)));
            const rows = Math.ceil(nodes.length / cols);
            const cellWidth = vw / (cols + 1);
            const cellHeight = vh / (rows + 1);

            sortedNodes.forEach((node, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                // Add some jitter for visual interest
                const jitterX = (Math.random() - 0.5) * cellWidth * 0.3;
                const jitterY = (Math.random() - 0.5) * cellHeight * 0.3;
                node.x = cellWidth * (col + 1) + jitterX;
                node.y = cellHeight * (row + 1) + jitterY;
            });
        } else {
            // Force-directed: spread in a circle initially
            const angleStep = (2 * Math.PI) / nodes.length;
            const radius = Math.min(vw, vh) * 0.35;

            nodes.forEach((node, i) => {
                const angle = i * angleStep;
                node.x = centerX + radius * Math.cos(angle);
                node.y = centerY + radius * Math.sin(angle);
            });
        }
    }

    initializeNodePositions(filteredGroupNodes, layoutConfig.layoutStrategy);

    // =========================================================================
    // FORCE SIMULATION - Properly configured for large graphs
    // =========================================================================
    const simulation = d3.forceSimulation(filteredGroupNodes)
        .force('link', d3.forceLink(groupLinks)
            .id(d => d.id)
            .distance(layoutConfig.forceDistance)
            .strength(0.3))
        .force('charge', d3.forceManyBody()
            .strength(layoutConfig.forceStrength)
            .distanceMax(layoutConfig.virtualWidth * 0.8))
        .force('center', d3.forceCenter(layoutConfig.virtualWidth / 2, layoutConfig.virtualHeight / 2)
            .strength(0.05))
        .force('collision', d3.forceCollide()
            .radius(layoutConfig.collisionRadius)
            .strength(0.8))
        .force('x', d3.forceX(layoutConfig.virtualWidth / 2).strength(0.02))
        .force('y', d3.forceY(layoutConfig.virtualHeight / 2).strength(0.02))
        .alpha(layoutConfig.alpha)
        .alphaDecay(layoutConfig.alphaDecay);

    // For very large graphs, add boundary forces
    if (nodeCount > 100) {
        simulation.force('boundary', () => {
            filteredGroupNodes.forEach(node => {
                const margin = nodeRadius * 2;
                const vw = layoutConfig.virtualWidth;
                const vh = layoutConfig.virtualHeight;

                if (node.x < margin) node.vx += (margin - node.x) * 0.1;
                if (node.x > vw - margin) node.vx -= (node.x - (vw - margin)) * 0.1;
                if (node.y < margin) node.vy += (margin - node.y) * 0.1;
                if (node.y > vh - margin) node.vy -= (node.y - (vh - margin)) * 0.1;
            });
        });
    }

    // =========================================================================
    // RENDER LINKS
    // =========================================================================
    const linkGroup = root.append('g').attr('class', 'links');

    const link = linkGroup.selectAll('path')
        .data(groupLinks)
        .enter().append('path')
        .attr('stroke', d => {
            // Color links based on strength - use brighter, more visible colors
            const maxValue = Math.max(...groupLinks.map(l => l.value));
            const intensity = d.value / maxValue;
            // Brighter cyan palette for visibility
            return d3.interpolateRgb('#4fc3f7', '#00e5ff')(intensity);
        })
        .attr('stroke-opacity', layoutConfig.linkOpacity)
        .attr('stroke-width', d => Math.max(layoutConfig.linkWidth, Math.sqrt(d.value) * layoutConfig.linkWidth * 1.3))
        .attr('fill', 'none')
        .attr('stroke-linecap', 'round')
        .style('filter', nodeCount <= 200 ? `url(#link-glow-${uniqueId})` : 'none')
        .attr('marker-end', `url(#arrowhead-${uniqueId})`);

    // =========================================================================
    // RENDER NODES
    // =========================================================================
    const nodeGroup = root.append('g').attr('class', 'nodes');

    const nodes = nodeGroup.selectAll('g')
        .data(filteredGroupNodes)
        .enter().append('g')
        .attr('class', 'node-group')
        .style('cursor', 'pointer')
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));

    // Main node circle - colored by relative risk
    nodes.append('circle')
        .attr('class', 'node-main')
        .attr('r', nodeRadius)
        .attr('fill', d => riskColorScale(d.relativeRiskScore))
        .attr('stroke', '#fff')
        .attr('stroke-width', nodeRadius > 15 ? 2 : 1)
        .style('filter', nodeCount <= 80 ? `url(#glow-${uniqueId})` : 'none');

    // Progress ring - only for smaller graphs or when node is large enough
    if (nodeRadius >= 10) {
        nodes.append('circle')
            .attr('class', 'progress-ring')
            .attr('r', nodeRadius + 3)
            .attr('fill', 'none')
            .attr('stroke', d => {
                const progress = parseFloat(d.progress);
                if (progress >= 100) return '#50fa7b';
                if (progress >= 75) return '#8be9fd';
                if (progress >= 50) return '#ffb86c';
                if (progress > 0) return '#ff5555';
                return 'transparent';
            })
            .attr('stroke-width', Math.max(2, nodeRadius / 6))
            .attr('stroke-dasharray', d => {
                const progress = parseFloat(d.progress);
                if (progress >= 100) return 'none';
                const radius = nodeRadius + 3;
                const circumference = 2 * Math.PI * radius;
                const dashLength = (progress / 100) * circumference;
                return `${dashLength} ${circumference}`;
            })
            .attr('stroke-dashoffset', d => {
                const progress = parseFloat(d.progress);
                if (progress >= 100) return 0;
                const radius = nodeRadius + 3;
                return (2 * Math.PI * radius) / 4;
            })
            .attr('transform', d => parseFloat(d.progress) >= 100 ? '' : 'rotate(-90)')
            .attr('opacity', 0.9)
            .attr('stroke-linecap', 'round');
    }

    // Group NUMBER inside the circle - ALWAYS visible
    // Font size calculated to fit the number inside the node
    nodes.append('text')
        .attr('class', 'node-number')
        .text(d => d.id)
        .attr('font-size', d => {
            const digits = String(d.id).length;
            // Calculate max font size that fits: nodeRadius * 2 is diameter, 
            // each digit is ~0.6 of font size wide
            const maxFontForWidth = (nodeRadius * 1.6) / (digits * 0.6);
            const maxFontForHeight = nodeRadius * 1.4;
            return Math.max(8, Math.min(maxFontForWidth, maxFontForHeight, 18));
        })
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('dy', '0.05em')
        .attr('fill', d => {
            // Use contrasting color based on background
            return d.relativeRiskScore < 0.5 ? '#000' : '#fff';
        })
        .attr('font-weight', 'bold')
        .style('pointer-events', 'none')
        .style('font-family', 'Arial, sans-serif');

    // Name labels ABOVE node - conditional based on graph size
    if (layoutConfig.showLabels) {
        nodes.append('text')
            .attr('class', 'node-label')
            .text(d => d.displayName || d.name)
            .attr('font-size', Math.max(8, nodeRadius * 0.5))
            .attr('text-anchor', 'middle')
            .attr('dy', -(nodeRadius + 6))
            .attr('fill', groupManager.colors.text)
            .style('pointer-events', 'none')
            .style('text-shadow', '1px 1px 2px rgba(0,0,0,0.8)')
            .style('font-weight', '500');
    }

    // =========================================================================
    // TOOLTIP
    // =========================================================================
    let tooltip = d3.select('body').select('.meta-graph-tooltip');
    if (tooltip.empty()) {
        tooltip = d3.select('body').append('div')
            .attr('class', 'meta-graph-tooltip')
            .style('opacity', 0)
            .style('position', 'absolute')
            .style('background-color', groupManager.colors.bgDark + 'F8')
            .style('color', groupManager.colors.text)
            .style('border', `1px solid ${groupManager.colors.primary}`)
            .style('border-radius', '6px')
            .style('padding', '12px')
            .style('font-family', 'Arial, sans-serif')
            .style('pointer-events', 'none')
            .style('box-shadow', '0 4px 16px rgba(0,0,0,0.5)')
            .style('max-width', '300px')
            .style('z-index', '10000')
            .style('font-size', '12px');
    }

    nodes.on('mouseover', function (event, d) {
        // Highlight connected nodes
        const connectedIds = new Set();
        groupLinks.forEach(link => {
            if (link.source.id === d.id) connectedIds.add(link.target.id);
            if (link.target.id === d.id) connectedIds.add(link.source.id);
        });

        nodes.style('opacity', n => n.id === d.id || connectedIds.has(n.id) ? 1 : 0.3);
        link.style('opacity', l => l.source.id === d.id || l.target.id === d.id ? 1 : 0.25);

        const riskColor = riskColorScale(d.relativeRiskScore);
        const riskLevel = d.relativeRiskScore < 0.33 ? 'LOW' :
            d.relativeRiskScore < 0.66 ? 'MEDIUM' : 'HIGH';

        tooltip.transition().duration(150).style('opacity', 0.98);
        tooltip.html(`
            <div style="font-weight: bold; color: ${groupManager.colors.primary}; margin-bottom: 8px; font-size: 13px; border-bottom: 1px solid ${groupManager.colors.primary}40; padding-bottom: 6px;">
                ${d.name}
            </div>
            ${d.displayName !== d.name ? `<div style="color: #8ce6ff; font-style: italic; margin-bottom: 8px; font-size: 11px;">${d.displayName}</div>` : ''}
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px;">
                <div><span style="color: #8ce6ff;">Status:</span></div>
                <div style="text-align: right; color: ${d.status === 'completed' ? '#50fa7b' : d.status === 'in-progress' ? '#ffb86c' : '#8ce6ff80'};">
                    ${d.status === 'completed' ? '✓ Completed' : d.status === 'in-progress' ? '⚡ Active' : '◷ Not Started'}
                </div>
                <div><span style="color: #8ce6ff;">Progress:</span></div>
                <div style="text-align: right; color: ${parseFloat(d.progress) >= 75 ? '#50fa7b' : '#ffb86c'};">${d.progress}%</div>
                <div><span style="color: #8ce6ff;">Activities (✓/⚡/◷):</span></div>
                <div style="text-align: right;">
                    <span style="color: #50fa7b;">${d.completedNodes || 0}</span> / 
                    <span style="color: #ffb86c;">${d.inProgressNodes || 0}</span> / 
                    <span style="color: #8ce6ff80;">${d.notStartedNodes || 0}</span>
                </div>
            </div>
            <div style="margin-top: 8px; padding: 6px; background: ${riskColor}20; border-radius: 4px; border-left: 3px solid ${riskColor};">
                <span style="color: #8ce6ff;">Risk Level:</span>
                <span style="float: right; color: ${riskColor}; font-weight: bold;">${riskLevel}</span>
            </div>
            <div style="margin-top: 6px; font-size: 10px; color: #8ce6ff;">
                ${groupManager.formatDate(d.earliestStart)} → ${groupManager.formatDate(d.latestEnd)}
            </div>
        `)
            .style('left', (event.pageX + 15) + 'px')
            .style('top', (event.pageY - 10) + 'px');

        // Highlight this node
        d3.select(this).select('.node-main')
            .transition().duration(150)
            .attr('stroke-width', nodeRadius > 15 ? 4 : 2)
            .attr('r', nodeRadius * 1.1);
    })
        .on('mouseout', function () {
            nodes.style('opacity', 1);
            link.style('opacity', layoutConfig.linkOpacity);
            tooltip.transition().duration(300).style('opacity', 0);

            d3.select(this).select('.node-main')
                .transition().duration(150)
                .attr('stroke-width', nodeRadius > 15 ? 2 : 1)
                .attr('r', nodeRadius);
        })
        .on('click', (event, d) => {
            // Scroll to group section
            const groupSection = document.getElementById(`group-section-${d.originalId}`);
            if (groupSection) {
                groupSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            _log(`[MetaNetwork] Group ${d.id} (${d.displayName}) clicked`);
        });

    // =========================================================================
    // SIMULATION TICK
    // =========================================================================
    simulation.on('tick', () => {
        // Update link paths - CURVED BEZIER for visual clarity
        link.attr('d', d => {
            const dx = d.target.x - d.source.x;
            const dy = d.target.y - d.source.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist === 0) return '';

            const normX = dx / dist;
            const normY = dy / dist;

            // Start from source node edge
            const sourceX = d.source.x + (nodeRadius * normX);
            const sourceY = d.source.y + (nodeRadius * normY);
            // End at target node edge
            const targetX = d.target.x - (nodeRadius * normX);
            const targetY = d.target.y - (nodeRadius * normY);

            // Calculate curve control point - perpendicular offset for arc
            // Offset scales with distance but caps for very long links
            const curvature = Math.min(0.2, 30 / dist);
            const midX = (sourceX + targetX) / 2;
            const midY = (sourceY + targetY) / 2;
            // Perpendicular vector (rotate 90 degrees)
            const perpX = -normY * dist * curvature;
            const perpY = normX * dist * curvature;
            const ctrlX = midX + perpX;
            const ctrlY = midY + perpY;

            // Quadratic bezier curve: M(start) Q(control, end)
            return `M${sourceX},${sourceY}Q${ctrlX},${ctrlY} ${targetX},${targetY}`;
        });

        // Update node positions with boundary constraints
        nodes.attr('transform', d => {
            const margin = nodeRadius + 5;
            const vw = layoutConfig.virtualWidth;
            const vh = layoutConfig.virtualHeight;
            d.x = Math.max(margin, Math.min(vw - margin, d.x));
            d.y = Math.max(margin, Math.min(vh - margin, d.y));
            return `translate(${d.x},${d.y})`;
        });
    });

    // Run simulation to completion for initial layout
    simulation.tick(layoutConfig.simIterations);

    // Calculate bounds and fit to view
    setTimeout(() => {
        fitToView(true);
    }, 100);

    // =========================================================================
    // DRAG HANDLERS
    // =========================================================================
    function dragstarted(event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
    }

    function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
    }

    function dragended(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
    }

    // =========================================================================
    // FIT TO VIEW FUNCTION
    // =========================================================================
    function fitToView(animate = true) {
        if (filteredGroupNodes.length === 0) return;

        // Calculate bounding box of all nodes
        const validNodes = filteredGroupNodes.filter(d => Number.isFinite(d.x) && Number.isFinite(d.y));
        if (!validNodes.length) return;

        const xs = validNodes.map(d => d.x);
        const ys = validNodes.map(d => d.y);
        const minX = Math.min(...xs) - nodeRadius - 10;
        const maxX = Math.max(...xs) + nodeRadius + 10;
        const minY = Math.min(...ys) - nodeRadius - 10;
        const maxY = Math.max(...ys) + nodeRadius + 10;

        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;

        // Account for UI panels
        const leftPadding = 230; // Summary panel
        const rightPadding = 50; // Controls
        const topPadding = 20;
        const bottomPadding = 60; // Legend

        const availableWidth = width - leftPadding - rightPadding;
        const availableHeight = height - topPadding - bottomPadding;

        const safeContentWidth = Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 1;
        const safeContentHeight = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 1;

        const scaleX = availableWidth / safeContentWidth;
        const scaleY = availableHeight / safeContentHeight;
        const scale = Math.max(0.1, Math.min(scaleX, scaleY, 2.5) * 0.95); // Cap at 2.5x, use 95%

        // Content center in simulation coordinates
        const contentCenterX = (minX + maxX) / 2;
        const contentCenterY = (minY + maxY) / 2;

        // Center of available viewport area (accounting for panels)
        const viewportCenterX = leftPadding + (availableWidth / 2);
        const viewportCenterY = topPadding + (availableHeight / 2);

        // Translate so content center aligns with viewport center
        const translateX = viewportCenterX - (contentCenterX * scale);
        const translateY = viewportCenterY - (contentCenterY * scale);

        if (![translateX, translateY, scale].every(Number.isFinite)) return;

        const transform = d3.zoomIdentity.translate(translateX, translateY).scale(scale);

        if (animate) {
            svg.transition().duration(500).call(zoom.transform, transform);
        } else {
            svg.call(zoom.transform, transform);
        }
    }

    // =========================================================================
    // CONTROL PANEL
    // =========================================================================
    const controlPanel = d3.select(container).append('div')
        .attr('class', 'meta-graph-controls')
        .style('position', 'absolute')
        .style('top', '10px')
        .style('right', '10px')
        .style('display', 'flex')
        .style('flex-direction', 'column')
        .style('gap', '4px')
        .style('z-index', '100');

    // Helper function to create styled buttons
    function createControlButton(parent, title, symbol, onClick) {
        const btn = parent.append('button')
            .attr('title', title)
            .attr('type', 'button')
            .style('padding', '0')
            .style('margin', '0')
            .style('width', '32px')
            .style('height', '32px')
            .style('min-height', '32px')
            .style('max-height', '32px')
            .style('line-height', '30px')
            .style('background', 'rgba(13, 33, 55, 0.95)')
            .style('border', `1px solid ${groupManager.colors.primary}`)
            .style('border-radius', '4px')
            .style('color', groupManager.colors.text)
            .style('cursor', 'pointer')
            .style('font-size', '16px')
            .style('font-family', 'Arial, sans-serif')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('justify-content', 'center')
            .style('box-sizing', 'border-box')
            .style('transition', 'all 0.2s')
            .style('outline', 'none')
            .html(symbol)
            .on('click', onClick)
            .on('mouseover', function () {
                d3.select(this)
                    .style('background', groupManager.colors.primary)
                    .style('color', '#000');
            })
            .on('mouseout', function () {
                d3.select(this)
                    .style('background', 'rgba(13, 33, 55, 0.95)')
                    .style('color', groupManager.colors.text);
            });
        return btn;
    }

    // Fit to view button
    createControlButton(controlPanel, 'Fit to View', '⊡', () => fitToView(true));

    // Zoom in
    createControlButton(controlPanel, 'Zoom In', '+', () => svg.transition().duration(300).call(zoom.scaleBy, 1.4));

    // Zoom out
    createControlButton(controlPanel, 'Zoom Out', '−', () => svg.transition().duration(300).call(zoom.scaleBy, 0.7));

    // Reset view
    createControlButton(controlPanel, 'Reset View', '↺', () => {
        simulation.alpha(0.5).restart();
        setTimeout(() => fitToView(true), 500);
    });

    // =========================================================================
    // MINIMAP - For large graphs
    // =========================================================================
    let minimapGroup = null;
    let minimapViewport = null;

    function updateMinimap() {
        if (!minimapGroup || !minimapViewport) return;

        const scale = currentTransform.k;
        const tx = -currentTransform.x / scale;
        const ty = -currentTransform.y / scale;
        const vw = width / scale;
        const vh = height / scale;

        minimapViewport
            .attr('x', tx * 0.15)
            .attr('y', ty * 0.15)
            .attr('width', vw * 0.15)
            .attr('height', vh * 0.15);
    }

    if (nodeCount > 40) {
        const minimapContainer = d3.select(container).append('div')
            .attr('class', 'minimap-container')
            .style('position', 'absolute')
            .style('bottom', '20px')
            .style('left', '10px')
            .style('width', '150px')
            .style('height', '100px')
            .style('background', 'rgba(13, 33, 55, 0.9)')
            .style('border', `1px solid ${groupManager.colors.primary}`)
            .style('border-radius', '4px')
            .style('overflow', 'hidden')
            .style('z-index', '100');

        const minimapSvg = minimapContainer.append('svg')
            .attr('width', '100%')
            .attr('height', '100%')
            .attr('viewBox', `0 0 ${layoutConfig.virtualWidth * 0.15} ${layoutConfig.virtualHeight * 0.15}`);

        minimapGroup = minimapSvg.append('g');

        // Draw minimap nodes
        minimapGroup.selectAll('circle')
            .data(filteredGroupNodes)
            .enter().append('circle')
            .attr('cx', d => d.x * 0.15)
            .attr('cy', d => d.y * 0.15)
            .attr('r', 2)
            .attr('fill', d => riskColorScale(d.relativeRiskScore));

        // Viewport indicator
        minimapViewport = minimapSvg.append('rect')
            .attr('class', 'minimap-viewport')
            .attr('fill', 'none')
            .attr('stroke', groupManager.colors.primary)
            .attr('stroke-width', 1)
            .attr('x', 0)
            .attr('y', 0)
            .attr('width', width * 0.15)
            .attr('height', height * 0.15);

        // Click on minimap to navigate
        minimapSvg.on('click', function (event) {
            const [mx, my] = d3.pointer(event);
            const targetX = mx / 0.15;
            const targetY = my / 0.15;

            const transform = d3.zoomIdentity
                .translate(width / 2 - targetX * currentTransform.k, height / 2 - targetY * currentTransform.k)
                .scale(currentTransform.k);

            svg.transition().duration(300).call(zoom.transform, transform);
        });
    }

    // =========================================================================
    // SUMMARY PANEL
    // =========================================================================
    const aggregatePanel = d3.select(container).append('div')
        .attr('class', 'aggregate-panel')
        .style('position', 'absolute')
        .style('top', '10px')
        .style('left', '10px')
        .style('background', 'rgba(13, 33, 55, 0.95)')
        .style('padding', '12px 15px')
        .style('border-radius', '8px')
        .style('border', `1px solid ${groupManager.colors.primary}`)
        .style('min-width', '200px')
        .style('max-width', '220px')
        .style('box-shadow', '0 4px 12px rgba(0,0,0,0.4)')
        .style('z-index', '100');

    aggregatePanel.append('div')
        .style('color', groupManager.colors.primary)
        .style('font-weight', 'bold')
        .style('margin-bottom', '10px')
        .style('font-size', '13px')
        .style('border-bottom', `1px solid ${groupManager.colors.primary}40`)
        .style('padding-bottom', '6px')
        .text('📊 Network Summary');

    const statsGrid = aggregatePanel.append('div')
        .style('display', 'grid')
        .style('grid-template-columns', '1fr auto')
        .style('gap', '4px 8px')
        .style('font-size', '12px');

    const addStat = (label, value, color = groupManager.colors.text) => {
        statsGrid.append('div').style('color', '#8ce6ff').text(label);
        statsGrid.append('div').style('color', color).style('text-align', 'right').style('font-weight', '600').text(value);
    };

    addStat('Total Groups:', groupNodes.length);
    addStat('Visible:', filteredGroupNodes.length, '#8be9fd');
    addStat('Connections:', groupLinks.length, '#bd93f9');

    // Group status breakdown (consistent with Panopticon)
    addStat('✓ Completed:', completedGroupCount, '#50fa7b');
    addStat('⚡ Active:', inProgressGroupCount, '#ffb86c');
    addStat('◷ Not Started:', notStartedGroupCount, '#8ce6ff80');

    // Activity breakdown
    addStat('Activities:', `${completedActivities}✓ ${inProgressActivities}⚡ ${notStartedActivities}◷`);

    addStat('Progress:', `${overallProgress.toFixed(1)}%`, overallProgress >= 75 ? '#50fa7b' : overallProgress >= 50 ? '#ffb86c' : '#ff5555');

    // Progress bar
    aggregatePanel.append('div')
        .style('width', '100%')
        .style('height', '6px')
        .style('background-color', '#195a8c')
        .style('border-radius', '3px')
        .style('margin-top', '10px')
        .style('overflow', 'hidden')
        .append('div')
        .style('height', '100%')
        .style('width', `${overallProgress}%`)
        .style('background', 'linear-gradient(to right, #50fa7b, #5ac8fa)')
        .style('border-radius', '3px')
        .style('transition', 'width 0.3s ease');

    // Layout info for large graphs
    if (nodeCount > 50) {
        aggregatePanel.append('div')
            .style('margin-top', '10px')
            .style('padding-top', '8px')
            .style('border-top', `1px solid ${groupManager.colors.primary}30`)
            .style('font-size', '10px')
            .style('color', '#8ce6ff')
            .html(`<span style="color: #bd93f9;">Layout:</span> ${layoutConfig.layoutStrategy}<br>
                   <span style="color: #8ce6ff; font-style: italic;">Click nodes to navigate</span>`);
    }

    // =========================================================================
    // RISK LEGEND - Horizontal layout at bottom right
    // =========================================================================
    const legendContainer = d3.select(container).append('div')
        .attr('class', 'risk-legend')
        .style('position', 'absolute')
        .style('bottom', '12px')
        .style('right', '12px')
        .style('background', 'rgba(13, 33, 55, 0.92)')
        .style('padding', '8px 14px')
        .style('border-radius', '6px')
        .style('border', `1px solid ${groupManager.colors.primary}50`)
        .style('z-index', '100')
        .style('display', 'flex')
        .style('align-items', 'center')
        .style('gap', '14px');

    legendContainer.append('span')
        .style('color', groupManager.colors.primary)
        .style('font-weight', '600')
        .style('font-size', '11px')
        .text('Risk:');

    const riskLevels = [
        { label: 'Low', color: '#50fa7b' },
        { label: 'Medium', color: '#ffb86c' },
        { label: 'High', color: '#ff5555' }
    ];

    riskLevels.forEach(level => {
        const levelDiv = legendContainer.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '5px')
            .style('font-size', '10px');

        levelDiv.append('div')
            .style('width', '10px')
            .style('height', '10px')
            .style('border-radius', '50%')
            .style('background-color', level.color)
            .style('border', '1px solid rgba(255,255,255,0.3)')
            .style('box-shadow', `0 0 4px ${level.color}50`);

        levelDiv.append('span')
            .style('color', groupManager.colors.text)
            .text(level.label);
    });

    // =========================================================================
    // TITLE
    // =========================================================================
    svg.append('text')
        .attr('x', width / 2)
        .attr('y', 25)
        .attr('text-anchor', 'middle')
        .attr('fill', groupManager.colors.primary)
        .style('font-family', 'Arial, sans-serif')
        .style('font-size', '14px')
        .style('font-weight', 'bold')
        .style('opacity', 0.9)
        .text(`${groupType.replace('_', ' ')} Network · ${filteredGroupNodes.length} Groups · ${groupLinks.length} Dependencies`);

    _log(`[MetaNetwork] Rendered with layout strategy: ${layoutConfig.layoutStrategy}, nodeRadius: ${nodeRadius.toFixed(1)}`);
}

// ============================================================================
// DRAW GRAPH FOR COMMUNITY GROUP - RESTORED WITH NAVIGATION
// ============================================================================
function drawGraphForCommunityGroup(svg, allNodes, allLinks, groupId, groupType) {
    if (!svg || !allNodes || !allLinks || groupId == null) {
        console.error('Missing required parameters for drawGraphForCommunityGroup');
        return;
    }

    const colors = {
        bgDark: '#0d2137',
        bgLight: '#102d50',
        primary: '#46b9fa',
        secondary: '#41afeb',
        groupNode: '#FFD700',  // Gold for group nodes
        connectedNode: '#287dc8', // Blue for connected nodes
        text: '#cdfaff',
        error: '#ff5555'
    };

    svg.selectAll("*").remove();
    const uniqueId = `graph-${groupType}-${groupId}-${Date.now()}`;

    const containerNode = svg.node().parentNode;
    let containerWidth = containerNode.clientWidth || 800;
    let containerHeight = containerNode.clientHeight || 600;

    svg.attr('width', '100%')
        .attr('height', '100%')
        .attr('viewBox', [0, 0, containerWidth, containerHeight])
        .style('background-color', colors.bgDark);

    const container = svg.append('g')
        .attr('class', 'container')
        .attr('transform', `translate(${containerWidth / 2}, ${containerHeight / 2})`);

    // Process nodes and links
    const nodeMap = new Map();
    const groupNodeIds = new Set();
    const connectedNodeIds = new Set();
    const processedLinks = [];

    allNodes.forEach(node => {
        nodeMap.set(node.ID, node);
        const nodeGroupValue = node[groupType];
        if (nodeGroupValue == groupId) {
            groupNodeIds.add(node.ID);
        }
    });

    allLinks.forEach(link => {
        const sourceID = typeof link.source === 'object' ? link.source.ID : link.source;
        const targetID = typeof link.target === 'object' ? link.target.ID : link.target;

        if (groupNodeIds.has(sourceID) || groupNodeIds.has(targetID)) {
            connectedNodeIds.add(sourceID);
            connectedNodeIds.add(targetID);
            processedLinks.push({
                source: sourceID,
                target: targetID,
                value: link.value || 1
            });
        }
    });

    const allNodesInGraph = Array.from(connectedNodeIds).map(id => nodeMap.get(id));
    const idToNodeMap = new Map(allNodesInGraph.map(node => [node.ID, node]));

    const graphLinks = processedLinks.map(link => ({
        source: idToNodeMap.get(link.source),
        target: idToNodeMap.get(link.target),
        value: link.value
    }));

    // Tooltip
    const tooltip = d3.select('body').selectAll('.graph-tooltip').data([null])
        .join('div')
        .attr('class', 'graph-tooltip')
        .style('position', 'absolute')
        .style('visibility', 'hidden')
        .style('background-color', colors.bgDark)
        .style('color', colors.text)
        .style('padding', '12px')
        .style('border-radius', '6px')
        .style('border', `1px solid ${colors.primary}`)
        .style('font-size', '12px')
        .style('pointer-events', 'none')
        .style('z-index', '1000')
        .style('box-shadow', `0 4px 12px ${colors.bgDark}80`)
        .style('max-width', '300px');

    // Zoom
    const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
            container.attr('transform', event.transform);
            updateZoomSlider(event.transform.k);
        });

    svg.call(zoom);

    // Definitions
    const defs = svg.append('defs');

    defs.append('marker')
        .attr('id', `arrowhead-${uniqueId}`)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 18)
        .attr('refY', 0)
        .attr('orient', 'auto')
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .append('path')
        .attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', colors.text);

    const glowFilter = defs.append('filter').attr('id', `glow-${uniqueId}`);
    glowFilter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur');
    const feMerge = glowFilter.append('feMerge');
    feMerge.append('feMergeNode').attr('in', 'coloredBlur');
    feMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Links
    const link = container.append('g')
        .attr('class', 'links')
        .selectAll('path')
        .data(graphLinks)
        .join('path')
        .attr('stroke', colors.secondary)
        .attr('stroke-width', d => Math.sqrt(d.value) * 1.5)
        .attr('fill', 'none')
        .attr('marker-end', `url(#arrowhead-${uniqueId})`);

    // Nodes
    const node = container.append('g')
        .attr('class', 'nodes')
        .selectAll('g')
        .data(allNodesInGraph)
        .join('g');

    const nodeEnter = node.append('g')
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended));

    // DIFFERENTIATE: Group nodes vs connected nodes
    nodeEnter.append('circle')
        .attr('r', d => groupNodeIds.has(d.ID) ? 24 : 18)
        .style('fill', d => groupNodeIds.has(d.ID) ? colors.groupNode : colors.connectedNode)
        .style('stroke', d => groupNodeIds.has(d.ID) ? '#ff6600' : colors.text)
        .style('stroke-width', d => groupNodeIds.has(d.ID) ? '3' : '2')
        .style('filter', d => groupNodeIds.has(d.ID) ? `url(#glow-${uniqueId})` : 'none');

    // Add progress rings around nodes - FIXED: Thicker, clearer, 100% closed
    nodeEnter.append('circle')
        .attr('r', d => groupNodeIds.has(d.ID) ? 26 : 20) // Reduced gap: was 28/22, now 26/20
        .attr('fill', 'none')
        .attr('stroke', d => {
            const progress = parseFloat(d.PercentComplete) || 0;
            if (progress >= 100) return '#50fa7b';  // Green for complete
            if (progress >= 75) return '#8be9fd';    // Cyan for 75-99%
            if (progress >= 50) return '#ffb86c';    // Orange for 50-74%
            if (progress > 0) return '#ff5555';      // Red for 1-49%
            return 'transparent';                     // No ring for 0%
        })
        .attr('stroke-width', '5') // Increased from 3 to 5 for clarity
        .attr('stroke-dasharray', d => {
            const progress = parseFloat(d.PercentComplete) || 0;
            if (progress >= 100) return 'none'; // Full circle at 100% - no dashes
            const radius = groupNodeIds.has(d.ID) ? 26 : 20;
            const circumference = 2 * Math.PI * radius;
            const dashLength = (progress / 100) * circumference;
            return `${dashLength} ${circumference}`;
        })
        .attr('stroke-dashoffset', d => {
            const progress = parseFloat(d.PercentComplete) || 0;
            if (progress >= 100) return 0; // No offset at 100%
            const radius = groupNodeIds.has(d.ID) ? 26 : 20;
            const circumference = 2 * Math.PI * radius;
            return circumference / 4;
        })
        .attr('transform', d => {
            const progress = parseFloat(d.PercentComplete) || 0;
            return progress >= 100 ? '' : 'rotate(-90)'; // No rotation needed at 100%
        })
        .attr('opacity', 0.9) // Increased from 0.8 for more visibility
        .attr('stroke-linecap', 'round'); // Rounded ends for smoother appearance

    nodeEnter.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', '.35em')
        .text(d => d.ID)
        .style('fill', d => groupNodeIds.has(d.ID) ? '#000' : colors.text)
        .style('font-size', d => groupNodeIds.has(d.ID) ? '12px' : '10px')
        .style('font-weight', d => groupNodeIds.has(d.ID) ? 'bold' : 'normal')
        .style('pointer-events', 'none');

    // Tooltips
    nodeEnter.on('mouseover', function (event, d) {
        const formatDate = date => !isNaN(date) ?
            date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A';

        const isGroupNode = groupNodeIds.has(d.ID);
        const nodeType = isGroupNode ? '⭐ GROUP NODE' : '🔗 CONNECTED NODE';
        const bgColor = isGroupNode ? 'rgba(255, 215, 0, 0.2)' : 'rgba(40, 125, 200, 0.2)';

        tooltip.html(`
            <div style="font-weight: bold; margin-bottom: 8px; color: ${isGroupNode ? colors.groupNode : colors.connectedNode}; padding: 4px; background: ${bgColor}; border-radius: 4px;">
                ${nodeType}
            </div>
            <div style="font-weight: bold; color: ${colors.primary}">${d.Name || 'Unnamed'}</div>
            <div style="color: ${colors.text}; margin-top: 8px;">
                <div style="margin: 4px 0"><strong>ID:</strong> ${d.ID}</div>
                <div style="margin: 4px 0"><strong>Duration:</strong> ${d.Duration || 'N/A'} hours</div>
                <div style="margin: 4px 0"><strong>Start:</strong> ${formatDate(new Date(d.Start))}</div>
                <div style="margin: 4px 0"><strong>End:</strong> ${formatDate(new Date(d.Finish))}</div>
                <div style="margin: 4px 0"><strong>Progress:</strong> ${d.PercentComplete || 0}%</div>
                ${d.WBS_Name ? `<div style="margin: 4px 0"><strong>WBS:</strong> ${d.WBS_Name}</div>` : ''}
            </div>
        `)
            .style('visibility', 'visible')
            .style('left', `${event.pageX + 10}px`)
            .style('top', `${event.pageY - 10}px`);

        const connectedNodes = new Set();
        graphLinks.forEach(link => {
            if (link.source.ID === d.ID) connectedNodes.add(link.target.ID);
            if (link.target.ID === d.ID) connectedNodes.add(link.source.ID);
        });

        nodeEnter.select('circle')
            .style('opacity', n => n.ID === d.ID || connectedNodes.has(n.ID) ? 1 : 0.3);
        link.style('opacity', l => l.source.ID === d.ID || l.target.ID === d.ID ? 1 : 0.1);

    }).on('mouseout', function () {
        tooltip.style('visibility', 'hidden');
        nodeEnter.select('circle').style('opacity', 1);
        link.style('opacity', 1);
    });

    // Force simulation
    const simulation = d3.forceSimulation(allNodesInGraph)
        .force('link', d3.forceLink(graphLinks).id(d => d.ID).distance(100))
        .force('charge', d3.forceManyBody().strength(-400))
        .force('center', d3.forceCenter(0, 0))
        .force('collision', d3.forceCollide().radius(30));

    // AUTO-FIT FUNCTION: Fits graph to container bounds
    function fitToViewAuto(animate = true) {
        const bounds = container.node().getBBox();
        if (bounds.width === 0 || bounds.height === 0) return;

        const scale = 0.85 / Math.max(bounds.width / containerWidth, bounds.height / containerHeight);
        const translate = [
            containerWidth / 2 - scale * (bounds.x + bounds.width / 2),
            containerHeight / 2 - scale * (bounds.y + bounds.height / 2)
        ];

        if (animate) {
            svg.transition().duration(500).call(
                zoom.transform,
                d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
            );
        } else {
            svg.call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
        }
    }

    simulation.on('tick', () => {
        link.attr('d', d => {
            const r = groupNodeIds.has(d.source.ID) ? 24 : 18;
            let dx = d.target.x - d.source.x;
            let dy = d.target.y - d.source.y;
            let dr = Math.sqrt(dx * dx + dy * dy) || 1; // Added || 1 to prevent NaN
            const normX = dx / dr;
            const normY = dy / dr;
            const sourceX = d.source.x + normX * r;
            const sourceY = d.source.y + normY * r;
            const targetX = d.target.x - normX * r;
            const targetY = d.target.y - normY * r;
            return `M${sourceX},${sourceY}L${targetX},${targetY}`;
        });

        nodeEnter.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    // AUTO-FIT ON SIMULATION END: Automatically fit graph when physics simulation completes
    simulation.on('end', () => {
        _log(`[Graph ${groupId}] Simulation complete - auto-fitting to view`);
        fitToViewAuto(true);
    });

    // FALLBACK AUTO-FIT: If simulation doesn't fully complete, fit after timeout
    setTimeout(() => {
        if (simulation.alpha() < 0.1) {
            fitToViewAuto(true);
        }
    }, 2000);

    // RESTORED: Control panel
    const controlsContainer = document.createElement('div');
    controlsContainer.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px;
        background-color: rgba(13, 33, 55, 0.9);
        border-radius: 6px;
        border: 1px solid ${colors.primary};
        z-index: 100;
    `;

    function createButton(icon, tooltip, onClick) {
        const button = document.createElement('button');
        button.innerHTML = icon;
        button.title = tooltip;
        button.style.cssText = `
            margin: 2px;
            padding: 4px 8px;
            height: 28px;
            min-width: 28px;
            background-color: ${colors.bgLight};
            border: 1px solid ${colors.primary};
            border-radius: 4px;
            color: ${colors.text};
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
        `;
        button.addEventListener('mouseover', () => {
            button.style.backgroundColor = colors.primary;
            button.style.color = colors.bgDark;
        });
        button.addEventListener('mouseout', () => {
            button.style.backgroundColor = colors.bgLight;
            button.style.color = colors.text;
        });
        button.addEventListener('click', onClick);
        return button;
    }

    controlsContainer.appendChild(createButton('🔍+', 'Zoom In', () => {
        svg.transition().duration(300).call(zoom.scaleBy, 1.2);
    }));

    controlsContainer.appendChild(createButton('🔍-', 'Zoom Out', () => {
        svg.transition().duration(300).call(zoom.scaleBy, 0.8);
    }));

    controlsContainer.appendChild(createButton('⊡', 'Fit to View', () => {
        const bounds = container.node().getBBox();
        const scale = 0.9 / Math.max(bounds.width / containerWidth, bounds.height / containerHeight);
        const translate = [
            containerWidth / 2 - scale * (bounds.x + bounds.width / 2),
            containerHeight / 2 - scale * (bounds.y + bounds.height / 2)
        ];
        svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale));
    }));

    controlsContainer.appendChild(createButton('⊙', 'Center', () => {
        svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity.translate(containerWidth / 2, containerHeight / 2).scale(1));
    }));

    // Zoom slider
    const sliderContainer = document.createElement('div');
    sliderContainer.style.cssText = 'width: 80px; padding: 4px;';
    const zoomSlider = document.createElement('input');
    zoomSlider.type = 'range';
    zoomSlider.id = 'meta-graph-zoom-slider';
    zoomSlider.name = 'meta-graph-zoom-slider';
    zoomSlider.min = '0.1';
    zoomSlider.max = '4';
    zoomSlider.step = '0.1';
    zoomSlider.value = '1';
    zoomSlider.style.cssText = 'width: 100%; accent-color: ' + colors.primary;
    zoomSlider.addEventListener('input', function () {
        svg.transition().duration(100).call(zoom.scaleTo, +this.value);
    });

    function updateZoomSlider(scale) {
        zoomSlider.value = scale.toFixed(1);
    }

    sliderContainer.appendChild(zoomSlider);
    controlsContainer.appendChild(sliderContainer);

    containerNode.appendChild(controlsContainer);

    // Legend
    const legendContainer = document.createElement('div');
    legendContainer.style.cssText = `
        position: absolute;
        bottom: 10px;
        right: 10px;
        padding: 10px;
        background-color: rgba(13, 33, 55, 0.95);
        border-radius: 6px;
        border: 1px solid ${colors.primary};
        color: ${colors.text};
        font-size: 11px;
        z-index: 100;
    `;

    legendContainer.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 6px; color: ${colors.primary};">Node Types</div>
        <div style="display: flex; align-items: center; margin: 4px 0;">
            <div style="width: 16px; height: 16px; border-radius: 50%; background: ${colors.groupNode}; border: 2px solid #ff6600; margin-right: 8px;"></div>
            <span>Group Nodes</span>
        </div>
        <div style="display: flex; align-items: center; margin: 4px 0;">
            <div style="width: 12px; height: 12px; border-radius: 50%; background: ${colors.connectedNode}; border: 1px solid ${colors.text}; margin-right: 8px;"></div>
            <span>Connected Nodes</span>
        </div>
    `;

    containerNode.appendChild(legendContainer);

    function dragstarted(event, d) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
    }

    function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
    }

    function dragended(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
    }

    return function cleanup() {
        simulation.stop();
        if (containerNode.contains(controlsContainer)) containerNode.removeChild(controlsContainer);
        if (containerNode.contains(legendContainer)) containerNode.removeChild(legendContainer);
    };
}

// ============================================================================
// DISPLAY GROUPED NODES (ENHANCED WITH WBS SUPPORT AND METRICS)
// ============================================================================
function displayGroupedNodes(groupedNodes, groupNames, groupType, containerId, allLinks, allNodes) {
    const _timerLabel = `[CommunityGroups] Render ${groupType}`;
    console.time(_timerLabel);
    const renderStartTime = performance.now();

    const groupManager = new ProjectGroupManager();
    const groupData = [];
    const mainContainer = document.getElementById(containerId);
    const dp = CybereumDesign.palette;
    const dt = CybereumDesign.typography;

    if (!mainContainer) {
        console.error(`Container with id ${containerId} not found`);
        return;
    }

    // Clean up
    mainContainer.innerHTML = '';

    mainContainer.style.cssText = `
        width: 100%;
        max-width: 1600px;
        margin: 0 auto;
        overflow-y: auto;
        height: calc(100vh - 100px);
        border: 1px solid ${dp.bgMid};
        padding: 20px;
        background-color: ${dp.bgDark};
        position: relative;
        box-sizing: border-box;
    `;

    // Determine the display title based on group type
    let displayTitle;
    if (groupType === 'WBS_ID') {
        displayTitle = 'Work Breakdown Structure (WBS)';
    } else if (groupType === 'CommunityGroup') {
        displayTitle = 'Project Work Groups';
    } else if (groupType === 'DependencyCluster') {
        displayTitle = 'Project Dependency Clusters';
    } else {
        displayTitle = groupType;
    }

    const mainTitle = document.createElement('h1');
    mainTitle.textContent = displayTitle;
    mainTitle.style.cssText = `
        color: ${dp.text};
        padding: 15px 0;
        margin-bottom: 20px;
        border-bottom: 2px solid ${dp.primary};
        font-size: 28px;
        text-align: center;
        font-family: ${dt.display};
    `;
    mainContainer.appendChild(mainTitle);

    // Cost estimation button container
    const costButtonContainer = createCostButtonContainer(groupedNodes, groupNames, groupType, allNodes);
    mainContainer.appendChild(costButtonContainer);

    const tabContainer = document.createElement('div');
    tabContainer.className = 'tab-container';
    mainContainer.appendChild(tabContainer);

    // =======================================================================
    // OPTIMIZATION 1: Pre-compute all metrics ONCE
    // =======================================================================
    console.time('[Metrics] Pre-computation');
    const metricsCache = new Map();
    const groupEntries = Object.entries(groupedNodes);

    groupEntries.forEach(([groupId, nodes]) => {
        metricsCache.set(groupId, groupManager.calculateGroupMetrics(nodes));
    });
    console.timeEnd('[Metrics] Pre-computation');

    // Create group ID to number mapping
    let groupNumberCounter = 1;
    const groupIdToNumberMap = {};
    groupEntries.forEach(([groupId]) => {
        groupIdToNumberMap[groupId] = groupNumberCounter++;
    });

    // Compute dynamic heights based on group count
    const groupCount = groupEntries.length;
    const networkHeight = Math.min(700, Math.max(500, 400 + groupCount * 3));
    const ganttHeight = Math.min(900, Math.max(500, 400 + groupCount * 10));

    // =======================================================================
    // CREATE OVERVIEW SECTIONS (Panopticon, Network, Gantt) - rendered once
    // =======================================================================
    const communityContentContainer = document.createElement('div');
    communityContentContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 16px;
        margin-bottom: 30px;
    `;
    tabContainer.appendChild(communityContentContainer);

    // Section label helper
    const createSectionLabel = (text, icon) => {
        const label = document.createElement('div');
        label.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: linear-gradient(90deg, rgba(90, 200, 250, 0.15) 0%, transparent 100%);
            border-left: 3px solid #5ac8fa;
            border-radius: 0 6px 6px 0;
            font-weight: 600;
            font-size: 13px;
            color: #cdfaff;
        `;
        label.innerHTML = `<span style="font-size: 16px;">${icon}</span> ${text}`;
        return label;
    };

    // Panopticon (if available) — skip when rendered as a standalone Schedule tab
    if (!window.cybereumState?._skipPanopticonInGroups) {
        try {
            if (typeof PanopticonDashboard !== 'undefined' && typeof renderPanopticonDashboard === 'function') {
                renderPanopticonDashboard(
                    communityContentContainer,
                    groupedNodes,
                    groupNames,
                    allNodes,
                    groupType,
                    groupManager,
                    createSectionLabel
                );
            }
        } catch (panopticonError) {
            console.error('[Panopticon] Error:', panopticonError);
        }
    }

    // Network Diagram
    communityContentContainer.appendChild(createSectionLabel('Dependency Network', '🔗'));
    const communityGraphContainer = document.createElement('div');
    communityGraphContainer.style.cssText = `
        width: 100%;
        height: ${networkHeight}px;
        border: 1px solid #5ac8fa;
        border-radius: 8px;
        padding: 15px;
        background-color: #102d50;
        box-sizing: border-box;
        position: relative;
    `;
    communityContentContainer.appendChild(communityGraphContainer);
    drawCommunityGroupGraph(groupedNodes, allNodes, allLinks, communityGraphContainer, groupType, groupNames);

    // Gantt Chart
    communityContentContainer.appendChild(createSectionLabel(`Schedule Timeline (${groupCount} groups)`, '📊'));
    const ganttChartContainerId = `${groupType.toLowerCase()}-gantt-chart-div`;
    const ganttChartContainer = document.createElement('div');
    ganttChartContainer.id = ganttChartContainerId;
    ganttChartContainer.style.cssText = `
        width: 100%;
        height: ${ganttHeight}px;
        border: 1px solid #5ac8fa;
        border-radius: 8px;
        padding: 15px;
        background-color: #102d50;
        box-sizing: border-box;
        overflow: auto;
    `;
    communityContentContainer.appendChild(ganttChartContainer);

    const ganttData = prepareGanttData(groupedNodes, groupNames, groupManager);
    drawGroupGanttChart(ganttData, ganttChartContainerId, groupType);

    // =======================================================================
    // GROUP LIST SECTION
    // =======================================================================
    communityContentContainer.appendChild(createSectionLabel(`Work Groups (${groupCount})`, '📁'));

    // =======================================================================
    // OPTIMIZATION 2: Progress indicator for batch rendering
    // =======================================================================
    const progressIndicator = document.createElement('div');
    progressIndicator.id = 'group-render-progress';
    progressIndicator.style.cssText = `
        padding: 12px 20px;
        background: rgba(90, 200, 250, 0.1);
        border: 1px solid #5ac8fa;
        border-radius: 8px;
        margin-bottom: 20px;
        display: flex;
        align-items: center;
        gap: 15px;
    `;
    progressIndicator.innerHTML = `
        <div style="flex: 1;">
            <div style="color: #5ac8fa; font-size: 12px; margin-bottom: 5px;">Loading groups...</div>
            <div style="height: 4px; background: #102d50; border-radius: 2px; overflow: hidden;">
                <div id="group-render-progress-bar" style="width: 0%; height: 100%; background: #5ac8fa; transition: width 0.3s;"></div>
            </div>
        </div>
        <div id="group-render-progress-text" style="color: #cdfaff; font-size: 12px;">0/${groupCount}</div>
    `;
    tabContainer.appendChild(progressIndicator);

    // =======================================================================
    // OPTIMIZATION 3: Batched rendering with lazy content loading
    // =======================================================================
    const BATCH_SIZE = 15;
    let currentIndex = 0;
    const contentRegistry = new Map();

    // Store references for lazy loading
    const groupNodesMap = new Map(groupEntries);

    function updateProgress(current, total) {
        const bar = document.getElementById('group-render-progress-bar');
        const text = document.getElementById('group-render-progress-text');
        if (bar) bar.style.width = `${(current / total) * 100}%`;
        if (text) text.textContent = `${current}/${total}`;
    }

    // Progress bar renderer (inline)
    function renderProgressBar(container, progress) {
        const progressBarContainer = document.createElement('div');
        progressBarContainer.style.cssText = `
            width: 100%;
            background-color: #195a8c;
            border-radius: 8px;
            margin: 15px 0;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            position: relative;
            height: 25px;
        `;

        if (progress === 0 || progress < 0.1) {
            const zeroProgressDiv = document.createElement('div');
            zeroProgressDiv.style.cssText = `
                height: 25px;
                width: 100%;
                background-color: #195a8c;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #8ce6ff;
                font-weight: bold;
                font-size: 12px;
            `;
            zeroProgressDiv.textContent = '0% Complete - Not Started';
            progressBarContainer.appendChild(zeroProgressDiv);
        } else {
            const progressBar = document.createElement('div');
            progressBar.style.cssText = `
                height: 25px;
                width: ${progress}%;
                background: linear-gradient(to right, 
                    ${progress < 30 ? '#f44336' : progress < 60 ? '#ffeb3b' : '#4caf50'}, 
                    ${progress < 30 ? '#ff6b6b' : progress < 60 ? '#ffd93d' : '#6bcf7f'}
                );
                border-radius: 8px;
                transition: width 0.3s ease;
                position: relative;
            `;

            const progressText = document.createElement('div');
            progressText.style.cssText = `
                position: absolute;
                right: 10px;
                top: 50%;
                transform: translateY(-50%);
                color: white;
                font-weight: bold;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
            `;
            progressText.textContent = `${progress.toFixed(1)}%`;

            progressBar.appendChild(progressText);
            progressBarContainer.appendChild(progressBar);
        }

        container.appendChild(progressBarContainer);
    }

    function renderGroupBatch() {
        const batchEnd = Math.min(currentIndex + BATCH_SIZE, groupEntries.length);

        for (let i = currentIndex; i < batchEnd; i++) {
            const [groupId, nodes] = groupEntries[i];
            const groupNumber = groupIdToNumberMap[groupId];
            const metrics = metricsCache.get(groupId);

            // Create group container
            const groupDiv = document.createElement('div');
            groupDiv.id = `group-section-${groupId}`;
            groupDiv.classList.add('community-group', 'cyb-group');
            groupDiv.setAttribute('data-group-id', groupId);
            groupDiv.setAttribute('data-group-number', groupNumber);

            // Get group name - prefer SystemsInsights v3.1 enriched name
            let aiGeneratedName;
            const enrichedName = window.cybereumState?.projectAnalysis?.getGroupName?.(groupId);
            if (enrichedName && enrichedName !== `Group ${groupId}`) {
                aiGeneratedName = resolveGroupDisplayName(enrichedName, {
                    groupType,
                    groupId,
                    groupNumber,
                    phase: nodes[0]?.Phase,
                    discipline: nodes[0]?.Discipline,
                    wbsPath: nodes[0]?.WBS_Path
                });
            } else if (groupType === 'WBS_ID' && nodes.length > 0 && nodes[0].WBS_Name) {
                aiGeneratedName = resolveGroupDisplayName(nodes[0].WBS_Name, {
                    groupType,
                    groupId,
                    groupNumber,
                    phase: nodes[0]?.Phase,
                    discipline: nodes[0]?.Discipline,
                    wbsPath: nodes[0]?.WBS_Path
                });
            } else {
                const groupInfo = groupNames[groupId];
                aiGeneratedName = resolveGroupDisplayName(groupInfo?.Name, {
                    groupType,
                    groupId,
                    groupNumber,
                    phase: nodes[0]?.Phase,
                    discipline: nodes[0]?.Discipline,
                    wbsPath: nodes[0]?.WBS_Path
                });
            }
            const groupDescription = groupNames[groupId]?.Description || 'No description available.';

            // Get phase & discipline from detectedTags
            const _gState = window.cybereumState.groups?.[groupType]?.[groupId];
            const _phase = _gState?.detectedTags?.phase || null;
            const _discipline = _gState?.detectedTags?.discipline || null;

            // =================================================================
            // CREATE HEADER (always rendered - lightweight)
            // =================================================================
            const groupHeader = document.createElement('div');
            groupHeader.classList.add('modal-header', 'group-header', 'cyb-group-hdr');

            // Header content
            const headerContent = document.createElement('div');
            headerContent.style.cssText = `flex: 1; margin-right: 15px;`;

            // Title row
            const groupTitle = document.createElement('div');
            groupTitle.classList.add('cyb-group-title');

            const titleText = document.createElement('span');
            titleText.textContent = `Group ${groupNumber}: ${aiGeneratedName}`;
            groupTitle.appendChild(titleText);

            const healthIndicator = groupManager.createHealthIndicator(metrics.healthScore);
            groupTitle.appendChild(healthIndicator);

            // Phase badge (uses CybereumUI.html.phase if available)
            if (_phase) {
                const phaseSpan = document.createElement('span');
                const UI = window.CybereumUI;
                if (UI && UI.html && UI.html.phase) {
                    phaseSpan.innerHTML = UI.html.phase(_phase, { discipline: _discipline });
                } else {
                    phaseSpan.textContent = _phase;
                    phaseSpan.style.cssText = 'font-size:10px;padding:2px 6px;background:rgba(90,200,250,0.15);border:1px solid rgba(90,200,250,0.3);border-radius:3px;color:var(--cyb-accent,#5ac8fa);text-transform:uppercase;letter-spacing:0.5px;font-weight:600';
                }
                groupTitle.appendChild(phaseSpan);
            }

            // Stats row
            const groupStats = document.createElement('div');
            groupStats.classList.add('cyb-group-stats');

            const progressColor = metrics.aggregateProgress >= 75 ? 'var(--cyb-success,#50fa7b)' :
                metrics.aggregateProgress >= 50 ? 'var(--cyb-info,#8be9fd)' :
                    metrics.aggregateProgress >= 25 ? 'var(--cyb-warning,#ffb86c)' : 'var(--cyb-danger,#ff5555)';

            groupStats.innerHTML = `
                <span>📋 ${nodes.length} activities</span>
                <span><span style="color:${progressColor}">●</span> ${metrics.aggregateProgress.toFixed(1)}%</span>
                ${metrics.criticalTaskCount > 0 ? `<span style="color:var(--cyb-danger,#ff5555)">⚠ ${metrics.criticalTaskCount} critical</span>` : ''}
                ${metrics.nearCriticalCount > 0 ? `<span style="color:var(--cyb-warning,#ffb86c)">⚡ ${metrics.nearCriticalCount} near-critical</span>` : ''}
                ${metrics.behindScheduleCount > 0 ? `<span style="color:var(--cyb-warning,#ffb86c)">⏱ ${metrics.behindScheduleCount} delayed</span>` : ''}
                ${metrics.totalMilestones > 0 ? `<span>${metrics.delayedMilestones > 0 ? `<span style="color:var(--cyb-danger,#ff5555)">🏁 ${metrics.delayedMilestones}/${metrics.totalMilestones} MS delayed</span>` : `<span style="color:var(--cyb-muted,#6c7a89)">🏁 ${metrics.totalMilestones} MS</span>`}</span>` : ''}
                <span>⏱ ${metrics.totalDuration}h</span>
            `;

            headerContent.appendChild(groupTitle);
            headerContent.appendChild(groupStats);

            // Toggle icon - starts collapsed
            const toggleIcon = document.createElement('span');
            toggleIcon.className = 'toggle-icon cyb-group-toggle';
            toggleIcon.style.transform = 'rotate(-90deg)';
            toggleIcon.textContent = '▲';

            groupHeader.appendChild(headerContent);
            groupHeader.appendChild(toggleIcon);
            groupDiv.appendChild(groupHeader);

            // =================================================================
            // CREATE CONTENT PLACEHOLDER (content loaded lazily)
            // =================================================================
            const contentPlaceholder = document.createElement('div');
            contentPlaceholder.className = 'group-content-placeholder';
            contentPlaceholder.dataset.groupId = groupId;
            contentPlaceholder.dataset.rendered = 'false';
            contentPlaceholder.style.display = 'none';
            groupDiv.appendChild(contentPlaceholder);

            // =================================================================
            // TOGGLE HANDLER WITH LAZY LOADING
            // =================================================================
            let isExpanded = false;

            groupHeader.addEventListener('click', () => {
                isExpanded = !isExpanded;

                // LAZY RENDER: Only build content on FIRST expand
                if (isExpanded && contentPlaceholder.dataset.rendered === 'false') {
                    console.time(`[LazyRender] Group ${groupId}`);

                    // Description
                    const descriptionElement = document.createElement('div');
                    descriptionElement.classList.add('cyb-group-desc');
                    descriptionElement.textContent = groupDescription;
                    contentPlaceholder.appendChild(descriptionElement);

                    // Insights placeholder
                    const insightContainer = document.createElement('div');
                    insightContainer.id = `insights-${groupType}-${groupId}`;
                    insightContainer.className = 'wg-insights-container';
                    insightContainer.style.cssText = `
                        padding: 12px;
                        background: linear-gradient(135deg, var(--cyb-bg-mid,rgba(16,45,80,0.9)), var(--cyb-bg-dark,rgba(13,33,55,0.95)));
                        border-radius: 6px;
                        margin: 10px 15px;
                        border: 1px solid var(--cyb-border2,rgba(90,200,250,0.2));
                        min-height: 50px;
                    `;
                    insightContainer.innerHTML = `
                        <div style="display:flex;align-items:center;gap:8px;color:#8ce6ff;font-size:12px;">
                            <span>💡 Analyzing work package...</span>
                        </div>
                    `;
                    contentPlaceholder.appendChild(insightContainer);

                    // FIX v2.1: Apply any cached insight that arrived while group was collapsed
                    if (window.WorkGroupInsights?.applyDeferredInsight) {
                        window.WorkGroupInsights.applyDeferredInsight(groupId, groupType);
                    }

                    // Cost display container
                    const groupCostContainer = document.createElement('div');
                    groupCostContainer.id = `cost-display-${groupType}-${groupId}`;
                    groupCostContainer.className = 'group-cost-display';
                    groupCostContainer.style.cssText = `display: none;`;
                    contentPlaceholder.appendChild(groupCostContainer);

                    // Main content container
                    const contentContainer = document.createElement('div');
                    contentContainer.style.cssText = `
                        display: flex;
                        flex-wrap: wrap;
                        padding: 15px;
                        gap: 20px;
                        min-height: 400px;
                        background-color: var(--cyb-bg-dark,#0d2137);
                        box-sizing: border-box;
                    `;

                    // CBS + Gantt row
                    const cbsGanttRow = document.createElement('div');
                    cbsGanttRow.style.cssText = `display: flex; gap: 20px; margin-bottom: 20px; width: 100%;`;

                    const cbsContainer = document.createElement('div');
                    cbsContainer.style.cssText = 'flex: 1.2 1 450px; min-width: 0;';
                    cbsContainer.appendChild(createEditableCBSTable(groupId, groupType, nodes, null));
                    cbsGanttRow.appendChild(cbsContainer);

                    const ganttContainer = document.createElement('div');
                    ganttContainer.style.cssText = 'flex: 1 1 500px; min-width: 0;';
                    ganttContainer.appendChild(createCompactGantt(nodes));
                    cbsGanttRow.appendChild(ganttContainer);

                    contentContainer.appendChild(cbsGanttRow);

                    // Graph + Table row
                    const graphTableRow = document.createElement('div');
                    graphTableRow.style.cssText = `display: flex; gap: 20px; flex-wrap: wrap; width: 100%;`;

                    // Graph container
                    const graphContainerId = `graph-${groupType}-${groupNumber}`;
                    const graphWrapper = document.createElement('div');
                    graphWrapper.style.cssText = `
                        flex: 1 1 600px;
                        position: relative;
                        height: 400px;
                        border: 1px solid #195a8c;
                        border-radius: 8px;
                        overflow: hidden;
                        background-color: #102d50;
                    `;
                    graphWrapper.innerHTML = `<div id="${graphContainerId}" style="width: 100%; height: 100%;"></div>`;
                    graphTableRow.appendChild(graphWrapper);

                    // Activity Table (virtualized)
                    const tableContainer = createOptimizedActivityTable(nodes, groupType, groupIdToNumberMap, groupId);
                    graphTableRow.appendChild(tableContainer);

                    contentContainer.appendChild(graphTableRow);
                    contentPlaceholder.appendChild(contentContainer);

                    // Control dashboard
                    const controlDashboard = groupManager.createGroupControlDashboard(metrics, aiGeneratedName);
                    contentPlaceholder.appendChild(controlDashboard);

                    // Progress bar
                    renderProgressBar(contentPlaceholder, metrics.aggregateProgress);

                    // DEFERRED: Initialize D3 graph
                    requestAnimationFrame(() => {
                        const svgContainer = d3.select(`#${graphContainerId}`).append('svg')
                            .attr('width', '100%')
                            .attr('height', '100%');
                        drawGraphForCommunityGroup(svgContainer, allNodes, allLinks, groupId, groupType);
                    });

                    contentPlaceholder.dataset.rendered = 'true';
                    contentRegistry.set(groupId, true);
                    console.timeEnd(`[LazyRender] Group ${groupId}`);
                }

                // Toggle visibility
                contentPlaceholder.style.display = isExpanded ? 'block' : 'none';
                toggleIcon.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
                toggleIcon.textContent = isExpanded ? '▼' : '▲';
            });

            tabContainer.appendChild(groupDiv);

            // Store group data
            groupData.push({
                GroupNumber: groupNumber,
                GroupID: groupId,
                GroupName: aiGeneratedName,
                WBSPath: nodes[0]?.WBS_Path || nodes[0]?.WBS_Name || '',
                GroupDescription: groupDescription,
                NumberOfActivities: nodes.length,
                TotalDuration: metrics.totalDuration,
                OverallProgress: metrics.aggregateProgress.toFixed(2),
                RiskScore: (metrics.normalizedRiskScore * 100).toFixed(1),
                HealthScore: metrics.healthScore,
                EarliestStart: groupManager.formatDate(metrics.earliestStart),
                LatestEnd: groupManager.formatDate(metrics.latestEnd),
                ActualStart: groupManager.formatDate(metrics.actualStart),
                ActualFinish: groupManager.formatDate(metrics.actualFinish),
                PredictedStart: groupManager.formatDate(metrics.predictedStart),
                PredictedEnd: groupManager.formatDate(metrics.predictedEnd),
                CriticalTaskCount: metrics.criticalTaskCount,
                NearCriticalCount: metrics.nearCriticalCount,
                CriticalActivities: metrics.criticalActivities,
                NearCriticalActivities: metrics.nearCriticalActivities,
                CompletedNodes: metrics.completedNodes,
                InProgressNodes: metrics.inProgressNodes,
                NotStartedNodes: metrics.notStartedNodes,
                BehindScheduleCount: metrics.behindScheduleCount,
                OnScheduleCount: metrics.onScheduleCount,
                AheadScheduleCount: metrics.aheadScheduleCount,
                SchedulePerformance: metrics.schedulePerformance,
                CostPerformance: metrics.costPerformance,
                TotalMilestones: metrics.totalMilestones,
                CompletedMilestones: metrics.completedMilestones,
                DelayedMilestones: metrics.delayedMilestones,
                // v2.3: Phase & discipline from detectedTags
                Phase: (window.cybereumState.groups?.[groupType]?.[groupId]?.detectedTags?.phase) || null,
                Discipline: (window.cybereumState.groups?.[groupType]?.[groupId]?.detectedTags?.discipline) || null
            });
        }

        currentIndex = batchEnd;
        updateProgress(currentIndex, groupEntries.length);

        if (currentIndex < groupEntries.length) {
            requestAnimationFrame(renderGroupBatch);
        } else {
            finishGroupRendering();
        }
    }

    function createOptimizedActivityTable(nodes, groupType, groupIdToNumberMap, groupId) {
        const MAX_INITIAL_ROWS = 25;

        const tableContainer = document.createElement('div');
        tableContainer.style.cssText = `
        flex: 1 1 400px;
        overflow-y: auto;
        max-height: 400px;
        border: 1px solid #195a8c;
        border-radius: 8px;
        background-color: #102d50;
        box-sizing: border-box;
    `;

        // Filter bar - FIXED: Force inline with !important to prevent global style overrides
        const filterDiv = document.createElement('div');
        filterDiv.setAttribute('style', [
            'display: flex !important',
            'flex-direction: row !important',
            'flex-wrap: nowrap !important',
            'gap: 4px !important',
            'padding: 8px !important',
            'background: rgba(13,33,55,0.95) !important',
            'border-bottom: 1px solid #195a8c !important',
            'align-items: center !important',
            'overflow-x: auto !important'
        ].join('; '));

        const filters = [
            { id: 'all', label: 'All', color: '#5ac8fa' },
            { id: 'critical', label: 'Critical', color: '#ff5555' },
            { id: 'delayed', label: 'Delayed', color: '#ffb86c' },
            { id: 'active', label: 'Active', color: '#8be9fd' },
            { id: 'done', label: 'Done', color: '#50fa7b' }
        ];

        filters.forEach((f, i) => {
            const btn = document.createElement('button');
            btn.textContent = f.label;
            btn.dataset.filter = f.id;
            // Use setAttribute with !important to prevent global style overrides
            btn.setAttribute('style', [
                'display: inline-block !important',
                'width: auto !important',
                'min-width: 50px !important',
                'max-width: 70px !important',
                'height: 26px !important',
                'padding: 2px 8px !important',
                'margin: 0 !important',
                `background: ${i === 0 ? f.color : 'rgba(90,200,250,0.15)'} !important`,
                `color: ${i === 0 ? '#0d2137' : '#cdfaff'} !important`,
                `border: 1px solid ${f.color} !important`,
                'border-radius: 4px !important',
                'cursor: pointer !important',
                'font-size: 10px !important',
                'font-weight: bold !important',
                'white-space: nowrap !important',
                'flex: 0 0 auto !important',
                'box-sizing: border-box !important'
            ].join('; '));
            btn.onclick = function () {
                filterActivityTable(groupId, f.id, filterDiv);
            };
            filterDiv.appendChild(btn);
        });
        tableContainer.appendChild(filterDiv);

        // Table
        const table = document.createElement('table');
        table.classList.add('sortable', 'stats-table');
        table.id = `activity-table-${groupId}`;

        const tableHeader = document.createElement('thead');
        const headerRow = document.createElement('tr');
        ['ID', 'Name', 'Duration', 'Progress', 'Path', 'Status', 'Start', 'End'].forEach(h => {
            const th = document.createElement('th');
            th.textContent = h;
            th.style.cssText = 'padding: 8px; font-size: 11px; position: sticky; top: 0; background: #102d50;';
            headerRow.appendChild(th);
        });
        tableHeader.appendChild(headerRow);
        table.appendChild(tableHeader);

        const tableBody = document.createElement('tbody');
        tableBody.id = `activity-tbody-${groupId}`;

        const displayNodes = nodes.slice(0, MAX_INITIAL_ROWS);
        const today = window.cybereumState?.dataDate || new Date();

        displayNodes.forEach(node => {
            const row = document.createElement('tr');
            const isCritical = node.isOnCriticalPath === true;
            const isNearCritical = node.isOnOutlierPath === true;
            const pct = parseFloat(node.PercentComplete) || 0;
            const plannedFinish = new Date(node.Finish);
            const plannedStart = new Date(node.Start);
            // ENHANCED: Get actual finish and predicted end for comprehensive delay detection
            const actualFinish = node.ActualFinish ? new Date(node.ActualFinish) : null;
            const predictedEnd = node.predictedEnd ? new Date(node.predictedEnd) : null;

            if (isCritical) {
                row.style.backgroundColor = 'rgba(255, 85, 85, 0.1)';
                row.style.borderLeft = '3px solid #ff5555';
            } else if (isNearCritical) {
                row.style.backgroundColor = 'rgba(255, 184, 108, 0.1)';
                row.style.borderLeft = '3px solid #ffb86c';
            }

            const pathStatus = isCritical ? '<span style="color:#ff5555;">⚠</span>'
                : isNearCritical ? '<span style="color:#ffb86c;">⚡</span>'
                    : '<span style="color:#50fa7b;">✓</span>';

            // ENHANCED DELAY DETECTION: Handles all edge cases
            let isDelayed = false;
            let delayStatus = '-';

            if (pct >= 100) {
                // COMPLETED: Check if finished late (actual > planned)
                if (actualFinish && actualFinish > plannedFinish) {
                    isDelayed = true;
                    delayStatus = '<span style="color:#ffb86c;" title="Completed late">⏱ Late</span>';
                } else {
                    delayStatus = '<span style="color:#50fa7b;" title="Completed">✓ Done</span>';
                }
            } else if (pct > 0) {
                // IN-PROGRESS: Check for predicted delay or overdue
                const effectivePredictedEnd = predictedEnd || plannedFinish;

                if (effectivePredictedEnd > plannedFinish) {
                    // Predicted to finish late based on current progress
                    isDelayed = true;
                    delayStatus = '<span style="color:#ff5555;" title="Predicted late finish">⏱ Slipping</span>';
                } else if (today > plannedFinish) {
                    // Past planned finish but not complete
                    isDelayed = true;
                    delayStatus = '<span style="color:#ff5555;" title="Past due date">⏱ Overdue</span>';
                } else {
                    // On track
                    delayStatus = '<span style="color:#8be9fd;" title="In progress">◷ Active</span>';
                }
            } else {
                // NOT STARTED: Check if should have started
                if (today > plannedStart) {
                    isDelayed = true;
                    delayStatus = '<span style="color:#ffb86c;" title="Should have started">⚠ Not Started</span>';
                } else {
                    delayStatus = '<span style="color:#8be9fd;" title="Scheduled">◷ Pending</span>';
                }
            }

            const formatDate = d => {
                if (!d) return '-';
                const date = new Date(d);
                return isNaN(date) ? '-' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            };

            row.innerHTML = `
            <td style="padding:6px;font-size:11px;">${node.ID || '-'}</td>
            <td style="padding:6px;font-size:11px;max-width:150px;overflow:hidden;text-overflow:ellipsis;">${(node.Name || '-').substring(0, 30)}</td>
            <td style="padding:6px;font-size:11px;text-align:center;">${node.Duration || '-'}</td>
            <td style="padding:6px;font-size:11px;text-align:center;">${pct.toFixed(0)}%</td>
            <td style="padding:6px;text-align:center;">${pathStatus}</td>
            <td style="padding:6px;text-align:center;">${delayStatus}</td>
            <td style="padding:6px;font-size:10px;">${formatDate(node.Start)}</td>
            <td style="padding:6px;font-size:10px;">${formatDate(node.Finish)}</td>
        `;

            row.dataset.pct = pct;
            row.dataset.isCritical = isCritical;
            row.dataset.isDelayed = isDelayed;
            tableBody.appendChild(row);
        });

        if (nodes.length > MAX_INITIAL_ROWS) {
            const loadMoreRow = document.createElement('tr');
            loadMoreRow.id = `load-more-${groupId}`;
            loadMoreRow.innerHTML = `
            <td colspan="8" style="text-align: center; padding: 12px; background: rgba(90,200,250,0.1);">
                <span style="color: #8be9fd; font-size: 12px;">
                    Showing ${MAX_INITIAL_ROWS} of ${nodes.length} activities
                </span>
            </td>
        `;
            tableBody.appendChild(loadMoreRow);
        }

        table.appendChild(tableBody);
        tableContainer.appendChild(table);
        return tableContainer;
    }

    function filterActivityTable(groupId, filterType, filterDiv) {
        const tbody = document.getElementById(`activity-tbody-${groupId}`);
        if (!tbody) return;

        // Update button styles - FIXED: Use setAttribute with !important to prevent overrides
        filterDiv.querySelectorAll('button').forEach(btn => {
            const isActive = btn.dataset.filter === filterType;
            const colors = { all: '#5ac8fa', critical: '#ff5555', delayed: '#ffb86c', active: '#8be9fd', done: '#50fa7b' };
            const color = colors[btn.dataset.filter] || '#5ac8fa';

            btn.setAttribute('style', [
                'display: inline-block !important',
                'width: auto !important',
                'min-width: 50px !important',
                'max-width: 70px !important',
                'height: 26px !important',
                'padding: 2px 8px !important',
                'margin: 0 !important',
                `background: ${isActive ? color : 'rgba(90,200,250,0.15)'} !important`,
                `color: ${isActive ? '#0d2137' : '#cdfaff'} !important`,
                `border: 1px solid ${color} !important`,
                'border-radius: 4px !important',
                'cursor: pointer !important',
                'font-size: 10px !important',
                'font-weight: bold !important',
                'white-space: nowrap !important',
                'flex: 0 0 auto !important',
                'box-sizing: border-box !important'
            ].join('; '));
        });

        const rows = tbody.querySelectorAll('tr:not([id^="load-more"])');
        rows.forEach(row => {
            const pct = parseFloat(row.dataset.pct) || 0;
            const isCritical = row.dataset.isCritical === 'true';
            const isDelayed = row.dataset.isDelayed === 'true';

            let show = false;
            switch (filterType) {
                case 'all': show = true; break;
                case 'critical': show = isCritical; break;
                case 'delayed': show = isDelayed; break;
                case 'active': show = pct > 0 && pct < 100; break;
                case 'done': show = pct >= 100; break;
            }
            row.style.display = show ? '' : 'none';
        });
    }

    // ============================================================================
    // COST BUTTON CONTAINER
    // ============================================================================
    function createCostButtonContainer(groupedNodes, groupNames, groupType, allNodes) {
        const costButtonContainer = document.createElement('div');
        costButtonContainer.style.cssText = `
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 15px;
        margin-bottom: 20px;
        padding: 15px;
        background: linear-gradient(135deg, rgba(90, 200, 250, 0.1) 0%, rgba(16, 45, 80, 0.3) 100%);
        border: 1px solid #5ac8fa;
        border-radius: 8px;
    `;

        const costButton = document.createElement('button');
        costButton.id = 'estimate-costs-btn';
        costButton.innerHTML = '💰 Estimate Work Group Costs';
        costButton.style.cssText = `
        padding: 12px 28px;
        background: linear-gradient(135deg, #5ac8fa 0%, #41afeb 100%);
        color: #0d2137;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-family: 'Orbitron', sans-serif;
        font-size: 15px;
        font-weight: bold;
        transition: all 0.3s ease;
        box-shadow: 0 4px 12px rgba(90, 200, 250, 0.4);
    `;
        costButton.onclick = () => estimateWorkGroupCosts(groupedNodes, groupNames, groupType, allNodes);

        const costStatus = document.createElement('div');
        costStatus.id = 'cost-status';
        costStatus.style.cssText = `color: #cdfaff; font-size: 13px; display: none;`;

        const costTotal = document.createElement('div');
        costTotal.id = 'cost-total-display';
        costTotal.style.cssText = `display: none; flex-direction: column; align-items: flex-end;`;
        costTotal.innerHTML = `
        <div style="color: #5ac8fa; font-size: 11px; font-weight: bold;">TOTAL COST</div>
        <div id="cost-total-value" style="color: #50fa7b; font-size: 20px; font-weight: bold;">$0</div>
    `;

        costButtonContainer.appendChild(costButton);
        costButtonContainer.appendChild(costStatus);
        costButtonContainer.appendChild(costTotal);
        return costButtonContainer;
    }

    function finishGroupRendering() {
        // Hide progress
        const progressEl = document.getElementById('group-render-progress');
        if (progressEl) progressEl.style.display = 'none';

        // v2.4: Store full groupData globally so GroupNavigator & other modules can read it
        if (!window.cybereumState._groupRenderData) {
            window.cybereumState._groupRenderData = {};
        }
        window.cybereumState._groupRenderData[groupType] = groupData;

        // Navigation registration
        const containerType = containerId === 'community-container' ? 'community' : 'dependency';
        const navGroups = groupData.map(g => ({
            groupId: g.GroupID,
            groupName: resolveGroupDisplayName(g.GroupName, {
                groupType,
                groupId: g.GroupID,
                groupNumber: g.GroupNumber,
                phase: g.Phase,
                discipline: g.Discipline,
                wbsPath: g.WBSPath
            }),
            nodeCount: g.NumberOfActivities,
            healthScore: g.HealthScore,
            progress: parseFloat(g.OverallProgress),
            hasCriticalPath: g.CriticalTaskCount > 0,
            hasDelayed: g.BehindScheduleCount > 0,
            wbsLevel: g.WBSPath || null,
            phase: g.Phase || null,
            discipline: g.Discipline || null
        }));

        if (window.WorkGroupNav) {
            window.WorkGroupNav.registerGroups(navGroups, containerType);
        }

        if (window.WorkGroupKPI && containerId === 'community-container') {
            window.WorkGroupKPI.init(groupData, allNodes, allLinks, containerId);
        }

        // AI insights (async)
        if (window.WorkGroupInsights) {
            window.WorkGroupInsights.fetch(groupedNodes, groupNames, groupType, allNodes)
                .catch(err => console.warn('[WorkGroupInsights] Error:', err));
        }
        generateSystemsInsights(groupData, groupedNodes, groupType, allNodes)
            .then(() => {
                // v2.4: Retry synthesis button injection after systems insights complete
                _retrySynthesisButtonInjection(groupType);
            })
            .catch(err => console.warn('[SystemsInsights] Error:', err));

        // v2.4: Dispatch event so GroupNavigator can re-scan with full data
        window.dispatchEvent(new CustomEvent('cybereum:groupsRendered', {
            detail: { groupType, groupCount: groupEntries.length }
        }));

        console.timeEnd(_timerLabel);
        _log(`[CommunityGroups] Rendered ${groupEntries.length} groups in ${(performance.now() - renderStartTime).toFixed(0)}ms`);
    }

    // Start rendering
    renderGroupBatch();

    return groupData;
}

// ============================================================================
// SHARED UTILITY: Build integer-keyed grouping with name-based fallback
// ============================================================================
// Builds an integer-keyed { groupId: [nodes] } object and a matching names map.
// When the integer property (e.g. CommunityGroup or DependencyCluster) produces
// only 1 group but the name-based grouping from fetchCommunityGroupNames has more,
// falls back to name-based groups and re-tags each node's integer property so that
// DrawGraph.js coloring matches the displayed groups.
//
// Parameters:
//   intGrouped      — object keyed by integer property value, e.g. from groupNodesByCommunityGroup()
//   nameBasedGroups — array-of-arrays from fetchCommunityGroupNames (Object.values result)
//   nameKey         — node property for display name, e.g. 'communityGroupName'
//   nameKeyAlt      — fallback property name, e.g. 'CommunityGroupName'
//   descKey         — node property for description, e.g. 'communityGroupDescription'
//   labelPrefix     — human label prefix, e.g. 'Work Group' or 'Cluster'
//   intPropName     — node property to re-tag, e.g. 'CommunityGroup' or 'DependencyCluster'
//
// Returns: { grouped: Object, names: Object }
function buildGroupingWithFallback(intGrouped, nameBasedGroups, nameKey, nameKeyAlt, descKey, labelPrefix, intPropName) {
    var grouped = intGrouped;
    var names = {};

    Object.entries(grouped).forEach(function (entry) {
        var gid = entry[0], gNodes = entry[1];
        var f = gNodes[0];
        names[gid] = {
            Name: (f && (f[nameKey] || f[nameKeyAlt])) || (labelPrefix + ' ' + gid),
            Description: (f && f[descKey]) || ''
        };
    });

    // Fallback: if integer property yields only 1 group but name-based has more
    if (Object.keys(grouped).length <= 1 && nameBasedGroups.length > 1) {
        _log('[Groups] ' + intPropName + ' integer produced 1 group; falling back to name-based grouping (' + nameBasedGroups.length + ' groups)');
        grouped = {};
        names = {};
        nameBasedGroups.forEach(function (groupNodes, idx) {
            var gid = idx + 1;
            grouped[String(gid)] = groupNodes;
            var f = groupNodes[0];
            names[String(gid)] = {
                Name: (f && (f[nameKey] || f[nameKeyAlt])) || (labelPrefix + ' ' + gid),
                Description: (f && f[descKey]) || ''
            };
            groupNodes.forEach(function (n) { n[intPropName] = gid; });
        });
    }

    return { grouped: grouped, names: names };
}

// ============================================================================
// GROUP NODES BY DEPENDENCY CLUSTER (UNCHANGED)
// ============================================================================
function groupNodesByDependencyCluster(nodes) {
    const groupedNodes = {};
    nodes.forEach(node => {
        let dependencyCluster = node.DependencyCluster;
        if (dependencyCluster == null || dependencyCluster === '') {
            dependencyCluster = 'Unassigned';
        }
        if (!groupedNodes[dependencyCluster]) {
            groupedNodes[dependencyCluster] = [];
        }
        groupedNodes[dependencyCluster].push(node);
    });
    return groupedNodes;
}

// ============================================================================
// HELPER FUNCTION FOR drawGraph INTEGRATION
// ============================================================================

// Call this at the start of drawGraph to set up group data properly
function setupGroupDataForDrawGraph(communityGroupData, DepGroupData) {
    communityGroupData = communityGroupData || [];
    DepGroupData = DepGroupData || [];

    // Treat DepGroupData as "primary" (it is whatever drawCharts returned as primary)
    const primaryGroupData = DepGroupData;

    const communityGroups = communityGroupData.length > 0
        ? communityGroupData.map(d => d.GroupName || d.groupName || `Group ${d.GroupNumber || d.GroupID}`)
        : ['Default Group'];

    const primaryGroups = primaryGroupData.length > 0
        ? primaryGroupData.map(d => d.GroupName || d.groupName || `Group ${d.GroupNumber || d.GroupID}`)
        : ['Default Group'];

    const communityGroupColors = d3.scaleOrdinal(d3.schemeCategory10).domain(communityGroups);
    const primaryGroupColors = d3.scaleOrdinal(d3.schemeCategory10).domain(primaryGroups);

    return {
        communityGroupData,
        primaryGroupData,
        communityGroups,
        primaryGroups,
        communityGroupColors,
        primaryGroupColors,
        isUsingWBS: !!primaryGroupData.find(g =>
            (g.GroupName || '').toLowerCase().includes('wbs') ||
            (g.GroupDescription || '').toLowerCase().includes('work breakdown')
        ),
        DepGroupData: primaryGroupData,  // back-compat
        DepGroups: primaryGroups,
        DepGroupColors: primaryGroupColors
    };
}


// Generate tooltip content for group data
function generateGroupTooltipContent(groupData, colorScale, groupType) {
    if (!groupData || groupData.length === 0) {
        return '<div style="color: #ff5555;">No group data available</div>';
    }

    const groupLabel = groupType === 'WBS' ? 'Control Account' :
        groupType === 'Community' ? 'Work Group' :
            'Dependency Cluster';

    let tooltipContent = `<div style="margin-bottom: 10px; font-weight: bold; color: #5ac8fa;">${groupLabel}s</div>`;

    groupData.forEach((data, index) => {
        const groupId = data.GroupID || index;
        const groupNumber = data.GroupNumber || (index + 1);
        const groupName = data.GroupName || data.groupName || `Group ${groupNumber}`;
        const activities = data.NumberOfActivities || 0;
        const duration = data.TotalDuration || 0;
        const progress = parseFloat(data.OverallProgress || 0).toFixed(2);
        const risk = data.RiskScore || '0.0';

        const color = colorScale(groupName);

        tooltipContent += `<div style="margin: 8px 0; padding: 6px; background: rgba(16, 45, 80, 0.5); border-radius: 4px;">
            <input type="checkbox" id="toggleGroup${groupId}" checked style="margin-right: 8px;">
            <label for="toggleGroup${groupId}" style="color: ${color} !important; cursor: pointer;">
                <strong>${groupLabel} ${groupNumber}:</strong> ${groupName}
            </label>
            <div style="margin-left: 24px; font-size: 11px; color: #cdfaff; margin-top: 4px;">
                📊 ${activities} activities | 
                ⏱️ ${duration.toFixed(0)} hrs | 
                📈 ${progress}% complete | 
                ⚠️ ${risk}% risk
            </div>
        </div>`;
    });

    return tooltipContent;
}

// ============================================================================
// CLEANUP EVENT LISTENERS (UNCHANGED)
// ============================================================================
function cleanupEventListeners(container) {
    // Production-ready cleanup using tracked registry
    const registry = window.cybereumState?.cleanupRegistry;
    if (!registry) return;

    registry.listeners = registry.listeners.filter(({ element, type, handler, options }) => {
        if (container.contains(element) || element === container) {
            try {
                element.removeEventListener(type, handler, options);
                return false; // Remove from registry
            } catch (err) {
                console.error('[Cleanup] Error removing listener:', err);
            }
        }
        return true; // Keep in registry
    });

    registry.observers = registry.observers.filter(({ observer, target }) => {
        if (container.contains(target) || target === container) {
            try {
                observer.disconnect();
                return false;
            } catch (err) {
                console.error('[Cleanup] Error disconnecting observer:', err);
            }
        }
        return true;
    });
}

// ============================================================================
// CHECK IF WBS IS PRESENT IN NODES
// ============================================================================
function checkWBSPresence(nodes) {
    // Check start node first (it has the flag)
    const startNode = nodes.find(n => n.ID === "0");
    if (startNode && startNode.WBS_IndexPresent === 1) {
        return true;
    }

    // Fallback: check if any nodes have valid WBS data
    return nodes.some(n =>
        n.WBS_ID &&
        n.WBS_ID !== '' &&
        n.WBS_Name &&
        n.WBS_Name !== ''
    );
}

// ============================================================================
// INTEGRATION FUNCTION FOR drawCharts
// ============================================================================
async function processProjectGroups(nodes, links, updateProgressBar) {
    const hasWBS = checkWBSPresence(nodes);
    // Back-compat alias so older code that calls isWBSPresent() keeps working
    const isWBSPresent = checkWBSPresence;

    let communityGroupData = [];
    let DepGroupData = [];
    let WBSGroupData = [];

    _log(`WBS Present: ${hasWBS}`);

    if (hasWBS) {
        _log('LoadingBar Processing WBS Groups...');
        await updateProgressBar(36, 'Processing WBS Groups...');

        // Group by WBS
        const wbsGroupedNodes = groupNodesByWBS(nodes);

        // Create simple names from WBS_Name
        const wbsGroupNames = {};
        Object.entries(wbsGroupedNodes).forEach(([wbsId, groupNodes]) => {
            if (groupNodes.length > 0 && groupNodes[0].WBS_Name) {
                wbsGroupNames[wbsId] = {
                    Name: groupNodes[0].WBS_Name,
                    Description: groupNodes[0].WBS_Path || 'No description available.'
                };
            } else {
                wbsGroupNames[wbsId] = {
                    Name: `WBS ${wbsId}`,
                    Description: 'No description available.'
                };
            }
        });

        // Also process Community groups for tabs
        const groupedNodes = groupNodesByCommunityGroup(nodes);
        let communityGroupNames = {};

        try {
            communityGroupNames = await fetchCommunityGroupNames(groupedNodes);
        } catch (error) {
            console.error('Error fetching community names:', error);
            Object.keys(groupedNodes).forEach(gid => {
                communityGroupNames[gid] = { Name: `Group ${gid}`, Description: 'Loading...' };
            });
        }

        // Display all groups with tabs - WAIT for completion
        await updateProgressBar(37, 'Creating group tabs...');
        const result = await displayGroupedNodesWithTabs(
            nodes,
            links,
            {
                wbs: { grouped: wbsGroupedNodes, names: wbsGroupNames },
                community: { grouped: groupedNodes, names: communityGroupNames },
                dependency: null
            },
            'community-container'
        );

        WBSGroupData = result.wbsGroupData || [];
        communityGroupData = result.communityGroupData || [];

        _log('All groups processed successfully', { WBSGroupData, communityGroupData });
        await updateProgressBar(40, 'Groups Complete');

        // Return WBS as primary for backward compatibility
        return {
            primaryGroupData: WBSGroupData,
            communityGroupData: communityGroupData,
            DepGroupData: WBSGroupData, // Use WBS for backward compatibility
            groupType: 'WBS'
        };

    } else {
        // Original logic: use Community and Dependency groups
        _log('LoadingBar Processing Community and Dependency Groups...');

        const groupedNodes = groupNodesByCommunityGroup(nodes);
        const DepgroupedNodes = groupNodesByDependencyCluster(nodes);

        await updateProgressBar(36, 'Creating Work Groups');

        // Fetch names
        let communityGroupNames = {};
        let DepGroupNames = {};

        try {
            communityGroupNames = await fetchCommunityGroupNames(groupedNodes);
            DepGroupNames = await fetchDevGroupNames(DepgroupedNodes);
        } catch (error) {
            console.error('Error fetching group names:', error);
            Object.keys(groupedNodes).forEach(gid => {
                communityGroupNames[gid] = { Name: `Group ${gid}`, Description: 'Loading...' };
            });
            Object.keys(DepgroupedNodes).forEach(gid => {
                DepGroupNames[gid] = { Name: `Cluster ${gid}`, Description: 'Loading...' };
            });
        }

        await updateProgressBar(37, 'Creating group tabs...');

        // Display with tabs - WAIT for completion
        const result = await displayGroupedNodesWithTabs(
            nodes,
            links,
            {
                wbs: null,
                community: { grouped: groupedNodes, names: communityGroupNames },
                dependency: { grouped: DepgroupedNodes, names: DepGroupNames }
            },
            'community-container'
        );

        communityGroupData = result.communityGroupData || [];
        DepGroupData = result.dependencyGroupData || [];

        _log('Groups processed:', { communityGroupData, DepGroupData });
        await updateProgressBar(40, 'Groups Complete');

        // Return Dependency as primary for backward compatibility
        return {
            primaryGroupData: DepGroupData,
            communityGroupData: communityGroupData,
            DepGroupData: DepGroupData,
            groupType: 'Dependency'
        };
    }
}

// ============================================================================
// DISPLAY GROUPED NODES WITH TABS
// ============================================================================
async function displayGroupedNodesWithTabs(nodes, links, groupsData, containerId) {
    const mainContainer = document.getElementById(containerId);
    const p = CybereumDesign.palette;
    const t = CybereumDesign.typography;

    if (!mainContainer) {
        console.error(`Container with id ${containerId} not found`);
        return { communityGroupData: [], dependencyGroupData: [], wbsGroupData: [] };
    }

    mainContainer.innerHTML = '';
    mainContainer.style.cssText = `
        width: 100%;
        max-width: 1600px;
        margin: 0 auto;
        overflow-y: auto;
        height: calc(100vh - 100px);
        border: 1px solid ${p.bgMid};
        padding: 20px;
        background-color: ${p.bgDark};
        position: relative;
        box-sizing: border-box;
    `;

    // Main title
    const mainTitle = document.createElement('h1');
    mainTitle.textContent = 'Project Groups Analysis';
    mainTitle.style.cssText = `
        color: ${p.text};
        padding: 15px 0;
        margin-bottom: 20px;
        border-bottom: 2px solid ${p.primary};
        font-size: 28px;
        text-align: center;
        font-family: ${t.display};
    `;
    mainContainer.appendChild(mainTitle);

    // Tab container
    const tabButtonContainer = document.createElement('div');
    tabButtonContainer.style.cssText = `
        display: flex;
        gap: 10px;
        margin-bottom: 20px;
        border-bottom: 2px solid ${p.primary};
        padding-bottom: 10px;
    `;

    const tabContentContainer = document.createElement('div');
    tabContentContainer.style.cssText = `
        width: 100%;
        min-height: 500px;
    `;

    mainContainer.appendChild(tabButtonContainer);
    mainContainer.appendChild(tabContentContainer);

    // Results storage — keys must match `${tab.id}GroupData` pattern from showTabContent
    const results = {
        communityGroupData: [],
        dependencyGroupData: [],
        wbsGroupData: []
    };

    // Create tabs data
    const tabs = [];

    if (groupsData.wbs) {
        tabs.push({ id: 'wbs', label: 'WBS Groups', data: groupsData.wbs, type: 'WBS_ID' });
    }
    if (groupsData.community) {
        tabs.push({ id: 'community', label: 'Work Groups', data: groupsData.community, type: 'CommunityGroup' });
    }
    if (groupsData.dependency) {
        tabs.push({ id: 'dependency', label: 'Dependency Clusters', data: groupsData.dependency, type: 'DependencyCluster' });
    }

    // Function to show a tab's content
    async function showTabContent(tab, button) {
        // Update button styles
        tabButtonContainer.querySelectorAll('button').forEach(btn => {
            btn.style.backgroundColor = p.bgMid;
            btn.style.color = p.text;
        });
        button.style.backgroundColor = p.primary;
        button.style.color = p.bgDark;

        // DESTROY inactive tab content to prevent memory leaks
        const registry = window.cybereumState?.cleanupRegistry;
        tabContentContainer.querySelectorAll('[data-tab-content]').forEach(div => {
            if (div.id !== `${tab.id}-tab-content`) {
                // Clean up resources before destroying
                const tabId = div.getAttribute('data-tab-content');
                if (registry) {
                    registry.cleanupTab(tabId);

                    // Clean up graphs in this tab
                    const groupType = div.dataset.groupType;
                    if (groupType) {
                        const graphKeys = Array.from(registry.graphCleanups.keys())
                            .filter(key => key.startsWith(`${groupType}:`));
                        graphKeys.forEach(key => {
                            const [, groupId] = key.split(':');
                            registry.cleanupGraph(groupType, groupId);
                        });
                    }
                }

                // Remove the DOM
                div.remove();
                _log(`[TabLifecycle] Destroyed inactive tab: ${tabId}`);
            }
        });

        // Check if this tab's content already exists
        let contentDiv = document.getElementById(`${tab.id}-tab-content`);

        if (!contentDiv) {
            // First time loading this tab - create content div
            contentDiv = document.createElement('div');
            contentDiv.id = `${tab.id}-tab-content`;
            contentDiv.setAttribute('data-tab-content', tab.id);
            // Mark meta-group identity on the content container (used for correct portfolio-analysis placement)
            contentDiv.classList.add('cyb-group-tab-content');
            contentDiv.dataset.groupType = tab.type;
            contentDiv.dataset.tabId = tab.id;
            contentDiv.style.width = '100%';
            tabContentContainer.appendChild(contentDiv);

            _log(`Loading ${tab.id} group data...`);
            const groupData = await displayGroupedNodes(
                tab.data.grouped,
                tab.data.names,
                tab.type,
                `${tab.id}-tab-content`,
                links,
                nodes
            );

            const resultKey = `${tab.id}GroupData`;
            results[resultKey] = groupData || [];
            _log(`${tab.id} group data loaded:`, results[resultKey].length, 'groups');

            // If systems insights arrived before this tab existed, render them now
            const pending = window.cybereumState?.analytics?.pendingSystemsInsightsByGroupType?.[tab.type];
            if (pending) {
                try {
                    updateSystemsInsightsUI(pending, tab.type);
                } finally {
                    delete window.cybereumState.analytics.pendingSystemsInsightsByGroupType[tab.type];
                }
            }

            // Flush SystemsInsights v3.1 deferred display queue for newly-rendered containers
            if (typeof window.flushDeferredInsights === 'function') {
                window.flushDeferredInsights();
            }
        } else {
            // Tab was already loaded - just show it
            contentDiv.style.display = 'block';

            // Ensure dataset markers exist (older DOMs may not have them)
            if (!contentDiv.classList.contains('cyb-group-tab-content')) {
                contentDiv.classList.add('cyb-group-tab-content');
            }
            contentDiv.dataset.groupType = contentDiv.dataset.groupType || tab.type;
            contentDiv.dataset.tabId = contentDiv.dataset.tabId || tab.id;

            // Render any pending systems insights for this tab
            const pending = window.cybereumState?.analytics?.pendingSystemsInsightsByGroupType?.[tab.type];
            if (pending) {
                try {
                    updateSystemsInsightsUI(pending, tab.type);
                } finally {
                    delete window.cybereumState.analytics.pendingSystemsInsightsByGroupType[tab.type];
                }
            }

            // Flush SystemsInsights v3.1 deferred display queue
            if (typeof window.flushDeferredInsights === 'function') {
                window.flushDeferredInsights();
            }
        }
    }

    // Create tab buttons and load first tab immediately
    for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const button = document.createElement('button');
        button.textContent = tab.label;
        button.style.cssText = `
            padding: 12px 24px;
            background-color: ${i === 0 ? p.primary : p.bgMid};
            color: ${i === 0 ? p.bgDark : p.text};
            border: 1px solid ${p.primary};
            border-radius: 8px 8px 0 0;
            cursor: pointer;
            font-family: ${t.display};
            font-size: 14px;
            font-weight: bold;
            transition: all 0.3s ease;
        `;

        button.addEventListener('click', () => showTabContent(tab, button));
        tabButtonContainer.appendChild(button);

        // Load first tab immediately
        if (i === 0) {
            await showTabContent(tab, button);
        }
    }

    return results;
}


// ============================================================================
// COST ESTIMATION CORE FUNCTIONS
// ============================================================================

/**
 * Update individual group cost displays
 */
function updateGroupCostDisplays(estimates, workGroupData, groupType) {
    _log('=== UPDATING GROUP COST DISPLAYS WITH CBS ===');
    _log('Estimates received:', estimates);

    const currency = estimates.metadata?.currency || 'USD';
    const fmt = (val) => {
        if (!val || isNaN(val)) return `${currency} 0`;
        return `${currency} ${val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    };

    let displayedCount = 0;

    estimates.workGroupEstimates.forEach(est => {
        // Find the original work group
        const wg = workGroupData.workGroups.find(w => w.id === est.id);
        if (!wg) {
            console.warn(`Could not find work group for estimate ID: ${est.id}`);
            return;
        }

        // Store CBS data on the work group
        wg.estimatedCost = est.estimatedCost;
        wg.cbsBreakdown = est.costBreakdown;

        if (wg._displayData) {
            const displayData = wg._displayData;
            const containerId = `cost-display-${displayData.groupType}-${displayData.groupId}`;
            const container = document.getElementById(containerId);

            if (container) {
                // Show the container
                container.style.display = 'block';

                // Update the total
                const valueEl = document.getElementById(`cost-value-${displayData.groupType}-${displayData.groupId}`);
                if (valueEl) valueEl.textContent = fmt(est.estimatedCost);

                // Update the breakdown - MAP THE CORRECT FIELDS
                const laborEl = document.getElementById(`cost-labor-${displayData.groupType}-${displayData.groupId}`);
                const materialsEl = document.getElementById(`cost-materials-${displayData.groupType}-${displayData.groupId}`);
                const equipmentEl = document.getElementById(`cost-equipment-${displayData.groupType}-${displayData.groupId}`);
                const indirectEl = document.getElementById(`cost-indirect-${displayData.groupType}-${displayData.groupId}`);

                // The API returns directLabor, directMaterial, etc. - map them correctly
                if (laborEl && est.costBreakdown?.directLabor) {
                    laborEl.textContent = fmt(est.costBreakdown.directLabor.amount || 0);
                }
                if (materialsEl && est.costBreakdown?.directMaterial) {
                    materialsEl.textContent = fmt(est.costBreakdown.directMaterial.amount || 0);
                }
                if (equipmentEl && est.costBreakdown?.equipment) {
                    equipmentEl.textContent = fmt(est.costBreakdown.equipment.amount || 0);
                }
                if (indirectEl && est.costBreakdown?.indirect) {
                    indirectEl.textContent = fmt(est.costBreakdown.indirect.amount || 0);
                }

                // Add subcontracts display if element exists
                const subcontractsEl = document.getElementById(`cost-subcontracts-${displayData.groupType}-${displayData.groupId}`);
                if (subcontractsEl && est.costBreakdown?.subcontracts) {
                    subcontractsEl.textContent = fmt(est.costBreakdown.subcontracts.amount || 0);
                }
            }
        }

        displayedCount++;
        _log(`✓ Updated cost display for: ${est.name}`);
    });

    // Now update or create CBS tables for all groups
    updateAllCBSTables(estimates, workGroupData, currency);

    _log(`=== UPDATE COMPLETE: ${displayedCount} groups updated ===`);
}

/**
 * Main cost estimation function
 */

// ============================================================================
// CBS HELPER FUNCTIONS
// ============================================================================


// ============================================================================
// function to update CBS tables
// ============================================================================

function updateAllCBSTables(estimates, workGroupData, currency) {
    _log('Updating CBS tables for all groups with AI estimates...');

    // Store estimates globally for access by CBS tables
    window._latestCBSEstimates = estimates;

    // For each estimate, find and update its editable CBS table
    estimates.workGroupEstimates.forEach(est => {
        const wg = workGroupData.workGroups.find(w => w.id === est.id);
        if (!wg || !wg._displayData) return;

        const displayData = wg._displayData;
        const stateKey = `${displayData.groupType}-${displayData.groupId}`;

        // Find the editable CBS table for this group
        const editableCBSTable = document.querySelector(`.editable-cbs-table[data-group-id="${displayData.groupId}"][data-group-type="${displayData.groupType}"]`);

        if (editableCBSTable && est.costBreakdown) {
            _log(`Updating editable CBS table for group: ${est.name}`);

            // Get CBS data from state - with safety checks
            if (!window.cybereumState?.costEstimation?.groupCBSData) {
                console.warn('CBS data structure not initialized for group:', stateKey);
                return;
            }
            const cbsData = window.cybereumState.costEstimation.groupCBSData[stateKey];
            if (!cbsData) return;

            // Update CBS data with AI estimates
            if (est.costBreakdown.directLabor) {
                cbsData.DIRECT_LABOR.hours = est.costBreakdown.directLabor.hours || 0;
                cbsData.DIRECT_LABOR.rate = est.costBreakdown.directLabor.rate || 75;
                cbsData.DIRECT_LABOR.amount = est.costBreakdown.directLabor.amount || 0;
            }

            if (est.costBreakdown.directMaterial) {
                cbsData.DIRECT_MATERIAL.quantity = est.costBreakdown.directMaterial.quantity || 0;
                cbsData.DIRECT_MATERIAL.unitCost = est.costBreakdown.directMaterial.rate || 100;
                cbsData.DIRECT_MATERIAL.amount = est.costBreakdown.directMaterial.amount || 0;
            }

            if (est.costBreakdown.equipment) {
                cbsData.EQUIPMENT.days = est.costBreakdown.equipment.days || 0;
                cbsData.EQUIPMENT.rate = est.costBreakdown.equipment.rate || 500;
                cbsData.EQUIPMENT.amount = est.costBreakdown.equipment.amount || 0;
            }

            if (est.costBreakdown.subcontracts) {
                cbsData.SUBCONTRACTS.amount = est.costBreakdown.subcontracts.amount || 0;
            }

            if (est.costBreakdown.indirect) {
                cbsData.INDIRECT.percentage = est.costBreakdown.indirect.percentOfDirect || 10;
                cbsData.INDIRECT.amount = est.costBreakdown.indirect.amount || 0;
            }

            // Recalculate total
            const directTotal = cbsData.DIRECT_LABOR.amount +
                cbsData.DIRECT_MATERIAL.amount +
                cbsData.EQUIPMENT.amount +
                cbsData.SUBCONTRACTS.amount;
            cbsData.total = directTotal + cbsData.INDIRECT.amount;

            // Update the editable inputs with new values
            editableCBSTable.querySelectorAll('.cbs-editable-input').forEach(input => {
                const category = input.dataset.category;
                const field = input.dataset.field;

                if (category === 'DIRECT_LABOR') {
                    if (field === 'quantity') input.value = cbsData.DIRECT_LABOR.hours;
                    if (field === 'rate') input.value = cbsData.DIRECT_LABOR.rate;
                } else if (category === 'DIRECT_MATERIAL') {
                    if (field === 'quantity') input.value = cbsData.DIRECT_MATERIAL.quantity;
                    if (field === 'rate') input.value = cbsData.DIRECT_MATERIAL.unitCost;
                } else if (category === 'EQUIPMENT') {
                    if (field === 'quantity') input.value = cbsData.EQUIPMENT.days;
                    if (field === 'rate') input.value = cbsData.EQUIPMENT.rate;
                } else if (category === 'SUBCONTRACTS' && field === 'amount') {
                    input.value = cbsData.SUBCONTRACTS.amount;
                } else if (category === 'INDIRECT' && field === 'percentage') {
                    input.value = cbsData.INDIRECT.percentage;
                }
            });

            // Update the display
            updateCBSDisplay(stateKey, cbsData);
            updateGroupTotalCost(stateKey, cbsData.total);
        }
    });

    // Update project total cost
    updateProjectTotalCost();
}

// REMOVED: updateCBSTableData - Now updating editable CBS tables directly in updateAllCBSTables
// ============================================================================
// function to create CBS table with inferred costs
// ============================================================================

/**
 * Infer CBS costs from workgroup activities
 */
function inferCBSFromActivities(activities) {
    const cbs = {
        DIRECT_LABOR: { amount: 0, hours: 0, rate: 75, items: [] },
        DIRECT_MATERIAL: { amount: 0, quantity: 0, unitCost: 100, items: [] },
        EQUIPMENT: { amount: 0, days: 0, rate: 500, items: [] },
        SUBCONTRACTS: { amount: 0, items: [] },
        INDIRECT: { amount: 0, percentage: 10, items: [] }
    };

    activities.forEach(act => {
        const name = (act.Name || act.name || '').toLowerCase();
        const duration = parseFloat(act.Duration) || 1;

        // Categorize by keywords
        if (name.includes('install') || name.includes('construct') || name.includes('build') ||
            name.includes('erect') || name.includes('assemble')) {
            cbs.DIRECT_LABOR.hours += duration * 8; // 8 hrs/day
            cbs.DIRECT_LABOR.items.push(act.Name);
        }
        else if (name.includes('material') || name.includes('supply') || name.includes('procure') ||
            name.includes('deliver') || name.includes('concrete') || name.includes('steel')) {
            cbs.DIRECT_MATERIAL.quantity += 1;
            cbs.DIRECT_MATERIAL.items.push(act.Name);
        }
        else if (name.includes('equipment') || name.includes('crane') || name.includes('excavat') ||
            name.includes('machine')) {
            cbs.EQUIPMENT.days += duration;
            cbs.EQUIPMENT.items.push(act.Name);
        }
        else if (name.includes('subcontract') || name.includes('vendor') || name.includes('consultant')) {
            cbs.SUBCONTRACTS.amount += 10000; // Default subcontract amount
            cbs.SUBCONTRACTS.items.push(act.Name);
        }
        else {
            // Default to labor
            cbs.DIRECT_LABOR.hours += duration * 4; // 4 hrs/day for other tasks
            cbs.DIRECT_LABOR.items.push(act.Name);
        }
    });

    // Calculate amounts
    cbs.DIRECT_LABOR.amount = cbs.DIRECT_LABOR.hours * cbs.DIRECT_LABOR.rate;
    cbs.DIRECT_MATERIAL.amount = cbs.DIRECT_MATERIAL.quantity * cbs.DIRECT_MATERIAL.unitCost * 100;
    cbs.EQUIPMENT.amount = cbs.EQUIPMENT.days * cbs.EQUIPMENT.rate;

    // Calculate indirect as % of directs
    const directTotal = cbs.DIRECT_LABOR.amount + cbs.DIRECT_MATERIAL.amount +
        cbs.EQUIPMENT.amount + cbs.SUBCONTRACTS.amount;
    cbs.INDIRECT.amount = directTotal * (cbs.INDIRECT.percentage / 100);

    cbs.total = directTotal + cbs.INDIRECT.amount;

    return cbs;
}

// ============================================================================
// EDITABLE CBS TABLE WITH LIVE UPDATES
// ============================================================================
function createEditableCBSTable(groupId, groupType, activities, existingCBS) {
    // Use existing CBS if available, otherwise infer from activities
    const cbs = existingCBS || inferCBSFromActivities(activities);

    // Store in global state - with safety checks
    const stateKey = `${groupType}-${groupId}`;

    if (!window.cybereumState.costEstimation) {
        window.cybereumState.costEstimation = {
            isEstimating: false,
            currentEstimates: null,
            cbsData: null,
            controlAccounts: null,
            groupCBSData: {}
        };
    }
    if (!window.cybereumState.costEstimation.groupCBSData) {
        window.cybereumState.costEstimation.groupCBSData = {};
    }

    window.cybereumState.costEstimation.groupCBSData[stateKey] = cbs;

    const container = document.createElement('div');
    container.className = 'editable-cbs-table';
    container.setAttribute('data-group-id', groupId);
    container.setAttribute('data-group-type', groupType);
    container.style.cssText = `
        padding: 15px;
        background: linear-gradient(135deg, rgba(90, 200, 250, 0.05) 0%, rgba(189, 147, 249, 0.05) 100%);
        border: 1px solid rgba(90, 200, 250, 0.3);
        border-radius: 8px;
        height: 100%;
        box-sizing: border-box;
    `;

    // Header with total
    const header = document.createElement('div');
    header.style.cssText = `
        margin-bottom: 10px; 
        padding-bottom: 10px; 
        border-bottom: 1px solid rgba(90, 200, 250, 0.3);
        display: flex;
        justify-content: space-between;
        align-items: center;
    `;
    header.innerHTML = `
        <div>
            <div style="color: #5ac8fa; font-size: 14px; font-weight: bold; margin-bottom: 5px;">💰 Cost Breakdown Structure (CBS)</div>
            <div style="color: #50fa7b; font-size: 18px;">
                Total: <span id="cbs-total-${stateKey}" class="cbs-total-display">$${(cbs.total || 0).toLocaleString()}</span>
            </div>
        </div>
        <button onclick="refreshCBSGroup('${stateKey}')" style="
            padding: 6px 12px;
            background: linear-gradient(135deg, #5ac8fa 0%, #41afeb 100%);
            color: #0d2137;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 11px;
            font-weight: bold;
        ">🤖 Update with AI</button>
    `;

    // Add custom styling for number inputs
    const style = document.createElement('style');
    style.textContent = `
        .cbs-editable-input {
            appearance: auto;
            -webkit-appearance: auto;
            -moz-appearance: auto;
        }
        
        /* Style the spin buttons */
        .cbs-editable-input::-webkit-inner-spin-button,
        .cbs-editable-input::-webkit-outer-spin-button {
            -webkit-appearance: inner-spin-button;
            opacity: 1;
            height: 22px;
            width: 16px;
            margin-left: 4px;
            cursor: pointer;
        }
        
        .cbs-editable-input::-webkit-inner-spin-button:hover,
        .cbs-editable-input::-webkit-outer-spin-button:hover {
            background: rgba(90, 200, 250, 0.2);
        }
        
        /* Firefox spin buttons */
        .cbs-editable-input[type="number"] {
            -moz-appearance: number-input;
        }
    `;
    container.appendChild(style);

    container.appendChild(header);

    // Create editable table
    const table = document.createElement('table');
    table.style.cssText = 'width: 100%; font-size: 12px;';
    table.innerHTML = `
        <thead>
            <tr style="border-bottom: 1px solid rgba(90, 200, 250, 0.2);">
                <th style="padding: 5px; text-align: left; color: #8be9fd;">Category</th>
                <th style="padding: 5px; text-align: center; color: #8be9fd;">Quantity</th>
                <th style="padding: 5px; text-align: center; color: #8be9fd;">Rate</th>
                <th style="padding: 5px; text-align: right; color: #8be9fd;">Amount</th>
            </tr>
        </thead>
    `;

    const tbody = document.createElement('tbody');

    // Direct Labor Row
    tbody.appendChild(createEditableRow(
        stateKey,
        'DIRECT_LABOR',
        '👷 Labor',
        cbs.DIRECT_LABOR.hours,
        cbs.DIRECT_LABOR.rate,
        cbs.DIRECT_LABOR.amount,
        'hours',
        '$/hr'
    ));

    // Direct Material Row
    tbody.appendChild(createEditableRow(
        stateKey,
        'DIRECT_MATERIAL',
        '📦 Materials',
        cbs.DIRECT_MATERIAL.quantity,
        cbs.DIRECT_MATERIAL.unitCost,
        cbs.DIRECT_MATERIAL.amount,
        'units',
        '$/unit'
    ));

    // Equipment Row
    tbody.appendChild(createEditableRow(
        stateKey,
        'EQUIPMENT',
        '🏗️ Equipment',
        cbs.EQUIPMENT.days,
        cbs.EQUIPMENT.rate,
        cbs.EQUIPMENT.amount,
        'days',
        '$/day'
    ));

    // Subcontracts Row (amount only)
    tbody.appendChild(createSubcontractsRow(
        stateKey,
        cbs.SUBCONTRACTS.amount
    ));

    // Indirect Row (percentage-based)
    tbody.appendChild(createIndirectRow(
        stateKey,
        cbs.INDIRECT.percentage,
        cbs.INDIRECT.amount
    ));

    table.appendChild(tbody);
    container.appendChild(table);

    // Note about editing
    const note = document.createElement('div');
    note.style.cssText = `
        margin-top: 10px;
        padding: 8px;
        background: rgba(189, 147, 249, 0.1);
        border-radius: 4px;
        color: #bd93f9;
        font-size: 11px;
    `;
    note.innerHTML = '💡 Edit values above to manually adjust costs. Changes update automatically. Click "💰 Estimate Work Group Costs" button at top to refresh all groups with AI estimates.';
    container.appendChild(note);

    return container;
}

function createEditableRow(stateKey, category, label, quantity, rate, amount, qtyUnit, rateUnit) {
    const row = document.createElement('tr');
    row.style.cssText = 'border-bottom: 1px solid rgba(90, 200, 250, 0.1);';

    row.innerHTML = `
        <td style="padding: 5px; color: #50fa7b;">${label}</td>
        <td style="padding: 5px; text-align: center;">
            <input type="number" 
                   id="cbs-${stateKey}-${category}-quantity"
                   name="cbs-${stateKey}-${category}-quantity"
                   class="cbs-editable-input" 
                   data-state-key="${stateKey}"
                   data-category="${category}"
                   data-field="quantity"
                   value="${quantity || 0}" 
                   style="width: 85px; background: rgba(90, 200, 250, 0.1); color: #cdfaff; border: 1px solid #5ac8fa; border-radius: 4px; padding: 4px 8px; text-align: right; font-size: 13px;"
                   step="any">
            <span style="color: #8be9fd; font-size: 10px; margin-left: 3px;">${qtyUnit}</span>
        </td>
        <td style="padding: 5px; text-align: center;">
            <input type="number" 
                   id="cbs-${stateKey}-${category}-rate"
                   name="cbs-${stateKey}-${category}-rate"
                   class="cbs-editable-input" 
                   data-state-key="${stateKey}"
                   data-category="${category}"
                   data-field="rate"
                   value="${rate || 0}" 
                   style="width: 85px; background: rgba(90, 200, 250, 0.1); color: #cdfaff; border: 1px solid #5ac8fa; border-radius: 4px; padding: 4px 8px; text-align: right; font-size: 13px;"
                   step="any">
            <span style="color: #8be9fd; font-size: 10px; margin-left: 3px;">${rateUnit}</span>
        </td>
        <td style="padding: 5px; text-align: right;">
            <span class="cbs-amount-display" data-state-key="${stateKey}" data-category="${category}" style="color: #50fa7b; font-weight: bold;">
                $${(amount || 0).toLocaleString()}
            </span>
        </td>
    `;

    // Add event listeners to inputs
    const inputs = row.querySelectorAll('.cbs-editable-input');
    inputs.forEach(input => {
        input.addEventListener('change', handleCBSInputChange);
        input.addEventListener('blur', handleCBSInputChange);
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            }
        });
    });

    return row;
}

function createSubcontractsRow(stateKey, amount) {
    const row = document.createElement('tr');
    row.style.cssText = 'border-bottom: 1px solid rgba(90, 200, 250, 0.1);';

    row.innerHTML = `
        <td style="padding: 5px; color: #bd93f9;">📄 Subcontracts</td>
        <td colspan="2" style="padding: 5px; text-align: center;">
            <input type="number" 
                   id="cbs-${stateKey}-SUBCONTRACTS-amount"
                   name="cbs-${stateKey}-SUBCONTRACTS-amount"
                   class="cbs-editable-input" 
                   data-state-key="${stateKey}"
                   data-category="SUBCONTRACTS"
                   data-field="amount"
                   value="${amount || 0}" 
                   style="width: 150px; background: rgba(90, 200, 250, 0.1); color: #cdfaff; border: 1px solid #5ac8fa; border-radius: 4px; padding: 4px 8px; text-align: right; font-size: 13px;"
                   step="any">
        </td>
        <td style="padding: 5px; text-align: right;">
            <span class="cbs-amount-display" data-state-key="${stateKey}" data-category="SUBCONTRACTS" style="color: #50fa7b; font-weight: bold;">
                $${(amount || 0).toLocaleString()}
            </span>
        </td>
    `;

    const input = row.querySelector('.cbs-editable-input');
    input.addEventListener('change', handleCBSInputChange);
    input.addEventListener('blur', handleCBSInputChange);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        }
    });

    return row;
}

function createIndirectRow(stateKey, percentage, amount) {
    const row = document.createElement('tr');
    row.style.cssText = 'border-top: 1px solid rgba(90, 200, 250, 0.3);';

    row.innerHTML = `
        <td style="padding: 5px; color: #ff79c6;">💼 Overhead</td>
        <td colspan="2" style="padding: 5px; text-align: center;">
            <input type="number" 
                   id="cbs-${stateKey}-INDIRECT-percentage"
                   name="cbs-${stateKey}-INDIRECT-percentage"
                   class="cbs-editable-input" 
                   data-state-key="${stateKey}"
                   data-category="INDIRECT"
                   data-field="percentage"
                   value="${percentage || 10}" 
                   style="width: 85px; background: rgba(90, 200, 250, 0.1); color: #cdfaff; border: 1px solid #5ac8fa; border-radius: 4px; padding: 4px 8px; text-align: right; font-size: 13px;"
                   step="any"
                   min="0"
                   max="100">
            <span style="color: #8be9fd; font-size: 10px; margin-left: 3px;">% of directs</span>
        </td>
        <td style="padding: 5px; text-align: right;">
            <span class="cbs-amount-display" data-state-key="${stateKey}" data-category="INDIRECT" style="color: #50fa7b; font-weight: bold;">
                $${(amount || 0).toLocaleString()}
            </span>
        </td>
    `;

    const input = row.querySelector('.cbs-editable-input');
    input.addEventListener('change', handleCBSInputChange);
    input.addEventListener('blur', handleCBSInputChange);
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
        }
    });

    return row;
}

function handleCBSInputChange(event) {
    const input = event.target;
    const stateKey = input.dataset.stateKey;
    const category = input.dataset.category;
    const field = input.dataset.field;
    const value = parseFloat(input.value) || 0;

    // Prevent negative values
    if (value < 0) {
        input.value = 0;
        return;
    }

    // Cap at 1 billion
    if (value > 1000000000) {
        input.value = 1000000000;
        return;
    }

    // Update the CBS data in state - with safety checks
    if (!window.cybereumState?.costEstimation?.groupCBSData) {
        console.warn('CBS data structure not initialized');
        return;
    }
    const cbsData = window.cybereumState.costEstimation.groupCBSData[stateKey];
    if (!cbsData) return;

    if (field === 'quantity') {
        if (category === 'DIRECT_LABOR') cbsData.DIRECT_LABOR.hours = value;
        else if (category === 'DIRECT_MATERIAL') cbsData.DIRECT_MATERIAL.quantity = value;
        else if (category === 'EQUIPMENT') cbsData.EQUIPMENT.days = value;
    } else if (field === 'rate') {
        if (category === 'DIRECT_LABOR') cbsData.DIRECT_LABOR.rate = value;
        else if (category === 'DIRECT_MATERIAL') cbsData.DIRECT_MATERIAL.unitCost = value;
        else if (category === 'EQUIPMENT') cbsData.EQUIPMENT.rate = value;
    } else if (field === 'amount' && category === 'SUBCONTRACTS') {
        cbsData.SUBCONTRACTS.amount = value;
    } else if (field === 'percentage' && category === 'INDIRECT') {
        cbsData.INDIRECT.percentage = value;
    }

    // Recalculate amounts
    cbsData.DIRECT_LABOR.amount = cbsData.DIRECT_LABOR.hours * cbsData.DIRECT_LABOR.rate;
    cbsData.DIRECT_MATERIAL.amount = cbsData.DIRECT_MATERIAL.quantity * cbsData.DIRECT_MATERIAL.unitCost;
    cbsData.EQUIPMENT.amount = cbsData.EQUIPMENT.days * cbsData.EQUIPMENT.rate;

    // Calculate indirect based on directs
    const directTotal = cbsData.DIRECT_LABOR.amount +
        cbsData.DIRECT_MATERIAL.amount +
        cbsData.EQUIPMENT.amount +
        cbsData.SUBCONTRACTS.amount;
    cbsData.INDIRECT.amount = directTotal * (cbsData.INDIRECT.percentage / 100);

    // Calculate total
    cbsData.total = directTotal + cbsData.INDIRECT.amount;

    // Update the UI
    updateCBSDisplay(stateKey, cbsData);
    updateGroupTotalCost(stateKey, cbsData.total);
    updateProjectTotalCost();
}

function updateCBSDisplay(stateKey, cbsData) {
    // Update all amount displays for this group
    document.querySelectorAll(`.cbs-amount-display[data-state-key="${stateKey}"]`).forEach(span => {
        const category = span.dataset.category;
        let amount = 0;

        if (category === 'DIRECT_LABOR') amount = cbsData.DIRECT_LABOR.amount;
        else if (category === 'DIRECT_MATERIAL') amount = cbsData.DIRECT_MATERIAL.amount;
        else if (category === 'EQUIPMENT') amount = cbsData.EQUIPMENT.amount;
        else if (category === 'SUBCONTRACTS') amount = cbsData.SUBCONTRACTS.amount;
        else if (category === 'INDIRECT') amount = cbsData.INDIRECT.amount;

        span.textContent = `$${amount.toLocaleString()}`;
    });

    // Update total
    const totalDisplay = document.getElementById(`cbs-total-${stateKey}`);
    if (totalDisplay) {
        totalDisplay.textContent = `$${(cbsData.total || 0).toLocaleString()}`;
    }
}

function updateGroupTotalCost(stateKey, total) {
    // Update the group-level cost display
    const parts = stateKey.split('-');
    const groupType = parts[0];
    const groupId = parts.slice(1).join('-');

    const costValueEl = document.getElementById(`cost-value-${groupType}-${groupId}`);
    if (costValueEl) {
        costValueEl.textContent = `$${total.toLocaleString()}`;
    }

    // Update breakdown - with safety checks
    if (!window.cybereumState?.costEstimation?.groupCBSData) {
        return;
    }
    const cbsData = window.cybereumState.costEstimation.groupCBSData[stateKey];
    if (cbsData) {
        const laborEl = document.getElementById(`cost-labor-${groupType}-${groupId}`);
        const materialsEl = document.getElementById(`cost-materials-${groupType}-${groupId}`);
        const equipmentEl = document.getElementById(`cost-equipment-${groupType}-${groupId}`);
        const indirectEl = document.getElementById(`cost-indirect-${groupType}-${groupId}`);

        if (laborEl) laborEl.textContent = `$${cbsData.DIRECT_LABOR.amount.toLocaleString()}`;
        if (materialsEl) materialsEl.textContent = `$${cbsData.DIRECT_MATERIAL.amount.toLocaleString()}`;
        if (equipmentEl) equipmentEl.textContent = `$${cbsData.EQUIPMENT.amount.toLocaleString()}`;
        if (indirectEl) indirectEl.textContent = `$${cbsData.INDIRECT.amount.toLocaleString()}`;
    }

    // Show the group cost container
    const costContainer = document.getElementById(`cost-display-${groupType}-${groupId}`);
    if (costContainer) {
        costContainer.style.display = 'block';
    }
}

function updateProjectTotalCost() {
    // Calculate total across all groups
    let projectTotal = 0;
    Object.values(window.cybereumState.costEstimation.groupCBSData || {}).forEach(cbsData => {
        projectTotal += (cbsData.total || 0);
    });

    // Update the main cost display at the top
    const costTotalValue = document.getElementById('cost-total-value');
    if (costTotalValue) {
        costTotalValue.textContent = `$${projectTotal.toLocaleString()}`;
    }

    const costTotalDisplay = document.getElementById('cost-total-display');
    if (costTotalDisplay) {
        costTotalDisplay.style.display = 'flex';
    }
}

function refreshCBSGroup(stateKey) {
    // TODO: Implement individual group refresh in future version
    // For now, direct users to the main cost estimation button
    _log('Refresh requested for group:', stateKey);
    alert('To update costs with AI, please use the "💰 Estimate Work Group Costs" button at the top. This will refresh all groups with the latest AI estimates.');
}
// REMOVED: createCBSTableWithInference - Consolidated into createEditableCBSTable


// REMOVED: createCBSTableWithData and updateCBSTableData - Consolidated into createEditableCBSTable
// The editable CBS table now gets updated directly with AI estimates


/**
 * Infer Control Accounts from WBS Structure
 */
function inferControlAccounts(nodes) {
    const controlAccounts = new Map();

    // Group by WBS at control level (typically level 3-4)
    nodes.forEach(node => {
        if (!node.WBS_IsLeaf && node.WorkPackage !== 1) {
            const caId = node.WBS_ID || node.WBS_Code;
            if (caId && !controlAccounts.has(caId)) {
                controlAccounts.set(caId, {
                    id: caId,
                    wbsCode: node.WBS_Code,
                    wbsName: node.WBS_Name,
                    wbsPath: node.WBS_Path,
                    workPackages: [],
                    activities: [],
                    cbsData: initializeCBSData()
                });
            }
        }
    });

    // Assign leaf WBS/Work Packages to Control Accounts
    nodes.forEach(node => {
        if (node.WBS_IsLeaf || node.WorkPackage === 1) {
            const pathParts = (node.WBS_Path || '').split(' / ');
            for (let i = pathParts.length - 2; i >= 0; i--) {
                const potentialCA = Array.from(controlAccounts.values())
                    .find(ca => ca.wbsName === pathParts[i]);
                if (potentialCA) {
                    potentialCA.activities.push(node);
                    if (node.WorkPackage === 1) {
                        potentialCA.workPackages.push(node);
                    }
                    break;
                }
            }
        }
    });

    return controlAccounts;
}

/**
 * Classify cost type using activity name and AI-enhanced keywords
 */
function classifyCostType(activityName, description = '') {
    const keywords = {
        DIRECT_LABOR: [
            'engineer', 'worker', 'labor', 'manpower', 'staff', 'crew',
            'personnel', 'technician', 'operator', 'supervisor', 'foreman'
        ],
        DIRECT_MATERIAL: [
            'material', 'steel', 'concrete', 'pipe', 'cement', 'supply',
            'purchase', 'procurement', 'commodity', 'consumable', 'aggregate'
        ],
        EQUIPMENT: [
            'equipment', 'crane', 'excavator', 'machinery', 'vehicle',
            'tool', 'rental', 'lease', 'mobilization', 'demobilization'
        ],
        SUBCONTRACTS: [
            'subcontract', 'contractor', 'vendor', 'supplier', 'consultant',
            'specialist', 'outsource', 'third-party', 'service provider'
        ],
        INDIRECT: [
            'overhead', 'management', 'admin', 'supervision', 'office',
            'insurance', 'permit', 'facility', 'utilities', 'safety'
        ]
    };

    const nameLower = (activityName + ' ' + description).toLowerCase();

    // Score each category
    const scores = {};
    for (const [type, words] of Object.entries(keywords)) {
        scores[type] = words.filter(w => nameLower.includes(w)).length;
    }

    // Return highest scoring category
    const maxScore = Math.max(...Object.values(scores));
    if (maxScore > 0) {
        return Object.entries(scores).find(([type, score]) => score === maxScore)[0];
    }

    return 'DIRECT_LABOR'; // default
}


/**
 * Initialize CBS data structure for a work group
 */
function initializeCBSData() {
    return {
        DIRECT_LABOR: {
            amount: 0,
            hours: 0,
            rate: 75, // default rate
            locked: false
        },
        DIRECT_MATERIAL: {
            amount: 0,
            quantity: 0,
            unitCost: 0,
            unit: 'unit',
            locked: false
        },
        EQUIPMENT: {
            amount: 0,
            days: 0,
            rate: 500, // default daily rate
            locked: false
        },
        SUBCONTRACTS: {
            amount: 0,
            locked: false
        },
        INDIRECT: {
            amount: 0,
            percentage: 10, // default 10% of directs
            locked: false
        },
        total: 0
    };
}

/**
 * Calculate CBS totals and update amounts
 */
function calculateCBSTotals(cbsData) {
    // Calculate direct costs first
    let directTotal = 0;

    // Labor
    if (!cbsData.DIRECT_LABOR.locked) {
        cbsData.DIRECT_LABOR.amount = CBS_CATEGORIES.DIRECT_LABOR.calculate(cbsData.DIRECT_LABOR);
    }
    directTotal += cbsData.DIRECT_LABOR.amount;

    // Materials
    if (!cbsData.DIRECT_MATERIAL.locked) {
        cbsData.DIRECT_MATERIAL.amount = CBS_CATEGORIES.DIRECT_MATERIAL.calculate(cbsData.DIRECT_MATERIAL);
    }
    directTotal += cbsData.DIRECT_MATERIAL.amount;

    // Equipment
    if (!cbsData.EQUIPMENT.locked) {
        cbsData.EQUIPMENT.amount = CBS_CATEGORIES.EQUIPMENT.calculate(cbsData.EQUIPMENT);
    }
    directTotal += cbsData.EQUIPMENT.amount;

    // Subcontracts
    directTotal += cbsData.SUBCONTRACTS.amount;

    // Calculate indirect based on directs
    if (!cbsData.INDIRECT.locked) {
        cbsData.INDIRECT.amount = CBS_CATEGORIES.INDIRECT.calculate(cbsData.INDIRECT, directTotal);
    }

    // Total
    cbsData.total = directTotal + cbsData.INDIRECT.amount;

    return cbsData;
}

/**
 * Find control account for a work group
 */
function findControlAccount(wg, controlAccounts) {
    const wbsPath = wg.wbsPath || wg.activities?.[0]?.WBS_Path || '';

    for (const [caId, ca] of controlAccounts) {
        if (wbsPath.includes(ca.wbsName)) {
            return ca;
        }
    }
    return null;
}

/**
 * Create CBS prompt enhancement for API
 */
function createCBSPromptEnhancement() {
    return `
Please provide detailed cost breakdown by CBS category for each work group:
- Direct Labor: hourly rates × hours (consider skill levels)
- Direct Materials: quantity × unit cost (include waste factors)  
- Equipment: rental rates × duration (include mob/demob)
- Subcontracts: lump sum amounts
- Indirect/Overhead: percentage of direct costs

Include confidence levels and key assumptions for each estimate.
`;
}

/**
 * Apply estimates to CBS data
 */
function applyEstimatesToCBS(estimates, workGroups) {
    if (!estimates || !estimates.workGroupEstimates) return;

    estimates.workGroupEstimates.forEach(est => {
        const wg = workGroups.find(w => w.id === est.id);
        if (wg && est.cbsBreakdown) {
            // Apply CBS breakdown to work group
            Object.keys(CBS_CATEGORIES).forEach(cat => {
                if (est.cbsBreakdown[cat]) {
                    Object.assign(wg.cbsData[cat], est.cbsBreakdown[cat]);
                }
            });

            // Recalculate totals
            calculateCBSTotals(wg.cbsData);
        }
    });
}

/**
 * Display enhanced CBS modal
 */
function displayCBSEstimationModal(estimates, workGroupData) {
    // Use existing modal creation but enhance with CBS tables
    const existingModal = document.getElementById('cost-modal');
    if (existingModal) {
        existingModal.remove();
    }

    // Call the original displayCostEstimationModal but it will use enhanced content
    displayCostEstimationModal(estimates, workGroupData);
}

// ============================================================================
// CBS EXPORT ENHANCEMENT
// ============================================================================

/**
 * Export CBS-enhanced CSV
 */
function exportCBSToCSV(estimates, workGroupData) {
    const csv = [];

    // Headers
    csv.push(['CBS Cost Breakdown Report']);
    csv.push(['Generated:', new Date().toLocaleString()]);
    csv.push([]);
    csv.push([
        'Work Group',
        'WBS Code',
        'Control Account',
        'Activities',
        'Direct Labor',
        'Direct Materials',
        'Equipment',
        'Subcontracts',
        'Indirect/Overhead',
        'Total',
        'Confidence'
    ].join(','));

    // Data rows
    let totals = {
        DIRECT_LABOR: 0,
        DIRECT_MATERIAL: 0,
        EQUIPMENT: 0,
        SUBCONTRACTS: 0,
        INDIRECT: 0,
        total: 0
    };

    workGroupData.workGroups.forEach((wg, idx) => {
        const est = estimates.workGroupEstimates.find(e => e.id === wg.id) || {};
        const cbsData = wg.cbsData || initializeCBSData();

        csv.push([
            `"${wg.name}"`,
            wg.wbsCode || wg._displayData?.wbsCode || '',
            wg.controlAccount?.wbsName || '',
            wg.activityCount || 0,
            cbsData.DIRECT_LABOR.amount || 0,
            cbsData.DIRECT_MATERIAL.amount || 0,
            cbsData.EQUIPMENT.amount || 0,
            cbsData.SUBCONTRACTS.amount || 0,
            cbsData.INDIRECT.amount || 0,
            cbsData.total || est.estimatedCost || 0,
            est.confidence || 'Medium'
        ].join(','));

        // Add to totals
        Object.keys(totals).forEach(key => {
            if (key === 'total') {
                totals[key] += cbsData.total || est.estimatedCost || 0;
            } else {
                totals[key] += cbsData[key]?.amount || 0;
            }
        });
    });

    // Total row
    csv.push([]);
    csv.push([
        'TOTAL',
        '',
        '',
        workGroupData.workGroups.reduce((sum, wg) => sum + (wg.activityCount || 0), 0),
        totals.DIRECT_LABOR,
        totals.DIRECT_MATERIAL,
        totals.EQUIPMENT,
        totals.SUBCONTRACTS,
        totals.INDIRECT,
        totals.total,
        ''
    ].join(','));

    // Control Accounts Summary
    if (window.cybereumState.costEstimation.controlAccounts) {
        csv.push([]);
        csv.push(['Control Accounts Summary']);
        csv.push(['Control Account', 'WBS Code', 'Activities', 'Total Cost'].join(','));

        window.cybereumState.costEstimation.controlAccounts.forEach((ca) => {
            csv.push([
                `"${ca.wbsName}"`,
                ca.wbsCode || '',
                ca.activities.length,
                ca.cbsData?.total || 0
            ].join(','));
        });
    }

    // Download
    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CBS_Cost_Estimates_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// Override the original export function
window.exportCostsToCSV = function (estimates) {
    const workGroupData = window._costEstimationWorkGroupData || window.cybereumState.costEstimation.cbsData;
    if (workGroupData) {
        exportCBSToCSV(estimates, workGroupData);
    } else {
        console.error('No work group data available for export');
    }
};

async function estimateWorkGroupCosts(groupedNodes, groupNames, groupType, allNodes) {

    const button = document.getElementById('estimate-costs-btn');
    const statusDiv = document.getElementById('cost-status');
    const totalDisplay = document.getElementById('cost-total-display');

    const BATCH_SIZE = 12;
    const REQUEST_TIMEOUT_MS = 180000; // 3 minutes per batch
    const MAX_RETRIES = 2; // Retry failed batches up to 2 times

    // Helper: fetch with timeout and retry
    async function fetchWithRetry(url, options, retries, label) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                const response = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(timeoutId);
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`${label}: ${errorText}`);
                }
                return await response.json();
            } catch (err) {
                clearTimeout(timeoutId);
                const isTimeout = err?.name === 'AbortError';
                const msg = isTimeout ? 'request timeout' : (err?.message || String(err));
                if (attempt < retries) {
                    const backoffMs = 2000 * (attempt + 1);
                    console.warn(`[CostEstimation] ${label} attempt ${attempt + 1}/${retries + 1} failed: ${msg}. Retrying in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                } else {
                    throw new Error(isTimeout ? `${label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : msg);
                }
            }
        }
    }

    // Helper: build API payload from project context and work groups
    function buildPayload(projectCtx, workGroups) {
        return {
            project: {
                sector: projectCtx.sector,
                region: projectCtx.region,
                regionCode: projectCtx.regionCode,
                country: projectCtx.country,
                countryName: projectCtx.countryName,
                currency: projectCtx.currency,
                timeline: projectCtx.timeline,
                budget: projectCtx.budget,
                budgetRaw: projectCtx.budgetRaw,
                background: projectCtx.background,
                costOverrun: projectCtx.costOverrun,
                scheduleOverrun: projectCtx.scheduleOverrun,
                startDate: projectCtx.startDate,
                endDate: projectCtx.endDate
            },
            workGroups: workGroups.map(wg => ({
                id: wg.id,
                name: wg.name,
                wbsPath: wg.wbsPath,
                activityCount: wg.activityCount,
                totalDuration: wg.totalDuration,
                criticalCount: wg.criticalCount,
                metrics: wg.metrics,
                activities: wg.activities
            }))
        };
    }

    try {

        // Update UI
        button.disabled = true;
        button.style.opacity = '0.6';
        button.innerHTML = '⏳ Analyzing...';
        statusDiv.style.display = 'block';
        statusDiv.textContent = 'Gathering work group data...';
        statusDiv.style.color = '#ffeb3b';

        // Gather data
        const workGroupData = gatherWorkGroupDataFromDisplay(groupedNodes, groupNames, groupType, allNodes);

        // VALIDATION: Check if we have groups
        if (!workGroupData || workGroupData.workGroups.length === 0) {
            throw new Error('No work groups found to estimate');
        }

        // VALIDATION: Warn about skipped groups
        if (workGroupData.skippedGroups && workGroupData.skippedGroups.length > 0) {
            const warningMsg = `⚠️ WARNING: ${workGroupData.skippedGroups.length} group(s) were skipped due to having no activities.`;
            console.warn(warningMsg);
            statusDiv.textContent = warningMsg;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const expectedGroupCount = Object.keys(groupedNodes).length;
        const actualGroupCount = workGroupData.workGroups.length;

        _log(`📊 Estimating costs for ${actualGroupCount} out of ${expectedGroupCount} total groups`);

        const needsBatching = actualGroupCount > BATCH_SIZE;

        let allEstimates = {
            metadata: null,
            workGroupEstimates: [],
            summary: {
                totalEstimatedCost: 0,
                totalDirectLabor: 0,
                totalDirectMaterial: 0,
                totalEquipment: 0,
                totalSubcontracts: 0,
                totalIndirect: 0,
                costRange: { low: 0, expected: 0, high: 0 }
            },
            notes: []
        };

        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };

        if (needsBatching) {
            // BATCHED PROCESSING for large projects
            const totalBatches = Math.ceil(actualGroupCount / BATCH_SIZE);
            _log(`📦 Batching: ${actualGroupCount} groups into ${totalBatches} batches of ${BATCH_SIZE}`);

            for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
                const startIdx = batchNum * BATCH_SIZE;
                const endIdx = Math.min(startIdx + BATCH_SIZE, actualGroupCount);
                const batchGroups = workGroupData.workGroups.slice(startIdx, endIdx);

                statusDiv.textContent = `Estimating batch ${batchNum + 1}/${totalBatches} (${batchGroups.length} groups)...`;
                _log(`⏳ Processing batch ${batchNum + 1}/${totalBatches}: groups ${startIdx}-${endIdx - 1}`);

                const batchPayload = buildPayload(workGroupData.project, batchGroups);

                const batchEstimates = await fetchWithRetry(
                    '/OpenAI/EstimateWorkGroupCosts',
                    { ...fetchOptions, body: JSON.stringify(batchPayload) },
                    MAX_RETRIES,
                    `Batch ${batchNum + 1}`
                );

                _log(`✓ Batch ${batchNum + 1} complete: ${batchEstimates.workGroupEstimates?.length || 0} estimates received`);

                // Merge batch results
                if (batchNum === 0) {
                    allEstimates.metadata = batchEstimates.metadata;
                }

                if (batchEstimates.workGroupEstimates) {
                    allEstimates.workGroupEstimates.push(...batchEstimates.workGroupEstimates);
                }

                // Accumulate summary totals
                if (batchEstimates.summary) {
                    allEstimates.summary.totalEstimatedCost += batchEstimates.summary.totalEstimatedCost || 0;
                    allEstimates.summary.totalDirectLabor += batchEstimates.summary.totalDirectLabor || 0;
                    allEstimates.summary.totalDirectMaterial += batchEstimates.summary.totalDirectMaterial || 0;
                    allEstimates.summary.totalEquipment += batchEstimates.summary.totalEquipment || 0;
                    allEstimates.summary.totalSubcontracts += batchEstimates.summary.totalSubcontracts || 0;
                    allEstimates.summary.totalIndirect += batchEstimates.summary.totalIndirect || 0;
                }

                if (batchEstimates.notes) {
                    allEstimates.notes.push(...batchEstimates.notes);
                }

                // Accumulate per-batch cost ranges (P10/P50/P90 from AI)
                if (batchEstimates.summary?.costRange) {
                    allEstimates.summary.costRange.low += batchEstimates.summary.costRange.low || 0;
                    allEstimates.summary.costRange.expected += batchEstimates.summary.costRange.expected || 0;
                    allEstimates.summary.costRange.high += batchEstimates.summary.costRange.high || 0;
                }

                // Small delay between batches to avoid rate limits
                if (batchNum < totalBatches - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            _log(`✓ All ${totalBatches} batches complete! Total: ${allEstimates.workGroupEstimates.length} estimates`);
            statusDiv.textContent = `✓ Estimated ${allEstimates.workGroupEstimates.length} work groups`;

        } else {
            // SINGLE REQUEST for small projects (<=12 groups)
            statusDiv.textContent = `Estimating costs for ${actualGroupCount} work groups...`;

            const apiPayload = buildPayload(workGroupData.project, workGroupData.workGroups);

            _log(`📦 Payload size: ${JSON.stringify(apiPayload).length} chars`);

            allEstimates = await fetchWithRetry(
                '/OpenAI/EstimateWorkGroupCosts',
                { ...fetchOptions, body: JSON.stringify(apiPayload) },
                MAX_RETRIES,
                'Cost estimation'
            );

            _log('Cost estimates received:', allEstimates);
        }

        const estimates = allEstimates;

        // Store for CSV export
        window._costEstimationWorkGroupData = workGroupData;

        // VALIDATION: Check if all groups got estimates
        const estimatedCount = estimates.workGroupEstimates?.length || 0;
        if (estimatedCount !== actualGroupCount) {
            console.warn(`⚠️ Mismatch: Sent ${actualGroupCount} groups but received ${estimatedCount} estimates`);
        }

        // Update individual group displays
        updateGroupCostDisplays(estimates, workGroupData, groupType);

        // Display results modal
        displayCostEstimationModal(estimates, workGroupData);

        // Update total display
        totalDisplay.style.display = 'flex';
        const totalValue = document.getElementById('cost-total-value');
        const currency = estimates.metadata?.currency || 'USD';
        const total = estimates.summary?.totalEstimatedCost || 0;
        totalValue.textContent = `${currency} ${total.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

        statusDiv.style.color = '#50fa7b';
        statusDiv.textContent = `✓ Cost estimation complete (${estimatedCount} groups)`;

        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 3000);

    } catch (error) {
        console.error('Cost estimation error:', error);
        statusDiv.style.color = '#ff5555';
        statusDiv.textContent = `✗ Error: ${error.message}`;

        alert(`Cost estimation failed: ${error.message}`);

        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 5000);
    } finally {
        button.disabled = false;
        button.style.opacity = '1';
        button.innerHTML = '💰 Estimate Work Group Costs';
    }
}

// ============================================================================
// GATHER WORK GROUP DATA (for cost estimation + AI insights)
// ============================================================================
function gatherWorkGroupDataFromDisplay(groupedNodes, groupNames, groupType, allNodes) {
    _log('=== GATHERING WORK GROUP DATA ===');
    _log('Total groups to process:', Object.keys(groupedNodes).length);

    // Get project context from start node
    const startNode =
        window.cybereumState.nodeMap?.get('0') ||
        (allNodes || []).find(n => n.ID === '0') ||
        (allNodes || [])[0] ||
        {};

    const projectContext = {
        name: startNode.ProjectName || window.cybereumState?.project?.name || document.title || 'Project',
        sector: startNode.Segment || window.cybereumState?.project?.sector || 'General',
        region: startNode.Region || window.cybereumState?.project?.region || 'General',
        regionCode: startNode.RegionCode || window.cybereumState?.project?.regionCode || '',
        country: startNode.Country || window.cybereumState?.project?.country || 'Not specified',
        countryName: startNode.CountryName || window.cybereumState?.project?.countryName || '',
        currency: startNode.Currency || window.cybereumState?.project?.budgetCurrency || 'USD',
        timeline: startNode.ProjectTimeline || window.cybereumState?.project?.timeline || 'Not specified',
        budget: window.cybereumState?.project?.budget || 0,
        budgetRaw: startNode.ProjectBudget || window.cybereumState?.project?.budgetRaw || '0',
        background: startNode.ProjectBackground || window.cybereumState?.project?.background || '',
        costOverrun: window.cybereumState?.project?.costOverrun || 0,
        scheduleOverrun: window.cybereumState?.project?.scheduleOverrun || 0,
        startDate: window.cybereumState.startDate || null,
        endDate: window.cybereumState.endDate || null
    };

    _log('Project context:', projectContext);

    const workGroups = [];
    const skippedGroups = [];
    const groupManager = new ProjectGroupManager();

    Object.keys(groupedNodes).forEach(groupId => {
        const nodes = groupedNodes[groupId];

        // VALIDATION: Check if group has nodes
        if (!nodes || nodes.length === 0) {
            console.warn(`⚠️ Skipping group ${groupId}: No nodes`);
            skippedGroups.push({ id: groupId, reason: 'No nodes' });
            return;
        }

        const groupInfo = groupNames[groupId] || {};
        const groupName = groupInfo.Name || `Group ${groupId}`;

        // Calculate metrics
        const metrics = groupManager.calculateGroupMetrics(nodes) || {};

        // Extract WBS info if available
        const firstNode = nodes[0] || {};
        const wbsPath = firstNode.WBS_Path || firstNode.WBS_Name || '';
        const wbsCode = firstNode.WBS_Code || '';
        const wbsId = firstNode.WBS_ID || groupId;

        // Compact metrics summary for AI & analytics (token-efficient)
        const metricsSummary = {
            healthScore: metrics.healthScore,
            progress: metrics.aggregateProgress,
            schedulePerformance: metrics.schedulePerformance,  // SPI
            costPerformance: metrics.costPerformance,          // CPI
            riskScore: metrics.normalizedRiskScore,
            highRiskCount: metrics.highRiskCount,
            mediumRiskCount: metrics.mediumRiskCount,
            criticalCount: metrics.criticalTaskCount,
            nearCriticalCount: metrics.nearCriticalCount,
            behindScheduleCount: metrics.behindScheduleCount,
            aheadScheduleCount: metrics.aheadScheduleCount,
            delayedMilestones: metrics.delayedMilestones,
            completedMilestones: metrics.completedMilestones,
            earliestStart: metrics.earliestStart,
            latestEnd: metrics.latestEnd,
            // EVM metrics for cost accuracy
            BAC: metrics.BAC || null,
            BCWP: metrics.BCWP || null,
            BCWS: metrics.BCWS || null,
            ACWP: metrics.ACWP || null,
            EAC: metrics.EAC || null
        };

        // Sample activities (up to 5 for better scope inference)
        const criticalActivities = nodes.filter(n => n.isOnCriticalPath === true);
        const avgDuration =
            nodes.length > 0
                ? (metrics.totalDuration || 0) / nodes.length
                : 0;

        const longActivities = nodes.filter(n =>
            (parseFloat(n.Duration) || 0) > avgDuration * 1.5
        );

        const regularActivities = nodes.filter(n =>
            !n.isOnCriticalPath &&
            (parseFloat(n.Duration) || 0) <= avgDuration * 1.5
        );

        const sampleNodes = [
            ...(criticalActivities.slice(0, 2)),
            ...(longActivities.slice(0, 2)),
            ...(regularActivities.slice(0, 1))
        ].filter(Boolean);

        const activities = sampleNodes.map(node => ({
            id: node.ID,
            name: node.Name,
            duration: parseFloat(node.Duration) || 0,
            critical: node.isOnCriticalPath === true,
            start: node.Start || null,
            finish: node.Finish || null
        }));

        const workGroup = {
            id: wbsId,
            name: groupName,
            wbsPath: wbsPath,

            // Essential metrics
            activityCount: nodes.length,
            totalDuration: Math.round(metrics.totalDuration || 0),
            criticalCount: metrics.criticalTaskCount || 0,

            metrics: metricsSummary,

            // Sample activities for context
            activities: activities,

            // For display / mapping only (not sent to API consumers if they ignore it)
            _displayData: {
                groupId: groupId,
                groupType: groupType,
                wbsCode: wbsCode,
                description: groupInfo.Description || ''
            }
        };

        workGroups.push(workGroup);
        _log(`✓ Added group ${groupId} (${groupName}): ${nodes.length} activities`);
    });

    // CRITICAL VALIDATION: Report any skipped groups
    if (skippedGroups.length > 0) {
        console.error('⚠️ WARNING: Some groups were skipped:', skippedGroups);
    }

    _log(`=== SUMMARY: ${workGroups.length} groups ready for estimation ===`);
    _log(
        'Groups:',
        workGroups.map(wg => `${wg.name} (${wg.activityCount} activities)`).join(', ')
    );

    return {
        project: projectContext,
        workGroups: workGroups,
        skippedGroups: skippedGroups
    };
}

/**
 * Display cost estimation results in modal
 */
function displayCostEstimationModal(estimates, workGroupData) {
    // Remove existing modal
    const existingModal = document.getElementById('cost-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'cost-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.9);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        backdrop-filter: blur(5px);
    `;

    const content = document.createElement('div');
    content.style.cssText = `
        background: linear-gradient(135deg, #0d2137 0%, #102d50 100%);
        border: 2px solid #5ac8fa;
        border-radius: 12px;
        max-width: 1400px;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
        padding: 30px;
        box-shadow: 0 8px 32px rgba(90, 200, 250, 0.5);
    `;

    content.innerHTML = buildCostModalHTML(estimates, workGroupData);
    modal.appendChild(content);
    document.body.appendChild(modal);

    // Setup events
    setupCostModalEvents(modal, estimates, workGroupData);

    // Animate in
    modal.style.opacity = '0';
    setTimeout(() => {
        modal.style.transition = 'opacity 0.3s ease';
        modal.style.opacity = '1';
    }, 10);
}

/**
 * Build cost modal HTML
 */
function buildCostModalHTML(estimates, workGroupData) {
    const currency = estimates.metadata?.currency || 'USD';
    const summary = estimates.summary || {};
    const workGroupEstimates = estimates.workGroupEstimates || [];

    const fmt = (val) => {
        if (!val || isNaN(val)) return `${currency} 0`;
        return `${currency} ${val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    };

    let html = `
        <button id="close-modal-btn" style="
            position: absolute;
            top: 15px;
            right: 15px;
            background: transparent;
            border: 2px solid #ff5555;
            color: #ff5555;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 20px;
            transition: all 0.3s ease;
        ">×</button>

        <h2 style="color: #5ac8fa; font-family: 'Orbitron', sans-serif; font-size: 26px; margin: 0 0 20px 0; padding-bottom: 15px; border-bottom: 2px solid #5ac8fa;">
            💰 Work Group Cost Estimates
        </h2>

        ${workGroupData.skippedGroups && workGroupData.skippedGroups.length > 0 ? `
        <div style="background: rgba(255, 184, 108, 0.15); padding: 12px; border-radius: 6px; border-left: 4px solid #ffb86c; margin-bottom: 15px;">
            <div style="color: #ffb86c; font-size: 12px; font-weight: bold;">
                ⚠️ ${workGroupData.skippedGroups.length} group(s) skipped (no activities)
            </div>
        </div>
        ` : ''}

        <div style="background: rgba(90, 200, 250, 0.1); padding: 12px; border-radius: 6px; border: 1px solid rgba(90, 200, 250, 0.3); margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
            <div style="color: #cdfaff; font-size: 13px;">
                <span style="color: #5ac8fa; font-weight: bold;">${workGroupEstimates.length}</span> of <span style="color: #5ac8fa; font-weight: bold;">${workGroupData.workGroups.length}</span> work groups estimated
            </div>
            <div style="color: #8be9fd; font-size: 11px;">
                Currency: ${currency}
            </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 25px;">
            <div class="cost-card">
                <div class="cost-label">Total Cost</div>
                <div class="cost-value" style="color: #50fa7b;">${fmt(summary.totalEstimatedCost)}</div>
            </div>
            <div class="cost-card">
                <div class="cost-label">Labor</div>
                <div class="cost-value">${fmt(summary.totalDirectLabor)}</div>
            </div>
            <div class="cost-card">
                <div class="cost-label">Materials</div>
                <div class="cost-value">${fmt(summary.totalDirectMaterial)}</div>
            </div>
            <div class="cost-card">
                <div class="cost-label">Equipment</div>
                <div class="cost-value">${fmt(summary.totalEquipment)}</div>
            </div>
            <div class="cost-card">
                <div class="cost-label">Subcontracts</div>
                <div class="cost-value">${fmt(summary.totalSubcontracts)}</div>
            </div>
            <div class="cost-card">
                <div class="cost-label">Indirect</div>
                <div class="cost-value">${fmt(summary.totalIndirect)}</div>
            </div>
        </div>

        ${summary.costRange ? `
        <div style="background: rgba(255, 184, 108, 0.1); padding: 15px; border-radius: 8px; border-left: 4px solid #ffb86c; margin-bottom: 20px;">
            <div style="color: #ffb86c; font-family: 'Orbitron', sans-serif; font-size: 12px; font-weight: bold; margin-bottom: 10px;">
                COST RANGE
            </div>
            <div style="display: flex; justify-content: space-around; text-align: center;">
                <div>
                    <div style="color: #cdfaff; font-size: 11px;">Optimistic</div>
                    <div style="color: #50fa7b; font-size: 16px; font-weight: bold;">${fmt(summary.costRange.low)}</div>
                </div>
                <div>
                    <div style="color: #cdfaff; font-size: 11px;">Expected</div>
                    <div style="color: #5ac8fa; font-size: 18px; font-weight: bold;">${fmt(summary.costRange.expected)}</div>
                </div>
                <div>
                    <div style="color: #cdfaff; font-size: 11px;">Pessimistic</div>
                    <div style="color: #ff5555; font-size: 16px; font-weight: bold;">${fmt(summary.costRange.high)}</div>
                </div>
            </div>
        </div>
        ` : ''}

        <div style="display: flex; justify-content: space-between; align-items: center; margin: 25px 0 15px 0; padding-bottom: 10px; border-bottom: 2px solid #5ac8fa;">
            <span style="color: #5ac8fa; font-family: 'Orbitron', sans-serif; font-size: 16px; font-weight: bold;">
                Work Groups (${workGroupEstimates.length})
            </span>
            <button id="export-csv-btn" style="
                padding: 8px 16px;
                background: linear-gradient(135deg, #41afeb 0%, #287dc8 100%);
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-family: 'Orbitron', sans-serif;
            ">📊 Export CSV</button>
        </div>

        <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr style="background: rgba(90, 200, 250, 0.2); color: #5ac8fa;">
                        <th style="padding: 10px; text-align: left; border-bottom: 2px solid #5ac8fa;">Work Group</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #5ac8fa;">WBS</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #5ac8fa;">Activities</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #5ac8fa;">Est. Cost</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #5ac8fa;">Labor</th>
                        <th style="padding: 10px; text-align: right; border-bottom: 2px solid #5ac8fa;">Materials</th>
                        <th style="padding: 10px; text-align: center; border-bottom: 2px solid #5ac8fa;">Confidence</th>
                    </tr>
                </thead>
                <tbody>
    `;

    workGroupEstimates.forEach((est, idx) => {
        const wg = workGroupData.workGroups.find(w => w.id === est.id);
        const displayData = wg?._displayData || {};
        const confColor = est.confidence === 'High' ? '#50fa7b' : est.confidence === 'Low' ? '#ff5555' : '#ffeb3b';

        html += `
            <tr style="border-bottom: 1px solid rgba(90, 200, 250, 0.1);">
                <td style="padding: 10px; color: #cdfaff;">
                    <div style="font-weight: bold;">${est.name}</div>
                    ${wg?.wbsPath ? `<div style="font-size: 11px; color: #8be9fd;">${wg.wbsPath}</div>` : ''}
                </td>
                <td style="padding: 10px; text-align: center; color: #8be9fd; font-family: monospace;">${displayData.wbsCode || '-'}</td>
                <td style="padding: 10px; text-align: center; color: #cdfaff;">${wg?.activityCount || 0}</td>
                <td style="padding: 10px; text-align: right; color: #50fa7b; font-weight: bold; font-family: monospace;">${fmt(est.estimatedCost)}</td>
                <td style="padding: 10px; text-align: right; color: #cdfaff; font-family: monospace;">${fmt(est.costBreakdown?.directLabor?.amount || 0)}</td>
                <td style="padding: 10px; text-align: right; color: #cdfaff; font-family: monospace;">${fmt(est.costBreakdown?.directMaterial?.amount || 0)}</td>
                <td style="padding: 10px; text-align: center;">
                    <span style="background: ${confColor}22; color: ${confColor}; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: bold;">
                        ${est.confidence || 'Med'}
                    </span>
                </td>
            </tr>
        `;
    });

    html += `
                </tbody>
            </table>
        </div>

        ${estimates.notes && estimates.notes.length > 0 ? `
        <div style="background: rgba(189, 147, 249, 0.1); padding: 15px; border-radius: 8px; border-left: 4px solid #bd93f9; margin-top: 20px;">
            <div style="color: #bd93f9; font-family: 'Orbitron', sans-serif; font-size: 12px; font-weight: bold; margin-bottom: 10px;">
                KEY INSIGHTS
            </div>
            <ul style="color: #cdfaff; margin: 0; padding-left: 20px;">
                ${estimates.notes.map(note => `<li style="margin-bottom: 8px;">${note}</li>`).join('')}
            </ul>
        </div>
        ` : ''}

        <div style="margin-top: 25px; text-align: right;">
            <button id="save-estimates-btn" style="
                padding: 10px 20px;
                background: linear-gradient(135deg, #50fa7b 0%, #2ec760 100%);
                color: #0d2137;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-family: 'Orbitron', sans-serif;
                font-size: 13px;
                font-weight: bold;
            ">💾 Save Estimates</button>
        </div>

        <style>
            .cost-card {
                background: rgba(90, 200, 250, 0.1);
                padding: 15px;
                border-radius: 8px;
                border: 1px solid rgba(90, 200, 250, 0.3);
            }
            .cost-label {
                color: #8be9fd;
                font-size: 11px;
                font-family: 'Orbitron', sans-serif;
                margin-bottom: 8px;
            }
            .cost-value {
                color: #cdfaff;
                font-size: 18px;
                font-family: 'Courier New', monospace;
                font-weight: bold;
            }
        </style>
    `;

    return html;
}

/**
 * Setup modal event listeners
 */
function setupCostModalEvents(modal, estimates, workGroupData) {
    const closeBtn = modal.querySelector('#close-modal-btn');
    closeBtn.addEventListener('click', () => {
        modal.style.opacity = '0';
        setTimeout(() => modal.remove(), 300);
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.opacity = '0';
            setTimeout(() => modal.remove(), 300);
        }
    });

    const exportBtn = modal.querySelector('#export-csv-btn');
    exportBtn?.addEventListener('click', () => exportCostsToCSV(estimates));

    const saveBtn = modal.querySelector('#save-estimates-btn');
    saveBtn?.addEventListener('click', () => {
        _log('Saving estimates:', estimates);
        alert('Cost estimates saved! (Implement backend save as needed)');
    });
}

/**
 * Export costs to CSV
 */
function exportCostsToCSV(estimates) {
    const csv = [];
    csv.push(['Work Group', 'WBS Code', 'Activities', 'Est. Cost', 'Labor', 'Materials', 'Equipment', 'Indirect', 'Confidence'].join(','));

    estimates.workGroupEstimates.forEach(est => {
        const wg = window._costEstimationWorkGroupData?.workGroups.find(w => w.id === est.id);
        const displayData = wg?._displayData || {};

        csv.push([
            `"${est.name}"`,
            displayData.wbsCode || '',
            wg?.activityCount || 0,
            est.estimatedCost || 0,
            est.costBreakdown?.directLabor?.amount || 0,
            est.costBreakdown?.directMaterial?.amount || 0,
            est.costBreakdown?.equipment?.amount || 0,
            est.costBreakdown?.indirect?.amount || 0,
            est.confidence || 'Medium'
        ].join(','));
    });


    csv.push([]);
    csv.push(['TOTAL', '', '', estimates.summary?.totalEstimatedCost || 0,
        estimates.summary?.totalDirectLabor || 0, estimates.summary?.totalDirectMaterial || 0,
        estimates.summary?.totalEquipment || 0, estimates.summary?.totalIndirect || 0, ''].join(','));

    const blob = new Blob([csv.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cost_estimates_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================================
// END OF COST ESTIMATION MODULE
// ============================================================================
// ============================================================
// CYBEREUM WORK GROUP ENHANCEMENTS
// KPI Dashboard + Navigation Sidebar
// Add this entire file to the END of CommunityGroups.js
// ============================================================

// ── Shared palette bridge: Tailwind → CSS Custom Properties (runtime theming) ──
var _cybResolveTailwind = (function () {
    var P = (window.CybereumDesign && window.CybereumDesign.palette) || {};
    // Hex mapping: Tailwind color → var(--cyb-*) CSS custom property references
    // Fallbacks resolved from CybereumDesign palette at injection time
    var _d = P.danger || '#ff5555', _w = P.warning || '#ffb86c', _s = P.success || '#50fa7b';
    var _a = P.accent || '#5ac8fa', _t1 = P.text1 || '#cdfaff', _t2 = P.text2 || '#8ce6ff';
    var _t3 = P.textTertiary || '#5a8ab5';
    var hex = {
        '#ef4444': 'var(--cyb-danger,' + _d + ')', '#dc2626': '#cc3333',
        '#f87171': 'var(--cyb-danger,' + _d + ')',
        '#eab308': 'var(--cyb-warning,' + _w + ')', '#ca8a04': '#e69840',
        '#fbbf24': 'var(--cyb-warning,' + _w + ')',
        '#22c55e': 'var(--cyb-success,' + _s + ')', '#16a34a': '#3dd468',
        '#4ade80': 'var(--cyb-success,' + _s + ')',
        '#3b82f6': 'var(--cyb-accent,' + _a + ')', '#2563eb': '#46b9fa',
        '#1d4ed8': '#2a9fd8',
        '#60a5fa': 'var(--cyb-text2,' + _t2 + ')', '#93c5fd': 'var(--cyb-text2,' + _t2 + ')',
        '#e2e8f0': 'var(--cyb-text1,' + _t1 + ')', '#cbd5e1': 'var(--cyb-text1,' + _t1 + ')',
        '#94a3b8': 'var(--cyb-text2,' + _t2 + ')', '#64748b': 'var(--cyb-text3,' + _t3 + ')'
    };
    // RGB triplet mapping for rgba() values — these can't use var() so resolve statically
    var rgb = {
        '59,130,246': '90,200,250',      // blue-500 → accent
        '239,68,68': '255,85,85',        // red-500  → danger
        '234,179,8': '255,184,108',      // yellow-500 → warning
        '37,99,235': '70,185,250',       // blue-600 → accent glow
        '30,64,175': '42,96,136',        // blue-800 → border
        '15,23,42': '13,33,55'          // slate-900 → bg
    };
    return function (css) {
        for (var k in hex) css = css.split(k).join(hex[k]);
        for (var r in rgb) css = css.split(r).join(rgb[r]);
        return css;
    };
})();

// ============================================================
// PART 1: KPI DASHBOARD
// Meta-level metrics with AI interpretation
// ============================================================
(function () {
    // strict mode inherited from top-level

    const KPI_STYLES = `
        .wg-kpi-dashboard{background:linear-gradient(135deg,#0a1628 0%,#0d1f3c 100%);border:1px solid rgba(59,130,246,0.3);border-radius:12px;padding:20px 24px;margin:16px 0 24px;box-shadow:0 4px 24px rgba(0,0,0,0.3)}
        .wg-kpi-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid rgba(59,130,246,0.2)}
        .wg-kpi-title{font-size:14px;font-weight:600;color:#e2e8f0;text-transform:uppercase;letter-spacing:0.5px;display:flex;align-items:center;gap:8px}
        .wg-kpi-title svg{color:#3b82f6}
        .wg-kpi-timestamp{font-size:11px;color:#64748b}
        .wg-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px}
        .wg-kpi-card{background:rgba(15,23,42,0.6);border:1px solid rgba(59,130,246,0.15);border-radius:8px;padding:14px;transition:all .2s}
        .wg-kpi-card:hover{border-color:rgba(59,130,246,0.4);background:rgba(15,23,42,0.8)}
        .wg-kpi-card.critical{border-left:3px solid #ef4444}
        .wg-kpi-card.warning{border-left:3px solid #eab308}
        .wg-kpi-card.healthy{border-left:3px solid #22c55e}
        .wg-kpi-card.info{border-left:3px solid #3b82f6}
        .wg-kpi-label{font-size:10px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.3px;margin-bottom:4px}
        .wg-kpi-value{font-size:22px;font-weight:700;color:#e2e8f0;line-height:1.2}
        .wg-kpi-value.critical{color:#ef4444}
        .wg-kpi-value.warning{color:#eab308}
        .wg-kpi-value.healthy{color:#22c55e}
        .wg-kpi-sub{font-size:11px;color:#64748b;margin-top:2px}
        .wg-kpi-bar{height:4px;background:rgba(15,23,42,0.8);border-radius:2px;margin-top:8px;overflow:hidden}
        .wg-kpi-bar-fill{height:100%;border-radius:2px;transition:width .5s}
        .wg-kpi-bar-fill.healthy{background:linear-gradient(90deg,#22c55e,#16a34a)}
        .wg-kpi-bar-fill.warning{background:linear-gradient(90deg,#eab308,#ca8a04)}
        .wg-kpi-bar-fill.critical{background:linear-gradient(90deg,#ef4444,#dc2626)}
        .wg-kpi-bar-fill.info{background:linear-gradient(90deg,#3b82f6,#2563eb)}
        .wg-kpi-ai-section{background:rgba(37,99,235,0.08);border:1px solid rgba(59,130,246,0.25);border-radius:8px;padding:16px}
        .wg-kpi-ai-header{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;font-weight:600;color:#60a5fa}
        .wg-kpi-ai-content{font-size:13px;color:#cbd5e1;line-height:1.6}
        .wg-kpi-ai-content strong{color:#e2e8f0}
        .wg-kpi-ai-content .highlight-critical{color:#f87171;font-weight:500}
        .wg-kpi-ai-content .highlight-warning{color:#fbbf24;font-weight:500}
        .wg-kpi-ai-content .highlight-good{color:#4ade80;font-weight:500}
        .wg-kpi-loading{display:flex;align-items:center;gap:8px;color:#64748b;font-size:12px}
        .wg-kpi-loading .spinner{width:16px;height:16px;border:2px solid rgba(59,130,246,0.2);border-top-color:#3b82f6;border-radius:50%;animation:cybSpin 1s linear infinite}
        /* @keyframes wg-spin removed — uses cybSpin from Common */
        .wg-kpi-alert{display:flex;align-items:flex-start;gap:10px;padding:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:6px;margin-bottom:12px}
        .wg-kpi-alert.warning{background:rgba(234,179,8,0.1);border-color:rgba(234,179,8,0.3)}
        .wg-kpi-alert-icon{flex-shrink:0;font-size:16px}
        .wg-kpi-alert-text{font-size:12px;color:#e2e8f0}
        .insight-critical{color:var(--cyb-danger,#ff5555);font-size:12px}
        .insight-trajectory{color:var(--cyb-info,#8be9fd);font-size:12px}
        .insight-risk{color:var(--cyb-warning,#ffb86c);font-size:12px}
        .insight-action{color:var(--cyb-success,#50fa7b);font-size:12px;font-style:italic}
        .wg-insight-card{display:flex;flex-direction:column;gap:8px}
    `;

    function calculateWorkGroupKPIs(groups, nodes, links) {
        const kpis = {
            totalGroups: groups.length, totalActivities: 0, avgActivitiesPerGroup: 0,
            healthyGroups: 0, warningGroups: 0, criticalGroups: 0, avgHealthScore: 0,
            onScheduleGroups: 0, delayedGroups: 0, criticalPathGroups: 0,
            zeroFloatActivities: 0, negativeFloatActivities: 0, avgFloat: 0,
            avgProgress: 0, completedGroups: 0, notStartedGroups: 0,
            highRiskGroups: 0, criticalActivities: 0,
            scheduleHealthIndex: 0, executionReadinessIndex: 0, criticalPathExposure: 0
        };
        if (!groups.length) return kpis;

        let totalHealth = 0, totalProgress = 0, totalFloat = 0, floatCount = 0;

        groups.forEach(g => {
            const groupNodes = g.nodes || [];
            kpis.totalActivities += groupNodes.length;

            const health = g.healthScore || 50;
            totalHealth += health;
            if (health >= 90) kpis.healthyGroups++;
            else if (health >= 70) kpis.warningGroups++;
            else kpis.criticalGroups++;

            if (g.hasDelayed) kpis.delayedGroups++; else kpis.onScheduleGroups++;
            if (g.hasCriticalPath) kpis.criticalPathGroups++;

            const progress = parseFloat(g.progress) || 0;
            totalProgress += progress;
            if (progress >= 100) kpis.completedGroups++;
            else if (progress === 0) kpis.notStartedGroups++;

            groupNodes.forEach(n => {
                const slack = parseFloat(n.TotalSlack);
                if (!isNaN(slack)) { totalFloat += slack; floatCount++; if (slack === 0) kpis.zeroFloatActivities++; else if (slack < 0) kpis.negativeFloatActivities++; }
                if (n.IsCritical || n.TotalSlack === 0) kpis.criticalActivities++;
            });

            const avgGroupRisk = groupNodes.reduce((s, n) => s + (parseFloat(n.RiskScore) || 0), 0) / (groupNodes.length || 1);
            if (avgGroupRisk > 0.6) kpis.highRiskGroups++;
        });

        kpis.avgActivitiesPerGroup = Math.round(kpis.totalActivities / groups.length);
        kpis.avgHealthScore = Math.round(totalHealth / groups.length);
        kpis.avgProgress = Math.round(totalProgress / groups.length);
        kpis.avgFloat = floatCount > 0 ? Math.round(totalFloat / floatCount * 10) / 10 : 0;
        kpis.criticalPathExposure = Math.round((kpis.criticalPathGroups / groups.length) * 100);
        kpis.scheduleHealthIndex = Math.round((kpis.onScheduleGroups / groups.length) * 100);
        kpis.executionReadinessIndex = Math.round(((kpis.avgProgress / 100) * 0.3 + (kpis.healthyGroups / groups.length) * 0.4 + ((groups.length - kpis.delayedGroups) / groups.length) * 0.3) * 100);

        return kpis;
    }

    async function generateKPIInterpretation(kpis, projectMeta) {
        // Deterministic interpretation to prevent contradictory or low-signal AI phrasing.
        // We still keep async signature to avoid changing call sites.
        return generateFallback(kpis);
    }

    function generateFallback(kpis) {
        const parts = [];
        const noActivityBreakdown = kpis.totalActivities === 0;
        const needsExecutionKickoff = kpis.avgProgress <= 5 || kpis.notStartedGroups === kpis.totalGroups;

        if (noActivityBreakdown) {
            parts.push(`Schedule status: <span class="highlight-warning">package-level status is not verifiable</span> because no activities are defined.`);
        } else if (kpis.scheduleHealthIndex >= 90) {
            parts.push(`Schedule status: <span class="highlight-good">${kpis.scheduleHealthIndex}% on-track</span> (${kpis.onScheduleGroups}/${kpis.totalGroups} packages), with ${kpis.delayedGroups} delayed.`);
        } else if (kpis.scheduleHealthIndex >= 70) {
            parts.push(`Schedule status: mixed performance with <span class="highlight-warning">${kpis.delayedGroups} delayed packages</span> and ${kpis.scheduleHealthIndex}% on-track.`);
        } else {
            parts.push(`Schedule status: <span class="highlight-critical">recovery required</span> — ${kpis.delayedGroups}/${kpis.totalGroups} packages delayed.`);
        }

        const concernFlags = [];
        if (kpis.criticalGroups > 0) concernFlags.push(`${kpis.criticalGroups} critical package${kpis.criticalGroups === 1 ? '' : 's'} (health < 70%)`);
        if (kpis.negativeFloatActivities > 0) concernFlags.push(`${kpis.negativeFloatActivities} negative-float activit${kpis.negativeFloatActivities === 1 ? 'y' : 'ies'}`);
        if (kpis.criticalPathExposure > 40) concernFlags.push(`${kpis.criticalPathExposure}% critical-path exposure`);
        if (needsExecutionKickoff) concernFlags.push(`execution maturity is low (${kpis.avgProgress}% average progress)`);

        if (concernFlags.length > 0) {
            parts.push(`Critical concerns: <span class="highlight-warning">${concernFlags.join('; ')}</span>.`);
        } else {
            parts.push(`Critical concerns: no immediate structural breaches detected; continue active monitoring.`);
        }

        if (noActivityBreakdown) {
            parts.push(`Priority actions: define activities and baseline logic within 7 days, then resource and start top-priority packages in the next 14 days.`);
        } else if (needsExecutionKickoff) {
            parts.push(`Priority actions: launch execution on highest-risk packages first, raise average progress above 10% in 2 weeks, and revalidate float/critical path after the first update cycle.`);
        } else {
            parts.push(`Priority actions: focus controls on delayed and critical packages, protect zero-float paths, and reforecast completion dates in the next reporting cycle.`);
        }

        return parts.join(' ');
    }

    function renderKPIDashboard(containerId, kpis, aiText, loading = false) {
        const container = document.getElementById(containerId);
        if (!container) return;

        let existing = container.querySelector('.wg-kpi-dashboard');
        if (existing) existing.remove();

        const hc = kpis.avgHealthScore >= 90 ? 'healthy' : kpis.avgHealthScore >= 70 ? 'warning' : 'critical';
        const sc = kpis.scheduleHealthIndex >= 90 ? 'healthy' : kpis.scheduleHealthIndex >= 70 ? 'warning' : 'critical';

        let alerts = '';
        if (kpis.criticalGroups > 0) alerts += `<div class="wg-kpi-alert"><span class="wg-kpi-alert-icon">🚨</span><span class="wg-kpi-alert-text"><strong>${kpis.criticalGroups} Critical Packages</strong> — health below 70%, immediate action required</span></div>`;
        if (kpis.negativeFloatActivities > 0) alerts += `<div class="wg-kpi-alert warning"><span class="wg-kpi-alert-icon">⚠️</span><span class="wg-kpi-alert-text"><strong>${kpis.negativeFloatActivities} Negative Float Activities</strong> — schedule compression needed</span></div>`;

        const dash = document.createElement('div');
        dash.className = 'wg-kpi-dashboard';
        dash.innerHTML = `
            <div class="wg-kpi-header">
                <div class="wg-kpi-title"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>Work Package Performance</div>
                <div class="wg-kpi-timestamp">${new Date().toLocaleTimeString()}</div>
            </div>
            ${alerts}
            ${(function () {
                var UI = window.CybereumUI;
                if (UI && UI.html && UI.html.cardGrid) {
                    var ri = kpis.executionReadinessIndex;
                    var riStatus = ri >= 70 ? 'healthy' : ri >= 50 ? 'warning' : 'critical';
                    return UI.html.cardGrid([
                        { status: 'info', label: 'Work Packages', value: kpis.totalGroups, sub: kpis.totalActivities + ' activities (' + kpis.avgActivitiesPerGroup + ' avg)' },
                        { status: sc, label: 'Schedule Health', value: kpis.scheduleHealthIndex + '%', sub: kpis.onScheduleGroups + ' on-track · ' + kpis.delayedGroups + ' delayed', bar: kpis.scheduleHealthIndex, valueClass: sc !== 'info' ? 'cyb-text-' + sc : '' },
                        { status: hc, label: 'Health Score', value: kpis.avgHealthScore + '%', sub: '🟢' + kpis.healthyGroups + ' 🟡' + kpis.warningGroups + ' 🔴' + kpis.criticalGroups, bar: kpis.avgHealthScore, valueClass: hc !== 'info' ? 'cyb-text-' + hc : '' },
                        { status: kpis.criticalPathExposure > 50 ? 'warning' : 'info', label: 'Critical Path', value: kpis.criticalPathExposure + '%', sub: kpis.criticalPathGroups + ' packages · ' + kpis.criticalActivities + ' activities' },
                        { status: 'info', label: 'Progress', value: kpis.avgProgress + '%', sub: kpis.completedGroups + ' done · ' + kpis.notStartedGroups + ' pending', bar: kpis.avgProgress },
                        { status: 'info', label: 'Float Status', value: kpis.avgFloat + 'd', sub: kpis.zeroFloatActivities + ' zero · ' + kpis.negativeFloatActivities + ' negative' },
                        { status: kpis.highRiskGroups > 0 ? 'warning' : 'healthy', label: 'High Risk', value: kpis.highRiskGroups, sub: 'packages flagged' },
                        { status: riStatus, label: 'Readiness Index', value: ri + '%', sub: 'composite score', bar: ri }
                    ]);
                }
                // Fallback: original handcrafted cards if Common not loaded
                return '<div class="wg-kpi-grid">' +
                    '<div class="wg-kpi-card info"><div class="wg-kpi-label">Work Packages</div><div class="wg-kpi-value">' + kpis.totalGroups + '</div><div class="wg-kpi-sub">' + kpis.totalActivities + ' activities (' + kpis.avgActivitiesPerGroup + ' avg)</div></div>' +
                    '<div class="wg-kpi-card ' + sc + '"><div class="wg-kpi-label">Schedule Health</div><div class="wg-kpi-value ' + sc + '">' + kpis.scheduleHealthIndex + '%</div><div class="wg-kpi-sub">' + kpis.onScheduleGroups + ' on-track · ' + kpis.delayedGroups + ' delayed</div><div class="wg-kpi-bar"><div class="wg-kpi-bar-fill ' + sc + '" style="width:' + kpis.scheduleHealthIndex + '%"></div></div></div>' +
                    '<div class="wg-kpi-card ' + hc + '"><div class="wg-kpi-label">Health Score</div><div class="wg-kpi-value ' + hc + '">' + kpis.avgHealthScore + '%</div><div class="wg-kpi-sub">🟢' + kpis.healthyGroups + ' 🟡' + kpis.warningGroups + ' 🔴' + kpis.criticalGroups + '</div><div class="wg-kpi-bar"><div class="wg-kpi-bar-fill ' + hc + '" style="width:' + kpis.avgHealthScore + '%"></div></div></div>' +
                    '<div class="wg-kpi-card ' + (kpis.criticalPathExposure > 50 ? 'warning' : 'info') + '"><div class="wg-kpi-label">Critical Path</div><div class="wg-kpi-value">' + kpis.criticalPathExposure + '%</div><div class="wg-kpi-sub">' + kpis.criticalPathGroups + ' packages · ' + kpis.criticalActivities + ' activities</div></div>' +
                    '<div class="wg-kpi-card info"><div class="wg-kpi-label">Progress</div><div class="wg-kpi-value">' + kpis.avgProgress + '%</div><div class="wg-kpi-sub">' + kpis.completedGroups + ' done · ' + kpis.notStartedGroups + ' pending</div><div class="wg-kpi-bar"><div class="wg-kpi-bar-fill info" style="width:' + kpis.avgProgress + '%"></div></div></div>' +
                    '<div class="wg-kpi-card info"><div class="wg-kpi-label">Float Status</div><div class="wg-kpi-value">' + kpis.avgFloat + 'd</div><div class="wg-kpi-sub">' + kpis.zeroFloatActivities + ' zero · ' + kpis.negativeFloatActivities + ' negative</div></div>' +
                    '<div class="wg-kpi-card ' + (kpis.highRiskGroups > 0 ? 'warning' : 'healthy') + '"><div class="wg-kpi-label">High Risk</div><div class="wg-kpi-value">' + kpis.highRiskGroups + '</div><div class="wg-kpi-sub">packages flagged</div></div>' +
                    '<div class="wg-kpi-card ' + (kpis.executionReadinessIndex >= 70 ? 'healthy' : kpis.executionReadinessIndex >= 50 ? 'warning' : 'critical') + '"><div class="wg-kpi-label">Readiness Index</div><div class="wg-kpi-value">' + kpis.executionReadinessIndex + '%</div><div class="wg-kpi-sub">composite score</div><div class="wg-kpi-bar"><div class="wg-kpi-bar-fill ' + (kpis.executionReadinessIndex >= 70 ? 'healthy' : kpis.executionReadinessIndex >= 50 ? 'warning' : 'critical') + '" style="width:' + kpis.executionReadinessIndex + '%"></div></div></div>' +
                    '</div>';
            })()}
            <div class="wg-kpi-ai-section">
                <div class="wg-kpi-ai-header"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>Project Controls Analysis</div>
                <div class="wg-kpi-ai-content" id="wg-kpi-ai-text">${loading ? (window.CybereumUI && window.CybereumUI.html ? window.CybereumUI.html.loader('Analyzing project controls...') : '<div class="wg-kpi-loading"><div class="spinner"></div>Analyzing...</div>') : aiText}</div>
            </div>`;
        container.insertBefore(dash, container.firstChild);
    }

    async function initKPI(groups, nodes, links, containerId = 'community-container') {
        if (!document.getElementById('wg-kpi-styles')) {
            const s = document.createElement('style'); s.id = 'wg-kpi-styles'; s.textContent = _cybResolveTailwind(KPI_STYLES); document.head.appendChild(s);
        }
        const kpis = calculateWorkGroupKPIs(groups, nodes, links);
        renderKPIDashboard(containerId, kpis, '', true);
        const meta = window.cybereumState ? (typeof buildMetaFromState === 'function' ? buildMetaFromState(window.cybereumState, nodes) : {}) : {};
        const ai = await generateKPIInterpretation(kpis, meta);
        const el = document.getElementById('wg-kpi-ai-text');
        if (el) el.innerHTML = ai;
        return kpis;
    }

    window.WorkGroupKPI = { init: initKPI, calculate: calculateWorkGroupKPIs, update: (g, n, l, c) => { const k = calculateWorkGroupKPIs(g, n, l); renderKPIDashboard(c || 'community-container', k, generateFallback(k)); return k; } };
})();


// ============================================================
// PART 2: NAVIGATION SIDEBAR
// Collapsible navigation with search and filters
// ============================================================
(function () {
    // strict mode inherited from top-level

    const ENABLE_LEGACY_FIXED_WORKGROUP_NAV = false;

    const NAV_CONFIG = { sidebarWidth: 260, collapsedWidth: 44, scrollOffset: 100, debounceDelay: 150, healthThresholds: { critical: 70, warning: 90 }, storageKey: 'cybereum_wgnav' };
    let navState = { isCollapsed: false, activeGroupId: null, groups: [], filteredGroups: [], searchTerm: '', activeFilter: 'all' };

    const NAV_STYLES = `
        .wg-nav-sidebar{position:fixed;left:0;top:120px;bottom:0;width:${NAV_CONFIG.sidebarWidth}px;background:linear-gradient(180deg,#0a1628,#0d1f3c);border-right:1px solid rgba(59,130,246,0.3);z-index:1000;display:flex;flex-direction:column;transition:transform .3s,width .3s;box-shadow:4px 0 20px rgba(0,0,0,0.4);font-family:Inter,Roboto,'Segoe UI',system-ui,sans-serif}
        .wg-nav-sidebar.collapsed{width:${NAV_CONFIG.collapsedWidth}px}
        .wg-nav-sidebar.hidden{transform:translateX(-100%)}
        .wg-nav-toggle{position:absolute;right:-28px;top:50%;transform:translateY(-50%);width:28px;height:56px;background:linear-gradient(135deg,#1e3a5f,#0d1f3c);border:1px solid rgba(59,130,246,0.4);border-left:none;border-radius:0 6px 6px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#60a5fa;transition:all .2s}
        .wg-nav-toggle:hover{background:linear-gradient(135deg,#2563eb,#1e3a5f);color:#fff}
        .wg-nav-toggle svg{transition:transform .3s}
        .wg-nav-sidebar.collapsed .wg-nav-toggle svg{transform:rotate(180deg)}
        .wg-nav-header{padding:12px;border-bottom:1px solid rgba(59,130,246,0.2);background:rgba(30,58,95,0.3)}
        .wg-nav-header h3{margin:0 0 10px;color:#e2e8f0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:6px}
        .wg-nav-sidebar.collapsed .wg-nav-header h3 span,.wg-nav-sidebar.collapsed .wg-nav-search,.wg-nav-sidebar.collapsed .wg-nav-filters,.wg-nav-sidebar.collapsed .wg-nav-stats{display:none}
        .wg-nav-search{position:relative;margin-bottom:10px}
        .wg-nav-search input{width:100%;padding:8px 10px 8px 32px;background:rgba(15,23,42,0.8);border:1px solid rgba(59,130,246,0.3);border-radius:5px;color:#e2e8f0;font-size:12px;outline:none;box-sizing:border-box}
        .wg-nav-search input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,0.15)}
        .wg-nav-search input::placeholder{color:#64748b}
        .wg-nav-search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#64748b}
        .wg-nav-search-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:#64748b;cursor:pointer;padding:2px;display:none;font-size:11px}
        .wg-nav-search-clear.visible{display:block}
        .wg-nav-filters{display:flex;gap:4px;flex-wrap:wrap}
        .wg-nav-filter-btn{padding:4px 8px;font-size:10px;background:rgba(15,23,42,0.6);border:1px solid rgba(59,130,246,0.2);border-radius:3px;color:#94a3b8;cursor:pointer;transition:all .2s}
        .wg-nav-filter-btn:hover{background:rgba(59,130,246,0.2);color:#e2e8f0}
        .wg-nav-filter-btn.active{background:linear-gradient(135deg,#2563eb,#1d4ed8);border-color:#3b82f6;color:#fff}
        .wg-nav-stats{display:flex;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(59,130,246,0.15);font-size:10px;color:#94a3b8}
        .wg-nav-stat{display:flex;align-items:center;gap:3px}
        .wg-nav-stat-dot{width:7px;height:7px;border-radius:50%}
        .wg-nav-stat-dot.healthy{background:#22c55e}.wg-nav-stat-dot.warning{background:#eab308}.wg-nav-stat-dot.critical{background:#ef4444}
        .wg-nav-list{flex:1;overflow-y:auto;padding:6px}
        .wg-nav-list::-webkit-scrollbar{width:5px}
        .wg-nav-list::-webkit-scrollbar-thumb{background:rgba(59,130,246,0.4);border-radius:3px}
        .wg-nav-item{padding:8px 10px;margin-bottom:3px;background:rgba(15,23,42,0.4);border:1px solid transparent;border-radius:5px;cursor:pointer;transition:all .2s}
        .wg-nav-item:hover{background:rgba(59,130,246,0.15);border-color:rgba(59,130,246,0.3)}
        .wg-nav-item.active{background:linear-gradient(135deg,rgba(37,99,235,0.3),rgba(30,64,175,0.2));border-color:#3b82f6}
        .wg-nav-item-header{display:flex;align-items:center;gap:6px;margin-bottom:4px}
        .wg-nav-item-status{width:8px;height:8px;border-radius:50%;flex-shrink:0}
        .wg-nav-item-status.healthy{background:#22c55e}.wg-nav-item-status.warning{background:#eab308}.wg-nav-item-status.critical{background:#ef4444}
        .wg-nav-item-name{flex:1;font-size:12px;font-weight:500;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .wg-nav-item-badge{font-size:9px;padding:1px 5px;background:rgba(59,130,246,0.2);border-radius:8px;color:#93c5fd}
        .wg-nav-item-icons{display:flex;gap:3px;font-size:10px}
        .wg-nav-item-progress{height:3px;background:rgba(15,23,42,0.6);border-radius:2px;overflow:hidden}
        .wg-nav-item-progress-bar{height:100%;border-radius:2px}
        .wg-nav-item-progress-bar.healthy{background:#22c55e}.wg-nav-item-progress-bar.warning{background:#eab308}.wg-nav-item-progress-bar.critical{background:#ef4444}
        .wg-nav-sidebar.collapsed .wg-nav-item{padding:6px;justify-content:center}
        .wg-nav-sidebar.collapsed .wg-nav-item-header,.wg-nav-sidebar.collapsed .wg-nav-item-progress{display:none}
        .wg-nav-sidebar.collapsed .wg-nav-item-status{width:20px;height:20px}
        .wg-nav-back-top{position:fixed;bottom:20px;left:20px;width:40px;height:40px;background:linear-gradient(135deg,#2563eb,#1d4ed8);border:1px solid rgba(59,130,246,0.5);border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;opacity:0;visibility:hidden;transition:all .3s;z-index:999}
        .wg-nav-back-top.visible{opacity:1;visibility:visible}
        .wg-nav-sidebar.collapsed~.wg-nav-back-top{left:56px}
        .wg-nav-breadcrumb{position:fixed;top:125px;left:${NAV_CONFIG.sidebarWidth + 16}px;background:rgba(10,22,40,0.95);padding:6px 12px;border-radius:5px;border:1px solid rgba(59,130,246,0.3);font-size:11px;color:#94a3b8;z-index:999;opacity:0;visibility:hidden;transition:all .3s}
        .wg-nav-breadcrumb.visible{opacity:1;visibility:visible}
        .wg-nav-sidebar.collapsed~.wg-nav-breadcrumb{left:${NAV_CONFIG.collapsedWidth + 16}px}
        .wg-nav-breadcrumb-label{color:#60a5fa;font-weight:500}
        .wg-nav-no-results{padding:20px 12px;text-align:center;color:#64748b;font-size:12px}
        #navpills-7.nav-shifted{margin-left:${NAV_CONFIG.sidebarWidth}px;transition:margin-left .3s}
        #navpills-7.nav-shifted-collapsed{margin-left:${NAV_CONFIG.collapsedWidth}px}
        .wg-nav-hint{position:absolute;bottom:8px;left:8px;right:8px;padding:6px;background:rgba(15,23,42,0.6);border-radius:3px;font-size:9px;color:#64748b;text-align:center}
        .wg-nav-sidebar.collapsed .wg-nav-hint{display:none}
        @media(max-width:1024px){.wg-nav-sidebar{transform:translateX(-100%)}.wg-nav-sidebar.mobile-open{transform:translateX(0)}#navpills-7.nav-shifted,#navpills-7.nav-shifted-collapsed{margin-left:0}}`;

    const debounce = (fn, w) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), w); }; };
    const getStatus = s => s < NAV_CONFIG.healthThresholds.critical ? 'critical' : s < NAV_CONFIG.healthThresholds.warning ? 'warning' : 'healthy';
    const escHtml = t => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    const saveState = () => { try { localStorage.setItem(NAV_CONFIG.storageKey, JSON.stringify({ isCollapsed: navState.isCollapsed })); } catch (e) { } };
    const loadState = () => { try { const s = localStorage.getItem(NAV_CONFIG.storageKey); if (s) navState.isCollapsed = JSON.parse(s).isCollapsed || false; } catch (e) { } };

    function createNav() {
        if (document.getElementById('wg-nav-sidebar')) return;
        const style = document.createElement('style'); style.id = 'wg-nav-styles'; style.textContent = _cybResolveTailwind(NAV_STYLES); document.head.appendChild(style);

        const sidebar = document.createElement('div');
        sidebar.id = 'wg-nav-sidebar';
        sidebar.className = 'wg-nav-sidebar' + (navState.isCollapsed ? ' collapsed' : '');
        sidebar.innerHTML = `<button class="wg-nav-toggle" title="Ctrl+B"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg></button>
            <div class="wg-nav-header"><h3><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg><span>Work Groups</span></h3>
                <div class="wg-nav-search"><svg class="wg-nav-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg><input type="text" placeholder="Search..." id="wg-nav-search-input" name="wg-nav-search"><button class="wg-nav-search-clear" id="wg-nav-search-clear">✕</button></div>
                <div class="wg-nav-filters"><button class="wg-nav-filter-btn active" data-filter="all">All</button><button class="wg-nav-filter-btn" data-filter="critical">⚠️ Critical</button><button class="wg-nav-filter-btn" data-filter="delayed">🔴 Delayed</button></div>
                <div class="wg-nav-stats"><div class="wg-nav-stat"><span class="wg-nav-stat-dot healthy"></span><span id="wg-stat-healthy">0</span></div><div class="wg-nav-stat"><span class="wg-nav-stat-dot warning"></span><span id="wg-stat-warning">0</span></div><div class="wg-nav-stat"><span class="wg-nav-stat-dot critical"></span><span id="wg-stat-critical">0</span></div></div></div>
            <div class="wg-nav-list" id="wg-nav-list"></div><div class="wg-nav-hint">Ctrl+B toggle</div>`;

        const bc = document.createElement('div'); bc.id = 'wg-nav-breadcrumb'; bc.className = 'wg-nav-breadcrumb'; bc.innerHTML = '<span class="wg-nav-breadcrumb-label"></span>';
        const bt = document.createElement('button'); bt.id = 'wg-nav-back-top'; bt.className = 'wg-nav-back-top'; bt.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>';

        document.body.appendChild(sidebar); document.body.appendChild(bc); document.body.appendChild(bt);
        setupEvents();
    }

    function applyFilters() {
        let f = [...navState.groups];
        if (navState.searchTerm) { const t = navState.searchTerm.toLowerCase(); f = f.filter(g => g.name.toLowerCase().includes(t)); }
        if (navState.activeFilter === 'critical') f = f.filter(g => g.hasCriticalPath);
        else if (navState.activeFilter === 'delayed') f = f.filter(g => g.hasDelayed);
        f.sort((a, b) => (a.wbsLevel && b.wbsLevel) ? a.wbsLevel.localeCompare(b.wbsLevel, undefined, { numeric: true }) : a.name.localeCompare(b.name));
        navState.filteredGroups = f;
    }

    function renderList() {
        const el = document.getElementById('wg-nav-list'); if (!el) return;
        if (!navState.filteredGroups.length) { el.innerHTML = '<div class="wg-nav-no-results">No groups found</div>'; return; }
        var UI = window.CybereumUI;
        el.innerHTML = navState.filteredGroups.map(g => {
            const st = getStatus(g.healthScore);
            var phaseHtml = '';
            if (g.phase && UI && UI.html && UI.html.phase) {
                phaseHtml = '<div style="margin-top:2px">' + UI.html.phase(g.phase, { compact: true }) + '</div>';
            } else if (g.phase) {
                phaseHtml = '<div style="margin-top:2px;font-size:8px;color:var(--cyb-text3,#5a8ab5);text-transform:uppercase;letter-spacing:0.4px">' + (g.phase || '') + '</div>';
            }
            return `<div class="wg-nav-item${navState.activeGroupId === g.id ? ' active' : ''}" data-group-id="${g.id}" data-container="${g.containerType}"><div class="wg-nav-item-header"><span class="wg-nav-item-status ${st}"></span><span class="wg-nav-item-name">${escHtml(g.name)}</span><span class="wg-nav-item-badge">${g.activityCount}</span><div class="wg-nav-item-icons">${g.hasCriticalPath ? '<span style="color:var(--cyb-warning,#f97316)">⚠️</span>' : ''}${g.hasDelayed ? '<span style="color:var(--cyb-danger,#ef4444)">🔴</span>' : ''}</div></div>${phaseHtml}<div class="wg-nav-item-progress"><div class="wg-nav-item-progress-bar ${st}" style="width:${Math.min(100, g.progress)}%"></div></div></div>`;
        }).join('');
    }

    function updateStats() {
        let h = 0, w = 0, c = 0; navState.groups.forEach(g => { const s = getStatus(g.healthScore); if (s === 'healthy') h++; else if (s === 'warning') w++; else c++; });
        const he = document.getElementById('wg-stat-healthy'), we = document.getElementById('wg-stat-warning'), ce = document.getElementById('wg-stat-critical');
        if (he) he.textContent = h; if (we) we.textContent = w; if (ce) ce.textContent = c;
    }

    function scrollToGroup(id, ct) {
        const el = document.getElementById(`group-section-${id}`) || document.querySelector(`#${ct === 'community' ? 'community' : 'dependency'}-container [data-group-id="${id}"]`);
        if (el) { window.scrollTo({ top: el.getBoundingClientRect().top + window.pageYOffset - NAV_CONFIG.scrollOffset, behavior: 'smooth' }); setActive(id); }
    }

    function setActive(id) {
        navState.activeGroupId = id;
        document.querySelectorAll('.wg-nav-item').forEach(i => i.classList.toggle('active', i.dataset.groupId === id));
        const g = navState.groups.find(x => x.id === id), bc = document.getElementById('wg-nav-breadcrumb');
        if (bc && g) { bc.querySelector('.wg-nav-breadcrumb-label').textContent = g.name; bc.classList.add('visible'); }
    }

    const handleScroll = debounce(() => {
        const np7 = document.getElementById('navpills-7'); if (!np7 || np7.style.display === 'none') return;
        const mid = window.innerHeight / 2; let closest = null, dist = Infinity;
        navState.groups.forEach(g => { const el = document.getElementById(`group-section-${g.id}`); if (el) { const r = el.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - mid); if (d < dist) { dist = d; closest = g; } } });
        if (closest && closest.id !== navState.activeGroupId) setActive(closest.id);
        const bt = document.getElementById('wg-nav-back-top'); if (bt) bt.classList.toggle('visible', window.scrollY > 400);
        const bc = document.getElementById('wg-nav-breadcrumb'); if (bc) bc.classList.toggle('visible', window.scrollY > 200 && navState.activeGroupId);
    }, NAV_CONFIG.debounceDelay);

    function setupEvents() {
        const sidebar = document.getElementById('wg-nav-sidebar'), si = document.getElementById('wg-nav-search-input'), sc = document.getElementById('wg-nav-search-clear'), nl = document.getElementById('wg-nav-list'), bt = document.getElementById('wg-nav-back-top'), tg = sidebar?.querySelector('.wg-nav-toggle');

        tg?.addEventListener('click', () => { navState.isCollapsed = !navState.isCollapsed; sidebar.classList.toggle('collapsed', navState.isCollapsed); const np7 = document.getElementById('navpills-7'); if (np7) { np7.classList.remove('nav-shifted', 'nav-shifted-collapsed'); np7.classList.add(navState.isCollapsed ? 'nav-shifted-collapsed' : 'nav-shifted'); } saveState(); });

        const ds = debounce(() => { navState.searchTerm = si.value.trim(); sc?.classList.toggle('visible', navState.searchTerm.length > 0); applyFilters(); renderList(); }, NAV_CONFIG.debounceDelay);
        si?.addEventListener('input', ds);
        sc?.addEventListener('click', () => { si.value = ''; navState.searchTerm = ''; sc.classList.remove('visible'); applyFilters(); renderList(); si.focus(); });

        document.querySelectorAll('.wg-nav-filter-btn').forEach(b => { b.addEventListener('click', () => { document.querySelectorAll('.wg-nav-filter-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); navState.activeFilter = b.dataset.filter; applyFilters(); renderList(); }); });

        nl?.addEventListener('click', e => { const i = e.target.closest('.wg-nav-item'); if (i) scrollToGroup(i.dataset.groupId, i.dataset.container); });
        bt?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
        window.addEventListener('scroll', handleScroll, { passive: true });
        document.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'b') { e.preventDefault(); tg?.click(); } });

        const obs = new MutationObserver(() => { const np7 = document.getElementById('navpills-7'); sidebar?.classList.toggle('hidden', !np7 || np7.style.display === 'none'); });
        const np7 = document.getElementById('navpills-7'); if (np7) { obs.observe(np7, { attributes: true, attributeFilter: ['style'] }); sidebar?.classList.toggle('hidden', np7.style.display === 'none'); }
    }

    function registerGroups(gd, ct) {
        if (!ENABLE_LEGACY_FIXED_WORKGROUP_NAV || !Array.isArray(gd)) return;
        gd.forEach(g => { if (!navState.groups.find(x => x.id === g.groupId && x.containerType === ct)) { navState.groups.push({ id: g.groupId, name: g.groupName || `Group ${g.groupId}`, activityCount: g.nodeCount || 0, healthScore: g.healthScore || 50, progress: g.progress || 0, hasCriticalPath: g.hasCriticalPath || false, hasDelayed: g.hasDelayed || false, containerType: ct, wbsLevel: g.wbsLevel || null, phase: g.phase || null, discipline: g.discipline || null }); } });
        applyFilters(); renderList(); updateStats();
    }

    function init() {
        if (!ENABLE_LEGACY_FIXED_WORKGROUP_NAV || document.getElementById('wg-nav-sidebar')) return;

        loadState();
        createNav();

        applyFilters();
        renderList();
        updateStats();

        const np7 = document.getElementById('navpills-7');
        if (np7) np7.classList.add(navState.isCollapsed ? 'nav-shifted-collapsed' : 'nav-shifted');
    }

    window.WorkGroupNav = {
        init,
        registerGroups,
        scrollToGroup,
        refresh: () => { if (ENABLE_LEGACY_FIXED_WORKGROUP_NAV) { applyFilters(); renderList(); updateStats(); } },
        toggle: () => { if (ENABLE_LEGACY_FIXED_WORKGROUP_NAV) document.querySelector('.wg-nav-toggle')?.click(); }
    };
    if (ENABLE_LEGACY_FIXED_WORKGROUP_NAV) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
    }
})();


// ============================================================
// PART 3: HELPER FUNCTIONS - IMPROVED HEALTH CALCULATION
// ============================================================
// ============================================================================
// CLEANUP BEFORE PROJECT LOAD
// ============================================================================

// ============================================================================
// GLOBAL PROJECT CLEANUP - Call before loading new project
// ============================================================================
function cleanupBeforeProjectLoad() {
    console.log('[Cybereum] Starting project cleanup...');

    // Run all cleanup functions (clears listeners, observers, timers, graphs, tabs)
    const registry = window.cybereumState?.cleanupRegistry;
    if (registry) {
        registry.cleanupAll(); // Also clears ProjectGroupRegistry + MetricsCache
        _log('[Cybereum] Cleanup stats:', registry.getStats());
    }

    // Clear groups state (also clears ProjectGroupRegistry + MetricsCache if not already done)
    if (window.cybereumState?.groups?.clear) {
        window.cybereumState.groups.clear();
    }

    // Reset analytics state safely (no .reset() method exists)
    if (window.cybereumState?.analytics) {
        const a = window.cybereumState.analytics;
        a.groupInsights = { status: 'pending', startTime: null, endTime: null, totalGroups: 0, completedGroups: 0, insights: {}, groupTypeTotals: {}, errors: [] };
        a.groupInsightsByGroupType = {};
        a.systemsAnalysis = { status: 'pending', startTime: null, endTime: null, result: null, error: null };
        a.systemsAnalysisByGroupType = {};
        a.pendingSystemsInsightsByGroupType = {};
        a.systemsInsightsRenderRetries = {};
        a.synthesis = { status: 'pending', startTime: null, endTime: null, result: null, error: null };
    }

    delete window._latestCBSEstimates;
    delete window._costEstimationWorkGroupData;

    // Clean up Nexus build timer
    if (window._nexusBuildTimer) {
        clearTimeout(window._nexusBuildTimer);
        delete window._nexusBuildTimer;
    }

    // Clean up CommissioningNexus (if enabled and loaded)
    if (window.CommissioningNexus?.cleanup) {
        try {
            window.CommissioningNexus.cleanup();
        } catch (e) {
            console.warn('[Cybereum] CommissioningNexus cleanup error:', e);
        }
    }

    console.log('[Cybereum] Project cleanup complete');
}

// Export cleanup function
window.cleanupBeforeProjectLoad = cleanupBeforeProjectLoad;

// ============================================================================
// v2.0 EXPORTS - ProjectGroup, MetricsCache, CybereumDesign
// ============================================================================
_log('[Cybereum] CommunityGroups v2.0 loaded with enhancements:');
_log('  - CybereumDesign: window.CybereumDesign');
_log('  - MetricsCache: window.MetricsCache');
_log('  - ProjectGroup: window.ProjectGroup');
_log('  - ProjectGroupRegistry: window.ProjectGroupRegistry');

// ============================================================================
// DEFENSIVE STATE CHECKS FOR GROUP OPERATIONS
// ============================================================================

/**
 * Safe wrapper for getting group metrics with fallback
 */
window.safeGetGroupMetrics = function (groupType, groupId) {
    try {
        var groups = window.cybereumState && window.cybereumState.groups && window.cybereumState.groups[groupType];
        if (!groups) return null;

        var groupData = groups[groupId];
        if (!groupData) return null;

        // Try to get cached metrics
        if (window.MetricsCache && groupData.nodes) {
            return window.MetricsCache.get(groupData.nodes, function (nodes) {
                if (window.ProjectGroupManager) {
                    var manager = new ProjectGroupManager();
                    return manager.calculateGroupMetrics(nodes);
                }
                return null;
            });
        }

        return groupData.metrics || null;
    } catch (e) {
        console.warn('[Cybereum] Error getting group metrics:', e);
        return null;
    }
};

/**
 * Safe wrapper for checking if a group is commissioning-related
 */
window.isCommissioningGroup = function (groupData) {
    if (!groupData) return false;

    // Check phase tags
    var phase = (groupData.detectedTags && groupData.detectedTags.phase) ||
        (groupData.tags && groupData.tags.phase);
    if (phase === 'Commissioning' || phase === 'Pre-Commissioning') {
        return true;
    }

    // Check name patterns
    var name = (groupData.name || groupData.GroupName || '').toLowerCase();
    return /commissioning|pre-?comm|startup|handover|cx\b/i.test(name);
};

_log('[Cybereum] CommunityGroups defensive utilities loaded');


// ============================================================================
// COMMISSIONING NEXUS BRIDGE — Simple & Dependable
//
// GATED: Only activates when window.cybereumState.enableCommissioningNexus = true
//
// How it works:
//   1. drawCommunityGroupGraph() stores groups → triggers buildFromGroups() (above)
//   2. User clicks Nexus tab → openPage('navpills-15') → renderCommissioningNexus()
//   That's it. No hooks, no observers, no polling.
// ============================================================================

window.renderCommissioningNexus = function () {
    // Feature flag gate
    if (!window.cybereumState?.enableCommissioningNexus) {
        var container = document.getElementById('nexus-commissioning-container');
        if (container && !container.hasChildNodes()) {
            container.innerHTML =
                '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;' +
                'min-height:400px;text-align:center;padding:40px;color:#8ab4c4;">' +
                '<div style="font-size:48px;margin-bottom:20px;">\u{1F6A7}</div>' +
                '<h2 style="font-family:\'Orbitron\',sans-serif;color:#5ac8fa;margin-bottom:10px;">' +
                'Commissioning Nexus</h2>' +
                '<p>Feature not enabled for this project.</p>' +
                '<p style="font-size:12px;opacity:0.6;">Set cybereumState.enableCommissioningNexus = true to activate.</p>' +
                '</div>';
        }
        return;
    }

    var container = document.getElementById('nexus-commissioning-container');
    if (!container) return;

    // Already built and rendered?
    if (window.CommissioningNexus?.initialized && container.hasChildNodes()) {
        return;
    }

    // Built but not rendered yet (tab was hidden during build)?
    if (window.CommissioningNexus?.initialized) {
        requestAnimationFrame(function () {
            window.CommissioningNexus.render('nexus-commissioning-container');
        });
        return;
    }

    // Not built yet — try building from state
    var groups = window.cybereumState?.groups;
    var wbs = Object.keys(groups?.WBS_ID || {}).length;
    var comm = Object.keys(groups?.CommunityGroup || {}).length;

    if (window.CommissioningNexus?.buildFromGroups && (wbs > 0 || comm > 0)) {
        try {
            window.CommissioningNexus.buildFromGroups(null);
        } catch (e) {
            console.warn('[CommissioningNexus] build error on tab open:', e);
        }
        return;
    }

    // No groups yet — show waiting state
    if (!container.hasChildNodes()) {
        container.innerHTML =
            '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;' +
            'min-height:400px;text-align:center;padding:40px;color:#8ab4c4;">' +
            '<div style="font-size:48px;margin-bottom:20px;">\u2699\uFE0F</div>' +
            '<h2 style="font-family:\'Orbitron\',sans-serif;color:#5ac8fa;margin-bottom:10px;">' +
            'Commissioning Nexus</h2>' +
            '<p>Waiting for schedule data...</p>' +
            '<p style="font-size:12px;opacity:0.6;">Load a schedule first, then return to this tab.</p>' +
            '</div>';
    }
};

// Hook openPage so clicking the Nexus tab calls renderCommissioningNexus
// The hook is always installed (lightweight), but renderCommissioningNexus
// itself checks the feature flag, so nothing executes unless enabled.
(function () {
    var _hooked = false;

    function hookOpenPage() {
        if (_hooked) return true;
        var orig = window.openPage;
        if (typeof orig !== 'function') return false;

        _hooked = true;
        window.openPage = function (pageName) {
            orig.call(this, pageName);
            if (pageName === 'navpills-15') {
                requestAnimationFrame(function () { window.renderCommissioningNexus(); });
            }
        };
        console.log('[CommissioningBridge] openPage hooked for Nexus tab');
        return true;
    }

    // Try now, then on load events, then brief poll
    if (!hookOpenPage()) {
        document.addEventListener('DOMContentLoaded', hookOpenPage);
        window.addEventListener('load', hookOpenPage);
        var n = 0;
        var poll = setInterval(function () {
            if (hookOpenPage() || ++n > 20) clearInterval(poll);
        }, 250);
    }
})();

_log('[CommissioningBridge] Simple bridge loaded');
