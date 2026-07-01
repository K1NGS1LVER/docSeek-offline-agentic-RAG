import os
import pathlib
import logging
import json
import threading
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, File, UploadFile, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from sse_starlette.sse import EventSourceResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel
import uvicorn

from app.core.config import (
    MODEL_NAME,
    EMBEDDING_DIM,
    HOST,
    PORT,
    DB_PATH,
    INDEX_PATH,
    UPLOAD_DIR,
    MAX_UPLOAD_BYTES,
    CORS_ORIGINS,
    ADMIN_TOKEN,
)
from app.core import database, parsing
from app.core.engine import VectorEngine
from app.core.llm import OllamaLLM

try:
    from docx import Document

    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False

# ============================================================================
# LOGGING
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

if not DOCX_AVAILABLE:
    logger.warning("python-docx not available. .docx files will not be supported.")

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================


def _safe_upload_path(filename: str) -> tuple[str, pathlib.Path]:
    """Strip any directory components from a client-supplied filename and
    resolve it strictly inside UPLOAD_DIR. Raises 400 on empty/unsafe names."""
    safe_name = os.path.basename(filename or "")
    if not safe_name or safe_name in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid filename")
    dest = (pathlib.Path(UPLOAD_DIR) / safe_name).resolve()
    upload_root = pathlib.Path(UPLOAD_DIR).resolve()
    if upload_root not in dest.parents and dest != upload_root:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return safe_name, dest


def extract_text_from_docx(file_path: str) -> str:
    """Extract text from a .docx file"""
    if not DOCX_AVAILABLE:
        raise HTTPException(
            status_code=400,
            detail="Word document support not available. Install python-docx.",
        )

    try:
        doc = Document(file_path)
        paragraphs = [
            paragraph.text for paragraph in doc.paragraphs if paragraph.text.strip()
        ]
        return "\n\n".join(paragraphs)
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Failed to read Word document: {str(e)}"
        )


# ============================================================================
# PYDANTIC MODELS
# ============================================================================


class IngestRequest(BaseModel):
    text: str
    metadata: Optional[str] = None


class SearchRequest(BaseModel):
    query: str
    k: int = 5


class SearchResult(BaseModel):
    id: int
    score: float
    content: str
    source: Optional[Dict[str, Any]] = None


class DocumentViewResponse(BaseModel):
    file: str
    content: str
    highlight: Optional[Dict[str, int]] = None


class GitHubIngestRequest(BaseModel):
    repo_url: str
    subpath: Optional[str] = None


# ============================================================================
# LIFECYCLE
# ============================================================================

engine: Optional[VectorEngine] = None
llm: Optional[OllamaLLM] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    global engine, llm
    database.init_db()
    engine = VectorEngine()
    llm = OllamaLLM()

    # Auto-rebuild index if DB has documents but FAISS is empty
    db_count = database.get_document_count()
    faiss_count = engine.get_total_vectors()
    if db_count > 0 and faiss_count == 0:
        logger.info(
            f"Index is empty but DB has {db_count} documents. Rebuilding index..."
        )
        _rebuild_index()

    logger.info(
        f"System ready. Documents in DB: {database.get_document_count()}, "
        f"Vectors in FAISS: {engine.get_total_vectors()}"
    )
    yield
    # Shutdown
    if engine:
        engine.save()
        logger.info("Index saved.")


def _rebuild_index():
    """Rebuild FAISS index from all documents in the database"""
    global engine
    import faiss
    from app.core.config import EMBEDDING_DIM

    all_docs = database.get_all_documents()
    if not all_docs:
        logger.info("No documents to rebuild index from.")
        return 0

    # Create a fresh index
    base_index = faiss.IndexFlatIP(EMBEDDING_DIM)
    engine.index = faiss.IndexIDMap(base_index)

    # Batch embed all document contents
    texts = [doc["content"] for doc in all_docs]
    doc_ids = [doc["id"] for doc in all_docs]

    batch_size = 64
    for i in range(0, len(texts), batch_size):
        batch_texts = texts[i : i + batch_size]
        batch_ids = doc_ids[i : i + batch_size]
        embeddings = engine.embed_batch(batch_texts)
        engine.add_to_index(embeddings, doc_ids=batch_ids)

    engine.save()
    logger.info(f"\u2705 Index rebuilt with {len(all_docs)} documents.")
    return len(all_docs)


# ============================================================================
# FASTAPI APP
# ============================================================================

app = FastAPI(title="RAG Search System", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def require_admin(x_admin_token: Optional[str] = Header(None)):
    """Gate for destructive endpoints. No-op when ADMIN_TOKEN is unset."""
    if ADMIN_TOKEN and x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Admin token required")

# ============================================================================
# INGEST & SEARCH
# ============================================================================


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload and ingest a single document file (optimized with batch embedding)"""
    import time

    start_time = time.time()

    try:
        safe_name, file_path = _safe_upload_path(file.filename)
        content = await file.read()
        if len(content) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
            )

        with open(file_path, "wb") as f:
            f.write(content)

        # Parse based on file extension
        ext = os.path.splitext(safe_name)[1].lower()

        # Validate file type
        supported_extensions = [".txt", ".md", ".markdown", ".html", ".htm", ".docx"]
        if ext not in supported_extensions:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type: {ext}. Supported: {', '.join(supported_extensions)}",
            )

        # Extract text based on file type
        try:
            if ext == ".docx":
                # For .docx files, we need to extract from the saved file
                text_content = extract_text_from_docx(str(file_path))
            elif ext in [".txt", ".md", ".markdown"]:
                text_content = content.decode("utf-8", errors="replace")
                if ext in [".md", ".markdown"]:
                    text_content = parsing.parse_markdown(text_content)
            elif ext in [".html", ".htm"]:
                text_content = content.decode("utf-8", errors="replace")
                text_content = parsing.parse_html(text_content)
            else:
                text_content = content.decode("utf-8", errors="replace")
        except Exception as e:
            raise HTTPException(
                status_code=400, detail=f"Failed to extract text from file: {str(e)}"
            )

        # Chunk the content (returns tuples of (text, start_char, end_char))
        chunks = parsing.chunk_text(text_content)

        if not chunks:
            raise HTTPException(
                status_code=400, detail="No content could be extracted from file"
            )

        logger.info(f"Processing {safe_name}: {len(chunks)} chunks to embed...")

        # BATCH EMBED all chunks at once (MUCH faster than one-by-one)
        chunk_texts = [chunk_text for chunk_text, _, _ in chunks]

        embed_start = time.time()
        embeddings = await run_in_threadpool(engine.embed_batch, chunk_texts)
        embed_time = time.time() - embed_start
        logger.info(
            f"✅ Embedded {len(chunks)} chunks in {embed_time:.2f}s ({len(chunks) / embed_time:.0f} chunks/sec)"
        )

        # Insert all chunks with their embeddings
        doc_ids = []
        for i, ((chunk_text, start_char, end_char), embedding) in enumerate(
            zip(chunks, embeddings)
        ):
            metadata = json.dumps(
                {
                    "source_file": str(file_path),
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                    "filename": safe_name,
                    "start_char": start_char,
                    "end_char": end_char,
                }
            )

            doc_id = database.insert_document(chunk_text, metadata)
            doc_ids.append(doc_id)

        # Add all embeddings to index with their actual DB IDs
        engine.add_to_index(embeddings, doc_ids=doc_ids)
        engine.save()  # Persist index changes to disk

        elapsed = time.time() - start_time

        logger.info(
            f"✅ Successfully ingested {safe_name} ({len(chunks)} chunks) in {elapsed:.2f}s"
        )

        return {
            "status": "success",
            "filename": safe_name,
            "chunks": len(chunks),
            "doc_ids": doc_ids,
            "time_seconds": round(elapsed, 2),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading file: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/upload-multiple")
async def upload_multiple_files(files: list[UploadFile] = File(...)):
    """Upload and ingest multiple documents at once (optimized batch processing)"""
    import time

    start_time = time.time()

    results = []
    total_chunks = 0

    for file in files:
        try:
            safe_name, file_path = _safe_upload_path(file.filename)
            content = await file.read()
            if len(content) > MAX_UPLOAD_BYTES:
                results.append(
                    {
                        "filename": safe_name,
                        "status": "failed",
                        "error": f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
                    }
                )
                continue

            with open(file_path, "wb") as f:
                f.write(content)

            # Parse based on file extension
            ext = os.path.splitext(safe_name)[1].lower()

            # Validate file type
            supported_extensions = [
                ".txt",
                ".md",
                ".markdown",
                ".html",
                ".htm",
                ".docx",
            ]
            if ext not in supported_extensions:
                results.append(
                    {
                        "filename": safe_name,
                        "status": "failed",
                        "error": f"Unsupported file type: {ext}",
                    }
                )
                continue

            # Extract text based on file type
            try:
                if ext == ".docx":
                    text_content = extract_text_from_docx(str(file_path))
                elif ext in [".txt", ".md", ".markdown"]:
                    text_content = content.decode("utf-8", errors="replace")
                    if ext in [".md", ".markdown"]:
                        text_content = parsing.parse_markdown(text_content)
                elif ext in [".html", ".htm"]:
                    text_content = content.decode("utf-8", errors="replace")
                    text_content = parsing.parse_html(text_content)
                else:
                    text_content = content.decode("utf-8", errors="replace")
            except Exception as decode_error:
                results.append(
                    {
                        "filename": safe_name,
                        "status": "failed",
                        "error": f"Failed to decode: {str(decode_error)}",
                    }
                )
                continue

            # Chunk the content
            chunks = parsing.chunk_text(text_content)

            if not chunks:
                results.append(
                    {
                        "filename": safe_name,
                        "status": "failed",
                        "error": "No content could be extracted",
                    }
                )
                continue

            # Batch embed all chunks for this file
            chunk_texts = [chunk_text for chunk_text, _, _ in chunks]
            embeddings = await run_in_threadpool(engine.embed_batch, chunk_texts)

            # Insert all chunks with their embeddings
            doc_ids = []
            for i, ((chunk_text, start_char, end_char), embedding) in enumerate(
                zip(chunks, embeddings)
            ):
                metadata = json.dumps(
                    {
                        "source_file": str(file_path),
                        "chunk_index": i,
                        "total_chunks": len(chunks),
                        "filename": safe_name,
                        "start_char": start_char,
                        "end_char": end_char,
                    }
                )

                doc_id = database.insert_document(chunk_text, metadata)
                doc_ids.append(doc_id)

            # Add all embeddings to index with their actual DB IDs
            engine.add_to_index(embeddings, doc_ids=doc_ids)

            total_chunks += len(chunks)
            results.append(
                {"filename": safe_name, "status": "success", "chunks": len(chunks)}
            )

            logger.info(f"✅ Processed {safe_name} ({len(chunks)} chunks)")

        except Exception as e:
            logger.error(f"Error processing {file.filename}: {str(e)}")
            results.append(
                {"filename": file.filename, "status": "failed", "error": str(e)}
            )

        engine.save()  # Persist index changes to disk after batch completion
    elapsed = time.time() - start_time
    logger.info(
        f"✅ Batch upload complete: {len(files)} files, {total_chunks} total chunks in {elapsed:.2f}s"
    )


    return {
        "status": "complete",
        "files_processed": len(files),
        "total_chunks": total_chunks,
        "time_seconds": round(elapsed, 2),
        "results": results,
    }


@app.post("/ingest")
def ingest_document(request: IngestRequest):
    vector = engine.embed(request.text)
    doc_id = database.insert_document(request.text, request.metadata)
    engine.add_to_index(vector, doc_ids=[doc_id])
    engine.save()  # Persist index changes to disk
    return {"status": "success", "id": doc_id}



SIMILARITY_THRESHOLD = 0.20  # Minimum cosine similarity score to return a result


@app.post("/search", response_model=List[SearchResult])
def search(request: SearchRequest):
    if engine.get_total_vectors() == 0:
        return []

    query_vector = engine.embed(request.query)
    top_indices, scores = engine.search(query_vector, request.k)

    logger.info(
        f"Search '{request.query}' → top scores: {[f'{s:.4f}' for s in scores]}"
    )

    # top_indices now contains actual DB IDs (from IndexIDMap)
    valid_ids = [int(idx) for idx in top_indices if idx != -1]
    if not valid_ids:
        return []

    documents = database.fetch_documents_by_ids(valid_ids)
    doc_map = {doc["id"]: doc for doc in documents}

    results = []
    for idx, score in zip(top_indices, scores):
        if idx == -1:
            continue

        # Skip results below the similarity threshold
        if float(score) < SIMILARITY_THRESHOLD:
            continue

        doc_id = int(idx)
        if doc_id not in doc_map:
            continue

        doc = doc_map[doc_id]
        source_data = None

        if doc.get("metadata"):
            try:
                source_data = json.loads(doc["metadata"])
            except Exception:
                source_data = {"raw": doc["metadata"]}

        results.append(
            SearchResult(
                id=doc["id"],
                score=float(score),
                content=doc["content"],
                source=source_data,
            )
        )

    return results


# ============================================================================
# ASK (LLM-POWERED RAG)
# ============================================================================


class AskRequest(BaseModel):
    query: str
    k: int = 3


@app.post("/ask")
async def ask(request: AskRequest):
    """RAG endpoint: retrieve context from vector DB, then stream an LLM answer."""

    try:
        # 1. Retrieve relevant chunks (reuse search logic)
        if engine.get_total_vectors() == 0:

            async def empty_stream():
                yield json.dumps(
                    "No documents have been uploaded yet. Please upload some documents first."
                )

            return EventSourceResponse(empty_stream())

        query_vector = await run_in_threadpool(engine.embed, request.query)
        top_indices, scores = await run_in_threadpool(engine.search, query_vector, request.k)

        valid_ids = [int(idx) for idx in top_indices if idx != -1]
        documents = database.fetch_documents_by_ids(valid_ids) if valid_ids else []
        doc_map = {doc["id"]: doc for doc in documents}

        # Build search results for LLM context
        search_results = []
        for idx, score in zip(top_indices, scores):
            if idx == -1 or float(score) < SIMILARITY_THRESHOLD:
                continue
            doc_id = int(idx)
            if doc_id not in doc_map:
                continue
            doc = doc_map[doc_id]
            source_data = None
            if doc.get("metadata"):
                try:
                    source_data = json.loads(doc["metadata"])
                except Exception:
                    source_data = {"raw": doc["metadata"]}
            search_results.append(
                {
                    "content": doc["content"],
                    "score": float(score),
                    "source": source_data,
                }
            )

        if not search_results:

            async def no_results_stream():
                yield json.dumps(
                    "I couldn't find any relevant information in the uploaded documents for your query."
                )

            return EventSourceResponse(no_results_stream())

        # 2. Build context and stream LLM response
        context = llm.build_context(search_results)

        logger.info(
            f"ASK '{request.query}' → {len(search_results)} chunks, streaming LLM response..."
        )

        async def llm_stream():
            try:
                async for chunk in llm.stream_answer(request.query, context):
                    yield json.dumps(chunk)
            except Exception as stream_err:
                logger.error(f"LLM streaming error: {stream_err}")
                yield json.dumps(f"\n\n⚠️ Error during LLM response: {str(stream_err)}")

        return EventSourceResponse(llm_stream())


    except Exception as e:
        logger.error(f"ASK endpoint error: {e}")

        async def error_stream():
            yield json.dumps(f"⚠️ Server error: {str(e)}")

        return EventSourceResponse(error_stream())


# ============================================================================
# DOCUMENT VIEW
# ============================================================================


@app.get("/document/view", response_class=HTMLResponse)
def view_document(
    id: int = Query(..., description="Document chunk ID from the database"),
):
    """View the FULL original document, with the clicked chunk highlighted.

    Given a chunk id, we find all sibling chunks that belong to the same
    source file, sort them by chunk_index, concatenate their content, and
    highlight the chunk that was clicked.
    """
    import html as html_module

    # 1. Fetch the target chunk
    doc = database.fetch_document_by_id(id)
    if doc is None:
        logger.warning(f"Document view: id={id} not found in database")
        raise HTTPException(status_code=404, detail=f"Document with id={id} not found")

    # 2. Parse metadata to find sibling chunks
    filename = f"Document (chunk #{id})"
    source_file = None
    target_chunk_index = None
    total_chunks = None
    github_repo = None

    if doc.get("metadata"):
        try:
            meta = json.loads(doc["metadata"])
            filename = meta.get("filename", filename)
            source_file = meta.get("source_file")
            target_chunk_index = meta.get("chunk_index")
            total_chunks = meta.get("total_chunks")
            github_repo = meta.get("github_repo")
        except Exception:
            pass

    # 3. If we know the source_file, fetch ALL sibling chunks for the full doc
    if source_file:
        siblings = database.fetch_chunks_by_source(source_file)
    else:
        # Fallback: just show this single chunk
        siblings = [doc]

    # 4. Parse chunk_index from each sibling and sort
    def _chunk_sort_key(d):
        if d.get("metadata"):
            try:
                m = json.loads(d["metadata"])
                return m.get("chunk_index", 0)
            except Exception:
                pass
        return 0

    siblings.sort(key=_chunk_sort_key)

    # 5. Build the full document HTML, highlighting the target chunk
    parts = []
    for sib in siblings:
        text = html_module.escape(sib["content"])
        if sib["id"] == id:
            parts.append(
                f'<span id="target" style="background:#FF6B00; color:#000; padding:2px 0; '
                f'border-left:3px solid #FF6B00;">{text}</span>'
            )
        else:
            parts.append(text)

    content_html = "\n".join(parts)
    chunk_count = len(siblings)
    source_label = f" — from {github_repo}" if github_repo else ""
    chunk_info = (
        f"Chunk #{target_chunk_index + 1} of {total_chunks}"
        if target_chunk_index is not None
        else f"Chunk #{id}"
    )

    html_response = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>{html_module.escape(filename)}</title>
        <style>
            * {{ margin:0; padding:0; box-sizing:border-box; }}
            body {{
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                max-width: 900px;
                margin: 0 auto;
                padding: 32px 24px;
                line-height: 1.7;
                background: #0B0B0F;
                color: #C8C8D0;
            }}
            .header {{
                background: #111116;
                border: 1px solid #222228;
                padding: 20px 24px;
                margin-bottom: 24px;
            }}
            .header h1 {{
                font-size: 16px;
                font-weight: 600;
                color: #E8E8ED;
                margin-bottom: 8px;
            }}
            .header .meta {{
                font-size: 12px;
                font-family: 'JetBrains Mono', monospace;
                color: #55556A;
            }}
            .header .meta .accent {{ color: #FF6B00; }}
            .content {{
                background: #111116;
                border: 1px solid #222228;
                padding: 24px;
                font-size: 14px;
                white-space: pre-wrap;
                word-wrap: break-word;
                font-family: 'JetBrains Mono', 'SF Mono', monospace;
                line-height: 1.8;
            }}
            #target {{
                scroll-margin-top: 120px;
            }}
        </style>
    </head>
    <body>
        <div class="header">
            <h1>📄 {html_module.escape(filename)}{source_label}</h1>
            <div class="meta">
                <span class="accent">▶ {chunk_info}</span>
                &nbsp;·&nbsp; {chunk_count} total chunks &nbsp;·&nbsp; Scrolled to highlighted section
            </div>
        </div>
        <div class="content">{content_html}</div>
        <script>document.getElementById('target')?.scrollIntoView({{behavior:'smooth',block:'center'}});</script>
    </body>
    </html>
    """

    return html_response


# ============================================================================
# FRONTEND COMPATIBILITY ENDPOINTS
# ============================================================================

# GitHub ingestion status (shared state)
github_ingest_status = {
    "is_ingesting": False,
    "current_file": "",
    "progress": 0,
    "total": 0,
    "message": "Idle",
    "error": None,
}


def _github_ingest_worker(repo_url: str, subpath: Optional[str]):
    """Background worker to clone and ingest a GitHub repo"""
    import tempfile
    import subprocess
    import re as re_module

    global github_ingest_status
    github_ingest_status = {
        "is_ingesting": True,
        "current_file": "",
        "progress": 0,
        "total": 0,
        "message": f"Cloning {repo_url}...",
        "error": None,
    }

    try:
        # Clone the repo into a temp directory
        tmpdir = tempfile.mkdtemp(prefix="docseek_github_")
        logger.info(f"Cloning {repo_url} into {tmpdir}")

        result = subprocess.run(
            ["git", "clone", "--depth", "1", repo_url, tmpdir],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise Exception(f"Git clone failed: {result.stderr.strip()}")

        # Determine the scan directory
        scan_dir = os.path.join(tmpdir, subpath) if subpath else tmpdir
        if not os.path.isdir(scan_dir):
            raise Exception(f"Subpath '{subpath}' not found in the repository.")

        # Find supported files
        supported_exts = {".md", ".markdown", ".txt", ".html", ".htm", ".rst"}
        files_to_ingest = []
        for root, dirs, files in os.walk(scan_dir):
            # Skip hidden dirs and common non-doc dirs
            dirs[:] = [
                d
                for d in dirs
                if not d.startswith(".")
                and d not in ("node_modules", "__pycache__", ".git", "venv", ".venv")
            ]
            for f in files:
                if os.path.splitext(f)[1].lower() in supported_exts:
                    files_to_ingest.append(os.path.join(root, f))

        if not files_to_ingest:
            raise Exception("No supported files found in the repository.")

        github_ingest_status["total"] = len(files_to_ingest)
        github_ingest_status["message"] = (
            f"Found {len(files_to_ingest)} files. Ingesting..."
        )
        logger.info(f"Found {len(files_to_ingest)} files to ingest from {repo_url}")

        total_chunks = 0
        for idx, filepath in enumerate(files_to_ingest):
            filename = os.path.relpath(filepath, tmpdir)
            github_ingest_status["current_file"] = filename
            github_ingest_status["progress"] = idx + 1
            github_ingest_status["message"] = (
                f"Processing {filename} ({idx + 1}/{len(files_to_ingest)})"
            )

            try:
                ext = os.path.splitext(filepath)[1].lower()
                with open(filepath, "r", encoding="utf-8", errors="replace") as fh:
                    raw = fh.read()

                if ext in [".md", ".markdown"]:
                    text_content = parsing.parse_markdown(raw)
                elif ext in [".html", ".htm"]:
                    text_content = parsing.parse_html(raw)
                else:
                    text_content = raw

                text_content = re_module.sub(r"\n{3,}", "\n\n", text_content).strip()
                if not text_content:
                    continue

                chunks = parsing.chunk_text(text_content)
                if not chunks:
                    continue

                chunk_texts = [ct for ct, _, _ in chunks]
                embeddings = engine.embed_batch(chunk_texts)

                doc_ids = []
                for i, ((chunk_text, start_char, end_char), embedding) in enumerate(
                    zip(chunks, embeddings)
                ):
                    metadata = json.dumps(
                        {
                            "source_file": filepath,
                            "chunk_index": i,
                            "total_chunks": len(chunks),
                            "filename": filename,
                            "start_char": start_char,
                            "end_char": end_char,
                            "github_repo": repo_url,
                        }
                    )
                    doc_id = database.insert_document(chunk_text, metadata)
                    doc_ids.append(doc_id)

                engine.add_to_index(embeddings, doc_ids=doc_ids)
                total_chunks += len(chunks)

            except Exception as file_err:
                logger.error(f"Error processing {filename}: {file_err}")

        engine.save()

        github_ingest_status["is_ingesting"] = False
        github_ingest_status["message"] = (
            f"Done! Ingested {len(files_to_ingest)} files ({total_chunks} chunks)"
        )
        logger.info(
            f"✅ GitHub ingestion complete: {len(files_to_ingest)} files, {total_chunks} chunks"
        )

        # Cleanup temp directory
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)

    except Exception as e:
        logger.error(f"GitHub ingestion failed: {e}")
        github_ingest_status["is_ingesting"] = False
        github_ingest_status["error"] = str(e)
        github_ingest_status["message"] = f"Failed: {str(e)}"


@app.post("/ingest/github")
def ingest_github(request: GitHubIngestRequest):
    """Start ingesting documentation from a GitHub repository"""
    if github_ingest_status["is_ingesting"]:
        raise HTTPException(
            status_code=409, detail="An ingestion is already in progress"
        )

    # Validate the URL
    if not request.repo_url.startswith(
        ("https://github.com/", "https://gitlab.com/", "http")
    ):
        raise HTTPException(
            status_code=400, detail="Please provide a valid Git repository URL"
        )

    # Start ingestion in background thread
    thread = threading.Thread(
        target=_github_ingest_worker,
        args=(request.repo_url, request.subpath),
        daemon=True,
    )
    thread.start()

    return {"status": "started", "message": f"Ingesting from {request.repo_url}"}


@app.get("/documents")
def list_documents():
    """Return list of uploaded document filenames"""
    all_metadata = database.get_all_metadata()
    files = set()

    for m in all_metadata:
        if not m:
            continue
        try:
            meta_obj = json.loads(m)
            if "filename" in meta_obj:
                files.add(meta_obj["filename"])
        except Exception:
            # Legacy format - just extract filename if it's part of metadata
            pass

    return list(files)


@app.delete("/documents")
def delete_document(
    source_file: str = Query(..., description="source_file value to delete"),
    _: None = Depends(require_admin),
):
    """Delete all chunks for a given source_file from both DB and index."""
    ids = database.delete_documents_by_source(source_file)
    removed = engine.remove_ids(ids) if ids else 0
    engine.save()
    return {"status": "success", "deleted": removed, "db_rows": len(ids)}


@app.get("/ingest/status")
def get_ingest_status():
    return {
        "is_ingesting": github_ingest_status["is_ingesting"],
        "current_file": github_ingest_status.get("current_file", ""),
        "progress": github_ingest_status.get("progress", 0),
        "total": github_ingest_status.get("total", 0),
        "message": github_ingest_status.get("message", "Idle"),
        "error": github_ingest_status.get("error", None),
        "history": [],
    }


# ============================================================================
# SYSTEM
# ============================================================================


@app.get("/stats")
def get_stats():
    return {
        "total_documents": database.get_document_count(),
        "total_vectors": engine.get_total_vectors(),
        "model": MODEL_NAME,
        "dimension": EMBEDDING_DIM,
        "index_type": "IndexFlatIP (Cosine Similarity)",
    }


@app.delete("/reset")
def reset_system(_: None = Depends(require_admin)):
    global engine

    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    if os.path.exists(INDEX_PATH):
        os.remove(INDEX_PATH)

    database.init_db()
    engine = VectorEngine()

    return {"status": "System reset successfully"}


@app.post("/rebuild")
def rebuild_index(_: None = Depends(require_admin)):
    """Rebuild the FAISS index from all documents in the database"""
    count = _rebuild_index()
    return {"status": "success", "documents_indexed": count}


# ============================================================================
# ENTRY
# ============================================================================

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
