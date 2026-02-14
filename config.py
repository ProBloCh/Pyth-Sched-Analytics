"""
Centralized Configuration for Pyth-Sched-Analytics
====================================================
All environment-based configuration in one place.
Supports enterprise deployment with validation.
"""

import os
import secrets


class Config:
    """Base configuration with enterprise defaults."""

    # --- Flask ---
    DEBUG = os.getenv("DEBUG", "false").lower() == "true"
    PORT = int(os.getenv("PORT", 8000))

    # --- Security ---
    # Comma-separated list of valid API keys.  Generate with: python -c "import secrets; print(secrets.token_urlsafe(32))"
    API_KEYS = [k.strip() for k in os.getenv("API_KEYS", "").split(",") if k.strip()]
    # When True, requests without a valid API key are rejected (set False for dev/testing)
    REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "false").lower() == "true"

    # CORS – comma-separated allowed origins.  "*" to allow all (dev only).
    ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*")

    # --- Rate Limiting ---
    # Requests per window per client IP
    RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", 100))
    # Window size in seconds
    RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", 60))
    RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "true").lower() == "true"

    # --- Request Constraints ---
    MAX_CONTENT_LENGTH_MB = int(os.getenv("MAX_CONTENT_LENGTH_MB", 50))
    MAX_NODES = int(os.getenv("MAX_NODES", 50000))
    MAX_LINKS = int(os.getenv("MAX_LINKS", 200000))
    REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", 120))

    # --- Graph Analytics ---
    SMALL_GRAPH_THRESHOLD = int(os.getenv("SMALL_GRAPH_THRESHOLD", 2000))
    MAX_PATTERN_NODES = int(os.getenv("MAX_PATTERN_NODES", 1000))
    MAX_PATTERNS = int(os.getenv("MAX_PATTERNS", 10))
    CACHE_SIZE = int(os.getenv("CACHE_SIZE", 32))
    ENABLE_SILHOUETTE_OPTIMIZATION = os.getenv("ENABLE_SILHOUETTE_OPTIMIZATION", "false").lower() == "true"
    COMMUNITY_RESOLUTION = float(os.getenv("COMMUNITY_RESOLUTION", 1.0))

    # --- Redis ---
    REDIS_URL = os.getenv("REDIS_URL", None)
    REDIS_CACHE_TTL = int(os.getenv("REDIS_CACHE_TTL", 3600))

    # --- Logging ---
    LOG_LEVEL = os.getenv("LOG_LEVEL", "WARNING" if not DEBUG else "DEBUG")
    LOG_FORMAT = os.getenv("LOG_FORMAT", "json")  # "json" or "text"

    # --- Audit ---
    AUDIT_LOG_ENABLED = os.getenv("AUDIT_LOG_ENABLED", "true").lower() == "true"
    AUDIT_LOG_FILE = os.getenv("AUDIT_LOG_FILE", None)  # None = stdout

    @classmethod
    def validate(cls):
        """Validate configuration at startup. Raises on fatal mis-config."""
        errors = []
        if cls.REQUIRE_AUTH and not cls.API_KEYS:
            errors.append("REQUIRE_AUTH is true but no API_KEYS are configured")
        if cls.MAX_CONTENT_LENGTH_MB < 1:
            errors.append("MAX_CONTENT_LENGTH_MB must be >= 1")
        if cls.RATE_LIMIT_REQUESTS < 1:
            errors.append("RATE_LIMIT_REQUESTS must be >= 1")
        if errors:
            raise EnvironmentError(
                "Configuration errors:\n  - " + "\n  - ".join(errors)
            )
