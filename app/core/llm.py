"""
LLM client for Ollama via the OpenAI-compatible API.

Uses the `openai` package to talk to Ollama's /v1/chat/completions endpoint.
Supports streaming for real-time response delivery.
"""

import logging
# pyrefly: ignore [missing-import]
from openai import AsyncOpenAI

from .config import LLM_BASE_URL, LLM_MODEL, LLM_TEMPERATURE, LLM_MAX_TOKENS, LLM_KEEP_ALIVE

logger = logging.getLogger(__name__)


# RAG system prompt — instructs the LLM to answer ONLY from provided context
SYSTEM_PROMPT = """You are a precise documentation assistant for the docSeek system.
Answer the user's question using ONLY the provided context below.
If the context does not contain enough information to answer, say so clearly — do NOT make up information.
Be concise, cite which source document you are referencing, and format your answer in Markdown."""


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

    def build_context(self, search_results: list) -> str:
        """Format search results into a context block for the LLM prompt."""
        if not search_results:
            return "No relevant documents were found."

        parts = []
        for i, result in enumerate(search_results, 1):
            source = ""
            if result.get("source") and isinstance(result["source"], dict):
                source = result["source"].get("filename", "unknown")
            score = result.get("score", 0)
            content = result.get("content", "")
            parts.append(
                f"--- Document {i} [source: {source}, score: {score:.2f}] ---\n{content}"
            )

        return "\n\n".join(parts)

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
