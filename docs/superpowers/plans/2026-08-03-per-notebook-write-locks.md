# Per-Notebook Write Locks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global `_ingest_lock` with per-notebook `rt.lock` write locks in `app/server.py` to enable concurrent ingestion across different notebooks.

**Architecture:** Extend the `Runtime` tuple to include a `lock: threading.Lock` field created lazily in `get_runtime(nb_id)`. Replace all occurrences of `_ingest_lock` in ingestion endpoints and background workers with `rt.lock`, ensuring per-notebook isolation and thread-safe persistence.

**Tech Stack:** Python 3.14, FastAPI, FAISS, SQLite, `threading.Lock`, `pytest`

## Global Constraints

- Preserve all existing API route signatures and behavior.
- Ensure all FAISS index mutations (`rt.engine.add_to_index`, `rt.engine.save`) and SQLite batch inserts (`database.insert_documents_batch`) happen under `with rt.lock:`.
- Ensure zero regressions across existing test suite (`.venv/bin/pytest`).

---

### Task 1: Update `Runtime` Data Structure and Evict Global `_ingest_lock`

**Files:**
- Modify: `app/server.py:75-95`
- Test: `tests/unit/test_model_unloading.py` (or pytest run)

**Interfaces:**
- Consumes: Python `threading.Lock`
- Produces: `Runtime = namedtuple("Runtime", ["db_path", "engine", "lock"])` and `get_runtime(nb_id: str) -> Runtime` with `rt.lock`

- [ ] **Step 1: Write the failing test for `Runtime.lock` existence**

Create or update test in `tests/unit/test_runtime_lock.py`:

```python
import threading
from app.server import Runtime

def test_runtime_tuple_has_lock():
    rt = Runtime(db_path=":memory:", engine=None, lock=threading.Lock())
    assert hasattr(rt, "lock")
    assert isinstance(rt.lock, type(threading.Lock()))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/test_runtime_lock.py -v`  
Expected: FAIL with `TypeError: Runtime.__new__() missing 1 required positional argument: 'lock'`

- [ ] **Step 3: Update `Runtime` namedtuple and `get_runtime` in `app/server.py`**

In `app/server.py`:
Update line 75:
```python
Runtime = namedtuple("Runtime", ["db_path", "engine", "lock"])
```
Update lines 80-93:
```python
def get_runtime(nb_id: str) -> Runtime:
    if notebooks.get_notebook(nb_id) is None:
        raise HTTPException(status_code=404, detail=f"Notebook '{nb_id}' not found")
    with _runtimes_lock:
        rt = _runtimes.get(nb_id)
        if rt is None:
            engine = VectorEngine(nb_index_path(nb_id))
            rt = Runtime(db_path=nb_db_path(nb_id), engine=engine, lock=threading.Lock())
            # Auto-rebuild this notebook's index if its DB has docs but index is empty.
            if database.get_document_count(rt.db_path) > 0 and engine.get_total_vectors() == 0:
                _rebuild_runtime(rt)
            _runtimes[nb_id] = rt
        return rt
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/pytest tests/unit/test_runtime_lock.py -v`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/server.py tests/unit/test_runtime_lock.py
git commit -m "refactor: add lock field to Runtime namedtuple"
```

---

### Task 2: Replace `_ingest_lock` with `rt.lock` Across Ingestion & Rebuild Functions

**Files:**
- Modify: `app/server.py:195-225, 624-675, 1440-1455, 1629-1640`
- Remove: Global `_ingest_lock = threading.Lock()` definition (line 195)

**Interfaces:**
- Consumes: `rt.lock` from `get_runtime(nb_id)`
- Produces: Per-notebook locked writes in `_persist_chunks`, `ingest_document`, `ingest_documents_batch`, `github_ingest`, and `_rebuild_runtime`

- [ ] **Step 1: Write tests verifying per-notebook write locking**

In `tests/unit/test_runtime_lock.py`:

```python
import threading
import time
from app.server import Runtime

def test_per_notebook_lock_independence():
    rt1 = Runtime(db_path="db1", engine=None, lock=threading.Lock())
    rt2 = Runtime(db_path="db2", engine=None, lock=threading.Lock())
    
    acquired1 = False
    acquired2 = False

    def hold_lock_1():
        nonlocal acquired1
        with rt1.lock:
            acquired1 = True
            time.sleep(0.1)

    def hold_lock_2():
        nonlocal acquired2
        with rt2.lock:
            acquired2 = True

    t1 = threading.Thread(target=hold_lock_1)
    t2 = threading.Thread(target=hold_lock_2)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert acquired1 and acquired2
```

- [ ] **Step 2: Run test to verify it passes**

Run: `.venv/bin/pytest tests/unit/test_runtime_lock.py -v`  
Expected: PASS

- [ ] **Step 3: Refactor `app/server.py` to use `rt.lock`**

1. Remove global `_ingest_lock = threading.Lock()` at line 195.
2. Update `_persist_chunks`:
```python
def _persist_chunks(rt: "Runtime", chunks, embeddings, safe_name, file_path, strategy_used, extra_meta=None):
    with rt.lock:
        db_items = []
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
            db_items.append({"content": chunk_text, "metadata": json.dumps(meta)})
        
        doc_ids = database.insert_documents_batch(rt.db_path, db_items)
        rt.engine.add_to_index(embeddings, doc_ids=doc_ids)
        rt.engine.save()
    return doc_ids
```

3. Update `ingest_document`:
```python
@app.post("/ingest")
def ingest_document(request: IngestRequest):
    rt = get_runtime(request.notebook_id)
    vector = rt.engine.embed(request.text)
    with rt.lock:
        doc_id = database.insert_document(rt.db_path, request.text, request.metadata)
        rt.engine.add_to_index(vector, doc_ids=[doc_id])
        rt.engine.save()  # Persist index changes to disk
    return {"status": "success", "id": doc_id}
```

4. Update `ingest_documents_batch`:
```python
    def _persist():
        with rt.lock:
            db_items = [{"content": doc.text, "metadata": doc.metadata} for doc in request.documents]
            doc_ids = database.insert_documents_batch(rt.db_path, db_items)
            rt.engine.add_to_index(embeddings, doc_ids=doc_ids)
            rt.engine.save()
            return doc_ids
```

5. Update `github_ingest` background loop:
Replace `with _ingest_lock:` with `with rt.lock:` at lines 1441 and 1449.

6. Update `_rebuild_runtime`:
```python
def _rebuild_runtime(rt: "Runtime"):
    """Rebuild one notebook's FAISS index from all documents in its DB."""
    import faiss
    with rt.lock:
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
```

- [ ] **Step 4: Verify existing tests and new unit tests pass**

Run: `.venv/bin/pytest -v`  
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/server.py tests/unit/test_runtime_lock.py
git commit -m "feat: replace global _ingest_lock with per-notebook rt.lock"
```

---

### Task 3: Comprehensive Concurrency Integration Testing & Verification

**Files:**
- Create: `tests/unit/test_concurrency.py`

**Interfaces:**
- Consumes: `/ingest`, `/upload`, `get_runtime`
- Produces: Test verification of multi-notebook concurrent ingestion and single-notebook serialized safety.

- [ ] **Step 1: Write integration tests for multi-notebook concurrency**

Create `tests/unit/test_concurrency.py`:

```python
import pytest
import threading
import time
from app.core import notebooks
from app.server import get_runtime, ingest_document, IngestRequest

def test_concurrent_ingestion_across_notebooks(tmp_path):
    nb1 = notebooks.create_notebook("Notebook 1", "📓")
    nb2 = notebooks.create_notebook("Notebook 2", "📘")

    errors = []

    def ingest_nb1():
        try:
            for i in range(10):
                ingest_document(IngestRequest(text=f"Doc NB1 #{i}", notebook_id=nb1["id"]))
        except Exception as e:
            errors.append(e)

    def ingest_nb2():
        try:
            for i in range(10):
                ingest_document(IngestRequest(text=f"Doc NB2 #{i}", notebook_id=nb2["id"]))
        except Exception as e:
            errors.append(e)

    t1 = threading.Thread(target=ingest_nb1)
    t2 = threading.Thread(target=ingest_nb2)
    
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert len(errors) == 0

    rt1 = get_runtime(nb1["id"])
    rt2 = get_runtime(nb2["id"])

    assert rt1.engine.get_total_vectors() == 10
    assert rt2.engine.get_total_vectors() == 10

    # Cleanup
    notebooks.delete_notebook(nb1["id"])
    notebooks.delete_notebook(nb2["id"])
```

- [ ] **Step 2: Run concurrency test**

Run: `.venv/bin/pytest tests/unit/test_concurrency.py -v`  
Expected: PASS

- [ ] **Step 3: Run complete pytest suite**

Run: `.venv/bin/pytest`  
Expected: 100% PASS across all unit and E2E tests.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/test_concurrency.py
git commit -m "test: add concurrent multi-notebook ingestion unit test"
```
