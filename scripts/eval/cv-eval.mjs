#!/usr/bin/env node
/**
 * scripts/eval/cv-eval.mjs — evaluates the competitor visual-intelligence
 * ingest (Gate B) and search (Gate C) against the golden set.
 *
 *   node scripts/eval/cv-eval.mjs [--golden docs/eval/cv-golden-30.json] [--tolerance 250]
 *        [--interval-ms 500] [--out docs/eval/results/<date>-cv-ingest.md]
 *        [--search-eval docs/eval/cv-queries-20.json] [--ocr-verdicts docs/eval/results/ocr-spot-verdicts.json]
 *
 * INGEST (reads mkt_cv_videos / shots / frames / cost ledger with the service key):
 *   • shot-boundary precision / recall at ±tolerance per video + micro totals.
 *     Reference = human `boundaries_ms` when labeling_status='done', otherwise
 *     the ffmpeg `pseudo_boundaries_ms` (high precision / low recall → against
 *     pseudo-labels PRECISION is the meaningful number, recall is only a lower
 *     bound; the report labels every row H or P).
 *   • frame-count sanity: expected ≈ floor(duration/interval)+1 + boundaries.
 *   • frames per shot (gate: every non-micro shot ≥ 1 frame) and keyframes/shot.
 *   • OCR spot check: 50 frames with non-empty OCR text listed with public_url
 *     for a human to verify; verdicts file {frame_id: true|false} → accuracy.
 *   • storage bytes (Σ frames.bytes) and cost (mkt_cv_videos.cost_usd + ledger
 *     by kind) per video.
 * SEARCH (--search-eval): for each query, embed via the Modal /embed_query
 *   endpoint (MODAL_CV_URL + MODAL_CV_TOKEN, header x-wassel-token) and call
 *   the RPC mkt_cv_search directly (API-free path — no per-org caps / MMR),
 *   then nDCG@10 from the query's `judgments` {shot_id: 0..3} and the number
 *   of distinct videos in the top-10. Unjudged shots count as 0 and are
 *   written to <out-dir>/<date>-search-candidates.json for judging. Skipped
 *   with a note when the Modal env is absent.
 *
 * Writes <out>.md and <out>.json. Exit code 1 when a gate fails.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseArgs, ROOT, todayStamp, serviceClient, pageAll } from './_lib/env.mjs';

const args = parseArgs();
const GOLDEN = join(ROOT, String(args.golden || 'docs/eval/cv-golden-30.json'));
const TOL = Number(args.tolerance ?? 250);
const INTERVAL = Number(args['interval-ms'] ?? 500);
const OUT_MD = join(ROOT, String(args.out || `docs/eval/results/${todayStamp()}-cv-ingest.md`));
const OUT_JSON = OUT_MD.replace(/\.md$/, '.json');
const SEARCH_SET = args['search-eval'] ? join(ROOT, String(args['search-eval'])) : null;
const VERDICTS = join(ROOT, String(args['ocr-verdicts'] || 'docs/eval/results/ocr-spot-verdicts.json'));
const GATES = { precision: 0.9, recall: 0.85, ocr: 0.9, ndcg10: 0.7, distinct_videos: 8, frame_ratio: [0.8, 1.3] };

const sb = serviceClient('cv-eval');
const fmt = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

/** One-to-one greedy match of detected cuts to reference cuts within ±tol. */
function matchBoundaries(reference, detected, tol) {
  const ref = [...reference].sort((a, b) => a - b);
  const det = [...detected].sort((a, b) => a - b);
  const usedDet = new Set();
  let matched = 0;
  const missed = [];
  for (const r of ref) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < det.length; i++) {
      if (usedDet.has(i)) continue;
      const d = Math.abs(det[i] - r);
      if (d <= tol && d < bestD) { best = i; bestD = d; }
    }
    if (best >= 0) { usedDet.add(best); matched++; } else missed.push(r);
  }
  const spurious = det.filter((_, i) => !usedDet.has(i));
  return { matched, missed, spurious, precision: det.length ? matched / det.length : null, recall: ref.length ? matched / ref.length : null };
}

// Seeded shuffle (mulberry32) so the OCR spot-check sample is stable between runs.
function seeded(seed) { let a = seed >>> 0; return () => { a += 0x6d2b79f5; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function evalIngest(golden) {
  const ids = golden.videos.map((v) => v.content_media_id);
  const { data: videos, error } = await sb.from('mkt_cv_videos').select('*').in('content_media_id', ids);
  if (error) throw new Error(`mkt_cv_videos: ${error.message}`);
  const byMedia = new Map(videos.map((v) => [v.content_media_id, v]));
  const vids = videos.map((v) => v.id);
  const shots = vids.length ? await pageAll((a, b) => sb.from('mkt_cv_shots').select('id,video_id,shot_no,start_ms,end_ms,duration_ms,is_micro,keyframe_ids,representative_frame_id,ocr_text,summary,analysis_status,analysis_cost_usd,transition_in').in('video_id', vids).order('video_id').order('shot_no').range(a, b)) : [];
  const frames = vids.length ? await pageAll((a, b) => sb.from('mkt_cv_frames').select('id,video_id,shot_id,ts_ms,is_boundary,is_keyframe,bytes,public_url,ocr,dup_group_id').in('video_id', vids).order('video_id').order('ts_ms').range(a, b)) : [];
  const ledger = vids.length ? await pageAll((a, b) => sb.from('mkt_cv_cost_ledger').select('video_id,kind,role,provider,model,cost_usd').in('video_id', vids).range(a, b)) : [];

  const rows = [];
  const totals = { ref: 0, det: 0, matched: 0, refH: 0, detH: 0, matchedH: 0, frames: 0, bytes: 0, cost: 0, shots: 0, shots_no_frames: 0, shots_no_keyframe: 0 };
  for (const g of golden.videos) {
    const v = byMedia.get(g.content_media_id);
    const row = { golden_id: g.golden_id, platform: g.platform, duration_ms: g.duration_ms, content_type: g.content_type, org: g.org, ingested: Boolean(v), status: v?.status ?? null };
    if (!v) { rows.push(row); continue; }
    const vs = shots.filter((s) => s.video_id === v.id);
    const vf = frames.filter((f) => f.video_id === v.id);
    const detected = vs.filter((s) => s.shot_no > 0).map((s) => s.start_ms);
    const useHuman = g.labeling_status === 'done' && Array.isArray(g.boundaries_ms) && g.boundaries_ms.length > 0;
    const reference = useHuman ? g.boundaries_ms : Array.isArray(g.pseudo_boundaries_ms) ? g.pseudo_boundaries_ms : null;
    const m = reference ? matchBoundaries(reference, detected, TOL) : null;
    const framesByShot = new Map();
    for (const f of vf) if (f.shot_id) framesByShot.set(f.shot_id, (framesByShot.get(f.shot_id) || 0) + 1);
    const nonMicro = vs.filter((s) => !s.is_micro);
    const shotsNoFrames = nonMicro.filter((s) => !framesByShot.get(s.id)).length;
    const kf = nonMicro.map((s) => (Array.isArray(s.keyframe_ids) ? s.keyframe_ids.length : 0));
    const shotsNoKeyframe = kf.filter((k) => k === 0).length;
    const expectedFrames = Math.floor(g.duration_ms / INTERVAL) + 1 + detected.length;
    const bytes = vf.reduce((a, f) => a + (f.bytes || 0), 0);
    const led = ledger.filter((l) => l.video_id === v.id);
    const costByKind = led.reduce((acc, l) => { acc[l.kind] = (acc[l.kind] || 0) + Number(l.cost_usd || 0); return acc; }, {});
    Object.assign(row, {
      video_id: v.id, shots: vs.length, micro_shots: vs.length - nonMicro.length, frames: vf.length, keyframes: vf.filter((f) => f.is_keyframe).length,
      expected_frames: expectedFrames, frame_ratio: expectedFrames ? vf.length / expectedFrames : null,
      shots_no_frames: shotsNoFrames, shots_no_keyframe: shotsNoKeyframe, keyframes_per_shot_min: kf.length ? Math.min(...kf) : null, keyframes_per_shot_mean: kf.length ? kf.reduce((a, b) => a + b, 0) / kf.length : null,
      reference_kind: reference ? (useHuman ? 'H' : 'P') : null, reference_count: reference?.length ?? null, detected_count: detected.length,
      precision: m?.precision ?? null, recall: m?.recall ?? null, missed_ms: m?.missed ?? null, spurious_ms: m?.spurious ?? null,
      bytes, cost_usd: Number(v.cost_usd || 0), cost_by_kind: costByKind, analyzed_shots: nonMicro.filter((s) => s.analysis_status === 'done').length, ocr_frames: vf.filter((f) => f.ocr?.text && String(f.ocr.text).trim()).length,
      detector_version: v.detector_version, embedding_version: v.embedding_version,
    });
    if (m) { totals.ref += reference.length; totals.det += detected.length; totals.matched += m.matched; if (useHuman) { totals.refH += reference.length; totals.detH += detected.length; totals.matchedH += m.matched; } }
    totals.frames += vf.length; totals.bytes += bytes; totals.cost += Number(v.cost_usd || 0); totals.shots += nonMicro.length; totals.shots_no_frames += shotsNoFrames; totals.shots_no_keyframe += shotsNoKeyframe;
    rows.push(row);
  }

  // OCR spot check: 50 frames with non-empty OCR, round-robin across videos, seeded.
  const rnd = seeded(42);
  const perVideo = new Map();
  for (const f of frames) {
    const t = f.ocr?.text && String(f.ocr.text).trim();
    if (!t) continue;
    if (!perVideo.has(f.video_id)) perVideo.set(f.video_id, []);
    perVideo.get(f.video_id).push(f);
  }
  for (const list of perVideo.values()) list.sort(() => rnd() - 0.5);
  const spot = [];
  const lists = [...perVideo.values()];
  for (let i = 0; spot.length < 50; i++) { let any = false; for (const l of lists) if (l[i]) { spot.push(l[i]); any = true; if (spot.length >= 50) break; } if (!any) break; }
  const gidByVideo = new Map(rows.filter((r) => r.video_id).map((r) => [r.video_id, r.golden_id]));
  const verdicts = existsSync(VERDICTS) ? JSON.parse(readFileSync(VERDICTS, 'utf8')) : null;
  const spotRows = spot.map((f) => ({ frame_id: f.id, golden_id: gidByVideo.get(f.video_id), ts_ms: f.ts_ms, public_url: f.public_url, text: String(f.ocr.text).replace(/\s+/g, ' ').slice(0, 160), lang: f.ocr.lang ?? null, inherited: Boolean(f.ocr.inherited_from), verdict: verdicts ? verdicts[f.id] ?? null : null }));
  const judged = spotRows.filter((s) => typeof s.verdict === 'boolean');
  const ocrAccuracy = judged.length ? judged.filter((s) => s.verdict).length / judged.length : null;

  const ingested = rows.filter((r) => r.ingested);
  const summary = {
    videos_in_set: golden.videos.length, ingested: ingested.length, by_status: ingested.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
    tolerance_ms: TOL,
    precision_all: totals.det ? totals.matched / totals.det : null, recall_all: totals.ref ? totals.matched / totals.ref : null,
    precision_human: totals.detH ? totals.matchedH / totals.detH : null, recall_human: totals.refH ? totals.matchedH / totals.refH : null,
    human_labeled_videos: rows.filter((r) => r.reference_kind === 'H').length, pseudo_labeled_videos: rows.filter((r) => r.reference_kind === 'P').length,
    shots: totals.shots, shots_no_frames: totals.shots_no_frames, shots_no_keyframe: totals.shots_no_keyframe,
    frames: totals.frames, storage_mb: totals.bytes / 1e6, cost_total_usd: totals.cost, cost_per_video_usd: ingested.length ? totals.cost / ingested.length : null,
    frame_ratio_out_of_band: ingested.filter((r) => r.frame_ratio != null && (r.frame_ratio < GATES.frame_ratio[0] || r.frame_ratio > GATES.frame_ratio[1])).map((r) => r.golden_id),
    ocr_spot_frames: spotRows.length, ocr_judged: judged.length, ocr_accuracy: ocrAccuracy,
  };
  // Gates: precision/recall are only AUTHORITATIVE against human labels; with
  // pseudo-labels precision is reported and recall is marked "lower bound".
  const pr = summary.human_labeled_videos ? summary.precision_human : summary.precision_all;
  const rc = summary.human_labeled_videos ? summary.recall_human : null;
  summary.gates = {
    precision: pr == null ? null : pr >= GATES.precision,
    recall: rc == null ? null : rc >= GATES.recall,
    recall_note: summary.human_labeled_videos ? null : 'recall not gated — no human labels yet (pseudo-label recall is a lower bound)',
    every_shot_has_frame: ingested.length ? totals.shots_no_frames === 0 : null,
    ocr: ocrAccuracy == null ? null : ocrAccuracy >= GATES.ocr,
  };
  summary.gates.pass = ingested.length > 0 && Object.entries(summary.gates).every(([k, v]) => k === 'recall_note' || v !== false);
  return { rows, summary, spotRows };
}

// ── search eval ─────────────────────────────────────────────────────────────
async function embedQuery(text) {
  const url = process.env.MODAL_CV_URL, token = process.env.MODAL_CV_TOKEN;
  const res = await fetch(`${url.replace(/\/$/, '')}/embed_query`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wassel-token': token }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`embed_query HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (!Array.isArray(j.image_vec) || !Array.isArray(j.text_vec)) throw new Error('embed_query returned no vectors');
  return j;
}

function ndcg(rels, k = 10) {
  const dcg = (xs) => xs.slice(0, k).reduce((a, r, i) => a + (Math.pow(2, r) - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...rels.all].sort((a, b) => b - a));
  return ideal ? dcg(rels.ranked) / ideal : null;
}

async function evalSearch(queriesFile) {
  const qs = JSON.parse(readFileSync(queriesFile, 'utf8'));
  if (!process.env.MODAL_CV_URL || !process.env.MODAL_CV_TOKEN) return { skipped: 'MODAL_CV_URL / MODAL_CV_TOKEN not set — search eval skipped (set them in .env.local to embed queries)' };
  const results = [];
  const candidates = {};
  for (const q of qs.queries) {
    const t0 = Date.now();
    let emb;
    try { emb = await embedQuery(q.text); } catch (e) { results.push({ id: q.id, text: q.text, error: e.message }); continue; }
    const { data, error } = await sb.rpc('mkt_cv_search', { p_qvec_image: JSON.stringify(emb.image_vec), p_qvec_text: JSON.stringify(emb.text_vec), p_query_text: q.text, p_filters: {}, p_mode: 'shot', p_limit: 30 });
    if (error) { results.push({ id: q.id, text: q.text, error: `mkt_cv_search: ${error.message}` }); continue; }
    const raw = data || [];
    const top10 = raw.slice(0, 10);
    // Diversified view (≤ 1 shot per video) approximating the API layer's cap.
    const seen = new Set(); const div = [];
    for (const r of raw) { if (seen.has(r.video_id)) continue; seen.add(r.video_id); div.push(r); if (div.length >= 10) break; }
    const judg = q.judgments || {};
    const rel = (r) => Number(judg[r.shot_id] ?? 0);
    const all = Object.values(judg).map(Number);
    const row = {
      id: q.id, text: q.text, lang: q.lang, results: raw.length, latency_ms: Date.now() - t0,
      judged_in_top10: top10.filter((r) => r.shot_id in judg).length, judged_total: all.length,
      ndcg10_raw: all.length ? ndcg({ ranked: top10.map(rel), all }) : null,
      ndcg10_diversified: all.length ? ndcg({ ranked: div.map(rel), all }) : null,
      distinct_videos_top10_raw: new Set(top10.map((r) => r.video_id)).size,
      distinct_videos_top10_diversified: new Set(div.map((r) => r.video_id)).size,
      distinct_orgs_top10_raw: new Set(top10.map((r) => r.organization_id)).size,
      top10: top10.map((r) => ({ shot_id: r.shot_id, video_id: r.video_id, org: r.org_name, platform: r.platform, start_ms: r.start_ms, end_ms: r.end_ms, score: r.score, frame: r.representative_frame_url, summary: r.summary, judged: judg[r.shot_id] ?? null })),
    };
    results.push(row);
    candidates[q.id] = { text: q.text, candidates: [...new Map([...top10, ...div].map((r) => [r.shot_id, r])).values()].map((r) => ({ shot_id: r.shot_id, video_id: r.video_id, org: r.org_name, platform: r.platform, post_url: r.post_url, start_ms: r.start_ms, end_ms: r.end_ms, frame: r.representative_frame_url, summary: r.summary, tags: r.tags, judged: judg[r.shot_id] ?? null })) };
  }
  const ok = results.filter((r) => !r.error);
  const withJ = ok.filter((r) => r.ndcg10_raw != null);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const summary = {
    queries: qs.queries.length, errors: results.filter((r) => r.error).length, judged_queries: withJ.length,
    ndcg10_raw_mean: mean(withJ.map((r) => r.ndcg10_raw)), ndcg10_diversified_mean: mean(withJ.map((r) => r.ndcg10_diversified)),
    distinct_videos_raw_mean: mean(ok.map((r) => r.distinct_videos_top10_raw)), distinct_videos_diversified_mean: mean(ok.map((r) => r.distinct_videos_top10_diversified)),
    queries_below_8_distinct_raw: ok.filter((r) => r.distinct_videos_top10_raw < GATES.distinct_videos).map((r) => r.id),
    unjudged_in_top10_total: ok.reduce((a, r) => a + (10 - r.judged_in_top10), 0),
  };
  summary.gates = {
    ndcg10: summary.ndcg10_raw_mean == null ? null : summary.ndcg10_raw_mean >= GATES.ndcg10,
    distinct_videos: ok.length ? summary.queries_below_8_distinct_raw.length === 0 : null,
    note: withJ.length ? null : 'no judgments yet — nDCG not gated; judge the candidates file (docs/eval/cv-queries-20-judging.md)',
  };
  const candPath = join(dirname(OUT_MD), `${todayStamp()}-search-candidates.json`);
  writeFileSync(candPath, JSON.stringify({ generated_at: new Date().toISOString(), how_to_judge: 'see docs/eval/cv-queries-20-judging.md', queries: candidates }, null, 2) + '\n');
  return { results, summary, candidates_file: candPath };
}

// ── report ──────────────────────────────────────────────────────────────────
function render(golden, ingest, search) {
  const L = [];
  const s = ingest.summary;
  L.push(`# CV ingest eval — ${todayStamp()}`, '');
  L.push(`Golden: \`${GOLDEN.replace(ROOT, '').replace(/^[\\/]/, '')}\` (${s.videos_in_set} videos, generated ${golden.generated_at}) · tolerance ±${TOL} ms · frame interval ${INTERVAL} ms`, '');
  L.push('## Summary', '');
  L.push(`- Ingested: **${s.ingested}/${s.videos_in_set}** (${Object.entries(s.by_status).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'})`);
  L.push(`- Boundaries vs **human** labels (${s.human_labeled_videos} videos): precision ${pct(s.precision_human)} · recall ${pct(s.recall_human)}`);
  L.push(`- Boundaries vs all references (${s.human_labeled_videos} H + ${s.pseudo_labeled_videos} P): precision ${pct(s.precision_all)} · recall ${pct(s.recall_all)} _(against pseudo-labels recall is a lower bound)_`);
  L.push(`- Shots (non-micro): ${s.shots} · without any frame: **${s.shots_no_frames}** · without a keyframe: ${s.shots_no_keyframe}`);
  L.push(`- Frames: ${s.frames} · storage ${fmt(s.storage_mb, 1)} MB · cost total $${fmt(s.cost_total_usd, 4)} · per video $${fmt(s.cost_per_video_usd, 4)}`);
  L.push(`- Frame-count out of band [${GATES.frame_ratio.join('–')}]×expected: ${s.frame_ratio_out_of_band.join(', ') || 'none'}`);
  L.push(`- OCR spot check: ${s.ocr_spot_frames} frames listed · ${s.ocr_judged} judged · accuracy ${pct(s.ocr_accuracy)}`);
  L.push('', `**Gates:** precision ≥ ${GATES.precision * 100}% → ${g(s.gates.precision)} · recall ≥ ${GATES.recall * 100}% → ${g(s.gates.recall)}${s.gates.recall_note ? ` (${s.gates.recall_note})` : ''} · every shot ≥ 1 frame → ${g(s.gates.every_shot_has_frame)} · OCR ≥ ${GATES.ocr * 100}% → ${g(s.gates.ocr)} · **overall ${s.gates.pass ? 'PASS' : 'FAIL'}**`, '');
  L.push('## Per video', '');
  L.push('| ID | platform | dur s | type | org | status | shots (micro) | frames / expected (ratio) | kf/shot min·mean | shots w/o frame | ref | ref cuts | detected | P | R | MB | $ |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of ingest.rows) {
    if (!r.ingested) { L.push(`| ${r.golden_id} | ${r.platform} | ${(r.duration_ms / 1000).toFixed(1)} | ${r.content_type} | ${r.org} | not ingested | | | | | | | | | | | |`); continue; }
    L.push(`| ${r.golden_id} | ${r.platform} | ${(r.duration_ms / 1000).toFixed(1)} | ${r.content_type} | ${r.org} | ${r.status} | ${r.shots} (${r.micro_shots}) | ${r.frames} / ${r.expected_frames} (${fmt(r.frame_ratio)}) | ${r.keyframes_per_shot_min ?? '—'}·${fmt(r.keyframes_per_shot_mean, 1)} | ${r.shots_no_frames} | ${r.reference_kind ?? '—'} | ${r.reference_count ?? '—'} | ${r.detected_count} | ${pct(r.precision)} | ${pct(r.recall)} | ${fmt(r.bytes / 1e6, 1)} | ${fmt(r.cost_usd, 4)} |`);
  }
  L.push('', 'ref: H = human boundaries_ms · P = ffmpeg pseudo_boundaries_ms (scene > 0.4).', '');
  const detail = ingest.rows.filter((r) => r.ingested && r.reference_kind && (r.missed_ms?.length || r.spurious_ms?.length));
  if (detail.length) {
    L.push('## Boundary misses / spurious cuts (ms)', '');
    for (const r of detail) L.push(`- **${r.golden_id}** missed: ${r.missed_ms.join(', ') || '—'} · spurious: ${r.spurious_ms.join(', ') || '—'}`);
    L.push('');
  }
  L.push('## OCR spot check (verify by opening public_url)', '');
  L.push(`Record verdicts as \`{"<frame_id>": true|false}\` in \`docs/eval/results/ocr-spot-verdicts.json\` and re-run. "true" = the OCR text is the text visible in the frame (minor spacing/punctuation differences are fine; wrong digits, missing lines, hallucinated words are false).`, '');
  L.push('| # | frame_id | video | ts s | OCR text | lang | inherited | url | correct? |', '|---|---|---|---|---|---|---|---|---|');
  ingest.spotRows.forEach((f, i) => L.push(`| ${i + 1} | ${f.frame_id} | ${f.golden_id} | ${(f.ts_ms / 1000).toFixed(1)} | ${f.text.replace(/\|/g, '\\|')} | ${f.lang ?? ''} | ${f.inherited ? 'yes' : ''} | [frame](${f.public_url}) | ${f.verdict == null ? '' : f.verdict ? '✓' : '✗'} |`));
  L.push('');
  if (search) {
    L.push('## Search eval', '');
    if (search.skipped) L.push(`> ${search.skipped}`, '');
    else {
      const ss = search.summary;
      L.push(`- Queries: ${ss.queries} · errors ${ss.errors} · judged ${ss.judged_queries}`);
      L.push(`- nDCG@10 (raw RPC order): **${fmt(ss.ndcg10_raw_mean, 3)}** · diversified (≤ 1 shot/video): ${fmt(ss.ndcg10_diversified_mean, 3)}`);
      L.push(`- Distinct videos in top-10: raw ${fmt(ss.distinct_videos_raw_mean, 1)} · diversified ${fmt(ss.distinct_videos_diversified_mean, 1)} · queries below ${GATES.distinct_videos}: ${ss.queries_below_8_distinct_raw.join(', ') || 'none'}`);
      L.push(`- Unjudged shots in top-10 (all queries): ${ss.unjudged_in_top10_total} → judge \`${search.candidates_file.replace(ROOT, '').replace(/^[\\/]/, '')}\``);
      L.push('', `**Gates:** nDCG@10 ≥ ${GATES.ndcg10} → ${g(ss.gates.ndcg10)}${ss.gates.note ? ` (${ss.gates.note})` : ''} · ≥ ${GATES.distinct_videos} distinct videos in every top-10 → ${g(ss.gates.distinct_videos)}`, '');
      L.push('| Q | text | results | judged in top10 | nDCG@10 raw | nDCG@10 div | distinct videos raw/div | orgs | ms |', '|---|---|---|---|---|---|---|---|---|');
      for (const r of search.results) L.push(r.error ? `| ${r.id} | ${r.text} | ERROR ${r.error} | | | | | | |` : `| ${r.id} | ${r.text} | ${r.results} | ${r.judged_in_top10} | ${fmt(r.ndcg10_raw, 3)} | ${fmt(r.ndcg10_diversified, 3)} | ${r.distinct_videos_top10_raw}/${r.distinct_videos_top10_diversified} | ${r.distinct_orgs_top10_raw} | ${r.latency_ms} |`);
      L.push('');
    }
  }
  return L.join('\n');
}
const g = (v) => (v == null ? 'n/a' : v ? 'PASS' : 'FAIL');

async function main() {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
  const ingest = await evalIngest(golden);
  const search = SEARCH_SET ? await evalSearch(SEARCH_SET) : null;
  mkdirSync(dirname(OUT_MD), { recursive: true });
  writeFileSync(OUT_MD, render(golden, ingest, search) + '\n');
  writeFileSync(OUT_JSON, JSON.stringify({ generated_at: new Date().toISOString(), golden: GOLDEN, tolerance_ms: TOL, ingest: { summary: ingest.summary, rows: ingest.rows, ocr_spot: ingest.spotRows }, search }, null, 2) + '\n');
  const s = ingest.summary;
  console.log(`ingested ${s.ingested}/${s.videos_in_set} · P ${pct(s.precision_all)} R ${pct(s.recall_all)} (human: ${s.human_labeled_videos} videos, P ${pct(s.precision_human)} R ${pct(s.recall_human)}) · shots w/o frame ${s.shots_no_frames} · OCR ${pct(s.ocr_accuracy)} · gates ${s.gates.pass ? 'PASS' : 'FAIL'}`);
  if (search && !search.skipped) console.log(`search: nDCG@10 ${fmt(search.summary.ndcg10_raw_mean, 3)} · distinct videos ${fmt(search.summary.distinct_videos_raw_mean, 1)} · unjudged ${search.summary.unjudged_in_top10_total}`);
  else if (search?.skipped) console.log(search.skipped);
  if (!s.ingested) console.log('NOTE: none of the golden videos are in mkt_cv_videos yet — run the ingest (mkt_cv_enqueue_video for each content_media_id) and re-run.');
  console.log(`wrote ${OUT_MD}`);
  if (s.ingested && !s.gates.pass) process.exitCode = 1;
  if (search && !search.skipped && Object.values(search.summary.gates).some((v) => v === false)) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
