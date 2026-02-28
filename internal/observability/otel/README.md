# tldraw sync OpenTelemetry observability

This folder contains a local OTel sink + live UI setup for investigating sync behavior, especially SQLite persistence.

## Industry-standard OTel libraries used

- **Core instrumentation API (shared in `@tldraw/sync-core`)**
  - `@opentelemetry/api`
- **Collector + UI sink (local)**
  - OpenTelemetry Collector (`otel/opentelemetry-collector-contrib`)
  - Jaeger (`jaegertracing/jaeger`)

## What is instrumented

Instrumentation has been added in `packages/sync-core` at the main sync boundaries:

- `TLSyncClient` (frontend store changes, push/connect send, server receive)
- `apps/dotcom/sync-worker/src/otel.ts` initializes Worker/DO OTLP exporter when `OTEL_ENABLED=true`
- `ClientWebSocketAdapter` (websocket send/receive boundaries)
- `TLSocketRoom` (server socket message ingress)
- `TLSyncRoom` (room message handling, connect, push, patch fanout)
- `SQLiteSyncStorage` (transaction timing + change summaries)
- `NodeSqliteWrapper` / `DurableObjectSqliteSyncWrapper` (SQLite wrapper execution boundaries)

Trace context is propagated in protocol messages through an optional `trace` carrier (`traceparent` + `tracestate`).

## Prerequisites

- Run commands from the repo root (`/tldraw`).
- Use `corepack yarn ...` for commands in this guide. In some shells, `yarn` is not on `PATH` unless you invoke it through Corepack.
- Enable Corepack once if needed:

```bash
corepack enable
```

## Run local sink and UI

1. Start collector + Jaeger:

```bash
corepack yarn otel:up
```

2. Open Jaeger:

- http://localhost:16686

3. Optional watched-file live UI (SSE):

```bash
corepack yarn otel:watch-ui
```

- http://localhost:9091
- This tails `internal/observability/otel/data/traces.jsonl` in real time.

4. Stop stack:

```bash
corepack yarn otel:down
```

## Issues encountered while running locally

- `yarn: command not found`: use `corepack yarn ...` (or run `corepack enable` once) before OTEL commands.
- Port `8790` already in use when running the example sync worker: either stop the conflicting `workerd` process or run the worker on a different port.
- If you run the worker on a non-default port, update any test/client `uri` values to match, or traces will not represent the session you expect.
- If `internal/observability/otel/data/traces.jsonl` is missing, the watched-file UI and file-backed trace checks will not show spans until the file path exists and is writable.

## Export endpoint

Use this OTLP HTTP endpoint in whichever runtime initializes an OTel SDK/exporter:

- `http://localhost:4318/v1/traces`

## Suggested env vars for sync workers/apps

- `OTEL_ENABLED=true`
- `OTEL_SERVICE_NAME=tldraw-sync-worker` (or client/server-specific name)
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces`
- `OTEL_SAMPLE_RATIO=1`

## Questions this setup is meant to answer

- When shape changes trigger push traffic (`tlsync.client.store_changes`, `tlsync.client.push`)
- How messages route through socket + room handlers (`tlsync.socket.*`, `tlsync.room.*`)
- When and how SQLite persistence transactions happen (`tlsync.storage.sqlite.*`)
- Shape hierarchy movement hints (parent/page/shape/reparent attributes on room/storage spans)
