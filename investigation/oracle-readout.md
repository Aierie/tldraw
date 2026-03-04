
## Backport Risk Analysis: SQLite Sync Storage into v3.15.x (OTel-excluded)

### Commit Sequence Map

| SHA | What it does | Backport scope |
|---|---|---|
| `d039f3a` | Storage abstraction: `TLSyncStorage`, `InMemorySyncStorage`, `'storage'` migration scope, `DocumentState` deletion, `RoomStoreMethods` reshuffling | **Core prerequisite** |
| `967d3af` | `SQLiteSyncStorage` + `DurableObjectSqliteSyncWrapper` + `NodeSqliteWrapper` + `TLFileDurableObject` + feature flag wiring | **Core SQLite** |
| `d1c72b2` | TEXT→BLOB migration (SQLite `state` column, migration version 2) | SQLite internal |
| `d6ff766` | `ROOM_NOT_FOUND` exported, fallback in `TLFileDurableObject`, R2-clock comparison | dotcom-only |
| `5221da51` | Fix double-migration: stage `updates[]` before applying during `record`-scope iteration | **Critical correctness** |
| `95b18b7` | `wrangler.toml` append-only DO migration fix (template) | template |
| `266d21c` | Rename `TldrawDurableObject`→`TldrawDurableObjectSqlite` class, add v3 DO migration | template |
| `e30d21a` | Rename `SqlLiteSyncStorage`→`SQLiteSyncStorage` everywhere | API rename |
| `89ecb28` | The "backport sqlite sync storage" commit — compiles the above into the v3.15.x branch, **includes OTel plumbing in `DurableObjectSqliteSyncWrapper`/`NodeSqliteWrapper`/`TLSyncRoom`** | **Your backport target** |
| `f3bfadd` | `StoreUpdateContext.getAll()` bug: new `puts`-only records weren't included; fixes server clock offset tests | `TLSyncRoom` compat |
| `6774bd0` | Adds backport migration tests + `NodeSqliteSyncWrapper.integration.test.ts` + `SQLiteSyncStorage.test.ts` | tests |
| `3fa9cdc` | Adds node20-safe migration assertion tests (mocks for TEXT→BLOB) | tests |
| `4b45869` | `TLSyncClient.lastServerClock` init changed to `-1`; `ensureStoreIsUsable` call removed during rebase | **client-side risk** |

---

## Risk Theme 1: OTel Plumbing Is Structurally Entangled, Not Additive

**The most important hidden coupling in the entire backport.**

In commit `89ecb28` (the backport commit itself), the `DurableObjectSqliteSyncWrapper` and `NodeSqliteWrapper` are **not** the thin wrappers from `967d3af`. They are OTel-instrumented versions — each `exec`, `prepare`, `iterate`, `all`, `run`, and `transaction` call wraps in [`withSyncSpan`](https://github.com/tldraw/tldraw/blob/89ecb2882e35ae3abc5c92337bb1ba2a6e7ae36a/packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts) using `@opentelemetry/api`. The `TLSyncRoom` in `89ecb28` also has `import { context, type Context } from '@opentelemetry/api'`.

If your backport plan strips OTel, you need to verify you have the **pre-OTel versions** of these files. The `967d3af` wrappers do NOT call `withSyncSpan`. The `89ecb28` wrappers DO. Using `89ecb28` wrappers without OTel installed will fail at import time or produce dead code.

**Watch-out:** Check your `packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts` and `NodeSqliteWrapper.ts` in the backport branch. If they contain `withSyncSpan`, you're using the wrong version.

---

## Risk Theme 2: `TLSyncRoom` Constructor/Storage Contract Rupture

The `d039f3a` commit made a **structural break** in how `TLSyncRoom` is constructed and what it owns:

**Before `d039f3a`:**
```typescript
// TLSocketRoom was the external API
new TLSocketRoom({ initialSnapshot, onDataChange })
// DocumentState was a public class on TLSyncRoom
room.documents.get(id)?.state
```

**After `d039f3a`:**
```typescript
// storage is mandatory (or initialSnapshot is deprecated compat)
new TLSocketRoom({ storage }) // storage owns documents, tombstones, clock
// DocumentState class is DELETED from TLSyncRoom
// documents moved to storage, presenceStore is separate
room.presenceStore.get(session.presenceId) // not room.documents
```

Tests in `presenceMode.test.ts` had to change from `room.documents.get(session.presenceId)` to `room.presenceStore.get(...)`. Any existing code in your v3.15.x codebase that accesses `room.documents` directly **will break silently or throw at runtime**.

**Watch-out:** Grep for `room.documents.get`, `room.documents.has`, `room.tombstones`, `room.tombstoneHistoryStartsAtClock` — these were all removed from `TLSyncRoom`'s public surface and moved into `InMemorySyncStorage`.

---

## Risk Theme 3: Migration Scope `'store'`→`'storage'` — The Arrow Migration Is a Silent Data Risk

The `d039f3a` commit renamed `scope: 'store'` migrations to `scope: 'storage'` in `store-migrations.ts` and `TLArrowShape.ts`. But the execution path is **different**:

- **`scope: 'store'`**: receives `SerializedStore` (a plain JS object, mutate freely)
- **`scope: 'storage'`**: receives a `SynchronousRecordStorage` with explicit `get/set/delete/entries` methods

The `arrowShapeVersions.ExtractBindings` migration was rewritten to use `storage.values()` iteration + `storage.set()`. If the backport applies the `'storage'` scope migration in a context where `migrateStoreSnapshot` (the old path) is called instead of `migrateStorage`, that migration **will not run** and arrow binding extraction will be silently skipped.

Then commit `5221da51` added the critical fix: **updates must be staged in an array and applied after iteration ends**, because SQLite cursors are live. The original `d039f3a` code mutated inside `storage.entries()` iteration, which could cause records to be visited multiple times. This is the regression that `5221da51` fixed.

**Watch-out:** If you backport `d039f3a`'s `migrateStorage` but not `5221da51`'s fix, arrow diagrams with bindings may be double-migrated on first load with SQLite, silently corrupting binding IDs.

```typescript
// DANGEROUS in d039f3a (before 5221da51):
for (const [id, state] of storage.entries()) {
    ...
    storage.set(id, result as R)  // mutates live iterator!
}

// SAFE in 5221da51:
const updates: [string, R][] = []
for (const [id, state] of storage.entries()) { updates.push(...) }
for (const [id, record] of updates) { storage.set(id, record) }
```

---

## Risk Theme 4: `RoomSnapshot` Clock Field — `clock` vs `documentClock` Duality

The `RoomSnapshot` type had `clock` as the primary field. After `d039f3a`, `documentClock` is the canonical field and `clock` is a deprecated alias. The `InMemorySyncStorage` constructor handles both:

```typescript
const documentClock = Math.max(maxClockValue, snapshot.documentClock ?? snapshot.clock ?? 0)
```

But the upgradeDowngrade test (`d039f3a`) had to be updated:
```typescript
// Before: lastServerClock: snapshot.clock
// After: lastServerClock: snapshot.documentClock ?? snapshot.clock ?? 0
```

If any v3.15.x code that serializes or deserializes `RoomSnapshot` uses `snapshot.clock` directly as the canonical clock (e.g., in R2 persistence), it will read the right value but write back a snapshot that only has `clock`, not `documentClock`. On next load, `InMemorySyncStorage` handles it via the `??` chain — but `SQLiteSyncStorage.getDocumentClock()` reads `documentClock` from the metadata table, not `clock`. First-time SQLite initialization from an old R2 snapshot with only `clock` will work correctly (constructor normalises it), but if code reads `snapshot.clock` instead of `storage.getClock()` for persist decisions, clocks will drift.

**Watch-out (TLFileDurableObject specifically):** The R2-clock comparison in `d6ff766` compares `lastR2Clock` (stored in DO storage) against `SQLiteSyncStorage.getDocumentClock(sql)`. If the last R2 persist was done when the snapshot still only had `clock` (not `documentClock`), the stored `lastPersistedR2Clock` value may be 0 (never written), triggering an unnecessary R2 reinitialisation of SQLite.

---

## Risk Theme 5: Cloudflare DO Migration Chain Is Broken for Existing Deployments

This is the most operationally dangerous chain. The template migration history:

| Commit | `wrangler.toml` change | Effect |
|---|---|---|
| `967d3af` | v1: `new_sqlite_classes: ["TldrawDurableObject"]` | **Wrong** — breaks existing KV-backed DOs |
| `95b18b7` | v1: `new_classes`, v2: `classes_with_sqlite` | Fixes fresh deploys, but `classes_with_sqlite` is not a valid Cloudflare directive |
| `266d21c` | Introduces `TldrawDurableObjectSqlite`, v3: `deleted_classes: [old]`, `new_sqlite_classes: [new]` | Correct fix, but only works if v1 and v2 already ran |

The key insight from `266d21c`'s commit message: "v2 was a no-op: `classes_with_sqlite` is not a valid Cloudflare migration directive." Cloudflare simply ignores unknown directives. So **any existing deployment that ran through `967d3af` or `95b18b7`** has a DO that was never actually switched to SQLite storage — they were writing to the KV-backed `TldrawDurableObject` the whole time.

**Watch-out for your template migration:**
- If your v3.15.x baseline uses a single `wrangler.toml` migration and you backport this, you must use `new_sqlite_classes` on the very first migration. Existing deployments with `new_classes` in v1 that then get a backport migration need `v2: classes_with_sqlite` (even as a no-op marker) and then `v3: new_sqlite_classes` on a renamed class. You cannot modify v1.
- The `sync-cloudflare` template ended up with a 3-step migration for this reason.

---

## Risk Theme 6: `TLSyncClient.lastServerClock` Initialisation (`4b45869`)

This is subtle and regression-prone. The backport changed `lastServerClock` from `0` to `-1`:

```typescript
// Before 4b45869:
private lastServerClock = 0

// After 4b45869:
private lastServerClock = -1
```

The `connect` message sends `lastServerClock` to the server so it knows what diffs to replay. If `lastServerClock = 0`, the server sends diffs since clock 0 (i.e., everything). If `lastServerClock = -1`, the server sees a clock before any valid document clock and **sends the full initial snapshot** instead of incremental diffs.

The same commit also **removes `this.store.ensureStoreIsUsable()`** from the rebase error path (commented out). This means that if a rebase fails, the store is no longer guaranteed to be in a valid state (has `document:document` and at least one `page:*`). In v3.15.x, if `ensureStoreIsUsable` is expected by downstream code after reconnection, this removal can cause rendering errors or protocol rejections on reconnect.

**Watch-out:** If any client-side logic assumes `lastServerClock = 0` after a hard reset (e.g., tests that check what the first connect message sends), those will now see `-1`. Also, removing `ensureStoreIsUsable` in the error path may cause empty-document rendering states after failed rebases.

---

## Risk Theme 7: `TLSocketRoom.getCurrentSnapshot()` is Removed — Persistence Breaks

Before `d039f3a`, the pattern for snapshot persistence was:
```typescript
const snapshot = room.getCurrentSnapshot()
await saveSnapshot(snapshot)
```

After, `getCurrentSnapshot()` is removed from `TLSocketRoom` and you must use:
```typescript
const snapshot = room.storage.getSnapshot?.()
```

Note the `?.` — `getSnapshot` is **optional** on `TLSyncStorage` interface. `InMemorySyncStorage` implements it; `SQLiteSyncStorage` implements it; but a custom storage backend might not. If the persistence code does `room.getCurrentSnapshot()` without the migration, it will throw `TypeError: room.getCurrentSnapshot is not a function` at runtime — only discovered when data needs to be persisted.

The `BemoDO` in `d039f3a`'s diff shows the migration:
```typescript
// Before:
const snapshot = JSON.stringify(room.getCurrentSnapshot())

// After:
const snapshot = JSON.stringify(room.storage.getSnapshot?.())
```

Also: `onDataChange` on `TLSocketRoom` is now deprecated and moved to `InMemorySyncStorage`'s `onChange`. If you register `onDataChange` on `TLSocketRoom` it still works (backward compat shim), but `onChange` fires in a microtask via `MicrotaskNotifier`, while the old `onDataChange` fired synchronously. **This timing difference can affect persist-on-change logic** — a persist triggered in an `onChange` callback may race with the next incoming message.

---

## Risk Theme 8: `StoreUpdateContext.getAll()` Missing `puts`-only Records (`f3bfadd`)

The `f3bfadd` commit fixed a bug in `TLSyncRoom`'s `StoreUpdateContext.getAll()`. Before the fix:

```typescript
// Only iterated over snapshot records, missing any records that were only in puts
return Object.values(this.snapshot).filter(...).map(r => this.updates.puts[r.id] ?? r)
```

After:
```typescript
// Now also includes records in puts that weren't in the original snapshot
for (const [id, r] of Object.entries(this.updates.puts)) {
    if (seen.has(id)) continue  // avoid double-counting
    records.push(...)
}
```

This matters because `TLSyncRoom.updateStore` (used by `room.updateDocument`) could return incomplete records if a transaction created new records not previously in the snapshot. The corresponding test change shows:

```typescript
// Before fix: push result had serverClock: 1 (phantom increment)
// After fix: serverClock: 0 (correct — no phantom change)
```

**Watch-out:** If you use `room.updateStore()` / `room.handleSocketMessage()` heavily and compare server clocks, the before-fix behavior would incorrectly increment the clock on no-change operations. If your v3.15.x tests were written against the old behavior, they'll fail after this fix.

---

## Risk Theme 9: `DBLoadResult` Type Collapse in dotcom's `TLDrawDurableObject`

In `967d3af`, the `DBLoadResult` type was simplified from a discriminated union:
```typescript
// Before (d039f3a):
type DBLoadResult = 
  | { type: 'error'; error?: Error }
  | { type: 'room_found'; snapshot: RoomSnapshot; roomSizeMB: number }
  | { type: 'room_not_found' }
```
to a flat interface:
```typescript
// After (967d3af):
interface DBLoadResult {
  snapshot: RoomSnapshot
  roomSizeMB: number
}
```

The `room_not_found` case is now handled by **throwing `ROOM_NOT_FOUND`** (a Symbol) rather than returning a discriminant. The `error` case throws directly.

If your v3.15.x baseline still has the discriminated union form, and the backport's `TLFileDurableObject.loadStorage()` calls `this.loadFromDatabase(slug)` expecting the flat form, you'll get a runtime error trying to access `.snapshot` on `{ type: 'room_not_found' }`.

---

## Risk Theme 10: `migratePersistedRecord` Behaviour Change for `'storage'`-scoped Migrations

In `89ecb28`, the `migratePersistedRecord` method in `StoreSchema` was updated to reject `'storage'`-scoped migrations with `TargetVersionTooNew`/`TargetVersionTooOld`:

```typescript
// 89ecb28 / d039f3a StoreSchema.ts:
if (migrationsToApply.some((m) => m.scope === 'storage')) {
    return { type: 'error', reason: MigrationFailureReason.TargetVersionTooNew }
}
```

This means that if any migration in the sequence uses `'storage'` scope, `migratePersistedRecord` (used by clients for per-record migration) will return an error. This is by design — storage-scoped migrations can only run server-side via `migrateStorage`. But on the **client**, receiving a record from an older server that hasn't run `migrateStorage` yet will cause the client's schema to reject it as unmigrable.

**Watch-out:** In a mixed-version rollout where some server instances are on the new code and some on old, clients connecting to old servers may receive records at the old schema version, then fail to migrate them client-side because their schema now has a `'storage'`-scoped migration in the chain. This causes `TLIncompatibilityReason.ServerTooOld` rejections.

---

## Key Differences vs. Main That Invalidate Assumptions

### 1. `DurableObjectSqliteSyncWrapper` in Backport Lacks OTel Spans
The `89ecb28` (backport) version of `DurableObjectSqliteSyncWrapper` calls `withSyncSpan` on every SQL operation. Main's `967d3af` version doesn't. Your backport plan says you're excluding OTel — verify which source file you're using for the wrappers.

### 2. The `'storage'` Migration Scope in `store-migrations.ts`
Main's `967d3af` converted 4 existing `scope: 'store'` migrations in `store-migrations.ts` to `scope: 'storage'`. These include `RemoveCodeAndIconShapeTypes`, `AddInstancePresenceType`, `RemoveTLUserAndPresenceAndAddPointer`, `RemoveUserDocument`. If the v3.15.x baseline still has the old `scope: 'store'` for these, and the backported `migrateStorage` is called during SQLite initialization, those migrations won't be applied (they're only handled in the `'store'` branch in `migrateStorage`, which does run them for backward compat — but only if `scope === 'store'`, not `'storage'`). Verify whether those `'storage'` scope reassignments are in your backport or not.

### 3. `SimpleTldrawDurableObject` Reset Logic
In `89ecb28`, the `SimpleTldrawDurableObject.handleReset()` changed from replaying the `initialSnapshot` (captured at construction time) to passing `DEFAULT_INITIAL_SNAPSHOT` — because with SQLite storage, you can't "replay" to original state by passing the initial snapshot (that would re-seed the DB). This means test resets on the dotcom simple server now always reset to blank (empty document) rather than whatever the room started with.

### 4. `TLSyncClient` `lastServerClock = -1` Is Not in Main at `967d3af`
The `-1` initialization is in `4b45869`, which is a branch-local backport commit (commit message: "sync-core: use -1 initial server clock and drop rebase usability guard"). This is **not** in the same position on main. On main, `lastServerClock` may still be `0`. If you're comparing client behavior between branches during validation, clients on main will connect with `lastServerClock: 0` (requesting diffs since clock 0), while your backport clients connect with `lastServerClock: -1` (requesting full initial sync). This changes initial sync volume and could trigger different server code paths.

### 5. `RoomStoreMethods` Export Location Changed
Before `d039f3a`, `RoomStoreMethods` was exported from `TLSyncRoom`. After, it moves to `TLSocketRoom`. The `index.ts` in `89ecb28` exports it from `TLSocketRoom`. Any code that imports `RoomStoreMethods` from `TLSyncRoom` will break.
