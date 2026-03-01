# Expected SQLite WebSocket Read/Write Behavior After Backport (tldraw-3)

## Purpose
Define the expected runtime behavior in `tldraw-3` once SQLite storage support is backported from `tldraw@4`, with a specific focus on:

1. which websocket-related flows read SQLite
2. which flows write SQLite
3. what OTel traces should prove those behaviors

## Reference baseline
Use the following reference naming throughout this document:

1. current repo name: `tldraw-3`
2. current repo path: `.`
3. reference repo name: `tldraw@4`
4. reference repo path: `../tldraw`
5. path notation: `<tldraw-3>/...` means `./...`
6. path notation: `<tldraw@4>/...` means `../tldraw/...`

`tldraw@4` is a later-version sibling repo used as the concrete backport target.

This document is based on:

1. current `tldraw-3` traces in `internal/observability/otel/data`
2. equivalent traces/code in `tldraw@4`
3. persistence findings in `investigation/findings/`

## Current gap summary in this branch
`tldraw-3` currently lacks the SQLite storage path used by the simple sync worker and by file-room DO flows in `tldraw@4`. As a result, traces in this branch do not include the SQLite span family:

1. `tlsync.storage.sqlite.exec`
2. `tlsync.storage.sqlite.statement.all`
3. `tlsync.storage.sqlite.statement.iterate`
4. `tlsync.storage.sqlite.statement.run`
5. `tlsync.storage.sqlite.transaction`
6. `tlsync.storage.sqlite.transaction.wrapper`

`tldraw-3` traces currently include only the client probe stacktrace (`tlsync.client.stacktrace_probe`) and not SQLite stacktrace events.

In observed `tldraw-3` reload traces, `tlsync.client.did_reconnect` is present, but
`tlsync.socket.client.reconnect.schedule_attempt` and
`tlsync.socket.client.reconnect.connected` are absent; equivalent `tldraw@4` traces include both.

## Expected architecture after backport
After backport, websocket room state should be backed by `SQLiteSyncStorage` via `DurableObjectSqliteSyncWrapper` (same model as `tldraw@4`):

1. room bootstrap uses SQLite storage, not only in-memory snapshot state
2. `TLSyncRoom` reads/writes via `TLSyncStorage.transaction(...)`
3. storage emits on-change callbacks that trigger persist scheduling
4. websocket protocol semantics remain unchanged (`connect`, `push_result`, peer `patch`, `pong`)

## Event-to-storage behavior matrix

| Event / flow | SQLite reads | SQLite writes | Expected websocket outcome | Expected OTel evidence |
|---|---|---|---|---|
| First room load on connect (cold DO/room) | metadata checks (`SELECT migrationVersion/schema/documentClock`) | schema bootstrap (`CREATE TABLE...`, metadata init), optional snapshot seed (`DELETE`, `INSERT`, metadata update) | socket connects and receives normal `connect` hydration | `tlsync.storage.sqlite.exec`, `...statement.all`, `...statement.run`, `...transaction.wrapper` |
| Connect request (`type: connect`) after room exists | `getChangesSince(lastServerClock)`, snapshot diff reads, clock/schema reads | none (read-only transaction for hydration) | server sends `connect` with `diff` + `serverClock` | `tlsync.room.connect` with nested SQLite `...transaction` and `...statement.*` reads |
| Push request with document diff (`type: push`, `diff`) | existing document reads (`get`/`exists`), changed-since reads for broadcast/rebase | `insert/replace document`, `delete document`, `insert tombstone`, metadata clock increment, tombstone pruning updates | source gets `push_result` (`commit`, `discard`, or `rebaseWithDiff`), peers get `patch` | `tlsync.room.push` plus high-frequency SQLite `...statement.run/all/iterate` and `...transaction` |
| Push request with presence only (`type: push`, `presence`) | none in document SQLite path | none in document SQLite path | presence rebroadcast only; no document clock mutation | `tlsync.room.push` may exist, but no meaningful SQLite write burst tied to document diff |
| Ping (`type: ping`) | none | none | `pong` | no SQLite spans expected |
| Client reconnect loop (offline/visibility/network hints) | reconnect itself none; subsequent connect reads per connect path | only if reconnect triggers first-time bootstrap for room instance | reconnect succeeds or retries based on socket state | client spans `tlsync.socket.client.reconnect.schedule_attempt` and `...connected`; SQLite spans only on actual room storage access |
| Test reset route for simple worker | reads may occur during re-open hydration | room reset seeds baseline snapshot into SQLite-backed storage | room returns to baseline snapshot | SQLite bootstrap/seed spans should appear after reset cycle |
| Restore flow (`/restore`) | may read storage state for migration and diff checks | snapshot load writes records/tombstones/schema into SQLite | subsequent connects hydrate from restored state | storage transaction + statement spans around snapshot load |
| Last-session persist to durable backend | snapshot reads (`iterate documents`, `iterate tombstones`, metadata reads) | no direct SQLite write required for snapshot read itself | room may close after persist; state preserved in SQLite and durable backend | SQLite `...statement.iterate/all` around `getSnapshot()` during persist |

## Concrete SQLite statements observed in equivalent traces
The following statements were observed in `<tldraw@4>/internal/observability/otel/data/traces*.jsonl` and are the concrete SQL evidence we should expect after backport.

### Reference implementation note (later version)
All code references in this section point to `<tldraw@4>/...`, which is a later version than `tldraw-3` and is used here as the concrete behavior target for backporting.

Key reference anchors:

1. SQLite migration/bootstrap logic:
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:88` (`migrateSqliteSyncStorage`)
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:110` (`CREATE TABLE ...`)
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:164` (`UPDATE metadata SET migrationVersion`)
2. Prepared statements and snapshot seed/reset writes:
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:274` (statement preparation block)
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:357` (`DELETE FROM documents/tombstones`)
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:365` / `:371` / `:376` (document/tombstone/metadata seeding)
3. Connect/push websocket handling:
   - `<tldraw@4>/packages/sync-core/src/lib/TLSyncRoom.ts:865` (`handleConnectRequest`)
   - `<tldraw@4>/packages/sync-core/src/lib/TLSyncRoom.ts:943` (`storage.transaction` in connect)
   - `<tldraw@4>/packages/sync-core/src/lib/TLSyncRoom.ts:997` (`handlePushRequest`)
   - `<tldraw@4>/packages/sync-core/src/lib/TLSyncRoom.ts:1147` (`storage.transaction` in push)
4. Transactional read/write semantics:
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:392` (`tlsync.storage.sqlite.transaction`)
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:562` (`get`)
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:569` (`set`)
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:578` (`delete`)
   - `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:623` (`getChangesSince`)
5. SQLite span instrumentation source:
   - `<tldraw@4>/packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts:44` (`statement.iterate`)
   - `<tldraw@4>/packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts:61` (`statement.all`)
   - `<tldraw@4>/packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts:75` (`statement.run`)
   - `<tldraw@4>/packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts:133` (`sqlite.exec`)
   - `<tldraw@4>/packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts:155` (`transaction.wrapper`)
6. Simple worker SQLite wiring used by current trace evidence:
   - `<tldraw@4>/apps/dotcom/sync-worker/src/simple/SimpleTldrawDurableObject.ts:46` (`new DurableObjectSqliteSyncWrapper`)
   - `<tldraw@4>/apps/dotcom/sync-worker/src/simple/SimpleTldrawDurableObject.ts:51` (`new SQLiteSyncStorage`)
   - `<tldraw@4>/apps/dotcom/sync-worker/src/simple/SimpleTldrawDurableObject.ts:99` (`/api/connect/:roomId`)

### Websocket `push` flow (document mutations)
These statement spans were observed with ancestry including:
`tlsync.room.push -> tlsync.socket.server.receive -> tlsync.storage.sqlite.transaction -> tlsync.storage.sqlite.transaction.wrapper`

1. `SELECT documentClock FROM metadata LIMIT 1` (observed 71)
2. `SELECT state FROM documents WHERE id = ?` (observed 32)
3. `DELETE FROM tombstones WHERE id = ?` (observed 23)
4. `INSERT OR REPLACE INTO documents (id, state, lastChangedClock) VALUES (?, ?, ?)` (observed 23)
5. `UPDATE metadata SET documentClock = documentClock + 1` (observed 11)
6. `SELECT id FROM documents WHERE id = ?` (observed 9)
7. `DELETE FROM documents WHERE id = ?` (observed 9)
8. `INSERT OR REPLACE INTO tombstones (id, clock) VALUES (?, ?)` (observed 9)
9. `SELECT count(*) as count FROM tombstones` (observed 3)

Interpretation:

1. Reads (`SELECT ...`) are used for conflict/rebase and existence checks.
2. Writes (`INSERT/DELETE/UPDATE`) match put/delete/tombstone semantics.
3. Clock increment is tied to transactions that perform actual document changes.

Code references in later version (`tldraw@4`):

1. Push transaction entry: `<tldraw@4>/packages/sync-core/src/lib/TLSyncRoom.ts:1133`
2. Push document op dispatch (`Put`/`Patch`/`Remove`): `<tldraw@4>/packages/sync-core/src/lib/TLSyncRoom.ts:1188`
3. SQLite transaction `set`/`delete` semantics: `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:569` and `:578`

### Websocket `connect` flow (hydration reads)
These statement spans were observed with ancestry including:
`tlsync.room.connect -> tlsync.socket.server.receive -> tlsync.storage.sqlite.transaction -> tlsync.storage.sqlite.transaction.wrapper`

1. `SELECT documentClock FROM metadata LIMIT 1` (observed 20)
2. `SELECT state FROM documents` (observed 4)
3. `SELECT tombstoneHistoryStartsAtClock FROM metadata` (observed 4)

Interpretation:

1. Connect path is read-oriented and computes hydration diff/snapshot metadata.
2. No document-table mutation statement is required for ordinary connect hydration.

Code references in later version (`tldraw@4`):

1. Connect transaction entry: `<tldraw@4>/packages/sync-core/src/lib/TLSyncRoom.ts:932`
2. Hydration diff read call (`txn.getChangesSince`): `<tldraw@4>/packages/sync-core/src/lib/TLSyncRoom.ts:945`
3. SQLite implementation of `getChangesSince`: `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:623`

### Bootstrap/reset/seed path (non-websocket-managed route contexts)
These statements were observed on root-ish SQLite traces without room push/connect ancestors, matching storage constructor/reset/bootstrap activity:

1. `SELECT migrationVersion FROM metadata LIMIT 1` (observed 6)
2. `CREATE TABLE documents (...); CREATE INDEX ...; CREATE TABLE tombstones (...); CREATE TABLE metadata (...) ...` via `tlsync.storage.sqlite.exec` (observed 3, statement truncated in span attribute)
3. `UPDATE metadata SET migrationVersion = 2` via `tlsync.storage.sqlite.exec` (observed 6)
4. `DELETE FROM documents; DELETE FROM tombstones;` via `tlsync.storage.sqlite.exec` (observed 6)
5. `UPDATE metadata SET documentClock = ?, tombstoneHistoryStartsAtClock = ?, schema = ?` (observed 6)

Interpretation:

1. First access probes migration metadata; missing table is expected before schema creation.
2. Bootstrap then creates schema and finalizes migration version.
3. Snapshot seed/reset clears tables and writes metadata/document state.

Code references in later version (`tldraw@4`):

1. Migration probe and bootstrap DDL: `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:97` and `:110`
2. Migration finalize write: `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:164`
3. Snapshot seed/reset writes in constructor: `<tldraw@4>/packages/sync-core/src/lib/SQLiteSyncStorage.ts:351`
4. Simple worker reset route that recreates storage-backed room: `<tldraw@4>/apps/dotcom/sync-worker/src/simple/SimpleTldrawDurableObject.ts:127`

## Expected behavior per websocket message type

### `connect`
1. Server validates protocol/schema compatibility.
2. Server opens a storage transaction and computes diff since client clock.
3. Storage access should be read-only for normal hydration.
4. No document mutation should happen from connect alone.

### `push` (document diff)
1. Server applies ops against authoritative storage in a transaction.
2. Any actual doc mutation increments document clock exactly once per transaction path.
3. Deletes write tombstones and may trigger pruning logic.
4. Response action semantics stay unchanged:
   - `commit`: server effect equivalent to client intent
   - `discard`: no effective document change
   - `rebaseWithDiff`: server-authoritative result differs

### `push` (presence only)
1. Presence updates stay in presence store behavior.
2. Presence-only updates should not generate document-table writes.
3. Peers still receive presence changes over websocket.

### `ping`
1. Health/liveness only.
2. No SQLite read/write side effects.

## Stacktrace expectations after backport
Expected stacktrace capture should include both categories:

1. Existing client probe stacktrace:
   - span: `tlsync.client.stacktrace_probe`
   - event: `exception`
   - attribute: `exception.stacktrace`
2. SQLite stacktrace events during bootstrap edge cases:
   - span: typically `tlsync.storage.sqlite.statement.all`
   - event: `exception`
   - known case from equivalent traces: metadata table not yet present (`no such table: metadata`)
   - concrete failing statement in equivalent traces: `SELECT migrationVersion FROM metadata LIMIT 1` (observed 4 exception events)
   - this can be expected during first migration probe and should not break room startup if handled by migration flow

## Backport guardrails from investigation findings

1. Migration integrity: preserve deferred-write migration behavior to avoid double-application during SQLite cursor iteration (see finding `5221da51b`).
2. Storage representation/migration: preserve TEXT->BLOB migration and encoding/decoding boundaries (see finding `d1c72b2b0`).
3. Startup resilience: preserve `ROOM_NOT_FOUND` semantics and non-not-found fallback behavior where applicable (see finding `d6ff76672`).
4. DO migration sequencing: keep append-only wrangler migrations and correct SQLite class/binding transitions (see findings `95b18b7c3`, `266d21c41`).

## Trace-driven backport implications
Direct trace/code comparison between `tldraw-3` and `tldraw@4` implies:

1. This is a coordinated room+storage backport, not a storage-class drop-in:
   `SimpleTldrawDurableObject` and `TLSyncRoom` must both move to the storage-backed transaction model used in `tldraw@4`.
2. `connect` must stay read-only at the storage layer:
   no document writes or document-clock mutation on ordinary hydration.
3. `push` semantics must remain split by effect:
   document-changing pushes produce SQLite writes and clock increment; presence-only/no-op pushes do not.
4. Cold bootstrap/reset SQLite paths are expected to run outside websocket ancestry:
   migration probe, schema creation, seed/reset statements, and tolerated first-probe metadata-table exceptions.
5. Reconnect observability parity should be restored with the SQLite backport validation pass:
   include explicit reconnect scheduling/connected spans, not only `tlsync.client.did_reconnect`.

## Trace-based acceptance criteria for this branch
After SQLite backport, traces for the existing sync-worker e2e flows should show:

1. Presence of SQLite span family (`exec`, `statement.*`, `transaction`, `transaction.wrapper`) in `internal/observability/otel/data/traces*.jsonl`.
2. `tlsync.room.push` spans coexisting with SQLite write activity for document-editing tests.
3. `tlsync.client.stacktrace_probe` exception stacktrace still present.
4. At least one SQLite exception stacktrace event may appear during cold bootstrap metadata probing and should not fail test flow by itself.
5. Reconnect spans (`tlsync.socket.client.reconnect.schedule_attempt`, `...connected`) present on reload/reconnect scenarios (not only `tlsync.client.did_reconnect`).
6. `tlsync.room.connect` traces include nested SQLite transaction spans with read-only semantics (`tldraw.storage.did_change = false` in normal hydration paths).
7. Document-changing `tlsync.room.push` traces include SQLite write statements (document/tombstone writes and metadata clock increment) with `tldraw.storage.did_change = true`.
8. Presence-only/no-op `tlsync.room.push` traces do not show document write bursts or metadata clock increment; if a storage transaction is present it should remain `tldraw.storage.did_change = false`.
9. Cold-start/reset traces include bootstrap/seed evidence (`SELECT migrationVersion`, schema bootstrap `exec`, reset/seed writes), and first-probe metadata-missing exceptions are tolerated if startup completes.

## Non-goals
This document does not require changing websocket protocol semantics. It defines expected storage behavior and trace observability once SQLite is ported.
