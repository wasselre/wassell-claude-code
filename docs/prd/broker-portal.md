# PRD: Broker Portal (بوابة الوسطاء)

**Status:** Live (first portal: الرمز / Al-Ramz)
**Last updated:** 2026-09-30
**Related PRDs:** [files.md](files.md) (file links, signed URLs, `/share/:token` pattern), [record-management.md](record-management.md) (all_projects / units), [public-website.md](public-website.md) (the other anon surface)

## What it is (in plain English)
A no-login web page for **outside brokers** that shows one developer's complete sales kit: every project, every unit with its price, status and floor plan, the payment plans (with SAR amounts per unit), photos, videos, the marketing library (designs + reels) and the brochures/PDFs. A broker opens a link like `app.wassel.re/brokers/<token>`, browses projects, filters units, opens a unit and shares it with a client on WhatsApp. The first portal was built for Al-Ramz Real Estate so their broker network can market their projects. Brokers can also have Wassel's sales WhatsApp line send a project to their client, copy the ready message, copy/download images and PDFs, and browse a developer-wide library («مكتبة الرمز»).

## Why it exists
Brokers ask for the same material over and over (price lists, plans, photos, brochures). The CRM already holds all of it, live. One link replaces a folder of PDFs that goes stale the day a unit sells.

## Key behaviors
- **One portal = one developer.** A `broker_portals` row binds a random token to a developer record. Every project whose `all_projects.developer` equals that developer is shown; nothing else is reachable with the token (a project id from another developer returns the same 404).
- **Live data.** Units, statuses, prices and the stored project rollups (`available_*` ranges) are read at request time. A sold unit stops being "available" the moment the CRM says so. Sold units show no price.
- **Whitelisted projection only.** The endpoint builds an explicit response; internal fields (`project_analysis`, `source_notes`, `update_source_*`, `data_sources`, owner/sales fields…) are never read into it.
- **Files** come from `file_links` on the project AND its units, restricted to `status='active'`, not archived, confidentiality `internal`/`public`. They are grouped: floor plans (`floor_plan` role / `unit_plan` category), marketing library (`marketing_asset` + `social_post`, non-PDF), documents (PDFs), videos, photos. The Videos tab additionally shows the library's videos plus the project's hosted `project_videos` URLs (YouTube embeds + direct mp4s).
- **Signed URLs live 6 hours**; the page silently re-fetches on focus after 5 hours. Images get a resized thumbnail URL (falls back to the original on error); every file has a named download URL.
- **Project cards** sort by available units, then size. Cover = `main_image`, else first `project_images`, else the best linked image (hero/main/gallery before marketing designs, landscape first). A project with no units shows «قريباً / Coming soon»; `project_status='unknown'` is hidden rather than shown as «غير معروف».
- **Payment schedules** (project overview + unit sheet) render as one bullet per instalment, split on « · »; Arabic uses «٪». **Unit sheet:** floor plan (zoomable), facts, components, each payment plan with the percentage AND the computed SAR amount (`price × %`, labelled as an estimate), WhatsApp share (unit summary + deep link) and copy-link.
- **Floor plans tab:** one card per plan with the model / bedrooms / area range / lowest available price and "N available / M" — "Show units" filters the Units tab to exactly those units.
- **Deep links:** `?p=<projectId>&tab=<tab>&u=<unitId>&lang=en`. Arabic is the default; the language lives in the URL, not the app's stored preference.
- **The CRM store never boots on this page.** `App.tsx` skips `bindAuth()/initialize()` and the app-level `dir` effect for `/brokers/*` — an anonymous visitor would otherwise run the full records load (RLS-filtered to nothing, and slow enough to time out into a red "Server sync failed" toast).
- **Views are counted** (`view_count`, `last_viewed_at`) on every overview load.

- **Send to client (from Wassel's sales line).** Every project with units shows «أرسل لعميلك» (on its card and in the project hero). The broker enters the client's mobile (KSA mobiles only), optional client name, their own name (required) and optional mobile. `api/broker-portal-send.ts` (nodejs) calls the SAME `sendProjectViaAiFlow` the WhatsApp bot uses — project message (saved template if its numbers are current, else the deterministic sheet; no AI call), then the brochure, then the photos — on the default (sales) line, with a first line naming the broker. The reply lands in Wassel's inbox like any bot-sent project.
- **Everything a client receives follows the tracked-links way** ([tracked-links.md](tracked-links.md), since 2026-09-29/30):
  - *Send from Wassel's line* = project card + ONE cover photo + that client's tracked links (photos / videos / brochure / units / location) — no brochure PDF, gallery or video uploads (files only as the fallback when a link can't be minted). Links are `sent_via='broker'`, so engagement shows on the chat like any tracked message.
  - *Copy project message* carries its own tracked links (one link minted per opened send sheet, `sent_via='broker'`, no chat) instead of the wassel.re website line; if minting fails the text comes back with the link line removed.
  - *Share unit* (available units only) mints a tracked, customer-facing unit page `/v/<token>` — a client is never sent a link into the broker portal.
  - Self-share links (copy / unit share) have no chat behind them, so they are capped at 300 per hour across the portal endpoint; past that the broker still gets text, without links.
- **Send limits live in the database** (`broker_portal_send_claim`, row-locked per portal): portal switch `send_enabled`, `daily_send_cap` (default 20/day, Riyadh day), the same client + project once per 24 h, one client at most 3 projects per 24 h, 10 sends per hashed IP per hour. Every attempt is logged in `broker_portal_sends` (who sent what to whom, outcome). These exist because each send is a first message to a stranger from the MAIN line — the traffic WhatsApp restricts (463) and bans.
- **Share it yourself:** the send sheet also shows the exact project message with «نسخ رسالة المشروع» and brochure downloads. Every image tile has copy-image (PNG to clipboard, paste into WhatsApp; falls back to download) and download buttons; the lightbox has both too. Clipboard failures show a notice, never a blocking prompt.
- **Library («مكتبة الرمز», `?view=library`):** every linked file across all the developer's projects and units (photos, designs, videos, floor plans, brochures) plus the projects' reel links (de-duplicated by URL). Filter by type and project, search names AND video transcripts. Metadata comes in one call (`library`); URLs are signed per visible page (`sign`, max 60 ids, only files linked to this developer's records).
- **Every video shows what the Arabic transcription found** — 🎙️ transcribed (speech), 🎵 music only, or 🔇 no sound track — so a broker sees all videos were checked, not only the few with speech. Collected reels also show their original **post caption** («نص المنشور», copyable ready-made copy). The library filter «فيديوهات بنص» = videos with a transcript OR a caption, and search covers both. Al-Ramz (2026-09-29): 111 videos → 7 speech, 97 music-only, 7 silent; 71 captions; 73 with text.
- **Transcripts:** shown only when they are real speech. Legacy English rows (wizper defaulted to English and translated Saudi Arabic speech — being repaired by `scripts/retranscribe-arabic.mjs`) and music-only "♪ Thank you" rows are hidden (`isPresentableTranscript`). Sources: collected reels `files ← mkt_content_media.file_id → mkt_transcripts`, and our own uploads `public.file_transcripts` (one row per file, added 2026-09-29). Filled for a whole developer by `scripts/transcribe-developer-videos.mjs --developer <id>` (fal wizper, language forced to Arabic, metered in `ai_usage` area `files`; music-only videos stored as language `none`).

## User flows
1. **Broker happy path:** open link → developer hero (projects / total units / available, phone, website) → search or pick a project → overview (description, features, payment plans, warranties, map, landmarks, services) → Units → filter by status/type/bedrooms/building/max price → open a unit → share on WhatsApp.
2. **Plan-first:** Floor plans tab → pick a layout → "Show units" → the Units tab lists only units with that plan.
3. **Media:** Photos / Videos / Marketing library open a full-screen lightbox (keyboard + RTL-aware arrows, download); Brochures open in the in-app PDF viewer with a download button; external brochure links (Drive) are listed separately.
4. **Error / empty:** wrong, inactive or expired token → «الرابط غير متاح» card. Empty media tabs are hidden; an empty units list says so.

## Creating / revoking a portal (admin, SQL for now)
- Create: `INSERT INTO broker_portals (developer_id, title_ar, title_en) VALUES ('<developer record id>', '…', '…') RETURNING token;` → link is `https://app.wassel.re/brokers/<token>`.
- Revoke: `UPDATE broker_portals SET is_active = false WHERE id = '…';` (or set `expires_at`).
- There is no in-app UI for this yet.

5. **Send to client:** project card or hero → «أرسل لعميلك» → client mobile + broker name → «إرسال» → "تم الإرسال" (or a translated limit message: already sent / 3-per-day / daily cap / paused / too many from this device).
6. **Library:** «مكتبة الرمز» tab → filter / search → copy or download any file; videos open with their transcript.

## Data touched
- Reads (service role, inside `api/broker-portal.ts` only): `broker_portals`, `models` (option labels for bilingual values), `records` (developer, `all_projects` by `data->>developer`, `units` by `data->>project_id` — paginated), `districts` / `cities` (names), `file_links`, `files`, Storage signed URLs.
- Writes: `broker_portals.view_count` / `last_viewed_at` via `broker_portal_record_view(id)` (service-role only); `broker_portal_sends` via `broker_portal_send_claim` / `_finish`; the send itself writes `scheduled_whatsapp_jobs` (reference `ai:broker-<send id>…` / `ai-project:broker-<send id>:…`) + `whatsapp_ai_replies` through the existing bot path.
- Reads for transcripts: `mkt_content_media`, `mkt_transcripts`.
- `broker_portals`: RLS on, admins only (`wassell_is_admin`); no anon grant.

## Key files
| File | What it does |
|---|---|
| `supabase/migrations/2026-09-29_broker_portals.sql` | Table, admin RLS, view-bump RPC, Al-Ramz seed |
| `api/broker-portal.ts` | Anonymous edge endpoint: `overview` + `project` actions, token → developer scoping, whitelisted projection, signed URLs |
| `src/pages/BrokerPortal/BrokerPortalPage.tsx` | Route `/brokers/:token`: header, developer hero, project grid, URL state, refresh-on-focus |
| `src/pages/BrokerPortal/components/ProjectView.tsx` | Project hero, KPI strip, tabs, overview, floor-plans, library |
| `src/pages/BrokerPortal/components/UnitsSection.tsx` | Unit filters, list, unit sheet with payment-plan amounts + share |
| `src/pages/BrokerPortal/components/Media.tsx` | Lightbox, media grid, videos (YouTube/mp4/files), documents + PDF viewer |
| `src/pages/BrokerPortal/lib/api.ts` / `lib/i18n.ts` | Response types + fetchers; bilingual copy and number formatting |
| `src/App.tsx` | Public route + `isSelfContainedPublicPath()` store-boot skip |
| `supabase/migrations/2026-09-29_broker_portal_sends.sql` | `send_enabled` / `daily_send_cap`, `broker_portal_sends` log, claim/finish RPCs |
| `api/broker-portal-send.ts` | nodejs: `message` (text + tracked links), `unit-link` (tracked unit page), `send` via `sendProjectViaAiFlow` (intro line, `force`, no AI) |
| `api/_lib/brokerPortal.ts` | Shared token → portal resolver + project-belongs-to-developer check |
| `api/_lib/aiSendProject.ts` | `introText` option + `resolveProjectMessagePreview` (added for the portal) |
| `src/pages/BrokerPortal/components/SendToClientModal.tsx` | Send form, limit messages, copy message, brochure downloads |
| `src/pages/BrokerPortal/components/LibraryView.tsx` | Developer-wide library: filters, transcript search, on-demand signing |
| `supabase/migrations/2026-09-29_file_transcripts.sql` | `file_transcripts` table + `file_video_transcript()` falls back to it |
| `scripts/transcribe-developer-videos.mjs` | Arabic transcripts for every video of one developer (dry-run / --confirm / --max-usd) |
| `src/pages/BrokerPortal/lib/flash.ts` | Page-local toast (the CRM store/toasts don't boot here) |

## Open questions / known limitations
- Engagement on links a broker sent THEMSELVES (copied message, shared unit) is recorded but not shown anywhere yet — it has no chat or client to hang on; one copied message reused for several clients shares one link.
- Turning sending off: `UPDATE broker_portals SET send_enabled=false …`; the cap: `daily_send_cap`. See who sent what: `SELECT * FROM broker_portal_sends ORDER BY created_at DESC`.
- Transcripts are filled by an operator script, not automatically: a video linked to the developer AFTER the run has none until the script is re-run (it skips videos already transcribed in Arabic).
- Hosted reel links (`project_videos`) may duplicate collected video files; they cannot be matched by name.
- No admin UI to create/revoke portals or see view counts — SQL only.
- Anyone holding the link can open it (no password / per-broker identity); revoke by deactivating the row.
- Only files LINKED to the project or its units appear. Several Al-Ramz brochures in Files are not linked to any project (e.g. «بروشور - الرمز - سديم - شقق - الصفا.pdf», «بروشور - الرمز - جديل - ادوار - الرمال.pdf», «بروشور- ريا النخيل -.pdf») and therefore do not show until someone links them.
- 8 of Al-Ramz's 16 projects have no units or media in the CRM yet; they appear as «قريباً».
- Descriptions (`marketing_document`) are Arabic-only; English mode translates labels, not free text.
