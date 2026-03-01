# Prompt: Persistence Evolution Deep Investigation

Investigate persistence for the tldraw sync backend at this checkpoint:

- **Target ref:** `<git ref>` (commit SHA / tag / branch)
- **Compare against (recommended):** `<older/newer git ref>`
- **Investigation mode:** `<baseline | delta>`
- **Why this checkpoint matters:** `<1-5 bullets>`
- **Series goal:** Complete all checkpoint investigations, create all findings docs, then study architectural evolution end-to-end.
- **Prior findings to reuse (optional):**
  - `investigation/findings/<baseline-or-prior>.md`

## Goals
1. Check out the target ref.
2. Trace end-to-end persistence flow:
   - canvas mutation in editor/client
   - store diff emission
   - sync client message encoding + transport
   - backend ingest + authoritative apply
   - persistence scheduling + durable writes
3. Create a report under `investigation/findings/` named:
   - `sync-persistence-investigation-<ref>.md`
4. Include:
   - exact file:line evidence
   - function-name anchors in addition to line numbers
   - root-cause style explanation of “how persistence works”
   - ack/rebroadcast semantics
   - failure/retry/consistency mechanisms
   - eliminated hypotheses
   - recommendations + preventive measures
   - at least one **Mermaid sequence diagram** of code paths
5. If `Compare against` is provided, add a section:
   - `Evolution vs <compare-ref>`
   - architectural differences
   - changed code paths
   - changed durability semantics (timing, storage targets, retries, etc.)
6. If `Investigation mode = delta`, add:
   - `Delta from prior findings`
   - what is unchanged (don’t re-argue it)
   - what changed and why it matters
   - `Carry-forward questions for next checkpoint`

## Investigation protocol
- Use deep investigation mode.
- Use `context_builder` first (required), then follow with targeted `ask_oracle`.
- Don’t conclude before gathering direct code evidence.
- Validate checked-out ref and include it at the top of the report.
- Reuse prior findings where possible; avoid restating baseline details unless needed to explain a change.

## Output expectations
- Confirm branch/commit checked out.
- Confirm report file path under `investigation/findings/`.
- Give a concise summary in chat after writing the report.
