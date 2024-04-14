import os
import logging
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
import pandas as pd
from sklearn.cluster import AgglomerativeClustering
import networkx as nx

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
app = Flask(__name__)
CORS(app)  # Enable CORS for all routes and origins

def process_graph(nodes, links):
    print("Processing graph...")
    print("Nodes:", nodes)
    print("Links:", links)

    # Convert nodes and links to DataFrames
    nodes_df = pd.DataFrame(nodes)
    links_df = pd.DataFrame(links)

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

    cluster_dep = AgglomerativeClustering(n_clusters=2, metric='precomputed', linkage='complete')
    nodes_df['DependencyCluster'] = cluster_dep.fit_predict(distance_matrix)

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
    #nodes_df = nodes_df.where(pd.notnull(nodes_df), None)
    nodes_df = nodes_df.replace({np.nan: None})  # Replace NaN with None
    links_df = links_df.replace({np.nan: None})  # Replace NaN with None

    # Prepare the response data
    response_data = {
        'nodes': nodes_df.to_dict(orient='records'),
        'links': links_df.to_dict(orient='records')
    }

    print("Response Data:")
    print(response_data)

    return response_data

def preprocess_graph(nodes, links):
    G = nx.DiGraph()
    G.add_nodes_from([str(node['ID']) for node in nodes])  # Convert node IDs to strings
    G.add_edges_from([(str(link['source']), str(link['target'])) for link in links])  # Convert edge IDs to strings

    if not nx.is_directed_acyclic_graph(G):
        cycles = list(nx.simple_cycles(G))
        for cycle in cycles:
            G.remove_edge(cycle[-1], cycle[0])

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
