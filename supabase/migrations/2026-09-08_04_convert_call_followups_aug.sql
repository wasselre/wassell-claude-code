-- Client retirement — Part 5a: convert ACTIVE call follow-ups → WhatsApp.
--
-- The operator runs no sales team and does no phone calls. For clients acquired
-- 1 Aug 2026 onward (record created_at in KSA time), any ACTIVE call-type
-- follow-up is relabelled to a WhatsApp follow-up. "Active" = status open /
-- in_progress / scheduled / (null ⇒ open). Completed & cancelled call
-- follow-ups are HISTORY and left untouched — rewriting them would corrupt the
-- sales record + reconciliation.
--
-- followups is unfrozen; followup_type is a section_selector stored as a JSON
-- array, so the new value is '["whatsapp_follow_up"]'. Not a translated field.
-- Snapshot the pre-change rows first (reversible). Idempotent: re-running
-- matches nothing (rows are already whatsapp).

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_followup_call_to_wa_20260908 AS
SELECT r.id, r.data, now() AS backed_up_at
FROM public.records r
WHERE r.model_id = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63'
  AND r.data->>'client_id' IN (
    SELECT id::text FROM public.records
    WHERE model_id = '2e86f197-385f-4853-908f-b4cb7237f7d8'
      AND (created_at AT TIME ZONE 'Asia/Riyadh')::date >= '2026-08-01'
  )
  AND COALESCE(NULLIF(r.data->>'followup_status',''),'open') IN ('open','in_progress','scheduled')
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(r.data->'followup_type') = 'array' THEN r.data->'followup_type'
           ELSE jsonb_build_array(r.data->>'followup_type') END) e
    WHERE e IN ('appointment_confirmation_call','follow_up_call_after_visit','appointment_booking_call','no_show_recovery_call')
  );

UPDATE public.records r
SET data = jsonb_set(r.data, '{followup_type}', '["whatsapp_follow_up"]'::jsonb)
WHERE r.id IN (SELECT id FROM public._backup_followup_call_to_wa_20260908);

COMMIT;
