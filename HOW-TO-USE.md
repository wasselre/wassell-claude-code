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
