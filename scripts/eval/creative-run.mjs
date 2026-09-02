#!/usr/bin/env node
/**
 * creative-run.mjs — run the Post Creative Director over an eval set.
 *
 *   node scripts/eval/creative-run.mjs --set creative-eval-set --stage concepts
 *   node scripts/eval/creative-run.mjs --set creative-eval-set --stage package --provider anthropic --model claude-opus-5
 *   node scripts/eval/creative-run.mjs --set creative-eval-set --stage derivatives --limit 4
 *
 * What it does per brief in the set:
 *   facts (worker sibling buildFactsPackage — the REAL one, via tsx) → A-GEN's
 *   pure director stage (worker/src/creative/director/runDirector.ts) with the
 *   stage's role optionally overridden by --provider/--model → harness-level
 *   validators (A-FACTS grounding.ts when present) → ONE JSONL result line.
 *
 * NO DB WRITES. The only DB access is READS through the service client
 * (project record + mos_settings.ai_roles).
 *
 * Model rule (brief A-AI §4): NOTHING hardcodes a model. --provider/--model
 * come from args; absent → the driver resolves mos_settings.ai_roles; absent
 * there → the non-final CREATIVE_DEFAULTS inside worker/src/creative/roles.ts.
 *
 * Peer-missing posture: when A-GEN's director (or A-FACTS' validators) has not
 * landed yet, the run degrades to FACTS ONLY — each line records
 * director:'missing' and the facts summary, and the script says so at the end.
 *
 * Output: docs/eval/results/<date>-<set>-<model>.jsonl — one JSON object per
 * line: {set, item_id, project_id, recipe, format, stage, provider, model,
 * director, facts, validator_pass, grounding_pass, rule_pass, errors, warnings,
 * latency_ms, cost_usd, usage, roles}.
 *
 * The driver is a generated TS module (docs/eval/.creative-driver.mts, deleted
 * after the run) executed with tsx — the worker's TS modules use bundler-style
 * `.js` specifiers that only tsx resolves. Install worker dev deps
 * (`npm --prefix worker install`) if the tsx probe fails.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serviceClient, parseArgs, todayStamp, requireEnv, ROOT } from './_lib/env.mjs';

const STAGE_ROLE = { concepts: 'creative_concepts', package: 'creative_package', derivatives: 'creative_derivatives' };

function die(msg) {
  console.error(`\n[creative-run] ${msg}\n`);
  process.exit(1);
}

// ── the generated driver (TS, run under tsx) ────────────────────────────────
// Reads the spec JSON path from argv[2]; streams one JSONL result per item to
// stdout. Anything human-readable goes to stderr.
const DRIVER_SOURCE = `
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { buildFactsPackage, loadProjectRecord, resolveLookupName } from '../../worker/src/marketing/script/facts.js';
import {
  callCreativeRole,
  createRoleLedger,
  ledgerToJson,
  type CreativeRoleConfig,
  type CreativeRoleKey,
} from '../../worker/src/creative/roles.js';
import type { CallRequest } from '../../worker/src/ai/index.js';

interface SpecItem {
  id: string; project_id: string; project_name: string | null; category: string;
  recipe: string; format: 'single' | 'carousel'; language: string;
}
interface Spec {
  set: string; stage: 'concepts' | 'package' | 'derivatives';
  stageRole: CreativeRoleKey;
  roleOverride: { provider: string; model: string } | null;
  items: SpecItem[];
}

const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Spec;
const sb = createClient(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
  auth: { persistSession: false },
});

// Peer modules (A-GEN director, A-FACTS grounding + placementSpecs) may not
// exist yet — dynamic import, and the run degrades to facts-only.
async function tryImport(path: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(path)) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(msg)) return null;
    throw err; // a present-but-broken peer is LOUD, not "missing"
  }
}

const director = await tryImport('../../worker/src/creative/director/runDirector.js');
const grounding = await tryImport('../../worker/src/creative/grounding.js');
const placement = await tryImport('../../worker/src/creative/placementSpecs.js');

const emit = (line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + '\\n');
const note = (msg: string) => process.stderr.write(msg + '\\n');

function classifyErrors(errors: Array<{ rule?: string }>): { validator: boolean; grounding: boolean; rule: boolean } {
  let validator = true, groundingOk = true, rule = true;
  for (const e of errors) {
    const r = e.rule ?? '';
    if (/claim|fact|readiness|mention|grounding/i.test(r)) groundingOk = false;
    else if (/prohibited|hashtag|caption|language|entity|blocklist|rule/i.test(r)) rule = false;
    else validator = false;
  }
  return { validator, grounding: groundingOk, rule };
}

const runFn =
  spec.stage === 'concepts' ? director?.runConcepts
  : spec.stage === 'package' ? director?.runPackage
  : director?.runDerivatives;

for (const item of spec.items) {
  const t0 = Date.now();
  const base: Record<string, unknown> = {
    set: spec.set, item_id: item.id, project_id: item.project_id, recipe: item.recipe,
    format: item.format, stage: spec.stage,
    provider: spec.roleOverride?.provider ?? null, model: spec.roleOverride?.model ?? null,
  };
  try {
    const record = await loadProjectRecord(sb as never, item.project_id);
    if (!record) {
      emit({ ...base, director: director ? 'present' : 'missing', error: 'project record not found', latency_ms: Date.now() - t0 });
      continue;
    }
    const developerName = record.developer ? await resolveLookupName(sb as never, record.developer) : null;
    const facts = buildFactsPackage(record, { developerName });
    const factsSummary = {
      project_name: facts.project_name, readiness: facts.readiness, sold_out: facts.sold_out,
      viable: facts.viable, missing: facts.missing, warnings: facts.warnings, fact_count: facts.facts.length,
    };
    if (!director || typeof runFn !== 'function') {
      emit({ ...base, director: 'missing', facts: factsSummary, validator_pass: null, grounding_pass: null, rule_pass: null, latency_ms: Date.now() - t0, cost_usd: null, usage: null, roles: null });
      continue;
    }

    const refs = facts.facts.map((f) => ({ id: f.id, key: f.key, rendered_ar: f.rendered_ar, source_field: f.source_field, claimable: f.claimable }));
    const placementType = item.format === 'carousel' ? 'carousel' : 'feed';
    const targets = [{ target_kind: 'organic', platform: 'instagram', placement_type: placementType, target_ref: {} }];
    const specs = Array.isArray(placement?.PLACEMENT_SPECS)
      ? (placement!.PLACEMENT_SPECS as Array<{ platform: string }>).filter((s) => s.platform === 'instagram')
      : [];

    const ledger = createRoleLedger();
    const override = spec.roleOverride;
    const deps = {
      callRole: (key: CreativeRoleKey, req: CallRequest) =>
        callCreativeRole(key, req, {
          sb: sb as never,
          creativeRoles:
            override && key === spec.stageRole
              ? { [key]: { provider: override.provider, model: override.model } as CreativeRoleConfig }
              : undefined,
        }),
      ledger,
      log: (msg: string) => note(\`[driver \${item.id}] \${msg}\`),
    };
    const input = {
      brief: { content_id: null, project_id: item.project_id, project_ids: [item.project_id], recipe: item.recipe, language: item.language, purpose: 'organic', platforms: ['instagram'] },
      content: { language: item.language, title: item.project_name ?? facts.project_name, content_type_key: item.recipe },
      facts: { package: facts, refs },
      brandKit: null,
      rules: { shared: [], post: [], decisions_log: [] },
      targets,
      specs,
      referenceRows: [],
      assetRows: [],
      ...(spec.stage !== 'concepts' ? { conceptChoice: 'c1' } : {}),
    };

    const out = (await (runFn as (i: unknown, d: unknown) => Promise<Record<string, unknown>>)(input, deps)) as Record<string, unknown>;
    const validation = (out.validation ?? null) as { ok?: boolean; errors?: Array<{ rule?: string }>; warnings?: unknown[] } | null;

    // Harness-level validation with A-FACTS' validators when the director did
    // not return one (or returned none) and grounding.ts is present.
    let harness: { ok: boolean; errors: Array<{ rule?: string }>; warnings: unknown[] } | null = null;
    const validatorFn =
      spec.stage === 'concepts' ? grounding?.validateConcepts
      : spec.stage === 'package' ? grounding?.validateBase
      : grounding?.validateDerivatives;
    if (!validation && typeof validatorFn === 'function' && out.output) {
      harness = (validatorFn as (o: unknown, c: unknown) => typeof harness)(out.output, {
        facts, refs, language: item.language, selectedTargets: targets, specs,
        brandKit: null, rules: { shared: [], post: [], decisions_log: [] },
        blocklist: [], allowedTerms: [], competitorMediaIds: new Set(), assetMeta: new Map(),
      });
    }
    const v = validation ?? harness;
    const buckets = v ? classifyErrors(v.errors ?? []) : { validator: true, grounding: true, rule: true };
    const rolesJson = ledgerToJson(ledger);
    emit({
      ...base,
      director: 'ran',
      facts: factsSummary,
      output: out.output ?? null,
      validator_pass: v ? buckets.validator && (v.ok ?? false) : null,
      grounding_pass: v ? buckets.grounding : null,
      rule_pass: v ? buckets.rule : null,
      errors: v?.errors ?? [],
      warnings: [...(v?.warnings ?? []), ...(((out.needs_attention as boolean | undefined) ? ['needs_attention'] : []) as string[])],
      latency_ms: Date.now() - t0,
      cost_usd: (out.cost as number | null | undefined) ?? (rolesJson.cost_usd as number | null),
      usage: rolesJson.tokens ?? null,
      roles: out.rolesJson ?? rolesJson,
      provider: override?.provider ?? ((rolesJson.roles as Record<string, { provider?: string }> | undefined)?.[spec.stageRole]?.provider ?? null),
      model: override?.model ?? ((rolesJson.roles as Record<string, { model?: string }> | undefined)?.[spec.stageRole]?.model ?? null),
    });
  } catch (err) {
    emit({ ...base, director: director ? 'present' : 'missing', error: err instanceof Error ? err.message : String(err), latency_ms: Date.now() - t0 });
  }
}
if (!director) note('[driver] A-GEN director (worker/src/creative/director/runDirector.ts) is MISSING — facts-only run');
`;

// ── tsx resolution ──────────────────────────────────────────────────────────
function tsxCommand(driverPath) {
  const candidates = [
    join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(ROOT, 'worker', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  for (const c of candidates) if (existsSync(c)) return { cmd: process.execPath, args: [c, driverPath] };
  // Fall back to npx (PATH) — works when tsx is installed globally or hoisted elsewhere.
  return { cmd: 'npx', args: ['tsx', driverPath], shell: true };
}

async function main() {
  const args = parseArgs();
  const set = String(args.set ?? '') || die('--set <name> is required (docs/eval/<name>.json)');
  const stage = String(args.stage ?? '') || die('--stage concepts|package|derivatives is required');
  if (!STAGE_ROLE[stage]) die(`unknown --stage '${stage}' (concepts|package|derivatives)`);
  const provider = args.provider ? String(args.provider) : null;
  const model = args.model ? String(args.model) : null;
  if ((provider && !model) || (!provider && model)) die('--provider and --model must be given together (or neither → ai_roles)');
  const limit = args.limit ? Math.max(1, Number(args.limit)) : null;
  const timeoutMs = (Number(args['timeout-s'] ?? 900) || 900) * 1000;

  const setPath = join(ROOT, 'docs', 'eval', `${set}.json`);
  if (!existsSync(setPath)) die(`set file not found: ${setPath} — run scripts/eval/creative-build-sets.mjs first`);
  // The driver (facts reads + ai_roles resolution) needs these even when
  // --provider/--model are given and the parent never opens a client.
  requireEnv('SUPABASE_URL', 'VITE_SUPABASE_URL');
  requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const setJson = JSON.parse(readFileSync(setPath, 'utf8'));
  let items = setJson.items ?? [];
  if (limit) items = items.slice(0, limit);
  if (items.length === 0) die('set has no items');

  // Model label for the results file: args → live ai_roles → 'defaults'. NEVER
  // a hardcoded model id (brief: model from args or ai_roles).
  let modelLabel = model;
  let providerLabel = provider;
  if (!modelLabel) {
    const db = serviceClient('creative-run');
    const { data, error } = await db.from('mos_settings').select('value').eq('key', 'ai_roles').maybeSingle();
    if (error) die(`mos_settings.ai_roles read failed: ${error.message}`);
    const cfg = data?.value?.[STAGE_ROLE[stage]];
    modelLabel = cfg?.model ?? 'defaults';
    providerLabel = cfg?.provider ?? 'defaults';
  }
  const safe = (s) => String(s).replace(/[^a-z0-9._-]+/gi, '_');

  const evalDir = join(ROOT, 'docs', 'eval');
  const driverPath = join(evalDir, '.creative-driver.mts');
  const specPath = join(evalDir, '.creative-run-spec.json');
  const resultsDir = join(evalDir, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const resultsPath = join(resultsDir, `${todayStamp()}-${safe(set)}-${safe(modelLabel)}.jsonl`);

  const spec = { set, stage, stageRole: STAGE_ROLE[stage], roleOverride: provider ? { provider, model } : null, items };
  writeFileSync(driverPath, DRIVER_SOURCE, 'utf8');
  writeFileSync(specPath, JSON.stringify(spec), 'utf8');

  console.log(`[creative-run] ${items.length} items · stage=${stage} · role=${providerLabel}/${modelLabel}`);
  console.log(`[creative-run] results → ${resultsPath}`);

  let buffer = '';
  let lines = 0;
  let sawDirectorMissing = false;
  writeFileSync(resultsPath, '', 'utf8'); // truncate any stale results from an earlier run today

  const { cmd, args: cmdArgs, shell } = tsxCommand(driverPath);
  const child = spawn(cmd, [...cmdArgs, specPath], { cwd: ROOT, env: process.env, shell: shell ?? false, stdio: ['ignore', 'pipe', 'inherit'] });
  const killer = setTimeout(() => {
    console.error(`[creative-run] TIMEOUT after ${timeoutMs / 1000}s — killing the driver (partial results kept)`);
    child.kill('SIGKILL');
  }, timeoutMs);

  const code = await new Promise((resolvePromise) => {
    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        appendFileSync(resultsPath, line + '\n', 'utf8');
        lines += 1;
        try {
          const parsed = JSON.parse(line);
          if (parsed.director === 'missing') sawDirectorMissing = true;
        } catch {
          console.error(`[creative-run] driver emitted a non-JSON line (kept in the file): ${line.slice(0, 160)}`);
        }
        process.stderr.write(`\r[creative-run] ${lines}/${items.length}   `);
      }
    });
    child.on('error', (e) => {
      clearTimeout(killer);
      die(`could not start tsx (${e.message}) — tsx is a worker devDependency; run: npm --prefix worker install`);
    });
    child.on('close', (c) => {
      clearTimeout(killer);
      resolvePromise(c);
    });
  });
  process.stderr.write('\n');

  // Cleanup generated driver + spec (results persist).
  for (const p of [driverPath, specPath]) {
    try {
      rmSync(p, { force: true });
    } catch (e) {
      console.error(`[creative-run] could not remove ${p}: ${e instanceof Error ? e.message : String(e)} — delete it by hand`);
    }
  }

  if (sawDirectorMissing) {
    console.log('[creative-run] NOTE: A-GEN director module is missing — this was a FACTS + validators-only run (director:"missing" lines).');
  }
  if (code !== 0) die(`driver exited with code ${code} — partial results (${lines} lines) are in ${resultsPath}`);
  console.log(`[creative-run] done — ${lines} result lines in ${resultsPath}`);
}

main().catch((e) => die(e.stack || e.message));
