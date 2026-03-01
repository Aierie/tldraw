# Prompt: Persistence Evolution Investigation — d039f3a1a

Investigate persistence for the tldraw sync backend at this checkpoint:

- **Target ref:** `d039f3a1a`
- **Compare against:** `016d4c288`

## Why this commit is of interest
- This is the architecture pivot from inline `TLSyncRoom` state ownership to pluggable `TLSyncStorage`.
- It changes where persistence hooks live (`TLSocketRoom` + storage lifecycle), and migration behavior (`'storage'` scope).
- It is the prerequisite contract for all later SQLite/DO storage work.

## Overarching goal (series context)
Contribute one step in a full evolution study: complete all checkpoint investigations, generate findings docs for each, then synthesize how persistence architecture changed over time.

## Baseline context
- Baseline already investigated at `v3.15.x`:
  - `investigation/findings/sync-persistence-investigation-v3.15.x.md`
- Focus here on **delta from baseline**, not re-documenting unchanged flows.

## Investigation goals
1. Check out `d039f3a1a`.
2. Trace persistence flow end-to-end, emphasizing storage abstraction boundaries:
   - where mutations enter authoritative server state
   - where persistence triggers now originate
   - how snapshots are produced/loaded with storage-first APIs
3. Explain how migration semantics changed (`store` vs `storage` scope).
4. Produce report:  
   `investigation/findings/sync-persistence-investigation-d039f3a1a.md`
5. Include section: `Evolution vs 016d4c288` with architectural deltas.

## Investigation protocol
- Use deep investigation mode.
- Use `context_builder` first (required), then targeted `ask_oracle`.
- Gather direct code evidence with file:line + function anchors.
- Confirm checked-out ref in the report header.

## Output expectations
- Confirm commit checked out.
- Confirm findings file path.
- Provide concise chat summary.

