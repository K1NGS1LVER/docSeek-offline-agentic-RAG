# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

docSeek: a local-first agentic RAG (Retrieval-Augmented Generation) system.
Privacy is the core constraint: everything runs on-device, and no external services are called at runtime (model weights are fetched once from HuggingFace, then cached).
FastAPI backend + FAISS vector index + SQLite for document storage, React (Vite) frontend.
Embeddings via `sentence-transformers` (`all-mpnet-base-v2`, 768-dim).
LLM answers, query planning, and evidence grading via a local Ollama server (`phi3:mini`) through the OpenAI-compatible client.
Reranking via a local cross-encoder (`ms-marco-MiniLM-L-6-v2`).

## Commands

### Both (run from project root)

```bash
./run.sh                             # starts backend + frontend together, output prefixed [backend]/[frontend]
```

### Backend (run from project root, uses `.venv`)

```bash
./run_server.sh                      # start the FastAPI server (http://localhost:8000, docs at /docs)
# equivalent direct call:
.venv/bin/python -m app.server

python -m app.ingest <directory> [glob_pattern]   # CLI bulk ingestion against a running server
python -m app.ingest --url <url>                  # ingest a single webpage
```

```bash
.venv/bin/python -m pytest tests/e2e      # end-to-end suite (~30s)
```

The e2e suite (`tests/e2e/`) boots a real server subprocess against an isolated temp data directory (via the `DOCSEEK_DATA_DIR` and `DOCSEEK_PORT` env overrides) and drives every flow over HTTP: ingestion with each chunking strategy, hybrid search, reranking, the agentic /ask SSE protocol, document view, deletion, and rebuild.
It never touches the real `data/` directory.
LLM-dependent assertions are structural (stages, events, ordering), so the suite passes with or without Ollama running.
There is no backend lint config in this repo currently.
`scripts/debug_model.py` and `scripts/test_embeddings_cli.py` are standalone manual debug scripts, not part of the automated suite.

### Frontend (run from `frontend/`)

```bash
npm run dev       # Vite dev server
npm run build     # production build
npm run lint      # ESLint
npm run preview   # preview production build
```

## Architecture

### Data flow

1. **Ingestion** (`POST /upload`, `/upload-multiple`, `/ingest`, `/ingest/github`, or the `app/ingest.py` CLI): raw files are parsed (`app/core/parsing.py`), then chunked via `app/core/chunking.py`.
   Supported upload types (`SUPPORTED_EXTENSIONS` in `server.py`, extracted by the single `extract_text_from_upload` helper used by both upload endpoints): `.txt`, `.md`/`.markdown` (front-matter stripped), `.html`/`.htm` (BeautifulSoup → text), `.docx` (python-docx), `.pdf` (pypdf text layer; scanned/image-only PDFs fall back to on-device Tesseract OCR via `app/core/ocr.py`, which lazily uses pypdfium2 + pytesseract and degrades gracefully when the tesseract binary is absent), and `.pptx` (python-pptx: per-slide shape text + tables).
   Three strategies: `recursive` (character budget, sentence/paragraph-boundary aware, `parsing.chunk_text`), `semantic` (sentences embedded with the local model, chunk boundaries at topic shifts where adjacent-sentence cosine distance exceeds a percentile threshold), and `auto` (default; profiles each document by length/code density/sentence count and picks per document).
   Upload endpoints accept an optional `chunking_strategy` form field; the strategy used is recorded in each chunk's metadata as `chunking`.
2. Each chunk is embedded (`VectorEngine.embed_batch`, L2-normalized for cosine similarity), inserted into SQLite (`app/core/database.py`, table `documents`: id/content/metadata/created_at) to get a real DB row id, then added to the FAISS index **using that DB id** via `add_to_index(..., doc_ids=...)`.
3. This DB-id-as-FAISS-id mapping (`faiss.IndexIDMap` wrapping `IndexFlatIP`) is the load-bearing design choice: search results map directly back to SQLite rows with no separate id-translation table. Any code that adds vectors without passing matching `doc_ids` will desync the index from the DB — `POST /rebuild` exists specifically to recover from that by re-embedding everything in SQLite and recreating the index from scratch.
4. **Search** (`POST /search`): embeds the query, does a FAISS top-k search fused with BM25 keyword results (FTS5 + Reciprocal Rank Fusion, `HYBRID_SEARCH` flag), filters by `SIMILARITY_THRESHOLD = 0.20`, then fetches matching rows from SQLite by id and reassembles content + metadata (JSON blob with `source_file`, `filename`, `chunk_index`, `total_chunks`, `start_char`/`end_char`, `chunking`, optionally `github_repo`).
   Optional `rerank: true` over-fetches `k * RERANK_CANDIDATE_FACTOR` candidates and rescores them with the local cross-encoder (`app/core/reranker.py`, lazy-loaded) before cutting to k.
   Optional `source_files` (also on `/ask`) scopes retrieval to the given sources: the matching chunk ids come from `database.get_ids_for_sources` (matches source_file, its basename, or the metadata filename), the dense search is restricted inside FAISS via `faiss.IDSelectorBatch` (never post-filtered, so a small source cannot be crowded out by a large one), and keyword hits are filtered to the same id set.
5. **Ask** (`POST /ask`): the agentic pipeline (`app/core/agent.py`, `RetrievalAgent`).
   The agent is a **LangGraph `StateGraph`** (`plan → retrieve → rerank? → grade → loop → retrieve … | END`), orchestration only (LangGraph makes no network calls, so the local-first guarantee holds).
   It plans the query with a local LLM JSON call (query type, dynamic k clamped to `AGENT_MIN_K..AGENT_MAX_K`, optional rewrite, optional sub-query decomposition, rerank decision), retrieves via the same `_retrieve_and_filter` as `/search` (multi-query results RRF-fused), optionally reranks, grades evidence sufficiency, and re-loops with a reformulated query and wider k up to `MAX_AGENT_LOOPS` extra passes.
   Nodes emit `trace` events through LangGraph's custom `StreamWriter`; `RetrievalAgent.run(query, user_k)` stays an async generator (`astream` custom+values modes) yielding the same trace dicts then a final `{"type": "results", ...}` event, so the SSE wire contract is unchanged.
   Every LLM decision has a deterministic heuristic fallback, so retrieval degrades to plain hybrid search when Ollama is unreachable.
   The response streams over SSE (`sse_starlette`) with typed events: `trace` (one per agent step), `sources` (final chunks), then unnamed events carrying JSON-encoded answer text deltas.
   Request fields: `k: null` lets the agent pick, `agentic: false` bypasses the agent, `source_files` scopes retrieval, and `AGENTIC_RAG` in config sets the default.
   Context assembly (`OllamaLLM.build_context`) numbers each chunk `[n]` by its position in the `sources` event (so the model's inline `[n]` citations map 1:1 onto what the client received), then reorders chunks best-first/best-last to mitigate "lost in the middle".
   The system prompt asks for those inline bracketed citations; the frontend renders them as clickable chips.
   `app/core/llm.py` talks to Ollama's OpenAI-compatible endpoint (`LLM_BASE_URL` in `config.py`); Ollama must be running locally with the configured model pulled, or streaming yields an inline error message instead of raising.
6. **Document view** (`GET /document/view?id=`): given one chunk id, looks up all sibling chunks sharing the same `source_file` in their metadata (via a SQLite `LIKE` query, no real foreign key), sorts by `chunk_index`, and renders the full reconstructed document as HTML with the requested chunk highlighted.
7. **Sources** (`GET /sources`): one row per source file (filename, chunk count, chunking strategy, `first_chunk_id` usable with `/document/view`), aggregated by `database.list_sources`.
   This powers the workspace Sources panel; `GET /documents` (bare filename list) remains for compatibility, and `DELETE /documents?source_file=` deletes a whole source from both DB and index.

### Local media features

These build on the same one-time-download-then-offline model story as the embedder/reranker; each lazy-loads its model on first use.

- **Dictation** (`POST /transcribe`): `app/core/stt.py` is a lazy-loaded faster-whisper singleton (`STT_MODEL`, env `DOCSEEK_STT_MODEL`, default `small`, int8/CPU) mirroring `reranker.py`'s pattern (`is_available()`, thread-safe load-on-first-use).
  The endpoint accepts a MediaRecorder audio `UploadFile` (webm/ogg/wav; faster-whisper decodes any container via bundled PyAV), runs transcription in `run_in_threadpool`, and returns `{"text", "language", "duration"}`; it reuses the `MAX_UPLOAD_BYTES` guard and returns 503 when the model can't load.
  Frontend: a push-to-talk `MicButton` in `ChatPanel`'s ask bar records via MediaRecorder, POSTs the blob through `api.js` `transcribe(blob)`, and appends the text into the query input; mic-permission denial and backend-unavailable both surface as an inline caution line.

### Persistence and lifecycle

- All persistent state lives in `data/`: `docs.db` (SQLite) and `my_index.faiss` (FAISS index), both gitignored. `data/uploads/` keeps a copy of uploaded source files.
- On startup (`server.py` lifespan), if SQLite has documents but FAISS has zero vectors, the index is auto-rebuilt from the DB. On shutdown, the index is saved.
- `VectorEngine.__init__` defends against loading a stale/incompatible FAISS index type (anything that isn't `IndexIDMap`/`IndexIDMap2`) by discarding it and starting a fresh empty index — in that case vectors are gone until `/rebuild` is called.
- `DELETE /reset` deletes both `docs.db` and `my_index.faiss` outright and reinitializes empty.
- Config (model name/dim, paths, host/port, LLM settings) is centralized in `app/core/config.py`. Changing `MODEL_NAME` requires also updating `EMBEDDING_DIM` to match, and existing indexes built with a different model are not compatible (rebuild required).

### Frontend

- React + Vite + Tailwind v4, in `frontend/`.
- Design system: `src/theme.css` is the single source of truth for ALL styling values - colors (WCAG AA-checked pairs for both themes, documented in the file), the 8pt spacing grid (4px base unit), radii, the fixed px type scale (`--fs-*`), fixed control heights (sm 32 / md 40 / lg 48), and state tokens (`--accent-hover`, `--on-accent`, `--disabled-bg`/`--disabled-fg`).
  Cream light theme is the default; warm dark via the `data-theme` attribute.
  `src/tailwind.css` maps those tokens onto Tailwind utilities via `@theme inline` (spacing utilities compile to `calc(var(--space-unit) * n)`), and `src/index.css` holds the reset/base layer plus landing-page classes.
  Cascade layering matters: index.css declares `@layer base, theme, utilities` and wraps its reset in `@layer base` so Tailwind utilities always win over the reset; component classes stay unlayered.
  Tailwind preflight is intentionally not imported; the reset in index.css strips UA button/input chrome itself.
  Never hard-code colors, fonts, sizes, or radii in components; never use spacing off the 8pt grid.
- `src/components/ui.jsx` holds the shared UI primitives (SectionLabel, Card, Button, IconButton, Segmented, Chip, Checkbox, Modal, OpRow, inputCls, textareaCls).
  All component shapes come from these primitives, never ad-hoc per page: cards/modals rounded-xl/2xl, buttons/inputs rounded-lg with fixed heights, chips/toggles pills, disabled state via the disabled tokens (never opacity).
- `src/lib/api.js` is the HTTP client, including a typed-SSE parser for `/ask` (dispatches `trace` and `sources` events to callbacks, accumulates unnamed events as the answer text; typed events never leak into answer text).
- `src/lib/SystemContext.jsx` holds shared app/system state (stats, sources, health, session logs), polled from the backend.
- Routes: `/` is the landing page (`src/pages/LandingPage.jsx`: split hero with an interactive vector-constellation canvas and a looping, clickable agentic-ask terminal demo).
  `/app` is a single NotebookLM-style three-panel workspace (`src/pages/Workspace.jsx`): Sources panel | Chat | Studio panel, plus an add-sources modal and a settings modal.
- Workspace UX (`src/components/`): `SourcesPanel` lists sources with per-source checkboxes that scope retrieval (unchecked sources are excluded via the `source_files` request field), click-to-view (document view in a new tab), and two-click delete.
  `ChatPanel` is the ask/search thread: suggested-question chips, streaming serif answers (`.answer-prose`), agent trace, inline `[n]` citation chips (bare `[n]` markers in the markdown are rewritten to links and rendered as `.citation-chip`), numbered source chips, and save-answer-to-note.
  `StudioPanel` has Notes (localStorage `ds_notes`) and Engine (stats tiles, pipeline facts, latency history, session log) tabs.
  `AddSourcesModal` handles upload queue + chunking-strategy picker + paste + GitHub ingest; it auto-opens once when the library is empty.
  `SettingsModal` holds theme, rebuild, collapsible debug console, and reset.
- `frontend/design/workspace-mockup.html` is the standalone design-language mockup (app frame + styleguide) used to review this redesign; keep it in sync only if the design language itself changes.
