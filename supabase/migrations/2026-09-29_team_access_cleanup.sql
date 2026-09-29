-- Team & Access cleanup (operator-approved 2026-09-29).
--
-- Measured before this migration: 4 of 8 profiles had no users; one profile
-- («مسؤول تقني – عبدالمحسن») was a per-person copy of an empty «مسؤول تقني»;
-- two sales roles had no holders («دور جديد») or were a mis-assigned duplicate
-- of a Marketing role name (sales «مدير التسويق», held only by the technical
-- admin). None of the deleted ids is referenced by a workflow, a model schema,
-- another profile or a record (checked by id across all four).
--
-- KEPT on purpose: the sales role «مدير مبيعات» (c54976bb…) — the
-- "After-Visit Completed" workflow assigns the sales-manager review task to it.
--
-- Everything touched is snapshotted first. Guarded so it replays on a fresh
-- database (every statement is keyed by id and is a no-op when absent).

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_profiles_20260929 AS
  SELECT * FROM public.profiles WHERE id IN (
    'cf9baf5b-e582-4291-93b2-212605f313c4', 'cf70f46e-d0f5-4849-b9ec-aabf06eb37db',
    'b27f9903-48f7-4570-b115-b54a3bb72e54', '1e9b3ae5-97e3-4da5-9610-8f6f2b449f18',
    'f32dfae8-9210-4f98-a26b-c88d0d7a2ca2');
CREATE TABLE IF NOT EXISTS public._backup_roles_20260929 AS
  SELECT * FROM public.roles WHERE id IN (
    'f05b92ce-33d8-4648-a8c9-ff5e598c584f', 'ad874d1a-3f20-415a-a504-0c6d8c7ec937');
CREATE TABLE IF NOT EXISTS public._backup_users_roles_20260929 AS
  SELECT id, email, name_ar, name_en, profile_id, role_assignments FROM public.users
   WHERE email IN ('r.abanumay@wassel.re', 'abdulmohsen3335@gmail.com');
REVOKE ALL ON public._backup_profiles_20260929, public._backup_roles_20260929,
  public._backup_users_roles_20260929 FROM anon, authenticated;

-- 1. The operator's own account was named after a profile.
UPDATE public.users SET name_ar = 'ريان أبانمي', name_en = 'Rayyan Abanumay'
 WHERE email = 'r.abanumay@wassel.re';

-- 2. Take the sales «مدير التسويق» role off the technical admin.
UPDATE public.users
   SET role_assignments = COALESCE((
         SELECT jsonb_agg(a) FROM jsonb_array_elements(role_assignments) a
          WHERE a->>'role_id' <> 'ad874d1a-3f20-415a-a504-0c6d8c7ec937'), '[]'::jsonb)
 WHERE role_assignments @> '[{"role_id": "ad874d1a-3f20-415a-a504-0c6d8c7ec937"}]';

-- 3. Delete the two empty sales roles (dependent rows cascade; none exist).
DELETE FROM public.roles WHERE id IN (
  'f05b92ce-33d8-4648-a8c9-ff5e598c584f', 'ad874d1a-3f20-415a-a504-0c6d8c7ec937')
  AND NOT EXISTS (SELECT 1 FROM public.users u, jsonb_array_elements(u.role_assignments) a
                   WHERE a->>'role_id' IN ('f05b92ce-33d8-4648-a8c9-ff5e598c584f', 'ad874d1a-3f20-415a-a504-0c6d8c7ec937'));

-- 4. Delete the empty profiles. The empty «مسؤول تقني» goes too; the technical
--    admin's own copy takes its name, so his access is unchanged byte for byte.
DELETE FROM public.profiles p WHERE p.id IN (
  'cf9baf5b-e582-4291-93b2-212605f313c4', 'cf70f46e-d0f5-4849-b9ec-aabf06eb37db',
  'b27f9903-48f7-4570-b115-b54a3bb72e54', '1e9b3ae5-97e3-4da5-9610-8f6f2b449f18')
  AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.profile_id = p.id);
UPDATE public.profiles SET label_ar = 'مسؤول تقني', label_en = 'Technical Admin'
 WHERE id = 'f32dfae8-9210-4f98-a26b-c88d0d7a2ca2';

COMMIT;
