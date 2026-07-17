"""
Script to ingest open source documentation into the RAG system.
Supports: Markdown files, text files, HTML docs, and more.
"""

import requests
import os
import glob
from pathlib import Path
from typing import List
import time
from bs4 import BeautifulSoup
import re
import gc
import json

# ============================================================================
# CONFIGURATION
# ============================================================================

RAG_API_URL = "http://localhost:8000"
CHUNK_SIZE = 300  # Characters per chunk
CHUNK_OVERLAP = 50  # Overlap between chunks

# ============================================================================
# TEXT CHUNKING
# ============================================================================

def chunk_text(
    text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP
) -> List[str]:
    """
    Split text into overlapping chunks.
    This prevents context loss at chunk boundaries.
    """
    if not text:
        return []
        
    if len(text) <= chunk_size:
        return [text]

    chunks = []
    start = 0

    while start < len(text):
        end = min(start + chunk_size, len(text))

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
            chunks.append(chunk)

        next_start = end - overlap
        if next_start <= start:
            next_start = start + max(1, chunk_size - overlap)
            
        start = next_start

    return chunks

# ============================================================================
# FILE READERS
# ============================================================================

def read_markdown_file(filepath: str) -> str:
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    content = re.sub(r"^---\n.*?\n---\n", "", content, flags=re.DOTALL)
    return content

def read_text_file(filepath: str) -> str:
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        return f.read()

def read_html_file(filepath: str) -> str:
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        soup = BeautifulSoup(f.read(), "html.parser")
    for script in soup(["script", "style", "nav", "footer"]):
        script.decompose()
    return soup.get_text(separator="\n", strip=True)

def download_webpage(url: str) -> str:
    response = requests.get(url)
    response.raise_for_status()
    soup = BeautifulSoup(response.content, "html.parser")
    for script in soup(["script", "style", "nav", "footer", "header"]):
        script.decompose()
    return soup.get_text(separator="\n", strip=True)

# ============================================================================
# INGESTION FUNCTIONS
# ============================================================================

def ingest_text(text: str, metadata: str = None, notebook_id: str = None) -> dict:
    response = requests.post(
        f"{RAG_API_URL}/ingest",
        json={"text": text, "metadata": metadata, "notebook_id": notebook_id},
    )
    return response.json()

def ingest_file(filepath: str, notebook_id: str):
    print(f"Processing: {filepath}")

    ext = Path(filepath).suffix.lower()

    if ext in [".md", ".markdown"]:
        content = read_markdown_file(filepath)
    elif ext in [".txt", ".rst"]:
        content = read_text_file(filepath)
    elif ext in [".html", ".htm"]:
        content = read_html_file(filepath)
    else:
        print(f"  ⚠️  Skipping unsupported file type: {ext}")
        return 0

    content = re.sub(r"\n{3,}", "\n\n", content).strip()

    if not content:
        print(f"  ⚠️  Empty file, skipping")
        return 0

    chunks = chunk_text(content)
    print(f"  📄 Split into {len(chunks)} chunks")

    ingested = 0
    current_pos = 0

    for i, chunk in enumerate(chunks):
        start_char = content.find(chunk, current_pos)
        if start_char == -1:
            start_char = current_pos
        end_char = start_char + len(chunk)
        current_pos = end_char

        metadata = {
            "source_file": filepath,
            "source_type": ext.lstrip("."),
            "chunk_index": i + 1,
            "start_char": start_char,
            "end_char": end_char
        }

        try:
            ingest_text(chunk, json.dumps(metadata), notebook_id)
            ingested += 1
        except Exception as e:
            print(f"  ❌ Error ingesting chunk {i+1}: {e}")

    print(f"  ✅ Ingested {ingested}/{len(chunks)} chunks\n")
    return ingested

def ingest_directory(directory: str, pattern: str = "**/*.md", max_files: int = None, notebook_id: str = None):
    print(f"\n🔍 Scanning directory: {directory}")
    print(f"Pattern: {pattern}\n")

    files = glob.glob(os.path.join(directory, pattern), recursive=True)

    if not files:
        print("❌ No files found!")
        return

    if max_files:
        files = files[:max_files]
        print(f"Found {len(files)} files (limited to {max_files})\n")
    else:
        print(f"Found {len(files)} files\n")

    total_chunks = 0
    failed_files = 0
    start_time = time.time()

    for idx, filepath in enumerate(files, 1):
        print(f"[{idx}/{len(files)}] ", end="")
        try:
            chunks = ingest_file(filepath, notebook_id)
            total_chunks += chunks
        except requests.exceptions.ConnectionError:
            print(f"  ❌ Cannot connect to RAG server at {RAG_API_URL}")
            return
        except Exception as e:
            print(f"  ❌ Failed: {e}")
            failed_files += 1

        time.sleep(0.05 if idx % 10 else 0.2)
        gc.collect()

    elapsed = time.time() - start_time
    print(f"\n{'='*60}")
    print(f"✅ COMPLETE")
    print(f"Files processed: {len(files) - failed_files}/{len(files)}")
    print(f"Total chunks ingested: {total_chunks}")
    print(f"Time elapsed: {elapsed:.2f}s")
    print(f"{'='*60}\n")

def ingest_urls(urls: List[str], notebook_id: str = None):
    print(f"\n🌐 Downloading {len(urls)} webpages\n")
    total_chunks = 0

    for url in urls:
        print(f"Processing: {url}")
        try:
            content = download_webpage(url)
            chunks = chunk_text(content)
            print(f"  📄 Split into {len(chunks)} chunks")

            current_pos = 0
            for i, chunk in enumerate(chunks):
                start_char = content.find(chunk, current_pos)
                if start_char == -1:
                    start_char = current_pos
                end_char = start_char + len(chunk)
                current_pos = end_char

                metadata = {
                    "source_file": url,
                    "source_type": "url",
                    "chunk_index": i + 1,
                    "start_char": start_char,
                    "end_char": end_char
                }

                ingest_text(chunk, json.dumps(metadata), notebook_id)
                total_chunks += 1

            print(f"  ✅ Ingested {len(chunks)} chunks\n")
            time.sleep(0.5)

        except Exception as e:
            print(f"  ❌ Error: {e}\n")

    print(f"\n✅ Total chunks ingested: {total_chunks}\n")

if __name__ == "__main__":
    import argparse

    print("\n" + "=" * 60)
    print("📚 RAG Documentation Ingestion Tool")
    print("=" * 60)

    parser = argparse.ArgumentParser(
        prog="python -m app.ingest",
        description="Bulk-ingest documentation into the RAG system.",
    )
    parser.add_argument("--notebook", required=True, help="Target notebook id")
    parser.add_argument("--url", help="Ingest a single webpage instead of a directory")
    parser.add_argument("directory", nargs="?", help="Directory to scan for files")
    parser.add_argument(
        "pattern", nargs="?", default="**/*.md", help="Glob pattern (default: **/*.md)"
    )
    parser.add_argument(
        "max_files", nargs="?", type=int, default=None, help="Limit number of files"
    )
    args = parser.parse_args()

    if args.url:
        ingest_urls([args.url], args.notebook)
    elif args.directory:
        ingest_directory(args.directory, args.pattern, args.max_files, args.notebook)
    else:
        parser.error("either --url or a directory must be given")
