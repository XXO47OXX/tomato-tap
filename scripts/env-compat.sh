#!/bin/bash

# Imported by operator scripts. Do not execute this file directly.
tomato_tap_apply_legacy_env() {
  local legacy_name canonical_name
  while IFS= read -r legacy_name; do
    canonical_name="TOMATO_TAP_${legacy_name#MIMO_TAP_}"
    if [ -z "${!canonical_name+x}" ]; then
      printf -v "$canonical_name" '%s' "${!legacy_name}"
      export "$canonical_name"
    fi
  done < <(compgen -A variable MIMO_TAP_)
}
