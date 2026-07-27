-- Internal Marketing Management (إدارة التسويق)
-- Applied to production as Supabase migration 20260727092512 — "mkt_mgmt_automation".
-- Exported verbatim from schema_migrations so repo and database cannot drift.

-- ── Task templates: creating content generates its production checklist ────
CREATE OR REPLACE FUNCTION public.mkt_generate_content_tasks(p_content_item_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_item public.mkt_content_items%ROWTYPE;
  v_steps text[][]; v_prev uuid; v_id uuid; v_n int := 0; i int;
  v_type text; v_title_ar text;
BEGIN
  SELECT * INTO v_item FROM public.mkt_content_items WHERE id=p_content_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'content item % not found', p_content_item_id; END IF;
  IF EXISTS (SELECT 1 FROM public.mkt_content_tasks WHERE content_item_id=p_content_item_id) THEN
    RETURN 0;   -- idempotent: never duplicate a checklist
  END IF;

  IF v_item.content_type IN ('carousel','static_image','infographic','paid_image_ad') THEN
    v_steps := ARRAY[
      ARRAY['write_brief','كتابة الموجز'], ARRAY['write_copy','كتابة نص الشرائح'],
      ARRAY['approve_script','اعتماد النص'], ARRAY['design_slides','تصميم الشرائح'],
      ARRAY['review_design','مراجعة التصميم'], ARRAY['revisions','تنفيذ التعديلات'],
      ARRAY['approve_final','الاعتماد النهائي'], ARRAY['schedule_publication','جدولة النشر'],
      ARRAY['record_performance','تسجيل الأداء']];
  ELSE
    v_steps := ARRAY[
      ARRAY['write_brief','كتابة الموجز'], ARRAY['write_script','كتابة السيناريو'],
      ARRAY['approve_script','اعتماد السيناريو'], ARRAY['prepare_assets','تجهيز المواد الخام'],
      ARRAY['record','التصوير'], ARRAY['edit_video','مونتاج الفيديو'],
      ARRAY['review_video','مراجعة الفيديو'], ARRAY['revisions','تنفيذ التعديلات'],
      ARRAY['write_caption','كتابة التعليق'], ARRAY['approve_final','الاعتماد النهائي'],
      ARRAY['schedule_publication','جدولة النشر'], ARRAY['record_performance','تسجيل الأداء']];
  END IF;

  FOR i IN 1 .. array_length(v_steps,1) LOOP
    v_type := v_steps[i][1]; v_title_ar := v_steps[i][2];
    INSERT INTO public.mkt_content_tasks
      (title, task_type, content_item_id, campaign_id, project_id, due_date,
       depends_on_task_id, sort_order, created_by_user_id,
       status, blocked_reason)
    VALUES (v_title_ar, v_type, p_content_item_id, v_item.campaign_id, v_item.project_id,
            v_item.due_date, v_prev, i, v_item.created_by_user_id,
            CASE WHEN v_prev IS NULL THEN 'not_started' ELSE 'blocked' END,
            CASE WHEN v_prev IS NULL THEN NULL ELSE 'في انتظار إنهاء المهمة السابقة' END)
    RETURNING id INTO v_id;
    v_prev := v_id; v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;
GRANT EXECUTE ON FUNCTION public.mkt_generate_content_tasks(uuid) TO authenticated, service_role;

-- Dependencies actually gate work: completing a task unblocks its dependents.
CREATE OR REPLACE FUNCTION public.mkt_tg_task_unblock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
    UPDATE public.mkt_content_tasks
       SET status='not_started', blocked_reason=NULL
     WHERE depends_on_task_id = NEW.id AND status='blocked';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mkt_task_unblock_tg ON public.mkt_content_tasks;
CREATE TRIGGER mkt_task_unblock_tg
  BEFORE UPDATE ON public.mkt_content_tasks
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_task_unblock();

-- A task whose dependency is unfinished cannot be started.
CREATE OR REPLACE FUNCTION public.mkt_tg_task_dependency_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_dep text;
BEGIN
  IF NEW.status IN ('in_progress','completed','waiting_review')
     AND NEW.depends_on_task_id IS NOT NULL THEN
    SELECT status INTO v_dep FROM public.mkt_content_tasks WHERE id=NEW.depends_on_task_id;
    IF v_dep IS DISTINCT FROM 'completed' AND v_dep IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'task "%" is blocked by an unfinished dependency (dependency status: %)',
        NEW.title, COALESCE(v_dep,'missing') USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mkt_task_dep_gate_tg ON public.mkt_content_tasks;
CREATE TRIGGER mkt_task_dep_gate_tg
  BEFORE UPDATE ON public.mkt_content_tasks
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_task_dependency_gate();

-- ── Deterministic operational alerts; every one links to a real record ─────
CREATE OR REPLACE FUNCTION public.mkt_mgmt_generate_alerts()
RETURNS TABLE(kind text, emitted integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n int;
BEGIN
  -- 1. missed content deadline
  WITH x AS (
    INSERT INTO public.mkt_mgmt_alerts(kind,severity,title_ar,title_en,body_ar,body_en,target_type,target_id,evidence,dedup_key)
    SELECT 'content_overdue','warning',
           'محتوى متأخر: '||i.title, 'Overdue content: '||i.title,
           'تاريخ الاستحقاق '||i.due_date::text, 'Due '||i.due_date::text,
           'content_item', i.id,
           jsonb_build_object('rule','content_overdue','due_date',i.due_date,'status',i.status),
           'content_overdue:'||i.id::text||':'||i.due_date::text
    FROM public.mkt_content_items i
    WHERE i.archived_at IS NULL AND i.due_date < current_date
      AND i.status NOT IN ('published','cancelled','archived')
    ON CONFLICT (dedup_key) DO NOTHING RETURNING 1)
  SELECT count(*) INTO n FROM x; kind:='content_overdue'; emitted:=n; RETURN NEXT;

  -- 2. campaign with no content
  WITH x AS (
    INSERT INTO public.mkt_mgmt_alerts(kind,severity,title_ar,title_en,target_type,target_id,evidence,dedup_key)
    SELECT 'campaign_without_content','warning',
           'حملة بلا محتوى: '||c.name_ar, 'Campaign has no content: '||COALESCE(c.name_en,c.name_ar),
           'campaign', c.id, jsonb_build_object('rule','campaign_without_content','status',c.status),
           'campaign_without_content:'||c.id::text
    FROM public.mkt_internal_campaigns c
    WHERE c.status IN ('planned','active') AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.mkt_content_items i WHERE i.campaign_id=c.id AND i.archived_at IS NULL)
    ON CONFLICT (dedup_key) DO NOTHING RETURNING 1)
  SELECT count(*) INTO n FROM x; kind:='campaign_without_content'; emitted:=n; RETURN NEXT;

  -- 3. scheduled publication with no APPROVED final asset
  WITH x AS (
    INSERT INTO public.mkt_mgmt_alerts(kind,severity,title_ar,title_en,target_type,target_id,evidence,dedup_key)
    SELECT 'scheduled_without_approved_asset','critical',
           'نشر مجدول بلا نسخة معتمدة', 'Scheduled publication has no approved version',
           'publication', p.id,
           jsonb_build_object('rule','scheduled_without_approved_asset','platform',p.platform,'scheduled_for',p.scheduled_for),
           'sched_no_approved:'||p.id::text
    FROM public.mkt_publications p
    WHERE p.status IN ('scheduled','ready')
      AND NOT EXISTS (SELECT 1 FROM public.mkt_content_versions v
                       WHERE v.content_item_id=p.content_item_id
                         AND v.approval_state='approved' AND v.version_type IN ('final','published'))
    ON CONFLICT (dedup_key) DO NOTHING RETURNING 1)
  SELECT count(*) INTO n FROM x; kind:='scheduled_without_approved_asset'; emitted:=n; RETURN NEXT;

  -- 4. waiting too long for approval (>3 days)
  WITH x AS (
    INSERT INTO public.mkt_mgmt_alerts(kind,severity,title_ar,title_en,target_type,target_id,evidence,dedup_key)
    SELECT 'approval_stalled','warning',
           'موافقة متعثرة منذ '||round(EXTRACT(EPOCH FROM (now()-a.created_at))/86400)||' أيام',
           'Approval pending '||round(EXTRACT(EPOCH FROM (now()-a.created_at))/86400)||' days',
           'content_item', a.target_id,
           jsonb_build_object('rule','approval_stalled','stage',a.stage,'threshold_days',3,'created_at',a.created_at),
           'approval_stalled:'||a.id::text
    FROM public.mkt_approvals a
    WHERE a.decision='pending' AND a.created_at < now() - interval '3 days' AND a.target_type='content_item'
    ON CONFLICT (dedup_key) DO NOTHING RETURNING 1)
  SELECT count(*) INTO n FROM x; kind:='approval_stalled'; emitted:=n; RETURN NEXT;

  -- 5. content item with no owner
  WITH x AS (
    INSERT INTO public.mkt_mgmt_alerts(kind,severity,title_ar,title_en,target_type,target_id,evidence,dedup_key)
    SELECT 'content_without_owner','info',
           'محتوى بلا مسؤول: '||i.title, 'Content has no owner: '||i.title,
           'content_item', i.id, jsonb_build_object('rule','content_without_owner'),
           'content_no_owner:'||i.id::text
    FROM public.mkt_content_items i
    WHERE i.owner_user_id IS NULL AND i.archived_at IS NULL AND i.status NOT IN ('cancelled','archived')
    ON CONFLICT (dedup_key) DO NOTHING RETURNING 1)
  SELECT count(*) INTO n FROM x; kind:='content_without_owner'; emitted:=n; RETURN NEXT;

  -- 6. published content with no performance snapshot after 3 days
  WITH x AS (
    INSERT INTO public.mkt_mgmt_alerts(kind,severity,title_ar,title_en,target_type,target_id,evidence,dedup_key)
    SELECT 'published_without_performance','warning',
           'منشور بلا بيانات أداء', 'Published content missing performance data',
           'publication', p.id,
           jsonb_build_object('rule','published_without_performance','published_at',p.published_at,'threshold_days',3),
           'pub_no_perf:'||p.id::text
    FROM public.mkt_publications p
    WHERE p.status='published' AND p.published_at < now() - interval '3 days'
      AND NOT EXISTS (SELECT 1 FROM public.mkt_performance_snapshots s WHERE s.publication_id=p.id)
    ON CONFLICT (dedup_key) DO NOTHING RETURNING 1)
  SELECT count(*) INTO n FROM x; kind:='published_without_performance'; emitted:=n; RETURN NEXT;

  -- 7. campaign nearing end date with low completion
  WITH x AS (
    INSERT INTO public.mkt_mgmt_alerts(kind,severity,title_ar,title_en,target_type,target_id,evidence,dedup_key)
    SELECT 'campaign_at_risk','critical',
           'حملة معرّضة للخطر: '||c.name_ar, 'Campaign at risk: '||COALESCE(c.name_en,c.name_ar),
           'campaign', c.id,
           jsonb_build_object('rule','campaign_at_risk','end_date',c.end_date,
             'published', (SELECT count(*) FROM public.mkt_content_items i WHERE i.campaign_id=c.id AND i.status='published'),
             'total', (SELECT count(*) FROM public.mkt_content_items i WHERE i.campaign_id=c.id)),
           'campaign_at_risk:'||c.id::text||':'||c.end_date::text
    FROM public.mkt_internal_campaigns c
    WHERE c.status='active' AND c.end_date IS NOT NULL
      AND c.end_date BETWEEN current_date AND current_date + 7
      AND (SELECT count(*) FROM public.mkt_content_items i WHERE i.campaign_id=c.id AND i.status='published')
          < (SELECT count(*) FROM public.mkt_content_items i WHERE i.campaign_id=c.id) * 0.5
      AND EXISTS (SELECT 1 FROM public.mkt_content_items i WHERE i.campaign_id=c.id)
    ON CONFLICT (dedup_key) DO NOTHING RETURNING 1)
  SELECT count(*) INTO n FROM x; kind:='campaign_at_risk'; emitted:=n; RETURN NEXT;

  -- resolve alerts whose cause has cleared
  UPDATE public.mkt_mgmt_alerts a SET resolved_at=now()
  WHERE a.resolved_at IS NULL AND (
    (a.kind='content_overdue' AND EXISTS (SELECT 1 FROM public.mkt_content_items i
        WHERE i.id=a.target_id AND (i.status IN ('published','cancelled','archived') OR i.due_date >= current_date)))
    OR (a.kind='campaign_without_content' AND EXISTS (SELECT 1 FROM public.mkt_content_items i WHERE i.campaign_id=a.target_id))
    OR (a.kind='content_without_owner' AND EXISTS (SELECT 1 FROM public.mkt_content_items i WHERE i.id=a.target_id AND i.owner_user_id IS NOT NULL))
    OR (a.kind='published_without_performance' AND EXISTS (SELECT 1 FROM public.mkt_performance_snapshots s WHERE s.publication_id=a.target_id))
  );
  RETURN;
END $$;
GRANT EXECUTE ON FUNCTION public.mkt_mgmt_generate_alerts() TO authenticated, service_role;;
