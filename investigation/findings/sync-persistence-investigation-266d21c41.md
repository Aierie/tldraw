# Sync persistence investigation — 266d21c41

- **Checked-out ref:** `266d21c41` (artifact-validated via `_git_data/repos/tldraw-22691012/2026-02-27/2248-2/MAP.txt:10` with `SNAPSHOT_COMPARE: 266d21c41^..266d21c41`, and `_git_data/repos/tldraw-22691012/2026-02-27/2248-2/MAP.txt:21` with `FINGERPRINT_HEAD_SHA: 266d21c41ec34445ed4bc49baf819a79f544cf9d`)
- **Compare ref:** `95b18b7c3` (artifact-validated via `_git_data/repos/tldraw-22691012/2026-02-27/2248/MAP.txt:10` with `SNAPSHOT_COMPARE: 95b18b7c3..266d21c41`)
- **Prompt:** `investigation/prompts/sync-persistence-investigation-266d21c41.md`

## Scope and framing
This checkpoint is a Cloudflare Durable Object migration-control fix for the sync-cloudflare template. It does not change sync protocol code paths; it fixes class/migration wiring used to reach SQLite-backed DO persistence.

## What remained broken after 95b18b7c3
`95b18b7c3` introduced `v2` using `classes_with_sqlite` (`_git_data/repos/tldraw-22691012/2026-02-27/2235/deep/changed_lines.tsv:5-7`).

`266d21c41` explicitly calls that out as ineffective:
- `# v2 was a no-op: classes_with_sqlite is not a valid Cloudflare migration directive` (`templates/sync-cloudflare/wrangler.toml:31`; `_git_data/repos/tldraw-22691012/2026-02-27/2248-2/deep/changed_lines.tsv:11`).

So after 95, the template still lacked a valid transition to the intended SQLite-backed DO class.

## How 266d21c41 resolves it
This commit switches from in-place mode conversion to class replacement and aligns all references:

1. **Binding target changed** to SQLite class:
   - `class_name = "TldrawDurableObjectSqlite"` (`templates/sync-cloudflare/wrangler.toml:23`; `_git_data/.../2248-2/deep/changed_lines.tsv:9-10`).
2. **New v3 migration** added:
   - `deleted_classes = ["TldrawDurableObject"]`
   - `new_sqlite_classes = ["TldrawDurableObjectSqlite"]`
   (`templates/sync-cloudflare/wrangler.toml:37-40`; `_git_data/.../2248-2/deep/changed_lines.tsv:13-16`).
3. **Worker export + env types aligned** with new class:
   - `export { TldrawDurableObjectSqlite } ...` (`templates/sync-cloudflare/worker/worker.ts:6`)
   - `DurableObjectNamespace<import('./worker/worker').TldrawDurableObjectSqlite>` (`templates/sync-cloudflare/worker-configuration.d.ts:6-8`; `_git_data/.../2248-2/deep/changed_lines.tsv:1-4`).
4. **DO class symbol aligned**:
   - `export class TldrawDurableObjectSqlite extends DurableObject` (`templates/sync-cloudflare/worker/TldrawDurableObjectSqlite.ts:22`; `_git_data/.../2248-2/deep/changed_lines.tsv:5-6`).

## Final expected DO migration sequence
### Existing deployments
1. `v1` created old class (`new_classes = ["TldrawDurableObject"]`, `wrangler.toml:28-29`).
2. `v2` is retained but explicitly noted as no-op (`wrangler.toml:31-34`).
3. Deploying this commit applies `v3`, deleting old class and creating new SQLite class (`wrangler.toml:37-40`).
4. Runtime binding points to the new class (`wrangler.toml:23`, `worker.ts:6`).

### Fresh deployments
1. Migration chain remains append-only (`v1 -> v2 -> v3`) in the template config.
2. Effective class/binding after migration is `TldrawDurableObjectSqlite` (`wrangler.toml:23,37-40`).
3. Runtime class uses SQLite-backed storage wrapper (`templates/sync-cloudflare/worker/TldrawDurableObjectSqlite.ts:29-33`).

## Persistence path context (unchanged runtime flow)
- `/api/connect/:roomId` route still resolves DO stub and forwards request (`templates/sync-cloudflare/worker/worker.ts:17-21`).
- DO handler still performs room websocket attach (`templates/sync-cloudflare/worker/TldrawDurableObjectSqlite.ts:45-57`).
- Core ack/rebroadcast logic is unchanged in this commit (changed-file tree is config/template wiring only: `_git_data/repos/tldraw-22691012/2026-02-27/2248-2/MAP.txt:75-87`).

## Evolution vs 95b18b7c3
- `95b18b7c3` introduced the `v2 classes_with_sqlite` step (`_git_data/.../2235/deep/changed_lines.tsv:5-7`).
- `266d21c41` establishes that this step did not work in practice (explicit no-op comment) and replaces it with a concrete `v3` class replacement migration (`wrangler.toml:31-40`; `_git_data/.../2248-2/deep/changed_lines.tsv:11-16`).
- Architectural shift: from “mutate existing class mode” to “replace class with explicit SQLite-backed class and retarget binding/export/types.”

## Eliminated hypotheses
1. **Protocol bug hypothesis:** eliminated; no sync-core protocol files changed (`_git_data/.../2248-2/MAP.txt:75-87`).
2. **Type-only cleanup hypothesis:** eliminated; wrangler migration directives and DO binding changed materially (`wrangler.toml:23,37-40`).
3. **95 fully fixed migration hypothesis:** eliminated by explicit `v2` no-op note and v3 replacement path (`wrangler.toml:31-40`).

## Notes / caveats
- The “invalid directive” claim is explicitly stated in repo code comments (`wrangler.toml:31`); this report treats that as direct project intent.
- Artifact map includes rename noise (`TldrawDurableObjectSqlite.ts}`), so line-level evidence is taken from `deep/changed_lines.tsv` plus checked-out files.
