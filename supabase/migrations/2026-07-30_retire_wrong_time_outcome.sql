-- ============================================================================
-- Retire the `wrong_time` follow-up outcome — fold it into `recontact_later`.
--
-- WHY
--   The two outcomes were operationally identical: both REQUIRED
--   `reschedule_contact_date` and both fired the same `schedule_recontact`
--   action creating the same next follow-up. The only thing that differed
--   downstream was a client status string.
--
--   Reps did not split them consistently. In a 50-call audit of real completed
--   follow-ups (2026-07-30), «اتصل بي بعد نص ساعة، أنا في اجتماع» was filed as
--   `recontact_later` while «برجع لك» was filed as `wrong_time` — exactly
--   backwards from the definitions. 4 of 7 AI misclassifications in that audit
--   sat on this boundary; collapsing the pair lifted agreement with the human
--   label from 86% to 94% without changing a single downstream behaviour.
--
--   Going forward: client open but not now, for ANY reason → `recontact_later`,
--   and the rep picks the date. Client does not want contact at all →
--   `not_interested`.
--
-- WHAT THIS DOES
--   Every live workflow branch gated on `call_result = 'wrong_time'` is either
--   repointed to `recontact_later` or removed as a now-unreachable duplicate:
--
--     Confirmation Completed        wrong_time only  → REPOINT
--     Offer Follow-up Completed     wrong_time only  → REPOINT
--     After-Visit Completed         both             → DROP the wrong_time twin
--     Follow-ups - Booking Call     both             → DROP the wrong_time twin
--     WhatsApp Response Completed   both             → DROP the wrong_time twin
--
--   REPOINT rewrites the gate value AND the status the branch writes
--   («الوقت غير مناسب» → «إعادة تواصل لاحقًا»), so behaviour is preserved.
--   Without it, `recontact_later` on an appointment-confirmation or offer
--   follow-up would match NO branch — no status change, no next task, silently.
--   That is the actual risk this migration exists to prevent.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   • Does NOT delete `wrong_time` from the followups model's `call_result`
--     dropdown options — ~43 historical follow-ups store that value and the
--     record table / generic form need it to render a label. Same append-only
--     rule as OUTCOME_CATALOG in src/lib/salesProcess/outcomes.ts.
--   • Does NOT rewrite historical `call_result = 'wrong_time'` records. Those
--     are a faithful account of what the rep chose at the time; rewriting them
--     would corrupt the audit trail and re-fire outcome workflows.
--
--   Reps cannot select `wrong_time` any more because it was removed from every
--   type's `allowed_outcomes` in src/lib/salesProcess/config.ts. The dropped
--   branches are therefore unreachable: their `call_result` condition carries
--   `only_on_change: true`, so it fires only when the value BECOMES
--   `wrong_time`, which can no longer happen.
--
-- Snapshot of every touched row lands in _backup_workflows_wrong_time_20260730.
-- Idempotent: a second run finds no `wrong_time` branches and does nothing.
-- ============================================================================

BEGIN;

-- Snapshot + work plan in one table, so both UPDATEs below are driven off a
-- FROZEN classification. Deriving the plan inline would let the REPOINT pass
-- re-match rows the DROP pass had just changed.
CREATE TABLE IF NOT EXISTS public._backup_workflows_wrong_time_20260730 (
  workflow_id uuid PRIMARY KEY,
  label       text,
  plan        text NOT NULL,
  branches    jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public._backup_workflows_wrong_time_20260730 (workflow_id, label, plan, branches)
SELECT w.id,
       COALESCE(w.label_en, w.label_ar),
       CASE WHEN COALESCE(w.branches::text, '') LIKE '%recontact_later%'
            THEN 'drop_dead_twin' ELSE 'repoint' END,
       w.branches
FROM public.workflows w
WHERE COALESCE(w.branches::text, '') LIKE '%wrong_time%'
ON CONFLICT (workflow_id) DO NOTHING;

-- 1. Workflows that ALREADY have a recontact_later branch: the wrong_time twin
--    is now unreachable. Remove it so the branch list reflects reality.
UPDATE public.workflows w
SET branches = (
      SELECT COALESCE(jsonb_agg(b ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(w.branches) WITH ORDINALITY t(b, ord)
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(b->'conditions', '[]'::jsonb)) c
        WHERE c->>'field_id' = 'call_result' AND c->>'value' = 'wrong_time'
      )
    ),
    updated_at = now()
FROM public._backup_workflows_wrong_time_20260730 p
WHERE p.workflow_id = w.id
  AND p.plan = 'drop_dead_twin'
  AND COALESCE(w.branches::text, '') LIKE '%wrong_time%';

-- 2. Workflows with NO recontact_later branch: repoint the gate and the status
--    it writes. Replacement is on the exact quoted JSON scalars, so it cannot
--    touch a label that merely contains the phrase.
UPDATE public.workflows w
SET branches = (
      SELECT jsonb_agg(
               CASE WHEN b::text LIKE '%"wrong_time"%'
                    THEN replace(
                           replace(b::text, '"wrong_time"', '"recontact_later"'),
                           '"الوقت غير مناسب"', '"إعادة تواصل لاحقًا"'
                         )::jsonb
                    ELSE b END
               ORDER BY ord)
      FROM jsonb_array_elements(w.branches) WITH ORDINALITY t(b, ord)
    ),
    updated_at = now()
FROM public._backup_workflows_wrong_time_20260730 p
WHERE p.workflow_id = w.id
  AND p.plan = 'repoint'
  AND COALESCE(w.branches::text, '') LIKE '%wrong_time%';

COMMIT;
