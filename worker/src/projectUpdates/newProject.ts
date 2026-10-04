/**
 * Create a NEW project that a source revealed (a portal listing we never
 * registered, or a WhatsApp announcement): the all_projects record, its units,
 * and its unit_updates row — so from the next week on it is updated like every
 * other project.
 *
 * Fields are filled ONLY from what the source states, plus the "house" fields a
 * sibling project of the same source already carries (marketer, city/region,
 * classification). Nothing is invented: no district if the source names none,
 * no developer if no CRM developer has that name. The project is NOT added to
 * our_projects — publishing to wassel.re stays a human decision.
 *
 * Every record created is logged in project_update_changes (action 'create'),
 * so project_update_revert(run) removes a wrong creation in one call.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyResult,
  MIGRATION_USER_ID,
  PROJECTS_MODEL_ID,
  UNIT_UPDATES_MODEL_ID,
  type ApplyOutcome,
} from './apply.js';
import { mapUnitType, normUnitKey, reconcile } from './reconcile.js';
import type { SourceProject } from './types.js';

const DEVELOPERS_MODEL_ID = '11bade2c-7da9-4d00-b045-eaab37153da2';
const DISTRICTS_MODEL_ID = 'd9a9db7e-b602-470c-b81b-5d6ff17048e9';

/** Arabic name comparison: strip «حي»/«شركة», alef forms, ة/ه, spaces. */
export function arKey(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/^(حي|شركة)\s+/, '')
    .replace(/\s+(للتطوير العقاري|العقارية|للتطوير)$/, '')
    .replace(/[إأآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[\sـ]+/g, '')
    .toLowerCase();
}

async function findDeveloper(supabase: SupabaseClient, name: unknown): Promise<string | null> {
  const key = arKey(name);
  if (!key) return null;
  const { data, error } = await supabase
    .from('records').select('id, data').eq('model_id', DEVELOPERS_MODEL_ID).limit(2000);
  if (error) throw new Error(`developers lookup: ${error.message}`);
  const hits = ((data ?? []) as Array<{ id: string; data: Record<string, unknown> }>)
    .filter((d) => arKey(d.data.name) === key || arKey(d.data.name_ar) === key);
  return hits.length === 1 ? hits[0]!.id : null; // two «أكنان»s → don't guess
}

async function findDistrict(supabase: SupabaseClient, name: unknown, cityId: unknown): Promise<string | null> {
  const key = arKey(name);
  if (!key || typeof cityId !== 'string') return null;
  const { data, error } = await supabase
    .from('unified_records').select('id, data').eq('model_id', DISTRICTS_MODEL_ID)
    .filter('data->>city_lookup', 'eq', cityId).limit(5000);
  if (error) throw new Error(`districts lookup: ${error.message}`);
  const hits = ((data ?? []) as Array<{ id: string; data: Record<string, unknown> }>)
    .filter((d) => arKey(d.data.name_ar) === key);
  return hits.length === 1 ? hits[0]!.id : null;
}

/** «بيع على الخارطة» → project_status available_on_map (there is no off-plan
 *  construction_status option). */
function statusFromType(t: unknown): string {
  return typeof t === 'string' && /على الخارطة|off.?plan/i.test(t) ? 'available_on_map' : 'available';
}

const UNIT_TYPE_TO_PROJECT: Record<string, string> = {
  'شقة': 'apartment', 'تاون هاوس': 'townhouse', 'فيلا': 'villa', 'دور': 'floor', 'دبلكس': 'duplex',
};

export interface NewProjectResult {
  projectId: string;
  registryId: string;
  code: string;
  units: ApplyOutcome;
  notes: string[];
}

export async function createProjectFromSource(
  supabase: SupabaseClient,
  args: {
    runId: string;
    src: SourceProject;
    sourceType: string;          // unit_updates.source_type
    sourceLabel: string;         // «بوابة وسطاء ريفا»
    sourceUrl: string | null;
    /** A developer already known (e.g. the WhatsApp group's own developer);
     *  otherwise looked up by the name the source states. */
    developerId?: string | null;
    /** unit_updates.migration_instructions for the new registry row. */
    instructions?: string;
    dataSources?: string[];
    /** A registered project of the same source — marketer / city / classification are copied. */
    sibling: Record<string, unknown> | null;
    today: string;
    updateFrequency: string;
  },
): Promise<NewProjectResult> {
  const { src, sibling, today } = args;
  const meta = src.meta ?? {};
  const notes: string[] = [];

  const developerId = args.developerId ?? (await findDeveloper(supabase, meta.developer));
  if (meta.developer && !developerId) notes.push(`المطور «${String(meta.developer)}» غير موجود في الشركات — تُرك فارغاً`);

  const data: Record<string, unknown> = {
    project_name: src.name,
    project_status: statusFromType(meta.project_type_text),
    data_sources: args.dataSources ?? ['broker_portal'],
    update_source: args.sourceType === 'whatsapp_group' ? 'files_manual' : 'broker_portal',
    last_source_update: today,
    last_verified_at: today,
  };
  if (args.sourceUrl) data.update_source_url = args.sourceUrl;
  if (developerId) data.developer = developerId;
  if (sibling) {
    for (const k of ['marketer', 'project_classification', 'project_type', 'city_name', 'preferred_city'] as const) {
      if (sibling[k] != null) data[k] = sibling[k];
    }
    const loc = sibling.location as Record<string, unknown> | undefined;
    if (loc && (!meta.city || meta.city === sibling.city_name)) {
      const location: Record<string, unknown> = { city: loc.city, region: loc.region };
      const districtId = await findDistrict(supabase, meta.district, loc.city);
      if (districtId) location.district = districtId;
      else if (meta.district) notes.push(`الحي «${String(meta.district)}» لم يُطابَق في جدول الأحياء — تُرك فارغاً`);
      data.location = location;
    }
  }
  if (meta.district) data.preferred_neighborhoods = meta.district;
  if (typeof meta.public_url === 'string') data.project_page_url = meta.public_url;
  data.source_notes = [
    `أُنشئ تلقائياً من ${args.sourceLabel} بتاريخ ${today}${args.sourceUrl ? ` — ${args.sourceUrl}` : ''}`,
    meta.ad_license ? `رخصة الإعلان: ${String(meta.ad_license)}` : '',
    meta.project_type_text ? `نوع المشروع حسب المصدر: ${String(meta.project_type_text)}` : '',
    meta.description ? `الوصف: ${String(meta.description)}` : '',
    ...notes.map((n) => `⚠ ${n}`),
  ].filter(Boolean).join('\n');
  data.update_source_notes = `تحديث تلقائي من ${args.sourceLabel}${args.sourceUrl ? ` (${args.sourceUrl})` : ''}.`;

  const { data: codes, error: codeErr } = await supabase.rpc('project_update_next_codes', { p_kind: 'project', p_n: 1 });
  if (codeErr || !Array.isArray(codes) || !codes[0]) throw new Error(`project code: ${codeErr?.message ?? 'none'}`);
  data.project_id = codes[0];
  const types = [...new Set(src.units.map((u) => UNIT_TYPE_TO_PROJECT[mapUnitType(u.unitType ?? null) ?? ''] ?? null).filter(Boolean))];
  if (types.length) data.unit_types = types;

  const projectId = randomUUID();
  const { error: pErr } = await supabase.rpc('record_save', {
    p_model_id: PROJECTS_MODEL_ID, p_id: projectId, p_data: data, p_created_by: MIGRATION_USER_ID, p_expected_version: null,
  });
  if (pErr) throw new Error(`create project: ${pErr.message}`);
  const { error: lErr } = await supabase.from('project_update_changes').insert({
    run_id: args.runId, project_id: projectId, record_id: projectId, model: 'all_projects',
    action: 'create', before: null, after: data, reason: `new project on ${args.sourceLabel}`,
  });
  if (lErr) throw new Error(`change log (project): ${lErr.message}`);

  // Units: an empty CRM side → every listed (not-sold) unit is a creation.
  const result = reconcile([], src.units, { absentAvailable: 'leave', createMissing: true, updatePrices: true }, {
    projectId, developerId, projectName: src.name, sourceLabel: args.sourceLabel, today,
  });
  const units = await applyResult(supabase, { runId: args.runId, projectId, projectName: src.name, result });

  const registry: Record<string, unknown> = {
    project: projectId,
    update_frequency: args.updateFrequency,
    source_type: args.sourceType,
    ...(args.sourceUrl ? { source_url: args.sourceUrl } : {}),
    last_migrated_at: today,
    ...(args.updateFrequency === 'on_file' ? {} : { next_due: today }),
    is_active: true,
    auto_scope: 'full',
    migration_instructions: args.instructions ??
      (`أُضيف تلقائياً (${today}) من ${args.sourceLabel}. يُحدَّث آلياً كل أسبوع عبر project_update_runs: ` +
      `مفتاح الربط = معرّف الوحدة في البوابة (developer_unit_code) ثم عنوان البطاقة؛ الحالة من حقل case، السعر من unit_price؛ ` +
      `الوحدات الغائبة عن البوابة لا تُلمس؛ الوحدات الجديدة تُضاف مع مخططها.`),
    migration_log: `${today} — أُنشئ المشروع تلقائياً من ${args.sourceLabel}: ${units.created} وحدة${units.plans ? `، ${units.plans} مخطط` : ''}${notes.length ? `؛ ⚠ ${notes.join('؛ ')}` : ''}`,
  };
  const registryId = randomUUID();
  const { error: rErr } = await supabase.rpc('record_save', {
    p_model_id: UNIT_UPDATES_MODEL_ID, p_id: registryId, p_data: registry, p_created_by: MIGRATION_USER_ID, p_expected_version: null,
  });
  if (rErr) throw new Error(`create unit_updates row: ${rErr.message}`);
  const { error: l2Err } = await supabase.from('project_update_changes').insert({
    run_id: args.runId, project_id: projectId, record_id: registryId, model: 'unit_updates',
    action: 'create', before: null, after: registry, reason: 'registered for weekly automatic updates',
  });
  if (l2Err) throw new Error(`change log (registry): ${l2Err.message}`);

  return { projectId, registryId, code: String(codes[0]), units, notes };
}

/** Same name already in the CRM (exact, after normalising)? */
export function sameName(a: unknown, b: unknown): boolean {
  const x = normUnitKey(a);
  return !!x && x === normUnitKey(b);
}
