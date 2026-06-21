/**
 * Structured payloads for the Sales Assistant's non-matching cards — comparison,
 * next-best-action, message draft, and task proposal. Each arrives over the SSE
 * stream as its own event, is normalized leniently (never drops what the agent
 * produced), stored on the assistant message, and rendered as a card inside the
 * SAME chat. Deterministic fields (scores/bands/temperature) come from the tools.
 */

const asString = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asString).filter((s) => s.trim() !== '') : [];
const asNum = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

// ─── Comparison ──────────────────────────────────────────────────────────────

export interface ComparisonProject {
  project_id?: string;
  project_name: string;
  data_source: 'our_projects' | 'all_projects';
  requires_verification: boolean;
  score?: number;
  match_band?: 'strong' | 'good' | 'partial';
  specs: Record<string, string>;
  strengths: string[];
  weaknesses: string[];
}

export interface ComparisonPayload {
  title: string;
  customer_need: string;
  projects: ComparisonProject[];
  verdict: string;
  recommended_project_id?: string;
}

function normalizeSpecsMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = asString(val);
    if (s.trim() !== '') out[k] = s;
  }
  return out;
}

export function normalizeComparison(data: unknown): ComparisonPayload | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const projects = (Array.isArray(d.projects) ? d.projects : [])
    .map((p): ComparisonProject | null => {
      if (!p || typeof p !== 'object') return null;
      const o = p as Record<string, unknown>;
      const name = asString(o.project_name);
      if (!name) return null;
      const source = o.data_source === 'all_projects' ? 'all_projects' : 'our_projects';
      const band = o.match_band;
      return {
        project_id: asString(o.project_id) || undefined,
        project_name: name,
        data_source: source,
        requires_verification: o.requires_verification === true || source === 'all_projects',
        score: asNum(o.score),
        match_band: band === 'strong' || band === 'good' || band === 'partial' ? band : undefined,
        specs: normalizeSpecsMap(o.specs),
        strengths: asStringArray(o.strengths),
        weaknesses: asStringArray(o.weaknesses),
      };
    })
    .filter((p): p is ComparisonProject => p !== null);
  if (projects.length === 0) return null;
  return {
    title: asString(d.title),
    customer_need: asString(d.customer_need),
    projects,
    verdict: asString(d.verdict),
    recommended_project_id: asString(d.recommended_project_id) || undefined,
  };
}

// ─── Next best action (sales consultant) ─────────────────────────────────────

export type LeadTemperature = 'hot' | 'warm' | 'cold' | 'won' | 'lost';

export interface NextActionPayload {
  client_id?: string;
  client_name: string;
  lead_temperature: LeadTemperature;
  stage: string;
  status: string;
  risk: string;
  recommended_action: string;
  why: string;
  talking_points: string[];
  follow_up_timing: string;
  next_action_due_at?: string;
}

function asTemp(v: unknown): LeadTemperature {
  return v === 'hot' || v === 'warm' || v === 'cold' || v === 'won' || v === 'lost' ? v : 'warm';
}

export function normalizeNextAction(data: unknown): NextActionPayload | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const action = asString(d.recommended_action);
  if (!action) return null;
  return {
    client_id: asString(d.client_id) || undefined,
    client_name: asString(d.client_name),
    lead_temperature: asTemp(d.lead_temperature),
    stage: asString(d.stage),
    status: asString(d.status),
    risk: asString(d.risk),
    recommended_action: action,
    why: asString(d.why),
    talking_points: asStringArray(d.talking_points),
    follow_up_timing: asString(d.follow_up_timing),
    next_action_due_at: asString(d.next_action_due_at) || undefined,
  };
}

// ─── Message draft ───────────────────────────────────────────────────────────

export interface MessageDraftPayload {
  channel: 'whatsapp' | 'sms' | 'call_script';
  purpose: string;
  to_name: string;
  message: string;
  notes: string;
}

export function normalizeMessageDraft(data: unknown): MessageDraftPayload | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const message = asString(d.message);
  if (!message) return null;
  const ch = d.channel;
  return {
    channel: ch === 'sms' || ch === 'call_script' ? ch : 'whatsapp',
    purpose: asString(d.purpose),
    to_name: asString(d.to_name),
    message,
    notes: asString(d.notes),
  };
}

// ─── Task proposal (confirmation-gated) ──────────────────────────────────────

export type FollowupType =
  | 'appointment_booking_call'
  | 'appointment_confirmation_call'
  | 'follow_up_call_after_visit'
  | 'whatsapp_follow_up'
  | 'no_show_recovery_call'
  | 'rating_request';

const FOLLOWUP_TYPES: FollowupType[] = [
  'appointment_booking_call',
  'appointment_confirmation_call',
  'follow_up_call_after_visit',
  'whatsapp_follow_up',
  'no_show_recovery_call',
  'rating_request',
];

export interface TaskProposalPayload {
  client_id: string;
  client_name: string;
  followup_type: FollowupType;
  due_at: string;
  notes: string;
  suggested_message: string;
  project_id?: string;
  /** Set by the server when the client_id couldn't be validated — the card then
   *  shows "client not found" and the Confirm button is disabled. */
  unresolved?: boolean;
}

export function normalizeTaskProposal(data: unknown): TaskProposalPayload | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const clientId = asString(d.client_id);
  const unresolved = d.unresolved === true;
  // A resolved task needs a real client_id; an unresolved one is still shown
  // (disabled) so the salesperson knows the lead wasn't found.
  if (!clientId && !unresolved) return null;
  const ft = asString(d.followup_type) as FollowupType;
  return {
    client_id: clientId,
    client_name: asString(d.client_name),
    followup_type: FOLLOWUP_TYPES.includes(ft) ? ft : 'whatsapp_follow_up',
    due_at: asString(d.due_at),
    notes: asString(d.notes),
    suggested_message: asString(d.suggested_message),
    project_id: asString(d.project_id) || undefined,
    unresolved,
  };
}

export const FOLLOWUP_TYPE_LABELS: Record<FollowupType, { ar: string; en: string }> = {
  appointment_booking_call: { ar: 'اتصال لحجز موعد', en: 'Appointment booking call' },
  appointment_confirmation_call: { ar: 'اتصال تأكيد الموعد', en: 'Appointment confirmation call' },
  follow_up_call_after_visit: { ar: 'متابعة بعد الزيارة', en: 'Follow-up after visit' },
  whatsapp_follow_up: { ar: 'متابعة واتساب', en: 'WhatsApp follow-up' },
  no_show_recovery_call: { ar: 'اتصال بعد عدم الحضور', en: 'No-show recovery call' },
  rating_request: { ar: 'طلب تقييم الزيارة', en: 'Visit rating request' },
};

// ─── History serialization (so the model stays grounded on follow-ups) ───────

export function serializeCardForModel(
  kind: 'comparison' | 'next_action' | 'message' | 'task_proposal',
  payload: unknown,
): string {
  try {
    if (kind === 'comparison') {
      const p = payload as ComparisonPayload;
      const names = p.projects.map((x) => x.project_name).join(' vs ');
      return `[Comparison: ${names} — verdict: ${p.verdict}]`;
    }
    if (kind === 'next_action') {
      const p = payload as NextActionPayload;
      return `[Next action for ${p.client_name || 'lead'}: temp=${p.lead_temperature}, stage=${p.stage} → ${p.recommended_action} (${p.follow_up_timing})]`;
    }
    if (kind === 'message') {
      const p = payload as MessageDraftPayload;
      return `[${p.channel} draft: ${p.message}]`;
    }
    if (kind === 'task_proposal') {
      const p = payload as TaskProposalPayload;
      return `[Proposed task: ${p.followup_type} for ${p.client_name || p.client_id} due ${p.due_at} — awaiting the salesperson's confirmation]`;
    }
  } catch {
    /* fall through */
  }
  return '';
}
