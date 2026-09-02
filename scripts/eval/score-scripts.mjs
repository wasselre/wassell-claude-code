#!/usr/bin/env node
/**
 * scripts/eval/score-scripts.mjs — human rubric scoring for script drafts.
 *
 * Reads a results file written by run-role-matrix.mjs (role script_writer or
 * script_reviewer), shows every model's draft for one brief SIDE BY SIDE
 * (scene by scene: voiceover / on-screen text / visual), and records 1–5
 * ratings into the same JSON under `runs[i].human`:
 *
 *   script_quality      1 = unusable … 5 = ready to hand to production
 *   saudi_arabic        1 = MSA/foreign/awkward … 5 = natural Saudi marketing voice
 *   editing_required    1 = rewrite from scratch … 5 = no edits needed
 *   note                free text (optional)
 *
 *   node scripts/eval/score-scripts.mjs --results docs/eval/results/2026-09-02-script_writer.json
 *        [--rater rayan] [--entry S03] [--model claude-opus-5] [--resume] [--blind]
 *
 * --blind hides the model names (A/B/C, shuffled per brief with a fixed seed)
 * so ratings are not anchored on the model id; the mapping is kept in
 * `human_blind_map` in the JSON. --resume skips runs the same rater already
 * scored. Saves after every brief; Ctrl-C loses at most the current brief.
 *
 * Afterwards the per-model means are written to `summary[model].human` and
 * appended to the sibling .md as a "Human ratings" section.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, ROOT } from './_lib/env.mjs';

const args = parseArgs();
if (!args.results) { console.error('--results <file.json> is required'); process.exit(2); }
const FILE = join(ROOT, String(args.results));
const RATER = String(args.rater || process.env.USERNAME || process.env.USER || 'anonymous');
const ENTRY = args.entry ? String(args.entry) : null;
const MODEL = args.model ? String(args.model) : null;
const RESUME = Boolean(args.resume);
const BLIND = Boolean(args.blind);

if (!process.stdin.isTTY) { console.error('score-scripts.mjs is interactive — run it in a terminal'); process.exit(2); }
const data = JSON.parse(readFileSync(FILE, 'utf8'));
if (!Array.isArray(data.runs)) { console.error('not a run-role-matrix results file'); process.exit(2); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

async function askScore(label) {
  for (;;) {
    const a = await ask(`  ${label} (1-5, s=skip): `);
    if (a === 's') return null;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
    console.log('  please enter 1, 2, 3, 4, 5 or s');
  }
}

// Deterministic per-brief shuffle for blind mode.
function seededShuffle(arr, seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; const j = h % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const wrap = (s, w = 100) => String(s || '').replace(new RegExp(`(.{1,${w}})(\\s+|$)`, 'g'), '$1\n').trimEnd();

function showDraft(run, label) {
  console.log(`\n══════════ ${label} ══════════`);
  if (run.status !== 'ok') { console.log(`  (${run.status}${run.error ? ': ' + run.error : ''})`); return; }
  console.log(`  ${run.scenes.count} scenes · ${run.scenes.total_duration_sec}s (target ${run.scenes.target_sec}s) · validator F${run.validator.hard_fail_count} E${run.entity_hits} · judge ${run.judge?.overall ?? '—'}`);
  if (run.draft_hooks?.length) console.log(`  hooks: ${run.draft_hooks.map((h, i) => `[${i}] ${h}`).join(' | ')}`);
  for (const s of run.draft_scenes || []) {
    console.log(`\n  #${s.order} [${s.purpose}] ${s.duration_sec}s`);
    console.log(`    VO : ${wrap(s.voiceover).replace(/\n/g, '\n         ')}`);
    if (s.on_screen_text) console.log(`    OST: ${wrap(s.on_screen_text).replace(/\n/g, '\n         ')}`);
    console.log(`    VIS: ${wrap(s.visual).replace(/\n/g, '\n         ')}`);
    if (s.warnings?.length) console.log(`    ⚠  ${s.warnings.join(' · ')}`);
  }
}

function save() {
  const byModel = {};
  for (const r of data.runs) {
    if (!r.human) continue;
    const m = (byModel[r.model] ||= { n: 0, script_quality: [], saudi_arabic: [], editing_required: [] });
    m.n++;
    for (const k of ['script_quality', 'saudi_arabic', 'editing_required']) if (Number.isFinite(r.human[k])) m[k].push(r.human[k]);
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const summaryTarget = data.summary?.byModel ?? data.summary ?? {};
  for (const [model, m] of Object.entries(byModel)) {
    const human = { rated: m.n, script_quality: mean(m.script_quality), saudi_arabic: mean(m.saudi_arabic), editing_required: mean(m.editing_required) };
    if (summaryTarget[model]) summaryTarget[model].human = human;
    else summaryTarget[model] = { model, human };
  }
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  const md = FILE.replace(/\.json$/, '.md');
  if (existsSync(md)) {
    let txt = readFileSync(md, 'utf8');
    const marker = '## Human ratings';
    const i = txt.indexOf(marker);
    if (i >= 0) txt = txt.slice(0, i);
    const rows = Object.entries(byModel).map(([model, m]) => `| ${model} | ${m.n} | ${fmt(mean(m.script_quality))} | ${fmt(mean(m.saudi_arabic))} | ${fmt(mean(m.editing_required))} |`);
    txt = `${txt.trimEnd()}\n\n${marker}\n\nScale 1–5 (5 = best / no edits). Raters: ${[...new Set(data.runs.filter((r) => r.human).map((r) => r.human.rater))].join(', ')}.\n\n| Model | rated | script quality | Saudi Arabic | editing required |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
    writeFileSync(md, txt);
  }
}
const fmt = (x) => (x == null ? '—' : x.toFixed(2));

async function main() {
  const entries = [...new Set(data.runs.map((r) => r.entry_id))].filter((id) => !ENTRY || id === ENTRY);
  data.human_blind_map ||= {};
  let rated = 0;
  for (const id of entries) {
    let runs = data.runs.filter((r) => r.entry_id === id && (!MODEL || r.model === MODEL));
    if (RESUME) runs = runs.filter((r) => !(r.human && r.human.rater === RATER));
    if (!runs.length) continue;
    const first = data.runs.find((r) => r.entry_id === id);
    console.log(`\n\n################ ${id} — ${first.project_name || ''} — recipe ${first.recipe} ################`);
    const order = BLIND ? seededShuffle(runs, `${id}:${FILE}`) : runs;
    const labels = order.map((r, i) => (BLIND ? `Draft ${String.fromCharCode(65 + i)}` : r.model));
    if (BLIND) data.human_blind_map[id] = Object.fromEntries(order.map((r, i) => [String.fromCharCode(65 + i), r.model]));
    order.forEach((r, i) => showDraft(r, labels[i]));
    for (let i = 0; i < order.length; i++) {
      const r = order[i];
      if (r.status !== 'ok') continue;
      console.log(`\n→ Rate ${labels[i]}`);
      const script_quality = await askScore('script quality');
      const saudi_arabic = await askScore('Saudi-Arabic quality');
      const editing_required = await askScore('editing required (5 = none)');
      const note = await ask('  note (enter to skip): ');
      r.human = { rater: RATER, rated_at: new Date().toISOString(), blind: BLIND, script_quality, saudi_arabic, editing_required, note: note || null };
      rated++;
    }
    save();
    console.log(`saved (${rated} ratings so far)`);
  }
  rl.close();
  console.log(`\nDone — ${rated} ratings by ${RATER} written to ${FILE}`);
  const st = data.summary?.byModel ?? data.summary ?? {};
  for (const [model, s] of Object.entries(st)) if (s.human) console.log(`  ${model}: quality ${fmt(s.human.script_quality)} · Saudi ${fmt(s.human.saudi_arabic)} · editing ${fmt(s.human.editing_required)} (n=${s.human.rated})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
