# PRD: Sales Assistant — Project Matching (Phase 1 / 1.1 / 1.2)

**Status:** Live
**Last updated:** 2026-06-21
**Related PRDs:** [ai-agent.md](ai-agent.md), [copywriter-intelligence.md](copywriter-intelligence.md), [data-storage.md](data-storage.md)

## Product direction — ONE unified Sales Assistant (read first)
This is intentionally designed as **one unified sales assistant face** — **"مساعد المبيعات" / "Sales Assistant"** — with multiple internal capabilities, NOT a collection of separate assistants/pages. The salesperson opens one assistant, one chat, one conversation history, and types naturally; the assistant routes to the right internal capability. **Project matching + sales-pitch generation is the FIRST active capability.** Future capabilities — next-best-action / sales consulting, follow-up & task support, project comparison, customer understanding — will be added **inside this same assistant** (same chat, new tool + new structured card type), never as a second face or a new page.

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
| `api/match.ts` | SSE endpoint — one turn of the agent's tool-use loop; emits a `recommendation` event for the card |
| `api/_lib/matchAgent.ts` | The agent brain — system prompt, tools (`match_projects`, `get_project`, `emit_recommendation`), the deterministic two-tier search + weighted scorer |
| `src/pages/Matching/MatchingPage.tsx` | Split-pane page (session list + active thread) |
| `src/pages/Matching/components/MatchingThread.tsx` | Active thread — sends turns, consumes SSE, renders the card |
| `src/pages/Matching/components/ProjectMatchCard.tsx` | Structured recommendation card (specs, pitch, warnings, questions) |
| `src/lib/matching/client.ts` | Browser SSE stream consumer (`streamMatchTurn`) |
| `src/lib/matching/recommendation.ts` | Recommendation payload type + lenient normalizer |
| `src/data/seedModels.ts` | `matching_chats` system model (`MATCHING_CHATS_MODEL_ID`) |
| `supabase/migrations/2026-06-18_matching_chats_model.sql` | Creates the `matching_chats` model row in prod (stable id, idempotent) |
| `src/lib/__tests__/projectMatchScoring.test.ts` | Unit tests for the deterministic scorer |

## Open questions / known limitations
- **Phase 1 = no geo.** No coordinates, distance, nearby-district, or radius logic. "Nearby" recommendations and a true distance score arrive in Phase 2 (lat/lng backfill + earthdistance). Until then, location is district/city text only.
- **Lifestyle matching is best-effort** (low weight): lifestyle keywords like "family/luxury" are fuzzy-matched against Arabic amenity values; many won't literally match. Treat as a tiebreaker, not a filter.
- **Whole-portfolio scan per call** — the tool pages all `all_projects` rows and scores in TypeScript (fine at ~1,372 rows). A `project_search_index` + SQL RPC is the Phase 2 performance path.
- **Card is display-only** — no "Create follow-up / lead" action yet (candidate for a later phase, alongside the Sales Consultant capability).
