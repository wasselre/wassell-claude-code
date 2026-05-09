# Wassell CRM — Product Requirements (PRD) Index

This folder contains the **living source of truth** for what every section of the Wassell CRM app does, written in plain English. Code is the source of truth for *how*; these PRDs are the source of truth for *what* and *why*.

> **For Claude:** These files must be kept in sync with the code. See the rule in `CLAUDE.md` ("Living Documentation"). After every non-trivial change in `src/**`, update the matching PRD(s) and bump the `Last updated` date.

## Index

| # | PRD | Scope |
|---|---|---|
| 1 | [model-builder.md](model-builder.md) | Designing custom data models: sections, fields, options, section selector, card builder |
| 2 | [record-management.md](record-management.md) | Viewing, creating, editing records. List/table/card views, forms, lookups |
| 3 | [workflow-automation.md](workflow-automation.md) | No-code automations: triggers, conditions, actions, execution engine |
| 4 | [dashboards.md](dashboards.md) | Dashboard builder, widget types, public dashboard sharing |
| 5 | [access-control.md](access-control.md) | Users, roles, profiles, permission matrix |
| 6 | [internationalization.md](internationalization.md) | Arabic/English labels, RTL/LTR switching, translations |
| 7 | [import-export.md](import-export.md) | Excel import, PDF generation, research PDF template |
| 8 | [navigation-layout.md](navigation-layout.md) | Sidebar, header, routing, model groups, home page |
| 9 | [data-storage.md](data-storage.md) | Supabase sync, offline localStorage fallback, JSONB schema |
| 10 | [home-dashboard.md](home-dashboard.md) | Home landing page — overview stats and quick actions |
| 11 | [workflow-logs.md](workflow-logs.md) | Workflow execution logs — detailed audit trail of every firing |
| 12 | [calling.md](calling.md) | Call logging via Hatif — post-call webhook, transcripts, client-record link |
| 13 | [chats.md](chats.md) | WhatsApp inbox via Haberchat — two-pane list + thread, live webhook updates, media, client auto-link |
| 14 | [whiteboard.md](whiteboard.md) | Built-in drawing canvas (tldraw) — freeform sketching, annotations, per-browser IndexedDB persistence |
| 15 | [ai-agent.md](ai-agent.md) | Internal Claude-powered AI sales agent — chat UI inside the app, tool-use loop over project records, save_lead into clients |
| 16 | [logs.md](logs.md) | Unified activity log — single timeline showing auth, record CRUD, workflow runs, AI agent turns + tool calls, API hits, webhook receipts |
| 17 | [public-website.md](public-website.md) | Public marketing site — `is_public` opt-in on projects, `site_settings` model, anon RLS contract powering projects.html + map.html + index.html |
| 18 | [marketing-operations.md](marketing-operations.md) | Template-driven design generator — pick project + template, fill variables, two-phase Higgsfield orchestration writes cleaned + final image back to the record |
| 19 | [templates-library.md](templates-library.md) | Reusable design templates: reference image, cleanup + design prompts with `{{PLACEHOLDER}}` tokens, typed variable list |

Plus `_TEMPLATE.md` — the template every new PRD must follow.

## Decision rule: when to add a new PRD vs. extend an existing one

When you add a new feature:

- **Extend an existing PRD** if the feature is a variation, option, or sub-behavior of something already documented.
  - Example: a new field type → extends `model-builder.md`.
  - Example: a new workflow action → extends `workflow-automation.md`.
  - Example: a new dashboard widget → extends `dashboards.md`.

- **Create a new PRD** if the feature is a distinct user-facing area that has all of:
  - Its own page/route
  - Its own data model or storage
  - Its own user flow not already covered

  Example: a new "Notifications" inbox or a new "Calendar" page → new PRD.

- **When in doubt, extend.** Fewer, richer PRDs are easier to maintain than many thin ones.

## How to write / update a PRD

1. Copy `_TEMPLATE.md` to `<feature-name>.md` (kebab-case).
2. Fill in every section. Keep language plain — a non-developer should understand it.
3. In "Key files", list only the files a new developer (or Claude) needs to find the feature. Not every file.
4. Cross-link related PRDs in the "Related PRDs" list.
5. Bump `Last updated` on every change.
6. Add the new PRD to the index in this README.
