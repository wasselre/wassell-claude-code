# Handoff — Geo-preference channel/provenance bug

**Branch:** `claude/whatsapp-ai-agents-count-c8ec81-8ycb1o` (HEAD `8e9ded5` at time of writing)
**Written:** 2026-09-13 · by the cloud session, to be continued locally
**Status (2026-09-13, local session):** **DECIDED + IMPLEMENTED as Option B** — the operator ruled that calls and chats must be extracted and reviewed **separately**: a call transcript has no speaker labels, so a merged extraction could not tell a salesperson's suggestion (القروان) from the customer's choice. Code: `gatherClientConversations` (one `Conversation` per call / per chat thread), per-conversation `persistExtraction`, `CALL_TRANSCRIPT_RULES` + per-mention turn attribution in `extractor.ts` (`geo-extract/v8`), channel-aware grader. **Re-backfill + `calib-001` rebuild NOT yet run** — see runbook §2a for the purge steps. The diagnosis below is kept as the record.
**Safety:** `auto_write_enabled = false` on prod. The ability is review-first; nothing here writes a client record.

---

## 0. One-paragraph summary (plain language)

The "Geography Understanding Ability" reads a customer's **phone calls and WhatsApp messages**, pulls out every place they mention, and reads what they meant. It's supposed to remember **which channel** each mention came from (a call vs a chat). It does not. The backfill pours both channels into one bucket and stamps **every** mention with the label `chat` — even the ones that came from a phone call. In the current calibration set the mentions are actually **mostly phone calls**. So the channel field is a fixed label, not a fact, and you can't trace a mention back to the specific call or message it came from. This is a real data-integrity bug in the extraction/backfill layer, not just a UI label.

---

## 1. How it surfaced

Testing the `/geo-grade` grader, the operator saw a card whose «المحادثة» (conversation) panel was clearly a **phone-call transcription** («ألو ألو ألو … معك صالح مستشار المبيعات»), while the header said «مكالمة العميل» and the underlying data claimed the mention was `chat`. That contradiction is the bug.

The cloud session initially (and wrongly) said "this batch is 100% WhatsApp, zero calls" — because it trusted the `source_channel` column instead of the content. **Do not trust `source_channel` in the current data; it is a constant.**

---

## 2. Proof

### 2a. The data says every mention is `chat`, but the content is call speech
`geo_pref_evidence` rows for batch `calib-001` — all `source_channel = 'chat'`, yet the `mention_span`s are transcribed spoken Arabic (hesitation markers «آآآ», run-on colloquial speech):
- «يعني عندك القدس مي خالص وفوق، لين الوصول»
- «أي، أي حي شمال، شمال شرق شوي ما عندي مشكلة»
- «الوادي، الفلاح، قرطبة، آآآ النرجس، الياسمين»

And `conversation_id` is the **client's UUID**, `source_ref` is literally `client:<client_id>` — i.e. not a real chat thread or call record. No traceability.

### 2b. Calls dominate the calibration set (opposite of what was first claimed)
Query over the 23 `calib-001` clients (run against prod `zhqqsxwealdwqzrbpwyv`):

| metric | value |
|---|---|
| calibration clients | 23 |
| clients with phone-call transcripts | **23 / 23** |
| clients chat-only (no calls) | **0** |
| call-only | 3 |
| both channels merged | 20 |

The deployed grader endpoint's own comment even says *"(Calls dominate the calibration.)"* — `api/geo-preference/simple-grade.ts`.

---

## 3. Root cause (code)

The channel is single-valued end to end, so a merged conversation must lie:

1. **`api/_lib/geoPreference/ontology.ts:71-74`** — `Conversation.channel: 'chat' | 'call'` is **one value for the whole conversation**. `ConversationTurn` (ontology.ts:62) has `text` / `ref` / `timestamp` / `speaker` but **no per-turn channel**.
2. **`api/_lib/geoPreference/backfillPorts.ts:151-198` (`gatherClientConversation`)** — pulls the client's WhatsApp messages (`chat_messages` via linked `chats`) **and** phone-call transcripts (`phone_calls.transcription_text`, split by `transcriptToTurns`), **merges them into one `turns[]`** sorted by timestamp, then returns:
   ```ts
   return { channel: 'chat', id: `client:${clientId}`, turns: bounded };  // line 197
   ```
   `channel:'chat'` and `id:'client:<id>'` are **hardcoded constants**.
3. **`api/_lib/geoPreference/extractor.ts:302,330,389`** — stamps every mention's `source` from the conversation-level value: `source = { channel: conversation.channel, ref: firstRef, timestamp }`. One channel + one ref for all mentions.
4. **`api/_lib/geoPreference/backfillPorts.ts:65` (`persistExtraction`)** — writes `source_channel: e.source.channel` onto each `geo_pref_evidence` row → the constant `'chat'` lands on all 113 rows.

Net: the schema *has* the right fields (`geo_pref_evidence.source_channel`, and `EvidenceRecord.source.channel` in the type), but the pipeline **populates them with a conversation-level constant** that is wrong whenever calls and chats are merged.

---

## 4. Why it matters

- **No real chat/call separation exists** despite the schema column — anything downstream that trusts `source_channel` (weighting calls vs chats, filtering by channel, per-conversation staleness in `versioning.ts`) is operating on a constant.
- **Provenance is lost.** You cannot trace a mention to the specific call recording or chat thread + turn; `conversation_id`/`source_ref` only identify the client.
- **Directly blocks the stated goal**: a modular ability that reads WhatsApp **and** calls and *knows which is which* (foundation for the WhatsApp agent). That requirement is silently unmet today.
- The `/geo-grade` UI compounds it: `src/pages/GeoGrade/GeoGradePage.tsx` hardcodes the header «مكالمة العميل» ("Customer call") for every card regardless of channel, and `simple-grade.ts` doesn't even return `source_channel` per item.

---

## 5. Fix plan (design decision required first)

The core change: make channel + source **per mention**, derived from the actual source turn — not a conversation-level constant.

**Option A — per-turn channel (keep merged, cross-channel context preserved).**
Add `channel` (+ real `ref`) to `ConversationTurn`; tag each turn in `gatherClientConversation` (`chat_messages` → `'chat'` with `chat_wid`; transcript turns → `'call'` with the `phone_calls` record id). Then the extractor must attribute each emitted mention to the **source turn** it came from and copy that turn's `channel`/`ref` into `source`. Requires the extractor to emit a turn reference (or robustly match `mention_span` back to a turn). More work; preserves chronological cross-channel context in one extraction pass.

**Option B — extract per channel (simpler, clean provenance).**
Don't merge. Build one `Conversation{channel:'call', id:<phone_calls id>}` per call and one `{channel:'chat', id:<chat_wid>}` per chat thread, extract each separately. Each evidence row then naturally gets the correct `source_channel` + a real `source_ref`. Downside: loses cross-channel context within a single extraction (e.g. a call mention that refers to something said earlier in chat). Could optionally pass the other channel as read-only context.

**Recommendation:** start with **Option B** for correctness of provenance (it's the smaller, safer change and directly gives traceable `source_ref`), unless cross-channel context turns out to materially improve extraction — then move to A. Confirm with the operator.

### Operational gotchas for the re-backfill (do NOT skip)
1. **Idempotency key changes.** `persistExtraction` deletes existing model-origin rows `WHERE conversation_id = <conversationId> AND origin='model'`. If the new scheme changes `conversation_id` (away from `client:<id>`), the **old rows won't be matched by the delete → orphans/dupes**. Purge existing `origin='model'` evidence/relations/checkpoints for the affected clients first.
2. **`calib-001` will break.** `persistExtraction` **re-mints evidence ids**; the `geo_pref_calibration_batch.subjects` for `calib-001` reference the OLD evidence ids, so after re-backfill the grader shows nothing. **Rebuild the calibration batch** to point at the new evidence ids (re-run / adapt the calibration script — commit `e088e5e`, `RUN_CALIB`-guarded).
3. **Keep `auto_write_enabled = false`** throughout. Review-first; no client writes.
4. Grader label fix falls out once items carry a real per-mention channel: return `source_channel` from `simple-grade.ts` and render «محادثة واتساب» / «مكالمة هاتفية» per card in `GeoGradePage.tsx`.

---

## 6. Live state & how to test

- **Prod project:** `wassell-prod` = `zhqqsxwealdwqzrbpwyv`.
- Migration `supabase/migrations/2026-09-03_geo_preference_ability.sql` is **applied**. 13 `geo_pref_*` tables; 113 evidence, 26 checkpoints, 23 proposals; `auto_write_enabled=false`.
- Calibration batch `calib-001` = `09fed81d-a657-46eb-89d9-251974c389b1` (113 subjects).
- Grader is **live on production** (`main`, SHA `19677e5`+): `https://app.wassel.re/geo-grade?batch=09fed81d-a657-46eb-89d9-251974c389b1` (admin-only).
- These handoff artifacts (this doc + the `e088e5e` calibration script + a generated-PRD sync) are the only things on this branch not yet on `main`; open **draft PR #40**.

---

## 7. Key files

| Concern | File |
|---|---|
| Conversation/turn/evidence types | `api/_lib/geoPreference/ontology.ts` |
| Conversation assembly (the bug) | `api/_lib/geoPreference/backfillPorts.ts` (`gatherClientConversation`, `persistExtraction`) |
| Extraction (stamps `source`) | `api/_lib/geoPreference/extractor.ts` |
| Orchestration (review-first) | `api/_lib/geoPreference/orchestrator.ts` |
| Backfill driver + safeguards | `api/geo-preference/backfill.ts`, `llmBudget.ts`, `backfillClaim.ts`, `versioning.ts`, `observability.ts` |
| Grader endpoint (transcript panel) | `api/geo-preference/simple-grade.ts` |
| Grader page (hardcoded «مكالمة») | `src/pages/GeoGrade/GeoGradePage.tsx` |
| Calibration run script | committed at `e088e5e` (`RUN_CALIB`-guarded) |
| Ops runbook | `docs/geo-preference-runbook.md` |

## 8. Resume locally

```bash
git fetch origin
git checkout claude/whatsapp-ai-agents-count-c8ec81-8ycb1o
git pull
bash scripts/bootstrap-session.sh   # unseals secrets + installs deps
```
Then start Claude Code in the repo and point it at this file.
