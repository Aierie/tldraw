#!/usr/bin/env bash
set -euo pipefail

QUEUE_FILE="${1:-investigation/runtime-e2e/scenarios/runtime-queue.txt}"
LOG_DIR="${LOG_DIR:-investigation/runtime-e2e/results/$(date +%F_%H%M%S)}"

mkdir -p "$LOG_DIR"
SUMMARY="$LOG_DIR/summary.tsv"
: > "$SUMMARY"

if [ ! -f "$QUEUE_FILE" ]; then
  echo "Queue file not found: $QUEUE_FILE"
  exit 1
fi

run_idx=0
while IFS= read -r raw || [ -n "$raw" ]; do
  line="$(echo "$raw" | sed 's/^\s*//;s/\s*$//')"
  [ -z "$line" ] && continue
  [[ "$line" =~ ^# ]] && continue

  run_idx=$((run_idx + 1))
  name="$(printf '%02d' "$run_idx")"
  log_file="$LOG_DIR/${name}.log"

  echo "\n=== [${name}] $line ==="
  set +e
  bash -lc "$line" >"$log_file" 2>&1
  code=$?
  set -e

  if [ "$code" -eq 0 ]; then
    status="PASS"
  else
    status="FAIL"
  fi

  printf "%s\t%s\t%s\t%s\n" "$name" "$status" "$code" "$line" >> "$SUMMARY"
  echo "[$status] exit=$code log=$log_file"

done < "$QUEUE_FILE"

echo "\nWrote: $SUMMARY"
cat "$SUMMARY"
