# Wassell CRM — Claude Code Project Memory

## What This Project Is
A full-stack no-code operational CRM system for a real estate marketing company called Wassel (وصل العقارية).
Users build their own data models, automate workflows, and create shareable dashboards — all without writing code.
Think: Zoho Creator + Zapier + Airtable, built for Saudi Arabian real estate.

## Living Documentation (CRITICAL — Read This)

Every main section of this app has a plain-English PRD in `docs/prd/`. These are the **source of truth for what the app does**; code is the source of truth for *how*. `CLAUDE.md` is the source of truth for architecture, design system, and conventions.

**Hard rule — after any non-trivial change to user-facing behavior in `src/**`, you MUST:**
1. Identify which PRD(s) in `docs/prd/` cover the area you changed (see each PRD's "Key files" table).
2. Update the PRD's `What it is`, `Key behaviors`, `User flows`, `Data touched`, and/or `Key files` sections to match the new reality.
3. Bump the `Last updated` date at the top of the PRD to today's date.
4. If a new feature doesn't fit any existing PRD, consult the decision rule in `docs/prd/README.md` — extend when in doubt; create a new PRD only for distinct user-facing areas with their own page, data, and flow.

**Skip PRD updates ONLY for:** pure refactors, typo fixes, comment-only changes, or test-only changes.

A `PostToolUse` hook at `.claude/hooks/prd-reminder.js` will print a reminder after every `Edit`/`Write`/`MultiEdit` in `src/**`, mapping the file to its PRD. Do NOT rely on the hook — follow the rule proactively. The hook is a safety net.

For large or cross-cutting changes (multiple PRDs, new pages, big refactors), invoke the `prd-updater` subagent:
```
Agent(subagent_type="prd-updater", prompt="Refresh PRDs after <describe the change>")
```

**PRD index:** `docs/prd/README.md`. **PRD template:** `docs/prd/_TEMPLATE.md`.

## Tech Stack
- **Frontend:** React 18 + TypeScript + Vite
- **Styling:** Tailwind CSS v3 (RTL support via `dir` attribute)
- **Database:** Supabase (PostgreSQL + JSONB) with localStorage offline fallback
- **State:** Zustand
- **Routing:** React Router v6
- **i18n:** react-i18next (Arabic + English, full RTL/LTR switching)
- **Drag & Drop:** @dnd-kit/core + @dnd-kit/sortable
- **Charts:** Recharts
- **PDF:** jsPDF (Arabic RTL support)
- **Icons:** Lucide React
- **Font:** Amiri (Google Fonts)

## Design System (Official Wassel Branding)
- **Primary:** Copper Bronze `#B8734F` — buttons, active states, accents (50%)
- **Sidebar:** Charcoal Slate Gray `#4A4E54` background
- **Dark Alt:** Rich Chocolate Brown `#4A2C2A` — headers, contrast areas
- **Secondary:** Deep Terracotta `#8E4E3A` — hover states
- **Surface:** Warm Sand/Beige `#D4B896` — borders, dividers (30%)
- **Background:** Soft Cream `#F5EDE0` — page backgrounds
- **Text:** Charcoal Slate Gray `#4A4E54` — body text (15%)
- **Accent:** Subtle Gold `#C09B5F` — badges, highlights (5%)
- **Currency:** SAR (Saudi Riyal) — ر.س
- Border radius: 8px (inputs), 12px (cards), 16px (modals)
- Typography: Amiri for both Arabic and English text
- Logo: Wassel castle/fort logo from `Wassel Branding/` folder
- RTL: when language = 'ar', set `dir="rtl"` on `<html>`; when 'en', set `dir="ltr"`

## Bilingual Rules (CRITICAL)
- Every model, section, field, and option has BOTH `label_ar` and `label_en`
- All static UI strings go through react-i18next
- Never hardcode Arabic or English text directly in JSX — always use `t('key')` or the `isAr ? x.label_ar : x.label_en` pattern
- The language toggle is in the Header component

## Data Architecture (CRITICAL — Read Before Any Feature)
All model schemas are stored as JSONB in Supabase. A model's schema looks like this:
```json
{
  "sections": [
    {
      "id": "uuid",
      "label_ar": "...",
      "label_en": "...",
      "order": 0,
      "is_base": true,
      "color": "#3B82F6",
      "fields": [
        {
          "id": "uuid",
          "name": "field_slug",
          "label_ar": "...",
          "label_en": "...",
          "type": "dropdown",
          "required": true,
          "order": 0,
          "section_id": "parent-section-uuid",
          "width": "half",
          "show_in_table": true,
          "options": [
            { "id": "uuid", "label_ar": "...", "label_en": "...", "value": "slug", "color": "#hex" }
          ],
          "lookup_model_id": null,
          "lookup_display_field": null
        }
      ]
    }
  ],
  "section_selector_field_id": "uuid-or-null"
}
```

Records are also JSONB: `{ "field_slug": value, "another_field": value }`

## The Section Selector Field (CRITICAL — Unique Feature)
This is a special field type (`section_selector`) that controls which non-base sections appear in the record form.
- Its options are the names of non-base sections in the same model
- When a user selects values in this field, only those sections show in the form
- Base sections (`is_base: true`) ALWAYS show regardless
- Used in the Follow-Ups model to show different fields per follow-up type
- Can be added to any model via the Builder

## Supabase Tables
```
models            — model definitions (schema as JSONB)
model_groups      — sidebar folder groups
records           — all records for all models (data as JSONB)
workflows         — automation workflow definitions
dashboards        — dashboard configurations (widgets as JSONB)
chat_messages     — WhatsApp messages per conversation (Realtime-enabled)
whatsapp_numbers  — local overlay on Haberchat devices: friendly name + default flag
```

## Offline / Local Fallback
- All data is mirrored to localStorage
- If Supabase is not configured, the app works fully offline
- On every save: update localStorage first (instant), then sync to Supabase (async, silent fail)
- On load: try Supabase first, fall back to localStorage

## Pre-Built System Models
These are defined in `src/data/seedModels.ts` and loaded on first run.
They are editable in the Builder but cannot be deleted (is_system: true).
1. `clients` — Clients model (3 sections)
2. `followups` — Follow-Ups model (5 sections, uses section_selector)
3. `all_projects` — All Projects (group: Projects)
4. `targeted_projects` — Targeted Projects (group: Projects)
5. `our_projects` — Our Projects (group: Projects)
6. `projects_research` — Research with PDF generation (group: Projects)
7. `chats` — WhatsApp conversations via Haberchat. Top-level (no group).
   Renders a custom two-pane UI (list + thread) instead of the generic
   record table/form. See `docs/prd/chats.md`.
8. `ai_chats` — Internal Claude-powered AI sales agent. Top-level
   (no group). Each record is one conversation; messages live inline in
   `record.data.messages` as a JSON array. Renders a custom split-pane
   UI. Backed by `api/agent.ts` + `api/_lib/aiAgent.ts`. Requires
   `ANTHROPIC_API_KEY`. See `docs/prd/ai-agent.md`.

## Current Build Status
- [x] Phase 1: Foundation (types, store, layout, routing)
- [x] Phase 2: Model Builder (the most critical feature)
- [x] Phase 3: Record Views (list, form, table, cards)
- [x] Phase 4: Workflow Engine
- [x] Phase 5: Dashboard Builder
- [x] Phase 6: PDF Generation + Public Links
- [x] Phase 7: Polish (home page, schema.sql, toasts)

## Coding Conventions
- All components use TypeScript with explicit prop types
- No `any` types — use proper types from `src/types/index.ts`
- Use Zustand store via `useAppStore` hook — never fetch directly in components
- All IDs are UUIDs generated with `uuid` package
- Dates stored as ISO strings
- Field slugs (the `name` property) are snake_case
- File names: PascalCase for components, camelCase for utilities
- Co-locate component-specific sub-components inside a `components/` subfolder next to the page

## Environment Variables
```
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_ANON_KEY=your-anon-key
ANTHROPIC_API_KEY=sk-ant-...   # server-side only, powers /api/agent
```
See `.env.example` for the full set including Haberchat + Hatif keys.

## Deployment Config (CRITICAL — `vercel.json`)
The app deploys to Vercel. Its config (`vercel.json`) is validated against a **strict JSON schema** (`https://openapi.vercel.sh/vercel.json`) at deploy time — every object inside `headers[]`, `rewrites[]`, `redirects[]`, etc. is `additionalProperties: false`. Any unknown key makes the deploy error out **before the build runs** (duration shows blank in the Vercel dashboard).

**Rules when editing `vercel.json`:**
1. **No custom keys.** JSON has no comments. Do NOT add `_comment`, `//`, `description`, or any other field the schema doesn't list. Explanations go in the commit message, not the JSON.
2. **`npm run build` does NOT validate `vercel.json`** — it only runs `tsc + vite build`. A green local build tells you nothing about deploy-config correctness.
3. **After any edit to `vercel.json` (or adding new Vercel-only config), verify before pushing.** Either:
   - Run `npx vercel build` locally (reproduces the full production build including config validation), OR
   - Open `vercel.json` in an editor with JSON-schema support — the `$schema` reference at the top will surface violations inline.
4. **Past incident (2026-04-22):** commit `f6a07f5` added `_comment` keys inside `headers[]` entries. Local build passed; three consecutive production deploys failed with blank duration until `_comment` was removed in `df7c09a`.

The same "strict schema, not validated by `npm run build`" principle applies to any other deploy-layer config we add later (e.g. `netlify.toml`, GitHub Actions workflows, Supabase `config.toml`).

## Do Not
- Do not use `any` TypeScript type
- Do not hardcode Arabic or English strings in JSX
- Do not fetch from Supabase directly in components — go through the store
- Do not delete system models (is_system: true) — disable the delete button instead
- Do not break RTL layout — always test both directions when adding UI
- Do not add non-schema keys (`_comment`, etc.) to `vercel.json` — see "Deployment Config" above
