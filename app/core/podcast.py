"""
NotebookLM-style audio overview: a two-host podcast generated from selected
sources, orchestrated as a LangGraph graph.

This is the first real payoff of the Phase 1 LangGraph adoption: a second graph
that reuses the same local-first building blocks (SQLite for content, the local
Ollama model for text, local Kokoro TTS for audio).

    gather -> outline -> script -> synthesize -> END
    (any node may short-circuit straight to END by setting an error)

Nodes:
- gather:     pull all chunks for the selected sources from SQLite and assemble
              a context block (best-effort length cap for the small local model).
- outline:    LLM writes an episode title + a handful of talking points.
- script:     LLM turns each talking point into a short A/B host dialogue.
- synthesize: Kokoro renders each turn to audio (host A / host B voices),
              concatenated with short gaps, written to data/audio/<job_id>.wav
              plus a JSON metadata sidecar.

Unlike the retrieval agent this has no heuristic fallback: generating a coherent
script genuinely needs the LLM, and TTS needs the model, so if either is
unavailable the job fails with a clear error status (surfaced via polling).
"""

import json
import logging
import time
from typing import Any, Callable, Dict, List, Optional, TypedDict

import numpy as np
import soundfile as sf
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from . import database, tts
from .config import AUDIO_DIR
from .llm import OllamaLLM

logger = logging.getLogger(__name__)

# Bounds tuned for a small local model: enough for a listenable overview
# without overrunning phi3:mini's context or taking too long.
MAX_TALKING_POINTS = 5
MAX_CONTEXT_CHARS = 6000
GAP_SECONDS = 0.35  # silence inserted between spoken turns

OUTLINE_SYSTEM = """You are the producer of a two-host explainer podcast.
Given source material, plan one short episode. Respond with ONLY a JSON object:
{
  "title": <a catchy, specific episode title, max 8 words>,
  "talking_points": [<3 to 5 SHORT phrases (max 10 words each), one distinct topic each, in a sensible order>]
}
Keep the talking points terse -- they are section labels, not sentences."""

SCRIPT_SYSTEM = """You are scripting a lively two-host podcast about the provided source material.
Host A is a curious guide who asks questions; Host B is the knowledgeable expert who explains.
Write natural, conversational spoken dialogue for ONE talking point -- no headings, no stage directions, no markdown, just what each host says aloud.
Ground every claim in the source material; do not invent facts.
Respond with ONLY a JSON object:
{
  "turns": [
    {"speaker": "A" | "B", "text": <one spoken line, 1-3 sentences>},
    ...
  ]
}
Use 4 to 6 turns, alternating speakers, starting with A."""


class PodcastState(TypedDict, total=False):
    job_id: str
    source_files: List[str]
    context: str
    title: str
    talking_points: List[str]
    turns: List[Dict[str, str]]
    audio_path: str
    duration: float
    error: str


def _assemble_context(source_files: List[str]) -> str:
    """Pull every chunk for the selected sources, ordered, and join into one
    context block capped at MAX_CONTEXT_CHARS."""
    ids = database.get_ids_for_sources(source_files)
    if not ids:
        return ""
    docs = database.fetch_documents_by_ids(ids)

    def _sort_key(d: Dict[str, Any]):
        meta = {}
        if d.get("metadata"):
            try:
                meta = json.loads(d["metadata"])
            except Exception:
                meta = {}
        return (meta.get("source_file", ""), meta.get("chunk_index", 0))

    docs.sort(key=_sort_key)
    parts, total = [], 0
    for d in docs:
        content = d.get("content", "")
        if not content:
            continue
        parts.append(content)
        total += len(content)
        if total >= MAX_CONTEXT_CHARS:
            break
    return "\n\n".join(parts)[:MAX_CONTEXT_CHARS]


class PodcastGraph:
    """Owns a compiled podcast graph bound to one LLM client."""

    def __init__(self, llm: OllamaLLM):
        self.llm = llm
        self._graph = self._build()

    # ------------------------------------------------------------- nodes

    async def _gather_node(self, state: PodcastState) -> Dict[str, Any]:
        writer = get_stream_writer()
        writer({"stage": "gather", "message": "Gathering source material…", "progress": 5})
        context = _assemble_context(state["source_files"])
        if not context.strip():
            return {"error": "No content found for the selected sources."}
        return {"context": context}

    async def _outline_node(self, state: PodcastState) -> Dict[str, Any]:
        if state.get("error"):
            return {}
        writer = get_stream_writer()
        writer({"stage": "outline", "message": "Outlining the episode…", "progress": 20})
        raw = await self.llm.complete_json(
            OUTLINE_SYSTEM,
            f"Source material:\n{state['context']}",
            max_tokens=800,
        )
        if not isinstance(raw, dict):
            return {"error": "The local LLM is unavailable or returned no outline. "
                             "Is Ollama running with the configured model pulled?"}
        title = str(raw.get("title") or "Audio Overview").strip()[:120]
        points = raw.get("talking_points")
        if isinstance(points, list):
            points = [
                str(p).strip()
                for p in points
                if p is not None and str(p).strip().lower() not in ("", "none", "null")
            ][:MAX_TALKING_POINTS]
        else:
            points = []
        if not points:
            return {"error": "The LLM did not produce any talking points to discuss."}
        return {"title": title, "talking_points": points}

    async def _script_node(self, state: PodcastState) -> Dict[str, Any]:
        if state.get("error"):
            return {}
        writer = get_stream_writer()
        points = state["talking_points"]
        turns: List[Dict[str, str]] = [
            {"speaker": "A", "text": f"Welcome to your audio overview: {state['title']}."}
        ]
        for i, point in enumerate(points):
            writer({
                "stage": "script",
                "message": f"Writing segment {i + 1} of {len(points)}: {point}",
                "progress": 25 + int(35 * (i / max(len(points), 1))),
            })
            raw = await self.llm.complete_json(
                SCRIPT_SYSTEM,
                f"Talking point: {point}\n\nSource material:\n{state['context']}",
                max_tokens=1000,
            )
            if isinstance(raw, dict) and isinstance(raw.get("turns"), list):
                for t in raw["turns"]:
                    if not isinstance(t, dict):
                        continue
                    # `or ""` (not a default arg) so an explicit null value from
                    # the model doesn't become the literal string "None".
                    speaker = "B" if str(t.get("speaker") or "").upper().startswith("B") else "A"
                    text = str(t.get("text") or "").strip()
                    if text:
                        turns.append({"speaker": speaker, "text": text})
        turns.append({"speaker": "B", "text": "That's it for this overview. Thanks for listening."})
        # Need more than the templated intro/outro to count as a real script.
        if len(turns) <= 2:
            return {"error": "The LLM did not produce any usable dialogue."}
        return {"turns": turns}

    async def _synthesize_node(self, state: PodcastState) -> Dict[str, Any]:
        if state.get("error"):
            return {}
        writer = get_stream_writer()
        writer({"stage": "synthesize", "message": "Generating audio…", "progress": 65})
        if not tts.is_available():
            return {"error": "Local text-to-speech (Kokoro) is unavailable. "
                             "Check server logs; the model downloads once on first use."}

        gap = np.zeros(int(GAP_SECONDS * tts.SAMPLE_RATE), dtype=np.float32)
        segments: List[np.ndarray] = []
        turns = state["turns"]
        for i, turn in enumerate(turns):
            voice = tts.VOICE_A if turn["speaker"] == "A" else tts.VOICE_B
            audio = tts.synthesize(turn["text"], voice)
            if audio is None:
                # Model became unavailable mid-run; can't recover this job.
                return {"error": "Text-to-speech model became unavailable."}
            if audio.size:
                segments.append(audio)
                segments.append(gap)
            # An empty clip means this turn was unsynthesizable; it's already
            # been skipped, so the episode continues with the remaining turns.
            writer({
                "stage": "synthesize",
                "message": f"Voicing turn {i + 1} of {len(turns)}…",
                "progress": 65 + int(30 * ((i + 1) / len(turns))),
            })

        if not segments:
            return {"error": "No audio could be synthesized from the script."}
        waveform = np.concatenate(segments)
        duration = round(len(waveform) / tts.SAMPLE_RATE, 2)

        audio_path = str(AUDIO_DIR / f"{state['job_id']}.wav")
        sf.write(audio_path, waveform, tts.SAMPLE_RATE)
        writer({"stage": "done", "message": "Episode ready.", "progress": 100})
        return {"audio_path": audio_path, "duration": duration}

    # ------------------------------------------------------------- edges

    @staticmethod
    def _continue(state: PodcastState) -> str:
        """Short-circuit straight to END as soon as any node records an error."""
        return END if state.get("error") else "continue"

    def _build(self):
        g = StateGraph(PodcastState)
        g.add_node("gather", self._gather_node)
        g.add_node("outline", self._outline_node)
        g.add_node("script", self._script_node)
        g.add_node("synthesize", self._synthesize_node)

        g.add_edge(START, "gather")
        g.add_conditional_edges("gather", self._continue, {"continue": "outline", END: END})
        g.add_conditional_edges("outline", self._continue, {"continue": "script", END: END})
        g.add_conditional_edges("script", self._continue, {"continue": "synthesize", END: END})
        g.add_edge("synthesize", END)
        return g.compile()

    async def run(
        self,
        job_id: str,
        source_files: List[str],
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """Drive the graph, forwarding node progress to on_progress; returns the
        final state (with either audio_path or error set)."""
        initial: PodcastState = {"job_id": job_id, "source_files": source_files}
        final_state: Dict[str, Any] = {}
        async for mode, chunk in self._graph.astream(
            initial, stream_mode=["custom", "values"]
        ):
            if mode == "custom" and on_progress:
                on_progress(chunk)
            elif mode == "values":
                final_state = chunk
        return final_state


async def generate_podcast(
    job_id: str,
    source_files: List[str],
    on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """Generate one podcast episode end to end.

    Creates its own LLM client (so it is safe to run inside a background
    worker's private event loop), runs the graph, writes a JSON metadata
    sidecar next to the WAV, and returns a job-result dict.
    """
    llm = OllamaLLM()
    graph = PodcastGraph(llm)
    try:
        state = await graph.run(job_id, source_files, on_progress)
    except Exception as e:  # unexpected failure -> clean error status
        logger.error(f"Podcast job {job_id} crashed: {e}", exc_info=True)
        return {"status": "failed", "error": str(e)}

    if state.get("error"):
        return {"status": "failed", "error": state["error"]}

    meta = {
        "job_id": job_id,
        "title": state.get("title", "Audio Overview"),
        "source_files": source_files,
        "turns": state.get("turns", []),
        "duration": state.get("duration", 0.0),
        "audio_file": f"{job_id}.wav",
        "created_at": time.time(),
    }
    sidecar = AUDIO_DIR / f"{job_id}.json"
    sidecar.write_text(json.dumps(meta, indent=2))
    logger.info(f"✅ Podcast {job_id} ready: '{meta['title']}' ({meta['duration']}s)")
    return {"status": "completed", **meta, "audio_path": state.get("audio_path")}


def list_episodes() -> List[Dict[str, Any]]:
    """All generated episodes, newest first, from the JSON sidecars in AUDIO_DIR."""
    episodes = []
    for sidecar in AUDIO_DIR.glob("*.json"):
        try:
            meta = json.loads(sidecar.read_text())
        except Exception:
            continue
        wav = AUDIO_DIR / meta.get("audio_file", "")
        if not wav.exists():
            continue
        episodes.append({
            "job_id": meta.get("job_id"),
            "title": meta.get("title"),
            "source_files": meta.get("source_files", []),
            "duration": meta.get("duration", 0.0),
            "created_at": meta.get("created_at", 0.0),
            "turns": len(meta.get("turns", [])),
        })
    episodes.sort(key=lambda e: e.get("created_at", 0.0), reverse=True)
    return episodes
