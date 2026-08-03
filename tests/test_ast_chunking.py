import pytest
from app.core.ast_chunking import ast_chunk_document

def test_ast_chunk_markdown_table_preserved():
    text = (
        "# Header\n\n"
        "Here is a table:\n\n"
        "| Header 1 | Header 2 |\n"
        "| --- | --- |\n"
        "| Row 1 Col 1 | Row 1 Col 2 |\n"
        "| Row 2 Col 1 | Row 2 Col 2 |\n"
        "| Row 3 Col 1 | Row 3 Col 2 |\n\n"
        "Some concluding text.\n"
    )
    chunks = ast_chunk_document(text, filename="test.md", max_chunk_size=150)
    
    table_header = "| Header 1 | Header 2 |"
    table_chunks = [c for c in chunks if table_header in c[0]]
    assert len(table_chunks) == 1
    chunk_text, start, end = table_chunks[0]
    assert "| Row 3 Col 2 |" in chunk_text
    assert text[start:end] == chunk_text

def test_ast_chunk_fenced_code_block():
    text = (
        "Some introduction text.\n\n"
        "```python\n"
        "def hello_world():\n"
        "    print('Hello, world!')\n"
        "    return True\n"
        "```\n\n"
        "Some concluding text after code block.\n"
    )
    chunks = ast_chunk_document(text, filename="script.md", max_chunk_size=150)
    
    code_chunks = [c for c in chunks if "def hello_world():" in c[0]]
    assert len(code_chunks) == 1
    chunk_text, start, end = code_chunks[0]
    assert "```python" in chunk_text
    assert "```" in chunk_text
    assert text[start:end] == chunk_text
