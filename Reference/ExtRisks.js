// --- Scheduling helpers (safe, minimal) ---
// Advanced risk combination methods for capital projects
//
// Phase-weight rationale grounded in empirical megaproject research:
//   - Flyvbjerg (2014): 9/10 megaprojects overrun; procurement and early phases
//     carry highest external exposure (regulatory, market, supply chain)
//   - Merrow (2011, "Industrial Megaprojects"): FEL/development phase decisions
//     lock in 80% of project cost; external market conditions dominate
//   - Morris & Hough (1987): Engineering-phase scope changes are the #1
//     driver of cost growth — external client/regulatory changes dominate
//   - CII (Construction Industry Institute) studies: Construction-phase risks
//     are predominantly execution/internal (labor productivity, rework, safety)
//   - Commissioning/closeout: internal integration dominates but external
//     regulatory acceptance remains a factor
class RiskCombiner {
    // Method 1: Phase-Weighted Combination (considers project lifecycle)
    static phaseWeighted(internalRisk, externalRisk, projectPhase) {
        const phaseWeights = {
            'Development': { internal: 0.25, external: 0.75 },   // External dominates: market, regulatory, FEL decisions (Merrow 2011)
            'Engineering': { internal: 0.35, external: 0.65 },   // External scope/regulatory changes drive growth (Morris & Hough 1987)
            'Procurement': { internal: 0.40, external: 0.60 },   // Supply chain, market prices — highest overrun phase (Flyvbjerg 2014)
            'Construction': { internal: 0.70, external: 0.30 },  // Execution risks dominate: productivity, rework (CII)
            'Commissioning': { internal: 0.75, external: 0.25 }, // Integration-dominant but regulatory acceptance matters
            'Closeout': { internal: 0.85, external: 0.15 }       // Mostly internal punch-list and handover
        };

        const weights = phaseWeights[projectPhase] || { internal: 0.5, external: 0.5 };
        return weights.internal * internalRisk + weights.external * externalRisk;
    }

    // Method 2: Maximum Risk with Correlation Factor (conservative approach)
    static maxWithCorrelation(internalRisk, externalRisk, correlationFactor = 0.3) {
        const maxRisk = Math.max(internalRisk, externalRisk);
        const minRisk = Math.min(internalRisk, externalRisk);
        return Math.min(1, maxRisk + correlationFactor * minRisk);
    }

    // Method 3: Root Sum of Squares (assumes partial independence)
    static rootSumSquares(internalRisk, externalRisk, dependenceFactor = 0.7) {
        // Pure RSS assumes independence
        const rss = Math.sqrt(internalRisk ** 2 + externalRisk ** 2);
        // Adjust for dependency
        const linear = internalRisk + externalRisk;
        // Blend based on dependency factor (0 = independent, 1 = fully dependent)
        const combined = (1 - dependenceFactor) * (rss / Math.sqrt(2)) + dependenceFactor * (linear / 2);
        return Math.min(1, combined);
    }

    // Method 4: Bayesian Combination (most sophisticated)
    static bayesian(internalRisk, externalRisk, priorWeight = 0.6) {
        // Use internal risk as prior, external as evidence
        const posterior = (priorWeight * internalRisk + (1 - priorWeight) * externalRisk);
        // Apply amplification for joint high risks
        const amplification = internalRisk * externalRisk;
        return Math.min(1, posterior + 0.2 * amplification);
    }

    // Method 5: Activity-Type Specific (recommended for capital projects)
    static activitySpecific(internalRisk, externalRisk, activityType, isOnCriticalPath) {
        let combinedRisk;

        // Different combination strategies for different activity types
        switch (activityType) {
            case 'Permits & Approvals':
            case 'Regulatory':
                // External risks dominate for regulatory activities
                combinedRisk = Math.max(externalRisk, internalRisk * 0.3);
                break;

            case 'Construction':
            case 'Installation':
                // Internal execution risks dominate
                combinedRisk = Math.max(internalRisk, externalRisk * 0.4);
                break;

            case 'Procurement':
            case 'Supply Chain':
                // Both equally important
                combinedRisk = this.rootSumSquares(internalRisk, externalRisk, 0.5);
                break;

            default:
                // Use weighted geometric mean as default
                combinedRisk = Math.pow(internalRisk, 0.6) * Math.pow(externalRisk, 0.4);
        }

        // Amplify for critical path activities
        if (isOnCriticalPath) {
            combinedRisk = Math.min(1, combinedRisk * 1.15);
        }

        return combinedRisk;
    }
}

// =============================================================================
// COMPOUND RISK DETECTION — cross-domain signal convergence analysis
// =============================================================================

/**
 * Analyzes external signals for cross-domain compound risk.
 * When multiple signal types (weather + supply + regulatory, etc.) converge
 * on the same region or time window, the combined risk exceeds the sum of parts.
 * Returns amplification factors that downstream consumers (Monte Carlo, Schwerpunkt) can use.
 *
 * Compound risk amplification is grounded in risk interaction theory:
 *   - Hillson (2003): Risk interactions create emergent risks exceeding sum of parts
 *   - PMI Practice Standard for Risk Management: compound risks require
 *     super-additive treatment when domains overlap
 *   - Amplification uses diminishing returns (log-based) rather than linear
 *     scaling to prevent runaway amplification while still reflecting that
 *     3+ converging domains represent qualitatively different risk regimes
 */
function analyzeCompoundRisk(signals) {
    if (!Array.isArray(signals) || signals.length < 2) {
        return { hasCompoundRisk: false, regions: [], amplification: 1.0 };
    }

    // Group signals by region
    var regionMap = {};
    signals.forEach(function (s) {
        var region = s.region || s.country || 'global';
        if (!regionMap[region]) regionMap[region] = { types: {}, signals: [], maxSeverity: 0 };
        var entry = regionMap[region];
        entry.types[s.type || 'unknown'] = (entry.types[s.type || 'unknown'] || 0) + 1;
        entry.signals.push(s);
        if ((s.severity || 0) > entry.maxSeverity) entry.maxSeverity = s.severity || 0;
    });

    var compoundRegions = [];
    Object.keys(regionMap).forEach(function (region) {
        var entry = regionMap[region];
        var typeCount = Object.keys(entry.types).length;
        if (typeCount >= 2) {
            // Compound risk: multiple domains converge
            // Amplification uses diminishing-returns scaling:
            //   2 types: 1.15x (+15%)
            //   3 types: 1.27x (+27%)
            //   4 types: 1.36x (+36%)
            //   5+ types: approaches 1.50x cap
            // Severity-weighted: high-severity compound risks amplify more
            var baseAmplification = 1.0 + 0.25 * Math.log2(typeCount);
            var severityBoost = entry.maxSeverity > 0.7 ? 0.08 : (entry.maxSeverity > 0.4 ? 0.04 : 0);
            var amplification = Math.min(baseAmplification + severityBoost, 1.5);

            compoundRegions.push({
                region: region,
                types: Object.keys(entry.types),
                typeCount: typeCount,
                signalCount: entry.signals.length,
                maxSeverity: entry.maxSeverity,
                amplification: amplification
            });
        }
    });

    // Overall amplification is the max across regions
    var maxAmplification = compoundRegions.reduce(function (max, r) {
        return Math.max(max, r.amplification);
    }, 1.0);

    return {
        hasCompoundRisk: compoundRegions.length > 0,
        regions: compoundRegions,
        amplification: maxAmplification
    };
}

// =============================================================================
// UNIFIED COMBINED RISK — phase-aware, confidence-weighted integration
// =============================================================================
//
// This function is the single authoritative method for combining internal
// (structural/schedule) risk with external (supply chain, weather, regulatory)
// risk. All consumers should call this rather than ad-hoc combination.
//
// Design principles:
//   1. Phase-weighted: external signals dominate early phases (Flyvbjerg 2014,
//      Merrow 2011), internal execution risks dominate construction (CII)
//   2. Confidence-weighted: external signal contribution scales with signal
//      confidence — low-confidence signals are dampened to avoid noise
//   3. Compound risk amplification: multiple converging signal types create
//      emergent risk beyond sum of parts (Hillson 2003)
//   4. Critical path amplification: CP activities propagate delay with certainty
//
// Returns: combined risk score in [0, 1]
// =============================================================================

/**
 * Compute combined risk score for an activity node.
 *
 * @param {number} internalRisk     — structural/schedule risk from ComputeMetrics (0-1)
 * @param {number} externalRisk     — external schedule risk (0-1)
 * @param {Object} opts
 * @param {string} opts.phase       — activity phase (Engineering, Procurement, Construction, etc.)
 * @param {number} opts.confidence  — external signal confidence (0-1), default 0.5
 * @param {boolean} opts.isOnCriticalPath — whether activity is on the critical path
 * @param {number} opts.compoundAmplification — compound risk amplification factor (1.0-1.5)
 * @returns {number} combined risk score in [0, 1]
 */
function computeCombinedRisk(internalRisk, externalRisk, opts) {
    opts = opts || {};
    var phase = opts.phase || null;
    var confidence = typeof opts.confidence === 'number' ? opts.confidence : 0.5;
    var isOnCriticalPath = opts.isOnCriticalPath || false;
    var compoundAmplification = opts.compoundAmplification || 1.0;

    // Clamp inputs
    internalRisk = Math.min(1, Math.max(0, internalRisk || 0));
    externalRisk = Math.min(1, Math.max(0, externalRisk || 0));
    confidence = Math.min(1, Math.max(0, confidence));

    // Apply compound risk amplification to external risk
    externalRisk = Math.min(1, externalRisk * compoundAmplification);

    // Confidence-weight the external risk contribution
    // Low-confidence signals are dampened: effective_external = external × confidence^0.5
    // Using sqrt(confidence) so that even moderate confidence (0.5) retains ~71% of signal
    // while very low confidence (0.1) retains only ~32%
    var confidenceWeight = Math.sqrt(confidence);
    var effectiveExternalRisk = externalRisk * confidenceWeight;

    // Phase-weighted combination (when phase is available)
    var combined;
    if (phase) {
        // Use phase-specific internal/external balance
        var phaseWeights = {
            'Planning':             { internal: 0.25, external: 0.75 },
            'Development':          { internal: 0.25, external: 0.75 },
            'Engineering':          { internal: 0.35, external: 0.65 },
            'Procurement':          { internal: 0.40, external: 0.60 },
            'Fabrication':          { internal: 0.55, external: 0.45 },
            'Construction':         { internal: 0.70, external: 0.30 },
            'Integration':          { internal: 0.65, external: 0.35 },
            'Pre-Commissioning':    { internal: 0.70, external: 0.30 },
            'Commissioning':        { internal: 0.75, external: 0.25 },
            'Marine Logistics':     { internal: 0.45, external: 0.55 },
            'Offshore Installation': { internal: 0.50, external: 0.50 },
            'Operations / Handover': { internal: 0.85, external: 0.15 },
            'Project Controls / Milestones': { internal: 0.80, external: 0.20 }
        };
        var w = phaseWeights[phase] || { internal: 0.55, external: 0.45 };
        combined = w.internal * internalRisk + w.external * effectiveExternalRisk;
    } else {
        // No phase available: use multiplicative independence assumption
        // P(problem) = 1 - P(no internal) × P(no external)
        // This is conservative (assumes partial independence)
        combined = 1 - (1 - internalRisk) * (1 - effectiveExternalRisk);
    }

    // Critical path amplification (modest — CP already boosted in structural risk)
    if (isOnCriticalPath) {
        combined = Math.min(1, combined * 1.12);
    }

    return Math.min(1, Math.max(0, combined));
}

// Store compound risk analysis on state for downstream consumers
function updateCompoundRiskState() {
    var state = window.cybereumState || {};
    var snapshot = state.externalSignalSnapshot;
    if (snapshot && Array.isArray(snapshot.signals)) {
        state.compoundRiskAnalysis = analyzeCompoundRisk(snapshot.signals);
        state.sentimentDivergence = analyzeSentimentDivergence(snapshot.signals);
        state.weatherForecastConfidence = extractWeatherConfidence(snapshot.signals);
    } else {
        state.compoundRiskAnalysis = { hasCompoundRisk: false, regions: [], amplification: 1.0 };
        state.sentimentDivergence = { hasDivergence: false, signals: [] };
        state.weatherForecastConfidence = { hasForecasts: false, forecasts: [] };
    }
}

// =============================================================================
// SENTIMENT DIVERGENCE ANALYSIS — prediction market vs. authoritative data
// =============================================================================

/**
 * Extracts signals where prediction market consensus diverges from authoritative sources.
 * Positive divergence = crowd overpanicking (market price > authoritative).
 * Negative divergence = crowd underreacting (market price < authoritative).
 * Downstream consumers can use this to weight risk signals more accurately.
 */
function analyzeSentimentDivergence(signals) {
    if (!Array.isArray(signals)) {
        return { hasDivergence: false, signals: [], avgDivergence: 0 };
    }

    var divergentSignals = [];
    var overreactionCount = 0;
    var underreactionCount = 0;
    var sumDiv = 0;

    signals.forEach(function (s) {
        if (s.divergence != null && Math.abs(s.divergence) > 0.05) {
            var direction = s.divergence > 0 ? 'crowd_overpanicking' : 'crowd_underreacting';
            if (direction === 'crowd_overpanicking') overreactionCount++;
            else underreactionCount++;
            sumDiv += s.divergence;

            divergentSignals.push({
                summary: s.summary,
                source: s.source,
                region: s.region,
                market_probability: s.market_probability,
                authoritative_probability: s.authoritative_probability,
                divergence: s.divergence,
                direction: direction,
                severity_adjustment: s.divergence > 0.15 ? 0.8 : (s.divergence < -0.15 ? 1.2 : 1.0)
            });
        }
    });

    var avgDiv = divergentSignals.length > 0 ? sumDiv / divergentSignals.length : 0;

    return {
        hasDivergence: divergentSignals.length > 0,
        signals: divergentSignals,
        avgDivergence: Math.round(avgDiv * 1000) / 1000,
        overreactionCount: overreactionCount,
        underreactionCount: underreactionCount
    };
}

// =============================================================================
// WEATHER FORECAST CONFIDENCE — probabilistic weather signal extraction
// =============================================================================

/**
 * Extracts NOAA probabilistic forecast signals with confidence scores.
 * These provide construction-schedule-relevant weather intel:
 *   - Temperature extremes (work stoppage risk)
 *   - Precipitation probability (delay risk)
 *   - Wind speed (crane shutdown threshold)
 * Unlike binary alerts, these carry forecast_confidence (0..1) and forecast_detail (JSON).
 */
function extractWeatherConfidence(signals) {
    if (!Array.isArray(signals)) {
        return { hasForecasts: false, forecasts: [], avgConfidence: 0 };
    }

    var forecasts = [];
    var sumConf = 0;
    var h24Count = 0;
    var h48Count = 0;

    signals.forEach(function (s) {
        if (s.forecast_confidence != null && s.type === 'weather') {
            var detail = null;
            if (s.forecast_detail) {
                try { detail = JSON.parse(s.forecast_detail); } catch (e) { /* ignore */ }
            }

            var horizon = s.forecast_horizon || 'unknown';
            if (horizon === '24h') h24Count++;
            else if (horizon === '48h') h48Count++;
            sumConf += s.forecast_confidence;

            forecasts.push({
                summary: s.summary,
                source: s.source,
                region: s.region,
                severity: s.severity,
                confidence: s.forecast_confidence,
                horizon: horizon,
                detail: detail,
                // severity is already confidence-adjusted on the server (severity * confidence)
                weightedSeverity: Math.round((s.severity || 0) * 1000) / 1000
            });
        }
    });

    forecasts.sort(function (a, b) { return b.weightedSeverity - a.weightedSeverity; });

    return {
        hasForecasts: forecasts.length > 0,
        forecasts: forecasts,
        avgConfidence: forecasts.length > 0 ? Math.round(sumConf / forecasts.length * 1000) / 1000 : 0,
        maxWeightedSeverity: forecasts.length > 0 ? forecasts[0].weightedSeverity : 0,
        horizonCoverage: { h24: h24Count, h48: h48Count }
    };
}

// =============================================================================
// CALIBRATED EXTERNAL RISK PIPELINE v2.1
// Optimizations: Pre-computed keywords, diversity selection, stronger location scoring
// =============================================================================

const RISK_PIPELINE_CONFIG = {
    thresholds: {
        light: { maxComplexity: 30, maxActivities: 200 },
        standard: { maxComplexity: 65, maxCapex: 500e6 },
    },
    scaling: {
        baseRisks: 30,           // INCREASED from 25 - higher baseline
        maxRisks: 200,           // INCREASED from 150 - allow more risks for large projects
        overGenerateFactor: 1.5, // INCREASED from 1.4 - ask LLM for more
        complexityWeight: 0.80,  // INCREASED from 0.75 - scale more with complexity
    },
    synthesis: {
        qualityThreshold: 0.25,   // LOWERED from 0.4 - accept more risks
        groundingThreshold: 0.2,  // LOWERED from 0.3 - less strict
        clusterSimilarity: 0.50,  // INCREASED from 0.35 - only merge very similar risks
        diversityPenalty: 0.10,   // LOWERED from 0.15 - less diversity penalty
        maxMergedMitigations: 8,
        maxMergedIndicators: 6,
    },
    validation: {
        enabled: true,
        borderlineThreshold: 0.35, // LOWERED from 0.5 - validate fewer
        maxValidationBatch: 15,
    },
    fallback: {
        enabled: true,
        endpoint: '/OpenAI/AssessExternalRisks',
    }
};

// OPTIMIZATION: Hoist stopwords to module level (created once, not per-call)
const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'will', 'may',
    'can', 'could', 'would', 'should', 'have', 'has', 'been', 'being', 'was',
    'were', 'which', 'their', 'them', 'these', 'those', 'such', 'than', 'then',
    'into', 'over', 'under', 'during', 'before', 'after', 'above', 'below',
    'project', 'risk', 'impact', 'delay', 'issue', 'problem', 'cause', 'effect',
    'potential', 'possible', 'related', 'associated', 'result', 'lead', 'due'
]);

// OPTIMIZATION: Memoization cache for categorizeByName (called 1000s of times)
const _categoryCache = new Map();
const CATEGORY_CACHE_MAX = 5000; // Prevent unbounded growth

// =============================================================================
// STAGE 0: CALIBRATION
// =============================================================================

function calibrateRiskPipeline(nodes, meta) {
    const metrics = extractProjectMetrics(nodes, meta);
    const complexity = calculateComplexity(metrics);
    const pipelineDepth = selectPipelineDepth(complexity, metrics);
    const targets = calculateTargets(complexity, metrics, pipelineDepth);
    const seeds = selectCanonicalSeeds(metrics.sector);
    const requiredTypes = determineRequiredTypes(metrics.sector);

    console.log(`[Calibration] Complexity: ${complexity.score}/100, Depth: ${pipelineDepth}, Target: ${targets.final}`);

    return { metrics, complexity, pipelineDepth, targets, seeds, requiredTypes, timestamp: new Date().toISOString() };
}

function extractProjectMetrics(nodes, meta) {
    return {
        activityCount: Array.isArray(nodes) ? nodes.length : 0,
        durationDays: meta?.baseline?.schedule_months
            ? Math.round(meta.baseline.schedule_months * 30.4375)
            : (meta?.timeline?.duration_days || 365),
        capexUsd: meta?.baseline?.capex_usd || 0,
        sector: meta?.sector || 'General',
        region: meta?.region || '',
        country: meta?.country || '',
        projectName: meta?.name || 'Capital Project'
    };
}

function calculateComplexity(metrics) {
    const { activityCount, durationDays, capexUsd, sector } = metrics;

    const activityScore = Math.min(25, (activityCount / 500) * 25);
    const durationScore = Math.min(25, (durationDays / 1500) * 25);
    const capexScore = Math.min(25, (capexUsd / 5e9) * 25);
    const interdependencyBonus = activityCount > 1000 ? 10 : (activityCount > 500 ? 5 : 0);
    const multiplier = getSectorMultiplier(sector);

    const rawScore = activityScore + durationScore + capexScore + interdependencyBonus;
    const score = Math.min(100, Math.round(rawScore * multiplier));

    return {
        score,
        components: { activityScore, durationScore, capexScore, interdependencyBonus },
        multiplier,
        isCriticalInfrastructure: isCriticalSector(sector),
        isMegaProject: capexUsd > 1e9
    };
}

function getSectorMultiplier(sector) {
    const multipliers = {
        nuclear: 1.4, olympic: 1.3, petrochemical: 1.25, chemical: 1.2,
        lng: 1.25, refinery: 1.2, offshore: 1.25, semiconductor: 1.2,
        defense: 1.15, aerospace: 1.15, rail: 1.1, airport: 1.1,
        tunnel: 1.1, hospital: 1.1, datacenter: 1.05, port: 1.05,
        mining: 1.0, bridge: 1.0, water: 1.0, power: 0.95,
        solar: 0.9, wind: 0.9, road: 0.9, building: 0.85
    };
    const sectorLower = (sector || '').toLowerCase();
    for (const [key, mult] of Object.entries(multipliers)) {
        if (sectorLower.includes(key)) return mult;
    }
    return 1.0;
}

function isCriticalSector(sector) {
    const critical = ['nuclear', 'petrochemical', 'chemical', 'lng', 'refinery',
        'offshore', 'defense', 'aerospace', 'dam', 'pipeline', 'port', 'airport'];
    const sectorLower = (sector || '').toLowerCase();
    return critical.some(c => sectorLower.includes(c));
}

function selectPipelineDepth(complexity, metrics) {
    const cfg = RISK_PIPELINE_CONFIG.thresholds;
    if (complexity.score < cfg.light.maxComplexity && metrics.activityCount < cfg.light.maxActivities) return 'LIGHT';
    if (complexity.score < cfg.standard.maxComplexity || metrics.capexUsd < cfg.standard.maxCapex) return 'STANDARD';
    return 'DEEP';
}

function calculateTargets(complexity, metrics, pipelineDepth) {
    const cfg = RISK_PIPELINE_CONFIG.scaling;
    const complexityBonus = Math.round((complexity.score / 100) * cfg.maxRisks * cfg.complexityWeight);
    const megaProjectBonus = metrics.capexUsd > 1e9 ? 25 : (metrics.capexUsd > 500e6 ? 15 : 0);
    const criticalBonus = complexity.isCriticalInfrastructure ? 15 : 0;

    const final = Math.min(cfg.maxRisks, Math.max(cfg.baseRisks,
        cfg.baseRisks + complexityBonus + megaProjectBonus + criticalBonus));
    const generate = Math.round(final * cfg.overGenerateFactor);

    return { final, generate, base: cfg.baseRisks };
}

// =============================================================================
// SEEDS - EXPANDED for comprehensive risk generation
// Each sector needs 10-15 seeds to ensure diverse risk coverage
// =============================================================================

const CANONICAL_SEEDS = {
    universal: [
        // Engineering & Design
        { type: 'Technical', seed: 'Design maturity and engineering changes', hint: 'Scope creep, late design changes, interface conflicts, drawing delays' },
        { type: 'Technical', seed: 'Contractor/subcontractor performance', hint: 'Schedule slippage, quality issues, resource constraints, coordination failures' },
        // Regulatory
        { type: 'Regulatory', seed: 'Permit and approval delays', hint: 'Agency review times, public hearings, environmental reviews, appeal processes' },
        { type: 'Regulatory', seed: 'Regulatory changes during execution', hint: 'New requirements, code updates, policy shifts, compliance costs' },
        // Supply Chain
        { type: 'Supply Chain', seed: 'Long-lead equipment delivery', hint: 'Compressors, transformers, vessels - 18-36 month lead times, vendor capacity' },
        { type: 'Supply Chain', seed: 'Material price escalation', hint: 'Steel, copper, concrete price volatility, index adjustments' },
        { type: 'Supply Chain', seed: 'Supplier financial distress', hint: 'Vendor bankruptcy, single-source risks, payment disputes' },
        // Labor
        { type: 'Labor', seed: 'Craft labor availability', hint: 'Welder, pipefitter, electrician shortages, competing projects' },
        { type: 'Labor', seed: 'Labor productivity and efficiency', hint: 'Learning curve, site conditions, supervision quality, rework rates' },
        // Construction
        { type: 'Weather', seed: 'Weather and climate impacts', hint: 'Seasonal constraints, extreme events, force majeure, climate patterns' },
        { type: 'Technical', seed: 'Site conditions and access', hint: 'Geotechnical surprises, utilities, laydown constraints, logistics' },
        // Commissioning
        { type: 'Technical', seed: 'Commissioning and startup complexity', hint: 'System integration, performance testing, punch list, operational readiness' },
        // Commercial
        { type: 'Market', seed: 'Contract disputes and claims', hint: 'Change orders, delay claims, scope interpretation, liquidated damages' },
    ],
    petrochemical: [
        { type: 'Supply Chain', seed: 'Rotating equipment procurement', hint: 'Compressors, pumps, turbines - limited OEM capacity, 18-30 month leads' },
        { type: 'Supply Chain', seed: 'Static equipment fabrication', hint: 'Reactors, columns, vessels, exchangers - steel availability, shop capacity' },
        { type: 'Technical', seed: 'Process technology and licensor issues', hint: 'Technology guarantees, design data, licensor responsiveness' },
        { type: 'Process Safety', seed: 'HAZOP findings and design changes', hint: 'Safety studies driving scope, SIL requirements, relief system sizing' },
        { type: 'Technical', seed: 'Modular construction execution', hint: 'Yard capacity, module transport, integration complexity' },
        { type: 'Technical', seed: 'Catalyst and chemical procurement', hint: 'Specialty catalysts, initial fills, activation requirements' },
        { type: 'Commodity', seed: 'Feedstock and product market volatility', hint: 'Price exposure, offtake agreements, margin compression' },
        { type: 'Technical', seed: 'Control system integration', hint: 'DCS/SIS programming, FAT/SAT testing, loop checking' },
    ],
    nuclear: [
        { type: 'Regulatory', seed: 'Nuclear licensing timeline', hint: 'NRC review cycles 3-5 years, design certification, COL process' },
        { type: 'Regulatory', seed: 'Public intervention and opposition', hint: 'Intervenor challenges, hearings, legal appeals, schedule impacts' },
        { type: 'Supply Chain', seed: 'Nuclear-grade supply chain constraints', hint: 'N-stamp vendors, QA requirements, NQA-1 documentation' },
        { type: 'Supply Chain', seed: 'Reactor and major component delivery', hint: 'RPV, steam generators, limited global manufacturing capacity' },
        { type: 'Technical', seed: 'First-of-a-kind design challenges', hint: 'Design maturity, reference plant experience, engineering resources' },
        { type: 'Quality', seed: 'Nuclear quality assurance requirements', hint: 'Documentation burden, inspection hold points, rework' },
        { type: 'Security', seed: 'Security and cyber requirements', hint: 'Clearances, physical security, cyber compliance during construction' },
        { type: 'Technical', seed: 'Concrete and civil construction', hint: 'Nuclear-grade concrete, embedments, basemat, heavy lifts' },
    ],
    datacenter: [
        { type: 'Technical', seed: 'Grid interconnection and power supply', hint: 'Utility studies, substation capacity, interconnection timeline' },
        { type: 'Supply Chain', seed: 'Critical electrical equipment', hint: 'Transformers 18-24mo, switchgear 12-18mo, generators competing globally' },
        { type: 'Supply Chain', seed: 'UPS and battery systems', hint: 'UPS lead times 12-18mo, battery chemistry availability' },
        { type: 'Supply Chain', seed: 'Cooling system equipment', hint: 'Chillers, cooling towers, CRAH units - extended lead times' },
        { type: 'Technical', seed: 'Fiber and network infrastructure', hint: 'Fiber routes, meet-me rooms, carrier coordination' },
        { type: 'Technical', seed: 'Hyperscaler specification compliance', hint: 'Customer requirements, design changes, acceptance testing' },
        { type: 'Technology', seed: 'Technology and design evolution', hint: 'Chip roadmap changes, power density, cooling requirements' },
        { type: 'Environmental', seed: 'Community and environmental concerns', hint: 'Water usage, noise, visual impact, power consumption' },
    ],
    offshore: [
        { type: 'Weather', seed: 'Marine weather windows', hint: 'Hs limits 1.5-2.5m, seasonal constraints, standby costs $500k+/day' },
        { type: 'Supply Chain', seed: 'Installation vessel availability', hint: 'Heavy lift, pipelay, DSV vessels - limited global fleet, day rates' },
        { type: 'Supply Chain', seed: 'Fabrication yard capacity', hint: 'Topsides, jackets, modules - yard competition, labor availability' },
        { type: 'Supply Chain', seed: 'Subsea equipment manufacturing', hint: 'Trees, manifolds, umbilicals - 18-24 month leads, limited vendors' },
        { type: 'Logistics', seed: 'Marine logistics and transport', hint: 'Heavy transport vessels, loadout operations, transit routing' },
        { type: 'Technical', seed: 'Offshore hook-up and commissioning', hint: 'Weather sensitivity, accommodation limits, SIMOPS complexity' },
        { type: 'Marine Operations', seed: 'Dive and ROV operations', hint: 'Dive spreads, ROV availability, water depth limitations' },
        { type: 'Regulatory', seed: 'Offshore regulatory requirements', hint: 'BSEE/BOEM permits, safety case, environmental compliance' },
        { type: 'Technical', seed: 'Floatover and heavy lift operations', hint: 'Weather windows, barge stability, rigging design, contingency' },
    ],
    mining: [
        { type: 'Market', seed: 'Commodity price economics', hint: 'Price volatility, breakeven sensitivity, hedge limitations' },
        { type: 'Social', seed: 'Community and social license', hint: 'Stakeholder opposition, benefit sharing, protest disruptions' },
        { type: 'Social', seed: 'Indigenous rights and consultation', hint: 'Free prior informed consent, cultural heritage, land claims' },
        { type: 'Technical', seed: 'Geological and ore body uncertainty', hint: 'Grade variability, orebody geometry, mining method changes' },
        { type: 'Environmental', seed: 'Water management and tailings', hint: 'Dewatering, treatment, dam stability, closure liability' },
        { type: 'Logistics', seed: 'Remote site logistics', hint: 'Access roads, camp operations, supply chain distance' },
        { type: 'Technical', seed: 'Process plant performance', hint: 'Metallurgical recovery, throughput, ramp-up duration' },
        { type: 'Supply Chain', seed: 'Heavy equipment procurement', hint: 'Haul trucks, excavators, crushers - lead times, spares' },
    ],
    infrastructure: [
        { type: 'Regulatory', seed: 'Right-of-way acquisition', hint: 'Parcel negotiations, holdouts, condemnation timeline, cost escalation' },
        { type: 'Technical', seed: 'Utility conflicts and relocations', hint: 'Utility mapping, relocation costs, coordination delays' },
        { type: 'Technical', seed: 'Geotechnical and ground conditions', hint: 'Unexpected soil, contamination, groundwater, rock' },
        { type: 'Social', seed: 'Traffic and public disruption', hint: 'Maintenance of traffic, public complaints, political pressure' },
        { type: 'Environmental', seed: 'Environmental and archaeological', hint: 'Wetlands, species, cultural resources, mitigation costs' },
        { type: 'Regulatory', seed: 'Multi-agency coordination', hint: 'Federal/state/local permits, review cycles, conflicting requirements' },
        { type: 'Market', seed: 'Funding and appropriations', hint: 'Budget cycles, federal grants, cost sharing, inflation' },
        { type: 'Technical', seed: 'Bridge and tunnel construction', hint: 'Foundation conditions, waterway permits, complex geometry' },
    ],
};

function selectCanonicalSeeds(sector) {
    const sectorLower = (sector || '').toLowerCase();
    let sectorSeeds = [];

    const matchers = [
        { key: 'petrochemical', patterns: ['petrochem', 'chemical', 'polymer', 'cracker', 'refin', 'lng', 'ammonia'] },
        { key: 'nuclear', patterns: ['nuclear'] },
        { key: 'datacenter', patterns: ['data center', 'datacenter'] },
        { key: 'offshore', patterns: ['offshore', 'subsea', 'fpso', 'platform', 'oil', 'gas', 'o&g'] },
        { key: 'mining', patterns: ['mining', 'mine', 'mineral'] },
        { key: 'infrastructure', patterns: ['infrastructure', 'road', 'highway', 'bridge', 'tunnel', 'rail', 'transit'] },
    ];

    for (const m of matchers) {
        if (m.patterns.some(p => sectorLower.includes(p))) {
            sectorSeeds = CANONICAL_SEEDS[m.key] || [];
            break;
        }
    }

    // Combine ALL universal + ALL sector seeds (don't filter by type)
    // More seeds = more diverse risks
    const combined = [...CANONICAL_SEEDS.universal, ...sectorSeeds];

    console.log(`[Seeds] Selected ${combined.length} seeds for sector: ${sector}`);
    return combined;
}

function determineRequiredTypes(sector) {
    const base = ['Regulatory', 'Environmental', 'Market', 'Technical', 'Labor', 'Supply Chain'];
    const sectorLower = (sector || '').toLowerCase();

    if (sectorLower.includes('nuclear')) return [...base, 'Safety', 'Security', 'Social', 'Quality'];
    if (sectorLower.match(/petrochem|chemical|lng|refin/)) return [...base, 'Process Safety', 'Commodity', 'Contractor'];
    if (sectorLower.match(/offshore|subsea|oil|gas/)) return [...base, 'Weather', 'Marine Operations', 'Logistics'];
    if (sectorLower.includes('data center')) return [...base, 'Power Supply', 'Technology'];
    if (sectorLower.includes('mining')) return [...base, 'Commodity', 'Social', 'Geotechnical'];
    return base;
}

// =============================================================================
// SECTOR GUIDANCE - Rich context to help LLM generate BETTER risks (not fewer)
// This provides context WITHOUT restricting what risks can be generated
// =============================================================================

const EPC_FABRICATION_GUIDANCE = {
    offshore: {
        has_remote_fabrication: true,
        typical_fab_locations: ['South Korea', 'Singapore', 'UAE', 'China', 'Indonesia', 'Malaysia'],
        fab_categories: ['topsides', 'jackets', 'FPSO hulls', 'subsea structures', 'modules'],
        guidance: `For offshore EPC projects, major fabrication occurs at specialized yards (typically in 
South Korea, Singapore, UAE, China) - NOT at the offshore installation site. The project location 
(e.g., Gulf of Mexico, North Sea) affects INSTALLATION risks (weather windows, vessel logistics, 
marine conditions) but fabrication risks are governed by yard location.

Generate risks for BOTH contexts:
- FABRICATION RISKS: Yard capacity constraints, labor availability in fabrication country, 
  steel and material supply chains, quality control at remote yards, schedule coordination
- LOGISTICS RISKS: Heavy transport, loadout operations, marine transit, customs/import
- INSTALLATION RISKS: Weather windows and Hs limits, vessel availability and day rates,
  hook-up complexity, marine operations coordination, offshore safety requirements

Consider the DUAL GEOGRAPHY: fabrication yards have different risk profiles than the offshore site.`
    },
    petrochemical: {
        has_remote_fabrication: true,
        typical_fab_locations: ['varies by equipment type and module strategy'],
        fab_categories: ['process modules', 'pipe racks', 'vessels', 'exchangers', 'packaged units'],
        guidance: `Large petrochemical projects often use modular construction with fabrication in 
different locations than the plant site. Long-lead equipment (compressors, reactors, columns) 
comes from specialized manufacturers globally.

Generate risks considering:
- EQUIPMENT RISKS: OEM manufacturing delays, specialized vendor capacity, long lead times (18-36 months)
- MODULE RISKS: Fabrication yard capacity, craft labor in yard location, heavy lift/transport
- SITE RISKS: Local installation labor, weather, brownfield integration, turnaround windows
- COMMISSIONING: Integrated systems startup, process safety, catalyst loading, performance testing`
    },
    lng: {
        has_remote_fabrication: true,
        typical_fab_locations: ['South Korea', 'China', 'Indonesia', 'specialized OEMs globally'],
        fab_categories: ['LNG trains', 'cryogenic equipment', 'storage tanks', 'marine facilities'],
        guidance: `LNG projects involve highly specialized cryogenic equipment from a limited pool of 
qualified global suppliers. Consider:
- CRYOGENIC EQUIPMENT: Very long lead times, limited qualified vendors, strict QA requirements
- STORAGE TANKS: Specialized construction techniques, nickel alloy materials
- MARINE FACILITIES: Jetty construction, loading arms, ship compatibility
- PROCESS RISKS: Liquefaction technology performance, refrigerant supply, flare systems`
    }
};

const SECTOR_SPECIFIC_GUIDANCE = {
    offshore: `Offshore/Subsea Project Considerations:
- Weather windows: Hs limits typically 1.5-2.5m for installation, seasonal constraints
- Vessel market: Installation vessels, pipelay vessels, DSVs have limited global availability
- Fabrication: Topsides, jackets, modules built at yards (Korea, Singapore, UAE)
- Subsea: Trees, manifolds, umbilicals from specialized manufacturers (18-24 month leads)
- Installation: Hook-up campaigns, SIMOPS, marine warranty requirements
- Regulatory: BSEE/BOEM (GOM), offshore safety case, environmental permits
- Remote logistics: Supply base operations, helicopter transport, marine support`,

    petrochemical: `Petrochemical/Refining Project Considerations:
- Process equipment: Compressors, reactors, columns, exchangers (18-36 month leads)
- Process safety: HAZOP, SIL ratings, safety instrumented systems
- Commissioning: Sequential system startup, catalyst activation, performance testing
- Brownfield: Tie-ins to existing operations, turnaround windows, SIMOPS
- Specialized labor: Pipefitters, welders, instrument technicians in high demand
- Modular strategy: Trade-off between yard efficiency and transport constraints`,

    nuclear: `Nuclear Project Considerations:
- Licensing: NRC/regulatory body reviews typically 3-5 years
- Nuclear-grade supply chain: N-stamp qualification, limited qualified vendors
- Quality assurance: NQA-1 requirements, extensive documentation
- Public/stakeholder: Intervention processes, public hearings, legal challenges
- Security: Clearances, cyber requirements, physical security during construction
- First-of-a-kind: Design maturity for new reactor types, regulatory uncertainty`,

    datacenter: `Data Center Project Considerations:
- Utility power: Grid interconnection studies, substation requirements, MW availability
- Electrical equipment: Switchgear, UPS, generators (12-18 month leads currently)
- Cooling: Chiller capacity, water rights/availability, mechanical systems
- Fiber/network: Connectivity infrastructure, meet-me rooms, carrier access
- Hyperscaler requirements: Strict specifications, acceptance testing protocols
- Competition: Multiple projects competing for same equipment and contractors`,

    mining: `Mining Project Considerations:
- Commodity prices: Project economics highly sensitive to price cycles
- Social license: Community relations, indigenous rights, benefit sharing
- Remote infrastructure: Camp, power generation, water supply, access roads
- Geological uncertainty: Ore grade variability, geotechnical conditions
- Environmental: Tailings management, water treatment, closure planning
- Equipment logistics: Heavy mobile equipment transport to remote sites`
};

function buildSectorGuidance(sector, region, country) {
    const sectorLower = (sector || '').toLowerCase();

    // Determine if EPC/fabrication guidance applies
    let epcContext = null;
    if (sectorLower.match(/offshore|subsea|fpso|platform|oil|gas|o&g/)) {
        epcContext = EPC_FABRICATION_GUIDANCE.offshore;
    } else if (sectorLower.match(/petrochem|chemical|refin|polymer|cracker/)) {
        epcContext = EPC_FABRICATION_GUIDANCE.petrochemical;
    } else if (sectorLower.match(/lng|liquefied|liquefaction/)) {
        epcContext = EPC_FABRICATION_GUIDANCE.lng;
    }

    // Get sector-specific guidance
    let sectorHints = '';
    if (sectorLower.match(/offshore|subsea|fpso|platform|oil|gas/)) {
        sectorHints = SECTOR_SPECIFIC_GUIDANCE.offshore;
    } else if (sectorLower.match(/petrochem|chemical|refin|lng/)) {
        sectorHints = SECTOR_SPECIFIC_GUIDANCE.petrochemical;
    } else if (sectorLower.includes('nuclear')) {
        sectorHints = SECTOR_SPECIFIC_GUIDANCE.nuclear;
    } else if (sectorLower.match(/data center|datacenter/)) {
        sectorHints = SECTOR_SPECIFIC_GUIDANCE.datacenter;
    } else if (sectorLower.includes('mining')) {
        sectorHints = SECTOR_SPECIFIC_GUIDANCE.mining;
    }

    return {
        sector: sector,
        epc_fabrication: epcContext,
        sector_hints: sectorHints,
        installation_location: {
            region: region,
            country: country,
            note: epcContext?.has_remote_fabrication
                ? 'This is the INSTALLATION location. Fabrication occurs at specialized yards globally.'
                : 'This is the project location.'
        }
    };
}

// =============================================================================
// STAGE 1: DIVERGENT GENERATION
// =============================================================================

function buildDivergentPayload(nodes, links, meta, calibration) {
    const base = typeof buildExternalRiskPayload === 'function'
        ? buildExternalRiskPayload(nodes, links, meta) : { project: meta };

    const nr = typeof deriveNonCriticalRelatedActivities === 'function'
        ? deriveNonCriticalRelatedActivities(nodes || [], meta)
        : { candidates: [], duration_outliers: [], summary: '' };

    // Build helpful sector guidance (NOT exclusions - we want MORE risks, not fewer)
    const sectorGuidance = buildSectorGuidance(
        calibration.metrics.sector,
        calibration.metrics.region,
        calibration.metrics.country
    );

    return {
        ...base,
        project: {
            ...(base.project || {}),
            name: meta?.project?.name || meta?.name || 'Capital Project',
            background: meta?.background || '',
            noncritical_candidates: nr.candidates,
            duration_outliers: nr.duration_outliers,
            candidate_summary: nr.summary,
            // Add explicit fields for C# prompt building
            activity_count: Array.isArray(nodes) ? nodes.length : 0,
            duration_days: meta?.baseline?.schedule_months
                ? Math.round(meta.baseline.schedule_months * 30.4375)
                : 365,
            capex_usd: meta?.baseline?.capex_usd || 0
        },
        pipeline: {
            stage: 'divergent',
            complexity_score: calibration.complexity.score,
            target_count: calibration.targets.generate,
            pipeline_depth: calibration.pipelineDepth,
            required_types: calibration.requiredTypes
        },
        seeds: calibration.seeds,
        location: { region: calibration.metrics.region, country: calibration.metrics.country },
        // Helpful context (NOT exclusions) - guides LLM to be smarter, not more restrictive
        sector_guidance: sectorGuidance
    };
}



function normalizeExternalSignalSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;

    // Normalize individual signal items (v2 includes full signal content)
    var signals = [];
    if (Array.isArray(snapshot.signals)) {
        signals = snapshot.signals.map(function (s) {
            if (!s || typeof s !== 'object') return null;
            return {
                type: s.type || 'unknown',
                summary: s.summary || '',
                source: s.source || '',
                publisher: s.publisher || '',
                url: s.url || '',
                as_of: s.as_of || '',
                severity: Number.isFinite(Number(s.severity)) ? Number(s.severity) : 0,
                region: s.region || '',
                country: s.country || '',
                location_hint: s.location_hint || ''
            };
        }).filter(Boolean);
    }

    return {
        version: snapshot.version || 'v1',
        source: snapshot.source || 'ExternalSignalsService',
        count: Number.isFinite(Number(snapshot.count)) ? Number(snapshot.count) : 0,
        timed_out: !!snapshot.timed_out,
        error: snapshot.error || null,
        generated_at_utc: snapshot.generated_at_utc || null,
        types: snapshot.types && typeof snapshot.types === 'object' ? snapshot.types : {},
        signals: signals
    };
}

async function executeDivergentGeneration(payload, calibration) {
    console.log(`[Stage 1] Generating ${calibration.targets.generate} candidates...`);

    const response = await fetch('/OpenAI/AssessExternalRisks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error(`Generation failed: ${response.status}`);
    }

    const result = await response.json();
    const signalSnapshot = normalizeExternalSignalSnapshot(result.external_signal_snapshot);

    if (signalSnapshot) {
        console.log(`[Stage 1] External signal snapshot: count=${signalSnapshot.count}, timed_out=${signalSnapshot.timed_out}`);
    }

    console.log(`[Stage 1] Received ${result.risk_register?.length || 0} candidates`);
    return result;
}

// =============================================================================
// STAGE 2: CONVERGENT SYNTHESIS (OPTIMIZED)
// =============================================================================

function executeConvergentSynthesis(generatedResult, calibration) {
    const risks = generatedResult.risk_register || [];
    if (risks.length === 0) {
        return { risks: [], borderline: [], stats: { generated: 0, final: 0 } };
    }

    console.log(`[Stage 2] Synthesizing ${risks.length} candidates...`);
    const t0 = performance.now();

    // Step 1: Score + PRE-COMPUTE KEYWORDS (OPTIMIZATION)
    const scored = risks.map(risk => {
        const scores = scoreRisk(risk, calibration.metrics);
        const keywords = extractKeywords(`${risk.name} ${risk.description}`);
        return { ...risk, _scores: scores, _keywords: new Set(keywords) };
    });

    // Step 2: Cluster using pre-computed keywords (OPTIMIZATION)
    const clusters = clusterRisksOptimized(scored);
    console.log(`[Stage 2] Clustered into ${clusters.length} groups`);

    // Step 3: Merge clusters
    const merged = clusters.map(mergeClusters);

    // Step 4: Sort by quality
    merged.sort((a, b) => (b._scores?.composite || 0) - (a._scores?.composite || 0));

    // Step 5: Select with coverage + DIVERSITY (OPTIMIZATION)
    const { selected, borderline } = selectWithCoverageAndDiversity(merged, calibration);

    // Step 6: Renumber
    selected.forEach((risk, idx) => {
        risk._originalId = risk.id;
        risk.id = idx + 1;
    });

    const elapsed = Math.round(performance.now() - t0);
    const stats = {
        generated: risks.length,
        clustered: clusters.length,
        final: selected.length,
        borderlineCount: borderline.length,
        avgQuality: selected.length > 0
            ? (selected.reduce((s, r) => s + (r._scores?.composite || 0), 0) / selected.length).toFixed(3) : 0,
        synthesis_ms: elapsed
    };

    console.log(`[Stage 2] Complete in ${elapsed}ms: ${stats.final} risks, avg quality ${stats.avgQuality}`);
    return { risks: selected, borderline, stats };
}

// OPTIMIZED: Keywords pre-computed, just use them
function clusterRisksOptimized(risks) {
    const clusters = [];
    const assigned = new Set();
    const threshold = RISK_PIPELINE_CONFIG.synthesis.clusterSimilarity;

    for (let i = 0; i < risks.length; i++) {
        if (assigned.has(i)) continue;

        const cluster = [risks[i]];
        assigned.add(i);
        const kwA = risks[i]._keywords;

        for (let j = i + 1; j < risks.length; j++) {
            if (assigned.has(j)) continue;
            if (risks[i].type !== risks[j].type) continue; // Quick type check first

            // OPTIMIZATION: Use pre-computed keywords
            const kwB = risks[j]._keywords;
            const intersection = [...kwA].filter(w => kwB.has(w)).length;
            const union = new Set([...kwA, ...kwB]).size;
            const jaccard = union > 0 ? intersection / union : 0;

            if (jaccard > threshold) {
                cluster.push(risks[j]);
                assigned.add(j);
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

// OPTIMIZATION: Hoist stopwords (already done at module level)
function extractKeywords(text) {
    return (text || '').toLowerCase()
        .replace(/[^a-z\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3 && !STOPWORDS.has(w));
}

function scoreRisk(risk, metrics) {
    const specificity = scoreSpecificity(risk);
    const grounding = scoreGrounding(risk, metrics);
    const completeness = scoreCompleteness(risk);
    const severity = calculateSeverity(risk);
    const confidence = (typeof risk.confidence === 'number') ? risk.confidence : 0.5;

    const composite = specificity * 0.25 + grounding * 0.30 + completeness * 0.20 +
        severity * 0.15 + confidence * 0.10;

    return { specificity, grounding, completeness, severity, confidence, composite };
}

function scoreSpecificity(risk) {
    let score = 0;
    const text = `${risk.name || ''} ${risk.description || ''} ${risk.project_specific_justification || ''}`.toLowerCase();

    if (/\d+\s*(day|week|month|hour|%|percent|km|mile|mw|ton|usd|\$)/i.test(text)) score += 0.2;
    if (/compressor|reactor|cracker|furnace|column|vessel|pump|turbine|generator|transformer|switchgear/.test(text)) score += 0.15;
    if (/commissioning|startup|fabrication|erection|excavation|piling|hydro|loop/.test(text)) score += 0.1;

    const justification = risk.project_specific_justification || '';
    if (justification.length > 80) score += 0.25;
    else if (justification.length > 40) score += 0.15;

    if (risk.data_citations?.length > 0) score += 0.15;
    if (/contractor|vendor|supplier|regulator|agency|utility|epc|owner/.test(text)) score += 0.1;

    return Math.min(1, score);
}

// HIGH IMPACT: Stronger location scoring
function scoreGrounding(risk, metrics) {
    let score = 0;
    const text = `${risk.name || ''} ${risk.description || ''} ${risk.project_specific_justification || ''}`.toLowerCase();

    // Sector relevance
    const sectorWords = (metrics.sector || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (sectorWords.some(w => text.includes(w))) score += 0.15;

    // FIXED: Allow 2-char codes (US, UK, DE, FR, JP, CN, AU, IN, etc.)
    const region = (metrics.region || '').toLowerCase();
    const country = (metrics.country || '').toLowerCase();
    if (region && region.length >= 2 && text.includes(region)) score += 0.25;
    if (country && country.length >= 2 && text.includes(country)) score += 0.2;

    // Category mappings
    if (risk.categories?.length > 0) score += 0.15;
    if (risk.categories?.length > 2) score += 0.1;
    if (risk.mapping_reasoning?.length > 30) score += 0.1;
    if (risk.source) score += 0.05;

    return Math.min(1, score);
}

function scoreCompleteness(risk) {
    let score = 0;
    if (risk.name?.length > 10) score += 0.15;
    if (risk.type) score += 0.1;
    if (risk.description?.length > 30) score += 0.15;
    if (typeof risk.probability === 'number') score += 0.1;
    if (typeof risk.cost_impact === 'number') score += 0.1;
    if (typeof risk.schedule_impact === 'number') score += 0.1;
    if (risk.mitigation_strategies?.length > 0) score += 0.15;
    if (risk.mitigation_strategies?.length >= 2) score += 0.1;
    if (risk.early_warning_indicators?.length > 0) score += 0.1;
    return Math.min(1, score);
}

function calculateSeverity(risk) {
    const prob = Number(risk.probability) || 0.5;
    const cost = Number(risk.cost_impact) || 0.5;
    const sched = Number(risk.schedule_impact) || 0.5;
    return prob * Math.max(cost, sched);
}

function mergeClusters(cluster) {
    if (cluster.length === 1) return cluster[0];

    cluster.sort((a, b) => (b._scores?.composite || 0) - (a._scores?.composite || 0));
    const best = { ...cluster[0] };

    const cfg = RISK_PIPELINE_CONFIG.synthesis;
    const mitigations = new Set(best.mitigation_strategies || []);
    const indicators = new Set(best.early_warning_indicators || []);
    const categories = new Set(best.categories || []);

    cluster.slice(1).forEach(other => {
        (other.mitigation_strategies || []).forEach(m => mitigations.add(m));
        (other.early_warning_indicators || []).forEach(i => indicators.add(i));
        (other.categories || []).forEach(c => categories.add(c));
    });

    best.mitigation_strategies = [...mitigations].slice(0, cfg.maxMergedMitigations);
    best.early_warning_indicators = [...indicators].slice(0, cfg.maxMergedIndicators);
    best.categories = [...categories];
    best._mergedCount = cluster.length;

    return best;
}

// HIGH IMPACT: Single pass with diversity penalty
function selectWithCoverageAndDiversity(sorted, calibration) {
    const cfg = RISK_PIPELINE_CONFIG.synthesis;
    const target = calibration.targets.final;
    const requiredTypes = new Set(calibration.requiredTypes);

    const selected = [];
    const borderline = [];
    const coveredTypes = new Set();
    const selectedKeywords = new Set(); // Track keywords for diversity

    // OPTIMIZED: Single pass with deferred low-quality risks
    const deferred = [];

    for (const risk of sorted) {
        if (selected.length >= target) break;

        const quality = risk._scores?.composite || 0;
        const needsType = requiredTypes.has(risk.type) && !coveredTypes.has(risk.type);

        // FIXED: Gradient diversity penalty instead of binary jump
        // Was: overlap > 5 ? 0.15 : 0 (binary)
        // Now: proportional penalty capped at 0.2
        const riskKeywords = risk._keywords || new Set();
        const overlap = [...riskKeywords].filter(w => selectedKeywords.has(w)).length;
        const diversityPenalty = Math.min(overlap * 0.025, 0.2);  // Smooth gradient
        const adjustedQuality = quality - diversityPenalty;

        // FIXED: Lower discard threshold from 0.2 to 0.1
        if (adjustedQuality >= cfg.qualityThreshold || needsType) {
            selected.push(risk);
            coveredTypes.add(risk.type);
            riskKeywords.forEach(w => selectedKeywords.add(w));

            if (quality < cfg.qualityThreshold) {
                borderline.push(risk.id);
            }
        } else if (quality > 0.1) {  // Was 0.2 - now keeps more marginal risks
            // Defer low-quality but not terrible risks
            deferred.push(risk);
        }
    }

    // Fill remaining slots from deferred
    for (const risk of deferred) {
        if (selected.length >= target) break;
        selected.push(risk);
        borderline.push(risk.id);
    }

    return { selected, borderline };
}

// =============================================================================
// STAGE 3: VALIDATION (unchanged)
// =============================================================================

async function executeValidation(risks, borderlineIds, calibration) {
    const cfg = RISK_PIPELINE_CONFIG.validation;

    if (!cfg.enabled || borderlineIds.length === 0) {
        return risks;
    }

    const borderlineRisks = risks.filter(r => borderlineIds.includes(r._originalId || r.id));
    if (borderlineRisks.length === 0) return risks;

    console.log(`[Stage 3] Validating ${Math.min(borderlineRisks.length, cfg.maxValidationBatch)} borderline risks...`);

    try {
        const toValidate = borderlineRisks.slice(0, cfg.maxValidationBatch);

        const response = await fetch('/OpenAI/ValidateRisks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'validate_risks',
                risks: toValidate.map(r => ({
                    id: r.id, name: r.name, type: r.type, description: r.description,
                    probability: r.probability, cost_impact: r.cost_impact, schedule_impact: r.schedule_impact,
                    project_specific_justification: r.project_specific_justification
                })),
                project: {
                    sector: calibration.metrics.sector, region: calibration.metrics.region,
                    country: calibration.metrics.country
                }
            })
        });

        if (!response.ok) return risks;

        const result = await response.json();
        if (result.validations) {
            for (const v of result.validations) {
                const risk = risks.find(r => r.id === v.id);
                if (risk) {
                    if (v.action === 'discard') risk._discarded = true;
                    else if (v.action === 'enhance' && v.enhanced) Object.assign(risk, v.enhanced);
                }
            }
            return risks.filter(r => !r._discarded);
        }
        return risks;
    } catch (error) {
        console.warn('[Stage 3] Validation failed:', error.message);
        return risks;
    }
}

// =============================================================================
// FALLBACK
// =============================================================================

async function executeFallback(nodes, links, meta) {
    console.log('[Fallback] Using single-shot generation...');
    const payload = typeof buildExternalRiskPayload === 'function'
        ? buildExternalRiskPayload(nodes, links, meta) : { project: meta };

    const response = await fetch(RISK_PIPELINE_CONFIG.fallback.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`Fallback failed: ${response.status}`);
    return await response.json();
}

// =============================================================================
// MAIN ORCHESTRATOR
// =============================================================================

async function getExternalRiskRegisterCalibrated(nodes, links, meta = {}, options = {}) {
    const startTime = performance.now();

    try {
        const built = typeof buildMetaFromState === 'function'
            ? buildMetaFromState(window.cybereumState || {}, nodes || []) : {};
        const mergedMeta = { ...built, ...meta };

        const calibration = calibrateRiskPipeline(nodes, mergedMeta);
        const payload = buildDivergentPayload(nodes, links, mergedMeta, calibration);
        const generatedResult = await executeDivergentGeneration(payload, calibration);

        let synthesisResult;
        if (calibration.pipelineDepth === 'LIGHT') {
            synthesisResult = {
                risks: generatedResult.risk_register || [],
                borderline: [],
                stats: { generated: generatedResult.risk_register?.length || 0, final: generatedResult.risk_register?.length || 0 }
            };
        } else {
            synthesisResult = executeConvergentSynthesis(generatedResult, calibration);
        }

        let finalRisks = synthesisResult.risks;
        if (calibration.pipelineDepth === 'DEEP' && options.validate !== false) {
            finalRisks = await executeValidation(synthesisResult.risks, synthesisResult.borderline, calibration);
        }

        // Cleanup internal properties
        finalRisks.forEach(risk => {
            delete risk._scores;
            delete risk._keywords;
            delete risk._originalId;
            delete risk._mergedCount;
            delete risk._validated;
        });

        const riskMappings = {};
        finalRisks.forEach(risk => {
            riskMappings[risk.id] = {
                categories: risk.categories || [],
                critical_path_only: false,
                impact_factor: Math.max(risk.cost_impact || 0.5, risk.schedule_impact || 0.5)
            };
        });

        const externalSignalSnapshot = normalizeExternalSignalSnapshot(generatedResult.external_signal_snapshot);
        const elapsed = Math.round(performance.now() - startTime);
        console.log(`[Pipeline] Complete in ${elapsed}ms`);

        return {
            risk_register: finalRisks,
            risk_mappings: riskMappings,
            external_signal_snapshot: externalSignalSnapshot,
            pipeline: {
                depth: calibration.pipelineDepth,
                complexity: calibration.complexity.score,
                target: calibration.targets.final,
                actual: finalRisks.length,
                elapsed_ms: elapsed
            },
            synthesis_stats: synthesisResult.stats
        };

    } catch (error) {
        console.error('[Pipeline] Error:', error.message);

        if (RISK_PIPELINE_CONFIG.fallback.enabled) {
            try {
                const fallbackResult = await executeFallback(nodes, links, meta);
                fallbackResult.external_signal_snapshot = normalizeExternalSignalSnapshot(fallbackResult.external_signal_snapshot);
                fallbackResult.pipeline = { depth: 'FALLBACK', error: error.message };
                return fallbackResult;
            } catch (e) {
                console.error('[Fallback] Also failed:', e.message);
            }
        }

        return { risk_register: [], risk_mappings: {}, external_signal_snapshot: null, error: error.message, pipeline: { depth: 'FAILED' } };
    }
}



function runSoon(fn) {
    if ('requestIdleCallback' in window) return requestIdleCallback(fn, { timeout: 2000 });
    return setTimeout(fn, 0);
}

// Build `meta` from cybereum state + nodes, fast and safe.
function buildMetaFromState(state, nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const startNode = (state && state.startNode) || (list.find(n => n.ID === "0")) || list[0] || {};
    const endNode =
        (state && state.endNode) ||
        list.find(n => typeof n.Name === "string" && /end\s*milestone/i.test(n.Name)) ||
        list.reduce((best, n) => {
            const nf = new Date(n && n.Finish ? n.Finish : 0).getTime();
            const bf = new Date(best && best.Finish ? best.Finish : 0).getTime();
            return nf > bf ? n : best;
        }, null);

    const totalHours = list.reduce((sum, n) => {
        const dur = Number(n && n.Duration) || 0;
        const tu = (n && n.TimeUnits ? String(n.TimeUnits) : "Hours").toLowerCase();
        let hours = dur;
        if (tu.includes("day")) hours = dur * 8;
        else if (tu.includes("week")) hours = dur * 40;
        else if (tu.includes("month")) hours = dur * 160;
        return sum + (isFinite(hours) ? hours : 0);
    }, 0);

    const costRate = Number(startNode && startNode.CostRate) || 0;
    const capexUSD = Math.max(0, costRate * totalHours);

    const startTs = new Date(
        startNode && (startNode.Start || startNode.riskAdjustedStart || startNode.predictedStart || startNode.Finish)
    ).getTime();
    const endTs = new Date(
        endNode && (endNode.Finish || endNode.riskAdjustedEnd || endNode.predictedEnd || startTs)
    ).getTime();
    const msPerMonth = 1000 * 60 * 60 * 24 * 30.4375;
    const scheduleMonths = startTs && endTs ? Math.max(0, (endTs - startTs) / msPerMonth) : 0;

    const avgPct =
        list.length > 0
            ? list.reduce((s, n) => s + (Number(n && n.PercentComplete) || 0), 0) / list.length
            : Number(startNode && startNode.PercentComplete) || 0;

    let phase = "Development";
    if (avgPct >= 90) phase = "Closeout";
    else if (avgPct >= 70) phase = "Commissioning";
    else if (avgPct >= 30) phase = "Construction";
    else if (avgPct >= 10) phase = "Engineering";

    // NEW: Enhanced location handling with fallbacks
    // Priority: 1) New structured data, 2) StartNode data, 3) State data, 4) Defaults

    // Country - prioritize structured data
    const countryCode = (startNode && startNode.Country) ||
        (state && state.project && state.project.country) ||
        "General";

    const countryName = (startNode && startNode.CountryName) ||
        (state && state.project && state.project.countryName) ||
        countryCode;

    // Region - prioritize structured data
    const region = (startNode && startNode.Region) ||
        (state && state.project && state.project.region) ||
        (startNode && startNode.Location) ||  // Fallback to old Location field
        "General";

    // For backward compatibility, also construct a location string
    const location = startNode && startNode.Location
        ? startNode.Location
        : (region && countryName && region !== "General"
            ? `${region}, ${countryName}`
            : countryName);

    // Background and project info
    const bgFromState = state && state.project && typeof state.project.background === 'string'
        ? state.project.background.trim()
        : "";
    const bgFromNode = typeof startNode.ProjectBackground === 'string'
        ? startNode.ProjectBackground.trim()
        : "";
    const background = bgFromState || bgFromNode || "";

    const projectName =
        (state && state.project && state.project.name) ||
        startNode.ProjectName ||
        "Unnamed Project";

    // Budget & currency with safe parsing
    const safeParseMoney = (val) => {
        if (typeof parseMoney === 'function') return parseMoney(val);
        const n = typeof val === 'string' ? Number(val.replace(/[^0-9.\-]/g, '')) : Number(val);
        return Number.isFinite(n) ? n : null;
    };

    const budgetRaw =
        (state && state.project && state.project.budgetRaw) ||
        (startNode.ProjectBudget || "");
    const budget = (state && state.project && typeof state.project.budget === 'number')
        ? state.project.budget
        : safeParseMoney(budgetRaw);
    const budgetCurrency =
        (state && state.project && state.project.budgetCurrency) ||
        startNode.Currency ||
        "USD";

    return {
        sector: startNode && startNode.Segment ? startNode.Segment : "General",
        region: region,                    // NEW: Specific region/state
        country: countryCode,              // NEW: ISO country code
        countryName: countryName,          // NEW: Full country name
        location: location,                // Backward compatible full location string
        phase,
        background,
        project: {
            name: projectName,
            budget_usd: budget,
            budget_raw: String(budgetRaw || ""),
            currency: budgetCurrency
        },
        baseline: {
            capex_usd: Math.round(capexUSD),
            schedule_months: Math.round(scheduleMonths)
        }
    };
}

// One-pass, O(n) selector for non-critical activities related to external risks
function deriveNonCriticalRelatedActivities(nodes, meta = {}, opts = {}) {
    const list = Array.isArray(nodes) ? nodes : [];
    const {
        maxReturn = 120,
        minSlackHours = 8,                  // exclude near-critical by slack
        probCut = 0.30,                     // overrun_probability cutoff
        uncertCut = 0.25,                   // scheduleUncertainty cutoff
        durRatioCut = 1.25,                 // riskAdjustedDuration or predictedDuration ratio
        riskOutlierTopPct = 0.10           // drop top X% ComputedRiskScore as "outliers"
    } = opts;

    if (!list.length) return { candidates: [], duration_outliers: [], summary: { total: 0 } };

    // Precompute thresholds
    const scores = list.map(n => Number(n?.ComputedRiskScore) || 0).sort((a, b) => a - b);
    const idx = Math.max(0, Math.floor((1 - riskOutlierTopPct) * (scores.length - 1)));
    const riskOutlierFloor = scores[idx] || 0;

    // External-risk proxy keyword map (fast regexes, case-insensitive)
    const rx = {
        permit: /(permit|approval|license|consent|boem|fema|nrc|fhwa|fapro|nepa|ceqa|npdes)\b/i,
        procurement: /(procure|purchase|bid(s|ding)?|rf[pi]|tender|quote|long[-\s]?lead|release bid documents)/i,
        utility: /(utility|interconnect|tie[-\s]?in|transformer|switchgear|relocat(e|ion))/i,
        env: /(survey|wetland|habitat|environment|esa|rsa|delineation|icra|stormwater|erosion)/i,
        public: /(public|hearing|stakeholder|outreach|information meeting|comment|\bDP(?:H|W)\b)/i,
        weather: /(pav(e|ing)|concrete|foundation|earthwork|excavat(e|ion)|in[-\s]?water|dredg(e|ing))/i,
        finance: /(fund(ing)?|grant|bond|insurance|rate case|concurrence|certificate of need)/i,
        standards: /(code|standard|aashto|part 139|ptc|phmsa|ferc|nrc|boem|tsa|uscg)/i
    };

    // Quick helpers
    const num = v => Number(v) || 0;
    const ratio = (a, b) => (num(b) > 0 ? num(a) / num(b) : 0);
    const isCriticalish = n =>
        Boolean(n?.isOnCriticalPath) ||
        (Number.isFinite(+n?.slack) ? +n.slack < minSlackHours : false) ||
        Boolean(n?.isNearCritical);
    const isRiskOutlier = n =>
        (num(n?.ComputedRiskScore) >= riskOutlierFloor) || Boolean(n?.isOnOutlierPath);

    const duration_outliers = [];
    const candidatesRaw = [];

    for (const n of list) {
        const name = String(n?.Name || "");
        if (!name) continue;

        // Duration outliers (capture regardless of criticality, but tag)
        const dur = Math.max(1, num(n?.Duration));
        const ratRA = Number.isFinite(num(n?.riskAdjustedDuration)) ? ratio(n?.riskAdjustedDuration, dur) : 0;
        const ratPR = Number.isFinite(num(n?.predictedDuration)) ? ratio(n?.predictedDuration, dur) : 0;
        const isDurOut =
            (ratRA && ratRA >= durRatioCut) ||
            (ratPR && ratPR >= durRatioCut);

        if (isDurOut) {
            duration_outliers.push({
                id: String(n?.ID ?? ""),
                name,
                ratio_risk_adjusted: +ratRA.toFixed(3),
                ratio_predicted: +ratPR.toFixed(3),
                scheduleUncertainty: +num(n?.scheduleUncertainty).toFixed(3),
                overrun_probability: +num(n?.overrun_probability).toFixed(3),
                critical: Boolean(n?.isOnCriticalPath),
                outlier_path: Boolean(n?.isOnOutlierPath)
            });
        }

        // We only want NON-critical & NON-outlier path for the candidate set
        if (isCriticalish(n) || isRiskOutlier(n)) continue;

        // External-risk proxies by name + early-warning stats
        const nameHit =
            rx.permit.test(name) || rx.procurement.test(name) || rx.utility.test(name) ||
            rx.env.test(name) || rx.public.test(name) || rx.weather.test(name) ||
            rx.finance.test(name) || rx.standards.test(name);

        const statHit =
            num(n?.overrun_probability) >= probCut ||
            num(n?.scheduleUncertainty) >= uncertCut;

        if (!(nameHit || statHit)) continue;

        // Lightweight score to rank
        const score =
            (nameHit ? 0.6 : 0) +
            Math.min(0.2, num(n?.overrun_probability)) +
            Math.min(0.2, num(n?.scheduleUncertainty));

        candidatesRaw.push({
            id: String(n?.ID ?? ""),
            name,
            start: n?.Start || n?.predictedStart || null,
            finish: n?.Finish || n?.predictedEnd || null,
            slack: num(n?.slack),
            overrun_probability: +num(n?.overrun_probability).toFixed(3),
            scheduleUncertainty: +num(n?.scheduleUncertainty).toFixed(3),
            riskAdjustedDurationRatio: +ratRA.toFixed(3),
            predictedDurationRatio: +ratPR.toFixed(3),
            // NEW: Flag weather-sensitive activities
            weather_sensitive: rx.weather.test(name) || rx.env.test(name),
            reason: nameHit
                ? "Matches external-risk proxy keywords"
                : "Elevated overrun probability / uncertainty",
            score: +score.toFixed(3)
        });
    }

    // Rank and trim
    candidatesRaw.sort((a, b) => b.score - a.score || a.slack - b.slack);
    const candidates = candidatesRaw.slice(0, maxReturn);

    return {
        candidates,
        duration_outliers: duration_outliers
            .sort((a, b) =>
                (b.ratio_risk_adjusted || b.ratio_predicted || 0) -
                (a.ratio_risk_adjusted || a.ratio_predicted || 0)
            )
            .slice(0, maxReturn),
        summary: {
            total: list.length,
            selected: candidates.length,
            duration_outliers: duration_outliers.length,
            sector: meta?.sector || "General",
            region: meta?.region || "General",
            country: meta?.country || "General"
        }
    };
}


function renderRowsInChunks({ rows, container, makeRowEl, chunkSize = 50 }) {
    let i = 0;
    function step() {
        const frag = document.createDocumentFragment();
        const end = Math.min(i + chunkSize, rows.length);
        for (; i < end; i++) frag.appendChild(makeRowEl(rows[i], i));
        container.appendChild(frag);
        if (i < rows.length) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

async function getExternalRisk(nodes, links, projectid) {
    {
        // Store projectId for downstream use (e.g., mitigation persistence)
        window.cybereumState = window.cybereumState || {};
        window.cybereumState.projectId = projectid;

        nodes.forEach((node) => {
            node.Start = new Date(node.Start);
            node.Finish = new Date(node.Finish);
            node.riskAdjustedStart = new Date(node.riskAdjustedStart);
            node.riskAdjustedEnd = new Date(node.riskAdjustedEnd);
        });

        const meta = buildMetaFromState(window.cybereumState, nodes);
        const { enrichedNodes, risk_register, external_signal_snapshot } = await assessProjectExternalRisks(nodes, links, meta);
        window.cybereumState.externalSignalSnapshot = normalizeExternalSignalSnapshot(external_signal_snapshot);
        const mergedRiskRegister = mergeRiskRegisters(getUserRiskRegisterInputs(), risk_register || []);
        const normalizedRiskRegister = mergedRiskRegister.map((r, i) => normalizeRiskRecord(r, i + 1));

        // Sync enriched external risk data back to original node objects
        // (applyRisksToActivitiesIntelligent clones, so originals need updating)
        const enrichedById = new Map(enrichedNodes.map(n => [String(n.ID), n]));
        nodes.forEach(n => {
            const enriched = enrichedById.get(String(n.ID));
            if (enriched) {
                n.externalRisks = enriched.externalRisks;
                n.externalRiskScore = enriched.externalRiskScore;
                n.externalCostRisk = enriched.externalCostRisk;
                n.externalScheduleRisk = enriched.externalScheduleRisk;
                n.combinedRiskScore = enriched.combinedRiskScore;
            }
        });

        // Keep global state in sync (same array ref)
        window.cybereumState.nodes = nodes;

        // let any listeners know risks are ready
        document.dispatchEvent(new CustomEvent('externalRisksReady', {
            detail: { count: normalizedRiskRegister ? normalizedRiskRegister.length : 0 }
        }));


        // STEP 1: Check if we got risks back from API
        console.log("RScores === STEP 1: API RESPONSE ===");
        console.log(`RScores Risk register length: ${normalizedRiskRegister.length}`);
        if (normalizedRiskRegister.length > 0) {
            console.log("RScores First risk:", normalizedRiskRegister[0]);
        } else {
            console.log("RScores NO RISKS RETURNED - Check API logs");
        }

        const nodesWithExtRisk = enrichedNodes.filter(n => n.externalRisks && n.externalRisks.length > 0);

        if (nodesWithExtRisk.length > 0) {
            const sample = nodesWithExtRisk[0];
            console.log("RScores Sample enriched node:", {
                id: sample.ID,
                name: sample.Name,
                externalRisks: sample.externalRisks.length,
                externalRiskScore: sample.externalRiskScore
            });
        } else {
            console.log("RScores NO NODES WERE ENRICHED");
            // Check if the problem is in risk register or node application
            if (normalizedRiskRegister.length > 0) {
                console.log("RScores Risk register exists but nodes not enriched - check matching logic");
            }
        }

        // Console print all nodes with external risks
        const nodesWithExternalRisks = enrichedNodes.filter(node =>
            node.externalRisks && node.externalRisks.length > 0
        );

        nodesWithExternalRisks.forEach((node, index) => {
            console.log(`\n${index + 1}. Activity ${node.ID}: ${node.Name}`);
            console.log(` RScores  Category: ${categorizeByName(String(node.Name || "").toLowerCase())}`);
            console.log(` RScores  Critical Path: ${node.isOnCriticalPath ? 'Yes' : 'No'}`);
            console.log(` RScores  Internal Risk: ${(node.riskScore || 0).toFixed(3)}`);
            console.log(` RScores  External Risk Score: ${(node.externalRiskScore || 0).toFixed(3)}`);
            console.log(` RScores  External Cost Risk: ${(node.externalCostRisk || 0).toFixed(3)}`);
            console.log(` RScores  External Schedule Risk: ${(node.externalScheduleRisk || 0).toFixed(3)}`);
            console.log(` RScores  Number of External Risks: ${node.externalRisks.length}`);

            // List each external risk affecting this node
            node.externalRisks.forEach((risk, riskIndex) => {
                console.log(` RScores    Risk ${riskIndex + 1}: ${risk.name} (${risk.type})`);
                console.log(` RScores      Influence Score: ${risk.influence_score.toFixed(3)}`);
                console.log(` RScores      Weighted Cost Impact: ${risk.weighted_cost_impact.toFixed(3)}`);
                console.log(` RScores      Weighted Schedule Impact: ${risk.weighted_schedule_impact.toFixed(3)}`);
            });
        });

        // Summary statistics
        if (nodesWithExternalRisks.length > 0) {
            const avgExternalRisk = nodesWithExternalRisks.reduce((sum, node) =>
                sum + (node.externalRiskScore || 0), 0) / nodesWithExternalRisks.length;

            const maxExternalRisk = Math.max(...nodesWithExternalRisks.map(node =>
                node.externalRiskScore || 0));

            const criticalPathAffected = nodesWithExternalRisks.filter(node =>
                node.isOnCriticalPath).length;

            console.log(`\n=== EXTERNAL RISK SUMMARY ===`);
            console.log(`RScores Average External Risk Score: ${avgExternalRisk.toFixed(3)}`);
            console.log(`RScores Maximum External Risk Score: ${maxExternalRisk.toFixed(3)}`);
            console.log(`RScores Critical Path Activities Affected: ${criticalPathAffected}`);
        }

        window.cybereumState = window.cybereumState || {};
        window.cybereumState.userRiskRegister = normalizedRiskRegister;

        // Propagate combined risk scores into riskScore and refresh Risk Matrix + charts
        propagateExternalRiskAndRefreshCharts(nodes, links);

        populateExternalRiskTables(enrichedNodes, normalizedRiskRegister);
        // Display mitigation activities
        // AFTER your working risk assessment, add mitigations separately
        if (normalizedRiskRegister && normalizedRiskRegister.length > 0) {
            console.log("Getting mitigation activities...");
            try {
                let mitigationResult = window.cybereumState.mitigationResult;

                // Fallback: If somehow not available, generate it now
                if (!mitigationResult) {
                    console.warn("Mitigation result not found in cache, generating now...");
                    try {
                        mitigationResult = await generateMitigationActivities(normalizedRiskRegister, nodes, meta);
                        window.cybereumState.mitigationResult = mitigationResult;
                    } catch (error) {
                        console.error("Mitigation generation failed:", error);
                        mitigationResult = null;
                    }
                }

                // Display if we have mitigation activities
                if (mitigationResult && mitigationResult.mitigation_activities && mitigationResult.mitigation_activities.length > 0) {
                    console.log(`Generated ${mitigationResult.mitigation_activities.length} mitigation activities`);

                    // Display mitigation activities
                    displayMitigationActivities(mitigationResult.mitigation_activities, normalizedRiskRegister);

                    const result = nodesWithExternalRisks.map(item => ({
                        ID: item.ID,
                        externalRisks: item.externalRisks.map(i => ({
                            id: i.id,
                            influence_score: i.influence_score || 0,
                            weighted_cost_impact: i.weighted_cost_impact || 0,
                            weighted_schedule_impact: i.weighted_schedule_impact || 0
                        })),
                        externalRiskScore: item.externalRiskScore,
                        externalCostRisk: item.externalCostRisk,
                        externalScheduleRisk: item.externalScheduleRisk,
                        combinedRiskScore: (typeof item.combinedRiskScore === 'number') ? item.combinedRiskScore : 0,
                        externalRiskConfidence: (typeof item.externalRiskConfidence === 'number') ? item.externalRiskConfidence : 0.5
                    }));

                    var externalRiskData = { 'projectid': projectid, 'risk_register': JSON.stringify(normalizedRiskRegister), 'mitigationResult': JSON.stringify(mitigationResult), 'nodes': JSON.stringify(result) };
                    $.ajax({
                        type: "POST",
                        url: "/Project/SaveExternalRisks",
                        data: JSON.stringify(externalRiskData),
                        contentType: "application/json; charset=utf-8",
                        dataType: "json",
                        success: function (result) {
                            alert("External Risks updated successfully");
                            //loadingIndicator.style.display = 'none';
                        },
                        error: function (response) {
                            alert(response.responseText);
                            //loadingIndicator.style.display = 'none';
                        }
                    });

                    // Optionally integrate into schedule
                    // nodes = integrateMitigationActivities(nodes, mitigationResult, meta);
                }
            } catch (error) {
                console.error("Mitigation generation failed:", error);
            }
        }
    }
}

function normalizeRiskRecord(risk, fallbackId) {
    const normalized = { ...(risk || {}) };
    normalized.id = normalized.id || fallbackId;
    normalized.name = normalized.name || `Risk ${normalized.id}`;
    normalized.type = normalized.type || 'Execution';
    normalized.source = normalized.source || 'LLM';
    normalized.manifestation_mechanism = normalized.manifestation_mechanism
        || normalized.mechanism
        || `${normalized.name} can manifest through decision latency, productivity degradation, and downstream rework on successor activities.`;

    const taxonomy = normalized.taxonomy || {};
    normalized.taxonomy = normalizeTaxonomyFields({
        domain: taxonomy.domain || (normalized.source === 'LLM' ? 'External' : 'Cross-Cutting'),
        category: taxonomy.category || normalized.type || 'Execution',
        sub_category: taxonomy.sub_category || taxonomy.subCategory || 'General',
        driver: taxonomy.driver || normalized.risk_driver || 'Multi-factor'
    });
    normalized.taxonomyLabel = `${normalized.taxonomy.domain} / ${normalized.taxonomy.category} / ${normalized.taxonomy.sub_category}`;
    normalized.affected_activity_ids = Array.isArray(normalized.affected_activity_ids)
        ? normalized.affected_activity_ids.map(v => String(v)).filter(Boolean)
        : [];
    const mitigationTips = Array.isArray(normalized.mitigation_strategies) ? normalized.mitigation_strategies.filter(Boolean) : [];
    const ewi = Array.isArray(normalized.early_warning_indicators) ? normalized.early_warning_indicators.filter(Boolean) : [];
    const justification = String(normalized.project_specific_justification || '').trim();
    normalized.guidanceSummary = String(normalized.guidanceSummary || normalized.guidance || '').trim();
    if (!normalized.guidanceSummary) {
        const parts = [];
        if (justification) parts.push(`Why it matters: ${justification}`);
        if (mitigationTips.length) parts.push(`Mitigate via: ${mitigationTips.slice(0, 2).join('; ')}`);
        if (ewi.length) parts.push(`Watch for: ${ewi.slice(0, 2).join('; ')}`);
        normalized.guidanceSummary = parts.join(' | ');
    }

    return normalized;
}

function normalizeTaxonomyFields(taxonomy) {
    const normalized = { ...(taxonomy || {}) };
    const domainRaw = String(normalized.domain || 'Cross-Cutting').trim();
    const categoryRaw = String(normalized.category || 'Execution').trim();
    const subCategoryRaw = String(normalized.sub_category || normalized.subCategory || 'General').trim();

    const domainMap = {
        external: 'External Environment',
        internal: 'Project Delivery',
        'cross-cutting': 'Cross-Cutting',
        'cross cutting': 'Cross-Cutting',
        crosscutting: 'Cross-Cutting',
        user: 'Cross-Cutting'
    };

    const categoryMap = {
        execution: 'Execution & Constructability',
        technical: 'Technical & Design',
        commercial: 'Commercial & Supply Chain',
        procurement: 'Commercial & Supply Chain',
        supply: 'Commercial & Supply Chain',
        regulatory: 'Regulatory & Permitting',
        hse: 'HSE & Social License',
        safety: 'HSE & Social License',
        environmental: 'HSE & Social License',
        financial: 'Finance & Macro',
        cost: 'Finance & Macro',
        schedule: 'Schedule & Interfaces',
        interface: 'Schedule & Interfaces',
        stakeholder: 'Stakeholder & Governance',
        governance: 'Stakeholder & Governance',
        geopolitical: 'External Events',
        weather: 'External Events',
        security: 'External Events',
        'user seed': 'User-Seeded Signals'
    };

    const toTitle = (txt) => txt
        .toLowerCase()
        .split(/[\s_/.-]+/)
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

    const domainKey = domainRaw.toLowerCase();
    const categoryKey = categoryRaw.toLowerCase();

    const mappedDomain = domainMap[domainKey] || toTitle(domainRaw);
    const mappedCategory = categoryMap[categoryKey] || toTitle(categoryRaw);

    return {
        domain: mappedDomain,
        category: mappedCategory,
        sub_category: sanitizeSubCategoryLabel(subCategoryRaw),
        driver: String(normalized.driver || 'Multi-factor').trim() || 'Multi-factor'
    };
}

function sanitizeSubCategoryLabel(subCategoryRaw) {
    const raw = String(subCategoryRaw || '').trim();
    if (!raw) return 'General';

    const generic = new Set(['general', 'other', 'misc', 'miscellaneous', 'na', 'n/a', 'unknown']);
    if (generic.has(raw.toLowerCase())) return 'General';

    return raw;
}

function inferSubCategoryFromRisk(risk, fallbackCategory) {
    const name = String(risk?.name || '').toLowerCase();
    const desc = String(risk?.description || '').toLowerCase();
    const type = String(risk?.type || '').toLowerCase();
    const text = `${name} ${desc} ${type}`;

    const patterns = [
        { label: 'Permitting Delays', test: /(permit|approval|licen|nrc|environmental review)/ },
        { label: 'Community & Stakeholder Opposition', test: /(community|stakeholder|opposition|public hearing|social license)/ },
        { label: 'Interconnection / Utility Constraints', test: /(interconnect|utility|grid|substation|transmission)/ },
        { label: 'Long-Lead Equipment', test: /(long-?lead|transformer|switchgear|generator|compressor|reactor|vessel)/ },
        { label: 'Labor Availability & Productivity', test: /(labor|workforce|craft|productivity|crew|skilled)/ },
        { label: 'Extreme Weather / Force Majeure', test: /(weather|hurricane|storm|flood|freeze|force majeure|heat)/ },
        { label: 'Design Maturity & Rework', test: /(design|engineering|rework|interface|constructability|drawing)/ },
        { label: 'Commercial / Claims Exposure', test: /(claim|change order|commercial|contract|dispute|lds?)/ },
        { label: 'Commodity & Cost Volatility', test: /(commodity|inflation|escalation|pricing|cost volatility)/ },
        { label: 'Cyber / Security Threats', test: /(cyber|security|breach|threat|ransom)/ }
    ];

    for (const p of patterns) {
        if (p.test.test(text)) return p.label;
    }

    if (fallbackCategory && fallbackCategory !== 'General') return `${fallbackCategory} Risk`;
    return 'General';
}


function buildRiskCoverageAudit(enrichedNodes, riskRegister, mitigationResult) {
    const risks = Array.isArray(riskRegister) ? riskRegister.map((r, i) => normalizeRiskRecord(r, i + 1)) : [];
    const nodes = Array.isArray(enrichedNodes) ? enrichedNodes : [];
    const mitigationActivities = Array.isArray(mitigationResult?.mitigation_activities) ? mitigationResult.mitigation_activities : [];

    const mappedRiskIds = new Set();
    nodes.forEach(node => {
        (node.externalRisks || []).forEach(r => mappedRiskIds.add(String(r.id)));
    });

    const mitigatedRiskIds = new Set();
    mitigationActivities.forEach(m => {
        const id = m?.risk_id;
        if (id !== undefined && id !== null && String(id).trim()) {
            mitigatedRiskIds.add(String(id));
        }
    });

    const mitigationNameSet = new Set(
        mitigationActivities
            .map(m => String(m.risk_name || m.risk || '').trim().toLowerCase())
            .filter(Boolean)
    );

    const unmappedRisks = [];
    const unmitigatedRisks = [];

    risks.forEach(r => {
        const id = String(r.id);
        const mappedByActivityList = (r.affected_activity_ids || []).length > 0;
        const mappedByNodes = mappedRiskIds.has(id);
        if (!mappedByActivityList && !mappedByNodes) unmappedRisks.push(r);

        const riskName = String(r.name || '').trim().toLowerCase();
        const hasMitigation = mitigatedRiskIds.has(id) || (riskName && mitigationNameSet.has(riskName));
        if (!hasMitigation) unmitigatedRisks.push(r);
    });

    return {
        totalRisks: risks.length,
        mappedRisks: risks.length - unmappedRisks.length,
        mitigatedRisks: risks.length - unmitigatedRisks.length,
        unmappedRisks,
        unmitigatedRisks,
        internalCoverageNote: 'Internal risks are currently activity-native scores and do not yet have a normalized internal risk register + mitigation linkage in this module.'
    };
}

function renderRiskCoverageSummary(enrichedNodes, riskRegister, mitigationResult) {
    const container = document.getElementById('riskCoverageSummary');
    if (!container) return;

    const audit = buildRiskCoverageAudit(enrichedNodes, riskRegister, mitigationResult);
    if (!audit.totalRisks) {
        container.innerHTML = '<em>No external risks to audit yet.</em>';
        return;
    }

    const pct = (part, total) => total > 0 ? `${Math.round((part / total) * 100)}%` : '0%';
    const normalizedRisks = (Array.isArray(riskRegister) ? riskRegister : []).map((r, i) => normalizeRiskRecord(r, i + 1));
    const domainBreakdown = new Map();
    const categoryBreakdown = new Map();
    normalizedRisks.forEach(r => {
        const t = normalizeTaxonomyFields(r.taxonomy || {});
        const domain = t.domain || 'Cross-Cutting';
        const category = t.category || 'Execution & Constructability';
        domainBreakdown.set(domain, (domainBreakdown.get(domain) || 0) + 1);
        categoryBreakdown.set(category, (categoryBreakdown.get(category) || 0) + 1);
    });

    const top = (map, max = 3) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
    const topDomains = top(domainBreakdown, 2).map(([k, v]) => `${k} (${v})`).join('; ');
    const topCategories = top(categoryBreakdown, 3).map(([k, v]) => `${k} (${v})`).join('; ');
    const genericSubCategoryCount = normalizedRisks.filter(r => sanitizeSubCategoryLabel(r?.taxonomy?.sub_category) === 'General').length;

    const unmappedPreview = audit.unmappedRisks.slice(0, 3).map(r => r.name).join('; ');
    const unmitigatedPreview = audit.unmitigatedRisks.slice(0, 3).map(r => r.name).join('; ');
    const guidanceHighlights = normalizedRisks
        .map(r => ({ name: r.name, guidance: String(r.guidanceSummary || '').trim() }))
        .filter(x => x.guidance)
        .slice(0, 3)
        .map(x => `<li><strong>${escapeHtml(x.name)}:</strong> ${escapeHtml(x.guidance)}</li>`)
        .join('');

    container.innerHTML = `
        <ul>
            <li><strong>Activity linkage:</strong> ${audit.mappedRisks}/${audit.totalRisks} (${pct(audit.mappedRisks, audit.totalRisks)}) external risks mapped to activities.</li>
            <li><strong>Mitigation linkage:</strong> ${audit.mitigatedRisks}/${audit.totalRisks} (${pct(audit.mitigatedRisks, audit.totalRisks)}) external risks with an explicit mitigation activity.</li>
            ${topDomains ? `<li><strong>Dominant domains:</strong> ${escapeHtml(topDomains)}</li>` : ''}
            ${topCategories ? `<li><strong>Dominant categories:</strong> ${escapeHtml(topCategories)}</li>` : ''}
            ${genericSubCategoryCount ? `<li><strong>Taxonomy quality watch:</strong> ${genericSubCategoryCount}/${audit.totalRisks} risks are still generic and should be refined with project-specific sub-categories.</li>` : ''}
            ${guidanceHighlights ? `<li><strong>AI guidance highlights:</strong><ul>${guidanceHighlights}</ul></li>` : ''}
            ${audit.unmappedRisks.length ? `<li><strong>Unmapped risks:</strong> ${audit.unmappedRisks.length}${unmappedPreview ? ` (e.g., ${escapeHtml(unmappedPreview)})` : ''}</li>` : ''}
            ${audit.unmitigatedRisks.length ? `<li><strong>Unmitigated risks:</strong> ${audit.unmitigatedRisks.length}${unmitigatedPreview ? ` (e.g., ${escapeHtml(unmitigatedPreview)})` : ''}</li>` : ''}
            <li>${audit.internalCoverageNote}</li>
        </ul>`;
}

function ensureExternalRiskCoverage(enrichedNodes, riskRegister) {
    const nodes = Array.isArray(enrichedNodes) ? enrichedNodes : [];
    const risks = Array.isArray(riskRegister) ? riskRegister : [];
    if (!nodes.length || !risks.length) return;

    const mappedRiskIds = new Set();
    nodes.forEach(node => {
        (node.externalRisks || []).forEach(r => mappedRiskIds.add(String(r.id)));
    });

    risks.forEach(risk => {
        const riskId = String(risk.id);
        if (mappedRiskIds.has(riskId)) return;

        let bestNode = null;
        let bestScore = -1;
        for (const node of nodes) {
            const score = getBasicInfluenceScoreOptimized(node, risk);
            if (score > bestScore) {
                bestScore = score;
                bestNode = node;
            }
        }

        if (!bestNode) return;
        const influenceScore = Math.max(0.2, Math.min(1, bestScore > 0 ? bestScore : 0.2));
        bestNode.externalRisks = Array.isArray(bestNode.externalRisks) ? bestNode.externalRisks : [];
        bestNode.externalRisks.push({
            id: risk.id,
            name: risk.name,
            type: risk.type,
            description: risk.description || '',
            probability: risk.probability,
            cost_impact: risk.cost_impact,
            schedule_impact: risk.schedule_impact,
            confidence: (typeof risk.confidence === 'number') ? risk.confidence : 0.5,
            influence_score: influenceScore,
            reasoning: 'Coverage fallback: linked to most relevant activity to preserve register traceability.',
            weighted_cost_impact: risk.probability * risk.cost_impact * influenceScore,
            weighted_schedule_impact: risk.probability * risk.schedule_impact * influenceScore
        });
        mappedRiskIds.add(riskId);
    });
}

function renderRiskTaxonomyChart(riskRegister) {
    const container = document.getElementById('riskTaxonomyChart');
    if (!container || typeof d3 === 'undefined') return;

    const risks = Array.isArray(riskRegister) ? riskRegister : [];
    container.innerHTML = '';

    if (!risks.length) {
        container.innerHTML = '<div class="risk-taxonomy-empty">No external risks available for taxonomy visualization.</div>';
        return;
    }

    const rootNode = { name: 'Risk Taxonomy', children: [] };
    const domainMap = new Map();

    risks.forEach(risk => {
        const t = normalizeTaxonomyFields(risk.taxonomy || {});
        const domain = t.domain || 'Cross-Cutting';
        const category = t.category || 'Execution & Constructability';
        const subCategory = sanitizeSubCategoryLabel(t.sub_category) === 'General'
            ? inferSubCategoryFromRisk(risk, category)
            : t.sub_category;

        if (!domainMap.has(domain)) domainMap.set(domain, new Map());
        const categoryMap = domainMap.get(domain);
        if (!categoryMap.has(category)) categoryMap.set(category, new Map());
        const subCategoryMap = categoryMap.get(category);
        subCategoryMap.set(subCategory, (subCategoryMap.get(subCategory) || 0) + 1);
    });

    for (const [domain, categories] of domainMap.entries()) {
        const domainNode = { name: domain, children: [] };
        for (const [category, subCategories] of categories.entries()) {
            const categoryNode = { name: category, children: [] };
            for (const [subCategory, count] of subCategories.entries()) {
                categoryNode.children.push({ name: subCategory, value: count });
            }
            categoryNode.children.sort((a, b) => b.value - a.value);
            domainNode.children.push(categoryNode);
        }
        domainNode.children.sort((a, b) => d3.sum(b.children || [], c => c.value) - d3.sum(a.children || [], c => c.value));
        rootNode.children.push(domainNode);
    }

    rootNode.children.sort((a, b) => {
        const aTotal = d3.sum(a.children || [], c => d3.sum(c.children || [], s => s.value));
        const bTotal = d3.sum(b.children || [], c => d3.sum(c.children || [], s => s.value));
        return bTotal - aTotal;
    });

    const hierarchy = d3.hierarchy(rootNode).sum(d => d.value || 0).sort((a, b) => (b.value || 0) - (a.value || 0));
    const width = Math.max(container.clientWidth || 540, 540);
    const height = 270;

    d3.treemap().size([width, height]).paddingOuter(6).paddingTop(18).paddingInner(2)(hierarchy);

    const categoryTotals = new Map();
    rootNode.children.forEach(d => {
        (d.children || []).forEach(c => categoryTotals.set(c.name, d3.sum(c.children || [], s => s.value || 0)));
    });
    const categoryNames = [...categoryTotals.keys()];
    const palette = ['#2db7f5', '#7d8bff', '#36d399', '#ffb347', '#f97583', '#c084fc', '#22d3ee', '#f59e0b'];
    const color = d3.scaleOrdinal().domain(categoryNames).range(palette);

    const svg = d3.select(container)
        .append('svg')
        .attr('viewBox', `0 0 ${width} ${height}`)
        .attr('class', 'risk-taxonomy-svg');

    const leaves = svg.selectAll('g')
        .data(hierarchy.leaves())
        .enter()
        .append('g')
        .attr('transform', d => `translate(${d.x0},${d.y0})`);

    const maxLeafValue = d3.max(hierarchy.leaves().map(n => n.value || 1)) || 1;

    leaves.append('rect')
        .attr('width', d => Math.max(0, d.x1 - d.x0))
        .attr('height', d => Math.max(0, d.y1 - d.y0))
        .attr('fill', d => color(d.ancestors()[1]?.data?.name || 'Other'))
        .attr('fill-opacity', d => {
            const base = d.value || 1;
            return 0.5 + ((base / maxLeafValue) * 0.4);
        })
        .attr('stroke', '#0d2238')
        .attr('stroke-width', 1);

    leaves.append('title')
        .text(d => {
            const domain = d.ancestors()[2]?.data?.name || 'Unknown';
            const category = d.ancestors()[1]?.data?.name || 'Unknown';
            return `${domain} → ${category} → ${d.data.name}: ${d.value}`;
        });

    leaves.append('text')
        .attr('x', 4)
        .attr('y', 14)
        .attr('class', 'risk-taxonomy-label')
        .text(d => `${d.ancestors()[1]?.data?.name || 'Category'} • ${d.data.name} (${d.value})`)
        .each(function (d) {
            const maxWidth = (d.x1 - d.x0) - 8;
            if (maxWidth < 70) {
                d3.select(this).remove();
                return;
            }
            let text = d3.select(this);
            while (this.getComputedTextLength() > maxWidth && text.text().length > 6) {
                text.text(text.text().slice(0, -4) + '…');
            }
        });

    const domainBand = svg.append('g').attr('class', 'risk-taxonomy-domain-band');
    hierarchy.children?.forEach(domainNode => {
        domainBand.append('text')
            .attr('x', domainNode.x0 + 6)
            .attr('y', domainNode.y0 + 14)
            .text(`${domainNode.data.name} (${domainNode.value})`);
    });

    const legend = document.createElement('div');
    legend.className = 'risk-taxonomy-legend';
    legend.innerHTML = categoryNames.slice(0, 8).map(name => `
        <span class="risk-taxonomy-legend-item">
            <span class="risk-taxonomy-legend-dot" style="background:${color(name)}"></span>
            ${escapeHtml(name)}
        </span>
    `).join('');
    container.appendChild(legend);
}

function applyRiskEditMode(editable) {
    // External Risk Register — contenteditable cells
    const riskCells = document.querySelectorAll('#externalRiskTableBody [data-field]');
    riskCells.forEach(cell => {
        cell.setAttribute('contenteditable', editable ? 'true' : 'false');
        cell.style.backgroundColor = editable ? 'rgba(50,146,205,0.2)' : 'transparent';
        cell.style.outline = editable ? '1px dashed #5ac8fa' : 'none';
    });

    // Mitigation Activities table — input/select fields
    const mitigationInputs = document.querySelectorAll('#mitigationActivitiesTableBody input[data-field], #mitigationActivitiesTableBody select[data-field]');
    mitigationInputs.forEach(input => {
        input.disabled = !editable;
        input.style.opacity = editable ? '1' : '0.7';
    });

    // Mitigation Accept buttons — only enabled in edit mode
    const acceptBtns = document.querySelectorAll('#mitigationActivitiesTableBody .mitigation-accept-btn');
    acceptBtns.forEach(btn => {
        if (btn.textContent !== 'Accepted') {
            btn.disabled = !editable;
            btn.style.opacity = editable ? '1' : '0.5';
        }
    });

    const toggleBtn = document.getElementById('externalRiskEditToggle');
    if (toggleBtn) {
        toggleBtn.textContent = editable ? 'Disable Edit' : 'Enable Edit';
        toggleBtn.dataset.editable = editable ? '1' : '0';
    }
}

function ensureExternalRiskTableEditMode() {
    const toggleBtn = document.getElementById('externalRiskEditToggle');
    if (!toggleBtn) return;

    // Bind click handler once
    if (toggleBtn.dataset.bound !== '1') {
        toggleBtn.dataset.bound = '1';
        toggleBtn.dataset.editable = '0';
        toggleBtn.addEventListener('click', () => applyRiskEditMode(toggleBtn.dataset.editable !== '1'));
    }

    // Re-apply current mode to all tables (handles newly added rows)
    applyRiskEditMode(toggleBtn.dataset.editable === '1');
}

function mergeRiskRegisters(existingRisks, generatedRisks) {
    const out = [];
    const seen = new Set();
    [...(existingRisks || []), ...(generatedRisks || [])].forEach((risk, idx) => {
        const n = normalizeRiskRecord(risk, idx + 1);
        const key = `${String(n.name || '').toLowerCase()}|${String(n.type || '').toLowerCase()}`;
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(n);
    });
    return out;
}

function parseSeedLines(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map((line, i) => {
            const cols = splitCsvLine(line);
            const name = (cols[0] || '').trim();
            if (!name) return null;
            const type = (cols[1] || 'User Seed').trim() || 'User Seed';
            const probability = clampSeedRange(parseSeedProbability(cols[2], 0.5));
            const costImpact = clampSeedRange(parseSeedProbability(cols[3], 0.5));
            const scheduleImpact = clampSeedRange(parseSeedProbability(cols[4], 0.5));
            const description = (cols[5] || '').trim();
            return {
                id: `seed-${Date.now()}-${i}`,
                name,
                type,
                source: 'User',
                probability,
                cost_impact: costImpact,
                schedule_impact: scheduleImpact,
                manifestation_mechanism: `Seeded risk signal from user input (${type}) requiring project-specific mapping and quantification.`,
                description,
                taxonomy: { domain: 'Cross-Cutting', category: 'User Seed', sub_category: 'Manual Input', driver: 'Stakeholder Input' }
            };
        })
        .filter(Boolean);
}

function splitCsvLine(line) {
    const out = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            out.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    out.push(current.trim());
    return out;
}

function parseSeedProbability(raw, fallback) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    if (value > 1 && value <= 100) return value / 100;
    return value;
}

function clampSeedRange(v) {
    return Math.max(0, Math.min(1, Number.isFinite(Number(v)) ? Number(v) : 0));
}

function getUserRiskRegisterInputs() {
    const stateRisks = Array.isArray(window.cybereumState?.userRiskRegister) ? window.cybereumState.userRiskRegister : [];
    const seededRisks = Array.isArray(window.cybereumState?.seededRiskRegister) ? window.cybereumState.seededRiskRegister : [];
    const existingRisks = Array.isArray(window.cybereumState?.existingRiskRegister) ? window.cybereumState.existingRiskRegister : [];
    return mergeRiskRegisters(mergeRiskRegisters(stateRisks, seededRisks), existingRisks);
}

/**
 * STEP 1: Get external risk register (using the working approach)
 * This is exactly what was working in the diagnostic version
 */
async function getExternalRiskRegister(nodes, links, meta = {}) {
    try {
        // Build a strong default meta from state+nodes,
        // then let caller overrides in `meta` take precedence
        const built = buildMetaFromState(window.cybereumState || {}, nodes || []);
        const mergedMeta = { ...built, ...meta };

        // derive candidates & duration outliers (fast, single pass)
        const nr = deriveNonCriticalRelatedActivities(nodes || [], mergedMeta);

        // Merge into your existing payload with the SAME project footprint
        const base = buildExternalRiskPayload(nodes, links, mergedMeta);
        const payload = {
            ...base,
            user_risk_register: getUserRiskRegisterInputs(),
            project: {
                ...(base.project || {}),
                noncritical_candidates: nr.candidates,
                duration_outliers: nr.duration_outliers,
                candidate_summary: nr.summary
            }
        };

        console.log("Calling external risk API…");
        const response = await fetch('/OpenAI/AssessExternalRisks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        console.log("Risk API response status:", response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error("Risk API error:", errorText);
            throw new Error(`Risk API failed: ${response.status}`);
        }

        const result = await response.json();
        console.log(`Risk register received: ${result.risk_register?.length || 0} external risks`);
        console.log("Risk register data:", result);

        return result;

    } catch (error) {
        console.error("Failed to get risk register:", error);
        return { risk_register: [], risk_mappings: {}, external_signal_snapshot: null };
    }
}

/**
 * STEP 2: Apply risks to activities with simple matching
 * Using the working logic from before but simplified
 * OPTIMIZED: Pre-compute categories, single-pass score calculation
 */
function applyRisksToActivities(nodes, riskAssessment) {
    const { risk_register, risk_mappings } = riskAssessment;

    if (!risk_register || risk_register.length === 0) {
        console.log("No external risks to apply");
        return initializeEmptyExternalRisks([...nodes]);
    }

    console.log(`Applying ${risk_register.length} external risks to ${nodes.length} activities`);
    const t0 = performance.now();

    // OPTIMIZATION: Pre-compute categories and lowercase names ONCE
    const enrichedNodes = nodes.map(node => {
        const nameLower = String(node.Name || "").toLowerCase();
        return {
            ...node,
            _nameLower: nameLower,                    // Cache lowercase name
            _category: categorizeByName(nameLower),  // Cache category
            externalRisks: [],
            externalRiskScore: 0,
            externalCostRisk: 0,
            externalScheduleRisk: 0
        };
    });

    // Apply each risk to relevant activities
    const fallbackActivity = enrichedNodes
        .slice()
        .sort((a, b) => {
            const aPriority = (a.isOnCriticalPath ? 3 : 0) + (Number(a.riskScore || 0) * 2) + Number(a.importanceScore || 0);
            const bPriority = (b.isOnCriticalPath ? 3 : 0) + (Number(b.riskScore || 0) * 2) + Number(b.importanceScore || 0);
            return bPriority - aPriority;
        })[0] || null;

    risk_register.forEach(risk => {
        let affectedActivities = findAffectedActivitiesOptimized(enrichedNodes, risk, risk_mappings);

        // Enforce minimum coupling: every external risk must map to at least one activity.
        if ((!affectedActivities || affectedActivities.length === 0) && fallbackActivity) {
            affectedActivities = [{ node: fallbackActivity, influenceScore: 0.15 }];
        }

        affectedActivities.forEach(({ node, influenceScore }) => {
            node.externalRisks.push({
                id: risk.id,
                name: risk.name,
                type: risk.type,
                description: risk.description || '',
                probability: risk.probability,
                cost_impact: risk.cost_impact,
                schedule_impact: risk.schedule_impact,
                confidence: (typeof risk.confidence === 'number') ? risk.confidence : 0.5,
                influence_score: influenceScore,
                weighted_cost_impact: risk.probability * risk.cost_impact * influenceScore,
                weighted_schedule_impact: risk.probability * risk.schedule_impact * influenceScore
            });
        });
    });

    // OPTIMIZATION: Single pass for max calculation, normalization, and combined score
    let maxExternalRisk = 0;
    let affectedCount = 0;

    // First pass: calculate scores and find max
    enrichedNodes.forEach(node => {
        if (node.externalRisks.length > 0) {
            affectedCount++;
            node.externalCostRisk = Math.max(...node.externalRisks.map(r => r.weighted_cost_impact));
            node.externalScheduleRisk = Math.max(...node.externalRisks.map(r => r.weighted_schedule_impact));
            node.externalRiskScore = Math.max(node.externalCostRisk, node.externalScheduleRisk);
            maxExternalRisk = Math.max(maxExternalRisk, node.externalRiskScore);
            // Propagate risk-level confidence: impact-weighted average
            var wcs = 0, iws = 0;
            node.externalRisks.forEach(function (r) {
                var imp = Math.max(r.weighted_cost_impact, r.weighted_schedule_impact);
                var conf = typeof r.confidence === 'number' ? r.confidence : 0.5;
                wcs += conf * imp; iws += imp;
            });
            node.externalRiskConfidence = iws > 0 ? wcs / iws : 0.5;
        }
    });

    // Second pass: normalize if needed AND calculate combined score (combines 3 passes into 1)
    const needsNormalization = maxExternalRisk > 0 && maxExternalRisk < 0.5;
    const normalizationFactor = needsNormalization ? (0.8 / maxExternalRisk) : 1;

    if (needsNormalization) {
        console.log(`Normalizing external risk scores with factor ${normalizationFactor.toFixed(2)}`);
    }

    enrichedNodes.forEach(node => {
        // Apply normalization if needed
        if (needsNormalization && node.externalRiskScore > 0) {
            node.externalRiskScore = Math.min(1, node.externalRiskScore * normalizationFactor);
            node.externalCostRisk = Math.min(1, node.externalCostRisk * normalizationFactor);
            node.externalScheduleRisk = Math.min(1, node.externalScheduleRisk * normalizationFactor);
        }

        // Clamp to 0-1
        node.externalCostRisk = Math.min(1, Math.max(0, node.externalCostRisk));
        node.externalScheduleRisk = Math.min(1, Math.max(0, node.externalScheduleRisk));
        node.externalRiskScore = Math.min(1, Math.max(0, node.externalRiskScore));

        // Combined risk: phase-aware, confidence-weighted integration
        const internalRisk = Number.isFinite(+node.riskScore) ? +node.riskScore : 0;
        var compoundAnalysis = (window.cybereumState || {}).compoundRiskAnalysis;
        node.combinedRiskScore = computeCombinedRisk(internalRisk, node.externalScheduleRisk, {
            phase: node.ActivityPhase || null,
            confidence: (typeof node.externalRiskConfidence === 'number') ? node.externalRiskConfidence : 0.5,
            isOnCriticalPath: !!(node.isOnCriticalPath || node.is_oncriticalpath),
            compoundAmplification: (compoundAnalysis && compoundAnalysis.amplification) || 1.0
        });

        // Clean up cached properties
        delete node._nameLower;
        delete node._category;
    });

    const elapsed = Math.round(performance.now() - t0);
    console.log(`Risk application complete in ${elapsed}ms: ${affectedCount} activities affected`);
    console.log(`External risk range: 0 to ${maxExternalRisk.toFixed(3)}`);

    return enrichedNodes;
}

/**
 * OPTIMIZED: Find affected activities using pre-computed categories
 */
function findAffectedActivitiesOptimized(nodes, risk, risk_mappings) {
    const affected = [];
    const mapping = risk_mappings[risk.id];

    // FIXED: Lower threshold from 0.1 to 0.05 to capture marginal cases
    const INFLUENCE_THRESHOLD = 0.05;

    if (!mapping) {
        // If no mapping provided, use basic type-based matching with pre-computed categories
        nodes.forEach(node => {
            const influenceScore = getBasicInfluenceScoreOptimized(node, risk);
            if (influenceScore > INFLUENCE_THRESHOLD) {
                affected.push({ node, influenceScore });
            }
        });
        return affected;
    }

    // Use the mapping if provided (with pre-computed categories)
    nodes.forEach(node => {
        let influenceScore = 0;
        const nodeCategory = node._category; // Use pre-computed category

        // Category matching
        if (mapping.categories && mapping.categories.includes(nodeCategory)) {
            influenceScore += 0.6;
        }

        // Critical path bonus
        if (node.isOnCriticalPath) {
            influenceScore += 0.2;
        }

        // Apply mapping impact factor
        if (mapping.impact_factor) {
            influenceScore *= mapping.impact_factor;
        }

        // Internal risk amplification
        const internalRisk = Number.isFinite(+node.riskScore) ? +node.riskScore : 0;
        if (internalRisk > 0.5) {
            influenceScore += 0.1;
        }

        if (influenceScore > INFLUENCE_THRESHOLD) {
            affected.push({ node, influenceScore: Math.min(1, influenceScore) });
        }
    });

    return affected;
}

const TYPE_MAPPING = {
    // Existing types
    'Regulatory': ['Design & Engineering', 'Permits & Approvals', 'Testing & Commissioning', 'Handover'],
    'Environmental': ['Site Preparation', 'Foundation', 'Structural', 'Installation', 'Civil Works'],
    'Weather': ['Site Preparation', 'Foundation', 'Structural', 'Installation', 'Civil Works', 'Piperack & Headers', 'Utilities & Offsites'],
    'Force Majeure': ['Site Preparation', 'Foundation', 'Structural', 'Installation', 'Mechanical', 'Electrical'],
    'Market': ['Procurement', 'Design & Engineering'],
    'Supply Chain': ['Procurement', 'Mechanical', 'Electrical', 'Instrumentation', 'Process Equipment', 'Rotating Equipment'],
    'Technical': ['Design & Engineering', 'Testing & Commissioning', 'Installation', 'Startup', 'Process Equipment'],
    'Social': ['Site Preparation', 'Permits & Approvals', 'Civil Works'],
    'Political': ['Permits & Approvals', 'Procurement', 'Design & Engineering'],
    'Labor': ['Site Preparation', 'Foundation', 'Structural', 'Mechanical', 'Electrical', 'Installation', 'Civil Works'],
    'Financial': ['Procurement', 'Design & Engineering', 'Permits & Approvals'],
    'Economic': ['Procurement', 'Design & Engineering'],
    'Geopolitical': ['Procurement', 'Permits & Approvals'],
    'Cyber': ['Instrumentation', 'Electrical', 'Testing & Commissioning'],
    'Health': ['Site Preparation', 'Installation', 'Testing & Commissioning'],
    'Safety': ['Site Preparation', 'Installation', 'Testing & Commissioning', 'Startup', 'Mechanical'],
    'Contractual': ['Procurement', 'Design & Engineering', 'Installation'],
    'Resource': ['Site Preparation', 'Foundation', 'Structural', 'Mechanical', 'Electrical', 'Installation'],
    'Process Safety': ['Testing & Commissioning', 'Startup', 'Mechanical', 'Instrumentation', 'Process Equipment'],
    'Quality': ['Design & Engineering', 'Testing & Commissioning', 'Mechanical', 'Procurement'],
    'Security': ['Instrumentation', 'Electrical', 'Site Preparation'],
    'Logistics': ['Procurement', 'Site Preparation', 'Installation', 'Mechanical', 'Structural'],
    'Marine Operations': ['Installation', 'Structural', 'Civil Works', 'Mechanical'],
    'Commodity': ['Procurement', 'Design & Engineering'],
    'Technology': ['Design & Engineering', 'Testing & Commissioning', 'Instrumentation'],

    // NEW: Missing types from logs
    'Organizational': ['Design & Engineering', 'Permits & Approvals', 'Testing & Commissioning', 'Handover', 'Startup'],
    'Operational': ['Testing & Commissioning', 'Startup', 'Utilities & Offsites', 'Instrumentation'],
    'Natural Hazard': ['Site Preparation', 'Foundation', 'Structural', 'Installation', 'Civil Works'],
    'Commercial': ['Procurement', 'Design & Engineering', 'Permits & Approvals', 'Handover'],
    'Insurance': ['Procurement', 'Design & Engineering', 'Installation'],
    'Engineering': ['Design & Engineering', 'Testing & Commissioning', 'Mechanical', 'Electrical', 'Instrumentation', 'Process Equipment']
};

// Pre-convert to Set for O(1) lookups
const TYPE_MAPPING_SETS = {};
for (const [type, categories] of Object.entries(TYPE_MAPPING)) {
    TYPE_MAPPING_SETS[type] = new Set(categories);
}

function getBasicInfluenceScoreOptimized(node, risk) {
    // Compute category if not pre-computed
    const nodeCategory = node._category || categorizeByName(String(node.Name || '').toLowerCase());
    const nodeName = node._nameLower || String(node.Name || '').toLowerCase();
    let score = 0;

    const relevantCategories = TYPE_MAPPING_SETS[risk.type];

    if (!relevantCategories) {
        // FIXED: Much more selective keyword matching
        // Only match if we find SPECIFIC, MEANINGFUL keywords
        const riskName = (risk.name || '').toLowerCase();
        const riskDesc = (risk.description || '').toLowerCase();

        // Extract significant keywords (longer words, exclude common terms)
        const significantWords = new Set([
            ...riskName.split(/\s+/).filter(w => w.length > 5),
            ...riskDesc.split(/\s+/).filter(w => w.length > 6)
        ]);

        // Remove generic words that would match too broadly
        const genericWords = new Set([
            'project', 'delay', 'impact', 'during', 'construction', 'installation',
            'system', 'equipment', 'material', 'schedule', 'budget', 'change',
            'approval', 'review', 'complete', 'completion', 'require', 'requirements'
        ]);

        let matchCount = 0;
        let strongMatch = false;

        for (const word of significantWords) {
            if (genericWords.has(word)) continue;

            // Check for strong match in node name
            if (nodeName.includes(word)) {
                matchCount++;
                if (word.length > 7) strongMatch = true;
            }
            // Weaker: check category match
            else if (nodeCategory && nodeCategory.toLowerCase().includes(word)) {
                matchCount += 0.5;
            }
        }

        // FIXED: Require stronger evidence for unknown risk types
        if (strongMatch && matchCount >= 2) {
            score += 0.35;
        } else if (matchCount >= 3) {
            score += 0.25;
        }
        // Otherwise, score stays 0 - don't apply risk

    } else {
        // Known risk type - use category matching
        if (relevantCategories.has(nodeCategory)) {
            score += 0.4;
        } else {
            // Partial category match - be more selective
            for (const cat of relevantCategories) {
                // Only match if substantial overlap
                if (nodeCategory && nodeCategory.length > 3) {
                    if (nodeCategory === cat) {
                        score += 0.35;
                        break;
                    } else if (cat.includes(nodeCategory) && nodeCategory.length > 5) {
                        score += 0.15;
                        break;
                    }
                }
            }
        }
    }

    // Critical path bonus
    if (node.isOnCriticalPath) {
        score += 0.2;
    }

    // High internal risk amplification (reduced from 0.2/0.1)
    const internalRisk = Number.isFinite(+node.riskScore) ? +node.riskScore : 0;
    if (internalRisk > 0.7) {
        score += 0.15;
    } else if (internalRisk > 0.5) {
        score += 0.08;
    }

    // High importance activities
    const importance = Number.isFinite(+node.importanceScore) ? +node.importanceScore : 0;
    if (importance > 0.7) {
        score += 0.1;
    }

    // Supply chain affinity: boost when externally-supplied activities face supply-chain-related risks
    const supplierType = node.SupplierType || node.supplierType;
    if (supplierType && supplierType !== 'internal' && supplierType !== 'unknown') {
        const riskType = (risk.type || '').toLowerCase();
        const riskName = (risk.name || '').toLowerCase();
        const isSupplyChainRisk = riskType === 'supply chain' || riskType === 'procurement'
            || riskType === 'commercial' || riskType === 'logistics'
            || riskName.includes('supply') || riskName.includes('supplier')
            || riskName.includes('procurement') || riskName.includes('vendor')
            || riskName.includes('delivery') || riskName.includes('lead time')
            || riskName.includes('shipping') || riskName.includes('logistics');

        if (isSupplyChainRisk) {
            if (supplierType === 'external_equipment') {
                score += 0.2;
            } else if (supplierType === 'external_material') {
                score += 0.15;
            } else if (supplierType === 'external_service') {
                score += 0.12;
            }
        }
    }

    return Math.min(1, score);
}

/**
 * STEP 2.5: Get intelligent risk-to-activity mappings from LLM
 * This replaces the generic type-based matching
 */
async function getIntelligentRiskMappings(risk_register, activities, projectMeta) {
    try {
        console.log("Getting intelligent risk mappings from LLM...");

        // Send only essential activity info to stay within token limits
        const activitySummary = activities.map(node => ({
            id: node.ID,
            name: node.Name,
            category: categorizeByName(String(node.Name || "").toLowerCase()),
            critical: node.isOnCriticalPath,
            internal_risk: node.riskScore || 0,
            duration: node.Duration || 0
        }));

        const payload = {
            risks: risk_register.map(risk => ({
                id: risk.id,
                name: risk.name,
                type: risk.type,
                description: risk.description
            })),
            activities: activitySummary,
            project: {
                sector: projectMeta.sector,
                subsector: projectMeta.subsector,
                region: projectMeta.region,
                phase: projectMeta.phase
            }
        };

        const response = await fetch('/OpenAI/GenerateIntelligentRiskMappings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.warn("LLM mapping failed, using basic mappings");
            return generateBasicRiskMappings(risk_register);
        }

        const result = await response.json();
        console.log("Intelligent risk mappings received");
        return result.mappings;

    } catch (error) {
        console.warn("LLM mapping error, using basic mappings:", error);
        return generateBasicRiskMappings(risk_register);
    }
}
/**
 * Generate basic fallback mappings when LLM fails
 */
function generateBasicRiskMappings(risk_register) {
    const mappings = {};

    risk_register.forEach(risk => {
        // Create empty structure that will trigger fallback matching
        mappings[risk.id] = {
            risk_id: risk.id,
            risk_name: risk.name,
            affected_activities: [] // Empty array will trigger fallback logic
        };
    });

    return mappings;
}

function applyRisksToActivitiesIntelligent(nodes, risk_register, intelligentMappings) {
    if (!risk_register || risk_register.length === 0) {
        console.log("No external risks to apply");
        return initializeEmptyExternalRisks([...nodes]);
    }

    console.log(`Applying ${risk_register.length} external risks using intelligent mappings`);
    const t0 = performance.now();

    // FIXED: Initialize nodes WITH _category and _nameLower
    const enrichedNodes = nodes.map(node => {
        const nameLower = String(node.Name || "").toLowerCase();
        return {
            ...node,
            _nameLower: nameLower,
            _category: categorizeByName(nameLower),
            externalRisks: [],
            externalRiskScore: 0,
            externalCostRisk: 0,
            externalScheduleRisk: 0,
            combinedRiskScore: 0
        };
    });

    const nodeById = new Map();
    enrichedNodes.forEach(node => {
        nodeById.set(String(node.ID), node);
    });

    const riskLookup = new Map();
    risk_register.forEach(risk => {
        riskLookup.set(risk.id, risk);
    });

    let mappingData = intelligentMappings;
    if (intelligentMappings.mappings && typeof intelligentMappings.mappings === 'object') {
        mappingData = intelligentMappings.mappings;
    }

    // Track risks that had explicit mappings vs fallback
    const risksWithMappings = new Set();

    const processIndividualMapping = (mapping) => {
        const risk = riskLookup.get(mapping.risk_id);
        if (!risk) return;

        let affectedCount = 0;

        if (mapping.affected_activities && Array.isArray(mapping.affected_activities) && mapping.affected_activities.length > 0) {
            risksWithMappings.add(mapping.risk_id);

            for (const activityMapping of mapping.affected_activities) {
                const node = nodeById.get(String(activityMapping.activity_id));
                if (!node) continue;

                const influenceScore = activityMapping.influence_score || 0.5;

                node.externalRisks.push({
                    id: risk.id,
                    name: risk.name,
                    type: risk.type,
                    description: risk.description || '',
                    probability: risk.probability,
                    cost_impact: risk.cost_impact,
                    schedule_impact: risk.schedule_impact,
                    confidence: (typeof risk.confidence === 'number') ? risk.confidence : 0.5,
                    influence_score: influenceScore,
                    reasoning: activityMapping.reasoning || 'LLM-based intelligent matching',
                    weighted_cost_impact: risk.probability * risk.cost_impact * influenceScore,
                    weighted_schedule_impact: risk.probability * risk.schedule_impact * influenceScore
                });

                affectedCount++;
            }
        }

        // FIXED: Only use fallback if mapping explicitly failed AND require higher threshold
        if (affectedCount === 0) {
            const FALLBACK_THRESHOLD = 0.25; // Higher threshold for fallback
            const candidateNodes = [];

            enrichedNodes.forEach(node => {
                const influenceScore = getBasicInfluenceScoreOptimized(node, risk);
                if (influenceScore >= FALLBACK_THRESHOLD) {
                    candidateNodes.push({ node, influenceScore });
                }
            });

            // FIXED: Limit fallback to top N most relevant activities per risk
            const MAX_FALLBACK_ACTIVITIES = Math.min(50, Math.ceil(enrichedNodes.length * 0.05));
            candidateNodes
                .sort((a, b) => b.influenceScore - a.influenceScore)
                .slice(0, MAX_FALLBACK_ACTIVITIES)
                .forEach(({ node, influenceScore }) => {
                    node.externalRisks.push({
                        id: risk.id,
                        name: risk.name,
                        type: risk.type,
                        description: risk.description || '',
                        probability: risk.probability,
                        cost_impact: risk.cost_impact,
                        schedule_impact: risk.schedule_impact,
                        influence_score: influenceScore,
                        confidence: (typeof risk.confidence === 'number') ? risk.confidence : 0.5,
                        reasoning: 'Fallback category-based matching',
                        weighted_cost_impact: risk.probability * risk.cost_impact * influenceScore,
                        weighted_schedule_impact: risk.probability * risk.schedule_impact * influenceScore
                    });
                });
        }
    };

    if (Array.isArray(mappingData)) {
        mappingData.forEach(processIndividualMapping);
    } else if (typeof mappingData === 'object') {
        Object.values(mappingData).forEach(processIndividualMapping);
    }

    // Ensure every external risk is traceable to at least one activity
    ensureExternalRiskCoverage(enrichedNodes, risk_register);

    // FIXED: Cap maximum risks per activity to prevent overload while keeping global risk traceability
    const MAX_RISKS_PER_ACTIVITY = 15;
    const riskAssignmentCounts = new Map();
    enrichedNodes.forEach(node => {
        (node.externalRisks || []).forEach(r => {
            const key = String(r.id);
            riskAssignmentCounts.set(key, (riskAssignmentCounts.get(key) || 0) + 1);
        });
    });

    enrichedNodes.forEach(node => {
        if (node.externalRisks.length <= MAX_RISKS_PER_ACTIVITY) return;

        node.externalRisks.sort((a, b) => {
            const impactA = Math.max(a.weighted_cost_impact, a.weighted_schedule_impact);
            const impactB = Math.max(b.weighted_cost_impact, b.weighted_schedule_impact);
            return impactB - impactA;
        });

        const kept = [];
        const overflow = [];
        node.externalRisks.forEach((risk, idx) => {
            if (idx < MAX_RISKS_PER_ACTIVITY) kept.push(risk);
            else overflow.push(risk);
        });

        for (const r of overflow) {
            const key = String(r.id);
            const currentCount = riskAssignmentCounts.get(key) || 0;
            if (currentCount <= 1) {
                kept.push(r);
            } else {
                riskAssignmentCounts.set(key, currentCount - 1);
            }
        }

        node.externalRisks = kept;
    });

    // Re-check after capping to guarantee that no risk was orphaned by trimming.
    ensureExternalRiskCoverage(enrichedNodes, risk_register);

    // Score calculation — also propagate confidence to node level
    // Node-level externalRiskConfidence = impact-weighted average of risk-level
    // confidences. This feeds into computeCombinedRisk() so that low-confidence
    // external signals are appropriately dampened.
    let maxExternalRisk = 0;

    for (const node of enrichedNodes) {
        if (node.externalRisks.length > 0) {
            let maxCost = 0, maxSched = 0;
            let weightedConfidenceSum = 0, impactWeightSum = 0;
            for (const r of node.externalRisks) {
                if (r.weighted_cost_impact > maxCost) maxCost = r.weighted_cost_impact;
                if (r.weighted_schedule_impact > maxSched) maxSched = r.weighted_schedule_impact;
                // Propagate risk-level confidence to node, weighted by impact
                var riskImpact = Math.max(r.weighted_cost_impact, r.weighted_schedule_impact);
                var riskConf = typeof r.confidence === 'number' ? r.confidence : 0.5;
                weightedConfidenceSum += riskConf * riskImpact;
                impactWeightSum += riskImpact;
            }
            node.externalCostRisk = maxCost;
            node.externalScheduleRisk = maxSched;
            node.externalRiskScore = Math.max(maxCost, maxSched);
            node.externalRiskConfidence = impactWeightSum > 0
                ? weightedConfidenceSum / impactWeightSum
                : 0.5;

            if (node.externalRiskScore > maxExternalRisk) {
                maxExternalRisk = node.externalRiskScore;
            }
        }
    }

    const needsNormalization = maxExternalRisk > 0 && maxExternalRisk < 0.5;
    const normalizationFactor = needsNormalization ? (0.8 / maxExternalRisk) : 1;

    for (const node of enrichedNodes) {
        if (needsNormalization && node.externalRiskScore > 0) {
            node.externalRiskScore *= normalizationFactor;
            node.externalCostRisk *= normalizationFactor;
            node.externalScheduleRisk *= normalizationFactor;
        }

        node.externalCostRisk = Math.min(1, Math.max(0, node.externalCostRisk));
        node.externalScheduleRisk = Math.min(1, Math.max(0, node.externalScheduleRisk));
        node.externalRiskScore = Math.min(1, Math.max(0, node.externalRiskScore));

        // Combined risk: phase-aware, confidence-weighted integration (unified function)
        const internalRisk = Number.isFinite(+node.riskScore) ? +node.riskScore : 0;
        var compoundState = (window.cybereumState || {}).compoundRiskAnalysis;
        node.combinedRiskScore = computeCombinedRisk(internalRisk, node.externalScheduleRisk, {
            phase: node.ActivityPhase || null,
            confidence: (typeof node.externalRiskConfidence === 'number') ? node.externalRiskConfidence : 0.5,
            isOnCriticalPath: !!(node.isOnCriticalPath || node.is_oncriticalpath),
            compoundAmplification: (compoundState && compoundState.amplification) || 1.0
        });

        delete node._nameLower;
        delete node._category;
    }

    const affectedCount = enrichedNodes.filter(n => n.externalRisks.length > 0).length;
    const elapsed = Math.round(performance.now() - t0);
    console.log(`Intelligent risk application complete in ${elapsed}ms: ${affectedCount}/${enrichedNodes.length} activities affected`);
    console.log(`Risks with explicit LLM mappings: ${risksWithMappings.size}/${risk_register.length}`);

    return enrichedNodes;
}

/**
 * Find activities affected by a risk using simple but effective logic
 * NOTE: Prefer using findAffectedActivitiesOptimized when nodes have pre-computed _category
 */
function findAffectedActivities(nodes, risk, risk_mappings) {
    // If nodes have pre-computed categories, delegate to optimized version
    if (nodes.length > 0 && nodes[0]._category !== undefined) {
        return findAffectedActivitiesOptimized(nodes, risk, risk_mappings);
    }

    const affected = [];
    const mapping = risk_mappings[risk.id];

    // FIXED: Lower threshold from 0.1 to 0.05
    const INFLUENCE_THRESHOLD = 0.05;

    if (!mapping) {
        // If no mapping provided, use basic type-based matching
        nodes.forEach(node => {
            const influenceScore = getBasicInfluenceScore(node, risk);
            if (influenceScore > INFLUENCE_THRESHOLD) {
                affected.push({ node, influenceScore });
            }
        });

        return affected;
    }

    // Use the mapping if provided
    nodes.forEach(node => {
        let influenceScore = 0;
        const nodeCategory = categorizeByName(String(node.Name || "").toLowerCase());

        // Category matching
        if (mapping.categories && mapping.categories.includes(nodeCategory)) {
            influenceScore += 0.6;
        }

        // Critical path bonus
        if (node.isOnCriticalPath) {
            influenceScore += 0.2;
        }

        // Apply mapping impact factor
        if (mapping.impact_factor) {
            influenceScore *= mapping.impact_factor;
        }

        // Internal risk amplification
        const internalRisk = Number.isFinite(+node.riskScore) ? +node.riskScore : 0;
        if (internalRisk > 0.5) {
            influenceScore += 0.1;
        }

        if (influenceScore > INFLUENCE_THRESHOLD) {
            affected.push({ node, influenceScore: Math.min(1, influenceScore) });
        }
    });

    return affected;
}

/**
 * Basic influence scoring when no mapping is provided
 * NOTE: Prefer using getBasicInfluenceScoreOptimized when nodes have pre-computed _category
 */
function getBasicInfluenceScore(node, risk) {
    // If node has pre-computed category, delegate to optimized version
    if (node._category !== undefined) {
        return getBasicInfluenceScoreOptimized(node, risk);
    }

    const name = String(node.Name || "").toLowerCase();
    const nodeCategory = categorizeByName(name);
    let score = 0;

    // EXPANDED: More comprehensive risk type to category mapping
    const typeMapping = {
        'Regulatory': ['Design & Engineering', 'Permits & Approvals', 'Testing & Commissioning', 'Handover'],
        'Environmental': ['Site Preparation', 'Foundation', 'Structural', 'Installation', 'Civil Works'],
        'Weather': ['Site Preparation', 'Foundation', 'Structural', 'Installation', 'Civil Works', 'Piperack & Headers'],
        'Force Majeure': ['Site Preparation', 'Foundation', 'Structural', 'Installation', 'Mechanical', 'Electrical'],
        'Market': ['Procurement', 'Design & Engineering'],
        'Supply Chain': ['Procurement', 'Mechanical', 'Electrical', 'Instrumentation', 'Process Equipment', 'Rotating Equipment'],
        'Technical': ['Design & Engineering', 'Testing & Commissioning', 'Installation', 'Startup', 'Process Equipment'],
        'Social': ['Site Preparation', 'Permits & Approvals', 'Civil Works'],
        'Political': ['Permits & Approvals', 'Procurement', 'Design & Engineering'],
        'Labor': ['Site Preparation', 'Foundation', 'Structural', 'Mechanical', 'Electrical', 'Installation', 'Civil Works'],
        'Financial': ['Procurement', 'Design & Engineering'],
        'Economic': ['Procurement', 'Design & Engineering'],
        'Geopolitical': ['Procurement', 'Permits & Approvals'],
        'Cyber': ['Instrumentation', 'Electrical', 'Testing & Commissioning'],
        'Health': ['Site Preparation', 'Installation', 'Testing & Commissioning'],
        'Safety': ['Site Preparation', 'Installation', 'Testing & Commissioning', 'Startup'],
        'Contractual': ['Procurement', 'Design & Engineering', 'Installation'],
        'Resource': ['Site Preparation', 'Foundation', 'Structural', 'Mechanical', 'Electrical', 'Installation'],
    };

    // Check for category match
    const relevantCategories = typeMapping[risk.type] || [];

    // ADDED: Fallback for unknown risk types
    if (relevantCategories.length === 0) {
        const riskText = `${risk.name || ''} ${risk.description || ''}`.toLowerCase();
        const riskWords = riskText.split(/\s+/).filter(w => w.length > 4);
        const matchedWords = riskWords.filter(w => name.includes(w) || nodeCategory.toLowerCase().includes(w));
        if (matchedWords.length > 0) {
            score += 0.3 + Math.min(matchedWords.length * 0.1, 0.2);
        }
    } else {
        if (relevantCategories.includes(nodeCategory)) {
            score += 0.4;
        }
        relevantCategories.forEach(cat => {
            if (nodeCategory.includes(cat) || cat.includes(nodeCategory)) {
                score += 0.1;
            }
        });
    }

    // Critical path bonus
    if (node.isOnCriticalPath) {
        score += 0.25;
    }

    // High internal risk makes activities more vulnerable to external risks
    const internalRisk = Number.isFinite(+node.riskScore) ? +node.riskScore : 0;
    if (internalRisk > 0.7) {
        score += 0.2;
    } else if (internalRisk > 0.4) {
        score += 0.1;
    }

    // High importance activities
    const importance = Number.isFinite(+node.importanceScore) ? +node.importanceScore : 0;
    if (importance > 0.7) {
        score += 0.15;
    }

    return Math.min(1, score);
}
/**
 * Initialize empty external risk data
 */
function initializeEmptyExternalRisks(nodes) {
    return nodes.map(node => {
        const internalRisk = Number.isFinite(+node.riskScore) ? +node.riskScore : 0;
        return {
            ...node,
            externalRisks: [],
            externalRiskScore: 0,
            externalCostRisk: 0,
            externalScheduleRisk: 0,
            combinedRiskScoreRaw: internalRisk,
            combinedRiskScore: internalRisk,  // Just internal risk when no external
            combinedRiskScoreNormalized: Math.min(1, internalRisk)
        };
    });
}

function combineForRender(baseNodes, baseLinks, opts = { showRisks: true }) {
    const coerceNode = n => ({ ...n, ID: String(n.ID) });
    const coerceLink = l => ({ ...l, source: String(l.source), target: String(l.target) });

    const allNodes = (baseNodes || []).map(coerceNode);
    let allLinks = (baseLinks || []).map(coerceLink);

    if (opts.showRisks && window.cybereumState && window.cybereumState.riskGraph) {
        const rg = window.cybereumState.riskGraph;
        allNodes.push(...(rg.riskNodes || []).map(coerceNode));

        // Keep only links whose endpoints exist in the final node set
        const idSet = new Set(allNodes.map(n => n.ID));
        const safeRiskLinks = (rg.riskLinks || [])
            .map(coerceLink)
            .filter(l => idSet.has(l.source) && idSet.has(l.target));

        allLinks = allLinks.concat(safeRiskLinks);
    }

    return { nodes: allNodes, links: allLinks };
}

// Keep the working helper functions exactly as they were
function buildExternalRiskPayload(nodes, links, meta = {}) {
    // ---- Helpers ------------------------------------------------------------
    const toNum = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    };

    const toDateSafe = (v) => {
        const d = new Date(v);
        return Number.isFinite(d.getTime()) ? d : null;
    };

    const daysBetween = (a, b) => Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));

    const clampPct = (p) => {
        const n = toNum(p);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(100, n));
    };

    // ---- Configuration for optimization ------------------------------------
    // FIXED: Scale sample size with project complexity instead of hard limit
    const activityCount = nodes.length;
    const MAX_SAMPLE_NODES = Math.min(250, Math.max(50, Math.round(activityCount * 0.15)));
    const MAX_WORK_CATEGORIES = 30;   // Limit categories sent
    const MAX_HIGH_RISK_SAMPLES = Math.min(50, Math.max(10, Math.round(activityCount * 0.03)));
    const MAX_RISK_CONCENTRATIONS = 20; // Limit risk concentrations

    // ---- Guard: empty input -------------------------------------------------
    if (!Array.isArray(nodes) || nodes.length === 0) {
        const today = window.cybereumState.dataDate || new Date();
        return {
            project: {
                sector: meta.sector || "General",
                subsector: meta.subsector || "",
                region: meta.region || "General",
                country: meta.country || "General",
                phase: meta.phase || "Execution",
                timeline: {
                    start: today.toISOString().split('T')[0],
                    end: today.toISOString().split('T')[0],
                    duration_days: 1,
                    progress_percent: 0
                },
                scale: {
                    total_activities: 0,
                    analyzed_activities: 0,
                    critical_path_activities: 0,
                    high_internal_risk_activities: 0,
                    estimated_capex: meta?.baseline?.capex_usd ?? 0
                }
            },
            work_categories: [],
            internal_risk_indicators: {
                critical_path_risk: 0,
                schedule_pressure: 0,
                complexity_indicators: {
                    high_centrality_tasks: 0,
                    community_groups: 0
                },
                risk_concentrations: []
            },
            sample_high_risk_activities: []
        };
    }

    // ---- Calculate project timeline efficiently -----------------------------
    const validStarts = [];
    const validFinishes = [];
    let criticalActivities = 0;
    let highRiskActivities = 0;
    let highImportanceActivities = 0;
    let completedActivities = 0;
    let totalProgress = 0;
    let highCentralityTasks = 0;
    const communityGroupSet = new Set();

    // Single pass through nodes to collect metrics
    nodes.forEach(n => {
        const start = toDateSafe(n.Start);
        const finish = toDateSafe(n.Finish);
        if (start) validStarts.push(start);
        if (finish) validFinishes.push(finish);

        if (n?.isOnCriticalPath === true) criticalActivities++;
        if (toNum(n?.riskScore) > 0.7) highRiskActivities++;
        if (toNum(n?.importanceScore) > 0.7) highImportanceActivities++;
        if (clampPct(n?.PercentComplete) >= 100) completedActivities++;
        totalProgress += clampPct(n?.PercentComplete);
        if (toNum(n?.betweenness) > 100) highCentralityTasks++;

        const cg = toNum(n?.CommunityGroup);
        if (Number.isFinite(cg) && cg >= 0) communityGroupSet.add(cg);
    });

    const startDate = validStarts.length > 0 ? new Date(Math.min(...validStarts)) : window.cybereumState.dataDate || new Date();
    const endDate = validFinishes.length > 0 ? new Date(Math.max(...validFinishes)) : startDate;
    const totalDurationDays = Math.max(1, daysBetween(startDate, endDate));
    const progressPercent = nodes.length > 0 ? totalProgress / nodes.length : 0;

    // ---- Smart node selection for API context ------------------------------
    // Prioritize nodes: critical path > high risk > high importance > centrality
    const scoredNodes = nodes.map(n => ({
        node: n,
        score: (n?.isOnCriticalPath ? 1000 : 0) +
            (toNum(n?.riskScore) * 100) +
            (toNum(n?.importanceScore) * 50) +
            (toNum(n?.betweenness) / 10)
    }));

    scoredNodes.sort((a, b) => b.score - a.score);
    const prioritizedNodes = scoredNodes.slice(0, MAX_SAMPLE_NODES).map(s => s.node);

    // ---- Efficient categorization -------------------------------------------
    const categoryMap = new Map();

    prioritizedNodes.forEach(node => {
        const name = String(node.Name || "").toLowerCase();
        const category = categorizeByName(name);

        if (!categoryMap.has(category)) {
            categoryMap.set(category, {
                count: 0,
                total_duration: 0,
                critical_count: 0,
                total_risk: 0,
                high_risk_count: 0,
                examples: []
            });
        }

        const cat = categoryMap.get(category);
        cat.count++;
        cat.total_duration += toNum(node.Duration);
        if (node.isOnCriticalPath) cat.critical_count++;
        const risk = toNum(node.riskScore);
        cat.total_risk += risk;
        if (risk > 0.7) cat.high_risk_count++;
        if (cat.examples.length < 2) cat.examples.push(node.Name);
    });

    // Convert to array and calculate averages
    const totalDuration = Array.from(categoryMap.values()).reduce((sum, cat) => sum + cat.total_duration, 0);
    const workCategoriesArray = Array.from(categoryMap.entries())
        .map(([category, data]) => ({
            category,
            count: data.count,
            duration_percent: totalDuration > 0 ? (data.total_duration / totalDuration * 100) : 0,
            critical_count: data.critical_count,
            avg_risk: data.count > 0 ? data.total_risk / data.count : 0,
            high_risk_count: data.high_risk_count,
            examples: data.examples
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_WORK_CATEGORIES);

    // ---- Schedule pressure calculation --------------------------------------
    const slackThreshold = 40;
    const lowSlackCount = nodes.filter(n => toNum(n?.slack) < slackThreshold).length;
    const schedulePressure = nodes.length > 0 ? lowSlackCount / nodes.length : 0;

    // ---- Risk concentrations ------------------------------------------------
    const riskConcentrations = workCategoriesArray
        .filter(cat => cat.high_risk_count > 0)
        .map(cat => ({
            category: cat.category,
            high_risk_count: cat.high_risk_count,
            avg_risk: cat.avg_risk
        }))
        .slice(0, MAX_RISK_CONCENTRATIONS);

    // ---- Sample high-risk activities ---------------------------------------
    const sampleHighRisk = prioritizedNodes
        .filter(n => toNum(n?.riskScore) > 0.7)
        .slice(0, MAX_HIGH_RISK_SAMPLES)
        .map(n => ({
            id: String(n?.ID ?? ""),
            name: n?.Name ?? "",
            category: categorizeByName(String(n?.Name || "").toLowerCase()),
            internal_risk: Number(toNum(n?.riskScore).toFixed(2)),
            is_critical: Boolean(n?.isOnCriticalPath),
            duration_days: Math.max(0, Math.round(toNum(n?.Duration) / 8))
        }));

    // ---- Calculate schedule months ------------------------------------------
    const msPerMonth = 1000 * 60 * 60 * 24 * 30.4375;
    const scheduleMonths = Math.max(0, (endDate - startDate) / msPerMonth);

    // ---- Build compact payload ---------------------------------------------
    const capexUSD = Math.max(0, toNum(meta?.baseline?.capex_usd));

    return {
        project: {
            sector: meta.sector || "General",
            subsector: meta.subsector || "",
            region: meta.region || "General",
            country: meta.country || "General",
            phase: meta.phase || "Execution",
            timeline: {
                start: startDate.toISOString().split('T')[0],
                end: endDate.toISOString().split('T')[0],
                duration_days: totalDurationDays,
                progress_percent: Math.round(progressPercent)
            },
            scale: {
                total_activities: nodes.length,
                analyzed_activities: prioritizedNodes.length,
                critical_path_activities: criticalActivities,
                high_internal_risk_activities: highRiskActivities,
                high_importance_activities: highImportanceActivities,
                completed_activities: completedActivities,
                estimated_capex: capexUSD
            },
            baseline: {
                capex_usd: capexUSD,
                schedule_months: Math.round(scheduleMonths * 10) / 10
            }
        },
        work_categories: workCategoriesArray,
        internal_risk_indicators: {
            critical_path_risk: nodes.length > 0 ? criticalActivities / nodes.length : 0,
            schedule_pressure: schedulePressure,
            complexity_indicators: {
                high_centrality_tasks: highCentralityTasks,
                community_groups: communityGroupSet.size
            },
            risk_concentrations: riskConcentrations
        },
        sample_high_risk_activities: sampleHighRisk
    };
}

function categorizeActivities(nodes) {
    const categories = {};

    // OPTIMIZATION: Calculate total duration ONCE, not per-category
    const totalDuration = nodes.reduce((sum, n) => sum + (Number.isFinite(+n.Duration) ? +n.Duration : 0), 0);

    nodes.forEach(node => {
        const name = String(node.Name || "").toLowerCase();
        const duration = Number.isFinite(+node.Duration) ? +node.Duration : 0;
        const isCritical = !!(node.isOnCriticalPath);
        const riskScore = Number.isFinite(+node.riskScore) ? +node.riskScore : 0;

        let category = categorizeByName(name);

        if (!categories[category]) {
            categories[category] = {
                count: 0,
                total_duration: 0,
                critical_count: 0,
                avg_risk: 0,
                high_risk_count: 0,
                examples: []
            };
        }

        const cat = categories[category];
        cat.count++;
        cat.total_duration += duration;
        if (isCritical) cat.critical_count++;
        cat.avg_risk += riskScore;
        if (riskScore > 0.7) cat.high_risk_count++;

        if (cat.examples.length < 3) {
            cat.examples.push(node.Name);
        }
    });

    // OPTIMIZATION: Use pre-computed totalDuration
    Object.keys(categories).forEach(key => {
        const cat = categories[key];
        cat.avg_risk = cat.count > 0 ? cat.avg_risk / cat.count : 0;
        cat.duration_percent = totalDuration > 0 ? (cat.total_duration / totalDuration) * 100 : 0;
    });

    return categories;
}

const CATEGORY_PATTERNS = {
    'Design & Engineering': /design|engineer|plan|draft|calculation|specification/,
    'Permits & Approvals': /permit|approval|regulatory|compliance|inspection|certificate|tceq|epa/,
    'Procurement': /purchase|procure|order|vendor|supplier|material|equipment/,
    'Site Preparation': /site|clear|excavat|grading|survey|access|temporary/,
    'Foundation': /foundation|footing|concrete|pile|earthwork/,
    'Structural': /structural|steel|erect|frame|column|beam|truss/,
    'Mechanical': /mechanical|piping|pipe|vessel|tank|pump|compressor|heat exchanger/,
    'Electrical': /electrical|cable|wire|transformer|switchgear|mcc|substation/,
    'Instrumentation': /instrument|control|dcs|plc|analyzer|transmitter/,
    'Installation': /install|mount|set|place|rig/,
    'Testing & Commissioning': /test|commission|punch|checkout|loop|hydro|pneumatic|pre-startup/,
    'Startup': /startup|start-up|performance|guarantee|ramp/,
    'Process Equipment': /reactor|cracker|furnace|heater|fractionator|distillation|column|tower/,
    'Rotating Equipment': /compressor|turbine|pump|motor|driver|gearbox/,
    'Utilities & Offsites': /utility|offsite|cooling tower|boiler|flare|waste|water treatment|fire/,
    'Piperack & Headers': /piperack|pipe rack|header|manifold|tie-in/,
    'Insulation & Fireproofing': /insulation|fireproof|coating|paint|heat trace/,
    'Civil Works': /civil|road|paving|drainage|underground|duct bank/,
    'Handover': /handover|turnover|substantial|mechanical completion|rfsu/
};

// Pre-compute entries array for faster iteration (avoid Object.entries() overhead per call)
const CATEGORY_PATTERN_ENTRIES = Object.entries(CATEGORY_PATTERNS);

/**
 * OPTIMIZED categorizeByName - uses hoisted patterns
 * Performance: ~5-10x faster for cache misses
 */
function categorizeByName(name) {
    // Check cache first
    if (_categoryCache.has(name)) {
        return _categoryCache.get(name);
    }

    // Use pre-computed pattern entries (no Object.entries() call)
    let result = 'Other';
    for (let i = 0; i < CATEGORY_PATTERN_ENTRIES.length; i++) {
        const [category, pattern] = CATEGORY_PATTERN_ENTRIES[i];
        if (pattern.test(name)) {
            result = category;
            break;
        }
    }

    // Cache result (with size limit)
    if (_categoryCache.size < CATEGORY_CACHE_MAX) {
        _categoryCache.set(name, result);
    }

    return result;
}

/**
 * STEP 3: Generate mitigation activities from risk register
 */
async function generateMitigationActivities(risk_register, existingNodes, projectMeta) {
    try {
        console.log("Generating mitigation activities from risk register...");

        const payload = {
            risks: risk_register.map(risk => ({
                id: risk.id,
                name: risk.name,
                type: risk.type,
                description: risk.description,
                mitigation_strategies: risk.mitigation_strategies || [],
                probability: risk.probability,
                cost_impact: risk.cost_impact,
                schedule_impact: risk.schedule_impact
            })),
            existing_schedule: {
                project_meta: projectMeta,
                key_activities: existingNodes.slice(0, 20).map(node => ({
                    id: node.ID,
                    name: node.Name,
                    category: categorizeByName(String(node.Name || "").toLowerCase()),
                    start: node.Start,
                    finish: node.Finish,
                    critical: node.isOnCriticalPath,
                    duration: node.Duration
                })),
                total_activities: existingNodes.length,
                project_start: Math.min(...existingNodes.map(n => new Date(n.Start).getTime())),
                project_end: Math.max(...existingNodes.map(n => new Date(n.Finish).getTime()))
            }
        };

        const response = await fetch('/OpenAI/GenerateMitigationActivities', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.warn("Mitigation activity generation failed");
            return generateBasicMitigationActivities(risk_register);
        }

        const result = await response.json();
        console.log(`Generated ${result.mitigation_activities?.length || 0} mitigation activities`);
        return result;

    } catch (error) {
        console.warn("Mitigation activity generation error:", error);
        return generateBasicMitigationActivities(risk_register);
    }
}

/**
 * Generate basic mitigation activities when LLM fails
 */
function generateBasicMitigationActivities(risk_register) {
    const activities = [];
    let activityId = 9000; // Start with high ID to avoid conflicts

    risk_register.forEach(risk => {
        // Basic mitigation activity for each risk
        activities.push({
            id: `MIT-${risk.id}`,
            name: `Mitigate: ${risk.name}`,
            description: `Mitigation activities for ${risk.name}`,
            type: "mitigation",
            risk_id: risk.id,
            risk_name: risk.name,
            duration: 40, // Default 5 days
            resource_requirements: ["Project Manager", "Risk Specialist"],
            estimated_cost: Math.round(risk.cost_impact * risk.probability * 10000), // Simple cost estimate
            timing: "early", // early, ongoing, or responsive
            predecessors: [],
            successors: [],
            deliverables: ["Risk mitigation plan", "Implementation checklist"]
        });
        activityId++;
    });

    return {
        mitigation_activities: activities,
        implementation_guidance: "Basic mitigation activities generated. Review and customize based on project needs."
    };
}

/**
 * Integrate mitigation activities into existing schedule
 */
function integrateMitigationActivities(existingNodes, mitigationResult, projectMeta) {
    console.log("Integrating mitigation activities into schedule...");

    const { mitigation_activities } = mitigationResult;
    if (!mitigation_activities || mitigation_activities.length === 0) {
        console.log("No mitigation activities to integrate");
        return existingNodes;
    }

    // Find key milestone activities for predecessor/successor logic
    const startMilestone = existingNodes.find(n => n.Name.toLowerCase().includes('start'));
    const endMilestone = existingNodes.find(n => n.Name.toLowerCase().includes('end'));
    const designActivities = existingNodes.filter(n =>
        categorizeByName(String(n.Name || "").toLowerCase()) === 'Design & Engineering'
    );
    const procurementActivities = existingNodes.filter(n =>
        categorizeByName(String(n.Name || "").toLowerCase()) === 'Procurement'
    );

    const projectStart = new Date(Math.min(...existingNodes.map(n => new Date(n.Start).getTime())));
    const projectEnd = new Date(Math.max(...existingNodes.map(n => new Date(n.Finish).getTime())));

    // Convert mitigation activities to schedule format
    const newActivities = mitigation_activities.map(mitigation => {
        const startDate = calculateMitigationStartDate(mitigation, projectStart, projectEnd, existingNodes);
        const endDate = new Date(startDate.getTime() + (mitigation.duration || 40) * 60 * 60 * 1000);

        // Determine predecessors based on timing and type
        const predecessors = determineMitigationPredecessors(mitigation, existingNodes, startMilestone, designActivities);
        const successors = determineMitigationSuccessors(mitigation, existingNodes, endMilestone, procurementActivities);

        return {
            ID: mitigation.id,
            Name: mitigation.name,
            Duration: mitigation.duration || 40,
            Start: startDate.toISOString(),
            Finish: endDate.toISOString(),
            PercentComplete: 0,
            TimeUnits: "Hours",
            TaskType: "Mitigation",

            // NEW: make explicit for renderers/filters
            NodeType: "Activity",

            // Mitigation-specific properties
            isMitigationActivity: true,
            riskId: mitigation.risk_id,
            riskName: mitigation.risk_name,
            mitigationType: mitigation.type,
            estimatedCost: mitigation.estimated_cost || 0,
            resourceRequirements: mitigation.resource_requirements || [],
            deliverables: mitigation.deliverables || [],

            // Standard properties
            Milestone: 0,
            isOnCriticalPath: mitigation.timing === 'critical',
            riskScore: 0.3, // Mitigation activities have moderate inherent risk
            importanceScore: 0.8, // High importance for risk management

            // Dependency information
            suggestedPredecessors: predecessors,
            suggestedSuccessors: successors,
            integrationNotes: generateIntegrationNotes(mitigation, predecessors, successors)
        };
    });

    console.log(`Created ${newActivities.length} mitigation activities for integration drawGraph`, newActivities);
    return [...existingNodes, ...newActivities];
}

/**
 * Calculate appropriate start date for mitigation activity
 */
function calculateMitigationStartDate(mitigation, projectStart, projectEnd, existingNodes) {
    const projectDuration = projectEnd.getTime() - projectStart.getTime();

    switch (mitigation.timing) {
        case 'early':
            // Start early in project (10-20% through)
            return new Date(projectStart.getTime() + projectDuration * 0.15);

        case 'ongoing':
            // Start in middle of project (40-60% through)
            return new Date(projectStart.getTime() + projectDuration * 0.5);

        case 'responsive':
            // Start later in project (70-80% through) when risks typically manifest
            return new Date(projectStart.getTime() + projectDuration * 0.75);

        default:
            // Default to early timing
            return new Date(projectStart.getTime() + projectDuration * 0.1);
    }
}

/**
 * Determine logical predecessors for mitigation activity
 */
function determineMitigationPredecessors(mitigation, existingNodes, startMilestone, designActivities) {
    const predecessors = [];

    // All activities should follow project start
    if (startMilestone) {
        predecessors.push(startMilestone.ID);
    }

    // Risk-specific predecessor logic
    if (mitigation.risk_name.toLowerCase().includes('regulatory') ||
        mitigation.risk_name.toLowerCase().includes('permit')) {
        // Regulatory mitigations should follow design activities
        if (designActivities.length > 0) {
            predecessors.push(designActivities[0].ID);
        }
    }

    if (mitigation.risk_name.toLowerCase().includes('supply') ||
        mitigation.risk_name.toLowerCase().includes('material')) {
        // Supply chain mitigations should be early but after initial planning
        const planningActivities = existingNodes.filter(n =>
            n.Name.toLowerCase().includes('plan') && !n.Name.toLowerCase().includes('install')
        );
        if (planningActivities.length > 0) {
            predecessors.push(planningActivities[0].ID);
        }
    }

    return predecessors;
}

/**
 * Determine logical successors for mitigation activity
 */
function determineMitigationSuccessors(mitigation, existingNodes, endMilestone, procurementActivities) {
    const successors = [];

    // Risk-specific successor logic
    if (mitigation.risk_name.toLowerCase().includes('supply') ||
        mitigation.risk_name.toLowerCase().includes('procurement')) {
        // Supply risk mitigations should complete before procurement
        procurementActivities.forEach(activity => {
            successors.push(activity.ID);
        });
    }

    if (mitigation.timing === 'early') {
        // Early mitigations should complete before major construction activities
        const constructionActivities = existingNodes.filter(n =>
            n.Name.toLowerCase().includes('install') ||
            n.Name.toLowerCase().includes('construct') ||
            n.Name.toLowerCase().includes('build')
        );
        if (constructionActivities.length > 0) {
            successors.push(constructionActivities[0].ID);
        }
    }

    return successors;
}

/**
 * Generate integration notes for the mitigation activity
 */
function generateIntegrationNotes(mitigation, predecessors, successors) {
    const notes = [];

    notes.push(`Mitigation for: ${mitigation.risk_name}`);

    if (predecessors.length > 0) {
        notes.push(`Should start after activities: ${predecessors.join(', ')}`);
    }

    if (successors.length > 0) {
        notes.push(`Should complete before activities: ${successors.join(', ')}`);
    }

    if (mitigation.deliverables && mitigation.deliverables.length > 0) {
        notes.push(`Deliverables: ${mitigation.deliverables.join(', ')}`);
    }

    return notes.join('; ');
}

/**
 * Enhanced main function that includes mitigation activities
 */
// Cache implementation
const riskCache = {
    assessments: new Map(),
    mappings: new Map(),
    mitigations: new Map(),

    getCacheKey(nodes, meta) {
        // Create cache key from essential project characteristics
        const nodeCount = nodes.length;
        const criticalCount = nodes.filter(n => n.isOnCriticalPath).length;
        const avgProgress = nodes.reduce((s, n) => s + (Number(n.PercentComplete) || 0), 0) / Math.max(1, nodes.length);
        return `${meta.sector}_${meta.region}_${nodeCount}_${criticalCount}_${Math.round(avgProgress)}`;
    },

    get(type, key) {
        const cache = this[type];
        if (!cache) return null;

        const entry = cache.get(key);
        if (!entry) return null;

        // Cache expires after 5 minutes
        if (Date.now() - entry.timestamp > 5 * 60 * 1000) {
            cache.delete(key);
            return null;
        }

        console.log(`Cache hit for ${type}: ${key}`);
        return entry.data;
    },

    set(type, key, data) {
        const cache = this[type];
        if (!cache) return;

        // Limit cache size
        if (cache.size > 10) {
            const firstKey = cache.keys().next().value;
            cache.delete(firstKey);
        }

        cache.set(key, {
            data,
            timestamp: Date.now()
        });
        console.log(`Cached ${type}: ${key}`);
    },

    clear() {
        this.assessments.clear();
        this.mappings.clear();
        this.mitigations.clear();
    }
};

async function assessProjectExternalRisks(nodes, links, meta) {
    console.log('=== EXTERNAL RISK ASSESSMENT STARTING ===');
    const startTime = performance.now();

    // Use CybereumInsightsLoader if available AND not already showing another pipeline.
    // When called from the import pipeline, the import loader is already active and
    // shows "Assessing external risks" as its own step — starting a new loader here
    // would hijack the singleton, and its finish()/hide() would kill the import overlay.
    const useLoader = typeof window.CybereumInsightsLoader1 !== 'undefined'
        && !window.CybereumInsightsLoader1.isActive();
    const loader = useLoader ? window.CybereumInsightsLoader1 : null;

    // Define steps for the loader
    const steps = [
        { name: 'Initialize risk assessment pipeline', optional: false },
        { name: 'Generate external risk register (AI)', optional: false },
        { name: 'Map risks to activities (AI)', optional: true },
        { name: 'Generate mitigation strategies (AI)', optional: true },
        { name: 'Calculate risk scores', optional: false },
        { name: 'Build risk visualization graph', optional: false }
    ];

    if (loader) {
        loader.start('External Risk Assessment', steps, {
            heading: 'CYBEREUM RISK INTELLIGENCE',
            phase: 'INITIALIZING',
            sources: [
                { id: 'schedule', name: 'Schedule Data' },
                { id: 'ai-risk', name: 'AI Risk Engine' },
                { id: 'external', name: 'External Signals' }
            ]
        });
    }

    // Legacy loading element fallback
    const loadingEl = document.getElementById('externalRiskLoadingIndicator');
    if (loadingEl && !loader) {
        loadingEl.style.display = 'block';
        loadingEl.textContent = 'Analyzing external risks...';
    }

    try {
        // STEP 0: Initialize
        if (loader) {
            await loader.runStep(0, async () => {
                console.log(`Processing ${nodes.length} activities`);
                loader.markSource('schedule', true);
                return true;
            }, { workingText: 'LOADING DATA' });
        }

        // Check cache first
        const cacheKey = riskCache.getCacheKey(nodes, meta);
        const cachedAssessment = riskCache.get('assessments', cacheKey);

        let riskAssessment;

        // STEP 1: Get risk register
        if (loader) {
            loader.setPhase('RISK GENERATION');
            const result = await loader.runStep(1, async () => {
                if (cachedAssessment) {
                    console.log('Using cached risk assessment');
                    return cachedAssessment;
                }

                loader.markSource('ai-risk', true);
                console.time('Risk Register Fetch');
                const assessment = await getExternalRiskRegister(nodes, links, meta);
                console.timeEnd('Risk Register Fetch');

                if (assessment.risk_register && assessment.risk_register.length > 0) {
                    riskCache.set('assessments', cacheKey, assessment);
                }
                return assessment;
            }, { workingText: 'GENERATING', doneText: 'GENERATED' });

            riskAssessment = result.result;
        } else {
            if (cachedAssessment) {
                riskAssessment = cachedAssessment;
            } else {
                riskAssessment = await getExternalRiskRegister(nodes, links, meta);
                if (riskAssessment.risk_register && riskAssessment.risk_register.length > 0) {
                    riskCache.set('assessments', cacheKey, riskAssessment);
                }
            }
        }

        // Check if we got risks
        if (!riskAssessment || !riskAssessment.risk_register || riskAssessment.risk_register.length === 0) {
            console.warn("No external risks returned - initializing empty");

            if (loader) {
                loader.markStep(2, 'skipped', 'NO RISKS');
                loader.markStep(3, 'skipped', 'NO RISKS');
                loader.markStep(4, 'done', 'COMPLETE');
                loader.markStep(5, 'done', 'COMPLETE');
                loader.finish(1500, 'NO EXTERNAL RISKS');
            }

            window.cybereumState = window.cybereumState || {};
            window.cybereumState.riskGraph = { riskNodes: [], riskLinks: [] };
            window.cybereumState.externalSignalSnapshot = normalizeExternalSignalSnapshot(riskAssessment?.external_signal_snapshot);

            return {
                enrichedNodes: initializeEmptyExternalRisks(nodes),
                risk_register: [],
                riskNodes: [],
                riskLinks: [],
                mitigationResult: null,
                external_signal_snapshot: window.cybereumState.externalSignalSnapshot
            };
        }

        console.log(`Received ${riskAssessment.risk_register.length} external risks`);

        // STEP 2 & 3: Parallel mapping and mitigation
        if (loader) {
            loader.setPhase('RISK MAPPING');
            loader.markSource('market', true);
        }

        let mappingResultValue = null;
        let mitigationResultValue = null;

        // STEP 2: Intelligent mapping
        if (loader) {
            const mapResult = await loader.runStep(2, async () => {
                const mappingKey = `${cacheKey}_mapping`;
                const cached = riskCache.get('mappings', mappingKey);
                if (cached) return cached;

                const result = await getIntelligentRiskMappings(
                    riskAssessment.risk_register,
                    nodes,
                    meta
                );
                riskCache.set('mappings', mappingKey, result);
                return result;
            }, { workingText: 'MAPPING', doneText: 'MAPPED' });

            if (mapResult.success && !mapResult.skipped) {
                mappingResultValue = mapResult.result;
            }
        } else {
            try {
                const mappingKey = `${cacheKey}_mapping`;
                const cached = riskCache.get('mappings', mappingKey);
                if (cached) {
                    mappingResultValue = cached;
                } else {
                    mappingResultValue = await getIntelligentRiskMappings(
                        riskAssessment.risk_register,
                        nodes,
                        meta
                    );
                    riskCache.set('mappings', mappingKey, mappingResultValue);
                }
            } catch (e) {
                console.warn('Mapping failed:', e);
            }
        }

        // STEP 3: Mitigation generation
        if (loader) {
            const mitResult = await loader.runStep(3, async () => {
                const mitigationKey = `${cacheKey}_mitigation`;
                const cached = riskCache.get('mitigations', mitigationKey);
                if (cached) return cached;

                const result = await generateMitigationActivities(
                    riskAssessment.risk_register,
                    nodes,
                    meta
                );
                riskCache.set('mitigations', mitigationKey, result);
                window.cybereumState.mitigationResult = result;
                return result;
            }, { workingText: 'GENERATING', doneText: 'GENERATED' });

            if (mitResult.success && !mitResult.skipped) {
                mitigationResultValue = mitResult.result;
            }
        } else {
            try {
                const mitigationKey = `${cacheKey}_mitigation`;
                const cached = riskCache.get('mitigations', mitigationKey);
                if (cached) {
                    mitigationResultValue = cached;
                } else {
                    mitigationResultValue = await generateMitigationActivities(
                        riskAssessment.risk_register,
                        nodes,
                        meta
                    );
                    riskCache.set('mitigations', mitigationKey, mitigationResultValue);
                    window.cybereumState.mitigationResult = mitigationResultValue;
                }
            } catch (e) {
                console.warn('Mitigation generation failed:', e);
            }
        }

        // STEP 4: Apply risks and calculate scores
        if (loader) {
            loader.setPhase('SCORE CALCULATION');
        }

        let enrichedNodes;
        let mappingMethod = 'unknown';

        const applyRisks = async () => {
            if (mappingResultValue) {
                console.log('Applying intelligent mappings...');
                mappingMethod = 'intelligent';

                enrichedNodes = applyRisksToActivitiesIntelligent(
                    nodes,
                    riskAssessment.risk_register,
                    mappingResultValue
                );

                const mappedCount = enrichedNodes.filter(n => n.externalRisks && n.externalRisks.length > 0).length;

                if (mappedCount === 0) {
                    console.warn('Intelligent mapping produced no results, falling back to basic');
                    mappingMethod = 'basic-fallback';
                    enrichedNodes = applyRisksToActivities(nodes, riskAssessment);
                }
            } else {
                console.warn('No intelligent mappings available, using basic');
                mappingMethod = 'basic';
                enrichedNodes = applyRisksToActivities(nodes, riskAssessment);
            }

            return enrichedNodes;
        };

        if (loader) {
            await loader.runStep(4, applyRisks, { workingText: 'CALCULATING', doneText: 'CALCULATED' });
        } else {
            await applyRisks();
        }

        // Emergency fallback if still no results
        const affectedActivities = enrichedNodes.filter(n => n.externalRisks && n.externalRisks.length > 0);

        if (affectedActivities.length === 0 && riskAssessment.risk_register.length > 0) {
            console.warn('No activities mapped, applying emergency fallback');
            mappingMethod = 'emergency';

            const criticalPathNodes = enrichedNodes.filter(n => n.isOnCriticalPath);
            const targetNodes = criticalPathNodes.length > 0 ? criticalPathNodes : enrichedNodes.slice(0, 10);

            targetNodes.forEach(node => {
                node.externalRisks = [];
                riskAssessment.risk_register.slice(0, 3).forEach(risk => {
                    const baseScore = 0.3;
                    const criticalBonus = node.isOnCriticalPath ? 0.2 : 0;
                    const influenceScore = baseScore + criticalBonus;

                    node.externalRisks.push({
                        id: risk.id,
                        name: risk.name,
                        type: risk.type,
                        description: risk.description || '',
                        probability: risk.probability,
                        cost_impact: risk.cost_impact,
                        schedule_impact: risk.schedule_impact,
                        influence_score: influenceScore,
                        reasoning: 'Emergency fallback - critical risk to critical activity',
                        confidence: (typeof risk.confidence === 'number') ? risk.confidence : 0.5,
                        weighted_cost_impact: risk.probability * risk.cost_impact * influenceScore,
                        weighted_schedule_impact: risk.probability * risk.schedule_impact * influenceScore
                    });
                });

                node.externalCostRisk = Math.max(...node.externalRisks.map(r => r.weighted_cost_impact));
                node.externalScheduleRisk = Math.max(...node.externalRisks.map(r => r.weighted_schedule_impact));
                node.externalRiskScore = Math.max(node.externalCostRisk, node.externalScheduleRisk);
                // Confidence propagation
                var _wcs = 0, _iws = 0;
                node.externalRisks.forEach(function (r) {
                    var _imp = Math.max(r.weighted_cost_impact, r.weighted_schedule_impact);
                    var _conf = typeof r.confidence === 'number' ? r.confidence : 0.5;
                    _wcs += _conf * _imp; _iws += _imp;
                });
                node.externalRiskConfidence = _iws > 0 ? _wcs / _iws : 0.5;
            });
        }

        // STEP 5: Build visualization graph
        if (loader) {
            loader.setPhase('VISUALIZATION');
        }

        const buildGraph = async () => {
            const { riskNodes, riskLinks } = materializeRiskGraph(
                riskAssessment.risk_register,
                enrichedNodes,
                riskAssessment
            );

            window.cybereumState = window.cybereumState || {};
            window.cybereumState.riskGraph = { riskNodes, riskLinks };

            return { riskNodes, riskLinks };
        };

        let graphResult;
        if (loader) {
            const stepResult = await loader.runStep(5, buildGraph, { workingText: 'BUILDING', doneText: 'COMPLETE' });
            graphResult = stepResult.result;
        } else {
            graphResult = await buildGraph();
        }

        // Complete
        const elapsed = Math.round(performance.now() - startTime);
        const finalAffected = enrichedNodes.filter(n => n.externalRisks && n.externalRisks.length > 0).length;

        console.log(`=== EXTERNAL RISK ASSESSMENT COMPLETE ===`);
        console.log(`Total time: ${elapsed}ms`);
        console.log(`Risks: ${riskAssessment.risk_register.length}, Affected activities: ${finalAffected}`);
        console.log(`Mapping method: ${mappingMethod}`);

        if (loader) {
            loader.finish(1000, `${riskAssessment.risk_register.length} RISKS ANALYZED`);
        }

        if (loadingEl) {
            loadingEl.style.display = 'none';
        }

        const externalSignalSnapshot = normalizeExternalSignalSnapshot(riskAssessment.external_signal_snapshot);
        if (window.cybereumState) {
            window.cybereumState.externalSignalSnapshot = externalSignalSnapshot;
            updateCompoundRiskState();
        }

        return {
            enrichedNodes,
            risk_register: riskAssessment.risk_register,
            riskNodes: graphResult.riskNodes,
            riskLinks: graphResult.riskLinks,
            mitigationResult: mitigationResultValue,
            external_signal_snapshot: externalSignalSnapshot,
            mappingMethod,
            stats: {
                totalRisks: riskAssessment.risk_register.length,
                affectedActivities: finalAffected,
                totalActivities: nodes.length,
                elapsed
            }
        };

    } catch (error) {
        console.error('External risk assessment failed:', error);

        if (loader) {
            loader.status('ERROR');
            loader.setPhase('FAILED');
            setTimeout(() => loader.hide(), 3000);
        }

        if (loadingEl) {
            loadingEl.style.display = 'none';
        }

        window.cybereumState = window.cybereumState || {};
        window.cybereumState.riskGraph = { riskNodes: [], riskLinks: [] };
        window.cybereumState.externalSignalSnapshot = null;

        return {
            enrichedNodes: initializeEmptyExternalRisks(nodes),
            risk_register: [],
            riskNodes: [],
            riskLinks: [],
            mitigationResult: null,
            external_signal_snapshot: null,
            error: error.message
        };
    }
}

function displayMitigationActivities(mitigation_activities, risk_register) {
    console.log("Displaying mitigation activities with dependencies...");

    const tableBody = document.getElementById('mitigationActivitiesTableBody');
    if (!tableBody) {
        console.warn("Mitigation activities table body not found");
        return;
    }

    const scheduleNodes = Array.isArray(window.cybereumState?.nodes) ? window.cybereumState.nodes : [];
    const validNodeIds = new Set(scheduleNodes.map(n => String(n.ID)));
    tableBody.innerHTML = '';

    mitigation_activities.forEach((activity, idx) => {
        const normalized = {
            ...activity,
            id: activity.id || `MIT-${idx + 1}`,
            name: cleanMitigationText(activity.name || `Mitigation ${idx + 1}`),
            description: cleanMitigationText(activity.description || ''),
            type: String(activity.type || 'mitigation').toLowerCase(),
            duration: Math.max(4, Math.min(240, Number(activity.duration || 40))),
            recommended_predecessors: Array.isArray(activity.recommended_predecessors) ? activity.recommended_predecessors.map(String) : [],
            recommended_successors: Array.isArray(activity.recommended_successors) ? activity.recommended_successors.map(String) : []
        };

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${normalized.id}</td>
            <td><input data-field="name" value="${escapeHtml(normalized.name)}" style="width:220px;" /></td>
            <td>${escapeHtml(normalized.risk_name || '')}</td>
            <td>
                <select data-field="type">
                    ${['mitigation', 'prevention', 'contingency', 'monitoring'].map(t => `<option value="${t}" ${normalized.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                </select>
            </td>
            <td><input data-field="duration" type="number" min="4" max="240" step="4" value="${normalized.duration}" style="width:90px;" /> hrs</td>
            <td><input data-field="predecessors" value="${escapeHtml(normalized.recommended_predecessors.join(', '))}" style="width:170px;" /></td>
            <td><input data-field="successors" value="${escapeHtml(normalized.recommended_successors.join(', '))}" style="width:170px;" /></td>
            <td><input data-field="resources" value="${escapeHtml((normalized.resource_requirements || []).slice(0, 3).join(', '))}" style="width:200px;" /></td>
            <td><button class="learn-more-btn mitigation-accept-btn">Accept</button></td>
        `;

        row.querySelector('.mitigation-accept-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            const value = field => row.querySelector(`[data-field="${field}"]`)?.value || '';
            const parseIds = (raw) => [...new Set(String(raw || '').split(',').map(v => v.trim()).filter(v => validNodeIds.has(v)))];

            const accepted = {
                ...normalized,
                id: String(normalized.id),
                name: cleanMitigationText(value('name')) || normalized.name,
                type: String(value('type') || normalized.type),
                duration: Math.max(4, Math.min(240, Number(value('duration') || normalized.duration || 40))),
                resource_requirements: String(value('resources')).split(',').map(v => cleanMitigationText(v)).filter(Boolean),
                recommended_predecessors: parseIds(value('predecessors')),
                recommended_successors: parseIds(value('successors'))
            };

            applyAcceptedMitigation(accepted);
            const btn = row.querySelector('.mitigation-accept-btn');
            btn.textContent = 'Accepted';
            btn.disabled = true;
            btn.style.opacity = '0.6';
        });

        row.addEventListener('click', (e) => {
            if (e.target.closest('input,select,button')) return;
            showMitigationDetails(normalized);
        });
        row.style.cursor = 'pointer';

        tableBody.appendChild(row);
    });

    console.log(`Populated mitigation table with ${mitigation_activities.length} activities`);

    // Re-apply edit mode state so new mitigation rows respect current toggle
    ensureExternalRiskTableEditMode();
}

function cleanMitigationText(text) {
    const value = String(text || '').replace(/[\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!value) return '';
    if (/(lorem ipsum|asdf|qwerty|\?\?\?|###|@@@@)/i.test(value)) {
        return 'Refine mitigation with specific owner, timing, and scope.';
    }
    return value;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function applyAcceptedMitigation(activity) {
    window.cybereumState = window.cybereumState || {};
    const accepted = Array.isArray(window.cybereumState.acceptedMitigationActivities)
        ? window.cybereumState.acceptedMitigationActivities
        : [];
    window.cybereumState.acceptedMitigationActivities = [...accepted.filter(a => String(a.id) !== String(activity.id)), activity];

    const nodes = Array.isArray(window.cybereumState.nodes) ? window.cybereumState.nodes : [];
    const links = Array.isArray(window.cybereumState.links) ? window.cybereumState.links : [];

    if (!nodes.some(n => String(n.ID) === String(activity.id))) {
        const baseStart = new Date(Math.min(...nodes.map(n => new Date(n.Start).getTime()).filter(Number.isFinite)) || Date.now());
        const start = new Date(baseStart.getTime() + (48 * 60 * 60 * 1000));
        const finish = new Date(start.getTime() + (activity.duration * 60 * 60 * 1000));
        nodes.push({
            ID: String(activity.id),
            Name: activity.name,
            Start: start.toISOString(),
            Finish: finish.toISOString(),
            Duration: activity.duration,
            TaskType: 'Mitigation',
            NodeType: 'Activity',
            isMitigationActivity: true,
            mitigationType: activity.type,
            riskName: activity.risk_name
        });
    }

    const keySet = new Set(links.map(l => `${l.source}->${l.target}`));
    (activity.recommended_predecessors || []).forEach(pred => {
        const key = `${pred}->${activity.id}`;
        if (!keySet.has(key)) {
            links.push({ source: String(pred), target: String(activity.id), type: 'FS', isMitigationLink: true });
            keySet.add(key);
        }
    });
    (activity.recommended_successors || []).forEach(succ => {
        const key = `${activity.id}->${succ}`;
        if (!keySet.has(key)) {
            links.push({ source: String(activity.id), target: String(succ), type: 'FS', isMitigationLink: true });
            keySet.add(key);
        }
    });

    window.cybereumState.nodes = nodes;
    window.cybereumState.links = links;

    // Persist accepted mitigation to backend
    const projectId = window.cybereumState.projectId || '';
    if (projectId) {
        const riskRegister = window.cybereumState.userRiskRegister || [];
        const allAccepted = window.cybereumState.acceptedMitigationActivities || [];
        const mitigationPayload = { mitigation_activities: allAccepted };
        const nodesWithExtRisk = nodes.filter(n => n.externalRisks && n.externalRisks.length > 0)
            .map(item => ({
                ID: item.ID,
                externalRisks: (item.externalRisks || []).map(i => ({
                    id: i.id,
                    influence_score: i.influence_score || 0,
                    weighted_cost_impact: i.weighted_cost_impact || 0,
                    weighted_schedule_impact: i.weighted_schedule_impact || 0
                })),
                externalRiskScore: item.externalRiskScore,
                externalCostRisk: item.externalCostRisk,
                externalScheduleRisk: item.externalScheduleRisk,
                combinedRiskScore: (typeof item.combinedRiskScore === 'number') ? item.combinedRiskScore : 0,
                externalRiskConfidence: (typeof item.externalRiskConfidence === 'number') ? item.externalRiskConfidence : 0.5
            }));

        $.ajax({
            type: "POST",
            url: "/Project/SaveExternalRisks",
            data: JSON.stringify({
                projectid: projectId,
                risk_register: JSON.stringify(riskRegister),
                mitigationResult: JSON.stringify(mitigationPayload),
                nodes: JSON.stringify(nodesWithExtRisk)
            }),
            contentType: "application/json; charset=utf-8",
            dataType: "json",
            success: function () {
                console.log('[ExtRisks] Mitigation acceptance persisted to backend');
            },
            error: function (err) {
                console.warn('[ExtRisks] Failed to persist mitigation acceptance:', err.responseText);
            }
        });
    }

    window.dispatchEvent(new CustomEvent('mitigationAccepted', { detail: { activity } }));
}

function showMitigationDetails(activity) {
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
        background: rgba(8,31,55,0.85); z-index: 1000; display: flex; 
        align-items: center; justify-content: center;
    `;

    const content = document.createElement('div');
    content.style.cssText = `
        background: linear-gradient(145deg, #0d2137, #143459); color:#cdfaff; padding: 24px; border-radius: 10px; 
        max-width: 680px; max-height: 85vh; overflow-y: auto; border:1px solid #3292cd; box-shadow: 0 0 24px rgba(50,146,205,.45);
    `;

    const predecessors = (activity.recommended_predecessors || []).join(', ');
    const successors = (activity.recommended_successors || []).join(', ');

    content.innerHTML = `
        <h3 style="color:#8ce6ff;">Mitigation Activity: ${escapeHtml(activity.name)}</h3>
        <p><strong>Risk:</strong> ${activity.risk_name}</p>
        <p><strong>Description:</strong> ${escapeHtml(cleanMitigationText(activity.description))}</p>
        <p><strong>Duration:</strong> ${activity.duration} hours</p>
        <p><strong>Estimated Cost:</strong> $${(activity.estimated_cost || 0).toLocaleString()}</p>
        <hr>
        <h4 style="color:#8ce6ff;">Dependencies</h4>
        <p><strong>Predecessors:</strong> ${predecessors || 'None'}</p>
        <p><strong>Successors:</strong> ${successors || 'None'}</p>
        <p><strong>Reasoning:</strong> ${activity.dependency_reasoning || 'Not provided'}</p>
        <hr>
        <h4 style="color:#8ce6ff;">Resources & Deliverables</h4>
        <p><strong>Resources:</strong> ${escapeHtml((activity.resource_requirements || []).join(', ' ))}</p>
        <p><strong>Deliverables:</strong> ${escapeHtml((activity.deliverables || []).join(', ' ))}</p>
        <button onclick="this.parentElement.parentElement.remove()" 
                class="icon-button" style="margin-top: 20px; padding: 8px 12px; background: #113464; color: #cdfaff; border: 1px solid #3292cd; border-radius: 5px; cursor: pointer;">
            Close
        </button>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}
function populateExternalRiskTables(enrichedNodes, risk_register) {
    console.log('RScores === POPULATING TABLES ===');
    console.log(`RScores Input: ${enrichedNodes.length} nodes, ${risk_register.length} risks`);

    // Add a promise wrapper for async notification
    const populateTables = () => {
        // Debug: Check if table elements exist
        const externalRiskTableBody = document.getElementById('externalRiskTableBody');
        const activitiesTableBody = document.getElementById('activitiesExternalRiskTableBody');

        console.log(`RScores External risk table body found: ${!!externalRiskTableBody}`);
        console.log(`RScores Activities table body found: ${!!activitiesTableBody}`);

        // Populate External Risk Register Table
        if (externalRiskTableBody && risk_register && risk_register.length > 0) {
            console.log(`RScores Populating external risk register with ${risk_register.length} risks`);
            externalRiskTableBody.innerHTML = '';

            risk_register.forEach((risk, index) => {
                const normalizedRisk = normalizeRiskRecord(risk, index + 1);
                const affectedCount = enrichedNodes.filter(node =>
                    node.externalRisks && node.externalRisks.some(r => String(r.id) === String(normalizedRisk.id))
                ).length;
                const affectedActivities = enrichedNodes
                    .filter(node => node.externalRisks && node.externalRisks.some(r => String(r.id) === String(normalizedRisk.id)))
                    .map(node => `${node.ID}: ${node.Name}`)
                    .slice(0, 6);
                const hasMoreActivities = affectedCount > affectedActivities.length;

                console.log(`RScores Risk ${index + 1}: ${normalizedRisk.name} affects ${affectedCount} activities`);

                const row = document.createElement('tr');
                const riskTypeClass = String(normalizedRisk.type || 'general').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
                row.innerHTML = `
                    <td>${normalizedRisk.id}</td>
                    <td contenteditable="false" data-field="name"><strong>${normalizedRisk.name}</strong></td>
                    <td><span class="risk-type-badge ${riskTypeClass}">${normalizedRisk.type}</span></td>
                    <td>${(Number(normalizedRisk.probability || 0) * 100).toFixed(1)}%</td>
                    <td>${(Number(normalizedRisk.cost_impact || 0) * 100).toFixed(1)}%</td>
                    <td>${(Number(normalizedRisk.schedule_impact || 0) * 100).toFixed(1)}%</td>
                    <td title="${affectedActivities.join(' | ')}"><strong>${affectedCount}</strong>${affectedActivities.length ? `<div style="font-size:11px;color:#8ce6ff;max-width:280px;">${affectedActivities.join('<br/>')}${hasMoreActivities ? '<br/>…' : ''}</div>` : ''}</td>
                    <td>${normalizedRisk.source || 'LLM'}${Array.isArray(normalizedRisk.source_signals) && normalizedRisk.source_signals.length ? '<div style="font-size:10px;color:#8ce6ff;margin-top:2px;">Signals: ' + normalizedRisk.source_signals.join(', ') + '</div>' : ''}</td>
                    <td title="Driver: ${normalizedRisk.taxonomy?.driver || 'Multi-factor'}">${normalizedRisk.taxonomyLabel}</td>
                    <td style="max-width: 240px; word-wrap: break-word;">${normalizedRisk.manifestation_mechanism || 'Not specified'}</td>
                    <td style="max-width: 300px; word-wrap: break-word;" contenteditable="false" data-field="description">${normalizedRisk.description || 'No description provided'}</td>
                `;
                row.addEventListener('input', () => {
                    const nameCell = row.querySelector('[data-field="name"]');
                    const descCell = row.querySelector('[data-field="description"]');
                    normalizedRisk.name = (nameCell?.textContent || '').trim();
                    normalizedRisk.description = (descCell?.textContent || '').trim();
                    window.cybereumState = window.cybereumState || {};
                    const current = Array.isArray(window.cybereumState.userRiskRegister) ? window.cybereumState.userRiskRegister : [];
                    window.cybereumState.userRiskRegister = mergeRiskRegisters(current.filter(r => String(r.id) !== String(normalizedRisk.id)), [normalizedRisk]);
                });
                externalRiskTableBody.appendChild(row);
            });

            console.log(`RScores External risk table populated with ${externalRiskTableBody.children.length} rows`);
            ensureExternalRiskTableEditMode();
            renderRiskTaxonomyChart(risk_register);
            renderRiskCoverageSummary(enrichedNodes, risk_register, window.cybereumState?.mitigationResult);
        } else {
            console.log(`RScores External risk table not populated. TableBody: ${!!externalRiskTableBody}, Risks: ${risk_register?.length || 0}`);
            renderRiskTaxonomyChart([]);
            renderRiskCoverageSummary(enrichedNodes, [], window.cybereumState?.mitigationResult);
        }

        // Populate Activities with External Risks Table
        if (activitiesTableBody) {
            activitiesTableBody.innerHTML = '';

            const activitiesWithExternalRisks = enrichedNodes.filter(node =>
                node.externalRisks && node.externalRisks.length > 0
            );

            console.log(`RScores Found ${activitiesWithExternalRisks.length} activities with external risks`);

            // Sort by external risk score descending
            activitiesWithExternalRisks.sort((a, b) => (b.externalRiskScore || 0) - (a.externalRiskScore || 0));

            activitiesWithExternalRisks.forEach((node, index) => {
                const riskNames = node.externalRisks.map(risk => risk.name).join(', ');
                const riskTypes = [...new Set(node.externalRisks.map(risk => risk.type))].join(', ');
                const manifestations = [...new Set(node.externalRisks.map(risk => (risk.manifestation_mechanism || risk.reasoning || '').trim()).filter(Boolean))]
                    .slice(0, 2)
                    .join(' | ');

                if (index < 5) { // Log first 5 for debugging
                    console.log(`RScores Activity ${index + 1}: ${node.ID} - ${node.Name} - Risks: ${riskNames}`);
                }

                const row = document.createElement('tr');
                row.innerHTML = `
                <td>${node.ID}</td>
                <td><strong>${node.Name}</strong></td>
                <td style="max-width: 250px; word-wrap: break-word; font-size: 0.9em;" title="${riskNames}">
                    ${riskTypes || 'General'}
                    ${manifestations ? `<div style="font-size:11px;color:#8ce6ff;margin-top:4px;">${manifestations}</div>` : ''}
                </td>
                <td>
                    <div class="risk-score-cell">
                        <span class="score-value">${(node.externalRiskScore || 0).toFixed(3)}</span>
                        <div class="score-bar" style="width: ${(node.externalRiskScore || 0) * 100}%; background-color: ${getRiskColor(node.externalRiskScore || 0)};"></div>
                    </div>
                </td>
                <td>
                    <div class="risk-score-cell">
                        <span class="score-value">${(node.riskScore || 0).toFixed(3)}</span>
                        <div class="score-bar" style="width: ${(node.riskScore || 0) * 100}%; background-color: ${getRiskColor(node.riskScore || 0)};"></div>
                    </div>
                </td>
                <td>${(node.externalCostRisk || 0).toFixed(3)}</td>
                <td>${(node.externalScheduleRisk || 0).toFixed(3)}</td>
                <td><span class="risk-count-badge">${node.externalRisks.length}</span></td>
                <td>${node.isOnCriticalPath ? '<span class="critical-badge">Yes</span>' : 'No'}</td>
            `;

                // Add click handler to show risk details
                row.addEventListener('click', () => showActivityRiskDetails(node));
                row.style.cursor = 'pointer';

                activitiesTableBody.appendChild(row);
            });
            console.log(`RScores Activities table populated with ${activitiesTableBody.children.length} rows`);

            // Add summary info if no activities
            if (activitiesWithExternalRisks.length === 0) {
                const emptyRow = document.createElement('tr');
                emptyRow.innerHTML = '<td colspan="8" style="text-align: center; padding: 20px; color: #666;">No activities with external risks found</td>';
                activitiesTableBody.appendChild(emptyRow);
            }
        } else {
            console.log('RScores Activities table body not found');
        }

        console.log('RScores === TABLE POPULATION COMPLETE ===');

        // Render external signal feed if available
        renderSignalFeed();

        // Dispatch completion event
        window.dispatchEvent(new CustomEvent('externalRiskTablesPopulated', {
            detail: { nodeCount: enrichedNodes.length, riskCount: risk_register.length }
        }));
    };

    // Use requestAnimationFrame for smoother UI updates
    requestAnimationFrame(populateTables);
}

// =============================================================================
// EXTERNAL SIGNAL FEED — renders live signal data in the Risk Matrix UI
// =============================================================================
function renderSignalFeed() {
    var feedRow = document.getElementById('externalSignalFeedRow');
    var tableBody = document.getElementById('signalFeedTableBody');
    var metaSpan = document.getElementById('signalFeedMeta');
    var compoundAlert = document.getElementById('signalCompoundAlert');
    if (!feedRow || !tableBody) return;

    var state = window.cybereumState || {};
    var snapshot = state.externalSignalSnapshot;
    if (!snapshot || !Array.isArray(snapshot.signals) || snapshot.signals.length === 0) {
        feedRow.style.display = 'none';
        return;
    }

    feedRow.style.display = '';
    tableBody.innerHTML = '';

    // Meta info
    if (metaSpan) {
        var parts = [];
        parts.push(snapshot.count + ' signals');
        if (snapshot.generated_at_utc) {
            var d = new Date(snapshot.generated_at_utc);
            parts.push('as of ' + d.toLocaleString());
        }
        if (snapshot.timed_out) parts.push('(partial — timeout)');
        var typeEntries = [];
        if (snapshot.types) {
            Object.keys(snapshot.types).forEach(function (t) { typeEntries.push(t + ': ' + snapshot.types[t]); });
        }
        if (typeEntries.length) parts.push('| ' + typeEntries.join(', '));
        metaSpan.textContent = parts.join(' ');
    }

    // Compound risk alert — reuse precomputed analysis from state
    if (compoundAlert) {
        var compoundData = state.compoundRiskAnalysis;
        if (compoundData && compoundData.hasCompoundRisk && Array.isArray(compoundData.regions) && compoundData.regions.length > 0) {
            compoundAlert.style.display = '';

            // Clear any existing content before rebuilding the alert
            compoundAlert.textContent = '';

            // Static label
            var alertLabel = document.createElement('strong');
            alertLabel.textContent = 'Compound Risk Alert:';
            compoundAlert.appendChild(alertLabel);
            compoundAlert.appendChild(document.createTextNode(' Multiple signal types converge in: '));

            // Per-region details, built safely via text nodes
            compoundData.regions.forEach(function (r, idx) {
                if (idx > 0) {
                    compoundAlert.appendChild(document.createTextNode('; '));
                }

                var regionStrong = document.createElement('strong');
                regionStrong.textContent = r.region;
                compoundAlert.appendChild(regionStrong);

                var description =
                    ': ' + r.types.join(', ') +
                    ' (' + r.typeCount + ' signal types, ' +
                    (r.amplification * 100 - 100).toFixed(0) + '% amplification)';
                compoundAlert.appendChild(document.createTextNode(description));
            });
        } else {
            compoundAlert.style.display = 'none';
        }
    }

    // Sort by severity descending, render via DocumentFragment for batched DOM update
    var sorted = snapshot.signals.slice().sort(function (a, b) { return (b.severity || 0) - (a.severity || 0); });
    var fragment = document.createDocumentFragment();

    sorted.forEach(function (s, idx) {
        var sev = Number(s.severity || 0);
        var sevColor = getRiskColor(sev);
        var typeClass = String(s.type || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

        var row = document.createElement('tr');

        // Column 1: Signal index
        var idxCell = document.createElement('td');
        idxCell.style.color = '#999';
        idxCell.textContent = 'S-' + (idx + 1);
        row.appendChild(idxCell);

        // Column 2: Type badge
        var typeCell = document.createElement('td');
        var typeBadge = document.createElement('span');
        typeBadge.className = 'risk-type-badge ' + typeClass;
        typeBadge.textContent = String(s.type || 'unknown').toUpperCase();
        typeCell.appendChild(typeBadge);
        row.appendChild(typeCell);

        // Column 3: Summary
        var summaryCell = document.createElement('td');
        summaryCell.style.maxWidth = '400px';
        summaryCell.style.wordWrap = 'break-word';
        summaryCell.textContent = s.summary || '';
        row.appendChild(summaryCell);

        // Column 4: Severity percentage with color
        var sevCell = document.createElement('td');
        sevCell.style.textAlign = 'center';
        var sevSpan = document.createElement('span');
        sevSpan.style.color = sevColor;
        sevSpan.style.fontWeight = '600';
        sevSpan.textContent = (sev * 100).toFixed(0) + '%';
        sevCell.appendChild(sevSpan);
        row.appendChild(sevCell);

        // Column 5: Publisher/source
        var publisherCell = document.createElement('td');
        publisherCell.style.fontSize = '0.8em';
        publisherCell.textContent = s.publisher || s.source || '';
        row.appendChild(publisherCell);

        // Column 6: Region/country and optional location hint
        var regionCell = document.createElement('td');
        var regionText = document.createTextNode(s.region || s.country || '');
        regionCell.appendChild(regionText);
        if (s.location_hint) {
            regionCell.appendChild(document.createTextNode(' '));
            var hintSmall = document.createElement('small');
            hintSmall.textContent = '(' + s.location_hint + ')';
            regionCell.appendChild(hintSmall);
        }
        row.appendChild(regionCell);

        // Column 7: As-of timestamp
        var asOfCell = document.createElement('td');
        asOfCell.style.fontSize = '0.8em';
        asOfCell.style.whiteSpace = 'nowrap';
        asOfCell.textContent = s.as_of || '';
        row.appendChild(asOfCell);
        fragment.appendChild(row);
    });
    tableBody.appendChild(fragment);
}

// Helper function to get risk color
function getRiskColor(score) {
    if (score >= 0.7) return '#ff4444';      // High risk - red
    if (score >= 0.4) return '#ffaa00';      // Medium risk - orange  
    if (score >= 0.1) return '#ffdd00';      // Low risk - yellow
    return '#44aa44';                        // Very low risk - green
}

// Show detailed risk information for an activity
function showActivityRiskDetails(node) {
    const modal = document.createElement('div');
    modal.className = 'risk-detail-modal';
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
        background: rgba(8,31,55,0.85); z-index: 1000; display: flex; 
        align-items: center; justify-content: center;
    `;

    const content = document.createElement('div');
    content.style.cssText = `
        background: linear-gradient(145deg, #0d2137, #143459); color:#cdfaff; padding: 24px; border-radius: 10px; 
        max-width: 680px; max-height: 85vh; overflow-y: auto; border:1px solid #3292cd; box-shadow: 0 0 24px rgba(50,146,205,.45);
    `;

    content.innerHTML = `
        <h3>External Risk Details: ${node.Name}</h3>
        <p><strong>Activity ID:</strong> ${node.ID}</p>
        <p><strong>External Risk Score:</strong> ${(node.externalRiskScore || 0).toFixed(3)}</p>
        <p><strong>External Cost Risk:</strong> ${(node.externalCostRisk || 0).toFixed(3)}</p>
        <p><strong>External Schedule Risk:</strong> ${(node.externalScheduleRisk || 0).toFixed(3)}</p>
        <hr>
        <h4>Applicable External Risks (${node.externalRisks.length}):</h4>
        ${node.externalRisks.map(risk => `
            <div style="margin-bottom: 15px; padding: 10px; border-left: 3px solid ${getRiskColor(risk.influence_score)};">
                <strong>${risk.name}</strong> (${risk.type})<br>
                <small>Influence Score: ${risk.influence_score.toFixed(3)} | 
                Weighted Cost: ${risk.weighted_cost_impact.toFixed(3)} | 
                Weighted Schedule: ${risk.weighted_schedule_impact.toFixed(3)}</small><br>
                <em>${risk.description}</em>
            </div>
        `).join('')}
        <button onclick="this.parentElement.parentElement.remove()" 
                class="icon-button" style="margin-top: 20px; padding: 8px 12px; background: #113464; color: #cdfaff; border: 1px solid #3292cd; border-radius: 5px; cursor: pointer;">
            Close
        </button>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    // Close on background click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
}

// Build Risk nodes and Risk→Activity links that are guaranteed render-safe.
// - Supports 1 risk → many activities (one link per pair)
// - If a risk maps to no activities, links it to Start (ID 0 by default) ONLY if Start exists
// - Ensures IDs are strings and CSS-safe
// - Ensures every link endpoint exists in the base node set
// - Adds schedule-like default fields to Risk nodes to prevent UI/tooltips from crashing
function materializeRiskGraph(baseNodes, risk_register, opts = {}) {
    // Prefer Start ID from state if present, else opt-in, else "0"
    const defaultStartId = (function () {
        try { return String(window?.cybereumState?.startNode?.ID ?? 0); } catch { return "0"; }
    })();
    const startId = opts.startId != null ? String(opts.startId) : defaultStartId;

    // --- Guards
    if (!Array.isArray(baseNodes)) {
        console.warn("[materializeRiskGraph] baseNodes not array:", baseNodes);
        return { riskNodes: [], riskLinks: [] };
    }
    const risks = Array.isArray(risk_register) ? risk_register : [];
    if (risks.length === 0) return { riskNodes: [], riskLinks: [] };

    // --- Helpers
    const clamp01 = x => {
        x = Number(x);
        return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
    };
    const sanitize = s => String(s).replace(/[^a-zA-Z0-9_\-]/g, "_");
    const riskNodeId = rid => `Rk-${sanitize(rid)}`;               // <— Rk prefix
    const riskLinkId = (rid, actId) => `RISK_${sanitize(rid)}__${sanitize(actId)}`;

    // Node id set for endpoint existence checks (use STRING keys)
    const nodeIdSet = new Set(baseNodes.map(n => String(n.ID)));
    const hasStart = nodeIdSet.has(startId);

    // Prefer dates from window.cybereumState.startNode/endNode
    let projectStartISO = null;
    let projectEndISO = null;
    try {
        const s = window?.cybereumState?.startNode?.Start;
        const e = window?.cybereumState?.endNode?.Finish;
        projectStartISO = s ? new Date(s).toISOString() : null;
        projectEndISO = e ? new Date(e).toISOString() : null;
    } catch { }
    if (!projectStartISO || !projectEndISO) {
        // Fallback: derive from schedule
        const starts = baseNodes.map(n => new Date(n.Start)).filter(d => !isNaN(d));
        const finishes = baseNodes.map(n => new Date(n.Finish)).filter(d => !isNaN(d));
        projectStartISO = projectStartISO || (starts.length ? new Date(Math.min(...starts)).toISOString() : window.cybereumState.dataDate.toISOString() || new Date().toISOString());
        projectEndISO = projectEndISO || (finishes.length ? new Date(Math.max(...finishes)).toISOString() : projectStartISO);
    }

    // --- Build Risk nodes with schedule-like defaults (now using project bounds)
    const riskNodesByRawId = new Map();
    risks.forEach(r => {
        const probability = clamp01(r.probability);
        const ci = clamp01(r.cost_impact);
        const si = clamp01(r.schedule_impact);
        const severity = Math.max(ci, si) * probability;

        const node = {
            ID: riskNodeId(r.id),
            Name: r.name,
            NodeType: "Risk",

            RiskType: r.type,
            Description: r.description || "",
            Probability: probability,
            CostImpact: ci,
            ScheduleImpact: si,
            Severity: severity,

            // schedule-like defaults pulled from Start/End milestones
            Duration: 0,
            Start: projectStartISO,
            Finish: projectEndISO,
            PercentComplete: 0,
            TimeUnits: "Hours",
            TaskType: "Risk",
            Milestone: 0,
            isOnCriticalPath: false,

            // convenience scores
            riskScore: severity,
            externalRiskScore: severity,
            externalCostRisk: probability * ci,
            externalScheduleRisk: probability * si
        };

        riskNodesByRawId.set(String(r.id), node);
    });

    // --- Build Risk → Activity links
    const riskLinks = [];
    const seen = new Set();
    const linksPerRisk = new Map(risks.map(r => [String(r.id), 0]));

    baseNodes.forEach(act => {
        const extRisks = Array.isArray(act.externalRisks) ? act.externalRisks : [];
        const actId = String(act.ID);
        if (!nodeIdSet.has(actId)) return;

        extRisks.forEach(er => {
            const rid = String(er.id);
            const riskNode = riskNodesByRawId.get(rid);
            if (!riskNode) return;

            const linkId = riskLinkId(rid, actId);
            if (seen.has(linkId)) return;

            seen.add(linkId);
            const wCost = clamp01(er.weighted_cost_impact);
            const wSched = clamp01(er.weighted_schedule_impact);

            riskLinks.push({
                id: linkId,
                source: riskNode.ID,      // string ID; d3.forceLink().id(d => d.ID)
                target: actId,            // string ID
                LinkType: "RISK_AFFECTS",
                Influence: clamp01(er.influence_score),
                WCost: wCost,
                WSched: wSched
            });

            linksPerRisk.set(rid, (linksPerRisk.get(rid) || 0) + 1);
        });
    });

    // --- Fallback: risks with no activities → link to Start (only if Start exists)
    linksPerRisk.forEach((count, rid) => {
        if (count === 0 && hasStart) {
            const rNode = riskNodesByRawId.get(rid);
            const r = risks.find(x => String(x.id) === rid);
            if (!rNode || !r) return;

            const prob = clamp01(r.probability);
            const ci = clamp01(r.cost_impact);
            const si = clamp01(r.schedule_impact);

            const linkId = riskLinkId(rid, startId);
            if (seen.has(linkId)) return;
            seen.add(linkId);

            riskLinks.push({
                id: linkId,
                source: rNode.ID,
                target: startId,
                LinkType: "RISK_AFFECTS",
                Influence: 1,
                WCost: clamp01(prob * ci),
                WSched: clamp01(prob * si)
            });
        }
    });

    return { riskNodes: [...riskNodesByRawId.values()], riskLinks };
}

/**
 * Merge scores back into nodes by ID.
 * Adds: node.extCostRisk (0..1), node.extScheduleRisk (0..1)
 */
function applyRiskScores(nodes, scores) {
    const byId = new Map(scores.map(s => [Number(s.id), s]));
    console.log("RScores Applying risk scores to nodes:", byId);
    nodes.forEach(n => {
        const s = byId.get(Number(n.ID));
        if (s) {
            n.extCostRisk = s.cost;
            n.extScheduleRisk = s.sched;
        }
    });
    return nodes;
}

/**
 * Propagate external risk scores into the main riskScore field used by Risk Matrix
 * and refresh all risk visualizations.
 *
 * Activities with both internal and external risk get a combined score.
 * This ensures the Risk Matrix scatter plot and outlier detection (which drives the
 * Risk Table) reflect the true combined risk posture.
 */
function propagateExternalRiskAndRefreshCharts(nodes, links) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;

    // combinedRiskScore is already set by applyRisksToActivities → computeCombinedRisk.
    // This function scales overrun_probability from the combined score and refreshes charts.
    let updated = 0;
    nodes.forEach(node => {
        const combined = Number(node.combinedRiskScore || 0);
        if (combined <= 0) return;

        // Capture original backend-calibrated values on first call
        if (node._internalOverrunProbability === undefined) {
            node._internalOverrunProbability = Number(node.overrun_probability || 0);
        }
        if (node._internalRiskScore === undefined) {
            node._internalRiskScore = Number(node.riskScore || 0);
        }
        const internal = Number(node._internalRiskScore || 0);
        const internalOverrun = node._internalOverrunProbability;

        // Promote combined score into riskScore so all downstream charts (drawRiskMatrix,
        // drawRiskScoreBarChart, drawRiskScoreDistributionChart, etc.) reflect the true
        // external+internal combined risk posture rather than the internal-only value.
        node.riskScore = combined;

        // Scale overrun proportionally to risk increase, capped at 5x
        if (internal > 0 && internalOverrun > 0) {
            const ratio = Math.min(combined / internal, 5.0);
            node.overrun_probability = internalOverrun * ratio;
        } else if (combined > 0) {
            node.overrun_probability = combined * 0.3;
        }
        node.overrun_probability = Math.min(1.0, Math.max(0, node.overrun_probability));

        updated++;
    });

    console.log(`[ExtRisks] Propagated combined risk scores to ${updated} activities`);

    // Recompute risk-adjusted durations and dates from the updated overrun_probability.
    // This closes the causal loop: external risks → combined riskScore →
    // overrun_probability → riskAdjustedDuration → riskAdjustedEnd → completion forecast.
    if (updated > 0 && typeof window.computeRiskAdjustedDurationsAndDates === 'function') {
        try {
            window.computeRiskAdjustedDurationsAndDates(nodes, links);
            console.log(`[ExtRisks] Recomputed risk-adjusted dates from combined risk scores`);
        } catch (e) {
            console.warn('[ExtRisks] Failed to recompute risk-adjusted dates:', e);
        }
    }

    // Refresh risk visualizations that exist on the current page
    const tryCall = (fn, canvasId, ...args) => {
        // ✅ Handle undefined or null function
        if (fn === undefined || fn === null) {
            console.warn(`Function is undefined for canvas: ${canvasId}`);
            return;
        }
        if (typeof fn === 'function' && document.getElementById(canvasId)) fn(...args);
    };
    typeof window.drawRiskMatrix === 'function' && tryCall(window.drawRiskMatrix, 'riskMatrix', nodes, links);
    typeof window.drawRiskScoreBarChart === 'function' && tryCall(window.drawRiskScoreBarChart, 'riskScoreBarChart', nodes);
    typeof window.drawRiskScoreDistributionChart === 'function' && tryCall(window.drawRiskScoreDistributionChart, 'riskScoreDistributionChart', nodes);
    typeof window.drawImpactScoreBarChart === 'function' && tryCall(window.drawImpactScoreBarChart, 'importanceScoreBarChart', nodes);
    typeof window.drawImpactScoreDistributionChart === 'function' && tryCall(window.drawImpactScoreDistributionChart, 'importanceScoreDistributionChart', nodes);
    typeof window.createRiskImpactChart === 'function' && tryCall(window.createRiskImpactChart, 'chart', nodes);

    // Dispatch event for any other listeners
    window.dispatchEvent(new CustomEvent('riskScoresUpdated', {
        detail: { nodeCount: nodes.length, updatedCount: updated }
    }));
}

/**
 * DEPRECATED: scoreScheduleExternalRisk
 * This function previously called undefined methods (buildRiskPayload, callExternalRiskScores).
 * Use getExternalRiskRegisterCalibrated or getExternalRiskRegister instead.
 * 
 * Example usage:
 *   const result = await getExternalRiskRegisterCalibrated(nodes, links, meta);
 *   const enrichedNodes = applyRisksToActivities(nodes, result);
 */
async function scoreScheduleExternalRisk(nodes, links, meta) {
    console.warn('[ExtRisks] scoreScheduleExternalRisk is deprecated. Use getExternalRiskRegisterCalibrated instead.');
    try {
        const result = await getExternalRiskRegisterCalibrated(nodes, links, meta);
        const enrichedNodes = applyRisksToActivities(nodes, result);
        return {
            nodes: enrichedNodes,
            scores: result.risk_register
        };
    } catch (error) {
        console.error('[ExtRisks] scoreScheduleExternalRisk failed:', error);
        return { nodes: initializeEmptyExternalRisks(nodes), scores: [] };
    }
}


function initializeRiskRegisterInputs() {
    const seedBtn = document.getElementById('seedRiskRegisterBtn');
    const seedText = document.getElementById('riskSeedInput');
    const fileInput = document.getElementById('riskSeedFileInput');

    if (seedBtn && seedText && !seedBtn.dataset.bound) {
        seedBtn.dataset.bound = '1';
        seedBtn.addEventListener('click', () => {
            const seeded = parseSeedLines(seedText.value || '');
            if (!seeded.length) {
                alert('No valid seed risks found. Use one risk per line, or CSV: risk_name,type,probability,cost_impact,schedule_impact,description.');
                return;
            }
            window.cybereumState = window.cybereumState || {};
            const current = Array.isArray(window.cybereumState.seededRiskRegister) ? window.cybereumState.seededRiskRegister : [];
            window.cybereumState.seededRiskRegister = mergeRiskRegisters(current, seeded);
            alert(`Added ${seeded.length} seeded risks.`);
            seedText.value = '';
        });
    }

    if (fileInput && !fileInput.dataset.bound) {
        fileInput.dataset.bound = '1';
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const content = await file.text();
            const rows = content.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
            if (!rows.length) {
                alert('The uploaded CSV is empty.');
                return;
            }

            const header = splitCsvLine(rows[0]).map(c => c.toLowerCase());
            const hasHeader = header.some(c => ['risk', 'risk_name', 'type', 'probability', 'cost_impact', 'schedule_impact', 'description'].includes(c));
            const lines = hasHeader ? rows.slice(1) : rows;
            const imported = parseSeedLines(lines.join('\n')).map(r => ({ ...r, source: 'Spreadsheet' }));
            if (!imported.length) {
                alert('No valid risks imported. Expected first column to be risk_name. Recommended CSV: risk_name,type,probability,cost_impact,schedule_impact,description');
                fileInput.value = '';
                return;
            }

            window.cybereumState = window.cybereumState || {};
            const current = Array.isArray(window.cybereumState.seededRiskRegister) ? window.cybereumState.seededRiskRegister : [];
            window.cybereumState.seededRiskRegister = mergeRiskRegisters(current, imported);
            alert(`Imported ${imported.length} risks from spreadsheet.`);
            fileInput.value = '';
        });
    }
}

document.addEventListener('DOMContentLoaded', initializeRiskRegisterInputs);

// =============================================================================
// EXPORTS (CORRECTED + OPTIMIZED)
// =============================================================================

// Core pipeline functions
window.getExternalRiskRegisterCalibrated = getExternalRiskRegisterCalibrated;
window.getExternalRiskRegister = getExternalRiskRegister;
window.calibrateRiskPipeline = calibrateRiskPipeline;
window.executeConvergentSynthesis = executeConvergentSynthesis;
window.executeDivergentGeneration = executeDivergentGeneration;
window.executeValidation = executeValidation;

// Configuration
window.RISK_PIPELINE_CONFIG = RISK_PIPELINE_CONFIG;
window.CANONICAL_SEEDS = CANONICAL_SEEDS;

// Data building functions
window.buildExternalRiskPayload = buildExternalRiskPayload;
window.buildMetaFromState = buildMetaFromState;
window.buildDivergentPayload = buildDivergentPayload;
window.deriveNonCriticalRelatedActivities = deriveNonCriticalRelatedActivities;

// Risk application functions
window.applyRisksToActivities = applyRisksToActivities;
window.applyRisksToActivitiesIntelligent = applyRisksToActivitiesIntelligent;
window.initializeEmptyExternalRisks = initializeEmptyExternalRisks;
window.findAffectedActivities = findAffectedActivities;
window.getBasicInfluenceScore = getBasicInfluenceScore;

// Optimized versions (for direct use when needed)
window.findAffectedActivitiesOptimized = findAffectedActivitiesOptimized;
window.getBasicInfluenceScoreOptimized = getBasicInfluenceScoreOptimized;

// Graph materialization (for visualization)
window.materializeRiskGraph = materializeRiskGraph;
window.applyRiskScores = applyRiskScores;
window.combineForRender = combineForRender;

// Risk combiners (class for advanced usage)
window.RiskCombiner = RiskCombiner;

// Utility functions
window.categorizeByName = categorizeByName;
window.categorizeActivities = categorizeActivities;

// Cache management utilities
window.clearCategoryCache = function () {
    _categoryCache.clear();
    console.log('[ExtRisks] Category cache cleared');
};
window.getCategoryCacheStats = function () {
    return { size: _categoryCache.size, maxSize: CATEGORY_CACHE_MAX };
};

// Mitigation functions
window.generateMitigationActivities = generateMitigationActivities;
window.integrateMitigationActivities = integrateMitigationActivities;

// Scoring functions (for backward compatibility)
window.scoreScheduleExternalRisk = scoreScheduleExternalRisk;

// NEW: Sector guidance functions
window.buildSectorGuidance = buildSectorGuidance;
window.EPC_FABRICATION_GUIDANCE = EPC_FABRICATION_GUIDANCE;
window.SECTOR_SPECIFIC_GUIDANCE = SECTOR_SPECIFIC_GUIDANCE;

// Sentiment divergence & weather forecast confidence analysis
window.analyzeSentimentDivergence = analyzeSentimentDivergence;
window.extractWeatherConfidence = extractWeatherConfidence;

// Log successful load with version
console.log('[ExtRisks.js] External risk pipeline v2.5 loaded (probabilistic weather + sentiment divergence).');
console.log('[ExtRisks.js] NEW: NOAA probabilistic forecasts, Polymarket divergence detection, confidence-weighted severity');
console.log('[ExtRisks.js] Available: getExternalRiskRegisterCalibrated, applyRisksToActivities, buildSectorGuidance');
