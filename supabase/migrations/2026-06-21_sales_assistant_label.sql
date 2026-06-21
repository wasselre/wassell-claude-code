-- 2026-06-21: Phase 1.2 — reposition the deployed Project Matching Assistant as
-- the unified "Sales Assistant" (مساعد المبيعات).
--
-- The product is ONE Sales Assistant with multiple internal capabilities; project
-- matching is its first active capability. Future capabilities (next-best-action,
-- follow-ups, comparison) will expand this SAME assistant — there is no second
-- assistant face. Per the agreed "Option B", we do NOT rename the technical model
-- (`matching_chats`) or the /api/match endpoint to avoid destabilizing the live
-- deployment — only the user-facing label changes.
--
-- This updates the live prod row's labels (the frontend seed-backfill never
-- overwrites an existing system model, so the seedModels.ts change alone would
-- not move the prod label). Idempotent: re-runs are a no-op once applied.

UPDATE public.models
SET label_ar = 'مساعد المبيعات',
    label_en = 'Sales Assistant'
WHERE name = 'matching_chats'
  AND (label_ar IS DISTINCT FROM 'مساعد المبيعات' OR label_en IS DISTINCT FROM 'Sales Assistant');
