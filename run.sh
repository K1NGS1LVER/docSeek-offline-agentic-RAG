#!/bin/bash
# Launches backend + frontend together, prefixing each line with [backend]/[frontend].

cd "$(dirname "$0")"

PYTHON=".venv/bin/python"
if [ ! -f "$PYTHON" ]; then
    echo "Error: Virtual environment not found at .venv"
    exit 1
fi

trap 'kill 0' EXIT INT TERM

$PYTHON -m app.server 2>&1 | sed -u 's/^/[backend]  /' &
(cd frontend && npm run dev) 2>&1 | sed -u 's/^/[frontend] /' &

wait
