# Prompt: Persistence Evolution Investigation — 5221da51b

Investigate persistence for the tldraw sync backend at this checkpoint:

- **Target ref:** `5221da51b`
- **Compare against:** `d6ff76672`

## Why this commit is of interest
- Fixes double-application of storage migrations caused by live SQLite iteration behavior.
- Protects migration correctness in real room reload scenarios.
- Directly affects data integrity guarantees for evolved schemas.

## Overarching goal (series context)
Contribute one step in a full evolution study: complete all checkpoint investigations, generate findings docs for each, then synthesize how persistence architecture changed over time.

## Baseline context
- Prior reports should have established migration mechanics; focus here on correctness under iteration/update interactions.

## Investigation goals
1. Check out `5221da51b`.
2. Trace migration execution path and pinpoint why duplicate migration occurred pre-fix.
3. Explain exactly how batching/deferred updates resolve the issue.
4. Produce report:  
   `investigation/findings/sync-persistence-investigation-5221da51b.md`
5. Include section: `Evolution vs d6ff76672`.

## Investigation protocol
- Use deep investigation mode.
- Use `context_builder` first (required), then targeted `ask_oracle`.
- Gather direct code evidence with file:line + function anchors.
- Confirm checked-out ref in the report header.

## Output expectations
- Confirm commit checked out.
- Confirm findings file path.
- Provide concise chat summary.
