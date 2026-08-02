-- ═══════════════════════════════════════════════════════════════════════════
-- Bilingual architecture W1 — migration 06: stable row identity for `table`
-- fields (REV 4 §B5 / blocker 5).
--
-- Element-path translation units (`features[id=<uuid>].name`) require ids
-- that survive reordering/deletion. Live audit 2026-08-02: NOTES entries are
-- already 100% id'd (NoteEntry.id, uuid at creation); TABLE rows have none.
-- In-scope backlog ≈ 1,767 rows (all_projects features/guarantees/services/
-- nearby_landmarks, project_details features/landmarks, targeted_projects,
-- reel_scripts). market_listings' 503k table rows are excluded (D-2) and are
-- simply never passed to this RPC.
--
-- The RPC is operator-run post-apply (scripts/backfill-element-ids.mjs), NOT
-- executed inside this migration — data writes at migration time would hold
-- locks across live records. It marks its statements as system writes so the
-- workflow/translation capture triggers skip them, and it does NOT touch
-- updated_at/version semantics beyond what the records triggers do.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.translation_assign_row_ids(p_model_id uuid, p_limit int DEFAULT 200)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_slugs text[];
  v_count int := 0;
  r record;
  v_new jsonb;
  v_slug text;
  v_changed boolean;
BEGIN
  SELECT COALESCE(array_agg(f->>'name'), '{}') INTO v_slugs
  FROM models m,
       jsonb_array_elements(m.schema->'sections') s,
       jsonb_array_elements(s->'fields') f
  WHERE m.id = p_model_id AND f->>'type' = 'table';
  IF v_slugs = '{}' THEN RETURN 0; END IF;

  PERFORM set_config('wassell.system_write', 'element_id_backfill', true);

  FOR r IN
    SELECT rec.id, rec.data FROM records rec
    WHERE rec.model_id = p_model_id
      AND EXISTS (
        SELECT 1 FROM unnest(v_slugs) sl
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(rec.data->sl) = 'array' THEN rec.data->sl ELSE '[]'::jsonb END) e(el)
        WHERE jsonb_typeof(e.el) = 'object' AND NOT (e.el ? '_row_id'))
    LIMIT p_limit
  LOOP
    v_new := r.data;
    v_changed := false;
    FOREACH v_slug IN ARRAY v_slugs LOOP
      IF jsonb_typeof(v_new->v_slug) = 'array'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_new->v_slug) e(el)
                     WHERE jsonb_typeof(e.el) = 'object' AND NOT (e.el ? '_row_id')) THEN
        DECLARE v_arr jsonb;
        BEGIN
          SELECT jsonb_agg(
            CASE WHEN jsonb_typeof(e.el) = 'object' AND NOT (e.el ? '_row_id')
                 THEN e.el || jsonb_build_object('_row_id', gen_random_uuid()::text)
                 ELSE e.el END
            ORDER BY e.ord)
          INTO v_arr
          FROM jsonb_array_elements(v_new->v_slug) WITH ORDINALITY e(el, ord);
          v_new := jsonb_set(v_new, ARRAY[v_slug], COALESCE(v_arr, '[]'::jsonb));
          v_changed := true;
        END;
      END IF;
    END LOOP;
    IF v_changed THEN
      UPDATE records SET data = v_new WHERE id = r.id;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  PERFORM set_config('wassell.system_write', '', true);
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.translation_assign_row_ids(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.translation_assign_row_ids(uuid, int) TO service_role;
