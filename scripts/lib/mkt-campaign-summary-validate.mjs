// Pure validation of the campaign-summary Skill's JSON output against the
// evidence package. Same posture as mkt-enrichment-validate.mjs: Claude never
// writes to the DB directly — this gate enforces schema + business rules before
// the runner persists anything.
//
// The rule that matters most is `evidence_refs ⊆ this campaign's members`: it is
// what keeps a summary falsifiable. A narrative citing an id that is not in the
// campaign is either a hallucination or a mix-up between campaigns in the same
// batch, and both must fail loudly rather than be stored as intelligence.

const STR_FIELDS = ['summary_ar', 'summary_en', 'positioning', 'target_audience',
  'channel_strategy', 'offer_summary', 'activity_read'];
const ARR_FIELDS = ['messaging_themes', 'differentiators', 'caveats'];

const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v, max = 20, itemMax = 300) =>
  (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, itemMax)).slice(0, max) : []);

/** Every member id a summary is allowed to cite. */
function memberIds(ev) {
  const out = new Set();
  for (const m of Array.isArray(ev.members) ? ev.members : []) {
    if (typeof m?.post_id === 'string') out.add(m.post_id);
    if (typeof m?.ad_id === 'string') out.add(m.ad_id);
  }
  return out;
}

/**
 * @param {unknown} rawResults parsed JSON from the skill's result file
 * @param {Array<{campaign_id:string, members?:any[], member_count?:number, members_omitted?:number, siblings_omitted?:number}>} evidence
 * @returns {{ valid: Array<{campaignId:string, result:object, evidenceRefs:string[], confidence:number}>, errors: string[] }}
 */
export function validateCampaignSummaries(rawResults, evidence) {
  const errors = [];
  if (!Array.isArray(rawResults)) return { valid: [], errors: ['result is not a JSON array'] };

  const byId = new Map(evidence.map((e) => [e.campaign_id, e]));
  const seen = new Set();
  const valid = [];

  for (const item of rawResults) {
    if (!item || typeof item !== 'object') { errors.push('non-object result item'); continue; }
    const campaignId = item.campaign_id;
    const ev = typeof campaignId === 'string' ? byId.get(campaignId) : undefined;
    if (!ev) { errors.push(`unknown/missing campaign_id: ${JSON.stringify(campaignId)}`); continue; }
    if (seen.has(campaignId)) { errors.push(`duplicate campaign_id: ${campaignId}`); continue; }

    const summaryAr = str(item.summary_ar);
    const summaryEn = str(item.summary_en);
    if (!summaryAr) { errors.push(`campaign ${campaignId}: summary_ar is empty`); continue; }
    if (!summaryEn) { errors.push(`campaign ${campaignId}: summary_en is empty`); continue; }

    const conf = item.confidence;
    if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
      errors.push(`campaign ${campaignId}: confidence must be a number in [0,1] (got ${JSON.stringify(conf)})`);
      continue;
    }

    // Citations must point at real members of THIS campaign.
    const allowed = memberIds(ev);
    const refs = Array.isArray(item.evidence_refs) ? item.evidence_refs : [];
    const bad = refs.filter((r) => typeof r !== 'string' || !allowed.has(r));
    if (bad.length > 0) {
      errors.push(`campaign ${campaignId}: evidence_refs not in this campaign's members: ${bad.slice(0, 3).map((b) => JSON.stringify(b)).join(', ')}`);
      continue;
    }

    const result = {};
    for (const k of STR_FIELDS) { const s = str(item[k]); if (s) result[k] = s; }
    for (const k of ARR_FIELDS) { const a = arr(item[k]); if (a.length) result[k] = a; }
    result.is_single_item = item.is_single_item === true || (ev.member_count ?? 0) <= 1;

    // Truthfulness about our own limits: if the evidence package told the Skill
    // it was partial, the stored summary must carry that caveat even when the
    // Skill forgot to add it. Silence about a known limitation is the failure
    // mode this codebase keeps getting bitten by.
    const forced = [];
    if ((ev.members_omitted ?? 0) > 0) forced.push(`evidence covered ${ev.members_included ?? '?'} of ${ev.member_count ?? '?'} members (${ev.members_omitted} omitted)`);
    if ((ev.siblings_omitted ?? 0) > 0) forced.push(`compared against a partial sibling set (${ev.siblings_omitted} other campaigns omitted)`);
    if (forced.length) result.caveats = [...new Set([...(result.caveats ?? []), ...forced])];

    seen.add(campaignId);
    valid.push({ campaignId, result, evidenceRefs: refs, confidence: conf });
  }

  for (const e of evidence) {
    if (!seen.has(e.campaign_id)) errors.push(`missing result for campaign ${e.campaign_id}`);
  }
  return { valid, errors };
}
