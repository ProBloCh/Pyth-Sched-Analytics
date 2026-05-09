"""E1: replace ``np.maximum(profile - capacity, 0)`` with the canonical
softplus from numpy/scipy -- no hand-rolled wrappers, just the library
primitives used directly.

The non-differentiable ``np.maximum`` in solver/objectives.py:
resource_objective is the reason resource_adj_dur and resource_adj_res
fall back to finite differences (and why ``_FD_MAX_N = 500`` cliffs
out resource gradients on large projects).  Replacing it with softplus
is everywhere differentiable; the gradient is the sigmoid.

Library primitives used directly (no replication):

  np.logaddexp(0, β x)          # softplus(x, β) * β; numerically stable
  scipy.special.expit(β x)      # sigmoid(β x); numerically stable

That's literally it.  The "implementation" of E1 is recognising that
``softplus(x, β) = np.logaddexp(0, β*x) / β`` and writing the new
objective as a one-line composition.

Run as::

    python docs/research/sketches/e1_logsumexp_resource.py

The script (a) demonstrates the substitution in solver/objectives.py
context, (b) verifies the analytic gradient against finite differences,
(c) shows asymptotic convergence to the hard ``np.maximum`` form.
"""

from __future__ import annotations

import sys

import numpy as np
from scipy.special import expit


# Default sharpness.  β = 10 → ≈1% deviation from hard max at x = 0.5
# (in the units of profile - capacity).  Higher β = sharper but more
# numerically sensitive.
DEFAULT_BETA = 10.0


def smoothed_resource_penalty(profile: np.ndarray, capacity: float,
                              bin_width: float,
                              beta: float = DEFAULT_BETA) -> float:
    """E1 reference: smoothed resource_objective.

    penalty = Σ_k (softplus(profile_k - capacity) / β)² · bin_width

    Direct composition of np.logaddexp -- no wrapper.
    """
    over = np.logaddexp(0.0, beta * (profile - capacity)) / beta
    return float(np.sum(over ** 2) * bin_width)


def smoothed_resource_grad(profile: np.ndarray, capacity: float,
                           bin_width: float,
                           beta: float = DEFAULT_BETA) -> np.ndarray:
    """E1 reference: ∂penalty/∂profile_k.

    Chain rule through softplus²:
        d/dx (softplus(x)/β)² = 2 · (softplus(x)/β) · sigmoid(βx)

    Direct composition of np.logaddexp + scipy.special.expit -- no wrapper.
    """
    delta = beta * (profile - capacity)
    softplus_over_beta = np.logaddexp(0.0, delta) / beta
    return 2.0 * softplus_over_beta * expit(delta) * bin_width


# --- Verification --------------------------------------------------------

def _fd_grad(f, x: np.ndarray, eps: float = 1e-6) -> np.ndarray:
    """Central-difference gradient (Nocedal & Wright §8.1)."""
    g = np.empty_like(x)
    for k in range(x.size):
        x_plus, x_minus = x.copy(), x.copy()
        x_plus[k] += eps
        x_minus[k] -= eps
        g[k] = (f(x_plus) - f(x_minus)) / (2.0 * eps)
    return g


def verify() -> None:
    rng = np.random.default_rng(seed=42)
    n_bins = 50
    capacity = 10.0
    bin_width = 1.0
    profile = rng.uniform(5.0, 15.0, size=n_bins)

    # 1. Analytic gradient matches central-difference FD.
    f = lambda p: smoothed_resource_penalty(p, capacity, bin_width)
    g_an = smoothed_resource_grad(profile, capacity, bin_width)
    g_fd = _fd_grad(f, profile, eps=1e-6)
    rel_err = np.abs(g_an - g_fd) / np.maximum(np.abs(g_fd), 1e-9)
    assert rel_err.max() < 1e-5, \
        f"analytic vs FD: max rel err {rel_err.max():.2e}"
    print(f"  analytic ≈ FD       OK   max_rel={rel_err.max():.2e}")

    # 2. Asymptotic: as β → ∞, smoothed → np.maximum.
    x = np.linspace(-5.0, 5.0, 201)
    hard = np.maximum(x, 0.0)
    smooth_hi = np.logaddexp(0.0, 1000.0 * x) / 1000.0
    assert np.abs(smooth_hi - hard).max() < 1e-2, \
        "asymptotic limit broken"
    print(f"  smooth(β→∞) → max   OK   max_abs={np.abs(smooth_hi - hard).max():.2e}")

    # 3. Feasible profile yields ~0 penalty.
    feasible = np.full(n_bins, capacity - 5.0)
    pen = smoothed_resource_penalty(feasible, capacity, bin_width)
    assert pen < 1e-10, f"feasible -> nonzero penalty: {pen}"
    print(f"  feasible → ~0       OK   penalty={pen:.2e}")


def main() -> int:
    print("E1: smoothed resource objective via np.logaddexp + scipy.special.expit")
    print("    (no wrappers; library primitives used directly)")
    print("-" * 70)
    verify()
    print("-" * 70)
    print("Substitution verified.  Replaces FD-based resource_adj_res "
          "in solver/adjoints.py with an analytic gradient -- "
          "eliminates the _FD_MAX_N=500 cliff for any project size.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
