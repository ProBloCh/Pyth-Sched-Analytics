"""
evm - Earned Value Management (EVM) analysis service.

Ports the deterministic computation core of `Reference/EVM.js` (~3,100
LOC) to a backend service.  Produces the same-shaped metrics and
time-phased distributions that the frontend today computes in-browser
and exposes on `window.evmMetrics`.

Scope:
  - Pure math (CPI, SPI, EV/PV/AC, EAC, duration-weighted progress,
    sector overrun, schedule-delay prediction)
  - Cumulative and non-cumulative time-phased distributions
    (forecasted + actual branches)

Explicitly NOT extracted (stays frontend):
  - Chart.js rendering
  - DOM updates (tables, insight panels, tab UI)
  - Event dispatching (`evmInit`)

The backend returns camelCase keys directly -- same shape as the
existing `window.evmMetrics` object -- so the JS wrapper
(Reference/EVM.js async layer) can drop the response in without
any key conversion.  Nothing downstream changes (notably
Completionprediction.js:4871 which reads `.actual.CPIcum`).

Grounding: PMI EVM Practice Standard; sector overrun table derived
from Flyvbjerg et al. Oxford megaproject studies.
"""

from .routes import evm_bp

__all__ = ['evm_bp']
