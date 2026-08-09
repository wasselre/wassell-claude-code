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

# --- Scrub the inherited CLAUDE_*/ANTHROPIC_* namespace --------------------
# A CLOUD session (Claude Code on the web) injects ~40 CLAUDE_CODE_* vars that
# wire the CLI to the HOST's managed provider: CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
# CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, CLAUDE_SESSION_INGRESS_TOKEN_FILE,
# CLAUDE_CODE_REMOTE, and friends. A child `claude` inherits them and keeps
# authenticating as the SESSION even though ANTHROPIC_AUTH_TOKEN is set — so it
# sends the session's OAuth token to Moonshot and gets a flat 401
# ("Authentication error · This may be a temporary network issue"), which is a
# credential problem wearing a network problem's clothes. CLAUDE_CONFIG_DIR
# alone does NOT cover this: the config dir is login-less, but the env still
# carries live host credentials.
#
# Blocklisting the known offenders is a losing game — the host adds vars over
# time — so scrub the whole namespace and re-export only what we set below.
# Deliberate tuning survives via the KIMI_* keys in the key file.
while IFS='=' read -r _var _; do
  case "$_var" in CLAUDE*|ANTHROPIC*) unset "$_var" || true ;; esac
done < <(env)

# --- Point the harness at Kimi K3 ------------------------------------------
# Everything below is re-exported AFTER the scrub above, so order matters.
export CLAUDE_CONFIG_DIR="$CFG_DIR"
export ANTHROPIC_BASE_URL="https://api.moonshot.ai/anthropic"
export ANTHROPIC_AUTH_TOKEN="$KIMI_API_KEY"
export ANTHROPIC_MODEL="${KIMI_MODEL:-kimi-k3}"
# Moonshot has no separate small/fast model — route the background model to K3.
export ANTHROPIC_SMALL_FAST_MODEL="${KIMI_MODEL:-kimi-k3}"
# Claude Code doesn't know Kimi's context window, so it assumes 200k and warns
# on every run. Set KIMI_MAX_CONTEXT_TOKENS in the key file to the model's real
# window to silence the warning and let auto-compact use the full budget.
if [[ -n "${KIMI_MAX_CONTEXT_TOKENS:-}" ]]; then
  export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$KIMI_MAX_CONTEXT_TOKENS"
fi

cd "$REPO_ROOT"

# acceptEdits: Kimi may write/modify files autonomously (the planner reviews
# the diff after). Override by passing your own --permission-mode before the prompt.
exec claude -p --permission-mode acceptEdits "$@"
