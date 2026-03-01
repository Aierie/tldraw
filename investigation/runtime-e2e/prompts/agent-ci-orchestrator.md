# Agent prompt: CI across commits with durable context

Use this as the instruction block for an orchestration agent.

```md
Goal: run runtime CI checks across a commit list and produce durable, resumable artifacts.

Constraints:
- Do not rely on chat memory for progress.
- Use on-disk tracker files as the only source of truth.
- Continue from partial progress if rerun.
- Keep results per commit isolated.

Inputs:
- Commit list: investigation/runtime-e2e/scenarios/ci-commits.txt
- Pipeline profile: core|full|dotcom (default: core)
- Pipeline file: investigation/runtime-e2e/scenarios/ci-pipeline.tsv
- Derived rules file: investigation/runtime-e2e/scenarios/derived-assertion-rules.tsv
- Assertions file: investigation/runtime-e2e/scenarios/ci-assertions.tsv (optional static assertions)
- Findings assertions file: investigation/runtime-e2e/scenarios/findings-runtime-assertions.tsv (typed, commit-scoped hypotheses)
- Dotcom assertions file: investigation/runtime-e2e/scenarios/dotcom-runtime-assertions.tsv (optional)

Assertion policy:
- For each commit, derive commit-specific assertions from changed files (`commit^..commit`) using `derived-assertion-rules.tsv`.
- Write derived assertions to `commits/<sha>/assertions/<sha>.derived.tsv`.
- Write mapping rationale to `commits/<sha>/assertions/<sha>.md`.
- Run findings assertions using typed fields (`hypothesis_id`, `class`, `blocking`).
- Generate hypothesis-specific test scripts per commit into `commits/<sha>/generated-tests/tests/`.
- Run generated tests and capture structured outcomes in `generated-tests/run/test-results.tsv`.
- Produce `commits/<sha>/assertions/hypotheses.tsv` with hypothesis PASS/FAIL rollup.
- If changes are non-trivial and unmapped, add a conservative fallback core sweep assertion.

Execution plan:
1) Ensure Docker runtime image exists:
   docker compose -f investigation/runtime-e2e/docker/docker-compose.yml build
2) Run the commit orchestrator inside the runtime container:
   PROFILE=core \
   ASSERTIONS_FILE=investigation/runtime-e2e/scenarios/ci-assertions.tsv \
   FINDINGS_ASSERTIONS_FILE=investigation/runtime-e2e/scenarios/findings-runtime-assertions.tsv \
   DOTCOM_ASSERTIONS_FILE=investigation/runtime-e2e/scenarios/dotcom-runtime-assertions.tsv \
   PIPELINE_FILE=investigation/runtime-e2e/scenarios/ci-pipeline.tsv \
   DERIVED_RULES_FILE=investigation/runtime-e2e/scenarios/derived-assertion-rules.tsv \
   RESULT_ROOT=investigation/runtime-e2e/results/ci-$(date +%F_%H%M%S) \
   investigation/runtime-e2e/docker/run.sh \
   './investigation/runtime-e2e/scripts/run-ci-across-commits.sh --profile core investigation/runtime-e2e/scenarios/ci-commits.txt'
3) If interrupted, rerun with the same RESULT_ROOT so existing summary/state files are reused.

Output contract:
- run-manifest.json with run settings + script hash
- control/* snapshots of input files used during the run
- summary.tsv with one line per commit (PASS/FAIL + failure class)
- state.tsv with step-level attempts, cwd, and log paths
- commits/<sha>/logs/*.log with raw command output
- commits/<sha>/assertions/<sha>.derived.tsv with auto-derived assertions
- commits/<sha>/assertions/<sha>.md with derivation rationale
- commits/<sha>/assertions/assertions-results.tsv with assertion-level outcomes
- commits/<sha>/assertions/hypotheses.tsv with hypothesis-level rollup
- commits/<sha>/generated-tests/manifest.tsv with generated tests inventory
- commits/<sha>/generated-tests/tests/* generated test scripts
- commits/<sha>/generated-tests/run/test-results.tsv with generated-test outcomes
- commits/<sha>/generated-tests/run/logs/* generated-test logs

Review/report format:
- Total commits checked
- Passing commits
- Failing commits + first failed step
- Distinguish infra/setup failures from test regressions
```
