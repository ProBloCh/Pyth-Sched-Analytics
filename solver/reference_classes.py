"""
solver/reference_classes.py - Per-sector empirical calibration table for
the five-tier risk-distribution Monte Carlo.

Each entry encodes published empirical findings on the SHAPE of capital
project cost / schedule overrun distributions for a specific sector.
The values feed two distinct mechanisms:

  1. Tier model selection in solver.stochastic._compute_raw_multipliers:
     - fat_tail_from / pareto_offset shift the BS and Pareto thresholds
       so each sector's tier 4 / tier 5 windows reflect its empirical
       fat-tail risk.
     - tier_4_distribution = 'birnbaum_saunders' (the historic default,
       Natarajan-validated for offshore O&G), 'lognormal' (thin-tailed
       sectors per Flyvbjerg & Gardner 2023 -- roads, solar, batteries),
       or 'skip' (alpha <= 1 regimes -- IT, Olympics -- where BS cannot
       represent infinite mean and Pareto must take over directly).
     - pareto_alpha_range clamps the Pareto power-law alpha per sector
       (lower alpha = fatter tail, finer-grained than the global
       2.0 + 1.5 * (1 - r) formula used when no class is selected).
     - max_multiplier_cap replaces the global 6x / 10x cap (a single
       activity in nuclear new build can run 20x; Olympics / IT can
       run 50x or more).

  2. Output percentile calibration (post-MC) in
     completion.monte_carlo: reported P50/P80/P95/P99 finish dates can
     be optionally scaled by sector-specific factors derived from
     Flyvbjerg / Sovacool / Cantarelli / TII reference-class tables to
     produce empirically-honest percentiles alongside the raw model
     output.

CRITICAL CAVEATS
----------------
- Per-class fitted Pareto alpha values are not all in the public
  literature.  The agent that compiled this table extracted the
  defensible numbers and marked judgement calls explicitly in
  citations.  When the Aaen et al. PMJ 2025 paper's Table 4 becomes
  available, the alpha ranges and BS thresholds should be updated.
- For IT (alpha <= 1) and Olympics (also alpha <= 1, Oxford 2024),
  the published guidance is that ANY single percentile is unstable.
  Reporting a P99 is a policy choice not an empirical measurement.
- Data centres / hyperscale have no peer-reviewed distribution fit
  yet; values are calibrated to JLL 2026 / Turner & Townsend 2025 /
  Allianz 2024 practitioner reports and marked as judgement.

Sources are cited per row.  Full bibliography at the bottom of this
file.
"""

from __future__ import annotations

import copy
import difflib
import json
import logging
import math
import os

logger = logging.getLogger(__name__)


# Sentinel for "not a real percentile, the reference class has formally
# infinite variance / mean".  Consumers should display a cap warning.
INFINITE = float('inf')

# Allowed tier-4 distribution values.  'skip' is preserved as a
# back-compat alias for 'direct_normal_to_pareto' (the explicit name
# describes the actual semantics: BS is bypassed and the normal tier
# extends directly to a low-alpha Pareto, used for alpha <= 1 regimes
# like IT and Olympics).
_TIER_4_VALID = frozenset({
    'birnbaum_saunders', 'lognormal',
    'direct_normal_to_pareto', 'skip',
})

# Required keys on every class definition
_REQUIRED_KEYS = (
    'fat_tail_from', 'pareto_offset', 'pareto_alpha_range',
    'tier_4_distribution', 'percentile_factors',
    'max_multiplier_cap',
)

# Optional keys we recognise (others are silently dropped to keep the
# schema closed; surfaced in validation as a warning, not an error).
_OPTIONAL_KEYS = (
    'mean_overrun', 'is_fat_tailed', 'has_finite_mean', 'citations',
    'version', 'last_updated', 'source',
)

_PERCENTILE_KEYS = ('P50', 'P80', 'P95', 'P99')


# ---------------------------------------------------------------------------
# 21-class reference table
# ---------------------------------------------------------------------------

REFERENCE_CLASS_TIERS = {
    # =====================================================================
    # OIL & GAS
    # =====================================================================
    'oil_gas_offshore': {
        'fat_tail_from':       0.55,
        'pareto_offset':       0.25,
        'pareto_alpha_range':  (1.8, 2.5),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.10, 'P80': 1.30, 'P95': 1.55, 'P99': 2.00},
        'max_multiplier_cap':  10.0,
        'mean_overrun':        0.40,    # ~30-50% per Natarajan + practice
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'Natarajan, PMJ 2022 (Birnbaum-Saunders, KS p=0.89, n offshore O&G)',
            'Flyvbjerg & Gardner 2023, "How Big Things Get Done" appendix',
        ],
    },
    'oil_gas_onshore_lng': {
        'fat_tail_from':       0.60,
        'pareto_offset':       0.25,
        'pareto_alpha_range':  (2.0, 2.7),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.05, 'P80': 1.20, 'P95': 1.40, 'P99': 1.75},
        'max_multiplier_cap':  8.0,
        'mean_overrun':        0.20,
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'Flyvbjerg & Gardner 2023; Bain & Co Energy Transition 2024',
        ],
    },

    # =====================================================================
    # NUCLEAR
    # =====================================================================
    'nuclear_new_build': {
        'fat_tail_from':       0.40,
        'pareto_offset':       0.20,
        'pareto_alpha_range':  (1.4, 2.0),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.35, 'P80': 1.85, 'P95': 2.80, 'P99': 5.00},
        'max_multiplier_cap':  20.0,    # Vogtle / Olkiluoto / Hinkley scale
        'mean_overrun':        1.173,   # 117.3% per Sovacool & Gilbert
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'Sovacool & Gilbert 2014 (n=401 electricity projects, mean 117.3%)',
            'INL Digital Library 2024 update (n=662 across 7 countries)',
            'Flyvbjerg & Gardner 2023 (one of the most fat-tailed sectors)',
        ],
    },
    'nuclear_decommissioning': {
        'fat_tail_from':       0.35,
        'pareto_offset':       0.15,
        'pareto_alpha_range':  (1.2, 1.8),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.50, 'P80': 2.20, 'P95': 4.00, 'P99': 8.00},
        'max_multiplier_cap':  30.0,
        'mean_overrun':        1.50,    # judgement: highest non-IT mean per HBTGD
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'Flyvbjerg & Gardner 2023 (nuclear storage classified most fat-tailed)',
            'JUDGEMENT: alpha range interpolated; PMJ 2025 Aaen Table 4 has the fitted value',
        ],
    },

    # =====================================================================
    # TRANSPORT / INFRASTRUCTURE
    # =====================================================================
    'rail': {
        'fat_tail_from':       0.55,
        'pareto_offset':       0.30,
        'pareto_alpha_range':  (2.0, 2.8),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.15, 'P80': 1.45, 'P95': 1.95, 'P99': 3.00},
        'max_multiplier_cap':  10.0,
        'mean_overrun':        0.45,
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'Cantarelli et al. (Dutch + international rail, mean 45%)',
            'TII Reference Class Forecasting Guidelines for National Roads/Rail',
            'UK DfT TAG Unit M4 / A1.2 (May 2025)',
        ],
    },
    'tunnels': {
        'fat_tail_from':       0.50,
        'pareto_offset':       0.25,
        'pareto_alpha_range':  (1.8, 2.5),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.20, 'P80': 1.55, 'P95': 2.30, 'P99': 3.80},
        'max_multiplier_cap':  12.0,
        'mean_overrun':        0.50,
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'MDPI Infrastructures 5(9):73 2020 (geological tail)',
            'Springer Geotech Geol Eng 2023 (double-Pareto-lognormal)',
        ],
    },
    'bridges_fixed_links': {
        'fat_tail_from':       0.60,
        'pareto_offset':       0.30,
        'pareto_alpha_range':  (2.2, 3.0),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.10, 'P80': 1.35, 'P95': 1.75, 'P99': 2.50},
        'max_multiplier_cap':  8.0,
        'mean_overrun':        0.34,
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'Cantarelli (fixed links 34% intl, 21.7% Dutch)',
        ],
    },
    'roads': {
        'fat_tail_from':       0.75,    # not fat-tailed per HBTGD
        'pareto_offset':       0.20,
        'pareto_alpha_range':  (2.5, 3.5),
        'tier_4_distribution': 'lognormal',
        'percentile_factors':  {'P50': 1.05, 'P80': 1.20, 'P95': 1.40, 'P99': 1.70},
        'max_multiplier_cap':  5.0,
        'mean_overrun':        0.20,
        'is_fat_tailed':       False,
        'has_finite_mean':     True,
        'citations': [
            'Cantarelli (mean 20%)',
            'Flyvbjerg & Gardner 2023 (classified non-fat-tailed)',
        ],
    },

    # =====================================================================
    # BUILDINGS
    # =====================================================================
    'buildings_standard': {
        'fat_tail_from':       0.70,
        'pareto_offset':       0.25,
        'pareto_alpha_range':  (2.5, 3.5),
        'tier_4_distribution': 'lognormal',
        'percentile_factors':  {'P50': 1.05, 'P80': 1.20, 'P95': 1.35, 'P99': 1.65},
        'max_multiplier_cap':  5.0,
        'mean_overrun':        0.13,
        'is_fat_tailed':       False,
        'has_finite_mean':     True,
        'citations': [
            'HM Treasury Green Book Optimism Bias (standard buildings 2-24%)',
        ],
    },
    'buildings_nonstandard': {
        'fat_tail_from':       0.55,
        'pareto_offset':       0.25,
        'pareto_alpha_range':  (1.9, 2.6),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.15, 'P80': 1.45, 'P95': 1.85, 'P99': 2.50},
        'max_multiplier_cap':  8.0,
        'mean_overrun':        0.30,
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'HM Treasury Green Book Optimism Bias (non-standard buildings up to 51%)',
        ],
    },

    # =====================================================================
    # DEFENSE
    # =====================================================================
    'defense_mdap': {
        'fat_tail_from':       0.50,
        'pareto_offset':       0.20,
        'pareto_alpha_range':  (1.7, 2.4),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.20, 'P80': 1.55, 'P95': 2.15, 'P99': 3.50},
        'max_multiplier_cap':  12.0,
        'mean_overrun':        0.33,
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'GAO Defense Acquisitions: Assessments of Selected Weapon Programs',
            'CSIS 2010/2011 (cost & schedule overruns 98 MDAPs)',
            'RAND tail-distribution studies',
        ],
    },

    # =====================================================================
    # IT / SOFTWARE  --  alpha <= 1 (infinite mean & variance)
    # =====================================================================
    'it_software': {
        'fat_tail_from':       0.30,    # short / nonexistent BS bridge
        'pareto_offset':       0.05,    # Pareto kicks in almost immediately
        'pareto_alpha_range':  (0.8, 1.5),
        'tier_4_distribution': 'direct_normal_to_pareto',  # straight from normal to Pareto
        'percentile_factors':  {'P50': 1.15, 'P80': 1.50, 'P95': 2.50, 'P99': INFINITE},
        'max_multiplier_cap':  50.0,
        'mean_overrun':        4.47,    # 447% in the tail; 18% exceed +50%
        'is_fat_tailed':       True,
        'has_finite_mean':     False,
        'citations': [
            'Flyvbjerg, Budzier, Lee, Keil, Lunn, Bester JMIS 39(3) 2022 (n=5,392, alpha <= 1)',
            'Flyvbjerg, Budzier, Aaen, Keil, Zottoli PMJ 2025/26 (cross-group alpha taxonomy)',
        ],
    },

    # =====================================================================
    # OLYMPICS / MEGA EVENTS  --  alpha <= 1, "regression to the tail"
    # =====================================================================
    'olympics': {
        'fat_tail_from':       0.20,
        'pareto_offset':       0.05,
        'pareto_alpha_range':  (0.9, 1.4),
        'tier_4_distribution': 'direct_normal_to_pareto',
        'percentile_factors':  {'P50': 1.50, 'P80': 2.40, 'P95': 4.50, 'P99': INFINITE},
        'max_multiplier_cap':  50.0,
        'mean_overrun':        1.72,    # 172% per Oxford Olympics Study 2024
        'is_fat_tailed':       True,
        'has_finite_mean':     False,
        'citations': [
            'Budzier & Flyvbjerg, Oxford Olympics Study 2024 (ArXiv 2406.01714, mean 172%)',
        ],
    },

    # =====================================================================
    # MINING
    # =====================================================================
    'mining': {
        'fat_tail_from':       0.50,
        'pareto_offset':       0.25,
        'pareto_alpha_range':  (1.8, 2.5),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.20, 'P80': 1.55, 'P95': 2.25, 'P99': 3.75},
        'max_multiplier_cap':  10.0,
        'mean_overrun':        0.62,
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'EY 2015 (mean 62%)',
            'McKinsey Metals & Mining 2024 (83% > +40%)',
            'Bain 2024 (recent 15-20%)',
            'ScienceDirect S030142072500296X (n=256/202 mining 1994-2020)',
        ],
    },

    # =====================================================================
    # RENEWABLES / ENERGY TRANSITION
    # =====================================================================
    'solar_pv': {
        'fat_tail_from':       0.85,    # not fat-tailed
        'pareto_offset':       0.10,
        'pareto_alpha_range':  (3.0, 4.0),
        'tier_4_distribution': 'lognormal',
        'percentile_factors':  {'P50': 1.00, 'P80': 1.10, 'P95': 1.20, 'P99': 1.35},
        'max_multiplier_cap':  3.0,
        'mean_overrun':        0.05,    # often under-budget
        'is_fat_tailed':       False,
        'has_finite_mean':     True,
        'citations': [
            'Flyvbjerg & Gardner 2023 (solar non-fat-tailed)',
            'IRENA Renewable Power Generation Costs 2024',
            'NREL ATB 2024',
        ],
    },
    'wind_onshore': {
        'fat_tail_from':       0.85,
        'pareto_offset':       0.10,
        'pareto_alpha_range':  (3.0, 4.0),
        'tier_4_distribution': 'lognormal',
        'percentile_factors':  {'P50': 1.00, 'P80': 1.10, 'P95': 1.20, 'P99': 1.35},
        'max_multiplier_cap':  3.0,
        'mean_overrun':        0.08,
        'is_fat_tailed':       False,
        'has_finite_mean':     True,
        'citations': [
            'Flyvbjerg & Gardner 2023 (onshore wind non-fat-tailed)',
            'IRENA 2024',
        ],
    },
    'wind_offshore': {
        'fat_tail_from':       0.60,
        'pareto_offset':       0.25,
        'pareto_alpha_range':  (2.0, 2.7),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.10, 'P80': 1.30, 'P95': 1.55, 'P99': 2.00},
        'max_multiplier_cap':  6.0,
        'mean_overrun':        0.20,
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'IRENA 2024 (offshore costs flat vs declining onshore)',
            'Lazard LCOE+ 2024',
        ],
    },
    'battery_storage': {
        'fat_tail_from':       0.85,
        'pareto_offset':       0.10,
        'pareto_alpha_range':  (3.0, 4.0),
        'tier_4_distribution': 'lognormal',
        'percentile_factors':  {'P50': 1.00, 'P80': 1.10, 'P95': 1.20, 'P99': 1.35},
        'max_multiplier_cap':  3.0,
        'mean_overrun':        0.05,
        'is_fat_tailed':       False,
        'has_finite_mean':     True,
        'citations': [
            'NREL Cost Projections fy25osti/93281 (2025)',
            'JUDGEMENT: thin sample post-2020 grid scale; treat conservatively',
        ],
    },

    # =====================================================================
    # DATA CENTRES / HYPERSCALE  --  no peer-reviewed distribution fit
    # =====================================================================
    'data_centre_hyperscale': {
        'fat_tail_from':       0.55,
        'pareto_offset':       0.25,
        'pareto_alpha_range':  (1.9, 2.6),
        'tier_4_distribution': 'birnbaum_saunders',
        'percentile_factors':  {'P50': 1.10, 'P80': 1.40, 'P95': 1.85, 'P99': 2.75},
        'max_multiplier_cap':  8.0,
        'mean_overrun':        0.30,
        'is_fat_tailed':       True,
        'has_finite_mean':     True,
        'citations': [
            'JLL 2026 Global Data Center Outlook',
            'Turner & Townsend Data Centre Construction Cost Index 2025',
            'Allianz Commercial Data Center Construction Risks 2024',
            'JUDGEMENT: no peer-reviewed distribution fit yet',
        ],
    },
}


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------

# Aliases for convenience / backwards compat with EVM sector names.
# Module-level so callers can extend (e.g. ops adding a new alias for
# a customer's internal taxonomy without touching every dict entry).
ALIASES = {
    'oil_and_gas': 'oil_gas_offshore',
    'oil_gas': 'oil_gas_offshore',
    'lng': 'oil_gas_onshore_lng',
    'petrochemical': 'oil_gas_onshore_lng',
    'petrochem': 'oil_gas_onshore_lng',
    'nuclear': 'nuclear_new_build',
    'nuclear_energy': 'nuclear_new_build',
    'infrastructure': 'rail',
    'epc': 'rail',
    'civil': 'rail',
    'transportation': 'rail',
    'construction': 'buildings_standard',
    'commercial': 'buildings_standard',
    'buildings': 'buildings_standard',
    'industrial': 'buildings_nonstandard',
    'defense': 'defense_mdap',
    'government': 'defense_mdap',
    'federal': 'defense_mdap',
    'military': 'defense_mdap',
    'technology': 'it_software',
    'software': 'it_software',
    'it': 'it_software',
    'data_centre': 'data_centre_hyperscale',
    'data_center': 'data_centre_hyperscale',
    'datacentre': 'data_centre_hyperscale',
    'datacenter': 'data_centre_hyperscale',
    'hyperscale': 'data_centre_hyperscale',
}


def _normalise_name(name):
    """Case- / separator-insensitive key form.  Used for both registry
    lookup and alias resolution."""
    if name is None:
        return None
    return (str(name).lower().strip()
            .replace(' ', '_').replace('-', '_')
            .replace('&', '_and_'))


def get_reference_class(name, registry=None):
    """Resolve a class name (with case / alias / fuzzy tolerance).

    Lookup order:
      1. exact match in registry (defaults to REFERENCE_CLASS_TIERS)
      2. normalised key in registry
      3. normalised key in ALIASES -> canonical name in registry

    Returns None when no match -- callers should treat that as
    "use the global default tier model".  Use ``suggest_reference_class``
    for a near-match suggestion when you want to give the user feedback.
    """
    if name is None:
        return None
    reg = registry if registry is not None else REFERENCE_CLASS_TIERS
    if isinstance(name, str) and name in reg:
        return reg[name]
    key = _normalise_name(name)
    if key is None:
        return None
    if key in reg:
        return reg[key]
    if key in ALIASES and ALIASES[key] in reg:
        return reg[ALIASES[key]]
    return None


def suggest_reference_class(name, registry=None, n=3, cutoff=0.5):
    """Return up to *n* close-match suggestions for an unknown name.

    Uses difflib's ratio over both canonical names and aliases so a
    typo or stale alias gets a useful "did you mean?" list.
    """
    if name is None:
        return []
    reg = registry if registry is not None else REFERENCE_CLASS_TIERS
    candidates = list(reg.keys()) + list(ALIASES.keys())
    key = _normalise_name(name) or ''
    matches = difflib.get_close_matches(key, candidates, n=n, cutoff=cutoff)
    # Resolve any matched aliases to their canonical names; dedupe.
    out, seen = [], set()
    for m in matches:
        canon = ALIASES.get(m, m)
        if canon in reg and canon not in seen:
            out.append(canon)
            seen.add(canon)
    return out


def list_reference_classes(registry=None):
    """Return sorted list of class metadata for API discovery / docs."""
    reg = registry if registry is not None else REFERENCE_CLASS_TIERS
    return [
        {
            'name': name,
            'mean_overrun': params.get('mean_overrun'),
            'is_fat_tailed': params.get('is_fat_tailed'),
            'has_finite_mean': params.get('has_finite_mean'),
            'tier_4_distribution': params.get('tier_4_distribution'),
            'pareto_alpha_range': params.get('pareto_alpha_range'),
            'max_multiplier_cap': params.get('max_multiplier_cap'),
            'percentile_factors': params.get('percentile_factors'),
            'citations': params.get('citations', []),
            'version': params.get('version'),
        }
        for name, params in sorted(reg.items())
    ]


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------

def validate_class_definition(name, params):
    """Validate one class definition.  Returns list of error strings
    (empty -> valid).  Used both for built-ins (at module load) and
    for user-supplied custom classes (per-request).

    Each error is a human-readable message naming the field; the
    routes layer surfaces them as 400 responses.
    """
    errors = []

    if not isinstance(name, str) or not name.strip():
        errors.append('class name must be a non-empty string')
    elif _normalise_name(name) != name:
        errors.append(
            f'class name {name!r} should be lowercase with underscores '
            f'(got non-canonical form; suggested: {_normalise_name(name)!r})')

    if not isinstance(params, dict):
        errors.append(f'class {name!r}: params must be a dict')
        return errors

    for key in _REQUIRED_KEYS:
        if key not in params:
            errors.append(f'class {name!r}: missing required key {key!r}')

    # Range checks for the numeric fields.  Each defends against the
    # specific way a hand-edited class can blow up the MC.
    fft = params.get('fat_tail_from')
    if fft is not None:
        if not isinstance(fft, (int, float)) or not (0.0 <= float(fft) <= 1.0):
            errors.append(
                f'class {name!r}: fat_tail_from must be in [0, 1] '
                f'(got {fft!r})')

    po = params.get('pareto_offset')
    if po is not None:
        if not isinstance(po, (int, float)) or not (0.0 <= float(po) <= 1.0):
            errors.append(
                f'class {name!r}: pareto_offset must be in [0, 1] '
                f'(got {po!r})')

    par = params.get('pareto_alpha_range')
    if par is not None:
        if (not (isinstance(par, (list, tuple)) and len(par) == 2)
                or not all(isinstance(v, (int, float)) for v in par)):
            errors.append(
                f'class {name!r}: pareto_alpha_range must be a (lo, hi) '
                f'numeric pair (got {par!r})')
        else:
            lo, hi = float(par[0]), float(par[1])
            if not (0.5 <= lo <= 5.0) or not (0.5 <= hi <= 5.0):
                errors.append(
                    f'class {name!r}: pareto_alpha_range values should be '
                    f'in [0.5, 5.0] (got {par!r}); alpha < 0.5 is '
                    f'numerically unstable, > 5 produces a near-thin tail')
            if lo > hi:
                errors.append(
                    f'class {name!r}: pareto_alpha_range lo ({lo}) must '
                    f'be <= hi ({hi})')

    t4 = params.get('tier_4_distribution')
    if t4 is not None and t4 not in _TIER_4_VALID:
        errors.append(
            f'class {name!r}: tier_4_distribution {t4!r} not in '
            f'{sorted(_TIER_4_VALID)}')

    cap = params.get('max_multiplier_cap')
    if cap is not None:
        if not isinstance(cap, (int, float)) or not (1.0 <= float(cap) <= 200.0):
            errors.append(
                f'class {name!r}: max_multiplier_cap must be in '
                f'[1.0, 200.0] (got {cap!r})')

    pf = params.get('percentile_factors')
    if pf is not None:
        if not isinstance(pf, dict):
            errors.append(
                f'class {name!r}: percentile_factors must be a dict')
        else:
            for pkey in _PERCENTILE_KEYS:
                if pkey not in pf:
                    # Missing percentiles are tolerated (callers default
                    # to 1.0) but flagged at validation level for
                    # built-ins; not an error for partial custom classes.
                    continue
                pv = pf[pkey]
                if not isinstance(pv, (int, float)):
                    errors.append(
                        f'class {name!r}: percentile_factors[{pkey!r}] '
                        f'must be numeric (got {pv!r})')
                elif math.isnan(pv) or pv < 0:
                    errors.append(
                        f'class {name!r}: percentile_factors[{pkey!r}] '
                        f'must be non-negative (got {pv!r})')
                elif math.isinf(pv) and pkey != 'P99':
                    errors.append(
                        f'class {name!r}: percentile_factors[{pkey!r}] '
                        f'should be finite; INFINITE is reserved for P99 '
                        f'in alpha <= 1 reference classes')

    return errors


def merge_class_definitions(base, overrides, name='__inline__'):
    """Deep-merge ``overrides`` onto a copy of ``base``.

    Used for the ``reference_class_overrides`` API pattern: caller
    supplies a base class name and a partial overrides dict; we
    produce a runtime class with the overrides applied.

    Validates the result and raises ValueError on schema failure.
    """
    if not isinstance(base, dict):
        raise TypeError('base must be a dict (a resolved reference class)')
    if not isinstance(overrides, dict):
        raise TypeError('overrides must be a dict')

    merged = copy.deepcopy(base)
    for k, v in overrides.items():
        if (k == 'percentile_factors' and isinstance(v, dict)
                and isinstance(merged.get(k), dict)):
            # Merge percentile_factors at the per-percentile level so
            # callers can override just P95 without rewriting P50/P80.
            merged[k] = {**merged[k], **v}
        else:
            merged[k] = v

    errs = validate_class_definition(name, merged)
    if errs:
        raise ValueError('Override produced invalid class: ' + '; '.join(errs))
    return merged


# ---------------------------------------------------------------------------
# Built-in validation: fail fast at module load on dev errors
# ---------------------------------------------------------------------------

def _validate_builtins():
    """Run validate_class_definition against every built-in class.
    Logs warnings for any issues (we don't raise here because a
    non-fatal warning lets the service still start during a bad
    deploy; the validate_class_definition function is reused for
    user-supplied classes where we DO raise / 400)."""
    issues = []
    for nm, pp in REFERENCE_CLASS_TIERS.items():
        errs = validate_class_definition(nm, pp)
        if errs:
            for e in errs:
                issues.append(e)
                logger.warning('Built-in class %r failed validation: %s',
                               nm, e)
    return issues


_BUILTIN_VALIDATION_ISSUES = _validate_builtins()


# ---------------------------------------------------------------------------
# External JSON loading (env-var path)
# ---------------------------------------------------------------------------

def load_classes_from_path(path):
    """Load a JSON file mapping class names to parameter dicts.

    File format::

        {
          "customer_specific_petrochem_v3": {
              "fat_tail_from": 0.55,
              "pareto_offset": 0.25,
              "pareto_alpha_range": [1.8, 2.4],
              ...
          },
          ...
        }

    Returns dict of {name: validated_params}.  Invalid classes are
    skipped with a warning so one bad entry doesn't break loading.
    """
    out = {}
    if not path or not os.path.isfile(path):
        return out
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, ValueError) as exc:
        logger.warning('Could not load reference classes from %s: %s',
                       path, exc)
        return out
    if not isinstance(raw, dict):
        logger.warning('Reference classes file %s must be a JSON object', path)
        return out

    for nm, pp in raw.items():
        errs = validate_class_definition(nm, pp)
        if errs:
            logger.warning('Skipping invalid class %r in %s: %s',
                           nm, path, '; '.join(errs))
            continue
        out[nm] = pp
    if out:
        logger.info('Loaded %d reference class(es) from %s', len(out), path)
    return out


# Load environment-supplied extensions at import time.  Sets
# EXTERNAL_CLASS_TIERS for ops to inspect; a separate `effective_registry`
# function below merges builtins + external + per-request custom.
_EXT_PATH = os.environ.get('PYTH_REFERENCE_CLASSES_PATH', '')
EXTERNAL_CLASS_TIERS = load_classes_from_path(_EXT_PATH) if _EXT_PATH else {}


def effective_registry(custom_classes=None):
    """Return the merged registry: builtins + env-loaded + per-request.

    Per-request `custom_classes` win over env-loaded which win over
    builtins.  This is the lookup the engine should use when callers
    supply a `reference_class` so a request can shadow a built-in
    class with a customer-specific calibration without hostile
    side-effects on other requests.
    """
    merged = dict(REFERENCE_CLASS_TIERS)
    merged.update(EXTERNAL_CLASS_TIERS)
    if custom_classes:
        merged.update(custom_classes)
    return merged


def validate_custom_classes(custom_classes):
    """Validate a request-supplied dict of custom classes.  Returns
    list of errors (empty -> valid).  Used by completion/routes.py."""
    if custom_classes is None:
        return []
    if not isinstance(custom_classes, dict):
        return ['config.custom_reference_classes must be an object']
    errors = []
    for nm, pp in custom_classes.items():
        errors.extend(validate_class_definition(nm, pp))
    return errors


__all__ = [
    'REFERENCE_CLASS_TIERS',
    'EXTERNAL_CLASS_TIERS',
    'ALIASES',
    'INFINITE',
    'get_reference_class',
    'suggest_reference_class',
    'list_reference_classes',
    'validate_class_definition',
    'validate_custom_classes',
    'merge_class_definitions',
    'effective_registry',
    'load_classes_from_path',
]
