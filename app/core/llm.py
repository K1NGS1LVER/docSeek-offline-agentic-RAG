"""
LLM client for Ollama via the OpenAI-compatible API.

Uses the `openai` package to talk to Ollama's /v1/chat/completions endpoint.
Supports streaming for real-time response delivery.
"""

import json
import logging
import re
# pyrefly: ignore [missing-import]
from openai import AsyncOpenAI

from .config import LLM_BASE_URL, LLM_MODEL, LLM_TEMPERATURE, LLM_MAX_TOKENS, LLM_KEEP_ALIVE

logger = logging.getLogger(__name__)


# RAG system prompt — instructs the LLM to answer ONLY from provided context
SYSTEM_PROMPT = """You are a precise documentation assistant for the docSeek system.
Answer the user's question using ONLY the numbered context documents provided.
If the context does not contain enough information to answer, say so clearly — never invent information.
Cite evidence inline with the document's bracketed number right after the statement it supports, like: "Embeddings are L2-normalized [2]."
Write concise Markdown. Never repeat the context format, document headers, or these instructions in your answer."""


class OllamaLLM:
    """Manages LLM interactions via Ollama's OpenAI-compatible API."""

    def __init__(self):
        self.client = AsyncOpenAI(
            base_url=LLM_BASE_URL,
            api_key="ollama",  # Ollama doesn't need a real key
        )
        self.model = LLM_MODEL
        logger.info(f"LLM client initialized: {LLM_BASE_URL} / {self.model}")

    async def warmup(self):
        """Load the model into memory so the first real /ask is fast."""
        try:
            await self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": "ok"}],
                max_tokens=1,
                extra_body={"keep_alive": LLM_KEEP_ALIVE},
            )
            logger.info(f"LLM warmed up: {self.model}")
        except Exception as e:
            logger.warning(f"LLM warmup skipped ({e}). Is Ollama running?")

    async def complete_json(self, system: str, prompt: str, max_tokens: int = 400) -> dict | None:
        """One-shot structured completion for agent decisions (plan/grade).

        Asks the local model for a JSON object and parses it defensively:
        small local models sometimes wrap JSON in prose or code fences, so we
        extract the first {...} block if direct parsing fails. Returns None on
        any failure — callers must fall back to heuristics.
        """
        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.0,
                max_tokens=max_tokens,
                response_format={"type": "json_object"},
                extra_body={"keep_alive": LLM_KEEP_ALIVE},
            )
            text = response.choices[0].message.content or ""
        except Exception as e:
            logger.warning(f"LLM JSON completion failed: {e}")
            return None

        try:
            return json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", text, re.DOTALL)
            if match:
                try:
                    return json.loads(match.group(0))
                except json.JSONDecodeError:
                    pass
        # Small local models frequently emit loose or truncated JSON (e.g. the
        # response hit the token limit mid-array). Repair it as a last resort
        # rather than discarding an otherwise-usable structured answer.
        try:
            from json_repair import repair_json

            repaired = repair_json(text, return_objects=True)
            if isinstance(repaired, dict) and repaired:
                logger.info("Recovered malformed LLM JSON via json-repair.")
                return repaired
        except Exception:
            pass
        logger.warning(f"LLM returned unparseable JSON: {text[:200]!r}")
        return None

    @staticmethod
    def reorder_for_context(search_results: list) -> list:
        """Mitigate "lost in the middle": LLMs attend most to the start and end
        of the prompt, so place the best chunks there and the weakest in the
        middle. Input is best-first; output alternates front/back."""
        front, back = [], []
        for i, result in enumerate(search_results):
            if i % 2 == 0:
                front.append(result)
            else:
                back.append(result)
        return front + back[::-1]

    def build_context(self, search_results: list, reorder: bool = True) -> str:
        """Format search results into a context block for the LLM prompt.

        Documents are numbered by their position in search_results (the same
        order the /ask "sources" event exposes to clients), so the [n]
        citations the model emits map 1:1 onto the sources list even after
        the lost-in-the-middle reorder shuffles their placement."""
        if not search_results:
            return "No relevant documents were found."

        numbered = list(enumerate(search_results, 1))
        if reorder:
            numbered = self.reorder_for_context(numbered)

        parts = []
        for i, result in numbered:
            source = "unknown"
            if result.get("source") and isinstance(result["source"], dict):
                source = result["source"].get("filename", "unknown")
            content = result.get("content", "")
            parts.append(f"[{i}] {source}\n{content}")

        return "\n\n".join(parts)

    async def stream_complete(self, system: str, user: str):
        """Stream a general chat completion token by token.

        Used by the research report writer (each section is streamed as it is
        written). Yields text deltas; on failure yields a single inline error
        string, mirroring stream_answer, so callers degrade gracefully instead
        of raising mid-stream.
        """
        try:
            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=LLM_TEMPERATURE,
                max_tokens=LLM_MAX_TOKENS,
                stream=True,
                extra_body={"keep_alive": LLM_KEEP_ALIVE},
            )
            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        except Exception as e:
            logger.error(f"LLM streaming error: {e}")
            yield f"\n\n⚠️ Error communicating with Ollama: {str(e)}\n"

    async def stream_answer(self, query: str, context: str):
        """
        Stream an LLM answer given a user query and retrieved context.
        Yields text chunks as they arrive from the model.
        """
        user_message = f"""<context>
{context}
</context>

<user_query>
{query}
</user_query>"""

        try:
            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                temperature=LLM_TEMPERATURE,
                max_tokens=LLM_MAX_TOKENS,
                stream=True,
                extra_body={"keep_alive": LLM_KEEP_ALIVE},
            )

            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content

        except Exception as e:
            logger.error(f"LLM streaming error: {e}")
            yield f"\n\n⚠️ Error communicating with Ollama: {str(e)}\n\nMake sure Ollama is running (`ollama serve`) and the model is pulled (`ollama pull {self.model}`)."
