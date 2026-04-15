"""
solver/pareto.py - Pareto frontier generation.

Sweeps weight vectors across the objective simplex, runs the optimiser for
each, and filters to non-dominated solutions.
"""

import logging
import numpy as np
from .dag import build_dag
from .models import SolverConfig, build_activity_params
from .optimizer import optimize

logger = logging.getLogger(__name__)


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
# Dominance
# ---------------------------------------------------------------------------

def _dominates(obj_a, obj_b, discs):
    """True if *a* dominates *b* (a <= b everywhere, a < b somewhere)."""
    at_least_one_strict = False
    for d in discs:
        if obj_a[d] > obj_b[d]:
            return False
        if obj_a[d] < obj_b[d]:
            at_least_one_strict = True
    return at_least_one_strict


def filter_pareto_front(solutions, disciplines):
    """Keep only non-dominated solutions."""
    front = []
    for i, si in enumerate(solutions):
        dominated = False
        for j, sj in enumerate(solutions):
            if i != j and _dominates(sj['objectives'], si['objectives'],
                                     disciplines):
                dominated = True
                break
        if not dominated:
            front.append(si)
    return front


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------

def run_pareto(nodes, links, activity_metadata, project_ctx, config,
               n_vectors=30):
    """
    Sweep weight vectors and return Pareto frontier.

    Each weight vector gets a fresh DAG + params to avoid cross-contamination.
    """
    disciplines = config.disciplines
    weight_vectors = generate_weight_vectors(disciplines, n_vectors)
    all_solutions = []

    for idx, wv in enumerate(weight_vectors):
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

        result = optimize(dag_state, params, project_ctx, run_cfg)
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

    return {
        'frontier':      frontier,
        'all_solutions': all_solutions,
        'weight_vectors': weight_vectors,
        'n_vectors':  len(weight_vectors),
        'n_frontier': len(frontier),
    }
