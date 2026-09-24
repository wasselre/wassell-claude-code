# Lead-portal recipes — how a portal registration is automated

**Audience:** whoever adds or fixes a portal (an admin in the app, or Claude in a
session). **Engine:** `worker/src/portals/recipe.ts` (keep this file and that one
in sync). **PRD:** `docs/prd/lead-portal-registration.md`.

## What a portal record is

One record in the **Lead portals** model (Settings → Lead portals, or
`/model/lead_portals`). The record says *whose* portal it is and *how* to fill it:

| Field | Meaning |
|---|---|
| `name`, `login_url` | Shown to the rep; `{{portal.login_url}}` in the recipe. |
| `developer` / `marketer` / `officers` / `projects` | Who it covers. A project P offers this portal when P is in `projects`, OR one of `officers` covers P, OR `developer` = P's developer, OR `marketer` = P's marketer (in that priority). |
| `login_phone` | The broker (Wassel) phone the portal sends its OTP to. The rep can override it per run. |
| `login_email`, `login_password` | For portals that sign in that way. Leave empty for OTP-only portals. |
| `otp_channel` | `sms` / `whatsapp` / `email` / `none` — only a hint shown to the rep. |
| `required_fields` | JSON: which customer fields the portal form needs (see below). |
| `recipe` | JSON: the steps replayed in the browser (see below). |
| `is_active` | Inactive portals are never offered. |

## `required_fields`

A JSON array. Each entry becomes an input in the "Register in portal" modal,
prefilled from the client / project / the rep, editable before the run starts,
then available to the recipe as `{{lead.<key>}}`.

```json
[
  { "key": "name",  "label_ar": "اسم العميل", "label_en": "Customer name", "source": "client.client_name", "required": true },
  { "key": "phone", "label_ar": "رقم الجوال", "label_en": "Mobile", "type": "phone", "source": "client.phone_number", "required": true },
  { "key": "email", "label_ar": "البريد", "label_en": "Email", "type": "email", "required": false },
  { "key": "unit_type", "label_ar": "نوع الوحدة", "label_en": "Unit type", "type": "select", "required": true,
    "options": [ { "value": "apartment", "label_ar": "شقة", "label_en": "Apartment" }, { "value": "villa", "label_ar": "فيلا", "label_en": "Villa" } ] }
]
```

- `source` prefills the value: `client.<field slug>`, `project.<field slug>`,
  `user.name` / `user.email` / `user.phone` (the rep), or `literal:<text>`.
  A multiselect / multi-lookup source gives its FIRST value; a range
  (`budget`) gives `"800,000 - 1,000,000"`.
- `map` translates the resolved value (exact match) into the portal's wording —
  `{"apartment": "شقة", "villa": "فيلا"}`, or a CRM project name → the portal's
  spelling. `default` is used when nothing resolves. For a `select`, a value
  that matches no option (by value or label) is dropped, then `default` applies.
- `min_length` + `fallback_source`: when the prefilled value has fewer letters /
  digits than `min_length` (punctuation ignored, so "B.A.k" counts 3 and "-"
  counts 0), the value comes from `fallback_source` instead. A Saudi mobile in
  `+9665…` form is written as the local `05…`. Riva's name field uses
  `{"min_length":3,"fallback_source":"client.phone_number"}` because Riva
  rejects names under 3 characters and WhatsApp names are often "A" or "-".
- `hidden: true` keeps a field out of the modal — it is sent with its prefilled /
  `default` value. A hidden required field that resolves to nothing still blocks
  the run and the modal names it ("missing on the client record").
- `type`: `text` (default), `phone`, `email`, `number`, `select` (needs `options`), `textarea`.
- If the field is empty, the two defaults above (`name` + `phone`) are used.
- `lead.project_name` is always available even if not declared.

## `recipe`

A JSON array of steps, run in order in a real browser (Browserbase, Saudi IP).
Every string may contain templates: `{{lead.name}}`, `{{portal.login_phone|local}}`,
`{{input.otp}}`, `{{client.<slug>}}`, `{{project.<slug>}}`, `{{vars.x}}`.

**Filters** (chain with `|`): `local` (→ `05XXXXXXXX`), `ksa_short` (→ `5XXXXXXXX`,
for portals with a separate +966 selector), `intl` (→ `9665XXXXXXXX`),
`e164` (→ `+9665XXXXXXXX`), `digits`, `no_plus`, `upper`, `lower`, `trim`,
`first_word`, `rest_words`, `default:<text>`.

**Targets** — every step that touches an element takes ONE of: `selector` (CSS /
`xpath=` / Playwright), `text` (visible text, substring), `label` (form label),
`placeholder`, or `role` + `name`. Add `nth` to pick the N-th match (0-based) and
`exact: true` to match the whole text (so «يمام 1» cannot hit «يمام 15»).
Livewire/Alpine forms often have no `name`/`id`; target the binding attribute
with an escaped colon: `"selector": "input[wire\\:model='name']"`. Escape dots
in the attribute name too (`wire:model.live` → `select[wire\\:model\\.live='x']`);
an unescaped dot is parsed as a class and the step fails with a bare
`DOMException`.

| Step | Fields | What it does |
|---|---|---|
| `goto` | `url`, `wait?` (`load`/`domcontentloaded`/`networkidle`) | Navigate. |
| `fill` | target, `value`, `clear?` | Set an input's value. |
| `type` | target, `value`, `delay_ms?` | Type key by key (for inputs that ignore `fill`, e.g. masked phones). |
| `fill_otp` | target (matches the N boxes), `value` | Segmented OTP field: each box gets one character of `value`. If the selector matches a single input, the whole code is typed into it (auto-advance widgets). Target the digit boxes precisely (e.g. `.otp__digit`) — a loose `input[type=text]` can also grab a hidden autofill helper and shift the digits. |
| `click` | target, `optional?` | Click. `optional: true` = skip silently if not found (cookie banners, "later" buttons). |
| `select` | target, `value` or `option_label` | Choose a `<select>` option. Works on a Select2-enhanced select too — setting the native value fires `change`, which Select2 mirrors into its display. |
| `check` | target, `checked?` | Tick a checkbox/radio. |
| `press` | `key`, target? | Press a key (`Enter`, `Tab`, …). |
| `wait` | `ms` | Sleep (max 60 s). |
| `wait_for` | target, `state?`, `timeout_ms?` | Wait until visible (or `hidden` / `attached`). |
| `wait_for_url` | `pattern` (glob, or `re:` regex) | Wait for navigation. |
| `request_input` | `key`, `prompt_ar`, `prompt_en`, `kind?` (`otp`/`text`), `length?`, `timeout_s?` | **Pause and ask the rep.** The modal shows the prompt + an input; the answer lands in `{{input.<key>}}`. Default wait 300 s. |
| `screenshot` | `label?`, `full?` | Save a screenshot to the run's evidence (`full: true` = the whole page, not just the viewport). |
| `assert` | target, `error_ar?`, `error_en?`, `timeout_ms?` | Fail the run with that message unless the element appears (use it to prove success). |
| `if_visible` | target, `timeout_ms?`, `then?: [...]`, `else?: [...]` | Branch (e.g. "already registered" dialog). |
| `phase` | `ar`, `en` | Progress label shown to the rep. |
| `fail` | `ar`, `en` | Stop with a message. |
| `set` | `key`, `value` | Store a value in `{{vars.key}}`. |

### Example — phone + OTP sign-in, then a lead form

```json
[
  { "do": "phase", "ar": "تسجيل الدخول للبوابة", "en": "Signing in" },
  { "do": "goto", "url": "{{portal.login_url}}" },
  { "do": "click", "text": "موافق", "optional": true },
  { "do": "fill", "selector": "input[name='mobile']", "value": "{{portal.login_phone|local}}" },
  { "do": "click", "role": "button", "name": "إرسال رمز التحقق" },
  { "do": "request_input", "key": "otp", "kind": "otp", "length": 4,
    "prompt_ar": "أدخل رمز التحقق الذي وصل إلى رقم الدخول", "prompt_en": "Enter the code sent to the sign-in phone" },
  { "do": "type", "selector": "input[name='otp']", "value": "{{input.otp}}" },
  { "do": "click", "text": "تأكيد" },
  { "do": "wait_for", "text": "تسجيل عميل جديد" },

  { "do": "phase", "ar": "تعبئة بيانات العميل", "en": "Filling the customer form" },
  { "do": "click", "text": "تسجيل عميل جديد" },
  { "do": "fill", "label": "اسم العميل", "value": "{{lead.name}}" },
  { "do": "fill", "label": "رقم الجوال", "value": "{{lead.phone|local}}" },
  { "do": "select", "label": "المشروع", "option_label": "{{lead.project_name}}" },
  { "do": "if_visible", "text": "العميل مسجل مسبقاً", "timeout_ms": 2000,
    "then": [ { "do": "fail", "ar": "هذا العميل مسجّل مسبقاً في البوابة", "en": "This client is already registered in the portal" } ] },
  { "do": "screenshot", "label": "before-submit" },
  { "do": "click", "role": "button", "name": "حفظ" },
  { "do": "assert", "text": "تم التسجيل بنجاح", "timeout_ms": 30000,
    "error_ar": "لم يظهر تأكيد التسجيل من البوابة", "error_en": "The portal did not confirm the registration" }
]
```

## Writing a recipe for a new portal

1. Open the portal in a normal browser, sign in once by hand, and note every
   field and button on the way (DevTools → copy a stable selector, or use the
   visible label/text).
2. Put the phone the OTP goes to in `login_phone` (or `login_email` / `login_password`
   for password portals).
3. Write the recipe; put a `request_input` step exactly where the portal asks
   for the code.
4. End with an `assert` on something that only appears after a successful
   registration — otherwise a silent portal error looks like success.
5. Test on a real client from a chat (Register in portal). Watch the live view;
   the failure screenshot tells you which step and what the page showed.

## Guarantees the engine gives

- **No secrets in recipes.** Reference `{{portal.login_password}}`; never paste a
  password into a step.
- **Nothing runs without the rep.** Every run is started by a person, on one
  client, and can be stopped from the modal (the browser closes within seconds).
- **A broken recipe fails before a browser is paid for.** Both the API and the
  worker parse the JSON first.
- **Evidence.** Each run keeps its screenshots (private bucket, signed URLs) and
  writes a `portal_lead_registered` activity-log line on the client.
