# 05 — History and decisions (why it is shaped this way)

Read this before changing anything that "looks odd". Almost every oddity is a scar.

## Timeline

| Date | Event | Consequence in the design |
|---|---|---|
| ≤ 2026-07-18 | WhatsApp ran through **Haberchat**, a hosted gateway (a Wassenger white-label). Browser proxies were named `api/haberchat/*`. | Route names, the `device_id` column name, and `HaberchatError` survive as historical names. |
| 2026-05-09 → 06-17 | Haberchat webhook blackout (a rotated device id orphaned the stored default). 91 conversations backfilled later. | "No device configured" usually means the registry row is stale, not the token. |
| 2026-07-18 | Evaluation WAHA vs Haberchat (`docs/evaluations/…`). Built the provider flag and our own scheduled-send queue because WAHA has no server-side delivery time. | `whatsapp_numbers.provider`, `scheduled_whatsapp_jobs`. |
| 2026-07-19 | **Haberchat subscription lapsed**; sending stopped; its history API returned 503 (history before this date is unrecoverable). Cut over to WAHA on Fly (fra) with engine GOWS, session `wassel_main`. Four silent bugs found by live testing: inbound identity is a LID; dedupe must key on event type; outbound payloads have `to: null`; a DB lookup on the hot proxy path hung the edge runtime. | The phone/LID ladder, `<type>:<id>` dedupe, chat id parsed from the message id, and timeouts around every DB lookup in the gateway layer. |
| 2026-07-21 | Activity bridge: outbound WhatsApp becomes visible to the follow-up engine. | `reconcile_*_whatsapp` RPCs called from the webhook. |
| 2026-07-22 | The queue had been silently dead since cutover: the worker lacked the WAHA secrets and logged "loop disabled" at boot. | Rule: when a worker drains a queue, check its boot log for the loop-enabled line. |
| 2026-07-23 | Root cause of chronic session drops diagnosed: the Fly host's **US-registered IP**. Proven by pairing instantly from a Saudi residential IP. WhatsApp's 463 cold-outreach lock documented. | Decision: host the gateway on a Gulf IP. |
| 2026-07-24 | Gateway moved to a **GCP VM in Doha**; session `sales` paired; Vercel repointed. | The current host. |
| 2026-07-26 | Inbound acks showed every customer message as "failed" (engine emits -1 on inbound). Re-pair flipped the account to LID-only addressing: 266 empty duplicate chats. Gateway-hosted media died with the old host (293 messages orphaned, later recovered from the old volume). WAHA refused Vercel's egress → proxy through the agent app. | Inbound ack → null; never auto-merge LID→phone; media mirrored to our bucket (`wm_`); the relay. |
| 2026-07-27 | A retired companion device (`wassel_main`) was still linked and reported every message a second time under LID addressing; delivery receipts landed on the copy nobody opened. | Message identity = trailing hash (`messageIdHash`, `message_hash` column); ack lookup by hash; unregistered-session warning; "after a re-pair, unlink the old device". Also: the agent's `$HOME` on a volume, orphan-sweep fix. |
| 2026-07-28 | The **WA-01…WA-31 audit** and repair day. Send authorization existed only as "has a JWT" (any account could message any number on earth) → `whatsappSendAuth`. One message, one row. Per-number budget. Fleet-wide remediation lock. `unknown` send state. Haberchat retired for good (adapter deleted, dead webhook refuses). Proxy moved from the single-machine agent to the five-machine worker. Runbook written. | Most of `04-senders-and-gates.md`. |
| 2026-07-29 | Sessions flapped STARTING → FAILED all night: WhatsApp refusing the **NOWEB engine** (reason 405), not credentials or IP. The watchdog restarted every 10 minutes forever and logged success; Baileys retried every 2 s (~23k rejected logins). | Engine → GOWS; watchdog verifies after restart, stops the session if not recovered, exponential backoff, one unrecoverable alert. Runbook: test the engine before touching the IP (an ephemeral IP change is irreversible). |
| 2026-08-01 | Notifications platform with a WhatsApp lane. | `notification_deliveries`, `notify_emit`. |
| 2026-08-14 / 08-18 | `client_owner` mirrored onto chats records; per-message owner push on inbound. | Cheap "own clients only" visibility; push to the right rep. |
| 2026-08-20 | iPhone PWA sends failed intermittently ("stolen key"): the Supabase auth lock. | Auth lock configuration in the SPA. |
| 2026-08-23 | Click-to-WhatsApp ad leads auto-onboard as clients from the opening message. | `meta.ad`, `mos_capture_ad_acquisition`. |
| 2026-08-24 | The browser's gateway mirror re-created every chat with no status on a raced empty store (inbox wipe) and re-opened every closed chat because WAHA has no "closed". Basic first-touch bot built from an analysis of the last 100 chats. | **Webhook is the only routine writer of chat records**; list load is a read. Bot exists. |
| 2026-08-31 | Operations number designated; Notify officer; owner alerts in-app (bell, toast, push prompt). | `is_operations`, sales/ops separation. |
| 2026-09-08 → 09-15 | Bot upgrades: full project package, named-project follow-ups classified before the gate, language match, unit-code → PDF on a dedicated render machine, the audit-row bug (bot muted itself for six hours because its sends were not recorded), QA fixes (greeting-prefix, repeat replies). | Rule: every bot send is audited; intro text before media. |
| 2026-09-21 | AI vendor balances are the truth; **cost alerts by WhatsApp** from the ops line to the owner. | `ai_alert_settings`, `ai_balance_alerts_evaluate()`. |

## Decisions and their reasons

- **Self-hosted unofficial client instead of the official WhatsApp Business Platform.** Chosen for
  cost, no template approval, no 24-hour window, and continuity after the vendor lapsed. The cost
  is real: WAHA is unofficial and bans are an operational risk that pacing reduces but cannot
  remove. Moving to the official platform is a product decision (cost model, templates, session
  windows), recorded as such in the runbook's "Known limitations".
- **Our own queue rather than the gateway's.** WAHA has no delivery time, no cancel, no pacing.
  The queue gives all three, plus retries, an unknown state, and a place for bots to write.
- **Database as the system of record, gateway as a cache.** WhatsApp hands history to a new
  linked device once, at pair time (about ten days of text), and never replays to an offline
  companion. Anything not captured by the webhook while it was live is gone; so the webhook must
  always be live and the DB must be what the UI renders.
- **The relay on the worker, not a firewall hole for Vercel.** Vercel's egress IPs are dynamic;
  the worker's are not, and it already held the secrets.
- **One machine for the AI agent, five for everything else.** A second agent machine would spawn
  a second Claude session for the same customer. Everything that is not the agent was moved off
  that machine so its singleton constraint stops being an availability ceiling.
- **Sales and operations on different SIMs.** So that internal traffic and cost alerts never
  appear in the inbox reps use with customers, and so officer conversations never trigger lead
  capture or the bot.
- **Hash identity, never content heuristics.** Content matching during the LID cleanup produced
  false positives (a chat mapped to our own number). Misattributing one client's messages to
  another is worse than a duplicate.
- **Bot audited by its own table, not by heuristics.** The gate's "a human is active" check is
  the only thing that stops the bot from talking over a rep; it can only work if the bot's sends
  are distinguishable from humans' — hence `whatsapp_ai_replies`.
- **Retired provider deleted, not kept as fallback.** A lookup timeout used to default to the old
  provider "for safety"; after retirement that default silently routed sends to a dead gateway
  for a minute at a time. Now an unknown provider fails loudly.
- **Turning a number off is a data change.** `is_active=false` gates the queue and the watchdog,
  so containment during an incident needs no deploy and no SSH.

## Lessons the next engineer should carry

- "It typechecks and deploys" proves nothing for a gateway swap. Only a real send AND a real
  inbound, checked in the database, prove the pipeline.
- Silent 200s are the failure mode here. Every incident above produced no error anywhere; the
  symptom was always "messages just vanished". Log loudly, write DLQ rows, fail visibly.
- Test the cheap reversible variable first (engine) before the expensive irreversible one (IP).
- Before blaming sync, run `select max(date) from chat_messages;` — hours old means the gateway
  is down, and messages typed on the phone while it is down are lost for good.
- A number that gets refused on registration cannot be re-paired; do not unlink anything until
  you know whether the host or the credentials are the problem (runbook has the one-step test).
