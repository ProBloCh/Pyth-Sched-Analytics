"""
Integration tests for solver Flask endpoints.

Uses Flask's test client — no actual HTTP server needed.
Tests request validation, error handling, and response contracts.
"""

import json
import pytest


# =====================================================================
# Happy-path endpoint tests
# =====================================================================

class TestSensitivityEndpoint:

    def test_returns_200(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        resp = client.post('/solver/sensitivity',
                           json={'nodes': nodes, 'links': links})
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'objectives' in data
        assert 'sensitivity' in data
        assert data['makespan'] == 42.0

    def test_with_config(self, client, diamond_schedule, diamond_metadata):
        nodes, links = diamond_schedule
        resp = client.post('/solver/sensitivity', json={
            'nodes': nodes,
            'links': links,
            'solver_config': {
                'disciplines': ['schedule', 'cost'],
                'weights': {'schedule': 0.6, 'cost': 0.4},
            },
            'activity_metadata': diamond_metadata,
            'project_context': {'phase': 'construction'},
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert set(data['objectives'].keys()) == {'schedule', 'cost'}

    def test_options_preflight(self, client):
        resp = client.options('/solver/sensitivity')
        assert resp.status_code == 200


class TestOptimizeEndpoint:

    def test_returns_200(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        resp = client.post('/solver/optimize', json={
            'nodes': nodes,
            'links': links,
            'solver_config': {'max_iterations': 5},
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'initial_objectives' in data
        assert 'final_objectives' in data
        assert 'activity_changes' in data
        assert len(data['activity_changes']) == 5


class TestParetoEndpoint:

    def test_returns_200(self, client, diamond_schedule):
        nodes, links = diamond_schedule
        resp = client.post('/solver/pareto', json={
            'nodes': nodes,
            'links': links,
            'solver_config': {
                'disciplines': ['schedule', 'cost'],
                'pareto_vectors': 3,
                'max_iterations': 5,
            },
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'frontier' in data
        assert 'n_frontier' in data
        assert data['n_explored'] == 3


class TestHealthEndpoint:

    def test_solver_health(self, client):
        resp = client.get('/solver/health')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['status'] == 'healthy'
        assert data['module'] == 'cadj-p-solver'

    def test_main_health(self, client):
        """Existing /health must still work."""
        resp = client.get('/health')
        assert resp.status_code == 200
        assert resp.get_json()['status'] in ('healthy', 'degraded')


# =====================================================================
# Existing endpoint not broken
# =====================================================================

class TestGraphMetricsUnaffected:

    def test_returns_200(self, client):
        resp = client.post('/graph-metrics', json={
            'nodes': [
                {'ID': '1', 'Duration': 10, 'Start': '2025-01-01',
                 'TaskType': 'Task', 'Resources': 'A',
                 'importanceScore': 5, 'riskScore': 5},
            ],
            'links': [],
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'nodes' in data
        assert 'critical_path' in data


# =====================================================================
# Input validation
# =====================================================================

class TestValidation:

    def test_no_body(self, client):
        resp = client.post('/solver/sensitivity',
                           data='', content_type='application/json')
        assert resp.status_code == 400
        assert 'error' in resp.get_json()

    def test_empty_nodes(self, client):
        resp = client.post('/solver/sensitivity', json={'nodes': []})
        assert resp.status_code == 400

    def test_nodes_not_list(self, client):
        resp = client.post('/solver/sensitivity', json={'nodes': 'bad'})
        assert resp.status_code == 400
        assert 'list' in resp.get_json()['error']

    def test_node_missing_id(self, client):
        resp = client.post('/solver/sensitivity',
                           json={'nodes': [{'Duration': 5}]})
        assert resp.status_code == 400
        assert 'ID' in resp.get_json()['error']

    def test_duplicate_id(self, client):
        resp = client.post('/solver/sensitivity', json={
            'nodes': [
                {'ID': 'A', 'Duration': 5},
                {'ID': 'A', 'Duration': 10},
            ],
        })
        assert resp.status_code == 400
        assert 'Duplicate' in resp.get_json()['error']

    def test_negative_duration(self, client):
        resp = client.post('/solver/sensitivity', json={
            'nodes': [{'ID': 'A', 'Duration': -5}],
        })
        assert resp.status_code == 400
        assert 'non-negative' in resp.get_json()['error']

    def test_nan_duration(self, client):
        resp = client.post('/solver/sensitivity', json={
            'nodes': [{'ID': 'A', 'Duration': float('nan')}],
        })
        assert resp.status_code == 400

    def test_link_unknown_source(self, client):
        resp = client.post('/solver/sensitivity', json={
            'nodes': [{'ID': 'A', 'Duration': 5}],
            'links': [{'source': 'Z', 'target': 'A'}],
        })
        assert resp.status_code == 400
        assert 'unknown source' in resp.get_json()['error']

    def test_link_unknown_target(self, client):
        resp = client.post('/solver/sensitivity', json={
            'nodes': [{'ID': 'A', 'Duration': 5}],
            'links': [{'source': 'A', 'target': 'Z'}],
        })
        assert resp.status_code == 400
        assert 'unknown target' in resp.get_json()['error']

    def test_link_missing_source(self, client):
        resp = client.post('/solver/sensitivity', json={
            'nodes': [{'ID': 'A', 'Duration': 5}],
            'links': [{'target': 'A'}],
        })
        assert resp.status_code == 400
        assert 'missing source' in resp.get_json()['error']

    def test_invalid_max_iterations(self, client):
        resp = client.post('/solver/sensitivity', json={
            'nodes': [{'ID': 'A', 'Duration': 5}],
            'solver_config': {'max_iterations': 0},
        })
        assert resp.status_code == 400

    def test_invalid_mc_samples(self, client):
        resp = client.post('/solver/sensitivity', json={
            'nodes': [{'ID': 'A', 'Duration': 5}],
            'solver_config': {'monte_carlo_samples': 99999},
        })
        assert resp.status_code == 400

    def test_negative_learning_rate(self, client):
        resp = client.post('/solver/sensitivity', json={
            'nodes': [{'ID': 'A', 'Duration': 5}],
            'solver_config': {'learning_rate': -0.01},
        })
        assert resp.status_code == 400

    def test_valid_request_passes_validation(self, client, diamond_schedule,
                                             diamond_metadata):
        """Full valid request passes all validation."""
        nodes, links = diamond_schedule
        resp = client.post('/solver/sensitivity', json={
            'nodes': nodes,
            'links': links,
            'solver_config': {
                'disciplines': ['schedule', 'cost'],
                'max_iterations': 50,
                'monte_carlo_samples': 100,
                'learning_rate': 0.01,
                'convergence_threshold': 0.001,
            },
            'activity_metadata': diamond_metadata,
            'project_context': {'phase': 'construction'},
        })
        assert resp.status_code == 200
