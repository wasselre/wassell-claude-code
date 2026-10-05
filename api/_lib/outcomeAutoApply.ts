/**
 * The AI records a follow-up's result on its own (operator, 2026-10-04: "I
 * want AI to select the results without me needing to confirm").
 *
 * Input: `chat_outcome_suggestions` rows the chat outcome reader marked
 * `ready`. A reading is applied only when ALL hold:
 *   1. the switch `ai_automation_settings.auto_apply_outcomes` is on;
 *   2. confidence ≥ `outcome_auto_min_confidence` (80);
 *   3. the chat has been QUIET for `outcome_quiet_minutes` (15) since the newest
 *      message the reader saw — and no customer message arrived after it (a
 *      newer message means a newer reading is on its way);
 *   4. the follow-up is still open and of the type the reading was made for;
 *   5. the completion passes the SAME validation the rep's popup uses
 *      (validateFollowUpCompletion — e.g. not_interested needs a lost reason).
 * Anything that fails stays `ready` for a person, exactly as before.
 *
 * The write is the popup's own completion (CompleteWhatsAppFollowupModal
 * doComplete) done server-side through `record_save`: followups is enrolled in
 * the server workflow runner, so every completion workflow fires as if a rep had
 * pressed it. A positive result also sets the client's main project when the
 * client has none (client_option_set_main_ai). Each application is logged in
 * `client_ai_changes` (kind 'outcome').
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordSaveWithRetry } from './recordSaveRetry.js';
import { logAiChanges, type AutomationSettings } from './clientPrefs/autoSave.js';
import { validateFollowUpCompletion } from '../../src/lib/salesProcess/validators.js';
import { isAdOpenerTemplate } from './clientPrefs/keywordGate.js';

const POSITIVE = new Set(['interested', 'appointment_booked', 'request_offer']);
const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'skipped']);

interface SuggestionRow {
  id: string;
  client_id: string;
  chat_record_id: string | null;
  chat_wid: string;
  followup_id: string | null;
  followup_type: string | null;
  suggested_outcome: string | null;
  confidence: number | null;
  summary: string | null;
  suggested_fields: Record<string, unknown> | null;
  quoted_phrase: string | null;
  last_message_at: string | null;
  suggested_main_project_id: string | null;
  suggested_main_project_name: string | null;
}

export interface OutcomeApplyResult {
  suggestion: string;
  applied: boolean;
  outcome?: string | null;
  reason?: string;
  main?: string;
}

const readType = (v: unknown): string | null => (Array.isArray(v) ? (v.length ? String(v[0]) : null) : v ? String(v) : null);

/** PURE — the follow-up data the popup writes on completion (doComplete), from a reading. */
export function buildAutoCompletion(
  data: Record<string, unknown>,
  s: Pick<SuggestionRow, 'suggested_outcome' | 'suggested_fields' | 'chat_record_id'>,
  client: { stage: string | null; status: string | null },
  nowIso: string,
): Record<string, unknown> {
  return {
    ...data,
    ...(s.suggested_fields ?? {}),
    call_result: s.suggested_outcome,
    actual_datetime: nowIso,
    followup_status: 'completed',
    completed_by_user: null,
    completed_by_chat_id: s.chat_record_id,
    whatsapp_state: null,
    source_stage_snapshot: (data.source_stage_snapshot as string) ?? client.stage ?? null,
    source_status_snapshot: (data.source_status_snapshot as string) ?? client.status ?? null,
  };
}

/** Apply every eligible reading (at most `limit`). Never throws for one bad row — it is reported. */
export async function autoApplyOutcomes(
  sb: SupabaseClient,
  settings: AutomationSettings,
  opts: { limit?: number; dryRun?: boolean; deadline?: number } = {},
): Promise<OutcomeApplyResult[]> {
  if (!settings.auto_apply_outcomes) return [];
  const quietBefore = new Date(Date.now() - settings.outcome_quiet_minutes * 60_000).toISOString();
  const { data, error } = await sb.from('chat_outcome_suggestions')
    .select('id, client_id, chat_record_id, chat_wid, followup_id, followup_type, suggested_outcome, confidence, summary, suggested_fields, quoted_phrase, last_message_at, suggested_main_project_id, suggested_main_project_name')
    .eq('status', 'ready')
    .not('suggested_outcome', 'is', null)
    .not('followup_id', 'is', null)
    .gte('confidence', settings.outcome_auto_min_confidence)
    .lte('last_message_at', quietBefore)
    .order('last_message_at', { ascending: true })
    .limit(opts.limit ?? 20);
  if (error) throw new Error(`ready outcome readings read failed: ${error.message}`);

  const out: OutcomeApplyResult[] = [];
  for (const s of (data ?? []) as SuggestionRow[]) {
    if (opts.deadline && Date.now() > opts.deadline) { out.push({ suggestion: s.id, applied: false, reason: 'time budget' }); continue; }
    try {
      out.push(await applyOne(sb, s, !!opts.dryRun));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[outcome-auto] suggestion=${s.id} failed: ${msg}`);
      out.push({ suggestion: s.id, applied: false, reason: `error: ${msg}` });
    }
  }
  return out;
}

async function applyOne(sb: SupabaseClient, s: SuggestionRow, dryRun: boolean): Promise<OutcomeApplyResult> {
  const skip = (reason: string): OutcomeApplyResult => ({ suggestion: s.id, applied: false, outcome: s.suggested_outcome, reason });

  // A customer message after the reading ⇒ a newer reading is coming; wait for it.
  const { data: newer, error: nErr } = await sb.from('chat_messages').select('id')
    .eq('chat_wid', s.chat_wid).eq('flow', 'in').gt('date', s.last_message_at!).limit(1);
  if (nErr) throw new Error(`newer-message check failed: ${nErr.message}`);
  if ((newer ?? []).length) return skip('newer customer message');

  // A reading for a follow-up that is gone or already closed can never be
  // applied: retire it so it leaves the approvals tab instead of sitting there.
  const retire = async (reason: string): Promise<OutcomeApplyResult> => {
    if (!dryRun) {
      const { error } = await sb.from('chat_outcome_suggestions').update({ status: 'superseded' }).eq('id', s.id).eq('status', 'ready');
      if (error) console.error(`[outcome-auto] suggestion=${s.id} could not be retired: ${error.message}`);
    }
    return skip(`${reason} (retired)`);
  };
  const { data: fu, error: fErr } = await sb.from('records').select('id, data').eq('id', s.followup_id!).maybeSingle();
  if (fErr) throw new Error(`follow-up read failed: ${fErr.message}`);
  if (!fu) return retire('follow-up not found');
  const fdata = (fu.data ?? {}) as Record<string, unknown>;
  if (CLOSED_STATUSES.has(String(fdata.followup_status ?? ''))) return retire(`follow-up already ${String(fdata.followup_status)}`);
  const type = readType(fdata.followup_type) ?? s.followup_type ?? '';
  if (s.followup_type && type !== s.followup_type) return skip(`follow-up type changed (${s.followup_type} → ${type})`);
  // Call results are always set by a human (operator, 2026-10-05). The chat AI
  // only ever reads WhatsApp tasks now, but a call task must never be closed by
  // it even if one slipped through.
  if (type !== 'whatsapp_follow_up') return retire(`a ${type || 'call'} task — call results are set by a person`);

  const { data: cl, error: cErr } = await sb.from('records').select('data').eq('id', s.client_id).maybeSingle();
  if (cErr) throw new Error(`client read failed: ${cErr.message}`);
  const cdata = ((cl as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const client = { stage: (cdata.client_stage as string) ?? null, status: (cdata.client_status as string) ?? null };

  const nowIso = new Date().toISOString();
  const draft = buildAutoCompletion(fdata, s, client, nowIso);
  // clientData: «طلب غير مجاب» is held for a person unless the client's saved
  // preferences can be a request (unit type, district, budget).
  const check = validateFollowUpCompletion({ followupType: type, selectedOutcome: s.suggested_outcome!, draft, clientData: cl ? cdata : null });
  if (!check.ok) return skip(`validation: ${check.hardErrors.map((e) => e.message_en).join('; ')}`);
  if (dryRun) return { suggestion: s.id, applied: false, outcome: s.suggested_outcome, reason: 'dry run (would apply)' };

  // Complete it on the FRESH row; if a rep completed it meanwhile, do nothing.
  let wrote = false;
  await recordSaveWithRetry(sb, {
    recordId: s.followup_id!,
    build: (fresh) => {
      wrote = false;
      if (CLOSED_STATUSES.has(String(fresh.followup_status ?? ''))) return null;
      wrote = true;
      return buildAutoCompletion(fresh, s, client, nowIso);
    },
  });
  if (!wrote) return skip('completed by someone else meanwhile');

  const { error: uErr } = await sb.from('chat_outcome_suggestions').update({
    status: 'confirmed', confirmed_outcome: s.suggested_outcome, confirmed_fields: s.suggested_fields ?? {},
    confirmed_by: null, confirmed_at: nowIso, auto_applied: true,
  }).eq('id', s.id).eq('status', 'ready');
  if (uErr) console.error(`[outcome-auto] suggestion=${s.id} applied but not marked confirmed: ${uErr.message}`);

  let main: string | undefined;
  // The main project needs EVIDENCE in the customer's own words: a recorded
  // reaction (wants / asked) whose quote is not the ad's opener button — the
  // ad button alone made «أكنان 25» a main project in the dry run (2026-10-04).
  let mainEvidence = false;
  if (s.suggested_main_project_id && POSITIVE.has(s.suggested_outcome!)) {
    const { data: sig, error: gErr } = await sb.from('client_project_message_signals').select('level, quote')
      .eq('client_id', s.client_id).eq('project_id', s.suggested_main_project_id).in('level', ['wants', 'asked']);
    if (gErr) console.error(`[outcome-auto] suggestion=${s.id} main evidence read failed: ${gErr.message}`);
    mainEvidence = ((sig ?? []) as Array<{ quote: string | null }>).some((x) => !!x.quote && !isAdOpenerTemplate(x.quote));
  }
  if (s.suggested_main_project_id && POSITIVE.has(s.suggested_outcome!) && !mainEvidence) {
    main = 'skipped:no_customer_evidence';
  } else if (s.suggested_main_project_id && POSITIVE.has(s.suggested_outcome!)) {
    const { data: m, error: mErr } = await sb.rpc('client_option_set_main_ai', {
      p_client: s.client_id, p_project: s.suggested_main_project_id, p_source: 'ai_outcome',
    });
    if (mErr) console.error(`[outcome-auto] suggestion=${s.id} main project not set: ${mErr.message}`);
    else {
      main = String(m);
      // Only a main the AI actually set is recorded as approved (the column
      // allows approved / rejected); 'kept:has_main' leaves it unset.
      if (main === 'set_main') {
        const { error: dErr } = await sb.from('chat_outcome_suggestions').update({ main_project_decision: 'approved' }).eq('id', s.id);
        if (dErr) console.error(`[outcome-auto] suggestion=${s.id} main decision not recorded: ${dErr.message}`);
      }
    }
  }

  await logAiChanges(sb, [{
    client_id: s.client_id, kind: 'outcome', field: 'call_result', after_value: s.suggested_outcome,
    label: s.suggested_main_project_name && main === 'set_main' ? s.suggested_main_project_name : null,
    note: s.summary, quote: s.quoted_phrase, source: 'chat', source_ref: s.chat_wid, proposal_id: s.id,
  }]);
  console.log(`[outcome-auto] suggestion=${s.id} followup=${s.followup_id} → ${s.suggested_outcome} (${s.confidence}%)${main ? ` main=${main}` : ''}`);
  return { suggestion: s.id, applied: true, outcome: s.suggested_outcome, main };
}
