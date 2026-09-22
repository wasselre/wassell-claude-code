# 06 — Operations, hosts, and secret NAMES

This repository is public. **No secret value appears anywhere in it**; secrets travel encrypted
in `secrets/wassel-secrets.enc` (see `CLAUDE.md` → "Encrypted secrets bundle") and are set on each
host out of band. This file lists names and locations only.

## Hosts

| Host | What runs there | Holds |
|---|---|---|
| **GCP VM `wassel-waha`** (project `instant-medium-503214-f9`, zone `me-central1-a`, IP `34.18.15.250`, e2-medium) | Docker container `wassel-waha` (`devlikeapro/waha`), engine GOWS, sessions `sales` / `wassel_ops` (+ inactive `bridge`, `wassel_main`); Caddy TLS at `https://34-18-15-250.sslip.io`; startup script reinstalls Docker + WAHA on boot; session credentials on volume `waha_sessions → /app/.sessions` | `WAHA_API_KEY`, `WHATSAPP_DEFAULT_ENGINE=GOWS`, `WAHA_LOG_LEVEL`, media-folder settings; the per-session webhook config carries the HMAC key |
| **Vercel project `wassell-claude-code`** (`app.wassel.re`) | The SPA, all `api/**` edge functions (webhook, proxies, bot endpoints, admin session endpoint, cron) | `WAHA_URL`, `WAHA_API_KEY` (used only when no proxy), `WAHA_PROXY_URL`, `WAHA_WEBHOOK_SECRET`, `WHATSAPP_AI_SECRET`, `APP_URL` (optional), `WHATSAPP_SEND_RATE_WINDOW_MIN` / `WHATSAPP_SEND_RATE_MAX` (optional), `SUPABASE_URL` / `VITE_SUPABASE_URL`, anon key, `SUPABASE_SERVICE_ROLE_KEY` |
| **Fly app `wassel-deck-worker`** (five `app` machines + one `render` machine, process groups in `worker/fly.toml`) | `/waha/*` relay; queue drain; queue + session watchdogs; notification-delivery lane; push lane; unit-PDF render lane; balance probes + alert evaluation | `WAHA_URL`, `WAHA_API_KEY`, `WHATSAPP_AI_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, plus the non-WhatsApp worker secrets |
| **Fly app `wassel-wa-agent`** (exactly one machine, volume `wa_agent_state` at `/home/agent`) | The headless Claude Code reply runner; fallback `/waha/*` relay | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `WHATSAPP_AI_SECRET`, `APP_URL`, `WAHA_URL`, `WAHA_API_KEY`, `WA_SKILL` (default `whatsapp-basic-reply`) |
| **Supabase project `wassell-prod`** | Everything in `03-data-model.md`; Realtime to the SPA | `ai_alert_settings.whatsapp_to` (the owner's number, DB-only) |

Pairs that must match across hosts: `WHATSAPP_AI_SECRET` (Vercel ⇄ worker ⇄ agent — the relay
and the bot endpoints share it); `WAHA_WEBHOOK_SECRET` (Vercel ⇄ each session's webhook config on
the gateway); `WAHA_API_KEY` (gateway ⇄ worker ⇄ agent).

## Where each procedure is written

All procedures are in `docs/runbooks/whatsapp.md`, executed at least once against production:

- Re-pairing a number (Settings → WhatsApp numbers → connection card; then unlink the old device on the phone).
- "The gateway is wedged" (worker restarts it once fleet-wide; VM self-heals on reboot).
- Sessions flapping STARTING → FAILED (engine refusal; the one-step credentials-vs-host test; containment with `is_active=false` and `/stop`, never `/logout`).
- Error 463 (do not retry; message the contact from the phone once).
- Stuck queue / unknown delivery state (never resend blindly; check the gateway store first).
- Proxy outage (repoint `WAHA_PROXY_URL` to the agent; env changes need a deployment).
- Secret rotation (the relay secret must match on both apps; import via a temp file, no trailing newline).
- Rate limiting (`whatsapp_send_budget`, tighten without a deploy).
- Rollback (promote the previous Vercel deployment; `fly releases` + `fly deploy --image`).

## Quick health checks (SQL, read-only)

```sql
-- Is ingestion alive?  Hours old = gateway down.
select max(date) from chat_messages;

-- The registry: which numbers exist, which are on, which is default / operations.
select device_id, phone, is_default, is_operations, is_active from whatsapp_numbers;

-- Queue health and pacing headroom.
select status, count(*) from scheduled_whatsapp_jobs group by 1;
select public.whatsapp_send_budget_remaining('sales');

-- Bot policy and whether it would answer right now.
select * from whatsapp_ai_settings;

-- Recent webhook receipts and failures.
select created_at, status, details->>'event' from activity_log
 where category = 'webhook' order by created_at desc limit 20;
select * from haberchat_webhook_dlq order by created_at desc limit 10;
```

Gateway-side (with the API key): `GET /api/sessions?all=true` shows each session's status, `me`,
and its webhook config (including which HMAC key it signs with).

## Verifying a webhook fix without messaging a customer

Sign a crafted event yourself: HMAC-SHA512 hex over the raw body with the session's webhook key,
header `X-Webhook-Hmac`, `POST https://app.wassel.re/api/webhook/waha`. Cross-check the true
value first with `GET /api/{session}/chats/{chatId}/messages` so the replay writes truth and
sends nothing.

## Deploy discipline (repo-wide rules that bite here)

- Push to `main` = rebase then push; Vercel auto-deploys; confirm the deployment reached READY and
  smoke-test the live change (`CLAUDE.md` → "Worktree workflow").
- Fly deploys: `fly deploy worker --remote-only` (worker), `fly deploy` in `wa-agent/` (agent).
  Deploying the agent restarts the single machine; the queue and relay on the worker keep running.
- Migrations are applied to the live database in the same session they are written.
- Never raise SQLSTATE 40001/40P01 from a function (PostgREST retries forever).
- `worker/src/waha.ts` is a copy of the send half of `api/_lib/waha.ts`; change both.

## Known limitations and risks (as of 2026-09-22)

1. **Unofficial client.** A ban is possible regardless of pacing. The official WhatsApp Business
   Platform is the only structural fix and is a product decision.
2. **Port 3000 on the VM is reachable in plain HTTP** behind the API key (runbook item WA-05).
   TLS exists via Caddy; the firewall should be narrowed to 80/443 or to Fly egress.
3. **History cap.** WhatsApp gives a new linked device about ten days of history once. Older
   conversations that were never captured have no recoverable text; Haberchat-era attachments
   are unrecoverable.
4. **One companion device per number.** A forgotten old device doubles every message (ingest is
   duplicate-safe now, but it wastes a slot and pollutes logs).
5. **463 cold-outreach lock** on first contact with numbers we hold no token for; bulk retries
   make it worse.
6. **Groups, channels, broadcasts** are not supported for sending (reserved fields only).
7. **LID-only contacts** (phone unresolvable) are stored but cannot be matched to a client or
   answered by the bot until a phone appears.
8. **Bot media sends are unaudited**; the audited intro text before media is what keeps the gate
   honest. Removing it re-mutes the bot.
