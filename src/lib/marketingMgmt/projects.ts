/**
 * Project options for marketing content.
 *
 * Reads the projects already in the store rather than adding an endpoint: the
 * SPA loads models + records at boot, so a second server round trip would fetch
 * data the browser is holding. This is also why the developer is DERIVED here
 * instead of being copied onto the content row — a denormalised copy would go
 * stale the moment a project changes hands, and the whole point of linking to
 * the project is that the project stays the source of truth.
 *
 * `developer` on all_projects is a lookup holding a Developers record id, so it
 * is resolved through that model's `name`. When it cannot be resolved the label
 * is null and the UI says "غير محدد" — never a raw uuid.
 */
import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';

export interface ProjectOption {
  id: string;
  name: string;
  developer: string | null;
  /** True when the project is in "مشاريعنا" (Our Projects).
   *
   *  `is_public` is not a second list to keep in step — it is maintained on
   *  all_projects by trigger from Our Projects membership and is read-only in
   *  the schema, so it cannot drift from that membership. Reading the flag off
   *  the record the store already holds is therefore both correct and free;
   *  fetching the our_projects model separately would add a round trip to learn
   *  something this row already says. */
  isOurs: boolean;
}

const asText = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
};

export function useProjectOptions(): ProjectOption[] {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  return useMemo(() => {
    const projectsModel = models.find((m) => m.name === 'all_projects');
    if (!projectsModel) return [];
    const devModel = models.find((m) => m.name === 'developers');
    const devById = new Map<string, string>();
    if (devModel) {
      for (const d of records[devModel.id] ?? []) {
        const n = asText(d.data.name);
        if (n) devById.set(d.id, n);
      }
    }
    const out: ProjectOption[] = [];
    for (const r of records[projectsModel.id] ?? []) {
      const name = asText(r.data.project_name);
      if (!name) continue;                       // unnamed rows are not pickable
      const devRaw = r.data.developer;
      // A lookup may hold an id or, on older rows, the plain name.
      const devId = asText(devRaw);
      const developer = devId ? (devById.get(devId) ?? (devById.size && /^[0-9a-f-]{36}$/i.test(devId) ? null : devId)) : null;
      out.push({ id: r.id, name, developer, isOurs: r.data.is_public === true });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }, [models, records]);
}

/** Only the projects Wassel actually markets — 49 of the ~980 rows in
 *  all_projects, the rest being the market/competitor catalogue.
 *
 *  A campaign of ours is for a project of ours, so offering the whole catalogue
 *  made the picker a scrolling list nobody could find anything in. Anything
 *  ALREADY linked is added back by the picker itself, so narrowing the list can
 *  never make an existing link disappear. */
export function useOurProjectOptions(): ProjectOption[] {
  const all = useProjectOptions();
  return useMemo(() => all.filter((p) => p.isOurs), [all]);
}

/** Resolve one project id to its option, for display on a content item. */
export function useProject(projectId: string | null | undefined): ProjectOption | null {
  const options = useProjectOptions();
  return useMemo(
    () => (projectId ? options.find((p) => p.id === projectId) ?? null : null),
    [options, projectId],
  );
}
