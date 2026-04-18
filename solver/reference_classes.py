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

# Sentinel for "not a real percentile, the reference class has formally
# infinite variance / mean".  Consumers should display a cap warning.
INFINITE = float('inf')


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
        'tier_4_distribution': 'skip',  # straight from normal to Pareto
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
        'tier_4_distribution': 'skip',
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

def get_reference_class(name):
    """Return the parameter dict for `name`, or None if unknown.

    Names are case-insensitive and tolerate hyphens / spaces (callers
    in the wild use 'oil_gas_offshore', 'oil-gas-offshore', or
    'Oil & Gas Offshore').  Returns None for unknown classes; the
    caller should fall back to the global default tier model.
    """
    if name is None:
        return None
    key = str(name).lower().strip().replace(' ', '_').replace('-', '_').replace('&', '_and_')
    if key in REFERENCE_CLASS_TIERS:
        return REFERENCE_CLASS_TIERS[key]
    # Aliases for convenience / backwards compat with EVM sector names
    aliases = {
        'oil_and_gas': 'oil_gas_offshore',
        'oil_gas': 'oil_gas_offshore',
        'lng': 'oil_gas_onshore_lng',
        'petrochemical': 'oil_gas_onshore_lng',
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
    if key in aliases:
        return REFERENCE_CLASS_TIERS[aliases[key]]
    return None


def list_reference_classes():
    """Return sorted list of canonical class names + their headline mean
    overrun and fat-tailed flag, useful for API discovery / docs."""
    return [
        {
            'name': name,
            'mean_overrun': params['mean_overrun'],
            'is_fat_tailed': params['is_fat_tailed'],
            'has_finite_mean': params['has_finite_mean'],
            'tier_4_distribution': params['tier_4_distribution'],
        }
        for name, params in sorted(REFERENCE_CLASS_TIERS.items())
    ]


__all__ = [
    'REFERENCE_CLASS_TIERS',
    'INFINITE',
    'get_reference_class',
    'list_reference_classes',
]
