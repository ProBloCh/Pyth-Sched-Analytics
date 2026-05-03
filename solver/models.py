"""
solver/models.py - Data models for the CADJ-P solver.

Defines configuration, activity parameters, and project context.
No external dependencies beyond numpy.
"""

from dataclasses import dataclass, field
import logging
import numpy as np

logger = logging.getLogger(__name__)

# Phase-dependent default weights (from design doc)
PHASE_WEIGHTS = {
    'planning':      {'schedule': 0.20, 'cost': 0.30, 'risk': 0.25, 'resources': 0.15, 'quality': 0.10},
    'design':        {'schedule': 0.25, 'cost': 0.25, 'risk': 0.20, 'resources': 0.20, 'quality': 0.10},
    'procurement':   {'schedule': 0.30, 'cost': 0.30, 'risk': 0.20, 'resources': 0.15, 'quality': 0.05},
    'construction':  {'schedule': 0.35, 'cost': 0.25, 'risk': 0.20, 'resources': 0.15, 'quality': 0.05},
    'commissioning': {'schedule': 0.40, 'cost': 0.20, 'risk': 0.25, 'resources': 0.10, 'quality': 0.05},
}

ALL_DISCIPLINES = frozenset({'schedule', 'cost', 'risk', 'resources', 'quality'})
DEFAULT_DISCIPLINES = ['schedule', 'cost', 'risk', 'resources', 'quality']


@dataclass
class SolverConfig:
    """Configuration for a single solver run."""
    disciplines: list = field(default_factory=lambda: list(DEFAULT_DISCIPLINES))
    weights: dict = field(default_factory=lambda: dict(PHASE_WEIGHTS['construction']))
    stochastic: bool = False
    monte_carlo_samples: int = 100
    max_iterations: int = 50
    convergence_threshold: float = 0.001
    antithetic_variates: bool = True
    learning_rate: float = 0.01

    @classmethod
    def from_dict(cls, d, phase='construction'):
        """Build from request dict, applying phase-appropriate defaults."""
        if not d:
            d = {}
        disciplines = d.get('disciplines') or list(DEFAULT_DISCIPLINES)
        disciplines = [disc for disc in disciplines if disc in ALL_DISCIPLINES]
        if not disciplines:
            disciplines = list(DEFAULT_DISCIPLINES)

        weights = d.get('weights') or dict(PHASE_WEIGHTS.get(phase, PHASE_WEIGHTS['construction']))
        # Normalize weights to active disciplines so they sum to 1
        active = {k: weights.get(k, 0.0) for k in disciplines}
        total = sum(active.values())
        if total > 0:
            active = {k: v / total for k, v in active.items()}
        else:
            eq = 1.0 / len(disciplines)
            active = {k: eq for k in disciplines}

        return cls(
            disciplines=disciplines,
            weights=active,
            stochastic=d.get('stochastic', False),
            monte_carlo_samples=d.get('monte_carlo_samples', 100),
            max_iterations=d.get('max_iterations', 50),
            convergence_threshold=d.get('convergence_threshold', 0.001),
            antithetic_variates=d.get('antithetic_variates', True),
            learning_rate=d.get('learning_rate', 0.01),
        )


@dataclass
class ActivityParams:
    """Vectorised per-activity parameters.  All arrays share the same index."""
    ids: list                         # original string IDs
    durations: np.ndarray             # current durations  (optimisation variable)
    resource_counts: np.ndarray       # current resources   (optimisation variable)
    baseline_durations: np.ndarray    # original durations  (reference)
    baseline_costs: np.ndarray        # baseline costs
    resource_rates: np.ndarray        # cost per resource per time unit
    crash_max_fractions: np.ndarray   # max fractional reduction in duration
    risk_scores: np.ndarray           # combined risk score per activity
    quality_sensitivities: np.ndarray # how quality degrades with crashing
    activity_types: list = field(default_factory=list)  # supply-chain type per activity

    @property
    def n(self):
        return len(self.ids)

    @property
    def min_durations(self):
        """Hard lower bound on durations after maximum crashing."""
        return self.baseline_durations * (1.0 - self.crash_max_fractions)

    @property
    def crash_fractions(self):
        """Current crash fractions (0 = no crash, 1 = fully crashed)."""
        safe = np.where(self.baseline_durations > 0, self.baseline_durations, 1.0)
        return np.clip(1.0 - self.durations / safe, 0.0, 1.0)


@dataclass
class ProjectContext:
    """Project-level context from the request."""
    hours_per_day: float = 8.0
    working_days: list = field(default_factory=lambda: [1, 2, 3, 4, 5])
    phase: str = 'construction'
    resource_capacities: dict = field(default_factory=lambda: {'default': 10})
    max_end_date: str = None
    max_budget: float = None
    # Resolved numeric constraints in the same time units as the
    # solver's makespan (whatever Duration units the request supplied).
    # Populated by from_dict via _resolve_max_makespan; None means the
    # constraint either wasn't supplied or couldn't be parsed.
    max_makespan: float = None
    start_date: str = None
    holidays: list = field(default_factory=list)

    @classmethod
    def from_dict(cls, d):
        if not d:
            return cls()
        calendar = d.get('calendar', {})
        constraints = d.get('constraints', {})
        start_date = (d.get('start_date')
                      or calendar.get('start_date')
                      or (d.get('project') or {}).get('start_date'))
        max_makespan = _resolve_max_makespan(
            constraints.get('max_makespan'),
            constraints.get('max_end_date'),
            start_date,
            calendar.get('hours_per_day', 8.0),
            calendar.get('working_days', [1, 2, 3, 4, 5]),
        )
        return cls(
            hours_per_day=calendar.get('hours_per_day', 8.0),
            working_days=calendar.get('working_days', [1, 2, 3, 4, 5]),
            phase=d.get('phase', 'construction'),
            resource_capacities=d.get('resource_capacities', {'default': 10}),
            max_end_date=constraints.get('max_end_date'),
            max_budget=_safe_constraint(constraints.get('max_budget')),
            max_makespan=max_makespan,
            start_date=start_date,
            holidays=calendar.get('holidays') or [],
        )


def _safe_constraint(value):
    """Coerce a constraint value to a positive float, else None."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(v) or v <= 0:
        return None
    return v


def _resolve_max_makespan(max_makespan_raw, max_end_date_raw, start_date_raw,
                          hours_per_day, working_days):
    """Resolve a numeric max_makespan in the solver's time units.

    Priority:
      1. Explicit numeric ``constraints.max_makespan`` (already in solver
         time units; the unambiguous form).
      2. Numeric ``constraints.max_end_date`` (treated as time units;
         backward-compatible with callers that passed a number here).
      3. ISO ``constraints.max_end_date`` plus an ISO project ``start_date``:
         convert the calendar-day difference to working hours using the
         supplied hours_per_day and working_days_per_week.

    Returns None when no resolution is possible -- the optimizer then
    skips that constraint silently (the analysis layer surfaces
    unresolved constraints separately so callers can detect mis-config).
    """
    direct = _safe_constraint(max_makespan_raw)
    if direct is not None:
        return direct
    direct = _safe_constraint(max_end_date_raw)
    if direct is not None:
        return direct
    if max_end_date_raw is None or start_date_raw is None:
        return None
    try:
        from datetime import datetime, timezone
        end = datetime.fromisoformat(
            str(max_end_date_raw).replace('Z', '+00:00'))
        start = datetime.fromisoformat(
            str(start_date_raw).replace('Z', '+00:00'))
        # Normalise to UTC: naive -> assume UTC, aware -> convert.
        # Without this, mixing tz-aware ('2026-12-31Z') with naive
        # ('2026-01-05') would raise outside the try/except via
        # `end - start`.  Matches evm.helpers.safe_date convention.
        end = (end if end.tzinfo is not None
               else end.replace(tzinfo=timezone.utc))
        start = (start if start.tzinfo is not None
                 else start.replace(tzinfo=timezone.utc))
    except (TypeError, ValueError):
        return None
    cal_days = (end - start).total_seconds() / 86400.0
    if cal_days <= 0:
        return None
    wd_count = len([d for d in (working_days or [])
                    if isinstance(d, (int, float))]) or 5
    working_hours = cal_days * (wd_count / 7.0) * float(hours_per_day or 8.0)
    return working_hours if working_hours > 0 else None


def _safe_float(value, default, lo=0.0, hi=1e12):
    """Convert to float, clamping to [lo, hi] and replacing NaN/Inf."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return float(default)
    if not np.isfinite(v):
        return float(default)
    return max(lo, min(v, hi))


def build_activity_params(nodes, activity_metadata):
    """Construct ActivityParams from request nodes + metadata dicts."""
    if not activity_metadata:
        activity_metadata = {}

    # Rate-limited per-call so the "suppressed for this build" message
    # below is accurate.  A module-global flag would silence diagnostics
    # for every subsequent build in the process after the first
    # malformed input, which is both misleading and unhelpful.
    dur_warned = {'emitted': False}

    ids, durs, rcs, bcosts, rates, crash, risk, atypes = (
        [], [], [], [], [], [], [], [])
    for node in nodes:
        aid = str(node.get('ID', node.get('id', '')))
        ids.append(aid)
        dur_raw = node.get('Duration', node.get('duration', 1.0))
        # Explicit milestone sentinels -> 0 silently.
        if dur_raw in ('', None, 0, 0.0, '0'):
            dur = 0.0
        else:
            try:
                dur = float(dur_raw)
            except (TypeError, ValueError):
                # Malformed (non-numeric, non-sentinel) Duration:
                # log once per build with the node ID so field
                # diagnostics can find "Duration = 'abc'" rather than
                # the silently-zero activity it would otherwise
                # become.
                if not dur_warned['emitted']:
                    logger.warning(
                        "build_activity_params: node id=%s has non-numeric "
                        "Duration=%r; treating as zero (further warnings "
                        "suppressed for this build).", aid, dur_raw)
                    dur_warned['emitted'] = True
                dur = 0.0
        durs.append(dur)

        meta = activity_metadata.get(aid, {})
        rcs.append(_safe_float(meta.get('resource_count', 1.0), 1.0, lo=1.0))
        bcosts.append(_safe_float(meta.get('baseline_cost', dur * 1000.0), dur * 1000.0))
        rates.append(_safe_float(meta.get('resource_rate', 85.0), 85.0))
        crash.append(_safe_float(meta.get('crash_max_fraction', 0.2), 0.2, lo=0.0, hi=1.0))
        risk.append(_safe_float(
            meta.get('combined_risk_score', meta.get('external_risk_score', 0.5)),
            0.5, lo=0.0, hi=10.0))
        atypes.append(str(meta.get(
            'activity_type', meta.get(
                'supply_chain_type', node.get('TaskType', 'standard'))
        )).lower())

    durs_arr = np.array(durs, dtype=np.float64)
    return ActivityParams(
        ids=ids,
        durations=durs_arr.copy(),
        resource_counts=np.array(rcs, dtype=np.float64),
        baseline_durations=durs_arr.copy(),
        baseline_costs=np.array(bcosts, dtype=np.float64),
        resource_rates=np.array(rates, dtype=np.float64),
        crash_max_fractions=np.array(crash, dtype=np.float64),
        risk_scores=np.array(risk, dtype=np.float64),
        quality_sensitivities=np.ones(len(ids), dtype=np.float64),
        activity_types=atypes,
    )
