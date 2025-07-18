"""
Pyth-Sched-Analytics • Ultra Lean v3.3.0
=============================================================
Goal: Maximum throughput & minimum latency for /graph-metrics while
preserving backward-compatible JSON schema expected by legacy
consumers: { nodes, links, critical_path, critical_path_length,
work_packages, templates, meta }

Design Rationale
----------------
1. **Removed Subsystems**: Redis + structural cache, pattern/template
   generation, work-package derivation, critical path computation,
   expensive O(n^2) dependency distance matrices, PCA (optional), and
   NetworkKit requirement (used only if present—no hard dependency).
2. **Deterministic & Minimal**: Cycle breaking picks the edge with the
   lowest (weight, source_id, target_id) tuple for repeatability across
   runs & replicas.
3. **Adaptive Light Metrics**:
   - Dependency clustering: Louvain (if NK & graph < NK_DEP_LIMIT), else
     degree+2-hop signature hashing (pure O(E)).
   - Community detection reuses dependency clusters when identical method
     already yields group structure; else runs same logic (no duplicate heavy work).
   - Risk/importance clustering: single-pass KMeans with stable k
     derived from heuristic (bounded) unless skipped.
   - Centralities: PageRank + degree centrality only (fast) unless disabled.
4. **Fail-Fast Guards**: Reject overly large payloads early to protect
   CPU & memory (configurable MAX_NODES/MAX_LINKS).
5. **Boolean Parsing**: Robust truthy set; ensures consistent flags.
6. **Extensibility Hooks**: Simple env flags to re-enable latent features
   without structural code bloat.
7. **Cache**: Only in-process LRU keyed by full payload JSON. Avoids
   complexity / serialization overhead while still skipping repeat work
   within the same process.

Environment Flags
-----------------
DEBUG                      (default 'false') – verbose logging.
MAX_NODES                  (default 12000)
MAX_LINKS                  (default 24000)
SKIP_DEP_GROUPS            (default 'false')
SKIP_COMMUNITIES           (default 'false')
SKIP_RISK_IMPORTANCE       (default 'false')
SKIP_CENTRALITIES          (default 'false')
SKIP_PCA                   (default 'true')  – PCA off by default.
FORCE_RECOMPUTE            (default 'false') – bypass reuse if future reuse logic added.
KMEANS_MAX_K               (default 8)
KMEANS_MIN_K               (default 2)
KMEANS_HEURISTIC_DIVISOR   (default 2.0) – k ≈ sqrt(n / divisor)
ENABLE_NETWORKIT           (default 'true') – allow NK usage if installed.

Returned meta fields:
  meta = {
    'algo_version', 'processing_time_sec', 'node_count', 'edge_count',
    'methods': { 'dependency_clusters', 'communities', 'centralities', 'risk_importance', 'pca' },
    'skipped': { feature: bool }
  }

Performance Notes
-----------------
Empirical complexity now dominated by: KMeans O(n * k * iters) (small k),
PageRank O(E * iterations) with convergence typically quick for sparse DAG-ish graphs,
Louvain O(E log V) (if NetworkKit). Fallback dependency fingerprint O(E).
Memory footprint ~ O(V + E) without quadratic temporary matrices.
"""
import os, json, time, logging, hashlib
from functools import lru_cache
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

try:
    import networkx as nx
except ImportError:  # Extremely unlikely in deployed env, but guard.
    raise RuntimeError("networkx required")

# Optional acceleration
_ENABLE_NETWORKIT = os.getenv("ENABLE_NETWORKIT", "true").lower() == "true"
try:
    if _ENABLE_NETWORKIT:
        import networkit as nk
        from networkit import nxadapter as nka
        _NK = True
    else:
        _NK = False
except ImportError:
    _NK = False

# ---------------- Configuration ---------------- #
DEBUG                = os.getenv("DEBUG", "false").lower() == "true"
MAX_NODES            = int(os.getenv("MAX_NODES", 12000))
MAX_LINKS            = int(os.getenv("MAX_LINKS", 24000))
SKIP_DEP_GROUPS      = os.getenv("SKIP_DEP_GROUPS", "false").lower() == "true"
SKIP_COMMUNITIES     = os.getenv("SKIP_COMMUNITIES", "false").lower() == "true"
SKIP_RISK_IMPORTANCE = os.getenv("SKIP_RISK_IMPORTANCE", "false").lower() == "true"
SKIP_CENTRALITIES    = os.getenv("SKIP_CENTRALITIES", "false").lower() == "true"
SKIP_PCA             = os.getenv("SKIP_PCA", "true").lower() == "true"
FORCE_RECOMPUTE      = os.getenv("FORCE_RECOMPUTE", "false").lower() == "true"
KMEANS_MAX_K         = int(os.getenv("KMEANS_MAX_K", 8))
KMEANS_MIN_K         = int(os.getenv("KMEANS_MIN_K", 2))
KMEANS_HEURISTIC_DIV = float(os.getenv("KMEANS_HEURISTIC_DIVISOR", 2.0))
ALGO_VERSION         = "3.3.0"

# Thread / BLAS limiting to reduce contention
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.WARNING,
    format="%(asctime)s %(levelname)s » %(message)s"
)

_truthy = {"true","1","yes","y","t"}

def tbool(v):
    return str(v).strip().lower() in _truthy

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# ---------------- LRU Request Cache ---------------- #
@lru_cache(maxsize=32)
def _cached(payload_hash: str, nodes_json: str, links_json: str):
    nodes = json.loads(nodes_json)
    links = json.loads(links_json)
    return analyse(nodes, links)

# ---------------- Graph Build ---------------- #

def build_graph(nodes, links):
    G = nx.DiGraph()
    # Edges (bulk)
    edge_attrs = []
    for e in links:
        s = str(e.get('source'))
        t = str(e.get('target'))
        if not s or not t:  # skip malformed
            continue
        d = e.get('duration', e.get('Duration', 1))
        try:
            d = float(d)
        except Exception:
            d = 1.0
        edge_attrs.append((s, t, { 'weight': d, 'duration': d }))
    G.add_edges_from(edge_attrs)

    if not nodes:
        return G

    df = pd.DataFrame(nodes)
    if 'ID' not in df.columns:
        df['ID'] = range(len(df))
    # Date handling
    df['Start']  = pd.to_datetime(df.get('Start'),  errors='coerce')
    df['Finish'] = pd.to_datetime(df.get('Finish'), errors='coerce')
    # Duration numeric
    df['Duration'] = pd.to_numeric(df.get('Duration', 1), errors='coerce').fillna(1).astype(float)
    # Fallback end date if Finish missing
    missing_finish = df['Finish'].isna() & df['Start'].notna()
    df.loc[missing_finish, 'Finish'] = df.loc[missing_finish,'Start'] + df.loc[missing_finish,'Duration'].map(lambda d: timedelta(days=d))

    bool_cols = ['isImportanceOutlier','isOnCriticalPath','isOnOutlierPath','isRiskOutlier','Milestone']
    for col in bool_cols:
        if col in df.columns:
            df[col] = df[col].apply(tbool)
        else:
            df[col] = False

    attrs = {}
    for r in df.itertuples():
        nid = str(r.ID)
        attrs[nid] = {
            'start_date': r.Start.to_pydatetime() if isinstance(r.Start, pd.Timestamp) and not pd.isna(r.Start) else None,
            'end_date': r.Finish.to_pydatetime() if isinstance(r.Finish, pd.Timestamp) and not pd.isna(r.Finish) else None,
            'duration': r.Duration,
            'Milestone': r.Milestone,
            'isImportanceOutlier': r.isImportanceOutlier,
            'isOnCriticalPath': r.isOnCriticalPath,
            'isOnOutlierPath': r.isOnOutlierPath,
            'isRiskOutlier': r.isRiskOutlier
        }
    G.add_nodes_from(attrs.keys())
    nx.set_node_attributes(G, attrs)
    return G

# ---------------- Deterministic Cycle Removal ---------------- #

def make_dag(G: nx.DiGraph):
    while True:
        try:
            cycle = nx.find_cycle(G, orientation='original')
            # gather candidate edges
            candidates = []
            for (u,v,_dir) in cycle:
                w = G[u][v].get('weight',1)
                candidates.append((w, str(u), str(v)))
            # pick deterministic smallest tuple
            _, u, v = min(candidates)
            G.remove_edge(u,v)
        except nx.NetworkXNoCycle:
            break
    # Connect orphan milestone starts/ends
    starts = [n for n in G if G.nodes[n].get('Milestone') and G.in_degree(n)==0]
    ends   = [n for n in G if G.nodes[n].get('Milestone') and G.out_degree(n)==0]
    if starts and ends:
        s0, e0 = starts[0], ends[0]
        orphan_starts = [n for n in G if G.in_degree(n)==0 and n!=s0]
        orphan_ends   = [n for n in G if G.out_degree(n)==0 and n!=e0]
        for n in orphan_starts: G.add_edge(s0,n,weight=0,duration=0)
        for n in orphan_ends:   G.add_edge(n,e0,weight=0,duration=0)
    return G

# ---------------- Dependency Clusters ---------------- #

def dependency_clusters(G: nx.DiGraph, df):
    if SKIP_DEP_GROUPS:
        df['DependencyCluster'] = 0
        return 'skipped', df
    if _NK and len(G) > 1:
        try:
            Gu = G.to_undirected()
            node_list = list(Gu.nodes())
            G_nk = nka.nx2nk(Gu)
            algo = nk.community.PLM(G_nk, seed=0)
            algo.run()
            part = algo.getPartition()
            mapping = {node_list[i]: part.subsetOf(i) for i in range(len(node_list))}
            df['DependencyCluster'] = df['ID'].astype(str).map(mapping).fillna(-1).astype(int)
            return 'louvain', df
        except Exception as e:
            if DEBUG: logging.warning(f"Louvain dep clustering failed: {e}; fallback")
    # Fallback fingerprint O(E)
    out_deg = dict(G.out_degree())
    succ = {n:set(G.successors(n)) for n in G}
    two_hop = {}
    for n,s in succ.items():
        t=set()
        for x in s: t.update(G.successors(x))
        two_hop[n]=len(t)
    sigs = []
    for nid in df['ID'].astype(str):
        sig = (out_deg.get(nid,0), len(succ.get(nid,())), two_hop.get(nid,0))
        sigs.append(sig)
    # Hash with larger digest to reduce collisions
    labels = {}
    cluster_ids = []
    next_id = 0
    for s in sigs:
        h = hashlib.blake2b(str(s).encode(), digest_size=8).hexdigest()
        if h not in labels:
            labels[h] = next_id; next_id += 1
        cluster_ids.append(labels[h])
    df['DependencyCluster'] = cluster_ids
    return 'fingerprint', df

# ---------------- Community Detection ---------------- #

def community_detection(G: nx.DiGraph, df, dep_method):
    if SKIP_COMMUNITIES:
        df['CommunityGroup'] = 0
        return 'skipped', df
    # If we already derived a good partition (Louvain) for dependency clusters, reuse it
    if dep_method == 'louvain':
        df['CommunityGroup'] = df['DependencyCluster']
        return 'reused_louvain', df
    # Else try Louvain independently
    if _NK and len(G) > 1:
        try:
            Gu = G.to_undirected()
            node_list = list(Gu.nodes())
            G_nk = nka.nx2nk(Gu)
            algo = nk.community.PLM(G_nk, seed=1)
            algo.run()
            part = algo.getPartition()
            mapping = {node_list[i]: part.subsetOf(i) for i in range(len(node_list))}
            df['CommunityGroup'] = df['ID'].astype(str).map(mapping).fillna(-1).astype(int)
            return 'louvain', df
        except Exception as e:
            if DEBUG: logging.warning(f"Community Louvain failed: {e}; fallback greedy")
    # Fallback greedy modularity
    try:
        comms = nx.algorithms.community.greedy_modularity_communities(G.to_undirected())
        mapping = {}
        for cid, grp in enumerate(comms):
            for n in grp: mapping[n]=cid
        df['CommunityGroup'] = df['ID'].astype(str).map(mapping).fillna(-1).astype(int)
        return 'greedy', df
    except Exception as e:
        if DEBUG: logging.warning(f"Community fallback failed: {e}")
        df['CommunityGroup'] = 0
        return 'failed', df

# ---------------- Risk / Importance Clustering ---------------- #

def risk_importance(df):
    if SKIP_RISK_IMPORTANCE:
        if 'Cluster' not in df.columns: df['Cluster']=0
        return 'skipped', df
    if 'importanceScore' not in df.columns or 'riskScore' not in df.columns:
        df['Cluster']=0
        return 'missing_feats', df
    vals = df[['importanceScore','riskScore']].fillna(0).values
    n = len(vals)
    if n < 2:
        df['Cluster']=0
        return 'trivial', df
    from sklearn.cluster import KMeans
    k_heur = max(KMEANS_MIN_K, min(KMEANS_MAX_K, int(np.sqrt(n / max(0.1, KMEANS_HEURISTIC_DIV)))))
    k = max(2, min(KMEANS_MAX_K, k_heur))
    kmeans = KMeans(n_clusters=k, n_init=5, random_state=0)
    df['Cluster'] = kmeans.fit_predict(vals)
    return f'kmeans_{k}', df

# ---------------- PCA (optional) ---------------- #

def pca_embed(df):
    if SKIP_PCA:
        df['pca1']=0; df['pca2']=0
        return 'skipped', df
    if 'importanceScore' not in df.columns or 'riskScore' not in df.columns:
        df['pca1']=0; df['pca2']=0
        return 'missing_feats', df
    arr = df[['importanceScore','riskScore']].fillna(0).values
    if len(arr) > 1:
        from sklearn.decomposition import PCA
        pc = PCA(2).fit_transform(arr)
        df['pca1']=pc[:,0]; df['pca2']=pc[:,1]
        return 'pca', df
    df['pca1']=0; df['pca2']=0
    return 'trivial', df

# ---------------- Centralities (minimal) ---------------- #

def centralities(G: nx.DiGraph, df):
    if SKIP_CENTRALITIES:
        for col,val in [('PageRank',0),('degree_centrality',0)]:
            if col not in df: df[col]=val
        return 'skipped', df
    # PageRank & degree only (fast)
    try:
        pr = nx.pagerank(G, alpha=0.9)
    except Exception:
        pr = {n:0 for n in G}
    deg = nx.degree_centrality(G)
    ids = df['ID'].astype(str)
    df['PageRank'] = ids.map(pr).fillna(0)
    df['degree_centrality'] = ids.map(deg).fillna(0)
    return 'pagerank_degree', df

# ---------------- Main Analyse ---------------- #

def analyse(nodes, links):
    t0 = time.time()
    n_nodes = len(nodes)
    n_links = len(links)

    if n_nodes > MAX_NODES or n_links > MAX_LINKS:
        return {
            'error': f'Payload too large (nodes={n_nodes}, links={n_links})',
            'nodes': [], 'links': [], 'critical_path': [], 'critical_path_length': 0,
            'work_packages': {}, 'templates': {}, 'meta': {'algo_version': ALGO_VERSION}
        }

    if not nodes:
        return {
            'nodes': [], 'links': links, 'critical_path': [], 'critical_path_length': 0,
            'work_packages': {}, 'templates': {},
            'meta': {
                'algo_version': ALGO_VERSION,
                'processing_time_sec': 0.0,
                'node_count': 0,
                'edge_count': len(links),
                'methods': {},
                'skipped': {}
            }
        }

    df = pd.DataFrame(nodes)
    if 'ID' not in df.columns:
        df['ID'] = range(len(df))

    # Build & sanitize graph
    G = build_graph(nodes, links)
    G = make_dag(G)

    methods = {}
    skipped = {
        'dependency_clusters': SKIP_DEP_GROUPS,
        'communities': SKIP_COMMUNITIES,
        'risk_importance': SKIP_RISK_IMPORTANCE,
        'centralities': SKIP_CENTRALITIES,
        'pca': SKIP_PCA
    }

    dep_method, df = dependency_clusters(G, df); methods['dependency_clusters']=dep_method
    comm_method, df = community_detection(G, df, dep_method); methods['communities']=comm_method
    ri_method, df = risk_importance(df); methods['risk_importance']=ri_method
    pca_method, df = pca_embed(df); methods['pca']=pca_method
    cent_method, df = centralities(G, df); methods['centralities']=cent_method

    df = df.replace({np.nan: None})

    response = {
        'nodes': df.to_dict('records'),
        'links': links,
        'critical_path': [],              # placeholders for backward compatibility
        'critical_path_length': 0,
        'work_packages': {},
        'templates': {},
        'meta': {
            'algo_version': ALGO_VERSION,
            'processing_time_sec': round(time.time()-t0, 4),
            'node_count': n_nodes,
            'edge_count': n_links,
            'methods': methods,
            'skipped': skipped
        }
    }
    return response

# ---------------- Routes ---------------- #
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

    # LRU hash (payload-level)
    payload_hash = hashlib.sha256(json.dumps([nodes, links], sort_keys=True, default=str).encode()).hexdigest()
    try:
        res = _cached(payload_hash, json.dumps(nodes, sort_keys=True, default=str), json.dumps(links, sort_keys=True, default=str))
        # Add LRU stats
        info = _cached.cache_info()
        res['meta']['lru_cache'] = {
            'hits': info.hits,
            'misses': info.misses,
            'currsize': info.currsize
        }
        res['meta']['cache_key'] = payload_hash
        r = jsonify(res)
        r.headers.add('Access-Control-Allow-Origin','*')
        return r
    except Exception as e:
        if DEBUG: logging.exception('graph-metrics error')
        r = jsonify({'error': str(e)})
        r.headers.add('Access-Control-Allow-Origin','*')
        return r, 500

@app.route('/health', methods=['GET'])
def health():
    info = _cached.cache_info()
    return jsonify({
        'status': 'healthy',
        'algo_version': ALGO_VERSION,
        'networkit': _NK,
        'timestamp': datetime.utcnow().isoformat(),
        'cache': {
            'hits': info.hits,
            'misses': info.misses,
            'currsize': info.currsize
        },
        'config': {
            'max_nodes': MAX_NODES,
            'max_links': MAX_LINKS,
            'skip_dep_groups': SKIP_DEP_GROUPS,
            'skip_communities': SKIP_COMMUNITIES,
            'skip_risk_importance': SKIP_RISK_IMPORTANCE,
            'skip_centralities': SKIP_CENTRALITIES,
            'skip_pca': SKIP_PCA
        }
    })

@app.errorhandler(HTTPException)
def http_err(e):
    r = jsonify({'error': e.description})
    r.status_code = e.code
    r.headers.add('Access-Control-Allow-Origin','*')
    return r

@app.errorhandler(Exception)
def unhandled(e):
    if DEBUG: logging.exception('Unhandled')
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

if __name__ == '__main__':
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=DEBUG)
