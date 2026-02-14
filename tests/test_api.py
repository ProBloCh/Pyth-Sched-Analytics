"""Tests for API endpoints, middleware, and core analytics."""

import json
import os
import pytest


# ──────────────────────────────────────────────────────────────────────────────
# Health / root endpoints
# ──────────────────────────────────────────────────────────────────────────────

class TestHealthEndpoints:
    def test_root_returns_ok(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "ok"
        assert data["version"] == "v4.0"

    def test_health_returns_status(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] in ("healthy", "degraded")
        assert "features" in data
        assert "limits" in data
        assert "api_versions" in data

    def test_versioned_health(self, client):
        resp = client.get("/api/v1/health")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] in ("healthy", "degraded")


# ──────────────────────────────────────────────────────────────────────────────
# Request-ID tracking
# ──────────────────────────────────────────────────────────────────────────────

class TestRequestID:
    def test_request_id_generated(self, client):
        resp = client.get("/health")
        assert "X-Request-ID" in resp.headers

    def test_request_id_honoured(self, client):
        resp = client.get("/health", headers={"X-Request-ID": "test-123"})
        assert resp.headers["X-Request-ID"] == "test-123"


# ──────────────────────────────────────────────────────────────────────────────
# Input validation
# ──────────────────────────────────────────────────────────────────────────────

class TestInputValidation:
    def test_empty_body_rejected(self, client):
        resp = client.post("/graph-metrics", json={})
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["code"] == "VALIDATION_ERROR"

    def test_no_nodes_rejected(self, client):
        resp = client.post("/graph-metrics", json={"nodes": [], "links": []})
        assert resp.status_code == 400

    def test_nodes_not_list_rejected(self, client):
        resp = client.post("/graph-metrics", json={"nodes": "bad", "links": []})
        assert resp.status_code == 400

    def test_node_missing_id_rejected(self, client):
        resp = client.post("/graph-metrics", json={
            "nodes": [{"Duration": 1}],
            "links": []
        })
        assert resp.status_code == 400
        assert "missing required fields" in resp.get_json()["error"]

    def test_link_missing_fields_rejected(self, client):
        resp = client.post("/graph-metrics", json={
            "nodes": [{"ID": "A"}],
            "links": [{"source": "A"}]
        })
        assert resp.status_code == 400


# ──────────────────────────────────────────────────────────────────────────────
# Core graph-metrics endpoint
# ──────────────────────────────────────────────────────────────────────────────

class TestGraphMetrics:
    def test_simple_graph(self, client, simple_graph):
        resp = client.post("/graph-metrics", json=simple_graph)
        assert resp.status_code == 200
        data = resp.get_json()
        assert "nodes" in data
        assert "links" in data
        assert "critical_path" in data
        assert "work_packages" in data
        assert "templates" in data
        assert isinstance(data["processing_time"], float)
        assert "request_id" in data

    def test_versioned_route(self, client, simple_graph):
        resp = client.post("/api/v1/graph-metrics", json=simple_graph)
        assert resp.status_code == 200
        data = resp.get_json()
        assert "nodes" in data

    def test_nodes_enriched(self, client, simple_graph):
        resp = client.post("/graph-metrics", json=simple_graph)
        data = resp.get_json()
        node = data["nodes"][0]
        assert "Cluster" in node
        assert "DependencyCluster" in node
        assert "CommunityGroup" in node
        assert "PageRank" in node
        assert "closeness_centrality" in node
        assert "degree_centrality" in node
        assert "Clustering_Coefficient" in node
        assert "pca1" in node
        assert "pca2" in node

    def test_critical_path_computed(self, client, simple_graph):
        resp = client.post("/graph-metrics", json=simple_graph)
        data = resp.get_json()
        assert isinstance(data["critical_path"], list)
        assert isinstance(data["critical_path_length"], (int, float))

    def test_large_graph(self, client, large_graph):
        resp = client.post("/graph-metrics", json=large_graph)
        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["nodes"]) == 50

    def test_options_preflight(self, client):
        resp = client.options("/graph-metrics")
        assert resp.status_code == 200


# ──────────────────────────────────────────────────────────────────────────────
# Error responses
# ──────────────────────────────────────────────────────────────────────────────

class TestErrorHandling:
    def test_404_structured(self, client):
        resp = client.get("/nonexistent")
        assert resp.status_code == 404
        data = resp.get_json()
        assert "error" in data
        assert "code" in data

    def test_405_structured(self, client):
        resp = client.delete("/health")
        assert resp.status_code == 405
        data = resp.get_json()
        assert data["code"] == "HTTP_405"

    def test_error_contains_request_id(self, client):
        resp = client.get("/nonexistent", headers={"X-Request-ID": "err-123"})
        data = resp.get_json()
        assert data.get("request_id") == "err-123"


# ──────────────────────────────────────────────────────────────────────────────
# CORS
# ──────────────────────────────────────────────────────────────────────────────

class TestCORS:
    def test_cors_endpoint(self, client):
        resp = client.get("/test-cors")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "cors test ok"


# ──────────────────────────────────────────────────────────────────────────────
# Authentication (when enabled)
# ──────────────────────────────────────────────────────────────────────────────

class TestAuthentication:
    def test_auth_disabled_allows_all(self, client, simple_graph):
        # Auth is disabled in conftest, so this should work
        resp = client.post("/graph-metrics", json=simple_graph)
        assert resp.status_code == 200

    def test_auth_enabled_rejects_no_key(self, app, client, simple_graph):
        from config import Config
        original = Config.REQUIRE_AUTH
        Config.REQUIRE_AUTH = True
        Config.API_KEYS = ["test-key-123"]
        try:
            resp = client.post("/graph-metrics", json=simple_graph)
            assert resp.status_code == 401
            data = resp.get_json()
            assert data["code"] == "AUTH_MISSING"
        finally:
            Config.REQUIRE_AUTH = original

    def test_auth_enabled_rejects_bad_key(self, app, client, simple_graph):
        from config import Config
        original = Config.REQUIRE_AUTH
        Config.REQUIRE_AUTH = True
        Config.API_KEYS = ["test-key-123"]
        try:
            resp = client.post(
                "/graph-metrics",
                json=simple_graph,
                headers={"Authorization": "Bearer wrong-key"}
            )
            assert resp.status_code == 403
            data = resp.get_json()
            assert data["code"] == "AUTH_INVALID"
        finally:
            Config.REQUIRE_AUTH = original

    def test_auth_enabled_accepts_valid_bearer(self, app, client, simple_graph):
        from config import Config
        original = Config.REQUIRE_AUTH
        Config.REQUIRE_AUTH = True
        Config.API_KEYS = ["test-key-123"]
        try:
            resp = client.post(
                "/graph-metrics",
                json=simple_graph,
                headers={"Authorization": "Bearer test-key-123"}
            )
            assert resp.status_code == 200
        finally:
            Config.REQUIRE_AUTH = original

    def test_auth_enabled_accepts_x_api_key(self, app, client, simple_graph):
        from config import Config
        original = Config.REQUIRE_AUTH
        Config.REQUIRE_AUTH = True
        Config.API_KEYS = ["test-key-123"]
        try:
            resp = client.post(
                "/graph-metrics",
                json=simple_graph,
                headers={"X-API-Key": "test-key-123"}
            )
            assert resp.status_code == 200
        finally:
            Config.REQUIRE_AUTH = original

    def test_auth_skipped_for_public_paths(self, app, client):
        from config import Config
        original = Config.REQUIRE_AUTH
        Config.REQUIRE_AUTH = True
        Config.API_KEYS = ["test-key-123"]
        try:
            assert client.get("/").status_code == 200
            assert client.get("/health").status_code == 200
        finally:
            Config.REQUIRE_AUTH = original


# ──────────────────────────────────────────────────────────────────────────────
# Rate Limiting
# ──────────────────────────────────────────────────────────────────────────────

class TestRateLimiting:
    def test_rate_limit_headers_present(self, app, client, simple_graph):
        from config import Config
        Config.RATE_LIMIT_ENABLED = True
        Config.RATE_LIMIT_REQUESTS = 100
        try:
            resp = client.post("/graph-metrics", json=simple_graph)
            assert resp.status_code == 200
            assert "X-RateLimit-Limit" in resp.headers
            assert "X-RateLimit-Remaining" in resp.headers
        finally:
            Config.RATE_LIMIT_ENABLED = False

    def test_rate_limit_enforced(self, app, client, simple_graph):
        from config import Config
        from middleware import _limiter
        Config.RATE_LIMIT_ENABLED = True
        Config.RATE_LIMIT_REQUESTS = 2
        Config.RATE_LIMIT_WINDOW = 60
        # Reset the limiter state
        _limiter._windows.clear()
        try:
            # First two should succeed
            r1 = client.post("/graph-metrics", json=simple_graph)
            assert r1.status_code == 200
            r2 = client.post("/graph-metrics", json=simple_graph)
            assert r2.status_code == 200
            # Third should be rate limited
            r3 = client.post("/graph-metrics", json=simple_graph)
            assert r3.status_code == 429
            data = r3.get_json()
            assert data["code"] == "RATE_LIMITED"
            assert "Retry-After" in r3.headers
        finally:
            Config.RATE_LIMIT_ENABLED = False
            _limiter._windows.clear()
