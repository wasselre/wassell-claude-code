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
      out.push({ id: r.id, name, developer });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }, [models, records]);
}

/** Resolve one project id to its option, for display on a content item. */
export function useProject(projectId: string | null | undefined): ProjectOption | null {
  const options = useProjectOptions();
  return useMemo(
    () => (projectId ? options.find((p) => p.id === projectId) ?? null : null),
    [options, projectId],
  );
}
