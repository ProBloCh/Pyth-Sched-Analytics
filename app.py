"""
Pyth-Sched-Analytics • Lean Optimized v3.2.0
=============================================================
Goal: Provide ONLY the metrics the front-end actually consumes
(nodes + links with DependencyCluster & CommunityGroup plus optional
centralities & clustering), while **avoiding redundant calculations**
that are already performed in the browser (e.g., critical path,
all paths enumeration, PageRank if already attached to nodes).

Design Principles (Phase: Lean Reduction)
----------------------------------------
1. **Idempotent / Safe**: Downstream code (front-end) calls getGraphMetrics()
   and expects JSON with { nodes, links }. Old extra keys (critical_path,
   work_packages, templates, etc.) are preserved as empty placeholders so
   any legacy consumer will not break.
2. **Skip Redundant Work**:
   - If nodes already carry PageRank / centralities, skip recomputation
     unless FORCE_RECOMPUTE_METRICS=true.
   - Critical path NOT recomputed (front-end already computes and sets
     isOnCriticalPath flags). We provide empty critical_path meta only.
   - Work packages & pattern templates omitted (configurable re-enable).
   - Dependency clustering uses fast Louvain (NetworkKit) or a light
     structural fingerprint fallback (O(E))—no O(n^2) distance matrices.
3. **Structural Metrics Cache** keyed by structural hash (IDs, durations,
   edges, ALGO_VERSION). Only computed when needed.
4. **Boolean Robustness**: Accept 'true','1','yes','y','t' for truthy.
5. **Config Toggles** for future flexibility.

Environment Variables
---------------------
ALGO_VERSION                (default '3.2.0') – bump to invalidate struct cache
REDIS_URL                   – optional Redis for cross-instance structural cache
CACHE_SIZE                  (default 32) – LRU in-process cache entries
STRUCT_METRICS_TTL          (default 3600) – TTL seconds for structural cache
DEBUG                       ('true'|'false') – verbose logging toggle
ALWAYS_USE_LOUVAIN          (default 'true') – force Louvain vs fallback
SKIP_CENTRALITIES           (default 'false') – skip computing all centralities
SKIP_COMMUNITIES            (default 'false') – skip community detection
SKIP_DEP_CLUSTERS           (default 'false') – skip dependency clusters
FORCE_RECOMPUTE_METRICS     (default 'false') – ignore existing node metrics & cache
ENABLE_RISK_IMPORTANCE_KMEANS (default 'true') – perform risk/importance clustering
MAX_PATTERN_NODES / MAX_PATTERNS (future re-enable patterns; currently ignored)

Returned JSON Structure
-----------------------
{
  "nodes": [...],
  "links": [...],
  "critical_path": [],            # placeholder
  "critical_path_length": 0,      # placeholder
  "work_packages": {},            # placeholder
  "templates": {},                # placeholder
  "meta": {
      "algo_version": str,
      "structural_hash": str,
      "structural_cache_hit": bool,
      "metrics_skipped": { ... },
      "dependency_cluster_method": "louvain"|"fingerprint"|"skipped",
      "recomputed": bool
  }
}

Safe Backward Compatibility: Placeholders keep legacy consumers alive.

"""
import os, json, logging, hashlib, time, gc, random, pickle
from functools import lru_cache
from datetime import datetime
from contextlib import contextmanager

import numpy as np
import pandas as pd
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

# Optional performance libs
try:
    import networkit as nk
    from networkit import nxadapter as nka
    _NK = True
except ImportError:  # graceful fallback
    _NK = False

import networkx as nx

# ---------------------- Configuration ---------------------- #
ALGO_VERSION                = os.getenv("ALGO_VERSION", "3.2.0")
CACHE_SIZE                  = int(os.getenv("CACHE_SIZE", 32))
STRUCT_METRICS_TTL          = int(os.getenv("STRUCT_METRICS_TTL", 3600))
DEBUG                       = os.getenv("DEBUG", "false").lower() == "true"
ALWAYS_USE_LOUVAIN          = os.getenv("ALWAYS_USE_LOUVAIN", "true").lower() == "true"
SKIP_CENTRALITIES           = os.getenv("SKIP_CENTRALITIES", "false").lower() == "true"
SKIP_COMMUNITIES            = os.getenv("SKIP_COMMUNITIES", "false").lower() == "true"
SKIP_DEP_CLUSTERS           = os.getenv("SKIP_DEP_CLUSTERS", "false").lower() == "true"
FORCE_RECOMPUTE_METRICS     = os.getenv("FORCE_RECOMPUTE_METRICS", "false").lower() == "true"
ENABLE_RISK_IMPORTANCE_KMEANS = os.getenv("ENABLE_RISK_IMPORTANCE_KMEANS", "true").lower() == "true"

# Thread / BLAS scaling (avoid CPU contention in containers)
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

random.seed(0)
np.random.seed(0)

# Logging
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.WARNING,
    format="%(asctime)s %(levelname)s » %(message)s"
)

# Redis (optional)
REDIS_URL = os.getenv('REDIS_URL')
redis_client = None
if REDIS_URL:
    try:
        import redis
        from redis.connection import ConnectionPool
        pool = ConnectionPool.from_url(REDIS_URL, max_connections=20, decode_responses=False)
        redis_client = redis.Redis(connection_pool=pool)
        redis_client.ping()
        logging.info("Redis connected for structural metrics cache")
    except Exception as e:
        logging.warning(f"Redis unavailable ({e}), continuing without distributed cache")
        redis_client = None

# Flask
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# ---------------------- Helpers ---------------------- #
_truthy = {'true','1','yes','y','t'}

def robust_bool(v):
    return str(v).strip().lower() in _truthy

def structural_hash(nodes, links):
    # Node ID + Duration + Edge list (source,target) + version
    node_sig = sorted([(n.get('ID'), n.get('Duration')) for n in nodes])
    edge_sig = sorted([(e.get('source'), e.get('target')) for e in links])
    payload = {'v': ALGO_VERSION, 'n': node_sig, 'e': edge_sig}
    return hashlib.sha256(json.dumps(payload, separators=(',',':')).encode()).hexdigest()

def redis_get_struct(sh):
    if not redis_client: return None
    try:
        blob = redis_client.get(f"struct:{sh}")
        if blob: return pickle.loads(blob)
    except Exception as e:
        if DEBUG: logging.warning(f"struct redis get fail {e}")
    return None

def redis_set_struct(sh, data):
    if not redis_client: return
    try:
        redis_client.setex(f"struct:{sh}", STRUCT_METRICS_TTL, pickle.dumps(data, pickle.HIGHEST_PROTOCOL))
    except Exception as e:
        if DEBUG: logging.warning(f"struct redis set fail {e}")

@lru_cache(maxsize=CACHE_SIZE)
def _cached(nodes_json, links_json):
    return analyse(json.loads(nodes_json), json.loads(links_json))

# ---------------------- Core Graph Build ---------------------- #

def build_graph(nodes, links):
    G = nx.DiGraph()
    # Edges
    edge_list = []
    for l in links:
        s = str(l.get('source'))
        t = str(l.get('target'))
        if s == '' or t == '':
            continue
        d = l.get('duration', l.get('Duration', 1))
        try:
            d = float(d)
        except Exception:
            d = 1.0
        edge_list.append((s,t,{'weight':d,'duration':d,'type':l.get('type','FS'),'lag':l.get('lag',0)}))
    G.add_edges_from(edge_list)

    # Nodes
    df = pd.DataFrame(nodes)
    if 'ID' not in df.columns:
        df['ID'] = range(len(df))
    # Dates
    df['Start'] = pd.to_datetime(df.get('Start'), errors='coerce')
    df['Finish'] = pd.to_datetime(df.get('Finish'), errors='coerce')
    df['Duration'] = pd.to_numeric(df.get('Duration', 1), errors='coerce').fillna(1).astype(float)

    bool_cols = ['isImportanceOutlier','isOnCriticalPath','isOnOutlierPath','isRiskOutlier','Milestone']
    for col in bool_cols:
        if col in df.columns:
            df[col] = df[col].apply(robust_bool)
        else:
            df[col] = False

    attr = {}
    for _, r in df.iterrows():
        nid = str(r['ID'])
        attr[nid] = {
            'start_date': r['Start'].to_pydatetime() if pd.notna(r['Start']) else None,
            'end_date': r['Finish'].to_pydatetime() if pd.notna(r['Finish']) else None,
            'duration': r['Duration'],
            'Milestone': r['Milestone'],
            'isImportanceOutlier': r['isImportanceOutlier'],
            'isOnCriticalPath': r['isOnCriticalPath'],
            'isOnOutlierPath': r['isOnOutlierPath'],
            'isRiskOutlier': r['isRiskOutlier']
        }
    G.add_nodes_from(attr.keys())
    nx.set_node_attributes(G, attr)
    return G


def ensure_dag(G: nx.DiGraph):
    # Remove cycles by dropping one edge per cycle found
    removed = 0
    while True:
        try:
            cyc = nx.find_cycle(G, orientation='original')
            u,v = cyc[0][0], cyc[0][1]
            G.remove_edge(u,v)
            removed += 1
        except nx.NetworkXNoCycle:
            break
    if DEBUG and removed: logging.info(f"Removed {removed} cycle edges")
    # Connect orphan start/end milestones (duration=0)
    starts = [n for n in G.nodes if G.nodes[n].get('Milestone') and G.in_degree(n)==0]
    ends   = [n for n in G.nodes if G.nodes[n].get('Milestone') and G.out_degree(n)==0]
    if starts and ends:
        s0, e0 = starts[0], ends[0]
        orphan_starts = [n for n in G.nodes if G.in_degree(n)==0 and n!=s0]
        orphan_ends   = [n for n in G.nodes if G.out_degree(n)==0 and n!=e0]
        for n in orphan_starts: G.add_edge(s0,n,weight=0,duration=0)
        for n in orphan_ends:   G.add_edge(n,e0,weight=0,duration=0)
    return G

# ---------------------- Structural Metrics ---------------------- #

def dependency_clusters(G: nx.DiGraph, df_nodes: pd.DataFrame):
    if SKIP_DEP_CLUSTERS:
        df_nodes['DependencyCluster'] = 0
        return 'skipped', df_nodes
    if _NK and ALWAYS_USE_LOUVAIN and len(G)>1:
        try:
            Gu = G.to_undirected()
            node_list = list(Gu.nodes())
            G_nk = nka.nx2nk(Gu)
            algo = nk.community.PLM(G_nk, seed=0)
            algo.run()
            part = algo.getPartition()
            mapping = {node_list[i]: part.subsetOf(i) for i in range(len(node_list))}
            df_nodes['DependencyCluster'] = df_nodes['ID'].astype(str).map(mapping).fillna(-1).astype(int)
            return 'louvain', df_nodes
        except Exception as e:
            logging.warning(f"Louvain dep clustering failed: {e}; fallback")
    # Fallback lightweight fingerprint (degree & 2-hop size)
    out_deg = dict(G.out_degree())
    succs = {n:set(G.successors(n)) for n in G.nodes}
    two_hop_size = {}
    for n,s in succs.items():
        two = set()
        for x in s: two.update(G.successors(x))
        two_hop_size[n]=len(two)
    rows=[]
    for nid in df_nodes['ID'].astype(str):
        rows.append((out_deg.get(nid,0), len(succs.get(nid,())), two_hop_size.get(nid,0)))
    hashes=[hashlib.blake2b(str(r).encode(),digest_size=4).hexdigest() for r in rows]
    uniq={h:i for i,h in enumerate(sorted(set(hashes)))}
    df_nodes['DependencyCluster']=[uniq[h] for h in hashes]
    return 'fingerprint', df_nodes


def community_detection(G: nx.DiGraph, df_nodes: pd.DataFrame):
    if SKIP_COMMUNITIES:
        df_nodes['CommunityGroup'] = 0
        return 'skipped', df_nodes
    if _NK and len(G)>1:
        try:
            Gu = G.to_undirected()
            node_list = list(Gu.nodes())
            G_nk = nka.nx2nk(Gu)
            algo = nk.community.PLM(G_nk, seed=0)
            algo.run()
            part = algo.getPartition()
            mapping = {node_list[i]: part.subsetOf(i) for i in range(len(node_list))}
            df_nodes['CommunityGroup'] = df_nodes['ID'].astype(str).map(mapping).fillna(-1).astype(int)
            return 'louvain', df_nodes
        except Exception as e:
            logging.warning(f"Community Louvain failed: {e}; fallback greedy")
    # Fallback greedy modularity (NetworkX)
    try:
        comms = nx.algorithms.community.greedy_modularity_communities(G.to_undirected())
        mapping = {}
        for cid, group in enumerate(comms):
            for n in group:
                mapping[n]=cid
        df_nodes['CommunityGroup'] = df_nodes['ID'].astype(str).map(mapping).fillna(-1).astype(int)
        return 'greedy', df_nodes
    except Exception as e:
        logging.warning(f"Community fallback failed: {e}")
        df_nodes['CommunityGroup']=0
        return 'failed', df_nodes


def centralities(G: nx.DiGraph, df_nodes: pd.DataFrame):
    if SKIP_CENTRALITIES:
        # Ensure columns exist
        for col,val in [('PageRank',0),('degree_centrality',0),('Clustering_Coefficient',0),('closeness_centrality',None)]:
            if col not in df_nodes.columns:
                df_nodes[col]=val
        return 'skipped', df_nodes

    # If already present and not forcing recompute, keep
    existing_cols = {'PageRank','degree_centrality','Clustering_Coefficient'}
    if existing_cols.issubset(set(df_nodes.columns)) and not FORCE_RECOMPUTE_METRICS:
        return 'reused', df_nodes

    if _NK and len(G)>1:
        try:
            node_list=list(G.nodes())
            nx_to_nk={n:i for i,n in enumerate(node_list)}
            G_nk = nka.nx2nk(G)
            pr_algo = nk.centrality.PageRank(G_nk, damp=0.9)
            pr_algo.run()
            pr = pr_algo.scores()
            deg_algo = nk.centrality.DegreeCentrality(G_nk, normalized=True)
            deg_algo.run(); deg = deg_algo.scores()
            # clustering on undirected
            Gu_nk = nka.nx2nk(G.to_undirected())
            lcc_algo = nk.centrality.LocalClusteringCoefficient(Gu_nk)
            lcc_algo.run(); lcc=lcc_algo.scores()
            # closeness optional (skip large graphs for speed)
            close=None
            if len(G) <= 1500:
                hc = nk.centrality.HarmonicCloseness(G_nk, normalized=True)
                hc.run(); close=hc.scores()
            pr_list=[];deg_list=[];lcc_list=[];close_list=[]
            for nid in df_nodes['ID'].astype(str):
                idx=nx_to_nk.get(nid)
                if idx is None:
                    pr_list.append(0);deg_list.append(0);lcc_list.append(0);close_list.append(None if close is None else 0)
                else:
                    pr_list.append(pr[idx]);deg_list.append(deg[idx]);lcc_list.append(lcc[idx]);close_list.append(None if close is None else close[idx])
            df_nodes['PageRank']=pr_list
            df_nodes['degree_centrality']=deg_list
            df_nodes['Clustering_Coefficient']=lcc_list
            df_nodes['closeness_centrality']=close_list
            return 'networkit', df_nodes
        except Exception as e:
            logging.warning(f"NK centralities failed: {e}; fallback NX")

    # NetworkX fallback
    pr = nx.pagerank(G, alpha=0.9)
    deg = nx.degree_centrality(G)
    clust = nx.clustering(G.to_undirected())
    close = None
    if len(G) <= 1500:
        close = nx.closeness_centrality(G)
    id_series = df_nodes['ID'].astype(str)
    df_nodes['PageRank'] = id_series.map(pr).fillna(0)
    df_nodes['degree_centrality'] = id_series.map(deg).fillna(0)
    df_nodes['Clustering_Coefficient'] = id_series.map(clust).fillna(0)
    df_nodes['closeness_centrality'] = id_series.map(close).fillna(0) if close else None
    return 'networkx', df_nodes

# ---------------------- Risk/Importance Clustering & PCA ---------------------- #

def risk_importance_clustering(df_nodes: pd.DataFrame):
    if not ENABLE_RISK_IMPORTANCE_KMEANS:
        if 'Cluster' not in df_nodes.columns:
            df_nodes['Cluster']=0
        return 'skipped', df_nodes
    if 'importanceScore' not in df_nodes.columns or 'riskScore' not in df_nodes.columns:
        df_nodes['Cluster']=0
        return 'missing_feats', df_nodes
    if 'Cluster' in df_nodes.columns and not FORCE_RECOMPUTE_METRICS:
        return 'reused', df_nodes
    from sklearn.cluster import KMeans
    vals = df_nodes[['importanceScore','riskScore']].fillna(0).values
    n=len(vals)
    if n<2:
        df_nodes['Cluster']=0
        return 'trivial', df_nodes
    k=max(2,min(8,int(np.sqrt(n/2))))
    kmeans = KMeans(n_clusters=k, n_init=10, random_state=0)
    df_nodes['Cluster']=kmeans.fit_predict(vals)
    return f'kmeans_{k}', df_nodes

def pca_embed(df_nodes: pd.DataFrame):
    if 'importanceScore' not in df_nodes.columns or 'riskScore' not in df_nodes.columns:
        df_nodes['pca1']=0; df_nodes['pca2']=0
        return 'missing_feats', df_nodes
    if all(c in df_nodes.columns for c in ['pca1','pca2']) and not FORCE_RECOMPUTE_METRICS:
        return 'reused', df_nodes
    from sklearn.decomposition import PCA
    arr = df_nodes[['importanceScore','riskScore']].fillna(0).values
    if len(arr)>1:
        pc = PCA(2).fit_transform(arr)
        df_nodes['pca1']=pc[:,0]; df_nodes['pca2']=pc[:,1]
    else:
        df_nodes['pca1']=0; df_nodes['pca2']=0
    return 'pca', df_nodes

# ---------------------- Analyse ---------------------- #

def analyse(nodes, links):
    start = time.time()
    if not nodes:
        return {
            'nodes': [], 'links': [], 'critical_path': [], 'critical_path_length': 0,
            'work_packages': {}, 'templates': {}, 'meta': {
                'algo_version': ALGO_VERSION, 'structural_hash': None,
                'structural_cache_hit': False, 'dependency_cluster_method': 'none',
                'recomputed': False, 'metrics_skipped': {}
            }
        }

    # DataFrame for nodes (mutable copy)
    df_nodes = pd.DataFrame(nodes)
    if 'ID' not in df_nodes.columns:
        df_nodes['ID'] = range(len(df_nodes))

    # Structural hash (structure only) – durations & edges matter
    sh = structural_hash(nodes, links)
    struct_cached = None if FORCE_RECOMPUTE_METRICS else redis_get_struct(sh)

    # Build graph only if needed for structural metrics or metrics not present
    need_graph = struct_cached is None or any(col not in df_nodes.columns for col in ['DependencyCluster','CommunityGroup'])
    if need_graph:
        G = build_graph(nodes, links)
        G = ensure_dag(G)
    else:
        # Graph still required for centrality if absent and not cached
        G = build_graph(nodes, links)
        G = ensure_dag(G)

    metrics_skipped = {}
    recomputed = False

    if struct_cached is None:
        # Compute structural metrics
        recomputed = True
        dep_method, df_nodes = dependency_clusters(G, df_nodes)
        comm_method, df_nodes = community_detection(G, df_nodes)
        cent_method, df_nodes = centralities(G, df_nodes)
        struct_cached = {
            'DependencyCluster': df_nodes['DependencyCluster'].tolist(),
            'CommunityGroup': df_nodes['CommunityGroup'].tolist(),
            'PageRank': df_nodes.get('PageRank',[]).tolist(),
            'degree_centrality': df_nodes.get('degree_centrality',[]).tolist(),
            'Clustering_Coefficient': df_nodes.get('Clustering_Coefficient',[]).tolist(),
            'closeness_centrality': df_nodes.get('closeness_centrality',[]).tolist(),
            'dep_method': dep_method,
            'comm_method': comm_method,
            'cent_method': cent_method
        }
        redis_set_struct(sh, struct_cached)
    else:
        # Inject cached metrics only if missing or if user wants reuse
        for col in ['DependencyCluster','CommunityGroup','PageRank','degree_centrality','Clustering_Coefficient','closeness_centrality']:
            if col not in df_nodes.columns or FORCE_RECOMPUTE_METRICS:
                df_nodes[col] = struct_cached.get(col, [0]*len(df_nodes))
        dep_method = struct_cached.get('dep_method','cached')
        comm_method = struct_cached.get('comm_method','cached')
        cent_method = struct_cached.get('cent_method','cached')

    # Risk / Importance clustering
    ric_method, df_nodes = risk_importance_clustering(df_nodes)
    pca_method, df_nodes = pca_embed(df_nodes)

    metrics_skipped.update({
        'dependency_clusters': dep_method,
        'communities': comm_method,
        'centralities': cent_method,
        'risk_importance': ric_method,
        'pca': pca_method
    })

    # Prepare output nodes (replace NaN with None)
    df_nodes = df_nodes.replace({np.nan: None})

    response = {
        'nodes': df_nodes.to_dict('records'),
        'links': links,  # unchanged
        'critical_path': [],                 # placeholder
        'critical_path_length': 0,           # placeholder
        'work_packages': {},                 # placeholder
        'templates': {},                     # placeholder
        'meta': {
            'algo_version': ALGO_VERSION,
            'structural_hash': sh,
            'structural_cache_hit': not recomputed,
            'dependency_cluster_method': dep_method,
            'recomputed': recomputed,
            'metrics_skipped': metrics_skipped,
            'processing_time_sec': round(time.time()-start,4)
        }
    }

    if len(nodes) > 4000:
        gc.collect()
    return response

# ---------------------- Flask Routes ---------------------- #
@app.route('/graph-metrics', methods=['POST','OPTIONS'])
def graph_metrics():
    if request.method == 'OPTIONS':
        r = jsonify({'status':'ok'})
        r.headers.add('Access-Control-Allow-Origin','*')
        r.headers.add('Access-Control-Allow-Headers','Content-Type')
        r.headers.add('Access-Control-Allow-Methods','POST,OPTIONS')
        return r

    data = request.get_json(force=True, silent=True) or {}
    nodes = data.get('nodes', [])
    links = data.get('links', [])

    if not isinstance(nodes, list) or not isinstance(links, list):
        return jsonify({'error':'Invalid payload'}), 400

    try:
        # Top-level request cache (exact payload). Retains lean processing benefits.
        cache_key = hashlib.sha256(json.dumps([nodes, links], sort_keys=True, default=str).encode()).hexdigest()
        cached = _cached.cache_info()
        # Use LRU only for identical payload
        res = _cached(
            json.dumps(nodes, sort_keys=True, default=str),
            json.dumps(links, sort_keys=True, default=str)
        )
        res['meta']['lru_cache'] = {
            'hits': cached.hits,
            'misses': cached.misses,
            'currsize': cached.currsize
        }
        res['meta']['cache_key'] = cache_key
        r = jsonify(res)
        r.headers.add('Access-Control-Allow-Origin','*')
        return r
    except Exception as e:
        logging.exception("graph-metrics error")
        r = jsonify({'error': str(e)})
        r.headers.add('Access-Control-Allow-Origin','*')
        return r, 500

@app.route('/health', methods=['GET'])
def health():
    try:
        redis_ok = False
        if redis_client:
            try: redis_ok = bool(redis_client.ping())
            except Exception: redis_ok = False
        return jsonify({
            'status':'healthy' if redis_ok or not REDIS_URL else 'degraded',
            'algo_version': ALGO_VERSION,
            'networkit': _NK,
            'redis': {'configured': bool(REDIS_URL), 'ok': redis_ok},
            'timestamp': datetime.utcnow().isoformat()
        })
    except Exception as e:
        return jsonify({'status':'error','error':str(e)}), 500

@app.errorhandler(HTTPException)
def http_err(e):
    r = jsonify({'error': e.description})
    r.status_code = e.code
    r.headers.add('Access-Control-Allow-Origin','*')
    return r

@app.errorhandler(Exception)
def unhandled(e):
    logging.exception('Unhandled')
    r = jsonify({'error': str(e)})
    r.headers.add('Access-Control-Allow-Origin','*')
    return r, 500

@app.after_request
def after(resp):
    resp.headers.add('Access-Control-Allow-Origin','*')
    resp.headers.add('Access-Control-Allow-Headers','Content-Type, Authorization')
    resp.headers.add('Access-Control-Allow-Methods','POST, GET, OPTIONS')
    return resp

@app.route('/', methods=['GET'])
def index():
    return jsonify({'status':'ok','service':'python-sched-analytics','version':ALGO_VERSION})

# ---------------------- Entrypoint ---------------------- #
if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=DEBUG)
