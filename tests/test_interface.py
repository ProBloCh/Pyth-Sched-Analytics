"""
Tests for the /interface blueprint and its analytics engine.

Covers
------
- compute_interface_analytics: grouping resolution, fallback chain,
  cross-group counting, score normalisation, top-sample selection
- HTTP endpoint: validation, happy path, weights override, max_hotspots,
  grouping_field override, malformed payloads
- Edge cases: missing grouping field, single-bucket schedules, missing
  optional risk/float fields, dangling link refs, self-loops
"""

import pytest

from interface.analytics import (
    UNASSIGNED_BUCKET,
    HotspotWeights,
    InterfaceConfig,
    compute_interface_analytics,
)

# =====================================================================
# Fixtures
# =====================================================================

@pytest.fixture
def two_package_schedule():
    """
    Three activities in package 'Mech', three in package 'Elec',
    plus a few cross-package handoffs.

        M1 -> M2 -> M3
                     \\
                      \\-> E1 -> E2 -> E3
        M1 ----------------> E1                (extra cross-WBS)

    M3->E1 and M1->E1 are cross-WBS (interface) links.
    """
    nodes = [
        {"ID": "M1", "Name": "Mech 1", "WBS_Path": "Plant / Mech",
         "total_float": 0,  "risk_score": 0.8},
        {"ID": "M2", "Name": "Mech 2", "WBS_Path": "Plant / Mech",
         "total_float": 0,  "risk_score": 0.6},
        {"ID": "M3", "Name": "Mech 3", "WBS_Path": "Plant / Mech",
         "total_float": 0,  "risk_score": 0.9},
        {"ID": "E1", "Name": "Elec 1", "WBS_Path": "Plant / Elec",
         "total_float": 2,  "risk_score": 0.7},
        {"ID": "E2", "Name": "Elec 2", "WBS_Path": "Plant / Elec",
         "total_float": 2,  "risk_score": 0.4},
        {"ID": "E3", "Name": "Elec 3", "WBS_Path": "Plant / Elec",
         "total_float": 5,  "risk_score": 0.3},
    ]
    links = [
        {"source": "M1", "target": "M2", "type": "FS", "lag": 0},
        {"source": "M2", "target": "M3", "type": "FS", "lag": 0},
        {"source": "M3", "target": "E1", "type": "FS", "lag": 0},  # cross
        {"source": "M1", "target": "E1", "type": "FS", "lag": 0},  # cross
        {"source": "E1", "target": "E2", "type": "FS", "lag": 0},
        {"source": "E2", "target": "E3", "type": "FS", "lag": 0},
    ]
    return nodes, links


@pytest.fixture
def single_package_schedule():
    """All activities in one bucket -> zero cross-group traffic."""
    nodes = [
        {"ID": "A", "WBS_Path": "Solo", "risk_score": 0.5, "total_float": 0},
        {"ID": "B", "WBS_Path": "Solo", "risk_score": 0.3, "total_float": 0},
        {"ID": "C", "WBS_Path": "Solo", "risk_score": 0.4, "total_float": 0},
    ]
    links = [
        {"source": "A", "target": "B"},
        {"source": "B", "target": "C"},
    ]
    return nodes, links


@pytest.fixture
def no_grouping_schedule():
    """Nodes with no WBS field at all."""
    nodes = [
        {"ID": "A"},
        {"ID": "B"},
        {"ID": "C"},
    ]
    links = [
        {"source": "A", "target": "B"},
        {"source": "B", "target": "C"},
    ]
    return nodes, links


@pytest.fixture
def multi_lens_schedule():
    """A schedule with multiple grouping dimensions populated, used to
    demonstrate that the same engine answers different questions by
    swapping the grouping_field parameter."""
    nodes = [
        {"ID": "1", "WBS_Path": "P1 / Mech", "Contract": "EPC-A",
         "Phase": "Construction"},
        {"ID": "2", "WBS_Path": "P1 / Elec", "Contract": "EPC-A",
         "Phase": "Construction"},
        {"ID": "3", "WBS_Path": "P2 / Mech", "Contract": "EPC-B",
         "Phase": "Commissioning"},
        {"ID": "4", "WBS_Path": "P2 / Elec", "Contract": "EPC-B",
         "Phase": "Commissioning"},
    ]
    links = [
        {"source": "1", "target": "2"},  # same contract, same phase, cross WBS
        {"source": "2", "target": "3"},  # cross contract, cross phase, cross WBS
        {"source": "3", "target": "4"},  # same contract, same phase, cross WBS
        {"source": "1", "target": "4"},  # cross contract, cross phase, cross WBS
    ]
    return nodes, links


@pytest.fixture
def flask_app():
    from app import app
    app.config["TESTING"] = True
    return app


@pytest.fixture
def client(flask_app):
    return flask_app.test_client()


# =====================================================================
# Engine tests
# =====================================================================

class TestGroupingResolution:
    def test_explicit_grouping_field_used(self, two_package_schedule):
        nodes, links = two_package_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="WBS_Path"),
        )
        assert result["summary"]["grouping_field"] == "WBS_Path"
        assert result["summary"]["total_groups"] == 2

    def test_fallback_chain_picks_first_populated(self, two_package_schedule):
        nodes, links = two_package_schedule
        # No grouping_field -> should auto-pick WBS_Path (first in chain).
        result = compute_interface_analytics(nodes, links)
        assert result["summary"]["grouping_field"] == "WBS_Path"

    def test_explicit_field_with_no_data_warns(self, two_package_schedule):
        nodes, links = two_package_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="Contract"),
        )
        assert result["summary"]["populated_node_count"] == 0
        assert any("not populated" in w for w in result["warnings"])

    def test_no_grouping_data_anywhere_warns(self, no_grouping_schedule):
        nodes, links = no_grouping_schedule
        result = compute_interface_analytics(nodes, links)
        # Should not crash; everything collapses to UNASSIGNED_BUCKET.
        assert result["summary"]["total_groups"] == 1
        assert result["summary"]["cross_group_links"] == 0
        assert any("no grouping field populated" in w
                   for w in result["warnings"])


class TestCrossGroupCounting:
    def test_cross_group_links_counted_correctly(self, two_package_schedule):
        nodes, links = two_package_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="WBS_Path"),
        )
        # Two cross-WBS links: M3->E1, M1->E1.
        assert result["summary"]["cross_group_links"] == 2
        assert result["summary"]["total_links"] == 6
        assert result["summary"]["cross_group_ratio"] == pytest.approx(2 / 6)

    def test_hotspot_directionality(self, two_package_schedule):
        """Mech is the predecessor side; Elec the successor side."""
        nodes, links = two_package_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="WBS_Path"),
        )
        by_group = {h["group"]: h for h in result["hotspots"]}
        elec = by_group["Plant / Elec"]
        mech = by_group["Plant / Mech"]
        # Two links arrive at Elec, none arrive at Mech.
        assert elec["incoming_cross_group"] == 2
        assert mech["incoming_cross_group"] == 0
        # Two links leave Mech, none leave Elec.
        assert mech["outgoing_cross_group"] == 2
        assert elec["outgoing_cross_group"] == 0
        # One distinct predecessor group on each side.
        assert elec["distinct_pred_groups"] == 1
        assert mech["distinct_succ_groups"] == 1

    def test_single_bucket_returns_no_hotspots(self, single_package_schedule):
        nodes, links = single_package_schedule
        result = compute_interface_analytics(nodes, links)
        assert result["summary"]["cross_group_links"] == 0
        assert result["hotspots"] == []
        assert result["matrix"] == []


class TestMatrix:
    def test_matrix_row_per_pair(self, two_package_schedule):
        nodes, links = two_package_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="WBS_Path"),
        )
        # Only one cross-group direction in this fixture: Mech -> Elec.
        assert len(result["matrix"]) == 1
        row = result["matrix"][0]
        assert row["pred_group"] == "Plant / Mech"
        assert row["succ_group"] == "Plant / Elec"
        assert row["rel_count"] == 2
        # Risk on E1 is 0.7; that should bubble up as max_succ_risk.
        assert row["max_succ_risk"] == pytest.approx(0.7)


class TestHotspotScore:
    def test_score_in_zero_to_hundred(self, two_package_schedule):
        nodes, links = two_package_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="WBS_Path"),
        )
        for h in result["hotspots"]:
            assert 0.0 <= h["interface_hotspot_score"] <= 100.0

    def test_weights_are_honoured(self, two_package_schedule):
        """Reweight to zero everywhere except w_outgoing -> Mech (which
        does the outgoing) should outscore Elec."""
        nodes, links = two_package_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(
                grouping_field="WBS_Path",
                weights=HotspotWeights(
                    w_incoming=0.0, w_distinct_pred=0.0,
                    w_outgoing=1.0, w_distinct_succ=0.0,
                    w_risk=0.0,
                ),
            ),
        )
        mech = next(h for h in result["hotspots"]
                    if h["group"] == "Plant / Mech")
        elec = next(h for h in result["hotspots"]
                    if h["group"] == "Plant / Elec")
        assert mech["interface_hotspot_score"] > elec["interface_hotspot_score"]


class TestTopSamples:
    def test_top_samples_attached_to_records(self, two_package_schedule):
        nodes, links = two_package_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="WBS_Path",
                            top_samples_per_hotspot=3),
        )
        records = result["_hotspot_records"]
        assert "Plant / Elec" in records
        # E1 receives both cross-group links, so it should appear once
        # in top_incoming for the Elec hotspot.
        elec_in = records["Plant / Elec"]["top_incoming"]
        ids = [r["ID"] for r in elec_in]
        assert "E1" in ids

    def test_top_samples_zero_returns_empty(self, two_package_schedule):
        nodes, links = two_package_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="WBS_Path",
                            top_samples_per_hotspot=0),
        )
        # Each hotspot record's top lists should be empty / absent.
        for grp_records in result["_hotspot_records"].values():
            for direction in ("top_incoming", "top_outgoing"):
                if direction in grp_records:
                    assert grp_records[direction] == []


class TestMultiLens:
    """The same schedule can be analysed under different grouping
    fields; each lens answers a different business question."""

    def test_wbs_lens(self, multi_lens_schedule):
        nodes, links = multi_lens_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="WBS_Path"),
        )
        # All four links cross WBS boundaries.
        assert result["summary"]["cross_group_links"] == 4

    def test_contract_lens(self, multi_lens_schedule):
        nodes, links = multi_lens_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="Contract"),
        )
        # Only links 2 (2->3) and 4 (1->4) cross EPC-A / EPC-B.
        assert result["summary"]["cross_group_links"] == 2

    def test_phase_lens(self, multi_lens_schedule):
        nodes, links = multi_lens_schedule
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="Phase"),
        )
        # Links 2 and 4 cross Construction -> Commissioning.
        assert result["summary"]["cross_group_links"] == 2


class TestEdgeCases:
    def test_dangling_link_ref_dropped_silently(self, two_package_schedule):
        nodes, links = two_package_schedule
        bad_links = links + [{"source": "M1", "target": "GHOST"}]
        result = compute_interface_analytics(
            nodes, bad_links,
            InterfaceConfig(grouping_field="WBS_Path"),
        )
        # GHOST is not a node -> the link is dropped, not crashed.
        assert result["summary"]["total_links"] == 6

    def test_self_loop_not_cross_group(self):
        nodes = [
            {"ID": "A", "WBS_Path": "X"},
            {"ID": "B", "WBS_Path": "Y"},
        ]
        links = [
            {"source": "A", "target": "A"},  # self
            {"source": "A", "target": "B"},
        ]
        result = compute_interface_analytics(
            nodes, links, InterfaceConfig(grouping_field="WBS_Path"),
        )
        assert result["summary"]["cross_group_links"] == 1

    def test_missing_risk_and_float_fields(self):
        nodes = [
            {"ID": "A", "WBS_Path": "X"},
            {"ID": "B", "WBS_Path": "Y"},
        ]
        links = [{"source": "A", "target": "B"}]
        # Should not crash; metrics that depend on absent fields end
        # up as None / NaN-collapsed-to-zero where appropriate.
        result = compute_interface_analytics(
            nodes, links, InterfaceConfig(grouping_field="WBS_Path"),
        )
        assert result["hotspots"]
        for h in result["hotspots"]:
            # Score should be finite in [0, 100] even with no risk data.
            assert 0.0 <= h["interface_hotspot_score"] <= 100.0

    def test_unassigned_bucket_for_missing_field_value(self):
        nodes = [
            {"ID": "A", "WBS_Path": "X"},
            {"ID": "B"},  # no WBS_Path
            {"ID": "C", "WBS_Path": "X"},
        ]
        links = [
            {"source": "A", "target": "B"},
            {"source": "B", "target": "C"},
        ]
        result = compute_interface_analytics(
            nodes, links, InterfaceConfig(grouping_field="WBS_Path"),
        )
        groups = {h["group"] for h in result["hotspots"]}
        assert UNASSIGNED_BUCKET in groups

    def test_max_hotspots_caps_output(self):
        # Ten distinct buckets, all linked across in a star.
        nodes = [{"ID": str(i), "WBS_Path": f"G{i}"} for i in range(10)]
        links = [{"source": "0", "target": str(i)} for i in range(1, 10)]
        result = compute_interface_analytics(
            nodes, links,
            InterfaceConfig(grouping_field="WBS_Path", max_hotspots=3),
        )
        assert len(result["hotspots"]) <= 3


# =====================================================================
# HTTP endpoint tests
# =====================================================================

class TestEndpoint:
    def test_health(self, client):
        resp = client.get("/interface/health")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "healthy"
        assert "/interface/analytics" in body["endpoints"]

    def test_happy_path(self, client, two_package_schedule):
        nodes, links = two_package_schedule
        resp = client.post("/interface/analytics", json={
            "nodes": nodes, "links": links,
            "grouping_field": "WBS_Path",
        })
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["summary"]["grouping_field"] == "WBS_Path"
        assert body["summary"]["cross_group_links"] == 2
        assert len(body["hotspots"]) == 2
        # Each hotspot row should have top_incoming/top_outgoing keys.
        for h in body["hotspots"]:
            assert "top_incoming" in h
            assert "top_outgoing" in h

    def test_weights_override(self, client, two_package_schedule):
        nodes, links = two_package_schedule
        resp = client.post("/interface/analytics", json={
            "nodes": nodes, "links": links,
            "grouping_field": "WBS_Path",
            "weights": {
                "w_incoming": 1.0, "w_distinct_pred": 0.0,
                "w_outgoing": 0.0, "w_distinct_succ": 0.0,
                "w_risk": 0.0,
            },
        })
        assert resp.status_code == 200

    def test_rejects_bad_weights(self, client, two_package_schedule):
        nodes, links = two_package_schedule
        resp = client.post("/interface/analytics", json={
            "nodes": nodes, "links": links,
            "weights": {"w_incoming": "high"},
        })
        assert resp.status_code == 400

    def test_rejects_negative_weights(self, client, two_package_schedule):
        nodes, links = two_package_schedule
        resp = client.post("/interface/analytics", json={
            "nodes": nodes, "links": links,
            "weights": {"w_incoming": -0.5},
        })
        assert resp.status_code == 400

    def test_rejects_empty_nodes(self, client):
        resp = client.post("/interface/analytics", json={
            "nodes": [], "links": [],
        })
        assert resp.status_code == 400

    def test_rejects_missing_id(self, client):
        resp = client.post("/interface/analytics", json={
            "nodes": [{"Name": "no id"}], "links": [],
        })
        assert resp.status_code == 400

    def test_rejects_duplicate_id(self, client):
        resp = client.post("/interface/analytics", json={
            "nodes": [{"ID": "1"}, {"ID": "1"}], "links": [],
        })
        assert resp.status_code == 400

    def test_rejects_invalid_grouping_field_type(self, client,
                                                 two_package_schedule):
        nodes, links = two_package_schedule
        resp = client.post("/interface/analytics", json={
            "nodes": nodes, "links": links,
            "grouping_field": 42,
        })
        assert resp.status_code == 400

    def test_rejects_invalid_max_hotspots(self, client, two_package_schedule):
        nodes, links = two_package_schedule
        resp = client.post("/interface/analytics", json={
            "nodes": nodes, "links": links,
            "max_hotspots": 0,
        })
        assert resp.status_code == 400

    def test_options_preflight(self, client):
        resp = client.open("/interface/analytics", method="OPTIONS")
        assert resp.status_code == 200
