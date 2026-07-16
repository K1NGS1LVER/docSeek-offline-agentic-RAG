"""
Local cross-encoder reranker.

A cross-encoder scores each (query, chunk) pair jointly, which is far more
accurate than bi-encoder cosine similarity — at the cost of one forward pass
per candidate. The agent applies it selectively on the retrieved candidate
set, so the cost stays bounded (k pairs, not corpus-sized).

Runs entirely on-device via sentence-transformers. The model weights are
downloaded once from HuggingFace (same as the embedding model) and cached
locally; after that no network access is needed.
"""

import logging
import threading
from typing import Dict, List

from .config import RERANK_MODEL

logger = logging.getLogger(__name__)

_model = None
_model_lock = threading.Lock()
_load_failed = False


def _get_model():
    """Lazy-load the cross-encoder on first use (thread-safe)."""
    global _model, _load_failed
    if _model is not None or _load_failed:
        return _model
    with _model_lock:
        if _model is not None or _load_failed:
            return _model
        try:
            from sentence_transformers import CrossEncoder

            logger.info(f"Loading reranker model: {RERANK_MODEL}...")
            _model = CrossEncoder(RERANK_MODEL)
            logger.info("Reranker loaded.")
        except Exception as e:
            logger.error(f"Failed to load reranker '{RERANK_MODEL}': {e}. Reranking disabled.")
            _load_failed = True
    return _model


def is_available() -> bool:
    """True if the reranker can be used (loads it on first call)."""
    return _get_model() is not None


def rerank(query: str, results: List[Dict]) -> List[Dict]:
    """Rescore results with the cross-encoder and sort best-first.

    Each result dict must have "content". Adds "rerank_score" to each result
    and keeps the original retrieval "score" untouched. On any failure the
    input order is returned unchanged.

    Single-item sets are scored too: ordering can't change, but callers rely
    on every reranked result carrying a "rerank_score".
    """
    if not results:
        return results
    model = _get_model()
    if model is None:
        return results

    try:
        pairs = [(query, r["content"]) for r in results]
        scores = model.predict(pairs, show_progress_bar=False)
        for r, s in zip(results, scores):
            r["rerank_score"] = float(s)
        return sorted(results, key=lambda r: r["rerank_score"], reverse=True)
    except Exception as e:
        logger.error(f"Reranking failed ({e}); keeping retrieval order.")
        return results
