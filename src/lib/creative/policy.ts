/**
 * Image policy (contracts §7) — the fabrication gate for AI image
 * recommendations. PURE module (no I/O).
 *
 * THIS IS THE src/ MIRROR of worker/src/creative/director/policy.ts — the API
 * refuses a queued execution with the same verdict the worker gave. The two
 * files carry IDENTICAL logic; the only differences are the imports:
 *   - types come from ./contracts.js (the worker copy reads ../contracts.js);
 *   - normAr is INLINED below (the worker imports it from
 *     worker/src/marketing/script/entities.js, which src/ must not import —
 *     src has no copy of that module). The inlined normAr is byte-for-byte the
 *     same normalisation (the TS twin of SQL mkt_norm_ar): folds أإآٱ→ا, ة→ه,
 *     ى→ي, drops tatweel + diacritics, unifies Arabic-Indic / Persian digits,
 *     collapses whitespace, lower-cases.
 * Change BOTH copies together.
 *
 * ALLOWED modes: cleanup, crop, color_correct, extend_background,
 *   remove_clutter, combine (approved assets), supporting_visual
 *   (lifestyle/abstract, no project features), remove_text, request_photo.
 * FORBIDDEN: any prompt that creates/changes the project's building, units,
 *   interiors, views, amenities, architectural features, or characteristics
 *   absent from the facts.
 *
 * Detector (deterministic, by contract): the prompt must not contain
 * build/add/create verbs targeting those nouns (AR + EN lists), unless the
 * mode is one of {cleanup, crop, color_correct} AND must_keep includes
 * 'architecture'. `request_photo` is always ok — it asks a human for a real
 * photo, it fabricates nothing. `supporting_visual` carries the extra
 * lifestyle/abstract rule: no project-feature nouns at all.
 *
 * Violations → `policy_blocked:` and the orchestrator emits the
 * recommendation with status 'dismissed' + a warning — never queued.
 */
import type { AiMode, AiRecommendation } from './contracts';

// ── inlined normAr (twin of worker/src/marketing/script/entities.ts) ────────
const DIACRITICS = /[ً-ْٰـ]/g; // tanween/harakat/shadda/sukun + dagger alef + tatweel
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

function unifyDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    const p = PERSIAN.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    out += ch;
  }
  return out;
}

function normAr(s: string | null | undefined): string {
  if (!s) return '';
  return unifyDigits(s)
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
// ── end inlined normAr ──────────────────────────────────────────────────────

export interface PolicyVerdict {
  ok: boolean;
  /** Stable, human-readable reason (English + Arabic) — empty when ok. */
  reason: string;
}

/** contracts §7 — anything else is rejected before the prompt is even read. */
export const ALLOWED_AI_MODES: readonly AiMode[] = [
  'cleanup',
  'crop',
  'color_correct',
  'extend_background',
  'remove_clutter',
  'combine',
  'supporting_visual',
  'remove_text',
  'request_photo',
];

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_AI_MODES);

/** Modes that only fix an existing photo — they may NAME architecture when must_keep protects it. */
const NON_FABRICATING_MODES: ReadonlySet<string> = new Set(['cleanup', 'crop', 'color_correct']);

/**
 * Build/add/create/change verbs — Arabic (post-normAr: hamzas folded to ا) and
 * English. Kept as plain substring lists; the detector checks co-occurrence
 * with a project noun inside a window.
 */
export const FABRICATION_VERBS_AR: readonly string[] = [
  'انشئ', 'اخلق', 'ابن', 'ابني', 'اضف', 'اضاف', 'غير', 'بدل', 'صمم', 'ولد',
  'ارسم', 'رندر', 'حول', 'وسع المبني', 'اعرض المبني', 'اجعل المبني', 'اجعل الوحده',
];
export const FABRICATION_VERBS_EN: readonly string[] = [
  'create', 'build', 'add', 'change', 'modify', 'alter', 'generate', 'design',
  'draw', 'render a', 'make the', 'place a', 'insert',
];

/** Project-feature nouns — the things the policy forbids fabricating/changing. */
export const PROJECT_NOUNS_AR: readonly string[] = [
  'المبني', 'البرج', 'الواجهه', 'العماره', 'المعمار', 'الوحده', 'الشقه', 'الفيلا',
  'الدور', 'البنتهاوس', 'الداخليه', 'التشطيب', 'الاطلاله', 'المنظر', 'المرافق',
  'المسبح', 'الصاله', 'النادي', 'الجيم', 'الغرفه', 'المطبخ', 'الحديقه', 'المدخل',
  'اللوبي', 'المواقف', 'المخطط',
];
export const PROJECT_NOUNS_EN: readonly string[] = [
  'building', 'tower', 'facade', 'architecture', 'unit', 'apartment', 'villa',
  'penthouse', 'interior', 'finishing', 'view', 'amenity', 'amenities', 'pool',
  'gym', 'lobby', 'room', 'bedroom', 'kitchen', 'garden', 'entrance', 'parking',
  'floor plan', 'balcony',
];

/** How far around a verb we look for a project noun (chars, normalized text). */
const VERB_NOUN_WINDOW = 90;

export interface FabricationHit {
  verb: string;
  noun: string;
}

/**
 * Find the first build/add/create verb that has a project noun within
 * VERB_NOUN_WINDOW chars of it (in either direction). null = clean.
 */
export function findFabrication(prompt: string): FabricationHit | null {
  const norm = normAr(prompt).toLowerCase();
  const verbs = [...FABRICATION_VERBS_AR, ...FABRICATION_VERBS_EN];
  const nouns = [...PROJECT_NOUNS_AR, ...PROJECT_NOUNS_EN];
  for (const verb of verbs) {
    let idx = norm.indexOf(verb);
    while (idx !== -1) {
      const from = Math.max(0, idx - VERB_NOUN_WINDOW);
      const to = Math.min(norm.length, idx + verb.length + VERB_NOUN_WINDOW);
      const window = norm.slice(from, to);
      for (const noun of nouns) {
        if (window.includes(noun)) return { verb, noun };
      }
      idx = norm.indexOf(verb, idx + verb.length);
    }
  }
  return null;
}

/** True when the prompt names ANY project-feature noun (the supporting_visual ban). */
export function namesProjectFeature(prompt: string): string | null {
  const norm = normAr(prompt).toLowerCase();
  for (const noun of [...PROJECT_NOUNS_AR, ...PROJECT_NOUNS_EN]) {
    if (norm.includes(noun)) return noun;
  }
  return null;
}

/** The slice of an AiRecommendation the policy reads. */
export type PolicyRecommendation = Pick<AiRecommendation, 'mode' | 'prompt' | 'must_keep'>;

/**
 * The §7 gate. Pure: same inputs → same verdict, no clock, no I/O.
 * `request_photo` always passes; unknown modes fail; fabrication prompts fail
 * unless the mode is non-fabricating AND must_keep protects the architecture.
 */
export function checkAiRecommendation(rec: PolicyRecommendation): PolicyVerdict {
  const ok = (reason = ''): PolicyVerdict => ({ ok: true, reason });
  const blocked = (reason: string): PolicyVerdict => ({ ok: false, reason });

  if (rec.mode === 'request_photo') return ok();

  if (!ALLOWED_SET.has(rec.mode)) {
    return blocked(
      `policy_blocked: mode '${rec.mode}' is not one of the §7 allowed modes (${ALLOWED_AI_MODES.join(', ')}) — ` +
      `النمط غير مسموح؛ الأنماط المسموحة فقط هي المذكورة.`,
    );
  }

  if (rec.mode === 'supporting_visual') {
    const noun = namesProjectFeature(rec.prompt);
    if (noun) {
      return blocked(
        `policy_blocked: supporting_visual must stay lifestyle/abstract — the prompt names a project feature «${noun}». ` +
        `الصورة الداعمة لا تصوّر مزايا المشروع (مبنى/وحدات/مرافق)؛ تبقى لايف ستايل أو تجريدية فقط.`,
      );
    }
    return ok();
  }

  const hit = findFabrication(rec.prompt);
  if (hit) {
    const keepsArchitecture = rec.must_keep.some((k) => normAr(k).toLowerCase().includes('architecture') || normAr(k).includes('العماره') || normAr(k).includes('المعمار'));
    if (!(NON_FABRICATING_MODES.has(rec.mode) && keepsArchitecture)) {
      return blocked(
        `policy_blocked: prompt fabricates/changes project features («${hit.verb}» near «${hit.noun}») — forbidden by §7. ` +
        `ممنوع إنشاء أو تغيير مبنى المشروع أو وحداته أو داخليته أو إطلالته أو مرافقه.`,
      );
    }
  }

  return ok();
}
