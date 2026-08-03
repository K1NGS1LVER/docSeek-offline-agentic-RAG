# Knowledge Graph Empty State Fix (Take 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the empty knowledge graph display bug by destructuring `{ data }` from the standard wrapper returned by `getGraphData()` in `GraphPage.jsx`, and fix chunk count / vector generation discrepancies by implementing fallback query routing inside `database.py` and `graph.py` when `source_file` is synthesized.

---

### Task 1: Backend Fallback Routing for Graph Node Chunks

**Files:**
- Modify: `app/core/database.py`
- Modify: `app/core/graph.py`
- Modify: `tests/test_graph.py`

- [ ] **Step 1: Implement `fetch_chunks_for_graph_node()` in `app/core/database.py`**
  ```python
  def fetch_chunks_for_graph_node(db_path: str, source_file: str, first_chunk_id: Optional[int] = None) -> List[Dict[str, Any]]:
      """Fetch chunks for a graph node. Uses source_file match first; falls back to first_chunk_id group."""
      with get_db(db_path) as conn:
          cursor = conn.cursor()
          # Try by source_file column first (real path)
          cursor.execute(
              "SELECT id, content, metadata FROM documents WHERE source_file = ?",
              (source_file,),
          )
          rows = cursor.fetchall()
          if rows:
              return [{"id": r[0], "content": r[1], "metadata": r[2]} for r in rows]
          # Fallback: if source_file is a synthesized name, try fetching the specific chunk by first_chunk_id
          if first_chunk_id is not None:
              cursor.execute(
                  "SELECT id, content, metadata FROM documents WHERE id = ?",
                  (first_chunk_id,),
              )
              rows = cursor.fetchall()
              return [{"id": r[0], "content": r[1], "metadata": r[2]} for r in rows]
      return []
  ```

- [ ] **Step 2: Update `build_graph_data()` in `app/core/graph.py` to use `fetch_chunks_for_graph_node`**
  - Replace `fetch_chunks_by_source` call with `fetch_chunks_for_graph_node(db_path, source_file, first_chunk_id)`.

- [ ] **Step 3: Run backend pytest verification**
  - Command: `.venv/bin/python -m pytest tests/test_graph.py tests/e2e/test_graph_api.py -v`

- [ ] **Step 4: Commit backend fixes**
  - Commit message: `fix(backend): use fallback query routing for graph node chunks`

---

### Task 2: Frontend API Response Destructuring

**Files:**
- Modify: `frontend/src/pages/GraphPage.jsx`

- [ ] **Step 1: Update API call in `frontend/src/pages/GraphPage.jsx` to destructure `{ data }`**
  - Change `getGraphData(...).then((data) =>` to `getGraphData(...).then(({ data }) =>`.

- [ ] **Step 2: Verify frontend build & linting**
  - Command: `cd frontend && npm run lint && npm run build`

- [ ] **Step 3: Commit frontend fix**
  - Commit message: `fix(frontend): destructure data correctly from getGraphData wrapper`
