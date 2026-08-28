# PRD: Marketing Workspace (مساحة التسويق)

**Status:** Live
**Last updated:** 2026-08-28 (**Campaigns & Goals: multi-select + bulk delete.** The campaigns table (`/m/campaigns`, desktop view) gained a checkbox column + select-all + a «N محدد» bar with a confirmed bulk **Delete** — same pattern as the Content list — gated on `delete_records`; the goal cards (`/m/goals`) gained the same (checkbox per card + bar + confirm), gated on `approve_budget` (matching goal_save and the `mos_goals` DELETE RLS). New actions `campaign_delete` (bulk; refuses the Meta-sync holder with a bilingual 409, pre-checks + FK-backstops the `client_attributions` RESTRICT so a campaign carrying client-acquisition records can never be deleted, detaches `mos_content.campaign_id` provenance first; executions/comments/events/goal-links cascade, publications/tasks unlink) and `goal_delete` (bulk; campaign links detach via the junction CASCADE, campaigns survive; returns the refreshed `{ goals }` list like goal_save). Client wrappers `deleteCampaigns` / `deleteGoals`. The Meta-sync holder row's checkbox is disabled with a tooltip. No migration — both DELETE RLS policies already existed. Prior note (same day): **Fix: a paid campaign's bulk content no longer lands «إعلانات ميتا» in the ORGANIC placements section.** The New-paid-campaign wizard used to seed each planned content piece with one draft `mos_publications` row per execution *platform* — but an execution platform is an AD channel («إعلانات ميتا»), not an organic feed, so the Placements tab showed a Meta-ads card under «أماكن النشر العضوية» and the derived `purpose` read `organic`. Now each bulk piece gets one **paid placement** (a waiting `mos_execution_ads` row via `content_ad_creative_save`) per created execution instead, so it appears under «أماكن الإعلان المدفوع» and derives `purpose='paid'`. Defense-in-depth: `publication_save` and `content_caption_save` now REFUSE ad-only channels (`meta`, `google`) with a loud 400 — a publications row is the organic surface, full stop. The 8 mis-seeded rows (C-033's P-120…123 / V-034…037, all empty untouched drafts) were swapped for real paid placements in the live DB. Prior note: **Design-brief references: multiple files, with real preview cards.** The content tab's design-brief «مرجع» was a single-file text button that, once saved, only re-opened the raw file. It is now «مراجع» — a strip of MANY reference files (`ReferenceFilesStrip` in `WritingFields.tsx`), each a real card: an image/video thumbnail (batch-signed view URLs) or a kind icon + label, the file name, and a click that opens the Files system's OWN `FilePreviewModal` in place (image lightbox / in-app pdf.js viewer / video player — no navigation away). Edit mode gives each card an × and a «+ إضافة مرجع» that opens the shared Files picker (search + library cards + upload). Stored as `mos_content.data.design_reference_file_ids: string[]`; the legacy single keys (`design_reference_file_id`/`_title`) are kept in sync to the first entry for backward-compatible reads, and pre-existing single-reference content is read through that fallback. No schema/migration (free-form `data` jsonb). Supersedes the «Design-brief «مرجع»/Reference now points at the Files library» note below. Prior note: **Ad creative picker is content-records-only.** The `ContentPicker` used by the Ad-sets-&-ads editor (`CampaignTreeModal`) and the new-paid-campaign builder (`CampaignExecutionsBuilder`) dropped its Asset-library and «+ رفع»/Upload sources — an ad's creative is now picked ONLY from the Content list (`mos_content` records), because linking an ad to a content record is what makes that ad a **paid placement** of the creative (an `mos_execution_ads` row with `content_id`; the content's Placements tab and the derived `purpose` in `mos_content_v` pick it up on save — a note under the select says exactly that). Legacy ads that carry a library asset in `creative.asset_*` still RENDER that pick as a «من المكتبة (قديم)» option and keep it verbatim on save, but no new asset picks are possible; the per-ad `AdModal` was already content-only. Supersedes the earlier «Ad creative picker: content list · library · upload» note below. Prior note: **Performance & load system shipped — see the dedicated PRD [marketing-performance.md](marketing-performance.md).** The workspace gained: capacity-aware placement + SLA due dates on every `workflow_role_tasks` open (the engine RPCs now call `mos_perf_place_open_task`), two rail surfaces — **«ملفي» `/m/me`** (`myperf`, every role: XP/rewards/late counter/leaves/KPI status) and **«مكتب الأداء» `/m/performance`** (`performance`, manager+ceo: pending discipline/leave/reward decisions, load heatmap, KPI goals, system toggles) — two Settings sub-pages (**Load & SLA** `/m/settings/load`, **Posting cadence** `/m/settings/cadence`), a coverage strip on `/m/calendar`, a rating card on a done creative (`rate_creative`), and two new capabilities `rate_creative` / `manage_performance`. Consequences ship dark (observe mode on, deductions off). Prior note: **Placements tab — a creative is neutral; each placement carries its own campaign.** A content item is now a **standalone record**: its `campaign_id` is only *provenance* ("born here"), NOT ownership, and no longer constrains where it runs. Captions + ad copy moved off the content tab into a dedicated **Placements** tab (`PlacementsTab.tsx`, replacing the purpose-gated `PlacementCaptions`, gated on `view_content_body`). Each placement carries its **own campaign link**: an **organic** placement (`mos_publications` row: platform + account + caption + schedule) links to an organic campaign — existing, created inline, or **none** (new nullable `mos_publications.campaign_id`); a **paid** placement (`mos_execution_ads` row) attaches to **any** paid campaign's execution + ad set (existing or created inline) — the old "must match the content's campaign" guard is **removed**. `purpose` is **no longer authored** — it is DERIVED in `mos_content_v` from the placements that exist (backward-compatible: falls back to the stored value when a content item has no placements yet), and is dropped from `CONTENT_EDITABLE` + the New-content/bulk-create purpose selectors. New/changed server actions (all `write_content`-gated): `content_paid_ads` + `loadPaidAdsPayload` rewritten to list the creative's REAL ad rows across any campaign; `content_ad_creative_save` accepts `ad_id` (edit) OR `execution_id` + `ad_set_id`/`new_ad_set_name` (add); `paid_placement_remove`; `paid_placement_targets` (the campaign→execution→ad-set picker); `publication_save` now accepts `campaign_id`; `publication_remove`. Migration `2026-08-28_placements_decouple.sql` (adds `mos_publications.campaign_id` + derived-purpose view), applied live. **Follow-ups same day:** (a) the per-content **Publishing tab («النشر») was MERGED into Placements** — its organic section now reuses the full `PublishTab` (approved-file picker, «انشر الآن»/«جدولة», bundle status, retry) plus the organic-campaign link (new shared `OrganicCampaignSelect`), so a placement is one complete thing; the standalone Publishing tab is gone (the Overview «خطة النشر» «فتح» now opens Placements), while the **workspace** Publishing Board (`/m/publishing`) stays as the cross-content calendar. (b) A paid placement can **attach to an existing UNLINKED ad** in the chosen ad set OR add a new one — `content_ad_creative_save` with `ad_id` now links a null-`content_id` ad to the creative (refuses one already linked to another creative), and `paid_placement_targets` returns each ad set's ads (with a `linked` flag). Prior note: **Materials tab: move a file between «المواد الأصلية» and «ملفات العمل» in place.** Each attached source/working file now carries a «نقل إلى ملفات العمل» / «نقل إلى المواد الأصلية» button that re-roles the `mos_asset_links` row (`source` ⇄ `reference`) via the existing `asset_link` upsert — no more unlink-and-re-pull to relabel. The approval band is deliberately untouched: `final` is still earned only through the manager's approval (`mos_promote_approval_asset`), so nothing can be hand-moved into or out of «المعتمد والمنشور». UI-only, no schema change. Prior note: **Captions & ad copy are authored on the PLACEMENT, and the content tab splits paid vs organic.** The content tab's writing surface used to show FOUR hard-coded caption boxes (Instagram/TikTok/X/Snapchat) for every item — including paid ones — stored in `mos_content.data.caption*`, which the publish path NEVER read (it reads `mos_publications.caption`, re-typed by hand in the Publish tab), so a writer's caption was a dead draft. Now (Option A): a caption belongs to the placement it runs on. New component `PlacementCaptions.tsx` (rendered by `ContentDetailPage` next to `WritingFields`, which lost its caption card) drives the surface off the item's **`purpose`**: **organic** → one caption editor PER selected organic platform, each bound to that platform's `mos_publications` row (the SAME row the Publish tab schedules and bundle.social posts — the caption a writer types is finally the one that publishes), plus a shared hashtags field; **paid** → one ad-copy card per campaign execution (primary text / headline / description / CTA / destination URL) → `mos_execution_ads.creative`; **both** → both blocks under «للنشر العضوي» / «للإعلانات المدفوعة» headers. A per-content **platform picker** persists which organic channels are in play in the NEW column **`mos_content.organic_platforms text[]`** (paid platforms come from the linked campaign's executions), so caption editors show only for the platforms actually targeted. Writes go through `write_content`-gated actions that touch only the copy text via the service client — `content_caption_save` (lazy-upserts the platform's draft publication, caption only; scheduling stays gated by `schedule`) and `content_ad_creative_save` (lazy-upserts the ad row for (execution, content), creative only, and links the execution to the content; ad structure/metrics stay gated by `manage_paid_ads`/`enter_metrics`); read `content_paid_ads` returns the paid-authoring surface. Shared hashtags stay on `mos_content.data.hashtags` and are folded into each organic caption at publish (`publication_publish`), leaving the authored caption clean. Migration `2026-08-26_mos_content_organic_platforms_placement_captions.sql` (adds the column, appends it to `mos_content_v`, backfills any legacy `data.caption*` into publication rows + seeds `organic_platforms`), applied live. Client wrappers `saveContentCaption` / `fetchPaidAds` / `saveAdCreative` + `MosContentRow.organic_platforms`. Prior note: **Templates moved to the EXECUTION (ad-campaign) level.** Per the operator, a saved template should capture an **ad campaign's SETTINGS** — platform + budget/objective/conversion-goal/dates plan + ad sets + ads — NOT a whole parent campaign. So the parent-level template UI was removed (New-campaign is a plain modal again, no `CampaignStartChooser`) and the feature now lives inside `CampaignExecutionsBuilder`: **«+ إضافة حملة إعلانية»** opens `ExecStartChooser` («من الصفر» or a saved settings template), and the execution editor (`ExecDraftEditor`) gained a **«حفظ كقالب»** footer button. A template's `setup` = `{ platform, settings, adSets }`, where each ad carries only its **name + caption** scaffold — **content picks are stripped** (content is per-project, added fresh each time). Applying re-keys every exec/ad-set/ad and starts content empty. Stored in ONE `mos_settings` row (`execution_templates` → {items}; no migration); server actions renamed `execution_templates_list`/`_save`/`_delete`; client type `ExecutionTemplate` + `fetchExecutionTemplates`/`saveExecutionTemplate`/`deleteExecutionTemplate`. Prior note: **Campaign templates + content bulk-generate (kept).** (a) NEW: campaign **templates** — «حفظ كقالب» on a New campaign saves its whole setup (goals/project/budget/executions/content) into ONE `mos_settings` row (`campaign_templates` → {items}; no migration); the New-campaign button opens a **chooser** («من الصفر» or a saved template) via `CampaignStartChooser`, and picking one prefills `CampaignModal` (seeded state, re-keyed exec/content rows) so you just fill names. Server actions `campaign_templates_list`/`_save`/`_delete`. (b) The content generator kept its **bulk generate** (base title + type + count → N rows) restored on top of the simplified per-piece fields (Type + Title + Notes; platform/project derived). Prior note: **Content generator simplified to Type + Title + Notes.** `CampaignContentBuilder` no longer asks platform, project, purpose, count or schedule per piece — each content row is just a small Type picker + Title + Notes. Platform is DERIVED from the ad campaign (its executions), project from the parent campaign, and the Notes land in the content's `data.notes` (the field the detail-page «الموجز» shows). Removed the shared/per-row platform chips, ProjectPicker, purpose control, generate-N and weekly scheduler. Prior note: **Campaign-modal polish: goals dropdown + in-app discard guards.** (1) The campaign brief's «الأهداف»/Goals field is now a **dropdown** multiselect (`GoalMultiSelect` — a trigger showing the chosen goals + a click-away panel of toggle rows) instead of a flat wrap of chips. (2) The dirty-close guard on BOTH the New-campaign modal (`CampaignModal.requestClose`) and the execution editor (`ExecDraftEditor`) now uses an **in-app** themed «تجاهل التغييرات؟» confirm modal instead of the browser's «app.wassel.re says» `window.confirm`; the execution editor gained a dirty check so it warns too. Prior note: **New-campaign popup guards unsaved changes.** The New/Edit-campaign modal (`CampaignModal`) no longer discards work when you click the backdrop or press Escape. It snapshots the form's opening state and, when anything changed (goal, goals, projects, owner, dates, budget, status, success measures, or any planned content/ad-campaign draft), a backdrop click / Escape / the header ✕ / Cancel all route through a guarded `requestClose` that asks «لديك تغييرات غير محفوظة… تجاهلها وإغلاق النافذة؟» before closing; while a save is in flight, close is ignored entirely. A pristine form still closes instantly. UI-only, no schema change; matches the existing `dirty && !window.confirm(...)` pattern in `SettingsWorkflows`. Prior note: **Marketing perf: killed the white-flash + the boot-time market_listings sweep.** (1) MarketingWorkspace now wraps its `<Outlet>` in its OWN dark-skeleton `Suspense`, so a lazy page-chunk load no longer bubbles to the app's cream full-screen fallback (the "white loading page on every click"). (2) The eager background slim-full-load of ~46k `market_listings` rows (~31MB / hundreds of keyset requests, fired on EVERY boot in `appStore.initialize`) was REMOVED — it saturated the connection for users who never open the Finder (all of Marketing). It's now on-demand: the market_listings LIST page loads it on mount; a single-listing deep link fetches just that record (`RecordFormPage` summaryDetail); the Finder matches server-side. Prior note: **Removed the design-brief «الصيغة»/Format field** (both edit + locked views + its helpers) per operator request — the design brief is now just «الاتجاه البصري» (visual direction) + «مرجع» (Files reference). Prior note: **Design-brief «مرجع»/Reference now points at the Files library.** The reference field (WritingFields design-brief card) used to pick another CONTENT piece (`mos_content`); it now picks an example FILE from the unified Files library (`business_files_search`), stored as `design_reference_file_id` + `design_reference_file_title` in the content's `data`. The old content-library `ReferencePicker` (+ its content-list load, thumbnails, `projectName` prop) was removed. Content record untouched. Prior note: **Content «المواد» pulls from the Files library.** The content item's «سحب من المكتبة» now browses the unified FILES library (debounced `business_files_search`) instead of the old `mos_assets`-only picker. Picking a file calls the new `asset_link_from_file` action, which FIND-OR-CREATES a `mos_assets` wrapper for that file (kind derived from `files.kind`, bytes shared via `file_id`) and links it to the content with a role band — so approval/publishing/role bands are untouched, and the CONTENT record (`mos_content`) is never touched. «إضافة مادة جديدة» already uploads into Files storage. Material stays a `mos_assets` object by design (the middle layer); only its SOURCE is now the Files library. Prior note: **Content tab: per-platform caption rows + الصيغة multiselect.** The writing surface («المحتوى») caption card is now one compact 2-row textarea PER platform (Instagram=legacy `caption`, TikTok/X/Snapchat = `caption_*` companion keys in `data`) instead of a single big Instagram box; the «set in Publishing» note was dropped. «الصيغة»/Format is now a multiselect of deliverable type + canvas size (toggle chips over `FORMAT_OPTIONS`, stored as a string array on `design_format`; legacy free-text tokens are preserved). Prior note: **Content brief («الموجز») trimmed to Project + Notes.** The overview «الموجز» card (read + edit) now shows ONLY the project and a free-text notes field (`data.notes`); Goal/Audience/Angle/CTA/Publishing-to/Target-duration were removed from that card per operator request (the underlying goal/audience/… columns are untouched, just no longer surfaced there). The Publishing-plan card is unchanged. Prior note: **Fix (project info tab): resolve الموقع/Location geography ids to place names (district · city · region), and show the handover date WITH its year (`fullDate`). Prior note: **Content inherits its campaign's project + two new project tabs for the writer.** (1) `content_create` now derives `project_ids` from the campaign when none is given — a content piece under a campaign inherits that campaign's project(s), so the writer never re-picks it. (2) The content detail page gains two tabs (shown when a project is known, direct or via the campaign): **«مواد المشروع» / Project assets** — every file linked to the project's all_projects record, via the shared `RecordFilesPanel`; and **«معلومات المشروع» / Project info** — a curated read-only facts sheet (developer, project/construction status, location, available units, **available** price/area ranges + bedroom range + price/m² [customer-facing = available-only], handover date + on/post-handover payment terms, developer brochure link, project analysis) resolved by the new `project_info` marketing-os action (labels from the model schema, values from the record; the client formats by `kind`). Goal: the writer has every reference and number in one place. Prior note: **Client acquisition is now LIVE — every ad-sourced lead is tied to the ad that brought them in.** The dormant `client_attributions` ledger (added 2026-08-01) became a working acquisition/source system, WITHOUT copying any marketing data onto the client. The design: **Client → Acquisition (an append-only `client_attributions` row) → Ad → Content + Project + the rest of the marketing hierarchy** — the Ad is the hub; the ledger is history that supports first-touch / latest-touch and multiple sources. A new **`channel`** column (`paid_ad | organic | referral | direct | other`) with a channel-aware CHECK (only `paid_ad` rows must name a spend object — ad/execution/campaign) lets the same ledger carry non-paid sources later; paid ads are just the first channel. Two SECURITY DEFINER RPCs: **`mos_capture_ad_acquisition`** is the webhook entry point — an inbound WhatsApp message that resolves to one of our paid ads finds-or-creates the client, tags its source «ترويج» (Promotion), and appends the ledger row (see [chats.md](chats.md)); **`mos_client_acquisition`** is the Sales read surface — it returns a client's touches resolved LIVE through the Ad (channel, platform, campaign, ad set, ad, project, offer, content, date, first/latest-touch), gated on being allowed to VIEW the client, NOT on a marketing role, so a rep with no MOS capability still sees where their lead came from. The migration also backfilled 42 first-touch rows for existing ad-resolved conversations already linked to a client. The read surface renders on the client record as the «كيف وصلنا هذا العميل» panel (see [clients.md](clients.md)), each touch deep-linking to `/m/campaigns/:campaignId/exec/:executionId`. Migration `2026-08-23_01_client_marketing_acquisition.sql`, applied live.) | 2026-08-20 (**«Create in Meta» is now all-or-nothing (no more false «linked» badge).** A push used to create the Meta campaign, immediately stamp `platform_campaign_id` (which lights the «✓ مربوطة بميتا» badge), THEN create ad sets — so a rejected ad set left a half-built campaign in Meta reading as "linked" but broken. Now `meta_push_structure` defers ALL link writes: it creates the campaign, then every ad set; if ANY ad set is rejected it **deletes the just-created Meta campaign** (cascading its ad sets) via the new `MetaMarketingClient.deleteNode`, writes NOTHING back, and returns Meta's actual rejection (HTTP 422, bilingual) so the buyer sees why. Only on full success are `platform_campaign_id` + each `platform_adset_id` persisted, so the "linked" badge can never lie. (An execution left "linked" by the OLD half-push can be unlinked by clearing its platform campaign id in the «على المنصة» card.) Prior note: **New paid campaigns are gated on a complete execution tree.** Creating a paid campaign can no longer produce an empty envelope: the New-campaign modal's lightweight per-platform budget-split picker is REPLACED (for `kind='paid' && isNew`) by `CampaignExecutionsBuilder` — you add one or more executions and must fully configure each (platform **plan** via `PlatformFieldsGrid` → **ad set(s)** → **ad(s)** with content + caption via `ContentPicker`). Each execution shows an «املأ الإعدادات / Fill settings» chip until complete (`execDraftComplete`: platform + objective + ≥1 named ad set + every ad named); **Create is disabled** until ≥1 execution exists and all are complete. On Create the whole tree is written together — `saveCampaign` (no lite executions) → per execution `saveExecution` (plan mirrored to `execution.budget`) → `saveCampaignTree` (ad sets + ads). Organic campaigns and edit mode are unchanged. Prior note: **Marketing Asset Library grid RETIRED → unified Files Library.** The standalone marketing grid at `/m/library` (`LibraryPage.tsx`) was deleted; the route now **redirects to `/files?view=marketing&origin=marketing_intake`**, and every in-app entry point (rail item, mobile tab, and the "back to library" buttons on `AssetDetailPage`/`UploadPage`/`ShootsPage`/`ShootRequestPage`/`LibraryUnusedPage`/`EmptyDayOne`) links there DIRECTLY via `marketingLibraryHref()` (`src/lib/files/libraryUrl.ts`) — no redirect double-hop. The sub-routes `/m/library/upload`, `/m/library/unused`, `/m/library/:assetId` are KEPT (reached from marketing global-search + within those pages). `mos_assets` and the `library` surface are unaffected — the retirement is UI-only. Prior note: **Ad creative picker: content list · library · upload.** In the Ad sets & ads editor, each ad's content is now chosen via a new `ContentPicker` with THREE sources — the **Content list** (`mos_content`, as before), the **Asset library** (`mos_assets`, grouped in the same select), and **+ رفع / Upload** (a new file straight into the library via the shared `NewAssetModal`, then auto-selected). Exactly one source is active per ad: a content pick sets `content_id`; a library/uploaded asset is carried in the ad's existing `creative` jsonb (`asset_id`/`asset_title`/`asset_url`/`asset_thumb`) — **no schema change**, since `creative` is where ad-level creative belongs. A chosen asset shows an inline thumbnail; the execution ads table falls back to the asset title for asset-backed ads. Prior note: **Ad sets & ads editor stops demanding Meta IDs.** The nested editor (`CampaignTreeModal`) treated the platform **Campaign ID** and per-ad-set **Ad Set ID** as manual text inputs — but both are Meta-owned and filled by the push, so prompting for them inside the campaign you're already in was noise. The Campaign ID input is now a read-only status line (`#id` when linked, else "created in Meta on «Create in Meta» — no id to enter"); the Ad Set ID input is gone (only the ad-set **name** is a planning input). The per-ad **Meta Ad ID** dropped its "★" prominence and moved below the caption as a small, clearly-optional attribution field ("added after the ad exists in Meta") — it's still the key inbound WhatsApp resolves against, just not a planning demand. Planning inputs are now: ad-set name, and per ad → content + caption. Prior note: **One-page campaign → ad sets → ads flow.** Creating a Meta/Instagram campaign now flows straight into the nested **Ad sets & ads** editor (`CampaignTreeModal`, retitled from "Set up ads (nested)") — the execution modal returns the new execution id (`execution_save` now yields `saved_id`) and `CampaignDetailPage` opens the tree inline, so the operator adds one OR MANY ad sets and, inside each, ads with **content + caption**, all on one page. The tree editor gained a **caption** field per ad (written to the ad's `creative.message` jsonb — merged, never clobbering AdModal-set creative; `campaign_tree_get/save` now carry `creative`). The dead **«المحتوى الذي يعمل هنا» / "content running here"** execution-level field was removed from the new/edit-campaign modal (it never affected Meta; per-ad content is the real link). The execution page's nested-editor button is now the primary «المجموعات والإعلانات» / "Ad sets & ads". Prior note: **Ad modal + targeting honesty for Meta.** The Add/Edit-ad modal (`AdModal`) now (a) has an **Ad set** selector (writes `ad_set_id`; shown only when the execution has ad sets — created in the nested tree editor), and (b) for meta/instagram makes **status read-only «من ميتا»** and hides the manual spend/clicks/leads/qualified inputs (excluded from the save patch so an empty box can't wipe Meta's synced numbers) — non-Meta platforms keep the manual status + metric fields. Separately, the execution's **Targeting** tab no longer shows the legacy free-text targeting brief for meta/instagram: the audience comes from the campaign's linked **Saved Audience** (set on the campaign page, pushed to ad sets on «Create in Meta»), so the tab shows a read-only Audience note instead; snapchat/tiktok show only their structured Platform-settings form; google/x/youtube keep the free-text brief as their only targeting surface. Prior note: **Fix: ExecModal's name field was mislabeled "Ad set name".** The New/Edit ad-campaign modal creates an EXECUTION (the per-platform line under a goal), not an ad set — but its name input was labeled «اسم المجموعة» / "Ad set name", so operators expected it to be where ad sets are added and worried the typed name drove Meta matching. Relabeled to «اسم الحملة الإعلانية» / "Ad campaign name" with a hint that it's the operator's own label and does NOT affect Meta matching (matching is by the `platform_adset_id`/`platform_campaign_id` captured on push, never by name). Multiple ad sets live in the nested tree editor («إعداد الإعلانات» → «+ إضافة مجموعة إعلانية») on the execution detail page, not here. Prior note: **Carousels: a publication can carry up to 10 approved files.** `mos_publications.asset_ids` (ORDERED uuid[], migration `2026-08-20_mos_publication_multi_asset.sql` applied live; `asset_id` is server-kept = the first entry so every single-file consumer is untouched). The Publish modal's file picker became an ordered multi-select for Instagram/TikTok (pick order = carousel order, ceiling 10, numbered chips); other platforms stay single-pick. Publish uploads every file to bundle (order preserved) and posts: **Instagram** — single video stays a REEL, anything else is a feed `POST` with 1–10 `uploadIds` (mixed images+videos allowed; `autoFitImage` when images present; a mixed carousel posts as a feed post, not a Reel — the checklist says so); **TikTok is no longer video-only** — an all-image set posts as **Photo Mode** (`type:'IMAGE'`, `autoScale:true`, no `autoAddMusic`), so the old «تيك توك يقبل الفيديو فقط» guard is gone; **Snapchat** stays exactly one file. `preflightPublishSet` (the set-shape twin of the single pre-flight, same shared rulebook file) enforces the shapes with per-file «الملف ٢:»-prefixed messages: IG ≤10 files / per-file image 8MB + video 3s–15min + 45Mbps; TikTok no mixing, one video max, Photo Mode 1–10 images **JPG/WebP only (PNG rejected!) ≤20MB each**; Snapchat exactly 1. Verified against bundle's REAL API: a 2-image IG carousel DRAFT and a TikTok `IMAGE` DRAFT both passed bundle's validation with our exact payloads, then were deleted (and GET on a deleted post returns `status:DELETED`, confirming the status sweep's DELETED branch matches reality). Prior note: **Fix: mobile cards leaked onto desktop as garbled text.** `styles/mobile-m4.css` (the `.m4-mob`/`.m4-desk` responsive toggle — `.m4-mob{display:none}` on desktop) was imported ONLY by CampaignsPage. After the route-level code-splitting, landing directly on another marketing page (e.g. a campaign's results tab) loaded the `.m4-*` classes with NO styles, so the phone-only comparison cards rendered on desktop as unstyled, run-together stats («صُرف ٧٨٢ ريال٤٣ عميلًا…»). Fixed by importing `mobile-m4.css` in the always-loaded `MarketingWorkspace` shell, so every `/m` page has the responsive rules regardless of which chunk loads first. Prior note: **One clean plan flow for Meta executions.** The New/Edit ad-campaign modal (ExecModal) now embeds the trimmed platform plan (`PlatformFieldsGrid` over the metaSchema — objective, budget CBO/mode/amount, conversion location, conversion goal, start/end date) as the SINGLE place a Meta/Instagram execution is planned. Removed the duplication: the standalone objective dropdown, the editable status (now read-only «من ميتا»), the internal purpose field, the manual platform-id input, and ALL manual metric inputs (spend/impressions/clicks/leads/qualified) are gone for meta/instagram — results come from the sync, the plan's budget mirrors onto `execution.budget` for lists. Non-Meta platforms (snapchat/tiktok/google) keep the old modal (objective + status + purpose + typed numbers) unchanged. The execution's «إعدادات المنصة» tab on the detail page stays as a consistent secondary editor of the same `platform_settings`; «إنشاء في ميتا» remains the push. Reframes the whole thing: this modal makes a Wassel PLAN — it does not create anything in Meta (that's the push). Prior note: **Organic publishing hardened into a reliable system (pre-flight + reconciliation + retry).** The bundle.social publish path graduated from "works when everything is right" to a guarded pipeline. **(1) Per-platform pre-flight** — a pure shared rulebook `src/lib/marketingOS/platformRules.ts` (imported by BOTH the SPA and `api/marketing-os.ts`, same blessed cross-import as `localizedName.ts`) encodes bundle's Platform Limits: caption ceilings (IG 2,000 — not the folkloric 2,200 — TikTok 2,200, **Snapchat 160**), IG ≤30 hashtags / image ≤8MB / Reel 3s–15min / 45Mbps bitrate (computed from size÷duration), TikTok video-only ≤1GB ≤10min, Snapchat ≤100MB / **MP4 only / video 5–60s**, and the 1GB upload-from-URL ceiling. The Publish tab renders the checklist per card (✕ blockers disable the button with the reason, △ warnings = «لم نستطع التحقق»); the server re-runs the same checks and 422s with a bilingual message — a stale client can't push a doomed post. **(2) Video duration is now measured, not hoped for** — `duration_seconds` was recorded on ZERO of the library's 263 videos, so the duration rules could never actually fire: new uploads probe the local bytes at intake (`probeVideoDuration` in `lib/upload.ts`, wired through `uploadCanonicalAsset`/`canonicalAssetFields`; `asset_save` allow-list gained `duration_seconds`), and the Publish tab lazily probes legacy videos from their signed URL (metadata-only load) and persists the measured value. **(3) Idempotency + no orphan posts** — `publication_publish` now refuses a row already handed to bundle (409) unless the prior attempt is dead (ERROR/DELETED = the retry path, which best-effort deletes the errored bundle post first); if the DB write fails AFTER the bundle post was created, the post is compensating-deleted so a live post can never exist untracked (and if even the rollback fails it says so loudly with the post id). Signed URL TTL 300s→3600s. **(4) Automatic status reconciliation** — the webhook only ever fires `post.published`, so a post that FAILED at its slot used to stay green-«مجدول» forever. A new 10-minute cron `/api/cron/bundle-status` runs `runBundleStatusSweep` (`api/_lib/marketing/bundleStatusSync.ts`): every in-flight post is polled — POSTED → published+permalink, ERROR → recorded AND a **`publish_failed` notification** (in-app+WhatsApp to ops_supervisor + marketing_manager, seeded in `2026-08-20_mos_publish_failed_rules.sql`, applied live) emitted exactly on the transition, DELETED/404 → row back to draft (retryable). The Publishing Board triggers the same sweep on open (`publication_sync_all`, gated `publish`) so what it shows is current truth; `publication_sync` (single) learned the same DELETED handling; the Publish tab gained a Retry button on failed rows. Prior note: **ExecModal (New/Edit ad campaign) hides synced result-metrics for Meta.** The execution create/edit modal is a Wassel PLAN record — it does NOT create a Meta campaign (that's the separate «إنشاء في ميتا» push). It used to show hand-entry inputs for spend/impressions/clicks/leads/qualified even on Meta/Instagram executions, whose results are owned by the hourly sync. Now for meta/instagram the modal shows only Budget (plan) + a note that results come from Meta; the five result-metric inputs are hidden AND excluded from the save patch (so a save never overwrites synced numbers with stale/empty manual state). Non-synced platforms (snapchat/tiktok/google) keep all manual number fields. Subtitle is source-aware. `الغرض/Purpose` remains a Wassel-internal tag (not a Meta field); the objective's 🔒 means Meta locks it after the campaign is created on the platform. Prior note: **Synced executions stop showing manual-era controls.** Now that Meta sync feeds numbers: (1) the ExecModal's **status** field is **read-only** («من ميتا») when the execution carries a `platform_campaign_id` — editing it was pointless since the hourly sync overwrites it; only unlinked executions keep the editable dropdown. (2) The campaign **results** tab's «مُدخلة يدويًا» badge now reads «أرقام من ميتا» when any execution is synced. (3) The Overview **الإعلانات المدفوعة** card dropped its blanket «مُدخلة يدويًا» badge — the aggregate mixes synced + hand-entered numbers, so a single-source claim was false. Note: «الغرض / Purpose» (`mos_campaign_executions.purpose`) is a Wassel-internal tag, NOT a Meta field — the real Meta objective/goal live in Platform settings. Prior note: **Content list: multi-select + bulk delete.** The Content table (`ContentListPage`) gains a checkbox column with a header **select-all** (over the current filtered set) and per-row checkboxes; selecting any rows shows a bar with the count + a **Delete** button. Gated on `delete_records` (the checkbox column + bar only render for that capability). New `content_delete` action (hard-deletes one or many via `sb.from('mos_content').delete().in('id', ids)`, gated `delete_records`, RLS re-enforces per row) + `deleteContent` client wrapper; all `mos_content` FK children cascade or SET NULL so the delete is safe, and an in-app confirm `Modal` (not the browser's native dialog) guards the irreversible action. Prior note: **Audience → Meta wiring (Option B): link a Wassel audience to a Meta Saved Audience.** A Wassel audience (`mos_audiences`) can now be linked to a Meta **Saved Audience** the buyer built in Ads Manager; on «إنشاء في ميتا» the ad set's targeting is that audience's spec instead of the KSA default. Migration `2026-08-20_mos_audience_meta_link.sql` (applied) adds `meta_saved_audience_id` + cached `meta_targeting` to `mos_audiences`. Graph client `listSavedAudiences()` → `meta_saved_audiences` action (gated `manage_paid_ads`) feeds a **Meta-audience dropdown in Settings → Audiences** (`SettingsAudiences.tsx`, `mosMetaSavedAudiences`); `audience_save` persists the id + cached spec. `meta_push_structure` loads the campaign's `audience_id`, resolves its `meta_targeting`, and passes it to `buildAdSetPayload`, which sends it verbatim as the ad set targeting (with `targeting_automation.advantage_audience:0` — Meta REQUIRES that flag once age/gender/interests are set, else create 400s "Advantage Audience Flag Required"). Verified live: an ad set created with a saved-audience-style spec (geo+age+gender+interest) and the KSA default both succeed. **Prereq:** the account currently has 0 Saved Audiences — the buyer must create one in Ads Manager for the picker to populate; until then targeting stays KSA-default. Prior note: **Meta platform-settings form trimmed to the essentials.** At the operator's request the Meta/Instagram «إعدادات المنصة» form (`src/lib/marketingOS/adPlatforms/meta.ts`) dropped from 26 fields to a minimal set in three sections — **الحملة/Campaign**: objective + budget (CBO campaign/ad-set toggle + daily/lifetime); **المجموعة/Ad set**: conversion location (`destination_type`) + conversion goal (`optimization_goal`) + start/end date; **الإعلان/Ad**: caption (`message`). Campaign + ad-set NAMES are auto reference codes on push (not fields); the AUDIENCE comes from the campaign brief's own audience field (not platform settings); everything else Meta needs (special ad categories, bidding, billing, placements, demographics, page/pixel) is defaulted by `metaPush.ts`, so the trimmed form still produces a valid campaign. Prior note: **Execution page: ad sets surfaced, manual surfaces removed.** The execution detail page now (1) **shows the ad-set level** — `execution_detail` fetches `mos_ad_sets` and the ads table gains an «المجموعة الإعلانية / Ad set» column plus an ad-set count in the header, so a synced Meta execution's ads read under their ad set instead of flat (they were never surfaced here — only in the tree modal); (2) **removed the «نموذج العملاء / Lead form» tab + side card** (the instant-form field spec) at the operator's request; (3) **removed the «يوميًا / Daily» manual registry** (tab + the campaign page's «إدخال أرقام اليوم» button and picker) — it was the pre-sync hand-entry of daily spend/leads, redundant now that Meta feeds numbers automatically; per-ad manual numbers remain for non-synced platforms, and `mos_execution_daily` is untouched. Prior note: **Campaign brief trimmed.** Removed the **Measured-by**, **Offer** and **Destination** fields from the campaign brief (both the edit modal and the read view) at the operator's request; the `measured_by`/`offer`/`destination_url` columns are kept and their data untouched (`campaign_save` no longer sends them, so a save never wipes them). Prior note: **Organic marketing now has its own cockpit — the rail split into «المدفوعة / Paid» and «العضوية / Organic».** The old «الإنفاق / Spend» group was renamed **«المدفوعة / Paid»** (goals, campaigns, weekly numbers — the money side is unchanged); a new **«العضوية / Organic»** group holds two new surfaces. Rationale: paid is a *spend* discipline (cost-per-result, pacing) and already had a cockpit; organic is an *audience* discipline (follower growth, engagement, posting consistency) and had none — publishing was buried in a per-content tab and the only numbers were per-post. The shared production line (content, calendar, library, shoots, approvals) is untouched — both paid and organic feed from it. **(1) Platform Pulse** (`/m/organic`, surface `organic`, `OrganicPulsePage.tsx`) — per-account growth cards for Instagram / TikTok / Snapchat: followers + 7d/30d growth deltas, a growth sparkline, 30-day reach & engagement (+rate), posting cadence (7d/30d, flags an account that went quiet), a cross-account comparison table, and best-posts (last 30 days). **(2) Publishing Board** (`/m/publishing`, surface `publishing`, `PublishingBoardPage.tsx`) — the cross-platform queue: every publication across ALL content in one place, bucketed **attention (failed/retrying) → in-flight → published → draft** (failures first, with the platform error + one-click republish), filterable, with inline **publish-now / schedule / sync-status** reusing the exact `publication_publish` / `publication_sync` wrappers the per-item tab uses. **The growth history is OURS:** bundle.social's account analytics (`GET /analytics/social-account` → followers/following/postCount/impressions/reach) are **deleted after 30 days** by bundle, which tells you to store them yourself — so a new table **`mos_account_metric_snapshots`** (the account-level twin of `mos_metric_snapshots`) is filled DAILY: the existing `/api/cron/bundle-metrics` cron gained a second pull (`runBundleAccountMetricsSync`) and a «تحديث الأرقام الآن» button on Pulse (`account_metrics_pull_all`, gated `enter_metrics`) UPSERTs one snapshot per account/day. The growth chart therefore STARTS the day you switch it on and fills in over time — a fresh install shows the current follower count and a flat line, not history we never captured. A read view **`mos_account_pulse_v`** rolls up the card headline (latest + follower deltas + posting cadence + 30-day engagement); a read action `organic_pulse` returns it plus the 60-day series plus recent posts in one trip. Two new rail surfaces (`organic`/`publishing`) were added to `SURFACES` (server), `SurfaceKey` (client), the `SettingsAccess` matrix, and **seeded in `surface_access` by copying the `numbers` surface's per-role levels** (so whoever saw Weekly Numbers sees the new surfaces at the same level; admins/managers see all). Client wrapper `api/_lib/marketing/bundleAccountMetrics.ts` + account-analytics helpers in `bundleSocial.ts` (`getSocialAccountAnalytics` / `accountAnalyticsToSnapshot`); self-disables when bundle env is unset. Migration `2026-08-20_mos_account_metrics.sql`, applied live. Verified live against the real bundle account: TikTok returns 37 followers / 23 posts / 1,544 likes; Instagram is `wassel.re`; Snapchat returns zeros (thin by platform). See the two new Key-behaviors bullets. Prior note: **Paid-campaign readability fixes (4).** (1) The Meta-sync **holder** pseudo-campaign («Meta — synced», `ref` `meta-sync:%`) is now hidden from the campaigns list — it's an internal inbox, not a campaign, and read as a stray "active" row. (2) A campaign's status pill now shows a **live status derived from its executions' real platform state** (`live_status` from `campaign_list`/`campaign_detail`: any running execution → active, synced-but-none-running → paused; a hand-set done/cancelled is never overridden) so a "planning" campaign whose Meta ads are actually running stops reading as planning; `deriveLiveStatus` in `api/marketing-os.ts`, UI prefers `live_status ?? status`. (3) Each synced execution now labels its Meta id as «حملة ميتا #…» instead of a bare number, so it's clear each execution IS a distinct Meta campaign with its own running/paused pill. (4) **Spend-display bug fixed:** ad spend from Meta insights carries halalas (e.g. 782.38 SAR) and rendered raw with the Arabic decimal mark misread as "782,038" — a new null-safe `whole()` helper (`lib/format.ts`) rounds every spend/budget display across CampaignsPage, CampaignDetailPage and ExecutionDetailPage to whole riyals (the pace figure now uses `money()` → «٧٨٢ ر.س»). Prior note: **Organic posting is now automatic for connected platforms (bundle.social).** The MOS Publish screen was manual-only by an earlier decision; now a publication on **Instagram / TikTok / Snapchat** whose account is connected posts for real with one tap — «انشر الآن» posts within a minute, «جدولة» hands the slot to bundle.social to publish at `scheduled_at`. We upload the ONE approved file by URL (public library URL verbatim, or a short-lived signed `wassel-files` URL), create a bundle post, and track it by `mos_publications.bundle_post_id` + `bundle_status` (bundle's SCHEDULED/PROCESSING/POSTED/RETRYING/ERROR/REVIEW); the tab auto-polls non-terminal posts + a «تحديث الحالة» button (`publication_sync`) flips to `published` + permalink on POSTED and surfaces `bundle_error` on ERROR. TikTok is video-only (guarded); IG feed images use `autoFitImage`. Accounts are linked once in the bundle.social dashboard's own OAuth flow — no OAuth in-app; Settings → Platforms gained a **«تحديث حالة الربط»** button (`platform_sync`, gated `manage_settings`) that reflects the live team's connection status onto the account cards. Server: `publication_publish` / `publication_sync` (gated `publish`) + `platform_sync` in `api/marketing-os.ts` over the thin client `api/_lib/marketing/bundleSocial.ts` (upload-from-URL + post create/get + per-platform data builder); self-disables when `BUNDLE_SOCIAL_API_KEY` / `BUNDLE_SOCIAL_TEAM_ID` are unset. Migration `2026-08-19_mos_bundle_social.sql` (bundle columns on `mos_publications` + `mos_platform_accounts` + `mos_publication_v`), applied live. **Performance numbers now arrive automatically too:** a daily cron (`/api/cron/bundle-metrics`, `37 6 * * *`) plus a «سحب الأرقام من المنصات» button on the Numbers screen (and per-card «تحديث الأرقام» + on-open auto-pull in Publish) fetch bundle.social's normalized post analytics (views / likes / comments / saves, `engagement` = their sum; impressions etc. in `extra`) and append them to `mos_metric_snapshots` as **`source='api'`** rows — deduped so an unchanged reading adds nothing. bundle auto-refreshes analytics every 24h, so the Numbers screen fills itself for connected platforms; hand-entry stays for X and any figure the platform API returns 0/omits. Shared engine `api/_lib/marketing/bundleMetrics.ts` (used by the cron AND the `metrics_pull` / `metrics_pull_all` actions, both gated `enter_metrics`). Unconnected platforms (X, website) keep the manual copy-paste flow. See the two Publishing Key-behaviors bullets. Prior note: **«إنشاء في ميتا» — the app now BUILDS a planned execution in Meta.** A `manage_paid_ads` role on an unlinked Meta/Instagram execution gets a **Create in Meta** button that creates the campaign (`mos_campaigns.objective` → ODAX objective) + one ad set per planned `mos_ad_sets` row (a single default when none) directly in the real ad account via the Marketing API, **all PAUSED**, and writes the returned `platform_campaign_id` / `platform_adset_id` back onto the Wassell rows so the execution links itself with no manual id typing. Payloads come from `platform_settings` where set, else objective-driven defaults (leads → Click-to-WhatsApp: CONVERSATIONS / IMPRESSIONS / WHATSAPP / promoted page; geo defaults KSA; SAR→halalas ×100). **Ads/creatives are NOT created here on purpose** — Meta blocks app-made creatives while the Meta *App* is in Development mode (subcode 1885183), so the buyer adds the ads in Meta and the hourly `meta_sync` matches them back by platform id (verified live end-to-end: campaign + 2 ad sets created and cleaned up against the وصل العقارية account). Action `meta_push_structure` (gated `manage_paid_ads`, refuses re-push with 409, skips already-linked ad sets), builders `api/_lib/marketing/metaPush.ts`, client `mosMetaPushStructure`, button on `ExecutionDetailPage`. See the «إنشاء في ميتا» Key-behaviors bullet. Prior note: **Meta ads now sync into the workspace — two-way.** OUR Meta ad account (وصل العقارية, SAR) is connected to the Marketing API. A scheduled + on-demand sync pulls every campaign / ad set / ad with live spend, impressions, clicks and lead counts into the MOS spine (Meta campaign → `mos_campaign_executions.platform_campaign_id`, ad set → `mos_ad_sets.platform_adset_id`, ad → `mos_execution_ads.platform_ad_id`) under a per-account holder campaign **«Meta — synced»**; the operator then links each synced execution to its real project campaign (the «link to project» action force-re-resolves attribution). Because the ad's `platform_ad_id` now matches the id an inbound Click-to-WhatsApp lead carries, **lead attribution self-heals on every sync** (`mos_reresolve_first_touch` over `chat_messages.meta.ad`). Settings → Platforms gained a live **«ميتا — حسابنا الإعلاني»** card (last-sync summary, «مزامنة الآن», kill switch), gated on a new **`manage_paid_ads`** capability that ALSO gates the WRITE side: create / pause / edit campaigns, ad sets, ads and creatives on Meta via the Marketing API (`meta_create` / `meta_update` / `meta_set_status`, every write supporting Meta's `validate_only` dry-run). Sync runs on **Vercel** (`/api/cron/meta-sync` hourly + the `meta_sync` action), NOT the Fly worker; the Graph client (`api/_lib/marketing/metaMarketingApi.ts` — Web-Crypto `appsecret_proof`, Edge-safe) + `api/_lib/marketing/metaSync.ts` are the one implementation. Server env: `META_APP_ID/APP_SECRET/SYSTEM_USER_TOKEN/AD_ACCOUNT_ID/PAGE_ID/INSTAGRAM_ID`; the feature self-disables when the token/account are unset (`loadMetaConfig`) or the kill switch is off. Migration `2026-08-16_03_meta_sync.sql` (`mos_meta_sync_state` + `mos_meta_sync_apply` + `mos_meta_force_reresolve_execution`), applied live. Per the operator's "Meta is source of truth" decision, the 4 pre-existing hand-entered Meta executions were backed up + removed (`public._backup_meta_manual_20260816`); the first sync rebuilt 2 campaigns / 2 ad sets / 5 ads and healed the waiting Mina 52 leads. New capability `manage_paid_ads` is DATA in `role_capabilities` (seeded to the roles that already hold `manage_settings`; admins pass via the `wassell_is_admin` bypass). Prior note: **Deleting a record is now its own permission.** Until now deletion piggy-backed on the *edit* capability — deleting a content item only needed `write_content`, an asset `manage_assets`, an ad/execution `enter_metrics` — so "can edit" implied "can destroy." A new **`delete_records`** capability (Settings → Roles and permissions → Capabilities, its own «الحذف» / Deletion group) is now the single gate for hard-deleting **every** marketing record: content, scenes, campaigns, executions (ad sets), ads, library assets and manual tasks. The DELETE RLS on each of those seven tables was re-pointed to `wassell_mos_can('delete_records')` (INSERT/UPDATE keep their original caps; manual tasks keep the "creator may delete their own" clause), and every delete button in the UI is now gated on `can('delete_records')` so no one is shown a control that would 403. Seeded to **Marketing Manager only** (app admins delete via the `wassell_is_admin` bypass); every other role starts without delete until an admin turns it on. Like every capability it is DATA in `role_capabilities`. Migration `2026-08-16_mos_delete_records_capability.sql`, applied live. See the capability sync-point note. Prior note: **Jump from any marketing record to its project.** A content item, a campaign, a library asset and a task each carry a clickable **«افتح المشروع»** affordance wherever they resolve to a real-estate project — directly (`project_id`/`project_ids`), or INDIRECTLY (a content item with no project of its own falls back to its campaign's project; a manual task falls back to its linked content item's project). Clicking it opens THAT single project's record in the **Our Projects** module (`/model/our_projects/:ourId` → the shared `ProjectDetailPage`) **in a new tab** — the marketer keeps their place in the workspace, with the record and the project side by side (a real `<a target="_blank">`, so middle-/⌘-click work too); never the whole list. Marketing stores the `all_projects` master id, so the button translates it to the `our_projects` record (matched on that record's `project` lookup field, the same mapping `OurProjectsPortfolioPage` uses — all 93 public masters map 1:1); it falls back to `/model/all_projects/:id` (same page, always readable for a public project) only when the Our-Projects record can't be resolved. One button per linked project. New shared component `src/pages/Marketing/components/ProjectLink.tsx`; wired into `ContentDetailPage`, `CampaignDetailPage`, `AssetDetailPage`, `WorkPage`. UI-only, no schema change. See the «افتح المشروع» Key-behaviors bullet. Prior note: **Being assigned a task now notifies you.** Hand-assigned tasks shipped without a notification, so work could land in someone's queue and the only way to find out was to go look. Assignment now emits a **`manual_task_assigned`** notification naming the assigner and the due date, linking to «مهامي» — a SEPARATE event key from the workflow's `task_assigned` (muting "your turn began" and muting "your manager handed you something" are different decisions, and the workflow event's own subtitle would be a lie if it carried both). It is its own row in Settings → Notifications: in-app ON for every role, WhatsApp ON for the writer and editor only, push off — mirroring the existing `task_assigned` seed and leaving the CEO's «إشعاران فقط» rule intact. Deliberately silent: self-assignment, editing a task someone already holds, and each generated occurrence of a repeating rule (it notifies ONCE at creation — the materializer opens occurrences a fortnight ahead). Reassigning to a different person DOES notify the new holder. Migration `2026-08-11_01_manual_task_assigned_notifications.sql`, applied live. Prior note: **Tasks can now be assigned by hand.** Every marketing task used to be workflow-generated — `workflow_role_tasks` is bound to a content item, owned by a role, and closing one advances the pinned path — so there was no way for a manager or the CEO to say «اعرضي حملة مينا ٥٢ يوم الأحد», and no way for an employee to add a task for themselves. New **`mos_manual_tasks`** rows sit alongside that queue without touching any of its invariants: no step, no role, no round, no approval loop, many open at once per person, closing advances nothing, and optional links to a campaign / content item / goal / project. Repeating tasks are a RULE (**`mos_task_series`**: daily/weekly/monthly + interval, Sunday-first weekdays, month day, Riyadh-local due time, start/end window) turned into occurrences by the idempotent, bounded `mos_task_series_materialize()` — called on every task read, because pg_cron is not enabled here. Assigning to OTHERS needs a new **`assign_task`** capability (seeded to Marketing Manager, CEO and Ops Supervisor — the CEO deliberately lacks the broad `assign`); assigning to YOURSELF never does. A trigger lets the assignee close a task but not re-word, re-date, re-assign or cancel it. Surfaced as the «مهام مُسندة إليكِ» block in My work (with «مهمة جديدة») and the «مهام مُسندة يدويًا» table in Team work (with «إسناد مهمة»). Migration `2026-08-10_01_mos_manual_tasks.sql`, applied live. See the four new Key-behaviors bullets. Prior note: **Library uploads stop duplicating bytes.** New marketing-library uploads now store the file ONCE — one object in the private `wassel-files` bucket + one `files` row, referenced by `mos_assets.file_id` — instead of also writing a public copy under `marketing-assets/mos/`. Reads resolve through a new `useAssetUrls` resolver that returns legacy public URLs verbatim and batch-signs file-backed ones; unsupported formats and signing failures are now visible errors. Migration `2026-08-09_mos_canonical_file_assets.sql` grants MOS readers view access to library files and closes two `file_id` privilege-escalation paths. The existing 1,252 duplicated assets are untouched. See the "Canonical file-backed assets" Key-behaviors bullet. Prior note: **Executions now carry the real ad-platform fields.** Meta/Instagram/Snapchat/TikTok executions gained a structured «إعدادات المنصة» form — the platform's own Ads-Manager fields (objective, optimization goal, budget mode, bid strategy, placements, structured targeting) with real API names + enum values in `mos_campaign_executions.platform_settings`, plus an ad-level `mos_execution_ads.creative` twin (format, copy, CTA, destination/lead-form/Spark id). Schemas are data in `src/lib/marketingOS/adPlatforms/`; migration `2026-08-09_mos_execution_platform_settings.sql` applied live. See the "Structured platform settings" Key-behaviors bullet. Prior note: **Goals now carry success measures.** A goal holds the SAME multi-measure success criteria as a campaign: new `mos_goals.success_measures` jsonb column (migration `2026-08-09_mos_goal_success_measures.sql`, applied live), the goal modal embeds the shared `SuccessMeasuresEditor` (registry picker + inline new-type + ★ main-first ordering), `goal_save` sanitizes the array exactly like `campaign_save`, and each goal card lists its measures as «label — target suffix» lines. Optional; no live-actuals rollup. See the Goals Key-behaviors bullet. Prior note: **Campaigns list no longer hangs on entry.** The campaigns list computed each row's platform sub-line on the client by fetching a full `campaign_detail` per campaign plus a `publication_list` on load — an N+1 that saturated the browser's connection limit and the lock-contention-prone MOS DB, freezing the workspace when opening Campaigns on a phone. `campaign_list` now returns `campaign.platforms` (computed server-side in three bounded, campaign-scoped reads); the client resolver was deleted. See the platform-sub-line Key-behaviors bullet. Prior note: **Goals — the spend side's strategic layer.** A new **Goals** surface (`/m/goals`, في «الإنفاق» فوق الحملات) is a managed registry of simple, reusable goals (name + description + active/inactive), and **every campaign now links to one or more goals** (many-to-many). The New/Edit campaign forms carry a required goal multi-select and refuse to save with none; the campaign detail brief shows the linked goals as chips; the campaigns list gained a **Goal** filter (and a `/m/campaigns?goal=<id>` deep link from each goal's card). Tables `mos_goals` + junction `mos_campaign_goals` (migration `2026-08-07_mos_goals.sql`), RLS: read = `read`, goal writes + links = `approve_budget` (the campaign-write capability). API actions `goals_list` / `goal_save` (with a linked-campaign count per goal) + `campaign_save` gained `goal_ids` (server enforces ≥1 on create, syncs the junction) + `campaign_list`/`campaign_detail` now return goal ids/objects. See the Goals Key-behaviors bullet. Prior note: **iOS PDF preview fix.** The asset page's inline PDF `<iframe>` is a non-scrollable first-page-only frame on iOS Safari — a PDF looked cut off. On iOS the frame is now a tappable «افتح الملف كاملاً» card that opens the native system viewer; Android/desktop keep the inline iframe. See the asset-preview Key-behaviors bullet. Prior note: **Approval → publishable file bridge.** Marking a material «تحديد للاعتماد» sets `mos_content.approval_asset_id`; an approver's `approved` result promotes it to the `final` band via the `mos_promote_approval_asset` RPC, so Publishing stops saying "Nothing approved yet." Publications now link the approved file by `mos_publications.asset_id` (asset id, not the NULL-prone `file_id`), and `publication_save` gained `asset_id`+`file_id` in its allow-list. Migration `2026-08-06_mos_content_approval_asset.sql`. See the two "2026-08-06" Key-behaviors bullets. Prior note: **Library files: open, edit, download + an aspect-ratio field.** The asset page gained «فتح الملف» (Open file, incl. click-to-open preview + a `?download=` forced-attachment «تنزيل») and a `manage_assets` «تعديل» (Edit) modal that edits the record itself; a new **`mos_assets.aspect_ratio`** column (migration `2026-08-06_mos_asset_aspect_ratio.sql`, choices in `ASSET_ASPECT_RATIOS`) is pickable on bulk upload — shared panel + per-file — and in the edit modal, and shows in the Details rail + spec caption. `shot_by`/`rights_expiry` were added to the `asset_save` allow-list so the edit modal can write them. Prior note: **Capabilities are now DATA, not code.** The marketing permission model had three layers that disagreed: an editable *surface* matrix (rail visibility only), a *capability* set hardcoded in a SQL `CASE` (`wassell_mos_can`) AND duplicated in a client `MATRIX`, and scattered hardcoded `role === 'ceo'` checks in components — the last of which caused the reported "CEO can't see the Content tab" bug. Re-architected so capabilities are editable rows in a new **`role_capabilities`** table (migration `2026-08-06_01_role_capabilities.sql`, seeded to reproduce the old `CASE` verbatim — proved by an in-migration parity assertion). `wassell_mos_can` now reads that table (same signature → every `mos_*` RLS policy unchanged); a new `wassell_mos_capabilities()` resolver ships the caller's capability UNION in the bootstrap `me.capabilities`, so the client `MATRIX` was **deleted** (three hand-synced copies → one source of truth). The hardcoded `role === 'ceo'` gates in `ContentDetailPage` (the Content tab, the activity rail, version-compare, the shoot button) became capability toggles (`view_content_body` / `view_activity` / `compare_versions` / `assign`), seeded so the default CEO preset reproduces the old behaviour but any role can now be reconfigured. **Settings → Roles and permissions gained a "Capabilities" tab** beside "Surfaces": it edits `role_capabilities` (grant/revoke, gated by the `manage_roles` capability via RLS — same posture as `surface_set`), so an admin can finally control what a role can DO, not just what it sees, and it's the same capability RLS enforces. `roles.domain` (`sales`/`marketing`/`intel`) was added to namespace the shared registry. **Editing content is now purely capability-based (same-day follow-up decision):** `ContentDetailPage.canEditNow` dropped its stage-ownership check (`roles.includes(openTask.role)`) — anyone whose role holds `write_content` can edit the writing fields/scenes at a writing stage regardless of which role owns the step, matching the `mos_content`/`mos_content_versions`/`mos_scenes` UPDATE RLS which already gate on `write_content` alone. The two remaining guards are structural, not role-ownership (no open task → nothing to edit; an approval stage is read-only for everyone). **Task ADVANCEMENT (submit/approve — `canAct`, and the DB `workflow_advance_role_path`) still follows stage ownership** — only editing the body was decoupled. Prior notes below.)

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
numerals everywhere, Amiri throughout including dense tables, workflows pointing
at roles rather than people, and every screen usable on a phone. Two original
decisions have since evolved: publishing is REAL (automatic) for the connected
platforms — Instagram/TikTok/Snapchat post through bundle.social with pre-flight
checks and automatic status reconciliation, while X/website stay manual — and
performance numbers arrive automatically from the platforms for those accounts,
with hand-entry kept for everything the APIs don't cover.

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
- **«افتح المشروع» — open a record's project in Our Projects (2026-08-14).**
  Anywhere a marketing record resolves to a project, a clickable chip/link opens
  that ONE project's record in the **Our Projects** module
  (`/model/our_projects/:ourId`, the shared `ProjectDetailPage`) **in a new tab**
  (a real `<a target="_blank">` — keeps the marketer's place in the workspace,
  and middle-/⌘-click work), not the projects list. Marketing stores the
  `all_projects` master id; the mapping to the `our_projects` record is served
  on each project by **`projects_list.our_project_id`** (resolved server-side
  from `v_our_projects.project`, so it's present the moment the workspace paints
  — a generic-records-store lookup is only a fallback, since that store isn't
  reliably loaded in `/m` yet). Falls back to `/model/all_projects/:id` (the
  same page) only when neither resolves. Resolution of WHICH project is direct
  first (`project_id`/
  `project_ids`), then indirect: a content item with no project of its own uses
  its **campaign's** project(s); a manual task with none uses its linked
  **content item's** project. One button per linked project. Present on content
  detail, campaign detail, asset detail, and both task shapes in My/Team work
  (workflow rows + manual rows, desktop and mobile). Shared component
  `ProjectLink.tsx`; UI-only, no schema change.
- **Client acquisition ledger — the Ad is the hub (2026-08-23).** Every ad-sourced
  client carries one or more append-only **`client_attributions`** rows:
  **`Client → Acquisition row → Ad → Content / Project / ad set / campaign /
  platform`**. Nothing marketing is copied onto the client — a row stores only ids
  + when (`occurred_at`) + how (`source`, `touch_type` first/latest, `channel`).
  The **`channel`** column (`paid_ad | organic | referral | direct | other`) lets
  the same ledger carry organic / referral / direct sources later; a channel-aware
  CHECK requires a spend object (ad/execution/campaign) only on `paid_ad` rows.
  Rows are written server-side ONLY: **automatically** by
  `mos_capture_ad_acquisition` when an inbound WhatsApp resolves to a paid ad
  (find-or-create the client, one row per client+ad, first-touch iff the client had
  no prior touch — see [chats.md](chats.md)), and were **backfilled** once (42 rows)
  for existing ad-resolved conversations. **`mos_client_acquisition`** resolves a
  client's rows LIVE through the Ad for the Sales-side «كيف وصلنا هذا العميل» panel
  (see [clients.md](clients.md)) — gated on VIEWING the client, not on a marketing
  role. It reads the marketing spine (`mos_execution_ads` / `mos_ad_sets` /
  `mos_campaign_executions` / `mos_campaigns` / `mos_content`) but writes only the
  ledger. The Intelligence `mkt_*` tables are unrelated (competitors, not our leads).
- **Hand-assigned tasks exist alongside the workflow queue (2026-08-10).** Every
  task used to be workflow-generated, which left no way to say «اعرضي حملة مينا
  ٥٢ يوم الأحد». A **manual task** (`mos_manual_tasks`) is a separate, lighter
  row: no step, no role, no round, no approval loop; several can be open for one
  person at once; and closing it advances nothing. It can optionally hang off a
  **campaign, a content item, a goal and/or a project**. It appears in the same
  «مهامي» queue in its own «مهام مُسندة إليكِ» block (kept visually distinct
  because those rows open a stage and these ones just get done), counts toward
  the rail badge, and shows team-wide on Team work as «مهام مُسندة يدويًا».
  The workflow tables and their invariants are untouched.
- **Assigning to others needs `assign_task`; assigning to yourself never does.**
  A new capability, seeded to Marketing Manager, CEO and Ops Supervisor (the CEO
  deliberately does NOT hold the broad `assign`, which is workflow reassignment).
  Anyone who can read the workspace can always create a task for themselves — so
  the New-task form shows a person picker only when the capability is held, and
  otherwise states plainly that the task is for you rather than offering a
  dropdown the save would refuse. Like every other capability, it is DATA and can
  be re-granted per role in Settings → Roles and permissions.
- **A repeating task is a rule, not a row.** `mos_task_series` holds
  daily/weekly/monthly + interval, weekdays (Sunday first — the Saudi work week),
  a month day, a Riyadh-local due time, and a start/end window;
  `mos_task_series_materialize()` turns it into real occurrences over a bounded
  window (14 days back, 14 days forward), idempotently (`(series_id,
  occurrence_on)` unique), called on every task read because pg_cron is not
  enabled on this project. The New-task form states the rule in words before you
  commit. Editing a rule regenerates only the occurrences that have not started
  yet — done and cancelled ones are history and stay. Day 31 in a shorter month
  falls on that month's last day rather than being skipped.
- **Being given a task tells you (2026-08-11).** Assigning work to someone emits
  a `manual_task_assigned` notification naming the assigner and the due date,
  linking to «مهامي». It is a SEPARATE event key from the workflow's
  `task_assigned`, because muting them are different decisions: "a previous
  stage approved and your turn began" is a reasonable thing for a busy role to
  silence, "your manager just handed you something" is not the same call — and
  the workflow event's own subtitle («اعتُمدت خطوة سابقة ودورك بدأ») would be a
  lie if it carried both. It appears as its own row in Settings → Notifications,
  tunable per role. Defaults: in-app ON for every role (a task a person put in
  your queue must always be findable, including for the CEO — an inbox row waits
  rather than interrupts), WhatsApp ON for the writer and the editor only
  (mirroring their existing `task_assigned` posture; the CEO's «إشعاران فقط»
  rule is left intact), push off everywhere.
- **Three things deliberately stay silent:** assigning a task to YOURSELF (you
  do not need telling what you just wrote down), re-wording or re-dating a task
  someone already holds (an edit is not an assignment and must not re-interrupt
  them), and each generated occurrence of a repeating task — the rule notifies
  ONCE when it is created, because the materializer opens occurrences a
  fortnight ahead and per-occurrence emission would deliver a fortnight of
  interruptions at once. Handing a task to a DIFFERENT person does notify the
  new holder.
- **The assignee can finish a task, not rewrite it.** A trigger
  (`mos_tg_manual_task_guard`) lets the assignee close/reopen and leave a note,
  but refuses any edit to the title, due date, assignee or links, and refuses
  cancellation — those belong to whoever assigned it. RLS gates the row; the
  trigger gates the columns.
- **A rejection needs a reason.** Requesting changes without a note is refused by
  a CHECK constraint and by the UI, because a blind rejection just restarts the
  loop. Rejection sends the work back one stage as a **new round**; nothing is
  overwritten, so "why did this go back twice?" is answered by scrolling.
- **Approval is split three ways.** Marketing Manager approves creative,
  Operations Supervisor approves process, CEO signs off budget and approves no
  content. That split is what stops one person becoming everyone's queue.
- **Approval promotes the submitted file (2026-08-06).** A material's owner marks
  ONE uploaded material «تحديد للاعتماد» (Mark for approval) on the Materials tab —
  a single-select toggle on the source/working rows, persisted as
  `mos_content.approval_asset_id`. When an approver returns `approved` on the item,
  the API calls the `mos_promote_approval_asset` SECURITY-DEFINER RPC, which
  promotes exactly that material to the approved (`final`) band — the only band the
  Publishing tab reads. This closes the old gap where approval advanced the workflow
  task but never tagged a file, so Publishing said "Nothing approved yet" even with a
  file uploaded and the item approved. It is **explicit-selection only** (never
  guesses a file, so a customer-facing publish can't attach the wrong one); the
  band-4 empty state now tells the user to mark a file, or that a marked file is
  queued for the manager. Unlinking the marked material clears the pointer.
- **A publication links its approved file by asset id (2026-08-06).** The Publishing
  modal's file pick now writes `mos_publications.asset_id` (an `mos_assets.id`),
  resolving by asset id instead of the old `mos_assets.file_id` key — which was NULL
  for any material uploaded straight into the `marketing-assets` bucket, so an
  uploaded video/file could never resolve. `publication_save` gained `asset_id`
  (and `file_id`, previously dropped) in its allow-list; `mos_publication_v` +
  `mos_content_v` expose the new columns.
- **Each step controls its own notification.** In the Workflows editor every
  step carries a `notify` on/off switch and a set of permitted channels
  (in-app, push, WhatsApp). When a step becomes active the engine interrupts
  its owning role only if `notify` is on, and only on the channels the step
  permits **AND** that person's role settings (Settings → Notifications) also
  enable — a step can narrow, never widen. `notify` off opens the task
  silently: it still shows in «my work», it just doesn't ping. Legacy steps
  with no setting default to notify-on / all-channels, so the role grid alone
  decides, exactly as before. The rules are pinned per workflow version, so
  editing a path never changes how in-flight records are notified.
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
- **A creative is neutral; where it runs lives on its Placements tab (2026-08-28).**
  A content item is a **standalone record** — its `campaign_id` is only *provenance*
  ("where it was born"), NOT ownership, and it no longer constrains where the
  creative can run. The dedicated **Placements** tab (own tab, gated on
  `view_content_body`) is the one place a creative chooses its doors, and each
  placement carries **its own campaign link**, independently:
  - **Organic placement** = an `mos_publications` row: platform + account + caption
    + schedule, optionally linked to an **organic** campaign (existing, a new one
    created inline, or **none**). This is the same row the Publishing board
    schedules and bundle.social posts, so adding one here is just a faster door into
    the organic section. Shared hashtags still live once on the content and are
    appended to every organic caption at publish. Adding/removing an organic
    placement keeps `mos_content.organic_platforms` in sync.
  - **Paid placement** = an `mos_execution_ads` row under **any** paid campaign's
    execution + ad set (existing ad set, or a new one created inline). The old
    "must match the content's own campaign" rule is **gone** — a creative born in
    one campaign can run paid in another. Ad copy (primary text) is written onto the
    ad's `creative`.
  - **Bulk content under a NEW paid campaign seeds PAID placements.** The campaign
    wizard's planned pieces each get one waiting `mos_execution_ads` row per created
    execution (`saveAdCreative`), never draft publications — an execution platform
    is an ad channel («إعلانات ميتا»), not an organic feed, and seeding publications
    from it rendered Meta ads inside the organic section (fixed 2026-08-28). The
    server refuses ad-only channels (`meta`, `google`) in `publication_save` /
    `content_caption_save` so this class of row cannot come back.
  - `purpose` (`organic` / `paid` / `both`) is **no longer chosen** — it is
    **derived in `mos_content_v`** from the placements that exist (with a
    backward-compatible fallback to the stored value when a content item has no
    placements yet). It stays a read-only label. Server actions:
    `content_paid_ads` / `content_ad_creative_save` (add/edit paid, decoupled) /
    `paid_placement_remove` / `paid_placement_targets` (the campaign→execution→ad-set
    picker) and `publication_save` (now accepts `campaign_id`) / `publication_remove`
    — all gated on `write_content`. Migration `2026-08-28_placements_decouple.sql`
    (adds `mos_publications.campaign_id` + the derived-purpose view). UI:
    `PlacementsTab.tsx` (replaced the old purpose-gated `PlacementCaptions`).
- **Organic posting is automatic for connected platforms (bundle.social).** A
  publication whose platform is Instagram / TikTok / Snapchat AND whose account
  is connected gains a **«انشر الآن» / «جدولة»** button on its Publish card: it
  uploads the ONE approved file to bundle.social (by URL — a public library URL
  verbatim, or a short-lived signed URL for a file-backed asset), then creates a
  post that bundle publishes now (`postDate` ≈ now) or schedules for the row's
  `scheduled_at`. bundle owns the OAuth tokens (accounts are linked once in the
  bundle.social dashboard's own flow), the per-platform upload, retries and the
  TikTok review state. We track it by `mos_publications.bundle_post_id` +
  `bundle_status` (bundle's own SCHEDULED/PROCESSING/POSTED/RETRYING/ERROR/REVIEW,
  distinct from the coarse `status`); the Publish tab auto-polls non-terminal
  posts on open and offers a «تحديث الحالة» refresh (`publication_sync`), flipping
  to `published` + storing the permalink on POSTED and surfacing `bundle_error` on
  ERROR. TikTok accepts video only (guarded); IG feed images post with
  `autoFitImage` so any aspect ratio is accepted. Server: `publication_publish` /
  `publication_sync` (gated on the `publish` capability) + `platform_sync` (gated
  on `manage_settings`, reflects the live team's connection status onto the
  accounts) in `api/marketing-os.ts`, over the thin client
  `api/_lib/marketing/bundleSocial.ts`; self-disables when `BUNDLE_SOCIAL_API_KEY`
  / `BUNDLE_SOCIAL_TEAM_ID` are unset. Migration `2026-08-19_mos_bundle_social.sql`.
- **Unconnected platforms stay manual.** X and the website have no bundle.social
  connection, so their cards keep the copy-caption → post-yourself → mark
  published + paste link flow. «Scheduled» for a manual row still means a
  reminder, not an automation.
- **The calendar plots three kinds of chip, no register of its own.** A
  scheduled/published publication is a solid platform-tinted chip (`scheduled_at`
  / `published_at`); a task due date or campaign-end is a dotted warning chip;
  and a content item's **target publish date** (`target_publish_at`) is a dashed
  copper **«مستهدف»** chip — the aim, shown only while nothing is scheduled for
  that item yet (once a publication exists, its solid chip is the truth and the
  aim is not double-charted). Target chips ride the «النشر» filter with real
  publications and count as planned publishing, so a week that has any aim or
  publication is not flagged «لا شيء مخطط». The `calendar` endpoint fetches
  content whose `due_at` OR `target_publish_at` lands in the window.
- **Metrics are append-only dated snapshots.** Nothing overwrites a reading, so
  two items can be compared at the same AGE. An empty box saves as NULL, never 0
  — a CHECK constraint refuses an all-empty reading. Each snapshot carries the
  core readings — **views, engagement, enquiries** — plus the **engagement
  breakdown: likes, comments, saves** (all first-class nullable integer columns
  on `mos_metric_snapshots`; the not-empty CHECK counts any of the six, plus
  `extra`). The Numbers capture grid and the Performance tab's «إدخال أرقام»
  modal collect all of them; the per-publication view `mos_publication_v`
  exposes each as `latest_*`.
- **Metrics can be pulled automatically (bundle.social), not only typed.** For a
  publication posted through bundle.social, a snapshot with `source='api'` is
  appended from the platform's own analytics — by the daily
  `/api/cron/bundle-metrics`, the Numbers screen's «سحب الأرقام من المنصات»
  button, the Publish card's «تحديث الأرقام», and an on-open auto-pull. bundle
  refreshes analytics every 24h; pulls dedupe against the last `api` snapshot so
  an unchanged reading adds nothing, and each carries the platform-only fields
  (impressions, unique reach, shares, dislikes) in `extra`. `enquiries` stays
  hand-entered (it is a CRM concept, not a social metric). `source` was always in
  the schema (`manual`|`api`); this is the first writer of `api`.
- **The shoot backlog is derived.** Every scene still marked `missing` is a shot
  someone has to film, whether or not a request exists for it yet.
- **The Asset library grid was RETIRED (2026-08-20)** in favour of the unified
  Files Library. The old grid at `/m/library` (design screen 16, `LibraryPage.tsx`
  — now DELETED) now **redirects to `/files?view=marketing&origin=marketing_intake`**,
  and every in-app entry point (the rail item, the mobile tab, and the "back to
  library" buttons on the kept marketing screens) links there DIRECTLY via
  `marketingLibraryHref()` (`src/lib/files/libraryUrl.ts`) — no redirect hop. The
  redirect stays only as a safety net for old bookmarks. `mos_assets` is
  unaffected (a 1:1 marketing sidecar on `files`); the retirement was UI-only.
- **"Unused material" is a LEFT JOIN**, not a counter anyone maintains. The
  unused-material screen (`/m/library/unused`, `LibraryUnusedPage.tsx`) and the
  per-asset page (`/m/library/:assetId`, `AssetDetailPage.tsx`) are KEPT and still
  stamp each card with its usage («مستخدمة في ٥», «نسخة معتمدة» for a final cut,
  «مجموعة ن» for a grouped set, mm:ss for videos). They are reached from the
  marketing global-search asset results and from within those pages, not from the
  retired grid.
- **The asset page previews the material inline** (`AssetDetailPage.tsx`): a video
  gets a `<video controls>` player, a photo/design renders as an image, an
  **audio track gets an `<audio controls>` player** (added 2026-08-06 — audio
  previously fell through to a static placeholder icon and could not be played),
  and a **PDF document renders in a full-width `<iframe>` viewer** with an
  "open in a new tab" link (added 2026-08-06 — a PDF previously showed only the
  placeholder glyph; it embeds because marketing-assets is a public bucket with
  no frame-blocking headers). Only PDFs embed — other documents (docx/xlsx) can't
  render in an iframe, so they keep the placeholder + Download. Anything with no
  playable/renderable form still shows the kind placeholder. **On iOS (2026-08-07)
  the `<iframe>` is replaced by a large tappable «افتح الملف كاملاً» (Open the full
  file) card** — iOS Safari/WebKit renders a PDF iframe as a non-scrollable,
  first-page-only frame, so the document looked cut off and could not be read past
  page one. iOS instead opens the PDF in the native system viewer (new tab), which
  scrolls, zooms, and downloads. Detection is UA-based (`IS_IOS`, incl. touch-Mac
  iPadOS); Android Chrome keeps the inline iframe (it scrolls fine there).
- **Open, edit, and download the asset (2026-08-06).** The header carries **«فتح الملف»
  (Open file)** — opens the raw file in a new tab (the photo/design preview is itself
  a click-to-open link, and the non-PDF document placeholder tile opens the file too) —
  and **«تنزيل» (Download)**, which now forces a real save via a `?download=<name>` query
  on the public storage URL (`downloadHref`) so Supabase sends `Content-Disposition:
  attachment` instead of opening inline (the bare `download` attribute is ignored
  cross-origin). A `manage_assets` role also gets **«تعديل» (Edit)** → an
  `EditAssetModal` that edits the record itself — Title / Project / Source / **Aspect
  ratio** / Shot-by / Shot-on / Usage-rights / Rights-expiry — through the same
  `asset_save` path (the file bytes + `kind` are fixed at upload). The Details rail
  shows the chosen aspect ratio, and the spec caption prefixes it («9:16 · 00:22 · 12 MB»).
- **Canonical file-backed assets — one copy, not two (Phase 0, 2026-08-09).** Library
  uploads used to write the bytes TWICE: once as a `files` row in the private
  `wassel-files` bucket and again as a public object under `marketing-assets/mos/`,
  with `mos_assets` storing the public `url` + `file_path`. ~1,252 assets (~1.08 GB)
  carry that duplication. **New uploads now store the bytes ONCE** — one object in
  `wassel-files`, one `files` row, and a `mos_assets` row that REFERENCES it through
  `file_id` with `url` / `thumb_url` / `file_path` left NULL. All four intake paths
  changed (the bulk queue, the Materials-tab modal, shoot delivery, and the offline
  capture drain); the duplicate-copy uploader (`uploadToStorage`/`storagePath`) was
  deleted so it cannot be reintroduced.
  - **Reading is shape-agnostic.** `useAssetUrls` (`src/pages/Marketing/lib/assetUrls.ts`)
    returns a legacy asset's stored public URL VERBATIM (no signing request ever) and
    mints a batched signed URL for a file-backed one via the existing
    `/api/files/sign-view-urls` (≤200 ids per call, re-signed a minute before the
    5-minute TTL). Wired into LibraryUnusedPage, MaterialsTab,
    AssetDetailPage and PublishTab (the retired LibraryPage grid used it too).
    **Every existing asset is unchanged** — all 1,568
    production rows carry a `url`, so none of them signs.
  - **Streaming latches its URL.** `<video>`/`<audio>` hold the first URL they get
    (`useLatchedUrl`), because swapping a media element's `src` on re-sign restarts
    playback at 00:00; an `onError` releases the latch so a genuinely expired token
    recovers without a reload. Known limit: seeking a file-backed clip after 5 minutes
    may need a reload — no production asset is file-backed yet.
  - **Downloads.** Legacy assets keep the `?download=` public attachment URL;
    file-backed assets mint a proper attachment URL through `signDownloadUrl`, which
    also records the `download` event in the file's audit trail.
  - **Unsupported formats fail visibly.** `marketing-assets` accepted anything;
    `wassel-files` enforces a 31-MIME allowlist + 500 MB cap. AVIF, MKV, AVI, AAC and
    the design formats (PSD/AI/FIG) are rejected BEFORE upload with a specific
    bilingual message naming the file and the fix. The allowlist was deliberately NOT
    widened. Signing failures render an inline notice with a retry, never a blank tile.
  - **Access.** Migration `2026-08-09_mos_canonical_file_assets.sql` lets any holder of
    the MOS `read` capability VIEW a file that is a library asset (`wassell_can_access_file`),
    and closes the two paths that could otherwise point `mos_assets.file_id` at an
    arbitrary restricted file — see `docs/prd/access-control.md`.
  - Not done in this phase: the existing 1,252 duplicates are untouched (no migration,
    no deletion), and the Search screen still shows a kind placeholder rather than a
    thumbnail for file-backed assets (its hits carry no `file_id`).
- **Material intake — direct multi-file upload (2026-08-04).** The «مادة جديدة»
  (New material) modal on a content piece's Materials tab (`NewAssetModal` in
  `src/pages/Marketing/components/MaterialsTab.tsx`) **uploads files directly** —
  a drag-drop/click zone (`multiple`) queues one or MORE files and streams each
  browser→`wassel-files` bucket via `uploadCanonicalAsset`
  (`src/pages/Marketing/lib/canonicalUpload.ts`, the same engine as the bulk intake
  queue; superseded the public-bucket `uploadToStorage` on 2026-08-09),
  with per-file progress and HEIC→JPEG conversion. **One `mos_assets` row is
  created per file** (each linked as role `source`); shared Source/Shot-on/Tags
  apply to the whole batch, `kind` is the select for a single file and
  auto-detected per file for a batch, and the name is the field for a single file
  or each file's own filename for a batch. A per-file failure is surfaced and
  skipped without sinking the rest (partial success links what succeeded). Each row
  fills `mos_assets.file_id` (the canonical `files` row) + `mime_type`/`size_bytes`/
  `original_name`; `url`/`thumb_url`/`file_path` stay NULL. The storage write is gated
  by the `manage_assets` capability.
  **The old Drive/anywhere link field was removed** — the modal was link-only
  ("الرابط يكفي…") through 2026-08-04 AM, then briefly upload-or-link; it is now
  upload-only (paste-a-link is gone per user request). Pulling an existing library
  row into a piece still works via «سحب من المكتبة».
- **Bulk upload — shared panel OR per-file overrides (2026-08-06).** The dedicated
  upload/intake screen (`/m/library/upload`, `src/pages/Marketing/UploadPage.tsx`)
  drops many files at once with an «ينطبق على الجميع» (Applies to all) panel —
  Project / Shoot / Source / Shot-on / Usage-rights / **Aspect ratio** / Tags applied
  to the whole batch. **Each queued file now also has a «تعديل» (Edit) toggle** that
  opens a per-file editor overriding Name / Kind / Project / Source / Shot-on /
  Usage-rights / **Aspect ratio** / Tags for that one file; anything left untouched
  inherits the shared panel at
  upload time (both paths run the same `saveAsset` call — overrides are a
  `RowOverride` patch, absent keys fall back to the shared value). A file with any
  override wears a «مخصّص» (Custom) pill, and «إرجاع إلى المشترك» (Reset to shared)
  clears them. Folder-name tags are still appended on top of whichever tag list
  applies. This makes «apply the same info to all» and «edit each one separately»
  the same intake, chosen per file.
- **Cost per lead is computed** from the execution rows, never typed.
- **Structured platform settings — the real Ads-Manager fields (2026-08-09).**
  On Meta, Instagram, Snapchat and TikTok executions, the detail page's
  targeting tab becomes **«إعدادات المنصة» (Platform settings)**: a sectioned
  form (objective → budget & bidding → schedule → targeting → placements →
  destination) whose fields carry the platform's REAL Marketing-API names and
  enum values (`mos_campaign_executions.platform_settings` jsonb) — so a saved
  execution can later be pushed through the platform's API unchanged. The form
  enforces what the platforms enforce: Meta's objective→optimization-goal
  matrix filters the goal select, TikTok's goal→billing table auto-fills the
  billing event, conditional fields (bid caps, pixel, end date) appear only
  when relevant, immutable-after-creation fields wear a 🔒, and
  allowlist-gated enum values say so. The quick execution modal asks ONE
  platform field — the objective — and the `instagram` platform is the Meta
  schema with placements preset to Instagram-only (that is what an Instagram
  campaign IS on the real API). Ads gained the ad-level twin
  (`mos_execution_ads.creative`): format, copy, CTA enum, destination URL /
  lead-form id / Spark post id, edited inside the ad modal. Header chips, the
  side rail and the campaign's execution cards show a computed summary
  (objective · goal · budget · geo). Platforms without a structured schema
  (google, x, youtube) keep the free-text brief, which also survives as a
  notes card under the structured form. Schemas are DATA
  (`src/lib/marketingOS/adPlatforms/` — one file per platform, one generic
  renderer), so adding Google Ads later is a schema file, not a component.
  Field research: `docs/reference/ad-platforms/`. Money is entered in SAR;
  minor-unit/micro conversion is handled by the push layer below.
- **«إنشاء في ميتا» (Create in Meta) — the push layer (2026-08-19).** A
  `manage_paid_ads` role on a Meta/Instagram execution that is not yet linked
  sees a **Create in Meta** button in the execution header. It builds the
  PLANNED structure — the campaign (`mos_campaigns.objective` → ODAX objective)
  plus one Meta ad set per planned `mos_ad_sets` row (a single default when none
  are planned) — directly in the real ad account via the Marketing API, **all
  PAUSED so nothing spends**, then writes the returned `platform_campaign_id` /
  `platform_adset_id` back onto the Wassell rows so the execution is linked with
  **no manual id typing**. Payloads come from `platform_settings` where present,
  else objective-driven defaults (leads → Click-to-WhatsApp: CONVERSATIONS /
  IMPRESSIONS / WHATSAPP destination / promoted page; geo defaults to KSA;
  SAR→halalas ×100). **Ads/creatives are deliberately NOT created here** —
  Meta blocks app-made ad creatives while the Meta *App* is in Development mode
  (subcode 1885183), so the media buyer adds the ads in Meta and the hourly
  `meta_sync` matches them back by platform id. Once the app goes Live, the same
  path can be extended to ads. Action `meta_push_structure` in
  `api/marketing-os.ts` (gated `manage_paid_ads`), builders in
  `api/_lib/marketing/metaPush.ts`, client `mosMetaPushStructure`. Re-pushing a
  linked execution is refused (409); already-linked ad sets are skipped, so it is
  idempotent.
- **The campaigns list's platform sub-line is computed server-side.** Under each
  campaign name the list shows its platforms — a paid campaign's executions' ad
  platforms, or (organic, or a paid campaign not launched yet) the feeds its
  attributed content publishes to; empty reads «لم تُطلق». `campaign_list` now
  returns this as `campaign.platforms` (three bounded, campaign-scoped reads).
  This replaced a client-side resolver that fetched a full `campaign_detail` for
  **every** row plus a `publication_list` on load — an N+1 that saturated the
  browser's connection limit and the DB and froze the whole workspace on a phone
  when opening Campaigns ("entering Campaigns hangs").
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
- **The goal field is a pure human description, never parsed for numbers.** It is
  the campaign's name/handle in lists (there is no separate name field) and is
  required, but the system reads **zero** numbers out of it. Every target, actual,
  pace, and verdict comes from the success measures — the campaign card, the
  detail «مقابل الهدف» pace card, projections, and gaps all read a MEASURE, not the
  goal sentence. (Previously the card scraped the first number out of the goal
  text as a fallback target; that path is gone.)
- **One measure is the «الرئيسي / main» measure — the one the card headlines.**
  When a campaign has more than one measure, the success-criteria editor shows a
  **★ Make main** toggle per row; the picked measure is stored first in
  `success_measures` (the server derives the back-compat scalar pair from `[0]`).
  The campaign card then shows that measure: a **volume goal** (higher-is-better
  qualified/leads/impressions/clicks) renders a pace bar (actual of target · %,
  on/behind pace vs the elapsed window), while a **cost/rate goal**
  (lower-is-better CPL/CTR/spend) renders actual-vs-target with an **under/over
  target** verdict. A measure whose source has no live actual yet (`none`, or a
  rate with no data) shows the target with «الهدف — بانتظار الأرقام». The detail
  page's pace/projection math still needs an accumulating volume measure, so it
  honors the main choice when it is a volume goal and otherwise falls back to the
  first volume measure.
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
- **Every campaign serves at least one GOAL, and may serve several (2026-08-07).**
  A **goal** is a simple, reusable objective — a `name` plus a `description` — kept
  in a managed registry (`mos_goals`) and surfaced on its own **Goals** screen
  (`/m/goals`, in the «الإنفاق» group above Campaigns). Campaigns link to goals
  through a many-to-many junction (`mos_campaign_goals`), so a single goal groups
  many campaigns and a single campaign can answer to several goals. The New/Edit
  campaign forms carry a **required** goal multi-select (`GoalMultiSelect`) and
  refuse to save with none; `campaign_save` enforces the same ≥1 rule on create
  server-side and replaces the junction on every save (delete-all-then-insert, so
  a save is idempotent). The campaign detail brief renders the linked goals as
  chips, and the campaigns list gained a **Goal** filter — each goal card links to
  its filtered campaigns via `/m/campaigns?goal=<id>`. Managing goals (create /
  edit / deactivate) and linking them is gated by `approve_budget`, the same
  capability that gates writing a campaign, so anyone who can spend can name what
  the spend is for. Deactivating a goal is hide-not-erase (existing links survive;
  an inactive goal still shows on a campaign that already carries it). Goals are
  single-language free text, like the audience/goal-sentence/offer brief fields.
  **A goal also carries its own success measures (2026-08-09)** — the SAME
  multi-measure build as a campaign's: `mos_goals.success_measures` (jsonb array),
  edited in the goal modal through the shared `SuccessMeasuresEditor` (pick from
  the `mos_measure_types` registry, define a new type inline, ★ main = first row),
  sanitized in `goal_save` with the identical shape/whitelist as `campaign_save`
  (no back-compat scalar pair — goals never had one), and rendered on each goal
  card as a ★/·-bulleted list of «label — target suffix» lines. Measures are
  optional on a goal (targets, not live-tracked rollups).
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
  `mos_audiences`, `mos_goals`, `mos_campaign_goals`, `mos_workflows`,
  `mos_workflow_steps`, `mos_platform_accounts`, `mos_ref_counters`,
  `mos_manual_tasks` + `mos_task_series` (hand-assigned work and its repeat
  rules — deliberately separate from the workflow queue).
- **Workflow engine + notifications:** `workflows` / `workflow_versions`
  (canonical role paths + pinned per-record snapshots, steps live in
  `metadata.steps` including each step's `notify` + `notify_channels`),
  `workflow_role_tasks` (the open task, carrying `workflow_version_id` +
  `step_key` so emission can read the pinned step's notification rules),
  `notifications` (the in-app inbox), `notification_rules` (the role × event ×
  channel grid), `notification_prefs`, `notification_deliveries` (WhatsApp
  outbox), `push_outbox` (push queue). Every notification enters through the
  `notify_emit` RPC, which now takes an optional per-step channel mask.
- **Views:** `mos_content_v` (derives status/owner from the open task),
  `mos_publication_v` (latest snapshot per publication), `mos_campaign_v`
  (spend/leads summed from executions).
- **Reads only:** `v_all_projects` (project names for the brief), `users`
  (role→person mapping).
- **Client acquisition (2026-08-23):** `client_attributions` (the append-only
  acquisition ledger — one row per client+ad; written by
  `mos_capture_ad_acquisition`, read through the `client_attributions_effective`
  view + `mos_client_acquisition`) and `records` (find-or-create the ad-sourced
  client). The read RPC also JOINs the marketing spine (`mos_execution_ads`,
  `mos_ad_sets`, `mos_campaign_executions`, `mos_campaigns`, `mos_content`) and
  `unified_records` (project name) to resolve each touch live. No marketing data is
  stored on the client.
- Shares NOTHING with the `mkt_*` tables — those belong to Marketing
  Intelligence, which watches competitors.

## Key files

| File | What it does |
|---|---|
| `src/pages/Marketing/MarketingWorkspace.tsx` | The shell: rail, workspace switcher, workspace-wide context (role, content types, project names), access gate |
| `src/pages/Marketing/mos.css` | The design system, scoped under `.mos-root` so the Sales theme is untouched |
| `src/pages/Marketing/OverviewPage.tsx` | Overview — manager state (s01: counters, stalled, week, paid ads) and CEO state (s34: funnel, returns, production, signature) branched on the active role |
| `src/pages/Marketing/WorkPage.tsx` | My work (s02) — late / yours today / someone else's + the «القادم إليك» band, plus the «مهام مُسندة إليكِ» block of hand-assigned tasks (own «تم» action) and the «مهمة جديدة» button |
| `src/pages/Marketing/TeamPage.tsx` | Team work (s35) — role-load tiles, every open task, imbalance + approvals cards, the team-wide «مهام مُسندة يدويًا» table (edit / cancel) and «إسناد مهمة» |
| `src/pages/Marketing/components/NewTaskModal.tsx` | New / edit a hand-assigned task: title, details, assignee (person picker only with `assign_task`), due date or repeat rule (daily / weekly with Sunday-first weekday chips / monthly), and the optional campaign / content / goal / project links. States the rule in words in the footer before you commit |
| `supabase/migrations/2026-08-10_01_mos_manual_tasks.sql` | `mos_manual_tasks` + `mos_task_series`, the `assign_task` capability seed (MM / CEO / ops), RLS (self-assign always allowed, others need the capability), the `mos_tg_manual_task_guard` column guard, and the idempotent `mos_task_series_materialize()` occurrence generator |
| `supabase/migrations/2026-08-11_01_manual_task_assigned_notifications.sql` | The `manual_task_assigned` role × channel seed (in-app everywhere, WhatsApp for writer + editor, push off), with an in-migration assertion that the whole 5 × 3 grid landed so the settings matrix never renders a cell with no row behind it |
| `src/pages/Marketing/ContentListPage.tsx` | The content library — table and board |
| `src/pages/Marketing/ContentDetailPage.tsx` | The content workspace — six tabs as local state, stage rail, thread |
| `src/pages/Marketing/CampaignsPage.tsx` / `CampaignDetailPage.tsx` | Spend: campaigns, executions, results. Both forms carry the required goal multi-select; the list gained a Goal filter; the detail brief shows linked goals as chips. The execution modal asks the platform's real objective and seeds settings defaults. The desktop table has multi-select + bulk delete (`delete_records`; Meta-sync holder and attribution-linked campaigns are refused) |
| `src/pages/Marketing/ExecutionDetailPage.tsx` | The execution (screen 21): ads, platform settings / targeting brief, lead form, daily. Structured platforms swap the targeting tab for the real Ads-Manager fields; the ad modal carries the platform's creative fields |
| `src/lib/marketingOS/adPlatforms/` | The platform schemas AS DATA — `meta.ts` (also serves Instagram), `snapchat.ts`, `tiktok.ts` + shared types, dependency rules (goal-by-objective, TikTok goal→billing), summary/progress helpers. Field research: `docs/reference/ad-platforms/` |
| `src/pages/Marketing/components/PlatformSettingsForm.tsx` | The one generic renderer for every platform's settings form + the reusable fields grid the ad modal embeds |
| `supabase/migrations/2026-08-09_mos_execution_platform_settings.sql` | `mos_campaign_executions.platform_settings` + `mos_execution_ads.creative` (both jsonb, additive) |
| `src/pages/Marketing/GoalsPage.tsx` | The Goals registry (`/m/goals`): list goals with a linked-campaign count, create/edit/deactivate + multi-select bulk delete (gated by `approve_budget`; links detach, campaigns survive), and a per-goal deep link into the filtered campaigns list |
| `src/pages/Marketing/components/GoalMultiSelect.tsx` | The campaign brief's goal picker — toggle chips over the active goals (plus any already-selected inactive one); loads goals itself |
| `supabase/migrations/2026-08-07_mos_goals.sql` | `mos_goals` + junction `mos_campaign_goals` (RLS: read = `read`, writes/links = `approve_budget`) + seeds the `goals` surface into `surface_access` (ceo/mm full, ops read) |
| `src/pages/Marketing/ShootsPage.tsx` | The derived shoot backlog (the `LibraryPage.tsx` grid was retired 2026-08-20 → `/m/library` redirects to `/files`, see the "Asset library grid was RETIRED" note above) |
| `src/pages/Marketing/NumbersPage.tsx` | The Friday data-entry screen |
| `src/pages/Marketing/OrganicPulsePage.tsx` | **Platform Pulse** (`/m/organic`, surface `organic`) — per-account organic growth cockpit: followers + 7d/30d deltas, growth sparkline (inline SVG, no chart dep), 30-day reach/engagement (+rate), posting cadence (flags a quiet account), cross-account comparison, best posts. «تحديث الأرقام الآن» (`account_metrics_pull_all`) + «تحديث حالة الربط» (`platform_sync`) |
| `src/pages/Marketing/PublishingBoardPage.tsx` | **Publishing Board** (`/m/publishing`, surface `publishing`) — the cross-platform publish queue over ALL content, bucketed attention→in-flight→published→draft (failures first + republish), filterable, inline publish-now / schedule / sync reusing `publication_publish` / `publication_sync` |
| `api/_lib/marketing/bundleAccountMetrics.ts` | The account-analytics engine (twin of `bundleMetrics.ts`): `pullAccountMetrics` (UPSERT one snapshot per account/day) + `runBundleAccountMetricsSync`; used by the daily cron AND the `account_metrics_pull_all` action. Account-analytics helpers (`getSocialAccountAnalytics` / `accountAnalyticsToSnapshot`) live in `bundleSocial.ts` |
| `supabase/migrations/2026-08-20_mos_account_metrics.sql` | `mos_account_metric_snapshots` (daily follower/reach history bundle deletes after 30d) + `mos_account_pulse_v` (card rollup) + RLS mirroring `mos_metric_snapshots` + seeds the `organic`/`publishing` surfaces from the `numbers` surface's per-role levels |
| `src/pages/Marketing/SettingsPage.tsx` | Workflows, content types, platforms, roles + the capability matrix |
| `src/pages/Marketing/components/SettingsAccess.tsx` | Roles & permissions screen — a segmented **Surfaces** (rail visibility) / **Capabilities** (what a role can DO) matrix; capability cells write `role_capabilities` via the `capability_set` action |
| `supabase/migrations/2026-08-06_01_role_capabilities.sql` | `role_capabilities` table + `roles.domain`; seeds the table from the old `wassell_mos_can` CASE with an in-migration parity assertion |
| `supabase/migrations/2026-08-06_02_mos_can_data_driven.sql` | Rewrites `wassell_mos_can` to read `role_capabilities` (signature unchanged → RLS untouched), parity-checked end-to-end |
| `supabase/migrations/2026-08-06_03_mos_capabilities_fn.sql` | `wassell_mos_capabilities()` — the caller's capability UNION, shipped in bootstrap `me.capabilities` so the client keeps no matrix copy |
| `supabase/migrations/2026-08-06_04_role_capabilities_write_policies.sql` | INSERT/DELETE RLS on `role_capabilities` gated by `manage_roles` (mirrors `surface_access`) |
| `supabase/migrations/2026-08-16_mos_delete_records_capability.sql` | Seeds the `delete_records` capability (Marketing Manager only) and re-points the DELETE RLS on `mos_content`, `mos_scenes`, `mos_manual_tasks`, `mos_assets`, `mos_campaigns`, `mos_campaign_executions`, `mos_execution_ads` to `wassell_mos_can('delete_records')` (the four `_write` FOR-ALL policies are split into `_ins`/`_upd`/`_del` so delete can peel off) |
| `supabase/migrations/2026-08-06_mos_content_approval_asset.sql` | `mos_content.approval_asset_id` + `mos_publications.asset_id`, the `mos_promote_approval_asset` SECURITY-DEFINER RPC (approval → `final` link), and the two views re-exposed with the new columns |
| `src/pages/Marketing/components/SettingsWorkflows.tsx` | The workflow path/step editor — each step carries an owning role, a **due-in-days** value (`due_days`, integer ≥ 0; `0` = same day, i.e. the task is due the day the step opens) that the engine turns into the task's `due_at` (`now() + due_days days`), approval + required fields, **and the per-step notification gate + channels** |
| `supabase/migrations/2026-08-05_mos_step_notify_channels.sql` | Adds the per-step channel mask to `notify_emit` (AND-s step-permitted channels with each role's grid; back-compatible, mask defaults NULL) |
| `src/pages/Marketing/components/` | Shared primitives (`kit.tsx`), icons, task card, stage rail, writing fields, scenes, publishing, performance, material, thread |
| `src/pages/Marketing/components/SuccessMeasuresEditor.tsx` / `SettingsMeasures.tsx` | A campaign's multi-measure success criteria (incl. the ★ **main-measure** picker that stores the chosen row first) + the managed measure-type registry (both auto-translate the name; unit = count/riyal/percent) |
| `src/pages/Marketing/lib/measure.ts` | The ONE place that turns a campaign's success measures into headline numbers — `pickMainMeasure` (card headline = first measure with a target), `pickVolumeMeasure` (detail pace math), `measureActual` (live value per source). The goal text is never read here. |
| `src/pages/Marketing/components/AudiencePicker.tsx` / `SettingsAudiences.tsx` | The campaign brief's saved-audience picker (pick existing or create inline) + the managed audiences registry (`mos_audiences`: name + details) |
| `src/hooks/useBilingualLabelAutofill.ts` | Live Arabic⇄English name auto-fill for local-state label pairs (wraps `useDebouncedTranslation`) |
| `src/pages/Marketing/lib/format.ts` | Arabic-Indic numerals and dates — one place that decides digit shape |
| `api/marketing-os.ts` | The action-dispatch endpoint; runs on the caller's JWT, never service role. Holds `publication_publish` / `publication_sync` / `platform_sync` |
| `api/_lib/marketing/bundleSocial.ts` | Thin bundle.social client — upload-from-URL, post create/get/delete, get-team, get-post-analytics, per-platform `data` builder + status/permalink/analytics mappers. Self-disables when the API key/team id are unset |
| `api/_lib/marketing/bundleMetrics.ts` | The ONE "pull analytics → `api` snapshot" engine (deduped, permalink backfill), used by both the cron and `metrics_pull` / `metrics_pull_all` |
| `api/cron/bundle-metrics.ts` | Daily cron that pulls numbers for every published bundle post in the 30-day window (`runBundleMetricsSync`, service role, CRON_SECRET auth) |
| `src/pages/Marketing/components/PublishTab.tsx` | The Publish screen — one card per platform; the «انشر الآن» / «جدولة» + «تحديث الحالة» controls for connected platforms |
| `src/pages/Marketing/components/SettingsPlatforms.tsx` | Settings → Platforms — account cards + «تحديث حالة الربط» (platform_sync) |
| `src/lib/marketingOS/client.ts` | Typed SPA client + the bilingual label maps |
| `src/components/Layout/Header.tsx` | The Sales-side half of the workspace switcher |
| `supabase/migrations/2026-08-23_01_client_marketing_acquisition.sql` | Turns the dormant `client_attributions` ledger live: the `channel` column + channel-aware spend CHECK, `mos_capture_ad_acquisition` (webhook find-or-create + «ترويج» tag + ledger append) and `mos_client_acquisition` (live-resolved Sales read surface, gated on record-view not marketing role), the re-expanded `client_attributions_effective` view, and the 42-row first-touch backfill. Applied live |
| `src/lib/acquisition/client.ts` + `src/pages/Records/components/ClientAcquisitionPanel.tsx` | The Sales-side «كيف وصلنا هذا العميل» panel on the client record form (calls `mos_client_acquisition`) — see [clients.md](clients.md) |

## Open questions / known limitations

- **Organic auto-publish + automatic metrics are live for Instagram / TikTok /
  Snapchat** via bundle.social (see the Publishing + Metrics Key-behaviors
  bullets). Instant post-status is wired too: `api/webhook/bundle-social.ts`
  receives bundle's `post.published` event (HMAC-SHA256 `x-signature` verified)
  and flips the row to `published` + permalink / records the error the moment
  bundle finishes — the poll paths (on-open auto-poll, «تحديث الحالة», daily
  cron) remain as the fallback. **One manual step:** the webhook URL +
  `BUNDLE_SOCIAL_WEBHOOK_SECRET` must be set from the bundle.social Webhooks
  dashboard (bundle exposes no webhook API); until then the endpoint is a safe
  no-op. What's NOT built: richer per-platform options (Snapchat Spotlight,
  first-comment hashtags, carousels/multi-file posts, IG collaborators/location),
  **profile-level** analytics (follower growth — only per-post metrics are
  pulled), and a live SPA push on webhook receipt (the DB is instant; an open
  Publish tab reflects it on its next fetch/auto-poll). Meta/TikTok *ad* review is
  unrelated — that's the paid side (Meta Marketing API), already partly synced.
- **Metrics are manual.** The `source` column already distinguishes
  `manual` from `api` so a later integration can backfill without rewriting
  history.
- **The mobile layout ships and is structurally verified** (drawer rail, stacked
  split panes, collapsing grids, tables scrolling inside their card) but has not
  yet been walked screen-by-screen on a real phone-width viewport.
- **The 2026 palette is not in this module.** It uses the palette the rest of the
  app ships; migrating the app-wide Tailwind theme is separate work.
- **Notifications are built** — the in-app inbox, the role × event × channel
  grid (Settings → Notifications, design screen 43), push (`push_outbox`) and
  WhatsApp (`notification_deliveries`) all exist, and each workflow step now
  carries its own notify gate + permitted channels (see Key behaviors). The
  task queue remains the always-on surface; notifications are the interrupt on
  top of it. Real WhatsApp send depends on the Fly worker draining
  `notification_deliveries`, and the `external_effects` kill switch gates both
  outward channels.
