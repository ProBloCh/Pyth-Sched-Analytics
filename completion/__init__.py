"""
completion - Project completion forecasting service.

Wraps the validated five-tier risk distribution model from
solver/stochastic.py to produce calendar-based P20/P50/P80 finish-date
forecasts from a project's current status.  Extracted from the
Completionprediction.js frontend MC loop (Natarajan & Flyvbjerg, PMJ
2022; Flyvbjerg et al., JMIS 2022).
"""

from .routes import completion_bp

__all__ = ['completion_bp']
