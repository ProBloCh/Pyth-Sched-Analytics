import os
import logging
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import pandas as pd
from sklearn.cluster import AgglomerativeClustering
import networkx as nx
from sklearn.metrics import silhouette_score

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
app = Flask(__name__)
CORS(app)  # Enable CORS for all routes and origins

def detect_repeating_patterns(nodes_df):
    if 'TaskType' not in nodes_df.columns:
        print("No 'TaskType' column found in nodes data. Skipping pattern detection.")
        return []

    # Advanced pattern detection: considering multiple attributes
    nodes_df['pattern_id'] = pd.factorize(nodes_df['TaskType'] + '_' +
                                          nodes_df['Duration'].astype(str) + '_' +
                                          nodes_df['Resources'].astype(str))[0]
    pattern_records = [group_df for _, group_df in nodes_df.groupby('pattern_id') if len(group_df) > 1]
    return pattern_records


def create_templates_from_patterns(pattern_records):
    templates = {}
    for index, pattern_df in enumerate(pattern_records):
        # Creating a template with detailed statistics
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
    # Calculate the critical path in the graph
    critical_path = nx.dag_longest_path(G, weight='duration')
    critical_path_length = nx.dag_longest_path_length(G, weight='duration')
    return critical_path, critical_path_length

def define_work_packages(nodes_df, G):
    work_packages = {}
    
    if 'Cluster' in nodes_df.columns:
        for cluster in nodes_df['Cluster'].unique():
            cluster_nodes = nodes_df[nodes_df['Cluster'] == cluster]
            tasks = cluster_nodes['ID'].tolist()

            # Ensure the subgraph is correctly referenced
            subgraph = G.subgraph(tasks)
            sub_critical_path = nx.dag_longest_path(subgraph, weight='duration')
            sub_critical_duration = nx.dag_longest_path_length(subgraph, weight='duration')

            # Use 'start_date' and 'end_date' correctly
            # Calculate the min 'start_date' and max 'end_date' from the subgraph nodes
            if not subgraph.nodes:  # Check if the subgraph has nodes to avoid errors
                continue
            start_dates = [G.nodes[node]['start_date'] for node in subgraph if 'start_date' in G.nodes[node]]
            end_dates = [G.nodes[node]['end_date'] for node in subgraph if 'end_date' in G.nodes[node]]

            # Validate start_dates and end_dates are not empty
            if not start_dates or not end_dates:
                print(f"No valid dates for cluster {cluster}. Skipping.")
                continue

            work_packages[f'Package_{cluster}'] = {
                'tasks': tasks,
                'critical_path': sub_critical_path,
                'critical_path_length': sub_critical_duration,
                'start': min(start_dates),
                'end': max(end_dates)
            }
    else:
        print("Cluster data not found in DataFrame.")

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

    # Determine the optimal number of clusters using silhouette scores
    max_clusters = 10  # or another suitable upper limit
    best_score = -1
    best_n_clusters = 3
    for n_clusters in range(3, max_clusters):
        clustering = AgglomerativeClustering(n_clusters=n_clusters, linkage='complete', metric='precomputed')
        labels = clustering.fit_predict(distance_matrix)
        # Only calculate silhouette score if there are at least two clusters
        if len(set(labels)) > 1:
            score = silhouette_score(distance_matrix, labels, metric='precomputed')
            print(f"Silhouette Score for {n_clusters} clusters: {score}")
            if score > best_score:
                best_score = score
                best_n_clusters = n_clusters

    # Clustering with the optimal number of clusters found
    best_clustering = AgglomerativeClustering(n_clusters=best_n_clusters, linkage='complete', metric='precomputed')
    nodes_df['DependencyCluster'] = best_clustering.fit_predict(distance_matrix)
    #print(f"Using {best_n_clusters} clusters based on the best silhouette score.")

    return nodes_df

def process_graph(nodes, links):
    print("Processing graph...")
    print("Nodes:", nodes)
    print("Links:", links)

    # Convert nodes and links to DataFrames
    nodes_df = pd.DataFrame(nodes)
    links_df = pd.DataFrame(links)

    # Validate required columns
    required_node_columns = ['ID', 'Duration', 'Start', 'Finish']
    for column in required_node_columns:
        if column not in nodes_df.columns:
            raise ValueError(f"Missing required column in nodes data: {column}")

    required_link_columns = ['source', 'target', 'duration']
    for column in required_link_columns:
        if column not in links_df.columns:
            raise ValueError(f"Missing required column in links data: {column}")

    print("Nodes DataFrame:")
    print(nodes_df)
    print("Links DataFrame:")
    print(links_df)

    # Preprocess the graph
    G = preprocess_graph(nodes, links)

    print("Preprocessed Graph:")
    print(G.nodes())
    print(G.edges())

    # Activity-Based Clustering
    if 'Duration' in nodes_df.columns:
        X = nodes_df[['Duration']].values
        cluster = AgglomerativeClustering(n_clusters=2, metric='euclidean', linkage='ward')
        nodes_df['Cluster'] = cluster.fit_predict(X)

    print("Activity-Based Clustering:")
    print(nodes_df['Cluster'])

    # Dependency-Based Clustering
    path_length = dict(nx.all_pairs_dijkstra_path_length(G))
    size = len(nodes_df)
    distance_matrix = np.zeros((size, size), dtype=float)

    for i, source_node in enumerate(nodes_df['ID']):
        for j, target_node in enumerate(nodes_df['ID']):
            distance = path_length.get(source_node, {}).get(target_node, np.inf)
            distance_matrix[i, j] = distance if distance != np.inf else 1e9

    nodes_df = dependency_clustering(nodes_df, G)

    print("Dependency-Based Clustering:")
    print(nodes_df['DependencyCluster'])

    # Community Detection
    communities = nx.algorithms.community.greedy_modularity_communities(G)
    node_community_dict = {}
    for community_group, nodes in enumerate(communities):
        for node in nodes:
            node_community_dict[node] = community_group
    nodes_df['CommunityGroup'] = nodes_df['ID'].apply(lambda x: node_community_dict.get(x))

    print("Community Detection:")
    print(nodes_df['CommunityGroup'])

    # Calculate metrics
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

    print("Calculated Metrics:")
    print(nodes_df)

    # Replace NaN values with null
    nodes_df = nodes_df.replace({np.nan: None})  # Replace NaN with None
    links_df = links_df.replace({np.nan: None})  # Replace NaN with None

    # Define work packages based on the clusters and the graph
    work_packages = define_work_packages(nodes_df, G)

    # Serialize work packages to be JSON compatible
    work_packages_serialized = serialize_work_packages(work_packages)

    # Prepare the response data
    response_data = {
        'nodes': nodes_df.to_dict(orient='records'),
        'links': links_df.to_dict(orient='records'),
        'work_packages': work_packages_serialized
    }
    
    print("Response Data:")
    print(response_data)

    return response_data



def serialize_work_packages(work_packages):
    # Ensure work packages are JSON serializable (e.g., datetime conversion)
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
        # Ensure the necessary attributes are present and valid
        source = str(link.get('source'))
        target = str(link.get('target'))
        duration = link.get('duration', 0)
        link_type = link.get('type', 'FS')
        lag = link.get('lag', 0)

        if source and target:
            G.add_edge(source, target, weight=duration)
            # Add type and lag as edge attributes
            G[source][target]['type'] = link_type
            G[source][target]['lag'] = lag
        else:
            print(f"Invalid link data: {link}")

    for node in nodes:
        node_id = str(node.get('ID'))
        if node_id:
            G.nodes[node_id]['start_date'] = pd.to_datetime(node.get('Start'), errors='coerce', exact=False)
            G.nodes[node_id]['duration'] = node.get('Duration', 0)
        else:
            print(f"Invalid node data: {node}")

    # Remove cycles if necessary
    try:
        if not nx.is_directed_acyclic_graph(G):
            cycles = list(nx.simple_cycles(G))
            for cycle in cycles:
                G.remove_edge(cycle[-1], cycle[0])
    except Exception as e:
        print("Error checking cycles in graph:", e)

    return G


@app.route('/graph-metrics', methods=['POST'])
def graph_metrics():
    print("Received request at /graph-metrics")
    request_data = request.get_json()
    print("Request Data:")
    print(request_data)

    if request_data is None:
        print("No data received in the request.")
        return jsonify({'error': 'No data received'}), 400

    nodes = request_data.get('nodes', [])
    links = request_data.get('links', [])

    print("Nodes:")
    print(nodes)
    print("Links:")
    print(links)

    # Add more logging statements to check the data
    print("Number of nodes:", len(nodes))
    print("Number of links:", len(links))

    response_data = process_graph(nodes, links)

    print("Sending response...")
    return jsonify(response_data)

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
