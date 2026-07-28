-- ============================================================================
-- Saved views for the content board.
--
-- The board has search, an owner filter, a platform filter, an incomplete-only
-- toggle and three layouts. All of it resets on reload, so anyone who works
-- from a particular slice — "my reels awaiting a caption", "everything blocked
-- this week" — rebuilds it by hand every time they open the page.
--
-- TWO DECISIONS WORTH STATING
--
-- 1. `filters` is jsonb, not a column per filter. The board's filter set has
--    already changed twice this week; a column each would mean a migration
--    every time one is added, and old saved views would silently lose the
--    filters they were saved with. Unknown keys are ignored on read, so a view
--    saved by a newer client still opens in an older one.
--
-- 2. A shared view stays OWNED by whoever wrote it. Everyone can SEE it;
--    only the author can change or delete it. "Shared" meaning "anyone may
--    rewrite it" is how a team's saved views quietly become one person's.
--
-- `view_mode` is stored beside the filters rather than inside them because it
-- is not a filter — a saved view that reopens in the wrong layout is only half
-- saved, but it also must not be mistaken for a predicate.
--
-- Idempotent.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.mkt_content_saved_views (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  -- The author. NOT NULL because an ownerless view is one nobody can maintain.
  owner_user_id   uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  is_shared       boolean NOT NULL DEFAULT false,
  -- The AUTHOR's default. Someone else adopting a shared view as their own
  -- default would need a per-user preference row; that is a real feature, not
  -- something to fake by letting them write this flag on a row they do not own.
  is_default      boolean NOT NULL DEFAULT false,
  filters         jsonb NOT NULL DEFAULT '{}'::jsonb,
  view_mode       text NOT NULL DEFAULT 'pipeline',
  sort_order      integer NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mkt_csv_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT mkt_csv_view_mode_check CHECK (view_mode IN ('pipeline','table','calendar')),
  -- Guards against a client sending an array or a scalar into a column every
  -- reader will treat as an object.
  CONSTRAINT mkt_csv_filters_is_object CHECK (jsonb_typeof(filters) = 'object')
);

-- One name per person. Saving "my reels" twice should update the view you
-- already have, not leave two rows that differ invisibly.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_csv_name_unique
  ON public.mkt_content_saved_views(owner_user_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS mkt_csv_one_default
  ON public.mkt_content_saved_views(owner_user_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_mkt_csv_visible
  ON public.mkt_content_saved_views(owner_user_id, sort_order);

CREATE OR REPLACE FUNCTION public.mkt_tg_saved_view_touch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  NEW.updated_at := now();
  -- Marking one default clears the previous one rather than colliding with the
  -- unique index and showing the user a constraint error for a normal action.
  IF NEW.is_default THEN
    UPDATE public.mkt_content_saved_views
       SET is_default = false
     WHERE owner_user_id = NEW.owner_user_id AND id <> NEW.id AND is_default;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_csv_touch ON public.mkt_content_saved_views;
CREATE TRIGGER mkt_csv_touch BEFORE INSERT OR UPDATE ON public.mkt_content_saved_views
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_saved_view_touch();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Saving a view is a reading preference, not a content write: anyone who can
-- READ marketing may keep their own views. Editing is owner-only, shared or not.
ALTER TABLE public.mkt_content_saved_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mkt_csv_read ON public.mkt_content_saved_views;
DROP POLICY IF EXISTS mkt_csv_ins  ON public.mkt_content_saved_views;
DROP POLICY IF EXISTS mkt_csv_upd  ON public.mkt_content_saved_views;
DROP POLICY IF EXISTS mkt_csv_del  ON public.mkt_content_saved_views;

CREATE POLICY mkt_csv_read ON public.mkt_content_saved_views FOR SELECT TO authenticated
  USING (public.wassell_mkt_can('read', auth.uid())
         AND (is_shared OR owner_user_id = public.wassell_app_user_id(auth.uid())));

CREATE POLICY mkt_csv_ins ON public.mkt_content_saved_views FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mkt_can('read', auth.uid())
              AND owner_user_id = public.wassell_app_user_id(auth.uid()));

CREATE POLICY mkt_csv_upd ON public.mkt_content_saved_views FOR UPDATE TO authenticated
  USING (owner_user_id = public.wassell_app_user_id(auth.uid()))
  WITH CHECK (owner_user_id = public.wassell_app_user_id(auth.uid()));

CREATE POLICY mkt_csv_del ON public.mkt_content_saved_views FOR DELETE TO authenticated
  USING (owner_user_id = public.wassell_app_user_id(auth.uid()));

-- ── Save-or-update in one call ──────────────────────────────────────────────
-- The name is the identity from the user's point of view: pressing "save" on a
-- name they already used means "update that one". Doing this client-side would
-- be a read-then-write race, and would show a unique-violation for what is a
-- perfectly ordinary action.
CREATE OR REPLACE FUNCTION public.mkt_content_save_view(
  p_name       text,
  p_filters    jsonb,
  p_view_mode  text    DEFAULT 'pipeline',
  p_is_shared  boolean DEFAULT false,
  p_is_default boolean DEFAULT false
) RETURNS public.mkt_content_saved_views
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE me uuid; out_row public.mkt_content_saved_views;
BEGIN
  me := public.wassell_app_user_id(auth.uid());
  IF me IS NULL THEN
    RAISE EXCEPTION 'no signed-in user' USING ERRCODE='insufficient_privilege';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'a saved view needs a name' USING ERRCODE='invalid_parameter_value';
  END IF;

  INSERT INTO public.mkt_content_saved_views
    (name, owner_user_id, filters, view_mode, is_shared, is_default)
  VALUES
    (btrim(p_name), me, COALESCE(p_filters, '{}'::jsonb),
     COALESCE(p_view_mode, 'pipeline'), COALESCE(p_is_shared, false),
     COALESCE(p_is_default, false))
  ON CONFLICT (owner_user_id, lower(btrim(name))) DO UPDATE
    SET filters    = EXCLUDED.filters,
        view_mode  = EXCLUDED.view_mode,
        is_shared  = EXCLUDED.is_shared,
        is_default = EXCLUDED.is_default,
        updated_at = now()
  RETURNING * INTO out_row;

  RETURN out_row;
END $$;

COMMIT;
