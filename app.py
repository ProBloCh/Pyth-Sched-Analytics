import os
import logging
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import pandas as pd
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score
import networkx as nx

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
CORS(app)  # Enable CORS for all routes and origins

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

def calculate_critical_path(G):
    critical_path = nx.dag_longest_path(G, weight='duration')
    critical_path_length = nx.dag_longest_path_length(G, weight='duration')
    return critical_path, critical_path_length

def define_work_packages(nodes_df, G):
    work_packages = {}
    
    if 'Cluster' in nodes_df.columns:
        for cluster in nodes_df['Cluster'].unique():
            cluster_nodes = nodes_df[nodes_df['Cluster'] == cluster]
            tasks = cluster_nodes['ID'].tolist()

            subgraph = G.subgraph(tasks)
            sub_critical_path = nx.dag_longest_path(subgraph, weight='duration')
            sub_critical_duration = nx.dag_longest_path_length(subgraph, weight='duration')

            if not subgraph.nodes:
                continue
            start_dates = [G.nodes[node]['start_date'] for node in subgraph if 'start_date' in G.nodes[node]]
            end_dates = [G.nodes[node]['end_date'] for node in subgraph if 'end_date' in G.nodes[node]]

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

def dependency_clustering(nodes_df, G):
    path_length = dict(nx.all_pairs_dijkstra_path_length(G, weight='weight'))
    size = len(nodes_df)
    distance_matrix = np.zeros((size, size), dtype=float)
    ids = nodes_df['ID'].tolist()

    for i, source_node in enumerate(ids):
        for j, target_node in enumerate(ids):
            distance = path_length.get(str(source_node), {}).get(str(target_node), np.inf)
            distance_matrix[i, j] = distance if distance != np.inf else 1e9

    max_clusters = 10
    best_score = -1
    best_n_clusters = 3
    for n_clusters in range(3, max_clusters):
        clustering = AgglomerativeClustering(n_clusters=n_clusters, linkage='complete', metric='precomputed')
        labels = clustering.fit_predict(distance_matrix)
        if len(set(labels)) > 1:
            score = silhouette_score(distance_matrix, labels, metric='precomputed')
            logging.info(f"Silhouette Score for {n_clusters} clusters: {score}")
            if score > best_score:
                best_score = score
                best_n_clusters = n_clusters

    best_clustering = AgglomerativeClustering(n_clusters=best_n_clusters, linkage='complete', metric='precomputed')
    nodes_df['DependencyCluster'] = best_clustering.fit_predict(distance_matrix)

    return nodes_df

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

# Commented out reduced graph creation for now
# def create_reduced_dag(G, critical_nodes):
#     reduced_dag = G.subgraph(critical_nodes).copy()
#     reduced_dag = make_dag(reduced_dag)
#     return reduced_dag

def make_dag(G):
    try:
        cycles = list(nx.find_cycle(G, orientation='original'))
        while cycles:
            for cycle in cycles:
                G.remove_edge(cycle[-1][0], cycle[-1][1])
            cycles = list(nx.find_cycle(G, orientation='original'))
    except nx.NetworkXNoCycle:
        pass

    start_milestones = [node for node in G.nodes if G.nodes[node].get('Milestone') == 1 and G.in_degree(node) == 0]
    end_milestones = [node for node in G.nodes if G.nodes[node].get('Milestone') == 1 and G.out_degree(node) == 0]

    if not start_milestones:
        raise ValueError("No start milestone found")
    if not end_milestones:
        raise ValueError("No end milestone found")

    start_milestone = start_milestones[0]
    end_milestone = end_milestones[0]

    for node in G.nodes:
        if G.in_degree(node) == 0 and node != start_milestone:
            G.add_edge(start_milestone, node)

    for node in G.nodes:
        if G.out_degree(node) == 0 and node != end_milestone:
            G.add_edge(node, end_milestone)

    return G

def perform_clustering(nodes_df):
    features = nodes_df[['importanceScore', 'riskScore']].values

    max_clusters = 10
    best_score = -1
    best_n_clusters = 3
    for n_clusters in range(2, max_clusters + 1):
        kmeans = KMeans(n_clusters=n_clusters, random_state=0)
        labels = kmeans.fit_predict(features)
        score = silhouette_score(features, labels)
        logging.info(f"Silhouette Score for {n_clusters} clusters: {score}")
        if score > best_score:
            best_score = score
            best_n_clusters = n_clusters

    kmeans = KMeans(n_clusters=best_n_clusters, random_state=0)
    nodes_df['Cluster'] = kmeans.fit_predict(features)

    return nodes_df, kmeans

def perform_pca(nodes_df):
    features = nodes_df[['importanceScore', 'avgWeightedRisk']].values
    pca = PCA(n_components=2)
    pca_result = pca.fit_transform(features)
    nodes_df['pca1'] = pca_result[:, 0]
    nodes_df['pca2'] = pca_result[:, 1]

    return nodes_df

def process_graph(nodes, links):
    logging.info("Processing graph...")
    logging.debug(f"Nodes: {nodes}")
    logging.debug(f"Links: {links}")

    nodes_df = pd.DataFrame(nodes)
    links_df = pd.DataFrame(links)

    logging.debug("Nodes DataFrame:")
    logging.debug(nodes_df)
    logging.debug("Links DataFrame:")
    logging.debug(links_df)

    if 'avgWeightedRisk' not in nodes_df.columns:
        nodes_df['avgWeightedRisk'] = 0

    try:
        G = preprocess_graph(nodes, links)
        G = make_dag(G)
    except Exception as e:
        logging.error(f"Error during graph preprocessing: {str(e)}")
        return {"error": "Error during graph preprocessing"}

    logging.debug("Preprocessed Graph:")
    logging.debug(G.nodes(data=True))
    logging.debug(G.edges(data=True))

    try:
        nodes_df, kmeans = perform_clustering(nodes_df)
    except Exception as e:
        logging.error(f"Error during clustering: {str(e)}")
        return {"error": "Error during clustering"}

    logging.debug("Risk and Importance Clustering:")
    logging.debug(nodes_df[['ID', 'Cluster']])

    try:
        nodes_df = perform_pca(nodes_df)
    except Exception as e:
        logging.error(f"Error during PCA analysis: {str(e)}")
        return {"error": "Error during PCA analysis"}

    logging.debug("PCA Analysis:")
    logging.debug(nodes_df[['ID', 'pca1', 'pca2']])

    try:
        nodes_df = dependency_clustering(nodes_df, G)
    except Exception as e:
        logging.error(f"Error during dependency-based clustering: {str(e)}")
        return {"error": "Error during dependency-based clustering"}

    logging.debug("Dependency-Based Clustering:")
    logging.debug(nodes_df['DependencyCluster'])

    try:
        communities = nx.algorithms.community.greedy_modularity_communities(G)
        node_community_dict = {node: community_group for community_group, nodes in enumerate(communities) for node in nodes}
        nodes_df['CommunityGroup'] = nodes_df['ID'].apply(lambda x: node_community_dict.get(x))
    except Exception as e:
        logging.error(f"Error during community detection: {str(e)}")
        return {"error": "Error during community detection"}

    logging.debug("Community Detection:")
    logging.debug(nodes_df['CommunityGroup'])

    try:
        clust = nx.clustering(G)
        close_cent = nx.closeness_centrality(G)
        dcent1 = nx.algorithms.degree_centrality(G)
        pr = nx.pagerank(G, alpha=0.9)

        for index, row in nodes_df.iterrows():
            key = row['ID']
            nodes_df.at[index, 'Clustering_Coefficient'] = clust.get(key, None)
            nodes_df.at[index, 'closeness_centrality'] = close_cent.get(key, None)
            nodes_df.at[index, 'degree_centrality'] = dcent1.get(key, None)
            nodes_df.at[index, 'PageRank'] = pr.get(key, None)
    except Exception as e:
        logging.error(f"Error during metric calculation: {str(e)}")
        return {"error": "Error during metric calculation"}

    logging.debug("Calculated Metrics:")
    logging.debug(nodes_df)

    nodes_df = nodes_df.replace({np.nan: None})
    links_df = links_df.replace({np.nan: None})

    try:
        work_packages = define_work_packages(nodes_df, G)
    except Exception as e:
        logging.error(f"Error during work package definition: {str(e)}")
        return {"error": "Error during work package definition"}

    # Commented out reduced graph creation for now
    # try:
    #     critical_nodes = identify_critical_activities_and_milestones(G)
    #     reduced_dag = create_reduced_dag(G, critical_nodes)
    #     reduced_nodes = list(reduced_dag.nodes)
    #     reduced_links = [{'source': u, 'target': v, 'weight': d['weight']} for u, v, d in reduced_dag.edges(data=True)]
    # except Exception as e:
    #     logging.error(f"Error during reduced DAG creation: {str(e)}")
    #     return {"error": "Error during reduced DAG creation"}
    
    #     Need to uncomment after fixing

    work_packages_serialized = serialize_work_packages(work_packages)

    response_data = {
        'nodes': nodes_df.to_dict(orient='records'),
        'links': links_df.to_dict(orient='records'),
        'work_packages': work_packages_serialized,
        # 'reduced_graph': {
        #     'nodes': reduced_nodes,
        #     'links': reduced_links
        # }
    }
    
    logging.debug("Response Data:")
    logging.debug(response_data)

    return response_data

def serialize_work_packages(work_packages):
    serialized_packages = {}
    for key, package in work_packages.items():
        serialized_packages[key] = {
            'tasks': package['tasks'],
            'critical_path': package['critical_path'],
            'critical_path_length': package['critical_path_length'],
            'start': package['start'].isoformat() if package['start'] else None,
            'end': package['end'].isoformat() if package['end'] else None
        }
    return serialized_packages

def preprocess_graph(nodes, links):
    G = nx.DiGraph()
    for link in links:
        G.add_edge(str(link['source']), str(link['target']), weight=link.get('duration', 1))
        # Add type and lag as edge attributes
        G[str(link['source'])][str(link['target'])]['type'] = link.get('type', 'FS')
        G[str(link['source'])][str(link['target'])]['lag'] = link.get('lag', 0)
    
    for node in nodes:
        G.nodes[str(node['ID'])]['start_date'] = pd.to_datetime(node['Start'], errors='coerce', exact=False)
        G.nodes[str(node['ID'])]['duration'] = node['Duration']
        G.nodes[str(node['ID'])]['Milestone'] = int(node.get('Milestone', 0)) == 1
        G.nodes[str(node['ID'])]['isImportanceOutlier'] = str(node.get('isImportanceOutlier', 'false')).lower() == 'true'
        G.nodes[str(node['ID'])]['isOnCriticalPath'] = str(node.get('isOnCriticalPath', 'false')).lower() == 'true'
        G.nodes[str(node['ID'])]['isOnOutlierPath'] = str(node.get('isOnOutlierPath', 'false')).lower() == 'true'
        G.nodes[str(node['ID'])]['isRiskOutlier'] = str(node.get('isRiskOutlier', 'false')).lower() == 'true'
    
    return G

@app.route('/graph-metrics', methods=['POST'])
def graph_metrics():
    logging.info("Received request at /graph-metrics")
    request_data = request.get_json()
    logging.debug("Request Data:")
    logging.debug(request_data)

    if request_data is None:
        logging.error("No data received in the request.")
        return jsonify({'error': 'No data received'}), 400

    nodes = request_data.get('nodes', [])
    links = request_data.get('links', [])

    logging.debug("Nodes:")
    logging.debug(nodes)
    logging.debug("Links:")
    logging.debug(links)

    logging.debug("Number of nodes: %d", len(nodes))
    logging.debug("Number of links: %d", len(links))

    try:
        response_data = process_graph(nodes, links)
        logging.info("Sending response....")
        return jsonify(response_data)
    except Exception as e:
        logging.error(f"An error occurred while processing the graph: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({"status": "healthy"}), 200

@app.errorhandler(Exception)
def handle_exception(e):
    logging.error(f"An error occurred: {str(e)}")
    return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
