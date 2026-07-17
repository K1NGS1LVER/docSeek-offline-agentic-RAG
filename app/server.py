import os
import pathlib
import logging
import json
import threading
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, File, Form, UploadFile, Header, Depends
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
    HYBRID_SEARCH,
    RRF_K,
    AGENTIC_RAG,
    RERANK_MODEL,
    RERANK_CANDIDATE_FACTOR,
    CHUNKING_STRATEGY,
)
from app.core import database, parsing, chunking, reranker
from app.core.engine import VectorEngine
from app.core.llm import OllamaLLM
from app.core.fusion import reciprocal_rank_fusion
from app.core.agent import RetrievalAgent

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


def _chunk_with_strategy(
    text_content: str, strategy: Optional[str]
) -> tuple[list, str]:
    """Chunk text with the requested (or configured default) strategy.

    Returns (chunks, strategy_used). Semantic chunking embeds sentences with
    the local model; "auto" picks a strategy per document.
    """
    resolved = (strategy or CHUNKING_STRATEGY).strip().lower()
    if resolved not in chunking.STRATEGIES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown chunking strategy: {resolved}. Supported: {', '.join(chunking.STRATEGIES)}",
        )
    return chunking.chunk_document(text_content, resolved, embed_fn=engine.embed_batch)


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


# Every file type the upload endpoints can ingest.
SUPPORTED_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".html", ".htm", ".docx", ".pdf", ".pptx",
}


def extract_text_from_upload(ext: str, content: bytes, file_path: pathlib.Path) -> str:
    """Extract plain text from an uploaded file by extension.

    `content` is the raw bytes; `file_path` is where they were saved (needed
    for .docx, which python-docx reads from a path). Raises HTTPException(400)
    on unsupported types or extraction failure.
    """
    ext = ext.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {ext}. Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}",
        )
    try:
        if ext == ".docx":
            return extract_text_from_docx(str(file_path))
        if ext == ".pdf":
            return parsing.parse_pdf(content)
        if ext == ".pptx":
            return parsing.parse_pptx(content)
        if ext in (".html", ".htm"):
            return parsing.parse_html(content.decode("utf-8", errors="replace"))
        # .txt / .md / .markdown / anything else textual
        text = content.decode("utf-8", errors="replace")
        if ext in (".md", ".markdown"):
            text = parsing.parse_markdown(text)
        return text
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Failed to extract text from {ext} file: {str(e)}"
        )


# Serializes the shared-state mutations of ingestion (SQLite inserts + FAISS
# index add + save). Parsing, OCR, and embedding run OUTSIDE this lock, so those
# (the slow parts) still overlap across parallel uploads; only the index writes
# serialize, which keeps the FAISS index from being corrupted by concurrency.
_ingest_lock = threading.Lock()


def _persist_chunks(chunks, embeddings, safe_name, file_path, strategy_used, extra_meta=None):
    """Insert chunks + their embeddings under the ingest lock. Returns doc_ids.

    chunks are (text, start_char, end_char) tuples aligned with embeddings.
    """
    with _ingest_lock:
        doc_ids = []
        for i, (chunk_text, start_char, end_char) in enumerate(chunks):
            meta = {
                "source_file": str(file_path),
                "chunk_index": i,
                "total_chunks": len(chunks),
                "filename": safe_name,
                "start_char": start_char,
                "end_char": end_char,
                "chunking": strategy_used,
            }
            if extra_meta:
                meta.update(extra_meta)
            doc_ids.append(database.insert_document(chunk_text, json.dumps(meta)))
        engine.add_to_index(embeddings, doc_ids=doc_ids)
        engine.save()
    return doc_ids


# ============================================================================
# PYDANTIC MODELS
# ============================================================================


class IngestRequest(BaseModel):
    text: str
    metadata: Optional[str] = None


class SearchRequest(BaseModel):
    query: str
    k: int = 5
    rerank: bool = False  # cross-encoder rescoring of an over-fetched candidate set
    # Restrict retrieval to these sources (filenames as returned by /documents).
    # None or empty means all sources.
    source_files: Optional[List[str]] = None


class SearchResult(BaseModel):
    id: int
    score: float
    content: str
    source: Optional[Dict[str, Any]] = None
    rerank_score: Optional[float] = None


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
    await llm.warmup()

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
async def upload_file(
    file: UploadFile = File(...),
    chunking_strategy: Optional[str] = Form(None),
):
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

        # Parse based on file extension (validates type, extracts text).
        ext = os.path.splitext(safe_name)[1].lower()
        text_content = await run_in_threadpool(
            extract_text_from_upload, ext, content, file_path
        )

        # Chunk the content (returns tuples of (text, start_char, end_char)).
        # Run in a threadpool: semantic chunking embeds sentences (CPU-heavy).
        chunks, strategy_used = await run_in_threadpool(
            _chunk_with_strategy, text_content, chunking_strategy
        )

        if not chunks:
            raise HTTPException(
                status_code=400, detail="No content could be extracted from file"
            )

        logger.info(
            f"Processing {safe_name}: {len(chunks)} chunks to embed ({strategy_used} chunking)..."
        )

        # BATCH EMBED all chunks at once (MUCH faster than one-by-one)
        chunk_texts = [chunk_text for chunk_text, _, _ in chunks]

        embed_start = time.time()
        embeddings = await run_in_threadpool(engine.embed_batch, chunk_texts)
        embed_time = time.time() - embed_start
        logger.info(
            f"✅ Embedded {len(chunks)} chunks in {embed_time:.2f}s ({len(chunks) / embed_time:.0f} chunks/sec)"
        )

        # Persist chunks + embeddings. The insert + FAISS add + save run under a
        # lock (in a threadpool) so concurrent uploads can't corrupt the index;
        # everything above (parse/OCR/embed) already ran outside the lock.
        doc_ids = await run_in_threadpool(
            _persist_chunks, chunks, embeddings, safe_name, file_path, strategy_used
        )

        elapsed = time.time() - start_time

        logger.info(
            f"✅ Successfully ingested {safe_name} ({len(chunks)} chunks) in {elapsed:.2f}s"
        )

        return {
            "status": "success",
            "filename": safe_name,
            "chunks": len(chunks),
            "chunking": strategy_used,
            "doc_ids": doc_ids,
            "time_seconds": round(elapsed, 2),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading file: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/upload-multiple")
async def upload_multiple_files(
    files: list[UploadFile] = File(...),
    chunking_strategy: Optional[str] = Form(None),
):
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

            # Parse based on file extension (validates type, extracts text).
            ext = os.path.splitext(safe_name)[1].lower()
            try:
                text_content = await run_in_threadpool(
                    extract_text_from_upload, ext, content, file_path
                )
            except HTTPException as extract_error:
                results.append(
                    {
                        "filename": safe_name,
                        "status": "failed",
                        "error": extract_error.detail,
                    }
                )
                continue

            # Chunk the content
            chunks, strategy_used = await run_in_threadpool(
                _chunk_with_strategy, text_content, chunking_strategy
            )

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

            # Persist under the ingest lock (safe against concurrent uploads).
            await run_in_threadpool(
                _persist_chunks, chunks, embeddings, safe_name, file_path, strategy_used
            )

            total_chunks += len(chunks)
            results.append(
                {
                    "filename": safe_name,
                    "status": "success",
                    "chunks": len(chunks),
                    "chunking": strategy_used,
                }
            )

            logger.info(f"✅ Processed {safe_name} ({len(chunks)} chunks)")

        except Exception as e:
            logger.error(f"Error processing {file.filename}: {str(e)}")
            results.append(
                {"filename": file.filename, "status": "failed", "error": str(e)}
            )
        # Note: _persist_chunks already saved the index under the lock per file.

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


def _retrieve_and_filter(
    query: str, k: int, source_files: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """Shared retrieval + relevance-filtering logic for /search and /ask.

    Runs dense search (and, if enabled, keyword search + RRF fusion), then
    drops weak dense-only hits below SIMILARITY_THRESHOLD -- unless the hit
    is also a keyword match (hybrid only), or is a keyword-only hit (no
    dense score at all), in which case it's kept regardless of score.

    If source_files is given, retrieval is scoped to those sources: the
    dense search is restricted with a FAISS ID selector and keyword hits
    are filtered to the same id set, so a small source can never be
    crowded out of the candidate pool by a large one.

    Returns a list of dicts: {"id", "score", "content", "source"}.
    """
    if engine.get_total_vectors() == 0:
        return []

    allowed_ids: Optional[set] = None
    if source_files:
        allowed_ids = set(database.get_ids_for_sources(source_files))
        if not allowed_ids:
            return []

    query_vector = engine.embed(query)
    top_indices, scores = engine.search(query_vector, k, allowed_ids=allowed_ids)

    # Dense scores keyed by id (used for the returned score + threshold).
    dense_scores = {
        int(idx): float(sc)
        for idx, sc in zip(top_indices, scores)
        if idx != -1
    }

    if HYBRID_SEARCH:
        dense_ids = [int(i) for i in top_indices if i != -1]
        kw_ids = database.keyword_search(query, k)
        if allowed_ids is not None:
            kw_ids = [i for i in kw_ids if i in allowed_ids]
        ordered_ids = reciprocal_rank_fusion([dense_ids, kw_ids], k=RRF_K)[:k]
    else:
        ordered_ids = [int(i) for i in top_indices if i != -1]

    if not ordered_ids:
        return []

    documents = database.fetch_documents_by_ids(ordered_ids)
    doc_map = {doc["id"]: doc for doc in documents}

    results = []
    for doc_id in ordered_ids:
        doc = doc_map.get(doc_id)
        if doc is None:
            continue
        score = dense_scores.get(doc_id)
        # Keyword-only hits have no dense score; keep them (they matched terms)
        # but give them a floor so they clear nothing they shouldn't. We surface
        # the dense score when we have it, else 0.0.
        if score is None:
            score = 0.0
        elif score < SIMILARITY_THRESHOLD:
            # Drop weak dense-only hits, but keep if keyword also matched (hybrid only).
            if not HYBRID_SEARCH or doc_id not in database.keyword_search(query, k):
                continue
        source_data = None
        if doc.get("metadata"):
            try:
                source_data = json.loads(doc["metadata"])
            except Exception:
                source_data = {"raw": doc["metadata"]}
        results.append(
            {"id": doc_id, "score": score, "content": doc["content"], "source": source_data}
        )
    return results


@app.post("/search", response_model=List[SearchResult])
def search(request: SearchRequest):
    if request.rerank:
        # Over-fetch candidates, rescore with the local cross-encoder, cut to k.
        fetch_k = min(request.k * RERANK_CANDIDATE_FACTOR, 30)
        results = _retrieve_and_filter(request.query, fetch_k, request.source_files)
        results = reranker.rerank(request.query, results)[: request.k]
    else:
        results = _retrieve_and_filter(request.query, request.k, request.source_files)
    logger.info(
        f"Search '{request.query}' hybrid={HYBRID_SEARCH} rerank={request.rerank} "
        f"-> {len(results)} results"
    )
    return [SearchResult(**r) for r in results]


# ============================================================================
# ASK (LLM-POWERED RAG)
# ============================================================================


class AskRequest(BaseModel):
    query: str
    # None lets the agent pick k dynamically (agentic) / defaults to 3 (simple).
    k: Optional[int] = None
    # None -> config default (AGENTIC_RAG). False forces plain hybrid retrieval.
    agentic: Optional[bool] = None
    # Restrict retrieval to these sources (filenames as returned by /documents).
    source_files: Optional[List[str]] = None


@app.post("/ask")
async def ask(request: AskRequest):
    """Agentic RAG endpoint, streamed over SSE with typed events:

    - event "trace":   agent decision steps (plan / retrieve / rerank / grade / loop)
    - event "sources": the final retrieved chunks used as context
    - default events:  JSON-encoded answer text deltas (unchanged framing)
    """
    use_agent = AGENTIC_RAG if request.agentic is None else request.agentic

    async def event_stream():
        try:
            if engine.get_total_vectors() == 0:
                yield {"data": json.dumps(
                    "No documents have been uploaded yet. Please upload some documents first."
                )}
                return

            def retrieve(query: str, k: int) -> List[Dict[str, Any]]:
                return _retrieve_and_filter(query, k, request.source_files)

            if use_agent:
                agent = RetrievalAgent(llm=llm, retrieve_fn=retrieve)
                results = []
                async for ev in agent.run(request.query, user_k=request.k):
                    if ev["type"] == "trace":
                        yield {"event": "trace", "data": json.dumps(ev)}
                    elif ev["type"] == "results":
                        results = ev["results"]
            else:
                results = await run_in_threadpool(retrieve, request.query, request.k or 3)

            search_results = [
                {
                    "id": r["id"],
                    "content": r["content"],
                    "score": r["score"],
                    "rerank_score": r.get("rerank_score"),
                    "source": r["source"],
                }
                for r in results
            ]
            yield {"event": "sources", "data": json.dumps(search_results)}

            if not search_results:
                yield {"data": json.dumps(
                    "I couldn't find any relevant information in the uploaded documents for your query."
                )}
                return

            # Reordered context: best chunks at the start and end of the prompt.
            context = llm.build_context(search_results)
            logger.info(
                f"ASK '{request.query}' agentic={use_agent} → "
                f"{len(search_results)} chunks, streaming LLM response..."
            )

            async for chunk in llm.stream_answer(request.query, context):
                yield {"data": json.dumps(chunk)}

        except Exception as e:
            logger.error(f"ASK endpoint error: {e}")
            yield {"data": json.dumps(f"⚠️ Server error: {str(e)}")}

    return EventSourceResponse(event_stream())


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

                chunks, strategy_used = chunking.chunk_document(
                    text_content, CHUNKING_STRATEGY, embed_fn=engine.embed_batch
                )
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
                            "chunking": strategy_used,
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


@app.get("/sources")
def list_sources():
    """Rich source listing for the workspace UI: one row per source file with
    its display name, chunk count, chunking strategy, and a chunk id usable
    with /document/view."""
    rows = database.list_sources()
    sources = []
    for row in rows:
        meta = {}
        if row.get("metadata"):
            try:
                meta = json.loads(row["metadata"])
            except Exception:
                meta = {}
        sources.append(
            {
                "source_file": row["source_file"],
                "filename": meta.get("filename")
                or os.path.basename(row["source_file"]),
                "chunks": row["chunks"],
                "first_chunk_id": row["first_chunk_id"],
                "chunking": meta.get("chunking"),
                "github_repo": meta.get("github_repo"),
            }
        )
    sources.sort(key=lambda s: s["filename"].lower())
    return sources


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
        "agentic": AGENTIC_RAG,
        "hybrid_search": HYBRID_SEARCH,
        "reranker_model": RERANK_MODEL,
        "chunking_strategy": CHUNKING_STRATEGY,
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
