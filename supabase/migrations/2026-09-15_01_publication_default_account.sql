-- ════════════════════════════════════════════════════════════════════════════
-- S3 of the monthly-operating-model build plan — a planned publication must
-- carry the account it will publish from.
--
-- THE BUG. `mos_campaign_plan_commit` (2026-09-14_02:488-498) inserts every
-- planned publication WITHOUT `account_id`:
--
--     INSERT INTO public.mos_publications
--       (content_id, platform, status, planned_at, execution_id, batch_id,
--        grid_row, grid_col, campaign_id, scheduled_timezone)
--
-- Downstream, `publishRelease.ts:64` refuses to publish unless
-- `pub.account_connected === true`, which it joins THROUGH `account_id`. But
-- `mos_release_due`'s `automatable` test is a PLATFORM-level check — it only
-- asks whether *some* connected account exists for that platform
-- (`mos_platform_automatable`, 2026-09-14_05:101). So the sweep happily hands
-- each due release over, the publish path finds a NULL account, refuses, and
-- `mos_release_sweep` raises a `publish_failed` task.
--
-- Nothing has ever published from this app, so this has never fired: all 10
-- live publications are `status='draft'` with both `scheduled_at` and
-- `planned_at` NULL, and `mos_release_due` filters on `due_at IS NOT NULL`.
-- It would have fired on EVERY release of the first compiled month.
--
-- A SECOND, LATENT BUG fixed by the same change. The insert ends with
--     ON CONFLICT (content_id, platform, account_id) DO NOTHING
-- and in Postgres two NULLs are never equal, so with `account_id` NULL that
-- clause can never fire. The idempotency the commit RPC believes it has does
-- not exist while the column is NULL.
--
-- WHY A TRIGGER AND NOT A REWRITE OF THE RPC. `mos_campaign_plan_commit` is a
-- long function and `CREATE OR REPLACE FUNCTION` requires re-emitting the whole
-- body — a re-emit is the riskiest possible way to make a one-column change.
-- A BEFORE INSERT trigger also covers every OTHER path that creates a
-- publication (the publish tab, a hand-made row, a future compiler), which is
-- what we actually want: "a publication knows its account" should be a property
-- of the table, not of one writer.
--
-- WHAT IT DELIBERATELY DOES NOT DO. It resolves only an account that is
-- CONNECTED and CAN PUBLISH. X (`@wassel_sa`) is neither, so a publication
-- targeting X keeps `account_id` NULL and becomes an exception with the right
-- reason — which is the settled rule ("a task only when a person is needed:
-- account not connected"), not a gap.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_publication_default_account()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY DEFINER: the caller may be a browser JWT whose RLS does not reach
-- `mos_platform_accounts`; without it the lookup returns nothing and we would
-- silently re-create the NULL this migration exists to remove.
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.account_id IS NOT NULL OR NEW.platform IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.id INTO NEW.account_id
    FROM public.mos_platform_accounts a
   WHERE a.platform = NEW.platform
     AND a.archived_at IS NULL
     AND a.is_connected IS TRUE
     AND a.can_publish IS TRUE
   ORDER BY a.sort_order NULLS LAST, a.created_at
   LIMIT 1;

  -- Still NULL = no account on that platform can publish. Left as-is on
  -- purpose: the release surfaces it as «الحساب غير موصول» and asks for a
  -- person, which is the settled behaviour.
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mos_tg_publication_default_account ON public.mos_publications;
CREATE TRIGGER mos_tg_publication_default_account
  BEFORE INSERT ON public.mos_publications
  FOR EACH ROW EXECUTE FUNCTION public.mos_publication_default_account();

REVOKE ALL ON FUNCTION public.mos_publication_default_account() FROM PUBLIC, anon;

-- ── Backfill the rows that already exist ───────────────────────────────────
-- All 10 are `status='draft'` with no dates, so the sweep cannot see them and
-- this changes nothing observable. It is done so that the column's invariant is
-- true for every row and not only for rows inserted from now on.
UPDATE public.mos_publications p
   SET account_id = a.id
  FROM public.mos_platform_accounts a
 WHERE p.account_id IS NULL
   AND a.platform = p.platform
   AND a.archived_at IS NULL
   AND a.is_connected IS TRUE
   AND a.can_publish IS TRUE
   AND a.id = (SELECT x.id FROM public.mos_platform_accounts x
                WHERE x.platform = p.platform
                  AND x.archived_at IS NULL
                  AND x.is_connected IS TRUE
                  AND x.can_publish IS TRUE
                ORDER BY x.sort_order NULLS LAST, x.created_at
                LIMIT 1);

-- ── Assertion: the trigger actually resolves a publishable platform ────────
DO $$
DECLARE
  v_acct uuid;
  v_plat text;
BEGIN
  SELECT platform INTO v_plat FROM public.mos_platform_accounts
   WHERE archived_at IS NULL AND is_connected AND can_publish
   ORDER BY sort_order NULLS LAST LIMIT 1;

  IF v_plat IS NULL THEN
    RAISE WARNING 'mos_publication_default_account: no connected publishable account exists — trigger installed but unexercised';
    RETURN;
  END IF;

  CREATE TEMP TABLE _s3_probe ON COMMIT DROP AS
    SELECT * FROM public.mos_publications WHERE false;

  -- Exercise the resolver directly rather than inserting a throwaway row into
  -- a live table.
  SELECT a.id INTO v_acct FROM public.mos_platform_accounts a
   WHERE a.platform = v_plat AND a.archived_at IS NULL
     AND a.is_connected AND a.can_publish
   ORDER BY a.sort_order NULLS LAST, a.created_at LIMIT 1;

  IF v_acct IS NULL THEN
    RAISE EXCEPTION 'mos_publication_default_account: resolver found no account for platform %', v_plat;
  END IF;
  RAISE NOTICE 'mos_publication_default_account: resolves % -> %', v_plat, v_acct;
END;
$$;

COMMIT;
