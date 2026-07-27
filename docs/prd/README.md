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
| 13 | [chats.md](chats.md) | WhatsApp inbox — two-pane list + thread, live webhook updates, media, client auto-link. Gateway is **per-number and swappable**: self-hosted **WAHA** since 2026-07-19 (migrated off Haberchat, which is kept as a legacy provider) |
| 14 | [whiteboard.md](whiteboard.md) | Built-in drawing canvas (tldraw) — freeform sketching, annotations, per-browser IndexedDB persistence |
| 15 | [ai-agent.md](ai-agent.md) | Internal Claude-powered AI sales agent — chat UI inside the app, tool-use loop over project records, save_lead into clients. **⛔ ARCHIVED 2026-07-22** (code deleted in commit `203f410`; model + conversations preserved) — superseded by the deterministic Project Finder (#30) |
| 16 | [logs.md](logs.md) | Unified activity log — single timeline showing auth, record CRUD, workflow runs, AI agent turns + tool calls, API hits, webhook receipts |
| 17 | [public-website.md](public-website.md) | Public marketing site — `is_public` opt-in on projects, `site_settings` model, anon RLS contract powering projects.html + map.html + index.html |
| 18 | [marketing-operations.md](marketing-operations.md) | **⛔ ARCHIVED 2026-07-22** (hidden from UI in commit `203f410`; data preserved) — template-driven design generator: pick project + template, fill variables, two-phase image orchestration writes cleaned + final image back to the record |
| 19 | [templates-library.md](templates-library.md) | **⛔ ARCHIVED 2026-07-22** (hidden from UI in commit `203f410`; data preserved) — reusable design templates: reference image, cleanup + design prompts with `{{PLACEHOLDER}}` tokens, typed variable list |
| 20 | [decks.md](decks.md) | **⛔ ARCHIVED 2026-07-22** (UI + endpoints deleted in commit `203f410`; records, `.pptx` files, and worker preserved) — AI-generated Wassel-branded PowerPoints via Anthropic Skills + code_execution |
| 21 | [clients.md](clients.md) | Clients model + Client 360 view — WhatsApp / Calls inline sections, tab strip on every record that references a client, cross-model Related Records panel |
| 22 | [files.md](files.md) | Drive-style file library — uploads to private `wassel-files` bucket, nested folders, file + folder permissions (viewer/editor/owner) with folder cascade, brand-heavy public `/share/:token` external links with password + expiry + view counter |
| 23 | [image-chats.md](image-chats.md) | **⛔ ARCHIVED 2026-07-22** (UI + endpoints deleted in commit `203f410`; sessions, `media_assets`, and worker preserved) — the Creative Studio image workspace on fal.ai (Generations, media library, brand presets) |
| 24 | [data-migration.md](data-migration.md) | **⛔ ARCHIVED 2026-07-22** (wizard deleted in commit `203f410`; data + worker preserved) — the in-app AI import wizard, superseded by the Claude-driven `/migrate-project` skill |
| 25 | [copywriter-intelligence.md](copywriter-intelligence.md) | **⛔ ARCHIVED 2026-07-22** (commit `203f410`) — competitor reel knowledge base + Copywriter agent. The Phase 3–4 chat-agent code was deleted; the Phase 1–2 "Clean & Analyze" engine + bulk script survive but the `competitors` / `reel_scripts` models are hidden from the UI. All data preserved |
| 26 | [sales-process.md](sales-process.md) | Sales Operating System — the guided sales lifecycle (New → … → Closed Won, side-exits Lost / Unqualified), the config layer, the 12 Sales Lifecycle workflows, the 4 downstream models, and the Sales Queue / Studio / Manager surfaces. Key files: `src/lib/salesProcess/**`, `src/pages/Sales/**`, `src/pages/SalesProcess/SalesProcessStudioPage.tsx`, `supabase/migrations/2026-06-1{6,7}_sales_os_*.sql` |
| 27 | [followups-workspace.md](followups-workspace.md) | Follow-up Workspace — the guided per-task screen that replaces the generic follow-ups form: mission, outcome panel with dynamic field visibility + validators, evidence linking, appointment-booked-requires-creation, the `?generic=1` escape hatch. Key files: `src/pages/Followups/FollowUpWorkspacePage.tsx`, `src/pages/Followups/components/**`, `src/lib/salesProcess/{config,validators,outcomes}.ts` |
| 28 | [scheduled-reports.md](scheduled-reports.md) | Scheduled Reports — dashboard / widget / metric delivered on a Riyadh schedule, computed under the owner's RLS by the SAME analytics engine, emailed via Resend or stored as a draft. Owner-scoped JWT runner + Fly worker scheduler + admin UI (create/edit/pause/resume/delete, run-now, history, snapshot, errors). Inert until env set (`SUPABASE_JWT_SECRET` + `REPORTS_RUNNER_SECRET`). Key files: `api/_lib/reportRunner.ts`, `api/scheduled-reports/run-now.ts`, `worker/src/index.ts`, `src/pages/Dashboard/ScheduledReportsPage.tsx`, `supabase/migrations/2026-06-17_scheduled_reports.sql` |
| 29 | [sales-studio.md](sales-studio.md) | Sales Studio 2.0 — the business-facing sales **strategy** layer over the Sales OS: a Process Library, versioned process configs, a customer journey map with safe workflow-card editing, client process assignment, A/B experiments, and real funnel analytics. The Workflow engine stays the only executor — Studio produces a config-overlaid copy it runs (`applyProcessOverlayToWorkflow`). Key files: `src/lib/salesStudio/**`, `src/pages/SalesStudio/**`, `supabase/migrations/2026-06-21_sales_studio_2.sql` |
| 30 | [project-matching-assistant.md](project-matching-assistant.md) | **Project Finder** (الباحث عن المشاريع) — the deterministic, geography-boundary-verified matching engine that the assistant direction was narrowed to (2026-06-28). Client requirements → ranked best-fit projects in FOUR location-centric groups (exact district / nearby / same-city / broader); selection + scoring + ranking are 100% code, district decided by PostGIS point-in-polygon (not stored text); the AI is bounded to parse-before + explain-after with a hard ranking guard. **The broad conversational assistants (`ai_chats`, `copywriter_chats`, `matching_chats`) are ⛔ UNWIRED under `PROJECT_FINDER_ONLY`** (data kept; their page/endpoint code was deleted 2026-07-22 in commit `203f410` — restore via `git revert`). The Follow-up "Suggested Projects" modal consumes `/api/project-finder` directly (`parse:false`+`explain:false`, four groups, no LLM); `/api/suggest-projects` is retired from the UI. Key files: `api/project-finder.ts`, `api/_lib/{projectFinder,projectFinderAI,geoVerify,matchAgent}.ts`, `api/suggest-projects.ts`, `src/lib/matching/projectFinder.ts`, `src/lib/featureFlags.ts`, `src/components/RetiredAssistantNotice.tsx`, `src/pages/Followups/components/{SalesAssistantSidePanel,SuggestedProjectsModal,FinderCard}.tsx`, `supabase/migrations/2026-06-28_project_finder_geo.sql`, `supabase/migrations/2026-06-25_geography_*.sql` |
| 31 | [visit-rating.md](visit-rating.md) | Visit Experience Rating — the customer-facing 1–5 star feedback loop for the Visit stage. A timer follow-up + an `on_due` workflow WhatsApp the client a login-free, PII-free public `/rate/:token` page ~2h after a visit; the score writes back to the visit + client mirror and feeds the timeline, account, and dashboards. Key files: `src/pages/PublicRate/RateVisitPage.tsx`, `src/pages/Records/hooks/useFieldDefaults.ts`, `supabase/migrations/2026-06-21_visits_rating_and_after_visit.sql` |
| 32 | [sales-valuation.md](sales-valuation.md) | Sales Valuation (تقييم المبيعات) — daily Sales Quality & Coaching loop over completed follow-ups: manager review queue, mistake-category classification + 0–100 scoring, auto correction tasks, per-rep daily coaching summaries, rep acknowledge/dispute → manager closure. Five unfrozen models + SECURITY DEFINER triggers (no client-workflow rows), saved-view queue + manager/rep dashboards, all Arabic-first. Key files: `supabase/migrations/2026-06-23_sales_valuation_operation.sql` (functions `svr_*`), rendered through the generic model/list/dashboard UI |
| 34 | [market-intelligence.md](market-intelligence.md) | **Market Intelligence** (ذكاء السوق) — a brokerage command center on a deterministic benchmark precompute layer over 46k market listings + our units + client demand. Per-district × type price/m² benchmarks (median + P10–P90, dedup + confidence grades), demand×supply overlay, opportunity queues, our-project pricing positioning, best-value listings, branded client/pricing PDF reports, and deal-quality badges in the Project Finder. ZERO AI in any number; asking-only (transaction-ready, honest empty states); confidence + caveats surfaced everywhere. Key files: `supabase/migrations/2026-06-29_market_intel_*.sql`, `api/market-intelligence.ts`, `api/_lib/marketBadge.ts`, `src/lib/market/**`, `src/pages/MarketIntelligence/**`, finder badge in `src/pages/Followups/components/FinderCard.tsx` |
| 33 | [projects-units.md](projects-units.md) | Projects & Units experience — restructured `all_projects` (9 sections) / `units` (7 sections) / `our_projects` (+Portfolio); custom Projects list (KPIs/filters/grid/list/map), Project detail with 7 tabs, in-project Units inventory (filter/sort/compare/WhatsApp + unit drawer), Our Projects sales portfolio. AI actions (clean/brief/whatsapp/compare/audit) are fact-grounded via `/api/project-ai`; matching reuses the deterministic `/api/project-finder` (AI narrates, never re-ranks). Key files: `src/pages/Projects/**`, `src/lib/projects/{projectView,unitView,projectAi}.ts`, `api/project-ai.ts` |

| 35 | [sales-rep-workspace.md](sales-rep-workspace.md) | **Sales Rep Workspace** — profile-assignable simplified sales surface: **My Clients** (tabbed self-scoped client list — All/Interested/Serious/Active/Late/Unqualified — with strong filters + a situational card incl. related-records summary, click-through to Client 360) and **My Tasks** (redesigned 2026-07-21: **Actions** — one priority-stacked list with hot-lead 5-min countdown / replied / overdue / today / quiet tiers; **Waiting for customer** — WhatsApp tasks parked with the client; **Appointments** — Today/Tomorrow/Future/No-shows; plus the Incomplete-Preferences placeholder and Other Tasks), with app-wide hot-lead + customer-replied notifications (`SalesNotifications`). Two opt-in `CUSTOM_PAGES` (`my_clients`/`my_tasks`, `default_access:'admin'`) → auto-wired Sidebar + PageAccessMatrix + RequirePageAccess; reps scoped to their own `client_owner`/`sales_rep`, managers see all. "Late" = scheduled before today (not earlier-today). Key files: `src/pages/Sales/{MyClientsPage,MyTasksPage}.tsx`, `src/pages/Sales/components/{MyClientCard,FollowupTaskCard}.tsx`, `src/pages/Sales/lib/{myWork,salesClients}.ts`, `src/components/SalesNotifications.tsx`, `src/lib/customPages.ts` |
| 35 | [marketing-intelligence.md](marketing-intelligence.md) | **Marketing Intelligence** (ذكاء التسويق) — competitor MARKETING intelligence, distinct from #34 Market Intelligence (ذكاء السوق, listing data). One page: a deterministic insight feed (7 SQL rules: advertiser went quiet, posting-frequency / platform / messaging shift, new offer, new marketer, price movement) + per-organization and per-project intelligence over the `mkt_observed_facts` layer (prices, offers, payment plans, CTAs, hooks, amenities, unit types, districts, phones). ZERO AI in any number. Confirmed vs speculative attributions are never mixed (4,453 speculative vs 225 confirmed); unmeasurable values render "—" not 0; every capped list reports its cap; every insight carries its rule + thresholds. Key files: `supabase/migrations/2026-08-13_mkt_intelligence_index.sql`, `api/marketing.ts`, `src/lib/marketing/client.ts`, `src/pages/MarketingIntelligence/**` |

| 36 | [posts-content.md](posts-content.md) | **Posts Content Writer** (كاتب المحتوى) — multi-project marketing-copy generator. Pick projects from Our Projects, choose a post count (a total distributed across them, or per-project), a language (ar/en/both) and a style (short/long) → posts written from the project's real facts → approve / reject-with-reason / edit / rewrite, with batch history. The 15 client templates are treated as marketing ANGLES, never property types (every project sells exactly one unit type); angles the data can't back are EXCLUDED before generation and ranked strongest-first, reused only after all are used. Two anti-fabrication gates: the model writes only headline+prose while code renders every spec line from the DB, AND it must cite `used_fact_ids[]` validated against a fact catalog (catches number-free fabrications). Available-only price/area (QA-003) — a sold-out project shows no price. Key files: `src/lib/postsContent/{templates,planning,facts,client}.ts`, `api/templates/posts-content.ts`, `src/pages/PostsContent/**`, `supabase/migrations/2026-07-26_posts_content_v2.sql` |

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
