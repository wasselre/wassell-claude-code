-- Variant roles must follow the source language when it flips.
--
-- WHAT WAS WRONG. `ensureVariants` (worker/src/runTranslationJob.ts) upserts the
-- ar/en variant rows with `ignoreDuplicates: true`: it can CREATE a row but can
-- never CORRECT one. That is deliberate for `state` — re-running a job must not
-- reset a translated variant back to pending and pay for it again — but it also
-- froze `role`, which is not a per-run detail: it says which side is the source.
--
-- So when a field's detected source language flips, the roles stay as they were:
--
--   clients «منيرة عبدالله» → client_name, source_lang flipped en→ar at
--   generation 2. The ar row stayed role='target', state='pending'; the en row
--   stayed role='source'. `translation_variant_activate` only ever updates a row
--   with `role = 'target' AND machine_owned`, so every English translation the
--   worker produced was DISCARDED — it returns false, which the worker reads as
--   "the source moved on", so nothing was even recorded as an error. Meanwhile
--   the stale ar 'target' row kept the unit dirty. A provider call every 15
--   minutes, no error, no progress, from 31 August to 27 September.
--
-- Measured before this migration: 4 rows / 2 fields across the whole database —
-- the client above, and units.notes on one unit (source_lang='en' with the ar
-- row marked source and the en row a "translation" of itself).
--
-- THE REPAIR. One statement that rewrites ONLY rows whose role disagrees with
-- the current source side. A row whose role is already right is never touched,
-- so nothing is re-translated and no cost is incurred by running this often.
--
-- `machine_owned = false` rows are deliberately EXEMPT: a human owns that text,
-- and flipping their row's role would silently reclassify their work. Such a row
-- keeps its unit dirty until the retry cap blocks it, which puts it in front of
-- an operator instead of quietly rewriting it.

BEGIN;

-- A repair that leaves work undone is its own quiet bug: flipping the roles can
-- turn a row into a PENDING target on a unit that is already clean, and the
-- reconcile only sweeps dirty units — so that translation would never be
-- produced while looking exactly like one on its way. The function therefore
-- marks the unit dirty when it actually changed something. `retry_count` is
-- deliberately NOT reset: a field near its cap should not buy six more rounds of
-- the same failure just because its roles were straightened out.
CREATE OR REPLACE FUNCTION public.translation_variant_repair_roles(
  p_kind text, p_entity uuid, p_path text, p_source_lang text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_fixed int;
BEGIN
  WITH fixed AS (
    UPDATE translation_variants v SET
      -- With a known source side, that language is the source and the other is
      -- a target. With none (a 'mixed' source), BOTH languages are targets.
      role  = CASE WHEN p_source_lang IS NOT NULL AND v.lang = p_source_lang
                   THEN 'source' ELSE 'target' END,
      state = CASE WHEN p_source_lang IS NOT NULL AND v.lang = p_source_lang
                   THEN 'source' ELSE 'pending' END,
      -- A row changing sides carries a display that belongs to the other side:
      -- a source's text comes from the record, and a new target has not been
      -- translated yet. Keeping either would show the wrong language.
      display_text = NULL, display_json = NULL, active_revision_id = NULL,
      generation = NULL, attempts = 0, last_error = NULL, updated_at = now()
    WHERE v.resource_kind = p_kind AND v.entity_id = p_entity AND v.field_path = p_path
      AND v.machine_owned
      AND v.role <> CASE WHEN p_source_lang IS NOT NULL AND v.lang = p_source_lang
                         THEN 'source' ELSE 'target' END
    RETURNING 1
  )
  SELECT COALESCE(count(*), 0)::int INTO v_fixed FROM fixed;

  IF v_fixed > 0 THEN
    UPDATE translation_units u
       SET dirty = true, next_retry_at = now(), updated_at = now()
     WHERE u.resource_kind = p_kind AND u.entity_id = p_entity AND u.field_path = p_path
       AND u.blocked_at IS NULL     -- a blocked unit stays blocked; unblock is explicit
       AND NOT u.dirty;
  END IF;

  RETURN v_fixed;
END $$;

REVOKE ALL ON FUNCTION public.translation_variant_repair_roles(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.translation_variant_repair_roles(text, uuid, text, text) TO service_role;

-- One-time sweep of what is already wrong. Guarded so the migration replays on a
-- fresh database (CI) that has no such rows.
DO $repair$
DECLARE r record; v_fixed int := 0; v_total int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT u.resource_kind, u.entity_id, u.field_path, u.source_lang
    FROM translation_units u
    JOIN translation_variants v
      ON v.resource_kind = u.resource_kind AND v.entity_id = u.entity_id
     AND v.field_path = u.field_path
    WHERE u.source_lang IN ('ar','en')
      AND v.machine_owned
      AND v.role <> CASE WHEN v.lang = u.source_lang THEN 'source' ELSE 'target' END
  LOOP
    v_fixed := public.translation_variant_repair_roles(
      r.resource_kind, r.entity_id, r.field_path, r.source_lang);
    v_total := v_total + v_fixed;
  END LOOP;
  RAISE NOTICE 'translation_variant_repair_roles: repaired % row(s)', v_total;
END $repair$;

COMMIT;
