-- ============================================================================
-- Campaign planning — SEEDS + COMPATIBILITY BACKFILLS (2026-09-14, part 4 of 4)
-- ----------------------------------------------------------------------------
--   * the five new capabilities (contract §3) — DATA, per CLAUDE.md
--   * mos_settings.planning / refresh_policy / ranking / work_calendar
--     (contract §6, verbatim defaults)
--   * mos_step_effort from src/lib/marketingOS/scheduling/defaults.ts
--   * mos_user_capacity from mos_role_load × the people who hold those roles
--   * the plan §18 compatibility backfills
--
-- SWITCHES AS SEEDED (this used to claim every layer ships dark; it does not,
-- and the claim was wrong the day it was written — the brief was one complete
-- phase with nothing left for a later release):
--   * preview_enabled        = true  — planning a campaign is read-only.
--   * reservations_enforced  = true  — an approved plan actually books capacity.
--     With it off, two approvals can book the same designer on the same day,
--     which is the whole failure this work exists to prevent.
--   * refresh_loop_enabled   = true  — the weekly sweep ranks creatives and
--     opens the decision, but never decides: see the next line.
--   * auto_apply_default_decision = false — the ONE switch that is off, and the
--     only one whose default is a judgement call rather than a capability. With
--     it off a human picks the winner and approves each swap; turning it on lets
--     the ranking act by itself. Ads are created paused either way
--     (ads_created_paused = true), so nothing spends before someone looks.
-- Flipping any of these is a data edit in Marketing → Settings, not a deploy.
--
-- Idempotent: ON CONFLICT DO NOTHING everywhere; the settings rows merge rather
-- than overwrite, so an operator's edit is never clobbered by a re-run.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 0. mos_settings also gates the snapshot hash (planning.weekend_days), so it
--    is a ledger-config table like the other four and takes the same lock.
-- ────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS mos_settings_ledger_lock ON public.mos_settings;
CREATE TRIGGER mos_settings_ledger_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.mos_settings
  FOR EACH STATEMENT EXECUTE FUNCTION public.mos_tg_ledger_lock();

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Capabilities (contract §3 / CLAUDE.md "Marketing OS capabilities are DATA")
-- ----------------------------------------------------------------------------
-- Reminder for whoever adds the next one: a capability lives in THREE places —
-- this seed, `CAPABILITIES` in api/marketing-os.ts, and the `Capability` union
-- in MarketingWorkspace.tsx.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.role_capabilities (role_id, capability)
SELECT r.id, c.capability
  FROM public.roles r
  CROSS JOIN (VALUES
      ('plan_campaign'),
      ('approve_plan'),
      ('decide_refresh'),
      ('revise_approved_content'),
      ('manage_capacity')) AS c(capability)
 WHERE r.key IN ('mos_marketing_manager', 'mos_ceo')
ON CONFLICT DO NOTHING;

-- the ops supervisor may PLAN a campaign but not approve it
INSERT INTO public.role_capabilities (role_id, capability)
SELECT r.id, 'plan_campaign' FROM public.roles r WHERE r.key = 'mos_ops_supervisor'
ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Settings (contract §6 — every value editable, all documented)
-- ----------------------------------------------------------------------------
-- MERGE semantics: the seeded defaults fill in only the keys that are missing,
-- so re-running never overwrites what the manager has since changed.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.mos_settings (key, value) VALUES
  ('planning', jsonb_build_object(
      'publish_buffer_days',          1,
      'manual_task_weight',           0.5,
      'approvals_cap_per_day',        20,
      'weekend_days',                 jsonb_build_array(5),
      'search_budget',                400000,
      'preview_enabled',              true,
      'reservations_enforced',        true,
      'refresh_loop_enabled',         true,
      'auto_apply_default_decision',  false,
      'min_active_creatives',         5,
      'ads_created_paused',           true))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || public.mos_settings.value;

INSERT INTO public.mos_settings (key, value) VALUES
  ('refresh_policy', jsonb_build_object(
      'slate_size',             5,
      'keep_min',               1,
      'cycle_days',             7,
      'min_remaining_days',     3,
      'lead_time_working_days', 7,
      'fifth_policy',           'A'))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || public.mos_settings.value;

INSERT INTO public.mos_settings (key, value) VALUES
  ('ranking', jsonb_build_object(
      'min_spend_sar',         150,
      'min_impressions',       2000,
      'fatigue_frequency',     3.0,
      'fatigue_ctr_drop_pct',  40))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || public.mos_settings.value;

-- plan §14.5. The weekend lives in planning.weekend_days (that is what the
-- hash and mos_weekend_days() read); this row carries the rest of the calendar.
INSERT INTO public.mos_settings (key, value) VALUES
  ('work_calendar', jsonb_build_object(
      'timezone',     'Asia/Riyadh',
      'weekend_days', jsonb_build_array(5),
      'day_start',    '09:00',
      'day_end',      '18:00'))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || public.mos_settings.value;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. mos_step_effort — EXPLICIT estimates, from defaults.ts
-- ----------------------------------------------------------------------------
-- These are NOT the steps' `due_days` (a deadline allowance, not effort — the
-- v2 mistake). Bucket = the LEDGER bucket, i.e. bucketOfStep(): an approval
-- step consumes 'approvals', everything else the content's own bucket.
-- The manager edits them in Settings → Capacity; §19's accuracy view re-seeds
-- them from measured medians after the first campaign.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.mos_step_effort (workflow_key, step_key, bucket, working_days) VALUES
  -- «مسار المنشور القياسي» / post_std
  ('post_std',  'writing',              'post',      1),
  ('post_std',  'writing_review',       'approvals', 1),
  ('post_std',  'design',               'post',      2),
  ('post_std',  'design_writer_review', 'approvals', 1),
  ('post_std',  'design_review',        'approvals', 1),
  ('post_std',  'scheduling',           'post',      0.5),
  ('post_std',  'publish_check',        'approvals', 0.5),
  -- «مسار الفيديو القياسي» / video_std
  ('video_std', 'idea',                 'video',     1),
  ('video_std', 'idea_review',          'approvals', 1),
  ('video_std', 'script',               'video',     2),
  ('video_std', 'script_review',        'approvals', 1),
  ('video_std', 'assets',               'video',     2),
  ('video_std', 'editing',              'video',     3),
  ('video_std', 'first_version',        'video',     1),
  ('video_std', 'writer_review',        'approvals', 1),
  ('video_std', 'review',               'approvals', 1),
  ('video_std', 'scheduling',           'video',     0.5),
  ('video_std', 'publish_check',        'approvals', 0.5)
ON CONFLICT (workflow_key, step_key, bucket) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. mos_user_capacity — mos_role_load × the people who hold those roles
-- ----------------------------------------------------------------------------
-- The fallback in mos_user_daily_slots() already resolves to the same numbers;
-- materialising them makes each person's capacity visible and EDITABLE in the
-- Capacity screen instead of implicit in their role.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO public.mos_user_capacity (user_id, bucket, daily_slots)
SELECT u.id, rl.bucket, max(rl.daily_new_tasks)::numeric
  FROM public.users u
  JOIN public.roles r
    ON r.key LIKE 'mos\_%' ESCAPE '\'
   AND r.id::text IN (SELECT e ->> 'role_id'
                        FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
  JOIN public.mos_role_load rl ON rl.role_id = r.id
 WHERE u.is_active
 GROUP BY u.id, rl.bucket
ON CONFLICT (user_id, bucket) DO NOTHING;

-- the approvals budget: mos_role_load has no 'approvals' bucket, so every
-- marketing-role holder gets the settings default (20/day) as an explicit,
-- editable row — the same number the fallback would have produced.
INSERT INTO public.mos_user_capacity (user_id, bucket, daily_slots)
SELECT DISTINCT u.id, 'approvals',
       COALESCE((public.mos_planning_cfg() ->> 'approvals_cap_per_day')::numeric, 20)
  FROM public.users u
  JOIN public.roles r
    ON r.key LIKE 'mos\_%' ESCAPE '\'
   AND r.id::text IN (SELECT e ->> 'role_id'
                        FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
 WHERE u.is_active
ON CONFLICT (user_id, bucket) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. mos_content_types.design_fields — which writing fields change the PICTURE
-- ----------------------------------------------------------------------------
-- §9.3: a change to one of these forces the design step to re-run (the file
-- still shows the old text). caption / hashtags / expiry do not.
-- ────────────────────────────────────────────────────────────────────────────

UPDATE public.mos_content_types SET design_fields = ARRAY['headlines','approved_headline','design_brief','slides']
 WHERE key = 'post'     AND COALESCE(array_length(design_fields, 1), 0) = 0;
UPDATE public.mos_content_types SET design_fields = ARRAY['headlines','slides','design_brief']
 WHERE key = 'carousel' AND COALESCE(array_length(design_fields, 1), 0) = 0;
UPDATE public.mos_content_types SET design_fields = ARRAY['design_brief']
 WHERE key = 'story'    AND COALESCE(array_length(design_fields, 1), 0) = 0;
UPDATE public.mos_content_types SET design_fields = ARRAY['idea','hook','scenes','duration','aspect_ratio']
 WHERE key = 'video'    AND COALESCE(array_length(design_fields, 1), 0) = 0;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Compatibility backfills (plan §18)
-- ────────────────────────────────────────────────────────────────────────────

-- (a) existing OPEN tasks get an effort so they weigh correctly in the ledger.
--     Without this every legacy open task counts as 1 slot-day whatever it is.
UPDATE public.workflow_role_tasks t
   SET effort_days = public.mos_step_effort_days(
         public.mos_workflow_key_of(t.subject_id),
         t.step_key,
         public.mos_ledger_bucket(t.workflow_version_id, t.step_key,
           COALESCE(t.bucket, public.mos_perf_bucket_of(t.subject_id))))
 WHERE t.status = 'open'
   AND t.subject_table = 'mos_content'
   AND t.effort_days IS NULL;

-- (b) mos_asset_links.version — the column is NOT NULL DEFAULT 1, so every
--     existing row is already version 1. Asserted rather than written.
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.mos_asset_links WHERE version IS DISTINCT FROM 1 AND superseded_at IS NULL;
  IF v_bad > 0 THEN
    RAISE NOTICE 'mos_asset_links: % current rows are not version 1 (expected 0 at backfill time)', v_bad;
  END IF;
END $$;

-- (c) legacy `final` links are FLAGGED, never auto-renamed. We cannot know
--     from the database whether a `final` file is the square or the vertical
--     one, and guessing is how a 9:16 design ends up in the Instagram feed —
--     the exact bug the operator had to undo by hand on 2026-09-13. The
--     preflight (`content_ad_readiness`) already reports them as missing
--     slots; this records the flag so the Materials tab can prompt.
INSERT INTO public.mos_content_events (content_id, kind, detail)
SELECT DISTINCT al.content_id, 'legacy_final_slot',
       jsonb_build_object(
         'note_ar', 'رابط تصميم قديم بدور «final» — أعد رفعه كـ final_square أو final_vertical',
         'note_en', 'legacy design link with role «final» — re-upload it as final_square or final_vertical',
         'asset_id', al.asset_id)
  FROM public.mos_asset_links al
 WHERE al.role = 'final' AND al.superseded_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.mos_content_events ev
                    WHERE ev.content_id = al.content_id AND ev.kind = 'legacy_final_slot');

-- ────────────────────────────────────────────────────────────────────────────
-- 6b. Give the requirement machinery something to enforce
-- ----------------------------------------------------------------------------
-- `workflow_advance_role_path` now enforces `required_fields`, but every live
-- step carried `required_fields: []` — so a writing stage could still close
-- with no caption at all, which is the exact hole this build exists to close.
--
-- A NEW workflow_versions row is pinned so NEW content picks it up. In-flight
-- items keep their pinned version by design (4 tasks are open right now) — a
-- retro-fit would move the goalposts under someone mid-task.
--
-- `caption` alone is not enough: the caption CONFIRMATION is enforced by the
-- companion rule inside workflow_advance_role_path
-- (`data->>'caption_confirmed_text' = data->>'caption'`, exact, untrimmed).
--
-- The two design slots are deliberately NOT put in `required_files`: montage
-- must be able to submit a work-in-progress for review, and the slots are
-- already a hard gate at ad-build time via content_ad_readiness.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r        record;
  v_def    jsonb;
  v_new    jsonb;
  v_no     int;
  v_steps  jsonb;
  v_wf     uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('post', 'writing'), ('video', 'script')) AS t(type_key, step_key)
  LOOP
    SELECT ct.workflow_id INTO v_wf FROM public.mos_content_types ct
     WHERE ct.key = r.type_key AND ct.archived_at IS NULL LIMIT 1;
    CONTINUE WHEN v_wf IS NULL;

    SELECT wv.definition, wv.version_no INTO v_def, v_no
      FROM public.workflow_versions wv
     WHERE wv.workflow_id = v_wf ORDER BY wv.version_no DESC LIMIT 1;
    CONTINUE WHEN v_def IS NULL;

    SELECT jsonb_agg(CASE WHEN e.elem ->> 'key' = r.step_key
                          THEN jsonb_set(e.elem, '{required_fields}', '["caption"]'::jsonb)
                          ELSE e.elem END ORDER BY e.ord)
      INTO v_steps
      FROM jsonb_array_elements(v_def -> 'metadata' -> 'steps') WITH ORDINALITY e(elem, ord);

    v_new := jsonb_set(v_def, '{metadata,steps}', v_steps);

    -- idempotent: the latest version already carries it → nothing to do
    IF v_new IS DISTINCT FROM v_def THEN
      INSERT INTO public.workflow_versions (workflow_id, version_no, definition)
      VALUES (v_wf, v_no + 1, v_new);
    END IF;

    -- the workflow's own metadata mirrors the newest step list
    UPDATE public.workflows w
       SET metadata = jsonb_set(COALESCE(w.metadata, '{}'::jsonb), '{steps}',
             (SELECT jsonb_agg(CASE WHEN e.elem ->> 'key' = r.step_key
                                    THEN jsonb_set(e.elem, '{required_fields}', '["caption"]'::jsonb)
                                    ELSE e.elem END ORDER BY e.ord)
                FROM jsonb_array_elements(COALESCE(w.metadata -> 'steps', '[]'::jsonb)) WITH ORDINALITY e(elem, ord)))
     WHERE w.id = v_wf
       AND jsonb_typeof(w.metadata -> 'steps') = 'array';
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Post-seed sanity — fail loudly rather than ship a half-seeded module
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE v_caps int; v_effort int; v_settings int;
BEGIN
  SELECT count(*) INTO v_caps FROM public.role_capabilities rc
    JOIN public.roles r ON r.id = rc.role_id
   WHERE rc.capability IN ('plan_campaign','approve_plan','decide_refresh',
                           'revise_approved_content','manage_capacity');
  IF v_caps < 11 THEN
    RAISE EXCEPTION 'capability seed incomplete: % rows (expected >= 11)', v_caps;
  END IF;

  SELECT count(*) INTO v_effort FROM public.mos_step_effort;
  IF v_effort < 18 THEN
    RAISE EXCEPTION 'mos_step_effort seed incomplete: % rows (expected >= 18)', v_effort;
  END IF;

  SELECT count(*) INTO v_settings FROM public.mos_settings
   WHERE key IN ('planning','refresh_policy','ranking','work_calendar');
  IF v_settings <> 4 THEN
    RAISE EXCEPTION 'settings seed incomplete: % of 4 keys', v_settings;
  END IF;
END $$;
