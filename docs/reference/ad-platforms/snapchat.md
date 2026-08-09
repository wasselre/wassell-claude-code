# Snapchat Marketing API — Campaign Creation Field Reference

Researched against the official docs at `developers.snap.com/api/marketing-api/Ads-API/*` (campaigns, ad-squads, targeting, ads, creatives, media, audience-creation). Base endpoint: `https://adsapi.snapchat.com/v1`. All monetary values are **micro-currency** (amount × 1,000,000). All entity creation is array-wrapped (`{"campaigns":[{...}]}`, `{"adsquads":[{...}]}`, etc.). Names are capped at **375 chars** across all levels.

---

## 1. Campaign

`POST /v1/adaccounts/{ad_account_id}/campaigns`
Source: https://developers.snap.com/api/marketing-api/Ads-API/campaigns

| Field | Type | Req | Allowed values / notes |
|---|---|---|---|
| `ad_account_id` | UUID | R | Owning ad account |
| `name` | string | R | Max 375 chars |
| `status` | enum | R | `ACTIVE`, `PAUSED` |
| `start_time` | ISO 8601 | R | Launch time |
| `end_time` | ISO 8601 | O | Must be after start_time |
| `objective_v2_properties` | object | O | `{ objective_v2_type, promotion_type }` — see below |
| `buy_model` | enum | O | `AUCTION` (default), `RESERVED` |
| `daily_budget_micro` | int | O | Min 20,000,000 ($20) — campaign-level daily cap |
| `lifetime_spend_cap_micro` | int | O | Min 20,000,000 — total campaign spend limit |
| `pacing_level` | enum | R | `AD_SQUAD` (normal), `CAMPAIGN` (Smart Budgets / CBO) |
| `measurement_spec` | object | O* | `{"ios_app_id":"...", "android_app_url":"..."}` — **required** for app-install / deep-link ad campaigns |
| `mobile_app_properties` | object | O | SKAdNetwork enrollment: `skad_network_status`, `mobile_app_id`, `app_optimization_type` |
| `shared_properties` | object | R if `pacing_level=CAMPAIGN` | `shared_optimization_goal`, `shared_ad_squad_bid_strategy`, `shared_pixel_id`, `shared_conversion_window` |
| `regulations` | object | O | CHE compliance (Credit/Housing/Employment) |
| `product_properties` | object | O | Dynamic Ads catalog attachment |
| `delivery_status`, `creation_state`, `auto_bid_max_bid_micro` | — | RO | Read-only |

**`objective_v2_type` (current consolidated objectives — confirmed):** `AWARENESS_AND_ENGAGEMENT` · `TRAFFIC` · `LEADS` · `APP_PROMOTION` · `SALES`

**`promotion_type`:** `PROMOTE_PLACES`, `PROMOTE_SHOWS`, `APP_INSTALL`, `APP_REENGAGEMENT` (e.g. APP_PROMOTION + APP_INSTALL vs APP_REENGAGEMENT)

---

## 2. Ad Squad

`POST /v1/campaigns/{campaign_id}/adsquads`
Source: https://developers.snap.com/api/marketing-api/Ads-API/ad-squads

**Important:** ad squad `type` is **`SNAP_ADS` | `LENS` | `FILTER`** — `STORY` is *not* an ad-squad type (Story is an **ad** type inside a SNAP_ADS squad).

### 2.1 Core fields

| Field | Type | Req | Allowed values / notes |
|---|---|---|---|
| `campaign_id` | UUID | R | |
| `name` | string | R | Max 375 chars |
| `type` | enum | R | `SNAP_ADS`, `LENS`, `FILTER` |
| `status` | enum | O | `ACTIVE` (default), `PAUSED` |
| `billing_event` | enum | R | `IMPRESSION` (the only current value) |
| `bid_strategy` | enum | R | `AUTO_BID`, `LOWEST_COST_WITH_MAX_BID`, `TARGET_COST`, ~~`MIN_ROAS`~~ (**deprecated 2025-02-10**) |
| `bid_micro` | int | R w/ max-bid & target-cost | USD range ≈ 10,000–500,000,000; currency-specific min/max |
| `roas_value_micro` | int | — | 10,000–100,000,000 (MIN_ROAS only — deprecated) |
| `optimization_goal` | enum | R | See full list below |
| `daily_budget_micro` | int | R (one of) | Min 5,000,000; mutually exclusive with lifetime |
| `lifetime_budget_micro` | int | R (one of) | Min 5,000,000 |
| `delivery_constraint` | enum | R | `DAILY_BUDGET`, `LIFETIME_BUDGET`, `REACH_AND_FREQUENCY` |
| `start_time` / `end_time` | ISO 8601 | O | e.g. `"2023-11-28T14:35:55.000Z"` |
| `pacing_type` | enum | O | `STANDARD` (default), `ACCELERATED` — immutable once set; ACCELERATED requires `LOWEST_COST_WITH_MAX_BID` |
| `targeting` | object | R | See §2.3 |
| `placement_v2` | object | R | See §2.2 |
| `conversion_window` | enum | O | `SWIPE_28DAY_VIEW_1DAY` (default), `SWIPE_7DAY` |
| `pixel_id` | UUID | O | Conversion pixel (required for PIXEL_* goals) |
| `event_sources` | object | O | `{"MOBILE_APP":["<snap_app_id>"]}` — required for SKAdNetwork / app-install-state targeting |
| `child_ad_type` | enum | O | Locks the ad type: `SNAP_AD`, `LONGFORM_VIDEO`, `APP_INSTALL`, `REMOTE_WEBPAGE`, `DEEP_LINK`, `STORY`, `AD_TO_LENS`, `AD_TO_CALL`, `AD_TO_MESSAGE`, `FILTER`, `LENS`, `LENS_WEB_VIEW`, `LENS_APP_INSTALL`, `LENS_DEEP_LINK`, `LENS_LONGFORM_VIDEO`, `COLLECTION` |
| `story_ad_creative_type` | enum | R for Dynamic Story Ads | `APP_INSTALL`, `WEB_VIEW`, `DEEP_LINK` |
| `cap_and_exclusion_config` | object | O | Frequency cap + exclusion spec; incompatible with multi-format delivery in Auction campaigns |
| `ad_scheduling_config` | object | O | Dayparting schedule |
| `brand_safety_config` | object | O | `inventory_option`: `FULL_INVENTORY` (default), `LIMITED_INVENTORY` |
| `forced_view_setting` | enum | O | `FULL_DURATION`, `SIX_SECONDS`, `NONE` (Commercials eligibility) |
| `measurement_provider_names` | array | O | `DOUBLEVERIFY` |
| `reach_and_frequency_status` | enum | R for R&F | `PENDING` |
| `reach_goal` / `impression_goal` | int | R w/ `REACH_AND_FREQUENCY` | |
| `skadnetwork_properties` | object | O | `enroll_action`: `OPT_IN`/`OPT_OUT`; `ecid_enroll_action`: `ATTACH`/`DETACH`; `enable_skoverlay`: bool; `status` (RO): `ENROLLED`/`NEVER_ENROLLED`/`WITHDRAWN` |
| `id`, `created_at`, `updated_at`, `delivery_status`, `targeting_reach_status`, `creation_state`, `separated_types`, `deleted` | — | RO | |

**`optimization_goal` full enum:** `IMPRESSIONS`, `SWIPES`, `APP_INSTALLS`, `VIDEO_VIEWS`, `VIDEO_VIEWS_15_SEC`, `USES`, `STORY_OPENS`, `PIXEL_PAGE_VIEW`, `PIXEL_ADD_TO_CART`, `PIXEL_PURCHASE`, `PIXEL_SIGNUP`, `LANDING_PAGE_VIEW`, `LEAD_FORM_SUBMISSIONS`, `APP_ADD_TO_CART`, `APP_PURCHASE`, `APP_SIGNUP`, `APP_REENGAGE_OPEN`, `APP_REENGAGE_PURCHASE`

### 2.2 placement_v2

| Field | Type | Req | Values |
|---|---|---|---|
| `config` | enum | R | `AUTOMATIC`, `CUSTOM` |
| `platforms` | array | R if CUSTOM | `SNAPCHAT` |
| `snapchat_positions` | array | R if CUSTOM | `INTERSTITIAL_USER`, `INTERSTITIAL_CONTENT`, `INTERSTITIAL_SPOTLIGHT`, `INSTREAM`, `PUBLIC_STORIES_INSTREAM`, `CHAT_FEED`, `FEED`, `CAMERA`, `POST_CAPTURE_CAROUSEL` |
| `inclusion` / `exclusion` | object | O | Content types: `NEWS`, `ENTERTAINMENT`, `SCIENCE_TECHNOLOGY`, `BEAUTY_FASHION`, `MENS_LIFESTYLE`, `WOMENS_LIFESTYLE`, `GAMING`, `GENERAL_LIFESTYLE`, `FOOD`, `SPORTS`, `YOUNG_BOLD` |

### 2.3 Targeting spec

Source: https://developers.snap.com/api/marketing-api/Ads-API/targeting
Logic: **fields within one object = AND; objects within an array = OR; EXCLUDE always ANDs and applies last.** Compact style (multiple ids per node) is the default since 2025-09-23 (`targeting_v2=ENABLED` on reads).

Top-level keys: `demographics[]`, `geos[]`, `interests[]`, `devices[]`, `segments[]`, `locations[]`, `app_install_states[]`, `regulated_content` (bool, default false), `enable_targeting_expansion` (bool), `auto_expansion_options`.

**Geos** (each entry carries `operation`: `INCLUDE` | `EXCLUDE`):
- Country: `{"country_code":"us"}` — ISO ALPHA-2 lowercase (`"sa"` for Saudi)
- Region/state: `{"country_code":"us","region_id":["5"]}`
- Metro/DMA (US): `{"country_code":"us","metro_id":["557"]}`
- Postal code: `{"country_code":"us","postal_code":["20622"]}`

**Locations** (radius / POI):
- Circles: `{"circles":[{"latitude":47.61,"longitude":-122.33,"radius":500,"unit":"METERS"}]}` — max **500 circles**/squad, radius **96–100,000 m**, units `METERS` (default) / `KILOMETERS` / `FEET` / `MILES`
- Location categories: `{"categories_loi":["LOI_1000"],"proximity":500,"proximity_unit":"METERS"}`

**Demographics:**
- `age_groups`: `"13-17"`, `"18-20"`, `"21-24"`, `"25-34"`, `"35+"`
- `min_age` (13–35) / `max_age` (13–55, omit for uncapped) — passed as strings, e.g. `{"min_age":"18"}`
- `gender`: `MALE`, `FEMALE`, `OTHER`
- `languages`: `[{"id":"en"}]`, `[{"id":"ar"}]` (ISO codes)
- Advanced demographics `DLXD_*` — **deprecated since 2024-09-27**

**Interests** (`{"category_id":[...], "operation":"INCLUDE"}`):
- `SLC_*` — Snap Lifestyle Categories (primary, hierarchical)
- `VAC_*` — Snap visitation segments; `SHP_*` — Snap shopper segments
- `NLN_*` — Nielsen; `PLC_*` — Placed visitation
- `DLXS_*`/`DLXC_*`/`DLXP_*` — Oracle Datalogix, **deprecated 2024-09-27** (don't build these into a new form)

**Devices:**
- `connection_type`: `WIFI`, `CELL`
- `os_type`: `iOS`, `ANDROID`, `WEB`
- `os_version_min` / `os_version_max`: `"10.0"`
- `carrier`: e.g. `US_ATT`
- `marketing_name` (make/model, hierarchical): `"Apple/"`, `"Apple/iPhone 7 Plus/"`

**Segments (custom audiences):** `{"segment_id":["5052756160240353"],"operation":"INCLUDE"|"EXCLUDE"}`

**Auto-expansion:** `auto_expansion_options` = `{ interest_expansion_option:{enabled}, custom_audience_expansion_option:{enabled}, auto_expansion_type:"SMART_TARGETING" (needs both enabled), demographic_expansion_option:{suggested_min_age:13–55} }`. `regulated_content:true` disables parts of expansion.

### 2.4 Audience segments (SAM / lookalikes) — for the custom-audience picker

Sources: https://developers.snap.com/marketing-api/Ads-API/audience-creation/customer-lists , /audience-creation/lookalikes

- Segment: `name` (R, ≤375), `description`, `ad_account_id` (R), `source_type` (R): `FIRST_PARTY` (Customer List/SAM), `ENGAGEMENT`, `PIXEL`, `MOBILE`, `FOOT_TRAFFIC_INSIGHTS`, `LOOKALIKE`; `retention_in_days` (R, lifetime = `9999`, lookalike max 180).
- Uploads: schemas `EMAIL_SHA256`, `PHONE_SHA256`, `MOBILE_AD_ID_SHA256` (normalized + SHA-256, ≤100k ids/request). Statuses: `upload_status` `NO_UPLOAD/PROCESSING/COMPLETE`; `targetable_status` `NOT_READY/TOO_FEW_USERS/READY`.
- Lookalike `creation_spec`: `seed_segment_id` (R), `countries` (R, ISO-2 list), `type`: `BALANCE` (default), `SIMILARITY`, `REACH`.

---

## 3. Ad

`POST /v1/adsquads/{ad_squad_id}/ads`
Source: https://developers.snap.com/api/marketing-api/Ads-API/ads

| Field | Type | Req | Values / notes |
|---|---|---|---|
| `ad_squad_id` | UUID | R | |
| `creative_id` | UUID | R | Ad type must match creative type |
| `name` | string | R | Max 375 |
| `type` | enum | R | `SNAP_AD`, `APP_INSTALL`, `REMOTE_WEBPAGE`, `DEEP_LINK`, `STORY`, `AD_TO_LENS`, `AD_TO_CALL`, `AD_TO_MESSAGE`, `FILTER`, `LENS`, `LENS_WEB_VIEW`, `LENS_APP_INSTALL`, `LENS_DEEP_LINK`, `COLLECTION`, `LEAD_GENERATION`, `REMINDER` |
| `status` | enum | R | `ACTIVE`, `PAUSED` |
| `paying_advertiser_name` | string | O | Political/paying entity |
| `third_party_paid_impression_tracking_urls` | array | O | Fired on impression |
| `third_party_on_swipe_tracking_urls` | array | O | Fired on attachment swipe |
| `review_status` (`PENDING/APPROVED/REJECTED`), `review_status_reasons`, `delivery_status`, `deleted` | — | RO | |

---

## 4. Creative

`POST /v1/adaccounts/{ad_account_id}/creatives`
Source: https://developers.snap.com/api/marketing-api/Ads-API/creatives

### 4.1 Core fields

| Field | Type | Req | Values / notes |
|---|---|---|---|
| `ad_account_id` | UUID | R | |
| `name` | string | R | Max 375 |
| `type` | enum | R | `SNAP_AD`, `APP_INSTALL`, `WEB_VIEW`, `DEEP_LINK`, `AD_TO_LENS`, `AD_TO_CALL`, `AD_TO_MESSAGE`, `PREVIEW`, `COMPOSITE`, `LENS`, `LENS_WEB_VIEW`, `LENS_APP_INSTALL`, `LENS_DEEP_LINK`, `COLLECTION`, `LEAD_GENERATION`, `REMINDER` |
| `headline` | string | R | **Max 34 chars** — shown under brand name |
| `brand_name` | string | O | **Max 32 chars** |
| `top_snap_media_id` | UUID | R | The 9:16 media |
| `top_snap_crop_position` | enum | O | `OPTIMIZED` (default), `MIDDLE`, `TOP`, `BOTTOM` |
| `shareable` | bool | O | Default true |
| `call_to_action` | enum | O | Type-dependent — §4.2 |
| `forced_view_eligibility` | enum | O | `FULL_DURATION`, `SIX_SECONDS`, `NONE` |
| `profile_properties` | object | O | `{ "profile_id": UUID }` — public profile association |
| `favorite_display_mode` | enum | O | `SHOW`, `HIDE` |
| `ad_product` | enum | O | `SNAP_AD` (default), `LENS`, `FILTER` |

### 4.2 call_to_action enums by type

- **APP_INSTALL / LENS_APP_INSTALL:** BOOK_NOW, DONATE, DOWNLOAD, GET_NOW, INSTALL_NOW, ORDER_NOW, PLAY, SHOP_NOW, SIGN_UP, TRY, USE_APP, WATCH, VOTE, DIRECTIONS, PLAY_GAME
- **DEEP_LINK / LENS_DEEP_LINK:** DONATE, PLAY, SHOP_NOW, SIGN_UP, USE_APP, MORE, OPEN_APP, TRY, WATCH, VIEW_PROFILE, VOTE, DIRECTIONS, PRE_REGISTER, PLAY_GAME, DOWNLOAD
- **WEB_VIEW / LENS_WEB_VIEW:** APPLY_NOW, MORE, ORDER_NOW, PLAY, READ, SHOP_NOW, SHOW, SIGN_UP, VIEW, WATCH, DONATE, DOWNLOAD, RESPOND, BUY_TICKETS, SHOWTIMES, BOOK_NOW, GET_NOW, LISTEN, TRY, VOTE, VIEW_MENU, PRE_REGISTER, PLAY_GAME
- **AD_TO_LENS:** PLAY, TRY, SHOP_NOW, VOTE · **AD_TO_MESSAGE:** MESSAGE_NOW, OPEN_APP · **AD_TO_CALL:** CALL_NOW, OPEN_APP · **REMINDER:** REMIND_ME

### 4.3 Attachment property objects

- **`web_view_properties`** (WEB_VIEW/LENS_WEB_VIEW/COLLECTION fallback): `url` (R, ≤2048 chars, SSL), `block_preload` (default false), `allow_snap_javascript_sdk`, `use_immersive_mode`, `web_browser_type: "SNAP"`.
- **`app_install_properties`**: `app_name` (R, ≤30), `ios_app_id` OR `android_app_url` (≥1 required), `icon_media_id` (R, 1:1 PNG), `enable_skoverlay`, `ios_app_end_card_media_ids` / `android_app_end_card_media_ids` (2–10 UUIDs), `product_page_id`, `playable_media_properties { playable_media_id, playable_call_to_action: "TRY_IT_OUT" }`.
- **`deep_link_properties`**: `deep_link_uri` (R), `app_name` (R, ≤30), `ios_app_id`/`android_app_url` (≥1), `icon_media_id` (R), `fallback_type`: `APP_INSTALL` (default) | `WEB_SITE`, `web_view_fallback_url`, `product_page_id`.
- **`ad_to_lens_properties`**: `lens_media_id` (R). **`ad_to_call_properties`**: `phone_number_id` (R). **`ad_to_message_properties`**: `phone_number_id` (R), `message` (≤160).
- **`preview_properties`** (PREVIEW — the Story-Ad tile): `preview_media_id` (R), `logo_media_id`, `preview_headline` (R, ≤55).
- **`composite_properties`** (COMPOSITE): `creative_ids` (R, 1–20 child creatives of SNAP_AD/APP_INSTALL/WEB_VIEW/DEEP_LINK) + `preview_creative_id` referencing the PREVIEW creative. **A Story Ad = ad type `STORY` → COMPOSITE creative → PREVIEW creative + children.**
- **`collection_properties`** (COLLECTION): `interaction_zone_id` (R — the thumbnail strip is a separate Interaction Zone entity), `default_fallback_interaction_type` (R): `WEB_VIEW` | `DEEP_LINK` | `APP_INSTALL`, plus the matching properties object.
- **`lead_generation` creatives**: require `lead_generation_form_id` (form built via the Lead Generation Ads guide).
- **`chat_properties`** (WEB_VIEW/APP_INSTALL/COMPOSITE): `wallpaper_media_id`, `additional_messages[] {chat_message_type:"TEXT", text ≤500}`, `default_responses[] {chat_message_type: TEXT|EXTERNAL_MEDIA_MESSAGE, text|media_id}`, `response_interaction_setting`: `NO_USER_INPUT` | `SEND_DEFAULT_UNLIMITED`.
- **`ar_extension_properties`** (APP_INSTALL/WEB_VIEW): `lens_media_id` (R), `product_info_card_display_mode`: `HIDE` (default)|`SHOW`, `ar_extension_button_text`: `TRY_ON`|`AR_LENS`, `ar_extension_button_color_theme`: `DARK_GRAY`|`LIGHT_GRAY`.
- **`reminder_properties`** (REMINDER): `event_detail_id` (R).

### 4.4 Media requirements

Source: https://developers.snap.com/api/marketing-api/Ads-API/media
Media object: `name` (R), `type` (R): `VIDEO` | `IMAGE` | `LENS_PACKAGE` | `PLAYABLE`, `ad_account_id` (R).

| Asset | Spec |
|---|---|
| Top Snap video | 1080×1920 (9:16), mp4/mov, 3 s–1800 s, ≤32 MB (≤1 GB chunked: 32 MB × 32 chunks) |
| Top Snap image | 1080×1920, PNG/JPG, ≤5 MB |
| App icon | 1:1, 200–2000 px, PNG |
| Preview (Story tile) image | 3:5, min 360×600, PNG, ≤2 MB |
| App end card | 1080×1920 or 1920×1080, JPG/PNG, ≤1 MB |
| Playable (ZIP) | ≤5 MB |

---

## Key facts to encode in the CRM form

1. **Objectives are the consolidated 5** (`objective_v2_type`): AWARENESS_AND_ENGAGEMENT, TRAFFIC, LEADS, APP_PROMOTION, SALES — set via `objective_v2_properties`, optionally with `promotion_type`.
2. **Ad squad type ≠ STORY** — squads are SNAP_ADS/LENS/FILTER; Story/Collection/etc. are ad+creative types under SNAP_ADS.
3. **MIN_ROAS bid strategy is deprecated** (Feb 2025); Oracle/Datalogix targeting (DLX*) is deprecated (Sept 2024) — omit both from a new form.
4. **Budgets:** campaign min $20/day; ad squad min 5,000,000 micro; daily vs lifetime budget mutually exclusive and must match `delivery_constraint`.
5. **billing_event is always IMPRESSION**; bid_micro only needed for LOWEST_COST_WITH_MAX_BID/TARGET_COST.
6. Country codes in geo targeting are **lowercase** ISO-2 (`"sa"`); lookalike `countries` are uppercase ISO-2.
7. Char limits: name 375 (all levels), headline 34, brand_name 32, app_name 30, web URL 2048, ad_to_message 160.
8. The frequency-cap object (`cap_and_exclusion_config`) and `ad_scheduling_config` exist but their sub-structure isn't published on the public ad-squads page — verify against a live API GET if needed.
