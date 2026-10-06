-- Is this WhatsApp number someone we already know who is NOT a client?
-- (operator, 2026-10-06: a message that is not from an ad, from a number that
-- is not a client "and not anything else", that asks about a project or shows
-- clear interest → create the client and let the sales agent reply.)
--
-- "Anything else" = the parties the chat list already recognises by phone —
-- a saved contact, a project officer, an advertiser — plus the real-estate
-- offices the office-outreach line writes to. Returns the model name of the
-- first match, or NULL for a number we do not know at all.
--
-- Same phone rule as find_client_id_by_phone (ksa_phone_canon on both sides),
-- with a digits-only fallback so a non-Saudi number still matches itself.
-- Service role only (it reveals who a number belongs to). No 40001/40P01.

CREATE OR REPLACE FUNCTION public.wa_phone_known_party(p_phone text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH want AS (
    SELECT COALESCE(public.ksa_phone_canon(p_phone), NULLIF(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), '')) AS c
  ),
  fields AS (
    SELECT m.id AS model_id, m.name, f->>'name' AS slug
    FROM public.models m,
         jsonb_array_elements(COALESCE(m.schema->'sections', '[]'::jsonb)) s,
         jsonb_array_elements(COALESCE(s->'fields', '[]'::jsonb)) f
    WHERE m.name IN ('contacts', 'project_officers', 'advertisers', 'real_estate_offices')
      AND f->>'type' = 'phone'
  )
  SELECT f.name
  FROM fields f
  JOIN public.records r ON r.model_id = f.model_id   -- all four are unfrozen (unified_records also unions 300k archived listings: 3–9 s)
  CROSS JOIN want w
  WHERE w.c IS NOT NULL
    AND COALESCE(r.data->>f.slug, '') <> ''
    AND COALESCE(public.ksa_phone_canon(r.data->>f.slug), regexp_replace(r.data->>f.slug, '\D', '', 'g')) = w.c
  LIMIT 1
$function$;

REVOKE ALL ON FUNCTION public.wa_phone_known_party(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_phone_known_party(text) TO service_role;
