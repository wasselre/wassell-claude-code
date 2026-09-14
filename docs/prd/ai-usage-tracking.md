# PRD: AI Usage, Cost & Credit Tracking

**Status:** Live
**Last updated:** 2026-09-14
**Related PRDs:** [internationalization.md](internationalization.md) (translation is the highest-volume AI lane), [marketing-operations.md](marketing-operations.md), [chats.md](chats.md), [copywriter-intelligence.md](copywriter-intelligence.md)

## What it is (in plain English)

Every time the app asks an AI model to do something — translate a field, draft a
WhatsApp message, read a competitor's video, summarise a client — it now writes
one line into a ledger saying what it asked, which model answered, how many
tokens it used, and what that cost. The ledger covers the whole app: the CRM API,
the background worker, and the public-website edge function.

Prices live in a separate table the operator can edit. That separation is the
whole design: the app always records *how much was used*, even for a provider
whose rate nobody has entered yet. The moment someone types that rate in, the
entire history re-prices itself. An unknown price shows as "unknown", never as
zero — so a cost report can never quietly under-report by treating an unpriced
provider as free.

On top of that sits a **credit tracker**. None of the five providers exposes a
balance an API key can read, so the operator types in what each account holds —
once, as an opening balance — and the app subtracts the metered spend from it
from that moment on. Later top-ups are added the same way. A page at
**Settings → AI Usage & Credit** shows what is left per account, the daily burn
rate, and how many days that leaves.

## Why it exists

Before 2026-09-14 only **9 of ~44 AI call sites** recorded a cost, and all nine
were in Marketing. Everything in Sales, all of translation, and both Opus-powered
agents spent money with no telemetry whatsoever. The AI bill could be read as a
single line on a vendor invoice, but there was no way to answer "which feature
caused this?", "what does one client summary cost?", or "is the cheap provider
still carrying the traffic?".

The measured spend at the time the ledger was built was **$87.50 all-time**:
Modal GPU $53.27 (competitor video processing), Anthropic $25.37, fal.ai $8.85.
Everything else — most importantly DeepSeek, the highest-volume provider in the
app — was invisible.

## Key behaviors

- **One row per model call.** Not per request, not per job: the loop inside an
  agent turn produces one row per iteration, because the iteration count is
  exactly what makes an agent turn expensive.
- **Failures are recorded too.** A call that errors still burned input tokens.
  A run of `status='error'` rows on a fallback leg is the signal that the cheap
  provider has stopped working.
- **Fallbacks are labelled.** Every row that ran because a cheaper provider
  failed carries `is_fallback` and `fallback_from`. Counting them answers "how
  often are we paying Claude prices because DeepSeek fell over?"
- **Unknown cost is never zero.** `cost_usd = NULL` with `cost_known = false`
  means the price is unknown. `cost_usd = 0` with `cost_known = true` means the
  call genuinely cost nothing (the Claude Code runner, which spends the paid
  subscription).
- **Entering a price re-costs history.** `ai_price_set(...)` upserts the rate and
  immediately re-prices every affected row, returning how many changed.
- **Non-token billing is first-class.** fal bills per generated image, fal's
  transcription per audio minute, Modal per GPU second. Those land in `units` +
  `unit_kind` instead of token columns.
- **The database is the only thing that prices a call.** Application code records
  tokens and passes a cost through only when it genuinely measured one.
- **Recording never breaks a user request.** If the ledger insert fails it is
  logged loudly to stdout and swallowed; the user's AI request still succeeds.
  There is no retry queue — a lost row is a metering gap, and the gap is visible
  in the daily view rather than hidden.

### Credit balances

- **Balances are entered, spend is automatic.** An account with no entries reads
  as "not tracked yet", never as "$0 left" — those are different statements and
  the page says which one it means.
- **Spend before tracking started is never subtracted.** Counting begins at the
  earliest credit entry's effective date, so usage that predates the opening
  balance cannot eat into it.
- **Nothing is edited in place.** A wrong figure is corrected with an
  `adjustment` entry (the only kind allowed to be negative), so the record of
  what was believed, and when, survives.
- **A balance resting on unpriced usage is labelled an upper bound.** The page
  says so on the card rather than presenting the number as fact.
- **Runway is measured, not projected.** Days remaining come from the last 30
  days of actual metered spend; with no spend in the window it shows "—".

## User flows

1. **Reading the bill.** Query `v_ai_usage_daily` — spend per day, area, call
   site, provider and model, with `unpriced_calls` alongside. If
   `unpriced_calls > 0` that day's `cost_usd` is a FLOOR, not a total.
2. **Filling in a missing price.** `select * from v_ai_usage_unpriced;` lists
   every model with recorded usage and no rate. For each, take the figure from
   the vendor's dashboard and run
   `select ai_price_set('deepseek', 'deepseek-chat', 0.28, 0.42, 0.028);`.
   The return value is how many historical rows just became costed.
3. **Attributing a spike.** Group by `call_site` — each is a stable slug naming
   one file, so a spike points at one feature rather than a department.
4. **Starting to track an account.** Settings → AI Usage & Credit → the account
   card → *Set opening balance*. Enter what the account holds right now. From
   that moment every recorded call is subtracted from it.
5. **Topping up.** Same card → *Record credit* → *Top-up*, with the amount and
   the date the money landed.
6. **Fixing a mistake.** *Record credit* → *Adjustment*, which accepts a negative
   number. The original entry stays in the history.
7. **Empty state.** A brand-new environment records nothing and says so: if
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are not both set, the recorder
   logs `AI usage is NOT being recorded in this environment` once per process.

## Data touched

- Writes: `ai_usage` (append-only, one row per model call)
- Reads/writes: `ai_price_book` (via `ai_price_set()`, admin-only)
- Reads/writes: `ai_provider_accounts`, `ai_credit_entries` (via `ai_account_upsert()`,
  `ai_credit_add()`, `ai_credit_delete()` — all admin-only, all SECURITY DEFINER)
- Reads: `v_ai_usage_daily`, `v_ai_usage_unpriced`, `v_ai_account_balances`,
  `v_ai_account_runway`
- RLS: service-role writes only; admins read. A browser cannot forge a usage row
  or write a balance directly.

## Coverage — every AI call site

| Area | Call site | Provider / model |
|---|---|---|
| Sales | `api/whatsapp/basic-reply` | Kimi K3 (ambiguous tail only) |
| Sales | `api/_lib/projectMessageAi` | Kimi K3 → Claude |
| Sales | `api/templates/listing-message` | DeepSeek → Opus 4.7 |
| Sales | `worker/runCleanTextJob` | fal flux-2 klein (per image) |
| Sales | `api/client-summary` | DeepSeek → Sonnet 4.6 |
| Sales | `api/_lib/projectFinderAI` | Haiku 4.5 |
| Sales | `api/match` | Opus 4.7 (per loop iteration) |
| Sales | `api/_lib/geoPreference/extractor` | DeepSeek → Haiku 4.5 |
| Sales | `api/_lib/prefExtract` | DeepSeek (per attempt) |
| Sales | `worker/runCallAnalysisJob` | DeepSeek |
| Translation | `worker/translateProvider` | DeepSeek → Haiku 4.5 (per batch) |
| Translation | `api/translate`, `api/value-translate`, `api/transliterate-name`, `api/market-listing/translate` | DeepSeek → Haiku 4.5 |
| Marketing | `worker/marketing/vision` | Sonnet 4.6 (creative OCR) |
| Marketing | `worker/runEnrichmentJob` | Haiku 4.5 |
| Marketing | `api/templates/posts-content` | DeepSeek → Opus 4.7 |
| Marketing | `worker/runMetaAdJob` | DeepSeek |
| Marketing | `worker/creative/imageProvider` | fal nano-banana-pro |
| Marketing | `api/icons/generate`, `api/marketing/generate` | fal nano-banana-pro |
| Marketing | `role:script_writer` / `script_reviewer` / `claim_classifier` | Opus 5 / Sonnet 5 / Haiku 4.5 |
| Marketing | `runner:*` | Claude Code runner (known $0) |
| Competitors | `worker/cv/process` | Modal GPU (largest single line) |
| Competitors | `role:shot_analyzer` / `frame_describer` | Sonnet 5 / Haiku 4.5 |
| Competitors | `worker/marketing/falTranscribe` | fal wizper (per minute) |
| Competitors | `api/analyze-reel` | Opus 4.7 → Sonnet 4.6 |
| Internal | `api/builder-agent`, `api/workflow-agent` | Opus 4.7 (per loop iteration) |
| Internal | `api/doc-assist`, `api/project-ai` | DeepSeek → Sonnet 4.6 |
| Internal | `worker/migrateAgent`, `worker/runDeckJob` | Opus 4.7 (dormant, wired anyway) |
| Website | `edge/project-details-ai-v2` | DeepSeek → Sonnet 4.6 |

## Key files

| File | What it does |
|---|---|
| `supabase/migrations/2026-09-14_ai_usage_ledger.sql` | Tables, costing trigger, `ai_price_set` / `ai_usage_recost`, views, RLS, seed prices |
| `api/_lib/aiUsage.ts` | The recorder — `recordAiUsage`, `trackedAnthropic`, `trackAnthropic`, token extractors |
| `worker/src/lib/aiUsage.ts` | **Generated** copy for the Fly worker |
| `supabase/functions/_shared/aiUsage.ts` | Deno port for edge functions |
| `scripts/sync-ai-usage-copy.mjs` | Regenerates the worker copy; `--check` fails when stale |
| `api/_lib/deepseek.ts` | Shared DeepSeek client; records inside itself, `track` is a required option |
| `api/_lib/imageGen.ts` + `worker/src/imageGen.ts` | fal queue; `pollImageGen` bills every terminal outcome |
| `worker/src/ai/roles.ts` | `callRole` / `embed` record every role-based lane centrally |
| `worker/src/marketing/cv/ledger.ts` | Records `cv_process` (the Modal call nothing else sees) |
| `api/_lib/__tests__/aiUsageCoverage.test.ts` | The guard that keeps coverage complete |
| `api/_lib/__tests__/aiUsage.test.ts` | Recorder unit tests |
| `supabase/migrations/2026-09-14_ai_credit_accounts.sql` | Accounts + credit ledger, balance/runway views, write RPCs, RLS |
| `src/pages/Settings/AiUsagePage.tsx` | The page: balances, burn rate, spend breakdown, unpriced worklist |
| `src/pages/Settings/components/AddCreditModal.tsx` | Opening balance / top-up / adjustment entry |
| `src/lib/aiUsage/client.ts` | Browser client + the pure aggregation helpers |
| `src/lib/aiUsage/__tests__/aggregation.test.ts` | Tests for the page's arithmetic |

## Open questions / known limitations

- **DeepSeek, Moonshot, Modal and fal-image prices are unset.** Tokens and units
  are being recorded in full, but those rows read as unknown cost until someone
  enters the rate from each vendor's dashboard. This is deliberate: the project's
  standing rule is that an unknown price is NULL, never a guess.
- **Modal GPU seconds are not itemised.** The `cv_process` row carries the cost
  Modal itself reports in its manifest, which is authoritative, but `units` is
  not populated — so a Modal rate change cannot be re-costed retroactively the
  way a token price can.
- **Two ledgers coexist.** `mkt_cv_cost_ledger`, `mos_creative_jobs.roles` and
  friends still keep their per-job provenance. `ai_usage` is the cross-app
  rollup; neither replaces the other, and the CV lane is careful to record
  `cv_process` in only one of them.
- **No retention policy yet.** At current volumes (~10k rows/month) this is not
  urgent, but the table grows forever.
- **Balances cannot be auto-synced.** No provider here exposes a readable
  balance, so the opening figure is only as current as the last time someone
  typed it in. If the operator tops up without recording it, the page
  under-reports what is left.
- **Spend is attributed by PROVIDER, not by key.** v1 allows exactly one active
  account per provider (a unique partial index enforces it). Two Anthropic keys
  billed separately would need per-key attribution on `ai_usage` first.
- **The authenticated page view has not been eyeballed by Claude.** The admin
  guard requires an AAL2 session (TOTP), which Claude cannot and should not
  obtain, so the page was verified by rendering it without a backend (both
  RTL and LTR), by unit tests over its arithmetic, and by proving the balance
  SQL directly. The populated view needs a human's eyes once.
