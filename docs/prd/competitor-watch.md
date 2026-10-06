# PRD: Competitor Watch (مرصد المنافسين)

**Status:** Live (all five surfaces: Content Library + Agents & runs, Content pipeline, Storage, Companies)
**Last updated:** 2026-10-06 (**Visual references — non-competitors followed for their design.** A company can now be of type «مرجع بصري» (`org_type = 'visual_reference'`): brands outside real estate whose visuals are worth learning from (first batch: Mercedes-Benz, Rolls-Royce, Ferrari, SEVEN, Range Rover, Porsche, Audi, Maserati). Their accounts are collected like any other, their media stored, their videos split into shots and their image posts design-read — but their posts are NEVER read for content: no project matching, no caption/offer reading, no transcription, no enrichment row. So they never reach Market Watch, the competitor counts, share of voice, trend alerts, the copywriter's examples or the script writer's exemplars (fenced explicitly where a view did not already require a content read). They DO feed the creative references and the shot library. The Companies page lists them under their own filter «مراجع بصرية» (excluded from «الكل»); the Library shows their posts only on their own company page or the new «مراجع بصرية» shelf. Migration `2026-10-06_02_visual_reference_companies.sql`; worker `runContentProcess.isVisualReferenceOrg`.) | 2026-10-06 (**OpenAI can read posts and designs (built, switched off).** A second engine for both jobs, chosen by two blind tests after Gemini hit its monthly cap: posts by **gpt-6-luna** (30 posts: right project 29/30 vs Gemini 30/30, screen text 7.8 vs 7.6, 4 invented lines vs 26, $0.0018 per post vs $0.0096) and image designs by **gpt-6.1-sol** (15 posts / 83 images: layout claims 8.2 vs 6.7 for luna and 6.1 for Claude Sonnet 5.5, 0.9 false statements per post, $0.015 per image). Same prompts, candidates, proof checker, validators and storage; a video is read from 8 still frames plus its transcript, since OpenAI takes no video. Switches `mkt_settings content.reader = 'openai'` and `content.design_reader = 'openai'`, both left on Gemini. An empty OpenAI balance pauses reading with one alert. Posts read by either engine count as read, so neither re-reads the other. Video shots and search vectors stay on Gemini. Also fixed: the design validator rejected every correct read of an image with no text (it demanded at least one font size). Migration `2026-10-06_01_openai_readers.sql`.) | 2026-10-05 (**Image posts get a design read.** Until now an image post kept only its TEXT; nothing said how it is designed (the Creative Director's `visual_design_reads` table, built 2026-09-02, had never stored a row — all 481 runner/API jobs failed). Now, right after a post is read, ONE gemini-3.8-flash call reads its images (carousel order, up to 10) and stores, in that same table, a design read per image (`competitor_media`, level `slide`: role, layout, image kind + subject, typography, text density, colours, logo, CTA, notes) and one for the whole post (`competitor_post`, level `post`: summary, template, branding 0-3, colours, what works, weak spots, the lesson), each checked by the existing validators, plus a gemini-embedding-2 vector per image for "looks like" search (model_used `gemini:gemini-3.8-flash`, rule_version `gemini-v1`). The Library's expanded entry shows it under «التصميم». Videos are not read this way — their shots carry the creative reading. Posts read before this get a design-only pass from the sweep (`mkt_design_read_due`, content_process mode `design_only`, 150 per tick, counted in the reader's daily budget); a failed read is stored as failed and retried at most 3 times. Measured: a 3-image carousel cost $0.0148. Code `worker/src/marketing/content/geminiDesign.ts`, UI `DesignReadPanel.tsx`, migration `2026-10-05_15_image_design_reads.sql`.) | 2026-10-05 (**Apify on the Scale plan.** $199/month of included usage, 128 runs at once; the monthly usage limit is $500 (set by the operator) and up to 8 Apify collection jobs run at once (was 4). The Rakez and Thiraa TikTok 12-month histories, deferred under the old $200 cap, finished on their first attempt (861 and 894 posts), so every watched account now has its 12-month history. Migration `2026-10-05_14_apify_scale_plan.sql`.) | 2026-10-05 (**Catch-up speed.** Video shot jobs run on two dedicated-CPU machines (the `cv` Fly process group) instead of the five shared general machines, where ffmpeg was throttled 5-20x and slowed post reading; each general machine runs two collection/reading slots; collection is claimed before reading; Apify may run 4 at once; catch-up caps 3,000 videos/day, $120/day shots, $120/day reading. An empty Gemini prepaid balance (HTTP 402) now pauses reading and shots with one critical alert and resumes by itself within 15 minutes of a top-up. Every shot job and post read records per-step timings (`timings_ms`). Migration `2026-10-05_01_catchup_speed.sql`.) | 2026-10-04 (**Cross-posts shown once.** The same post published by one company on two or three platforms (same company, different platform, identical normalised caption of 25+ characters, within 3 days) is linked to its earliest copy (`mkt_content_posts.repost_of`, kept current by the `mkt_content_posts_repost` trigger). The Library shows it once with «also on TikTok ▷ … ♥ …» chips carrying each copy's own numbers (filtering by a platform still shows that platform's copy), and Market Watch counts it as one piece of news. 382 copies linked at backfill (mostly Instagram + TikTok). Nothing is deleted or re-read. YouTube: Rakez and Mada Properties channel ids were stored with the wrong letter case (IDs are case-sensitive) and are corrected and collecting again. Migration `2026-10-04_07_cross_posts.sql`. **YouTube videos blocked from the worker** (YouTube refuses ~5-8% of downloads from datacenter addresses — bot check or a 403, even with the current yt-dlp) are retried from a home connection by `node scripts/youtube-catchup-local.mjs` (operator-run; stores them exactly as the worker does and queues their read, which also offers them to shots); re-run it now and then.) | 2026-10-04 (**One library.** The separate Visual library tab is gone. Each Content Library post with a video shows «Shots (n)» once its video has been split into shots (or «shots being prepared» while queued), opening the same filmstrip and shot drawer; the old scene search is the Library's «Search by scene» mode (not offered on a company page, since it spans every company). `mkt_content_library` rows carry `video_media_id`, `shots_status`, `shot_count`. Shot-building (`cv.enabled`) switched back on to work through the ~2,350 queued videos under the 500/day and $30/day caps. Migration `2026-10-04_06_library_shots.sql`.) | 2026-10-04 (**Market Watch («أخبار السوق» tab).** A feed of the market's news read off competitor posts, each item with the posts that prove it and no AI call (`mkt_market_watch`, derived from what the post reader stored): **new project** (a catalog project's first post by anyone, or a name not in our catalog), **launch** (one per company + project; an uncatalogued project grouped by name), **new offer** (an offer text not seen before for that company + project), **stated price changed** (the AMOUNT, parsed by `mkt_price_number` incl. «مليون»/«ألف» and Arabic digits, moved >1% — wording alone never counts; labelled as possibly a different unit type), **event** (exhibitions, signings, openings — greetings / general branding excluded), **sold out** (AR/EN wording in caption, screen text or speech). Periods 7 / 30 / 90 days, filter by kind. Migration `2026-10-04_05_market_watch.sql`.) | 2026-10-04 (**Interactions shown, and a page per company.** Every Library entry now shows views / likes / comments, the readings 7 and 30 days after publishing (`mkt_post_age_reading`: the snapshot nearest the mark, inside 5-12 / 25-45 days), and «× المعتاد» — the post against its OWN account's 12-month median (`mkt_account_baseline_v`; a median needs ≥10 posts carrying the number, and × usual is only shown against ≥50 views / ≥5 likes, so a quiet account's 1-like median cannot produce a 14,000× figure). A post with ≥20× usual views but under 2 likes per 1,000 views is flagged «إعلان مموّل غالبًا» — a labelled guess; measured: YouTube videos at 1.6-5.8 M views with 1-24 likes on channels that usually get 119-509. The Library sorts by newest / most viewed / most liked / best vs usual (`mkt_content_library` p_sort). **Company page** («صفحة الشركة ←» on each Companies row, `CompanyDetail.tsx`, one `mkt_company_profile` call): accounts with followers and their 30-day change, posts per week (26 weeks), average views by month, their 12 best posts against their own usual, purpose / format / platform mix, their projects, latest offers and messages, projects they name that the catalog lacks, visual style from shots, and all their posts (the Library, pre-filtered). Migration `2026-10-04_04_competitor_performance.sql`.) | 2026-10-04 (**Moved into the Marketing workspace.** Competitor Watch is now the «المنافسون» tab of «التسويق» at `/m/competitors` (still gated by page id `competitor_watch`); the old `/competitor-watch` address redirects there and its sidebar row is gone. The page itself, and its own `.cw-root` design system, are unchanged.)
**Last updated:** 2026-10-04 (**Posts are read and matched by Gemini, not the Claude runner.** `content_process` now reads every post itself: ONE gemini-3.8-flash call with the post's video (whole, not 6 frames) or all its images, plus caption, transcript and the short list of candidate projects, returns the on-screen text per media item and the project pick with a verbatim quote; the short list is rebuilt with that screen text and, only if it changed, a text-only Gemini call decides again; the same proof checker (ported to `worker/src/marketing/content/enrichmentValidate.ts`, parity-tested against the runner's) and the same persistence follow. The runner's `mkt_visual_ocr` / `mkt_content_enrichment` lanes are no longer fed; posts an older reader decided are re-read by the sweep, 40 per tick, under `content.reader_daily_budget_usd` (25); a per-day Gemini quota pauses reading (`content.reader_paused_until`) with one alert. Switch back with `content.reader = 'runner'`. Chosen by two blind 60-post tests: vs the runner (same project on 57/60, image text 9.4 vs 9.4 accuracy, 0 vs 1 invented lines, content type acceptable 17 vs 11 of 23 disputed) and vs Kimi K3 (video text judged better 18 vs 6, 0 vs 11 invented lines, ~1/10 the price). Migration `2026-10-04_03_content_reader_gemini.sql`.) | 2026-10-04 (**Visual intelligence moved from Modal to Gemini.** Each competitor video is now read by ONE Gemini 3.8 Flash call that returns every shot with its on-screen text (copied exactly), a bilingual one-line description and the creative reading the shot drawer shows; ffmpeg's cut detector makes the shot times exact; Gemini's multimodal embedding makes shots and frames searchable by text. Chosen by a blind 20-video bake-off where the old Modal OCR was worst on every video (174 invented lines vs 4). Every stored video is redone and every Modal-era vector cleared — see «Visual intelligence (shots)» under «User flows». Migration `2026-10-04_02_cv_gemini.sql`.) | 2026-10-04 (**Collection: 12 months once, then only new posts; views and likes at 7 and 30 days.** Each account's last 12 months are collected once (`mkt_social_accounts.history_done_at` marks it done); after that a run asks only for posts newer than our newest one, with a one-day overlap, never older than 12 months. Recent posts are no longer re-bought on every run to refresh engagement (that was about 14 paid reads per post for a daily account): each post is re-read exactly twice, at 7 and 30 days old (`metrics_7d_at` / `metrics_30d_at`, `mkt_posts_due_for_metrics`, the `post_metrics` job — Instagram/TikTok by post link through Apify, YouTube free), so every post is measured at the same ages. A long history run extends its job lease first, so a second machine can never buy the same account twice. YouTube's history walks the uploads list back 12 months (free). Every competitor Instagram, TikTok and YouTube account is collected daily (our own Wassel accounts and a duplicate Alajlan YouTube row excluded); an account with no post in 30 days drops to weekly by itself. Migration `2026-10-04_01_collection_history_and_metrics.sql`.) | 2026-10-03 (**Bug fixes from the 48-post audit.** Project matching: a generic word plus a short number («أدوار 9») is no longer a series reference; a one-word project name that is an everyday word («بعد», «بناء») needs the publisher's own scope or a marker word before it («مشروع بعد»); a name made only of generic and place words («مشروع النرجس») is a match only for the company that owns it; Arabic-Indic digits («مينا ٣٩») now match catalog numbers; a name matched with its words in any order must include its number («أدوار - يمام 9» is no longer a candidate for a post about يمام 16 — 260 such candidates were removed). Proof check (`mkt-enrichment-validate.mjs`): numbers glued to a word («مكين 63حي») and Arabic-Indic digits are found; generic words («شقق») are no longer required name tokens; a strong full-name/number pick whose quote the model left empty is proved by the matcher's own alias (`evidence_quote_source: 'matcher'`) unless the quote proves a different candidate, and never through an alias that drops the project's number; a post with no caption, transcript or OCR is stored as `no_evidence` with empty fields instead of a guessed `brand`. Posts with no candidate that were never read under the current rules are handed back to the runner once, so `mentioned_projects` (catalog gaps) is filled for them — 1,915 posts had kept their July reading. The runner now checks every save (a failed save no longer marks a post processed) and demotes a machine auto-accept that disagrees with its decision (`mkt_attribution_demote_stale`), so the project record's Marketing tab agrees with the Library. OCR text sent to the runner is de-duplicated (an end-card read off six frames is one line). A YouTube channel the API says does not exist is now `not_found`: the job ends without retries, the account's collection is switched off with the reason in `provider_metadata`, and one «account_not_found» alert is raised — six accounts had failed daily (1,691 jobs); their ids (four stored lowercased) were corrected. Anonymous EXECUTE was revoked from all 159 SECURITY DEFINER `mkt_*` functions. Migration `2026-10-03_01_competitor_tracking_bugfixes.sql`.) | 2026-09-30 (**Projects tab + every project on a company card.** A new «المشاريع» surface lists one row per project that is in our portfolio or that anybody has posted about: its developer and marketers (from the project record) and every company posting about it, with a «مسوّق غير مسجَّل» flag when a company posts about a project whose record does not name it (`mkt_project_roster`, `ProjectsSurface.tsx`). The Companies card's project list is no longer capped at four and now includes projects the company is linked to but has never posted about (`mkt_company_roster`). **Video frames are read again, on the subscription lane:** the cover-first OCR order had left 1,167 of 1,406 stored videos read from their cover only; frames are now sampled by the worker into `mkt_video_frames` and read by the runner's OCR lane — see «Video frames» under «How collection runs». **Runner self-heals:** a failed lease heartbeat call no longer shuts the runner down, and a real stop exits non-zero so Fly restarts it — it had been down since 2026-09-28. Six placeholder companies removed.) | 2026-09-29 (**Companies follow-ups:** Abah is a developer; Riva markets Adwar Jadeel Al Rimal; the old Marketers model is deleted; company pickers only list the right type. Migration `2026-09-29_03_companies_followups.sql`.) | 2026-09-29 (**Transcripts in the language that was spoken.** New video transcriptions ask fal for language auto-detect instead of omitting the key — omitted, fal defaults to English, which is why 840 competitor transcripts (2026-07-23 → 2026-09-28) were English translations of Saudi Arabic speech. The historical rows are repaired in place by `scripts/retranscribe-arabic.mjs --backfill` (≈ $12, operator-run, metered). Also earlier today: **One Companies list.** Every watched company is now a record in the CRM Companies list (the old Developers model, relabelled «الشركات», with a required مطوّر / مسوّق type) and its watch-entry type follows that record. 41 watched companies that were in no CRM list got a Companies record; 11 duplicate company rows were merged; ذراع and آبه are marketers. A project now names ONE developer and ANY number of marketers, and every marketer it names becomes an `authorized_marketer` link here — see `mkt_project_organizations` under «Data touched». A company created, renamed, retyped or deleted in the CRM updates its watch entry automatically.) | 2026-09-29 (**The «المعلنون المدفوعون» Settings page was deleted** — competitor paid-ad collection has no screen now. Nothing collected paid ads through it after 2026-07-22: 27 advertiser look-ups (last 2026-07-28), zero `paid_ads` queue jobs; the 10 stored paid ads (`mkt_paid_ads`, all 2026-07-22) stay. Server actions + data kept. See the new bullet under «How collection runs».) | 2026-09-28 (**Creating a project works again.** The attribution catch-up that runs inside every project insert (`mkt_enqueue_attribution_rerun`) took 68 s and timed the save out, so no project could be created from the app since ~2026-09-14; rewritten set-based, now 165 ms with the same jobs queued.) | 2026-09-27 (**Relationships follow the project records** — a project's marketer in the CRM now becomes its marketer here automatically, and stale copies are retired; see `mkt_project_organizations` under «Data touched».) Also 2026-09-27 (**Companies surface rebuilt around the marketing read** — type, channels, cadence, format mix, dominant message, offers, projects and districts per competitor; «آخر نشاط» was our scrape time and is now «آخر نشر», theirs.) Previously 2026-09-21 (**Collection made budget-aware** — see «How collection runs, and what it costs» below: incremental runs fetch only posts newer than the last stored one plus a 14-day engagement window, TikTok downloads only new videos, Apify storage is cleaned up, dormant accounts are checked weekly, and a spent Apify budget pauses collection with one alert instead of retrying for weeks.) Previously 2026-09-13 (**Project attribution rebuilt** — see «How a post gets its project» below: brand/place words are no longer evidence, full names are matched as phrases, a pick must carry a verbatim quote, corrections lock the post, and the Library has a «تصحيح المشروع» control.)

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
  `strength` (full_name | number | word) and `ambiguous`. (2) Gemini (since
  2026-10-04; the Claude runner before) picks from that list ONLY, and must return an `evidence_quote` — a verbatim
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
  («♪♪»), sound tags («\*Splash\*»), an auto-detect that lands on a language
  other than Arabic/English (music misheard as Khmer / Latin), and a transcript
  made only of Whisper's Arabic filler («موسيقى اشتركوا في القناة») are all
  stored as no-speech (`language='none'`). Decoder loops (the same phrase
  repeated more than 3 times back-to-back — seen on a 35-minute walkthrough)
  are collapsed to one copy (`collapseRepeats`).
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

### TikTok videos that never got their file (2026-09-30)

TikTok is collected in two passes — post list, then a download pass for the NEW
videos of that run. A video the download pass missed was recorded as failed and
never retried: 175 of 548 TikTok videos (Riva 124 of 236), 141 of them from the
first bulk pull in July. A `backfill` job with `mode: 'tiktok_redownload'`
re-runs only the download pass for an account's missing videos
(`redownloadTikTokVideos`), then sends each recovered post through full
processing (store → transcript → frames → project match). Each video gets at
most 3 attempts (`mkt_content_media.redownload_attempts`) — a deleted video is
not re-bought forever. The sweep's stage 2c (`mkt_enqueue_tiktok_redownloads`)
keeps this self-healing, one bounded job per account per 20 h, and enqueues
nothing while Apify is disabled or paused.

**What the recovery found (same day):** only 6 of the 175 were videos. The other
169 are TikTok PHOTO posts ("slideshows") — there is no video file to fetch. The
parser called every TikTok item a video, so each photo post got a false "failed
video" row and its pictures were never stored or read. Now a photo post is typed
`image` / `carousel`, its slides are stored as images (`tiktokSlides` in
`mediaExtract.ts`) and read on the subscription OCR lane like any other picture,
and `mkt_tiktok_videos_missing` only offers real videos.

### Video frames (2026-09-30)

A stored video's on-screen text — price, offer and phone overlays — is in its
frames, not its cover. The content sweep reads the cover on the subscription OCR
lane first, and full processing used to treat "this post has visual text" as
"nothing left to read", so the six sampled frames were dropped: 1,167 of 1,406
stored videos were read from the cover only.

- The worker's `content_process` job with `mode: 'frames_only'`
  (`worker/src/marketing/content/videoFrames.ts`) downloads the stored video,
  samples six frames with ffmpeg, stores them and writes one `mkt_video_frames`
  row each. No model is called. A video that cannot be framed gets one failure
  marker row (`frame_ts_ms = -1`) so it is not retried forever; a network error
  fails the job instead, so a blip never writes a video off.
- Full processing of a NEW video whose cover was already read now queues its
  frames the same way instead of skipping them.
- The sweep (`sweepBacklog.ts`, stages 2a/2b) enqueues up to 40 frames-only jobs
  per tick from `mkt_videos_needing_frames()` and batches pending frames, 24 at
  a time, into `claude_jobs` (`mkt_visual_ocr` with `payload.frame_ids`), under
  the same queue ceiling as cover OCR.
- The runner (`handleVideoFrameOcr` in `scripts/claude-study-runner.mjs`) reads
  them with the `/visual-ocr` skill and writes `mkt_visual_text` against the
  VIDEO's media row (`source='frame'`, `frame_ts_ms`) — the shape the paid path
  always wrote, so no reader changed. `mkt_video_frames_finish` marks frames
  done (an unread frame is retried twice, then failed), and once a post has no
  pending frame left it re-checks the post's project match with the free
  narrow-only pass. Read frames are removed from storage.
- Frames are not `mkt_content_media` rows on purpose: sixteen functions read
  that table (Content Library, Files bridge, design reads, storage usage…).

### Visual intelligence (shots) — Gemini (2026-10-04)

The shot-level library behind visual search (`mkt_cv_videos` → `mkt_cv_shots` →
`mkt_cv_frames`, queue `mkt_cv_jobs`) is a separate system from collection (see
CLAUDE.md "Competitor tracking and video analysis are TWO systems"). Until
2026-10-04 a Modal GPU service cut the video into shots, read text with an OCR
model and made SigLIP-2 / bge-m3 vectors, and a second job described each shot
with Claude. A blind bake-off on 20 competitor videos, scored by 10 independent
reviewers, ranked that output worst on all 20 (text accuracy 2.8/10, 174 invented
lines); Gemini 3.8 Flash watching the whole video scored 8.8/10 with 4 invented
lines. So the pipeline was replaced (`worker/src/marketing/cv/gemini/`):

1. The worker downloads the stored video, makes a silent copy (the transcript
   carries the speech) and runs ffmpeg's `scdet` cut detector.
2. **One Gemini call per video** (`gemini-3.8-flash`) returns every shot: start,
   transition, on-screen text copied exactly, a one-line Arabic and English
   description, purpose, angle, camera movement, pace, production method and
   difficulty, reproducibility, platforms, mood, tags. It is told which detected
   cuts are certain and which are only possible; it splits soft transitions the
   detector cannot see, and splits a long walkthrough where the place changes
   (`analysis.continuous_take`). Our code snaps its times onto detected cuts and
   clamps them inside the video (Gemini alone overran the end on 2 of 20 test
   videos). Videos over 15 minutes are read up to 15 minutes and marked partial.
3. Keyframes (one per shot, three for shots over 6 s) are cut as JPEGs into
   `marketing-assets/content/frame/<video>/`.
4. **Gemini embeddings** (`gemini-embedding-2`, one multimodal model): each
   keyframe at 768 dims, each shot's words (description + on-screen text +
   speech) at 1024 dims. A search query is embedded the same way, so typing
   "drone shot of a villa" finds the picture. Old Modal vectors were cleared —
   the two models' numbers cannot be compared.
5. The video's old rows are deleted (`mkt_cv_reset_video`) and the new ones go
   through the same ingest RPCs as before, so the Visual library, the shot
   drawer and `mkt_cv_search` did not change. Old frame images under the
   video's folder are removed after a successful re-run.

Our own assets (`cv_embed_wassel`) use the same pipeline without the Gemini
call: cuts + keyframes + image vectors only.

**Cost.** Measured on test videos: about $0.01–0.05 per video, depending on how
many shots it has (output is ~300 tokens per shot), plus well under a cent of
embeddings. Every call is metered in `ai_usage` with its exact cost (Google's
implicit cache discount included). At most `cv.max_videos_per_day` (500) new
videos are admitted a day, and `cv.daily_budget_usd` (30) stays as the hard stop.
**Google overload.** Gemini answers 503 "high demand" and 429 in bursts that
can last several minutes; the call retries 6 times (honouring Google's
`retryDelay`) and the job queue requeues up to 5 attempts after that.

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
| `scripts/lib/mkt-enrichment-validate.mjs` | Mechanical proof check (`attributionRejection`) — a pick without a valid quote becomes «no project», except a strong full-name/number pick proved by the matcher's alias; zero-evidence posts become `no_evidence`. Keeps a copy of `GENERIC_TOKENS` (sync test enforces it) |
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
- **The 840 historical English transcripts were re-transcribed on 2026-09-29**
  with `node scripts/retranscribe-arabic.mjs --backfill` (operator-run, metered,
  capped by `--max-usd`). When the text rules change, `--reclean` re-applies
  them to repaired rows from the stored fal response at no cost. Anything
  derived from the transcripts before the repair — content enrichment, post
  embeddings, CV `search_tsv` — still reflects the English text until it is
  recomputed.
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
