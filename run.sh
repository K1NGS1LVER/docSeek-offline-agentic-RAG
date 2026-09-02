#!/bin/bash
# Launches backend + frontend together, prefixing each line with [backend]/[frontend].

cd "$(dirname "$0")"

PYTHON=".venv/bin/python"
if [ ! -f "$PYTHON" ]; then
    echo "Error: Virtual environment not found at .venv"
    exit 1
fi

# Start SearXNG for web research if Docker daemon is available
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo "==> Starting SearXNG search engine (Docker)..."
    docker compose up -d 2>&1 | sed 's/^/[searxng]  /'
else
    echo "==> Docker not running. Using built-in DuckDuckGo search fallback."
fi

trap 'kill 0' EXIT INT TERM

$PYTHON -m app.server 2>&1 | sed -u 's/^/[backend]  /' &
(cd frontend && npm run dev) 2>&1 | sed -u 's/^/[frontend] /' &

wait
