-- Guard: refuse schema-shrinking writes to system models from browser (JWT) sessions.
-- APPLIED LIVE 2026-08-20 (via MCP apply_migration `models_guard_block_schema_shrink`).
--
-- Root cause chain of the 2026-08-20 model-wipe incidents:
--   1. LATENT: initialize() in appStore backfilled "missing" SEED_MODELS on any
--      non-null models read. An RLS-scoped read that outruns the session token
--      returns an EMPTY ARRAY (not null, not an error), making every seed model
--      look missing -> the whole SEED_MODELS baseline was upserted.
--   2. ARMED 2026-08-18 (ca035cb3): seed model ids were pinned to the live ids.
--      Before that, the upserts inserted NEW random ids and died on the models
--      `name` UNIQUE constraint (harmless). After pinning, the same upserts MATCH
--      the live rows and OVERWRITE their schemas with the code baseline —
--      dropping every field added since the seed was written.
--   3. FIRED at least three times: between 08-18 and the 08-19 PRD sync
--      (units 48->9, followups 44->18, clients -12, visits 12->8, appointments
--      10->8, developers 6->5), again 08-20 06:42Z, and again 08-20 08:18Z —
--      the LAST one from a STALE TAB still running the pre-fix bundle, three
--      minutes after a restore. Client-side guards cannot stop stale bundles;
--      the database must defend itself. That is this trigger.
--
-- Behavior:
--   * service_role / no-JWT sessions (migrations, Fly workers, Claude MCP):
--     always allowed — schema surgery stays possible where it belongs.
--   * Browser (JWT) sessions: may grow or edit system-model schemas (inline
--     option adds keep working) but any UPDATE that REDUCES the field count of
--     an is_system model — the re-seed fingerprint — is refused loudly (P0001).
--
-- Intentional field REMOVALS on system models therefore go through migrations
-- (service role), which has been the standing practice since the Builder was
-- retired for system models.

CREATE OR REPLACE FUNCTION public.models_block_schema_shrink()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  jwt_role text;
  old_n int;
  new_n int;
BEGIN
  -- Resolve the caller's JWT role; NULL claims = direct DB / migration session.
  BEGIN
    jwt_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
  EXCEPTION WHEN OTHERS THEN
    jwt_role := NULL;
  END;
  IF jwt_role IS NULL OR jwt_role = 'service_role' THEN
    RETURN NEW;  -- trusted server-side writer
  END IF;

  IF COALESCE(NEW.is_system, false) THEN
    SELECT count(*) INTO old_n
    FROM jsonb_array_elements(COALESCE(OLD.schema, '{}'::jsonb)->'sections') s,
         jsonb_array_elements(COALESCE(s->'fields', '[]'::jsonb)) f;
    SELECT count(*) INTO new_n
    FROM jsonb_array_elements(COALESCE(NEW.schema, '{}'::jsonb)->'sections') s,
         jsonb_array_elements(COALESCE(s->'fields', '[]'::jsonb)) f;
    IF new_n < old_n THEN
      RAISE EXCEPTION 'models_guard: refusing schema shrink on system model "%" (% -> % fields) from a browser session. This is the re-seed wipe fingerprint. Intentional schema changes to system models go through migrations (service role).',
        NEW.name, old_n, new_n
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS models_guard_schema_shrink ON public.models;
CREATE TRIGGER models_guard_schema_shrink
  BEFORE UPDATE ON public.models
  FOR EACH ROW
  EXECUTE FUNCTION public.models_block_schema_shrink();
