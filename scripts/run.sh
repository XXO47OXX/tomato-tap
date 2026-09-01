#!/bin/bash
# run.sh — supervisor for tomato-tap.
#
# Usage:
#   ./scripts/run.sh start               background daemon (idempotent)
#   ./scripts/run.sh stop                graceful stop (SIGTERM + drain)
#   ./scripts/run.sh restart             stop + start
#   ./scripts/run.sh status              supervisor PID, child PID, uptime
#
# Boot survival: use your platform's service manager or add this script to
# the local user's crontab with an absolute checkout path.
#
# Internals:
#   - One supervisor process (tomato-tap.supervisor.pid) runs a while-true
#     loop spawning the actual node child (tomato-tap.pid).
#   - Crash within 30 s 5× in a row → give up (avoids log-spam runaways).
#   - SIGTERM to supervisor → graceful drain of child → clean exit.
#   - `.stop-flag` file communicates "loop intentionally" between stop()
#     and the supervisor body.

set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/env-compat.sh"
tomato_tap_apply_legacy_env
cd "$ROOT"
mkdir -p "$ROOT/runtime"
chmod 700 "$ROOT/runtime" 2>/dev/null || true

readonly NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || {
  echo "node executable not found; install Node.js >= 20 or set NODE_BIN" >&2
  exit 2
}
readonly PROXY_SCRIPT="${PROXY_SCRIPT:-$ROOT/bin/tomato-tap.mjs}"
readonly QUOTA_PROBER_SCRIPT="${QUOTA_PROBER_SCRIPT:-$ROOT/bin/quota-prober.mjs}"
readonly LOG_FILE="${TOMATO_TAP_LOG_FILE:-$ROOT/runtime/proxy.out}"
# Include PORT in PID-file paths so separate instances cannot stop each other.
readonly _INST="${PORT:-8888}"
readonly PID_DIR="${TOMATO_TAP_PID_DIR:-$ROOT}"
mkdir -p "$PID_DIR" "$(dirname "$LOG_FILE")"
readonly PID_FILE="$PID_DIR/tomato-tap.${_INST}.pid"
readonly PROBER_PID_FILE="$PID_DIR/tomato-tap.${_INST}.quota-prober.pid"
readonly SUPERVISOR_PID_FILE="$PID_DIR/tomato-tap.${_INST}.supervisor.pid"
readonly STOP_FLAG="$PID_DIR/.stop-flag.${_INST}"
# Proxy stops accepting new work on SIGTERM and drains for 150 s by default.
# Keep the supervisor's hard-stop ceiling slightly longer than that window.
readonly DRAIN_TIMEOUT_S="${DRAIN_TIMEOUT_S:-165}"
readonly CRASH_WINDOW_S=30
readonly CRASH_MAX_BURST=5

harden_runtime_permissions() {
  find "$ROOT/runtime" -type d -exec chmod 700 {} + 2>/dev/null || true
  find "$ROOT/runtime" -type f -exec chmod 600 {} + 2>/dev/null || true
  for private_file in "$ROOT/.env" "$ROOT/usage.log" "$ROOT/proxy.out" "$ROOT/budget.json" "$LOG_FILE"; do
    [ -f "$private_file" ] && chmod 600 "$private_file" 2>/dev/null || true
  done
}
harden_runtime_permissions

# Outbound proxy policy belongs to the operator. Parent-shell values win;
# otherwise the gateway and quota prober load HTTPS_PROXY/NO_PROXY from .env.
# No machine-specific proxy address is baked into the public launcher.
export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"
export TOMATO_TAP_ENV_FILE="${TOMATO_TAP_ENV_FILE:-$ROOT/.env}"

# Node's environment-proxy support is initialized before the gateway runs, so
# import only network-policy variables before spawning Node. API credentials
# remain loaded by the JavaScript config loader and are never sourced as shell
# code.
load_network_value() {
  local name="$1" value
  [ -f "$TOMATO_TAP_ENV_FILE" ] || return 1
  value=$(awk -v key="$name" '
    index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }
  ' "$TOMATO_TAP_ENV_FILE")
  [ -n "$value" ] || return 1
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf -v "$name" '%s' "$value"
  export "$name"
}
for network_name in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
  [ -n "${!network_name:-}" ] || load_network_value "$network_name" || true
done

is_alive() { [ -f "$1" ] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null; }
log()      { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$LOG_FILE"; }

start() {
  if is_alive "$SUPERVISOR_PID_FILE"; then
    echo "already running: supervisor PID $(cat "$SUPERVISOR_PID_FILE")"
    return 0
  fi
  rm -f "$STOP_FLAG"
  # A dedicated session keeps the supervisor alive when the invoking terminal,
  # SSH command, cron wrapper, or automation process group exits. `nohup`
  # alone only ignores SIGHUP and is insufficient for wrappers that terminate
  # their whole foreground process group.
  nohup setsid "$0" _supervise > /dev/null 2>&1 &
  echo $! > "$SUPERVISOR_PID_FILE"
  # Wait up to 5 s for both children to come up.
  for _ in 1 2 3 4 5; do
    is_alive "$PID_FILE" && is_alive "$PROBER_PID_FILE" && break
    sleep 1
  done
  if is_alive "$PID_FILE" && is_alive "$PROBER_PID_FILE"; then
    echo "started: supervisor PID $(cat "$SUPERVISOR_PID_FILE"), proxy PID $(cat "$PID_FILE"), quota-prober PID $(cat "$PROBER_PID_FILE")"
    return 0
  fi
  echo "FAILED to start. Last 10 log lines:" >&2
  tail -10 "$LOG_FILE" >&2 || true
  return 2
}

stop() {
  if ! is_alive "$SUPERVISOR_PID_FILE" && ! is_alive "$PID_FILE" && ! is_alive "$PROBER_PID_FILE"; then
    echo "not running"
    rm -f "$PID_FILE" "$PROBER_PID_FILE" "$SUPERVISOR_PID_FILE" "$STOP_FLAG"
    return 0
  fi
  # Tell the supervisor not to relaunch the child after it exits.
  : > "$STOP_FLAG"
  # Drain both children first (graceful for in-flight requests and probes).
  for child_file in "$PID_FILE" "$PROBER_PID_FILE"; do
    if ! is_alive "$child_file"; then
      continue
    fi
    local child; child=$(cat "$child_file")
    kill -TERM "$child" 2>/dev/null || true
    for _ in $(seq 1 "$DRAIN_TIMEOUT_S"); do
      kill -0 "$child" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$child" 2>/dev/null && kill -KILL "$child" 2>/dev/null || true
  done
  # Stop the supervisor itself.
  if is_alive "$SUPERVISOR_PID_FILE"; then
    local sup; sup=$(cat "$SUPERVISOR_PID_FILE")
    kill -TERM "$sup" 2>/dev/null || true
    sleep 1
    is_alive "$SUPERVISOR_PID_FILE" && kill -KILL "$sup" 2>/dev/null || true
  fi
  rm -f "$PID_FILE" "$PROBER_PID_FILE" "$SUPERVISOR_PID_FILE" "$STOP_FLAG"
  echo "stopped"
}

status() {
  local sup_ok=0 child_ok=0 prober_ok=0
  is_alive "$SUPERVISOR_PID_FILE" && sup_ok=1
  is_alive "$PID_FILE" && child_ok=1
  is_alive "$PROBER_PID_FILE" && prober_ok=1
  if [ "$sup_ok" = 1 ] && [ "$child_ok" = 1 ] && [ "$prober_ok" = 1 ]; then
    echo "running: supervisor PID $(cat "$SUPERVISOR_PID_FILE"), proxy PID $(cat "$PID_FILE"), quota-prober PID $(cat "$PROBER_PID_FILE"), uptime $(ps -p "$(cat "$PID_FILE")" -o etime= | tr -d ' ')"
    return 0
  fi
  if [ "$sup_ok" = 1 ]; then
    echo "supervisor up (PID $(cat "$SUPERVISOR_PID_FILE")), child between restarts (proxy=$child_ok quota-prober=$prober_ok)"
    return 0
  fi
  # Stale pid files left over from a crash.
  [ -f "$PID_FILE" ] && [ "$child_ok" = 0 ] && rm -f "$PID_FILE"
  [ -f "$PROBER_PID_FILE" ] && [ "$prober_ok" = 0 ] && rm -f "$PROBER_PID_FILE"
  [ -f "$SUPERVISOR_PID_FILE" ] && [ "$sup_ok" = 0 ] && rm -f "$SUPERVISOR_PID_FILE"
  echo "not running"
  return 3
}

_supervise() {
  local proxy_started=0 prober_started=0 proxy_burst=0 prober_burst=0
  cleanup_children() {
    for child_file in "$PID_FILE" "$PROBER_PID_FILE"; do
      if is_alive "$child_file"; then
        kill -TERM "$(cat "$child_file")" 2>/dev/null || true
      fi
    done
  }
  trap ': > "$STOP_FLAG"; cleanup_children; exit 0' TERM INT

  launch_proxy() {
    "$NODE_BIN" "$PROXY_SCRIPT" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    proxy_started=$(date +%s)
  }
  launch_prober() {
    "$NODE_BIN" "$QUOTA_PROBER_SCRIPT" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PROBER_PID_FILE"
    prober_started=$(date +%s)
  }

  launch_proxy
  launch_prober
  while true; do
    if [ -f "$STOP_FLAG" ]; then
      cleanup_children
      rm -f "$PID_FILE" "$PROBER_PID_FILE"
      rm -f "$STOP_FLAG"
      exit 0
    fi

    if ! is_alive "$PID_FILE"; then
      local proxy_duration=$(( $(date +%s) - proxy_started ))
      rm -f "$PID_FILE"
      if [ "$proxy_duration" -lt "$CRASH_WINDOW_S" ]; then
        proxy_burst=$(( proxy_burst + 1 ))
      else
        proxy_burst=0
      fi
      if [ "$proxy_burst" -ge "$CRASH_MAX_BURST" ]; then
        log "supervisor: proxy crashed $CRASH_MAX_BURST times — giving up."
        cleanup_children
        exit 1
      fi
      log "supervisor: proxy exited uptime=${proxy_duration}s — restarting"
      launch_proxy
    fi

    if ! is_alive "$PROBER_PID_FILE"; then
      local prober_duration=$(( $(date +%s) - prober_started ))
      rm -f "$PROBER_PID_FILE"
      if [ "$prober_duration" -lt "$CRASH_WINDOW_S" ]; then
        prober_burst=$(( prober_burst + 1 ))
      else
        prober_burst=0
      fi
      if [ "$prober_burst" -ge "$CRASH_MAX_BURST" ]; then
        log "supervisor: quota-prober crashed $CRASH_MAX_BURST times — giving up."
        cleanup_children
        exit 1
      fi
      log "supervisor: quota-prober exited uptime=${prober_duration}s — restarting"
      launch_prober
    fi
    sleep 1
  done
}

case "${1:-}" in
  start)       start ;;
  stop)        stop ;;
  restart)     stop || true; sleep 2; start ;;
  status)      status ;;
  _supervise)  _supervise ;;        # internal
  *)           echo "usage: $0 {start|stop|restart|status}" >&2; exit 1 ;;
esac
