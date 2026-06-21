# PRD: Sales Assistant (Project Matching + full sales co-pilot)

**Status:** Live — all planned capabilities shipped
**Last updated:** 2026-06-21
**Related PRDs:** [ai-agent.md](ai-agent.md), [copywriter-intelligence.md](copywriter-intelligence.md), [followups-workspace.md](followups-workspace.md), [data-storage.md](data-storage.md)

## Build status — all capabilities Complete
Every capability on the original roadmap is **built, deployed, and live-verified** on `app.wassel.re`:

| Capability | Status |
|---|---|
| Project matching (two-tier, weighted scoring) | ✅ Complete |
| Deterministic score/band pass-through (1.1) | ✅ Complete |
| Unified "Sales Assistant" face (1.2) | ✅ Complete |
| Location intelligence (lat/lng, distance, nearby tier, confidence) | ✅ Complete |
| Project comparison | ✅ Complete |
| Customer understanding / context | ✅ Complete |
| Sales consultant / next-best-action (lead temperature) | ✅ Complete |
| Message drafting | ✅ Complete |
| Task / follow-up creation (confirmation-gated, identity-safe) | ✅ Complete |
| Feedback + telemetry + admin insights | ✅ Complete |

**Current focus (post-build):** the product is feature-complete; effort now shifts to **operating it well** — driving rep adoption, collecting 👍/👎 feedback, watching usage analytics (the admin insights dashboard), reliability hardening, and validating real sales-performance impact. No new capability is planned until that signal says one is needed.

## Product direction — ONE unified Sales Assistant (read first)
This is intentionally designed as **one unified sales assistant face** — **"مساعد المبيعات" / "Sales Assistant"** — with multiple internal capabilities, NOT a collection of separate assistants/pages. The salesperson opens one assistant, one chat, one conversation history, and types naturally; the assistant routes to the right internal capability. **Project matching + sales-pitch generation is the FIRST active capability.** Future capabilities — next-best-action / sales consulting, follow-up & task support, project comparison, customer understanding — will be added **inside this same assistant** (same chat, new tool + new structured card type), never as a second face or a new page.

### One assistant, multiple SURFACES (2026-06-21)
The same assistant brain is exposed through more than one **surface** — never a second assistant product:
1. **Main Sales Assistant page** — the standalone split-pane chat at `/model/matching_chats` (persisted sessions).
2. **Follow-up record side panel** — a contextual `SalesAssistantSidePanel` embedded on the right of the **Follow-up Workspace** ([followups-workspace.md](followups-workspace.md)). It streams the **same `/api/match` brain** and renders the **same cards**; the only difference is it injects the current follow-up's client-preference **draft** (unsaved edits included) as context, so "Suggested Projects" matches against what the rep is editing live on the call — **before Save**. Panel state is ephemeral (not persisted). There is deliberately **no** "Follow-up Assistant" — it is the Sales Assistant, scoped to a follow-up.

**Naming (Phase 1.2, 2026-06-21):** the user-facing label is **مساعد المبيعات / Sales Assistant**. The technical name stays `matching_chats` and the endpoint stays `/api/match` (Option B — relabel only, no destabilizing rename of the deployed system). When future capabilities land, a backend rename to `sales_assistant` / `/api/sales-assistant` can be considered, but is not required.

## What it is (in plain English)
A live-call sales co-pilot. A salesperson on a call types what the customer wants — city, district, property type, budget, area, bedrooms, lifestyle — and the assistant instantly returns the best-matching projects, ranked, with a ready-to-say sales pitch for each. It searches **our curated projects first**; only if there's no good match there does it fall back to the broad **All Projects** database, clearly flagging those results as needing verification before being offered to the customer. It renders as a split-pane chat (past sessions on the left, the active conversation on the right) under the sidebar item **"مساعد المبيعات" (Sales Assistant)**.

## Why it exists
During a live call the salesperson needs a confident recommendation in seconds, grounded in real inventory — not a hand search through 1,372 projects, and not an AI that invents prices or availability. The assistant turns the customer's words into a ranked, fact-checked shortlist plus the exact sentence to say next.

## Full capabilities (one unified assistant — 2026-06-21)
The Sales Assistant is ONE chat that routes the salesperson's plain-language message to the right internal capability. All capabilities are tools + structured cards inside the same conversation — never a separate page/assistant.

1. **Project matching** — `match_projects` → `ProjectMatchCard`. (Detailed below.)
2. **Location intelligence** — `match_projects` is coordinate-aware. `all_projects` carries `latitude`/`longitude`/`geo_source`/`geo_confidence` (backfilled in `2026-06-21_project_geo.sql`: 300 from inline map-link coords = high confidence, 636 from district centroids = medium, 437 text-only). A candidate outside the requested district but within **12 km** of that district's centroid is a **"nearby"** match carrying a real `distance_km` (haversine); tiers are exact → nearby → same_city → partial. The agent states the real distance, never invents proximity, and flags medium-confidence (centroid) coords as approximate.
3. **Project comparison** — `compare_projects(project_ids, requirements?)` → `emit_comparison` → `ComparisonCard`: side-by-side facts, deterministic per-project fit score/band, dimension winners (cheapest / largest / most bedrooms / most available), a verdict + recommended pick.
4. **Sales consultant / next best action** — `get_customer_context(client_id|phone|name)` returns the **deterministic** lead temperature (hot/warm/cold/won/lost — computed from stage + activity recency + status), stage, status, the already-scheduled next action (type/due/overdue), and preferences → `emit_next_action` → `NextActionCard` (risk, recommended action, talking points, follow-up timing).
5. **Message drafting** — `emit_message` → `MessageCard`: WhatsApp / SMS / call-script drafts built only from real facts, with a copy button.
6. **Task / follow-up creation (confirmation-gated)** — `propose_task` NEVER writes; it surfaces a `TaskProposalCard` with an editable due date and **Confirm / Dismiss**. Only on Confirm does the client create a `followups` record (via `saveRecord`). The agent is forbidden from claiming the task was created.
7. **Customer understanding** — the agent continuously extracts/refines the customer's structured requirements from the whole conversation (the chat history is its memory); cards re-serialize into history so context carries across turns.
8. **Feedback + telemetry + admin insights** — every assistant answer carries a 👍/👎 control. 👍 saves instantly; 👎 asks "what were you trying to do?" (find project / compare / understand customer / write message / create task / other) with an optional one-line note, so a miss is tagged by the rep's actual intent. Each answer also stores **inline per-turn telemetry** (which capabilities fired, response time, whether the turn errored) on the message — no schema change, no extra write path. An admin-only **Sales Assistant insights** dashboard (`/sales/assistant-insights`, gated by `useIsAdmin`, opened from a chart icon in the session list) aggregates the conversations the admin can see: capability/card usage, helpful rate (👍/👎), requests that didn't land (by intent), written rep comments, errored turns, and average response time. The aggregation (`aggregateInsights`) is pure and unit-tested; it tolerates any malformed message shape.
9. **Find a project by name** — `search_projects(query)` resolves a named project to candidate `project_id`s (name, city, district, our_projects vs all_projects, requires_verification) so the agent can fetch its facts (`get_project`) or get the ids it needs for `compare_projects`. Powers the **"معلومات مشروع / Project Info"** quick action (info about a named project) and comparison-by-name; if more than one project matches, the agent asks which one. Added 2026-06-21 to close the long-standing gap where the prompt told the agent to "search first if you only have names" but no search tool existed.

**Deterministic-truth contract (all capabilities):** score / band / match_type / data_source / requires_verification / distance_km (matching, comparison) and lead_temperature / stage / next_action (consultant) are computed in code and quoted verbatim; the server reconciles `emit_recommendation` metadata so the model cannot re-score. The LLM only generates explanation, pitch, message, talking points, and questions — always from verified data.

## Key behaviors
- **Deterministic matching in code, narration by the AI.** The agent extracts requirements and calls one `match_projects` tool that does ALL filtering, tiering, and scoring server-side. The AI only writes prose over the verified, scored results — so it can't invent a project or fudge a score.
- **Two tiers, never mixed.** Tier 1 = projects in the `our_projects` model (curated, real units). Tier 2 = the rest of `all_projects` (scraped/competitor, unverified). The tool returns them in **separate** arrays and only includes the Tier-2 group when Tier 1 has no good match (`used_fallback`).
- **Verification warning on All Projects results.** Every Tier-2 pick carries `data_source:"all_projects"` + `requires_verification:true` and renders an amber "verify price, availability, details before offering" banner.
- **Location is coordinate-aware.** Exact district → full credit; a different district within 12 km → a "nearby" match with a real `distance_km`; else same-city → half credit. Coordinates were backfilled in pure SQL (inline map-link coords + district centroids); 437 text-only projects still match on district/city text. The assistant states the real distance and never invents proximity.
- **Weighted scoring (0–100):** location 30, budget 25, property type 20, area 10, bedrooms 8, availability 5, amenities/lifestyle 2. Dimensions the customer didn't specify are excluded and the weights renormalize, so an unspecified field neither penalizes nor inflates. Bands: strong ≥75, good ≥55, partial ≥40; below 40 is never surfaced.
- **Budget stretch:** an option up to 15% over `budget_max` is surfaced as a "stretch" (scored down, labelled). Beyond that → no budget credit.
- **Sold-out excluded by default** (`available_units = 0`), unless the request opts in.
- **Anti-hallucination:** the AI states only facts present in the tool output; missing details become "not available in the data" + a question to ask the customer. The recommendation card's specs are built only from present values.
- **Structured recommendation card** (`emit_recommendation` → `ProjectMatchCard`): per pick — name, band + score, why it matches, key specs, selling points, a copy-able pitch, verification warning (if Tier 2), and questions to ask. Plus overall clarifying questions. Display-only (no record is created).

## User flows
1. **Main happy path:** Salesperson opens Matching Assistant → "New match" → types the customer's request → the agent calls `match_projects` → a good Tier-1 (our_projects) match is found → the chat shows the ranked recommendation and a card with the pitch → salesperson reads/copies the pitch on the call.
2. **Fallback flow:** No good match in our_projects → the tool searches all_projects and returns those flagged `requires_verification` → the agent opens with the verification warning and the card shows an amber banner per pick.
3. **No exact district:** District not found → tool sets `district_exact_match:false` and returns same-city alternatives (`match_type:"same_city"`) → the agent says "no exact match in <district>, here are same-city options".
4. **Vague / thin request:** Too little to match well → the agent asks 1–2 sharp questions (budget? district? villa or apartment?) before searching.
5. **Empty / unrealistic:** Nothing scores ≥40 (or budget is unrealistic) → the agent says so plainly and names the single requirement to relax; it does not pad with weak options.

## Data touched
- **Reads:** `unified_records` (frozen-safe) for `all_projects` (the 1,372-row portfolio) and `our_projects` (the curated 11, via the `project` lookup → defines Tier 1); `models.schema` of `all_projects` for `get_project` field labels + rollup flags. All matching uses existing fields only: `project_name`, `preferred_city`, `preferred_neighborhoods`, `unit_types`, `project_status`, `preferred_amenities`, and the stored rollups `price_range` / `area_range` / `bedroom_range` / `bathroom_range` / `available_units` / `unit_count` (`{min,max}` objects + numbers).
- **Writes:** `records.data` (JSONB) on the `matching_chats` model only — each session's `messages` array, `title`, `status`, `message_count`, `last_message_at`. Nothing is written to project data. The structured recommendation is **not** persisted server-side (delivered over SSE, stored on the assistant message).

## Key files
| File | What it does |
|---|---|
| `api/match.ts` | SSE endpoint — one turn of the agent's tool-use loop; emits `recommendation` / `comparison` / `next_action` / `message_draft` / `task_proposal` events; runs identity-safe `resolveClient` before any task proposal. Shared by EVERY surface |
| `api/_lib/matchAgent.ts` | The agent brain — system prompt, all tools (`match_projects`, `get_project`, `search_projects`, `emit_recommendation`, `compare_projects`, `emit_comparison`, `get_customer_context`, `emit_next_action`, `emit_message`, `propose_task`), the deterministic geo-aware two-tier search + weighted scorer, lead-temperature, and `resolveClientFromCandidates` (never guesses on duplicate names) |
| `src/pages/Matching/MatchingPage.tsx` | Main split-pane page surface (session list + active thread); admin-only Insights link |
| `src/pages/Matching/components/MatchingThread.tsx` | Active thread — sends turns, consumes SSE, renders all card types, captures per-turn telemetry, persists 👍/👎 feedback, and runs the confirmation-gated task write |
| `src/pages/Matching/components/ProjectMatchCard.tsx` | Structured recommendation card (specs, pitch, warnings, questions) — reused by both surfaces |
| `src/pages/Matching/components/TaskProposalCard.tsx` | Confirmation-gated task card — shows resolved client name+phone, blocks Confirm when identity is ambiguous/not-found, shows save failure + retry inline |
| `src/pages/Matching/components/MessageFeedback.tsx` | Per-answer 👍/👎; 👎 expands to intent chips + optional note |
| `src/pages/Matching/AssistantInsightsPage.tsx` | Admin-only usage/feedback dashboard (`/sales/assistant-insights`) |
| `src/pages/Followups/components/SalesAssistantSidePanel.tsx` | **Follow-up surface** — contextual side panel: draft-first preference summary, "Suggested Projects" / "Project Info" quick actions, ephemeral chat, same `/api/match` brain + same cards |
| `src/lib/followups/assistantContext.ts` | Pure helper that resolves the follow-up's preferences **draft-first** (draft > saved > missing) into the UI summary + the Arabic context preface fed to `/api/match` |
| `src/lib/matching/telemetry.ts` | Telemetry + feedback types, `FEEDBACK_INTENTS`, and the pure `aggregateInsights` aggregator |
| `src/lib/matching/cards.ts` | Comparison / next-action / message / task-proposal payload types + normalizers + `serializeCardForModel` |
| `src/lib/matching/client.ts` | Browser SSE stream consumer (`streamMatchTurn`); `MatchEvent` union over all card types — used by both surfaces |
| `src/lib/matching/recommendation.ts` | Recommendation payload type + lenient normalizer (`nearby` match type + `distance_km`) |
| `src/data/seedModels.ts` | `matching_chats` system model (`MATCHING_CHATS_MODEL_ID`) |
| `supabase/migrations/2026-06-18_matching_chats_model.sql` | Creates the `matching_chats` model row in prod (stable id, idempotent) |
| `supabase/migrations/2026-06-21_project_geo.sql` | Backfills `all_projects` lat/lng + geo confidence (inline coords + district centroids) |
| `src/lib/__tests__/projectMatchScoring.test.ts` | Unit tests for the deterministic scorer |
| `src/lib/__tests__/salesAssistant.test.ts` | Unit tests — geo distance, nearby tier, lead temperature, identity resolution |
| `src/lib/__tests__/assistantInsights.test.ts` | Unit tests for `aggregateInsights` (usage, helpful rate, failed intents, malformed-input tolerance) |
| `src/lib/followups/__tests__/assistantContext.test.ts` | Unit tests for the follow-up surface's draft-first preference resolution |

## Production Learnings (write these down so we don't relearn them)
These are the hard-won lessons from building a **write-capable** sales AI. They drove real fixes in `matchAgent.ts` / `api/match.ts` and they govern any future capability that can act on the user's behalf.

1. **Identity resolution is safety-critical — the wrong customer is the unacceptable failure.** The safety hierarchy is explicit: *attaching a task to the wrong client* is unacceptable; *missing a task* is acceptable; *asking one more question* is acceptable. So the assistant must always prefer "I need one more piece of information" over "this is probably the right customer." Concretely: `resolveClient` NEVER accepts a client id echoed by the model unless it resolves to a real record, and `resolveClientFromCandidates` is exact-match-first and requires a **unique** match — it never first-match-guesses on duplicate Arabic names.

2. **A write-capable AI is a different risk class than a read-only one.** Read-only matching that's slightly wrong wastes a few seconds; a wrong write creates a real orphaned record in `followups`. Every action capability therefore (a) resolves identity deterministically in code, (b) is confirmation-gated, and (c) is forbidden from claiming success it can't prove.

3. **Ambiguity must BLOCK execution, not get resolved by a guess.** When a name matches multiple clients, the assistant must surface the candidates and refuse to proceed — at **both** resolution points (`resolveClient` for the proposal *and* `get_customer_context`, which a live test of "عبدالله" proved could otherwise feed a valid-looking id straight into `propose_task`). The `TaskProposalCard` disables **Confirm** until the rep picks a specific client.

4. **User confirmation alone is insufficient if the identity underneath it is wrong.** A rep clicking "Confirm" trusts that the name/phone on the card is who the assistant resolved — so the card must show the resolved name + phone, and `confirmTask` must write only the validated id and report success **only** when `saveRecord` actually returns `'saved'`. Confirmation gates the *action*; deterministic resolution guarantees the *subject*.

## Open questions / known limitations
- **Lifestyle matching is best-effort** (low weight): lifestyle keywords like "family/luxury" are fuzzy-matched against Arabic amenity values; many won't literally match. Treat as a tiebreaker, not a filter.
- **437 text-only projects have no coordinates.** They match on district/city text only; "nearby" distance applies just to the 936 geocoded projects (300 high-confidence inline coords + 636 medium-confidence district centroids). Medium-confidence distances are approximate and flagged as such.
- **Whole-portfolio scan per call** — the tool pages all `all_projects` rows and scores in TypeScript (fine at ~1,372 rows). A `project_search_index` + SQL RPC is the performance path if the portfolio grows materially.
- **Insights are client-aggregated over visible conversations.** The admin dashboard computes from the `matching_chats` records the current admin can see (RLS-scoped), not a server-side rollup — accurate for a single admin's view; a cross-tenant rollup would need a server aggregate.
