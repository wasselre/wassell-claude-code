#!/usr/bin/env node
/**
 * scripts/eval/run-role-matrix.mjs — the role × model comparison harness.
 *
 * Runs the SAME inputs through candidate models for ONE AI role (contracts §4)
 * and scores every run, so choosing a model per role is a measured decision.
 *
 *   node scripts/eval/run-role-matrix.mjs --role script_writer \
 *        --models claude-opus-5,claude-sonnet-5,claude-sonnet-4-6 \
 *        --set docs/eval/script-eval-set.json --limit 20 \
 *        --out docs/eval/results/2026-09-02-script_writer.json
 *
 *   --role script_reviewer --writer claude-opus-5 --models claude-sonnet-5,claude-haiku-4-5
 *        (writer FIXED, reviewer varies — note: each run regenerates the draft, so
 *         writer variance is still present; see README "Reviewer comparisons")
 *   --role frame_describer | shot_analyzer --set docs/eval/cv-golden-30.json
 *        (items = representative frames / shots of the golden videos already
 *         ingested into mkt_cv_*; needs worker/src/marketing/cv/evalEntry.ts)
 *
 * Other flags: --only S01,S05 · --concurrency 2 · --timeout-min 15 · --dry-run
 * (plan only, no pipeline calls) · a model spec may carry a provider prefix
 * (`openai_compat:deepseek-chat`); bare ids are Anthropic.
 *
 * The pipeline is reached through scripts/eval/_lib/pipeline-bridge.ts (one
 * tsx child per call). When the entry module does not exist yet the harness
 * prints "pipeline not available yet", still validates the data set, and
 * writes a results file whose runs are all `unavailable` — so the DATA part of
 * a matrix run is never blocked on the code part.
 *
 * Writes <out>.json and <out>.md (markdown tables). Never truncates: every
 * run is recorded, including errors (with the error text).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, ROOT, todayStamp, serviceClient, pageAll } from './_lib/env.mjs';
import { tokens, jaccard, sharedNgrams, normAr, extractNumbers, numberAllowed, findPhones, digitsOnly } from './_lib/text.mjs';

const ROLES = ['script_writer', 'script_reviewer', 'frame_describer', 'shot_analyzer'];
/** Fact classes whose FAIL is a hard gate (a wrong number/date/availability claim). */
const HARD_CLASSES = new Set(['price', 'area', 'unit_count', 'date', 'distance', 'duration', 'availability', 'guarantee', 'payment']);
/** Contracts §6 controlled vocabulary — used to score cv-role label compliance. */
const VOCAB = {
  shot_size: ['wide', 'medium', 'close', 'extreme_close', 'aerial'],
  setting: ['exterior_facade', 'interior_living', 'kitchen', 'bedroom', 'bathroom', 'amenity_pool', 'gym', 'lobby', 'street', 'map', 'studio', 'render', 'office'],
  subject: ['building', 'unit', 'person', 'presenter', 'family', 'vehicle', 'text_card', 'logo', 'map', 'plan'],
  graphic: ['none', 'text_overlay', 'animated_map', '3d_render', 'motion_graphic', 'split_screen', 'slideshow'],
  motion: ['static', 'pan', 'tilt', 'dolly', 'drone', 'handheld', 'zoom'],
  light: ['day', 'golden', 'night', 'studio'],
  purpose: ['hook', 'location', 'product', 'feature', 'proof', 'offer', 'cta', 'brand'],
  reproducibility: ['easy', 'moderate', 'hard'],
};
const VOCAB_SET = new Set(Object.entries(VOCAB).flatMap(([g, vs]) => vs.map((v) => `${g}:${v}`)));
const GATES = {
  script: { hard_fail: 0, entity_hits: 0, rhetorical_pass: 0.95, exemplar_jaccard: 0.3, judge_pass_rate: 0.8 },
};

const args = parseArgs();
const role = String(args.role || '');
if (!ROLES.includes(role)) { console.error(`--role must be one of ${ROLES.join(', ')}`); process.exit(2); }
if (!args.models) { console.error('--models is required (comma-separated model ids, optional provider: prefix)'); process.exit(2); }
const MODELS = String(args.models).split(',').map((s) => s.trim()).filter(Boolean).map(parseModel);
const isScriptRole = role === 'script_writer' || role === 'script_reviewer';
const SET = String(args.set || (isScriptRole ? 'docs/eval/script-eval-set.json' : 'docs/eval/cv-golden-30.json'));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const ONLY = args.only ? new Set(String(args.only).split(',').map((s) => s.trim())) : null;
const CONCURRENCY = Number(args.concurrency ?? 2);
const TIMEOUT_MS = Number(args['timeout-min'] ?? 15) * 60_000;
const DRY = Boolean(args['dry-run']);
const WRITER = parseModel(String(args.writer || 'claude-opus-5'));
const OUT = String(args.out || join('docs', 'eval', 'results', `${todayStamp()}-${role}.json`));
const OUT_JSON = OUT.endsWith('.json') ? OUT : `${OUT}.json`;
const OUT_MD = OUT_JSON.replace(/\.json$/, '.md');
const BRIDGE = join(ROOT, 'scripts', 'eval', '_lib', 'pipeline-bridge.ts');
const TSX = join(ROOT, 'worker', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function parseModel(spec) {
  const i = spec.indexOf(':');
  return i > 0 ? { provider: spec.slice(0, i), model: spec.slice(i + 1) } : { provider: 'anthropic', model: spec };
}
const modelLabel = (m) => (m.provider === 'anthropic' ? m.model : `${m.provider}:${m.model}`);

// ── bridge ──────────────────────────────────────────────────────────────────
function callBridge(req) {
  return new Promise((resolve) => {
    if (!existsSync(TSX)) return resolve({ ok: false, unavailable: true, reason: `${TSX} missing — run \`npm install\` inside worker/` });
    const env = { ...process.env };
    // The worker's strict env loader wants these even for a pure-eval import.
    env.FAL_KEY ??= 'stub';
    env.ANTHROPIC_WASSEL_SKILL_ID ??= 'eval-unused';
    const child = spawn(process.execPath, [TSX, BRIDGE], { cwd: ROOT, env, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: `timeout after ${TIMEOUT_MS / 60000} min`, kind: 'timeout', stderr: err.slice(-2000) }); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `spawn failed: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.startsWith('__EVAL_RESULT__'));
      if (!line) return resolve({ ok: false, error: `bridge exited ${code} without a result line`, stdout: out.slice(-2000), stderr: err.slice(-2000) });
      try { resolve({ ...JSON.parse(line.slice('__EVAL_RESULT__'.length)), stderr_tail: err.slice(-1500) }); }
      catch (e) { resolve({ ok: false, error: `bad result JSON: ${e.message}`, stdout: out.slice(-2000) }); }
    });
    child.stdin.end(JSON.stringify(req));
  });
}

// ── script-role scoring ─────────────────────────────────────────────────────
function scoreScriptRun(entry, model, res) {
  const base = { entry_id: entry.id, project_name: entry.project_name, recipe: entry.recipe, content_id: entry.content_id, model: modelLabel(model), role_config: model };
  if (res.unavailable) return { ...base, status: 'unavailable', reason: res.reason };
  const exp = entry.expected;
  if (!res.ok) {
    const refused = res.kind === 'facts_insufficient';
    return {
      ...base,
      status: refused ? 'refused' : 'error',
      error: res.error, error_kind: res.kind ?? null, latency_ms: res.wall_ms ?? null,
      refusal_expected: exp.expect_pipeline_refusal,
      refusal_correct: refused === exp.expect_pipeline_refusal,
      gates: { pass: refused && exp.expect_pipeline_refusal },
    };
  }
  const r = res.result || {};
  const draft = r.draft || {};
  const review = r.review || {};
  const scenes = Array.isArray(draft.scenes) ? draft.scenes : [];
  const claims = review.validator?.claims || [];
  const entities = review.validator?.entities || [];
  const checks = review.validator?.checks || [];
  const judge = review.judge || null;

  const countBy = (arr, f) => arr.reduce((acc, x) => { const k = f(x); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const fails = claims.filter((c) => c.verdict === 'fail');
  const reviews = claims.filter((c) => c.verdict === 'review');
  const hard_fail = fails.filter((c) => HARD_CLASSES.has(c.class));

  const spoken = scenes.map((s) => `${s.voiceover || ''}\n${s.on_screen_text || ''}`).join('\n');
  const visual = scenes.map((s) => `${s.visual || ''}\n${s.production_note || ''}`).join('\n');
  const all = `${spoken}\n${visual}`;
  const nAll = normAr(all);
  const phonesInText = findPhones(all);
  const mnc_hits = [];
  for (const s of exp.must_not_contain || []) {
    const d = digitsOnly(s);
    const hit = d.length >= 7 ? phonesInText.some((p) => p.endsWith(d.slice(-7))) : nAll.includes(normAr(s));
    if (hit) mnc_hits.push(s);
  }

  const hf = exp.hard_facts || {};
  const allowed = [hf.price?.min, hf.price?.max, hf.price_all_units?.min, hf.price_all_units?.max, hf.area?.min, hf.area?.max, hf.area_all_units?.min, hf.area_all_units?.max, hf.unit_count, hf.available_units, hf.sold_units].filter((x) => Number.isFinite(x));
  const unexpected_numbers = extractNumbers(spoken)
    .filter((n) => n.value >= 1000 && !(n.value >= 2020 && n.value <= 2035) && !numberAllowed(n.value, allowed, 0.01))
    .map((n) => n.raw);

  const total_duration = scenes.reduce((a, s) => a + (Number(s.duration_sec) || 0), 0);
  const last_end = scenes.reduce((a, s) => Math.max(a, Number(s.end_sec) || 0), 0);
  const target = entry.duration_sec;

  const exemplars = Array.isArray(draft.exemplars) ? draft.exemplars : [];
  const scriptToks = tokens(scenes.map((s) => s.voiceover || '').join(' '));
  let leak = { max_jaccard: 0, max_shared_5grams: 0, worst_exemplar: null };
  for (const ex of exemplars) {
    const t = tokens(ex.transcript || ex.transcript_text || '');
    if (t.length < 5) continue;
    const j = jaccard(scriptToks, t);
    const g = sharedNgrams(scriptToks, t, 5).shared;
    if (j > leak.max_jaccard || g > leak.max_shared_5grams) leak = { max_jaccard: Math.max(j, leak.max_jaccard), max_shared_5grams: Math.max(g, leak.max_shared_5grams), worst_exemplar: ex.id || ex.content_post_id || null };
  }

  const facts = draft.facts || r.facts || {};
  const readiness_reported = facts.readiness ?? null;
  const sold_out_reported = typeof facts.sold_out === 'boolean' ? facts.sold_out : null;
  const rhetorical_pass = checks.length ? checks.filter((c) => c.level !== 'fail').length / checks.length : null;
  const judge_pass = judge ? judge.overall === 'pass' : null;
  const entity_hits = entities.length + mnc_hits.length + phonesInText.length;

  const gates = {
    hard_fail: hard_fail.length === 0,
    entities: entity_hits === 0,
    rhetorical: rhetorical_pass == null ? null : rhetorical_pass >= GATES.script.rhetorical_pass,
    leakage: leak.max_jaccard < GATES.script.exemplar_jaccard && leak.max_shared_5grams < 3,
    judge: judge_pass,
    refusal: exp.expect_pipeline_refusal ? false : null, // produced a draft where a refusal was expected
  };
  gates.pass = Object.values(gates).every((v) => v !== false);

  return {
    ...base,
    status: 'ok',
    draft_id: draft.id ?? null,
    final: review.final ?? null,
    repaired: review.repaired ?? null,
    validator: {
      claims_total: claims.length,
      fail_by_class: countBy(fails, (c) => c.class),
      review_by_class: countBy(reviews, (c) => c.class),
      hard_fail_count: hard_fail.length,
      hard_fails: hard_fail.map((c) => ({ scene: c.scene, mention: c.mention, class: c.class, reason: c.reason })),
      entities: entities.map((e) => ({ scene: e.scene, mention: e.mention, kind: e.kind })),
      checks_fail: checks.filter((c) => c.level === 'fail').map((c) => c.key),
      checks_warn: checks.filter((c) => c.level === 'warn').map((c) => c.key),
      rhetorical_pass,
    },
    entity_hits,
    must_not_contain_hits: mnc_hits,
    phones_in_text: phonesInText,
    unexpected_numbers,
    readiness: { expected: exp.readiness, reported: readiness_reported, match: readiness_reported == null ? null : readiness_reported === exp.readiness },
    sold_out: { expected: exp.sold_out, reported: sold_out_reported, match: sold_out_reported == null ? null : sold_out_reported === exp.sold_out },
    judge: judge ? { overall: judge.overall, dialect: judge.dialect, hook: judge.hook, progression: judge.progression, fit: judge.fit, completeness: judge.completeness, notes: judge.notes?.length ?? 0 } : null,
    scenes: { count: scenes.length, total_duration_sec: total_duration, last_end_sec: last_end, target_sec: target, duration_dev: target ? (total_duration - target) / target : null, purposes: scenes.map((s) => s.purpose) },
    hooks: Array.isArray(draft.hooks) ? draft.hooks.length : 0,
    exemplars_used: exemplars.length,
    leakage: leak,
    latency_ms: r.latency_ms ?? res.wall_ms ?? null,
    cost_usd: r.cost_usd ?? null,
    roles: r.roles ?? null,
    gates,
    refusal_expected: exp.expect_pipeline_refusal,
    refusal_correct: !exp.expect_pipeline_refusal,
    // Full scenes kept for score-scripts.mjs (human rubric) — never truncated.
    draft_scenes: scenes.map((s) => ({ order: s.order, purpose: s.purpose, duration_sec: s.duration_sec, voiceover: s.voiceover, on_screen_text: s.on_screen_text, visual: s.visual, fact_refs: s.fact_refs, warnings: s.warnings })),
    draft_hooks: draft.hooks ?? [],
  };
}

// ── cv-role scoring ─────────────────────────────────────────────────────────
function scoreCvRun(item, model, res) {
  const base = { entry_id: item.id, golden_id: item.golden_id, kind: item.kind, model: modelLabel(model), role_config: model };
  if (res.unavailable) return { ...base, status: 'unavailable', reason: res.reason };
  if (!res.ok) return { ...base, status: 'error', error: res.error, error_kind: res.kind ?? null, latency_ms: res.wall_ms ?? null };
  const r = res.result || {};
  const out = r.output || {};
  const labels = Array.isArray(out.labels) ? out.labels : Array.isArray(out.tags) ? out.tags : [];
  const inVocab = labels.filter((l) => VOCAB_SET.has(String(l)));
  const summary = out.summary || out.description || '';
  return {
    ...base,
    status: 'ok',
    labels,
    vocab_compliance: labels.length ? inVocab.length / labels.length : null,
    off_vocab: labels.filter((l) => !VOCAB_SET.has(String(l))),
    summary_chars: String(summary).length,
    has_ocr: Boolean(out.ocr_text || out.ocr),
    latency_ms: r.latency_ms ?? res.wall_ms ?? null,
    cost_usd: r.cost_usd ?? null,
    roles: r.roles ?? null,
    output: out,
  };
}

// ── item loading ────────────────────────────────────────────────────────────
async function loadItems() {
  const set = JSON.parse(readFileSync(join(ROOT, SET), 'utf8'));
  if (isScriptRole) {
    let entries = set.entries || [];
    if (ONLY) entries = entries.filter((e) => ONLY.has(e.id));
    return { set, items: entries.slice(0, LIMIT) };
  }
  // cv roles: resolve representative frames / shots for the golden videos.
  const sb = serviceClient('run-role-matrix');
  const ids = (set.videos || []).filter((v) => !ONLY || ONLY.has(v.golden_id)).map((v) => v.content_media_id);
  const { data: videos, error } = await sb.from('mkt_cv_videos').select('id,content_media_id,status,shot_count').in('content_media_id', ids);
  if (error) throw new Error(`mkt_cv_videos: ${error.message}`);
  if (!videos.length) return { set, items: [], note: 'no mkt_cv_videos rows exist for the golden set yet — run the ingest (Gate B) first' };
  const byMedia = new Map(videos.map((v) => [v.content_media_id, v]));
  const shots = await pageAll((a, b) => sb.from('mkt_cv_shots').select('id,video_id,shot_no,representative_frame_id,is_micro').in('video_id', videos.map((v) => v.id)).order('video_id').order('shot_no').range(a, b));
  const items = [];
  for (const g of set.videos) {
    const v = byMedia.get(g.content_media_id);
    if (!v) continue;
    for (const s of shots.filter((s) => s.video_id === v.id && !s.is_micro)) {
      if (role === 'frame_describer') {
        if (!s.representative_frame_id) continue;
        items.push({ id: `${g.golden_id}/shot${s.shot_no}/frame`, golden_id: g.golden_id, kind: 'frame', input: { role, frame_id: s.representative_frame_id, shot_id: s.id, video_id: v.id } });
      } else {
        items.push({ id: `${g.golden_id}/shot${s.shot_no}`, golden_id: g.golden_id, kind: 'shot', input: { role, shot_id: s.id, video_id: v.id } });
      }
    }
  }
  // Spread the cap across videos (round-robin) so --limit 30 is not 30 shots of G01.
  const byVideo = new Map();
  for (const it of items) { if (!byVideo.has(it.golden_id)) byVideo.set(it.golden_id, []); byVideo.get(it.golden_id).push(it); }
  const spread = [];
  for (let i = 0; spread.length < Math.min(LIMIT, items.length); i++) {
    let any = false;
    for (const list of byVideo.values()) if (list[i]) { spread.push(list[i]); any = true; if (spread.length >= LIMIT) break; }
    if (!any) break;
  }
  return { set, items: spread };
}

// ── summaries ───────────────────────────────────────────────────────────────
const mean = (xs) => { const v = xs.filter((x) => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const p50 = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const rate = (xs) => { const v = xs.filter((x) => typeof x === 'boolean'); return v.length ? v.filter(Boolean).length / v.length : null; };
const fmt = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : typeof x === 'number' ? x.toFixed(d) : String(x));
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);

function summariseScript(runs) {
  const byModel = {};
  for (const m of MODELS) {
    const rs = runs.filter((r) => r.model === modelLabel(m));
    const ok = rs.filter((r) => r.status === 'ok');
    const s = {
      model: modelLabel(m), runs: rs.length,
      ok: ok.length, refused: rs.filter((r) => r.status === 'refused').length, error: rs.filter((r) => r.status === 'error').length, unavailable: rs.filter((r) => r.status === 'unavailable').length,
      refusal_correct_rate: rate(rs.map((r) => r.refusal_correct)),
      hard_fail_total: ok.reduce((a, r) => a + r.validator.hard_fail_count, 0),
      hard_fail_runs: ok.filter((r) => r.validator.hard_fail_count > 0).length,
      entity_hit_runs: ok.filter((r) => r.entity_hits > 0).length,
      unexpected_number_runs: ok.filter((r) => r.unexpected_numbers.length > 0).length,
      rhetorical_pass_mean: mean(ok.map((r) => r.validator.rhetorical_pass)),
      leakage_runs: ok.filter((r) => !r.gates.leakage).length,
      max_exemplar_jaccard: ok.length ? Math.max(...ok.map((r) => r.leakage.max_jaccard)) : null,
      judge_pass_rate: rate(ok.map((r) => r.gates.judge)),
      judge: { dialect: mean(ok.map((r) => r.judge?.dialect)), hook: mean(ok.map((r) => r.judge?.hook)), progression: mean(ok.map((r) => r.judge?.progression)), fit: mean(ok.map((r) => r.judge?.fit)), completeness: mean(ok.map((r) => r.judge?.completeness)) },
      readiness_match_rate: rate(ok.map((r) => r.readiness.match)),
      repaired_runs: ok.filter((r) => r.repaired).length,
      needs_attention_runs: ok.filter((r) => r.final === 'needs_attention').length,
      scenes_mean: mean(ok.map((r) => r.scenes.count)),
      duration_dev_mean: mean(ok.map((r) => r.scenes.duration_dev)),
      latency_p50_ms: p50(rs.map((r) => r.latency_ms)),
      latency_mean_ms: mean(rs.map((r) => r.latency_ms)),
      cost_total_usd: ok.some((r) => r.cost_usd == null) ? null : ok.reduce((a, r) => a + (r.cost_usd || 0), 0),
      cost_unknown_runs: ok.filter((r) => r.cost_usd == null).length,
    };
    s.gates = {
      hard_fail: s.hard_fail_total === 0,
      entities: s.entity_hit_runs === 0,
      rhetorical: s.rhetorical_pass_mean == null ? null : s.rhetorical_pass_mean >= GATES.script.rhetorical_pass,
      leakage: s.leakage_runs === 0,
      judge: s.judge_pass_rate == null ? null : s.judge_pass_rate >= GATES.script.judge_pass_rate,
      refusals: s.refusal_correct_rate == null ? null : s.refusal_correct_rate === 1,
    };
    s.gates.pass = ok.length > 0 && Object.values(s.gates).every((v) => v !== false);
    byModel[s.model] = s;
  }
  return byModel;
}

function summariseCv(runs) {
  const byModel = {};
  for (const m of MODELS) {
    const rs = runs.filter((r) => r.model === modelLabel(m));
    const ok = rs.filter((r) => r.status === 'ok');
    byModel[modelLabel(m)] = {
      model: modelLabel(m), runs: rs.length, ok: ok.length, error: rs.filter((r) => r.status === 'error').length, unavailable: rs.filter((r) => r.status === 'unavailable').length,
      vocab_compliance_mean: mean(ok.map((r) => r.vocab_compliance)),
      off_vocab_total: ok.reduce((a, r) => a + r.off_vocab.length, 0),
      labels_mean: mean(ok.map((r) => r.labels.length)),
      summary_chars_mean: mean(ok.map((r) => r.summary_chars)),
      latency_p50_ms: p50(rs.map((r) => r.latency_ms)),
      cost_total_usd: ok.some((r) => r.cost_usd == null) ? null : ok.reduce((a, r) => a + (r.cost_usd || 0), 0),
    };
  }
  // Cross-model agreement on the same item (label-set Jaccard, pairwise mean).
  const byItem = new Map();
  for (const r of runs) if (r.status === 'ok') { if (!byItem.has(r.entry_id)) byItem.set(r.entry_id, []); byItem.get(r.entry_id).push(r); }
  const agree = [];
  for (const rs of byItem.values()) for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) agree.push(jaccard(rs[i].labels, rs[j].labels));
  return { byModel, cross_model_label_agreement_mean: mean(agree) };
}

// ── markdown ────────────────────────────────────────────────────────────────
function mdScript(meta, summary, runs) {
  const L = [];
  L.push(`# Role matrix — \`${role}\` — ${meta.date}`, '');
  L.push(`Set: \`${SET}\` (${meta.items} briefs) · models: ${MODELS.map(modelLabel).join(', ')}${role === 'script_reviewer' ? ` · fixed writer: ${modelLabel(WRITER)}` : ''} · generated ${meta.generated_at}`, '');
  if (meta.note) L.push(`> ${meta.note}`, '');
  L.push('## Per-model summary', '');
  L.push('| Model | runs ok/ref/err/n.a. | refusals ✓ | hard FAILs (runs) | entity-hit runs | unexpected-number runs | rhetorical | leakage runs (max J) | judge pass | dialect/hook/prog/fit/compl | readiness ✓ | repaired | scenes | Δduration | p50 latency | cost | GATE |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of Object.values(summary)) {
    const j = s.judge;
    L.push(`| ${s.model} | ${s.ok}/${s.refused}/${s.error}/${s.unavailable} | ${pct(s.refusal_correct_rate)} | ${s.hard_fail_total} (${s.hard_fail_runs}) | ${s.entity_hit_runs} | ${s.unexpected_number_runs} | ${pct(s.rhetorical_pass_mean)} | ${s.leakage_runs} (${fmt(s.max_exemplar_jaccard)}) | ${pct(s.judge_pass_rate)} | ${fmt(j.dialect, 1)}/${fmt(j.hook, 1)}/${fmt(j.progression, 1)}/${fmt(j.fit, 1)}/${fmt(j.completeness, 1)} | ${pct(s.readiness_match_rate)} | ${s.repaired_runs} | ${fmt(s.scenes_mean, 1)} | ${s.duration_dev_mean == null ? '—' : pct(s.duration_dev_mean)} | ${s.latency_p50_ms == null ? '—' : (s.latency_p50_ms / 1000).toFixed(1) + ' s'} | ${s.cost_total_usd == null ? `— (${s.cost_unknown_runs} unknown)` : '$' + s.cost_total_usd.toFixed(3)} | ${s.gates.pass ? 'PASS' : 'FAIL'} |`);
  }
  L.push('', `Gates (docs/eval/README.md): hard-class claim FAILs = 0 after repair · entity hits = 0 · rhetorical pass ≥ 95% · exemplar Jaccard < 0.3 and < 3 shared 5-grams · judge pass ≥ 80% · every expected refusal refused.`, '');
  L.push('## Per-brief results', '');
  L.push(`| Brief | Recipe | Expected | ${MODELS.map(modelLabel).join(' | ')} |`);
  L.push(`|---|---|---|${MODELS.map(() => '---').join('|')}|`);
  const items = [...new Set(runs.map((r) => r.entry_id))];
  for (const id of items) {
    const rs = runs.filter((r) => r.entry_id === id);
    const first = rs[0];
    const cells = MODELS.map((m) => {
      const r = rs.find((x) => x.model === modelLabel(m));
      if (!r) return '—';
      if (r.status === 'unavailable') return 'n/a';
      if (r.status === 'refused') return `refused (${r.refusal_correct ? 'expected' : 'UNEXPECTED'})`;
      if (r.status === 'error') return `ERROR: ${String(r.error).slice(0, 60)}`;
      return `${r.gates.pass ? 'ok' : 'FAIL'} · F${r.validator.hard_fail_count} E${r.entity_hits} N${r.unexpected_numbers.length} · rh ${pct(r.validator.rhetorical_pass)} · J ${r.judge ? r.judge.overall : '—'} · ${r.scenes.count}sc/${r.scenes.total_duration_sec}s · ${r.readiness.match === false ? 'readiness≠' : ''}${r.leakage.max_jaccard >= 0.3 ? ' LEAK' : ''} · ${r.latency_ms == null ? '' : (r.latency_ms / 1000).toFixed(0) + 's'}`;
    });
    L.push(`| ${id} ${first.project_name || ''} | ${first.recipe} | ${first.refusal_expected ? 'REFUSE' : ''} | ${cells.join(' | ')} |`);
  }
  L.push('', 'Cell key: F = hard-class claim FAILs · E = entity hits (validator + must_not_contain + phones) · N = numbers ≥ 1000 not traceable to a project fact · rh = rhetorical checks passing · J = judge overall.', '');
  const failing = runs.filter((r) => r.status === 'ok' && (r.validator.hard_fail_count || r.entity_hits || r.unexpected_numbers.length));
  if (failing.length) {
    L.push('## Flagged claims / entities', '');
    for (const r of failing) {
      L.push(`- **${r.entry_id} · ${r.model}**`);
      for (const f of r.validator.hard_fails) L.push(`  - FAIL [${f.class}] scene ${f.scene}: «${f.mention}» — ${f.reason}`);
      for (const e of r.validator.entities) L.push(`  - ENTITY [${e.kind}] scene ${e.scene}: «${e.mention}»`);
      for (const s of r.must_not_contain_hits) L.push(`  - must_not_contain hit: «${s}»`);
      for (const p of r.phones_in_text) L.push(`  - phone in text: ${p}`);
      for (const n of r.unexpected_numbers) L.push(`  - untraceable number: «${n}»`);
    }
    L.push('');
  }
  L.push(`Human rubric ratings: \`node scripts/eval/score-scripts.mjs --results ${OUT_JSON}\``, '');
  return L.join('\n');
}

function mdCv(meta, summary, runs) {
  const L = [];
  L.push(`# Role matrix — \`${role}\` — ${meta.date}`, '');
  L.push(`Set: \`${SET}\` → ${meta.items} items · models: ${MODELS.map(modelLabel).join(', ')} · generated ${meta.generated_at}`, '');
  if (meta.note) L.push(`> ${meta.note}`, '');
  L.push('| Model | runs ok/err/n.a. | vocab compliance | off-vocab labels | labels/item | summary chars | p50 latency | cost |', '|---|---|---|---|---|---|---|---|');
  for (const s of Object.values(summary.byModel)) L.push(`| ${s.model} | ${s.ok}/${s.error}/${s.unavailable} | ${pct(s.vocab_compliance_mean)} | ${s.off_vocab_total} | ${fmt(s.labels_mean, 1)} | ${fmt(s.summary_chars_mean, 0)} | ${s.latency_p50_ms == null ? '—' : (s.latency_p50_ms / 1000).toFixed(1) + ' s'} | ${s.cost_total_usd == null ? '—' : '$' + s.cost_total_usd.toFixed(3)} |`);
  L.push('', `Cross-model label agreement (pairwise Jaccard on the same item): ${fmt(summary.cross_model_label_agreement_mean)}`, '');
  L.push('## Per-item outputs', '');
  const items = [...new Set(runs.map((r) => r.entry_id))];
  for (const id of items) {
    L.push(`### ${id}`);
    for (const r of runs.filter((x) => x.entry_id === id)) {
      if (r.status !== 'ok') { L.push(`- **${r.model}**: ${r.status}${r.error ? ' — ' + r.error : ''}${r.reason ? ' — ' + r.reason : ''}`); continue; }
      L.push(`- **${r.model}** (${r.latency_ms == null ? '' : (r.latency_ms / 1000).toFixed(1) + ' s'}${r.cost_usd == null ? '' : ', $' + r.cost_usd.toFixed(4)}): labels ${r.labels.join(', ') || '—'}${r.off_vocab.length ? ` · OFF-VOCAB: ${r.off_vocab.join(', ')}` : ''}`);
      const summ = r.output.summary || r.output.description; if (summ) L.push(`  - ${String(summ).replace(/\n/g, ' ')}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const { set, items, note } = await loadItems();
  if (!items.length) {
    console.log(`No items to run (${note || 'empty set / --only matched nothing'}).`);
  }
  const plan = [];
  for (const it of items) for (const m of MODELS) plan.push({ it, m });
  console.log(`role=${role} · ${items.length} items × ${MODELS.length} models = ${plan.length} calls · concurrency ${CONCURRENCY}${DRY ? ' · DRY RUN' : ''}`);
  if (DRY) {
    for (const it of items) console.log(`  ${it.id}${isScriptRole ? ` ${it.recipe} ${it.project_name}${it.content_id ? '' : ' (synthesised brief)'}` : ''}`);
    const entry = isScriptRole ? join(ROOT, 'worker/src/marketing/script/evalEntry.ts') : join(ROOT, 'worker/src/marketing/cv/evalEntry.ts');
    console.log(existsSync(entry) ? `pipeline entry present: ${entry}` : `pipeline not available yet: ${entry} does not exist — runs would be recorded as 'unavailable'`);
    return;
  }

  const runs = [];
  let idx = 0, availabilityNote = null;
  async function worker() {
    while (idx < plan.length) {
      const { it, m } = plan[idx++];
      const t0 = Date.now();
      let res;
      if (isScriptRole) {
        const roleOverrides = role === 'script_writer' ? { script_writer: m } : { script_writer: WRITER, script_reviewer: m };
        res = await callBridge({ kind: 'script', input: { content_id: it.content_id, project_id: it.project_id, recipe: it.recipe, duration_sec: it.duration_sec }, roleOverrides });
        runs.push(scoreScriptRun(it, m, res));
      } else {
        res = await callBridge({ kind: 'cv', input: it.input, roleOverrides: { [role]: m } });
        runs.push(scoreCvRun(it, m, res));
      }
      const last = runs[runs.length - 1];
      if (last.status === 'unavailable' && !availabilityNote) { availabilityNote = `pipeline not available yet — ${last.reason}`; console.log(availabilityNote); }
      console.log(`[${runs.length}/${plan.length}] ${it.id} × ${modelLabel(m)} → ${last.status}${last.status === 'ok' && isScriptRole ? ` (F${last.validator.hard_fail_count} E${last.entity_hits} J:${last.judge?.overall ?? '—'} ${last.scenes.count}sc)` : ''}${last.error ? ` — ${String(last.error).slice(0, 120)}` : ''} ${Date.now() - t0} ms`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, plan.length)) }, worker));

  // Stable order: by item then by model order given.
  const order = new Map(items.map((it, i) => [it.id, i]));
  runs.sort((a, b) => (order.get(a.entry_id) - order.get(b.entry_id)) || (MODELS.findIndex((m) => modelLabel(m) === a.model) - MODELS.findIndex((m) => modelLabel(m) === b.model)));

  const meta = { role, date: todayStamp(), generated_at: new Date().toISOString(), set: SET, set_generated_at: set.generated_at ?? null, items: items.length, models: MODELS, writer: role === 'script_reviewer' ? WRITER : null, note: availabilityNote || note || null, gates: GATES };
  const summary = isScriptRole ? summariseScript(runs) : summariseCv(runs);
  mkdirSync(dirname(join(ROOT, OUT_JSON)), { recursive: true });
  writeFileSync(join(ROOT, OUT_JSON), JSON.stringify({ meta, summary, runs }, null, 2) + '\n');
  writeFileSync(join(ROOT, OUT_MD), (isScriptRole ? mdScript(meta, summary, runs) : mdCv(meta, summary, runs)) + '\n');
  console.log(`wrote ${OUT_JSON} and ${OUT_MD}`);
  if (isScriptRole) for (const s of Object.values(summary)) console.log(`  ${s.model}: ok ${s.ok} refused ${s.refused} error ${s.error} n/a ${s.unavailable} · hard FAILs ${s.hard_fail_total} · entity-hit runs ${s.entity_hit_runs} · judge pass ${pct(s.judge_pass_rate)} · GATE ${s.gates.pass ? 'PASS' : 'FAIL'}`);
  else for (const s of Object.values(summary.byModel)) console.log(`  ${s.model}: ok ${s.ok} error ${s.error} n/a ${s.unavailable} · vocab ${pct(s.vocab_compliance_mean)}`);
  if (runs.some((r) => r.status === 'error')) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
