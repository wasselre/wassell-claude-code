-- ============================================================================
-- Content operations, part 4: backfill legacy content into the new shape.
--
-- WHAT EXISTS IN PRODUCTION AT THE TIME OF WRITING (verified, not assumed):
--   mkt_content_items          2   C-00008 "de" (brief), C-00011 "mena 52 video" (idea)
--   mkt_content_tasks         24   the identical fixed 12 on each item
--   mkt_video_scenes           7
--   mkt_raw_assets             2   mkt_asset_links 0
--   mkt_content_versions       0   mkt_publications 0   mkt_content_platforms 0
--
-- WHAT THIS DOES
--   * snapshots every table it touches, so there is a rollback path
--   * gives each brief exactly one deliverable carrying its platform-shaped
--     fields, numbered D1
--   * re-parents its tasks and scenes onto that deliverable, preserving every
--     column — no task is deleted, renumbered or re-titled
--   * marks the legacy tasks with template_key='legacy_fixed_12' so they are
--     distinguishable from generated ones forever, and gives the ones that were
--     sitting at status='blocked' with no reason a REAL dependency
--   * copies the five fixed craft columns into mkt_content_roles
--   * maps any existing content versions onto the deliverable and any
--     final_asset_id into an asset link
--   * flags what it could not know instead of inventing it
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * invent a platform (mkt_content_platforms is empty — see part 1)
--   * invent a strategy version, plan, goal, scope or audience
--   * drop a single legacy column or row
--   * move any item out of its current status
--
-- Idempotent: guarded on "does this brief already have a deliverable".
-- ============================================================================
BEGIN;

-- ── 0. Rollback snapshots ───────────────────────────────────────────────────
-- Plain tables, not temp: the point is that they survive the transaction so a
-- human can compare or restore. Drop them once the migration is trusted.
CREATE TABLE IF NOT EXISTS public._backup_content_items_20260827 AS
  SELECT * FROM public.mkt_content_items;
CREATE TABLE IF NOT EXISTS public._backup_content_tasks_20260827 AS
  SELECT * FROM public.mkt_content_tasks;
CREATE TABLE IF NOT EXISTS public._backup_video_scenes_20260827 AS
  SELECT * FROM public.mkt_video_scenes;
CREATE TABLE IF NOT EXISTS public._backup_content_versions_20260827 AS
  SELECT * FROM public.mkt_content_versions;

-- ── 1. One deliverable per legacy brief ─────────────────────────────────────
DO $$
DECLARE
  c record; v_del uuid; v_platform text; v_format text; v_count int := 0; v_platforms int;
BEGIN
  FOR c IN SELECT * FROM public.mkt_content_items WHERE archived_at IS NULL LOOP
    -- Idempotence: a brief that already has a deliverable is left alone.
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.mkt_content_deliverables
                           WHERE content_item_id = c.id);

    -- Platform only when the legacy join row says so UNAMBIGUOUSLY. Two rows
    -- means two deliverables were always intended and a human must split them;
    -- zero rows means nobody ever said. Both stay NULL.
    SELECT count(*) INTO v_platforms FROM public.mkt_content_platforms WHERE content_item_id = c.id;
    IF v_platforms = 1 THEN
      SELECT platform INTO v_platform FROM public.mkt_content_platforms WHERE content_item_id = c.id;
      -- The legacy platform list and the deliverable list are not identical.
      IF v_platform NOT IN ('instagram','tiktok','youtube','snapchat','x','facebook',
                            'linkedin','whatsapp','website','email','offline','other') THEN
        v_platform := NULL;
      END IF;
    ELSE
      v_platform := NULL;
    END IF;

    -- content_type → deliverable format. Every value in the live CHECK list is
    -- mapped; anything unrecognised falls to 'other' rather than failing the
    -- migration, and 'other' has no template so it asks for one.
    v_format := CASE c.content_type
      WHEN 'reel' THEN 'reel'
      WHEN 'tiktok_video' THEN 'short_video'
      WHEN 'snapchat_video' THEN 'short_video'
      WHEN 'snapchat_story' THEN 'story'
      WHEN 'instagram_story' THEN 'story'
      WHEN 'static_image' THEN 'static_image'
      WHEN 'carousel' THEN 'carousel'
      WHEN 'infographic' THEN 'static_image'
      WHEN 'long_form_video' THEN 'long_form_video'
      WHEN 'paid_video_ad' THEN 'paid_video_ad'
      WHEN 'paid_image_ad' THEN 'paid_image_ad'
      WHEN 'project_announcement' THEN 'static_image'
      WHEN 'testimonial' THEN 'short_video'
      WHEN 'construction_update' THEN 'short_video'
      WHEN 'educational' THEN 'short_video'
      WHEN 'floor_plan' THEN 'static_image'
      WHEN 'property_tour' THEN 'long_form_video'
      WHEN 'drone_video' THEN 'short_video'
      WHEN 'presenter_video' THEN 'short_video'
      WHEN 'ai_video' THEN 'short_video'
      WHEN 'motion_graphics' THEN 'short_video'
      ELSE 'other'
    END;

    INSERT INTO public.mkt_content_deliverables
      (content_item_id, deliverable_number, label, platform, distribution, format,
       language, owner_user_id, due_date, planned_publish_at, status,
       caption, hashtags, cta_destination, destination_url,
       workflow_template_key, needs_classification, notes,
       created_by_user_id, created_at)
    VALUES
      (c.id, 1,
       -- Named after what it came from, so its origin is legible in the UI.
       'المخرج الأصلي',
       v_platform,
       CASE c.organic_or_paid WHEN 'paid' THEN 'paid' WHEN 'boosted' THEN 'both'
                              ELSE 'organic' END,
       v_format,
       COALESCE(c.language, 'ar'),
       c.owner_user_id, c.due_date, c.planned_publish_at,
       -- Never advances the item. A published legacy item keeps a published
       -- deliverable; everything else starts where the work actually is.
       -- A deliverable with no known platform is held at 'planned' whatever the
       -- item says: mkt_del_live_needs_platform refuses to call something ready
       -- when nobody has said where it goes, and the alternative would be to
       -- invent a platform to satisfy the constraint.
       CASE WHEN v_platform IS NULL THEN 'planned'
            WHEN c.status = 'published' THEN 'published'
            WHEN c.status IN ('cancelled','archived') THEN 'cancelled'
            WHEN c.status = 'scheduled' THEN 'scheduled'
            ELSE 'planned' END,
       c.caption, COALESCE(c.hashtags, '{}'), c.cta_destination, c.tracking_link,
       (SELECT key FROM public.mkt_workflow_templates
         WHERE format = v_format AND is_active LIMIT 1),
       -- Unclassified whenever we could not learn the platform.
       (v_platform IS NULL),
       CASE WHEN v_platforms > 1
            THEN format('Legacy item listed %s platforms; they need splitting into separate deliverables.', v_platforms)
            ELSE NULL END,
       c.created_by_user_id, c.created_at)
    RETURNING id INTO v_del;

    -- Tasks: re-parent, never recreate. template_key marks their provenance;
    -- step_key stays NULL so mkt_generate_deliverable_tasks() can add the real
    -- template steps alongside without colliding on the unique index.
    UPDATE public.mkt_content_tasks
       SET deliverable_id = v_del,
           template_key = COALESCE(template_key, 'legacy_fixed_12')
     WHERE content_item_id = c.id AND deliverable_id IS NULL;

    -- Those 24 rows are 'blocked' with neither a reason nor a dependency, which
    -- is the state the fixed-12 generator left them in. Chain each to its
    -- predecessor so "blocked" becomes a fact the UI can explain.
    UPDATE public.mkt_content_tasks t
       SET depends_on_task_id = p.id
      FROM public.mkt_content_tasks p
     WHERE t.deliverable_id = v_del AND p.deliverable_id = v_del
       AND p.sort_order = t.sort_order - 1
       AND t.depends_on_task_id IS NULL AND t.status = 'blocked';

    UPDATE public.mkt_video_scenes SET deliverable_id = v_del
     WHERE content_item_id = c.id AND deliverable_id IS NULL;
    UPDATE public.mkt_carousel_slides SET deliverable_id = v_del
     WHERE content_item_id = c.id AND deliverable_id IS NULL;

    -- Existing text/file versions become artifact versions of this deliverable.
    UPDATE public.mkt_content_versions SET deliverable_id = v_del
     WHERE content_item_id = c.id AND deliverable_id IS NULL;

    -- Any publication rows follow their content item's only deliverable.
    UPDATE public.mkt_publications SET deliverable_id = v_del
     WHERE content_item_id = c.id AND deliverable_id IS NULL;

    -- A final asset that was only a foreign key becomes a real library link.
    IF c.final_asset_id IS NOT NULL THEN
      INSERT INTO public.mkt_asset_links (asset_id, target_type, target_id, role, created_by_user_id)
      VALUES (c.final_asset_id, 'deliverable', v_del, 'final', c.created_by_user_id)
      ON CONFLICT (asset_id, target_type, target_id) DO NOTHING;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'BACKFILL: created % legacy deliverable(s)', v_count;
END $$;

-- ── 2. The five fixed craft columns become role rows ────────────────────────
-- The columns stay. This makes the same facts expressible as many-per-role.
INSERT INTO public.mkt_content_roles (content_item_id, user_id, role_key, created_by_user_id)
SELECT c.id, u.user_id, u.role_key, c.created_by_user_id
  FROM public.mkt_content_items c
  CROSS JOIN LATERAL (VALUES
    (c.owner_user_id,        'owner'),
    (c.writer_user_id,       'writer'),
    (c.designer_user_id,     'designer'),
    (c.editor_user_id,       'editor'),
    (c.presenter_user_id,    'presenter'),
    (c.photographer_user_id, 'photographer')
  ) AS u(user_id, role_key)
 WHERE u.user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 3. Flag what we could not know; invent nothing ──────────────────────────
UPDATE public.mkt_content_items
   SET legacy_shape = 'v1_single_platform'
 WHERE legacy_shape IS NULL;

UPDATE public.mkt_content_items
   SET needs_classification = true
 WHERE archived_at IS NULL
   AND array_length(public.mkt_content_missing_requirements(id), 1) > 0;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT content_number, title, status,
           public.mkt_content_missing_requirements(id) AS missing
      FROM public.mkt_content_items WHERE archived_at IS NULL ORDER BY content_number
  LOOP
    RAISE NOTICE 'LEGACY % (%) status=% missing=%',
      r.content_number, r.title, r.status, array_to_string(r.missing, ', ');
  END LOOP;
END $$;

-- ── 4. Validate the migrated content itself, not the migration's timestamp ──
DO $$
DECLARE
  v_items int; v_without int; v_orphan_tasks int; v_orphan_scenes int;
  v_dupes int; v_lost_tasks int; v_before int;
BEGIN
  SELECT count(*) INTO v_items FROM public.mkt_content_items WHERE archived_at IS NULL;

  SELECT count(*) INTO v_without FROM public.mkt_content_items c
   WHERE c.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.mkt_content_deliverables d WHERE d.content_item_id = c.id);
  IF v_without > 0 THEN
    RAISE EXCEPTION 'BACKFILL FAILED: % live content item(s) still have no deliverable', v_without;
  END IF;

  -- Nothing may appear twice. A second D1 for one brief would show the same
  -- work in two places on the board.
  SELECT count(*) INTO v_dupes FROM (
    SELECT content_item_id FROM public.mkt_content_deliverables
     WHERE label = 'المخرج الأصلي' GROUP BY content_item_id HAVING count(*) > 1) x;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'BACKFILL FAILED: % brief(s) got more than one legacy deliverable', v_dupes;
  END IF;

  -- Every task and scene that had a content item must now also have a
  -- deliverable, and NONE may have been lost.
  SELECT count(*) INTO v_orphan_tasks FROM public.mkt_content_tasks
   WHERE content_item_id IS NOT NULL AND deliverable_id IS NULL;
  IF v_orphan_tasks > 0 THEN
    RAISE EXCEPTION 'BACKFILL FAILED: % task(s) were not attached to a deliverable', v_orphan_tasks;
  END IF;

  SELECT count(*) INTO v_orphan_scenes FROM public.mkt_video_scenes WHERE deliverable_id IS NULL;
  IF v_orphan_scenes > 0 THEN
    RAISE EXCEPTION 'BACKFILL FAILED: % scene(s) were not attached to a deliverable', v_orphan_scenes;
  END IF;

  SELECT count(*) INTO v_before FROM public._backup_content_tasks_20260827;
  SELECT count(*) INTO v_lost_tasks FROM public.mkt_content_tasks;
  IF v_lost_tasks < v_before THEN
    RAISE EXCEPTION 'BACKFILL FAILED: task count fell from % to %', v_before, v_lost_tasks;
  END IF;

  RAISE NOTICE 'BACKFILL VALIDATED: % items, % deliverables, % tasks (was %), % scenes',
    v_items,
    (SELECT count(*) FROM public.mkt_content_deliverables),
    v_lost_tasks, v_before,
    (SELECT count(*) FROM public.mkt_video_scenes);
END $$;

COMMIT;
