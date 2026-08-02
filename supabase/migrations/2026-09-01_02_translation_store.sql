-- ═══════════════════════════════════════════════════════════════════════════
-- Bilingual architecture W1 — migration 02/05: the durable translation store.
-- units (canonical source state) → variants (per-language display) →
-- revisions (append-only attempts) → segments (long content), plus
-- translation memory, glossary, settings, history, authorization RPCs.
-- Tables are the PG17-validated DDL (REV 4 §A8). Ships dark.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Canonical source state: ONE row per logical field/element ─────────────
CREATE TABLE IF NOT EXISTS public.translation_units (
  resource_kind text NOT NULL REFERENCES public.translation_resources(resource_kind),
  entity_id uuid NOT NULL,               -- NO FK: frozen rows + non-records kinds
  field_path text NOT NULL,              -- 'slug' | 'slug[id=<uuid>].sub' | 'content.block[<uuid>]' | 'pair:<base>'
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  model_id uuid REFERENCES public.models(id) ON DELETE CASCADE,   -- resource_kind='record' only
  source_lang text NOT NULL CHECK (source_lang IN ('ar','en','mixed','und')),
  detect_confidence numeric, detector_version text,
  source_lang_locked boolean NOT NULL DEFAULT false,
  source_rev text NOT NULL,              -- sha256 of exact canonical source (worker-computed)
  source_excerpt text,
  generation bigint NOT NULL DEFAULT 1,  -- translation-basis revision (REV 4 §B4 bump matrix)
  basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  dirty boolean NOT NULL DEFAULT true,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_kind, entity_id, field_path)
);
CREATE INDEX IF NOT EXISTS tu_dirty_idx ON public.translation_units (dirty, next_retry_at) WHERE dirty;
CREATE INDEX IF NOT EXISTS tu_model_idx ON public.translation_units (model_id) WHERE model_id IS NOT NULL;

-- ── Append-only attempts/audit of every translation ───────────────────────
CREATE TABLE IF NOT EXISTS public.translation_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_kind text NOT NULL, entity_id uuid NOT NULL, field_path text NOT NULL,
  lang text NOT NULL CHECK (lang IN ('ar','en')),
  generation bigint NOT NULL,
  source_rev text NOT NULL, source_lang text NOT NULL, source_text text,
  translated_text text, translated_json jsonb,
  origin text NOT NULL CHECK (origin IN ('ai','human','official','glossary','seed','source_snapshot')),
  status text NOT NULL CHECK (status IN ('candidate','active','approved','superseded','rejected','failed')),
  treatment text, provider text, provider_model text,
  prompt_version text, glossary_version int,
  error text, actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (resource_kind, entity_id, field_path)
    REFERENCES public.translation_units (resource_kind, entity_id, field_path) ON DELETE CASCADE
);
-- DB-enforced idempotency PER GENERATION (REV 4 blocker 3): duplicate workers
-- can't create competing candidates, while prompt/glossary/policy bumps (new
-- generation) legitimately retranslate unchanged source text.
CREATE UNIQUE INDEX IF NOT EXISTS tr_gen_candidate_uq ON public.translation_revisions
  (resource_kind, entity_id, field_path, lang, generation)
  WHERE status = 'candidate' AND origin IN ('ai','seed');
CREATE INDEX IF NOT EXISTS tr_unit_idx ON public.translation_revisions
  (resource_kind, entity_id, field_path, lang, created_at DESC);

-- ── Per-language display state ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.translation_variants (
  resource_kind text NOT NULL, entity_id uuid NOT NULL, field_path text NOT NULL,
  lang text NOT NULL CHECK (lang IN ('ar','en')),
  role text NOT NULL DEFAULT 'target' CHECK (role IN ('source','target')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','translated','approved','failed','skipped','source')),
  generation bigint,                     -- the unit generation this display was produced for
  display_text text, display_json jsonb,
  active_revision_id uuid REFERENCES public.translation_revisions(id) ON DELETE SET NULL,
  last_approved_revision_id uuid REFERENCES public.translation_revisions(id) ON DELETE SET NULL,
  machine_owned boolean NOT NULL DEFAULT true,   -- twin/target ownership (§B9)
  attempts int NOT NULL DEFAULT 0, last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_kind, entity_id, field_path, lang),
  FOREIGN KEY (resource_kind, entity_id, field_path)
    REFERENCES public.translation_units (resource_kind, entity_id, field_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tv_state_idx ON public.translation_variants (state) WHERE state IN ('pending','failed');
CREATE INDEX IF NOT EXISTS tv_fieldpath_idx ON public.translation_variants (resource_kind, field_path);
CREATE INDEX IF NOT EXISTS tv_display_trgm ON public.translation_variants
  USING gin (public.wassell_search_norm(display_text) gin_trgm_ops);

-- Structural invariant (REV 4 §4a): a display without its revision pointer is
-- corrupt. Deep generation-consistency is enforced by every reader's
-- `variant.generation = unit.generation` predicate + the synchronous clear in
-- the capture trigger (mig 03); this guard catches broken writers.
CREATE OR REPLACE FUNCTION public.tg_translation_variants_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.display_text IS NOT NULL OR NEW.display_json IS NOT NULL)
     AND NEW.active_revision_id IS NULL AND NEW.role = 'target' THEN
    RAISE EXCEPTION 'translation_variants: display without active_revision_id (%.% % %)',
      NEW.resource_kind, NEW.entity_id, NEW.field_path, NEW.lang;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS translation_variants_guard ON public.translation_variants;
CREATE TRIGGER translation_variants_guard
BEFORE INSERT OR UPDATE ON public.translation_variants
FOR EACH ROW EXECUTE FUNCTION public.tg_translation_variants_guard();

-- ── Long-content segments (resumable; REV 4 §B5/blocker 10) ───────────────
CREATE TABLE IF NOT EXISTS public.translation_segments (
  revision_id uuid NOT NULL REFERENCES public.translation_revisions(id) ON DELETE CASCADE,
  seg_ix int NOT NULL,
  source_seg text NOT NULL, translated_seg text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','failed')),
  attempts int NOT NULL DEFAULT 0, error text,
  PRIMARY KEY (revision_id, seg_ix)
);

-- ── Context-keyed translation memory (service-only; REV 4 §4c) ────────────
CREATE TABLE IF NOT EXISTS public.translation_memory (
  org_id uuid NOT NULL,
  source_lang text NOT NULL, target_lang text NOT NULL,
  resource_kind text NOT NULL,           -- '*' for global_terms rows
  context_scope text NOT NULL,           -- '<scope_id>:<field_path>' | '*'
  semantic_class text NOT NULL, sensitivity text NOT NULL, treatment text NOT NULL,
  prompt_version text NOT NULL, glossary_version int NOT NULL,
  source_hash text NOT NULL, source_text text, translated_text text NOT NULL,
  provider text, provider_model text, hit_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, source_lang, target_lang, resource_kind, context_scope,
               semantic_class, treatment, prompt_version, glossary_version, source_hash)
);

CREATE TABLE IF NOT EXISTS public.translation_glossary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  term_ar text NOT NULL, term_en text NOT NULL,
  kind text NOT NULL DEFAULT 'name' CHECK (kind IN ('name','term')),
  resource_scope text, field_scope text,
  is_active boolean NOT NULL DEFAULT true,
  notes text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tg_term_uq ON public.translation_glossary
  (org_id, lower(term_ar), COALESCE(resource_scope,''), COALESCE(field_scope,''));

CREATE TABLE IF NOT EXISTS public.translation_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  is_enabled boolean NOT NULL DEFAULT false,       -- global kill switch, ships OFF
  debounce_seconds int NOT NULL DEFAULT 20,
  max_queue_depth int NOT NULL DEFAULT 500,
  glossary_version int NOT NULL DEFAULT 1,
  prompt_version text NOT NULL DEFAULT 'v1',
  retention_days int NOT NULL DEFAULT 180
);
INSERT INTO public.translation_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Glossary edits bump the settings version so the worker stamps every row and
-- maintenance can find stale-under-old-glossary units (REV 4 §B4).
CREATE OR REPLACE FUNCTION public.tg_translation_glossary_bump()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE translation_settings SET glossary_version = glossary_version + 1 WHERE id;
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS translation_glossary_bump ON public.translation_glossary;
CREATE TRIGGER translation_glossary_bump
AFTER INSERT OR UPDATE OR DELETE ON public.translation_glossary
FOR EACH ROW EXECUTE FUNCTION public.tg_translation_glossary_bump();

-- ── Append-only history ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.translation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_kind text NOT NULL, entity_id uuid NOT NULL, field_path text NOT NULL, lang text,
  reason text NOT NULL CHECK (reason IN ('ai_translate','ai_retranslate','cache_hit','human_approve','human_edit',
    'human_unapprove','stale_mark','backfill','seed_import','seed_accept','seed_reject','source_flip',
    'source_lang_set','twin_fill','gc_prune','retranslate_requested')),
  old_status text, new_status text, revision_id uuid, actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── RLS + grants ──────────────────────────────────────────────────────────
ALTER TABLE public.translation_units     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translation_variants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translation_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translation_segments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translation_memory    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translation_glossary  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translation_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translation_history   ENABLE ROW LEVEL SECURITY;

-- TM / segments / settings / history: service-only. Clients read units/variants.
REVOKE ALL ON public.translation_memory, public.translation_segments,
  public.translation_settings, public.translation_history FROM anon, authenticated;

-- Visibility inherits the SOURCE resource's ACL through a STATIC dispatcher
-- (SECURITY INVOKER — the caller's own RLS applies inside each EXISTS arm;
-- no registry-supplied executables, REV 4 blocker 5).
CREATE OR REPLACE FUNCTION public.translation_visible(p_kind text, p_entity uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT CASE p_kind
    WHEN 'record' THEN EXISTS (SELECT 1 FROM public.unified_records ur WHERE ur.id = p_entity)
    WHEN 'wassel_doc' THEN EXISTS (SELECT 1 FROM public.wassel_documents d WHERE d.file_id = p_entity)
    ELSE false
  END;
$$;

DROP POLICY IF EXISTS tu_select ON public.translation_units;
CREATE POLICY tu_select ON public.translation_units FOR SELECT TO authenticated
  USING (public.translation_visible(resource_kind, entity_id));
DROP POLICY IF EXISTS tv_select ON public.translation_variants;
CREATE POLICY tv_select ON public.translation_variants FOR SELECT TO authenticated
  USING (public.translation_visible(resource_kind, entity_id));
DROP POLICY IF EXISTS trv_select ON public.translation_revisions;
CREATE POLICY trv_select ON public.translation_revisions FOR SELECT TO authenticated
  USING (public.translation_visible(resource_kind, entity_id));
-- Glossary: readable to signed-in users (terminology is not sensitive);
-- writes only via admin RPCs below.
DROP POLICY IF EXISTS tg_select ON public.translation_glossary;
CREATE POLICY tg_select ON public.translation_glossary FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.translation_units, public.translation_variants,
  public.translation_revisions, public.translation_glossary TO authenticated;

-- ── Authorization helpers (explicit uid checks — REV 4 §B6) ───────────────
-- Six separated permissions: view = RLS above · correct/edit = parent edit
-- right · approve = role action 'approve_translations' or admin ·
-- set_source_lang = parent edit right · manage policies/glossary = admin ·
-- accept seed batches = admin.
CREATE OR REPLACE FUNCTION public.translation_can_edit(p_uid uuid, p_kind text, p_entity uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  IF p_uid IS NULL THEN RETURN false; END IF;
  IF p_kind = 'record' THEN
    SELECT ur.model_id, ur.created_by_user_id, ur.data INTO r
    FROM unified_records ur WHERE ur.id = p_entity;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN wassell_can_edit_jsonb(p_uid, r.model_id, p_entity, r.created_by_user_id, r.data);
  END IF;
  -- Non-record kinds: admin-only until their edit adapters land (W6-M/W-Docs).
  RETURN wassell_is_admin(p_uid);
END $$;

CREATE OR REPLACE FUNCTION public.translation_can_approve(p_uid uuid, p_kind text, p_entity uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_model uuid;
BEGIN
  IF p_uid IS NULL THEN RETURN false; END IF;
  IF wassell_is_admin(p_uid) THEN RETURN true; END IF;
  IF p_kind = 'record' THEN
    SELECT model_id INTO v_model FROM translation_units
    WHERE resource_kind = 'record' AND entity_id = p_entity LIMIT 1;
    IF v_model IS NOT NULL THEN
      RETURN wassell_user_has_action(p_uid, v_model, 'approve_translations');
    END IF;
  END IF;
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION public.translation_can_edit(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.translation_can_approve(uuid, text, uuid) FROM PUBLIC, anon;

-- ── Lifecycle RPCs (SECURITY DEFINER + explicit authz + generation CAS) ───

-- Approve a specific revision as the display for its language.
CREATE OR REPLACE FUNCTION public.record_translation_approve(
  p_kind text, p_entity uuid, p_path text, p_lang text,
  p_revision_id uuid, p_expected_generation bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_unit translation_units%ROWTYPE; v_rev translation_revisions%ROWTYPE;
BEGIN
  IF NOT translation_can_approve(auth.uid(), p_kind, p_entity) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_unit FROM translation_units
  WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unit_not_found'; END IF;
  IF v_unit.generation <> p_expected_generation THEN
    RAISE EXCEPTION 'source_changed' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_rev FROM translation_revisions WHERE id = p_revision_id;
  IF NOT FOUND OR v_rev.field_path <> p_path OR v_rev.entity_id <> p_entity
     OR v_rev.lang <> p_lang OR v_rev.generation <> v_unit.generation THEN
    RAISE EXCEPTION 'revision_mismatch' USING ERRCODE = '40001';
  END IF;
  UPDATE translation_revisions SET status = 'approved', actor_user_id = auth.uid()
  WHERE id = p_revision_id;
  UPDATE translation_variants SET
    state = 'approved', generation = v_unit.generation,
    display_text = v_rev.translated_text, display_json = v_rev.translated_json,
    active_revision_id = p_revision_id, last_approved_revision_id = p_revision_id
  WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path AND lang = p_lang;
  INSERT INTO translation_history (resource_kind, entity_id, field_path, lang, reason,
    new_status, revision_id, actor_user_id)
  VALUES (p_kind, p_entity, p_path, p_lang, 'human_approve', 'approved', p_revision_id, auth.uid());
END $$;

CREATE OR REPLACE FUNCTION public.record_translation_unapprove(
  p_kind text, p_entity uuid, p_path text, p_lang text, p_expected_generation bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_unit translation_units%ROWTYPE;
BEGIN
  IF NOT translation_can_approve(auth.uid(), p_kind, p_entity) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_unit FROM translation_units
  WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unit_not_found'; END IF;
  IF v_unit.generation <> p_expected_generation THEN
    RAISE EXCEPTION 'source_changed' USING ERRCODE = '40001';
  END IF;
  UPDATE translation_variants SET
    state = CASE WHEN active_revision_id IS NULL THEN 'pending' ELSE 'translated' END,
    last_approved_revision_id = NULL, machine_owned = true
  WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path AND lang = p_lang;
  UPDATE translation_units SET dirty = true WHERE resource_kind = p_kind
    AND entity_id = p_entity AND field_path = p_path;
  INSERT INTO translation_history (resource_kind, entity_id, field_path, lang, reason, actor_user_id)
  VALUES (p_kind, p_entity, p_path, p_lang, 'human_unapprove', auth.uid());
END $$;

-- Target-side correction (REV 4 §B10/§B6): creates a HUMAN revision. When the
-- field requires approval and the caller can't approve, it lands as a
-- candidate for the approval queue — never auto-approved.
CREATE OR REPLACE FUNCTION public.record_translation_human_edit(
  p_kind text, p_entity uuid, p_path text, p_lang text,
  p_text text, p_expected_generation bigint
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_unit translation_units%ROWTYPE;
  v_requires boolean; v_can_approve boolean; v_rev uuid;
BEGIN
  IF NOT translation_can_edit(auth.uid(), p_kind, p_entity) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(p_text), '') = '' THEN RAISE EXCEPTION 'empty_text'; END IF;
  SELECT * INTO v_unit FROM translation_units
  WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unit_not_found'; END IF;
  IF v_unit.generation <> p_expected_generation THEN
    RAISE EXCEPTION 'source_changed' USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(require_approval, false) INTO v_requires
  FROM translation_field_policies
  WHERE resource_kind = p_kind AND field_path = split_part(p_path, '[', 1)
    AND scope_id = COALESCE(v_unit.model_id, '00000000-0000-0000-0000-000000000000');
  v_can_approve := translation_can_approve(auth.uid(), p_kind, p_entity);

  INSERT INTO translation_revisions (resource_kind, entity_id, field_path, lang, generation,
    source_rev, source_lang, translated_text, origin, status, actor_user_id)
  VALUES (p_kind, p_entity, p_path, p_lang, v_unit.generation,
    v_unit.source_rev, v_unit.source_lang, btrim(p_text), 'human',
    CASE WHEN COALESCE(v_requires,false) AND NOT v_can_approve THEN 'candidate' ELSE 'approved' END,
    auth.uid())
  RETURNING id INTO v_rev;

  IF NOT (COALESCE(v_requires,false) AND NOT v_can_approve) THEN
    UPDATE translation_variants SET
      state = 'approved', generation = v_unit.generation,
      display_text = btrim(p_text), display_json = NULL,
      active_revision_id = v_rev, last_approved_revision_id = v_rev,
      machine_owned = false
    WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path AND lang = p_lang;
  END IF;

  INSERT INTO translation_history (resource_kind, entity_id, field_path, lang, reason,
    new_status, revision_id, actor_user_id)
  VALUES (p_kind, p_entity, p_path, p_lang, 'human_edit',
    CASE WHEN COALESCE(v_requires,false) AND NOT v_can_approve THEN 'candidate' ELSE 'approved' END,
    v_rev, auth.uid());
  RETURN v_rev;
END $$;

-- Manual source-language correction (locked against re-detection).
CREATE OR REPLACE FUNCTION public.record_translation_set_source_lang(
  p_kind text, p_entity uuid, p_path text, p_lang text, p_expected_generation bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_unit translation_units%ROWTYPE;
BEGIN
  IF NOT translation_can_edit(auth.uid(), p_kind, p_entity) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_lang NOT IN ('ar','en') THEN RAISE EXCEPTION 'invalid_lang'; END IF;
  SELECT * INTO v_unit FROM translation_units
  WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unit_not_found'; END IF;
  IF v_unit.generation <> p_expected_generation THEN
    RAISE EXCEPTION 'source_changed' USING ERRCODE = '40001';
  END IF;
  UPDATE translation_units SET
    source_lang = p_lang, source_lang_locked = true,
    generation = generation + 1, dirty = true, updated_at = now()
  WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path;
  -- Role swap + display invalidation (REV 4 §B2 steps 4-5, minus parent write).
  UPDATE translation_variants v SET
    role = CASE WHEN v.lang = p_lang THEN 'source' ELSE 'target' END,
    state = CASE WHEN v.lang = p_lang THEN 'source' ELSE 'pending' END,
    display_text = NULL, display_json = NULL, active_revision_id = NULL
  WHERE v.resource_kind = p_kind AND v.entity_id = p_entity AND v.field_path = p_path;
  INSERT INTO translation_history (resource_kind, entity_id, field_path, lang, reason, actor_user_id)
  VALUES (p_kind, p_entity, p_path, p_lang, 'source_lang_set', auth.uid());
END $$;

-- Manual retranslation: bumps the generation (new basis) and marks dirty; the
-- reconcile/queue picks it up. Never blocked by prior candidates (idempotency
-- is per generation).
CREATE OR REPLACE FUNCTION public.record_translation_retranslate(
  p_kind text, p_entity uuid, p_path text, p_expected_generation bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_gen bigint;
BEGIN
  IF NOT translation_can_edit(auth.uid(), p_kind, p_entity) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  UPDATE translation_units SET generation = generation + 1, dirty = true,
    next_retry_at = now(), updated_at = now()
  WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path
    AND generation = p_expected_generation
  RETURNING generation INTO v_gen;
  IF NOT FOUND THEN RAISE EXCEPTION 'source_changed' USING ERRCODE = '40001'; END IF;
  UPDATE translation_variants SET display_text = NULL, display_json = NULL,
    active_revision_id = NULL, state = 'pending'
  WHERE resource_kind = p_kind AND entity_id = p_entity AND field_path = p_path AND role = 'target'
    AND machine_owned;   -- human-owned displays survive a bulk retranslate request
  INSERT INTO translation_history (resource_kind, entity_id, field_path, reason, actor_user_id)
  VALUES (p_kind, p_entity, p_path, 'retranslate_requested', auth.uid());
END $$;

-- ── Read contract (SECURITY INVOKER — RLS composes; REV 4 §C1) ────────────
CREATE OR REPLACE FUNCTION public.record_data_localized(p_record_id uuid, p_lang text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT ur.data || COALESCE((
    SELECT jsonb_object_agg(v.field_path, to_jsonb(v.display_text))
    FROM public.translation_variants v
    JOIN public.translation_units u USING (resource_kind, entity_id, field_path)
    WHERE v.resource_kind = 'record' AND v.entity_id = ur.id
      AND v.lang = p_lang AND v.role = 'target'
      AND v.state IN ('translated','approved')
      AND v.generation = u.generation           -- never serve a stale generation
      AND v.display_text IS NOT NULL
      AND position('[' in v.field_path) = 0     -- scalar overlay; elements resolve client/api-side
      AND v.field_path NOT LIKE 'pair:%'
  ), '{}'::jsonb)
  FROM public.unified_records ur WHERE ur.id = p_record_id;
$$;

-- Full per-field status contract for one entity (drives the response shape
-- {requested_lang, resolved_lang, value, status, source_lang, generation,
-- active_revision_id} in api/ and the SPA).
CREATE OR REPLACE FUNCTION public.entity_translation_status(p_kind text, p_entity uuid)
RETURNS TABLE (field_path text, lang text, role text, state text,
               display_text text, generation bigint, unit_generation bigint,
               source_lang text, source_lang_locked boolean, dirty boolean,
               active_revision_id uuid, machine_owned boolean)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT v.field_path, v.lang, v.role, v.state, v.display_text,
         v.generation, u.generation, u.source_lang, u.source_lang_locked,
         u.dirty, v.active_revision_id, v.machine_owned
  FROM public.translation_variants v
  JOIN public.translation_units u USING (resource_kind, entity_id, field_path)
  WHERE v.resource_kind = p_kind AND v.entity_id = p_entity;
$$;

GRANT EXECUTE ON FUNCTION public.record_data_localized(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.entity_translation_status(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_translation_approve(text, uuid, text, text, uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_translation_unapprove(text, uuid, text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_translation_human_edit(text, uuid, text, text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_translation_set_source_lang(text, uuid, text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_translation_retranslate(text, uuid, text, bigint) TO authenticated;
