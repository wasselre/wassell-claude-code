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
| `if_visible` | target, `timeout_ms?`, `then?: [...]`, `else?: [...]` | Branch (e.g. "already registered" dialog). Returns as soon as the target shows, so a long `timeout_ms` costs nothing when it does. **Only a timeout means "not visible"** — any other error (page closed, bad selector) fails the step (since 2026-10-05; before, every error silently took `else`). |
| `phase` | `ar`, `en` | Progress label shown to the rep. |
| `fail` | `ar`, `en`, optional `outcome` | Stop with a message. With `"outcome": "already_registered"` the run is NOT a failure: it ends as its own status `already_registered` (the portal answered that the client is another broker's) — sky-blue «مسجّل لدى وسيط آخر» on the chat card, an activity-log line on the client, «ℹ️» on the ops WhatsApp, no retry button. It is the only outcome so far (`RECIPE_OUTCOMES` in `recipe.ts`); an unknown value fails the step. |
| `collect_rows` | `url` (with `{{page}}`), `source`, `fields {ref,name,phone,status}`, optional `ref_prefix`, `status_labels`, `max_pages` (200). `source: "inertia"` + `rows_path` + `last_page_path` (fields = JSON keys); `source: "table"` + `rows_selector` (fields = CSS selectors inside a row; `@attr` = an attribute of the row, `sel@attr` = of a child; `status_detail` is appended as «status — detail»; `ref_pattern` = a regex with one capture group applied to the ref) | **Status checks only.** Reads the portal's own client list page by page. `inertia` reads the page's embedded JSON (`#app[data-page]`, Al Ramz); `table` reads a plain HTML table (Riva's Livewire «طلباتي») and walks `?page=1,2,…` until a page has no rows or repeats the last one. A row without a phone is dropped (empty-state rows). More pages than `max_pages` fails loudly — never a silent partial list. |
| `save_items` | `key`, `urls` (each with `{{page}}`), `item_selector`, optional `max_pages` (80), `optional` | Fetches each URL page by page **inside the signed-in page** (same cookies), keeps only the `outerHTML` of the items matching `item_selector`, and stores `{saved_at, pages}` as `portal-registrations/inventory/<portal record id>/<key>.json` (private, overwritten each run). Stops at a page with no items or one that repeats the last. Riding the daily status check lets ONE sign-in code a day also feed the automated project updates (`docs/prd/project-updates.md`). `optional: true` = a failure is logged and the recipe carries on — use it whenever the step rides on a status check. |
| `save_html` | optional `label` | Saves the current page's HTML to the private `portal-registrations` bucket next to the screenshots (logged, not shown in the chat card). For writing a recipe against pages that sit behind a sign-in code. |
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
    "then": [ { "do": "fail", "outcome": "already_registered", "ar": "هذا العميل مسجّل مسبقاً في البوابة", "en": "This client is already registered in the portal" } ] },
  { "do": "screenshot", "label": "before-submit" },
  { "do": "click", "role": "button", "name": "حفظ" },
  { "do": "assert", "text": "تم التسجيل بنجاح", "timeout_ms": 30000,
    "error_ar": "لم يظهر تأكيد التسجيل من البوابة", "error_en": "The portal did not confirm the registration" }
]
```

## `status_recipe` — the daily status check

A portal can also carry a **`status_recipe`** (same JSON language) and
**`status_sync_enabled: true`**. The status-check job (`portal_registration_jobs.kind =
'status_check'`, no client) replays it: sign in (copy the sign-in steps from `recipe` —
a code comes through the same operations-WhatsApp relay), then ONE `collect_rows`
step over the portal's client list. The rows go to `portal_status_sync_apply()`, which
matches them to our clients by canonical phone and refreshes each client's
«البوابات» row (portal status, portal ref), creating rows for clients found in the
portal but never recorded. It runs daily at 12:00 Riyadh (`/api/cron/portal-status-sync`)
and on «تحديث الحالات». Al Ramz example (its list is Laravel + Inertia):

```json
{ "do": "collect_rows", "url": "https://brokerportal.alramzre.com/user/clients?page={{page}}",
  "source": "inertia", "rows_path": "props.clients.data", "last_page_path": "props.clients.last_page",
  "fields": { "ref": "id", "name": "name", "phone": "phone", "status": "status" }, "ref_prefix": "#",
  "status_labels": { "new": "جديد", "open": "مفتوح", "qualified": "مؤهل", "disqualified": "مرفوض", "won": "ربح", "lost": "خسارة" } }
```

Riva example (a Livewire table, no code at sign-in — its check needs nobody):

```json
{ "do": "collect_rows", "url": "https://riva.sa/broker/leads?page={{page}}", "source": "table",
  "rows_selector": "table tbody tr",
  "fields": { "ref": "td:nth-child(1)", "name": "td:nth-child(2) > div:nth-child(1)",
              "phone": "td:nth-child(2) [dir='ltr']", "status": "td:nth-child(6) span" } }
```

Safa example — its opportunities are cards whose full details sit in hidden
`.detail-col` panels on the same page, so the "row" is the panel and the id is
read from its `id` attribute:

```json
{ "do": "collect_rows", "url": "https://broker.safainv.sa/opportunities?page={{page}}", "source": "table",
  "rows_selector": ".detail-col",
  "fields": { "ref": "@id", "name": ".profile-name", "phone": ".profile-contact-item--ltr",
              "status": ".profile-card-head .badge", "status_detail": ".outcome-badge-label" },
  "ref_pattern": "(\\d+)$", "ref_prefix": "#" }
```

A portal without a `status_recipe` is simply never checked; its portal status is
edited by hand on the client's tab.

## Writing a recipe for a new portal

1. Open the portal in a normal browser, sign in once by hand, and note every
   field and button on the way (DevTools → copy a stable selector, or use the
   visible label/text).
2. Put the phone the OTP goes to in `login_phone` (or `login_email` / `login_password`
   for password portals).
3. Write the recipe; put a `request_input` step exactly where the portal asks
   for the code.
4. **A run starts in a fresh browser — it is never already signed in.** Give the
   sign-in check a generous `timeout_ms` (Riva uses 30 000): the form can appear
   seconds after the page loads (Cloudflare's script runs first). A short check
   that runs out silently skips the sign-in, and the run then fails much later
   on the login page with a misleading "missing field" timeout — Riva's
   failures 2026-09-27 → 10-04 were exactly this. After opening the page you
   actually need, check for it and, if the portal sent you back to the login
   page, sign in again (see Riva's recipe).
5. End with an `assert` on something that only appears after a successful
   registration — otherwise a silent portal error looks like success.
6. Test on a real client from a chat (Register in portal). Watch the live view;
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


### `save_inertia` (added 2026-10-05)

For a Laravel + Inertia portal (Al Ramz). Saves the page JSON (`data-page`) of a
list page and of every listed record's detail page, inside the same signed-in
visit, to `portal-registrations/inventory/<portal record id>/<key>.json`.

```json
{ "do": "save_inertia", "key": "projects",
  "list_url": "https://brokerportal.alramzre.com/user/projects?page={{page}}",
  "detail_url": "https://brokerportal.alramzre.com/user/projects/{{id}}",
  "rows_path": "props.projects.data", "id_key": "id", "optional": true }
```

`rows_path` may be left out while exploring a portal: the first array of
objects carrying `id_key` under `props` is used and the path found is saved.
A page that answers with a login component fails the step (never saved as
data). Ceilings `max_pages` (10) and `max_details` (60) fail loudly.
