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
CFG_DIR="$REPO_ROOT/.kimi-claude.local"   # matches *.local -> git-ignored

# --- Locate the key --------------------------------------------------------
# Per-worktree file first (lets one worktree pin a different key/model), then
# the user-level fallback. The fallback is what makes this work in a FRESH
# worktree: .kimi.env.local is git-ignored, so it never comes across when a new
# worktree is created, and every new session would otherwise have to be handed
# the key again. ~/.kimi.env.local lives outside every repo, so it can't be
# committed by accident and all worktrees share it.
#
# It is also what makes Kimi work in a CLOUD session: the encrypted secrets
# bundle restores ~/.kimi.env.local on bootstrap (scripts/secrets/files.list).
KEY_FILE=""
for candidate in "$REPO_ROOT/.kimi.env.local" "$HOME/.kimi.env.local"; do
  if [[ -f "$candidate" ]]; then KEY_FILE="$candidate"; break; fi
done

if [[ -z "$KEY_FILE" ]]; then
  echo "kimi-code: no key file found. Looked for:" >&2
  echo "  $REPO_ROOT/.kimi.env.local" >&2
  echo "  $HOME/.kimi.env.local" >&2
  echo "Create one from .kimi.env.example with KIMI_API_KEY set," >&2
  echo "or in a fresh checkout run: bash scripts/bootstrap-session.sh" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$KEY_FILE"
: "${KIMI_API_KEY:?kimi-code: KIMI_API_KEY not set in $KEY_FILE}"

# --- Isolated, login-less config dir (seed once) ---------------------------
mkdir -p "$CFG_DIR"
if [[ ! -f "$CFG_DIR/.claude.json" ]]; then
  # Claude Code keys projects by native path: backslashes on win32, plain
  # POSIX path elsewhere. `pwd -W` only succeeds under Git Bash on Windows —
  # using it unconditionally turned /home/u/repo into \home\u\repo on Linux,
  # so the trust-dialog pre-accept missed and headless runs stalled.
  if PROJ_PATH="$(pwd -W 2>/dev/null)"; then
    PROJ_PATH="${PROJ_PATH//\//\\}"
  else
    PROJ_PATH="$(pwd)"
  fi
  PY_BIN="$(command -v python3 || command -v python || true)"
  if [[ -z "$PY_BIN" ]]; then
    echo "kimi-code: need python3 (or python) to seed $CFG_DIR/.claude.json" >&2
    exit 1
  fi
  "$PY_BIN" - "$CFG_DIR/.claude.json" "$PROJ_PATH" <<'PY'
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
