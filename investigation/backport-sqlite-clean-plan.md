# Clean Plan: SQLite Sync Storage Backport (`v3.15.x` baseline)

Date: 2026-03-04  
Source review inputs: `knowledge.md` and commit range `v3.15.x..observability-3.x`

## Objective

Backport SQLite sync storage to the `v3.15.x` codebase with minimal behavioral drift and **no additional OpenTelemetry surface**.

## Hard Constraints

1. Do not backport OTel/tracing plumbing.
2. Do not add protocol `trace` carrier fields.
3. Keep websocket behavior compatible with `v3.15.x` (`connect`, `patch`, `push_result`, `pong`).
4. Include the SQLite-related regression prevention noted in `knowledge.md` (initial server clock handling).

## Commit Audit: Include vs Exclude

| Commit | Summary | Decision | Why |
|---|---|---|---|
| `89ecb2882` | backport sqlite sync storage implementation | `Partial` | Core source for storage architecture, but entangled with observability-era APIs/comments and trace-aware code paths. |
| `f3bfadd06` | fix sync-room compatibility updateStore behavior | `Include` | Required functional fix for `updateStore` behavior after storage refactor. |
| `6774bd059` | add backport storage migration and sync storage tests | `Include (adapted)` | Core regression coverage for storage migrations and sync storage behavior. |
| `3fa9cdc96` | add node20-safe sqlite migration assertions | `Include` | Needed for Node 20-safe migration validation. |
| `4b45869dc` | use `-1` initial server clock and drop rebase usability guard | `Include (clock part required)` | `knowledge.md` identifies this as the key safety fix vs camera-null rebase regression. |
| `78b52991a` | cloudflare sqlite DO migration wiring | `Optional track` | Useful for template/runtime migration path, but separable from core sync-storage backport. |
| `a2eafe83f` | remove legacy cloudflare kv template path | `Optional track` | Cleanup tied to template migration track. |
| `dffa84446` | normalize cloudflare migration noop tag | `Optional track` | Fixes migration history correctness in template track. |
| `2520d666a`, `f33f32a1a`, `641c71571` | OTel + trace/typing churn | `Exclude` | Out of scope and explicitly forbidden by objective. |
| docs/investigation-only commits | reports, findings, runbooks | `Exclude` | Not implementation code. |

## Backport Strategy

Use a **subsystem transplant** approach, not a wholesale cherry-pick of `89ecb2882`.

1. Start a fresh branch from `v3.15.x`.
2. Port store migration substrate first.
3. Add sync-core storage primitives (new files) without trace spans.
4. Integrate storage into `TLSyncRoom`/`TLSocketRoom` while preserving existing protocol behavior.
5. Apply `updateStore` compatibility fix from `f3bfadd06`.
6. Apply client clock safety fix (`lastServerClock = -1` and hard-reset `-1`) from `4b45869dc`.
7. Add/adapt tests from `6774bd059` + `3fa9cdc96`.
8. Add Cloudflare template migration wiring only if this rollout requires template/runtime parity now.

## Planned Implementation Phases

### Phase 1: Store migration substrate

Files:
- `packages/store/src/lib/migrate.ts`
- `packages/store/src/lib/StoreSchema.ts`
- `packages/store/src/index.ts`

Work:
- Add `storage` migration scope interfaces (`SynchronousRecordStorage`, `SynchronousStorage`).
- Implement `StoreSchema.migrateStorage(...)`.
- Keep staged-update behavior for record iteration to avoid live-cursor double-apply issues (SQLite cursor safety).

Exit check:
- Store compiles.
- Storage-scope migration tests pass.

### Phase 2: Sync storage primitives (no OTel)

Files to add:
- `packages/sync-core/src/lib/TLSyncStorage.ts`
- `packages/sync-core/src/lib/InMemorySyncStorage.ts`
- `packages/sync-core/src/lib/SQLiteSyncStorage.ts`
- `packages/sync-core/src/lib/NodeSqliteWrapper.ts`
- `packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts`
- `packages/sync-core/src/lib/MicrotaskNotifier.ts`
- `packages/sync-core/src/lib/recordDiff.ts`

Files to minimally update:
- `packages/sync-core/src/lib/diff.ts`
- `packages/sync-core/src/index.ts`

Work:
- Port functional storage logic from `89ecb2882`.
- Remove/avoid `withSyncSpan`, `setSafeAttributes`, and trace-dependent helpers in storage wrappers and `SQLiteSyncStorage`.
- Keep exports limited to storage-related API needed by consumers.

Exit check:
- `sync-core` compiles without adding new OTel dependencies.
- New storage files are span-free.

### Phase 3: Room/socket integration with compatibility guardrails

Files:
- `packages/sync-core/src/lib/TLSyncRoom.ts`
- `packages/sync-core/src/lib/TLSocketRoom.ts`
- `packages/sync-core/src/lib/RoomSession.ts`
- `packages/sync-core/src/lib/TLSyncClient.ts`

Work:
- Integrate `TLSyncStorage` transaction model into room/connect/push paths.
- Keep existing `v3.15.x` protocol behavior; do not introduce trace-carrier protocol changes.
- Apply `f3bfadd06` compatibility fix (`updateStore` merged view should include new puts not in initial snapshot).
- Apply clock safety fix from `4b45869dc` (`lastServerClock` init/reset to `-1`).

Exit check:
- Room/socket tests pass with unchanged protocol surface.
- No new references to `trace` fields in sync protocol types.

### Phase 4: Tests and migration regressions

Files:
- `packages/store/src/lib/test/recordStore.test.ts`
- `packages/sync-core/src/test/InMemorySyncStorage.test.ts`
- `packages/sync-core/src/test/SQLiteSyncStorage.test.ts`
- `packages/sync-core/src/lib/NodeSqliteSyncWrapper.integration.test.ts`
- `packages/sync-core/src/test/TLSyncRoom.test.ts`

Work:
- Backport SQLite/storage tests from `6774bd059` and `3fa9cdc96`.
- Keep Node 20-safe behavior (`node:sqlite` optional/skip pattern).
- Update expectations only where storage architecture intentionally shifts semantics.

Exit check:
- Migration regression tests pass, including once-per-record migration behavior.
- SQLite TEXT->BLOB migration checks pass.

### Phase 5 (Optional): Cloudflare template SQLite migration track

Files:
- `templates/sync-cloudflare/worker/TldrawDurableObjectSqlite.ts`
- `templates/sync-cloudflare/worker/worker.ts`
- `templates/sync-cloudflare/wrangler.toml`
- `templates/sync-cloudflare/worker-configuration.d.ts`
- `templates/sync-cloudflare/README.md`
- `templates/sync-cloudflare/package.json`

Work:
- Apply `78b52991a`, `a2eafe83f`, `dffa84446` intent.
- Keep migration chain append-only and valid (`v2` no-op tag retained without invalid directives, `v3` introduces sqlite class).

Exit check:
- Template typecheck succeeds.
- Migration chain is coherent and forward-safe.

## OTel Exclusion Guardrails

These must stay unchanged from `v3.15.x` unless absolutely required for compile fixes:
- `packages/sync-core/src/lib/otel.ts`
- `packages/sync-core/src/lib/protocol.ts` trace-carrier additions
- `packages/sync-core/package.json` OTel dependency additions
- `apps/dotcom/sync-worker/src/*otel*`
- `internal/observability/**`
- skills/investigation observability tooling files

Suggested mechanical guard:
- `rg -n "@opentelemetry/api|withSyncSpan|extractTraceContext|traceparent|tracestate|baggage" packages/store packages/sync-core templates/sync-cloudflare`

## Proposed Commit Stack

1. `store: add storage-scope migration substrate`
2. `sync-core: add sqlite/in-memory storage primitives (no tracing)`
3. `sync-core: integrate TLSyncStorage into room/socket paths`
4. `sync-core: fix updateStore compatibility behavior`
5. `sync-core: initialize/reset client lastServerClock to -1`
6. `tests: add storage migration + sqlite sync storage coverage`
7. `templates(sync-cloudflare): sqlite DO wiring + migration normalization` (optional)

## Validation Plan

Core validation:
1. `corepack yarn workspace @tldraw/store test --runInBand src/lib/test/recordStore.test.ts`
2. `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/TLSyncRoom.test.ts`
3. `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/TLSocketRoom.test.ts`
4. `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/InMemorySyncStorage.test.ts`
5. `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/SQLiteSyncStorage.test.ts`
6. `corepack yarn workspace @tldraw/sync-core test --runInBand src/lib/NodeSqliteSyncWrapper.integration.test.ts` (Node-version gated)

Optional template validation:
1. `corepack yarn workspace tldraw-sync-cloudflare tsc --noEmit`

## Main Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Protocol drift while porting large `TLSyncRoom`/`TLSocketRoom` changes | Preserve `v3.15.x` protocol types and behavior; treat storage integration as internal refactor only. |
| OTel code accidentally reintroduced via commit transplant | File-level include list + grep guard for OTel/trace tokens before each commit. |
| Migration double-apply on SQLite cursor iteration | Keep staged writes in `StoreSchema.migrateStorage(...)`; enforce with regression tests. |
| Rebase regression from clock semantics | Apply `lastServerClock=-1` fix as part of core backport, not as a later optional patch. |
| Template migration chain mistakes | Keep migration history append-only; normalize no-op tag instead of rewriting historical tags. |

## Definition of Done

1. SQLite-backed sync storage exists and is wired into sync-core room/socket flow.
2. No OTel/tracing/protocol-trace additions are introduced by this backport.
3. Migration safety regressions are covered and passing.
4. Client/server connect-push behavior remains compatible with `v3.15.x` expectations.
5. Optional Cloudflare template track is either completed and validated or explicitly deferred.

## Minimal Delta Manifest (Oracle Addendum)

This is the smallest practical implementation set to achieve the objective without importing observability-era coupling.

1. Backport store migration substrate from `89ecb2882` with `5221da51b` safety behavior preserved:
   - `packages/store/src/lib/migrate.ts`
   - `packages/store/src/lib/StoreSchema.ts`
   - `packages/store/src/index.ts`
   - Keep staged writes in `migrateStorage(...)` for record-scope migrations.
2. Backport sync storage primitives from `89ecb2882`, but use span-free logic only:
   - `packages/sync-core/src/lib/TLSyncStorage.ts`
   - `packages/sync-core/src/lib/InMemorySyncStorage.ts`
   - `packages/sync-core/src/lib/SQLiteSyncStorage.ts`
   - `packages/sync-core/src/lib/NodeSqliteWrapper.ts`
   - `packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts`
   - `packages/sync-core/src/lib/MicrotaskNotifier.ts`
   - `packages/sync-core/src/lib/recordDiff.ts`
   - `packages/sync-core/src/lib/diff.ts`
   - `packages/sync-core/src/index.ts`
3. Integrate storage transaction model into room/socket paths, then apply compatibility correctness patch:
   - `packages/sync-core/src/lib/TLSyncRoom.ts`
   - `packages/sync-core/src/lib/TLSocketRoom.ts`
   - `packages/sync-core/src/lib/RoomSession.ts`
   - Apply `f3bfadd06` (`updateStore`/`getAll()` includes puts-only new records).
4. Apply client clock safety semantics from `4b45869dc` exactly as scoped in this plan:
   - `packages/sync-core/src/lib/TLSyncClient.ts`
   - Keep `lastServerClock` initialization and hard reset at `-1`.
5. Backport regression coverage from `6774bd059` + `3fa9cdc96`:
   - `packages/store/src/lib/test/recordStore.test.ts`
   - `packages/sync-core/src/test/InMemorySyncStorage.test.ts`
   - `packages/sync-core/src/test/SQLiteSyncStorage.test.ts`
   - `packages/sync-core/src/lib/NodeSqliteSyncWrapper.integration.test.ts`
   - `packages/sync-core/src/test/TLSyncRoom.test.ts`
6. Optional template track:
   - Apply `78b52991a`, `a2eafe83f`, `dffa84446` intent, but account for later `main` fix `2d6554e2c`.
   - Practical caveat: Cloudflare can reject deleting previously bound DO classes; if deploy validation fails on `deleted_classes`, prefer leaving old class undeleted while still using `new_sqlite_classes` for new runtime binding.

## Preflight Gate (Run Before Each Backport Commit)

Use this mechanical gate to prevent drift and catch accidental observability/protocol contamination early.

```bash
# 0) Safety: review scope of staged changes
git status --short

# 1) OTel/trace token scan in touched subsystems (must be empty for new backport code)
rg -n "@opentelemetry/api|withSyncSpan|extractTraceContext|traceparent|tracestate|baggage" \
  packages/store packages/sync-core templates/sync-cloudflare

# 2) Protocol trace-carrier guard (must not add trace fields vs v3.15.x)
git diff -- packages/sync-core/src/lib/protocol.ts

# 3) OTel dependency guard (must not add @opentelemetry/api vs v3.15.x)
git diff -- packages/sync-core/package.json

# 4) Ensure forbidden observability files are untouched
git diff -- apps/dotcom/sync-worker/src '*otel*' internal/observability

# 5) Ensure migration safety pattern remains in place
rg -n "const updates: \[string, R\]\[\]|for \(const \[id, state\] of storage\.entries\(\)\)" \
  packages/store/src/lib/StoreSchema.ts

# 6) Ensure clock fix semantics are present
rg -n "lastServerClock = -1|this\.lastServerClock = -1" \
  packages/sync-core/src/lib/TLSyncClient.ts
```

Expected interpretation:

1. Step 1 should return no newly introduced hits in backported files.
2. Steps 2-4 should show no disallowed diffs against the hard constraints.
3. Steps 5-6 should positively confirm required regression-prevention logic exists.
