> **STATUS (2026-09-22) — GOVERNING DOCUMENT: `01-plan-v9.md` (v8 and earlier superseded).** These six per-issue resolutions were written against plan v2, BEFORE v3 and v4. On ANY conflict, `01-plan-v4.md` governs; this file is evidence and design rationale, not implementation instructions. Every SQL/TS skeleton here is ILLUSTRATIVE — it shows the shape of a fix, not code to apply. References to "plan v2", `01-plan-v2.md:NNN` line numbers and operator "decision #N" use v2 numbering and are STALE. Known supersessions, each marked inline below with `⚠ SUPERSEDED`: (1) P-488…491 are Band C (`offered_to NULL`, `waiting_reason NULL`), NOT "offered"; only `mos_refill` ever sets `offered_to`. (2) The reservation status CHECK is ONE constraint with all six values `reserved, bound, stale, consumed, released, superseded` (Issue 1's fragment omits `superseded`, Issue 4's omits `bound`; run alone they clobber each other). (3) The subject+step unique index is PARTIAL over live statuses `reserved, stale, bound, consumed` (the unconditional index and its global 0-duplicate assertion are wrong once superseded rows are retained). (4) `mos_completion_events` binds an event to (actor, operation, task, request hash) — the actor-only table and replay check here are superseded. (5) Risk: the current step is the subject's single OPEN task, remaining steps are the pinned positions after it, and there is no all-done→on_track fallback. (6) The commit guard derives same-day from `row_key`, never the free-text `spread`; retirement happens per campaign in `commit_month` BEFORE the one union guard. (7) Band predicates are column-only; `waiting_reason='offered'` is never written.



# ISSUE Reviewer Issue 3 — Plan v2 §5 (idempotent completion) fixes the DB transition (event-id under the ledger lock stops a du  [label=None]
> ⚠ SUPERSEDED by 01-plan-v9.md — §5 — the replay rule here is actor-only (superseded by request binding), and the Meta enqueue is not atomic (superseded by mos_meta_ad_enqueue).
VERDICT: confirmed
EVIDENCE: All four sub-claims verified against live code + live DB (2026-09-22).

1) API rejects a closed task before the RPC. api/marketing-os.ts:2409-2417 (task_complete): `tq = sb.from('workflow_role_tasks').select(...).eq('subject_table','mos_content').eq('status','open')`; `tq = taskId ? tq.eq('id', taskId) : tq.eq('subject_id', contentId)`; `const cur = await tq.maybeSingle(); ... if (!cur.data) return jsonError(404,'no open task found')`. So an already-closed task (status='done') yields no row → HTTP 404. The ROW twin differs: api/marketing-os.ts:5704-5720 does the same `status='open'` query but on miss returns HTTP 409 `MOS:STEP_ALREADY_CLOSED`. Asymmetry is real: content path 404, row path 409; neither returns the stored success on a same-action retry. CONFIRMED.

2) The `call` helper offers no idempotency and the retry is user-driven. src/lib/marketingOS/client.ts:448-495 — 30s AbortController; on timeout/network drop it throws a "server is busy, try again" MosApiError (no auto-retry, no Idempotency-Key header, no event id). completeTask (client.ts:563-581) sends only `task_id`/`result`/`note`/`targets`. rowClient.ts:210 completeRowTask sends `row_id`/`task_id` only. So "response lost → user clicks again" = a fresh request with no dedupe. CONFIRMED.

3) Side effects run after the DB transition and (except promote) are not idempotent. In task_complete the atomic RPC returns at api/marketing-os.ts:2499-2508; THEN, post-commit: mos_promote_approval_asset at 2537; enqueueMetaAdJob at 2552; wakeWorker() 2559; emitNotify (task_assigned/changes_requested) at 2611-2634. row_task_complete mirrors this: RPC at 5763, promote-per-member at 5808-5817, emitNotify at 5838-5861 (no Meta ad on the row path — confirmed by the code comment at 5672-5676). CONFIRMED that side effects are post-transition.
   • Meta enqueue is NOT idempotent: api/_lib/marketing/metaAutoAd.ts:210 `const jobId = crypto.randomUUID();` then inserts generation_jobs with `id: jobId` (line 251-271). Live DB: generation_jobs has NO dedupe/unique key beyond the PK on the random id — pg_indexes shows only generation_jobs_pkey(id) plus non-unique btree idx on generation_id/record_id/message_id/user_id; pg_constraint shows PK(id) + kind/status/user CHECKs only. So a second call = a second queued 'meta-ad' job. The worker has a PARTIAL guard: worker/src/runMetaAdJob.ts:1096 `if (adRow.platform_ad_id) throw ...` — protects only when the SAME ad_row_id is reused AND the first job already wrote platform_ad_id; a retry that re-resolves a fresh placeholder / inserts a new mos_execution_ads row bypasses it and produces a second Meta ad. CONFIRMED.
   • Notifications are NOT idempotent: emitNotify (api/marketing-os.ts:1455-1486) calls notify_emit; live body inserts a fresh public.notifications row (new id v_nid) every call, and the push_outbox dedupe_key is `'ntf:'||v_nid||':'||v_uid` — keyed on the fresh notification id, so a replay produces a NEW notification and a NEW push. No (event,kind,recipient) key exists. CONFIRMED.
   • Approval-asset promote IS already idempotent (refinement to the claim): mos_promote_approval_asset body returns early if a `role LIKE 'final%'` link exists and otherwise INSERTs with `ON CONFLICT (asset_id, content_id) DO UPDATE`. Safe to replay/recover. The in-RPC mos_content_approvals insert is also idempotent (`ON CONFLICT (content_id, step_key, round) DO UPDATE`), as is the submit snapshot upsert (onConflict content_id,round at 2485/5749) and the rejected_note update.

4) The DB transition is subject-bound today (the defect the plan's task-id fix targets). Live workflow_advance_role_path body: `PERFORM public.mos_ledger_lock();` (first stmt) then `SELECT * INTO v_task FROM workflow_role_tasks WHERE subject_table=p_subject_table AND subject_id=p_subject_id AND status='open' FOR UPDATE; IF NOT FOUND THEN RAISE 'MOS:NO_OPEN_TASK'` — no task_id, no event_id. Two different-event requests on the same open task serialize on the advisory lock; the second re-selects "the open task for this subject" = the NEWLY opened successor and advances it again. CONFIRMED (matches plan §5 trace and briefing defect #10).

5) mos_completion_events does NOT exist yet: SELECT to_regclass('public.mos_completion_events') → null (public.notifications and public.push_outbox exist). So the whole idempotency+durability surface is greenfield.

6) Caller audit for the RPC: grep of api/ worker/ supabase/functions/ src/ finds exactly TWO real `.rpc('workflow_advance_role_path')` call sites — api/marketing-os.ts:2499 (task_complete) and :5763 (row_task_complete). The plan §5 list also names rowTasks.ts / releaseMaterial.ts / worker / cron as callers, but those files only MENTION the function in comments (rowTasks.ts:41,61; releaseMaterial.ts:40) — they do not call it. Refinement: the "audit every caller before parameters become required" work is smaller than the plan states (2 sites, both in one file).

7) content_revise / transfer replay bugs (adjacent, same family): content_revise body does NOT `PERFORM mos_ledger_lock()` (plan §5 flags this correctly) though its task creation is idempotent (reuses an already-open target-step task at the same round). workflow_role_task_transfer appends `note = note || 'transferred by … at …'` on every call with no replay guard — a replayed transfer stacks notes. Both take no p_event_id today.

CONTRACT: CONTRACT — completion is idempotent end to end, side effects are durable, deduplicated and recoverable. One shared effect runner, three entry points (happy path, replay, recovery).

A. Event identity and authentication.
 - The SPA generates ONE `event_id` (uuid v4) per user action (opening the approve/submit/request-changes dialog) and reuses it across the choose→pick→submit cycle AND across every retry of that same action. It is sent as body field `event_id` (accept an `Idempotency-Key` header as an alias). A different button press = a new event_id.
 - Authenticated binding: the RPC stores `actor_user_id = wassell_app_user_id(auth.uid())` on the event. A replay whose event_id exists but was created by a different actor → `MOS:EVENT_OWNER_MISMATCH` (ERRCODE insufficient_privilege → API maps to HTTP 403). This prevents one user replaying another's completion via a shared/leaked key.

B. The API stops pre-checking status (removes the 404/409 precheck at 2409-2417 and 5704-5720). It:
 1. Reads the task by id WITHOUT a status gate (a resolve, not a reject) to get subject_id, step_key, workflow_version_id, round, status. Task id absent entirely → 404 TASK_NOT_FOUND.
 2. FRESH-only work: if status='open' AND result='approved' AND the step carries auto_meta_ad → resolve the Meta target (resolveAutoAdTarget). A 'choose' still returns 409 and changes nothing (unchanged behavior). If status != 'open', skip resolution — the RPC will replay-or-reject.
 3. Calls the RPC forwarding p_task_id, p_event_id, p_result, p_note, p_targets, p_finish, p_return_to, and p_meta_target (the resolved concrete target or NULL/skip).
 4. Runs the shared effect runner keyed by event_id (idempotent — skips effects already 'done').
 5. Returns the RPC outcome (which carries `replayed: true` on a replay) plus the effect outcomes.

C. workflow_advance_role_path (and its row usage) — under mos_ledger_lock (first statement, as today):
 1. Replay check FIRST: SELECT outcome, side_effects, actor_user_id FROM mos_completion_events WHERE event_id=p_event_id. If found: enforce the actor bind (else 403), and RETURN outcome || {'replayed':true}. No transition.
 2. Lock the SPECIFIC task: SELECT * INTO v_task FROM workflow_role_tasks WHERE id=p_task_id AND subject_table=p_subject_table AND subject_id=p_subject_id FOR UPDATE. NOT FOUND → RAISE 'MOS:TASK_NOT_FOUND' (404). If v_task.status <> 'open' → RAISE 'MOS:TASK_ALREADY_CLOSED' ERRCODE 'WS409' (API maps to HTTP 409). This is the exactly-once guard: a different event id on a closed/advanced task can never re-select the successor (the subject-bound select is gone).
 3. Auth + requirements + transition + open-next + consume-reservation: unchanged from today.
 4. Build the side_effects manifest from what the transition produced (all inside the transaction, so recovery is possible even if the API dies at commit+ε):
    - if p_meta_target is a concrete target → {kind:'meta_ad', status:'pending', target:<jsonb>, ad_row_id:<if known>, job_id:<mos_meta_job_id(event_id)>}
    - if result='approved' → {kind:'promote_asset', status:'pending', content_ids:[…]} (idempotent; cheap; still tracked)
    - if a next task opened with an assignee → {kind:'notify', status:'pending', recipient:<uid>, event:'task_assigned'|'changes_requested', …}
 5. INSERT mos_completion_events(event_id PK, task_id, subject_table, subject_id, actor_user_id, result, outcome jsonb, side_effects jsonb, created_at) as the LAST write of the transaction (PK is the backstop; the lock is the primary serializer). On any rollback the event AND the transition vanish together.
 6. RETURN outcome (closed_task_id, opened_task_id, next_step_key, round, done).

D. Each side effect becomes idempotent + durable.
 - Meta enqueue: replace metaAutoAd.ts:210 `crypto.randomUUID()` with a DETERMINISTIC id `jobId = mos_meta_job_id(event_id)` (uuid v5 of event_id in the 'meta-ad' namespace). generation_jobs INSERT gains `... ON CONFLICT (id) DO NOTHING` (add a small ON CONFLICT; PK already unique). Pin ad_row_id: reuse the placeholder if present; when a NEW mos_execution_ads row must be created, derive its id deterministically from event_id and INSERT ON CONFLICT (id) DO NOTHING, and write the chosen ad_row_id back into the event's side_effects. Result: any number of enqueue attempts (happy/replay/recovery) → exactly one generation_jobs row + one ad row. The worker's existing platform_ad_id guard (runMetaAdJob.ts:1096) is the second layer.
 - Notifications: add `dedupe_key text` to public.notifications with a UNIQUE partial index (dedupe_key WHERE dedupe_key IS NOT NULL); add p_dedupe_key to notify_emit and INSERT … ON CONFLICT (dedupe_key) DO NOTHING; derive the push_outbox dedupe_key from p_dedupe_key (not v_nid) when supplied. emitNotify passes `dedupe_key = event_id || ':' || event || ':' || recipient`. Replay/recovery re-emit → no-op.
 - Promote asset: already idempotent (mos_promote_approval_asset); keep, still tracked so recovery re-runs a pending one.
 - After each effect succeeds the runner calls mos_completion_effect_done(p_event_id, p_kind, p_recipient?, p_outcome) which flips that manifest element to 'done' (a single row-locked jsonb merge — same posture as clean_text_entry_patch; no version check, no 40001).

E. Recovery. A TS cron pass (extend /api/cron/planning-sweep or a dedicated /api/cron/mos-effects-recover) selects mos_completion_events where any side_effect.status='pending' AND created_at < now()-interval '2 min', and runs the SAME runCompletionSideEffects(event) routine. Because every effect is idempotent-by-key, recovery after a crash between the RPC commit and the API's side-effect calls enqueues exactly one job / one notification and then marks it done. (The SQL refill cannot host this — Meta enqueue builds generation_jobs+ad-row rows in TS — so recovery is TS-side; it is NOT the SQL mos_refill.)

F. Expected results (the reviewer's clarifications):
 - Concurrent requests with the SAME event id → both return the same success; one performs the transition + effects, the other replays (effects run once via dedupe keys).
 - A different event id targeting the same already-completed task → the second gets MOS:TASK_ALREADY_CLOSED (HTTP 409), successor untouched.
 - A replay of the same event id by a different user → MOS:EVENT_OWNER_MISMATCH (HTTP 403).
 - Lost response then retry with the same event id → same success, effects exactly once.
 - Crash between the RPC commit and job creation → recovery enqueues exactly one job.

G. SQLSTATE compliance (CLAUDE.md): no new RAISE uses 40001/40P01. TASK_ALREADY_CLOSED → WS409; EVENT_OWNER_MISMATCH → insufficient_privilege; TASK_NOT_FOUND → no_data_found. The API classifies by MESSAGE first (MOS:TASK_ALREADY_CLOSED→409, MOS:EVENT_OWNER_MISMATCH→403, MOS:TASK_NOT_FOUND→404), matching the existing row-path 409 pattern.

SKELETON:
-- ============ MIGRATION (SQL) ============
-- 1. completion events (greenfield; to_regclass confirmed null today)
> ⚠ SUPERSEDED by 01-plan-v9.md — §5a — the event table binds (actor, operation, task NULLable, request_hash, request_snapshot); this actor-only DDL and its replay check are replaced.
CREATE TABLE public.mos_completion_events (
  event_id      uuid PRIMARY KEY,
> ⚠ SUPERSEDED by 01-plan-v9.md — §5a — the event table binds (actor, operation, task NULLable, request_hash, request_snapshot); this actor-only DDL and its replay check are replaced.
  task_id       uuid NOT NULL,
  subject_table text NOT NULL,
  subject_id    uuid NOT NULL,
  actor_user_id uuid,
  result        text NOT NULL,
  outcome       jsonb NOT NULL,           -- the returned transition payload
  side_effects  jsonb NOT NULL DEFAULT '[]',  -- [{kind,status,...}]
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mos_completion_events_pending_idx
  ON public.mos_completion_events (created_at)
  WHERE side_effects @> '[{"status":"pending"}]';

-- 2. notification dedupe surface
ALTER TABLE public.notifications ADD COLUMN dedupe_key text;
CREATE UNIQUE INDEX notifications_dedupe_key_uq
  ON public.notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;
-- notify_emit gains p_dedupe_key; INSERT ... ON CONFLICT (dedupe_key) DO NOTHING;
--   push_outbox dedupe_key := COALESCE(p_dedupe_key||':push', 'ntf:'||v_nid||':'||v_uid)

-- 3. deterministic meta job id
CREATE FUNCTION public.mos_meta_job_id(p_event_id uuid) RETURNS uuid
  LANGUAGE sql IMMUTABLE AS
$$ SELECT uuid_generate_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid,
                           'meta-ad:'||p_event_id::text) $$;

-- 4. effect-status flip (single row-locked jsonb merge; no version check, no 40001)
CREATE FUNCTION public.mos_completion_effect_done(
  p_event_id uuid, p_kind text, p_recipient uuid DEFAULT NULL, p_outcome jsonb DEFAULT '{}')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.mos_completion_events e
     SET side_effects = (
       SELECT jsonb_agg(CASE
         WHEN el->>'kind' = p_kind
          AND (p_recipient IS NULL OR el->>'recipient' = p_recipient::text)
         THEN el || jsonb_build_object('status','done','outcome',p_outcome)
         ELSE el END)
       FROM jsonb_array_elements(e.side_effects) el)
   WHERE e.event_id = p_event_id;
END $$;

-- 5. workflow_advance_role_path — new signature + replay/closed logic (skeleton)
CREATE OR REPLACE FUNCTION public.workflow_advance_role_path(
  p_subject_table text, p_subject_id uuid, p_result text,
  p_note text DEFAULT NULL, p_targets jsonb DEFAULT '[]', p_finish boolean DEFAULT false,
  p_return_to text DEFAULT NULL,
  p_task_id uuid DEFAULT NULL, p_event_id uuid DEFAULT NULL,   -- NEW
  p_meta_target jsonb DEFAULT NULL)                            -- NEW
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_task workflow_role_tasks%ROWTYPE; v_ev record; v_actor uuid;
        v_outcome jsonb; v_effects jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();
  v_actor := public.wassell_app_user_id(auth.uid());
  IF p_event_id IS NULL OR p_task_id IS NULL THEN
    RAISE EXCEPTION 'MOS:EVENT_AND_TASK_REQUIRED';   -- transition window: log loudly for legacy callers
  END IF;
  -- (1) replay
  SELECT outcome, actor_user_id INTO v_ev
    FROM public.mos_completion_events WHERE event_id = p_event_id;
  IF FOUND THEN
    IF v_ev.actor_user_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'MOS:EVENT_OWNER_MISMATCH' USING ERRCODE='insufficient_privilege';
    END IF;
    RETURN v_ev.outcome || jsonb_build_object('replayed', true);
  END IF;
  -- (2) lock the SPECIFIC task
  SELECT * INTO v_task FROM public.workflow_role_tasks
   WHERE id=p_task_id AND subject_table=p_subject_table AND subject_id=p_subject_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MOS:TASK_NOT_FOUND'  USING ERRCODE='no_data_found'; END IF;
  IF v_task.status <> 'open' THEN
    RAISE EXCEPTION 'MOS:TASK_ALREADY_CLOSED' USING ERRCODE='WS409';   -- NEVER 40001
  END IF;
  -- (3) auth + requirements + close + approvals + open-next + consume  ... (existing body) ...
  --     produce v_outcome (closed_task_id, opened_task_id, next_step_key, round, done)
  -- (4) build manifest
  v_effects := '[]'::jsonb;
  IF p_result='approved' THEN
    v_effects := v_effects || jsonb_build_array(jsonb_build_object('kind','promote_asset','status','pending'));
  END IF;
  IF p_meta_target IS NOT NULL AND (p_meta_target->>'kind')='target' THEN
    v_effects := v_effects || jsonb_build_array(jsonb_build_object(
      'kind','meta_ad','status','pending','job_id',public.mos_meta_job_id(p_event_id)::text,
      'target',p_meta_target->'target'));
  END IF;
  -- notify element added when v_outcome.opened_task_id has an assignee (recipient,event)
  -- (5) record event LAST
  INSERT INTO public.mos_completion_events(event_id,task_id,subject_table,subject_id,
         actor_user_id,result,outcome,side_effects)
  VALUES (p_event_id,p_task_id,p_subject_table,p_subject_id,v_actor,p_result,v_outcome,v_effects);
  RETURN v_outcome;
END $$;

// ============ API (api/marketing-os.ts task_complete) ============
// remove the status='open' precheck (2409-2417). Instead:
const taskId = str(body.task_id);
const eventId = str(body.event_id) ?? req.headers.get('idempotency-key');
if (!taskId || !eventId) return jsonError(400, 'task_id and event_id are required');
const meta = await sb.from('workflow_role_tasks')
  .select('id, subject_id, status, step_key, workflow_version_id, round')
  .eq('id', taskId).maybeSingle();          // resolve, NOT a status gate
if (dbFail(meta.error)) return dbFail(meta.error)!;
if (!meta.data) return jsonError(404, 'no task with this id');
const t = meta.data as ...; const contentId = t.subject_id;
let metaTarget: unknown = null;
if (t.status === 'open' && result === 'approved' && isAutoAdStep(...)) {
  const plan = await resolveAutoAdTarget(svcPre, contentId, str(body.ad_set_id));
  if (plan.kind === 'choose') return json409ChooseAdSet(plan);   // unchanged
  metaTarget = plan;                                              // target | skip
}
const adv = await sb.rpc('workflow_advance_role_path', {
  p_subject_table:'mos_content', p_subject_id:contentId, p_result:result, p_note:note,
  p_targets:targets, p_finish:finishPath, p_task_id:taskId, p_event_id:eventId, p_meta_target:metaTarget });
if (adv.error) return mapCompletionError(adv.error); // MSG-first: ALREADY_CLOSED→409, OWNER_MISMATCH→403, NOT_FOUND→404
const payload = adv.data;                             // may carry replayed:true
await runCompletionSideEffects(sb, svc, { eventId, payload, contentId, metaTarget }); // idempotent, keyed by eventId
return jsonOk({ ..., replayed: payload.replayed === true });

// ============ metaAutoAd.ts enqueueMetaAdJob ============
- const jobId = crypto.randomUUID();
+ const jobId = deterministicMetaJobId(input.eventId);   // uuid v5 of event_id
  ... generation_jobs.insert({ id: jobId, ... })
+ ,{ onConflict: 'id', ignoreDuplicates: true }          // ON CONFLICT (id) DO NOTHING
  // new ad row (no placeholder): id derived from event_id, insert ON CONFLICT DO NOTHING

// ============ runCompletionSideEffects (shared: happy path, replay, recovery) ============
for (const eff of event.side_effects.filter(e => e.status === 'pending')) {
  if (eff.kind === 'promote_asset') { await sb.rpc('mos_promote_approval_asset', {p_content_id}); }
  if (eff.kind === 'meta_ad')       { await enqueueMetaAdJob(svc, { ...eff.target, eventId }); wakeWorker(); }
  if (eff.kind === 'notify')        { await emitNotify(sb, { ...eff, dedupe_key: `${eventId}:${eff.event}:${eff.recipient}` }); }
  await sb.rpc('mos_completion_effect_done', { p_event_id:eventId, p_kind:eff.kind, p_recipient:eff.recipient ?? null });
}

TESTS:

IMPACTS: Plan §5 (Completion cannot be repeated) is REPLACED by this contract's superset. §5 already had event_id + p_task_id + replay + TASK_ALREADY_CLOSED; add: authenticated actor-bind (403 EVENT_OWNER_MISMATCH), the side_effects jsonb manifest on mos_completion_events, deterministic Meta job id + ON CONFLICT, notification dedupe_key, and the TS recovery pass. TASK_ALREADY_CLOSED must be ERRCODE WS409 (not the plan's bare RAISE, which would be P0001→400) — §5's raise list must be re-checked against the CLAUDE.md 40001 rule. | Plan §5 caller-audit scope is smaller than stated: the RPC has exactly TWO callers (api/marketing-os.ts:2499, :5763), not five. rowTasks.ts/releaseMaterial.ts/worker/cron only reference it in comments. The 'transition window that logs loudly for subject-only callers' still applies to those two sites, but making p_task_id/p_event_id required is a 2-site change. | Plan §3 (one decider / mos_task_open / mos_refill): the effect runner is TS-side and CANNOT be folded into the SQL mos_refill (Meta enqueue writes generation_jobs + mos_execution_ads in TS). The recovery pass is a separate TS cron step, not part of refill. §3's 'refill is the sole decider' is about ASSIGNMENT; side-effect recovery is orthogonal and must be documented as its own cron responsibility. | Plan §6 migration ordering: this contract adds a table (mos_completion_events), a notifications column + unique index, notify_emit signature change (add p_dedupe_key, backward-compatible via default), mos_meta_job_id, mos_completion_effect_done, and the advance-RPC signature change. All backward-compatible if new params default; but the API and RPC must ship together (the API forwards event_id; the RPC requires it). Sequence: DB migration first (defaults keep old API working), then deploy API, then flip event_id to required. | content_revise (plan §5) needs the SAME treatment for completeness: add mos_ledger_lock() (currently absent) + p_event_id replay-guard. It has no Meta/notify side effect inside the RPC, so its manifest is empty, but a replayed revise should not re-run its API-side notify. Lower priority than task_complete but same family. | workflow_role_task_transfer appends its note on every call (transfer.json body) — a replayed transfer stacks notes. Add p_event_id + short-circuit (plan §5 named this). Not a completion path but shares the idempotency gap. | SPA (§9 open decision / UI scope): client.ts completeTask, rowClient.ts completeRowTask, and the approval components (ApprovalSheet.tsx, RequestChangesModal.tsx, RowDesign.tsx, RowWriter.tsx) must generate ONE event_id per user action and reuse it across the ad-set choose→pick and across retries; the `call` helper (client.ts:448) must forward it (body field or Idempotency-Key header). The content path's 404 'no open task found' must become the row path's friendly 409 'already done — refresh' so both retries read the same. This is a bilingual, RTL UI change → PRD docs/prd (marketing-os / ai-agent area) update required. | The worker's platform_ad_id guard (runMetaAdJob.ts:1096) stays as defense-in-depth but is no longer the primary dedupe; the primary is the deterministic generation_jobs id. Do not remove it. | generation_jobs is a SHARED queue (image/video/clean-text/meta-ad/...). Adding ON CONFLICT (id) DO NOTHING to the meta-ad insert is scoped to metaAutoAd.ts and does not touch other lanes; but the deterministic-id pattern should be documented so no other lane assumes random ids collide-free.
OPEN: Where should the recovery pass live and at what cadence — inside /api/cron/planning-sweep (every 10 min, runs after refill) or a dedicated endpoint? 10 min recovery latency for a lost Meta ad on launch day may be too slow; a 1-2 min dedicated cron may be warranted. Operator to confirm acceptable recovery latency. | Ad-row identity when NO placeholder exists: derive the new mos_execution_ads id deterministically from event_id (recommended, keeps recovery pure) vs create the ad row inside the RPC transaction (fully durable but moves ad-row creation from TS to SQL). Which is preferred? For paid creatives a placeholder normally exists (created at plan commit), so this only bites the no-placeholder case. | event_id lifetime across the ad-set choose→pick flow: reuse the same event_id (recommended — the first 'choose' creates NO event) or mint a fresh one on re-submit? Confirm the SPA reuses it so a lost response after the pick is still idempotent. | notify_emit currently has NO idempotency across ANY caller (shoot delivery, campaign save, etc. all insert fresh notifications). Adding p_dedupe_key is opt-in per call; do we want to backfill dedupe keys on other emitNotify sites, or scope this strictly to completion notifications for now? | Should replay of an approval that is still mid-side-effect (event exists, meta_ad still 'pending') RUN the pending effect synchronously in the replay response, or only mark it and let recovery handle it? Recommended: run it synchronously (the runner already skips 'done'), so a user retry both returns success AND completes the ad without waiting for the cron. | Retention/GC for mos_completion_events: after all side_effects are 'done' and the row is older than N days, is it safe to prune, or must it be kept for the audit trail? Keeping it forever also keeps replay idempotency valid forever (a very late duplicate still replays); pruning trades that for table size.
PLAIN: The reviewer is right. Today, when someone clicks "approve" and the network drops the reply, the finish already happened on the server but the person sees an error; if they click again, the app says "no open task" (a confusing 404) instead of "done — here's your result". Worse, the useful work that runs AFTER the finish — creating the Meta ad, sending the notification, marking the design as the final file — happens in a second step that isn't protected: if we simply replay and re-run that step we could create the ad twice (each attempt makes a brand-new job id with nothing stopping duplicates) and send the notification twice; and if the server crashes in the gap between finishing and creating the ad, the ad is silently never made (the 22 Sep launch had zero ads live). The one piece already safe is the "mark as final file" step, which checks before it writes.\n\nThe fix: give every button-press a unique ticket number (event id). The database records that ticket the moment it finishes the task, together with a checklist of the follow-up jobs it still owes (make the ad, notify the next person, mark the file). Finishing is now tied to that ticket, so a duplicate or double-click can't push the work forward twice — the second one either gets the same success back (same ticket) or a clean "already done, refresh" (a different ticket on a task that's already finished), and a replay by a different person is refused. Each follow-up job is made repeat-proof: the ad job gets a fixed id derived from the ticket so it can only exist once, notifications get a de-dupe key so they send once, and a background sweep every couple of minutes finishes any checklist item the server crashed before doing — making exactly one ad, no more, no less. Net effect: click as many times as you like, lose the connection whenever, the outcome is always exactly one finish and exactly one of each follow-up. The change touches two API handlers, one database function, the Meta enqueue helper, the notification function, a small new table, and the approval buttons in the app; it must NOT use the forbidden retry error codes, and the app screens need the shared "one ticket per action" behavior plus a PRD update.


# ISSUE Reviewer Issue 2 — "Publication risk can remain 'on track' after publication has become impossible." The plan v2 publica  [label=None]
> ⚠ SUPERSEDED by 01-plan-v9.md — §1c — the time-aware in-production math stands; the step selection and the terminal fallback in this section are replaced (see markers below).
VERDICT: confirmed
EVIDENCE: THE BUGGY FORMULA (verbatim, docs/reviews/mos-assignment-redesign-2026-09-22/04-live-state-tables-22sep.md, section "[deadline-model] SQL skeleton — mos_publication_risk", lines ~551-566):
  FOR r IN SELECT * FROM mos_plan_chain(...) ORDER BY sort_order LOOP
    IF NOT v_started THEN
      v_anchor := COALESCE((SELECT t.opened_at FROM workflow_role_tasks t WHERE ... AND t.step_key=r.step_key AND t.status='open' LIMIT 1), r.plan_handoff_at);
      v_cursor := v_anchor; v_step := r.step_key; v_started := true;
    END IF;
    IF v_started THEN v_cursor := mos_work_due_at(v_cursor, r.target_hours); END IF;
  END LOOP;
  projected_ready_at := COALESCE(v_cursor, required_ready_at);
Three defects, all present: (1) v_anchor is a FIXED past timestamp (opened_at); now() is never read, so projected_ready cannot slide while the step ages. (2) No blocked-step handling. (3) downstream steps fold target straight off v_cursor with NO GREATEST(booked_day) floor, so early upstream work pretends the designer accepted early work. Also note v_anchor uses opened_at, which contradicts plan §1c's deadline anchor assigned_at (01-plan-v2.md line 65) — an internal inconsistency.

required_ready is set to `max(plan_due_at) FROM mos_plan_chain` (same skeleton) — the last production step's deadline, NOT a publication instant. This is exactly the "final approval lands on the publication day is insufficient" gap.

LIVE REPRODUCTION on the running month (read via read-only RPC, now = 2026-09-22 10:11 Riyadh, q_now.json):
- The 6 launch paid creatives P-471..476 each have writing done+approved and design OPEN round 1 on سارة since 2026-09-20 19:31/19:32 (q_open.json; blocked=false). Their activation date is refresh_on r0 = 2026-09-22 (already 10 h in the past).
- Buggy formula: anchor = design.opened_at = 2026-09-20 19:31; fold design 4h + design_writer_review 2h + design_review 2h = +8h → projected_ready = 2026-09-21 03:31. required_ready (=max plan_due_at, worked-example-2 in 04 gives design_review plan_due 2026-09-22 14:00). 2026-09-21 03:31 ≤ 2026-09-22 14:00 → risk='on_track'. The formula reports ON_TRACK for six ads that at 10:11 today have 0 designs finished and 0 ads on Meta (04 tables launch_creatives, launch_meta: 3 running executions, 6 ad sets, 0 execution_ads). This is the reviewer's failure, verbatim, on live data.

ACTIVATION MECHANICS (how/when a paid ad goes live — the required-ready anchor for paid):
- activate_on = mos_refresh_cycles.refresh_on, a civil DATE (supabase/migrations/2026-09-15_23_reservation_cycle_bind.sql:614-621, the mos_creative_slots INSERT selects refresh_on into activate_on).
- worker/src/runRefreshCycleJob.ts:1173-1185 activateDueSlots: claims slots status='ready', cycle_id IS NULL, ad_row has platform_ad_id, `.lte('activate_on', today)` with today=riyadhToday() (civil date, line 1177); sets Meta status ACTIVE and stamps activated_at.
- worker/src/marketing/refreshLane.ts:27 POLL_MS=60_000; refreshLane.ts:88 runRefreshCycleSweep each tick; runRefreshCycleJob.ts:1428 calls activateDueSlots first every 60 s.
- Ads are BUILT PAUSED (runRefreshCycleJob.ts:6-11, 1150-1155; PLANNING_FALLBACK.adsCreatedPaused=true). Building requires design_review (auto_meta_ad) → AI caption → MANAGER CAPTION APPROVAL → create phase (api/_lib/marketing/metaAutoAd.ts:1-27, approveMetaAdCaption enqueues phase 'create').
- CONCLUSION: paid activation has NO fixed clock time and NO noon. An ad goes live on the first 60-second refresh-lane tick at/after 00:00 Riyadh on refresh_on, PROVIDED it is already built on Meta; under month_starts ads_live_when_ready=true (monthCompiler.ts:1354,1403) it is "live as soon as ready, not before the batch day." The "12:00" in 01-plan-v2.md §5 and 02-system-brief §6 ("publish Tue 12:00", "ads 12:00 today") is an OPERATOR ASSUMPTION not encoded anywhere.

ORGANIC RELEASE MECHANICS (required-ready anchor for organic):
- Publish instant = mos_publications.planned_at (18:00 + 5-min row gaps). Live query q_pub.json: every batch day has exactly 6 organic publications, earliest 18:00:00, latest 18:10:00 Riyadh.
- api/cron/release-sweep.ts runs every 5 min, hands due releases (COALESCE(scheduled_at, planned_at) reached) to bundle.social; publishRelease.ts:242-246 schedules at scheduled_at else now+60s.
- Paid creatives have ZERO publications (q_pub_purpose.json: purpose=paid → contents 21, pubs 0; purpose=organic → contents 93, pubs 148). So paid publish instant MUST come from refresh_on, never from mos_publications — confirming the two subject types need different required-ready sources.

CONTRACT: Replace the frozen-anchor forecast with a time-aware one. Definitions are per subject (a paid creative, or an organic row/single).

A. INPUTS. chain = mos_plan_chain(subject) in step order (writing→writing_review→design→design_writer_review→design_review), each row carrying booked_day (the *_corrected day if present, else original), target_hours (4/2/4/2/2), allowance_hours (24/12/24/12/12), and its live task state: done (closed_at set) | open(assigned_at, blocked, blocked_reason) | not-yet-created (reservation only). now := clock_timestamp(). All day math on the Riyadh working calendar via mos_work_due_at (Friday contributes 0 h).

B. THE FORECAST (folds only the steps that are NOT done):
  current step c = the earliest step in sort order whose task is not done.
   • if c.blocked  → risk='blocked', risk_reason=c.blocked_reason, projected_ready_at=NULL. STOP. (No numeric estimate for blocked work.)
   • else handoff_c = c.assigned_at when c is assigned (being worked), else GREATEST(now, dayStart(c.booked_day)).  [dayStart(d)=d 00:00 Riyadh]
     expected_finish_c = GREATEST(now, mos_work_due_at(handoff_c, c.target_hours)).   ← slides with the clock while unfinished (fixes defect 1 & "aging").
  for each remaining step k after c (all not-started):
     handoff_k = GREATEST(expected_finish_{k-1}, dayStart(k.booked_day)).   ← booked-day floor preserves downstream plan dates; pulling writing early never pulls design early (fixes defect 3, reviewer point 2).
     finish_k  = mos_work_due_at(handoff_k, k.target_hours).
> ⚠ SUPERSEDED by 01-plan-v9.md — §1c — no all-done→on_track fallback; the terminal rule reads mos_publications / mos_execution_ads by time.
  projected_ready_at = finish_{last} (design_review). If no step remains (all done) → on_track.
  PROPERTY (answers the briefing "hide a late predecessor?"): because c is the earliest NOT-done step, a late-but-still-open predecessor IS c, and its expected_finish slides with now(); it can never be skipped in favour of a successor.

C. REQUIRED-READY AND PUBLISH INSTANTS (precise, per subject type):
  Organic: PUB = min over the subject's mos_publications.planned_at (earliest member, = 18:00 Riyadh on batch day). required_ready_at = PUB − release_lead (working-calendar). publish_at = PUB.
  Paid: A = the creative's cycle activation floor = dayStart(mos_refresh_cycles.refresh_on) (= slot.activate_on 00:00 Riyadh — the earliest the ad can be live). required_ready_at = A − ad_build_lead. publish_at = A + 1 working day boundary (end of the refresh_on day): under ads_live_when_ready the ad still counts if it goes live any time that day; it becomes a hard miss only when it slips past the batch day (wasting a cadence day + budget).
  SETTING: add planning leads (reviewer's mos_month_template.release_lead_hours). RECOMMEND TWO because the leads differ in kind: release_lead_hours (organic, default 2 h: release-sweep 5-min latency + scheduling/publish_check + bundle fetch) and ad_build_lead_hours (paid, default 2 h MINIMUM; the true paid lead ALSO contains a human caption-approval step that the 5-step chain does not model — see open questions).

D. VERDICTS:
  blocked   : current step blocked (projected NULL).
  on_track  : projected_ready_at ≤ required_ready_at.
  at_risk   : required_ready_at < projected_ready_at ≤ publish_at.
  late      : projected_ready_at > publish_at.

E. RECOMPUTE POINTS (this is a REQUIRED correction to plan v2, which says "recomputed on each handoff" — insufficient, because projected_ready slides with the clock BETWEEN handoffs): recompute (1) on every handoff (assign + advance/close), (2) on every 10-minute planning sweep for every in-flight subject (this is what makes the flag age when NO event happens — without it the launch would read on_track until the next handoff that never comes), (3) on block/unblock. The stored workflow_role_tasks.at_risk/risk_reason is a ≤10-min-stale cache; the authoritative value is the STABLE function evaluated at read, so the queue/Work-page UI should call it live for anything it shows as a risk.

SKELETON:
-- Time-aware replacement for mos_publication_risk (READ-ONLY design; not applied).
-- Fixes: (1) current step slides with now(); (2) blocked → 'blocked';
-- (3) downstream booked-day floor; (4) required_ready/publish_at per subject type.
CREATE OR REPLACE FUNCTION public.mos_publication_risk(
  p_subject_table text, p_subject_id uuid)
RETURNS TABLE(projected_ready_at timestamptz, required_ready_at timestamptz,
              publish_at timestamptz, risk text, risk_step text, risk_reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_now     timestamptz := clock_timestamp();
  v_cursor  timestamptz;               -- running expected-finish
  v_started boolean := false;
  v_step    text;
  v_is_paid boolean;
  v_lead_h  numeric;
  v_daystart timestamptz;
  r record;
BEGIN
  v_is_paid := (p_subject_table='mos_content')
     AND EXISTS (SELECT 1 FROM mos_content c WHERE c.id=p_subject_id AND c.purpose='paid');

  IF v_is_paid THEN
    -- activation floor = the creative's cycle refresh_on at 00:00 Riyadh
    SELECT (rc.refresh_on::timestamp AT TIME ZONE 'Asia/Riyadh')
      INTO required_ready_at
      FROM mos_creative_slots s JOIN mos_refresh_cycles rc ON rc.id=s.cycle_id
     WHERE s.content_id=p_subject_id ORDER BY rc.refresh_on LIMIT 1;
    v_lead_h := public.mos_setting_num('planning.ad_build_lead_hours', 2);
    publish_at        := required_ready_at + interval '1 day';   -- day-plan miss line
    required_ready_at := required_ready_at - make_interval(hours => v_lead_h::int);
  ELSE
    SELECT min(p.planned_at) INTO publish_at
      FROM mos_publications p JOIN mos_content c ON c.id=p.content_id
     WHERE (CASE WHEN p_subject_table='mos_content_rows' THEN c.row_id=p_subject_id
                 ELSE c.id=p_subject_id END);
    v_lead_h := public.mos_setting_num('planning.release_lead_hours', 2);
    required_ready_at := publish_at - make_interval(hours => v_lead_h::int);
  END IF;

  FOR r IN
    SELECT ch.step_key, ch.sort_order, ch.booked_day, ch.target_hours,
           st.done, st.assigned_at, st.blocked, st.blocked_reason
      FROM mos_plan_chain(p_subject_table, p_subject_id) ch
      LEFT JOIN LATERAL (
        SELECT (t.status='done') done, t.assigned_at, t.blocked, t.blocked_reason
          FROM workflow_role_tasks t
         WHERE t.subject_table=p_subject_table AND t.subject_id=p_subject_id
           AND t.step_key=ch.step_key
         ORDER BY (t.status='open') DESC, t.round DESC LIMIT 1) st ON true
     ORDER BY ch.sort_order
  LOOP
> ⚠ SUPERSEDED by 01-plan-v9.md — §1c — WRONG step selection: after a changes_requested, later steps keep round-1 done rows and are skipped. Current step = the single OPEN task; remaining = pinned positions after it.
    IF r.done IS TRUE THEN CONTINUE; END IF;                 -- completed steps drop out
    v_daystart := (r.booked_day::timestamp AT TIME ZONE 'Asia/Riyadh');
    IF NOT v_started THEN                                    -- CURRENT step
      IF r.blocked IS TRUE THEN
        risk:='blocked'; risk_step:=r.step_key;
        risk_reason:=COALESCE(r.blocked_reason,'blocked');
        projected_ready_at:=NULL; RETURN NEXT; RETURN;       -- no estimate for blocked
      END IF;
      v_cursor := GREATEST(v_now, public.mos_work_due_at(
                    COALESCE(r.assigned_at, GREATEST(v_now, v_daystart)),
                    r.target_hours));                        -- slides with the clock
      v_step := r.step_key; v_started := true;
    ELSE                                                     -- downstream step
      v_cursor := public.mos_work_due_at(
                    GREATEST(v_cursor, v_daystart), r.target_hours); -- booked-day floor
    END IF;
  END LOOP;

  projected_ready_at := v_cursor;   risk_step := v_step;
  risk := CASE
    WHEN projected_ready_at IS NULL                         THEN 'on_track'  -- nothing left
    WHEN projected_ready_at <= required_ready_at            THEN 'on_track'
    WHEN publish_at IS NULL OR projected_ready_at<=publish_at THEN 'at_risk'
    ELSE 'late' END;
  RETURN NEXT;
END $$;
-- Recompute sites: (a) workflow_advance_role_path + mos_task_assign_apply (each handoff);
-- (b) mos_plan_start_due / mos_dispatch_sweep every 10 min for every in-flight subject
--     (REQUIRED — this is what ages the flag between handoffs);
-- (c) on block/unblock. Store into workflow_role_tasks.at_risk/risk_reason as a cache;
-- read-time callers (queue API, Work page) evaluate the STABLE function live.

TESTS:
- T1 reviewer's exact case — sliding while unfinished: SETUP Paid creative; writing+writing_review done; design open, assigned 2026-09-23 06:00; targets 4/2/2 remain; activation refresh_on 2026-09-24, ad_build_lead 2h. | ACTION Evaluate at 2026-09-23 10:00; then again at 2026-09-24 20:00 with design STILL open. | EXPECTED At 10:00: projected_ready=2026-09-23 14:00 → on_track. At 2026-09-24 20:00: projected_ready=GREATEST(now,...) = 2026-09-24 20:00-folded > publish_at(end of 09-24) → 'late' (NEVER 'on_track'). The buggy skeleton returns 2026-09-23 14:00/on_track at both times.
- T2 blocked current step: SETUP Design open with blocked=true, blocked_reason set. | ACTION Evaluate risk. | EXPECTED risk='blocked', risk_reason=the reason, projected_ready_at=NULL; no numeric on_track.
- T3 downstream booked-day floor (early upstream ≠ early design): SETUP Organic row; writing pulled early and DONE 2026-09-22; design NOT assigned, design booked_day 2026-09-23. | ACTION Evaluate risk on 2026-09-22. | EXPECTED design handoff = GREATEST(writing_finish, 2026-09-23 00:00)=2026-09-23 00:00; projection uses the plan day, not 09-22 — the designer is not assumed to have accepted early work.
- T4 late-but-open predecessor not hidden: SETUP writing OPEN and overdue on the anchor; design still reservation-only. | ACTION Evaluate risk. | EXPECTED current step = writing (earliest not-done); anchor slides with now(); projected_ready reflects writing's aging and pushes design/design_review out; anchor is never the successor.
- T5 per-type required-ready instants: SETUP One organic row (min planned_at 18:00) and one paid creative (refresh_on 2026-09-29). | ACTION Read required_ready_at/publish_at for each. | EXPECTED Organic: publish_at=18:00 batch day, required_ready=16:00 (lead 2h). Paid: required_ready=2026-09-28 22:00 (refresh_on 00:00 − 2h), publish_at=2026-09-30 00:00 (end of refresh_on day). Paid never reads mos_publications.
- T6 live launch regression: SETUP The 6 launch creatives P-471..476 as they stand (design open since 2026-09-20, refresh_on 2026-09-22), now 2026-09-22 10:11. | ACTION Evaluate fixed function vs buggy skeleton. | EXPECTED Buggy: on_track. Fixed: projected_ready=2026-09-22 14:11 > required_ready(2026-09-21 22:00) → at_risk (≤ end-of-day publish_at) — and 'late' if the operator sets an intended activation hour ≤ 12:00. Not on_track either way.
- T7 chain crossing Friday: SETUP Remaining step handoff Thu 2026-09-24 20:00, target 4h, Friday 2026-09-25 off. | ACTION Fold via mos_work_due_at. | EXPECTED finish lands Sat 2026-09-26 (Friday contributes 0h); required_ready and projected both route through mos_work_due_at, staying consistent.

TABLE Parameters used (from 04 [deadline-model], live mos_step_rules):
| step | target_hours | allowance_hours |
|---|---|---|
| writing | 4 | 24 |
| writing_review | 2 | 12 |
| design | 4 | 24 |
| design_writer_review | 2 | 12 |
| design_review | 2 | 12 |

Σ target = 14 h. now = 2026-09-22 10:11 Riyadh (q_now.json). Leads assumed 2 h (proposed default). Organic publish = 18:00 (q_pub.json); paid activation floor = refresh_on 00:00 (r0=09-22, r1=09-29, r2=10-06…; 04 refresh_cycles). Corrected booked days from 04 [correction-dryrun] table 4.

TABLE Buggy skeleton vs fixed forecast — the 6 launch paid creatives (smoking gun):
| creative | current step | buggy anchor | buggy projected | buggy verdict | fixed projected (now-aware) | required_ready (paid) | publish_at | fixed verdict |
|---|---|---|---|---|---|---|---|---|
| P-471..476 (r0, activate 09-22) | design OPEN (since 09-20 19:31) | opened_at 09-20 19:31 | 09-21 03:31 (frozen) | **on_track** | **09-22 14:11** | 09-21 22:00 | 09-23 00:00 (day line) | **at_risk** (day) / **late** vs 00:00 or 12:00 |

The buggy formula reports on_track for six ads whose designs are all still open at 10:11 today and which have 0 ads on Meta. This is Reviewer Issue 2, reproduced on live data.

TABLE Rerun forecast — requested subjects (now = 2026-09-22 10:11 Riyadh):
| subject | publish/activation instant | required_ready_at | projected_ready_at | verdict | risk_step |
|---|---|---|---|---|---|
| 22 Sep launch — 6 paid P-471..476 | activation 09-22 00:00 (refresh_on r0; live-when-ready) | 09-21 22:00 | 09-22 14:11 | at_risk (day) / late vs intended hour | design |
| 22 Sep launch — organic row (d5c3b85d, design r2 open) | 09-22 18:00 | 09-22 16:00 | 09-22 14:11 | on_track (~2h slack) | — |
| 24 Sep organic row (reservation-only, booked 09-23) | 09-24 18:00 | 09-24 16:00 | 09-23 14:00 | on_track | — |
| 29 Sep — 11 of 15 paid (r1, writing in flight, design has buffer) | activation 09-29 00:00 | 09-28 22:00 | ≤ 09-28 (per plan) | on_track | — |
| 29 Sep — P-488/489/490/491 (offered, writing not started, design corrected→09-29) | activation 09-29 00:00 | 09-28 22:00 | 09-29 08:00 | at_risk | design |
| c2–c5 paid (e.g. a9f8 c2 s5, pub 10-06, design corrected→10-06) | activation 10-06 00:00 | 10-05 22:00 | 10-06 08:00 | at_risk | design |

c2–c5: 34 at_risk (buffer lost by the inversion+capacity correction), 0 late — matches 04 [correction-dryrun] table 6. Note c2–c5 have nothing open today, so the now()-sliding term is inert for them now; it activates once their steps go open and stall.

TABLE 'Ads at what time today?' — the precise answer:
There is NO fixed activation clock. activate_on = refresh_on = 2026-09-22 (a civil DATE). The refresh lane (60-second poll) activates each launch ad on the first tick at/after 00:00 Riyadh 09-22 **once it is built on Meta** (built paused). At 10:11 today NONE of the 6 are built (all in design), so 0 ads are live and 0 can be until a design→caption-approval→create→activate chain completes. Earliest optimistic live time ≈ 14:11 (per-subject; ignores the single-designer queue). The '12:00' in plan v2 §5 / brief §6 is an operator assumption, not a stored instant — if a specific hour is wanted it must be added (mos_refresh_cycles activate_at, or a template setting).

IMPACTS: §1 Deadline model (01-plan-v2 line 65 vs 04 risk skeleton): unify the anchor. The deadline uses assigned_at; the risk skeleton uses opened_at. The forecast's current-step handoff must be assigned_at when assigned (else GREATEST(now, booked_day)); opened_at (which can be days old for queued work, e.g. the 4 P-488..491 opened 09-20) must NOT be the anchor. | §1 required_ready redefinition: plan v2's required_ready = 'last step plan_due_at' is replaced by a precise publication/activation instant minus a lead. This changes what 'at_risk' means for every subject and must be threaded through the sweep, the task columns, and the Work-page UI. | §2 Correction dry-run (04 table 6): its risk column is a STATIC plan-chain view (no now()), so it understates TODAY's launch risk — it lists the 22 Sep launch creatives as OK/on_track, but the live time-aware forecast shows them at_risk/late at 10:11 because design is still open. Recompute the dry-run risk with the time-aware function before trusting its 65 on_track / 38 at_risk / 0 late split for in-flight subjects (the 34 future c2–c5 at_risk are unaffected). | §5/§6 Migration: add planning.release_lead_hours and planning.ad_build_lead_hours settings; resolve paid publish_at from mos_refresh_cycles.refresh_on (paid have 0 publications — confirmed); add the risk recompute to mos_plan_start_due / the 10-min sweep (not only to the handoff path — plan v2's 'recomputed per handoff' is insufficient). | Decision #4 (the 38 buffer-losing creatives = at_risk by day plan): confirmed correct AS A DAY-LINE verdict; but the launch shows the day-line is too coarse for a batch whose intended activation is start-of-day. Recommend the operator decide whether paid needs a sub-day activation cutoff (then publish_at becomes that instant and the launch is 'late'). | mos_plan_repair (§5): it currently marks coarse at_risk from collapsed stage_deadlines; that is fully replaced by mos_publication_risk. Nothing else should write at_risk.
OPEN: Does the operator want a specific paid ACTIVATION HOUR? The brief/plan assume 12:00 for the launch, but nothing stores it: refresh_on is a date and ads_live_when_ready means 'live at 00:00 or when ready'. If yes, add an activate_at time (mos_refresh_cycles or template) and set publish_at (paid) to it; then the launch is unambiguously 'late', not 'at_risk'. | The paid ad-build lead includes a HUMAN caption-approval step (design_review → AI caption → manager approves caption → create → activate; metaAutoAd.ts). The 5-step reservation chain ends at design_review and does not model caption approval, so ad_build_lead_hours must cover an unbounded human wait, OR the chain should gain a caption-approval step. Which? | Single-designer serialization: the per-subject forecast assumes each subject can start now, so it labels all 6 launch creatives at_risk with the same 14:11 projection — but سارة has 8 open designs and cannot finish all by 14:11, so several are really 'late'. Should risk model per-role QUEUE contention (portfolio view), or is per-subject risk + a separate capacity view acceptable? (The reviewer asked for aging/blocked/current-time; contention is a further, real source of optimism.) | One lead setting or two? Reviewer proposed a single mos_month_template.release_lead_hours; I recommend two (release_lead_hours organic, ad_build_lead_hours paid) because the mechanisms and magnitudes differ. Confirm. | Should the projection use target_hours (optimistic turnaround, as plan v2 and the reviewer's example do) or allowance_hours (the deadline)? Optimistic targets can read on_track for a team that habitually uses the full allowance. Consider emitting BOTH a target-based and an allowance-based projection so the operator sees best-case vs commitment-case.
PLAIN: The reviewer is right. The way plan v2 measures 'will this post/ad make it out on time?' takes a snapshot at the moment a task is picked up and never looks at the clock again. So if a step gets stuck, the estimate freezes at the old, rosy answer. Proof from the live system right now: the six launch ads for today are all still being designed at 10:11 this morning, none is on Meta, yet the plan's formula still reports them as 'on track' — because it is quoting a projection frozen from Sunday night. That is the bug in one sentence: the forecast can say 'fine' after it has already become impossible.\n\nThe fix has four parts. (1) For the step that is currently open, the earliest it can finish is 'no sooner than right now plus whatever work is left', so the estimate must move forward as the day passes — a stuck task slowly turns from on-track to at-risk to late on its own. (2) If a step is blocked, don't invent a finish time — say 'blocked'. (3) Don't let starting one step early fool the forecast into assuming the next person also started early; each later step is still pinned to its planned day. (4) Define the real deadline precisely, not 'sometime on the publish day': for a normal post it's 6 PM that day (minus a short buffer to actually push it out); for an ad it's the start of the ad's batch day, because the system turns ads on the moment they're ready from that morning — there is no built-in noon, and the '12:00' people have been assuming is not written down anywhere.\n\nWith the fix, today's picture becomes honest: the six launch ads read at-risk (or late, if we decide ads must be live by a set hour) instead of on-track; the normal 22 Sep posts are on-track with a couple of hours to spare; the 24 and 29 Sep batches are on-track except four late ad texts; and next month's ads are flagged at-risk because the schedule correction used up their safety buffer. One more thing the plan missed: the risk has to be recomputed on a timer (every 10 minutes), not only when someone hands work over — otherwise a task that just sits there never trips the alarm, which is exactly how the launch slipped."


# ISSUE Reviewer Issue 1 — the plan's capacity guarantee has a verified hole: an offered task consumes its reservation but stays  [label=None]
VERDICT: confirmed
EVIDENCE: LIVE VIEW BODY — pg_get_viewdef('public.mos_work_ledger_v') (5 UNION arms):
• Task arm A (subject_table='mos_content'): "WHERE t.status = 'open' AND t.subject_table = 'mos_content' AND t.assignee_user_id IS NOT NULL".
• Task arm B (subject_table='mos_content_rows'): same, "AND t.assignee_user_id IS NOT NULL".
  → BOTH task arms REQUIRE assignee_user_id IS NOT NULL (reviewer claim #1 confirmed).
• Reservation arm C (planned day): "FROM mos_task_reservations r ... WHERE r.status = 'reserved' AND r.planned_end >= mos_perf_today() AND r.assignee_user_id IS NOT NULL".
• Reservation arm D (overdue/stale): "WHERE (r.status = 'stale' OR r.status = 'reserved' AND r.planned_end < mos_perf_today()) AND r.assignee_user_id IS NOT NULL".
  → BOTH reservation arms filter status='reserved'/'stale' and thus EXCLUDE status='consumed' (reviewer claim #2 confirmed).
• Manual arm E: mos_manual_tasks status='open'. Irrelevant here.
Consequence: a reservation that is 'consumed' by an open task whose assignee_user_id IS NULL is counted by NO arm.

LIVE DATA — the four tasks (P-488..491), all queried this session:
• workflow_role_tasks: 4 rows status='open', assignee_user_id=NULL, waiting_reason='capacity', step_key='writing', scheduled_start/end=2026-09-27, each carries reservation_id (ids 73cdad2e…, 560a8933…, 9325dceb…, a4da17a1…).
• mos_task_reservations for those reservation_ids: all 4 status='consumed', consumed_task_id → the open task, assignee_user_id='3eea9a65-dbaa-461a-9323-4d8b1ae539dd' (مريم / m.ansary), weight 1, bucket 'post', planned 2026-09-27.
• LEDGER ROWS for all 8 ids (4 tasks + 4 reservations): "SELECT ... FROM mos_work_ledger_v WHERE ref_id IN (…8 ids…)" → 0 rows. The 4 units are invisible (reviewer claim #3 confirmed — "zero ledger entries").
• Whole-cell proof: مريم writing planned 27 Sep has 8 consumed reservations — 3 back 'done' tasks (correctly gone), 1 backs an open+assigned task (counted, 1 unit), 4 back open+UNASSIGNED tasks (0 units). mos_work_ledger_v for (مريم, 2026-09-27, post) = 1 unit; live unfinished bookings = 5 units (1 assigned + 4 offered). Under-count = 4.
• Hole population repo-wide right now: "consumed reservations whose task is open+unassigned" = 4 rows / 4 units (exactly P-488..491). Reservation status distribution: consumed 46 (all with task, all retain assignee_user_id), reserved 474, stale/released/superseded 0.
• مريم writing/post capacity = 10 (mos_user_capacity + mos_user_daily_slots('3eea9a65…','post')=10).

COMMIT GUARD reads the same hole — mos_campaign_plan_commit body (scratchpad/commit.txt) lines 126-132: "existing" per (uid,day,bucket) = "COALESCE(sum(l.weight),0) FROM public.mos_work_ledger_v l WHERE l.user_id=a.uid AND l.day=a.day AND l.bucket=a.bucket"; line 131-132 raises when "(x.existing + a.proposed) > mos_user_daily_slots". With existing under-reporting مريم/27-Sep by 4, a new plan proposing 9 writing units would see 1+9=10≤10 → PASS while true load is 5+9=14 (overbook of 4). mos_campaign_plan_commit_month (scratchpad/cm.txt) locks then loops mos_campaign_plan_commit per plan (line 32), so every per-plan check inherits the hole; same-tx visibility only sees earlier plans' rows as 'reserved', never as bound-unassigned.

ALL LEDGER CONSUMERS (so the fix must cover every reader) — pg_proc scan for 'mos_work_ledger_v':
• mos_campaign_plan_commit (the WS409 capacity guard) — under-admits.
• mos_month_exceptions cte a8 'capacity_breach' (operator overbook warning) — under-flags: "FROM mos_work_ledger_v l ... HAVING sum(l.weight) > cap.daily_slots".
• mos_workload_snapshot_hash — serializes every ledger row (user_id;day;bucket;source;ref_id;weight); adding bound rows changes the hash value (one-time; preview and commit compute it from the same view so they still agree).
• TS month-planner: api/_lib/marketing/planning/snapshot.ts:148 "sb.from('mos_work_ledger_v').select('user_id, day, bucket, weight, source, ref_id')" builds LedgerRow[] (:211) → CapacityBook (src/lib/marketingOS/scheduling/ledger.ts). snapshot.ts:6 comment: "(mos_work_ledger_v) — so 'preview and commit use the same numbers'". This is the most dangerous reader: it decides backward-scheduling placement, so it will book NEW work onto مريم's 27-Sep writing as if 9 slots were free when only 5 are.

WHY THE PLAN'S PREMISE IS FALSE — plan-v2 §6a/§8: "existing = mos_work_ledger_v alone … excludes consumed reservations because their open task is counted instead." The clause "because their open task is counted instead" holds only when the open task has an assignee. The plan's OWN §4a defines an offered task as opened+bound+UNASSIGNED (assignee NULL) — precisely the state whose open task is NOT counted. The plan converts a transient race (dispatch deferring a consumed task, which is how P-488..491 got here — mos_plan_consume_reservation sets 'consumed' at bind, brief lines 820-826, and the old dispatch then failed to place them) into a deliberate, long-lived, systematic state, so it widens a 4-unit incidental hole into the steady state for every early-offered batch.

LIFECYCLE ROOT — brief §mos_plan_consume_reservation (lines 763-832) consumes (status→'consumed') at BIND time and immediately dispatches; the "counted through the task" assumption depends on dispatch succeeding in the same tx. Plan §3a splits bind (mos_task_open) from assign (mos_task_assign_apply), so 'consumed' is set at bind while assignment can be deferred for days → the assumption breaks structurally.

CONSTRAINT — mos_task_reservations_status_check currently CHECK (status = ANY(ARRAY['reserved','stale','consumed','released'])); 'released' exists but is unused (0 rows) and is counted by no arm. Adding 'bound' requires altering this CHECK.

STATUS-BRANCHING BLAST RADIUS (functions that read mos_task_reservations.status): mos_campaign_plan_commit, mos_plan_consume_reservation, mos_plan_release_internal, mos_plan_repair, mos_plan_start_due, mos_task_rules_audit — each must learn 'bound'.

CI — supabase/tests/ci/assert_engine_conformance.sql asserts only config-table equality (daily_limit vs daily_slots, lines 29-73); it does not touch the ledger or reservation lifecycle, so the fix does not break its contract, but no test guards the hole today.

CONTRACT: KEEP the ledger as the single accounting source; CHANGE the reservation-consumption lifecycle so a booking is never lost and never double-counted, transferring from the reservation arm to the task arm exactly once, at ASSIGNMENT (not at bind).

RECOMMENDED: Option (a) — a new reservation status 'bound'. Reject option (b) (task arm counts COALESCE(assignee_user_id, offered_to_user_id)) for the failure-mode reason below.

THE ONE ACCOUNTING RULE (invariant): every reservation that is not yet done and not yet actively assigned is counted through the RESERVATION arm (statuses 'reserved','stale','bound'), attributed to r.assignee_user_id on its planned day; the instant a task is ASSIGNED its reservation flips 'bound'→'consumed' and the TASK arm takes over (attributed to t.assignee_user_id); a done/closed task's reservation stays 'consumed' and is counted by neither. 'consumed' therefore means exactly "actively assigned or finished", never "offered".

LIFECYCLE (one unit of planned work):
1. Planned, no task: reservation 'reserved', assignee set → reservation arm (1). [today: OK]
> ⚠ SUPERSEDED by 01-plan-v9.md — §3/§4 — terminology: the bound-unassigned state is Band C (offered_to NULL); 'offered' means Band B only. The reserved→bound→consumed ledger lifecycle itself stands.
2. Offered = opened+bound, unassigned: mos_task_open sets reservation 'reserved'→'bound' (NOT 'consumed'), consumed_task_id=task, keep assignee_user_id=planned person; task open, assignee NULL, offered_to set. Counted by reservation arm via r.assignee_user_id on its planned day (1). [today: 0 — THE BUG; fixed here]
3. Assigned (mandatory arrival OR explicit early start): mos_task_assign_apply, in the SAME tx it sets t.assignee_user_id, flips reservation 'bound'→'consumed'. Task arm counts it via t.assignee_user_id; reservation arm drops it. Atomic exactly-once handoff (1).
4. Done: workflow_advance closes the task (status='done'); reservation stays 'consumed'; neither arm counts it (0). The successor's mos_task_open binds the successor's own reservation to 'bound'.

EDGE TRANSITIONS:
• Transfer of an already-assigned task: reservation already 'consumed'; mos_task_assign_apply only updates t.assignee_user_id; task arm follows the new person. Still 1.
• Release / unassign while the task stays open (role loss, transfer-away that clears assignee): flip reservation 'consumed'→'bound' and clear t.assignee_user_id in the same tx; reservation arm resumes via r.assignee_user_id (re-point to the new intended holder, else keep the planned person). Loud, exactly 1.
• Cancel the work entirely: reservation → 'released' (already uncounted), task → 'skipped'. 0, deliberate.
• mos_task_open's consume-search MUST keep "WHERE status IN ('reserved','stale')" so a 'bound' reservation can never be re-bound by a second task (prevents double-bind / double-count).

WHY (a) OVER (b): the house rule is "never silently under-count capacity; fail loud." Option (a)'s worst case (a reservation stuck at 'bound' after its task finished) is an OVER-count — the person looks busier, work is pushed out, visible in mos_month_exceptions a8 and the conformance assertion. Option (b)'s worst case (any open task with assignee NULL AND offered_to NULL — a transient mid-tx state, a legacy row, or any new code path that forgets to set offered_to) is an UNDER-count that vanishes silently — the exact bug being fixed. (b) also does not structurally close the hole: COALESCE(NULL,NULL)=NULL groups the row under user_id NULL, i.e. invisible again. (a) closes it structurally because the reservation (always has assignee_user_id, always exists until done) is the counted entity while unassigned.

DAY ATTRIBUTION is preserved across the whole lifecycle: a 'bound' reservation charges its planned day (reservation arm uses GREATEST(planned_start,today)); after early assignment the task arm uses GREATEST(scheduled_start,today) and scheduled_start stays the planned day — so the ledger cell is unchanged by early start (matches "starting early keeps the planned deadline/day" and gives the "constant until completion" property).

The plan's §6a claim ("existing = mos_work_ledger_v alone; adding consumed reservations would double-count") becomes TRUE and precisely justified under this lifecycle, and its per-plan/whole-month commit guard, mos_month_exceptions, mos_workload_snapshot_hash and the TS CapacityBook all inherit the correct number with NO change to their own code (they read the view).

SKELETON:
-- 1. Status domain: add 'bound'
ALTER TABLE public.mos_task_reservations DROP CONSTRAINT mos_task_reservations_status_check;
ALTER TABLE public.mos_task_reservations ADD CONSTRAINT mos_task_reservations_status_check
> ⚠ SUPERSEDED by 01-plan-v9.md — §6c step 1 — ONE CHECK with all six values; this fragment omits 'superseded'.
  CHECK (status = ANY (ARRAY['reserved','bound','stale','consumed','released']));

-- 2. Ledger view: reservation arms count 'bound' too; TASK arms UNCHANGED
--    (do NOT add offered_to to the task arms — that would double-count the bound reservation).
CREATE OR REPLACE VIEW public.mos_work_ledger_v AS
  -- task arm A (mos_content): unchanged  ... WHERE t.status='open' AND ... AND t.assignee_user_id IS NOT NULL
  -- task arm B (mos_content_rows): unchanged ... AND t.assignee_user_id IS NOT NULL
  UNION ALL
  SELECT r.assignee_user_id, s.day, r.bucket, s.weight, 'reservation', r.id
    FROM public.mos_task_reservations r
    CROSS JOIN LATERAL public.mos_spread_effort_mode(GREATEST(r.planned_start, public.mos_perf_today()), r.weight, r.row_id IS NOT NULL) s(day,weight)
   WHERE r.status IN ('reserved','bound')                     -- +bound
     AND r.planned_end >= public.mos_perf_today() AND r.assignee_user_id IS NOT NULL
  UNION ALL
  SELECT r.assignee_user_id, s.day, r.bucket, s.weight, 'reservation', r.id
    FROM public.mos_task_reservations r
    CROSS JOIN LATERAL public.mos_spread_effort_mode(public.mos_perf_today(), r.weight, r.row_id IS NOT NULL) s(day,weight)
   WHERE (r.status = 'stale' OR (r.status IN ('reserved','bound') AND r.planned_end < public.mos_perf_today()))  -- +bound
     AND r.assignee_user_id IS NOT NULL
  UNION ALL
  -- manual arm: unchanged
  ;
-- (mos_workload_snapshot_hash needs no edit — it reads the view; its hash value changes once, consistently for preview+commit.)

-- 3. mos_task_open (bind = 'bound', never 'consumed'); consume-search stays reserved/stale
UPDATE public.mos_task_reservations
   SET status='bound', consumed_task_id=v_task.id,
       content_id = CASE WHEN v_is_row THEN content_id ELSE v_task.subject_id END,
       row_id     = CASE WHEN v_is_row THEN v_task.subject_id ELSE row_id END,
       updated_at = now()
 WHERE id = v_res.id;                       -- selected by WHERE status IN ('reserved','stale') ... FOR UPDATE
-- copy planned_start/end/effort_days/reservation_id onto the task; assignee stays NULL.

-- 4. mos_task_assign_apply: transfer the booking exactly once, in the assignment tx
UPDATE public.workflow_role_tasks
   SET assignee_user_id=p_user, assigned_at=now(),
       due_at = GREATEST(plan_due_at, public.mos_work_due_at(now(), v_allowance)),
       offered_to_user_id=NULL, waiting_reason=NULL, updated_at=now()
 WHERE id=p_task AND status='open' AND assignee_user_id IS NULL;   -- FOR UPDATE guard
UPDATE public.mos_task_reservations
   SET status='consumed', updated_at=now()
 WHERE consumed_task_id=p_task AND status='bound';                 -- idempotent no-op if already consumed

-- 5. Release/unassign path (mos_plan_release_internal / transfer that clears assignee)
UPDATE public.mos_task_reservations SET status='bound', updated_at=now()
 WHERE consumed_task_id=p_task AND status='consumed';
UPDATE public.workflow_role_tasks
> ⚠ SUPERSEDED by 01-plan-v9.md — §3a — release clears assignee/due_at/offered_to and flips the reservation to bound; the task lands in Band C until refill decides. Never pre-set offered_to or waiting_reason.
   SET assignee_user_id=NULL, offered_to_user_id=p_new_holder, waiting_reason='offered', due_at=NULL
 WHERE id=p_task AND status='open';
-- true cancellation: reservation -> 'released', task -> 'skipped'.

-- 6. mos_plan_repair: treat 'bound' like 'consumed' (NEVER re-date/re-span it) — a bound day is offered work; moving it would change a planned deadline.

-- 7. Correction (§2) booked-weight: booked = task arm + reservation('reserved'|'bound') + already-moved; consumed(assigned) counted once via its task, bound counted once via its reservation.

-- 8. Migration recovery of the 4 live tasks: consumed+open+unassigned -> bound + offered
UPDATE public.mos_task_reservations r SET status='bound', updated_at=now()
  FROM public.workflow_role_tasks t
 WHERE r.consumed_task_id=t.id AND r.status='consumed' AND t.status='open' AND t.assignee_user_id IS NULL;
> ⚠ SUPERSEDED by 01-plan-v9.md — §6c step 6 — the four recovered tasks become Band C: waiting_reason NULL, offered_to NULL; keep only the reservation consumed→bound flip.
UPDATE public.workflow_role_tasks t SET waiting_reason='offered',
       offered_to_user_id=(SELECT assignee_user_id FROM public.mos_task_reservations WHERE consumed_task_id=t.id), due_at=NULL
 WHERE t.status='open' AND t.assignee_user_id IS NULL;

-- 9. CI conformance assertion (add to assert_engine_conformance.sql) — the hole can never recur silently
SELECT count(*) INTO v_hole FROM public.mos_task_reservations r
  JOIN public.workflow_role_tasks t ON t.id=r.consumed_task_id
 WHERE r.status='consumed' AND t.status='open' AND t.assignee_user_id IS NULL;
IF v_hole>0 THEN RAISE EXCEPTION 'CONFORMANCE: % consumed reservation(s) back an open UNASSIGNED task (capacity hole)', v_hole; END IF;
-- Invariant restated: a live task-backing reservation is 'bound' iff its task is open+unassigned; 'consumed' iff (open+assigned) or done.

TESTS:
- E-LEDGER-1 reservation→offer→assign→complete: sum constant then removed: SETUP One writing reservation w=1 for person M on day D, bucket post, status='reserved', assignee=M, no task. Define S := SELECT COALESCE(SUM(weight),0) FROM mos_work_ledger_v WHERE user_id=M AND day=D AND bucket='post'. | ACTION Read S at four checkpoints: (1) reserved-no-task; (2) after mos_task_open (reservation→bound, task open unassigned, offered_to=M); (3) after mos_task_assign_apply(task,M) (reservation→consumed, task assigned); (4) after workflow_advance_role_path closes the task. | EXPECTED S=w at (1),(2),(3) — never 0, never 2w; S drops by w at (4). At (2) the ledger row's source='reservation', ref_id=reservation.id; at (3) source='task', ref_id=task.id. Exactly one arm supplies w at every live checkpoint.
- E-LEDGER-2 commit guard sees offered work: SETUP Person M, cap 10 writing on day D. Create 4 offered (bound+unassigned) writing units on M/D plus 1 assigned unit (existing live shape: 5 units). | ACTION Attempt mos_campaign_plan_commit of a plan proposing 6 more writing units on M/D. | EXPECTED WS409 capacity_conflict (existing 5 + proposed 6 = 11 > 10). BEFORE the fix the same commit passes (existing reads 1). The DETAIL cell reports existing=5.
- E-LEDGER-3 no orphan-consumed (conformance): SETUP Run the full migration + one mos_refill on a fixture containing an offered batch. | ACTION Run the assert_engine_conformance.sql orphan-consumed check. | EXPECTED 0 consumed reservations back an open unassigned task; assertion passes. Deliberately corrupt one row to consumed+open+unassigned → assertion RAISES.
- E-LEDGER-4 early start keeps the ledger day: SETUP Offered (bound) writing unit for M planned day D=27 Sep; today=22 Sep. | ACTION M starts it early → mos_task_assign_apply on 22 Sep (reservation→consumed). | EXPECTED Ledger cell stays (M, 27 Sep, post)=w before and after; NO unit appears on 22 Sep (scheduled_start unchanged). due_at=plan_due_at (unchanged).
- E-LEDGER-5 release returns the booking to the reservation arm: SETUP Assigned task (reservation consumed) for M on D. | ACTION Release/unassign the task while it stays open (role loss). | EXPECTED Reservation flips consumed→bound; ledger cell (M,D,post) stays w (now via reservation arm); task open, assignee NULL, offered_to set; no double count.
- E-LEDGER-6 double-bind prevented: SETUP A reservation already status='bound' (consumed_task_id set). | ACTION Invoke mos_task_open/consume for a second task matching the same subject+step. | EXPECTED The consume search (WHERE status IN ('reserved','stale')) does NOT re-select the bound reservation; no second binding; ledger still counts the unit once.
- E-LEDGER-7 concurrent assign is exactly-once: SETUP One offered (bound) task, two concurrent mos_task_assign_apply calls. | ACTION Both run under mos_ledger_lock. | EXPECTED Winner sets assignee + flips reservation→consumed; loser's FOR UPDATE guard (assignee_user_id IS NULL) fails → no-op; reservation consumed exactly once; ledger cell = w throughout.

TABLE Exactly-once matrix per lifecycle state (weight w of one unit):
| state | reservation.status | task | today ledger | after-fix ledger (option a) | after-fix counting arm |
|---|---|---|---|---|---|
| 1 planned, no task | reserved | none | w | w | reservation (r.assignee) |
> ⚠ SUPERSEDED by 01-plan-v9.md — §3/§4 — same terminology note: this row is Band C bound-unassigned.
| 2 offered (bound, unassigned) | consumed (today) / **bound** (fix) | open, assignee NULL | **0 (HOLE)** | w | reservation (r.assignee) |
| 3 assigned / started early | consumed | open, assignee set | w | w | task (t.assignee) |
| 4 done | consumed | done | 0 | 0 | none (correct) |
| forbidden | consumed | open, assignee NULL | 0 (silent) | blocked by conformance assert | — |

TABLE مريم writing, 27 Sep 2026, bucket post (live vs fix):
| measure | value |
|---|---|
| capacity (mos_user_daily_slots post) | 10 |
| consumed reservations planned 27 Sep | 8 (3 done · 1 open+assigned · 4 open+unassigned) |
| live unfinished bookings | 5 units (1 assigned + 4 offered) |
| **mos_work_ledger_v now** | **1 unit** (under-count 4) |
| ledger after fix (4 offered → bound) | 5 units |
| commit guard 'existing' now → after | 1 → 5 |
| a plan proposing +6 writing units | now: PASS (1+6=7≤10) but real 5+6=11 overbook · after: WS409 (5+6=11) |

TABLE The four live tasks (P-488..491) after migration:
| task/reservation | now | after migration (option a) |
|---|---|---|
| reservation.status | consumed | **bound** |
| task.status / assignee | open / NULL | open / NULL |
> ⚠ SUPERSEDED by 01-plan-v9.md — §8 — after migration: waiting_reason NULL, offered_to NULL (Band C).
| waiting_reason / offered_to | 'capacity' / (none) | 'offered' / مريم (from reservation.assignee) |
| due_at | NULL | NULL (no countdown) |
| ledger rows contributed | 0 | 1 each (reservation arm, مريم, 27 Sep, post, w=1) → +4 to the cell |
| becomes mandatory | — | 27 Sep (planned day), then assigned normally |
| writing day (predecessor, never moved by §2 correction) | 27 Sep | 27 Sep |

IMPACTS: §3a MUST change: 'mos_task_open … bind its reservation (= mos_plan_consume_reservation minus its trailing dispatch)' must set the reservation to 'bound', NOT 'consumed'. As written it reproduces the hole verbatim. | §3a mos_task_assign_apply MUST gain, in the same tx that sets the assignee, the reservation flip 'bound'→'consumed'. The plan currently lists only 'sets assignee/assigned_at/due_at, notify'. This is the exactly-once transfer point. | §4a 'offered = opened+bound, unassigned' is fine but must be restated as: bound-reservation is the counted entity while unassigned; the ledger keeps counting the offered unit on its planned day via the reservation arm. This is what makes 'offering preserves its booking' true. | §6a bullet 'existing = mos_work_ledger_v alone … their open task is counted instead' MUST be re-justified: 'consumed' now means actively-assigned (task arm) or done (nobody); 'bound' means offered (reservation arm). The 'adding consumed reservations would double-count' point stays correct. Without the lifecycle change the bullet is factually false for offered work. | §6b.1 schema step MUST add 'bound' to mos_task_reservations_status_check and (optionally) an index supporting the consumed+open+unassigned conformance check. | §6b.5 mos_plan_repair rewrite MUST treat 'bound' like 'consumed' (never re-date/re-span), else offered work's planned day would move — violating 'making future work available never changes its deadline'. | §2 correction MUST include 'bound' in its booked-weight (booked = open tasks + reserved + bound + already-moved). The plan's phrasing 'consumed reservations counted once through their task' omits bound and would undercount offered work during the repack. | mos_plan_release_internal, mos_plan_start_due, mos_task_rules_audit, mos_plan_consume_reservation all branch on reservation status and MUST learn 'bound' (consume-search stays reserved/stale only). | mos_month_exceptions a8 and the TS CapacityBook (snapshot.ts:148 → ledger.ts) need NO code change but their numbers change (now include offered work) — this is the intended correction; add a regression check that the planner preview no longer books over offered work. | mos_workload_snapshot_hash value changes once (bound rows now serialize); acceptable because preview and commit read the same view. Any preview taken before the migration will WS409 on a stale-hash re-commit after — expected for a one-time migration under the lock. | assert_engine_conformance.sql: contract unchanged, but ADD the orphan-consumed assertion so the hole cannot recur. | PRD docs/prd for Marketing OS scheduling must document the reserved→bound→consumed→(done|released) lifecycle and the single-arm invariant.
OPEN: Should merely-offered (bound) work BLOCK a future plan from booking the same cell (i.e., count against the commit-guard cap)? Option (a) makes it count, which is required for the guarantee. This is consistent with the operator's rule — 'offering adds no mandatory workload' governs the PERSON's countdown (due_at NULL, late sweep ignores it), not capacity reservation. Recommend: yes, it counts. Confirm. | On role-loss/unassign of an offered task, should its reservation become 'bound' re-attributed to a new eligible holder (kept in the ledger, capacity preserved) or 'released' (freed)? Recommend 'bound' re-pointed to the intended holder, 'released' only on true cancellation. Confirm the rule. | Early-STARTED work is charged on its PLANNED day (scheduled_start unchanged), not the actual start day, so the ledger cell is constant across assignment. Confirm this matches the operator's capacity intent (vs. charging the day work actually happens). | Does any non-planning code path (worker, releaseMaterial.ts, cron) create an open task without immediately assigning AND without setting offered_to/binding a reservation? Such a path would still be invisible; the conformance assertion catches consumed+unassigned, but an open task with neither reservation nor assignee is a separate gap worth a grep before go-live.
PLAIN: The reviewer is right, and I proved it on the live database. The system keeps one shared tally of 'how much work each person has each day' (the ledger). That tally counts a booking in one of two ways: while nobody is doing it yet, it counts the reservation; once a person is assigned, it counts their task instead — and it stops counting the reservation to avoid counting the same job twice. The plan introduces a new middle state: 'offered' work — a job that has grabbed its reservation but has not been assigned to anyone yet. In that state the tally counts NEITHER side: the reservation is marked 'used up' so it's skipped, and the task has no assignee so it's skipped too. The job simply disappears from the day's total. I found this happening right now: مريم has four real writing jobs booked for 27 September that the tally shows as zero. So the day looks 4 units emptier than it is, and the safety check that stops overbooking would happily let another plan pile more work onto that same day — the exact hole the reviewer described. The fix is small and precise: give the reservation a third label, 'bound' (offered but not yet assigned). While a job is offered, the ledger counts it through the reservation (so it never disappears); the moment someone is actually assigned, the label flips to 'used up' and the person's task takes over the count — the booking moves from one side to the other exactly once, in the same database step, so it's never lost and never doubled. I chose this over the alternative (counting an unassigned task by a fallback 'offered-to' column) because if that column is ever empty the job silently vanishes again — the same class of quiet bug that has cost this team weeks before. The 'bound' approach fails safe instead: the worst case is a job counted slightly too long, which is loud and visible, not a job that disappears. Every place that reads the tally — the overbooking guard, the planner's own forecast, the operator's overload warnings — automatically gets the right number with no other changes, because they all read the same ledger. I also added a permanent safety check that fails the build if this hole ever reopens, and an acceptance test that watches one job go reservation → offered → assigned → done and confirms the day's total stays steady the whole way, then drops only when the job is finished.


# ISSUE Reviewer Issue 4 — Plan v2 §6a proposes to EXCLUDE the reservations of plans being superseded from the commit capacity g  [label=None]
> ⚠ SUPERSEDED by 01-plan-v9.md — §6a — retirement is lifted OUT of the per-plan commit into commit_month Phase 1 (per campaign, before the ONE union guard); the per-plan-only design false-refuses multi-campaign months. Bound tasks the new plan re-books are CARRIED, not closed.
VERDICT: confirmed
EVIDENCE: VERDICT: CONFIRMED, and the risk is larger than "hidden capacity" — the unreleased reservations are not just a phantom ledger charge, they are materialisable into real duplicate tasks.

1) The commit changes the old plan's STATUS only, never its reservations.
`mos_campaign_plan_commit` (live body, pg_get_functiondef), the supersede block at the very end:
  UPDATE public.mos_campaign_plans
     SET status = 'superseded', superseded_by = p_plan_id, updated_at = now()
   WHERE campaign_id = v_campaign AND campaign_id IS NOT NULL
     AND id <> p_plan_id AND status IN ('proposed','approved');
Statuses affected = the earlier `proposed`/`approved` plan(s) of the same campaign. There is NO `UPDATE public.mos_task_reservations` anywhere in the function except the rule-4 INSERT (`... 'reserved' ...`) and the consume path. So the old plan's rows stay `status='reserved'` (or `consumed`).

2) No trigger closes the gap. Triggers on the two tables:
  mos_campaign_plans -> only `mos_campaign_plans_touch` (BEFORE UPDATE, updated_at). Nothing else.
  mos_task_reservations -> only `mos_task_reservations_touch`.
The release trigger `mos_content_release_reservations_tg` runs `mos_tg_release_reservations()` on `mos_content` (archived_at/rejected_at/on_hold_at) and calls `mos_plan_release_internal(OLD.id)` keyed by CONTENT id — it is not a plan-supersession path and never fires when a plan is superseded.

3) The ledger counts reservations by their OWN status, with no plan join.
`mos_work_ledger_v` (pg_get_viewdef) reservation arms:
  ... FROM mos_task_reservations r ... WHERE r.status = 'reserved' AND r.planned_end >= mos_perf_today() ...
  ... WHERE (r.status = 'stale' OR r.status = 'reserved' AND r.planned_end < mos_perf_today()) ...
No join to mos_campaign_plans, no plan-status predicate. It excludes `consumed` and `released` (their open task is counted instead / they are retired). So a superseded plan's still-`reserved` rows remain counted. `mos_campaign_plan_commit`'s own guard reads `existing` from this view (`FROM public.mos_work_ledger_v l WHERE l.user_id=... AND l.day=... AND l.bucket=...`), so it double-counts old+new unless the old rows are retired.

4) The unreleased rows are ACTIVE, not just counted. No engine path filters by plan status:
  - `mos_plan_start_due`: materialises a task for any row with a `reserved`/`stale` reservation and no task (`EXISTS (... tr.status IN ('reserved','stale'))`), and any `mos_content_plan.status='planned'` content with production_start and no task. No plan filter -> the superseded plan's un-started subjects become duplicate active tasks.
  - `mos_plan_repair`: `WHERE res.status='reserved' AND res.planned_end < v_today AND res.consumed_task_id IS NULL` with only an OPTIONAL campaign filter -> re-dates superseded rows.
  - `mos_plan_consume_reservation`: `WHERE r.status IN ('reserved','stale')` regardless of plan.

5) The path that fires this is the live re-plan/re-confirm. `api/_lib/marketing/planning/monthActions.ts:828` inserts a FRESH `mos_campaign_plans` row `status:'proposed'` per campaign (new plan_id), then `:877` calls `mos_campaign_plan_commit_month` -> per-plan `mos_campaign_plan_commit` -> the supersede block fires on the prior approved plan. `ensureCampaign` reuses the campaign (ref UNIQUE); rows are reused by `row_key` (UNIQUE, re-pointed to the new plan), but content shells are created fresh per plan (`mos_content_plan` lookup keyed on `plan_id + content_key`), so the old plan's content persists.

6) Live state confirms it is LATENT (never fired yet): `mos_campaign_plans` = 4 campaigns x 1 `approved` plan (committed 2026-09-20 10:54) + 2 orphan `proposed` (campaign_id NULL). 0 `superseded` plans. `mos_task_reservations` = 474 `reserved` + 46 `consumed`, all under approved plans; 0 reserved/stale carry a consumed_task_id. Invariant check on open MOS tasks: 17 assigned+consumed-reservation, 4 UNASSIGNED+consumed-reservation (the parked/offered shape), 2 assigned+no-reservation (revisions). So an ASSIGNED planned task always has a `consumed` reservation (consume runs inside `mos_plan_consume_reservation`, called by path_start/advance/revise/commit, which then calls `mos_task_dispatch`).

7) Status vocabulary already supports a clean fix: `mos_task_reservations_status_check` = ('reserved','stale','consumed','released'); `mos_campaign_plans_status_check` = ('proposed','approved','superseded','discarded'). No reader applies a NEGATIVE status filter to reservation rows (checked every function that reads the table: mos_campaign_plan_commit, mos_plan_consume_reservation, mos_plan_release_internal, mos_plan_repair, mos_plan_start_due, mos_task_rules_audit — every reservation predicate is a positive `IN ('reserved','stale')` / `='reserved'`; the only `<>` matches are on the tasks/plans tables), so a new terminal status value is auto-inert across all of them. `mos_campaign_plan_commit` is the ONLY function that writes plan status `superseded` (other pg_proc hits are unrelated mkt_*/workflow_advance).

CONTRACT: Replace plan v2 §6a's sentence — "Reservations of plans this commit supersedes (same campaign, proposed/approved) are excluded so a re-preview -> re-confirm does not false-positive" — with ACTIVE RETIREMENT inside `mos_campaign_plan_commit`, in the same transaction, BEFORE the guard. The guard then uses `existing = mos_work_ledger_v` alone with NO plan/status exclusion clause.

DEFINITIONS
- Superseded set S = { plan ids WHERE campaign_id = v_campaign AND campaign_id IS NOT NULL AND id <> p_plan_id AND status IN ('proposed','approved') } — identical to the predicate already used by the end-of-function supersede UPDATE.
- "Unconsumed reservation" = status IN ('reserved','stale') AND consumed_task_id IS NULL.
- "Consumed reservation" = status='consumed' (consumed_task_id set) — backs a real open/closed task.

NEW ORDER INSIDE mos_campaign_plan_commit (one txn, already under mos_ledger_lock):
1. lock; load v_plan FOR UPDATE; idempotent 'already' short-circuit when status='approved' (writes nothing — MUST run before any retirement so a replay never re-supersedes); reject if status<>'proposed'. UNCHANGED.
2. Resolve v_campaign := COALESCE(NULLIF(p_materialise->>'campaign_id','')::uuid, v_plan.campaign_id) — MOVED up, above the guard.
3. Hash gate. UNCHANGED.
4. RETIRE prior plans of this campaign (NEW — this whole block is the fix):
   (a) Retire unconsumed reservations of S -> terminal status 'superseded' with provenance:
       UPDATE mos_task_reservations
          SET status='superseded', superseded_by_plan_id=p_plan_id, superseded_at=now(), updated_at=now()
        WHERE plan_id = ANY(S) AND status IN ('reserved','stale') AND consumed_task_id IS NULL;
   (b) Retire the OLD plan's offered/parked open tasks (open AND unassigned) whose subject belongs to S, and terminalise their (consumed) reservations:
       - close each such task: status='skipped', closed_at=now(), note 'plan_superseded:'||p_plan_id;
       - set its reservation status='superseded' (+provenance), so a 'consumed' row is not left pointing at a closed task.
       Subject->plan test: content tasks via mos_content_plan.plan_id = ANY(S); ROW tasks are NOT in S (the row is re-pointed to the new plan by row_key and its single open task is carried forward — its new reservation is consumed at the next dispatch, its old row reservation is retired by 4a).
   (c) Flip plan status: UPDATE mos_campaign_plans SET status='superseded', superseded_by=p_plan_id, updated_at=now() WHERE id = ANY(S). (This is the existing end-of-function UPDATE, moved here; DELETE the duplicate at the end.)
   NOT TOUCHED: consumed reservations that back ASSIGNED open tasks. They stay 'consumed', keep their task, keep their due_at, and remain counted through the ledger's task arm. "Existing assigned work must remain counted" is satisfied by leaving them alone.
5. Capacity guard: existing = mos_work_ledger_v alone, evaluated AFTER step 4, + proposed(this plan). NO status/plan exclusion clause (delete plan v2's exclusion; keep the row_key-not-spread parity fix). Because S's unconsumed bookings are now 'superseded', the view no longer counts them; the double-count is gone by real retirement, not by a read filter — which also removes the reviewer's §7.6 risk that a read-time exclusion could over-exclude the wrong rows.
6. materialise items/rows/reservations. UNCHANGED.
7. Remove the old end-of-function supersede UPDATE (folded into 4c).

STATUS VALUE: use a distinct terminal reservation status 'superseded' (not reuse 'released'), for an auditable separation of content-archive release vs plan supersession, and add nullable columns superseded_by_plan_id uuid, superseded_at timestamptz. MANDATORY co-change in the same migration: add 'superseded' to mos_task_reservations_status_check (else the UPDATE fails — loudly, no silent loss). Verified safe: every reservation reader uses positive inclusion filters, so the new value is auto-excluded from ledger/start_due/repair/consume/audit. (Reusing 'released' avoids the CHECK change and is equally inert, but loses provenance; if chosen, still add a release_reason/superseded_by_plan_id column.)

RE-BIND vs CLOSE decision: CLOSE offered/parked old-plan tasks as 'skipped', do NOT re-bind to the new plan. Justification: rows already carry forward structurally (shared row_key); content shells are created fresh per compile with plan-scoped content_keys, so no reliable 1:1 old->new content mapping exists and a string-key re-bind could attach a person's task to different creative. The new plan re-materialises equivalent work via start_due/refill; a stale task from a dead plan on someone's board is exactly the "misleading flag" the operator forbids. This also aligns with operator decision #5 (archiving auto-closes tasks).

MIGRATION: forward-only; 0 superseded plans exist today so no backfill is required. Add the columns + CHECK value + the rewritten commit function. (If a future re-confirm has already stranded rows, a one-shot sweep — status IN ('reserved','stale') AND consumed_task_id IS NULL AND plan_id in superseded plans -> 'superseded' — cleans them; not needed at apply time.)

SKELETON:
-- ============ migration: schema ============
ALTER TABLE public.mos_task_reservations
  ADD COLUMN IF NOT EXISTS superseded_by_plan_id uuid,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

ALTER TABLE public.mos_task_reservations
  DROP CONSTRAINT mos_task_reservations_status_check,
  ADD  CONSTRAINT mos_task_reservations_status_check
> ⚠ SUPERSEDED by 01-plan-v9.md — §6c step 1 — ONE CHECK with all six values; this fragment omits 'bound'.
    CHECK (status = ANY (ARRAY['reserved','stale','consumed','released','superseded']));

-- ============ inside CREATE OR REPLACE FUNCTION public.mos_campaign_plan_commit(...) ============
-- ... after: PERFORM mos_ledger_lock(); SELECT * INTO v_plan ... FOR UPDATE;
-- ... after the 'already'(approved) short-circuit and the 'not proposed' reject;

  -- (resolved EARLY, above the guard)
  v_campaign := COALESCE(NULLIF(p_materialise ->> 'campaign_id','')::uuid, v_plan.campaign_id);

  -- ... hash gate unchanged ...

  -- ---- NEW: retire the prior plans of this campaign BEFORE the guard ----
  IF v_campaign IS NOT NULL THEN
    -- ids of the plans this commit supersedes
    WITH s AS (
      SELECT id FROM public.mos_campaign_plans
       WHERE campaign_id = v_campaign AND id <> p_plan_id
         AND status IN ('proposed','approved')
    ),
    -- 4a: retire unconsumed reservations (leave assigned/consumed rows alone)
    r AS (
      UPDATE public.mos_task_reservations tr
         SET status='superseded', superseded_by_plan_id=p_plan_id,
             superseded_at=now(), updated_at=now()
       WHERE tr.plan_id IN (SELECT id FROM s)
         AND tr.status IN ('reserved','stale')
         AND tr.consumed_task_id IS NULL
      RETURNING 1
    ),
    -- 4b: close the old plan's OFFERED/parked (open, unassigned) content tasks
    tk AS (
      UPDATE public.workflow_role_tasks t
         SET status='skipped', closed_at=now(),
             note = COALESCE(t.note,'') || ' plan_superseded:' || p_plan_id
       WHERE t.status='open' AND t.assignee_user_id IS NULL
         AND t.subject_table='mos_content'
         AND EXISTS (SELECT 1 FROM public.mos_content_plan cp
                      WHERE cp.content_id=t.subject_id AND cp.plan_id IN (SELECT id FROM s))
      RETURNING t.reservation_id
    ),
    -- terminalise the consumed reservations those closed tasks pointed at
    r2 AS (
      UPDATE public.mos_task_reservations tr
         SET status='superseded', superseded_by_plan_id=p_plan_id,
             superseded_at=now(), updated_at=now()
       WHERE tr.id IN (SELECT reservation_id FROM tk WHERE reservation_id IS NOT NULL)
      RETURNING 1
    )
    -- 4c: flip the plan status (replaces the end-of-function UPDATE)
    UPDATE public.mos_campaign_plans p
       SET status='superseded', superseded_by=p_plan_id, updated_at=now()
     WHERE p.id IN (SELECT id FROM s);
  END IF;

  -- ---- (c) capacity guard: existing = mos_work_ledger_v ALONE, no exclusion ----
  -- (unchanged body; it now naturally omits the retired rows because the view
  --  counts only status IN ('reserved','stale'))
  WITH prop AS ( ... p_reservations ... ),
> ⚠ SUPERSEDED by 01-plan-v9.md — §6a — same-day is derived from row_key (proposed side) / row_id (existing side), never the free-text spread.
       spread AS ( ... mos_spread_effort_mode(..., prop.spread='same_day') ... ),
       agg AS ( SELECT uid,bucket,day,sum(w) proposed FROM spread GROUP BY 1,2,3 )
  SELECT ... INTO v_cells
    FROM agg a
    CROSS JOIN LATERAL (SELECT COALESCE(sum(l.weight),0) existing
                          FROM public.mos_work_ledger_v l
                         WHERE l.user_id=a.uid AND l.day=a.day AND l.bucket=a.bucket) x
   WHERE mos_on_leave(a.uid,a.day) OR (x.existing+a.proposed) > mos_user_daily_slots(a.uid,a.bucket);
  IF jsonb_array_length(v_cells) > 0 THEN
    RAISE EXCEPTION 'capacity_conflict' USING ERRCODE='WS409', DETAIL=v_cells::text;
  END IF;

  -- ... materialise (unchanged) ...
  -- DELETE the old trailing "UPDATE mos_campaign_plans SET status='superseded'..." block (now in 4c).

-- NOTE: WS409/insufficient_privilege only; never SQLSTATE 40001/40P01 (CLAUDE.md).

TESTS:
- re-preview then re-confirm of a PROPOSED plan is idempotent (unchanged): SETUP Plan P (proposed) committed once -> approved with N reservations. Call mos_campaign_plan_commit(P,...) again (same plan_id). | ACTION Second commit runs. | EXPECTED Returns {already:true, ...}; writes nothing; no retirement block runs (short-circuit is before step 4); P's reservations untouched; no plan flipped.
- propose-twice then confirm the second (empty old proposed): SETUP Campaign C: proposed plan P1 (no reservations — proposed plans never hold reservations), then a second propose P2 (proposed). | ACTION Confirm P2. | EXPECTED Step 4a finds 0 unconsumed reservations on P1 (it has none); P1 flipped to superseded; guard sees only P2; commit succeeds. No WS409, no stranded rows.
- genuine re-plan that moves a booking: SETUP Campaign C: approved P1 with 100 reserved (unconsumed) rows on given (user,day,bucket) cells. Operator re-plans -> proposed P2 whose reservations reuse the same cells. | ACTION Confirm P2 via commit_month. | EXPECTED Step 4a sets P1's 100 rows to status='superseded'; guard's existing (mos_work_ledger_v) no longer counts them, so no false capacity_conflict; P2's reservations inserted; post-commit ledger for those cells = P2 only (no double count); mos_plan_start_due later materialises P2 subjects only.
- re-plan while an OLD-plan task is OFFERED (open, unassigned): SETUP P1 approved; one content subject has an open, unassigned (offered/parked) task whose reservation is consumed (the live 4-task shape). | ACTION Confirm P2. | EXPECTED Step 4b closes that task status='skipped' note 'plan_superseded:<P2>'; its reservation set to 'superseded'; the offered work does not linger on anyone's board; P2 re-offers equivalent work. No misleading flag.
- re-plan while an OLD-plan task is ASSIGNED (must remain counted and unchanged): SETUP P1 approved; a content task assigned to مريم, open, reservation consumed, due_at set. | ACTION Confirm P2. | EXPECTED Step 4a skips it (consumed_task_id NOT NULL); step 4b skips it (assignee not null); task stays open+assigned, due_at unchanged, still counted via the ledger task arm; its consumed reservation stays 'consumed'.
- shared ROW subject carries forward, old row reservation retired: SETUP P1 approved with a row reservation (row_id=R, unconsumed) and its open row task; re-plan P2 reuses row_key -> same R, new row reservation. | ACTION Confirm P2. | EXPECTED P1's row reservation set to 'superseded' (4a); the single open row task is NOT closed (row re-pointed to P2, not in S); at next dispatch it consumes P2's row reservation. Exactly one active row reservation remains.
- guard needs no exclusion clause / cannot over-exclude: SETUP Two campaigns A,B each approved; re-confirm A only. | ACTION Confirm A' (new proposed). | EXPECTED Only A's prior reservations are retired (campaign_id filter); B's reservations untouched and still counted; guard reads plain mos_work_ledger_v; B never mis-excluded.
- new status is inert across engine paths: SETUP A reservation set to status='superseded'. | ACTION Run mos_work_ledger_v, mos_plan_start_due, mos_plan_repair, mos_plan_consume_reservation, mos_task_rules_audit. | EXPECTED None count, materialise, re-date, consume, or audit-flag the superseded row (all use positive IN ('reserved','stale') filters).
- CHECK-constraint co-change present: SETUP Apply migration. | ACTION UPDATE a reservation to status='superseded'. | EXPECTED Succeeds (constraint includes 'superseded'); omitting the constraint change makes the commit RAISE a check-violation loudly rather than silently skip retirement.

TABLE What a re-confirm of the running month would strand TODAY (live, 2026-09-22) if §6a is implemented as exclude-not-release:
| campaign | approved plan_id | reservations that would be left live as zombies (reserved, unconsumed) | reservations that correctly stay (consumed, assigned) | plan total |
|---|---|---:|---:|---:|
| 30031ce8 (organic) | 1612301b | 111 | 4 | 115 |
| 4b756383 (paid) | bada9d59 | 119 | 16 | 135 |
| 50b5436e (paid) | c9fc468a | 120 | 15 | 135 |
| 53e12f14 (paid) | a66cd25b | 124 | 11 | 135 |
| TOTAL | | 474 | 46 | 520 |

Under plan v2 as written (exclude from guard, no release), a single re-confirm would pass the guard yet leave all 474 rows `reserved` under superseded plans — double-counted in every later ledger read and materialisable by mos_plan_start_due. Under this contract those 474 become `superseded` (inert) and the 46 consumed rows stay counted through their tasks.

TABLE Duplicate-work amplifier (live):
| plan_id | old-plan content status='planned' with production_start set |
|---|---:|
| 1612301b (organic) | 66 |

These are old-plan subjects mos_plan_start_due would try to materialise into fresh tasks after supersession if their reservations are not retired (row-member content is materialised via its row; standalone content via the content arm). Retiring the reservations + closing offered tasks removes the duplicate-materialisation path.

IMPACTS: Plan v2 §6a (the guard): DELETE the clause 'Reservations of plans this commit supersedes ... are excluded'; replace with 'the superseded plans' unconsumed reservations are retired to status=superseded before the guard runs; existing = mos_work_ledger_v alone with no plan/status exclusion.' The row_key-not-spread parity fix stays. | Plan v2 §6b (migration schema list): add mos_task_reservations.superseded_by_plan_id, .superseded_at, and the CHECK-constraint value 'superseded' to the migration's schema step (step 1). | Plan v2 §3 (one decider / mos_refill): mos_refill 'release strays' and mos_task_open must ignore status='superseded' the same way they ignore released/consumed (they already gate on reserved/stale, so this is a no-op to verify, not a change). | Plan v2 §5 (idempotent completion) is unaffected — retirement runs at commit, not on task completion; but the offered-task close in 4b must use the same skipped+closed_at posture the phantom-close uses so it does not collide with mos_completion_events. | Operator decision #5 (archiving auto-closes open tasks): this contract closes offered old-plan tasks as skipped — consistent; if #5 is answered 'no', keep the close anyway because a superseded plan's offered task is not the archive case (the plan, not the content, is retired). | mos_task_rules_audit: its R1/R2 scans use positive reserved/stale filters, so superseded rows drop out cleanly; no restatement needed, but add a check that no open task points at a superseded reservation (should be 0 after 4b). | Adjacent path: mos_campaign_plans status 'discarded' (allowed by the CHECK) — whatever sets it should also release that plan's unconsumed reservations; out of this issue's commit scope but worth a follow-up so discarded plans don't leak the same way superseded ones would.
OPEN: Does plan v2's mos_task_open, when it OFFERS a task (opened+bound+unassigned), consume the reservation (as today's 4 parked tasks show consumed reservations) or leave it reserved? If offered tasks leave their reservation reserved, step 4a already retires them; if they consume it, step 4b (close task + retire its consumed reservation) is the arm that handles them. The contract covers both, but the exact mos_task_open binding semantics should be pinned before implementation. | Should a re-confirm be ALLOWED at all once an old-plan content step is in production (assigned/started)? The contract keeps assigned work but the new compile makes fresh content, so the finished old-plan work is orphaned from the new plan. Operator decision #6 (re-plan running month: proposed 'no') largely avoids this, but the steady-state re-plan of a partially-produced future month needs an explicit rule. | Confirm the exact column name on workflow_role_tasks used for the 'offered/parked' distinction under plan v2 (offered_to_user_id / due_at IS NULL) so 4b targets offered tasks precisely and never an in-flight one. | Choice of terminal value: distinct 'superseded' (recommended, auditable, needs the CHECK change) vs reuse 'released' (no CHECK change, needs a release_reason to stay auditable). Both verified inert; operator/implementer picks one.
PLAIN: The reviewer is right. When the team re-plans a campaign and confirms the new plan, the system marks the OLD plan as 'superseded' but forgets to cancel the old plan's booked work. Those old bookings just sit there, still counted against people's daily capacity and — worse — the dispatcher can still turn them into real tasks, so the same work could get handed out twice. Plan v2's idea was to just tell the capacity check to ignore the old bookings so the re-confirm doesn't wrongly complain about being over capacity. But ignoring them in the check while leaving them alive means the check approves a schedule that is actually double-booked. The fix is to actually retire the old plan's bookings in the same step that supersedes the plan: cancel every old booking that nobody has started yet (mark it 'superseded' so it drops out of the capacity math and out of every dispatcher path), and leave alone any booking someone is already working — that stays counted and untouched. Old 'offered but not started' tasks from the dead plan are closed with a note, because the new plan will re-offer that work; we don't try to rewire them to the new plan because the new plan builds fresh items and a wrong match would hand someone the wrong creative. With the old bookings genuinely gone, the capacity check needs no special 'ignore these' rule — it just reads the true remaining load. Today this bug has not bitten yet (no plan has been re-confirmed), but a single re-confirm of the current month would strand 474 old bookings across the four campaigns, so it must be fixed before the redesign ships. The change is confined to one database function plus adding one new status value and two bookkeeping columns.


# ISSUE Reviewer Issue 5 — the running-month migration's promised deadline results in plan-v2 §2/§6 do not follow the plan's own  [label=None]
> ⚠ SUPERSEDED by 01-plan-v9.md — §6c/§8 — the 17 assigned / 4 unassigned split and the review 16:00 chain stand; everything labelled 'offered' here is Band C.
VERDICT: confirmed
EVIDENCE: ALL FOUR of the reviewer's specific claims are CONFIRMED against the live DB (read-only RPC, 2026-09-22).

1) NO `round` COLUMN. information_schema.columns for public.mos_task_reservations returns exactly: id, plan_id, cycle_id, content_id, content_key, step_key, role_key, assignee_user_id, bucket, planned_start, planned_end, weight, status, consumed_task_id, created_at, updated_at, row_id. There is no `round`. The §6-step-1 index expression `(COALESCE(content_id::text,row_id::text,cycle_id||':'||content_key), step_key, round)` would fail with 42703 undefined column. (Note: `round` is a workflow_role_tasks concept for revisions; reservations are the plan forecast and have no round — dropping it is semantically correct.)

2) THE 4 UNASSIGNED ARE INSIDE THE 21. The 23 open (status='open') tasks decompose as: 17 assigned reservation-backed (سارة design P-471..477 =7; مريم writing P-479/480/487 =3; حسام writing_review P-478/481/482/483/484/485/486 =7) + 4 UNASSIGNED reservation-backed (P-488/489/490/491, writing, waiting_reason='capacity', reservation_id set, writing reservation status='consumed'→their own open task) + 2 with NO reservation (P-135 phantom design on ريان; row 2026-09:w3:2026-09-22:b design r2 on سارة). 17+4+2=23; 17+4=21 reservation-backed. PostgreSQL GREATEST ignores NULL and returns the non-null arg, so GREATEST(NULL::timestamptz, plan_due_at)=plan_due_at — running §6 step 4's blanket update over the 21 gives P-488..491 due_at=2026-09-28 00:00, contradicting §4a ("offered: due_at NULL").

3) REVIEW DEADLINES ARE 16:00, NOT 24:00. Live probe: mos_work_due_at('2026-09-28 04:00:00+03',12)=2026-09-28 16:00; mos_work_due_at('2026-09-27 04:00:00+03',12)=2026-09-27 16:00. Chain: writing_review handoff = GREATEST(bookedDay 00:00, mos_work_due_at(writing_handoff 00:00, target_writing 4h)=bookedDay 04:00) = bookedDay 04:00; plan_due = mos_work_due_at(04:00, allowance 12h) = bookedDay 16:00. So حسام's 7 reviews' plan_due are 2026-09-28 16:00 (P-478/481/482/483) and 2026-09-27 16:00 (P-484/485/486), never 24:00. (Writing IS midnight — mos_work_due_at('2026-09-27 00:00+03',24)=2026-09-28 00:00 — so §6's "24/24/27 Sep 24:00" for مريم's 3 writing tasks is CORRECT; only the review line is wrong.)

4) P-477 MUST EXTEND. Live: task 64a7ecc3 P-477 design, assignee سارة, assigned 2026-09-20 19:32, due 2026-09-21 19:32, reservation 5a78f58e planned_start=planned_end=2026-09-28 (all five of P-477's steps booked 28 Sep). Chain design handoff = GREATEST(28 00:00, 28 06:00)=28 06:00; plan_due = mos_work_due_at('2026-09-28 06:00+03',24)=2026-09-29 06:00 (live-verified). GREATEST(2026-09-21 19:32, 2026-09-29 06:00)=2026-09-29 06:00 → EXTENDED by ~7 days, not "unchanged".

INDEX UNIQUENESS (corrected form): SELECT over all 520 reservations grouped by (COALESCE(content_id::text,row_id::text,cycle_id::text||':'||content_key), step_key) → total_rows=520, distinct_keys=520, dup_excess=0. Shape breakdown: 300 rows content_id NULL+row_id NULL+cycle_id+content_key (virtual c2–c5 creatives), 115 rows row_id set (organic rows), 105 rows content_id set (materialized paid, cycle_id also set → COALESCE picks content_id). So virtual subjects ARE covered by the third COALESCE branch; 0 collisions today; a virtual→materialized transition mutates the same row's key (cycle:ckey→content_id) with no new row, so the index stays unique across materialization. The literal expression `cycle_id||':'||content_key` also parses (Postgres `anynonarray || text`), so `round` is the ONLY index defect; I still recommend explicit `cycle_id::text` for clarity.

mos_work_due_at model verified: skips Friday (dow=5); Friday probe mos_work_due_at('2026-09-24 20:00+03',12)=2026-09-26 08:00 (Sat). No open-task chain in this set crosses a Friday. A Python re-implementation of mos_work_due_at reproduced every live probe exactly and was used to compute the full table.

SOURCE lines: plan-v2 §6 step 4 (01-plan-v2.md:200) "write plan_* onto the 21 open reservation-backed tasks; due_at := GREATEST(due_at, plan_due_at) (never shortened); the 4 waiting P-488…491 → offered"; §6 step 1 (01-plan-v2.md:197) index with `round`; §2 (01-plan-v2.md:114) "سارة's 6 launch designs keep today's 19:31–19:40 ... plan target, 21 Sep, is already past"; §6 dry-run table (01-plan-v2.md:211-212) حسام "due 27/28 Sep 24:00" and سارة "6 launch designs + P-477 + row r2 ... unchanged (plan target passed)". Live-state corroboration: 04-live-state-tables-22sep.md open_tasks_23.

CONTRACT: Replace plan-v2 §6-step-4's single deadline write with an assignment-state split, and drop `round` from the reservation index.

RULE A — 17 open ASSIGNED reservation-backed tasks (assignee_user_id IS NOT NULL): set plan_handoff_at and plan_due_at from the §1 chain (mos_plan_chain over the subject's reservations, using *_corrected days where present, else *_orig; for these open steps corrected=original because the open step is always CONSUMED/in-progress and the correction moves only NOT-STARTED reserved steps), then due_at := GREATEST(due_at, plan_due_at) [plus the existing approved-leave extension]. Never shortened. Chain constants: target_hours writing 4 / writing_review 2 / design 4 / design_writer_review 2 / design_review 2; allowance_hours 24/12/24/12/12; each handoff_k = GREATEST(bookedDay_k 00:00 Riyadh, mos_work_due_at(handoff_{k-1}, target_{k-1})); plan_due_k = mos_work_due_at(handoff_k, allowance_k). Consequence: reviews are due at their booked-day 16:00/22:00/next-00:00 (per chain position), NOT a blanket midnight; only a first-step writing task lands on midnight.

> ⚠ SUPERSEDED by 01-plan-v9.md — §6c step 6 — P-488…491 become Band C (offered_to NULL, waiting_reason NULL, due_at NULL, plan_* stamped); the migration never sets offered_to.
RULE B — 4 open UNASSIGNED reservation-backed tasks (P-488..491): convert to OFFERED. Set plan_handoff_at and plan_due_at (2026-09-28 00:00, tracked/immutable), offered_to_user_id = the sole writer holder, offered_at = now(), waiting_reason='offered', waiting_since=NULL, and due_at STAYS NULL. Do NOT run GREATEST on them. Implement as one guarded statement: due_at := CASE WHEN assignee_user_id IS NULL THEN NULL ELSE GREATEST(due_at, plan_due_at) END — or two UPDATEs each with an explicit WHERE on assignee_user_id — so an offer can never receive a countdown.

RULE C — the 2 non-reservation open tasks are outside the reservation-backed set: P-135 phantom → status='skipped' (closed), not in the due update; row r2 design (revision, round 2, no reservation) → keeps its receipt-relative due_at 2026-09-22 18:50 (unplanned work).

RULE D — reservation UNIQUE index: drop the nonexistent `round`. UNIQUE (COALESCE(content_id::text, row_id::text, cycle_id::text||':'||content_key), step_key), created after a 0-duplicate assertion (holds today: 520/520). This covers virtual subjects (content_id NULL, row_id NULL → cycle_id:content_key), the 300-row majority, and is stable across virtual→materialized transitions.

Correct per-task results (Riyadh): sara design P-471/473/474 → 2026-09-22 06:00 (EXTENDED); P-472/475/476 → 2026-09-22 19:40 (unchanged, current later); P-477 → 2026-09-29 06:00 (EXTENDED). maryam writing P-479/480 → 2026-09-29 00:00; P-487 → 2026-09-28 00:00 (all EXTENDED). hosam writing_review P-478/481/482/483 → 2026-09-28 16:00; P-484/485/486 → 2026-09-27 16:00 (all EXTENDED). P-488..491 → due_at NULL, plan_due_at 2026-09-28 00:00. P-135 → closed. row r2 → 2026-09-22 18:50.

SKELETON:
-- ============ CORRECTED §6 step 4: split ASSIGNED vs OFFERED ============
-- Assumes mos_plan_chain(subject_table, subject_id) returns (step_key, plan_handoff_at, plan_due_at)
-- computed with target 4/2/4/2/2, allowance 24/12/24/12/12, anchored on booked-day 00:00 via mos_work_due_at,
-- preferring *_corrected over *_orig.

-- (A) 17 open ASSIGNED reservation-backed tasks: floor deadline on the plan, never shorten.
UPDATE public.workflow_role_tasks t
   SET plan_handoff_at = c.plan_handoff_at,
       plan_due_at     = c.plan_due_at,
       due_at          = GREATEST(t.due_at, c.plan_due_at)      -- + existing approved-leave extension
  FROM public.mos_plan_chain(t.subject_table, t.subject_id) c
 WHERE t.status = 'open'
   AND t.reservation_id IS NOT NULL
   AND t.assignee_user_id IS NOT NULL          -- <<< the fix: excludes the 4 offers
   AND c.step_key = t.step_key;

-- (B) 4 open UNASSIGNED reservation-backed tasks -> OFFERED; due_at MUST stay NULL.
UPDATE public.workflow_role_tasks t
   SET plan_handoff_at    = c.plan_handoff_at,
       plan_due_at        = c.plan_due_at,      -- tracked/immutable (2026-09-28 00:00)
       due_at             = NULL,               -- <<< preserved: an offer has no countdown
> ⚠ SUPERSEDED by 01-plan-v9.md — §6c step 6 — delete the mos_sole_holder / offered / waiting_reason writes; migration writes Band C.
       offered_to_user_id = public.mos_sole_holder(t.role_key),  -- or the role's routine holder
       offered_at         = now(),
       waiting_reason     = 'offered',
       waiting_since      = NULL
  FROM public.mos_plan_chain(t.subject_table, t.subject_id) c
 WHERE t.status = 'open'
   AND t.reservation_id IS NOT NULL
   AND t.assignee_user_id IS NULL              -- <<< only the offers
   AND c.step_key = t.step_key;

-- (C) phantom (no reservation) closed; row r2 revision left as-is (receipt-relative due).
UPDATE public.workflow_role_tasks
   SET status='skipped', closed_at=now(), note = COALESCE(note,'')||' [migration: archived-subject phantom closed]'
 WHERE status='open' AND reservation_id IS NULL
   AND public.mos_subject_inactive(subject_table, subject_id);   -- P-135 only; row r2 subject is active -> untouched

-- ============ CORRECTED §6 step 1: reservation UNIQUE index (drop `round`) ============
DO $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM public.mos_task_reservations
       GROUP BY COALESCE(content_id::text, row_id::text, cycle_id::text||':'||content_key), step_key
> ⚠ SUPERSEDED by 01-plan-v9.md — §6b — the 0-duplicates assertion is scoped to the live statuses, never all statuses.
      HAVING count(*) > 1
  ) THEN
      RAISE EXCEPTION 'MOS:RESV_SUBJECT_STEP_DUP subject+step duplicates exist' USING ERRCODE='raise_exception';
  END IF;
END $$;

> ⚠ SUPERSEDED by 01-plan-v9.md — §6b — the index must be PARTIAL: WHERE status IN ('reserved','stale','bound','consumed'); an unconditional index rejects every re-plan of a shared row or virtual creative.
CREATE UNIQUE INDEX mos_task_reservations_subject_step_uidx
  ON public.mos_task_reservations
     (COALESCE(content_id::text, row_id::text, cycle_id::text||':'||content_key), step_key);
-- (No `round`: the column does not exist on mos_task_reservations; reservations are single-round forecasts.)

TESTS:
> ⚠ SUPERSEDED by 01-plan-v9.md — §9 B0 — expected waiting_reason NULL and offered_to NULL (only due_at NULL + plan_due_at set are correct).
- offers keep NULL due_at: SETUP Run the corrected migration against the 4 open unassigned reservation-backed writing tasks P-488/489/490/491. | ACTION SELECT id, assignee_user_id, due_at, plan_due_at, waiting_reason FROM workflow_role_tasks WHERE ref IN ('P-488','P-489','P-490','P-491'). | EXPECTED All four: due_at IS NULL, waiting_reason='offered', offered_to_user_id set, plan_due_at = 2026-09-28 00:00+03. No mos_late_events, no late_flag.
- assigned deadlines floored on plan, never shortened: SETUP Run the corrected migration; capture each of the 17 open assigned reservation-backed tasks' old due_at first. | ACTION Compare new due_at to old due_at and to plan_due_at. | EXPECTED For every one: new due_at = GREATEST(old due_at, plan_due_at) and new due_at >= old due_at (never decreased).
- P-477 extended, not unchanged: SETUP P-477 design open on سارة, reservation booked 2026-09-28. | ACTION SELECT due_at, plan_due_at FROM workflow_role_tasks WHERE ref='P-477'. | EXPECTED plan_due_at = due_at = 2026-09-29 06:00+03 (extended ~7 days from the pre-migration 2026-09-21 19:32).
- reviews due at 16:00 not midnight: SETUP حسام's 7 open writing_review tasks after migration. | ACTION SELECT ref, plan_due_at FROM workflow_role_tasks WHERE step_key='writing_review' AND status='open'. | EXPECTED P-478/481/482/483 → 2026-09-28 16:00+03; P-484/485/486 → 2026-09-27 16:00+03. None is a 24:00/00:00 value.
- launch designs split correctly: SETUP سارة's 6 launch design tasks P-471..476. | ACTION SELECT ref, due_at FROM workflow_role_tasks WHERE ref IN ('P-471','P-472','P-473','P-474','P-475','P-476'). | EXPECTED P-471/473/474 → 2026-09-22 06:00 (extended from 09-21 19:3x); P-472/475/476 → 2026-09-22 19:40 (unchanged, receipt-relative later than plan_due).
- reservation index builds without round and is unique: SETUP Apply the corrected index migration on the live 520 reservations. | ACTION CREATE UNIQUE INDEX ... (COALESCE(content_id::text,row_id::text,cycle_id::text||':'||content_key), step_key); then check virtual coverage. | EXPECTED Index creates successfully (no 42703 for `round`); 0-duplicate pre-assert passes (520/520 distinct); a spot-check of a content_id-NULL,row_id-NULL virtual reservation shows its key = cycle_id::text||':'||content_key.
- phantom closed, revision untouched: SETUP P-135 (archived, no reservation) and row r2 design (revision, no reservation). | ACTION SELECT ref_or_row, status, due_at FROM workflow_role_tasks for both. | EXPECTED P-135 status='skipped' (closed); row r2 still status='open', due_at=2026-09-22 18:50 unchanged (not in the reservation-backed update).

TABLE open_task_deadline_comparison_current_to_proposed (all 23, Riyadh, exact proposed logic):
| ref | open step | who | current due_at | plan_handoff (open step) | plan_due_at (chain) | proposed due_at | change |
|---|---|---|---|---|---|---|---|
| P-471 | design | سارة | 2026-09-21 19:32 | 2026-09-21 06:00 | 2026-09-22 06:00 | **2026-09-22 06:00** | EXTENDED +10.5h |
| P-472 | design | سارة | 2026-09-22 19:40 | 2026-09-21 06:00 | 2026-09-22 06:00 | 2026-09-22 19:40 | unchanged (current later) |
| P-473 | design | سارة | 2026-09-21 19:31 | 2026-09-21 06:00 | 2026-09-22 06:00 | **2026-09-22 06:00** | EXTENDED +10.5h |
| P-474 | design | سارة | 2026-09-21 19:31 | 2026-09-21 06:00 | 2026-09-22 06:00 | **2026-09-22 06:00** | EXTENDED +10.5h |
| P-475 | design | سارة | 2026-09-22 19:40 | 2026-09-21 06:00 | 2026-09-22 06:00 | 2026-09-22 19:40 | unchanged (current later) |
| P-476 | design | سارة | 2026-09-22 19:40 | 2026-09-21 06:00 | 2026-09-22 06:00 | 2026-09-22 19:40 | unchanged (current later) |
| P-477 | design | سارة | 2026-09-21 19:32 | 2026-09-28 06:00 | 2026-09-29 06:00 | **2026-09-29 06:00** | EXTENDED +7d (target 28 Sep is FUTURE) |
| P-479 | writing | مريم | 2026-09-22 14:00 | 2026-09-28 00:00 | 2026-09-29 00:00 | **2026-09-29 00:00** | EXTENDED +6d |
| P-480 | writing | مريم | 2026-09-22 14:00 | 2026-09-28 00:00 | 2026-09-29 00:00 | **2026-09-29 00:00** | EXTENDED +6d |
| P-487 | writing | مريم | 2026-09-22 14:00 | 2026-09-27 00:00 | 2026-09-28 00:00 | **2026-09-28 00:00** | EXTENDED +5d |
| P-478 | writing_review | حسام | 2026-09-22 03:59 | 2026-09-28 04:00 | 2026-09-28 16:00 | **2026-09-28 16:00** | EXTENDED (16:00, not 24:00) |
| P-481 | writing_review | حسام | 2026-09-22 02:54 | 2026-09-28 04:00 | 2026-09-28 16:00 | **2026-09-28 16:00** | EXTENDED (16:00) |
| P-482 | writing_review | حسام | 2026-09-22 10:34 | 2026-09-28 04:00 | 2026-09-28 16:00 | **2026-09-28 16:00** | EXTENDED (16:00) |
| P-483 | writing_review | حسام | 2026-09-22 04:36 | 2026-09-28 04:00 | 2026-09-28 16:00 | **2026-09-28 16:00** | EXTENDED (16:00) |
| P-484 | writing_review | حسام | 2026-09-22 10:26 | 2026-09-27 04:00 | 2026-09-27 16:00 | **2026-09-27 16:00** | EXTENDED (16:00) |
| P-485 | writing_review | حسام | 2026-09-22 04:43 | 2026-09-27 04:00 | 2026-09-27 16:00 | **2026-09-27 16:00** | EXTENDED (16:00) |
| P-486 | writing_review | حسام | 2026-09-22 10:19 | 2026-09-27 04:00 | 2026-09-27 16:00 | **2026-09-27 16:00** | EXTENDED (16:00) |
> ⚠ SUPERSEDED by 01-plan-v9.md — §8 — these four rows are Band C bound-unassigned, not '(offer)/(offered)'; the NULL due is correct, the label is not.
| P-488 | writing | (offer) | (none) | 2026-09-27 00:00 | 2026-09-28 00:00 | **NULL (offered)** | plan_due tracked; NOT a due |
| P-489 | writing | (offer) | (none) | 2026-09-27 00:00 | 2026-09-28 00:00 | **NULL (offered)** | plan_due tracked; NOT a due |
| P-490 | writing | (offer) | (none) | 2026-09-27 00:00 | 2026-09-28 00:00 | **NULL (offered)** | plan_due tracked; NOT a due |
| P-491 | writing | (offer) | (none) | 2026-09-27 00:00 | 2026-09-28 00:00 | **NULL (offered)** | plan_due tracked; NOT a due |
| P-135 | design (phantom) | ريان | 2026-09-06 17:00 | — (no reservation) | — | closed (skipped) | archived subject; not in due update |
| ROW w3:09-22:b | design r2 (revision) | سارة | 2026-09-22 18:50 | — (no reservation) | — | 2026-09-22 18:50 | unplanned; receipt-relative, unchanged |

Bold = value the corrected logic produces where plan-v2 says something different. All plan_due_at values reproduced by live mos_work_due_at.

TABLE plan_v2_sentences_contradicted:
| loc | plan-v2 text | corrected value |
|---|---|---|
> ⚠ SUPERSEDED by 01-plan-v9.md — §8 — terminology: 'offers' → Band C bound-unassigned; the NULL-due conclusion stands.
| §6 step 4 (line 200) | "write plan_* onto the 21 open reservation-backed tasks; due_at := GREATEST(due_at, plan_due_at)" applied to all 21 | Must exclude the 4 offers: `CASE WHEN assignee_user_id IS NULL THEN NULL ELSE GREATEST(due_at, plan_due_at) END`. As written it sets P-488..491 due_at = 2026-09-28 00:00, breaking §4a (offers have NULL due). |
| §6 step 1 (line 197) | UNIQUE index `(…, step_key, round)` | `round` column does not exist on mos_task_reservations → drop it: `(COALESCE(content_id::text,row_id::text,cycle_id::text||':'||content_key), step_key)`; 0 dups today (520/520); virtual subjects covered. |
| §2 (line 114) | "سارة's 6 launch designs keep today's 19:31–19:40 (their plan target, 21 Sep, is already past — full allowance stands)" | Only P-472/475/476 keep 2026-09-22 19:40. P-471/473/474 EXTEND to 2026-09-22 06:00 (their design plan_due 09-22 06:00 > current 09-21 19:3x). The design plan_due is 09-22 06:00, not "21 Sep"; booked day ≠ deadline. |
| §6 table (line 212) | "سارة — 6 launch designs + P-477 + row r2 … unchanged (plan target passed; full allowance stands)" | P-471/473/474 → 09-22 06:00 (extended); P-477 → 09-29 06:00 (extended; target 28 Sep is FUTURE); only P-472/475/476 + row r2 unchanged. |
| §6 table (line 211) | "حسام — 7 writing_review … due 27/28 Sep 24:00 (planned)" | Reviews' plan_due = booked-day 16:00: P-478/481/482/483 → 09-28 16:00; P-484/485/486 → 09-27 16:00. Not 24:00. |
| §2 (line 114) | "The 21 open assigned tasks keep their assignment" | Only 17 of the 21 are assigned; 4 (P-488..491) are unassigned → offered. Mislabel is the root of the GREATEST-over-NULL bug. |
| §2 (line 114) / §6 table (line 208) — مريم's 3 writing "27/28 Sep 24:00" | (CORRECT, no change) | Writing plan_due IS midnight: P-487 → 09-28 00:00, P-479/480 → 09-29 00:00 (= "27/28 Sep 24:00"). Only the review line, not the writing line, is wrong. |

> ⚠ SUPERSEDED by 01-plan-v9.md — §4/§8/§10 — in the IMPACTS and OPEN items below, every 'offered' reading of P-488…491 is Band C (offered_to NULL); Rule B is replaced by the three-band model; P-477 and the early launch designs stay assigned with the extended planned deadline (decision 3).
IMPACTS: §1c anchor consistency: for the one-shot migration the receipt leg mos_work_due_at(assigned_at, allowance) equals each already-issued task's current due_at (that is how dispatch set it), so GREATEST(current due_at, plan_due_at) is exactly the §1b rule at the migration moment — the split fix does not disturb §1. | §4 (offered work): the corrected Rule B is what actually realises §4a. plan_due_at should be POPULATED on offered tasks (immutable tracking) while due_at stays NULL; when the 27 Sep planned day arrives and the offer is started, §4a's due_at=GREATEST(plan_due_at, now+allowance)=plan_due_at=2026-09-28 00:00 holds. | §2/§6 publication-risk counts: mos_publication_risk folds the SAME chain; because reviews finish at 16:00 (not 24:00) the projected-ready is slightly EARLIER, i.e. more slack, so the 38 at-risk / 0-late verdict is unaffected or marginally improved — but the §2/§6 narrative that reviews land at midnight must be corrected wherever risk is explained. | §6 correction of the 116 reserved steps is unaffected by this fix (those are NOT-STARTED reserved rows; the open-task due update is a separate write). But the mos_plan_chain used to fill *_corrected/plan_due for reserved rows must use the same target/allowance constants, or reserved-row plan_due and open-task plan_due will disagree. | The 'launch creatives flagged at_risk' note in §6 stands for P-471..476 (design still open, ads due 12:00 today), independent of whether their due_at extends — employee lateness (due_at) and publication risk are the separate measures §1 promises.
OPEN: P-477 (and P-471/473/474): these were dispatched EARLY relative to their booked day (P-477 design booked 28 Sep, in progress since 20 Sep). The reviewer only asked to correct the due; extending P-477 to 2026-09-29 06:00 is correct under the rule but leaves سارة holding an assigned task whose deadline is a week out. Confirm the migration should keep it assigned+extended, or instead re-offer such early-started future work (would require un-consuming a reservation — out of scope for a due-only fix). | Should offered tasks (P-488..491) carry plan_due_at populated (recommended, for the «القادم» plan view and for the start-early path) or NULL? Plan §4a specifies due_at NULL but is silent on plan_due_at; this contract populates it. | design_review is the only step whose plan_due can legitimately be a midnight/next-00:00 value (single-day row: handoff 12:00 + 12h). No open design_review task exists today, so the §6 '24:00' generalization is never right for the current open set — but confirm the chain for a future open design_review so the same '24:00' error is not reintroduced downstream. | row r2 (design revision, no reservation): treated as unplanned (receipt-relative due kept). Confirm revisions are intended to be excluded from the plan-floor GREATEST entirely (plan §4 lane 4 implies yes: unplanned work uses the open-units rule, not a reservation deadline).
PLAIN: The reviewer is right on all four points, and I re-computed the whole before/after table from the live database to prove it.\n\nThink of the migration as re-setting each open task's due date to match the plan you approved, but never making a date earlier than what was already promised. Plan v2 wrote that step in a way that has four mistakes:\n\n1. It runs the 'never make it earlier' rule over 21 tasks — but 4 of those 21 are the tasks nobody has been given yet (P-488..491, next week's ad texts). Those are supposed to be 'available to start early, no clock running.' The way the rule is written, they'd wrongly get a due date of 28 Sep. Fix: only touch the 17 tasks that actually have an owner; leave the 4 with no due date (just show their planned day).\n\n2. It says P-477 'stays the same because its date passed.' But P-477's design is actually booked for 28 Sep — that's in the future — so its due date should move OUT to 29 Sep, not stay at yesterday. The plan confused 'the booked day' with 'the deadline.'\n\n3. It promises the manager's reviews are due at midnight (27/28 Sep 24:00). The plan's own math (handoff + 12 hours) makes them due at 4 p.m. that day, not midnight. Writing tasks DO land on midnight, so that part was fine — only the reviews line is wrong.\n\n4. The new 'no duplicates' index it wants to build refers to a column called 'round' that simply isn't in that table. Building it would fail. Drop 'round'; the index then works and I confirmed there are zero duplicates today, and it correctly covers the future ad creatives that don't have an id yet.\n\nBiggest surprises in the corrected numbers: three of the six launch designs and P-477 all get LATER deadlines (they were handed out too early, so their honest plan deadline is later), and the manager's whole review queue moves from 'due this morning' to 27–28 Sep afternoon. Nobody's deadline gets shorter, and the four early ad texts correctly get no deadline at all.


# ISSUE Reviewer Issue 6: the four existing future tasks (P-488..491 — writing step, planned 27 Sep, currently unassigned with w  [label=None]
> ⚠ SUPERSEDED by 01-plan-v9.md — §4 — transitions here lack B→C withdrawal and start-early re-validation (v4 §4c–4f); the 'refill re-runs → stays B' rule is conditional on the eligibility predicate.
VERDICT: confirmed
EVIDENCE: THE THREE CONTRADICTORY STATEMENTS, quoted verbatim from docs/reviews/mos-assignment-redesign-2026-09-22/01-plan-v2.md:

1. §4b "Applied to today" (line 161): "مريم holds 3 open writing tasks → not idle → no early offer yet; the 4 waiting P-488…491 (planned 27 Sep) become **offered**, no countdown. When she finishes the 3, the earliest future day with executable writing is Wed 23 Sep (the Thu 24 batch) → offered whole; the 27 Sep set is not exposed until she is idle again and no earlier day remains." — This one sentence contains ALL THREE reviewer descriptions: "no early offer yet" (=c), "become offered, no countdown" (=a), and "not exposed until she is idle again and no earlier day remains" (=b).
2. §6 migration step 4 (line 200): "the 4 waiting P-488…491 → `offered`".
3. §6 dry-run table (line 209): "مريم — 4 waiting writing (P-488…491) | unassigned \"capacity\", invisible to her | **offered** (planned 27 Sep), visible, no countdown; mandatory on 27 Sep".

Statements 2 and 3 make the four tasks `offered` at migration; statement 1's tail says the 27 Sep set is "not exposed until she is idle again and no earlier day remains." Both cannot hold. ROOT CAUSE: plan v2 overloads the one word "offered" to mean two different things — (i) materialized+visible+startable-early (the idle-gated, one-future-day batch of §4b step 3), and (ii) merely visible future planned work. The operator's own rule (00-reviewer-briefing.md line 83) already separates them: "distinguish 'available to start early' from 'required now' ... select the early batch once per refill — the whole ready batch of one future planned day ... blocked work on the earliest future day must not hide later executable work." Plan v2's own §4b step 3 correctly gates the early batch on the idle test and the earliest-executable-future-day, so the "→ offered" for P-488..491 is inconsistent with the plan's own selection algorithm (مريم is not idle; and even when idle, 23 Sep — not 27 Sep — is her earliest executable future day).

WHAT THE APP RENDERS TODAY (code, file:line):
- api/marketing-os.ts:1258-1289 `readOpenQueueTasks` — my queue = assignee=me OR (assignee IS NULL AND waiting_since IS NULL AND role IN my roles). Line 1277 explicitly excludes waiting rows ("Waiting work ... is nobody's to claim"). So P-488..491 (waiting_since set) are excluded → INVISIBLE to مريم. This is finding 9 / defect D4.
- api/marketing-os.ts:889-923 `mapRoleTask` — exposes id, due_at, assigned_at, units, waiting_since, waiting_reason, but NOT scheduled_start/end, and no plan_handoff_at / plan_due_at / offered_to / at_risk (those columns do not exist yet — see live-schema check below). The SPA has ZERO plan-date visibility on any task today.
- api/marketing-os.ts:5271-5313 the `upcoming` list («القادم إليك») is derived from `mos_content_v` (line 5273-5276): status not in draft/done, `.neq('owner_role', myRole)`, then walks the PINNED steps for a future step whose role_key = mine. It is NOT the planner's reservation forecast; it only sees IN-FLIGHT content items and has no planned day. Reservation-only future work never appears.
- src/pages/Marketing/WorkPage.tsx:680-682 bands = late / mine / others, computed purely by `itemLate` (due_at<now) and role match (`itemMine`). Render at WorkPage.tsx:1323-1379: «متأخر» (Late), ManualBlock, «مطلوب منك اليوم» (Yours today), «القادم إليك — ليست مهامًا بعد» (the upcoming heuristic), «بانتظار شخص آخر». Header comment WorkPage.tsx:10-13 states «القادم إليك» is NOT tasks. There is no band for offered/early or for the planner's future reservations.
- Client types have no plan/offered fields: src/lib/marketingOS/rowClient.ts:69-96 MosSubjectTask; the payload MosWorkQueue (rowClient.ts:167-178) carries content/tasks/upcoming/manual_tasks/rows but does NOT even type `ledger` (shipped at marketing-os.ts:5340 but rendered nowhere) — corroborating finding 9 ("the per-person planned forecast is shipped in the payload and rendered nowhere").

LIVE DB EVIDENCE (read-only RPC, 2026-09-22):
> ⚠ SUPERSEDED by 01-plan-v9.md — §4a — band predicates are column-only; refill never writes waiting_reason='offered' (also drop it from mos_planned_steps).
- workflow_role_tasks columns: contains scheduled_start/scheduled_end (date), blocked, blocked_reason, waiting_since, waiting_reason; NO offered_to_user_id, offered_at, plan_handoff_at, plan_due_at, at_risk, risk_reason — all are proposed additions. Confirmed count query: 0 open tasks have waiting_reason='offered' and 0 are blocked today (the 'offered' state does not exist yet).
- Open tasks (23): مريم (writer, user 3eea9a65) has 3 ASSIGNED open writing tasks P-479/P-480/P-487 (assigned_at 21 Sep 14:00, due 22 Sep 11:00Z=14:00 Riyadh, scheduled_start P-487=27 Sep, P-479/480=28 Sep) and 4 UNASSIGNED open writing tasks P-488/489/490/491 (assignee NULL, waiting_reason='capacity', due NULL, scheduled_start 27 Sep, reservation_id set).
- mos_task_reservations for writer/writing (assignee = مريم 3eea9a65 on every row): 23 Sep reserved wt=3 (organic ROW, first step → executable, NOT materialized), 24 Sep reserved wt=3 (row), 26 Sep reserved wt=3 (row), 28 Sep reserved wt=3 (row); 27 Sep are consumed (→ the P-484..491 tasks). So مريم's earliest FUTURE executable writing day is 23 Sep, confirming that even when idle the offered batch would be the 23 Sep row, never the 27 Sep set. The 27 Sep P-488..491 reservations are consumed (consumed_task_id set), i.e. the tasks are already materialized.

CONTRACT: ONE VISIBILITY MODEL — three mutually-exclusive, exhaustive bands per person. The distinction the reviewer asks for is carried by exactly two task columns: `assignee_user_id` and `offered_to_user_id` (+ `due_at NULL`). The bands are a pure PARTITION of "my planned work"; the idle-test and one-future-day rule live entirely inside `mos_refill` and change ONLY whether `offered_to_user_id` is set (i.e. whether an item is in C or B). The screen never re-derives eligibility; it renders by the partition.

BAND A — «مطلوب الآن» (required now / mandatory).
  Predicate over workflow_role_tasks: `status='open' AND assignee_user_id = :me`.
  Meaning: work handed to me (plan day ≤ today, OR handed early and kept as an issued commitment). Has a real `due_at = GREATEST(plan_due_at, mos_work_due_at(assigned_at, allowance))`. The workflow action is available (ابدئي الكتابة / اعتمد / …). Sub-order: late (due_at<now) first, then due_at asc.

BAND B — «متاح للبدء مبكرًا» (available to start early).
> ⚠ SUPERSEDED by 01-plan-v9.md — §4a — band predicates are column-only; refill never writes waiting_reason='offered' (also drop it from mos_planned_steps).
  Predicate over workflow_role_tasks: `status='open' AND assignee_user_id IS NULL AND offered_to_user_id = :me AND due_at IS NULL AND waiting_reason='offered'`.
  Meaning: THE ONE future planned day's executable batch, chosen once per refill by `mos_refill` ONLY when the person passed the idle test (no open non-blocked ASSIGNED task of that capacity key; open review tasks don't count) AND this is the earliest future day with ≥1 executable item. `mos_perf_late_sweep` ignores it (due_at NULL). Action available: START EARLY only (`task_start` → `mos_task_assign_apply`, sets assignee=me, due_at = GREATEST(plan_due_at, now+allowance) = plan_due_at). No countdown until started. This is the ONLY band with a start action.

BAND C — «قادم حسب الخطة» (upcoming, per the plan) — READ-ONLY.
  Two sources, unioned; C is exactly "my planned work that is neither A nor B":
  C1 (materialized, bound-unassigned): workflow_role_tasks `status='open' AND role_key=:my_role AND assignee_user_id IS NULL AND offered_to_user_id IS NULL`.
  C2 (reservation-only): mos_task_reservations `status='reserved' (consumed_task_id IS NULL) AND assignee_user_id=:me AND NOT EXISTS(open task for that subject/step/round)`, within a horizon (default 14 days, "show more" beyond).
  Each C row shows: planned day (scheduled_start / planned_start), planned deadline (plan_due_at, or computed via mos_plan_chain from planned_start), and a READINESS reason:
    - blocked=true → blocked_reason.
    - immediate predecessor step not yet approved → «بانتظار اعتماد <predecessor label>» (design → «بانتظار اعتماد الكتابة»; design_writer_review → «بانتظار التصميم»; design_review → «بانتظار مراجعة الكاتبة»).
    - executable (first step, or predecessor approved) but planned day > today → «محجوز ليوم <planned day>».
  No start / no claim action. A link to view the item only. Band C is ALWAYS visible regardless of how much open work the person holds or whether they are idle — that is precisely the "visible future planned work" the reviewer wants kept separate from "the batch available to start early."

WHY THIS RESOLVES ISSUE 6: the four tasks P-488..491 are Band C, unconditionally, today. They are visible (fixing D4/finding 9), read-only, carry planned day 27 Sep and their planned deadline, generate no countdown and no mandatory workload. They are NOT "offered" (Band B), because Band B is set only by refill under the idle+earliest-day gate, which مريم fails today (3 open assigned) and would still fail for 27 Sep even when idle (23 Sep is her earliest executable future day). "Visible" and "offered/startable" are now different states with different columns and different screen bands — the exact distinction the reviewer required.

CORRECTED MIGRATION STATE FOR P-488..491 (replaces plan v2's "→ offered"): at migration, set them to the Band C bound-unassigned state — clear `waiting_reason` ('capacity' no longer exists), leave `assignee_user_id` NULL and `offered_to_user_id` NULL and `due_at` NULL, stamp `plan_handoff_at`/`plan_due_at` from their reservation chain, keep scheduled_start=27 Sep. They render in «قادم حسب الخطة» with readiness «محجوز ليوم ٢٧ سبتمبر». (They are kept materialized rather than de-materialized because their reservations are already consumed and the one-open-task index tolerates a bound-unassigned open row; the task spec explicitly admits "bound-unassigned" into Band C. De-materializing — closing the tasks and un-consuming the reservations so C2 is the sole future source — is the cleaner long-term shape and is listed as an open question, but is more migration surgery and not required for correctness.)

BAND TRANSITIONS (event → move). Every move is a refill decision or a completion; nothing moves a row silently:
  - C2 (reservation-only), planned day arrives (≤ today) & executable → refill: mos_task_open + mos_task_assign_apply → A.
> ⚠ SUPERSEDED by 01-plan-v9.md — §4a — band predicates are column-only; refill never writes waiting_reason='offered' (also drop it from mos_planned_steps).
  - C (either source), person idle & this is the earliest future day with an executable item → refill: (materialize if needed) set offered_to=me, due_at NULL, waiting_reason='offered' → B. Chosen once per refill for the WHOLE executable batch of that one day.
  - B, person starts it (task_start) → assign_apply, due_at=plan_due_at → A.
  - B, not started, planned day arrives → next refill assigns it (now mandatory) → A (offered_to cleared).
  - B, not started, refill re-runs while still future & person still idle → stays B (idempotent; E2).
  - A completes → its successor's reservation may become executable → appears in C with a new readiness reason, or (if idle & earliest) is offered → B on the same refill.
  - blocked earliest-future day → its items stay in C (blocked reason); refill skips it for Band B and offers the next day that has an executable item (E4) — later executable reservation-only work is never hidden.

RECONCILE THE OLD «القادم إليك»: Band C «قادم حسب الخطة» SUPERSEDES the `upcoming` heuristic. «القادم إليك» was a workaround built because the reservation forecast was rendered nowhere; Band C renders that forecast authoritatively (planned day + deadline + readiness) and also covers reservation-only, not-yet-in-flight subjects the heuristic could never see. The `upcoming` computation (marketing-os.ts:5271-5313) and the MosUpcoming type are removed; the band label changes from «القادم إليك — ليست مهامًا بعد» to «قادم حسب الخطة».

SKELETON:
-- ============ SCHEMA (subset of plan v2 §6 step 1; the two load-bearing columns for Issue 6 are offered_to_user_id + plan_due_at) ============
ALTER TABLE public.workflow_role_tasks
  ADD COLUMN IF NOT EXISTS offered_to_user_id uuid,   -- set ONLY for Band B
  ADD COLUMN IF NOT EXISTS offered_at        timestamptz,
  ADD COLUMN IF NOT EXISTS plan_handoff_at   timestamptz,
  ADD COLUMN IF NOT EXISTS plan_due_at       timestamptz,  -- immutable planned deadline
  ADD COLUMN IF NOT EXISTS at_risk           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS risk_reason       text;

-- ============ MIGRATION FIX for P-488..491 (replaces plan v2 §6 step 4 "→ offered") ============
-- Band C bound-unassigned, NOT offered:
UPDATE public.workflow_role_tasks t
   SET waiting_reason = NULL, waiting_since = NULL,       -- 'capacity' state retired
       offered_to_user_id = NULL, offered_at = NULL,      -- NOT offered (مريم not idle; 27 Sep not earliest)
       assignee_user_id = NULL, due_at = NULL,
       plan_handoff_at = ch.handoff, plan_due_at = ch.due
  FROM mos_plan_chain(t.reservation_id) ch                -- §1 chain from the reservation's planned days
 WHERE t.status='open' AND t.assignee_user_id IS NULL
   AND t.subject_id IN ( /* P-488..491 */ );

-- ============ BAND C READ RPC (definer — reservations carry RLS with zero browser policies) ============
CREATE OR REPLACE FUNCTION public.mos_planned_steps(p_user_id uuid, p_horizon_days int DEFAULT 14)
RETURNS TABLE(
  source text,               -- 'task' | 'reservation'
  task_id uuid, reservation_id uuid,
  subject_table text, subject_id uuid, ref text, title text,
  step_key text, role_key text, round int,
  planned_day date, plan_handoff_at timestamptz, plan_due_at timestamptz,
  readiness text,            -- 'reserved_future' | 'awaiting_<predstep>' | 'blocked'
  readiness_label_ar text, readiness_label_en text,
  at_risk boolean, risk_reason text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- C1: materialized, bound-unassigned, NOT offered, my role
  SELECT 'task', t.id, t.reservation_id, t.subject_table, t.subject_id,
         c.ref, c.title, t.step_key, t.role_key, t.round,
         t.scheduled_start, t.plan_handoff_at, t.plan_due_at,
         mos_step_readiness(t.subject_table, t.subject_id, t.step_key, t.round, t.blocked),
         '', '',                               -- labels resolved in the API (bilingual)
         t.at_risk, t.risk_reason
    FROM workflow_role_tasks t
    LEFT JOIN mos_content c ON c.id = t.subject_id AND t.subject_table='mos_content'
   WHERE t.status='open' AND t.role_key = mos_user_role(p_user_id)
     AND t.assignee_user_id IS NULL AND t.offered_to_user_id IS NULL
  UNION ALL
  -- C2: reservation-only future steps for me, not yet a task
  SELECT 'reservation', NULL, r.id, COALESCE(...'mos_content'/'mos_content_rows'...), COALESCE(r.content_id,r.row_id),
         c.ref, c.title, r.step_key, r.role_key, 1,
         r.planned_start, ch.handoff, ch.due,
         mos_step_readiness(...same...),
         '', '', false, NULL
    FROM mos_task_reservations r
    LEFT JOIN mos_content c ON c.id = r.content_id
    CROSS JOIN LATERAL mos_plan_chain(r.id) ch
   WHERE r.status='reserved' AND r.consumed_task_id IS NULL
     AND r.assignee_user_id = p_user_id
     AND r.planned_start <= (current_date + p_horizon_days)
     AND NOT EXISTS (SELECT 1 FROM workflow_role_tasks x
                       WHERE x.status='open' AND x.step_key=r.step_key AND x.round=1
                         AND ((r.content_id IS NOT NULL AND x.subject_id=r.content_id)
                           OR (r.row_id     IS NOT NULL AND x.subject_id=r.row_id)))
  ORDER BY planned_day, ref, step_key;
$$;

// ============ api/marketing-os.ts — split the queue read into the partition ============
// readOpenQueueTasks(sb, sel) now returns THREE lists, not one:
//   band_a  : status='open' AND assignee_user_id = me            (Band A — the old `tasks`, minus the removed self-claim clause at line 1277)
//   band_b  : status='open' AND offered_to_user_id = me AND due_at IS NULL   (Band B)
//   band_c  : mos_planned_steps(me, 14)                          (Band C)
// The `and(assignee is null, waiting_since is null, role in ...)` self-claim clause (line 1277) is DELETED — refill decides, nobody claims.

// mapRoleTask MUST additionally expose (task spec part 3):
function mapRoleTask(t) {
  return { ...existing,
    scheduled_start: t.scheduled_start ?? null,   // booked_day
    plan_handoff_at: t.plan_handoff_at ?? null,
    plan_due_at:     t.plan_due_at ?? null,
    offered_to:      t.offered_to_user_id ?? null,
    offered_at:      t.offered_at ?? null,
    waiting_reason:  t.waiting_reason ?? null,
    blocked_reason:  t.blocked_reason ?? null,
    at_risk:         t.at_risk ?? false,
    risk_reason:     t.risk_reason ?? null,
    // band is DERIVED, never a stored ambiguous string:
    band: t.assignee_user_id ? 'mandatory'
        : (t.offered_to_user_id ? 'available_early' : 'planned'),
  };
}
// s02 payload gains two NEW lists and drops `upcoming`:
//   available_early: OfferedTask[]   (Band B)
//   planned:         PlannedStep[]   (Band C, from mos_planned_steps, with readiness/planned_day/plan_due_at)
// `tasks` = Band A only.  actions: work/complete on A; START EARLY on B; NONE on C.

// ============ src/pages/Marketing/WorkPage.tsx — bands ============
// const late  = bandA.filter(itemLate);
// const nowB  = bandA.filter(!itemLate);                    // «مطلوب الآن»
// render order:  Late → Manual → «مطلوب الآن» (A) → «متاح للبدء مبكرًا» (B, each with a Start-early button) → «قادم حسب الخطة» (C, read-only, planned day + readiness pill) → «بانتظار شخص آخر»
// «القادم إليك» band (lines 1211-1242 mobile, 1337-1371 desktop) is REPLACED by «قادم حسب الخطة» driven by `planned`.

TESTS:
- A1 — assigned work is Band A regardless of plan day: SETUP مريم has open writing tasks P-479/480/487 assigned (planned 27/28 Sep), due_at corrected to 27/28 Sep 24:00. | ACTION GET work_list (scope=mine) as مريم. | EXPECTED All three appear in `tasks`/band='mandatory' («مطلوب الآن»), with due_at=plan-corrected date; none appear in available_early or planned.
- B0 — P-488..491 are Band C at migration, not offered: SETUP Migration applied; مريم holds 3 open assigned writing tasks (not idle). | ACTION GET work_list as مريم. | EXPECTED P-488/489/490/491 appear in `planned` (Band C «قادم حسب الخطة») with planned_day=27 Sep, plan_due_at set, readiness «محجوز ليوم ٢٧ سبتمبر»; they carry assignee=NULL, offered_to=NULL, due_at=NULL; they appear in NEITHER `tasks` NOR `available_early`; no late_flag, no countdown.
> ⚠ SUPERSEDED by 01-plan-v9.md — §4a — band predicates are column-only; refill never writes waiting_reason='offered' (also drop it from mos_planned_steps).
- B1 — idle offers the earliest future day, not 27 Sep: SETUP مريم completes P-479/480/487; her earliest future executable writing day is 23 Sep (organic row reservation wt=3); P-488..491 are 27 Sep. | ACTION Completion triggers one mos_refill. | EXPECTED The 23 Sep organic row is materialized+offered (offered_to=مريم, due_at=NULL, waiting_reason='offered') → `available_early`; P-488..491 stay in `planned` (Band C), still unoffered; nothing from 24/26/27 Sep is offered.
- B2 — offered batch not started keeps its plan deadline: SETUP 23 Sep batch offered to مريم; she does not start it. | ACTION Next mos_refill runs while 23 Sep is still future and she is idle. | EXPECTED Batch stays in `available_early`, assignee NULL, due_at NULL, plan_due_at unchanged; no mos_late_events; no change to Band C.
- B3 — start early sets deadline to plan_due_at: SETUP 23 Sep batch offered to مريم. | ACTION مريم clicks Start early (task_start → mos_task_assign_apply). | EXPECTED Task moves to `tasks`/band='mandatory' with assignee=مريم, due_at = GREATEST(plan_due_at, now+24h) = plan_due_at (23 Sep chain), at_risk=false.
- C1 — Band C visible while person is fully loaded: SETUP سارة holds 8 open assigned design tasks (not idle). | ACTION GET work_list as سارة. | EXPECTED Her 8 design tasks are Band A; `available_early` is empty (not idle); her future design reservations (Sat/Sun/Mon each week within 14d) appear in `planned` (Band C) with readiness («بانتظار اعتماد الكتابة» where writing_review not yet approved, else «محجوز ليوم …»). Band C is shown despite zero spare capacity.
- C2 — readiness reflects predecessor approval: SETUP A paid creative is at writing_review (حسام); its design step is reserved for سارة on a future day, predecessor not approved. | ACTION GET work_list as سارة. | EXPECTED The design step is in `planned` with readiness «بانتظار اعتماد الكتابة»; it is NOT offered; when حسام approves and (سارة idle & earliest day) refill offers it, it moves to `available_early`.
- E4 — blocked earliest day does not hide later executable work: SETUP سارة idle; earliest future design day's only item is blocked (predecessor not approved); a later day has an executable design reservation. | ACTION mos_refill. | EXPECTED The blocked earlier item stays in `planned` with its reason; the later executable item's whole day-batch is offered → `available_early`.
- P — partition is exhaustive and disjoint: SETUP Any person, any live state. | ACTION For every open task in my role and every reserved future step for me, classify by (assignee=me → A) / (offered_to=me → B) / else C. | EXPECTED Every planned step for me lands in exactly one band; no step is both offered and assigned; no future planned step for me is invisible (closes finding 9 / D4).

TABLE P-488..491 (writing, planned 27 Sep) — band in each state (computed from live data 2026-09-22):
| state | Band A «مطلوب الآن»? | Band B «متاح للبدء مبكرًا»? | Band C «قادم حسب الخطة»? |
|---|---|---|---|
| TODAY (مريم holds 3 open assigned writing tasks → not idle) | No (assignee NULL) | No (idle test fails) | **Yes** — planned 27 Sep, plan_due_at set, readiness «محجوز ليوم ٢٧ سبتمبر», read-only, no countdown |
| AFTER مريم finishes her 3 assigned (now idle) | No | No — earliest executable future writing day is **23 Sep** (organic row reservation wt=3), so refill offers the 23 Sep batch, not the 27 Sep set | **Yes** — still Band C until 23/24/26 Sep are cleared, she is idle again, and 27 Sep is her earliest remaining executable day; then they move to Band B |
| Once 27 Sep is the earliest remaining executable day AND idle | No (until started) | **Yes** — offered as that day's whole executable batch (offered_to=مريم, due_at NULL) | No |
| 27 Sep arrives (day ≤ today) | **Yes** — refill assigns (mandatory that day) | No | No |

TABLE مريم's full band assignment TODAY under the new model (live open tasks + reservations, 14-day horizon):
| item | source | new band | planned day | readiness / due |
|---|---|---|---|---|
| P-487 writing | open task, assignee=مريم | A «مطلوب الآن» | 27 Sep | due→27 Sep 24:00 (plan-corrected) |
| P-479 writing | open task, assignee=مريم | A «مطلوب الآن» | 28 Sep | due→28 Sep 24:00 |
| P-480 writing | open task, assignee=مريم | A «مطلوب الآن» | 28 Sep | due→28 Sep 24:00 |
| (none) | — | B «متاح للبدء مبكرًا» | — | empty — مريم not idle |
| P-488 writing | open task, bound-unassigned | C «قادم حسب الخطة» | 27 Sep | «محجوز ليوم ٢٧ سبتمبر» |
| P-489 writing | open task, bound-unassigned | C | 27 Sep | «محجوز ليوم ٢٧ سبتمبر» |
| P-490 writing | open task, bound-unassigned | C | 27 Sep | «محجوز ليوم ٢٧ سبتمبر» |
| P-491 writing | open task, bound-unassigned | C | 27 Sep | «محجوز ليوم ٢٧ سبتمبر» |
| organic row (Thu 24 publish) | reservation, 23 Sep, wt3 | C | 23 Sep | «محجوز ليوم ٢٣ سبتمبر» (executable) |
| organic row | reservation, 24 Sep, wt3 | C | 24 Sep | «محجوز ليوم ٢٤ سبتمبر» |
| organic row | reservation, 26 Sep, wt3 | C | 26 Sep | «محجوز ليوم ٢٦ سبتمبر» |
| 6 × design_writer_review (launch) | reservations, repaired to 22 Sep | C | today (repair) → orig 21 Sep | «بانتظار اعتماد التصميم» (design in progress) |
| organic row | reservation, 28 Sep, wt3 | C | 28 Sep | «محجوز ليوم ٢٨ سبتمبر» |

Note: the two-source Band C (materialized bound-unassigned tasks + reservation-only rows) both flow through `mos_planned_steps`, so the screen renders one uniform «قادم حسب الخطة» list ordered by planned day.

> ⚠ SUPERSEDED by 01-plan-v9.md — §4a — band predicates are column-only; refill never writes waiting_reason='offered' (also drop it from mos_planned_steps).
IMPACTS: §4b (line 161) — DELETE the clause 'the 4 waiting P-488…491 (planned 27 Sep) become **offered**, no countdown.' Replace with: 'the 4 waiting P-488…491 become Band C «قادم حسب الخطة» — visible with planned day 27 Sep and plan_due_at, read-only, no countdown; not offered, because مريم is not idle and 27 Sep is not her earliest executable future day (23 Sep is).' Keep the rest of the sentence (idle → offer 23 Sep whole; 27 Sep exposed as an offer only when idle and earliest). | §6 migration step 4 (line 200) — change 'the 4 waiting P-488…491 → `offered`' to '→ Band C bound-unassigned (clear waiting_reason, assignee NULL, offered_to NULL, due_at NULL, stamp plan_handoff_at/plan_due_at)'. | §6 dry-run table (line 209) — change the 'after' cell from '**offered** (planned 27 Sep), visible, no countdown; mandatory on 27 Sep' to '**Band C «قادم حسب الخطة»** (planned 27 Sep), visible read-only, no countdown; offered only when مريم is idle and 27 Sep is her earliest executable day; mandatory on 27 Sep'. | §4a — clarify that `offered_to_user_id`/`waiting_reason='offered'` marks Band B ONLY; add a new CHOICE '4d — Visibility model' stating the three-band partition and that Band C is always visible while Band B is idle-gated. | §9 decision 2 (offered = unassigned + offered_to vs pre-assigned) — resolved in favor of unassigned+offered_to, because that column is exactly what separates Band B (offered) from Band C (planned) on screen and in RLS; keep it. | The old «القادم إليك» / `upcoming` heuristic (api/marketing-os.ts:5271-5313; MosUpcoming type in client.ts:329-338; WorkPage.tsx:1211-1242 and 1337-1371; upcomingHref) is superseded by Band C «قادم حسب الخطة» and should be removed; the `upcoming` field leaves the s02 payload and MosWorkQueue, replaced by `available_early` and `planned`. | API/types: readOpenQueueTasks returns three lists (Band A/B/C); mapRoleTask adds scheduled_start, plan_handoff_at, plan_due_at, offered_to, offered_at, blocked_reason, at_risk, risk_reason, derived `band`; MosSubjectTask (rowClient.ts:69-96) and MosWorkQueue (rowClient.ts:167-178) gain those fields plus the two new lists; a new PlannedStep type for Band C rows. | New definer RPC mos_planned_steps (and helpers mos_step_readiness, mos_plan_chain) — reservations carry RLS with zero browser policies (same reason readRowSummaries uses mos_row_summary), so Band C's reservation source must be a SECURITY DEFINER read, not a direct SELECT. | §7 verification scenarios 1 and E1–E5 — align terminology: scenario 1's 'next batch offered' = Band B; the 'plan_due_at intact' rows that are NOT offered belong in Band C; add the partition-exhaustiveness assertion (test P above) to live acceptance. | PRD docs/prd (marketing OS work/queue PRD) — must document the three bands, the offered_to marker, and that Band C is read-only; per CLAUDE.md every user-facing change updates the PRD, and this changes the primary work screen.
OPEN: Keep P-488..491 materialized as Band C bound-unassigned (C1), or de-materialize them (close the open tasks, un-consume the reservations) so Band C future work is uniformly reservation-sourced (C2)? De-materializing is the cleaner long-term shape (one future source, no bound-unassigned limbo) but is more migration surgery and interacts with the one-open-task index; keeping them materialized is the smaller change and is what this contract assumes. Operator/implementer to choose. | Band C horizon: default 14 days with 'show more'. Is 14 the right default, and should Band C group by planned day (recommended) with the readiness pill per row? | Should Band C surface reservations for a person's SECONDARY role-step too (e.g. مريم's design_writer_review reservations, حسام's reviews)? This contract includes them (any reserved future step where assignee_user_id=me). Confirm the operator wants reviews shown as upcoming-planned, not just first-step production work. | مريم's 3 assigned tasks are planned 27/28 Sep yet, once she finishes them, Band B would offer the 23-Sep-planned row — i.e. optional early work whose plan day is EARLIER than her already-assigned mandatory work. That is an artifact of the early hand-out; does the §2 correction re-date her assigned tasks, and should Band B's 'earliest future day' be relative to today or to her last mandatory day? (Out of Issue 6's core scope but affects the exact offer order.) | Exact readiness labels for each predecessor (design→«بانتظار اعتماد الكتابة», design_writer_review→«بانتظار التصميم», design_review→«بانتظار مراجعة الكاتبة») — confirm the bilingual wording.
PLAIN: The reviewer is right. Plan v2 gives the four already-created 27-September ad-writing tasks (P-488..491) three different fates in three different places: it says they become offers مريم can start now, it says they stay hidden until her earlier work is done, and it says she gets no offers at all while her three current tasks are open. The reason is one word doing two jobs: "offered" is used to mean both "she can see it" and "she can start it early." Those are not the same thing.\n\nThe fix is one rule with three shelves for each person: «مطلوب الآن» (work that's actually assigned to her, with a deadline), «متاح للبدء مبكرًا» (the one future day's batch the system offers her to start ahead of time — and only when she's free and that day is her next real day of work), and «قادم حسب الخطة» (everything else the plan has lined up for her — always visible, but read-only: it shows the planned day, the planned deadline, and why it isn't startable yet, e.g. "waiting for the writing to be approved" or "booked for 27 September"). Whether an item is on the middle shelf or the last one is decided by a single flag the system sets; the screen just draws the shelves.\n\nUnder this rule the four 27-September tasks sit on the last shelf today — visible to مريم (they're invisible today, which was the original complaint), with no deadline and no pressure. They never jump to the "start early" shelf on their own: even when مريم finishes her current work, the system would first offer her the 23 September batch (her genuinely-earliest ready day), and the 27 September set stays on the "coming up" shelf until it's actually next in line. This closes the contradiction and matches every rule the operator set. Plan v2's line that turns these four into "offered" at migration should be changed to "make them visible-but-not-startable"; the API and the work screen need a couple of new fields and two new lists to draw the three shelves. The old «القادم إليك» strip is replaced by the new «قادم حسب الخطة» shelf, which shows the real plan instead of a guess."