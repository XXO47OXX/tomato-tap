#!/bin/bash
# Truncate runtime logs when they exceed limits, keeping the tail for context.
# Wired to cron every 10 min.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/env-compat.sh"
tomato_tap_apply_legacy_env
mkdir -p "$ROOT/runtime"

rotate_one() {
    local log="$1" max_bytes="$2" tail_bytes="$3"
    [ -f "$log" ] || return 0
    local size
    size=$(stat -c%s "$log")
    [ "$size" -le "$max_bytes" ] && return 0

    # Preserve tail without dropping the file (tomato-tap holds the fd, can't rename).
    local tmp="${log}.rotating.$$"
    tail -c "$tail_bytes" "$log" > "$tmp"
    cat "$tmp" > "$log"
    rm -f "$tmp"
    chmod 600 "$log" 2>/dev/null || true
    echo "[$(date -Iseconds)] rotated $(basename "$log"): ${size}B -> $(stat -c%s "$log")B" >> "$ROOT/runtime/rotate_log.history"
}

rotate_one "$ROOT/runtime/proxy.out" $((500 * 1024 * 1024)) $((50 * 1024 * 1024))
# 代理池 boot/watchdog 日志：小体积高频追加，10MB 截断
rotate_one "$ROOT/runtime/proxy-pool-boot.log" $((10 * 1024 * 1024)) $((512 * 1024))
# usage.log is intentionally absent here. usage-ledger.mjs rotates it only
# after draining its writer, so request accounting cannot lose rows.
