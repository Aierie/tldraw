---
name: tldraw-sync-instrumentation
description: Add, audit, and harden OpenTelemetry instrumentation for tldraw sync flows across sync, sync-core, and sync-worker code. Use when asked to trace client↔server change handling, close span coverage gaps, preserve trace hierarchy, standardize tracing attributes, or verify instrumentation after branch refactors with changed file layouts.
---

# tldraw Sync Instrumentation

Instrument tldraw sync paths aggressively while keeping traces queryable, hierarchical, and test-safe.

## Quick start

1. Run `scripts/find_sync_instrumentation_targets.sh` from the repo root to discover likely files on the current branch.
2. Read `references/span-taxonomy.md` and choose the span groups relevant to the requested flow.
3. Add spans at boundaries first (client store/push, socket send/receive, room handle/push/broadcast, worker ingress/forwarding, storage transaction).
4. Preserve parent context across adapters and message handlers.
5. Add explicit outcome attributes on non-exception branches (drop/discard/rebase/forbidden/full/etc.).
6. Run validation commands in `references/validation-checklist.md`.
7. For local trace audits, ensure collector is fresh (`corepack yarn otel:down && corepack yarn otel:up`) if `traces.jsonl` appears stuck at zero.

## Workflow

### 1) Discover branch-specific structure

Do not assume file paths are identical across branches. Discover equivalents with:

- `scripts/find_sync_instrumentation_targets.sh`
- `rg` for key symbols:
  - `TLSyncClient|ClientWebSocketAdapter|ServerSocketAdapter`
  - `TLSocketRoom|TLSyncRoom|handleMessage|handlePushRequest`
  - `startActiveSpan|startSpan|extractTraceContext|propagateTraceContext`
  - `worker.fetch|onRequest|forwardRoomRequest|joinExistingRoom`

If a canonical file is missing, instrument the nearest equivalent layer (same responsibility, different filename).

### 2) Instrument end-to-end path first

For client change propagation (sync → sync-core → worker/DO):

- Client queue + push attempt
- Client socket send
- Server socket receive + parse/assemble
- Room message dispatch + push handling
- Storage transaction and write paths
- Fanout/broadcast and server socket send
- Worker/DO request ingress + forwarding/auth/permission/rate-limit branches

Use `references/span-taxonomy.md` for naming and required attributes.

### 3) Enforce context correctness

- Extract remote context once at receive boundary.
- Pass extracted context downward (avoid re-extracting in nested handlers).
- Create nested child spans from the active/contextual parent.
- Keep transport envelopes stable; avoid emitting debug fields with `undefined` values.

### 4) Capture business outcomes (not only errors)

On every important branch, set attributes such as:

- `tldraw.outcome` (`committed`, `discarded`, `rebase`, `dropped`, `forbidden`, `room_full`, `readonly`)
- `http.status_code` on request spans
- room/session/user/store identifiers when already available in scope
- message size, listener/session counts, reconnect attempt/delay, close code/reason

Use low-cardinality values for outcome attributes.

### 5) Validate aggressively

Run lint + targeted tests for touched paths, then run representative integration tests for sync-core room/socket/client flows. Prefer existing test suites over new snapshots unless behavior changes.

If instrumentation touches payload objects, watch for snapshot churn from optional fields (e.g. `trace: undefined`).

## Done checklist

- End-to-end spans exist for the requested path.
- Trace tree is hierarchical (no accidental flattening from repeated extraction).
- Outbound sends are instrumented where receives are instrumented.
- Non-exception outcomes are visible in attributes.
- Lint and targeted tests pass.
- Final response summarizes added span groups, gaps closed, and validation run.

## Resources

- `references/span-taxonomy.md`: Canonical tldraw span groups, attributes, and gap checklist.
- `references/validation-checklist.md`: Practical validation commands and pre-merge checks.
- `scripts/find_sync_instrumentation_targets.sh`: Fast discovery of likely instrumentation files on current branch.
