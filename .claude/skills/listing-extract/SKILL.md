---
name: listing-extract
description: Extract structured real-estate fields from scraped Aqar.sa (عقار) listing pages. Reads a manifest JSON listing page bundles and writes a strict JSON result array. Used by the aqar lane on the Claude Code runner (paid subscription, no Anthropic API charge). Invoke as `/listing-extract <manifest_file> <result_file>`.
---

# Listing extraction (Aqar.sa)

You are running HEADLESS from the `claude_jobs` queue on the `aqar` lane. Nobody
can answer questions — decide everything autonomously and write ONE result file.
This replaces a direct Anthropic API call, so the output must be strictly
machine-parseable.

## Inputs

Two absolute paths are given in the prompt: `<manifest_file>` and `<result_file>`.

Read `<manifest_file>` — a JSON **array**, one entry per listing:

```json
{ "listing_id": "6789992",
  "url": "https://sa.aqar.fm/...",
  "bundle": "<the scraped page content: visible text, JSON-LD, embedded JSON, features block>" }
```

**Read every entry.** These are Saudi real-estate listings — the content is
mostly Arabic.

## Extraction rules

- **Do NOT guess.** If a field is not clearly present in the bundle, use `null`.
- **Keep Arabic text exactly as it appears** — do not translate, transliterate,
  or normalise.
- `price` — digits only when a clear numeric price is shown (strip currency
  words, commas, `ريال`); otherwise `null`.
- Numeric fields (`area`, `bedrooms`, `bathrooms`, `living_rooms`, `floors`) —
  clean numbers when clearly stated, else `null`.
- `area` is the property/land area in square metres (number only).
- `frontage` is the property facing direction / الواجهة. `age` is عمر العقار.
- `phone_number` — only if a real phone number is visibly present. Aqar usually
  hides it, so this is **typically `null`**. Never invent one.
- Only use information about **THIS** listing. Ignore "similar" / "recommended"
  listings, ads, and navigation.

### `features` (المميزات)

- Extract the features listed under the `المميزات` section, **exactly as
  written in Arabic**.
- These are free-text labels (e.g. `مدخل سيارة`, `مصعد`, `ألياف ضوئية`) — do
  NOT invent boolean fields.
- Include ONLY features shown as available on the page.
- Preserve their original order and remove exact duplicates.
- If the page has no `المميزات` section, set `features` to `null`.
- When the bundle contains a CANDIDATE FEATURES list, treat it as the source of
  truth — do not add features that are not on the page.

## Output — write to `<result_file>`

A JSON **array**, one object per manifest entry, **in the same order**, with
**every** key present (use `null`, not omission):

```json
[
  {
    "listing_id": "6789992",
    "title": "...", "price": "850000", "city": "الرياض", "district": "حي الياسمين",
    "street": "...", "property_type": "فيلا", "area": "300", "bedrooms": "5",
    "bathrooms": "6", "living_rooms": "2", "floors": "2", "frontage": "شمالية",
    "age": "جديد", "description": "...", "advertiser_name": "...",
    "phone_number": null,
    "features": ["مدخل سيارة", "مصعد"]
  }
]
```

The 16 text fields are exactly: `title`, `price`, `city`, `district`, `street`,
`property_type`, `area`, `bedrooms`, `bathrooms`, `living_rooms`, `floors`,
`frontage`, `age`, `description`, `advertiser_name`, `phone_number` — each a
string or `null`. `features` is an array of strings or `null`.

## Hard rules

1. **One entry out per entry in.** A short array means a listing was silently
   dropped; the validator rejects the whole job for that. If a bundle is
   unusable, still emit its object with every field `null` — never skip it.
2. **`listing_id` must be copied verbatim** from the manifest entry. Do not
   reformat, pad, or renumber it — it is the join key back to the scraper.
3. **Write the result file and nothing else.** No commentary in the file, no
   markdown fences, no partial writes. The file must parse as JSON on the first
   read.
4. **Do not touch the database, the network, or any file other than
   `<result_file>`.** Everything you need is in the manifest.
