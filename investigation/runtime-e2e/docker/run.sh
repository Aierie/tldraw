#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/investigation/runtime-e2e/docker/docker-compose.yml"

if [ "$#" -eq 0 ]; then
  CMD="bash"
else
  CMD="$*"
fi

exec docker compose -f "$COMPOSE_FILE" run --rm runtime-e2e bash -lc "$CMD"
