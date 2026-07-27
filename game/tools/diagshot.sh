#!/usr/bin/env bash
# Own the preview server for the lifetime of the probe, same as oneshot.sh.
set -u
cd "$(dirname "$0")/.."
PORT="${1:-5360}"
npx vite preview --host 127.0.0.1 --port "$PORT" --strictPort >"/tmp/pv$PORT.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
PORT="$PORT" node tools/diag.mjs
