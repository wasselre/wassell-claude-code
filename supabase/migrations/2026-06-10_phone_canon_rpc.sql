-- 2026-06-10 — Canonical KSA phone matching (durable normalization fix)
-- ---------------------------------------------------------------------------
-- Problem this closes: phone->client matching used to compare either exact
-- strings or raw digits, so the SAME number stored in different shapes did not
-- match (e.g. call "+966532577669" vs client "532577669"). ~45% of clients
-- store the bare 9-digit form.
--
-- Fix: ONE canonical function used by BOTH the Hatif webhook (new calls) and
-- the client-link backfill. It normalizes ANY shape — "+966…", bare 9-digit,
-- "05…", "00966…", spaces, dashes — to KSA E.164 digits "966XXXXXXXXX", and we
-- compare the canon of BOTH sides. Format-agnostic, so this can't silently
-- regress when a future import introduces a new spelling.
--
-- Idempotent (CREATE OR REPLACE). No table changes.

-- Canonicalize a phone string to KSA E.164 digits ("966XXXXXXXXX").
-- Strips non-digits + a leading "00" international prefix, then reconciles a
-- leading 966 / leading 0 / bare 9-digit Saudi subscriber number. Foreign /
-- unknown numbers keep their full digit string. NULL when there are no digits.
CREATE OR REPLACE FUNCTION public.ksa_phone_canon(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN d = ''        THEN NULL
           WHEN d ~ '^966'    THEN d
           WHEN d ~ '^0'      THEN '966' || substring(d from 2)
           WHEN length(d) = 9 THEN '966' || d   -- bare KSA subscriber (5XXXXXXXX / 1XXXXXXXX)
           ELSE d                               -- foreign / unknown: keep digits
         END
  FROM (
    SELECT CASE WHEN d0 ~ '^00' THEN substring(d0 from 3) ELSE d0 END AS d
    FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d0) z
  ) y
$$;

COMMENT ON FUNCTION public.ksa_phone_canon(text) IS
  'Canonicalize a phone to KSA E.164 digits (966XXXXXXXXX). Strips non-digits + 00 prefix; reconciles 966 / leading-0 / bare-9. NULL if no digits. Single source of truth for phone->client matching (webhook + backfill).';

-- First client (by created_at) whose phone_number canonicalizes to the same
-- KSA E.164 as p_phone, else NULL. Goes through unified_records so it works
-- whether the clients model is frozen or not.
CREATE OR REPLACE FUNCTION public.find_client_id_by_phone(p_phone text)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT cl.id
  FROM public.unified_records cl
  WHERE cl.model_id = (SELECT id FROM public.models WHERE name = 'clients')
    AND public.ksa_phone_canon(p_phone) IS NOT NULL
    AND public.ksa_phone_canon(cl.data->>'phone_number') = public.ksa_phone_canon(p_phone)
  ORDER BY cl.created_at
  LIMIT 1
$$;

COMMENT ON FUNCTION public.find_client_id_by_phone(text) IS
  'First client id whose phone_number canonicalizes (ksa_phone_canon) to the same value as p_phone, else NULL. Format-agnostic. Used by api/webhook/hatif-call.ts.';

GRANT EXECUTE ON FUNCTION public.ksa_phone_canon(text)        TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.find_client_id_by_phone(text) TO anon, authenticated, service_role;
