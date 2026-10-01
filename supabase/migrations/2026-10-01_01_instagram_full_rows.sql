-- 2026-10-01 — The Instagram grid only grows by whole rows of three.
--
-- WHAT HAPPENED (29–30 Sep). The profile grid is three tiles wide and the month
-- plan designs organic posts as rows of three. The publisher knew nothing about
-- rows and handed releases to bundle.social one at a time. The eight older
-- ربوة الرمز posts belonged to no row and went out as 1 (29 Sep) + 7 (30 Sep);
-- the one was later taken off Instagram, leaving seven: two rows plus one. That
-- one extra tile shifted everything below it, splitting both يمام rows.
--
-- THE RULE NOW (operator, 2026-10-01: "we only post full rows on Instagram").
-- It lives in the publisher (api/_lib/marketing/instagramGrid.ts +
-- publishRelease.ts): an Instagram feed post goes out only with its whole row —
-- all three handed off together, or none — and a post that belongs to no row
-- never reaches the grid. A post held for its row records the new hold reason
-- 'row_incomplete'. This file only teaches the database that reason:
--
--   • mos_release_hold_text / mos_release_hold_label — its Arabic wording on the
--     month page's «يحتاج قرارك».
--   • mos_release_open_task — it is a REFUSAL, not a failed handoff: nothing was
--     uploaded and it clears itself when the row is ready, so a 'publish_failed'
--     re-report of it is never counted (same list as the other refusals).
--
-- All three are re-emitted verbatim from the live definitions with only those
-- lines added. No view is replaced. Nothing here raises SQLSTATE 40001/40P01.
BEGIN;

CREATE OR REPLACE FUNCTION public.mos_release_hold_text(p_reason text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_reason
    WHEN 'auto_publish_off'         THEN 'النشر الآلي متوقف من الإعدادات، فلم يُرسل هذا المنشور.'
    WHEN 'not_approved'             THEN 'لم يُعتمد التصميم النهائي بعد — لا يُنشر شيء قبل الاعتماد.'
    WHEN 'in_production'            THEN 'المحتوى ما زال قيد العمل — يُنشر بعد اعتماده النهائي.'
    WHEN 'stale'                    THEN 'فات موعده بأكثر من يوم فلم يُنشر آليًا.'
    WHEN 'material_unresolved'      THEN 'ينقص التصميم المطلوب لهذه الوجهة.'
    WHEN 'approval_mismatch'        THEN 'تغيّر التصميم أو الكابشن بعد الاعتماد — لن يُنشر شيء غير معتمد.'
    WHEN 'preflight_blocked'        THEN 'لا يستوفي شروط المنصة.'
    WHEN 'row_incomplete'           THEN 'منشورات الفيد في إنستقرام تُنشر صفًا كاملًا من ثلاثة — ينتظر بقية الصف.'
    WHEN 'publish_failed'           THEN 'فشل إرساله إلى المنصة.'
    WHEN 'account_not_connected'    THEN 'الحساب غير موصول أو لا يملك صلاحية النشر.'
    WHEN 'platform_not_automatable' THEN 'هذه المنصة بلا ربط نشر آلي.'
    WHEN 'manual_by_policy'         THEN 'النشر على هذه المنصة يدوي بقرار التشغيل.'
    ELSE 'توقّف قبل النشر وينتظر قرارك.'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.mos_release_hold_label(p_reason text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE p_reason
    WHEN 'auto_publish_off'         THEN 'لم يُنشر: النشر الآلي متوقف'
    WHEN 'not_approved'             THEN 'حان موعده ولم يُعتمد'
    WHEN 'in_production'            THEN 'حان موعده وما زال قيد العمل'
    WHEN 'stale'                    THEN 'فات موعده ولم يُنشر'
    WHEN 'material_unresolved'      THEN 'ينقصه التصميم'
    WHEN 'approval_mismatch'        THEN 'تغيّر بعد الاعتماد'
    WHEN 'preflight_blocked'        THEN 'لا يستوفي شروط المنصة'
    WHEN 'row_incomplete'           THEN 'ينتظر اكتمال الصف'
    WHEN 'publish_failed'           THEN 'فشل النشر'
    WHEN 'account_not_connected'    THEN 'يحتاج نشرًا يدويًا'
    WHEN 'platform_not_automatable' THEN 'يحتاج نشرًا يدويًا'
    WHEN 'manual_by_policy'         THEN 'يحتاج نشرًا يدويًا'
    ELSE 'متوقف بانتظار قرارك'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.mos_release_open_task(p_publication_id uuid, p_reason text, p_detail text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rel      record;
  v_existing uuid;
  v_owner    uuid;
  v_role     text := COALESCE(public.mos_planning_cfg() ->> 'release_owner_role', 'mos_writer');
  v_id       uuid;
  v_title    text;
BEGIN
  -- Publishing is not a task (2026-09-27). Off unless the setting says exactly
  -- true: no publish task is opened, by any caller. NULL is the function's own
  -- "nothing to open" answer, which every caller already handles.
  IF COALESCE(public.mos_planning_cfg() ->> 'publish_tasks_enabled', 'false') <> 'true' THEN
    -- Still no task — but never silence (2026-09-29). Until now this RETURNed
    -- and the release sat in 'planned' with nobody told: 12 posts missed their
    -- dates that way. The reason is recorded on the release itself, where the
    -- month page's «يحتاج قرارك» lists it with «انشر الآن / أعد الجدولة / ألغِ».
    -- Written only when it changes, so a 5-minute sweep re-refusing the same
    -- release does not rewrite the row every tick.
    IF p_reason = 'publish_failed' THEN
      -- (2026-09-30) A REFUSAL is not a failed handoff. The material rule has
      -- already recorded why on the release (in production, not approved, …);
      -- the sweep shipped before this date then re-reported the same refusal
      -- as a generic 'publish_failed', which would now be counted and stop the
      -- retries — stranding a post that is merely approved late. A real
      -- handoff failure always carries the platform's own message.
      IF position('bundle.social:' IN COALESCE(p_detail, '')) = 0
         AND EXISTS (SELECT 1 FROM public.mos_publications r
                      WHERE r.id = p_publication_id
                        AND r.hold_reason IN ('in_production', 'not_approved', 'approval_mismatch',
                                              'material_unresolved', 'preflight_blocked',
                                              -- (2026-10-01) waiting for the rest of its Instagram row
                                              'row_incomplete')) THEN
        RETURN NULL;
      END IF;
      -- Every failed handoff is COUNTED, including a repeat of the same error:
      -- the count is what stops the retries (see mos_release_due).
      UPDATE public.mos_publications r
         SET publish_attempts = r.publish_attempts + 1
       WHERE r.id = p_publication_id
         AND r.status NOT IN ('published', 'cancelled')
         AND r.bundle_post_id IS NULL;
    END IF;
    UPDATE public.mos_publications p
       SET hold_reason = p_reason,
           hold_detail = COALESCE(NULLIF(btrim(p_detail), ''), public.mos_release_hold_text(p_reason)),
           hold_at     = now()
     WHERE p.id = p_publication_id
       AND p.status NOT IN ('published', 'cancelled')
       AND p.bundle_post_id IS NULL
       AND (p.hold_reason IS DISTINCT FROM p_reason
            OR p.hold_detail IS DISTINCT FROM
               COALESCE(NULLIF(btrim(p_detail), ''), public.mos_release_hold_text(p_reason)));
    RETURN NULL;
  END IF;

  SELECT * INTO v_rel FROM public.mos_release_v WHERE release_id = p_publication_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:RELEASE_NOT_FOUND %', p_publication_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT id INTO v_existing FROM public.mos_manual_tasks
   WHERE kind = 'publish' AND ref_id = p_publication_id AND status = 'open' LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  IF v_rel.status IN ('published','cancelled') THEN RETURN NULL; END IF;

  -- 1. whoever holds the configured release role, most publishing headroom first
  SELECT u.id INTO v_owner
    FROM public.users u
    JOIN public.roles r
      ON r.key = v_role
     AND r.id::text IN (SELECT e ->> 'role_id'
                          FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
   WHERE u.is_active
   ORDER BY public.mos_user_daily_slots(u.id, 'publishing') DESC, u.id
   LIMIT 1;

  -- 2. the marketing manager, who can always reassign it
  IF v_owner IS NULL THEN
    SELECT u.id INTO v_owner
      FROM public.users u
      JOIN public.roles r
        ON r.key = 'mos_marketing_manager'
       AND r.id::text IN (SELECT e ->> 'role_id'
                            FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
     WHERE u.is_active
     ORDER BY u.id
     LIMIT 1;
  END IF;

  -- 3. anyone who works in marketing at all
  IF v_owner IS NULL THEN
    SELECT u.id INTO v_owner
      FROM public.users u
      JOIN public.roles r
        ON r.key LIKE 'mos\_%' ESCAPE '\'
       AND r.id::text IN (SELECT e ->> 'role_id'
                            FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
     WHERE u.is_active
     ORDER BY u.id
     LIMIT 1;
  END IF;

  -- Nobody at all. Say so in the log instead of returning a quiet NULL that
  -- reads like "nothing to do": this release cannot go out and no one knows.
  IF v_owner IS NULL THEN
    RAISE WARNING 'MOS:RELEASE_UNASSIGNABLE % (%) — no active marketing user to own it', p_publication_id, p_reason;
    RETURN NULL;
  END IF;

  v_title := 'نشر — ' || COALESCE(v_rel.content_title, v_rel.content_ref, '') ||
             ' · ' || v_rel.platform;

  INSERT INTO public.mos_manual_tasks
    (title, details, assignee_user_id, created_by_user_id, campaign_id, content_id, project_id,
     status, due_at, kind, ref_id, entity_kind, entity_id, action)
  VALUES (
    left(v_title, 200),
    COALESCE(p_detail, CASE p_reason
      WHEN 'account_not_connected'    THEN 'الحساب غير موصول أو لا يملك صلاحية النشر — انشر يدويًا ثم ألصق الرابط.'
      WHEN 'platform_not_automatable' THEN 'هذه المنصة بلا ربط نشر — انشر يدويًا ثم ألصق الرابط.'
      WHEN 'manual_by_policy'         THEN 'النشر على هذه المنصة يدوي بقرار التشغيل.'
      WHEN 'preflight_blocked'        THEN 'متطلبات المنصة غير مستوفاة — عالجها ثم انشر.'
      WHEN 'publish_failed'           THEN 'فشل النشر الآلي — راجع السبب ثم أعد المحاولة.'
      ELSE 'يحتاج النشر إلى تدخل يدوي.' END),
    v_owner, v_owner, v_rel.campaign_id, v_rel.content_id, v_rel.project_id,
    'open', v_rel.due_at, 'publish', p_publication_id, 'publication', p_publication_id, p_reason)
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;

DO $assert$
BEGIN
  IF public.mos_release_hold_label('row_incomplete') <> 'ينتظر اكتمال الصف' THEN
    RAISE EXCEPTION 'FULL_ROWS: mos_release_hold_label does not know row_incomplete';
  END IF;
  IF position('row_incomplete' IN public.mos_release_hold_text('row_incomplete')) > 0
     OR public.mos_release_hold_text('row_incomplete') = public.mos_release_hold_text('__unknown__') THEN
    RAISE EXCEPTION 'FULL_ROWS: mos_release_hold_text does not know row_incomplete';
  END IF;
  IF position('''row_incomplete''' IN pg_get_functiondef('public.mos_release_open_task(uuid,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'FULL_ROWS: mos_release_open_task would count a row_incomplete refusal as a failed handoff';
  END IF;
END $assert$;

COMMIT;
