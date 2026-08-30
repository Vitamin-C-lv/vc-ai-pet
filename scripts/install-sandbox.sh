#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-$HOME/.local/share/vc-ai-pet}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT"
[[ -d "$ROOT/sandbox" ]] || cp -a "$SRC/sandbox-template" "$ROOT/sandbox"
echo "PET_SANDBOX=$ROOT/sandbox"
