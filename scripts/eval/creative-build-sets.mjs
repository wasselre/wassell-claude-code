#!/usr/bin/env node
/**
 * creative-build-sets.mjs — build the Post Creative Director eval sets.
 *
 *   node scripts/eval/creative-build-sets.mjs
 *
 * Writes TWO files (regenerated on every run; committed snapshots):
 *
 *  docs/eval/creative-eval-set.json
 *    20 briefs = 4 projects × 5 recipes {feature_spec, lifestyle, offer, event,
 *    launch} × format alternating {single, carousel}. The four projects are
 *    auto-selected from live all_projects to cover ready / off_plan / sold_out /
 *    conflict (deterministic: scored, sha1-id tiebreak). The sibling worktree's
 *    curated id list was unreachable from this sandbox, so selection is
 *    data-driven with the same readiness rules as
 *    worker/src/marketing/script/facts.ts (deriveReadiness + sold-out).
 *
 *  docs/eval/creative-design-read-pilot.json
 *    Tier-0 pilot list for the design-read backfill (contracts §9): 60
 *    competitor static slides (single-image posts) + 25 carousels (all stored
 *    slides of 25 multi-image posts), ordered by sha1(content_media_id) for a
 *    deterministic, org/content_type-diverse pick. Internal (Wassel) orgs are
 *    excluded. `labels` start null — filled later by human review / pilot runs.
 *
 * READ-ONLY against prod (service role, PostgREST only — no raw SQL available).
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serviceClient, pageAll, ROOT } from './_lib/env.mjs';

const ALL_PROJECTS_MODEL_ID = '220c49b9-de57-492d-9eca-c0d9f54fd40f';
const RECIPES = ['feature_spec', 'lifestyle', 'offer', 'event', 'launch'];
const CATEGORIES = ['ready', 'off_plan', 'sold_out', 'conflict'];

// ── readiness — mirrors worker/src/marketing/script/facts.ts deriveReadiness ──
const OFF_PLAN_PROJECT_STATUS = new Set(['available_on_map', 'under_construction', 'upcoming']);
const IN_PROGRESS_CONSTRUCTION = new Set(['excavation', 'foundations', 'structure', 'finishing', 'facade_installation', 'تحت-التطوير']);
function deriveReadiness(ps, cs) {
  const offPlanMarker = OFF_PLAN_PROJECT_STATUS.has(ps) || IN_PROGRESS_CONSTRUCTION.has(cs);
  const readyMarker = cs === 'ready' || (ps === 'available' && !IN_PROGRESS_CONSTRUCTION.has(cs));
  if (offPlanMarker && cs === 'ready') return 'conflict';
  if (OFF_PLAN_PROJECT_STATUS.has(ps)) return 'off_plan';
  if (readyMarker) return 'ready';
  if (offPlanMarker) return 'off_plan';
  return 'unknown';
}
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,٬\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');

function die(msg) {
  console.error(`\n[creative-build-sets] ${msg}\n`);
  process.exit(1);
}

// ── 1. eval set: 4 projects × 5 recipes × alternating format ────────────────
async function pickProjects(db) {
  const rows = await pageAll((from, to) =>
    db.from('unified_records').select('id, data').eq('model_id', ALL_PROJECTS_MODEL_ID).range(from, to),
  );
  const enriched = rows.map((r) => {
    const d = r.data ?? {};
    const ps = String(d.project_status ?? '').trim();
    const cs = String(d.construction_status ?? '').trim();
    const readiness = deriveReadiness(ps, cs);
    const avail = num(d.available_units);
    const soldOut = ps === 'sold_out' || avail === 0;
    const price = d.available_price_range && typeof d.available_price_range === 'object' ? num(d.available_price_range.min) : null;
    const hasPrice = !soldOut && avail !== null && avail > 0 && price !== null && price > 0;
    const name = typeof d.project_name === 'string' && d.project_name.trim() ? d.project_name.trim() : null;
    // Quality score per category so the pick favours records rich enough to brief on.
    let category = null;
    if (soldOut) category = 'sold_out';
    else if (readiness === 'conflict') category = 'conflict';
    else if (readiness === 'ready') category = 'ready';
    else if (readiness === 'off_plan') category = 'off_plan';
    let score = 0;
    if (name) score += 2;
    if (hasPrice) score += 2;
    if (category === 'off_plan' && d.handover_date) score += 1;
    if (Array.isArray(d.unit_types) && d.unit_types.length > 0) score += 1;
    if (Array.isArray(d.features) && d.features.length >= 3) score += 1;
    if (d.location && typeof d.location === 'object') score += 1;
    return { id: r.id, name, category, readiness, sold_out: soldOut, has_price: hasPrice, score };
  });

  const picked = [];
  for (const cat of CATEGORIES) {
    const pool = enriched
      .filter((e) => e.category === cat && e.name)
      .sort((a, b) => b.score - a.score || sha1(a.id).localeCompare(sha1(b.id)));
    if (pool.length === 0) die(`no all_projects record found for category '${cat}' — pick one manually and add it to the JSON`);
    picked.push(pool[0]);
  }
  return picked;
}

function buildEvalSet(projects) {
  const items = [];
  let n = 0;
  for (const p of projects) {
    for (let i = 0; i < RECIPES.length; i++) {
      n += 1;
      const recipe = RECIPES[i];
      const format = i % 2 === 0 ? 'single' : 'carousel';
      const expect = { readiness: p.readiness, sold_out: p.sold_out, no_price: p.sold_out || !p.has_price };
      items.push({
        id: `b${String(n).padStart(2, '0')}`,
        project_id: p.id,
        project_name: p.name,
        category: p.category,
        recipe,
        format,
        language: 'ar',
        expect,
      });
    }
  }
  return {
    meta: {
      kind: 'creative-eval-set',
      built_at: new Date().toISOString(),
      recipe_list: RECIPES,
      projects: projects.map((p) => ({ id: p.id, name: p.name, category: p.category, score: p.score })),
      note: '20 briefs = 4 projects (ready/off_plan/sold_out/conflict) × 5 recipes × alternating format. Regenerate with scripts/eval/creative-build-sets.mjs.',
    },
    items,
  };
}

// ── 2. design-read pilot: 60 static slides + 25 carousels ───────────────────
const PILOT_STATICS = 60;
const PILOT_CAROUSEL_POSTS = 25;
const PER_ORG_CAP = 6;
const PER_TYPE_CAP = 15;

async function buildPilot(db) {
  const [media, posts, enrichments, orgs] = await Promise.all([
    pageAll((from, to) =>
      db
        .from('mkt_content_media')
        .select('id, content_post_id, media_kind, stored_url, download_status, carousel_index, created_at')
        .eq('download_status', 'stored')
        .eq('media_kind', 'image')
        .not('stored_url', 'is', null)
        .range(from, to),
    ),
    pageAll((from, to) =>
      db.from('mkt_content_posts').select('id, organization_id, post_type, platform, published_at').range(from, to),
    ),
    pageAll((from, to) =>
      db.from('mkt_content_enrichment').select('content_post_id, result').eq('status', 'done').range(from, to),
    ),
    pageAll((from, to) => db.from('mkt_organizations').select('id, name_ar, name_en, org_type').range(from, to)),
  ]);

  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const typeByPost = new Map(enrichments.map((e) => [e.content_post_id, e.result?.content_type ?? null]));
  const postById = new Map(
    posts
      .filter((p) => {
        const org = orgById.get(p.organization_id);
        return org && org.org_type !== 'internal'; // competitor posts only (contracts §0.11)
      })
      .map((p) => [p.id, p]),
  );

  const mediaByPost = new Map();
  for (const m of media) {
    if (!postById.has(m.content_post_id)) continue;
    const list = mediaByPost.get(m.content_post_id) ?? [];
    list.push(m);
    mediaByPost.set(m.content_post_id, list);
  }
  const slideOrder = (a, b) => (a.carousel_index ?? 0) - (b.carousel_index ?? 0) || sha1(a.id).localeCompare(sha1(b.id));

  const statics = []; // single-image posts
  const carousels = []; // multi-image posts
  for (const [postId, list] of mediaByPost) {
    list.sort(slideOrder);
    if (list.length === 1) statics.push({ postId, media: list[0] });
    else carousels.push({ postId, media: list });
  }

  const entry = (postId, m, carousel) => {
    const post = postById.get(postId);
    const org = orgById.get(post.organization_id);
    return {
      content_media_id: m.id,
      content_post_id: postId,
      stored_url: m.stored_url,
      carousel_index: m.carousel_index ?? 0,
      carousel,
      org: org.name_ar ?? org.name_en ?? String(post.organization_id),
      organization_id: post.organization_id,
      platform: post.platform ?? null,
      content_type: typeByPost.get(postId) ?? null,
      published_at: post.published_at ?? null,
      labels: { slide_role: null, layout: null, palette_family: null, density: null, branding_intensity: null },
    };
  };

  // Greedy diversity pick over a deterministic sha1 order: per-org and
  // per-content_type caps keep one big advertiser from filling the pilot.
  function pick(candidates, target, accept) {
    const orgCount = new Map();
    const typeCount = new Map();
    const out = [];
    const sorted = [...candidates].sort((a, b) => sha1(accept(a).content_media_id).localeCompare(sha1(accept(b).content_media_id)));
    for (const c of sorted) {
      if (out.length >= target) break;
      const e = accept(c);
      const oc = orgCount.get(e.organization_id) ?? 0;
      const tc = typeCount.get(e.content_type ?? 'unknown') ?? 0;
      if (oc >= PER_ORG_CAP || tc >= PER_TYPE_CAP) continue;
      orgCount.set(e.organization_id, oc + 1);
      typeCount.set(e.content_type ?? 'unknown', tc + 1);
      out.push(e);
    }
    return out;
  }

  const staticEntries = pick(statics, PILOT_STATICS, (c) => entry(c.postId, c.media, false));
  const carouselPosts = pick(carousels, PILOT_CAROUSEL_POSTS, (c) => entry(c.postId, c.media[0], true));
  // Emit EVERY stored slide of each picked carousel post (slide-level reads
  // need the full sequence); the post count is what the "25" budgets.
  const pickedCarouselPostIds = new Set(carouselPosts.map((e) => e.content_post_id));
  const carouselEntries = [];
  for (const c of carousels) {
    if (!pickedCarouselPostIds.has(c.postId)) continue;
    for (const m of c.media) carouselEntries.push(entry(c.postId, m, true));
  }

  return {
    meta: {
      kind: 'creative-design-read-pilot',
      built_at: new Date().toISOString(),
      static_slides: staticEntries.length,
      carousel_posts: carouselPosts.length,
      carousel_slides: carouselEntries.length,
      per_org_cap: PER_ORG_CAP,
      per_content_type_cap: PER_TYPE_CAP,
      note: 'Tier-0 pilot list for the design-read backfill (contracts §9). Deterministic sha1 order; internal orgs excluded. Regenerate with scripts/eval/creative-build-sets.mjs.',
    },
    statics: staticEntries,
    carousels: carouselEntries,
  };
}

async function main() {
  const db = serviceClient('creative-build-sets');
  const outDir = join(ROOT, 'docs', 'eval');
  mkdirSync(outDir, { recursive: true });

  console.log('[creative-build-sets] picking projects…');
  const projects = await pickProjects(db);
  const evalSet = buildEvalSet(projects);
  const evalPath = join(outDir, 'creative-eval-set.json');
  writeFileSync(evalPath, JSON.stringify(evalSet, null, 2), 'utf8');
  console.log(`[creative-build-sets] ${evalSet.items.length} briefs → ${evalPath}`);
  for (const p of projects) console.log(`  ${p.category.padEnd(9)} ${p.name} (${p.id}) score=${p.score}`);

  console.log('[creative-build-sets] building design-read pilot…');
  const pilot = await buildPilot(db);
  const pilotPath = join(outDir, 'creative-design-read-pilot.json');
  writeFileSync(pilotPath, JSON.stringify(pilot, null, 2), 'utf8');
  console.log(
    `[creative-build-sets] pilot: ${pilot.meta.static_slides} static slides + ${pilot.meta.carousel_posts} carousels (${pilot.meta.carousel_slides} slides) → ${pilotPath}`,
  );
}

main().catch((e) => die(e.stack || e.message));
