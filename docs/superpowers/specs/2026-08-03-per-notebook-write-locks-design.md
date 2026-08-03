# Per-Notebook Write Locks Design Specification

**Date**: 2026-08-03  
**Status**: Approved  
**Scope**: Server concurrency architecture (`app/server.py`)

## 1. Overview & Goal

Currently, `app/server.py` uses a single process-wide global lock (`_ingest_lock = threading.Lock()`) to serialize writes to SQLite and FAISS indices during file uploads and document ingestion.

This global lock creates unnecessary contention when multiple users or threads ingest files into **different** notebooks concurrently. Furthermore, certain endpoints (such as single document `/ingest` and `/rebuild`) lacked explicit write locking.

This specification replaces the global `_ingest_lock` with per-notebook write locks (`rt.lock`) embedded directly inside each notebook's `Runtime` object. Ingestion tasks for distinct notebooks can now run in parallel without blocking each other, while writes to the same notebook remain strictly serialized and thread-safe.

## 2. Architecture & Data Structures

### 2.1 `Runtime` Definition Update
In `app/server.py`, the `Runtime` tuple is updated to include a `lock` field:

```python
Runtime = namedtuple("Runtime", ["db_path", "engine", "lock"])
```

### 2.2 Lifecycle & Lazy Lock Creation
In `get_runtime(nb_id: str) -> Runtime`, when a new `Runtime` is instantiated, a dedicated `threading.Lock` is created:

```python
with _runtimes_lock:
    rt = _runtimes.get(nb_id)
    if rt is None:
        engine = VectorEngine(nb_index_path(nb_id))
        rt = Runtime(db_path=nb_db_path(nb_id), engine=engine, lock=threading.Lock())
        if database.get_document_count(rt.db_path) > 0 and engine.get_total_vectors() == 0:
            _rebuild_runtime(rt)
        _runtimes[nb_id] = rt
    return rt
```

When a notebook runtime is evicted or deleted (`del_notebook`), its lock is cleaned up along with the runtime object.

### 2.3 Global Lock Removal
The global `_ingest_lock = threading.Lock()` definition is completely removed.

## 3. Ingestion & Maintenance Operations

All write operations targeting SQLite (`database.insert_...`) and FAISS index updates (`rt.engine.add_to_index`, `rt.engine.save`) acquire `rt.lock`:

1. **`_persist_chunks`**:
   ```python
   def _persist_chunks(rt: "Runtime", chunks, embeddings, safe_name, file_path, strategy_used, extra_meta=None):
       with rt.lock:
           db_items = [...]
           doc_ids = database.insert_documents_batch(rt.db_path, db_items)
           rt.engine.add_to_index(embeddings, doc_ids=doc_ids)
           rt.engine.save()
       return doc_ids
   ```
2. **`ingest_document` (`POST /ingest`)**:
   ```python
   @app.post("/ingest")
   def ingest_document(request: IngestRequest):
       rt = get_runtime(request.notebook_id)
       vector = rt.engine.embed(request.text)
       with rt.lock:
           doc_id = database.insert_document(rt.db_path, request.text, request.metadata)
           rt.engine.add_to_index(vector, doc_ids=[doc_id])
           rt.engine.save()
       return {"status": "success", "id": doc_id}
   ```
3. **`ingest_documents_batch` (`POST /ingest/batch`)**:
   ```python
   def _persist():
       with rt.lock:
           db_items = [{"content": doc.text, "metadata": doc.metadata} for doc in request.documents]
           doc_ids = database.insert_documents_batch(rt.db_path, db_items)
           rt.engine.add_to_index(embeddings, doc_ids=doc_ids)
           rt.engine.save()
           return doc_ids
   ```
4. **`github_ingest` Background Worker**:
   Batch document inserts and final `rt.engine.save()` acquire `with rt.lock:`.
5. **`_rebuild_runtime` (`POST /rebuild`)**:
   Index rebuild logic acquires `with rt.lock:` during FAISS index clear, embedding batches, and index save.

## 4. Verification Plan

### Automated Tests
1. **Regression Test**: Run `.venv/bin/pytest` to ensure all 50 existing unit and E2E tests pass without regressions.
2. **Concurrency Unit Test**: Add `tests/unit/test_concurrency.py` testing:
   - **Parallel Ingestion Across Notebooks**: Two threads ingesting concurrently into Notebook A and Notebook B execute in parallel without deadlock or blocking.
   - **Same-Notebook Serial Writes**: Concurrent requests targeting the same notebook acquire `rt.lock` sequentially and maintain DB/index consistency.
