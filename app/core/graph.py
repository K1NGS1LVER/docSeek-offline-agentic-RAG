import json
import math
from typing import List, Dict, Any, Optional
from app.core.database import list_sources, fetch_chunks_by_source


def compute_cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
    """Compute cosine similarity between two 1D float vectors."""
    if not vec1 or not vec2 or len(vec1) != len(vec2):
        return 0.0
    dot_product = sum(a * b for a, b in zip(vec1, vec2))
    norm_a = math.sqrt(sum(a * a for a in vec1))
    norm_b = math.sqrt(sum(b * b for b in vec2))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot_product / (norm_a * norm_b)


def build_graph_data(
    db_path: str,
    min_similarity: float = 0.3,
    chunk_embeddings_map: Optional[Dict[int, List[float]]] = None,
) -> Dict[str, Any]:
    """
    Build graph nodes and edges from database sources and embeddings.
    If chunk_embeddings_map is provided (e.g. from vector store), computes exact centroid vectors.
    """
    sources = list_sources(db_path)
    nodes = []
    doc_vectors: Dict[str, List[float]] = {}

    for src in sources:
        source_file = src["source_file"]
        chunks = fetch_chunks_by_source(db_path, source_file)
        chunk_count = len(chunks)
        first_chunk_id = src.get("first_chunk_id")

        # Parse tags from metadata
        tags = []
        meta_str = src.get("metadata")
        if meta_str:
            try:
                meta = json.loads(meta_str)
                tags = meta.get("tags", [])
                if isinstance(tags, str):
                    tags = [tags]
            except Exception:
                tags = []

        nodes.append(
            {
                "id": source_file,
                "label": source_file.split("/")[-1],
                "source_file": source_file,
                "chunk_count": chunk_count,
                "tags": tags,
                "first_chunk_id": first_chunk_id,
            }
        )

        # Compute document centroid vector if chunk embeddings are provided
        if chunk_embeddings_map and chunks:
            chunk_vecs = [
                chunk_embeddings_map[c["id"]]
                for c in chunks
                if c["id"] in chunk_embeddings_map
            ]
            if chunk_vecs:
                vec_dim = len(chunk_vecs[0])
                centroid = [
                    sum(cv[i] for cv in chunk_vecs) / len(chunk_vecs)
                    for i in range(vec_dim)
                ]
                doc_vectors[source_file] = centroid

    # Compute similarity and tag edges
    edges = []
    n = len(nodes)
    for i in range(n):
        for j in range(i + 1, n):
            src_i = nodes[i]["id"]
            src_j = nodes[j]["id"]

            edge_added = False
            # Embedding similarity edge
            if src_i in doc_vectors and src_j in doc_vectors:
                sim = compute_cosine_similarity(doc_vectors[src_i], doc_vectors[src_j])
                if sim >= min_similarity:
                    edges.append(
                        {
                            "source": src_i,
                            "target": src_j,
                            "weight": round(sim, 4),
                            "type": "similarity",
                        }
                    )
                    edge_added = True

            # Shared tag edge
            tags_i = set(nodes[i]["tags"])
            tags_j = set(nodes[j]["tags"])
            shared_tags = tags_i & tags_j
            if shared_tags and not edge_added:
                edges.append(
                    {
                        "source": src_i,
                        "target": src_j,
                        "weight": 1.0,
                        "type": "tag",
                    }
                )

    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "total_documents": len(nodes),
            "total_edges": len(edges),
        },
    }
