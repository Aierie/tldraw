# SQLite sync storage backport investigation (base: `1e9ed3513`)

This note captures the most important repository-state facts for porting `SQLiteSyncStorage` from modern `main` back to this commit, with claims tied to reproducible checks.

## Why this commit is a risky backport base

1. **The Cloudflare template migration chain has no SQLite transition step yet.**
   - `wrangler.toml` has only `new_classes = ["TldrawDurableObject"]` for `v1`.
   - There is no `classes_with_sqlite` / `new_sqlite_classes` declaration.
   - Backport implication: introducing SQLite-backed storage requires an **append-only migration addition** (new tag), not mutation of `v1`, to keep deployment upgrades safe.

2. **Runtime persistence model is snapshot-to-R2, not DB-backed sync storage.**
   - `TldrawDurableObject` reads and writes the room snapshot in R2 (`r2.get` / `r2.put`) and uses DO storage only for `roomId` metadata.
   - Backport implication: SQLite porting is not a drop-in; it changes persistence semantics from periodic full snapshot writes to transaction-oriented storage operations.

3. **`@tldraw/sync-core` in this commit does not expose SQLite storage wrappers/classes.**
   - No `SQLiteSyncStorage`, `DurableObjectSqliteSyncWrapper`, `NodeSqliteWrapper`, or `TLSyncSqliteWrapper` symbols are present in `packages/sync-core` or the Cloudflare template.
   - Backport implication: porting requires pulling in API surface plus implementation, then adapting template runtime code.

## Checks used as proof

Run:

```bash
node internal/scripts/check-sync-persistence-backport.mjs
```

The script asserts:

- DO migrations create the class but do not enable SQLite mode.
- DO persistence path is R2 snapshots + DO `roomId` metadata.
- No SQLite storage symbols are present in current `sync-core`/template code.

## Suggested porting order

1. Introduce SQLite wrappers + `SQLiteSyncStorage` in `@tldraw/sync-core` (API + tests).
2. Update `templates/sync-cloudflare/worker/TldrawDurableObject.ts` to initialize `SQLiteSyncStorage` (instead of R2 snapshot path).
3. Add a new Cloudflare migration tag for SQLite enablement (append-only).
4. Keep an explicit fallback/upgrade story for previously snapshotted rooms.
