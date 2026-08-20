# Extraction playbook — building the extractor for a new platform

_Last updated: 2026-08-19_

How to build the **extraction** stage (stage 1) for any new real-estate portal
(Bayut, Wasalt, …). Extraction's one job: **capture every field the portal gives,
RAW, and keep immutable evidence.** Matching, cleaning, and computing happen later
and elsewhere — never here.

Read the [master plan](./README.md) first. The companion is the
[adapter-playbook](./adapter-playbook.md).

---

## 0. The prime directive

> **Extraction brings the source data exactly as-is. It never alters, coerces,
> normalizes, "fixes", or drops an original value.**

If a field is `0`, extraction records `0`. If it's an empty string, a weird enum, a
placeholder like "licensed via app", a nested object — extraction records it
verbatim. Deciding that `0` means "not specified", or that a placeholder phone isn't
a real phone, is the **adapter's** job (matching + rules), not extraction's. Two
reasons this line is absolute:

1. The raw evidence must be a faithful, replayable record of what the portal served
   — so any later re-interpretation (a new adapter rule, a re-mapping) can run
   against the truth, not a lossy copy.
2. Every past silent-data bug in this codebase came from "helpfully" transforming
   data early. Keep transformations downstream where they're governed.

**One narrow, documented exception is allowed** and it is still not "altering the
source": a field may be recorded as `null` **only** when the source value is a known
non-value placeholder AND capturing it raw would poison a downstream identity/lookup
step. The live example: Aqar returns `"مرخص عن طريق تطبيق عقار…"` in the phone field
when the number is hidden; the extractor stores `null` there (not the placeholder) so
the REGA phone-lookup fills it later. This is a deliberate, commented, per-field
decision — not a general cleaning pass. When in doubt, keep it raw and let the
adapter decide.

---

## 1. What extraction is, and is not

| Extraction IS | Extraction is NOT |
|---|---|
| Capturing raw field values from the page | Matching them to CRM columns (adapter) |
| Preserving nested objects/arrays as-is | Coercing `0`→`null`, trimming, renaming (adapter) |
| Deterministic identity + media capture | Computing price/m², counts (app/DB) |
| Writing immutable evidence | Writing to `market_listings` (adapter) |
| Feeding the field catalog (Gate A) | Deciding a field's meaning (cockpit) |

---

## 2. Choosing an extraction method — the decision tree

Always prefer the most **deterministic, complete, cheap** source available. Fall
down this ladder only as each rung fails:

1. **An internal structured object embedded in the page.** Modern portals ship the
   full listing as JSON somewhere in the HTML: a Next.js RSC flight stream
   (`self.__next_f.push([1,"…"])`), a `__NEXT_DATA__` / `__NUXT__` blob, a Redux
   preload, or an inline `application/json`. **This is almost always the richest and
   most reliable source** — it carries fields the rendered page never shows. Aqar's
   RSC `listing` object (157 keys) is the reference case.
2. **A documented or discoverable JSON API** the page itself calls (XHR/fetch). Often
   the same data as (1); use it if it's stable and doesn't need auth you can't get.
3. **JSON-LD** (`<script type="application/ld+json">`). Structured but usually thin
   (schema.org RealEstateListing) — good for a few canonical fields, rarely complete.
4. **DOM / visible text + an LLM** (last resort, for fields not in any structured
   source). The LLM reads rendered text; it is the least reliable and the most
   expensive, and it **cannot see** client-rendered tabs (Aqar's deed number /
   street width live in a tab the LLM never sees — they had to come from the RSC
   object). Use the LLM only for genuinely unstructured fields (free-text
   description, feature chips), and pin it hard (see §5).

**Rule:** identity and structured fields come from a deterministic source (1–3).
The LLM is for prose only. Never extract an identity/dedup field with an LLM.

---

## 3. Reference implementation — Aqar (RSC flight stream)

The Aqar extractor is the template. Files in `aqar-scraper/src/`:

- **`rsc.ts`** — `decodeRsc(html)` concatenates + JSON-unescapes every
  `self.__next_f.push([1,"…"])` payload; `extractListingObject(html)` anchors on the
  stable marker `"location":{"lat"` and balances braces outward to slice the one
  canonical `listing` object; `rscListingFields(html)` reads the deterministic
  identity/detail fields (deed number, street width, advertiser phone) + the
  `scraped_extras` catch-all.
- **`extractListing.ts`** — orchestrates one page: deterministic media
  (`processImages`/`processVideos`, no hallucinated URLs), map-marker coordinates,
  then the LLM (`askModel`) for prose + feature chips only, then the RSC overlay for
  the fields the LLM can't see. Supplementary reads are wrapped so they **never fail
  the listing**.
- **`schema.ts`** — the raw `Listing` shape the extractor emits.

Key techniques worth copying:
- **Anchor on a marker that every listing object carries** (`"location":{"lat"`),
  then balance braces — don't regex-scrape individual keys (that collides across the
  page's many embedded objects; it once matched a generic `id=40`).
- **Coordinates** often hide in the escaped structured blob or a lazily-mounted map
  popup, not the static DOM. (Aqar: coords live in the escaped RSC `location`; the
  Google-Maps link only appears after the marker is clicked.)
- **A `scraped_extras` catch-all** carries every structured field with no dedicated
  column, so nothing observed is lost even before it's mapped.

---

## 4. Step-by-step: onboard a new portal's extractor

1. **Recon the page.** Open a listing, view source, and hunt for the richest
   structured blob (§2). Confirm it carries the fields the rendered page shows *plus*
   more. Identify a **stable anchor** substring present in every listing object.
2. **Write the decoder.** Deterministically slice + parse the canonical listing
   object. Handle malformed chunks gracefully (one bad chunk must not lose the
   stream — see `decodeRsc`'s per-chunk try/catch). Return `null` cleanly for block
   pages / empty listings.
3. **Capture EVERYTHING raw.** Persist the full decoded object as immutable evidence
   (the `market-raw` bucket) AND surface a raw field set on the listing. Do not
   pre-select "fields we care about" — the catalog + cockpit decide relevance later.
4. **Identity fields, deterministically.** Extract the portal's ad id (`external_id`)
   and any deterministic dedup key the portal exposes (Aqar: `deed_number` — the key
   for grouping competing broker ads on the same property). **Never** source these
   from the LLM.
5. **Media, deterministically.** Collect image/video URLs from the structured source
   or DOM in order; never let the LLM emit URLs (it hallucinates them). Preserve the
   full gallery, not just the hero.
6. **Prose via the LLM, pinned.** Only description / feature chips. See §5.
7. **Never fail a listing over a supplementary field.** Wrap identity/detail overlays
   so a parse miss degrades to `null`, and the listing still saves.
8. **Handle anti-bot / egress.** See §6.
9. **Feed the field catalog.** Every observed `source_path` (e.g. `listing.<key>`)
   with example values → `source_field_catalog` (Gate A). This is what makes the
   fields show up in the cockpit's decision queue and what makes "a new field
   appeared" detectable. Include the observed type and page section.

Output of this stage: a **raw field set per listing + immutable evidence + catalog
rows**. Nothing typed to CRM columns yet — that's the adapter.

---

## 5. Using an LLM safely (prose only)

- **Scope it to unstructured fields** the structured source genuinely lacks
  (free-text `description`, `المميزات` feature chips). Everything structured comes
  from the deterministic source.
- **Give it the candidate set as source-of-truth** (e.g. the feature chips scraped
  from the DOM) and forbid inventing beyond it.
- **Guard the literal-"null" trap.** Models (deepseek-v4-flash observed 2026-07-29)
  sometimes emit the *string* `"null"` for an absent required field — store it and
  you get a title of `"null"`, a price of `"null"`. The extractor coerces `""` and
  `"null"` (case-insensitive) → real `null`. This guard is load-bearing.
- **Encoding.** Arabic through shell/JSON payloads mojibakes into `?????` and then
  into confident hallucinations — send via UTF-8 file, echo-test first (see memory
  `reference_deepseek_arabic_shell_encoding`).
- The text-gen provider routing is DeepSeek-primary + Claude-fallback
  (`TEXT_LLM_PROVIDER` kill switch); reuse that path, don't add a new provider.

---

## 6. Anti-bot, rate limits, and egress (the operational reality)

- **Rate limits.** Aqar rate-limits direct fetches (~2/s); heavy scraping goes
  through Browserbase. Expect per-portal limits; throttle and back off.
- **Datacenter-IP blocks by ASN.** Portals block cloud egress by ASN. Aqar began
  403-ing Fly's ranges ~2026-07-24; **region-hopping does not fix it** (measured:
  multiple Fly regions blocked, laptop + a Saudi VM fine). The working egress is the
  **me-central1 image proxy** — see `infra/imgproxy/README.md` and memory
  `reference_aqar_403_fly_sin_egress_blocked`.
- **Never make a historical backfill automatic, and keep queue-depth guards.** The
  photo-mirror lane caps enqueue at `listing_mirror_settings.max_queue_depth`
  (default 200) precisely so a catch-up run can't flood the shared me-central1 proxy
  (which also hosts the WhatsApp gateway). Any new portal's bulk backfill must be
  operator-run and throttled the same way.
- **Linking / login IP nationality** (if a portal needs an authed session): a
  mismatched-country IP reads as fraud. See the WAHA lessons (`reference_waha_saudi_ip_pairing`).

---

## 7. Rules checklist (paste into the PR)

- [ ] Raw values captured **verbatim** — no coercion, trimming, renaming, or dropping.
- [ ] The only `null`-substitution is a documented, per-field placeholder case (with a comment).
- [ ] Full decoded object persisted as **immutable evidence** (`market-raw`).
- [ ] Identity (`external_id`) + dedup key extracted **deterministically**, never via LLM.
- [ ] Full media gallery captured deterministically; no LLM-emitted URLs.
- [ ] LLM used for **prose only**, with the literal-`"null"` guard and UTF-8-safe payloads.
- [ ] Supplementary reads wrapped so they **never fail the listing**.
- [ ] Every observed `source_path` + examples fed to `source_field_catalog`.
- [ ] Egress path chosen for the portal's ASN blocks; backfill is throttled + operator-run.
- [ ] Coordinates hunted in the structured blob / map popup, not assumed absent.

---

## 8. Anti-patterns (real incidents — do not repeat)

- **LLM for identity/structured fields.** The LLM can't see client-rendered tabs;
  Aqar's deed number was missing from LLM output → dedup split into wrong groups.
  Fixed by reading the RSC object. Identity is always deterministic.
- **Regex-scraping individual keys out of the flight stream.** Collides with the
  page's other embedded objects (matched a generic `id=40`). Anchor + balance braces
  to get the *one* canonical object.
- **"Cleaning" at extraction.** Any early transform (0→null, trimming, dropping
  empties) belongs in the adapter. Extraction that alters the source makes the
  evidence a lie.
- **Region-hopping a blocked ASN.** Wastes time; the fix is the me-central1 proxy.
- **Automatic historical backfill without a queue cap.** Floods the shared proxy /
  WhatsApp gateway. Throttle + operator-run + `max_queue_depth`.
- **Storing the literal string `"null"`.** Guard it or downstream reads a real value.

---

## 9. Interfaces this stage must respect

- **Down to the adapter:** a raw field set keyed by the portal's own field names. The
  adapter maps those; it must not need extraction to have pre-shaped them.
- **To Gate A:** catalog rows (`source_field_catalog`) — `platform`, `source_path`,
  example values, observed type, page section, occurrence.
- **Evidence:** immutable objects in the `market-raw` bucket, replayable.

See the [adapter-playbook](./adapter-playbook.md) for what happens to this raw set next.
