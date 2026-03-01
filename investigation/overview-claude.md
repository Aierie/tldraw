# tldraw storage system: commit history for backporting SQLiteSyncStorage to v3.15.x

This document lists the commits required to understand and backport `SQLiteSyncStorage` from the v4.x
line into v3.15.x. All commits are in the [tldraw/tldraw](https://github.com/tldraw/tldraw) monorepo.

---

## Group 1 — Baseline: what v3.15.x actually is

These are the last commits that touched `TLSyncRoom` / `TLSocketRoom` before the storage refactor.
Read them to fully understand the starting state you are patching *into*.

| Date | Commit | Subject |
|---|---|---|
| 2025-07-25 | [`6319eac61`](https://github.com/tldraw/tldraw/commit/6319eac61869213d14b8c65a786790579fbbd76f) | TLSyncRoom optimization ([#6488](https://github.com/tldraw/tldraw/pull/6488)) |
| 2025-08-06 | [`8c74738e0`](https://github.com/tldraw/tldraw/commit/8c74738e06fbc6498e7b88edb5244c4a495bc1f9) | Fix: change handlers not passed to new room instance ([#6549](https://github.com/tldraw/tldraw/pull/6549)) |
| 2025-08-28 | [`016d4c288`](https://github.com/tldraw/tldraw/commit/016d4c2889b7c18e0b4c7a2d063593e354ca0bc1) | Save and reinstate documentClock properly ([#6666](https://github.com/tldraw/tldraw/pull/6666)) |

**What to look for:**

- How `TLSyncRoom` owns `documents` and `tombstones` inside a reactive `Atom`-keyed dictionary
- How `onDataChange` is wired up and called
- How `documentClock` is tracked and round-tripped through `RoomSnapshot`
- The `MAX_TOMBSTONES = 3000` / `TOMBSTONE_PRUNE_BUFFER_SIZE = 300` inline pruning logic that gets extracted later

---

## Group 2 — Two small pre-refactor additions (context only)

These landed between v3.15.x and the big refactor. They are minor but touch files you will diff.

| Date | Commit | Subject |
|---|---|---|
| 2025-08-26 | [`4c3f2b478`](https://github.com/tldraw/tldraw/commit/4c3f2b4783e64955f02bd5ab005fcf0ba6e8f080) | Support sending custom server messages to connected clients ([#6614](https://github.com/tldraw/tldraw/pull/6614)) |
| 2025-11-06 | [`8e28283dc`](https://github.com/tldraw/tldraw/commit/8e28283dc716412e31ce3713e61c9870174d9688) | Add stream operation for string append optimization ([#7007](https://github.com/tldraw/tldraw/pull/7007)) |

**What to look for:**

- `4c3f2b478` — adds `sendCustomMessage` to `TLSocketRoom`; does not touch storage but modifies a file you will patch
- `8e28283dc` — adds a `stream` op-type to `protocol.ts` and `diff.ts`; neither file touches storage but both appear in diffs across the refactor

---

## Group 3 — The pivotal refactor (must read in full)

| Date | Commit | Subject |
|---|---|---|
| 2025-12-08 | [`d039f3a1a`](https://github.com/tldraw/tldraw/commit/d039f3a1ab8fffea7de88758486a0576cf792b3c) | **abstract out sync storage ([#7123](https://github.com/tldraw/tldraw/pull/7123))** |

This is the single most important commit. Read the full diff and the commit message, which contains
a detailed migration guide. The PR description is the canonical spec for the new API.

**New files created:**

- `packages/sync-core/src/lib/TLSyncStorage.ts` — the `TLSyncStorage<R>` interface and transaction types
- `packages/sync-core/src/lib/InMemorySyncStorage.ts` — replaces the inline `Atom`-based store in `TLSyncRoom`
- `packages/sync-core/src/lib/recordDiff.ts` — extracted diff helpers

**Heavily rewritten:**

- `packages/sync-core/src/lib/TLSyncRoom.ts` — receives `storage: TLSyncStorage<R>` as a dependency instead of owning the document map
- `packages/sync-core/src/lib/TLSocketRoom.ts` — gains `storage?: TLSyncStorage<R>` option; `initialSnapshot` and `onDataChange` become `@deprecated`

**`@tldraw/store` changes** (you may need these too):

- `packages/store/src/lib/StoreSchema.ts` — gains a new `'storage'` migration scope alongside the existing `'store'` scope
- `packages/store/src/index.ts` — exports `SynchronousStorage` and `AtomMap`

---

## Group 4 — SQLite implementation (the code being backported)

| Date | Commit | Subject |
|---|---|---|
| 2025-12-10 | [`967d3af52`](https://github.com/tldraw/tldraw/commit/967d3af528127869a6f6778425499c2befa755cf) | **Add SQLite storage support for sync ([#7320](https://github.com/tldraw/tldraw/pull/7320))** |
| 2025-12-11 | [`e30d21a52`](https://github.com/tldraw/tldraw/commit/e30d21a52b090a9588062240cf2cbb68e75f9f37) | Rename SqlLiteSyncStorage → SQLiteSyncStorage ([#7344](https://github.com/tldraw/tldraw/pull/7344)) |
| 2025-12-11 | [`d1c72b2b0`](https://github.com/tldraw/tldraw/commit/d1c72b2b01a8128d52ebe5a8f5d34a27e4eba933) | **use blobs for sqlite ([#7350](https://github.com/tldraw/tldraw/pull/7350))** |
| 2025-12-12 | [`d6ff76672`](https://github.com/tldraw/tldraw/commit/d6ff7667259b56dc6ce54d2424302b13bf2715e2) | sqlite: Add load fallback and bump file record attempts ([#7355](https://github.com/tldraw/tldraw/pull/7355)) |

**What to look for:**

- `967d3af52` — introduces `SqlLiteSyncStorage.ts`, `NodeSqliteWrapper.ts`, `MicrotaskNotifier.ts`,
  and `DurableObjectSqliteSyncWrapper.ts`; also refactors `InMemorySyncStorage.ts` to extract
  `computeTombstonePruning` as a shared utility used by both storage backends. The updated
  `templates/simple-server-example/src/server/rooms.ts` is a clean reference implementation
  of the full SQLite-backed Node.js server pattern.

- `e30d21a52` — pure rename from `SqlLiteSyncStorage` to `SQLiteSyncStorage`; trivial

- `d1c72b2b0` — **do not skip**. Switches the `documents` column from `TEXT` (JSON string) to
  `BLOB` (`Uint8Array`) for efficiency. This is schema migration v1→v2. If you omit this commit
  your migration path will be broken for any database that was written with the v0/v1 schema.

- `d6ff76672` — adds a load fallback for when the initial SQLite read fails, plus retry logic for
  `fileRecord` writes in the dotcom worker. The fallback in `SQLiteSyncStorage` is worth including;
  the `fileRecord` retry is dotcom-specific and can be skipped.

---

## Group 5 — Bug fixes to include in the backport

| Date | Commit | Subject |
|---|---|---|
| 2026-01-09 | [`5221da51b`](https://github.com/tldraw/tldraw/commit/5221da51b0197f2fdc36344ff90ef957f00c15fa) | **fix sqlite double migration ([#7655](https://github.com/tldraw/tldraw/pull/7655))** |
| 2026-02-04 | [`95b18b7c3`](https://github.com/tldraw/tldraw/commit/95b18b7c3d58a57742051b714b2e2d8d9a56a836) | fix(sync): fix SQLite migration for multiplayer template ([#7829](https://github.com/tldraw/tldraw/pull/7829)) |
| 2026-02-04 | [`266d21c41`](https://github.com/tldraw/tldraw/commit/266d21c41ec34445ed4bc49baf819a79f544cf9d) | fix(sync): fix Durable Object SQLite migration in multiplayer template ([#7832](https://github.com/tldraw/tldraw/pull/7832)) |

**What to look for:**

- `5221da51b` — **include this**. Fixes a bug where the migration runs twice when a room is
  reloaded from an existing database. Affects `SQLiteSyncStorage.ts` directly.

- `95b18b7c3` and `266d21c41` — fix the `sync-cloudflare` and Durable Object templates. Only
  relevant if you are targeting Cloudflare Durable Objects; skip for a Node.js-only backport.

---

## Group 6 — Dotcom consolidation (reference only)

| Date | Commit | Subject |
|---|---|---|
| 2025-12-10 | [`b63d72f42`](https://github.com/tldraw/tldraw/commit/b63d72f423e23809ed964ff2332d32273913f617) | Allow safely toggling sqlite feature flag ([#7332](https://github.com/tldraw/tldraw/pull/7332)) |
| 2026-02-25 | [`79a720cbb`](https://github.com/tldraw/tldraw/commit/79a720cbb4f3853057b25500dc57fa2235f977a9) | remove sqlite feature flag and consolidate durable objects ([#7346](https://github.com/tldraw/tldraw/pull/7346)) |

These only affect `apps/dotcom/sync-worker`. Skip unless studying the Cloudflare Durable Object path.

---

## Recommended reading order

```
1. 6319eac61   understand the v3.15.x baseline (TLSyncRoom owns documents in an Atom)
2. 016d4c288   how documentClock survives a snapshot round-trip
3. d039f3a1a   the full storage abstraction refactor — read commit message + full diff
4. 967d3af52   SQLite implementation (SqlLiteSyncStorage + NodeSqliteWrapper)
5. d1c72b2b0   BLOB encoding / schema migration v2 — do not miss this
6. 5221da51b   double-migration bugfix — include in your port
```

---

## Files to produce for the backport

**New files** (copy from HEAD, adjusting imports to match v3.15.x package structure):

| File | Source commit |
|---|---|
| `packages/sync-core/src/lib/TLSyncStorage.ts` | `d039f3a1a` |
| `packages/sync-core/src/lib/InMemorySyncStorage.ts` | `d039f3a1a` + `967d3af52` |
| `packages/sync-core/src/lib/SQLiteSyncStorage.ts` | `967d3af52` + `d1c72b2b0` + `5221da51b` |
| `packages/sync-core/src/lib/NodeSqliteWrapper.ts` | `967d3af52` |
| `packages/sync-core/src/lib/MicrotaskNotifier.ts` | `967d3af52` |
| `packages/sync-core/src/lib/computeTombstonePruning.ts` | `967d3af52` |

**Files to patch** (apply the storage-related hunks from `d039f3a1a`):

| File | What changes |
|---|---|
| `packages/sync-core/src/lib/TLSyncRoom.ts` | Swap inline `Atom`-based store for `TLSyncStorage<R>` dependency |
| `packages/sync-core/src/lib/TLSocketRoom.ts` | Add `storage?` option; deprecate `initialSnapshot` / `onDataChange` |
| `packages/sync-core/src/index.ts` | Export the new types and classes |
| `packages/store/src/lib/StoreSchema.ts` | Add `'storage'` migration scope (if you need schema migrations) |
