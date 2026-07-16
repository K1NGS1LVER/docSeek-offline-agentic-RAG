"""
Chunking strategies for document ingestion.

Three strategies, all fully local:
- "recursive": character-budget splitting on sentence/paragraph boundaries
  (delegates to parsing.chunk_text, the original docSeek splitter).
- "semantic": embedding-based topic segmentation. Sentences are embedded with
  the same local model used for retrieval; a chunk boundary is placed wherever
  the similarity between adjacent sentence windows drops sharply, so chunks
  follow topic shifts instead of a fixed character count.
- "auto": profiles the document and picks a strategy per document.

Every strategy returns List[(chunk_text, start_char, end_char)] — the same
contract as parsing.chunk_text — so ingestion code is strategy-agnostic.
"""

import re
import logging
from typing import Callable, List, Optional, Tuple

import numpy as np

from .parsing import chunk_text as _recursive_chunk_text, CHUNK_SIZE, CHUNK_OVERLAP

logger = logging.getLogger(__name__)

Chunk = Tuple[str, int, int]

STRATEGIES = ("auto", "recursive", "semantic")

# Semantic chunking knobs.
SEMANTIC_MIN_CHUNK_CHARS = 200   # merge forward until at least this size
SEMANTIC_MAX_CHUNK_CHARS = 1600  # hard cap; overflowing chunks are re-split recursively
SEMANTIC_BREAKPOINT_PERCENTILE = 80  # distance percentile that counts as a topic shift
SEMANTIC_MIN_SENTENCES = 6       # below this, semantic segmentation is meaningless

_SENTENCE_RE = re.compile(r".+?(?:[.!?][\"')\]]?\s+|\n{2,}|$)", re.DOTALL)


def _split_sentences(text: str) -> List[Tuple[str, int, int]]:
    """Split text into sentences with (sentence, start, end) positions."""
    sentences = []
    for m in _SENTENCE_RE.finditer(text):
        raw = m.group(0)
        stripped = raw.strip()
        if not stripped:
            continue
        start = m.start() + (len(raw) - len(raw.lstrip()))
        sentences.append((stripped, start, start + len(stripped)))
    return sentences


def recursive_chunk(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[Chunk]:
    """Original recursive character splitter (sentence-boundary aware)."""
    return _recursive_chunk_text(text, chunk_size=chunk_size, overlap=overlap)


def semantic_chunk(
    text: str,
    embed_fn: Callable[[List[str]], np.ndarray],
    breakpoint_percentile: int = SEMANTIC_BREAKPOINT_PERCENTILE,
) -> List[Chunk]:
    """Topic-shift chunking: boundaries where adjacent sentence embeddings diverge.

    embed_fn: batch embedding function returning L2-normalized vectors
    (VectorEngine.embed_batch). Falls back to recursive splitting when the
    document is too short to segment meaningfully.
    """
    sentences = _split_sentences(text)
    if len(sentences) < SEMANTIC_MIN_SENTENCES:
        return recursive_chunk(text)

    try:
        embeddings = embed_fn([s[0] for s in sentences])
    except Exception as e:
        logger.warning(f"Semantic chunking embed failed ({e}); falling back to recursive.")
        return recursive_chunk(text)

    if embeddings is None or len(embeddings) != len(sentences):
        return recursive_chunk(text)

    # Cosine distance between consecutive sentences (vectors are normalized).
    sims = np.sum(embeddings[:-1] * embeddings[1:], axis=1)
    distances = 1.0 - sims
    threshold = float(np.percentile(distances, breakpoint_percentile))

    # Boundary after sentence i when distance(i, i+1) exceeds the threshold.
    boundaries = {i for i, d in enumerate(distances) if d > threshold}

    chunks: List[Chunk] = []
    group_start_idx = 0
    for i in range(len(sentences)):
        is_last = i == len(sentences) - 1
        group_char_len = sentences[i][2] - sentences[group_start_idx][1]
        boundary_here = (i in boundaries and group_char_len >= SEMANTIC_MIN_CHUNK_CHARS)
        if is_last or boundary_here or group_char_len >= SEMANTIC_MAX_CHUNK_CHARS:
            start = sentences[group_start_idx][1]
            end = sentences[i][2]
            piece = text[start:end].strip()
            if piece:
                piece_start = text.find(piece, start)
                chunks.append((piece, piece_start, piece_start + len(piece)))
            group_start_idx = i + 1

    # Re-split any chunk that still exceeds the cap (long unbroken sections).
    final: List[Chunk] = []
    for piece, start, end in chunks:
        if len(piece) > SEMANTIC_MAX_CHUNK_CHARS:
            for sub, sub_start, sub_end in recursive_chunk(piece):
                final.append((sub, start + sub_start, start + sub_end))
        else:
            final.append((piece, start, end))
    return final if final else recursive_chunk(text)


def profile_document(text: str) -> str:
    """Heuristically pick the best strategy for a document ("auto" mode).

    - Short documents: recursive (semantic segmentation needs enough sentences).
    - Code-heavy or table-heavy content: recursive (embeddings of code lines
      produce noisy boundaries).
    - Prose and structured docs: semantic.
    """
    if len(text) < 1200:
        return "recursive"

    lines = text.splitlines() or [text]
    code_ish = sum(
        1
        for ln in lines
        if ln.startswith(("    ", "\t", "|", "```")) or re.match(r"^\s*[{}<>#/;]", ln)
    )
    if code_ish / len(lines) > 0.4:
        return "recursive"

    sentence_count = len(_split_sentences(text))
    if sentence_count < SEMANTIC_MIN_SENTENCES:
        return "recursive"

    return "semantic"


def chunk_document(
    text: str,
    strategy: str = "auto",
    embed_fn: Optional[Callable[[List[str]], np.ndarray]] = None,
) -> Tuple[List[Chunk], str]:
    """Chunk with the requested strategy. Returns (chunks, strategy_used).

    "auto" resolves to a concrete strategy per document. Semantic chunking
    requires embed_fn; without it, falls back to recursive.
    """
    if strategy not in STRATEGIES:
        raise ValueError(f"Unknown chunking strategy: {strategy!r} (expected one of {STRATEGIES})")

    resolved = profile_document(text) if strategy == "auto" else strategy

    if resolved == "semantic":
        if embed_fn is None:
            logger.warning("Semantic chunking requested without embed_fn; using recursive.")
            resolved = "recursive"
        else:
            chunks = semantic_chunk(text, embed_fn)
            return chunks, "semantic"

    return recursive_chunk(text), "recursive"


if __name__ == "__main__":
    # Self-check with a fake embedder: two topics -> expect a boundary between them.
    topic_a = "The cat sat on the mat. Cats love warm places. A cat sleeps a lot. Felines purr when happy. "
    topic_b = "Quantum computers use qubits. Superposition enables parallelism. Entanglement links qubits. Decoherence is the enemy. "
    text = (topic_a * 3 + topic_b * 3).strip()

    def fake_embed(sentences):
        vecs = []
        for s in sentences:
            v = np.array([1.0, 0.0] if "cat" in s.lower() or "feline" in s.lower() or "purr" in s.lower() else [0.0, 1.0])
            vecs.append(v)
        return np.array(vecs)

    chunks, used = chunk_document(text, "semantic", embed_fn=fake_embed)
    assert used == "semantic"
    assert len(chunks) >= 2, chunks
    # Positions must be faithful to the source text.
    for piece, start, end in chunks:
        assert text[start:end] == piece
    assert profile_document("short") == "recursive"
    prose = ("This is a sentence about something interesting. " * 60)
    assert profile_document(prose) == "semantic"
    chunks2, used2 = chunk_document(prose, "auto", embed_fn=None)
    assert used2 == "recursive"  # no embed_fn -> fallback
    print(f"OK: semantic chunking produced {len(chunks)} chunks, positions faithful")
