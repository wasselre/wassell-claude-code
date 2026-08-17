-- High-cardinality personas for B2A.1.
--
-- Production today has 15 explicit grants and 3 folder grants. Tuning against
-- only that shape is how you ship a design that is fast now and pathological
-- later — precisely the failure mode that ruled out InitPlan arrays, whose
-- membership test is a linear scan per row. These personas exist so the array
-- design would visibly lose and the hash-semi-join design visibly holds.
--
--   persona 66… : 3,000 direct file grants (200x production)
--   persona 77… : a grant at the ROOT of a 12-deep folder chain, so the
--                 recursive descent has real depth AND ~2,400 files hang off it
--   persona 88… : both at once — the shape that made production's grant-holder
--                 the slow persona in the first place

INSERT INTO public.users (id, email, auth_uid, profile_id, is_active) VALUES
  ('66666666-6666-6666-6666-666666666666','many.grants@test','66666666-6666-6666-6666-666666666666','aaaaaaaa-0000-0000-0000-00000000000b',true),
  ('77777777-7777-7777-7777-777777777777','deep.folder@test','77777777-7777-7777-7777-777777777777','aaaaaaaa-0000-0000-0000-00000000000b',true),
  ('88888888-8888-8888-8888-888888888888','both@test',       '88888888-8888-8888-8888-888888888888','aaaaaaaa-0000-0000-0000-00000000000b',true)
ON CONFLICT (id) DO UPDATE
  SET auth_uid = EXCLUDED.auth_uid, profile_id = EXCLUDED.profile_id, is_active = EXCLUDED.is_active;

-- 3,000 direct grants, mixed roles so view/edit/delete genuinely differ.
INSERT INTO public.file_permissions (file_id, user_id, role)
SELECT ('c0000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
       '66666666-6666-6666-6666-666666666666',
       CASE WHEN i % 3 = 0 THEN 'owner' WHEN i % 3 = 1 THEN 'editor' ELSE 'viewer' END
FROM generate_series(1000, 3999) i
ON CONFLICT DO NOTHING;

-- A 12-deep folder chain hanging under the existing root.
DO $chain$
DECLARE parent uuid := 'f0000000-0000-0000-0000-0000000000f1'; cur uuid; d int;
BEGIN
  FOR d IN 1..12 LOOP
    cur := ('e0000000-0000-4000-8000-' || lpad(d::text,12,'0'))::uuid;
    INSERT INTO public.folders (id, name, parent_folder_id)
    VALUES (cur, 'depth ' || d, parent) ON CONFLICT (id) DO NOTHING;
    parent := cur;
  END LOOP;
END $chain$;

-- ~2,400 files spread across the deep chain, so descent returns a large set.
UPDATE public.files
   SET folder_id = ('e0000000-0000-4000-8000-'
                    || lpad(((right(id::text,12)::bigint % 12) + 1)::text, 12, '0'))::uuid
 WHERE storage_path LIKE 'scale/%'
   AND right(id::text,12)::bigint BETWEEN 4000 AND 6399;

-- Grant persona 77 at the TOP of the chain: every one of those files must be
-- reachable only by walking down 12 levels.
INSERT INTO public.folder_permissions (folder_id, user_id, role) VALUES
  ('e0000000-0000-4000-8000-000000000001','77777777-7777-7777-7777-777777777777','viewer')
ON CONFLICT DO NOTHING;

-- Persona 88: both a deep folder grant and 500 direct grants.
INSERT INTO public.folder_permissions (folder_id, user_id, role) VALUES
  ('e0000000-0000-4000-8000-000000000001','88888888-8888-8888-8888-888888888888','editor')
ON CONFLICT DO NOTHING;
INSERT INTO public.file_permissions (file_id, user_id, role)
SELECT ('c0000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
       '88888888-8888-8888-8888-888888888888',
       CASE WHEN i % 2 = 0 THEN 'owner' ELSE 'viewer' END
FROM generate_series(6500, 6999) i
ON CONFLICT DO NOTHING;

ANALYZE public.files;
ANALYZE public.file_permissions;
ANALYZE public.folder_permissions;
ANALYZE public.folders;
