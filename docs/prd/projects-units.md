# PRD: Projects & Units Experience

**Status:** Live (model layer) · Built, pending deploy (UI + AI)
**Last updated:** 2026-07-04
**Related PRDs:** [project-matching-assistant.md](project-matching-assistant.md), [marketing-operations.md](marketing-operations.md), [public-website.md](public-website.md), [data-storage.md](data-storage.md)

## What it is (in plain English)
A polished, sales-oriented experience over the three project models. **All Projects** (`all_projects`) is the master project database; **Our Projects** (`our_projects`) is a curated sales portfolio layered on top of it; **Units** (`units`) is the inventory engine. Instead of generic record tables, the user gets: a custom Projects list (KPIs, filters, cards, list, map), a Project detail page with seven tabs, an in-project Units inventory with comparison and a unit drawer, and an Our Projects portfolio dashboard. AI assists by summarizing, cleaning, auditing, and writing sales language from real data only — it never invents facts and never does the matching itself.

## Why it exists
The three models were functionally useful but ugly: `all_projects` had fields scattered across messy sections with mislabels and a duplicate section; `units` had 31 fields dumped in one "Basic" section; `our_projects` was nearly empty with a broken card config. The generic record UI treated them as plain forms, not real-estate sales screens. This redesign fixes the structure, then the UI, then the AI.

## Key behaviors
- **All Projects = source of truth.** Inventory numbers are STORED rollups maintained by DB triggers (see [data-storage.md](data-storage.md) "Persisted project rollups") — read, never recomputed.
- **Two range families (QA-003, 2026-07-04).** `price_range` / `area_range` aggregate over ALL units (incl. sold + reserved) — internal/admin surfaces. `available_price_range` / `available_area_range` aggregate over AVAILABLE units only (null when none) — every customer-facing output (WhatsApp project messages, website project cards + OG "ابتداءً من" previews, AI sales agent price quotes, copywriter scripts) quotes the available family, so a sold 900k unit can never set the advertised starting price.
- **Our Projects = curated layer, not a duplicate DB.** Each record links to an `all_projects` master via the `project` lookup and adds portfolio-only fields (status, priority, display order, hero override, sales pitch, visibility, commission/portfolio notes).
- **Deterministic matching only.** "Match client request" calls the existing `/api/project-finder` (boundary-verified, scored, ranked). AI never chooses from the database; it only NARRATES the engine's results (`finderCandidatesForNarration` preserves the engine's groups/order/scores and cannot re-rank or add candidates).
- **AI never invents facts.** Every AI action receives pre-resolved facts from the client (`projectFacts`/`unitFacts`); any missing field is `null` and rendered/declared as "غير متوفر". The `/api/project-ai` system prompt forbids inventing prices, locations, availability, amenities, developers, or dates.
- **Deterministic-first audit.** Data-quality score, missing-field lists, website-publish blockers, and matching blockers are computed in `auditProject` (pure TS). The AI audit action only phrases those deterministic findings.
- **Price/m²** is the only derived unit value (`total_price ÷ unit_area`); shown only when both exist and area > 0.
- **`?generic=1` escape hatch** on every custom page falls back to the standard record list/form (table, export, advanced edit).
- Fully bilingual + RTL. Missing facts always render as "غير متوفر" / "N/A", never a guess.

## User flows
1. **Browse projects:** open All Projects → KPI bar (total / available units / targeted / public / missing-geo) → search + filter (city, district, developer, status, construction, unit type, price, targeting, data quality) → grid / list / map → click a card → Project detail.
2. **Work a project:** detail page hero + KPI cards → tabs: **Overview** (identity, unit types, amenities, links), **Units** (inventory), **Location** (geo + map + landmarks), **Media** (images/videos/brochures), **Sales Notes** (inline-editable priority/exclusivity/targeting/notes, saved via `record_save`), **AI Review** (clean / brief / WhatsApp / audit / match), **Data Quality** (score + blocker checklists).
3. **Inventory + sell units:** Units tab → filter (status/type/bedrooms/price/area/floor) + sort (cheapest/largest/best per m²/newest) → select units → Compare (deterministic best-in-class highlights + AI recommendation) or generate a WhatsApp message → click a row → unit drawer (identity, price, layout, areas, plan, components, location, documents, notes, AI WhatsApp).
4. **Run the portfolio:** Our Projects → active-first cards ordered by display order → visibility indicator → open linked project, or generate an AI sales pitch grounded in the linked project's facts.
5. **Empty/missing state:** any absent fact shows "غير متوفر"; the detail page renders with no crash when a project is sparse (resolvers return null throughout).

## Data touched
- Reads: `models.schema.sections` (the restructured schemas), `records.data` for `all_projects` / `our_projects` / `units`, geography records (`cities` / `districts`) for location names, and `/api/project-finder` for matching.
- Writes: `records.data` via `saveRecord`/`record_save` (Sales Notes tab only). AI endpoints write nothing — they return text.
- Model schema (live, applied 2026-06-29; backup `_backup_projects_units_models_20260629`): `all_projects` → 9 sections; `units` → 7 sections; `our_projects` → +Portfolio section; 4 relabels; 9 new all_projects fields; card configs fixed.

## Key files
| File | What it does |
|---|---|
| `src/pages/Projects/ProjectsListPage.tsx` | Custom All Projects list (KPIs, filters, grid/list/map) |
| `src/pages/Projects/ProjectDetailPage.tsx` | Project detail page (hero + KPI cards + 7 tabs) |
| `src/pages/Projects/OurProjectsPortfolioPage.tsx` | Our Projects sales portfolio dashboard |
| `src/pages/Projects/components/UnitsInventory.tsx` | In-project inventory (filter/sort/select/compare/WhatsApp) |
| `src/pages/Projects/components/UnitDrawer.tsx` | Unit detail slide-over + AI WhatsApp |
| `src/pages/Projects/components/UnitCompareModal.tsx` | Deterministic compare + AI recommendation |
| `src/pages/Projects/components/MatchClientModal.tsx` | Deterministic match via `/api/project-finder` + AI narration |
| `src/lib/projects/projectView.ts` | Pure resolver for project facts (missing → null) |
| `src/lib/projects/unitView.ts` | Pure resolver for unit facts + sort + best-by |
| `src/lib/projects/projectAi.ts` | Deterministic audit/issue-detection + AI client + fact builders |
| `api/project-ai.ts` | Fact-grounded AI actions (clean/brief/whatsapp/compare/audit/match_explain) |
| `src/App.tsx` | Dispatcher wiring (`all_projects`, `our_projects`) |

## Open questions / known limitations
- **Image rendering** on cards/detail uses values only if they are `http(s)` URLs. CRM image fields that store private `files` ids are not resolved to signed URLs here yet — they show a placeholder + a "manage in the form" link. A signed-URL resolution pass is a follow-up.
- **AI audit score** is computed deterministically (`auditProject`); the AI only narrates it. `data_confidence_score` (manual) is shown alongside but not merged into the computed score.
- Sales Notes inline save uses the default `saveRecord` path; on a concurrent edit it surfaces a "changed elsewhere — reload" toast rather than a merge.
- Generated model PRDs under `docs/prd/models/` refresh via `npm run sync:prds` when Supabase creds are present (skipped in credential-less worktrees).
