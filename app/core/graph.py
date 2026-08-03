import json
import math
import os
import re
from typing import List, Dict, Any, Optional
from app.core.database import list_sources, fetch_chunks_for_graph_node


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


def parse_explicit_references(content: str, doc_targets: List[Dict[str, Any]]) -> List[str]:
    """Scans document text for explicit wikilinks, markdown links, or filename mentions to target documents."""
    if not content:
        return []
    matched_ids = []
    content_lower = content.lower()
    for target in doc_targets:
        target_id = target["id"]
        filename = os.path.basename(target_id).lower()
        stem, _ = os.path.splitext(filename)

        # Wiki-links: [[setup]] or [[setup.md]]
        if stem:
            wikilink_pattern = rf"\[\[([^\]]*?{re.escape(stem)}[^\]]*?)\]\]"
            if re.search(wikilink_pattern, content_lower):
                matched_ids.append(target_id)
                continue

            # Markdown links: [setup](docs/setup.md)
            markdown_pattern = rf"\]\([^\)]*?{re.escape(stem)}[^\)]*?\)"
            if re.search(markdown_pattern, content_lower):
                matched_ids.append(target_id)
                continue

        # Literal filename mentions with extension: setup.md
        if filename:
            filename_pattern = rf"\b{re.escape(filename)}\b"
            if re.search(filename_pattern, content_lower):
                matched_ids.append(target_id)
                continue

    return matched_ids


def build_graph_data(
    db_path: str,
    min_similarity: float = 0.3,
    chunk_embeddings_map: Optional[Dict[int, List[float]]] = None,
) -> Dict[str, Any]:
    """
    Build graph nodes and edges from database sources and embeddings.
    Creates tag hub nodes, scans for explicit reference links, and connects nearest neighbor similarity edges.
    """
    sources = list_sources(db_path)
    doc_nodes = []
    doc_vectors: Dict[str, List[float]] = {}
    doc_contents: Dict[str, str] = {}
    all_tags = set()

    for src in sources:
        source_file = src["source_file"]
        first_chunk_id = src.get("first_chunk_id")
        chunks = fetch_chunks_for_graph_node(db_path, source_file, first_chunk_id)
        chunk_count = len(chunks)

        # Concatenate chunk content for reference scanning
        content = "\n".join(c["content"] for c in chunks if isinstance(c, dict) and "content" in c and c["content"])
        doc_contents[source_file] = content

        # Parse tags from metadata
        tags = []
        meta_str = src.get("metadata")
        if meta_str:
            try:
                meta = json.loads(meta_str)
                raw_tags = meta.get("tags", [])
                if isinstance(raw_tags, str):
                    tags = [raw_tags]
                elif isinstance(raw_tags, list):
                    tags = [str(t) for t in raw_tags if t]
            except Exception:
                tags = []

        doc_nodes.append(
            {
                "id": source_file,
                "label": source_file.split("/")[-1],
                "source_file": source_file,
                "chunk_count": chunk_count,
                "tags": tags,
                "first_chunk_id": first_chunk_id,
                "is_tag": False,
            }
        )

        for tag in tags:
            tag_clean = tag.strip()
            if tag_clean:
                all_tags.add(tag_clean)

        # Compute document centroid vector if chunk embeddings are provided
        if chunk_embeddings_map and chunks:
            chunk_vecs = [
                chunk_embeddings_map[c["id"]]
                for c in chunks
                if isinstance(c, dict) and "id" in c and c["id"] in chunk_embeddings_map
            ]
            if chunk_vecs:
                vec_dim = len(chunk_vecs[0])
                centroid = [
                    sum(cv[i] for cv in chunk_vecs) / len(chunk_vecs)
                    for i in range(vec_dim)
                ]
                doc_vectors[source_file] = centroid

    # Create tag nodes
    tag_nodes = []
    sorted_tags = sorted(list(all_tags))
    for tag_name in sorted_tags:
        tag_nodes.append(
            {
                "id": f"tag:{tag_name}",
                "label": f"#{tag_name}",
                "is_tag": True,
                "tag_name": tag_name,
            }
        )

    all_nodes = doc_nodes + tag_nodes
    edges = []
    seen_edges = set()

    # 1. Tag Edges (connecting document nodes to tag hub nodes)
    for doc in doc_nodes:
        doc_id = doc["id"]
        for tag in doc["tags"]:
            tag_clean = tag.strip()
            if tag_clean:
                tag_node_id = f"tag:{tag_clean}"
                pair = (min(doc_id, tag_node_id), max(doc_id, tag_node_id))
                if pair not in seen_edges:
                    seen_edges.add(pair)
                    edges.append(
                        {
                            "source": doc_id,
                            "target": tag_node_id,
                            "weight": 1.0,
                            "type": "tag",
                        }
                    )

    # 2. Explicit Link Edges (reference)
    for doc in doc_nodes:
        doc_id = doc["id"]
        content = doc_contents.get(doc_id, "")
        target_docs = [d for d in doc_nodes if d["id"] != doc_id]
        matched_target_ids = parse_explicit_references(content, target_docs)
        for target_id in matched_target_ids:
            if doc_id != target_id:
                pair = (min(doc_id, target_id), max(doc_id, target_id))
                if pair not in seen_edges:
                    seen_edges.add(pair)
                    edges.append(
                        {
                            "source": doc_id,
                            "target": target_id,
                            "weight": 1.0,
                            "type": "reference",
                        }
                    )

    # 3. Top-2 Nearest Neighbors Embedding Similarity Edges
    for doc_i in doc_nodes:
        src_i = doc_i["id"]
        if src_i not in doc_vectors:
            continue

        similarities = []
        for doc_j in doc_nodes:
            src_j = doc_j["id"]
            if src_i == src_j or src_j not in doc_vectors:
                continue

            sim = compute_cosine_similarity(doc_vectors[src_i], doc_vectors[src_j])
            if sim >= min_similarity:
                similarities.append((src_j, sim))

        similarities.sort(key=lambda x: x[1], reverse=True)
        top_2 = similarities[:2]

        for src_j, sim in top_2:
            pair = (min(src_i, src_j), max(src_i, src_j))
            if pair not in seen_edges:
                seen_edges.add(pair)
                edges.append(
                    {
                        "source": src_i,
                        "target": src_j,
                        "weight": round(sim, 4),
                        "type": "similarity",
                    }
                )

    return {
        "nodes": all_nodes,
        "edges": edges,
        "stats": {
            "total_documents": len(doc_nodes),
            "total_edges": len(edges),
        },
    }
