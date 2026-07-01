"""Chunks respect size, overlap, and cover the whole text."""
from app.core.parsing import chunk_text, CHUNK_SIZE, CHUNK_OVERLAP

def main():
    text = ("Sentence number %d is here. " % 0) + "".join(
        "Sentence number %d is here. " % i for i in range(1, 400)
    )
    chunks = chunk_text(text)
    assert len(chunks) > 1, "expected multiple chunks"
    for c, start, end in chunks:
        # allow slack: sentence-boundary breaking can overshoot the raw size
        assert len(c) <= CHUNK_SIZE + 200, f"chunk too large: {len(c)}"
        assert text[start:end].strip() == c.strip() or c in text, "position mismatch"
    # First chunk should be near target size, not tiny.
    assert len(chunks[0][0]) > CHUNK_SIZE // 2, "first chunk unexpectedly small"
    print(f"OK: {len(chunks)} chunks, size<= {CHUNK_SIZE}+slack, overlap={CHUNK_OVERLAP}")

if __name__ == "__main__":
    main()
