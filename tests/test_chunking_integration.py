"""
Integration tests for AST chunking strategy registration and auto profiling.
"""

from app.core.chunking import STRATEGIES, profile_document, chunk_document


def test_ast_strategy_registered():
    """Verify 'ast' is registered in STRATEGIES tuple."""
    assert "ast" in STRATEGIES


def test_profile_document_selects_ast_for_code_or_tables():
    """Verify profile_document returns 'ast' when >30% lines are code or tables."""
    lines = [
        "| Header 1 | Header 2 |",
        "| --- | --- |",
        "| Cell 1 | Cell 2 |",
        "| Cell 3 | Cell 4 |",
        "Some regular prose here that describes the table above.",
        "Another sentence of regular text.",
    ]
    doc = "\n".join(lines)
    assert profile_document(doc) == "ast"


def test_chunk_document_with_ast_strategy():
    """Verify chunk_document executes 'ast' strategy correctly."""
    doc = (
        "# Title\n\n"
        "| Col1 | Col2 |\n"
        "| --- | --- |\n"
        "| Val1 | Val2 |\n\n"
        "```python\ndef hello():\n    print('world')\n```\n"
    )
    chunks, strategy_used = chunk_document(doc, strategy="ast")
    assert strategy_used == "ast"
    assert len(chunks) > 0
    # Ensure text faithfully matches slice
    for piece, start, end in chunks:
        assert doc[start:end] == piece
