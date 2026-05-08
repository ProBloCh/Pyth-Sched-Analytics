"""interface - Boundary-crossing interface intelligence.

Source-agnostic engine for hotspot detection, cross-group dependency
matrices, and recovery-board grounding.  Operates on Cybereum-native
``{nodes, links}`` payloads regardless of origin (P6 XER, MSP XML,
native authoring, ...) -- only requires that nodes carry the chosen
grouping field (defaults to ``WBS_Path``, configurable to ``Contract``,
``Phase``, ``Asset``, ``Discipline``, etc.).
"""

from .analytics import (
    HotspotWeights,
    InterfaceConfig,
    compute_interface_analytics,
)
from .routes import interface_bp

__all__ = [
    "interface_bp",
    "InterfaceConfig",
    "HotspotWeights",
    "compute_interface_analytics",
]
