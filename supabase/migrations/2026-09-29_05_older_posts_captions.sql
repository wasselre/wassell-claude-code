-- 2026-09-29 — The eight ربوة الرمز posts get real captions, approved by the operator.
--
-- Operator decision (2026-09-29, superseding option "A" in _04): write actual
-- captions and approve them — the writer does nothing and does not approve.
-- So the captions below were written by Claude on the operator's instruction,
-- from the live all_projects record (checked the same day: 66 units / 44
-- available — 29 villas + 15 floors; available price from 899,000 SAR; available
-- area 162–458.81 m²; villas 4–5 bedrooms over 3 floors with an internal lift;
-- off-plan, handover 2028-08-01; payment plan 5 / 80 / 15; developer warranties),
-- following the writing-post skill's hard rules (facts only, «على الخارطة» +
-- handover date, only وصل named, our hashtags, Arabic-Indic numerals).
--
-- They are recorded as APPROVED BY THE OPERATOR (ريان أبانمي, admin) through the
-- normal engine — writing → writing_review → final design_review — so the final
-- approval row binds each caption's hash exactly as a manager's approval would,
-- and the publish gate checks it the same way. `_04`'s skip-list skips the two
-- design steps (the designs were approved 9–13 Sep and do not change).
--
-- P-157 carried an unconfirmed AI draft that the writing page generated on open
-- (09:12 UTC). It is replaced: it called 44 the project's total units (44 is the
-- AVAILABLE count; the total is 66) and turned the largest villa's area (458.81
-- m²) into "community space". Provenance of every caption is logged as a
-- `caption_written` content event; `caption_source` is cleared because the app
-- renders 'ai' as «مسودة — راجعها», which an approved caption is not.
--
-- `mos.in_refill = '1'` for the duration: the two review steps open and close
-- inside this transaction, so they must not be handed to anyone — an assignment
-- sends a «فُتحت لك مهمة» notification for a task that is already closed.
-- No Meta ad is created: the engine adds one only when a target is passed.
--
-- Guarded: replays as a no-op where the posts or their caption tasks are absent.
BEGIN;

DO $run$
DECLARE
  v_operator_auth constant uuid := '31621e58-c723-45ad-9e4f-6f8ba1689fe7';  -- ريان أبانمي (auth uid)
  v_operator_user uuid;
  r        record;
  v_id     uuid;
  v_res    jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.mos_content WHERE ref = 'P-150') THEN
    RETURN;
  END IF;
  v_operator_user := public.wassell_app_user_id(v_operator_auth);

  PERFORM set_config('mos.in_refill', '1', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_operator_auth, 'role', 'authenticated')::text, true);

  FOR r IN
    SELECT * FROM (VALUES
('P-150', $c$ربوة الرمز.. الأرقام تحكي عن بيتك القادم ✨

📍 حي الربوة، وسط شرق الرياض
🏡 فلل وأدوار سكنية بمساحات من ١٦٢ إلى ٤٥٨٫٨١ م²
💰 الأسعار تبدأ من ٨٩٩٬٠٠٠ ر.س
🔑 ٤٤ وحدة متاحة حاليًا
🗓 بيع على الخارطة، والتسليم ١ أغسطس ٢٠٢٨

📞 أرسل لنا رسالة الآن وسجّل اهتمامك مع وصل العقارية.

#ربوة_الرمز #وصل_العقارية #حي_الربوة #عقارات_الرياض$c$),

('P-151', $c$فلل ربوة الرمز.. فخامة في التصميم وذكاء في التفاصيل ✨

▫️ ٣ أدوار يخدمها مصعد داخلي
▫️ ٤ و٥ غرف نوم تناسب العائلة
▫️ بيت ذكي ومكنسة مركزية
▫️ كاميرات مراقبة وأنظمة أمان

📍 حي الربوة، وسط شرق الرياض
🗓 بيع على الخارطة، والتسليم ١ أغسطس ٢٠٢٨

📞 أرسل لنا رسالة وتعرّف على الفلل المتاحة وأسعارها.

#ربوة_الرمز #وصل_العقارية #فلل_الرياض #حي_الربوة$c$),

('P-152', $c$بيتك الذكي في حي الربوة يبدأ من هنا ✨

في ربوة الرمز تختار بين الفلل والأدوار السكنية، بتقنيات البيت الذكي وبأسعار تبدأ من ٨٩٩٬٠٠٠ ر.س.

▫️ بيع على الخارطة، والتسليم ١ أغسطس ٢٠٢٨
▫️ دفعة أولى تبدأ من ٥٪
▫️ ٤٤ وحدة متاحة حاليًا

📞 تواصل معنا اليوم ونساعدك في اختيار وحدتك وتأكيد حجزك.

#ربوة_الرمز #وصل_العقارية #حي_الربوة #عقارات_الرياض$c$),

('P-153', $c$موقع يختصر عليك مشاويرك في الرياض 📍

ربوة الرمز في حي الربوة، وسط شرق الرياض:
▫️ على طريق الدائري الشرقي مباشرة
▫️ محاذٍ لطريق عمر بن الخطاب
▫️ دقائق من طريق النهضة وطريق المدينة المنورة

فلل وأدوار سكنية تُباع على الخارطة، والتسليم ١ أغسطس ٢٠٢٨.

📞 أرسل لنا رسالة ونشاركك الموقع وتفاصيل الوحدات المتاحة.

#ربوة_الرمز #وصل_العقارية #حي_الربوة #عقارات_الرياض$c$),

('P-154', $c$التملك على الخارطة.. خطوة مبكرة بسعر الطرح الحالي ✨

في ربوة الرمز:
▫️ الأسعار تبدأ من ٨٩٩٬٠٠٠ ر.س
▫️ من خطط الدفع: ٥٪ مقدم، و٨٠٪ أثناء الإنشاء، و١٥٪ عند التسليم
▫️ التسليم ١ أغسطس ٢٠٢٨
▫️ فلل بمصاعد داخلية وتجهيزات البيت الذكي

📍 حي الربوة، وسط شرق الرياض

📞 تواصل معنا لاستشارة مباشرة تساعدك في اختيار الوحدة وخطة الدفع المناسبة.

#ربوة_الرمز #وصل_العقارية #استثمار_عقاري #حي_الربوة$c$),

('P-155', $c$ربوة الرمز.. مساحة تكبر مع عائلتك ✨

▫️ ٤٤ وحدة متاحة للبيع على الخارطة
▫️ فلل من ٣ أدوار بـ٤ و٥ غرف نوم
▫️ مصعد داخلي يخدم جميع الأدوار
▫️ بيت ذكي ومكنسة مركزية وكاميرات أمان

🗓 التسليم ١ أغسطس ٢٠٢٨
📍 حي الربوة، وسط شرق الرياض

📞 أرسل لنا رسالة اليوم وتعرّف على خيارات التملك المتاحة.

#ربوة_الرمز #وصل_العقارية #فلل_الرياض #حي_الربوة$c$),

('P-156', $c$حياة هادئة في مجتمع سكني متكامل ✨

مشروع ربوة الرمز يجمع بين قيمة السكن وفرصة الاستثمار:
▫️ فلل وأدوار بأسعار تبدأ من ٨٩٩٬٠٠٠ ر.س
▫️ حدائق وممرات خضراء داخل المشروع
▫️ كاميرات مراقبة وأنظمة أمان
▫️ بيع على الخارطة، والتسليم ١ أغسطس ٢٠٢٨

📍 حي الربوة، وسط شرق الرياض

📞 احجز موعدك الاستشاري مع وصل العقارية الآن.

#ربوة_الرمز #وصل_العقارية #حي_الربوة #عقارات_الرياض$c$),

('P-157', $c$جودة تطمّنك اليوم وبعد الاستلام ✨

في ربوة الرمز، ضمانات المطوّر تشمل:
▫️ ١٠ سنوات على الهيكل الإنشائي
▫️ ١٠ سنوات على العزل المائي والحراري
▫️ ٥ سنوات على التمديدات الكهربائية والسباكة
▫️ سنتان على المصاعد

🗓 بيع على الخارطة، والتسليم ١ أغسطس ٢٠٢٨
📍 حي الربوة، وسط شرق الرياض

📞 تواصل معنا واستكشف الوحدات المتاحة.

#ربوة_الرمز #وصل_العقارية #حي_الربوة #عقارات_الرياض$c$)
    ) AS v(ref, caption)
    ORDER BY ref
  LOOP
    SELECT c.id INTO v_id FROM public.mos_content c WHERE c.ref = r.ref;
    -- Only a post still waiting on its caption step; anything else is left alone.
    IF v_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.workflow_role_tasks t
          WHERE t.subject_table = 'mos_content' AND t.subject_id = v_id
            AND t.status = 'open' AND t.step_key = 'writing') THEN
      CONTINUE;
    END IF;

    INSERT INTO public.mos_content_events (content_id, kind, actor_user_id, detail)
    SELECT v_id, 'caption_written', v_operator_user,
           jsonb_build_object(
             'written_by', 'claude', 'instructed_by', 'operator', 'approved_by', 'operator',
             'why', 'operator 2026-09-29: write real captions and approve them; the writer does nothing',
             'replaced_draft', NULLIF(c.data ->> 'caption', ''),
             'migration', '2026-09-29_05_older_posts_captions')
      FROM public.mos_content c WHERE c.id = v_id;

    UPDATE public.mos_content
       SET data = (data - 'caption_source')
                  || jsonb_build_object('caption', r.caption,
                                        'caption_confirmed_text', r.caption,
                                        'caption_confirmed_at', now())
     WHERE id = v_id;

    v_res := public.workflow_advance_role_path('mos_content', v_id, 'submitted');   -- the caption step
    v_res := public.workflow_advance_role_path('mos_content', v_id, 'approved');    -- caption approved
    IF v_res ->> 'next_step_key' IS DISTINCT FROM 'design_review' THEN
      RAISE EXCEPTION 'OLDER_CAPTIONS: % expected the final approval next, got %', r.ref, v_res ->> 'next_step_key';
    END IF;
    v_res := public.workflow_advance_role_path('mos_content', v_id, 'approved');    -- final approval
    IF NOT COALESCE((v_res ->> 'done')::boolean, false) THEN
      RAISE EXCEPTION 'OLDER_CAPTIONS: % did not finish after the final approval: %', r.ref, v_res;
    END IF;
  END LOOP;

  PERFORM set_config('mos.in_refill', '0', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $run$;

-- ── assertions (guarded: only when these posts exist) ─────────────────────────
DO $assert$
DECLARE v_bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.mos_content WHERE ref = 'P-150') THEN
    RETURN;
  END IF;
  SELECT string_agg(c.ref, ', ' ORDER BY c.ref) INTO v_bad
    FROM public.mos_content c
   WHERE c.ref IN ('P-150','P-151','P-152','P-153','P-154','P-155','P-156','P-157')
     AND (
          EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                   WHERE t.subject_table = 'mos_content' AND t.subject_id = c.id AND t.status = 'open')
       OR COALESCE(btrim(c.data ->> 'caption'), '') = ''
       OR (c.data ? 'revision' AND (c.data -> 'revision' ->> 'closed_at') IS NULL)
       OR NOT EXISTS (
            SELECT 1 FROM (
              SELECT a.design_hash, a.caption_hash FROM public.mos_content_approvals a
               WHERE a.content_id = c.id AND a.step_key = 'design_review'
               ORDER BY a.approved_at DESC LIMIT 1) last
             WHERE last.design_hash = public.mos_content_design_hash(c.id)
               AND last.caption_hash = public.mos_caption_hash(c.data ->> 'caption')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'OLDER_CAPTIONS: not approved with their caption: %', v_bad;
  END IF;
END $assert$;

COMMIT;
