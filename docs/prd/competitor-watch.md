# PRD: Competitor Watch (مرصد المنافسين)

**Status:** Live (all five surfaces: Content Library + Agents & runs, Content pipeline, Storage, Companies)
**Last updated:** 2026-09-13 (**Project attribution rebuilt** — see «How a post gets its project» below: brand/place words are no longer evidence, full names are matched as phrases, a pick must carry a verbatim quote, corrections lock the post, and the Library has a «تصحيح المشروع» control.)

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
  project whose `developer` is the publisher (kept live by trigger). The whole
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
- `mkt_project_organizations` — now synced from `all_projects.developer` by
  `records_sync_developer_relationship` (records trigger) and
  `mkt_organizations_sync_developer_relationships`; rows carry
  `evidence.source = developer_field_sync`.
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
| `worker/src/marketing/pipeline.ts` | `attributeCaption` — full-name phrase first, exclusions, `strength`; `GENERIC_TOKENS`; `projectNameVariants` |
| `worker/src/marketing/content/attributionContext.ts` | Shared loader: live catalog, common tokens, brand + place exclusions, `publisherProjects` (relationship table ∪ developer field) |
| `worker/src/marketing/content/enrich.ts` | `narrowProjects` → candidates with `strength` / `ambiguous` (`enrich-v2`) |
| `worker/src/marketing/content/runContentProcess.ts` | `narrowOnly` pass (re-score from stored evidence, reset, hand back to runner) |
| `worker/src/marketing/__tests__/attributionRules.test.ts` | The measured failure modes pinned as tests |
| `.claude/skills/content-enrichment/SKILL.md` | Runner skill: candidates-only + `evidence_quote` + `mentioned_projects` |
| `scripts/lib/mkt-enrichment-validate.mjs` | Mechanical proof check (`attributionRejection`) — a pick without a valid quote becomes «no project» |
| `src/pages/CompetitorWatch/components/PipelineSurface.tsx` | «صحة ربط المشاريع» panel |

## Open questions / known limitations

- **All five surfaces now ship.** The four monitoring surfaces are backed by
  `mkt_agent_activity`, `mkt_pipeline_health`, `mkt_storage_usage`, and
  `mkt_company_roster` (migration `2026-08-31_05`), exposed as the `agent_activity`
  / `pipeline_health` / `storage_usage` / `company_roster` actions on
  `/api/marketing`. All read-only — there are no write actions yet (e.g. "run
  discovery", pause/enable an account, dismiss). Storage/company byte + fact totals
  are exact (not sampled); the Companies list covers organizations that have at
  least one active social account.
- **Full transcript text is not inlined yet** — only a presence flag. A per-post
  "load transcript" fetch is the follow-up.
- **Competitor filter is click-to-filter** (from a row); no standalone competitor
  dropdown yet.
- **The "learner" agents** that study this corpus are the next major build; this
  Library is their foundation.
- **Follower / engagement completeness** inherits the pipeline's gaps (e.g. views
  absent on some platforms) — shown as-is, never faked.
