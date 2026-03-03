#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<USAGE
Usage:
  $SCRIPT_NAME up [--fresh] [--keep-traces] [--no-worker]
  $SCRIPT_NAME down
  $SCRIPT_NAME restart [--keep-traces] [--no-worker]
  $SCRIPT_NAME status
  $SCRIPT_NAME doctor

Commands:
  up         Start Jaeger + OTel collector, optionally reset stale services, clear traces, start sync worker.
  down       Stop sync worker and OTel docker services.
  restart    Equivalent to: down, then up --fresh.
  status     Show service/process status and traces file stats.
  doctor     Check for stale/broken state and print recommended action.

Options:
  --fresh        Force a clean restart of docker services and worker before startup.
  --keep-traces  Keep internal/observability/otel/data/traces.jsonl as-is.
  --no-worker    Start only docker services (skip sync worker).
USAGE
}

log() {
  printf '[otel-lab] %s\n' "$*"
}

warn() {
  printf '[otel-lab][warn] %s\n' "$*" >&2
}

fail() {
  printf '[otel-lab][error] %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

find_repo_root() {
  if [[ -n "${TLDRAW_REPO_ROOT:-}" ]] && [[ -f "$TLDRAW_REPO_ROOT/internal/observability/otel/docker-compose.yml" ]]; then
    printf '%s\n' "$TLDRAW_REPO_ROOT"
    return
  fi

  if git_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    if [[ -f "$git_root/internal/observability/otel/docker-compose.yml" ]]; then
      printf '%s\n' "$git_root"
      return
    fi
  fi

  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/internal/observability/otel/docker-compose.yml" ]]; then
      printf '%s\n' "$dir"
      return
    fi
    dir="$(dirname "$dir")"
  done

  fail "Could not find tldraw repo root. Run from the repo (or set TLDRAW_REPO_ROOT)."
}

ROOT="$(find_repo_root)"
COMPOSE_FILE="$ROOT/internal/observability/otel/docker-compose.yml"
TRACE_FILE="$ROOT/internal/observability/otel/data/traces.jsonl"
STATE_DIR="$ROOT/internal/observability/otel/data"
WORKER_PID_FILE="$STATE_DIR/sync-worker.pid"
WORKER_LOG_FILE="$STATE_DIR/sync-worker.log"
WORKER_PORT="${WORKER_PORT:-8790}"

compose() {
  (cd "$ROOT" && docker compose -f "$COMPOSE_FILE" "$@")
}

yarn_repo() {
  (cd "$ROOT" && corepack yarn "$@")
}

port_pids() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

is_pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

worker_pid_from_file() {
  [[ -f "$WORKER_PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$WORKER_PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  printf '%s\n' "$pid"
}

cleanup_dead_worker_pid_file() {
  local pid
  pid="$(worker_pid_from_file 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    if ! is_pid_alive "$pid"; then
      rm -f "$WORKER_PID_FILE"
    fi
  fi
}

running_services() {
  compose ps --status running --services 2>/dev/null || true
}

collector_services_healthy() {
  local services
  services="$(running_services)"

  grep -q '^jaeger$' <<<"$services" || return 1
  grep -q '^otel-collector$' <<<"$services" || return 1

  curl -fsS --max-time 2 "http://127.0.0.1:16686" >/dev/null || return 1
  nc -z 127.0.0.1 4318 >/dev/null 2>&1 || return 1

  return 0
}

ensure_trace_file() {
  mkdir -p "$STATE_DIR"
  chmod 0777 "$STATE_DIR" >/dev/null 2>&1 || true
  touch "$TRACE_FILE"
  chmod 0666 "$TRACE_FILE" >/dev/null 2>&1 || true
  [[ -w "$TRACE_FILE" ]] || fail "Trace file is not writable: $TRACE_FILE"
}

clear_trace_file() {
  ensure_trace_file
  : > "$TRACE_FILE"
  log "Cleared trace data: $TRACE_FILE"
}

stop_worker() {
  cleanup_dead_worker_pid_file

  local pid
  pid="$(worker_pid_from_file 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    if is_pid_alive "$pid"; then
      log "Stopping sync worker (pid $pid)"
      kill "$pid" >/dev/null 2>&1 || true
      for _ in {1..20}; do
        if ! is_pid_alive "$pid"; then
          break
        fi
        sleep 0.25
      done
      if is_pid_alive "$pid"; then
        warn "Worker did not stop gracefully; sending SIGKILL"
        kill -9 "$pid" >/dev/null 2>&1 || true
      fi
    fi
    rm -f "$WORKER_PID_FILE"
  fi

  local pids
  pids="$(port_pids "$WORKER_PORT")"
  if [[ -n "$pids" ]]; then
    warn "Port $WORKER_PORT is in use; killing stale process(es): $pids"
    # shellcheck disable=SC2086
    kill $pids >/dev/null 2>&1 || true
    sleep 0.5
    pids="$(port_pids "$WORKER_PORT")"
    if [[ -n "$pids" ]]; then
      warn "Force-killing remaining process(es) on port $WORKER_PORT: $pids"
      # shellcheck disable=SC2086
      kill -9 $pids >/dev/null 2>&1 || true
    fi
  fi
}

start_worker() {
  ensure_trace_file
  cleanup_dead_worker_pid_file

  local pid
  pid="$(worker_pid_from_file 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    if is_pid_alive "$pid"; then
      log "Sync worker already running (pid $pid)"
      return
    fi
  fi

  local pids
  pids="$(port_pids "$WORKER_PORT")"
  if [[ -n "$pids" ]]; then
    warn "Port $WORKER_PORT is already in use; cleaning stale process(es): $pids"
    # shellcheck disable=SC2086
    kill $pids >/dev/null 2>&1 || true
    sleep 0.5
  fi

  log "Starting sync worker on http://127.0.0.1:$WORKER_PORT (logs: $WORKER_LOG_FILE)"
  (
    cd "$ROOT"
    # Wrangler requires --var KEY:VALUE to inject Worker env bindings at runtime.
    corepack yarn workspace @tldraw/dotcom-worker exec wrangler dev \
      --config wrangler.simple.toml \
      --local \
      --log-level info \
      --port "$WORKER_PORT" \
      --var OTEL_ENABLED:true \
      --var OTEL_CAPTURE_SPANS:true \
      --var OTEL_EXPORTER_OTLP_ENDPOINT:http://127.0.0.1:4318/v1/traces \
      --var OTEL_SERVICE_NAME:tldraw-sync-core-simple-worker \
      --var OTEL_SAMPLE_RATIO:1 \
      --var WORKER_ENV:development
  ) >"$WORKER_LOG_FILE" 2>&1 &

  local pid=$!
  printf '%s\n' "$pid" > "$WORKER_PID_FILE"

  for _ in {1..45}; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$WORKER_PORT/health" >/dev/null; then
      log "Sync worker is ready (pid $pid)"
      return
    fi
    if ! is_pid_alive "$pid"; then
      warn "Worker exited during startup. Recent logs:"
      tail -n 40 "$WORKER_LOG_FILE" >&2 || true
      fail "Failed to start sync worker"
    fi
    sleep 0.5
  done

  warn "Timed out waiting for worker health endpoint. Recent logs:"
  tail -n 40 "$WORKER_LOG_FILE" >&2 || true
  fail "Worker did not become healthy in time"
}

trace_line_count() {
  ensure_trace_file
  wc -l < "$TRACE_FILE" | tr -d ' '
}

probe_trace_write() {
  local before after
  before="$(trace_line_count)"

  curl -fsS --max-time 4 "http://127.0.0.1:$WORKER_PORT/health" >/dev/null || return 1
  sleep 2

  after="$(trace_line_count)"
  if (( after > before )); then
    log "Trace probe OK ($before -> $after lines in traces.jsonl)"
    return 0
  fi

  return 1
}

start_collector() {
  if collector_services_healthy; then
    log "OTel docker services already healthy"
    return
  fi

  warn "OTel services are missing or unhealthy; restarting collector + Jaeger"
  yarn_repo otel:down >/dev/null 2>&1 || true
  yarn_repo otel:up >/dev/null

  for _ in {1..30}; do
    if collector_services_healthy; then
      log "OTel collector + Jaeger are healthy"
      return
    fi
    sleep 1
  done

  fail "Collector stack did not become healthy"
}

cmd_up() {
  local fresh="false"
  local keep_traces="false"
  local no_worker="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --fresh) fresh="true" ;;
      --keep-traces) keep_traces="true" ;;
      --no-worker) no_worker="true" ;;
      *) fail "Unknown option for up: $1" ;;
    esac
    shift
  done

  require_cmd corepack
  require_cmd docker
  require_cmd curl
  require_cmd nc
  require_cmd lsof

  if [[ "$fresh" == "true" ]]; then
    log "Forcing fresh restart"
    stop_worker
    yarn_repo otel:down >/dev/null 2>&1 || true
  fi

  start_collector

  if [[ "$keep_traces" != "true" ]]; then
    clear_trace_file
  else
    ensure_trace_file
    log "Keeping existing trace file"
  fi

  if [[ "$no_worker" == "true" ]]; then
    log "Skipping worker startup (--no-worker)"
    return
  fi

  start_worker

  if probe_trace_write; then
    return
  fi

  warn "No new traces detected after probe; restarting collector once"
  yarn_repo otel:down >/dev/null 2>&1 || true
  start_collector

  if ! probe_trace_write; then
    warn "Trace file still not updating. Check $WORKER_LOG_FILE and docker logs (corepack yarn otel:logs)."
    return 1
  fi
}

cmd_down() {
  require_cmd corepack
  require_cmd docker

  stop_worker
  log "Stopping OTel docker services"
  yarn_repo otel:down >/dev/null || true
}

cmd_status() {
  ensure_trace_file
  cleanup_dead_worker_pid_file

  echo "repo_root=$ROOT"

  echo "docker_services_running=$(running_services | tr '\n' ',' | sed 's/,$//')"

  if collector_services_healthy; then
    echo "collector_health=healthy"
  else
    echo "collector_health=unhealthy"
  fi

  local pid
  pid="$(worker_pid_from_file 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    if is_pid_alive "$pid"; then
      echo "worker_status=running"
      echo "worker_pid=$pid"
    else
      echo "worker_status=stale_pid_file"
    fi
  else
    echo "worker_status=stopped"
  fi

  local port_p
  port_p="$(port_pids "$WORKER_PORT")"
  if [[ -n "$port_p" ]]; then
    echo "worker_port_in_use=true"
    echo "worker_port_pids=$port_p"
  else
    echo "worker_port_in_use=false"
  fi

  echo "trace_file=$TRACE_FILE"
  echo "trace_lines=$(trace_line_count)"
  echo "jaeger_ui=http://127.0.0.1:16686"
  echo "worker_url=http://127.0.0.1:$WORKER_PORT"
}

cmd_doctor() {
  ensure_trace_file
  cleanup_dead_worker_pid_file

  local issues=0

  if collector_services_healthy; then
    log "Collector + Jaeger look healthy"
  else
    warn "Collector stack is unhealthy or incomplete"
    issues=$((issues + 1))
  fi

  local pid
  pid="$(worker_pid_from_file 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    if is_pid_alive "$pid"; then
      log "Worker process is alive (pid $pid)"
    else
      warn "Stale worker PID file found"
      issues=$((issues + 1))
    fi
  else
    warn "Worker is not tracked via PID file"
    if [[ -n "$(port_pids "$WORKER_PORT")" ]]; then
      warn "Port $WORKER_PORT is occupied by an untracked process"
      issues=$((issues + 1))
    fi
  fi

  if [[ -w "$TRACE_FILE" ]]; then
    log "Trace file exists and is writable"
  else
    warn "Trace file is not writable: $TRACE_FILE"
    issues=$((issues + 1))
  fi

  if curl -fsS --max-time 2 "http://127.0.0.1:$WORKER_PORT/health" >/dev/null 2>&1; then
    if probe_trace_write; then
      log "Trace ingestion probe succeeded"
    else
      warn "Health endpoint works but traces.jsonl did not grow"
      issues=$((issues + 1))
    fi
  else
    warn "Worker health endpoint not reachable at http://127.0.0.1:$WORKER_PORT/health"
    issues=$((issues + 1))
  fi

  if (( issues == 0 )); then
    log "Doctor check passed"
  else
    warn "Doctor found $issues issue(s). Recommended: $SCRIPT_NAME up --fresh"
    return 1
  fi
}

cmd_restart() {
  local keep_traces="false"
  local no_worker="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep-traces) keep_traces="true" ;;
      --no-worker) no_worker="true" ;;
      *) fail "Unknown option for restart: $1" ;;
    esac
    shift
  done

  cmd_down

  local args=(--fresh)
  if [[ "$keep_traces" == "true" ]]; then
    args+=(--keep-traces)
  fi
  if [[ "$no_worker" == "true" ]]; then
    args+=(--no-worker)
  fi

  cmd_up "${args[@]}"
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi

  local command="$1"
  shift

  case "$command" in
    up) cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    restart) cmd_restart "$@" ;;
    status) cmd_status "$@" ;;
    doctor) cmd_doctor "$@" ;;
    -h|--help|help)
      usage
      ;;
    *)
      fail "Unknown command: $command"
      ;;
  esac
}

main "$@"
