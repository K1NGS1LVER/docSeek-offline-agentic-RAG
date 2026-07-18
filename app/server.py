import asyncio
import os
import pathlib
import logging
import json
import threading
from typing import List, Optional, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, File, Form, UploadFile, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse
from sse_starlette.sse import EventSourceResponse
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool
from pydantic import BaseModel
import uvicorn

from app.core.config import (
    MODEL_NAME,
    EMBEDDING_DIM,
    HOST,
    PORT,
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
from app.core import database, parsing, chunking, reranker, stt, tts, podcast, research
from app.core.engine import VectorEngine
from app.core.llm import OllamaLLM
from app.core.fusion import reciprocal_rank_fusion
from app.core.agent import RetrievalAgent

# Per-notebook runtime registry (Step 2 below) needs these.
from collections import namedtuple
from app.core import notebooks, migration
from app.core.config import db_path as nb_db_path, index_path as nb_index_path, upload_dir, audio_dir

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
# NOTEBOOK RUNTIME REGISTRY
# ============================================================================
#
# One VectorEngine + db_path pair per notebook, created lazily on first use
# and cached for the process lifetime. The embedding model itself is shared
# across engines (VectorEngine loads it lazily/once), so opening many
# notebooks does not multiply model memory.

Runtime = namedtuple("Runtime", ["db_path", "engine"])
_runtimes: dict[str, "Runtime"] = {}
_runtimes_lock = threading.Lock()


def get_runtime(nb_id: str) -> Runtime:
    if notebooks.get_notebook(nb_id) is None:
        raise HTTPException(status_code=404, detail=f"Notebook '{nb_id}' not found")
    with _runtimes_lock:
        rt = _runtimes.get(nb_id)
        if rt is None:
            engine = VectorEngine(nb_index_path(nb_id))
            rt = Runtime(db_path=nb_db_path(nb_id), engine=engine)
            # Auto-rebuild this notebook's index if its DB has docs but index is empty.
            if database.get_document_count(rt.db_path) > 0 and engine.get_total_vectors() == 0:
                _rebuild_runtime(rt)
            _runtimes[nb_id] = rt
        return rt


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================


def _safe_upload_path(filename: str, base_dir: pathlib.Path) -> tuple[str, pathlib.Path]:
    """Strip any directory components from a client-supplied filename and
    resolve it strictly inside base_dir. Raises 400 on empty/unsafe names."""
    safe_name = os.path.basename(filename or "")
    if not safe_name or safe_name in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid filename")
    dest = (pathlib.Path(base_dir) / safe_name).resolve()
    upload_root = pathlib.Path(base_dir).resolve()
    if upload_root not in dest.parents and dest != upload_root:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return safe_name, dest


def _chunk_with_strategy(
    rt: "Runtime", text_content: str, strategy: Optional[str]
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
    return chunking.chunk_document(text_content, resolved, embed_fn=rt.engine.embed_batch)


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


def _persist_chunks(rt: "Runtime", chunks, embeddings, safe_name, file_path, strategy_used, extra_meta=None):
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
            doc_ids.append(database.insert_document(rt.db_path, chunk_text, json.dumps(meta)))
        rt.engine.add_to_index(embeddings, doc_ids=doc_ids)
        rt.engine.save()
    return doc_ids


# ============================================================================
# PYDANTIC MODELS
# ============================================================================


class IngestRequest(BaseModel):
    text: str
    metadata: Optional[str] = None
    notebook_id: str


class SearchRequest(BaseModel):
    query: str
    k: int = 5
    rerank: bool = False  # cross-encoder rescoring of an over-fetched candidate set
    # Restrict retrieval to these sources (filenames as returned by /documents).
    # None or empty means all sources.
    source_files: Optional[List[str]] = None
    notebook_id: str


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
    notebook_id: str
    repo_url: str
    subpath: Optional[str] = None


# ============================================================================
# LIFECYCLE
# ============================================================================

llm: Optional[OllamaLLM] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    global llm
    migration.migrate_legacy_layout()
    llm = OllamaLLM()
    await llm.warmup()

    # Fire-and-forget: warm the TTS pipeline in the background so it doesn't
    # delay server startup, but the first "Listen" click of the session
    # doesn't pay Kokoro's cold-load cost. A TTS warmup failure is logged by
    # tts.warmup() itself and must never affect startup.
    asyncio.create_task(run_in_threadpool(tts.warmup))

    # Notebook runtimes lazy-load on first request (see get_runtime); there is
    # no single global index/DB to rebuild or warm at startup anymore.
    logger.info("System ready. Notebook runtimes load lazily on first request.")
    yield
    # Shutdown
    with _runtimes_lock:
        _open_runtimes = list(_runtimes.values())
    for rt in _open_runtimes:
        rt.engine.save()
    logger.info("Saved %d loaded notebook runtime(s).", len(_open_runtimes))


def _rebuild_runtime(rt: "Runtime"):
    """Rebuild one notebook's FAISS index from all documents in its DB."""
    import faiss
    all_docs = database.get_all_documents(rt.db_path)
    base_index = faiss.IndexFlatIP(rt.engine.dimension)
    rt.engine.index = faiss.IndexIDMap(base_index)
    if not all_docs:
        rt.engine.save()
        return 0
    texts = [d["content"] for d in all_docs]
    doc_ids = [d["id"] for d in all_docs]
    batch_size = 64
    for i in range(0, len(texts), batch_size):
        embeddings = rt.engine.embed_batch(texts[i:i + batch_size])
        rt.engine.add_to_index(embeddings, doc_ids=doc_ids[i:i + batch_size])
    rt.engine.save()
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
# NOTEBOOKS
# ============================================================================


class NotebookCreate(BaseModel):
    name: str
    emoji: str | None = None


class NotebookUpdate(BaseModel):
    name: str
    emoji: str


@app.get("/notebooks")
async def get_notebooks():
    rows = notebooks.list_notebooks()
    out = []
    for r in rows:
        p = nb_db_path(r["id"])
        try:
            srcs = len(database.list_sources(p))
            docs = database.get_document_count(p)
        except Exception:
            srcs, docs = 0, 0
        out.append({**r, "sources": srcs, "documents": docs})
    return out


@app.post("/notebooks")
async def post_notebook(body: NotebookCreate):
    return notebooks.create_notebook(body.name, body.emoji or "📓")


@app.patch("/notebooks/{nb_id}")
async def patch_notebook(nb_id: str, body: NotebookUpdate):
    rec = notebooks.rename_notebook(nb_id, body.name, body.emoji)
    if rec is None:
        raise HTTPException(status_code=404, detail="Notebook not found")
    return rec


@app.delete("/notebooks/{nb_id}")
async def del_notebook(nb_id: str, _: None = Depends(require_admin)):
    if not notebooks.delete_notebook(nb_id):
        raise HTTPException(status_code=404, detail="Notebook not found")
    with _runtimes_lock:
        _runtimes.pop(nb_id, None)
    return {"deleted": True}


# ============================================================================
# INGEST & SEARCH
# ============================================================================


@app.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    chunking_strategy: Optional[str] = Form(None),
    notebook_id: str = Form(...),
):
    """Upload and ingest a single document file (optimized with batch embedding)"""
    import time

    start_time = time.time()
    rt = get_runtime(notebook_id)

    try:
        safe_name, file_path = _safe_upload_path(file.filename, upload_dir(notebook_id))
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
            _chunk_with_strategy, rt, text_content, chunking_strategy
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
        embeddings = await run_in_threadpool(rt.engine.embed_batch, chunk_texts)
        embed_time = time.time() - embed_start
        logger.info(
            f"✅ Embedded {len(chunks)} chunks in {embed_time:.2f}s ({len(chunks) / embed_time:.0f} chunks/sec)"
        )

        # Persist chunks + embeddings. The insert + FAISS add + save run under a
        # lock (in a threadpool) so concurrent uploads can't corrupt the index;
        # everything above (parse/OCR/embed) already ran outside the lock.
        doc_ids = await run_in_threadpool(
            _persist_chunks, rt, chunks, embeddings, safe_name, file_path, strategy_used
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
    notebook_id: str = Form(...),
):
    """Upload and ingest multiple documents at once (optimized batch processing)"""
    import time

    start_time = time.time()
    rt = get_runtime(notebook_id)
    base_dir = upload_dir(notebook_id)

    results = []
    total_chunks = 0

    for file in files:
        try:
            safe_name, file_path = _safe_upload_path(file.filename, base_dir)
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
                _chunk_with_strategy, rt, text_content, chunking_strategy
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
            embeddings = await run_in_threadpool(rt.engine.embed_batch, chunk_texts)

            # Persist under the ingest lock (safe against concurrent uploads).
            await run_in_threadpool(
                _persist_chunks, rt, chunks, embeddings, safe_name, file_path, strategy_used
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
    rt = get_runtime(request.notebook_id)
    vector = rt.engine.embed(request.text)
    doc_id = database.insert_document(rt.db_path, request.text, request.metadata)
    rt.engine.add_to_index(vector, doc_ids=[doc_id])
    rt.engine.save()  # Persist index changes to disk
    return {"status": "success", "id": doc_id}



SIMILARITY_THRESHOLD = 0.20  # Minimum cosine similarity score to return a result


def _retrieve_and_filter(
    rt: "Runtime", query: str, k: int, source_files: Optional[List[str]] = None
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
    if rt.engine.get_total_vectors() == 0:
        return []

    allowed_ids: Optional[set] = None
    if source_files:
        allowed_ids = set(database.get_ids_for_sources(rt.db_path, source_files))
        if not allowed_ids:
            return []

    query_vector = rt.engine.embed(query)
    top_indices, scores = rt.engine.search(query_vector, k, allowed_ids=allowed_ids)

    # Dense scores keyed by id (used for the returned score + threshold).
    dense_scores = {
        int(idx): float(sc)
        for idx, sc in zip(top_indices, scores)
        if idx != -1
    }

    if HYBRID_SEARCH:
        dense_ids = [int(i) for i in top_indices if i != -1]
        kw_ids = database.keyword_search(rt.db_path, query, k)
        if allowed_ids is not None:
            kw_ids = [i for i in kw_ids if i in allowed_ids]
        ordered_ids = reciprocal_rank_fusion([dense_ids, kw_ids], k=RRF_K)[:k]
    else:
        ordered_ids = [int(i) for i in top_indices if i != -1]

    if not ordered_ids:
        return []

    documents = database.fetch_documents_by_ids(rt.db_path, ordered_ids)
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
            if not HYBRID_SEARCH or doc_id not in database.keyword_search(rt.db_path, query, k):
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
    rt = get_runtime(request.notebook_id)
    if request.rerank:
        # Over-fetch candidates, rescore with the local cross-encoder, cut to k.
        fetch_k = min(request.k * RERANK_CANDIDATE_FACTOR, 30)
        results = _retrieve_and_filter(rt, request.query, fetch_k, request.source_files)
        results = reranker.rerank(request.query, results)[: request.k]
    else:
        results = _retrieve_and_filter(rt, request.query, request.k, request.source_files)
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
    notebook_id: str


@app.post("/ask")
async def ask(request: AskRequest):
    """Agentic RAG endpoint, streamed over SSE with typed events:

    - event "trace":   agent decision steps (plan / retrieve / rerank / grade / loop)
    - event "sources": the final retrieved chunks used as context
    - default events:  JSON-encoded answer text deltas (unchanged framing)
    """
    rt = get_runtime(request.notebook_id)
    use_agent = AGENTIC_RAG if request.agentic is None else request.agentic

    async def event_stream():
        try:
            if rt.engine.get_total_vectors() == 0:
                yield {"data": json.dumps(
                    "No documents have been uploaded yet. Please upload some documents first."
                )}
                return

            def retrieve(query: str, k: int) -> List[Dict[str, Any]]:
                return _retrieve_and_filter(rt, query, k, request.source_files)

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
# RESEARCH (DEEP RESEARCH REPORT)
# ============================================================================


class ResearchRequest(BaseModel):
    query: str
    # Restrict retrieval to these sources (filenames as returned by /documents).
    source_files: Optional[List[str]] = None
    notebook_id: str


@app.post("/research")
async def deep_research(request: ResearchRequest):
    """Deep research report, streamed over SSE with the exact same typed events
    as /ask: `trace` (one per graph node/section), `sources` (all cited chunks),
    then unnamed events carrying JSON-encoded report-text deltas."""

    rt = get_runtime(request.notebook_id)

    async def event_stream():
        try:
            if rt.engine.get_total_vectors() == 0:
                yield {"data": json.dumps(
                    "No documents have been uploaded yet. Please upload some documents first."
                )}
                return

            def retrieve(query: str, k: int) -> List[Dict[str, Any]]:
                return _retrieve_and_filter(rt, query, k, request.source_files)

            graph = research.ResearchGraph(llm=llm, retrieve_fn=retrieve)
            logger.info(f"RESEARCH '{request.query}' streaming report...")
            async for kind, payload in graph.run(request.query, request.source_files):
                if kind == "trace":
                    yield {"event": "trace", "data": json.dumps(payload)}
                elif kind == "sources":
                    yield {"event": "sources", "data": json.dumps(payload)}
                elif kind == "delta":
                    yield {"data": json.dumps(payload)}
        except Exception as e:
            logger.error(f"RESEARCH endpoint error: {e}")
            yield {"data": json.dumps(f"⚠️ Server error: {str(e)}")}

    return EventSourceResponse(event_stream())


# ============================================================================
# DICTATION (LOCAL SPEECH-TO-TEXT)
# ============================================================================


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Transcribe a recorded audio clip to text, fully on-device.

    Accepts whatever container the browser's MediaRecorder produces
    (webm/ogg/wav); faster-whisper decodes it via bundled PyAV. Returns
    {"text", "language", "duration"}.
    """
    import tempfile

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty audio upload")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)",
        )

    # Persist to a temp file: faster-whisper decodes from a path.
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(content)
        tmp.close()
        result = await run_in_threadpool(stt.transcribe, tmp.name)
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass

    if result is None:
        raise HTTPException(
            status_code=503,
            detail="Speech-to-text model unavailable. Check server logs; the "
            "faster-whisper model downloads once on first use.",
        )
    logger.info(
        f"Transcribed {len(content)} bytes → {len(result['text'])} chars "
        f"({result.get('language')}, {result.get('duration')}s)"
    )
    return result


# ============================================================================
# PODCAST (LOCAL AUDIO OVERVIEW)
# ============================================================================

# In-memory job registry for podcast generation. Podcasts take minutes, so we
# reuse the background-worker + status-polling pattern proven by GitHub ingest.
podcast_jobs: Dict[str, Dict[str, Any]] = {}


class PodcastRequest(BaseModel):
    notebook_id: str
    source_files: List[str]


def _podcast_worker(job_id: str, notebook_id: str, source_files: List[str]):
    """Background worker: drive the podcast LangGraph in its own event loop."""
    import asyncio

    def on_progress(ev: Dict[str, Any]):
        job = podcast_jobs.get(job_id)
        if job is not None:
            job.update({
                "stage": ev.get("stage", job.get("stage")),
                "message": ev.get("message", job.get("message")),
                "progress": ev.get("progress", job.get("progress", 0)),
            })

    try:
        rt = get_runtime(notebook_id)
        result = asyncio.run(
            podcast.generate_podcast(
                rt.db_path, audio_dir(notebook_id), job_id, source_files, on_progress
            )
        )
    except Exception as e:  # asyncio/loop-level failure
        logger.error(f"Podcast worker {job_id} failed: {e}")
        result = {"status": "failed", "error": str(e)}

    job = podcast_jobs.setdefault(job_id, {})
    job.update(result)
    if result.get("status") == "failed":
        job["message"] = result.get("error", "Generation failed.")
        job["progress"] = job.get("progress", 0)
    else:
        job["message"] = "Episode ready."
        job["progress"] = 100


@app.post("/podcast")
def create_podcast(request: PodcastRequest):
    """Kick off a two-host audio overview for the selected sources. Returns a
    job_id to poll via /podcast/status."""
    import uuid

    rt = get_runtime(request.notebook_id)  # 404s bad notebook ids early
    sources = [s for s in (request.source_files or []) if s and s.strip()]
    if not sources:
        raise HTTPException(status_code=400, detail="Select at least one source.")

    job_id = uuid.uuid4().hex[:12]
    podcast_jobs[job_id] = {
        "job_id": job_id,
        "notebook_id": request.notebook_id,
        "status": "running",
        "stage": "queued",
        "message": "Starting…",
        "progress": 0,
        "source_files": sources,
        "error": None,
    }
    thread = threading.Thread(
        target=_podcast_worker, args=(job_id, request.notebook_id, sources), daemon=True
    )
    thread.start()
    logger.info(f"Podcast job {job_id} started for {len(sources)} source(s)")
    return {"job_id": job_id, "status": "running"}


@app.get("/podcast/status")
def podcast_status(job_id: str = Query(...), notebook_id: str = Query(...)):
    job = podcast_jobs.get(job_id)
    if job is None or job.get("notebook_id") != notebook_id:
        raise HTTPException(status_code=404, detail="Unknown podcast job")
    return {
        "job_id": job_id,
        "status": job.get("status"),
        "stage": job.get("stage"),
        "message": job.get("message"),
        "progress": job.get("progress", 0),
        "error": job.get("error"),
        "title": job.get("title"),
        "duration": job.get("duration"),
    }


@app.get("/podcast/audio")
def podcast_audio(job_id: str = Query(...), notebook_id: str = Query(...)):
    """Serve the generated WAV for a completed episode."""
    if notebooks.get_notebook(notebook_id) is None:
        raise HTTPException(status_code=404, detail=f"Notebook '{notebook_id}' not found")
    wav = audio_dir(notebook_id) / f"{job_id}.wav"
    if not wav.exists():
        raise HTTPException(status_code=404, detail="Audio not found for this job")
    return FileResponse(str(wav), media_type="audio/wav", filename=f"{job_id}.wav")


@app.get("/podcasts")
def list_podcasts(notebook_id: str = Query(...)):
    """All generated episodes for this notebook, newest first."""
    if notebooks.get_notebook(notebook_id) is None:
        raise HTTPException(status_code=404, detail=f"Notebook '{notebook_id}' not found")
    return podcast.list_episodes(audio_dir(notebook_id))


class TTSRequest(BaseModel):
    text: str
    voice: Optional[str] = None


@app.post("/tts")
async def text_to_speech(request: TTSRequest):
    """Read a short piece of text aloud (single voice), returned as a WAV.

    Powers the answer read-aloud button; reuses the same local Kokoro model as
    the podcast pipeline. Prefer POST /tts/stream for lower time-to-first-audio;
    this whole-file endpoint remains for callers that need a single WAV blob.
    """
    import io
    import soundfile as sf

    text = (request.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text to speak")
    # Guard against very long inputs monopolizing the model.
    text = text[:2000]

    voice = request.voice or tts.VOICE_A

    def _render():
        # Returns (status, bytes): "ok" | "unavailable" | "empty".
        audio = tts.synthesize(text, voice)
        if audio is None:
            return "unavailable", b""
        if audio.size == 0:
            return "empty", b""
        buf = io.BytesIO()
        sf.write(buf, audio, tts.SAMPLE_RATE, format="WAV")
        return "ok", buf.getvalue()

    status, wav_bytes = await run_in_threadpool(_render)
    if status == "unavailable":
        raise HTTPException(
            status_code=503,
            detail="Local text-to-speech (Kokoro) is unavailable. The model "
            "downloads once on first use; check server logs.",
        )
    if status == "empty":
        raise HTTPException(
            status_code=422, detail="Nothing could be synthesized from that text."
        )
    from fastapi.responses import Response

    return Response(content=wav_bytes, media_type="audio/wav")


@app.post("/tts/stream")
async def text_to_speech_stream(request: TTSRequest):
    """Read a short piece of text aloud, streaming raw PCM as it's synthesized.

    Same input contract as POST /tts, but yields audio incrementally (mono
    float32 samples at tts.SAMPLE_RATE, no container/header) so playback can
    start after the first sentence instead of waiting for the whole answer.
    """
    text = (request.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text to speak")
    text = text[:2000]
    voice = request.voice or tts.VOICE_A

    if not await run_in_threadpool(tts.is_available):
        raise HTTPException(
            status_code=503,
            detail="Local text-to-speech (Kokoro) is unavailable. The model "
            "downloads once on first use; check server logs.",
        )

    async def _pcm_chunks():
        async for segment in iterate_in_threadpool(tts.synthesize_stream(text, voice)):
            if segment.size:
                yield segment.tobytes()

    return StreamingResponse(_pcm_chunks(), media_type="application/octet-stream")


# ============================================================================
# DOCUMENT VIEW
# ============================================================================


@app.get("/document/view", response_class=HTMLResponse)
def view_document(
    id: int = Query(..., description="Document chunk ID from the database"),
    notebook_id: str = Query(...),
):
    """View the FULL original document, with the clicked chunk highlighted.

    Given a chunk id, we find all sibling chunks that belong to the same
    source file, sort them by chunk_index, concatenate their content, and
    highlight the chunk that was clicked.
    """
    import html as html_module

    rt = get_runtime(notebook_id)

    # 1. Fetch the target chunk
    doc = database.fetch_document_by_id(rt.db_path, id)
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
        siblings = database.fetch_chunks_by_source(rt.db_path, source_file)
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
    "notebook_id": None,
}


def _github_ingest_worker(notebook_id: str, repo_url: str, subpath: Optional[str]):
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
        "notebook_id": notebook_id,
    }

    try:
        rt = get_runtime(notebook_id)

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
                    text_content, CHUNKING_STRATEGY, embed_fn=rt.engine.embed_batch
                )
                if not chunks:
                    continue

                chunk_texts = [ct for ct, _, _ in chunks]
                embeddings = rt.engine.embed_batch(chunk_texts)

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
                    doc_id = database.insert_document(rt.db_path, chunk_text, metadata)
                    doc_ids.append(doc_id)

                rt.engine.add_to_index(embeddings, doc_ids=doc_ids)
                total_chunks += len(chunks)

            except Exception as file_err:
                logger.error(f"Error processing {filename}: {file_err}")

        rt.engine.save()

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
    rt = get_runtime(request.notebook_id)  # 404s bad notebook ids early
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
        args=(request.notebook_id, request.repo_url, request.subpath),
        daemon=True,
    )
    thread.start()

    return {"status": "started", "message": f"Ingesting from {request.repo_url}"}


@app.get("/documents")
def list_documents(notebook_id: str = Query(...)):
    """Return list of uploaded document filenames"""
    rt = get_runtime(notebook_id)
    all_metadata = database.get_all_metadata(rt.db_path)
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
def list_sources(notebook_id: str = Query(...)):
    """Rich source listing for the workspace UI: one row per source file with
    its display name, chunk count, chunking strategy, and a chunk id usable
    with /document/view."""
    rt = get_runtime(notebook_id)
    rows = database.list_sources(rt.db_path)
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
    notebook_id: str = Query(...),
    _: None = Depends(require_admin),
):
    """Delete all chunks for a given source_file from both DB and index."""
    rt = get_runtime(notebook_id)
    ids = database.delete_documents_by_source(rt.db_path, source_file)
    removed = rt.engine.remove_ids(ids) if ids else 0
    rt.engine.save()
    return {"status": "success", "deleted": removed, "db_rows": len(ids)}


@app.get("/ingest/status")
def get_ingest_status(notebook_id: str = Query(...)):
    if github_ingest_status.get("notebook_id") != notebook_id:
        # A different (or no) notebook owns the in-flight/last job; this
        # notebook never sees another notebook's ingest progress.
        return {
            "is_ingesting": False,
            "current_file": "",
            "progress": 0,
            "total": 0,
            "message": "Idle",
            "error": None,
            "history": [],
        }
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
def get_stats(notebook_id: str = Query(...)):
    rt = get_runtime(notebook_id)
    return {
        "total_documents": database.get_document_count(rt.db_path),
        "total_vectors": rt.engine.get_total_vectors(),
        "model": MODEL_NAME,
        "dimension": EMBEDDING_DIM,
        "index_type": "IndexFlatIP (Cosine Similarity)",
        "agentic": AGENTIC_RAG,
        "hybrid_search": HYBRID_SEARCH,
        "reranker_model": RERANK_MODEL,
        "chunking_strategy": CHUNKING_STRATEGY,
    }


@app.delete("/reset")
def reset_system(notebook_id: str = Query(...), _: None = Depends(require_admin)):
    rt = get_runtime(notebook_id)

    if os.path.exists(rt.db_path):
        os.remove(rt.db_path)
    if os.path.exists(nb_index_path(notebook_id)):
        os.remove(nb_index_path(notebook_id))

    database.init_db(nb_db_path(notebook_id))
    with _runtimes_lock:
        _runtimes[notebook_id] = Runtime(
            db_path=nb_db_path(notebook_id), engine=VectorEngine(nb_index_path(notebook_id))
        )

    return {"status": "System reset successfully"}


@app.post("/rebuild")
async def rebuild_index(notebook_id: str = Query(...), _: None = Depends(require_admin)):
    """Rebuild the FAISS index from all documents in the database"""
    rt = get_runtime(notebook_id)
    count = await run_in_threadpool(_rebuild_runtime, rt)
    return {"status": "success", "documents_indexed": count}


# ============================================================================
# ENTRY
# ============================================================================

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
