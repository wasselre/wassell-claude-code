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
