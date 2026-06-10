# PRD: Real-Estate Copywriter Intelligence

**Status:** Live (Phase 1–4 — knowledge base + copywriter agent + structured reel output → Reels records)
**Last updated:** 2026-06-10
**Related PRDs:** [models/competitors.md](models/competitors.md) (auto-generated field list), [models/reel-scripts.md](models/reel-scripts.md) (the "Reels" model the agent fills), [ai-agent.md](ai-agent.md) (the agent pattern Phase 3 mirrors), [record-management.md](record-management.md) (the prefilled record form reused), [data-storage.md](data-storage.md)

## What it is (in plain English)
A system for turning hundreds of collected competitor reels (TikTok / Instagram real-estate marketing videos, auto-transcribed to Arabic text) into a **clean, structured marketing knowledge base** — and, on top of it, a specialized Saudi real-estate **copywriter agent**.

Today (Phase 1–2): the **Competitor Library** (`competitors` model, "مكتبة المنافسين") holds each reel's raw transcript. A new **"Clean & Analyze"** button on each reel runs one AI pass that (1) *corrects* the messy auto-transcript into a clean one — fixing misheard words and broken sentences while keeping the original wording, tone, and Saudi dialect — and (2) *extracts* the marketing thinking behind it: the hook, the angle, the psychological trigger, the script structure, the tone, and the call-to-action. The whole library can also be processed in bulk with a script.

Phase 3 (live): a **Copywriter** chat agent (sidebar → "كاتب المحتوى") that retrieves the most relevant analyzed reels (by angle / trigger / tone / hook type) plus our own project data, and writes new reel scripts, improves drafts, generates hook variations, and analyzes any script — grounded in the patterns of the strongest competitors. Same split-pane chat shape as the AI sales agent; each conversation is a `copywriter_chats` record.

Phase 4 (live): the agent is now a **workflow tool, not just a chat**. The chat stays identical (discuss, revise, ask for hooks, analyze = plain text), but when it produces a **final, ready-to-film reel script** it also emits it as **structured data** (the `emit_reel_script` tool) that the chat renders as a **table inside the message** (Scene · Voiceover · Visual · On-Screen Text · Notes, plus hook / angle / CTA / alt-hooks). A **"Create Reel"** button on that table opens a brand-new **Reels** record (`reel_scripts` model), **pre-filled** with the project (linked automatically when the script was grounded in one of our projects) and the script table — for the user to review and explicitly **Save** (never auto-saved). One click turns chat output into structured CRM data.

## Why it exists
Auto-generated transcripts are too noisy to learn from (wrong/misheard words, broken sentences, ASR artifacts). And raw text alone isn't useful — the *value* is the repeatable persuasion patterns inside each reel. Cleaning + structuring the library first means the future agent retrieves real, correct examples and proven structures instead of guessing, and we can test quality with prompt-engineering before ever considering fine-tuning.

## Key behaviors
- **Cleaning is correction, NOT rewriting.** The AI reconstructs the most-likely original Arabic: it fixes ASR errors (e.g. `أثمان بن عفان`→`عثمان بن عفان`, `دورة ميناء`→`دورة مياه`, `الحية العارض`→`حي العارض`), preserves meaning / wording / tone / Saudi dialect / stylistic repetition (`ما شاء الله تبارك الرحمن`), strips obvious ASR artifacts (e.g. a transcription tool's credit line), and adds only light punctuation. It never summarizes, improves, translates, or invents facts.
- **Uncertain reconstructions are flagged**, not hidden — every guessed word/name is noted in **Analysis Notes** so a human can verify.
- **Analysis is grounded in the cleaned text** and returns: exact **Hook** + **Hook Type**; one-or-more **Main Angle**; one-or-more **Psychological Trigger**; **Script Structure** as an Arabic beat-chain (e.g. `خطّاف ← مشكلة ← حل ← مزايا ← دعوة`); one-or-more **Tone**; exact **CTA** + **CTA Type**.
- **Processing Status** tracks each reel through `raw → cleaned/analyzed → reviewed`, with `skipped` (empty/near-empty transcript, no AI call made) and `error` (the AI/parse failed — reason in Analysis Notes; retried on the next bulk run).
- **The same engine powers the button and the bulk script** (`api/_lib/reelAnalyst.mjs`), so per-record and bulk results are identical.
- **The structured fields ARE the retrieval index** for Phase 3 — no embeddings/vector search needed; the agent filters by angle/trigger/tone/hook-type/competitor and pulls full clean transcripts only for the few it emulates.
- **A finished script becomes structured data, then a record (Phase 4).** The agent calls `emit_reel_script` ONLY for a complete reel script (GENERATE / IMPROVE) — never for a hooks list or an analysis (those stay plain chat). The payload (`title`, `hook`, `angle`, `cta`, `alt_hooks`, optional brief fields, the `project_id` it got from `get_project`, and a `scenes[]` body) streams as a `reel_script` SSE event, renders as a table in the message, and maps 1:1 onto the `reel_scripts` model on **Create Reel**. The structured script is also re-serialized into the model's view of history (not the UI) so revisions stay grounded. **Nothing is auto-saved** — the prefilled record form (reused `RecordFormModal`) requires an explicit Save (CLAUDE.md anti-silent-failure posture).
- **Failures surface loudly** (red toast on the button; `error` status + logged reason in bulk) — never silently swallowed (CLAUDE.md "Silent Failures").

## User flows
1. **Clean one reel (button):** open a reel in the Competitor Library → click **"Clean & Analyze"** (تنظيف وتحليل) → ~10–30s later the form refreshes with the Clean Transcript + all analysis fields filled and Processing Status = `analyzed`.
2. **Bulk-process the library (operator/Claude):** run `node scripts/backfill-reel-analysis.mjs` — pages every `reel_script` reel, skips already-done ones (idempotent), marks empties `skipped`, analyzes the rest with bounded concurrency. `--limit N` / `--ids a,b` for sampling; `--force` to reprocess.
3. **Empty/error states:** a reel with no transcript → button shows "no transcript to analyze"; in bulk it's marked `skipped`. An AI/parse failure → red toast (button) or `error` status with the reason (bulk), retried next run.
4. **Generate / improve / analyze a script (Copywriter agent):** open **Copywriter** (sidebar) → New chat → ask in plain Arabic (e.g. "اكتب نص ريل لمشروع X"). The agent calls `search_projects`/`get_project` for our real facts and `search_reels`/`get_reel` for proven patterns, then writes a grounded reel script (hook → scene beats → CTA + alternative hooks), improves a pasted draft, generates hook variations, or analyzes any script. Rate the result via the conversation's Feedback Score.
5. **Chat → structured script → Reel record (Phase 4):** when the agent finishes a full reel script, it renders a **structured table** in the message with a **"Create Reel / إنشاء ريل"** button. Click it → a new **Reels** record opens **pre-filled** (project linked + the script table + hook / angle / CTA / brief fields) → review and edit anything → click **Save** → it becomes a normal `reel_scripts` record and opens. (Asking only for hooks or for an analysis stays plain chat text — no table, no button.)

## Data touched
- **Reads/Writes:** `records.data` (JSONB) for the `competitors` model — adds `clean_content`, `hook`, `hook_type`, `angle[]`, `psych_trigger[]`, `structure`, `tone[]`, `cta`, `cta_type`, `analysis_notes`, `processing_status`. Existing `content` (raw transcript) and `notes` (source metadata: date · platform · Drive URL) are never overwritten.
- **Writes via** the `record_save` RPC (optimistic concurrency + retry), frozen-safe.
- **Model schema:** the 11 fields + the `analyze_reel` custom button live in `models.schema` for `competitors` (added by the migration below; mirrored in `seedModels.ts`).
- **External:** Anthropic Messages API (one forced-tool call per reel, `claude-opus-4-7`).

## Key files
| File | What it does |
|---|---|
| `api/_lib/reelAnalyst.mjs` | The shared clean+analyze engine (forced-tool Anthropic call, prompt, validation). Single source of truth. |
| `api/analyze-reel.ts` | `POST /api/analyze-reel` — the per-record button endpoint (edge, withAuth, record_save). |
| `scripts/backfill-reel-analysis.mjs` | Bulk runner over the whole library (service-role, idempotent, concurrency). |
| `supabase/migrations/2026-06-09_competitor_reel_analysis_fields.sql` | Adds the 11 analysis fields + the "Clean & Analyze" button to the live `competitors` schema. |
| `src/data/seedModels.ts` | Canonical `competitors` model definition (fields + button), kept in sync with the migration. |
| `src/types/index.ts` · `src/pages/Records/RecordFormPage.tsx` · `src/pages/Builder/components/CustomButtonsTab.tsx` | The `analyze_reel` custom-button action type + its dispatch + Builder display. |
| **Phase 3 — Copywriter agent** | |
| `api/_lib/copywriterAgent.ts` | The agent brain: system prompt (methodology) + all four tool executors. `search_reels`/`get_reel` over the reel library; `search_projects`/`get_project` scoped to **`all_projects`** — `get_project` returns a fact sheet splitting `details` (team-entered) from `calculated`, and **computes the rollups LIVE from the project's units** (price/area/bedroom/bathroom ranges, unit counts, price per m²) the same way the app does — because those `is_computed` values are NOT persisted in `records.data`, so reading the stored slot wrongly reported "no numbers" for projects whose form shows them. Rollup math is ported from `src/lib/ourProjectsRollup.ts` (keep in sync). |
| `api/copywriter.ts` | `POST /api/copywriter` — SSE tool-use loop (edge), clone of `api/agent.ts`. |
| `src/lib/copywriter/client.ts` | Browser SSE client (`streamCopywriterTurn`). |
| `src/pages/Copywriter/CopywriterPage.tsx` · `components/CopywriterThread.tsx` | Split-pane chat UI (list + thread), clone of the AI sales agent's. The thread now also catches the `reel_script` event, renders the table card, persists the structured script on the message, and opens the Create-Reel form. |
| `src/data/seedModels.ts` · `src/App.tsx` | `copywriter_chats` model seed (mirrors `ai_chats`) + the route dispatch in both dispatchers. |
| **Phase 4 — Structured reel script → Reels record** | |
| `api/_lib/copywriterAgent.ts` · `api/copywriter.ts` | The `emit_reel_script` tool + system-prompt rule (call it only for a finished script); the endpoint surfaces its input to the browser as a `reel_script` SSE event. |
| `src/lib/copywriter/reelScript.ts` | `ReelScript` type + helpers: `normalizeReelScript` (coerce untrusted tool input), `reelScriptToPrefill` (→ `reel_scripts` field slugs), `serializeReelScriptForModel` (re-ground revisions). |
| `src/lib/copywriter/client.ts` | Adds the `reel_script` event to the SSE union. |
| `src/pages/Copywriter/components/ReelScriptCard.tsx` | Renders a structured script as a table + the **Create Reel** button. |
| `src/pages/Records/components/RecordFormModal.tsx` | **Reused as-is** — opens the prefilled new Reels record with explicit Save (no auto-save). |
| `src/data/seedModels.ts` (`reelScriptsModel`) · `supabase/migrations/2026-06-10_reel_scripts_model.sql` | The new **Reels** model (`reel_scripts`). Seed for fresh installs (project lookup → seed all_projects); SQL migration for prod (lookup → LIVE all_projects `220c49b9…`). Slug is `reel_scripts`, NOT `reels` (retired). See [models/reel-scripts.md](models/reel-scripts.md). |

## Open questions / known limitations
- **Our own scripts:** the `our_script` library type exists so our past scripts can be added (via the Competitor Library, then "Clean & Analyze") and retrieved alongside competitors' — but none are loaded yet, so `search_reels` currently returns competitor reels only. The agent's methodology lives in the system prompt (`api/_lib/copywriterAgent.ts`); making it editable in `site_settings` is future work.
- **Retrieval is in-memory filtering** over the analyzed library (a few hundred rows), ranked by facet overlap (angle/trigger/tone) + free-text — no embeddings. Fine at this scale; revisit with pgvector only if the library grows into the thousands and semantic recall matters.
- **Duplicate reels exist** in the library (same name + content imported twice) — surfaced as a list for a human to merge/delete; nothing is auto-deleted.
- **`confidence`** is returned by the engine (and logged in bulk) but not stored as a field — `analysis_notes` carries the actionable per-word uncertainty flags instead.
- A small share of reels have empty transcripts (failed ASR) and are `skipped` until a real transcript is added.
