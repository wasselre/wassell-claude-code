-- Officer interest notices may be sent WITHOUT approval (operator, 2026-10-07),
-- once an AI-raised interest passes the rules in api/_lib/officerInterestGate.ts.
-- The switch the cron reads (api/cron/ai-sales-automation.ts step 3). Ships OFF;
-- turned on after the rules were tested against the last days' real events.
ALTER TABLE public.ai_automation_settings
  ADD COLUMN IF NOT EXISTS officer_notice_auto_send boolean NOT NULL DEFAULT false;
