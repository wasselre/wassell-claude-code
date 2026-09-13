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

const LANGS = new Set(['ar', 'en', 'mixed', 'none']);
const STR_FIELDS = ['content_type', 'objective', 'offer', 'financing', 'payment_plan', 'price', 'location', 'district', 'campaign_message'];
const ARR_FIELDS = ['unit_types', 'amenities', 'selling_points', 'ctas'];

const str = (v) => (typeof v === 'string' ? v.slice(0, 500) : '');
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 20) : []);

/** Same folding as the worker's normalizeAr: NFKC, strip tatweel + harakat,
 *  fold hamza forms / alef maqsura / ta marbuta, underscores → spaces, lowercase,
 *  and collapse whitespace so a quote copied across a line break still matches. */
export function normalizeText(s) {
  return (s ?? '')
    .normalize('NFKC')
    .replace(/[ـً-ْ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Name tokens of a candidate that can anchor a quote: words ≥3 chars and
 *  numbers, minus the publisher's brand tokens. */
function anchorTokens(candidate, brandTokens) {
  const out = new Set();
  const brand = new Set((brandTokens ?? []).map((t) => normalizeText(t)));
  for (const raw of [candidate?.nameAr, candidate?.nameEn, ...(Array.isArray(candidate?.matchedAliases) ? candidate.matchedAliases : [])]) {
    if (typeof raw !== 'string') continue;
    for (const w of normalizeText(raw).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(' ')) {
      if (!w) continue;
      if (/^\d+$/.test(w)) { if (w.length >= 2) out.add(w); continue; }
      if (w.length >= 3 && !brand.has(w)) out.add(w);
    }
  }
  return out;
}

/**
 * Why a project pick is not acceptable, or null when it is.
 * @param {string} quote            skill's evidence_quote
 * @param {object} candidate        chosen candidate {nameAr,nameEn,matchedAliases,strength}
 * @param {object} ev               evidence post {caption,transcript,ocr_text,brand_tokens}
 */
export function attributionRejection(quote, candidate, ev) {
  if (typeof quote !== 'string' || quote.trim().length < 6) return 'no evidence_quote';
  if (quote.length > 300) return 'evidence_quote too long';
  const nq = normalizeText(quote);
  const hay = normalizeText(`${ev?.caption ?? ''}\n${ev?.transcript ?? ''}\n${ev?.ocr_text ?? ''}`);
  if (!hay.includes(nq)) return 'evidence_quote not found verbatim in the evidence';
  const anchors = anchorTokens(candidate, ev?.brand_tokens);
  if (anchors.size === 0) {
    // the project name is nothing but the brand word(s) — a phrase-level
    // match of the whole name is the only acceptable proof
    const full = normalizeText(candidate?.nameAr ?? candidate?.nameEn ?? '');
    return full && nq.includes(full) ? null : 'quote carries only the brand word';
  }
  const hits = [...anchors].filter((a) => new RegExp(`(^|[^\\p{L}\\p{N}])(?:[وبلفك]|لل)?${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'u').test(nq));
  // a weak (lone-word) candidate with a multi-word name needs two anchors or a number
  const need = candidate?.strength === 'word' && anchors.size >= 2 ? 2 : 1;
  if (hits.length < need) return `quote does not name the project (${hits.length}/${need} name tokens)`;
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

    // the mechanical proof check
    let rejected = null;
    let evidenceQuote = typeof item.evidence_quote === 'string' ? item.evidence_quote.slice(0, 300) : '';
    if (idx >= 0) {
      rejected = attributionRejection(evidenceQuote, cands[idx], ev);
      if (rejected) { idx = -1; primaryProjectId = null; evidenceQuote = ''; }
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
    if (rejected) result.attribution_rejected = rejected;
    for (const f of STR_FIELDS) result[f] = str(item[f]);
    for (const f of ARR_FIELDS) result[f] = arr(item[f]);

    // secondary attributions: strong deterministic candidates (not the primary)
    const secondary = cands
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
