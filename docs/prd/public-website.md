# PRD: Public Marketing Website

**Status:** Live
**Last updated:** 2026-05-09
**Related PRDs:** [model-builder.md](model-builder.md), [record-management.md](record-management.md), [data-storage.md](data-storage.md)

## What it is (in plain English)
A public marketing site at the company's domain that pulls live data from the CRM. Three pages — homepage, projects listing, and projects map. Visitors see the company story, browse the projects an admin has chosen to publish, and view all published projects on a clustered map of Saudi Arabia. The CRM is the only place anyone edits content; the website is read-only.

The website lives in a separate folder/repo (`Wassel Website/`), not in this codebase. This PRD covers the CRM-side data model and the public-read RLS contract that backs the website.

## Why it exists
Marketing the company and the projects it manages without spinning up a separate CMS. Admins keep working in the one tool they already use (the CRM) — and changes show up on the public site within seconds, no rebuild required.

## Key behaviors
- **Opt-in publishing.** The "إعدادات الموقع / Website Settings" section on every project has an `is_public` checkbox (default OFF). Only rows where `is_public = true` reach the website. Existing 1,366 projects stayed private after the migration; admins toggle them on individually.
- **Schema-driven rendering.** The website does NOT hardcode field names. It reads `card_config.title_field_id` / `subtitle_field_id` / `badge_field_id` / `shown_field_ids` for the projects grid, and `maps_config.location_url_field_id` / `pin_label_field_id` / `pin_color_field_id` / `popup_*_field_id` / `popup_shown_field_ids` for the map. Whatever the admin configures in the **Card Builder** and **Maps Builder**, the website renders identically — same wiring path as the CRM's `CardView` and `MapsView`.
- **Map info-window card design.** Pixel-port of "Variation B — البطاقة المدمجة" from the Claude Design handoff (`maps-card/project/`). 320px white card, copper-tinted status pill with colored option dot, 20px Amiri title in brown, location row with copper map-pin icon, 3-column cream chip grid for stats, dashed-top footer with price block + copper "فتح السجل" CTA. Card frame, tail pointer, hover lift, and tokens are exact ports of `cards.css` `.cp-card`.
- **Per-slot field selection.** A "بطاقة الخريطة / Map Card" section on `site_settings` exposes 6 dropdowns the admin uses to pin which `all_projects` field populates each slot in the website's map card: status pill, chips 1–3, footer price, CTA URL. Dropdown options are snapshotted from the `all_projects` schema at migration time. Empty selections fall through to website-side heuristics (first 3 popup_shown_field_ids → chips, label-match `سعر|تكلف` → price, first URL field → CTA), so the migration is non-breaking.
- **Same map mechanics + style as the CRM.** Project locations come from whatever URL/text field `maps_config.location_url_field_id` points at — currently the existing "موقع المشروع" field in "المعلومات الجغرافية". The website parses with the same logic as `src/lib/locationUtils.ts` (long-form `@lat,lng` URLs, `?q=lat,lng`, bare `lat,lng`). It also applies `maps_config.map_style_json` as the map's `styles`, honors `default_center_lat/lng` and `default_zoom`, and loads the API with `language=ar&region=SA` to match `src/lib/mapsLoader.ts`. Short `goo.gl` links don't resolve on the website (no edge function for redirect-following).
- **Two website-only fields on `all_projects`** in their own non-base section: `image_url` (hero photo for cards / map info windows — `image` field type, drop-zone uploader to the `marketing-assets` Storage bucket, stores public URL) and `is_public`.
- **Lookup-target reading on the website.** `formatFieldValue` resolves `lookup` fields by looking up the linked record in `ctx.lookupTargets[lookup_model_id]` and pulling out `lookup_display_field` — same logic as the CRM's `MapsView` resolver. RLS lets anon read those records (and the lookup-target model row for the schema), gated by `wassell_is_public_lookup_target(record_id, model_id)` and `wassell_public_lookup_model_ids()` SECURITY DEFINER helpers so the cross-table predicate doesn't recurse on itself.
- **Sticky overrides on the map card.** When the admin's Map Card pick is set in `site_settings` but the record has no value (e.g. a lookup whose target doesn't exist, or a blank field), the slot stays empty rather than falling through to a heuristic. Hides the heuristic-substitution-looks-like-a-bug behavior.
- **Live data, no rebuild.** The website's JS reads directly from Supabase via the anon key. Toggling `is_public` on a project, editing its name, or changing the hero copy in `site_settings` is reflected on the next page load.
- **Singleton config record.** `site_settings` is a system model with one record holding hero copy, contact info, social links, working hours, and the WhatsApp number. The website always reads the first record.
- **Narrow public RLS.** The `anon` role can SELECT only:
  - `records` rows where the model is `site_settings` (always) OR `all_projects` AND `is_public = true`.
  - `models` rows for those two models (so the website can resolve dropdown option labels like city / status).
  - Everything else stays gated by the existing `wassell_can_view_record` policy for authenticated traffic.

## User flows
1. **Admin publishes a project (happy path):**
   1. Open the project in the CRM record form.
   2. Make sure the existing "موقع المشروع" field has a Google Maps URL (long form or `?q=lat,lng`) so the project will appear on the map.
   3. Scroll to the "إعدادات الموقع" section. Fill in `image_url` and tick **عرض على الموقع**.
   4. Save. The project appears on the public site within a few seconds (no caching beyond the browser tab).
2. **Admin updates site copy:**
   1. Open the singleton record in the **إعدادات الموقع / Website Settings** model.
   2. Edit hero title, description, contact info, social URLs, hours, etc.
   3. Save. Public pages pick up the change on next reload.
3. **Admin redesigns the map card:**
   1. Open `/settings` → click **إعدادات الموقع / Website Settings**.
   2. Scroll to the "بطاقة الخريطة / Map Card" section.
   3. Pick the projects-model field for each slot (status pill, البطاقة الأولى/الثانية/الثالثة, price, CTA URL) from its dropdown. Leave any slot blank to fall back to heuristics.
   4. Save. The next pin click on the public map renders the new layout.

**Settings-page integration:** `site_settings` is hidden from the regular Sidebar by name (`Sidebar.tsx` `SETTINGS_ONLY_MODEL_NAMES`) — the only entry point is the **Website Settings** card on `/settings`, which routes through `/settings/website`. That route hydrates the singleton record from the store and redirects into `/model/site_settings/<id>` so the standard record form renders. New tenants land on `/model/site_settings/new` and the form creates the singleton on first save.
3. **Visitor browses projects:**
   1. Open `/projects.html`.
   2. Filter by city, status, or free-text search.
   3. Click "View on map" → jumps to `/map.html#project-<id>`, the map flies to the pin and opens its info window.
4. **Empty / error states:**
   - No published projects → the projects page shows a "no projects match" empty state.
   - Network failure or bad keys → an error card with a message; the homepage falls back to the static copy in `index.html`.

## Data touched
- **Reads (anon):**
  - `models` rows where `name IN ('all_projects', 'site_settings')`.
  - `records` rows where `model_id = site_settings.id` OR `(model_id = all_projects.id AND data->>'is_public' = 'true')`.
- **Writes (authenticated/CRM only):** `records.data` JSONB for both models, via the standard `record_save` RPC. No special path.
- **Schema-time changes (one-shot in migrations):**
  - `models.schema` JSONB on `all_projects` — `image_url` and `is_public` live in a new non-base "إعدادات الموقع / Website Settings" section.
  - `models.maps_config` JSONB on `all_projects` — `location_url_field_id` set to the existing "موقع المشروع" URL field in the "المعلومات الجغرافية" section. Pin/popup wiring (title, label, color, badge, subtitle, shown fields) was tuned by the admin in the Maps Builder before this work; the migration leaves their tuning intact.
  - `models` insert — new `site_settings` row.
  - `models.schema` JSONB on `site_settings` — appended a "بطاقة الخريطة / Map Card" section with 6 dropdown fields (`card_status_field`, `card_chip1_field`, `card_chip2_field`, `card_chip3_field`, `card_price_field`, `card_cta_url_field`). Each dropdown's options are a snapshot of the `all_projects` field list at migration time.
  - `records` insert — one default `site_settings` record matching the original static homepage copy.
  - `pg_policies` — two new `TO anon` SELECT policies (`records_public_website_read`, `models_public_website_read`).
  - `GRANT SELECT ON public.records, public.models TO anon`.

## Key files
| File | What it does |
|---|---|
| `src/data/seedModels.ts` | Defines the `all_projects` fields (incl. `is_public`, `image_url`, `location_url`) and the `site_settings` system model so fresh installs match production. |
| `supabase/migrations/2026-05-09_j_website_integration.sql` | The one-shot migration that added the new fields, created `site_settings`, wired `maps_config`, and opened the public-read RLS window. Idempotent. |
| `src/lib/locationUtils.ts` | Google Maps URL parser. The website's `wassel-data.js` mirrors this so locations resolve identically. |
| (External repo) `Wassel Website/projects.html` | Public projects grid + filters. |
| (External repo) `Wassel Website/map.html` | Public Google Maps with clustered pins + sidebar. |
| (External repo) `Wassel Website/index.html` | Public homepage; hero/contact/social hydrate from `site_settings`. |
| (External repo) `Wassel Website/js/wassel-data.js` | Supabase client wrapper, schema helpers, project shaper. |

## Open questions / known limitations
- **Short Google Maps URLs (`goo.gl/maps`)** don't resolve on the website. The CRM has `/api/resolve-maps-url` for this; the website doesn't. Workaround: paste the long-form URL or raw `lat,lng`.
- **Singleton enforcement on `site_settings`** is a convention, not a constraint. If an admin creates a second record, the website silently uses whichever one comes back first by `created_at DESC`.
- **No image upload — `image_url` is a URL field.** Admins paste a hosted image URL (from a CDN, a project's listing site, etc.). A future iteration could upload to Supabase Storage from inside the form.
- **No site-wide cache.** The website fetches fresh on every page load. Fine at the current scale (1,366 projects total, far fewer published); revisit if traffic grows.
- **Authenticated CRM users see all projects regardless of `is_public`** — the website's filter only applies to the `anon` policy. This is intentional.
