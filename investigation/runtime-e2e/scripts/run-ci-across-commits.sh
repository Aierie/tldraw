#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# CLI / env configuration
# -----------------------------
PROFILE="${PROFILE:-core}"                 # core | full | dotcom
RESUME="${RESUME:-1}"                      # 1=skip already-passed steps
USE_WORKTREES="${USE_WORKTREES:-1}"        # 1=per-commit worktree isolation
KEEP_WORKTREES="${KEEP_WORKTREES:-0}"      # 1=keep worktrees after each commit
RETRIES="${RETRIES:-1}"                    # retry count after first attempt
CONTINUE_ON_FAIL="${CONTINUE_ON_FAIL:-1}"  # 1=continue through all commits
GENERATED_TEST_RETAIN="${GENERATED_TEST_RETAIN:-all}" # all | pass-only
GENERATED_TEST_POLICY="${GENERATED_TEST_POLICY:-important-only}" # important-only | all
FORCE_GENERATED_TESTS="${FORCE_GENERATED_TESTS:-0}" # 1=generate regardless of policy/profile class gates
GENERATED_TEST_HYPOTHESIS_IDS="${GENERATED_TEST_HYPOTHESIS_IDS:-}" # csv allowlist (optional)
GENERATED_TEST_ASSERTION_IDS="${GENERATED_TEST_ASSERTION_IDS:-}" # csv allowlist (optional)
GENERATED_TEST_CLASS_ALLOWLIST="${GENERATED_TEST_CLASS_ALLOWLIST:-}" # csv allowlist (optional)
RUN_GENERATED_TESTS_ON_FAILURE="${RUN_GENERATED_TESTS_ON_FAILURE:-0}" # 1=continue to generated-test phases after first blocking failure
EXPECTED_OUTCOMES_FILE="${EXPECTED_OUTCOMES_FILE:-}" # optional expected hypothesis outcomes tsv

COMMITS_FILE="${COMMITS_FILE:-}"
RESULT_ROOT="${RESULT_ROOT:-}"

while [ "$#" -gt 0 ]; do
	case "$1" in
		--profile)
			PROFILE="$2"
			shift 2
			;;
		--result-root)
			RESULT_ROOT="$2"
			shift 2
			;;
		--resume)
			RESUME="$2"
			shift 2
			;;
		--use-worktrees)
			USE_WORKTREES="$2"
			shift 2
			;;
		--keep-worktrees)
			KEEP_WORKTREES="$2"
			shift 2
			;;
		--retries)
			RETRIES="$2"
			shift 2
			;;
		--continue-on-fail)
			CONTINUE_ON_FAIL="$2"
			shift 2
			;;
		--force-generated-tests)
			FORCE_GENERATED_TESTS="$2"
			shift 2
			;;
		--generated-test-hypothesis-ids)
			GENERATED_TEST_HYPOTHESIS_IDS="$2"
			shift 2
			;;
		--generated-test-assertion-ids)
			GENERATED_TEST_ASSERTION_IDS="$2"
			shift 2
			;;
		--generated-test-class-allowlist)
			GENERATED_TEST_CLASS_ALLOWLIST="$2"
			shift 2
			;;
		--run-generated-tests-on-failure)
			RUN_GENERATED_TESTS_ON_FAILURE="$2"
			shift 2
			;;
		--expected-outcomes-file)
			EXPECTED_OUTCOMES_FILE="$2"
			shift 2
			;;
		-*)
			echo "Unknown option: $1"
			exit 1
			;;
		*)
			if [ -z "${COMMITS_FILE:-}" ]; then
				COMMITS_FILE="$1"
			else
				echo "Unexpected positional arg: $1"
				exit 1
			fi
			shift
			;;
	esac
done

COMMITS_FILE="${COMMITS_FILE:-investigation/runtime-e2e/scenarios/ci-commits.txt}"
ASSERTIONS_FILE="${ASSERTIONS_FILE:-investigation/runtime-e2e/scenarios/ci-assertions.tsv}"
FINDINGS_ASSERTIONS_FILE="${FINDINGS_ASSERTIONS_FILE:-investigation/runtime-e2e/scenarios/findings-runtime-assertions.tsv}"
DOTCOM_ASSERTIONS_FILE="${DOTCOM_ASSERTIONS_FILE:-investigation/runtime-e2e/scenarios/dotcom-runtime-assertions.tsv}"
DERIVED_RULES_FILE="${DERIVED_RULES_FILE:-investigation/runtime-e2e/scenarios/derived-assertion-rules.tsv}"
PIPELINE_FILE="${PIPELINE_FILE:-investigation/runtime-e2e/scenarios/ci-pipeline.tsv}"
EXPECTED_OUTCOMES_FILE="${EXPECTED_OUTCOMES_FILE:-investigation/runtime-e2e/scenarios/expected-hypothesis-outcomes.tsv}"
RESULT_ROOT="${RESULT_ROOT:-investigation/runtime-e2e/results/ci-$(date +%F_%H%M%S)}"

ROOT_DIR="$(pwd)"

# -----------------------------
# Paths / artifacts
# -----------------------------
CONTROL_DIR="$RESULT_ROOT/control"
COMMITS_DIR="$RESULT_ROOT/commits"
WORKSPACES_DIR="$RESULT_ROOT/workspaces"
LOG_ROOT="$RESULT_ROOT/logs"
MANIFEST_JSON="$RESULT_ROOT/run-manifest.json"
STATE_TSV="$RESULT_ROOT/state.tsv"
SUMMARY_TSV="$RESULT_ROOT/summary.tsv"

mkdir -p "$CONTROL_DIR" "$COMMITS_DIR" "$WORKSPACES_DIR" "$LOG_ROOT"

if [ ! -f "$STATE_TSV" ]; then
	printf "timestamp\tcommit\tstep\tattempt\tstatus\texit_code\tcwd\tlog_file\n" >"$STATE_TSV"
fi

if [ ! -f "$SUMMARY_TSV" ]; then
	printf "commit\tstatus\tfailed_step\tfailure_class\tworkspace\n" >"$SUMMARY_TSV"
fi

# -----------------------------
# Guardrails
# -----------------------------
if [ ! -f "$COMMITS_FILE" ]; then
	echo "Commits file not found: $COMMITS_FILE"
	exit 1
fi

if [ ! -f "$PIPELINE_FILE" ]; then
	echo "Pipeline file not found: $PIPELINE_FILE"
	exit 1
fi

if [ ! -f "$DERIVED_RULES_FILE" ]; then
	echo "Derived rules file not found: $DERIVED_RULES_FILE"
	exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "Working tree has uncommitted changes. Commit/stash first, then rerun."
	exit 1
fi

ORIG_REF="$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)"
ACTIVE_WORKTREE=""

cleanup() {
	if [ "$USE_WORKTREES" != "1" ]; then
		git checkout -q "$ORIG_REF" || true
	else
		if [ -n "$ACTIVE_WORKTREE" ] && [ "$KEEP_WORKTREES" != "1" ]; then
			git worktree remove --force "$ACTIVE_WORKTREE" >/dev/null 2>&1 || true
		fi
	fi
}
trap cleanup EXIT

# -----------------------------
# Helpers
# -----------------------------
profile_allows() {
	local profile="$1"
	local allowlist="$2"
	[ -z "$allowlist" ] && return 0
	[ "$allowlist" = "all" ] && return 0
	printf '%s' "$allowlist" | tr ',' '\n' | grep -Fxq "$profile"
}

csv_contains() {
	local csv="$1"
	local value="$2"
	[ -z "$csv" ] && return 1
	printf '%s' "$csv" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -Fxq "$value"
}

class_allowed_for_profile() {
	local class="$1"
	case "$PROFILE" in
		core)
			[ "$class" = "DOTCOM" ] && return 1
			return 0
			;;
		full|dotcom)
			return 0
			;;
		*)
			return 0
			;;
	esac
}

has_summary_for_commit() {
	local commit="$1"
	awk -F'\t' -v c="$commit" 'NR>1 && $1==c {found=1} END {exit found ? 0 : 1}' "$SUMMARY_TSV"
}

step_already_passed() {
	local commit="$1"
	local step="$2"
	awk -F'\t' -v c="$commit" -v s="$step" 'NR>1 && $2==c && $3==s && $5=="PASS" {found=1} END {exit found ? 0 : 1}' "$STATE_TSV"
}

classify_failure() {
	local step="$1"
	case "$step" in
		yarn-install|prepare-workspace|checkout-commit)
			echo "infra/setup"
			;;
		*)
			echo "test/regression"
			;;
	esac
}

safe_copy_control_file() {
	local src="$1"
	local dst_name="$2"
	if [ -f "$src" ]; then
		cp "$src" "$CONTROL_DIR/$dst_name"
	fi
}

snapshot_control_inputs() {
	safe_copy_control_file "$COMMITS_FILE" "ci-commits.txt"
	safe_copy_control_file "$ASSERTIONS_FILE" "ci-assertions.tsv"
	safe_copy_control_file "$FINDINGS_ASSERTIONS_FILE" "findings-runtime-assertions.tsv"
	safe_copy_control_file "$DOTCOM_ASSERTIONS_FILE" "dotcom-runtime-assertions.tsv"
	safe_copy_control_file "$DERIVED_RULES_FILE" "derived-assertion-rules.tsv"
	safe_copy_control_file "$PIPELINE_FILE" "ci-pipeline.tsv"
	safe_copy_control_file "$EXPECTED_OUTCOMES_FILE" "expected-hypothesis-outcomes.tsv"

	local script_hash
	script_hash="$(shasum -a 256 "$0" | awk '{print $1}')"

	cat >"$MANIFEST_JSON" <<EOF
{
  "started_at": "$(date -Iseconds)",
  "profile": "${PROFILE}",
  "resume": "${RESUME}",
  "use_worktrees": "${USE_WORKTREES}",
  "keep_worktrees": "${KEEP_WORKTREES}",
  "retries": "${RETRIES}",
  "continue_on_fail": "${CONTINUE_ON_FAIL}",
  "generated_test_retain": "${GENERATED_TEST_RETAIN}",
  "generated_test_policy": "${GENERATED_TEST_POLICY}",
  "force_generated_tests": "${FORCE_GENERATED_TESTS}",
  "generated_test_hypothesis_ids": "${GENERATED_TEST_HYPOTHESIS_IDS}",
  "generated_test_assertion_ids": "${GENERATED_TEST_ASSERTION_IDS}",
  "generated_test_class_allowlist": "${GENERATED_TEST_CLASS_ALLOWLIST}",
  "run_generated_tests_on_failure": "${RUN_GENERATED_TESTS_ON_FAILURE}",
  "expected_outcomes_file": "${EXPECTED_OUTCOMES_FILE}",
  "script": "$0",
  "script_sha256": "${script_hash}",
  "root": "${ROOT_DIR}"
}
EOF
}

RUN_STEP_LAST_LOG=""
RUN_STEP_LAST_CODE=0

run_step() {
	local commit="$1"
	local step="$2"
	local cmd="$3"
	local cwd="$4"
	local log_base="$5"

	if [ "$RESUME" = "1" ] && step_already_passed "$commit" "$step"; then
		echo "[SKIP] [$commit][$step] already passed"
		printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
			"$(date -Iseconds)" "$commit" "$step" "0" "SKIP" "0" "$cwd" "-" >>"$STATE_TSV"
		RUN_STEP_LAST_LOG="-"
		RUN_STEP_LAST_CODE=0
		return 0
	fi

	local max_attempts=$((RETRIES + 1))
	local attempt=1
	local code=0
	local status="FAIL"
	local log_file=""

	while [ "$attempt" -le "$max_attempts" ]; do
		log_file="${log_base}.attempt${attempt}.log"
		echo "[$commit][$step] attempt $attempt/$max_attempts" >&2

		set +e
		(
			cd "$cwd"
			bash -lc "$cmd"
		) >"$log_file" 2>&1
		code=$?
		set -e

		if [ "$code" -eq 0 ]; then
			status="PASS"
		else
			status="FAIL"
		fi

		printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
			"$(date -Iseconds)" "$commit" "$step" "$attempt" "$status" "$code" "$cwd" "$log_file" >>"$STATE_TSV"

		RUN_STEP_LAST_LOG="$log_file"
		RUN_STEP_LAST_CODE="$code"

		if [ "$code" -eq 0 ]; then
			return 0
		fi

		attempt=$((attempt + 1))
	done

	return "$code"
}

prepare_commit_workspace() {
	local commit="$1"
	local short="$2"
	if [ "$USE_WORKTREES" = "1" ]; then
		local wt="$WORKSPACES_DIR/$short"
		if [ -d "$wt" ]; then
			git worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
		fi
		if git worktree add --detach "$wt" "$commit" >/dev/null 2>&1; then
			ACTIVE_WORKTREE="$wt"
			echo "$wt"
			return 0
		fi
		echo "[WARN] worktree setup failed for $commit; falling back to in-place detached checkout" >&2
	fi

	if ! git checkout -q --detach "$commit"; then
		return 1
	fi
	ACTIVE_WORKTREE=""
	echo "$ROOT_DIR"
}

get_changed_files() {
	local workspace="$1"
	local commit="$2"
	if git -C "$workspace" rev-parse -q --verify "$commit^" >/dev/null; then
		git -C "$workspace" diff --name-only "$commit^..$commit"
	else
		git -C "$workspace" ls-tree -r --name-only "$commit"
	fi
}

append_derived_assertion() {
	local file="$1"
	local assertion_id="$2"
	local command="$3"
	local reason="$4"
	local class="$5"

	if awk -F'\t' -v a="$assertion_id" -v c="$command" 'NR>1 && $1==a && $2==c {found=1} END {exit found ? 0 : 1}' "$file"; then
		return 0
	fi

	printf "%s\t%s\t%s\t%s\n" "$assertion_id" "$command" "$reason" "$class" >>"$file"
}

derive_assertions_for_commit() {
	local commit="$1"
	local short="$2"
	local workspace="$3"
	local commit_dir="$4"

	local assertions_tsv="$commit_dir/assertions/${short}.derived.tsv"
	local rationale_md="$commit_dir/assertions/${short}.md"
	local changed_list="$commit_dir/assertions/${short}.changed-files.txt"
	local rules_file="$CONTROL_DIR/derived-assertion-rules.tsv"

	printf "assertion_id\tcommand\treason\tclass\n" >"$assertions_tsv"
	printf "# Derived assertions for %s\n\n" "$commit" >"$rationale_md"
	printf "## Changed files\n\n" >>"$rationale_md"

	get_changed_files "$workspace" "$commit" >"$changed_list"
	if [ ! -s "$changed_list" ]; then
		echo "- (none)" >>"$rationale_md"
		echo "No changed files detected; no derived assertions." >>"$rationale_md"
		return 0
	fi

	sed 's/^/- /' "$changed_list" >>"$rationale_md"
	echo >>"$rationale_md"
	echo "## Rule mapping rationale" >>"$rationale_md"
	echo >>"$rationale_md"

	local mapped_any=0
	local non_trivial_unmapped=0

	while IFS= read -r path || [ -n "$path" ]; do
		[ -z "$path" ] && continue
		local matched=0

		while IFS=$'\t' read -r path_regex assertion_id command reason class profiles || [ -n "${path_regex}${assertion_id}${command}${reason}${class}${profiles}" ]; do
			[ -z "${path_regex// }" ] && continue
			[[ "$path_regex" =~ ^# ]] && continue
			[ -z "${assertion_id:-}" ] && continue
			[ -z "${command:-}" ] && continue
			class="${class:-CORE}"
			profiles="${profiles:-all}"

			if ! profile_allows "$PROFILE" "$profiles"; then
				continue
			fi
			if ! class_allowed_for_profile "$class"; then
				continue
			fi

			if [[ "$path" =~ $path_regex ]]; then
				append_derived_assertion "$assertions_tsv" "$assertion_id" "$command" "${reason:-matched $path_regex}" "$class"
				printf -- "- %s -> %s (%s)\n" "$path" "$assertion_id" "$path_regex" >>"$rationale_md"
				matched=1
				mapped_any=1
			fi
		done <"$rules_file"

		if [ "$matched" -eq 0 ]; then
			case "$path" in
				docs/*|templates/*|.github/*|*.md)
					printf -- "- %s -> docs/meta-only (no extra assertion)\n" "$path" >>"$rationale_md"
					;;
				*)
					non_trivial_unmapped=1
					printf -- "- %s -> unmapped\n" "$path" >>"$rationale_md"
					;;
			esac
		fi
	done <"$changed_list"

	if [ "$mapped_any" -eq 0 ] && [ "$non_trivial_unmapped" -eq 1 ]; then
		append_derived_assertion "$assertions_tsv" "fallback-core-sweep" "for p in packages/editor packages/tldraw packages/store packages/state packages/state-react packages/sync packages/sync-core packages/tlschema packages/validate packages/utils; do [ -d \"$p\" ] && (cd \"$p\" && yarn test-ci); done" "unmapped non-trivial change detected" "CORE"
		echo "- Added fallback-core-sweep due to unmapped non-trivial changes." >>"$rationale_md"
	fi

	if [ "$(wc -l <"$assertions_tsv")" -eq 1 ]; then
		echo >>"$rationale_md"
		echo "No additional derived assertions were required for this commit." >>"$rationale_md"
	fi
}

ensure_assertion_result_header() {
	local file="$1"
	if [ ! -f "$file" ]; then
		printf "commit\tsource\thypothesis_id\tassertion_id\tclass\tblocking\tstatus\texit_code\tlog_file\treason\n" >"$file"
	fi
}

append_assertion_result() {
	local file="$1"
	local commit="$2"
	local source="$3"
	local hypothesis_id="$4"
	local assertion_id="$5"
	local class="$6"
	local blocking="$7"
	local status="$8"
	local code="$9"
	local log_file="${10}"
	local reason="${11}"
	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$commit" "$source" "$hypothesis_id" "$assertion_id" "$class" "$blocking" "$status" "$code" "$log_file" "$reason" >>"$file"
}

run_one_assertion() {
	local commit="$1"
	local short="$2"
	local workspace="$3"
	local source="$4"
	local hypothesis_id="$5"
	local assertion_id="$6"
	local class="$7"
	local blocking="$8"
	local command="$9"
	local reason="${10}"
	local commit_dir="${11}"

	if ! class_allowed_for_profile "$class"; then
		return 0
	fi

	local step_name="assert-${source}-${assertion_id}"
	local safe_step
	safe_step="$(echo "$step_name" | tr ' /' '__' | tr -cd '[:alnum:]_.-')"
	local log_base="$commit_dir/logs/${short}.${safe_step}"

	if run_step "$commit" "$step_name" "$command" "$workspace" "$log_base"; then
		append_assertion_result "$commit_dir/assertions/assertions-results.tsv" "$commit" "$source" "$hypothesis_id" "$assertion_id" "$class" "$blocking" "PASS" "0" "$RUN_STEP_LAST_LOG" "$reason"
	else
		append_assertion_result "$commit_dir/assertions/assertions-results.tsv" "$commit" "$source" "$hypothesis_id" "$assertion_id" "$class" "$blocking" "FAIL" "$RUN_STEP_LAST_CODE" "$RUN_STEP_LAST_LOG" "$reason"
		return 1
	fi
}

run_derived_assertions() {
	local commit="$1" short="$2" workspace="$3" commit_dir="$4"
	local derived_file="$commit_dir/assertions/${short}.derived.tsv"
	[ -f "$derived_file" ] || return 0

	local assertion_id command reason class
	while IFS=$'\t' read -r assertion_id command reason class || [ -n "${assertion_id}${command}${reason}${class}" ]; do
		[ -z "${assertion_id// }" ] && continue
		[[ "$assertion_id" = "assertion_id" ]] && continue
		class="${class:-CORE}"
		run_one_assertion "$commit" "$short" "$workspace" "derived" "-" "$assertion_id" "$class" "1" "$command" "$reason" "$commit_dir" || return 1
	done <"$derived_file"
	return 0
}

run_static_assertions() {
	local commit="$1" short="$2" workspace="$3" commit_dir="$4"
	local file="$CONTROL_DIR/ci-assertions.tsv"
	[ -f "$file" ] || return 0

	local pattern name command
	while IFS=$'\t' read -r pattern name command || [ -n "${pattern}${name}${command}" ]; do
		[ -z "${pattern// }" ] && continue
		[[ "$pattern" =~ ^# ]] && continue
		[ -z "${command:-}" ] && continue
		if [ "$pattern" != "*" ] && [[ ! "$commit" =~ $pattern ]]; then
			continue
		fi
		run_one_assertion "$commit" "$short" "$workspace" "static" "-" "$name" "STATIC" "0" "$command" "static assertion" "$commit_dir" || return 1
	done <"$file"
	return 0
}

run_findings_assertions() {
	local commit="$1" short="$2" workspace="$3" commit_dir="$4"
	local file="$CONTROL_DIR/findings-runtime-assertions.tsv"
	[ -f "$file" ] || return 0

	local c1 c2 c3 c4 c5 c6 c7 c8
	while IFS=$'\t' read -r c1 c2 c3 c4 c5 c6 c7 c8 || [ -n "${c1}${c2}${c3}${c4}${c5}${c6}${c7}${c8}" ]; do
		[ -z "${c1// }" ] && continue
		[[ "$c1" =~ ^# ]] && continue

		local pattern hypothesis_id assertion_id class blocking command reason profiles
		pattern="$c1"

		# Legacy 3-column format fallback: pattern, assertion_id, command
		if [ -n "${c3:-}" ] && [ -z "${c6:-}" ]; then
			hypothesis_id="legacy-${c2}"
			assertion_id="$c2"
			class="BEHAVIOR"
			blocking="1"
			command="$c3"
			reason="legacy findings assertion"
			profiles="all"
		else
			hypothesis_id="$c2"
			assertion_id="$c3"
			class="${c4:-BEHAVIOR}"
			blocking="${c5:-1}"
			command="$c6"
			reason="${c7:-findings assertion}"
			profiles="${c8:-all}"
		fi

		[ -z "${command:-}" ] && continue
		if [ "$pattern" != "*" ] && [[ ! "$commit" =~ $pattern ]]; then
			continue
		fi
		if ! profile_allows "$PROFILE" "$profiles"; then
			continue
		fi

		run_one_assertion "$commit" "$short" "$workspace" "finding" "$hypothesis_id" "$assertion_id" "$class" "$blocking" "$command" "$reason" "$commit_dir" || return 1
	done <"$file"

	return 0
}

sanitize_id() {
	local raw="$1"
	echo "$raw" | tr ' /' '__' | tr -cd '[:alnum:]_.-'
}

ensure_generated_test_manifest_header() {
	local file="$1"
	if [ ! -f "$file" ]; then
		printf "hypothesis_id\ttest_id\tassertion_id\tclass\tblocking\ttest_path\trun_command\treason\tstatus\n" >"$file"
	fi
}

generate_hypothesis_tests_for_commit() {
	local commit="$1" short="$2" workspace="$3" commit_dir="$4"
	local file="$CONTROL_DIR/findings-runtime-assertions.tsv"
	[ -f "$file" ] || return 0

	local gen_root="$commit_dir/generated-tests"
	local tests_dir="$gen_root/tests"
	local prompts_dir="$gen_root/prompts"
	local retained_dir="$gen_root/retained"
	local discarded_dir="$gen_root/discarded"
	local patches_dir="$gen_root/patches"
	local run_logs_dir="$gen_root/run/logs"
	local manifest="$gen_root/manifest.tsv"
	local generated_prompt="$gen_root/generation-prompt.md"
	local selection_report="$gen_root/selection-report.tsv"

	mkdir -p "$tests_dir" "$prompts_dir" "$retained_dir" "$discarded_dir" "$patches_dir" "$run_logs_dir"
	ensure_generated_test_manifest_header "$manifest"
	printf "hypothesis_id\tassertion_id\tclass\tblocking\tdecision\treason\n" >"$selection_report"

	cat >"$generated_prompt" <<'EOF'
Generate commit-scoped hypothesis tests from findings assertions.
Each test should execute one hypothesis assertion command and report pass/fail deterministically.
Preserve hypothesis_id and assertion_id for rollup.
EOF

	local c1 c2 c3 c4 c5 c6 c7 c8
	while IFS=$'\t' read -r c1 c2 c3 c4 c5 c6 c7 c8 || [ -n "${c1}${c2}${c3}${c4}${c5}${c6}${c7}${c8}" ]; do
		[ -z "${c1// }" ] && continue
		[[ "$c1" =~ ^# ]] && continue

		local pattern hypothesis_id assertion_id class blocking command reason profiles
		pattern="$c1"

		# Legacy 3-column format fallback: pattern, assertion_id, command
		if [ -n "${c3:-}" ] && [ -z "${c6:-}" ]; then
			hypothesis_id="legacy-${c2}"
			assertion_id="$c2"
			class="BEHAVIOR"
			blocking="1"
			command="$c3"
			reason="legacy findings assertion"
			profiles="all"
		else
			hypothesis_id="$c2"
			assertion_id="$c3"
			class="${c4:-BEHAVIOR}"
			blocking="${c5:-1}"
			command="$c6"
			reason="${c7:-findings assertion}"
			profiles="${c8:-all}"
		fi

		local selection_decision="GENERATE"
		local selection_reason="selected"

		if [ -z "${command:-}" ]; then
			selection_decision="SKIP"
			selection_reason="empty-command"
		elif [ "$pattern" != "*" ] && [[ ! "$commit" =~ $pattern ]]; then
			selection_decision="SKIP"
			selection_reason="commit-pattern-mismatch"
		elif ! profile_allows "$PROFILE" "$profiles"; then
			selection_decision="SKIP"
			selection_reason="profile-filter"
		elif [ -n "$GENERATED_TEST_HYPOTHESIS_IDS" ] && ! csv_contains "$GENERATED_TEST_HYPOTHESIS_IDS" "$hypothesis_id"; then
			selection_decision="SKIP"
			selection_reason="hypothesis-id-filter"
		elif [ -n "$GENERATED_TEST_ASSERTION_IDS" ] && ! csv_contains "$GENERATED_TEST_ASSERTION_IDS" "$assertion_id"; then
			selection_decision="SKIP"
			selection_reason="assertion-id-filter"
		elif [ -n "$GENERATED_TEST_CLASS_ALLOWLIST" ] && ! csv_contains "$GENERATED_TEST_CLASS_ALLOWLIST" "$class"; then
			selection_decision="SKIP"
			selection_reason="class-allowlist-filter"
		elif [ "$FORCE_GENERATED_TESTS" != "1" ] && ! class_allowed_for_profile "$class"; then
			selection_decision="SKIP"
			selection_reason="profile-class-filter"
		elif [ "$FORCE_GENERATED_TESTS" != "1" ] && [ "$GENERATED_TEST_POLICY" = "important-only" ]; then
			# Only generate tests for high-importance hypotheses:
			# - blocking hypotheses
			# - behavior/regression classes
			if [ "$blocking" != "1" ]; then
				selection_decision="SKIP"
				selection_reason="policy-important-only-nonblocking"
			else
				case "$class" in
					BEHAVIOR|REGRESSION_GUARD)
						;;
					*)
						selection_decision="SKIP"
						selection_reason="policy-important-only-class-filter"
						;;
				esac
			fi
		fi

		if [ "$selection_decision" = "SKIP" ]; then
			printf "%s\t%s\t%s\t%s\t%s\t%s\n" \
				"$hypothesis_id" "$assertion_id" "$class" "$blocking" "$selection_decision" "$selection_reason" >>"$selection_report"
			continue
		fi

		local safe_id
		safe_id="$(sanitize_id "$assertion_id")"
		local test_id="hyp-${safe_id}"
		local test_path="$tests_dir/${test_id}.sh"
		local prompt_path="$prompts_dir/${test_id}.prompt.md"

		cat >"$prompt_path" <<EOF
# Generated hypothesis test

- commit: $commit
- hypothesis_id: $hypothesis_id
- assertion_id: $assertion_id
- class: $class
- blocking: $blocking
- reason: $reason

Command under test:

type: shell

action: run

\`\`\`bash
$command
\`\`\`
EOF

		cat >"$test_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail

# generated from findings assertion
# commit: $commit
# hypothesis_id: $hypothesis_id
# assertion_id: $assertion_id

bash -lc "\$(cat <<'__CMD__'
$command
__CMD__
)"
EOF
		chmod +x "$test_path"

		printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
			"$hypothesis_id" "$test_id" "$assertion_id" "$class" "$blocking" "$test_path" "bash $test_path" "$reason" "GENERATED" >>"$manifest"
		printf "%s\t%s\t%s\t%s\t%s\t%s\n" \
			"$hypothesis_id" "$assertion_id" "$class" "$blocking" "GENERATE" "selected" >>"$selection_report"
	done <"$file"

	return 0
}

run_generated_hypothesis_tests_for_commit() {
	local commit="$1" short="$2" workspace="$3" commit_dir="$4"
	local gen_root="$commit_dir/generated-tests"
	local manifest="$gen_root/manifest.tsv"
	local results_tsv="$gen_root/run/test-results.tsv"
	local run_logs_dir="$gen_root/run/logs"
	local retained_dir="$gen_root/retained"
	local discarded_dir="$gen_root/discarded"

	[ -f "$manifest" ] || return 0
	mkdir -p "$run_logs_dir" "$retained_dir" "$discarded_dir"
	printf "hypothesis_id\ttest_id\tassertion_id\tclass\tblocking\tstatus\texit_code\tlog_file\trun_command\n" >"$results_tsv"

	local hypothesis_id test_id assertion_id class blocking test_path run_command reason status
	while IFS=$'\t' read -r hypothesis_id test_id assertion_id class blocking test_path run_command reason status || [ -n "${hypothesis_id}${test_id}${assertion_id}${class}${blocking}${test_path}${run_command}${reason}${status}" ]; do
		[ -z "${hypothesis_id// }" ] && continue
		[[ "$hypothesis_id" = "hypothesis_id" ]] && continue
		[ -f "$test_path" ] || continue
		if ! class_allowed_for_profile "$class"; then
			continue
		fi

		local step_name="generated-test-${test_id}"
		local safe_step
		safe_step="$(sanitize_id "$step_name")"
		local log_base="$run_logs_dir/${short}.${safe_step}"

		local cmd="bash \"$test_path\""
		if run_step "$commit" "$step_name" "$cmd" "$workspace" "$log_base"; then
			printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$hypothesis_id" "$test_id" "$assertion_id" "$class" "$blocking" "PASS" "0" "$RUN_STEP_LAST_LOG" "$run_command" >>"$results_tsv"
			append_assertion_result "$commit_dir/assertions/assertions-results.tsv" "$commit" "generated-test" "$hypothesis_id" "$test_id" "$class" "$blocking" "PASS" "0" "$RUN_STEP_LAST_LOG" "$reason"
			cp "$test_path" "$retained_dir/" >/dev/null 2>&1 || true
		else
			printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$hypothesis_id" "$test_id" "$assertion_id" "$class" "$blocking" "FAIL" "$RUN_STEP_LAST_CODE" "$RUN_STEP_LAST_LOG" "$run_command" >>"$results_tsv"
			append_assertion_result "$commit_dir/assertions/assertions-results.tsv" "$commit" "generated-test" "$hypothesis_id" "$test_id" "$class" "$blocking" "FAIL" "$RUN_STEP_LAST_CODE" "$RUN_STEP_LAST_LOG" "$reason"
			cp "$test_path" "$discarded_dir/" >/dev/null 2>&1 || true
			if [ "$blocking" = "1" ]; then
				return 1
			fi
		fi
	done <"$manifest"

	if [ "$GENERATED_TEST_RETAIN" = "pass-only" ]; then
		find "$discarded_dir" -type f -name '*.sh' -delete >/dev/null 2>&1 || true
	fi

	return 0
}

evaluate_expected_outcomes_for_commit() {
	local commit="$1" short="$2" workspace="$3" commit_dir="$4"
	local file="$CONTROL_DIR/expected-hypothesis-outcomes.tsv"
	[ -f "$file" ] || return 0

	local hypotheses_file="$commit_dir/assertions/hypotheses.tsv"
	local out_file="$commit_dir/assertions/expected-outcomes-results.tsv"
	printf "pattern\thypothesis_id\texpected_status\tactual_status\tblocking_on_mismatch\tresult\treason\n" >"$out_file"

	local has_blocking_mismatch=0
	local c1 c2 c3 c4 c5 c6
	while IFS=$'\t' read -r c1 c2 c3 c4 c5 c6 || [ -n "${c1}${c2}${c3}${c4}${c5}${c6}" ]; do
		[ -z "${c1// }" ] && continue
		[[ "$c1" =~ ^# ]] && continue

		local pattern hypothesis_id expected_status blocking_on_mismatch reason profiles
		pattern="$c1"
		hypothesis_id="$c2"
		expected_status="${c3:-PASS}"
		blocking_on_mismatch="${c4:-1}"
		reason="${c5:-expected hypothesis status}"
		profiles="${c6:-all}"

		[ -z "${hypothesis_id:-}" ] && continue
		if [ "$pattern" != "*" ] && [[ ! "$commit" =~ $pattern ]]; then
			continue
		fi
		if ! profile_allows "$PROFILE" "$profiles"; then
			continue
		fi

		local expected_norm actual_status result
		expected_norm="$(printf '%s' "$expected_status" | tr '[:lower:]' '[:upper:]')"
		actual_status="$(awk -F'\t' -v h="$hypothesis_id" 'NR>1 && $1==h {print $2; found=1} END {if (!found) print "MISSING"}' "$hypotheses_file" 2>/dev/null || echo "MISSING")"

		if [ "$expected_norm" = "ANY" ] || [ "$expected_norm" = "*" ] || [ "$actual_status" = "$expected_norm" ]; then
			result="PASS"
		else
			result="FAIL"
			if [ "$blocking_on_mismatch" = "1" ]; then
				has_blocking_mismatch=1
			fi
		fi

		printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
			"$pattern" "$hypothesis_id" "$expected_norm" "$actual_status" "$blocking_on_mismatch" "$result" "$reason" >>"$out_file"
	done <"$file"

	if [ "$has_blocking_mismatch" = "1" ]; then
		return 1
	fi
	return 0
}

run_dotcom_assertions() {
	local commit="$1" short="$2" workspace="$3" commit_dir="$4"
	local file="$CONTROL_DIR/dotcom-runtime-assertions.tsv"
	[ -f "$file" ] || return 0

	local pattern name command
	while IFS=$'\t' read -r pattern name command || [ -n "${pattern}${name}${command}" ]; do
		[ -z "${pattern// }" ] && continue
		[[ "$pattern" =~ ^# ]] && continue
		[ -z "${command:-}" ] && continue
		if [ "$pattern" != "*" ] && [[ ! "$commit" =~ $pattern ]]; then
			continue
		fi
		run_one_assertion "$commit" "$short" "$workspace" "dotcom" "dotcom-${name}" "$name" "DOTCOM" "0" "$command" "dotcom assertion" "$commit_dir" || return 1
	done <"$file"
	return 0
}

rollup_hypotheses() {
	local commit_dir="$1"
	local in_file="$commit_dir/assertions/assertions-results.tsv"
	local out_file="$commit_dir/assertions/hypotheses.tsv"
	printf "hypothesis_id\tstatus\tblocking_failures\tblocking_total\n" >"$out_file"

	[ -f "$in_file" ] || return 0

	awk -F'\t' '
	NR==1 {next}
	$3 == "-" || $3 == "" {next}
	{
		h=$3
		if ($6 == "1") {
			blocking_total[h]++
			if ($7 != "PASS") blocking_fail[h]++
		}
	}
	END {
		for (h in blocking_total) {
			if (blocking_fail[h] > 0) {
				status="FAIL"
			} else {
				status="PASS"
			}
			printf "%s\t%s\t%d\t%d\n", h, status, blocking_fail[h]+0, blocking_total[h]+0
		}
	}' "$in_file" >>"$out_file"
}

RUN_PIPELINE_STATUS=""
RUN_PIPELINE_FAILED_STEP=""
RUN_PIPELINE_FAILED_CLASS=""

run_pipeline_for_commit() {
	local commit="$1" short="$2" workspace="$3" commit_dir="$4"
	local pipeline="$CONTROL_DIR/ci-pipeline.tsv"

	local failed_step=""
	local failed_class=""
	local post_failure_generated_only="0"

	while IFS=$'\t' read -r step_id profiles enabled blocking description || [ -n "${step_id}${profiles}${enabled}${blocking}${description}" ]; do
		[ -z "${step_id// }" ] && continue
		[[ "$step_id" =~ ^# ]] && continue
		[ "${enabled:-1}" != "1" ] && continue
		profile_allows "$PROFILE" "${profiles:-all}" || continue
		if [ "$post_failure_generated_only" = "1" ]; then
			case "$step_id" in
				generate-hypothesis-tests|run-generated-hypothesis-tests)
					;;
				*)
					continue
					;;
			esac
		fi

		case "$step_id" in
			yarn-install)
				run_step "$commit" "yarn-install" "yarn install --immutable" "$workspace" "$commit_dir/logs/${short}.yarn-install" || {
					if [ -z "$failed_step" ]; then
						failed_step="yarn-install"
						failed_class="$(classify_failure "$failed_step")"
					fi
				}
				;;
			yarn-test-ci)
				run_step "$commit" "yarn-test-ci" "yarn test-ci" "$workspace" "$commit_dir/logs/${short}.yarn-test-ci" || {
					if [ -z "$failed_step" ]; then
						failed_step="yarn-test-ci"
						failed_class="$(classify_failure "$failed_step")"
					fi
				}
				;;
			derived-assertions)
				derive_assertions_for_commit "$commit" "$short" "$workspace" "$commit_dir"
				run_derived_assertions "$commit" "$short" "$workspace" "$commit_dir" || {
					if [ -z "$failed_step" ]; then
						failed_step="derived-assertions"
						failed_class="$(classify_failure "$failed_step")"
					fi
				}
				;;
			findings-assertions)
				run_findings_assertions "$commit" "$short" "$workspace" "$commit_dir" || {
					if [ -z "$failed_step" ]; then
						failed_step="findings-assertions"
						failed_class="$(classify_failure "$failed_step")"
					fi
				}
				;;
			generate-hypothesis-tests)
				generate_hypothesis_tests_for_commit "$commit" "$short" "$workspace" "$commit_dir" || {
					if [ -z "$failed_step" ]; then
						failed_step="generate-hypothesis-tests"
						failed_class="$(classify_failure "$failed_step")"
					fi
				}
				;;
			run-generated-hypothesis-tests)
				run_generated_hypothesis_tests_for_commit "$commit" "$short" "$workspace" "$commit_dir" || {
					if [ -z "$failed_step" ]; then
						failed_step="run-generated-hypothesis-tests"
						failed_class="$(classify_failure "$failed_step")"
					fi
				}
				;;
			static-assertions)
				run_static_assertions "$commit" "$short" "$workspace" "$commit_dir" || {
					if [ -z "$failed_step" ]; then
						failed_step="static-assertions"
						failed_class="$(classify_failure "$failed_step")"
					fi
				}
				;;
			dotcom-assertions)
				run_dotcom_assertions "$commit" "$short" "$workspace" "$commit_dir" || {
					if [ -z "$failed_step" ]; then
						failed_step="dotcom-assertions"
						failed_class="$(classify_failure "$failed_step")"
					fi
				}
				;;
			*)
				echo "[WARN] Unknown pipeline step id: $step_id"
				;;
		esac

		if [ -n "$failed_step" ] && [ "${blocking:-1}" = "1" ]; then
			if [ "$RUN_GENERATED_TESTS_ON_FAILURE" = "1" ]; then
				post_failure_generated_only="1"
			else
				break
			fi
		fi
	done <"$pipeline"

	rollup_hypotheses "$commit_dir"
	if ! evaluate_expected_outcomes_for_commit "$commit" "$short" "$workspace" "$commit_dir"; then
		if [ -z "$failed_step" ]; then
			failed_step="expected-hypothesis-outcomes"
			failed_class="$(classify_failure "$failed_step")"
		fi
	fi

	if [ -z "$failed_step" ]; then
		RUN_PIPELINE_STATUS="PASS"
		RUN_PIPELINE_FAILED_STEP="-"
		RUN_PIPELINE_FAILED_CLASS="-"
	else
		RUN_PIPELINE_STATUS="FAIL"
		RUN_PIPELINE_FAILED_STEP="$failed_step"
		RUN_PIPELINE_FAILED_CLASS="$failed_class"
	fi
}

# -----------------------------
# Bootstrap
# -----------------------------
snapshot_control_inputs

echo "Using commits from: $COMMITS_FILE"
echo "Profile: $PROFILE"
echo "Writing results to: $RESULT_ROOT"
echo

mapfile -t COMMITS < <(grep -vE '^\s*#' "$COMMITS_FILE" | sed '/^\s*$/d')
if [ "${#COMMITS[@]}" -eq 0 ]; then
	echo "No commits found in $COMMITS_FILE"
	exit 1
fi

# -----------------------------
# Main loop
# -----------------------------
for commit in "${COMMITS[@]}"; do
	if has_summary_for_commit "$commit"; then
		echo "[SKIP] $commit already has summary entry"
		continue
	fi

	short="${commit:0:12}"
	commit_dir="$COMMITS_DIR/$short"
	mkdir -p "$commit_dir/logs" "$commit_dir/assertions"
	ensure_assertion_result_header "$commit_dir/assertions/assertions-results.tsv"

	echo
	echo "=== Commit: $commit ==="

	if ! workspace="$(prepare_commit_workspace "$commit" "$short")"; then
		echo "[FAIL] failed to prepare workspace for $commit"
		printf "%s\t%s\t%s\t%s\t%s\n" "$commit" "FAIL" "prepare-workspace" "infra/setup" "-" >>"$SUMMARY_TSV"
		if [ "$CONTINUE_ON_FAIL" != "1" ]; then
			exit 1
		fi
		continue
	fi
	if [ ! -d "$workspace" ]; then
		echo "[FAIL] workspace path missing for $commit: $workspace"
		printf "%s\t%s\t%s\t%s\t%s\n" "$commit" "FAIL" "prepare-workspace" "infra/setup" "-" >>"$SUMMARY_TSV"
		if [ "$CONTINUE_ON_FAIL" != "1" ]; then
			exit 1
		fi
		continue
	fi

	run_pipeline_for_commit "$commit" "$short" "$workspace" "$commit_dir"
	status="$RUN_PIPELINE_STATUS"
	failed_step="$RUN_PIPELINE_FAILED_STEP"
	failure_class="$RUN_PIPELINE_FAILED_CLASS"

	printf "%s\t%s\t%s\t%s\t%s\n" "$commit" "$status" "$failed_step" "$failure_class" "$workspace" >>"$SUMMARY_TSV"
	echo "[$status] $commit (failed_step=$failed_step, failure_class=$failure_class)"

	if [ "$USE_WORKTREES" = "1" ] && [ "$KEEP_WORKTREES" != "1" ]; then
		git worktree remove --force "$workspace" >/dev/null 2>&1 || true
		ACTIVE_WORKTREE=""
	fi

	if [ "$status" = "FAIL" ] && [ "$CONTINUE_ON_FAIL" != "1" ]; then
		echo "Stopping on first blocking failure (CONTINUE_ON_FAIL=$CONTINUE_ON_FAIL)."
		exit 1
	fi
done

echo
echo "Done."
echo "Summary: $SUMMARY_TSV"
echo "State:   $STATE_TSV"
