-- ============================================================================
-- Phase 1 — file relationship PROJECTION (observability only)
--
-- WHAT THIS IS
-- A read-only projection of the file↔record relationships that ALREADY exist in
-- production, scattered across four mechanisms that disagree with each other.
-- It changes no authorization, no write path, and no existing behaviour. Nothing
-- reads it for permission decisions in this phase.
--
-- ⚠ THIS IS A SNAPSHOT, NOT A LIVE VIEW.
-- No trigger and no dual-write ships in this slice, so the moment the backfill
-- finishes the projection begins drifting: new references are missing, removed
-- references linger as stale edges, reordered arrays go stale, changed marketing
-- relationships go stale. `file_links_reconcile()` MEASURES that drift and names
-- it — it does not repair it. The "Used in" panel must therefore stay disabled
-- in production until Phase 2 ships a proven freshness mechanism. Preview
-- environments may enable it against a freshly generated projection.
--
-- WHY TWO TABLES, NOT ONE
-- Measured on production 2026-08-10: 10,242 source occurrences collapse into
-- 9,054 distinct semantic edges — 1,188 occurrences are a SECOND proof of an
-- edge some other mechanism already asserts. A single table keyed
-- (file_id, model_id, record_id, role) would silently destroy those 1,188 and
-- make the projection non-reversible and non-reconcilable. So:
--
--   file_links         one row per SEMANTIC edge  — "file X is the floor plan of unit Y"
--   file_link_sources  one row per SOURCE occurrence — "…proven by units.unit_plan[0]"
--
-- IDENTITY includes model_id. (file_id, record_id, role) alone is NOT unique:
-- record ids are only unique per model in this schema, and frozen models keep
-- their rows in their own physical tables. The RLS target predicate matches on
-- BOTH model_id and record_id for exactly the same reason — claiming
-- model-scoped identity here and then resolving visibility by record id alone
-- would be incoherent.
--
-- DELIBERATELY ABSENT (approved deferrals — do not add "to reserve the schema")
--   grants_view · is_published · classification · status · external_url
--   generated_from · version_group_id · renditions · triggers · manual linking
-- Version identity stays UNRESOLVED until Phase 3, when real replacement
-- workflows are audited. `files.id` is the identity of the CURRENT canonical
-- file object and this migration claims nothing beyond that.
--
-- WRITE POSTURE: application users can never INSERT/UPDATE/DELETE here. There is
-- no write policy for `authenticated` at all, so RLS denies by default. Only the
-- SECURITY DEFINER backfill (service_role) populates it, and no general
-- link-writing RPC is exposed. This prevents anyone poisoning a graph that
-- becomes security-relevant in Phase 2.
--
-- ROLLBACK: at the foot of this file. It is a clean DROP — nothing depends on
-- these tables.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- A. Semantic edge
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.file_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  -- Polymorphic target. record_id is SOFT (no FK) on purpose: frozen models live
  -- in dedicated physical tables, so a single FK cannot cover both shapes. Same
  -- precedent as document_links.
  model_id    uuid NOT NULL,
  record_id   uuid NOT NULL,
  role        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_links_identity UNIQUE (file_id, model_id, record_id, role)
);

CREATE INDEX IF NOT EXISTS file_links_file_idx   ON public.file_links (file_id);
CREATE INDEX IF NOT EXISTS file_links_record_idx ON public.file_links (model_id, record_id);

-- ---------------------------------------------------------------------------
-- B. Provenance — why that edge exists. One row per source occurrence.
--
-- SOURCE IDENTITY (`source_key`) is the load-bearing column, not a convenience.
-- The previous shape keyed uniqueness on (link_id, origin, source_field,
-- source_position), which fails on two counts:
--   1. an ordinary UNIQUE constraint does not constrain rows where a
--      participating column is NULL, so any origin without a field or a position
--      could be inserted repeatedly;
--   2. it identifies a source CATEGORY, not the specific source row, so
--      reconciliation could never tell that a particular occurrence had
--      DISAPPEARED — only that the category still had some member.
--
-- `source_key` is NOT NULL, globally UNIQUE, and deterministically computable
-- from live data alone, which is what makes set-difference reconciliation
-- possible at all. It identifies the exact FACT ASSERTED — the source slot AND
-- the file it names:
--   field       'field:<model_id>:<record_id>:<field_slug>:<array_index>:<file_id>'
--   attachment  'attachment:<files.id>:<model_id>:<record_id>'
--   manual      'manual:<file_id>:<model_id>:<record_id>'
--   marketing   'marketing:<mos_assets.id>:<file_id>:<model_id>:<record_id>'
--
-- THE RULE every key obeys: it changes whenever the asserted relationship
-- changes, and is identical whenever the same relationship is asserted again.
--
-- The file id is part of every key deliberately. Keying a field on the slot
-- alone (…:unit_plan:0) would mean repointing from file A to file B kept the
-- SAME key: the projected row would quietly change meaning on the next backfill
-- and reconciliation would never report that "file A is the floor plan of unit
-- 12" had stopped being true. With the file in the key, a repoint shows up
-- honestly as one stale source (A) plus one missing source (B). Uniqueness is
-- unaffected — a slot holds one value at a time.
--
-- The manual key deliberately does NOT use document_links.id — see the
-- live-source function for why the surrogate would report false drift.
--
-- source_field / source_position are now DESCRIPTIVE and nullable: uniqueness no
-- longer depends on them, so a NULL cannot smuggle in a duplicate. Idempotency
-- is a schema guarantee (ON CONFLICT on a real unique index), not a procedural
-- NOT EXISTS that a concurrent run could race.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.file_link_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id         uuid NOT NULL REFERENCES public.file_links(id) ON DELETE CASCADE,
  -- Which mechanism proved it: 'field' | 'attachment' | 'manual' | 'marketing'
  origin          text NOT NULL,
  -- Stable identity of the EXACT source occurrence. See the block above.
  source_key      text NOT NULL,
  -- Descriptive only. NULL where the origin has no field / no ordinal.
  source_field    text,
  source_position int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_link_sources_origin_check
    CHECK (origin IN ('field','attachment','manual','marketing')),
  CONSTRAINT file_link_sources_key_nonempty CHECK (length(source_key) > 0),
  CONSTRAINT file_link_sources_identity UNIQUE (source_key)
);

CREATE INDEX IF NOT EXISTS file_link_sources_link_idx ON public.file_link_sources (link_id);

-- ---------------------------------------------------------------------------
-- C. RLS — BOTH-SIDES visibility, and no writes at all
--
-- A link row is visible only when the caller may view the FILE *and* may view
-- the TARGET RECORD. Either half alone leaks:
--   * file-only would tell a file owner that some restricted client/reservation
--     exists and uses their file;
--   * record-only would expose files the caller has no rights to.
--
-- The target predicate matches BOTH model_id AND record_id. Record ids are only
-- unique per model in this schema — that is precisely why model_id is part of
-- the edge identity above — so an id-only match would resolve visibility
-- against whichever model happened to own a colliding uuid. Cheap to get right;
-- silently wrong if assumed away.
--
-- Target visibility rides on `unified_records`, which is security_invoker=true
-- and UNIONs dynamic `records` with every frozen model's view — so this one
-- predicate covers dynamic AND frozen targets, and automatically inherits the
-- per-profile view_scope rules already enforced there. No new access helper is
-- invented, and no rule is weakened.
--
-- There is intentionally NO policy for INSERT/UPDATE/DELETE: RLS denies by
-- default, so `authenticated` cannot mutate the projection at all.
-- ---------------------------------------------------------------------------
ALTER TABLE public.file_links        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_link_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS file_links_select ON public.file_links;
CREATE POLICY file_links_select ON public.file_links
  FOR SELECT TO authenticated
  USING (
    public.wassell_can_access_file(file_links.file_id, 'view')
    AND EXISTS (
      SELECT 1 FROM public.unified_records ur
       WHERE ur.id       = file_links.record_id
         AND ur.model_id = file_links.model_id
    )
  );

-- Sources are reachable only through a visible parent edge.
DROP POLICY IF EXISTS file_link_sources_select ON public.file_link_sources;
CREATE POLICY file_link_sources_select ON public.file_link_sources
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.file_links l WHERE l.id = file_link_sources.link_id));

REVOKE ALL ON public.file_links, public.file_link_sources FROM PUBLIC;
GRANT SELECT ON public.file_links, public.file_link_sources TO authenticated;
GRANT ALL    ON public.file_links, public.file_link_sources TO service_role;

-- ---------------------------------------------------------------------------
-- D. Role mapping
--
-- Roles are resolved from (model name, field slug, field type) — NEVER from the
-- slug alone, because the same slug can mean different things on different
-- models. Held as controlled constants inside this function rather than a third
-- table: the projection is read-only in Phase 1, so a vocabulary table would add
-- a table and a write surface for no Phase-1 benefit. When manual linking ships
-- (Phase 2+) this becomes a real lookup table and this function reads it —
-- mirrored in TypeScript at src/lib/files/linkRoles.ts.
--
-- An unrecognised (model, field) pair is NOT silently bucketed into a generic
-- role. It maps to the explicit sentinel 'unmapped' and the reconciliation
-- report names every such pair with its count, so the gap is loud and the data
-- is still preserved.
--
-- 'attachment' is a RESERVED role-neutral value, never produced here — see the
-- live-source function for what it means.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_link_role_for(
  p_model text, p_field text, p_ftype text
) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN p_model='units'         AND p_field='unit_plan'            THEN 'floor_plan'
    WHEN p_model='all_projects'  AND p_field='main_image'           THEN 'main_image'
    WHEN p_model='all_projects'  AND p_field='project_images'       THEN 'gallery_image'
    WHEN p_model='all_projects'  AND p_field='project_videos'       THEN 'video'
    WHEN p_model='all_projects'  AND p_field='developer_content'    THEN 'developer_content'
    WHEN p_model='tasks'         AND p_field='files'                THEN 'task_attachment'
    WHEN p_model='project_details' AND p_field='hero_image_url'     THEN 'hero_image'
    WHEN p_model='project_details' AND p_field='agent_image_url'    THEN 'agent_image'
    WHEN p_model='project_details' AND p_field ~ '^gallery_image_[0-9]+$' THEN 'gallery_image'
    WHEN p_model='prompt_snippets' AND p_field='images'             THEN 'reference'
    WHEN p_model='image_presets'   AND p_field='images'             THEN 'reference'
    WHEN p_model='design_templates' AND p_field='reference_image'   THEN 'reference'
    WHEN p_model='marketing_operations' AND p_field='raw_photo'     THEN 'source'
    ELSE 'unmapped'
  END;
$$;

-- ---------------------------------------------------------------------------
-- D2. The field-type allowlist — WIDE, because classification is by VALUE.
--
-- Every type here is merely a candidate: whether an occurrence becomes an edge
-- is decided by what the value actually resolves to, never by the type's name.
-- Adding a type that turns out to hold URLs therefore costs nothing — those
-- values classify as 'external' and are reported, not projected. Narrowing the
-- list, by contrast, silently loses real file relationships, which is exactly
-- what happened when the list was image/multi_image/attachment only and
-- `tasks.files` and `all_projects.project_videos` fell outside it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_link_candidate_types()
RETURNS text[] LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT ARRAY['image','multi_image','file','multi_file','video','multi_video',
                   'attachment','image_icon']::text[] $$;

-- ---------------------------------------------------------------------------
-- E. EVERY field-value occurrence in a candidate field, CLASSIFIED BY VALUE.
--
-- Split out from the live-source function so the backfill and the reconciliation
-- share ONE derivation and cannot drift apart.
--
-- VALUE SHAPES handled (all observed in production 2026-08-10):
--   scalar string                    units.unit_plan            = "<uuid>"
--   array of strings                 all_projects.project_images= ["<uuid>", …]
--   array of {id, type} objects      all_projects.developer_content
--                                      = [{"id":"<uuid>","type":"file"|"folder"}, …]
--   scalar {id, type} object         (same shape, unwrapped defensively)
-- Mixed arrays are normal: all_projects.project_videos holds 4 canonical file
-- uuids AND 250 external URLs, with one record mixing both in a single array.
-- Array position is preserved for every element regardless of how it classifies,
-- so the canonical entries keep their true index.
--
-- CLASSIFICATION — the governing rule is "does this resolve to a canonical
-- files.id?", not "what is the field called":
--   'file'     a uuid with a matching public.files row      → becomes an edge
--   'folder'   declared type='folder', or a uuid matching   → REPORTED, not an edge.
--              public.folders                                 A folder is a different
--                                                             resource; manufacturing a
--                                                             file relationship from one
--                                                             would be a fabrication.
--   'external' an http(s)/protocol-relative/data URL        → REPORTED as an external
--                                                             resource, NOT an anomaly.
--                                                             250 YouTube/Supabase URLs
--                                                             in project_videos are
--                                                             correct data, not loss.
--   'dangling' a uuid with no files row                     → ANOMALY (real signal)
--   'invalid'  anything else                                → ANOMALY
--
-- Frozen models are excluded, and this is now measured rather than assumed:
-- market_listings' main_image_url / image_urls / video_urls are 100% external
-- Aqar URLs across a 2,183-value sample — scraped listing media, not business
-- files. The other three frozen models declare no file-bearing field at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_link_field_occurrences()
RETURNS TABLE (
  model_id uuid, model text, record_id uuid, field text, ftype text,
  raw_value text, declared_kind text, source_position int, role text, class text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH flds AS (
    SELECT m.id AS model_id, m.name AS model, fld->>'name' AS field, fld->>'type' AS ftype
      FROM public.models m,
           LATERAL jsonb_array_elements(m.schema->'sections') sec,
           LATERAL jsonb_array_elements(sec->'fields') fld
     WHERE m.is_hardcoded IS NOT TRUE
       AND fld->>'type' = ANY (public.file_link_candidate_types())
  ),
  raw AS (
    SELECT f.model_id, f.model, r.id AS record_id, f.field, f.ftype,
           x.v AS raw_value, x.kind AS declared_kind, x.pos AS source_position
      FROM flds f
      JOIN public.records r ON r.model_id = f.model_id
      CROSS JOIN LATERAL (
        -- scalar string
        SELECT r.data->>f.field AS v, NULL::text AS kind, 0 AS pos
         WHERE jsonb_typeof(r.data->f.field) = 'string'
        UNION ALL
        -- scalar {id, type} object
        SELECT r.data->f.field->>'id', r.data->f.field->>'type', 0
         WHERE jsonb_typeof(r.data->f.field) = 'object'
        UNION ALL
        -- array of strings OR of {id, type} objects; position always preserved
        SELECT CASE WHEN jsonb_typeof(e.val)='object' THEN e.val->>'id'
                    WHEN jsonb_typeof(e.val)='string' THEN e.val #>> '{}'
                    ELSE NULL END,
               CASE WHEN jsonb_typeof(e.val)='object' THEN e.val->>'type' ELSE NULL END,
               (e.ord-1)::int
          FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(r.data->f.field)='array'
                      THEN r.data->f.field ELSE '[]'::jsonb END
               ) WITH ORDINALITY AS e(val, ord)
      ) x
     WHERE x.v IS NOT NULL AND x.v <> ''
  )
  SELECT raw.model_id, raw.model, raw.record_id, raw.field, raw.ftype,
         raw.raw_value, raw.declared_kind, raw.source_position,
         public.file_link_role_for(raw.model, raw.field, raw.ftype),
         CASE
           WHEN raw.declared_kind = 'folder' THEN 'folder'
           WHEN raw.raw_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN CASE
                    WHEN EXISTS (SELECT 1 FROM public.files fi WHERE fi.id = raw.raw_value::uuid) THEN 'file'
                    WHEN EXISTS (SELECT 1 FROM public.folders fo WHERE fo.id = raw.raw_value::uuid) THEN 'folder'
                    ELSE 'dangling'
                  END
           WHEN raw.raw_value ~* '^(https?:)?//' OR raw.raw_value ~* '^data:' THEN 'external'
           ELSE 'invalid'
         END
    FROM raw;
$$;

-- ---------------------------------------------------------------------------
-- F. THE live source set — one row per source occurrence that can legitimately
--    become an edge. The single derivation used by BOTH the backfill and the
--    reconciliation, so "what should exist" has exactly one definition.
--
-- Four mechanisms:
--   1. field       record field values on unfrozen models (above), class='file'.
--   2. attachment  the legacy files.model_id/record_id column pair.
--   3. manual      document_links.
--   4. marketing   mos_assets.project_id — the Marketing Library's own record
--                  relationship. Omitting it would exclude the very assets that
--                  motivated the metadata model from Project Files.
--
-- HOW THE LEGACY ATTACHMENT IS CLASSIFIED
-- `files.record_id` proves only that a file was ASSOCIATED with a record. It
-- carries no evidence about whether that association is a main image, a gallery
-- image, a floor plan or a brochure. An earlier revision attached it to the
-- "deterministically lowest" role when several field-derived roles existed on
-- the same triple. That is stable, but stability is not truth — it invents a
-- semantic claim the source never made. The rule:
--
--   0 field-derived roles on the triple → its own edge, role 'attachment'
--   exactly 1                           → corroborates THAT edge (unambiguous)
--   more than 1                         → its own edge, role 'attachment'
--
-- 'attachment' is a reserved, role-NEUTRAL value meaning "associated with this
-- record; the relationship type is not asserted". It is deliberately distinct
-- from 'unmapped', which means "a field we have not named yet".
--
-- Measured on production 2026-08-10 across 1,424 legacy pairs:
--   215 with no field role · 1,188 unambiguous · 21 AMBIGUOUS.
-- Those 21 are exactly the rows an "assign the deterministically lowest role"
-- rule would have mislabelled.
--
-- SOURCE KEYS — each is the COMPLETE ASSERTED FACT, so it changes whenever the
-- relationship changes and stays identical whenever the same fact recurs:
--   field       'field:<model>:<record>:<field>:<index>:<file>'
--   attachment  'attachment:<file>:<model>:<record>'
--   manual      'manual:<file>:<model>:<record>'
--   marketing   'marketing:<asset_id>:<file>:<model>:<record>'
--
-- The manual key deliberately does NOT use document_links.id. That column is a
-- surrogate: the table's real identity is its own UNIQUE (file_id, model_id,
-- record_id), and the app only ever inserts (upsert on that triple) or deletes
-- by id — there is no UPDATE path. Keying on the surrogate would therefore
-- report FALSE drift every time a user unlinks and re-links the same record,
-- because the re-inserted row gets a fresh uuid while the asserted fact is
-- unchanged. Keying on the fact is correct in both directions: retargeting the
-- model, the record or the file all change the key, and re-asserting the same
-- relationship does not. The marketing key keeps the asset id because two
-- distinct library entries may legitimately assert the same file↔project fact.
--
-- NOT projected (documented boundary): mos_asset_links (asset↔CONTENT, not a
-- business record), mos_assets.parent_asset_id (file↔file lineage), and
-- publications. Those need a usage/derivation relationship, not a record edge,
-- and forcing them here would misrepresent them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_link_live_sources()
RETURNS TABLE (
  source_key text, origin text, file_id uuid, model_id uuid, record_id uuid,
  role text, source_field text, source_position int
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH field_valid AS (
    SELECT o.model_id, o.record_id, o.raw_value::uuid AS file_id, o.field,
           o.source_position, o.role
      FROM public.file_link_field_occurrences() o
     WHERE o.class = 'file'
  ),
  -- How many DISTINCT field-derived roles does each triple already carry?
  tri AS (
    SELECT fv.file_id, fv.model_id, fv.record_id,
           count(DISTINCT fv.role) AS n_roles,
           min(fv.role)            AS only_role   -- meaningful only when n_roles = 1
      FROM field_valid fv
     GROUP BY 1,2,3
  )
  SELECT 'field:'||fv.model_id||':'||fv.record_id||':'||fv.field||':'||fv.source_position||':'||fv.file_id,
         'field', fv.file_id, fv.model_id, fv.record_id, fv.role, fv.field, fv.source_position
    FROM field_valid fv
  UNION ALL
  SELECT 'attachment:'||fi.id||':'||fi.model_id||':'||fi.record_id,
         'attachment', fi.id, fi.model_id, fi.record_id,
         CASE WHEN t.n_roles = 1 THEN t.only_role ELSE 'attachment' END,
         NULL, NULL
    FROM public.files fi
    LEFT JOIN tri t
      ON t.file_id = fi.id AND t.model_id = fi.model_id AND t.record_id = fi.record_id
   WHERE fi.record_id IS NOT NULL AND fi.model_id IS NOT NULL
  UNION ALL
  SELECT 'manual:'||dl.file_id||':'||dl.model_id||':'||dl.record_id,
         'manual', dl.file_id, dl.model_id, dl.record_id,
         'supporting_document', NULL, NULL
    FROM public.document_links dl
   WHERE dl.model_id IS NOT NULL AND dl.record_id IS NOT NULL AND dl.file_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = dl.file_id)
  UNION ALL
  SELECT 'marketing:'||a.id||':'||a.file_id||':'||mp.id||':'||a.project_id,
         'marketing', a.file_id, mp.id, a.project_id, 'marketing_asset', NULL, NULL
    FROM public.mos_assets a
    CROSS JOIN LATERAL (SELECT id FROM public.models WHERE name='all_projects') mp
   WHERE a.file_id IS NOT NULL AND a.project_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = a.file_id);
$$;

-- ---------------------------------------------------------------------------
-- G. Backfill — idempotent BY SCHEMA, re-runnable, service-role only.
--
-- Idempotency comes from the two unique indexes plus ON CONFLICT, not from a
-- procedural NOT EXISTS that two concurrent runs could interleave through.
-- The source upsert DOES update link_id: if a source's classification changes
-- (an ambiguous legacy attachment that becomes unambiguous, say), the same
-- occurrence must move to the correct edge rather than linger on the old one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_links_backfill()
RETURNS TABLE (metric text, value bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_edges_before bigint;
  v_src_before   bigint;
BEGIN
  SELECT count(*) INTO v_edges_before FROM public.file_links;
  SELECT count(*) INTO v_src_before   FROM public.file_link_sources;

  -- ON COMMIT DROP only fires at COMMIT, so a second call INSIDE the same
  -- transaction would hit "relation already exists". Callers that verify
  -- idempotency do exactly that, so drop defensively first. Temp relations are
  -- always addressed schema-qualified as pg_temp.* so an identically named
  -- permanent relation can never be hit by accident.
  DROP TABLE IF EXISTS pg_temp._fl_live;

  CREATE TEMP TABLE _fl_live ON COMMIT DROP AS
    SELECT * FROM public.file_link_live_sources();

  -- 1. edges
  INSERT INTO public.file_links (file_id, model_id, record_id, role)
  SELECT DISTINCT l.file_id, l.model_id, l.record_id, l.role FROM pg_temp._fl_live l
  ON CONFLICT (file_id, model_id, record_id, role) DO NOTHING;

  -- 2. provenance, attached to the edge each occurrence actually proves
  INSERT INTO public.file_link_sources (link_id, origin, source_key, source_field, source_position)
  SELECT fl.id, l.origin, l.source_key, l.source_field, l.source_position
    FROM pg_temp._fl_live l
    JOIN public.file_links fl
      ON fl.file_id   = l.file_id
     AND fl.model_id  = l.model_id
     AND fl.record_id = l.record_id
     AND fl.role      = l.role
  ON CONFLICT (source_key) DO UPDATE
     SET link_id         = EXCLUDED.link_id,
         origin          = EXCLUDED.origin,
         source_field    = EXCLUDED.source_field,
         source_position = EXCLUDED.source_position;

  RETURN QUERY
  SELECT 'field_occurrences_considered', (SELECT count(*) FROM public.file_link_field_occurrences())
  UNION ALL SELECT 'source_occurrences_live',  (SELECT count(*) FROM pg_temp._fl_live)
  UNION ALL SELECT 'semantic_edges_total',     (SELECT count(*) FROM public.file_links)
  UNION ALL SELECT 'semantic_edges_added',     (SELECT count(*) FROM public.file_links) - v_edges_before
  UNION ALL SELECT 'source_rows_total',        (SELECT count(*) FROM public.file_link_sources)
  UNION ALL SELECT 'source_rows_added',        (SELECT count(*) FROM public.file_link_sources) - v_src_before;
END;
$$;

-- ---------------------------------------------------------------------------
-- H. Reconciliation — the projection is a SNAPSHOT, so this must measure DRIFT,
--    not merely confirm the last run did not duplicate itself.
--
-- Acceptance is NOT "zero drift". Acceptance is ZERO UNEXPLAINED LOSS, and it
-- rests on a COMPLETE PARTITION of every considered field value:
--
--     considered = represented + external + folder_ref + anomaly
--
-- Categories:
--   considered      every value occurrence in a candidate field
--   represented     what the projection currently holds
--   external        an http/data URL — a real external resource (YouTube,
--                   Supabase storage), NOT loss and NOT an anomaly. Manufacturing
--                   a file relationship from one would be a fabrication.
--   folder_ref      resolves to a folder, not a file. Also not loss.
--   anomaly         a value that SHOULD have been a file and is not: a uuid with
--                   no files row, or an unrecognisable value.
--   gap             represented, but our role vocabulary does not name it yet
--                   (role='unmapped'). The edge EXISTS; nothing was lost.
--   unscanned       a file reference sitting in a field whose declared type is
--                   NOT in the candidate list — i.e. a file-bearing field we do
--                   not know about. Reported explicitly rather than skipped.
--   missing_source  live source occurrence absent from the projection
--   stale_source    projected source occurrence that no longer exists live
--   missing_edge    edge implied by live sources but not in file_links
--   orphan_edge     edge in file_links with no live source at all
--   drift           recognisable shapes inside the above (reclassification,
--                   positional movement)
--   shape/source/role   descriptive distributions
--
-- Reporting is the whole job here. This function NEVER deletes: pruning stale
-- edges is destructive automation against a graph that becomes
-- security-relevant, and it needs its own justification and approval.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_links_reconcile()
RETURNS TABLE (category text, detail text, value bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  DROP TABLE IF EXISTS pg_temp._fl_occ, pg_temp._fl_live2, pg_temp._fl_proj;

  CREATE TEMP TABLE _fl_occ  ON COMMIT DROP AS SELECT * FROM public.file_link_field_occurrences();
  CREATE TEMP TABLE _fl_live2 ON COMMIT DROP AS SELECT * FROM public.file_link_live_sources();
  CREATE TEMP TABLE _fl_proj ON COMMIT DROP AS
    SELECT s.source_key, s.origin, s.source_field, s.source_position,
           l.file_id, l.model_id, l.record_id, l.role
      FROM public.file_link_sources s
      JOIN public.file_links l ON l.id = s.link_id;

  RETURN QUERY
  SELECT 'considered', 'field value occurrences', (SELECT count(*) FROM pg_temp._fl_occ)
  UNION ALL
  SELECT 'anomaly', 'dangling uuid (no files row)',  (SELECT count(*) FROM pg_temp._fl_occ WHERE class='dangling')
  UNION ALL
  SELECT 'anomaly', 'unrecognisable value',          (SELECT count(*) FROM pg_temp._fl_occ WHERE class='invalid')
  UNION ALL
  SELECT 'external', o.model||'.'||o.field, count(*)
    FROM pg_temp._fl_occ o WHERE o.class='external' GROUP BY o.model, o.field
  UNION ALL
  SELECT 'folder_ref', o.model||'.'||o.field, count(*)
    FROM pg_temp._fl_occ o WHERE o.class='folder' GROUP BY o.model, o.field
  UNION ALL
  SELECT 'gap', 'unmapped role: '||o.model||'.'||o.field, count(*)
    FROM pg_temp._fl_occ o WHERE o.role='unmapped' AND o.class='file' GROUP BY o.model, o.field
  UNION ALL
  -- A canonical file reference hiding in a field type we do not treat as
  -- file-bearing. Scans the ACTUAL keys present in each record rather than the
  -- declared field list, so a type nobody has told us about still surfaces.
  SELECT 'unscanned', 'file reference in non-candidate field: '||m.name||'.'||kv.key, count(*)
    FROM public.records r
    JOIN public.models m ON m.id = r.model_id AND m.is_hardcoded IS NOT TRUE
    CROSS JOIN LATERAL jsonb_each(r.data) kv
    CROSS JOIN LATERAL (
      SELECT kv.value #>> '{}' AS v WHERE jsonb_typeof(kv.value)='string'
      UNION ALL
      SELECT e.val #>> '{}' FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(kv.value)='array' THEN kv.value ELSE '[]'::jsonb END) e(val)
       WHERE jsonb_typeof(e.val)='string'
    ) x
   WHERE x.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM public.files fi WHERE fi.id = x.v::uuid)
     AND NOT EXISTS (
       SELECT 1 FROM LATERAL jsonb_array_elements(m.schema->'sections') sec,
                     LATERAL jsonb_array_elements(sec->'fields') fld
        WHERE fld->>'name' = kv.key
          AND fld->>'type' = ANY (public.file_link_candidate_types()))
   GROUP BY m.name, kv.key
  UNION ALL
  SELECT 'represented', 'semantic edges',     (SELECT count(*) FROM public.file_links)
  UNION ALL
  SELECT 'represented', 'source occurrences', (SELECT count(*) FROM public.file_link_sources)
  UNION ALL
  -- ── staleness: live vs projected, by source identity ──────────────────────
  SELECT 'missing_source', 'origin='||l.origin, count(*)
    FROM pg_temp._fl_live2 l
   WHERE NOT EXISTS (SELECT 1 FROM pg_temp._fl_proj p WHERE p.source_key = l.source_key)
   GROUP BY l.origin
  UNION ALL
  SELECT 'stale_source', 'origin='||p.origin, count(*)
    FROM pg_temp._fl_proj p
   WHERE NOT EXISTS (SELECT 1 FROM pg_temp._fl_live2 l WHERE l.source_key = p.source_key)
   GROUP BY p.origin
  UNION ALL
  -- A source whose key still exists but now proves a DIFFERENT edge.
  SELECT 'drift', 'reclassified (same source, different edge)', count(*)
    FROM pg_temp._fl_proj p
    JOIN pg_temp._fl_live2 l ON l.source_key = p.source_key
   WHERE (l.file_id, l.model_id, l.record_id, l.role)
      IS DISTINCT FROM (p.file_id, p.model_id, p.record_id, p.role)
  UNION ALL
  -- Positional drift: the same (record, field, file) present live and projected,
  -- but at a different array index — surfaces as one stale + one missing above.
  SELECT 'drift', 'positional (same record/field/file, new index)', count(*)
    FROM (
      SELECT DISTINCT l.model_id, l.record_id, l.source_field, l.file_id
        FROM pg_temp._fl_live2 l
       WHERE l.origin='field'
         AND NOT EXISTS (SELECT 1 FROM pg_temp._fl_proj p WHERE p.source_key = l.source_key)
         AND EXISTS (
           SELECT 1 FROM pg_temp._fl_proj p
            WHERE p.origin='field' AND p.model_id = l.model_id AND p.record_id = l.record_id
              AND p.source_field = l.source_field AND p.file_id = l.file_id
              AND NOT EXISTS (SELECT 1 FROM pg_temp._fl_live2 l2 WHERE l2.source_key = p.source_key))
    ) q
  UNION ALL
  -- ── staleness: live vs projected, by semantic edge ────────────────────────
  SELECT 'missing_edge', 'implied by live sources, not projected', count(*)
    FROM (SELECT DISTINCT file_id, model_id, record_id, role FROM pg_temp._fl_live2) l
   WHERE NOT EXISTS (
     SELECT 1 FROM public.file_links fl
      WHERE fl.file_id=l.file_id AND fl.model_id=l.model_id
        AND fl.record_id=l.record_id AND fl.role=l.role)
  UNION ALL
  SELECT 'orphan_edge', 'projected, no live source', count(*)
    FROM public.file_links fl
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_temp._fl_live2 l
      WHERE l.file_id=fl.file_id AND l.model_id=fl.model_id
        AND l.record_id=fl.record_id AND l.role=fl.role)
  UNION ALL
  -- ── descriptive ───────────────────────────────────────────────────────────
  SELECT 'shape', 'edges with >1 source',
         (SELECT count(*) FROM (SELECT link_id FROM public.file_link_sources
                                 GROUP BY link_id HAVING count(*)>1) q)
  UNION ALL
  SELECT 'shape', 'max sources on one edge',
         (SELECT coalesce(max(c),0) FROM (SELECT count(*) c FROM public.file_link_sources
                                           GROUP BY link_id) q)
  UNION ALL
  SELECT 'shape', 'max records referencing one file',
         (SELECT coalesce(max(c),0) FROM (SELECT count(*) c FROM public.file_links
                                           GROUP BY file_id) q)
  UNION ALL
  SELECT 'source', 'origin='||origin, count(*)
    FROM public.file_link_sources GROUP BY origin
  UNION ALL
  SELECT 'role', 'role='||role, count(*) FROM public.file_links GROUP BY role;
END;
$$;

-- ---------------------------------------------------------------------------
-- I. Function security
--
-- Postgres grants EXECUTE to PUBLIC by default, so REVOKE FROM authenticated
-- alone would leave the function wide open — a lesson this repo already paid
-- for once, in the Phase 0b hardening of mos_register_record_file. Revoke from
-- PUBLIC explicitly, then grant only what is intended.
--
-- POST-ROLLOUT POSTURE: these stay RETAINED and RESTRICTED to service_role.
-- The backfill is how the snapshot is refreshed until Phase 2 ships
-- synchronisation, and the reconciliation is how its drift is measured — both
-- are operator tools, run from a trusted context, never from the browser. No
-- general link-writing RPC exists and none should be added in this phase.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.file_link_field_occurrences()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_link_candidate_types()     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.file_link_live_sources()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_links_backfill()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.file_links_reconcile()         FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.file_link_field_occurrences() TO service_role;
GRANT EXECUTE ON FUNCTION public.file_link_candidate_types()    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.file_link_live_sources()      TO service_role;
GRANT EXECUTE ON FUNCTION public.file_links_backfill()         TO service_role;
GRANT EXECUTE ON FUNCTION public.file_links_reconcile()        TO service_role;

-- file_link_role_for is a pure lookup over its arguments — no relation access,
-- no data exposure — and the TypeScript mirror needs the same vocabulary, so it
-- stays readable. It still cannot write anything.
REVOKE ALL ON FUNCTION public.file_link_role_for(text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_link_role_for(text,text,text) TO authenticated, service_role;

COMMIT;

-- ============================================================================
-- ROLLBACK — clean DROP. Nothing depends on these objects: no view references
-- them, no trigger fires into them, and no existing policy calls their
-- functions. Dropping them returns the database to its pre-Phase-1 state
-- exactly, and destroys no data that did not originate in the backfill.
--
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.file_links_reconcile();
-- DROP FUNCTION IF EXISTS public.file_links_backfill();
-- DROP FUNCTION IF EXISTS public.file_link_live_sources();
-- DROP FUNCTION IF EXISTS public.file_link_field_occurrences();
-- DROP FUNCTION IF EXISTS public.file_link_candidate_types();
-- DROP FUNCTION IF EXISTS public.file_link_role_for(text,text,text);
-- DROP TABLE IF EXISTS public.file_link_sources;   -- FK CASCADE from file_links
-- DROP TABLE IF EXISTS public.file_links;
-- COMMIT;
-- ============================================================================
