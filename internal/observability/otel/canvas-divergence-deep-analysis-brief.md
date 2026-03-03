# SQLite Backport Analysis for Document Changes (`v3.15.x`, `sync`/`sync-core`)

## Objective

Reframe this analysis as a backport planning document for `packages/sync` and `packages/sync-core`: bring SQLite-backed handling to `v3.15.x` for **document-related sync changes** (create/update/group/reparent/delete flows), while preserving existing sync semantics.

## Backport scope and non-goals

In scope:

- Server-side apply path for document diffs:
  - `tlsync.room.push` -> `TLSyncRoom.handlePushRequest` -> storage transaction -> persisted document/tombstone state.
- SQLite storage behavior for document data:
  - transactional writes, reads, `getChangesSince`, snapshots.
- Migration safety required for document-state correctness:
  - TEXT -> BLOB migration and no double-apply migration behavior.
- Package focus:
  - `packages/sync`
  - `packages/sync-core`

Out of scope for this backport:

- Presence policy differences (solo/full behavior).
- Client batching/coalescing differences (`unsentChanges.nextDiff` behavior).
- Generic OTel schema cleanup that is unrelated to document-state backport correctness.
- Worker/runtime rollout policy questions outside `sync`/`sync-core` behavior.

## Reproducibility metadata

- Comparison date: 2026-03-01
- Repo SHAs used:
  - `tldraw-3`: `1e9ed3513b62`
  - `tldraw`: `021b6f7b4f5c`
- Traces compared:
  - `tldraw-3`: `internal/observability/otel/data/traces.jsonl` (203 spans)
  - `tldraw`: `../tldraw/internal/observability/otel/data/traces.jsonl` (508 spans)
- Focused test and command (run in each repo):
  - `corepack yarn playwright test -c ./e2e/playwright.config.ts ./e2e/tests/simple-sync-worker.spec.ts -g "essential canvas ops write to OTel traces"`
- Trace reset behavior:
  - test calls `clearOtelTraces()` before the essential scenario.
- Filtering rules used:
  - ignore ping/pong spans
  - exclude detached SQLite spans from `__test__/snapshot` polling when mapping canvas-action paths

## What this analysis says about the SQLite backport

### Current state vs target state

Current `v3.15.x` comparison behavior:

- `tldraw-3` document changes are applied against in-memory room state.
- `tldraw` document changes are applied through storage transactions with SQLite in the simple worker path.

Target for this backport:

- `v3.15.x` document changes should follow the SQLite-backed apply/persist path used in `tldraw`, without changing document-level merge semantics.

### Document-action semantic parity evidence

For document-related actions, payload semantics already match between repos in this scenario:

| Action | `tldraw-3` | `tldraw` | Semantic status |
|---|---|---|---|
| Create | `shapePuts=3` | `shapePuts=3` | aligned |
| Update | `shapePatches=1` | `shapePatches=1` | aligned |
| Delete shape | `shapeRemoves=1` | `shapeRemoves=1` | aligned |
| Delete cascade | `shapeRemoves=3` | `shapeRemoves=3` | aligned |

Implication for backport:

- Main gap is storage backend durability path, not document diff meaning.

## Divergence map for backport decisions

| Divergence | Category | Backport decision |
|---|---|---|
| In-memory apply path (`tldraw-3`) vs SQLite transaction path (`tldraw`) | Document storage path | **Close this gap** |
| Presence bootstrap push count difference | Presence behavior | Keep (out of scope) |
| Group+reparent split vs coalesced push count | Client batching behavior | Keep (out of scope) |

## First divergence points that matter for document SQLite backport

1. Server document apply boundary:
   - `tldraw-3`: in-memory apply in `packages/sync-core/src/lib/TLSyncRoom.ts:971-1321`
   - `tldraw`: storage-backed apply in `packages/sync-core/src/lib/TLSyncRoom.ts:1133-1243`
2. SQLite-backed storage implementation boundary in `tldraw`:
   - `apps/dotcom/sync-worker/src/simple/SimpleTldrawDurableObject.ts:46-56`
   - `packages/sync-core/src/lib/SQLiteSyncStorage.ts:392-453`
   - `packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts:28-70`
   - `packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts:114-146`
3. Migration correctness boundaries needed for safe document backport:
   - TEXT -> BLOB migration (`d1c72b2b0`)
   - no in-loop double migration apply (`5221da51b`)

## Commit anchors for document-focused SQLite backport

Required sequence for `v3.15.x` (document changes):

1. `d039f3a1a` (`TLSyncStorage` abstraction)
2. `967d3af52` (SQLite storage support)
3. `d1c72b2b0` (BLOB migration for document state)
4. `5221da51b` (double-migration fix)

References:

- `investigation/findings/sync-persistence-investigation-d039f3a1a.md`
- `investigation/findings/sync-persistence-investigation-967d3af52.md`
- `investigation/findings/sync-persistence-investigation-d1c72b2b0.md`
- `investigation/findings/sync-persistence-investigation-5221da51b.md`

## Expected OTel signature after backport (document changes only)

For create/update/group/reparent/delete operations in `v3.15.x`:

- `tlsync.room.push` should remain the parent action anchor.
- Descendant SQLite transaction spans should appear on the document apply path.
- `shapePuts` / `shapePatches` / `shapeRemoves` semantics should remain unchanged.
- `push_result` outcomes (`commit` / `discard` / `rebaseWithDiff`) should remain semantically consistent with pre-backport behavior.

## Acceptance criteria for this backport

1. Document operations route through SQLite-backed transactions in `v3.15.x`.
2. Document semantic outputs remain stable:
   - create/update/delete counts match baseline behavior for the same test scenario.
3. Migration safety is preserved:
   - existing SQLite TEXT data migrates to BLOB correctly.
   - migrations are not double-applied during iteration.
4. Known out-of-scope divergences remain unchanged:
   - presence push policy and client batching behavior are not regressed by this backport.
