# PRD: Competitor Watch (مرصد المنافسين)

**Status:** Live (all five surfaces: Content Library + Agents & runs, Content pipeline, Storage, Companies)
**Last updated:** 2026-09-29 (**Transcripts in the language that was spoken.** New video transcriptions ask fal for language auto-detect instead of omitting the key — omitted, fal defaults to English, which is why 840 competitor transcripts (2026-07-23 → 2026-09-28) were English translations of Saudi Arabic speech. The historical rows are repaired in place by `scripts/retranscribe-arabic.mjs --backfill` (≈ $12, operator-run, metered). Also earlier today: **One Companies list.** Every watched company is now a record in the CRM Companies list (the old Developers model, relabelled «الشركات», with a required مطوّر / مسوّق type) and its watch-entry type follows that record. 41 watched companies that were in no CRM list got a Companies record; 11 duplicate company rows were merged; ذراع and آبه are marketers. A project now names ONE developer and ANY number of marketers, and every marketer it names becomes an `authorized_marketer` link here — see `mkt_project_organizations` under «Data touched». A company created, renamed, retyped or deleted in the CRM updates its watch entry automatically.) | 2026-09-29 (**The «المعلنون المدفوعون» Settings page was deleted** — competitor paid-ad collection has no screen now. Nothing collected paid ads through it after 2026-07-22: 27 advertiser look-ups (last 2026-07-28), zero `paid_ads` queue jobs; the 10 stored paid ads (`mkt_paid_ads`, all 2026-07-22) stay. Server actions + data kept. See the new bullet under «How collection runs».) | 2026-09-28 (**Creating a project works again.** The attribution catch-up that runs inside every project insert (`mkt_enqueue_attribution_rerun`) took 68 s and timed the save out, so no project could be created from the app since ~2026-09-14; rewritten set-based, now 165 ms with the same jobs queued.) | 2026-09-27 (**Relationships follow the project records** — a project's marketer in the CRM now becomes its marketer here automatically, and stale copies are retired; see `mkt_project_organizations` under «Data touched».) Also 2026-09-27 (**Companies surface rebuilt around the marketing read** — type, channels, cadence, format mix, dominant message, offers, projects and districts per competitor; «آخر نشاط» was our scrape time and is now «آخر نشر», theirs.) Previously 2026-09-21 (**Collection made budget-aware** — see «How collection runs, and what it costs» below: incremental runs fetch only posts newer than the last stored one plus a 14-day engagement window, TikTok downloads only new videos, Apify storage is cleaned up, dormant accounts are checked weekly, and a spent Apify budget pauses collection with one alert instead of retrying for weeks.) Previously 2026-09-13 (**Project attribution rebuilt** — see «How a post gets its project» below: brand/place words are no longer evidence, full names are matched as phrases, a pick must carry a verbatim quote, corrections lock the post, and the Library has a «تصحيح المشروع» control.)

> A NEW, from-scratch workspace that succeeds the **Marketing Intelligence**
> page (`marketing-intelligence.md`), built because the operator found that page
> unusable ("it's ugly, I can't use it"). Same underlying `mkt_*` competitor data;
> completely separate UI, deliberately not built on the old components. The old
> `/marketing-intelligence` page is left intact and untouched.

## What it is (in plain English)

A control-room workspace for watching competitors' marketing, at `/competitor-watch`
(admin-only), with five surfaces switched from a sub-nav: the **Content Library**
("the shelves") plus four monitoring surfaces — **Agents & runs** (what's running,
what it did today, from which accounts), **Content pipeline** (each stage's counts +
where posts stand), **Storage** (bytes by media type and by company), and
**Companies** (every competitor, their accounts, and how much we've collected,
expand a row for the per-account breakdown). Each surface is backed by its own
read-only gathering RPC.

The **Content Library** surfaces the labels the file/enrichment AI has *already*
computed for every scraped competitor post — but which sit scattered across
`mkt_content_posts` + `mkt_content_enrichment` + `mkt_transcripts`. It gathers them
into one searchable list: one entry per post, labeled by competitor, project,
format, **purpose (the 7 content-types = the shelves)**, platform, the extracted
facts, the words, and date.

## Why it exists

The competitor "understanding" pipeline reads and structures thousands of posts,
but there was no place to *browse and search* that reading — the transcripts,
descriptions, selling points and facts were query-only, split across four tables.
The Library is that surface, and it is the foundation for future "learner" agents
that study the corpus (how competitors write posts, script reels, price offers).

## Key behaviors

- **The shelves are by PURPOSE**, and they are the AI's own read, not a new
  classification: the 7 `content_type` values already stamped on every post —
  brand · project_launch · event · walkthrough · offer · teaser · testimonial
  (plus an "unclassified" shelf for the handful with none). Shelf counts are a
  server-side facet over the filtered set.
- **Nothing here is a fresh AI call.** The page reads labels the enrichment
  pipeline already produced; the gathering is one SQL RPC (`mkt_content_library`).
- **Every entry is labeled with** competitor · project (resolved to the real
  project name) · format · purpose · platform · facts (unit type, offer, price,
  payment plan, district, CTA) · the words (caption + transcript flag) · date.
- **Filter + search:** free-text over caption + campaign message + objective;
  chips for format, platform, and "has an offer"; clicking a competitor's name
  filters to them. Active filters show as removable chips.
- **Read full** expands an entry to its caption, selling points, amenities, a
  transcript-present note, and a link to the original post.
- **How a post gets its project (rebuilt 2026-09-13).** Two steps, both
  bounded. (1) A deterministic matcher in the worker builds a SMALL candidate
  list from the publisher's projects — the relationship table ∪ every catalog
  project whose `developer` is the publisher (kept live by trigger). Since
  2026-09-27 the relationship table also follows each project's **marketer**
  field, so a marketer such as ريفا gets every project the CRM says it markets
  (it had 14 of its 20 our_projects before). Projects on the publisher's list
  match on a partial mention; any other project needs its full name. The whole
  project name matched as a phrase (also `#hashtag_form`, parenthesised and
  dash-segment variants) is strong; a distinctive number is strong; ONE lone
  word is weak. The publisher's own brand words, district/city names and
  generic real-estate words are never evidence on their own — so «عزوم»,
  «ديارا», «جنوب الربوة» cannot link a post. Each candidate carries
  `strength` (full_name | number | word) and `ambiguous`. (2) The Claude runner
  picks from that list ONLY, and must return an `evidence_quote` — a verbatim
  excerpt that names the project (not merely the brand). The validator checks
  the quote exists in the caption/OCR/transcript and names the project; a pick
  without valid proof is downgraded to «no project» with the reason recorded.
  Projects the post names that are not candidates come back as
  `mentioned_projects` and show on the entry as «مشروع غير مسجّل» — the catalog
  gap becomes visible instead of being forced onto the nearest sibling.
- **Weak links are marked.** An entry whose link rests on a lone word shows
  «؟ ربط ضعيف»; one a person fixed shows «🔒 مثبّت».
- **«تصحيح المشروع» / «اربط بمشروع» (admins):** on any entry, search the live
  All Projects catalog and pick the right project, or choose «لا مشروع — هوية
  عامة». One RPC (`mkt_attribution_set`) writes BOTH the Library pointer and
  the attribution rows as confirmed and LOCKS the post: every machine
  re-decision (runner upsert, re-narrow) keeps a locked project. The «تأكيد
  الروابط» Y/N surface now goes through the same lock.
- **Re-linking everything is cheap.** `mkt_enqueue_attribution_rerun` queues an
  attribution-only pass (`content_process` with `mode=narrow_only`) that
  re-scores candidates from stored evidence — no download, no vision — resets
  machine attributions and hands changed posts back to the runner. Locked
  posts are skipped.
- **A project added later catches up by itself.** Inserting an All Projects
  record, renaming one, or changing its developer (and linking a developer to
  a tracked organization) enqueues an attribution-only re-score of EVERY post
  of EVERY company (`records_rescore_on_project_insert` / `_update`,
  `mkt_organizations_rescore_on_developer_change` →
  `mkt_rescore_project_organizations` → `mkt_enqueue_attribution_rerun(NULL)`,
  2026-09-14) — not only the project's own developer, because a marketer's
  earlier post about the new project (ريفا about أكنان 23) must be caught too.
  Unchanged posts are skipped in milliseconds; only posts that now match reach
  the AI. Plain data writes that
  do not touch the name or developer (unit rollups) never fire it — verified
  live: inserting a test project for أكدال enqueued exactly its 47 posts, a
  no-op update on ربوة الرمز enqueued nothing.
- **The catch-up must stay fast, because it runs inside the project save
  (fixed 2026-09-28).** `mkt_enqueue_attribution_rerun` used to loop over
  ~3,500 posts and, for each one, scan all ~70k collection jobs to check
  whether one was already in flight — measured 68 s. The app's save gives up
  long before that, so **no project could be created from the app from about
  2026-09-14** (the last successful create was 2026-09-07): the save failed and
  rolled back. It is now one set-based pass (collect in-flight posts once, then
  insert every missing job in one statement): 165 ms, same jobs queued
  (`supabase/migrations/2026-09-28_attribution_rerun_set_based.sql`).
- **Into the Files system (2026-09-13).** Once a post has a project, its
  stored photos/videos are registered as `files` rows and linked to that
  project (derived origin `social`), so they show on the project's Files tab,
  in the Business Library and in the WhatsApp picker. The entry shows «في
  الملفات (n)». Rights: sendable when the project is one of ours (any publisher) or the
  publisher is the project's developer; a rival's content about a rival's
  project stays internal only. Details in `files.md`
  («Social-media intake»).
- **Attribution health on the Pipeline surface:** linked · fixed by a person ·
  linked without a quote naming the project · link rests on one word · names an
  unknown project · awaiting decision · queued for re-linking. These are the
  exact checks that exposed the September 2026 mis-links.
- **Design-read chip (2026-09-02):** expanding an entry lazily fetches its
  `visual_design_reads` (`design_read_get`); when a read exists a «قراءة
  تصميم» chip shows on the entry and the expanded view renders a one-line
  summary (layout, density, palette family, branding intensity, or the
  post-level arc summary). No read → nothing renders, no error.
- **«مثال للدراسة» (2026-09-02, admins only):** registers the post into
  `mos_design_examples` as `study_only` via `design_example_set` — strengths /
  caveats / note captured inline. Saved examples read «في سجل الأمثلة» and
  feed the Creative Director's reference retrieval and the brand kit's
  approved-examples registry.
- **Honest gaps rendered, not hidden:** a shelf/facet with no items is shown as
  its real count; the full spoken-transcript TEXT is not yet inlined (only a
  "transcript exists" flag) — flagged in-UI as a coming update.
- Bilingual AR/EN, RTL-correct; its own scoped design system (`.cw-root`).
- **Companies = who they are and what they market (rebuilt 2026-09-27).** The
  surface leads with the competitor, their **type** (مطوّر / مسوّق, filterable,
  with counts), and then their marketing behaviour, all of it read from posts the
  pipeline had already enriched but never gathered per company:
  - **Publishing, not collecting.** Columns are posts in the last 90 days, posts
    per week, and **«آخر نشر» — when THEY last published**. The old «آخر نشاط»
    column showed when WE last scraped, which says nothing about a competitor;
    pull time now sits inside each account row where it belongs.
  - **Channels** as compact platform chips (IG · TT · YT), dimmed when collection
    for that account is off, with handle and post count on hover.
  - **Format mix** as one proportional bar (video / image / carousel) and the
    **dominant message** as a pill with its share — the top of the 7 content
    types the enrichment already stamps (إطلاق مشروع · عرض · جولة · علامة ·
    تشويق · فعالية · شهادة).
  - **Offers** counted per company, with the latest offer line quoted verbatim
    and dated in the expanded view.
  - **Expanding a row** gives three cards: what they publish (all 7 purposes as
    bars), what they talk about (top projects + top districts, district names
    folded so «حي النرجس» and «النرجس» are one), and performance + channels
    (average views/likes, posts 30d, totals collected, website, and each account with
    its cadence and last post).
  - **Search + sort** across company, handle and project name; sort by most
    active (90d), most posts, most recent post, or name.
  - Empty stays empty: a company with no read posts says so, a missing follower
    count shows «—», never a fake zero.
- **How collection runs, and what it costs (rebuilt 2026-09-21).** Instagram and
  TikTok posts are fetched through Apify (paid per post, $29/month plan limit);
  YouTube through the free YouTube API. Measured before the rebuild: 9,961 posts
  paid for in one cycle, 221 new, budget gone on day 14, nothing collected for the
  rest of the month. Now:
  - **Only what can have changed.** A scheduled run asks for posts newer than
    the last one we stored, and never less than the last 14 days so recent posts'
    likes/views keep updating. After a gap the window reaches back to the last
    stored post, so nothing is skipped. A run that hits its ceiling (30, or 100
    when catching up) is marked partial with a warning, never silently cut.
  - **TikTok in two passes.** A metadata pass (no downloads) finds new videos;
    a second pass downloads only those. Instagram media comes from Instagram's
    own CDN.
  - **Apify storage is deleted** once read (metadata) or once our copy of the
    video exists (downloads) — stage 8 of the content sweep, 25 runs per tick.
  - **Schedule.** Once per Riyadh calendar day per account (was every 20 h,
    i.e. 1.2×/day). An account with no post in 30 days, or none ever, is checked
    weekly and returns to daily by itself when it posts again. An account's
    `cadence.incremental = 'weekly'` is honoured.
  - **A spent budget pauses, it does not retry.** Apify's "monthly usage hard
    limit" (403) / "not enough usage" (402) is classified `budget_exhausted`. The
    provider is paused until the billing cycle Apify reports renews
    (`mkt_providers.paused_until`), its queued jobs are cancelled, ONE critical
    alert «نفدت ميزانية apify الشهرية» appears on Settings → Marketing Ops, and
    admins get one push notification. The pause lifts itself at renewal and the
    alert resolves. Paused providers no longer occupy scheduler slots, which had
    starved YouTube collection for 16 days. Settings → Marketing Ops' manual
    health check also reads the limit, so it shows `budget_exhausted` with the
    spend instead of "connected".
- **Competitor PAID-ad collection has no screen any more (2026-09-29).** The
  Settings page «المعلنون المدفوعون» (`/settings/marketing-advertisers`), the admin
  screen for finding and confirming a competitor's advertiser account and
  starting paid-ad collection, was deleted (architecture
  cleanup D07b); the old URL now opens the Settings home. Measured before
  deleting: the only jobs that page ever ran were 27 advertiser look-ups
  (`discover_advertiser`, last on 2026-07-28), not one paid-ad collection
  (`paid_ads`) queue job ever ran, and nothing enqueues either kind on its own.
  `mkt_paid_ads` does hold 10 competitor paid ads, all from 2026-07-22 (an early
  one-off collection); they are kept and still readable. So in practice this
  retires a feature idle since July — organic posts, reels,
  OCR and everything on this page are unaffected. The server actions
  (`discover_advertiser`, `paid_ads`, `advertiser_list`, … in `api/marketing.ts`)
  and all stored data were kept, so bringing it back is a UI job only.

- **Transcript language (fixed 2026-09-29).** Every video transcription
  (`worker/src/marketing/content/falTranscribe.ts`, shared by this pipeline,
  our own marketing assets and Files AI) now sends `language: null` to fal
  wizper, which means *detect the spoken language*. Until then the key was
  omitted, and fal's default for a missing key is **English**: Whisper then
  decoded Saudi Arabic speech as an English translation («The door is small
  for you and the villa is expensive? … Yaman Park 10 project»). Auto-detect,
  not forced Arabic, because some watched companies (UAE developers) speak
  English and forcing Arabic would translate *them*. Bare music-note output
  («♪♪») is now stored as no-speech (`language='none'`) instead of as text.
- **One transcript row per video.** The repair of old rows overwrites the
  existing `fal-ai/wizper` row rather than adding a second one, because every
  reader (the Library, script exemplars, the «النص» button, re-processing)
  assumes one. The English text it replaced is kept in `raw._replaced`; a
  repaired row is recognisable by `raw._request.language` being present.

## User flows

1. **Browse a shelf** — open Competitor Watch → pick a purpose shelf (e.g. Offer)
   → read every offer post across all competitors.
2. **Search the words** — type a term (e.g. `تقسيط`) → every post whose caption or
   AI-read message mentions it.
3. **Study one competitor** — click a competitor's name on any entry → the list
   filters to their content; combine with a shelf to see, e.g., their walkthroughs.

## Data touched

Reads, plus two admin writes (`attribution_set`, `attribution_rerun`).

- `mkt_attribution_set(p_post, p_project|NULL, p_user, p_note)` — the one
  correction path: sets `mkt_content_enrichment.primary_project_id` +
  `attribution_locked_at/by/note`, upserts the `mkt_content_attributions` row
  as `confirmed` (method `manual`) and rejects the others. `mkt_attribution_review`
  (Y/N surface) delegates to it on accept. `mkt_enrichment_upsert` keeps a
  locked pointer on every machine write.
- `mkt_project_organizations` — **follows the project records** (2026-09-27,
  `2026-09-27_02_relationships_follow_project_records.sql`). The project record
  is the source of truth for what it holds: `developer` rows come from
  `all_projects.developer` via `mkt_organizations.developer_record_id`;
  `authorized_marketer` rows come from `all_projects.marketer` — since
  2026-09-29 a MULTI lookup on the Companies list — one row per company it
  names, through the same `developer_record_id` link (every company, developer
  or marketer, has exactly one watch entry). A company is never linked as a
  marketer of its own project. The separate `marketer_record_id` link of
  2026-09-27 was folded into `developer_record_id` and dropped
  (`2026-09-29_01_companies_list.sql`, `2026-09-29_02_companies_watch_trigger.sql`).
  `records_company_to_org` keeps the watch entry in step with its company:
  a new company gets an entry, a rename or type change is copied, a deleted
  company's entry is archived (never deleted — its posts stay).
  `mkt_sync_developer_relationships` runs on every project save
  (`records_sync_developer_relationship`) and on a company's link / name / type
  change (`mkt_organizations_sync_developer_relationships`). It no longer only
  adds: a copy the record stops supporting is retired — a marketer the record no
  longer names becomes `former_marketer`, anything else goes `is_active=false`
  with the reason in `evidence`. The table still holds what one field can't:
  observed marketers, former marketers, confidence, evidence. Rows a person
  confirmed (`confirmed_by` set) are never changed. Every reader must filter
  `is_active` — `mkt_content_org_attribute` and the four `api/marketing.ts`
  reads now do. The 2026-07-22 import had written the project's developer in
  as its marketer on 38 projects and flagged them `human_confirmed` with no
  confirmer; those were retired.
- `mkt_intelligence_evidence` — adds `organization_name`, `brand_tokens`,
  `sibling_projects`, `attribution_locked`; candidates carry `strength` /
  `ambiguous` / `matchedAliases`.
- `mkt_attribution_health()` — embedded in `mkt_pipeline_health()` as
  `attribution`.
- `mkt_enqueue_attribution_rerun(p_org, p_limit)` / `mkt_attribution_reset_auto(p_post)`.

- `mkt_content_library(p_shelf, p_org, p_format, p_platform, p_has_offer, p_q,
  p_limit, p_offset)` — the gathering RPC (SECURITY DEFINER; the route is the gate,
  same posture as `mkt_intelligence_index`). Returns `{ total, shelves{}, rows[] }`.
- Underlying: `mkt_content_posts`, `mkt_content_enrichment` (the `result` jsonb
  carries content_type / campaign_message / selling_points / offer / price /
  unit_types / amenities / ctas / district), `mkt_transcripts` (presence flag),
  `mkt_organizations`, `unified_records` (project-name resolution).

## Key files

| Path | Role |
|---|---|
| `supabase/migrations/2026-08-31_03_mkt_content_library.sql` | The `mkt_content_library` gathering RPC + facets |
| `api/marketing.ts` | `content_library` action (service client → RPC) |
| `src/lib/competitorWatch/client.ts` | Typed client (`fetchContentLibrary`) + row/result types |
| `src/pages/CompetitorWatch/CompetitorWatchPage.tsx` | Workspace shell: command bar + sub-nav (Library live, 4 surfaces "soon") |
| `src/pages/CompetitorWatch/components/ContentLibrary.tsx` | The Library surface: shelves rail, filter bar, entry cards + expand. Also the design-read chip (lazy `design_read_get` on expand) and the admin «مثال للدراسة» action (`design_example_set`, 2026-09-02) |
| `src/pages/CompetitorWatch/watch.css` | Scoped `.cw-root` design system (control-room; Fraunces + IBM Plex, copper/cream/charcoal) |
| `src/lib/customPages.ts` / `src/App.tsx` | Page registration (`competitor_watch`, `/competitor-watch`, admin default) |
| `supabase/migrations/2026-09-13_01_attribution_rebuild.sql` | Lock columns, `mkt_attribution_set`, review-through-lock, reset-auto, developer-relationship sync triggers, evidence package fields, rerun enqueue, `mkt_attribution_health`, Library lock/strength/unknown fields |
| `supabase/migrations/2026-09-28_attribution_rerun_set_based.sql` | `mkt_enqueue_attribution_rerun` rewritten set-based (68 s → 165 ms) so the project-insert trigger no longer times out the save |
| `worker/src/marketing/pipeline.ts` | `attributeCaption` — full-name phrase first, exclusions, `strength`; `GENERIC_TOKENS`; `projectNameVariants` |
| `worker/src/marketing/content/attributionContext.ts` | Shared loader: live catalog, common tokens, brand + place exclusions, `publisherProjects` (relationship table ∪ developer field) |
| `worker/src/marketing/content/enrich.ts` | `narrowProjects` → candidates with `strength` / `ambiguous` (`enrich-v2`) |
| `worker/src/marketing/content/runContentProcess.ts` | `narrowOnly` pass (re-score from stored evidence, reset, hand back to runner) |
| `worker/src/marketing/__tests__/attributionRules.test.ts` | The measured failure modes pinned as tests |
| `.claude/skills/content-enrichment/SKILL.md` | Runner skill: candidates-only + `evidence_quote` + `mentioned_projects` |
| `scripts/lib/mkt-enrichment-validate.mjs` | Mechanical proof check (`attributionRejection`) — a pick without a valid quote becomes «no project» |
| `src/pages/CompetitorWatch/components/PipelineSurface.tsx` | «صحة ربط المشاريع» panel |
| `supabase/migrations/2026-09-27_01_company_marketing_profile.sql` | `mkt_company_roster` rebuilt: cadence, format/purpose mix, offers, top projects + districts, engagement, per-account last post; `mkt_district_norm` folds the «حي» prefix |
| `src/pages/CompetitorWatch/components/CompaniesSurface.tsx` | The Companies surface: type filter, search, sort, mix bars, message pill, expandable marketing profile |
| `supabase/migrations/2026-09-21_01_apify_efficient_collection.sql` | Calendar-day + dormancy scheduler (`mkt_incremental_due`, `mkt_enqueue_due_accounts`), provider budget pause (`mkt_provider_pause_for_budget`, `mkt_provider_resume_expired`, `mkt_job_cancel_paused`) |
| `worker/src/marketing/apifyLifecycle.ts` | `incrementalWindow`, date-filtered inputs, TikTok two-pass download, inline storage delete, `classifyApifyError`, pause guard |
| `worker/src/marketing/apifyStorageSweep.ts` | Deletes leftover Apify run storage once media is safe (sweep stage 8) |
| `api/_lib/marketing/providers/apify.ts` | Manual health check reads the monthly limit |

## Open questions / known limitations

- **All five surfaces now ship.** The four monitoring surfaces are backed by
  `mkt_agent_activity`, `mkt_pipeline_health`, `mkt_storage_usage`, and
  `mkt_company_roster` (migration `2026-08-31_05`), exposed as the `agent_activity`
  / `pipeline_health` / `storage_usage` / `company_roster` actions on
  `/api/marketing`. All read-only — there are no write actions yet (e.g. "run
  discovery", pause/enable an account, dismiss). Storage/company byte + fact totals
  are exact (not sampled); the Companies list covers organizations that have at
  least one active social account.
- **840 historical transcripts are English translations** until the operator
  runs `node scripts/retranscribe-arabic.mjs --backfill --limit 1000 --confirm`
  (dry run first: `--dry-run`; ≈ 1,205 audio-min ≈ $12.05 at fal's $0.01/min;
  capped by `--max-usd`, default 15). Anything derived from those transcripts
  before the repair — content enrichment, post embeddings, CV `search_tsv` —
  still reflects the English text until it is recomputed.
- **Full transcript text is not inlined yet** — only a presence flag. A per-post
  "load transcript" fetch is the follow-up.
- **Competitor filter is click-to-filter** (from a row); no standalone competitor
  dropdown yet.
- **The "learner" agents** that study this corpus are the next major build; this
  Library is their foundation.
- **Recorded Apify cost under-counts** Apify's bill (about $20 recorded vs
  $26.56 billed for scraping in the Aug–Sep 2026 cycle; storage not recorded at
  all). Apify's billing page is the source of truth for spend.
- **The `post_metrics` job for Instagram/TikTok is a stub** — it never calls
  Apify. Engagement is refreshed only by the 14-day window of incremental runs.
- **Follower / engagement completeness** inherits the pipeline's gaps (e.g. views
  absent on some platforms) — shown as-is, never faked.
- **No competitor paid ads are collected.** With the advertisers page deleted
  (2026-09-29) there is no way to start a paid-ad collection from the app; the
  10 paid ads on file are from 2026-07-22. Competitor tracking here is organic
  content only.
