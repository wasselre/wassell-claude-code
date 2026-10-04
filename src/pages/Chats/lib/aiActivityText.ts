import type { TFunction } from 'i18next';
import { getOutcome } from '@/lib/salesProcess';
import { money, num } from '@/pages/Marketing/lib/format';
import type { AgentRunReading, AgentRunSearch, AiActivity } from './aiActivity';

/**
 * Plain-language lines for the AI activity (shared by the chat's AI cards and
 * the client's AI timeline). Every string goes through i18n; only DATA values
 * (project names, the customer's own words, unit-type values) pass through.
 */

const ZONES = new Set(['north', 'south', 'east', 'west', 'center']);

/** What the customer wants, as short chips. */
export function readingChips(r: AgentRunReading | null | undefined, t: TFunction, isAr: boolean): string[] {
  if (!r) return [];
  const out: string[] = [];
  if (r.unit_types?.length) out.push(r.unit_types.join(' / '));
  if (r.bedrooms_min != null) out.push(t('chats.ai_act.c_bedrooms', { n: num(r.bedrooms_min, isAr) }));
  if (r.budget_max != null) out.push(t('chats.ai_act.c_budget', { v: money(r.budget_max, isAr) }));
  if (r.area_min != null) out.push(t('chats.ai_act.c_area', { n: num(r.area_min, isAr) }));
  for (const p of r.purpose ?? []) out.push(t(`chats.ai_act.purpose_${p === 'investment' ? 'investment' : 'residential'}`));
  if (r.amenities?.length) out.push(r.amenities.join('، '));
  return out;
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A search's criteria, as short chips. */
export function criteriaChips(s: AgentRunSearch, t: TFunction, isAr: boolean): string[] {
  const c = s.criteria ?? {};
  const out: string[] = [];
  const types = strArr(c.unit_types);
  if (types.length) out.push(types.join(' / '));
  if (typeof c.zone === 'string' && ZONES.has(c.zone)) out.push(t(`chats.ai_act.zone_${c.zone}`));
  const districts = strArr(c.districts);
  if (districts.length) out.push(districts.join('، '));
  if (s.area_understood?.length) {
    const wanted = s.area_understood.filter((a) => a.wanted).map((a) => a.place);
    const not = s.area_understood.filter((a) => !a.wanted).map((a) => a.place);
    if (wanted.length) out.push(wanted.join('، '));
    if (not.length) out.push(t('chats.ai_act.c_not', { places: not.join('، ') }));
  }
  const beds = numOrNull(c.bedrooms_min);
  if (beds != null) out.push(t('chats.ai_act.c_bedrooms', { n: num(beds, isAr) }));
  const budget = numOrNull(c.budget_max);
  if (budget != null) out.push(t('chats.ai_act.c_budget', { v: money(budget, isAr) }));
  const area = numOrNull(c.area_min);
  if (area != null) out.push(t('chats.ai_act.c_area', { n: num(area, isAr) }));
  if (c.readiness === 'ready' || c.readiness === 'off_plan') out.push(t(`chats.ai_act.ready_${c.readiness}`));
  const feats = strArr(c.features);
  if (feats.length) out.push(feats.join('، '));
  if (Array.isArray(c.near)) {
    for (const n of c.near as Array<Record<string, unknown>>) {
      const what = typeof n.place === 'string' ? n.place : typeof n.category === 'string' ? t(`chats.ai_act.near_cat_${n.category}`, { defaultValue: n.category }) : '';
      const km = numOrNull(n.max_km);
      if (what) out.push(t('chats.ai_act.c_near', { what, km: km != null ? num(km, isAr) : '—' }));
    }
  }
  if (!out.length) out.push(t('chats.ai_act.c_everything'));
  return out;
}

export function relaxedLabel(relaxed: string | null, t: TFunction): string | null {
  return relaxed ? t(`chats.ai_act.relaxed_${relaxed}`, { defaultValue: relaxed }) : null;
}

export type AiEventKind =
  | 'customer' | 'ai_reply' | 'rep' | 'search' | 'sent' | 'booked' | 'handoff' | 'asked'
  | 'change' | 'kept' | 'outcome' | 'portal' | 'officer' | 'followup_msg' | 'booking';

export interface AiEvent {
  id: string;
  at: string;
  kind: AiEventKind;
  text: string;
  /** Secondary line (a quote, a status, an error). */
  detail?: string | null;
  tone?: 'ok' | 'warn' | 'bad' | 'muted';
}

const AI_ACTION_STATUS_TONE: Record<string, AiEvent['tone']> = { sent: 'ok', pending: 'warn', expired: 'muted', rejected: 'muted', failed: 'bad' };

/**
 * Everything the AI did, newest first. `withMessages` adds the conversation
 * (customer / AI / rep messages) for the client timeline; `withReplies` adds
 * the AI's own replies from the run log when messages are not included.
 */
export function buildAiEvents(
  d: AiActivity,
  t: TFunction,
  isAr: boolean,
  fieldLabel: (slug: string) => string,
  formatValue: (slug: string, v: unknown) => string,
  opts: { withMessages: boolean },
): AiEvent[] {
  const ev: AiEvent[] = [];
  const name = (id: string | null | undefined) => (id && d.names[id]) || t('chats.ai_act.unknown_project');

  if (opts.withMessages) {
    for (const [i, m] of d.messages.entries()) {
      if (!m.text) continue;
      ev.push({ id: `m${i}`, at: m.date, kind: m.by === 'customer' ? 'customer' : m.by === 'ai' ? 'ai_reply' : 'rep', text: m.text });
    }
  }

  for (const r of d.runs) {
    for (const [i, s] of r.searches.entries()) {
      ev.push({
        id: `${r.id}s${i}`, at: r.created_at, kind: 'search',
        text: t('chats.ai_act.ev_search', { n: num(s.total, isAr) }),
        detail: [criteriaChips(s, t, isAr).join(' · '), relaxedLabel(s.relaxed, t)].filter(Boolean).join(' — '),
        tone: s.total === 0 ? 'warn' : undefined,
      });
    }
    const a = r.actions ?? {};
    if (a.sent_project) ev.push({ id: `${r.id}p`, at: r.created_at, kind: 'sent', text: t('chats.ai_act.ev_sent_project', { name: a.sent_project.name }), tone: 'ok' });
    if (a.sent_units) ev.push({ id: `${r.id}u`, at: r.created_at, kind: 'sent', text: t('chats.ai_act.ev_sent_units', { n: num(a.sent_units.count, isAr), name: a.sent_units.name }), tone: 'ok' });
    if (a.booked) ev.push({ id: `${r.id}b`, at: r.created_at, kind: 'booked', text: t('chats.ai_act.ev_booked', { name: name(a.booked.projectId), day: a.booked.day }), tone: 'ok' });
    if (a.handoff) ev.push({ id: `${r.id}h`, at: r.created_at, kind: 'handoff', text: t('chats.ai_act.ev_handoff'), detail: a.handoff.note ?? a.handoff.reason, tone: 'warn' });
    if (!opts.withMessages && r.reply) {
      ev.push({ id: `${r.id}r`, at: r.created_at, kind: 'ai_reply', text: r.reply, tone: r.reply_sent === false ? 'bad' : undefined });
    }
  }

  for (const q of d.questions) {
    ev.push({ id: `q${q.id}`, at: q.created_at, kind: 'asked', text: t('chats.ai_act.ev_asked', { q: q.question }), detail: q.answer ? t('chats.ai_act.ev_answer', { a: q.answer }) : t(`chats.ai_act.q_${q.status}`, { defaultValue: q.status }), tone: q.answer ? 'ok' : 'warn' });
  }

  for (const c of d.changes) {
    if (c.kind === 'outcome') {
      const o = typeof c.after_value === 'string' ? getOutcome(c.after_value) : undefined;
      ev.push({ id: `c${c.id}`, at: c.created_at, kind: 'outcome', text: t('chats.ai_changes.outcome', { label: o ? (isAr ? o.label_ar : o.label_en) : String(c.after_value ?? '') }), detail: c.quote, tone: c.undone_at ? 'muted' : 'ok' });
    } else if (c.kind === 'place') {
      ev.push({ id: `c${c.id}`, at: c.created_at, kind: c.applied ? 'change' : 'kept', text: c.applied ? t('chats.ai_changes.place', { label: c.label ?? '' }) : t('chats.ai_changes.doubted', { label: c.label ?? '' }), detail: c.quote, tone: c.undone_at ? 'muted' : c.applied ? 'ok' : 'warn' });
    } else if (c.field) {
      ev.push({
        id: `c${c.id}`, at: c.created_at, kind: c.applied ? 'change' : 'kept',
        text: c.applied
          ? `${fieldLabel(c.field)}: ${formatValue(c.field, c.after_value)}`
          : t('chats.ai_changes.kept', { field: fieldLabel(c.field), heard: formatValue(c.field, c.after_value), current: formatValue(c.field, c.before_value) }),
        detail: c.quote, tone: c.undone_at ? 'muted' : c.applied ? 'ok' : 'warn',
      });
    }
  }

  for (const j of d.portal.jobs) {
    if (j.kind && j.kind !== 'register') continue;
    ev.push({
      id: `pj${j.id}`, at: j.created_at, kind: 'portal',
      text: t('chats.ai_act.ev_portal', { portal: name(j.portal_record_id), project: j.project_record_id ? name(j.project_record_id) : '' }),
      detail: [t(`chats.ai_act.portal_${j.status}`, { defaultValue: j.status }), j.error_message].filter(Boolean).join(' — '),
      tone: j.status === 'done' || j.status === 'already_registered' ? 'ok' : j.status === 'failed' ? 'bad' : 'warn',
    });
  }

  for (const a of d.actions) {
    ev.push({
      id: `aa${a.id}`, at: a.created_at, kind: a.kind === 'officer_notice' ? 'officer' : 'followup_msg',
      text: t(a.kind === 'officer_notice' ? 'chats.ai_act.ev_officer' : 'chats.ai_act.ev_followup_msg', { name: a.project_id ? name(a.project_id) : '' }),
      detail: [t(`chats.ai_act.action_${a.status}`, { defaultValue: a.status }), a.body].filter(Boolean).join(' — '),
      tone: AI_ACTION_STATUS_TONE[a.status],
    });
  }

  for (const h of d.handoffs) {
    ev.push({ id: `n${h.id}`, at: h.created_at, kind: 'handoff', text: h.title || t('chats.ai_act.ev_handoff'), detail: h.body, tone: 'warn' });
  }

  for (const b of d.bookings) {
    ev.push({ id: `bk${b.id}`, at: b.created_at, kind: 'booking', text: t(b.kind === 'visit' ? 'chats.ai_act.ev_visit' : 'chats.ai_act.ev_appointment', { name: b.project_id ? name(b.project_id) : '' }), detail: b.status, tone: 'muted' });
  }

  return ev.sort((x, y) => y.at.localeCompare(x.at));
}
