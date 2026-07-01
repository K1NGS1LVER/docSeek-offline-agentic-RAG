import re
from typing import List, Tuple
from bs4 import BeautifulSoup

CHUNK_SIZE = 1000  # Characters per chunk (~200 tokens, well under mpnet's 384)
CHUNK_OVERLAP = 150  # Overlap between chunks

def chunk_text(
    text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP
) -> List[Tuple[str, int, int]]:
    """
    Split text into overlapping chunks with character positions.
    Returns list of (chunk_text, start_char, end_char) tuples.
    This prevents context loss at chunk boundaries.
    """
    if not text:
        return []
        
    if len(text) <= chunk_size:
        return [(text, 0, len(text))]

    chunks = []
    start = 0

    while start < len(text):
        end = min(start + chunk_size, len(text))
        original_end = end

        # Try to break at sentence boundary
        if end < len(text):
            search_start = max(0, chunk_size // 2) 
            text_slice = text[start:end]
            
            for punct in [". ", "! ", "? ", "\n\n"]:
                last_punct = text_slice.rfind(punct, search_start) 
                if last_punct != -1:
                    end = start + last_punct + len(punct)
                    break
            
        chunk = text[start:end].strip()
        if chunk:
            # Find actual positions after stripping
            chunk_start = text.find(chunk, start)
            chunk_end = chunk_start + len(chunk)
            chunks.append((chunk, chunk_start, chunk_end))

        next_start = end - overlap
        if next_start <= start:
            next_start = start + max(1, chunk_size - overlap)
            
        start = next_start

    return chunks

def parse_markdown(content: str) -> str:
    """Clean markdown content"""
    # Remove front matter (YAML)
    content = re.sub(r"^---\n.*?\n---\n", "", content, flags=re.DOTALL)
    return content

def parse_html(content: str) -> str:
    """Parse HTML content and extract text"""
    soup = BeautifulSoup(content, "html.parser")
    for script in soup(["script", "style", "nav", "footer"]):
        script.decompose()
    return soup.get_text(separator="\n", strip=True)

def clean_text(content: str) -> str:
    """General text cleaning"""
    content = re.sub(r"\n{3,}", "\n\n", content)
    return content.strip()
