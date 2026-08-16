# Freeze baseline — extracted production source of truth

Last updated: 2026-08-16

Everything `2026-09-03_02_market_listings_freeze_baseline.sql` must reproduce, extracted
read-only from `wassell-prod` (`BEGIN READ ONLY`, `transaction_read_only = on`, zero
mutations). This file exists so the baseline can be authored **mechanically**, without
re-measuring production.

Nothing here is new public exposure: the same functions, policies and views are already
present in the committed `supabase/branch-bootstrap-*.sql`, which are generated from the
live catalogs.

---

## 1. Fingerprint targets

| Target | md5 |
|---|---|
| **L1** normalized generator-input (83 fields; UUID/label-independent) | `f1b79167fa6becc5b262ae9d3cca0eaa` |
| **L2** `regenerate_frozen_model_artifacts` functiondef | `415e0006b8be1eb6200c147b336bfcfe` |
| Raw `md5(models.schema)` — **production identity evidence only, never an L1 pin** | `44e7ce3ffc050cba5f49b97b5667cf83` |
| `frozen_view` qual | `6087e8fdcfcb9f3df3da7898c1163c18` |
| `frozen_update` qual **and** withcheck (identical) | `9f0255206b5395282618aa80bd147719` |
| `frozen_delete` qual | `5c85c440b19c5541a150f8b6f57922a5` |
| `frozen_insert` withcheck | `4928c9574ded1309015b08236950b256` |
| `market_listings_view_fast` qual (permissive) | `b80e72543ad3b57e163b283456f62418` |
| `market_listings_view_deny_none` qual (restrictive) | `4f400ee19d9149b0554841e4e1086075` |
| `market_listings_v` viewdef | `09af7a872c06f8d3acc81b7ebe5c82ec` |
| `unified_records` viewdef (five-way) | `74602527636617c3549508a67fcc220d` |
| `market_listings_summary` viewdef | `0ddd7ab480fcf167ca9d684d9c1f2db6` |
| `v_market_listings` viewdef | `3675d4c9bab1019312eae01035ab18ba` |
| `v_market_properties` viewdef | `416a3eaac713f2eaf27d46f8867c5d4a` |
| `wassell_view_scope_class` functiondef | `0bcfabe9df9da91ea4d874104fec65d6` |
| `wassell_can_view_jsonb` functiondef | `c9a781616085d3b06eec12d68238b502` |

The six the **unmodified** `2026-09-04_00` pins are: the three view md5s, `frozen_view`'s
qual, and the two function md5s. All three views must be plain views owned by `postgres`.

### L1 recipe (reproducible; re-run to re-derive)

Per field, joined `|`: `name`, `type`, `required` (default `false`), `width`, `is_multi`
(default `false`), `default`, `validation`, lookup target resolved to the **model slug**
(not UUID), `lookup_display_field`, and dropdown option `value`s sorted and comma-joined.
Field `id` and all display labels are excluded. Signatures joined with `\n` ordered by
`(name, sig)`, then `md5`. Yields 83 fields → `f1b79167fa6becc5b262ae9d3cca0eaa`.

---

## 2. Two traps that will silently break reproduction

**2.1 — `wassell_can_view_jsonb`'s stored body uses CRLF.** Its `pg_get_functiondef` text
contains `\r\n` inside `$function$…$function$`. Because `.gitattributes` normalizes the repo
to LF, a fixture cannot carry those bytes literally. Create it by building the body with LF
and restoring CRLF at execution time, e.g.
`EXECUTE replace(v_body, E'\n', E'\r\n')`. `wassell_view_scope_class` is plain LF — do **not**
apply the same transform to it.

**2.2 — production has FOUR frozen models.** `unified_records` is
`records ∪ cities_v ∪ districts_v ∪ market_listings_v ∪ regions_v`, in that order
(alphabetical after `records`). The predecessor fixture must therefore already carry the
frozen geography models, and the baseline rebuilds the **complete five-way** union. A
reduced union is not parity and will miss `74602527636617c3549508a67fcc220d`.

---

## 3. Physical shape

- 91 columns. Full ordered DDL: see §4.
- Constraints: `market_listings_pkey PRIMARY KEY (id)`;
  `market_listings_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL`.
- Junctions: `market_listings__features`, `market_listings__basic_info_missing_keys`
  (both `(record_id uuid, value text)`, referenced by `market_listings_v`).
- 13 indexes: `idx_market_listings_dupe_group_id`, `idx_ml_bedrooms`, `idx_ml_created_at (created_at DESC)`,
  `idx_ml_dupe`, `idx_ml_emirate`, `idx_ml_enrich_pending (source, created_at) WHERE detail_enriched_at IS NULL`,
  `idx_ml_is_active`, `idx_ml_permit_key`, `idx_ml_price`, `idx_ml_scraped_at (scraped_at DESC)`,
  `idx_ml_source`, `idx_ml_source_ext (source, external_id)`, `market_listings_pkey`.
- RLS enabled; owner `postgres`; `models.id = 8f06bc39-4bee-42e9-9fab-77023fb89ede`,
  `is_hardcoded = true`, `table_name = 'market_listings'`.
- Six policies, all `TO authenticated`: `frozen_view` (permissive SELECT),
  `frozen_insert` (permissive INSERT), `frozen_update` (permissive UPDATE),
  `frozen_delete` (permissive DELETE), `market_listings_view_fast` (permissive SELECT),
  `market_listings_view_deny_none` (**restrictive** SELECT). The last two are created by
  `2026-09-04_00`, **not** by the baseline — the baseline must leave
  `market_listings_view_fast` absent, which that migration's preflight relies on.

## 4. Column DDL (verbatim, ordered)

```sql
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  external_id text, source text, source_url text, title text, listing_type text,
  category text, property_type text, price numeric, description text, location text,
  title_ar text, description_ar text, plot_area numeric, furnished text,
  completion_status text, emirate text, community text, building text,
  permit_number text, permit_key text, reference_number text, agency_name text,
  agent_whatsapp text, is_verified boolean, listed_at timestamptz,
  dupe_group_id text, dupe_role text, source_payload jsonb, area numeric,
  price_per_m2 numeric, bedrooms numeric, bathrooms numeric, living_rooms numeric,
  floors_count numeric, age text, frontage text, street_name text, location_url text,
  latitude numeric, longitude numeric, main_image_url text, image_count numeric,
  video_count numeric, advertiser_name text, advertiser_phone text, advertiser text,
  advertiser_rating numeric, ad_license_number text, ad_license_url text,
  is_active boolean, first_seen timestamptz, last_seen timestamptz, sold_at timestamptz,
  scraped_at timestamptz, source_last_updated_at timestamptz,
  description_char_count numeric, description_word_count numeric, feature_count numeric,
  basic_info_completed_count numeric, views_count numeric, deed_number text,
  street_width numeric, quality_score numeric, quality_grade text,
  quality_breakdown jsonb, scraped_extras jsonb,
  custom_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  area_sqft numeric, plot_area_sqft numeric, purpose text, property_age text,
  handover text, zone_name text, tour_url text, listed_by text, whatsapp_number text,
  ded_license_number text, brn text, detail_enriched_at timestamptz,
  enrich_status text, enrich_attempts integer NOT NULL DEFAULT 0,
  developer text, project_name text, dupe_split boolean,
  image_urls jsonb, video_urls jsonb
```

`image_urls` / `video_urls` are `jsonb` (converted by `2026-08-09_03`); a `text` column here
reproduces neither `market_listings_v` nor the frozen policy predicates.

## 5. Policy predicates

All four share one generated jsonb projection. `frozen_view` calls
`wassell_can_view_jsonb`; `frozen_update` (qual **and** withcheck) and `frozen_delete` call
`wassell_can_edit_jsonb`; `frozen_delete` additionally `AND`s
`wassell_user_has_action(…, 'delete')` and wraps the whole predicate in parentheses.
`frozen_insert` is the short one:

```
wassell_user_has_action(( SELECT auth.uid() AS uid), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid, 'create'::text)
```

The shared projection is three `jsonb_build_object(...)` groups concatenated with `||`, then
`|| COALESCE(custom_data, '{}'::jsonb)`, with every non-text column cast `(col)::text`.
Group 1 ends at `'developer', developer`; group 2 runs `'project_name'` → `'quality_breakdown'`;
group 3 is `jsonb_build_object('scraped_extras', (scraped_extras)::text)`.
Re-extract the exact bytes with:

```sql
SELECT polname, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass;
```

**Do not hand-retype these.** Round-trip them and assert the md5s in §1 inside the baseline
so a deparse mismatch fails loudly there rather than confusingly inside `2026-09-04_00`.

## 6. Views

`market_listings_v` — `jsonb_strip_nulls` over the same three-group projection **without**
`::text` casts, plus two correlated junction aggregates (`features`,
`basic_info_missing_keys`, each `jsonb_agg(value ORDER BY value)` defaulting to `'[]'`),
selecting `FROM market_listings t`, exposing `(id, model_id, data, created_by_user_id,
created_at, updated_at, version)`.

`v_market_listings` — flat passthrough of 89 columns `FROM market_listings` (no `dupe_split`).

`market_listings_summary` — 33-key `jsonb_strip_nulls(jsonb_build_object(...)) ||
COALESCE(custom_data,'{}')` `FROM market_listings t`, gated by a `CASE` on
`wassell_view_scope_class` (`all` → true, `none` → false, else `wassell_can_view_jsonb` on a
four-key slim object). Carries **no** `source_payload` — `2026-09-04_00` §2.7 asserts that.

`v_market_properties` — `WITH ml AS (… FROM unified_records WHERE model_id = <ml> AND
COALESCE(try_boolean(data->>'is_active'), true))`, `grp` aggregate, then
`SELECT DISTINCT ON (group_id)`. References `unified_records` **by name**, so its pinned md5
is independent of what that view unions.

`unified_records` — five-way `UNION ALL`, each branch selecting the seven columns:
`records`, `cities_v`, `districts_v`, `market_listings_v`, `regions_v`.

## 7. Predecessor functions the fixture must carry byte-exactly

`wassell_view_scope_class(auth_user_id uuid, the_model_id uuid) RETURNS text`,
`LANGUAGE plpgsql`, `STABLE SECURITY DEFINER`, `SET search_path TO 'public', 'pg_temp'`.
Body reads `profiles` joined to `users` on `profile_id`/`auth_uid`/`is_active`, returns
`all` for `is_admin`, resolves `model_permissions` → `view_scope`, and returns
`all`/`none`/`filtered`. The NULL-caller branch returns `all` only for `service_role`
(via the JWT claim or `current_setting('role')`), else `none`. **LF body.**

`wassell_can_view_jsonb(uuid, uuid, uuid, uuid, jsonb) RETURNS boolean`, `LANGUAGE sql`,
`STABLE SECURITY DEFINER`, same `search_path`. Body ANDs
`wassell_user_has_action(…, 'view')` with `wassell_record_passes_scope(jsonb_populate_record(
NULL::records, …), auth_user_id, 'view')`. **CRLF body — see §2.1.**

Both therefore require `profiles`, `users`, `records`, `wassell_user_has_action` and
`wassell_record_passes_scope` to exist for the runtime RLS assertions (creation alone
tolerates absence under `SET check_function_bodies = off`).

## 8. Fresh-path order the CI must execute

1. Pre-freeze predecessor fixture — roles, `auth.uid()`, `users`, `profiles`, `records`,
   the `wassell_*` functions above, the frozen geography models (`cities`, `districts`,
   `regions`) with their `_v` views, the three-way `unified_records`, and
   `v_our_projects_scope` / `v_website_public` so the view-chain unwind is exercised.
2. `2026-09-03_02_market_listings_freeze_baseline.sql`
3. **Unmodified** `2026-09-04_00_market_listings_view_reconciliation.sql`
4. `2026-09-05_01…04`
5. `2026-09-05_06_listing_provenance_outbox.sql`
6. Final assertions — five-way `unified_records` md5, six-policy state, grants,
   idempotency, fail-closed drift.

The baseline must unwind the dependent chain before rebuilding `unified_records`
(`v_website_public`, `v_our_projects_scope`, `v_market_properties` → `unified_records`),
preserving each dependent's `reloptions` and grants, per CLAUDE.md.
