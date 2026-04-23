# Wassell CRM — Claude Code Project Guide

## How This Project Is Organized

```
wassell-crm/
│
├── CLAUDE.md                    ← Project memory (Claude reads this every session)
│
├── agents/                      ← One task file per build phase
│   ├── phase-1-foundation.md
│   ├── phase-2-model-builder.md
│   ├── phase-3-record-views.md
│   ├── phase-4-workflow.md
│   ├── phase-5-dashboards.md
│   └── phase-6-7-pdf-polish.md
│
└── wassell-crm-prompt.md        ← Full system spec (reference document)
```

---

## How to Use With Claude Code

### Step 1 — Open Claude Code in your project folder
```bash
cd wassell-crm
claude
```

### Step 2 — Run phases one at a time

For each phase, paste this command into Claude Code:

```
Read CLAUDE.md first, then read agents/phase-1-foundation.md and complete all tasks in it.
```

Wait for it to finish. Then move to the next phase:

```
Read CLAUDE.md first, then read agents/phase-2-model-builder.md and complete all tasks in it.
```

Continue until all 7 phases are done.

### Step 3 — If something goes wrong mid-phase

Tell Claude Code:
```
Read CLAUDE.md. We were in the middle of phase-2-model-builder.md.
The ModelEditor component was working but FieldEditor is not complete yet.
Continue from the FieldEditor component.
```

CLAUDE.md gives Claude Code the context it needs to resume correctly.

---

## Why This Structure Works

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Persistent memory — Claude Code reads this automatically at the start of every session. Contains architecture rules, conventions, and current build status. |
| `agents/phase-N.md` | Focused task instructions — tells Claude Code exactly what to build in each session, with clear deliverables and a stop point. |
| `wassell-crm-prompt.md` | Full spec — the complete system description. Used as a reference when Claude Code needs more detail. |

---

## The Build Order

```
Phase 1 → Foundation       (types, store, layout, routing, seed data)
Phase 2 → Model Builder    (the most critical feature — build this carefully)
Phase 3 → Record Views     (list page, form page, table, cards, dynamic fields)
Phase 4 → Workflow Engine  (builder UI + execution logic)
Phase 5 → Dashboards       (widget builder + public links)
Phase 6 → PDF Generation   (Projects Research export)
Phase 7 → Polish           (home page, toasts, skeletons, empty states, RTL audit)
```

Phases 4 and 5 can run in parallel if needed (they don't depend on each other).

---

## Tips for Working With Claude Code on This Project

1. **Always start a new session with:** "Read CLAUDE.md first"
2. **One phase per session** — don't try to build multiple phases at once
3. **After each phase**, ask Claude Code to update the build status in CLAUDE.md
4. **If a component gets complex**, create a sub-task:
   "Focus only on the FieldEditor component from phase-2-model-builder.md"
5. **If you want to change something** (add a field type, change a color), update CLAUDE.md first — then tell Claude Code to use the updated spec

---

## Asking Claude Code to Fix or Extend

Once the app is built, you can ask Claude Code to make changes like:

- "Read CLAUDE.md. Add a new field type called 'rating' (1–5 stars) to the builder."
- "Read CLAUDE.md. Add an export to Excel button on the table view for every model."
- "Read CLAUDE.md. Add a new system model called 'Teams' with these fields: [...]"

Because CLAUDE.md contains the full architecture, Claude Code will make changes that are consistent with the rest of the system.

---

## Running the Presentations daemon

The Presentations feature (deck generation from the `/presentations` page) needs a small background process running on your machine to actually produce decks. The web app only queues jobs; the daemon spawns Claude Code for each one.

### First-time setup

```bash
cd daemon
cp .env.example .env
# Edit daemon/.env — fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
# (find them in the Supabase dashboard → Project Settings → API)
npm install
npm run smoke    # sanity-check env + Supabase + templates
```

### Daily use

```bash
cd daemon
npm start
```

Leave that terminal open. The "daemon not running" banner in the app disappears within 15 seconds of the daemon starting. Queued jobs are picked up within 5 seconds of being inserted. Stop with `Ctrl+C`.

### Adding a new deck template

The fastest path is the `template-scaffolder` skill — ask Claude Code:

> Scaffold a template called `monthly-report` for monthly market reports.

It generates the command file, the manifest, and a skill stub with the sentinel contract pre-wired. Fill in the TODOs, and the daemon syncs the new template into the app within a second — no app redeploy.

If you prefer to author by hand:

1. In Claude Code, author a new slash command + skill + build script for the new deck type (same pattern as `~/.claude/commands/wassel.md` + `~/.claude/skills/wassel-presentation/`).
2. Drop a manifest file at `~/.claude/ppt/templates/<slug>/template.json` (copy `wassel/template.json` as a starting point and change `id` to a fresh UUID, `slug`, `command`, etc.).
3. End the command with a `###PRESENTATION-RESULT###{...}` line (see `~/.claude/commands/wassel.md` § 5 for the exact contract).
4. The file watcher syncs within a second — the new template shows up in the app picker without a redeploy.

### Optional: daemon as a Windows service

If you'd rather not keep a terminal open running `npm start`, the daemon can register as a Windows service:

```bash
cd daemon
npm install node-windows
node scripts/install-service.mjs
```

Important: the default LocalSystem account can't see your Chrome profile (which Paseetah needs). Edit `scripts/install-service.mjs` to set `svc.user` + `svc.password` to your Windows account before installing. To remove: `node scripts/uninstall-service.mjs`.

More detail in `daemon/README.md`.
