# Sync persistence claim test matrix

This matrix maps each claim to a deterministic test. Use it with `investigation/claims/manifest.yaml`.

## Static tests (git/code assertions)

- **T-STATIC-001** — Storage abstraction introduced in `d039f3a1a`
  - Command:
    - `git show --name-only d039f3a1a -- packages/sync-core/src/lib/TLSyncRoom.ts packages/sync-core/src/lib/TLSyncStorage.ts`
  - Pass if both files are in the commit and `TLSyncRoom` references `storage.transaction`.

- **T-STATIC-002** — SQLite backend + wrappers introduced in `967d3af52`
  - Command:
    - `git show --name-only 967d3af52 -- packages/sync-core/src/lib/`
  - Pass if `SqlLiteSyncStorage.ts`, `DurableObjectSqliteSyncWrapper.ts`, and `NodeSqliteWrapper.ts` appear.

- **T-STATIC-003** — 5221 scope check
  - Command:
    - `git show --name-only 5221da51b`
  - Pass if changed files are migration engine / shape migration / tests and exclude protocol handlers (`TLSyncRoom.ts`, `TLSocketRoom.ts`).

- **T-STATIC-004** — 95 scope check
  - Command:
    - `git show --name-only 95b18b7c3`
  - Pass if only `templates/sync-cloudflare/wrangler.toml` changed.

## Protocol behavior tests

- **T-PROTO-001** — Source gets `push_result`
  - Environment: Node sync server (simple-server-example or equivalent).
  - Method: Two clients join same room. Client A pushes mutation.
  - Pass if A receives `push_result` (commit/discard/rebaseWithDiff).

- **T-PROTO-002** — Peers get patch; source excluded
  - Environment: same as T-PROTO-001.
  - Method: Capture outbound messages for A and B.
  - Pass if B receives `patch` and A does not receive same rebroadcast patch for its own mutation.

## Persistence scheduling tests

- **T-PERSIST-001** — Deferred persistence (not per mutation)
  - Environment: dotcom worker or controlled equivalent.
  - Method: Burst mutations, count durable writes.
  - Pass if writes are coalesced under throttle/alarm behavior.

- **T-PERSIST-002** — Persist on last session out
  - Environment: same.
  - Method: Open room, mutate, disconnect final session.
  - Pass if persistence is triggered before close.

## Migration tests

- **T-MIG-001** — Storage migration scope exists
  - Command:
    - `git show d039f3a1a:packages/store/src/lib/migrate.ts | rg "scope: 'storage'|StorageMigration"`
  - Pass if storage migration scope/types are present.

- **T-MIG-002** — v1(TEXT)->v2(BLOB) migration implemented
  - Command:
    - `git show d1c72b2b0:packages/sync-core/src/lib/SQLiteSyncStorage.ts | rg "migrationVersion|CAST\(state AS BLOB\)|state BLOB"`
  - Pass if all key migration markers are present.

- **T-MIG-003** — TEXT->BLOB migration regression test exists/passes
  - Command:
    - `pnpm vitest packages/sync-core/src/test/SQLiteSyncStorage.test.ts -t "Migration from TEXT to BLOB"`
  - Pass if test passes.

- **T-MIG-004** — once-per-record migration under SQLite
  - Command:
    - `pnpm vitest packages/sync-core/src/test/SQLiteSyncStorage.test.ts -t "Schema migrations via migrateStorage"`
  - Pass if test passes.

- **T-MIG-005** — once-per-record migration parity in memory
  - Command:
    - `pnpm vitest packages/sync-core/src/test/InMemorySyncStorage.test.ts -t "migrateStorage"`
  - Pass if equivalent once-only behavior passes.

## Boot/recovery tests

- **T-BOOT-001** — SQLite feature flag path
  - Command:
    - `git show 967d3af52:apps/dotcom/sync-worker/src/TLFileDurableObject.ts | rg "sqlite_file_storage|SQLiteSyncStorage|SqlLiteSyncStorage"`
  - Pass if flag-gated branch exists.

- **T-BOOT-002** — Fallback for non-ROOM_NOT_FOUND
  - Command:
    - `git show d6ff76672:apps/dotcom/sync-worker/src/TLFileDurableObject.ts | rg "try|catch|super.loadStorage|ROOM_NOT_FOUND"`
  - Pass if catch block reports error and falls back to `super.loadStorage` for non-ROOM_NOT_FOUND.

- **T-BOOT-003** — ROOM_NOT_FOUND passthrough
  - Method: Inject/trigger ROOM_NOT_FOUND in load path.
  - Pass if error is rethrown (no fallback).

- **T-BOOT-004** — Clock-based reconciliation rule
  - Method: Set `lastPersistedR2Clock > sqliteClock` in test harness.
  - Pass if load path rehydrates from DB/R2 snapshot to SQLite.

## Cloudflare migration tests

- **T-CF-001** — 95 migration chain split
  - Command:
    - `git show 95b18b7c3 -- templates/sync-cloudflare/wrangler.toml`
  - Pass if `v1` uses `new_classes` and `v2` adds `classes_with_sqlite`.

- **T-CF-002** — 266 class replacement migration
  - Command:
    - `git show 266d21c41 -- templates/sync-cloudflare/wrangler.toml`
  - Pass if `v3` contains `deleted_classes=["TldrawDurableObject"]` and `new_sqlite_classes=["TldrawDurableObjectSqlite"]`.

- **T-CF-003** — 266 runtime wiring alignment
  - Command:
    - `git show 266d21c41 -- templates/sync-cloudflare/wrangler.toml templates/sync-cloudflare/worker/worker.ts templates/sync-cloudflare/worker-configuration.d.ts templates/sync-cloudflare/worker/TldrawDurableObjectSqlite.ts`
  - Pass if class name, export, env typing, and DO symbol all reference `TldrawDurableObjectSqlite`.

## Coverage map (claim -> tests)

- CLM-V315-001: T-PROTO-001, T-PROTO-002
- CLM-V315-002: T-PERSIST-001, T-PERSIST-002
- CLM-D039-001: T-STATIC-001
- CLM-D039-002: T-MIG-001
- CLM-967-001: T-STATIC-002
- CLM-967-002: T-BOOT-001
- CLM-D1-001: T-MIG-002, T-MIG-003
- CLM-D6-001: T-BOOT-002, T-BOOT-003
- CLM-D6-002: T-BOOT-004
- CLM-5221-001: T-MIG-004, T-MIG-005
- CLM-5221-002: T-STATIC-003
- CLM-95-001: T-CF-001
- CLM-95-002: T-STATIC-004
- CLM-266-001: T-CF-002
- CLM-266-002: T-CF-003
