"""
Deep research reports: a long, structured, cited answer built by a second
LangGraph graph that reuses Phase 1's retrieval building blocks.

    plan_report -> research -> write -> synthesize -> END

- plan_report: the local LLM breaks the question into 3-6 section headings,
               each with a focused retrieval query (heuristic fallback: a
               single "Findings" section using the original question).
- research:    retrieve evidence per section (the same hybrid dense+keyword
               retrieval as /search and /ask, optionally cross-encoder
               reranked), deduped across sections into one global, citation-
               numbered sources list.
- write:       the LLM writes each section from its evidence, streamed token by
               token, citing chunks by their global [n] number.
- synthesize:  a short conclusion plus an assembled "Sources" list.

The whole thing streams over SSE with the exact same typed-event protocol as
/ask (trace events, one sources event, then answer-text deltas), so the
frontend's existing SSE parser is reused unchanged.
"""

import logging
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Tuple, TypedDict

from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from starlette.concurrency import run_in_threadpool

from . import reranker
from .config import AGENT_MAX_K, RESEARCH_MAX_SECTIONS
from .llm import OllamaLLM

logger = logging.getLogger(__name__)

# retrieve_fn(query, k) -> list of {"id", "score", "content", "source"} dicts.
RetrieveFn = Callable[[str, int], List[Dict[str, Any]]]

PLAN_SYSTEM = """You are a research editor planning a structured report that answers the user's question.
Respond with ONLY a JSON object:
{
  "title": <a concise report title>,
  "sections": [
    {"heading": <a section heading>, "query": <a focused search query to gather evidence for this section>},
    ...
  ]
}
Use 3 to 6 sections that together answer the question comprehensively, in a logical reading order.
Do not include an introduction or conclusion section -- only the substantive body sections."""

SECTION_SYSTEM = """You are writing ONE section of a research report grounded strictly in the provided numbered context.
Write clear, substantive prose in Markdown (a few paragraphs; use sub-bullets only if genuinely helpful).
Do NOT repeat the section heading, and do NOT write an overall introduction or conclusion.
Cite evidence inline with the context document's bracketed number right after the claim it supports, like: "the index maps ids directly [3]."
Use ONLY the provided context; if it lacks something, say so briefly rather than inventing it."""

CONCLUSION_SYSTEM = """You are writing the concluding paragraph of a research report.
Given the report title and its section headings, write a single short concluding paragraph in Markdown that ties the findings together.
Do not add a heading, do not introduce new facts, and keep it to 3-5 sentences."""


class Section(TypedDict, total=False):
    heading: str
    query: str
    evidence: List[Dict[str, Any]]  # chunks retrieved for this section (global-numbered)


class ResearchState(TypedDict, total=False):
    query: str
    source_files: Optional[List[str]]
    k: int
    use_rerank: bool
    title: str
    sections: List[Section]
    sources: List[Dict[str, Any]]  # global deduped, citation-numbered chunk list


class ResearchGraph:
    def __init__(self, llm: Optional[OllamaLLM], retrieve_fn: RetrieveFn):
        self.llm = llm
        self.retrieve_fn = retrieve_fn
        self._graph = self._build()

    # ------------------------------------------------------------ helpers

    def _heuristic_plan(self, query: str) -> Dict[str, Any]:
        return {"title": query.strip().rstrip("?").strip() or "Research Report",
                "sections": [{"heading": "Findings", "query": query}]}

    async def _plan(self, query: str) -> Dict[str, Any]:
        fallback = self._heuristic_plan(query)
        if self.llm is None:
            return fallback
        raw = await self.llm.complete_json(PLAN_SYSTEM, f"Research question: {query}", max_tokens=500)
        if not isinstance(raw, dict):
            return fallback
        sections = raw.get("sections")
        cleaned: List[Dict[str, str]] = []
        if isinstance(sections, list):
            for s in sections:
                if not isinstance(s, dict):
                    continue
                heading = str(s.get("heading", "")).strip()
                q = str(s.get("query", "") or heading).strip()
                if heading and q:
                    cleaned.append({"heading": heading, "query": q})
        cleaned = cleaned[:RESEARCH_MAX_SECTIONS]
        if not cleaned:
            return fallback
        title = str(raw.get("title") or fallback["title"]).strip()[:160]
        return {"title": title, "sections": cleaned}

    @staticmethod
    def _context_for(evidence: List[Dict[str, Any]]) -> str:
        """Number chunks by their GLOBAL citation index so a section's inline
        [n] markers line up with the single sources event the client received."""
        parts = []
        for chunk in evidence:
            n = chunk["cite"]
            source = "unknown"
            if isinstance(chunk.get("source"), dict):
                source = chunk["source"].get("filename", "unknown")
            parts.append(f"[{n}] {source}\n{chunk['content']}")
        return "\n\n".join(parts) if parts else "No relevant context was found."

    @staticmethod
    async def _clean_stream(token_iter, heading: Optional[str] = None):
        """Line-buffer an LLM token stream and defensively clean two artifacts
        small models produce: (1) a first line that just repeats the section
        heading (we emit the heading ourselves), and (2) wrapping the whole
        answer in a ```markdown fence. Unwraps the fence and drops the dup
        heading; everything else streams through line by line.

        Bare ``` code fences (no `markdown`/`md` tag) pass through untouched, so
        genuine code blocks in a section are preserved.
        """
        heading_norm = None
        if heading:
            heading_norm = heading.strip().lstrip("#").strip().rstrip(":").strip().lower()
        first_seen = False
        in_md_fence = False
        pending = ""

        def process(line: str):
            nonlocal first_seen, in_md_fence
            stripped = line.strip()
            if not first_seen:
                if stripped == "":
                    return None  # swallow leading blank lines
                first_seen = True
                if heading_norm is not None:
                    norm = stripped.lstrip("#").strip().rstrip(":").strip().lower()
                    if norm == heading_norm:
                        return None  # drop a heading the model echoed back
            if not in_md_fence and stripped in ("```markdown", "```md"):
                in_md_fence = True
                return None
            if in_md_fence and stripped == "```":
                in_md_fence = False
                return None
            return line

        async for tok in token_iter:
            pending += tok
            while "\n" in pending:
                idx = pending.index("\n") + 1
                line, pending = pending[:idx], pending[idx:]
                out = process(line)
                if out:
                    yield out
        if pending:
            out = process(pending)
            if out:
                yield out

    # ------------------------------------------------------------- nodes

    async def _plan_node(self, state: ResearchState) -> Dict[str, Any]:
        writer = get_stream_writer()
        plan = await self._plan(state["query"])
        sections: List[Section] = [
            {"heading": s["heading"], "query": s["query"]} for s in plan["sections"]
        ]
        writer({"kind": "trace", "event": {
            "type": "trace", "stage": "plan",
            "message": f"planned '{plan['title']}' → {len(sections)} sections",
            "data": {"title": plan["title"], "sections": [s["heading"] for s in sections]},
        }})
        return {"title": plan["title"], "sections": sections}

    async def _research_node(self, state: ResearchState) -> Dict[str, Any]:
        writer = get_stream_writer()
        k, use_rerank = state["k"], state["use_rerank"]
        sections = state["sections"]

        # Global deduped sources, in first-seen order; each gets a 1-based cite.
        global_by_id: Dict[int, Dict[str, Any]] = {}
        for i, section in enumerate(sections):
            candidates = await self._retrieve(section["query"], k, use_rerank)
            evidence = []
            for c in candidates:
                existing = global_by_id.get(c["id"])
                if existing is None:
                    c = {**c, "cite": len(global_by_id) + 1}
                    global_by_id[c["id"]] = c
                    evidence.append(c)
                else:
                    evidence.append(existing)
            section["evidence"] = evidence
            writer({"kind": "trace", "event": {
                "type": "trace", "stage": "research",
                "message": f"section {i + 1}/{len(sections)} '{section['heading']}': {len(evidence)} chunks",
                "data": {"section": section["heading"], "chunks": len(evidence)},
            }})

        sources = sorted(global_by_id.values(), key=lambda c: c["cite"])
        # Emit the sources event in the same shape as /ask.
        writer({"kind": "sources", "sources": [
            {
                "id": c["id"],
                "content": c["content"],
                "score": c.get("score", 0.0),
                "rerank_score": c.get("rerank_score"),
                "source": c.get("source"),
            }
            for c in sources
        ]})
        return {"sources": sources}

    async def _retrieve(self, query: str, k: int, use_rerank: bool) -> List[Dict[str, Any]]:
        candidates = await run_in_threadpool(self.retrieve_fn, query, k)
        if use_rerank and candidates:
            candidates = await run_in_threadpool(reranker.rerank, query, candidates)
        return candidates[:k]

    async def _write_node(self, state: ResearchState) -> Dict[str, Any]:
        writer = get_stream_writer()

        def delta(text: str):
            writer({"kind": "delta", "text": text})

        delta(f"# {state['title']}\n\n")
        for i, section in enumerate(state["sections"]):
            delta(f"## {section['heading']}\n\n")
            context = self._context_for(section.get("evidence", []))
            user = (f"Report title: {state['title']}\n"
                    f"Section heading: {section['heading']}\n\n"
                    f"<context>\n{context}\n</context>")
            if self.llm is None:
                delta("_The local LLM is unavailable, so this section could not be written._\n")
            else:
                async for tok in self._clean_stream(
                    self.llm.stream_complete(SECTION_SYSTEM, user), heading=section["heading"]
                ):
                    delta(tok)
            delta("\n\n")
            writer({"kind": "trace", "event": {
                "type": "trace", "stage": "write",
                "message": f"wrote section {i + 1}/{len(state['sections'])}: {section['heading']}",
                "data": {"section": section["heading"]},
            }})
        return {}

    async def _synthesize_node(self, state: ResearchState) -> Dict[str, Any]:
        writer = get_stream_writer()

        def delta(text: str):
            writer({"kind": "delta", "text": text})

        headings = [s["heading"] for s in state["sections"]]
        delta("## Conclusion\n\n")
        if self.llm is not None:
            user = f"Report title: {state['title']}\nSection headings: {', '.join(headings)}"
            async for tok in self._clean_stream(
                self.llm.stream_complete(CONCLUSION_SYSTEM, user), heading="Conclusion"
            ):
                delta(tok)
            delta("\n\n")

        # Sources list, numbered to match the inline [n] citations.
        if state.get("sources"):
            delta("## Sources\n\n")
            for c in state["sources"]:
                name = "unknown"
                if isinstance(c.get("source"), dict):
                    name = c["source"].get("filename", "unknown")
                delta(f"{c['cite']}. {name}\n")

        writer({"kind": "trace", "event": {
            "type": "trace", "stage": "done",
            "message": f"report complete · {len(state.get('sources', []))} sources",
            "data": {"sources": len(state.get("sources", []))},
        }})
        return {}

    # ------------------------------------------------------------- graph

    def _build(self):
        g = StateGraph(ResearchState)
        g.add_node("plan_report", self._plan_node)
        g.add_node("research", self._research_node)
        g.add_node("write", self._write_node)
        g.add_node("synthesize", self._synthesize_node)
        g.add_edge(START, "plan_report")
        g.add_edge("plan_report", "research")
        g.add_edge("research", "write")
        g.add_edge("write", "synthesize")
        g.add_edge("synthesize", END)
        return g.compile()

    async def run(
        self, query: str, source_files: Optional[List[str]] = None
    ) -> AsyncIterator[Tuple[str, Any]]:
        """Drive the research graph, yielding ('trace'|'sources'|'delta', payload)
        tuples the /research endpoint maps straight onto SSE events."""
        use_rerank = reranker.is_available()
        initial: ResearchState = {
            "query": query,
            "source_files": source_files,
            "k": AGENT_MAX_K,
            "use_rerank": use_rerank,
        }
        async for chunk in self._graph.astream(initial, stream_mode="custom"):
            kind = chunk.get("kind")
            if kind == "trace":
                yield ("trace", chunk["event"])
            elif kind == "sources":
                yield ("sources", chunk["sources"])
            elif kind == "delta":
                yield ("delta", chunk["text"])
