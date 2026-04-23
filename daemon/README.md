# Wassell Presentations Daemon

Local background worker that turns "click Generate in the app" into a finished Drive deck.

The web app inserts rows into the `presentation_jobs` Supabase table with `status='queued'`. This daemon polls that table, spawns `claude --print <slash-command>` for each queued row, parses a sentinel line from the CLI's stdout, and writes the Drive URL back to the row. The app polls and shows the link.

See `docs/prd/presentations.md` (in the repo root) for the wider design.

## Why it runs locally

Every dependency of the deck pipeline lives on your machine:

- Claude-in-Chrome MCP — reads your paseet.ai session.
- Google Drive Connectors MCP — uploads with your Google account.
- Python + python-pptx, the Amiri font, `~/.claude/commands/wassel.md`, `~/.claude/skills/wassel-presentation/scripts/build_deck.py`.

Running the daemon in a cloud worker would mean rebuilding all of that (headless Playwright + stored cookies + containerized Python + …). Running it locally reuses every moving part verbatim.

## Prerequisites

- **Node.js 20+** on PATH.
- **Claude Code CLI** on PATH, or an absolute path you can point `CLAUDE_BIN` at. Verify with `claude --version`.
- Access to the Supabase project that the frontend uses, with its **service-role key** (Project Settings → API). Treat this key like a password — don't commit it, don't paste it in chat.
- The Presentations tables (`presentation_templates`, `presentation_jobs`, `daemon_status`) and the `claim_next_presentation_job` RPC must already exist in Supabase. Run `supabase/schema.sql` if they don't.

## First-run setup

```bash
cd daemon
cp .env.example .env
# edit daemon/.env — paste SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
```

## Run the smoke test before queuing a real job

```bash
npm run smoke
```

Confirms: env loads, Supabase is reachable, template manifests sync from `~/.claude/ppt/templates/`, a heartbeat row is written, the claim RPC is callable. If any step fails, the daemon is not yet ready to process real jobs.

## Start the daemon

```bash
npm start
```

You should see:

```
[daemon] starting v0.1.0 as <hostname>:<pid>
[daemon] templates dir: C:\Users\rayan\.claude\ppt\templates
[daemon] poll=5000ms heartbeat=15000ms timeout=1800s
[daemon] swept 0 stale 'running' job(s) from a previous crash
[daemon] initial template sync: synced=1 invalid=0 disabled=0
```

Within 15 seconds the "Presentations daemon is not running" banner disappears in the app.

Leave the process running. Queued jobs are picked up within `POLL_INTERVAL_MS` of insertion.

## What happens when a job is claimed

1. `claim_next_presentation_job` atomically moves one `queued` row to `running` and stamps `claimed_by=<hostname>:<pid>`. Two daemons racing never pick the same row (SKIP LOCKED).
2. The daemon spawns `claude --print --permission-mode bypassPermissions --output-format text "<template.command> <brief>"`.
3. stdout is tailed: any `###PRESENTATION-PROGRESS###{...}` line updates the job's `progress_stage`/`progress_message_*` in real time. The app's polling picks it up and the user sees live status.
4. The CLI prints `###PRESENTATION-RESULT###{...}` just before exiting; the daemon parses the JSON and flips the row to `completed` (or `failed`, with a classified `error_code`).
5. Drive URLs go into `drive_deck_url` / `drive_folder_url` — the app renders them as clickable links.

## Concurrency

The daemon runs **one job at a time**. The Paseetah step drives a real Chrome window — concurrent runs would thrash the same tab. A queued job behind a running one waits until the running one finishes.

## Crash recovery

On startup the daemon sweeps its own stale `running` rows (claimed_by matches this host+pid) and flips them to `failed` with `error_code='daemon_restarted'`. We never auto-resume because `/wassel` creates Drive folders and resuming mid-run would duplicate them. The user retries from the app's detail page.

## Environment variables

See `.env.example`. The non-obvious knobs:

- `POLL_INTERVAL_MS` (default 5000) — how often to check the queue when idle. Lower = snappier but more DB reads.
- `HEARTBEAT_INTERVAL_MS` (default 15000) — how often to bump `daemon_status.last_heartbeat_at`. Must stay < 60s; the app treats > 60s as offline.
- `JOB_TIMEOUT_SECONDS` (default 1800 = 30 min) — max wall-clock per job. A run that exceeds this is SIGTERM'd then SIGKILL'd, and the job fails with `error_code='timeout'`.
- `TEMPLATES_DIR` (default `~/.claude/ppt/templates`) — where the daemon watches for `<slug>/template.json` manifests.

## Adding a new template

1. In Claude Code: author a new slash command and (usually) a new skill that implements the research + build pipeline for this deck type.
2. Create `~/.claude/ppt/templates/<slug>/template.json` — copy `wassel/template.json` as a starting point. Required fields: `id` (generate a UUID — never reuse one from another template), `slug`, `label_ar`, `label_en`, `command`, `inputs`.
3. Ensure the command emits the `###PRESENTATION-RESULT###` sentinel at the end. Copy the structure from `~/.claude/commands/wassel.md` § 5.
4. Save the manifest — the daemon's file watcher upserts the row within a second. The new template appears in the app picker with no app redeploy.

## Logs

The daemon writes a daily log file to `daemon/logs/daemon-YYYY-MM-DD.log` in addition to stdout. Files older than 7 days are deleted on boot. Override the location by setting `LOG_DIR` in `.env` (absolute path or relative to the daemon folder).

`tail -f daemon/logs/daemon-$(date +%Y-%m-%d).log` is the fastest way to watch live activity when the daemon is running as a service and you can't see its stdout directly.

## Optional: run as a Windows service

For a daemon that starts on login and auto-restarts on crash, you can wrap it as a Windows service using `node-windows`. This is opt-in — most users can stick with `npm start` in a terminal.

```bash
npm install node-windows      # one-time
node scripts/install-service.mjs
```

The service runs as **LocalSystem by default, which can't see your Chrome profile**. For the Presentations pipeline to work (Paseetah needs your Chrome session), edit `scripts/install-service.mjs` and set `svc.user` + `svc.password` to your own Windows account before installing. Alternatively, keep running `npm start` as your interactive user — the service path is for when you don't want to manage the terminal window.

To uninstall:

```bash
node scripts/uninstall-service.mjs
```

If the service fails to start, check the Windows Event Viewer under "Applications and Services Logs → wassellpresentationsdaemon" as well as `daemon/logs/` for hints.

## Authoring new templates quickly

Ask Claude Code: *"Scaffold a template called monthly-report for monthly market reports."* The `template-scaffolder` skill will create `~/.claude/commands/monthly-report.md`, `~/.claude/ppt/templates/monthly-report/template.json`, and `~/.claude/skills/monthly-report-presentation/SKILL.md` with the sentinel contract pre-wired. Fill in the TODOs, and the daemon's file-watcher syncs the new template into Supabase within a second — no app redeploy.

## Gotchas

- **Service-role key in `.env`.** Never check it in. `daemon/.gitignore` excludes `.env` but double-check.
- **First run with no templates.** If `~/.claude/ppt/templates/` doesn't exist, the daemon logs a warning and keeps running — the seeded row in `src/data/seedPresentationTemplates.ts` covers the app until a real manifest lands.
- **Claude Code ANSI output.** `--output-format text` already strips most control codes, but if you see garbled sentinel parsing, that's the likely culprit.
- **Long-running Chrome sessions.** If paseet.ai signs you out mid-day, the template's Paseetah step will stop and ask the user to re-auth. The daemon classifies this as `error_code='chrome_session_expired'` and surfaces a bilingual retry prompt in the app.

## Known limitations

- **Running-job cancel from the app.** Only `queued` jobs can be canceled. Killing a mid-Paseetah or mid-Drive-upload run leaves orphan state; don't do it without a cleanup story.
- **Single-machine only.** Multi-user / shared-queue scenarios need a lightweight auth layer between app and daemon (service-role key is currently on ONE machine).
- **systemd / launchd wrappers** for macOS and Linux aren't in the box. Installing `node-windows` only covers Windows. PRs welcome.
