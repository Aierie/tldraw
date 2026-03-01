# Runbook: prove/disprove sync persistence claims

This runbook executes the manifest and matrix in a repeatable way.

## Files
- Claim manifest: `investigation/claims/manifest.yaml`
- Test matrix: `investigation/claims/test-matrix.md`

## Prerequisites
1. From repo root:
   - `cd /Users/michael/Personal/code/tldraw`
2. Install dependencies once:
   - `pnpm install` (or `yarn install --immutable`)
3. Optional (Cloudflare template runtime checks):
   - `pnpm dlx wrangler --version`

## Step 1: Static verification sweep (all checkpoints)
Run these commands and store output in a dated folder.

```bash
mkdir -p investigation/claims/results/$(date +%F)
OUT=investigation/claims/results/$(date +%F)

git show --name-only d039f3a1a > "$OUT/d039-name-only.txt"
git show --name-only 967d3af52 > "$OUT/967-name-only.txt"
git show --name-only d1c72b2b0 > "$OUT/d1-name-only.txt"
git show --name-only d6ff76672 > "$OUT/d6-name-only.txt"
git show --name-only 5221da51b > "$OUT/5221-name-only.txt"
git show --name-only 95b18b7c3 > "$OUT/95-name-only.txt"
git show --name-only 266d21c41 > "$OUT/266-name-only.txt"

git show 95b18b7c3 -- templates/sync-cloudflare/wrangler.toml > "$OUT/95-wrangler.diff"
git show 266d21c41 -- templates/sync-cloudflare/wrangler.toml templates/sync-cloudflare/worker/worker.ts templates/sync-cloudflare/worker-configuration.d.ts templates/sync-cloudflare/worker/TldrawDurableObjectSqlite.ts > "$OUT/266-cf-wiring.diff"
```

Then evaluate pass/fail using the exact criteria in `test-matrix.md` for:
- T-STATIC-001..004
- T-MIG-001..002
- T-BOOT-001..002
- T-CF-001..003

## Step 2: Unit/regression verification (code behavior)
Run targeted tests:

```bash
pnpm vitest packages/sync-core/src/test/SQLiteSyncStorage.test.ts -t "Migration from TEXT to BLOB"
pnpm vitest packages/sync-core/src/test/SQLiteSyncStorage.test.ts -t "Schema migrations via migrateStorage"
pnpm vitest packages/sync-core/src/test/InMemorySyncStorage.test.ts -t "migrateStorage"
```

Record results against:
- T-MIG-003
- T-MIG-004
- T-MIG-005

## Step 3: Protocol and persistence runtime checks
Use a runnable sync server setup (Node path first, then Cloudflare path if needed).

### 3A) Node runtime (recommended first)
Goal: validate T-PROTO-001, T-PROTO-002, T-PERSIST-001, T-PERSIST-002.

Minimum method:
1. Start server for the checkpoint/ref you are validating.
2. Connect two clients (A, B) to same room.
3. Perform mutation from A.
4. Capture server/client messages and persistence side effects.

Pass/fail criteria are defined in `test-matrix.md`.

### 3B) Cloudflare template runtime (when validating 95/266 migration chain claims)
Goal: validate T-CF-001..003 behavior in a realistic deploy path.

Suggested flow:
1. In `templates/sync-cloudflare`, set up local env.
2. Run local worker with wrangler.
3. Confirm migration tags/class bindings in effective config.
4. Perform connect + write + reconnect scenario.

## Step 4: Score each claim
Create `investigation/claims/results/<date>/scorecard.md` with one line per claim:

```md
- CLM-D1-001: PASS (T-MIG-002 PASS, T-MIG-003 PASS)
- CLM-5221-001: PASS (T-MIG-004 PASS, T-MIG-005 PASS)
- CLM-95-002: PASS (T-STATIC-004 PASS)
```

Use status values:
- `PASS`
- `FAIL`
- `PARTIAL` (some tests pass, others pending)
- `UNVERIFIED`

## Step 5: Decide overview correctness
After scoring, produce:
- `investigation/claims/results/<date>/overview-verdict.md`

Template:
```md
# Overview verdict

## Correct claims
- ...

## Incorrect/overstated claims
- ...

## Final verdict
- Mostly correct / Mixed / Mostly incorrect

## Evidence links
- scorecard.md
- key diff outputs
```

## Notes
- Treat static proof and runtime proof separately; a claim can be statically plausible but runtime-unverified.
- For Cloudflare migration claims, static diffs are necessary but not always sufficient for production confidence; add runtime checks when possible.
