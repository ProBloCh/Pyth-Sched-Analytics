"""
Pyth‑Sched‑Analytics • Optimised v2.0 (scales to 10 k × 500 k)
==============================================================
FIXED VERSION - Now includes all v1 functionality
"""

import os, json, logging, hashlib
from functools import lru_cache
from datetime import datetime

from flask import Flask, request, jsonify
from flask_cors import CORS

import numpy as np, pandas as pd
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score

# Optional high‑performance graph library
try:
    import networkit as nk
    from networkit import nxadapter as nka
    _NK = True
except ImportError:
    _NK = False
    import networkx as nx
else:
    import networkx as nx

SMALL_GRAPH_THRESHOLD = int(os.getenv("SMALL_GRAPH_THRESHOLD", 2000))

###############################################################################
# Flask setup                                                                 #
###############################################################################

app = Flask(__name__)
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s » %(message)s")

# Enable CORS with explicit configuration
CORS(app, 
     resources={r"/*": {"origins": "*"}},
     allow_headers=["Content-Type", "Authorization"],
     methods=["GET", "POST", "OPTIONS"])

###############################################################################
# Helpers                                                                     #
###############################################################################

def _sha(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()

def parse_date_safe(date_str):
    """Parse date string and ensure it's timezone-naive"""
    if date_str is None:
        return None
    try:
        date = pd.to_datetime(date_str, errors='coerce')
        if date is pd.NaT:
            return None
        # Remove timezone info if present
        if hasattr(date, 'tz') and date.tz is not None:
            date = date.tz_localize(None)
        return date
    except Exception as e:
        logging.warning(f"Date parsing error for {date_str}: {e}")
        return None

@lru_cache(maxsize=32)
def _cached(nodes_json: str, links_json: str):
    return analyse(json.loads(nodes_json), json.loads(links_json))

###############################################################################
# Pattern Detection (from v1)                                                 #
###############################################################################

def detect_repeating_patterns(nodes_df):
    if 'TaskType' not in nodes_df.columns:
        logging.warning("No 'TaskType' column found in nodes data. Skipping pattern detection.")
        return []

    nodes_df['pattern_id'] = pd.factorize(nodes_df['TaskType'] + '_' +
                                          nodes_df['Duration'].astype(str) + '_' +
                                          nodes_df['Resources'].astype(str))[0]
    pattern_records = [group_df for _, group_df in nodes_df.groupby('pattern_id') if len(group_df) > 1]
    return pattern_records

def create_templates_from_patterns(pattern_records):
    templates = {}
    for index, pattern_df in enumerate(pattern_records):
        template = {
            'average_duration': pattern_df['Duration'].mean(),
            'duration_variance': pattern_df['Duration'].var(),
            'most_common_resources': pattern_df['Resources'].mode().tolist(),
            'dependency_links': pattern_df['Dependencies'].mode().tolist(),
            'task_frequency': len(pattern_df)
        }
        templates[f"Template_{index}"] = template
    return templates

###############################################################################
# Critical Path & Activities (from v1)                                       #
###############################################################################

def calculate_critical_path(G):
    critical_path = nx.dag_longest_path(G, weight='duration')
    critical_path_length = nx.dag_longest_path_length(G, weight='duration')
    return critical_path, critical_path_length

def identify_critical_activities_and_milestones(G):
    critical_activities = [
        node for node in G.nodes if (
            G.nodes[node].get('Milestone') == 1 or
            G.nodes[node].get('isImportanceOutlier', True) or
            G.nodes[node].get('isOnCriticalPath', True) or
            G.nodes[node].get('isOnOutlierPath', True) or
            G.nodes[node].get('isRiskOutlier', True)
        )
    ]
    return set(critical_activities)

###############################################################################
# Work Packages (from v1)                                                     #
###############################################################################

def define_work_packages(nodes_df, G):
    work_packages = {}
    
    if 'Cluster' in nodes_df.columns:
        for cluster in nodes_df['Cluster'].unique():
            cluster_nodes = nodes_df[nodes_df['Cluster'] == cluster]
            tasks = cluster_nodes['ID'].astype(str).tolist()

            # Ensure all nodes exist in the graph
            tasks = [t for t in tasks if t in G]
            if not tasks:
                continue

            subgraph = G.subgraph(tasks)
            
            # Check if subgraph is a DAG before computing longest path
            if nx.is_directed_acyclic_graph(subgraph) and len(subgraph) > 0:
                sub_critical_path = nx.dag_longest_path(subgraph, weight='duration')
                sub_critical_duration = nx.dag_longest_path_length(subgraph, weight='duration')
            else:
                sub_critical_path = []
                sub_critical_duration = 0

            # Get dates and ensure they're timezone-naive
            start_dates = []
            end_dates = []
            
            for node in subgraph:
                start_date = G.nodes[node].get('start_date')
                end_date = G.nodes[node].get('end_date')
                
                # Handle timezone-aware dates
                if start_date is not None and hasattr(start_date, 'tz_localize'):
                    if start_date.tz is not None:
                        start_date = start_date.tz_localize(None)
                    start_dates.append(start_date)
                elif start_date is not None:
                    start_dates.append(start_date)
                    
                if end_date is not None and hasattr(end_date, 'tz_localize'):
                    if end_date.tz is not None:
                        end_date = end_date.tz_localize(None)
                    end_dates.append(end_date)
                elif end_date is not None:
                    end_dates.append(end_date)

            if not start_dates or not end_dates:
                logging.warning(f"No valid dates for cluster {cluster}. Skipping.")
                continue

            work_packages[f'Package_{cluster}'] = {
                'tasks': tasks,
                'critical_path': sub_critical_path,
                'critical_path_length': sub_critical_duration,
                'start': min(start_dates) if start_dates else None,
                'end': max(end_dates) if end_dates else None
            }
    else:
        logging.warning("Cluster data not found in DataFrame.")

    return work_packages

def serialize_work_packages(work_packages):
    serialized_packages = {}
    for key, package in work_packages.items():
        try:
            # Safely serialize dates
            start_date = package['start']
            end_date = package['end']
            
            # Convert to ISO format string, handling timezone issues
            if start_date is not None:
                if hasattr(start_date, 'tz') and start_date.tz is not None:
                    start_date = start_date.tz_localize(None)
                start_str = start_date.isoformat() if hasattr(start_date, 'isoformat') else str(start_date)
            else:
                start_str = None
                
            if end_date is not None:
                if hasattr(end_date, 'tz') and end_date.tz is not None:
                    end_date = end_date.tz_localize(None)
                end_str = end_date.isoformat() if hasattr(end_date, 'isoformat') else str(end_date)
            else:
                end_str = None
            
            serialized_packages[key] = {
                'tasks': package['tasks'],
                'critical_path': package['critical_path'],
                'critical_path_length': float(package['critical_path_length']),
                'start': start_str,
                'end': end_str
            }
        except Exception as e:
            logging.warning(f"Error serializing work package {key}: {e}")
            serialized_packages[key] = {
                'tasks': package.get('tasks', []),
                'critical_path': package.get('critical_path', []),
                'critical_path_length': float(package.get('critical_path_length', 0)),
                'start': None,
                'end': None
            }
    return serialized_packages

###############################################################################
# Graph builders                                                              #
###############################################################################

def build_nx_graph(nodes, links):
    G = nx.DiGraph()
    
    # Add edges
    for l in links:
        s, t = str(l['source']), str(l['target'])
        if not G.has_edge(s, t):
            G.add_edge(s, t, 
                      weight=l.get('duration', 1), 
                      type=l.get('type', 'FS'), 
                      lag=l.get('lag', 0))
    
    # Add nodes with all attributes from v1
    for n in nodes:
        nid = str(n['ID'])
        G.add_node(nid)  # Ensure node exists
        
        # Parse dates - handle timezone issues
        start_date = parse_date_safe(n.get('Start'))
        
        # Calculate end date if we have start_date and duration
        duration = n.get('Duration', 1)
        if start_date is not None and duration:
            try:
                end_date = start_date + pd.Timedelta(days=duration)
            except Exception:
                end_date = None
        else:
            end_date = None
            
        G.nodes[nid].update({
            'start_date': start_date,
            'end_date': end_date,
            'duration': duration,
            'Milestone': int(n.get('Milestone', 0)) == 1,
            'isImportanceOutlier': str(n.get('isImportanceOutlier', 'false')).lower() == 'true',
            'isOnCriticalPath': str(n.get('isOnCriticalPath', 'false')).lower() == 'true',
            'isOnOutlierPath': str(n.get('isOnOutlierPath', 'false')).lower() == 'true',
            'isRiskOutlier': str(n.get('isRiskOutlier', 'false')).lower() == 'true'
        })
    
    return G

def ensure_dag(G: nx.DiGraph):
    """Enhanced DAG creation matching v1's make_dag() functionality"""
    logging.info("Initial Graph Nodes: %d", len(G))
    logging.info("Initial Graph Edges: %d", len(G.edges))
    
    # Remove cycles
    cycles_removed = 0
    while True:
        try:
            cycle = nx.find_cycle(G, orientation='original')
            u, v = cycle[0][0], cycle[0][1]
            G.remove_edge(u, v)
            cycles_removed += 1
            logging.info(f"Removed edge to break cycle: {u} -> {v}")
        except nx.NetworkXNoCycle:
            break
    
    logging.info(f"Removed {cycles_removed} edges to break cycles")
    
    # Connect orphan nodes to start/end milestones (from v1)
    start_milestones = [n for n in G.nodes if G.nodes[n].get('Milestone') and G.in_degree(n) == 0]
    end_milestones = [n for n in G.nodes if G.nodes[n].get('Milestone') and G.out_degree(n) == 0]
    
    if start_milestones and end_milestones:
        start_milestone = start_milestones[0]
        end_milestone = end_milestones[0]
        
        # Connect orphan start nodes
        for node in G.nodes:
            if G.in_degree(node) == 0 and node != start_milestone:
                G.add_edge(start_milestone, node)
                logging.info(f"Added start milestone edge: {start_milestone} -> {node}")
        
        # Connect orphan end nodes
        for node in G.nodes:
            if G.out_degree(node) == 0 and node != end_milestone:
                G.add_edge(node, end_milestone)
                logging.info(f"Added end milestone edge: {node} -> {end_milestone}")
    
    return G

###############################################################################
# Analytics – small (<2 k) vs big graphs                                     #
###############################################################################

def _cluster_risk_kmeans(df: pd.DataFrame):
    """K-means clustering matching v1 behavior"""
    if 'importanceScore' not in df.columns or 'riskScore' not in df.columns:
        df['Cluster'] = 0
        return df
        
    feats = df[['importanceScore', 'riskScore']].values
    n = len(df)
    
    if n < 2:
        df['Cluster'] = 0
        return df
    
    # Match v1's clustering logic more closely
    max_clusters = min(10, n)
    best, k = -1, 3
    
    for c in range(2, max_clusters + 1):
        if c >= n: 
            break
        try:
            kmeans = KMeans(c, n_init='auto', random_state=0)
            lbl = kmeans.fit_predict(feats)
            if len(set(lbl)) > 1:
                sc = silhouette_score(feats, lbl)
                logging.info(f"Silhouette Score for {c} clusters: {sc}")
                if sc > best:
                    best, k = sc, c
        except:
            continue
    
    df['Cluster'] = KMeans(k, n_init='auto', random_state=0).fit_predict(feats)
    return df

def _pca(df):
    """PCA matching v1"""
    if 'importanceScore' not in df.columns or 'riskScore' not in df.columns:
        df['pca1'] = 0
        df['pca2'] = 0
        return df
        
    arr = df[['importanceScore', 'riskScore']].values
    if len(arr) > 1:
        df[['pca1', 'pca2']] = PCA(2).fit_transform(arr)
    else:
        df['pca1'] = 0
        df['pca2'] = 0
    return df

def _dependency_groups_big(G_nx: nx.DiGraph, df: pd.DataFrame):
    """Big graph dependency grouping using Louvain"""
    if not _NK:
        # Fallback to small graph method
        return _dependency_groups_small(G_nx, df)
    
    try:
        G_nk = nka.nx2nk(G_nx)
        algo = nk.community.PLM(G_nk)
        algo.run()
        comm_id = algo.getPartition().getVector()
        
        # Map NetworkX node IDs to networkit indices
        nx_to_nk = {node: idx for idx, node in enumerate(G_nx.nodes())}
        mapping = {node: comm_id[nx_to_nk[node]] for node in G_nx.nodes()}
        
        df['DependencyCluster'] = df['ID'].astype(str).map(mapping).fillna(0).astype(int)
    except Exception as e:
        logging.warning(f"Networkit dependency clustering failed: {e}")
        return _dependency_groups_small(G_nx, df)
    
    return df

def _dependency_groups_small(G: nx.DiGraph, df: pd.DataFrame):
    """Small graph dependency clustering matching v1"""
    ids = df['ID'].astype(str).tolist()
    n = len(ids)
    
    if n < 2:
        df['DependencyCluster'] = 0
        return df
    
    # Build distance matrix
    path = dict(nx.all_pairs_dijkstra_path_length(G, weight='weight'))
    dist = np.full((n, n), 1e9, dtype=float)
    
    for i, s in enumerate(ids):
        for j, t in enumerate(ids):
            if s in path and t in path[s]:
                dist[i, j] = path[s][t]
    
    # Silhouette optimization from v1
    max_clusters = min(10, n)
    best_score = -1
    best_n_clusters = min(3, n)
    
    for n_clusters in range(3, max_clusters):
        if n_clusters >= n:
            break
        try:
            clustering = AgglomerativeClustering(
                n_clusters=n_clusters, 
                linkage='complete', 
                metric='precomputed'
            )
            labels = clustering.fit_predict(dist)
            if len(set(labels)) > 1:
                score = silhouette_score(dist, labels, metric='precomputed')
                logging.info(f"Dependency clustering silhouette for {n_clusters}: {score}")
                if score > best_score:
                    best_score = score
                    best_n_clusters = n_clusters
        except:
            continue
    
    clustering = AgglomerativeClustering(
        n_clusters=best_n_clusters,
        linkage='complete',
        metric='precomputed'
    )
    df['DependencyCluster'] = clustering.fit_predict(dist)
    
    return df

def _centralities(G: nx.DiGraph, df: pd.DataFrame):
    """Compute centralities with networkit acceleration for large graphs"""
    node_ids = df['ID'].astype(str).tolist()
    
    if _NK and len(G) > SMALL_GRAPH_THRESHOLD:
        try:
            # Convert to networkit
            G_nk = nka.nx2nk(G)
            
            # Map NetworkX node IDs to networkit indices
            nx_to_nk = {node: idx for idx, node in enumerate(G.nodes())}
            
            # Compute centralities
            pr = nk.centrality.PageRank(G_nk, alpha=0.9).run().scores()
            close = nk.centrality.Closeness(G_nk, variant=nk.centrality.ClosenessVariant.Harmonic).run().scores()
            deg = nk.centrality.DegreeCentrality(G_nk).run().scores()
            
            # Clustering coefficient
            G_undirected = nka.nx2nk(G.to_undirected())
            coef = nk.centrality.LocalClusteringCoefficient(G_undirected).run().scores()
            
            # Map back to dataframe
            for idx, row in df.iterrows():
                node_id = str(row['ID'])
                if node_id in nx_to_nk:
                    nk_idx = nx_to_nk[node_id]
                    df.at[idx, 'PageRank'] = pr[nk_idx]
                    df.at[idx, 'closeness_centrality'] = close[nk_idx]
                    df.at[idx, 'degree_centrality'] = deg[nk_idx]
                    df.at[idx, 'Clustering_Coefficient'] = coef[nk_idx]
                else:
                    df.at[idx, 'PageRank'] = 0
                    df.at[idx, 'closeness_centrality'] = 0
                    df.at[idx, 'degree_centrality'] = 0
                    df.at[idx, 'Clustering_Coefficient'] = 0
                    
        except Exception as e:
            logging.warning(f"Networkit centrality computation failed: {e}")
            # Fallback to NetworkX
            _centralities_nx(G, df)
    else:
        _centralities_nx(G, df)
    
    return df

def _centralities_nx(G: nx.DiGraph, df: pd.DataFrame):
    """Pure NetworkX centrality computation"""
    # Compute centralities
    pr = nx.pagerank(G, alpha=0.9)
    close = nx.closeness_centrality(G)
    deg = nx.degree_centrality(G)
    clust = nx.clustering(G.to_undirected())
    
    # Map to dataframe
    for idx, row in df.iterrows():
        node_id = str(row['ID'])
        df.at[idx, 'PageRank'] = pr.get(node_id, 0)
        df.at[idx, 'closeness_centrality'] = close.get(node_id, 0)
        df.at[idx, 'degree_centrality'] = deg.get(node_id, 0)
        df.at[idx, 'Clustering_Coefficient'] = clust.get(node_id, 0)

def _community_detection(G: nx.DiGraph, df: pd.DataFrame):
    """Community detection matching v1"""
    try:
        # Use undirected version for community detection
        G_undirected = G.to_undirected()
        communities = nx.algorithms.community.greedy_modularity_communities(G_undirected)
        
        # Create mapping
        node_community_dict = {}
        for community_id, nodes in enumerate(communities):
            for node in nodes:
                node_community_dict[node] = community_id
        
        df['CommunityGroup'] = df['ID'].astype(str).map(node_community_dict).fillna(-1).astype(int)
    except Exception as e:
        logging.warning(f"Community detection failed: {e}")
        df['CommunityGroup'] = 0
    
    return df

###############################################################################
# Main analyse()                                                             #
###############################################################################

def analyse(nodes, links):
    try:
        # Create dataframes
        df_nodes = pd.DataFrame(nodes)
        df_links = pd.DataFrame(links)
        
        # Set default avgWeightedRisk if not present (from v1)
        if 'avgWeightedRisk' not in df_nodes.columns:
            df_nodes['avgWeightedRisk'] = 0
        
        # Build and process graph
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        
        # Pattern detection (from v1)
        pattern_records = detect_repeating_patterns(df_nodes)
        templates = create_templates_from_patterns(pattern_records)
        
        # Risk/importance clustering + PCA
        df_nodes = _cluster_risk_kmeans(df_nodes)
        df_nodes = _pca(df_nodes)
        
        # Dependency grouping
        if len(df_nodes) > SMALL_GRAPH_THRESHOLD:
            df_nodes = _dependency_groups_big(G, df_nodes)
        else:
            df_nodes = _dependency_groups_small(G, df_nodes)
        
        # Community detection (from v1)
        df_nodes = _community_detection(G, df_nodes)
        
        # Centrality metrics
        df_nodes = _centralities(G, df_nodes)
        
        # Work packages (from v1)
        work_packages = define_work_packages(df_nodes, G)
        work_packages_serialized = serialize_work_packages(work_packages)
        
        # Critical path (from v1)
        if nx.is_directed_acyclic_graph(G) and len(G) > 0:
            critical_path, critical_path_length = calculate_critical_path(G)
        else:
            critical_path, critical_path_length = [], 0
        
        # Build response matching v1 API
        response = {
            'nodes': df_nodes.replace({np.nan: None}).to_dict('records'),
            'links': df_links.replace({np.nan: None}).to_dict('records'),
            'work_packages': work_packages_serialized,
            # Additional fields that might be expected
            'critical_path': critical_path,
            'critical_path_length': float(critical_path_length),
            'templates': templates
        }
        
        return response
        
    except Exception as e:
        logging.exception(f"Analysis error: {str(e)}")
        # Provide more specific error messages
        if "tz-naive and tz-aware" in str(e):
            raise ValueError("Timezone mismatch in date data. Please ensure all dates are in the same format.")
        else:
            raise

###############################################################################
# Routes                                                                      #
###############################################################################

@app.route('/graph-metrics', methods=['POST', 'OPTIONS'])
def graph_metrics():
    # Handle preflight
    if request.method == 'OPTIONS':
        response = jsonify({'status': 'ok'})
        response.headers.add('Access-Control-Allow-Origin', '*')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        response.headers.add('Access-Control-Allow-Methods', 'POST')
        return response
    
    data = request.get_json(force=True, silent=True) or {}
    nodes, links = data.get('nodes', []), data.get('links', [])
    
    if not nodes:
        return jsonify({'error': 'No nodes provided'}), 400
    
    # Generate cache key
    key = _sha([nodes, links])
    
    try:
        # Use cached result if available
        res = _cached(
            json.dumps(nodes, sort_keys=True, default=str),
            json.dumps(links, sort_keys=True, default=str)
        )
        res['cache_key'] = key
        response = jsonify(res)
        response.headers.add('Access-Control-Allow-Origin', '*')
        return response
    except Exception as exc:
        logging.exception('Analysis failed: %s', exc)
        # Provide cleaner error messages
        error_msg = str(exc)
        if "tz-naive and tz-aware" in error_msg:
            error_msg = "Date format inconsistency detected. Please ensure all dates are in the same timezone format."
        response = jsonify({'error': error_msg})
        response.headers.add('Access-Control-Allow-Origin', '*')
        return response, 500

@app.route('/health', methods=['GET'])
def health():
    response = jsonify({'status': 'healthy'})
    response.headers.add('Access-Control-Allow-Origin', '*')
    return response

@app.route('/test-cors', methods=['GET', 'POST', 'OPTIONS'])
def test_cors():
    """Test endpoint to verify CORS is working"""
    if request.method == 'OPTIONS':
        response = jsonify({'status': 'preflight ok'})
    else:
        response = jsonify({
            'status': 'cors test ok',
            'method': request.method,
            'origin': request.headers.get('Origin', 'no origin header')
        })
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
    response.headers.add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    return response

@app.errorhandler(Exception)
def unhandled(e):
    logging.exception('Unhandled: %s', e)
    response = jsonify({'error': str(e)})
    response.headers.add('Access-Control-Allow-Origin', '*')
    return response, 500

@app.after_request
def after_request(response):
    """Ensure CORS headers are always present"""
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    return response

###############################################################################
# Local dev                                                                   #
###############################################################################

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    # Enable CORS in development mode
    app.run(host='0.0.0.0', port=port, debug=False)