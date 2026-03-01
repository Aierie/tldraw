# SQLite Backport Implementation Report (March 1, 2026)

## Scope
- Task: implement `investigation/backport-sqlite-implementation-plan.md` in `tldraw-3`.
- Acceptance source: findings documents in `investigation/findings/` plus runtime validation.
- Note: legacy `investigation/claims` artifacts were removed and are not used for acceptance.

## Phase-to-commit mapping
1. Phase A/B/C/D (`store` migration substrate, storage abstraction, room/socket conversion, sqlite backend):
   - `89ecb2882` backport sqlite sync storage implementation
   - `f3bfadd06` fix sync-room compatibility updateStore behavior
   - `6774bd059` add backport storage migration and sync storage tests
   - `3fa9cdc96` add node20-safe sqlite migration assertions
2. Acceptance/process cleanup:
   - `269a2a8f9` drop stale claims artifacts and align sqlite acceptance docs
3. Phase F (`sync-cloudflare` migration and class/binding wiring):
   - `78b52991a` backport cloudflare sqlite durable object migration wiring
   - `a2eafe83f` remove legacy cloudflare kv durable object template path
   - `dffa84446` normalize cloudflare sqlite migration noop tag

## Validation summary
1. Sync-core/store test coverage (branch run history):
   - `corepack yarn workspace @tldraw/store test --runInBand src/lib/test/recordStore.test.ts`
   - `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/TLSyncRoom.test.ts`
   - `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/TLSocketRoom.test.ts`
   - `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/InMemorySyncStorage.test.ts`
   - `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/SQLiteSyncStorage.test.ts`
   - `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/InMemorySyncStorage.test.ts -t "migrateStorage"`
   - `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/SQLiteSyncStorage.test.ts -t "wrapper-level"`
   - `corepack yarn workspace @tldraw/sync-core test --runInBand src/test/SQLiteSyncStorage.test.ts -t "Migration from TEXT to BLOB"`
   - Result: passing; Node 20 guard conditions respected where `node:sqlite` is unavailable (Node-dependent SQLite cases are skipped, wrapper-level migration checks still pass).
2. Required OTel feedback loop (non-gating) rerun on March 1, 2026:
   - `./skills/tldraw-otel-lab/scripts/otel_lab.sh up --fresh --no-worker`
   - `corepack yarn workspace @tldraw/dotcom-worker playwright test -c ./e2e/playwright.config.ts ./e2e/tests/simple-sync-worker.spec.ts -g "essential canvas ops write to OTel traces"`
   - `corepack yarn workspace @tldraw/dotcom-worker playwright test -c ./e2e/playwright.config.ts ./e2e/tests/simple-sync-worker.spec.ts`
   - `jq -r '.resourceSpans[].scopeSpans[].spans[].name' internal/observability/otel/data/traces.jsonl | sort -u | rg 'tlsync\\.client\\.push|tlsync\\.client\\.store_changes'`
   - `./skills/tldraw-otel-lab/scripts/otel_lab.sh down`
   - Result: targeted and full simple worker e2e passed (6/6); required client spans present (`tlsync.client.push`, `tlsync.client.store_changes`).
3. Cloudflare template wiring validation:
   - `corepack yarn workspace tldraw-sync-cloudflare tsc --noEmit`
   - Result: passing after sqlite DO class/binding/migration wiring backport.

## Notes
1. `corepack yarn workspace tldraw-sync-cloudflare build` still reports a pre-existing client CSS resolution problem (`tldraw/tldraw.css`) unrelated to sqlite DO wiring.
2. `git restore` in this repo currently triggers `.husky/post-checkout` noise and creates a transient `0` file; this was cleaned during validation and does not affect committed outputs.
