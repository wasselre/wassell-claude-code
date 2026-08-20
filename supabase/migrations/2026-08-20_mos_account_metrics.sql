-- Organic account-level metrics — the growth history bundle.social will NOT keep.
-- ---------------------------------------------------------------------------
-- bundle.social exposes GET /analytics/social-account (followers, following,
-- postCount, impressions, reach) but DELETES all analytics after 30 days and
-- tells you, in their own docs, to "fetch and store the data daily on your end."
-- A growth trend therefore cannot be a read-through to bundle — it must be OUR
-- own daily snapshot. This table is the account-level twin of the per-post
-- mos_metric_snapshots: one dated row per (account, day), filled by the daily
-- cron (service role) and the on-demand "refresh" action.
--
-- Everything here is ADDITIVE and backward-compatible — deploying it changes no
-- existing behavior; it only creates a new table + a read view.

CREATE TABLE IF NOT EXISTS public.mos_account_metric_snapshots (
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES public.mos_platform_accounts(id) ON DELETE CASCADE,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  -- One point per account per day: the growth chart wants a clean daily cadence,
  -- so the daily pull UPSERTs on this (updating through the day) rather than
  -- appending N rows. UTC so the day boundary is stable regardless of server tz.
  captured_on        date NOT NULL DEFAULT ((now() AT TIME ZONE 'utc'))::date,
  source             text NOT NULL DEFAULT 'api',
  followers          integer,
  following          integer,
  post_count         integer,
  impressions        integer,
  reach              integer,   -- bundle's impressionsUnique (unique accounts reached)
  views              integer,
  likes              integer,
  comments           integer,
  extra              jsonb NOT NULL DEFAULT '{}'::jsonb,
  entered_by_user_id uuid,      -- null for a machine (cron/API) reading
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mos_account_metric_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT mos_acct_snap_source_check CHECK (source = ANY (ARRAY['manual'::text, 'api'::text])),
  CONSTRAINT mos_acct_snap_not_empty_check CHECK (
    followers IS NOT NULL OR following IS NOT NULL OR post_count IS NOT NULL
    OR impressions IS NOT NULL OR reach IS NOT NULL OR views IS NOT NULL
    OR extra <> '{}'::jsonb
  )
);

-- The daily-cadence key the pull UPSERTs onto (one row per account/source/day).
CREATE UNIQUE INDEX IF NOT EXISTS mos_acct_snap_daily_uidx
  ON public.mos_account_metric_snapshots (account_id, source, captured_on);

-- Trend reads: newest-first series for one account.
CREATE INDEX IF NOT EXISTS mos_acct_snap_account_at_idx
  ON public.mos_account_metric_snapshots (account_id, captured_at DESC);

-- RLS mirrors mos_metric_snapshots exactly: read gated by 'read', writes by
-- 'enter_metrics'. The cron writes as service role (bypasses RLS); the
-- on-demand refresh action goes through the same enter_metrics gate.
ALTER TABLE public.mos_account_metric_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mos_account_metric_snapshots_read ON public.mos_account_metric_snapshots;
CREATE POLICY mos_account_metric_snapshots_read ON public.mos_account_metric_snapshots
  FOR SELECT TO authenticated USING (wassell_mos_can('read'::text));

DROP POLICY IF EXISTS mos_account_metric_snapshots_ins ON public.mos_account_metric_snapshots;
CREATE POLICY mos_account_metric_snapshots_ins ON public.mos_account_metric_snapshots
  FOR INSERT TO authenticated WITH CHECK (wassell_mos_can('enter_metrics'::text));

DROP POLICY IF EXISTS mos_account_metric_snapshots_upd ON public.mos_account_metric_snapshots;
CREATE POLICY mos_account_metric_snapshots_upd ON public.mos_account_metric_snapshots
  FOR UPDATE TO authenticated
  USING (wassell_mos_can('enter_metrics'::text))
  WITH CHECK (wassell_mos_can('enter_metrics'::text));

DROP POLICY IF EXISTS mos_account_metric_snapshots_del ON public.mos_account_metric_snapshots;
CREATE POLICY mos_account_metric_snapshots_del ON public.mos_account_metric_snapshots
  FOR DELETE TO authenticated USING (wassell_mos_can('enter_metrics'::text));

-- ---------------------------------------------------------------------------
-- The Platform Pulse cockpit's headline numbers, one row per connected account:
-- latest snapshot + follower deltas (7d / 30d) + posting cadence + 30-day
-- engagement. The raw trend series is read directly from the table by the page;
-- this view is only the card summary so the page stays a single query.
-- security_invoker so the caller's RLS ('read') applies through it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.mos_account_pulse_v
WITH (security_invoker = true) AS
SELECT
  a.id                               AS account_id,
  a.platform,
  a.handle,
  a.label_ar,
  a.label_en,
  a.is_connected,
  a.can_read_metrics,
  a.bundle_account_id,
  latest.captured_at                 AS latest_captured_at,
  latest.followers,
  latest.following,
  latest.post_count,
  latest.reach                       AS reach_30d,
  latest.impressions                 AS impressions_30d,
  latest.views                       AS views_30d,
  (latest.followers - d7.followers)  AS followers_delta_7d,
  (latest.followers - d30.followers) AS followers_delta_30d,
  ( SELECT count(*) FROM public.mos_publications p
     WHERE p.account_id = a.id AND p.status = 'published'
       AND p.published_at >= now() - interval '7 days' )   AS posts_7d,
  ( SELECT count(*) FROM public.mos_publications p
     WHERE p.account_id = a.id AND p.status = 'published'
       AND p.published_at >= now() - interval '30 days' )  AS posts_30d,
  ( SELECT coalesce(sum(pv.latest_engagement), 0) FROM public.mos_publication_v pv
     WHERE pv.account_id = a.id AND pv.status = 'published'
       AND pv.published_at >= now() - interval '30 days' ) AS engagement_30d
FROM public.mos_platform_accounts a
LEFT JOIN LATERAL (
  SELECT * FROM public.mos_account_metric_snapshots s
   WHERE s.account_id = a.id
   ORDER BY s.captured_at DESC LIMIT 1
) latest ON true
LEFT JOIN LATERAL (
  SELECT s.followers FROM public.mos_account_metric_snapshots s
   WHERE s.account_id = a.id AND s.captured_on <= (current_date - 7)
   ORDER BY s.captured_on DESC LIMIT 1
) d7 ON true
LEFT JOIN LATERAL (
  SELECT s.followers FROM public.mos_account_metric_snapshots s
   WHERE s.account_id = a.id AND s.captured_on <= (current_date - 30)
   ORDER BY s.captured_on DESC LIMIT 1
) d30 ON true
WHERE a.archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- New rail surfaces for the Organic group: 'organic' (Platform Pulse) and
-- 'publishing' (Publishing Board). computeSurfaces() defaults an unseen surface
-- to HIDDEN for every non-admin role, so without these rows the new group would
-- be invisible to everyone except administrators/managers. Seed them by copying
-- the existing 'numbers' surface's per-role levels — whoever sees Weekly Numbers
-- (the current organic-adjacent surface) sees the new organic surfaces at the
-- same level. Idempotent.
INSERT INTO public.surface_access (role_id, surface_key, level, updated_at)
SELECT sa.role_id, v.surface_key, sa.level, now()
FROM public.surface_access sa
CROSS JOIN (VALUES ('organic'), ('publishing')) AS v(surface_key)
WHERE sa.surface_key = 'numbers'
ON CONFLICT (role_id, surface_key) DO NOTHING;
