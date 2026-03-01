#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Run this script inside a git working tree." >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

echo "== tldraw sync instrumentation target discovery =="
echo "repo: $repo_root"
echo

echo "-- Candidate files by path --"
git ls-files | rg -n --no-line-number \
  '(packages/sync/|packages/sync-core/|apps/.*/sync-worker/).*(TLSyncClient|TLSyncRoom|TLSocketRoom|ClientWebSocketAdapter|ServerSocketAdapter|worker|otel|DurableObject|joinExistingRoom|forwardRoomRequest).*\.(ts|tsx)$' \
  || true

echo

echo "-- Files containing span APIs --"
rg -l 'startActiveSpan\(|startSpan\(|extractTraceContext\(|propagateTraceContext\(' \
  packages apps 2>/dev/null | rg '(sync|sync-core|sync-worker)' || true

echo

echo "-- Files containing key sync handlers --"
rg -l 'handleMessage\(|handlePushRequest\(|push\(|broadcast|sendMessage\(|onRequest\(' \
  packages apps 2>/dev/null | rg '(sync|sync-core|sync-worker)' || true

echo

echo "Tip: compare outputs above and instrument equivalent layers if filenames differ on this branch."
