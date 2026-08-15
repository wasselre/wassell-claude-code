-- 2026-08-14_chat_client_owner_mirror.sql
--
-- Goal: let the generic per-profile view-scope engine gate WhatsApp chats by
-- "a sales rep sees only chats linked to a client they own". The engine CANNOT
-- traverse a lookup (it only tests fields on a record's own JSONB), so we mirror
-- the linked client's owner onto each chat record as a read-only `client_owner`
-- assignee field. Then two admin-configurable scope conditions become expressible
-- in Settings -> Profiles -> chats, with ZERO engine changes:
--   * "only client-linked chats"  ->  client_link  is not empty
--   * "only my own clients"        ->  client_owner equals current user
--
-- client_owner holds the same value/shape as clients.client_owner: a public.users.id
-- stored as a JSON string (which is exactly what the scope engine's `current_user`
-- source resolves to). Two triggers keep it in sync, mirroring the all_projects
-- rollup pattern (BEFORE-fill on the target row + AFTER-touch on the source row).
--
-- Recursion safety: the client->chat sync touches chats with `SET data = data`,
-- which leaves last_message_at untouched, so the existing
-- records_touch_client_on_activity trigger early-returns for chats and there is NO
-- client<->chat ping-pong. (Verified against the live trigger definition.)
--
-- Messages: chat_messages + the whatsapp_ai_* sidecars already defer to the chats
-- view-scope class (wassell_chat_scope_class), so restricting the list restricts
-- message bodies and the live feed too -- nothing to change there.
--
-- This migration is migration-only (not seeded), matching how clients.client_owner
-- was itself added (2026-06-30_client_owner_sales_consultant_auto.sql).
--
-- No explicit BEGIN/COMMIT: the migration runner wraps the whole script in one
-- transaction. SET LOCAL (step 4) therefore scopes to that transaction.

-- 1. Add the mirrored `client_owner` field to the chats model schema (JSONB) so the
--    record form renders it (read-only) and the Settings scope editor lists it as a
--    filterable target. Idempotent via the NOT EXISTS guard.
UPDATE public.models
SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields') || jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', 'client_owner',
        'type', 'assignee',
        'label_ar', 'مستشار المبيعات',
        'label_en', 'Sales Consultant',
        'required', false,
        'read_only', true,
        'order', 13,
        'section_id', (schema->'sections'->0->>'id'),
        'width', 'half',
        'show_in_table', false,
        'assignee_role_ids', '[]'::jsonb
      )
    )
WHERE name = 'chats'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(schema->'sections'->0->'fields') f
    WHERE f->>'name' = 'client_owner'
  );

-- 2. BEFORE-fill on the chat row: pull the linked client's client_owner onto the chat.
--    SECURITY DEFINER so it can read the client regardless of the writer's RLS
--    (the webhook writes chats as service_role; a rep-initiated save must still resolve).
CREATE OR REPLACE FUNCTION public.tg_records_fill_chat_client_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_chats   uuid := (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1);
  v_clients uuid := public._sales_clients_model_id();
  v_cid   text;
  v_uuid  uuid;
  v_owner text;
BEGIN
  IF NEW.model_id IS DISTINCT FROM v_chats THEN
    RETURN NEW;
  END IF;

  v_cid := public._link_client_id_of(NEW.data);
  IF v_cid IS NOT NULL THEN
    BEGIN
      v_uuid := v_cid::uuid;
    EXCEPTION WHEN others THEN
      v_uuid := NULL;
    END;
    IF v_uuid IS NOT NULL THEN
      SELECT CASE
               WHEN jsonb_typeof(c.data->'client_owner') = 'array'
                 THEN nullif(c.data->'client_owner'->>0, '')
               ELSE nullif(c.data->>'client_owner', '')
             END
      INTO v_owner
      FROM public.records c
      WHERE c.id = v_uuid AND c.model_id = v_clients;
    END IF;
  END IF;

  IF v_owner IS NOT NULL THEN
    NEW.data := COALESCE(NEW.data, '{}'::jsonb) || jsonb_build_object('client_owner', v_owner);
  ELSE
    -- No linked client (advertisers / contacts / unknown numbers) or the client
    -- has no owner -> clear the mirror so those chats are excluded by the scope rule.
    NEW.data := COALESCE(NEW.data, '{}'::jsonb) - 'client_owner';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS records_fill_chat_client_owner ON public.records;
CREATE TRIGGER records_fill_chat_client_owner
  BEFORE INSERT OR UPDATE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.tg_records_fill_chat_client_owner();

-- 3. AFTER-sync on the client row: when a client's owner changes (or the client is
--    deleted), nudge every chat linked to it so its BEFORE-fill re-runs. The nudge is
--    `SET data = data` (last_message_at untouched) so records_touch_client_on_activity
--    early-returns -> no client<->chat recursion.
CREATE OR REPLACE FUNCTION public.tg_records_sync_chats_on_client_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_chats   uuid := (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1);
  v_clients uuid := public._sales_clients_model_id();
  v_cid text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.model_id IS DISTINCT FROM v_clients THEN RETURN OLD; END IF;
    v_cid := OLD.id::text;
  ELSE
    IF NEW.model_id IS DISTINCT FROM v_clients THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND (OLD.data->'client_owner') IS NOT DISTINCT FROM (NEW.data->'client_owner') THEN
      RETURN NEW;  -- owner unchanged: nothing to propagate (the common case)
    END IF;
    v_cid := NEW.id::text;
  END IF;

  IF v_chats IS NOT NULL AND v_cid IS NOT NULL THEN
    UPDATE public.records ch
    SET data = ch.data
    WHERE ch.model_id = v_chats
      AND public._link_client_id_of(ch.data) = v_cid;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

DROP TRIGGER IF EXISTS records_sync_chats_on_client_owner ON public.records;
CREATE TRIGGER records_sync_chats_on_client_owner
  AFTER INSERT OR UPDATE OR DELETE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.tg_records_sync_chats_on_client_owner();

-- 4. One-time backfill for existing chats. Touch every client-linked chat so the
--    BEFORE-fill stamps client_owner. wassell.system_write suppresses the translation
--    + workflow-event capture triggers (they honor this GUC); enqueue_push is
--    followups-only so it never fires for chats.
SET LOCAL wassell.system_write = 'chat_owner_backfill';

UPDATE public.records ch
SET data = ch.data
WHERE ch.model_id = (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1)
  AND public._link_client_id_of(ch.data) IS NOT NULL;
