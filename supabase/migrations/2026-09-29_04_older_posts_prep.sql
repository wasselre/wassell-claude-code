-- 2026-09-29 — The 11 older organic posts that were approved and never published.
--
-- Found 2026-09-29 among the 24 older items hidden on 16 Sep for the production
-- test week: 12 were confirmed published by hand at the old «تأكيد النشر» step
-- (left alone), 1 was never approved (P-135, left alone), and 11 were approved
-- (9–13 Sep) but never scheduled, so they never went out:
--   ربوة الرمز  P-150 … P-157 — square 1:1 + story 9:16 each, NO caption (made
--                before posts had a caption field; the text is on the image);
--   تل الربوة  P-142, P-146, P-148 — a single 9:16 design each (P-142/P-146 in
--                the old «final» slot, P-148 mislabelled «final_square").
--
-- Operator decision (2026-09-29, option "A"): the WRITER writes the captions and
-- the MANAGER approves them. So:
--   1. un-hide the 11 (the rest of the test-week list stays hidden);
--   2. the three تل الربوة designs go to the STORY slot — they are 9:16, and a
--      story carries no caption, so they need no writing at all;
--   3. record those three posts' final approval (9–10 Sep, from the workflow
--      history: same approver, same moment), binding today's files — the
--      approval existed before approvals were stamped with fingerprints
--      (20 Sep), and the publish gate (2026-09-29) posts nothing without one;
--   4. give each post undated publishing slots (feed + story for the eight,
--      story for the three) — dates are set when the operator picks the pace;
--   5. open a caption task for the writer on each ربوة الرمز post
--      (mos_content_request_caption): writing → review → final approval, with
--      the design steps skipped because the designs are already approved.
--
-- Guarded throughout so it replays harmlessly on a database without these rows.
BEGIN;

-- 1. un-hide the eleven
UPDATE public.mos_content
   SET archived_at = NULL
 WHERE ref IN ('P-142','P-146','P-148','P-150','P-151','P-152','P-153','P-154','P-155','P-156','P-157')
   AND purpose = 'organic'
   AND archived_at IS NOT NULL;

-- 2. the three 9:16 تل الربوة designs belong in the story slot (measured:
--    752×1344, 752×1344, 1080×1920). Done BEFORE the approval is recorded, while
--    the links are still unlocked.
UPDATE public.mos_asset_links l
   SET role = 'final_vertical'
  FROM public.mos_content c
 WHERE c.id = l.content_id
   AND l.superseded_at IS NULL
   AND ((c.ref = 'P-142' AND l.asset_id = '181b2f5f-5e73-4041-a9cd-0036c3395b61' AND l.role = 'final')
     OR (c.ref = 'P-146' AND l.asset_id = 'c956d6ab-7d6b-445a-ad3b-9b649fa117ed' AND l.role = 'final')
     OR (c.ref = 'P-148' AND l.asset_id = 'a035c91a-aa74-4eb8-8342-813279fdd313' AND l.role = 'final_square'));

-- 3. their final approval, as it happened in the workflow
INSERT INTO public.mos_content_approvals
  (content_id, step_key, round, approved_by_user_id, approved_at,
   writing_hash, design_hash, caption_hash, package_hash)
SELECT c.id, 'design_review', t.round, t.closed_by_user_id, t.closed_at,
       public.mos_content_writing_hash(c.id), public.mos_content_design_hash(c.id),
       public.mos_caption_hash(c.data ->> 'caption'), public.mos_content_package_hash(c.id)
  FROM public.mos_content c
  JOIN LATERAL (
    SELECT tt.round, tt.closed_by_user_id, tt.closed_at
      FROM public.workflow_role_tasks tt
     WHERE tt.subject_table = 'mos_content' AND tt.subject_id = c.id
       AND tt.step_key = 'design_review' AND tt.result = 'approved'
     ORDER BY tt.closed_at DESC LIMIT 1) t ON true
 WHERE c.ref IN ('P-142','P-146','P-148')
ON CONFLICT (content_id, step_key, round) DO NOTHING;

INSERT INTO public.mos_content_events (content_id, kind, actor_user_id, detail)
SELECT c.id, 'approval_backfilled', NULL,
       jsonb_build_object('why', 'approved 9–10 Sep before approvals were fingerprinted; recorded from the workflow history so the publish gate can pass it',
                          'story_slot', true, 'migration', '2026-09-29_04_older_posts_prep')
  FROM public.mos_content c
 WHERE c.ref IN ('P-142','P-146','P-148')
   AND EXISTS (SELECT 1 FROM public.mos_content_approvals a WHERE a.content_id = c.id);

-- 4. undated publishing slots on the company Instagram
UPDATE public.mos_publications p
   SET placement_variant = 'story'
  FROM public.mos_content c
 WHERE c.id = p.content_id AND c.ref IN ('P-146','P-148')
   AND p.status = 'draft' AND p.placement_variant IS NULL AND p.bundle_post_id IS NULL;

INSERT INTO public.mos_publications (content_id, platform, status, placement_variant)
SELECT c.id, 'instagram', 'draft', v.variant
  FROM public.mos_content c
  CROSS JOIN (VALUES ('feed'), ('story')) AS v(variant)
 WHERE (c.ref IN ('P-150','P-151','P-152','P-153','P-154','P-155','P-156','P-157')
        OR (c.ref = 'P-142' AND v.variant = 'story'))
   AND NOT EXISTS (SELECT 1 FROM public.mos_publications p
                    WHERE p.content_id = c.id AND p.placement_variant = v.variant
                      AND p.status <> 'cancelled');

-- 5. the writer's caption tasks on the eight ربوة الرمز posts
SELECT public.mos_content_request_caption(c.id,
  'أضف كابشن لهذا المنشور — صُمّم قبل وجود حقل الكابشن، ونصه على الصورة فقط. التصميم معتمد ولن يتغيّر؛ بعد اعتماد الكابشن يصبح جاهزًا للنشر.')
  FROM public.mos_content c
 WHERE c.ref IN ('P-150','P-151','P-152','P-153','P-154','P-155','P-156','P-157')
   AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                    WHERE t.subject_table = 'mos_content' AND t.subject_id = c.id AND t.status = 'open')
 ORDER BY c.ref;

-- ── assertions (guarded: only when these posts exist) ─────────────────────────
DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.mos_content WHERE ref = 'P-150') THEN
    IF (SELECT count(*) FROM public.workflow_role_tasks t JOIN public.mos_content c ON c.id = t.subject_id
         WHERE t.subject_table = 'mos_content' AND t.status = 'open' AND t.step_key = 'writing'
           AND c.ref IN ('P-150','P-151','P-152','P-153','P-154','P-155','P-156','P-157')) <> 8 THEN
      RAISE EXCEPTION 'OLDER_POSTS: expected 8 open caption tasks';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.mos_content WHERE ref = 'P-142') THEN
    IF (SELECT count(*) FROM public.mos_asset_links l JOIN public.mos_content c ON c.id = l.content_id
         WHERE c.ref IN ('P-142','P-146','P-148') AND l.role = 'final_vertical' AND l.superseded_at IS NULL) <> 3 THEN
      RAISE EXCEPTION 'OLDER_POSTS: the three تل الربوة designs are not in the story slot';
    END IF;
    IF (SELECT count(DISTINCT a.content_id) FROM public.mos_content_approvals a JOIN public.mos_content c ON c.id = a.content_id
         WHERE c.ref IN ('P-142','P-146','P-148') AND a.step_key = 'design_review') <> 3 THEN
      RAISE EXCEPTION 'OLDER_POSTS: the three تل الربوة approvals were not recorded';
    END IF;
  END IF;
END $assert$;

COMMIT;
