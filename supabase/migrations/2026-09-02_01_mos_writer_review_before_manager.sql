-- ============================================================================
-- Marketing OS: a WRITER review gate before the Marketing Manager, on both the
-- Standard post and Standard video role-paths.
--
-- WHAT (operator request, 2026-09-02)
-- Today, once Montage finishes the visual, the item goes STRAIGHT to the
-- Marketing Manager:
--   * post_std :  design (montage)      -> design_review (marketing_manager)
--   * video_std:  first_version (montage) -> review        (marketing_manager)
-- The operator wants the WRITER to review the finished post/video first; only
-- after the writer approves does it reach the Marketing Manager. (The existing
-- "writing finished -> Marketing Manager reviews" steps — writing_review /
-- script_review — are unchanged.)
--
-- HOW
-- Insert ONE approval step owned by the `writer` role immediately after the
-- Montage production step and before the Marketing Manager review:
--   * post_std :  design -> [design_writer_review: writer] -> design_review
--   * video_std:  first_version -> [writer_review: writer] -> review
--
-- WHY THIS IS SAFE
-- Editing a role-path workflow's metadata fires `workflows_tg_write_version`,
-- which snapshots a NEW workflow_versions row. In-flight mos_content items stay
-- pinned to the version they started under (mos_content.workflow_version_id,
-- ON DELETE RESTRICT), so running work is untouched. NEW content pins the
-- LATEST version at creation (api/marketing-os.ts openFirstTask), so only items
-- created from now on get the writer gate. Purely additive.
--
-- WHY creates_revision = false ON THE NEW STEP
-- The engine (workflow_advance_role_path) routes a `changes_requested` back to
-- the LAST prior step whose creates_revision=true. Marking the new writer-review
-- step creates_revision=false means:
--   * The writer requesting changes routes back to the Montage step (design /
--     first_version) — Montage redoes the visual. Correct.
--   * A LATER Marketing Manager rejection still routes back to the Montage step
--     (skipping the writer-review step), exactly as it does today, then re-flows
--     through the writer gate. So existing rejection routing is preserved and
--     the writer stays in the loop on every redo.
--
-- WHY writer approval works with no new capability
-- Task authorization (workflow_advance_role_path) and the UI's approve/return
-- buttons (ContentDetailPage canAct) gate on ROLE OWNERSHIP, not on an
-- approve_* capability. A user holding the `writer` role can act on a
-- writer-owned step whether or not it is an approval step. No capability change
-- is needed.
--
-- Idempotent: each UPDATE is a no-op if the new step key already exists.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- post_std: insert `design_writer_review` (writer) right after `design`
-- ---------------------------------------------------------------------------
UPDATE public.workflows w
SET metadata = jsonb_set(
  w.metadata,
  '{steps}',
  (
    SELECT jsonb_agg(x.elem ORDER BY e.ord, x.sub)
      FROM jsonb_array_elements(w.metadata->'steps') WITH ORDINALITY AS e(elem, ord)
      CROSS JOIN LATERAL (
        SELECT e.elem AS elem, 0 AS sub
        UNION ALL
        SELECT jsonb_build_object(
                 'key',                    'design_writer_review',
                 'notify',                 true,
                 'due_days',               1,
                 'label_ar',               'مراجعة الكاتب',
                 'label_en',               'Writer review',
                 'role_key',               'writer',
                 'is_approval',            true,
                 'approval_kind',          'creative',
                 'required_files',         '[]'::jsonb,
                 'notify_channels',        '["inapp","push","whatsapp"]'::jsonb,
                 'required_fields',        '[]'::jsonb,
                 'creates_revision',       false,
                 'require_note_on_reject', true
               ), 1
        WHERE e.elem->>'key' = 'design'
      ) AS x(elem, sub)
  )
)
WHERE w.kind = 'role_path'
  AND w.metadata->>'key' = 'post_std'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(w.metadata->'steps') s(elem)
     WHERE s.elem->>'key' = 'design_writer_review'
  );

-- ---------------------------------------------------------------------------
-- video_std: insert `writer_review` (writer) right after `first_version`
-- ---------------------------------------------------------------------------
UPDATE public.workflows w
SET metadata = jsonb_set(
  w.metadata,
  '{steps}',
  (
    SELECT jsonb_agg(x.elem ORDER BY e.ord, x.sub)
      FROM jsonb_array_elements(w.metadata->'steps') WITH ORDINALITY AS e(elem, ord)
      CROSS JOIN LATERAL (
        SELECT e.elem AS elem, 0 AS sub
        UNION ALL
        SELECT jsonb_build_object(
                 'key',                    'writer_review',
                 'notify',                 true,
                 'due_days',               1,
                 'label_ar',               'مراجعة الكاتب',
                 'label_en',               'Writer review',
                 'role_key',               'writer',
                 'is_approval',            true,
                 'approval_kind',          'creative',
                 'required_files',         '[]'::jsonb,
                 'notify_channels',        '["inapp","push","whatsapp"]'::jsonb,
                 'required_fields',        '[]'::jsonb,
                 'creates_revision',       false,
                 'require_note_on_reject', true
               ), 1
        WHERE e.elem->>'key' = 'first_version'
      ) AS x(elem, sub)
  )
)
WHERE w.kind = 'role_path'
  AND w.metadata->>'key' = 'video_std'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(w.metadata->'steps') s(elem)
     WHERE s.elem->>'key' = 'writer_review'
  );

-- ---------------------------------------------------------------------------
-- Validation — fail loudly rather than ship a half-applied change
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_post_ok  boolean;
  v_video_ok boolean;
BEGIN
  -- post: design_writer_review sits between design and design_review, owned by writer.
  SELECT (dpos + 1 = wpos AND wpos + 1 = drpos AND role = 'writer')
    INTO v_post_ok
    FROM (
      SELECT
        max(ord) FILTER (WHERE k = 'design')               AS dpos,
        max(ord) FILTER (WHERE k = 'design_writer_review')  AS wpos,
        max(ord) FILTER (WHERE k = 'design_review')         AS drpos,
        max(role) FILTER (WHERE k = 'design_writer_review') AS role
      FROM (
        SELECT s.elem->>'key' AS k, s.elem->>'role_key' AS role, s.ord
          FROM public.workflows w
          CROSS JOIN LATERAL jsonb_array_elements(w.metadata->'steps') WITH ORDINALITY AS s(elem, ord)
         WHERE w.metadata->>'key' = 'post_std'
      ) z
    ) q;

  -- video: writer_review sits between first_version and review, owned by writer.
  SELECT (fpos + 1 = wpos AND wpos + 1 = rpos AND role = 'writer')
    INTO v_video_ok
    FROM (
      SELECT
        max(ord) FILTER (WHERE k = 'first_version') AS fpos,
        max(ord) FILTER (WHERE k = 'writer_review') AS wpos,
        max(ord) FILTER (WHERE k = 'review')        AS rpos,
        max(role) FILTER (WHERE k = 'writer_review') AS role
      FROM (
        SELECT s.elem->>'key' AS k, s.elem->>'role_key' AS role, s.ord
          FROM public.workflows w
          CROSS JOIN LATERAL jsonb_array_elements(w.metadata->'steps') WITH ORDINALITY AS s(elem, ord)
         WHERE w.metadata->>'key' = 'video_std'
      ) z
    ) q;

  IF NOT COALESCE(v_post_ok, false) THEN
    RAISE EXCEPTION 'MOS-WRITER-REVIEW: post_std did not end up design -> design_writer_review(writer) -> design_review';
  END IF;
  IF NOT COALESCE(v_video_ok, false) THEN
    RAISE EXCEPTION 'MOS-WRITER-REVIEW: video_std did not end up first_version -> writer_review(writer) -> review';
  END IF;
END $$;

COMMIT;
