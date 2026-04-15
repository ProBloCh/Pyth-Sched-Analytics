"""
solver/models.py - Data models for the CADJ-P solver.

Defines configuration, activity parameters, and project context.
No external dependencies beyond numpy.
"""

from dataclasses import dataclass, field
import numpy as np

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

    @classmethod
    def from_dict(cls, d):
        if not d:
            return cls()
        calendar = d.get('calendar', {})
        constraints = d.get('constraints', {})
        return cls(
            hours_per_day=calendar.get('hours_per_day', 8.0),
            working_days=calendar.get('working_days', [1, 2, 3, 4, 5]),
            phase=d.get('phase', 'construction'),
            resource_capacities=d.get('resource_capacities', {'default': 10}),
            max_end_date=constraints.get('max_end_date'),
            max_budget=constraints.get('max_budget'),
        )


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

    ids, durs, rcs, bcosts, rates, crash, risk = [], [], [], [], [], [], []
    for node in nodes:
        aid = str(node.get('ID', node.get('id', '')))
        ids.append(aid)
        dur = float(node.get('Duration', node.get('duration', 1.0)))
        durs.append(dur)

        meta = activity_metadata.get(aid, {})
        rcs.append(_safe_float(meta.get('resource_count', 1.0), 1.0, lo=1.0))
        bcosts.append(_safe_float(meta.get('baseline_cost', dur * 1000.0), dur * 1000.0))
        rates.append(_safe_float(meta.get('resource_rate', 85.0), 85.0))
        crash.append(_safe_float(meta.get('crash_max_fraction', 0.2), 0.2, lo=0.0, hi=1.0))
        risk.append(_safe_float(
            meta.get('combined_risk_score', meta.get('external_risk_score', 0.5)),
            0.5, lo=0.0, hi=10.0))

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
    )
