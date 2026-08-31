# PRD: Competitor Watch (مرصد المنافسين)

**Status:** Live (v1 — Content Library surface only)
**Last updated:** 2026-08-31

> A NEW, from-scratch workspace that succeeds the **Marketing Intelligence**
> page (`marketing-intelligence.md`), built because the operator found that page
> unusable ("it's ugly, I can't use it"). Same underlying `mkt_*` competitor data;
> completely separate UI, deliberately not built on the old components. The old
> `/marketing-intelligence` page is left intact and untouched.

## What it is (in plain English)

A control-room workspace for watching competitors' marketing, at `/competitor-watch`
(admin-only). It is planned as five surfaces; **v1 ships one — the Content
Library ("the shelves")** — with the other four (Agents & runs, Content pipeline,
Storage, Companies) stubbed in the sub-nav as "soon".

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

Reads only. No write path.

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
| `src/pages/CompetitorWatch/components/ContentLibrary.tsx` | The Library surface: shelves rail, filter bar, entry cards + expand |
| `src/pages/CompetitorWatch/watch.css` | Scoped `.cw-root` design system (control-room; Fraunces + IBM Plex, copper/cream/charcoal) |
| `src/lib/customPages.ts` / `src/App.tsx` | Page registration (`competitor_watch`, `/competitor-watch`, admin default) |

## Open questions / known limitations

- **Only the Content Library ships in v1.** Agents & runs, Content pipeline,
  Storage, and Companies are designed (mockups) but not built — they need their
  own gathering RPCs (`mkt_agent_activity`, `mkt_pipeline_health`,
  `mkt_storage_usage`, `mkt_company_account_roster`).
- **Full transcript text is not inlined yet** — only a presence flag. A per-post
  "load transcript" fetch is the follow-up.
- **Competitor filter is click-to-filter** (from a row); no standalone competitor
  dropdown yet.
- **The "learner" agents** that study this corpus are the next major build; this
  Library is their foundation.
- **Follower / engagement completeness** inherits the pipeline's gaps (e.g. views
  absent on some platforms) — shown as-is, never faked.
