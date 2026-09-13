# PRD: Geography Understanding Ability (geo-preference extraction + grading)

**Status:** Live (review-first; `auto_write_enabled = false` on prod — nothing writes a client record)
**Last updated:** 2026-09-13 (**calls and chats are extracted and reviewed SEPARATELY.** Until today the backfill merged a client's phone calls and WhatsApp messages into one conversation and stamped every mention `source_channel='chat'` with `source_ref='client:<id>'` — so provenance was a constant, and a call transcript's unlabelled speech let the AI record a district the *salesperson* suggested (القروان) as the *customer's* preference. Now one conversation per call and per chat thread, call-specific extraction rules, per-mention source turn, channel-aware grader.)
**Related PRDs:** [project-matching-assistant.md](project-matching-assistant.md) (the Finder consumes confirmed geo preferences), [calling.md](calling.md) (phone_calls transcripts are the call input), [chats.md](chats.md) (chat_messages are the chat input), [clients.md](clients.md)

## What it is (in plain English)
The ability reads what a customer said about *where* they want to buy — in their WhatsApp chats and in transcribed phone calls — and turns each place they mention into a structured "evidence" record: which place, whether they want it or reject it, how strongly, and whose preference it is. Those records feed a review-first proposal that a sales rep confirms before anything reaches the client's profile. An admin grades the AI's readings one card at a time on `/geo-grade` (Right / Wrong / Not sure), with the exact transcript the AI read shown on the card.

## Why it exists
Reps type location preferences inconsistently or not at all. The Project Finder needs a clean, boundary-verified geography preference per client. The ability extracts it from the conversations that already exist, but never trusts itself: every proposal is human-confirmed, and the grader measures how often the AI's reading is right before the gate is ever opened.

## Key behaviors
- **One conversation = one channel.** The backfill gathers a client's history as separate conversations: one per `phone_calls` transcript (`channel='call'`, id = the phone_calls record id) and one per WhatsApp thread (`channel='chat'`, id = the `chat_wid`). They are never merged. Each is extracted, persisted and reviewed on its own, so a client with one call and one chat gets **two** pending proposals — a chat review is separate from a call review (operator decision, 2026-09-13).
- **Calls are unlabelled; chats are not.** A call transcript is one machine-transcribed line with no speaker labels (27/27 calibration calls). The extractor gets call-specific rules (`CALL_TRANSCRIPT_RULES`): infer the speaker from content; a place the agent offers, suggests or asks about is NOT a client preference and gets no record unless the client responds to it; default `speaker='unknown'` + `preference_applicability='unclear'` when unsure. Chat messages carry `flow` (in/out), so the speaker is a fact.
- **Per-mention provenance.** Every evidence row stores `source_channel`, `source_ref` and `source_timestamp` from the specific turn it came from: the model's `turn` index when that turn actually contains the span, else the unique turn containing the span verbatim, else the conversation's first turn. For a call the ref is the call record itself. Extractor version `geo-extract/v8`.
- **Agent-only chat threads are skipped** (the customer never wrote) — nothing to interpret, no LLM spend.
- **Grammar never decides meaning.** A question («عندكم فلل بالنرجس؟») is still a positive preference; a conditional («إذا مو شمال الرياض ما يناسبني») is still active and hard.
- **Review-first, always.** The orchestrator's only side effect is one `pending` row in `geo_pref_proposals` per conversation; `auto_write_enabled` is forced off in the backfill's run context regardless of the DB flag.
- **Idempotent per conversation.** Re-running a client replaces the prior model rows for each of its conversations (by real conversation id); evidence ids are re-minted, so a calibration batch built on old ids must be rebuilt.
- **Grader is admin-only** and shows, per card, the channel («مكالمة هاتفية» / «محادثة واتساب»), the customer's first name, the ONE transcript the mention came from with the span highlighted, the phrase, and the AI's plain-Arabic reading. Keyboard 1/2/3.

## User flows
1. **Backfill (admin):** `POST /api/geo-preference/backfill {action:'enqueue', clientIds}` → `{action:'process'}` in bounded batches → per client: gather conversations → per conversation: extract → persist evidence + one checkpoint → review-first → pending proposal. Progress via `GET ?runId`.
2. **Grade (admin):** open `/geo-grade?batch=<id>` → cards ordered by client then time → Right / Wrong / Not sure saves one `overall.verdict` label per evidence row → "All done" screen; verdicts are editable by re-visiting a card.
3. **Review (rep):** open proposals listed by `/api/geo-preference/proposals`; confirm / reject / edit via `/api/geo-preference/review` (audit row per action). Confirmed proposals apply only when the gate allows — off today.
4. **Empty states:** a client with no calls and no client-written chat completes with no proposal; a card whose transcript is missing shows «لا يوجد نص محادثة محفوظ لهذا العميل».

## Data touched
- Reads: `unified_records` (models `phone_calls` → `transcription_text`, `call_time`, `client_link`; `chats` → `wid`, `client_link`), `chat_messages` (`id`, `flow`, `body`, `date`), `geo_pref_gate_config`, `geo_pref_calibration_batch.subjects`.
- Writes (service role, never a client record): `geo_pref_evidence` (`conversation_id` = phone_calls id or chat_wid, `source_channel`, `source_ref`, `source_timestamp`), `geo_pref_relations`, `geo_pref_checkpoints` (one per conversation, `turn_id='aggregate'`, `as_of_timestamp` = the conversation's last turn, `member_message_ids` = turn refs), `geo_pref_proposals` (one per conversation), `geo_pref_labels` (grader verdicts), `geo_pref_backfill_jobs`.

## Key files
| File | What it does |
|---|---|
| `api/_lib/geoPreference/backfillPorts.ts` | `gatherClientConversations` (one conversation per call / per chat thread), `persistExtraction` (per conversation), Supabase wiring |
| `api/_lib/geoPreference/backfillRunner.ts` | Per-client job: loop over conversations → extract → persist → review-first |
| `api/_lib/geoPreference/extractor.ts` | Stage-A extraction: system prompt, `CALL_TRANSCRIPT_RULES`, `buildExtractionUserText`, `attributeMentionSource`, validate/repair |
| `api/_lib/geoPreference/ontology.ts` | The shared Evidence / relation / checkpoint types |
| `api/_lib/geoPreference/orchestrator.ts` | Review-first pipeline; sole side effect = one pending proposal |
| `api/geo-preference/backfill.ts` | Admin enqueue / process / progress endpoint |
| `api/geo-preference/simple-grade.ts` | Grader endpoint: items with `source_channel` + `conversation_id`, transcripts keyed by conversation id |
| `src/pages/GeoGrade/GeoGradePage.tsx` | The one-card-at-a-time grader (`/geo-grade`) |
| `api/geo-preference/proposals.ts`, `review.ts` | Rep-facing proposal list + confirm/reject |
| `supabase/migrations/2026-09-03_geo_preference_ability.sql` | The 13 `geo_pref_*` tables |
| `docs/geo-preference-runbook.md` | Ops runbook (§2a: unit of work + re-backfill purge steps) |
| `docs/handoff/geo-pref-channel-provenance.md` | Diagnosis record of the 2026-09-13 provenance bug |

## Open questions / known limitations
- **Re-backfill of the 23 `calib-001` clients has NOT been run yet.** Old rows (`conversation_id` = client uuid) must be purged first and the batch rebuilt — runbook §2a.
- Speaker inference on calls is prompt-driven, not diarized; no call provider supplies speaker labels today. If one does, `transcriptToTurns` already splits labelled lines into per-speaker turns.
- A short span that appears in several turns («الرياض») with no usable `turn` hint falls back to conversation-level provenance (first turn's ref).
- Re-running a client re-mints its checkpoint, and the old pending proposal's `checkpoint_id` is nulled by the FK — the proposal-store dedup then cannot match it, so purge or supersede old pending proposals before a re-run.
