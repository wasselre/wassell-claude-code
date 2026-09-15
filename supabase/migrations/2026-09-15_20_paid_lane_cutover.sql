-- Group E — the paid lane. Three things, all additive and idempotent.
--
--   1. `mos_cutover_pause_manifest` — what the D2 cutover pause turned off, so
--      it can be turned back on. E1's script writes a row per ad BEFORE its
--      first Meta call. A log is not a manifest, and "re-runnable" means
--      re-pause, not undo.
--   2. `mos_month_template.min_spend_sar` becomes NULLABLE, meaning "derive
--      the gate from the standing budget" (E1c) — and the seeded row is set to
--      NULL, because the 150 it carries is the legacy number and nothing has
--      ever read it.
--   3. `mos_settings.planning.max_active_creatives` — the ceiling that stops
--      the live slate ratcheting upward (E1b).
--
-- Nothing here changes behaviour on its own: the manifest is empty until the
-- cutover script runs, and both settings are read only by the refresh lane.

BEGIN;

/* ── 1. the cutover manifest ─────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS public.mos_cutover_pause_manifest (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One run of the script. `--restore` names a run and undoes exactly it.
  run_id         text NOT NULL,
  -- 'ad'   → an ad row paused at Meta and in our tables
  -- 'slot' → a creative slot retired alongside its ad
  -- 'cycle'→ an open refresh cycle closed so automatic application cannot
  --          re-activate what the cutover just paused
  subject_kind   text NOT NULL CHECK (subject_kind IN ('ad', 'slot', 'cycle')),
  subject_id     uuid NOT NULL,
  execution_id   uuid,
  -- Meta's own id, and Meta's own view of the ad before we touched it. Both are
  -- recorded so a restore can tell "we paused it" from "it was already paused".
  platform_ad_id text,
  prior_status   text,
  prior_meta_status text,
  paused_at      timestamptz,
  restored_at    timestamptz,
  restore_run_id text,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- One manifest row per subject per run: the script is re-runnable, and a second
-- run must UPDATE what it already recorded rather than stack a second, later
-- snapshot on top of the state it has itself already changed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mos_cutover_manifest_run_subject
  ON public.mos_cutover_pause_manifest (run_id, subject_kind, subject_id);

CREATE INDEX IF NOT EXISTS idx_mos_cutover_manifest_open
  ON public.mos_cutover_pause_manifest (run_id)
  WHERE restored_at IS NULL;

COMMENT ON TABLE public.mos_cutover_pause_manifest IS
  'What the D2 paid cutover turned off, recorded BEFORE the first Meta call so it can be turned back on. Written only by scripts/cutover-pause-legacy-ads.mjs (service role).';

-- Service role only. The manifest is an operator artefact, not app data: no
-- browser session has any business reading or writing it, and RLS with no
-- policies is how this repo says exactly that.
ALTER TABLE public.mos_cutover_pause_manifest ENABLE ROW LEVEL SECURITY;

/* ── 2. the spend gate follows the budget (E1c) ──────────────────────────── */

ALTER TABLE public.mos_month_template
  ALTER COLUMN min_spend_sar DROP NOT NULL;

COMMENT ON COLUMN public.mos_month_template.min_spend_sar IS
  'Weekly spend gate for the paid ranking, in riyals. NULL = derive it from budget_per_project / campaign_length_days (deriveMinSpendSar), which is the normal state. A number here is an operator override.';

-- The seeded 150 is the legacy constant, calibrated against a campaign spending
-- ~691 SAR a week; the standing month buys ~467, where the same absolute gate
-- is a materially stricter rule. Only the untouched seed row is cleared — a row
-- somebody has edited keeps whatever they typed.
UPDATE public.mos_month_template
SET min_spend_sar = NULL
WHERE min_spend_sar = 150
  AND updated_at = created_at;

/* ── 3. the anti-ratchet ceiling (E1b) ───────────────────────────────────── */

-- Five new a week plus the at-most-two the §3.6 margin guard can keep.
-- Added only when absent, so an operator's number is never overwritten.
UPDATE public.mos_settings
SET value = value || jsonb_build_object('max_active_creatives', 7),
    updated_at = now()
WHERE key = 'planning'
  AND NOT (value ? 'max_active_creatives');

INSERT INTO public.mos_settings (key, value)
SELECT 'planning', jsonb_build_object('max_active_creatives', 7)
WHERE NOT EXISTS (SELECT 1 FROM public.mos_settings WHERE key = 'planning');

COMMIT;
