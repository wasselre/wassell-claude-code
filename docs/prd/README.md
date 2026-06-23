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
| 20 | [decks.md](decks.md) | AI-generated Wassel-branded PowerPoints — brief form + Anthropic Skills API + code_execution + Supabase Storage. New section under sidebar "Decks" |
| 21 | [clients.md](clients.md) | Clients model + Client 360 view — WhatsApp / Calls inline sections, tab strip on every record that references a client, cross-model Related Records panel |
| 22 | [files.md](files.md) | Drive-style file library — uploads to private `wassel-files` bucket, nested folders, file + folder permissions (viewer/editor/owner) with folder cascade, brand-heavy public `/share/:token` external links with password + expiry + view counter |
| 23 | [image-chats.md](image-chats.md) | "Mini Higgsfield" image-design chat — fal.ai Nano Banana 2, per-turn aspect ratio / variations / brand preset, image + prompt libraries with auto-attach |
| 24 | [data-migration.md](data-migration.md) | AI-assisted import wizard — any-format files → raw table → AI column mapping → approval-gated value standardization (match / create / route-to-field) → import into any model |
| 25 | [copywriter-intelligence.md](copywriter-intelligence.md) | Competitor reel knowledge base — AI "Clean & Analyze" turns noisy Arabic auto-transcripts into clean text + structured marketing analysis (hook, angle, trigger, structure, tone, CTA); feeds a planned copywriter agent |
| 26 | [sales-process.md](sales-process.md) | Sales Operating System — the guided sales lifecycle (New → … → Closed Won, side-exits Lost / Unqualified), the config layer, the 12 Sales Lifecycle workflows, the 4 downstream models, and the Sales Queue / Studio / Manager surfaces. Key files: `src/lib/salesProcess/**`, `src/pages/Sales/**`, `src/pages/SalesProcess/SalesProcessStudioPage.tsx`, `supabase/migrations/2026-06-1{6,7}_sales_os_*.sql` |
| 27 | [followups-workspace.md](followups-workspace.md) | Follow-up Workspace — the guided per-task screen that replaces the generic follow-ups form: mission, outcome panel with dynamic field visibility + validators, evidence linking, appointment-booked-requires-creation, the `?generic=1` escape hatch. Key files: `src/pages/Followups/FollowUpWorkspacePage.tsx`, `src/pages/Followups/components/**`, `src/lib/salesProcess/{config,validators,outcomes}.ts` |
| 28 | [scheduled-reports.md](scheduled-reports.md) | Scheduled Reports — dashboard / widget / metric delivered on a Riyadh schedule, computed under the owner's RLS by the SAME analytics engine, emailed via Resend or stored as a draft. Owner-scoped JWT runner + Fly worker scheduler + admin UI (create/edit/pause/resume/delete, run-now, history, snapshot, errors). Inert until env set (`SUPABASE_JWT_SECRET` + `REPORTS_RUNNER_SECRET`). Key files: `api/_lib/reportRunner.ts`, `api/scheduled-reports/run-now.ts`, `worker/src/index.ts`, `src/pages/Dashboard/ScheduledReportsPage.tsx`, `supabase/migrations/2026-06-17_scheduled_reports.sql` |
| 29 | [sales-studio.md](sales-studio.md) | Sales Studio 2.0 — the business-facing sales **strategy** layer over the Sales OS: a Process Library, versioned process configs, a customer journey map with safe workflow-card editing, client process assignment, A/B experiments, and real funnel analytics. The Workflow engine stays the only executor — Studio produces a config-overlaid copy it runs (`applyProcessOverlayToWorkflow`). Key files: `src/lib/salesStudio/**`, `src/pages/SalesStudio/**`, `supabase/migrations/2026-06-21_sales_studio_2.sql` |
| 30 | [project-matching-assistant.md](project-matching-assistant.md) | **Sales Assistant** (مساعد المبيعات) — ONE unified live-call sales co-pilot; project matching is its FIRST capability (more added inside the same assistant later, never a second face). Customer requirements → ranked best-fit projects + ready-to-say pitch. Deterministic two-tier search (our_projects first, all_projects fallback flagged for verification) + weighted TEXT scoring + server-forced score/band (no LLM re-scoring); AI narrates only over verified facts. Custom split-pane chat (`matching_chats` / `/api/match` — technical names kept). No geo yet (Phase 2). Key files: `api/match.ts`, `api/_lib/matchAgent.ts`, `src/pages/Matching/**`, `src/lib/matching/**`, `supabase/migrations/2026-06-18_matching_chats_model.sql` |
| 31 | [visit-rating.md](visit-rating.md) | Visit Experience Rating — the customer-facing 1–5 star feedback loop for the Visit stage. A timer follow-up + an `on_due` workflow WhatsApp the client a login-free, PII-free public `/rate/:token` page ~2h after a visit; the score writes back to the visit + client mirror and feeds the timeline, account, and dashboards. Key files: `src/pages/PublicRate/RateVisitPage.tsx`, `src/pages/Records/hooks/useFieldDefaults.ts`, `supabase/migrations/2026-06-21_visits_rating_and_after_visit.sql` |
| 32 | [sales-valuation.md](sales-valuation.md) | Sales Valuation (تقييم المبيعات) — daily Sales Quality & Coaching loop over completed follow-ups: manager review queue, mistake-category classification + 0–100 scoring, auto correction tasks, per-rep daily coaching summaries, rep acknowledge/dispute → manager closure. Five unfrozen models + SECURITY DEFINER triggers (no client-workflow rows), saved-view queue + manager/rep dashboards, all Arabic-first. Key files: `supabase/migrations/2026-06-23_sales_valuation_operation.sql` (functions `svr_*`), rendered through the generic model/list/dashboard UI |

Plus `_TEMPLATE.md` — the template every new PRD must follow.

## Auto-generated PRDs (models & workflows)

Two subfolders are **machine-generated from the live Supabase DB**, not hand-written:

- **[models/](models/)** — one PRD per model: every section, field, field type, dropdown option (with its API `value`), lookup, formula, range, and computed rollup. Includes unfrozen models that exist only as JSONB rows and never appear in code.
- **[workflows/](workflows/)** — one PRD per workflow: trigger, branches, conditions, and every action with its resolved field mappings.

Regenerate with `npm run sync:prds` (reads the live DB; a `SessionStart` hook also runs it each session). **Never hand-edit these** — they're overwritten on the next run and files for deleted models/workflows are pruned. The git diff of these folders is the record of what changed in the app. See `CLAUDE.md` → "Generated model & workflow PRDs" for the full contract.

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
