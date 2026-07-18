#!/usr/bin/env bash
#
# One-command setup for docSeek. Idempotent — safe to re-run.
#
# Creates the Python virtualenv, installs backend + audio (TTS) + frontend
# dependencies, and checks for the optional system tools and Ollama. It never
# hard-fails on optional pieces; it just tells you what's missing.
#
# Usage:  ./setup.sh              (uses python3)
#         PYTHON=python3.11 ./setup.sh
set -euo pipefail
cd "$(dirname "$0")"

info() { printf "\033[1;34m==>\033[0m %s\n" "$1"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$1"; }

PY="${PYTHON:-python3}"

info "Checking Python…"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Python 3.10+ is required but '$PY' was not found." >&2
  exit 1
fi
ok "$("$PY" --version)"

info "Checking optional system tools (scanned-PDF OCR + audio phonemization)…"
for bin in tesseract espeak-ng ffmpeg; do
  if command -v "$bin" >/dev/null 2>&1; then
    ok "$bin"
  else
    warn "$bin not found — install with 'brew install $bin' (macOS) or 'sudo apt-get install -y $bin' (Debian/Ubuntu)"
  fi
done

if [ ! -d .venv ]; then
  info "Creating virtualenv (.venv)…"
  "$PY" -m venv .venv
else
  info "Reusing existing .venv"
fi
VENV_PY=".venv/bin/python"

info "Installing backend Python dependencies…"
"$VENV_PY" -m pip install --upgrade pip >/dev/null
"$VENV_PY" -m pip install -r requirements.txt

info "Installing local audio / text-to-speech stack (Kokoro)…"
chmod +x scripts/install_audio.sh
PYTHON="$VENV_PY" ./scripts/install_audio.sh

info "Installing frontend dependencies…"
if command -v npm >/dev/null 2>&1; then
  (cd frontend && npm install)
  ok "frontend dependencies installed"
else
  warn "npm not found — install Node.js 18+, then run: cd frontend && npm install"
fi

info "Checking Ollama (local LLM for agentic answers)…"
if command -v ollama >/dev/null 2>&1; then
  ok "ollama found"
  if ollama list 2>/dev/null | grep -q "phi3:mini"; then
    ok "phi3:mini present"
  else
    warn "default model not pulled yet — run: ollama pull phi3:mini"
  fi
else
  warn "Ollama not found — install from https://ollama.com then 'ollama pull phi3:mini'."
  warn "(docSeek still runs without it, degrading to plain hybrid search.)"
fi

echo
ok "Setup complete."
echo
echo "Start docSeek:   ./run.sh"
echo "Then open:       http://localhost:5173"
