import os
from pathlib import Path

# Base directory is the parent of 'app' (i.e., project_root)
BASE_DIR = Path(__file__).resolve().parent.parent.parent
# DOCSEEK_DATA_DIR overrides where all persistent state lives (used by the
# e2e test suite to run against an isolated throwaway directory).
DATA_DIR = Path(os.environ.get("DOCSEEK_DATA_DIR", BASE_DIR / "data"))

# Ensure data directory exists
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Max accepted upload size (bytes). ponytail: read() still buffers in RAM;
# true fix is streaming with a running size guard. Cap keeps a single request
# from OOMing the process.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB

# File Paths
DB_PATH = str(DATA_DIR / "docs.db")
INDEX_PATH = str(DATA_DIR / "my_index.faiss")

# Settings
MODEL_NAME = "all-mpnet-base-v2"
EMBEDDING_DIM = 768  # Matches mpnet
# MODEL_NAME = "all-MiniLM-L6-v2"
# EMBEDDING_DIM = 384

# Server settings
HOST = "0.0.0.0"
PORT = int(os.environ.get("DOCSEEK_PORT", "8000"))

# Environment setup
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

# LLM Settings (Ollama). DOCSEEK_LLM_BASE_URL overrides for tests and
# non-default Ollama setups.
LLM_BASE_URL = os.environ.get("DOCSEEK_LLM_BASE_URL", "http://localhost:11434/v1")
# phi3:mini is fine for planning/grading JSON, but too weak for podcast scripts
# and research reports. Pull a stronger local model (e.g. `qwen3:8b` or
# `llama3.1:8b`) and set DOCSEEK_LLM_MODEL to use it; nothing hard-depends on it.
LLM_MODEL = os.environ.get("DOCSEEK_LLM_MODEL", "phi3:mini")
LLM_TEMPERATURE = 0.3
LLM_MAX_TOKENS = 1024

# Ollama keep_alive: how long the model stays resident. -1 = never unload.
LLM_KEEP_ALIVE = -1

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

# Hybrid retrieval: fuse dense (FAISS) and keyword (FTS5/BM25) results.
HYBRID_SEARCH = True
RRF_K = 60  # Reciprocal Rank Fusion constant (standard default)

# ---------------------------------------------------------------------------
# Agentic RAG (all local: planning/grading via Ollama, reranking via a local
# cross-encoder, semantic chunking via the local embedding model).
# ---------------------------------------------------------------------------

# Master switch. When False (or when Ollama is unreachable) /ask degrades to
# plain hybrid retrieval with heuristic parameter defaults.
AGENTIC_RAG = True

# Local cross-encoder used to rescore retrieved candidates (~80MB, CPU-friendly).
RERANK_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"

# How many candidates to over-fetch for the reranker (multiplier on final k).
RERANK_CANDIDATE_FACTOR = 3

# Max extra retrieval loops the agent may take when it grades evidence as weak.
MAX_AGENT_LOOPS = 2

# Bounds for the agent's dynamic top-k choice.
AGENT_MIN_K = 3
AGENT_MAX_K = 12

# Default chunking strategy for ingestion: "auto" | "recursive" | "semantic".
# "auto" profiles each document and picks per document.
CHUNKING_STRATEGY = "auto"

# ---------------------------------------------------------------------------
# Local media features (all on-device, same one-time-download model story as
# the embedder/reranker): speech-to-text dictation, text-to-speech podcasts,
# and deep research reports.
# ---------------------------------------------------------------------------

# faster-whisper (CTranslate2) model size for /transcribe dictation.
# "small" balances accuracy and CPU cost; "base"/"tiny" are faster, "medium"
# more accurate. Auto-downloads once from HuggingFace, then cached.
STT_MODEL = os.environ.get("DOCSEEK_STT_MODEL", "small")

# Kokoro-82M TTS voices for the two-host podcast (host A / host B).
# Full voice list ships with the `kokoro` package.
TTS_VOICE_A = os.environ.get("DOCSEEK_TTS_VOICE_A", "af_heart")
TTS_VOICE_B = os.environ.get("DOCSEEK_TTS_VOICE_B", "am_michael")

# Generated podcast WAVs + their JSON metadata sidecars live here.
AUDIO_DIR = DATA_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# Upper bound on sections in a deep research report.
RESEARCH_MAX_SECTIONS = 6
