# Backport Plan: SQLite Persistence (`tldraw` -> `tldraw-3`)

## 1) Scope and Non-Goals

### In scope
- Backport SQLite persistence architecture into `tldraw-3` with minimal surface-area change.
- Make Cloudflare/Durable Objects usage first-class and deployment-safe.
- Preserve websocket behavior compatibility (`connect`, `push_result`, peer `patch`, `pong`).
- Bring over required migration safety behaviors (TEXT->BLOB, no double-apply migration bug, startup fallback semantics where applicable).

### Out of scope
- Unrelated protocol modernization.
- Feature additions not required for SQLite + Cloudflare viability.
- Broad refactors outside store migration substrate, sync-core storage path, worker wiring, and Cloudflare migration wiring.

### Hard rule
- No protocol/version/op-surface drift unless proven necessary and isolated with explicit justification.

## 2) Source-vs-Target Architecture Delta (What drives the plan)

1. Target is still snapshot/in-memory room centric, while source is storage-transaction centric.
   - Anchors:
     - `tldraw/packages/sync-core/src/lib/TLSyncRoom.ts`
     - `tldraw-3/packages/sync-core/src/lib/TLSyncRoom.ts`
     - `tldraw/packages/sync-core/src/lib/TLSocketRoom.ts`
     - `tldraw-3/packages/sync-core/src/lib/TLSocketRoom.ts`

2. Target store migration substrate lacks storage-scope support required by storage-backed sync safety.
   - Anchors:
     - `tldraw/packages/store/src/lib/migrate.ts`
     - `tldraw-3/packages/store/src/lib/migrate.ts`
     - `tldraw/packages/store/src/lib/StoreSchema.ts`
     - `tldraw-3/packages/store/src/lib/StoreSchema.ts`

3. Source has concrete SQLite stack and wrappers; target does not fully.
   - Anchors:
     - `tldraw/packages/sync-core/src/lib/TLSyncStorage.ts`
     - `tldraw/packages/sync-core/src/lib/SQLiteSyncStorage.ts`
     - `tldraw/packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts`
     - `tldraw/packages/sync-core/src/lib/NodeSqliteWrapper.ts`
     - `tldraw/packages/sync-core/src/lib/InMemorySyncStorage.ts`

4. Simple worker wiring differs: source is storage-injected SQLite, target still uses initial snapshot path.
   - Anchors:
     - `tldraw/apps/dotcom/sync-worker/src/simple/SimpleTldrawDurableObject.ts`
     - `tldraw-3/apps/dotcom/sync-worker/src/simple/SimpleTldrawDurableObject.ts`

5. Cloudflare migration-chain correctness is mandatory and must be planned as a deployment subsystem.

## 3) Phased Backport Plan (Subsystem-Oriented)

### Phase A: Store Migration Substrate (Prerequisite)
**Objective**
Enable storage-backed migration safety in `tldraw-3` before syncing engine changes.

**Must-do deliverables**
- Add storage migration scope/types in target store migration model.
- Add `StoreSchema.migrateStorage(...)` behavior with staged updates (avoid mutating while iterating live storage cursors).
- Export necessary storage migration types from store public index.

**Validation gate**
- Store package builds cleanly.
- Migration behavior parity checks pass for once-per-record migration behavior in memory/SQLite paths once those tests are brought over.

**Rollback posture**
- Isolated to store package; reversible without touching runtime sync protocol.

### Phase B: Sync-Core Storage Abstraction Layer
**Objective**
Introduce the storage contract and in-memory implementation needed to transition room/socket behavior safely.

**Must-do deliverables**
- Introduce `TLSyncStorage` abstraction and transaction result semantics.
- Introduce/align `InMemorySyncStorage`, notifier, and record diff helper surface needed by storage-backed room logic.
- Preserve backward compatibility pathways where feasible (`initialSnapshot` support in socket room as compatibility layer).

**Validation gate**
- Sync-core compiles with no protocol-surface expansion beyond necessity.
- In-memory storage tests pass (including migration-related behavior).

**Rollback posture**
- Keep this phase isolated from worker wiring so regressions are contained to sync-core internals.

### Phase C: Room/Socket Engine Conversion (In-Memory -> Transactional Storage)
**Objective**
Move `TLSyncRoom` and `TLSocketRoom` in target to storage-transaction-backed behavior while preserving existing protocol semantics.

**Must-do deliverables**
- `TLSyncRoom` connect/push paths operate through `storage.transaction(...)`.
- `TLSocketRoom` accepts injected storage and still supports compatibility behavior needed by existing call-sites.
- Preserve message semantics (`connect`, `push_result`, peer `patch`, `pong`) and avoid protocol drift from newer source baseline.

**Protocol drift guard (required)**
- Explicitly list any protocol-facing behavior touched.
- For each touched behavior: "necessary for SQLite backport" vs "excluded".
- If any new protocol-era feature is required, isolate and justify it.

**Validation gate**
- Existing and adapted e2e behavior remains stable.
- Push outcome semantics (`commit`/`discard`/`rebaseWithDiff`) unchanged at interface level.

**Rollback posture**
- Commit boundary should allow reverting engine conversion while keeping earlier substrate work intact.

### Phase D: SQLite Backend + Wrappers + Exports
**Objective**
Introduce concrete persistence backend with migration-safe behavior and runtime wrappers.

**Must-do deliverables**
- Add SQLite storage backend and wrappers for Durable Objects and Node.
- Include TEXT->BLOB migration path and metadata migration version handling.
- Include migration integrity protections tied to once-per-record application behavior.
- Align sync-core exports so backend is consumable by worker layers.

**Validation gate**
- SQLite storage unit tests pass, including:
  - TEXT->BLOB migration regression.
  - `migrateStorage` once-per-record behavior.
- Node wrapper integration test passes.

**Rollback posture**
- Backend remains dormant until wiring phases consume it; easy to disable by unwiring call-sites.

### Phase E: Simple Sync Worker Wiring
**Objective**
Switch target simple DO path from snapshot-only room creation to SQLite-backed storage injection.

**Must-do deliverables**
- Durable Object simple worker creates sqlite wrapper + sqlite storage and injects storage into socket room.
- Reset/test routes continue to work with SQLite-backed lifecycle.
- No auth/route behavior regressions.

**Validation gate**
- Target simple-worker e2e suite passes.
- Snapshot/reset semantics remain valid after conversion.

**Rollback posture**
- Revert worker wiring phase independently if needed while keeping backend availability in sync-core.

### Phase F: Cloudflare Migration + Runtime Wiring (Mandatory)
**Objective**
Ensure Cloudflare template/deployment path is migration-chain safe and aligned with SQLite class/binding wiring.

**Must-do deliverables**
- Plan and apply append-only migration chain updates for DO class transitions.
- Align class name, binding, exports, and typing to SQLite-backed DO class path.
- Explicitly account for known ineffective migration directive history and ensure forward-safe sequence.

**Validation gate**
- Static config checks for migration tags/binding alignment.
- Runtime sanity path (local wrangler/dev): connect -> write -> reconnect succeeds against SQLite-backed DO path.
- No class/binding mismatch in generated types/runtime wiring.

**Rollback posture**
- Forward-only migration discipline; no rewriting historical tags.
- If remediation is needed, add a new migration step rather than modifying shipped ones.

### Phase G: Consolidated Verification + Hardening
**Objective**
Prove backport correctness and operational readiness.

**Must-do deliverables**
- Ordered validation execution and pass/fail report.
- Risk closure summary (what was mitigated, what remains).
- Final minimal-change conformance note.

**Validation order**
1. Sync-core/store unit tests (fast feedback).
2. SQLite-specific unit + integration tests.
3. Simple worker e2e.
4. Cloudflare config/runtime checks.
5. Investigation findings parity review (`investigation/findings/*.md`) for documented regressions.

**Required feedback loop (non-gating)**
- Run OTel trace checks for SQLite span family and connect/push `did_change` semantics.
- Use these traces as implementation feedback and change documentation (confirm code paths are flowing as intended).
- Do not treat OTel parity as acceptance gating for the backport.

## 4) Dependency / Prerequisite Graph

1. Phase A -> required for Phase C and Phase D migration safety.
2. Phase B -> required for Phase C engine conversion.
3. Phase C + Phase D -> required before Phase E worker wiring.
4. Phase D -> required before Phase F Cloudflare runtime viability.
5. Phase E + Phase F -> required before final Phase G signoff.

## 5) Risk Register (Minimal-Change Backport)

| Risk | Impact | Mitigation | Detection Signal |
|---|---|---|---|
| Protocol drift from newer source baseline | Client incompatibility/regressions | Hard exclusion of unrelated protocol features; explicit drift audit section per phase | Unexpected protocol/type surface changes in sync-core |
| TEXT->BLOB migration errors | Data unreadable/corrupt on existing DBs | Carry explicit v1->v2 migration path + regression tests | Failing TEXT->BLOB test or parse errors on existing data |
| Double-application of migrations | Data mutation duplication | Stage migration updates after iteration; avoid in-loop writes on live cursors | Failing once-per-record migration tests |
| Startup fallback semantics regressions | Room load failures/behavior differences | Keep fallback/not-found semantics explicitly planned and tested in DO boot flows | Boot failures or incorrect ROOM_NOT_FOUND handling |
| Cloudflare migration chain mistakes | Broken deploy/runtime binding | Append-only migration discipline + binding/class/type alignment checks | Wrangler migration anomalies, class not found, binding mismatch |
| Over-expansion of change scope | Delivery risk, hidden regressions | Must-do vs nice-to-have split; phase boundaries and rollback points | Cross-package churn outside defined subsystem boundaries |

## 6) Validation Strategy (Concrete)

**Primary required validation anchors**
- `tldraw/packages/sync-core/src/test/SQLiteSyncStorage.test.ts`
- `tldraw/packages/sync-core/src/test/InMemorySyncStorage.test.ts`
- `tldraw/packages/sync-core/src/lib/NodeSqliteSyncWrapper.integration.test.ts`
- `tldraw-3/apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts`

**Test intent coverage**
- Storage migration correctness.
- Transactional push/connect behavior preservation.
- SQLite-backed worker runtime behavior.
- Cloudflare migration/wiring viability.

**Findings-driven acceptance usage**
- Use the investigation findings docs as the acceptance checklist and reporting structure.
- Do not treat the legacy `investigation/claims` directory as an acceptance source.

**Runtime/tooling assumption**
- Use Node.js 20 for all installs/scripts/tests.

## 7) Rollback / Recovery Strategy

1. Keep each phase in isolated commits with clear scope labels.
2. Roll back by phase boundary, not by ad-hoc file revert.
3. Do not rewrite Cloudflare migration history; remediate with forward migrations.
4. Keep backward-compatible constructor/options surface during transition to allow safe unwind.
5. Preserve a known-good pre-wiring state where SQLite backend exists but is not active in worker wiring.

## 8) Clear Completion Criteria (Implementation Complete)

1. `tldraw-3` has a storage-backed sync architecture in place end-to-end:
   - Store migration substrate supports storage-scope migration behavior.
   - `TLSyncRoom`/`TLSocketRoom` operate with injected `TLSyncStorage`.
   - SQLite backend + wrappers are wired and exported.

2. Simple sync worker in `tldraw-3` runs on SQLite-backed storage (not snapshot-only room state), and reset/snapshot test routes still function correctly.

3. Cloudflare path is production-viable:
   - Durable Object class/binding/export/type wiring is aligned.
   - Migration chain is append-only and correctly transitions to SQLite-backed class behavior.

4. Migration integrity is validated:
   - Existing DB upgrade path for TEXT -> BLOB works.
   - Storage migrations apply once per record (no double-application regression).

5. Websocket behavior compatibility is preserved:
   - `connect`, `push_result`, peer `patch`, and `pong` semantics remain correct.
   - No protocol/version/op-surface drift unless explicitly justified and isolated.

6. Verification suite passes at required levels:
   - Sync-core/store unit tests for migrated behaviors.
   - SQLite-specific unit/integration coverage.
   - `tldraw-3` simple sync-worker e2e coverage for persistence behavior.

7. Rollback safety is documented and practical:
   - Changes are phased in reversible commit boundaries.
   - Cloudflare migration remediation strategy uses forward migrations only.

8. Observability feedback loop recorded (non-gating):
   - OTel SQLite span-family and connect/push `did_change` semantics reviewed and documented.
   - Findings are captured as diagnostic evidence of code-path behavior, not release-blocking acceptance criteria.
