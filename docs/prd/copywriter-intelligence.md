# PRD: Real-Estate Copywriter Intelligence

**Status:** Live (Phase 1–2: knowledge base) · Phase 3 (copywriter agent) planned
**Last updated:** 2026-06-09
**Related PRDs:** [models/competitors.md](models/competitors.md) (auto-generated field list), [ai-agent.md](ai-agent.md) (the agent pattern Phase 3 mirrors), [marketing-operations.md](marketing-operations.md), [data-storage.md](data-storage.md)

## What it is (in plain English)
A system for turning hundreds of collected competitor reels (TikTok / Instagram real-estate marketing videos, auto-transcribed to Arabic text) into a **clean, structured marketing knowledge base** — and, on top of it, a specialized Saudi real-estate copywriter agent (planned).

Today (Phase 1–2): the **Competitor Library** (`competitors` model, "مكتبة المنافسين") holds each reel's raw transcript. A new **"Clean & Analyze"** button on each reel runs one AI pass that (1) *corrects* the messy auto-transcript into a clean one — fixing misheard words and broken sentences while keeping the original wording, tone, and Saudi dialect — and (2) *extracts* the marketing thinking behind it: the hook, the angle, the psychological trigger, the script structure, the tone, and the call-to-action. The whole library can also be processed in bulk with a script.

Planned (Phase 3): a copywriter chat agent that retrieves the most relevant analyzed reels (by angle / trigger / tone / hook type) plus our own project data, and writes new reel scripts, improves drafts, generates hook variations, and analyzes any script — grounded in the patterns of the strongest competitors.

## Why it exists
Auto-generated transcripts are too noisy to learn from (wrong/misheard words, broken sentences, ASR artifacts). And raw text alone isn't useful — the *value* is the repeatable persuasion patterns inside each reel. Cleaning + structuring the library first means the future agent retrieves real, correct examples and proven structures instead of guessing, and we can test quality with prompt-engineering before ever considering fine-tuning.

## Key behaviors
- **Cleaning is correction, NOT rewriting.** The AI reconstructs the most-likely original Arabic: it fixes ASR errors (e.g. `أثمان بن عفان`→`عثمان بن عفان`, `دورة ميناء`→`دورة مياه`, `الحية العارض`→`حي العارض`), preserves meaning / wording / tone / Saudi dialect / stylistic repetition (`ما شاء الله تبارك الرحمن`), strips obvious ASR artifacts (e.g. a transcription tool's credit line), and adds only light punctuation. It never summarizes, improves, translates, or invents facts.
- **Uncertain reconstructions are flagged**, not hidden — every guessed word/name is noted in **Analysis Notes** so a human can verify.
- **Analysis is grounded in the cleaned text** and returns: exact **Hook** + **Hook Type**; one-or-more **Main Angle**; one-or-more **Psychological Trigger**; **Script Structure** as an Arabic beat-chain (e.g. `خطّاف ← مشكلة ← حل ← مزايا ← دعوة`); one-or-more **Tone**; exact **CTA** + **CTA Type**.
- **Processing Status** tracks each reel through `raw → cleaned/analyzed → reviewed`, with `skipped` (empty/near-empty transcript, no AI call made) and `error` (the AI/parse failed — reason in Analysis Notes; retried on the next bulk run).
- **The same engine powers the button and the bulk script** (`api/_lib/reelAnalyst.mjs`), so per-record and bulk results are identical.
- **The structured fields ARE the retrieval index** for Phase 3 — no embeddings/vector search needed; the agent filters by angle/trigger/tone/hook-type/competitor and pulls full clean transcripts only for the few it emulates.
- **Failures surface loudly** (red toast on the button; `error` status + logged reason in bulk) — never silently swallowed (CLAUDE.md "Silent Failures").

## User flows
1. **Clean one reel (button):** open a reel in the Competitor Library → click **"Clean & Analyze"** (تنظيف وتحليل) → ~10–30s later the form refreshes with the Clean Transcript + all analysis fields filled and Processing Status = `analyzed`.
2. **Bulk-process the library (operator/Claude):** run `node scripts/backfill-reel-analysis.mjs` — pages every `reel_script` reel, skips already-done ones (idempotent), marks empties `skipped`, analyzes the rest with bounded concurrency. `--limit N` / `--ids a,b` for sampling; `--force` to reprocess.
3. **Empty/error states:** a reel with no transcript → button shows "no transcript to analyze"; in bulk it's marked `skipped`. An AI/parse failure → red toast (button) or `error` status with the reason (bulk), retried next run.
4. **(Planned) Generate a script:** open the Copywriter agent → give it a project → it retrieves matching analyzed reels + our project data → returns a full reel script / hooks / improvements / analysis with a feedback score.

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

## Open questions / known limitations
- **Phase 3 (the copywriter agent) is not built yet.** Planned shape: a `copywriter_chats` custom-UI model mirroring `ai_chats`, with `search_reels` / `get_reel` tools over this library plus the existing `search_projects` / `get_project`; an `our_script` library type so our own scripts are analyzed and retrieved alongside competitors'; methodology in the system prompt + editable `site_settings`.
- **Duplicate reels exist** in the library (same name + content imported twice) — surfaced as a list for a human to merge/delete; nothing is auto-deleted.
- **`confidence`** is returned by the engine (and logged in bulk) but not stored as a field — `analysis_notes` carries the actionable per-word uncertainty flags instead.
- A small share of reels have empty transcripts (failed ASR) and are `skipped` until a real transcript is added.
