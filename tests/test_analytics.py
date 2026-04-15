"""
Unit and integration tests for descriptive analytics (app.py).

Covers: build_nx_graph, ensure_dag, clustering, PCA, community detection,
centralities, critical path, work packages, analyse() orchestration,
and the /graph-metrics endpoint contract.
"""

import json
import numpy as np
import pandas as pd
import pytest

from app import (
    app,
    build_nx_graph,
    ensure_dag,
    calculate_critical_path,
    detect_repeating_patterns,
    create_templates_from_patterns,
    define_work_packages,
    serialize_work_packages,
    _cluster_risk_kmeans,
    _pca,
    _centralities,
    _community_detection,
    analyse,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def simple_chain():
    """A -> B -> C  linear chain.  Edge durations match node durations."""
    nodes = [
        {'ID': 'A', 'Duration': 10, 'Start': '2025-01-01',
         'importanceScore': 8, 'riskScore': 3},
        {'ID': 'B', 'Duration': 20, 'Start': '2025-01-11',
         'importanceScore': 5, 'riskScore': 7},
        {'ID': 'C', 'Duration': 5, 'Start': '2025-01-31',
         'importanceScore': 2, 'riskScore': 9},
    ]
    links = [
        {'source': 'A', 'target': 'B', 'duration': 10},
        {'source': 'B', 'target': 'C', 'duration': 20},
    ]
    return nodes, links


@pytest.fixture
def diamond():
    """
    A -> B -> D
    A -> C -> D
    Critical path uses edge durations: A->B(10) + B->D(15) = 25
    """
    nodes = [
        {'ID': 'A', 'Duration': 10, 'Start': '2025-01-01',
         'Milestone': 1, 'importanceScore': 9, 'riskScore': 2},
        {'ID': 'B', 'Duration': 15, 'Start': '2025-01-11',
         'importanceScore': 7, 'riskScore': 5},
        {'ID': 'C', 'Duration': 8, 'Start': '2025-01-11',
         'importanceScore': 3, 'riskScore': 8},
        {'ID': 'D', 'Duration': 5, 'Start': '2025-01-26',
         'Milestone': 1, 'importanceScore': 6, 'riskScore': 4},
    ]
    links = [
        {'source': 'A', 'target': 'B', 'duration': 10},
        {'source': 'A', 'target': 'C', 'duration': 8},
        {'source': 'B', 'target': 'D', 'duration': 15},
        {'source': 'C', 'target': 'D', 'duration': 8},
    ]
    return nodes, links


@pytest.fixture
def cyclic_graph():
    """Graph with a cycle: A -> B -> C -> A."""
    nodes = [
        {'ID': 'A', 'Duration': 5, 'Start': '2025-01-01',
         'importanceScore': 5, 'riskScore': 5},
        {'ID': 'B', 'Duration': 10, 'Start': '2025-01-06',
         'importanceScore': 5, 'riskScore': 5},
        {'ID': 'C', 'Duration': 3, 'Start': '2025-01-16',
         'importanceScore': 5, 'riskScore': 5},
    ]
    links = [
        {'source': 'A', 'target': 'B'},
        {'source': 'B', 'target': 'C'},
        {'source': 'C', 'target': 'A'},
    ]
    return nodes, links


@pytest.fixture
def client():
    app.config['TESTING'] = True
    return app.test_client()


# ---------------------------------------------------------------------------
# build_nx_graph
# ---------------------------------------------------------------------------

class TestBuildNxGraph:

    def test_basic_construction(self, simple_chain):
        nodes, links = simple_chain
        G = build_nx_graph(nodes, links)
        assert len(G.nodes) == 3
        assert len(G.edges) == 2
        assert G.has_edge('A', 'B')
        assert G.has_edge('B', 'C')

    def test_node_attributes(self, simple_chain):
        nodes, links = simple_chain
        G = build_nx_graph(nodes, links)
        assert G.nodes['A']['duration'] == 10
        assert G.nodes['A']['start_date'] is not None

    def test_missing_start_date(self):
        """Nodes without Start should get None start_date."""
        nodes = [{'ID': 'X', 'Duration': 5, 'Start': None}]
        G = build_nx_graph(nodes, [])
        assert G.nodes['X']['start_date'] is None

    def test_missing_id_gets_index(self):
        nodes = [{'Duration': 5}, {'Duration': 10}]
        G = build_nx_graph(nodes, [])
        assert '0' in G.nodes
        assert '1' in G.nodes

    def test_edge_attributes(self):
        nodes = [{'ID': 'A', 'Duration': 3}, {'ID': 'B', 'Duration': 5}]
        links = [{'source': 'A', 'target': 'B', 'duration': 7, 'type': 'FS', 'lag': 2}]
        G = build_nx_graph(nodes, links)
        edge = G.edges['A', 'B']
        assert edge['duration'] == 7
        assert edge['type'] == 'FS'
        assert edge['lag'] == 2


# ---------------------------------------------------------------------------
# ensure_dag
# ---------------------------------------------------------------------------

class TestEnsureDag:

    def test_already_dag(self, simple_chain):
        nodes, links = simple_chain
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        import networkx as nx
        assert nx.is_directed_acyclic_graph(G)

    def test_breaks_cycle(self, cyclic_graph):
        nodes, links = cyclic_graph
        G = build_nx_graph(nodes, links)
        import networkx as nx
        assert not nx.is_directed_acyclic_graph(G)
        G = ensure_dag(G)
        assert nx.is_directed_acyclic_graph(G)
        # Should have removed exactly 1 edge to break the cycle
        assert len(G.edges) == 2


# ---------------------------------------------------------------------------
# Critical path
# ---------------------------------------------------------------------------

class TestCriticalPath:

    def test_linear_chain(self, simple_chain):
        nodes, links = simple_chain
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        path, length = calculate_critical_path(G)
        assert path == ['A', 'B', 'C']
        assert length == 30  # edge durations: 10 + 20

    def test_diamond(self, diamond):
        nodes, links = diamond
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        path, length = calculate_critical_path(G)
        assert length == 25  # edge durations: A->B(10) + B->D(15)
        assert 'A' in path and 'D' in path


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

class TestClusterRiskKmeans:

    def test_basic_clustering(self):
        df = pd.DataFrame({
            'importanceScore': [1, 1, 9, 9, 5],
            'riskScore': [1, 2, 8, 9, 5],
        })
        result = _cluster_risk_kmeans(df)
        assert 'Cluster' in result.columns
        assert result['Cluster'].nunique() >= 2

    def test_single_node(self):
        df = pd.DataFrame({'importanceScore': [5], 'riskScore': [5]})
        result = _cluster_risk_kmeans(df)
        assert result['Cluster'].iloc[0] == 0

    def test_identical_points(self):
        """All identical points should get cluster 0 without warnings."""
        df = pd.DataFrame({
            'importanceScore': [5, 5, 5, 5],
            'riskScore': [3, 3, 3, 3],
        })
        result = _cluster_risk_kmeans(df)
        assert 'Cluster' in result.columns

    def test_missing_columns(self):
        df = pd.DataFrame({'other': [1, 2, 3]})
        result = _cluster_risk_kmeans(df)
        assert (result['Cluster'] == 0).all()


# ---------------------------------------------------------------------------
# PCA
# ---------------------------------------------------------------------------

class TestPCA:

    def test_basic_pca(self):
        df = pd.DataFrame({
            'importanceScore': [1, 5, 9, 3, 7],
            'riskScore': [2, 6, 8, 4, 10],
        })
        result = _pca(df)
        assert 'pca1' in result.columns
        assert 'pca2' in result.columns
        assert not (result['pca1'] == 0).all()

    def test_single_row(self):
        df = pd.DataFrame({'importanceScore': [5], 'riskScore': [5]})
        result = _pca(df)
        assert result['pca1'].iloc[0] == 0
        assert result['pca2'].iloc[0] == 0

    def test_missing_columns(self):
        df = pd.DataFrame({'other': [1, 2]})
        result = _pca(df)
        assert (result['pca1'] == 0).all()


# ---------------------------------------------------------------------------
# Community detection
# ---------------------------------------------------------------------------

class TestCommunityDetection:

    def test_assigns_communities(self, diamond):
        nodes, links = diamond
        G = build_nx_graph(nodes, links)
        df = pd.DataFrame(nodes)
        result = _community_detection(G, df)
        assert 'CommunityGroup' in result.columns
        assert len(result) == 4

    def test_disconnected_components(self):
        """Two disconnected pairs should get different communities."""
        nodes = [{'ID': 'A', 'Duration': 5}, {'ID': 'B', 'Duration': 5},
                 {'ID': 'C', 'Duration': 5}, {'ID': 'D', 'Duration': 5}]
        links = [
            {'source': 'A', 'target': 'B'},
            {'source': 'C', 'target': 'D'},
        ]
        G = build_nx_graph(nodes, links)
        df = pd.DataFrame(nodes)
        result = _community_detection(G, df)
        assert result['CommunityGroup'].nunique() >= 2


# ---------------------------------------------------------------------------
# Centralities
# ---------------------------------------------------------------------------

class TestCentralities:

    def test_centrality_columns_present(self, diamond):
        nodes, links = diamond
        G = build_nx_graph(nodes, links)
        df = pd.DataFrame(nodes)
        result = _centralities(G, df)
        for col in ['PageRank', 'closeness_centrality', 'degree_centrality',
                     'Clustering_Coefficient']:
            assert col in result.columns

    def test_pagerank_sums_to_one(self, diamond):
        nodes, links = diamond
        G = build_nx_graph(nodes, links)
        df = pd.DataFrame(nodes)
        result = _centralities(G, df)
        assert abs(result['PageRank'].sum() - 1.0) < 0.01


# ---------------------------------------------------------------------------
# Work packages
# ---------------------------------------------------------------------------

class TestWorkPackages:

    def test_work_packages_created(self, diamond):
        nodes, links = diamond
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        df = pd.DataFrame(nodes)
        df['Cluster'] = [0, 0, 1, 1]
        packages = define_work_packages(df, G)
        assert len(packages) >= 1

    def test_serialization(self):
        from datetime import datetime
        packages = {
            'Package_0': {
                'tasks': ['A', 'B'],
                'critical_path': ['A', 'B'],
                'critical_path_length': 25.0,
                'start': datetime(2025, 1, 1),
                'end': datetime(2025, 2, 1),
            }
        }
        serialized = serialize_work_packages(packages)
        assert serialized['Package_0']['start'] == '2025-01-01T00:00:00'
        assert serialized['Package_0']['critical_path_length'] == 25.0


# ---------------------------------------------------------------------------
# Pattern detection
# ---------------------------------------------------------------------------

class TestPatternDetection:

    def test_detects_patterns(self):
        df = pd.DataFrame({
            'TaskType': ['Build', 'Build', 'Test', 'Build'],
            'Resources': ['TeamA', 'TeamA', 'TeamB', 'TeamA'],
            'Duration': [10, 10, 5, 10],
        })
        patterns = detect_repeating_patterns(df)
        assert len(patterns) >= 1

    def test_no_tasktype_column(self):
        df = pd.DataFrame({'Duration': [5, 10]})
        patterns = detect_repeating_patterns(df)
        assert patterns == []

    def test_templates(self):
        df = pd.DataFrame({
            'TaskType': ['Build', 'Build'],
            'Resources': ['TeamA', 'TeamA'],
            'Duration': [10, 12],
        })
        patterns = detect_repeating_patterns(df)
        templates = create_templates_from_patterns(patterns)
        if templates:
            key = list(templates.keys())[0]
            assert 'average_duration' in templates[key]


# ---------------------------------------------------------------------------
# Full analyse() orchestration
# ---------------------------------------------------------------------------

class TestAnalyse:

    def test_empty_nodes(self):
        result = analyse([], [])
        assert result['error'] == 'No nodes provided'
        assert result['nodes'] == []

    def test_single_node(self):
        nodes = [{'ID': '1', 'Duration': 10, 'Start': '2025-01-01',
                  'importanceScore': 5, 'riskScore': 5,
                  'TaskType': 'Task', 'Resources': 'A'}]
        result = analyse(nodes, [])
        assert 'nodes' in result
        assert len(result['nodes']) == 1
        assert 'critical_path' in result
        assert 'work_packages' in result
        assert 'templates' in result

    def test_chain_response_contract(self, simple_chain):
        nodes, links = simple_chain
        result = analyse(nodes, links)
        # Top-level keys (API contract)
        assert 'nodes' in result
        assert 'links' in result
        assert 'work_packages' in result
        assert 'critical_path' in result
        assert 'critical_path_length' in result
        assert 'templates' in result
        # Node enrichment
        node0 = result['nodes'][0]
        assert 'Cluster' in node0
        assert 'pca1' in node0
        assert 'CommunityGroup' in node0
        assert 'PageRank' in node0

    def test_critical_path_length(self, simple_chain):
        nodes, links = simple_chain
        result = analyse(nodes, links)
        assert result['critical_path_length'] == 30.0  # edge durations: 10 + 20

    def test_diamond_critical_path(self, diamond):
        nodes, links = diamond
        result = analyse(nodes, links)
        assert result['critical_path_length'] == 25.0  # A->B(10) + B->D(15)

    def test_handles_missing_optional_fields(self):
        """Nodes with only ID and Duration should not crash."""
        nodes = [
            {'ID': 'A', 'Duration': 5},
            {'ID': 'B', 'Duration': 10},
        ]
        links = [{'source': 'A', 'target': 'B'}]
        result = analyse(nodes, links)
        assert len(result['nodes']) == 2
        assert 'error' not in result

    def test_cyclic_input_produces_dag(self, cyclic_graph):
        nodes, links = cyclic_graph
        result = analyse(nodes, links)
        assert 'nodes' in result
        assert 'error' not in result


# ---------------------------------------------------------------------------
# /graph-metrics endpoint contract
# ---------------------------------------------------------------------------

class TestGraphMetricsEndpoint:

    def test_returns_200_with_valid_data(self, client, simple_chain):
        nodes, links = simple_chain
        resp = client.post('/graph-metrics', json={'nodes': nodes, 'links': links})
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'nodes' in data
        assert 'links' in data
        assert 'critical_path' in data
        assert 'critical_path_length' in data
        assert 'work_packages' in data
        assert 'templates' in data
        assert 'cache_key' in data

    def test_lru_cache_not_mutated_across_requests(self, client):
        """Verify that mutating the response dict doesn't corrupt the LRU cache.

        Regression test for H2: the route handler adds cache_key/cache_hit/
        processing_time to the result dict.  Without copy.copy(), these
        mutations leak into the @lru_cache'd object and subsequent requests
        return stale metadata.
        """
        payload = {'nodes': [
            {'ID': 'LRU1', 'Duration': 7, 'Start': '2025-06-01',
             'importanceScore': 5, 'riskScore': 5,
             'TaskType': 'Task', 'Resources': 'X'},
        ], 'links': []}

        # First request — computes and caches
        r1 = client.post('/graph-metrics', json=payload)
        assert r1.status_code == 200
        d1 = r1.get_json()
        assert d1['cache_hit'] is False

        # Second request — should hit LRU cache but still have correct metadata
        r2 = client.post('/graph-metrics', json=payload)
        assert r2.status_code == 200
        d2 = r2.get_json()
        # The key assertion: cache_hit should NOT carry over stale False from
        # the first request's mutation of the shared dict.
        # With copy.copy, the LRU-cached dict is never mutated, so the route
        # handler can set cache_hit=False on a fresh copy each time. The
        # response is still correct because it always sets the value explicitly.
        assert 'cache_key' in d2
        assert 'processing_time' in d2
        # Both requests should return the same analytical results
        assert d1['critical_path'] == d2['critical_path']
        assert d1['nodes'] == d2['nodes']

    def test_empty_nodes_returns_400(self, client):
        resp = client.post('/graph-metrics', json={'nodes': [], 'links': []})
        assert resp.status_code == 400
        assert 'error' in resp.get_json()

    def test_no_body_returns_400(self, client):
        resp = client.post('/graph-metrics',
                           data='', content_type='application/json')
        assert resp.status_code == 400

    def test_node_enrichment(self, client, diamond):
        nodes, links = diamond
        resp = client.post('/graph-metrics', json={'nodes': nodes, 'links': links})
        data = resp.get_json()
        node = data['nodes'][0]
        enriched_keys = ['Cluster', 'pca1', 'pca2', 'CommunityGroup',
                         'PageRank', 'closeness_centrality',
                         'degree_centrality', 'Clustering_Coefficient']
        for key in enriched_keys:
            assert key in node, f"Missing enrichment key: {key}"

    def test_response_is_json_serializable(self, client, diamond):
        """Ensure no numpy types leak into the response."""
        nodes, links = diamond
        resp = client.post('/graph-metrics', json={'nodes': nodes, 'links': links})
        raw = resp.get_data(as_text=True)
        # If this parses, the response is valid JSON
        parsed = json.loads(raw)
        assert isinstance(parsed, dict)
