# Prompt: Persistence Evolution Investigation — d1c72b2b0

Investigate persistence for the tldraw sync backend at this checkpoint:

- **Target ref:** `d1c72b2b0`
- **Compare against:** `967d3af52`

## Why this commit is of interest
- Changes SQLite document storage from `TEXT` JSON to `BLOB` bytes.
- Adds/updates schema migration behavior (v1 → v2), which is critical for existing deployments.
- Alters serialization/deserialization boundaries and compatibility guarantees.

## Overarching goal (series context)
Contribute one step in a full evolution study: complete all checkpoint investigations, generate findings docs for each, then synthesize how persistence architecture changed over time.

## Baseline context
- Prior reports should already capture baseline + storage abstraction + initial SQLite architecture.
- Focus here on schema/data representation migration semantics and durability implications.

## Investigation goals
1. Check out `d1c72b2b0`.
2. Trace persistence flow for document encoding/decoding and migration:
   - pre-migration state assumptions
   - migration execution order and guards
   - post-migration read/write behavior
3. Identify risk scenarios for large records and upgrade path safety.
4. Produce report:  
   `investigation/findings/sync-persistence-investigation-d1c72b2b0.md`
5. Include section: `Evolution vs 967d3af52`.

## Investigation protocol
- Use deep investigation mode.
- Use `context_builder` first (required), then targeted `ask_oracle`.
- Gather direct code evidence with file:line + function anchors.
- Confirm checked-out ref in the report header.

## Output expectations
- Confirm commit checked out.
- Confirm findings file path.
- Provide concise chat summary.
