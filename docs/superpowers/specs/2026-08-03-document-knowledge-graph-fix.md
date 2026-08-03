# Design Specification: Knowledge Graph Data Loading & Header Layout Fix

**Date**: 2026-08-03  
**Status**: Approved  
**Target Feature**: Document Knowledge Graph Data Loading & Header Controls Layout  

---

## 1. Overview & Goal

This specification addresses two critical issues identified from user feedback and screenshots:
1. **Empty Graph Bug**: Documents in notebooks were missing from the knowledge graph because `list_sources()` strictly filtered out `NULL`/empty `source_file` records, and `VectorEngine` did not expose a method to extract stored vector embeddings from FAISS.
2. **Header Overlay Collision**: `GraphControls.jsx` was previously rendered as an absolute floating card (`top-4 left-4 absolute`) hovering over and covering the **Back to Notebook** button and title.

---

## 2. Technical Architecture & Solutions

### A. Backend Embedding Extraction & Robust Source Resolution
- **`VectorEngine.get_embeddings_map()` (`app/core/engine.py`)**:
  - Reconstructs 384-dim float vectors for all chunk IDs stored in FAISS using `index.reconstruct(id)`.
- **`app/server.py` (`get_graph_data`)**:
  - Calls `chunk_embeddings_map = rt.engine.get_embeddings_map()` to pass real chunk vectors to `build_graph_data`.
- **`list_sources(db_path)` (`app/core/database.py`)**:
  - Uses `COALESCE(NULLIF(source_file, ''), json_extract(metadata, '$.source_file'), json_extract(metadata, '$.source'), json_extract(metadata, '$.filename'), json_extract(metadata, '$.title'), 'Document #' || MIN(id))` to group chunks by effective source name.
  - Guarantees 100% of ingested files, PDFs, text notes, and documents in any notebook are represented as nodes.

### B. Header Layout & Controls Integration
- **`GraphPage.jsx`**:
  - Header: `<header className="h-14 flex-shrink-0 flex items-center justify-between px-6 bg-surface border-b border-border z-10 shadow-sm">`.
  - **Top-Left**: `<Link to={notebookId ? \`/app/\${notebookId}\` : '/app'}>` Back button (`<ArrowLeft className="w-4 h-4 text-accent" /> Back to Notebook`), vertical divider, and serif title (`docSeek Knowledge Graph`).
  - **Top-Right**: Renders `<GraphControls>` as an inline horizontal toolbar (`flex items-center gap-3`).
- **`GraphControls.jsx`**:
  - Renders inline horizontal controls (`flex items-center gap-3 text-text text-xs`), completely removing the `absolute top-4 left-4` floating card wrapper.
  - Contains Search input, Cutoff slider, Force slider, Reset button, and Theme toggle.

---

## 3. Verification Plan

- **Automated Tests**:
  - Backend pytest suite: `.venv/bin/python -m pytest tests/test_graph.py tests/e2e/test_graph_api.py -v`.
  - Frontend production build & lint: `cd frontend && npm run lint && npm run build`.
- **Manual Verification**:
  - Open notebook graph `/app/:notebookId/graph`.
  - Verify all notebook documents render as nodes on the 2D canvas.
  - Verify top-left Back button is 100% visible and un-obscured by controls.
