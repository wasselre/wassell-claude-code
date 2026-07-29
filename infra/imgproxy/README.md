# imgproxy — allowlisted listing-photo fetcher (me-central1)

## Why

Aqar's CDN (Cloudflare) blocklists datacenter egress **by ASN**, and around
2026-07-24 it began answering **403** to Fly.io's ranges. That broke the
clean-text lane in `worker/src/runCleanTextJob.ts`: `rehostSource()` downloads a
listing photo and re-uploads it to `marketing-assets` so fal can read it, and
that download started failing *before fal or Anthropic was ever called* — so
every photo in the Listing Message modal showed `فشل` while fal/Anthropic
credit was untouched.

Measured 2026-07-29 on `https://images.aqar.fm/webp/750x0/props/...jpg`:

| Origin | Egress | Result |
| --- | --- | --- |
| Laptop (KSA) | — | 200 (even with no headers) |
| `wassel-wa-agent` (bom) | 204.93.145.73 | 200 |
| `wassel-deck-worker` `48ee749f705d98` (sin) | 167.88.158.106 | 200 |
| `wassel-deck-worker`, other 4 (sin) | 138.199.24.234/.235/.236/.245 | **403** |
| freshly-cloned machine (fra) | 89.222.119.17 | **403** |
| `wassel-waha` VM (me-central1) | 34.18.239.19 | 200 |

It is not a UA/Referer/hotlink problem — the worker was already sending browser
headers. Only 1 of 5 machines had a clean IP, which is why ~1 photo in 5 kept
working and redo "sometimes" fixed it. Region-hopping does **not** fix this
(`fra` was blocked on first provision), so the fetch is routed through an
address we own instead.

## What this is

A ~120-line stdlib-only Python service on the `wassel-waha` GCP VM
(me-central1-a), running as `imgproxy.service` on `127.0.0.1:8090` behind the
Caddy instance that already fronts WAHA. Purely additive — WAHA's own route is
untouched (`handle_path /imgproxy/*` is matched before the catch-all `handle`).

Deliberately not a general-purpose proxy. All four of these hold at once:

- `Authorization: Bearer $IMGPROXY_TOKEN` required
- host must be in `ALLOWED_HOSTS` (`images.aqar.fm`, `sa.aqar.fm`)
- `https` only, response must be `image/*`
- 25 MB / 30 s caps

So a leaked token still cannot reach the GCP metadata endpoint, the WAHA
container, or anything but public Aqar listing photos. Verified at install:
`no-token=401`, `bad-host=403`, `metadata-ssrf=403`, `good=200`.

## Install / reinstall

```bash
gcloud compute scp imgproxy.py setup-imgproxy.sh wassel-waha:/tmp/ --zone me-central1-a
gcloud compute ssh wassel-waha --zone me-central1-a --command "bash /tmp/setup-imgproxy.sh '<TOKEN>'"
```

Then point the worker at it:

```powershell
fly secrets set --app wassel-deck-worker `
  LISTING_IMAGE_PROXY_URL=https://34-18-239-19.sslip.io/imgproxy/fetch `
  LISTING_IMAGE_PROXY_TOKEN=<TOKEN>
```

The worker tries the CDN **directly first** and only falls back to this proxy on
refusal (log line: `[run-clean] direct fetch refused (source fetch 403) —
retrying via image proxy`). With both secrets unset the fallback self-disables
and a blocked fetch fails loudly, exactly as before.

## Caveats

- **The VM's public IP is baked into the Caddy site name** (`34-18-239-19.sslip.io`).
  If the VM's external IP changes, update `/etc/caddy/Caddyfile` *and* the
  `LISTING_IMAGE_PROXY_URL` secret. Original config is backed up at
  `/etc/caddy/Caddyfile.bak.preimgproxy`.
- This is a **stopgap.** The durable fix is to re-host listing photos into
  `marketing-assets` at scan time, so the cleaning lane never touches Aqar's CDN
  and no proxy is needed. Aqar could blocklist this IP too.
- `market_listings` also stopped gaining rows after 2026-07-23 — possibly the
  same block hitting the scanner (`aqar-sync-rayan`, region `sjc`). Not
  root-caused; investigate separately.
