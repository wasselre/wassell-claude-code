#!/usr/bin/env bash
#
# unseal.sh — decrypt secrets/wassel-secrets.enc back into real files.
#
# Run this in a CLOUD SESSION (or any fresh clone, or a worktree that has no
# .env) to get the exact same secret files the laptop has.
#
#   bash scripts/secrets/unseal.sh            # restore
#   bash scripts/secrets/unseal.sh --check    # verify passphrase only, write nothing
#
# Passphrase resolution (first hit wins):
#   1. $WASSEL_SECRETS_PASSPHRASE   <- set this in the cloud environment
#   2. .secrets-passphrase.local at the repo root (gitignored, laptop only)
#
# `repo:` files land in the CURRENT working tree, so this also fixes the
# "a fresh worktree has no .env" problem. `home:` files land under $HOME.
#
# An existing target whose content differs is backed up to <file>.bak before
# being overwritten — we never destroy a local edit silently.

set -euo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ENC="$REPO_ROOT/secrets/wassel-secrets.enc"

[ -f "$ENC" ] || { echo "ERROR: $ENC not found. Was it committed?" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl not found." >&2; exit 1; }

# ── passphrase ───────────────────────────────────────────────────────────
if [ -z "${WASSEL_SECRETS_PASSPHRASE:-}" ]; then
  # The passphrase file lives in the MAIN working tree — a per-session
  # worktree does not have its own copy, so check both.
  MAIN_TREE="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')"
  [ -n "$MAIN_TREE" ] || MAIN_TREE="$REPO_ROOT"

  PASS_FILE=""
  for candidate in "$REPO_ROOT/.secrets-passphrase.local" "$MAIN_TREE/.secrets-passphrase.local"; do
    if [ -f "$candidate" ]; then PASS_FILE="$candidate"; break; fi
  done

  if [ -n "$PASS_FILE" ]; then
    WASSEL_SECRETS_PASSPHRASE="$(tr -d '\r\n' < "$PASS_FILE")"
    export WASSEL_SECRETS_PASSPHRASE
  else
    echo "ERROR: no passphrase available." >&2
    echo "" >&2
    echo "  In a cloud session: add WASSEL_SECRETS_PASSPHRASE to the" >&2
    echo "  environment's variables/secrets settings." >&2
    echo "  On the laptop: create $MAIN_TREE/.secrets-passphrase.local" >&2
    echo "  (generate one with: bash scripts/secrets/new-passphrase.sh)" >&2
    echo "" >&2
    echo "  See docs/cloud-session-setup.md." >&2
    exit 1
  fi
fi
[ -n "$WASSEL_SECRETS_PASSPHRASE" ] || { echo "ERROR: passphrase is empty." >&2; exit 1; }

# ── decrypt ──────────────────────────────────────────────────────────────
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
      -in "$ENC" -out "$STAGE/bundle.tar.gz" \
      -pass env:WASSEL_SECRETS_PASSPHRASE 2>"$STAGE/err"; then
  echo "ERROR: decryption failed — the passphrase is wrong, or the bundle is corrupt." >&2
  sed 's/^/  openssl: /' "$STAGE/err" >&2 || true
  exit 1
fi

tar -xzf "$STAGE/bundle.tar.gz" -C "$STAGE"

if [ "$CHECK_ONLY" -eq 1 ]; then
  n="$(find "$STAGE/repo" "$STAGE/home" -type f 2>/dev/null | wc -l | tr -d ' ')"
  echo "OK: passphrase is correct; bundle decrypts to $n file(s). Nothing written (--check)."
  exit 0
fi

# ── restore ──────────────────────────────────────────────────────────────
restored=0
backed_up=0

restore_tree() {
  local root="$1" base="$2"
  [ -d "$STAGE/$root" ] || return 0
  while IFS= read -r src; do
    local rel="${src#"$STAGE/$root/"}"
    local dest="$base/$rel"
    mkdir -p "$(dirname "$dest")"
    if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
      cp "$dest" "$dest.bak"
      echo "  backed up existing -> $dest.bak"
      backed_up=$((backed_up + 1))
    fi
    cp "$src" "$dest"
    chmod 600 "$dest" 2>/dev/null || true
    echo "  restored $dest"
    restored=$((restored + 1))
  done < <(find "$STAGE/$root" -type f)
}

restore_tree repo "$REPO_ROOT"
restore_tree home "$HOME"

[ "$restored" -gt 0 ] || { echo "ERROR: bundle decrypted but contained no files." >&2; exit 1; }

echo
echo "Unsealed $restored file(s)."
[ "$backed_up" -eq 0 ] || echo "$backed_up pre-existing file(s) were backed up to *.bak."
