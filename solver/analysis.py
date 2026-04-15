"""
solver/analysis.py - Conflict, synergy, and intervention analysis.

Analyses gradient alignment between objective pairs (cosine similarity)
and ranks activities by multi-objective improvement potential.
"""

import numpy as np


def analyze_conflicts_and_synergies(gradients, disciplines, params):
    """
    Detect conflicts (opposing gradients) and synergies (aligned gradients)
    between every pair of objectives using cosine similarity on the duration
    gradient vectors.

    Returns list of {pair, cosine_similarity, relationship, description}.
    """
    disc_list = list(disciplines)
    results = []

    for i in range(len(disc_list)):
        for j in range(i + 1, len(disc_list)):
            d1, d2 = disc_list[i], disc_list[j]
            if d1 not in gradients or d2 not in gradients:
                continue

            g1 = gradients[d1]['duration']
            g2 = gradients[d2]['duration']
            n1, n2 = np.linalg.norm(g1), np.linalg.norm(g2)

            if n1 < 1e-12 or n2 < 1e-12:
                cos = 0.0
            else:
                cos = float(np.dot(g1, g2) / (n1 * n2))

            if cos > 0.3:
                rel  = 'synergy'
                desc = f'{d1} and {d2} improvements are aligned'
            elif cos < -0.3:
                rel  = 'conflict'
                desc = f'{d1} and {d2} improvements oppose each other'
            else:
                rel  = 'independent'
                desc = f'{d1} and {d2} are largely independent'

            results.append({
                'pair': [d1, d2],
                'cosine_similarity': round(cos, 4),
                'relationship': rel,
                'description': desc,
            })

    return results


def rank_interventions(gradients, config, params):
    """
    Rank activities by weighted gradient magnitude across all disciplines.
    High-magnitude activities are the highest-leverage interventions.

    Returns list of {activity_id, rank, score, normalised_score,
                     per_discipline, recommendation}.
    """
    n = params.n
    disciplines = config.disciplines
    weights = config.weights

    scores   = np.zeros(n, dtype=np.float64)
    per_disc = {d: np.zeros(n, dtype=np.float64) for d in disciplines}

    for d in disciplines:
        if d not in gradients:
            continue
        w = weights.get(d, 0.0)
        combined = np.abs(gradients[d]['duration']) + \
                   np.abs(gradients[d]['resources'])
        per_disc[d] = combined
        scores += w * combined

    ranking = np.argsort(-scores)
    max_s = max(float(np.max(scores)), 1e-12) if n > 0 else 1.0

    results = []
    for rank, idx in enumerate(ranking):
        idx = int(idx)
        norm = float(scores[idx] / max_s)
        if norm > 0.7:
            rec = 'high_priority'
        elif norm > 0.3:
            rec = 'moderate_priority'
        else:
            rec = 'low_priority'

        results.append({
            'activity_id':     params.ids[idx],
            'rank':            rank + 1,
            'score':           round(float(scores[idx]), 6),
            'normalized_score': round(norm, 4),
            'per_discipline':  {d: round(float(per_disc[d][idx]), 6)
                                for d in disciplines},
            'recommendation':  rec,
        })

    return results


def compute_analysis(gradients, config, params):
    """Full analysis bundle: conflicts/synergies + intervention ranking."""
    return {
        'conflicts_and_synergies': analyze_conflicts_and_synergies(
            gradients, config.disciplines, params,
        ),
        'interventions': rank_interventions(gradients, config, params),
    }
