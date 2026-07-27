#!/usr/bin/env bash
# Build the game, serve it on a private port, capture every camera pose, stop.
#
#   tools/capture.sh <port> <output-dir> [extra shot.mjs args...]
#
# Each agent should use its own port so concurrent runs never collide.
set -euo pipefail

PORT="${1:?usage: capture.sh <port> <outdir> [args...]}"
OUTDIR="${2:?usage: capture.sh <port> <outdir> [args...]}"
shift 2

cd "$(dirname "$0")/.."

echo "==> building"
npm run build 2>&1 | tail -5

echo "==> serving on :$PORT"
npx vite preview --host 127.0.0.1 --port "$PORT" --strictPort >/tmp/preview-$PORT.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  sleep 0.5
done

echo "==> capturing to $OUTDIR"
node tools/shot.mjs --all --dir "$OUTDIR" --base "http://127.0.0.1:$PORT/" "$@"
