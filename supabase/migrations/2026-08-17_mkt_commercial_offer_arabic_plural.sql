-- ============================================================================
-- `خصم` does not match its own plural `خصومات` (2026-08-17).
--
-- The infixed و breaks the literal, so the discount keyword silently failed on
-- every plural form. Measured on live enrichment output: 4 of 19 distinct real
-- offers were dropped by this alone —
--   "خصومات حصرية خلال معرض سيتي سكيب العالمي"
--   "خصومات حصرية لمنسوبي الاتصالات السعودية"
--   "خصومات حصرية وعروض محدودة للتملك خلال فترة المعرض"
--   "عروض وخصومات خاصة لموظفي stc"
--
-- mkt_is_commercial_offer gates `new_offer_detected`, so the effect was a FALSE
-- NEGATIVE in the alert path: a genuine competitor discount campaign filtered
-- out before it could ever fire. That is the mirror of the false-POSITIVE
-- problem fixed on 2026-08-11, and the more dangerous direction — a noisy alert
-- gets complained about, a missing one just looks like quiet.
--
-- Widened to the shared stem `خصوم` ONLY. Deliberately NOT adding bare `عروض`,
-- which is generic marketing language and would re-open the false-positive door
-- that cost 288 bad values last time.
--
-- Known still-missed, left alone rather than guessed at with a fragile pattern:
--   "دورين بسعر دور واحد" — two floors for the price of one. A real offer with
--   no digit, no percentage and no keyword. Catching it needs semantics, not a
--   regex; the Skill already routes it into `offer`, so only this gate drops it.
--
-- Verified on the live corpus: 9 → 13 of 19 pass, while the sponsorship badge
-- ("Diamond Sponsorship…"), the sales-progress line ("27 وحدة تم بيعها…") and a
-- literal "None" remain rejected.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mkt_is_commercial_offer(p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(
    p_value ~* ('(تقسيط|أقساط|قسط\y|دفعة|مقدم'
             || '|خصم|خصوم|تخفيض|عرض خاص|عرض لفترة|سعر خاص'
             || '|مجان|هدية|كاش ?باك|استرداد|إعفاء|اعفاء|بدون رسوم'
             || '|تمويل|دعم عقاري'
             || '|discount|cashback|free|gift|installment|instalment|waiv|bonus|promo)')
    OR (p_value ~ '[0-9]' AND p_value ~* '(%|ريال|ر\.س|SAR|halala|هللة)'),
    false);
$$;

-- Regression: the plural must pass, generic marketing must not.
DO $$
BEGIN
  IF NOT public.mkt_is_commercial_offer('خصومات حصرية خلال معرض سيتي سكيب العالمي') THEN
    RAISE EXCEPTION 'FAILED: plural خصومات still rejected — real discount campaigns will not alert';
  END IF;
  IF NOT public.mkt_is_commercial_offer('عروض وخصومات خاصة لموظفي stc') THEN
    RAISE EXCEPTION 'FAILED: عروض وخصومات rejected';
  END IF;
  IF public.mkt_is_commercial_offer('Diamond Sponsorship presence at Cityscape Global') THEN
    RAISE EXCEPTION 'FAILED: sponsorship badge accepted as an offer (the 2026-08-11 regression)';
  END IF;
  IF public.mkt_is_commercial_offer('تملك الفخامة') THEN
    RAISE EXCEPTION 'FAILED: slogan accepted as an offer';
  END IF;
  RAISE NOTICE 'PASS: Arabic plural discounts detected, slogans and badges still rejected';
END $$;
