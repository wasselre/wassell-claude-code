# PRD: Marketing Intelligence (ذكاء التسويق)

Last updated: 2026-07-28

> Not to be confused with **Market Intelligence** (`market-intelligence.md`, ذكاء السوق),
> which analyses LISTING data — asking prices, supply, demand. This page analyses
> **competitor MARKETING**: their posts, ads, creatives, and the facts extracted
> from them. Different route, different data, different question.

## What it is (in plain English)

One page that answers three questions about the competition:

1. **What changed?** — a feed of alerts produced by seven deterministic rules:
   an advertiser went quiet, posting frequency moved, a platform shift, a
   messaging shift, a new commercial offer, a new marketer on a project, a price
   movement.
2. **Who markets what?** — every organization (developer, marketing company, or
   both) with the projects they touch, their posting cadence, audience, and the
   marketing language they actually use.
3. **What are they saying about a project?** — per project: the confirmed posts,
   the extracted facts (prices, offers, payment plans, CTAs, hooks, amenities,
   unit types, districts, phone numbers), who markets it, and on which platforms.

**Zero AI produces any number on this page.** Facts are extracted by database
triggers over captions, transcripts and image OCR; insights come from SQL rules;
every rollup is a COUNT. The only model involvement anywhere upstream is reading
text out of images, and that output is stored as *evidence*, never as a conclusion.

## Why it exists

The intelligence backends (fact layer, analytics primitives, Project
Intelligence, Organization Intelligence, insight engine) were all built and
verified with SQL and typed API clients — and had no user-facing surface at all.
Everything was reachable only by query. This page is that surface.

## Key behaviors

- **Coverage strip is rendered first and never hidden.** It is the denominator
  for every number below it: posts collected, facts extracted, posts awaiting
  attribution, posts without OCR, and confirmed vs speculative attributions.
- **Confirmed and speculative attributions are never mixed.** Speculative
  candidates outnumber confirmed roughly 20:1 (4,453 vs 225). One project shows
  13 confirmed against 121 speculative — a merged count would claim 134 and be
  wrong by 9×. An earlier rollup did exactly that and reported ~130 posts for
  nearly every project.
- **`awaiting_intelligence` is reported as its own state, not as "unprocessed".**
  Those posts have complete media, OCR and facts; only the runner's project
  decision is pending. Collapsing them into "unprocessed" would understate a
  fully-populated fact layer and overstate breakage.
- **Unmeasurable is rendered as "—", never 0.** Follower growth with fewer than
  two observations, and a posting-frequency change with no prior baseline, both
  show an em dash. "We cannot see this" and "this is zero" are different claims.
- **Every capped list reports its cap** (`showing 4 of 71`). A silently truncated
  list reads as "that is all there is".
- **Every insight carries its evidence one click away** — the rule name and the
  thresholds that fired it. The engine's first live run emitted 80 insights of
  which 66 were false; the noise floors that fixed it are recorded per insight so
  a sceptical reader can check the reasoning instead of guessing.
- **Insights are dismissed, never deleted** — the evidence trail is the point.
- **Media recovery is split from understanding, and neither is opt-in.** Downloading
  a post's media is time-critical (Instagram/TikTok CDN URLs expire within days);
  OCR and enrichment are not, because they read from permanent storage. Collection
  therefore enqueues a *media-only* pass for every post it ingests, and a separate
  backlog sweep drives the rest. Processing used to be gated behind a
  `process_content` flag that no enqueue path ever set, so 1,104 posts sat at
  `collected` with zero media rows while their URLs aged out — every collection job
  green, because collecting was all they were asked to do.
- **The pipeline is driven by state, not by events.** The sweep asks "which posts
  lack media / OCR / enrichment?" rather than trusting that something remembered to
  enqueue them, so a missed enqueue self-heals on the next tick instead of stranding
  a post permanently. It orders its stages media → OCR → enrich so the free OCR lane
  always reads the images before the metered vision path would have.
- **Failure is not an exit.** The sweep scans posts at `collected` *and* `failed`.
  A post reaches `failed` when its job exhausts its attempts — but that is a
  statement about one attempt, not about whether the work is still possible, and
  media recovery frequently succeeds afterwards. Scoping the scan to `collected`
  quietly made `failed` a terminal state no code path could leave: 906 posts sat
  there, 899 of them already holding stored media, one enqueue short of processing.
  Twice now the same mistake has cost this pipeline its self-healing property
  (stage 2's OCR scope was the first), and both times the tell was identical — a
  status is an event, so gating recovery on one is the very thing this bullet says
  the pipeline does not do. Re-entry stays bounded: stage 1 re-attempts at most once
  per 6h, stage 3 requires stored media, so a permanently-dead post costs ~4
  attempts a day rather than one per tick.
- Bilingual AR/EN with full RTL/LTR; no horizontal body scroll at 375px.

## User flows

1. **Triage** — open the page, read the coverage strip, scan the insight feed
   (critical → warning → opportunity → info), expand evidence on anything
   surprising, dismiss what is handled.
2. **Follow an alert to its subject** — click the organization or project chip on
   an insight row to jump straight into that entity's panel.
3. **Study a competitor** — Organizations tab → pick an org → role breakdown,
   project table (confirmed vs speculative side by side), audience, posting
   trend, and their most-used offers / campaign messages / selling points / CTAs.
4. **Study a project** — Projects tab → pick a project → attribution caveat,
   fact families, who markets it, platform split, recent posts.

## Data touched

Reads only. No write path except dismissing an insight.

- `mkt_intelligence_index(p_limit)` — page shell: insight feed + both pickers + coverage
- `mkt_project_intelligence(...)` — Projects panel
- `mkt_organization_intelligence(...)` — Organizations panel
- `mkt_insight_set_dismissed(id, bool)` — dismiss
- Underlying: `mkt_observed_facts`, `mkt_insights`, `mkt_project_marketing_state`,
  `mkt_organizations`, `mkt_project_organizations`, `mkt_content_posts`,
  `mkt_content_attributions`, `mkt_visual_text`, `mkt_share_of_voice`

## Key files

| Path | Role |
|---|---|
| `src/pages/MarketingIntelligence/MarketingIntelligencePage.tsx` | Page shell, tabs, coverage strip, pickers |
| `src/pages/MarketingIntelligence/components/InsightsFeed.tsx` | Insight feed + evidence expander + dismiss |
| `src/pages/MarketingIntelligence/components/ProjectPanel.tsx` | Project Intelligence panel |
| `src/pages/MarketingIntelligence/components/OrganizationPanel.tsx` | Organization Intelligence panel |
| `src/pages/MarketingIntelligence/components/shared.tsx` | Disclosure-biased primitives (`Stat` renders "—" not 0, `ShownOf`) |
| `src/lib/marketing/client.ts` | Typed clients + response shapes |
| `api/marketing.ts` | `intelligence_index`, `insight_dismiss` actions |
| `supabase/migrations/2026-08-13_mkt_intelligence_index.sql` | Index RPC + dismiss RPC |
| `src/lib/customPages.ts` / `src/App.tsx` | Page registration (`marketing_intelligence`, `/marketing-intelligence`, admin default) |
| `worker/src/marketing/content/sweepBacklog.ts` | State-driven backlog sweep (media → OCR → enrich) + single-machine sweep lease |
| `worker/src/marketing/content/runContentProcess.ts` | Per-post pipeline; `mediaOnly` = time-critical media-recovery pass |
| `worker/src/marketing/runCollectionJob.ts` | Collection enqueues media recovery for every ingested post (no longer opt-in) |
| `.claude/skills/visual-ocr/SKILL.md` / `scripts/claude-study-runner.mjs` | OCR lane: reads creatives on the Claude subscription, no per-token API charge |

## Open questions / known limitations

- **Share of voice is not surfaced yet.** `mkt_compute_share_of_voice` requires an
  explicit window + scope and only `scope_type='market'` rows exist; the page has
  no period picker to drive it.
- **Follower growth is unmeasurable everywhere** — no account yet has two
  follower observations, so the page correctly shows "—" for all of them. It
  becomes real once the metrics capture has run twice.
- **No paid-ad reach or spend** — none of the collected ads carry those fields.
- **Cross-platform campaigns are all singletons**, so the campaign timeline in
  Project Intelligence is thin.
- **Attribution backlog** — 656 posts sit at `awaiting_intelligence`. Their facts
  already count; their project attribution does not exist yet, which is why
  confirmed attributions (225) look small next to facts (9,172).
- **No recommendation layer** — the page reports what competitors did. It does not
  say what Wassel should do about it. That was deferred deliberately.
