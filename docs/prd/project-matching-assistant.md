# PRD: Project Matching Assistant (Phase 1)

**Status:** Live
**Last updated:** 2026-06-18
**Related PRDs:** [ai-agent.md](ai-agent.md), [copywriter-intelligence.md](copywriter-intelligence.md), [data-storage.md](data-storage.md)

## What it is (in plain English)
A live-call sales co-pilot. A salesperson on a call types what the customer wants — city, district, property type, budget, area, bedrooms, lifestyle — and the assistant instantly returns the best-matching projects, ranked, with a ready-to-say sales pitch for each. It searches **our curated projects first**; only if there's no good match there does it fall back to the broad **All Projects** database, clearly flagging those results as needing verification before being offered to the customer. It renders as a split-pane chat (past sessions on the left, the active conversation on the right) under the sidebar item "Matching Assistant".

## Why it exists
During a live call the salesperson needs a confident recommendation in seconds, grounded in real inventory — not a hand search through 1,372 projects, and not an AI that invents prices or availability. The assistant turns the customer's words into a ranked, fact-checked shortlist plus the exact sentence to say next.

## Key behaviors
- **Deterministic matching in code, narration by the AI.** The agent extracts requirements and calls one `match_projects` tool that does ALL filtering, tiering, and scoring server-side. The AI only writes prose over the verified, scored results — so it can't invent a project or fudge a score.
- **Two tiers, never mixed.** Tier 1 = projects in the `our_projects` model (curated, real units). Tier 2 = the rest of `all_projects` (scraped/competitor, unverified). The tool returns them in **separate** arrays and only includes the Tier-2 group when Tier 1 has no good match (`used_fallback`).
- **Verification warning on All Projects results.** Every Tier-2 pick carries `data_source:"all_projects"` + `requires_verification:true` and renders an amber "verify price, availability, details before offering" banner.
- **Phase 1 location is text only.** District and city are matched as text (exact district → full credit; same city → half credit, labelled "same-city alternative"). There is **no coordinate/distance/nearby-district logic yet** — that's Phase 2. The assistant never claims a project is "X km away".
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
