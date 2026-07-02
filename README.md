# RAG Search System

A high-performance **Retrieval-Augmented Generation (RAG)** system built with **FastAPI**, **FAISS**, **Sentence Transformers**, and **SQLite**. This system allows you to ingest textual documentation and perform semantic vector searches against it.

## 🚀 Features

*   **Dense Vector Search:** Uses `all-mpnet-base-v2` (state-of-the-art) for high-quality semantic embeddings.
*   **FAISS Indexing:** Fast similarity search using Facebook AI Similarity Search.
*   **Persistent Storage:** SQLite for document content and FAISS for vector data.
*   **REST API:** Fully featured API built with FastAPI.
*   **Interactive Docs:** Auto-generated Swagger UI for easy testing.
*   **Modular Design:** Clean separation of concerns (Core, Engine, DB).

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
    pip install fastapi uvicorn sentence-transformers faiss-cpu numpy sqlite3 requests beautifulsoup4
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
You can ingest Markdown, Text, or HTML files recursively.

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
     -d '{"query": "How do I use dependency injection?", "k": 3}'
```

**Via Swagger UI:**
1.  Go to `http://localhost:8000/docs`
2.  Click on `/search` -> **Try it out**
3.  Enter your query and execute.

## ⚙️ Configuration
You can adjust settings in `app/core/config.py`:
*   **MODEL_NAME:** Change embedding model (e.g., `all-MiniLM-L6-v2` for speed).
*   **EMBEDDING_DIM:** Update dimension if you change the model.
*   **HOST/PORT:** Server binding.

## 🧹 Maintenance
*   **Reset System:** Send a DELETE request to `/reset` to clear the DB and Index.
*   **Data:** All data is stored in the `data/` directory. Delete this folder to manually reset.
