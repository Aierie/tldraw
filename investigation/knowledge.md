Reading this file:
1. tldraw-3 refers to the branch `observability-3.x`
2. tldraw, or tldraw v4 refers to the branch `observability`
3. tldraw-3-obs-baseline refers to the branch `observability-3.x-baseline`

## OTel: interpreting `push_result.action=discard`

- In tldraw sync traces, `tldraw.push_result.action = "discard"` usually means the push was a no-op on document state, not a hard failure.
- Practical signal: `discard` commonly appears with `tldraw.room.did_doc_change=false` (often also `tldraw.push_result.broadcast=false`).
- Typical causes: stale/duplicate/speculative client pushes during reconnect/rebase windows.
- Treat as abnormal only if it spikes unexpectedly with user-visible sync issues, or alongside real error signals (`status.code=2` with exception events).

## OTel: `rebase_error` signatures (observed in `tldraw-3`)

- `rebase_error` is present in `tldraw-3` traces and absent in rerun `tldraw-3-obs-baseline` traces (`0` occurrences there).
- Associated captured error pairs (`tldraw.client.rebase.error.name` + `tldraw.client.rebase.error.message`) in `tldraw-3`:
  - `TypeError` + `Cannot read properties of undefined (reading 'z')` (observed `22`)
  - `TypeError` + `Cannot destructure property 'x' of 'this.getCamera(...)' as it is undefined.` (observed `4`)
- These signatures were seen in:
  - `internal/observability/otel/data/traces.chromium.essential-canvas-ops-write-to-otel-traces-create-update-group-delete.w0.r0.jsonl`
  - `internal/observability/otel/data/traces.jsonl`

## OTel: why `discard` appears in `tldraw-3` comparison traces

- In `tldraw-3`, `TLSyncClient` initializes `lastServerClock = 0` (`packages/sync-core/src/lib/TLSyncClient.ts`), while baseline `tldraw` uses `-1`.
- Upstream context (`tldraw` v4): commit `6319eac61869213d14b8c65a786790579fbbd76f` (2025-07-25, `TLSyncRoom optimization` / `#6488`) changed `TLSyncClient` default from `0` to `-1`.
- Why v4 moved to `-1`: the same change set fixed tombstone-history tracking (`tombstoneHistoryStartsAtClock`) and noted that clients sending `lastServerClock=0` had been a legacy/technically incorrect behavior that previously did not manifest due old tombstone-history handling. After that fix, `-1` became the safer initial clock for first-connect/full-hydration semantics.
- With `lastServerClock=0`, reconnect traces show `hydration_type=wipe_presence` (instead of `wipe_all`), then a `clientClock=0` document push (`puts=2`).
- Server `push_outcome` logic returns `action="discard"` when there is no resulting document diff (`!result.docChanges.diffs?.networkDiff`) in `TLSyncRoom`.
- In observed traces, these discards are presence-only outcomes (`did_doc_change=false`, `did_presence_change=true`), i.e. document no-op + presence update, not a hard sync failure.

## Regression status + likely introducing change (2026-03-03)

- Confirmed: camera-null `rebase_error` is a new regression in `tldraw-3`; this behavior is not present in `v3.15.x` baseline and not present in `tldraw` v4 for the same scenario.
- Most likely introducing commit versus `v3.15.x`: `89ecb2882` (`backport sqlite sync storage implementation`).

Evidence from branch diff (`tldraw-3` vs `v3.15.x`):

- Initial room/bootstrap semantics changed:
  - `v3.15.x` `TLSyncRoom` starts with `clock = 1`, `documentClock = 1`, `tombstoneHistoryStartsAtClock = 1`, and empty room docs (`packages/sync-core/src/lib/TLSyncRoom.ts` in `v3.15.x`, lines ~200-214).
  - Backport adds `InMemorySyncStorage`/`SQLiteSyncStorage` default snapshot seeded with `document` + `page` at clock `0` (`packages/sync-core/src/lib/InMemorySyncStorage.ts:91-109`, wired in `packages/sync-core/src/lib/SQLiteSyncStorage.ts:351-356`).
- Connect hydration logic changed:
  - `v3.15.x` connect path forces `wipe_all` when `lastServerClock < tombstoneHistoryStartsAtClock` (`v3.15.x` `TLSyncRoom.ts:800-885`).
  - Backport connect path uses `txn.getChangesSince(message.lastServerClock)` and sets hydration from `docChanges?.wipeAll`, which can produce `wipe_presence` for `lastServerClock=0` (`packages/sync-core/src/lib/TLSyncRoom.ts:959-994`).
- Push outcome path changed under the same commit:
  - Backport `push_result` action selection is in the new txn-based path (`packages/sync-core/src/lib/TLSyncRoom.ts:1276-1312`), where non-identical/non-empty doc effect returns `rebase`, and no doc effect returns `discard`.
  - This aligns with observed trace shift from mostly `commit` (`v3.15.x`) to `discard/rebase` (`tldraw-3`), which is what routes the client into `tlsync.client.rebase` where camera-null currently manifests.

## Clock fix rationale + experiment record (2026-03-03)

- Decision adopted in `tldraw-3`:
  - Keep `TLSyncClient.lastServerClock` initialization and hard reset at `-1`.
  - Keep the rebase `this.store.ensureStoreIsUsable()` calls commented out in `TLSyncClient`.
- Why:
  - The `-1` clock change alone removes camera-null `rebase_error` in the tested scenario and restores cleaner connect/push semantics (`wipe_all` + `commit` only).
  - `ensureStoreIsUsable` can mask the failure when clock remains `0`, but that path still shows `wipe_presence` and `discard`, which is less correct semantically for first-connect/full-hydration behavior.

### What was instrumented / measured

- Existing OTel instrumentation used as primary evidence:
  - `tlsync.client.rebase` + attrs:
    - `tldraw.client.rebase.error.*`
    - `tldraw.client.rebase.push_result.{commit,discard,rebase}`
  - `tlsync.client.reset_connection` + `tldraw.client.reset.reason`
  - `tlsync.room.push_outcome` + `tldraw.push_result.action`
  - `tlsync.client.did_reconnect` + `tldraw.client.hydration_type`
- Added regression test coverage:
  - `apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts`
  - test name: `regression: rebase should not enter camera-null state`
- Added repeatable analysis tooling:
  - `skills/tldraw-rebase-trace-matrix/scripts/rebase_trace_report.sh`

### What was tried

- 2x2 matrix in `packages/sync-core/src/lib/TLSyncClient.ts`:
  - `clock=0, ensure=off`
  - `clock=0, ensure=on`
  - `clock=-1, ensure=on`
  - `clock=-1, ensure=off`
- All runs used fresh OTel worker cycles (`otel_lab.sh down` / `up --fresh`) and full `simple-sync-worker.spec.ts`.

### Matrix outcome summary

- `clock=0, ensure=off`:
  - tests: `1 failed, 6 passed`
  - `rebase_error_messages=26`, `camera_null_signatures=26`, `reset_reason_rebase_error=26`
  - push outcomes: `commit:5 discard:24 rebase:4`
  - hydration: `wipe_presence:26`
- `clock=0, ensure=on`:
  - tests: `7 passed`
  - rebase/camera/reset errors: `0`
  - push outcomes: `commit:13 discard:3`
  - hydration: `wipe_presence:3`
- `clock=-1, ensure=on`:
  - tests: `7 passed`
  - rebase/camera/reset errors: `0`
  - push outcomes: `commit:17`
  - hydration: `wipe_all:3`
- `clock=-1, ensure=off`:
  - tests: `7 passed`
  - rebase/camera/reset errors: `0`
  - push outcomes: `commit:15`
  - hydration: `wipe_all:3`

### Repeatability check (clock `-1` only)

- 5 repeated runs each for `ensure=on` and `ensure=off` with cleanup between every run.
- Both variants:
  - `playwright_fail_runs=0`
  - `rebase_error_total=0`
  - `camera_sig_total=0`
  - `reset_rebase_error_total=0`
- `tlsync.room.push_outcome` commit counts were statistically identical:
  - `ensure=on`: mean `15.80`, sd `0.75`, min/max `15..17`
  - `ensure=off`: mean `15.80`, sd `0.75`, min/max `15..17`
- Interpretation:
  - Commit-count differences between `ensure=on` and `ensure=off` are run-to-run batching/timing variance, not a semantic behavior difference.
