/**
 * Unlist the projects Riva has stopped listing (operator rule 2026-10-05:
 * "unlist the projects which Riva unlisted, unless we have a developer
 * source"). Unlisting = the project's Our Projects row goes; the project and
 * its units stay in All Projects (the website flag follows by trigger).
 *
 * "Riva unlisted it" needs BOTH lists to agree: not in the broker portal's
 * project list AND not on the public riva.sa/projects page. On 2026-09-07
 * عبق العارض was off the portal but still on the public page — one list alone
 * is not enough. Guards: both lists must have been read in full (≥ 10
 * projects each), a project with no riva.sa page link is reported not
 * unlisted, and more than 3 unlistings in one run are held for a person
 * (a half-loaded list must never empty Our Projects).
 *
 * Every removal is logged as a `delete` in project_update_changes (the full
 * row in `before`), so project_update_revert puts it back.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { BROWSER_UA } from './http.js';
import { logChange, patchRecord } from './apply.js';
import { rivaProjectIdFromUrl } from './riva.js';

const MAX_UNLIST_PER_RUN = 3;
const MIN_LIST_SIZE = 10;

/** riva.sa/project/<slug> → slug. */
export function rivaSlug(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return url.match(/riva\.sa\/project\/([a-z0-9-]+)/i)?.[1]?.toLowerCase() ?? null;
}

/** Every project slug linked from the public riva.sa/projects page. */
export function rivaPublicSlugs(html: string): Set<string> {
  return new Set([...html.matchAll(/riva\.sa\/project\/([a-z0-9-]+)/gi)].map((m) => m[1]!.toLowerCase()));
}

async function fetchRivaPublicSlugs(): Promise<Set<string>> {
  const res = await fetch('https://riva.sa/projects', {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'ar,en;q=0.8' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`riva.sa/projects answered ${res.status}`);
  return rivaPublicSlugs(await res.text());
}

interface Row { id: string; data: Record<string, unknown> }

export interface UnlistDecision {
  project_id: string;
  project: string;
  status: 'listed' | 'kept_developer_source' | 'no_public_link' | 'would_unlist' | 'unlisted' | 'held_too_many' | 'error';
  note?: string;
}

/** Pure decision for one Our Projects member of a Riva registry row. */
export function decideUnlist(a: {
  portalId: string | null; listedIds: Set<string>; publicSlugs: Set<string>;
  slug: string | null; developer: string | null; devSourced: Set<string>;
}): UnlistDecision['status'] {
  if (a.portalId && a.listedIds.has(a.portalId)) return 'listed';
  if (!a.slug) return 'no_public_link';
  if (a.publicSlugs.has(a.slug)) return 'listed';
  if (a.developer && a.devSourced.has(a.developer)) return 'kept_developer_source';
  return 'would_unlist';
}

export async function unlistDroppedRivaProjects(supabase: SupabaseClient, a: {
  runId: string; dryRun: boolean; today: string;
  listedIds: Set<string>; registry: Row[]; devSourced: Set<string>;
  loadRecord: (id: string) => Promise<Row | null>;
}): Promise<{ checked: boolean; reason?: string; decisions: UnlistDecision[]; unlisted: number }> {
  if (a.listedIds.size < MIN_LIST_SIZE) {
    return { checked: false, reason: `the portal listed only ${a.listedIds.size} projects — not a full list`, decisions: [], unlisted: 0 };
  }
  let publicSlugs: Set<string>;
  try {
    publicSlugs = await fetchRivaPublicSlugs();
  } catch (err) {
    return { checked: false, reason: `riva.sa/projects could not be read: ${(err as Error).message}`, decisions: [], unlisted: 0 };
  }
  if (publicSlugs.size < MIN_LIST_SIZE) {
    return { checked: false, reason: `riva.sa/projects showed only ${publicSlugs.size} projects — not a full list`, decisions: [], unlisted: 0 };
  }

  const { data: m, error: mErr } = await supabase.from('models').select('id').eq('name', 'our_projects').single();
  if (mErr || !m) throw new Error(`our_projects model: ${mErr?.message ?? 'missing'}`);
  const ourModelId = (m as { id: string }).id;
  const { data: ours, error: oErr } = await supabase.from('records').select('id, data').eq('model_id', ourModelId).limit(5000);
  if (oErr) throw new Error(`our_projects rows: ${oErr.message}`);
  const byProject = new Map<string, Row[]>();
  for (const r of (ours ?? []) as Row[]) {
    const ref = r.data.project;
    const pid = typeof ref === 'string' ? ref : Array.isArray(ref) && typeof ref[0] === 'string' ? ref[0] : null;
    if (pid) byProject.set(pid, [...(byProject.get(pid) ?? []), r]);
  }

  const decisions: UnlistDecision[] = [];
  const toUnlist: Array<{ reg: Row; project: Row; rows: Row[] }> = [];
  for (const reg of a.registry) {
    const pid = typeof reg.data.project === 'string' ? reg.data.project : null;
    const rows = pid ? byProject.get(pid) : undefined;
    if (!pid || !rows?.length) continue; // not one of ours — nothing to unlist
    const project = await a.loadRecord(pid);
    if (!project) continue;
    const status = decideUnlist({
      portalId: rivaProjectIdFromUrl(reg.data.source_url), listedIds: a.listedIds, publicSlugs,
      slug: rivaSlug(project.data.project_page_url), devSourced: a.devSourced,
      developer: typeof project.data.developer === 'string' ? project.data.developer : null,
    });
    if (status === 'listed') continue;
    decisions.push({ project_id: pid, project: String(project.data.project_name ?? ''), status });
    if (status === 'would_unlist') toUnlist.push({ reg, project, rows });
  }

  if (toUnlist.length > MAX_UNLIST_PER_RUN) {
    for (const d of decisions) if (d.status === 'would_unlist') {
      d.status = 'held_too_many';
      d.note = `${toUnlist.length} projects at once (limit ${MAX_UNLIST_PER_RUN}) — a person should confirm`;
    }
    return { checked: true, decisions, unlisted: 0 };
  }
  if (a.dryRun) return { checked: true, decisions, unlisted: 0 };

  let unlisted = 0;
  for (const t of toUnlist) {
    const d = decisions.find((x) => x.project_id === t.project.id)!;
    try {
      for (const row of t.rows) {
        const { error } = await supabase.rpc('record_delete', { p_model_id: ourModelId, p_id: row.id });
        if (error) throw new Error(`record_delete ${row.id}: ${error.message}`);
        await logChange(supabase, {
          run_id: a.runId, project_id: t.project.id, record_id: row.id, model: 'our_projects', action: 'delete',
          before: row.data, after: { model_id: ourModelId },
          reason: 'Riva no longer lists it (broker portal + riva.sa/projects); the developer has no source of its own',
        });
      }
      const line = `${a.today} — أُخرج من «مشاريعنا» تلقائياً: ريفا أزالته من بوابة الوسطاء ومن riva.sa/projects، ولا مصدر للمطوّر. باقٍ في كل المشاريع بوحداته.`;
      const prev = typeof t.reg.data.migration_log === 'string' ? t.reg.data.migration_log : '';
      const regPatch = { is_active: false, migration_log: prev ? `${prev}\n${line}` : line };
      const before = await patchRecord(supabase, t.reg.id, regPatch);
      if (before) {
        await logChange(supabase, {
          run_id: a.runId, project_id: t.project.id, record_id: t.reg.id, model: 'unit_updates', action: 'update',
          before, after: regPatch, reason: 'unlisted: Riva dropped the project',
        });
      }
      d.status = 'unlisted';
      unlisted++;
    } catch (err) {
      d.status = 'error';
      d.note = (err as Error).message;
      console.error(`[project-update] unlist ${t.project.id} failed: ${d.note}`);
    }
  }
  return { checked: true, decisions, unlisted };
}
