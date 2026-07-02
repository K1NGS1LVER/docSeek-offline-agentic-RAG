# docSeek Robustness, Latency & Hybrid Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix concurrency/security/correctness holes in the RAG backend, cut answer latency, and add hybrid (keyword + semantic) retrieval - without adding new services or heavy frameworks.

**Architecture:** Keep the existing FastAPI + FAISS(IndexIDMap/IndexFlatIP) + SQLite + Ollama design. Add a thread lock around the shared FAISS index, move CPU embedding off the async event loop, harden upload/CORS/destructive endpoints, replace the O(n) metadata `LIKE` scan with a real indexed column, keep the Ollama model warm, and add BM25 keyword search via SQLite's built-in FTS5 fused with dense results using Reciprocal Rank Fusion.

**Tech Stack:** Python 3.14, FastAPI/Starlette, faiss-cpu, sentence-transformers (`all-mpnet-base-v2`), SQLite (stdlib `sqlite3`, FTS5 built in), Ollama (`phi3:mini`) via `openai` async client.

## Global Constraints

- No new runtime dependencies. Everything uses stdlib or already-installed packages (`requirements.txt`: fastapi, uvicorn, pydantic, sentence-transformers, faiss-cpu, numpy, requests, beautifulsoup4, python-multipart, python-docx, openai, sse-starlette).
- No pytest in this repo. Verification is standalone `assert`-based scripts run with `.venv/bin/python` plus `curl` against a running server (`./run_server.sh`).
- Do not use an em dash in any file. Plain dash only.
- In Markdown, one sentence per physical line.
- The DB-id == FAISS-id invariant is load-bearing. Any code adding vectors MUST pass matching `doc_ids`. Never break it.
- `MODEL_NAME` and `EMBEDDING_DIM` must stay in sync (`config.py`). Changing the model requires `POST /rebuild`.
- Commit after every task.

## Out of scope (deliberate, per architecture review)

- LangGraph: the flow is linear (retrieve -> context -> generate). A graph framework earns its weight only for cyclic/agentic RAG (query rewrite, re-retrieval loops, self-critique). Add it later if those appear. Not now.
- Open Knowledge Format / knowledge-graph layer: additive only, and only when a concrete multi-hop query type demonstrably fails with hybrid RAG. Not speculatively.
- Switching embedding model to MiniLM: left as a one-line config flip; not part of this plan.

---

### Task 1: Thread-safe VectorEngine

The FAISS index is mutated from a background daemon thread (`_github_ingest_worker`) while request handlers call `search`.
`faiss` `add_with_ids` / `search` / `write_index` are not safe to run concurrently on one index object.
Add one reentrant lock guarding all index access.

**Files:**
- Modify: `app/core/engine.py`

**Interfaces:**
- Produces: `VectorEngine` with an internal `self._lock` (threading.RLock). Public method signatures unchanged: `embed(text)->np.ndarray`, `embed_batch(list)->np.ndarray`, `add_to_index(vectors, doc_ids=None)`, `search(query_vector, k=5)->(indices, scores)`, `save()`, `get_total_vectors()->int`, `remove_ids(doc_ids: list)` (added in Task 7).

- [ ] **Step 1: Add the lock import and attribute**

In `app/core/engine.py`, add `import threading` at the top with the other imports, and in `__init__` (after `self.index` is finally assigned in every branch) add:

```python
        # Guards all index mutate/search/save. Reentrant so save() can be
        # called from inside a locked add. FAISS index objects are not
        # thread-safe and the GitHub ingest worker runs in a daemon thread.
        self._lock = threading.RLock()
```

Place the `self._lock = threading.RLock()` line at the END of `__init__` so it exists regardless of which index-creation branch ran.

- [ ] **Step 2: Wrap the mutating/reading index methods**

Wrap the bodies of `add_to_index`, `search`, `save`, and `get_total_vectors` so every FAISS access is under `self._lock`. Example for `search`:

```python
    def search(self, query_vector: np.ndarray, k: int = 5):
        """Search for top-k nearest neighbors. Returns (doc_ids, scores)."""
        try:
            query_vector = query_vector.astype("float32")
            with self._lock:
                actual_k = min(k, self.index.ntotal) if self.index.ntotal > 0 else 0
                if actual_k == 0:
                    return np.array([]), np.array([])
                distances, indices = self.index.search(query_vector, actual_k)
            return indices[0], distances[0]
        except Exception as e:
            logger.error(f"Search failed (k={k}): {e}")
            return np.array([]), np.array([])
```

Do the same for `add_to_index` (wrap from the `if doc_ids is not None` block through `self.index.add_with_ids(...)`), `save` (wrap the `faiss.write_index` call), and `get_total_vectors` (wrap the `return self.index.ntotal`).
`embed` / `embed_batch` do NOT touch the index - leave them unlocked.

- [ ] **Step 3: Concurrency self-check**

Create `scripts/check_engine_lock.py`:

```python
"""Hammer the engine from many threads; must not crash or corrupt count."""
import threading
import numpy as np
from app.core.engine import VectorEngine

def main():
    eng = VectorEngine()
    start = eng.get_total_vectors()
    dim = eng.dimension
    errors = []

    def writer(base):
        try:
            for i in range(20):
                vec = np.random.rand(1, dim).astype("float32")
                eng.add_to_index(vec, doc_ids=[10_000_000 + base * 100 + i])
        except Exception as e:  # noqa
            errors.append(e)

    def reader():
        try:
            for _ in range(50):
                q = np.random.rand(1, dim).astype("float32")
                eng.search(q, 5)
        except Exception as e:  # noqa
            errors.append(e)

    threads = [threading.Thread(target=writer, args=(b,)) for b in range(4)]
    threads += [threading.Thread(target=reader) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"Concurrent access raised: {errors}"
    added = eng.get_total_vectors() - start
    assert added == 80, f"Expected 80 new vectors, got {added}"
    # Clean up the junk ids we added
    eng.remove_ids([10_000_000 + b * 100 + i for b in range(4) for i in range(20)])
    print("OK: engine lock holds under concurrent read/write")

if __name__ == "__main__":
    main()
```

Note: this check calls `eng.remove_ids` (Task 7). Run it AFTER Task 7 is merged, or temporarily drop the cleanup line and run now. If running now, comment the `eng.remove_ids(...)` line.

- [ ] **Step 4: Run the check**

Run: `.venv/bin/python -m scripts.check_engine_lock`
Expected: `OK: engine lock holds under concurrent read/write` (no traceback).
Note: this loads/saves the real index. Run against a disposable `data/` or accept that 80 junk vectors get cleaned up by the last line.

- [ ] **Step 5: Commit**

```bash
git add app/core/engine.py scripts/check_engine_lock.py
git commit -m "fix(engine): guard FAISS index with a lock for concurrent access"
```

---

### Task 2: Stop redundant index saves during ingest

`add_to_index` auto-saves whenever `ntotal % 50 == 0`, and every caller ALSO calls `engine.save()` after.
`save()` rewrites the entire index file. During bulk ingest this thrashes disk.
Remove the auto-save; callers already persist at the right boundaries.

**Files:**
- Modify: `app/core/engine.py`

**Interfaces:**
- Consumes: Task 1 lock.
- Produces: `add_to_index` no longer calls `save()` internally. Callers remain responsible for `engine.save()` (they already are: `server.py` upload/ingest/github/rebuild all call it).

- [ ] **Step 1: Delete the auto-save block**

In `app/core/engine.py`, in `add_to_index`, remove:

```python
            # Auto-save every 50 vectors
            if self.index.ntotal % 50 == 0:
                self.save()
```

- [ ] **Step 2: Verify callers still save**

Grep to confirm every write path persists:
Run: `grep -rn "engine.save()\|\.save()" app/server.py`
Expected: matches inside `/upload`, `/upload-multiple`, `/ingest`, `_github_ingest_worker`, `_rebuild_index`, and lifespan shutdown. If any write path lacks a trailing `engine.save()`, add it.

- [ ] **Step 3: Commit**

```bash
git add app/core/engine.py
git commit -m "perf(engine): drop redundant auto-save; callers persist explicitly"
```

---

### Task 3: Move CPU embedding off the async event loop

`/upload`, `/upload-multiple`, and `/ask` are `async def` but call `engine.embed` / `engine.embed_batch` synchronously.
sentence-transformers is heavy CPU work, so it blocks the entire event loop and stalls all other requests.
Offload those calls with `starlette.concurrency.run_in_threadpool`.

**Files:**
- Modify: `app/server.py`

**Interfaces:**
- Consumes: `engine.embed_batch`, `engine.embed` (unchanged, now thread-safe on the index but embedding itself is model-only).
- Produces: no signature changes; handlers now `await run_in_threadpool(...)` around blocking embed calls.

- [ ] **Step 1: Add the import**

Near the top of `app/server.py` with the other imports:

```python
from starlette.concurrency import run_in_threadpool
```

- [ ] **Step 2: Offload embedding in `/upload`**

In `upload_file`, replace:

```python
        embed_start = time.time()
        embeddings = engine.embed_batch(chunk_texts)
        embed_time = time.time() - embed_start
```

with:

```python
        embed_start = time.time()
        embeddings = await run_in_threadpool(engine.embed_batch, chunk_texts)
        embed_time = time.time() - embed_start
```

- [ ] **Step 3: Offload embedding in `/upload-multiple`**

In `upload_multiple_files`, replace `embeddings = engine.embed_batch(chunk_texts)` with:

```python
            embeddings = await run_in_threadpool(engine.embed_batch, chunk_texts)
```

- [ ] **Step 4: Offload embedding in `/ask`**

In `ask`, replace:

```python
        query_vector = engine.embed(request.query)
        top_indices, scores = engine.search(query_vector, request.k)
```

with:

```python
        query_vector = await run_in_threadpool(engine.embed, request.query)
        top_indices, scores = await run_in_threadpool(engine.search, query_vector, request.k)
```

- [ ] **Step 5: Verify server boots and endpoints respond**

Start the server: `./run_server.sh` (in a background terminal).
Run:
```bash
curl -s -X POST localhost:8000/ingest -H 'Content-Type: application/json' \
  -d '{"text":"The mitochondria is the powerhouse of the cell.","metadata":"{\"filename\":\"bio.txt\",\"source_file\":\"bio.txt\",\"chunk_index\":0,\"total_chunks\":1}"}'
curl -s -X POST localhost:8000/search -H 'Content-Type: application/json' \
  -d '{"query":"what makes energy in cells","k":3}'
```
Expected: ingest returns `{"status":"success","id":...}`; search returns a JSON array with the mitochondria chunk and a score above 0.20.

- [ ] **Step 6: Commit**

```bash
git add app/server.py
git commit -m "perf(api): run embedding in threadpool to keep event loop responsive"
```

---

### Task 4: Harden file upload (status codes, path traversal, size cap)

Three defects in `/upload` (and `/upload-multiple`):
1. `raise HTTPException(400)` inside the `try` is swallowed by `except Exception` and re-raised as 500.
2. `UPLOAD_DIR / file.filename` trusts a client-controlled name - `../` escapes the upload dir.
3. `await file.read()` loads the whole file into memory with no size cap - OOM/DoS.

**Files:**
- Modify: `app/server.py`
- Modify: `app/core/config.py`

**Interfaces:**
- Consumes: `UPLOAD_DIR` from config.
- Produces: `MAX_UPLOAD_BYTES: int` in `config.py`; a module-level helper `_safe_upload_path(filename: str) -> tuple[str, pathlib.Path]` in `server.py` returning `(safe_name, absolute_path)` and raising `HTTPException(400)` on an unsafe/empty name.

- [ ] **Step 1: Add size limit to config**

In `app/core/config.py`, after the upload dir setup, add:

```python
# Max accepted upload size (bytes). ponytail: read() still buffers in RAM;
# true fix is streaming with a running size guard. Cap keeps a single request
# from OOMing the process.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB
```

- [ ] **Step 2: Add the safe-path helper and import**

In `app/server.py`, add `import pathlib` near the top, import the new config value:

```python
from app.core.config import (
    MODEL_NAME,
    EMBEDDING_DIM,
    HOST,
    PORT,
    DB_PATH,
    INDEX_PATH,
    UPLOAD_DIR,
    MAX_UPLOAD_BYTES,
)
```

and add this helper in the HELPER FUNCTIONS section:

```python
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
```

- [ ] **Step 3: Use the helper + size cap + fix status swallow in `/upload`**

In `upload_file`, replace the top of the `try` block:

```python
    try:
        # Save the uploaded file
        file_path = UPLOAD_DIR / file.filename
        content = await file.read()

        with open(file_path, "wb") as f:
            f.write(content)
```

with:

```python
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
```

Then update every later reference to `file.filename` in this function to use `safe_name` (the `filename=file.filename` in the metadata dict, the log lines, and the return payload `"filename": file.filename` -> `"filename": safe_name`).
Finally, fix the status-code swallow: change the tail of the function from:

```python
    except Exception as e:
        logger.error(f"Error uploading file: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
```

to:

```python
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading file: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
```

- [ ] **Step 4: Apply safe path + size cap in `/upload-multiple`**

In `upload_multiple_files`, inside the per-file `try`, replace:

```python
            # Save the uploaded file
            file_path = UPLOAD_DIR / file.filename
            content = await file.read()

            with open(file_path, "wb") as f:
                f.write(content)
```

with:

```python
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
```

and replace the remaining `file.filename` references in this function's per-file body with `safe_name`.
Note: `_safe_upload_path` may raise `HTTPException` for a bad name; the outer `except Exception` will catch it and append a failed result - acceptable for the multi-file endpoint.

- [ ] **Step 5: Verify traversal is blocked and status codes are correct**

With the server running:
```bash
# Path traversal attempt must be rejected, not written outside uploads
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8000/upload \
  -F 'file=@app/core/config.py;filename=../../evil.py'
# Unsupported type must be 400, not 500
printf 'hello' > /tmp/x.bin
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8000/upload \
  -F 'file=@/tmp/x.bin'
```
Expected: first returns `400`; second returns `400`.
Confirm no file named `evil.py` exists above the uploads dir: `ls data/../../evil.py 2>/dev/null && echo LEAK || echo safe` -> `safe`.

- [ ] **Step 6: Commit**

```bash
git add app/server.py app/core/config.py
git commit -m "fix(upload): block path traversal, cap size, preserve 4xx status codes"
```

---

### Task 5: Lock down CORS and gate destructive endpoints

`allow_origins=["*"]` with `allow_credentials=True` is an invalid combo browsers reject, and `DELETE /reset` + `POST /rebuild` are wide open - any page can wipe the corpus.
Pin origins from config, and require an admin token (only enforced if one is configured, so local dev stays frictionless).

**Files:**
- Modify: `app/core/config.py`
- Modify: `app/server.py`

**Interfaces:**
- Produces: `CORS_ORIGINS: list[str]` and `ADMIN_TOKEN: str | None` in config; a dependency `require_admin(x_admin_token: str | None = Header(None))` in `server.py` that raises `HTTPException(401)` when `ADMIN_TOKEN` is set and the header does not match.

- [ ] **Step 1: Add config values**

In `app/core/config.py`, add:

```python
# CORS: explicit origins (credentials cannot be combined with "*").
# Override with CORS_ORIGINS env var (comma-separated).
CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CORS_ORIGINS", "http://localhost:5173,http://localhost:3000"
    ).split(",")
    if o.strip()
]

# When set, destructive endpoints require the X-Admin-Token header to match.
# Unset (None) = open, for frictionless local dev.
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN") or None
```

- [ ] **Step 2: Wire CORS from config**

In `app/server.py`, import the new values (add `CORS_ORIGINS, ADMIN_TOKEN` to the `from app.core.config import (...)` block) and change the middleware:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

- [ ] **Step 3: Add the admin dependency**

Add `Header` to the fastapi import (`from fastapi import FastAPI, HTTPException, Query, File, UploadFile, Header, Depends`) and define:

```python
def require_admin(x_admin_token: Optional[str] = Header(None)):
    """Gate for destructive endpoints. No-op when ADMIN_TOKEN is unset."""
    if ADMIN_TOKEN and x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Admin token required")
```

- [ ] **Step 4: Protect `/reset` and `/rebuild`**

Change the decorators:

```python
@app.delete("/reset")
def reset_system(_: None = Depends(require_admin)):
```

```python
@app.post("/rebuild")
def rebuild_index(_: None = Depends(require_admin)):
```

- [ ] **Step 5: Verify gate behavior**

With the server running and no `ADMIN_TOKEN` set, `/reset` stays open (dev default). To verify the gate, restart with a token:
```bash
ADMIN_TOKEN=secret ./run_server.sh   # in a background terminal
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE localhost:8000/reset            # expect 401
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE localhost:8000/reset -H 'X-Admin-Token: secret'  # expect 200
```
Expected: `401` then `200`.

- [ ] **Step 6: Commit**

```bash
git add app/server.py app/core/config.py
git commit -m "fix(security): pin CORS origins and gate destructive endpoints with admin token"
```

---

### Task 6: Replace metadata LIKE scan with an indexed source_file column

`fetch_chunks_by_source` does `metadata LIKE '%"source_file": "..."%'` - a full-table scan on every `/document/view`, brittle to JSON formatting.
Add a real `source_file` column populated on insert (parsed from metadata, so call sites do not change), backfill existing rows, and index it.

**Files:**
- Modify: `app/core/database.py`

**Interfaces:**
- Consumes: existing `insert_document(content, metadata)` call sites (unchanged signature).
- Produces: `documents.source_file` TEXT column with an index; `insert_document` now also writes `source_file` (extracted from the metadata JSON); `fetch_chunks_by_source(source_file)` queries the column with `=` instead of `LIKE`; `init_db()` runs an idempotent migration + backfill.

- [ ] **Step 1: Migrate schema + backfill in `init_db`**

In `app/core/database.py`, add `import json` at the top, and replace `init_db` with:

```python
def init_db():
    """Initialize SQLite database and run idempotent migrations."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                metadata TEXT,
                source_file TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """
        )
        # Migration: add source_file to pre-existing tables.
        cols = {row[1] for row in cursor.execute("PRAGMA table_info(documents)")}
        if "source_file" not in cols:
            cursor.execute("ALTER TABLE documents ADD COLUMN source_file TEXT")
        # Backfill any NULL source_file from the metadata JSON.
        rows = cursor.execute(
            "SELECT id, metadata FROM documents WHERE source_file IS NULL AND metadata IS NOT NULL"
        ).fetchall()
        for row_id, meta in rows:
            try:
                sf = json.loads(meta).get("source_file")
            except Exception:
                sf = None
            if sf:
                cursor.execute(
                    "UPDATE documents SET source_file = ? WHERE id = ?", (sf, row_id)
                )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_documents_source_file ON documents(source_file)"
        )
        conn.commit()
    print(f"Database initialized at {DB_PATH}")
```

- [ ] **Step 2: Populate source_file on insert**

Replace `insert_document` with:

```python
def insert_document(content: str, metadata: Optional[str] = None) -> int:
    """Insert document and return its ID. Extracts source_file from metadata."""
    source_file = None
    if metadata:
        try:
            source_file = json.loads(metadata).get("source_file")
        except Exception:
            source_file = None
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO documents (content, metadata, source_file) VALUES (?, ?, ?)",
            (content, metadata, source_file),
        )
        doc_id = cursor.lastrowid
        conn.commit()
    return doc_id
```

- [ ] **Step 3: Rewrite `fetch_chunks_by_source` to use the column**

Replace it with:

```python
def fetch_chunks_by_source(source_file: str) -> List[Dict[str, Any]]:
    """Fetch all chunks sharing a source_file, via the indexed column."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, content, metadata FROM documents WHERE source_file = ?",
            (source_file,),
        )
        rows = cursor.fetchall()
    return [{"id": row[0], "content": row[1], "metadata": row[2]} for row in rows]
```

- [ ] **Step 4: Migration + query self-check**

Create `scripts/check_source_column.py`:

```python
"""Verify migration backfills source_file and grouped fetch works."""
import json
from app.core import database

def main():
    database.init_db()
    meta = json.dumps({"source_file": "sc_test.txt", "filename": "sc_test.txt",
                       "chunk_index": 0, "total_chunks": 2})
    a = database.insert_document("chunk A", meta)
    meta2 = json.dumps({"source_file": "sc_test.txt", "filename": "sc_test.txt",
                        "chunk_index": 1, "total_chunks": 2})
    b = database.insert_document("chunk B", meta2)

    got = database.fetch_chunks_by_source("sc_test.txt")
    ids = {r["id"] for r in got}
    assert {a, b} <= ids, f"grouped fetch missing rows: {ids}"

    # Confirm the column (not a LIKE scan) is populated.
    with database.get_db() as conn:
        row = conn.execute(
            "SELECT source_file FROM documents WHERE id = ?", (a,)
        ).fetchone()
    assert row[0] == "sc_test.txt", f"source_file not populated: {row}"
    print("OK: source_file column populated and queryable")

if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run the check**

Run: `.venv/bin/python -m scripts.check_source_column`
Expected: `OK: source_file column populated and queryable`.

- [ ] **Step 6: Commit**

```bash
git add app/core/database.py scripts/check_source_column.py
git commit -m "perf(db): index source_file column, drop O(n) metadata LIKE scan"
```

---

### Task 7: Document deletion (index + DB)

Currently the only way to remove a doc is `/reset` (nuke everything).
Add `remove_ids` to the engine, a DB delete, and a `DELETE /documents` endpoint that removes a whole source file's chunks by name.

**Files:**
- Modify: `app/core/engine.py`
- Modify: `app/core/database.py`
- Modify: `app/server.py`

**Interfaces:**
- Consumes: Task 1 `self._lock`; Task 6 `source_file` column.
- Produces:
  - `VectorEngine.remove_ids(doc_ids: list) -> int` (count removed).
  - `database.delete_documents_by_source(source_file: str) -> list[int]` (returns deleted ids).
  - `DELETE /documents?source_file=...` endpoint gated by `require_admin` (Task 5), returns `{"status": "success", "deleted": <count>}`.

- [ ] **Step 1: Add `remove_ids` to the engine**

In `app/core/engine.py`, add:

```python
    def remove_ids(self, doc_ids: list) -> int:
        """Remove vectors by their DB ids. Returns count removed."""
        if not doc_ids:
            return 0
        ids = np.array(doc_ids, dtype=np.int64)
        with self._lock:
            removed = self.index.remove_ids(ids)
        return int(removed)
```

- [ ] **Step 2: Add DB delete-by-source**

In `app/core/database.py`, add:

```python
def delete_documents_by_source(source_file: str) -> List[int]:
    """Delete all chunks for a source_file. Returns the deleted ids."""
    with get_db() as conn:
        cursor = conn.cursor()
        ids = [
            row[0]
            for row in cursor.execute(
                "SELECT id FROM documents WHERE source_file = ?", (source_file,)
            )
        ]
        if ids:
            cursor.execute(
                "DELETE FROM documents WHERE source_file = ?", (source_file,)
            )
            conn.commit()
    return ids
```

- [ ] **Step 3: Add the endpoint**

In `app/server.py`, near the other document routes, add:

```python
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
```

- [ ] **Step 4: Round-trip self-check**

Create `scripts/check_delete.py`:

```python
"""Insert, index, delete, confirm gone from both DB and FAISS."""
import json
from app.core import database
from app.core.engine import VectorEngine

def main():
    database.init_db()
    eng = VectorEngine()
    before = eng.get_total_vectors()

    meta = json.dumps({"source_file": "del_test.txt", "filename": "del_test.txt",
                       "chunk_index": 0, "total_chunks": 1})
    doc_id = database.insert_document("delete me", meta)
    vec = eng.embed("delete me")
    eng.add_to_index(vec, doc_ids=[doc_id])
    assert eng.get_total_vectors() == before + 1

    ids = database.delete_documents_by_source("del_test.txt")
    removed = eng.remove_ids(ids)
    assert removed == 1, f"expected 1 removed, got {removed}"
    assert eng.get_total_vectors() == before, "vector count did not return to baseline"
    assert database.fetch_chunks_by_source("del_test.txt") == [], "DB rows remain"
    print("OK: delete removes rows from DB and vectors from index")

if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run the check**

Run: `.venv/bin/python -m scripts.check_delete`
Expected: `OK: delete removes rows from DB and vectors from index`.

- [ ] **Step 6: Commit**

```bash
git add app/core/engine.py app/core/database.py app/server.py scripts/check_delete.py
git commit -m "feat(api): delete a document's chunks from DB and FAISS index"
```

---

### Task 8: Keep the Ollama model warm

Ollama unloads `phi3:mini` after idle, so the first `/ask` reloads the model - multi-second time-to-first-token.
Warm it at startup and pass `keep_alive` so it stays resident. Biggest easy latency win.

**Files:**
- Modify: `app/core/config.py`
- Modify: `app/core/llm.py`
- Modify: `app/server.py`

**Interfaces:**
- Produces: `LLM_KEEP_ALIVE` in config; `OllamaLLM.stream_answer` passes `extra_body={"keep_alive": LLM_KEEP_ALIVE}`; `OllamaLLM.warmup()` async method issuing a tiny generation; lifespan calls `await llm.warmup()` on startup.

- [ ] **Step 1: Add config**

In `app/core/config.py`, after the LLM settings:

```python
# Ollama keep_alive: how long the model stays resident. -1 = never unload.
LLM_KEEP_ALIVE = -1
```

- [ ] **Step 2: Pass keep_alive on generation**

In `app/core/llm.py`, import it (`from .config import LLM_BASE_URL, LLM_MODEL, LLM_TEMPERATURE, LLM_MAX_TOKENS, LLM_KEEP_ALIVE`) and add `extra_body={"keep_alive": LLM_KEEP_ALIVE}` to the `create` call:

```python
            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                temperature=LLM_TEMPERATURE,
                max_tokens=LLM_MAX_TOKENS,
                stream=True,
                extra_body={"keep_alive": LLM_KEEP_ALIVE},
            )
```

- [ ] **Step 3: Add a warmup method**

In `OllamaLLM`, add:

```python
    async def warmup(self):
        """Load the model into memory so the first real /ask is fast."""
        try:
            await self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": "ok"}],
                max_tokens=1,
                extra_body={"keep_alive": LLM_KEEP_ALIVE},
            )
            logger.info(f"LLM warmed up: {self.model}")
        except Exception as e:
            logger.warning(f"LLM warmup skipped ({e}). Is Ollama running?")
```

- [ ] **Step 4: Warm up at startup**

In `app/server.py` lifespan, after `llm = OllamaLLM()` and before the yield, add:

```python
    await llm.warmup()
```

- [ ] **Step 5: Verify warmup logs and model stays loaded**

Start the server (Ollama must be running with `phi3:mini` pulled).
Expected startup log line: `LLM warmed up: phi3:mini` (or a warning if Ollama is down - non-fatal).
Then: `curl -s localhost:11434/api/ps` should list `phi3:mini` as loaded.
Time an ask (should have low TTFT on the first call):
```bash
curl -N -s -X POST localhost:8000/ask -H 'Content-Type: application/json' \
  -d '{"query":"what is the powerhouse of the cell","k":3}'
```
Expected: streamed answer tokens begin quickly (no cold-load stall).

- [ ] **Step 6: Commit**

```bash
git add app/core/config.py app/core/llm.py app/server.py
git commit -m "perf(llm): warm Ollama at startup and keep the model resident"
```

---

### Task 9: Tune chunk size for retrieval quality and prompt size

300-char chunks (~60 tokens) fragment context and inflate vector count.
`all-mpnet-base-v2` handles ~384 tokens.
Larger chunks improve retrieval quality and let `/ask` use fewer, richer chunks.
Existing indexes must be rebuilt after this change.

**Files:**
- Modify: `app/core/parsing.py`

**Interfaces:**
- Produces: `CHUNK_SIZE = 1000`, `CHUNK_OVERLAP = 150`. `chunk_text` signature and return type unchanged (`List[Tuple[str, int, int]]`).

- [ ] **Step 1: Bump the constants**

In `app/core/parsing.py`:

```python
CHUNK_SIZE = 1000  # Characters per chunk (~200 tokens, well under mpnet's 384)
CHUNK_OVERLAP = 150  # Overlap between chunks
```

- [ ] **Step 2: Chunking self-check**

Create `scripts/check_chunking.py`:

```python
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
```

- [ ] **Step 3: Run the check**

Run: `.venv/bin/python -m scripts.check_chunking`
Expected: `OK: N chunks, ...`.

- [ ] **Step 4: Rebuild note + verify**

Existing data was chunked at 300 chars; new ingests use 1000.
To normalize existing content, re-ingest sources or call rebuild (rebuild re-embeds existing DB rows AS-IS - it does NOT re-chunk, so old rows stay 300-char). For a clean corpus, re-upload sources after this change.
Document this in the commit body.

- [ ] **Step 5: Commit**

```bash
git add app/core/parsing.py scripts/check_chunking.py
git commit -m "tune(chunking): 1000/150 char chunks for better retrieval; re-ingest to apply"
```

---

### Task 10: Hybrid retrieval (FTS5 keyword + dense) with Reciprocal Rank Fusion

Dense retrieval misses exact terms, rare tokens, IDs, and code symbols.
Add BM25 keyword search using SQLite's built-in FTS5 (no new dependency), and fuse the two ranked lists with Reciprocal Rank Fusion.
This is the biggest retrieval-quality upgrade.

**Files:**
- Modify: `app/core/database.py`
- Modify: `app/core/config.py`
- Create: `app/core/fusion.py`
- Modify: `app/server.py`

**Interfaces:**
- Consumes: Task 6 schema; the dense path already in `/search` and `/ask`.
- Produces:
  - FTS5 virtual table `documents_fts` synced to `documents` via triggers; `database.keyword_search(query: str, k: int) -> list[int]` returning DB ids ranked best-first by BM25.
  - `fusion.reciprocal_rank_fusion(rankings: list[list[int]], k: int = 60) -> list[int]` returning fused ids best-first.
  - `HYBRID_SEARCH: bool` and `RRF_K: int` in config.
  - `/search` and `/ask` fuse dense + keyword ids when `HYBRID_SEARCH` is on, then fetch/score from the dense results (keyword-only hits get their dense score if present, else are included with score 0 and skipped by the threshold - see Step 5).

- [ ] **Step 1: Add config toggles**

In `app/core/config.py`:

```python
# Hybrid retrieval: fuse dense (FAISS) and keyword (FTS5/BM25) results.
HYBRID_SEARCH = True
RRF_K = 60  # Reciprocal Rank Fusion constant (standard default)
```

- [ ] **Step 2: Create the FTS5 table + triggers in `init_db`**

In `app/core/database.py` `init_db`, after the index creation and before `conn.commit()`, add:

```python
        # FTS5 full-text mirror of documents.content for BM25 keyword search.
        cursor.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
            USING fts5(content, content='documents', content_rowid='id')
            """
        )
        cursor.execute(
            """
            CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
            END
            """
        )
        cursor.execute(
            """
            CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, content)
                VALUES ('delete', old.id, old.content);
            END
            """
        )
        cursor.execute(
            """
            CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
                INSERT INTO documents_fts(documents_fts, rowid, content)
                VALUES ('delete', old.id, old.content);
                INSERT INTO documents_fts(rowid, content) VALUES (new.id, new.content);
            END
            """
        )
        # Backfill FTS for rows that predate the virtual table.
        cursor.execute("SELECT count(*) FROM documents_fts")
        if cursor.fetchone()[0] == 0:
            cursor.execute(
                "INSERT INTO documents_fts(rowid, content) SELECT id, content FROM documents"
            )
```

- [ ] **Step 3: Add `keyword_search`**

In `app/core/database.py`:

```python
def keyword_search(query: str, k: int) -> List[int]:
    """BM25 keyword search over content via FTS5. Returns DB ids, best first."""
    if not query.strip():
        return []
    # FTS5 MATCH needs a query; quote the whole thing to treat it as a phrase
    # of terms and avoid syntax errors on punctuation.
    match = '"' + query.replace('"', '""') + '"'
    with get_db() as conn:
        cursor = conn.cursor()
        try:
            rows = cursor.execute(
                "SELECT rowid FROM documents_fts WHERE documents_fts MATCH ? "
                "ORDER BY bm25(documents_fts) LIMIT ?",
                (match, k),
            ).fetchall()
        except Exception:
            return []
    return [row[0] for row in rows]
```

- [ ] **Step 4: Create the fusion helper**

Create `app/core/fusion.py`:

```python
"""Reciprocal Rank Fusion for combining ranked result lists."""
from typing import List


def reciprocal_rank_fusion(rankings: List[List[int]], k: int = 60) -> List[int]:
    """Fuse multiple ranked id lists into one, best-first.

    RRF score for an id = sum over lists of 1 / (k + rank), rank starting at 1.
    k dampens the influence of low-ranked items; 60 is the standard default.
    """
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores, key=lambda d: scores[d], reverse=True)


if __name__ == "__main__":
    # Self-check: an id ranked high in both lists must win.
    dense = [1, 2, 3]
    keyword = [3, 4, 1]
    fused = reciprocal_rank_fusion([dense, keyword])
    assert fused[0] in (1, 3), fused
    assert set(fused) == {1, 2, 3, 4}, fused
    assert reciprocal_rank_fusion([]) == []
    print("OK: RRF fuses and ranks correctly")
```

- [ ] **Step 5: Wire hybrid into `/search`**

In `app/server.py`, import the new pieces (`from app.core.config import ... HYBRID_SEARCH, RRF_K` and `from app.core.fusion import reciprocal_rank_fusion`), then rework `search`:

```python
@app.post("/search", response_model=List[SearchResult])
def search(request: SearchRequest):
    if engine.get_total_vectors() == 0:
        return []

    query_vector = engine.embed(request.query)
    top_indices, scores = engine.search(query_vector, request.k)

    # Dense scores keyed by id (used for the returned score + threshold).
    dense_scores = {
        int(idx): float(sc)
        for idx, sc in zip(top_indices, scores)
        if idx != -1
    }

    if HYBRID_SEARCH:
        dense_ids = [int(i) for i in top_indices if i != -1]
        kw_ids = database.keyword_search(request.query, request.k)
        ordered_ids = reciprocal_rank_fusion([dense_ids, kw_ids], k=RRF_K)[: request.k]
    else:
        ordered_ids = [int(i) for i in top_indices if i != -1]

    logger.info(
        f"Search '{request.query}' hybrid={HYBRID_SEARCH} -> {len(ordered_ids)} candidates"
    )
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
            # Drop weak dense-only hits, but keep if keyword also matched.
            if doc_id not in database.keyword_search(request.query, request.k):
                continue
        source_data = None
        if doc.get("metadata"):
            try:
                source_data = json.loads(doc["metadata"])
            except Exception:
                source_data = {"raw": doc["metadata"]}
        results.append(
            SearchResult(id=doc_id, score=score, content=doc["content"], source=source_data)
        )
    return results
```

Note: the double `keyword_search` call is acceptable (FTS5 is fast and indexed). ponytail: if it shows up in profiling, hoist the kw list into a set once above and reuse.

- [ ] **Step 6: Wire hybrid into `/ask`**

In `ask`, replace the dense-only retrieval/build block with the fused version:

```python
        query_vector = await run_in_threadpool(engine.embed, request.query)
        top_indices, scores = await run_in_threadpool(engine.search, query_vector, request.k)

        dense_scores = {
            int(idx): float(sc) for idx, sc in zip(top_indices, scores) if idx != -1
        }
        if HYBRID_SEARCH:
            dense_ids = [int(i) for i in top_indices if i != -1]
            kw_ids = database.keyword_search(request.query, request.k)
            ordered_ids = reciprocal_rank_fusion([dense_ids, kw_ids], k=RRF_K)[: request.k]
        else:
            ordered_ids = [int(i) for i in top_indices if i != -1]

        documents = database.fetch_documents_by_ids(ordered_ids) if ordered_ids else []
        doc_map = {doc["id"]: doc for doc in documents}

        search_results = []
        for doc_id in ordered_ids:
            doc = doc_map.get(doc_id)
            if doc is None:
                continue
            score = dense_scores.get(doc_id, 0.0)
            source_data = None
            if doc.get("metadata"):
                try:
                    source_data = json.loads(doc["metadata"])
                except Exception:
                    source_data = {"raw": doc["metadata"]}
            search_results.append(
                {"content": doc["content"], "score": score, "source": source_data}
            )
```

Keep the rest of `/ask` (the `if not search_results` guard, `build_context`, and streaming) unchanged.
Note: hybrid intentionally relaxes the strict `SIMILARITY_THRESHOLD` gate for keyword matches so exact-term hits are not dropped.

- [ ] **Step 7: RRF unit self-check**

Run: `.venv/bin/python app/core/fusion.py`
Expected: `OK: RRF fuses and ranks correctly`.

- [ ] **Step 8: End-to-end hybrid self-check**

Create `scripts/check_hybrid.py`:

```python
"""Keyword-only match (rare token) is retrievable via hybrid path."""
import json
from app.core import database
from app.core.engine import VectorEngine
from app.core.fusion import reciprocal_rank_fusion

def main():
    database.init_db()
    eng = VectorEngine()
    meta = json.dumps({"source_file": "hy_test.txt", "filename": "hy_test.txt",
                       "chunk_index": 0, "total_chunks": 1})
    doc_id = database.insert_document(
        "The error code XZ9271Q indicates a coolant pump failure.", meta
    )
    eng.add_to_index(eng.embed("The error code XZ9271Q indicates a coolant pump failure."),
                     doc_ids=[doc_id])

    # A rare token is exactly where dense retrieval is weakest and BM25 shines.
    kw = database.keyword_search("XZ9271Q", 5)
    assert doc_id in kw, f"keyword search missed exact token: {kw}"

    dense_ids = [int(i) for i in eng.search(eng.embed("XZ9271Q"), 5)[0] if i != -1]
    fused = reciprocal_rank_fusion([dense_ids, kw])
    assert doc_id in fused, f"fusion dropped the keyword hit: {fused}"

    database.delete_documents_by_source("hy_test.txt")
    eng.remove_ids([doc_id])
    print("OK: hybrid retrieves exact-token match dense search would miss")

if __name__ == "__main__":
    main()
```

- [ ] **Step 9: Run the checks**

Run: `.venv/bin/python -m scripts.check_hybrid`
Expected: `OK: hybrid retrieves exact-token match dense search would miss`.
Then with the server running:
```bash
curl -s -X POST localhost:8000/search -H 'Content-Type: application/json' \
  -d '{"query":"XZ9271Q","k":5}'
```
Expected: the coolant-pump chunk returned (keyword path), even though it is a rare token dense search alone would rank poorly.

- [ ] **Step 10: Commit**

```bash
git add app/core/database.py app/core/config.py app/core/fusion.py app/server.py scripts/check_hybrid.py
git commit -m "feat(search): hybrid BM25 (FTS5) + dense retrieval fused with RRF"
```

---

## Self-Review

**Spec coverage** (against the architecture review):
- Thread-safety race -> Task 1.
- Redundant index saves -> Task 2.
- Event-loop-blocking embedding -> Task 3.
- HTTPException swallow + path traversal + upload size -> Task 4.
- CORS misconfig + open destructive endpoints -> Task 5.
- O(n) metadata LIKE scan -> Task 6.
- No document deletion -> Task 7.
- LLM cold-start latency -> Task 8.
- Tiny chunks -> Task 9.
- Hybrid keyword + semantic + fusion -> Task 10.
- LangGraph / OKF -> explicitly out of scope, with rationale.

**Type consistency:** `remove_ids(doc_ids: list) -> int` used identically in Tasks 1, 7, 10.
`keyword_search(query, k) -> list[int]` and `reciprocal_rank_fusion(rankings, k=60) -> list[int]` consistent across Task 10 call sites.
`source_file` column name consistent Tasks 6, 7, 10.
`fetch_chunks_by_source` / `delete_documents_by_source` both key on the same column.

**Ordering note:** Task 1's self-check references `remove_ids` from Task 7. Step 3 of Task 1 documents running it after Task 7 or commenting the cleanup line. Everything else is forward-only.

**Placeholder scan:** no TBD/TODO/"handle edge cases"; every code step shows real code; every check step shows the command and expected output.
