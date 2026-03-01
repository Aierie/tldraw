---
name: tldraw-otel-lab
description: Start, restart, validate, and stop the local tldraw OpenTelemetry experiment stack (collector, Jaeger, sync worker, and simple demo browser client spans) with stale-service detection and safe cleanup. Use when running sync tracing experiments, clearing traces.jsonl, diagnosing empty trace output, confirming client-span export, or tearing down local OTel services.
---

# tldraw OTel Lab

Use this skill to run repeatable local OTel tracing sessions for `tldraw` without leaving stale Docker services or stale `wrangler` worker processes.

## Run the helper script

Use `scripts/otel_lab.sh` from this skill directory:

- `scripts/otel_lab.sh up --fresh`
  - Force a clean restart of collector + Jaeger + worker.
  - Ensure `internal/observability/otel/data` and `traces.jsonl` are writable for collector file rotation.
  - Clear `internal/observability/otel/data/traces.jsonl` unless `--keep-traces` is passed.
  - Start the simple sync worker with OTLP export enabled.
  - Probe `/health` and verify `traces.jsonl` grows.
  - If probe fails, restart collector once automatically and probe again.
  - Use this whenever `corepack yarn otel:up` reports services are already running but `traces.jsonl` stays empty.

- `scripts/otel_lab.sh status`
  - Show running services, worker PID/port state, and trace-file line count.

- `scripts/otel_lab.sh doctor`
  - Detect stale/unhealthy state (missing services, stale PID file, port conflicts, non-growing trace file).
  - Exit non-zero when issues are found.

- `scripts/otel_lab.sh down`
  - Stop worker process and free port `8790`.
  - Stop collector + Jaeger (`corepack yarn otel:down`).

- `scripts/otel_lab.sh restart`
  - Run a full down/up cycle with fresh startup checks.

## Default experiment workflow

1. Run `scripts/otel_lab.sh up --fresh`.
2. Confirm readiness with `scripts/otel_lab.sh status`.
3. Interact with the canvas at `http://127.0.0.1:8790/room/<room-id>`.
4. Inspect Jaeger at `http://127.0.0.1:16686`.
5. End with `scripts/otel_lab.sh down`.

## Client span verification (simple demo)

- The simple demo page (`apps/dotcom/sync-worker/src/simple/worker.ts`) initializes browser OTLP export in local mode and emits `tlsync.client.*` / `tlsync.socket.client.*` spans.
- Verify services in Jaeger:

```bash
curl -s http://127.0.0.1:16686/api/services | jq -r '.data[]' | sort
```

Expected services include:

- `tldraw-sync-core-simple-worker` (worker/DO/server)
- `tldraw-sync-core-simple-client` (browser client spans)

If client service is missing:

1. Ensure collector is running (`scripts/otel_lab.sh status`).
2. Reload the room page after collector is healthy.
3. Check browser console for `ERR_CONNECTION_REFUSED` to `http://127.0.0.1:4318/v1/traces` (collector was down when the page tried to export).

## Behavior feedback loop (sync changes)

Use this when validating behavior changes in sync/OTel code paths.

1. Start a fresh stack: `scripts/otel_lab.sh up --fresh`.
2. Install Playwright Chromium once per machine: `cd apps/dotcom/sync-worker && npx playwright install chromium`.
3. Run the targeted trace test from repo root:
   - `corepack yarn workspace @tldraw/dotcom-worker playwright test -c ./e2e/playwright.config.ts ./e2e/tests/simple-sync-worker.spec.ts -g "essential canvas ops write to OTel traces (create/update/group/delete)"`
4. Confirm trace output includes key spans:
   - `jq -r '.resourceSpans[].scopeSpans[].spans[].name' internal/observability/otel/data/traces.jsonl | sort -u | rg 'tlsync\.client\.push|tlsync\.client\.store_changes'`
5. Tear down: `scripts/otel_lab.sh down`.

## Troubleshooting

- If Jaeger receives spans but `traces.jsonl` stays empty, inspect collector logs for file-rotation errors:
  - `corepack yarn otel:logs | rg "can't rename log file|permission denied"`
- If you see rename/permission errors, run `scripts/otel_lab.sh restart --no-worker` (or `up --fresh`) to reapply writable permissions and retry.

## Notes

- Run from inside the `tldraw` repository, or set `TLDRAW_REPO_ROOT`.
- Override worker port with `WORKER_PORT=<port>` when needed.
- Use `--no-worker` to manage only Docker OTel services.
