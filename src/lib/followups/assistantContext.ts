/**
 * Builds the contextual preface the Wassel Sales Assistant uses when it runs
 * inside a Follow-up record (the side-panel surface). ONE assistant, multiple
 * surfaces — this only assembles the *context* that the existing `/api/match`
 * brain consumes; it never matches or scores anything itself.
 *
 * The salesperson edits the client's preferences inline in the Follow-up
 * Workspace (PreferenceSummary) BEFORE saving. Those unsaved edits live in a
 * lifted `prefDraft` buffer. This helper resolves each preference DRAFT-FIRST
 * (draft value > saved client value > missing), turns it into human-readable
 * Arabic/English lines for the UI, and into an Arabic preface that tells the
 * assistant to treat these current draft values as the source of truth.
 *
 *   priority:  draft form value  >  saved record value  >  missing
 */

import type { AppModel, ModelField } from '@/types';

/** One resolved preference, ready to show in the panel and feed the assistant. */
export interface UsedPreference {
  slug: string;
  label_ar: string;
  label_en: string;
  /** Display value already resolved (option labels, formatted ranges). */
  value: string;
}

/** The preference slugs we map into project-matching requirements, in the order
 *  we present them. Slugs verified against the live `clients` model (2026-06-21).
 *  All but the two ranges are multiselect storing the Arabic label as the value,
 *  which is exactly what match_projects fuzzy-matches against project text. */
const PREF_FIELDS: Array<{ slug: string; label_ar: string; label_en: string; kind: 'list' | 'money' | 'area' | 'geo' }> = [
  // Relational geography: preferred_cities / preferred_districts hold cities/districts
  // record ids, resolved to names via geoNames (no legacy preferred_city / neighborhoods).
  { slug: 'preferred_cities', label_ar: 'المدينة', label_en: 'City', kind: 'geo' },
  { slug: 'preferred_districts', label_ar: 'الحي', label_en: 'District', kind: 'geo' },
  { slug: 'preferred_unit_type', label_ar: 'نوع العقار', label_en: 'Property type', kind: 'list' },
  { slug: 'budget', label_ar: 'الميزانية', label_en: 'Budget', kind: 'money' },
  { slug: 'preferred_area', label_ar: 'المساحة', label_en: 'Area', kind: 'area' },
  { slug: 'preferred_amenities', label_ar: 'المرافق / نمط الحياة', label_en: 'Amenities / lifestyle', kind: 'list' },
  { slug: 'preferred_direction', label_ar: 'الاتجاه', label_en: 'Direction', kind: 'list' },
];

/** Resolve an array of lookup record ids (districts/cities) to display names. */
function geoValue(raw: unknown, geoNames: Record<string, string> | undefined): string | null {
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const names = arr
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((id) => geoNames?.[id])
    .filter((s): s is string => !!s);
  return names.length ? names.join('، ') : null;
}

const isPresent = (v: unknown): boolean => {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.some((x) => x !== null && x !== undefined && x !== '');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return o.min != null || o.max != null;
  }
  return true;
};

/** Resolve a stored option value to its display label via the field's options.
 *  Stored values ARE the Arabic label in this app, so the fallback (raw value)
 *  is already meaningful for both display and matching. */
function optionLabel(field: ModelField | undefined, value: string, isAr: boolean): string {
  const opt = field?.options?.find((o) => o.value === value);
  if (!opt) return value;
  return (isAr ? opt.label_ar : opt.label_en) || opt.label_ar || opt.label_en || value;
}

function formatMoneyRange(v: unknown, isAr: boolean): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const min = typeof o.min === 'number' ? o.min : Number(o.min);
  const max = typeof o.max === 'number' ? o.max : Number(o.max);
  const fmt = (n: number) => n.toLocaleString('en-US');
  const cur = isAr ? 'ر.س' : 'SAR';
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  if (hasMin && hasMax) return `${fmt(min)} – ${fmt(max)} ${cur}`;
  if (hasMax) return `${isAr ? 'حتى' : 'up to'} ${fmt(max)} ${cur}`;
  if (hasMin) return `${isAr ? 'من' : 'from'} ${fmt(min)} ${cur}`;
  return null;
}

function formatAreaRange(v: unknown, isAr: boolean): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const min = typeof o.min === 'number' ? o.min : Number(o.min);
  const max = typeof o.max === 'number' ? o.max : Number(o.max);
  const unit = isAr ? 'م²' : 'm²';
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  if (hasMin && hasMax) return `${min} – ${max} ${unit}`;
  if (hasMax) return `${isAr ? 'حتى' : 'up to'} ${max} ${unit}`;
  if (hasMin) return `${isAr ? 'من' : 'from'} ${min} ${unit}`;
  return null;
}

function listValue(field: ModelField | undefined, raw: unknown, isAr: boolean): string | null {
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const labels = arr
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((v) => optionLabel(field, v, isAr));
  return labels.length ? labels.join('، ') : null;
}

export interface BuildContextArgs {
  clientsModel: AppModel | null;
  /** Lifted, draft-first preference buffer (seeded from the saved client). */
  prefDraft: Record<string, unknown>;
  /** The saved client record's data — fallback when a draft slot is empty. */
  savedClientData: Record<string, unknown> | null;
  /** The follow-up's own draft (outcome_notes, etc.) for extra context. */
  followupDraft: Record<string, unknown>;
  /** Optional project the follow-up is centered on (ctx.project), for context. */
  projectName?: string | null;
  /** id → display name map for districts + cities, so preferred_districts /
   *  preferred_cities lookup ids resolve to readable names. Built by the caller. */
  geoNames?: Record<string, string>;
  isAr: boolean;
}

export interface AssistantContext {
  /** Resolved, present preferences — shown in the panel and used by the assistant. */
  used: UsedPreference[];
  /** True when at least one preference resolved — drives the "thin requirements" hint. */
  hasAny: boolean;
  /** The Arabic/English preface prepended to the user's message sent to /api/match. */
  preface: string;
}

/**
 * Resolve every preference draft-first and assemble the assistant context.
 * Returns the resolved preferences (for the panel UI) plus the preface string
 * that grounds the shared assistant in the current, unsaved follow-up values.
 */
export function buildAssistantContext(args: BuildContextArgs): AssistantContext {
  const { clientsModel, prefDraft, savedClientData, followupDraft, projectName, geoNames, isAr } = args;
  const fieldBySlug = new Map<string, ModelField>();
  for (const sec of clientsModel?.schema.sections ?? []) {
    for (const f of sec.fields) fieldBySlug.set(f.name, f);
  }

  const pick = (slug: string): unknown => {
    const draftVal = prefDraft[slug];
    if (isPresent(draftVal)) return draftVal;
    const savedVal = savedClientData?.[slug];
    return isPresent(savedVal) ? savedVal : undefined;
  };

  const used: UsedPreference[] = [];
  for (const def of PREF_FIELDS) {
    const raw = pick(def.slug);
    if (!isPresent(raw)) continue;
    const field = fieldBySlug.get(def.slug);
    let value: string | null = null;
    if (def.kind === 'money') value = formatMoneyRange(raw, isAr);
    else if (def.kind === 'area') value = formatAreaRange(raw, isAr);
    else if (def.kind === 'geo') value = geoValue(raw, geoNames);
    else value = listValue(field, raw, isAr);
    if (!value) continue;
    used.push({ slug: def.slug, label_ar: def.label_ar, label_en: def.label_en, value });
  }

  const notes = typeof followupDraft.outcome_notes === 'string' ? followupDraft.outcome_notes.trim() : '';

  const lines = used.map((p) => `- ${isAr ? p.label_ar : p.label_en}: ${p.value}`);
  if (projectName) lines.push(`- ${isAr ? 'المشروع محل المتابعة' : 'Follow-up project'}: ${projectName}`);
  if (notes) lines.push(`- ${isAr ? 'ملاحظات المتابعة' : 'Follow-up notes'}: ${notes}`);

  const header = isAr
    ? 'أنت الآن داخل سجل متابعة في وصل العقارية — نفس مساعد المبيعات، لكن في سياق هذه المتابعة. اعتمد على تفضيلات العميل الحالية التالية من نموذج المتابعة (قد تتضمن تعديلات لم تُحفظ بعد) كمصدر لتفضيلات العميل، وقدّمها على أي قيمة محفوظة سابقاً. إن نقص تفضيل مهم، اسأل سؤالاً أو سؤالين دقيقين بدل التخمين. اذكر باختصار في بداية ردك التفضيلات التي اعتمدت عليها.'
    : 'You are now inside a Follow-up record at Wassel — the same Sales Assistant, in the context of this follow-up. Use the following CURRENT client preferences from the follow-up form (they may include unsaved edits) as the source of the customer\'s preferences, ahead of any previously saved value. If an important preference is missing, ask one or two sharp questions instead of guessing. Briefly state at the start of your reply which preferences you relied on.';

  const body = lines.length
    ? `\n${isAr ? 'التفضيلات الحالية في نموذج المتابعة:' : 'Current preferences in the follow-up form:'}\n${lines.join('\n')}`
    : `\n${isAr ? '(لا توجد تفضيلات محددة بعد في نموذج المتابعة — اطلبها من مستشار المبيعات.)' : '(No preferences are set yet in the follow-up form — ask the salesperson for them.)'}`;

  return {
    used,
    hasAny: used.length > 0,
    preface: `[${header}${body}]`,
  };
}
