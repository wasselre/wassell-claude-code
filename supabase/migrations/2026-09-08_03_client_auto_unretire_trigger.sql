-- Client retirement — Part 4: auto-un-retire on inbound WhatsApp.
--
-- A retired client is hidden until they contact us again. Every inbound
-- WhatsApp message (WAHA + Haberchat both) lands as a row in `chat_messages`
-- with flow='in' and from_phone = the client's number, so ONE AFTER-INSERT
-- trigger there catches every code path — no need to touch the webhook code.
--
-- It clears the retirement flag on any clients record whose canonical phone
-- matches the sender AND is currently retired. The `is_retired = true` guard
-- means a message from a NON-retired client does nothing (no needless version
-- bump / Realtime echo). SECURITY DEFINER so it can update the client row
-- regardless of who/what inserted the message (webhook = service role anyway).
--
-- clients is unfrozen, so a direct UPDATE to `records` is the correct write
-- (the records_block_frozen_writes trigger only guards frozen models). The
-- records_bump_version trigger bumps `version` and Realtime pushes the cleared
-- flag to the SPA. is_retired/retired_* are not translated fields, so the
-- translation capture trigger enqueues nothing.

CREATE OR REPLACE FUNCTION public.clients_auto_unretire_on_inbound()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clients_model_id uuid;
  v_canon text;
BEGIN
  IF NEW.flow IS DISTINCT FROM 'in' THEN
    RETURN NEW;
  END IF;
  v_canon := public.ksa_phone_canon(NEW.from_phone);
  IF v_canon IS NULL OR v_canon = '' THEN
    RETURN NEW;
  END IF;
  SELECT id INTO v_clients_model_id FROM public.models WHERE name = 'clients';
  IF v_clients_model_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.records r
  SET data = r.data || jsonb_build_object(
               'is_retired', false,
               'retired_at', NULL,
               'retired_reason', NULL
             )
  WHERE r.model_id = v_clients_model_id
    AND (r.data->>'is_retired')::boolean IS TRUE
    AND public.ksa_phone_canon(r.data->>'phone_number') = v_canon;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_messages_auto_unretire ON public.chat_messages;
CREATE TRIGGER chat_messages_auto_unretire
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  WHEN (NEW.flow = 'in')
  EXECUTE FUNCTION public.clients_auto_unretire_on_inbound();
