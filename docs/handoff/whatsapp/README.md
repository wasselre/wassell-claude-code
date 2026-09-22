# WhatsApp system — handoff for another model (GPT, Codex, or a fresh Claude)

**Written:** 2026-09-22, from the code at commit `62fe2bcd` and the live `whatsapp_numbers` table.
**Audience:** an AI model or engineer who has never seen this repository and needs to understand,
operate, or extend how the Wassel CRM (`app.wassel.re`) sends and receives WhatsApp messages.
**Scope:** everything between a WhatsApp phone number and the CRM database: the gateway, the
relay, the webhook, the send queue, the number registry, the automatic senders (bots, alerts,
notifications), the AI agent runner, permissions, and the operating procedures.

This folder is a **map**, not a copy of the code. Every claim points at a file path relative to
the repository root. If a statement here disagrees with the code, the code wins. If you cannot
read the repository (for example, you were only given this folder), run `export-bundle.sh` from a
checkout to get a zip with the source files it references.

---

## Reading order

| # | File | Read it when you need to… |
|---|------|---------------------------|
| 0 | `README.md` (this file) | get the one-page picture and the invariants |
| 1 | `01-architecture.md` | follow a message end to end, inbound and outbound |
| 2 | `02-file-map.md` | find the exact file for any part of the system |
| 3 | `03-data-model.md` | know the tables, columns, RPCs, triggers, and settings rows |
| 4 | `04-senders-and-gates.md` | know who is allowed to send what, to whom, through which gate |
| 5 | `05-history-and-decisions.md` | understand why it is shaped this way (incidents and choices) |
| 6 | `06-operations-and-secrets.md` | run it: hosts, env var names per host, procedures, risks |
| 7 | `07-glossary.md` | decode LID, wid, ack, session, 463, 405, wt_/wf_/wm_ and friends |

Companion documents already in the repo (also linked from the file map):

- `docs/runbooks/whatsapp.md` — the production runbook (re-pairing, wedged gateway, stuck queue, rollback).
- `docs/waha-doha-gateway.md` — the gateway VM (note: its "engine NOWEB" line predates the 2026-07-29 switch to GOWS).
- `docs/ops-whatsapp-personal-style.md` — house rules for human-sounding messages from the operations number.
- `docs/prd/chats.md` — the product requirements for the Chats inbox UI (very long; search it).
- `docs/evaluations/2026-07-18-waha-vs-haberchat.md` — the evaluation that chose the gateway.

---

## The system on one page

```
                         ┌───────────────────────────────────────────────┐
                         │  WhatsApp phone numbers (company SIMs)        │
                         │   sales  +966556546238  (customers, default)  │
                         │   wassel_ops +966554620315 (operations line)  │
                         └───────────────▲───────────────────────────────┘
                                         │ paired as a "linked device" (8-char code)
                                         │
                ┌────────────────────────┴─────────────────────────┐
                │  WAHA gateway — Docker on a GCP VM in Doha        │
                │  one WAHA "session" per number, engine GOWS       │
                │  HTTPS via Caddy: https://34-18-15-250.sslip.io   │
                └───────▲───────────────────────────┬──────────────┘
      REST calls with   │                           │ webhook events, HMAC-SHA512 signed
      the WAHA API key  │                           │ (message.any, message.ack, session.status, …)
                        │                           ▼
   ┌────────────────────┴────────────┐     ┌──────────────────────────────────────────┐
   │ Fly app wassel-deck-worker      │     │ Vercel  POST /api/webhook/waha            │
   │ (5 machines)                    │     │  verify signature → dedupe → resolve      │
   │  • /waha/* reverse proxy  ◄─────┼──┐  │  phone → mirror media → write DB          │
   │  • drains scheduled_whatsapp_   │  │  └──────────────────┬───────────────────────┘
   │    jobs (paced per number)      │  │                     │
   │  • session + queue watchdogs    │  │                     ▼
   │  • notification + push lanes    │  │  ┌──────────────────────────────────────────┐
   └─────────────────────────────────┘  │  │ Supabase Postgres (system of record)      │
                                        │  │  chat_messages, records(chats),           │
   ┌─────────────────────────────────┐  │  │  whatsapp_numbers, scheduled_whatsapp_    │
   │ Vercel API (edge functions)     │──┘  │  jobs, whatsapp_ai_*, push_outbox, …      │
   │  /api/haberchat/messages (send) │     └──────────────────┬───────────────────────┘
   │  /api/whatsapp/* (bot, admin)   │                        │ Realtime
   └───────────▲─────────────────────┘                        ▼
               │ JWT                              ┌──────────────────────────┐
   ┌───────────┴─────────────┐                    │ Browser SPA (React)      │
   │ Fly app wassel-wa-agent │                    │ Chats inbox, Settings →  │
   │ ONE machine: headless   │                    │ WhatsApp numbers / AI /  │
   │ Claude Code session per │                    │ Permissions              │
   │ conversation (bot)      │                    └──────────────────────────┘
   └─────────────────────────┘
```

Direction of trust: the browser never holds a WhatsApp credential. Vercel functions hold the
webhook secret and the proxy secret. Only the Fly workers and the VM hold the WAHA API key.

---

## The ten invariants (do not break these)

1. **`chat_messages` in Postgres is the system of record.** The gateway's own store is a cache
   that can be empty or wiped (re-pair, disk loss) without losing anything the CRM knows.
2. **The WAHA webhook is the only routine writer of chat conversation records.** The browser
   reads. Copying gateway chat state over the CRM (status, list) destroyed closed-state and
   wiped the inbox once (2026-08-24). Never reintroduce it.
3. **A message's identity is the trailing HASH of its WhatsApp id, not the whole id.** The same
   message can be reported under phone addressing (`…@c.us`) or LID addressing (`…@lid`) by
   different gateways; dedupe and ack lookups use the hash (`chatIngest.messageIdHash`).
4. **Inbound acks are meaningless.** A delivery receipt applies only to messages we sent. The
   engine emits `-1/ERROR` on received messages; store `null`, never `failed`.
5. **A send is authorized against a conversation the caller can see under RLS, never against a
   raw phone number.** Starting a new conversation needs `create` on the chats model. Every
   attempt is audited with the phone masked.
6. **The sales line and the operations line are different numbers with different roles.**
   Customer traffic uses the `is_default` number; officer outreach and internal alerts use the
   `is_operations` number. The webhook keeps operations threads out of the sales funnel.
   Never silently fall back from one to the other.
7. **Scheduled, bulk, and bot sends go through `scheduled_whatsapp_jobs`.** WAHA has no
   server-side delivery time. The Fly worker drains the queue with a per-number budget.
8. **The bot's own sends must be audited in `whatsapp_ai_replies`,** or the gate's
   "a human is active on this chat" check mistakes the bot for a human and mutes itself.
9. **Media outlives the gateway.** Bytes are mirrored into the `wassel-files` bucket
   (`wm_` refs). A `wf_` ref pointing at the gateway disk is only as durable as that disk.
10. **Turning a number off is one row:** `whatsapp_numbers.is_active = false` stops both the
    queue and the session watchdog for that number. Use `/stop` on the gateway, never `/logout`.

---

## Plain-language summary

The company's WhatsApp numbers are logged in on a small server in Doha that runs an open-source
program called WAHA. That server is the "phone". Nobody types on it directly. The web app and the
robots hand messages to a relay on the Fly worker, which is the only thing allowed to talk to the
phone. Every message that arrives at the phone is copied into the company database within about a
second, so the database, not the phone, is the memory.

Before anything is sent, the system checks three things: is this person allowed to see the
conversation, are they allowed to start a new one, and are they sending too fast. Anything that
needs timing or pacing goes into a queue that sends gently, because WhatsApp bans numbers that
look like spam.

There are two lines. The sales number talks to customers. The operations number talks to project
officers, business contacts, and the owner (cost alerts). Robots that answer customers are gated
by a policy the admin controls in Settings, and a real Claude session can act as the sales agent
on a single dedicated machine so two robots never answer the same customer at once.
