-- Fixture supplement for the Phase 3 · B1 metadata smoke.
--
-- Runs immediately AFTER fixture_file_links.sql and BEFORE the Phase 1/2
-- migrations, so the rows added here exist before any projection trigger does
-- and therefore cannot perturb file_links, file_link_sources or the dirty set.
--
-- Its job is to close the gap between the Phase 1 fixture and the PRODUCTION
-- shape of `files`. The Phase 1 fixture only ever needed (id, original_name,
-- model_id, record_id); B1 backfills `owner_user_id` from `uploaded_by_user_id`
-- and promotes it to NOT NULL, so a fixture that leaves uploaders NULL would
-- make the migration fail in CI while succeeding in production — the same
-- CI-is-not-production asymmetry the anon-grant comment in fixture_file_links.sql
-- warns about.

-- `users` exists in production and B1 puts a FK on it. Without it here the FK
-- is silently skipped (to_regclass guard) and CI would never test it.
CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);
INSERT INTO public.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'uploader.one@test'),
  ('22222222-2222-2222-2222-222222222222', 'uploader.two@test')
ON CONFLICT (id) DO NOTHING;

-- Production-shape columns the Phase 1 fixture omits.
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Every pre-existing fixture file gets an uploader and a kind, matching the
-- production NOT NULLs.
UPDATE public.files SET uploaded_by_user_id = '11111111-1111-1111-1111-111111111111'
 WHERE uploaded_by_user_id IS NULL;
UPDATE public.files SET kind = 'image' WHERE kind IS NULL;
UPDATE public.files SET mime_type = 'image/png' WHERE mime_type IS NULL;
ALTER TABLE public.files ALTER COLUMN uploaded_by_user_id SET NOT NULL;
ALTER TABLE public.files ALTER COLUMN original_name      SET NOT NULL;
ALTER TABLE public.files ALTER COLUMN kind               SET NOT NULL;

-- The two job queues B1 reads for provenance. Only the columns B1 touches.
CREATE TABLE IF NOT EXISTS public.pdf_compress_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_file_id uuid
);
CREATE TABLE IF NOT EXISTS public.document_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_file_id uuid
);

-- ── Classification cases, all deliberately UNLINKED (model_id/record_id NULL)
-- so they add no projection edge and the file_links count assertions stay exact.
INSERT INTO public.files
  (id, original_name, kind, mime_type, uploaded_by_user_id, size_bytes, storage_bucket, storage_path) VALUES
  -- b1: ordinary image, no edges  → gallery_image / business / user_upload
  ('b1000000-0000-0000-0000-0000000000a1','لقطة للمشروع.png','image','image/png',
   '11111111-1111-1111-1111-111111111111', 10, 'wassel-files','p/a1.png'),
  -- b2: NO EXTENSION in the name — title must be the whole name, not empty
  ('b1000000-0000-0000-0000-0000000000a2','ملف بدون امتداد','pdf','application/pdf',
   '22222222-2222-2222-2222-222222222222', 20, 'wassel-files','p/a2'),
  -- b3: name is ONLY an extension — stripping it would leave '' and violate the
  --     NOT NULL + length CHECK, so the fallback must return the whole name
  ('b1000000-0000-0000-0000-0000000000a3','.pdf','pdf','application/pdf',
   '11111111-1111-1111-1111-111111111111', 30, 'wassel-files','p/a3.pdf'),
  -- b4: video → document_type video
  ('b1000000-0000-0000-0000-0000000000a4','جولة.mp4','video','video/mp4',
   '11111111-1111-1111-1111-111111111111', 40, 'wassel-files','p/a4.mp4'),
  -- b5: compression rendition → file_class system, origin derived_rendition
  ('b1000000-0000-0000-0000-0000000000a5','عرض (مضغوط).pdf','pdf','application/pdf',
   '11111111-1111-1111-1111-111111111111', 50, 'wassel-files','p/a5.pdf'),
  -- b6: generated document, matched by document_jobs.result_file_id
  ('b1000000-0000-0000-0000-0000000000a6','عقد إيجار.pdf','pdf','application/pdf',
   '22222222-2222-2222-2222-222222222222', 60, 'wassel-files','p/a6.pdf'),
  -- b7: generated document, matched only by the machine name pattern
  ('b1000000-0000-0000-0000-0000000000a7','عرض سعر — عروض الأسعار · 1a2b3c4d.pdf','pdf','application/pdf',
   '22222222-2222-2222-2222-222222222222', 70, 'wassel-files','p/a7.pdf'),
  -- b8: marketing intake — carries a mos_assets row
  ('b1000000-0000-0000-0000-0000000000a8','هوية بصرية.png','image','image/png',
   '22222222-2222-2222-2222-222222222222', 80, 'wassel-files','p/a8.png')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.pdf_compress_jobs (result_file_id)
  VALUES ('b1000000-0000-0000-0000-0000000000a5');
INSERT INTO public.document_jobs (result_file_id)
  VALUES ('b1000000-0000-0000-0000-0000000000a6');
-- mos_assets.file_id is UNIQUE in production; one row is enough here.
INSERT INTO public.mos_assets (id, title, file_id)
  VALUES ('b1000000-0000-0000-0000-0000000000b8','brand mark','b1000000-0000-0000-0000-0000000000a8')
ON CONFLICT (id) DO NOTHING;

-- ── updated_at history + the timestamp trigger ──────────────────────────────
-- Production `files` holds 7,132 DISTINCT updated_at values spanning
-- 2026-05-23 to 2026-08-15. That is real history and the B1 backfill must not
-- flatten it. Give every fixture row its own deterministic historical stamp so
-- "the fingerprint is byte-identical" is a real claim: if the backfill stamped
-- now() on everything, every one of these would move, and if it stamped a
-- single shared value the distinct-count assertion would catch that too.
--
-- Assigned BEFORE the trigger is created, because the trigger would otherwise
-- overwrite these very UPDATEs.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY id) AS rn FROM public.files
)
UPDATE public.files f
   SET created_at = timestamptz '2026-05-23 02:04:52.181964+00' + (o.rn * interval '7 hours'),
       updated_at = timestamptz '2026-05-23 02:04:52.181964+00' + (o.rn * interval '13 hours')
  FROM ordered o WHERE o.id = f.id;

-- Mirrors production exactly: BEFORE UPDATE only (tgtype 19 = ROW|BEFORE|UPDATE),
-- function body `NEW.updated_at = now()` with no guard — which is why the B1
-- backfill cannot simply assign the old value and must bypass the trigger.
-- INSERTs are not covered; they rely on the column DEFAULT.
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS files_set_updated_at ON public.files;
CREATE TRIGGER files_set_updated_at
  BEFORE UPDATE ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
