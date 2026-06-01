-- ============================================================
-- 2026-06-01 — Auto-ID duplicate repair + counter realignment
-- ============================================================
-- One-time corrective for auto_id values that had already drifted into
-- collisions before the self-heal RPC landed (see
-- 2026-06-01_auto_id_selfheal_rpc.sql for the root-cause writeup).
-- On prod this cleaned 1 clients dup (`ع218`) and 12 all_projects dups
-- (`م ش055…061`, `م ش1766…1775`).
--
-- For every GLOBAL-scope auto_id field on an unfrozen model:
--   * keep the OLDEST record in each duplicate-value group,
--   * re-issue fresh ids (max+1, max+2, …) to the newer ones,
--   * realign the server counter to the post-repair max.
--
-- Idempotent: on a clean DB (or a re-run) no duplicates exist, so every
-- UPDATE matches zero rows and the migration is a no-op.
--
-- NOTE the pad uses GREATEST(pad, length(n)) — a plain lpad(n, pad, '0')
-- TRUNCATES when n is longer than pad (Postgres semantics), which would
-- corrupt 4-digit ids under a 3-pad field (e.g. 2783 -> '278').
-- ============================================================

BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT m.id AS model_id,
           (f->>'id')                       AS field_id,
           (f->>'name')                     AS field_name,
           COALESCE(f->>'auto_id_prefix','') AS prefix,
           COALESCE((f->>'auto_id_padding')::int, 0) AS pad
    FROM public.models m
    CROSS JOIN LATERAL jsonb_array_elements(m.schema->'sections') s
    CROSS JOIN LATERAL jsonb_array_elements(s->'fields') f
    WHERE f->>'type' = 'auto_id'
      AND COALESCE(f->>'auto_id_scope_field_id','') = ''   -- global scope only
      AND m.is_hardcoded = false                            -- values live in records
  LOOP
    -- Re-id the newer duplicates to max+seq (non-truncating pad).
    EXECUTE format($q$
      WITH dup AS (
        SELECT id, row_number() OVER (PARTITION BY data->>%1$L ORDER BY created_at, id) AS rn
        FROM public.records
        WHERE model_id = %2$L AND COALESCE(data->>%1$L,'') <> ''
      ),
      mx AS (
        SELECT COALESCE(MAX(NULLIF(regexp_replace(data->>%1$L,'\D','','g'),'')::bigint),0) AS m
        FROM public.records WHERE model_id = %2$L
      ),
      fix AS ( SELECT id, row_number() OVER (ORDER BY id) AS seq FROM dup WHERE rn > 1 )
      UPDATE public.records t
      SET data = jsonb_set(t.data, ARRAY[%1$L],
            to_jsonb(%3$L || lpad(((SELECT m FROM mx)+f.seq)::text,
                          GREATEST(%4$s, length(((SELECT m FROM mx)+f.seq)::text)), '0'))),
          updated_at = now()
      FROM fix f WHERE t.id = f.id
    $q$, r.field_name, r.model_id, r.prefix, r.pad);

    -- Realign the counter to the post-repair max.
    EXECUTE format($q$
      UPDATE public.auto_id_counters c
      SET current_value = (SELECT COALESCE(MAX(NULLIF(regexp_replace(data->>%1$L,'\D','','g'),'')::bigint),0)
                           FROM public.records WHERE model_id = %2$L),
          updated_at = now()
      WHERE c.model_id = %2$L AND c.field_id = %3$L AND c.scope_key = '__global__'
    $q$, r.field_name, r.model_id, r.field_id);
  END LOOP;
END $$;

COMMIT;
