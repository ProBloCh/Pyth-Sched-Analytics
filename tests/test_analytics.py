"""
Unit and integration tests for descriptive analytics (app.py).

Covers: build_nx_graph, ensure_dag, clustering, PCA, community detection,
centralities, critical path, work packages, analyse() orchestration,
and the /graph-metrics endpoint contract.
"""

import json

import pandas as pd
import pytest

from app import (
    _centralities,
    _cluster_risk,
    _community_detection,
    _pca,
    analyse,
    app,
    build_nx_graph,
    calculate_critical_path,
    create_templates_from_patterns,
    define_work_packages,
    detect_repeating_patterns,
    ensure_dag,
    serialize_work_packages,
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

    def test_missing_duration_defaults_to_1(self):
        """All nodes lacking Duration should get duration=1, not crash."""
        nodes = [{'ID': 'X'}]
        G = build_nx_graph(nodes, [])
        assert G.nodes['X']['duration'] == 1

    def test_missing_start_and_duration(self):
        """Nodes with neither Start nor Duration should build cleanly."""
        nodes = [{'ID': 'A'}, {'ID': 'B'}]
        links = [{'source': 'A', 'target': 'B'}]
        G = build_nx_graph(nodes, links)
        assert len(G.nodes) == 2
        assert G.nodes['A']['start_date'] is None
        assert G.nodes['A']['duration'] == 1

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

    def test_records_removed_edges(self, cyclic_graph):
        """ensure_dag publishes removed edges on G.graph for the caller."""
        nodes, links = cyclic_graph
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        removed = G.graph['cycles_removed']
        assert isinstance(removed, list)
        assert len(removed) == 1
        entry = removed[0]
        assert set(entry.keys()) == {'source', 'target', 'type', 'lag'}
        # The removed edge must have come from the input cycle.
        assert (entry['source'], entry['target']) in {
            ('A', 'B'), ('B', 'C'), ('C', 'A')
        }
        assert G.graph['cycles_remaining'] is False

    def test_cycle_edge_choice_is_deterministic(self, cyclic_graph):
        """The cycle-edge tie-break is canonical: it picks the
        lexicographically smallest (source, target, type, lag) tuple,
        regardless of input link ordering."""
        nodes, links = cyclic_graph

        # Same cycle, two distinct insertion orders.
        G1 = build_nx_graph(nodes, links)
        G2 = build_nx_graph(nodes, list(reversed(links)))

        G1 = ensure_dag(G1)
        G2 = ensure_dag(G2)

        edge1 = (G1.graph['cycles_removed'][0]['source'],
                 G1.graph['cycles_removed'][0]['target'])
        edge2 = (G2.graph['cycles_removed'][0]['source'],
                 G2.graph['cycles_removed'][0]['target'])
        assert edge1 == edge2
        # Lexicographically smallest of {(A,B), (B,C), (C,A)} is (A,B).
        assert edge1 == ('A', 'B')

    def test_no_cycle_keeps_lists_empty(self, simple_chain):
        nodes, links = simple_chain
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        assert G.graph['cycles_removed'] == []
        assert G.graph['cycles_remaining'] is False

    def test_multi_disjoint_cycles_deterministic_within_fixed_ordering(self):
        """Two disjoint cycles in the same input must produce identical
        cycles_removed lists across repeated runs of that exact input.
        Cross-input-permutation invariance is P-3 scope (cache
        canonicalisation) and is NOT promised here."""
        nodes = [{'ID': c, 'Duration': 1} for c in 'ABCDEF']
        links = [
            {'source': 'A', 'target': 'B'},
            {'source': 'B', 'target': 'C'},
            {'source': 'C', 'target': 'A'},  # cycle 1
            {'source': 'D', 'target': 'E'},
            {'source': 'E', 'target': 'F'},
            {'source': 'F', 'target': 'D'},  # cycle 2
        ]

        run1 = ensure_dag(build_nx_graph(nodes, links))
        run2 = ensure_dag(build_nx_graph(nodes, links))
        assert run1.graph['cycles_removed'] == run2.graph['cycles_removed']
        # Both cycles must have been broken.
        assert len(run1.graph['cycles_removed']) == 2

    def test_cap_hit_sets_cycles_remaining(self):
        """When the cycle-removal cap is exhausted before all cycles are
        broken, cycles_remaining must be True so the response can flag
        the partial sanitisation."""
        # max_cycle_removals = max(|E|//2, 1).  With 3 edges and two
        # disjoint cycles (self-loop on A, plus B<->C), cap=1 but two
        # removals are needed.  Whatever cycle find_cycle returns first,
        # the other remains after the single allowed removal.
        nodes = [{'ID': c, 'Duration': 1} for c in 'ABC']
        links = [
            {'source': 'A', 'target': 'A'},   # cycle 1: self-loop
            {'source': 'B', 'target': 'C'},
            {'source': 'C', 'target': 'B'},   # cycle 2: 2-cycle
        ]
        G = ensure_dag(build_nx_graph(nodes, links))
        assert G.graph['cycles_remaining'] is True
        assert len(G.graph['cycles_removed']) == 1


# ---------------------------------------------------------------------------
# Critical path
# ---------------------------------------------------------------------------

class TestCriticalPath:

    def test_linear_chain(self, simple_chain):
        nodes, links = simple_chain
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        path, length, tf_map = calculate_critical_path(G)
        assert path == ['A', 'B', 'C']
        assert length == 35  # CPM makespan: A(10) + B(20) + C(5)

    def test_diamond(self, diamond):
        nodes, links = diamond
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        path, length, tf_map = calculate_critical_path(G)
        assert length == 30  # CPM makespan: A(10) + B(15) + D(5)
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
        result = _cluster_risk(df)
        assert 'Cluster' in result.columns
        assert result['Cluster'].nunique() >= 2

    def test_single_node(self):
        df = pd.DataFrame({'importanceScore': [5], 'riskScore': [5]})
        result = _cluster_risk(df)
        assert result['Cluster'].iloc[0] == 0

    def test_identical_points(self):
        """All identical points should get cluster 0 without warnings."""
        df = pd.DataFrame({
            'importanceScore': [5, 5, 5, 5],
            'riskScore': [3, 3, 3, 3],
        })
        result = _cluster_risk(df)
        assert 'Cluster' in result.columns

    def test_missing_columns(self):
        df = pd.DataFrame({'other': [1, 2, 3]})
        result = _cluster_risk(df)
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
        assert result['critical_path_length'] == 35.0  # CPM makespan: A(10)+B(20)+C(5)

    def test_diamond_critical_path(self, diamond):
        nodes, links = diamond
        result = analyse(nodes, links)
        assert result['critical_path_length'] == 30.0  # CPM makespan: A(10)+B(15)+D(5)

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

    def test_cyclic_input_surfaces_cycles_removed(self, cyclic_graph):
        """Response must publish cycles_removed + a structured warning."""
        nodes, links = cyclic_graph
        result = analyse(nodes, links)
        assert isinstance(result.get('cycles_removed'), list)
        assert len(result['cycles_removed']) == 1
        assert set(result['cycles_removed'][0].keys()) == {
            'source', 'target', 'type', 'lag'
        }
        codes = {w['code'] for w in result.get('warnings', [])}
        # Warning code is `cycles_removed_summary` -- the top-level
        # `cycles_removed` field carries the list itself, and the two
        # share no name so consumers can branch on the code without
        # disambiguation.
        assert 'cycles_removed_summary' in codes
        assert 'cycles_remaining' not in codes  # cap not hit on this fixture

    def test_dag_input_has_empty_cycle_fields(self, simple_chain):
        """No cycles -> empty cycles_removed and empty warnings."""
        nodes, links = simple_chain
        result = analyse(nodes, links)
        assert result.get('cycles_removed') == []
        # warnings list is present (always) but holds no cycle entries.
        codes = {w['code'] for w in result.get('warnings', [])}
        assert 'cycles_removed_summary' not in codes
        assert 'cycles_remaining' not in codes

    def test_propagated_risk_deterministic_on_residual_cycles(self):
        """When ensure_dag leaves residual cycles, _risk_propagation must
        produce identical output across repeated calls (was nondeterministic
        before: the fallback walked nodes in insertion order and treated
        unvisited predecessors as 0.0)."""
        import networkx as nx
        from app import _risk_propagation

        # Build a graph with a self-sustaining cycle that ensure_dag would
        # break.  We construct G directly and skip ensure_dag so the
        # residual-cycle branch of _risk_propagation is exercised.
        risk_scores = {'A': 5.0, 'B': 7.0, 'C': 3.0, 'D': 4.0}
        df = pd.DataFrame([
            {'ID': k, 'riskScore': v, 'CommunityGroup': 0}
            for k, v in risk_scores.items()
        ])

        def _build():
            G = nx.DiGraph()
            for n in df['ID']:
                G.add_node(n)
            # A -> B -> C -> A is a cycle; D feeds in from outside.
            G.add_edge('A', 'B')
            G.add_edge('B', 'C')
            G.add_edge('C', 'A')
            G.add_edge('D', 'A')
            return G

        out1 = _risk_propagation(_build(), df.copy())
        out2 = _risk_propagation(_build(), df.copy())
        vals1 = dict(zip(out1['ID'].astype(str),
                         out1['propagated_risk'].astype(float)))
        vals2 = dict(zip(out2['ID'].astype(str),
                         out2['propagated_risk'].astype(float)))
        assert vals1 == vals2
        # Every node should have a finite, non-zero propagated risk
        # (intrinsic is non-zero and propagation is well-defined).
        for v in vals1.values():
            assert v == v  # not NaN
            assert v != 0.0

    def test_self_loop_endpoint_path_is_bounded(self):
        """In the normal path ensure_dag removes the self-loop, so
        propagated_risk is computed acyclically with no self-edge
        contribution.  The self-loop must appear in cycles_removed."""
        nodes = [
            {'ID': 'A', 'Duration': 1, 'riskScore': 2.0},
            {'ID': 'B', 'Duration': 1, 'riskScore': 3.0},
        ]
        links = [
            {'source': 'A', 'target': 'A'},  # self-loop on A
            {'source': 'A', 'target': 'B'},
        ]
        result = analyse(nodes, links)
        a_row = next(n for n in result['nodes'] if n['ID'] == 'A')
        # Without the self-loop fix, this was ~52 at 50 Jacobi iters.
        # After ensure_dag drops the self-edge, propagated_risk_A is
        # just the intrinsic (no external preds).
        assert a_row['propagated_risk'] < 10.0
        # The self-loop edge should appear in the removed-cycles list.
        removed = {(e['source'], e['target']) for e in result['cycles_removed']}
        assert ('A', 'A') in removed

    def test_residual_self_loop_dropped_from_inflow(self):
        """When ensure_dag's cap leaves a self-loop in G,
        _propagate_with_residual_cycles must drop the self-edge from the
        inflow average -- otherwise propagated_risk scales with the
        Jacobi iter cap (pre-fix: 2.0 intrinsic → ~52 after 50 iters)."""
        import networkx as nx
        from app import _risk_propagation

        df = pd.DataFrame([
            {'ID': 'A', 'riskScore': 2.0, 'CommunityGroup': 0},
        ])
        G = nx.DiGraph()
        G.add_node('A')
        G.add_edge('A', 'A')  # self-loop survives because we skip ensure_dag

        result = _risk_propagation(G, df.copy())
        val = float(result['propagated_risk'].iloc[0])
        # Self-edge dropped → no inflow → propagated_risk == intrinsic.
        assert val == pytest.approx(2.0, rel=1e-6)
        # The function records the drop so analyse() can emit a warning.
        assert G.graph.get('self_loops_dropped', 0) >= 1

    def test_pure_cycle_falls_back_to_intrinsic_with_warning(self):
        """Pure k-cycle SCC with no external pred has no fixed point under
        the averaging propagation.  The implementation must (1) record
        scc_non_convergent for the warning channel, and (2) write the
        intrinsic riskScore -- not the cap-linear Jacobi residue, which
        empirically grew ~130 at 50 iters, ~255 at 100, ~1254 at 500
        before this fix -- to propagated_risk for the SCC members."""
        import networkx as nx
        from app import _risk_propagation

        risk_scores = {'A': 5.0, 'B': 7.0, 'C': 3.0}
        df = pd.DataFrame([
            {'ID': k, 'riskScore': v, 'CommunityGroup': 0}
            for k, v in risk_scores.items()
        ])
        G = nx.DiGraph()
        for n in df['ID']:
            G.add_node(n)
        # Pure 3-cycle, no external input.
        G.add_edge('A', 'B')
        G.add_edge('B', 'C')
        G.add_edge('C', 'A')

        out = _risk_propagation(G, df.copy())
        # Non-convergence recorded so analyse() can emit the warning.
        assert G.graph.get('scc_non_convergent_count', 0) >= 1
        # propagated_risk falls back to intrinsic riskScore -- bounded,
        # iteration-cap-independent, and pairs with the warning.
        vals = dict(zip(out['ID'].astype(str),
                        out['propagated_risk'].astype(float)))
        assert vals['A'] == pytest.approx(risk_scores['A'], rel=1e-9)
        assert vals['B'] == pytest.approx(risk_scores['B'], rel=1e-9)
        assert vals['C'] == pytest.approx(risk_scores['C'], rel=1e-9)


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
        # Cycle-handling fields are always-present (empty for DAG inputs).
        assert data['cycles_removed'] == []
        assert isinstance(data.get('warnings'), list)

    def test_cyclic_input_endpoint_surface(self, client, cyclic_graph):
        """/graph-metrics must surface cycles_removed + warnings to HTTP."""
        nodes, links = cyclic_graph
        resp = client.post('/graph-metrics',
                           json={'nodes': nodes, 'links': links})
        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data['cycles_removed']) == 1
        entry = data['cycles_removed'][0]
        assert set(entry.keys()) == {'source', 'target', 'type', 'lag'}
        codes = {w['code'] for w in data['warnings']}
        assert 'cycles_removed_summary' in codes

    def test_lru_cache_not_mutated_across_requests(self, client):
        """Regression test for H2: the route handler adds cache_key/cache_hit/
        processing_time to the response.  The @lru_cache'd dict must never be
        mutated — the route builds a new dict via {**cached, ...} instead.

        Without this protection, top-level keys written into the first response
        leak into the cached object and subsequent requests return stale
        metadata (wrong cache_hit, wrong processing_time).
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

        # Second request — LRU cache hit, must still produce correct metadata
        r2 = client.post('/graph-metrics', json=payload)
        assert r2.status_code == 200
        d2 = r2.get_json()
        assert 'cache_key' in d2
        assert 'processing_time' in d2
        # Analytical results must be identical
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

    def test_oversized_request_returns_413(self, client):
        """MAX_CONTENT_LENGTH should reject oversized requests."""
        from app import MAX_REQUEST_BYTES
        # Send a body larger than the configured limit
        oversized = b'x' * (MAX_REQUEST_BYTES + 1)
        resp = client.post('/graph-metrics', data=oversized,
                           content_type='application/json')
        assert resp.status_code == 413
