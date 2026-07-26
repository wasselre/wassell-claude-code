# WhatsApp gateway — Doha VM (2026-07-24)

The WhatsApp gateway moved off Fly onto a **GCP VM in Doha (me-central1)**.

## Why

The Fly host egressed via a **US-registered IP**. WhatsApp geolocates the
companion device by IP-block owner, so a Saudi number linking from an
"American" device tripped its account-takeover heuristics: the pairing UI
warned *"this device might be a scammer"*, link attempts were refused, sessions
were killed aggressively, and repeated `request-code` calls hit
`429 rate-overlimit`. That is the root cause of the chronic session drops and
the manual re-pairing from the phone. A Gulf IP removes the mismatch.

## Current setup

| | |
|---|---|
| VM | `wassel-waha`, project `instant-medium-503214-f9`, zone `me-central1-a` |
| IP | `34.18.15.250` (Doha, QA) |
| Size | e2-medium / 30 GB |
| Image | `devlikeapro/waha:latest`, `--restart always` |
| Engine | **NOWEB** |
| Session | `sales` → +966556546238 (وصل العقارية) |
| Webhook | `https://app.wassel.re/api/webhook/waha` (HMAC, 6 retries) |
| Port | 3000, firewall rule `allow-waha-3000`, tag `waha` |

The VM carries a startup-script that reinstalls Docker + WAHA on boot, so a
reset self-heals.

App wiring: Vercel production `WAHA_URL` / `WAHA_API_KEY` point at the Doha
host, and `whatsapp_numbers` has `sales` as the default active device
(`provider='waha'`, `session_name='sales'`). The old `wassel_main` row is kept
inactive for history.

## Engine notes (which WAHA engine to use)

- **NOWEB** — use this. Supports 8-char code pairing *and* stays connected.
- **GOWS** — code pairing works but the session is unstable (~20 s pairing
  window, drops mid-sync) and it has the 463 cold-contact send bug.
- **WEBJS** — stable session but `requestPairingCode` is broken (500); QR only,
  and needs the Chromium-bundled image.

## Gotchas

- **GCP Dammam (me-central2) is blocked for this account** — zones list fine
  but any create returns `Permission denied on locations/me-central2`. It is
  not an org policy (`gcp.resourceLocations` is empty); it is a platform-level
  regional allowlist. `me-central1` (Doha), `me-west1` and `asia-south1` work.
- `gcloud compute ssh` from Windows fails on plink host-key prompts — run
  remote setup via a **startup-script + `instances reset`** instead.
- Pairing codes expire in ~2 min and the session then goes `FAILED`;
  `request-code` only works in `SCAN_QR_CODE`. Working recipe: DELETE the
  session → recreate → wait for `SCAN_QR_CODE` → request the code → have the
  operator already sitting on the "enter code" screen so they type it at once.
- Enable the Compute API per project first
  (`gcloud services enable compute.googleapis.com`).

## Open follow-ups

- Port 3000 is plain HTTP protected only by the API key — put HTTPS/a tunnel in
  front, or restrict the source range to Vercel egress.
- Migrate the ops/bridge number (+966554620315) off the laptop onto this VM too.
