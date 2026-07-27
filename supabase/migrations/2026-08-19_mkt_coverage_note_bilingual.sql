-- ============================================================================
-- Bilingual coverage caveat (2026-08-19).
--
-- The coverage note was an English-only string built inside the RPC, so it
-- bypassed the UI's bilingual handling entirely and stayed English on an
-- otherwise fully-translated Arabic page. BOTH pages had it — Marketing
-- Management and Marketing Intelligence — because the same mistake was written
-- twice. Found by reading the live Arabic page, not by typecheck: an English
-- string is perfectly well-typed.
--
-- The caveat travels WITH the data on purpose rather than moving into the UI:
-- it is the denominator for every number beside it, and an export or PDF
-- consuming the RPC needs it too.
--
-- `note` keeps its existing English value so nothing reading it breaks; the UI
-- picks note_ar when the language is Arabic and falls back to note otherwise.
-- Patches the deployed bodies via pg_get_functiondef rather than re-typing two
-- large functions to change one key — and refuses to patch if either function's
-- shape has moved.
-- ============================================================================
DO $mig$
DECLARE
  v_def text;
  v_ar_mgmt  constant text :=
    'أرقام الإسناد تحتسب ما هو مسجَّل فقط. غياب الرقم يعني أنه غير مسجَّل، وليس أنه صفر.';
  v_ar_intel constant text :=
    'أعداد منشورات المشاريع تحتسب الإسناد المؤكد فقط. المرشّحة تُعرض منفصلة ولا تُخلط أبداً. '
    || 'المنشورات بانتظار الإسناد لها حقائق مستخرجة بالفعل (الوسائط وقراءة الصور واستخراج الحقائق مكتملة) '
    || 'لكن دون قرار مشروع بعد. المنشورات بلا قراءة صور تساهم بنص التعليق والتفريغ فقط.';
BEGIN
  -- ── mkt_mgmt_overview ────────────────────────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='mkt_mgmt_overview';
  IF v_def IS NULL THEN RAISE EXCEPTION 'mkt_mgmt_overview not found'; END IF;

  IF position('note_ar' IN v_def) > 0 THEN
    RAISE NOTICE 'mkt_mgmt_overview already bilingual — skipping';
  ELSIF position($m$'note', 'Attribution figures$m$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'mkt_mgmt_overview coverage note not found in the shape expected — refusing to patch blindly';
  ELSE
    EXECUTE replace(v_def,
      $m$'note', 'Attribution figures$m$,
      format($m$'note_ar', %L, 'note', 'Attribution figures$m$, v_ar_mgmt));
    RAISE NOTICE 'mkt_mgmt_overview: note_ar added';
  END IF;

  -- ── mkt_intelligence_index ───────────────────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='mkt_intelligence_index';
  IF v_def IS NULL THEN RAISE EXCEPTION 'mkt_intelligence_index not found'; END IF;

  IF position('note_ar' IN v_def) > 0 THEN
    RAISE NOTICE 'mkt_intelligence_index already bilingual — skipping';
  ELSIF position($m$'note', 'Project post counts$m$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'mkt_intelligence_index coverage note not found in the shape expected — refusing to patch blindly';
  ELSE
    EXECUTE replace(v_def,
      $m$'note', 'Project post counts$m$,
      format($m$'note_ar', %L, 'note', 'Project post counts$m$, v_ar_intel));
    RAISE NOTICE 'mkt_intelligence_index: note_ar added';
  END IF;
END $mig$;

-- Verification (both keys must be present, English must survive):
--   SELECT mkt_mgmt_overview(1)->'coverage'->>'note_ar' IS NOT NULL
--      AND mkt_mgmt_overview(1)->'coverage'->>'note'    IS NOT NULL
--      AND mkt_intelligence_index(1)->'coverage'->>'note_ar' IS NOT NULL
--      AND mkt_intelligence_index(1)->'coverage'->>'note'    IS NOT NULL;
