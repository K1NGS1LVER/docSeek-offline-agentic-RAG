import json
import pytest
import numpy as np
from unittest.mock import patch, MagicMock
from app.core.graph import compute_cosine_similarity, build_graph_data, parse_explicit_references
from app.core.engine import VectorEngine
from app.core import database


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


def test_parse_explicit_references():
    doc_targets = [
        {"id": "docs/setup.md"},
        {"id": "notes/architecture.pdf"},
    ]
    # 1. Wiki-link test
    content_wiki = "For setup, check [[setup]] or [[setup.md]] in the docs."
    refs_wiki = parse_explicit_references(content_wiki, doc_targets)
    assert refs_wiki == ["docs/setup.md"]

    # 2. Markdown link test
    content_md = "See the [Architecture Diagram](notes/architecture.pdf) for details."
    refs_md = parse_explicit_references(content_md, doc_targets)
    assert refs_md == ["notes/architecture.pdf"]

    # 3. Literal filename mention test
    content_filename = "Please view setup.md for installation instructions."
    refs_filename = parse_explicit_references(content_filename, doc_targets)
    assert refs_filename == ["docs/setup.md"]

    # 4. No matches
    content_none = "This text has no references or links."
    refs_none = parse_explicit_references(content_none, doc_targets)
    assert refs_none == []


@patch("app.core.graph.list_sources")
@patch("app.core.graph.fetch_chunks_for_graph_node")
def test_build_graph_data_empty(mock_fetch_chunks, mock_list_sources):
    mock_list_sources.return_value = []
    data = build_graph_data("dummy.db", min_similarity=0.3)
    assert data["nodes"] == []
    assert data["edges"] == []
    assert data["stats"]["total_documents"] == 0
    assert data["stats"]["total_edges"] == 0


@patch("app.core.graph.list_sources")
@patch("app.core.graph.fetch_chunks_for_graph_node")
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

    def side_effect(db_path, source_file, first_chunk_id=None):
        if source_file == "docs/a.txt":
            return [{"id": 1, "content": "a1"}, {"id": 2, "content": "a2"}]
        elif source_file == "docs/b.txt":
            return [{"id": 3, "content": "b1 [[c.txt]]"}]
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

    # 3 document nodes + 3 tag nodes (ai, python, web) = 6 nodes
    assert len(data["nodes"]) == 6
    doc_nodes = [n for n in data["nodes"] if not n.get("is_tag")]
    tag_nodes = [n for n in data["nodes"] if n.get("is_tag")]

    assert len(doc_nodes) == 3
    assert len(tag_nodes) == 3

    doc_ids = [n["id"] for n in doc_nodes]
    assert "docs/a.txt" in doc_ids
    assert "docs/b.txt" in doc_ids
    assert "docs/c.txt" in doc_ids

    tag_ids = [n["id"] for n in tag_nodes]
    assert "tag:ai" in tag_ids
    assert "tag:python" in tag_ids
    assert "tag:web" in tag_ids

    # Edges:
    edges = data["edges"]
    sim_edges = [e for e in edges if e["type"] == "similarity"]
    tag_edges = [e for e in edges if e["type"] == "tag"]
    ref_edges = [e for e in edges if e["type"] == "reference"]

    # Tag edges: a.txt connected to python & ai; b.txt connected to python & web; c.txt connected to web
    assert len(tag_edges) == 5
    assert any(e["source"] == "docs/a.txt" and e["target"] == "tag:python" for e in tag_edges)
    assert any(e["source"] == "docs/a.txt" and e["target"] == "tag:ai" for e in tag_edges)
    assert any(e["source"] == "docs/b.txt" and e["target"] == "tag:python" for e in tag_edges)

    # Reference edge: b.txt content contains [[c.txt]] -> b.txt connected to c.txt
    assert len(ref_edges) == 1
    assert ref_edges[0]["source"] == "docs/b.txt"
    assert ref_edges[0]["target"] == "docs/c.txt"

    # Similarity edge: a.txt <-> b.txt
    assert len(sim_edges) == 1
    assert (
        (sim_edges[0]["source"] == "docs/a.txt" and sim_edges[0]["target"] == "docs/b.txt") or
        (sim_edges[0]["source"] == "docs/b.txt" and sim_edges[0]["target"] == "docs/a.txt")
    )

    assert data["stats"]["total_documents"] == 3
    assert data["stats"]["total_edges"] == len(edges)


def test_get_embeddings_map(tmp_path):
    index_file = str(tmp_path / "test.index")
    with patch("app.core.engine.get_shared_model"):
        engine = VectorEngine(index_file)
        assert engine.get_embeddings_map() == {}

        vecs = np.random.randn(2, engine.dimension).astype("float32")
        engine.add_to_index(vecs, doc_ids=[10, 20])
        emb_map = engine.get_embeddings_map()
        assert len(emb_map) == 2
        assert 10 in emb_map
        assert 20 in emb_map
        assert len(emb_map[10]) == engine.dimension


def test_list_sources_metadata_fallback(tmp_path):
    db_file = str(tmp_path / "test.db")
    database.init_db(db_file)

    database.insert_document(db_file, "content 1", metadata=json.dumps({"source_file": "file1.txt"}))
    database.insert_document(db_file, "content 2", metadata=json.dumps({"filename": "file2.pdf"}))
    database.insert_document(db_file, "content 3", metadata=json.dumps({"title": "Notebook Note"}))
    database.insert_document(db_file, "content 4", metadata=None)

    sources = database.list_sources(db_file)
    src_names = [s["source_file"] for s in sources]

    assert "file1.txt" in src_names
    assert "file2.pdf" in src_names
    assert "Notebook Note" in src_names
    assert "Document #4" in src_names
    assert len(sources) == 4


def test_fetch_chunks_for_graph_node(tmp_path):
    db_file = str(tmp_path / "test_fallback.db")
    database.init_db(db_file)

    # Insert document with real source_file
    id1 = database.insert_document(db_file, "real file content", metadata=json.dumps({"source_file": "real.txt"}))
    # Insert document without source_file (synthesized source path case)
    id2 = database.insert_document(db_file, "synthesized content", metadata=None)

    # 1. Matches real source_file
    chunks1 = database.fetch_chunks_for_graph_node(db_file, "real.txt", first_chunk_id=id1)
    assert len(chunks1) == 1
    assert chunks1[0]["id"] == id1

    # 2. Synthesized source path fails source_file match, falls back to first_chunk_id
    chunks2 = database.fetch_chunks_for_graph_node(db_file, "Document #2", first_chunk_id=id2)
    assert len(chunks2) == 1
    assert chunks2[0]["id"] == id2
    assert chunks2[0]["content"] == "synthesized content"

    # 3. Non-existent source path without first_chunk_id returns []
    chunks3 = database.fetch_chunks_for_graph_node(db_file, "missing.txt", first_chunk_id=None)
    assert chunks3 == []
