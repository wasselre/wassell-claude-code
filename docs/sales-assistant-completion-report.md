# Wassell Sales Assistant — Product Completion: Execution Report

**Date:** 2026-06-26
**Phase:** Assistant Product Completion (extend the existing assistant; no rebuild)
**Delivery:** Built & verified in the worktree. **Not** pushed to main, **not** deployed. The DB migration has **not** been applied to prod (see Deployment).

---

## What was already built (before this phase)

Investigation found ~80% of the original spec already shipped and live:

- **Deterministic matching engine** — `api/_lib/matchAgent.ts` `scoreProject()` (weighted: location 30 / budget 25 / type 20 / area 10 / bedrooms 8 / availability 5 / amenities 2), bands, tiers (exact / nearby ≤12 km / same-city / partial), two-tier our_projects→all_projects with fallback suppression. The LLM never re-scores (`reconcileRecommendationPayload`).
- **Dual-read, lookup-first geography** — `district_lookup` id equality first, legacy text fuzzy-match fallback; district centroid resolved from the live `districts` model.
- **The Follow-up Sales Assistant side panel** (`SalesAssistantSidePanel`) already read **unsaved draft preferences** and streamed `/api/match`.
- **Controlled tools** already covered: `match_projects`, `get_project`, `compare_projects`, `get_customer_context`, `emit_recommendation` (incl. pitch + "why"), `emit_comparison`, `emit_message` (WhatsApp **draft**), `propose_task`; cards rendered via `ProjectMatchCard` / `ComparisonCard` / `MessageCard`.

So this phase **completed the product** rather than rebuilding it.

## What was added

1. **Grouped recommendation contract (deterministic, no LLM).**
   - Extracted the `match_projects` body into an exported `matchProjectsCore` (returns the object). The `match_projects` tool now wraps it with **byte-identical** JSON — `/api/match` and the panel are unchanged.
   - New pure `groupMatchResults` (`api/_lib/suggestGroups.ts`) buckets candidates into **exact_matches / nearby_alternatives / budget_matches / location_matches / fallback_matches**, and stamps each with `data_confidence` (high/medium/low) + normalized `data_gaps`.
   - The scorer now also returns `district_match_basis` ('lookup' | 'text' | null) to drive confidence + the `legacy_text_match_only` gap.
2. **`POST /api/suggest-projects`** (`api/suggest-projects.ts`) — RLS-scoped, no Anthropic: maps requirements → `matchProjectsCore` → `groupMatchResults` → missing-preference warnings → writes one audit row → returns the grouped contract.
3. **Suggested Projects modal** (`SuggestedProjectsModal.tsx`) — large modal: preference summary + missing-preference banner (top), grouped tabs + cards (left), assistant chat (right). Opened from the panel's "Suggested Projects" button. Reads the **unsaved** preference draft.
4. **Grouped project card** (`SuggestionCard.tsx`) — score, band, category, district-centroid distance, price-or-"data not available", available units, data-gap chips, confidence pill, verification banner, and actions: **Why / Compare / Pitch / WhatsApp / Open details / Add to client** (Show on map intentionally omitted — no project coordinates exist).
5. **Reusable chat pane** (`AssistantChatPane.tsx`) — the streaming `/api/match` chat extracted so the modal's right pane reuses the exact brain + cards; card buttons inject prompts via an imperative `ask()`.
6. **Add-to-client** (`src/lib/matching/addToClient.ts`) — appends a project to the existing `clients.preferred_projects` lookup via the version-aware `saveRecord` (user-triggered only, never from AI text; append-dedup; surfaces success/conflict/failure).
7. **Recommendation audit log** — `assistant_recommendation_runs` physical table (owner-RLS), written per run with the input prefs summary, result counts, project ids, and draft/legacy flags (not full payloads).
8. **Feature-flag kill switch** — `feature_flags` table seeded `sales_assistant_enabled = true`; `src/lib/featureFlags.ts` reads it fail-open; the panel + button + modal hide when it is `false`.
9. **Requirements mapper** (`src/lib/matching/requirements.ts`) — draft-first, lookup-first mapping of client preferences → matcher requirements.

## Backend response contract (`/api/suggest-projects`)

```jsonc
{
  "client_preferences_summary": {
    "requirements": { "city?", "district?", "property_type?", "budget_min?", "budget_max?", "area_min?", "area_max?", "amenities?" },
    "missing_required_preferences": ["budget" | "location" | "unit_type" | "bedrooms", ...]
  },
  "groups": {
    "exact_matches": [SuggestionItem], "nearby_alternatives": [...], "budget_matches": [...],
    "location_matches": [...], "fallback_matches": [...]
  },
  "metadata": {
    "total_candidates", "used_fallback", "used_legacy_fallback", "used_draft_values",
    "req_district_resolved", "counts": { per-group }, "generated_at"
  }
}
```
`SuggestionItem` = `{ project_id, project_name, data_source, requires_verification, score, match_band, match_type, group, data_confidence, data_gaps[], distance_km, distance_basis, budget_fit, reason_code, sales_reason, facts, score_breakdown, verification_warning? }`.

### Honest-data rules (enforced + tested)
- A project with **no price** can never be a `budget_match` → it surfaces `missing_price_range` and lands in `location_matches`/`nearby`/`fallback`.
- A strong-geography project with missing price → `location_matches` (not exact).
- `sold_out` status and `all_projects`/requires-verification/partial → `fallback_matches`.
- **Distance is district-centroid based** (0 of 978 projects have lat/lng) and labelled `distance_basis: "district_centroid"`.
- `data_confidence`: high = lookup match + active status + price/unit data; medium = lookup/active but missing price/unit; low = legacy text / requires-verification / partial / sold-out.

## Files changed

**Backend:** `api/_lib/matchAgent.ts` (extract `matchProjectsCore`, add `district_match_basis`, export types), `api/_lib/suggestGroups.ts` (new), `api/suggest-projects.ts` (new).
**Migration:** `supabase/migrations/2026-06-26_sales_assistant_completion.sql` (new — `assistant_recommendation_runs` + `feature_flags`).
**Client libs:** `src/lib/matching/{requirements,suggestions,addToClient}.ts` (new), `src/lib/featureFlags.ts` (new).
**UI:** `src/pages/Followups/components/{SuggestedProjectsModal,SuggestionCard,AssistantChatPane}.tsx` (new), `SalesAssistantSidePanel.tsx` (open modal + flag gate + `followupId` prop), `src/pages/Followups/FollowUpWorkspacePage.tsx` (pass `followupId`).
**Tests:** `src/lib/__tests__/{suggestGroups,suggestRequirements,suggestGroups.integration}.test.ts` (new); `matchProjects.integration.test.ts` (lazy client so the no-secrets suite stays green).
**Docs:** `docs/prd/project-matching-assistant.md` (updated).

## Tests run

- `npm run build` (`tsc -b` + `vite build`) → **green** (exit 0).
- `npx tsc -b` (SPA typecheck) → **green**. (`npm run typecheck:api` has pre-existing errors in unrelated files — `share/*`, `hatif`, `webhook/haberchat`, etc.; none in the new/changed files. It is not part of `npm run build`.)
- `npx vitest run` (full suite) → **264 passed, 6 skipped (live), exit 0**.
- New unit tests: `suggestGroups.test.ts` (17 — bucketing, confidence tiers, gap codes, budget-fit, perGroup cap), `suggestRequirements.test.ts` (6 — draft-first, lookup-vs-legacy).
- Regression: existing `projectMatchScoring` (12) + `salesAssistant` (16) still pass → the `matchProjectsCore` refactor preserved behavior.

## Smoke test results (live, against wassell-prod)

`suggestGroups.integration.test.ts` + the existing `matchProjects.integration.test.ts` were run with prod service-role secrets:

- **Scenario النرجس / شقة / ≤2,000,000 SAR** →
  `exact_matches: 1` ("مينا 52 - النرجس", **strong**, **high** confidence),
  `budget_matches: 5` (real-priced projects, **medium** confidence, flagged `missing_project_coordinates`),
  `fallback_matches: 2`; `req_district_resolved: true`, `used_legacy_fallback: false`.
- Asserted: every item has a valid confidence + bucket; **no `budget_match` contained a price-less project**; lookup-first district resolution worked on real data.
- The 5 existing live `match_projects` scenarios still pass → the tool path is intact end-to-end.

This verifies the deterministic engine + grouping against real production data.

## Known data limitations (carried, not fixed this phase — by instruction)

- **0 of 978 projects have lat/lng** → distance is district-centroid based only; there is no project pin/polygon matching. (`Show on map` is therefore hidden on cards.)
- **Only ~11 of 978 projects have linked units** → price/area/bedroom/availability data is absent for ~99%, so `budget_matches` is small and `location_matches` carries the strong-geo-but-no-price majority. This is surfaced honestly via `data_gaps`, never fabricated.
- `regions` model is empty; `is_active` is never true (we use `project_status`, treating `sold_out` as inactive).

## Verification gaps (manual steps remaining)

These could not be exercised in the worktree (no `/api/*` under `vite dev`; login is MFA-gated):

1. **Live UI smoke test of the modal** (acceptance-critical draft-first path). Manual steps on a deployed/authenticated build: open a Follow-up (`/model/followups/:id`) → edit preferred district/budget in the preference summary **without saving** → click **Suggested Projects** → confirm the modal results reflect the **unsaved** values (e.g. النرجس), tabs render per group, cards show data-gap chips, and **Add to client** appends to the client's preferred projects. (To test under `vite dev`, stub `window.fetch('/api/suggest-projects')` — `vite` does not serve serverless functions.)
2. **Audit insert + feature flag** behavior in the running app — exercised only after the migration is applied (see below). Both degrade gracefully without it: the audit insert logs and is skipped (results still return), and the flag read fails open (panel shows).

## Deployment

- **Run the migration first:** `supabase/migrations/2026-06-26_sales_assistant_completion.sql` (creates `assistant_recommendation_runs` + `feature_flags`, seeds the flag ON). Until then, the audit log is a no-op and the flag is fail-open (feature visible) — no errors surfaced to users.
- No env-var changes. `/api/suggest-projects` uses the existing `SUPABASE_URL` + anon key + the caller JWT (RLS-scoped), like `/api/match`.

## Rollback

- **Disable the feature:** `UPDATE public.feature_flags SET enabled = false WHERE key = 'sales_assistant_enabled';` → hides the Follow-up panel + Suggested Projects + modal immediately (next load). No code change, no schema rollback. The standalone main Sales Assistant page is unaffected.
- The matcher refactor is behavior-preserving; the legacy `match_projects` tool output is byte-identical, so `/api/match` is unaffected regardless.

## Deferred (per instruction)

Map polygon UI; backfilling unit/price/coordinate data; project pin/polygon matching; forcing lookup-only matching; a backend `matching_chats` → `sales_assistant` rename.
