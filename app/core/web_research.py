"""Web research: search via SearXNG, extract content, deep research with LLM.

Provides two modes:
1. Quick Search — query SearXNG, return results for user preview/import.
2. Deep Research — LLM decomposes query, multi-searches, extracts, summarizes,
   generates a cited report.

All search goes through a local SearXNG instance (Docker). Content extraction
uses trafilatura (fast, no browser) with optional Crawl4AI fallback for
JS-heavy pages.
"""

import json
import logging
import time
from typing import AsyncGenerator, Optional

import requests

from app.core.config import SEARXNG_URL, CRAWL4AI_ENABLED, RESEARCH_MAX_RESULTS

logger = logging.getLogger(__name__)

# ── Health ──────────────────────────────────────────────────────

_health_cache: dict = {"available": None, "checked_at": 0.0}
HEALTH_CACHE_TTL = 30  # seconds


def is_available() -> bool:
    """Check if SearXNG is reachable. Cached for 30s."""
    now = time.time()
    if now - _health_cache["checked_at"] < HEALTH_CACHE_TTL:
        return _health_cache["available"]
    try:
        r = requests.get(
            f"{SEARXNG_URL}/search",
            params={"q": "test", "format": "json"},
            timeout=3,
        )
        available = r.status_code == 200
    except Exception:
        available = False
    _health_cache.update(available=available, checked_at=now)
    return available


# ── Search ──────────────────────────────────────────────────────


def search_web(query: str, num_results: int = RESEARCH_MAX_RESULTS) -> list[dict]:
    """Query SearXNG, return deduplicated [{title, url, snippet, engines}]."""
    r = requests.get(
        f"{SEARXNG_URL}/search",
        params={"q": query, "format": "json", "pageno": 1},
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()

    seen_urls: set[str] = set()
    results: list[dict] = []
    for item in data.get("results", []):
        url = item.get("url", "")
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        results.append({
            "title": item.get("title", ""),
            "url": url,
            "snippet": item.get("content", ""),
            "engines": item.get("engines", []),
        })
        if len(results) >= num_results:
            break
    return results


# ── Content Extraction ──────────────────────────────────────────


def extract_content(url: str) -> dict:
    """Extract clean text from URL. trafilatura first, Crawl4AI fallback.

    Returns {url, title, content, word_count, method}.
    """
    import trafilatura

    title = ""
    content = None
    method = "trafilatura"

    try:
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            content = trafilatura.extract(
                downloaded,
                include_links=False,
                include_tables=True,
                deduplicate=True,
            )
            # Extract title from metadata
            metadata = trafilatura.extract_metadata(downloaded)
            if metadata and metadata.title:
                title = metadata.title
    except Exception as e:
        logger.warning("trafilatura failed for %s: %s", url, e)

    # Fallback to Crawl4AI if enabled and trafilatura got nothing useful
    if (not content or len(content) < 100) and CRAWL4AI_ENABLED:
        try:
            import asyncio
            from crawl4ai import AsyncWebCrawler

            async def _crawl():
                async with AsyncWebCrawler() as crawler:
                    result = await crawler.arun(url=url)
                    return (result.markdown, getattr(result, "title", "")) if result.success else (None, "")

            crawl_content, crawl_title = asyncio.run(_crawl())
            if crawl_content:
                content = crawl_content
                method = "crawl4ai"
                if crawl_title and not title:
                    title = crawl_title
        except Exception as e:
            logger.warning("crawl4ai failed for %s: %s", url, e)

    content = content or ""
    return {
        "url": url,
        "title": title or url,
        "content": content,
        "word_count": len(content.split()) if content else 0,
        "method": method,
    }


# ── Deep Research (LLM-powered) ────────────────────────────────


PLAN_SYSTEM = (
    "You are a research planner. Given a research question, generate 3-5 specific "
    "search queries that explore different angles of the topic. Each query should "
    "target a different aspect to ensure comprehensive coverage."
)

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "queries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sub_query": {"type": "string"},
                    "intent": {"type": "string"},
                },
                "required": ["sub_query", "intent"],
            },
        }
    },
    "required": ["queries"],
}


async def plan_research(query: str, llm) -> list[dict]:
    """Decompose query into 3-5 sub-queries via LLM.

    Heuristic fallback: just return the raw query if LLM unavailable.
    """
    try:
        result = await llm.complete_json(
            system=PLAN_SYSTEM,
            prompt=f"Research question: {query}",
            max_tokens=400,
            schema=PLAN_SCHEMA,
        )
        if result and isinstance(result.get("queries"), list) and result["queries"]:
            return result["queries"][:5]
    except Exception as e:
        logger.warning("LLM query decomposition failed: %s", e)

    # Heuristic fallback
    return [{"sub_query": query, "intent": "direct search"}]


SUMMARIZE_SYSTEM = (
    "You are a research assistant. Summarize how the given source is relevant to "
    "the research question. Write 2-3 concise sentences."
)

REPORT_SYSTEM = (
    "You are a research report writer. Write a clear, well-structured markdown "
    "report answering the research question using ONLY the provided sources. "
    "Cite sources inline as [n]. Include an introduction, body sections, and conclusion."
)


async def deep_research(
    query: str, llm, num_results_per_query: int = 5
) -> AsyncGenerator[dict, None]:
    """Full deep research pipeline. Yields trace events and final results.

    Pipeline:
    1. plan_research() → sub-queries
    2. search_web() for each sub-query
    3. Deduplicate URLs across all sub-queries
    4. extract_content() for top unique URLs
    5. LLM summarizes each source's relevance
    6. LLM generates a synthesis report
    7. Yield final {results, report_markdown}
    """
    # Phase 1: Plan
    yield {"type": "trace", "step": "plan",
           "detail": "Decomposing research question..."}
    sub_queries = await plan_research(query, llm)
    yield {"type": "trace", "step": "plan_done",
           "detail": f"Generated {len(sub_queries)} sub-queries",
           "sub_queries": sub_queries}

    # Phase 2: Search
    all_results: list[dict] = []
    seen_urls: set[str] = set()
    for i, sq in enumerate(sub_queries):
        sub_q = sq.get("sub_query", query)
        yield {"type": "trace", "step": "search",
               "detail": f"Searching ({i + 1}/{len(sub_queries)}): {sub_q}"}
        try:
            results = search_web(sub_q, num_results_per_query)
            for r in results:
                if r["url"] not in seen_urls:
                    seen_urls.add(r["url"])
                    r["from_query"] = sub_q
                    all_results.append(r)
        except Exception as e:
            yield {"type": "trace", "step": "search_error",
                   "detail": f"Search failed for '{sub_q}': {e}"}

    yield {"type": "trace", "step": "search_done",
           "detail": f"Found {len(all_results)} unique URLs"}

    # Phase 3: Extract content from top URLs
    top_urls = all_results[:RESEARCH_MAX_RESULTS]
    extracted: list[dict] = []
    for i, r in enumerate(top_urls):
        yield {"type": "trace", "step": "extract",
               "detail": f"Extracting ({i + 1}/{len(top_urls)}): {r['title'][:60]}"}
        try:
            content_data = extract_content(r["url"])
            r["content"] = content_data["content"]
            r["word_count"] = content_data["word_count"]
            r["extraction_method"] = content_data["method"]
            if content_data.get("title") and content_data["title"] != r["url"]:
                r["title"] = content_data["title"]
            if content_data["content"]:
                extracted.append(r)
        except Exception as e:
            yield {"type": "trace", "step": "extract_error",
                   "detail": f"Extraction failed for {r['url']}: {e}"}

    # Phase 4: LLM summarizes each source's relevance
    for i, r in enumerate(extracted):
        yield {"type": "trace", "step": "summarize",
               "detail": f"Summarizing ({i + 1}/{len(extracted)}): {r['title'][:60]}"}
        try:
            preview = r["content"][:2000]
            result = await llm.complete_json(
                system=SUMMARIZE_SYSTEM,
                prompt=(
                    f"Research question: {query}\n\n"
                    f"Source ({r['url']}):\n{preview}\n\n"
                    f"Return JSON: {{\"summary\": \"...\"}}"
                ),
                max_tokens=200,
            )
            r["summary"] = result.get("summary", r.get("snippet", "")) if result else r.get("snippet", "")
        except Exception:
            r["summary"] = r.get("snippet", "")

    # Phase 5: Generate synthesis report
    yield {"type": "trace", "step": "report",
           "detail": "Generating research report..."}
    report_md = await _generate_report(query, extracted, llm)

    yield {"type": "results", "query": query,
           "results": extracted, "report_markdown": report_md}


async def _generate_report(query: str, sources: list[dict], llm) -> str:
    """Generate a cited markdown report from extracted sources."""
    if not sources:
        return f"# Research: {query}\n\nNo sources could be extracted for this query."

    # Build numbered source context (same pattern as agent.py)
    context_parts = []
    for i, s in enumerate(sources, 1):
        preview = s.get("content", "")[:1500]
        context_parts.append(f"[{i}] {s['title']} ({s['url']})\n{preview}")
    context = "\n\n---\n\n".join(context_parts)

    prompt = (
        f"Research question: {query}\n\n"
        f"Sources:\n{context}\n\n"
        f"Write a research report with sections. Cite sources as [n]."
    )

    try:
        report_parts: list[str] = []
        async for chunk in llm.stream_complete(REPORT_SYSTEM, prompt):
            report_parts.append(chunk)
        return "".join(report_parts)
    except Exception as e:
        logger.warning("Report generation failed: %s", e)
        # Fallback: structured source listing
        lines = [f"# Research: {query}\n"]
        for i, s in enumerate(sources, 1):
            lines.append(f"## [{i}] {s['title']}\n{s.get('summary', s.get('snippet', ''))}\n")
        return "\n".join(lines)
