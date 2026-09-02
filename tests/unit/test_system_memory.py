"""Unit tests for memory optimization and diagnostics."""
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.server import app
from app.core import web_research, engine, config


@pytest.fixture
def client():
    return TestClient(app)


def test_system_memory_endpoint(client):
    """GET /system/memory returns RSS, peak RSS, and model residency."""
    response = client.get("/system/memory")
    assert response.status_code == 200
    data = response.json()
    assert "rss_mb" in data
    assert "peak_mb" in data
    assert "stt_loaded" in data
    assert "tts_loaded" in data
    assert "audio_idle_timeout_sec" in data
    assert data["audio_idle_timeout_sec"] == 60.0
    assert data["llm_keep_alive"] == "5m"


def test_clear_system_memory_endpoint(client):
    """POST /system/memory/clear unloads audio models and clears memory."""
    response = client.post("/system/memory/clear")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


def test_web_extract_char_limit(monkeypatch):
    """Web extraction truncates text to MAX_WEB_EXTRACT_CHARS to prevent memory blowup."""
    huge_text = "Word " * 10000  # 50,000 characters
    monkeypatch.setattr("trafilatura.fetch_url", lambda u: "<html>huge</html>")
    monkeypatch.setattr("trafilatura.extract", lambda *args, **kwargs: huge_text)
    monkeypatch.setattr("trafilatura.extract_metadata", lambda *args, **kwargs: None)

    res = web_research.extract_content("https://example.com/huge-doc")
    assert len(res["content"]) <= config.MAX_WEB_EXTRACT_CHARS
    assert len(res["content"]) == config.MAX_WEB_EXTRACT_CHARS


def test_engine_embed_batch_sub_batching(monkeypatch):
    """embed_batch processes large inputs in sub-batches <= MAX_EMBED_BATCH_SIZE."""
    dummy_model = MagicMock()
    # Mock model.encode to return 2D numpy array of length = input batch
    import numpy as np
    dummy_model.encode.side_effect = lambda texts, **kwargs: np.ones((len(texts), 768), dtype="float32")

    with patch.object(engine, "get_shared_model", return_value=dummy_model):
        ve = engine.VectorEngine("tests/temp_test_index.faiss")
        ve.model = dummy_model

        # 70 texts with MAX_EMBED_BATCH_SIZE = 32 should invoke encode 3 times (32, 32, 6)
        texts = [f"Text sentence {i}" for i in range(70)]
        embeddings = ve.embed_batch(texts)
        assert embeddings.shape == (70, 768)
        assert dummy_model.encode.call_count == 3
