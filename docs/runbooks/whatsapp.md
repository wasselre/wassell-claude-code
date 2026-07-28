# WhatsApp — production runbook

Written 2026-07-28 alongside the WA-01…WA-31 repair work. Every procedure here
has been executed at least once against production.

## The shape of the system

```
browser ──▶ Vercel /api/haberchat/messages ──▶ WAHA_PROXY_URL
                                                  │
                                    wassel-deck-worker (bom, 5 machines)
                                       • /waha/* reverse proxy   ← HA
                                       • scheduled_whatsapp_jobs drain
                                       • queue + session watchdogs
                                                  │  plain HTTP :3000  ⚠ WA-05
                                          GCP Doha 34.18.15.250
                                          WAHA 2026.7.1 NOWEB
                                          sessions: sales, bridge
                                                  │
                     webhook (HTTPS + HMAC) ──▶ /api/webhook/waha ──▶ Supabase

wassel-wa-agent (bom, EXACTLY 1 machine) — the AI reply runner only.
  One machine is deliberate: a second would answer the same customer twice.
  It no longer carries the proxy, so its deploys no longer stop sending.
```

`chat_messages` is the system of record. The gateway supplements it and may be
empty without meaning anything is wrong.

## Re-pairing a number

1. Settings → WhatsApp numbers → the connection card drives it.
2. Pairing codes expire in ~2 min and the session then goes FAILED. The recipe
   that works: DELETE the session, recreate, wait for `SCAN_QR_CODE`, request the
   code, and have someone type it immediately.
3. **Afterwards, unlink the OLD device on the phone** (WhatsApp → Linked
   Devices). A leftover companion keeps reporting every message under its own
   addressing and burns a companion slot. Ingest is duplicate-safe since
   2026-07-27, but the webhook logs `events from UNREGISTERED session "<name>"`
   until it is gone.
4. History does NOT come back with a re-pair. Expected and harmless — the thread
   renders from our database, not the gateway.

## "The gateway is wedged"

Symptoms: sends 5xx, API slow, `context canceled` in GOWS.

    fly logs -a wassel-deck-worker | grep -i waha

The worker restarts a non-WORKING session by itself, once, fleet-wide (a
Postgres advisory lock — five machines cannot all restart it). Every restart is
in `activity_log` as `session_remediation`. If it is still wedged, restart the
container on the VM; the VM self-heals on boot via its startup script.

## Error 463 — cold-outreach lock

**Do not retry and do not restart the session.** 463 is WhatsApp refusing first
contact with a number we hold no token for, and each retry re-arms the lock.
Since 2026-07-28 the worker fails these once with a clear reason and surfaces a
failed bubble in the conversation.

Recovery: message that contact manually from the phone once (this seeds the
token), or wait for them to write first. Any inbound fixes the contact
permanently.

## Stuck queue

    select status, count(*) from scheduled_whatsapp_jobs group by 1;
    select public.scheduled_whatsapp_watchdog();
    select public.whatsapp_send_budget_remaining('sales');

A remaining budget of 0 means paced, not broken. A job in `unknown` MAY have
been delivered — reconcile against the gateway before resending. That state
exists precisely so nobody resends blindly.

## Unknown delivery state

    select id, chat_wid, error_message from scheduled_whatsapp_jobs where status='unknown';

Then check the gateway's own store for that chat before acting:
`GET /waha/api/sales/chats/<wid>/messages?limit=20`.

## Proxy outage

`WAHA_PROXY_URL` points at `wassel-deck-worker`. If it is unhealthy, repoint at
`wassel-wa-agent`, which still serves `/waha/*`:

    vercel link --yes --scope wassel1 --project prj_4ObF1mUW9KmmhFJDkoHCD0MZzJEh
    vercel env rm WAHA_PROXY_URL production --yes
    vercel env add WAHA_PROXY_URL production      # value on stdin, no newline

Env changes need a deployment to take effect.

**The project must be linked or every `vercel env` command fails silently**, and
`env ls | grep` returning nothing then reads exactly like the variable being
gone. Verify the change with `vercel env ls production | grep WAHA_PROXY_URL`
and check the age column.

## Secret rotation

The proxy host and Vercel must carry the SAME `WHATSAPP_AI_SECRET`. Read the
current value without printing it:

    fly ssh console -a wassel-wa-agent -C "printenv WHATSAPP_AI_SECRET"

Write it with a temp file piped to `fly secrets import` — plain piping appends a
newline and the comparison then fails. The two apps held DIFFERENT values until
2026-07-28; check both before assuming they match.

## Rate limiting / pacing

Per-number, in `whatsapp_send_budget` (default 40/min, 600/hour). Those defaults
come from this account's own peak — 379 messages/day, 65/hour — not from any
published WhatsApp figure, because none exists for an unofficial client. Tighten
a number after a 463 without a deploy:

    update whatsapp_send_budget set max_per_minute = 10 where device_id = 'sales';

## Rollback

Every WhatsApp change ships as its own commit and Vercel deployment. Roll back by
promoting the previous READY production deployment; Fly workers roll back with
`fly releases --app <app>` then `fly deploy --image <previous>`.

Database changes are in `supabase/migrations/2026-07-28_*`. Every data repair
wrote a backup table first: `_backup_lid_dupes_20260727`,
`_backup_lid_chat_records_20260727`, `_backup_corrupted_chat_20260728`.

## Known limitations

- **WA-05** — the hop from Fly to the Doha VM is plain HTTP on a publicly
  reachable port. Message bodies and the API key cross the internet in clear
  text. Needs TLS in front of WAHA and the firewall narrowed to Fly egress.
- **WA-25** — an unregistered `wassel_main` session was still linked as of
  2026-07-28. Host never identified; unlink it from the phone.
- Haberchat is retired and its account 403s every request. Attachments from
  before 2026-07-19 are unrecoverable and render as "older attachment
  unavailable".
- WAHA is an UNOFFICIAL client. Account bans are a real operational risk that no
  amount of pacing removes. The official WhatsApp Business Platform is the only
  structural fix and is a separate migration decision — it changes cost model,
  template approval, and 24-hour session-window rules, so it is a product
  decision as much as a technical one.
