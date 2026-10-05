-- Riva lead-portal recipe: sign in reliably (2026-10-05).
--
-- ROOT CAUSE of Riva's intermittent "Step 6 (wait_for (input[wire\:model='name']))
-- … Timeout 30000ms exceeded" failures (7 runs 2026-09-27 → 2026-10-04, while
-- most runs passed): the login form is shown ~2 s after the page reports
-- loaded (Cloudflare's script runs first; measured 8/8 on Browserbase) and
-- sometimes much later. The recipe gave the "is there a login form?" check
-- only 5 s; when it ran out the run assumed it was already signed in, skipped
-- the login, and Riva bounced the new-client form back to the login page.
-- Browserbase's logs of the failed runs show exactly that: no typing, straight
-- from the login page to /broker/leads/create, then the login page again.
-- A simulation with the real engine against a fake slow portal reproduced the
-- production error word for word with the old recipe and passed with this one.
--
-- Changes (everything else in the recipe is unchanged):
--   1. Wait up to 30 s for the login form (returns as soon as it appears, so
--      a normal run is not slower).
--   2. Safety net after opening the form: if the portal sent us back to the
--      login page, sign in again and reopen the form; if it happens again,
--      stop with a clear "could not sign in to Riva" message.
--   3. Wait up to 45 s (was 30 s) for the redirect after signing in.
-- The old recipe is kept in _backup_riva_recipe_20261005.

CREATE TABLE IF NOT EXISTS public._backup_riva_recipe_20261005 AS
  SELECT id, data->>'recipe' AS recipe, now() AS backed_up_at
    FROM public.records
   WHERE id = 'ee417a12-9577-431e-b539-80497f39f527';
REVOKE ALL ON public._backup_riva_recipe_20261005 FROM anon, authenticated;

UPDATE public.records
   SET data = jsonb_set(data, '{recipe}', to_jsonb($riva$[
    {
        "ar": "تسجيل الدخول إلى بوابة ريفا",
        "do": "phase",
        "en": "Signing in to the Riva portal"
    },
    {
        "do": "goto",
        "url": "https://riva.sa/broker/login"
    },
    {
        "do": "if_visible",
        "selector": "input[name='email']",
        "timeout_ms": 30000,
        "then": [
            {
                "do": "fill",
                "selector": "input[name='email']",
                "value": "{{portal.login_email}}"
            },
            {
                "do": "fill",
                "selector": "input[name='password']",
                "value": "{{portal.login_password}}"
            },
            {
                "do": "click",
                "selector": "button[type='submit']"
            },
            {
                "do": "wait_for_url",
                "pattern": "**/broker",
                "timeout_ms": 45000
            }
        ]
    },
    {
        "ar": "فتح نموذج إرسال عميل جديد",
        "do": "phase",
        "en": "Opening the new-client form"
    },
    {
        "do": "goto",
        "url": "https://riva.sa/broker/leads/create"
    },
    {
        "do": "if_visible",
        "selector": "input[wire\\:model='name']",
        "timeout_ms": 30000,
        "else": [
            {
                "do": "if_visible",
                "selector": "input[name='email']",
                "timeout_ms": 5000,
                "then": [
                    {
                        "do": "fill",
                        "selector": "input[name='email']",
                        "value": "{{portal.login_email}}"
                    },
                    {
                        "do": "fill",
                        "selector": "input[name='password']",
                        "value": "{{portal.login_password}}"
                    },
                    {
                        "do": "click",
                        "selector": "button[type='submit']"
                    },
                    {
                        "do": "wait_for_url",
                        "pattern": "**/broker",
                        "timeout_ms": 45000
                    },
                    {
                        "do": "goto",
                        "url": "https://riva.sa/broker/leads/create"
                    }
                ]
            },
            {
                "do": "if_visible",
                "selector": "input[name='email']",
                "timeout_ms": 3000,
                "then": [
                    {
                        "do": "screenshot",
                        "full": true,
                        "label": "login-failed"
                    },
                    {
                        "do": "fail",
                        "ar": "تعذّر تسجيل الدخول إلى بوابة ريفا — أعادتنا البوابة إلى صفحة الدخول. تحقّق من البريد وكلمة المرور في بطاقة البوابة.",
                        "en": "Could not sign in to the Riva portal — it kept returning to the login page. Check the email and password on the portal record."
                    }
                ]
            },
            {
                "do": "wait_for",
                "selector": "input[wire\\:model='name']",
                "timeout_ms": 30000
            }
        ]
    },
    {
        "ar": "تعبئة بيانات العميل",
        "do": "phase",
        "en": "Filling the customer details"
    },
    {
        "do": "fill",
        "value": "{{lead.name}}",
        "selector": "input[wire\\:model='name']"
    },
    {
        "do": "type",
        "clear": true,
        "value": "{{lead.phone|ksa_short}}",
        "selector": "input[placeholder='5xxxxxxxx']"
    },
    {
        "do": "wait",
        "ms": 1200
    },
    {
        "do": "click",
        "text": "{{lead.project}}",
        "exact": true
    },
    {
        "do": "select",
        "value": "{{lead.property_type}}",
        "selector": "select[wire\\:model='property_type']"
    },
    {
        "do": "select",
        "value": "{{lead.purchase_type}}",
        "selector": "select[wire\\:model\\.live='PurchaseType']"
    },
    {
        "do": "wait",
        "ms": 1000
    },
    {
        "do": "select",
        "value": "{{lead.purpose}}",
        "selector": "select[wire\\:model='PurchasePurpose']"
    },
    {
        "do": "select",
        "value": "{{lead.support_type}}",
        "selector": "select[wire\\:model='support_type']"
    },
    {
        "do": "fill",
        "value": "{{lead.notes}}",
        "selector": "textarea[wire\\:model='message']"
    },
    {
        "do": "wait",
        "ms": 1500
    },
    {
        "do": "screenshot",
        "full": true,
        "label": "filled-form"
    },
    {
        "ar": "إرسال العميل إلى ريفا",
        "do": "phase",
        "en": "Submitting the client to Riva"
    },
    {
        "do": "if_visible",
        "text": "بالفعل",
        "then": [
            {
                "do": "click",
                "selector": "input[wire\\:model='name']"
            },
            {
                "do": "screenshot",
                "full": true,
                "label": "already-registered"
            },
            {
                "ar": "هذا العميل مسجّل بالفعل في بوابة ريفا — لا يمكن إرسال الطلب.",
                "do": "fail",
                "en": "This client is already registered in the Riva portal — the request cannot be sent.",
                "outcome": "already_registered"
            }
        ],
        "timeout_ms": 2500
    },
    {
        "do": "click",
        "name": "إرسال العميل",
        "role": "button"
    },
    {
        "do": "wait",
        "ms": 3000
    },
    {
        "do": "if_visible",
        "then": [
            {
                "do": "screenshot",
                "full": true,
                "label": "logged-out"
            },
            {
                "ar": "لم يُرسل العميل — عادت البوابة إلى صفحة تسجيل الدخول قبل تأكيد الإرسال. تحقّق من زر «إرسال العميل».",
                "do": "fail",
                "en": "The client was not submitted — the portal returned to the login page before confirming. Check the «إرسال العميل» button."
            }
        ],
        "selector": "input[name='email']",
        "timeout_ms": 5000
    },
    {
        "do": "if_visible",
        "then": [
            {
                "do": "click",
                "selector": "input[wire\\:model='name']"
            },
            {
                "do": "wait",
                "ms": 500
            },
            {
                "do": "screenshot",
                "full": true,
                "label": "after-submit"
            }
        ],
        "selector": "input[wire\\:model='name']",
        "timeout_ms": 1000
    },
    {
        "do": "wait_for",
        "state": "hidden",
        "selector": "input[wire\\:model='name']",
        "timeout_ms": 30000
    },
    {
        "do": "wait",
        "ms": 1500
    }
]$riva$::text))
 WHERE id = 'ee417a12-9577-431e-b539-80497f39f527';
