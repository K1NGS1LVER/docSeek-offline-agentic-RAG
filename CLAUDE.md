# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

docSeek: a RAG (Retrieval-Augmented Generation) system.
FastAPI backend + FAISS vector index + SQLite for document storage, React (Vite) frontend.
Embeddings via `sentence-transformers` (`all-mpnet-base-v2`, 768-dim).
LLM answers via a local Ollama server (`phi3:mini`) through the OpenAI-compatible client.

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

There is no backend test suite or lint config in this repo currently.
`scripts/debug_model.py` and `scripts/test_embeddings_cli.py` are standalone manual debug scripts, not part of an automated suite.

### Frontend (run from `frontend/`)

```bash
npm run dev       # Vite dev server
npm run build     # production build
npm run lint      # ESLint
npm run preview   # preview production build
```

## Architecture

### Data flow

1. **Ingestion** (`POST /upload`, `/upload-multiple`, `/ingest`, `/ingest/github`, or the `app/ingest.py` CLI): raw files are parsed (`app/core/parsing.py`: markdown front-matter stripped, HTML reduced to text via BeautifulSoup), then split into overlapping character-based chunks (`chunk_text`, 300 chars / 50 overlap, breaking on sentence/paragraph boundaries when possible).
2. Each chunk is embedded (`VectorEngine.embed_batch`, L2-normalized for cosine similarity), inserted into SQLite (`app/core/database.py`, table `documents`: id/content/metadata/created_at) to get a real DB row id, then added to the FAISS index **using that DB id** via `add_to_index(..., doc_ids=...)`.
3. This DB-id-as-FAISS-id mapping (`faiss.IndexIDMap` wrapping `IndexFlatIP`) is the load-bearing design choice: search results map directly back to SQLite rows with no separate id-translation table. Any code that adds vectors without passing matching `doc_ids` will desync the index from the DB — `POST /rebuild` exists specifically to recover from that by re-embedding everything in SQLite and recreating the index from scratch.
4. **Search** (`POST /search`): embeds the query, does a FAISS top-k search, filters by `SIMILARITY_THRESHOLD = 0.20`, then fetches matching rows from SQLite by id and reassembles content + metadata (JSON blob with `source_file`, `filename`, `chunk_index`, `total_chunks`, `start_char`/`end_char`, optionally `github_repo`).
5. **Ask** (`POST /ask`): same retrieval as search, then the retrieved chunks are formatted into a context block (`OllamaLLM.build_context`) and streamed back as an LLM answer over SSE (`sse_starlette`), one JSON-encoded text delta per event. `app/core/llm.py` talks to Ollama's OpenAI-compatible endpoint (`LLM_BASE_URL` in `config.py`) — Ollama must be running locally with the configured model pulled, or streaming yields an inline error message instead of raising.
6. **Document view** (`GET /document/view?id=`): given one chunk id, looks up all sibling chunks sharing the same `source_file` in their metadata (via a SQLite `LIKE` query, no real foreign key), sorts by `chunk_index`, and renders the full reconstructed document as HTML with the requested chunk highlighted.

### Persistence and lifecycle

- All persistent state lives in `data/`: `docs.db` (SQLite) and `my_index.faiss` (FAISS index), both gitignored. `data/uploads/` keeps a copy of uploaded source files.
- On startup (`server.py` lifespan), if SQLite has documents but FAISS has zero vectors, the index is auto-rebuilt from the DB. On shutdown, the index is saved.
- `VectorEngine.__init__` defends against loading a stale/incompatible FAISS index type (anything that isn't `IndexIDMap`/`IndexIDMap2`) by discarding it and starting a fresh empty index — in that case vectors are gone until `/rebuild` is called.
- `DELETE /reset` deletes both `docs.db` and `my_index.faiss` outright and reinitializes empty.
- Config (model name/dim, paths, host/port, LLM settings) is centralized in `app/core/config.py`. Changing `MODEL_NAME` requires also updating `EMBEDDING_DIM` to match, and existing indexes built with a different model are not compatible (rebuild required).

### Frontend

- React + Vite + Tailwind v4, in `frontend/`.
- `src/lib/api.js` is the HTTP client, including SSE/streaming support for `/ask` (JSON-encoded chunks per event, matching the backend's `EventSourceResponse` framing).
- `src/lib/SystemContext.jsx` holds shared app/system state.
- `src/pages/Query.jsx` is the main search/ask UI (toggles between plain semantic Search and Ask AI streaming modes).
- Routing/pages under `src/pages/`, shared chrome under `src/components/` (Navbar, Sidebar, StatusBar, ThemeToggle, LoadingScreen).
