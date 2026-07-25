// Pure validation of the content-enrichment Skill's JSON output against the
// evidence package. Claude never writes to the DB directly — this gate enforces
// schema + business rules (project ids must come from the post's candidate set,
// valid enums, every post answered exactly once) before the runner persists.

const LANGS = new Set(['ar', 'en', 'mixed', 'none']);
const STR_FIELDS = ['content_type', 'objective', 'offer', 'financing', 'payment_plan', 'price', 'location', 'district', 'campaign_message'];
const ARR_FIELDS = ['unit_types', 'amenities', 'selling_points', 'ctas'];

const str = (v) => (typeof v === 'string' ? v.slice(0, 500) : '');
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 20) : []);

/**
 * @param {unknown} rawResults  parsed JSON from the skill's result file
 * @param {Array<{post_id:string, candidates:Array<{projectId:string,confidence?:number}>, deterministic_partial?:boolean}>} evidence
 * @returns {{ valid: Array<{postId:string, primaryProjectId:string|null, result:object, candidates:any[], deterministicPartial:boolean, secondary:Array<{projectId:string,confidence:number,matched:string[]}>}>, errors: string[] }}
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
    const idx = item.primary_project_index;
    if (!Number.isInteger(idx) || idx < -1 || idx >= cands.length) {
      errors.push(`post ${postId}: primary_project_index out of range (${JSON.stringify(idx)}, candidates=${cands.length})`);
      continue;
    }
    const primaryProjectId = idx >= 0 ? cands[idx]?.projectId ?? null : null;
    if (idx >= 0 && !primaryProjectId) { errors.push(`post ${postId}: candidate[${idx}] has no projectId`); continue; }

    seen.add(postId);
    const result = {
      is_general_branding: item.is_general_branding === true,
      language: LANGS.has(item.language) ? item.language : 'none',
    };
    for (const f of STR_FIELDS) result[f] = str(item[f]);
    for (const f of ARR_FIELDS) result[f] = arr(item[f]);

    // secondary attributions: strong deterministic candidates (not the primary)
    const secondary = cands
      .filter((c) => c.projectId && c.projectId !== primaryProjectId && typeof c.confidence === 'number' && c.confidence >= 0.8)
      .map((c) => ({ projectId: c.projectId, confidence: c.confidence, matched: Array.isArray(c.matchedAliases) ? c.matchedAliases : [] }));

    valid.push({ postId, primaryProjectId, result, candidates: cands, deterministicPartial: ev.deterministic_partial === true, secondary });
  }

  // every evidence post must be answered exactly once
  for (const e of evidence) if (!seen.has(e.post_id)) errors.push(`post ${e.post_id}: missing from result`);

  return { valid, errors };
}

/** Detect a Claude subscription/usage-limit condition in a session's output. */
export function isSubscriptionLimit(text) {
  return /usage limit|rate limit|reached your .*limit|5-hour limit|too many requests|please try again later|approaching .*limit/i.test(text || '');
}
