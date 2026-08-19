-- ============================================================================
-- Phase 3 · B5 — file_views (saved views) + the file_document_types read grant
--
-- B5 turns /files into the Library. Two database objects are needed for that
-- and nothing else: a place to keep a user's saved query, and permission to
-- read the 16-row document-type vocabulary B1 deliberately left locked.
--
-- NO authorization change. This migration adds no branch to
-- wassell_can_access_file, touches no policy on `files` or `file_links`, and
-- creates no path by which anyone can see a file they could not already see.
-- A saved view is a stored *query*; it is evaluated live through
-- business_files_search, which is SECURITY INVOKER, so two people opening the
-- same shared view correctly get different rows and different counts.
--
-- -- WHY THE SIX SEEDED VIEWS ARE NOT ROWS IN THIS TABLE ---------------------
-- The spec lists six system views to ship on day one (Unlinked, Recently
-- added, My files, Project pack, Marketing library, Expiring soon). They live
-- in src/lib/files/views.ts as code constants, not as seeded rows here. Three
-- reasons, all of which would have to be worked around to do it the other way:
--
--   1. They need BOTH labels. Every user-facing name in this product carries
--      label_ar and label_en; `file_views.name` is one column because a user
--      naming their own view types one string. Seeding system rows would mean
--      adding a second name column that only six rows ever use.
--   2. Two of them are not constant. "My files" filters on the CALLER, and
--      "Project pack" is a template that needs a project chosen. A row would
--      have to carry a placeholder the client rewrites -- at which point the
--      row is not the definition, the client is.
--   3. A row is a thing that can fail to load. A static definition cannot.
--      The Library's own views must not depend on a fetch that can be empty.
--
-- So: this table holds exactly what the spec says it is for -- a view a PERSON
-- saved. `visibility` decides whether their colleagues can also open it.
--
-- -- WHY A SHARED VIEW STAYS OWNED --------------------------------------------
-- Same rule the content board settled on (2026-08-29_01_content_saved_views):
-- everyone can SEE a shared view, only its author can change or delete it.
-- "Shared" meaning "anyone may rewrite it" is how a team's saved views quietly
-- become one person's.
--
-- Idempotent. Rollback: supabase/rollback/2026-08-19_10_file_views_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The table.
--
--    `filters` is jsonb rather than a column per filter for the same reason
--    business_files_search takes jsonb: the filter set is still moving, and a
--    column each would mean a migration every time one is added AND would
--    silently drop the filters an older saved view was written with. The RPC
--    ignores keys it does not know, so a view saved by a newer client still
--    opens -- degraded, not broken -- in an older one.
--
--    `q`, `grouping`, `sort` and `layout` are stored BESIDE the filters, not
--    inside them, because they are not predicates. A saved view that reopens
--    with the wrong grouping or the wrong layout is only half saved; but if
--    they lived in `filters` they would be handed to the RPC as filters, which
--    is a different bug.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.file_views (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  -- NOT NULL because an ownerless saved view is one nobody can maintain.
  owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  filters       jsonb   NOT NULL DEFAULT '{}'::jsonb,
  q             text,
  grouping      text    NOT NULL DEFAULT 'none',
  sort          text    NOT NULL DEFAULT 'created_desc',
  layout        text    NOT NULL DEFAULT 'grid',
  visibility    text    NOT NULL DEFAULT 'private',
  pinned        boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT file_views_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT file_views_name_len       CHECK (length(btrim(name)) <= 120),
  -- Guards against a client sending an array or a scalar into a column every
  -- reader will treat as an object -- including the RPC, which would then fail
  -- at `f ? 'document_type'` rather than at the write that caused it.
  CONSTRAINT file_views_filters_object CHECK (jsonb_typeof(filters) = 'object'),
  CONSTRAINT file_views_visibility_chk CHECK (visibility IN ('private','shared')),
  CONSTRAINT file_views_layout_chk     CHECK (layout IN ('grid','list')),
  CONSTRAINT file_views_grouping_chk   CHECK (grouping IN ('none','document_type','linked_model','owner','month')),
  -- Deliberately the SAME seven values business_files_search accepts. A saved
  -- view carrying an eighth would raise inside the RPC on every open, which is
  -- a confusing place to discover a bad write.
  CONSTRAINT file_views_sort_chk       CHECK (sort IN ('created_desc','created_asc','updated_desc',
                                                       'title_asc','title_desc','size_desc','size_asc'))
);

COMMENT ON TABLE  public.file_views IS
  'A saved Library query. Evaluated live through business_files_search (SECURITY INVOKER), so it has no membership and can never drift. The six SYSTEM views are code constants in src/lib/files/views.ts, not rows here.';
COMMENT ON COLUMN public.file_views.filters IS
  'Filter object passed verbatim to business_files_search. Unknown keys are ignored on read, so views survive both directions of a client version skew.';
COMMENT ON COLUMN public.file_views.visibility IS
  'private = only the owner may open it. shared = anyone may open it, but only the owner may change or delete it.';

-- Saving the same name twice means updating the view you already have, not
-- leaving two rows that differ invisibly. Case- and whitespace-insensitive
-- because "My Files" and "my files " are the same view to the person typing.
CREATE UNIQUE INDEX IF NOT EXISTS file_views_owner_name_uniq
  ON public.file_views (owner_user_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_file_views_owner  ON public.file_views (owner_user_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_file_views_shared ON public.file_views (visibility) WHERE visibility = 'shared';

-- ---------------------------------------------------------------------------
-- 2. updated_at. Its own trigger rather than a shared one, so nothing else's
--    behaviour changes if this ever needs to do more.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_file_views_touch()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $tg$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$tg$;

DROP TRIGGER IF EXISTS file_views_touch ON public.file_views;
CREATE TRIGGER file_views_touch
  BEFORE INSERT OR UPDATE ON public.file_views
  FOR EACH ROW EXECUTE FUNCTION public.tg_file_views_touch();

-- ---------------------------------------------------------------------------
-- 3. RLS.
--
--    Naming the roles explicitly on the REVOKE is not decoration: Supabase's
--    ALTER DEFAULT PRIVILEGES grants ALL on every new public table to
--    anon/authenticated, and `REVOKE ... FROM PUBLIC` does not touch a
--    role-specific grant. Phase 1 shipped a table to production with both
--    roles holding full DML for exactly this reason.
-- ---------------------------------------------------------------------------
ALTER TABLE public.file_views ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.file_views FROM PUBLIC;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.file_views FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.file_views FROM authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.file_views TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.file_views TO service_role;
  END IF;
END $g$;

DROP POLICY IF EXISTS file_views_select ON public.file_views;
DROP POLICY IF EXISTS file_views_insert ON public.file_views;
DROP POLICY IF EXISTS file_views_update ON public.file_views;
DROP POLICY IF EXISTS file_views_delete ON public.file_views;

CREATE POLICY file_views_select ON public.file_views FOR SELECT TO authenticated
  USING (visibility = 'shared'
         OR owner_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid()))));

CREATE POLICY file_views_insert ON public.file_views FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid()))));

CREATE POLICY file_views_update ON public.file_views FOR UPDATE TO authenticated
  USING      (owner_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid()))))
  WITH CHECK (owner_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid()))));

CREATE POLICY file_views_delete ON public.file_views FOR DELETE TO authenticated
  USING (owner_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid()))));

-- ---------------------------------------------------------------------------
-- 4. Save-or-update in one call.
--
--    From the user's point of view the NAME is the identity: pressing Save on
--    a name they already used means "update that one". Doing that client-side
--    is a read-then-write race, and it shows a unique-violation for what is a
--    perfectly ordinary action.
--
--    SECURITY INVOKER, so the policies above are still the only authority --
--    the function cannot write a row on someone else's behalf.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_views_save(
  p_name       text,
  p_filters    jsonb   DEFAULT '{}'::jsonb,
  p_q          text    DEFAULT NULL,
  p_grouping   text    DEFAULT 'none',
  p_sort       text    DEFAULT 'created_desc',
  p_layout     text    DEFAULT 'grid',
  p_visibility text    DEFAULT 'private',
  p_pinned     boolean DEFAULT false
) RETURNS public.file_views
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_me  uuid := public.wassell_app_user_id((SELECT auth.uid()));
  v_row public.file_views;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'file_views_save: caller is not a Wassell user'
      USING HINT = 'The signed-in account has no row in public.users (auth_uid unbound).';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'file_views_save: a view needs a name';
  END IF;

  INSERT INTO public.file_views AS v
    (name, owner_user_id, filters, q, grouping, sort, layout, visibility, pinned)
  VALUES
    (btrim(p_name), v_me, coalesce(p_filters, '{}'::jsonb), nullif(btrim(coalesce(p_q,'')), ''),
     coalesce(p_grouping,'none'), coalesce(p_sort,'created_desc'),
     coalesce(p_layout,'grid'), coalesce(p_visibility,'private'), coalesce(p_pinned,false))
  ON CONFLICT (owner_user_id, lower(btrim(name))) DO UPDATE
     SET name       = EXCLUDED.name,
         filters    = EXCLUDED.filters,
         q          = EXCLUDED.q,
         grouping   = EXCLUDED.grouping,
         sort       = EXCLUDED.sort,
         layout     = EXCLUDED.layout,
         visibility = EXCLUDED.visibility,
         pinned     = EXCLUDED.pinned
  RETURNING v.* INTO v_row;

  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.file_views_save(text, jsonb, text, text, text, text, text, boolean) FROM PUBLIC;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.file_views_save(text, jsonb, text, text, text, text, text, boolean) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.file_views_save(text, jsonb, text, text, text, text, text, boolean) TO authenticated;
  END IF;
END $g$;

-- ---------------------------------------------------------------------------
-- 5. The document-type vocabulary becomes readable.
--
--    B1 created file_document_types with RLS on and NO policy, and said so in
--    its own header: "B5 adds the read policy when the Library UI actually
--    needs it." This is that moment -- the filter bar and the metadata editor
--    both render its bilingual labels, and today `authenticated` cannot SELECT
--    a single row of it.
--
--    Read-only, and only the ACTIVE rows: deactivating a type should remove it
--    from the pickers. Files already carrying a deactivated type keep it (the
--    FK is on `value`, not on `active`), and the client falls back to the raw
--    value as its own label, so a deactivated type degrades to a plain string
--    rather than vanishing from a file that has one.
--
--    Writes stay closed. Changing the vocabulary is a migration, not a UI
--    action -- every value is referenced by an FK from files.document_type and
--    document_links.role.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS file_document_types_select ON public.file_document_types;
CREATE POLICY file_document_types_select ON public.file_document_types FOR SELECT TO authenticated
  USING (active);

DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    GRANT SELECT ON public.file_document_types TO authenticated;
  END IF;
  -- service_role reads it in the workers' document paths; it bypasses RLS but
  -- still needs the table grant.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT ON public.file_document_types TO service_role;
  END IF;
END $g$;

COMMIT;
