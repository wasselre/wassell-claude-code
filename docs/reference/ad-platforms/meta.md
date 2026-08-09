# Meta (Facebook/Instagram) Marketing API — Campaign Creation Field Reference

Compiled 2026-08-09 from official Meta developer docs (Graph API / Marketing API, current version family v25–v26). Structure: Campaign → Ad Set → Ad + Creative, plus targeting spec, placements, Advantage+ notes.

---

## 1. Campaign — `POST /act_{ad_account_id}/campaigns`

Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `name` | string | **Yes** | Free text, supports emoji |
| `objective` | enum | **Yes** | **Current (ODAX, use these 6):** `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_APP_PROMOTION`, `OUTCOME_SALES`. Legacy values still in the enum (read-only for old campaigns, don't offer in a new form): `APP_INSTALLS`, `BRAND_AWARENESS`, `CONVERSIONS`, `EVENT_RESPONSES`, `LEAD_GENERATION`, `LINK_CLICKS`, `LOCAL_AWARENESS`, `MESSAGES`, `OFFER_CLAIMS`, `PAGE_LIKES`, `POST_ENGAGEMENT`, `PRODUCT_CATALOG_SALES`, `REACH`, `STORE_VISITS`, `VIDEO_VIEWS` |
| `special_ad_categories` | array<enum> | **Yes** (may be `[]`) | `NONE`, `EMPLOYMENT`, `HOUSING`, `CREDIT`, `ISSUES_ELECTIONS_POLITICS`, `ONLINE_GAMBLING_AND_GAMING`, `FINANCIAL_PRODUCTS_SERVICES`. Real-estate advertising in some countries = `HOUSING` (US-centric; for KSA typically `NONE`, but the field itself is mandatory) |
| `special_ad_category_country` | array<string> | No | ISO country codes, used with a special ad category |
| `status` | enum | No (default `PAUSED`) | On create only `ACTIVE`, `PAUSED` (full enum: `ACTIVE`, `PAUSED`, `DELETED`, `ARCHIVED`) |
| `daily_budget` | int64 (minor currency units) | No | Campaign-level budget = **Advantage campaign budget (CBO)**. All ad sets share it. Either campaign-level OR ad-set-level budget, never both |
| `lifetime_budget` | int64 | No | Same CBO note; requires `stop_time` |
| `bid_strategy` | enum | No | `LOWEST_COST_WITHOUT_CAP`, `LOWEST_COST_WITH_BID_CAP`, `COST_CAP`, `LOWEST_COST_WITH_MIN_ROAS`. Settable at campaign level when using CBO, otherwise on the ad set |
| `spend_cap` | int64 | No | Whole-campaign spend limit; min ≈ $100 USD equivalent; set `922337203685478` to remove |
| `buying_type` | string | No (default `AUCTION`) | `AUCTION`, `RESERVED` (reach & frequency) |
| `start_time` / `stop_time` | datetime (ISO 8601 or UNIX) | No | `stop_time` required with `lifetime_budget` |
| `promoted_object` | object | No | Campaign-level promoted object (mostly for app promotion / ASC-style setups) |
| `is_skadnetwork_attribution` | boolean | No | iOS 14+ SKAdNetwork campaigns |
| `adlabels` | list | No | Organizational labels |
| `source_campaign_id` | numeric string | No | When copying a campaign |
| `smart_promotion_type` | enum | Being phased out | `AUTOMATED_SHOPPING_ADS` (Advantage+ shopping), `SMART_APP_PROMOTION` — see §5 |

---

## 2. Ad Set — `POST /act_{ad_account_id}/adsets`

Source: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/ and https://developers.facebook.com/docs/marketing-api/bidding/overview/bid-strategy

### 2.1 Core fields

| Field | Type | Required | Allowed values / notes |
|---|---|---|---|
| `name` | string (≤400 chars) | **Yes** | |
| `campaign_id` | numeric string | **Yes** | |
| `optimization_goal` | enum | **Yes** | Full enum: `NONE`, `APP_INSTALLS`, `AD_RECALL_LIFT`, `ENGAGED_USERS`, `EVENT_RESPONSES`, `IMPRESSIONS`, `LEAD_GENERATION`, `QUALITY_LEAD`, `LINK_CLICKS`, `OFFSITE_CONVERSIONS`, `PAGE_LIKES`, `POST_ENGAGEMENT`, `QUALITY_CALL`, `REACH`, `LANDING_PAGE_VIEWS`, `VISIT_INSTAGRAM_PROFILE`, `VALUE`, `THRUPLAY`, `DERIVED_EVENTS`, `APP_INSTALLS_AND_OFFSITE_CONVERSIONS`, `CONVERSATIONS`, `IN_APP_VALUE`, `MESSAGING_PURCHASE_CONVERSION`, `MESSAGING_APPOINTMENT_CONVERSION`, `MESSAGING_DEEP_CONVERSATION_AND_FOLLOW`, `SUBSCRIBERS`, `REMINDERS_SET`, `MEANINGFUL_CALL_ATTEMPT`, `PROFILE_VISIT`, `PROFILE_AND_PAGE_ENGAGEMENT`, `ENGAGED_PAGE_VIEWS`, `ADVERTISER_SILOED_VALUE`, `AUTOMATIC_OBJECTIVE` |
| `billing_event` | enum | **Yes** | `APP_INSTALLS`, `CLICKS`, `IMPRESSIONS`, `LINK_CLICKS`, `NONE`, `OFFER_CLAIMS`, `PAGE_LIKES`, `POST_ENGAGEMENT`, `THRUPLAY`, `PURCHASE`, `LISTING_INTERACTION`. In practice almost everything is `IMPRESSIONS`; `THRUPLAY` for video views, `LINK_CLICKS` where allowed |
| `targeting` | Targeting object | **Yes** | See §3. `geo_locations.countries` (or equivalent) mandatory |
| `status` | enum | No | `ACTIVE`, `PAUSED` on create |
| `destination_type` | enum | Conditionally | `WEBSITE`, `APP`, `MESSENGER`, `APPLINKS_AUTOMATIC`, `WHATSAPP`, `INSTAGRAM_DIRECT`, `FACEBOOK`, `MESSAGING_MESSENGER_WHATSAPP`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER`, `MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP`, `MESSAGING_INSTAGRAM_DIRECT_WHATSAPP`, `SHOP_AUTOMATIC`, `ON_AD`, `ON_POST`, `ON_EVENT`, `ON_VIDEO`, `ON_PAGE`, `INSTAGRAM_PROFILE`, `FACEBOOK_PAGE`, `INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE`, `INSTAGRAM_LIVE`, `FACEBOOK_LIVE`, `IMAGINE` |
| `promoted_object` | object | Conditionally (depends on goal) | Keys: `page_id`, `pixel_id`, `custom_event_type`, `application_id`, `object_store_url`, `event_id`, `product_set_id`, `product_catalog_id`, `offline_conversion_data_set_id`, `whatsapp_phone_number`, `custom_conversion_id`. `custom_event_type` enum: `AD_IMPRESSION`, `RATE`, `TUTORIAL_COMPLETION`, `CONTACT`, `CUSTOMIZE_PRODUCT`, `DONATE`, `FIND_LOCATION`, `SCHEDULE`, `START_TRIAL`, `SUBMIT_APPLICATION`, `SUBSCRIBE`, `ADD_TO_CART`, `ADD_TO_WISHLIST`, `INITIATED_CHECKOUT`, `ADD_PAYMENT_INFO`, `PURCHASE`, `LEAD`, `COMPLETE_REGISTRATION`, `CONTENT_VIEW`, `SEARCH`, `SERVICE_BOOKING_REQUEST`, `MESSAGING_CONVERSATION_STARTED_7D`, `LEVEL_ACHIEVED`, `ACHIEVEMENT_UNLOCKED`, `SPENT_CREDITS`, `LISTING_INTERACTION`, `D2_RETENTION`, `D7_RETENTION`, `OTHER` |
| `dsa_payor` / `dsa_beneficiary` | string (≤512) | Required for EU targeting | DSA compliance |

### 2.2 Budget, bidding, schedule

| Field | Type | Required | Notes |
|---|---|---|---|
| `daily_budget` | int64 | One of daily/lifetime (unless CBO on campaign) | Minor currency units (halalas for SAR) |
| `lifetime_budget` | int64 | " | Requires `end_time` |
| `bid_strategy` | enum | No (default `LOWEST_COST_WITHOUT_CAP`) | `LOWEST_COST_WITHOUT_CAP` (no extra field), `LOWEST_COST_WITH_BID_CAP` (**requires `bid_amount`**), `COST_CAP` (**requires `bid_amount`**, settable campaign or ad set), `LOWEST_COST_WITH_MIN_ROAS` (**requires `bid_constraints: {"roas_average_floor": int}`**, `bid_amount` prohibited; only with value optimization — goals `VALUE`/`OFFSITE_CONVERSIONS`/`APP_INSTALLS`) |
| `bid_amount` | integer | With cap strategies | Max bid or cost target, minor units |
| `bid_constraints` | object | With MIN_ROAS | `{"roas_average_floor": 10000}` = 1.0× ROAS (scaled ×10000) |
| `daily_min_spend_target` / `daily_spend_cap` | int64 | No | Ad-set spend guardrails; `922337203685478` removes |
| `lifetime_min_spend_target` / `lifetime_spend_cap` | int64 | No | " |
| `start_time` | datetime | No (default now) | |
| `end_time` | datetime | Required with lifetime_budget | `0` = ongoing |
| `adset_schedule` | list<DayPart> | No (dayparting) | Each: `{start_minute: 0–1439, end_minute, days: [0–6, 0=Sunday], timezone_type: "USER"|"ADVERTISER"}`. Only with lifetime budget |
| `pacing_type` | list<string> | No | `standard` (default), `day_parting`, `no_pacing`/accelerated (only with bid cap) |
| `frequency_control_specs` | list | No (REACH/THRUPLAY only) | `{event: IMPRESSIONS|VIDEO_VIEWS|VIDEO_VIEWS_2S|VIDEO_VIEWS_15S, interval_days: 1–90, max_frequency: 1–90, type: NONE|CAP|TARGET}` |
| `attribution_spec` | list<object> | No | `[{event_type: CLICK_THROUGH|VIEW_THROUGH|ENGAGED_VIDEO_VIEW, window_days: int}]` (typical: click 1/7, view 1) |
| `is_dynamic_creative` | boolean | No | Enables dynamic creative (pairs with creative `asset_feed_spec`) |
| `multi_optimization_goal_weight` | enum | No | `UNDEFINED`, `BALANCED`, `PREFER_INSTALL`, `PREFER_EVENT` |
| `existing_customer_budget_percentage` | int | No | Advantage+ sales audience budget split (deprecated with ASC retirement — see §5) |
| `execution_options` | list | No | `validate_only`, `include_recommendations` |
| `adlabels`, `creative_sequence`, `campaign_spec`, `contextual_bundling_spec`, `bid_adjustments`, `optimization_sub_event` | misc | No | Secondary |

### 2.3 Objective → conversion location (`destination_type`) → `optimization_goal` pairing (ODAX)

This is the table Ads Manager enforces:

| Objective | destination_type options | Valid optimization goals | promoted_object needs |
|---|---|---|---|
| `OUTCOME_AWARENESS` | (none / `ON_VIDEO` implicit) | `REACH`, `IMPRESSIONS`, `AD_RECALL_LIFT`, `THRUPLAY` (video views live here now) | `page_id` |
| `OUTCOME_TRAFFIC` | `WEBSITE`, `APP`, `MESSENGER`, `WHATSAPP`, `INSTAGRAM_PROFILE`, `FACEBOOK_PAGE` (calls: no dest + `QUALITY_CALL`) | `LINK_CLICKS`, `LANDING_PAGE_VIEWS` (website only), `IMPRESSIONS`, `REACH`, `CONVERSATIONS` (messaging), `QUALITY_CALL`, `PROFILE_VISIT` | `application_id`+`object_store_url` for APP; `page_id` for calls/messaging |
| `OUTCOME_ENGAGEMENT` | `ON_POST`, `ON_PAGE`, `ON_EVENT`, `ON_VIDEO`, `MESSENGER`, `WHATSAPP`, `INSTAGRAM_DIRECT`, `WEBSITE`, `APP` | `POST_ENGAGEMENT`, `PAGE_LIKES`, `EVENT_RESPONSES`, `THRUPLAY`, `CONVERSATIONS`, `LINK_CLICKS`, `IMPRESSIONS`, `REACH`, `OFFSITE_CONVERSIONS` (website engagement), `PROFILE_AND_PAGE_ENGAGEMENT` | `page_id`; `pixel_id`+`custom_event_type` for website |
| `OUTCOME_LEADS` | `ON_AD` (instant forms), `WEBSITE`, `MESSENGER`, `INSTAGRAM_DIRECT`, `WHATSAPP`, `APP`, calls | `LEAD_GENERATION`, `QUALITY_LEAD`, `OFFSITE_CONVERSIONS` (website leads, pixel `LEAD` event), `CONVERSATIONS`, `QUALITY_CALL`, `LINK_CLICKS`, `REACH`, `IMPRESSIONS`, `SUBSCRIBERS` | Instant forms: `page_id` (form id lives on the creative CTA — §4.4); website: `pixel_id`+`custom_event_type: LEAD` |
| `OUTCOME_APP_PROMOTION` | `APP`, `APPLINKS_AUTOMATIC` | `APP_INSTALLS`, `OFFSITE_CONVERSIONS` (app events), `LINK_CLICKS`, `VALUE`, `APP_INSTALLS_AND_OFFSITE_CONVERSIONS`, `IN_APP_VALUE` | `application_id` + `object_store_url` |
| `OUTCOME_SALES` | `WEBSITE`, `APP`, `MESSENGER`, `WHATSAPP`, `INSTAGRAM_DIRECT`, `SHOP_AUTOMATIC`, calls | `OFFSITE_CONVERSIONS`, `VALUE`, `LINK_CLICKS`, `LANDING_PAGE_VIEWS`, `IMPRESSIONS`, `REACH`, `CONVERSATIONS`, `MESSAGING_PURCHASE_CONVERSION`, `QUALITY_CALL` | `pixel_id` + `custom_event_type` (typically `PURCHASE`); `product_set_id` for catalog ads |

---

## 3. Targeting spec (`targeting` object on the ad set)

Sources: https://developers.facebook.com/docs/marketing-api/audiences/reference/basic-targeting , .../advanced-targeting , .../placement-targeting

### 3.1 Geo

`geo_locations` (object, **required**) and `excluded_geo_locations` (same shape, minus `location_types`):

| Key | Shape | Limits / values |
|---|---|---|
| `countries` | `["SA"]` | ISO-2 codes |
| `regions` | `[{"key":"3847"}]` | ≤200; keys from Targeting Search API (`type=adgeolocation`) |
| `cities` | `[{"key":"2430536","radius":12,"distance_unit":"mile"}]` | ≤250; radius 10–50 mi / 17–80 km |
| `zips` | `[{"key":"US:94304"}]` | ≤50,000 |
| `geo_markets` | `[{"key":"COMSCORE_MARKET:2001"}]` | ≤2,500 (DMA, US) |
| `custom_locations` | `[{"latitude":24.7,"longitude":46.7,"radius":5,"distance_unit":"kilometer","address_string":"..."}]` | ≤200; radius 0.63–50 mi / 1–80 km — pin-drop radius targeting |
| `location_types` | `["home","recent"]` | default both |
| `country_groups` | `["worldwide","asia","africa","europe","north_america","south_america","oceania","caribbean","central_america","mercosur",…]` | |

### 3.2 Demographics

| Key | Type | Values |
|---|---|---|
| `age_min` | int | 13–65, default 18 |
| `age_max` | int | ≤65 (65 = "65+") |
| `genders` | array<int> | `[1]` male, `[2]` female, omit = all |
| `locales` | array<int> | Language IDs (Targeting Search `type=adlocale`), ≤50 |
| `relationship_statuses` | array<int> | 1 single, 2 in relationship, 3 married, 4 engaged, 6 not specified |
| `education_statuses` | array<int> | 1–13 enumerated levels |
| `education_schools` / `education_majors` / `work_employers` / `work_positions` | array<{id,name}> | ≤200 each |
| `college_years` | array<int> | ≥1980 |
| `life_events`, `industries`, `income`, `family_statuses` | array<{id,name}> | IDs from Targeting Search (`type=adTargetingCategory`) |

### 3.3 Interests / behaviors / logic

| Key | Type | Notes |
|---|---|---|
| `interests` | `[{"id":6003139266461,"name":"Movies"}]` | OR within array |
| `behaviors` | `[{"id":6002714895372,"name":"..."}]` | |
| `flexible_spec` | array of targeting-spec fragments | AND between array elements, OR inside each — "narrow audience" |
| `exclusions` | one targeting-spec fragment | Excludes interests/behaviors/demographics |
| `custom_audiences` / `excluded_custom_audiences` | `[{"id":"<audience_id>"}]` | ≤500; covers custom audiences AND lookalikes (a lookalike is a custom audience id) |
| `connections` / `excluded_connections` / `friends_of_connections` | array of page/app/event ids | |

### 3.4 Device / OS

| Key | Values |
|---|---|
| `device_platforms` | `mobile`, `desktop` |
| `user_os` | `iOS`, `Android`, versioned e.g. `iOS_ver_8.0_and_above` |
| `user_device` / `excluded_user_device` | device names (`iPhone`, `Galaxy S6`, …) |
| `wireless_carrier` | `Wifi` |

### 3.5 Placements (inside `targeting`)

**Omit all placement keys = Advantage+ placements (all placements, Meta-recommended default).** Any manual selection must be internally consistent.

| Key | Enum values (verbatim) |
|---|---|
| `publisher_platforms` | `facebook`, `instagram`, `audience_network`, `messenger`, `threads` |
| `facebook_positions` | `feed`, `right_hand_column`, `marketplace`, `video_feeds`, `story`, `search`, `instream_video`, `facebook_reels`, `facebook_reels_overlay`, `profile_feed`, `notification` |
| `instagram_positions` | `stream` (= Instagram feed), `story`, `explore`, `explore_home`, `reels`, `profile_feed`, `profile_reels`, `ig_search` |
| `audience_network_positions` | `classic`, `rewarded_video` |
| `messenger_positions` | `sponsored_messages`, `story` (messenger_home retired) |

Constraints: audience_network can't be alone; FB/Messenger `story` can't be alone (needs feed or IG story); `notification` needs `feed`; `threads_stream` needs IG `stream`; right column incompatible with video/collection. **Instagram-only campaign = `publisher_platforms: ["instagram"]` + chosen `instagram_positions` — same API, no separate endpoint.**

### 3.6 Advantage+ audience & relaxation

| Key | Shape | Meaning |
|---|---|---|
| `targeting_automation` | `{"advantage_audience": 1}` (0/1; also `individual_setting: {age:0/1, gender:0/1, geo:0/1}`) | Advantage+ audience: your inputs become suggestions, not hard constraints. Required-explicit on newer API versions for many objectives |
| `targeting_relaxation_types` | `{"lookalike": 0/1, "custom_audience": 0/1}` | Advantage custom-audience/lookalike expansion |
| `brand_safety_content_filter_levels` | array | e.g. `FACEBOOK_STANDARD`, `AN_STANDARD` (also `*_RELAXED`, `*_STRICT`) |

---

## 4. Ad + Creative

### 4.1 Ad — `POST /act_{id}/ads`

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | **Yes** | |
| `adset_id` | int64 | **Yes** | |
| `creative` | object | **Yes** | `{"creative_id": <id>}` or full inline creative spec |
| `status` | enum | No | `ACTIVE`/`PAUSED` on create; goes through `PENDING_REVIEW` |
| `tracking_specs` | object | No | Extra action tracking, e.g. `[{"action.type":"offsite_conversion","fb_pixel":["<pixel_id>"]}]` |
| `conversion_domain` | string | Conditionally | Required for pixel-based conversion campaigns |
| `ad_schedule_start_time` / `ad_schedule_end_time` | datetime | No | Per-ad scheduling (sales/app campaigns) |
| `adlabels`, `execution_options` (`validate_only`, `synchronous_ad_review`, `include_recommendations`), `engagement_audience`, `source_ad_id`, `creative_asset_groups_spec` | misc | No | `bid_amount` on the ad is deprecated |

### 4.2 Ad Creative — `POST /act_{id}/adcreatives`

| Field | Type | Notes |
|---|---|---|
| `name` | string ≤100 | |
| `object_story_spec` | object | The main path: creates an unpublished page post. Keys: **`page_id`** (required), `instagram_user_id` (Instagram identity — replaces the older `instagram_actor_id`), plus exactly one of `link_data` / `photo_data` / `video_data` / `text_data` / `template_data` (dynamic ads) / `product_data` |
| `object_story_id` | post id | Alternative: promote an existing published post ("boost") |
| `asset_feed_spec` | object | Dynamic creative / flexible ads / placement asset customization — §4.5 |
| `degrees_of_freedom_spec` | object | Advantage+ creative enhancements — §4.6 |
| `url_tags` | string | e.g. `utm_source=facebook&utm_campaign={{campaign.name}}` |
| `image_hash` / `image_url` / `video_id` | | Simple-creative shortcuts |
| `product_set_id` | numeric string | Advantage+ catalog (dynamic) ads |
| `template_url` / `template_url_spec` | | 3rd-party click tracking for dynamic ads |
| `authorization_category` | enum | `POLITICAL`, `POLITICAL_WITH_DIGITALLY_CREATED_MEDIA` |
| `branded_content_sponsor_page_id`, `contextual_multi_ads` | | Secondary |

### 4.3 `link_data` (single image / carousel) — the "form fields" mapping

Ads-Manager-visible copy fields map as: **primary text = `message`**, **headline = `name`**, **description = `description`**, display link = `caption`, destination = `link`.

Full AdCreativeLinkData: `link` (req), `message`, `name`, `caption`, `description`, `image_hash` | `picture`, `image_crops`, `call_to_action`, `child_attachments` (carousel: 2–10 cards, each `{link, name, description, image_hash|picture|video_id, call_to_action}`), `multi_share_optimized` (default true), `multi_share_end_card` (default true), `attachment_style`, `force_single_link`, `format_option` (`carousel_ar_effects`, `carousel_images_multi_items`, `carousel_images_single_item`, `carousel_slideshows`, `collection_video`, `single_image`), `page_welcome_message` (click-to-message ads), `app_link_spec`, `image_layer_specs`, `image_overlay_spec`, `customization_rules_spec`, `retailer_item_ids`, `collection_thumbnails` (collection format), `boosted_product_set_id`, `offer_id`, `event_id`, branded-content fields, `post_click_configuration`.

`video_data`: `video_id` (req), `image_hash`/`image_url` (thumbnail, one required), `title` (headline), `message` (primary text), `link_description`, `call_to_action`, `page_welcome_message`, `caption_ids`, `retailer_item_ids`, `collection_thumbnails`, `post_click_configuration`, branded-content fields.

`photo_data`: `image_hash` **or** `url` (exactly one), `caption`, `page_welcome_message`, branded-content fields.

### 4.4 `call_to_action` — `{type, value}`

`value` carries: `link`, `lead_gen_form_id` (instant forms — **lead ads put the form id here**, with ad set `destination_type: ON_AD` + `promoted_object.page_id`), `app_destination`, `app_link`, `page`, `whatsapp_number`, `event_id`.

Full `type` enum: `OPEN_LINK`, `LIKE_PAGE`, `SHOP_NOW`, `PLAY_GAME`, `INSTALL_APP`, `USE_APP`, `CALL`, `CALL_ME`, `VIDEO_CALL`, `INSTALL_MOBILE_APP`, `USE_MOBILE_APP`, `MOBILE_DOWNLOAD`, `BOOK_TRAVEL`, `LISTEN_MUSIC`, `WATCH_VIDEO`, `LEARN_MORE`, `SIGN_UP`, `DOWNLOAD`, `WATCH_MORE`, `NO_BUTTON`, `VISIT_PAGES_FEED`, `CALL_NOW`, `APPLY_NOW`, `CONTACT`, `BUY_NOW`, `GET_OFFER`, `GET_OFFER_VIEW`, `BUY_TICKETS`, `UPDATE_APP`, `GET_DIRECTIONS`, `BUY`, `SEND_UPDATES`, `MESSAGE_PAGE`, `DONATE`, `SUBSCRIBE`, `SAY_THANKS`, `SELL_NOW`, `SHARE`, `DONATE_NOW`, `GET_QUOTE`, `CONTACT_US`, `ORDER_NOW`, `START_ORDER`, `ADD_TO_CART`, `VIEW_CART`, `VIEW_IN_CART`, `VIDEO_ANNOTATION`, `RECORD_NOW`, `INQUIRE_NOW`, `CONFIRM`, `REFER_FRIENDS`, `REQUEST_TIME`, `GET_SHOWTIMES`, `LISTEN_NOW`, `TRY_DEMO`, `WOODHENGE_SUPPORT`, `SOTTO_SUBSCRIBE`, `FOLLOW_USER`, `RAISE_MONEY`, `SEE_SHOP`, `GET_DETAILS`, `FIND_OUT_MORE`, `VISIT_WEBSITE`, `BROWSE_SHOP`, `EVENT_RSVP`, `WHATSAPP_MESSAGE`, `FOLLOW_NEWS_STORYLINE`, `SEE_MORE`, `BOOK_NOW`, `FIND_A_GROUP`, `FIND_YOUR_GROUPS`, `PAY_TO_ACCESS`, `PURCHASE_GIFT_CARDS`, `FOLLOW_PAGE`, `SEND_A_GIFT`, `SWIPE_UP_SHOP`, `SWIPE_UP_PRODUCT`, `SEND_GIFT_MONEY`, `PLAY_GAME_ON_FACEBOOK`, `GET_STARTED`, `OPEN_INSTANT_APP`, `AUDIO_CALL`, `GET_PROMOTIONS`, `JOIN_CHANNEL`, `MAKE_AN_APPOINTMENT`, `ASK_ABOUT_SERVICES`, `BOOK_A_CONSULTATION`, `GET_A_QUOTE`, `BUY_VIA_MESSAGE`, `ASK_FOR_MORE_INFO`, `CHAT_WITH_US`, `VIEW_PRODUCT`, `VIEW_CHANNEL`, `GET_IN_TOUCH`, `ASK_A_QUESTION`, `START_A_CHAT`, `CHAT_NOW`, `ASK_US`, `WATCH_LIVE_VIDEO`, `JOIN_LIVE_VIDEO`, `SHOP_WITH_AI`, `TRY_ON_WITH_AI`.

Common form subset worth surfacing in a CRM UI: `LEARN_MORE`, `SHOP_NOW`, `SIGN_UP`, `SUBSCRIBE`, `CONTACT_US`, `GET_QUOTE`, `APPLY_NOW`, `BOOK_NOW`, `CALL_NOW`, `GET_DIRECTIONS`, `MESSAGE_PAGE`, `WHATSAPP_MESSAGE`, `DOWNLOAD`, `GET_OFFER`, `ORDER_NOW`, `NO_BUTTON`.

### 4.5 `asset_feed_spec` (dynamic creative + placement asset customization)

`images[]` (≤10, `{hash|url}`), `videos[]` (≤10, `{video_id, thumbnail_url, url_tags}`), `bodies[]` (≤5, ≤1024 chars — multiple primary texts), `titles[]` (≤5, ≤255 — multiple headlines), `descriptions[]` (≤5, ≤255), `link_urls[]` (≤5, `{website_url, deeplink_url}`), `call_to_action_types[]` (≤5; required except `OUTCOME_AWARENESS`), `ad_formats[]` — `SINGLE_IMAGE`, `SINGLE_VIDEO`, `CAROUSEL`, `AUTOMATIC_FORMAT` (one per feed), `message_extensions` (`whatsapp`, `messenger`, `instagram_message`), `asset_customization_rules[]` (per-placement asset assignment), `optimization_type` (`REGULAR` | `PLACEMENT` | `DEGREES_OF_FREEDOM`). ≤30 assets total. Requires ad set `is_dynamic_creative: true` for DCO use.

### 4.6 `degrees_of_freedom_spec` (Advantage+ creative)

```json
{"degrees_of_freedom_spec": {"creative_features_spec": {"<feature>": {"enroll_status": "OPT_IN"|"OPT_OUT"}}}}
```

Since **v22.0** the bundled `standard_enhancements` opt-in is deprecated — opt into individual features: `image_templates`, `image_touchups`, `video_auto_crop`, `image_brightness_and_contrast`, `enhance_cta`, `text_optimizations`, `inline_comment`, `image_uncrop`, `adapt_to_placement`, `media_type_automation`, `product_extensions`, `description_automation`, `add_text_overlay`, `image_animation`, `image_background_gen`, `video_filtering`, `video_uncrop`, `text_translation`, `image_text_translation`, `translate_voiceover`, `reveal_details_over_time`, `pac_relaxation`. (`music` goes through `asset_feed_spec`, not here.)

---

## 5. Advantage+ shopping/sales & the post-v25 "simplified" model

- Legacy ASC: campaign `objective: OUTCOME_SALES` + `smart_promotion_type: AUTOMATED_SHOPPING_ADS`, ad set with `promoted_object {pixel_id, custom_event_type}`, targeting limited to `geo_locations`, `billing_event: IMPRESSIONS`, goals `OFFSITE_CONVERSIONS`/`VALUE`, optional `existing_customer_budget_percentage`.
- **As of v25.0 the dedicated ASC API is retired.** A campaign is "Advantage+ on" when the three automation levers are set on a regular ODAX campaign: campaign-level budget (Advantage+ budget/CBO), `targeting_automation.advantage_audience: 1`, and default (unrestricted) placements. `existing_customer_budget_percentage` was deprecated with it. For a new CRM form, model this as three toggles on a normal `OUTCOME_SALES`/`OUTCOME_LEADS` campaign, not a separate campaign type.

---

## 6. Practical notes for the CRM form

- **Budgets are integer minor units** (SAR → halalas: 100 SAR = `10000`). Currency comes from the ad account, not the request.
- **Creation order & minimum viable payload:** campaign (`name`, `objective`, `special_ad_categories`, `status`) → ad set (`name`, `campaign_id`, budget, `optimization_goal`, `billing_event`, `targeting.geo_locations`, `promoted_object` when goal needs one, `status`) → creative (`object_story_spec` with `page_id` + one data block) → ad (`name`, `adset_id`, `creative_id`, `status`).
- **Identities:** every creative needs `page_id`; Instagram delivery uses the linked IG account or `instagram_user_id`. Instagram-only = placement selection (§3.5), not a different endpoint.
- **Validation without spending:** pass `execution_options: ["validate_only"]` on ad set/ad creation — ideal for a form's "check" button.
- The objective→goal→destination matrix (§2.3) is the single biggest source of API errors; enforce it in the form rather than free-combining enums.
