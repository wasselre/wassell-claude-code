// ============================================================================
// The proof checker for a content-enrichment decision (which project a post
// promotes), ported from scripts/lib/mkt-enrichment-validate.mjs so the worker
// can run it after its own Gemini read. COPY — the worker is a standalone
// package and cannot import from scripts/. Change BOTH files together; the
// parity test (__tests__/enrichmentValidateParity.test.ts) feeds the same
// fixtures to both and fails when they disagree.
//
// The rule is mechanical, not a prompt request: a project pick must come with
// `evidence_quote`, a verbatim excerpt of the caption / transcript / on-screen
// text that names the chosen project (its name or number), not merely the
// publisher's brand word. A pick that fails is downgraded to "no project" and
// the reason is recorded (`attribution_rejected`). History of each rule is in
// the .mjs file's header.
// ============================================================================

export interface EnrichCandidate {
  projectId: string;
  nameAr?: string | null;
  nameEn?: string | null;
  confidence?: number;
  strength?: 'full_name' | 'number' | 'word' | string;
  ambiguous?: boolean;
  matchedAliases?: string[];
}

export interface EnrichEvidence {
  post_id: string;
  caption?: string | null;
  transcript?: string | null;
  ocr_text?: string | null;
  brand_tokens?: string[];
  candidates?: EnrichCandidate[];
  deterministic_partial?: boolean;
  attribution_locked?: boolean;
}

/** One model answer, in the shape the content-enrichment skill defines. */
export interface EnrichAnswer {
  post_id: string;
  primary_project_index: number;
  evidence_quote?: string;
  mentioned_projects?: unknown;
  is_general_branding?: boolean;
  language?: string;
  [field: string]: unknown;
}

export interface ValidEnrichment {
  postId: string;
  primaryProjectId: string | null;
  evidenceQuote: string;
  result: Record<string, unknown>;
  candidates: EnrichCandidate[];
  deterministicPartial: boolean;
  locked: boolean;
  secondary: Array<{ projectId: string; confidence: number; matched: string[] }>;
}

const LANGS = new Set(['ar', 'en', 'mixed', 'none']);
const STR_FIELDS = ['content_type', 'objective', 'offer', 'financing', 'payment_plan', 'price', 'location', 'district', 'campaign_message'];
const ARR_FIELDS = ['unit_types', 'amenities', 'selling_points', 'ctas'];

const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 500) : '');
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 20) : []);

/** Same folding as the worker's normalizeAr (see the .mjs for the rationale). */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKC')
    .replace(/[ـً-ْ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/_/g, ' ')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** COPY of GENERIC_TOKENS in worker/src/marketing/pipeline.ts and the .mjs. */
export const GENERIC_TOKENS = new Set([
  'مشروع', 'مشاريع', 'شقق', 'شقه', 'فلل', 'فيلا', 'ادوار', 'دور', 'اراضي', 'ارض',
  'تاون', 'فيلج', 'بارك', 'سكوير', 'ريزيدنس', 'ريزيدنسيز', 'ريزيدنسز',
  'تاور', 'برج', 'ابراج', 'مجمع', 'كمباوند', 'سكني', 'سكنيه', 'هوم', 'هومز', 'هيلز',
  'فيو', 'جاردن', 'جاردنز', 'بلازا', 'سيتي', 'سنتر', 'مول', 'بوليفارد', 'افنيو',
  'ليفينج', 'لاند', 'لاندز', 'العقاريه', 'العقاري', 'للتطوير', 'التطوير', 'للاستثمار',
  'residence', 'residences', 'tower', 'towers', 'park', 'square', 'village', 'town',
  'villas', 'villa', 'apartments', 'homes', 'home', 'hills', 'view', 'garden', 'gardens',
  'plaza', 'city', 'center', 'centre', 'mall', 'boulevard', 'avenue', 'living', 'land',
  'project', 'projects', 'real', 'estate', 'development', 'developments', 'investment',
]);

const nameSources = (c: EnrichCandidate | undefined): unknown[] => [c?.nameAr, c?.nameEn, ...(Array.isArray(c?.matchedAliases) ? c!.matchedAliases : [])];
const brandSet = (ev: EnrichEvidence): Set<string> => new Set((ev?.brand_tokens ?? []).map((t) => normalizeText(t)));
const flatten = (s: string): string => s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function anchorTokens(candidate: EnrichCandidate | undefined, brand: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const raw of nameSources(candidate)) {
    if (typeof raw !== 'string') continue;
    for (const w of flatten(normalizeText(raw)).split(' ')) {
      if (!w) continue;
      if (/^\d+$/.test(w)) { if (w.length >= 2) out.add(w); continue; }
      if (w.length >= 3 && !brand.has(w) && !GENERIC_TOKENS.has(w)) out.add(w);
    }
  }
  return out;
}

function nameVariants(candidate: EnrichCandidate | undefined): string[] {
  const out = new Set<string>();
  const add = (v: string) => { const c = flatten(v); if (c.length >= 3) out.add(c); };
  for (const raw of nameSources(candidate)) {
    if (typeof raw !== 'string' || !raw) continue;
    const n = normalizeText(raw);
    for (const m of n.match(/\(([^)]+)\)/g) ?? []) add(m.slice(1, -1));
    const bare = n.replace(/\([^)]*\)/g, ' ');
    add(bare);
    const seg = (bare.split(/\s+[-–|]\s+/)[0] ?? '').trim();
    if (seg && seg !== bare.trim() && seg.split(/\s+/).length >= 2) add(seg);
  }
  return [...out];
}

function quoteNamesWholeVariant(nq: string, candidate: EnrichCandidate | undefined, brand: Set<string>): boolean {
  const flatQuote = flatten(nq);
  return nameVariants(candidate).some((v) => {
    const words = v.split(' ');
    if (words.length < 2) return false;
    if (!words.some((w) => /^\d+$/.test(w) || (w.length >= 3 && !brand.has(w)))) return false;
    return boundedRe(v).test(flatQuote);
  });
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function boundedRe(s: string): RegExp {
  const words = s.split(' ');
  const left = /^\d+$/.test(words[0] ?? '') ? '(?:^|\\D)' : '(?:^|[^\\p{L}\\p{N}])(?:[وبلفك]|لل)?';
  const right = /^\d+$/.test(words[words.length - 1] ?? '') ? '(?=$|\\D)' : '(?=$|[^\\p{L}\\p{N}])';
  return new RegExp(`${left}${escapeRe(s)}${right}`, 'u');
}

/**
 * Spelling tolerance for LONG name words only (2026-10-04). Captions write a
 * project name with a space inside it («ساند ستون» for «ساندستون») or with one
 * long vowel more or less («مانديفيلا» for «ماندفيلا»); the exact-token check
 * threw those correct picks away (8 Sandstone posts, Mandevilla). Both
 * tolerances need a name word of ≥6 letters, so a short word can never match
 * by accident, and the quote must still be found verbatim in the evidence.
 */
const LONG_NAME = 6;
const despace = (s: string): string => s.replace(/\s+/g, '');
/** The word with its internal long vowels (ا و ي) removed; first letter kept. */
const skeleton = (w: string): string => w.slice(0, 1) + w.slice(1).replace(/[اوي]/g, '');
function fuzzyHit(anchor: string, nq: string): boolean {
  if (anchor.length < LONG_NAME || /^\d+$/.test(anchor)) return false;
  if (despace(flatten(nq)).includes(anchor)) return true;
  const sk = skeleton(anchor);
  if (sk.length < 4) return false;
  return flatten(nq).split(' ').some((w) => {
    const bare = w.replace(/^(?:[وبلفك]|لل)(?=.{5,})/, '');
    for (const cand of [w, bare]) {
      if (cand.length >= LONG_NAME - 1 && Math.abs(cand.length - anchor.length) <= 1 && skeleton(cand) === sk) return true;
    }
    return false;
  });
}

const evidenceText = (ev: EnrichEvidence): string => normalizeText(`${ev?.caption ?? ''}\n${ev?.transcript ?? ''}\n${ev?.ocr_text ?? ''}`);

/** Why a project pick is not acceptable, or null when it is. */
export function attributionRejection(quote: unknown, candidate: EnrichCandidate | undefined, ev: EnrichEvidence): string | null {
  return proofRejection(quote, candidate, ev, 6);
}

function proofRejection(quote: unknown, candidate: EnrichCandidate | undefined, ev: EnrichEvidence, minLength: number): string | null {
  if (typeof quote !== 'string' || quote.trim().length < Math.max(1, minLength)) return 'no evidence_quote';
  if (quote.length > 300) return 'evidence_quote too long';
  const nq = normalizeText(quote);
  if (!evidenceText(ev).includes(nq)) return 'evidence_quote not found verbatim in the evidence';
  const brand = brandSet(ev);
  if (quoteNamesWholeVariant(nq, candidate, brand)) return null;
  const anchors = anchorTokens(candidate, brand);
  if (anchors.size === 0) {
    const full = normalizeText(candidate?.nameAr ?? candidate?.nameEn ?? '');
    return full && nq.includes(full) ? null : 'quote carries only the brand word';
  }
  const hits = [...anchors].filter((a) => boundedRe(a).test(nq) || fuzzyHit(a, nq));
  const need = candidate?.strength === 'word' && anchors.size >= 2 ? 2 : 1;
  if (hits.length < need) return `quote does not name the project (${hits.length}/${need} name tokens)`;
  return null;
}

/** The matcher's own alias as the proof for a STRONG candidate the model quoted badly. */
function matcherQuote(candidate: EnrichCandidate | undefined, ev: EnrichEvidence): string | null {
  if (candidate?.strength !== 'full_name' && candidate?.strength !== 'number') return null;
  const hay = evidenceText(ev);
  const nameNums = normalizeText(`${candidate?.nameAr ?? ''} ${candidate?.nameEn ?? ''}`).match(/\d+/g) ?? [];
  for (const alias of Array.isArray(candidate?.matchedAliases) ? candidate.matchedAliases : []) {
    if (typeof alias !== 'string' || !alias.trim()) continue;
    const quote = alias.trim();
    if (nameNums.length > 0 && !nameNums.some((n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(normalizeText(quote)))) continue;
    if (!boundedRe(normalizeText(quote)).test(hay)) continue;
    if (proofRejection(quote, candidate, ev, 1) === null) return quote;
  }
  return null;
}

export function validateEnrichmentResults(rawResults: unknown, evidence: EnrichEvidence[]): { valid: ValidEnrichment[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(rawResults)) return { valid: [], errors: ['result is not a JSON array'] };
  const byId = new Map(evidence.map((e) => [e.post_id, e]));
  const seen = new Set<string>();
  const valid: ValidEnrichment[] = [];

  for (const raw of rawResults) {
    if (!raw || typeof raw !== 'object') { errors.push('non-object result item'); continue; }
    const item = raw as EnrichAnswer;
    const postId = item.post_id;
    const ev = typeof postId === 'string' ? byId.get(postId) : undefined;
    if (!ev) { errors.push(`unknown/missing post_id: ${JSON.stringify(postId)}`); continue; }
    if (seen.has(postId)) { errors.push(`duplicate post_id: ${postId}`); continue; }

    const cands = Array.isArray(ev.candidates) ? ev.candidates : [];
    let idx = item.primary_project_index;
    if (!Number.isInteger(idx) || idx < -1 || idx >= cands.length) {
      errors.push(`post ${postId}: primary_project_index out of range (${JSON.stringify(idx)}, candidates=${cands.length})`);
      continue;
    }
    let primaryProjectId: string | null = idx >= 0 ? cands[idx]?.projectId ?? null : null;
    if (idx >= 0 && !primaryProjectId) { errors.push(`post ${postId}: candidate[${idx}] has no projectId`); continue; }

    const noEvidence = ![ev.caption, ev.transcript, ev.ocr_text].some((t) => typeof t === 'string' && t.trim() !== '');

    let rejected: string | null = null;
    let modelQuoteRejected: string | null = null;
    let rejectedQuote = '';
    let evidenceQuote = typeof item.evidence_quote === 'string' ? item.evidence_quote.slice(0, 300) : '';
    if (idx >= 0) {
      rejected = noEvidence ? 'post has no evidence (caption, transcript and OCR are empty)' : attributionRejection(evidenceQuote, cands[idx], ev);
      const quoteNames = rejected && !noEvidence
        ? cands.findIndex((c, j) => j !== idx && !!c?.projectId && c.projectId !== primaryProjectId && attributionRejection(evidenceQuote, c, ev) === null)
        : -1;
      const alias = rejected && !noEvidence && quoteNames < 0 ? matcherQuote(cands[idx], ev) : null;
      if (alias) { modelQuoteRejected = rejected; rejected = null; evidenceQuote = alias; }
      else if (rejected) {
        if (quoteNames >= 0) rejected = `${rejected}; the quote names candidate[${quoteNames}] instead`;
        rejectedQuote = evidenceQuote;
        idx = -1; primaryProjectId = null; evidenceQuote = '';
      }
    } else {
      evidenceQuote = '';
    }
    const locked = ev.attribution_locked === true;

    seen.add(postId);
    const result: Record<string, unknown> = {
      is_general_branding: item.is_general_branding === true,
      language: typeof item.language === 'string' && LANGS.has(item.language) ? item.language : 'none',
      evidence_quote: evidenceQuote,
      mentioned_projects: arr(item.mentioned_projects).map((s) => s.trim()).filter(Boolean).slice(0, 10),
    };
    if (rejected) { result.attribution_rejected = rejected; if (rejectedQuote) result.rejected_quote = rejectedQuote; }
    if (modelQuoteRejected) { result.evidence_quote_source = 'matcher'; result.model_quote_rejected = modelQuoteRejected; }
    for (const f of STR_FIELDS) result[f] = str(item[f]);
    for (const f of ARR_FIELDS) result[f] = arr(item[f]);
    if (noEvidence) {
      result.is_general_branding = false;
      result.language = 'none';
      result.mentioned_projects = [];
      for (const f of STR_FIELDS) result[f] = '';
      for (const f of ARR_FIELDS) result[f] = [];
      result.no_evidence = true;
    }

    const secondary = noEvidence ? [] : cands
      .filter((c) => c.projectId && c.projectId !== primaryProjectId && typeof c.confidence === 'number' && c.confidence >= 0.8 && c.strength !== 'word')
      .map((c) => ({ projectId: c.projectId, confidence: c.confidence as number, matched: Array.isArray(c.matchedAliases) ? c.matchedAliases : [] }));

    valid.push({ postId, primaryProjectId, evidenceQuote, result, candidates: cands, deterministicPartial: ev.deterministic_partial === true, locked, secondary });
  }

  for (const e of evidence) if (!seen.has(e.post_id)) errors.push(`post ${e.post_id}: missing from result`);
  return { valid, errors };
}
