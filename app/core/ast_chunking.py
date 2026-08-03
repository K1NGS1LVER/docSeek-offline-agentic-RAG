"""
AST-aware document chunking strategy for Markdown and code files.

Prevents breaking Markdown tables, fenced code blocks, and section/function definitions
across chunk boundaries.
"""

import re
from typing import List, Tuple

Chunk = Tuple[str, int, int]


def _find_atomic_ranges(text: str) -> List[Tuple[int, int, str]]:
    """
    Find ranges in text that should be treated as atomic AST blocks.
    Returns list of (start_char, end_char, block_type) sorted by start_char.
    """
    ranges: List[Tuple[int, int, str]] = []

    # 1. Fenced code blocks
    code_block_pattern = re.compile(r"```[^\n]*\n.*?```|~~~[^\n]*\n.*?~~~", re.DOTALL)
    for m in code_block_pattern.finditer(text):
        ranges.append((m.start(), m.end(), "code_block"))

    # Helper to check if range overlaps with existing atomic ranges
    def is_overlapping(start: int, end: int) -> bool:
        for s, e, _ in ranges:
            if max(start, s) < min(end, e):
                return True
        return False

    # 2. Markdown tables outside code blocks
    # Table lines start and end with '|' (ignoring whitespace)
    table_pattern = re.compile(r"(?:^[ \t]*\|[^\n]*\|[ \t]*(?:\n|$))+", re.MULTILINE)
    for m in table_pattern.finditer(text):
        if not is_overlapping(m.start(), m.end()):
            ranges.append((m.start(), m.end(), "table"))

    # Sort ranges by start position
    ranges.sort(key=lambda r: r[0])
    return ranges


def _segment_text_into_blocks(text: str) -> List[Tuple[int, int, str]]:
    """
    Segment the text into non-overlapping AST block ranges covering the full text.
    """
    if not text:
        return []

    atomic_ranges = _find_atomic_ranges(text)
    blocks: List[Tuple[int, int, str]] = []
    curr = 0

    for start, end, btype in atomic_ranges:
        if curr < start:
            # Segment intermediate text by headers or paragraph breaks
            _segment_subtext(text, curr, start, blocks)
        blocks.append((start, end, btype))
        curr = end

    if curr < len(text):
        _segment_subtext(text, curr, len(text), blocks)

    return blocks


def _segment_subtext(text: str, start: int, end: int, blocks: List[Tuple[int, int, str]]) -> None:
    """
    Subsegment non-atomic text between start and end by markdown headers or paragraphs.
    """
    subtext = text[start:end]
    # Header or paragraph pattern: headers (#), or double newlines
    header_or_para_pattern = re.compile(r"(?:^[ \t]*#{1,6}\s+[^\n]*(?:\n|$))|(?:\n\s*\n)", re.MULTILINE)
    
    curr = start
    for m in header_or_para_pattern.finditer(text[start:end]):
        m_start = start + m.start()
        m_end = start + m.end()

        if m_start > curr:
            blocks.append((curr, m_start, "prose"))
        blocks.append((m_start, m_end, "separator_or_header"))
        curr = m_end

    if curr < end:
        blocks.append((curr, end, "prose"))


def ast_chunk_document(
    text: str,
    filename: str = "",
    max_chunk_size: int = 1000,
) -> List[Chunk]:
    """
    Chunk document preserving AST boundaries (Markdown tables, code blocks, headers).

    Returns List[Tuple[str, int, int]] representing (chunk_text, start_char, end_char).
    """
    if not text:
        return []

    blocks = _segment_text_into_blocks(text)
    if not blocks:
        return []

    chunks: List[Chunk] = []
    
    current_start = -1
    current_end = -1

    for b_start, b_end, b_type in blocks:
        if current_start == -1:
            current_start = b_start
            current_end = b_end
            continue

        potential_len = b_end - current_start
        if potential_len <= max_chunk_size:
            current_end = b_end
        else:
            # Flush current chunk
            piece = text[current_start:current_end]
            stripped_piece = piece.strip()
            if stripped_piece:
                p_start = text.find(stripped_piece, current_start)
                chunks.append((stripped_piece, p_start, p_start + len(stripped_piece)))
            current_start = b_start
            current_end = b_end

    if current_start != -1:
        piece = text[current_start:current_end]
        stripped_piece = piece.strip()
        if stripped_piece:
            p_start = text.find(stripped_piece, current_start)
            chunks.append((stripped_piece, p_start, p_start + len(stripped_piece)))

    return chunks
