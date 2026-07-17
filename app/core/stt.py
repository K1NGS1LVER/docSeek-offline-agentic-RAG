"""
Local speech-to-text via faster-whisper (CTranslate2 Whisper).

Runs entirely on-device: the model weights are downloaded once from
HuggingFace (same as the embedder and reranker) and cached locally; after
that no network access is needed. faster-whisper bundles PyAV, so it decodes
whatever container the browser's MediaRecorder produces (webm/ogg/wav)
straight from a file path -- no ffmpeg subprocess required.

Lazy-loaded singleton in the style of app/core/reranker.py: the model loads
on first use, and is_available() reflects whether it can be used.
"""

import logging
import threading
from typing import Any, Dict, Optional

from .config import STT_MODEL

logger = logging.getLogger(__name__)

_model = None
_model_lock = threading.Lock()
_load_failed = False


def _get_model():
    """Lazy-load the Whisper model on first use (thread-safe)."""
    global _model, _load_failed
    if _model is not None or _load_failed:
        return _model
    with _model_lock:
        if _model is not None or _load_failed:
            return _model
        try:
            from faster_whisper import WhisperModel

            logger.info(f"Loading STT model: {STT_MODEL} (int8, CPU)...")
            # int8 on CPU is the CPU-friendly default; it downloads once, caches.
            _model = WhisperModel(STT_MODEL, device="cpu", compute_type="int8")
            logger.info("STT model loaded.")
        except Exception as e:
            logger.error(f"Failed to load STT model '{STT_MODEL}': {e}. Dictation disabled.")
            _load_failed = True
    return _model


def is_available() -> bool:
    """True if speech-to-text can be used (loads the model on first call)."""
    return _get_model() is not None


def transcribe(audio_path: str) -> Optional[Dict[str, Any]]:
    """Transcribe an audio file to text.

    Returns {"text", "language", "duration"} on success, or None if the model
    could not be loaded (callers should surface a clear "unavailable" error).
    Decodes the container itself via the bundled PyAV, so any MediaRecorder
    output (webm/ogg/wav) works from a plain file path.
    """
    model = _get_model()
    if model is None:
        return None

    segments, info = model.transcribe(audio_path, beam_size=5)
    # segments is a generator; materialize it to pull the full transcript.
    text = "".join(seg.text for seg in segments).strip()
    return {
        "text": text,
        "language": getattr(info, "language", None),
        "duration": round(float(getattr(info, "duration", 0.0)), 2),
    }
