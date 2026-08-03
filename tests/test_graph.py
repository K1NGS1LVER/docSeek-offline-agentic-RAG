import json
import pytest
from unittest.mock import patch, MagicMock
from app.core.graph import compute_cosine_similarity, build_graph_data


def test_compute_cosine_similarity():
    v1 = [1.0, 0.0, 0.0]
    v2 = [1.0, 0.0, 0.0]
    v3 = [0.0, 1.0, 0.0]
    v4 = [-1.0, 0.0, 0.0]
    v_zero = [0.0, 0.0, 0.0]

    assert pytest.approx(compute_cosine_similarity(v1, v2), 0.001) == 1.0
    assert pytest.approx(compute_cosine_similarity(v1, v3), 0.001) == 0.0
    assert pytest.approx(compute_cosine_similarity(v1, v4), 0.001) == -1.0
    assert compute_cosine_similarity(v1, v_zero) == 0.0
    assert compute_cosine_similarity([], v1) == 0.0
    assert compute_cosine_similarity([1.0, 2.0], [1.0, 2.0, 3.0]) == 0.0


@patch("app.core.graph.list_sources")
@patch("app.core.graph.fetch_chunks_by_source")
def test_build_graph_data_empty(mock_fetch_chunks, mock_list_sources):
    mock_list_sources.return_value = []
    data = build_graph_data("dummy.db", min_similarity=0.3)
    assert data["nodes"] == []
    assert data["edges"] == []
    assert data["stats"]["total_documents"] == 0
    assert data["stats"]["total_edges"] == 0


@patch("app.core.graph.list_sources")
@patch("app.core.graph.fetch_chunks_by_source")
def test_build_graph_data_nodes_and_edges(mock_fetch_chunks, mock_list_sources):
    mock_list_sources.return_value = [
        {
            "source_file": "docs/a.txt",
            "chunks": 2,
            "first_chunk_id": 1,
            "metadata": json.dumps({"tags": ["python", "ai"]}),
        },
        {
            "source_file": "docs/b.txt",
            "chunks": 1,
            "first_chunk_id": 3,
            "metadata": json.dumps({"tags": ["python", "web"]}),
        },
        {
            "source_file": "docs/c.txt",
            "chunks": 1,
            "first_chunk_id": 4,
            "metadata": json.dumps({"tags": "web"}),
        },
    ]

    def side_effect(db_path, source_file):
        if source_file == "docs/a.txt":
            return [{"id": 1, "content": "a1"}, {"id": 2, "content": "a2"}]
        elif source_file == "docs/b.txt":
            return [{"id": 3, "content": "b1"}]
        elif source_file == "docs/c.txt":
            return [{"id": 4, "content": "c1"}]
        return []

    mock_fetch_chunks.side_effect = side_effect

    # Chunk embeddings:
    # a.txt chunks (1, 2) average vector -> [1.0, 0.0]
    # b.txt chunk (3) vector -> [0.9, 0.1] (similar to a.txt)
    # c.txt chunk (4) vector -> [0.0, 1.0] (orthogonal to a.txt)
    chunk_embeddings_map = {
        1: [1.0, 0.0],
        2: [1.0, 0.0],
        3: [0.9, 0.1],
        4: [0.0, 1.0],
    }

    data = build_graph_data("dummy.db", min_similarity=0.5, chunk_embeddings_map=chunk_embeddings_map)

    assert len(data["nodes"]) == 3
    node_ids = [n["id"] for n in data["nodes"]]
    assert "docs/a.txt" in node_ids
    assert "docs/b.txt" in node_ids
    assert "docs/c.txt" in node_ids

    # Edge check:
    # a.txt <-> b.txt similarity is high (~0.99) -> similarity edge
    # b.txt <-> c.txt similarity is low (0.1 / norm), but both share tag "web" -> tag edge
    edges = data["edges"]
    assert len(edges) >= 2

    sim_edges = [e for e in edges if e["type"] == "similarity"]
    tag_edges = [e for e in edges if e["type"] == "tag"]

    assert any(
        (e["source"] == "docs/a.txt" and e["target"] == "docs/b.txt") or
        (e["source"] == "docs/b.txt" and e["target"] == "docs/a.txt")
        for e in sim_edges
    )
    assert any(
        (e["source"] == "docs/b.txt" and e["target"] == "docs/c.txt") or
        (e["source"] == "docs/c.txt" and e["target"] == "docs/b.txt")
        for e in tag_edges
    )
    assert data["stats"]["total_documents"] == 3
    assert data["stats"]["total_edges"] == len(edges)
