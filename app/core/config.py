import os
from pathlib import Path

# Base directory is the parent of 'app' (i.e., project_root)
BASE_DIR = Path(__file__).resolve().parent.parent.parent
# DOCSEEK_DATA_DIR overrides where all persistent state lives (used by the
# e2e test suite to run against an isolated throwaway directory).
DATA_DIR = Path(os.environ.get("DOCSEEK_DATA_DIR", BASE_DIR / "data"))

# Ensure data directory exists
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Per-notebook path resolvers
NOTEBOOKS_DIR = DATA_DIR / "notebooks"
NOTEBOOKS_DIR.mkdir(parents=True, exist_ok=True)
NOTEBOOKS_REGISTRY = DATA_DIR / "notebooks.json"


def notebook_dir(nb_id: str) -> Path:
    d = NOTEBOOKS_DIR / nb_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path(nb_id: str) -> str:
    return str(notebook_dir(nb_id) / "docs.db")


def index_path(nb_id: str) -> str:
    return str(notebook_dir(nb_id) / "my_index.faiss")


def upload_dir(nb_id: str) -> Path:
    d = notebook_dir(nb_id) / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def audio_dir(nb_id: str) -> Path:
    d = notebook_dir(nb_id) / "audio"
    d.mkdir(parents=True, exist_ok=True)
    return d

# Max accepted upload size (bytes). ponytail: read() still buffers in RAM;
# true fix is streaming with a running size guard. Cap keeps a single request
# from OOMing the process.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB

# Settings
# ponytail: default to nomic-ai/nomic-embed-text-v1.5 for 8192 token context length (768 vector dimension)
MODEL_NAME = os.environ.get("DOCSEEK_EMBED_MODEL", "nomic-ai/nomic-embed-text-v1.5")
EMBEDDING_DIM = int(os.environ.get("DOCSEEK_EMBED_DIM", "768"))

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
# Recommended lightweight models for fast local agentic RAG & reliable JSON:
#   - `qwen2.5:1.5b` or `qwen2.5:3b` (fastest response, highly reliable JSON parsing)
#   - `granite3.1-dense:2b` (128k context, extremely low VRAM footprint)
#   - `phi3:mini` (fallback, 3.8B parameters)
LLM_MODEL = os.environ.get("DOCSEEK_LLM_MODEL", "qwen2.5:1.5b")
LLM_LIGHT_MODEL = os.environ.get("DOCSEEK_LLM_LIGHT_MODEL", LLM_MODEL)
LLM_TEMPERATURE = 0.3
LLM_MAX_TOKENS = 1024

# Ollama keep_alive: how long the model stays resident in RAM/VRAM.
# Default 5m frees RAM on mid/low-tier hardware when inactive.
LLM_KEEP_ALIVE = os.environ.get("DOCSEEK_LLM_KEEP_ALIVE", "5m")

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

# Upper bound on sections in a deep research report.
RESEARCH_MAX_SECTIONS = 6

# Idle timeout in seconds before unloading audio models (STT/TTS) to release RAM/VRAM.
DOCSEEK_AUDIO_IDLE_TIMEOUT_SECONDS = float(
    os.getenv("DOCSEEK_AUDIO_IDLE_TIMEOUT_SECONDS", "60")
)

# ---------------------------------------------------------------------------
# Web Research (search the web via a local SearXNG instance, extract content,
# and import into the notebook's RAG database).
# ---------------------------------------------------------------------------

# SearXNG endpoint. Start with: docker compose up -d
SEARXNG_URL = os.environ.get("DOCSEEK_SEARXNG_URL", "http://localhost:8080")

# Enable Crawl4AI browser fallback for JS-heavy pages (requires Playwright +
# Chromium ~200MB). trafilatura handles 90%+ of pages without this.
CRAWL4AI_ENABLED = os.environ.get("DOCSEEK_CRAWL4AI_ENABLED", "false").lower() == "true"

# Max results per web search query.
RESEARCH_MAX_RESULTS = int(os.environ.get("DOCSEEK_RESEARCH_MAX_RESULTS", "10"))

# Upper bound on extracted text per web page (chars) to prevent memory bloat on large pages.
MAX_WEB_EXTRACT_CHARS = int(os.environ.get("DOCSEEK_MAX_WEB_EXTRACT_CHARS", "25000"))

# Maximum batch size for sentence-transformer embeddings to prevent memory spikes.
MAX_EMBED_BATCH_SIZE = int(os.environ.get("DOCSEEK_MAX_EMBED_BATCH_SIZE", "32"))

