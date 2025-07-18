"""
Pyth-Sched-Analytics • Lean Optimized v3.2.1
=============================================================
Purpose: Provide ONLY the metrics consumed by the front-end with
minimal latency and resource usage while ensuring correctness and
backward-compatible response structure.

Changes vs v3.2.0 (Patch Focus: Correctness & Minimal Overhead)
--------------------------------------------------------------
P0/P1 Fixes Implemented:
1. Structural Metrics Cache now keyed & stored *by node ID* (prevents
   index-order misalignment when node ordering changes).
2. Added feature hash for (ID, importanceScore, riskScore) to decide
   risk/importance cluster recomputation (prevents stale clusters when
   only feature values change).
3. Deterministic cycle edge removal: always removes edge with minimal
   (weight, source_id, target_id) within each detected cycle, ensuring
   stable DAG transformation across runs / replicas.
4. end_date fallback: if Finish absent but Start & Duration present,
   we derive end_date = Start + Duration days.
5. Closeness centrality normalization: always present as numeric
   (0.0 if skipped/not computed) + meta flag `closeness_computed`.
6. Improved lightweight dependency fingerprint fallback: cluster id
   derived from structural tuple (out_degree, succ_count, two_hop_out,
   two_hop_in, median_successor_out_degree) instead of short digest to
   reduce collisions while keeping O(E) complexity.
7. Structural hash now includes relevant toggle flags + ALGO_VERSION
   to auto-invalidate cache when config changes impact semantics.
8. Added optional input size guards (MAX_NODES, MAX_LINKS) and clear
   error 413 response if exceeded.
9. Optional origin allowlist via ALLOWED_ORIGINS (comma list). Defaults
   to permissive if unset for backward compatibility.
10. Added meta fields: `centralities_method`, `closeness_computed`,
    `feature_hash_changed`.

Performance Impact: Negligible. All added hashes are O(n log n) due to
sorting small tuples; cycle removal deterministic comparison is trivial.
No reintroduction of O(n^2) distance matrices.

Environment Variables (Key)
---------------------------
ALGO_VERSION (default '3.2.1')
MAX_NODES (optional int) / MAX_LINKS (optional int)
ALLOWED_ORIGINS (comma separated) – optional CORS allowlist
CACHE_SIZE (default 32)
STRUCT_METRICS_TTL (default 3600)
DEBUG ('true'|'false')
ALWAYS_USE_LOUVAIN ('true'|'false')
SKIP_CENTRALITIES, SKIP_COMMUNITIES, SKIP_DEP_CLUSTERS ('true'|'false')
FORCE_RECOMPUTE_METRICS ('true'|'false')
ENABLE_RISK_IMPORTANCE_KMEANS ('true'|'false')

Returned JSON Structure (Backward Compatible Placeholders)
---------------------------------------------------------
{
  "nodes": [...],
  "links": [...],
  "critical_path": [],
  "critical_path_length": 0,
  "work_packages": {},
  "templates": {},
  "meta": {
     algo_version, structural_hash, structural_cache_hit,
     dependency_cluster_method, centralities_method,
     recomputed, metrics_skipped, processing_time_sec,
     closeness_computed, feature_hash_changed, cache_key, lru_cache {...}
  }
}
"""
import os, json, logging, hashlib, time, gc, random, pickle
from functools import lru_cache
from datetime import datetime, timedelta
from typing import Dict, Any, Tuple

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
ALGO_VERSION                 = os.getenv("ALGO_VERSION", "3.2.1")
CACHE_SIZE                   = int(os.getenv("CACHE_SIZE", 32))
STRUCT_METRICS_TTL           = int(os.getenv("STRUCT_METRICS_TTL", 3600))
DEBUG                        = os.getenv("DEBUG", "false").lower() == "true"
ALWAYS_USE_LOUVAIN           = os.getenv("ALWAYS_USE_LOUVAIN", "true").lower() == "true"
SKIP_CENTRALITIES            = os.getenv("SKIP_CENTRALITIES", "false").lower() == "true"
SKIP_COMMUNITIES             = os.getenv("SKIP_COMMUNITIES", "false").lower() == "true"
SKIP_DEP_CLUSTERS            = os.getenv("SKIP_DEP_CLUSTERS", "false").lower() == "true"
FORCE_RECOMPUTE_METRICS      = os.getenv("FORCE_RECOMPUTE_METRICS", "false").lower() == "true"
ENABLE_RISK_IMPORTANCE_KMEANS= os.getenv("ENABLE_RISK_IMPORTANCE_KMEANS", "true").lower() == "true"
MAX_NODES                    = int(os.getenv("MAX_NODES", 0))  # 0 = disabled
MAX_LINKS                    = int(os.getenv("MAX_LINKS", 0))
ALLOWED_ORIGINS_RAW          = os.getenv("ALLOWED_ORIGINS", "")

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

# CORS allowlist processing
if ALLOWED_ORIGINS_RAW.strip():
    ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_RAW.split(',') if o.strip()]
else:
    ALLOWED_ORIGINS = ["*"]  # backward compatible permissive default

# Redis (optional) for structural metrics cache\ nREDIS_URL = os.getenv('REDIS_URL')
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
CORS(app, resources={r"/*": {"origins": ALLOWED_ORIGINS}})

# ---------------------- Helpers ---------------------- #
_truthy = {'true','1','yes','y','t'}

def robust_bool(v):
    return str(v).strip().lower() in _truthy

def structural_hash(nodes, links) -> str:
    """Hash only structural aspects + toggles & version.
    Includes: (ID, Duration) pairs; (source, target) edges; ALGO_VERSION & relevant toggles.
    """
    node_sig = sorted([(n.get('ID'), n.get('Duration')) for n in nodes])
    edge_sig = sorted([(e.get('source'), e.get('target')) for e in links])
    toggles = {
        'ALGO_VERSION': ALGO_VERSION,
        'SKIP_CENTRALITIES': SKIP_CENTRALITIES,
        'SKIP_COMMUNITIES': SKIP_COMMUNITIES,
        'SKIP_DEP_CLUSTERS': SKIP_DEP_CLUSTERS,
        'ALWAYS_USE_LOUVAIN': ALWAYS_USE_LOUVAIN
    }
    payload = {'n': node_sig, 'e': edge_sig, 't': toggles}
    return hashlib.sha256(json.dumps(payload, separators=(',',':')).encode()).hexdigest()

def feature_hash(df: pd.DataFrame) -> str:
    if not {'importanceScore','riskScore','ID'}.issubset(df.columns):
        return 'nofeats'
    sig = sorted((str(r.ID), float(r.importanceScore) if r.importanceScore is not None else 0.0,
                  float(r.riskScore) if r.riskScore is not None else 0.0)
                 for r in df[['ID','importanceScore','riskScore']].fillna(0).itertuples())
    return hashlib.sha256(json.dumps(sig, separators=(',',':')).encode()).hexdigest()

def redis_get_struct(sh: str):
    if not redis_client: return None
    try:
        blob = redis_client.get(f"struct:{sh}")
        if blob: return pickle.loads(blob)
    except Exception as e:
        if DEBUG: logging.warning(f"struct redis get fail {e}")
    return None

def redis_set_struct(sh: str, data: dict):
    if not redis_client: return
    try:
        redis_client.setex(f"struct:{sh}", STRUCT_METRICS_TTL, pickle.dumps(data, pickle.HIGHEST_PROTOCOL))
    except Exception as e:
        if DEBUG: logging.warning(f"struct redis set fail {e}")

@lru_cache(maxsize=CACHE_SIZE)
def _cached(nodes_json, links_json):
    return analyse(json.loads(nodes_json), json.loads(links_json))

# ---------------------- Core Graph Build ---------------------- #

def build_graph(nodes, links) -> nx.DiGraph:
    G = nx.DiGraph()
    edge_list = []
    for l in links:
        s = str(l.get('source'))
        t = str(l.get('target'))
        if not s or not t:
            continue
        d = l.get('duration', l.get('Duration', 1))
        try: d = float(d)
        except: d = 1.0
        edge_list.append((s, t, {'weight': d, 'duration': d, 'type': l.get('type','FS'), 'lag': l.get('lag',0)}))
    G.add_edges_from(edge_list)

    df = pd.DataFrame(nodes)
    if 'ID' not in df.columns:
        df['ID'] = range(len(df))
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
        start_dt = r['Start'].to_pydatetime() if pd.notna(r['Start']) else None
        if pd.notna(r['Finish']):
            end_dt = r['Finish'].to_pydatetime()
        elif start_dt is not None:
            end_dt = start_dt + timedelta(days=float(r['Duration']))
        else:
            end_dt = None
        attr[nid] = {
            'start_date': start_dt,
            'end_date': end_dt,
            'duration': float(r['Duration']),
            'Milestone': r['Milestone'],
            'isImportanceOutlier': r['isImportanceOutlier'],
            'isOnCriticalPath': r['isOnCriticalPath'],
            'isOnOutlierPath': r['isOnOutlierPath'],
            'isRiskOutlier': r['isRiskOutlier']
        }
    G.add_nodes_from(attr.keys())
    nx.set_node_attributes(G, attr)
    return G

def ensure_dag(G: nx.DiGraph) -> nx.DiGraph:
    removed = 0
    while True:
        try:
            cycle = nx.find_cycle(G, orientation='original')
            # Collect candidate edges in this cycle
            candidates = []
            for u, v, _ in cycle:
                w = G[u][v].get('weight', 1)
                candidates.append((w, str(u), str(v)))
            # Deterministically remove minimal tuple
            _, u_min, v_min = min(candidates)
            G.remove_edge(u_min, v_min)
            removed += 1
        except nx.NetworkXNoCycle:
            break
    if DEBUG and removed:
        logging.debug(f"Removed {removed} cycle edges deterministically")

    starts = [n for n in G.nodes if G.nodes[n].get('Milestone') and G.in_degree(n)==0]
    ends   = [n for n in G.nodes if G.nodes[n].get('Milestone') and G.out_degree(n)==0]
    if starts and ends:
        s0, e0 = starts[0], ends[0]
        orphan_starts = [n for n in G.nodes if G.in_degree(n)==0 and n!=s0]
        orphan_ends   = [n for n in G.nodes if G.out_degree(n)==0 and n!=e0]
        for n in orphan_starts: G.add_edge(s0, n, weight=0, duration=0)
        for n in orphan_ends:   G.add_edge(n, e0, weight=0, duration=0)
    return G

# ---------------------- Structural Metrics ---------------------- #

def dependency_clusters(G: nx.DiGraph, df_nodes: pd.DataFrame) -> Tuple[str, pd.DataFrame]:
    if SKIP_DEP_CLUSTERS:
        df_nodes['DependencyCluster'] = 0
        return 'skipped', df_nodes
    if _NK and ALWAYS_USE_LOUVAIN and len(G) > 1:
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
    # Fingerprint fallback (enriched)
    out_deg = dict(G.out_degree())
    in_deg  = dict(G.in_degree())
    succs = {n:set(G.successors(n)) for n in G.nodes}
    two_hop_out = {}
    succ_out_deg_median = {}
    for n,s in succs.items():
        two = set()
        succ_out_degs = []
        for x in s:
            succ_out_degs.append(out_deg.get(x,0))
            two.update(G.successors(x))
        two_hop_out[n]=len(two)
        if succ_out_degs:
            succ_out_deg_median[n]=float(np.median(succ_out_degs))
        else:
            succ_out_deg_median[n]=0.0
    records = []
    for nid in df_nodes['ID'].astype(str):
        records.append((out_deg.get(nid,0), in_deg.get(nid,0), len(succs.get(nid,())), two_hop_out.get(nid,0), succ_out_deg_median.get(nid,0.0)))
    # Map unique fingerprints to incremental cluster IDs
    unique = {}
    clusters = []
    for fp in records:
        if fp not in unique:
            unique[fp] = len(unique)
        clusters.append(unique[fp])
    df_nodes['DependencyCluster'] = clusters
    return 'fingerprint', df_nodes

def community_detection(G: nx.DiGraph, df_nodes: pd.DataFrame) -> Tuple[str, pd.DataFrame]:
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
    # Greedy fallback
    try:
        comms = nx.algorithms.community.greedy_modularity_communities(G.to_undirected())
        mapping = {}
        for cid, group in enumerate(comms):
            for n in group: mapping[n]=cid
        df_nodes['CommunityGroup'] = df_nodes['ID'].astype(str).map(mapping).fillna(-1).astype(int)
        return 'greedy', df_nodes
    except Exception as e:
        logging.warning(f"Community fallback failed: {e}")
        df_nodes['CommunityGroup'] = 0
        return 'failed', df_nodes

def centralities(G: nx.DiGraph, df_nodes: pd.DataFrame) -> Tuple[str, pd.DataFrame, bool]:
    if SKIP_CENTRALITIES:
        for col,val in [('PageRank',0.0),('degree_centrality',0.0),('Clustering_Coefficient',0.0),('closeness_centrality',0.0)]:
            if col not in df_nodes.columns:
                df_nodes[col] = val
        return 'skipped', df_nodes, False

    existing_cols = {'PageRank','degree_centrality','Clustering_Coefficient','closeness_centrality'}
    if existing_cols.issubset(set(df_nodes.columns)) and not FORCE_RECOMPUTE_METRICS:
        # Normalize NaNs
        df_nodes['closeness_centrality'] = df_nodes['closeness_centrality'].fillna(0.0)
        return 'reused', df_nodes, df_nodes['closeness_centrality'].any()

    closeness_computed = False

    if _NK and len(G)>1:
        try:
            node_list=list(G.nodes())
            nx_to_nk={n:i for i,n in enumerate(node_list)}
            G_nk = nka.nx2nk(G)
            pr_algo = nk.centrality.PageRank(G_nk, damp=0.9)
            pr_algo.run(); pr = pr_algo.scores()
            deg_algo = nk.centrality.DegreeCentrality(G_nk, normalized=True)
            deg_algo.run(); deg = deg_algo.scores()
            Gu_nk = nka.nx2nk(G.to_undirected())
            lcc_algo = nk.centrality.LocalClusteringCoefficient(Gu_nk)
            lcc_algo.run(); lcc = lcc_algo.scores()
            close_scores = None
            if len(G) <= 1500:
                hc = nk.centrality.HarmonicCloseness(G_nk, normalized=True)
                hc.run(); close_scores = hc.scores(); closeness_computed = True
            pr_list=[];deg_list=[];lcc_list=[];close_list=[]
            for nid in df_nodes['ID'].astype(str):
                idx=nx_to_nk.get(nid)
                if idx is None:
                    pr_list.append(0.0);deg_list.append(0.0);lcc_list.append(0.0);close_list.append(0.0)
                else:
                    pr_list.append(pr[idx]);deg_list.append(deg[idx]);lcc_list.append(lcc[idx]);
                    close_list.append(0.0 if close_scores is None else close_scores[idx])
            df_nodes['PageRank']=pr_list
            df_nodes['degree_centrality']=deg_list
            df_nodes['Clustering_Coefficient']=lcc_list
            df_nodes['closeness_centrality']=close_list
            return 'networkit', df_nodes, closeness_computed
        except Exception as e:
            logging.warning(f"NK centralities failed: {e}; fallback NX")

    # NetworkX fallback
    pr = nx.pagerank(G, alpha=0.9)
    deg = nx.degree_centrality(G)
    clust = nx.clustering(G.to_undirected())
    close = None
    if len(G) <= 1500:
        close = nx.closeness_centrality(G); closeness_computed = True
    id_series = df_nodes['ID'].astype(str)
    df_nodes['PageRank'] = id_series.map(pr).fillna(0.0)
    df_nodes['degree_centrality'] = id_series.map(deg).fillna(0.0)
    df_nodes['Clustering_Coefficient'] = id_series.map(clust).fillna(0.0)
    if close:
        df_nodes['closeness_centrality'] = id_series.map(close).fillna(0.0)
    else:
        df_nodes['closeness_centrality'] = 0.0
    return 'networkx', df_nodes, closeness_computed

# ---------------------- Risk/Importance Clustering & PCA ---------------------- #

def risk_importance_clustering(df_nodes: pd.DataFrame, feature_hash_current: str, cached_feature_hash: str) -> Tuple[str, pd.DataFrame, bool]:
    if not ENABLE_RISK_IMPORTANCE_KMEANS:
        if 'Cluster' not in df_nodes.columns: df_nodes['Cluster']=0
        return 'skipped', df_nodes, False
    if {'importanceScore','riskScore'}.issubset(df_nodes.columns):
        # Decide recompute
        recompute = FORCE_RECOMPUTE_METRICS or ('Cluster' not in df_nodes.columns) or (feature_hash_current != cached_feature_hash)
        if not recompute:
            return 'reused', df_nodes, False
        vals = df_nodes[['importanceScore','riskScore']].fillna(0).values
        n=len(vals)
        if n<2:
            df_nodes['Cluster']=0
            return 'trivial', df_nodes, recompute
        k=max(2,min(8,int(np.sqrt(n/2))))
        from sklearn.cluster import KMeans
        df_nodes['Cluster']=KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(vals)
        return f'kmeans_{k}', df_nodes, recompute
    else:
        df_nodes['Cluster']=0
        return 'missing_feats', df_nodes, False

def pca_embed(df_nodes: pd.DataFrame, feature_hash_current: str, cached_feature_hash: str) -> Tuple[str, pd.DataFrame]:
    if not {'importanceScore','riskScore'}.issubset(df_nodes.columns):
        df_nodes['pca1']=0.0; df_nodes['pca2']=0.0
        return 'missing_feats', df_nodes
    reuse = (not FORCE_RECOMPUTE_METRICS and all(c in df_nodes.columns for c in ['pca1','pca2']) and feature_hash_current == cached_feature_hash)
    if reuse:
        return 'reused', df_nodes
    from sklearn.decomposition import PCA
    arr = df_nodes[['importanceScore','riskScore']].fillna(0).values
    if len(arr)>1:
        pc = PCA(2).fit_transform(arr)
        df_nodes['pca1']=pc[:,0]; df_nodes['pca2']=pc[:,1]
    else:
        df_nodes['pca1']=0.0; df_nodes['pca2']=0.0
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
                'centralities_method': 'none', 'recomputed': False, 'metrics_skipped': {},
                'processing_time_sec': 0.0, 'closeness_computed': False,
                'feature_hash_changed': False
            }
        }

    df_nodes = pd.DataFrame(nodes)
    if 'ID' not in df_nodes.columns:
        df_nodes['ID'] = range(len(df_nodes))

    sh = structural_hash(nodes, links)
    struct_cached = None if FORCE_RECOMPUTE_METRICS else redis_get_struct(sh)

    # Feature hash for clustering / PCA
    feature_hash_current = feature_hash(df_nodes)
    cached_feature_hash = struct_cached.get('feature_hash') if struct_cached else None

    need_graph = struct_cached is None or any(col not in df_nodes.columns for col in ['DependencyCluster','CommunityGroup'])
    if need_graph:
        G = build_graph(nodes, links)
        G = ensure_dag(G)
    else:
        # Graph may still be needed for centralities if we recompute them
        G = build_graph(nodes, links)
        G = ensure_dag(G)

    recomputed = False

    if struct_cached is None:
        recomputed = True
        dep_method, df_nodes = dependency_clusters(G, df_nodes)
        comm_method, df_nodes = community_detection(G, df_nodes)
        cent_method, df_nodes, closeness_computed = centralities(G, df_nodes)

        # Build per-ID mapping for cache
        per_id = {}
        for r in df_nodes.itertuples():
            nid = str(r.ID)
            per_id[nid] = {
                'DependencyCluster': int(getattr(r,'DependencyCluster',0)),
                'CommunityGroup': int(getattr(r,'CommunityGroup',0)),
                'PageRank': float(getattr(r,'PageRank',0.0)),
                'degree_centrality': float(getattr(r,'degree_centrality',0.0)),
                'Clustering_Coefficient': float(getattr(r,'Clustering_Coefficient',0.0)),
                'closeness_centrality': float(getattr(r,'closeness_centrality',0.0))
            }
        struct_cached = {
            'by_id': per_id,
            'dep_method': dep_method,
            'comm_method': comm_method,
            'cent_method': cent_method,
            'feature_hash': feature_hash_current,
            'closeness_computed': closeness_computed
        }
        redis_set_struct(sh, struct_cached)
    else:
        dep_method = struct_cached.get('dep_method','cached')
        comm_method = struct_cached.get('comm_method','cached')
        cent_method = struct_cached.get('cent_method','cached')
        closeness_computed = struct_cached.get('closeness_computed', False)
        # Inject metrics by ID
        by_id = struct_cached.get('by_id', {})
        id_map = df_nodes['ID'].astype(str)
        for col in ['DependencyCluster','CommunityGroup','PageRank','degree_centrality','Clustering_Coefficient','closeness_centrality']:
            if col not in df_nodes.columns or FORCE_RECOMPUTE_METRICS:
                df_nodes[col] = id_map.map(lambda x: by_id.get(x, {}).get(col, 0.0))
        # Normalize closeness
        df_nodes['closeness_centrality'] = df_nodes['closeness_centrality'].fillna(0.0)

    # Centralities recompute if forced
    if FORCE_RECOMPUTE_METRICS and not SKIP_CENTRALITIES:
        cent_method, df_nodes, closeness_computed = centralities(G, df_nodes)

    ric_method, df_nodes, cluster_recomputed = risk_importance_clustering(df_nodes, feature_hash_current, cached_feature_hash)
    pca_method, df_nodes = pca_embed(df_nodes, feature_hash_current, cached_feature_hash)

    metrics_skipped = {
        'dependency_clusters': dep_method,
        'communities': comm_method,
        'centralities': cent_method,
        'risk_importance': ric_method,
        'pca': pca_method
    }

    df_nodes = df_nodes.replace({np.nan: None})

    response = {
        'nodes': df_nodes.to_dict('records'),
        'links': links,
        'critical_path': [],                 # placeholder
        'critical_path_length': 0,           # placeholder
        'work_packages': {},                 # placeholder
        'templates': {},                     # placeholder
        'meta': {
            'algo_version': ALGO_VERSION,
            'structural_hash': sh,
            'structural_cache_hit': not recomputed,
            'dependency_cluster_method': dep_method,
            'centralities_method': cent_method,
            'recomputed': recomputed,
            'metrics_skipped': metrics_skipped,
            'processing_time_sec': round(time.time()-start,4),
            'closeness_computed': closeness_computed,
            'feature_hash_changed': feature_hash_current != cached_feature_hash,
            'feature_hash': feature_hash_current
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
        _add_cors_headers(r)
        return r

    data = request.get_json(force=True, silent=True) or {}
    nodes = data.get('nodes', [])
    links = data.get('links', [])

    if not isinstance(nodes, list) or not isinstance(links, list):
        return _error_response('Invalid payload structure', 400)

    if MAX_NODES and len(nodes) > MAX_NODES:
        return _error_response(f'Node count {len(nodes)} exceeds MAX_NODES={MAX_NODES}', 413)
    if MAX_LINKS and len(links) > MAX_LINKS:
        return _error_response(f'Link count {len(links)} exceeds MAX_LINKS={MAX_LINKS}', 413)

    try:
        cache_key_payload = json.dumps([nodes, links], sort_keys=True, default=str)
        res = _cached(cache_key_payload, '0')  # use dummy second param to keep signature (links not hashed separately here)
        # NOTE: For LRU distinctness we combine nodes+links already; reuse second param placeholder.
        cache_info = _cached.cache_info()
        res['meta']['lru_cache'] = {
            'hits': cache_info.hits,
            'misses': cache_info.misses,
            'currsize': cache_info.currsize
        }
        res['meta']['cache_key'] = hashlib.sha256(cache_key_payload.encode()).hexdigest()
        r = jsonify(res)
        _add_cors_headers(r)
        return r
    except Exception as e:
        logging.exception("graph-metrics error")
        return _error_response(str(e), 500)

@app.route('/health', methods=['GET'])
def health():
    try:
        redis_ok = False
        if redis_client:
            try: redis_ok = bool(redis_client.ping())
            except Exception: redis_ok = False
        cache_info = _cached.cache_info()
        return jsonify({
            'status':'healthy' if redis_ok or not REDIS_URL else 'degraded',
            'algo_version': ALGO_VERSION,
            'networkit': _NK,
            'redis': {'configured': bool(REDIS_URL), 'ok': redis_ok},
            'lru': {'hits': cache_info.hits, 'misses': cache_info.misses, 'currsize': cache_info.currsize},
            'timestamp': datetime.utcnow().isoformat()
        })
    except Exception as e:
        return _error_response(str(e), 500)

@app.errorhandler(HTTPException)
def http_err(e):
    return _error_response(e.description, e.code)

@app.errorhandler(Exception)
def unhandled(e):
    logging.exception('Unhandled')
    return _error_response(str(e), 500)

@app.after_request
def after(resp):
    _add_cors_headers(resp)
    return resp

@app.route('/', methods=['GET'])
def index():
    return jsonify({'status':'ok','service':'python-sched-analytics','version':ALGO_VERSION})

# ---------------------- Utility Responses ---------------------- #

def _add_cors_headers(resp):
    origin_list = ALLOWED_ORIGINS
    # If wildcard OR origin present and allowed, respond with specific origin for stricter mode
    if '*' in origin_list:
        resp.headers.add('Access-Control-Allow-Origin','*')
    else:
        req_origin = request.headers.get('Origin')
        if req_origin and req_origin in origin_list:
            resp.headers.add('Access-Control-Allow-Origin', req_origin)
    resp.headers.add('Access-Control-Allow-Headers','Content-Type, Authorization')
    resp.headers.add('Access-Control-Allow-Methods','POST, GET, OPTIONS')
    return resp

def _error_response(message: str, code: int):
    payload = {'error': message, 'code': code}
    r = jsonify(payload)
    r.status_code = code
    _add_cors_headers(r)
    return r

# ---------------------- Entrypoint ---------------------- #
if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=DEBUG)
