#!/usr/bin/env bash
# Self-contained capture: owns its preview server for the lifetime of the shot,
# so a stray pkill from another script cannot pull the ground out from under it.
#
#   tools/oneshot.sh <port> <pose> [outfile]
set -u
cd "$(dirname "$0")/.."

PORT="${1:-5340}"
POSE="${2:-hero}"
OUT="${3:-shots/final/$POSE.png}"

npx vite preview --host 127.0.0.1 --port "$PORT" --strictPort >"/tmp/pv$PORT.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for _ in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done

PORT="$PORT" node tools/longshot.mjs "$POSE" "$OUT"
