-- Marketing runs on three roles: Manager, Writer, Montage (2026-10-04).
--
-- The CEO and Operations-supervisor roles are retired:
--   · mos_ceo was held only by an app admin, who keeps full access as admin
--     (wassell_mos_can bypasses for admins; campaign signing already accepts
--     'administrator'). Keeping the role meant the task planner could route
--     work to him.
--   · mos_ops_supervisor has had no holder since 2026-09-12, so the one step it
--     owned («جمع المواد», Standard video) opened tasks nobody received.
--
-- Changes:
--   1. rate_creative (held ONLY by the CEO) moves to the Manager — otherwise it
--      would vanish for everyone, admins included (admin = union of all role
--      capabilities).
--   2. The Manager receives «ميزانية تنتظر توقيعك» (in-app + WhatsApp); the
--      server now addresses budget_signature to the Manager.
--   3. The Standard video «جمع المواد» step moves to Montage (who edits next).
--   4. Both role ids are stripped from users.role_assignments, then the role
--      rows are deleted (their capabilities, notification rules, surface access,
--      load and SLA rows cascade).
--
-- Historic workflow_role_tasks keep their role_key text (21 done + 1 skipped for
-- ops_supervisor) and the CHECK constraint still allows the old keys, so history
-- stays readable. Everything removed is in _backup_mos_retired_roles_20261004
-- (one row per source row, as jsonb) for a restore.

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_mos_retired_roles_20261004 (
  source text NOT NULL,
  row_data jsonb NOT NULL
);
REVOKE ALL ON public._backup_mos_retired_roles_20261004 FROM anon, authenticated;

INSERT INTO public._backup_mos_retired_roles_20261004 (source, row_data)
SELECT 'roles', to_jsonb(r) FROM public.roles r WHERE r.key IN ('mos_ceo', 'mos_ops_supervisor')
UNION ALL
SELECT 'role_capabilities', to_jsonb(x) FROM public.role_capabilities x
  JOIN public.roles r ON r.id = x.role_id WHERE r.key IN ('mos_ceo', 'mos_ops_supervisor')
UNION ALL
SELECT 'notification_rules', to_jsonb(x) FROM public.notification_rules x
  JOIN public.roles r ON r.id = x.role_id WHERE r.key IN ('mos_ceo', 'mos_ops_supervisor')
UNION ALL
SELECT 'surface_access', to_jsonb(x) FROM public.surface_access x
  JOIN public.roles r ON r.id = x.role_id WHERE r.key IN ('mos_ceo', 'mos_ops_supervisor')
UNION ALL
SELECT 'mos_role_load', to_jsonb(x) FROM public.mos_role_load x
  JOIN public.roles r ON r.id = x.role_id WHERE r.key IN ('mos_ceo', 'mos_ops_supervisor')
UNION ALL
SELECT 'mos_role_sla', to_jsonb(x) FROM public.mos_role_sla x
  JOIN public.roles r ON r.id = x.role_id WHERE r.key IN ('mos_ceo', 'mos_ops_supervisor')
UNION ALL
SELECT 'users.role_assignments', jsonb_build_object('id', u.id, 'role_assignments', u.role_assignments)
  FROM public.users u
 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
                JOIN public.roles r ON r.id::text = e->>'role_id'
               WHERE r.key IN ('mos_ceo', 'mos_ops_supervisor'))
UNION ALL
SELECT 'workflows', to_jsonb(w) FROM public.workflows w
 WHERE w.kind = 'role_path'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(w.metadata->'steps', '[]'::jsonb)) s
               WHERE s->>'role_key' IN ('ceo', 'ops_supervisor'));

-- 1. rate_creative → Manager.
INSERT INTO public.role_capabilities (role_id, capability)
SELECT r.id, 'rate_creative' FROM public.roles r WHERE r.key = 'mos_marketing_manager'
ON CONFLICT DO NOTHING;

-- 2. Budget-signature notifications → Manager.
INSERT INTO public.notification_rules (role_id, event, channel, timing, enabled)
SELECT r.id, 'budget_signature', ch, 'immediate', true
  FROM public.roles r CROSS JOIN (VALUES ('inapp'), ('whatsapp')) v(ch)
 WHERE r.key = 'mos_marketing_manager'
ON CONFLICT (role_id, event, channel) DO UPDATE SET enabled = true;

-- 3. Steps owned by a retired role: ops_supervisor → montage, ceo → marketing_manager.
UPDATE public.workflows w
   SET metadata = jsonb_set(w.metadata, '{steps}', (
         SELECT jsonb_agg(
                  CASE s->>'role_key'
                    WHEN 'ops_supervisor' THEN s || jsonb_build_object('role_key', 'montage')
                    WHEN 'ceo'            THEN s || jsonb_build_object('role_key', 'marketing_manager')
                    ELSE s END
                  ORDER BY o)
           FROM jsonb_array_elements(w.metadata->'steps') WITH ORDINALITY AS t(s, o)))
 WHERE w.kind = 'role_path'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(w.metadata->'steps', '[]'::jsonb)) s
               WHERE s->>'role_key' IN ('ceo', 'ops_supervisor'));

-- 4. Unassign, then delete the roles.
UPDATE public.users u
   SET role_assignments = COALESCE((
         SELECT jsonb_agg(e ORDER BY o)
           FROM jsonb_array_elements(u.role_assignments) WITH ORDINALITY AS t(e, o)
          WHERE e->>'role_id' NOT IN (SELECT r.id::text FROM public.roles r
                                       WHERE r.key IN ('mos_ceo', 'mos_ops_supervisor'))), '[]'::jsonb)
 WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
                JOIN public.roles r ON r.id::text = e->>'role_id'
               WHERE r.key IN ('mos_ceo', 'mos_ops_supervisor'));

DELETE FROM public.roles WHERE key IN ('mos_ceo', 'mos_ops_supervisor');

-- mos_role_grant: validate against the three live roles.
CREATE OR REPLACE FUNCTION public.mos_role_grant(p_user_id uuid, p_role_key text, p_grant boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_full_key text;
  v_role_id  uuid;
  v_current  jsonb;
BEGIN
  -- Definer rights bypass RLS, so the authorization lives here. manage_roles
  -- is held by app admins and the Marketing Manager (see wassell_mos_can).
  IF NOT public.wassell_mos_can('manage_roles') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Accept the key with or without the mos_ prefix; validate against the three
  -- marketing roles (CEO and Operations supervisor retired 2026-10-04).
  v_full_key := CASE
    WHEN p_role_key LIKE 'mos\_%' THEN p_role_key
    ELSE 'mos_' || p_role_key
  END;
  IF v_full_key NOT IN ('mos_marketing_manager', 'mos_writer', 'mos_montage') THEN
    RAISE EXCEPTION 'MOS:UNKNOWN_ROLE %', p_role_key;
  END IF;

  SELECT id INTO v_role_id FROM public.roles WHERE key = v_full_key;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'MOS:UNKNOWN_ROLE %', p_role_key;
  END IF;

  SELECT COALESCE(u.role_assignments, '[]'::jsonb)
    INTO v_current
    FROM public.users u
   WHERE u.id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:UNKNOWN_USER';
  END IF;

  -- Strip any existing assignment of this role (idempotent re-grant, and the
  -- revoke path), then append on grant. Array order is otherwise preserved.
  v_current := COALESCE(
    (SELECT jsonb_agg(elem)
       FROM jsonb_array_elements(v_current) elem
      WHERE elem->>'role_id' <> v_role_id::text),
    '[]'::jsonb
  );

  IF p_grant THEN
    v_current := v_current
      || jsonb_build_object('role_id', v_role_id::text, 'field_values', '{}'::jsonb);
  END IF;

  UPDATE public.users
     SET role_assignments = v_current
   WHERE id = p_user_id;
END $function$;

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.roles WHERE key IN ('mos_ceo', 'mos_ops_supervisor')) THEN
    RAISE EXCEPTION 'MOS_RETIRE roles still present';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflows w, jsonb_array_elements(COALESCE(w.metadata->'steps', '[]'::jsonb)) s
              WHERE w.kind = 'role_path' AND s->>'role_key' IN ('ceo', 'ops_supervisor')) THEN
    RAISE EXCEPTION 'MOS_RETIRE a role_path step still points at a retired role';
  END IF;
  -- Guarded: a fresh/branch database has no marketing roles yet.
  IF EXISTS (SELECT 1 FROM public.roles WHERE key = 'mos_marketing_manager')
     AND NOT EXISTS (SELECT 1 FROM public.role_capabilities rc JOIN public.roles r ON r.id = rc.role_id
                      WHERE r.key = 'mos_marketing_manager' AND rc.capability = 'rate_creative') THEN
    RAISE EXCEPTION 'MOS_RETIRE rate_creative did not reach the Manager';
  END IF;
END $assert$;

COMMIT;
