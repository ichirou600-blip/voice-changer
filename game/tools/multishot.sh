#!/usr/bin/env bash
# tools/multishot.sh <port> <pose> <outdir> <variants-json>
set -u
cd "$(dirname "$0")/.."
PORT="${1:-5340}"
npx vite preview --host 127.0.0.1 --port "$PORT" --strictPort >"/tmp/pv$PORT.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
PORT="$PORT" node tools/multishot.mjs "$2" "$3" "$4"
