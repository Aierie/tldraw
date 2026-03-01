---
name: tldraw-sqlite-trace-backport-audit
description: Compare OpenTelemetry trace behavior between tldraw-3 and a tldraw@4 reference repo to audit SQLite sync-persistence backport readiness. Use when validating websocket connect/push/ping storage side effects, identifying trace-level behavioral gaps, or updating investigation findings from trace evidence.
---

# tldraw SQLite Trace Backport Audit

Run a repeatable trace audit that compares `tldraw-3` against a reference repo that already has SQLite sync storage behavior. Default reference repo path is `../tldraw`.

## Quick Start

1. Run the report script from `tldraw-3` root:

```bash
node skills/tldraw-sqlite-trace-backport-audit/scripts/trace_backport_report.mjs \
  --current . \
  --reference ../tldraw
```

2. If `tldraw@4` is elsewhere, override `--reference`.

3. Use the output sections `Comparison Highlights` and `Acceptance Signals` to update investigation findings.

## Where Traces Come From

Treat provenance as mandatory context before making behavioral claims.

1. Collector sink file:
   `internal/observability/otel/data/traces.jsonl` is written by the OTel collector file exporter configured in `internal/observability/otel/collector.yaml`.
2. Per-test snapshot files:
   `traces.<project>.<title>.w<worker>.r<retry>.jsonl` are produced by `apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts`.
   The test helper clears `traces.jsonl`, repeatedly reads it, and copies current contents into the per-test output file.
3. Service producers:
   - `tldraw-sync-core-simple-client`: browser exporter in `apps/dotcom/sync-worker/e2e/client/src/main.tsx`.
   - `tldraw-sync-core-simple-worker`: worker/DO exporter in `apps/dotcom/sync-worker/src/simple/otel.ts`.
4. Test-side deterministic server checks:
   the same e2e spec also reads in-memory captured server spans via `GET /__test__/room/:roomId/spans` (not only collector output).
5. Critical env caveat:
   `wrangler.simple.toml` defaults `OTEL_ENABLED="false"`.
   If Playwright starts `dev-simple` itself, worker OTLP export may be off; client spans can still appear.
   For full client+server/storage traces, pre-start worker with OTel env enabled (for example via `skills/tldraw-otel-lab/scripts/otel_lab.sh up --fresh`).

## Workflow

1. Confirm both repos have trace data in `internal/observability/otel/data`.
2. Run `trace_backport_report.mjs` and read `Trace Provenance Model` + `trace_file_origin` + `service_names` before comparing behavior.
3. Validate expected SQLite span family presence in reference traces:
   `tlsync.storage.sqlite.exec`, `statement.all`, `statement.iterate`, `statement.run`, `transaction`, `transaction.wrapper`.
4. Compare websocket behavior:
   - `connect`: read-only transaction evidence
   - `push`: doc-changing vs presence-only/no-op behavior
   - `ping`: no SQLite side effects
5. Check reconnect observability:
   `tlsync.socket.client.reconnect.schedule_attempt` and `tlsync.socket.client.reconnect.connected`.
6. Update findings docs with:
   - behavioral implications
   - trace-backed acceptance criteria
   - known tolerated bootstrap exceptions (`no such table: metadata` during migration probe)

## Regenerating Comparable Trace Fixtures

1. Start OTel stack + worker with OTLP export enabled:

```bash
skills/tldraw-otel-lab/scripts/otel_lab.sh up --fresh
```

2. Run the simple sync-worker e2e suite that captures trace snapshots:

```bash
corepack yarn workspace @tldraw/dotcom-worker e2e-simple
```

3. Confirm generated files under `internal/observability/otel/data/`:
   - `traces.jsonl` (collector aggregate)
   - `traces.chromium.*.w0.r0.jsonl` (per-test snapshots)

4. Stop lab services when done:

```bash
skills/tldraw-otel-lab/scripts/otel_lab.sh down
```

## Interpretation Rules

1. Treat only `traces.chromium*.jsonl` as primary comparison input to avoid double-counting aggregate replay files.
2. Expect SQLite bootstrap spans outside websocket ancestry (`flow=other`).
3. Expect `connect` SQLite transactions to be read-only (`tldraw.storage.did_change=false`).
4. Expect document-changing `push` transactions to include write statements and `tldraw.storage.did_change=true`.
5. Expect presence-only/no-op pushes to avoid document write bursts and metadata clock increments.

## Report Script

Use:

```bash
node skills/tldraw-sqlite-trace-backport-audit/scripts/trace_backport_report.mjs \
  [--current <path>] \
  [--reference <path>] \
  [--include-aggregated]
```

Arguments:

1. `--current`: current repo path. Default `.`.
2. `--reference`: reference repo path. Default `../tldraw`.
3. `--include-aggregated`: include `traces.jsonl` in addition to `traces.chromium*.jsonl`.

Output includes:

1. trace provenance model and inferred file origin (`collector-aggregate` vs Playwright snapshot)
2. service-name mix overall and per file (client vs worker emitter visibility)
3. span family counts and file-level SQLite counts
4. SQLite statements grouped by inferred flow (`push`, `connect`, `other`)
5. transaction `did_change` summaries by flow
6. push outcome variants (`doc/presence/broadcast/action`)
7. reconnect span counts
8. comparison highlights + acceptance signals for findings updates
