-- Internal Marketing Management (إدارة التسويق)
-- Applied to production as Supabase migration 20260727092044 — "mkt_mgmt_integrity_and_permissions".
-- Exported verbatim from schema_migrations so repo and database cannot drift.

-- ── Marketing role grants (additive: existing users/profiles untouched) ────
CREATE TABLE IF NOT EXISTS public.mkt_role_grants (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  mkt_role text NOT NULL CHECK (mkt_role IN ('administrator','marketing_manager','content_manager',
    'writer','designer','video_editor','publisher','reviewer','sales','viewer')),
  granted_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Effective marketing role: an app admin is always administrator.
CREATE OR REPLACE FUNCTION public.wassell_mkt_role(p_auth_uid uuid DEFAULT auth.uid())
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT CASE
    WHEN p_auth_uid IS NULL THEN 'none'
    WHEN public.wassell_is_admin(p_auth_uid) THEN 'administrator'
    ELSE COALESCE((SELECT g.mkt_role FROM public.mkt_role_grants g
                    WHERE g.user_id = public.wassell_app_user_id(p_auth_uid)), 'viewer')
  END;
$$;

-- Capability matrix, enforced in the DATABASE — not just hidden buttons.
CREATE OR REPLACE FUNCTION public.wassell_mkt_can(p_capability text, p_auth_uid uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT CASE public.wassell_mkt_role(p_auth_uid)
    WHEN 'administrator'     THEN true
    WHEN 'marketing_manager' THEN true
    WHEN 'content_manager'   THEN p_capability IN ('read','write_content','write_campaign','comment','assign','schedule','approve_content')
    WHEN 'writer'            THEN p_capability IN ('read','write_content','comment')
    WHEN 'designer'          THEN p_capability IN ('read','write_content','comment')
    WHEN 'video_editor'      THEN p_capability IN ('read','write_content','comment')
    WHEN 'publisher'         THEN p_capability IN ('read','comment','schedule','publish')
    WHEN 'reviewer'          THEN p_capability IN ('read','comment','approve_content')
    WHEN 'sales'             THEN p_capability IN ('read','comment')
    WHEN 'viewer'            THEN p_capability = 'read'
    ELSE false
  END;
$$;
GRANT EXECUTE ON FUNCTION public.wassell_mkt_role(uuid)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wassell_mkt_can(text,uuid) TO authenticated, service_role;

-- ── Status machine: invalid jumps are rejected by the database ─────────────
CREATE OR REPLACE FUNCTION public.mkt_content_status_allowed(p_from text, p_to text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_from = p_to OR p_to IN ('cancelled','archived') OR
    (p_from, p_to) IN (
      ('idea','brief'),
      ('brief','writing'),('brief','idea'),
      ('writing','awaiting_script_approval'),('writing','brief'),
      ('awaiting_script_approval','approved_for_production'),
      ('awaiting_script_approval','revision_requested'),('awaiting_script_approval','writing'),
      ('approved_for_production','raw_assets_required'),('approved_for_production','recording'),
      ('approved_for_production','designing'),('approved_for_production','editing'),
      ('raw_assets_required','recording'),('raw_assets_required','designing'),('raw_assets_required','editing'),
      ('recording','editing'),('recording','internal_review'),
      ('designing','internal_review'),
      ('editing','internal_review'),
      ('internal_review','revision_requested'),('internal_review','awaiting_final_approval'),
      ('revision_requested','writing'),('revision_requested','recording'),
      ('revision_requested','designing'),('revision_requested','editing'),('revision_requested','internal_review'),
      ('awaiting_final_approval','approved'),('awaiting_final_approval','revision_requested'),
      ('approved','ready_to_publish'),('approved','revision_requested'),
      ('ready_to_publish','scheduled'),('ready_to_publish','published'),('ready_to_publish','approved'),
      ('scheduled','published'),('scheduled','ready_to_publish'),
      ('cancelled','idea')
    );
$$;

CREATE OR REPLACE FUNCTION public.mkt_tg_content_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT public.mkt_content_status_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'invalid content status transition: % -> % (content %)',
        OLD.status, NEW.status, OLD.content_number
        USING ERRCODE='check_violation';
    END IF;
    INSERT INTO public.mkt_content_status_history(content_item_id, from_status, to_status, changed_by_user_id, reason)
    VALUES (NEW.id, OLD.status, NEW.status, public.wassell_app_user_id(auth.uid()), NULLIF(current_setting('wassell.status_reason', true),''));
  ELSIF TG_OP='INSERT' THEN
    INSERT INTO public.mkt_content_status_history(content_item_id, from_status, to_status, changed_by_user_id, reason)
    VALUES (NEW.id, NULL, NEW.status, COALESCE(NEW.created_by_user_id, public.wassell_app_user_id(auth.uid())), 'created');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_content_status_tg ON public.mkt_content_items;
CREATE TRIGGER mkt_content_status_tg
  BEFORE INSERT OR UPDATE ON public.mkt_content_items
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_content_status();

-- history rows are append-only
CREATE OR REPLACE FUNCTION public.mkt_tg_history_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'mkt_content_status_history is append-only (attempted % )', TG_OP
    USING ERRCODE='check_violation';
END $$;
DROP TRIGGER IF EXISTS mkt_history_immutable_tg ON public.mkt_content_status_history;
CREATE TRIGGER mkt_history_immutable_tg
  BEFORE UPDATE OR DELETE ON public.mkt_content_status_history
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_history_append_only();

-- ── Version immutability: approved/published versions are never rewritten ──
CREATE OR REPLACE FUNCTION public.mkt_tg_version_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.is_locked THEN
    -- Only the supersede/关 bookkeeping columns may move on a locked version.
    IF NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.file_id IS DISTINCT FROM OLD.file_id
       OR NEW.version_type IS DISTINCT FROM OLD.version_type
       OR NEW.version_number IS DISTINCT FROM OLD.version_number
       OR NEW.content_item_id IS DISTINCT FROM OLD.content_item_id THEN
      RAISE EXCEPTION 'version % of % is locked (state %) — create a NEW version instead of editing it',
        OLD.version_number, OLD.version_type, OLD.approval_state
        USING ERRCODE='check_violation';
    END IF;
  END IF;
  -- approving locks it
  IF NEW.approval_state='approved' AND (TG_OP='INSERT' OR OLD.approval_state IS DISTINCT FROM 'approved') THEN
    NEW.is_locked := true;
    NEW.approved_at := COALESCE(NEW.approved_at, now());
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mkt_version_immutable_tg ON public.mkt_content_versions;
CREATE TRIGGER mkt_version_immutable_tg
  BEFORE INSERT OR UPDATE ON public.mkt_content_versions
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_version_immutable();

CREATE OR REPLACE FUNCTION public.mkt_tg_version_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_locked THEN
    RAISE EXCEPTION 'approved/published versions cannot be deleted (version % %)', OLD.version_type, OLD.version_number
      USING ERRCODE='check_violation';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS mkt_version_no_delete_tg ON public.mkt_content_versions;
CREATE TRIGGER mkt_version_no_delete_tg
  BEFORE DELETE ON public.mkt_content_versions
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_version_no_delete();

-- generic updated_at
CREATE OR REPLACE FUNCTION public.mkt_tg_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mkt_internal_campaigns','mkt_video_scenes','mkt_carousel_slides',
    'mkt_raw_assets','mkt_content_tasks','mkt_publications','mkt_video_details','mkt_post_details']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t||'_touch_tg', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_touch_updated_at()', t||'_touch_tg', t);
  END LOOP;
END $$;

-- ── RLS: read for authenticated, writes gated by capability ────────────────
DO $$
DECLARE t text; cap text;
BEGIN
  FOR t, cap IN
    SELECT * FROM (VALUES
      ('mkt_internal_campaigns','write_campaign'), ('mkt_internal_campaign_projects','write_campaign'),
      ('mkt_internal_campaign_members','write_campaign'), ('mkt_content_items','write_content'),
      ('mkt_content_platforms','write_content'), ('mkt_content_versions','write_content'),
      ('mkt_video_details','write_content'), ('mkt_video_scenes','write_content'),
      ('mkt_post_details','write_content'), ('mkt_carousel_slides','write_content'),
      ('mkt_raw_assets','write_content'), ('mkt_asset_links','write_content'),
      ('mkt_content_tasks','write_content'), ('mkt_approvals','comment'),
      ('mkt_mgmt_comments','comment'), ('mkt_publications','schedule'),
      ('mkt_performance_snapshots','write_content'), ('mkt_lead_attributions','write_content'),
      ('mkt_intelligence_actions','write_content'), ('mkt_content_status_history','write_content'),
      ('mkt_mgmt_alerts','write_content'), ('mkt_role_grants','manage_roles')
    ) v(t,cap)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_read', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT USING (public.wassell_mkt_can('read'))$p$, t||'_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_ins', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (public.wassell_mkt_can(%L))$p$, t||'_ins', t, cap);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_upd', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR UPDATE USING (public.wassell_mkt_can(%L)) WITH CHECK (public.wassell_mkt_can(%L))$p$, t||'_upd', t, cap, cap);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_del', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR DELETE USING (public.wassell_mkt_can(%L))$p$, t||'_del', t, cap);
  END LOOP;
END $$;;
