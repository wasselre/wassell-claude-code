# ASR A/B — English-default wizper (A) vs Arabic-forced (B word-level whisper, B2 wizper segment)

Generated 2026-09-02T08:42:54.869Z by `scripts/retranscribe-arabic.mjs --ab`. Pool: 624 stored competitor videos with a done, non-empty `fal-ai/wizper` transcript; 10 sampled.

**No human ground truth exists for these videos.** Every metric below is a proxy computed against the enrichment result, the linked project / organization / developer records, and the post caption — none of which were produced from the audio. Dialect fidelity needs the operator sheet in `human-review.md`.

## Variants

| Key | Endpoint | Request (besides `audio_url`) | Note |
|---|---|---|---|
| A | `fal-ai/wizper` | `{task:"transcribe", chunk_level:"segment", version:"3"}` — **no `language` key** | The stored v1 rows. fal's schema defaults `language` to `"en"`, so Whisper decoded Arabic speech as English. |
| B | `fal-ai/whisper` | `{task:"transcribe", language:"ar", chunk_level:"word", version:"3"}` | wizper returns **422** for `chunk_level:"word"` (schema: `const "segment"`), so word-level ran on the sibling whisper endpoint. Words re-aggregated to ~5–8 s segments. |
| B2 | `fal-ai/wizper` | `{task:"transcribe", language:"ar", chunk_level:"segment", version:"3"}` | The backfill candidate; stored as `fal-ai/wizper@ar`. |

## Per-video

| # | Video | Why picked | Dur s | Var | Arabic | Names (strict) | Names (±1 edit) | Numbers | Segs | Median seg s | Greeting ≤15% | Coverage | Latency s | Cost $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | [f9dd6a2e](https://www.youtube.com/watch?v=MzmCwPM_OzA) | walkthrough | 267 | A | 0% | 1/7 (14%) | 0/7 (0%) | 2/2 (100%) | 7 | 31.9 | yes | 98% | — | 0.0000 |
| 1 | [f9dd6a2e](https://www.youtube.com/watch?v=MzmCwPM_OzA) | walkthrough | 267 | B | 100% | 4/7 (57%) | 4/7 (57%) | 2/2 (100%) | 32 | 7.4 | yes | 98% | 58 | 0.0444 |
| 1 | [f9dd6a2e](https://www.youtube.com/watch?v=MzmCwPM_OzA) | walkthrough | 267 | B2 | 100% | 4/7 (57%) | 4/7 (57%) | 2/2 (100%) | 7 | 31.9 | yes | 98% | 6 | 0.0444 |
| 2 | [881aae55](https://www.youtube.com/watch?v=hzmAFDHyj-U) | project_name | 266 | A | 0% | 1/5 (20%) | 0/5 (0%) | — | 6 | 42.1 | yes | 98% | — | 0.0000 |
| 2 | [881aae55](https://www.youtube.com/watch?v=hzmAFDHyj-U) | project_name | 266 | B | 100% | 0/5 (0%) | 1/5 (20%) | — | 32 | 7.0 | yes | 98% | 55 | 0.0443 |
| 2 | [881aae55](https://www.youtube.com/watch?v=hzmAFDHyj-U) | project_name | 266 | B2 | 100% | 0/5 (0%) | 1/5 (20%) | — | 6 | 42.1 | yes | 98% | 6 | 0.0443 |
| 3 | [15e6f4de](https://www.instagram.com/p/DahxLnkszHG/) | district | 164 | A | 0% | 1/7 (14%) | 0/7 (0%) | 1/1 (100%) | 6 | 27.0 | yes | 97% | — | 0.0000 |
| 3 | [15e6f4de](https://www.instagram.com/p/DahxLnkszHG/) | district | 164 | B | 100% | 4/7 (57%) | 3/7 (43%) | 1/1 (100%) | 21 | 7.7 | yes | 97% | 37 | 0.0274 |
| 3 | [15e6f4de](https://www.instagram.com/p/DahxLnkszHG/) | district | 164 | B2 | 99% | 4/7 (57%) | 3/7 (43%) | 1/1 (100%) | 6 | 27.0 | yes | 97% | 6 | 0.0274 |
| 4 | [e23d9af1](https://www.tiktok.com/@almajdiah/video/7397129876211240199) | price | 138 | A | 0% | 0/5 (0%) | 0/5 (0%) | 4/4 (100%) | 6 | 25.0 | yes | 98% | — | 0.0000 |
| 4 | [e23d9af1](https://www.tiktok.com/@almajdiah/video/7397129876211240199) | price | 138 | B | 100% | 2/5 (40%) | 2/5 (40%) | 2/4 (50%) | 19 | 7.6 | yes | 98% | 44 | 0.0230 |
| 4 | [e23d9af1](https://www.tiktok.com/@almajdiah/video/7397129876211240199) | price | 138 | B2 | 100% | 2/5 (40%) | 2/5 (40%) | 2/4 (50%) | 6 | 25.0 | yes | 98% | 6 | 0.0230 |
| 5 | [260a52be](https://www.instagram.com/p/DXpUqWsEotB/) | area | 112 | A | 0% | 1/5 (20%) | 0/5 (0%) | 2/2 (100%) | 4 | 28.6 | no greeting | 95% | — | 0.0000 |
| 5 | [260a52be](https://www.instagram.com/p/DXpUqWsEotB/) | area | 112 | B | 100% | 2/5 (40%) | 1/5 (20%) | 1/2 (50%) | 15 | 6.7 | no greeting | 95% | 31 | 0.0187 |
| 5 | [260a52be](https://www.instagram.com/p/DXpUqWsEotB/) | area | 112 | B2 | 100% | 2/5 (40%) | 1/5 (20%) | 1/2 (50%) | 4 | 28.6 | no greeting | 95% | 3 | 0.0187 |
| 6 | [7b67b822](https://www.instagram.com/p/DVoZWR2DL1B/) | fast_speech | 63 | A | 0% | 1/6 (17%) | 0/6 (0%) | — | 2 | 27.8 | no greeting | 89% | — | 0.0000 |
| 6 | [7b67b822](https://www.instagram.com/p/DVoZWR2DL1B/) | fast_speech | 63 | B | 100% | 4/6 (67%) | 4/6 (67%) | — | 8 | 7.7 | no greeting | 100% | 36 | 0.0105 |
| 6 | [7b67b822](https://www.instagram.com/p/DVoZWR2DL1B/) | fast_speech | 63 | B2 | 100% | 4/6 (67%) | 4/6 (67%) | — | 2 | 27.8 | no greeting | 89% | 9 | 0.0105 |
| 7 | [ffdb24a1](https://www.youtube.com/watch?v=v-y9HoJWbqc) | music_noise | 72 | A | 0% | 0/11 (0%) | 0/11 (0%) | 0/1 (0%) | 2 | 32.2 | no greeting | 100% | — | 0.0000 |
| 7 | [ffdb24a1](https://www.youtube.com/watch?v=v-y9HoJWbqc) | music_noise | 72 | B | 100% | 0/11 (0%) | 0/11 (0%) | 0/1 (0%) | 4 | 15.0 | no greeting | 100% | 20 | 0.0121 |
| 7 | [ffdb24a1](https://www.youtube.com/watch?v=v-y9HoJWbqc) | music_noise | 72 | B2 | 100% | 0/11 (0%) | 0/11 (0%) | 0/1 (0%) | 2 | 32.2 | no greeting | 100% | 6 | 0.0121 |
| 8 | [f8b6811a](https://www.youtube.com/watch?v=pO7brkIWfek) | multi_speaker | 293 | A | 0% | 0/8 (0%) | 1/8 (13%) | 1/1 (100%) | 13 | 21.7 | no greeting | 96% | — | 0.0000 |
| 8 | [f8b6811a](https://www.youtube.com/watch?v=pO7brkIWfek) | multi_speaker | 293 | B | 99% | 4/8 (50%) | 5/8 (63%) | 1/1 (100%) | 34 | 7.8 | no greeting | 92% | 61 | 0.0488 |
| 8 | [f8b6811a](https://www.youtube.com/watch?v=pO7brkIWfek) | multi_speaker | 293 | B2 | 99% | 4/8 (50%) | 4/8 (50%) | 1/1 (100%) | 13 | 21.7 | no greeting | 96% | 30 | 0.0488 |
| 9 | [df885e76](https://www.tiktok.com/@riva_aqar/video/7648636638209346817) | coverage | 99 | A | 0% | 0/5 (0%) | 0/5 (0%) | 2/2 (100%) | 3 | 29.7 | no greeting | 95% | — | 0.0000 |
| 9 | [df885e76](https://www.tiktok.com/@riva_aqar/video/7648636638209346817) | coverage | 99 | B | 100% | 3/5 (60%) | 3/5 (60%) | 2/2 (100%) | 12 | 7.6 | no greeting | 95% | 36 | 0.0165 |
| 9 | [df885e76](https://www.tiktok.com/@riva_aqar/video/7648636638209346817) | coverage | 99 | B2 | 100% | 2/5 (40%) | 3/5 (60%) | 2/2 (100%) | 3 | 29.7 | no greeting | 95% | 23 | 0.0165 |
| 10 | [f22100dc](https://www.instagram.com/p/DW6relkjFaT/) | coverage | 86 | A | 0% | 0/5 (0%) | 0/5 (0%) | 0/2 (0%) | 3 | 30.6 | no greeting | 94% | — | 0.0000 |
| 10 | [f22100dc](https://www.instagram.com/p/DW6relkjFaT/) | coverage | 86 | B | 100% | 1/5 (20%) | 1/5 (20%) | 0/2 (0%) | 10 | 7.6 | no greeting | 93% | 41 | 0.0144 |
| 10 | [f22100dc](https://www.instagram.com/p/DW6relkjFaT/) | coverage | 86 | B2 | 100% | 1/5 (20%) | 1/5 (20%) | 0/2 (0%) | 3 | 30.6 | no greeting | 94% | 22 | 0.0144 |

## Totals

| Variant | Videos | Mean Arabic ratio | Names (strict) | Names (±1 edit) | Numbers present | Segments / video | Median seg s | Greeting ≤15% | Mean coverage | Median latency s | Est. cost $ | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 10 | 0% | 5/64 (8%) | 1/64 (2%) | 12/15 (80%) | 5.2 | 29.1 | 4/4 (100%) | 96% | — | 0.0000 | 0 |
| B | 10 | 100% | 24/64 (38%) | 24/64 (38%) | 9/15 (60%) | 18.7 | 7.6 | 4/4 (100%) | 97% | 39 | 0.2601 | 0 |
| B2 | 10 | 100% | 23/64 (36%) | 23/64 (36%) | 9/15 (60%) | 5.2 | 29.1 | 4/4 (100%) | 96% | 6 | 0.2601 | 0 |

Cost is an estimate at fal's list price ($0.01 / audio-minute); the API returns no billing data — verify on the fal dashboard. A's cost was already paid.

## Gate (B2 = the backfill variant, vs A)

- Proper names: A 5/64 (8%) → B2 23/64 (36%) — B2 wins
- Numbers: A 12/15 (80%) → B2 9/15 (60%) — B2 does NOT beat A
- Ordering (greeting in first 15% of text, where a greeting exists): B2 4/4 (100%) — ordering looks correct
- Failures: 0

**Recommendation: NO-GO** for the Arabic backfill (`--backfill --confirm`). See per-video rows for what fell short.

## Caveats

- Name/number presence is measured after Arabic normalization (harakat/tatweel stripped, أإآ→ا, ة→ه, ى→ي, digits unified, `ال` prefix ignored). A name counts only if EVERY significant token is present (strict), so partial hits count as misses for both variants; the ±1-edit column tolerates one character slip per token («فستا»/«فستة», «سواري»/«سواهري») — the usual ASR error on an unfamiliar brand name.
- Numbers: Whisper writes Saudi prices as WORDS in Arabic («مليونين وخمسمية وتسعين» = 2,590,000; «919 ألف»), and as digits in English. The numeric metric expands spoken Arabic number phrases (incl. the colloquial implied «ألف» after «مليون») and dotted/comma thousands before comparing; without that expansion the Arabic variants scored 40% on a metric artifact. Remaining misses are either a genuine ASR digit error (e.g. «1.282.000» vs the enrichment's 1,289,000) or a number the enrichment took from the caption/visuals that was never spoken.
- Expected names come from `mkt_content_enrichment` (district/location), the linked `all_projects` record (`project_name`), `mkt_organizations` (name_ar/name_en + developer record), and caption patterns (`مشروع X`, `حي X`, `#hashtag`). Organization names are often NOT spoken in the video, which depresses BOTH variants equally.
- The A transcripts are English, so Arabic names can only match them through transliteration — they mostly cannot. That is the point: the stored rows are unusable for Arabic name/number extraction.
- Speaker count is a heuristic (≥6 stored segments); no diarization was run.
- Every stored fal row also exposes the v1 media path issue: where `content/audio/<checksum>.m4a` was missing, the stored mp4 was sent instead (see `source.kind` in results.json).
