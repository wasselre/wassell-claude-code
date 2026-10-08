/**
 * GET / POST /api/cron/ai-sales-automation — the AI sales automation, every
 * five minutes (operator, 2026-10-04).
 *
 *   1. HIGH INTEREST from the interest score: `client_interest_detect_links(threshold)`
 *      records every (client, project) whose score in v_client_project_interest
 *      (links + appointment/visit + what the customer's messages say) is at or
 *      above the PORTAL threshold (15; registration). The officer is told only
 *      at 40 (step 3, v_interest_officer_due). High interest from the AI — a positive
 *      follow-up result with a chosen main project — is recorded by the outcome
 *      agent itself (chat_outcome_suggestion_ready).
 *   2. PORTAL (automatic — the only thing that acts on its own): each new
 *      interest event registers the client in the portal of that project's
 *      company, unless they are already registered with it
 *      (api/_lib/portalInterest.ts).
 *   3. OFFICER: each interest event gets ONE message to the project's officer
 *      (api/_lib/officerNoticeDraft.ts). An event the AI raised (not the score)
 *      must pass the interest rules first (api/_lib/officerInterestGate.ts):
 *      the client's own words about this project — wants to visit / buy, a deal
 *      question, or two detailed questions (never the client's preferences). With
 *      `officer_notice_auto_send` (2026-10-07) it is SENT without approval
 *      (api/_lib/officerNoticeSend.ts), inside 09:00–21:00 Riyadh; otherwise it
 *      waits in the Work Queue's AI tab.
 *   3c. OFFICER ON REGISTRATION (automatic, 2026-10-07): a client registered in
 *      a portal whose `notify_officer_on_register` box is ticked (Al Ramz) →
 *      the project's officer is told from the operations line, no approval
 *      (api/_lib/officerRegistrationNotice.ts). The one officer message that
 *      does not wait for the operator.
 *   3d. OFFICER QUESTION DEADLINES (2026-10-08): an officer question or visit
 *      check nobody answered by its deadline → one fixed reminder to the
 *      officer, then an alert to the rep; a visit still unconfirmed the day
 *      before → an alert to the rep (api/_lib/salesAgent/officerQuestions.ts).
 *   4. FOLLOW-UPS (SENT, no approval since 2026-10-07 — operator: «the agent
 *      is good now»): due WhatsApp follow-ups get a message written by the AI
 *      (api/_lib/salesAgent/followupDraft.ts), recorded in ai_actions and sent
 *      at once through api/_lib/salesAgent/followupSend.ts (paced 60–180 s;
 *      old-lead messages from 12:00 Riyadh). Switch:
 *      ai_automation_settings.followup_auto_send. Capped per day; one message
 *      per follow-up round.
 *   0. OLD-LEAD CAMPAIGN (2026-10-05): `sales_campaign_tick()` opens today's
 *      40 old leads after 08:00 Riyadh on a working day (one WhatsApp task
 *      each; their call tasks were planned at activation). Their messages are
 *      drafted in their OWN pass before step 4 — never limited by the daily
 *      cap, and drafted even though the lead has an open call (that is the plan).
 *
 * What sends a WhatsApp here: 3 (with officer_notice_auto_send), 3c, 3d, and 4
 * (with followup_auto_send). With a switch off, its drafts wait for a person
 * (/api/ai-actions).
 *
 * Budget: no follow-up draft STARTS after TIME_BUDGET_MS (one draft is one
 * model call, up to ~60 s). Auth: Bearer $CRON_SECRET or ?secret=.
 * `?dryRun=1` lists what would run, writes nothing. Always 200 once authorised;
 * every failure is ALSO console.error-ed.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { autoApplyOutcomes } from '../_lib/outcomeAutoApply.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { LEAD_PORTALS_MODEL_ID, type Rec } from '../_lib/leadPortals.js';
import { registerOnInterest, isTransientPortalFailure, RETRY_AFTER_MS } from '../_lib/portalInterest.js';
import { draftOfficerNotice, refreshPendingNotice } from '../_lib/officerNoticeDraft.js';
import { sendRegistrationNotices } from '../_lib/officerRegistrationNotice.js';
import { sendOfficerNotice } from '../_lib/officerNoticeSend.js';
import { sendFollowupAction } from '../_lib/salesAgent/followupSend.js';
import { resolveOperationsDeviceId } from '../_lib/whatsappGateway.js';
import { draftFollowupMessage } from '../_lib/salesAgent/followupDraft.js';
import { remindUnansweredHandoffs } from '../_lib/salesAgent/escalation.js';
import { remindOfficerQuestions } from '../_lib/salesAgent/officerQuestions.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

const SERVICE_NAME = 'api:cron-ai-sales-automation';
const TIME_BUDGET_MS = 200_000;
const EVENTS_PER_TICK = 20;
const DRAFTS_PER_TICK = 6;

interface Settings {
  /** The officer is told at this score (40). */
  interest_score_threshold: number;
  /** A portal registration starts at this score (15). */
  portal_score_threshold: number;
  portal_on_interest: boolean;
  officer_notice_drafts: boolean;
  /** Send an officer notice that passed the rules without approval (2026-10-07). */
  officer_notice_auto_send: boolean;
  followup_auto_send: boolean;
  followup_drafts: boolean;
  followup_drafts_per_day: number;
  officer_cooldown_days: number;
  auto_save_profile: boolean;
  auto_apply_outcomes: boolean;
  outcome_auto_min_confidence: number;
  outcome_quiet_minutes: number;
}

interface InterestRow {
  id: string;
  client_id: string;
  project_id: string;
  source: string;
  score: number | null;
  chat_wid: string | null;
  detected_at: string;
}

function nodeToWebRequest(nodeReq: IncomingMessage): Request {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  return new Request(url.toString(), { method: 'GET', headers });
}

function send(nodeRes: ServerResponse, status: number, body: unknown): void {
  nodeRes.statusCode = status;
  nodeRes.setHeader('content-type', 'application/json');
  nodeRes.end(JSON.stringify(body, null, 2));
}

/** Midnight in Riyadh (UTC+3, no DST), as an ISO instant. */
function riyadhDayStart(now: Date): string {
  const local = new Date(now.getTime() + 3 * 3600_000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - 3 * 3600_000).toISOString();
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const req = nodeToWebRequest(nodeReq);
  const expected = process.env.CRON_SECRET;
  if (!expected) return send(nodeRes, 500, { error: 'CRON_SECRET is not set; refusing to run' });
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  if ((bearer || url.searchParams.get('secret') || '') !== expected) return send(nodeRes, 401, { error: 'unauthorized' });
  const dryRun = ['1', 'true'].includes((url.searchParams.get('dryRun') ?? '0').toLowerCase());

  const svc = makeServiceClient(SERVICE_NAME);
  if (!svc) {
    console.error('[ai-sales-automation] server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
    return send(nodeRes, 200, { ok: false, error: 'server env missing' });
  }

  const report: Record<string, unknown> = { dry_run: dryRun };
  const errors: string[] = [];
  const fail = (where: string, err: unknown) => {
    const msg = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[ai-sales-automation] ${msg}`);
    errors.push(msg);
  };

  try {
    const { data: sRow, error: sErr } = await svc.from('ai_automation_settings').select('*').eq('id', 1).maybeSingle();
    if (sErr) throw new Error(`settings read failed: ${sErr.message}`);
    if (!sRow) throw new Error('ai_automation_settings row 1 is missing');
    const settings = sRow as Settings;
    report.settings = settings;

    // ── 0. Old-lead campaign: open today's leads ─────────────────────────────
    if (!dryRun) {
      const { data: tick, error: tickErr } = await svc.rpc('sales_campaign_tick');
      if (tickErr) fail('sales_campaign_tick', tickErr);
      else report.campaign_tick = tick;
      // The day's "review the AI agent's WhatsApp work" list (once per working day).
      const { data: review, error: revErr } = await svc.rpc('ai_review_tick');
      if (revErr) fail('ai_review_tick', revErr);
      else report.review_tick = review;
    }

    // ── 1. High interest from the links ──────────────────────────────────────
    if (dryRun) {
      const { data: hot, error: hErr } = await svc.from('v_client_project_interest').select('client_id, project_id, score')
        .gte('score', settings.portal_score_threshold);
      if (hErr) fail('interest score (dry run)', hErr);
      else report.interest_pairs = (hot ?? []).length;
    } else {
      const { data: n, error: dErr } = await svc.rpc('client_interest_detect_links', { p_threshold: settings.portal_score_threshold });
      if (dErr) fail('client_interest_detect_links', dErr);
      else report.new_link_interest = n;
    }

    // ── 2. Portal registration (automatic) ───────────────────────────────────
    const portalOut: unknown[] = [];
    if (settings.portal_on_interest) {
      const { data: portalRows, error: pErr } = await svc.from('unified_records').select('id, data').eq('model_id', LEAD_PORTALS_MODEL_ID);
      if (pErr) throw new Error(`portals load failed: ${pErr.message}`);
      const autoPortals = ((portalRows ?? []) as Rec[]).filter((p) => p.data?.auto_register === true && p.data?.is_active !== false);
      const { data: todo, error: tErr } = await svc.from('client_project_interest')
        .select('id, client_id, project_id, source, score, chat_wid, detected_at')
        .is('portal_done_at', null).order('detected_at', { ascending: true }).limit(EVENTS_PER_TICK);
      if (tErr) throw new Error(`interest events read failed: ${tErr.message}`);
      for (const ev of (todo ?? []) as InterestRow[]) {
        if (dryRun) { portalOut.push({ interest: ev.id, would: 'register' }); continue; }
        try {
          const r = autoPortals.length === 0
            ? { status: 'no_portal' as const, portals: [] }
            : await registerOnInterest(svc, { interestId: ev.id, clientId: ev.client_id, projectId: ev.project_id, autoPortalRows: autoPortals });
          const { error: uErr } = await svc.from('client_project_interest')
            .update({ portal_done_at: new Date().toISOString(), portal_result: r }).eq('id', ev.id);
          if (uErr) throw new Error(`marking portal step done failed: ${uErr.message}`);
          portalOut.push({ interest: ev.id, ...r });
        } catch (err) {
          // Left undone on purpose: the next tick retries this event.
          fail(`portal step interest=${ev.id}`, err);
        }
      }

      // 2b. Retry an interest registration the PORTAL broke (a timeout, a
      // dropped browser session) — ≥ 20 min later, ≤ 3 attempts per client ×
      // portal (registerOnInterest → interestRetry decides). Only the pair's
      // LATEST job counts, so a pair already retried or registered is left alone.
      const { data: failedJobs, error: fErr } = await svc.from('portal_registration_jobs')
        .select('id, interest_id, client_record_id, portal_record_id, error_message, finished_at, created_at, phase')
        .eq('origin', 'auto').eq('status', 'failed').not('interest_id', 'is', null)
        .gte('finished_at', new Date(Date.now() - 3 * 86_400_000).toISOString())
        .lte('finished_at', new Date(Date.now() - RETRY_AFTER_MS).toISOString())
        .order('finished_at', { ascending: true }).limit(50);
      if (fErr) throw new Error(`failed portal jobs read failed: ${fErr.message}`);
      const retryable = ((failedJobs ?? []) as Array<{ id: string; interest_id: string; client_record_id: string; portal_record_id: string; error_message: string | null; created_at: string; phase: string | null }>)
        .filter((j) => isTransientPortalFailure(j.error_message, j.phase));
      if (retryable.length) {
        const { data: later, error: lErr } = await svc.from('portal_registration_jobs')
          .select('client_record_id, portal_record_id, created_at')
          .in('client_record_id', [...new Set(retryable.map((j) => j.client_record_id))]);
        if (lErr) throw new Error(`portal job history read failed: ${lErr.message}`);
        const newest = new Map<string, string>();
        for (const r of (later ?? []) as Array<{ client_record_id: string; portal_record_id: string; created_at: string }>) {
          const k = `${r.client_record_id}|${r.portal_record_id}`;
          if (!newest.has(k) || newest.get(k)! < r.created_at) newest.set(k, r.created_at);
        }
        const done = new Set<string>();
        for (const j of retryable) {
          if (newest.get(`${j.client_record_id}|${j.portal_record_id}`) !== j.created_at || done.has(j.interest_id)) continue;
          done.add(j.interest_id);
          const { data: ev, error: eErr } = await svc.from('client_project_interest')
            .select('id, client_id, project_id').eq('id', j.interest_id).maybeSingle();
          if (eErr) { fail(`portal retry interest=${j.interest_id}`, eErr); continue; }
          if (!ev) continue;
          if (dryRun) { portalOut.push({ interest: j.interest_id, would: 'retry registration' }); continue; }
          try {
            const e = ev as { id: string; client_id: string; project_id: string };
            const r = await registerOnInterest(svc, { interestId: e.id, clientId: e.client_id, projectId: e.project_id, autoPortalRows: autoPortals });
            const { error: uErr } = await svc.from('client_project_interest')
              .update({ portal_result: { ...r, retried_at: new Date().toISOString(), retry_of: j.id } }).eq('id', e.id);
            if (uErr) throw new Error(`recording the retry failed: ${uErr.message}`);
            portalOut.push({ interest: e.id, retry_of: j.id, ...r });
          } catch (err) {
            fail(`portal retry interest=${j.interest_id}`, err);
          }
        }
      }
    }
    report.portal = portalOut;

    // ── 3. Officer notice drafts (await approval) ────────────────────────────
    const officerOut: unknown[] = [];
    if (settings.officer_notice_drafts) {
      // Only events whose CURRENT score reached the officer threshold (40), or
      // the AI's follow-up reading (interested / booked / offer). A 15+ event
      // was registered in the portal; it waits here until its score reaches 40.
      const { data: todo, error: tErr } = await svc.from('v_interest_officer_due')
        .select('id, client_id, project_id, source, score, chat_wid, detected_at')
        .order('detected_at', { ascending: true }).limit(EVENTS_PER_TICK);
      if (tErr) throw new Error(`officer-due events read failed: ${tErr.message}`);
      for (const ev of (todo ?? []) as InterestRow[]) {
        if (dryRun) { officerOut.push({ interest: ev.id, would: 'draft officer notice' }); continue; }
        try {
          const r = await draftOfficerNotice(svc, {
            interestId: ev.id, clientId: ev.client_id, projectId: ev.project_id, chatWid: ev.chat_wid,
            detectedAt: ev.detected_at, cooldownDays: settings.officer_cooldown_days, source: ev.source, score: ev.score,
          });
          if (r.status !== 'wait_portal') {
            const { error: uErr } = await svc.from('client_project_interest')
              .update({ officer_done_at: new Date().toISOString(), officer_result: r }).eq('id', ev.id);
            if (uErr) throw new Error(`marking officer step done failed: ${uErr.message}`);
          }
          let sent: unknown = null;
          if (r.status === 'drafted' && settings.officer_notice_auto_send) {
            sent = await sendOfficerNotice(svc, r.action_id, resolveOperationsDeviceId);
          }
          officerOut.push({ interest: ev.id, ...r, ...(sent ? { sent } : {}) });
        } catch (err) {
          fail(`officer step interest=${ev.id}`, err);
          // A failed judgement or send is closed, not retried every 5 minutes
          // (each retry is a paid model call). Nothing was sent; the error is
          // on the event for the record.
          const { error: eErr } = await svc.from('client_project_interest')
            .update({ officer_done_at: new Date().toISOString(), officer_result: { status: 'error', error: err instanceof Error ? err.message : String(err) } })
            .eq('id', ev.id).is('officer_done_at', null);
          if (eErr) fail(`recording the officer step error interest=${ev.id}`, eErr);
        }
      }
    }
    report.officer = officerOut;

    // ── 3c. A hand-off nobody answered in 3 hours → remind the rep once.
    if (!dryRun) {
      try {
        report.handoff_reminders = await remindUnansweredHandoffs(svc);
      } catch (err) { fail('hand-off reminders', err); }
    }

    // ── 3d. Officer questions / visit checks past their deadline: one fixed
    // reminder to the officer, then the rep is alerted; a visit still
    // unconfirmed the day before → the rep is alerted (officerQuestions.ts).
    if (!dryRun) {
      try {
        const r = await remindOfficerQuestions(svc, resolveOperationsDeviceId);
        report.officer_question_deadlines = r;
        for (const e of r.errors) fail('officer question deadline', new Error(e));
      } catch (err) { fail('officer question deadlines', err); }
    }

    // ── 3a. Waiting officer drafts follow the facts (a visit booked after the
    // draft, new link activity). Only drafts nobody edited; unchanged = no write.
    if (!dryRun) {
      const { data: waiting, error: wErr } = await svc.from('ai_actions').select('id').eq('kind', 'officer_notice').eq('status', 'pending').limit(50);
      if (wErr) fail('pending officer notices read', wErr);
      let refreshed = 0;
      for (const w of (waiting ?? []) as { id: string }[]) {
        try {
          if (await refreshPendingNotice(svc, w.id)) refreshed += 1;
        } catch (err) {
          fail(`officer notice refresh ${w.id}`, err);
        }
      }
      report.officer_refreshed = refreshed;
    }

    // ── 3c. Registered in a portal → the officer is told (automatic) ─────────
    try {
      report.officer_on_registration = await sendRegistrationNotices(svc, { dryRun, operationsDeviceId: resolveOperationsDeviceId });
    } catch (err) {
      fail('officer notice on registration', err);
    }

    // ── 3b. Follow-up results the AI records itself (no rep confirm) ─────────
    // Before the drafts: a follow-up that just got its result must not also
    // get a follow-up message drafted.
    try {
      report.auto_outcomes = await autoApplyOutcomes(svc, settings, { dryRun, deadline: startedAt + TIME_BUDGET_MS });
    } catch (err) {
      fail('auto-apply outcomes', err);
    }

    // ── 4. Follow-up messages (sent without approval) ────────────────────────
    const { data: expired, error: xErr } = dryRun ? { data: null, error: null } : await svc.rpc('ai_actions_expire');
    if (xErr) fail('ai_actions_expire', xErr);
    else if (!dryRun) report.expired_drafts = expired;

    // 4a. Drafts still waiting (written while approval was on) go out now.
    // The send re-checks each one is still right to send, so a stale one is
    // closed, not sent.
    if (!dryRun && settings.followup_auto_send) {
      const { data: waiting, error: wErr } = await svc.from('ai_actions').select('id')
        .eq('kind', 'followup_message').eq('status', 'pending').order('created_at', { ascending: true }).limit(40);
      if (wErr) fail('pending follow-up drafts read', wErr);
      const swept: unknown[] = [];
      for (const w of (waiting ?? []) as { id: string }[]) {
        try { swept.push({ action: w.id, ...(await sendFollowupAction(svc, w.id, { decidedBy: null, auto: true })) }); }
        catch (err) { fail(`follow-up send action=${w.id}`, err); }
      }
      report.followup_pending_sent = swept;
    }

    const draftOut: unknown[] = [];
    if (settings.followup_drafts) {
      const { data: ai, error: aiErr } = await svc.from('whatsapp_ai_settings').select('agent_model, agent_effort').limit(1).maybeSingle();
      if (aiErr) throw new Error(`whatsapp_ai_settings read failed: ${aiErr.message}`);
      const model = ((ai as { agent_model?: string | null } | null)?.agent_model) || 'claude-opus-5-5';
      const effortRaw = (ai as { agent_effort?: string | null } | null)?.agent_effort;
      const effort = effortRaw === 'medium' || effortRaw === 'high' ? effortRaw : 'low';

      // Old-lead messages first, then ordinary follow-ups within the daily cap.
      // The cap counts ordinary drafts only — the campaign's 40 a day are planned.
      const { count, error: cErr } = await svc.from('ai_actions').select('id', { count: 'exact', head: true })
        .eq('kind', 'followup_message').is('context->>campaign', null).gte('created_at', riyadhDayStart(new Date()));
      if (cErr) throw new Error(`daily draft count failed: ${cErr.message}`);
      const room = Math.max(0, settings.followup_drafts_per_day - (count ?? 0));
      report.drafts_today = count ?? 0;

      const passes: Array<{ campaign: boolean; limit: number }> = [
        { campaign: true, limit: DRAFTS_PER_TICK },
        { campaign: false, limit: Math.min(room, DRAFTS_PER_TICK) },
      ];
      for (const pass of passes) {
        if (pass.limit <= 0) continue;
        const { data: cands, error: kErr } = await svc.rpc('ai_followup_candidates', { p_limit: pass.limit, p_campaign: pass.campaign });
        if (kErr) throw new Error(`ai_followup_candidates failed: ${kErr.message}`);
        const candidates = (cands ?? []) as { followup_id: string; client_id: string; chat_wid: string; chat_record_id: string; attempt: number; due_at: string; campaign: string | null }[];

        for (const c of candidates) {
          if (Date.now() - startedAt > TIME_BUDGET_MS) { draftOut.push({ followup: c.followup_id, deferred: 'time budget' }); continue; }
          if (dryRun) { draftOut.push({ followup: c.followup_id, client: c.client_id, attempt: c.attempt, campaign: c.campaign, would: 'draft' }); continue; }
          const round = String(c.attempt);
          const base = {
            kind: 'followup_message', client_id: c.client_id, chat_wid: c.chat_wid, followup_id: c.followup_id, round_key: round,
            phone: `+${c.chat_wid.split('@')[0]}`,
          };
          try {
            const campaign = c.campaign === 'morning' || c.campaign === 'no_answer' ? c.campaign : null;
            const d = await draftFollowupMessage(svc, { followupId: c.followup_id, clientId: c.client_id, chatWid: c.chat_wid, attempt: c.attempt, model, effort, campaign });
            const context = {
              brief: d.brief, warnings: d.warnings, lang: d.lang, model: d.model, chat_record_id: c.chat_record_id, due_at: c.due_at,
              reason: d.reason, client_said: d.clientSaid, reading: d.reading, focus: d.focus,
              ...(campaign ? { campaign } : {}),
            };
            const row = d.body
              ? { ...base, body: d.body, original_body: d.body, reference: `ai:followup:${c.followup_id}:${round}`, context }
              // The AI judged no message should go (e.g. the client said stop):
              // recorded as expired so it is visible and never redrafted.
              : { ...base, status: 'expired', body: '', original_body: '', error: `AI skipped: ${d.skipReason ?? 'no reason'}`, context };
            const { data: ins, error: iErr } = await svc.from('ai_actions').insert(row).select('id').maybeSingle();
            if (iErr && iErr.code !== '23505') throw new Error(`draft insert failed: ${iErr.message}`);
            const newId = (ins as { id?: string } | null)?.id ?? null;
            // Sent at once — a separate try, so a send failure never records a
            // second (failed) draft for a round that already has one.
            let sent: unknown = null;
            if (d.body && newId && settings.followup_auto_send) {
              try { sent = await sendFollowupAction(svc, newId, { decidedBy: null, auto: true }); }
              catch (err) { fail(`follow-up send action=${newId}`, err); sent = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
            }
            draftOut.push({ followup: c.followup_id, campaign, drafted: !!d.body, warnings: d.warnings.length, skip: d.skipReason, ...(sent ? { sent } : {}) });
          } catch (err) {
            fail(`follow-up draft followup=${c.followup_id}`, err);
            // One failed round is recorded so a broken chat is not re-billed every tick.
            const { error: iErr } = await svc.from('ai_actions').insert({
              ...base, status: 'failed', body: '', original_body: '',
              error: `draft failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
              context: { chat_record_id: c.chat_record_id, ...(c.campaign ? { campaign: c.campaign } : {}) },
            });
            if (iErr && iErr.code !== '23505') fail(`recording the failed draft followup=${c.followup_id}`, iErr);
          }
        }
      }
    }
    report.followup_drafts = draftOut;
  } catch (err) {
    fail('run', err);
  }

  return send(nodeRes, 200, { ok: errors.length === 0, ms: Date.now() - startedAt, errors, ...report });
}
