"""
Local text-to-speech via Kokoro-82M.

Kokoro is a small, high-quality TTS model that runs on CPU (or MPS) in real
time. Like the embedder/reranker/STT models it downloads once from HuggingFace
(the model plus a spaCy English tokenizer for grapheme-to-phoneme) and then
runs fully offline -- no audio ever leaves the machine.

Lazy-loaded singleton in the style of app/core/reranker.py and stt.py: the
pipeline loads on first use, and is_available() reflects whether it can be used.

espeak-ng (brew install espeak-ng) improves pronunciation of out-of-vocabulary
words, but plain English works without it via the bundled spaCy fallback.
"""

import logging
import re
import threading
import unicodedata
from typing import Iterator, List, Optional

import numpy as np

from .config import TTS_VOICE_A, TTS_VOICE_B

logger = logging.getLogger(__name__)

# Kokoro always outputs 24 kHz mono audio.
SAMPLE_RATE = 24000

# The two-host podcast voices, exposed for callers/UI. Both are American
# English (the "a" lang_code); af_* female, am_* male.
VOICE_A = TTS_VOICE_A
VOICE_B = TTS_VOICE_B

_pipeline = None
_pipeline_lock = threading.Lock()
_load_failed = False


def _get_pipeline():
    """Lazy-load the Kokoro pipeline on first use (thread-safe)."""
    global _pipeline, _load_failed
    if _pipeline is not None or _load_failed:
        return _pipeline
    with _pipeline_lock:
        if _pipeline is not None or _load_failed:
            return _pipeline
        try:
            from kokoro import KPipeline

            logger.info("Loading Kokoro TTS pipeline (American English)...")
            # lang_code "a" = American English; matches the af_/am_ voices.
            _pipeline = KPipeline(lang_code="a")
            logger.info("Kokoro TTS pipeline loaded.")
        except Exception as e:
            logger.error(f"Failed to load Kokoro TTS: {e}. Podcast generation disabled.")
            _load_failed = True
    return _pipeline


def is_available() -> bool:
    """True if text-to-speech can be used (loads the pipeline on first call)."""
    return _get_pipeline() is not None


def warmup() -> None:
    """Pay the pipeline's cold-start cost eagerly (call once, off the request path).

    Loading the pipeline alone doesn't warm every code path (torch kernel
    selection, G2P caching, etc.), so we also synthesize a throwaway phrase.
    Never raises: a warmup failure just means the first real request pays the
    cost instead, same as before this existed.
    """
    pipeline = _get_pipeline()
    if pipeline is None:
        return
    try:
        _run(pipeline, "Ready.", VOICE_A)
    except Exception as e:
        logger.warning(f"TTS warmup synthesis failed (non-fatal): {e}")


def _sanitize(text: str) -> str:
    """Normalize text so the grapheme-to-phoneme step is less likely to choke.

    Kokoro's G2P (misaki) can fail on odd unicode or control characters; we
    normalize to NFKC (turning fancy quotes/dashes into plain ASCII where
    possible), drop control characters, and collapse whitespace.
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    text = "".join(ch for ch in text if ch == "\n" or unicodedata.category(ch)[0] != "C")
    return re.sub(r"\s+", " ", text).strip()


def _run(pipeline, text: str, voice: str) -> List[np.ndarray]:
    """Run the Kokoro pipeline for one text, returning float32 audio segments."""
    segments = []
    for _graphemes, _phonemes, audio in pipeline(text, voice=voice):
        arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
        segments.append(arr.astype(np.float32))
    return segments


def synthesize(text: str, voice: str) -> Optional[np.ndarray]:
    """Synthesize speech for one utterance, defensively.

    Returns a mono float32 waveform at SAMPLE_RATE, or None if TTS is
    unavailable (model not loaded). This never raises: if the G2P step chokes
    on a passage (e.g. an out-of-vocabulary token with no espeak-ng fallback),
    we retry sentence by sentence and skip only the offending sentence, so a
    single bad token can never crash a whole podcast job.
    """
    pipeline = _get_pipeline()
    if pipeline is None:
        return None
    text = _sanitize(text)
    if not text:
        return np.zeros(0, dtype=np.float32)

    try:
        segments = _run(pipeline, text, voice)
    except Exception as e:
        logger.warning(f"TTS failed for a passage ({e}); retrying sentence by sentence.")
        segments = []
        for sentence in re.split(r"(?<=[.!?])\s+", text):
            sentence = sentence.strip()
            if not sentence:
                continue
            try:
                segments.extend(_run(pipeline, sentence, voice))
            except Exception as e2:
                logger.warning(f"TTS skipped an unsynthesizable passage: {e2}")

    if not segments:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(segments)


def synthesize_stream(text: str, voice: str) -> Iterator[np.ndarray]:
    """Like synthesize(), but yields each mono float32 segment as it is produced.

    Kokoro's own pipeline() only splits on literal newlines and otherwise
    batches up to ~510 phonemes (several sentences) per yielded segment, so
    handing it a whole answer in one call would make the caller wait many
    seconds for the first chunk -- most of a short answer's total synthesis
    time. We split on sentence boundaries ourselves so the first segment is
    ready almost immediately; this also means a G2P failure only ever costs
    one sentence, with no risk of duplicate audio on retry.
    """
    pipeline = _get_pipeline()
    if pipeline is None:
        return
    text = _sanitize(text)
    if not text:
        return

    for sentence in re.split(r"(?<=[.!?])\s+", text):
        sentence = sentence.strip()
        if not sentence:
            continue
        try:
            for segment in _run(pipeline, sentence, voice):
                yield segment
        except Exception as e:
            logger.warning(f"TTS skipped an unsynthesizable passage: {e}")
