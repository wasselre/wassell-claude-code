# Operations WhatsApp — personal message style (LIVING standard)

**What this is:** the house rules for **personal WhatsApp messages sent from the
operations number** (رقم العمليات) — the human, one-to-one messages we send to
developers' relationship managers, project owners, and other business contacts.
Not the automated sales-agent replies, not templates. When Claude drafts or sends
one of these, it MUST follow this file.

**This is a LIVING standard.** Every operator note the user gives about how these
messages should read gets logged here and never re-asked. Append new rules as they
come; don't overwrite the reason a rule exists.

**Sender identity:** صالح الصليح — وصل العقارية. Always from the operations number
(NOT the sales number).

---

## HARD RULE — never send without explicit confirmation

**NEVER send any operations WhatsApp message until the user has seen the exact
text and explicitly said `SEND` (or `أرسل`).** Draft it, show the full message +
recipient + which number it goes from, and then STOP and wait. No exceptions,
no "I'll just send it," no treating a general instruction ("ask him X") as
permission to send — "ask him" means *draft it and show me*. Only the literal
word SEND / أرسل, said after seeing the text, authorizes sending. (Added
2026-09-07, standing instruction from the operator.)

---

## Rules

1. **Introduce yourself only ONCE per contact.** The first time we message a new
   contact, open with `معك صالح الصليح من وصل العقارية`. If we've messaged this
   person before and already introduced ourselves, **do NOT repeat the
   introduction** — they already know who we are. (Added 2026-09-07.)

2. **Greet by time of day, and address the person.** Use the greeting that matches
   the current Riyadh time, followed by `أستاذ [الاسم]`:
   - Morning → `صباح الخير أستاذ [name]`
   - Afternoon / evening → `مساء الخير أستاذ [name]`
   Then go straight to what you want. (Added 2026-09-07.)

3. **Get to the point; keep it short.** State the one thing you need clearly. Don't
   pad. (Added 2026-09-07.)

4. **Name products/projects precisely.** For a developer with several products
   (villas / floors / apartments), name the specific project or product type —
   don't lump them under one name (e.g. don't just say "ربوة"). (From the Rams
   file-request thread, 2026-09-06.)

5. **Ask for ONE consolidated update file**, not "each file separately" — the
   relationship manager already knows their projects. (From the Rams thread.)

6. **Don't thank for old files or reference prior internal work** (migrations,
   previous data pulls). Keep the ask forward-looking. (From the Rams thread.)

7. **Apologize politely when asking for a lot.** A short `معليش أتعبناك` /
   `آسف على الإزعاج` when the request is heavy. (From the Rams thread.)

8. **Office address for visit invitations: `حي النزهة، الرياض`.** When inviting
   anyone (job applicants, contacts) to the office, say the office is in حي
   النزهة. Do not guess another district. (Operator correction, 2026-09-07.)

9. **Job-applicant invitations** (from the طلبات التوظيف list): first name only
   after `أستاذ`, propose a specific 30-minute slot, and ask university students
   to send their university schedule so we can confirm they have time to work.
   Always close with the website line:
   `تقدر تتعرف على الشركة أكثر عن طريق زيارة موقعنا الإلكتروني` then
   `https://wassel.re/` on its own line. (Added 2026-09-07.)

10. **No contact name on file → greet without a name.** Write plain `مساء الخير` /
    `صباح الخير`; never leave a `[الاسم]` placeholder or guess. (Operator edit on the
    Riva data-request draft, 2026-09-07.)

11. **Colloquial present tense for "we are doing X":** `قاعدين نحدّث بيانات…`, not
    the formal `نحدّث`. (Same edit, 2026-09-07.)

12. **Don't say "في ملف واحد" in the ask.** Rule 5 means *don't* demand separate
    files; it does not mean spelling out "one file" — just list what's needed and
    let them choose the format. (Same edit, 2026-09-07.)

13. **Send mechanics (for Claude) — two proven paths:** (a) through the app,
    `POST https://app.wassel.re/api/haberchat/messages` with a user JWT (mint one via
    the admin `generate_link` + `verify` flow, revoke with `logout?scope=local` after)
    and body `{deviceId:'wassel_ops', phone, body, source:'new_chat'}` — a brand-new
    recipient needs `create` on the chats model (admins have it); (b) the Fly proxy
    runbook below. The operations number is WAHA session `wassel_ops`
    (+966554620315, `whatsapp_numbers.is_operations=true`). WAHA keys are Vercel-only,
    not in `.env.local`, and the WAHA host is unreachable from the laptop directly.

---

## Contact log (who we've already introduced ourselves to)

Used to decide whether rule 1 applies. Append as we open new relationships.

| Contact | Role | Channel | First introduced |
|---|---|---|---|
| عبدالعزيز المطلب | مسؤول مشاريع — الرمز (Rams) | operations number | 2026-09-06 |
| عبدالعزيز فهد محمد بجران | متقدم للتوظيف — مستشار مبيعات | operations number | 2026-09-07 |
| عبدالله خالد العوض | متقدم للتوظيف — مستشار مبيعات | operations number | 2026-09-07 |
| محمد فهد هذال ال هزاع | متقدم للتوظيف — مستشار مبيعات | operations number | 2026-09-07 |
| علي موسى التميمي | متقدم للتوظيف — مستشار مبيعات | operations number | 2026-09-07 |
| (no name on file) +966536400117 | مسؤول الوسطاء — ريفا العقارية | operations number | 2026-09-07 (data-request message; earlier ops messages existed on 2026-09-06/07) |
| تميم الشايع +966553732972 | مسؤول المشاريع — صفا للاستثمار | operations number | 2026-09-07 (data-request message; an ops thread with him already existed the same day) |

**Check the ops thread BEFORE writing the intro line (added 2026-09-07):** both messages
today re-introduced صالح although `chat_messages` already held earlier ops-number messages
with the same contact. Rule 1 is about the CONTACT, not this document's log — query
`chat_messages WHERE chat_wid='<phone>@c.us' AND device_id='wassel_ops'` first; if any
outbound exists, drop the introduction.

**Where contact numbers live (added 2026-09-07):** the `project_officers` model
(`/model/project_officers`, view `v_project_officers`: name, phone, developer,
marketer, projects). Look there FIRST before saying "no contact on file" — the Riva
officer was registered there under the name «ريفا» with no personal name.

---

## How to send from the operations number (Claude runbook)

The WAHA gateway (`WAHA_URL`, an sslip.io host on the Doha VM) is NOT reachable
from the laptop — direct calls time out. Send through the Fly proxy instead:
`POST <WAHA_PROXY_URL>/waha/api/sendText` with header
`x-wassel-proxy-secret: <WHATSAPP_AI_SECRET>` and body
`{ "session": "wassel_ops", "chatId": "<966…>@c.us", "text": "…" }`.
Both values come from Vercel production env (`vercel env pull` after
`vercel link --scope wassel1 --project wassell-claude-code`). Write the Arabic
to a UTF-8 `.mjs` file and run it with node — never inline Arabic in a shell
command. A 201 with `true_<phone>@c.us_<hash>` is accepted; the webhook mirrors
it into `chat_messages` (`device_id='wassel_ops'`, `flow='out'`) within seconds
and `ack` moves to `delivered`. (Proven 2026-09-07, four applicant invitations.)
The app-API path (rule 13a) was proven the same day for the Riva and Safa data requests.
