"""Tests for middleware components."""

import pytest
from middleware import validate_graph_payload, _RateLimiter


class TestPayloadValidation:
    def test_valid_payload(self):
        ok, err = validate_graph_payload({
            "nodes": [{"ID": "A"}],
            "links": [{"source": "A", "target": "B"}]
        })
        assert ok is True
        assert err is None

    def test_missing_nodes(self):
        ok, err = validate_graph_payload({"links": []})
        assert ok is False
        assert "nodes" in err.lower()

    def test_nodes_not_list(self):
        ok, err = validate_graph_payload({"nodes": "bad"})
        assert ok is False

    def test_empty_nodes(self):
        ok, err = validate_graph_payload({"nodes": [], "links": []})
        assert ok is False
        assert "No nodes" in err

    def test_node_missing_id(self):
        ok, err = validate_graph_payload({
            "nodes": [{"Duration": 1}],
            "links": []
        })
        assert ok is False
        assert "missing required" in err.lower()

    def test_link_missing_target(self):
        ok, err = validate_graph_payload({
            "nodes": [{"ID": "A"}],
            "links": [{"source": "A"}]
        })
        assert ok is False

    def test_node_count_limit(self):
        from config import Config
        original = Config.MAX_NODES
        Config.MAX_NODES = 5
        try:
            ok, err = validate_graph_payload({
                "nodes": [{"ID": str(i)} for i in range(10)],
                "links": []
            })
            assert ok is False
            assert "exceeds maximum" in err
        finally:
            Config.MAX_NODES = original

    def test_null_links_accepted(self):
        ok, err = validate_graph_payload({
            "nodes": [{"ID": "A"}],
            "links": None
        })
        assert ok is True


class TestRateLimiter:
    def test_allows_within_limit(self):
        limiter = _RateLimiter()
        allowed, headers = limiter.is_allowed("test-ip", 5, 60)
        assert allowed is True
        assert "X-RateLimit-Limit" in headers

    def test_blocks_over_limit(self):
        limiter = _RateLimiter()
        for _ in range(5):
            limiter.is_allowed("test-ip", 5, 60)
        allowed, headers = limiter.is_allowed("test-ip", 5, 60)
        assert allowed is False
        assert headers["X-RateLimit-Remaining"] == "0"
        assert "Retry-After" in headers

    def test_separate_keys(self):
        limiter = _RateLimiter()
        for _ in range(5):
            limiter.is_allowed("ip-1", 5, 60)
        allowed, _ = limiter.is_allowed("ip-2", 5, 60)
        assert allowed is True
