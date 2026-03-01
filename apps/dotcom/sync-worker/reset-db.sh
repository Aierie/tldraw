#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${SIMPLE_SYNC_WORKER_BASE_URL:-http://127.0.0.1:8790}"
ROOM_ID="${1:-demo-room}"

if curl --silent --show-error --fail -X POST "${BASE_URL}/__test__/room/${ROOM_ID}/reset" >/dev/null; then
	echo "Reset room '${ROOM_ID}' via ${BASE_URL}/__test__/room/${ROOM_ID}/reset"
else
	echo "Falling back to filesystem reset (.wrangler/state)"
	rm -rf .wrangler/state
fi
