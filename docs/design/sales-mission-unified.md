# Unified Sales Mission — Locked Architecture & Phased Plan

> Status: **ARCHITECTURE LOCKED** (2026-08-07). This is the durable reference for the
> AI-sales consolidation. Do not reopen the decisions below in a later session without a
> concrete reason; extend this doc instead.
>
> Scope: turns the Follow-Up Workspace into a guided sales mission
> (Context → Call → Qualify → Present → Confirm → Done) that reuses the existing
> deterministic matching engine and the live outcome→workflow spine, and integrates the
> rescued live-call preference-capture prototype **without** letting AI silently change
> permanent client data.

---

## 0. Resolved decisions (do not relitigate)

- **Call audio:** desktop **softphone** — rep and client audio are both on the rep's
  machine. Dual-track capture (mic = rep, `getDisplayMedia` tab/system audio = client)
  is the validated approach; two physical tracks ⇒ **certain speaker attribution, no
  diarization**.
- **Capture scope for v1:** full **dual-speaker** now (not a rep-mic-only interim), with
  a graceful mic-only degrade wired underneath as a safety net.
- **Phase 1 Context is deterministic-only.** No AI client summary in Phase 1. The AI
  summary is a later, optional phase decided after Context proves itself.
- **The matching engine is reused, never re-implemented.** All scoring stays server-side
  (`api/_lib/matchAgent.ts` `scoreProject`); the SPA calls `/api/project-finder`. No
  second client-side scorer (avoids the `constraints.ts`-style drift the repo already
  carries).
- **The outcome→workflow spine is untouched.** `completeFollowUp` still writes
  `call_result` + `followup_status='completed'`; client-side workflows fire on that write
  and create the next task.

### Verified state corrections (vs the original brief)

- `prefDraft` **already exists**, lifted to `FollowUpWorkspacePage`, shared by the
  preference editor (`PreferenceSummary`) and the assistant panel. It is **ephemeral** —
  seeded from the client record, discarded on navigation unless explicitly saved.
- Historical `wrong_time` follow-ups = **644** (not "~43"); retired from being *offered*,
  label preserved for history.
- Client Options today is a finder dumping-ground: 3,362 rows, **97% `suitable`**,
  `presented` used on **1**, **0** market listings saved. "Options as memory of what was
  shown" is a genuine behavior change, not just wiring.
- Live mission volume is **~64% `appointment_booking_call`, ~36% `whatsapp_follow_up`**;
  the other 8 configured types are near-zero. Build those two missions first.
- `our_projects` + `all_projects` records are **100% resident in the browser store** at
  all times; only `market_listings` is boot-excluded (slim summary set).

---

## 1. The central rule

> **There is exactly one editable value buffer (the working preference draft). The safety
> boundary is *persistence to the client record*, which is always an explicit rep action
> at end-of-call. AI may populate the *working draft* (ephemeral, visible, flagged by
> origin) but may never write to the client record.**

Because the draft is already ephemeral, letting high-confidence AI fill it is not a
weakening of safety — the persist gate is unchanged. This removes the per-field "Accept"
burden while keeping the guarantee that AI never silently changes permanent data.

---

## 2. Live-qualification state model (LOCKED)

### Stores

- **Working draft** — the single value source of truth. One value per preference slug,
  seeded from the saved client record, held in the app-wide capture singleton so it
  survives navigation. Carries **per-field provenance**: `saved` · `ai_filled` ·
  `ai_changed` · `rep_edited`. Only this is ever persisted (at end-of-call confirm).
- **Exceptions queue** — a small advisory map holding only AI proposals that did **not**
  auto-apply: `conflict` (contradicts a rep edit) and `low_confidence`. These never enter
  the draft and never move the live count until the rep acts.

There is no third store. Per-field status is derived from
`(savedValue, draftValue+provenance, exception?)`.

### Auto-apply policy

| Situation | Action | In draft → live count? | End-of-call review |
|---|---|---|---|
| High-conf, field **empty** in saved, not rep-touched | Auto-fill, green "from the call" | **Yes** | pre-checked (a glance) |
| High-conf, **refines an earlier AI-filled** value (same call) | Auto-update (later wins) | **Yes** | pre-checked |
| High-conf, **differs from a non-empty *saved* value**, not rep-touched | Apply-but-flag, amber "changed from X" | **Yes** | **required**, unchecked |
| Any-conf, field was **rep-edited this call** | Hold as conflict chip; rep value stays | **No** (rep value in draft) | rep value wins unless resolved |
| **Low-confidence**, not rep-touched | Hold as subtle suggestion chip | **No** | optional |
| High-conf, **matches** current value | no-op | (unchanged) | — |

### Two inviolable rules

1. **The rep's live manual edit is never overridden by AI.** A field the rep touched is
   locked; AI can only offer a conflict chip.
2. **A value that already existed is never silently replaced in the draft.** It is
   applied-but-flagged (amber) and requires explicit end-of-call confirmation. Only
   empty-fills pass on a glance.

### Thresholds & visual language (tune at build time)

- Single high-confidence threshold for auto-apply (start ~**80**; tune for *precision*,
  since a wrong auto-fill is cheap but annoying). "Changes a known value" is
  attention-required **regardless** of confidence.
- Green = new-from-call · amber = changed-from-saved · faint = low-confidence.
- The client's quoted phrase on hover (`«ميزانيتي حدود ٢ مليون»`). Correcting = typing
  over the value (which locks the field). No special modes.

---

## 3. Live inventory count (LOCKED)

Purpose: guide the conversation in real time — e.g. `14 → 8 → 3 → 0 مشاريع`.

- **Mechanism:** `draftToMatchRequirements(workingDraft)` → **debounced** count-only
  `/api/project-finder`, `sources: ['our_projects','all_projects']` **only** (market is
  secondary and boot-excluded). Add a `mode:'count'` to the endpoint that reuses
  `scoreProject` but returns `{ our_count, tier2_count }` and skips full serialization/
  market scan/explain. **Zero drift — same engine.**
- **Cheapness:** debounce ~600–800 ms after the draft settles + `AbortController` cancel
  of the in-flight request (the existing `SuggestedProjectsView` pattern). **One request
  per settled edit, never per keystroke.** AI fills arrive in bursts; the debounce
  coalesces them.
- **What counts:** only the working draft (incl. high-confidence AI values). Conflicts and
  low-confidence values are **not** in the draft, so they do not move the count.
- **Relax analysis (on-demand, not live):** when the count is 0 or the rep taps "why so
  few?", a second call computes counts with each hard constraint individually loosened
  (district→nearby, budget±, bedrooms±) and returns which single relaxation unlocks the
  most inventory. **Deterministic impact; the side AI only phrases it. AI never fabricates
  the number.**
- **Deferred optimization:** a clearly non-authoritative in-store prefilter (hard gates
  over resident `our_projects` rollup ranges + district ids) for an instant "~N" that the
  server number always overwrites — only if measured latency demands it. Not in v1.

---

## 4. Presentation, market fallback, Client Options (LOCKED)

- **Presentation** reuses `SuggestedProjectsView` (already pins `our_projects`,
  `buildFinderTabs`). Default the first view to **own projects only**; market behind an
  explicit tab/toggle.
- **Market fallback** stays opt-in server-side (`sources:['market_listings']`, with the
  `too_many`/`needs_district` signals). Gate the market tab behind a fallback condition:
  no/low own inventory **or** the client rejected the own projects. Market remains the
  intelligence + pricing + coverage source, never the primary sales surface.
- **Client Options** reuses `clientOptions.ts` (`saveClientOption`, `updateOptionStatus`,
  `setMainOption`, `eliminateOption`; the `presented` status already exists). **Activate
  the `presented` lifecycle**: a project actually shown in the call gets `presented` +
  facts snapshot, so Options becomes the persistent memory of what was shown/discussed —
  not a bulk dump of `suitable` matches.

---

## 5. End-of-call — one experience, not two popups (LOCKED)

Two transcripts, two timings: **outcome** classification runs on the **Hatif** transcript
via the Fly worker (async, arrives after hangup); **preference** extraction runs on the
**browser capture** (sync, finishes at hangup). Unify the *surface*, not the mechanism.

- Build one shared **`PreferenceReconciliation`** panel (new/changed preferences,
  conflicts to resolve, projects-presented / Client Options changes).
- **Mount it inside `OutcomePanel`**, which is already shared by the Workspace and
  `CallResultConfirmHost`. Same combined surface whether the rep completes in the
  Workspace or is caught later by the `CallResultConfirmHost` badge (the escaped-rep
  case — the reason that component exists).
- **Extend `completeFollowUp`** with optional `preferencePatch` + `presentedOptionIds` so
  outcome + preferences + Options `presented` transitions persist through the **one
  existing funnel** in a single logical commit. `call_result` still triggers the workflow
  spine unchanged.
- The rep reviews/edits/confirms **once**. Per-field in-call Accept is gone.

Edge cases:
- **Navigates away without reviewing:** the capture store is an app-wide singleton, so the
  working draft survives; `CallResultConfirmHost` reads the same draft. No loss.
- **Closes the tab:** ephemeral draft is lost; only the worker's Hatif-outcome remains
  (today's behavior). Acceptable. Optionally stash the pending diff on the *follow-up*
  record (not the client) to survive tab close — **deferred**; keep ephemeral for v1 to
  avoid a second write path.

---

## 6. Live-call prototype disposition

| File | Verdict |
|---|---|
| `src/lib/liveCall/captureStore.ts` | **Reuse ~unchanged** — pure, tested; advisory-merge semantics (never clears a value) fit the exceptions queue |
| `api/_lib/prefExtract.ts` | **Reuse, re-tune slugs** to the **live** clients model; route `districts` → `location`/`location_items` |
| `api/live-call/{transcribe-chunk,extract}.ts` | **Reuse** — read-only, write nothing; keep the read-only guarantee |
| `src/lib/liveCall/client.ts` | **Reuse** — thin fetch helpers |
| `src/lib/liveCall/captureController.ts` | **Reuse core, refactor to a hook** — dual-track assumption confirmed (softphone); add React subscription; prefer "share tab audio" when the softphone is a tab |
| `src/lib/liveCall/__tests__/captureStore.test.ts` | **Reuse** |
| `public/audio-capture-test.html` | **Discard from bundle** — dev reference only |
| Deepgram batch micro-chunk (5s restart) | **Reuse/flag** — boundary-word clipping; provided key is pre-recorded-only; streaming is a later upgrade needing a full-scope key |

Preservation snapshot: commit `85fc458e` on `claude/ai-sales-consolidation-6a4aeb`
(8 files, sha256-verified byte-identical). Not pushed, not deployed.

---

## 7. Phased plan with verification gates

No deploy/push/migrate without explicit approval. Each phase is independently shippable
and gated.

**Phase 0 — Preservation.** ✅ Done (`85fc458e`). Gate: files sha256-verified, tree clean.

**Phase 1 — Mission Brief (deterministic Context only).** Configure per-mission Context
for `appointment_booking_call` + `whatsapp_follow_up`; generic fallback for the rest.
**No AI, no capture.** Gate: opening a real booking-call and WhatsApp follow-up shows
objective, source, prior interaction, preferences, Client Options / main project, and
relevant timeline — with no separate "open task" step.

**Phase 2 — Live inventory count (no capture yet).** Add `mode:'count'` to the finder;
`useOwnInventoryCount` + `InventoryMeter` driven by manual `prefDraft` edits. Gate:
editing budget/district moves the number within one debounce; ≈ one request per settled
edit (verify in the network panel); own-projects only.

**Phase 3 — Working-draft state model + auto-apply (no audio).** Implement the §2 state
model: per-field provenance, auto-apply policy, exceptions queue. Feed suggestions from a
**manual/paste transcript** harness first. Gate: high-conf empty-fills auto-apply and move
the count; a value-change is amber + attention-required; a rep-edited field is never
overridden; **nothing persists to the client record** until end-of-call confirm.

**Phase 4 — Live dual-speaker capture wiring.** Refactor `captureController` into a hook;
`LiveCallBar` (Copy Number + Share Live Audio + mic/client meters); extraction →
suggestions → auto-apply. Gate: dual-track capture attributes speakers correctly;
mic-only degrade works; extraction populates the draft per policy, never the client
record.

**Phase 5 — Presentation + Client Options `presented` lifecycle.** Own-projects-first
view; market behind the fallback gate; "Mark as presented" writes the `presented` status +
facts snapshot. Gate: presenting a project creates/updates a `client_property_options` row
with `presented`; market stays out of the primary view.

**Phase 6 — End-of-call unification.** `PreferenceReconciliation` inside `OutcomePanel`;
extend `completeFollowUp(preferencePatch, presentedOptionIds)`. Gate: one confirm persists
outcome + prefs + presented options; `call_result` still fires the next-task workflow;
`CallResultConfirmHost` shows the same surface for the escaped-rep case. **Explicit spine
regression test.**

Migrations: only Phase 5/6 may need schema (e.g. presented-provenance). None drafted, none
applied.

---

## 8. Risk register

| Risk | Mitigation |
|---|---|
| Accidental writes from AI extraction | AI only touches the ephemeral working draft; the client-record persist is an explicit end-of-call action. |
| Silently changing known preferences | Value-changes are apply-but-flag (amber) + attention-required; only empty-fills pass on a glance. |
| Overriding rep intent | Rep-edited fields are locked; AI can only offer a conflict chip. |
| Stale preference state | Single ephemeral draft seeded once per client; version-aware `saveRecord` rejects stale writes at persist. |
| Transcript/extraction latency | Suggestions are advisory and never block the rep; fast mid-call window + careful end-of-call sweep. |
| Excessive matching requests | Debounce + `AbortController`; count-only mode; own-projects only; on-demand relax analysis. |
| Duplicate confirmation surfaces | One shared `PreferenceReconciliation` + `OutcomePanel`; one funnel `completeFollowUp`; `CallResultConfirmHost` extended, not duplicated. |
| Market listings distracting | Count + first presentation are own-projects only; market gated behind an explicit fallback condition. |
| Breaking the live outcome/workflow spine | `completeFollowUp` contract preserved; new inputs optional; Phase 6 gate includes a spine regression test. |
| Slug/model drift (seed vs live) | Target the live clients model; reconcile `prefExtract` field set with `PreferenceSummary.PREF_SLUGS`; route `districts` → `location_items`. |

---

## 9. Key files (for engineers)

- Workspace: `src/pages/Followups/FollowUpWorkspacePage.tsx` (holds `prefDraft`),
  `components/{MissionHeader,ContextPanel,PreferenceSummary,OutcomePanel,TimelinePanel,SuggestedProjectsView,CallResultConfirmHost}.tsx`.
- Sales process: `src/lib/salesProcess/{config.ts,types.ts,contextResolvers.ts,workflowBindings.ts}`.
- Matching: `src/lib/matching/{requirements.ts,projectFinder.ts,finderRefine.ts,finderHandoff.ts,clientOptions.ts}`; server `api/_lib/matchAgent.ts`, `api/project-finder.ts`.
- Completion funnel: `src/pages/Followups/lib/completeFollowup.ts`.
- Live-call prototype: `src/lib/liveCall/*`, `api/live-call/*`, `api/_lib/prefExtract.ts`.
- Outcome pipeline: `worker/src/runCallAnalysisJob.ts`, `src/lib/callSuggestions/client.ts`.
