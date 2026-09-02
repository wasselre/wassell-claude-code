#!/usr/bin/env node
/**
 * creative-compare.mjs — comparison table across creative eval result files.
 *
 *   node scripts/eval/creative-compare.mjs [--results-dir docs/eval/results] [--glob substring]
 *
 * Reads every docs/eval/results/*.jsonl (optionally filtered by --glob) and
 * prints one markdown table: file, set, stage mix, model(s), items, ran vs
 * facts-only, validator / grounding / rule pass rates, median latency, total
 * cost (null-aware — an unknown part makes the total "unknown", never "0"),
 * tokens.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, ROOT } from './_lib/env.mjs';

function die(msg) {
  console.error(`\n[creative-compare] ${msg}\n`);
  process.exit(1);
}

const pct = (pass, total) => (total === 0 ? '—' : `${Math.round((pass / total) * 100)}%`);
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function summarize(file, lines) {
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      console.error(`[creative-compare] ${file}: skipping a non-JSON line: ${t.slice(0, 120)}`);
    }
  }
  const ran = rows.filter((r) => r.director === 'ran');
  const missing = rows.filter((r) => r.director === 'missing');
  const errored = rows.filter((r) => r.error);
  const judged = ran.filter((r) => r.validator_pass !== null && r.validator_pass !== undefined);
  const pass = (key) => judged.filter((r) => r[key] === true).length;
  const lat = median(ran.map((r) => r.latency_ms).filter((n) => typeof n === 'number'));
  let cost = 0;
  let costUnknown = false;
  for (const r of ran) {
    if (typeof r.cost_usd === 'number') cost += r.cost_usd;
    else if (r.cost_usd === null) costUnknown = true;
  }
  const tokIn = ran.reduce((a, r) => a + (r.usage?.in ?? 0), 0);
  const tokOut = ran.reduce((a, r) => a + (r.usage?.out ?? 0), 0);
  const models = [...new Set(rows.map((r) => r.model).filter(Boolean))];
  const sets = [...new Set(rows.map((r) => r.set).filter(Boolean))];
  const stages = [...new Set(rows.map((r) => r.stage).filter(Boolean))];
  return {
    file,
    set: sets.join(',') || '—',
    stages: stages.join(',') || '—',
    model: models.join(',') || '—',
    items: rows.length,
    ran: ran.length,
    factsOnly: missing.length,
    errors: errored.length,
    validator: pct(pass('validator_pass'), judged.length),
    grounding: pct(pass('grounding_pass'), judged.length),
    rule: pct(pass('rule_pass'), judged.length),
    medianLatency: lat === null ? '—' : `${Math.round(lat / 100) / 10}s`,
    cost: ran.length === 0 ? '—' : costUnknown ? `$${cost.toFixed(4)}+?` : `$${cost.toFixed(4)}`,
    tokens: `${tokIn}/${tokOut}`,
  };
}

async function main() {
  const args = parseArgs();
  const dir = join(ROOT, String(args['results-dir'] ?? 'docs/eval/results'));
  if (!existsSync(dir)) die(`results dir not found: ${dir} — run scripts/eval/creative-run.mjs first`);
  const glob = args.glob ? String(args.glob) : null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && (!glob || f.includes(glob)))
    .sort();
  if (files.length === 0) die(`no .jsonl result files in ${dir}${glob ? ` matching '${glob}'` : ''}`);

  const rows = files.map((f) => summarize(f, readFileSync(join(dir, f), 'utf8').split('\n')));
  const head = ['file', 'set', 'stage', 'model', 'items', 'ran', 'facts-only', 'errors', 'validator', 'grounding', 'rule', 'p50 latency', 'cost', 'tok in/out'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String([r.file, r.set, r.stages, r.model, r.items, r.ran, r.factsOnly, r.errors, r.validator, r.grounding, r.rule, r.medianLatency, r.cost, r.tokens][i]).length)));
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(fmt(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log(fmt([r.file, r.set, r.stages, r.model, r.items, r.ran, r.factsOnly, r.errors, r.validator, r.grounding, r.rule, r.medianLatency, r.cost, r.tokens]));
  }
}

main().catch((e) => die(e.stack || e.message));
