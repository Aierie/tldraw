# Runtime / E2E Docker runner

This setup is for runtime/e2e verification (not static git-claim checks).

## What it gives you
- Linux Playwright environment with browsers already available in the base image
- Node (from Playwright base image; currently v22.x) + Yarn (version auto-matched from `package.json#packageManager`)
- Docker CLI + mounted Docker socket (so dotcom zero-cache scripts that call `docker compose` can run)
- PostgreSQL client tools for runtime troubleshooting
- Sequential queue runner for stable execution on 8GB RAM VMs

## Files
- `investigation/runtime-e2e/docker/Dockerfile`
- `investigation/runtime-e2e/docker/entrypoint.sh`
- `investigation/runtime-e2e/docker/docker-compose.yml`
- `investigation/runtime-e2e/docker/run.sh`
- `investigation/runtime-e2e/scripts/run-runtime-queue.sh`
- `investigation/runtime-e2e/scripts/run-ci-across-commits.sh`
- `investigation/runtime-e2e/scripts/prepare-dotcom-env.sh`
- `investigation/runtime-e2e/scenarios/runtime-queue.txt`
- `investigation/runtime-e2e/scenarios/ci-commits.example.txt`
- `investigation/runtime-e2e/scenarios/ci-assertions.example.tsv`
- `investigation/runtime-e2e/scenarios/ci-pipeline.tsv`
- `investigation/runtime-e2e/scenarios/derived-assertion-rules.tsv`
- `investigation/runtime-e2e/scenarios/findings-runtime-assertions.tsv`
- `investigation/runtime-e2e/scenarios/dotcom-runtime-assertions.tsv`
- `investigation/runtime-e2e/prompts/agent-ci-orchestrator.md`

## Deep-dive dependency findings (for tldraw runtime/e2e)

From repo/workflow inspection:

- **Package manager:** Yarn across investigated refs (`1e9ed3513` → `266d21c41`), with Yarn 4.7.x or 4.12.x.
- **Node requirement:** repo engines specify `^20`; CI setup currently uses Node 22.16.x.
- **Playwright:** examples and dotcom e2e both use `@playwright/test` and install browsers in CI.
- **Dotcom e2e extras:** relies on Clerk env vars and local Postgres/pgbouncer services (through dotcom zero-cache tooling).

## Quick start

From repo root:

```bash
docker compose -f investigation/runtime-e2e/docker/docker-compose.yml build
```

Run queue in container:

```bash
chmod +x investigation/runtime-e2e/docker/run.sh investigation/runtime-e2e/scripts/*.sh
investigation/runtime-e2e/docker/run.sh "./investigation/runtime-e2e/scripts/run-runtime-queue.sh"
```

Results are written to:

- `investigation/runtime-e2e/results/<timestamp>/summary.tsv`
- per-step logs in the same directory

## Customize scenarios

Edit:

- `investigation/runtime-e2e/scenarios/runtime-queue.txt`

Format: one shell command per line; `#` for comments.

## Yarn compatibility across tldraw versions

For the investigation checkpoints we care about (`1e9ed3513` through `266d21c41`), tldraw uses Yarn (`packageManager` is Yarn 4.7.x or 4.12.x). Older history also uses Yarn (v3 / v1). The container entrypoint activates whatever Yarn version is declared by the checked-out commit.

## Commit-matrix CI (agent-friendly)

Use this when you want durable, resumable checks across many commits.

Key behavior:
- step-level resume (`RESUME=1` skips previously passed steps)
- per-commit isolation via git worktrees (`USE_WORKTREES=1`, with detached-checkout fallback)
- control-file snapshot at run start (`results/.../control/*`)
- profile-driven pipeline (`PROFILE=core|full|dotcom`, default `core`)
- generated hypothesis-test phase (`generate-hypothesis-tests` + `run-generated-hypothesis-tests`)
- generated-test policy defaults to high-importance hypotheses only (`GENERATED_TEST_POLICY=important-only`)

1) Create your commit list from the example:

```bash
cp investigation/runtime-e2e/scenarios/ci-commits.example.txt investigation/runtime-e2e/scenarios/ci-commits.txt
```

2) (Optional) Create commit-specific assertions:

```bash
cp investigation/runtime-e2e/scenarios/ci-assertions.example.tsv investigation/runtime-e2e/scenarios/ci-assertions.tsv
```

3) Run inside container:

```bash
PROFILE=core \
ASSERTIONS_FILE=investigation/runtime-e2e/scenarios/ci-assertions.tsv \
FINDINGS_ASSERTIONS_FILE=investigation/runtime-e2e/scenarios/findings-runtime-assertions.tsv \
DOTCOM_ASSERTIONS_FILE=investigation/runtime-e2e/scenarios/dotcom-runtime-assertions.tsv \
PIPELINE_FILE=investigation/runtime-e2e/scenarios/ci-pipeline.tsv \
DERIVED_RULES_FILE=investigation/runtime-e2e/scenarios/derived-assertion-rules.tsv \
EXPECTED_OUTCOMES_FILE=investigation/runtime-e2e/scenarios/expected-hypothesis-outcomes.tsv \
FORCE_GENERATED_TESTS=1 \
GENERATED_TEST_POLICY=all \
RUN_GENERATED_TESTS_ON_FAILURE=1 \
RESULT_ROOT=investigation/runtime-e2e/results/ci-$(date +%F_%H%M%S) \
investigation/runtime-e2e/docker/run.sh \
"./investigation/runtime-e2e/scripts/run-ci-across-commits.sh --profile core investigation/runtime-e2e/scenarios/ci-commits.txt"
```

Artifacts:

- `run-manifest.json` (run settings + script hash)
- `control/*` (snapshotted inputs used for this run)
- `summary.tsv` (one row per commit + failure class)
- `state.tsv` (step/attempt-level log with cwd/log path)
- `commits/<sha>/logs/*.log` (per-commit raw output)
- `commits/<sha>/assertions/<sha>.derived.tsv` (auto-derived per-commit assertions)
- `commits/<sha>/assertions/<sha>.md` (per-commit derivation rationale)
- `commits/<sha>/assertions/assertions-results.tsv` (assertion-level outcomes)
- `commits/<sha>/assertions/hypotheses.tsv` (hypothesis-level PASS/FAIL rollup)
- `commits/<sha>/assertions/expected-outcomes-results.tsv` (expected vs actual hypothesis outcomes)
- `commits/<sha>/generated-tests/manifest.tsv` (generated tests catalog)
- `commits/<sha>/generated-tests/selection-report.tsv` (why a finding was generated vs skipped)
- `commits/<sha>/generated-tests/prompts/*` (generation prompts)
- `commits/<sha>/generated-tests/tests/*` (generated test scripts)
- `commits/<sha>/generated-tests/run/test-results.tsv` (generated-test execution results)
- `commits/<sha>/generated-tests/run/logs/*` (generated-test logs)
- `commits/<sha>/generated-tests/retained/*` and `.../discarded/*` (retention buckets)

To resume, rerun with the same `RESULT_ROOT`.

## Dotcom e2e notes

If you enable dotcom e2e queue entries, set these env vars when running container commands:

- `VITE_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`

Then run:

```bash
./investigation/runtime-e2e/scripts/prepare-dotcom-env.sh
```

## Recommended practice for 8GB VM
- Keep `--workers=1` for Playwright unless you benchmark otherwise.
- Run scenarios sequentially via queue runner.
- Add heavyweight suites gradually.
