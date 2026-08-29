# Market-ingest session handoff — 2026-08-29

Read this first if you're picking up the Aqar market-ingest / Market Automation
cockpit work. It captures the live state, what changed this session, the one thing
blocking all of it, and the exact commands/IDs a fresh session needs. Pair it with
`README.md`, `gate-a.md`, and the "Frozen models" section of the root `CLAUDE.md`.

---

## 0. THE BLOCKER — read this before anything else

**The Aqar scraper has not run since 2026-08-20.** Everything built this session
(and any earlier undeployed extraction change) produces NO new data until it runs.

- Fly app `aqar-sync-rayan`, machine `84042eb24417e8`, `MODE=dailysync`,
  `schedule="daily"` — but Fly's scheduler has not fired since 08-20. Last machine
  event was a deploy, not a scheduled run.
- Nothing is broken in the code; the schedule simply isn't triggering.
- **First action for the next session (with the operator's OK):** trigger a run now
  and fix the daily schedule so it runs unattended. A manual run:
  `flyctl machine start 84042eb24417e8 --app aqar-sync-rayan` (it runs
  `src/sync/index.ts && src/sync/pushToCrm.ts` then exits; Fly won't auto-restart an
  exit-0 machine — that's expected). Investigate why `schedule="daily"` isn't firing
  (check `flyctl machine status`, the machine's schedule config, and Fly's
  scheduled-machine support for this org).

Until this is fixed, treat every "shipped" item below as **built + verified, not yet
producing data**.

---

## 1. Systems, IDs, and how to deploy each

| Thing | Where | Deploy |
|---|---|---|
| **App (CRM SPA + /api)** | this repo (`wassell-claude-code`), worktree on branch `claude/market-ingest-aqar-handoff-bd7083` | `git fetch origin main && git rebase origin/main && git push origin HEAD:main` → Vercel auto-builds. Verify SHA READY via Vercel MCP, then smoke-test live. |
| **Aqar scraper** | separate repo `C:/Users/rayan/Claude/aqar-scraper` (NOT a worktree) | `export FLY_API_TOKEN=$(grep access_token ~/.fly/config.yml \| sed ...)` then `flyctl deploy --app aqar-sync-rayan`. Deploy = live; there is no "push to main" for it. |
| **Database** | Supabase project `zhqqsxwealdwqzrbpwyv` | Apply migrations yourself via the Supabase MCP `apply_migration` (never ask). Write the file under `supabase/migrations/` too. |

Key IDs:
- `market_listings` model id: **`8f06bc39-4bee-42e9-9fab-77023fb89ede`**
- Vercel project `prj_4ObF1mUW9KmmhFJDkoHCD0MZzJEh`, team `team_3UCVfsGz7gmIizM7AsVfczzW`
- `market_listings` is **FROZEN** (`is_hardcoded=true`, physical table, ~318k rows,
  ~4.85 GB). Reads via `market_listings_v` → `unified_records`; writes via
  `record_save` / `market_listing_write` (the gated write). NEVER write `records`
  for it. See CLAUDE.md "Frozen models" + "market_listings is FROZEN".

Browser testing of the live app needs a minted session (TOTP blocks self-login):
admin `generate_link` (magiclink) → `verify` → inject the session JSON into
`localStorage['sb-zhqqsxwealdwqzrbpwyv-auth-token']` → navigate. **Load the app at
`/` first (client-side nav to the target) — a direct deep-load races the records
boot and can hang on a blank screen (known slow-boot / `unified_records` timeout).**
Revoke with `/auth/v1/logout?scope=local` after. Service-role key is in the main
tree's `.env.local` (`SUPABASE_SERVICE_ROLE_KEY`); a fresh worktree has no `.env` —
copy it in (and delete it after; it's gitignored).

---

## 2. What shipped this session

### A. Sold detection — `closed` as a supplementary signal (scraper, LIVE)
Sold was disappearance-only (weekly full reconcile marks listings that vanish).
Now the extractor also reads Aqar's `listing.closed`; the adapter sets
`is_active=false` + `sold_at` when `closed=true` (catches "still listed but closed").
Governance: `listing.closed` = intentionally_ignored **as a mapping**, with a reason
documenting it IS consumed as a sold signal (kept out of the extras sweep). Files:
`src/rsc.ts`, `src/extractListing.ts`, `src/schema.ts`, `src/sync/crmClient.ts`.

### B. Features — read Aqar's structured array + keep per-flag safety net (scraper, LIVE)
`listing.features` is Aqar's STRUCTURED amenity list (`[{name,label,value}]`) with
clean Arabic labels — read it directly (via the label). ALSO keep the operator's 19
per-flag amenity mappings (`listing.pool → مسبح`, etc.) as a union safety net,
de-duplicated; two mismatched labels were aligned to Aqar's wording
(`مدخلان→مدخلين`, `شقة في فيلا→في فيلا`). `features` is released in the publish
ledger. **Lesson: don't reverse an operator's explicit mapping without asking — I
did once this session and had to restore it.**

### C. Property type + offer type split (scraper LIVE + frozen migration LIVE)
Aqar's `listing.categoryName` = type + transaction ("شقق للبيع"). The adapter now
splits it:
- **`property_type`** ← clean, normalized singular ("شقة", "فيلا", "أرض", "دور",
  "عمارة", "استراحة", …). Overrides the LLM guess for Aqar.
- **`offer_type`** (NEW frozen column) ← `sale`/`rent`, from the transaction suffix
  with a rent-signal fallback (`daily_rentable`/`rent_period`), default `sale`.
- Migration `supabase/migrations/2026-08-23_market_offer_type.sql` added the column
  + dropdown schema (بيع/إيجار) + the full view-chain unwind. `offer_type` released
  in the ledger. Governance: `listing.categoryName → property_type` (offer_type half
  is adapter logic). **New scrapes only — existing rows NOT backfilled** (operator's
  choice). Existing `property_type` stays messy (mixed EN/AR + some "X للبيع") until
  re-scraped; the legacy `category` (combined slug) and `purpose` ("Sale") fields
  are left untouched.

### D. Cockpit UX overhaul (app, commits on main)
- `478190ab` — filter bar (search + status chips) + Save & Next.
- `8f27db04` — full-page review mode (replaced the drawer) + Prev/Next + ←/→ keys +
  gamification (progress bar, streak, XP, level, completion celebration).
- `4b840ca0` — progress bar counts **THIS session's** decisions, not the global
  already-decided count (`راجعت X من Y في هذه الجلسة` + muted global-remaining note).
- `3170fdc5` — the offer_type migration file. **COMMITTED LOCALLY, NOT PUSHED.**
  The DB change is already applied to prod; this commit is just the record. Push it
  (rebase + push to main) when convenient — it's safe (a migration file doesn't
  change app behavior).

Files: `src/pages/MarketAutomation/MarketAutomationPage.tsx`,
`src/pages/MarketAutomation/components/DecisionPanel.tsx`,
`src/lib/marketAutomation/client.ts`.

---

## 3. Governance / publish-gate model (how the cockpit works)

- **Gate A tables**: `source_field_catalog` (evidence + example values),
  `source_field_mappings` (the decision authority), `v_source_field_status` (the view
  the cockpit reads). Decisions via the `source_field_decide(platform, source_path,
  status, canonical_field, transformation, reason)` RPC.
- **Publish gate**: `market_listing_publish_ledger` (per-canonical released/held) +
  `market_listing_write(id, patch)` (splits the patch: released canonicals → live via
  `record_save`; held → `market_listing_staging`). A canonical is **held** iff some
  source maps to it AND it's not `released`. `market_listing_publish_set(platform,
  field, status, reason)` toggles the ledger.
- **Gotcha proven this session:** mapping a source to a canonical that isn't released
  silently diverts that field to staging on the next scan. When you map something,
  either the canonical is already released, or release it. (`features`, `offer_type`,
  `property_type` are all released.)

---

## 4. Frozen-model migration — what actually bit this session

The runbook is in CLAUDE.md ("Frozen models" → "Unwinding the view chain"). Two
things to internalize:

1. **The dependency graph GROWS — always re-derive it.** This session the graph was
   `market_listings ← {market_listings_v, market_listings_summary, v_market_listings}`;
   `market_listings_v ← unified_records`;
   `unified_records ← {v_market_properties, v_our_projects_scope, v_website_public}`.
2. **`unified_records` also has a POLICY dependency the view-only query misses:** the
   `file_links_select` RLS policy on `file_links` references `unified_records`. A plain
   `DROP VIEW unified_records` fails with `2BP01` until you drop that policy too, then
   recreate it after `rebuild_unified_records()`. (Now documented in CLAUDE.md.)
   Re-check for policy deps with:
   `select tablename, policyname, qual from pg_policies where qual like '%unified_records%';`
3. Load-bearing details that must be restored verbatim: `v_our_projects_scope` is NOT
   security_invoker; `v_website_public` is `security_invoker=false`;
   `v_market_properties` has grants for **postgres + service_role ONLY** (re-`REVOKE`
   anon/authenticated after recreating). `regenerate_frozen_model_artifacts` rebuilds
   `<name>_v` + the 4 RLS policies from `models.schema` (update the JSONB BEFORE
   calling it); `rebuild_unified_records()` rebuilds the UNION. `<name>_v` uses
   `jsonb_strip_nulls`, so a new column with all-null values is ABSENT from `data`
   until a row has a non-null value — that's expected, not a bug.

---

## 5. Pending / not done

- **Fix the scraper schedule (BLOCKER — §0).**
- Push commit `3170fdc5` (offer_type migration file) to main — safe, record-only.
- Backfill existing 318k rows' `property_type`/`offer_type` — operator declined for
  now (chose "new scrapes only"). If revisited: Aqar rows are parseable from their
  existing `category` slug ("شقق-للبيع"), Bayut rows from `purpose` ("Sale").
- `property_type` is still bilingual-messy across Aqar (Arabic) + Bayut (English) —
  a cross-platform normalization is a separate, larger task.
- Second portal (Bayut) extraction/adapter; video mirror/convert lane; Gate B
  (storage enforcement) — all still open per README.
- After the scraper runs: run `npm run sync:prds` to regenerate
  `docs/prd/models/market_listings.md` (it now has `offer_type`).

---

## 6. Standing operator preferences (in force)

- **Apply migrations yourself — never ask.** "push"/"go" = rebase + direct push to
  main (no PR), then verify the Vercel SHA + smoke-test live.
- **No unasked pushes/migrations to the APP** beyond what's requested; batch edits,
  deploy on command. (Scraper deploys to Fly have been done per-change this session.)
- Every technical explanation needs a plain-language version. Never silently swallow
  errors. Never cap/truncate results silently. Don't reverse an operator's explicit
  decision without confirming.
