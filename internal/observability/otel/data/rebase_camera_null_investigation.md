# Rebase Camera-Null Investigation

## Objective

Isolate why `tlsync.client.rebase` sometimes fails with camera-related `TypeError`s in `tldraw-3`, and produce a reliable repro with exact conditions that put the editor into a state where `Editor.getCamera()` returns `undefined`.

Related inputs:

- `~/knowledge.md`
- `internal/observability/otel/data/rebase_error_summary.md`
- `internal/observability/otel/data/traces*.jsonl`

---

## Theory List (Created First)

Status legend: `untested` | `in_progress` | `supported` | `dismissed`

1. **H1: Rebase applies a server `rebaseWithDiff` that causes a temporary or persistent missing camera record for the current page.**
Status: `in_progress`
Rationale: All observed failures are inside `tlsync.client.rebase`, and at least one failing rebase includes `push_result.rebase=1`.

2. **H2: Callback ordering during rebase (`runCallbacks` true/false mix) breaks camera invariants.**
Status: `untested`
Rationale: Rebase does `reverse speculative (runCallbacks:false)` then reapplies network diffs (mostly `runCallbacks:true`), which may violate assumptions in editor/store side effects.

3. **H3: Page add/delete callbacks are skipped in a branch (or run at the wrong time), so camera records are not created for current page.**
Status: `untested`
Rationale: Camera records are created/deleted via page side effects in `Editor.ts`.

4. **H4: SQLite/backport server behavior produces a rebase diff shape that triggers this state, while baseline (`v3.15.x`) avoids it.**
Status: `untested`
Rationale: The branch has large sync-core/server-side changes; baseline reportedly does not emit this error.

5. **H5: Reconnect/hydration (`wipe_all`/connect path) temporarily leaves store usable for schema but not for camera-dependent computed reads.**
Status: `untested`
Rationale: Errors are frequently adjacent to reset/restart/disconnect spans.

6. **H6: A client queue/clock edge case applies the wrong `push_result` to pending pushes, yielding unexpected local state in rebase.**
Status: `untested`
Rationale: Rebase correctness depends on strict pending queue alignment with server `clientClock`.

7. **H7: Editor runtime reactions (e.g. viewport/following/deep-link) read camera during rebase while current-page camera is absent.**
Status: `untested`
Rationale: Error signatures originate in viewport/zoom getters, which are read by many reactive paths.

8. **H8: OTel instrumentation overhead/timing in this branch exposes an existing race (not present in baseline runs).**
Status: `untested`
Rationale: `Editor.ts` appears unchanged between baseline and branch; branch adds extensive sync instrumentation.

---

## Findings Log (Appended While Testing)

### F1 - Error signatures and span relationships

Evidence:

- `knowledge.md` reports:
  - `TypeError: Cannot read properties of undefined (reading 'z')`
  - `TypeError: Cannot destructure property 'x' of 'this.getCamera(...)' as it is undefined`
- `rebase_error_summary.md` shows `tldraw.client.reset.reason == "rebase_error"` with parent span `tlsync.client.rebase`.

Conclusion:

- Camera undefined is not a generic runtime error; it is strongly correlated with `rebase` execution.

### F2 - Rebase span details for one concrete failing trace

Evidence (from `traces.jsonl`, trace id `c4a43356c296a6dc302b5d60367dcaa0`):

- `tlsync.client.rebase` attributes include:
  - `tldraw.client.pending_incoming_diffs=1`
  - `tldraw.client.pending_pushes=1`
  - `tldraw.client.rebase.push_result.rebase=1`
  - error name/message matching camera undefined in `Editor.getViewportPageBounds`
- immediate child: `tlsync.client.reset_connection` with reason `rebase_error`.

Conclusion:

- At least one reliable failure mode is: rebase processes one incoming diff that is a `push_result` with `action=rebase`, then throws in editor camera reads.
- Supports: `H1`.

### F3 - Camera assumptions in editor code

Evidence:

- `Editor.getCamera()` (`packages/editor/src/lib/editor/Editor.ts`) does:
  - `const baseCamera = this.store.get(this._unsafe_getCameraId())!`
  - non-null assertion (`!`) assumes camera record always exists.
- `getZoomLevel` and `getViewportPageBounds` directly dereference camera fields (`.z`, destructuring `{x,y,z}`).

Conclusion:

- Any transient or persistent absence of current-page camera record will crash these getters.
- Supports: `H1`, `H7`.

### F4 - Camera record lifecycle and scope

Evidence:

- `CameraRecordType` scope is `session` (`packages/tlschema/src/records/TLCamera.ts`).
- Camera creation/deletion is handled via page side effects in editor:
  - `page.afterCreate` creates camera if missing.
  - `page.afterDelete` removes camera for deleted page.
- Integrity checker (`createIntegrityChecker`) can recreate missing cameras for existing pages (`packages/tlschema/src/TLStore.ts`).

Conclusion:

- Camera is local/session state, not a document-synced record.
- Missing camera for current page requires local invariant break (e.g., callback ordering/timing), not direct server camera mutation.
- Supports: `H2`, `H3`, `H5`, `H7`.

### F5 - Baseline comparison (initial)

Evidence:

- `Editor.ts` is identical between `tldraw-3` and `tldraw-3-obs-baseline` for the relevant camera getters.
- `useSync.ts` behavioral diff is minor (telemetry context fields).

Conclusion:

- Root cause is likely outside direct editor camera getter implementation itself.
- Baseline-vs-branch delta likely in sync/rebase/storage/runtime behavior rather than `Editor.getCamera()` logic.
- Supports: `H4`, `H8`.

### F6 - Deterministic repro with official test command

Evidence:

- Command (from repo instructions) consistently reproduces `rebase_error` in this branch:
  - `cd /home/exedev/tldraw-3/apps/dotcom/sync-worker`
  - `corepack yarn playwright test -c ./e2e/playwright.config.ts ./tests/simple-sync-worker.spec.ts -g "essential canvas ops write to OTel traces (create/update/group/delete)"`
- After each run, `internal/observability/otel/data/traces.jsonl` shows many `tlsync.client.rebase` spans with error attributes and matching `tlsync.client.reset_connection` reason `rebase_error`.

Conclusion:

- Repro is reliable and not flaky in this environment.
- Supports: `H1`.

### F7 - Exact state at throw time (`Editor.getCamera` probe)

Evidence:

- Temporary probe in `Editor.getCamera` changed the thrown message to include store ids at the instant `baseCamera` is missing.
- Captured error message repeatedly in `tldraw.client.rebase.error.message`:
  - `Missing camera record for current page during getCamera (cameraId=camera:page:page, currentPageId=page:page, pageIds=none, cameraIds=none)`

Conclusion:

- The failure is a real invariant break, not just stale computed cache:
  - `instance.currentPageId` still points to `page:page`
  - but there are temporarily no `page` or `camera` records in store.
- Strongly supports: `H1`, `H3`, `H7`.

### F8 - Rebase phase at failure

Evidence:

- Temporary stage marker added to `TLSyncClient.rebase` catch path (`tldraw.client.rebase.error.stage`).
- All observed failures occur at:
  - `replay_pending_pushes`

Conclusion:

- Crash occurs after undo/apply phase enters the replay path, not in unrelated socket lifecycle code.
- Supports: `H2`.

### F9 - Speculative diff content at failure

Evidence:

- Added per-span speculative summary attributes at start of `rebase`.
- For every failing span:
  - `tldraw.client.rebase.speculative.added.page = 1`
  - `tldraw.client.rebase.speculative.added.document = 1`
- These values persist across repeated error cycles.

Conclusion:

- Rebase is always undoing a speculative diff that includes exactly one page and one document as added records.
- Undoing that speculative diff removes page/document from local store, creating the camera-null window.
- Supports: `H2`, `H3`.

### F10 - Server outcome divergence vs baseline

Evidence:

- In current branch traces: `push_result` includes `discard` and `rebase`.
- In baseline traces (`tldraw-3-obs-baseline/internal/observability/otel/data/traces.jsonl`): `tlsync.room.push_outcome` is `commit` for all observed pushes.

Conclusion:

- Branch introduces outcome mix change (`commit -> discard/rebase`) relative to baseline for this scenario.
- This is sufficient to route client into the failing rebase path in current branch.
- Supports: `H4`.

### F11 - Queue mismatch hypothesis check

Evidence:

- No observed errors with messages:
  - `Received push_result but there are no pending push requests`
  - `Received push_result for a push request that is not at the front of the queue`
- Failures consistently report camera-related error and stage `replay_pending_pushes`.

Conclusion:

- No evidence for pending queue ordering mismatch as primary trigger.
- `H6` is dismissed for this repro.

### F12 - Reconnect/hydration as primary cause check

Evidence:

- First failure occurs during normal single-client canvas-op scenario before reconnect loop dominates.
- Reconnect/reset spans appear mainly after first `rebase_error` as recovery behavior.

Conclusion:

- Reconnect/hydration is part of the failure loop aftermath, but not the primary trigger condition for entering camera-null state.
- `H5` is dismissed as primary cause for this repro.

---

## Working Status

- H1: `supported`
- H2: `supported`
- H3: `supported`
- H4: `supported`
- H5: `dismissed` (as primary trigger)
- H6: `dismissed`
- H7: `supported`
- H8: `dismissed` (timing overhead not needed to explain current deterministic repro)

---

## Reliable Repro (Current Branch)

### Preconditions

1. Branch: `/home/exedev/tldraw-3` at `observability-3.x` lineage (current investigation branch).
2. Node.js 20 in shell.
3. OTel lab services up.

### Steps

1. Start lab:
   - `cd /home/exedev/tldraw-3`
   - `./skills/tldraw-otel-lab/scripts/otel_lab.sh up --fresh`
2. Run the target test:
   - `cd /home/exedev/tldraw-3/apps/dotcom/sync-worker`
   - `corepack yarn playwright test -c ./e2e/playwright.config.ts ./tests/simple-sync-worker.spec.ts -g "essential canvas ops write to OTel traces (create/update/group/delete)"`
3. Verify failure signatures in traces:
   - `cd /home/exedev/tldraw-3`
   - `jq -r '.resourceSpans[].scopeSpans[].spans[] | select(.name=="tlsync.client.rebase") | (.attributes // []) | map(select(.key=="tldraw.client.rebase.error.message") | .value.stringValue)[]' internal/observability/otel/data/traces.jsonl`
   - Expect camera-missing error signatures.

### Why this reproduces

1. Client enters rebase with speculative changes containing `added.page=1` and `added.document=1`.
2. Rebase reverses speculative changes, temporarily removing page/document from local store.
3. Before a stable replay restores state, editor camera-dependent computation runs.
4. `Editor.getCamera` resolves current page id but finds no camera record for it, causing throw.
5. Client catches as `rebase_error`, calls `reset_connection`, restarts socket, and repeats.

---

## Required Conditions For `camera === undefined`

The following conditions are sufficient in this repro:

1. `TLSyncClient.rebase` is running with speculative additions that include page/document.
2. The rebase path temporarily produces a store state where:
   - `instance.currentPageId` is set (e.g. `page:page`)
   - but page/camera records are absent (`pageIds=none`, `cameraIds=none` at throw time).
3. Any reactive/editor code path reads `editor.getCamera()` during that gap.
4. `Editor.getCamera` non-null assumption (`store.get(cameraId)!`) turns this gap into a thrown error.

---

## Fix Attempt Log (2026-03-02)

### F13 - Fix implemented in `TLSyncClient.rebase`

Evidence:

- Updated `packages/sync-core/src/lib/TLSyncClient.ts` rebase path to call:
  - `this.store.ensureStoreIsUsable()`
- Placement is inside `this.store.mergeRemoteChanges(() => { ... })`, after replaying pending pushes and before the outer remote-change atomic operation completes.

Conclusion:

- The fix forces page/camera/document invariants to be restored before remote side-effect callbacks flush.
- This removes the camera-null gap that previously surfaced as `Editor.getCamera()` `undefined` throws during rebase.

### F14 - Regression test converted from expected-fail to real assertion

Evidence:

- Removed `test.fail(true, 'Known bug ...')` from:
  - `apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts`
  - test: `regression: rebase should not enter camera-null state`

Conclusion:

- The regression now acts as a real gate for camera-null rebase behavior.

### F15 - Post-fix validation (targeted)

Evidence:

1. Regression test command:
   - `cd /home/exedev/tldraw-3`
   - `corepack yarn workspace @tldraw/dotcom-worker playwright test -c ./e2e/playwright.config.ts ./e2e/tests/simple-sync-worker.spec.ts -g "regression: rebase should not enter camera-null state"`
   - Result: `1 passed`
2. Regression trace file check:
   - `internal/observability/otel/data/traces.chromium.regression-rebase-should-not-enter-camera-null-state.w0.r0.jsonl`
   - `tldraw.client.rebase.error.message` count: `0`
   - `tldraw.client.reset.reason == "rebase_error"`: none observed

Conclusion:

- The previously deterministic camera-null rebase failure is no longer reproduced by the dedicated regression test.

### F16 - Broader validation (sync worker e2e)

Evidence:

1. Essential OTel scenario:
   - `corepack yarn workspace @tldraw/dotcom-worker playwright test -c ./e2e/playwright.config.ts ./e2e/tests/simple-sync-worker.spec.ts -g "essential canvas ops write to OTel traces \(create/update/group/delete\)"`
   - Result: `1 passed`
2. Full `simple-sync-worker.spec.ts` run:
   - Result: `6 passed, 1 failed`
   - Single failure was infra/process-related during setup:
     - `503 ... worker restarted mid-request`
     - failing test: `reset + create/update/delete sequence persists expected tombstone and spans`
3. Isolated rerun of failing test:
   - `corepack yarn workspace @tldraw/dotcom-worker playwright test -c ./e2e/playwright.config.ts ./e2e/tests/simple-sync-worker.spec.ts -g "reset \+ create/update/delete sequence persists expected tombstone and spans"`
   - Result: `1 passed`

Conclusion:

- No functional regression from the rebase fix was detected in targeted and broader e2e checks.
- The one full-suite failure appears to be transient worker restart noise, not a deterministic behavior regression.
