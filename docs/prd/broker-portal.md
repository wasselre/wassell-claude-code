# PRD: Broker Portal (بوابة الوسطاء)

**Status:** Live (first portal: الرمز / Al-Ramz)
**Last updated:** 2026-09-29
**Related PRDs:** [files.md](files.md) (file links, signed URLs, `/share/:token` pattern), [record-management.md](record-management.md) (all_projects / units), [public-website.md](public-website.md) (the other anon surface)

## What it is (in plain English)
A no-login web page for **outside brokers** that shows one developer's complete sales kit: every project, every unit with its price, status and floor plan, the payment plans (with SAR amounts per unit), photos, videos, the marketing library (designs + reels) and the brochures/PDFs. A broker opens a link like `app.wassel.re/brokers/<token>`, browses projects, filters units, opens a unit and shares it with a client on WhatsApp. The first portal was built as a gift for Al-Ramz Real Estate so their broker network can market their projects.

## Why it exists
Brokers ask for the same material over and over (price lists, plans, photos, brochures). The CRM already holds all of it, live. One link replaces a folder of PDFs that goes stale the day a unit sells.

## Key behaviors
- **One portal = one developer.** A `broker_portals` row binds a random token to a developer record. Every project whose `all_projects.developer` equals that developer is shown; nothing else is reachable with the token (a project id from another developer returns the same 404).
- **Live data.** Units, statuses, prices and the stored project rollups (`available_*` ranges) are read at request time. A sold unit stops being "available" the moment the CRM says so. Sold units show no price.
- **Whitelisted projection only.** The endpoint builds an explicit response; internal fields (`project_analysis`, `source_notes`, `update_source_*`, `data_sources`, owner/sales fields…) are never read into it.
- **Files** come from `file_links` on the project AND its units, restricted to `status='active'`, not archived, confidentiality `internal`/`public`. They are grouped: floor plans (`floor_plan` role / `unit_plan` category), marketing library (`marketing_asset` + `social_post`, non-PDF), documents (PDFs), videos, photos. The Videos tab additionally shows the library's videos plus the project's hosted `project_videos` URLs (YouTube embeds + direct mp4s).
- **Signed URLs live 6 hours**; the page silently re-fetches on focus after 5 hours. Images get a resized thumbnail URL (falls back to the original on error); every file has a named download URL.
- **Project cards** sort by available units, then size. Cover = `main_image`, else first `project_images`, else the best linked image (hero/main/gallery before marketing designs, landscape first). A project with no units shows «قريباً / Coming soon»; `project_status='unknown'` is hidden rather than shown as «غير معروف».
- **Unit sheet:** floor plan (zoomable), facts, components, each payment plan with the percentage AND the computed SAR amount (`price × %`, labelled as an estimate), WhatsApp share (unit summary + deep link) and copy-link.
- **Floor plans tab:** one card per plan with the model / bedrooms / area range / lowest available price and "N available / M" — "Show units" filters the Units tab to exactly those units.
- **Deep links:** `?p=<projectId>&tab=<tab>&u=<unitId>&lang=en`. Arabic is the default; the language lives in the URL, not the app's stored preference.
- **The CRM store never boots on this page.** `App.tsx` skips `bindAuth()/initialize()` and the app-level `dir` effect for `/brokers/*` — an anonymous visitor would otherwise run the full records load (RLS-filtered to nothing, and slow enough to time out into a red "Server sync failed" toast).
- **Views are counted** (`view_count`, `last_viewed_at`) on every overview load.

## User flows
1. **Broker happy path:** open link → developer hero (projects / total units / available, phone, website) → search or pick a project → overview (description, features, payment plans, warranties, map, landmarks, services) → Units → filter by status/type/bedrooms/building/max price → open a unit → share on WhatsApp.
2. **Plan-first:** Floor plans tab → pick a layout → "Show units" → the Units tab lists only units with that plan.
3. **Media:** Photos / Videos / Marketing library open a full-screen lightbox (keyboard + RTL-aware arrows, download); Brochures open in the in-app PDF viewer with a download button; external brochure links (Drive) are listed separately.
4. **Error / empty:** wrong, inactive or expired token → «الرابط غير متاح» card. Empty media tabs are hidden; an empty units list says so.

## Creating / revoking a portal (admin, SQL for now)
- Create: `INSERT INTO broker_portals (developer_id, title_ar, title_en) VALUES ('<developer record id>', '…', '…') RETURNING token;` → link is `https://app.wassel.re/brokers/<token>`.
- Revoke: `UPDATE broker_portals SET is_active = false WHERE id = '…';` (or set `expires_at`).
- There is no in-app UI for this yet.

## Data touched
- Reads (service role, inside `api/broker-portal.ts` only): `broker_portals`, `models` (option labels for bilingual values), `records` (developer, `all_projects` by `data->>developer`, `units` by `data->>project_id` — paginated), `districts` / `cities` (names), `file_links`, `files`, Storage signed URLs.
- Writes: `broker_portals.view_count` / `last_viewed_at` via `broker_portal_record_view(id)` (service-role only).
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

## Open questions / known limitations
- No admin UI to create/revoke portals or see view counts — SQL only.
- Anyone holding the link can open it (no password / per-broker identity); revoke by deactivating the row.
- Only files LINKED to the project or its units appear. Several Al-Ramz brochures in Files are not linked to any project (e.g. «بروشور - الرمز - سديم - شقق - الصفا.pdf», «بروشور - الرمز - جديل - ادوار - الرمال.pdf», «بروشور- ريا النخيل -.pdf») and therefore do not show until someone links them.
- 8 of Al-Ramz's 16 projects have no units or media in the CRM yet; they appear as «قريباً».
- Descriptions (`marketing_document`) are Arabic-only; English mode translates labels, not free text.
