-- Internal Marketing Management (إدارة التسويق)
-- Applied to production as Supabase migration 20260727092551 — "mkt_mgmt_overview_rpc".
-- Exported verbatim from schema_migrations so repo and database cannot drift.

-- One composed read for إدارة التسويق Overview: KPIs + operational queues +
-- alerts, against a consistent snapshot. Every count is a SQL COUNT; anything
-- unmeasurable is reported as null, never as 0.
CREATE OR REPLACE FUNCTION public.mkt_mgmt_overview(p_limit int DEFAULT 12)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'kpis', jsonb_build_object(
      'planned_this_month', (SELECT count(*) FROM mkt_content_items
         WHERE archived_at IS NULL AND planned_publish_at >= date_trunc('month', now())
           AND planned_publish_at < date_trunc('month', now()) + interval '1 month'),
      'in_production', (SELECT count(*) FROM mkt_content_items WHERE archived_at IS NULL
         AND status IN ('writing','approved_for_production','raw_assets_required','recording','designing','editing')),
      'awaiting_approval', (SELECT count(*) FROM mkt_content_items WHERE archived_at IS NULL
         AND status IN ('awaiting_script_approval','awaiting_final_approval','internal_review')),
      'ready_to_publish', (SELECT count(*) FROM mkt_content_items WHERE archived_at IS NULL AND status='ready_to_publish'),
      'scheduled', (SELECT count(*) FROM mkt_publications WHERE status='scheduled'),
      'published_this_month', (SELECT count(*) FROM mkt_publications
         WHERE status='published' AND published_at >= date_trunc('month', now())),
      'late', (SELECT count(*) FROM mkt_content_items WHERE archived_at IS NULL
         AND due_date < current_date AND status NOT IN ('published','cancelled','archived')),
      'blocked', (SELECT count(*) FROM mkt_content_tasks WHERE status='blocked'),
      'active_organic_campaigns', (SELECT count(*) FROM mkt_internal_campaigns
         WHERE status='active' AND channel_mix IN ('organic','both')),
      'active_paid_campaigns', (SELECT count(*) FROM mkt_internal_campaigns
         WHERE status='active' AND channel_mix IN ('paid','both')),
      'raw_assets_available', (SELECT count(*) FROM mkt_raw_assets
         WHERE archived_at IS NULL AND usage_status='available'),
      'leads_attributed', (SELECT count(*) FROM mkt_lead_attributions WHERE client_id IS NOT NULL),
      'revenue_attributed', (SELECT sum(revenue) FROM mkt_lead_attributions),
      -- unmeasurable until a source exists: null, NOT zero
      'appointments_attributed', (SELECT count(*) FROM mkt_lead_attributions WHERE appointment_id IS NOT NULL),
      'sales_attributed', (SELECT count(*) FROM mkt_lead_attributions WHERE reservation_id IS NOT NULL)
    ),
    'due_today', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (
        SELECT i.id, i.content_number, i.title, i.status, i.due_date, i.owner_user_id
        FROM mkt_content_items i WHERE i.archived_at IS NULL AND i.due_date = current_date
          AND i.status NOT IN ('published','cancelled','archived')
        ORDER BY i.priority DESC LIMIT p_limit) t), '[]'::jsonb),
    'overdue', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (
        SELECT i.id, i.content_number, i.title, i.status, i.due_date,
               (current_date - i.due_date) AS days_late
        FROM mkt_content_items i WHERE i.archived_at IS NULL AND i.due_date < current_date
          AND i.status NOT IN ('published','cancelled','archived')
        ORDER BY i.due_date LIMIT p_limit) t), '[]'::jsonb),
    'approval_queue', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (
        SELECT a.id, a.stage, a.target_id, a.created_at, i.title, i.content_number,
               round(EXTRACT(EPOCH FROM (now()-a.created_at))/3600)::int AS hours_waiting
        FROM mkt_approvals a LEFT JOIN mkt_content_items i ON i.id=a.target_id
        WHERE a.decision='pending' ORDER BY a.created_at LIMIT p_limit) t), '[]'::jsonb),
    'publishing_queue', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (
        SELECT p.id, p.platform, p.scheduled_for, p.status, i.title, i.content_number,
               EXISTS (SELECT 1 FROM mkt_content_versions v WHERE v.content_item_id=p.content_item_id
                        AND v.approval_state='approved') AS has_approved_version
        FROM mkt_publications p JOIN mkt_content_items i ON i.id=p.content_item_id
        WHERE p.status IN ('ready','scheduled') ORDER BY p.scheduled_for NULLS LAST LIMIT p_limit) t), '[]'::jsonb),
    'recently_published', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (
        SELECT p.id, p.platform, p.published_at, p.published_url, i.title, i.content_number,
               EXISTS (SELECT 1 FROM mkt_performance_snapshots s WHERE s.publication_id=p.id) AS has_performance
        FROM mkt_publications p JOIN mkt_content_items i ON i.id=p.content_item_id
        WHERE p.status='published' ORDER BY p.published_at DESC LIMIT p_limit) t), '[]'::jsonb),
    'alerts', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (
        SELECT a.id, a.kind, a.severity, a.title_ar, a.title_en, a.target_type, a.target_id, a.evidence, a.generated_at
        FROM mkt_mgmt_alerts a WHERE a.resolved_at IS NULL AND a.dismissed=false
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 a.generated_at DESC LIMIT p_limit) t), '[]'::jsonb),
    'workload', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM (
        SELECT t2.assigned_user_id, count(*) AS open_tasks,
               count(*) FILTER (WHERE t2.due_date < current_date) AS overdue_tasks
        FROM mkt_content_tasks t2
        WHERE t2.assigned_user_id IS NOT NULL AND t2.status NOT IN ('completed','cancelled')
        GROUP BY 1 ORDER BY 2 DESC LIMIT p_limit) t), '[]'::jsonb),
    'coverage', jsonb_build_object(
      'campaigns_total', (SELECT count(*) FROM mkt_internal_campaigns WHERE archived_at IS NULL),
      'content_total',   (SELECT count(*) FROM mkt_content_items WHERE archived_at IS NULL),
      'publications_total', (SELECT count(*) FROM mkt_publications),
      'assets_total',    (SELECT count(*) FROM mkt_raw_assets WHERE archived_at IS NULL),
      'note', 'Attribution figures count only recorded attributions. Absence of a number means not recorded, not zero.'
    )
  );
$$;
GRANT EXECUTE ON FUNCTION public.mkt_mgmt_overview(int) TO authenticated, service_role;;
