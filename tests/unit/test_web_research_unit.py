import pytest
from unittest.mock import patch, MagicMock
from app.core import web_research


def test_is_available_success():
    with patch("requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        web_research._health_cache = {"available": None, "checked_at": 0.0}
        assert web_research.is_available() is True


def test_is_available_fallback_when_searxng_down():
    with patch("requests.get", side_effect=Exception("Connection refused")):
        web_research._health_cache = {"available": None, "checked_at": 0.0}
        # Falls back to ddgs successfully
        assert web_research.is_available() is True
        assert web_research._health_cache.get("engine") == "duckduckgo"


def test_is_available_total_failure():
    with patch("requests.get", side_effect=Exception("Connection refused")), \
         patch.dict("sys.modules", {"ddgs": None, "duckduckgo_search": None}):
        web_research._health_cache = {"available": None, "checked_at": 0.0}
        assert web_research.is_available() is False


def test_search_web_parsing():
    sample_response = {
        "results": [
            {
                "title": "Result 1",
                "url": "https://example.com/1",
                "content": "Snippet 1",
                "engines": ["google"],
            },
            {
                "title": "Duplicate URL",
                "url": "https://example.com/1",
                "content": "Duplicate Snippet",
                "engines": ["bing"],
            },
            {
                "title": "Result 2",
                "url": "https://example.com/2",
                "content": "Snippet 2",
                "engines": ["duckduckgo"],
            },
        ]
    }
    with patch("requests.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = sample_response
        mock_resp.raise_for_status.return_value = None
        mock_get.return_value = mock_resp

        results = web_research.search_web("test query", num_results=10)
        assert len(results) == 2
        assert results[0]["title"] == "Result 1"
        assert results[0]["url"] == "https://example.com/1"
        assert results[1]["url"] == "https://example.com/2"


def test_extract_content_trafilatura():
    with patch("trafilatura.fetch_url") as mock_fetch, \
         patch("trafilatura.extract") as mock_extract, \
         patch("trafilatura.extract_metadata") as mock_meta:
        mock_fetch.return_value = "<html>mock html</html>"
        mock_extract.return_value = "Extracted article body text with sufficient length for testing."
        mock_meta_obj = MagicMock()
        mock_meta_obj.title = "Mock Article Title"
        mock_meta.return_value = mock_meta_obj

        result = web_research.extract_content("https://example.com/article")
        assert result["title"] == "Mock Article Title"
        assert "Extracted article body text" in result["content"]
        assert result["method"] == "trafilatura"
        assert result["word_count"] > 0


@pytest.mark.asyncio
async def test_plan_research():
    mock_llm = MagicMock()
    mock_llm.complete_json = MagicMock()
    import asyncio
    fut = asyncio.Future()
    fut.set_result({
        "queries": [
            {"sub_query": "subquery 1", "intent": "intent 1"},
            {"sub_query": "subquery 2", "intent": "intent 2"},
        ]
    })
    mock_llm.complete_json.return_value = fut

    queries = await web_research.plan_research("main topic", mock_llm)
    assert len(queries) == 2
    assert queries[0]["sub_query"] == "subquery 1"


@pytest.mark.asyncio
async def test_plan_research_fallback_on_error():
    mock_llm = MagicMock()
    import asyncio
    fut = asyncio.Future()
    fut.set_exception(Exception("LLM down"))
    mock_llm.complete_json.return_value = fut

    queries = await web_research.plan_research("main topic", mock_llm)
    assert len(queries) == 1
    assert queries[0]["sub_query"] == "main topic"
