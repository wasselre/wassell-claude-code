-- Production-shaped corpus for the B2 search tests.
--
-- The Phase 1 fixture holds 19 files. That is the right size for proving
-- projection SHAPES but it cannot say anything about whether search is fast, or
-- whether facet counts stay right once a bucket has thousands of members. B2's
-- acceptance criterion is "p95 < 300 ms at production-shaped scale", so the
-- corpus has to actually be that scale: production is 7,133 files, this makes
-- 8,000.
--
-- Everything is deterministic (generate_series + modulo, no random()), so a
-- failure is reproducible and the expected counts below are exact.
--
-- Runs AFTER B1 and B2 are applied, so:
--   * files_fill_business_metadata derives title/owner/document_type
--   * search_text is generated for every row
--   * the Phase 2 trigger sees the inserts (model_id/record_id are NULL for
--     most rows, and file_links_mark_dirty returns early on NULL, so they mark
--     nothing dirty; the linked subset below deliberately does mark targets)

-- A third principal so RLS differences are measurable: user 1 and user 2 each
-- own roughly half the corpus and can see nothing of the other's.
INSERT INTO public.users (id, email) VALUES
  ('33333333-3333-3333-3333-333333333333','grants.only@test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.files
  (id, original_name, kind, mime_type, uploaded_by_user_id, size_bytes,
   storage_bucket, storage_path, created_at, updated_at, valid_until, checksum_sha256, tags)
SELECT
  ('c0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  CASE
    -- Arabic, with the SAME word spelled two ways so folding is exercised:
    -- أبراج (with hamza) vs ابراج (without). Both must match one query.
    WHEN i % 10 = 0 THEN 'مخطط الدور ' || i || '.png'
    WHEN i % 7  = 0 THEN 'أبراج المشرقية ' || i || '.png'
    WHEN i % 7  = 3 THEN 'ابراج المشرقية ' || i || '.png'
    WHEN i % 11 = 0 THEN 'بروشور المشروع ' || i || '.pdf'
    ELSE 'Floor Plan Unit ' || i || '.png'
  END,
  CASE WHEN i % 20 = 0 THEN 'pdf' WHEN i % 37 = 0 THEN 'video' ELSE 'image' END,
  CASE WHEN i % 20 = 0 THEN 'application/pdf' WHEN i % 37 = 0 THEN 'video/mp4' ELSE 'image/png' END,
  CASE WHEN i % 2 = 0 THEN '11111111-1111-1111-1111-111111111111'::uuid
                      ELSE '22222222-2222-2222-2222-222222222222'::uuid END,
  (i * 137) % 5000000,
  'wassel-files',
  'scale/' || i || '.bin',
  timestamptz '2026-01-01 00:00:00+00' + (i * interval '11 minutes'),
  timestamptz '2026-01-01 00:00:00+00' + (i * interval '11 minutes'),
  -- 160 expired rows (every 50th)
  CASE WHEN i % 50 = 0 THEN timestamptz '2026-02-01 00:00:00+00' END,
  -- 80 rows share 40 checksums => 80 duplicates (every 100th and its +1)
  CASE WHEN i % 100 = 0 THEN 'dup' || (i / 100)::text
       WHEN i % 100 = 1 AND i > 1 THEN 'dup' || (i / 100)::text END,
  CASE WHEN i % 13 = 0 THEN ARRAY['تسويق'] WHEN i % 17 = 0 THEN ARRAY['أرشيف'] ELSE '{}'::text[] END
FROM generate_series(1, 8000) i
ON CONFLICT (id) DO NOTHING;

-- Give the corpus real document_type variety for the facet assertions. The B1
-- trigger typed everything from `kind`; a Library corpus is not that uniform.
--
-- The row index `i` is recoverable from the id: the uuid's last 12 characters
-- are lpad(i,12,'0'), so right(id::text,12)::bigint is exact. (Parsing it back
-- out of storage_path would mean casting 'scale/123.bin'.)
UPDATE public.files SET document_type = 'floor_plan'
 WHERE storage_path LIKE 'scale/%' AND right(id::text, 12)::bigint % 10 = 0;
UPDATE public.files SET document_type = 'brochure'
 WHERE storage_path LIKE 'scale/%' AND right(id::text, 12)::bigint % 11 = 0;
UPDATE public.files SET document_type = 'marketing_asset'
 WHERE storage_path LIKE 'scale/%' AND right(id::text, 12)::bigint % 23 = 0;

-- A linked subset, so the linked_model / role facets and the "unlinked" health
-- count are non-trivial. Writing files.model_id/record_id uses the ATTACHMENT
-- source, the same path production uses — never a direct file_links insert,
-- which would be drift by construction.
DO $link$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT id, model_id FROM public.records WHERE model_id IS NOT NULL LIMIT 4 LOOP
    UPDATE public.files
       SET model_id = r.model_id, record_id = r.id
     WHERE storage_path LIKE 'scale/%'
       AND right(id::text, 12)::bigint % 20 = n;
    n := n + 1;
  END LOOP;
END $link$;

ANALYZE public.files;
ANALYZE public.file_links;
