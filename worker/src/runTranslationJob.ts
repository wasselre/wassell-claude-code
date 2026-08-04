/**
 * Translation job pipeline (bilingual REV 4 §6 lifecycle) — 8th lane on the
 * shared Fly worker, draining `translation_jobs`.
 *
 * Per claimed job (one record, coalesced changed paths):
 *   load confirmed policies → per field: detect language, sync the unit
 *   (claiming its generation), resolve each missing target through the tier
 *   order official → glossary → translation-memory → provider (DeepSeek →
 *   Haiku, fact-asserted) → CAS-activate the variant (only if the unit's
 *   generation is still the claimed one) → TM write-back per policy →
 *   rebuild the record's search document.
 *
 * CAS invariants (REV 4 blocker 4): every activation is
 * `WHERE generation = claimed_generation` — a save that lands mid-provider-
 * call bumps the generation (capture trigger) and this job's result is
 * silently discarded; the new queued job re-translates. Candidate-revision
 * idempotency is the DB partial unique per (unit, lang, generation).
 *
 * Twin pairs ('pair:*' policies, W7): the authored side's translation is
 * materialized into the EMPTY twin column via record_twin_fill (not a variant
 * display — the app reads the twin columns directly). See the pair pass below.
 * Element paths ('slug[id=…]') are W-Docs/W1-element work — skipped likewise.
 * Oversized scalars: >200 KB → variant failed 'manual_review:oversized'
 * (loud, Review-listed); 20–200 KB translate via sequential sub-batches
 * (current live maximum record scalar is ~3.5 KB — the resumable
 * translation_segments path activates with W-Docs where real long content
 * lives).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import {
  DETECTOR_VERSION, detectLang, sha256, translateItems,
  type TranslateItem, type TargetLang, type Treatment,
} from './lib/translateProvider.js';

export interface TranslationJob {
  id: string;
  resourceKind: string;
  entityId: string;
  modelId: string | null;
  changedPaths: string[];
  attempts: number;
}

interface FieldPolicy {
  field_path: string;
  treatment: Treatment | 'skip';
  semantic_class: string;
  sensitivity: string;
  provider_route: 'deepseek' | 'anthropic' | 'none';
  tm_reuse: 'org' | 'global_terms' | 'never' | 'service_only';
  require_approval: boolean;
  official_counterpart_path: string | null;
  /** For `pair:*` policies (W7): "<ar_path>|<en_path>" of the twin columns. */
  twin_counterpart_path: string | null;
}

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const MANUAL_REVIEW_BYTES = 200_000;

interface Ctx {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: TranslationJob;
}

export async function runTranslationJob({ supabase, env, job }: Ctx): Promise<Record<string, unknown>> {
  if (job.resourceKind !== 'record') {
    // mkt_* / wassel_doc kinds register in W6-M / W-Docs.
    return { skipped: `resource_kind ${job.resourceKind} not yet handled` };
  }

  const { data: settingsRow, error: settingsErr } = await supabase
    .from('translation_settings').select('prompt_version, glossary_version').eq('id', true).single();
  if (settingsErr) throw new Error(`settings read failed: ${settingsErr.message}`);
  const promptVersion = settingsRow.prompt_version as string;
  const glossaryVersion = settingsRow.glossary_version as number;

  const { data: entity, error: entErr } = await supabase
    .from('unified_records').select('id, model_id, data').eq('id', job.entityId).maybeSingle();
  if (entErr) throw new Error(`entity read failed: ${entErr.message}`);
  if (!entity) return { skipped: 'entity deleted' };
  const data = (entity.data ?? {}) as Record<string, unknown>;

  const { data: policies, error: polErr } = await supabase
    .from('translation_field_policies')
    .select('field_path, treatment, semantic_class, sensitivity, provider_route, tm_reuse, require_approval, official_counterpart_path, twin_counterpart_path')
    .eq('resource_kind', 'record').eq('scope_id', entity.model_id)
    .eq('classification_status', 'confirmed').neq('treatment', 'skip');
  if (polErr) throw new Error(`policy read failed: ${polErr.message}`);

  const scalarPolicies = (policies ?? []).filter(
    (p): p is FieldPolicy => !p.field_path.includes('[') && !p.field_path.startsWith('pair:'),
  );
  const pairPolicies = (policies ?? []).filter(
    (p): p is FieldPolicy => p.field_path.startsWith('pair:') && !!p.twin_counterpart_path,
  );
  const fieldSet = job.changedPaths.length === 0
    ? scalarPolicies
    : scalarPolicies.filter((p) => job.changedPaths.includes(p.field_path));

  const stats = { translated: 0, tmHits: 0, official: 0, glossary: 0, failed: 0, skipped: 0 };
  const providerWork: Array<{ item: TranslateItem; policy: FieldPolicy; claimedGen: number; sourceRev: string; sourceLang: string; raw: string }> = [];

  for (const policy of fieldSet) {
    const rawVal = data[policy.field_path];
    const raw = typeof rawVal === 'string' ? rawVal.trim() : '';

    if (raw === '') {
      // Empty source = nothing to translate; unit (and variants) go away.
      await supabase.from('translation_units').delete()
        .match({ resource_kind: 'record', entity_id: job.entityId, field_path: policy.field_path });
      continue;
    }

    const det = detectLang(raw);
    const sourceRev = sha256(raw);

    // ── Unit sync: claim the generation ─────────────────────────────────
    const { data: unitRows, error: unitErr } = await supabase
      .from('translation_units')
      .upsert({
        resource_kind: 'record', entity_id: job.entityId, field_path: policy.field_path,
        org_id: ORG_ID, model_id: entity.model_id,
        source_lang: det.lang, detect_confidence: det.confidence, detector_version: DETECTOR_VERSION,
        source_rev: sourceRev, source_excerpt: raw.slice(0, 200),
      }, { onConflict: 'resource_kind,entity_id,field_path', ignoreDuplicates: false })
      .select('generation, source_lang, source_lang_locked');
    if (unitErr) throw new Error(`unit upsert failed (${policy.field_path}): ${unitErr.message}`);
    const unit = unitRows?.[0];
    if (!unit) throw new Error(`unit upsert returned no row (${policy.field_path})`);
    const claimedGen = unit.generation as number;
    // A locked manual language override always wins over re-detection.
    const sourceLang = (unit.source_lang_locked ? unit.source_lang : det.lang) as string;
    if (unit.source_lang_locked && unit.source_lang !== det.lang) {
      await supabase.from('translation_units')
        .update({ source_lang: unit.source_lang })
        .match({ resource_kind: 'record', entity_id: job.entityId, field_path: policy.field_path });
    }

    if (sourceLang === 'und') {
      // Undecidable: no AI; surfaced in Review's "needs language" queue.
      await ensureVariants(supabase, job.entityId, policy.field_path, null, ['ar', 'en'], 'skipped');
      stats.skipped++;
      continue;
    }

    const targets: TargetLang[] =
      sourceLang === 'mixed' ? ['ar', 'en'] : sourceLang === 'ar' ? ['en'] : ['ar'];
    const sourceSide: TargetLang | null =
      sourceLang === 'ar' ? 'ar' : sourceLang === 'en' ? 'en' : null;
    await ensureVariants(supabase, job.entityId, policy.field_path, sourceSide, targets, 'pending');

    if (raw.length > MANUAL_REVIEW_BYTES) {
      await supabase.from('translation_variants')
        .update({ state: 'failed', last_error: 'manual_review:oversized' })
        .match({ resource_kind: 'record', entity_id: job.entityId, field_path: policy.field_path })
        .eq('role', 'target');
      stats.failed += targets.length;
      continue;
    }

    for (const target of targets) {
      // Already current? (state valid at the claimed generation)
      const { data: existing } = await supabase.from('translation_variants')
        .select('state, generation, machine_owned')
        .match({ resource_kind: 'record', entity_id: job.entityId, field_path: policy.field_path, lang: target })
        .maybeSingle();
      if (existing && ['translated', 'approved'].includes(existing.state as string)
          && existing.generation === claimedGen) { stats.skipped++; continue; }
      if (existing && existing.machine_owned === false) { stats.skipped++; continue; }

      // Tier 1 — official counterpart (English targets of name fields).
      if (policy.official_counterpart_path && target === 'en') {
        const official = data[policy.official_counterpart_path];
        if (typeof official === 'string' && official.trim() !== '') {
          const ok = await activate(supabase, job, policy, target, claimedGen, sourceRev, sourceLang, raw,
            official.trim(), 'official', 'official', promptVersion, glossaryVersion, policy.require_approval);
          if (ok) stats.official++;
          continue;
        }
      }

      // Tier 2 — glossary exact term.
      const glossCol = target === 'en' ? 'term_en' : 'term_ar';
      const matchCol = target === 'en' ? 'term_ar' : 'term_en';
      const { data: gloss } = await supabase.from('translation_glossary')
        .select(glossCol).eq('is_active', true).ilike(matchCol, raw).limit(1);
      const glossHit = (gloss?.[0] as Record<string, unknown> | undefined)?.[glossCol];
      if (typeof glossHit === 'string' && glossHit.trim() !== '') {
        const ok = await activate(supabase, job, policy, target, claimedGen, sourceRev, sourceLang, raw,
          glossHit.trim(), 'glossary', 'glossary', promptVersion, glossaryVersion, policy.require_approval);
        if (ok) stats.glossary++;
        continue;
      }

      // Tier 3 — translation memory (exact context key; REV 4 §4c).
      if (policy.tm_reuse !== 'never') {
        const { data: tm } = await supabase.from('translation_memory')
          .select('translated_text, provider')
          .match({
            org_id: ORG_ID, source_lang: sourceLang === 'mixed' ? 'mixed' : sourceLang,
            target_lang: target, resource_kind: 'record',
            context_scope: `${entity.model_id}:${policy.field_path}`,
            semantic_class: policy.semantic_class, sensitivity: policy.sensitivity,
            treatment: policy.treatment, prompt_version: promptVersion,
            glossary_version: glossaryVersion, source_hash: sourceRev,
          }).maybeSingle();
        if (tm?.translated_text) {
          const ok = await activate(supabase, job, policy, target, claimedGen, sourceRev, sourceLang, raw,
            tm.translated_text, 'ai', `tm:${tm.provider ?? 'unknown'}`, promptVersion, glossaryVersion, policy.require_approval);
          if (ok) stats.tmHits++;
          continue;
        }
      }

      if (policy.provider_route === 'none') { stats.skipped++; continue; }
      providerWork.push({
        item: {
          id: `${policy.field_path}|${target}`,
          text: raw,
          treatment: policy.treatment as Treatment,
          targetLang: target,
          mixedSource: sourceLang === 'mixed',
        },
        policy, claimedGen, sourceRev, sourceLang, raw,
      });
    }
  }

  // ── Provider pass (batched across all fields of this record) ───────────
  if (providerWork.length > 0) {
    const results = await translateItems(
      { deepseekKey: env.DEEPSEEK_API_KEY, anthropicKey: env.ANTHROPIC_API_KEY },
      providerWork.map((w) => w.item),
    );
    for (const w of providerWork) {
      const r = results.get(w.item.id);
      if (!r || r.error || !r.translated) {
        stats.failed++;
        await supabase.from('translation_variants')
          .update({ state: 'failed', last_error: (r?.error ?? 'no result').slice(0, 500) })
          .match({ resource_kind: 'record', entity_id: job.entityId, field_path: w.policy.field_path, lang: w.item.targetLang })
          .eq('machine_owned', true);
        continue;
      }
      const requireApproval = w.policy.require_approval
        || (w.sourceLang === 'mixed');   // mixed always human-gated (REV 4 §B3)
      const ok = await activate(supabase, job, w.policy, w.item.targetLang, w.claimedGen,
        w.sourceRev, w.sourceLang, w.raw, r.translated, 'ai', r.provider,
        promptVersion, glossaryVersion, requireApproval);
      if (!ok) { stats.skipped++; continue; }   // CAS discard: source moved on
      stats.translated++;

      // TM write-back per policy.
      if (w.policy.tm_reuse !== 'never') {
        await supabase.from('translation_memory').upsert({
          org_id: ORG_ID,
          source_lang: w.sourceLang === 'mixed' ? 'mixed' : w.sourceLang,
          target_lang: w.item.targetLang, resource_kind: 'record',
          context_scope: `${entity.model_id}:${w.policy.field_path}`,
          semantic_class: w.policy.semantic_class, sensitivity: w.policy.sensitivity,
          treatment: w.policy.treatment, prompt_version: promptVersion,
          glossary_version: glossaryVersion, source_hash: w.sourceRev,
          source_text: w.policy.tm_reuse === 'service_only' ? null : w.raw,
          translated_text: r.translated, provider: r.provider,
        }, { onConflict: 'org_id,source_lang,target_lang,resource_kind,context_scope,semantic_class,treatment,prompt_version,glossary_version,source_hash' });
      }
    }
  }

  // ── Twin pairs (W7): materialize the authored side's translation into the
  //    EMPTY twin column (never a variant display — the app renders the twin
  //    columns directly). Idempotent: only an empty target is filled, and
  //    record_twin_fill CAS-guards against a human edit landing mid-translate.
  //    v1 fills empty sides; re-translating a filled side after the source is
  //    edited is deferred (a human can clear the target to re-fill). ─────────
  const twinWork: Array<{ item: TranslateItem; policy: FieldPolicy; sourcePath: string; targetPath: string; sourceText: string }> = [];
  for (const policy of pairPolicies) {
    const [arPath, enPath] = (policy.twin_counterpart_path as string).split('|');
    if (!arPath || !enPath) continue;
    // Only act when THIS record's twin fields were part of the change (or the
    // job is a full reconcile with no explicit paths).
    if (job.changedPaths.length > 0
        && !job.changedPaths.includes(arPath) && !job.changedPaths.includes(enPath)) continue;

    const arText = typeof data[arPath] === 'string' ? (data[arPath] as string).trim() : '';
    const enText = typeof data[enPath] === 'string' ? (data[enPath] as string).trim() : '';
    // Exactly one side authored ⇒ fill the other. Both or neither ⇒ nothing to do.
    let sourceText: string, sourcePath: string, targetPath: string, target: TargetLang;
    if (arText && !enText) { sourceText = arText; sourcePath = arPath; targetPath = enPath; target = 'en'; }
    else if (enText && !arText) { sourceText = enText; sourcePath = enPath; targetPath = arPath; target = 'ar'; }
    else continue;
    if (sourceText.length > MANUAL_REVIEW_BYTES) { stats.failed++; continue; }

    twinWork.push({
      item: { id: `pair:${policy.field_path}|${target}`, text: sourceText, treatment: policy.treatment as Treatment, targetLang: target, mixedSource: false },
      policy, sourcePath, targetPath, sourceText,
    });
  }
  if (twinWork.length > 0) {
    const results = await translateItems(
      { deepseekKey: env.DEEPSEEK_API_KEY, anthropicKey: env.ANTHROPIC_API_KEY },
      twinWork.map((w) => w.item),
    );
    for (const w of twinWork) {
      const r = results.get(w.item.id);
      if (!r || r.error || !r.translated) { stats.failed++; continue; }
      // record_twin_fill: source unchanged (sha) AND target still empty (''),
      // then the GUC-marked write into the twin column. false ⇒ raced, skip.
      const { data: filled, error: fillErr } = await supabase.rpc('record_twin_fill', {
        p_record_id: job.entityId, p_source_path: w.sourcePath, p_target_path: w.targetPath,
        p_value: r.translated, p_expected_source_rev: sha256(w.sourceText), p_expected_target_value: '',
      });
      if (fillErr) { stats.failed++; console.error(`[translate] twin_fill failed (${w.targetPath}): ${fillErr.message}`); continue; }
      if (filled === true) stats.translated++; else stats.skipped++;
    }
  }

  // Finalize: clears dirty only for fully-resolved units; failed/pending ones
  // stay dirty with a 15-min retry backoff for the reconcile loop.
  const { error: finErr } = await supabase.rpc('translation_unit_finalize', {
    p_kind: 'record', p_entity: job.entityId,
  });
  if (finErr) console.error(`[translate] unit finalize failed: ${finErr.message}`);

  const { error: sdErr } = await supabase.rpc('search_document_rebuild_record', { p_record_id: job.entityId });
  if (sdErr) console.error(`[translate] search doc rebuild failed: ${sdErr.message}`);

  return stats;
}

async function ensureVariants(
  supabase: SupabaseClient, entityId: string, fieldPath: string,
  sourceSide: TargetLang | null, targets: TargetLang[], targetState: 'pending' | 'skipped',
): Promise<void> {
  const rows = [] as Array<Record<string, unknown>>;
  for (const lang of ['ar', 'en'] as TargetLang[]) {
    const isSource = sourceSide === lang;
    if (!isSource && !targets.includes(lang)) continue;
    rows.push({
      resource_kind: 'record', entity_id: entityId, field_path: fieldPath, lang,
      role: isSource ? 'source' : 'target',
      state: isSource ? 'source' : targetState,
    });
  }
  const { error } = await supabase.from('translation_variants')
    .upsert(rows, { onConflict: 'resource_kind,entity_id,field_path,lang', ignoreDuplicates: true });
  if (error) throw new Error(`variant ensure failed (${fieldPath}): ${error.message}`);
}

/**
 * Insert the revision + CAS-activate the variant. Returns false when the CAS
 * lost (unit generation moved on) — the result is recorded as a candidate
 * revision but never displayed.
 */
async function activate(
  supabase: SupabaseClient, job: TranslationJob, policy: FieldPolicy,
  lang: TargetLang, claimedGen: number, sourceRev: string, sourceLang: string,
  sourceText: string, translated: string, origin: string, provider: string,
  promptVersion: string, glossaryVersion: number, requireApproval: boolean,
): Promise<boolean> {
  const { data: revRows, error: revErr } = await supabase.from('translation_revisions')
    .insert({
      resource_kind: 'record', entity_id: job.entityId, field_path: policy.field_path,
      lang, generation: claimedGen, source_rev: sourceRev, source_lang: sourceLang,
      source_text: sourceText.slice(0, 4000), translated_text: translated,
      origin, status: 'candidate', treatment: policy.treatment,
      provider, prompt_version: promptVersion, glossary_version: glossaryVersion,
    })
    .select('id');
  // Unique-violation = another worker already produced this (unit,lang,gen)
  // candidate — idempotent, fetch theirs.
  let revId = revRows?.[0]?.id as string | undefined;
  if (revErr) {
    if (!revErr.message.includes('tr_gen_candidate_uq') && !revErr.code?.startsWith('23')) {
      throw new Error(`revision insert failed: ${revErr.message}`);
    }
    const { data: existing } = await supabase.from('translation_revisions').select('id')
      .match({ resource_kind: 'record', entity_id: job.entityId, field_path: policy.field_path,
               lang, generation: claimedGen, status: 'candidate' })
      .limit(1);
    revId = existing?.[0]?.id as string | undefined;
  }
  if (!revId) return false;

  if (requireApproval) {
    // Display stays empty (pending honesty); the candidate waits in Review.
    return true;
  }

  // Atomic CAS activation in ONE SQL statement (translation_variant_activate):
  // activates only while the unit is still at the claimed generation.
  const { data: activated, error: actErr } = await supabase.rpc('translation_variant_activate', {
    p_kind: 'record', p_entity: job.entityId, p_path: policy.field_path, p_lang: lang,
    p_revision_id: revId, p_claimed_generation: claimedGen,
    p_text: translated, p_json: null,
  });
  if (actErr) throw new Error(`variant activate failed: ${actErr.message}`);
  if (activated !== true) return false;   // CAS lost: source moved on — discard

  await supabase.from('translation_history').insert({
    resource_kind: 'record', entity_id: job.entityId, field_path: policy.field_path, lang,
    reason: provider.startsWith('tm:') ? 'cache_hit' : 'ai_translate',
    new_status: 'translated', revision_id: revId,
  });
  return true;
}
