/**
 * Claim gate — every number the writer emits must trace to a claimable fact.
 *
 * Pipeline: extractMentions (digits in both scripts, separators, number words,
 * multipliers, units) → classifyMention (deterministic rules first) →
 * gateByClass (hard classes must match a fact of that class; distance /
 * duration → review unless matched; rhetorical enumerations and scene numbers
 * pass) → the ambiguous residue goes to ONE batched claim_classifier call.
 */
import { normAr, unifyDigits } from './entities.js';
import type { CallRole, ClaimVerdict, ClassifiedMention, DraftScene, Fact, Mention, MentionClass, RoleCallResult, ScriptWriterRules } from './types.js';

export const HARD_CLASSES: ReadonlySet<string> = new Set(['price', 'area', 'unit_count', 'date', 'availability', 'guarantee', 'payment']);
export const FORBIDDEN_CLASSES: ReadonlySet<string> = new Set(['return', 'financing', 'yield']);
const SOFT_NUMERIC: ReadonlySet<string> = new Set(['distance', 'duration']);

const NUMBER_WORDS: Record<string, number> = {
  'واحد': 1, 'واحده': 1, 'وحده': 1, 'اثنين': 2, 'اثنتين': 2, 'ثنتين': 2, 'اثنان': 2,
  'ثلاث': 3, 'ثلاثه': 3, 'ثلاثة': 3, 'اربع': 4, 'اربعه': 4, 'خمس': 5, 'خمسه': 5, 'ست': 6, 'سته': 6,
  'سبع': 7, 'سبعه': 7, 'ثمان': 8, 'ثمانيه': 8, 'ثماني': 8, 'تسع': 9, 'تسعه': 9, 'عشر': 10, 'عشره': 10,
};
const ORDINALS = ['اول', 'اولي', 'ثاني', 'ثانيه', 'ثالث', 'ثالثه', 'رابع', 'رابعه', 'خامس', 'خامسه', 'سادس', 'سادسه', 'سابع', 'سابعه', 'ثامن', 'ثامنه', 'تاسع', 'تاسعه', 'عاشر', 'عاشره'];
const ENUM_NOUNS = /^(مزايا|ميزه|ميزات|مميزات|اسباب|سبب|خطوات|خطوه|نقاط|نقطه|طرق|طريقه|امور|اشياء|حاجات|فوائد|عوامل|مراحل|انواع|خيارات|افكار|اسئله|سؤال|حقائق|حقيقه|معلومات|معلومه|اشارات|علامات|اهداف|قواعد|شروط|نصائح|نصيحه|فرص|فرصه|مفاجات|مفاجاه|كلمات|كلمه|جمل|جمله|اجزاء|جزء)$/;

/** Unicode-safe "end of word" — JS `` is ASCII-only and never fires after Arabic letters. */
const END = '(?![\\p{L}\\p{N}])';
const unit = (alts: string, flags = 'u'): RegExp => new RegExp(`^(?:${alts})${END}`, flags);
const UNIT_PATTERNS: Array<[RegExp, string]> = [
  [unit('ر\\.?\\s?س|ريال(?:ات)?(?:\\s?سعودي)?|sar|رس', 'iu'), 'sar'],
  [new RegExp('^(?:م\\s?[²٢2]|متر\\s?مربع|مترمربع|م\\.م|sqm|m2|m²)', 'iu'), 'm2'],
  [new RegExp('^(?:%|٪|بالمئه|بالميه|بالمائه|في المئه)', 'u'), 'percent'],
  [unit('دقيقه|دقيقة|دقائق|دقايق|min(?:utes?)?', 'iu'), 'minute'],
  [unit('كم|كيلو(?:متر)?|km', 'iu'), 'km'],
  [unit('متر|م'), 'm'],
  [unit('سنه|سنة|سنوات|سنين|عام|اعوام|أعوام|years?', 'iu'), 'year'],
  [unit('شهر|اشهر|أشهر|شهور|months?', 'iu'), 'month'],
  [unit('يوم|ايام|أيام|days?', 'iu'), 'day'],
  [unit('غرف(?:ه|ة)?|غرف نوم|صالات|صاله|دورات مياه|حمامات|مجالس|مجلس|rooms?|bedrooms?', 'iu'), 'room'],
  [unit('وحده|وحدة|وحدات|فلل|فيلا|فيلات|شقه|شقة|شقق|تاون\\s?هاوس|ادوار|أدوار|دور|بنتهاوس|دوبلكس|استوديو|units?|villas?|apartments?', 'iu'), 'unit'],
  [unit('مشهد|لقطه|لقطة|scene', 'iu'), 'scene'],
  [unit('الف|ألف|آلاف|الاف'), 'thousand'],
  [unit('مليون|ملايين'), 'million'],
];

function detectUnit(after: string): { unit: string | null; consumed: string } {
  const a = after.replace(/^[\s:]+/, '');
  for (const [re, unit] of UNIT_PATTERNS) {
    const m = a.match(re);
    if (m) return { unit, consumed: m[0] };
  }
  return { unit: null, consumed: '' };
}

function parseNumber(raw: string): number | null {
  const s = unifyDigits(raw).replace(/[٬,]/g, '').replace(/٫/g, '.');
  // "1.200.000" (dot as thousands) → strip dots when more than one
  const dots = (s.match(/\./g) ?? []).length;
  const cleaned = dots > 1 ? s.replace(/\./g, '') : s;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const NUM_RE = /(\d{1,3}(?:[,٬]\d{3})+(?:[.٫]\d+)?|\d+(?:[.٫]\d+)?)/g;
const RANGE_JOIN = /^\s*(?:-|–|—|ـ|الى|إلى|to)\s*/;

/** Extract every numeric / number-word / ordinal mention with a small context window. */
export function extractMentions(text: string): Mention[] {
  if (!text) return [];
  const uni = unifyDigits(text);
  const out: Mention[] = [];
  const ctx = (i: number, len: number): string => text.slice(Math.max(0, i - 25), Math.min(text.length, i + len + 25));

  // 1. Digits.
  const covered: Array<[number, number]> = [];
  for (const m of uni.matchAll(NUM_RE)) {
    const start = m.index ?? 0;
    let raw = m[0];
    let end = start + raw.length;
    if (raw.replace(/\D/g, '').length >= 9) continue; // phone-like → entity gate
    let value = parseNumber(raw);
    let value2: number | null | undefined;
    // range: 120 – 150
    const restForRange = uni.slice(end);
    const rj = restForRange.match(RANGE_JOIN);
    if (rj) {
      const m2 = restForRange.slice(rj[0].length).match(/^(\d{1,3}(?:[,٬]\d{3})+(?:[.٫]\d+)?|\d+(?:[.٫]\d+)?)/);
      if (m2) {
        value2 = parseNumber(m2[0]);
        raw = uni.slice(start, end + rj[0].length + m2[0].length);
        end = start + raw.length;
      }
    }
    let approximate = false;
    let rawEnd = end;
    const skipWs = (p: number): number => p + (uni.slice(p).match(/^[\s:]*/)?.[0].length ?? 0);
    let { unit, consumed } = detectUnit(uni.slice(end));
    if (consumed) rawEnd = skipWs(end) + consumed.length;
    if (unit === 'thousand' || unit === 'million') {
      const mult = unit === 'thousand' ? 1_000 : 1_000_000;
      value = value === null ? null : value * mult;
      if (value2 !== undefined && value2 !== null) value2 = value2 * mult;
      approximate = true;
      const u2 = detectUnit(uni.slice(rawEnd));
      unit = u2.unit ?? 'sar';
      if (u2.consumed) rawEnd = skipWs(rawEnd) + u2.consumed.length;
    }
    out.push({ raw: text.slice(start, rawEnd).trim(), value, value2, unit, context: ctx(start, raw.length), index: start, approximate });
    covered.push([start, rawEnd]);
  }

  // 2. Number words + ordinals.
  const wordRe = /[\p{L}]+/gu;
  for (const m of text.matchAll(wordRe)) {
    const start = m.index ?? 0;
    const w = normAr(m[0]).replace(/^(و|ف|ب|ل|ك)?(ال)?/, '');
    const isWord = Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w);
    const isOrdinal = ORDINALS.includes(w);
    if (!isWord && !isOrdinal) continue;
    if (covered.some(([s, e]) => start >= s && start < e)) continue;
    const after = text.slice(start + m[0].length);
    let value: number | null = isWord ? NUMBER_WORDS[w]! : null;
    let { unit, consumed } = detectUnit(after);
    if (value !== null && (unit === 'thousand' || unit === 'million')) {
      value *= unit === 'thousand' ? 1_000 : 1_000_000;
      const rest = after.replace(/^[\s:]*/, '').slice(consumed.length);
      const u2 = detectUnit(rest);
      unit = u2.unit ?? 'sar';
      consumed = `${consumed}${u2.consumed ? ` ${u2.consumed}` : ''}`;
    }
    out.push({
      raw: `${m[0]}${consumed ? ` ${consumed}` : ''}`.trim(),
      value,
      unit: isOrdinal ? 'ordinal' : unit,
      context: ctx(start, m[0].length),
      index: start,
      approximate: true,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** The word right after the mention (context starts ≤25 chars before `raw`). */
function nextWord(m: Mention): string {
  const offset = Math.min(25, m.index);
  const after = m.context.slice(offset + m.raw.length);
  const w = normAr(after).replace(/^[^\p{L}]+/u, '').split(/\s+/)[0] ?? '';
  return w.replace(/^(و|ف|ب|ل|ك)?(ال)?/, '');
}

/** Deterministic classification. `confident=false` marks the residue for the model classifier. */
export function classifyMention(m: Mention): ClassifiedMention {
  const c = normAr(m.context);
  const has = (re: RegExp): boolean => re.test(c);
  const done = (cls: MentionClass, confident = true): ClassifiedMention => ({ ...m, class: cls, confident });

  if (m.unit === 'scene') return done('scene_numbering');
  if (m.unit === 'ordinal') return done('rhetorical_enumeration');
  if (m.value !== null && m.unit === null) {
    const nw = nextWord(m);
    if (ENUM_NOUNS.test(nw)) return done('rhetorical_enumeration');
    // «المشهد ٣» / «لقطة ٤» — the noun precedes the number
    const before = normAr(m.context.slice(0, Math.min(25, m.index))).trim().split(/\s+/).pop() ?? '';
    if (/^(ال)?(مشهد|لقطه|scene)$/.test(before)) return done('scene_numbering');
  }
  if (m.unit === null && has(/\b(اهم|ابرز)\s+\S+\s+(مزايا|ميزات|اسباب|نقاط|امور)/)) return done('rhetorical_enumeration');

  const forbid = (): ClassifiedMention | null => {
    if (has(/عائد|عوائد|ربح|ارباح|return|yield|مردود/)) return done('return');
    if (has(/تمويل|بنك|فائده|فوائد|مرابحه|قسط شهري|اقساط بنكيه|financ/)) return done('financing');
    return null;
  };

  switch (m.unit) {
    case 'sar': return forbid() ?? done('price');
    case 'm2': return done('area');
    case 'percent': {
      const f = forbid();
      if (f) return f;
      if (has(/دفعه|مقدم|تقسيط|قسط|اقساط|تسليم|سداد|خطه|دفع/)) return done('payment');
      if (has(/خصم|تخفيض/)) return done('price');
      return done('other', false);
    }
    case 'minute': return done('duration');
    case 'km': case 'm': return done('distance');
    case 'year': case 'month': case 'day': {
      const f = forbid();
      if (f) return f;
      if (has(/ضمان|ضمانات|كفاله/)) return done('guarantee');
      if (has(/تقسيط|قسط|اقساط|سداد|دفعات|دفع/)) return done('payment');
      if (has(/تسليم|استلام|تستلم|جاهز|انجاز|اكتمال/)) return done('date');
      return done('other', false);
    }
    case 'room': return done('other');
    case 'unit': {
      if (has(/متبقي|باقي|باقيه|متبقيه|متاح|متاحه|اخر|بس|فقط|محدود|لحق|الحق|سارع/)) return done('availability');
      if (m.value !== null && m.value <= 1) return done('other');
      return done('unit_count');
    }
    default: break;
  }

  // Bare numbers.
  if (m.value !== null) {
    if (m.value >= 1400 && m.value <= 1500) return done('date'); // hijri year
    if (m.value >= 2020 && m.value <= 2040 && Number.isInteger(m.value)) return done('date');
    const f = forbid();
    if (f) return f;
    if (has(/سعر|اسعار|بسعر|تبدا|يبدا|ريال|ر\.س|قيمه|ثمن/)) return done('price');
    if (has(/مساحه|مساحات|متر مربع/)) return done('area');
    if (has(/دقيقه|دقائق|دقايق/)) return done('duration');
    if (has(/كيلو|كم\b|مسافه/)) return done('distance');
    if (has(/ضمان/)) return done('guarantee');
    if (has(/دفعه|مقدم|تقسيط|قسط|سداد/)) return done('payment');
    if (has(/تسليم|استلام/)) return done('date');
    if (has(/غرف|غرفه|صالات|حمام|دورات مياه/)) return done('other');
    if (has(/وحده|وحدات|فلل|شقق|فيلا|شقه/)) return has(/متبقي|باقي|متاح|فقط|بس/) ? done('availability') : done('unit_count');
    return done('other', false);
  }
  return done('other');
}

function factNumbers(f: Fact): number[] {
  const v = f.value;
  if (typeof v === 'number') return [v];
  if (v && typeof v === 'object') {
    const r = v as { min?: unknown; max?: unknown };
    return [r.min, r.max].filter((x): x is number => typeof x === 'number');
  }
  if (typeof v === 'string') {
    const n = Number(unifyDigits(v).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && v.replace(/\D/g, '').length > 0 ? [n] : [];
  }
  return [];
}

function numEq(a: number, b: number, approximate: boolean): boolean {
  if (a === b) return true;
  const tol = approximate ? 0.015 : 0.0005;
  return Math.abs(a - b) <= Math.abs(b) * tol;
}

function matchesFact(m: ClassifiedMention, f: Fact): boolean {
  if (m.value === null) return false;
  if (f.class === 'date' && typeof f.value === 'string') {
    const y = Number(f.value.slice(0, 4));
    const mo = Number(f.value.slice(5, 7));
    if (m.value >= 2020 && m.value <= 2040) return m.value === y;
    if (m.unit === 'month' || m.unit === null) return m.value === mo;
    return false;
  }
  const nums = factNumbers(f);
  if (nums.length === 0) return false;
  const v = m.value;
  const v2 = m.value2 ?? null;
  if (v2 !== null && nums.length >= 2) {
    // a range mention must sit inside the fact's range (or equal its bounds)
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    return (numEq(v, lo, m.approximate) || v >= lo) && (numEq(v2, hi, m.approximate) || v2 <= hi);
  }
  return nums.some((n) => numEq(v, n, m.approximate));
}

export interface GateInput { scene: number; field: 'voiceover' | 'on_screen_text'; mention: ClassifiedMention }

/** Deterministic verdicts. Mentions with `confident=false` are returned as `review` with reason 'ambiguous'. */
export function gateByClass(items: GateInput[], facts: Fact[], rules: Pick<ScriptWriterRules, 'forbidden_claim_classes'>): ClaimVerdict[] {
  const forbidden = new Set([...FORBIDDEN_CLASSES, ...rules.forbidden_claim_classes]);
  const claimable = facts.filter((f) => f.claimable);
  return items.map(({ scene, field, mention: m }): ClaimVerdict => {
    const base = { scene, field, mention: m.raw, class: m.class };
    if (m.class === 'rhetorical_enumeration') return { ...base, verdict: 'pass', reason: 'rhetorical enumeration, not a factual quantity' };
    if (m.class === 'scene_numbering') return { ...base, verdict: 'pass', reason: 'scene numbering' };
    if (forbidden.has(m.class)) return { ...base, verdict: 'fail', reason: `class '${m.class}' is never claimable` };
    if (!m.confident) return { ...base, verdict: 'review', reason: 'ambiguous — unresolved class' };

    const sameClass = claimable.filter((f) => f.class === m.class);
    const hit = sameClass.find((f) => matchesFact(m, f));
    if (HARD_CLASSES.has(m.class)) {
      if (hit) return { ...base, verdict: 'pass', fact_id: hit.id, reason: `matches ${hit.id} (${hit.source_field})` };
      const anyFact = facts.find((f) => f.class === m.class && matchesFact(m, f));
      if (anyFact && !anyFact.claimable) return { ...base, verdict: 'fail', reason: `matches ${anyFact.id} but that fact is not claimable as a number (${anyFact.note ?? 'qualitative'})` };
      return { ...base, verdict: 'fail', reason: m.value === null ? `hard class '${m.class}' without a numeric fact` : `no claimable ${m.class} fact equals ${m.value}` };
    }
    if (SOFT_NUMERIC.has(m.class)) {
      if (hit) return { ...base, verdict: 'pass', fact_id: hit.id, reason: `matches ${hit.id}` };
      return { ...base, verdict: 'review', reason: `${m.class} not found in facts — verify before shooting` };
    }
    // other / descriptive numerics: pass when any claimable fact carries the number, else review
    if (m.value === null) return { ...base, verdict: 'pass', reason: 'non-quantitative mention' };
    const anyHit = claimable.find((f) => matchesFact(m, f));
    if (anyHit) return { ...base, verdict: 'pass', fact_id: anyHit.id, reason: `matches ${anyHit.id}` };
    return { ...base, verdict: 'review', reason: 'number not traceable to a fact' };
  });
}

export const CLASSIFIER_CLASSES: ReadonlyArray<string> = [
  'price', 'area', 'unit_count', 'date', 'distance', 'duration', 'availability', 'guarantee', 'payment',
  'return', 'financing', 'rhetorical_enumeration', 'scene_numbering', 'other',
];

export const CLASSIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'integer' }, class: { type: 'string', enum: [...CLASSIFIER_CLASSES] } },
        required: ['id', 'class'],
      },
    },
  },
  required: ['items'],
} as const;

/** Character spans of every name-class fact inside `text` (digits unified, whitespace-tolerant). */
export function nameFactSpans(text: string, facts: Fact[]): Array<[number, number]> {
  const uni = unifyDigits(text);
  const spans: Array<[number, number]> = [];
  for (const f of facts) {
    if (f.class !== 'name' || typeof f.value !== 'string' || !/\d/.test(unifyDigits(f.value))) continue;
    const parts = unifyDigits(f.value).trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (parts.length === 0) continue;
    const re = new RegExp(parts.join('\\s+'), 'gu');
    for (const m of uni.matchAll(re)) spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return spans;
}

export interface VerifyClaimsResult {
  verdicts: ClaimVerdict[];
  /** The one batched classifier call, when the residue needed it (caller records it on the ledger). */
  classifier?: RoleCallResult<{ items: Array<{ id: number; class: string }> }>;
  /** null = a call ran but its cost is unknown (never coerced to 0); 0 = no call. */
  cost_usd: number | null;
}

/**
 * Full claim verification for a set of scenes. Deterministic first; the
 * ambiguous residue (if any) goes to the claim_classifier role in ONE batched
 * call, then is gated again. Pass `callRole=null` to skip the model (legacy /
 * offline) — residue stays `review`.
 */
export async function verifyClaims(
  scenes: Array<Pick<DraftScene, 'order' | 'voiceover' | 'on_screen_text'>>,
  facts: Fact[],
  rules: Pick<ScriptWriterRules, 'forbidden_claim_classes'>,
  callRole: CallRole | null,
): Promise<VerifyClaimsResult> {
  const items: GateInput[] = [];
  const nameSpans = (text: string): Array<[number, number]> => nameFactSpans(text, facts);
  for (const s of scenes) {
    for (const field of ['voiceover', 'on_screen_text'] as const) {
      const text = s[field] ?? '';
      const spans = nameSpans(text);
      for (const m of extractMentions(text)) {
        const inName = spans.some(([a, b]) => m.index >= a && m.index < b);
        // «أكنان ٢٥» — a digit that is part of a name fact is the name, not a quantity.
        items.push({ scene: s.order, field, mention: inName ? { ...m, class: 'name', confident: true } : classifyMention(m) });
      }
    }
  }
  const residue = items.map((it, i) => ({ it, i })).filter(({ it }) => !it.mention.confident);
  let classifier: VerifyClaimsResult['classifier'];
  if (residue.length > 0 && callRole) {
    const user = JSON.stringify({
      classes: CLASSIFIER_CLASSES,
      items: residue.map(({ it, i }) => ({ id: i, mention: it.mention.raw, context: it.mention.context, field: it.field })),
    });
    const system = [
      'You classify numeric mentions inside Saudi-Arabic real-estate video scripts.',
      'For each item pick exactly one class from `classes`. Rules:',
      '- price: money amounts (ريال, ر.س, ألف/مليون).',
      '- area: square metres. unit_count: number of units in the project. availability: units left / remaining.',
      '- date: delivery / handover timing. distance / duration: to landmarks.',
      '- guarantee: warranty years. payment: down payment %, instalments. return / financing: yields, mortgages, bank rates.',
      '- rhetorical_enumeration: counts of reasons/features/steps in speech («ثلاث مزايا»). scene_numbering: «مشهد ٣».',
      '- other: anything else (rooms, floors, generic).',
      'Return JSON only.',
    ].join('\n');
    classifier = await callRole<{ items: Array<{ id: number; class: string }> }>('claim_classifier', { system, user, schema: CLASSIFIER_SCHEMA as unknown as Record<string, unknown> });
    for (const r of classifier.output.items ?? []) {
      const target = items[r.id];
      if (!target || !CLASSIFIER_CLASSES.includes(r.class)) continue;
      target.mention = { ...target.mention, class: r.class as MentionClass, confident: true };
    }
  }
  const verdicts = gateByClass(items, facts, rules);
  const result: VerifyClaimsResult = { verdicts, cost_usd: classifier?.cost_usd ?? 0 };
  if (classifier) result.classifier = classifier;
  return result;
}
