# OTel Trace Comparison Session Log (2026-03-01)

## Goal

Compare `internal/observability/otel/data/traces.jsonl` in `tldraw-3` vs `../tldraw`, map spans to canvas actions, explain differences, instrument gaps, regenerate traces, and minimize non-essential divergence.

## Repos and Files

- `tldraw-3`:
  - `internal/observability/otel/data/traces.jsonl`
  - `apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts`
- `tldraw`:
  - `../tldraw/internal/observability/otel/data/traces.jsonl`
  - `../tldraw/apps/dotcom/sync-worker/e2e/tests/simple-sync-worker.spec.ts`

## Major Requests Covered

1. Initial trace comparison, ignoring ping/pong.
2. Improve analysis with e2e test context and map spans to canvas actions.
3. Focus on canvas-op messages and identify useful instrumentation additions.
4. Implement instrumentation suggestions and regenerate traces.
5. Re-analyze with emphasis on maximal similarity.
6. Verify whether tests are the same and whether traces are cleared before test start.
7. Re-run only essential test flow.
8. Confirm SQLite instrumentation in `tldraw` traces.
9. Backtrace SQLite spans to comparable behavior points.
10. Explain the 242 SQLite spans not related to canvas actions.
11. Produce deep divergence document with code-path rationale.

## Key Execution and Validation

- Essential-only rerun command (both repos):
  - `corepack yarn playwright test -c ./e2e/playwright.config.ts ./e2e/tests/simple-sync-worker.spec.ts -g "essential canvas ops write to OTel traces"`
- Result:
  - both repos: `1 passed` for the essential test.
- Trace reset in tests:
  - test calls `clearOtelTraces()` before essential scenario starts.

## Answers Established During Session

- Functional test intent: same canvas scenarios and assertions.
- Setup differs:
  - `tldraw`: simple worker uses SQLite-backed room storage.
  - `tldraw-3`: simple worker path is in-memory snapshot style.
- SQLite instrumentation in `tldraw`: present and extensive.

## Important Trace Findings

### Canvas-action path

- `tldraw-3`: 8 `tlsync.room.push` spans.
- `tldraw`: 6 `tlsync.room.push` spans.
- Canonical semantic mapping:
  - create/update/delete operations align.
  - main divergence is `group + reparent`:
    - `tldraw-3`: split into two pushes.
    - `tldraw`: coalesced into one push.

### SQLite spans (essential-only `tldraw` run)

- Total SQLite spans: `338`.
- Backtrace classification:
  - via `tlsync.room.push`: `87` (canvas action path)
  - via `tlsync.room.connect`: `9`
  - detached from room push/connect ancestry: `242`

### The 242 detached SQLite spans

- Accounted for as non-canvas work:
  - repeated `__test__/snapshot` polling (`waitForSnapshot`) and associated snapshot reads.
  - startup/reset/bootstrap DB operations.
- Why detached:
  - test helper routes intentionally bypass top-level worker/do fetch tracing for those endpoints, so SQLite spans appear as standalone roots.

## Documents Produced

- Deep divergence analysis:
  - `internal/observability/otel/canvas-divergence-deep-analysis.md`
  - Contains per-action divergence points, message-kind comparison on generic spans, and rationale for necessary divergences.

## Final State

- Essential traces regenerated and re-analyzed.
- Canvas-action differences explained and attributed.
- Detached SQLite spans explained.
- Deep code-path divergence document added.
