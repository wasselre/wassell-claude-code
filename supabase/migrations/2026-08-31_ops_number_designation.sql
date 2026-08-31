-- Operations-number designation for whatsapp_numbers.
--
-- Two roles now live on the overlay:
--   is_default    → the customer/sales line (default sender + runs the sales funnel)
--   is_operations → the line used for INTERNAL operational outreach (project officers)
--
-- Server senders resolve the ops line by this flag (resolveOperationsDeviceId),
-- and the WAHA webhook uses it to keep the sales funnel OFF ops-line threads.
--
-- Backward-compatible: adds a column with a false default; existing code that
-- never reads it is unaffected. Safe to apply before the code PR merges.

ALTER TABLE public.whatsapp_numbers
  ADD COLUMN IF NOT EXISTS is_operations boolean NOT NULL DEFAULT false;

-- Designate the already-paired ops session as the operations line.
UPDATE public.whatsapp_numbers
SET is_operations = true, updated_at = now()
WHERE device_id = 'wassel_ops';

-- A number should not be BOTH the sales default and the operations line.
-- Not a hard constraint (roles are operator-editable), but flag it if it ever happens.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.whatsapp_numbers WHERE is_default AND is_operations) THEN
    RAISE WARNING 'a whatsapp_numbers row is BOTH is_default and is_operations — sales and ops would collide on one line';
  END IF;
END $$;
