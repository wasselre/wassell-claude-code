# PRD: Marketing Workspace (مساحة التسويق)

**Status:** Live
**Last updated:** 2026-08-05
**Related PRDs:** [access-control.md](access-control.md), [marketing-intelligence.md](marketing-intelligence.md), [posts-content.md](posts-content.md), [projects-units.md](projects-units.md), [navigation-layout.md](navigation-layout.md)

## What it is (in plain English)

A **second workspace** in the app, sitting beside the Sales one. You switch between
them from a control at the top of either shell: in Sales it is a pill in the
header, in Marketing it is the button at the top of the rail. The Marketing
Workspace has its own navigation, its own colours and type, and its own screens —
it is not a page inside Sales.

Inside it, the marketing team runs one pipeline: an idea becomes a piece of
**content**, the content moves through a **workflow** of stages, each stage sits
with a **role**, and the person filling that role does the one thing the stage
asks for. Along the way the content collects **material** (photos, footage,
designs), gets **published** to one or more platforms, and later collects
**numbers**. Paid spend lives alongside it as **campaigns** and their
**executions**.

The design decisions the business made and this build keeps: Arabic-Indic
numerals everywhere, Amiri throughout including dense tables, numbers entered by
hand at first, publishing always manual, workflows pointing at roles rather than
people, and every screen usable on a phone.

## Why it exists

The marketing process lived in Google Sheets and Drive folders: a status column
somebody had to remember to update, a "who has it now?" that was answered by
asking, and material that was found by scrolling a shared drive. The previous
in-app attempt reproduced that inside the Sales shell and was rejected — slow,
re-loading on every move, and visually indistinguishable from the CRM around it.

This workspace answers the three questions the old process could not:
**what is stuck, who is holding it, and did it work.**

## Key behaviors

- **Status and owner are DERIVED, never stored.** Both come from the single open
  task via the `mos_content_v` view. There is no status dropdown anywhere, which
  is why the content list can never disagree with the task queue.
- **At most one open task per content item** (enforced by a partial unique
  index). Work is always in exactly one place.
- **A rejection needs a reason.** Requesting changes without a note is refused by
  a CHECK constraint and by the UI, because a blind rejection just restarts the
  loop. Rejection sends the work back one stage as a **new round**; nothing is
  overwritten, so "why did this go back twice?" is answered by scrolling.
- **Approval is split three ways.** Marketing Manager approves creative,
  Operations Supervisor approves process, CEO signs off budget and approves no
  content. That split is what stops one person becoming everyone's queue.
- **Type is a column, not a module.** Post, Video, Carousel and Story are rows in
  `mos_content_types`; each names its workflow, its ref prefix and its writing
  fields. Adding a Brochure type later is a row, not a screen.
- **Headlines ARE the post, not a shortlist.** In the Content tab's writing
  surface the headlines are the copy that lands on the design. You write as many
  as the piece needs — there is no forced count and no "approve one" picker; none
  is discarded. (The legacy separate "on-design copy" field is gone — headlines
  do that job — and the old `approved_headline` / `slides` keys are ignored if
  present in older records.) The design brief's **Reference** is a *pick from the
  content library* — the existing post/video this design should take after — not
  free text. The picker browses the whole library (thumbnail preview per item —
  the piece's final cut, or a type-tinted placeholder), searchable by ref/title
  and filterable by content type and project.
- **One publication row per platform** — never a multi-select. Each platform
  carries its own caption, time, link and result.
- **Publishing is manual by decision.** `can_publish` defaults FALSE and nothing
  in the app flips it; Settings → Platforms says so plainly rather than implying
  an automation that does not exist.
- **Metrics are append-only dated snapshots.** Nothing overwrites a reading, so
  two items can be compared at the same AGE. An empty box saves as NULL, never 0
  — a CHECK constraint refuses an all-empty reading. Each snapshot carries the
  core readings — **views, engagement, enquiries** — plus the **engagement
  breakdown: likes, comments, saves** (all first-class nullable integer columns
  on `mos_metric_snapshots`; the not-empty CHECK counts any of the six, plus
  `extra`). The Numbers capture grid and the Performance tab's «إدخال أرقام»
  modal collect all of them; the per-publication view `mos_publication_v`
  exposes each as `latest_*`.
- **The shoot backlog is derived.** Every scene still marked `missing` is a shot
  someone has to film, whether or not a request exists for it yet.
- **"Unused material" is a LEFT JOIN**, not a counter anyone maintains. The
  library (design screen 16) groups cards by project × kind, stamps each card
  with its usage («مستخدمة في ٥», «نسخة معتمدة» for a final cut, «مجموعة ن»
  for a grouped set, mm:ss for videos), toggles between grid and list, and
  leads with a «لم تُستخدم قط» banner that links to the unused-material screen
  (`/m/library/unused`). Cards open the asset page (`/m/library/:assetId`).
- **Material intake — direct multi-file upload (2026-08-04).** The «مادة جديدة»
  (New material) modal on a content piece's Materials tab (`NewAssetModal` in
  `src/pages/Marketing/components/MaterialsTab.tsx`) **uploads files directly** —
  a drag-drop/click zone (`multiple`) queues one or MORE files and streams each
  browser→`marketing-assets` bucket via `uploadToStorage`
  (`src/pages/Marketing/lib/upload.ts`, the same engine as the bulk intake queue),
  with per-file progress and HEIC→JPEG conversion. **One `mos_assets` row is
  created per file** (each linked as role `source`); shared Source/Shot-on/Tags
  apply to the whole batch, `kind` is the select for a single file and
  auto-detected per file for a batch, and the name is the field for a single file
  or each file's own filename for a batch. A per-file failure is surfaced and
  skipped without sinking the rest (partial success links what succeeded). Each row
  fills `mos_assets.url` (public URL) + `file_path`/`mime_type`/`size_bytes`/
  `original_name`. The storage write is gated by the `manage_assets` capability.
  **The old Drive/anywhere link field was removed** — the modal was link-only
  ("الرابط يكفي…") through 2026-08-04 AM, then briefly upload-or-link; it is now
  upload-only (paste-a-link is gone per user request). Pulling an existing library
  row into a piece still works via «سحب من المكتبة».
- **Cost per lead is computed** from the execution rows, never typed.
- **A campaign's whole detail screen is organic-vs-paid aware.** `kind` decides
  what every metric surface shows. A PAID campaign is judged on qualified leads
  and its content is scored on ad-campaign spend/leads/qualified. An ORGANIC
  campaign has no ad buys, so: the Ad-campaigns tab, the overview's platform-ad
  card, and the budget-shift control are hidden; the Content tab's filter reads
  «كل المنصات» (not «كل الحملات الإعلانية») and lists the platforms the content
  was **published** to; and the content table swaps its أُنفق/عملاء/مؤهلون
  columns for **المشاهدات / الإعجابات / التعليقات / الحفظ** (impressions /
  likes / comments / saves). Those organic numbers are summed **from each
  linked item's publications** (`mos_publication_v` latest reading per
  publication), because
  the campaign rollup (`mos_campaign_v.total_impressions`) only counts
  ad-campaign impressions — of which an organic campaign has none. The «مقابل
  الهدف» pace card, the projection sentence and the results-gap verdict likewise
  count reach («مشاهدة») instead of qualified leads for an organic campaign.
  «الأفضل أداءً» is most-impressions (tie → most engagement) for organic, most-
  qualified (tie → cheapest) for paid. The overview/results **«ما بعد النشر»**
  card (paid: «ما بعد الإعلان») shows the CRM funnel (leads → qualified →
  appointments → visits → reservations, «من نظام العملاء») for a paid campaign,
  but for an organic one it shows the **reach aggregate** — impressions,
  engagement, likes, comments, saves, enquiries, «من المنصات» — summed across the
  campaign's content (NULL, shown «—», when nothing is read yet).
- **A content piece names its campaign.** The content detail header carries a
  copper, clickable **«الحملة: …»** chip when the piece is linked to a campaign;
  it opens that campaign's detail screen. (Previously the campaign name rendered
  as a plain, unlabelled tag indistinguishable from the project tags.)
- **A campaign is judged by one or more success measures**, each picked from a
  managed registry (`mos_measure_types`, four presets seeded) or defined inline.
  A measure carries a **direction** (higher/lower is better → "or more"/"or less"
  wording) and a **unit** — `count` (bare number), `currency` (riyals), or
  `percent` (`٪`/`%`). The chosen label/direction/unit are snapshotted onto the
  campaign so a later rename never rewrites history. Defining a measure (inline or
  in Settings → Success measures) **auto-translates the name between Arabic and
  English** as you type, the same live `/api/translate` flow the Builder uses.
- **The campaign brief's «الجمهور» (audience) is a saved, reusable record**, not a
  one-off line typed fresh each time. An audience is a title (`name`) plus a large
  `details` field, kept in a managed registry (`mos_audiences`). On the brief you
  **pick an existing audience or define a new one inline** (which persists it to the
  registry for reuse and lists it in Settings → Audiences). The chosen record's
  **name is snapshotted** onto `mos_campaigns.audience` so every join-free reader
  (the brief read grid, search's `audience` match) keeps rendering a concise label,
  while the campaign also stores `audience_id` and the read/edit surfaces resolve the
  live `details` through it. Legacy campaigns that carry free-text audience with no
  `audience_id` keep showing that text until the brief is edited and a saved audience
  is chosen — nothing is dropped. Deactivating an audience is hide-not-erase (the
  registry row stays; campaigns keep their name snapshot). Audiences are
  single-language free text, like the goal/offer brief fields.
- **Refs come from one row-locked allocator** (`mos_next_ref`), so two concurrent
  creates can never mint the same number. The allocator is `SECURITY DEFINER`:
  a user allowed to insert the ROW must be able to get a NUMBER without being
  granted write access to a shared counter table.

## User flows

1. **Main happy path — an idea becomes a published post.**
   New content → pick a type (this fixes the workflow, the ref prefix and who
   gets the first task, all previewed before you commit) → the first task opens
   for its role → that person does the stage and submits → the next role
   approves or sends it back with a note → material is linked, scenes filled,
   platforms scheduled → someone posts it manually and marks the row published →
   the numbers are entered on Friday from the Weekly numbers screen.

2. **Bottleneck hunt (manager).** Overview → four counters answer "is the machine
   running?", then "stalled — nothing moved in 48h" lists the oldest-untouched
   open work, longest first, each row carrying a «تذكير» button that nudges the
   open task's holder (`remind`). A working segmented control (هذا الأسبوع /
   الشهر / الربع) re-runs the same screen over a month or a quarter
   (`overview` takes a `period` param); the week card also shows items aimed at
   the period but still lacking a slot («بحاجة لموعد نشر»).

3. **A maker's day (writer / editor).** My work → three groups in order: late,
   yours today, someone else's. The third is deliberately faded so nobody chases
   a task that is not theirs. Row buttons name the action ("ابدئي الكتابة",
   "جدولة"), not "فتح". Below them sits the «القادم إليك» band — future steps
   for MY role on in-flight items, derived from each item's PINNED workflow
   version (`work_list.upcoming`). It is explicitly NOT a task list: the item
   becomes a task only when the path advances to that step.

4. **Load balancing (ops supervisor).** Team work (`/m/team`) → four role-load
   tiles (roles, not people), every open task sortable by role / project / due
   date, stalled rows carrying «تذكير» and «نقل» (transfer inside the SAME
   role), an imbalance card that only ever proposes «تأجيل / تقديم»
   (`task_update` moves the due date — roles are not interchangeable and the UI
   says so), the creative-vs-process approvals split, and a verbatim «ما لا
   تستطيع فعله» card for the ops supervisor.

5. **CEO overview (`/m` as CEO).** Same nav item, completely different content
   (`ceo_overview`): month/quarter/year segmented — produced-vs-previous
   period, spend vs committed, qualified leads, attributed reservations; a
   riyal→reservation funnel (`campaign_outcomes` aggregated over the listed
   campaigns); campaigns ordered by return; a six-month production chart; and
   the «بانتظار توقيعك» card listing campaigns past the signature threshold
   with the «توقيع» action (`campaign_sign`). NO task lists anywhere — the CEO
   is not a production manager.

6. **Empty states.** Every screen states what would fill it and why: an empty
   library explains that material is an object in its own right; empty Weekly
   numbers explains that rows appear once a publication is marked published.

7. **Error state.** A failed load shows the message plus a Try again button.
   Nothing is swallowed. A partial save (Weekly numbers) reports how many rows
   saved and how many failed — never a blanket success.

8. **No role granted yet.** Until someone is granted a marketing role, everyone
   who is not an app admin is a Viewer: full read, no writes. Settings → Roles
   leads with that warning while it is empty.

## Data touched

- **Reads/writes:** `mos_content`, `mos_tasks`, `mos_scenes`, `mos_publications`,
  `mos_metric_snapshots`, `mos_campaigns`, `mos_campaign_executions`,
  `mos_assets`, `mos_asset_links`, `mos_shoot_requests`, `mos_shoot_items`,
  `mos_comments`, `mos_role_grants`, `mos_content_types`, `mos_measure_types`,
  `mos_audiences`, `mos_workflows`,
  `mos_workflow_steps`, `mos_platform_accounts`, `mos_ref_counters`.
- **Views:** `mos_content_v` (derives status/owner from the open task),
  `mos_publication_v` (latest snapshot per publication), `mos_campaign_v`
  (spend/leads summed from executions).
- **Reads only:** `v_all_projects` (project names for the brief), `users`
  (role→person mapping).
- Shares NOTHING with the `mkt_*` tables — those belong to Marketing
  Intelligence, which watches competitors.

## Key files

| File | What it does |
|---|---|
| `src/pages/Marketing/MarketingWorkspace.tsx` | The shell: rail, workspace switcher, workspace-wide context (role, content types, project names), access gate |
| `src/pages/Marketing/mos.css` | The design system, scoped under `.mos-root` so the Sales theme is untouched |
| `src/pages/Marketing/OverviewPage.tsx` | Overview — manager state (s01: counters, stalled, week, paid ads) and CEO state (s34: funnel, returns, production, signature) branched on the active role |
| `src/pages/Marketing/WorkPage.tsx` | My work (s02) — late / yours today / someone else's + the «القادم إليك» band |
| `src/pages/Marketing/TeamPage.tsx` | Team work (s35) — role-load tiles, every open task, imbalance + approvals cards |
| `src/pages/Marketing/ContentListPage.tsx` | The content library — table and board |
| `src/pages/Marketing/ContentDetailPage.tsx` | The content workspace — six tabs as local state, stage rail, thread |
| `src/pages/Marketing/CampaignsPage.tsx` / `CampaignDetailPage.tsx` | Spend: campaigns, executions, results |
| `src/pages/Marketing/LibraryPage.tsx` / `ShootsPage.tsx` | Material library and the derived shoot backlog |
| `src/pages/Marketing/NumbersPage.tsx` | The Friday data-entry screen |
| `src/pages/Marketing/SettingsPage.tsx` | Workflows, content types, platforms, roles + the capability matrix |
| `src/pages/Marketing/components/SettingsWorkflows.tsx` | The workflow path/step editor — each step carries an owning role and a **due-in-days** value (`due_days`, integer ≥ 0; `0` = same day, i.e. the task is due the day the step opens) that the engine turns into the task's `due_at` (`now() + due_days days`) |
| `src/pages/Marketing/components/` | Shared primitives (`kit.tsx`), icons, task card, stage rail, writing fields, scenes, publishing, performance, material, thread |
| `src/pages/Marketing/components/SuccessMeasuresEditor.tsx` / `SettingsMeasures.tsx` | A campaign's multi-measure success criteria + the managed measure-type registry (both auto-translate the name; unit = count/riyal/percent) |
| `src/pages/Marketing/components/AudiencePicker.tsx` / `SettingsAudiences.tsx` | The campaign brief's saved-audience picker (pick existing or create inline) + the managed audiences registry (`mos_audiences`: name + details) |
| `src/hooks/useBilingualLabelAutofill.ts` | Live Arabic⇄English name auto-fill for local-state label pairs (wraps `useDebouncedTranslation`) |
| `src/pages/Marketing/lib/format.ts` | Arabic-Indic numerals and dates — one place that decides digit shape |
| `api/marketing-os.ts` | The action-dispatch endpoint; runs on the caller's JWT, never service role |
| `src/lib/marketingOS/client.ts` | Typed SPA client + the bilingual label maps |
| `src/components/Layout/Header.tsx` | The Sales-side half of the workspace switcher |

## Open questions / known limitations

- **Platform connections are not implemented.** Every account is "not connected";
  scheduling records intent and a human posts. Real auto-publish needs Meta and
  TikTok app review, which is a separate business decision.
- **Metrics are manual.** The `source` column already distinguishes
  `manual` from `api` so a later integration can backfill without rewriting
  history.
- **The mobile layout ships and is structurally verified** (drawer rail, stacked
  split panes, collapsing grids, tables scrolling inside their card) but has not
  yet been walked screen-by-screen on a real phone-width viewport.
- **The 2026 palette is not in this module.** It uses the palette the rest of the
  app ships; migrating the app-wide Tailwind theme is separate work.
- Notifications (design screen 43) are not built — the task queue is the
  notification surface for now.
