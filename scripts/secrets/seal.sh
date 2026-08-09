#!/usr/bin/env bash
#
# seal.sh — encrypt the local secret files into secrets/wassel-secrets.enc
#
# Run this ON THE LAPTOP whenever a secret changes. The output is safe to
# commit to a PUBLIC repo: AES-256-CBC with PBKDF2 (600k iterations) over a
# passphrase that never leaves your machine or the cloud env settings.
#
#   bash scripts/secrets/seal.sh
#
# Passphrase resolution (first hit wins):
#   1. $WASSEL_SECRETS_PASSPHRASE
#   2. .secrets-passphrase.local at the repo root (gitignored)
#
# Sealing also regenerates secrets/MANIFEST.md — a committed, plaintext
# inventory of WHICH files and WHICH variable names are in the bundle
# (never values), so the bundle's contents are auditable without the key.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"

# Secrets live in the MAIN working tree, not in per-session worktrees.
MAIN_TREE="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')"
[ -n "$MAIN_TREE" ] || MAIN_TREE="$REPO_ROOT"

LIST="$SCRIPT_DIR/files.list"
OUT_DIR="$REPO_ROOT/secrets"
OUT_ENC="$OUT_DIR/wassel-secrets.enc"
MANIFEST="$OUT_DIR/MANIFEST.md"

# ── passphrase ───────────────────────────────────────────────────────────
if [ -z "${WASSEL_SECRETS_PASSPHRASE:-}" ]; then
  PASS_FILE="$MAIN_TREE/.secrets-passphrase.local"
  if [ -f "$PASS_FILE" ]; then
    WASSEL_SECRETS_PASSPHRASE="$(tr -d '\r\n' < "$PASS_FILE")"
    export WASSEL_SECRETS_PASSPHRASE
  else
    echo "ERROR: no passphrase." >&2
    echo "  Set \$WASSEL_SECRETS_PASSPHRASE, or create $PASS_FILE" >&2
    echo "  Generate one with: bash scripts/secrets/new-passphrase.sh" >&2
    exit 1
  fi
fi
[ -n "$WASSEL_SECRETS_PASSPHRASE" ] || { echo "ERROR: passphrase is empty." >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || { echo "ERROR: openssl not found." >&2; exit 1; }

# ── stage the files ──────────────────────────────────────────────────────
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

found=0
missing=0
declare -a INCLUDED=()

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac
  root="${line%%:*}"
  rel="${line#*:}"

  case "$root" in
    repo) src="$MAIN_TREE/$rel" ;;
    home) src="$HOME/$rel" ;;
    *) echo "WARN: unknown root '$root' in files.list — skipping '$line'" >&2; continue ;;
  esac

  if [ ! -f "$src" ]; then
    echo "WARN: missing, not sealed: $root:$rel" >&2
    missing=$((missing + 1))
    continue
  fi

  dest="$STAGE/$root/$rel"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  INCLUDED+=("$root:$rel")
  found=$((found + 1))
done < "$LIST"

[ "$found" -gt 0 ] || { echo "ERROR: nothing to seal — every file in files.list is missing." >&2; exit 1; }

# ── encrypt ──────────────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
tar -C "$STAGE" -czf "$STAGE/bundle.tar.gz" repo home 2>/dev/null || \
  tar -C "$STAGE" -czf "$STAGE/bundle.tar.gz" .

openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "$STAGE/bundle.tar.gz" -out "$OUT_ENC" \
  -pass env:WASSEL_SECRETS_PASSPHRASE

# ── manifest (names only, never values) ──────────────────────────────────
{
  echo "# Encrypted secrets bundle — inventory"
  echo
  echo "\`secrets/wassel-secrets.enc\` is AES-256-CBC (PBKDF2, 600k iterations)."
  echo "This file lists WHAT is inside it. **Values are never recorded here.**"
  echo
  echo "Regenerate both with \`bash scripts/secrets/seal.sh\`. Do not hand-edit."
  echo
  echo "## Files in the bundle"
  echo
  echo "| Restored to | Source |"
  echo "|---|---|"
  for entry in "${INCLUDED[@]}"; do
    r="${entry%%:*}"; p="${entry#*:}"
    if [ "$r" = "repo" ]; then
      echo "| \`<repo root>/$p\` | working tree |"
    else
      echo "| \`\$HOME/$p\` | home directory |"
    fi
  done
  echo
  echo "## Variable names carried"
  echo
  for entry in "${INCLUDED[@]}"; do
    r="${entry%%:*}"; p="${entry#*:}"
    case "$p" in
      *.env|.env|.env.local|*.local)
        names="$(grep -ohE '^[A-Za-z_][A-Za-z0-9_]*=' "$STAGE/$r/$p" 2>/dev/null | tr -d '=' | sort -u || true)"
        if [ -n "$names" ]; then
          echo "### \`$p\`"
          echo
          echo "$names" | sed 's/^/- `/; s/$/`/'
          echo
        fi
        ;;
      *)
        echo "### \`$p\`"
        echo
        echo "- (non-dotenv file — structure not enumerated)"
        echo
        ;;
    esac
  done
} > "$MANIFEST"

size="$(wc -c < "$OUT_ENC" | tr -d ' ')"
echo "Sealed $found file(s) into secrets/wassel-secrets.enc (${size} bytes)."
[ "$missing" -eq 0 ] || echo "  $missing listed file(s) were missing — see warnings above."
echo "Manifest written to secrets/MANIFEST.md."
echo
echo "Next: commit secrets/wassel-secrets.enc and secrets/MANIFEST.md."
