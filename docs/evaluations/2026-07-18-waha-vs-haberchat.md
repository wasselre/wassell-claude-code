# Evaluation: Can WAHA replace HaberChat? (2026-07-18)

**Question:** Can [WAHA](https://github.com/devlikeapro/waha) (self-hosted WhatsApp HTTP API) reliably replace HaberChat (whitelabel of Wassenger, `api.haber.chat/v1`) as the WhatsApp gateway for the Wassell CRM?

**Verdict (short): Conditional yes — technically replaceable, not a drop-in.** Every HaberChat capability Wassell uses exists in WAHA's free Core image today **except server-side scheduled messages** (`deliverAt` + queue list/cancel), which would have to be built as a Wassell-owned queue. Reliability is the same *class* as HaberChat (unofficial WhatsApp Web automation: zombie sessions, at-least-once webhooks, ban risk) but the operational burden — watchdogs, restarts, monthly upgrades chasing WhatsApp protocol changes — moves in-house. Recommended path: parallel pilot on a disposable number, no production cutover until multi-week parity is proven. Full verdict at the bottom.

---

## 1. What HaberChat currently provides to Wassell (complete inventory)

Server wrapper: `api/_lib/haberchat.ts`. Proxies: `api/haberchat/{devices,chats,messages,scheduled,files}.ts` (+ `chats/[wid]`, `chats/[wid]/messages`, `files/[id]`). Webhook: `api/webhook/haberchat.ts`. Env: `HABERCHAT_TOKEN`, `HABERCHAT_DEFAULT_DEVICE_ID`, `HABERCHAT_WEBHOOK_SECRET`.

| Capability | HaberChat endpoint | Wassell consumers |
|---|---|---|
| Send text/media (+captions, quoted replies, idempotency `reference`) | `POST /messages` | Chats composer, StartChatModal, 3 workflow-engine impls (`workflowEngine.ts`, `workflowSweeper.ts`, `workflowRunner.ts` — `send_whatsapp_message` action), `api/send-document.ts`, `sendProjectImageMessages` (project/listing galleries + video ride-alongs) |
| **Scheduled sends + queue + cancel** | `POST /messages` w/ `deliverAt`; `GET /messages?status=queued`; `DELETE /messages/{id}` | `SchedulePopover` on EVERY send surface (composer, StartChatModal ×8 entry points, gallery stagger +10s, SendDocumentModal), scheduled-chips strip w/ cancel & cancel-all |
| File upload | `POST /files` | Composer, template editors, `projectMessageImages`, send-document |
| Media download (dual namespace: device-scoped w/ account-scoped 404-fallback) | `GET /chat/{d}/files/{id}/download`, `GET /files/{id}/download` | `MessageBubble` inline media via `fetchFileBlob` (JWT blob fetch) |
| Chat list sync | `GET /chat/{d}/chats` (paginate 200×10) | `loadChatsFromHaberchat` → `mergeChatIntoRecord` (forward-only recency; unread + preview are CRM-owned) |
| Per-chat history | `GET /chat/{d}/chats/{wid}/sync` (`before` cursor, **size ≥ 50 enforced upstream**) | Thread load + "Load older"; DB-mirror fallback on outage |
| Webhooks | `message:in:new`, `message:out:new`, `message:out:ack`, `chat:update`; secret via header/query | `chat_messages` upsert (never-downgrade ack via `ACK_ORDER`), `bumpConversationRecord` (unread++, auto-reopen + push-back, `last_message_*`), `mark_whatsapp_replied` v3 RPC (reply-gate + `client_messaged_at`), DLQ `haberchat_webhook_dlq`, Supabase Realtime fan-out |
| Chat status/labels | `PATCH /chat/{d}/chats/{wid}/status|labels` | Done/Reopen button, status pill, webhook auto-reopen push-back (Haberchat status is authoritative on next list sync) |
| Device management | `GET /devices` | `/settings/whatsapp-numbers`, `whatsapp_numbers` overlay (friendly name + default), boot-time `loadWhatsAppNumbers` |
| Unread seed | `chat.meta.unreadCount` | Only seeds never-tracked chats (unread is CRM-owned since 2026-07-17) |

Identity glue that MUST survive any migration: `CHATS_NAMESPACE` uuidv5 (chat wid → record id, duplicated in webhook + `src/lib/haberchat/normalize.ts`), `reference` echo for optimistic-send reconciliation, `deviceIdString` guard, KSA phone canonicalization (`ksa_phone_canon` SQL + `normalizePhone` TS). Downstream logic riding on the webhook: WA_ESCALATION `on_due` workflow, `whatsapp_state` machine (`message_sent_waiting_response`/`replied`/…), `reconcile_superseded_followups` trigger, sales-queue early-message indicator.

## 2. WAHA capability map (docs + source audit, July 2026)

- **Pricing changed 2026-06-22 (v2026.6.1): WAHA Plus merged into free Core.** Unlimited sessions, media send/receive, Postgres/S3 storage, API-key auth, health/metrics — all free. Only an optional $5/mo no-perks donation tier remains. ([blog](https://waha.devlike.pro/blog/waha-2026-6/))
- **Engines:** WEBJS (default; Chromium; most fragile to WhatsApp Web changes), NOWEB (Baileys fork; sunset-track, needs Store enabled for chats/history), **GOWS (Go/whatsmeow; designated NOWEB successor; best resource profile: ~0.1 CPU / 200 MB per session; fastest fixes)**. Chosen for the POC: **GOWS**.
- **Covers:** session lifecycle (create/start/stop/restart/logout, QR + pairing-code), sendText/Image/Video/Voice/File with captions + quoted replies, reactions/edit/delete, chats + overview + per-chat messages (limit/offset/timestamp filters), `message.ack` (PENDING/SERVER/DEVICE/READ/PLAYED), sendSeen/read, presence, labels APIs, `check-exists` phone validation, LID↔phone mapping, per-session webhooks w/ HMAC-SHA512 + retries (constant/linear/exponential) + custom headers, WebSocket alternative, `session.status` events.
- **Gaps:** ❌ **no scheduled sends / no queue / no cancel** (confirmed absent from send API); ❌ no chat "status" concept (active/resolved/archived is Wassenger CRM sugar — would become fully CRM-owned; archive-chat exists); ❌ no built-in dead-session liveness probe (`/health` = storage/DB only; `timestamps.activity` exists but has an open bug #2073); ⚠️ media files expire in **180 s by default** (`WHATSAPP_FILES_LIFETIME`); ⚠️ history depth engine/config-bound (GOWS deep-sync has OOM history, NOWEB ≈3mo default / ≈1yr fullSync, decided at QR time); ⚠️ monthly upgrade discipline required (WhatsApp Web breakage is routine).

## 3. GitHub issue-tracker reliability review (12–18 mo)

~1,714 issues lifetime, ~441 open, ~36 closed/mo in 2026; effectively single-maintainer; fast on core breakage (days–2 weeks, e.g. WhatsApp passkey enforcement 2026-06-30 → GOWS fix in 2026.7.1 within ~1 week), slow on periphery.

- **Silent webhook death with status WORKING** — open on all engines (#1931 NOWEB, #2151 GOWS, #2157 WEBJS). Restart is the universal cure. External watchdog on last-event age is mandatory.
- **Duplicate + missed webhooks** — open, cross-engine (#2031, #1050, #1384, #2148). At-least-once at best; idempotency-keying required (Wassell's upsert-by-id posture already does this).
- **Acks unreliable** — 201 ≠ delivered (#2118: async ack=-1; #2119: stuck at ack=0). Wassell's reply-checkpoint reconciliation pattern remains necessary.
- **History pulls flaky** — WEBJS 500s on old messages (#1805/#1885 open), GOWS group-history race (#1968 open). Keep the `chat_messages` mirror authoritative (already the architecture).
- **Media flakiest surface** — CDN 403s/expiry, hung retries, 0-byte S3 audio, the 32-bit `FILES_LIFETIME` overflow that silently wiped media (#2018). Download-on-webhook + own storage required.
- **Bans** — timelock/463 "most complained" (#2166 open); maintainer explicitly declines safe-config guarantees (#2068 closed not_planned). Same risk class as Haberchat; reply-driven traffic + warm numbers is the only mitigation.
- **GOWS growing pains** — libsignal panic can kill all sessions (#2100 open), OOM on pairing deep-sync (#1826 open), error-400 send lockups fixed without published root cause.

## 4. Proof of concept (live, executed 2026-07-18)

**Pinned version: `devlikeapro/waha:gows-2026.7.1` (engine GOWS, tier CORE)** — never `latest`. Hosting: disposable Fly.io app `waha-poc-wassell` (fra, shared-cpu-1x/1GB, 1 GB volume at `/data`) + webhook catcher `waha-poc-catcher` (records every delivery w/ timestamps, simulates outages). **No production config touched; no production number involved.** Config: `WHATSAPP_RESTART_ALL_SESSIONS=true`, `WHATSAPP_FILES_LIFETIME=0`, global + per-session webhooks (HMAC, exponential retries ×6), API key + dashboard auth. Secrets in the session scratchpad `waha-poc/waha/.poc-secrets.local`.

| # | Test | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | Deploy pinned image; `GET /api/version` | 2026.7.1 / GOWS | `{"version":"2026.7.1","engine":"GOWS","tier":"CORE"}` | ✅ |
| 2 | API key enforcement | 401 without key | `GET /api/sessions` → 401 | ✅ |
| 3 | Create session w/ per-session webhook (HMAC+retries) | 201, reaches SCAN_QR_CODE | STARTING → SCAN_QR_CODE in <1 s; config echoed | ✅ |
| 4 | QR retrieval (`/auth/qr?format=raw`) | QR value | raw pairing string returned | ✅ |
| 5 | Pairing-code flow (`/auth/request-code`) | code issued | `{"code":"ABZK-745W"}` (201) | ✅ |
| 6 | Webhook delivery + headers | events at catcher w/ HMAC | `session.status` delivered; `X-Webhook-Request-Id` (ULID), `X-Webhook-Timestamp`, `X-Webhook-Hmac`, UA `WAHA/2026.7.1`; payload carries stable `evt_…` id + status history | ✅ |
| 7 | Duplicate-delivery behavior | — | global env hook + per-session hook at same URL ⇒ **every event delivered 2×** (same event id, different request id). Dedupe on event/message id is mandatory | ✅ (documented) |
| 8 | Webhook retry on receiver 500 | retries w/ backoff, no loss | same request-id redelivered at ~2 s→4 s→8 s→17 s (exponential+jitter); all events eventually delivered after recovery; **zero loss** in outage window | ✅ |
| 9 | Multi-session in free Core | 2nd session allowed | `poc2` created + started | ✅ |
| 10 | Send on unpaired session | loud failure | 422 `{"error":"Session status is not as expected…","expected":["WORKING"]}` | ✅ |
| 11 | `/health` + `/ping` | storage/health JSON | disk checks on `/data/media` + `/data/sessions` w/ thresholds | ✅ |
| 12 | Container restart persistence | sessions survive + auto-restart | `fly machine restart` → both sessions present, auto-restarted to SCAN_QR_CODE (max reachable unpaired) | ✅ |
| 13 | Chats/history endpoints wired | routes exist | `GET /api/poc1/chats`, `…/messages` → clean 422 (session gate), routes live | ✅ |
| 14 | Scheduled sends | expected absent | **absent** — no `deliverAt`/schedule/cancel anywhere in the send API (docs + API surface) | ❌ gap confirmed |

### 4b. Message-level tests on a PAIRED session (executed 2026-07-18, after a disposable number scanned the QR)

Session `poc1` paired to a disposable number (WAHA `me`: `966554620315@c.us`, GOWS). Counterparty = the operator's personal phone. Catcher recorded every delivery.

| # | Test | Expected | Actual | Result |
|---|---|---|---|---|
| 15 | Outbound **text** | id + `message.any` (out) | id returned, `message.any` flow=out, ack=SERVER | ✅ |
| 16 | Outbound **image + caption** | media msg + webhook | sent; `message.any` out, media flagged; caption delivered | ✅ |
| 17 | Outbound **PDF** (`sendFile`) | doc msg + downloadable | sent; media **download 200 / application/pdf / 13,264 B** | ✅ |
| 18 | Outbound **video** (1.1 MB mp4) | video msg | sent (clean CDN mp4); webhook out+media | ✅ |
| 19 | Outbound **voice** (`sendVoice` convert→ogg) | voice msg | sent; webhook out+media | ✅ |
| 20 | Outbound **quoted reply** (`reply_to`) | reply w/ quote | sent w/ `reply_to`, webhook fired | ✅ |
| 21 | `sendVideo` w/ `convert:true` on a **bad source URL** | — | 500 `ffmpeg exited code 1` (source returned HTML, not video). A verified mp4 sent fine → source problem, not WAHA. Lesson: validate media bytes before convert | ⚠️ |
| 22 | Inbound **text** | `message` (in) w/ body | 4 texts received, flow=in, Arabic body extracted intact | ✅ |
| 23 | Inbound **image** | `message` in + media | received, `media.mimetype=image/jpeg`; **download 200 / 75,966 B** | ✅ |
| 24 | Inbound **video** | `message` in + media | received, `media.mimetype=video/mp4`; **download 200 / application/mp4 / 3,652,717 B** | ✅ |
| 25 | **Ack lifecycle** outbound→counterparty | SERVER→DEVICE→READ | **SERVER → DEVICE** captured; **READ not emitted** because the recipient's phone has read-receipts DISABLED (WhatsApp privacy — no gateway can see READ then; identical on Haberchat) | ✅ (READ n/a by design) |
| 26 | **Chat list + history** on WORKING session | chats + messages | `chats/overview` → 1 chat w/ correct last-message; `getMessages` → all 7 msgs in order w/ media URLs | ✅ |
| 27 | **Duplicate events** under real traffic | dedupe needed | **every event delivered 2×** (global env hook + per-session hook both point at catcher) — inbound AND outbound | ⚠️ (dedupe-by-id mandatory) |
| 28 | **Webhook outage w/ real messages** | retry, zero loss | catcher forced 500; 3 msgs sent during outage; after recovery **3/3 distinct redelivered** (8× each from retries × 2 hooks) — zero loss | ✅ |
| 29 | **Container restart on a PAIRED session** | auth survives, no re-scan | `fly machine restart` → poc1 back to **WORKING** as same account in **~10 s, no QR re-scan** (auth persisted on volume) | ✅ |
| 30 | **Zombie (connected-but-silent) detection** | signal to watchdog on | `status:WORKING` alone is unreliable (documented failure mode); `/health` = storage/DB only, NOT liveness; the ONE signal is `timestamps.activity` (epoch ms, present here; issue #2073 = intermittently absent). No built-in E2E probe → external watchdog + `/restart` required (restart recovery proven in #29) | ✅ (gap characterized) |

**🚩 Load-bearing migration finding — inbound sender identity is a LID, not a phone (GOWS).** On the GOWS engine, an inbound message's top-level `from` / `payload.from` is a WhatsApp **LID** (`196271432331425@lid`), and the top-level payload exposes **no phone number** (`senderPn` empty). The real phone is nested in the raw whatsmeow field `payload._data.Info.SenderAlt` = `966554446109@s.whatsapp.net`. **Wassell's entire client model keys off the phone wid** (`966…@c.us`) that Haberchat/Wassenger delivers directly as `from` — auto-link, `mark_whatsapp_replied`, reply reconciliation, `find_client_id_by_phone`, the advertiser matcher. A naive port that maps WAHA `from` → phone would key **every inbound by LID and match no clients**. The migration MUST resolve phone from `SenderAlt` (or WAHA's `/lids` mapping endpoint), and this behavior is engine-dependent (verify separately on WEBJS/NOWEB). This is the single most important code-level gotcha surfaced by the POC.

**Media URL base gotcha.** `getMessages`/webhook media URLs return with an internal base `http://localhost:3000/api/files/...`. Set `WAHA_BASE_URL` to emit public URLs, or (better for a CRM) download server-side by path and re-host into Supabase Storage immediately (also mitigates the 180 s media-lifetime expiry).

**Still not exercised** (need a second paired number, or don't add signal): two numbers paired simultaneously (multi-session was proven at create/start in #9; simultaneous paired traffic not run), and long-horizon history backfill depth. Everything else on the original checklist is now covered. **POC left running:** dashboard `https://waha-poc-wassell.fly.dev/dashboard` (user `wassell`, pw in `.poc-secrets.local`), `poc1` WORKING. Teardown: `fly apps destroy waha-poc-wassell waha-poc-catcher` + `fly volumes destroy`.

## 5. Migration work required (if pursued)

1. **Gateway wrapper rewrite** — `api/_lib/haberchat.ts` → `api/_lib/waha.ts`: different auth (`X-Api-Key`), different payload shapes, `chatId` stays `<digits>@c.us` (compatible with existing wid/uuidv5 identity glue). Ack enum remap (SERVER/DEVICE/READ ↔ sent/delivered/read).
2. **Webhook handler rework** — event names (`message`, `message.any`, `message.ack`, `session.status`), envelope shape, HMAC-SHA512 verification, dedupe on event id (duplicates confirmed normal, both directions). DLQ + never-downgrade-ack logic carries over. **CRITICAL: resolve the sender phone from `_data.Info.SenderAlt` (GOWS surfaces `from` as a LID, not a phone) before any phone→client match** — otherwise every inbound fails to link. This is the highest-risk single line in the port (see §4b LID finding).
3. **Build a scheduler** — the single biggest piece: a Wassell-owned scheduled-messages queue (DB table + the existing Fly worker pattern — an 8th queue) replicating `deliverAt`, queued-strip listing, cancel/cancel-all, and the +10 s gallery stagger. Restart-survival comes free (DB-backed).
4. **Media pipeline** — download media on webhook receipt and re-host (Supabase Storage or Tigris S3); configure `WAHA_MEDIA_STORAGE`. Never trust WAHA/WhatsApp CDN URLs beyond minutes.
5. **Zombie watchdog** — track last-event age per session; auto-restart via API when stale; alert on repeated restarts. (No Haberchat equivalent was needed — this is new operational surface.)
6. **Chat status/labels** — status becomes fully CRM-owned (simpler: no push-back needed); labels via WAHA labels API if ever re-surfaced.
7. **Device management** — `GET /devices` → `GET /api/sessions` mapping into `whatsapp_numbers` overlay.
8. **Version pinning + monthly bump routine** — pinned image tag, staging smoke-test, then prod bump. WhatsApp-side breakage (e.g. the June 2026 passkey change) can block pairing/features fleet-wide until a fix ships.

## 6. Real cost

| Item | HaberChat today | WAHA self-hosted |
|---|---|---|
| Gateway license | Wassenger-class list pricing **€39.90–€99.90/mo** ([wassenger.com/pricing](https://wassenger.com/pricing)); actual Haberchat bill may differ | **$0** (optional $5/mo donation) |
| Hosting | included | Fly.io ~**$8–15/mo** (shared-cpu-1x/2x, 1–2 GB; GOWS 1–3 sessions ≈ 0.1–0.3 CPU / <1 GB) + volume ~$0.15/GB/mo (snapshots included) |
| Media storage | included (their CDN) | Supabase Storage (existing) or Tigris S3 ~$0.02/GB/mo + egress |
| Scheduler | included (`deliverAt` queue) | **build + maintain** (one-time build, then part of the worker) |
| Monitoring/watchdog | their ops team | build once; runs on existing worker ($0 infra) |
| Incident response | Haberchat support (and their outages — Jul 9–12 incident, device-id rotations) | **in-house**: WhatsApp protocol breakage lands on us; expect ~monthly pinned-version bumps + occasional urgent fixes |
| One-time migration | — | wrapper + webhook + scheduler + media + watchdog + dual-run pilot: the dominant cost (~2–4 engineering weeks equivalent) |

Cash savings ≈ €35–95/mo. That pays back a serious migration only over a long horizon — the stronger arguments for WAHA are **control** (no vendor outages like Jul 9–12, no silent `/sync` API changes, no stale-webhook 401 noise, unlimited numbers at no marginal cost) and **data locality** (media + queue fully in-house).

## 7. Final verdict

**WAHA CAN replace HaberChat, with conditions — it is a credible replacement, not a drop-in upgrade.**

- **Functionally:** everything Wassell uses is covered except scheduled sends (must be built) and the Wassenger chat-status sugar (becomes CRM-owned, arguably cleaner). The POC on pinned `gows-2026.7.1` passed **30 runnable tests** end-to-end on a real paired number: outbound + inbound text/image/video/voice/PDF, captions, quoted replies, media download both directions, chat-list + history, SERVER→DEVICE acks (READ unobservable only because the operator's phone had read-receipts off), webhook retry with **zero loss** across a forced outage, and **paired-session auth surviving a container restart with no re-scan (~10 s)**. Two concrete code-level gotchas surfaced that a doc-only review would have missed: (a) **inbound `from` is a LID, phone is in `_data.Info.SenderAlt`** — must be handled or client-linking breaks; (b) media URLs use an internal `localhost:3000` base. Both are solvable in the wrapper/webhook rewrite.
- **Reliability:** same failure physics as HaberChat (both are unofficial WhatsApp Web automation). WAHA's tracker documents zombie sessions, duplicate/missed webhooks, and unreliable acks — but Wassell's architecture (webhook→mirror→Realtime, DLQ, never-downgrade acks, reply reconciliation, mirror fallback) was hardened against exactly these behaviors on Haberchat and transfers directly. The genuinely new burden is operational: watchdog, restarts, monthly upgrades, incident response.
- **Ban risk:** unchanged either way; the maintainer explicitly offers no safe-config guarantee.
- **Recommendation:** do NOT cut over on this evidence alone. (1) Pair the running POC with a disposable number and complete the message-level suite. (2) If it passes, run WAHA as a **second gateway in parallel** on a non-production number (the multi-device architecture already supports multiple numbers) for 3–4 weeks, with the scheduler + watchdog built and exercised. (3) Only then migrate the production number — keeping the Haberchat wrapper intact for one release as a rollback path. Proceed if the driver is control/reliability-ownership/unlimited numbers; do not proceed if the only driver is the €40–100/mo subscription.

---
*POC artifacts: session scratchpad `waha-poc/` (catcher source, fly configs, secrets). Live apps (disposable): `waha-poc-wassell`, `waha-poc-catcher` — destroy with `fly apps destroy` when done. Evidence agents' full reports archived in the session transcript.*
