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
  # Pick a python that actually RUNS, not merely one that exists on PATH.
  # On Windows, `command -v python3` finds the Microsoft Store app-execution
  # alias at AppData/Local/Microsoft/WindowsApps/python3 — a stub that prints
  # "Python was not found..." and exits non-zero. Testing existence alone
  # selected the stub and every kimi-code run died before reaching Moonshot.
  PY_BIN=""
  for cand in python3 python py; do
    candidate="$(command -v "$cand" || true)"
    [[ -z "$candidate" ]] && continue
    if "$candidate" -c "pass" >/dev/null 2>&1; then PY_BIN="$candidate"; break; fi
  done
  if [[ -z "$PY_BIN" ]]; then
    echo "kimi-code: need a WORKING python3/python to seed $CFG_DIR/.claude.json" >&2
    echo "  (a Microsoft Store python stub on PATH does not count)" >&2
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

# --- Strip the HOST-MANAGED provider environment ---------------------------
# In a Claude Code CLOUD session the harness pins the model provider itself:
# it exports CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1, hands auth in over
# CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, and sets ~80 other CLAUDE_*/
# ANTHROPIC_* vars. Those are INHERITED by this subprocess and outrank the Kimi
# credentials below, so the child `claude -p` tried to talk to Moonshot with the
# host's session and died on "Authentication error" — even though the key is
# valid (a direct curl to api.moonshot.ai returns 200). CLAUDE_CONFIG_DIR alone
# does not save you: it isolates the on-disk config, not the environment.
#
# Verified live in a cloud session (2026-08-09): unsetting the obvious two vars
# is NOT enough, and neither is swapping ANTHROPIC_AUTH_TOKEN for
# ANTHROPIC_API_KEY. Clearing the whole inherited CLAUDE*/ANTHROPIC* surface is
# what works, and it is also the honest description of what we want — the coder
# must start from a blank provider environment, not a filtered one.
#
# On a laptop this loop finds little or nothing and costs nothing.
KIMI_ENV_STRIP=()
while IFS='=' read -r _k _; do
  case "$_k" in
    CLAUDE*|ANTHROPIC*) KIMI_ENV_STRIP+=(-u "$_k") ;;
  esac
done < <(env)

# --- Point the harness at Kimi K3 ------------------------------------------
cd "$REPO_ROOT"

# acceptEdits: Kimi may write/modify files autonomously (the planner reviews
# the diff after). Override by passing your own --permission-mode before the prompt.
#
# --- Standing brief ---------------------------------------------------------
# The coder starts every run with ZERO context: it has never seen this codebase
# and remembers nothing from the last run. Both defects found in review on
# 2026-09-16 (an hourly tick that would have run on all five worker machines,
# and a claim placed outside its try/catch) were CONTEXT failures — the planner
# forgot to put a standing fact in a one-off spec.
#
# So the standing facts are not left to the planner's memory. Every run is
# prefixed with docs/kimi-coder-brief.md. Keep that file short: it is re-sent on
# every invocation, and everything in it earns its place by having cost a bug.
#
# Prepending (rather than appending) puts the house rules ahead of the task, so
# a spec that contradicts them reads as the exception it is.
# Split leading FLAGS from the prompt text: callers may pass their own
# --permission-mode (or any other claude flag) before the prompt, and those must
# reach the CLI as flags rather than being swallowed into the prompt string.
KIMI_FLAGS=()
while [[ $# -gt 0 && "$1" == -* ]]; do
  KIMI_FLAGS+=("$1")
  shift
  # A flag that takes a value (e.g. --permission-mode plan) consumes the next
  # arg too, as long as it is not itself a flag.
  if [[ $# -gt 0 && "$1" != -* ]]; then
    KIMI_FLAGS+=("$1")
    shift
  fi
done
KIMI_TASK="$*"

BRIEF_FILE="$REPO_ROOT/docs/kimi-coder-brief.md"
if [[ -f "$BRIEF_FILE" ]]; then
  KIMI_PROMPT="$(cat "$BRIEF_FILE")

---

# Your task

$KIMI_TASK"
else
  # Loud, not silent: a missing brief means the coder is flying blind, and the
  # planner should know that before reading the diff.
  echo "kimi-code: WARNING - $BRIEF_FILE not found; running WITHOUT the standing brief." >&2
  KIMI_PROMPT="$KIMI_TASK"
fi

# stdin is redirected from /dev/null: with no terminal attached the CLI waits
# ~3 s for piped input before giving up. Callers that DO want to pipe context in
# should use the prompt argument instead.
exec env "${KIMI_ENV_STRIP[@]}" \
  CLAUDE_CONFIG_DIR="$CFG_DIR" \
  ANTHROPIC_BASE_URL="https://api.moonshot.ai/anthropic" \
  ANTHROPIC_AUTH_TOKEN="$KIMI_API_KEY" \
  ANTHROPIC_MODEL="${KIMI_MODEL:-kimi-k3}" \
  ANTHROPIC_SMALL_FAST_MODEL="${KIMI_MODEL:-kimi-k3}" \
  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 \
  claude -p --permission-mode acceptEdits "${KIMI_FLAGS[@]}" "$KIMI_PROMPT" < /dev/null
