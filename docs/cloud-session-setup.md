# Cloud session setup

**Goal:** a Claude session running in a cloud sandbox has the same files, the
same environment variables, and the same values as the laptop — and can start
and finish a piece of work without anyone hand-feeding it credentials.

**Last updated:** 2026-08-09

---

## One-time setup (already done, recorded here so it can be redone)

1. A passphrase was generated with `bash scripts/secrets/new-passphrase.sh`.
   It lives at `.secrets-passphrase.local` in the main working tree
   (gitignored) and should also be in the password manager.
2. `bash scripts/secrets/seal.sh` encrypted every secret file into
   `secrets/wassel-secrets.enc`, which **is committed**.
3. Brand assets and the user-level Claude skills were moved into the repo so
   they travel with a clone.

## What you do once per cloud environment

Add exactly one variable to the cloud environment's variables/secrets settings:

```
WASSEL_SECRETS_PASSPHRASE = <the value in .secrets-passphrase.local>
```

That is the whole manual step. Everything else the session does itself.

## What the session does on start

```bash
bash scripts/bootstrap-session.sh
```

It unseals the secrets, installs dependencies, installs the pre-push guard,
refreshes the generated model/workflow PRDs, and prints a capability report.
It exits non-zero if any step failed, and says which.

### The environment's Setup script field

Paste this — **not** a bare `bash scripts/bootstrap-session.sh`:

```bash
#!/bin/bash
# Never exits non-zero: a failing setup script BLOCKS the session from starting.
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/scripts/bootstrap-session.sh" ]; then
  FOUND="$(find "$HOME" /workspace /repo /app -maxdepth 4 -type f \
             -path '*/scripts/bootstrap-session.sh' 2>/dev/null | head -1)"
  [ -n "$FOUND" ] && ROOT="${FOUND%/scripts/bootstrap-session.sh}"
fi

if [ -n "${ROOT:-}" ] && [ -f "$ROOT/scripts/bootstrap-session.sh" ]; then
  echo "[setup] repo root: $ROOT"
  cd "$ROOT" || exit 0
  bash scripts/bootstrap-session.sh || echo "[setup] bootstrap reported failures (see above) — continuing so the session still starts"
else
  echo "[setup] scripts/bootstrap-session.sh not found. cwd=$PWD"
  echo "[setup] This branch probably predates it (added on main at f165668a)."
  echo "[setup] In the session run:  git fetch origin main && git rebase origin/main && bash scripts/bootstrap-session.sh"
  [ -f package.json ] && npm install --no-audit --no-fund
fi

exit 0
```

Two failure modes this exists to survive, both hit live on 2026-08-09:

1. **The setup script's working directory is not guaranteed to be the repo
   root.** A bare relative path gives `exit 127 — No such file or directory`.
2. **A cloud session started on an older branch has no bootstrap script at
   all**, because the branch predates it. Hard-failing there means the session
   never starts — you get an "An API error occurred" card instead of a usable
   session. The fallback prints the rebase command and installs deps instead.

**Start cloud sessions from `main`** (or rebase inside them) so the bundle and
scripts are present.

---

## Why the bundle is safe in a public repo

`github.com/wasselre/wassell-claude-code` is **public**. `wassel-secrets.enc`
is AES-256-CBC with PBKDF2 at 600,000 iterations over a 256-bit random
passphrase. What is public is ciphertext plus `secrets/MANIFEST.md`, which
lists variable *names* only, never values.

The consequences of that design, stated plainly:

- **Plaintext secrets must never be committed.** The `.gitignore` blocks
  `.env`, `.env.local`, `*.local`, and `.secrets-passphrase.local`. Do not add
  exceptions.
- **The passphrase is the whole security boundary.** If it leaks, re-run
  `new-passphrase.sh --force`, re-seal, update the cloud env — and rotate the
  underlying keys, because the old ciphertext is permanently in git history.
- **Rotating a secret means re-sealing.** Editing `.env.local` on the laptop
  does not update the bundle until you run `seal.sh` and commit.

## Changing a secret

```bash
# 1. edit .env.local (or whichever file) on the laptop as usual
# 2. re-encrypt
bash scripts/secrets/seal.sh
# 3. commit both outputs
git add secrets/wassel-secrets.enc secrets/MANIFEST.md
git commit -m "chore(secrets): re-seal bundle"
```

Adding a whole new secret *file* means adding a line to
`scripts/secrets/files.list` first.

## Verifying without writing anything

```bash
bash scripts/secrets/unseal.sh --check
```

Confirms the passphrase decrypts the bundle and reports the file count. Writes
nothing. Use this to test a cloud environment's variable before relying on it.

---

## What travels, and what still cannot

| Travels with a clone | Notes |
|---|---|
| All app source, migrations, PRDs, `CLAUDE.md` | normal git contents |
| `.env`, `.env.local`, `.deploy-secrets.local`, `~/.fly/config.yml` | via the encrypted bundle |
| `~/.kimi.env.local` (`KIMI_API_KEY`) | via the bundle; `kimi-code.sh` falls back to `$HOME`. Works in the cloud only since the 2026-08-09 env-strip fix — see below |
| `Wassel Branding/` (16 PNGs, 11 MB) | un-gitignored; deck skills need it |
| Deck + research skills, `wassel-builder` agent, `/wassel` command | mirrored from `~/.claude` into `.claude/` |

### Kimi in a cloud session (fixed 2026-08-09)

`scripts/kimi-code.sh` works in a cloud container, but only because it now
clears the inherited provider environment before launching the coder.

A cloud session's harness **pins the model provider itself**: it exports
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, passes auth over
`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, and sets ~80 other
`CLAUDE_*` / `ANTHROPIC_*` variables. A subprocess INHERITS all of it, and it
outranks the Kimi credentials — so the child `claude -p` died on
`Authentication error` even though the key was fine (a direct `curl` to
`api.moonshot.ai` returned 200). `CLAUDE_CONFIG_DIR` does not save you: it
isolates the on-disk config, not the environment.

Measured while fixing it — none of the obvious narrow fixes work:

| Attempt | Result |
|---|---|
| Swap `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` | fails |
| Unset `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` only | fails |
| Unset `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` only | fails |
| Unset both (± `CLAUDE_CODE_USE_CCR_V2`) | fails |
| **Strip the whole inherited `CLAUDE*`/`ANTHROPIC*` surface** | **works** |

So the script builds an `env -u` list over every inherited `CLAUDE*`/`ANTHROPIC*`
name and re-sets only the four Kimi variables. On a laptop the loop finds
nothing and costs nothing. It also redirects stdin from `/dev/null`, because a
headless run otherwise waits ~3 s for piped input that never arrives.

Two things to expect when driving it from a session:

- **`claude -p` buffers its entire answer until it exits** — a background run
  shows 0 bytes of output until it finishes. That is normal, not a hang; check
  the process, not the file.
- **A multi-file review can exceed 10 minutes.** The Bash tool caps a
  foreground call at 600 s, so run longer Kimi jobs in the background and give
  the `timeout` wrapper real headroom.

### CLIs a sandbox does not have

A cloud container ships `node`, `npm`, `psql`, `openssl` — but **not** the
`vercel` or `fly` CLIs (verified in a live session, 2026-08-09).

- **Vercel** — irrelevant. You deploy by pushing to `main`; the Vercel MCP
  confirms `READY`. The CLI was never in that path.
- **Fly** — needed for worker deploys. Your Fly *auth* always travels in the
  bundle; only the binary is absent. Install it on demand:

  ```bash
  WASSEL_BOOTSTRAP_FLYCTL=1 bash scripts/bootstrap-session.sh
  ```

  Off by default so the ~15s install does not tax every session. After it runs,
  add `$HOME/.fly/bin` to `PATH` in that shell.

**Still laptop-only, by nature:**

- **Claude-in-Chrome MCP** — drives the real Chrome on the laptop. The
  post-deploy smoke test on `app.wassel.re` in `CLAUDE.md` needs this, so
  deploy verification stays a laptop task.
- **computer-use MCP** and the local Browser pane against a dev server.
- **`Wassel Website`** — 218 MB, its own git repo at
  `C:/Users/rayan/Claude/Wassel Website` with **no remote**. A cloud session
  cannot see it. It also has no off-machine backup at all; giving it a private
  GitHub remote fixes both problems at once.

Network-based MCPs (Supabase, Vercel) work fine in the cloud once authorized
there.

---

## Worktrees get this for free

A freshly created worktree has never had a `.env` — a long-standing annoyance
that made `npm run sync:prds` and every server-side script fail there. Running
`bash scripts/secrets/unseal.sh` inside a worktree restores the secret files
into that worktree. The passphrase is read from the main tree automatically.

## Coming back from the cloud

Work done in the cloud lands on GitHub, not on the laptop. Before picking a
task back up locally:

```bash
git fetch origin main
git rebase origin/main
```

The pre-push hook (`scripts/safe-push-main.sh`) refuses a push whose tip is not
on top of `origin/main`, which is the safety net for exactly this.
