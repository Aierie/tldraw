---
name: tldraw-rebase-trace-matrix
description: Run and analyze sync-client clock and rebase-guard matrix experiments using local OTel traces in tldraw-3. Use when testing whether client `lastServerClock` defaults, `ensureStoreIsUsable` guards, or reconnect hydration behavior change camera-null `rebase_error` outcomes in `simple-sync-worker` traces.
---

# Tldraw Rebase Trace Matrix

Use this skill to run repeatable 2x2 experiments around `TLSyncClient` rebase behavior and summarize traces with consistent metrics.

## Quick Start

1. Start clean tracing environment:
   - `skills/tldraw-otel-lab/scripts/otel_lab.sh up --fresh`
2. Run the sync-worker Playwright suite:
   - `corepack yarn workspace @tldraw/dotcom-worker playwright test -c ./e2e/playwright.config.ts ./e2e/tests/simple-sync-worker.spec.ts`
3. Summarize trace outcomes:
   - `skills/tldraw-rebase-trace-matrix/scripts/rebase_trace_report.sh internal/observability/otel/data/traces.jsonl`
4. Tear down:
   - `skills/tldraw-otel-lab/scripts/otel_lab.sh down`

## Matrix Workflow (Clock x Ensure)

Evaluate these variants in `packages/sync-core/src/lib/TLSyncClient.ts`:

1. `clock=0, ensure=off`
2. `clock=-1, ensure=off`
3. `clock=-1, ensure=on`
4. `clock=0, ensure=on`

For each variant:

1. Apply the variant edits.
2. Run the Quick Start sequence.
3. Copy `internal/observability/otel/data/traces.jsonl` to a variant-specific filename.
4. Run `rebase_trace_report.sh` against the copied file.
5. Compare:
   - `rebase_error_messages`
   - `camera_null_signatures`
   - `reset_reason_rebase_error`
   - push outcome action distribution
   - hydration type distribution

## Required Metrics

Always report:

1. `tlsync.client.rebase` span count
2. `tldraw.client.rebase.error.message` count
3. camera-null signature count
4. `tlsync.client.reset_connection` reason counts
5. `tlsync.room.push_outcome` action counts (`commit`/`discard`/`rebase`)
6. `tlsync.client.did_reconnect` hydration type counts
7. `tlsync.client.rebase.push_result.{commit,discard,rebase}` summed counters

## Interpretation Rules

Use the matrix results to separate causal effects:

1. If only `clock=-1` variants remove camera-null signatures, clock semantics are primary.
2. If `ensure=on` variants remove signatures independent of clock, store invariant guard is primary.
3. If both are required, keep both and treat clock as behavioral fix plus ensure as safety guard.
4. If neither removes signatures, investigate server/storage diff shape instead of client guards.

## Resources

1. `scripts/rebase_trace_report.sh`:
   - Produce per-file metrics for `traces*.jsonl`.
   - Use this instead of ad hoc jq one-liners.
2. `references/rebase-signatures.md`:
   - Known camera-null signatures and outcome interpretation.
