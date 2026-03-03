# Suggestions to Improve `canvas-divergence-deep-analysis.md`

## 1) Add a short executive summary (P0)

The current doc is detailed but starts at methodology depth. Add a 5-8 line summary at the top with:

- what diverges semantically vs what only diverges in instrumentation
- what is intentional and should remain
- what should be aligned next

Suggested summary framing:

- Intentional behavioral divergence: presence suppression in solo mode, client push coalescing, storage backend (in-memory vs SQLite).
- Non-behavioral divergence: missing/uneven OTel attributes (`tldraw.msg.type`) in `tldraw-3`.
- Recommendation: keep behavioral differences, align telemetry fields for clean comparison.

## 2) Strengthen reproducibility metadata (P0)

The analysis references trace files and span counts, but reproducibility is still weak. Add:

- exact git SHA for both repos used in the comparison run
- test command and any env flags used for "essential-only" mode
- timestamp of each run and whether traces were cleared beforehand
- explicit filtering rules in one compact checklist

This makes future reruns auditable and avoids ambiguity when line numbers drift.

## 3) Separate behavioral vs observability divergence in one matrix (P0)

Add a dedicated table like:

| Divergence | Type | Evidence | Keep vs Align |
|---|---|---|---|
| Presence push suppression in solo mode | Behavioral | `useSync` + `TLSyncClient` refs | Keep |
| Unsent diff coalescing | Behavioral | `TLSyncClient` refs + push-count delta | Keep |
| SQLite-backed storage path in `tldraw` | Behavioral/architecture | `SimpleTldrawDurableObject` + storage refs | Keep |
| Missing `tldraw.msg.type` on `tldraw-3` client spans | Instrumentation | Generic span table | Align |

This clarifies what is a product/runtime choice versus what is a telemetry quality gap.

## 4) Anchor claims with the `investigation/findings` timeline (P0)

The deep analysis should reference the commit-sequence findings to justify architecture claims:

- baseline room/persistence path: `investigation/findings/sync-persistence-investigation-v3.15.x.md`
- storage abstraction pivot: `investigation/findings/sync-persistence-investigation-d039f3a1a.md`
- SQLite introduction: `investigation/findings/sync-persistence-investigation-967d3af52.md`
- migration/reliability hardening with unchanged ack semantics:
  - `investigation/findings/sync-persistence-investigation-d1c72b2b0.md`
  - `investigation/findings/sync-persistence-investigation-d6ff76672.md`
  - `investigation/findings/sync-persistence-investigation-5221da51b.md`

This gives historical backing for "divergence is intentional" instead of presenting it as a one-run inference.

## 5) Quantify impact where possible (P1)

The doc states directionally that coalescing reduces traffic. Add simple derived metrics from current counts:

- push handling: `8 -> 6` (`25%` fewer push cycles)
- push_result sends: `8 -> 6` (`25%` fewer result messages)

Use explicit wording that this is from a single essential-canvas scenario, not a universal benchmark.

## 6) Add confidence and limits per major claim (P1)

For each action section, add:

- confidence (`high`/`medium`)
- what evidence would falsify the claim

Example:

- Claim: group+reparent split in `tldraw-3` is due to missing unsent-diff merge.
- Confidence: high.
- Falsifier: same action still splits after porting coalescing logic.

This prevents the report from reading as absolute when based on limited runs.

## 7) Call out unresolved deltas explicitly (P1)

Two rows in the generic span table deserve explicit follow-up:

- `tlsync.socket.client.send`: mixed `(none)` message kinds in `tldraw-3`
- connect count mismatch (`connect:1` vs `connect:2`)

Add a short "open questions" section with investigation tasks so these are tracked, not buried in a table.

## 8) Tighten wording from "necessary" to "intentional + tradeoff" (P2)

Several sections say divergence is "necessary". Prefer:

- "intentional for current architecture"
- "preferred tradeoff given durability/perf goals"

This is more precise and avoids overclaiming inevitability.

## 9) Add a concrete alignment plan and acceptance criteria (P2)

Convert "What Can Be Aligned" into a mini plan:

1. Add missing `tldraw.msg.type` attributes on `tldraw-3` client send/dispatch spans.
2. Standardize key names (`close_code`, byte/chunk attributes) across both repos.
3. Re-run the same essential test and verify:
   - no `(none)` `tldraw.msg.type` for the compared spans
   - behavioral deltas (push counts and group/reparent split/coalesce pattern) remain unchanged.

That makes the recommendation directly executable.
