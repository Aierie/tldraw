#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-static}" # static | migrations | all
DATE_STAMP="${DATE_STAMP:-$(date +%F)}"
RESULT_DIR="investigation/claims/results/${DATE_STAMP}"
TEST_FILE="$RESULT_DIR/test-results.tsv"
SCORECARD_FILE="$RESULT_DIR/scorecard.md"

mkdir -p "$RESULT_DIR"
: > "$TEST_FILE"

record_test() {
  local id="$1"
  local status="$2"
  local detail="$3"
  printf "%s\t%s\t%s\n" "$id" "$status" "$detail" >> "$TEST_FILE"
  printf "[%s] %s - %s\n" "$status" "$id" "$detail"
}

pass() { record_test "$1" "PASS" "$2"; }
fail() { record_test "$1" "FAIL" "$2"; }

run_static_tests() {
  # T-STATIC-001
  local names
  names="$(git show --name-only --pretty='' d039f3a1a -- packages/sync-core/src/lib/TLSyncRoom.ts packages/sync-core/src/lib/TLSyncStorage.ts)"
  local room_src
  room_src="$(git show d039f3a1a:packages/sync-core/src/lib/TLSyncRoom.ts || true)"
  if echo "$names" | grep -q 'packages/sync-core/src/lib/TLSyncRoom.ts' \
    && echo "$names" | grep -q 'packages/sync-core/src/lib/TLSyncStorage.ts' \
    && echo "$room_src" | grep -q 'storage.transaction'; then
    pass "T-STATIC-001" "d039 introduces storage abstraction wiring"
  else
    fail "T-STATIC-001" "expected files/symbols not found"
  fi

  # T-STATIC-002
  local names967
  names967="$(git show --name-only --pretty='' 967d3af52 -- packages/sync-core/src/lib/)"
  if echo "$names967" | grep -q 'packages/sync-core/src/lib/SqlLiteSyncStorage.ts' \
    && echo "$names967" | grep -q 'packages/sync-core/src/lib/DurableObjectSqliteSyncWrapper.ts' \
    && echo "$names967" | grep -q 'packages/sync-core/src/lib/NodeSqliteWrapper.ts'; then
    pass "T-STATIC-002" "967 introduces SQLite backend + wrappers"
  else
    fail "T-STATIC-002" "missing expected SQLite files"
  fi

  # T-STATIC-003
  local names5221
  names5221="$(git show --name-only --pretty='' 5221da51b)"
  if echo "$names5221" | grep -q 'packages/store/src/lib/StoreSchema.ts' \
    && echo "$names5221" | grep -q 'packages/tlschema/src/shapes/TLArrowShape.ts' \
    && echo "$names5221" | grep -q 'packages/sync-core/src/test/SQLiteSyncStorage.test.ts' \
    && echo "$names5221" | grep -q 'packages/sync-core/src/test/InMemorySyncStorage.test.ts' \
    && ! echo "$names5221" | grep -q 'packages/sync-core/src/lib/TLSyncRoom.ts' \
    && ! echo "$names5221" | grep -q 'packages/sync-core/src/lib/TLSocketRoom.ts'; then
    pass "T-STATIC-003" "5221 scoped to migration engine/shape/tests"
  else
    fail "T-STATIC-003" "unexpected/missing files in 5221"
  fi

  # T-STATIC-004
  local names95
  names95="$(git show --name-only --pretty='' 95b18b7c3)"
  local count95
  count95="$(echo "$names95" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$count95" = "1" ] && echo "$names95" | grep -q '^templates/sync-cloudflare/wrangler.toml$'; then
    pass "T-STATIC-004" "95 only changes wrangler.toml"
  else
    fail "T-STATIC-004" "95 changed unexpected files"
  fi

  # T-MIG-001
  local migsrc
  migsrc="$(git show d039f3a1a:packages/store/src/lib/migrate.ts || true)"
  if echo "$migsrc" | grep -q "scope: 'storage'" \
    && (echo "$migsrc" | grep -q 'SynchronousRecordStorage<UnknownRecord>' \
      || echo "$migsrc" | grep -q 'Abstraction over the storage'); then
    pass "T-MIG-001" "storage migration scope/types present"
  else
    fail "T-MIG-001" "storage migration scope/types missing"
  fi

  # T-MIG-002
  local sqlsrc
  sqlsrc="$(git show d1c72b2b0:packages/sync-core/src/lib/SQLiteSyncStorage.ts || true)"
  if echo "$sqlsrc" | grep -q 'migrationVersion' \
    && echo "$sqlsrc" | grep -q 'CAST(state AS BLOB)' \
    && echo "$sqlsrc" | grep -q 'state BLOB'; then
    pass "T-MIG-002" "TEXT->BLOB migration markers present"
  else
    fail "T-MIG-002" "missing TEXT->BLOB migration markers"
  fi

  # T-BOOT-001
  local tlfile967
  tlfile967="$(git show 967d3af52:apps/dotcom/sync-worker/src/TLFileDurableObject.ts || true)"
  if echo "$tlfile967" | grep -q 'sqlite_file_storage' \
    && (echo "$tlfile967" | grep -q 'SqlLiteSyncStorage' || echo "$tlfile967" | grep -q 'SQLiteSyncStorage'); then
    pass "T-BOOT-001" "feature-flagged sqlite boot path present"
  else
    fail "T-BOOT-001" "sqlite flag path not found"
  fi

  # T-BOOT-002
  local tlfiled6
  tlfiled6="$(git show d6ff76672:apps/dotcom/sync-worker/src/TLFileDurableObject.ts || true)"
  if echo "$tlfiled6" | grep -q 'try' \
    && echo "$tlfiled6" | grep -q 'catch' \
    && echo "$tlfiled6" | grep -q 'ROOM_NOT_FOUND' \
    && echo "$tlfiled6" | grep -q 'super.loadStorage'; then
    pass "T-BOOT-002" "fallback catch path exists"
  else
    fail "T-BOOT-002" "fallback catch path missing"
  fi

  # T-CF-001
  local diff95
  diff95="$(git show 95b18b7c3 -- templates/sync-cloudflare/wrangler.toml || true)"
  if echo "$diff95" | grep -q 'tag = "v1"' \
    && echo "$diff95" | grep -q 'new_classes = \["TldrawDurableObject"\]' \
    && echo "$diff95" | grep -q 'tag = "v2"' \
    && echo "$diff95" | grep -q 'classes_with_sqlite = \["TldrawDurableObject"\]'; then
    pass "T-CF-001" "95 has v1 new_classes + v2 classes_with_sqlite"
  else
    fail "T-CF-001" "95 migration chain markers missing"
  fi

  # T-CF-002
  local diff266
  diff266="$(git show 266d21c41 -- templates/sync-cloudflare/wrangler.toml || true)"
  if echo "$diff266" | grep -q 'tag = "v3"' \
    && echo "$diff266" | grep -q 'deleted_classes = \["TldrawDurableObject"\]' \
    && echo "$diff266" | grep -q 'new_sqlite_classes = \["TldrawDurableObjectSqlite"\]'; then
    pass "T-CF-002" "266 adds v3 class replacement migration"
  else
    fail "T-CF-002" "266 v3 migration markers missing"
  fi

  # T-CF-003
  local combo266
  combo266="$(git show 266d21c41 -- templates/sync-cloudflare/wrangler.toml templates/sync-cloudflare/worker/worker.ts templates/sync-cloudflare/worker-configuration.d.ts templates/sync-cloudflare/worker/TldrawDurableObjectSqlite.ts || true)"
  if echo "$combo266" | grep -q 'class_name = "TldrawDurableObjectSqlite"' \
    && echo "$combo266" | grep -q "export { TldrawDurableObjectSqlite }" \
    && echo "$combo266" | grep -q "import('./worker/worker').TldrawDurableObjectSqlite" \
    && echo "$combo266" | grep -q 'export class TldrawDurableObjectSqlite extends DurableObject'; then
    pass "T-CF-003" "266 aligns binding/export/types/class symbols"
  else
    fail "T-CF-003" "266 symbol alignment incomplete"
  fi
}

run_migration_tests() {
  if pnpm vitest packages/sync-core/src/test/SQLiteSyncStorage.test.ts -t "Migration from TEXT to BLOB"; then
    pass "T-MIG-003" "TEXT->BLOB regression test passes"
  else
    fail "T-MIG-003" "TEXT->BLOB regression test failed"
  fi

  if pnpm vitest packages/sync-core/src/test/SQLiteSyncStorage.test.ts -t "Schema migrations via migrateStorage"; then
    pass "T-MIG-004" "once-per-record sqlite migration test passes"
  else
    fail "T-MIG-004" "once-per-record sqlite migration test failed"
  fi

  if pnpm vitest packages/sync-core/src/test/InMemorySyncStorage.test.ts -t "migrateStorage"; then
    pass "T-MIG-005" "in-memory migration parity test passes"
  else
    fail "T-MIG-005" "in-memory migration parity test failed"
  fi
}

test_status() {
  local id="$1"
  local line
  line="$(grep -E "^${id}[[:space:]]" "$TEST_FILE" || true)"
  if [ -z "$line" ]; then
    echo "UNVERIFIED"
  else
    echo "$line" | awk -F '\t' '{print $2}'
  fi
}

write_claim_scorecard() {
  cat > "$SCORECARD_FILE" <<EOF
# Claim scorecard (${DATE_STAMP})

Generated by: investigation/claims/run-claims.sh ${MODE}

## Test results


test_id | status | detail
--- | --- | ---
EOF

  awk -F '\t' '{printf "%s | %s | %s\n", $1, $2, $3}' "$TEST_FILE" >> "$SCORECARD_FILE"

  cat >> "$SCORECARD_FILE" <<'EOF'

## Claim verdicts

claim_id | status | test evidence
--- | --- | ---
EOF

  emit_claim() {
    local claim_id="$1"
    shift
    local tests=("$@")
    local overall="PASS"
    local details=""
    local any_verified="0"
    for tid in "${tests[@]}"; do
      local st
      st="$(test_status "$tid")"
      details+="${tid}:${st} "
      if [ "$st" != "UNVERIFIED" ]; then any_verified="1"; fi
      if [ "$st" = "FAIL" ]; then overall="FAIL"; fi
      if [ "$st" = "UNVERIFIED" ] && [ "$overall" = "PASS" ]; then overall="PARTIAL"; fi
    done
    if [ "$any_verified" = "0" ]; then overall="UNVERIFIED"; fi
    printf "%s | %s | %s\n" "$claim_id" "$overall" "$details" >> "$SCORECARD_FILE"
  }

  emit_claim CLM-V315-001 T-PROTO-001 T-PROTO-002
  emit_claim CLM-V315-002 T-PERSIST-001 T-PERSIST-002
  emit_claim CLM-D039-001 T-STATIC-001
  emit_claim CLM-D039-002 T-MIG-001
  emit_claim CLM-967-001 T-STATIC-002
  emit_claim CLM-967-002 T-BOOT-001
  emit_claim CLM-D1-001 T-MIG-002 T-MIG-003
  emit_claim CLM-D6-001 T-BOOT-002 T-BOOT-003
  emit_claim CLM-D6-002 T-BOOT-004
  emit_claim CLM-5221-001 T-MIG-004 T-MIG-005
  emit_claim CLM-5221-002 T-STATIC-003
  emit_claim CLM-95-001 T-CF-001
  emit_claim CLM-95-002 T-STATIC-004
  emit_claim CLM-266-001 T-CF-002
  emit_claim CLM-266-002 T-CF-003

  echo "Wrote $SCORECARD_FILE"
  echo "Wrote $TEST_FILE"
}

case "$MODE" in
  static)
    run_static_tests
    ;;
  migrations)
    run_migration_tests
    ;;
  all)
    run_static_tests
    run_migration_tests
    ;;
  *)
    echo "Usage: $0 [static|migrations|all]"
    exit 1
    ;;
esac

write_claim_scorecard
