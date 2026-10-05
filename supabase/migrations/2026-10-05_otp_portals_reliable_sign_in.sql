-- Al Ramz + Safa lead-portal recipes: sign in reliably (2026-10-05).
--
-- Same root cause as Riva (2026-10-05_riva_recipe_reliable_sign_in.sql): the
-- sign-in was wrapped in an if_visible with only 6 s for the login form; a
-- slow page skipped the sign-in. Al Ramz's 2026-10-04 status check is the
-- proof: attempt 2 (after parking for the code) never asked for a code, read
-- the login page, and failed with "No row array at props.clients.data".
-- Safa 2026-10-01: «جاري الإرسال…» outlasted the 30 s wait for the code screen.
--
-- Changes: login form wait 6 s → 30 s; Safa code-screen wait 30 s → 60 s and
-- dashboard wait 30 s → 45 s; before reading the client list / opening the
-- form, a clear "sign-in did not complete" stop if the login page came back.
-- Old recipes: _backup_otp_portal_recipes_20261005.

UPDATE public.records
   SET data = data || jsonb_build_object('recipe', $rcp$[
    {
        "ar": "تسجيل الدخول إلى بوابة الرمز",
        "do": "phase",
        "en": "Signing in to the Al Ramz portal"
    },
    {
        "do": "goto",
        "url": "https://brokerportal.alramzre.com/user/login"
    },
    {
        "do": "if_visible",
        "then": [
            {
                "do": "type",
                "clear": true,
                "value": "{{portal.login_phone|ksa_short}}",
                "selector": "input[type='tel']"
            },
            {
                "do": "click",
                "text": "إرسال رمز التحقق"
            },
            {
                "do": "wait_for",
                "selector": "input.otp-input",
                "timeout_ms": 30000
            },
            {
                "do": "request_input",
                "key": "otp",
                "kind": "otp",
                "length": 6,
                "prompt_ar": "أدخل رمز التحقق المُرسل إلى رقم دخول بوابة الرمز",
                "prompt_en": "Enter the code sent to the Al Ramz sign-in phone",
                "timeout_s": 300
            },
            {
                "do": "fill_otp",
                "value": "{{input.otp}}",
                "selector": "input.otp-input"
            },
            {
                "do": "wait",
                "ms": 800
            },
            {
                "do": "click",
                "text": "تحقق",
                "exact": true
            },
            {
                "do": "wait_for",
                "state": "hidden",
                "selector": "input.otp-input",
                "timeout_ms": 30000
            }
        ],
        "selector": "input[type='tel']",
        "timeout_ms": 30000
    },
    {
        "ar": "فتح نموذج إضافة عميل",
        "do": "phase",
        "en": "Opening the add-client form"
    },
    {
        "do": "goto",
        "url": "https://brokerportal.alramzre.com/user/clients/create"
    },
    {
        "do": "if_visible",
        "selector": "#client-name",
        "timeout_ms": 30000,
        "else": [
            {
                "do": "if_visible",
                "selector": "input[type='tel']",
                "timeout_ms": 3000,
                "then": [
                    {
                        "do": "screenshot",
                        "full": true,
                        "label": "not-signed-in"
                    },
                    {
                        "do": "fail",
                        "ar": "لم يكتمل تسجيل الدخول إلى بوابة الرمز — ظهرت صفحة الدخول من جديد. أعد المحاولة؛ إن تكرر فتحقق من رقم الدخول ورمز التحقق.",
                        "en": "Sign-in to the Al Ramz portal did not complete — the login page came back. Retry; if it repeats, check the sign-in phone and the code."
                    }
                ]
            },
            {
                "do": "wait_for",
                "selector": "#client-name",
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
        "selector": "#client-name"
    },
    {
        "do": "type",
        "clear": true,
        "value": "{{lead.phone|ksa_short}}",
        "selector": "#client-phone"
    },
    {
        "do": "click",
        "text": "اختر الوقت"
    },
    {
        "do": "wait",
        "ms": 600
    },
    {
        "do": "click",
        "text": "مساءً",
        "exact": true
    },
    {
        "do": "wait",
        "ms": 300
    },
    {
        "do": "click",
        "text": "صباحاً",
        "exact": true
    },
    {
        "do": "wait",
        "ms": 300
    },
    {
        "do": "click",
        "selector": "#client-name"
    },
    {
        "do": "wait",
        "ms": 300
    },
    {
        "do": "select",
        "value": "{{lead.unit_type}}",
        "selector": "#client-unit-type"
    },
    {
        "do": "click",
        "text": "اختر المشاريع"
    },
    {
        "do": "wait",
        "ms": 600
    },
    {
        "do": "click",
        "text": "{{lead.project}}",
        "exact": true
    },
    {
        "do": "wait",
        "ms": 400
    },
    {
        "do": "click",
        "selector": "#client-notes"
    },
    {
        "do": "fill",
        "value": "{{lead.notes}}",
        "selector": "#client-notes"
    },
    {
        "do": "wait",
        "ms": 1000
    },
    {
        "do": "screenshot",
        "full": true,
        "label": "filled-form"
    },
    {
        "ar": "إرسال العميل إلى الرمز",
        "do": "phase",
        "en": "Submitting the client to Al Ramz"
    },
    {
        "do": "click",
        "text": "إرسال",
        "exact": true
    },
    {
        "do": "wait",
        "ms": 2500
    },
    {
        "do": "if_visible",
        "text": "مضاف من قبل وسيط آخر",
        "then": [
            {
                "do": "screenshot",
                "full": true,
                "label": "already-registered"
            },
            {
                "ar": "الرمز رفض التسجيل: هذا العميل مسجّل من قبل وسيط آخر.",
                "do": "fail",
                "en": "Al Ramz refused: this client is already registered by another broker.",
                "outcome": "already_registered"
            }
        ],
        "timeout_ms": 4000
    },
    {
        "do": "wait_for",
        "state": "hidden",
        "selector": "#client-name",
        "timeout_ms": 30000
    },
    {
        "do": "wait",
        "ms": 1500
    }
]$rcp$::text, 'status_recipe', $rcp$[{"ar":"تسجيل الدخول إلى بوابة الرمز","do":"phase","en":"Signing in to the Al Ramz portal"},{"do":"goto","url":"https://brokerportal.alramzre.com/user/login"},{"do":"if_visible","then":[{"do":"type","clear":true,"value":"{{portal.login_phone|ksa_short}}","selector":"input[type='tel']"},{"do":"click","text":"إرسال رمز التحقق"},{"do":"wait_for","selector":"input.otp-input","timeout_ms":30000},{"do":"request_input","key":"otp","kind":"otp","length":6,"prompt_ar":"أدخل رمز التحقق المُرسل إلى رقم دخول بوابة الرمز","prompt_en":"Enter the code sent to the Al Ramz sign-in phone","timeout_s":300},{"do":"fill_otp","value":"{{input.otp}}","selector":"input.otp-input"},{"do":"wait","ms":800},{"do":"click","text":"تحقق","exact":true},{"do":"wait_for","state":"hidden","selector":"input.otp-input","timeout_ms":30000}],"selector":"input[type='tel']","timeout_ms":30000},{"ar":"قراءة قائمة عملائنا في الرمز","do":"phase","en":"Reading our client list at Al Ramz"},{"do":"goto","url":"https://brokerportal.alramzre.com/user/clients"},{"do":"if_visible","selector":"input[type='tel']","timeout_ms":3000,"then":[{"do":"screenshot","full":true,"label":"not-signed-in"},{"do":"fail","ar":"لم يكتمل تسجيل الدخول إلى بوابة الرمز — ظهرت صفحة الدخول من جديد. أعد المحاولة؛ إن تكرر فتحقق من رقم الدخول ورمز التحقق.","en":"Sign-in to the Al Ramz portal did not complete — the login page came back. Retry; if it repeats, check the sign-in phone and the code."}]},{"do":"collect_rows","url":"https://brokerportal.alramzre.com/user/clients?page={{page}}","fields":{"ref":"id","name":"name","phone":"phone","status":"status"},"source":"inertia","rows_path":"props.clients.data","ref_prefix":"#","status_labels":{"New":"جديد","Won":"ربح","new":"جديد","won":"ربح","Lost":"خسارة","Open":"مفتوح","lost":"خسارة","open":"مفتوح","Qualified":"مؤهل","qualified":"مؤهل","Disqualified":"مرفوض","disqualified":"مرفوض"},"last_page_path":"props.clients.last_page"},{"do":"save_items","key":"projects","urls":["https://brokerportal.alramzre.com/user/projects?page={{page}}"],"optional":true,"max_pages":3,"item_selector":"#app"}]$rcp$::text)
 WHERE id = 'a0702e76-8617-402b-9ac9-5d7ed3c865ec';

UPDATE public.records
   SET data = data || jsonb_build_object('recipe', $rcp$[
    {
        "ar": "تسجيل الدخول إلى بوابة صفا (كسب)",
        "do": "phase",
        "en": "Signing in to the Safa (Kasb) portal"
    },
    {
        "do": "goto",
        "url": "https://broker.safainv.sa/"
    },
    {
        "do": "if_visible",
        "then": [
            {
                "do": "type",
                "clear": true,
                "value": "{{portal.login_phone|ksa_short}}",
                "selector": "input[name='phone']"
            },
            {
                "do": "click",
                "selector": "#submit"
            },
            {
                "do": "wait_for_url",
                "pattern": "**/login/otp",
                "timeout_ms": 60000
            },
            {
                "do": "request_input",
                "key": "otp",
                "kind": "otp",
                "length": 4,
                "prompt_ar": "أدخل رمز التحقق المُرسل إلى رقم دخول بوابة صفا",
                "prompt_en": "Enter the code sent to the Safa sign-in phone",
                "timeout_s": 300
            },
            {
                "do": "fill_otp",
                "value": "{{input.otp}}",
                "selector": ".otp__digit"
            },
            {
                "do": "wait",
                "ms": 600
            },
            {
                "do": "click",
                "optional": true,
                "selector": "#submit",
                "timeout_ms": 5000
            },
            {
                "do": "wait_for_url",
                "pattern": "**/dashboard",
                "timeout_ms": 45000
            }
        ],
        "selector": "input[name='phone']",
        "timeout_ms": 30000
    },
    {
        "do": "click",
        "text": "حسناً!",
        "optional": true,
        "timeout_ms": 5000
    },
    {
        "ar": "فتح نموذج فرصة جديدة",
        "do": "phase",
        "en": "Opening the new-opportunity form"
    },
    {
        "do": "goto",
        "url": "https://broker.safainv.sa/opportunities"
    },
    {
        "do": "if_visible",
        "selector": "input[name='phone']",
        "timeout_ms": 3000,
        "then": [
            {
                "do": "screenshot",
                "full": true,
                "label": "not-signed-in"
            },
            {
                "do": "fail",
                "ar": "لم يكتمل تسجيل الدخول إلى بوابة صفا — ظهرت صفحة الدخول من جديد. أعد المحاولة؛ إن تكرر فتحقق من رقم الدخول ورمز التحقق.",
                "en": "Sign-in to the Safa portal did not complete — the login page came back. Retry; if it repeats, check the sign-in phone and the code."
            }
        ]
    },
    {
        "do": "click",
        "text": "إنشاء فرصة جديدة"
    },
    {
        "do": "wait_for",
        "selector": "#create_opportunity input[name='customer_name']"
    },
    {
        "ar": "تعبئة بيانات العميل",
        "do": "phase",
        "en": "Filling the customer details"
    },
    {
        "do": "fill",
        "value": "{{lead.name}}",
        "selector": "#create_opportunity input[name='customer_name']"
    },
    {
        "do": "type",
        "clear": true,
        "value": "{{lead.phone|ksa_short}}",
        "selector": "#create_opportunity input[name='customer_phone']"
    },
    {
        "do": "select",
        "value": "{{lead.project}}",
        "selector": "#create_opportunity select[name='project_ids[]']"
    },
    {
        "do": "wait",
        "ms": 800
    },
    {
        "do": "fill",
        "value": "{{lead.notes}}",
        "selector": "#create_opportunity textarea"
    },
    {
        "do": "wait",
        "ms": 1000
    },
    {
        "do": "screenshot",
        "full": true,
        "label": "filled-form"
    },
    {
        "ar": "إرسال الفرصة إلى صفا",
        "do": "phase",
        "en": "Submitting the opportunity to Safa"
    },
    {
        "do": "click",
        "selector": "#create_opportunity button[type='submit']"
    },
    {
        "do": "wait_for",
        "state": "hidden",
        "selector": "#create_opportunity input[name='customer_name']",
        "timeout_ms": 30000
    },
    {
        "do": "wait",
        "ms": 1500
    }
]$rcp$::text, 'status_recipe', $rcp$[{"ar":"تسجيل الدخول إلى بوابة صفا (كسب)","do":"phase","en":"Signing in to the Safa (Kasb) portal"},{"do":"goto","url":"https://broker.safainv.sa/"},{"do":"if_visible","then":[{"do":"type","clear":true,"value":"{{portal.login_phone|ksa_short}}","selector":"input[name='phone']"},{"do":"click","selector":"#submit"},{"do":"wait_for_url","pattern":"**/login/otp","timeout_ms":60000},{"do":"request_input","key":"otp","kind":"otp","length":4,"prompt_ar":"أدخل رمز التحقق المُرسل إلى رقم دخول بوابة صفا","prompt_en":"Enter the code sent to the Safa sign-in phone","timeout_s":300},{"do":"fill_otp","value":"{{input.otp}}","selector":".otp__digit"},{"do":"wait","ms":600},{"do":"click","optional":true,"selector":"#submit","timeout_ms":5000},{"do":"wait_for_url","pattern":"**/dashboard","timeout_ms":45000}],"selector":"input[name='phone']","timeout_ms":30000},{"do":"click","text":"حسناً!","optional":true,"timeout_ms":5000},{"ar":"قراءة الفرص المحالة في صفا","do":"phase","en":"Reading our referred opportunities at Safa"},{"do":"goto","url":"https://broker.safainv.sa/opportunities"},{"do":"if_visible","selector":"input[name='phone']","timeout_ms":3000,"then":[{"do":"screenshot","full":true,"label":"not-signed-in"},{"do":"fail","ar":"لم يكتمل تسجيل الدخول إلى بوابة صفا — ظهرت صفحة الدخول من جديد. أعد المحاولة؛ إن تكرر فتحقق من رقم الدخول ورمز التحقق.","en":"Sign-in to the Safa portal did not complete — the login page came back. Retry; if it repeats, check the sign-in phone and the code."}]},{"do":"collect_rows","url":"https://broker.safainv.sa/opportunities?page={{page}}","fields":{"ref":"@id","name":".profile-name","phone":".profile-contact-item--ltr","status":".profile-card-head .badge","status_detail":".outcome-badge-label"},"source":"table","ref_prefix":"#","ref_pattern":"(\\d+)$","rows_selector":".detail-col"},{"ar":"حفظ وحدات المشاريع للتحديث الآلي","do":"phase","en":"Saving the project units for the automatic update"},{"do":"save_items","key":"units","urls":["https://broker.safainv.sa/project/properties/108?page={{page}}","https://broker.safainv.sa/project/properties/129?page={{page}}","https://broker.safainv.sa/project/properties/130?page={{page}}","https://broker.safainv.sa/project/properties/42?page={{page}}","https://broker.safainv.sa/project/properties/44?page={{page}}","https://broker.safainv.sa/project/properties/57?page={{page}}","https://broker.safainv.sa/project/properties/60?page={{page}}","https://broker.safainv.sa/project/properties/61?page={{page}}","https://broker.safainv.sa/project/properties/64?page={{page}}","https://broker.safainv.sa/project/properties/82?page={{page}}","https://broker.safainv.sa/project/properties/83?page={{page}}","https://broker.safainv.sa/project/properties/87?page={{page}}"],"optional":true,"max_pages":80,"item_selector":"div.unit_details"}]$rcp$::text)
 WHERE id = 'd2c8bfd8-5f37-4979-ad25-10709218d0df';

