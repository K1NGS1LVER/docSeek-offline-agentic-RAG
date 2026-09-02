#!/bin/bash
# Launches backend + frontend together, prefixing each line with color-coded tags.

cd "$(dirname "$0")"

# Terminal Colors & Formatting
CLR_RESET=$'\033[0m'
CLR_BOLD=$'\033[1m'
CLR_DIM=$'\033[2m'
CLR_RED=$'\033[31m'
CLR_GREEN=$'\033[32m'
CLR_YELLOW=$'\033[33m'
CLR_BLUE=$'\033[34m'
CLR_MAGENTA=$'\033[35m'
CLR_CYAN=$'\033[36m'

TAG_BACKEND="${CLR_CYAN}${CLR_BOLD}[backend]${CLR_RESET}  "
TAG_FRONTEND="${CLR_MAGENTA}${CLR_BOLD}[frontend]${CLR_RESET} "
TAG_SEARXNG="${CLR_BLUE}${CLR_BOLD}[searxng]${CLR_RESET}  "

log_info()    { echo "${CLR_BLUE}${CLR_BOLD}==>${CLR_RESET} ${CLR_BOLD}$1${CLR_RESET}"; }
log_success() { echo "${CLR_GREEN}${CLR_BOLD}==>${CLR_RESET} ${CLR_GREEN}$1${CLR_RESET}"; }
log_warn()    { echo "${CLR_YELLOW}${CLR_BOLD}==> Warning:${CLR_RESET} ${CLR_YELLOW}$1${CLR_RESET}"; }
log_error()   { echo "${CLR_RED}${CLR_BOLD}==> Error:${CLR_RESET} ${CLR_RED}$1${CLR_RESET}" >&2; }

PYTHON=".venv/bin/python"
if [ ! -f "$PYTHON" ]; then
    log_error "Virtual environment not found at .venv"
    echo "    ${CLR_DIM}Please run: python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt${CLR_RESET}"
    exit 1
fi

if [ ! -d "frontend/node_modules" ]; then
    log_info "Installing frontend dependencies..."
    (cd frontend && npm install)
fi

# Check if Ollama is running
if ! curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    log_warn "Ollama is not running on http://127.0.0.1:11434."
    echo "    ${CLR_DIM}Make sure to run 'ollama serve' for local LLM answers, suggestions, and artifacts.${CLR_RESET}"
fi

# Start SearXNG & Valkey if Docker daemon is available
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    log_info "Starting SearXNG search & Valkey cache (Docker)..."
    docker compose up -d 2>&1 | sed "s|^|${TAG_SEARXNG}|"
else
    echo "${CLR_DIM}==> Docker not running. Using built-in DuckDuckGo search and in-memory LRU cache.${CLR_RESET}"
fi

trap 'kill 0' EXIT INT TERM

$PYTHON -m app.server 2>&1 | sed -u "s|^|${TAG_BACKEND}|" &

# Wait for backend to be ready before starting frontend dev server
log_info "Waiting for backend to initialize..."
for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:8000/web-research/health >/dev/null 2>&1; then
        log_success "Backend ready on ${CLR_BOLD}http://localhost:8000${CLR_RESET}"
        break
    fi
    sleep 0.5
done

log_success "Frontend launching on ${CLR_BOLD}http://localhost:5173${CLR_RESET}"
(cd frontend && npm run dev) 2>&1 | sed -u "s|^|${TAG_FRONTEND}|" &

wait
