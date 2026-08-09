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
| `Wassel Branding/` (16 PNGs, 11 MB) | un-gitignored; deck skills need it |
| Deck + research skills, `wassel-builder` agent, `/wassel` command | mirrored from `~/.claude` into `.claude/` |

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
