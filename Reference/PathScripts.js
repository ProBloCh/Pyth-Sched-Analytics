/**
 * Default work parameters for missing calendars:
 * - 8 hours per day
 * - 5 days per week
 * Feel free to expand to store more advanced info (like resource calendars).
 */
// Global constants for schedule calculations
window.DEFAULT_HOURS_PER_DAY = (Number.isFinite(Number(window.DEFAULT_HOURS_PER_DAY)) ? Number(window.DEFAULT_HOURS_PER_DAY) : 8);
window.DEFAULT_WORKING_DAYS = (Array.isArray(window.DEFAULT_WORKING_DAYS) && window.DEFAULT_WORKING_DAYS.length ? window.DEFAULT_WORKING_DAYS : [1, 2, 3, 4, 5]); // Monday-Friday

// Module-private HTML-escape helper used by the driving-constraints
// tooltip (`cybDG_showTooltipForNode`). Prefixed `_ps` to avoid colliding
// with similar helpers in sibling scripts loaded on the same page.
function _psEscHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CONFIG = {
    WORKING_HOURS_PER_DAY: window.DEFAULT_HOURS_PER_DAY,
    WORKING_DAYS_PER_WEEK: window.DEFAULT_WORKING_DAYS.length,
    CALENDAR_HOURS_PER_DAY: 24,
    // For rough conversions of Months / Years
    WEEKS_PER_MONTH: 4.345,
    WEEKS_PER_YEAR: 52.14,
    /* ======================================================================
 * DURATION NORMALIZATION & SAFETY LIMITS
 * ====================================================================== */

    // Hard cap used by convertToHours() to prevent corrupt schedules exploding charts
    MAX_WORKING_HOURS: 150000,        // ~360 work-years (defensive only)

    // Max hours a single addWorkingHours operation may advance a date
    MAX_WORKING_HOURS_TO_ADD: 20000,  // protects infinite loops in calendars

};
window.CONFIG = CONFIG;

/**
 * Resolve the effective working calendar from the best available source.
 * Fallback chain: teamCalendar → CONFIG → hardcoded defaults.
 * Use this instead of ad-hoc fallback chains throughout the codebase.
 *
 * @returns {{ hoursPerDay: number, workingDaysPerWeek: number, workingDays: number[], holidays: string[] }}
 */
function resolveCalendar() {
    var cal = (window.cybereumState && window.cybereumState.teamCalendar) || {};
    var hoursPerDay = (Number.isFinite(Number(cal.hoursPerDay)) && Number(cal.hoursPerDay) > 0)
        ? Number(cal.hoursPerDay)
        : CONFIG.WORKING_HOURS_PER_DAY || 8;
    var workingDays = (Array.isArray(cal.workingDays) && cal.workingDays.length > 0)
        ? cal.workingDays
        : window.DEFAULT_WORKING_DAYS || [1, 2, 3, 4, 5];
    return {
        hoursPerDay: hoursPerDay,
        workingDaysPerWeek: workingDays.length,
        workingDays: workingDays,
        holidays: (Array.isArray(cal.holidays) ? cal.holidays : [])
    };
}
window.resolveCalendar = resolveCalendar;

/**
 * Sync global working-time defaults from imported P6/MSP calendars (if present).
 * Importers should populate: window.cybereumState.calendars = { default, defaultCalendarId, byId, ... }.
 */
function syncWorkingCalendarFromImport() {
    try {
        const calState = window?.cybereumState?.calendars;
        if (!calState) return false;

        const def = calState.default
            || (calState.defaultCalendarId && calState.byId && calState.byId[String(calState.defaultCalendarId)])
            || null;

        if (!def) return false;

        const hours = Number(def.dayHours ?? def.hoursPerDay ?? def.hoursPerDayAvg ?? calState.defaultHoursPerDay);
        const workingDays =
            (Array.isArray(def.workingDays) && def.workingDays.length) ? def.workingDays :
                ((Array.isArray(calState.defaultWorkingDays) && calState.defaultWorkingDays.length) ? calState.defaultWorkingDays : null);

        if (Number.isFinite(hours) && hours > 0) {
            CONFIG.WORKING_HOURS_PER_DAY = hours;
            window.DEFAULT_HOURS_PER_DAY = hours;
        }

        if (workingDays) {
            window.DEFAULT_WORKING_DAYS = workingDays.slice();
            CONFIG.WORKING_DAYS_PER_WEEK = window.DEFAULT_WORKING_DAYS.length;
        } else if (Number.isFinite(Number(calState.defaultWorkingDaysPerWeek))) {
            CONFIG.WORKING_DAYS_PER_WEEK = Number(calState.defaultWorkingDaysPerWeek);
        }

        return true;
    } catch (err) {
        console.warn('[PathScripts] syncWorkingCalendarFromImport failed:', err);
        return false;
    }
}

// Export + attempt once at load time
window.syncWorkingCalendarFromImport = syncWorkingCalendarFromImport;
syncWorkingCalendarFromImport();



/**
 * ============================================================================
 * CANONICAL DURATION CONVERTER (WORKING HOURS)
 * ============================================================================
 * Single source of truth: duration + units -> working hours
 *
 * Uses CONFIG.WORKING_HOURS_PER_DAY, CONFIG.WORKING_DAYS_PER_WEEK, CONFIG.MAX_WORKING_HOURS
 * - Defensive: never NaN, clamps <=0 to 0, caps to MAX_WORKING_HOURS
 * - Handles minutes/hours/days/weeks/months/years (with pragmatic month/year averages)
 * - Explicitly resolves "m" ambiguity (minutes vs months)
 *
 * Recommended usage everywhere:
 *   const hrs = convertToHours(node.Duration, node.TimeUnits);
 *   const lagHrs = convertToHours(link.lag, link.lagUnits || link.timeUnits || link.TimeUnits);
 */
function convertToHours(duration, timeUnits) {
    const HOURS_PER_DAY = Number(CONFIG?.WORKING_HOURS_PER_DAY) || 8;
    const DAYS_PER_WEEK = Number(CONFIG?.WORKING_DAYS_PER_WEEK) || 5;
    const MAX_HOURS = Number(CONFIG?.MAX_WORKING_HOURS) || 100000;

    // Pragmatic averages for schedules that contain Months/Years
    // 52.14 weeks/year ÷ 12 ≈ 4.345 weeks/month
    const WEEKS_PER_MONTH = 4.345;
    const WEEKS_PER_YEAR = 52.14;

    const d = Number(duration);
    if (!Number.isFinite(d) || d <= 0) return 0;

    const uRaw = String(timeUnits ?? "Hours").trim().toLowerCase();
    if (!uRaw) return Math.min(d, MAX_HOURS);

    let hours;

    // Fast-path exact matches / common aliases
    switch (uRaw) {
        case "h":
        case "hr":
        case "hrs":
        case "hour":
        case "hours":
            hours = d;
            break;

        case "s":
        case "sec":
        case "secs":
        case "second":
        case "seconds":
            hours = d / 3600;
            break;

        case "min":
        case "mins":
        case "minute":
        case "minutes":
            hours = d / 60;
            break;

        // NOTE: "m" is ambiguous; treat as minutes by default
        // If you ever need month shorthand, schedules should use "mo"/"month(s)".
        case "m":
            hours = d / 60;
            break;

        case "d":
        case "day":
        case "days":
            hours = d * HOURS_PER_DAY;
            break;

        case "w":
        case "wk":
        case "wks":
        case "week":
        case "weeks":
            hours = d * DAYS_PER_WEEK * HOURS_PER_DAY;
            break;

        case "mo":
        case "mon":
        case "mons":
        case "month":
        case "months":
            hours = d * WEEKS_PER_MONTH * DAYS_PER_WEEK * HOURS_PER_DAY;
            break;

        case "y":
        case "yr":
        case "yrs":
        case "year":
        case "years":
            hours = d * WEEKS_PER_YEAR * DAYS_PER_WEEK * HOURS_PER_DAY;
            break;

        default: {
            // Prefix handling for slightly messy unit strings
            // Examples: "Days", "day(s)", "Weeks", "Months", etc.
            const c0 = uRaw[0];
            if (c0 === "h") hours = d;
            else if (c0 === "d") hours = d * HOURS_PER_DAY;
            else if (c0 === "w") hours = d * DAYS_PER_WEEK * HOURS_PER_DAY;
            else if (c0 === "y") hours = d * WEEKS_PER_YEAR * DAYS_PER_WEEK * HOURS_PER_DAY;
            else if (c0 === "m") {
                // Distinguish minutes vs months by prefix
                // "mo"/"mon"/"month" -> months, otherwise minutes
                hours = (uRaw.startsWith("mo") || uRaw.startsWith("mon") || uRaw.startsWith("month"))
                    ? d * WEEKS_PER_MONTH * DAYS_PER_WEEK * HOURS_PER_DAY
                    : d / 60;
            } else {
                // Unknown unit: treat as hours (least surprising)
                hours = d;
                if (typeof console !== "undefined") {
                    console.warn(`convertToHours: Unknown unit "${timeUnits}", treating as hours`);
                }
            }
            break;
        }
    }

    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return Math.min(hours, MAX_HOURS);
}

/**
 * Backward-compatible alias (so you don't have to refactor everything at once).
 * If you keep toWorkingHours around, it MUST call convertToHours.
 */
function toWorkingHours(duration, timeUnits) {
    return convertToHours(duration, timeUnits);
}

/**
 * Overrun semantics
 * ---------------------------------------------------------------------------
 * We have seen two (valid) interpretations used across the codebase:
 *  1) "probability" (0..1)  -> multiplier = 1 + p * expectedImpactScalar
 *  2) "fractional_overrun"  -> the value already represents the fractional overrun
 *                              (e.g., 0.20 = +20%, 1.50 = +150%)
 *
 * Your current risk-allocation code is producing values like 3.6 alongside 0.02.
 * That pattern is consistent with the *fractional_overrun* interpretation.
 *
 * To avoid silent unit heuristics, we make the interpretation explicit:
 *  - CONFIG.overrunSemantics can be: 'fractional_overrun' | 'probability' | 'percent'
 *  - default is 'fractional_overrun'
 */
function getOverrunSemantics() {
    const s = (typeof CONFIG !== 'undefined' && CONFIG && typeof CONFIG.overrunSemantics === 'string')
        ? CONFIG.overrunSemantics
        : (typeof window !== 'undefined' && typeof window.OVERRUN_SEMANTICS === 'string')
            ? window.OVERRUN_SEMANTICS
            : 'fractional_overrun';
    return String(s).toLowerCase();
}

function getDurationMultiplierCaps() {
    const minMult = (typeof OVERRUN_CONFIG !== 'undefined' && Number.isFinite(+OVERRUN_CONFIG.MIN_DURATION_MULTIPLIER))
        ? +OVERRUN_CONFIG.MIN_DURATION_MULTIPLIER
        : 0.5;
    const maxMult = (typeof OVERRUN_CONFIG !== 'undefined' && Number.isFinite(+OVERRUN_CONFIG.MAX_DURATION_MULTIPLIER))
        ? +OVERRUN_CONFIG.MAX_DURATION_MULTIPLIER
        : 3.0;
    return { minMult, maxMult };
}

function clampDurationMultiplier(mult) {
    const { minMult, maxMult } = getDurationMultiplierCaps();
    const m = Number(mult);
    if (!Number.isFinite(m)) return 1.0;
    return Math.max(minMult, Math.min(maxMult, m));
}

/**
 * Convert node.overrun_probability into a duration multiplier.
 * - If overrunSemantics = 'fractional_overrun': multiplier = 1 + raw
 * - If overrunSemantics = 'probability':       multiplier = 1 + p * expectedImpactScalar
 * - If overrunSemantics = 'percent':           multiplier = 1 + (raw/100)
 *
 * NOTE: This function intentionally does NOT apply the duration-multiplier cap.
 *       Call clampDurationMultiplier() at the use-site so all paths/dates/tables
 *       remain consistent.
 */
function overrunProbToMultiplier(rawOverrun) {
    let x = Number(rawOverrun);
    if (!Number.isFinite(x)) x = 0;
    if (x < 0) x = 0;

    const semantics = getOverrunSemantics();
    if (semantics === 'percent') {
        return 1 + (x / 100);
    }
    if (semantics === 'probability') {
        // probability (0..1) -> expected fractional overrun scaled by impact
        const p = Math.max(0, Math.min(1, x));
        const impact = (typeof CONFIG !== 'undefined' && CONFIG && Number.isFinite(+CONFIG.expectedOverrunImpactScalar))
            ? +CONFIG.expectedOverrunImpactScalar
            : 1.0;
        return 1 + (p * impact);
    }

    // default: fractional_overrun
    return 1 + x;
}

function calculateExpectedOverrunDurationForPath(path, links) {
    // Returns a risk-adjusted *path length in working hours*.
    // This is computed deterministically by simulating a single chain using the
    // relationship type (FS/SS/FF/SF) and lag hours.

    if (!Array.isArray(path) || path.length === 0) return 0;

    const succMap = window.cybereumState?.succMap || buildSuccessorMap(links, path);

    function adjustedDurHrs(node, edgeDurHrsFallback) {
        const baseHrs = (Number.isFinite(+edgeDurHrsFallback) && +edgeDurHrsFallback > 0)
            ? +edgeDurHrsFallback
            : getDurationInHours(node);
        const mult = clampDurationMultiplier(overrunProbToMultiplier(node?.overrun_probability));
        return baseHrs * mult;
    }

    // Seed first node at t=0
    let curNode = path[0];
    let curStart = 0;
    let curFinish = curStart + adjustedDurHrs(curNode, null);

    for (let i = 0; i < path.length - 1; i++) {
        const nextNode = path[i + 1];
        const edges = succMap.get(curNode.ID);
        const edge = edges?.find(e => e.target === nextNode.ID);

        const lagHrs = edge ? (Number(edge.lagHrs) || 0) : 0;
        const nextDur = adjustedDurHrs(nextNode, null);

        let nextStart;
        const rel = edge?.type || 'FS';
        switch (rel) {
            case 'SS':
                nextStart = curStart + lagHrs;
                break;
            case 'FF': {
                const nextFinish = curFinish + lagHrs;
                nextStart = nextFinish - nextDur;
                break;
            }
            case 'SF': {
                const nextFinish = curStart + lagHrs;
                nextStart = nextFinish - nextDur;
                break;
            }
            case 'FS':
            default:
                nextStart = curFinish + lagHrs;
                break;
        }

        if (!Number.isFinite(nextStart)) nextStart = curFinish + lagHrs;
        if (nextStart < 0) nextStart = 0;

        const nextFinish = nextStart + nextDur;

        // Advance
        curNode = nextNode;
        curStart = nextStart;
        curFinish = nextFinish;
    }

    // Since the first node starts at 0, the finish time is the chain length
    return Math.max(0, curFinish);
}

function getDurationInHours(node) {
    const duration = Number(node?.Duration) || 0;
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return convertToHours(duration, node?.TimeUnits || "Hours");
}


/**
 * Get risk-adjusted node duration in working hours.
 * Clamps overrun factor to prevent extreme values.
 */
function getAdjustedDurationInHours(node) {
    if (!node) return 0;

    const baseDuration = getDurationInHours(node);
    return baseDuration * clampDurationMultiplier(overrunProbToMultiplier(node.overrun_probability));
}


function adjustTaskTimesForOverrun(nodes) {
    nodes.forEach(node => {
        const difference = getAdjustedDurationInHours(node) - getDurationInHours(node);
        var taskEnd = new Date(node.Finish);
        // Convert working hours to working days and use addWorkDays for calendar-aware addition
        var cal = resolveCalendar();
        var workDays = difference / cal.hoursPerDay;
        taskEnd = addWorkDays(taskEnd, Math.ceil(workDays), cal.workingDaysPerWeek);
        node.AdjustedFinish = taskEnd.toISOString();
    });
}


function differenceInCalendarDays(date1, date2) {
    const msPerDay = 24 * 60 * 60 * 1000; // number of milliseconds in a day
    return (date1 - date2) / msPerDay;
}

function durationToMilliseconds(duration, timeUnits) {
    switch (timeUnits) {
        case 'Hours':
            return duration * 60 * 60 * 1000;
        case 'Minutes':
            return duration * 60 * 1000;
        case 'Seconds':
            return duration * 1000;
        case 'Days':
            return duration * 24 * 60 * 60 * 1000;
        default:
            return duration;  // Return the original value if the unit isn't recognized
    }
}

function calculateResources(start, end, duration, hoursPerDay = 8, workDaysPerWeek = 5) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const totalDays = Math.floor((endDate - startDate) / (24 * 60 * 60 * 1000)) + 1;

    let workDays = 0;
    let currentDay = new Date(startDate);
    while (currentDay <= endDate) {
        // Convert Sunday=0 to 7 for easier comparison
        var dayNum = currentDay.getDay() === 0 ? 7 : currentDay.getDay();
        if (dayNum <= workDaysPerWeek) {
            workDays++;
        }
        currentDay.setDate(currentDay.getDate() + 1);
    }

    // Guard against zero work days to avoid Infinity/NaN
    if (workDays === 0) return 0;

    // Calculate total available hours for a resource
    const totalAvailableHours = workDays * hoursPerDay;
    // Calculate the number of resources required
    const resourcesRequired = duration / totalAvailableHours;
    // Debug logs
    //console.log(`calculateResources Task Start: ${start}, Task End: ${end}, Duration: ${duration}`);
    //console.log(`calculateResources Total Days: ${totalDays}, Work Days: ${workDays}`);
    //console.log(`calculateResources Total Available Hours: ${totalAvailableHours}, Resources Required: ${resourcesRequired}`);

    return Math.ceil(resourcesRequired); // Round up to ensure all work can be done
}


function computeRiskAdjustedDurationsAndDates(nodes, links) {
    var cal = resolveCalendar();
    var workingHoursPerDay = cal.hoursPerDay;
    var workingDaysPerWeek = cal.workingDaysPerWeek;

    const startNode = nodes.find(node => String(node.ID) === "0") || nodes[0];
    const endNode = nodes.reduce((a, b) => (Number(a.ID) > Number(b.ID)) ? a : b);
    const paths = findAllPaths(startNode, endNode, links, nodes);

    // ── Build link lookup: "sourceID|targetID" → { type, lagHrs } ──
    // Used by the forward pass to propagate risk-adjusted dates correctly
    // for all 4 relationship types (FS, SS, FF, SF) instead of FS-only.
    const linkLookup = new Map();
    for (const link of links) {
        const sID = String(typeof link.source === 'object' ? link.source.ID : link.source);
        const tID = String(typeof link.target === 'object' ? link.target.ID : link.target);
        const type = String(link.type || link.Type || link.relation || link.Relation || 'FS').toUpperCase();
        const lagHrs = getLinkLagHours(link);
        const key = `${sID}|${tID}`;
        // Keep the most constraining edge if multiple exist between same pair
        if (!linkLookup.has(key)) {
            linkLookup.set(key, { type: (type === 'FS' || type === 'SS' || type === 'FF' || type === 'SF') ? type : 'FS', lagHrs });
        }
    }

    nodes.forEach(node => {
        // Use centralized overrun-to-multiplier conversion + clamping
        const clampedMultiplier = clampDurationMultiplier(overrunProbToMultiplier(node.overrun_probability));

        const baseDuration = Number(node.Duration) || 0;
        const riskAdjustedDuration = baseDuration * clampedMultiplier; // stored in the SAME units as node.Duration
        node.riskAdjustedDuration = riskAdjustedDuration;
        node.riskAdjustedStart = new Date(node.Start);

        const timeUnit = node.TimeUnits || "Hours";
        // Convenience normalized field (hours) for any module that wants to skip unit conversion.
        node.riskAdjustedDurationHrs = convertToHours(riskAdjustedDuration, timeUnit);

        node.resourcesRequired = calculateResources(node.Start, node.Finish, baseDuration, workingHoursPerDay, workingDaysPerWeek);

        if (node.isOnCriticalPath) {
            node.riskAdjustedEnd = addDurationToDate(node.riskAdjustedStart, riskAdjustedDuration, workingHoursPerDay * node.resourcesRequired, workingDaysPerWeek, timeUnit);
        } else {
            node.riskAdjustedEnd = addDurationToDate(node.riskAdjustedStart, riskAdjustedDuration, workingHoursPerDay * (node.resourcesRequired && node.resourcesRequired > 1 ? node.resourcesRequired : 1), workingDaysPerWeek, timeUnit);
        }
    });

    // ── Relationship-aware risk-adjusted forward pass ──
    // For each consecutive pair on a path, resolve the link type and propagate
    // the correct constraint date. Previously treated all links as FS, which
    // silently serialised concurrent work (SS) and caused 80%+ overstatement
    // on schedules with SS/FF/SF relationships.
    paths.forEach(path => {
        path.forEach((node, index) => {
            if (index === 0) return;

            const prevNode = path[index - 1];
            const linkKey = `${String(prevNode.ID)}|${String(node.ID)}`;
            const linkInfo = linkLookup.get(linkKey);
            const relType = linkInfo ? linkInfo.type : 'FS';
            const lagHrs = linkInfo ? (linkInfo.lagHrs || 0) : 0;

            // Compute the potential start date based on relationship type.
            //
            // CPM semantics (all in working time):
            //   FS: succ.ES >= pred.EF + lag         → start after predecessor finishes
            //   SS: succ.ES >= pred.ES + lag          → start after predecessor starts
            //   FF: succ.EF >= pred.EF + lag          → finish after predecessor finishes
            //       ⇒ succ.ES >= pred.EF + lag - dur
            //   SF: succ.EF >= pred.ES + lag          → finish after predecessor starts
            //       ⇒ succ.ES >= pred.ES + lag - dur
            let potentialStartDate;

            switch (relType) {
                case 'SS':
                    // Successor can start when predecessor starts (+ lag)
                    potentialStartDate = (lagHrs > 0)
                        ? addDurationToDate(prevNode.riskAdjustedStart, lagHrs, workingHoursPerDay, workingDaysPerWeek, "Hours")
                        : new Date(prevNode.riskAdjustedStart);
                    break;

                case 'FF': {
                    // Successor must finish after predecessor finishes (+ lag)
                    // → compute implied start: potentialEnd - node's calendar span
                    const potentialEnd = (lagHrs > 0)
                        ? addDurationToDate(prevNode.riskAdjustedEnd, lagHrs, workingHoursPerDay, workingDaysPerWeek, "Hours")
                        : new Date(prevNode.riskAdjustedEnd);
                    const calendarSpanMs = node.riskAdjustedEnd.getTime() - node.riskAdjustedStart.getTime();
                    potentialStartDate = new Date(potentialEnd.getTime() - calendarSpanMs);
                    break;
                }

                case 'SF': {
                    // Successor must finish after predecessor starts (+ lag)
                    // → compute implied start: potentialEnd - node's calendar span
                    const potentialEnd = (lagHrs > 0)
                        ? addDurationToDate(prevNode.riskAdjustedStart, lagHrs, workingHoursPerDay, workingDaysPerWeek, "Hours")
                        : new Date(prevNode.riskAdjustedStart);
                    const calendarSpanMs = node.riskAdjustedEnd.getTime() - node.riskAdjustedStart.getTime();
                    potentialStartDate = new Date(potentialEnd.getTime() - calendarSpanMs);
                    break;
                }

                case 'FS':
                default:
                    // Successor starts after predecessor finishes (+ lag)
                    potentialStartDate = (lagHrs > 0)
                        ? addDurationToDate(prevNode.riskAdjustedEnd, lagHrs, workingHoursPerDay, workingDaysPerWeek, "Hours")
                        : new Date(prevNode.riskAdjustedEnd);
                    break;
            }

            if (potentialStartDate > node.riskAdjustedStart) {
                node.riskAdjustedStart = potentialStartDate;
                const timeUnit = node.TimeUnits || "Hours";

                if (node.isOnCriticalPath) {
                    node.riskAdjustedEnd = addDurationToDate(node.riskAdjustedStart, node.riskAdjustedDuration, workingHoursPerDay * node.resourcesRequired, workingDaysPerWeek, timeUnit);
                } else {
                    node.riskAdjustedEnd = addDurationToDate(node.riskAdjustedStart, node.riskAdjustedDuration, workingHoursPerDay * (node.resourcesRequired && node.resourcesRequired > 1 ? node.resourcesRequired : 1), workingDaysPerWeek, timeUnit);
                }
            }
        });
    });
}

// compute the difference between two dates in terms of the given TimeUnits.
function computeDateDifference(startDate, endDate, workingHoursPerDay, workingDaysPerWeek, timeUnits) {
    const diff = endDate - startDate; // Difference in milliseconds
    switch (timeUnits) {
        case 'Hours':
            const hours = diff / (1000 * 60 * 60);
            return hours;
        case 'Days':
            return diff / (1000 * 60 * 60 * 24);
        case 'Weeks':
            return diff / (1000 * 60 * 60 * 24 * 7);
        default:
            throw new Error(`Unsupported time unit: ${timeUnits}`);
    }
}
function addWorkDays(startDate, daysToAdd, workingDaysPerWeek = 5) {
    let endDate = new Date(startDate);
    while (daysToAdd > 0) {
        endDate.setDate(endDate.getDate() + 1);
        // Convert Sunday=0 to 7 for easier comparison
        var day = endDate.getDay();
        var dayNum = day === 0 ? 7 : day;
        var isWorkDay = dayNum <= workingDaysPerWeek;
        if (isWorkDay) {
            daysToAdd--;
        }
    }
    return endDate;
}
/**
 * Convert link lag to hours with proper field fallback.
 * Mirrors getLinkLagHours from PathScripts.js for consistency.
 */
function getLagInHoursFromLink(link) {
    if (!link) return 0;

    // If lagHrs is already computed, use it
    if (typeof link.lagHrs === "number" && Number.isFinite(link.lagHrs)) {
        return link.lagHrs;
    }

    const raw = link.lag ?? 0;
    // Check lagUnits first, then timeUnits, then TimeUnits
    const units = link.lagUnits || link.timeUnits || link.TimeUnits || "Hours";
    return toWorkingHours(raw, units);
}

// ============================================================================
// BRANCH-BALANCED PATH EXPLORATION CONFIGURATION
// Added: January 15, 2026 - Eliminates path exploration bias with <1% overhead
// Rollback: Set ENABLE_BRANCH_BALANCED_EXPLORATION = false
// ============================================================================
const ENABLE_BRANCH_BALANCED_EXPLORATION = true;

const BRANCH_BALANCE_CONFIG = {
    maxPathsPerBranch: 100,        // Max paths per branch before applying penalty
    branchPenalty: 0.5,             // Priority reduction for over-represented branches (0.5 = 50%)
    rebalanceInterval: 500,         // Rebalance branch weights every N pushes
    enableLogging: false             // Enable detailed branch statistics logging
};

const ENABLE_PATH_CLUSTER_DETECTION = true;

const PATH_CLUSTER_CONFIG = {
    targetBins: 40,
    minBinWidth: 10,
    minPeakProminence: 0.12,
    minPeakSeparation: 0.04,
    minPathsInCluster: 3,
    pathsPerCluster: 30,
    clusterWidthFactor: 1.8,
    maxClusters: 5,
    minPathsForAnalysis: 20,
    enableLogging: false
};
// ============================================================================
// STRUCTURAL DIVERSITY PATH SELECTION
// Added: January 23, 2026 - Extract independent near-critical branches even when
// thousands of near-identical variants exist around the same backbone.
//
// Rollback: Set ENABLE_STRUCTURAL_DIVERSITY_SELECTION = false
// ============================================================================
const ENABLE_STRUCTURAL_DIVERSITY_SELECTION = true;

const STRUCTURAL_DIVERSITY_CONFIG = {
    maxPaths: 200,               // Cap of returned structurally independent paths
    enableAutoTune: true,       // Auto-tune knobs based on schedule/path characteristics (overridable)
    branchDepth: 4,              // How many early nodes define a branch
    midpointDepth: 3,            // Nodes around midpoint for within-branch diversity
    minPathsPerBranch: 3,        // Minimum per branch (auto-adjusted if too many branches)
    maxPathsPerBranch: 30,       // Maximum per branch
    applyWithinClusters: true,   // Apply diversity selection inside each duration cluster
    enableLogging: false,        // Keep false in production; enable for diagnostics
    // Independence filtering (suppresses thousands of micro-variants around the same backbone)
    enableIndependenceFilter: true,
    overlapThreshold: 0.92,     // Containment overlap threshold (edges); higher = stricter dedupe
    minUniqueEdges: 5,          // Require at least this many unique edges vs. any selected path
    familyCollapse: true,       // Collapse near-identical variants using deviation signatures
    maxPerFamily: 1,            // Representatives per family
    candidateMultiplier: 20,    // Analyze up to maxPaths * multiplier paths (bounded)
    candidateCap: 20000         // Absolute cap on candidates analyzed (safety)
};

// ============================================================================
// AUTO-TUNED STRUCTURAL DIVERSITY CONFIGURATION
// - Adjusts selection knobs based on schedule size/shape and path characteristics
// - Always overridable via:
//    1) options passed into extractIndependentNearCriticalPaths / extractStructurallyDiversePaths
//    2) window.cybereumConfig.structuralDiversity (if provided)
// ============================================================================

function _getGlobalStructuralDiversityOverrides() {
    try {
        const ov = window?.cybereumConfig?.structuralDiversity;
        return (ov && typeof ov === 'object') ? ov : {};
    } catch (e) { return {}; }
}

function _computeScheduleStatsForTuning(pathsData, options = {}) {
    const stats = {
        nodeCount: 0,
        linkCount: 0,
        pathCount: Array.isArray(pathsData?.paths) ? pathsData.paths.length : 0,
        criticalEdges: 0,
        medianEdges: 0,
        p90Edges: 0,
        prefixUniqByDepth: {},
        sampleCount: 0,
        durationMax: 0,
        durationMedian: 0,
        durationP90: 0,
        durationPeakShare: 0
    };

    // Prefer explicit nodes/links, fall back to cybereumState maps.
    const nodes = options.nodes;
    const links = options.links;

    if (Array.isArray(nodes)) stats.nodeCount = nodes.length;

    if (Array.isArray(links)) stats.linkCount = links.length;

    if (!stats.nodeCount) {
        const nm = options.nodeMap || window?.cybereumState?.nodeMap;
        if (nm && typeof nm.size === 'number') stats.nodeCount = nm.size;
    }

    if (!stats.linkCount) {
        const sm = options.succMap || window?.cybereumState?.succMap;
        if (sm && typeof sm.values === 'function') {
            let c = 0;
            for (const arr of sm.values()) c += Array.isArray(arr) ? arr.length : 0;
            stats.linkCount = c;
        }
    }

    // Path length stats from a bounded sample (keeps it cheap)
    const paths = Array.isArray(pathsData?.paths) ? pathsData.paths : [];
    const sampleN = Math.min(paths.length, 2000);
    stats.sampleCount = sampleN;

    const lens = [];
    for (let i = 0; i < sampleN; i++) {
        const p = paths[i];
        if (Array.isArray(p)) lens.push(Math.max(0, p.length - 1));
    }
    lens.sort((a, b) => a - b);

    const pick = (q) => lens.length ? lens[Math.min(lens.length - 1, Math.max(0, Math.floor(q * (lens.length - 1))))] : 0;

    stats.medianEdges = pick(0.5);
    stats.p90Edges = pick(0.9);

    const refPath = options.refPath || (paths.length ? paths[0] : null);
    if (Array.isArray(refPath)) stats.criticalEdges = Math.max(0, refPath.length - 1);

    // Prefix uniqueness curve: helps choose branchDepth robustly.
    // NOTE: some schedules have very long common prefixes (design-release "backbones") where meaningful fan-out
    // happens well after depth 8. Scan deeper but keep bounded and sampled (still cheap).
    const hardMaxDepth = 40;
    const p90 = stats.p90Edges || stats.medianEdges || 0;
    const maxDepth = Math.max(8, Math.min(hardMaxDepth, Math.floor(p90 ? (p90 * 0.45) : 12)));
    for (let d = 2; d <= maxDepth; d++) {
        const set = new Set();
        for (let i = 0; i < sampleN; i++) {
            const p = paths[i];
            if (!Array.isArray(p) || p.length < d) continue;
            // Use a cheap join on first d nodes
            set.add(p.slice(0, d).join('>'));
            if (set.size > 5000) break; // stop runaway growth
        }
        stats.prefixUniqByDepth[d] = set.size;
    }

    // ---- Duration distribution stats (top slice; used for tuning dense near-critical clusters) ----
    const rawDurations = Array.isArray(pathsData?.durations) ? pathsData.durations : null;
    if (rawDurations && rawDurations.length) {
        // Focus on the near-critical region to detect heavy clustering around the driving path.
        const maxSample = Math.min(rawDurations.length, 2000);
        const durSample = new Array(maxSample);
        for (let i = 0; i < maxSample; i++) durSample[i] = Number(rawDurations[i]);

        // Compact in place (drop NaN/Infinity).
        let k = 0;
        for (let i = 0; i < maxSample; i++) {
            const v = durSample[i];
            if (Number.isFinite(v)) durSample[k++] = v;
        }
        durSample.length = k;

        if (k > 0) {
            // Ensure descending order (max first).
            durSample.sort((a, b) => b - a);
            stats.durationMax = durSample[0];
            stats.durationMedian = durSample[Math.floor(k / 2)];
            // 90th percentile (high duration) when array is sorted DESC: index = (1 - 0.90) * (k - 1).
            stats.durationP90 = durSample[Math.floor(0.10 * (k - 1))];

            // Peak share: share of paths that fall into the densest duration bin (detects heavy clustering).
            if (k >= 20) {
                const maxD = durSample[0];
                const minD = durSample[k - 1];
                const range = maxD - minD;

                if (range <= 1) {
                    stats.durationPeakShare = 1;
                } else {
                    const numBins = 25;
                    const binWidth = range / numBins;
                    const bins = new Array(numBins).fill(0);

                    for (let i = 0; i < k; i++) {
                        const idx = Math.min(Math.floor((maxD - durSample[i]) / binWidth), numBins - 1);
                        bins[idx]++;
                    }

                    let peak = 0;
                    for (let i = 0; i < numBins; i++) if (bins[i] > peak) peak = bins[i];
                    stats.durationPeakShare = peak / k;
                }
            }
        }
    }

    return stats;
}

// Choose a branchDepth based on prefix uniqueness saturation:
// pick the smallest depth that achieves >= 80% of the max uniqueness (within 2..8).
function _autoSelectBranchDepth(stats, fallback = 4) {
    const uniq = stats?.prefixUniqByDepth || {};
    const depths = Object.keys(uniq).map(Number).sort((a, b) => a - b);
    if (!depths.length) return fallback;

    let maxU = 0;
    for (const d of depths) maxU = Math.max(maxU, uniq[d] || 0);
    if (maxU <= 1) return fallback;

    // Prefer a depth that yields a manageable number of distinct early branches.
    // Too small => everything looks identical; too large => every path is unique (not useful for grouping).
    const baseCount = stats?.pathCount || stats?.sampleCount || 0;
    const minBranches = Math.min(10, Math.max(3, Math.floor(Math.sqrt(Math.max(1, baseCount)) / 4)));
    const maxBranches = 50;

    // 1) Smallest depth that reaches at least minBranches but doesn't exceed maxBranches
    for (const d of depths) {
        const u = uniq[d] || 0;
        if (u >= minBranches && u <= maxBranches) return d;
    }

    // 2) Otherwise, smallest depth that produces >1 branch and stays within maxBranches
    for (const d of depths) {
        const u = uniq[d] || 0;
        if (u > 1 && u <= maxBranches) return d;
    }

    // 3) Otherwise, pick the deepest scanned depth (bounded) as a last resort
    return depths[depths.length - 1] || fallback;
}

function _autoTuneStructuralDiversity(baseCfg, stats) {
    const tuned = {};
    const nodeCount = stats.nodeCount || 0;
    const linkCount = stats.linkCount || 0;
    const medianEdges = stats.medianEdges || 0;
    const p90Edges = stats.p90Edges || 0;
    const criticalEdges = stats.criticalEdges || 0;

    // 1) Branch depth: adapt to how quickly the schedule meaningfully fans out.
    tuned.branchDepth = _autoSelectBranchDepth(stats, baseCfg.branchDepth);

    // 2) Output size budget (maxPaths): scale with project size but clamp to safe limits.
    //    Rationale: large schedules have more parallel interfaces worth sampling, but selection must stay bounded.
    let mp;
    if (nodeCount > 0) {
        if (nodeCount < 600) mp = 80;
        else if (nodeCount < 1500) mp = 120;
        else if (nodeCount < 4000) mp = 180;
        else if (nodeCount < 12000) mp = 220;
        else mp = 260;
    } else {
        // fallback when nodeCount isn't available: scale by path length
        mp = (p90Edges > 300) ? 220 : (p90Edges > 120 ? 180 : 120);
    }
    // Slight bump for dense logic networks
    if (linkCount > 0 && nodeCount > 0) {
        const density = linkCount / Math.max(1, nodeCount);
        if (density > 3.5) mp = Math.min(320, mp + 40);
        else if (density > 2.5) mp = Math.min(300, mp + 20);
    }
    tuned.maxPaths = Math.max(40, Math.min(400, mp));

    // 3) Candidate gating: tighten for very large schedules to prevent UI stalls.
    tuned.candidateMultiplier = (nodeCount > 8000 || linkCount > 20000) ? 12 : 20;
    tuned.candidateCap = (nodeCount > 12000 || linkCount > 35000) ? 12000 : (nodeCount > 8000 ? 15000 : 20000);

    // 4) Independence thresholding: adapt to typical path length.
    //    Long paths naturally share big common suffixes; keep overlapThreshold slightly higher (more tolerant).
    const L = Math.max(medianEdges, criticalEdges);
    let minUnique;
    if (L < 60) minUnique = 4;
    else if (L < 120) minUnique = 5;
    else if (L < 250) minUnique = 8;
    else if (L < 500) minUnique = 12;
    else minUnique = 15;
    tuned.minUniqueEdges = minUnique;

    let ov;
    if (L < 80) ov = 0.90;
    else if (L < 200) ov = 0.92;
    else if (L < 450) ov = 0.94;
    else ov = 0.95;
    tuned.overlapThreshold = ov;

    if ((stats.durationPeakShare || 0) >= 0.6) {
        tuned.overlapThreshold = Math.min(0.97, (tuned.overlapThreshold || ov) + 0.02);
    }

    // 5) Within-branch diversity: if paths are very short, midpointDepth 2 is enough.
    tuned.midpointDepth = (L < 80) ? 2 : baseCfg.midpointDepth;

    // Keep these stable unless explicitly overridden
    tuned.familyCollapse = true;
    tuned.maxPerFamily = 1;

    return tuned;
}

// Resolve final structural diversity config for a given run:
// base defaults -> auto-tuned -> global overrides -> per-call options
function _resolveStructuralDiversityConfig(pathsData, options = {}) {
    const base = { ...STRUCTURAL_DIVERSITY_CONFIG };
    const globalOv = _getGlobalStructuralDiversityOverrides();

    if (!base.enableAutoTune || options.enableAutoTune === false) {
        return { ...base, ...globalOv, ...options };
    }

    const stats = _computeScheduleStatsForTuning(pathsData, options);
    const tuned = _autoTuneStructuralDiversity(base, stats);

    const cfg = { ...base, ...tuned, ...globalOv, ...options };

    // Sanity clamps (avoid bad overrides)
    cfg.maxPaths = Math.max(1, Math.min(cfg.maxPaths, 1000));
    cfg.branchDepth = Math.max(2, Math.min(cfg.branchDepth, 30));
    cfg.midpointDepth = Math.max(1, Math.min(cfg.midpointDepth, 8));
    cfg.minPathsPerBranch = Math.max(1, Math.min(cfg.minPathsPerBranch, 20));
    cfg.maxPathsPerBranch = Math.max(cfg.minPathsPerBranch, Math.min(cfg.maxPathsPerBranch, 200));
    cfg.candidateMultiplier = Math.max(3, Math.min(cfg.candidateMultiplier, 50));
    cfg.candidateCap = Math.max(cfg.maxPaths, Math.min(cfg.candidateCap, 50000));
    cfg.overlapThreshold = Math.max(0.70, Math.min(cfg.overlapThreshold, 0.99));
    cfg.minUniqueEdges = Math.max(0, Math.min(cfg.minUniqueEdges, 200));

    return cfg;
}


// ============================================================================
// SECTION D: VISUALIZATION ENHANCEMENTS
// ============================================================================
// ADD THIS AFTER THE drawPathsDistributionCurve FUNCTION
// ============================================================================

/**
 * Get distinct color for each cluster in visualizations
 * 
 * @param {number} index - Cluster index (0-based)
 * @returns {string} - Hex color code
 */
function getClusterColor(index) {
    const colors = [
        '#46b9fa',  // Primary blue (existing)
        '#ff6b6b',  // Coral red
        '#4ecdc4',  // Teal
        '#ffe66d',  // Yellow
        '#95e1d3',  // Mint
        '#dda0dd',  // Plum
        '#87ceeb'   // Sky blue
    ];
    return colors[index % colors.length];
}

/**
 * Add visual annotations showing cluster peaks on the distribution chart
 * Call this after drawPathsDistributionCurve when clusters are detected
 * 
 * @param {Array} clusters - Cluster info array from detectPathClusters or findOutlierPaths2._clusterInfo
 */
function annotateClusterPeaks(clusters) {
    if (!clusters || clusters.length <= 1) return;  // No annotation needed for single cluster

    const chartEl = document.getElementById('path_distribution_chart');
    if (!chartEl) return;

    // Remove existing annotation if present
    const existingOverlay = chartEl.querySelector('.cluster-annotations');
    if (existingOverlay) {
        existingOverlay.remove();
    }

    // Create annotation overlay
    const overlay = document.createElement('div');
    overlay.className = 'cluster-annotations';
    overlay.style.cssText = `
        position: absolute;
        top: 45px;
        right: 15px;
        background: rgba(17, 52, 100, 0.92);
        padding: 10px 12px;
        border-radius: 6px;
        font-size: 11px;
        color: var(--cyb-accent2, #b4f5ff);
        border: 1px solid rgba(70, 185, 250, 0.3);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        z-index: 100;
        max-width: 200px;
    `;

    // Ensure chart container has relative positioning
    if (getComputedStyle(chartEl).position === 'static') {
        chartEl.style.position = 'relative';
    }

    // Build annotation content
    let html = `
        <div style="margin-bottom: 6px; color: var(--cyb-text1, #fff); font-weight: bold; font-size: 12px;">
            📊 Path Clusters Detected
        </div>
    `;

    clusters.forEach((c, i) => {
        const peakHrs = typeof c.peakDuration === 'number' ? Math.round(c.peakDuration) : c.peakDuration;
        const pathCount = c.pathCount || '?';
        html += `
            <div style="margin: 4px 0; display: flex; align-items: center;">
                <span style="color: ${getClusterColor(i)}; font-size: 14px; margin-right: 6px;">●</span>
                <span>Cluster ${i + 1}: ~${peakHrs.toLocaleString()} hrs</span>
                <span style="color: var(--cyb-textSecondary, #7fb8d8); margin-left: auto;">(${pathCount})</span>
            </div>
        `;
    });

    overlay.innerHTML = html;
    chartEl.appendChild(overlay);
}

/**
 * Enhanced version of drawPathsDistributionCurve that shows cluster annotations
 * This wraps the original function to add cluster visualization
 * 
 * @param {Array} nodes - Node array
 * @param {Array} links - Link array  
 * @param {Array} paths - Path array
 * @param {Array} precomputedDurations - Optional precomputed durations
 * @returns {Promise} - Resolves when chart is drawn
 */
function drawPathsDistributionCurveWithClusters(nodes, links, paths, precomputedDurations) {
    // First draw the base chart
    return drawPathsDistributionCurve(nodes, links, paths, precomputedDurations)
        .then(() => {
            // Check if we should add cluster annotations
            if (!ENABLE_PATH_CLUSTER_DETECTION || !precomputedDurations?.length) {
                return;
            }

            // Analyze distribution for cluster info
            const analysis = analyzePathDistribution(precomputedDurations);

            if (analysis.isMultimodal && analysis.clusters?.length > 1) {
                annotateClusterPeaks(analysis.clusters);
            }
        })
        .catch(err => {
            console.error('drawPathsDistributionCurveWithClusters error:', err);
        });
}

/**
 * Update the path distribution chart with cluster annotations if outlier result has cluster info
 * Call this after computing outlier paths to add cluster visualization
 * 
 * @param {Object} outlierResult - Result from findOutlierPaths2 (may have _clusterInfo)
 */
function updateDistributionChartWithClusters(outlierResult) {
    if (outlierResult?._clusterInfo?.length > 1) {
        annotateClusterPeaks(outlierResult._clusterInfo);
    }
}

/**
 * Convert a duration value to WORKING hours (canonical).
 * Uses working-time assumptions (DEFAULT_HOURS_PER_DAY, DEFAULT_WORKING_DAYS).
 *
 * Supported units (case-insensitive):
 *  - Hours:   "hours","hour","hr","h"
 *  - Minutes: "minutes","minute","min","m"   (NOTE: "m" treated as minutes)
 *  - Days:    "days","day","d"
 *  - Weeks:   "weeks","week","w","wk"
 *  - Months:  "months","month","mo","mon","mons" (≈ 4.345 weeks)
 *  - Years:   "years","year","y","yr"            (≈ 52 weeks)
 */
function convertDurationToHours(duration, timeUnits) {
    const HOURS_PER_DAY =
        (typeof CONFIG !== "undefined" && CONFIG && Number.isFinite(CONFIG.workingHoursPerDay) && CONFIG.workingHoursPerDay > 0)
            ? CONFIG.workingHoursPerDay
            : (Number.isFinite(window.DEFAULT_HOURS_PER_DAY) && window.DEFAULT_HOURS_PER_DAY > 0 ? window.DEFAULT_HOURS_PER_DAY : 8);

    const DAYS_PER_WEEK =
        (typeof CONFIG !== "undefined" && CONFIG && Number.isFinite(CONFIG.workingDaysPerWeek) && CONFIG.workingDaysPerWeek > 0)
            ? CONFIG.workingDaysPerWeek
            : (Array.isArray(window.DEFAULT_WORKING_DAYS) && window.DEFAULT_WORKING_DAYS.length > 0 ? window.DEFAULT_WORKING_DAYS.length : 5);

    // Very high cap to prevent runaway charts / loops; keep configurable if you want.
    const MAX_HOURS =
        (typeof CONFIG !== "undefined" && CONFIG && Number.isFinite(CONFIG.maxWorkingHoursToAdd) && CONFIG.maxWorkingHoursToAdd > 0)
            ? Math.max(CONFIG.maxWorkingHoursToAdd, 1000) // ensure it's not too small for durations
            : 1_000_000;

    const d = Number(duration);
    if (!Number.isFinite(d) || d <= 0) return 0;

    const u = String(timeUnits ?? "Hours").trim().toLowerCase();

    const WEEKS_PER_MONTH = 4.345;
    const WEEKS_PER_YEAR = 52;

    let hours;

    if (u === "hours" || u === "hour" || u === "hr" || u === "h") {
        hours = d;
    } else if (u === "minutes" || u === "minute" || u === "min" || u === "m") {
        // "m" treated as minutes (explicitly NOT months)
        hours = d / 60;
    } else if (u === "days" || u === "day" || u === "d") {
        hours = d * HOURS_PER_DAY;
    } else if (u === "weeks" || u === "week" || u === "w" || u === "wk") {
        hours = d * DAYS_PER_WEEK * HOURS_PER_DAY;
    } else if (u === "months" || u === "month" || u === "mo" || u === "mon" || u === "mons") {
        hours = d * WEEKS_PER_MONTH * DAYS_PER_WEEK * HOURS_PER_DAY;
    } else if (u === "years" || u === "year" || u === "y" || u === "yr") {
        hours = d * WEEKS_PER_YEAR * DAYS_PER_WEEK * HOURS_PER_DAY;
    } else {
        // Unknown unit: safest is to treat as hours to avoid understating time.
        if (typeof console !== "undefined") {
            console.warn(`convertDurationToHours: Unknown unit "${timeUnits}", treating as hours`);
        }
        hours = d;
    }

    if (!Number.isFinite(hours) || hours <= 0) return 0;
    return Math.min(hours, MAX_HOURS);
}

// Compatibility alias so other modules can standardize on convertToHours(...)
window.convertToHours = convertToHours;


/**
 * Returns a node's duration normalized to HOURS, honoring node.TimeUnits and global DEFAULT_HOURS_PER_DAY.
 * Use this everywhere you previously used node.Duration directly in CPM/path math.
 *
 * @param {Object} node
 * @param {string} [field="Duration"] - Which field to read (e.g., "Duration", "riskAdjustedDuration")
 * @param {string} [unitsField="TimeUnits"] - Which field contains the units (defaults to node.TimeUnits)
 * @returns {number} duration in HOURS
 */
function getNodeDurationHours(node, field = "Duration", unitsField = "TimeUnits") {
    if (!node) return 0;
    const raw = node[field];
    const units = (node[unitsField] || node.TimeUnits || "Hours");
    return convertDurationToHours(raw, units);
}


/**
 * Convert duration to calendar milliseconds (for date arithmetic)
 */
function toCalendarMs(duration, timeUnits) {
    const d = +duration;
    if (!isFinite(d) || d < 0) return 0;

    const tu = String(timeUnits || 'Hours').toLowerCase();
    const MS_PER_HOUR = 3600000;

    switch (tu[0]) {
        case 'm':
            if (tu.length > 1 && tu[1] === 'o') {
                return d * 30 * 24 * 3600000; // months (approximate)
            }
            return d * 60000; // minutes
        case 'h': return d * MS_PER_HOUR;
        case 'd': return d * CONFIG.CALENDAR_HOURS_PER_DAY * MS_PER_HOUR;
        case 'w': return d * 7 * CONFIG.CALENDAR_HOURS_PER_DAY * MS_PER_HOUR;
        default: return d * MS_PER_HOUR;
    }
}

/**
 * Returns a dependency lag normalized to HOURS (uses precomputed lagHrs when available).
 * @param {Object} link
 * @returns {number}
 */
function getLinkLagHours(link) {
    if (!link) return 0;
    if (typeof link.lagHrs === "number" && Number.isFinite(link.lagHrs)) {
        return link.lagHrs;
    }
    const raw = link.lag ?? 0;
    const units = link.lagUnits || link.timeUnits || link.TimeUnits || "Hours";
    return convertToHours(raw, units);
}

const teamCalendar = {
    name: "DefaultCalendar",
    hoursPerDay: 8,
    workingDays: [1, 2, 3, 4, 5], // Monday=1 ... Sunday=7
    holidays: [
        "2024-01-01", // New Year's Day
        "2024-12-25"  // Christmas
    ]
};


/**
 * isWorkingDay checks if `date` is considered a working day
 * according to the teamCalendar’s weekdays and holidays.
 */
// Updated isWorkingDay function with proper fallbacks and LOCAL time handling
function isWorkingDay(date, calendar) {
    // Ensure we have a valid calendar object with default values
    const teamCalendar = calendar || {};
    const workingDays = teamCalendar.workingDays || [1, 2, 3, 4, 5]; // Default Mon-Fri
    const holidays = teamCalendar.holidays || []; // Default empty array if undefined

    // JS getDay(): 0=Sun..6=Sat.  Calendar convention: 1=Mon..7=Sun.
    // Map Sunday 0→7 so both conventions match (P6 imports use 0-6, PathScripts uses 1-7).
    const jsDay = date.getDay();
    const calDay = jsDay === 0 ? 7 : jsDay;
    if (!workingDays.includes(jsDay) && !workingDays.includes(calDay)) {
        return false;
    }

    // 2) Check if date is in the holiday list
    // Format as local "YYYY-MM-DD" string (avoids UTC timezone shift)
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const localDateStr = `${year}-${month}-${day}`;

    if (holidays.includes(localDateStr)) {
        return false;
    }

    return true;
}

// Helper functions for date manipulation
function getFirstDayOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getLastDayOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * renderCalendarView
 * 
 * Renders an HTML table showing each day from startDate to endDate with activity indicators.
 * Features optimized activity display and calendar settings editor with date details modal.
 *
 * @param {Object} teamCalendar - Calendar settings object with working days/hours/holidays
 * @param {string} elementId - ID of the DOM container to place the calendar
 * @param {Array} nodes - Array of activity nodes to display on the calendar
 * @param {Object} options - Display options
 */
function renderCalendarView(teamCalendar, elementId, nodes, options = {}) {
    // ----- Time-zone-safe calendar preparation & caching -----------------------------
    function prepareCalendar(cal) {
        if (!cal) cal = {};
        if (!Array.isArray(cal.workingDays)) cal.workingDays = [1, 2, 3, 4, 5];
        if (!Array.isArray(cal.holidays)) cal.holidays = [];
        if (!cal.holidaySet) cal.holidaySet = new Set(cal.holidays || []);
        if (!cal.workDaySet) cal.workDaySet = new Set(cal.workingDays || [1, 2, 3, 4, 5]);
        if (!("hoursPerDay" in cal)) cal.hoursPerDay = 8;
        return cal;
    }

    /**
     * Is the ISO date (or Date obj) a working day in the given time-zone?
     *
     * @param {string|Date} dateISO - e.g. "2025-04-29"
     * @param {object} calendar - { workingDays: [1..7], holidays:[yyyy-mm-dd] }
     * @param {string} timeZone - IANA zone, default browser zone
     */
    function isWorkingDay(dateISO, calendar) {
        calendar = prepareCalendar(calendar);
        const d = new Date(dateISO);
        const weekday = d.getDay() === 0 ? 7 : d.getDay();
        const iso = normalizeToISODate(d);
        return calendar.workDaySet.has(weekday) && !calendar.holidaySet.has(iso);
    }

    // Normalize date string to ISO format (YYYY-MM-DD)
    function normalizeToISODate(date) {
        if (date instanceof Date) {
            var y = date.getFullYear();
            var m = String(date.getMonth() + 1).padStart(2, '0');
            var d = String(date.getDate()).padStart(2, '0');
            return y + '-' + m + '-' + d;
        }
        return date; // Assume it's already a YYYY-MM-DD string
    }

    // Cache modal elements
    const modalElements = new Map();
    function getModalElement(id) {
        if (!modalElements.has(id)) {
            modalElements.set(id, document.getElementById(id));
        }
        return modalElements.get(id);
    }

    const defaultOptions = {
        monthsPerRow: 3,
        showLegend: true,
        showWeekNumbers: false,
        compactView: false,
        showAllIcons: false
    };
    const startDate = window.cybereumState.startDate;
    const endDate = window.cybereumState.endDate;
    console.log("renderCalendarView: ", startDate, endDate); // Changed from error to log
    const settings = { ...defaultOptions, ...options };

    if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
        console.error("renderCalendarView: invalid start/end date");
        return;
    }

    // Initialize teamCalendar with prepared Sets for faster lookups
    teamCalendar = prepareCalendar(teamCalendar);

    // Load saved calendar from localStorage if available
    try {
        const savedCalendar = localStorage.getItem('teamCalendar');
        if (savedCalendar) {
            const parsedCalendar = JSON.parse(savedCalendar);
            Object.assign(teamCalendar, parsedCalendar);
            // Rebuild the Sets after loading
            teamCalendar = prepareCalendar(teamCalendar);
        }
    } catch (e) {
        console.warn('Could not load calendar from localStorage:', e);
    }

    // Initialize accent color variable for styling if not already defined
    if (!document.documentElement.style.getPropertyValue('--accent-color-light')) {
        document.documentElement.style.setProperty('--accent-color-light', 'rgba(90, 200, 250, 0.2)');
    }

    // Preprocess activities from nodes – assign type, icon, and color
    function preprocessActivities(nodes) {
        return {
            highRisk: nodes.filter(n => n.isRiskOutlier).map(node => ({
                ...node,
                startDate: new Date(node.Start),
                finishDate: new Date(node.Finish),
                type: 'risk',
                icon: '⚠️',
                color: 'var(--red)'
            })),
            highImpact: nodes.filter(n => n.isImportanceOutlier).map(node => ({
                ...node,
                startDate: new Date(node.Start),
                finishDate: new Date(node.Finish),
                type: 'impact',
                icon: '⭐',
                color: 'var(--accent-color)'
            })),
            criticalPath: nodes.filter(n => n.isOnCriticalPath).map(node => ({
                ...node,
                startDate: new Date(node.Start),
                finishDate: new Date(node.Finish),
                type: 'critical',
                icon: '🔴',
                color: 'var(--delayed-color)'
            })),
            nearCritical: nodes.filter(n => n.isOnOutlierPath).map(node => ({
                ...node,
                startDate: new Date(node.Start),
                finishDate: new Date(node.Finish),
                type: 'near-critical',
                icon: '🟡',
                color: 'var(--orange)'
            })),
            milestones: nodes.filter(n => n.Milestone).map(node => ({
                ...node,
                startDate: new Date(node.Start),
                finishDate: new Date(node.Finish),
                type: 'milestone',
                icon: '🎯',
                color: 'var(--green)'
            }))
        };
    }
    const activities = preprocessActivities(nodes);

    // Memoize activity lookups for better performance
    const activityCache = new Map();

    // Get activities for a specific date
    function getActivitiesForDate(date) {
        const dateStr = normalizeToISODate(date);

        // Check cache first
        if (activityCache.has(dateStr)) {
            return activityCache.get(dateStr);
        }

        const activeActivities = [];
        Object.entries(activities).forEach(([category, acts]) => {
            acts.forEach(activity => {
                const startStr = normalizeToISODate(activity.startDate);
                const finishStr = normalizeToISODate(activity.finishDate);
                if (dateStr >= startStr && dateStr <= finishStr) {
                    activeActivities.push({
                        ...activity,
                        isStart: dateStr === startStr,
                        isFinish: dateStr === finishStr
                    });
                }
            });
        });

        // Store in cache for future lookups
        activityCache.set(dateStr, activeActivities);
        return activeActivities;
    }

    // Generate tooltip content for a given day with improved formatting
    function generateTooltip(activities) {
        return activities.map((activity, index) => {
            const status = activity.isStart ? 'Starts' : activity.isFinish ? 'Ends' : 'Ongoing';
            const dates = activity.isStart
                ? activity.startDate.toLocaleDateString()
                : activity.isFinish
                    ? activity.finishDate.toLocaleDateString()
                    : `${activity.startDate.toLocaleDateString()} - ${activity.finishDate.toLocaleDateString()}`;

            // Add divider except for last item
            const divider = index < activities.length - 1 ?
                '<div style="height: 1px; background: rgba(255,255,255,0.1); margin: 5px 0;"></div>' : '';

            return `
                <div class="tooltip-item">
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <span style="color: ${activity.color}">${activity.icon}</span>
                        <strong>${activity.Name}</strong>
                    </div>
                    <div style="margin-left: 10px; margin-top: 2px; color: var(--secondary-text);">
                        • ${status}: ${dates}
                    </div>
                    ${divider}
                </div>
            `;
        }).join('');
    }

    // Start building HTML
    let html = `
        <style>
            .calendar-tooltip {
                position: absolute;
                background: var(--card-bg, rgba(13, 33, 55, 0.9));
                color: var(--primary-text, #fff);
                padding: 10px;
                border-radius: 4px;
                z-index: 1000;
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                display: none;
                width: 250px;
                max-width: 300px;
                max-height: 200px;
                overflow-y: auto;
                font-size: 0.9em;
                border: 1px solid var(--accent-color, #5ac8fa);
                /* Improved positioning logic */
                left: 50%;
                transform: translateX(-50%);
                bottom: 100%;
                margin-bottom: 5px;
            }
            .calendar-cell:hover .calendar-tooltip {
                display: block;
            }
            .activity-indicator {
                margin: 0 2px;
                position: relative;
                z-index: 20;
            }
            .current-day-indicator {
                position: absolute;
                top: 2px;
                right: 2px;
                background: var(--accent-color);
                color: var(--cyb-text1, #fff);
                padding: 2px 4px;
                border-radius: 4px;
                font-size: 0.7em;
                z-index: 5;
            }
            .activity-count {
                position: absolute;
                top: -5px;
                right: -5px;
                background: var(--accent-color);
                color: white;
                border-radius: 50%;
                width: 14px;
                height: 14px;
                font-size: 0.6em;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
            }
            .activity-summary-indicator {
                position: relative;
                box-shadow: 0 1px 3px rgba(0,0,0,0.3);
                transition: transform 0.2s;
            }
            .activity-summary-indicator:hover {
                transform: scale(1.1);
            }
            
            /* Modal styles */
            .modal-overlay {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 8, 20, 0.95);
                align-items: center;
                justify-content: center;
                z-index: 2000;
                padding: 20px;
                box-sizing: border-box;
                overflow-y: auto;
            }
            
            .modal-overlay .dashboard {
                position: relative;
                width: 95%;
                max-width: 1400px;
                max-height: calc(100vh - 40px);
                margin: 0 auto;
                background: var(--bg-darker, #091625);
                border-radius: 10px;
                border: 1px solid rgba(90, 200, 250, 0.5);
                box-shadow: 0 0 20px rgba(90, 200, 250, 0.3);
                display: grid;
                grid-template-rows: auto 1fr auto;
                gap: 0;
                padding: 0;
                overflow: hidden;
            }
            
            .modal-overlay .header {
                display: flex;
                flex-wrap: wrap;
                justify-content: space-between;
                align-items: flex-start;
                padding: 15px 20px;
                background: var(--bg-darker, #091625);
                border-bottom: 1px solid rgba(90, 200, 250, 0.5);
                position: relative;
            }
            
            .modal-overlay .header h1 {
                font-size: 28px;
                color: var(--bright, #8ce6ff);
                margin: 0;
                font-family: var(--font-orbitron, 'Orbitron', sans-serif);
                text-shadow: 0 0 10px rgba(90, 200, 250, 0.7);
            }

            .modal-overlay .header .subtitle {
                font-size: 20px;
                color: var(--text, #cdfaff);
                opacity: 0.8;
                font-family: var(--font-roboto, 'Roboto', sans-serif);
            }
            
            .modal-overlay .header .project-timeline {
                font-size: 22px;
                color: var(--bright, #cdfaff);
                text-align: right;
                font-family: var(--font-orbitron, 'Orbitron', sans-serif);
                text-shadow: 0 0 10px rgba(90, 200, 250, 0.7);
            }
            
            .modal-overlay .header .date-time {
                font-size: 16px;
                color: var(--text, #cdfaff);
                margin-top: 10px;
                font-family: var(--font-roboto, 'Roboto', sans-serif);
            }
            
            .modal-overlay .main-content {
                display: grid;
                grid-template-columns: 2fr 1fr;
                gap: 20px;
                padding: 20px;
                min-height: 0;
                overflow-y: auto;
            }
            
            .modal-overlay .section {
                background: var(--bg-darker, #091625);
                border: 1px solid rgba(90, 200, 250, 0.2);
                padding: 15px;
                position: relative;
                margin-bottom: 15px;
            }
            
            .modal-overlay .section::before {
                content: '';
                position: absolute;
                top: -1px;
                left: -1px;
                right: -1px;
                height: 2px;
                background: linear-gradient(to right, transparent, var(--primary, #46b9fa), transparent);
            }
            
            .modal-overlay .section h2 {
                margin-top: 0;
                color: var(--bright, #8ce6ff);
                font-family: var(--font-orbitron, 'Orbitron', sans-serif);
                text-shadow: 0 0 10px rgba(90, 200, 250, 0.7);
                margin-bottom: 15px;
            }
            
            .modal-overlay .project-overview {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
                font-size: 16px;
                color: var(--text, #cdfaff);
            }
            
            .modal-overlay .project-overview div {
                margin-bottom: 10px;
            }
            
            .modal-overlay .footer {
                display: flex;
                flex-wrap: wrap;
                justify-content: flex-end;
                gap: 15px;
                padding: 15px;
                background: var(--bg-darker, #091625);
                border-top: 1px solid rgba(90, 200, 250, 0.2);
                flex-direction: row !important;
                flex-shrink: 0;
            }
            
            .modal-overlay .action-button {
                background-color: rgba(14, 36, 70, 0.8);
                border: 2px solid var(--primary, #46b9fa);
                color: var(--text, #cdfaff);
                font-size: 16px;
                cursor: pointer;
                display: flex;
                align-items: center;
                padding: 6px 12px;
                height: 38px;
                position: relative;
                overflow: hidden;
                box-shadow: 0 0 10px rgba(50, 146, 205, 0.5);
                font-family: var(--font-rajdhani, 'Rajdhani', sans-serif);
                gap: 10px;
                justify-content: space-between;
                border-radius: 4px;
                transition: all 0.2s;
                width: auto;
                max-width: 200px;
            }
            
            .modal-overlay .action-button:hover {
                background: var(--primary, #46b9fa);
                color: var(--bg-darker, #091625);
                box-shadow: 0 0 10px rgba(90, 200, 250, 0.7);
            }
            
            .modal-overlay .icon-box {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                margin-right: 0;
                margin-left: 5px;
                border: 1px solid var(--cyb-primary, #5ac8fa);
                padding: 1px 6px;
                box-shadow: 0 0 3px #5ac8fa, inset 0 0 3px #5ac8fa;
            }
            
            .modal-overlay .icon {
                color: var(--cyb-text1, #cdfaff);
                text-shadow: 0 0 2px #8ce6ff, 0 0 4px #8ce6ff;
                font-weight: 700;
                letter-spacing: 1px;
            }
            
            .milestone {
                margin-bottom: 12px;
                padding-bottom: 12px;
                border-bottom: 1px solid rgba(90, 200, 250, 0.1);
                color: var(--text, #cdfaff);
            }
            
            /* Calendar settings panel - simplified UI */
            .calendar-settings-panel {
                margin-top: 20px;
                padding: 15px;
                background: rgba(14, 36, 70, 0.3);
                border-radius: 8px;
                border: 1px solid var(--primary, #5ac8fa);
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            }
            
            .calendar-settings-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
                border-bottom: 1px solid rgba(90, 200, 250, 0.2);
                padding-bottom: 10px;
            }
            
            .calendar-settings-title {
                margin: 0;
                color: var(--bright, #8ce6ff);
                font-size: 15px;
                font-weight: bold;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            
            .calendar-settings-title::before {
                content: "📅";
                font-size: 14px;
            }
            
            .calendar-settings-summary {
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                margin-bottom: 15px;
                align-items: center;
            }
            
            .calendar-settings-item {
                background: rgba(14, 36, 70, 0.5);
                border-radius: 6px;
                padding: 6px 10px;
                display: flex;
                align-items: center;
                gap: 6px;
                border: 1px solid rgba(90, 200, 250, 0.1);
            }
            
            .settings-label {
                font-size: 12px;
                color: var(--text, #cdfaff);
                opacity: 0.8;
            }
            
            .settings-value {
                font-size: 12px;
                color: var(--bright, #8ce6ff);
                font-weight: bold;
            }
            

            .calendar-settings-item-full {
                width: 100%;
                justify-content: space-between;
            }

            .calendar-selector-input {
                min-width: 260px;
                background: rgba(14, 36, 70, 0.9);
                color: var(--text, #cdfaff);
                border: 1px solid rgba(90, 200, 250, 0.3);
            }

            .settings-inline-row {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            .settings-inline-label {
                font-size: 14px;
                color: var(--text, #cdfaff);
                margin: 0;
            }

            .settings-section-full {
                grid-column: 1 / -1;
            }
            /* Form Controls */
            .calendar-settings-form {
                display: none;
                margin-top: 10px;
                animation: fadeIn 0.3s ease-in-out;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            
            .settings-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 15px;
                margin-bottom: 15px;
            }
            
            .settings-section {
                background: rgba(14, 36, 70, 0.5);
                border-radius: 8px;
                padding: 15px;
                border: 1px solid rgba(90, 200, 250, 0.1);
            }
            
            .settings-section-title {
                font-size: 14px;
                color: var(--bright, #8ce6ff);
                margin: 0 0 10px 0;
                border-bottom: 1px solid rgba(90, 200, 250, 0.1);
                padding-bottom: 5px;
                font-weight: 600;
            }
            
            /* Working Days Checkboxes */
            .working-days-container {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 8px;
            }
            
            .day-checkbox-label {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 5px 8px;
                border-radius: 4px;
                font-size: 13px;
                color: var(--text, #cdfaff);
                background: rgba(14, 36, 70, 0.8);
                border: 1px solid rgba(90, 200, 250, 0.2);
                cursor: pointer;
                transition: all 0.2s;
            }
            
            .day-checkbox-label:hover {
                border-color: var(--primary, #5ac8fa);
                background: rgba(14, 36, 70, 0.9);
            }
            
            .day-checkbox-label.active {
                background: rgba(90, 200, 250, 0.1);
                border-color: var(--primary, #5ac8fa);
            }
            
            .day-checkbox {
                width: 14px;
                height: 14px;
                cursor: pointer;
                accent-color: var(--primary, #5ac8fa);
            }
            
            /* Holidays Section */
            .holidays-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 12px;
            }
            
            .holidays-container {
                max-height: 150px;
                overflow-y: auto;
                padding: 5px;
                border-radius: 4px;
                background: rgba(14, 36, 70, 0.3);
                scrollbar-width: thin;
                scrollbar-color: var(--primary) rgba(14, 36, 70, 0.3);
                margin-top: 8px;
            }
            
            .holidays-container::-webkit-scrollbar {
                width: 6px;
            }
            
            .holidays-container::-webkit-scrollbar-track {
                background: rgba(14, 36, 70, 0.3);
                border-radius: 4px;
            }
            
            .holidays-container::-webkit-scrollbar-thumb {
                background-color: var(--primary);
                border-radius: 4px;
            }
            
            .holiday-item {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 10px;
                margin-bottom: 6px;
                background: rgba(14, 36, 70, 0.5);
                border-radius: 6px;
                border: 1px solid rgba(90, 200, 250, 0.1);
            }
            
            .holiday-date {
                font-size: 13px;
                color: var(--text, #cdfaff);
            }
            
            .holiday-actions {
                display: flex;
                gap: 4px;
            }
            
            /* Form Inputs */
            .hours-input {
                width: 60px;
                padding: 8px;
                border-radius: 4px;
                background: rgba(14, 36, 70, 0.8);
                border: 1px solid rgba(90, 200, 250, 0.3);
                color: var(--text, #cdfaff);
                font-size: 14px;
                transition: all 0.2s;
            }
            
            .hours-input:focus {
                outline: none;
                border-color: var(--primary, #5ac8fa);
                box-shadow: 0 0 5px rgba(90, 200, 250, 0.3);
            }
            
            .date-input {
                width: 130px;
                padding: 8px;
                border-radius: 4px;
                background: rgba(14, 36, 70, 0.8);
                border: 1px solid rgba(90, 200, 250, 0.3);
                color: var(--text, #cdfaff);
                font-size: 14px;
            }
            
            .date-input:focus {
                outline: none;
                border-color: var(--primary, #5ac8fa);
                box-shadow: 0 0 5px rgba(90, 200, 250, 0.3);
            }
            
            input[type="date"].date-input {
                padding: 7px 8px;
                font-family: var(--font-rajdhani, 'Rajdhani', sans-serif);
            }

            input[type="date"].date-input::-webkit-calendar-picker-indicator {
                filter: invert(0.8) sepia(0.3) saturate(3) hue-rotate(170deg);
                opacity: 0.8;
            }

            /* Buttons */
            .calendar-btn {
                background: rgba(14, 36, 70, 0.8);
                color: var(--text, #cdfaff);
                border: 1px solid var(--primary, #5ac8fa);
                border-radius: 4px;
                padding: 6px 12px;
                font-size: 13px;
                cursor: pointer;
                transition: all 0.2s;
                height: auto;
                display: flex;
                align-items: center;
                gap: 5px;
            }
            
            .calendar-btn:hover {
                background: rgba(90, 200, 250, 0.1);
                box-shadow: 0 0 8px rgba(90, 200, 250, 0.2);
            }
            
            .calendar-btn.small {
                padding: 4px 8px;
                font-size: 12px;
            }
            
            .calendar-btn.danger {
                color: var(--cyb-danger, #ff5555);
                border-color: var(--cyb-danger, #ff5555);
            }
            
            .calendar-btn.danger:hover {
                background: rgba(255, 85, 85, 0.1);
                box-shadow: 0 0 8px rgba(255, 85, 85, 0.2);
            }
            
            .action-buttons {
                display: flex;
                justify-content: flex-end;
                gap: 12px;
                margin-top: 15px;
                padding-top: 15px;
                border-top: 1px solid rgba(90, 200, 250, 0.1);
            }
            
            /* Empty state */
            .empty-state {
                padding: 10px;
                text-align: center;
                color: var(--text, #cdfaff);
                opacity: 0.7;
                font-size: 13px;
                font-style: italic;
            }
            
            @media (max-width: 992px) {
                .modal-overlay .main-content {
                    grid-template-columns: 1fr;
                }
                
                .settings-grid {
                    grid-template-columns: 1fr;
                }
            }
        </style>
        <div class="calendar-container" style="
            font-family: var(--font-rajdhani);
            background: var(--primary-bg);
            padding: 20px;
            border-radius: 12px;
            box-shadow: var(--glow);
        ">`;

    // Add legend if enabled
    if (settings.showLegend) {
        html += `
            <div class="calendar-legend" style="
                margin-bottom: 20px;
                padding: 12px;
                background: var(--secondary-bg);
                border-radius: 8px;
                display: flex;
                gap: 16px;
                flex-wrap: wrap;
            ">
                <div style="color: var(--primary-text); font-weight: bold;">Legend:</div>
                <span style="color: var(--red);">⚠️ High Risk</span>
                <span style="color: var(--accent-color);">⭐ High Impact</span>
                <span style="color: var(--delayed-color);">🔴 Critical Path</span>
                <span style="color: var(--orange);">🟡 Near Critical</span>
                <span style="color: var(--green);">🎯 Milestone</span>
            </div>`;
    }

    // Create grid for months
    html += `<div style="
        display: grid;
        grid-template-columns: repeat(${settings.monthsPerRow}, 1fr);
        gap: 20px;
    ">`;

    let currentMonthDate = new Date(getFirstDayOfMonth(startDate));
    const endMonthDate = getLastDayOfMonth(endDate);
    const todayStr = new Date().toISOString().split('T')[0];

    while (currentMonthDate <= endMonthDate) {
        const monthStart = getFirstDayOfMonth(currentMonthDate);
        const monthEnd = getLastDayOfMonth(currentMonthDate);

        html += `
            <div class="month-block" style="
                border: 1px solid var(--accent-color);
                border-radius: 8px;
                overflow: hidden;
                background: var(--secondary-bg);
                box-shadow: 0 2px 8px rgba(13, 33, 55, 0.1);
            ">
                <div class="month-header" style="
                    background: var(--tertiary-bg);
                    color: var(--primary-text);
                    padding: 12px;
                    font-size: 1.1em;
                    text-align: center;
                    border-bottom: 2px solid var(--accent-color);
                    border-radius: 8px 8px 0 0;
                ">${currentMonthDate.toLocaleString('default', { month: 'long', year: 'numeric' })}</div>
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="background: var(--tertiary-bg);">
                    ${settings.showWeekNumbers ?
                `<th style="width: 40px; padding: 8px; color: var(--secondary-text);">Wk</th>` : ''}
                    <th style="padding: 8px; color: var(--secondary-text);">Su</th>
                    <th style="padding: 8px; color: var(--secondary-text);">Mo</th>
                    <th style="padding: 8px; color: var(--secondary-text);">Tu</th>
                    <th style="padding: 8px; color: var(--secondary-text);">We</th>
                    <th style="padding: 8px; color: var(--secondary-text);">Th</th>
                    <th style="padding: 8px; color: var(--secondary-text);">Fr</th>
                    <th style="padding: 8px; color: var(--secondary-text);">Sa</th>
                </tr>
            </thead>
            <tbody>`;

        let day = new Date(monthStart);
        day.setDate(1 - day.getDay());

        while (day <= monthEnd || day.getDay() !== 0) {
            if (day.getDay() === 0) {
                html += '<tr>';
            }

            const dayStr = normalizeToISODate(day);
            const isCurrentMonth = day.getMonth() === currentMonthDate.getMonth();
            const isInRange = day >= startDate && day <= endDate;
            const isWorkDay = isWorkingDay(day, teamCalendar);
            const dayActivities = getActivitiesForDate(day);

            const cellClasses = [
                'calendar-cell',
                dayActivities.some(a => a.isStart) ? 'activity-start' : '',
                dayActivities.some(a => a.isFinish) ? 'activity-end' : ''
            ].filter(Boolean).join(' ');

            const cellStyle = `
                padding: ${settings.compactView ? '4px' : '8px'};
                text-align: center;
                border: 1px solid var(--accent-color);
                color: ${isCurrentMonth ? 'var(--primary-text)' : 'var(--secondary-text)'};
                background: ${isInRange && isCurrentMonth ?
                    (isWorkDay ? 'var(--tertiary-bg)' : 'var(--secondary-bg)') :
                    'var(--bg-darker)'};
                position: relative;
                height: ${settings.compactView ? '30px' : '60px'};
                vertical-align: top;
                cursor: pointer;
            `;

            html += `
                <td class="${cellClasses}" style="${cellStyle}" data-date="${dayStr}">
                    <div style="font-size: ${settings.compactView ? '0.9em' : '1.1em'};">
                        ${day.getDate()}
                    </div>
                    ${dayStr === todayStr ?
                    `<div class="current-day-indicator">Today</div>`
                    : ''}
            `;

            // Activity indicators with optimized display
            if (dayActivities.length > 0) {
                if (dayActivities.length <= 3 || settings.showAllIcons) {
                    // Group similar activities together with count
                    const activityCounts = {};
                    dayActivities.forEach(activity => {
                        activityCounts[activity.type] = (activityCounts[activity.type] || 0) + 1;
                    });

                    // Get unique activity types in priority order
                    const priorityOrder = ['milestone', 'critical', 'risk', 'near-critical', 'impact'];
                    const uniqueTypes = Object.keys(activityCounts).sort((a, b) =>
                        priorityOrder.indexOf(a) - priorityOrder.indexOf(b)
                    );

                    html += `
                    <div class="activity-indicators" style="
                        position: absolute;
                        bottom: 4px;
                        left: 0;
                        right: 0;
                        display: flex;
                        justify-content: center;
                        flex-wrap: wrap;
                        z-index: 10;
                    ">
                        ${uniqueTypes.map(type => {
                        const count = activityCounts[type];
                        const activity = dayActivities.find(a => a.type === type);

                        // Only show count if more than 1
                        const countDisplay = count > 1 ? `<span class="activity-count">${count}</span>` : '';

                        let fontSize = "0.8em";
                        if (type === "critical" || type === "near-critical") {
                            fontSize = "0.7em";
                        } else if (type === "milestone") {
                            fontSize = "1.2em";
                        } else if (type === "risk" || type === "impact") {
                            fontSize = "0.9em";
                        }

                        return `<span class="activity-indicator" 
                                title="${count} ${type.replace('-', ' ')} ${count === 1 ? 'activity' : 'activities'}"
                                style="color: ${activity.color}; font-size: ${fontSize}; margin: 0 2px; position: relative; z-index:20;">
                                ${activity.icon}${countDisplay}
                            </span>`;
                    }).join('')}
                    </div>
                    `;
                } else {
                    // If too many activities, show a summary indicator
                    const iconCount = Math.min(dayActivities.length, 99);
                    html += `
                    <div class="activity-indicators" style="
                        position: absolute;
                        bottom: 4px;
                        left: 0;
                        right: 0;
                        display: flex;
                        justify-content: center;
                        z-index: 10;
                    ">
                        <span class="activity-summary-indicator" 
                            title="${dayActivities.length} activities on this day"
                            style="background: var(--accent-color); color: var(--cyb-text1, #fff); border-radius: 50%; width: 20px; height: 20px; 
                            display: flex; align-items: center; justify-content: center; font-size: 0.8em; font-weight: bold;">
                            ${iconCount}
                        </span>
                    </div>
                    `;
                }

                // Add tooltip with all activity details
                html += `<div class="calendar-tooltip">
                    ${generateTooltip(dayActivities)}
                </div>`;
            }

            html += `</td>`;
            if (day.getDay() === 6) {
                html += '</tr>';
            }
            day.setDate(day.getDate() + 1);
        }

        html += `
                    </tbody>
                </table>
            </div>`;
        currentMonthDate.setMonth(currentMonthDate.getMonth() + 1);
    }

    html += `</div>`;

    const availableCalendars = Array.isArray(options.calendars) ? options.calendars : [];
    const hasCalendarSelector = availableCalendars.length > 1;

    // IMPROVED CALENDAR SETTINGS PANEL with simplified UI
    html += `
    <div class="calendar-settings-panel">
        <!-- Header with title and toggle button -->
        <div class="calendar-settings-header">
            <h3 class="calendar-settings-title">Calendar Settings</h3>
            <button id="toggleCalendarSettings" class="calendar-btn">
                <i class="fas fa-cog"></i> Settings
            </button>
        </div>
        
        ${hasCalendarSelector ? `
        <div class="calendar-settings-summary calendar-selector-row">
            <div class="calendar-settings-item calendar-settings-item-full">
                <label class="settings-label" for="calendarSelector">Calendar:</label>
                <select id="calendarSelector" class="form-control form-control-sm calendar-selector-input">
                    ${availableCalendars.map(cal => `<option value="${cal.id}" ${cal.id === teamCalendar.id ? 'selected' : ''}>${cal.name || cal.id}</option>`).join('')}
                </select>
            </div>
        </div>` : ''}

        <!-- Summary view (always visible) -->
        <div class="calendar-settings-summary">
            <div class="calendar-settings-item">
                <span class="settings-label">Working hours:</span>
                <span class="settings-value" id="hoursPerDayDisplay">${teamCalendar.hoursPerDay}h/day</span>
            </div>
            
            <div class="calendar-settings-item">
                <span class="settings-label">Working days:</span>
                <span class="settings-value" id="workingDaysDisplay">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
            .filter((_, i) => teamCalendar.workDaySet.has(i))
            .join(', ')}</span>
            </div>
            
            <div class="calendar-settings-item">
                <span class="settings-label">Holidays:</span>
                <span class="settings-value" id="holidaysCountDisplay">${teamCalendar.holidays.length}</span>
            </div>
        </div>
        
        <!-- Expanded settings form (hidden by default) -->
        <div id="calendarSettingsForm" class="calendar-settings-form">
            <div class="settings-grid">
                <!-- Working Hours Section -->
                <div class="settings-section">
                    <div class="settings-section-title">Working Hours</div>
                    <div class="settings-inline-row">
                        <label for="hoursPerDay" class="settings-inline-label">
                            Hours per day:
                        </label>
                        <input type="number" id="hoursPerDay" class="hours-input" 
                            value="${teamCalendar.hoursPerDay}" min="1" max="24" step="0.5">
                    </div>
                </div>
                
                <!-- Working Days Section -->
                <div class="settings-section">
                    <div class="settings-section-title">Working Days</div>
                    <div class="working-days-container" id="workingDaysContainer">
                        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
            .map((day, index) => {
                const jsDay = index === 6 ? 0 : index + 1;
                const isChecked = teamCalendar.workDaySet.has(jsDay);

                return `
                        <label class="day-checkbox-label ${isChecked ? 'active' : ''}">
                            <input type="checkbox" class="day-checkbox working-day-checkbox" 
                                data-day="${jsDay}" ${isChecked ? 'checked' : ''}>
                            ${day}
                        </label>
                    `;
            }).join('')}
                    </div>
                </div>
                
                <!-- Holidays Section -->
                <div class="settings-section settings-section-full">
                    <div class="holidays-header">
                        <div class="settings-section-title">Holidays</div>
                        <div class="settings-inline-row">
                            <input type="date" id="newHoliday" class="date-input">
                            <button id="addHoliday" class="calendar-btn">Add Holiday</button>
                        </div>
                    </div>
                    
                    <div class="holidays-container" id="holidaysList">
                        ${teamCalendar.holidays.length > 0 ?
            teamCalendar.holidays.map(holiday => {
                const date = new Date(holiday);
                const formattedDate = date.toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });

                return `
                        <div class="holiday-item">
                            <span class="holiday-date">${formattedDate}</span>
                            <div class="holiday-actions">
                                <button class="calendar-btn danger remove-holiday" data-date="${holiday}">Remove</button>
                            </div>
                        </div>
                    `;
            }).join('') :
            `<div class="empty-state">No holidays defined</div>`
        }
                    </div>
                </div>
            </div>
            
            <!-- Action Buttons -->
            <div class="action-buttons">
                <button id="cancelCalendarSettings" class="calendar-btn">
                    <i class="fas fa-times"></i> Cancel
                </button>
                <button id="saveCalendarSettings" class="calendar-btn">
                    <i class="fas fa-save"></i> Save Changes
                </button>
            </div>
        </div>
    </div>
    
    <!-- Date Details Modal -->
    <div class="modal-overlay" id="dateDetailsModal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-describedby="modalDescription">
        <div class="dashboard" tabindex="0">
            <!-- Header -->
            <header class="header">
                <div>
                    <h1 id="modalTitle">DATE DETAILS</h1>
                    <div class="subtitle" id="modalDate"></div>
                    <div class="date-time" id="modalDateTime"></div>
                </div>
                <div class="project-timeline">
                    <div id="modalDayInfo"></div>
                    <div id="modalActivityCount"></div>
                </div>
            </header>

            <!-- Main Content -->
            <div class="main-content" id="modalDescription">
                <!-- Left Panel -->
                <div class="left-panel">
                    <!-- Activity List -->
                    <section class="section">
                        <h2>Activities</h2>
                        <div id="modalActivities">
                            <!-- Activities will be inserted here -->
                        </div>
                    </section>
                </div>

                <!-- Right Panel -->
                <aside class="right-panel">
                    <!-- Activity Stats -->
                    <section class="section">
                        <h2>Activity Summary</h2>
                        <div class="project-overview" id="modalActivitySummary">
                            <!-- Summary will be inserted here -->
                        </div>
                    </section>
                    
                    <!-- Working Day Info -->
                    <section class="section">
                        <h2>Calendar Information</h2>
                        <div class="project-overview" id="modalCalendarInfo">
                            <!-- Calendar info will be inserted here -->
                        </div>
                    </section>
                </aside>
            </div>

            <!-- Footer -->
            <footer class="footer">
                <button class="action-button action-button-danger" id="closeModalButton">
                    <span class="text">Close</span>
                    <span class="icon-box"><span class="icon">C</span></span>
                </button>
                <button class="action-button" id="toggleHolidayButton">
                    <span class="text" id="toggleHolidayButtonText">Mark as Holiday</span>
                    <span class="icon-box"><span class="icon">H</span></span>
                </button>
            </footer>
        </div>
    </div>
    `;

    html += `</div>`;

    const containerEl = document.getElementById(elementId);
    if (containerEl) {
        containerEl.innerHTML = html;

        // Toggle calendar settings panel
        const toggleButton = containerEl.querySelector('#toggleCalendarSettings');
        const settingsForm = containerEl.querySelector('#calendarSettingsForm');

        if (toggleButton && settingsForm) {
            toggleButton.addEventListener('click', () => {
                const isHidden = settingsForm.style.display === 'none' || !settingsForm.style.display;
                settingsForm.style.display = isHidden ? 'block' : 'none';
                toggleButton.textContent = isHidden ? 'Hide Settings' : 'Show Settings';

                // Reset form to current values
                if (isHidden) {
                    const hoursInput = containerEl.querySelector('#hoursPerDay');
                    if (hoursInput) hoursInput.value = teamCalendar.hoursPerDay;

                    // Reset working days checkboxes
                    const dayCheckboxes = containerEl.querySelectorAll('.working-day-checkbox');
                    dayCheckboxes.forEach(checkbox => {
                        const day = parseInt(checkbox.getAttribute('data-day'));
                        const isChecked = teamCalendar.workDaySet.has(day);
                        checkbox.checked = isChecked;
                        checkbox.closest('.day-checkbox-label').classList.toggle('active', isChecked);
                    });
                }
            });
        }

        const calendarSelector = containerEl.querySelector('#calendarSelector');
        if (calendarSelector && typeof options.onCalendarSelected === 'function') {
            calendarSelector.addEventListener('change', (event) => {
                options.onCalendarSelected(event.target.value);
            });
        }

        // Add event delegation for working day checkboxes
        const workingDaysContainer = containerEl.querySelector('#workingDaysContainer');
        if (workingDaysContainer) {
            workingDaysContainer.addEventListener('change', (e) => {
                if (e.target.classList.contains('working-day-checkbox')) {
                    const checkbox = e.target;
                    // Toggle the active class on the parent label
                    checkbox.closest('.day-checkbox-label').classList.toggle('active', checkbox.checked);

                    const day = parseInt(checkbox.getAttribute('data-day'));
                    if (checkbox.checked) {
                        // Add day to both array and Set
                        if (!teamCalendar.workingDays.includes(day)) {
                            teamCalendar.workingDays.push(day);
                            teamCalendar.workingDays.sort(); // Keep sorted
                        }
                        teamCalendar.workDaySet.add(day);
                    } else {
                        // Remove day from both array and Set
                        teamCalendar.workingDays = teamCalendar.workingDays.filter(d => d !== day);
                        teamCalendar.workDaySet.delete(day);
                    }
                }
            });
        }

        // Add holiday button
        const addHolidayButton = containerEl.querySelector('#addHoliday');
        const newHolidayInput = containerEl.querySelector('#newHoliday');
        const holidaysList = containerEl.querySelector('#holidaysList');

        if (addHolidayButton && newHolidayInput && holidaysList) {
            addHolidayButton.addEventListener('click', () => {
                const dateValue = newHolidayInput.value;
                if (!dateValue) return;

                // Add to both array and Set
                if (!teamCalendar.holidaySet.has(dateValue)) {
                    teamCalendar.holidays.push(dateValue);
                    teamCalendar.holidaySet.add(dateValue);

                    // Create new holiday item
                    const holidayItem = document.createElement('div');
                    holidayItem.className = 'holiday-item';

                    const date = new Date(dateValue);
                    const formattedDate = date.toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    });

                    holidayItem.innerHTML = `
                        <span class="holiday-date">${formattedDate}</span>
                        <div class="holiday-actions">
                            <button class="calendar-btn danger remove-holiday" data-date="${dateValue}">Remove</button>
                        </div>
                    `;

                    // Remove empty state if present
                    const emptyState = holidaysList.querySelector('.empty-state');
                    if (emptyState) {
                        emptyState.remove();
                    }

                    holidaysList.appendChild(holidayItem);
                    newHolidayInput.value = '';
                }
            });
        }

        // Wire up holidays list with event delegation
        if (holidaysList) {
            holidaysList.addEventListener('click', function (e) {
                const removeBtn = e.target.closest('.remove-holiday');
                if (!removeBtn) return;

                const dateToRemove = removeBtn.getAttribute('data-date');
                // Remove from both array and Set
                teamCalendar.holidays = teamCalendar.holidays.filter(d => d !== dateToRemove);
                teamCalendar.holidaySet.delete(dateToRemove);

                removeBtn.closest('.holiday-item').remove();

                // Show empty state if all holidays removed
                if (teamCalendar.holidays.length === 0) {
                    const emptyStateEl = document.createElement('div');
                    emptyStateEl.className = 'empty-state';
                    emptyStateEl.textContent = 'No holidays defined';
                    holidaysList.appendChild(emptyStateEl);
                }

                // Update holiday count display
                const holidaysCountDisplay = document.getElementById('holidaysCountDisplay');
                if (holidaysCountDisplay) {
                    holidaysCountDisplay.textContent = teamCalendar.holidays.length;
                }
            });
        }

        // Hours per day input with validation
        const hoursPerDayInput = containerEl.querySelector('#hoursPerDay');
        if (hoursPerDayInput) {
            hoursPerDayInput.addEventListener('change', function () {
                const hours = parseFloat(this.value);
                if (isNaN(hours) || hours < 1 || hours > 24) {
                    // Invalid input - reset to previous value
                    this.value = teamCalendar.hoursPerDay;
                    return;
                }

                teamCalendar.hoursPerDay = hours;
            });

            // Additional input validation
            hoursPerDayInput.addEventListener('input', function () {
                if (this.value === '') return;

                const hours = parseFloat(this.value);
                if (isNaN(hours) || hours < 1) {
                    this.classList.add('invalid-input');
                } else if (hours > 24) {
                    this.value = 24;
                    this.classList.remove('invalid-input');
                } else {
                    this.classList.remove('invalid-input');
                }
            });
        }

        // Save button with improved UI feedback
        const saveButton = containerEl.querySelector('#saveCalendarSettings');
        if (saveButton) {
            saveButton.addEventListener('click', () => {
                // Update displays
                const hoursPerDayDisplay = document.getElementById('hoursPerDayDisplay');
                if (hoursPerDayDisplay) {
                    hoursPerDayDisplay.textContent = `${teamCalendar.hoursPerDay}h/day`;
                }

                // Format and update working days display
                const workingDaysDisplay = document.getElementById('workingDaysDisplay');
                if (workingDaysDisplay) {
                    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    const selectedDays = Array.from(teamCalendar.workDaySet)
                        .sort((a, b) => a - b) // Sort numerically
                        .map(day => dayNames[day === 7 ? 0 : day]);

                    workingDaysDisplay.textContent = selectedDays.join(', ');
                }

                // Update holidays count
                const holidaysCountDisplay = document.getElementById('holidaysCountDisplay');
                if (holidaysCountDisplay) {
                    holidaysCountDisplay.textContent = teamCalendar.holidays.length;
                }

                // Save calendar to global state
                if (!window.cybereumState) {
                    window.cybereumState = {};
                }

                window.cybereumState.teamCalendar = {
                    name: teamCalendar.name,
                    hoursPerDay: teamCalendar.hoursPerDay,
                    workingDays: Array.from(teamCalendar.workDaySet).sort((a, b) => a - b),
                    holidays: Array.from(teamCalendar.holidaySet).sort()
                };
                console.log('Calendar settings saved:', window.cybereumState.teamCalendar);

                // Store in localStorage for persistence
                try {
                    localStorage.setItem('teamCalendar', JSON.stringify(window.cybereumState.teamCalendar));
                } catch (e) {
                    console.warn('Could not save calendar to localStorage:', e);
                }

                // Give visual feedback that settings were saved
                saveButton.textContent = 'Saved!';
                saveButton.style.backgroundColor = 'rgba(25, 135, 84, 0.2)';
                saveButton.style.borderColor = '#198754';

                setTimeout(() => {
                    saveButton.innerHTML = '<i class="fas fa-save"></i> Save Changes';
                    saveButton.style.backgroundColor = '';
                    saveButton.style.borderColor = '';

                    // Hide settings form
                    settingsForm.style.display = 'none';
                    toggleButton.textContent = 'Show Settings';

                    // Re-render calendar with new settings
                    renderCalendarView(window.cybereumState.teamCalendar, elementId, nodes, options);
                }, 1000);
            });
        }

        // Cancel button with improved handling
        const cancelButton = containerEl.querySelector('#cancelCalendarSettings');
        if (cancelButton) {
            cancelButton.addEventListener('click', () => {
                // Reload original calendar settings if available
                if (window.cybereumState && window.cybereumState.teamCalendar) {
                    Object.assign(teamCalendar, window.cybereumState.teamCalendar);
                    // Rebuild Sets after loading
                    teamCalendar = prepareCalendar(teamCalendar);
                }

                // Hide form without re-rendering
                settingsForm.style.display = 'none';
                toggleButton.textContent = 'Show Settings';
            });
        }

        // Add a single delegated calendar cell click handler instead of individual handlers
        if (!containerEl.dataset.listenerAttached) {
            containerEl.addEventListener("click", function (ev) {
                const cell = ev.target.closest(".calendar-cell");
                if (!cell) return;
                const dayStr = cell.getAttribute("data-date");
                if (!dayStr) return;
                const dayDate = new Date(dayStr);
                const dayActs = getActivitiesForDate(dayStr);
                openDateDetailsModal(dayDate, dayActs);
            });
            containerEl.dataset.listenerAttached = "true";
        }

        // Function to open the date details modal
        function openDateDetailsModal(date, activities) {
            const modal = document.getElementById('dateDetailsModal');
            if (!modal) return;

            // Format date for display
            const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            const formattedDate = date.toLocaleDateString('en-US', dateOptions);

            // Update modal header
            document.getElementById('modalTitle').textContent = 'DATE DETAILS';
            document.getElementById('modalDate').textContent = formattedDate;
            document.getElementById('modalDateTime').textContent = new Date().toLocaleString();

            // Check if it's a working day
            const isWorkDay = isWorkingDay(date, teamCalendar);
            document.getElementById('modalDayInfo').textContent = isWorkDay ? 'WORKING DAY' : 'NON-WORKING DAY';
            document.getElementById('modalDayInfo').style.color = isWorkDay ? 'var(--green)' : 'var(--orange)';

            document.getElementById('modalActivityCount').textContent = `${activities.length} ACTIVITIES`;

            // Group activities by type for the summary
            const activityTypes = {};
            activities.forEach(activity => {
                activityTypes[activity.type] = (activityTypes[activity.type] || 0) + 1;
            });

            // Populate activity summary
            let summaryHTML = '';
            for (const [type, count] of Object.entries(activityTypes)) {
                const activity = activities.find(a => a.type === type);
                summaryHTML += `
                    <div><strong style="color: ${activity.color}">${type.replace('-', ' ')} activities:</strong></div>
                    <div>${count}</div>
                `;
            }
            document.getElementById('modalActivitySummary').innerHTML = summaryHTML || '<div>No activities scheduled for this date</div>';

            // Populate calendar info
            const dateStr = normalizeToISODate(date);
            const isHoliday = teamCalendar.holidaySet.has(dateStr);

            const calendarHTML = `
                <div><strong>Working hours:</strong></div>
                <div id="modalWorkingHoursValue">${teamCalendar.hoursPerDay} hours</div>
                <div><strong>Working day:</strong></div>
                <div id="modalWorkDayValue">${isWorkDay ? 'Yes' : 'No'}</div>
                <div><strong>Holiday:</strong></div>
                <div id="modalHolidayValue">${isHoliday ? 'Yes' : 'No'}</div>
            `;
            document.getElementById('modalCalendarInfo').innerHTML = calendarHTML;

            // Populate activities
            let activitiesHTML = '';
            if (activities.length > 0) {
                activities.forEach(activity => {
                    const status = activity.isStart ? 'Starts' : activity.isFinish ? 'Ends' : 'Ongoing';

                    activitiesHTML += `
                        <div class="milestone" style="border-left: 4px solid ${activity.color}; padding-left: 10px; margin-bottom: 15px;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                                <span style="font-size: 1.2em; color: ${activity.color}">${activity.icon}</span>
                                <span style="font-weight: bold; font-size: 1.1em;">${activity.Name}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; color: var(--secondary-text);">
                                <span>${status}</span>
                                <span>${activity.isStart
                            ? activity.startDate.toLocaleDateString()
                            : activity.isFinish
                                ? activity.finishDate.toLocaleDateString()
                                : `${activity.startDate.toLocaleDateString()} - ${activity.finishDate.toLocaleDateString()}`}
                                </span>
                            </div>
                            <div style="margin-top: 5px; font-size: 0.9em; color: var(--primary-text);">
                                ${activity.Description || 'No description available'}
                            </div>
                        </div>
                    `;
                });
            } else {
                activitiesHTML = '<div style="text-align: center; padding: 20px; color: var(--secondary-text);">No activities scheduled for this date</div>';
            }
            document.getElementById('modalActivities').innerHTML = activitiesHTML;

            // Set up toggle holiday button text based on current status
            const toggleHolidayButton = document.getElementById('toggleHolidayButton');
            const closeModalButton = document.getElementById('closeModalButton');

            // Clear existing event listeners by cloning and replacing
            const newCloseBtn = closeModalButton.cloneNode(true);
            closeModalButton.parentNode.replaceChild(newCloseBtn, closeModalButton);

            const newToggleBtn = toggleHolidayButton.cloneNode(true);
            toggleHolidayButton.parentNode.replaceChild(newToggleBtn, toggleHolidayButton);

            const updateHolidayButtonLabel = () => {
                const currentlyHoliday = teamCalendar.holidaySet.has(dateStr);
                const btnLabel = currentlyHoliday ? 'Remove Holiday' : 'Mark as Holiday';
                const textEl = newToggleBtn.querySelector('.text');
                if (textEl) {
                    textEl.textContent = btnLabel;
                }
            };

            const persistCalendarToState = () => {
                if (!window.cybereumState) {
                    window.cybereumState = {};
                }

                window.cybereumState.teamCalendar = {
                    id: teamCalendar.id || 'default',
                    name: teamCalendar.name,
                    hoursPerDay: teamCalendar.hoursPerDay,
                    workingDays: Array.from(teamCalendar.workDaySet).sort((a, b) => a - b),
                    holidays: Array.from(teamCalendar.holidaySet).sort()
                };

                try {
                    localStorage.setItem('teamCalendar', JSON.stringify(window.cybereumState.teamCalendar));

                    if (Array.isArray(window.cybereumState.projectCalendars)) {
                        window.cybereumState.projectCalendars = window.cybereumState.projectCalendars.map(cal =>
                            cal.id === window.cybereumState.teamCalendar.id
                                ? { ...cal, ...window.cybereumState.teamCalendar }
                                : cal
                        );

                        if (window.cybereumState.projectCalendarsStorageKey) {
                            localStorage.setItem(window.cybereumState.projectCalendarsStorageKey, JSON.stringify(window.cybereumState.projectCalendars));
                        }
                    }
                } catch (e) {
                    console.warn('Could not save calendar changes to localStorage:', e);
                }
            };

            const updateModalCalendarStatus = () => {
                const holidayStatusEl = document.getElementById('modalHolidayValue');
                if (holidayStatusEl) {
                    holidayStatusEl.textContent = teamCalendar.holidaySet.has(dateStr) ? 'Yes' : 'No';
                }

                const updatedIsWorkDay = isWorkingDay(date, teamCalendar);
                const modalDayInfo = document.getElementById('modalDayInfo');
                modalDayInfo.textContent = updatedIsWorkDay ? 'WORKING DAY' : 'NON-WORKING DAY';
                modalDayInfo.style.color = updatedIsWorkDay ? 'var(--green)' : 'var(--orange)';

                const workDayStatusEl = document.getElementById('modalWorkDayValue');
                if (workDayStatusEl) {
                    workDayStatusEl.textContent = updatedIsWorkDay ? 'Yes' : 'No';
                }
            };

            const refreshCalendarCell = () => {
                const cell = containerEl.querySelector(`.calendar-cell[data-date="${dateStr}"]`);
                if (cell) {
                    const updatedIsWorkDay = isWorkingDay(date, teamCalendar);
                    const isCurrentMonth = date.getMonth() === new Date(getFirstDayOfMonth(date)).getMonth();
                    const isInRange = date >= startDate && date <= endDate;
                    cell.style.background = isInRange && isCurrentMonth
                        ? (updatedIsWorkDay ? 'var(--tertiary-bg)' : 'var(--secondary-bg)')
                        : 'var(--bg-darker)';
                }
            };

            const toggleHoliday = () => {
                if (teamCalendar.holidaySet.has(dateStr)) {
                    teamCalendar.holidaySet.delete(dateStr);
                } else {
                    teamCalendar.holidaySet.add(dateStr);
                }

                teamCalendar.holidays = Array.from(teamCalendar.holidaySet).sort();
                persistCalendarToState();

                const holidaysCountDisplay = document.getElementById('holidaysCountDisplay');
                if (holidaysCountDisplay) {
                    holidaysCountDisplay.textContent = teamCalendar.holidays.length;
                }

                updateHolidayButtonLabel();
                updateModalCalendarStatus();
                refreshCalendarCell();
            };

            const cleanupModalHandlers = () => {
                document.removeEventListener('keydown', keydownHandler);
                modal.removeEventListener('click', clickOutsideHandler);
            };

            const closeModal = () => {
                modal.style.display = 'none';
                cleanupModalHandlers();
            };

            const keydownHandler = function (event) {
                if (modal.style.display !== 'flex') {
                    return;
                }

                if (event.key === 'Escape' || event.key === 'c' || event.key === 'C') {
                    closeModal();
                    return;
                }

                if (event.key === 'h' || event.key === 'H') {
                    toggleHoliday();
                }
            };

            const clickOutsideHandler = function (event) {
                if (event.target === modal) {
                    closeModal();
                }
            };

            // Add event listeners for buttons
            newCloseBtn.addEventListener('click', closeModal);
            newToggleBtn.addEventListener('click', toggleHoliday);
            document.addEventListener('keydown', keydownHandler);
            modal.addEventListener('click', clickOutsideHandler);
            updateHolidayButtonLabel();
            // Display modal
            modal.style.display = 'flex';

        }
    } else {
        console.warn(`renderCalendarView: no container with id='${elementId}' found.`);
    }
}


// Example usage:
/*
renderCalendarView(
    new Date('2024-01-01'), 
    new Date('2024-03-31'), 
    teamCalendar, 
    "calendarContainer",
    {
        monthsPerRow: 3,
        showLegend: true,
        showWeekNumbers: true,
        compactView: false
    }
);
*/

/**
 * Helper function to convert days to working hours
 * 
 * @param {number|string} daysValue - Days value
 * @param {Object} teamCalendar - Calendar object with hours per day
 * @returns {number} - Hours value
 */
function convertDaysToWorkingHours(daysValue, teamCalendar) {
    const days = Number(daysValue) || 0;
    const hoursPerDay = teamCalendar?.hoursPerDay || DEFAULT_HOURS_PER_DAY || 8;
    return days * hoursPerDay;
}
function validateGraph(nodeMap, startNode, endNode) {
    if (!nodeMap.has(startNode.ID) || !nodeMap.has(endNode.ID)) {
        console.warn("Invalid start/end nodes");
        return false;
    }
    return true;
}
function analyzeGraph(nodeMap, links, nodeThreshold, linkThreshold, adjacency) {
    const isValidDAG = validateDAGStructure(adjacency, nodeMap);
    return {
        isValidDAG,
        isLargeDAG: nodeMap.size > nodeThreshold || links.length > linkThreshold
    };
}

/**
 * Calculate the total duration of a path accounting for all relationship types.
 * This function accurately models FS, SS, FF, and SF relationships by tracking
 * earliest start and finish times for each node in the path.
 * 
 * @param {Array} path - Array of nodes or node IDs representing the path
 * @param {Map} nodeMap - Map of node ID to node object
 * @param {Map} succMap - Map of node ID to successor edges
 * @param {Map} predMap - Map of node ID to predecessor edges (optional)
 * @returns {number} - Total path duration in hours
 */
function calculatePathDuration(path, nodeMap, succMap, predMap) {
    // Validate inputs
    if (!path || path.length <= 1) {
        return 0;
    }

    // Maps to track earliest start and finish times for each node
    const startTimes = new Map();
    const finishTimes = new Map();

    // Initialize first node in path to start at time 0
    // Normalize IDs defensively (P6/MSP imports often mix number vs string IDs).
    const firstNodeId = String(typeof path[0] === 'object' ? path[0].ID : path[0]);
    const firstNode = nodeMap.get(firstNodeId) || nodeMap.get(Number(firstNodeId));

    if (!firstNode) {
        console.warn(`First node ${firstNodeId} not found in nodeMap`);
        return 0;
    }

    // Set first node start/finish times
    startTimes.set(firstNodeId, 0);
    finishTimes.set(firstNodeId, getNodeDurationHours(firstNode));

    // Process the path node by node
    for (let i = 0; i < path.length - 1; i++) {
        const currentNodeId = String(typeof path[i] === 'object' ? path[i].ID : path[i]);
        const nextNodeId = String(typeof path[i + 1] === 'object' ? path[i + 1].ID : path[i + 1]);

        const currentNode = nodeMap.get(currentNodeId) || nodeMap.get(Number(currentNodeId));
        const nextNode = nodeMap.get(nextNodeId) || nodeMap.get(Number(nextNodeId));

        if (!currentNode || !nextNode) {
            console.warn(`Missing node: ${!currentNode ? currentNodeId : ''} ${!nextNode ? nextNodeId : ''}`);
            continue;
        }

        // Get the current start and finish times
        const currentStart = startTimes.get(currentNodeId);
        const currentFinish = finishTimes.get(currentNodeId);

        if (currentStart === undefined || currentFinish === undefined) {
            console.warn(`Missing times for node ${currentNodeId}`);
            continue;
        }

        // Find the relationship between the nodes
        const edges = (succMap.get(currentNodeId) || succMap.get(Number(currentNodeId)) || []);
        const edge = edges.find(e => String(e.target) === String(nextNodeId));

        if (!edge) {
            // If no direct edge is found, try to find a transitive relationship
            console.warn(`No direct edge found between ${currentNodeId} and ${nextNodeId}`);

            // Default to FS relationship with no lag as a fallback
            const nextDuration = getNodeDurationHours(nextNode);
            startTimes.set(nextNodeId, currentFinish);
            finishTimes.set(nextNodeId, currentFinish + nextDuration);
            continue;
        }

        const lag = getLinkLagHours(edge);
        const nextDuration = getNodeDurationHours(nextNode);
        let nextStart, nextFinish;

        // Calculate start/finish times based on relationship type
        switch (edge.type) {
            case 'FS': // Finish-to-Start
                // Next task starts after current task finishes plus lag
                nextStart = currentFinish + lag;
                nextFinish = nextStart + nextDuration;
                break;

            case 'SS': // Start-to-Start
                // Next task starts after current task starts plus lag
                nextStart = currentStart + lag;
                nextFinish = nextStart + nextDuration;
                break;

            case 'FF': // Finish-to-Finish
                // Next task finishes after current task finishes plus lag
                nextFinish = currentFinish + lag;
                nextStart = Math.max(0, nextFinish - nextDuration);
                break;

            case 'SF': // Start-to-Finish
                // Next task finishes after current task starts plus lag
                nextFinish = currentStart + lag;
                nextStart = Math.max(0, nextFinish - nextDuration);
                break;

            default:
                // Default to FS
                nextStart = currentFinish + lag;
                nextFinish = nextStart + nextDuration;
                break;
        }

        // Ensure times are not negative
        nextStart = Math.max(0, nextStart);
        nextFinish = Math.max(nextStart + nextDuration, nextFinish);

        // Store the calculated times
        startTimes.set(nextNodeId, nextStart);
        finishTimes.set(nextNodeId, nextFinish);
    }

    // The path duration is the finish time of the last node
    const lastNodeId = typeof path[path.length - 1] === 'object' ? path[path.length - 1].ID : path[path.length - 1];
    const pathDuration = finishTimes.get(lastNodeId.toString()) || 0;

    return pathDuration;
}
/**
 * findAllPaths (Optimized, No Duplicates)
 *
 * If the DAG is "small," enumerates ALL paths exactly.
 * If "large," enumerates paths using a 'Longest Paths First' partial approach.
 */
function findAllPaths(startNode, endNode, links, nodes, includeDurations = false, nodeMap, succMap, predMap) {
    console.log("findAllPaths (Optimized) from", startNode.ID, "to", endNode.ID);

    const NODE_THRESHOLD = 700;
    const LINK_THRESHOLD = 1000;
    const MAX_PATHS_TO_RETURN = 10000;

    // Safely access global state with fallbacks
    //const cybereumState = window.cybereumState || {};
    //const nodeMap = cybereumState.nodeMap || new Map(nodes.map(n => [n.ID, n]));
    //const succMap = cybereumState.succMap || buildSuccessorMap(links, nodeMap);
    //const predMap = cybereumState.predMap || buildPredecessorMap(links, nodeMap);
    const adjacency = new Map(nodes.map(n => [n.ID, []]));

    // Build linkMap for duration calculations
    const linkMap = new Map();
    for (let link of links) {
        const sID = typeof link.source === 'object' ? link.source.ID : link.source;
        const tID = typeof link.target === 'object' ? link.target.ID : link.target;
        if (nodeMap.has(sID) && nodeMap.has(tID)) {
            adjacency.get(sID).push(tID);
            if (includeDurations) {
                linkMap.set(`${sID}|${tID}`, {
                    type: link.type || 'FS',
                    durHours: convertDurationToHours(link.duration, link.timeUnits),
                    lagHours: getLinkLagHours(link)
                });
            }
        }
    }

    // Validation and Preparation
    if (!validateGraph(nodeMap, startNode, endNode)) {
        return includeDurations ? { paths: [], durations: [] } : [];
    }
    const { isValidDAG, isLargeDAG } = analyzeGraph(nodeMap, links, NODE_THRESHOLD, LINK_THRESHOLD, adjacency);
    //const isLargeDAG = (nodes.length > NODE_THRESHOLD || links.length > LINK_THRESHOLD);

    // -------------------------------------------------------------------------
    // Optional: CPM-derived Driving Graph extraction (deterministic + scalable)
    // -------------------------------------------------------------------------
    const useDrivingGraph = !!(window.cybereumConfig?.paths?.useDrivingGraph);
    if (useDrivingGraph && typeof extractDrivingGraphPathsFromCPM === "function") {
        const dg = extractDrivingGraphPathsFromCPM(startNode, endNode, nodes, links, nodeMap, succMap, predMap);
        // If Driving Graph produced a usable answer, return it; otherwise fall back to legacy enumeration.
        if (dg && Array.isArray(dg.paths) && dg.paths.length) {
            if (!includeDurations) return dg.paths;
            return dg;
        }
    }

    const criticalNodes =
        new Set(nodes.filter(n => n.isCritical).map(n => n.ID));

    const pathTracker = new PathTracker(MAX_PATHS_TO_RETURN);

    let result;
    if (!isLargeDAG) {
        console.log("DAG is small => enumerating ALL paths (exact).");
        result = enumerateAllPathsExact(startNode, endNode, adjacency, nodeMap, pathTracker);
    } else {
        console.log("DAG is large => enumerating LONGEST paths first with partial cutoff, no duplicates.");
        result = enumerateLongestPathsFirst(startNode, endNode, adjacency, nodeMap, MAX_PATHS_TO_RETURN, criticalNodes, isValidDAG, links);
    }

    if (!includeDurations) return result;

    // Calculate and sort by durations if requested
    const pathsWithDurations = result.map(path => ({
        path,
        duration: calculatePathDuration(path, nodeMap, succMap, predMap)
    }));

    pathsWithDurations.sort((a, b) => b.duration - a.duration);

    const sortedPaths = pathsWithDurations.map(p => p.path);
    const sortedDurations = pathsWithDurations.map(p => p.duration);

    // For large, dense schedules, returning thousands of near-tied paths is rarely useful.
    // Default behavior: return a structurally diverse subset (auto-tuned), but allow override.
    const selectionMode = String(window.cybereumConfig?.paths?.selectionMode || 'outliers').toLowerCase();
    const applyTrim = (typeof ENABLE_STRUCTURAL_DIVERSITY_SELECTION !== 'undefined' && ENABLE_STRUCTURAL_DIVERSITY_SELECTION);

    if (isLargeDAG && includeDurations && applyTrim && selectionMode !== 'raw') {
        if (selectionMode === 'independent') {
            const diverse = extractIndependentNearCriticalPaths(
                { paths: sortedPaths, durations: sortedDurations },
                { maxPaths: STRUCTURAL_DIVERSITY_CONFIG.maxPaths, refPath: sortedPaths[0], nodes, links }
            );
            return { ...diverse, _rawPathCount: sortedPaths.length };
        }

        // Default: outlier (near-critical) selection, with multimodal cluster support
        const out = findOutlierPaths2({ paths: sortedPaths, durations: sortedDurations }, links, nodes);
        return { ...out, _rawPathCount: sortedPaths.length };
    }

    return { paths: sortedPaths, durations: sortedDurations };
}

/**
 * Enumerate ALL paths exactly (DFS) for small DAGs
 */
function enumerateAllPathsExact(startNode, endNode, adjacency, nodeMap, pathTracker) {
    console.log("Using improved exact path enumeration (suffix memoization)");
    const visited = new Set();
    const memo = new Map(); // Maps nodeID -> Array of SUFFIX paths (currentID → endNode)
    const MAX_PATHS_PER_NODE = 10000; // Safety limit to prevent out of memory

    /**
     * Returns an array of SUFFIX ID-arrays, each starting at currentID and ending at endNode.ID.
     * The memo caches these suffixes so they can be reused regardless of how currentID was reached.
     */
    function dfs(currentID) {
        // Base case: end node → single suffix [endNode.ID]
        if (currentID === endNode.ID) {
            return [[currentID]];
        }

        // Cache hit: return previously computed suffixes from this node
        if (memo.has(currentID)) {
            return memo.get(currentID);
        }

        visited.add(currentID);
        const suffixes = [];

        // Process neighbors
        const neighbors = adjacency.get(currentID) || [];
        for (const nbrID of neighbors) {
            if (!visited.has(nbrID)) {
                const nbrSuffixes = dfs(nbrID);

                // Prepend currentID to each neighbor suffix
                for (const suffix of nbrSuffixes) {
                    suffixes.push([currentID, ...suffix]);

                    // Safety check for maximum paths
                    if (suffixes.length >= MAX_PATHS_PER_NODE) {
                        console.warn(`Reached maximum paths limit (${MAX_PATHS_PER_NODE}) for node ${currentID}`);
                        break;
                    }
                }

                // Break early if we hit the limit
                if (suffixes.length >= MAX_PATHS_PER_NODE) {
                    break;
                }
            }
        }

        visited.delete(currentID);
        memo.set(currentID, suffixes);
        return suffixes;
    }

    // Enumerate all suffixes from start, then register with pathTracker
    const allSuffixes = dfs(startNode.ID);
    for (const idPath of allSuffixes) {
        const completePath = idPath.map(id => nodeMap.get(id));
        pathTracker.addPath(completePath);
    }

    return pathTracker.getPaths();
}

/**
 * Enumerate paths in "Longest First" partial BFS for large DAGs
 */
// Add this before path finding
function validateDAGStructure(adjacency, nodeMap) {
    // Check for cycles using Kahn's algorithm
    //const inDegree = new Map([...nodeMap.keys()].map(k => [k, 0]));
    //const edges = new Map([...nodeMap.keys()].map(k => [k, []]));
    const inDegree = new Map();
    const edges = new Map(Array.from(adjacency.entries()).map(([k, v]) => [k, [...v]]));

    // Calculate in-degrees
    nodeMap.forEach((_, id) => inDegree.set(id, 0));
    edges.forEach((targets) => {
        targets.forEach(target => {
            inDegree.set(target, (inDegree.get(target) || 0) + 1);
        });
    });

    // Find nodes with no incoming edges
    const queue = Array.from(inDegree.entries())
        .filter(([_, deg]) => deg === 0)
        .map(([id]) => id);

    let visited = 0;
    let qHead = 0;
    while (qHead < queue.length) {
        const current = queue[qHead++];
        visited++;

        (edges.get(current) || []).forEach(neighbor => {
            inDegree.set(neighbor, inDegree.get(neighbor) - 1);
            if (inDegree.get(neighbor) === 0) {
                queue.push(neighbor);
            }
        });
    }

    // If we haven't visited all nodes, there's a cycle
    if (visited !== nodeMap.size) {
        console.warn("Graph contains cycles - results may be incomplete");
        return false;
    }

    return true;
}
class PathState {
    constructor(pathIDs, criticalCount, visited = new Set(), estDuration = 0) {
        this.pathIDs = pathIDs;
        this.length = pathIDs.length;
        this.criticalCount = criticalCount;
        this.visited = visited; // O(1) cycle checks
        this.estDuration = estDuration; // Heuristic for path quality
        this.signature = pathIDs.join('->');
    }
}

/**
 * Updated enumerateLongestPathsFirst
 *
 * This function enumerates near-critical paths using a priority queue that orders states by 
 * an estimated duration, the count of critical nodes encountered, and path length.  
 * A memoization cache (stateCache) is used to avoid re-expanding states that have already been 
 * encountered with an equal or higher estimated duration.
 *
 * @param {Object} startNode - The start node object.
 * @param {Object} endNode - The end node object.
 * @param {Map} adjacency - A Map of nodeID -> array of neighbor nodeIDs.
 * @param {Map} nodeMap - A Map of nodeID -> node object.
 * @param {number} maxPaths - Maximum number of paths to retain.
 * @param {Set} criticalNodes - Set of node IDs that are flagged as critical.
 * @param {boolean} isDAG - Flag indicating if the graph is a valid DAG.
 * @returns {Array} - An array of paths (each path is an array of node objects).
 */
function enumerateLongestPathsFirst(startNode, endNode, adjacency, nodeMap, maxPaths, criticalNodes, isDAG, links) {
    console.log("Enumerating near-critical paths (Longest First) with memoization...");
    // Build a heuristic link map from the links (assume buildHeuristicLinkMap is defined elsewhere)
    const linkMap = buildHeuristicLinkMap(adjacency, links); // links is assumed to be global or passed in

    // Priority queue, with a comparator that prioritizes higher estimated duration,
    // higher critical node count, and longer path length.
    // BRANCH-BALANCED: Use BranchBalancedQueue if feature flag enabled for equitable branch exploration
    const comparator = (a, b) =>
        b.estDuration - a.estDuration || b.criticalCount - a.criticalCount || b.length - a.length;

    const queue = ENABLE_BRANCH_BALANCED_EXPLORATION ?
        new BranchBalancedQueue(comparator, BRANCH_BALANCE_CONFIG) :
        new PriorityQueue(comparator);

    // Use an object to cache states, keyed by "nodeID|visitedSignature"
    const stateCache = new Map();

    // Start with the initial state.
    const initialVisited = new Set([startNode.ID]);
    queue.push(new PathState(
        [startNode.ID],
        criticalNodes.has(startNode.ID) ? 1 : 0,
        initialVisited,
        0
    ));

    const pathTracker = new PathTracker(maxPaths);
    let expansions = 0;
    const MAX_EXPANSIONS = isDAG ? 100000 : 50000;

    // Helper to create a signature from a state.
    // BUGFIX: Use full path signature to prevent collisions
    // Previous implementation used `lastNode|sortedVisited` which caused different
    // paths with the same visited set to collide (e.g., A->B->C->D vs A->C->B->D)
    // This could cause non-deterministic output and missed paths.
    function stateSignature(pathIDs, visitedSet) {
        // Use full path for unique identification
        return pathIDs.join('->');
    }

    while (!queue.isEmpty() && expansions++ < MAX_EXPANSIONS) {
        const current = queue.pop();
        const lastID = current.pathIDs[current.pathIDs.length - 1];
        const sig = stateSignature(current.pathIDs, current.visited);

        // Check memo cache: if we already have a state with this signature and a higher or equal estDuration, skip.
        if (stateCache.has(sig) && stateCache.get(sig) >= current.estDuration) {
            continue;
        }
        stateCache.set(sig, current.estDuration);

        // If the state is complete, add to pathTracker.
        if (String(lastID) === String(endNode.ID)) {
            const completePath = current.pathIDs.map(id => nodeMap.get(id));
            pathTracker.addPath(completePath, current.estDuration);
            if (pathTracker.isFull()) break;
            continue;
        }

        // Expand neighbors.
        const neighbors = adjacency.get(lastID) || [];
        for (const nbrID of neighbors) {
            if (!current.visited.has(nbrID)) {
                const linkKey = `${lastID}|${nbrID}`;
                const linkData = linkMap.get(linkKey);
                const edgeDuration = linkData ? linkData.maxDuration : 0;

                // Clone the visited set and add the neighbor.
                const newVisited = new Set(current.visited);
                newVisited.add(nbrID);

                // Push the new state into the priority queue.
                queue.push(new PathState(
                    [...current.pathIDs, nbrID],
                    current.criticalCount + (criticalNodes.has(nbrID) ? 1 : 0),
                    newVisited,
                    current.estDuration + edgeDuration
                ));
            }
        }

        // If the queue grows too large, trim it.
        if (queue.size() > maxPaths * 2) {
            queue.trim(maxPaths);
        }
    }

    console.log(`EnumerateLongestPathsFirst: Processed ${expansions} expansions, found ${pathTracker.size()} paths.`);

    // ========================================================================
    // BRANCH-BALANCED DIAGNOSTICS: Log branch exploration statistics
    // ========================================================================
    if (ENABLE_BRANCH_BALANCED_EXPLORATION && queue instanceof BranchBalancedQueue) {
        const branchStats = queue.getBranchStats(nodeMap);

        if (BRANCH_BALANCE_CONFIG.enableLogging && branchStats.totalBranches > 0) {
            console.log('\n=== Branch Exploration Statistics ===');
            console.log(`Total branches: ${branchStats.totalBranches} | Paths found: ${pathTracker.size()}`);
            console.log(`Operations: ${branchStats.operationStats.totalPushes} pushes, ${branchStats.operationStats.totalPops} pops`);
            console.log(`Rebalances: ${branchStats.operationStats.rebalances} | Penalties applied: ${branchStats.operationStats.branchPenaltiesApplied}`);

            // Show top branches
            const topBranches = branchStats.branches.slice(0, Math.min(5, branchStats.branches.length));
            if (topBranches.length > 0) {
                console.log('\nTop branches by path count:');
                topBranches.forEach((branch, idx) => {
                    console.log(`  ${idx + 1}. ${branch.nodeName || branch.branchID}: ${branch.itemCount} paths`);
                });
            }

            // Check balance health
            if (branchStats.branches.length >= 2) {
                const ratio = branchStats.branches[0].itemCount / branchStats.branches[1].itemCount;
                if (ratio > 5) {
                    console.warn(`⚠️  Branch imbalance detected: Top branch has ${ratio.toFixed(1)}x more paths than second`);
                    console.warn(`    Consider decreasing BRANCH_BALANCE_CONFIG.maxPathsPerBranch to ${Math.floor(BRANCH_BALANCE_CONFIG.maxPathsPerBranch / 2)}`);
                } else {
                    console.log(`✅ Branch balance is healthy (ratio: ${ratio.toFixed(1)}x)`);
                }
            }
            console.log('=====================================\n');
        }
    }

    return pathTracker.getPaths();
}

function buildHeuristicLinkMap(adjacency, links) {
    const linkMap = new Map();
    links.forEach(link => {
        const sID = typeof link.source === 'object' ? link.source.ID : link.source;
        const tID = typeof link.target === 'object' ? link.target.ID : link.target;
        if (adjacency.get(sID)?.includes(tID)) {
            // Calculate maximum possible duration contribution
            const dur = convertDurationToHours(link.duration, link.timeUnits);
            const lag = getLinkLagHours(link);  // FIXED: Was getLagInHours
            linkMap.set(`${sID}|${tID}`, {
                maxDuration: dur + lag // Conservative FS-based estimate
            });
        }
    });
    return linkMap;
}

function getCriticalNodesSet() {
    const criticalNodes = new Set();

    // Get critical paths from global state if available
    if (window.cybereumState?.criticalPathResult?.paths) {
        window.cybereumState.criticalPathResult.paths.forEach(path => {
            path.forEach(node => criticalNodes.add(node.ID));
        });
    }
    return criticalNodes;
}

/**
 * Memory-efficient path tracking with bounded capacity.
 * 
 * Keeps the N longest paths by duration. When capacity is exceeded,
 * evicts the shortest path to make room for longer ones.
 * 
 * Uses a MinHeap internally to efficiently identify the shortest path
 * for eviction (O(1) to find, O(log n) to remove).
 * 
 * BUGFIX: Changed from MaxHeap (which was actually MinHeap logic) to MinHeap
 * BUGFIX: Handle missing durationEstimate parameter
 * OPTIMIZATION: Early rejection of non-competitive paths
 */
class PathTracker {
    constructor(maxPaths) {
        this.maxPaths = maxPaths;
        this.paths = new Map();           // sig -> path
        this.durationHeap = new MinHeap(); // Tracks durations for quick pruning (minimum at root)
    }

    size() {
        return this.paths.size;
    }

    /**
     * Add a path to the tracker.
     * 
     * @param {Array} path - Array of node objects representing the path
     * @param {number} durationEstimate - Estimated duration (optional, defaults to 0)
     * @returns {boolean} - true if path was added, false if duplicate or not competitive
     */
    addPath(path, durationEstimate) {
        const sig = path.map(n => n.ID).join('->');

        // Skip duplicates
        if (this.paths.has(sig)) return false;

        // Handle missing duration - default to 0
        const duration = (typeof durationEstimate === 'number' && !isNaN(durationEstimate))
            ? durationEstimate
            : 0;

        // OPTIMIZATION: If at capacity, check if new path is competitive before adding
        if (this.paths.size >= this.maxPaths) {
            const minDuration = this.durationHeap.peekKey();
            // If new path is shorter than or equal to our shortest, skip it
            if (minDuration !== null && duration <= minDuration) {
                return false; // Not competitive - don't add
            }
            // New path is longer - evict the shortest first
            const evicted = this.durationHeap.pop();
            if (evicted) {
                this.paths.delete(evicted.value);
            }
        }

        // Add to tracking
        this.paths.set(sig, path);
        this.durationHeap.push(duration, sig);
        return true;
    }

    /**
     * Get all tracked paths.
     * @returns {Array} - Array of path arrays
     */
    getPaths() {
        return Array.from(this.paths.values());
    }

    /**
     * Check if tracker is at capacity.
     * @returns {boolean}
     */
    isFull() {
        return this.paths.size >= this.maxPaths;
    }

    /**
     * Get the minimum duration currently tracked.
     * @returns {number|null}
     */
    getMinDuration() {
        return this.durationHeap.peekKey();
    }
}

// Priority Queue implementation for efficient path management
class PriorityQueue {
    constructor(comparator) {
        this.items = [];
        this.comparator = comparator;
    }

    push(item) {
        this.items.push(item);
        this._siftUp(this.items.length - 1);
    }

    pop() {
        if (this.isEmpty()) return null;
        const item = this.items[0];
        const last = this.items.pop();
        if (!this.isEmpty()) {
            this.items[0] = last;
            this._siftDown(0);
        }
        return item;
    }

    isEmpty() {
        return this.items.length === 0;
    }

    size() {
        return this.items.length;
    }

    trim(maxSize) {
        if (this.items.length <= maxSize) return;

        // Efficiently retain top-k elements using partial heapification
        this.items.sort(this.comparator);
        this.items.length = maxSize;
        // Rebuild heap after truncation
        for (let i = Math.floor(this.items.length / 2); i >= 0; i--) {
            this._siftDown(i);
        }
    }

    _siftUp(index) {
        while (index > 0) {
            const parent = (index - 1) >>> 1;
            if (this.comparator(this.items[parent], this.items[index]) <= 0) break;
            [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
            index = parent;
        }
    }

    _siftDown(index) {
        const length = this.items.length;
        while (true) {
            let smallest = index;
            const left = 2 * index + 1;
            const right = 2 * index + 2;

            if (left < length && this.comparator(this.items[left], this.items[smallest]) < 0) {
                smallest = left;
            }
            if (right < length && this.comparator(this.items[right], this.items[smallest]) < 0) {
                smallest = right;
            }

            if (smallest === index) break;

            [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
            index = smallest;
        }
    }
}

/**
 * Branch-Balanced Priority Queue
 * 
 * Eliminates path exploration bias by ensuring equitable exploration across branches.
 * Prevents any single branch from dominating the path exploration process.
 * 
 * OVERHEAD: Memory O(B) where B = branches (typically 5-20) ≈ 630 bytes
 *           Time per push: O(1), Time per pop: O(B), Rebalance: O(B) every 500 pushes
 * 
 * Compatible with PriorityQueue interface: push(), pop(), isEmpty(), size(), trim()
 */
class BranchBalancedQueue {
    constructor(comparator, config = BRANCH_BALANCE_CONFIG) {
        this.comparator = comparator;
        this.config = config;

        // Map: branchID -> { items: PathState[], count: number, totalPriority: number }
        this.branches = new Map();

        // Statistics for diagnostics
        this.stats = {
            totalPushes: 0,
            totalPops: 0,
            rebalances: 0,
            branchPenaltiesApplied: 0
        };

        this._size = 0;
    }

    /**
     * Identify which branch a path state belongs to
     * Uses second node in path as branch identifier (first is always start)
     */
    _identifyBranch(item) {
        const branchNode = item.pathIDs && item.pathIDs.length >= 2 ?
            item.pathIDs[1] :
            (item.pathIDs && item.pathIDs.length > 0 ? item.pathIDs[0] : 'root');
        return String(branchNode);
    }

    /**
     * Calculate priority for an item using the comparator
     * Higher values = higher priority
     */
    _calculatePriority(item) {
        // Create reference item for comparison
        const reference = { estDuration: 0, criticalCount: 0, length: 0 };
        return -this.comparator(item, reference);
    }

    /**
     * Push a path state onto the queue - O(1) complexity
     */
    push(item) {
        this.stats.totalPushes++;
        this._size++;

        const branchID = this._identifyBranch(item);

        // Initialize branch if first time
        if (!this.branches.has(branchID)) {
            this.branches.set(branchID, {
                items: [],
                count: 0,
                totalPriority: 0
            });
        }

        const branch = this.branches.get(branchID);
        const priority = this._calculatePriority(item);
        let adjustedPriority = priority;

        // Apply penalty if branch over-represented
        if (branch.count >= this.config.maxPathsPerBranch) {
            adjustedPriority *= this.config.branchPenalty;
            this.stats.branchPenaltiesApplied++;
        }

        branch.items.push({
            item: item,
            originalPriority: priority,
            adjustedPriority: adjustedPriority
        });

        branch.count++;
        branch.totalPriority += adjustedPriority;

        // Periodic rebalancing
        if (this.stats.totalPushes % this.config.rebalanceInterval === 0) {
            this._rebalanceBranches();
        }
    }

    /**
     * Pop the highest-priority path from any branch - O(B) complexity
     */
    pop() {
        if (this._size === 0) return null;

        this.stats.totalPops++;
        this._size--;

        // Find highest-priority item across all branches
        let bestBranch = null;
        let bestBranchID = null;
        let bestPriority = -Infinity;
        let bestItemIndex = -1;

        for (const [branchID, branch] of this.branches) {
            if (branch.items.length === 0) continue;

            for (let i = 0; i < branch.items.length; i++) {
                const itemData = branch.items[i];
                if (itemData.adjustedPriority > bestPriority) {
                    bestPriority = itemData.adjustedPriority;
                    bestBranch = branch;
                    bestBranchID = branchID;
                    bestItemIndex = i;
                }
            }
        }

        if (!bestBranch) return null;

        // Remove and return best item
        const itemData = bestBranch.items.splice(bestItemIndex, 1)[0];
        bestBranch.count--;
        bestBranch.totalPriority -= itemData.adjustedPriority;

        // Clean up empty branches
        if (bestBranch.items.length === 0) {
            this.branches.delete(bestBranchID);
        }

        return itemData.item;
    }

    /**
     * Rebalance branch penalties based on current distribution
     */
    _rebalanceBranches() {
        this.stats.rebalances++;

        if (this.branches.size === 0) return;

        // Calculate average items per branch
        let totalItems = 0;
        for (const branch of this.branches.values()) {
            totalItems += branch.count;
        }
        const avgItemsPerBranch = totalItems / this.branches.size;

        // Reapply penalties based on deviation from average
        for (const branch of this.branches.values()) {
            const deviation = branch.count / avgItemsPerBranch;

            branch.totalPriority = 0;
            for (const itemData of branch.items) {
                let newAdjustedPriority = itemData.originalPriority;

                // Progressive penalty for over-representation
                if (deviation > 1.5) {
                    newAdjustedPriority *= Math.pow(this.config.branchPenalty, deviation - 1);
                }

                itemData.adjustedPriority = newAdjustedPriority;
                branch.totalPriority += newAdjustedPriority;
            }
        }
    }

    isEmpty() {
        return this._size === 0;
    }

    size() {
        return this._size;
    }

    /**
     * Trim queue to maximum size (compatibility with PriorityQueue interface)
     */
    trim(maxSize) {
        if (this._size <= maxSize) return;

        // Collect all items with priorities
        const allItems = [];
        for (const [branchID, branch] of this.branches) {
            for (let i = 0; i < branch.items.length; i++) {
                allItems.push({
                    branchID: branchID,
                    priority: branch.items[i].adjustedPriority,
                    itemData: branch.items[i]
                });
            }
        }

        // Sort by priority descending and keep top maxSize
        allItems.sort((a, b) => b.priority - a.priority);
        const itemsToKeep = allItems.slice(0, maxSize);

        // Rebuild branch structures
        const newBranches = new Map();
        for (const item of itemsToKeep) {
            if (!newBranches.has(item.branchID)) {
                newBranches.set(item.branchID, {
                    items: [],
                    count: 0,
                    totalPriority: 0
                });
            }
            const branch = newBranches.get(item.branchID);
            branch.items.push(item.itemData);
            branch.count++;
            branch.totalPriority += item.itemData.adjustedPriority;
        }

        this.branches = newBranches;
        this._size = maxSize;
    }

    /**
     * Get branch statistics for diagnostics
     */
    getBranchStats(nodeMap) {
        const stats = [];

        for (const [branchID, branch] of this.branches) {
            stats.push({
                branchID: branchID,
                itemCount: branch.count,
                avgPriority: branch.items.length > 0 ?
                    branch.totalPriority / branch.items.length : 0,
                nodeName: nodeMap && nodeMap.get(branchID) ? nodeMap.get(branchID).Name : branchID
            });
        }

        // Sort by item count descending
        stats.sort((a, b) => b.itemCount - a.itemCount);

        return {
            branches: stats,
            totalBranches: this.branches.size,
            queueSize: this._size,
            operationStats: this.stats
        };
    }
}

/**
 * MinHeap - stores {key, value} pairs ordered by MINIMUM key at root.
 * 
 * Used by PathTracker to efficiently identify the shortest path for eviction.
 * 
 * Operations:
 *   push(key, value): O(log n) - Insert a new element
 *   pop(): O(log n) - Remove and return element with smallest key
 *   peek(): O(1) - View element with smallest key without removing
 *   peekKey(): O(1) - View the smallest key without removing
 *   isEmpty(): O(1) - Check if heap is empty
 *   size(): O(1) - Get number of elements
 * 
 * BUGFIX: pop() now returns {key, value} for consistency with MaxHeap
 * BUGFIX: Removed unused `this.keys` array from constructor
 */
class MinHeap {
    constructor() {
        this.heap = [];
    }

    /**
     * Insert a new key-value pair.
     * @param {number} key - The key to sort by (smaller = higher priority)
     * @param {*} value - The associated value
     */
    push(key, value) {
        this.heap.push({ key, value });
        this._siftUp(this.heap.length - 1);
    }

    /**
     * Remove and return the element with smallest key.
     * @returns {{key: number, value: *}|null} - The element with smallest key, or null if empty
     */
    pop() {
        if (this.isEmpty()) return null;
        const result = this.heap[0]; // Return full {key, value} object
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this._siftDown(0);
        }
        return result;
    }

    /**
     * View the element with smallest key without removing it.
     * @returns {{key: number, value: *}|null}
     */
    peek() {
        return this.isEmpty() ? null : this.heap[0];
    }

    /**
     * View the smallest key without removing.
     * @returns {number|null}
     */
    peekKey() {
        return this.isEmpty() ? null : this.heap[0].key;
    }

    /**
     * Check if heap is empty.
     * @returns {boolean}
     */
    isEmpty() {
        return this.heap.length === 0;
    }

    /**
     * Get number of elements.
     * @returns {number}
     */
    size() {
        return this.heap.length;
    }

    /**
     * Restore heap property by moving element up.
     * @private
     */
    _siftUp(index) {
        while (index > 0) {
            const parentIdx = (index - 1) >>> 1;
            // MIN-heap: parent should be <= child, break if already satisfied
            if (this.heap[parentIdx].key <= this.heap[index].key) break;
            [this.heap[parentIdx], this.heap[index]] = [this.heap[index], this.heap[parentIdx]];
            index = parentIdx;
        }
    }

    /**
     * Restore heap property by moving element down.
     * @private
     */
    _siftDown(index) {
        const length = this.heap.length;
        while (true) {
            let smallest = index;
            const left = 2 * index + 1;
            const right = 2 * index + 2;

            // MIN-heap: find smallest among parent and children
            if (left < length && this.heap[left].key < this.heap[smallest].key) {
                smallest = left;
            }
            if (right < length && this.heap[right].key < this.heap[smallest].key) {
                smallest = right;
            }

            if (smallest === index) break;

            [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
            index = smallest;
        }
    }
}

/**
 * MaxHeap - stores {key, value} pairs ordered by MAXIMUM key at root.
 * 
 * BUGFIX: Original implementation used MIN-heap logic (kept minimum at root).
 * Now correctly implements MAX-heap for keeping largest values at root.
 * 
 * Note: PathTracker now uses MinHeap instead of this class.
 * 
 * Operations:
 *   push(key, value): O(log n) - Insert a new element
 *   pop(): O(log n) - Remove and return element with LARGEST key
 *   peek(): O(1) - View element with largest key without removing
 *   peekKey(): O(1) - View the largest key without removing
 *   isEmpty(): O(1) - Check if heap is empty
 *   size(): O(1) - Get number of elements
 */
class MaxHeap {
    constructor() {
        this.heap = [];
    }

    /**
     * Insert a new key-value pair.
     * @param {number} key - The key to sort by (larger = higher priority)
     * @param {*} value - The associated value
     */
    push(key, value) {
        this.heap.push({ key, value });
        this._siftUp(this.heap.length - 1);
    }

    /**
     * Remove and return the element with largest key.
     * @returns {{key: number, value: *}|null} - The element with largest key, or null if empty
     */
    pop() {
        if (this.isEmpty()) return null;
        const result = this.heap[0]; // Return full {key, value} object
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this._siftDown(0);
        }
        return result;
    }

    /**
     * View the element with largest key without removing it.
     * @returns {{key: number, value: *}|null}
     */
    peek() {
        return this.isEmpty() ? null : this.heap[0];
    }

    /**
     * View the largest key without removing.
     * @returns {number|null}
     */
    peekKey() {
        return this.isEmpty() ? null : this.heap[0].key;
    }

    /**
     * Check if heap is empty.
     * @returns {boolean}
     */
    isEmpty() {
        return this.heap.length === 0;
    }

    /**
     * Get number of elements.
     * @returns {number}
     */
    size() {
        return this.heap.length;
    }

    /**
     * Restore heap property by moving element up.
     * @private
     */
    _siftUp(index) {
        while (index > 0) {
            const parentIdx = (index - 1) >>> 1;
            // MAX-heap: parent should be >= child, break if already satisfied
            if (this.heap[parentIdx].key >= this.heap[index].key) break;
            [this.heap[parentIdx], this.heap[index]] = [this.heap[index], this.heap[parentIdx]];
            index = parentIdx;
        }
    }

    /**
     * Restore heap property by moving element down.
     * @private
     */
    _siftDown(index) {
        const length = this.heap.length;
        while (true) {
            let largest = index;
            const left = 2 * index + 1;
            const right = 2 * index + 2;

            // MAX-heap: find largest among parent and children
            if (left < length && this.heap[left].key > this.heap[largest].key) {
                largest = left;
            }
            if (right < length && this.heap[right].key > this.heap[largest].key) {
                largest = right;
            }

            if (largest === index) break;

            [this.heap[index], this.heap[largest]] = [this.heap[largest], this.heap[index]];
            index = largest;
        }
    }
}
/**
 * Helper function for topological sort
 * 
 * @param {Array} nodes - Array of node objects
 * @param {Array} links - Array of link objects
 * @returns {Object} - Object with topoOrder array
 */
function topologicalSort(nodes, links) {
    const inDegree = {};
    const neighbors = {};
    const topoOrder = [];
    const queue = [];

    // Initialize in-degree and neighbor maps
    nodes.forEach(node => {
        inDegree[node.ID] = 0;
        neighbors[node.ID] = [];
    });

    // Calculate in-degrees
    links.forEach(link => {
        const sourceId = typeof link.source === 'object' ? link.source.ID : link.source;
        const targetId = typeof link.target === 'object' ? link.target.ID : link.target;

        inDegree[targetId]++;
        neighbors[sourceId].push(targetId);
    });

    // Start with nodes that have no incoming edges
    for (const nodeId in inDegree) {
        if (inDegree[nodeId] === 0) {
            queue.push(nodeId);
        }
    }

    // Process nodes in topological order
    let qHead = 0;
    while (qHead < queue.length) {
        const current = queue[qHead++];
        topoOrder.push(current);

        neighbors[current].forEach(neighbor => {
            inDegree[neighbor]--;
            if (inDegree[neighbor] === 0) {
                queue.push(neighbor);
            }
        });
    }

    // Check for cycles
    if (topoOrder.length !== nodes.length) {
        console.error("The graph contains a cycle, topological sort is incomplete.");
    }

    return { topoOrder };
}

function getPredSuccMap(nodes, links) {
    const nodeMap = new Map();
    const succMap = new Map(); // Successor adjacency list.
    const predMap = new Map();

    nodes.forEach(node => {
        nodeMap.set(node.ID, node);
        succMap.set(node.ID, []);
        predMap.set(node.ID, []);
    });

    // Process links to build the adjacency lists and compute in-degrees.
    links.forEach(link => {
        const sourceID = (typeof link.source === 'object') ? link.source.ID : link.source;
        const targetID = (typeof link.target === 'object') ? link.target.ID : link.target;

        if (!nodeMap.has(sourceID) || !nodeMap.has(targetID)) {
            console.warn(`getPredSuccMap: Invalid link: ${sourceID} -> ${targetID}`);
            return;
        }

        const linkDuration = convertDurationToHours(Number(link.duration) || 0, link.timeUnits || 'Hours');
        const lagHours = getLinkLagHours(link);

        const edge = {
            source: sourceID,
            target: targetID,
            type: link.type || 'FS',
            durHrs: linkDuration,
            lagHrs: lagHours
        };

        succMap.get(sourceID).push(edge);
        predMap.get(targetID).push(edge);
    });
    return {
        nodeMap: nodeMap,
        succMap: succMap,
        predMap: predMap
    };
}

/**
 * Find critical path(s) from startID to endID
 * 
 * This improved implementation uses the standard CPM approach:
 * 1. Compute ES, EF, LS, LF for all nodes
 * 2. Find nodes with zero slack (critical nodes)
 * 3. Find complete paths through critical nodes
 * 
 * BUGFIX: Added maximum path limit to prevent explosion with many parallel critical paths
 * BUGFIX: Added cycle detection to prevent infinite loops with bad data
 * BUGFIX: Deduplicate successor targets to avoid redundant exploration
 * BUGFIX: Added visited set to prevent revisiting nodes in same path
 * 
 * @param {Map} nodeMap - Map of node ID to node
 * @param {Array} links - Array of links between nodes
 * @param {string|number} startID - ID of the start node
 * @param {string|number} endID - ID of the end node
 * @param {number} maxPaths - Maximum number of critical paths to find (default: 100)
 * @returns {Object} - Object with critical paths and duration
 */
function findCriticalPath(nodeMap, links, startID, endID, succMap, predMap, maxPaths = 200) {
    //// Build successor and predecessor maps if not available
    //const succMap = window.cybereumState?.succMap || buildSuccessorMap(links, nodeMap);
    //const predMap = window.cybereumState?.predMap || buildPredecessorMap(links, nodeMap);

    // Step 1: Calculate early and late dates
    const { earliestStart, earliestFinish, latestStart, latestFinish, projectFinish } =
        calculateCPMDates(nodeMap, succMap, predMap);

    // Step 2: Identify critical nodes (slack <= 0)
    const criticalNodes = new Set();
    nodeMap.forEach((node, nodeId) => {
        const es = earliestStart.get(nodeId) || 0;
        const ls = latestStart.get(nodeId) || 0;
        const slack = ls - es;

        // Mark node as critical for DFS traversal
        if (slack <= 0.001) { // Use small epsilon for floating point comparison
            criticalNodes.add(nodeId);
            node.isCritical = true;
        } else {
            node.isCritical = false;
        }
    });

    // Step 3: Find complete paths through critical nodes using DFS
    const criticalPaths = [];
    const pathSet = new Set();     // To avoid duplicate paths (by signature)
    const currentPath = [];
    const visitedInPath = new Set(); // BUGFIX: Track visited nodes in current path for cycle detection
    let pathLimitReached = false;

    function dfsFindCriticalPaths(currentId) {
        // BUGFIX: Early termination if we've found enough paths
        if (criticalPaths.length >= maxPaths) {
            pathLimitReached = true;
            return;
        }

        // BUGFIX: Cycle detection - skip if already in current path
        if (visitedInPath.has(currentId)) {
            console.warn(`Cycle detected in critical path at node ${currentId}`);
            return;
        }

        // Add current node to path and visited set
        currentPath.push(nodeMap.get(currentId));
        visitedInPath.add(currentId);

        // Check if we've reached the end node
        if (String(currentId) === String(endID)) {
            const pathStr = currentPath.map(n => n.ID).join('->');
            if (!pathSet.has(pathStr)) {
                pathSet.add(pathStr);
                criticalPaths.push([...currentPath]);
            }
            // Backtrack
            currentPath.pop();
            visitedInPath.delete(currentId);
            return;
        }

        // BUGFIX: Deduplicate successor targets to avoid redundant exploration
        // Multiple edges to same target (e.g., multiple relationship types) should only explore once
        const successors = succMap.get(currentId) || [];
        const uniqueTargets = new Set();
        const criticalSuccessors = [];

        for (const edge of successors) {
            if (criticalNodes.has(edge.target) && !uniqueTargets.has(edge.target)) {
                uniqueTargets.add(edge.target);
                criticalSuccessors.push(edge.target);
            }
        }

        // Continue DFS through unique critical successors
        for (const targetId of criticalSuccessors) {
            if (criticalPaths.length >= maxPaths) {
                pathLimitReached = true;
                break; // Early exit
            }
            dfsFindCriticalPaths(targetId);
        }

        // Remove current node from path when backtracking
        currentPath.pop();
        visitedInPath.delete(currentId);
    }

    // Start DFS if the start node is critical
    if (criticalNodes.has(startID)) {
        dfsFindCriticalPaths(startID);
    }

    // Log warning if limit was reached
    if (pathLimitReached) {
        console.warn(`Critical path limit (${maxPaths}) reached. Some paths may not be included.`);
    }

    // Calculate path duration(s) using the improved calculatePathDuration
    let maxPathDuration = 0;
    let criticalDurations = [];

    if (criticalPaths.length > 0) {
        criticalDurations = new Array(criticalPaths.length);
        for (let i = 0; i < criticalPaths.length; i++) {
            const d = calculatePathDuration(criticalPaths[i], nodeMap, succMap, predMap);
            criticalDurations[i] = d;
            if (d > maxPathDuration) maxPathDuration = d;
        }
    } else {
        // If no complete critical path was found, use the project finish time
        maxPathDuration = projectFinish;
    }

    return {
        paths: criticalPaths,
        durations: criticalDurations,
        duration: maxPathDuration,
        limitReached: pathLimitReached,
        totalCriticalNodes: criticalNodes.size,
        _rawCriticalPathCount: criticalPaths.length
    };
}/**
 * =============================================================================
 * ALTERNATE / INDEPENDENT NEAR-CRITICAL PATHS (DISPLAY-SAFE)
 * =============================================================================
 *
 * IMPORTANT:
 * - We deliberately keep findCriticalPath() "pure" (raw critical-path enumeration) to avoid
 *   changing behavior for schedules where it returns a small, meaningful set.
 * - For dense schedules with thousands of tied/near-tied paths, use the helpers below to
 *   compute a compact set of independent near-critical alternates and optionally merge them
 *   with the driving critical path for UI display.
 */

/**
 * Return a compact set of independent near-critical paths to the finish, suitable for UI.
 * This does NOT modify findCriticalPath behavior; it is an additive API.
 *
 * @param {Map} nodeMap
 * @param {Array} links
 * @param {string|number} startID
 * @param {string|number} endID
 * @param {Object} options
 *   - nodes: optional array of node objects (defaults to Array.from(nodeMap.values()))
 *   - maxAlternates: cap of independent alternates to return (default: STRUCTURAL_DIVERSITY_CONFIG.maxPaths or 200)
 *   - candidateMode: 'allPaths' (default) uses findAllPaths(...) as candidate generator
 *   - includeDurations: default true
 *   - selectionMode: 'independent' | 'outliers' | 'raw' (overrides global selectionMode for this call only)
 *   - enforceIndependence: default true (runs extractIndependentNearCriticalPaths on the candidate pool)
 *   - refPath: optional reference path (defaults to longest candidate path)
 * @returns {{paths:Array, durations:Array, _diversityInfo?:Object, _rawPathCount?:number}}
 */
function findAlternateNearCriticalPaths(nodeMap, links, startID, endID, options = {}) {
    const nodes = options.nodes || Array.from(nodeMap.values());
    const startNode = nodeMap.get(String(startID)) || nodeMap.get(startID);
    const endNode = nodeMap.get(String(endID)) || nodeMap.get(endID);

    if (!startNode || !endNode) {
        console.warn("[findAlternateNearCriticalPaths] Start or end node missing:", startID, endID);
        return { paths: [], durations: [] };
    }

    const includeDurations = options.includeDurations !== false;

    // Candidate generation: prefer existing findAllPaths() (already branch-balanced and large-DAG safe).
    // We avoid mutating global config by allowing a one-shot selection override.
    const previousSelectionMode = window.cybereumConfig?.paths?.selectionMode;
    const hasOverride = typeof options.selectionMode === "string" && options.selectionMode.length > 0;

    try {
        if (hasOverride) {
            window.cybereumConfig = window.cybereumConfig || {};
            window.cybereumConfig.paths = window.cybereumConfig.paths || {};
            window.cybereumConfig.paths.selectionMode = options.selectionMode;
        }

        const candidateResult = findAllPaths(startNode, endNode, links, nodes, includeDurations);

        const cPaths = candidateResult?.paths || [];
        const cDurations = candidateResult?.durations || [];
        const rawCount = candidateResult?._rawPathCount || cPaths.length;

        if (!includeDurations) {
            // If caller asked for raw paths without durations, still allow independence selection if desired
            return { paths: cPaths, durations: [], _rawPathCount: rawCount };
        }

        if (!cPaths.length) return { paths: [], durations: [], _rawPathCount: rawCount };

        // Ensure candidates are sorted by duration (desc)
        const order = [...cPaths.keys()].sort((a, b) => (cDurations[b] ?? 0) - (cDurations[a] ?? 0));
        const sortedPaths = order.map(i => cPaths[i]);
        const sortedDurations = order.map(i => cDurations[i]);

        const enforceIndependence = options.enforceIndependence !== false;
        if (!enforceIndependence || typeof extractIndependentNearCriticalPaths !== "function") {
            return { paths: sortedPaths, durations: sortedDurations, _rawPathCount: rawCount };
        }

        const maxAlternates =
            Number.isFinite(options.maxAlternates) ? options.maxAlternates :
                (typeof STRUCTURAL_DIVERSITY_CONFIG !== "undefined" && Number.isFinite(STRUCTURAL_DIVERSITY_CONFIG.maxPaths) ? STRUCTURAL_DIVERSITY_CONFIG.maxPaths : 200);

        const refPath = options.refPath || sortedPaths[0];

        const diverse = extractIndependentNearCriticalPaths(
            { paths: sortedPaths, durations: sortedDurations },
            { maxPaths: maxAlternates, refPath, nodes, links }
        );

        return { ...diverse, _rawPathCount: rawCount };

    } finally {
        // Restore global config if we overrode it
        if (hasOverride) {
            window.cybereumConfig = window.cybereumConfig || {};
            window.cybereumConfig.paths = window.cybereumConfig.paths || {};
            window.cybereumConfig.paths.selectionMode = previousSelectionMode;
        }
    }
}

/**
 * Convenience wrapper: returns the driving critical path plus a compact set of independent alternates,
 * and a combined array suitable for "display together".
 *
 * @param {Map} nodeMap
 * @param {Array} links
 * @param {string|number} startID
 * @param {string|number} endID
 * @param {Object} options
 *   - maxCriticalPaths: how many raw critical paths to enumerate (default: 200)
 *   - maxAlternates: how many alternates to return (default: STRUCTURAL_DIVERSITY_CONFIG.maxPaths or 200)
 *   - selectionMode: passed to findAlternateNearCriticalPaths (default: 'outliers')
 *   - enforceIndependence: passed to findAlternateNearCriticalPaths (default: true)
 * @returns {{
 *   drivingPath:Array|null,
 *   drivingDuration:number,
 *   critical:Object,
 *   alternates:Object,
 *   combined:{paths:Array, durations:Array}
 * }}
 */
function getDrivingPathAndAlternates(nodeMap, links, startID, endID, options = {}) {
    const maxCriticalPaths = Number.isFinite(options.maxCriticalPaths) ? options.maxCriticalPaths : 200;

    // Prefer Driving Graph when enabled: deterministic driving chains + explainability.
    const useDrivingGraph = !!(window.cybereumConfig?.paths?.useDrivingGraph);
    if (useDrivingGraph && typeof getDrivingPathAndAlternatesFromDrivingGraph === "function") {
        return getDrivingPathAndAlternatesFromDrivingGraph(nodeMap, links, startID, endID, options);
    }

    const critical = findCriticalPath(nodeMap, links, startID, endID, maxCriticalPaths);
    const cPaths = critical?.paths || [];
    const cDurations = critical?.durations || [];

    // Identify driving path = longest among enumerated critical paths (fallback to first)
    let drivingPath = null;
    let drivingDuration = Number.isFinite(critical?.duration) ? critical.duration : 0;

    if (cPaths.length) {
        if (cDurations.length === cPaths.length) {
            let bestIdx = 0;
            let best = -Infinity;
            for (let i = 0; i < cDurations.length; i++) {
                const d = cDurations[i];
                if (Number.isFinite(d) && d > best) { best = d; bestIdx = i; }
            }
            drivingPath = cPaths[bestIdx];
            drivingDuration = Number.isFinite(best) ? best : drivingDuration;
        } else {
            drivingPath = cPaths[0];
        }
    }

    const alternates = findAlternateNearCriticalPaths(
        nodeMap, links, startID, endID,
        {
            nodes: options.nodes || Array.from(nodeMap.values()),
            maxAlternates: options.maxAlternates,
            selectionMode: options.selectionMode || "outliers",
            enforceIndependence: options.enforceIndependence !== false,
            refPath: drivingPath || undefined
        }
    );

    // Combine: driving first, then alternates excluding duplicates
    const combinedPaths = [];
    const combinedDurations = [];
    const seen = new Set();

    function sig(path) {
        try { return path.map(n => n?.ID ?? n).join("->"); } catch { return String(path); }
    }

    if (drivingPath) {
        const s = sig(drivingPath);
        seen.add(s);
        combinedPaths.push(drivingPath);
        combinedDurations.push(drivingDuration);
    }

    const aPaths = alternates?.paths || [];
    const aDurations = alternates?.durations || [];

    for (let i = 0; i < aPaths.length; i++) {
        const p = aPaths[i];
        const s = sig(p);
        if (seen.has(s)) continue;
        seen.add(s);
        combinedPaths.push(p);
        combinedDurations.push(Number.isFinite(aDurations[i]) ? aDurations[i] : null);
    }

    return {
        drivingPath,
        drivingDuration,
        critical,
        alternates,
        combined: { paths: combinedPaths, durations: combinedDurations }
    };
}





/**
 * Calculate Critical Path Method dates (ES, EF, LS, LF) for all nodes
 * using improved early and late date calculations
 * 
 * @param {Map} nodeMap - Map of node ID to node
 * @param {Map} succMap - Map of node ID to successor edges
 * @param {Map} predMap - Map of node ID to predecessor edges
 * @returns {Object} - Maps for ES, EF, LS, LF, and project finish time
 */
function calculateCPMDates(nodeMap, succMap, predMap) {
    // Initialize maps for early and late dates
    const earliestStart = new Map();
    const earliestFinish = new Map();
    const latestStart = new Map();
    const latestFinish = new Map();

    // Perform topological sort for node traversal order
    const topoOrder = calculateTopologicalSort(nodeMap, succMap, predMap);

    // Initialize dates
    nodeMap.forEach((_, nodeId) => {
        earliestStart.set(nodeId, -Infinity);
        earliestFinish.set(nodeId, -Infinity);
        latestStart.set(nodeId, Infinity);
        latestFinish.set(nodeId, Infinity);
    });

    // Forward pass: Calculate early start and early finish dates
    topoOrder.forEach(nodeId => {
        const node = nodeMap.get(nodeId);
        const duration = getNodeDurationHours(node);
        const predecessors = predMap.get(nodeId) || [];

        if (predecessors.length === 0) {
            // Start node
            earliestStart.set(nodeId, 0);
        } else {
            let es = -Infinity;

            // Calculate ES based on all predecessors
            for (const edge of predecessors) {
                const predId = edge.source;
                const predStart = earliestStart.get(predId);
                const predFinish = earliestFinish.get(predId);

                // Skip if predecessor not processed yet
                if (predStart === -Infinity || predFinish === -Infinity) {
                    continue;
                }

                let candidateStart;
                const lag = getLinkLagHours(edge);

                switch (edge.type) {
                    case 'FS': // Finish-to-Start
                        candidateStart = predFinish + lag;
                        break;
                    case 'SS': // Start-to-Start
                        candidateStart = predStart + lag;
                        break;
                    case 'FF': // Finish-to-Finish
                        candidateStart = predFinish + lag - duration;
                        break;
                    case 'SF': // Start-to-Finish
                        candidateStart = predStart + lag - duration;
                        break;
                    default: // Default to FS
                        candidateStart = predFinish + lag;
                }

                es = Math.max(es, candidateStart);
            }

            // Ensure no negative start time
            earliestStart.set(nodeId, Math.max(0, es));
        }

        // Calculate earliest finish
        earliestFinish.set(nodeId, earliestStart.get(nodeId) + duration);
    });

    // Identify project finish time (maximum EF of any end node)
    let projectFinish = 0;
    let endNodes = [];

    nodeMap.forEach((node, nodeId) => {
        const successors = succMap.get(nodeId) || [];
        if (successors.length === 0) {
            endNodes.push(nodeId);
            projectFinish = Math.max(projectFinish, earliestFinish.get(nodeId) || 0);
        }
    });

    // Backward pass: Calculate late start and late finish dates
    // Start by setting LF = projectFinish for all end nodes
    endNodes.forEach(nodeId => {
        const node = nodeMap.get(nodeId);
        const ef = earliestFinish.get(nodeId) || 0;

        // For end nodes, set LF = project finish (or EF if requiring exact finish)
        latestFinish.set(nodeId, projectFinish);
        latestStart.set(nodeId, latestFinish.get(nodeId) - (getNodeDurationHours(node)));
    });

    // Process all nodes in reverse topological order
    for (let i = topoOrder.length - 1; i >= 0; i--) {
        const nodeId = topoOrder[i];
        const node = nodeMap.get(nodeId);
        const duration = getNodeDurationHours(node);
        const successors = succMap.get(nodeId) || [];

        if (successors.length > 0) {
            let lf = Infinity;

            for (const edge of successors) {
                const succId = edge.target;
                const succNode = nodeMap.get(succId);
                const succDuration = getNodeDurationHours(succNode);
                const succStart = latestStart.get(succId);
                const succFinish = latestFinish.get(succId);

                // Skip if successor not processed yet
                if (succStart === Infinity || succFinish === Infinity) {
                    continue;
                }

                let candidateFinish;
                const lag = getLinkLagHours(edge);

                switch (edge.type) {
                    case 'FS': // Finish-to-Start
                        candidateFinish = succStart - lag;
                        break;
                    case 'SS': // Start-to-Start
                        candidateFinish = succStart - lag + duration;
                        break;
                    case 'FF': // Finish-to-Finish
                        candidateFinish = succFinish - lag;
                        break;
                    case 'SF': // Start-to-Finish
                        candidateFinish = succFinish - lag + duration;
                        break;
                    default: // Default to FS
                        candidateFinish = succStart - lag;
                }

                lf = Math.min(lf, candidateFinish);
            }

            latestFinish.set(nodeId, lf);
            latestStart.set(nodeId, lf - duration);
        }
    }

    return {
        earliestStart,
        earliestFinish,
        latestStart,
        latestFinish,
        projectFinish
    };
}

/**
 * Calculate topological sort of the network
 * 
 * @param {Map} nodeMap - Map of node ID to node object
 * @param {Map} succMap - Map of node ID to successor edges
 * @param {Map} predMap - Map of node ID to predecessor edges
 * @returns {Array} - Array of node IDs in topological order
 */
function calculateTopologicalSort(nodeMap, succMap, predMap) {
    const topoOrder = [];
    const inDegree = new Map();

    // Calculate in-degree for each node
    nodeMap.forEach((_, nodeId) => {
        const predecessors = predMap.get(nodeId) || [];
        inDegree.set(nodeId, predecessors.length);
    });

    // Start with nodes that have no predecessors
    const queue = [];
    inDegree.forEach((degree, nodeId) => {
        if (degree === 0) {
            queue.push(nodeId);
        }
    });

    // Process nodes in topological order
    let qHead = 0;
    while (qHead < queue.length) {
        const nodeId = queue[qHead++];
        topoOrder.push(nodeId);

        const successors = succMap.get(nodeId) || [];
        for (const edge of successors) {
            const targetId = edge.target;

            // Reduce in-degree of successor
            const newDegree = inDegree.get(targetId) - 1;
            inDegree.set(targetId, newDegree);

            // If successor has no more predecessors, add to queue
            if (newDegree === 0) {
                queue.push(targetId);
            }
        }
    }

    // Check if all nodes were processed (cycle detection)
    if (topoOrder.length !== nodeMap.size) {
        console.warn("Graph contains cycles - topological sort is incomplete");
    }

    return topoOrder;
}

// Calculate path significance score
/**
 * Calculate the significance score of a path based on duration, critical nodes, and length.
 * 
 * @param {Array} path - Array of nodes in the path
 * @param {number} duration - Duration of the path
 * @param {Set} criticalNodes - Set of critical node IDs
 * @param {number} longestDuration - Duration of the longest path (for normalization)
 * @param {Array} candidatePaths - Array of all candidate paths (for length normalization)
 * @returns {number} - Significance score between 0 and 1
 */
function calculatePathSignificance(path, duration, criticalNodes, longestDuration, candidatePaths) {
    // Guard against invalid inputs
    if (!path || path.length === 0 || !longestDuration || !candidatePaths || candidatePaths.length === 0) {
        return 0;
    }

    const criticalNodeSet = criticalNodes instanceof Set ? criticalNodes : new Set(criticalNodes || []);
    const criticalNodeCount = path.filter(node => criticalNodeSet.has(node.ID)).length;
    const normalizedDuration = duration / longestDuration;
    const maxPathLength = Math.max(...candidatePaths.map(p => p.length));
    const normalizedLength = maxPathLength > 0 ? path.length / maxPathLength : 0;

    return (
        0.4 * normalizedDuration + // Duration importance
        0.3 * (criticalNodeCount / path.length) + // Density of critical nodes
        0.3 * normalizedLength // Path length importance
    );
}

// ============================================================================
// CLUSTER ANALYSIS HELPER FUNCTIONS  
// ============================================================================

/**
 * Smooth histogram using simple moving average for noise reduction
 * 
 * @param {Array} bins - Raw histogram bin counts
 * @param {number} windowSize - Size of smoothing window (default: 3)
 * @returns {Array} - Smoothed bin counts
 */
function smoothHistogram(bins, windowSize = 3) {
    const n = bins.length;
    const smoothed = new Array(n);
    const halfWindow = Math.floor(windowSize / 2);

    for (let i = 0; i < n; i++) {
        let sum = 0, count = 0;
        for (let j = Math.max(0, i - halfWindow); j <= Math.min(n - 1, i + halfWindow); j++) {
            sum += bins[j];
            count++;
        }
        smoothed[i] = sum / count;
    }
    return smoothed;
}

/**
 * Find peaks in histogram using prominence-based detection
 * A peak is a local maximum that stands out significantly from surrounding valleys
 * 
 * @param {Array} smoothedBins - Smoothed histogram for peak detection
 * @param {Array} rawBins - Original histogram for accurate counts
 * @param {Object} cfg - Configuration object
 * @returns {Array} - Array of peak objects with binIndex, count, prominence, width
 */
function findHistogramPeaks(smoothedBins, rawBins, cfg) {
    const n = smoothedBins.length;
    const peaks = [];
    const minSeparationBins = Math.max(2, Math.floor(n * cfg.minPeakSeparation));

    // Find local maxima
    for (let i = 1; i < n - 1; i++) {
        if (smoothedBins[i] > smoothedBins[i - 1] && smoothedBins[i] > smoothedBins[i + 1]) {
            // Calculate prominence (height above surrounding valleys)
            let leftValley = smoothedBins[i], rightValley = smoothedBins[i];

            // Scan left for valley
            for (let j = i - 1; j >= 0; j--) {
                leftValley = Math.min(leftValley, smoothedBins[j]);
                if (smoothedBins[j] > smoothedBins[i]) break;  // Hit a higher peak
            }

            // Scan right for valley
            for (let j = i + 1; j < n; j++) {
                rightValley = Math.min(rightValley, smoothedBins[j]);
                if (smoothedBins[j] > smoothedBins[i]) break;  // Hit a higher peak
            }

            const baselineHeight = Math.max(leftValley, rightValley);
            const prominence = smoothedBins[i] > 0
                ? (smoothedBins[i] - baselineHeight) / smoothedBins[i]
                : 0;

            // Calculate peak width (bins where value > half peak height)
            let width = 1;
            const halfHeight = (smoothedBins[i] + baselineHeight) / 2;
            for (let j = i - 1; j >= 0 && smoothedBins[j] > halfHeight; j--) width++;
            for (let j = i + 1; j < n && smoothedBins[j] > halfHeight; j++) width++;

            peaks.push({
                binIndex: i,
                count: rawBins[i],
                smoothedCount: smoothedBins[i],
                prominence,
                width
            });
        }
    }

    // Filter by prominence threshold
    const significantPeaks = peaks
        .filter(p => p.prominence >= cfg.minPeakProminence || p.count >= cfg.minPathsInCluster)
        .sort((a, b) => b.smoothedCount - a.smoothedCount);  // Sort by size descending

    // Enforce minimum separation between peaks (keep the larger one)
    const finalPeaks = [];
    for (const peak of significantPeaks) {
        const tooClose = finalPeaks.some(p =>
            Math.abs(p.binIndex - peak.binIndex) < minSeparationBins
        );
        if (!tooClose) {
            finalPeaks.push(peak);
        }
    }

    return finalPeaks.slice(0, cfg.maxClusters);
}

/**
 * Detect multiple path clusters in a schedule's duration distribution.
 * Returns cluster information for extracting paths from each distinct pathway family.
 * 
 * @param {Object} pathsData - { paths: Array, durations: Array } sorted descending by duration
 * @param {Object} config - Optional configuration overrides
 * @returns {Object} - { clusters: Array, histogram: Object, stats: Object, isMultimodal: boolean }
 */
function detectPathClusters(pathsData, config = {}) {
    const cfg = { ...PATH_CLUSTER_CONFIG, ...config };
    const { paths, durations } = pathsData;

    if (!durations?.length) {
        return { clusters: [], histogram: null, stats: { totalPaths: 0 }, isMultimodal: false };
    }

    const n = durations.length;
    const minDur = durations[n - 1];  // Already sorted descending
    const maxDur = durations[0];
    const range = maxDur - minDur;

    // Not enough data or range for cluster analysis
    if (n < cfg.minPathsForAnalysis || range < cfg.minBinWidth * 3) {
        return {
            clusters: [{
                peakDuration: maxDur,
                minDuration: minDur,
                maxDuration: maxDur,
                pathCount: n,
                pathIndices: Array.from({ length: Math.min(n, cfg.pathsPerCluster) }, (_, i) => i)
            }],
            histogram: null,
            stats: { totalPaths: n, range, isSingleCluster: true },
            isMultimodal: false
        };
    }

    // ---------- Build histogram ----------
    const binWidth = Math.max(cfg.minBinWidth, range / cfg.targetBins);
    const numBins = Math.ceil(range / binWidth);
    const bins = new Array(numBins).fill(0);
    const binPaths = new Array(numBins).fill(null).map(() => []);

    // Assign paths to bins (bin 0 = longest durations)
    for (let i = 0; i < n; i++) {
        const dur = durations[i];
        let binIdx = Math.floor((maxDur - dur) / binWidth);
        binIdx = Math.min(binIdx, numBins - 1);  // Handle edge case
        bins[binIdx]++;
        // Store path indices for later extraction (limit storage for memory efficiency)
        if (binPaths[binIdx]) {
            if (binPaths[binIdx].length < Math.min(200, cfg.pathsPerCluster * 2)) {
                binPaths[binIdx].push(i);
            }
        }
    }

    // ---------- Detect peaks using smoothed histogram ----------
    const smoothedBins = smoothHistogram(bins, 3);
    const peaks = findHistogramPeaks(smoothedBins, bins, cfg);

    const isMultimodal = peaks.length > 1;

    if (cfg.enableLogging && isMultimodal) {
        console.log(`[PathCluster] Detected ${peaks.length} peaks in duration distribution:`);
        peaks.forEach((p, i) => {
            const peakDur = maxDur - (p.binIndex * binWidth);
            console.log(`  Peak ${i + 1}: ~${Math.round(peakDur)} hours, prominence=${(p.prominence * 100).toFixed(1)}%, width=${p.width} bins`);
        });
    }

    // ---------- Build clusters from peaks ----------
    const clusters = [];
    const usedPathIndices = new Set();

    for (const peak of peaks) {
        if (clusters.length >= cfg.maxClusters) break;

        // Calculate cluster bounds (peak ± spread based on peak width)
        const peakDur = maxDur - (peak.binIndex * binWidth);
        const spread = binWidth * cfg.clusterWidthFactor * Math.max(peak.width, 2);
        const clusterMax = Math.min(maxDur, peakDur + spread);
        const clusterMin = Math.max(minDur, peakDur - spread);

        // Collect paths within cluster bounds
        const clusterPathIndices = [];
        for (let i = 0; i < n && clusterPathIndices.length < cfg.pathsPerCluster; i++) {
            if (usedPathIndices.has(i)) continue;
            const dur = durations[i];
            if (dur >= clusterMin && dur <= clusterMax) {
                clusterPathIndices.push(i);
                usedPathIndices.add(i);
            }
        }

        if (clusterPathIndices.length >= cfg.minPathsInCluster) {
            clusters.push({
                peakDuration: peakDur,
                minDuration: clusterMin,
                maxDuration: clusterMax,
                pathCount: clusterPathIndices.length,
                pathIndices: clusterPathIndices,
                prominence: peak.prominence,
                peakBinIndex: peak.binIndex
            });
        }
    }

    // Ensure at least one cluster (the longest paths) if no peaks met criteria
    if (clusters.length === 0) {
        const defaultIndices = Array.from(
            { length: Math.min(n, cfg.pathsPerCluster) },
            (_, i) => i
        );
        clusters.push({
            peakDuration: maxDur,
            minDuration: maxDur * 0.8,
            maxDuration: maxDur,
            pathCount: defaultIndices.length,
            pathIndices: defaultIndices,
            prominence: 1.0
        });
    }

    return {
        clusters,
        histogram: { bins, smoothedBins, binWidth, minDur, maxDur, numBins },
        stats: {
            totalPaths: n,
            range,
            peaksDetected: peaks.length,
            clustersExtracted: clusters.length
        },
        isMultimodal
    };
}

/**
 * Quick check if a duration distribution is multimodal
 * Faster than full cluster detection - use for gating
 * 
 * @param {Array} durations - Array of path durations (sorted descending)
 * @param {number} sensitivity - Peak prominence threshold (default: 0.12)
 * @returns {boolean} - True if distribution has multiple significant peaks
 */
function isMultimodalDistribution(durations, sensitivity = 0.12) {
    if (!durations?.length || durations.length < PATH_CLUSTER_CONFIG.minPathsForAnalysis) {
        return false;
    }

    const n = durations.length;
    const max = durations[0], min = durations[n - 1];
    const range = max - min;

    if (range < 100) return false;  // Range too narrow for meaningful analysis

    // Quick histogram with fewer bins for speed
    const numBins = 25;
    const binWidth = range / numBins;
    const bins = new Array(numBins).fill(0);

    for (const d of durations) {
        const idx = Math.min(Math.floor((max - d) / binWidth), numBins - 1);
        bins[idx]++;
    }

    // Smooth and find peaks
    const smoothed = smoothHistogram(bins, 3);
    let peakCount = 0;
    const avgBin = n / numBins;

    for (let i = 1; i < numBins - 1; i++) {
        const isLocalMax = smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1];
        if (!isLocalMax) continue;

        // Calculate quick prominence
        let leftMin = smoothed[i], rightMin = smoothed[i];
        for (let j = i - 1; j >= 0 && smoothed[j] <= smoothed[i]; j--)
            leftMin = Math.min(leftMin, smoothed[j]);
        for (let j = i + 1; j < numBins && smoothed[j] <= smoothed[i]; j++)
            rightMin = Math.min(rightMin, smoothed[j]);

        const prominence = smoothed[i] > 0
            ? (smoothed[i] - Math.max(leftMin, rightMin)) / smoothed[i]
            : 0;

        if (prominence >= sensitivity && bins[i] >= 3) {
            peakCount++;
        }
    }

    return peakCount >= 2;
}

/**
 * Analyze path distribution and return structured information
 * Useful for diagnostics and reporting
 * 
 * @param {Array} durations - Array of path durations (any order - will be sorted)
 * @returns {Object} - Distribution analysis with cluster info
 */
function analyzePathDistribution(durations) {
    if (!durations?.length) {
        return { isMultimodal: false, clusters: [], stats: {} };
    }

    // Sort descending for analysis
    const sorted = [...durations].sort((a, b) => b - a);
    const result = detectPathClusters(
        { paths: null, durations: sorted },
        { pathsPerCluster: 0 }  // Skip path collection, just analyze distribution
    );

    return {
        isMultimodal: result.isMultimodal,
        clusters: result.clusters.map(c => ({
            peakDuration: Math.round(c.peakDuration),
            pathCount: c.pathCount,
            prominence: c.prominence,
            range: [Math.round(c.minDuration), Math.round(c.maxDuration)]
        })),
        histogram: result.histogram,
        stats: {
            ...result.stats,
            maxDuration: sorted[0],
            minDuration: sorted[sorted.length - 1],
            medianDuration: sorted[Math.floor(sorted.length / 2)]
        }
    };
}

/**
 * Get cluster assignment for each path index
 * Useful for coloring paths by cluster in visualizations
 * 
 * @param {Array} durations - Path durations array (sorted descending)
 * @param {Array} clusters - Cluster array from detectPathClusters
 * @returns {Array} - Array of cluster indices (0-based), -1 if unassigned
 */
function assignPathsToClusters(durations, clusters) {
    const assignments = new Array(durations.length).fill(-1);

    for (let i = 0; i < durations.length; i++) {
        const dur = durations[i];
        for (let c = 0; c < clusters.length; c++) {
            if (dur >= clusters[c].minDuration && dur <= clusters[c].maxDuration) {
                assignments[i] = c;
                break;
            }
        }
    }

    return assignments;
}

/**
 * Diagnostic function to help identify problematic schedules
 * Call this when debugging path extraction issues
 * 
 * @param {Object} pathsData - { paths, durations } from findAllPaths
 * @returns {Object} - Diagnostic information
 */
function diagnosePathDistribution(pathsData) {
    const { durations } = pathsData;
    if (!durations?.length) return { error: 'No durations provided' };

    const n = durations.length;
    // Assume already sorted descending
    const sorted = durations[0] >= durations[n - 1] ? durations : [...durations].sort((a, b) => b - a);

    const stats = {
        totalPaths: n,
        maxDuration: sorted[0],
        minDuration: sorted[n - 1],
        median: sorted[Math.floor(n / 2)],
        q1: sorted[Math.floor(n * 0.75)],
        q3: sorted[Math.floor(n * 0.25)],
        threshold80Pct: sorted[0] * 0.8
    };

    stats.iqr = stats.q3 - stats.q1;
    stats.iqrThreshold = stats.q3 + 1.5 * stats.iqr;
    stats.isMultimodal = isMultimodalDistribution(sorted);

    if (stats.isMultimodal) {
        const clusterResult = detectPathClusters({ paths: null, durations: sorted });
        stats.clusters = clusterResult.clusters.map(c => ({
            peakDuration: Math.round(c.peakDuration),
            range: `${Math.round(c.minDuration)} - ${Math.round(c.maxDuration)}`,
            pathCount: c.pathCount
        }));
        stats.recommendation = 'Multimodal distribution detected - cluster extraction active';
    } else {
        stats.recommendation = 'Unimodal distribution - standard threshold extraction used';
    }

    console.log('[PathDistribution Diagnosis]');
    console.table(stats);
    if (stats.clusters) {
        console.log('Detected Clusters:');
        console.table(stats.clusters);
    }

    return stats;
}


// ============================================================================
// STRUCTURAL DIVERSITY HELPERS
// ============================================================================

function _getPathNodeId(nodeOrId) {
    return String(typeof nodeOrId === 'object' && nodeOrId !== null ? nodeOrId.ID : nodeOrId);
}

function getPathBranchSignature(path, depth = STRUCTURAL_DIVERSITY_CONFIG.branchDepth) {
    if (!Array.isArray(path) || path.length === 0) return '';
    const ids = [];
    const d = Math.min(depth, path.length);
    for (let i = 0; i < d; i++) ids.push(_getPathNodeId(path[i]));
    return ids.join('->');
}

function getPathMidpointSignature(path, depth = STRUCTURAL_DIVERSITY_CONFIG.midpointDepth) {
    if (!Array.isArray(path) || path.length < 5) return 'short';
    const mid = Math.floor(path.length / 2);
    const start = Math.max(0, mid - Math.floor(depth / 2));
    const end = Math.min(path.length, start + depth);
    const ids = [];
    for (let i = start; i < end; i++) ids.push(_getPathNodeId(path[i]));
    return ids.join('->');
}

function getPathFullSignature(path) {
    if (!Array.isArray(path) || path.length === 0) return '';
    return path.map(_getPathNodeId).join('->');
}
// =============================================================================
// INDEPENDENT NEAR-CRITICAL PATH EXTRACTION
// =============================================================================
// Goal: suppress hundreds/thousands of micro-variants around the same backbone and
// surface structurally distinct (independent) near-critical routes to finish.

function _buildNodePosMap(path) {
    const m = new Map();
    if (!Array.isArray(path)) return m;
    for (let i = 0; i < path.length; i++) {
        m.set(_getPathNodeId(path[i]), i);
    }
    return m;
}

// Short "deviation signature" relative to a reference path:
// captures first divergence and the first subsequent rejoin (if any).
function getDeviationSignature(path, refPath, refPosMap, maxScan = 500) {
    if (!Array.isArray(path) || !Array.isArray(refPath) || path.length < 2 || refPath.length < 2) {
        return 'UNSPEC';
    }

    const scanLimit = Math.min(path.length - 1, maxScan);
    for (let j = 0; j < scanLimit; j++) {
        const nodeId = _getPathNodeId(path[j]);
        const refIdx = refPosMap.get(nodeId);
        if (refIdx == null || refIdx >= refPath.length - 1) continue;

        const refNextId = _getPathNodeId(refPath[refIdx + 1]);
        const nextId = _getPathNodeId(path[j + 1]);

        if (nextId === refNextId) continue; // still on ref

        // Divergence found. Find earliest rejoin later on the reference beyond refIdx.
        let rejoin = null;
        for (let k = j + 1; k < path.length; k++) {
            const rnId = _getPathNodeId(path[k]);
            const rn = refPosMap.get(rnId);
            if (rn != null && rn > refIdx) {
                rejoin = { refIdx: rn, nodeId: rnId };
                break;
            }
        }

        const rejoinPart = rejoin ? `RJ@${rejoin.refIdx}:${rejoin.nodeId}` : 'RJ@none';
        return `DV@${refIdx}:${nodeId}->${nextId}|${rejoinPart}`;
    }

    // No detected divergence in scanned range; likely identical to ref or only diverges after scan window
    return 'ON_REF';
}

function _buildEdgeSet(path) {
    const s = new Set();
    if (!Array.isArray(path) || path.length < 2) return s;
    for (let i = 0; i < path.length - 1; i++) {
        const a = _getPathNodeId(path[i]);
        const b = _getPathNodeId(path[i + 1]);
        s.add(`${a}->${b}`);
    }
    return s;
}

// Containment overlap: |A∩B| / min(|A|,|B|) using edge sets.
function _containmentOverlap(aEdges, bEdges) {
    if (!aEdges?.size || !bEdges?.size) return 0;
    const small = aEdges.size <= bEdges.size ? aEdges : bEdges;
    const big = aEdges.size <= bEdges.size ? bEdges : aEdges;
    let inter = 0;
    for (const e of small) if (big.has(e)) inter++;
    return inter / Math.min(aEdges.size, bEdges.size);
}

function _uniqueEdgeCount(candidateEdges, selectedEdges) {
    if (!candidateEdges?.size) return 0;
    let maxInter = 0;
    for (const se of selectedEdges) {
        let inter = 0;
        const small = candidateEdges.size <= se.size ? candidateEdges : se;
        const big = candidateEdges.size <= se.size ? se : candidateEdges;
        for (const e of small) if (big.has(e)) inter++;
        if (inter > maxInter) maxInter = inter;
    }
    return candidateEdges.size - maxInter;
}

// Primary entrypoint: returns up to cfg.maxPaths independent near-critical paths.
// - Collapses micro-variants into "families" using deviation signatures.
// - Ensures branch coverage using early branch signatures.
// - Applies overlap-based independence filtering across the selected set.
function extractIndependentNearCriticalPaths(pathsData, options = {}) {
    const { paths, durations } = pathsData || {};
    if (!Array.isArray(paths) || !paths.length) {
        return { paths: [], durations: [], _diversityInfo: { selectionMethod: 'independent', totalBranches: 0 } };
    }

    const cfg = _resolveStructuralDiversityConfig(pathsData, options);

    // Candidate gating (safety / performance)
    const candidateLimit = Math.min(
        paths.length,
        cfg.candidateCap,
        Math.max(cfg.maxPaths * cfg.candidateMultiplier, cfg.maxPaths * 3)
    );
    const candPaths = paths.slice(0, candidateLimit);
    const candDurations = (durations || []).slice(0, candidateLimit);

    const refPath = options.refPath ?? candPaths[0];
    const refPos = _buildNodePosMap(refPath);

    // Build descriptors
    const structures = candPaths.map((p, idx) => ({
        index: idx,
        duration: candDurations[idx] ?? 0,
        branchSig: getPathBranchSignature(p, cfg.branchDepth),
        midSig: getPathMidpointSignature(p, cfg.midpointDepth),
        devSig: getDeviationSignature(p, refPath, refPos)
    }));

    // Collapse micro-variants into families: branch + deviation signature
    let reps = structures;
    let familyStats = null;

    if (cfg.familyCollapse) {
        const famMap = new Map(); // key -> { best: structure, count }
        for (const s of structures) {
            const key = `${s.branchSig}|${s.devSig}`;
            const existing = famMap.get(key);
            if (!existing) {
                famMap.set(key, { best: s, count: 1 });
            } else {
                existing.count++;
                // Keep top duration as representative; tie-break by shorter fullSig (cheaper) just in case.
                if (s.duration > existing.best.duration) existing.best = s;
            }
        }

        reps = Array.from(famMap.values()).map(v => v.best);
        reps.sort((a, b) => (b.duration - a.duration));

        familyStats = {
            familyCount: famMap.size,
            totalCandidates: structures.length,
            maxFamilySize: Math.max(...Array.from(famMap.values()).map(v => v.count), 1)
        };
    }


    // Dynamic tightening/loosening based on how dominant micro-variant families are.
    // - When a single family dominates (e.g., thousands of near-ties around same backbone), tighten overlap + uniqueness.
    // - When families are mostly unique, loosen slightly to avoid starving selection.
    if (familyStats) {
        const dominance = familyStats.maxFamilySize / Math.max(1, familyStats.totalCandidates);
        const familyRatio = familyStats.familyCount / Math.max(1, familyStats.totalCandidates);

        if (familyStats.maxFamilySize >= 200 || dominance >= 0.25 || familyRatio <= 0.40) {
            cfg.overlapThreshold = Math.min(cfg.overlapThreshold, 0.90);
            cfg.minUniqueEdges = Math.max(cfg.minUniqueEdges, 10);
            cfg.maxPathsPerBranch = Math.min(cfg.maxPathsPerBranch, 20);
        } else if (familyStats.maxFamilySize <= 10 && familyRatio >= 0.85) {
            cfg.overlapThreshold = Math.max(cfg.overlapThreshold, 0.94);
            cfg.minUniqueEdges = Math.max(4, Math.min(cfg.minUniqueEdges, 8));
        }
    }

    // If we already have few enough, optionally still apply independence filter (useful when clusters overlap heavily).
    // Otherwise, do branch-balanced selection first.
    const branchGroups = new Map();
    for (const r of reps) {
        if (!branchGroups.has(r.branchSig)) branchGroups.set(r.branchSig, []);
        branchGroups.get(r.branchSig).push(r);
    }

    // Sort members within each branch by duration
    for (const arr of branchGroups.values()) arr.sort((a, b) => b.duration - a.duration);

    const branchCount = branchGroups.size || 1;
    let minPerBranch = cfg.minPathsPerBranch;
    if (branchCount * minPerBranch > cfg.maxPaths) minPerBranch = 1;

    // Allocate quotas (duration-weighted priority but fair across branches)
    const sortedBranches = Array.from(branchGroups.entries())
        .map(([sig, members]) => ({ sig, members, maxDuration: members[0]?.duration ?? 0 }))
        .sort((a, b) => b.maxDuration - a.maxDuration);

    const baseQuota = Math.floor(cfg.maxPaths / branchCount);
    const remainder = cfg.maxPaths % branchCount;

    // Preselect a larger pool so independence filtering doesn't starve output
    const preselectTarget = Math.min(reps.length, Math.max(cfg.maxPaths * 3, cfg.maxPaths + 10));
    const preselected = [];

    for (let i = 0; i < sortedBranches.length && preselected.length < preselectTarget; i++) {
        const b = sortedBranches[i];
        let quota = baseQuota + (i < remainder ? 1 : 0);
        quota = Math.max(minPerBranch, Math.min(cfg.maxPathsPerBranch, quota));

        // Over-select slightly per branch for downstream independence filtering
        quota = Math.min(b.members.length, Math.max(quota, Math.ceil(quota * 1.5)));

        // Diverse within branch (midSig first, then duration)
        const chosen = [];
        const seenMid = new Set();
        for (const m of b.members) {
            if (chosen.length >= quota) break;
            if (!seenMid.has(m.midSig)) {
                chosen.push(m);
                seenMid.add(m.midSig);
            }
        }
        for (const m of b.members) {
            if (chosen.length >= quota) break;
            if (!chosen.includes(m)) chosen.push(m);
        }

        for (const m of chosen) {
            if (preselected.length >= preselectTarget) break;
            preselected.push(m);
        }
    }

    // Sort preselected by duration desc
    preselected.sort((a, b) => b.duration - a.duration);

    // Independence filtering (edge-overlap)
    let finalSel = preselected;
    const diversityInfo = {
        selectionMethod: 'independent_near_critical',
        totalCandidates: structures.length,
        candidateLimit,
        branches: branchCount,
        ...(familyStats || {})
    };

    if (cfg.enableIndependenceFilter) {
        const selected = [];
        const selectedEdges = [];
        const edgeCache = new Map(); // idx -> Set

        const getEdges = (s) => {
            if (edgeCache.has(s.index)) return edgeCache.get(s.index);
            const es = _buildEdgeSet(candPaths[s.index]);
            edgeCache.set(s.index, es);
            return es;
        };

        for (const s of preselected) {
            if (selected.length >= cfg.maxPaths) break;

            const cEdges = getEdges(s);
            if (!cEdges.size) continue;

            // Containment overlap check
            let maxOverlap = 0;
            for (const se of selectedEdges) {
                const ov = _containmentOverlap(cEdges, se);
                if (ov > maxOverlap) maxOverlap = ov;
                if (maxOverlap >= cfg.overlapThreshold) break;
            }
            if (maxOverlap >= cfg.overlapThreshold) continue;

            // Require some unique edges (prevents trivial variants from slipping through)
            const uniq = _uniqueEdgeCount(cEdges, selectedEdges);
            if (selectedEdges.length > 0 && uniq < cfg.minUniqueEdges) continue;

            selected.push(s);
            selectedEdges.push(cEdges);
        }

        // Fallback fill if independence filter is too strict
        if (selected.length < Math.min(cfg.maxPaths, preselected.length)) {
            const selectedSet = new Set(selected.map(s => s.index));
            for (const s of preselected) {
                if (selected.length >= cfg.maxPaths) break;
                if (selectedSet.has(s.index)) continue;
                selected.push(s);
                selectedSet.add(s.index);
            }
            diversityInfo.fallbackFill = true;
        }

        finalSel = selected;
        diversityInfo.selected = selected.length;
    } else {
        finalSel = preselected.slice(0, cfg.maxPaths);
        diversityInfo.selected = finalSel.length;
    }

    // Map back to concrete paths/durations
    const outPaths = finalSel.map(s => candPaths[s.index]);
    const outDurations = finalSel.map(s => candDurations[s.index] ?? 0);

    if (cfg.enableLogging) {
        console.log(`[IndependentPaths] candidates=${structures.length}, reps=${reps.length}, selected=${outPaths.length}, branches=${branchCount}`);
    }

    return { paths: outPaths, durations: outDurations, _diversityInfo: diversityInfo };
}


function selectDiverseWithinBranch(branchMembers, maxSelect) {
    if (!Array.isArray(branchMembers) || branchMembers.length === 0) return [];
    if (branchMembers.length <= maxSelect) return branchMembers.map(m => m.index);

    const selected = [];
    const seenMid = new Set();

    // Pass 1: one per unique midpoint signature
    for (const m of branchMembers) {
        if (selected.length >= maxSelect) break;
        if (!seenMid.has(m.midSig)) {
            selected.push(m.index);
            seenMid.add(m.midSig);
        }
    }

    // Pass 2: fill remaining slots with longest remaining
    for (const m of branchMembers) {
        if (selected.length >= maxSelect) break;
        if (!selected.includes(m.index)) selected.push(m.index);
    }

    return selected;
}

/**
 * Extract structurally independent near-critical paths.
 *
 * This addresses the "masked parallel branches" failure mode where thousands of
 * near-identical paths (small variations on the same backbone) crowd out distinct
 * branches that are just slightly shorter.
 *
 * @param {Object} pathsData - { paths, durations } (ideally already filtered to near-critical candidates)
 * @param {Object} options - optional overrides for STRUCTURAL_DIVERSITY_CONFIG
 * @returns {Object} - { paths, durations, _diversityInfo }
 */
function extractStructurallyDiversePaths(pathsData, options = {}) {
    const cfg = _resolveStructuralDiversityConfig(pathsData, options);

    const { paths, durations } = pathsData || {};
    if (!Array.isArray(paths) || paths.length === 0) {
        return { paths: [], durations: [], _diversityInfo: { totalBranches: 0 } };
    }

    // Build structure descriptors
    // Add fullSig to the structure descriptor
    const structures = paths.map((p, idx) => ({
        index: idx,
        duration: durations?.[idx] ?? 0,
        branchSig: getPathBranchSignature(p, cfg.branchDepth),
        midSig: getPathMidpointSignature(p, cfg.midpointDepth),
        fullSig: getPathFullSignature(p)  // ADD THIS LINE
    }));

    // Group by branch signature (early divergence)
    const branchGroups = new Map();
    for (const s of structures) {
        if (!branchGroups.has(s.branchSig)) branchGroups.set(s.branchSig, []);
        branchGroups.get(s.branchSig).push(s);
    }

    const totalBranches = branchGroups.size || 1;

    // Auto-adjust minPathsPerBranch if branch count is very high vs maxPaths
    let minPerBranch = cfg.minPathsPerBranch;
    if (totalBranches * minPerBranch > cfg.maxPaths) {
        minPerBranch = 1;
    }

    // Sort branches by max duration (prioritize branches with longest exposure)
    const sortedBranches = Array.from(branchGroups.entries())
        .map(([sig, members]) => ({
            sig,
            members: members.sort((a, b) => b.duration - a.duration),
            maxDuration: members[0]?.duration ?? 0
        }))
        .sort((a, b) => b.maxDuration - a.maxDuration);

    // Fair allocation across branches
    const perBranchQuota = Math.max(
        minPerBranch,
        Math.min(cfg.maxPathsPerBranch, Math.ceil(cfg.maxPaths / totalBranches))
    );

    const selectedIdx = new Set();
    const selectedFull = new Set(); // exact dedupe
    const branchContrib = [];

    for (const br of sortedBranches) {
        if (selectedIdx.size >= cfg.maxPaths) break;
        const quota = Math.min(perBranchQuota, cfg.maxPaths - selectedIdx.size);
        const picked = selectDiverseWithinBranch(br.members, quota);

        let added = 0;
        for (const idx of picked) {
            if (selectedIdx.size >= cfg.maxPaths) break;
            const fullSig = structures[idx]?.fullSig;
            if (!fullSig || selectedFull.has(fullSig)) continue;
            selectedIdx.add(idx);
            selectedFull.add(fullSig);
            added++;
        }

        branchContrib.push({
            branch: br.sig,
            maxDuration: Math.round(br.maxDuration),
            totalPaths: br.members.length,
            selected: added
        });
    }

    // Fill remaining slots with next-best from underrepresented branches
    if (selectedIdx.size < cfg.maxPaths) {
        for (const br of sortedBranches) {
            if (selectedIdx.size >= cfg.maxPaths) break;
            for (const m of br.members) {
                if (selectedIdx.size >= cfg.maxPaths) break;
                if (selectedIdx.has(m.index)) continue;
                if (selectedFull.has(m.fullSig)) continue;
                selectedIdx.add(m.index);
                selectedFull.add(m.fullSig);
            }
        }
    }

    // Convert to duration-sorted output (longest first)
    const resultIndices = Array.from(selectedIdx).sort((a, b) =>
        (durations?.[b] ?? 0) - (durations?.[a] ?? 0)
    );

    const _diversityInfo = {
        selectionMethod: 'structural_diversity',
        totalBranches,
        perBranchQuota,
        branchContributions: branchContrib
    };

    if (cfg.enableLogging) {
        console.log(`[StructuralDiversity] Selected ${resultIndices.length}/${paths.length} paths from ${totalBranches} branches (quota=${perBranchQuota})`);
        console.table(branchContrib.slice(0, 10));
    }

    return {
        paths: resultIndices.map(i => paths[i]),
        durations: resultIndices.map(i => durations[i]),
        _diversityInfo
    };
}

/**
 * Find outlier (near-critical) paths from the path distribution.
 * 
 * ENHANCED: Now detects multimodal distributions and extracts paths from
 * multiple clusters to capture distinct parallel pathways through the schedule.
 * 
 * For unimodal distributions, uses the original IQR/80% threshold logic.
 * For multimodal distributions, extracts representative paths from each peak cluster.
 * 
 * @param {Object} pathsData - { paths: Array, durations: Array } sorted descending by duration
 * @param {Array} links - Link array (for API compatibility)
 * @param {Array} nodes - Node array (for API compatibility)
 * @returns {Object} - { paths: Array, durations: Array, _clusterInfo?: Array }
 */

function findOutlierPaths2(pathsData, links, nodes) {
    const { paths: sortedPaths, durations } = pathsData;

    if (!sortedPaths?.length) return { paths: [], durations: [] };

    // Scan window (kept large for robust thresholds). Output is optionally trimmed by diversity selection.
    const MAX_OUTLIERS_SCAN = 1000;
    const MAX_OUTLIERS_RETURN = ENABLE_STRUCTURAL_DIVERSITY_SELECTION
        ? Math.min(STRUCTURAL_DIVERSITY_CONFIG.maxPaths, MAX_OUTLIERS_SCAN)
        : MAX_OUTLIERS_SCAN;

    // ---------- Multimodal distributions: cluster-aware extraction ----------
    if (ENABLE_PATH_CLUSTER_DETECTION && isMultimodalDistribution(durations)) {
        return findOutlierPathsWithClusters(pathsData, MAX_OUTLIERS_RETURN, links, nodes);
    }

    // ---------- Unimodal distributions: original IQR/80% threshold logic ----------
    const candidatePaths = sortedPaths.slice(0, MAX_OUTLIERS_SCAN);
    const candidateDurations = durations.slice(0, MAX_OUTLIERS_SCAN);

    const len = candidateDurations.length;
    const q1 = candidateDurations[Math.floor(len * 0.75)] || 0;  // Reversed because descending
    const q3 = candidateDurations[Math.floor(len * 0.25)] || 0;
    const iqr = q3 - q1;
    const longestDuration = candidateDurations[0];
    const upperThreshold = q3 + 1.5 * iqr;
    const durationThreshold = longestDuration * 0.8;

    // Filter outliers from pre-sorted candidates
    const outlierIndices = [];
    for (let i = 0; i < len; i++) {
        if (candidateDurations[i] > upperThreshold ||
            candidateDurations[i] >= durationThreshold) {
            outlierIndices.push(i);
        }
    }

    // If no outliers found, take the longest path
    if (!outlierIndices.length && len) {
        outlierIndices.push(0);
    }

    const outlierPaths = outlierIndices.map(i => candidatePaths[i]);
    const outlierDurations = outlierIndices.map(i => candidateDurations[i]);

    // ---------- Structural diversity selection (independent branches) ----------
    if (ENABLE_STRUCTURAL_DIVERSITY_SELECTION) {
        const diverse = extractIndependentNearCriticalPaths({ paths: outlierPaths, durations: outlierDurations }, { maxPaths: MAX_OUTLIERS_RETURN, refPath: outlierPaths[0], nodes, links });
        return { ...diverse };
    }

    return {
        paths: outlierPaths,
        durations: outlierDurations
    };
}

/**
 * Extract outlier paths using cluster detection for multimodal distributions.
 * Called internally by findOutlierPaths2 when multimodal distribution is detected.
 * 
 * @param {Object} pathsData - { paths: Array, durations: Array } sorted descending
 * @param {number} maxTotal - Maximum total paths to return
 * @returns {Object} - { paths: Array, durations: Array, _clusterInfo: Array }
 */

function findOutlierPathsWithClusters(pathsData, maxTotal = 200, links, nodes) {
    const { paths: sortedPaths, durations } = pathsData;

    if (!sortedPaths?.length || !durations?.length) {
        return { paths: [], durations: [], _clusterInfo: [] };
    }

    // Collect a richer sample per cluster so structural diversity has enough candidates to work with.
    // (We still cap final output to maxTotal.)
    const candidatePerCluster = Math.min(
        2000,
        Math.max(PATH_CLUSTER_CONFIG.pathsPerCluster, Math.ceil(maxTotal * 10))
    );

    // Detect clusters
    const clusterResult = detectPathClusters(pathsData, { pathsPerCluster: candidatePerCluster });
    const { clusters } = clusterResult;

    if (!clusters?.length) {
        return {
            paths: sortedPaths.slice(0, maxTotal),
            durations: durations.slice(0, maxTotal),
            _clusterInfo: []
        };
    }

    const resultPaths = [];
    const resultDurations = [];
    const usedFullSigs = new Set();

    const clusterInfo = [];
    const diversityClusters = [];

    let remaining = maxTotal;
    let remainingClusters = clusters.length;

    for (let c = 0; c < clusters.length; c++) {
        if (remaining <= 0) break;

        const cluster = clusters[c];
        remainingClusters = Math.max(1, remainingClusters);

        // Allocate quota dynamically to avoid starving later clusters
        const quota = Math.max(1, Math.floor(remaining / remainingClusters));
        remainingClusters--;

        // Build cluster candidate arrays
        const clusterPaths = [];
        const clusterDurations = [];

        for (const idx of cluster.pathIndices) {
            clusterPaths.push(sortedPaths[idx]);
            clusterDurations.push(durations[idx]);
        }

        let selected = { paths: clusterPaths.slice(0, quota), durations: clusterDurations.slice(0, quota) };

        // Structural diversity selection within each duration cluster
        if (ENABLE_STRUCTURAL_DIVERSITY_SELECTION && STRUCTURAL_DIVERSITY_CONFIG.applyWithinClusters) {
            selected = extractIndependentNearCriticalPaths(
                { paths: clusterPaths, durations: clusterDurations },
                { maxPaths: quota, refPath: clusterPaths[0] }
            );

            diversityClusters.push({
                peakDuration: Math.round(cluster.peakDuration),
                selectedCount: selected.paths.length,
                ...(selected._diversityInfo || {})
            });
        }

        // Add selected paths to global output with exact dedupe
        for (let i = 0; i < selected.paths.length && resultPaths.length < maxTotal; i++) {
            const p = selected.paths[i];
            const d = selected.durations[i];

            const sig = getPathFullSignature(p);
            if (!sig || usedFullSigs.has(sig)) continue;

            usedFullSigs.add(sig);
            resultPaths.push(p);
            resultDurations.push(d);
        }

        clusterInfo.push({
            peakDuration: Math.round(cluster.peakDuration),
            pathCount: cluster.pathCount,
            range: [Math.round(cluster.minDuration), Math.round(cluster.maxDuration)]
        });

        remaining = maxTotal - resultPaths.length;
    }

    return {
        paths: resultPaths,
        durations: resultDurations,
        _clusterInfo: clusterInfo,
        _diversityInfo: ENABLE_STRUCTURAL_DIVERSITY_SELECTION ? {
            selectionMethod: 'cluster+structural_diversity',
            maxTotal,
            clusters: diversityClusters
        } : undefined
    };
}

// Shared helper function
function calculateLinkDuration(type, duration, lag, predDuration) {
    switch (type) {
        case 'FS': return duration + lag;
        case 'SS':
        case 'SF': return Math.max(duration + lag - predDuration, 0);
        case 'FF': return Math.max(lag - duration, 0);
        default: return duration;
    }
}

/**
 * Calculate shortest and longest distances from each node to the start node
 * 
 * @param {Object} startNode - The start node
 * @param {Array} links - Array of link objects
 * @param {Array} nodes - Array of node objects
 * @returns {Object} - Object with shortestDistances and longestDistances maps
 */
function findDistancesToStart(startNode, links, nodes) {
    const predMap = window.cybereumState?.predMap || buildPredecessorMap(links, nodes);
    const { topoOrder } = window.cybereumState?.slackResults || topologicalSort(nodes, links);

    // O(1) lookups + ID normalization (string/number mixed imports)
    const nodeMapLocal = new Map();
    for (const n of (nodes || [])) {
        const k = String(n.ID);
        nodeMapLocal.set(k, n);
        nodeMapLocal.set(n.ID, n);
        const num = Number(k);
        if (Number.isFinite(num)) nodeMapLocal.set(num, n);
    }

    const shortestDistances = new Map();
    const longestDistances = new Map();
    for (const n of (nodes || [])) {
        const k = String(n.ID);
        shortestDistances.set(k, Infinity);
        longestDistances.set(k, -Infinity);
    }

    const startKey = String((startNode && startNode.ID) != null ? startNode.ID : startNode);
    shortestDistances.set(startKey, 0);
    longestDistances.set(startKey, 0);

    for (const rawId of (topoOrder || [])) {
        const nodeKey = String(rawId);
        const node = nodeMapLocal.get(nodeKey) || nodeMapLocal.get(rawId);
        if (!node) continue;

        const predecessors =
            predMap.get(nodeKey) ||
            predMap.get(rawId) ||
            predMap.get(Number(nodeKey)) ||
            [];

        const nodeDuration = getNodeDurationHours(node);

        let bestShort = shortestDistances.get(nodeKey);
        let bestLong = longestDistances.get(nodeKey);
        if (bestShort === undefined) bestShort = Infinity;
        if (bestLong === undefined) bestLong = -Infinity;

        for (const edge of predecessors) {
            const srcKey = String(edge.source);
            const predNode = nodeMapLocal.get(srcKey) || nodeMapLocal.get(edge.source);
            if (!predNode) continue;

            const predDuration = getNodeDurationHours(predNode);
            const lag = getLinkLagHours(edge);

            const srcShort = shortestDistances.get(srcKey);
            const srcLong = longestDistances.get(srcKey);
            if (!Number.isFinite(srcShort) || !Number.isFinite(srcLong)) continue;

            let shortDist, longDist;
            switch (edge.type) {
                case 'FS':
                    shortDist = srcShort + predDuration + lag;
                    longDist = srcLong + predDuration + lag;
                    break;
                case 'SS':
                    shortDist = srcShort + lag;
                    longDist = srcLong + lag;
                    break;
                case 'FF':
                    shortDist = srcShort + Math.max(0, predDuration + lag - nodeDuration);
                    longDist = srcLong + Math.max(0, predDuration + lag - nodeDuration);
                    break;
                case 'SF':
                    shortDist = srcShort + Math.max(0, lag - nodeDuration);
                    longDist = srcLong + Math.max(0, lag - nodeDuration);
                    break;
                default:
                    shortDist = srcShort + predDuration + lag;
                    longDist = srcLong + predDuration + lag;
            }

            if (Number.isFinite(shortDist)) bestShort = Math.min(bestShort, shortDist);
            if (Number.isFinite(longDist)) bestLong = Math.max(bestLong, longDist);
        }

        shortestDistances.set(nodeKey, bestShort);
        longestDistances.set(nodeKey, bestLong);
    }

    // Store distances in node objects (used elsewhere as heuristics)
    for (const node of (nodes || [])) {
        const k = String(node.ID);
        const sd = shortestDistances.get(k);
        const ld = longestDistances.get(k);
        node.shortestDistanceToStart = Number.isFinite(sd) ? sd : 0;
        node.longestDistanceToStart = Number.isFinite(ld) ? ld : 0;
    }

    return { shortestDistances, longestDistances };
}



/**
 * Calculate shortest and longest distances from each node to the end node
 * 
 * @param {Object} startNode - The start node
 * @param {Object} endNode - The end node
 * @param {Array} links - Array of link objects
 * @param {Array} nodes - Array of node objects
 * @returns {Object} - Object with shortestDistances and longestDistances maps
 */
function findDistancesToEnd(startNode, endNode, links, nodes) {
    const succMap = window.cybereumState?.succMap || buildSuccessorMap(links, nodes);
    const { topoOrder } = window.cybereumState?.slackResults || topologicalSort(nodes, links);

    // O(1) lookups + ID normalization (string/number mixed imports)
    const nodeMapLocal = new Map();
    for (const n of (nodes || [])) {
        const k = String(n.ID);
        nodeMapLocal.set(k, n);
        nodeMapLocal.set(n.ID, n);
        const num = Number(k);
        if (Number.isFinite(num)) nodeMapLocal.set(num, n);
    }

    const shortestDistances = new Map();
    const longestDistances = new Map();
    for (const n of (nodes || [])) {
        const k = String(n.ID);
        shortestDistances.set(k, Infinity);
        longestDistances.set(k, -Infinity);
    }

    const endKey = String((endNode && endNode.ID) != null ? endNode.ID : endNode);
    shortestDistances.set(endKey, 0);
    longestDistances.set(endKey, 0);

    for (let i = (topoOrder || []).length - 1; i >= 0; i--) {
        const rawId = topoOrder[i];
        const nodeKey = String(rawId);
        const node = nodeMapLocal.get(nodeKey) || nodeMapLocal.get(rawId);
        if (!node) continue;

        const successors =
            succMap.get(nodeKey) ||
            succMap.get(rawId) ||
            succMap.get(Number(nodeKey)) ||
            [];

        const nodeDuration = getNodeDurationHours(node);

        let bestShort = shortestDistances.get(nodeKey);
        let bestLong = longestDistances.get(nodeKey);
        if (bestShort === undefined) bestShort = Infinity;
        if (bestLong === undefined) bestLong = -Infinity;

        for (const edge of successors) {
            const tgtKey = String(edge.target);
            const succNode = nodeMapLocal.get(tgtKey) || nodeMapLocal.get(edge.target);
            if (!succNode) continue;

            const succDuration = getNodeDurationHours(succNode);
            const lag = getLinkLagHours(edge);

            const tgtShort = shortestDistances.get(tgtKey);
            const tgtLong = longestDistances.get(tgtKey);
            if (!Number.isFinite(tgtShort) || !Number.isFinite(tgtLong)) continue;

            let shortDist, longDist;
            switch (edge.type) {
                case 'FS':
                    shortDist = tgtShort + lag + nodeDuration;
                    longDist = tgtLong + lag + nodeDuration;
                    break;
                case 'SS':
                    shortDist = Math.max(nodeDuration, lag + tgtShort);
                    longDist = Math.max(nodeDuration, lag + tgtLong);
                    break;
                case 'FF':
                    shortDist = Math.max(nodeDuration, Math.max(0, nodeDuration + lag - succDuration) + tgtShort);
                    longDist = Math.max(nodeDuration, Math.max(0, nodeDuration + lag - succDuration) + tgtLong);
                    break;
                case 'SF':
                    shortDist = Math.max(nodeDuration, Math.max(0, lag - succDuration) + tgtShort);
                    longDist = Math.max(nodeDuration, Math.max(0, lag - succDuration) + tgtLong);
                    break;
                default:
                    shortDist = tgtShort + nodeDuration + lag;
                    longDist = tgtLong + nodeDuration + lag;
            }

            if (Number.isFinite(shortDist)) bestShort = Math.min(bestShort, shortDist);
            if (Number.isFinite(longDist)) bestLong = Math.max(bestLong, longDist);
        }

        shortestDistances.set(nodeKey, bestShort);
        longestDistances.set(nodeKey, bestLong);
    }

    for (const node of (nodes || [])) {
        const k = String(node.ID);
        const sd = shortestDistances.get(k);
        const ld = longestDistances.get(k);
        node.shortestDistanceToEnd = Number.isFinite(sd) ? sd : 0;
        node.longestDistanceToEnd = Number.isFinite(ld) ? ld : 0;
    }

    return { shortestDistances, longestDistances };
}


/**
 * Optimized Critical Path Method calculation with calendar considerations
 * 
 * Computes ES (Early Start), EF (Early Finish), LS (Late Start), LF (Late Finish),
 * and slack for each node, properly accounting for all relationship types.
 * 
 * @param {Array} nodes - Array of node objects with Duration property
 * @param {Array} links - Array of link objects with relationship type, lag, etc.
 * @param {Object} teamCalendar - Calendar with hours per day, working days, etc.
 * @returns {Object} - Complete calculation results including maps and values
 */
function calculateSlackWithCalendar_Optimized(nodes, links, teamCalendar) {
    if (!Array.isArray(nodes) || !Array.isArray(links) || nodes.length === 0) {
        console.error("Invalid input data");
        return {};
    }

    console.log("calculateSlackWithCalendar === Starting Complete Fixed CPM Calculation ===");
    console.log(`calculateSlackWithCalendar Processing ${nodes.length} nodes and ${links.length} links`);

    // Step 1: Build graph structure
    const nodeMap = new Map();
    const succMap = new Map();
    const predMap = new Map();
    const inDegree = new Map();

    nodes.forEach(node => {
        nodeMap.set(node.ID, node);
        succMap.set(node.ID, []);
        predMap.set(node.ID, []);
        inDegree.set(node.ID, 0);

        // Reset all values to ensure clean calculation
        node.ES = 0;
        node.EF = 0;
        node.LS = 0;
        node.LF = 0;
        node.slack = 0;
        node.isCritical = false;
        node.issueFlags = [];
    });

    //nodeMap.forEach((node, id) => {
    //    console.log('calculateSlackWithCalendar nodeMap ', id, node);           // shows the ID and the full activity object
    //});
    // Process links
    links.forEach(link => {
        // 1️⃣ Normalise to string IDs (avoids "887" vs 887 mix-ups)
        const sourceID = String(typeof link.source === 'object' ? link.source.ID : link.source);
        const targetID = String(typeof link.target === 'object' ? link.target.ID : link.target);

        if (!nodeMap.has(sourceID) || !nodeMap.has(targetID)) {
            return;
        }
        const ensureNode = id => {
            if (!nodeMap.has(id)) {
                const ghost = {
                    ID: id,
                    Name: `Ghost Node ${id}`,
                    Duration: 0,
                    ES: 0, EF: 0, LS: 0, LF: 0, slack: 0, isCritical: false,
                    issueFlags: ['undefinedNode']
                };
                nodeMap.set(id, ghost);
                succMap.set(id, []);
                predMap.set(id, []);
                inDegree.set(id, 0);
            }
        };
        ensureNode(sourceID);
        ensureNode(targetID);

        // 3️⃣ Normalise link duration to hours
        let linkDuration = Number(link.duration) || 0;
        if (link.timeUnits === 'Days') {
            const hoursPerDay = teamCalendar?.hoursPerDay || 8;
            linkDuration *= hoursPerDay;
        }

        // 4️⃣ Build edge object
        const edge = {
            source: sourceID,
            target: targetID,
            type: link.type || 'FS',
            durHrs: linkDuration,
            lagHrs: getLinkLagHours(link),
            disabled: false   // may be flipped later by the cycle-breaker
        };

        // 5️⃣ Populate successor / predecessor maps
        succMap.get(sourceID).push(edge);
        predMap.get(targetID).push(edge);

        // 6️⃣ Safe in-degree increment (undefined ⇒ 0)
        inDegree.set(targetID, (inDegree.get(targetID) ?? 0) + 1);
    });

    // Step 2: Topological sort
    const topoOrder = [];
    const queue = [];

    inDegree.forEach((degree, nodeID) => {
        if (degree === 0) {
            queue.push(nodeID);
        }
    });

    let qHead = 0;
    while (qHead < queue.length) {
        const currentID = queue[qHead++];
        topoOrder.push(currentID);

        succMap.get(currentID).forEach(edge => {
            const newDegree = inDegree.get(edge.target) - 1;
            inDegree.set(edge.target, newDegree);
            if (newDegree === 0) {
                queue.push(edge.target);
            }
        });
    }

    console.log(`calculateSlackWithCalendar Topological sort completed: ${topoOrder.length} of ${nodes.length} nodes sorted`);
    // 🔍 DIAGNOSTIC: check that every node was sorted
    if (topoOrder.length !== inDegree.size) {
        const classifyProblem = (id) => {
            const preds = predMap.get(id) || [];
            const succs = succMap.get(id) || [];
            const node = nodeMap.get(id);

            if (node?.issueFlags?.includes('undefinedNode')) return 'undefinedNode';
            if (preds.length === 0 && succs.length === 0) return 'isolated';
            if (preds.length === 0) return 'orphanStart';
            if (succs.length === 0) return 'orphanEnd';
            return 'cycle'; // in-degree never hit 0 ⇒ loop
        };

        const allIds = Array.from(nodeMap.keys()).map(String);
        const skippedIds = allIds.filter(id => !topoOrder.includes(id));

        skippedIds.forEach(id => {
            const n = nodeMap.get(id);
            if (!Array.isArray(n.issueFlags)) n.issueFlags = [];
            const cause = classifyProblem(id);
            if (!n.issueFlags.includes(cause)) n.issueFlags.push(cause);
            if (!n.issueFlags.includes('notSorted')) n.issueFlags.push('notSorted');
        });

        const byCause = skippedIds.reduce((acc, id) => {
            const flags = nodeMap.get(id)?.issueFlags || [];
            flags.forEach(f => { if (f !== 'notSorted') acc[f] = (acc[f] || 0) + 1; });
            return acc;
        }, {});
        console.warn('⛔️ Topo sort skipped', skippedIds.length, 'nodes →',
            Object.entries(byCause).map(([k, v]) => `${k}:${v}`).join(' | '));
    }


    // Step 3: FORWARD PASS - Calculate ES and EF
    console.log("calculateSlackWithCalendar Starting forward pass...");

    topoOrder.forEach(nodeID => {
        const node = nodeMap.get(nodeID);
        const duration = getNodeDurationHours(node);
        const predecessors = predMap.get(nodeID) || [];

        if (predecessors.length === 0) {
            // Start node or disconnected node
            node.ES = 0;
            node.EF = duration;
        } else {
            let maxES = 0;

            predecessors.forEach(edge => {
                const predNode = nodeMap.get(edge.source);
                if (!predNode) return;

                const predES = predNode.ES;
                const predEF = predNode.EF;
                const lag = getLinkLagHours(edge);

                let candidateES;
                switch (edge.type) {
                    case 'FS':
                        candidateES = predEF + lag;
                        break;
                    case 'SS':
                        candidateES = predES + lag;
                        break;
                    case 'FF':
                        candidateES = Math.max(0, predEF + lag - duration);
                        break;
                    case 'SF':
                        candidateES = Math.max(0, predES + lag - duration);
                        break;
                    default:
                        candidateES = predEF + lag;
                }

                maxES = Math.max(maxES, candidateES);
            });

            node.ES = maxES;
            node.EF = maxES + duration;
        }
    });

    // Step 4: Find Project Finish Time
    // CRITICAL: Use the maximum EF of ALL nodes, not just end nodes
    let projectFinish = 0;
    let projectFinishNode = null;

    nodeMap.forEach((node, nodeID) => {
        if (node.EF > projectFinish) {
            projectFinish = node.EF;
            projectFinishNode = node;
        }
    });

    console.log(`calculateSlackWithCalendar Forward pass complete. Project finish time: ${projectFinish}`);
    if (projectFinishNode) {
        console.log(`calculateSlackWithCalendar Project finish determined by node ${projectFinishNode.ID}: ${projectFinishNode.Name}`);
    }

    // Ensure we have a valid project finish
    if (projectFinish <= 0) {
        console.error("calculateSlackWithCalendar ERROR: Project finish time is zero or negative!");
        // Calculate a reasonable default based on node durations
        projectFinish = nodes.reduce((sum, node) => sum + (getNodeDurationHours(node)), 0);
        console.log(`calculateSlackWithCalendar Using fallback project finish: ${projectFinish}`);
    }

    // Step 5: BACKWARD PASS - Calculate LS and LF
    console.log("calculateSlackWithCalendar Starting backward pass...");

    // First, initialize ALL nodes with project finish
    nodeMap.forEach(node => {
        node.LF = projectFinish;
        node.LS = projectFinish - (getNodeDurationHours(node));
    });

    // Find nodes with no successors (true end nodes)
    const endNodes = [];
    nodeMap.forEach((node, nodeID) => {
        if (succMap.get(nodeID).length === 0) {
            endNodes.push(nodeID);
            // End nodes should finish at project finish
            node.LF = projectFinish;
            node.LS = projectFinish - (getNodeDurationHours(node));
        }
    });

    console.log(`calculateSlackWithCalendar Found ${endNodes.length} end nodes`);

    // Process nodes in reverse topological order
    for (let i = topoOrder.length - 1; i >= 0; i--) {
        const nodeID = topoOrder[i];
        const node = nodeMap.get(nodeID);
        const duration = getNodeDurationHours(node);
        const successors = succMap.get(nodeID) || [];

        if (successors.length > 0) {
            let minLF = projectFinish;
            if (!Number.isFinite(minLF)) {
                node.issueFlags.push('cycle');
            }
            successors.forEach(edge => {
                const succNode = nodeMap.get(edge.target);
                if (!succNode) return;

                const succLS = succNode.LS;
                const succLF = succNode.LF;
                const succDuration = getNodeDurationHours(succNode);
                const lag = getLinkLagHours(edge);

                let candidateLF;
                switch (edge.type) {
                    case 'FS':
                        candidateLF = succLS - lag;
                        break;
                    case 'SS':
                        candidateLF = succLS - lag + duration;
                        break;
                    case 'FF':
                        candidateLF = succLF - lag;
                        break;
                    case 'SF':
                        candidateLF = succLF - lag + duration;
                        break;
                    default:
                        candidateLF = succLS - lag;
                }

                minLF = Math.min(minLF, candidateLF);
            });

            node.LF = minLF;
            node.LS = minLF - duration;
        }
    }

    console.log("calculateSlackWithCalendar Backward pass complete");

    // Step 6: Calculate Slack and Identify Critical Path
    const slackValues = {};
    let criticalCount = 0;
    let minSlack = Infinity;
    let maxSlack = -Infinity;

    nodeMap.forEach((node, nodeID) => {
        // Total slack = LS - ES (or LF - EF)
        node.slack = node.LS - node.ES;

        // Track min/max for debugging
        minSlack = Math.min(minSlack, node.slack);
        maxSlack = Math.max(maxSlack, node.slack);

        // A node is critical if slack is approximately zero
        node.isCritical = Math.abs(node.slack) < 0.001;

        if (node.isCritical) {
            criticalCount++;
        }

        slackValues[nodeID] = node.slack;
    });

    console.log(`calculateSlackWithCalendar Slack calculation complete:`);
    console.log(` calculateSlackWithCalendar Critical nodes: ${criticalCount}`);
    console.log(` calculateSlackWithCalendar Min slack: ${minSlack}`);
    console.log(` calculateSlackWithCalendar Max slack: ${maxSlack}`);

    // Step 7: Validate Results
    if (minSlack < -1) {
        console.warn("calculateSlackWithCalendar ⚠️ WARNING: Large negative slack values detected!");
        console.warn("calculateSlackWithCalendar This usually indicates:");
        console.warn(" calculateSlackWithCalendar 1. Disconnected nodes in the network");
        console.warn(" calculateSlackWithCalendar 2. Incorrect project finish time");
        console.warn(" calculateSlackWithCalendar 3. Cycles in the graph");

        // Run diagnostic
        //diagnoseCPMIssues(Array.from(nodeMap.values()), links);
    }

    // Store results
    if (window.cybereumState) {
        window.cybereumState.slackResults = {
            nodeMap,
            succMap,
            predMap,
            topoOrder,
            slackValues,
            projectFinish,
            criticalCount
        };
    }

    // Gather all nodes that have at least one flag
    const problemNodes = Array.from(nodeMap.values()).filter(n => n.issueFlags.length);

    // Expose for UI/other modules
    if (window.cybereumState) {
        window.cybereumState.problemNodes = problemNodes;
    }

    return {
        nodeMap,
        succMap,
        predMap,
        topoOrder,
        slackValues,
        projectFinish,
        nodes: Array.from(nodeMap.values()),
        criticalCount,
        statistics: {
            minSlack,
            maxSlack,
            criticalNodes: criticalCount,
            totalNodes: nodes.length
        },
        problemNodes
    };
}
/**
* Optimized calculateSlack function for DAG-based project scheduling.
*
* This function computes ES (Early Start), EF (Early Finish), LS (Late Start),
* LF (Late Finish), and slack for each node. It requires the graph to be a DAG
* (Directed Acyclic Graph); otherwise, the calculation is invalid.
*
* @param {Array} nodes - Array of node objects, each containing:
*   - ID (string|number),
*   - Duration (number),
*   - ES, EF, LS, LF (optional, will be computed here).
* @param {Array} links - Array of link objects, each containing:
*   - source (object|ID),
*   - target (object|ID),
*   - lag (number),
*   - timeUnits ('Hours'|'Days'),
*   - type ('FS'|'SS'|'FF'|'SF' or custom).
* @returns {Object} - Returns an object mapping nodeID -> slack. Also mutates
*                     the original node objects by setting ES, EF, LS, LF.
*/


/**
* calculateDistance (Fixed - Longest Path)
*
* Calculates the longest path distance from fromNode to toNode using topological ordering.
* Uses Kahn's algorithm to process nodes in topological order, computing the maximum
* distance to each node from the start.
*/
function calculateDistance(fromNode, toNode, nodes, links) {
    if (!fromNode || !toNode || fromNode.ID === toNode.ID) {
        return 0;
    }

    const nodeMap = new Map(nodes.map(n => [n.ID, n]));
    const succMap = window.cybereumState?.succMap || buildSuccessorMap(links, nodeMap);

    // Use dynamic programming to find longest path (for DAGs)
    // dist[nodeId] = longest distance from fromNode to nodeId
    const dist = new Map();
    dist.set(fromNode.ID, 0);

    // Build topological order starting from fromNode using BFS
    const inDegree = new Map();
    const reachable = new Set();

    // First, find all nodes reachable from fromNode
    const queue = [fromNode.ID];
    reachable.add(fromNode.ID);
    let qHead = 0;
    while (qHead < queue.length) {
        const current = queue[qHead++];
        const edges = succMap.get(current) || [];
        for (const edge of edges) {
            if (!reachable.has(edge.target)) {
                reachable.add(edge.target);
                queue.push(edge.target);
            }
        }
    }

    // If toNode is not reachable, return 0
    if (!reachable.has(toNode.ID)) {
        return 0;
    }

    // Calculate in-degrees for reachable nodes
    for (const nodeId of reachable) {
        inDegree.set(nodeId, 0);
    }
    for (const nodeId of reachable) {
        const edges = succMap.get(nodeId) || [];
        for (const edge of edges) {
            if (reachable.has(edge.target)) {
                inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
            }
        }
    }

    // Process in topological order using Kahn's algorithm
    const topoQueue = [];
    for (const [nodeId, deg] of inDegree) {
        if (deg === 0) {
            topoQueue.push(nodeId);
        }
    }

    let tqHead = 0;
    while (tqHead < topoQueue.length) {
        const currentId = topoQueue[tqHead++];
        const currentNode = nodeMap.get(currentId);
        const currentDist = dist.get(currentId);

        // Skip if we haven't reached this node yet from fromNode
        if (currentDist === undefined) continue;

        const edges = succMap.get(currentId) || [];
        for (const edge of edges) {
            if (!reachable.has(edge.target)) continue;

            const nextNode = nodeMap.get(edge.target);
            if (!nextNode) continue;

            // Calculate edge weight based on dependency type
            let edgeWeight = 0;
            switch (edge.type || 'FS') {
                case 'FS':
                    edgeWeight = getNodeDurationHours(currentNode) + getLinkLagHours(edge);
                    break;
                case 'SS':
                    edgeWeight = getLinkLagHours(edge);
                    break;
                case 'FF':
                    edgeWeight = Math.max(0, getNodeDurationHours(currentNode) + getLinkLagHours(edge) - getNodeDurationHours(nextNode));
                    break;
                case 'SF':
                    edgeWeight = Math.max(0, getLinkLagHours(edge) - getNodeDurationHours(nextNode));
                    break;
                default:
                    edgeWeight = getNodeDurationHours(currentNode) + getLinkLagHours(edge);
            }

            // Update longest distance to next node
            const newDist = currentDist + edgeWeight;
            if (!dist.has(edge.target) || dist.get(edge.target) < newDist) {
                dist.set(edge.target, newDist);
            }

            // Decrease in-degree and add to queue if ready
            const newDegree = inDegree.get(edge.target) - 1;
            inDegree.set(edge.target, newDegree);
            if (newDegree === 0) {
                topoQueue.push(edge.target);
            }
        }
    }

    return dist.get(toNode.ID) || 0;
}
async function findPathsToAndFromNode(nodeId, nodes, links) {
    // Use globally available data
    const succMap = window.cybereumState?.succMap;
    const predMap = window.cybereumState?.predMap;
    const nodeMap = window.cybereumState?.nodeMap;
    const allPathsWithDurations = window.cybereumState?.allPathsWithDurations;

    if (!succMap || !predMap || !nodeMap) {
        console.warn("Required maps not found, falling back to full path search");
        const startNode = nodes.find(node => node.ID === "0");
        const endNode = nodes.reduce((a, b) => (Number(a.ID) > Number(b.ID)) ? a : b);
        const targetNode = nodes.find(n => n.ID === nodeId);

        return {
            pathsToNode: await findAllPaths(startNode, targetNode, links, nodes),
            pathsFromNode: await findAllPaths(targetNode, endNode, links, nodes)
        };
    }

    // If we have all paths cached, filter them
    if (allPathsWithDurations) {
        const { paths, durations } = allPathsWithDurations;

        // Filter paths that contain our target node
        const pathsContainingNode = paths.map((path, index) => ({
            path,
            duration: durations[index],
            nodeIndex: path.findIndex(n => n.ID === nodeId)
        })).filter(item => item.nodeIndex !== -1);

        // Split paths at the target node
        const toNode = [];
        const fromNode = [];

        pathsContainingNode.forEach(({ path, duration, nodeIndex }) => {
            // Path to node (start to target)
            toNode.push({
                path: path.slice(0, nodeIndex + 1),
                duration: calculatePartialPathDuration(path.slice(0, nodeIndex + 1), links)
            });

            // Path from node (target to end)
            fromNode.push({
                path: path.slice(nodeIndex),
                duration: calculatePartialPathDuration(path.slice(nodeIndex), links)
            });
        });

        return {
            pathsToNode: {
                paths: toNode.map(p => p.path),
                durations: toNode.map(p => p.duration)
            },
            pathsFromNode: {
                paths: fromNode.map(p => p.path),
                durations: fromNode.map(p => p.duration)
            }
        };
    }

    // If we don't have cached paths but have the topology maps,
    // do a targeted search using predMap/succMap
    const targetNode = nodeMap.get(nodeId);
    const pathsToNode = findPathsUsingMap(predMap, "0", nodeId, nodeMap);
    const pathsFromNode = findPathsUsingMap(succMap, nodeId,
        [...nodeMap.keys()].reduce((a, b) => Number(a) > Number(b) ? a : b), nodeMap);

    return {
        pathsToNode: {
            paths: pathsToNode,
            durations: pathsToNode.map(path => calculatePartialPathDuration(path, links))
        },
        pathsFromNode: {
            paths: pathsFromNode,
            durations: pathsFromNode.map(path => calculatePartialPathDuration(path, links))
        }
    };
}

function findPathsUsingMap(directionMap, startId, endId, nodeMap) {
    const paths = [];
    const visited = new Set();

    function dfs(currentId, currentPath) {
        if (currentId === endId) {
            paths.push(currentPath.map(id => nodeMap.get(id)));
            return;
        }

        visited.add(currentId);
        const neighbors = directionMap.get(currentId) || [];

        for (const edge of neighbors) {
            const nextId = typeof edge === 'object' ? edge.target : edge;
            if (!visited.has(nextId)) {
                dfs(nextId, [...currentPath, nextId]);
            }
        }
        visited.delete(currentId);
    }

    dfs(startId, [startId]);
    return paths;
}

function calculatePartialPathDuration(path, links, nodes) {
    // Duration math in HOURS, honoring node.TimeUnits and global calendar defaults.
    const hoursPerDay = window.DEFAULT_HOURS_PER_DAY || 8;

    let totalHours = 0;

    for (let i = 0; i < path.length; i++) {
        const node = path[i];
        totalHours += getNodeDurationHours(node);

        // Add lag/edge effects when available (best-effort; does not encode full relationship logic)
        if (i < path.length - 1 && Array.isArray(links) && links.length) {
            const fromId = node.ID;
            const toId = path[i + 1].ID;

            // Find the specific link for this hop
            const link = links.find(l => {
                const s = typeof l.source === "object" ? l.source.ID : l.source;
                const t = typeof l.target === "object" ? l.target.ID : l.target;
                return String(s) === String(fromId) && String(t) === String(toId);
            });

            if (link) {
                // Include lag in HOURS
                const lagHrs = getLinkLagHours(link);
                if (Number.isFinite(lagHrs) && lagHrs > 0) totalHours += lagHrs;

                // Some link datasets include a duration/timeUnits; normalize if present (rare in P6 links)
                const edgeDurRaw = link.duration ?? 0;
                const edgeUnits = link.timeUnits || "Hours";
                const edgeDurHrs = convertDurationToHours(edgeDurRaw, edgeUnits);
                if (Number.isFinite(edgeDurHrs) && edgeDurHrs > 0) totalHours += edgeDurHrs;
            }
        }
    }

    return totalHours;
}


/* =============================================================================
 * CPM-DERIVED DRIVING GRAPH (Deterministic Critical / Near-Critical / Outlier Chains)
 * =============================================================================
 *
 * Key goals:
 * - Deterministic "driving chain" extraction on top of CPM (no repeated tiny-variation loops)
 * - Explainable: for any node on a chain, show the predecessor constraints ranked by impact
 * - Fast: O(N+E) CPM + constrained enumeration on a much smaller Driving Predecessor Graph (DPG)
 *
 * Enable:
 *   window.cybereumConfig = window.cybereumConfig || {};
 *   window.cybereumConfig.paths = window.cybereumConfig.paths || {};
 *   window.cybereumConfig.paths.useDrivingGraph = true;
 */

const CYB_DG_DEFAULT = {
    epsilonHours: 0.01,                    // 0.01 hours (36 seconds) — tight enough for correctness,
    // forgiving enough for accumulated floating-point from calendar/lag conversions
    criticalFloatTolHours: 0.01,           // match epsilon for consistency
    nearCriticalFloatTolHours: 24,     // ~3 working days @ 8h/day
    nearDrivingTolHours: 8,            // include near-driving predecessors up to 1 day slack-from-max
    maxCriticalChains: 80,
    maxNearCriticalChains: 200,
    maxExpansions: 250000,
    maxDepthGuard: 20000,
    selectionMode: "outliers",        // 'raw' | 'outliers'
    maxDisplayChains: 15,
    minJaccardNovelty: 0.25,           // 0..1 (higher = require more novelty)
    tooltipMaxRows: 10
};

function cybDG_getConfig(overrides = {}) {
    const globalCfg = window.cybereumConfig?.paths?.drivingGraph || {};
    const cfg = { ...CYB_DG_DEFAULT, ...globalCfg, ...overrides };
    // Coerce numeric fields
    for (const k of [
        "epsilonHours", "criticalFloatTolHours", "nearCriticalFloatTolHours", "nearDrivingTolHours",
        "maxCriticalChains", "maxNearCriticalChains", "maxExpansions", "maxDepthGuard", "maxDisplayChains",
        "minJaccardNovelty", "tooltipMaxRows"
    ]) {
        if (k in cfg) {
            const v = Number(cfg[k]);
            if (Number.isFinite(v)) cfg[k] = v;
        }
    }
    cfg.selectionMode = String(cfg.selectionMode || "outliers").toLowerCase();
    return cfg;
}

function cybDG_normId(x) {
    if (x == null) return "";
    if (typeof x === "object" && x.ID != null) return String(x.ID);
    return String(x);
}

function cybDG_canonicalNodeMap(nodeMap) {
    const m = new Map();
    if (nodeMap instanceof Map) {
        for (const [k, v] of nodeMap.entries()) m.set(String(k), v);
        return m;
    }
    // Array-like fallback
    if (Array.isArray(nodeMap)) {
        for (const n of nodeMap) if (n && n.ID != null) m.set(String(n.ID), n);
    }
    return m;
}

function cybDG_buildEdgeMaps(links, nodeMapStr) {
    const succ = new Map();
    const pred = new Map();
    for (const id of nodeMapStr.keys()) {
        succ.set(id, []);
        pred.set(id, []);
    }

    for (const link of (links || [])) {
        const s = cybDG_normId(typeof link.source === "object" ? link.source.ID : link.source);
        const t = cybDG_normId(typeof link.target === "object" ? link.target.ID : link.target);
        if (!s || !t) continue;
        if (!nodeMapStr.has(s) || !nodeMapStr.has(t)) continue;

        const type = String(link.type || link.Type || link.relation || link.Relation || "FS").toUpperCase();
        const lagHrs = (typeof getLinkLagHours === "function") ? getLinkLagHours(link) : 0;
        const edge = {
            source: s,
            target: t,
            type: (type === "FS" || type === "SS" || type === "FF" || type === "SF") ? type : "FS",
            lagHrs: Number.isFinite(lagHrs) ? lagHrs : 0,
            _raw: link
        };

        succ.get(s).push(edge);
        pred.get(t).push(edge);
    }

    return { succ, pred };
}

function cybDG_reachableFrom(startId, succ) {
    const seen = new Set();
    const q = [startId];
    seen.add(startId);
    while (q.length) {
        const cur = q.pop();
        const edges = succ.get(cur) || [];
        for (const e of edges) {
            const n = String(e.target);
            if (!seen.has(n)) { seen.add(n); q.push(n); }
        }
    }
    return seen;
}

function cybDG_canReach(endId, pred) {
    const seen = new Set();
    const q = [endId];
    seen.add(endId);
    while (q.length) {
        const cur = q.pop();
        const edges = pred.get(cur) || [];
        for (const e of edges) {
            const p = String(e.source);
            if (!seen.has(p)) { seen.add(p); q.push(p); }
        }
    }
    return seen;
}

function cybDG_topoSort(activeIds, succ, pred) {
    const indeg = new Map();
    for (const id of activeIds) indeg.set(id, 0);

    for (const id of activeIds) {
        for (const e of (succ.get(id) || [])) {
            const t = String(e.target);
            if (!activeIds.has(t)) continue;
            indeg.set(t, (indeg.get(t) || 0) + 1);
        }
    }

    const q = [];
    for (const [id, d] of indeg.entries()) if (d === 0) q.push(id);
    const order = [];

    while (q.length) {
        const id = q.pop();
        order.push(id);
        for (const e of (succ.get(id) || [])) {
            const t = String(e.target);
            if (!activeIds.has(t)) continue;
            const nd = (indeg.get(t) || 0) - 1;
            indeg.set(t, nd);
            if (nd === 0) q.push(t);
        }
    }

    const hasCycle = order.length !== activeIds.size;
    if (hasCycle) {
        // Fallback: append remaining nodes to allow best-effort CPM
        const ordered = new Set(order);
        for (const id of activeIds) if (!ordered.has(id)) order.push(id);
    }
    return { order, hasCycle };
}

function cybDG_candidateES(predId, nodeId, edge, ES, EF, nodeMapStr) {
    const lag = edge.lagHrs || 0;
    const predES = ES.get(predId) ?? 0;
    const predEF = EF.get(predId) ?? (predES + (typeof getNodeDurationHours === "function" ? getNodeDurationHours(nodeMapStr.get(predId)) : 0));
    const dur = (typeof getNodeDurationHours === "function") ? getNodeDurationHours(nodeMapStr.get(nodeId)) : 0;
    switch (edge.type) {
        case "SS": return predES + lag;
        case "FF": return predEF + lag - dur;
        case "SF": return predES + lag - dur;
        case "FS":
        default: return predEF + lag;
    }
}

function cybDG_candidateLF(nodeId, succId, edge, LS, LF, nodeMapStr) {
    const lag = edge.lagHrs || 0;
    const succLS = LS.get(succId);
    const succLF = LF.get(succId);
    const dur = (typeof getNodeDurationHours === "function") ? getNodeDurationHours(nodeMapStr.get(nodeId)) : 0;
    switch (edge.type) {
        case "SS": return (succLS ?? 0) - lag + dur;
        case "FF": return (succLF ?? 0) - lag;
        case "SF": return (succLF ?? 0) - lag + dur;
        case "FS":
        default: return (succLS ?? 0) - lag;
    }
}

function cybDG_computeCPM(activeIds, topoOrder, succ, pred, nodeMapStr, startId, endId) {
    const ES = new Map();
    const EF = new Map();
    const LS = new Map();
    const LF = new Map();
    const TF = new Map();

    // Init ES
    for (const id of activeIds) ES.set(id, Number.NEGATIVE_INFINITY);

    // Start anchors
    ES.set(startId, 0);
    for (const id of activeIds) {
        const preds = (pred.get(id) || []).filter(e => activeIds.has(String(e.source)));
        if (preds.length === 0 && ES.get(id) === Number.NEGATIVE_INFINITY) ES.set(id, 0);
    }

    // Forward pass
    for (const id of topoOrder) {
        if (!activeIds.has(id)) continue;
        const dur = (typeof getNodeDurationHours === "function") ? getNodeDurationHours(nodeMapStr.get(id)) : 0;

        const preds = (pred.get(id) || []).filter(e => activeIds.has(String(e.source)));
        let best = ES.get(id);
        if (best === Number.NEGATIVE_INFINITY) best = 0;
        for (const e of preds) {
            const p = String(e.source);
            const c = cybDG_candidateES(p, id, e, ES, EF, nodeMapStr);
            if (c > best) best = c;
        }
        ES.set(id, best);
        EF.set(id, best + dur);
    }

    // Determine project finish
    let projectFinish = EF.get(endId);
    if (!Number.isFinite(projectFinish)) {
        projectFinish = 0;
        for (const id of activeIds) {
            const v = EF.get(id);
            if (Number.isFinite(v) && v > projectFinish) projectFinish = v;
        }
    }

    // Init LF
    for (const id of activeIds) LF.set(id, Number.POSITIVE_INFINITY);
    // End anchor
    LF.set(endId, projectFinish);
    // Sinks anchor
    for (const id of activeIds) {
        const succs = (succ.get(id) || []).filter(e => activeIds.has(String(e.target)));
        if (succs.length === 0) LF.set(id, Math.min(LF.get(id), projectFinish));
    }

    // Backward pass
    const rev = [...topoOrder].reverse();
    for (const id of rev) {
        if (!activeIds.has(id)) continue;
        const dur = (typeof getNodeDurationHours === "function") ? getNodeDurationHours(nodeMapStr.get(id)) : 0;
        let lf = LF.get(id);
        if (!Number.isFinite(lf) || lf === Number.POSITIVE_INFINITY) lf = projectFinish;

        const succs = (succ.get(id) || []).filter(e => activeIds.has(String(e.target)));
        for (const e of succs) {
            const s = String(e.target);
            const cand = cybDG_candidateLF(id, s, e, LS, LF, nodeMapStr);
            if (Number.isFinite(cand) && cand < lf) lf = cand;
        }
        LF.set(id, lf);
        LS.set(id, lf - dur);
    }

    for (const id of activeIds) {
        const tf = (LS.get(id) ?? 0) - (ES.get(id) ?? 0);
        TF.set(id, tf);
    }

    return { ES, EF, LS, LF, TF, projectFinish };
}

function cybDG_computePredRanking(activeIds, pred, ES, EF, nodeMapStr) {
    const rankings = new Map();
    for (const id of activeIds) {
        const preds = (pred.get(id) || []).filter(e => activeIds.has(String(e.source)));
        if (!preds.length) { rankings.set(id, []); continue; }

        // Aggregate by predecessor (choose the most constraining edge for that predecessor)
        const agg = new Map(); // predId -> entry
        let bestES = Number.NEGATIVE_INFINITY;
        for (const e of preds) {
            const p = String(e.source);
            const cand = cybDG_candidateES(p, id, e, ES, EF, nodeMapStr);
            if (cand > bestES) bestES = cand;

            const cur = agg.get(p);
            if (!cur || cand > cur.candidateES) {
                agg.set(p, {
                    predId: p,
                    type: e.type,
                    lagHrs: e.lagHrs || 0,
                    candidateES: cand
                });
            }
        }

        const arr = Array.from(agg.values()).map(x => ({
            ...x,
            deltaHrs: bestES - x.candidateES
        })).sort((a, b) => b.candidateES - a.candidateES);

        rankings.set(id, arr);
    }
    return rankings;
}

function cybDG_buildDrivingPredSets(activeIds, rankings, TF, cfg) {
    const driving = new Map();
    const nearDriving = new Map();
    for (const id of activeIds) {
        const r = rankings.get(id) || [];
        driving.set(id, r.filter(x => x.deltaHrs <= cfg.epsilonHours));
        nearDriving.set(id, r.filter(x => x.deltaHrs <= cfg.nearDrivingTolHours));
    }
    return { driving, nearDriving };
}

function cybDG_enumerateChainsBackwards(startId, endId, predsMap, nodeMapStr, cfg, maxChains) {
    const out = [];
    const path = [endId];
    const pathSet = new Set([endId]); // O(1) cycle detection
    let expansions = 0;

    function dfs(current) {
        if (out.length >= maxChains) return;
        if (++expansions > cfg.maxExpansions) return;
        if (path.length > cfg.maxDepthGuard) return;

        if (current === startId) {
            const nodes = path.slice().reverse().map(id => nodeMapStr.get(id)).filter(Boolean);
            if (nodes.length) out.push(nodes);
            return;
        }

        const preds = predsMap.get(current) || [];
        if (!preds.length) return;

        // Try most driving first (delta small)
        const ordered = preds.slice().sort((a, b) => (a.deltaHrs - b.deltaHrs));
        for (const p of ordered) {
            const pid = String(p.predId);
            if (!nodeMapStr.has(pid)) continue;
            if (pathSet.has(pid)) continue; // O(1) cycle guard
            path.push(pid);
            pathSet.add(pid);
            dfs(pid);
            path.pop();
            pathSet.delete(pid);
            if (out.length >= maxChains) return;
            if (expansions > cfg.maxExpansions) return;
        }
    }

    dfs(endId);
    return out;
}

function cybDG_computePathDuration(pathNodes, nodeMapStr, succ) {
    if (!Array.isArray(pathNodes) || pathNodes.length <= 1) return 0;
    const startTimes = new Map();
    const finishTimes = new Map();

    const firstId = String(pathNodes[0].ID);
    startTimes.set(firstId, 0);
    finishTimes.set(firstId, (typeof getNodeDurationHours === "function") ? getNodeDurationHours(pathNodes[0]) : 0);

    for (let i = 0; i < pathNodes.length - 1; i++) {
        const curId = String(pathNodes[i].ID);
        const nxtId = String(pathNodes[i + 1].ID);
        const curStart = startTimes.get(curId) ?? 0;
        const curFinish = finishTimes.get(curId) ?? curStart;

        const edges = succ.get(curId) || [];
        const edge = edges.find(e => String(e.target) === nxtId);
        const nxtDur = (typeof getNodeDurationHours === "function") ? getNodeDurationHours(pathNodes[i + 1]) : 0;
        let nxtStart = curFinish;

        if (edge) {
            const lag = edge.lagHrs || 0;
            switch (edge.type) {
                case "SS": nxtStart = curStart + lag; break;
                case "FF": nxtStart = (curFinish + lag) - nxtDur; break;
                case "SF": nxtStart = (curStart + lag) - nxtDur; break;
                case "FS":
                default: nxtStart = curFinish + lag; break;
            }
        }

        // Avoid negative time in isolated-chain simulation
        nxtStart = Math.max(0, nxtStart);
        startTimes.set(nxtId, nxtStart);
        finishTimes.set(nxtId, nxtStart + nxtDur);
    }

    const lastId = String(pathNodes[pathNodes.length - 1].ID);
    return finishTimes.get(lastId) ?? 0;
}

function cybDG_jaccard(aSet, bSet) {
    let inter = 0;
    for (const x of aSet) if (bSet.has(x)) inter++;
    const union = aSet.size + bSet.size - inter;
    return union ? inter / union : 0;
}

function cybDG_selectOutliers(paths, durations, cfg) {
    if (!paths.length) return { paths: [], durations: [] };
    // Sort by duration desc
    const idx = paths.map((_, i) => i).sort((i, j) => (durations[j] || 0) - (durations[i] || 0));
    const sel = [];
    const selDur = [];
    const selSets = [];

    for (const i of idx) {
        if (sel.length >= cfg.maxDisplayChains) break;
        const p = paths[i];
        const d = durations[i];
        if (!Array.isArray(p) || !p.length) continue;

        const s = new Set(p.map(n => String(n.ID)));
        if (!sel.length) {
            sel.push(p); selDur.push(d); selSets.push(s);
            continue;
        }

        // Require novelty vs all selected: reject if too similar to ANY already-selected path
        let maxSim = 0;
        for (const ss of selSets) {
            const j = cybDG_jaccard(s, ss);
            if (j > maxSim) maxSim = j;
        }
        if (maxSim <= (1 - cfg.minJaccardNovelty)) {
            sel.push(p); selDur.push(d); selSets.push(s);
        }
    }

    return { paths: sel, durations: selDur };
}

function extractDrivingGraphPathsFromCPM(startNode, endNode, nodes, links, nodeMap, succMap, predMap, overrides = {}) {
    const cfg = cybDG_getConfig(overrides);
    const nodeMapStr = cybDG_canonicalNodeMap(nodeMap);
    const startId = cybDG_normId(startNode);
    const endId = cybDG_normId(endNode);
    if (!nodeMapStr.has(startId) || !nodeMapStr.has(endId)) {
        return { paths: [], durations: [], drivingGraph: {}, explainability: {}, _rawPathCount: 0 };
    }

    const { succ, pred } = cybDG_buildEdgeMaps(links, nodeMapStr);
    const reach = cybDG_reachableFrom(startId, succ);
    const canReach = cybDG_canReach(endId, pred);
    const activeIds = new Set([...reach].filter(x => canReach.has(x)));
    if (!activeIds.size) {
        return { paths: [], durations: [], drivingGraph: {}, explainability: {}, _rawPathCount: 0 };
    }

    const topo = cybDG_topoSort(activeIds, succ, pred);
    const cpm = cybDG_computeCPM(activeIds, topo.order, succ, pred, nodeMapStr, startId, endId);
    const rankings = cybDG_computePredRanking(activeIds, pred, cpm.ES, cpm.EF, nodeMapStr);
    const { driving, nearDriving } = cybDG_buildDrivingPredSets(activeIds, rankings, cpm.TF, cfg);

    const criticalNodeIds = new Set([...activeIds].filter(id => (cpm.TF.get(id) ?? 0) <= cfg.criticalFloatTolHours + cfg.epsilonHours));
    const nearCriticalNodeIds = new Set([...activeIds].filter(id => (cpm.TF.get(id) ?? 0) <= cfg.nearCriticalFloatTolHours + cfg.epsilonHours));

    const drivingCriticalPreds = new Map();
    const nearDrivingNearCriticalPreds = new Map();
    for (const id of activeIds) {
        drivingCriticalPreds.set(id, criticalNodeIds.has(id) ? (driving.get(id) || []).filter(r => criticalNodeIds.has(String(r.predId))) : []);
        nearDrivingNearCriticalPreds.set(id, nearCriticalNodeIds.has(id) ? (nearDriving.get(id) || []).filter(r => nearCriticalNodeIds.has(String(r.predId))) : []);
    }

    const criticalChains = cybDG_enumerateChainsBackwards(startId, endId, drivingCriticalPreds, nodeMapStr, cfg, cfg.maxCriticalChains);
    const nearCriticalChains = cybDG_enumerateChainsBackwards(startId, endId, nearDrivingNearCriticalPreds, nodeMapStr, cfg, cfg.maxNearCriticalChains);

    // Dedupe
    const bySig = new Map();
    function addAll(arr, label) {
        for (const p of arr) {
            const sig = p.map(n => String(n.ID)).join("->");
            if (!bySig.has(sig)) bySig.set(sig, { path: p, labels: new Set([label]) });
            else bySig.get(sig).labels.add(label);
        }
    }
    addAll(criticalChains, "critical");
    addAll(nearCriticalChains, "nearCritical");

    const candidates = Array.from(bySig.values()).map(x => x.path);
    const candDurations = candidates.map(p => cybDG_computePathDuration(p, nodeMapStr, succ));

    let selected;
    if (cfg.selectionMode === "raw") {
        selected = { paths: candidates, durations: candDurations };
    } else {
        selected = cybDG_selectOutliers(candidates, candDurations, cfg);
    }

    // Persist explainability for UI
    window.cybereumState = window.cybereumState || {};
    window.cybereumState.drivingGraphExplainability = {
        startId,
        endId,
        config: cfg,
        cpm: {
            ES: Object.fromEntries(cpm.ES),
            EF: Object.fromEntries(cpm.EF),
            LS: Object.fromEntries(cpm.LS),
            LF: Object.fromEntries(cpm.LF),
            TF: Object.fromEntries(cpm.TF),
            projectFinish: cpm.projectFinish
        },
        predRankings: Object.fromEntries(Array.from(rankings.entries()).map(([k, v]) => [k, v])),
        computedAt: new Date().toISOString()
    };

    const out = {
        paths: selected.paths || [],
        durations: selected.durations || [],
        drivingGraph: {
            activeNodeCount: activeIds.size,
            topoHasCycle: topo.hasCycle,
            projectFinish: cpm.projectFinish,
            criticalChainCount: criticalChains.length,
            nearCriticalChainCount: nearCriticalChains.length,
            rawCandidateCount: candidates.length
        },
        explainability: { startId, endId },
        _rawPathCount: candidates.length
    };

    window.cybereumState.drivingGraphResult = out;
    return out;
}

function getDrivingPathAndAlternatesFromDrivingGraph(nodeMap, links, startID, endID, options = {}) {
    const nm = cybDG_canonicalNodeMap(nodeMap);
    const startId = String(startID);
    const endId = String(endID);
    const startNode = nm.get(startId) || nm.get(String(startID));
    const endNode = nm.get(endId) || nm.get(String(endID));
    if (!startNode || !endNode) {
        return {
            drivingPath: null,
            drivingDuration: 0,
            critical: { paths: [], durations: [], duration: 0 },
            alternates: { paths: [], durations: [] },
            combined: { paths: [], durations: [] },
            drivingGraph: {}
        };
    }

    const dg = extractDrivingGraphPathsFromCPM(startNode, endNode, Array.from(nm.values()), links, nm, null, null, options.drivingGraph || {});
    const paths = dg.paths || [];
    const durs = dg.durations || [];
    const drivingPath = paths.length ? paths[0] : null;
    const drivingDuration = durs.length ? durs[0] : 0;

    return {
        drivingPath,
        drivingDuration,
        critical: {
            paths: drivingPath ? [drivingPath] : [],
            durations: drivingPath ? [drivingDuration] : [],
            duration: drivingDuration
        },
        alternates: {
            paths: paths.slice(drivingPath ? 1 : 0),
            durations: durs.slice(drivingPath ? 1 : 0)
        },
        combined: { paths, durations: durs },
        drivingGraph: dg.drivingGraph || {},
        explainability: dg.explainability || {}
    };
}

// -------------------- UI hook: tooltip for predecessor constraint ranking --------------------

function cybDG_getNodeExplanation(nodeId, limit = null) {
    const st = window.cybereumState?.drivingGraphExplainability;
    if (!st) return null;
    const id = String(nodeId);
    const rank = st.predRankings?.[id] || [];
    const lim = Number.isFinite(limit) ? limit : (st.config?.tooltipMaxRows || CYB_DG_DEFAULT.tooltipMaxRows);
    const top = rank.slice(0, lim);
    const tf = st.cpm?.TF?.[id];
    const es = st.cpm?.ES?.[id];
    const ef = st.cpm?.EF?.[id];
    return { id, ES: es, EF: ef, TF: tf, predecessors: top };
}

let cybDG_tooltipEl = null;

function cybDG_ensureTooltip() {
    if (cybDG_tooltipEl) return cybDG_tooltipEl;
    const el = document.createElement("div");
    el.id = "cyb-driving-tooltip";
    el.style.position = "fixed";
    el.style.zIndex = "99999";
    el.style.maxWidth = "520px";
    el.style.background = "rgba(13, 33, 55, 0.96)";
    el.style.color = "#e7f0ff";
    el.style.border = "1px solid rgba(120, 160, 210, 0.35)";
    el.style.borderRadius = "10px";
    el.style.boxShadow = "0 12px 30px rgba(0,0,0,0.35)";
    el.style.padding = "10px 12px";
    el.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Arial";
    el.style.fontSize = "12px";
    el.style.display = "none";
    document.body.appendChild(el);
    cybDG_tooltipEl = el;
    return el;
}

function cybDG_hideTooltip() {
    if (cybDG_tooltipEl) cybDG_tooltipEl.style.display = "none";
}

function cybDG_showTooltipForNode(nodeId, anchorEl = null) {
    try {
        const exp = cybDG_getNodeExplanation(nodeId);
        if (!exp) return;

        const el = cybDG_ensureTooltip();
        const rows = exp.predecessors || [];

        const header = `<div style="font-weight:700;margin-bottom:6px;">
            Driving constraints for <span style="color:var(--cyb-textSecondary, #9fd1ff);">${_psEscHtml(exp.id)}</span>
            <span style="opacity:0.8;font-weight:500;">(TF=${Number.isFinite(exp.TF) ? exp.TF.toFixed(2) : 'n/a'}h)</span>
        </div>`;

        const body = rows.length
            ? `<table style="width:100%;border-collapse:collapse;">
                <thead><tr style="opacity:0.85;">
                    <th style="text-align:left;padding:2px 0;">Pred</th>
                    <th style="text-align:left;padding:2px 0;">Rel</th>
                    <th style="text-align:right;padding:2px 0;">Lag(h)</th>
                    <th style="text-align:right;padding:2px 0;">Δ(h)</th>
                </tr></thead>
                <tbody>
                ${rows.map(r => `
                    <tr style="border-top:1px solid rgba(255,255,255,0.06);">
                        <td style="padding:3px 0;">${_psEscHtml(r.predId)}</td>
                        <td style="padding:3px 0;">${_psEscHtml(r.type)}</td>
                        <td style="padding:3px 0;text-align:right;">${Number.isFinite(r.lagHrs) ? r.lagHrs.toFixed(2) : '0.00'}</td>
                        <td style="padding:3px 0;text-align:right;">${Number.isFinite(r.deltaHrs) ? r.deltaHrs.toFixed(2) : 'n/a'}</td>
                    </tr>`).join("")}
                </tbody>
            </table>`
            : `<div style="opacity:0.8;">No predecessors (start/sink) or no ranking available.</div>`;

        el.innerHTML = header + body;
        el.style.display = "block";

        // Position near cursor/anchor
        let x = 20, y = 20;
        if (anchorEl && anchorEl.getBoundingClientRect) {
            const r = anchorEl.getBoundingClientRect();
            x = Math.min(window.innerWidth - 20, r.right + 10);
            y = Math.min(window.innerHeight - 20, r.top + 10);
        }
        // Clamp
        const rect = el.getBoundingClientRect();
        x = Math.min(x, window.innerWidth - rect.width - 12);
        y = Math.min(y, window.innerHeight - rect.height - 12);
        el.style.left = `${Math.max(8, x)}px`;
        el.style.top = `${Math.max(8, y)}px`;
    } catch (e) {
        console.warn("[DrivingGraphUI] tooltip error", e);
    }
}

/**
 * Bind hover/click handlers to a chain container.
 * Your chain-node elements should include one of:
 *   - data-cy-node-id="<ID>"
 *   - data-node-id="<ID>"
 */
function cybDG_bindTooltips(container) {
    const root = (typeof container === "string") ? document.querySelector(container) : container;
    if (!root) return;

    const sel = "[data-cy-node-id],[data-node-id]";
    const nodes = root.querySelectorAll(sel);
    if (!nodes.length) return;

    nodes.forEach(el => {
        const id = el.getAttribute("data-cy-node-id") || el.getAttribute("data-node-id");
        if (!id) return;

        el.addEventListener("mouseenter", () => cybDG_showTooltipForNode(id, el));
        el.addEventListener("mouseleave", () => cybDG_hideTooltip());
        el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            cybDG_showTooltipForNode(id, el);
        });
    });

    // Click-away closes
    document.addEventListener("click", cybDG_hideTooltip, { once: true });
}

// =========================================================================
// CASCADE SIMULATION — "What if Activity X slips by N days?"
// Deterministic forward-pass propagation from a hypothetically slipped node.
// Uses the existing CPM infrastructure: same link types (FS/SS/FF/SF),
// same lag handling, same topological ordering.
//
// Usage:
//   var result = window.simulateCascade('A1234', 15);
//   result.affectedNodes — array of { id, name, originalEF, newEF, delayDays, group, isCritical, absorbedByFloat }
//   result.newProjectEnd — new project end (hours)
//   result.originalProjectEnd — original project end (hours)
//   result.endDateSlippage — net slippage at project level (hours)
// =========================================================================
function simulateCascade(startNodeId, slipDays, nodesInput, linksInput) {
    var state = window.cybereumState || {};
    var nodes = nodesInput || state.currentNodes || [];
    var links = linksInput || [];

    // If links not provided, reconstruct from succMap edges (handles both Map and Object)
    if (links.length === 0 && state.succMap) {
        var allEdges = [];
        var sm = state.succMap;
        var iterateEntries = function (key) {
            var edgeArr = sm instanceof Map ? sm.get(key) : sm[key];
            if (Array.isArray(edgeArr)) {
                for (var ei = 0; ei < edgeArr.length; ei++) {
                    allEdges.push(edgeArr[ei]);
                }
            }
        };
        if (sm instanceof Map) {
            sm.forEach(function (val, key) { iterateEntries(key); });
        } else {
            var smKeys = Object.keys(sm);
            for (var ki = 0; ki < smKeys.length; ki++) { iterateEntries(smKeys[ki]); }
        }
        links = allEdges;
    }

    if (!nodes.length) {
        return { error: 'No nodes available', affectedNodes: [], newProjectEnd: 0, originalProjectEnd: 0, endDateSlippage: 0 };
    }

    var hoursPerDay = resolveCalendar().hoursPerDay;
    var slipHours = slipDays * hoursPerDay;

    // Build node map and adjacency structures
    var nodeMap = new Map();
    var succMap = new Map();
    var predMap = new Map();

    nodes.forEach(function (n) {
        var id = String(n.ID || n.id);
        // Clone the scheduling fields so we don't mutate originals
        nodeMap.set(id, {
            ID: id,
            Name: n.Name || n.name || id,
            Duration: n.Duration,
            TimeUnits: n.TimeUnits || 'Hours',
            originalES: n.ES,
            originalEF: n.EF,
            originalLS: n.LS,
            originalLF: n.LF,
            slack: n.slack,
            ES: n.ES,
            EF: n.EF,
            LS: n.LS,
            LF: n.LF,
            is_oncriticalpath: n.is_oncriticalpath || n.IsOnCriticalPath || false,
            CommunityGroup: n.CommunityGroup || '',
            WBS_ID: n.WBS_ID || '',
            PercentComplete: n.PercentComplete || 0
        });
        succMap.set(id, []);
        predMap.set(id, []);
    });

    // Build edges
    links.forEach(function (link) {
        var sourceId = String(link.source && link.source.ID ? link.source.ID : (link.source || ''));
        var targetId = String(link.target && link.target.ID ? link.target.ID : (link.target || ''));
        if (!nodeMap.has(sourceId) || !nodeMap.has(targetId)) return;
        if (link.disabled) return;

        var edge = {
            source: sourceId,
            target: targetId,
            type: (link.type || 'FS').toUpperCase(),
            lagHrs: typeof link.lagHrs === 'number' ? link.lagHrs : convertToHours(link.lag || 0, link.lagUnits || link.timeUnits || 'Hours')
        };
        succMap.get(sourceId).push(edge);
        predMap.get(targetId).push(edge);
    });

    // Topological sort (Kahn's algorithm)
    var inDegree = new Map();
    nodeMap.forEach(function (n, id) { inDegree.set(id, 0); });
    predMap.forEach(function (edges, id) { inDegree.set(id, edges.length); });
    var queue = [];
    inDegree.forEach(function (deg, id) { if (deg === 0) queue.push(id); });
    var topoOrder = [];
    // Use an index pointer instead of queue.shift() to keep the sort O(n).
    // queue.shift() is O(n) per call (array reindex); qi++ is O(1).
    // The queue array is bounded by n (each node pushed once), so memory is O(n).
    var qi = 0;
    while (qi < queue.length) {
        var nid = queue[qi++];
        topoOrder.push(nid);
        var succs = succMap.get(nid) || [];
        for (var si = 0; si < succs.length; si++) {
            var tid = succs[si].target;
            inDegree.set(tid, inDegree.get(tid) - 1);
            if (inDegree.get(tid) === 0) queue.push(tid);
        }
    }

    // Record original project end
    var originalProjectEnd = 0;
    nodeMap.forEach(function (n) {
        if (n.EF > originalProjectEnd) originalProjectEnd = n.EF;
    });

    // Apply the slip to the start node
    var startId = String(startNodeId);
    var startNode = nodeMap.get(startId);
    if (!startNode) {
        return { error: 'Node not found: ' + startNodeId, affectedNodes: [], newProjectEnd: originalProjectEnd, originalProjectEnd: originalProjectEnd, endDateSlippage: 0 };
    }
    var duration = getNodeDurationHours(startNode);
    startNode.EF = startNode.originalEF + slipHours;
    startNode.ES = startNode.EF - duration;

    // Forward propagation from the slipped node (process only nodes after it in topo order)
    var startIdx = topoOrder.indexOf(startId);
    var affectedSet = new Set();
    affectedSet.add(startId);

    // If the start node is not present in the topological order, we cannot safely propagate.
    // This typically indicates an invalid graph (e.g., cycles) or mismatched IDs.
    if (startIdx === -1) {
        return { error: 'Start node not in topological order or graph has cycles: ' + startNodeId, affectedNodes: [], newProjectEnd: originalProjectEnd, originalProjectEnd: originalProjectEnd, endDateSlippage: 0 };
    }
    for (var ti = startIdx + 1; ti < topoOrder.length; ti++) {
        var curId = topoOrder[ti];
        var curNode = nodeMap.get(curId);
        var curDuration = getNodeDurationHours(curNode);
        var preds = predMap.get(curId) || [];

        if (preds.length === 0) continue;

        var maxES = 0;
        var isAffected = false;

        for (var pi = 0; pi < preds.length; pi++) {
            var edge = preds[pi];
            var predNode = nodeMap.get(edge.source);
            if (!predNode) continue;

            var candidateES;
            switch (edge.type) {
                case 'FS': candidateES = predNode.EF + edge.lagHrs; break;
                case 'SS': candidateES = predNode.ES + edge.lagHrs; break;
                case 'FF': candidateES = Math.max(0, predNode.EF + edge.lagHrs - curDuration); break;
                case 'SF': candidateES = Math.max(0, predNode.ES + edge.lagHrs - curDuration); break;
                default: candidateES = predNode.EF + edge.lagHrs;
            }

            if (candidateES > maxES) maxES = candidateES;
            if (affectedSet.has(edge.source)) isAffected = true;
        }

        var newES = maxES;
        var newEF = newES + curDuration;

        // Only update if this node is actually pushed later
        if (newEF > curNode.originalEF) {
            curNode.ES = newES;
            curNode.EF = newEF;
            if (isAffected) affectedSet.add(curId);
        }
    }

    // Collect results
    var newProjectEnd = 0;
    nodeMap.forEach(function (n) { if (n.EF > newProjectEnd) newProjectEnd = n.EF; });

    var affectedNodes = [];
    affectedSet.forEach(function (id) {
        var n = nodeMap.get(id);
        if (!n) return;
        var delayHours = n.EF - n.originalEF;
        if (delayHours <= 0 && id !== startId) return; // Not actually delayed

        var absorbedByFloat = false;
        if (n.slack !== undefined && n.slack !== null && n.slack > 0 && delayHours > 0) {
            // slack from calculateSlackWithCalendar_Optimized is LS - ES, same units as ES/EF (hours)
            absorbedByFloat = delayHours <= n.slack;
        }

        affectedNodes.push({
            id: n.ID,
            name: n.Name,
            originalEF: n.originalEF,
            newEF: n.EF,
            delayHours: delayHours,
            delayDays: Math.round(delayHours / hoursPerDay * 10) / 10,
            group: n.WBS_ID || n.CommunityGroup || '',
            isCritical: n.is_oncriticalpath,
            absorbedByFloat: absorbedByFloat,
            percentComplete: n.PercentComplete
        });
    });

    // Sort by delay magnitude descending
    affectedNodes.sort(function (a, b) { return b.delayDays - a.delayDays; });

    return {
        startNode: { id: startNode.ID, name: startNode.Name, slipDays: slipDays },
        affectedNodes: affectedNodes,
        totalAffected: affectedNodes.length,
        newProjectEnd: newProjectEnd,
        originalProjectEnd: originalProjectEnd,
        endDateSlippageHours: newProjectEnd - originalProjectEnd,
        endDateSlippageDays: Math.round((newProjectEnd - originalProjectEnd) / hoursPerDay * 10) / 10,
        hoursPerDay: hoursPerDay
    };
}

// Public surface
window.CybereumDrivingGraph = window.CybereumDrivingGraph || {};
window.CybereumDrivingGraph.extract = extractDrivingGraphPathsFromCPM;
window.CybereumDrivingGraph.explainNode = cybDG_getNodeExplanation;

window.CybereumDrivingGraphUI = window.CybereumDrivingGraphUI || {};
window.CybereumDrivingGraphUI.bind = cybDG_bindTooltips;
window.CybereumDrivingGraphUI.show = cybDG_showTooltipForNode;
window.CybereumDrivingGraphUI.hide = cybDG_hideTooltip;

window.simulateCascade = simulateCascade;
