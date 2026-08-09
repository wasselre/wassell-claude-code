#!/usr/bin/env bash
#
# bootstrap-session.sh — bring a fresh checkout (cloud sandbox, new worktree,
# new laptop) to a fully working state in one command.
#
#   bash scripts/bootstrap-session.sh
#
# Steps: unseal secrets -> install deps -> install git hooks -> refresh the
# generated model/workflow PRDs -> report what this environment can and
# cannot do.
#
# Every step reports success or failure loudly. A failed step does not abort
# the rest (you still want deps installed even if secrets are unavailable),
# but the final summary is non-zero if anything failed.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

FAILED=0
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { printf '   \033[32mOK\033[0m  %s\n' "$1"; }
bad()  { printf '   \033[31mFAIL\033[0m %s\n' "$1"; FAILED=$((FAILED + 1)); }
skip() { printf '   --  %s\n' "$1"; }

# ── 1. secrets ───────────────────────────────────────────────────────────
step "1/4  Secrets"
if bash scripts/secrets/unseal.sh; then
  ok "secret files restored from secrets/wassel-secrets.enc"
else
  bad "could not unseal secrets — see the error above (usually a missing WASSEL_SECRETS_PASSPHRASE)"
fi

# ── 2. dependencies ──────────────────────────────────────────────────────
step "2/4  Dependencies"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  ok "node_modules already present"
else
  if npm ci --no-audit --no-fund 2>&1 | tail -3; then
    ok "npm ci"
  elif npm install --no-audit --no-fund 2>&1 | tail -3; then
    ok "npm install (fallback — lockfile was out of sync)"
  else
    bad "dependency install failed"
  fi
fi

# ── 3. git hooks ─────────────────────────────────────────────────────────
step "3/4  Git hooks"
if [ -f scripts/install-git-hooks.sh ]; then
  if bash scripts/install-git-hooks.sh >/dev/null 2>&1; then
    ok "pre-push guard installed (refuses pushes from a stale main)"
  else
    bad "install-git-hooks.sh failed"
  fi
else
  skip "scripts/install-git-hooks.sh not present"
fi

# ── 4. generated PRDs ────────────────────────────────────────────────────
step "4/4  Model + workflow PRDs"
if grep -q '"sync:prds"' package.json 2>/dev/null; then
  if npm run --silent sync:prds >/dev/null 2>&1; then
    ok "docs/prd/models + docs/prd/workflows refreshed from the live DB"
  else
    skip "sync:prds did not run (needs Supabase env — harmless if secrets failed above)"
  fi
else
  skip "no sync:prds script in package.json"
fi

# ── optional: flyctl ─────────────────────────────────────────────────────
# OFF by default — installing it costs ~15s on every session, and most
# sessions never deploy the worker. Turn on with WASSEL_BOOTSTRAP_FLYCTL=1.
# Your Fly AUTH always travels in the secrets bundle (~/.fly/config.yml);
# this only fetches the missing binary.
step "Optional  flyctl"
if [ "${WASSEL_BOOTSTRAP_FLYCTL:-0}" = "1" ]; then
  if command -v fly >/dev/null 2>&1 || command -v flyctl >/dev/null 2>&1; then
    ok "fly already installed"
  elif command -v curl >/dev/null 2>&1; then
    # Official Fly.io installer, per https://fly.io/docs/flyctl/install/
    if curl -fsSL https://fly.io/install.sh 2>/dev/null | sh >/dev/null 2>&1; then
      export FLYCTL_INSTALL="${FLYCTL_INSTALL:-$HOME/.fly}"
      export PATH="$FLYCTL_INSTALL/bin:$PATH"
      if command -v flyctl >/dev/null 2>&1; then
        ok "flyctl installed to $FLYCTL_INSTALL/bin (add it to PATH in this shell)"
      else
        bad "flyctl installer ran but the binary is not on PATH"
      fi
    else
      bad "flyctl install failed (network or installer error)"
    fi
  else
    bad "cannot install flyctl — curl is not available"
  fi
else
  skip "not requested (set WASSEL_BOOTSTRAP_FLYCTL=1 to install)"
fi

# ── capability report ────────────────────────────────────────────────────
step "This environment"
have() { command -v "$1" >/dev/null 2>&1 && ok "$1" || skip "$1 — not available here"; }
have node
have npm
have vercel
have fly
have psql
have openssl

printf '\n'
if [ -f .env.local ]; then
  ok ".env.local present ($(grep -cE '^[A-Za-z_]' .env.local 2>/dev/null || echo 0) variables)"
else
  bad ".env.local missing — server-side scripts and api/ will not run"
fi
[ -f "$HOME/.fly/config.yml" ] && ok "Fly auth present (worker deploys possible)" \
                               || skip "no Fly auth — worker deploys unavailable"

cat <<'NOTE'

   Not available in a cloud sandbox, by design:
     - Claude-in-Chrome MCP (drives the real Chrome on the laptop)
     - computer-use MCP
     - the local Browser pane against a dev server on this machine
   Deploy verification that needs a live browser stays a laptop task.
   See docs/cloud-session-setup.md.
NOTE

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32mBootstrap complete — no failures.\033[0m\n'
  exit 0
else
  printf '\033[31mBootstrap finished with %d failed step(s) — see FAIL lines above.\033[0m\n' "$FAILED"
  exit 1
fi
