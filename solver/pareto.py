"""
solver/pareto.py - Pareto frontier generation.

Sweeps weight vectors across the objective simplex using augmented
Tchebycheff scalarisation (via the optimizer's utopia parameter),
which can find solutions on non-convex frontiers.  Non-dominated
sorting is vectorised with numpy.
"""

import logging
import time

import numpy as np

from .dag import build_dag
from .models import SolverConfig, build_activity_params
from .optimizer import optimize

logger = logging.getLogger(__name__)

WALL_TIME_LIMIT = 300  # 5 minutes — safety net for Pareto sweeps


# ---------------------------------------------------------------------------
# Weight vector generation
# ---------------------------------------------------------------------------

def generate_weight_vectors(disciplines, n_vectors=30):
    """Evenly-spaced weight vectors on the probability simplex."""
    k = len(disciplines)
    if k == 1:
        return [{disciplines[0]: 1.0}]

    if k == 2:
        alphas = np.linspace(0.05, 0.95, n_vectors)
        return [{disciplines[0]: float(a), disciplines[1]: float(1.0 - a)}
                for a in alphas]

    # k >= 3: recursive grid on simplex, then subsample
    vectors = []
    steps = max(3, int(np.round(n_vectors ** (1.0 / (k - 1)))))

    def _recurse(dim, remaining_w, current):
        if dim == k - 1:
            current[disciplines[dim]] = round(remaining_w, 6)
            vectors.append(dict(current))
            return
        for i in range(steps + 1):
            w = remaining_w * i / steps
            if w < 0.01 and remaining_w > 0.1:
                continue
            current[disciplines[dim]] = round(w, 6)
            _recurse(dim + 1, remaining_w - w, current)

    _recurse(0, 1.0, {})

    if len(vectors) > n_vectors:
        rng = np.random.default_rng(seed=42)
        idx = rng.choice(len(vectors), size=n_vectors, replace=False)
        vectors = [vectors[i] for i in sorted(idx)]

    return vectors


# ---------------------------------------------------------------------------
# Non-dominated sorting (vectorised)
# ---------------------------------------------------------------------------

def filter_pareto_front(solutions, disciplines):
    """Keep only non-dominated solutions (vectorised numpy)."""
    n = len(solutions)
    if n == 0:
        return []

    obj_matrix = np.array(
        [[s['objectives'][d] for d in disciplines] for s in solutions]
    )
    dominated = np.zeros(n, dtype=bool)

    for i in range(n):
        if dominated[i]:
            continue
        # Check which solutions point i dominates
        diffs = obj_matrix[i] - obj_matrix        # shape (n, k)
        leq = np.all(diffs <= 0, axis=1)           # i <= j everywhere
        strict = np.any(diffs < 0, axis=1)          # i < j somewhere
        newly_dominated = leq & strict
        newly_dominated[i] = False
        dominated |= newly_dominated

    return [s for i, s in enumerate(solutions) if not dominated[i]]


# ---------------------------------------------------------------------------
# Utopia estimation
# ---------------------------------------------------------------------------

def _compute_utopia(nodes, links, activity_metadata, project_ctx, config,
                    deadline):
    """Estimate utopia by optimising each discipline independently."""
    utopia = {}
    for d in config.disciplines:
        if time.time() > deadline:
            break
        dag_state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, activity_metadata)
        quick_cfg = SolverConfig(
            disciplines=[d],
            weights={d: 1.0},
            max_iterations=min(20, config.max_iterations),
            convergence_threshold=config.convergence_threshold,
            learning_rate=config.learning_rate,
        )
        result = optimize(dag_state, params, project_ctx, quick_cfg,
                          deadline=deadline)
        utopia[d] = result['final_objectives'].get(d, 0.0)
    return utopia


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def run_pareto(nodes, links, activity_metadata, project_ctx, config,
               n_vectors=30):
    """
    Sweep weight vectors using augmented Tchebycheff and return
    the Pareto frontier.

    Each weight vector gets a fresh DAG + params to avoid cross-contamination.
    """
    t0 = time.time()
    deadline = t0 + WALL_TIME_LIMIT

    disciplines = config.disciplines

    # Reserve up to 20% of the time budget (max 60s) for utopia estimation
    utopia_deadline = t0 + min(60, WALL_TIME_LIMIT * 0.2)
    utopia = _compute_utopia(nodes, links, activity_metadata, project_ctx,
                             config, utopia_deadline)

    weight_vectors = generate_weight_vectors(disciplines, n_vectors)
    all_solutions = []

    logger.info("Pareto sweep start: %d vectors, %d disciplines, utopia=%s",
                len(weight_vectors), len(disciplines), utopia)

    for idx, wv in enumerate(weight_vectors):
        if time.time() > deadline:
            logger.warning("Pareto sweep hit wall-time limit after %d/%d "
                           "vectors (%.1fs)", idx, len(weight_vectors),
                           time.time() - t0)
            break

        dag_state, _ = build_dag(nodes, links)
        params = build_activity_params(nodes, activity_metadata)

        run_cfg = SolverConfig(
            disciplines=disciplines,
            weights=wv,
            stochastic=False,
            max_iterations=config.max_iterations,
            convergence_threshold=config.convergence_threshold,
            learning_rate=config.learning_rate,
        )

        result = optimize(dag_state, params, project_ctx, run_cfg,
                          deadline=deadline, utopia=utopia)
        all_solutions.append({
            'index':      idx,
            'weights':    wv,
            'objectives': result['final_objectives'],
            'durations':  result['optimized_durations'].tolist(),
            'resources':  result['optimized_resources'].tolist(),
            'converged':  result['converged'],
            'iterations': result['iterations'],
        })

    frontier = filter_pareto_front(all_solutions, disciplines)
    logger.info("Pareto sweep done: %d/%d vectors, %d frontier points, %.1fs",
                len(all_solutions), len(weight_vectors), len(frontier),
                time.time() - t0)

    return {
        'frontier':      frontier,
        'all_solutions': all_solutions,
        'weight_vectors': weight_vectors,
        'n_vectors':  len(weight_vectors),
        'n_frontier': len(frontier),
    }
