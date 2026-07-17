# docSeek: Local-First Agentic RAG

A privacy-first, fully local **agentic Retrieval-Augmented Generation (RAG)** system built with **FastAPI**, **FAISS**, **Sentence Transformers**, and **SQLite**.
All retrieval, reranking, and LLM reasoning run on your device.
Nothing leaves your machine (model weights are downloaded once from HuggingFace, then everything is offline).

## 🚀 Features

*   **Agentic retrieval loop (LangGraph):** a local LLM agent, orchestrated as a LangGraph `StateGraph`, plans each query (dynamic top-k, query rewriting, sub-query decomposition), decides whether to rerank, grades the retrieved evidence, and re-loops with a reformulated query when the evidence is weak (CRAG-style). LangGraph is pure orchestration (no network calls), so the local-first guarantee is unchanged.
*   **Hybrid search:** dense vectors (FAISS, `all-mpnet-base-v2`) fused with BM25 keyword search (SQLite FTS5) via Reciprocal Rank Fusion.
*   **Local cross-encoder reranking:** `ms-marco-MiniLM-L-6-v2` rescores candidates on-device when the agent judges precision matters.
*   **Broad file support:** ingest `.txt`, `.md`, `.html`, `.docx`, `.pdf`, and `.pptx`. Scanned/image-only PDFs are read via an on-device Tesseract OCR fallback.
*   **Chunking strategies:** recursive (character/sentence-boundary), semantic (embedding-based topic-shift detection), or auto (per-document strategy selection).
*   **Transparent decisions:** every agent step streams to the UI as a trace event, so you can watch it plan, retrieve, rerank, grade, and loop.
*   **Graceful degradation:** if Ollama is down, deterministic heuristics take over and the system falls back to plain hybrid retrieval.
*   **Persistent storage:** SQLite for document content and FAISS for vector data.
*   **REST API:** fully featured API built with FastAPI, with auto-generated Swagger UI.

## 📂 Project Structure

```text
.
├── app/
│   ├── core/           # Core components
│   │   ├── config.py   # Configuration & Settings
│   │   ├── database.py # SQLite CRUD operations
│   │   └── engine.py   # FAISS & Embedding logic
│   ├── server.py       # FastAPI Application
│   └── ingest.py       # CLI Tool for ingestion
├── data/               # Persistent data (ignored by git)
│   ├── docs.db
│   └── my_index.faiss
├── scripts/            # Utility scripts
├── run.sh              # Start backend + frontend together
├── run_server.sh       # Backend-only startup helper script
└── .venv/              # Python Virtual Environment
```

## 🛠️ Installation

1.  **Clone the repository** (if applicable).
2.  **Set up the Virtual Environment:**

    ```bash
    python3 -m venv .venv
    source .venv/bin/activate
    ```

3.  **Install Dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

## 🏁 Usage

### 1. Start the Server

Start backend + frontend together (output prefixed `[backend]`/`[frontend]`):

```bash
./run.sh
```

Or backend only:

```bash
./run_server.sh
```
*   Server runs at: `http://localhost:8000`
*   Interactive Docs: `http://localhost:8000/docs`

### 2. Ingest Documentation
Upload accepts `.txt`, `.md`, `.html`, `.docx`, `.pdf`, and `.pptx`. Scanned/image-only PDFs (no text layer) fall back to on-device Tesseract OCR — install the binary with `brew install tesseract` (macOS) or `apt install tesseract-ocr` (Debian); without it, OCR is skipped and text-layer PDFs still work.

The CLI ingests Markdown, Text, or HTML files recursively.

**Syntax:**
```bash
python -m app.ingest <directory> [pattern]
```

**Example:**
```bash
# Ingest all markdown files in the 'fastapi' folder
python -m app.ingest ./fastapi/docs/en "**/*.md"
```

### 3. Search
You can search using the API or the provided Swagger UI.

**Via CURL:**
```bash
curl -X POST "http://localhost:8000/search" \
     -H "Content-Type: application/json" \
     -d '{"query": "How do I use dependency injection?", "k": 3, "rerank": true}'
```

`rerank` is optional.
When true, the server over-fetches candidates and rescores them with the local cross-encoder before returning the top k.

**Via Swagger UI:**
1.  Go to `http://localhost:8000/docs`
2.  Click on `/search` -> **Try it out**
3.  Enter your query and execute.

### 4. Ask (agentic RAG)

`POST /ask` runs the full agentic pipeline and streams the answer over SSE.

```bash
curl -N -X POST "http://localhost:8000/ask" \
     -H "Content-Type: application/json" \
     -d '{"query": "How does ingestion work?"}'
```

*   Omit `k` (or send `null`) to let the agent choose it per query.
*   Send `"agentic": false` to skip the agent and use plain hybrid retrieval.
*   The stream contains typed events: `trace` (agent decisions), `sources` (retrieved chunks), and unnamed events carrying JSON-encoded answer text deltas.

Requires a local [Ollama](https://ollama.com) server with the configured model pulled (`ollama pull phi3:mini`).
Without Ollama, retrieval still works with heuristic planning, but answer generation is unavailable.

### 5. Chunking strategies

Uploads accept an optional `chunking_strategy` form field: `auto` (default), `recursive`, or `semantic`.

```bash
curl -X POST "http://localhost:8000/upload" \
     -F "file=@my_doc.md" -F "chunking_strategy=semantic"
```

*   `recursive` splits on a character budget at sentence/paragraph boundaries.
*   `semantic` embeds sentences with the local model and places chunk boundaries at topic shifts.
*   `auto` profiles each document (length, code density, sentence count) and picks a strategy per document.

## ⚙️ Configuration
You can adjust settings in `app/core/config.py`:
*   **MODEL_NAME:** Change embedding model (e.g., `all-MiniLM-L6-v2` for speed).
*   **EMBEDDING_DIM:** Update dimension if you change the model.
*   **HOST/PORT:** Server binding.
*   **AGENTIC_RAG:** Master switch for the agentic /ask pipeline.
*   **RERANK_MODEL / RERANK_CANDIDATE_FACTOR:** Local cross-encoder and its over-fetch multiplier.
*   **MAX_AGENT_LOOPS / AGENT_MIN_K / AGENT_MAX_K:** Bounds for the agent's retry loop and dynamic top-k.
*   **CHUNKING_STRATEGY:** Default ingestion chunking strategy (`auto`, `recursive`, or `semantic`).
*   **LLM_MODEL / LLM_BASE_URL:** Local Ollama model used for planning, grading, and answers.

## ✅ Testing

```bash
.venv/bin/python -m pytest tests/e2e
```

The end-to-end suite boots a real server against an isolated temp data directory and exercises ingestion, hybrid search, reranking, the agentic ask pipeline (SSE trace/sources/answer events), document view, deletion, and index rebuild over HTTP.
Your real `data/` directory is never touched.
The suite passes with or without Ollama running (agent decisions fall back to heuristics).

## 🧹 Maintenance
*   **Reset System:** Send a DELETE request to `/reset` to clear the DB and Index.
*   **Data:** All data is stored in the `data/` directory. Delete this folder to manually reset.
