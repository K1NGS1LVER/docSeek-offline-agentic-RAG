"""
Agentic retrieval controller.

For each question the agent runs a bounded observe/decide/act loop, entirely
on-device (decisions via the local Ollama model, reranking via a local
cross-encoder):

1. PLAN    — classify the query and choose the retrieval knobs: top-k,
             query rewrite, decomposition into sub-queries, and whether the
             cross-encoder rerank is worth the latency.
2. RETRIEVE— hybrid dense+keyword retrieval per (sub-)query, RRF-fused.
3. RERANK  — optional cross-encoder rescoring of an over-fetched candidate set.
4. GRADE   — judge whether the evidence actually answers the question.
5. RE-LOOP — if evidence is weak, reformulate the query, widen k, retry
             (at most MAX_AGENT_LOOPS extra passes).

Every LLM decision has a deterministic heuristic fallback, so when Ollama is
unreachable the pipeline degrades to plain hybrid retrieval instead of failing.

run() is an async generator yielding trace events (so the UI can show the
agent thinking) followed by a final {"type": "results", ...} event.
"""

import logging
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

from starlette.concurrency import run_in_threadpool

from . import reranker
from .config import (
    AGENT_MAX_K,
    AGENT_MIN_K,
    MAX_AGENT_LOOPS,
    RERANK_CANDIDATE_FACTOR,
)
from .fusion import reciprocal_rank_fusion
from .llm import OllamaLLM

logger = logging.getLogger(__name__)

# retrieve_fn(query, k) -> list of {"id", "score", "content", "source"} dicts.
RetrieveFn = Callable[[str, int], List[Dict[str, Any]]]

MAX_RERANK_CANDIDATES = 30
MAX_SUBQUERIES = 3

PLAN_SYSTEM = """You are the retrieval planner of a local document-search system.
Given a user query, decide how to retrieve evidence. Respond with ONLY a JSON object:
{
  "query_type": "keyword" | "factual" | "conceptual" | "multi_hop",
  "k": <int 3-12, how many chunks to retrieve; more for broad/complex queries>,
  "rewritten_query": <string or null; a clearer standalone search query, null if the original is already good>,
  "subqueries": <array of 2-3 simpler search queries if the question needs multiple distinct lookups, else null>,
  "rerank": <true if precise ranking matters (natural-language questions), false for simple keyword lookups>,
  "reason": <one short sentence explaining your choices>
}"""

GRADE_SYSTEM = """You judge whether retrieved document snippets contain enough information to answer a user's question.
Respond with ONLY a JSON object:
{
  "sufficient": <true if the snippets can answer the question, else false>,
  "confidence": <float 0.0-1.0>,
  "better_query": <string or null; if insufficient, a reformulated search query more likely to find the answer>
}"""


def _clamp_k(k: Any, default: int) -> int:
    try:
        return max(AGENT_MIN_K, min(AGENT_MAX_K, int(k)))
    except (TypeError, ValueError):
        return default


class RetrievalAgent:
    def __init__(self, llm: Optional[OllamaLLM], retrieve_fn: RetrieveFn):
        self.llm = llm
        self.retrieve_fn = retrieve_fn

    # ------------------------------------------------------------------ plan

    def _heuristic_plan(self, query: str, user_k: Optional[int]) -> Dict[str, Any]:
        """Deterministic plan used when the LLM is unavailable or off."""
        words = query.split()
        is_question = "?" in query or (
            words and words[0].lower() in
            ("what", "how", "why", "when", "where", "who", "which", "does", "do",
             "is", "are", "can", "should", "explain", "compare")
        )
        if len(words) <= 3 and not is_question:
            query_type, k = "keyword", 4
        elif len(words) >= 12 or query.count("?") > 1 or " and " in query.lower():
            query_type, k = "multi_hop", 10
        else:
            query_type, k = "factual" if is_question else "conceptual", 6
        return {
            "query_type": query_type,
            "k": user_k if user_k else k,
            "rewritten_query": None,
            "subqueries": None,
            "rerank": len(words) >= 3,
            "reason": "Heuristic plan (local LLM unavailable or planning disabled).",
            "planner": "heuristic",
        }

    async def _plan(self, query: str, user_k: Optional[int]) -> Dict[str, Any]:
        fallback = self._heuristic_plan(query, user_k)
        if self.llm is None:
            return fallback

        raw = await self.llm.complete_json(PLAN_SYSTEM, f"Query: {query}")
        if not isinstance(raw, dict):
            return fallback

        subqueries = raw.get("subqueries")
        if isinstance(subqueries, list):
            subqueries = [s for s in subqueries if isinstance(s, str) and s.strip()][:MAX_SUBQUERIES]
            if len(subqueries) < 2:
                subqueries = None
        else:
            subqueries = None

        rewritten = raw.get("rewritten_query")
        if not isinstance(rewritten, str) or not rewritten.strip() or rewritten.strip() == query:
            rewritten = None

        return {
            "query_type": raw.get("query_type") if raw.get("query_type") in
                          ("keyword", "factual", "conceptual", "multi_hop") else fallback["query_type"],
            # An explicit user k always wins over the agent's choice.
            "k": user_k if user_k else _clamp_k(raw.get("k"), fallback["k"]),
            "rewritten_query": rewritten,
            "subqueries": subqueries,
            "rerank": bool(raw.get("rerank", fallback["rerank"])),
            "reason": str(raw.get("reason", ""))[:300],
            "planner": "llm",
        }

    # ------------------------------------------------------------- retrieval

    async def _retrieve(self, queries: List[str], fetch_k: int) -> List[Dict[str, Any]]:
        """Retrieve for one or more queries; multi-query results are RRF-fused."""
        result_lists = []
        for q in queries:
            results = await run_in_threadpool(self.retrieve_fn, q, fetch_k)
            result_lists.append(results)

        if len(result_lists) == 1:
            return result_lists[0]

        by_id: Dict[int, Dict[str, Any]] = {}
        rankings = []
        for results in result_lists:
            rankings.append([r["id"] for r in results])
            for r in results:
                prev = by_id.get(r["id"])
                if prev is None or r["score"] > prev["score"]:
                    by_id[r["id"]] = r
        fused_ids = reciprocal_rank_fusion(rankings)
        return [by_id[i] for i in fused_ids if i in by_id]

    # --------------------------------------------------------------- grading

    def _heuristic_grade(self, results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Score-based sufficiency check (free, no LLM call)."""
        if not results:
            return {"sufficient": False, "confidence": 0.0, "better_query": None,
                    "grader": "heuristic"}
        top = results[0]
        rerank_score = top.get("rerank_score")
        if rerank_score is not None:
            # Cross-encoder logits: >0 is a confident match.
            sufficient = rerank_score > 0.0
            confidence = min(1.0, max(0.0, 0.5 + rerank_score / 10.0))
        else:
            sufficient = top.get("score", 0.0) >= 0.30
            confidence = min(1.0, max(0.0, top.get("score", 0.0)))
        return {"sufficient": sufficient, "confidence": round(confidence, 2),
                "better_query": None, "grader": "heuristic"}

    async def _grade(self, query: str, results: List[Dict[str, Any]]) -> Dict[str, Any]:
        fallback = self._heuristic_grade(results)
        if self.llm is None or not results:
            return fallback

        snippets = "\n\n".join(
            f"[{i}] {r['content'][:350]}" for i, r in enumerate(results[:6], 1)
        )
        raw = await self.llm.complete_json(
            GRADE_SYSTEM, f"Question: {query}\n\nSnippets:\n{snippets}"
        )
        if not isinstance(raw, dict) or "sufficient" not in raw:
            return fallback

        better_query = raw.get("better_query")
        if not isinstance(better_query, str) or not better_query.strip() or better_query.strip() == query:
            better_query = None
        try:
            confidence = max(0.0, min(1.0, float(raw.get("confidence", 0.5))))
        except (TypeError, ValueError):
            confidence = 0.5
        return {
            "sufficient": bool(raw["sufficient"]),
            "confidence": round(confidence, 2),
            "better_query": better_query,
            "grader": "llm",
        }

    # ------------------------------------------------------------------ run

    async def run(
        self, query: str, user_k: Optional[int] = None
    ) -> AsyncIterator[Dict[str, Any]]:
        """Run the agentic retrieval loop, yielding trace events then results."""

        plan = await self._plan(query, user_k)
        k = plan["k"]
        use_rerank = plan["rerank"] and reranker.is_available()
        yield {
            "type": "trace", "stage": "plan",
            "message": f"{plan['query_type']} query → k={k}"
                       f"{', rerank' if use_rerank else ''}"
                       f"{', rewritten' if plan['rewritten_query'] else ''}"
                       f"{f', {len(plan['subqueries'])} subqueries' if plan['subqueries'] else ''}"
                       f" ({plan['planner']})",
            "data": plan,
        }

        active_query = plan["rewritten_query"] or query
        best_by_id: Dict[int, Dict[str, Any]] = {}
        results: List[Dict[str, Any]] = []
        grade: Dict[str, Any] = {}
        iterations = 0

        for iteration in range(1 + MAX_AGENT_LOOPS):
            iterations = iteration + 1
            queries = plan["subqueries"] if (iteration == 0 and plan["subqueries"]) else [active_query]
            fetch_k = min(k * RERANK_CANDIDATE_FACTOR, MAX_RERANK_CANDIDATES) if use_rerank else k

            candidates = await self._retrieve(queries, fetch_k)
            yield {
                "type": "trace", "stage": "retrieve",
                "message": f"pass {iterations}: {len(candidates)} candidates for "
                           + (f"{len(queries)} subqueries" if len(queries) > 1 else f"'{queries[0]}'"),
                "data": {"iteration": iterations, "queries": queries, "candidates": len(candidates)},
            }

            if use_rerank and candidates:
                candidates = await run_in_threadpool(reranker.rerank, active_query, candidates)
                yield {
                    "type": "trace", "stage": "rerank",
                    "message": f"cross-encoder reranked {len(candidates)} candidates",
                    "data": {"candidates": len(candidates)},
                }

            # Merge this pass into the running best set (dedupe by chunk id).
            for r in candidates:
                prev = best_by_id.get(r["id"])
                if prev is None or r.get("rerank_score", r["score"]) > prev.get("rerank_score", prev["score"]):
                    best_by_id[r["id"]] = r
            results = sorted(
                best_by_id.values(),
                key=lambda r: r.get("rerank_score", r["score"]),
                reverse=True,
            )[:k]

            last_pass = iteration == MAX_AGENT_LOOPS
            # LLM-grade only when a retry is still possible; the final pass
            # gets the free heuristic grade for the trace.
            grade = self._heuristic_grade(results) if last_pass else await self._grade(active_query, results)
            yield {
                "type": "trace", "stage": "grade",
                "message": f"evidence {'sufficient' if grade['sufficient'] else 'insufficient'} "
                           f"(confidence {grade['confidence']:.2f}, {grade['grader']})",
                "data": grade,
            }

            if grade["sufficient"] or last_pass:
                break

            # Re-loop: reformulate and widen.
            new_query = grade.get("better_query")
            new_k = min(k + 4, AGENT_MAX_K)
            if not new_query and new_k == k:
                break  # nothing left to vary; another pass would be identical
            if new_query:
                active_query = new_query
            k = new_k
            yield {
                "type": "trace", "stage": "loop",
                "message": f"retrying with "
                           + (f"query '{active_query}' and " if new_query else "")
                           + f"k={k}",
                "data": {"query": active_query, "k": k},
            }

        yield {
            "type": "results",
            "results": results,
            "plan": plan,
            "grade": grade,
            "iterations": iterations,
        }
