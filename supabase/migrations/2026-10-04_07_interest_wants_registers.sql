-- "Said it suits me" is enough to register (operator, 2026-10-04: "yes suit me
-- is enough to register"). The message signal 'wants' (the outcome agent's
-- quote-checked reading: the customer said the project suits them / wants to
-- go ahead) now weighs 40 = the high-interest threshold, so on its own it
-- raises a high-interest event → automatic portal registration + an officer
-- draft for approval. At apply time 3 client × project pairs crossed (no rows
-- are written here; the 5-minute detector picks them up).
-- Weights stay DATA in ai_automation_settings.interest_weights.

UPDATE public.ai_automation_settings
   SET interest_weights = interest_weights || '{"wants": 40}'::jsonb,
       updated_at = now()
 WHERE id = 1;
