#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
	echo "jq is required" >&2
	exit 1
fi

if [[ "$#" -eq 0 ]]; then
	set -- "internal/observability/otel/data/traces.jsonl"
fi

count_lines() {
	local query="$1"
	local file="$2"
	jq -r "$query" "$file" 2>/dev/null | wc -l | tr -d ' '
}

sum_int_attr() {
	local span_name="$1"
	local attr_key="$2"
	local file="$3"
	jq -r \
		".resourceSpans[].scopeSpans[].spans[] | select(.name==\"$span_name\") | (.attributes // []) | map(select(.key==\"$attr_key\") | .value.intValue)[]?" \
		"$file" 2>/dev/null | awk '{s+=$1} END {print s+0}'
}

distribution_for_attr() {
	local span_name="$1"
	local attr_key="$2"
	local file="$3"
	local out
	out=$(
		jq -r \
			".resourceSpans[].scopeSpans[].spans[] | select(.name==\"$span_name\") | (.attributes // []) | map(select(.key==\"$attr_key\") | .value.stringValue)[]?" \
			"$file" 2>/dev/null | sort | uniq -c | awk '{printf "%s:%s ", $2, $1}'
	)
	if [[ -z "$out" ]]; then
		echo "none"
	else
		echo "$out"
	fi
}

for file in "$@"; do
	if [[ ! -f "$file" ]]; then
		echo "file=$file status=missing"
		continue
	fi

	rebase_spans=$(count_lines '.resourceSpans[].scopeSpans[].spans[] | select(.name=="tlsync.client.rebase") | 1' "$file")
	rebase_errors=$(count_lines '.resourceSpans[].scopeSpans[].spans[] | select(.name=="tlsync.client.rebase") | (.attributes // []) | map(select(.key=="tldraw.client.rebase.error.message") | .value.stringValue)[]?' "$file")
	camera_signatures=$(count_lines '.resourceSpans[].scopeSpans[].spans[] | select(.name=="tlsync.client.rebase") | (.attributes // []) | map(select(.key=="tldraw.client.rebase.error.message") | .value.stringValue)[]? | select(test("reading .z.|this.getCamera\\(\\.\\.\\.\\).*undefined|Missing camera record for current page"))' "$file")
	reset_rebase_error=$(count_lines '.resourceSpans[].scopeSpans[].spans[] | select(.name=="tlsync.client.reset_connection") | (.attributes // []) | map(select(.key=="tldraw.client.reset.reason") | .value.stringValue)[]? | select(.=="rebase_error")' "$file")

	push_actions=$(distribution_for_attr "tlsync.room.push_outcome" "tldraw.push_result.action" "$file")
	hydration_types=$(distribution_for_attr "tlsync.client.did_reconnect" "tldraw.client.hydration_type" "$file")
	reset_reasons=$(distribution_for_attr "tlsync.client.reset_connection" "tldraw.client.reset.reason" "$file")

	push_result_commit=$(sum_int_attr "tlsync.client.rebase" "tldraw.client.rebase.push_result.commit" "$file")
	push_result_discard=$(sum_int_attr "tlsync.client.rebase" "tldraw.client.rebase.push_result.discard" "$file")
	push_result_rebase=$(sum_int_attr "tlsync.client.rebase" "tldraw.client.rebase.push_result.rebase" "$file")

	echo "file=$file"
	echo "  rebase_spans=$rebase_spans"
	echo "  rebase_error_messages=$rebase_errors"
	echo "  camera_null_signatures=$camera_signatures"
	echo "  reset_reason_rebase_error=$reset_rebase_error"
	echo "  push_outcome_actions=$push_actions"
	echo "  hydration_types=$hydration_types"
	echo "  reset_reasons=$reset_reasons"
	echo "  client_rebase_push_result_commit=$push_result_commit"
	echo "  client_rebase_push_result_discard=$push_result_discard"
	echo "  client_rebase_push_result_rebase=$push_result_rebase"
done
