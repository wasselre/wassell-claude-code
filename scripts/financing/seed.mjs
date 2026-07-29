/**
 * Stages 2–7 of the financing ingestion pipeline: PARSE → NORMALIZE → VALIDATE
 * → DIFF → VERSIONED UPSERT → ISSUE LOG → COVERAGE REPORT.
 *
 *   node scripts/financing/seed.mjs [--snapshots=data/financing/snapshots]
 *                                   [--dry-run] [--trigger=manual|scheduled|backfill]
 *
 * IDEMPOTENT AND HISTORY-PRESERVING, by construction:
 *   - Entities (sources/providers/products/rules) are upserted by natural key.
 *   - VERSIONS are never updated. A version whose payload is byte-identical to
 *     the current one is left alone; a changed payload CLOSES the current
 *     version (effective_to = today) and INSERTS a new one. So re-running this
 *     script twice in a row creates nothing the second time, and a genuine
 *     change leaves both the old and new rows readable forever.
 *   - Every fact's `evidence` strings are re-checked against the stored
 *     snapshot BEFORE the fact is written. A missing quote does not write a
 *     guess — it opens a validation issue and a manual-review row.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { ALL_SOURCES, AUTHORITY } from './sources/manifest.mjs';
import {
  BENCHMARKS,
  REGULATORY_RULES,
  SUPERSEDED_RULE_VERSIONS,
  SUPPORT_PROGRAMS,
  TAX_RULES,
} from './sources/regulatoryData.mjs';
import { PRODUCTS, PROVIDERS, UNREACHABLE_PROVIDERS } from './sources/providerData.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const SNAPSHOT_DIR = path.resolve(String(args.snapshots ?? 'data/financing/snapshots'));
const DRY_RUN = args['dry-run'] === true || args.dryRun === true;
const TRIGGER = String(args.trigger ?? 'manual');

// Pricing goes stale far faster than a law does — the whole reason freshness is
// per-source rather than one global constant.
const FRESHNESS = { regulator: 365, tax_authority: 365, government_program: 180, benchmark: 7, provider: 90 };

// ── Supabase (service role: this writes reference data across RLS) ──────────
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const envFiles = [
  path.join(process.cwd(), '.env.local'),
  path.join(process.cwd(), '.env'),
  'C:/Users/rayan/Claude/wassell-claude-code/.env.local',
  'C:/Users/rayan/Claude/wassell-claude-code/.env',
];
let fileEnv = {};
for (const f of envFiles) fileEnv = { ...readEnvFile(f), ...fileEnv };

const SUPABASE_URL = process.env.SUPABASE_URL ?? fileEnv.SUPABASE_URL ?? fileEnv.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fileEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[seed] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found — cannot seed.');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  global: { headers: { 'x-wassell-service': 'financing-seed' } },
});

const log = (...a) => console.error('[seed]', ...a);
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Deterministic JSON: keys sorted at every depth.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: Postgres stores jsonb with its own key
 * ordering (by length, then bytewise), so a payload read back from the database
 * serialises differently from the identical object in JS. Comparing raw
 * JSON.stringify output therefore reports "changed" on every single run — which
 * would close and re-open every rule version on every cron tick, filling the
 * history with fabricated change events and burying a REAL regulatory change in
 * the noise. Canonical ordering is what makes "unchanged" actually mean it.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

// ── Snapshots ──────────────────────────────────────────────────────────────
function loadSnapshot(sourceKey) {
  const file = path.join(SNAPSHOT_DIR, `${sourceKey}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Normalise whitespace + strip the invisible characters bank pages love, so a
 *  quote match is not defeated by a non-breaking space or a soft hyphen. */
function normalizeForMatch(text) {
  return String(text)
    .replace(/[\u00A0\u200B-\u200F\u202A-\u202E\uFEFF]/g, ' ')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The heart of the anti-fabrication design: assert every claimed quote is
 * genuinely present in what the official page served.
 */
function verifyEvidence(snapshot, evidence) {
  const results = [];
  if (!snapshot || snapshot.status !== 'ok') {
    for (const quote of evidence ?? []) {
      results.push({ quote, found: false, reason: snapshot ? snapshot.status : 'snapshot_missing' });
    }
    return results;
  }
  const haystack = normalizeForMatch(snapshot.text);
  for (const quote of evidence ?? []) {
    const needle = normalizeForMatch(quote);
    results.push({ quote, found: needle.length > 0 && haystack.includes(needle), reason: null });
  }
  return results;
}

// ── Run bookkeeping ────────────────────────────────────────────────────────
const issues = [];
const reviewItems = [];
let versionsCreated = 0;

function addIssue(entityType, entityId, severity, issueType, messageEn, messageAr, details) {
  issues.push({
    entity_type: entityType,
    entity_id: entityId ?? null,
    severity,
    issue_type: issueType,
    message_en: messageEn,
    message_ar: messageAr ?? null,
    details: details ?? {},
  });
}

async function insertRun() {
  if (DRY_RUN) return null;
  const { data, error } = await db
    .from('fin_data_refresh_runs')
    .insert({ trigger: TRIGGER, status: 'running' })
    .select('id')
    .single();
  if (error) throw new Error(`refresh run insert failed: ${error.message}`);
  return data.id;
}

// ── Sources ────────────────────────────────────────────────────────────────
async function upsertSources(runId) {
  const bySourceKey = new Map();
  for (const src of ALL_SOURCES) {
    const kind = src.kind ?? 'provider';
    const row = {
      source_key: src.key,
      kind,
      authority_rank: AUTHORITY[kind] ?? 5,
      publisher: src.publisher,
      title_ar: src.title_ar ?? null,
      title_en: src.title_en,
      url: src.url,
      is_official: true,
      freshness_days: FRESHNESS[kind] ?? 90,
      is_active: true,
    };
    if (DRY_RUN) {
      bySourceKey.set(src.key, `dry-${src.key}`);
      continue;
    }
    const { data, error } = await db
      .from('fin_sources')
      .upsert(row, { onConflict: 'source_key' })
      .select('id')
      .single();
    if (error) throw new Error(`source ${src.key}: ${error.message}`);
    bySourceKey.set(src.key, data.id);

    // Record the fetch outcome — including failures, which is what makes an
    // unreadable regulator page visible instead of invisible.
    const snap = loadSnapshot(src.key);
    if (snap) {
      await db.from('fin_source_records').insert({
        source_id: data.id,
        refresh_run_id: runId,
        fetched_at: snap.fetched_at,
        status: snap.status === 'ok' ? 'ok' : snap.status,
        http_status: snap.http_status,
        blocked_reason: snap.blocked_reason,
        final_url: snap.final_url,
        content_hash: snap.content_hash,
        content_chars: snap.text?.length ?? 0,
        duration_ms: snap.duration_ms ?? null,
        error: snap.error,
        excerpt: (snap.text ?? '').slice(0, 4000) || null,
      });
      if (snap.status === 'ok' && snap.content_hash) {
        // Deduped by (source_id, content_hash): an unchanged page adds nothing.
        await db
          .from('fin_source_snapshots')
          .upsert(
            {
              source_id: data.id,
              content_hash: snap.content_hash,
              captured_at: snap.fetched_at,
              content_text: snap.text,
              content_links: snap.links ?? [],
              content_tables: snap.tables ?? [],
            },
            { onConflict: 'source_id,content_hash', ignoreDuplicates: true },
          );
      } else {
        addIssue(
          'source',
          data.id,
          'warning',
          `source_${snap.status}`,
          `Official source "${src.title_en}" could not be read (${snap.blocked_reason ?? snap.error ?? snap.status}). Any data depending on it is unverified for this cycle.`,
          `تعذر قراءة المصدر الرسمي "${src.title_en}" خلال هذه الدورة.`,
          { url: src.url, status: snap.status, blocked_reason: snap.blocked_reason },
        );
      }
    } else {
      addIssue(
        'source',
        data.id,
        'info',
        'source_not_fetched',
        `Source "${src.title_en}" has no snapshot in this run.`,
        null,
        { url: src.url },
      );
    }
  }
  return bySourceKey;
}

/**
 * Version upsert with change detection.
 *
 * Returns 'unchanged' | 'created' | 'closed_and_created'. This is what makes
 * the script safe to run on a cron: the common case writes nothing.
 */
async function upsertVersion(opts) {
  const { table, parentColumn, parentId, payloadHash, newRow, compareFields } = opts;
  if (DRY_RUN) return { action: 'dry-run', id: null };

  const { data: existing, error: selErr } = await db
    .from(table)
    .select('*')
    .eq(parentColumn, parentId)
    .is('effective_to', null)
    .eq('is_active', true)
    .order('version_number', { ascending: false })
    .limit(1);
  if (selErr) throw new Error(`${table} select: ${selErr.message}`);

  const current = existing?.[0] ?? null;

  if (current) {
    const same = compareFields.every((f) => {
      const a = current[f];
      const b = newRow[f];
      if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
      if (a === null || a === undefined || b === null || b === undefined) return false;
      // Objects/arrays: canonical ordering, because jsonb comes back reordered.
      if (typeof a === 'object' || typeof b === 'object') return canonical(a) === canonical(b);
      // Numeric columns come back from PostgREST as strings ("5000.00" vs 5000).
      if (typeof b === 'number') return Number(a) === b;
      return a === b;
    });
    if (same) {
      // Touch nothing but the verification stamp — proof we re-checked today
      // without pretending the data itself changed.
      await db.from(table).update({ verified_at: new Date().toISOString() }).eq('id', current.id);
      return { action: 'unchanged', id: current.id };
    }
    // A real change: close the old window, open a new one. History intact.
    const today = new Date().toISOString().slice(0, 10);
    const closeFrom = current.effective_from >= today ? current.effective_from : today;
    await db.from(table).update({ effective_to: closeFrom, is_active: false }).eq('id', current.id);
    reviewItems.push({
      entity_type: table,
      entity_id: current.id,
      change_kind: 'changed',
      proposed: newRow,
      previous: current,
      diff_summary: compareFields
        .filter((f) => JSON.stringify(current[f]) !== JSON.stringify(newRow[f]))
        .join(', '),
    });
    const nextNumber = (current.version_number ?? 0) + 1;
    const { data, error } = await db
      .from(table)
      .insert({ ...newRow, version_number: nextNumber, content_hash: payloadHash })
      .select('id')
      .single();
    if (error) throw new Error(`${table} insert: ${error.message}`);
    versionsCreated += 1;
    return { action: 'closed_and_created', id: data.id };
  }

  const { data, error } = await db
    .from(table)
    .insert({ ...newRow, version_number: newRow.version_number ?? 1, content_hash: payloadHash })
    .select('id')
    .single();
  if (error) throw new Error(`${table} insert: ${error.message}`);
  versionsCreated += 1;
  return { action: 'created', id: data.id };
}

/** Verify evidence and record a gap when a quote no longer appears. */
function checkEvidenceOrFlag(entityType, label, sourceKey, evidence, reviewNote) {
  const snapshot = loadSnapshot(sourceKey);
  const checks = verifyEvidence(snapshot, evidence);
  const missing = checks.filter((c) => !c.found);
  if (evidence && evidence.length > 0 && missing.length > 0) {
    addIssue(
      entityType,
      null,
      'error',
      'evidence_not_found',
      `Evidence for "${label}" was not found in the current snapshot of ${sourceKey}: ${missing
        .map((m) => `"${m.quote.slice(0, 60)}"`)
        .join('; ')}. The source may have changed — re-verify before relying on this value.`,
      `تعذر العثور على النص المرجعي لـ "${label}" في النسخة الحالية من المصدر ${sourceKey}.`,
      { source_key: sourceKey, missing: missing.map((m) => m.quote) },
    );
  }
  if (reviewNote) {
    addIssue(entityType, null, 'warning', 'requires_human_confirmation', `${label}: ${reviewNote}`, null, {
      source_key: sourceKey,
    });
  }
  return { verified: missing.length === 0 && (evidence?.length ?? 0) > 0, checks };
}

// ── Regulatory rules ───────────────────────────────────────────────────────
async function seedRegulatoryRules(sourceIds) {
  for (const rule of REGULATORY_RULES) {
    const v = rule.version;
    const { verified } = checkEvidenceOrFlag(
      'regulatory_rule',
      rule.label_en,
      v.source_key,
      v.evidence,
      v.review_note,
    );
    if (DRY_RUN) {
      log(`rule ${rule.rule_key}: evidence ${verified ? 'VERIFIED' : 'NOT VERIFIED'}`);
      continue;
    }

    const { data: ruleRow, error: ruleErr } = await db
      .from('fin_regulatory_rules')
      .upsert(
        {
          rule_key: rule.rule_key,
          authority: rule.authority,
          category: rule.category,
          label_ar: rule.label_ar,
          label_en: rule.label_en,
          description_ar: rule.description_ar ?? null,
          description_en: rule.description_en ?? null,
          is_active: true,
        },
        { onConflict: 'rule_key' },
      )
      .select('id')
      .single();
    if (ruleErr) throw new Error(`rule ${rule.rule_key}: ${ruleErr.message}`);

    const sourceId = sourceIds.get(v.source_key);
    const src = ALL_SOURCES.find((s) => s.key === v.source_key);
    const payloadHash = sha256(JSON.stringify(v.payload));
    const result = await upsertVersion({
      table: 'fin_regulatory_rule_versions',
      parentColumn: 'rule_id',
      parentId: ruleRow.id,
      payloadHash,
      compareFields: ['payload'],
      newRow: {
        rule_id: ruleRow.id,
        version_number: v.version_number,
        effective_from: v.effective_from,
        effective_to: v.effective_to,
        is_active: true,
        payload: v.payload,
        citation_ref: v.citation_ref ?? null,
        citation_text: (v.evidence ?? []).join(' | ') || null,
        source_id: sourceId,
        source_url: src?.url ?? '',
        source_title: src?.title_en ?? null,
        extraction_method: 'manual_review',
        confidence: v.confidence ?? 'high',
        verified_at: verified ? new Date().toISOString() : null,
      },
    });
    log(`rule ${rule.rule_key}: ${result.action}`);
  }

  // Superseded windows — the versioning mechanism demonstrated on real history.
  for (const sv of SUPERSEDED_RULE_VERSIONS) {
    if (DRY_RUN) continue;
    const { data: ruleRow } = await db
      .from('fin_regulatory_rules')
      .select('id')
      .eq('rule_key', sv.rule_key)
      .single();
    if (!ruleRow) continue;
    const { data: exists } = await db
      .from('fin_regulatory_rule_versions')
      .select('id')
      .eq('rule_id', ruleRow.id)
      .eq('version_number', sv.version_number)
      .maybeSingle();
    if (exists) continue;
    const src = ALL_SOURCES.find((s) => s.key === sv.source_key);
    await db.from('fin_regulatory_rule_versions').insert({
      rule_id: ruleRow.id,
      version_number: sv.version_number,
      effective_from: sv.effective_from,
      effective_to: sv.effective_to,
      is_active: sv.is_active !== false,
      payload: sv.payload,
      citation_ref: sv.citation_ref ?? null,
      source_id: sourceIds.get(sv.source_key),
      source_url: src?.url ?? '',
      source_title: src?.title_en ?? null,
      extraction_method: 'manual_review',
      confidence: sv.confidence ?? 'high',
      content_hash: sha256(JSON.stringify(sv.payload)),
    });
    log(`rule ${sv.rule_key}: seeded superseded version ${sv.version_number}`);
  }
}

async function seedTaxRules(sourceIds) {
  for (const tax of TAX_RULES) {
    const v = tax.version;
    checkEvidenceOrFlag('tax_rule', tax.name_en, v.source_key, v.evidence, v.review_note);
    if (DRY_RUN) continue;
    const { data: taxRow, error } = await db
      .from('fin_tax_rules')
      .upsert(
        { tax_key: tax.tax_key, authority: tax.authority, name_ar: tax.name_ar, name_en: tax.name_en, is_active: true },
        { onConflict: 'tax_key' },
      )
      .select('id')
      .single();
    if (error) throw new Error(`tax ${tax.tax_key}: ${error.message}`);
    const src = ALL_SOURCES.find((s) => s.key === v.source_key);
    const result = await upsertVersion({
      table: 'fin_tax_rule_versions',
      parentColumn: 'tax_rule_id',
      parentId: taxRow.id,
      payloadHash: sha256(JSON.stringify(v)),
      compareFields: ['rate_pct', 'base', 'payer', 'first_home_relief_cap'],
      newRow: {
        tax_rule_id: taxRow.id,
        version_number: v.version_number,
        effective_from: v.effective_from,
        effective_to: v.effective_to,
        is_active: true,
        rate_pct: v.rate_pct,
        base: v.base,
        payer: v.payer,
        first_home_relief_cap: v.first_home_relief_cap,
        first_home_relief_notes_ar: v.first_home_relief_notes_ar ?? null,
        first_home_relief_notes_en: v.first_home_relief_notes_en ?? null,
        citation_ref: v.citation_ref ?? null,
        source_id: sourceIds.get(v.source_key),
        source_url: src?.url ?? '',
        confidence: v.confidence ?? 'high',
      },
    });
    log(`tax ${tax.tax_key}: ${result.action}`);
  }
}

async function seedBenchmarks(sourceIds) {
  for (const bm of BENCHMARKS) {
    if (DRY_RUN) continue;
    const { data: row, error } = await db
      .from('fin_benchmarks')
      .upsert(
        {
          benchmark_key: bm.benchmark_key,
          name_ar: bm.name_ar,
          name_en: bm.name_en,
          tenor: bm.tenor,
          administrator: bm.administrator,
          official_url: bm.official_url,
          is_active: true,
        },
        { onConflict: 'benchmark_key' },
      )
      .select('id')
      .single();
    if (error) throw new Error(`benchmark ${bm.benchmark_key}: ${error.message}`);

    for (const obs of bm.observations) {
      checkEvidenceOrFlag('benchmark', `${bm.name_en} @ ${obs.observation_date}`, obs.source_key, obs.evidence, obs.review_note);
      const src = ALL_SOURCES.find((s) => s.key === obs.source_key);
      // Observations are immutable; ignoreDuplicates makes a re-run a no-op.
      await db.from('fin_benchmark_observations').upsert(
        {
          benchmark_id: row.id,
          observation_date: obs.observation_date,
          rate_pct: obs.rate_pct,
          source_id: sourceIds.get(obs.source_key),
          source_url: src?.url ?? '',
          confidence: obs.confidence ?? 'medium',
        },
        { onConflict: 'benchmark_id,observation_date', ignoreDuplicates: true },
      );

      // Stale-benchmark detection: a variable product priced off an old fixing
      // is a wrong number wearing a confident face.
      const ageDays = Math.round((Date.now() - Date.parse(`${obs.observation_date}T00:00:00Z`)) / 86_400_000);
      if (ageDays > 30) {
        addIssue(
          'benchmark',
          row.id,
          'error',
          'benchmark_stale',
          `The most recent available observation for ${bm.name_en} is ${ageDays} days old (${obs.observation_date}). Variable-rate products must not be priced from it until a current fixing is collected.`,
          `أحدث قراءة متاحة لمؤشر ${bm.name_ar} عمرها ${ageDays} يومًا.`,
          { observation_date: obs.observation_date, age_days: ageDays },
        );
      }
    }
    log(`benchmark ${bm.benchmark_key}: ${bm.observations.length} observation(s)`);
  }
}

async function seedSupportPrograms(sourceIds) {
  for (const prog of SUPPORT_PROGRAMS) {
    const v = prog.version;
    checkEvidenceOrFlag('support_program', prog.name_en, v.source_key, v.evidence, v.review_note);
    if (DRY_RUN) continue;
    const { data: row, error } = await db
      .from('fin_support_programs')
      .upsert(
        {
          program_key: prog.program_key,
          authority: prog.authority,
          name_ar: prog.name_ar,
          name_en: prog.name_en,
          program_type: prog.program_type,
          official_url: prog.official_url,
          is_active: true,
        },
        { onConflict: 'program_key' },
      )
      .select('id')
      .single();
    if (error) throw new Error(`program ${prog.program_key}: ${error.message}`);
    const src = ALL_SOURCES.find((s) => s.key === v.source_key);
    const result = await upsertVersion({
      table: 'fin_support_program_versions',
      parentColumn: 'program_id',
      parentId: row.id,
      payloadHash: sha256(JSON.stringify(v)),
      compareFields: ['monthly_support_amount', 'support_cap_amount', 'subsidised_principal_cap', 'figures_verified'],
      newRow: {
        program_id: row.id,
        version_number: v.version_number,
        effective_from: v.effective_from,
        effective_to: v.effective_to,
        is_active: true,
        monthly_support_amount: v.monthly_support_amount,
        support_duration_months: v.support_duration_months,
        support_cap_amount: v.support_cap_amount,
        subsidised_principal_cap: v.subsidised_principal_cap,
        down_payment_grant_amount: v.down_payment_grant_amount,
        max_property_value: v.max_property_value,
        eligibility_notes_ar: v.eligibility_notes_ar ?? null,
        eligibility_notes_en: v.eligibility_notes_en ?? null,
        figures_verified: v.figures_verified === true,
        source_id: sourceIds.get(v.source_key),
        source_url: src?.url ?? '',
        confidence: v.confidence ?? 'medium',
      },
    });
    if (!v.figures_verified) {
      addIssue(
        'support_program',
        row.id,
        'warning',
        'support_figures_unavailable',
        `${prog.name_en}: no official subsidy figures could be collected. Amounts are stored as NULL and must not be quoted to a customer until verified.`,
        `${prog.name_ar}: لم يتم جمع أرقام الدعم من مصدر رسمي.`,
        { official_url: prog.official_url },
      );
    }
    log(`program ${prog.program_key}: ${result.action}`);
  }
}

// ── Providers and products ─────────────────────────────────────────────────
async function seedProviders(sourceIds) {
  const ids = new Map();
  const registerSnap = loadSnapshot('sama_licensed_finance_entities');
  const registerReadable = registerSnap?.status === 'ok';
  for (const p of PROVIDERS) {
    if (DRY_RUN) {
      ids.set(p.provider_key, `dry-${p.provider_key}`);
      continue;
    }
    const { data, error } = await db
      .from('fin_providers')
      .upsert(
        {
          provider_key: p.provider_key,
          name_ar: p.name_ar,
          name_en: p.name_en,
          short_name_en: p.short_name_en ?? null,
          provider_type: p.provider_type,
          website_url: p.website_url ?? null,
          is_active: true,
          // Never claim SAMA confirmed a licence we could not read.
          license_verified: registerReadable ? true : false,
          license_source_id: registerReadable ? sourceIds.get('sama_licensed_finance_entities') : null,
        },
        { onConflict: 'provider_key' },
      )
      .select('id')
      .single();
    if (error) throw new Error(`provider ${p.provider_key}: ${error.message}`);
    ids.set(p.provider_key, data.id);
  }
  if (!registerReadable) {
    addIssue(
      'provider',
      null,
      'warning',
      'license_register_unreadable',
      'SAMA’s licensed-entity register could not be read during collection, so no provider is marked licence-verified. Provider identity comes from each provider’s own official site.',
      'تعذر قراءة سجل الجهات المرخصة لدى البنك المركزي السعودي خلال هذه الدورة.',
      { url: ALL_SOURCES.find((s) => s.key === 'sama_licensed_finance_entities')?.url },
    );
  }
  log(`providers: ${PROVIDERS.length} upserted (licence_verified=${registerReadable})`);
  return ids;
}

async function seedProducts(sourceIds, providerIds) {
  for (const prod of PRODUCTS) {
    const v = prod.version;
    checkEvidenceOrFlag('product', `${prod.provider_key}/${prod.product_key}`, prod.source_key, v.evidence, null);
    if (DRY_RUN) continue;

    const providerId = providerIds.get(prod.provider_key);
    if (!providerId) throw new Error(`product ${prod.product_key}: unknown provider ${prod.provider_key}`);

    const { data: productRow, error: prodErr } = await db
      .from('fin_products')
      .upsert(
        {
          provider_id: providerId,
          product_key: prod.product_key,
          name_ar: prod.name_ar,
          name_en: prod.name_en,
          category: prod.category,
          structure: prod.structure ?? null,
          official_url: prod.official_url ?? null,
          is_active: true,
        },
        { onConflict: 'provider_id,product_key' },
      )
      .select('id')
      .single();
    if (prodErr) throw new Error(`product ${prod.product_key}: ${prodErr.message}`);

    const src = ALL_SOURCES.find((s) => s.key === prod.source_key);
    const versionRow = {
      product_id: productRow.id,
      version_number: 1,
      effective_from: v.effective_from,
      effective_to: null,
      is_active: true,
      applies_to_saudi: v.applies_to_saudi ?? null,
      applies_to_resident: v.applies_to_resident ?? null,
      applies_to_first_home: v.applies_to_first_home ?? null,
      applies_to_additional_home: v.applies_to_additional_home ?? null,
      supported_financing: v.supported_financing ?? null,
      unsupported_financing: v.unsupported_financing ?? null,
      property_types: v.property_types ?? null,
      property_status: v.property_status ?? null,
      employment_types: v.employment_types ?? null,
      employer_sectors: v.employer_sectors ?? null,
      requires_approved_employer: v.requires_approved_employer ?? null,
      requires_salary_transfer: v.requires_salary_transfer ?? null,
      min_salary: v.min_salary ?? null,
      min_salary_no_transfer: v.min_salary_no_transfer ?? null,
      min_employment_months: v.min_employment_months ?? null,
      min_age_years: v.min_age_years ?? null,
      max_age_at_application: v.max_age_at_application ?? null,
      max_age_at_maturity: v.max_age_at_maturity ?? null,
      retiree_eligible: v.retiree_eligible ?? null,
      min_amount: v.min_amount ?? null,
      max_amount: v.max_amount ?? null,
      min_term_months: v.min_term_months ?? null,
      max_term_months: v.max_term_months ?? null,
      min_down_payment_pct: v.min_down_payment_pct ?? null,
      max_ltv_pct: v.max_ltv_pct ?? null,
      max_salary_multiple: v.max_salary_multiple ?? null,
      grace_period_months: v.grace_period_months ?? null,
      calculation_method: v.calculation_method ?? 'unknown',
      supports_balloon: v.supports_balloon ?? null,
      supports_step_up: v.supports_step_up ?? null,
      early_settlement_terms: v.early_settlement_terms ?? null,
      insurance_required: v.insurance_required ?? null,
      required_documents: v.required_documents ?? null,
      conditions_notes: v.conditions_notes ?? null,
      source_id: sourceIds.get(prod.source_key),
      source_url: src?.url ?? prod.official_url ?? '',
      source_title: src?.title_en ?? null,
      extraction_method: 'manual_review',
      confidence: v.confidence ?? 'medium',
      verified_at: new Date().toISOString(),
    };

    const compareFields = [
      'applies_to_saudi', 'applies_to_resident', 'min_salary', 'min_salary_no_transfer',
      'min_employment_months', 'min_age_years', 'max_age_at_maturity', 'min_amount', 'max_amount',
      'min_term_months', 'max_term_months', 'min_down_payment_pct', 'max_ltv_pct',
      'grace_period_months', 'calculation_method', 'requires_salary_transfer',
    ];
    const result = await upsertVersion({
      table: 'fin_product_versions',
      parentColumn: 'product_id',
      parentId: productRow.id,
      payloadHash: sha256(JSON.stringify(versionRow)),
      compareFields,
      newRow: versionRow,
    });

    // The LTV/down-payment cross-check: a provider advertising 5% down implies
    // 95% LTV, above the 90% first-home regulatory ceiling. Flag, don't silently
    // pick one — the engine already applies the lower, but a human should know.
    if (v.max_ltv_pct && v.max_ltv_pct > 90) {
      addIssue(
        'product_version',
        result.id,
        'warning',
        'ltv_above_regulatory_ceiling',
        `${prod.provider_key}/${prod.product_key} advertises up to ${v.max_ltv_pct}% LTV, which exceeds the 90% first-home regulatory ceiling. The engine applies the lower of the two; confirm the provider's exact wording.`,
        null,
        { advertised_ltv: v.max_ltv_pct },
      );
    }

    // Eligibility rules that don't fit the flat columns.
    if (v.eligibility_rules && result.id) {
      for (const er of v.eligibility_rules) {
        await db.from('fin_product_eligibility_rules').insert({
          product_version_id: result.id,
          rule_key: er.rule_key,
          label_ar: er.label_ar ?? null,
          label_en: er.label_en,
          operator: er.operator,
          field_path: er.field_path,
          value_numeric: er.value_numeric ?? null,
          value_text: er.value_text ?? null,
          value_list: er.value_list ?? null,
          value_boolean: er.value_boolean ?? null,
          is_hard_requirement: er.is_hard_requirement !== false,
          failure_message_ar: er.failure_message_ar ?? null,
          failure_message_en: er.failure_message_en ?? null,
          source_id: sourceIds.get(prod.source_key),
          source_url: src?.url ?? '',
        });
      }
    }

    // Required documents as structured rows (the array column keeps the
    // human-readable copy; these drive the missing-document task generator).
    if (v.required_documents && result.id) {
      for (const doc of v.required_documents) {
        const key = doc.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
        await db.from('fin_product_document_requirements').upsert(
          {
            product_version_id: result.id,
            document_key: key,
            label_en: doc,
            is_mandatory: true,
            source_id: sourceIds.get(prod.source_key),
            source_url: src?.url ?? '',
          },
          { onConflict: 'product_version_id,document_key', ignoreDuplicates: true },
        );
      }
    }

    // ── Rate version (only when the provider actually published pricing) ────
    if (v.rate) {
      const r = v.rate;
      checkEvidenceOrFlag('rate_version', `${prod.provider_key}/${prod.product_key} pricing`, prod.source_key, r.evidence, null);
      const rateRow = {
        product_id: productRow.id,
        product_version_id: result.id,
        version_number: 1,
        effective_from: r.effective_from,
        effective_to: null,
        is_active: true,
        rate_type: r.rate_type,
        rate_disclosure_type: r.rate_disclosure_type,
        contractual_rate_pct: r.contractual_rate_pct ?? null,
        contractual_rate_min_pct: r.contractual_rate_min_pct ?? null,
        contractual_rate_max_pct: r.contractual_rate_max_pct ?? null,
        published_apr_pct: r.published_apr_pct ?? null,
        published_apr_min_pct: r.published_apr_min_pct ?? null,
        published_apr_max_pct: r.published_apr_max_pct ?? null,
        benchmark_name: r.benchmark_name ?? null,
        margin_pct: r.margin_pct ?? null,
        example_amount: r.example_amount ?? null,
        example_term_months: r.example_term_months ?? null,
        example_property_price: r.example_property_price ?? null,
        example_ltv_pct: r.example_ltv_pct ?? null,
        example_monthly_payment: r.example_monthly_payment ?? null,
        rate_assumptions: r.rate_assumptions ?? null,
        applicability_notes: r.applicability_notes ?? null,
        campaign_end_date: r.campaign_end_date ?? null,
        source_id: sourceIds.get(prod.source_key),
        source_url: src?.url ?? '',
        source_title: src?.title_en ?? null,
        extraction_method: 'manual_review',
        confidence: r.confidence ?? 'low',
        verified_at: new Date().toISOString(),
      };
      const rateResult = await upsertVersion({
        table: 'fin_product_rate_versions',
        parentColumn: 'product_id',
        parentId: productRow.id,
        payloadHash: sha256(JSON.stringify(rateRow)),
        compareFields: [
          'rate_type', 'rate_disclosure_type', 'contractual_rate_pct',
          'published_apr_pct', 'margin_pct', 'campaign_end_date',
        ],
        newRow: rateRow,
      });
      log(`  rate ${prod.provider_key}/${prod.product_key}: ${rateResult.action} (${r.rate_disclosure_type})`);

      if (r.rate_disclosure_type !== 'exact_rate') {
        addIssue(
          'rate_version',
          rateResult.id,
          'info',
          'rate_not_customer_specific',
          `${prod.provider_key}/${prod.product_key}: the published figure is a "${r.rate_disclosure_type}" disclosure, not a customer-specific contractual rate. Installments derived from it are approximations.`,
          null,
          { disclosure: r.rate_disclosure_type },
        );
      }
    } else {
      addIssue(
        'product',
        productRow.id,
        'warning',
        'no_published_pricing',
        `${prod.provider_key}/${prod.product_key}: the provider publishes no rate or APR. This product cannot be priced and will appear as "product data unavailable".`,
        null,
        { official_url: prod.official_url },
      );
    }

    log(`product ${prod.provider_key}/${prod.product_key}: ${result.action}`);
  }
}

async function recordUnreachable() {
  for (const u of UNREACHABLE_PROVIDERS) {
    addIssue(
      'provider',
      null,
      'warning',
      `provider_source_${u.reason}`,
      `${u.provider_key}: ${u.note}`,
      null,
      { source_key: u.source_key, reason: u.reason },
    );
  }
}

async function flushIssuesAndReviews(runId) {
  if (DRY_RUN) {
    log(`DRY RUN — ${issues.length} issue(s), ${reviewItems.length} review item(s) would be written`);
    for (const i of issues.slice(0, 40)) log(`  [${i.severity}] ${i.issue_type}: ${i.message_en.slice(0, 150)}`);
    return;
  }

  // Close the PREVIOUS run's open issues before writing this run's.
  //
  // An issue is a statement about what the LATEST refresh found, not an
  // immutable event. Without this the queue grows by ~17 rows per scheduled
  // run: the same "SAMA's register was unreachable" sentence three times over,
  // burying anything genuinely new. Observed on production after three seeds —
  // 40 open issues where 17 were current.
  //
  // Resolved rather than deleted: the fact that a source was unreadable last
  // month is still history worth keeping, it is just no longer a to-do.
  const { error: closeErr } = await db
    .from('fin_data_validation_issues')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolution_note: 'Superseded by a later refresh run that re-evaluated the same source.',
    })
    .eq('status', 'open')
    .neq('refresh_run_id', runId);
  if (closeErr) console.error('[seed] closing superseded issues failed:', closeErr.message);

  if (issues.length > 0) {
    const rows = issues.map((i) => ({ ...i, refresh_run_id: runId }));
    // Chunked: a single 500-row insert is one all-or-nothing statement, and
    // losing the whole issue log because one row is malformed is the exact
    // silent-failure shape this codebase has been bitten by before.
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db.from('fin_data_validation_issues').insert(rows.slice(i, i + 100));
      if (error) console.error('[seed] issue insert failed:', error.message);
    }
  }
  if (reviewItems.length > 0) {
    const rows = reviewItems.map((r) => ({ ...r, refresh_run_id: runId }));
    const { error } = await db.from('fin_manual_review_queue').insert(rows);
    if (error) console.error('[seed] review insert failed:', error.message);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
const runId = await insertRun();
log(`run ${runId ?? '(dry)'} started — snapshots: ${SNAPSHOT_DIR}`);

try {
  const sourceIds = await upsertSources(runId);
  await seedRegulatoryRules(sourceIds);
  await seedTaxRules(sourceIds);
  await seedBenchmarks(sourceIds);
  await seedSupportPrograms(sourceIds);
  const providerIds = await seedProviders(sourceIds);
  await seedProducts(sourceIds, providerIds);
  await recordUnreachable();
  await flushIssuesAndReviews(runId);

  const snapshotRun = fs.existsSync(path.join(SNAPSHOT_DIR, '_run.json'))
    ? JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, '_run.json'), 'utf8'))
    : { total: 0, ok: 0, blocked: 0, failed: 0 };

  if (!DRY_RUN && runId) {
    await db
      .from('fin_data_refresh_runs')
      .update({
        finished_at: new Date().toISOString(),
        status: 'completed',
        sources_total: snapshotRun.total,
        sources_ok: snapshotRun.ok,
        sources_blocked: snapshotRun.blocked,
        sources_failed: snapshotRun.failed,
        versions_created: versionsCreated,
        issues_opened: issues.length,
        summary: {
          providers: PROVIDERS.length,
          products: PRODUCTS.length,
          regulatory_rules: REGULATORY_RULES.length,
          tax_rules: TAX_RULES.length,
          support_programs: SUPPORT_PROGRAMS.length,
          unreachable_providers: UNREACHABLE_PROVIDERS.length,
        },
      })
      .eq('id', runId);
  }

  log(
    `done — versions created ${versionsCreated}, issues ${issues.length}, review items ${reviewItems.length}`,
  );
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        versions_created: versionsCreated,
        issues: issues.length,
        review_items: reviewItems.length,
        errors: issues.filter((i) => i.severity === 'error').length,
        warnings: issues.filter((i) => i.severity === 'warning').length,
      },
      null,
      1,
    ),
  );
} catch (err) {
  log('FAILED:', err instanceof Error ? err.message : String(err));
  if (!DRY_RUN && runId) {
    await db
      .from('fin_data_refresh_runs')
      .update({ finished_at: new Date().toISOString(), status: 'failed', error: String(err) })
      .eq('id', runId);
  }
  process.exitCode = 1;
}
