---
name: template-scaffolder
description: Scaffold a new Presentations template for the Wassell CRM. Produces the three files a template needs — a slash command, a manifest (template.json), and a skill stub — wired to the daemon's result sentinel contract so the new template is pickable in the app as soon as the daemon syncs. Use this whenever the user says "scaffold a template", "create a deck template", "add a presentation template", or asks to register a new deck type in the app. Requires a slug (e.g. 'study', 'monthly-report'), a human title, and a one-line description; will ask for anything missing.
---

# Template Scaffolder

Creates a fresh Presentations template that the `wassell-presentations-daemon` can run and the CRM web app can pick. A template is three files that live together:

1. `~/.claude/commands/<slug>.md` — the slash command the daemon invokes (`/slug`).
2. `~/.claude/ppt/templates/<slug>/template.json` — the manifest the daemon syncs into the `presentation_templates` Supabase table.
3. `~/.claude/skills/<slug>-presentation/SKILL.md` — a placeholder skill for the research + build logic (user fills in over time; scaffolder just stubs it).

---

## What you need from the user

Gather these before generating anything. Ask one prompt that covers all of them so you don't ping-pong:

- **`slug`** — kebab-case, e.g. `study`, `monthly-report`, `client-proposal`. No spaces, ASCII only. Used as the folder name, the command name (prefix with `/`), and the `slug` field in the manifest.
- **`label_ar`** — Arabic display title (e.g. "دراسة سوقية").
- **`label_en`** — English display title (e.g. "Market Study").
- **`description_ar`** + **`description_en`** — one-sentence each. Renders on the template picker card.
- **`record_binding`** — optional. If the template is tied to a CRM model (e.g. `targeted_projects`), ask for the model's slug. If not, leave it null — the template shows up globally on `/presentations` with no record binding.
- **`inputs`** — the user fields the form should collect. Common case: one `project_brief` textarea, like the Wassel template. Expand later.

Do **not** invent values. If the user hasn't given you one of the above, ask — half-wrong templates are harder to fix than templates that stall on a question.

Generate a fresh UUID for the template's `id` — never reuse the Wassel id (`00000000-0000-4000-8000-000000000100`) or any other existing template's id. Use a Node one-liner (`node -e "console.log(crypto.randomUUID())"`) or ask Claude for a UUID directly.

---

## What you write

### 1. `~/.claude/commands/<slug>.md`

Start from this scaffold. Replace everything inside `<<<...>>>` with the template's specifics, then delete the placeholders. The **Step N** progress sentinels and the **final result sentinel at Step 4** are **mandatory** — the daemon parses them and fails the job if the result sentinel is missing.

```markdown
---
description: <<<one-line command description — shows up in the slash menu>>>
argument-hint: <<<hint shown to users typing the command; copy from wassel.md if you're building a deck>>>
---

Run the <<<Label>>> deck pipeline for this input.

**Brief:** $ARGUMENTS

## Step 1 — <<<first stage — e.g. gather source data>>>

**Progress signal.** Before starting this step, print this exact line on its own:

```
###PRESENTATION-PROGRESS###{"stage":"<<<stage slug — e.g. paseetah, research, etc.>>>","message_ar":"<<<Arabic status>>>","message_en":"<<<English status>>>"}
```

<<<Describe what this step does. Reference skills it invokes. Keep step boundaries sharp so progress sentinels line up.>>>

---

## Step 2 — <<<second stage>>>

**Progress signal.** Print this exact line:

```
###PRESENTATION-PROGRESS###{"stage":"<<<next stage slug>>>","message_ar":"<<<Arabic>>>","message_en":"<<<English>>>"}
```

<<<Work description>>>

---

## Step 3 — <<<upload / finalization>>>

**Progress signal.** Print this exact line:

```
###PRESENTATION-PROGRESS###{"stage":"upload","message_ar":"جاري الرفع","message_en":"Uploading"}
```

<<<Upload / delivery steps.>>>

---

## Step 4 — Emit the result sentinel

After the user-facing summary above, print **exactly one additional line** at the very end:

###PRESENTATION-RESULT###{"ok":true,"drive_folder_url":"<folder URL or null>","drive_deck_url":"<deck URL or null>","drive_sheet_url":"<sheet URL or null>","warnings":["..."]}

Rules:
- `ok: true` only when the deliverable was produced and uploaded. Use `ok: false` on any failure, with a short reason in `warnings[0]`.
- When Drive upload fails but the file exists locally: set `ok: true`, all drive_* fields to `null`, and include `"local_paths": {"deck": "C:/path/to/file.ext", "sheet": "C:/path/to/sheet.csv"}`. The app renders these as copyable paths.
- Optional `"research_stats": {"filled": N, "total": M, "gaps": N, "conflicts": N}` — the app shows it as a footnote.

This line is parsed by `daemon/src/runner.ts`. Do NOT vary the prefix. Do NOT wrap it in a code fence. Do NOT print anything after it.
```

Copy `~/.claude/commands/wassel.md` as a concrete reference if you get stuck.

### 2. `~/.claude/ppt/templates/<slug>/template.json`

```json
{
  "id": "<<<fresh UUID — NEVER reuse>>>",
  "slug": "<<<slug>>>",
  "label_ar": "<<<Arabic title>>>",
  "label_en": "<<<English title>>>",
  "description_ar": "<<<Arabic one-liner>>>",
  "description_en": "<<<English one-liner>>>",
  "command": "/<<<slug>>>",
  "icon": "<<<Lucide icon name — e.g. file-text, building-2, bar-chart-3>>>",
  "inputs": [
    {
      "name": "project_brief",
      "label_ar": "ملخص المشروع",
      "label_en": "Project brief",
      "type": "textarea",
      "required": true,
      "source": "user",
      "placeholder_ar": "<<<Arabic placeholder>>>",
      "placeholder_en": "<<<English placeholder>>>"
    }
  ],
  "record_binding": {
    "model_slug": "<<<CRM model slug, or delete this whole key for no binding>>>",
    "optional": true
  },
  "estimated_duration_seconds": 900
}
```

Icon names map to Lucide React icons and must also be registered in `src/components/layout/Sidebar.tsx`'s `ICON_MAP`. Stick to ones already in that map (`file-text`, `building-2`, `bar-chart-3`, `users`, etc.) unless you're also planning to register a new one.

### 3. `~/.claude/skills/<slug>-presentation/SKILL.md`

```markdown
---
name: <<<slug>>>-presentation
description: <<<Skill description — used by Claude's skill discovery. Reference the slash command and reserved for its pipeline. Reuse the wassel-presentation description as a template and adapt.>>>
---

# <<<Label>>> — Presentation Builder

Placeholder skill for the `/<<<slug>>>` command. The command in `~/.claude/commands/<<<slug>>>.md` invokes this skill (or calls tools directly). Fill in:

- Research: what data sources, in what order. Keep Paseetah / web-research / CRM record-data steps distinct.
- Build: which Python / deck builder to call. Reference `~/.claude/skills/wassel-presentation/scripts/build_deck.py` as a starting point if you need an Arabic RTL deck builder.
- Review: QA pass over the final deliverable.

**The command's result sentinel is the only wire-level contract** — anything inside the skill is free to change. Just preserve the sentinel.
```

---

## After generation

Tell the user to:

1. Fill in the TODOs in each file (marked with `<<<...>>>`).
2. Start the daemon (or restart if it was already running) — `cd daemon && npm start`.
3. The manifest is picked up within a second by the chokidar watcher; the new template appears in the app's picker with no app redeploy.

Don't auto-start the daemon yourself — that's a side effect with blast radius the user should choose when to take.

---

## Common pitfalls

- **Reusing a UUID.** Each template needs a fresh one. Hardcoding a UUID from another template silently overwrites that template's row in Supabase.
- **Forgetting the result sentinel.** Daemon treats "no sentinel by the time the CLI exits" as `error_code='claude_error'`. The job fails and the user sees a cryptic failure.
- **Changing the sentinel prefix.** Don't. `###PRESENTATION-RESULT###` and `###PRESENTATION-PROGRESS###` are exact strings parsed by `daemon/src/runner.ts`.
- **Slug-folder mismatch.** The daemon warns when the folder name differs from the manifest's `slug`. Not fatal, but confusing — keep them aligned.
- **Binding to a model that doesn't exist.** If `record_binding.model_slug` names a model that isn't seeded or hasn't been created in the Builder, the record picker shows an empty list. Verify the model exists before binding.
