import os
from pathlib import Path

# Base directory is the parent of 'app' (i.e., project_root)
BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = BASE_DIR / "data"

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
PORT = 8000

# Environment setup
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

# LLM Settings (Ollama)
LLM_BASE_URL = "http://localhost:11434/v1"
LLM_MODEL = "phi3:mini"
LLM_TEMPERATURE = 0.3
LLM_MAX_TOKENS = 1024

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
