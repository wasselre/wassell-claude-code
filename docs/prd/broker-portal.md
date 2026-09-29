# PRD: Broker Portal (بوابة الوسطاء)

**Status:** Live (first portal: الرمز / Al-Ramz)
**Last updated:** 2026-09-29
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
- **Send limits live in the database** (`broker_portal_send_claim`, row-locked per portal): portal switch `send_enabled`, `daily_send_cap` (default 20/day, Riyadh day), the same client + project once per 24 h, one client at most 3 projects per 24 h, 10 sends per hashed IP per hour. Every attempt is logged in `broker_portal_sends` (who sent what to whom, outcome). These exist because each send is a first message to a stranger from the MAIN line — the traffic WhatsApp restricts (463) and bans.
- **Share it yourself:** the send sheet also shows the exact project message with «نسخ رسالة المشروع» and brochure downloads. Every image tile has copy-image (PNG to clipboard, paste into WhatsApp; falls back to download) and download buttons; the lightbox has both too. Clipboard failures show a notice, never a blocking prompt.
- **Library («مكتبة الرمز», `?view=library`):** every linked file across all the developer's projects and units (photos, designs, videos, floor plans, brochures) plus the projects' reel links (de-duplicated by URL). Filter by type and project, search names AND video transcripts. Metadata comes in one call (`library`); URLs are signed per visible page (`sign`, max 60 ids, only files linked to this developer's records).
- **Transcripts:** shown only when they are real speech. Legacy English rows (wizper defaulted to English and translated Saudi Arabic speech — being repaired by `scripts/retranscribe-arabic.mjs`) and music-only "♪ Thank you" rows are hidden (`isPresentableTranscript`). Source: `files ← mkt_content_media.file_id → mkt_transcripts`.

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
| `api/broker-portal-send.ts` | nodejs: `message` preview + `send` via `sendProjectViaAiFlow` (intro line, `force`, no AI) |
| `api/_lib/brokerPortal.ts` | Shared token → portal resolver + project-belongs-to-developer check |
| `api/_lib/aiSendProject.ts` | `introText` option + `resolveProjectMessagePreview` (added for the portal) |
| `src/pages/BrokerPortal/components/SendToClientModal.tsx` | Send form, limit messages, copy message, brochure downloads |
| `src/pages/BrokerPortal/components/LibraryView.tsx` | Developer-wide library: filters, transcript search, on-demand signing |
| `src/pages/BrokerPortal/lib/flash.ts` | Page-local toast (the CRM store/toasts don't boot here) |

## Open questions / known limitations
- Turning sending off: `UPDATE broker_portals SET send_enabled=false …`; the cap: `daily_send_cap`. See who sent what: `SELECT * FROM broker_portal_sends ORDER BY created_at DESC`.
- Transcript coverage for Al-Ramz is thin: of 111 videos, ~20 legacy English rows await the Arabic repair and 40 (our own marketing videos, not collected reels) have never been transcribed — no pipeline covers non-collected files yet.
- Hosted reel links (`project_videos`) may duplicate collected video files; they cannot be matched by name.
- No admin UI to create/revoke portals or see view counts — SQL only.
- Anyone holding the link can open it (no password / per-broker identity); revoke by deactivating the row.
- Only files LINKED to the project or its units appear. Several Al-Ramz brochures in Files are not linked to any project (e.g. «بروشور - الرمز - سديم - شقق - الصفا.pdf», «بروشور - الرمز - جديل - ادوار - الرمال.pdf», «بروشور- ريا النخيل -.pdf») and therefore do not show until someone links them.
- 8 of Al-Ramz's 16 projects have no units or media in the CRM yet; they appear as «قريباً».
- Descriptions (`marketing_document`) are Arabic-only; English mode translates labels, not free text.
