# Prompt: Persistence Evolution Investigation — 95b18b7c3

Investigate persistence for the tldraw sync backend at this checkpoint:

- **Target ref:** `95b18b7c3`
- **Compare against:** `5221da51b`

## Why this commit is of interest
- Fixes Cloudflare template migration sequencing for switching Durable Objects to SQLite.
- Addresses real deployment upgrade behavior where existing migration tags prevent expected SQLite activation.
- Important for operational correctness in existing multiplayer deployments.

## Overarching goal (series context)
Contribute one step in a full evolution study: complete all checkpoint investigations, generate findings docs for each, then synthesize how persistence architecture changed over time.

## Baseline context
- Prior reports should cover core library/storage behavior; this investigation focuses on deployment migration semantics.

## Investigation goals
1. Check out `95b18b7c3`.
2. Trace Cloudflare migration configuration behavior:
   - old vs new migration tags
   - when SQLite enablement actually applies
3. Explain deployment-path implications for already-live environments.
4. Produce report:  
   `investigation/findings/sync-persistence-investigation-95b18b7c3.md`
5. Include section: `Evolution vs 5221da51b`.

## Investigation protocol
- Use deep investigation mode.
- Use `context_builder` first (required), then targeted `ask_oracle`.
- Gather direct code evidence with file:line + function anchors.
- Confirm checked-out ref in the report header.

## Output expectations
- Confirm commit checked out.
- Confirm findings file path.
- Provide concise chat summary.
