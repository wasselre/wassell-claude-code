#!/usr/bin/env bash
#
# new-passphrase.sh — generate the one passphrase that protects the bundle.
#
#   bash scripts/secrets/new-passphrase.sh
#
# Writes it to .secrets-passphrase.local (gitignored) and prints it ONCE so
# you can paste it into the cloud environment's variable settings as
# WASSEL_SECRETS_PASSPHRASE.
#
# Refuses to clobber an existing passphrase file — rotating means re-sealing
# the bundle, so that has to be deliberate (pass --force).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
MAIN_TREE="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')"
[ -n "$MAIN_TREE" ] || MAIN_TREE="$REPO_ROOT"
PASS_FILE="$MAIN_TREE/.secrets-passphrase.local"

if [ -f "$PASS_FILE" ] && [ "${1:-}" != "--force" ]; then
  echo "A passphrase already exists at:"
  echo "  $PASS_FILE"
  echo
  echo "Reuse it. To rotate deliberately: re-run with --force, then"
  echo "re-run seal.sh and update WASSEL_SECRETS_PASSPHRASE in the cloud env."
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl not found." >&2; exit 1; }

# 32 random bytes, base64 -> ~43 chars of high-entropy passphrase.
PASS="$(openssl rand -base64 32 | tr -d '\n')"
printf '%s\n' "$PASS" > "$PASS_FILE"
chmod 600 "$PASS_FILE" 2>/dev/null || true

echo "Passphrase generated and saved to:"
echo "  $PASS_FILE   (gitignored — never committed)"
echo
echo "Add this to your cloud environment as WASSEL_SECRETS_PASSPHRASE:"
echo
echo "    $PASS"
echo
echo "This is the ONLY thing a cloud session needs from you. Store a copy in"
echo "your password manager — if you lose it, the bundle cannot be decrypted"
echo "and you re-seal from the laptop."
