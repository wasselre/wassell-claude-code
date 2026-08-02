-- ════════════════════════════════════════════════════════════════════════════
-- W4 (bilingual REV 4 §E): server consumers speak the language contract.
--
-- Server-generated output was language-blind: every generated PDF hardcoded
-- Arabic, scheduled reports rendered English chrome regardless of audience,
-- and workflow push notifications picked message_ar first for every recipient.
-- This migration adds the three language carriers:
--
--   1. document_jobs.language        — requested render language for a generated
--                                      PDF; the enqueue endpoint passes the
--                                      caller's UI language.
--   2. scheduled_reports.language    — the report's delivery language.
--   3. users.preferred_language      — per-employee language; the SPA stamps it
--                                      on every language toggle, and the server
--                                      workflow runner picks each push
--                                      notification recipient's message side
--                                      from it (consumer ladder REV 4 §C1).
--
-- Additive only; all defaults are 'ar' (Arabic-first company). Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. document_jobs.language ──────────────────────────────────────────────

ALTER TABLE public.document_jobs
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'ar'
  CHECK (language IN ('ar','en'));

-- Enqueue gains p_language. The old 10-arg signature is DROPPED (not
-- overloaded) so PostgREST named-arg dispatch stays unambiguous; p_language
-- has a DEFAULT so a not-yet-redeployed endpoint calling without it keeps
-- working during rollout.
DROP FUNCTION IF EXISTS public.document_job_enqueue(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid);

CREATE OR REPLACE FUNCTION public.document_job_enqueue(
  p_source_record_id  uuid,
  p_source_model_id   uuid,
  p_template_id       uuid,
  p_template_file_id  uuid,
  p_target_folder_id  uuid,
  p_owner_user_id     uuid,
  p_owner_auth_uid    uuid,
  p_client_record_id  uuid,
  p_unit_record_id    uuid,
  p_project_record_id uuid,
  p_language          text DEFAULT 'ar'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_lang text := CASE WHEN p_language = 'en' THEN 'en' ELSE 'ar' END;
BEGIN
  INSERT INTO public.document_jobs (
    source_record_id, source_model_id, template_id, template_file_id,
    target_folder_id, owner_user_id, owner_auth_uid,
    client_record_id, unit_record_id, project_record_id, language
  )
  VALUES (
    p_source_record_id, p_source_model_id, p_template_id, p_template_file_id,
    p_target_folder_id, p_owner_user_id, p_owner_auth_uid,
    p_client_record_id, p_unit_record_id, p_project_record_id, v_lang
  )
  ON CONFLICT (source_record_id, template_id) WHERE status IN ('queued','running') DO NOTHING
  RETURNING id INTO v_id;

  -- A concurrent click already had an active job — return that one.
  IF v_id IS NULL THEN
    SELECT id INTO v_id
      FROM public.document_jobs
     WHERE source_record_id = p_source_record_id
       AND template_id = p_template_id
       AND status IN ('queued','running')
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.document_job_enqueue(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_job_enqueue(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text) TO service_role;

-- Claim returns the language (return-type change ⇒ DROP + CREATE).
DROP FUNCTION IF EXISTS public.document_job_claim_next(text);

CREATE FUNCTION public.document_job_claim_next(p_worker_id text)
RETURNS TABLE (
  job_id            uuid,
  source_record_id  uuid,
  source_model_id   uuid,
  template_id       uuid,
  template_file_id  uuid,
  target_folder_id  uuid,
  owner_user_id     uuid,
  owner_auth_uid    uuid,
  client_record_id  uuid,
  unit_record_id    uuid,
  project_record_id uuid,
  attempts          int,
  language          text,
  template_label_ar text,
  template_label_en text,
  content_json      jsonb,
  settings          jsonb
) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH claimed AS (
    UPDATE public.document_jobs j
       SET status     = 'running',
           worker_id  = p_worker_id,
           started_at = now(),
           attempts   = j.attempts + 1
     WHERE j.id = (
       SELECT id FROM public.document_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING j.id, j.source_record_id, j.source_model_id, j.template_id,
               j.template_file_id, j.target_folder_id, j.owner_user_id,
               j.owner_auth_uid, j.client_record_id, j.unit_record_id,
               j.project_record_id, j.attempts, j.language
  )
  SELECT c.id, c.source_record_id, c.source_model_id, c.template_id,
         c.template_file_id, c.target_folder_id, c.owner_user_id,
         c.owner_auth_uid, c.client_record_id, c.unit_record_id,
         c.project_record_id, c.attempts, c.language,
         dt.label_ar, dt.label_en,
         wd.content_json, wd.settings
    FROM claimed c
    JOIN public.document_templates dt ON dt.id = c.template_id
    JOIN public.wassel_documents   wd ON wd.file_id = dt.file_id;
$$;

REVOKE ALL ON FUNCTION public.document_job_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_job_claim_next(text) TO service_role;

-- ─── 2. scheduled_reports.language ──────────────────────────────────────────

ALTER TABLE public.scheduled_reports
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'ar'
  CHECK (language IN ('ar','en'));

-- ─── 3. users.preferred_language ────────────────────────────────────────────
-- NULL = never expressed a preference (server falls back to 'ar'). The SPA
-- stamps this on every header language toggle, so it converges to how each
-- employee actually uses the app.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS preferred_language text NULL
  CHECK (preferred_language IN ('ar','en'));
