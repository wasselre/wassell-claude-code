-- ═══════════════════════════════════════════════════════════════════════════
-- Bilingual architecture W2 — migration 07: seed-acceptance RPCs.
--
-- REV 4 §D3: legacy-cache seeds import as INACTIVE candidates; the ONLY path
-- to display is a recorded per-field acceptance. These RPCs power the Review
-- panel: a reviewer samples a field's pairs, then accepts (activates every
-- generation-valid seed candidate for that field) or rejects (marks them
-- rejected; the worker regenerates at cutover). Both admin-gated in-body.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.translation_seed_field_summary(p_model_id uuid)
RETURNS TABLE (field_path text, seed_count bigint, accepted_count bigint,
               samples jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.field_path,
         count(*) FILTER (WHERE r.status = 'candidate') AS seed_count,
         count(*) FILTER (WHERE r.status = 'active') AS accepted_count,
         (SELECT jsonb_agg(jsonb_build_object('src', s.source_text, 'en', s.translated_text))
          FROM (SELECT source_text, translated_text FROM translation_revisions s2
                WHERE s2.resource_kind='record' AND s2.origin='seed'
                  AND s2.field_path = r.field_path
                  AND s2.entity_id IN (SELECT entity_id FROM translation_units
                                       WHERE model_id = p_model_id AND field_path = r.field_path)
                ORDER BY random() LIMIT 10) s(source_text, translated_text)) AS samples
  FROM translation_revisions r
  JOIN translation_units u ON u.resource_kind = r.resource_kind
   AND u.entity_id = r.entity_id AND u.field_path = r.field_path
  WHERE r.resource_kind = 'record' AND r.origin = 'seed' AND u.model_id = p_model_id
  GROUP BY r.field_path
  ORDER BY r.field_path;
$$;

CREATE OR REPLACE FUNCTION public.translation_seed_accept(
  p_model_id uuid, p_field_path text, p_accept boolean
) RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int := 0;
BEGIN
  IF NOT wassell_is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF p_accept THEN
    -- Activate every seed candidate whose unit is STILL at the seed's
    -- generation and source_rev (generation CAS — values edited since the
    -- import are skipped; the worker handles them fresh).
    WITH act AS (
      UPDATE translation_variants v SET
        state = 'translated', generation = u.generation,
        display_text = r.translated_text, display_json = NULL,
        active_revision_id = r.id
      FROM translation_units u, translation_revisions r
      WHERE u.resource_kind = 'record' AND u.model_id = p_model_id
        AND u.field_path = p_field_path
        AND v.resource_kind = u.resource_kind AND v.entity_id = u.entity_id
        AND v.field_path = u.field_path AND v.lang = 'en' AND v.role = 'target'
        AND v.machine_owned AND v.active_revision_id IS NULL
        AND r.resource_kind = u.resource_kind AND r.entity_id = u.entity_id
        AND r.field_path = u.field_path AND r.lang = 'en'
        AND r.origin = 'seed' AND r.status = 'candidate'
        AND r.generation = u.generation AND r.source_rev = u.source_rev
      RETURNING r.id
    )
    UPDATE translation_revisions SET status = 'active'
    WHERE id IN (SELECT id FROM act);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    -- Units whose seed activated are no longer dirty (nothing left to do).
    UPDATE translation_units u SET dirty = false, next_retry_at = NULL
    WHERE u.resource_kind='record' AND u.model_id = p_model_id AND u.field_path = p_field_path
      AND NOT EXISTS (SELECT 1 FROM translation_variants v
        WHERE v.resource_kind=u.resource_kind AND v.entity_id=u.entity_id
          AND v.field_path=u.field_path AND v.role='target' AND v.machine_owned
          AND v.state IN ('pending','failed'));
    INSERT INTO translation_history (resource_kind, entity_id, field_path, lang, reason, actor_user_id)
    VALUES ('record', p_model_id, p_field_path, 'en', 'seed_accept', auth.uid());
  ELSE
    WITH rej AS (
      UPDATE translation_revisions r SET status = 'rejected'
      FROM translation_units u
      WHERE u.resource_kind='record' AND u.model_id = p_model_id AND u.field_path = p_field_path
        AND r.resource_kind = u.resource_kind AND r.entity_id = u.entity_id
        AND r.field_path = u.field_path AND r.origin = 'seed' AND r.status = 'candidate'
      RETURNING 1
    ) SELECT count(*) INTO v_n FROM rej;
    INSERT INTO translation_history (resource_kind, entity_id, field_path, lang, reason, actor_user_id)
    VALUES ('record', p_model_id, p_field_path, 'en', 'seed_reject', auth.uid());
  END IF;
  RETURN v_n;
END $$;

GRANT EXECUTE ON FUNCTION public.translation_seed_field_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.translation_seed_accept(uuid, text, boolean) TO authenticated;

-- Review overview (per-model unit/variant/seed counts) for the Settings panel.
CREATE OR REPLACE FUNCTION public.translation_review_overview()
RETURNS TABLE (model_id uuid, model_name text, units bigint, dirty bigint,
               pending bigint, translated bigint, approved bigint, failed bigint,
               seeds_awaiting bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.model_id, m.name,
    count(DISTINCT (u.entity_id, u.field_path)),
    count(DISTINCT (u.entity_id, u.field_path)) FILTER (WHERE u.dirty),
    count(*) FILTER (WHERE v.state = 'pending'),
    count(*) FILTER (WHERE v.state = 'translated'),
    count(*) FILTER (WHERE v.state = 'approved'),
    count(*) FILTER (WHERE v.state = 'failed'),
    (SELECT count(*) FROM translation_revisions r
     WHERE r.origin='seed' AND r.status='candidate'
       AND r.entity_id IN (SELECT entity_id FROM translation_units u2 WHERE u2.model_id = u.model_id))
  FROM translation_units u
  JOIN models m ON m.id = u.model_id
  LEFT JOIN translation_variants v
    ON v.resource_kind = u.resource_kind AND v.entity_id = u.entity_id
   AND v.field_path = u.field_path AND v.role = 'target'
  WHERE u.resource_kind = 'record' AND u.model_id IS NOT NULL
  GROUP BY u.model_id, m.name
  ORDER BY m.name;
$$;
GRANT EXECUTE ON FUNCTION public.translation_review_overview() TO authenticated;
