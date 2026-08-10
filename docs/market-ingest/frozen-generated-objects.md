# Frozen generated objects + raw Storage policies (captured for review)

These objects are reproduced by migration `01`'s **pinned regeneration** (fresh DB) or **asserted present** (production). They are captured here verbatim from the live database (2026-09-03) so they are reviewable in source control even though `01` applies them via `regenerate_frozen_model_artifacts()` under the pinned `md5(models.schema)=44e7ce3ffc050cba5f49b97b5667cf83`.

## Frozen RLS policies on `public.market_listings`
All four policies target role `authenticated`. They pass a full record reconstruction (the "record literal" below) into the Wassell scope evaluators. The reconstruction is the deterministic per-column expression the freeze generator emits.

**Record literal `R`** (used by view/update/delete; abbreviated — all 90 scalar columns, each cast to text, plus `custom_data`):
```sql
R := ((jsonb_build_object(
        'external_id', external_id, 'source', source, 'source_url', source_url, 'title', title,
        'listing_type', listing_type, 'category', category, 'property_type', property_type,
        'price', (price)::text, 'description', description, 'location', location,
        'title_ar', title_ar, 'description_ar', description_ar, 'plot_area', (plot_area)::text,
        /* … furnished, completion_status, emirate, community, building, permit_number, permit_key,
             reference_number, agency_name, agent_whatsapp, is_verified::text, listed_at::text,
             dupe_group_id, dupe_role, source_payload::text, area_sqft::text, plot_area_sqft::text,
             purpose, property_age, handover, zone_name, tour_url, listed_by, whatsapp_number,
             ded_license_number, brn, developer … */
      ) || jsonb_build_object(
        'project_name', project_name, 'area', (area)::text, 'price_per_m2', (price_per_m2)::text,
        'bedrooms', (bedrooms)::text, 'bathrooms', (bathrooms)::text, /* … through quality_breakdown::text */
      ) || jsonb_build_object('scraped_extras', (scraped_extras)::text))
      || COALESCE(custom_data, '{}'::jsonb));
```
(The full, un-abbreviated expression is exactly the live `pg_policy` definition; it is regenerated, not hand-maintained.)

```sql
-- SELECT
CREATE POLICY frozen_view   ON public.market_listings FOR SELECT TO authenticated
  USING ( public.wassell_can_view_jsonb((SELECT auth.uid()), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid,
                                         id, created_by_user_id, R) );
-- INSERT
CREATE POLICY frozen_insert ON public.market_listings FOR INSERT TO authenticated
  WITH CHECK ( public.wassell_user_has_action((SELECT auth.uid()), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid, 'create') );
-- UPDATE
CREATE POLICY frozen_update ON public.market_listings FOR UPDATE TO authenticated
  USING      ( public.wassell_can_edit_jsonb((SELECT auth.uid()), '8f06bc39-…'::uuid, id, created_by_user_id, R) )
  WITH CHECK ( public.wassell_can_edit_jsonb((SELECT auth.uid()), '8f06bc39-…'::uuid, id, created_by_user_id, R) );
-- DELETE
CREATE POLICY frozen_delete ON public.market_listings FOR DELETE TO authenticated
  USING ( public.wassell_can_edit_jsonb((SELECT auth.uid()), '8f06bc39-…'::uuid, id, created_by_user_id, R)
          AND public.wassell_user_has_action((SELECT auth.uid()), '8f06bc39-…'::uuid, 'delete') );
```

## Views (security_invoker flags, from live `pg_class.reloptions`)
- `public.market_listings_v` — `security_invoker=true` (generated JSONB-shape view over the frozen columns).
- `public.unified_records` — `security_invoker=true` (UNION of `records` + each frozen model's `_v`).
- `public.v_market_properties` — **`security_invoker=false`** (definition folded verbatim into migration `01`).

## `market-raw` private bucket + ENFORCEABLE Storage policies (applied at Gate B)
Not part of the five schema migrations (Storage layer). **`service_role` has BYPASSRLS**, so an "insert-only" guarantee cannot rely on the worker using the `service_role` key. Enforcement uses a dedicated **non-bypass** uploader role; the worker uploads with a scoped JWT for that role, never the `service_role` key.
```sql
-- bucket (private, no public read)
INSERT INTO storage.buckets (id, name, public) VALUES ('market-raw','market-raw', false)
ON CONFLICT (id) DO NOTHING;

-- dedicated uploader role: NOLOGIN, NOT bypassrls, assumable via a scoped JWT.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='market_raw_uploader') THEN
    CREATE ROLE market_raw_uploader NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT market_raw_uploader TO authenticator;   -- lets a JWT with role=market_raw_uploader assume it

-- INSERT only, for the uploader role only (content-addressed; upsert=false, so an
-- existing hash is a no-op, never an overwrite). No UPDATE/DELETE policy exists for
-- ANY application role → immutable to app + ingestion roles.
CREATE POLICY market_raw_upload ON storage.objects FOR INSERT TO market_raw_uploader
  WITH CHECK ( bucket_id = 'market-raw' );

-- READ: admin only, via signed URLs minted by an admin RPC. No anon, no blanket authenticated.
CREATE POLICY market_raw_admin_read ON storage.objects FOR SELECT TO authenticated
  USING ( bucket_id = 'market-raw' AND public.wassell_is_admin((SELECT auth.uid())) );
```
**Threat boundary (honest):**
- Immutable to `anon`, `authenticated`, and `market_raw_uploader` (INSERT-only, non-bypass) — i.e. all application/ingestion roles.
- Mutable ONLY via `postgres` / `service_role` (BYPASSRLS) = explicit emergency/admin infrastructure authority; **no routine worker uses these for `market-raw`** (the worker holds only the uploader JWT).
- Content-addressed key `market-raw/<source>/<sha256>[.gz]`, `upsert=false`; **hash verification** (`sha256(bytes)=key`) before `raw_blobs.content_hash` is recorded.
- Any DELETE/UPDATE on `market-raw` (possible only via infra authority) is **audited + alerted**; `storage.protect_delete` refuses direct SQL DELETE on `storage.objects`. No routine worker receives delete authority.
- **Gate-B verification:** confirm the current Supabase Storage version honors a custom `role` JWT claim for `market_raw_uploader`; if not, use an INSERT-only edge signer that never holds the `service_role` key.
- **Existing assets:** `listing-photos` referenced not copied (`existing_storage_ref` / `durable_existing_asset`); Aqar Cloudflare HLS on Aqar's Stream account (`customer-tcdl2qnu9671k3x4…`) is `external_reference_only`.
