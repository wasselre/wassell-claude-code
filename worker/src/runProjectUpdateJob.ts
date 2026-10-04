/**
 * runProjectUpdateJob — one project_update_runs row → reconcile every project
 * of one source against the CRM, apply, and stamp the update list.
 *
 * Replaces the manual weekly routine (a Claude session following each
 * unit_updates.migration_instructions by hand). Today the scheduled sources
 * are listed in project_update_settings.scheduled_sources; each source_type
 * maps to an adapter below.
 *
 * A run:
 *   1. loads every ACTIVE unit_updates row of the source;
 *   2. signs in to the portal ONCE and lists its projects;
 *   3. per registered project: scrape → reconcile → safety brake → apply →
 *      stamp (last_migrated_at, next_due, migration_log; all_projects.last_source_update);
 *   4. reports portal projects that are NOT in the update list (new projects)
 *      and registered projects the portal no longer lists.
 *
 * A dry run (project_update_runs.dry_run) does steps 1–4 without writing a
 * thing: the summary carries exactly what a live run would change.
 *
 * Never holds an HTTP request open — this is a queue lane, like every other
 * long job in the worker.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyResult,
  patchRecord,
  PROJECTS_MODEL_ID,
  UNIT_UPDATES_MODEL_ID,
  UNITS_MODEL_ID,
} from './projectUpdates/apply.js';
import { brakeReason, normUnitKey, reconcile } from './projectUpdates/reconcile.js';
import { createProjectFromSource } from './projectUpdates/newProject.js';
import { RivaPortal, rivaProjectIdFromUrl } from './projectUpdates/riva.js';
import type { CrmUnit, ReconcilePolicy, ReconcileResult } from './projectUpdates/types.js';

const LEAD_PORTALS_MODEL_ID = '1ead0000-0000-4000-8000-000000000001';
const HEARTBEAT_MS = 20_000;

export interface ProjectUpdateRun {
  id: string;
  source_type: string;
  trigger: string;
  dry_run: boolean;
  params: Record<string, unknown>;
  attempts: number;
}

interface Settings {
  brake_share: number;
  brake_min_units: number;
}

interface RegistryRow {
  id: string;
  data: Record<string, unknown>;
}

export interface RunResult {
  outcome: 'applied' | 'no_change' | 'held' | 'partial' | 'dry_run';
  summary: Record<string, unknown>;
}

function riyadhToday(): string {
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function frequencyDays(freq: unknown): number | null {
  switch (freq) {
    case 'daily': return 1;
    case 'weekly': return 7;
    case 'biweekly': return 14;
    case 'monthly': return 30;
    default: return null; // on_file etc. — not on a calendar
  }
}

async function loadAll(
  supabase: SupabaseClient,
  modelId: string,
  filter: { key: string; value: string } | null,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const out: Array<{ id: string; data: Record<string, unknown> }> = [];
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('records').select('id, data').eq('model_id', modelId);
    if (filter) q = q.filter(`data->>${filter.key}`, 'eq', filter.value);
    const { data, error } = await q.order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`load ${modelId}: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function loadRecord(supabase: SupabaseClient, id: string): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const { data, error } = await supabase.from('records').select('id, data').eq('id', id).maybeSingle();
  if (error) throw new Error(`load record ${id}: ${error.message}`);
  return (data as { id: string; data: Record<string, unknown> } | null) ?? null;
}

async function rivaCredentials(supabase: SupabaseClient): Promise<{ email: string; password: string }> {
  const portals = await loadAll(supabase, LEAD_PORTALS_MODEL_ID, null);
  const riva = portals.find((p) => typeof p.data.login_url === 'string' && /riva\.sa\/broker/.test(p.data.login_url));
  const email = riva?.data.login_email;
  const password = riva?.data.login_password;
  if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
    throw new Error('no Riva broker login on file (lead_portals record with login_email / login_password)');
  }
  return { email, password };
}

function logLine(today: string, label: string, r: ReconcileResult, extra: string): string {
  const s = r.stats;
  const created = r.creates.length;
  const changes = r.updates.length + created;
  return `${today} — تحديث تلقائي (${label}): ${changes} تغيير (حالة ${s.statusChanges}، سعر ${s.priceChanges}، جديد ${created})${extra}`;
}

const RIVA_POLICY: ReconcilePolicy = { absentAvailable: 'leave', createMissing: true, updatePrices: true };
/** auto_scope = status_only: the portal is a secondary source for this
 *  project (e.g. ستون الندى — the developer's own price files lead). */
const STATUS_ONLY_POLICY: ReconcilePolicy = { absentAvailable: 'leave', createMissing: false, updatePrices: false, forwardOnly: true };

async function runRiva(
  supabase: SupabaseClient,
  run: ProjectUpdateRun,
  settings: Settings,
  registry: RegistryRow[],
  heartbeat: () => Promise<void>,
): Promise<RunResult> {
  const today = riyadhToday();
  const portal = new RivaPortal(await rivaCredentials(supabase), heartbeat);
  await portal.login();
  const listed = await portal.listProjects();
  const listedIds = new Set(listed.map((p) => p.id));

  // Every registered portal id (inactive rows too) — a retired project is not "new".
  const allRegistry = await loadAll(supabase, UNIT_UPDATES_MODEL_ID, { key: 'source_type', value: 'riva_broker' });
  const knownIds = new Set(allRegistry.map((r) => rivaProjectIdFromUrl(r.data.source_url)).filter(Boolean) as string[]);

  const projects: Array<Record<string, unknown>> = [];
  let applied = 0, held = 0, failed = 0, totalChanges = 0;

  for (const row of registry) {
    const portalId = rivaProjectIdFromUrl(row.data.source_url);
    const projectId = typeof row.data.project === 'string' ? row.data.project : null;
    const entry: Record<string, unknown> = { registry_id: row.id, portal_id: portalId, project_id: projectId };
    projects.push(entry);
    try {
      if (!portalId || !projectId) throw new Error('registry row has no portal id or project');
      const project = await loadRecord(supabase, projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      const projectName = String(project.data.project_name ?? '');
      entry.project = projectName;
      if (!listedIds.has(portalId)) {
        entry.status = 'missing_from_portal';
        continue; // reported; retirement stays a human decision
      }
      const scope = typeof row.data.auto_scope === 'string' ? row.data.auto_scope : 'full';
      entry.scope = scope;
      if (scope === 'off') {
        entry.status = 'skipped_off';
        continue;
      }
      const policy: ReconcilePolicy = scope === 'status_only' ? STATUS_ONLY_POLICY : RIVA_POLICY;
      const src = await portal.scrapeProject(portalId);
      const crm = (await loadAll(supabase, UNITS_MODEL_ID, { key: 'project_id', value: projectId })) as CrmUnit[];
      const developerId = typeof project.data.developer === 'string' ? project.data.developer : null;
      const result = reconcile(crm, src.units, policy, {
        projectId, developerId, projectName, sourceLabel: 'بوابة وسطاء ريفا', today,
      });
      const brake = brakeReason(result, { share: settings.brake_share, minUnits: settings.brake_min_units });
      Object.assign(entry, {
        portal_units: src.units.length,
        declared_total: src.declaredTotal,
        crm_units: crm.length,
        stats: result.stats,
        updates: result.updates.map((u) => ({ unit: u.label, why: u.reasons })),
        creates: result.creates.map((c) => ({ unit: c.label, status: c.data.unit_status, price: c.data.total_price ?? null, plan: !!c.source.planUrl })),
        missing_from_portal_units: result.missingFromSource.length,
        missing_sample: result.missingFromSource.slice(0, 15),
        ambiguous: result.ambiguous,
      });
      const gap = src.declaredTotal != null && src.units.length < src.declaredTotal
        ? `؛ البوابة ${src.units.length}/${src.declaredTotal} وحدة` : `؛ البوابة ${src.units.length} وحدة`;

      if (brake) {
        entry.status = 'held';
        entry.held_reason = brake;
        held++;
        if (!run.dry_run) {
          await stamp(supabase, row, project.id, today, addDays(today, 1),
            `${today} — ⛔ تحديث تلقائي موقوف: ${brake}. لم يُكتب شيء؛ سيُعاد غداً.`, false);
        }
        continue;
      }
      if (run.dry_run) {
        entry.status = 'dry_run';
        totalChanges += result.updates.length + result.creates.length;
        continue;
      }
      const out = await applyResult(supabase, { runId: run.id, projectId, projectName, result });
      Object.assign(entry, { status: out.failures.length ? 'partial' : 'applied', written: out });
      totalChanges += out.updated + out.created;
      if (out.updated + out.created > 0) applied++;
      const fails = out.failures.length ? `؛ ⚠ تعذّر ${out.failures.length}` : '';
      const days = frequencyDays(row.data.update_frequency) ?? 7;
      await stamp(supabase, row, project.id, today, addDays(today, days), logLine(today, 'بوابة وسطاء ريفا', result, gap + fails), true);
    } catch (err) {
      failed++;
      entry.status = 'error';
      entry.error = (err as Error).message;
    }
    await heartbeat();
  }

  // Portal projects nobody registered → candidates for a first migration.
  const crmProjects = await loadAll(supabase, PROJECTS_MODEL_ID, null);
  const byName = new Map<string, string>();
  for (const p of crmProjects) {
    const k = normUnitKey(p.data.project_name);
    if (k) byName.set(k, p.id);
  }
  // Read each unregistered project's own page: its name (the card text runs
  // the name, city, brand and commission together) and its units.
  const newProjects: Array<Record<string, unknown>> = [];
  let createdProjects = 0;
  // A registered project of this portal — new ones copy its marketer, city,
  // classification (the "house" fields every Riva project shares).
  let siblingProject: Record<string, unknown> | null = null;
  for (const r of registry) {
    const pid = typeof r.data.project === 'string' ? r.data.project : null;
    const rec = pid ? await loadRecord(supabase, pid) : null;
    if (rec && rec.data.location && rec.data.marketer) { siblingProject = rec.data; break; }
  }
  for (const p of listed.filter((x) => !knownIds.has(x.id))) {
    const item: Record<string, unknown> = { portal_id: p.id, card_text: p.name };
    try {
      const src = await portal.scrapeProject(p.id);
      const name = src.name || p.name;
      const key = normUnitKey(name);
      const exact = byName.get(key) ?? null;
      // «جديل الرمال» on the portal is «أدوار جديل الرمال» in the CRM: a
      // containment hit is reported as a likely match, never auto-linked.
      const likely = exact ? [] : crmProjects
        .filter((c) => {
          const k = normUnitKey(c.data.project_name);
          return k && key && k !== key && (k.includes(key) || key.includes(k));
        })
        .map((c) => ({ id: c.id, name: c.data.project_name }));
      Object.assign(item, {
        name, units: src.units.length, declared_total: src.declaredTotal,
        available: src.units.filter((u) => u.status === 'available').length,
        crm_match: exact, likely_matches: likely.slice(0, 5),
        meta: src.meta ?? {},
      });
      // Create it only when nothing in the CRM could already be it: an exact
      // or likely name match is reported for a human, never duplicated.
      if (!exact && likely.length === 0 && src.units.length > 0 && src.name) {
        if (run.dry_run) {
          item.would_create = true;
        } else {
          const created = await createProjectFromSource(supabase, {
            runId: run.id, src: { ...src, name },
            sourceType: 'riva_broker', sourceLabel: 'بوابة وسطاء ريفا', sourceUrl: src.url,
            sibling: siblingProject, today, updateFrequency: 'weekly',
          });
          item.created = { project_id: created.projectId, code: created.code, units: created.units.created, plans: created.units.plans, failures: created.units.failures, notes: created.notes };
          createdProjects++;
          totalChanges += 1 + created.units.created;
        }
      }
    } catch (err) {
      item.error = (err as Error).message;
    }
    newProjects.push(item);
    await heartbeat();
  }

  const summary = {
    source: 'riva_broker',
    pages_fetched: portal.pagesFetched,
    parse_errors: portal.parseErrors,
    portal_projects: listed.length,
    registered: registry.length,
    applied, held, failed, created_projects: createdProjects, total_changes: totalChanges,
    new_projects: newProjects,
    projects,
  };
  let outcome: RunResult['outcome'];
  if (run.dry_run) outcome = 'dry_run';
  else if (held > 0 || failed > 0) outcome = applied > 0 ? 'partial' : (held > 0 ? 'held' : 'partial');
  else outcome = totalChanges > 0 || createdProjects > 0 ? 'applied' : 'no_change';
  return { outcome, summary };
}

/** Stamp the update-list row (and the project's last_source_update). */
async function stamp(
  supabase: SupabaseClient,
  row: RegistryRow,
  projectId: string,
  today: string,
  nextDue: string,
  line: string,
  success: boolean,
): Promise<void> {
  const prevLog = typeof row.data.migration_log === 'string' ? row.data.migration_log : '';
  const patch: Record<string, unknown> = {
    next_due: nextDue,
    migration_log: prevLog ? `${prevLog}\n${line}` : line,
  };
  if (success) patch.last_migrated_at = today;
  await patchRecord(supabase, row.id, patch);
  if (success) await patchRecord(supabase, projectId, { last_source_update: today });
}

export async function runProjectUpdateJob(args: {
  supabase: SupabaseClient;
  run: ProjectUpdateRun;
}): Promise<RunResult> {
  const { supabase, run } = args;
  const { data: s, error: sErr } = await supabase
    .from('project_update_settings').select('brake_share, brake_min_units').eq('id', 1).single();
  if (sErr || !s) throw new Error(`settings: ${sErr?.message ?? 'missing'}`);
  const settings: Settings = { brake_share: Number(s.brake_share), brake_min_units: Number(s.brake_min_units) };

  let lastBeat = Date.now();
  const heartbeat = async (): Promise<void> => {
    if (Date.now() - lastBeat < HEARTBEAT_MS) return;
    lastBeat = Date.now();
    const { error } = await supabase.rpc('project_update_heartbeat', { p_id: run.id });
    if (error) console.error(`[project-update] heartbeat failed run=${run.id}: ${error.message}`);
  };

  const registry = (await loadAll(supabase, UNIT_UPDATES_MODEL_ID, { key: 'source_type', value: run.source_type }))
    .filter((r) => r.data.is_active === true || r.data.is_active === 'true');
  const only = Array.isArray(run.params.registry_ids) ? new Set(run.params.registry_ids as string[]) : null;
  const scoped = only ? registry.filter((r) => only.has(r.id)) : registry;

  switch (run.source_type) {
    case 'riva_broker':
      return runRiva(supabase, run, settings, scoped, heartbeat);
    default:
      throw new Error(`no adapter for source_type '${run.source_type}' yet`);
  }
}
