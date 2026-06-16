-- 2026-06-16_dedup_seed_roles_profiles.sql
--
-- Collapse duplicate seeded system profiles/roles and PREVENT recurrence.
--
-- Background
-- ----------
-- The shipped seeds (Administrator + Sales profiles, Sales Rep + Sales Manager
-- roles) are backfilled by the SPA on first load, keyed by HARDCODED ids
-- (src/data/seedUsers.ts, hardcoded since 2026-05-17 to make seeding idempotent).
-- That keeps the *app* from ever inserting a second copy on a given DB lineage --
-- the backfill only seeds an EMPTY table. But a deployment that rolls the DB
-- baseline back behind those ids -- a point-in-time RESTORE, a Supabase BRANCH
-- reset/merge, or a manual backup-copy -- can reintroduce an older-lineage seed
-- row under a DIFFERENT id. That old row then coexists with the canonical one:
-- a duplicate keyed by label, which the id-keyed backfill can't recognize.
--
-- Observed on prod (zhqqsxwealdwqzrbpwyv) 2026-06-16: two clean cohorts --
-- 2026-05-07 (old ids) and 2026-06-01 12:44:17.449 (the four hardcoded seed ids,
-- same millisecond) -- gave 2x Administrator (profile), 2x Sales Manager and
-- 2x Sales Rep (roles). The 2026-05-07 copies were re-pointed/removed by hand
-- before this migration ran; the generic dedup below is what makes the migration
-- safe to apply on ANY environment (and re-runnable), and the UNIQUE indexes are
-- the durable, DB-enforced guard against the next restore/branch doing it again.
--
-- This migration is idempotent: the dedup no-ops once each seed is singular, and
-- the indexes use IF NOT EXISTS.

BEGIN;

-- Canonical seed ids -- MUST match src/data/seedUsers.ts. Only used to PREFER the
-- canonical row as the keeper; if a duplicate group has none of these, the oldest
-- row (then smallest id) wins. Keeping these in sync is not load-bearing for
-- correctness -- it only decides WHICH duplicate survives.
--   profiles: ed8349bc-... = Administrator,  b303acd7-... = Sales (is_system=false)
--   roles:    bc217747-... = Sales Rep,      c54976bb-... = Sales Manager

------------------------------------------------------------------------
-- 1. Profiles: collapse duplicate is_system profiles by lower(label_en)
------------------------------------------------------------------------
CREATE TEMP TABLE _profile_dedup ON COMMIT DROP AS
WITH ranked AS (
  SELECT id,
         lower(btrim(label_en)) AS k,
         created_at,
         (id = 'ed8349bc-e083-46cb-9bcb-34727fb7fb78'::uuid) AS is_canonical
  FROM public.profiles
  WHERE is_system = true
),
keeper AS (
  SELECT DISTINCT ON (k) k, id AS keeper_id
  FROM ranked
  ORDER BY k, is_canonical DESC, created_at ASC, id ASC
)
SELECT r.id AS loser_id, kp.keeper_id
FROM ranked r
JOIN keeper kp USING (k)
WHERE r.id <> kp.keeper_id;

-- Re-point users off the losers, then delete the loser profiles.
UPDATE public.users u
SET profile_id = d.keeper_id, updated_at = now()
FROM _profile_dedup d
WHERE u.profile_id = d.loser_id;

DELETE FROM public.profiles p
USING _profile_dedup d
WHERE p.id = d.loser_id;

------------------------------------------------------------------------
-- 2. Roles: collapse duplicate is_system roles by lower(label_en)
------------------------------------------------------------------------
CREATE TEMP TABLE _role_dedup ON COMMIT DROP AS
WITH ranked AS (
  SELECT id,
         lower(btrim(label_en)) AS k,
         created_at,
         (id IN ('bc217747-73cf-4405-b176-1da43d8f972a'::uuid,
                 'c54976bb-d0ae-4c5c-a7a7-05ef5fd07551'::uuid)) AS is_canonical
  FROM public.roles
  WHERE is_system = true
),
keeper AS (
  SELECT DISTINCT ON (k) k, id AS keeper_id
  FROM ranked
  ORDER BY k, is_canonical DESC, created_at ASC, id ASC
)
SELECT r.id AS loser_id, kp.keeper_id
FROM ranked r
JOIN keeper kp USING (k)
WHERE r.id <> kp.keeper_id;

-- Role "records" (if any) are stored in records with model_id = role id.
UPDATE public.records rec
SET model_id = d.keeper_id
FROM _role_dedup d
WHERE rec.model_id = d.loser_id;

-- Rewrite users.role_assignments[].role_id from loser -> keeper (dedupe the array).
UPDATE public.users u
SET role_assignments = (
      SELECT jsonb_agg(DISTINCT
               CASE WHEN d.keeper_id IS NOT NULL
                    THEN jsonb_set(elem, '{role_id}', to_jsonb(d.keeper_id::text))
                    ELSE elem END)
      FROM jsonb_array_elements(u.role_assignments) elem
      LEFT JOIN _role_dedup d ON d.loser_id = (elem->>'role_id')::uuid
    ),
    updated_at = now()
WHERE u.role_assignments IS NOT NULL
  AND jsonb_typeof(u.role_assignments) = 'array'
  AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(u.role_assignments) e
        JOIN _role_dedup d2 ON d2.loser_id = (e->>'role_id')::uuid
      );

DELETE FROM public.roles r
USING _role_dedup d
WHERE r.id = d.loser_id;

------------------------------------------------------------------------
-- 3. Durable guard: at most ONE is_system row per label, DB-enforced.
--    Partial (WHERE is_system) so user-created non-system profiles/roles
--    (e.g. multiple "New Profile" / "New Role") are unconstrained. A future
--    restore/branch/backup-copy that tries to insert a second system seed by
--    label now fails loudly instead of silently duplicating.
------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS profiles_system_label_uniq
  ON public.profiles (lower(btrim(label_en)))
  WHERE is_system = true;

CREATE UNIQUE INDEX IF NOT EXISTS roles_system_label_uniq
  ON public.roles (lower(btrim(label_en)))
  WHERE is_system = true;

COMMIT;
