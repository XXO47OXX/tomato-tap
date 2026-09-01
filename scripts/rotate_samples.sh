#!/bin/bash
# Keep tomato-tap samples within both an age window and a byte limit.
# The sample logger only appends files, so deleting expired samples is safe.
# Optional manual/cron fallback. The proxy now performs the same cleanup itself
# when TOMATO_TAP_SAMPLES_ENABLED=true. KEEP_DAYS/MAX_SIZE_GB remain supported;
# the TOMATO_TAP_* aliases let one env file configure both paths.

set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/env-compat.sh"
tomato_tap_apply_legacy_env
if [ -n "${TOMATO_TAP_STATE_DIR:-}" ]; then
    STATE_DIR="$TOMATO_TAP_STATE_DIR"
    RUNTIME_DIR="${TOMATO_TAP_RUNTIME_DIR:-$STATE_DIR/runtime}"
elif [ -e "$ROOT/usage.log" ] || [ -e "$ROOT/budget.json" ] || [ -e "$ROOT/samples" ]; then
    STATE_DIR="$ROOT"
    RUNTIME_DIR="$ROOT/runtime"
else
    STATE_DIR="$ROOT/runtime"
    RUNTIME_DIR="$ROOT/runtime"
fi
mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
DIR="${TOMATO_TAP_SAMPLES_DIR:-$STATE_DIR/samples}"
REAL_DIR="$(readlink -f "$DIR" 2>/dev/null || printf "%s" "$DIR")"
KEEP_DAYS="${TOMATO_TAP_SAMPLES_RETENTION_DAYS:-${KEEP_DAYS:-7}}"
MAX_SIZE_GB="${TOMATO_TAP_SAMPLES_MAX_SIZE_GB:-${MAX_SIZE_GB:-5}}"
HISTORY="$RUNTIME_DIR/rotate_log.history"
LOCK="$RUNTIME_DIR/rotate_samples.lock"

[ -d "$DIR" ] || exit 0

case "$KEEP_DAYS" in
  ""|*[!0-9]*) echo "KEEP_DAYS must be a non-negative integer" >&2; exit 2 ;;
esac
if ! MAX_SIZE_BYTES=$(awk -v gb="$MAX_SIZE_GB" "BEGIN { if (gb !~ /^[0-9]+([.][0-9]+)?$/ || gb < 0) exit 1; printf \"%.0f\", gb * 1024 * 1024 * 1024 }"); then
    echo "MAX_SIZE_GB must be a non-negative number" >&2
    exit 2
fi

# Prevent overlapping hourly runs, especially while scanning a large NTFS directory.
exec 9>"$LOCK"
flock -n 9 || exit 0

TMP_BASE="$(dirname "$REAL_DIR")"
TMP_DIR="$(mktemp -d "$TMP_BASE/.rotate_samples.XXXXXX" 2>/dev/null || mktemp -d)"
SORTED="$TMP_DIR/sorted_records"
KEPT="$TMP_DIR/kept_records"
trap "rm -rf -- \"$TMP_DIR\"" EXIT

# One filesystem scan. Sorting by mtime makes both age cleanup and size cleanup oldest-first.
find "$DIR" -maxdepth 1 -type f -printf "%T@ %s %p\0" 2>/dev/null | sort -z -n > "$SORTED"

before_count=0
before_size=0
current_count=0
current_size=0
deleted=0
freed=0
cutoff=$(( $(date +%s) - KEEP_DAYS * 86400 ))

while IFS= read -r -d "" record; do
    timestamp="${record%% *}"
    rest="${record#* }"
    file_size="${rest%% *}"
    file="${rest#* }"
    timestamp_int="${timestamp%%.*}"
    before_count=$((before_count + 1))
    before_size=$((before_size + file_size))

    if [ "$timestamp_int" -lt "$cutoff" ]; then
        if rm -f -- "$file"; then
            deleted=$((deleted + 1))
            freed=$((freed + file_size))
        fi
    else
        printf "%s\0" "$record" >> "$KEPT"
        current_count=$((current_count + 1))
        current_size=$((current_size + file_size))
    fi
done < "$SORTED"

# If age cleanup is not enough, remove the oldest remaining files until under the cap.
if [ "$current_size" -gt "$MAX_SIZE_BYTES" ]; then
    while IFS= read -r -d "" record; do
        [ "$current_size" -le "$MAX_SIZE_BYTES" ] && break
        rest="${record#* }"
        file_size="${rest%% *}"
        file="${rest#* }"
        if [ -f "$file" ] && rm -f -- "$file"; then
            deleted=$((deleted + 1))
            freed=$((freed + file_size))
            current_count=$((current_count - 1))
            current_size=$((current_size - file_size))
        fi
    done < "$KEPT"
fi

if [ "$deleted" -gt 0 ] || [ "$current_size" -gt "$MAX_SIZE_BYTES" ]; then
    human_freed=$(numfmt --to=iec --suffix=B "$freed" 2>/dev/null || printf "%sB" "$freed")
    human_size=$(numfmt --to=iec --suffix=B "$current_size" 2>/dev/null || printf "%sB" "$current_size")
    human_cap=$(numfmt --to=iec --suffix=B "$MAX_SIZE_BYTES" 2>/dev/null || printf "%sB" "$MAX_SIZE_BYTES")
    printf "[%s] samples rotated: scanned=%s deleted=%s freed=%s kept=%s size=%s cap=%s days=%s\n" \
        "$(date -Iseconds)" "$before_count" "$deleted" "$human_freed" "$current_count" "$human_size" "$human_cap" "$KEEP_DAYS" >> "$HISTORY"
fi
