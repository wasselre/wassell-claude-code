#!/usr/bin/env bash
#
# kimi-code — run Kimi K3 as the CODER via Claude Code's agent harness.
#
# Architecture: "Claude plans, Kimi codes." The parent Claude Code session
# (the planner) stays on Claude. This script launches a SEPARATE headless
# `claude -p` process that runs on Kimi K3 via Moonshot's Anthropic-compatible
# API. Two things keep the two worlds apart:
#   1. ANTHROPIC_* env vars are exported only inside this process.
#   2. CLAUDE_CONFIG_DIR points at an ISOLATED, login-less config dir, so the
#      coder can't fall back to your OAuth session (which otherwise overrides
#      the Kimi key and 401s against Moonshot). The dir is auto-seeded on first
#      run so the headless call never stalls on onboarding / trust prompts.
#
# Usage:
#   scripts/kimi-code.sh "implement X in src/foo.ts, match the existing style"
#   scripts/kimi-code.sh --permission-mode plan "..."   # extra flags pass through
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEY_FILE="$REPO_ROOT/.kimi.env.local"
CFG_DIR="$REPO_ROOT/.kimi-claude.local"   # matches *.local -> git-ignored

if [[ ! -f "$KEY_FILE" ]]; then
  echo "kimi-code: missing $KEY_FILE (must define KIMI_API_KEY)" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$KEY_FILE"
: "${KIMI_API_KEY:?kimi-code: KIMI_API_KEY not set in .kimi.env.local}"

# --- Isolated, login-less config dir (seed once) ---------------------------
mkdir -p "$CFG_DIR"
if [[ ! -f "$CFG_DIR/.claude.json" ]]; then
  # Windows-style backslash path is how Claude Code keys projects on win32.
  WIN_PATH="$(pwd -W 2>/dev/null || pwd)"; WIN_PATH="${WIN_PATH//\//\\}"
  python - "$CFG_DIR/.claude.json" "$WIN_PATH" <<'PY'
import json, sys
cfg_path, proj = sys.argv[1], sys.argv[2]
json.dump({
    "hasCompletedOnboarding": True,
    "projects": {proj: {"hasTrustDialogAccepted": True, "allowedTools": []}},
}, open(cfg_path, "w"), indent=2)
PY
fi
export CLAUDE_CONFIG_DIR="$CFG_DIR"

# --- Point the harness at Kimi K3 ------------------------------------------
unset ANTHROPIC_API_KEY || true
export ANTHROPIC_BASE_URL="https://api.moonshot.ai/anthropic"
export ANTHROPIC_AUTH_TOKEN="$KIMI_API_KEY"
export ANTHROPIC_MODEL="${KIMI_MODEL:-kimi-k3}"
# Moonshot has no separate small/fast model — route the background model to K3.
export ANTHROPIC_SMALL_FAST_MODEL="${KIMI_MODEL:-kimi-k3}"

cd "$REPO_ROOT"

# acceptEdits: Kimi may write/modify files autonomously (the planner reviews
# the diff after). Override by passing your own --permission-mode before the prompt.
exec claude -p --permission-mode acceptEdits "$@"
