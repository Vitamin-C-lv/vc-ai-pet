#!/usr/bin/env bash
set -euo pipefail
REPO_NAME="${1:-vc-ai-pet}"
[[ -d .git ]] || { git init; git branch -M main; }
git add .
if ! git diff --cached --quiet; then git commit -m "feat: bootstrap vc-ai-pet v0.1"; fi
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if ! git remote get-url origin >/dev/null 2>&1; then gh repo create "$REPO_NAME" --public --source=. --remote=origin --push; else git push -u origin main; fi
else
  echo "GitHub CLI not authenticated. Use existing GitHub auth/remote only; do not modify VPN/proxy/SSH/credentials for this task." >&2; exit 3
fi
