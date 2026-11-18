#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"

# Stop both development servers when the script receives Ctrl+C.
trap 'echo "Stopping..."; kill 0' SIGINT SIGTERM EXIT

echo "Starting backend..."
(cd "$BACKEND_DIR" && npm run start:dev) &

echo "Starting frontend..."
(cd "$FRONTEND_DIR" && npm run start) &

wait
