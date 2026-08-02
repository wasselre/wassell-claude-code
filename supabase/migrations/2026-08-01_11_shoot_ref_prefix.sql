-- ============================================================================
-- Shoot request refs: SR-*, as the approved design shows — not SH-*.
--
-- The mos_tg_shoot_ref trigger hardcoded 'SH-'; every approved screen
-- (s24/s42/s30) shows SR-003-style refs. Change the allocator, migrate the
-- counter row, and re-ref existing rows in place (refs are display
-- identifiers; nothing joins on them — mos_assets links via shoot_request_id).
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.mos_tg_shoot_ref()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.ref IS NULL THEN NEW.ref := public.mos_next_ref('SR-'); END IF;
  RETURN NEW;
END $function$;

-- Carry the SH- counter forward so numbering continues, then retire it.
INSERT INTO public.mos_ref_counters (prefix, next_number)
SELECT 'SR-', next_number FROM public.mos_ref_counters WHERE prefix = 'SH-'
ON CONFLICT (prefix) DO UPDATE
  SET next_number = GREATEST(public.mos_ref_counters.next_number, EXCLUDED.next_number);
DELETE FROM public.mos_ref_counters WHERE prefix = 'SH-';

UPDATE public.mos_shoot_requests
   SET ref = replace(ref, 'SH-', 'SR-')
 WHERE ref LIKE 'SH-%';

COMMIT;
