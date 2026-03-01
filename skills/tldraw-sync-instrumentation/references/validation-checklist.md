# Validation checklist for tldraw sync instrumentation

Run from the `tldraw` repo root.

## 1) Fast static checks

- Lint touched files or the nearest package-level lint target.
- Run typecheck if instrumentation changed function signatures/context plumbing.

## 2) Targeted tests (sync-core first)

Use focused tests for adapters, room logic, and client behavior:

```bash
corepack yarn workspace @tldraw/sync-core test --run \
  src/lib/ClientWebSocketAdapter.test.ts \
  src/test/TLSocketRoom.test.ts \
  src/test/TLSyncRoom.test.ts \
  src/lib/TLSyncClient.test.ts
```

If paths differ on the branch, run the closest equivalent tests covering:

- websocket send/receive behavior
- room push/commit/rebase/discard flows
- reconnect/health-check behavior

## 3) Worker-side verification

When worker or DO instrumentation changes, run relevant worker tests/lint and verify request-level spans include status/outcomes.

## 3.5) Local OTel lab checks (when using the simple worker demo)

Run quick collection sanity checks before analyzing span topology:

```bash
# Ensure both worker and browser client services are present
curl -s http://127.0.0.1:16686/api/services | jq -r '.data[]' | sort

# Ensure file-backed sink is growing
wc -l internal/observability/otel/data/traces.jsonl
```

If `traces.jsonl` stays empty while Jaeger has spans, restart the collector stack (`corepack yarn otel:down && corepack yarn otel:up`) and retry.
If browser client service is missing, verify the page loaded after collector startup and check for browser errors to `http://127.0.0.1:4318/v1/traces`.

## 4) Trace quality checks

Confirm all of the following:

- Child spans appear under expected parents.
- Receive path and send path both emit spans.
- Non-exception outcomes are visible (`tldraw.outcome`).
- `http.status_code` is present on request spans.
- Payload snapshots are unchanged except for intentional trace changes.

## 5) Final report format

Summarize:

1. Span groups added/changed
2. Gaps closed
3. Validation commands executed and pass/fail outcome
4. Any intentionally deferred instrumentation
