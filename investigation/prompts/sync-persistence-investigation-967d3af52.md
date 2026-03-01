# Prompt: Persistence Evolution Investigation — 967d3af52

Investigate persistence for the tldraw sync backend at this checkpoint:

- **Target ref:** `967d3af52`
- **Compare against:** `d039f3a1a`

## Why this commit is of interest
- Introduces SQLite-backed sync storage (`SqlLite/SQLiteSyncStorage`) plus Node and Durable Object wrappers.
- First concrete persistent storage backend implementation against `TLSyncStorage`.
- Introduces new durability code paths in templates and DO-oriented runtime wiring.

## Overarching goal (series context)
Contribute one step in a full evolution study: complete all checkpoint investigations, generate findings docs for each, then synthesize how persistence architecture changed over time.

## Baseline context
- Reuse previous findings:
  - `investigation/findings/sync-persistence-investigation-v3.15.x.md`
  - `investigation/findings/sync-persistence-investigation-d039f3a1a.md` (after created)
- Focus on new SQLite/DO durability mechanics.

## Investigation goals
1. Check out `967d3af52`.
2. Trace end-to-end persistence with emphasis on SQLite integration:
   - storage initialization and room boot sequence
   - authoritative apply → SQLite writes
   - notifier/scheduling behavior for change propagation
3. For Cloudflare path, identify DO-specific persistence boundaries and failure surfaces.
4. Produce report:  
   `investigation/findings/sync-persistence-investigation-967d3af52.md`
5. Include section: `Evolution vs d039f3a1a`.

## Investigation protocol
- Use deep investigation mode.
- Use `context_builder` first (required), then targeted `ask_oracle`.
- Gather direct code evidence with file:line + function anchors.
- Confirm checked-out ref in the report header.

## Output expectations
- Confirm commit checked out.
- Confirm findings file path.
- Provide concise chat summary.

