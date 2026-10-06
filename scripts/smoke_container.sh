#!/usr/bin/env bash
# Smoke test for the Docker stack (docker-compose.yml).
# Verifies the wiring that the unit/e2e suites don't cover: nginx /api
# prefix-strip, the proxy SSE path, and compose DNS between services.
#
# Usage: ./scripts/smoke_container.sh [--ask]
#   --ask   also run the agentic /ask SSE check (needs ollama-init finished;
#           otherwise it fails after ~2 min waiting for tokens)
#
# Exits non-zero on first failure. Assumes `docker compose up -d` already ran.
set -euo pipefail

UI="${UI:-http://127.0.0.1:5173}"
API="${API:-http://127.0.0.1:8000}"
PY="${PYTHON:-python3}"

fail() { echo "FAIL: $1" >&2; exit 1; }
note() { echo "  ok: $1"; }

command -v curl >/dev/null || fail "curl not found"
command -v "$PY" >/dev/null || fail "python3 not found"

# 1. Backend health, reached through its compose network (also proves the
#    searxng DNS alias resolves from inside the backend container).
#    Assert engine=="searxng": a bare "available:true" can come from the
#    ddgs fallback even when SearXNG is down. Retry: backend may still be
#    booting right after `up -d` (its health result is cached ~30s).
up=0
for i in $(seq 1 12); do
  if curl -sf --max-time 10 "$API/web-research/health" 2>/dev/null \
      | grep -q '"engine":"searxng"'; then up=1; break; fi
  sleep 5
done
[ "$up" = 1 ] || fail "backend health via SearXNG not available at $API"
note "backend health (searxng engine)"

# 2. Frontend serves the SPA shell.
curl -sf --max-time 10 "$UI/" | grep -qi "<title>" || fail "frontend not serving at $UI"
note "frontend serves UI"

# 3. Data path through nginx: create notebook, ingest, search.
NB=$(curl -sf --max-time 10 -X POST "$UI/api/notebooks" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke-script","emoji":"x"}' \
  | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["id"])') || fail "POST /api/notebooks through nginx"
note "notebook created ($NB)"

cleanup() { curl -s -X DELETE "$UI/api/notebooks/$NB" >/dev/null || true; }
trap cleanup EXIT

curl -sf --max-time 120 -X POST "$UI/api/ingest" \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"Container smoke test: docSeek stores documents in SQLite with a FAISS vector index.\",\"metadata\":\"{\\\"source_file\\\":\\\"smoke.txt\\\"}\",\"notebook_id\":\"$NB\"}" \
  | grep -q '"status":"success"' || fail "POST /api/ingest through nginx"
note "ingest (embedding model must be cached or downloadable)"

HIT=$(curl -sf --max-time 60 -X POST "$UI/api/search" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"where are documents stored\",\"notebook_id\":\"$NB\"}") || fail "POST /api/search through nginx"
echo "$HIT" | grep -q "FAISS vector index" || fail "search returned no expected hit"
note "search retrieves the ingested chunk"

# 4. Agentic SSE through nginx (needs qwen2.5:1.5b pulled by ollama-init).
if [[ "${1:-}" == "--ask" ]]; then
  SSE=$(curl -sfN --max-time 180 -X POST "$UI/api/ask" \
    -H 'Content-Type: application/json' \
    -d "{\"query\":\"Where are documents stored?\",\"notebook_id\":\"$NB\"}") || fail "POST /api/ask (SSE) through nginx"
  echo "$SSE" | grep -q "^event: trace" || fail "ask SSE produced no trace events"
  echo "$SSE" | grep -q "^event: results" || fail "ask SSE produced no results event"
  echo "$SSE" | grep -q "^data:" || fail "ask SSE produced no data"
  note "ask SSE streams (trace + results)"
else
  echo "  skip: ask SSE (pass --ask to run it; requires ollama-init to have finished)"
fi

echo "PASS: container smoke test"
