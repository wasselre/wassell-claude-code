-- Reusable, team-shared GEOGRAPHICAL preference presets.
--
-- A preset is a named bundle of `location_items` (district / drawn-area /
-- geo-element rules) a rep saves once and applies to any client's preference
-- profile. The whole library is readable by every authenticated user (shared);
-- a preset can be deleted/renamed only by its creator or an admin.
--
-- Geography-only by design: budget/type/amenities live on per-client preference
-- profiles (clients.data.preference_profiles), not on shared presets. `city_id`
-- is the district city these items belong to (null = element-only / city-agnostic)
-- and is what the picker filters on so a Riyadh preset is not offered to a
-- Jeddah client.

CREATE TABLE IF NOT EXISTS public.preference_presets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  -- District city id (a districts/cities record id). Null for element-only presets.
  city_id            text,
  -- ISO-3166-1 alpha-2, a secondary scope for the picker.
  country_code       text,
  -- LocationItem[] — the same shape as clients.data.location_items.
  items              jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Owner = auth.uid() of the creator (mirrors media_assets), for owner-only delete.
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Picker filters by city; list is newest-first.
CREATE INDEX IF NOT EXISTS preference_presets_city_idx
  ON public.preference_presets (city_id, created_at DESC);

ALTER TABLE public.preference_presets ENABLE ROW LEVEL SECURITY;

-- Shared library: any authenticated user can read every preset.
DROP POLICY IF EXISTS preference_presets_select ON public.preference_presets;
CREATE POLICY preference_presets_select
  ON public.preference_presets FOR SELECT
  TO authenticated
  USING (true);

-- Any authenticated user can create a preset, stamped as its owner.
DROP POLICY IF EXISTS preference_presets_insert ON public.preference_presets;
CREATE POLICY preference_presets_insert
  ON public.preference_presets FOR INSERT
  TO authenticated
  WITH CHECK (created_by_user_id = (SELECT auth.uid()) OR created_by_user_id IS NULL);

-- Rename: the creator or an admin.
DROP POLICY IF EXISTS preference_presets_update ON public.preference_presets;
CREATE POLICY preference_presets_update
  ON public.preference_presets FOR UPDATE
  TO authenticated
  USING (created_by_user_id = (SELECT auth.uid()) OR public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (created_by_user_id = (SELECT auth.uid()) OR public.wassell_is_admin((SELECT auth.uid())));

-- Delete: the creator or an admin (so a shared preset is not wiped by anyone).
DROP POLICY IF EXISTS preference_presets_delete ON public.preference_presets;
CREATE POLICY preference_presets_delete
  ON public.preference_presets FOR DELETE
  TO authenticated
  USING (created_by_user_id = (SELECT auth.uid()) OR public.wassell_is_admin((SELECT auth.uid())));
