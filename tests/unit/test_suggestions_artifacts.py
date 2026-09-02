import json
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from app.core.config import LLM_MODEL, LLM_LIGHT_MODEL
from app.core.llm import OllamaLLM
from app.core import database
from app.server import app, ArtifactRequest, ARTIFACT_PROMPTS


def test_config_light_model():
    assert LLM_LIGHT_MODEL is not None
    assert isinstance(LLM_LIGHT_MODEL, str)


def test_artifact_request_model():
    req = ArtifactRequest(notebook_id="nb-123", artifact_type="briefing")
    assert req.notebook_id == "nb-123"
    assert req.artifact_type == "briefing"
    assert req.focus is None

    req_with_focus = ArtifactRequest(
        notebook_id="nb-123", artifact_type="study_guide", focus="Chapter 1"
    )
    assert req_with_focus.focus == "Chapter 1"


@pytest.mark.asyncio
async def test_llm_complete_json_passes_model_param():
    llm = OllamaLLM()
    mock_resp = MagicMock()
    mock_resp.choices = [MagicMock()]
    mock_resp.choices[0].message.content = json.dumps({"followups": ["q1", "q2", "q3"]})

    llm.client = MagicMock()
    llm.client.chat = MagicMock()
    llm.client.chat.completions = MagicMock()
    llm.client.chat.completions.create = AsyncMock(return_value=mock_resp)

    # Test with custom model
    res = await llm.complete_json(
        system="sys",
        prompt="prompt",
        max_tokens=120,
        model="custom-small-model",
    )
    assert res == {"followups": ["q1", "q2", "q3"]}
    llm.client.chat.completions.create.assert_awaited_once()
    _, kwargs = llm.client.chat.completions.create.call_args
    assert kwargs["model"] == "custom-small-model"
    assert kwargs["max_tokens"] == 120

    # Test with default model
    llm.client.chat.completions.create.reset_mock()
    await llm.complete_json(
        system="sys",
        prompt="prompt",
    )
    _, kwargs = llm.client.chat.completions.create.call_args
    assert kwargs["model"] == LLM_MODEL


def test_database_get_document_and_source_file(tmp_path):
    db_file = str(tmp_path / "test.db")
    database.init_db(db_file)

    meta1 = json.dumps({"source_file": "fileA.txt", "filename": "fileA.txt"})
    meta2 = json.dumps({"source_file": "fileB.txt", "filename": "fileB.txt"})

    id1 = database.insert_document(db_file, "Content 1", meta1)
    id2 = database.insert_document(db_file, "Content 2", meta2)

    # Test get_document alias
    doc1 = database.get_document(db_file, id1)
    assert doc1 is not None
    assert doc1["id"] == id1
    assert doc1["content"] == "Content 1"

    # Test get_all_documents returns source_file
    all_docs = database.get_all_documents(db_file)
    assert len(all_docs) == 2
    sources = {d["source_file"] for d in all_docs}
    assert "fileA.txt" in sources
    assert "fileB.txt" in sources


def test_suggestions_empty_notebook(tmp_path):
    client = TestClient(app)
    mock_rt = MagicMock()
    mock_rt.engine.get_total_vectors.return_value = 0

    with patch("app.server.get_runtime", return_value=mock_rt):
        resp = client.get("/suggestions?notebook_id=test_nb")
        assert resp.status_code == 200
        assert resp.json() == {"suggestions": []}


def test_suggestions_diverse_sampling(tmp_path):
    client = TestClient(app)
    mock_rt = MagicMock()
    mock_rt.engine.get_total_vectors.return_value = 3
    mock_rt.db_path = str(tmp_path / "test.db")

    docs = [
        {"id": 1, "content": "Chunk 1 from file A", "source_file": "fileA.txt", "metadata": "{}"},
        {"id": 2, "content": "Chunk 2 from file A", "source_file": "fileA.txt", "metadata": "{}"},
        {"id": 3, "content": "Chunk 1 from file B", "source_file": "fileB.txt", "metadata": "{}"},
    ]

    mock_llm = MagicMock()
    mock_llm.complete_json = AsyncMock(return_value={"questions": ["Q1?", "Q2?", "Q3?", "Q4?"]})

    with patch("app.server.get_runtime", return_value=mock_rt), \
         patch("app.server.database.get_all_documents", return_value=docs), \
         patch("app.server.llm", mock_llm):
        resp = client.get("/suggestions?notebook_id=test_nb")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["suggestions"]) == 4
        assert data["suggestions"][0] == "Q1?"
        # Verify prompt passed to LLM has chunks from both distinct sources
        call_args = mock_llm.complete_json.call_args[1]
        assert "fileA.txt" in call_args["prompt"]
        assert "fileB.txt" in call_args["prompt"]


def test_artifact_generate_invalid_type():
    client = TestClient(app)
    with patch("app.server.get_runtime"):
        resp = client.post(
            "/artifacts/generate",
            json={"notebook_id": "test_nb", "artifact_type": "invalid_type"},
        )
        assert resp.status_code == 400
        assert "Unknown artifact type" in resp.text


def test_artifact_generate_streaming(tmp_path):
    client = TestClient(app)
    mock_rt = MagicMock()
    mock_rt.db_path = str(tmp_path / "test.db")
    mock_rt.engine.embed.return_value = [0.1, 0.2]
    mock_rt.engine.search.return_value = ([1], [0.9])

    mock_doc = {
        "id": 1,
        "content": "Sample content for artifact",
        "metadata": json.dumps({"filename": "source.txt"}),
    }

    mock_llm = MagicMock()
    mock_llm.build_context.return_value = "[1] source.txt\nSample content for artifact"

    async def mock_stream(system, user):
        yield "Section 1: "
        yield "Summary details."

    mock_llm.stream_complete = mock_stream

    for art_type in ["briefing", "study_guide", "faq", "timeline"]:
        with patch("app.server.get_runtime", return_value=mock_rt), \
             patch("app.server.database.get_document", return_value=mock_doc), \
             patch("app.server.llm", mock_llm):
            resp = client.post(
                "/artifacts/generate",
                json={"notebook_id": "test_nb", "artifact_type": art_type, "focus": "Key findings"},
            )
            assert resp.status_code == 200
            content = resp.text
            assert "data: " in content
            assert "event: done" in content
            expected_title = ARTIFACT_PROMPTS[art_type]["title"]
            assert expected_title in content
            assert "Section 1: Summary details." in content


def test_ask_followups_emitted(tmp_path):
    client = TestClient(app)
    mock_rt = MagicMock()
    mock_rt.engine.get_total_vectors.return_value = 1
    mock_rt.db_path = str(tmp_path / "test.db")

    mock_llm = MagicMock()
    mock_llm.build_context.return_value = "context"

    async def mock_stream_answer(query, context):
        yield "This is the answer."

    mock_llm.stream_answer = mock_stream_answer
    mock_llm.complete_json = AsyncMock(
        return_value={"followups": ["Followup 1?", "Followup 2?", "Followup 3?"]}
    )

    fake_results = [{"id": 1, "content": "hello", "score": 0.9, "source": {"filename": "a.txt"}}]

    with patch("app.server.get_runtime", return_value=mock_rt), \
         patch("app.server._retrieve_and_filter", return_value=fake_results), \
         patch("app.server.llm", mock_llm):
        resp = client.post(
            "/ask",
            json={"query": "test query", "notebook_id": "test_nb", "agentic": False},
        )
        assert resp.status_code == 200
        text = resp.text
        assert "event: followups" in text
        assert "Followup 1?" in text

        # Verify complete_json was called with LLM_LIGHT_MODEL and max_tokens=120
        mock_llm.complete_json.assert_awaited_once()
        kwargs = mock_llm.complete_json.call_args[1]
        assert kwargs["model"] == LLM_LIGHT_MODEL
        assert kwargs["max_tokens"] == 120
