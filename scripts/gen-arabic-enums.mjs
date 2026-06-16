#!/usr/bin/env node
/**
 * gen-arabic-enums.mjs
 * ----------------------------------------------------------------------------
 * Generates src/lib/salesProcess/arabicEnums.generated.ts from the LIVE `clients`
 * model on Supabase — the canonical Arabic `client_stage` / `client_status`
 * option values the sales-process config writes to client records.
 *
 * WHY: correction #7 — the config must reference real, current option values.
 * Hand-maintaining a union drifts the moment someone edits options in the
 * Builder. This reads the live model and writes the typed unions; a runtime
 * guard (assertSalesProcessEnums) re-checks at app start.
 *
 * REQUIRED ENV (process.env or auto-loaded from .env.local / .env at repo root):
 *   SUPABASE_URL (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY (preferred) or SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY
 *
 * USAGE:  node scripts/gen-arabic-enums.mjs
 * ----------------------------------------------------------------------------
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── tiny zero-dep .env loader (mirrors sync-model-workflow-prds.mjs) ──────────
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  let txt;
  try { txt = readFileSync(p, 'utf8'); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile(resolve(ROOT, '.env.local'));
loadEnvFile(resolve(ROOT, '.env'));

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY;

if (!URL || !KEY) {
  console.error('Missing Supabase env (SUPABASE_URL + a key). Aborting.');
  process.exit(1);
}

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

function optionValues(schema, fieldSlug) {
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields ?? []) {
      if (field.name === fieldSlug) return (field.options ?? []).map((o) => ({ value: o.value, en: o.label_en }));
    }
  }
  return [];
}

function emitArray(constName, typeName, options) {
  const lines = options.map((o) => {
    const v = String(o.value).replace(/'/g, "\\'");
    const comment = o.en ? `  // ${o.en}` : '';
    return `  '${v}',${comment}`;
  });
  return (
    `export const ${constName} = [\n${lines.join('\n')}\n] as const;\n\n` +
    `export type ${typeName} = (typeof ${constName})[number];\n`
  );
}

const { data, error } = await supabase.from('models').select('schema').eq('name', 'clients').single();
if (error) { console.error('Failed to read clients model:', error.message); process.exit(1); }

const stages = optionValues(data.schema, 'client_stage');
const statuses = optionValues(data.schema, 'client_status');

const banner =
  `/* eslint-disable */\n` +
  `// AUTO-GENERATED — do not hand-edit.\n` +
  `// Regenerate with:  node scripts/gen-arabic-enums.mjs\n` +
  `// Source of truth: the live \`clients\` model's client_stage / client_status options.\n\n`;

const out =
  banner +
  emitArray('CLIENT_STAGE_VALUES', 'ClientStageValue', stages) +
  '\n' +
  emitArray('CLIENT_STATUS_VALUES', 'ClientStatusValue', statuses);

const target = resolve(ROOT, 'src/lib/salesProcess/arabicEnums.generated.ts');
writeFileSync(target, out, 'utf8');
console.log(`Wrote ${target} — ${stages.length} stages, ${statuses.length} statuses.`);
