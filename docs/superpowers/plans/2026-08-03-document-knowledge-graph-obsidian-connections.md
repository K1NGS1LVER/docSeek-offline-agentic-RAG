# Knowledge Graph Obsidian-Style True Connections Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dense fully-connected "hairball" graph with sparse, structured, true connections like Obsidian. This includes:
1. **Dedicated Tag Nodes**: Extract unique tags and represent them as separate green hub nodes, rather than drawing pairwise links between documents.
2. **Explicit Reference Extraction**: Parse document chunk contents for wikilinks (`[[target]]`), markdown links (`[label](target.md)`), and explicit filename mentions to draw bright, direct reference links.
3. **k-Nearest Neighbor (k-NN) Semantic Similarity**: Limit similarity edges to the top-$k$ nearest neighbors (e.g. $k=2$) for each document, preventing mesh network clutter.

---

### Task 1: Backend Structured Connection Engine

**Files:**
- Modify: `app/core/graph.py`
- Modify: `app/core/database.py`
- Modify: `tests/test_graph.py`

- [ ] **Step 1: Implement `parse_explicit_references` in `app/core/graph.py`**
  ```python
  def parse_explicit_references(content: str, doc_targets: List[Dict[str, Any]]) -> List[str]:
      """Scans document text for explicit wikilinks, markdown links, or filename mentions to target documents."""
      matched_ids = []
      content_lower = content.lower()
      for target in doc_targets:
          target_id = target["id"]
          filename = os.path.basename(target_id).lower()
          stem, _ = os.path.splitext(filename)
          
          # Wiki-links: [[setup]] or [[setup.md]]
          wikilink_pattern = rf"\[\[([^\]]*?{re.escape(stem)}[^\]]*?)\]\]"
          if re.search(wikilink_pattern, content_lower):
              matched_ids.append(target_id)
              continue
              
          # Markdown links: [setup](docs/setup.md)
          markdown_pattern = rf"\]\([^\)]*?{re.escape(stem)}[^\)]*?\)"
          if re.search(markdown_pattern, content_lower):
              matched_ids.append(target_id)
              continue
              
          # Literal filename mentions with extension: setup.md
          filename_pattern = rf"\b{re.escape(filename)}\b"
          if re.search(filename_pattern, content_lower):
              matched_ids.append(target_id)
              continue
      return matched_ids
  ```

- [ ] **Step 2: Update `build_graph_data` in `app/core/graph.py`**
  - **Document Nodes**: Store full concatenated content of all chunks per document for reference scanning.
  - **Tag Nodes**: Extract unique tags from documents, create tag nodes (`is_tag=True`), and link documents directly to their tag nodes (type `'tag'`).
  - **Explicit Link Extraction**: Call `parse_explicit_references` for each document and add direct reference edges (type `'reference'`).
  - **k-NN Similarity Edges**: For each document with a centroid, calculate similarity with all other documents, sort descending, and add similarity edges (type `'similarity'`) only for the **top 2 nearest neighbors** (where $\text{similarity} \ge \text{min\_similarity}$).
  - Prevent duplicate undirected edges (e.g. A-B and B-A).

- [ ] **Step 3: Update `tests/test_graph.py`**
  - Adapt mock tests to match the new tag node structure and k-NN bounds.
  - Add `test_parse_explicit_references` unit test.

- [ ] **Step 4: Verify backend tests**
  - Command: `.venv/bin/python -m pytest tests/test_graph.py tests/e2e/test_graph_api.py -v`

- [ ] **Step 5: Commit backend fixes**
  - Commit message: `feat(backend): implement tag hubs, explicit wikilink parser, and k-NN semantic similarity`

---

### Task 2: Frontend Edge Contrast & Tag Visuals

**Files:**
- Modify: `frontend/src/components/GraphCanvas.jsx`
- Modify: `frontend/src/components/DocumentDrawer.jsx`

- [ ] **Step 1: Style edge types in `GraphCanvas.jsx`**
  - Differentiate styling inside the edge loop:
    - **`reference` edges**: Bright, highly visible accent lines (`rgba(217, 119, 6, 0.7)` / light `rgba(163, 72, 10, 0.7)`).
    - **`tag` edges**: Soft green strokes (`palette.tagStroke`).
    - **`similarity` edges**: Dim background guidelines (`rgba(217, 119, 6, 0.12)` / light `rgba(163, 72, 10, 0.15)`).

- [ ] **Step 2: Update `DocumentDrawer.jsx` layout and styles**
  - Fix drawer absolute positioning offset by changing `top-14` to `top-0` and `h-[calc(100vh-56px)]` to `h-full` so it aligns perfectly with the main content area height.
  - Adapt connected neighbors logic to cleanly count and display link relationships from tag hub nodes and reference connections.

- [ ] **Step 3: Verify frontend build & linting**
  - Command: `cd frontend && npm run lint && npm run build`

- [ ] **Step 4: Commit frontend fixes**
  - Commit message: `style(frontend): improve visual contrast for links and fix DocumentDrawer layout position`
