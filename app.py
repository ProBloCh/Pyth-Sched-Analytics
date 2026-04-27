"""
Pyth-Sched-Analytics • Optimised v3.0 (Production-Ready)
==============================================================
Includes: Redis caching, NetworkKit acceleration, sparse matrices,
vectorized operations, and Python 3.12 optimizations
"""

import os, json, logging, hashlib, time, gc
from functools import lru_cache
from datetime import datetime, timezone

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
MAX_REQUEST_BYTES = int(os.getenv("MAX_REQUEST_BYTES", 10 * 1024 * 1024))  # 10 MB
DEBUG = os.getenv("DEBUG", "false").lower() == "true"
ENABLE_SILHOUETTE_OPTIMIZATION = os.getenv("ENABLE_SILHOUETTE_OPTIMIZATION", "false").lower() == "true"
COMMUNITY_RESOLUTION = float(os.getenv("COMMUNITY_RESOLUTION", 1.0))

# Redis configuration
REDIS_URL = os.getenv('REDIS_URL', None)
# TTL should be > typical request cycle time. Lower if cache memory is constrained
REDIS_CACHE_TTL = int(os.getenv('REDIS_CACHE_TTL', 3600))  # 1 hour default

###############################################################################
# Flask setup                                                                 #
###############################################################################

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = MAX_REQUEST_BYTES

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

try:
    from solver import solver_bp
    app.register_blueprint(solver_bp)
except Exception as _solver_err:
    logging.warning("Solver package failed to load: %s. "
                    "Solver endpoints will be unavailable.", _solver_err)

try:
    from completion import completion_bp
    app.register_blueprint(completion_bp)
except Exception as _completion_err:
    logging.warning("Completion package failed to load: %s. "
                    "Completion endpoints will be unavailable.", _completion_err)

try:
    from evm import evm_bp
    app.register_blueprint(evm_bp)
except Exception as _evm_err:
    logging.warning("EVM package failed to load: %s. "
                    "EVM endpoints will be unavailable.", _evm_err)

try:
    from paths import paths_bp
    app.register_blueprint(paths_bp)
except Exception as _paths_err:
    logging.warning("Paths package failed to load: %s. "
                    "Path endpoints will be unavailable.", _paths_err)

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

def get_cached_result(key):
    """Try Redis first, then fall back to LRU cache"""
    if redis_client:
        try:
            cached = redis_client.get(key)
            if cached:
                if DEBUG:
                    logging.info(f"Redis cache hit for key: {key[:8]}...")
                return json.loads(cached)
        except Exception as e:
            if DEBUG:
                logging.warning(f"Redis get failed: {e}")
    return None

def set_cached_result(key, value, ttl=None):
    """Store in Redis if available"""
    if redis_client:
        try:
            serialized = json.dumps(value, default=_json_default,
                                     separators=(',', ':')).encode('utf-8')
            redis_client.setex(key, ttl or REDIS_CACHE_TTL, serialized)
            if DEBUG:
                logging.info(f"Cached result in Redis: {key[:8]}...")
        except Exception as e:
            # Log but don't fail the request on cache write errors
            if DEBUG:
                logging.warning(f"Redis set failed: {e}")
            # Continue without caching - the result is still valid

###############################################################################
# Helpers                                                                     #
###############################################################################

def _json_default(obj):
    """JSON serializer for numpy/pandas types in cache values.

    Raises TypeError for unrecognised types so json.dumps fails fast
    and the caller's except block skips caching rather than storing
    silently corrupted data.
    """
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, (datetime, pd.Timestamp)):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")

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
    pattern_key = (sample_df['TaskType'].cat.codes.astype('int64') * 100000 +
                  duration_discrete * 100 +
                  sample_df['Resources'].cat.codes.astype('int64'))
    
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
            'duration_variance': float(pattern_df['Duration'].var()) if len(pattern_df) > 1 else 0.0,
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
    """Calculate critical path using full CPM with FS/SS/FF/SF + lag.

    Delegates to solver.dag for correct precedence-relationship handling,
    then extracts the critical path from the solved state.  Falls back
    to NetworkX dag_longest_path if the solver import fails.
    """
    try:
        from solver.dag import build_dag as _build_dag, get_critical_path_indices
        cpm_nodes = [{'ID': str(nd), 'Duration': float(G.nodes[nd].get('duration', 1))}
                     for nd in G.nodes()]
        cpm_links = []
        for u, v in G.edges():
            edge = G.edges[u, v]
            try:
                lag = float(edge.get('lag', 0))
            except (TypeError, ValueError):
                lag = 0.0
            cpm_links.append({
                'source': str(u), 'target': str(v),
                'type': edge.get('type', 'FS'), 'lag': lag,
            })
        dag_state, _ = _build_dag(cpm_nodes, cpm_links)
        cp_ids = [cpm_nodes[i]['ID'] for i in get_critical_path_indices(dag_state)]
        tf_map = {cpm_nodes[i]['ID']: float(dag_state.TF[i])
                  for i in range(dag_state.n)}
        return cp_ids, dag_state.makespan, tf_map
    except ImportError:
        pass
    except Exception as e:
        logging.warning(f"CPM critical path failed ({e}); falling back to NetworkX")
    critical_path = nx.dag_longest_path(G, weight='duration')
    critical_path_length = nx.dag_longest_path_length(G, weight='duration')
    return critical_path, critical_path_length, {}

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

def define_work_packages(nodes_df, G):
    work_packages = {}
    
    if 'Cluster' not in nodes_df.columns:
        logging.warning("Cluster data not found in DataFrame.")
        return work_packages
    
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

        work_packages[f'Package_{cluster}'] = {
            'tasks': tasks,
            'critical_path': sub_critical_path,
            'critical_path_length': sub_critical_duration,
            'start': min(valid_starts),
            'end': max(valid_ends)
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
                'end': end_str
            }
        except Exception as e:
            if DEBUG:
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
# Graph builders - Optimized with vectorization                              #
###############################################################################

def build_nx_graph(nodes, links):
    """Optimized graph building with vectorized operations"""
    G = nx.DiGraph()
    
    # Bulk add edges (more efficient than loop)
    edge_list = [(str(l['source']), str(l['target']), {
        'weight': l.get('duration', 1),
        'duration': l.get('duration', 1),  # Add duration attribute for critical path
        'type': l.get('type', 'FS'),
        'lag': l.get('lag', 0)
    }) for l in links]
    G.add_edges_from(edge_list)
    
    # Vectorized node attribute processing
    nodes_df = pd.DataFrame(nodes)
    if len(nodes_df) == 0:
        return G
        
    # Ensure ID column exists
    if 'ID' not in nodes_df.columns:
        nodes_df['ID'] = range(len(nodes_df))
    
    # Vectorized date parsing (guard against missing columns)
    if 'Start' in nodes_df.columns:
        nodes_df['start_date'] = pd.to_datetime(nodes_df['Start'], errors='coerce', utc=False)
        # Remove timezone info if present (future-compatible check)
        if getattr(nodes_df['start_date'].dtype, 'tz', None) is not None:
            nodes_df['start_date'] = nodes_df['start_date'].dt.tz_localize(None)
    else:
        nodes_df['start_date'] = pd.NaT

    if 'Duration' in nodes_df.columns:
        nodes_df['duration'] = pd.to_numeric(nodes_df['Duration'], errors='coerce').fillna(1)
    else:
        nodes_df['duration'] = 1
    
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
            if DEBUG:
                logging.warning(f"NetworkKit DAG check failed: {e}")
    
    # Remove cycles using NetworkX (cap iterations to avoid runaway loops)
    max_cycle_removals = max(len(G.edges) // 2, 1)
    cycles_removed = 0
    while cycles_removed < max_cycle_removals:
        try:
            cycle = nx.find_cycle(G, orientation='original')
            u, v = cycle[0][0], cycle[0][1]
            G.remove_edge(u, v)
            cycles_removed += 1
            if DEBUG:
                logging.info(f"Removed edge to break cycle: {u} -> {v}")
        except nx.NetworkXNoCycle:
            break

    if cycles_removed >= max_cycle_removals:
        # Verify the graph actually still has cycles before warning
        try:
            nx.find_cycle(G, orientation='original')
            logging.warning(f"Cycle removal capped at {max_cycle_removals}. "
                            f"Graph may still contain cycles.")
        except nx.NetworkXNoCycle:
            pass  # all cycles resolved despite hitting the cap
    
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

def _cluster_risk(df: pd.DataFrame):
    """Density-based clustering (HDBSCAN primary, K-means fallback)."""
    if 'importanceScore' not in df.columns or 'riskScore' not in df.columns:
        df['Cluster'] = 0
        return df

    feats = df[['importanceScore', 'riskScore']].values
    n = len(df)

    if n < 2:
        df['Cluster'] = 0
        return df

    # O(n) short-circuit when all feature points are identical.
    if (feats == feats[0]).all():
        df['Cluster'] = 0
        return df

    # O(n log n) unique count for k-bounding — negligible vs clustering cost.
    unique_count = len(np.unique(feats, axis=0))

    # ---- HDBSCAN primary path ----
    if n >= 15 and unique_count >= 5:
        try:
            from sklearn.cluster import HDBSCAN as _HDBSCAN
            min_cluster_size = max(5, n // 20)
            labels = _HDBSCAN(
                min_cluster_size=min_cluster_size, min_samples=3
            ).fit_predict(feats)

            noise_ratio = np.sum(labels == -1) / n
            n_clusters = len(set(labels) - {-1})
            if noise_ratio <= 0.5 and n_clusters >= 2:
                # Reassign noise points to nearest cluster
                if np.any(labels == -1):
                    from sklearn.neighbors import NearestNeighbors
                    clustered = labels != -1
                    nn = NearestNeighbors(n_neighbors=1).fit(feats[clustered])
                    _, idx = nn.kneighbors(feats[~clustered])
                    labels[~clustered] = labels[clustered][idx.ravel()]
                df['Cluster'] = labels
                if DEBUG:
                    logging.info(f"HDBSCAN: {n_clusters} clusters, "
                                 f"noise={noise_ratio:.0%}")
                return df
            if DEBUG:
                logging.info(f"HDBSCAN produced {n_clusters} clusters with "
                             f"{noise_ratio:.0%} noise; falling back to K-means")
        except Exception as e:
            if DEBUG:
                logging.info(f"HDBSCAN unavailable ({e}); using K-means")

    # ---- K-means fallback ----
    if not ENABLE_SILHOUETTE_OPTIMIZATION:
        k = max(2, min(10, int(np.sqrt(n / 2)), unique_count))
        if DEBUG:
            logging.info(f"K-means heuristic k={k} for {n} nodes")
        try:
            df['Cluster'] = KMeans(k, n_init='auto', random_state=0).fit_predict(feats)
        except ValueError:
            df['Cluster'] = 0
        return df

    # Silhouette optimization path (only if explicitly enabled)
    if n <= 15:
        k = min(3, n, unique_count)
        try:
            df['Cluster'] = KMeans(k, n_init='auto', random_state=0).fit_predict(feats)
        except ValueError:
            df['Cluster'] = 0
        return df

    max_clusters = min(10, n, unique_count)
    best, k = -1, min(3, n, unique_count)

    for c in range(2, max_clusters + 1):
        if c >= n:
            break
        try:
            kmeans = KMeans(c, n_init='auto', random_state=0)
            lbl = kmeans.fit_predict(feats)
            if len(set(lbl)) > 1:
                sc = silhouette_score(feats, lbl)
                if sc > best:
                    best, k = sc, c
        except Exception:
            continue

    k = min(k, max(1, n), unique_count)
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
    if len(arr) > 1 and len(np.unique(arr, axis=0)) > 1:
        df[['pca1', 'pca2']] = PCA(2).fit_transform(arr)
    else:
        df['pca1'] = 0
        df['pca2'] = 0
    return df

def _dependency_groups_big(G_nx: nx.DiGraph, df: pd.DataFrame):
    """Big graph dependency grouping using NetworkKit Louvain"""
    if not _NK:
        # Without NetworkKit, the O(n²) sparse-distance fallback is too
        # slow for large graphs.  Use NetworkX Louvain as a lightweight
        # alternative that stays O(n·e).
        return _dependency_groups_nx_louvain(G_nx, df)
    
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
        return _dependency_groups_nx_louvain(G_nx, df)

    return df

def _dependency_groups_nx_louvain(G_nx: nx.DiGraph, df: pd.DataFrame):
    """Lightweight dependency grouping via NetworkX Louvain.

    Used as fallback when NetworkKit is unavailable for large graphs
    (> SMALL_GRAPH_THRESHOLD).  O(n·e) vs the O(n²) sparse-distance +
    agglomerative path in _dependency_groups_small, which becomes
    prohibitively slow above ~5K activities.
    """
    try:
        G_undirected = G_nx.to_undirected()
        if G_undirected.number_of_edges() == 0:
            df['DependencyCluster'] = 0
            return df
        communities = nx.algorithms.community.louvain_communities(
            G_undirected, weight='weight', seed=0)
        node_to_comm = {}
        for cid, members in enumerate(communities):
            for node in members:
                node_to_comm[node] = cid
        df['DependencyCluster'] = df['ID'].astype(str).map(node_to_comm).fillna(0).astype(int)
    except Exception as e:
        logging.warning(f"NetworkX Louvain dependency grouping failed: {e}")
        df['DependencyCluster'] = 0
    return df

def _dependency_groups_small(G: nx.DiGraph, df: pd.DataFrame):
    """Small graph dependency clustering using sparse matrices.

    Uses O(n²) shortest-path distance matrix + agglomerative clustering.
    Only appropriate for n <= SMALL_GRAPH_THRESHOLD; above that the
    distance matrix becomes prohibitively large.
    """
    ids = df['ID'].astype(str).tolist()
    n = len(ids)

    if n > SMALL_GRAPH_THRESHOLD:
        return _dependency_groups_nx_louvain(G, df)

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
            
            clustering_kwargs = _agglomerative_precomputed_kwargs()
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
                    if DEBUG:
                        logging.warning(f"Clustering failed for {n_clusters} clusters: {e}")
                    continue
        
        # Final clustering
        best_n_clusters = min(best_n_clusters, n)
        clustering = AgglomerativeClustering(
            n_clusters=best_n_clusters,
            linkage='complete',
            **_agglomerative_precomputed_kwargs()
        )
        df['DependencyCluster'] = clustering.fit_predict(dist_sparse)
        
    except Exception as e:
        logging.error(f"Dependency clustering failed: {e}")
        df['DependencyCluster'] = 0
    
    return df

def _agglomerative_precomputed_kwargs():
    """Return compatible kwargs for precomputed distance clustering across sklearn versions."""
    try:
        AgglomerativeClustering(metric='precomputed')
        return {'metric': 'precomputed'}
    except TypeError:
        return {'affinity': 'precomputed'}

def _centralities(G: nx.DiGraph, df: pd.DataFrame):
    """Compute centralities with NetworkKit acceleration when available"""
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
                        'Clustering_Coefficient': lcc[nk_idx]
                    })
                else:
                    centrality_data.append({
                        'PageRank': 0,
                        'closeness_centrality': 0,
                        'degree_centrality': 0,
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
    # Compute centralities
    pr = nx.pagerank(G, alpha=0.9)
    close = nx.closeness_centrality(G)
    deg = nx.degree_centrality(G)
    clust = nx.clustering(G.to_undirected())
    
    # Vectorized mapping
    df['PageRank'] = df['ID'].astype(str).map(pr).fillna(0)
    df['closeness_centrality'] = df['ID'].astype(str).map(close).fillna(0)
    df['degree_centrality'] = df['ID'].astype(str).map(deg).fillna(0)
    df['Clustering_Coefficient'] = df['ID'].astype(str).map(clust).fillna(0)

def _risk_propagation(G: nx.DiGraph, df: pd.DataFrame):
    """Propagate risk through the dependency network.

    Each activity's propagated_risk combines its intrinsic riskScore
    with risk inherited from predecessors, averaged over immediate
    predecessor count at convergence points.  This models the cascade mechanism that generates
    fat-tailed overrun distributions (Natarajan et al., PMJ 2022;
    Flyvbjerg et al., JMIS 2022).

    Adds three columns:
      propagated_risk:      intrinsic + inherited risk (topological sum)
      risk_transmission:    outgoing risk flow (how much risk this node
                            transmits to its successors)
      coupling_density:     fraction of community members that are
                            direct neighbours — high values indicate
                            Thunderhorse-class tight coupling
    """
    if 'riskScore' not in df.columns:
        df['propagated_risk'] = 0.0
        df['risk_transmission'] = 0.0
        df['coupling_density'] = 0.0
        return df

    # Map riskScore from df to activity/node id
    risk_map = dict(zip(df['ID'].astype(str), df['riskScore'].fillna(0).values))

    # Topological propagation: propagated_risk[j] = risk[j] + Σ propagated_risk[pred] / in_degree[j]
    # This gives activities deeper in the dependency chain higher propagated risk.
    try:
        topo = list(nx.topological_sort(G))
    except nx.NetworkXUnfeasible:
        topo = list(G.nodes())

    prop = {}
    for node in topo:
        intrinsic = float(risk_map.get(str(node), 0.0))
        preds = list(G.predecessors(node))
        if preds:
            inherited = sum(prop.get(p, 0.0) for p in preds) / len(preds)
        else:
            inherited = 0.0
        prop[node] = intrinsic + inherited

    # Risk transmission: how much risk a node sends forward
    # = propagated_risk × out_degree (more successors = more risk spread)
    trans = {}
    for node in G.nodes():
        out_deg = G.out_degree(node)
        trans[node] = prop.get(node, 0.0) * out_deg

    # Coupling density: for each node, what fraction of its community
    # neighbours are also its direct graph neighbours (in or out).
    # High coupling_density = tightly coupled = cascade-prone.
    coupling = {}
    if 'CommunityGroup' in df.columns:
        comm_map = dict(zip(df['ID'].astype(str), df['CommunityGroup'].values))
        comm_members = {}
        for aid, cid in comm_map.items():
            comm_members.setdefault(cid, set()).add(aid)

        for node in G.nodes():
            snode = str(node)
            cid = comm_map.get(snode, -1)
            members = comm_members.get(cid, set())
            if len(members) <= 1:
                coupling[node] = 0.0
                continue
            neighbours = set(str(n) for n in G.predecessors(node))
            neighbours |= set(str(n) for n in G.successors(node))
            shared = len(neighbours & members)
            coupling[node] = shared / (len(members) - 1)
    else:
        for node in G.nodes():
            coupling[node] = 0.0

    # Map back to dataframe
    str_ids = df['ID'].astype(str)
    df['propagated_risk'] = str_ids.map(
        {str(k): round(v, 4) for k, v in prop.items()}).fillna(0)
    df['risk_transmission'] = str_ids.map(
        {str(k): round(v, 4) for k, v in trans.items()}).fillna(0)
    df['coupling_density'] = str_ids.map(
        {str(k): round(v, 4) for k, v in coupling.items()}).fillna(0)

    return df

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
            if DEBUG:
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
# Schedule Health (DCMA 14-Point / GAO Schedule Assessment)                   #
###############################################################################

def _schedule_health(G: nx.DiGraph, df: pd.DataFrame, critical_path, critical_path_length):
    """DCMA-style schedule health metrics computed from the dependency graph.

    Based on the Defense Contract Management Agency 14-Point Assessment
    and the GAO Schedule Assessment Guide.  Only includes checks that
    can be computed from the plan (no execution data required).
    """
    n_tasks = len(df)
    n_links = G.number_of_edges()
    if n_tasks == 0:
        return {}

    # 1. Logic (relationship) density — target: 1.5–2.5 per task
    logic_density = round(n_links / max(n_tasks, 1), 2)

    # 2. Missing predecessors / successors (DCMA definition: non-start/end
    #    tasks with no logical ties).  One start and one end are expected;
    #    extras are treated as missing logic.
    starts = [nd for nd in G.nodes() if G.in_degree(nd) == 0]
    ends   = [nd for nd in G.nodes() if G.out_degree(nd) == 0]
    n_no_pred = max(0, len(starts) - 1)
    n_no_succ = max(0, len(ends) - 1)

    # 3. Relationship type breakdown
    rel_counts = {'FS': 0, 'SS': 0, 'FF': 0, 'SF': 0}
    lag_count = 0
    negative_lag_count = 0
    for u, v, data in G.edges(data=True):
        rel = str(data.get('type', 'FS')).upper()
        if rel in rel_counts:
            rel_counts[rel] += 1
        else:
            rel_counts['FS'] += 1
        try:
            lag = float(data.get('lag', 0))
        except (TypeError, ValueError):
            lag = 0.0
        if abs(lag) > 1e-9:
            lag_count += 1
        if lag < -1e-9:
            negative_lag_count += 1

    # 4. High float — activities with TF > 44 working days (DCMA threshold)
    high_float_threshold = 44.0
    high_float = []
    if 'total_float' in df.columns:
        hf_mask = df['total_float'] > high_float_threshold
        high_float = df.loc[hf_mask, 'ID'].astype(str).tolist()

    # 5. High duration — activities > 44 working days (DCMA threshold)
    high_dur_threshold = 44.0
    high_dur = df.loc[df['Duration'] > high_dur_threshold, 'ID'].astype(str).tolist()

    # 6. Resource assignment gaps
    resource_gaps = []
    if 'Resources' in df.columns:
        empty_res = df['Resources'].fillna('').astype(str).str.strip() == ''
        resource_gaps = df.loc[empty_res, 'ID'].astype(str).tolist()

    # 7. Critical path metrics
    cp_length = len(critical_path) if critical_path else 0
    cp_ratio = round(cp_length / max(n_tasks, 1), 3)

    # Overall health score (percentage of checks passing)
    checks = {
        'logic_density_ok':     1.5 <= logic_density <= 2.5,
        'missing_predecessors': n_no_pred <= max(1, int(n_tasks * 0.05)),
        'missing_successors':   n_no_succ <= max(1, int(n_tasks * 0.05)),
        'no_negative_lags':     negative_lag_count == 0,
        'high_float_ok':        len(high_float) <= int(n_tasks * 0.05),
        'high_duration_ok':     len(high_dur) <= int(n_tasks * 0.05),
        'resources_assigned':   len(resource_gaps) <= int(n_tasks * 0.05),
        'critical_path_exists': cp_length > 0,
    }
    n_passing = sum(checks.values())

    return {
        'logic_density': logic_density,
        'n_tasks': n_tasks,
        'n_relationships': n_links,
        'relationship_types': rel_counts,
        'n_lags': lag_count,
        'n_negative_lags': negative_lag_count,
        'missing_predecessors': n_no_pred,
        'missing_successors': n_no_succ,
        'high_float_activities': len(high_float),
        'high_duration_activities': len(high_dur),
        'resource_gaps': len(resource_gaps),
        'critical_path_length_tasks': cp_length,
        'critical_path_length_duration': float(critical_path_length),
        'critical_path_ratio': cp_ratio,
        'checks': checks,
        'health_score': round(n_passing / max(len(checks), 1), 2),
    }

###############################################################################
# Main analysis function                                                      #
###############################################################################

def analyse(nodes, links):
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
                'templates': {}
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
        
        # Pattern detection
        pattern_records = detect_repeating_patterns(df_nodes)
        templates = create_templates_from_patterns(pattern_records)
        
        # Risk/importance clustering + PCA
        clustering_start = time.time() if DEBUG else None
        df_nodes = _cluster_risk(df_nodes)
        df_nodes = _pca(df_nodes)
        if DEBUG:
            logging.info(f"Risk/importance clustering took {time.time() - clustering_start:.2f}s")
        
        # Dependency grouping
        dep_start = time.time() if DEBUG else None
        if len(df_nodes) > SMALL_GRAPH_THRESHOLD:
            df_nodes = _dependency_groups_big(G, df_nodes)
        else:
            df_nodes = _dependency_groups_small(G, df_nodes)
        if DEBUG:
            logging.info(f"Dependency clustering took {time.time() - dep_start:.2f}s")
        
        # Community detection (single-resolution — populates CommunityGroup column)
        df_nodes = _community_detection(G, df_nodes)

        # Multi-resolution community detection (additive — new response key).
        # Reduce n_runs for large graphs to keep latency bounded:
        # ~5 Louvain runs × 4 resolutions = 20 runs at default; at 2 runs
        # for large graphs that drops to 8.
        multi_res = None
        n_nodes = len(df_nodes)
        if n_nodes >= 50 and G.number_of_edges() > 0:
            try:
                from multi_resolution_pipeline import run_multi_resolution
                mr_runs = 2 if n_nodes > SMALL_GRAPH_THRESHOLD else 5
                multi_res = run_multi_resolution(G.to_undirected(),
                                                 n_runs=mr_runs)
            except Exception as e:
                logging.warning(f"Multi-resolution community detection failed: {e}")
        
        # Centrality metrics
        df_nodes = _centralities(G, df_nodes)

        # Risk propagation through dependency network
        df_nodes = _risk_propagation(G, df_nodes)

        # Work packages
        work_packages = define_work_packages(df_nodes, G)
        work_packages_serialized = serialize_work_packages(work_packages)
        
        # Critical path (CPM with FS/SS/FF/SF + lag)
        if nx.is_directed_acyclic_graph(G) and len(G) > 0:
            critical_path, critical_path_length, tf_map = calculate_critical_path(G)
            if tf_map:
                df_nodes['total_float'] = df_nodes['ID'].astype(str).map(tf_map).fillna(0)
        else:
            critical_path, critical_path_length = [], 0
        
        # Schedule health (DCMA 14-Point)
        health = _schedule_health(G, df_nodes, critical_path,
                                  critical_path_length)

        # Build response
        response = {
            'nodes': df_nodes.replace({np.nan: None}).to_dict('records'),
            'links': df_links.replace({np.nan: None}).to_dict('records'),
            'work_packages': work_packages_serialized,
            'critical_path': critical_path,
            'critical_path_length': float(critical_path_length),
            'templates': templates,
            'schedule_health': health,
        }
        if multi_res:
            response['multi_resolution_communities'] = multi_res
        
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
    
    # Generate cache key (v2 prefix avoids reading stale pickle-serialized
    # entries left by the pre-JSON caching code during a rolling deploy)
    key = _sha([nodes, links])
    redis_key = f"graph:v2:{key}"
    
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
        # Use in-memory LRU cache as second level.
        # Build a NEW dict via {**...} so the @lru_cache'd object is never
        # mutated — not even at the top level.  Nested values (nodes list,
        # work_packages dict) are shared references, which is safe because
        # jsonify() only reads.
        cached_res = _cached(
            json.dumps(nodes, sort_keys=True, default=str),
            json.dumps(links, sort_keys=True, default=str)
        )
        res = {**cached_res, 'cache_key': key, 'cache_hit': False}

        # Store in Redis for other instances
        set_cached_result(redis_key, res)

        # Log processing time
        elapsed = time.time() - start_time
        if DEBUG or elapsed > 5:
            logging.info(f"Graph processed in {elapsed:.2f}s (nodes: {len(nodes)}, links: {len(links)})")
        res['processing_time'] = elapsed

        return jsonify(res)
        
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
    return jsonify({'error': str(e)}), 500

###############################################################################
# Local dev                                                                   #
###############################################################################

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    # Enable debug mode only in development
    app.run(host='0.0.0.0', port=port, debug=DEBUG)
