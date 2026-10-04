// Pure validation of the content-enrichment Skill's JSON output against the
// evidence package. Claude never writes to the DB directly — this gate enforces
// schema + business rules (project ids must come from the post's candidate set,
// valid enums, every post answered exactly once) before the runner persists.
//
// 2026-09-13 — the attribution rule is now MECHANICAL, not a prompt request:
// a project pick must come with `evidence_quote`, a verbatim excerpt of the
// caption / transcript / OCR that contains the chosen project's own name (or
// number) and not merely the publisher's brand word. A pick that fails the
// check is downgraded to "no project" and the reason is recorded on the result
// (`attribution_rejected`), so the batch still persists and the failure is
// visible instead of silently accepted. Measured before this: on brand-only
// candidate sets the model picked 219 times and declined 191 — a coin flip.
//
// 2026-10-03 — an audit found the check REJECTING correct links: a number
// glued to the next word («مكين 63حي العارض»), Arabic-Indic digits, a generic
// word («شقق») demanded as a second name token, and a strong matcher hit thrown
// away because the model's own quote was empty. It also found an image post
// with no caption, OCR or transcript stored as confident 'brand'. Fixed below.

const LANGS = new Set(['ar', 'en', 'mixed', 'none']);
const STR_FIELDS = ['content_type', 'objective', 'offer', 'financing', 'payment_plan', 'price', 'location', 'district', 'campaign_message'];
const ARR_FIELDS = ['unit_types', 'amenities', 'selling_points', 'ctas'];

const str = (v) => (typeof v === 'string' ? v.slice(0, 500) : '');
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 20) : []);

/** Same folding as the worker's normalizeAr: NFKC, strip tatweel + harakat,
 *  fold hamza forms / alef maqsura / ta marbuta, underscores → spaces, lowercase,
 *  and collapse whitespace so a quote copied across a line break still matches.
 *  Arabic-Indic (٠-٩) and Persian (۰-۹) digits fold to ASCII — NFKC leaves them
 *  alone, so a quote «مكين ٦٣» could not be found in OCR text «مكين 63». */
export function normalizeText(s) {
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

/**
 * Real-estate words that name a KIND of thing, not a project. COPY of
 * GENERIC_TOKENS in worker/src/marketing/pipeline.ts — this script cannot import
 * across packages. Keep the two in sync; the test reads the worker file and
 * fails when an entry is missing here. Without it «شقق» counted as a second
 * name token of «شقق سماوة», and the correct quote «تغطية للوحدة المؤثثة في
 * سماوة» was rejected for naming 1 of 2.
 */
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

const nameSources = (candidate) => [candidate?.nameAr, candidate?.nameEn, ...(Array.isArray(candidate?.matchedAliases) ? candidate.matchedAliases : [])];
const brandSet = (ev) => new Set((ev?.brand_tokens ?? []).map((t) => normalizeText(t)));
/** Punctuation → spaces, so «ريفييرا-58» and «ريفييرا 58» are the same phrase. */
const flatten = (s) => s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Name tokens of a candidate that can anchor a quote: words ≥3 chars and
 *  numbers, minus the publisher's brand tokens and generic real-estate words. */
function anchorTokens(candidate, brand) {
  const out = new Set();
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

/**
 * The project's whole-name phrases, derived the way the worker's
 * projectNameVariants does: every name and alias, each parenthesised alternate
 * («الماجدية فيلج (Al Majdiah Village)» → «al majdiah village»), and the part
 * before a « - » / « | » separator when it has ≥2 words («سديم تاون - شقق» →
 * «سديم تاون»). Normalised and flattened.
 */
function nameVariants(candidate) {
  const out = new Set();
  const add = (v) => { const c = flatten(v); if (c.length >= 3) out.add(c); };
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

/**
 * The quote carries one of the project's whole-name phrases. That names the
 * project even when no single anchor does: a name made of brand + generic words
 * («الماجدية فيلج», «سديم تاون», «أدوار - يمام 9») has no anchor left once those
 * words are dropped, and an Arabic quote cannot hit the anchors of its English
 * alternate («majdiah»). Two guards keep the brand trap shut: a phrase must be
 * ≥2 words (a lone word is the weak 'word' rule's business), and it must carry
 * something besides the brand — a number or a ≥3-letter non-brand word — so
 * «Al Majdiah» alone never names «Al Majdiah Village».
 */
function quoteNamesWholeVariant(nq, candidate, brand) {
  const flatQuote = flatten(nq);
  return nameVariants(candidate).some((v) => {
    const words = v.split(' ');
    if (words.length < 2) return false;
    if (!words.some((w) => /^\d+$/.test(w) || (w.length >= 3 && !brand.has(w)))) return false;
    return boundedRe(v).test(flatQuote);
  });
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A normalised token or phrase present as a whole unit. An edge WORD that is a
 *  number needs only a non-digit beside it — the worker matcher's number rule —
 *  because captions glue numbers to the word on either side: «مكين 63حي
 *  العارض» and «مكين63» name 63, «1963» does not. Any other edge word, a mixed
 *  one like «b12» included, needs a non-letter/digit, after an optional
 *  attached prefix letter (بمكين، للماجدية): «b12x» is not «b12». */
function boundedRe(s) {
  const words = s.split(' ');
  const left = /^\d+$/.test(words[0]) ? '(?:^|\\D)' : '(?:^|[^\\p{L}\\p{N}])(?:[وبلفك]|لل)?';
  const right = /^\d+$/.test(words[words.length - 1]) ? '(?=$|\\D)' : '(?=$|[^\\p{L}\\p{N}])';
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
const despace = (s) => s.replace(/\s+/g, '');
/** The word with its internal long vowels (ا و ي) removed; first letter kept. */
const skeleton = (w) => w.slice(0, 1) + w.slice(1).replace(/[اوي]/g, '');
function fuzzyHit(anchor, nq) {
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

const evidenceText = (ev) => normalizeText(`${ev?.caption ?? ''}\n${ev?.transcript ?? ''}\n${ev?.ocr_text ?? ''}`);

/**
 * Why a project pick is not acceptable, or null when it is.
 * @param {string} quote            skill's evidence_quote
 * @param {object} candidate        chosen candidate {nameAr,nameEn,matchedAliases,strength}
 * @param {object} ev               evidence post {caption,transcript,ocr_text,brand_tokens}
 */
export function attributionRejection(quote, candidate, ev) {
  return proofRejection(quote, candidate, ev, 6);
}

/** attributionRejection with the minimum quote length as a parameter: a quote
 *  the model wrote must be a real excerpt (≥6 chars), but a matcher alias used
 *  as the quote may be as short as «174» — every other rule still applies. */
function proofRejection(quote, candidate, ev, minLength) {
  if (typeof quote !== 'string' || quote.trim().length < Math.max(1, minLength)) return 'no evidence_quote';
  if (quote.length > 300) return 'evidence_quote too long';
  const nq = normalizeText(quote);
  if (!evidenceText(ev).includes(nq)) return 'evidence_quote not found verbatim in the evidence';
  const brand = brandSet(ev);
  if (quoteNamesWholeVariant(nq, candidate, brand)) return null;
  const anchors = anchorTokens(candidate, brand);
  if (anchors.size === 0) {
    // the project name is nothing but brand / generic word(s) and no
    // whole-name phrase above matched — the raw name verbatim is the last
    // acceptable proof (a project named exactly its brand, «عزوم»)
    const full = normalizeText(candidate?.nameAr ?? candidate?.nameEn ?? '');
    return full && nq.includes(full) ? null : 'quote carries only the brand word';
  }
  const hits = [...anchors].filter((a) => boundedRe(a).test(nq) || fuzzyHit(a, nq));
  // a weak (lone-word) candidate with a multi-word name needs two anchors or a number
  const need = candidate?.strength === 'word' && anchors.size >= 2 ? 2 : 1;
  if (hits.length < need) return `quote does not name the project (${hits.length}/${need} name tokens)`;
  return null;
}

/**
 * The matcher's own alias as the proof, for a STRONG candidate (whole name or
 * project number) the model picked but quoted badly or not at all — rejecting
 * that pick threw away a link the matcher had already proven. The alias must
 * occur in the evidence as a whole phrase (not inside a longer word or number:
 * «174» inside «1745» is not the project) and pass the same anchor rule as a
 * model quote. A weak 'word' candidate is never upgraded: a lone word is a hint.
 * @returns {string|null} the alias to store as the quote
 */
function matcherQuote(candidate, ev) {
  if (candidate?.strength !== 'full_name' && candidate?.strength !== 'number') return null;
  const hay = evidenceText(ev);
  // A numbered project is identified by its number. A matcher alias that drops
  // it («ادوار يمام» for «أدوار - يمام 9», from a post about يمام 16) proves the
  // series, not the project — 260 such candidates existed on 2026-10-03.
  const nameNums = (normalizeText(`${candidate?.nameAr ?? ''} ${candidate?.nameEn ?? ''}`).match(/\d+/g)) ?? [];
  for (const alias of Array.isArray(candidate?.matchedAliases) ? candidate.matchedAliases : []) {
    if (typeof alias !== 'string' || !alias.trim()) continue;
    const quote = alias.trim();
    if (nameNums.length > 0 && !nameNums.some((n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(normalizeText(quote)))) continue;
    if (!boundedRe(normalizeText(quote)).test(hay)) continue;
    if (proofRejection(quote, candidate, ev, 1) === null) return quote;
  }
  return null;
}

/**
 * @param {unknown} rawResults  parsed JSON from the skill's result file
 * @param {Array<{post_id:string, candidates:Array<{projectId:string,confidence?:number}>, deterministic_partial?:boolean, attribution_locked?:boolean, brand_tokens?:string[]}>} evidence
 * @returns {{ valid: Array<{postId:string, primaryProjectId:string|null, evidenceQuote:string, result:object, candidates:any[], deterministicPartial:boolean, locked:boolean, secondary:Array<{projectId:string,confidence:number,matched:string[]}>}>, errors: string[] }}
 */
export function validateEnrichmentResults(rawResults, evidence) {
  const errors = [];
  if (!Array.isArray(rawResults)) return { valid: [], errors: ['result is not a JSON array'] };
  const byId = new Map(evidence.map((e) => [e.post_id, e]));
  const seen = new Set();
  const valid = [];

  for (const item of rawResults) {
    if (!item || typeof item !== 'object') { errors.push('non-object result item'); continue; }
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
    let primaryProjectId = idx >= 0 ? cands[idx]?.projectId ?? null : null;
    if (idx >= 0 && !primaryProjectId) { errors.push(`post ${postId}: candidate[${idx}] has no projectId`); continue; }

    // Nothing to read at all. Real case: an image post with an empty caption,
    // no OCR and no transcript was stored as content_type 'brand',
    // is_general_branding true — a confident label resting on nothing.
    const noEvidence = ![ev.caption, ev.transcript, ev.ocr_text].some((t) => typeof t === 'string' && t.trim() !== '');

    // the mechanical proof check
    let rejected = null;
    let modelQuoteRejected = null;
    let rejectedQuote = '';
    let evidenceQuote = typeof item.evidence_quote === 'string' ? item.evidence_quote.slice(0, 300) : '';
    if (idx >= 0) {
      rejected = noEvidence ? 'post has no evidence (caption, transcript and OCR are empty)' : attributionRejection(evidenceQuote, cands[idx], ev);
      // The model's quote proves a DIFFERENT candidate than its index: it meant
      // that one and mis-indexed («عن مشروع ريفييرا المربع» with the index of
      // «ريفييرا 58», both in the post). The answer contradicts itself, so the
      // matcher alias must not settle it in favour of the index — that would
      // auto-accept the project the model's own words point away from.
      const quoteNames = rejected && !noEvidence
        ? cands.findIndex((c, j) => j !== idx && c?.projectId && c.projectId !== primaryProjectId && attributionRejection(evidenceQuote, c, ev) === null)
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
    const result = {
      is_general_branding: item.is_general_branding === true,
      language: LANGS.has(item.language) ? item.language : 'none',
      evidence_quote: evidenceQuote,
      mentioned_projects: arr(item.mentioned_projects).map((s) => s.trim()).filter(Boolean).slice(0, 10),
    };
    if (rejected) { result.attribution_rejected = rejected; if (rejectedQuote) result.rejected_quote = rejectedQuote; }
    // the pick stands on the matcher's alias; the model's own quote failed and
    // why is kept, so the audit can still see how often the model mis-quotes
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

    // secondary attributions: strong deterministic candidates (not the primary).
    // None on a post with no evidence — a candidate there cannot have come from it.
    const secondary = noEvidence ? [] : cands
      .filter((c) => c.projectId && c.projectId !== primaryProjectId && typeof c.confidence === 'number' && c.confidence >= 0.8 && c.strength !== 'word')
      .map((c) => ({ projectId: c.projectId, confidence: c.confidence, matched: Array.isArray(c.matchedAliases) ? c.matchedAliases : [] }));

    valid.push({ postId, primaryProjectId, evidenceQuote, result, candidates: cands, deterministicPartial: ev.deterministic_partial === true, locked, secondary });
  }

  // every evidence post must be answered exactly once
  for (const e of evidence) if (!seen.has(e.post_id)) errors.push(`post ${e.post_id}: missing from result`);

  return { valid, errors };
}

/** Detect a Claude subscription/usage-limit condition in a session's output. */
export function isSubscriptionLimit(text) {
  return /usage limit|rate limit|reached your .*limit|5-hour limit|too many requests|please try again later|approaching .*limit/i.test(text || '');
}
