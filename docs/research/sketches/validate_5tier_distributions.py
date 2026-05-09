"""Validate the hand-rolled distribution PPFs in solver/stochastic.py
against the canonical scipy.stats implementations.

Why this exists
---------------
The 5-tier risk model in solver/stochastic.py uses four hand-rolled
inverse-CDF (PPF) functions:

    _triangular_ppf   -- our piecewise sqrt formula
    _bs_ppf           -- Birnbaum-Saunders, z-parameterised for
                         hot-path reuse
    _pareto_ppf       -- Pareto Type I with x_min=1
    _lognormal_ppf    -- lognormal with mu, sigma

scipy provides canonical, well-tested implementations of all four.
Our hand-rolled versions exist for vectorisation efficiency (avoiding
scipy's per-call object overhead in the MC hot path) and z-cached
reuse.  This sketch confirms the hand-rolled functions are
*mathematically equivalent* to scipy's to ~1e-10 relative tolerance
across the full u ∈ (0, 1) domain.

Run as::

    python docs/research/sketches/validate_5tier_distributions.py

Failure of any assertion below is a real bug in the production MC
loop -- the distributions deviate from peer-reviewed canonical forms.

Trusted-source pulls used:
    scipy.stats.triang        -- triangular distribution
    scipy.stats.fatiguelife   -- Birnbaum-Saunders distribution
    scipy.stats.pareto        -- Pareto Type I
    scipy.stats.lognorm       -- lognormal distribution
    scipy.special.ndtri       -- inverse standard-normal CDF
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy import stats
from scipy.special import ndtri

# Import the hand-rolled PPFs from solver/stochastic.py
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from solver.stochastic import (  # noqa: E402
    _bs_ppf,
    _bs_ppf_z,
    _lognormal_ppf,
    _lognormal_ppf_z,
    _pareto_ppf,
    _triangular_ppf,
)


# Probe across the open unit interval; clip at the edges to avoid
# infinity/NaN from the heavy-tailed Pareto.
U_PROBE = np.linspace(1e-4, 1.0 - 1e-4, 5_000)
RTOL = 1e-10
ATOL = 1e-12


def validate_triangular() -> None:
    """Hand-rolled vs scipy.stats.triang."""
    n = U_PROBE.size
    low = np.full(n, 1.0)
    mode = np.full(n, 1.5)
    high = np.full(n, 3.0)

    ours = _triangular_ppf(U_PROBE, low, mode, high)
    # scipy parameterisation: c = (mode - loc) / scale, loc = low, scale = high - low
    c = (mode[0] - low[0]) / (high[0] - low[0])
    theirs = stats.triang.ppf(U_PROBE, c=c, loc=low[0], scale=high[0] - low[0])

    np.testing.assert_allclose(ours, theirs, rtol=RTOL, atol=ATOL)
    print(f"  triangular     OK  max_abs_err={np.abs(ours - theirs).max():.2e}")


def validate_birnbaum_saunders() -> None:
    """Hand-rolled vs scipy.stats.fatiguelife (canonical BS)."""
    alpha = 0.5
    beta = 1.2

    ours = _bs_ppf(U_PROBE, alpha, beta)
    # scipy parameterisation: c = alpha, scale = beta, loc = 0
    theirs = stats.fatiguelife.ppf(U_PROBE, c=alpha, scale=beta)

    np.testing.assert_allclose(ours, theirs, rtol=RTOL, atol=ATOL)
    print(f"  BS (alpha=0.5) OK  max_abs_err={np.abs(ours - theirs).max():.2e}")

    # Also validate the z-parameterised variant -- the hot-path form.
    z = ndtri(U_PROBE)
    ours_z = _bs_ppf_z(z, alpha, beta)
    np.testing.assert_allclose(ours_z, theirs, rtol=RTOL, atol=ATOL)
    print(f"  BS via z-param OK  max_abs_err={np.abs(ours_z - theirs).max():.2e}")


def validate_pareto() -> None:
    """Hand-rolled vs scipy.stats.pareto (Type I, x_min=1)."""
    for alpha in (1.5, 2.0, 2.35, 3.0):
        ours = _pareto_ppf(U_PROBE, alpha)
        # scipy.stats.pareto with b=alpha matches our x_min=1 formulation.
        theirs = stats.pareto.ppf(U_PROBE, b=alpha)
        np.testing.assert_allclose(ours, theirs, rtol=RTOL, atol=ATOL)
        print(f"  Pareto α={alpha:<4}  OK  "
              f"max_abs_err={np.abs(ours - theirs).max():.2e}")


def validate_lognormal() -> None:
    """Hand-rolled vs scipy.stats.lognorm."""
    sigma = 0.25
    mu = 0.0

    ours = _lognormal_ppf(U_PROBE, sigma=sigma, mu=mu)
    # scipy parameterisation: s = sigma, scale = exp(mu), loc = 0
    theirs = stats.lognorm.ppf(U_PROBE, s=sigma, scale=np.exp(mu))

    np.testing.assert_allclose(ours, theirs, rtol=RTOL, atol=ATOL)
    print(f"  lognormal       OK  max_abs_err={np.abs(ours - theirs).max():.2e}")

    z = ndtri(U_PROBE)
    ours_z = _lognormal_ppf_z(z, sigma=sigma, mu=mu)
    np.testing.assert_allclose(ours_z, theirs, rtol=RTOL, atol=ATOL)
    print(f"  lognormal via z OK  max_abs_err={np.abs(ours_z - theirs).max():.2e}")


def main() -> int:
    print("Validating hand-rolled PPFs against scipy canonical forms")
    print("rtol=", RTOL, "atol=", ATOL, "n_probe=", U_PROBE.size)
    print("-" * 60)
    validate_triangular()
    validate_birnbaum_saunders()
    validate_pareto()
    validate_lognormal()
    print("-" * 60)
    print("All distributions agree with scipy canonical forms.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
