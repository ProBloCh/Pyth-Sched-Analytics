"""
paths/_constants.py - Shared constants for the /paths blueprint.

Lives in a leaf module (no imports from sibling paths modules) so
both ``routes.py`` and ``subpath_patterns.py`` can reference the
same values without creating an import cycle.  Update here only --
both call sites pick up the change automatically.
"""

# Hard upper bound on schedule size for any /paths/* endpoint.
# Mirrored by SubpathConfig.__post_init__ for direct Python callers.
MAX_NODES = 20_000
