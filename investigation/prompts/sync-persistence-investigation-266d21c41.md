# Prompt: Persistence Evolution Investigation — 266d21c41

Investigate persistence for the tldraw sync backend at this checkpoint:

- **Target ref:** `266d21c41`
- **Compare against:** `95b18b7c3`

## Why this commit is of interest
- Follow-up Cloudflare Durable Object SQLite migration fix.
- Clarifies/corrects migration behavior specifically for DO-backed multiplayer template paths.
- Important for validating the final operational migration model in Cloudflare environments.

## Overarching goal (series context)
Contribute one step in a full evolution study: complete all checkpoint investigations, generate findings docs for each, then synthesize how persistence architecture changed over time.

## Baseline context
- Prior reports should establish earlier template migration fix; focus on what this follow-up changes and why it was still needed.

## Investigation goals
1. Check out `266d21c41`.
2. Trace what remained broken after `95b18b7c3` and how this commit resolves it.
3. Explain final expected DO migration sequence for existing vs fresh deployments.
4. Produce report:  
   `investigation/findings/sync-persistence-investigation-266d21c41.md`
5. Include section: `Evolution vs 95b18b7c3`.

## Investigation protocol
- Use deep investigation mode.
- Use `context_builder` first (required), then targeted `ask_oracle`.
- Gather direct code evidence with file:line + function anchors.
- Confirm checked-out ref in the report header.

## Output expectations
- Confirm commit checked out.
- Confirm findings file path.
- Provide concise chat summary.
