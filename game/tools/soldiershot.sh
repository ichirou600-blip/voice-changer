#!/usr/bin/env bash
# Self-contained still-soldier capture: owns its preview server.
#   tools/soldiershot.sh <port> <outfile> [extra args to soldier.mjs...]
set -u
cd "$(dirname "$0")/.."
PORT="${1:-5571}"; OUT="${2:-shots/soldier.png}"; shift 2 || true
npx vite preview --host 127.0.0.1 --port "$PORT" --strictPort >"/tmp/pv$PORT.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
node tools/soldier.mjs --port "$PORT" --out "$OUT" "$@"
