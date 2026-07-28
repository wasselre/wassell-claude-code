-- ============================================================================
-- Content operations, part 2: artifacts, versioning, and workflow templates.
--
-- TWO PROBLEMS THIS FIXES
--
-- 1. "Writing" is a dropdown plus one universal textarea. A script, a caption,
--    a shot list, a subtitle file and a design file are not the same thing and
--    cannot all be typed into the same box — a design file is not text at all.
--    mkt_content_versions already has the right primitive (version_number,
--    version_type, payload, approval_state, is_locked, superseded_by); it is
--    missing a deliverable, an owner, a parent version, and a staleness flag,
--    and its version_type list is a closed 9-value CHECK.
--
-- 2. Every content item gets the SAME fixed 12 tasks. Verified in production:
--    both existing items carry write_brief → … → record_performance in the
--    same order, whether or not any of it applies. A text post does not need
--    filming; a raw asset does not need publishing.
--
-- Artifact types and workflow steps therefore become DATA, not CHECK lists, so
-- adding "subtitle file" or reordering a template is an insert rather than a
-- migration.
--
-- Idempotent. Non-destructive: no column or row is dropped.
-- ============================================================================
BEGIN;

-- ── 1. Artifact types as data ───────────────────────────────────────────────
-- editor_kind is what tells the UI which editor to render. Getting this wrong
-- is the current bug: a design file behind a textarea.
CREATE TABLE IF NOT EXISTS public.mkt_artifact_types (
  key         text PRIMARY KEY,
  label_ar    text NOT NULL,
  label_en    text NOT NULL,
  editor_kind text NOT NULL,
  hint_ar     text,
  hint_en     text,
  sort_order  integer NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  is_legacy   boolean NOT NULL DEFAULT false,
  CONSTRAINT mkt_atype_editor_check CHECK (editor_kind IN ('text','rich_text','list','file','link','media'))
);

INSERT INTO public.mkt_artifact_types (key, label_ar, label_en, editor_kind, hint_ar, hint_en, sort_order) VALUES
  ('creative_brief',  'الموجز الإبداعي', 'Creative brief',   'rich_text', 'الفكرة والرسالة والدليل', 'The idea, the message, the evidence', 10),
  ('script',          'النص',            'Script',           'rich_text', 'ما يُقال، مشهداً بمشهد',  'What is said, scene by scene', 20),
  ('voice_over',      'التعليق الصوتي',  'Voice-over',       'text',      NULL, NULL, 30),
  ('on_screen_text',  'النص على الشاشة', 'On-screen text',   'list',      NULL, NULL, 40),
  ('shot_list',       'قائمة اللقطات',   'Shot list',        'list',      NULL, NULL, 50),
  ('storyboard',      'اللوحة القصصية',  'Storyboard',       'file',      NULL, NULL, 60),
  ('carousel_outline','هيكل الشرائح',    'Carousel outline', 'list',      NULL, NULL, 70),
  ('slide_copy',      'نصوص الشرائح',    'Slide copy',       'rich_text', NULL, NULL, 80),
  ('headline',        'العنوان',         'Headline',         'text',      NULL, NULL, 90),
  ('caption',         'التعليق',         'Caption',          'rich_text', 'نص المنشور كما يُنشر', 'The post text exactly as published', 100),
  ('first_comment',   'التعليق الأول',   'First comment',    'text',      NULL, NULL, 110),
  ('thumbnail_copy',  'نص الصورة المصغّرة','Thumbnail copy', 'text',      NULL, NULL, 120),
  ('design_file',     'ملف التصميم',     'Design file',      'file',      'ارفع الملف أو اربط ملفاً موجوداً', 'Upload or link an existing file', 130),
  ('subtitle_file',   'ملف الترجمة',     'Subtitle file',    'file',      NULL, NULL, 140),
  ('final_media',     'المادة النهائية', 'Final media',      'media',     'الفيديو أو الصورة التي ستُنشر', 'The video or image that will publish', 150)
ON CONFLICT (key) DO UPDATE
  SET label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      editor_kind = EXCLUDED.editor_kind, sort_order = EXCLUDED.sort_order;

-- The nine values the old CHECK allowed. Kept so existing and historical rows
-- stay valid, flagged so the UI can retire them from the "add artifact" menu
-- without deleting anything that already points at them.
INSERT INTO public.mkt_artifact_types (key, label_ar, label_en, editor_kind, sort_order, is_active, is_legacy) VALUES
  ('brief',            'موجز (قديم)',           'Brief (legacy)',            'rich_text', 900, false, true),
  ('video_edit',       'مونتاج (قديم)',         'Video edit (legacy)',       'media',     910, false, true),
  ('post_design',      'تصميم منشور (قديم)',    'Post design (legacy)',      'file',      920, false, true),
  ('carousel_design',  'تصميم شرائح (قديم)',    'Carousel design (legacy)',  'file',      930, false, true),
  ('platform_variant', 'نسخة منصّة (قديم)',     'Platform variant (legacy)', 'rich_text', 940, false, true),
  ('final',            'نهائي (قديم)',          'Final (legacy)',            'media',     950, false, true),
  ('published',        'منشور (قديم)',          'Published (legacy)',        'media',     960, false, true)
ON CONFLICT (key) DO NOTHING;

-- ── 2. mkt_content_versions becomes the artifact-version table ──────────────
ALTER TABLE public.mkt_content_versions
  ADD COLUMN IF NOT EXISTS deliverable_id uuid REFERENCES public.mkt_content_deliverables(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_version_id uuid REFERENCES public.mkt_content_versions(id) ON DELETE SET NULL,
  -- Set when an upstream artifact this one was derived from changes. The
  -- alternative — carrying on as if an approved caption still matched a script
  -- that has since been rewritten — is how wrong copy gets published.
  ADD COLUMN IF NOT EXISTS is_stale boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stale_reason text,
  ADD COLUMN IF NOT EXISTS stale_since timestamptz,
  ADD COLUMN IF NOT EXISTS review_comment text;

-- Swap the closed CHECK for a reference to the types table, so a new artifact
-- type is an INSERT rather than a migration.
ALTER TABLE public.mkt_content_versions DROP CONSTRAINT IF EXISTS mkt_content_versions_version_type_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_cv_version_type_fk') THEN
    ALTER TABLE public.mkt_content_versions ADD CONSTRAINT mkt_cv_version_type_fk
      FOREIGN KEY (version_type) REFERENCES public.mkt_artifact_types(key) ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_cv_no_self_parent') THEN
    ALTER TABLE public.mkt_content_versions ADD CONSTRAINT mkt_cv_no_self_parent
      CHECK (parent_version_id IS NULL OR parent_version_id <> id) NOT VALID;
    ALTER TABLE public.mkt_content_versions VALIDATE CONSTRAINT mkt_cv_no_self_parent;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_cv_approved_has_approver') THEN
    ALTER TABLE public.mkt_content_versions ADD CONSTRAINT mkt_cv_approved_has_approver
      CHECK (approval_state <> 'approved' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)) NOT VALID;
    ALTER TABLE public.mkt_content_versions VALIDATE CONSTRAINT mkt_cv_approved_has_approver;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mkt_cv_deliverable ON public.mkt_content_versions(deliverable_id, version_type, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_cv_item_type ON public.mkt_content_versions(content_item_id, version_type, version_number DESC);

-- An artifact is identified by (deliverable | item, type); its versions are the
-- rows. Numbering per artifact, assigned by trigger so a script written by the
-- API, a backfill or a future importer numbers identically.
CREATE OR REPLACE FUNCTION public.mkt_tg_artifact_version_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.version_number IS NULL OR NEW.version_number = 0) THEN
    SELECT COALESCE(max(version_number), 0) + 1 INTO NEW.version_number
      FROM public.mkt_content_versions
     WHERE version_type = NEW.version_type
       AND ((NEW.deliverable_id IS NOT NULL AND deliverable_id = NEW.deliverable_id)
         OR (NEW.deliverable_id IS NULL AND deliverable_id IS NULL
             AND content_item_id = NEW.content_item_id));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_cv_number ON public.mkt_content_versions;
CREATE TRIGGER mkt_cv_number BEFORE INSERT ON public.mkt_content_versions
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_artifact_version_number();

-- ── 3. Approved versions are immutable ──────────────────────────────────────
-- Editing an approved artifact must create a NEW version. Without this the
-- approval means nothing: what was approved and what is live drift apart with
-- no record. The only fields that may still move on an approved row are the
-- ones that describe its RELATIONSHIP to later work — being superseded, or
-- being marked stale — never its content.
CREATE OR REPLACE FUNCTION public.mkt_tg_version_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF OLD.approval_state = 'approved' THEN
    IF NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.file_id IS DISTINCT FROM OLD.file_id
       OR NEW.version_type IS DISTINCT FROM OLD.version_type
       OR NEW.version_number IS DISTINCT FROM OLD.version_number
       OR NEW.content_item_id IS DISTINCT FROM OLD.content_item_id
       OR NEW.deliverable_id IS DISTINCT FROM OLD.deliverable_id THEN
      RAISE EXCEPTION
        'artifact % v% is approved and cannot be edited — create a new version instead',
        OLD.version_type, OLD.version_number USING ERRCODE='check_violation';
    END IF;
    -- Un-approving in place would erase the fact that it WAS approved.
    IF NEW.approval_state NOT IN ('approved','superseded') THEN
      RAISE EXCEPTION
        'artifact % v% is approved — supersede it with a new version rather than reverting its state',
        OLD.version_type, OLD.version_number USING ERRCODE='check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_cv_immutable ON public.mkt_content_versions;
CREATE TRIGGER mkt_cv_immutable BEFORE UPDATE ON public.mkt_content_versions
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_version_immutable();

-- ── 4. Approving supersedes the previous version, and staleness cascades ────
CREATE OR REPLACE FUNCTION public.mkt_tg_version_approved()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n int;
BEGIN
  IF NEW.approval_state <> 'approved'
     OR (TG_OP = 'UPDATE' AND OLD.approval_state = 'approved') THEN
    RETURN NULL;
  END IF;

  -- Exactly one approved version per artifact: retire the incumbent.
  UPDATE public.mkt_content_versions
     SET approval_state = 'superseded', superseded_by = NEW.id
   WHERE id <> NEW.id
     AND version_type = NEW.version_type
     AND approval_state = 'approved'
     AND ((NEW.deliverable_id IS NOT NULL AND deliverable_id = NEW.deliverable_id)
       OR (NEW.deliverable_id IS NULL AND deliverable_id IS NULL
           AND content_item_id = NEW.content_item_id));

  -- Anything derived from this artifact was approved against the OLD text.
  -- Flag it rather than silently continuing; a human decides whether the
  -- caption still fits the rewritten script.
  UPDATE public.mkt_content_versions
     SET is_stale = true,
         stale_since = COALESCE(stale_since, now()),
         stale_reason = COALESCE(stale_reason,
           format('upstream %s was replaced by v%s', NEW.version_type, NEW.version_number))
   WHERE parent_version_id IN (
           SELECT id FROM public.mkt_content_versions
            WHERE version_type = NEW.version_type AND id <> NEW.id
              AND ((NEW.deliverable_id IS NOT NULL AND deliverable_id = NEW.deliverable_id)
                OR (NEW.deliverable_id IS NULL AND deliverable_id IS NULL
                    AND content_item_id = NEW.content_item_id)))
     AND approval_state = 'approved' AND NOT is_stale;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE NOTICE '% downstream artifact(s) marked stale by %  v%', n, NEW.version_type, NEW.version_number;
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS mkt_cv_zz_approved ON public.mkt_content_versions;
CREATE TRIGGER mkt_cv_zz_approved AFTER INSERT OR UPDATE ON public.mkt_content_versions
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_version_approved();

-- The current approved version of one artifact, or NULL when there is none.
-- NULL means "not approved yet" — never a fabricated empty version.
CREATE OR REPLACE FUNCTION public.mkt_approved_artifact(p_deliverable_id uuid, p_type text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT id FROM public.mkt_content_versions
   WHERE deliverable_id = p_deliverable_id AND version_type = p_type
     AND approval_state = 'approved'
   ORDER BY version_number DESC LIMIT 1;
$$;

-- ── 5. Workflow templates as data ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_workflow_templates (
  key         text PRIMARY KEY,
  label_ar    text NOT NULL,
  label_en    text NOT NULL,
  -- The deliverable format this template is the default for. NULL = pick it
  -- manually. Unique so format → template stays a function.
  format      text,
  description text,
  is_active   boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_wft_format_unique
  ON public.mkt_workflow_templates(format) WHERE format IS NOT NULL AND is_active;

CREATE TABLE IF NOT EXISTS public.mkt_workflow_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key  text NOT NULL REFERENCES public.mkt_workflow_templates(key) ON DELETE CASCADE,
  step_key      text NOT NULL,
  sort_order    integer NOT NULL,
  label_ar      text NOT NULL,
  label_en      text NOT NULL,
  task_type     text NOT NULL,
  -- The artifact this step is supposed to produce, if any. This is what makes
  -- "required approved writing artifacts" answerable instead of a guess.
  artifact_type text REFERENCES public.mkt_artifact_types(key) ON UPDATE CASCADE,
  role_key      text,
  depends_on_step_key text,
  is_optional   boolean NOT NULL DEFAULT false,
  -- True when publishing must not happen until this step's artifact is approved.
  gates_publish boolean NOT NULL DEFAULT false,
  UNIQUE (template_key, step_key)
);
CREATE INDEX IF NOT EXISTS idx_mkt_wfs_template ON public.mkt_workflow_steps(template_key, sort_order);

INSERT INTO public.mkt_workflow_templates (key, label_ar, label_en, format, description) VALUES
  ('video',       'فيديو / ريلز',   'Reel / video',   'reel',           'Brief → script → shot list → filming → edit → review → caption → approval → publish'),
  ('carousel',    'كاروسيل',        'Carousel',       'carousel',       'Brief → structure → slide copy → design → review → caption → approval → publish'),
  ('static_post', 'منشور ثابت',     'Static post',    'static_image',   'Brief → copy → design → review → approval → publish'),
  ('text_post',   'منشور نصّي',     'Text post',      'text_post',      'Brief → copy → review → approval → publish'),
  ('raw_only',    'مادة خام فقط',   'Raw asset only', 'raw_asset_only', 'Capture → metadata → classification → library. No publishing.')
ON CONFLICT (key) DO UPDATE
  SET label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en,
      format = EXCLUDED.format, description = EXCLUDED.description;

-- Extra formats that share a template rather than duplicating its steps.
INSERT INTO public.mkt_workflow_templates (key, label_ar, label_en, format, description) VALUES
  ('short_video',   'فيديو قصير',  'Short video',   'short_video',     'Same spine as a reel'),
  ('long_video',    'فيديو طويل',  'Long-form video','long_form_video','Same spine as a reel, longer edit'),
  ('story',         'ستوري',       'Story',         'story',           'Light: copy → media → approval → publish'),
  ('paid_video',    'إعلان فيديو', 'Paid video ad', 'paid_video_ad',   'Video spine plus ad-set attachment'),
  ('paid_image',    'إعلان صورة',  'Paid image ad', 'paid_image_ad',   'Static spine plus ad-set attachment')
ON CONFLICT (key) DO NOTHING;

-- Steps. Deliberately different per template — that is the entire point.
DELETE FROM public.mkt_workflow_steps WHERE template_key IN
  ('video','carousel','static_post','text_post','raw_only','short_video','long_video','story','paid_video','paid_image');

INSERT INTO public.mkt_workflow_steps
  (template_key, step_key, sort_order, label_ar, label_en, task_type, artifact_type, role_key, depends_on_step_key, gates_publish) VALUES
  -- video
  ('video','brief',        10,'كتابة الموجز',       'Write brief',        'write_brief',          'creative_brief','writer',      NULL,          false),
  ('video','script',       20,'كتابة النص',         'Write script',       'write_script',         'script',        'scriptwriter','brief',       false),
  ('video','script_ok',    30,'اعتماد النص',        'Approve script',     'approve_script',       'script',        'approver',    'script',      false),
  ('video','shot_list',    40,'قائمة اللقطات',      'Shot list',          'prepare_assets',       'shot_list',     'videographer','script_ok',   false),
  ('video','filming',      50,'التصوير',            'Filming',            'record',               NULL,            'videographer','shot_list',   false),
  ('video','editing',      60,'المونتاج',           'Editing',            'edit_video',           'final_media',   'editor',      'filming',     true),
  ('video','review',       70,'المراجعة الداخلية',  'Internal review',    'review_video',         NULL,            'reviewer',    'editing',     false),
  ('video','caption',      80,'التعليق والغلاف',    'Caption & thumbnail','write_caption',        'caption',       'writer',      'review',      true),
  ('video','final_ok',     90,'الاعتماد النهائي',   'Final approval',     'approve_final',        NULL,            'approver',    'caption',     false),
  ('video','publish',     100,'النشر',              'Publishing',         'schedule_publication', NULL,            'publisher',   'final_ok',    false),
  -- carousel
  ('carousel','brief',     10,'كتابة الموجز',       'Write brief',        'write_brief',          'creative_brief','writer',      NULL,          false),
  ('carousel','structure', 20,'هيكل الشرائح',       'Slide structure',    'write_copy',           'carousel_outline','writer',    'brief',       false),
  ('carousel','slide_copy',30,'نصوص الشرائح',       'Slide copy',         'write_copy',           'slide_copy',    'writer',      'structure',   false),
  ('carousel','design',    40,'التصميم',            'Design',             'design_slides',        'design_file',   'designer',    'slide_copy',  true),
  ('carousel','review',    50,'المراجعة',           'Review',             'review_design',        NULL,            'reviewer',    'design',      false),
  ('carousel','caption',   60,'التعليق',            'Caption',            'write_caption',        'caption',       'writer',      'review',      true),
  ('carousel','final_ok',  70,'الاعتماد',           'Approval',           'approve_final',        NULL,            'approver',    'caption',     false),
  ('carousel','publish',   80,'النشر',              'Publishing',         'schedule_publication', NULL,            'publisher',   'final_ok',    false),
  -- static post
  ('static_post','brief',  10,'كتابة الموجز',       'Write brief',        'write_brief',          'creative_brief','writer',      NULL,          false),
  ('static_post','copy',   20,'كتابة النص',         'Copy',               'write_copy',           'caption',       'writer',      'brief',       true),
  ('static_post','design', 30,'التصميم',            'Design',             'design_slides',        'design_file',   'designer',    'copy',        true),
  ('static_post','review', 40,'المراجعة',           'Review',             'review_design',        NULL,            'reviewer',    'design',      false),
  ('static_post','final_ok',50,'الاعتماد',          'Approval',           'approve_final',        NULL,            'approver',    'review',      false),
  ('static_post','publish',60,'النشر',              'Publishing',         'schedule_publication', NULL,            'publisher',   'final_ok',    false),
  -- text post
  ('text_post','brief',    10,'كتابة الموجز',       'Write brief',        'write_brief',          'creative_brief','writer',      NULL,          false),
  ('text_post','copy',     20,'كتابة النص',         'Copy',               'write_copy',           'caption',       'writer',      'brief',       true),
  ('text_post','review',   30,'المراجعة',           'Review',             'review_design',        NULL,            'reviewer',    'copy',        false),
  ('text_post','final_ok', 40,'الاعتماد',           'Approval',           'approve_final',        NULL,            'approver',    'review',      false),
  ('text_post','publish',  50,'النشر',              'Publishing',         'schedule_publication', NULL,            'publisher',   'final_ok',    false),
  -- raw asset only: no publishing step at all
  ('raw_only','capture',   10,'التصوير أو الرفع',   'Capture / upload',   'prepare_assets',       NULL,            'photographer',NULL,          false),
  ('raw_only','metadata',  20,'البيانات الوصفية',   'Metadata',           'custom',               NULL,            'photographer','capture',     false),
  ('raw_only','classify',  30,'التصنيف',            'Classification',     'custom',               NULL,            'photographer','metadata',    false),
  ('raw_only','library',   40,'الإضافة للمكتبة',    'Add to library',     'custom',               NULL,            'photographer','classify',    false),
  -- story: light spine
  ('story','brief',        10,'كتابة الموجز',       'Write brief',        'write_brief',          'creative_brief','writer',      NULL,          false),
  ('story','media',        20,'المادة',             'Media',              'edit_video',           'final_media',   'editor',      'brief',       true),
  ('story','final_ok',     30,'الاعتماد',           'Approval',           'approve_final',        NULL,            'approver',    'media',       false),
  ('story','publish',      40,'النشر',              'Publishing',         'schedule_publication', NULL,            'publisher',   'final_ok',    false);

-- The three that reuse a spine verbatim.
INSERT INTO public.mkt_workflow_steps
  (template_key, step_key, sort_order, label_ar, label_en, task_type, artifact_type, role_key, depends_on_step_key, gates_publish)
SELECT t.key, s.step_key, s.sort_order, s.label_ar, s.label_en, s.task_type, s.artifact_type, s.role_key, s.depends_on_step_key, s.gates_publish
  FROM public.mkt_workflow_steps s
  CROSS JOIN (VALUES ('short_video'),('long_video'),('paid_video')) AS t(key)
 WHERE s.template_key = 'video';

INSERT INTO public.mkt_workflow_steps
  (template_key, step_key, sort_order, label_ar, label_en, task_type, artifact_type, role_key, depends_on_step_key, gates_publish)
SELECT 'paid_image', s.step_key, s.sort_order, s.label_ar, s.label_en, s.task_type, s.artifact_type, s.role_key, s.depends_on_step_key, s.gates_publish
  FROM public.mkt_workflow_steps s WHERE s.template_key = 'static_post';

-- ── 6. Tasks gain what a real task board needs ──────────────────────────────
ALTER TABLE public.mkt_content_tasks
  ADD COLUMN IF NOT EXISTS deliverable_id uuid REFERENCES public.mkt_content_deliverables(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS reviewer_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS attachment_file_id uuid,
  ADD COLUMN IF NOT EXISTS skipped_reason text,
  ADD COLUMN IF NOT EXISTS template_key text,
  ADD COLUMN IF NOT EXISTS step_key text,
  ADD COLUMN IF NOT EXISTS artifact_type text REFERENCES public.mkt_artifact_types(key) ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS idx_mkt_tasks_deliverable ON public.mkt_content_tasks(deliverable_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_mkt_tasks_assignee ON public.mkt_content_tasks(assigned_user_id)
  WHERE status NOT IN ('completed','cancelled');

-- One task per template step per deliverable, so regenerating is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_tasks_step_unique
  ON public.mkt_content_tasks(deliverable_id, step_key)
  WHERE deliverable_id IS NOT NULL AND step_key IS NOT NULL;

-- Extend the status list: in_review / changes_requested / skipped are states
-- the current five cannot express. waiting_review is kept so the 24 existing
-- rows stay valid; the API writes in_review.
ALTER TABLE public.mkt_content_tasks DROP CONSTRAINT IF EXISTS mkt_content_tasks_status_check;
ALTER TABLE public.mkt_content_tasks ADD CONSTRAINT mkt_content_tasks_status_check
  CHECK (status IN ('not_started','in_progress','blocked','waiting_review','in_review',
                    'changes_requested','completed','skipped','cancelled'));

-- A skip must say why. A silently skipped step is indistinguishable from one
-- nobody noticed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_task_skip_needs_reason') THEN
    ALTER TABLE public.mkt_content_tasks ADD CONSTRAINT mkt_task_skip_needs_reason
      CHECK (status <> 'skipped' OR (skipped_reason IS NOT NULL AND btrim(skipped_reason) <> '')) NOT VALID;
    ALTER TABLE public.mkt_content_tasks VALIDATE CONSTRAINT mkt_task_skip_needs_reason;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mkt_task_blocked_needs_reason') THEN
    ALTER TABLE public.mkt_content_tasks ADD CONSTRAINT mkt_task_blocked_needs_reason
      CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL OR depends_on_task_id IS NOT NULL) NOT VALID;
    -- NOT validated: the 24 legacy rows are 'blocked' with neither. Part 4
    -- gives them a dependency; validating here would fail the migration, and
    -- inventing a reason for them would be worse.
  END IF;
END $$;

-- ── 7. Generate tasks from the deliverable's template ───────────────────────
-- Replaces the fixed 12. Returns how many were created.
CREATE OR REPLACE FUNCTION public.mkt_generate_deliverable_tasks(
  p_deliverable_id uuid,
  p_replace boolean DEFAULT false
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  d record; tkey text; s record; n int := 0;
  v_id uuid; v_map jsonb := '{}'::jsonb; v_dep uuid;
BEGIN
  SELECT * INTO d FROM public.mkt_content_deliverables WHERE id = p_deliverable_id;
  IF d IS NULL THEN RAISE EXCEPTION 'deliverable not found' USING ERRCODE='no_data_found'; END IF;

  tkey := COALESCE(d.workflow_template_key,
                   (SELECT key FROM public.mkt_workflow_templates
                     WHERE format = d.format AND is_active LIMIT 1));
  IF tkey IS NULL THEN
    RAISE EXCEPTION 'no workflow template for format "%" — pick one explicitly', d.format
      USING ERRCODE='no_data_found';
  END IF;

  -- Only ever removes tasks this generator created and that nobody has touched.
  -- Work already done is never discarded by a regenerate.
  IF p_replace THEN
    DELETE FROM public.mkt_content_tasks
     WHERE deliverable_id = p_deliverable_id
       AND step_key IS NOT NULL
       AND status = 'not_started'
       AND completed_at IS NULL;
  END IF;

  FOR s IN SELECT * FROM public.mkt_workflow_steps WHERE template_key = tkey ORDER BY sort_order LOOP
    v_dep := NULLIF(v_map ->> s.depends_on_step_key, '')::uuid;

    INSERT INTO public.mkt_content_tasks
      (title, task_type, content_item_id, deliverable_id, project_id, status, priority,
       sort_order, template_key, step_key, artifact_type, depends_on_task_id,
       assigned_user_id, created_by_user_id)
    VALUES
      (s.label_ar, s.task_type, d.content_item_id, p_deliverable_id,
       (SELECT project_id FROM public.mkt_content_items WHERE id = d.content_item_id),
       -- A step whose predecessor is not done starts blocked BY DEPENDENCY,
       -- which is a fact, not the invented "blocked" the legacy rows carry.
       CASE WHEN s.depends_on_step_key IS NULL THEN 'not_started' ELSE 'blocked' END,
       'normal', s.sort_order, tkey, s.step_key, s.artifact_type, v_dep,
       CASE WHEN s.role_key = 'owner' THEN d.owner_user_id ELSE NULL END,
       d.created_by_user_id)
    -- mkt_tasks_step_unique is PARTIAL, and ON CONFLICT can only infer a partial
    -- index when the inference clause repeats its predicate. Without the WHERE
    -- this raises 42P10 the first time it ever runs.
    ON CONFLICT (deliverable_id, step_key)
      WHERE deliverable_id IS NOT NULL AND step_key IS NOT NULL
      DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.mkt_content_tasks
       WHERE deliverable_id = p_deliverable_id AND step_key = s.step_key;
    ELSE
      n := n + 1;
    END IF;
    v_map := v_map || jsonb_build_object(s.step_key, v_id);
  END LOOP;

  UPDATE public.mkt_content_deliverables
     SET workflow_template_key = tkey, updated_at = now()
   WHERE id = p_deliverable_id AND workflow_template_key IS DISTINCT FROM tkey;

  RETURN n;
END $$;

-- Completing a task unblocks whatever was waiting only on it.
CREATE OR REPLACE FUNCTION public.mkt_tg_task_unblock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.status IN ('completed','skipped') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.mkt_content_tasks
       SET status = 'not_started', updated_at = now()
     WHERE depends_on_task_id = NEW.id AND status = 'blocked';
  END IF;
  IF NEW.status = 'completed' AND NEW.completed_at IS NULL THEN
    NEW.completed_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mkt_task_unblock ON public.mkt_content_tasks;
CREATE TRIGGER mkt_task_unblock BEFORE UPDATE ON public.mkt_content_tasks
  FOR EACH ROW EXECUTE FUNCTION public.mkt_tg_task_unblock();

-- ── 8. RLS on the new tables ────────────────────────────────────────────────
ALTER TABLE public.mkt_artifact_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_workflow_steps ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text; BEGIN
  -- Reference data: readable by anyone who can read marketing, writable only
  -- by whoever may already change content settings.
  FOREACH t IN ARRAY ARRAY['mkt_artifact_types','mkt_workflow_templates','mkt_workflow_steps'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write', t);
    EXECUTE format($f$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
                      USING (public.wassell_mkt_can('read'))$f$, t || '_read', t);
    EXECUTE format($f$CREATE POLICY %I ON public.%I FOR ALL TO authenticated
                      USING (public.wassell_mkt_can('write_content'))
                      WITH CHECK (public.wassell_mkt_can('write_content'))$f$, t || '_write', t);
  END LOOP;
END $$;

COMMIT;
