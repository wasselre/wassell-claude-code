#!/usr/bin/env node
/**
 * scripts/eval/build-eval-sets.mjs
 * ----------------------------------------------------------------------------
 * Builds the two golden inputs of the eval harness FROM THE LIVE DATABASE:
 *
 *   docs/eval/script-eval-set.json   20 script-writer briefs (curated project ×
 *                                    recipe pairs; `expected` derived from the
 *                                    live all_projects record at build time)
 *   docs/eval/cv-golden-30.json      30 stored competitor videos for the shot-
 *                                    boundary / ingest / search gates (chosen by
 *                                    a deterministic quota fill, so re-runs are
 *                                    stable unless the underlying media changes)
 *
 * Re-run whenever the project facts change (prices, availability) so the
 * `expected.hard_facts` stay honest. Human labels already in cv-golden-30.json
 * (`boundaries_ms`, `labeling_status`) and machine pseudo-labels
 * (`pseudo_boundaries_ms`) are PRESERVED across re-runs for videos that stay
 * in the set.
 *
 *   node scripts/eval/build-eval-sets.mjs            # both
 *   node scripts/eval/build-eval-sets.mjs --script   # only the script set
 *   node scripts/eval/build-eval-sets.mjs --cv       # only the cv golden set
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local). Throws loudly on
 * any DB error or on a curated project id that no longer exists.
 * ----------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { serviceClient, pageAll, parseArgs, ROOT } from './_lib/env.mjs';

const ALL_PROJECTS_MODEL = '220c49b9-de57-492d-9eca-c0d9f54fd40f';
const MARKETERS_MODEL = '37f4905c-bc64-4993-a0c4-07e4f54463e2';
const DEVELOPERS_MODEL = '11bade2c-7da9-4d00-b045-eaab37153da2';
const OUT_DIR = join(ROOT, 'docs', 'eval');

const args = parseArgs();
const doScript = args.script || (!args.script && !args.cv);
const doCv = args.cv || (!args.script && !args.cv);
const sb = serviceClient('build-eval-sets');

// ── Script eval set ─────────────────────────────────────────────────────────
// Curated (project, recipe) pairs. Each recipe appears exactly 4×. The mix is
// deliberate: off-plan (available_on_map / under_construction), ready
// (available + construction ready), one sold-out, one status conflict, one
// unknown, one UAE (AED) project. Two briefs are bound to the only two real
// video content items in mos_content that carry a project_id (V-041 / V-042 →
// أكنان 25); every other brief has content_id = null and the harness
// SYNTHESISES the brief from the project record (see docs/eval/README.md).
const CURATED = [
  // walkthrough ×4
  { id: 'S01', project_id: 'aab86347-e139-4ebd-b481-5282293c8eea', content_id: '30eb4c0e-b3bf-4ecb-9236-9216271dab24', recipe: 'walkthrough', duration_sec: 45, why: 'أكنان 25 — ready; the real V-041 content item' },
  { id: 'S02', project_id: '95c0edd3-1d85-4149-b050-72edf35ee302', content_id: null, recipe: 'walkthrough', duration_sec: 45, why: 'شقق سماوة — ready, 5 of 9 available, 12 features, 9 guarantees' },
  { id: 'S03', project_id: '5ca5502f-dbd9-466d-85a8-a215c2ddcc18', content_id: null, recipe: 'walkthrough', duration_sec: 60, why: 'الماجدية 178 — off-plan (renders walkthrough), 120 units' },
  { id: 'S04', project_id: 'eb781575-3844-4817-aad6-c71d369dbf2f', content_id: null, recipe: 'walkthrough', duration_sec: 45, why: 'دروازة — ready, mixed AR/EN name' },
  // offer ×4
  { id: 'S05', project_id: 'eeeea025-41bf-4736-9283-dd2c83fd37fb', content_id: null, recipe: 'offer', duration_sec: 30, why: 'المشرقية 2 — 468 units, ONE left (real scarcity)' },
  { id: 'S06', project_id: 'ac48b23f-bc99-4bd1-b9fd-b245e47f4372', content_id: null, recipe: 'offer', duration_sec: 30, why: 'اوتوجراف 21 — 1 of 21 left, single price point' },
  { id: 'S07', project_id: 'e27d0887-f193-4ff4-b6c3-0932b8229340', content_id: null, recipe: 'offer', duration_sec: 30, why: 'يمام 8 — SOLD OUT (12/0, no available price): offer requires price → expected facts_insufficient refusal' },
  { id: 'S08', project_id: '93181558-b673-4cb1-83b6-c738c41b1f21', content_id: null, recipe: 'offer', duration_sec: 30, why: 'سديم فلل — STATUS CONFLICT: project_status=sold_out but 16 units available with a price' },
  // rent_vs_own ×4
  { id: 'S09', project_id: '384a2b68-1b68-47d3-ade8-c60923ea3c21', content_id: null, recipe: 'rent_vs_own', duration_sec: 40, why: 'صفا 80 — ready, 31 units' },
  { id: 'S10', project_id: 'ff658a62-fa27-424d-9c34-e56d7a9ef350', content_id: null, recipe: 'rent_vs_own', duration_sec: 40, why: 'ستون الندى — off-plan, 138 units' },
  { id: 'S11', project_id: 'b83566e6-683d-49f0-a4a7-9e3bbab48282', content_id: null, recipe: 'rent_vs_own', duration_sec: 40, why: 'يمام 15 — ready floors' },
  { id: 'S12', project_id: '93d521e4-f4cf-4400-9d95-739351f32507', content_id: null, recipe: 'rent_vs_own', duration_sec: 40, why: 'ريا النخيل — ready apartments, 32 of 52 available' },
  // product_explainer ×4
  { id: 'S13', project_id: 'aab86347-e139-4ebd-b481-5282293c8eea', content_id: 'ef573714-325d-4079-87a6-72397148b36f', recipe: 'product_explainer', duration_sec: 45, why: 'أكنان 25 — the real V-042 content item' },
  { id: 'S14', project_id: 'd14c1370-0852-4c4d-8245-e61b3d8ac003', content_id: null, recipe: 'product_explainer', duration_sec: 45, why: 'ربوة الرمز — off-plan, wide price band' },
  { id: 'S15', project_id: '36611f3e-891b-40f8-b3b7-68eeddcbe611', content_id: null, recipe: 'product_explainer', duration_sec: 45, why: 'ساندستون ريزيدنسيز — ready, premium (3.8–4.2M)' },
  { id: 'S16', project_id: '8ab23ab5-85d2-4695-9482-41d45a14bfd7', content_id: null, recipe: 'product_explainer', duration_sec: 45, why: 'بن غاطي سكاي رايز — UAE, AED developer currency, off-plan' },
  // launch ×4
  { id: 'S17', project_id: '3117ab2a-f50a-4c48-ae4b-fca6b6ed68bb', content_id: null, recipe: 'launch', duration_sec: 40, why: 'ستون الملقا — off-plan, 17 landmarks, 12 guarantees' },
  { id: 'S18', project_id: 'bd4c49b0-49c9-4157-8592-570d73efa941', content_id: null, recipe: 'launch', duration_sec: 40, why: 'تل الربوة — off-plan, entry price < 1M' },
  { id: 'S19', project_id: '7c0211b8-97e2-4694-9718-63d48564b7cc', content_id: null, recipe: 'launch', duration_sec: 40, why: 'صفا 82 — off-plan, 119 units' },
  { id: 'S20', project_id: 'bf518a3c-62f7-41c5-9621-f40813d4725c', content_id: null, recipe: 'launch', duration_sec: 40, why: 'ديارا مشارف — project_status=unknown but construction_status=ready → the readiness rule must resolve to ready from construction alone' },
];

const OFF_PLAN_STATUSES = new Set(['available_on_map', 'under_construction', 'upcoming']);
const PHONE_RE = /(?:\+?966|0)5\d{8}|\b05\d(?:[\s-]?\d){7}\b|\+971\s?5\d[\d\s-]{7,}/g;

/**
 * Readiness rule used for `expected.readiness` (documented in README):
 *   sold_out  = project_status='sold_out' OR (unit_count>0 AND available_units=0)
 *   conflict  = off-plan status with construction_status='ready'
 *               OR project_status='sold_out' with available_units>0
 *   off_plan  = project_status ∈ {available_on_map, under_construction, upcoming}
 *   ready     = project_status='available' OR construction_status='ready'
 *   unknown   = anything else (incl. project_status='unknown')
 * This is the EXPECTATION the facts builder is judged against; if W-SCRIPT's
 * facts.ts encodes a different rule the harness reports the disagreement.
 */
function deriveReadiness(d) {
  const ps = d.project_status || '';
  const cs = d.construction_status || '';
  const units = Number(d.unit_count) || 0;
  const avail = d.available_units == null ? null : Number(d.available_units);
  const sold_out = ps === 'sold_out' || (units > 0 && avail === 0);
  let readiness;
  if ((OFF_PLAN_STATUSES.has(ps) && cs === 'ready') || (ps === 'sold_out' && avail != null && avail > 0)) readiness = 'conflict';
  else if (OFF_PLAN_STATUSES.has(ps)) readiness = 'off_plan';
  else if (ps === 'available' || cs === 'ready') readiness = 'ready';
  else readiness = 'unknown';
  return { readiness, sold_out };
}

function range(r) {
  if (!r || typeof r !== 'object') return null;
  const min = Number(r.min), max = Number(r.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

async function buildScriptSet() {
  const projects = await pageAll((a, b) => sb.from('unified_records').select('id,data,updated_at').eq('model_id', ALL_PROJECTS_MODEL).range(a, b));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const marketers = new Map((await pageAll((a, b) => sb.from('unified_records').select('id,data').eq('model_id', MARKETERS_MODEL).range(a, b))).map((r) => [r.id, r.data]));
  const developers = new Map((await pageAll((a, b) => sb.from('unified_records').select('id,data').eq('model_id', DEVELOPERS_MODEL).range(a, b))).map((r) => [r.id, r.data]));
  const { data: content, error } = await sb.from('mos_content_v').select('id,ref,title,project_id,content_type_key,language').not('project_id', 'is', null);
  if (error) throw new Error(`mos_content_v: ${error.message}`);
  const contentById = new Map(content.map((c) => [c.id, c]));

  const entries = CURATED.map((c) => {
    const row = byId.get(c.project_id);
    if (!row) throw new Error(`Curated project ${c.id} (${c.project_id}) not found in all_projects — pick a replacement`);
    const d = row.data;
    if (c.content_id) {
      const ci = contentById.get(c.content_id);
      if (!ci) throw new Error(`Curated content ${c.content_id} for ${c.id} no longer exists`);
      if (ci.project_id !== c.project_id) throw new Error(`Content ${ci.ref} now points at ${ci.project_id}, not ${c.project_id}`);
    }
    const { readiness, sold_out } = deriveReadiness(d);

    // Entities that must NEVER appear in a script: the marketer's name/phone
    // if the record has a marketer, the developer's phone/email (developer
    // NAME is allowed per script_writer_rules.allow_developer_name), and any
    // phone number found in the record's free-text fields.
    const must_not_contain = [];
    if (d.marketer) {
      const m = marketers.get(d.marketer);
      if (m?.name) must_not_contain.push(m.name);
      if (m?.phone) must_not_contain.push(String(m.phone));
    }
    const dev = d.developer ? developers.get(d.developer) : null;
    if (dev?.phone) must_not_contain.push(String(dev.phone));
    if (dev?.email) must_not_contain.push(String(dev.email));
    const freeText = [d.project_analysis, d.marketing_document, d.source_notes, d.internal_sales_notes, d.objection_handling_notes, d.payment_plan_summary, d.ai_audit_notes].filter(Boolean).join('\n');
    for (const ph of freeText.match(PHONE_RE) || []) if (!must_not_contain.includes(ph)) must_not_contain.push(ph);

    const feats = Array.isArray(d.features) ? d.features.map((f) => f?.feature).filter(Boolean) : [];
    const landmarks = Array.isArray(d.nearby_landmarks) ? d.nearby_landmarks.map((l) => l?.landmark || l?.name).filter(Boolean) : [];
    return {
      id: c.id,
      project_id: c.project_id,
      project_name: d.project_name,
      developer_name: dev?.name ?? null,
      content_id: c.content_id,
      content_ref: c.content_id ? contentById.get(c.content_id).ref : null,
      recipe: c.recipe,
      duration_sec: c.duration_sec,
      why: c.why,
      expected: {
        readiness,
        sold_out,
        project_status: d.project_status ?? null,
        construction_status: d.construction_status ?? null,
        must_not_contain,
        hard_facts: {
          currency: d.developer_currency || 'SAR',
          price: range(d.available_price_range),
          price_all_units: range(d.price_range),
          area: range(d.available_area_range),
          area_all_units: range(d.area_range),
          unit_count: d.unit_count ?? null,
          available_units: d.available_units ?? null,
          sold_units: d.sold_units ?? null,
          unit_types: Array.isArray(d.unit_types) ? d.unit_types : [],
          handover_date: d.handover_date ?? null,
          features: feats,
          landmarks,
        },
        // Sold-out + offer/rent_vs_own recipes REQUIRE a price → the pipeline
        // must refuse with `facts_insufficient:` rather than invent one.
        expect_pipeline_refusal: sold_out && !range(d.available_price_range) && ['offer', 'rent_vs_own'].includes(c.recipe),
      },
      snapshot: { project_updated_at: row.updated_at },
    };
  });

  const out = {
    _generated_by: 'scripts/eval/build-eval-sets.mjs',
    generated_at: new Date().toISOString(),
    readiness_rule: 'see deriveReadiness() in scripts/eval/build-eval-sets.mjs and docs/eval/README.md',
    synthesised_brief_note: 'Entries with content_id=null have no mos_content row; the harness passes {content_id:null, project_id, recipe, duration_sec} and runScriptEval must build the brief from the project record alone (language ar, purpose unknown, cta = Wassel default, no existing scenes).',
    counts: {
      by_recipe: count(entries, (e) => e.recipe),
      by_readiness: count(entries, (e) => e.expected.readiness),
      sold_out: entries.filter((e) => e.expected.sold_out).length,
      with_content_id: entries.filter((e) => e.content_id).length,
    },
    entries,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'script-eval-set.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('script-eval-set.json:', JSON.stringify(out.counts));
}

// ── CV golden 30 ────────────────────────────────────────────────────────────
const CV_TYPES = ['walkthrough', 'project_launch', 'offer', 'teaser', 'brand', 'event'];
const TYPE_QUOTA = { walkthrough: 7, project_launch: 6, offer: 4, teaser: 4, brand: 5, event: 4 }; // = 30
const PLATFORM_CAP = { instagram: 12, tiktok: 10, youtube: 8 };
const ORG_CAP = 6;
const SILENT_TARGET = 10; // ≥ this many with an EMPTY transcript
const BUCKETS = [[10000, 30000], [30001, 60000], [60001, 120000]];
const BUCKET_CAP = 12;
const MAX_BYTES = 50 * 1024 * 1024;

const stableKey = (id) => createHash('sha1').update(id).digest('hex');
const bucketOf = (ms) => BUCKETS.findIndex(([lo, hi]) => ms >= lo && ms <= hi);

async function buildCvGolden() {
  const media = await pageAll((a, b) => sb.from('mkt_content_media')
    .select('id,content_post_id,stored_url,duration_ms,bytes,width,height,mime_type,mkt_content_posts(id,platform,post_type,organization_id,published_at,post_url,mkt_organizations(name_ar,name_en,org_type),mkt_content_enrichment(result))')
    .eq('media_kind', 'video').eq('download_status', 'stored').not('stored_url', 'is', null).range(a, b));
  const tx = await pageAll((a, b) => sb.from('mkt_transcripts').select('content_media_id,language,text').eq('status', 'done').range(a, b));
  const txByMedia = new Map(tx.map((t) => [t.content_media_id, t]));

  const cands = media
    .map((m) => {
      const p = m.mkt_content_posts;
      const enr = Array.isArray(p?.mkt_content_enrichment) ? p.mkt_content_enrichment[0] : p?.mkt_content_enrichment;
      const t = txByMedia.get(m.id);
      const transcriptLen = (t?.text || '').trim().length;
      return {
        content_media_id: m.id,
        content_post_id: m.content_post_id,
        stored_url: m.stored_url,
        duration_ms: m.duration_ms,
        bytes: m.bytes,
        width: m.width,
        height: m.height,
        platform: p?.platform,
        post_type: p?.post_type,
        post_url: p?.post_url,
        published_at: p?.published_at,
        organization_id: p?.organization_id,
        org: p?.mkt_organizations?.name_en || p?.mkt_organizations?.name_ar || null,
        org_ar: p?.mkt_organizations?.name_ar || null,
        content_type: enr?.result?.content_type ?? null,
        language: enr?.result?.language ?? t?.language ?? null,
        has_transcript: transcriptLen > 0,
        transcript_chars: transcriptLen,
      };
    })
    .filter((c) => c.duration_ms >= 10000 && c.duration_ms <= 120000 && c.bytes > 0 && c.bytes <= MAX_BYTES && CV_TYPES.includes(c.content_type) && c.platform in PLATFORM_CAP && c.org)
    .sort((a, b) => stableKey(a.content_media_id).localeCompare(stableKey(b.content_media_id)));

  const picked = [];
  const used = { type: {}, platform: {}, org: {}, bucket: {}, silent: 0, voiced: 0 };
  const inc = (k, v) => { used[k][v] = (used[k][v] || 0) + 1; };
  const fits = (c, relax) => {
    if ((used.type[c.content_type] || 0) >= TYPE_QUOTA[c.content_type]) return false;
    if ((used.platform[c.platform] || 0) >= PLATFORM_CAP[c.platform]) return false;
    if ((used.org[c.org] || 0) >= (relax >= 2 ? ORG_CAP + 2 : ORG_CAP)) return false;
    if (relax < 2 && (used.bucket[bucketOf(c.duration_ms)] || 0) >= BUCKET_CAP) return false;
    if (relax === 0) {
      if (!c.has_transcript && used.silent >= SILENT_TARGET) return false;
      if (c.has_transcript && used.voiced >= 30 - SILENT_TARGET) return false;
    }
    return true;
  };
  // relax 0: all quotas; 1: drop the silent/voiced split; 2: also drop the
  // duration-bucket cap and allow +2 per org (the type quota + platform caps
  // are never relaxed — they define the set's shape).
  for (const relax of [0, 1, 2]) {
    for (const c of cands) {
      if (picked.length >= 30) break;
      if (picked.some((p) => p.content_media_id === c.content_media_id) || !fits(c, relax)) continue;
      picked.push(c);
      inc('type', c.content_type); inc('platform', c.platform); inc('org', c.org); inc('bucket', bucketOf(c.duration_ms));
      if (c.has_transcript) used.voiced++; else used.silent++;
    }
  }
  if (picked.length < 30) throw new Error(`Only ${picked.length} candidates satisfied the quotas — loosen TYPE_QUOTA/PLATFORM_CAP in build-eval-sets.mjs`);
  const orgs = new Set(picked.map((p) => p.org));
  if (orgs.size < 6) throw new Error(`Only ${orgs.size} organisations in the pick — need ≥ 6`);

  // Preserve human + machine labels for videos that survive a rebuild.
  const outPath = join(OUT_DIR, 'cv-golden-30.json');
  const prev = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;
  const prevById = new Map((prev?.videos || []).map((v) => [v.content_media_id, v]));

  const videos = picked
    .sort((a, b) => a.duration_ms - b.duration_ms)
    .map((c, i) => {
      const old = prevById.get(c.content_media_id);
      return {
        golden_id: `G${String(i + 1).padStart(2, '0')}`,
        content_media_id: c.content_media_id,
        content_post_id: c.content_post_id,
        stored_url: c.stored_url,
        duration_ms: c.duration_ms,
        bytes: c.bytes,
        width: c.width,
        height: c.height,
        platform: c.platform,
        post_type: c.post_type,
        post_url: c.post_url,
        content_type: c.content_type,
        org: c.org,
        org_ar: c.org_ar,
        organization_id: c.organization_id,
        language: c.language,
        has_transcript: c.has_transcript,
        transcript_chars: c.transcript_chars,
        boundaries_ms: old?.boundaries_ms ?? [],
        labeling_status: old?.labeling_status ?? 'pending',
        labeled_by: old?.labeled_by ?? null,
        labeled_at: old?.labeled_at ?? null,
        pseudo_boundaries_ms: old?.pseudo_boundaries_ms ?? null,
        pseudo_method: old?.pseudo_method ?? null,
      };
    });

  const out = {
    _generated_by: 'scripts/eval/build-eval-sets.mjs',
    generated_at: new Date().toISOString(),
    selection_rule: `duration 10–120 s, ≤ 50 MB, enrichment content_type ∈ ${CV_TYPES.join('/')}, quotas per type ${JSON.stringify(TYPE_QUOTA)}, platform caps ${JSON.stringify(PLATFORM_CAP)}, ≤ ${ORG_CAP}/org, ≥ ${SILENT_TARGET} silent (empty transcript), ≤ ${BUCKET_CAP} per duration bucket; candidates walked in sha1(content_media_id) order so the pick is deterministic`,
    tolerance_ms: 250,
    counts: {
      by_platform: count(videos, (v) => v.platform),
      by_content_type: count(videos, (v) => v.content_type),
      by_org: count(videos, (v) => v.org),
      by_duration_bucket: count(videos, (v) => ['10-30s', '30-60s', '60-120s'][bucketOf(v.duration_ms)]),
      silent: videos.filter((v) => !v.has_transcript).length,
      with_transcript: videos.filter((v) => v.has_transcript).length,
      human_labeled: videos.filter((v) => v.labeling_status === 'done').length,
      pseudo_labeled: videos.filter((v) => Array.isArray(v.pseudo_boundaries_ms)).length,
    },
    videos,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log('cv-golden-30.json:', JSON.stringify(out.counts));
}

function count(arr, f) {
  const c = {};
  for (const x of arr) { const k = f(x) ?? 'null'; c[k] = (c[k] || 0) + 1; }
  return c;
}

if (doScript) await buildScriptSet();
if (doCv) await buildCvGolden();
