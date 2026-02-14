"""Tests for the Config module."""

import os
import pytest
from config import Config


class TestConfigValidation:
    def test_validate_passes_with_defaults(self):
        original_auth = Config.REQUIRE_AUTH
        Config.REQUIRE_AUTH = False
        try:
            Config.validate()  # Should not raise
        finally:
            Config.REQUIRE_AUTH = original_auth

    def test_validate_fails_auth_without_keys(self):
        original_auth = Config.REQUIRE_AUTH
        original_keys = Config.API_KEYS
        Config.REQUIRE_AUTH = True
        Config.API_KEYS = []
        try:
            with pytest.raises(EnvironmentError, match="API_KEYS"):
                Config.validate()
        finally:
            Config.REQUIRE_AUTH = original_auth
            Config.API_KEYS = original_keys

    def test_validate_fails_bad_content_length(self):
        original = Config.MAX_CONTENT_LENGTH_MB
        Config.MAX_CONTENT_LENGTH_MB = 0
        try:
            with pytest.raises(EnvironmentError, match="MAX_CONTENT_LENGTH_MB"):
                Config.validate()
        finally:
            Config.MAX_CONTENT_LENGTH_MB = original
