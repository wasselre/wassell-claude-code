-- ════════════════════════════════════════════════════════════════════════════
-- W7 (bilingual): twin (_ar/_en) auto-fill — the backfill enqueuer.
--
-- Ongoing auto-fill needs no new plumbing: the capture trigger already enqueues
-- a translation job when a twin physical field changes (its enqueue predicate
-- recognizes `pair:` policies), and the worker's pair pass (runTranslationJob)
-- materializes the authored side's translation into the EMPTY twin column via
-- record_twin_fill. This RPC covers EXISTING records — it enqueues one job per
-- record that has exactly one twin side filled, so the worker fills the other.
--
-- Operator-run at go-live (after confirming a model's pair policy). The worker
-- claim is globally gated on translation_settings.is_enabled, so enqueued jobs
-- only drain when the pipeline is on. Idempotent — re-runnable; a record whose
-- other side is already filled no longer matches the XOR predicate.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.translation_twin_backfill(p_model_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_total int := 0; v_n int; v_pol record; v_ar text; v_en text;
BEGIN
  FOR v_pol IN
    SELECT field_path, twin_counterpart_path FROM translation_field_policies
    WHERE resource_kind = 'record' AND scope_id = p_model_id
      AND classification_status = 'confirmed' AND field_path LIKE 'pair:%'
      AND twin_counterpart_path IS NOT NULL
  LOOP
    v_ar := split_part(v_pol.twin_counterpart_path, '|', 1);
    v_en := split_part(v_pol.twin_counterpart_path, '|', 2);
    IF v_ar = '' OR v_en = '' THEN CONTINUE; END IF;

    -- Exactly one side filled ((ar empty) XOR (en empty)) ⇒ enqueue. changed_paths
    -- carries both twin columns so the worker's pair pass targets this pair.
    INSERT INTO translation_jobs (resource_kind, entity_id, model_id, changed_paths, run_after)
    SELECT 'record', r.id, p_model_id, ARRAY[v_ar, v_en], now()
    FROM records r
    WHERE r.model_id = p_model_id
      AND ((COALESCE(btrim(r.data->>v_ar), '') = '') <> (COALESCE(btrim(r.data->>v_en), '') = ''))
    ON CONFLICT (resource_kind, entity_id) WHERE status = 'queued'
    DO UPDATE SET
      changed_paths = (SELECT array_agg(DISTINCT x)
                       FROM unnest(translation_jobs.changed_paths || EXCLUDED.changed_paths) x),
      updated_at = now();
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;
  END LOOP;
  RETURN v_total;
END $$;

REVOKE ALL ON FUNCTION public.translation_twin_backfill(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.translation_twin_backfill(uuid) TO service_role;
