"""
Pyth-Sched-Analytics • Optimised v3.0 (Production-Ready)
==============================================================
Includes: Redis caching, NetworkKit acceleration, sparse matrices,
vectorized operations, and Python 3.12 optimizations
"""

import os, json, logging, hashlib, time, gc
from functools import lru_cache
from datetime import datetime, timezone
import pickle

# Set BLAS threads to prevent CPU contention with Gunicorn
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

import numpy as np
import pandas as pd
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import shortest_path
import redis

# NetworkKit imports with fallback
try:
    import networkit as nk
    from networkit import nxadapter as nka
    _NK = True
    logging.info("NetworkKit loaded successfully - using C++ acceleration")
except ImportError:
    _NK = False
    logging.warning("NetworkKit not available - falling back to NetworkX (slower)")

import networkx as nx  # Single canonical import

# Configuration
SMALL_GRAPH_THRESHOLD = int(os.getenv("SMALL_GRAPH_THRESHOLD", 2000))
MAX_PATTERN_NODES = int(os.getenv("MAX_PATTERN_NODES", 1000))
MAX_PATTERNS = int(os.getenv("MAX_PATTERNS", 10))
# Cache sizing: With multi-minute requests, consider CACHE_SIZE=128+ if hit rate drops below 80%
CACHE_SIZE = int(os.getenv("CACHE_SIZE", 32))
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", 120))
DEBUG = os.getenv("DEBUG", "false").lower() == "true"
ENABLE_SILHOUETTE_OPTIMIZATION = os.getenv("ENABLE_SILHOUETTE_OPTIMIZATION", "false").lower() == "true"
COMMUNITY_RESOLUTION = float(os.getenv("COMMUNITY_RESOLUTION", 1.0))
MAX_COMMUNITY_RATIO = float(os.getenv("MAX_COMMUNITY_RATIO", 0.3))
GATEWAY_PERCENTILE = float(os.getenv("GATEWAY_PERCENTILE", 90))

# Relationship type coupling weights (FS tightest, SF loosest)
_RELATIONSHIP_COUPLING = {'FS': 1.0, 'SS': 0.85, 'FF': 0.85, 'SF': 0.5}

# Redis configuration
REDIS_URL = os.getenv('REDIS_URL', None)
# TTL should be > typical request cycle time. Lower if cache memory is constrained
REDIS_CACHE_TTL = int(os.getenv('REDIS_CACHE_TTL', 3600))  # 1 hour default

###############################################################################
# Flask setup                                                                 #
###############################################################################

app = Flask(__name__)

# Set production log level
log_level = logging.DEBUG if DEBUG else logging.WARNING
logging.basicConfig(
    level=log_level,
    format="%(asctime)s %(levelname)s » %(message)s"
)

# Enable CORS with explicit configuration
CORS(app, 
     resources={r"/*": {"origins": "*"}},
     allow_headers=["Content-Type", "Authorization"],
     methods=["GET", "POST", "OPTIONS"])

###############################################################################
# Redis Cache Setup                                                           #
###############################################################################

redis_client = None
if REDIS_URL:
    try:
        # Create connection pool for better performance
        from redis.connection import ConnectionPool
        redis_pool = ConnectionPool.from_url(
            REDIS_URL,
            max_connections=20,
            decode_responses=False,
            socket_connect_timeout=5,
            socket_timeout=5,
            retry_on_timeout=True,
            health_check_interval=30
        )
        redis_client = redis.Redis(connection_pool=redis_pool)
        redis_client.ping()
        logging.info("Redis cache connected successfully")
    except Exception as e:
        logging.warning(f"Redis connection failed: {e}. Falling back to in-memory cache.")
        redis_client = None

REDIS_RETRY_DELAY = 0.25  # seconds between retries for transient Redis errors

def get_cached_result(key):
    """Try Redis first, then fall back to LRU cache. Retries once on transient errors."""
    if redis_client:
        for attempt in range(2):
            try:
                cached = redis_client.get(key)
                if cached:
                    if DEBUG:
                        logging.info(f"Redis cache hit for key: {key[:8]}...")
                    return pickle.loads(cached)
                return None  # key simply not present — no retry needed
            except (redis.ConnectionError, redis.TimeoutError) as e:
                if attempt == 0:
                    logging.warning(f"Redis get transient error (retrying): {e}")
                    time.sleep(REDIS_RETRY_DELAY)
                else:
                    logging.warning(f"Redis get failed after retry: {e}")
            except Exception as e:
                logging.warning(f"Redis get failed: {e}")
                break
    return None

def set_cached_result(key, value, ttl=None):
    """Store in Redis if available. Retries once on transient errors."""
    if redis_client:
        for attempt in range(2):
            try:
                serialized = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
                redis_client.setex(key, ttl or REDIS_CACHE_TTL, serialized)
                if DEBUG:
                    logging.info(f"Cached result in Redis: {key[:8]}...")
                return
            except (redis.ConnectionError, redis.TimeoutError) as e:
                if attempt == 0:
                    logging.warning(f"Redis set transient error (retrying): {e}")
                    time.sleep(REDIS_RETRY_DELAY)
                else:
                    logging.warning(f"Redis set failed after retry: {e}")
            except Exception as e:
                logging.warning(f"Redis set failed: {e}")
                break

###############################################################################
# Helpers                                                                     #
###############################################################################

def _sha(payload):
    """Generate cache key from payload"""
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()

@lru_cache(maxsize=CACHE_SIZE)
def _cached(nodes_json: str, links_json: str):
    """In-memory LRU cache as second-level cache"""
    return analyse(json.loads(nodes_json), json.loads(links_json))

###############################################################################
# Pattern Detection (from v1)                                                 #
###############################################################################

def detect_repeating_patterns(nodes_df):
    """Optimized pattern detection using categorical dtypes"""
    if 'TaskType' not in nodes_df.columns:
        logging.warning("No 'TaskType' column found in nodes data. Skipping pattern detection.")
        return []

    if 'Resources' not in nodes_df.columns:
        logging.warning("No 'Resources' column found in nodes data. Skipping pattern detection.")
        return []

    # Only copy the subset we need to avoid doubling peak memory on large inputs
    cols = ['TaskType', 'Resources', 'Duration', 'Dependencies'] if 'Dependencies' in nodes_df.columns else ['TaskType', 'Resources', 'Duration']
    limit = min(len(nodes_df), MAX_PATTERN_NODES)
    if limit < len(nodes_df) and DEBUG:
        logging.info(f"Large graph ({len(nodes_df)} nodes). Sampling first {limit} for patterns.")
    sample_df = nodes_df[cols].head(limit).copy()

    # Use categorical dtype for memory efficiency
    sample_df['TaskType'] = sample_df['TaskType'].astype('category')
    sample_df['Resources'] = sample_df['Resources'].astype('category')
    
    # Create pattern key more efficiently with discretized duration
    # Round duration to avoid float precision issues
    duration_discrete = (sample_df['Duration'].round(1) * 10).astype(int)
    pattern_key = (sample_df['TaskType'].cat.codes * 100000 + 
                  duration_discrete * 100 + 
                  sample_df['Resources'].cat.codes)
    
    sample_df['pattern_id'] = pd.factorize(pattern_key)[0]
    
    # Use value_counts for faster grouping
    pattern_counts = sample_df['pattern_id'].value_counts()
    valid_patterns = pattern_counts[pattern_counts > 1].index
    
    # Return only top patterns by frequency
    pattern_records = [sample_df[sample_df['pattern_id'] == pid] 
                      for pid in valid_patterns[:MAX_PATTERNS]]
    
    return pattern_records

def create_templates_from_patterns(pattern_records):
    templates = {}
    for index, pattern_df in enumerate(pattern_records):
        template = {
            'average_duration': float(pattern_df['Duration'].mean()),
            'duration_variance': float(pattern_df['Duration'].var()),
            'most_common_resources': pattern_df['Resources'].mode().tolist(),
            'dependency_links': pattern_df['Dependencies'].mode().tolist() if 'Dependencies' in pattern_df.columns else [],
            'task_frequency': len(pattern_df)
        }
        templates[f"Template_{index}"] = template
    return templates

###############################################################################
# Critical Path & Activities (from v1)                                       #
###############################################################################

def calculate_critical_path(G):
    """Calculate critical path using NetworkX DAG algorithms"""
    # Note: NetworkKit doesn't have direct critical path support
    # so we use NetworkX which is optimized for this
    critical_path = nx.dag_longest_path(G, weight='duration')
    critical_path_length = nx.dag_longest_path_length(G, weight='duration')
    return critical_path, critical_path_length

def identify_critical_activities_and_milestones(G):
    critical_activities = [
        node for node in G.nodes if (
            G.nodes[node].get('Milestone') == 1 or
            G.nodes[node].get('isImportanceOutlier', False) or
            G.nodes[node].get('isOnCriticalPath', False) or
            G.nodes[node].get('isOnOutlierPath', False) or
            G.nodes[node].get('isRiskOutlier', False)
        )
    ]
    return set(critical_activities)

###############################################################################
# Work Packages (from v1)                                                     #
###############################################################################

def define_work_packages(nodes_df, G, critical_path=None):
    work_packages = {}

    if 'Cluster' not in nodes_df.columns:
        logging.warning("Cluster data not found in DataFrame.")
        return work_packages

    cp_set = set(critical_path) if critical_path else set()

    # Pre-extract dates from graph for efficiency
    node_dates = {}
    for node in G.nodes():
        node_dates[node] = {
            'start': G.nodes[node].get('start_date'),
            'end': G.nodes[node].get('end_date')
        }

    # Process each cluster
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

        # Efficient date collection using pre-extracted data
        valid_starts = [node_dates[t]['start'] for t in tasks
                       if t in node_dates and node_dates[t]['start'] is not None]
        valid_ends = [node_dates[t]['end'] for t in tasks
                     if t in node_dates and node_dates[t]['end'] is not None]

        if not valid_starts or not valid_ends:
            if DEBUG:
                logging.warning(f"No valid dates for cluster {cluster}. Skipping.")
            continue

        # Controls KPIs
        tasks_set = set(tasks)
        cp_in_cluster = len(tasks_set & cp_set)
        cp_concentration = cp_in_cluster / len(tasks) if tasks else 0

        interface_edges = sum(
            1 for u, v in G.edges()
            if (u in tasks_set) != (v in tasks_set)
        )

        avg_risk = 0.0
        if 'riskScore' in cluster_nodes.columns:
            avg_risk = float(pd.to_numeric(
                cluster_nodes['riskScore'], errors='coerce'
            ).fillna(0).mean())

        work_packages[f'Package_{cluster}'] = {
            'tasks': tasks,
            'critical_path': sub_critical_path,
            'critical_path_length': sub_critical_duration,
            'start': min(valid_starts),
            'end': max(valid_ends),
            'critical_path_concentration': round(cp_concentration, 3),
            'interface_edge_count': interface_edges,
            'average_risk': round(avg_risk, 3),
        }

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
                if hasattr(start_date, 'tzinfo') and start_date.tzinfo is not None:
                    start_date = start_date.replace(tzinfo=None)
                start_str = start_date.isoformat() if hasattr(start_date, 'isoformat') else str(start_date)
            else:
                start_str = None

            if end_date is not None:
                if hasattr(end_date, 'tzinfo') and end_date.tzinfo is not None:
                    end_date = end_date.replace(tzinfo=None)
                end_str = end_date.isoformat() if hasattr(end_date, 'isoformat') else str(end_date)
            else:
                end_str = None
            
            serialized_packages[key] = {
                'tasks': package['tasks'],
                'critical_path': package['critical_path'],
                'critical_path_length': float(package['critical_path_length']),
                'start': start_str,
                'end': end_str,
                'critical_path_concentration': package.get('critical_path_concentration', 0),
                'interface_edge_count': package.get('interface_edge_count', 0),
                'average_risk': package.get('average_risk', 0),
            }
        except Exception as e:
            logging.warning(f"Error serializing work package {key}: {e}")
            serialized_packages[key] = {
                'tasks': package.get('tasks', []),
                'critical_path': package.get('critical_path', []),
                'critical_path_length': float(package.get('critical_path_length', 0)),
                'start': None,
                'end': None,
                'critical_path_concentration': 0,
                'interface_edge_count': 0,
                'average_risk': 0,
            }
    return serialized_packages

###############################################################################
# Graph builders - Optimized with vectorization                              #
###############################################################################

def build_nx_graph(nodes, links):
    """Optimized graph building with vectorized operations"""
    G = nx.DiGraph()
    
    # Bulk add edges with coupling-aware weights
    # Weight reflects construction coupling: type strength × duration / (1 + |lag|)
    edge_list = []
    for l in links:
        rel_type = l.get('type', 'FS')
        lag = l.get('lag', 0)
        duration = max(l.get('duration', 1), 1)
        type_w = _RELATIONSHIP_COUPLING.get(rel_type, 0.7)
        coupling = type_w * duration / (1 + abs(lag))
        edge_list.append((str(l['source']), str(l['target']), {
            'weight': coupling,
            'duration': duration,
            'type': rel_type,
            'lag': lag
        }))
    G.add_edges_from(edge_list)
    
    # Vectorized node attribute processing
    nodes_df = pd.DataFrame(nodes)
    if len(nodes_df) == 0:
        return G
        
    # Ensure ID column exists
    if 'ID' not in nodes_df.columns:
        nodes_df['ID'] = range(len(nodes_df))
    
    # Vectorized date parsing
    nodes_df['start_date'] = pd.to_datetime(nodes_df.get('Start'), errors='coerce', utc=False)
    # Remove timezone info if present (future-compatible check)
    if getattr(nodes_df['start_date'].dtype, 'tz', None) is not None:
        nodes_df['start_date'] = nodes_df['start_date'].dt.tz_localize(None)
    
    nodes_df['duration'] = pd.to_numeric(nodes_df.get('Duration', 1), errors='coerce').fillna(1)
    
    # Vectorized end date calculation
    nodes_df['end_date'] = nodes_df['start_date'] + pd.to_timedelta(nodes_df['duration'], unit='D', errors='coerce')
    
    # Vectorized boolean conversions with safer casting
    bool_cols = ['isImportanceOutlier', 'isOnCriticalPath', 'isOnOutlierPath', 'isRiskOutlier']
    
    # Handle Milestone separately with safer conversion
    if 'Milestone' in nodes_df.columns:
        nodes_df['Milestone'] = pd.to_numeric(nodes_df['Milestone'], errors='coerce').fillna(0).astype(int) == 1
    else:
        nodes_df['Milestone'] = False
    
    # Handle other boolean columns
    for col in bool_cols:
        if col in nodes_df.columns:
            nodes_df[col] = nodes_df[col].astype(str).str.lower() == 'true'
        else:
            nodes_df[col] = False
    
    # Bulk add nodes with attributes
    node_attrs = {}
    for idx, row in nodes_df.iterrows():
        nid = str(row['ID'])
        node_attrs[nid] = {
            'start_date': row['start_date'] if pd.notna(row['start_date']) else None,
            'end_date': row['end_date'] if pd.notna(row['end_date']) else None,
            'duration': row['duration'],
            'Milestone': row['Milestone'],
            'isImportanceOutlier': row['isImportanceOutlier'],
            'isOnCriticalPath': row['isOnCriticalPath'],
            'isOnOutlierPath': row['isOnOutlierPath'],
            'isRiskOutlier': row['isRiskOutlier']
        }
    
    # Add all nodes at once
    G.add_nodes_from(node_attrs.keys())
    nx.set_node_attributes(G, node_attrs)
    
    return G

def ensure_dag(G: nx.DiGraph):
    """Enhanced DAG creation using NetworkKit when available"""
    if DEBUG:
        logging.info(f"Initial Graph: {len(G)} nodes, {len(G.edges)} edges")
    
    if _NK and len(G) > 100:
        try:
            # Use NetworkKit for cycle detection (faster)
            G_nk = nka.nx2nk(G)
            if not nk.graphtools.isDAG(G_nk):
                # Fall back to NetworkX for cycle removal
                # NetworkKit doesn't have direct cycle removal
                pass
        except Exception as e:
            logging.warning(f"NetworkKit DAG check failed: {e}")
    
    # Remove cycles using NetworkX
    cycles_removed = 0
    while True:
        try:
            cycle = nx.find_cycle(G, orientation='original')
            u, v = cycle[0][0], cycle[0][1]
            G.remove_edge(u, v)
            cycles_removed += 1
            if DEBUG:
                logging.info(f"Removed edge to break cycle: {u} -> {v}")
        except nx.NetworkXNoCycle:
            break
    
    if DEBUG and cycles_removed > 0:
        logging.info(f"Removed {cycles_removed} edges to break cycles")
    
    # Connect orphan nodes to start/end milestones (from v1)
    start_milestones = [n for n in G.nodes if G.nodes[n].get('Milestone') and G.in_degree(n) == 0]
    end_milestones = [n for n in G.nodes if G.nodes[n].get('Milestone') and G.out_degree(n) == 0]
    
    if start_milestones and end_milestones:
        start_milestone = start_milestones[0]
        end_milestone = end_milestones[0]
        
        # Connect orphan start nodes
        orphan_starts = [node for node in G.nodes 
                        if G.in_degree(node) == 0 and node != start_milestone]
        if orphan_starts:
            G.add_edges_from([(start_milestone, node) for node in orphan_starts])
            if DEBUG:
                logging.info(f"Connected {len(orphan_starts)} orphan start nodes")
        
        # Connect orphan end nodes
        orphan_ends = [node for node in G.nodes 
                      if G.out_degree(node) == 0 and node != end_milestone]
        if orphan_ends:
            G.add_edges_from([(node, end_milestone) for node in orphan_ends])
            if DEBUG:
                logging.info(f"Connected {len(orphan_ends)} orphan end nodes")
    
    return G

###############################################################################
# Analytics – Optimized algorithms                                           #
###############################################################################

def _cluster_risk_kmeans(df: pd.DataFrame):
    """K-means clustering with controls-aware features and optional silhouette optimization"""
    if 'importanceScore' not in df.columns or 'riskScore' not in df.columns:
        df['Cluster'] = 0
        return df

    # Build feature matrix: start with core risk dimensions, add controls columns if available
    feature_cols = ['importanceScore', 'riskScore']
    for col in ['avgWeightedRisk', 'Duration']:
        if col in df.columns:
            series = pd.to_numeric(df[col], errors='coerce').fillna(0)
            if series.std() > 0:  # only include if it carries signal
                feature_cols.append(col)

    feats = df[feature_cols].apply(pd.to_numeric, errors='coerce').fillna(0).values.astype(float)

    # Normalize when using more than the original 2 features so scale differences
    # between e.g. Duration (days) and riskScore (1-10) don't dominate KMeans
    if feats.shape[1] > 2:
        col_mean = np.mean(feats, axis=0)
        col_std = np.std(feats, axis=0)
        col_std[col_std == 0] = 1
        feats = (feats - col_mean) / col_std

    n = len(df)
    
    if n < 2:
        df['Cluster'] = 0
        return df
    
    # Fast heuristic path (default)
    if not ENABLE_SILHOUETTE_OPTIMIZATION:
        # Heuristic: sqrt(n/2) clusters, bounded between 2 and 10
        k = max(2, min(10, int(np.sqrt(n / 2))))
        
        if DEBUG:
            logging.info(f"Using heuristic k={k} for {n} nodes (silhouette optimization disabled)")
        
        try:
            df['Cluster'] = KMeans(k, n_init='auto', random_state=0).fit_predict(feats)
        except ValueError:
            df['Cluster'] = 0
        return df
    
    # Silhouette optimization path (only if explicitly enabled)
    if DEBUG:
        logging.info(f"Running silhouette optimization for {n} nodes")
    
    # Early exit for small datasets
    if n <= 15:
        k = min(3, n)
        try:
            df['Cluster'] = KMeans(k, n_init='auto', random_state=0).fit_predict(feats)
        except ValueError:
            df['Cluster'] = 0
        return df
    
    # Full silhouette optimization
    max_clusters = min(10, n)
    best, k = -1, min(3, n)
    
    for c in range(2, max_clusters + 1):
        if c >= n: 
            break
        try:
            kmeans = KMeans(c, n_init='auto', random_state=0)
            lbl = kmeans.fit_predict(feats)
            if len(set(lbl)) > 1:
                sc = silhouette_score(feats, lbl)
                if DEBUG:
                    logging.info(f"Silhouette Score for {c} clusters: {sc:.3f}")
                if sc > best:
                    best, k = sc, c
        except Exception:
            continue
    
    # Guard against edge cases
    k = min(k, max(1, n))
    try:
        df['Cluster'] = KMeans(k, n_init='auto', random_state=0).fit_predict(feats)
    except ValueError:
        df['Cluster'] = 0
    
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
    """Big graph dependency grouping using NetworkKit Louvain"""
    if not _NK:
        # Fallback to small graph method
        return _dependency_groups_small(G_nx, df)
    
    try:
        # Convert to undirected for community detection
        G_undirected = G_nx.to_undirected()
        # Store node list before conversion to maintain order
        node_list = list(G_undirected.nodes())
        G_nk = nka.nx2nk(G_undirected)
        
        # Use Louvain algorithm (much faster than modularity)
        algo = nk.community.PLM(G_nk)
        algo.run()
        partition = algo.getPartition()
        
        # Map back to dataframe using pre-conversion node list
        node_to_comm = {}
        for node_idx in range(len(node_list)):
            comm_id = partition.subsetOf(node_idx)
            node_id = node_list[node_idx]
            node_to_comm[node_id] = comm_id
        
        df['DependencyCluster'] = df['ID'].astype(str).map(node_to_comm).fillna(0).astype(int)
        
        if DEBUG:
            n_clusters = partition.numberOfSubsets()
            logging.info(f"NetworkKit Louvain found {n_clusters} dependency clusters")
            
    except Exception as e:
        logging.warning(f"NetworkKit dependency clustering failed: {e}")
        return _dependency_groups_small(G_nx, df)
    
    return df

def _dependency_groups_small(G: nx.DiGraph, df: pd.DataFrame):
    """Small graph dependency clustering using sparse matrices"""
    ids = df['ID'].astype(str).tolist()
    n = len(ids)
    
    if n < 2:
        df['DependencyCluster'] = 0
        return df
    
    try:
        # Create adjacency matrix
        id_to_idx = {id_val: idx for idx, id_val in enumerate(ids)}
        
        # Build sparse adjacency matrix
        row_ind = []
        col_ind = []
        data = []
        
        for u, v, d in G.edges(data=True):
            if str(u) in id_to_idx and str(v) in id_to_idx:
                i, j = id_to_idx[str(u)], id_to_idx[str(v)]
                weight = d.get('weight', 1)
                row_ind.extend([i, j])
                col_ind.extend([j, i])
                data.extend([weight, weight])
        
        # Create sparse matrix
        adj_sparse = csr_matrix((data, (row_ind, col_ind)), shape=(n, n))
        
        # Use scipy's sparse shortest path
        dist_sparse = shortest_path(adj_sparse, method='D', directed=False)
        
        # Convert inf to large number for clustering
        dist_sparse[np.isinf(dist_sparse)] = 1e9
        
        # Early exit for very small graphs
        if n <= 5:
            best_n_clusters = min(2, n)
        else:
            # Silhouette optimization
            max_clusters = min(10, n // 2)
            best_score = -1
            best_n_clusters = min(3, n)
            
            clustering_kwargs = _AGGLOMERATIVE_PRECOMPUTED_KWARGS
            for n_clusters in range(2, max_clusters + 1):
                if n_clusters >= n:
                    break
                try:
                    clustering = AgglomerativeClustering(
                        n_clusters=n_clusters,
                        linkage='complete',
                        **clustering_kwargs
                    )
                    labels = clustering.fit_predict(dist_sparse)
                    if len(set(labels)) > 1:
                        score = silhouette_score(dist_sparse, labels, metric='precomputed')
                        if DEBUG:
                            logging.info(f"Dependency clustering silhouette for {n_clusters}: {score:.3f}")
                        if score > best_score:
                            best_score = score
                            best_n_clusters = n_clusters
                except Exception as e:
                    logging.warning(f"Clustering failed for {n_clusters} clusters: {e}")
                    continue
        
        # Final clustering
        best_n_clusters = min(best_n_clusters, n)
        clustering = AgglomerativeClustering(
            n_clusters=best_n_clusters,
            linkage='complete',
            **_AGGLOMERATIVE_PRECOMPUTED_KWARGS
        )
        df['DependencyCluster'] = clustering.fit_predict(dist_sparse)
        
    except Exception as e:
        logging.error(f"Dependency clustering failed: {e}")
        df['DependencyCluster'] = 0
    
    return df

def _detect_agglomerative_precomputed_kwargs():
    """Detect compatible kwargs for precomputed distance clustering across sklearn versions."""
    try:
        AgglomerativeClustering(metric='precomputed')
        return {'metric': 'precomputed'}
    except TypeError:
        return {'affinity': 'precomputed'}

_AGGLOMERATIVE_PRECOMPUTED_KWARGS = _detect_agglomerative_precomputed_kwargs()

def _centralities(G: nx.DiGraph, df: pd.DataFrame):
    """Compute centralities with NetworkKit acceleration when available"""
    node_ids = df['ID'].astype(str).tolist()
    
    # Use NetworkKit for better performance if available (lower threshold)
    if _NK and len(G) > 50:
        try:
            # Capture node list BEFORE conversion to maintain order
            node_list = list(G.nodes())
            
            # Convert to NetworkKit
            G_nk = nka.nx2nk(G)
            
            # Map NetworkX node IDs to NetworkKit indices using pre-conversion node list
            nx_to_nk = {node: idx for idx, node in enumerate(node_list)}
            
            # Compute centralities using NetworkKit (C++ implementation)
            pr = nk.centrality.PageRank(G_nk, damp=0.9).run().scores()
            
            # For directed graphs, use harmonic closeness
            close = nk.centrality.HarmonicCloseness(G_nk, normalized=True).run().scores()
            
            # Degree centrality
            deg = nk.centrality.DegreeCentrality(G_nk, normalized=True).run().scores()
            
            # Betweenness centrality
            betw = nk.centrality.Betweenness(G_nk, normalized=True).run().scores()

            # Clustering coefficient (need undirected)
            G_undirected = nka.nx2nk(G.to_undirected())
            lcc = nk.centrality.LocalClusteringCoefficient(G_undirected).run().scores()

            # Map back to dataframe efficiently
            centrality_data = []
            for idx, row in df.iterrows():
                node_id = str(row['ID'])
                if node_id in nx_to_nk:
                    nk_idx = nx_to_nk[node_id]
                    centrality_data.append({
                        'PageRank': pr[nk_idx],
                        'closeness_centrality': close[nk_idx],
                        'degree_centrality': deg[nk_idx],
                        'betweenness_centrality': betw[nk_idx],
                        'Clustering_Coefficient': lcc[nk_idx]
                    })
                else:
                    centrality_data.append({
                        'PageRank': 0,
                        'closeness_centrality': 0,
                        'degree_centrality': 0,
                        'betweenness_centrality': 0,
                        'Clustering_Coefficient': 0
                    })
            
            # Bulk update dataframe
            centrality_df = pd.DataFrame(centrality_data)
            for col in centrality_df.columns:
                df[col] = centrality_df[col]
                
            if DEBUG:
                logging.info(f"Used NetworkKit for centralities on {len(G)} nodes")
                
        except Exception as e:
            logging.warning(f"NetworkKit centrality computation failed: {e}")
            _centralities_nx(G, df)
    else:
        _centralities_nx(G, df)
    
    return df

def _centralities_nx(G: nx.DiGraph, df: pd.DataFrame):
    """Pure NetworkX centrality computation"""
    pr = nx.pagerank(G, alpha=0.9)
    close = nx.closeness_centrality(G)
    deg = nx.degree_centrality(G)
    betw = nx.betweenness_centrality(G, normalized=True)
    clust = nx.clustering(G.to_undirected())

    id_str = df['ID'].astype(str)
    df['PageRank'] = id_str.map(pr).fillna(0)
    df['closeness_centrality'] = id_str.map(close).fillna(0)
    df['degree_centrality'] = id_str.map(deg).fillna(0)
    df['betweenness_centrality'] = id_str.map(betw).fillna(0)
    df['Clustering_Coefficient'] = id_str.map(clust).fillna(0)

def _community_detection(G: nx.DiGraph, df: pd.DataFrame):
    """Community detection using NetworkKit when available"""
    if _NK and len(G) > 100:
        try:
            # Use NetworkKit's PLM (Louvain) for community detection
            G_undirected = G.to_undirected()
            # Get node list before conversion to maintain order
            node_list = list(G_undirected.nodes())
            G_nk = nka.nx2nk(G_undirected)
            
            # Run PLM algorithm
            algo = nk.community.PLM(G_nk)
            algo.run()
            partition = algo.getPartition()
            
            # Map to dataframe - using pre-conversion node list
            node_to_comm = {}
            for node_idx in range(len(node_list)):
                comm_id = partition.subsetOf(node_idx)
                node_id = node_list[node_idx]
                node_to_comm[node_id] = comm_id
            
            df['CommunityGroup'] = df['ID'].astype(str).map(node_to_comm).fillna(-1).astype(int)
            
            if DEBUG:
                n_communities = partition.numberOfSubsets()
                logging.info(f"NetworkKit found {n_communities} communities")
                
        except Exception as e:
            logging.warning(f"NetworkKit community detection failed: {e}")
            _community_detection_nx(G, df)
    else:
        _community_detection_nx(G, df)
    
    return df

def _community_detection_nx(G: nx.DiGraph, df: pd.DataFrame):
    """NetworkX community detection fallback"""
    try:
        G_undirected = G.to_undirected()
        if G_undirected.number_of_edges() == 0:
            df['CommunityGroup'] = 0
            return df

        try:
            communities = nx.algorithms.community.louvain_communities(
                G_undirected,
                weight='weight',
                resolution=COMMUNITY_RESOLUTION,
                seed=0
            )
        except AttributeError:
            communities = nx.algorithms.community.greedy_modularity_communities(
                G_undirected,
                weight='weight'
            )
        
        node_community_dict = {}
        for community_id, nodes in enumerate(communities):
            for node in nodes:
                node_community_dict[node] = community_id
        
        df['CommunityGroup'] = df['ID'].astype(str).map(node_community_dict).fillna(-1).astype(int)
    except Exception as e:
        logging.warning(f"Community detection failed: {e}")
        df['CommunityGroup'] = 0

###############################################################################
# Multi-resolution community detection                                        #
###############################################################################

_TIER_LABELS = {
    0.1: 'ultra_coarse', 0.3: 'macro_systems', 0.5: 'macro_systems',
    1.0: 'systems', 2.0: 'work_packages', 2.5: 'work_packages', 4.0: 'work_fronts',
}

def _resolution_ladder(n_nodes):
    """Adaptive resolution ladder based on schedule size (from guidance doc)."""
    if n_nodes < 100:
        return [0.5, 1.0, 2.0]
    if n_nodes < 500:
        return [0.3, 1.0, 2.5]
    if n_nodes < 5000:
        return [0.3, 1.0, 2.5, 4.0]
    return [0.1, 0.3, 1.0, 2.5, 4.0]

def _run_louvain(G_undirected, gamma):
    """Single Louvain run at a given resolution. Returns list-of-sets."""
    if _NK and len(G_undirected) > 100:
        try:
            node_list = list(G_undirected.nodes())
            G_nk = nka.nx2nk(G_undirected)
            algo = nk.community.PLM(G_nk, gamma=gamma)
            algo.run()
            partition = algo.getPartition()
            comm_map = {}
            for node_idx in range(len(node_list)):
                comm_id = partition.subsetOf(node_idx)
                comm_map.setdefault(comm_id, set()).add(node_list[node_idx])
            return list(comm_map.values())
        except Exception as e:
            logging.warning(f"NetworkKit Louvain (γ={gamma}) failed: {e}")
    # NetworkX fallback
    try:
        return list(nx.algorithms.community.louvain_communities(
            G_undirected, weight='weight', resolution=gamma, seed=0
        ))
    except AttributeError:
        return list(nx.algorithms.community.greedy_modularity_communities(
            G_undirected, weight='weight'
        ))

def _enforce_max_community_size(G_undirected, communities, gamma, n_total):
    """Split oversized communities by re-running Louvain at 2× resolution on the subgraph."""
    max_size = max(int(n_total * MAX_COMMUNITY_RATIO), 2)
    result = []
    for comm in communities:
        if len(comm) <= max_size:
            result.append(comm)
        else:
            subgraph = G_undirected.subgraph(comm)
            try:
                sub_comms = list(nx.algorithms.community.louvain_communities(
                    subgraph, weight='weight', resolution=gamma * 2, seed=0
                ))
                result.extend(sub_comms)
            except Exception:
                result.append(comm)
    return result

def _multi_resolution_communities(G, df, deadline=None):
    """Run Louvain at multiple resolutions, build tiered community structure."""
    n = len(G)
    if n < 2:
        df['CommunityGroup'] = 0
        return df, {'tiers': []}

    G_undirected = G.to_undirected()
    if G_undirected.number_of_edges() == 0:
        df['CommunityGroup'] = 0
        return df, {'tiers': []}

    ladder = _resolution_ladder(n)
    tiers = []
    default_set = False

    for gamma in ladder:
        if deadline:
            _check_deadline(deadline, f"community detection γ={gamma}")

        communities = _run_louvain(G_undirected, gamma)
        communities = _enforce_max_community_size(G_undirected, communities, gamma, n)

        # Build node → community mapping
        node_to_comm = {}
        for comm_id, members in enumerate(communities):
            for node in members:
                node_to_comm[node] = comm_id

        label = _TIER_LABELS.get(gamma, f'tier_{gamma}')
        tier_col = f'CommunityGroup_{label}'
        df[tier_col] = df['ID'].astype(str).map(node_to_comm).fillna(-1).astype(int)

        # The tier matching COMMUNITY_RESOLUTION (default γ=1.0) populates CommunityGroup
        if gamma == COMMUNITY_RESOLUTION:
            df['CommunityGroup'] = df[tier_col]
            default_set = True

        tiers.append({
            'resolution': gamma,
            'label': label,
            'n_communities': len(communities),
            'column': tier_col,
        })

    # Fallback: if COMMUNITY_RESOLUTION wasn't in the ladder, use closest >= 1.0
    if not default_set:
        for t in tiers:
            if t['resolution'] >= 1.0:
                df['CommunityGroup'] = df[t['column']]
                default_set = True
                break
        if not default_set and tiers:
            df['CommunityGroup'] = df[tiers[-1]['column']]

    return df, {'tiers': tiers}

###############################################################################
# Gateway / bridge activity detection                                         #
###############################################################################

def _detect_gateway_activities(df):
    """Flag high-betweenness nodes as gateway/bridge activities for interface management."""
    if 'betweenness_centrality' not in df.columns:
        df['is_gateway'] = False
        return []

    bc = df['betweenness_centrality']
    positive = bc[bc > 0]
    if positive.empty:
        df['is_gateway'] = False
        return []

    threshold = np.percentile(positive, GATEWAY_PERCENTILE)
    mask = bc >= threshold
    df['is_gateway'] = mask
    return df.loc[mask, 'ID'].astype(str).tolist()

###############################################################################
# Main analysis function                                                      #
###############################################################################

class AnalysisTimeout(Exception):
    """Raised when analysis exceeds the configured REQUEST_TIMEOUT."""

def _check_deadline(deadline, stage):
    """Raise AnalysisTimeout if the deadline has passed."""
    if time.monotonic() > deadline:
        raise AnalysisTimeout(f"Analysis timed out during {stage}")

def analyse(nodes, links):
    deadline = time.monotonic() + REQUEST_TIMEOUT
    try:
        # Validate input
        if not nodes:
            return {
                'error': 'No nodes provided',
                'nodes': [],
                'links': [],
                'work_packages': {},
                'critical_path': [],
                'critical_path_length': 0,
                'templates': {},
                'community_tiers': [],
                'gateway_activities': [],
            }
        
        # Create dataframes
        df_nodes = pd.DataFrame(nodes)
        df_links = pd.DataFrame(links)
        
        # Ensure required columns exist with defaults
        required_columns = {
            'ID': lambda: range(len(df_nodes)),
            'Duration': 1,
            'importanceScore': 5,
            'riskScore': 5,
            'avgWeightedRisk': 0,
            'Resources': '',
            'Dependencies': '',
            'TaskType': 'Task'
        }
        
        for col, default in required_columns.items():
            if col not in df_nodes.columns:
                df_nodes[col] = default() if callable(default) else default
        
        # Build and process graph
        G = build_nx_graph(nodes, links)
        G = ensure_dag(G)
        _check_deadline(deadline, "graph construction")

        # Pattern detection
        pattern_records = detect_repeating_patterns(df_nodes)
        templates = create_templates_from_patterns(pattern_records)

        # Risk/importance clustering + PCA
        clustering_start = time.time() if DEBUG else None
        df_nodes = _cluster_risk_kmeans(df_nodes)
        df_nodes = _pca(df_nodes)
        if DEBUG:
            logging.info(f"Risk/importance clustering took {time.time() - clustering_start:.2f}s")
        _check_deadline(deadline, "clustering")

        # Dependency grouping
        dep_start = time.time() if DEBUG else None
        if len(df_nodes) > SMALL_GRAPH_THRESHOLD:
            df_nodes = _dependency_groups_big(G, df_nodes)
        else:
            df_nodes = _dependency_groups_small(G, df_nodes)
        if DEBUG:
            logging.info(f"Dependency clustering took {time.time() - dep_start:.2f}s")
        _check_deadline(deadline, "dependency grouping")

        # Multi-resolution community detection (replaces single-pass Louvain)
        df_nodes, community_meta = _multi_resolution_communities(G, df_nodes, deadline)

        # Centrality metrics (includes betweenness for gateway detection)
        df_nodes = _centralities(G, df_nodes)
        _check_deadline(deadline, "centrality metrics")

        # Gateway / bridge activity detection
        gateway_activities = _detect_gateway_activities(df_nodes)

        # Critical path (computed before work packages so KPIs can reference it)
        if nx.is_directed_acyclic_graph(G) and len(G) > 0:
            critical_path, critical_path_length = calculate_critical_path(G)
        else:
            critical_path, critical_path_length = [], 0

        # Work packages (enriched with controls KPIs)
        work_packages = define_work_packages(df_nodes, G, critical_path=critical_path)
        work_packages_serialized = serialize_work_packages(work_packages)

        # Build response
        response = {
            'nodes': df_nodes.replace({np.nan: None}).to_dict('records'),
            'links': df_links.replace({np.nan: None}).to_dict('records'),
            'work_packages': work_packages_serialized,
            'critical_path': critical_path,
            'critical_path_length': float(critical_path_length),
            'templates': templates,
            'community_tiers': community_meta.get('tiers', []),
            'gateway_activities': gateway_activities,
        }
        
        # Garbage collection for large graphs
        if len(nodes) > 5000:
            gc.collect()
        
        return response
        
    except Exception as e:
        logging.exception(f"Analysis error: {str(e)}")
        if "tz-naive and tz-aware" in str(e):
            raise ValueError("Timezone mismatch in date data. Please ensure all dates are in the same format.")
        else:
            raise

###############################################################################
# Routes                                                                      #
###############################################################################

@app.route('/graph-metrics', methods=['POST', 'OPTIONS'])
def graph_metrics():
    start_time = time.time()
    
    # Handle preflight
    if request.method == 'OPTIONS':
        return jsonify({'status': 'ok'})
    
    data = request.get_json(force=True, silent=True) or {}
    nodes, links = data.get('nodes', []), data.get('links', [])
    
    if not nodes:
        return jsonify({'error': 'No nodes provided'}), 400
    
    # Generate cache key
    key = _sha([nodes, links])
    redis_key = f"graph:{key}"
    
    # Try Redis cache first
    cached_result = get_cached_result(redis_key)
    if cached_result:
        cached_result.setdefault('cache_key', key)
        cached_result['cache_hit'] = True
        cached_result['processing_time'] = time.time() - start_time
        return jsonify(cached_result)
    
    if DEBUG:
        logging.info(f"Processing graph with {len(nodes)} nodes and {len(links)} links")
    
    try:
        # Use in-memory LRU cache as second level
        res = _cached(
            json.dumps(nodes, sort_keys=True, default=str),
            json.dumps(links, sort_keys=True, default=str)
        )
        res['cache_key'] = key
        res['cache_hit'] = False
        
        # Store in Redis for other instances
        set_cached_result(redis_key, res)
        
        # Log processing time
        elapsed = time.time() - start_time
        if DEBUG or elapsed > 5:
            logging.info(f"Graph processed in {elapsed:.2f}s (nodes: {len(nodes)}, links: {len(links)})")
        res['processing_time'] = elapsed

        return jsonify(res)
        
    except AnalysisTimeout as exc:
        logging.warning('Analysis timed out after %ss: %s', REQUEST_TIMEOUT, exc)
        return jsonify({'error': f'Analysis timed out after {REQUEST_TIMEOUT}s'}), 504
    except Exception as exc:
        logging.exception('Analysis failed: %s', exc)
        error_msg = str(exc)
        if "tz-naive and tz-aware" in error_msg:
            error_msg = "Date format inconsistency detected. Please ensure all dates are in the same timezone format."
        return jsonify({'error': error_msg}), 500

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint with system status"""
    # Check Redis once
    redis_ok = False
    redis_configured = redis_client is not None
    try:
        redis_ok = redis_configured and redis_client.ping()
    except Exception:
        redis_ok = False
    
    # Get LRU cache info
    cache_info = _cached.cache_info()
    
    # Determine overall health status
    status = 'healthy'
    if REDIS_URL and not redis_ok:
        status = 'degraded'  # Redis is configured but not working
    
    health_status = {
        'status': status,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'instance': {
            'site': os.getenv("WEBSITE_SITE_NAME"),
            'instance_id': os.getenv("WEBSITE_INSTANCE_ID"),
            'region': os.getenv("REGION_NAME", "unknown")
        },
        'cache': {
            'redis': redis_ok,
            'redis_configured': redis_configured,
            'lru': {
                'size': cache_info.currsize,
                'hits': cache_info.hits,
                'misses': cache_info.misses,
                'hit_rate': f"{(cache_info.hits / (cache_info.hits + cache_info.misses) * 100):.1f}%" if (cache_info.hits + cache_info.misses) > 0 else "0%"
            }
        },
        'features': {
            'networkit': _NK,
            'redis': redis_configured,
            'silhouette_optimization': ENABLE_SILHOUETTE_OPTIMIZATION
        },
        'settings': {
            'small_graph_threshold': SMALL_GRAPH_THRESHOLD,
            'max_pattern_nodes': MAX_PATTERN_NODES,
            'cache_size': CACHE_SIZE,
            'debug': DEBUG,
            'community_resolution': COMMUNITY_RESOLUTION
        }
    }
    return jsonify(health_status)

@app.route('/test-cors', methods=['GET', 'POST', 'OPTIONS'])
def test_cors():
    """Test endpoint to verify CORS is working"""
    if request.method == 'OPTIONS':
        return jsonify({'status': 'preflight ok'})
    return jsonify({
        'status': 'cors test ok',
        'method': request.method,
        'origin': request.headers.get('Origin', 'no origin header')
    })

@app.route('/', methods=['GET'])
def index():
    """Root endpoint for health checks and crawlers"""
    return jsonify({'status': 'ok', 'service': 'python-sched-analytics'}), 200

@app.errorhandler(HTTPException)
def handle_http_exception(e):
    """Handle HTTP exceptions (404, 405, etc.) properly"""
    response = jsonify({'error': e.description})
    response.status_code = e.code
    return response

@app.errorhandler(Exception)
def unhandled(e):
    logging.exception('Unhandled: %s', e)
    detail = str(e) if DEBUG else 'Internal server error'
    return jsonify({'error': detail}), 500

###############################################################################
# Local dev                                                                   #
###############################################################################

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    # Enable debug mode only in development
    app.run(host='0.0.0.0', port=port, debug=DEBUG)
