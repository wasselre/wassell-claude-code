-- ============================================================================
-- Backfill: normalize all clients.phone_number values to E.164 (2026-05-11)
--
-- Discovered while testing the new appointments phone-first auto-link:
-- every existing client record had phone_number stored as the bare 9-digit
-- mobile (e.g. "599780010") rather than canonical E.164 ("+966599780010").
-- The form (src/pages/Records/components/PhoneInput.tsx) DOES emit E.164
-- via joinPhone(), so new edits/inserts already canonicalize. But the
-- existing data was imported / created before that became the convention,
-- so the auto-link search (which normalizes the typed input to E.164 and
-- does a `data->>'phone_number' = '+966xxxxxxxxx'` equality) missed every
-- existing client.
--
-- This migration creates two helper functions that mirror the JS logic in
-- src/lib/phone.ts:
--   - phone_strip_trunk_zero(digits)
--   - phone_normalize(raw)
--
-- Then it UPDATEs every client record whose stored phone differs from the
-- normalized form. Idempotent — re-running is a no-op once everything is
-- already in E.164.
--
-- The helpers are kept around (CREATE OR REPLACE) so future migrations and
-- ad-hoc cleanups can reuse them.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phone_strip_trunk_zero(p_digits text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  cc text;
BEGIN
  -- Longest-prefix wins. Saudi (3) checked before US/Canada (1).
  FOR cc IN
    SELECT v FROM (VALUES
      ('966'), ('971'), ('965'), ('973'), ('974'), ('968'), ('967'),
      ('962'), ('961'), ('963'), ('964'), ('212'),
      ('20'), ('90'), ('92'), ('91'), ('44'), ('33'), ('49'),
      ('1')
    ) AS t(v) ORDER BY length(v) DESC
  LOOP
    IF starts_with(p_digits, cc || '0') THEN
      RETURN cc || substring(p_digits FROM length(cc) + 2);
    END IF;
  END LOOP;
  RETURN p_digits;
END;
$$;

CREATE OR REPLACE FUNCTION public.phone_normalize(p_raw text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_trimmed text;
  v_has_plus boolean;
  v_digits text;
BEGIN
  IF p_raw IS NULL THEN RETURN NULL; END IF;
  v_trimmed := btrim(p_raw);
  IF v_trimmed = '' THEN RETURN NULL; END IF;
  v_has_plus := starts_with(v_trimmed, '+');
  v_digits := regexp_replace(v_trimmed, '\D', '', 'g');
  IF length(v_digits) < 7 THEN RETURN NULL; END IF;

  IF v_has_plus THEN
    RETURN '+' || public.phone_strip_trunk_zero(v_digits);
  END IF;
  IF starts_with(v_digits, '00') THEN
    RETURN '+' || public.phone_strip_trunk_zero(substring(v_digits FROM 3));
  END IF;
  IF starts_with(v_digits, '0') THEN
    RETURN '+966' || substring(v_digits FROM 2);
  END IF;
  IF starts_with(v_digits, '966') THEN
    RETURN '+' || public.phone_strip_trunk_zero(v_digits);
  END IF;
  RETURN '+966' || v_digits;
END;
$$;

-- Apply the backfill on the clients model.
UPDATE public.records
SET data = jsonb_set(data, '{phone_number}', to_jsonb(public.phone_normalize(data->>'phone_number')))
WHERE model_id = (SELECT id FROM models WHERE name = 'clients')
  AND data ? 'phone_number'
  AND data->>'phone_number' IS NOT NULL
  AND data->>'phone_number' <> ''
  AND data->>'phone_number' <> COALESCE(public.phone_normalize(data->>'phone_number'), '');
