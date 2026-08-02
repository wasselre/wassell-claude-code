-- ════════════════════════════════════════════════════════════════════════════
-- W5 (bilingual): fix a folding typo in wassell_search_norm.
--
-- The W1 definition's translate() target string had a SPACE where the fold for
-- آ (alef-madda, U+0622) should have been — so آ was normalized to a space
-- instead of to bare alef ا, splitting any token containing it (e.g. "مكافآت"
-- → "مكاف ات") in both the stored search text and the query. The intent (shared
-- by every other hamza form) is آ → ا. The client-side foldArabic() folds it
-- correctly; this brings the SQL into EXACT parity so client and server search
-- normalize identically.
--
-- Because the trigram GIN indexes are EXPRESSION indexes over
-- wassell_search_norm(...), their stored trigrams were computed with the old
-- (buggy) definition — REPLACE alone would leave the index disagreeing with the
-- function. The affected indexes are REINDEXed in the same transaction so every
-- entry is recomputed with the corrected fold. (Plain REINDEX INDEX is
-- transactional and sub-second at current row counts.)
-- ════════════════════════════════════════════════════════════════════════════

-- Corrected: source أإآةى٠…٩ (15 chars) → target اااهي0…9 (15 chars), i.e.
-- أ→ا, إ→ا, آ→ا, ة→ه, ى→ي, digits→ascii. The W1 bug was a stray SPACE at the
-- آ position, which shifted nothing else (translate is positional and the space
-- WAS the آ slot) but folded آ→space. No space now — three alefs, then ه ي.
CREATE OR REPLACE FUNCTION public.wassell_search_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(translate(regexp_replace(COALESCE(t,''),'[ـ]','','g'),
    'أإآةى٠١٢٣٤٥٦٧٨٩', 'اااهي0123456789'));
$$;

-- Rebuild every expression index that folds through this function so stored
-- trigrams match the corrected normalization. Guarded so the migration is safe
-- even if an index name is absent (fresh CI DB builds them in mig 02/04).
DO $$
DECLARE ix text;
BEGIN
  FOREACH ix IN ARRAY ARRAY['sd_src_trgm','sd_ar_trgm','sd_en_trgm','tv_display_trgm']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relkind='i' AND relname=ix) THEN
      EXECUTE format('REINDEX INDEX public.%I', ix);
    END IF;
  END LOOP;
END $$;
