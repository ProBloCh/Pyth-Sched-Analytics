"""Shared fixtures for the test suite."""

import os
import pytest

# Disable auth and set test-friendly config before importing app
os.environ["REQUIRE_AUTH"] = "false"
os.environ["RATE_LIMIT_ENABLED"] = "false"
os.environ["AUDIT_LOG_ENABLED"] = "false"
os.environ["LOG_FORMAT"] = "text"
os.environ["DEBUG"] = "false"

from app import app as flask_app


@pytest.fixture()
def app():
    flask_app.config["TESTING"] = True
    yield flask_app


@pytest.fixture()
def client(app):
    return app.test_client()


# ---------------------------------------------------------------------------
# Reusable payloads
# ---------------------------------------------------------------------------

@pytest.fixture()
def simple_graph():
    """Minimal valid graph with 3 nodes and 2 links."""
    return {
        "nodes": [
            {"ID": "A", "Duration": 5, "importanceScore": 8, "riskScore": 3,
             "TaskType": "Task", "Resources": "Team1", "Start": "2025-01-01"},
            {"ID": "B", "Duration": 3, "importanceScore": 5, "riskScore": 7,
             "TaskType": "Task", "Resources": "Team2", "Start": "2025-01-06"},
            {"ID": "C", "Duration": 2, "importanceScore": 9, "riskScore": 2,
             "TaskType": "Milestone", "Resources": "Team1", "Start": "2025-01-09"},
        ],
        "links": [
            {"source": "A", "target": "B", "duration": 5, "type": "FS"},
            {"source": "B", "target": "C", "duration": 3, "type": "FS"},
        ],
    }


@pytest.fixture()
def large_graph():
    """Graph with 50 nodes for testing clustering / community detection."""
    nodes = [
        {
            "ID": f"N{i}",
            "Duration": (i % 10) + 1,
            "importanceScore": (i % 10) + 1,
            "riskScore": 10 - (i % 10),
            "TaskType": "Task",
            "Resources": f"Team{i % 5}",
            "Start": f"2025-01-{(i % 28) + 1:02d}",
        }
        for i in range(50)
    ]
    links = [
        {"source": f"N{i}", "target": f"N{i + 1}", "duration": 1, "type": "FS"}
        for i in range(49)
    ]
    return {"nodes": nodes, "links": links}
