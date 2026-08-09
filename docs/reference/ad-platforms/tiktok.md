# TikTok Marketing API — Campaign Creation Field Reference (v1.3)

Researched 2026-08-09 from the live TikTok API for Business portal (business-api.tiktok.com/portal/docs).

**API base:** `https://business-api.tiktok.com/open_api/v1.3/` — all create endpoints are `POST` with header `Access-Token` (required) + `Content-Type: application/json`. All IDs are **strings** in v1.3.

**Hierarchy:** Campaign → Ad Group → Ad. Each ad account: up to 999 campaigns. Each ad group: up to 50 regular ads (20 for `RF_REACH`; 20 for `PRODUCT_SALES` with product source STORE, 50 with CATALOG).

**Sources (all verified live 2026-08-09):**
- Campaign create: https://business-api.tiktok.com/portal/docs?id=1739318962329602
- Ad group create: https://business-api.tiktok.com/portal/docs?id=1739499616346114
- Ad create: https://business-api.tiktok.com/portal/docs?id=1739953377508354
- Advertising objectives: https://business-api.tiktok.com/portal/docs?id=1737585562434561
- Enumerations appendix: https://business-api.tiktok.com/portal/docs?id=1737174886619138
- Conversion events: https://business-api.tiktok.com/portal/docs?id=1739361474981889
- Upgraded Smart+ guides: https://business-api.tiktok.com/portal/docs/create-an-upgraded-smart-dc-app-campaign/v1.3

---

## 1. Campaign — `POST /campaign/create/`

### 1.1 Request fields

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `advertiser_id` | string | **Required** | Ad account ID. |
| `campaign_name` | string | **Required** | ≤512 chars, no emoji. CJK chars count as 2. Duplicate names allowed only with distinct `request_id`. |
| `objective_type` | string | **Required** | See §1.2. Cannot be changed after creation. |
| `app_promotion_type` | string | Conditional — required when `objective_type=APP_PROMOTION` | `APP_INSTALL`, `APP_RETARGETING`, `APP_PREREGISTRATION` (allowlist). Only `APP_INSTALL` may be used in an iOS14 Dedicated Campaign. |
| `virtual_objective_type` | string | Optional | `SALES` — the merged "Sales" objective (combines Website Conversions + Product Sales). Must pass `sales_destination` with it. |
| `sales_destination` | string | Conditional — required iff `virtual_objective_type` set | `TIKTOK_SHOP`, `WEBSITE`, `APP` (catalog required), `WEB_AND_APP` (allowlist). |
| `is_search_campaign` | boolean | Optional | `true` = Search Ads Campaign (keywords, search results page). Allowlist. Immutable after set. |
| `campaign_type` | string | Optional | `REGULAR_CAMPAIGN` (default), `IOS14_CAMPAIGN`. `IOS14_CAMPAIGN` only supports `PRODUCT_SALES` or `APP_PROMOTION`+`APP_INSTALL`. |
| `app_id` | string | Conditional — required for iOS14 Dedicated Campaigns | App ID from `/app/list/`. |
| `is_advanced_dedicated_campaign` | boolean | Optional | Default `false`. Advanced Dedicated Campaign (real-time signals). Immutable. |
| `disable_skan_campaign` | boolean | Optional (allowlist) | Valid only for APP_PROMOTION+APP_INSTALL+IOS14_CAMPAIGN with an eligible app. Immutable. |
| `campaign_app_profile_page_state` | string | Optional | `ON`, `OFF` (default). Only for APP_PROMOTION iOS14 Dedicated Campaigns. |
| `rf_campaign_type` | string | Optional (allowlist) | Only when `objective_type=RF_REACH`: `STANDARD` (Reach & Frequency), `PULSE` (TikTok Pulse — fixed CPM). Immutable. |
| `campaign_product_source` | string | Conditional — required when `objective_type=PRODUCT_SALES` | `CATALOG`, `STORE` (TikTok Shop / Showcase). Constrains ad-group `product_source`. |
| `catalog_enabled` | boolean | Optional | Default `false`. Set `true` for Automotive Ads. Auto-forced `true` when PRODUCT_SALES+CATALOG. Immutable. |
| `request_id` | string | Optional | String of a 64-bit int. Enables duplicate names + 10-second idempotency. |
| `special_industries` | string[] | Optional | **`HOUSING`** (real estate listings, homeowners insurance, mortgage loans), **`EMPLOYMENT`**, **`CREDIT`**. Declaring one restricts ad-group targeting (no zip targeting, no saved audiences, restricted age/gender). Generally available to advertisers registered in the US/Canada; others targeting the US/Canada need an allowlist. Can later be removed but not changed. |
| `budget_optimize_on` | boolean | Optional | `true` enables Campaign Budget Optimization (CBO): budget auto-allocated across ad groups; ad-group budgets ignored; first ad group fixes `bid_type`/`optimization_goal`/`optimization_event` for siblings. |
| `budget_mode` | string | Conditional — required unless `objective_type=RF_REACH` (only `BUDGET_MODE_INFINITE`) | CBO on: `BUDGET_MODE_TOTAL`, `BUDGET_MODE_DYNAMIC_DAILY_BUDGET`. CBO off: `BUDGET_MODE_INFINITE`, `BUDGET_MODE_TOTAL`, `BUDGET_MODE_DAY`. `BUDGET_MODE_DYNAMIC_DAILY_BUDGET` = avg daily budget over a week; daily spend ≤125% of it, weekly ≤7×. |
| `budget` | float | Conditional — required when `budget_mode` is DAY / DYNAMIC_DAILY / TOTAL | Minimums vary by currency. |
| `rta_id` / `rta_bid_enabled` / `rta_product_selection_enabled` | — | Optional (allowlist) | Realtime API strategy. |
| `operation_status` | string | Optional | `ENABLE` (default), `DISABLE`. R&F campaigns must not be created DISABLE. |
| `postback_window_mode` | string | Optional | iOS14 SKAN 4.0: `POSTBACK_WINDOW_MODE1` (default) / `MODE2` / `MODE3`. Immutable. |
| `po_number` | string | Optional | Purchase-order number for invoices. |

**Deprecated in v1.3 (do not model):** `budget_optimize_switch`, `bid_type`, `deep_bid_type`, `roas_bid`, `optimize_goal` at campaign level (moved to ad group).

**Response-only fields worth mirroring:** `campaign_id`, `create_time`, `modify_time`, `secondary_status`, `is_smart_performance_campaign`, `bid_align_type` (`SAN`|`SKAN`), `is_new_structure`, `objective` (`APP` | `LANDING_PAGE`).

### 1.2 `objective_type` — full current enum

**Creatable Auction objectives:**

| Value | Ads-Manager name | Notes |
|---|---|---|
| `REACH` | Reach | |
| `TRAFFIC` | Traffic | |
| `VIDEO_VIEWS` | Video views | |
| `LEAD_GENERATION` | Lead generation | Instant Form / website form / DM / IM apps / calls |
| `ENGAGEMENT` | Community interaction | Follows + profile visits |
| `APP_PROMOTION` | App promotion | With `app_promotion_type` sub-mode |
| `WEB_CONVERSIONS` | Website conversions | |
| `PRODUCT_SALES` | Product sales | Shopping Ads; partially allowlisted |
| *(virtual)* `SALES` | Sales | Not a real `objective_type` — set `virtual_objective_type=SALES` + `sales_destination` |

**Reservation objectives:** `RF_REACH` (allowlisted), `TOPVIEW_REACH` (read-only via API).

**Deprecated / read-only:** `APP_INSTALL`, `CONVERSIONS`, `CATALOG_SALES`, `SHOP_PURCHASES`, `RF_APP_INSTALL`, `RF_ENGAGEMENT`, `RF_TRAFFIC`, `RF_VIDEO_VIEW`, `BRAND_CONSIDERATION` (GET-only filter).

---

## 2. Ad Group — `POST /adgroup/create/`

> If `special_industries` was set on the campaign (HOUSING etc.), the ad group must meet restricted-targeting requirements: **no zip/postal-code targeting, no `saved_audience_id`**, and restricted age/gender.

### 2.1 Identity / structure

| Field | Type | Required | Notes |
|---|---|---|---|
| `advertiser_id` | string | **Required** | |
| `campaign_id` | string | **Required** | |
| `adgroup_name` | string | **Required** | ≤512 chars, no emoji. |
| `request_id` | string | Optional | Idempotency. |

### 2.2 Promotion type / destination

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `promotion_type` | string | Conditional — required unless objective is REACH / VIDEO_VIEWS / ENGAGEMENT | `WEBSITE`, `APP_ANDROID`, `APP_IOS`, `LEAD_GENERATION`, `LEAD_GEN_CLICK_TO_TT_DIRECT_MESSAGE`, `LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE` (IM apps), `LEAD_GEN_CLICK_TO_CALL` (allowlist), `WEBSITE_OR_DISPLAY` (only Reach/VideoViews/Engagement), `TIKTOK_SHOP`, `VIDEO_SHOPPING`, `LIVE_SHOPPING`, `PSA_PRODUCT`, `MINI_APP`/`MINI_GAME` (Smart+ only), `GAME` (not creatable via API). |
| `promotion_target_type` | string | Optional — LEAD_GENERATION | `INSTANT_PAGE` (Instant Form), `EXTERNAL_WEBSITE` (website form). |
| `promotion_website_type` | string | Conditional | `UNSET`, `TIKTOK_NATIVE_PAGE` (TikTok Instant Page). |
| `app_id` | string | Conditional | Required for APP_PROMOTION retargeting / installs when not iOS14 Dedicated. |
| `pixel_id` | string | Conditional | Required iff `optimization_goal` is `CONVERT` or `VALUE` (web). From `/pixel/list/`. |
| `optimization_event` | string | Conditional | Required when `pixel_id` set, or when goal is `IN_APP_EVENT`/`VALUE`. Standard conversion events. |
| `custom_conversion_id` | string | Optional | Custom Conversion. |
| `app_config` | object[] (max 2) | Conditional | Required when campaign `sales_destination=WEB_AND_APP`. |
| `deep_funnel_optimization_status` / `_event_source` / `_event_source_id` / `_optimization_event` | — | Optional (LEAD_GENERATION) | Deep funnel: source `PIXEL`/`OFFLINE`/`CRM`. |

**Messaging (Instant Messaging Ads)** — `promotion_type=LEAD_GEN_CLICK_TO_SOCIAL_MEDIA_APP_MESSAGE`:

| Field | Required | Values |
|---|---|---|
| `messaging_app_type` | Required when goal=CONVERSATION | `MESSENGER`, `WHATSAPP`, `ZALO`, `LINE`, `IM_URL`. CONVERSATION goal only allows MESSENGER/WHATSAPP. Immutable. |
| `messaging_app_account_id` | For MESSENGER / LINE | Immutable. |
| `phone_region_code` / `phone_region_calling_code` / `phone_number` | For WHATSAPP / ZALO | Immutable. |
| `message_event_set_id` | For CONVERSATION | From `/ctm/message_event_set/get/`. Immutable. |

**Shopping (PRODUCT_SALES):** `shopping_ads_type` (**required**: `VIDEO`, `LIVE`, `PRODUCT_SHOPPING_ADS`), `product_source` (`UNSET`/`CATALOG`/`STORE`/`SHOWCASE`), `catalog_id`, `catalog_authorized_bc_id`, `store_id`, `store_authorized_bc_id`, `identity_id` + `identity_type` + `identity_authorized_bc_id`, retargeting: `shopping_ads_retargeting_type` (`LAB1`/`LAB2`/`LAB3`/`OFF`), `shopping_ads_retargeting_actions_days` (1,2,3,7,14,30,60,90,180), `included_custom_actions` / `excluded_custom_actions`, `shopping_ads_retargeting_custom_audience_relation` (`OR`/`AND`).

### 2.3 Placements

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `placement_type` | string | Optional | `PLACEMENT_TYPE_AUTOMATIC`, `PLACEMENT_TYPE_NORMAL` (default). Immutable. |
| `placements` | string[] | Required when NORMAL | `PLACEMENT_TIKTOK`, `PLACEMENT_PANGLE`, `PLACEMENT_GLOBAL_APP_BUNDLE` (CapCut + Fizzo; only BR/ID/VN/PH/TH/MY/MX/**SA**/JP). PRODUCT_SALES → TikTok only. Immutable. |
| `tiktok_subplacements` | string[] | Optional — REACH/VIDEO_VIEWS/ENGAGEMENT + TikTok-only | `IN_FEED`, `SEARCH_FEED` (allowlist), `TIKTOK_LITE` (to-be-deprecated), `LEMON8` (REACH only, allowlist). Immutable. |
| `search_result_enabled` | boolean | Optional | Automatic Search Placement toggle. |
| `automated_keywords_enabled` | boolean | Optional (allowlist) | Only `is_search_campaign=true`. |
| `search_keywords` | object[] (max 1,000) | **Required for Search Ads Campaigns** | `keyword` (≤80 chars), `match_type` (`PRECISE_WORD`/`PHRASE_WORD`/`BROAD_WORD`), `keyword_bid_type` (`FOLLOW_ADGROUP`/`CUSTOM`), `keyword_bid`. |
| `blocked_pangle_app_ids` | string[] | Optional | Pangle block list. |
| `comment_disabled` / `video_download_disabled` / `share_disabled` | boolean | Optional | Interaction toggles. |

### 2.4 Targeting

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `location_ids` | string[] | **Must set `location_ids` or `zipcode_ids`** | Max 3,000 combined. IDs from `/tool/targeting/search/` or `/tool/region/`. No overlapping locations. |
| `zipcode_ids` | string[] | Conditional | Zip (US) / postal (CA; others allowlisted). TikTok placement only. **Not with `special_industries` or RF_REACH.** |
| `languages` | string[] | Optional | `ar`, `en`, … full list via `/tool/language/`. Empty = all. |
| `gender` | string | Optional | `GENDER_FEMALE`, `GENDER_MALE`, `GENDER_UNLIMITED`. |
| `age_groups` | string[] | Optional | `AGE_13_17`, `AGE_18_24`, `AGE_25_34`, `AGE_35_44`, `AGE_45_54`, `AGE_55_100`. |
| `spending_power` | string | Optional | `ALL`, `HIGH`. Not for PRODUCT_SALES / RF_REACH; TikTok placement required. |
| `household_income` | string[] | Optional | `TOP5`, `TOP10`, `TOP10_25`, `TOP25_50` — **US only**. |
| `audience_ids` / `excluded_audience_ids` | string[] | Optional | Custom/lookalike audiences from `/dmp/custom_audience/list/`. |
| `saved_audience_id` | string | Optional | NOT with special_industries / PRODUCT_SALES / non-TikTok-only placement. |
| `smart_audience_enabled` | boolean | Optional | Smart Targeting: smart audience toggle. |
| `smart_interest_behavior_enabled` | boolean | Optional | Smart Targeting: smart interests & behaviors toggle. |
| `interest_category_ids` | string[] | Optional | General interest categories. |
| `interest_keyword_ids` | string[] | Optional | Mutually exclusive with `purchase_intention_keyword_ids`. |
| `purchase_intention_keyword_ids` | string[] | Optional | Purchase-intent categories. |
| `actions` | object[] | Optional | Behavior targeting: `action_scene` (`VIDEO_RELATED`, `CREATOR_RELATED`, `HASHTAG_RELATED`), `action_period` (0/7/15), `video_user_actions` (`WATCHED_TO_END`,`LIKED`,`COMMENTED`,`SHARED` / `FOLLOWING`,`VIEW_HOMEPAGE` / `VIEW_HASHTAG`), `action_category_ids`. |
| `included_pangle_audience_package_ids` / `excluded_…` | string[] | Optional | Pangle only. |
| `operating_systems` | string[] | Conditional — required for APP_PROMOTION | One value: `ANDROID` or `IOS`. |
| `min_android_version` / `min_ios_version` | string | Optional / conditional | Via `/tool/os_version/`. |
| `ios14_targeting` | string | Conditional | `UNSET`, `IOS14_MINUS`, `IOS14_PLUS`, `ALL`. |
| `device_model_ids` | string[] | Optional | From `/tool/device_model/`. Mutually exclusive with `device_price_ranges`. |
| `network_types` | string[] | Optional | `WIFI`, `2G`, `3G`, `4G`, `5G`. |
| `carrier_ids` | string[] | Optional | From `/tool/carrier/`. |
| `isp_ids` | string[] | Optional | Requires country/region-level locations. |
| `device_price_ranges` | number[] | Optional | Multiples of 50; `10000` = 1000+. |
| `audience_type` | string | Conditional | Required iff `app_promotion_type=APP_RETARGETING`: `NEW_CUSTOM_AUDIENCE`. |
| `auto_targeting_enabled` / `targeting_expansion` | — | **To be deprecated** | Migrate to Smart Targeting. |
| `contextual_tag_ids` | string[] | Optional (allowlist) | REACH/VIDEO_VIEWS only. |

**Brand safety:** `brand_safety_type` (TikTok-only): `NO_BRAND_SAFETY` (default, to be deprecated), `EXPANDED_INVENTORY`, `STANDARD_INVENTORY`, `LIMITED_INVENTORY`, `THIRD_PARTY` (+`brand_safety_partner`: `IAS`/`OPEN_SLATE`). `category_exclusion_ids`, `vertical_sensitivity_id` with STANDARD/LIMITED.

### 2.5 Budget, schedule, optimization & bidding

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `budget_mode` | string | **Required** | `BUDGET_MODE_TOTAL`, `BUDGET_MODE_DAY`, `BUDGET_MODE_DYNAMIC_DAILY_BUDGET`. Ignored under CBO. TOTAL forces START_END schedule. |
| `budget` | float | **Required** | Ignored under CBO. |
| `schedule_type` | string | **Required** | `SCHEDULE_START_END`, `SCHEDULE_FROM_NOW`. |
| `schedule_start_time` | datetime | **Required** | `"YYYY-MM-DD HH:MM:SS"` UTC+0. |
| `schedule_end_time` | datetime | Conditional | Required for START_END / TOTAL. |
| `dayparting` | string | Optional | 48×7 = 336-char string of 0/1, Monday 00:01 first slot. |
| `optimization_goal` | string | **Required** | See §2.6. Must match `billing_event` per §2.7. |
| `secondary_optimization_event` | string | Optional | For INSTALL / VALUE secondary goals. |
| `billing_event` | string | **Required** | `CPC`, `CPM`, `CPV`, `OCPM` (`GD` guaranteed delivery; `OCPC` deprecated). |
| `bid_type` | string | Conditional — required when CBO on | `BID_TYPE_CUSTOM` (Cost Cap), `BID_TYPE_NO_BID` (Maximum Delivery). |
| `bid_price` | float | Required with CUSTOM + CPC/CPM/CPV | |
| `conversion_bid_price` | float | Required with CUSTOM + OCPM | Target CPA. |
| `deep_bid_type` | string | Conditional | `DEFAULT`, `MIN`, `PACING`, `AEO`, `VO_MIN_ROAS` (allowlist), `VO_HIGHEST_VALUE` (allowlist). |
| `roas_bid` | float | Required with VO_MIN_ROAS | 0.01–1,000 (0.01–10 IAA). |
| `pacing` | string | **Required** (forced SMOOTH under CBO) | `PACING_MODE_SMOOTH`, `PACING_MODE_FAST`. |
| `frequency` / `frequency_schedule` | number | REACH only | e.g. 2 & 3 = "≤ twice every 3 days". |
| `click_attribution_window` | string | Optional | `OFF`, `ONE_DAY`, `SEVEN_DAYS`, `FOURTEEN_DAYS`, `TWENTY_EIGHT_DAYS`. Immutable. |
| `view_attribution_window` | string | Optional | `OFF`, `ONE_DAY`, `SEVEN_DAYS`. Immutable. |
| `engaged_view_attribution_window` | string | Optional | `ONE_DAY`, `SEVEN_DAYS`. Immutable. |
| `attribution_event_count` | string | Optional | `UNSET`, `EVERY`, `ONCE`. Immutable. |
| `operation_status` | string | Optional | `ENABLE` (default), `DISABLE`. |
| `creative_material_mode` | string | Optional | `CUSTOM` (default). |

### 2.6 `optimization_goal` — full enum

Creatable: `CLICK`, `CONVERT`, `INSTALL`, `IN_APP_EVENT`, `SHOW` (impressions), `REACH`, `LEAD_GENERATION`, `CONVERSATION` (allowlist), `FOLLOWERS`, `PAGE_VISIT` (ENGAGEMENT only), `VALUE`, `AUTOMATIC_VALUE_OPTIMIZATION` (allowlist), `MT_LIVE_ROOM`, `PRODUCT_CLICK_IN_LIVE`, `ENGAGED_VIEW` (6-sec), `ENGAGED_VIEW_FIFTEEN` (15-sec), `TRAFFIC_LANDING_PAGE_VIEW`, `DESTINATION_VISIT` (allowlist), `PREFERRED_LEAD`.
Deprecated/read-only: `VIDEO_VIEW`, `PROFILE_VIEWS`, `CONVERSION_LEADS`, `GMV`/`PURCHASES`/`INITIATE_CHECKOUTS` (reporting filters only).

### 2.7 Goal → billing event mapping (deterministic)

| optimization_goal | billing_event |
|---|---|
| CLICK, PAGE_VISIT | `CPC` |
| CONVERT, INSTALL, IN_APP_EVENT, TRAFFIC_LANDING_PAGE_VIEW, LEAD_GENERATION, CONVERSATION, FOLLOWERS, VALUE, AUTOMATIC_VALUE_OPTIMIZATION, PRODUCT_CLICK_IN_LIVE, MT_LIVE_ROOM, DESTINATION_VISIT | `OCPM` |
| SHOW, REACH | `CPM` |
| ENGAGED_VIEW, ENGAGED_VIEW_FIFTEEN | `CPV` |

---

## 3. Ad — `POST /ad/create/`

Body: `advertiser_id` (**req**), `adgroup_id` (**req**), `creatives` (**req**, object[], max 20 per call).

### 3.1 Core creative fields

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `ad_name` | string | **Required** | ≤512 chars, no emoji. `""` = auto-generate. |
| `identity_type` | string | **Required** | `CUSTOMIZED_USER` (being sunset for TikTok placement on accounts created ≥2026-01-15), `AUTH_CODE` (Spark authorized post), `TT_USER` (own TikTok Business Account), `BC_AUTH_TT` (BC-authorized). |
| `identity_id` | string | **Required** | |
| `identity_authorized_bc_id` | string | With BC_AUTH_TT | |
| `ad_format` | string | **Required** | `SINGLE_VIDEO`, `SINGLE_IMAGE`, `CAROUSEL_ADS` (1–35 images), `CATALOG_CAROUSEL`, `LIVE_CONTENT`. |
| `video_id` | string | Conditional | For SINGLE_VIDEO; or `tiktok_item_id` for Spark. |
| `image_ids` | string[] | Conditional | SINGLE_IMAGE: 1. SINGLE_VIDEO: 1 = cover. CAROUSEL_ADS: 1–35, order = display order. |
| `tiktok_item_id` | string | Conditional | Spark Ads Pull: the TikTok post ID (AUTH_CODE / BC_AUTH_TT). |
| `music_id` | string | Conditional | Required for standard carousel push. |
| `ad_text` | string | Conditional | ≤100 chars, no emoji. |
| `ad_texts` | string[] (max 5) | Conditional | Search Ads Campaigns only. |
| `call_to_action` | string | Conditional | Full enum §3.4; or `call_to_action_id` (CTA portfolio, wins). |
| `card_id` | string | Optional | Creative portfolio: Display Card, Countdown Sticker, Gift Code, Pop-up Showcase, Gesture, Superlike, etc. |
| `landing_page_url` | string | Conditional | Destination URL (may embed UTM). Required for website promotions. |
| `display_name` | string | Conditional | 1–40 EN chars (1–20 CJK). Required for landing-page promotions. |
| `app_name` / `avatar_icon_web_uri` | string | Conditional / optional | App display name; 1:1 avatar image. |
| `page_id` | number | Conditional | Instant Page / **Instant Form (Lead Gen)** ID via `/page/get/`. TikTok placement only. |
| `tiktok_page_category` | string | Required when goal=PAGE_VISIT | `PROFILE_PAGE`, `OTHER_TIKTOK_PAGE` (+url), `TIKTOK_INSTANT_PAGE` (+page_id). Immutable. |
| `auto_message_id` | string | For DM lead gen | Welcome message ID. |
| `phone_region_code` / `phone_region_calling_code` / `phone_number` | string | For LEAD_GEN_CLICK_TO_CALL | |
| `operation_status` | string | Optional | `ENABLE` (default) / `DISABLE`. |

### 3.2 Spark Ads specifics

`promotional_music_disabled` (default true), `item_duet_status` / `item_stitch_status` (`ENABLE`/`DISABLE`), `dark_post_status` (`ON` default/`OFF`), `creative_authorized` (bool — Creative Center display, non-US, video only).

### 3.3 Tracking, deeplinks, misc

- **UTM:** `utm_params` (max 14 `{key,value}`; macros `__CAMPAIGN_NAME__`, `__CAMPAIGN_ID__`, `__AID_NAME__`, `__AID__`, `__CID_NAME__`, `__CID__`, `__PLACEMENT__`).
- **Tracking:** `impression_tracking_url`, `click_tracking_url`, `video_view_tracking_url`, `tracking_pixel_id`, `tracking_app_id`, `tracking_offline_event_set_ids` (max 50), `tracking_message_event_set_id`.
- **Deeplinks:** `deeplink`, `deeplink_type` (`NORMAL`/`DEFERRED_DEEPLINK` allowlist), `deeplink_format_type`, `fallback_type` (`APP_INSTALL`/`WEBSITE`/`UNSET`).
- **Disclaimers:** `disclaimer_type` (`TEXT_LINK`/`TEXT_ONLY`), `disclaimer_text` (≤90), `disclaimer_clickable_texts` (max 3). Cannot be deleted once added.
- **Other:** `aigc_disclosure_type` (`SELF_DISCLOSURE`/`NOT_DECLARED`), `creative_auto_enhancement_strategy_list` (`VIDEO_QUALITY`,`MUSIC_REFRESH`,`IMAGE_QUALITY`,`IMAGE_RESIZE`), `playable_url`, brand-safety post-bid partners (allowlist).
- **Catalog/shopping:** `product_specific_type` (`ALL`/`PRODUCT_SET`/`CUSTOMIZED_PRODUCTS`), `item_group_ids`, `product_set_id`, `sku_ids`, `showcase_products`, `dynamic_format`, `vertical_video_strategy`, `instant_product_page_used`.

### 3.4 `call_to_action` — full enum

`APPLY_NOW`, `BOOK_NOW`, `CALL_NOW`, `CHECK_AVAILLABILITY` *(sic — doc spelling)*, `CONTACT_US`, `DOWNLOAD_NOW`, `EXPERIENCE_NOW`, `GET_QUOTE`, `GET_SHOWTIMES`, `GET_TICKETS_NOW`, `INSTALL_NOW`, `INTERESTED`, `LEARN_MORE`, `LISTEN_NOW`, `ORDER_NOW`, `PLAY_GAME`, `PREORDER_NOW`, `READ_MORE`, `SEND_MESSAGE`, `SHOP_NOW`, `SIGN_UP`, `SUBSCRIBE`, `VIEW_NOW`, `VIEW_PROFILE` (ENGAGEMENT only), `VISIT_STORE`, `WATCH_LIVE` (LIVE ads only), `WATCH_NOW`, plus R&F-only: `JOIN_THIS_HASHTAG`, `SHOOT_WITH_THIS_EFFECT`, `VIEW_VIDEO_WITH_THIS_EFFECT`.

---

## 4. Upgraded Smart+ (automated campaigns)

Separate endpoint family: `POST /smart_plus/campaign/create/`, `/smart_plus/adgroup/create/`, `/smart_plus/ad/create/`. Legacy Smart Performance Campaigns used `/campaign/spc/create/` ("to be deprecated"). Detection on GET: `is_smart_performance_campaign=true`.

Key deltas vs manual: campaign adds `budget_auto_adjust_strategy` (`AUTO_BUDGET_INCREASE`/`UNSET`, allowlist); CBO default **true**. Ad group: `targeting_optimization_mode` (`AUTOMATIC`|`MANUAL`), targeting inside a **`targeting_spec` object** instead of flat fields; `min_budget` floor; placements optional (omit = automatic).

---

## 5. CRM-modeling notes

1. **`special_industries=["HOUSING"]`** — the real-estate flag. Only generally available to US/CA-registered advertisers; for a Saudi advertiser targeting Saudi locations it does not apply.
2. **Saudi Arabia is an allowed Global App Bundle market** (`PLACEMENT_GLOBAL_APP_BUNDLE`).
3. Field dependency spine for a wizard: objective → (app_promotion_type | campaign_product_source | virtual+sales_destination) → budget_mode/budget → ad group promotion_type → placement → targeting → optimization_goal → billing_event (deterministic §2.7) → bid_type → bid_price/conversion_bid_price → ad identity → ad_format → creative assets → CTA → destination.
4. Many enum values are **allowlist-gated** — hide them or badge "requires TikTok rep approval".
5. Lists that must stay dynamic (fetched from tool endpoints, not hardcoded): locations, languages, interest/action categories, device models, carriers, OS versions, pixels, apps, identities, audiences.
