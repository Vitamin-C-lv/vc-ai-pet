#!/usr/bin/env bash
set -euo pipefail
ROOT="/mnt/d/VC-AI-Pet"
[[ -d /mnt/d ]] || { echo "ERROR: D: is not mounted at /mnt/d" >&2; exit 2; }

mkdir -p \
  "$ROOT/models/Qwen3.5-4B" \
  "$ROOT/runtime/llama.cpp" \
  "$ROOT/cache" \
  "$ROOT/temp"

printf '%s\n' \
  "PET_MODEL_ROOT=$ROOT/models/Qwen3.5-4B" \
  "PET_RUNTIME_ROOT=$ROOT/runtime/llama.cpp" \
  "PET_CACHE_ROOT=$ROOT/cache" \
  "PET_TEMP_ROOT=$ROOT/temp" \
  "PET_BACKUP_RESERVED=/mnt/e/VC-AI-Pet-Backup"

echo "MODEL_POLICY=Qwen3.5-4B-Q4_K_M_ONLY"
echo "D_STORAGE_PREPARED=PASS"
