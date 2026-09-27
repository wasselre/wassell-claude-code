/**
 * «اختيار المشروع والوحدات» — the project + units choice for appointments and
 * visits, made in the SAME Projects & Units browser the WhatsApp chat uses
 * (project cards with photos and prices, search, filters, map, and the full
 * units table) opened in pick mode. Used by the quick appointment / visit forms
 * and, through UnitPickerField, by those models' full record forms.
 *
 * Split into a hook (`useProjectUnitsPicker`: the state, the value mapping and
 * the browser element) and a plain summary button, because a MODAL host must
 * step aside while the browser is open — the browser sits below the modal layer
 * on purpose so its own unit drawer / compare modal can stack above it — and it
 * can only do that if the browser is rendered OUTSIDE the modal.
 *
 * The browser lists `all_projects` (our marketed ones only). The form's project
 * field may point at a DIFFERENT model:
 *   - appointments.project_id → All Projects  → stored as picked;
 *   - visits.project_id       → Our Projects  → the Our Projects entry whose
 *     `project` link is the picked project is stored instead.
 * Units always belong to an all_projects project and are stored as ids.
 */
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Building2, Pencil } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { recordTitle } from '@/lib/documents/links';
import { modelByName, fieldByCandidates } from '@/lib/projects/projectView';
import type { AppModel, AppRecord, ModelField } from '@/types';

const ProjectsUnitsBrowser = lazy(() => import('@/pages/Chats/components/ProjectsUnitsBrowser'));

interface PickerOptions {
  /** The model id the form's project field looks up (All Projects or Our Projects). */
  projectLookupModelId: string | null | undefined;
  /** The form's current project value (an id in that lookup model). */
  projectValue: unknown;
  unitIds: string[];
  /** Also choose units (false → project only). */
  withUnits: boolean;
  onChange: (next: { projectValue: string; unitIds: string[] }) => void;
}

export interface ProjectUnitsPicker {
  open: boolean;
  openBrowser: () => void;
  projectName: string | null;
  unitLabels: string[];
  withUnits: boolean;
  /** The browser element (null while closed) — render it OUTSIDE any modal. */
  browser: ReactNode;
}

const firstId = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' && x ? x : null;
};

export function useProjectUnitsPicker({
  projectLookupModelId, projectValue, unitIds, withUnits, onChange,
}: PickerOptions): ProjectUnitsPicker {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = useAppStore((s) => s.language) === 'ar';
  const [open, setOpen] = useState(false);

  const allModel = useMemo(() => modelByName(models, 'all_projects'), [models]);
  const ourModel = useMemo(() => modelByName(models, 'our_projects'), [models]);
  const unitsModel = useMemo(() => modelByName(models, 'units'), [models]);
  const storesOurProjects = !!ourModel && projectLookupModelId === ourModel.id;
  const ourLinkSlug = useMemo(() => fieldByCandidates(ourModel, ['project'])?.name ?? null, [ourModel]);
  const ourRecords: AppRecord[] = useMemo(() => (ourModel ? records[ourModel.id] ?? [] : []), [ourModel, records]);

  // The form's value → the all_projects id the browser speaks.
  const currentAllProjectId = useMemo(() => {
    const id = firstId(projectValue);
    if (!id) return null;
    if (!storesOurProjects) return id;
    const our = ourRecords.find((r) => r.id === id);
    return our && ourLinkSlug ? firstId((our.data as Record<string, unknown>)[ourLinkSlug]) : null;
  }, [projectValue, storesOurProjects, ourRecords, ourLinkSlug]);

  const projectName = useMemo(() => {
    if (!currentAllProjectId || !allModel) return null;
    const rec = (records[allModel.id] ?? []).find((r) => r.id === currentAllProjectId);
    return rec ? recordTitle(allModel, rec, isAr) : null;
  }, [currentAllProjectId, allModel, records, isAr]);

  const unitLabels = useMemo(() => {
    if (!unitsModel || unitIds.length === 0) return [];
    const byId = new Map((records[unitsModel.id] ?? []).map((r) => [r.id, r]));
    return unitIds.map((id) => {
      const u = byId.get(id);
      const code = u ? (u.data as Record<string, unknown>).unit_code : null;
      return typeof code === 'string' && code ? code : u ? recordTitle(unitsModel, u, isAr) : id.slice(0, 8);
    });
  }, [unitsModel, records, unitIds, isAr]);

  const handlePick = ({ projectId, unitIds: picked }: { projectId: string; unitIds: string[] }) => {
    let value = projectId;
    if (storesOurProjects) {
      const our = ourLinkSlug
        ? ourRecords.find((r) => firstId((r.data as Record<string, unknown>)[ourLinkSlug]) === projectId)
        : undefined;
      if (!our) {
        // The browser lists only projects that HAVE an Our Projects entry, so this
        // means the portfolio changed underneath us — say so, keep the old value.
        console.error('[useProjectUnitsPicker] no our_projects entry links to', projectId);
        addToast(isAr ? 'هذا المشروع غير موجود ضمن مشاريعنا — اختر مشروعاً آخر' : 'That project is not in Our Projects — pick another', 'error');
        return;
      }
      value = our.id;
    }
    onChange({ projectValue: value, unitIds: withUnits ? picked : [] });
    setOpen(false);
  };

  const browser = open ? (
    <Suspense fallback={null}>
      <ProjectsUnitsBrowser
        onClose={() => setOpen(false)}
        pick={{ initialProjectId: currentAllProjectId, initialUnitIds: unitIds, withUnits, onPick: handlePick }}
      />
    </Suspense>
  ) : null;

  return { open, openBrowser: () => setOpen(true), projectName, unitLabels, withUnits, browser };
}

/** The form's summary of the choice; clicking it opens the browser. */
export function ProjectUnitsSummaryButton({ picker }: { picker: ProjectUnitsPicker }) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const { projectName, unitLabels, withUnits } = picker;
  return (
    <button
      type="button"
      onClick={picker.openBrowser}
      className="flex w-full items-center gap-2.5 rounded-lg border border-sand bg-white px-3 py-2.5 text-start text-sm transition-colors hover:border-copper/40 hover:bg-cream/50"
    >
      <Building2 size={16} className="shrink-0 text-copper" />
      <span className="min-w-0 flex-1">
        {projectName ? (
          <>
            <span className="block truncate font-semibold text-charcoal">{projectName}</span>
            {withUnits && (
              <span className="block truncate text-xs text-charcoal/55" dir="auto">
                {unitLabels.length > 0 ? unitLabels.join(' · ') : isAr ? 'لم تُحدَّد وحدات' : 'No units chosen'}
              </span>
            )}
          </>
        ) : (
          <span className="text-charcoal/50">
            {withUnits
              ? isAr ? 'اختيار المشروع والوحدات' : 'Choose project & units'
              : isAr ? 'اختيار المشروع' : 'Choose project'}
          </span>
        )}
      </span>
      {projectName && <Pencil size={14} className="shrink-0 text-charcoal/40" />}
    </button>
  );
}

/** Models whose `unit_picker` field uses the browser instead of UnitPickerField. */
export const BROWSER_UNIT_PICKER_MODELS = new Set(['appointments', 'visits']);

/**
 * The full record form's version (DynamicField, `unit_picker` on appointments /
 * visits): the units field value plus its sibling project field, written
 * together through `onPatch` so the two can never disagree.
 */
export function ProjectUnitsPickerField({
  owner, field, value, recordData, onPatch,
}: {
  owner: AppModel;
  field: ModelField;
  value: unknown;
  recordData?: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const projectSlug = field.unit_picker_project_from_field || 'project_id';
  const projectField = owner.schema.sections.flatMap((s) => s.fields).find((f) => f.name === projectSlug);
  const picker = useProjectUnitsPicker({
    projectLookupModelId: projectField?.lookup_model_id,
    projectValue: recordData?.[projectSlug],
    unitIds: Array.isArray(value) ? (value as string[]) : typeof value === 'string' && value ? [value] : [],
    withUnits: true,
    onChange: ({ projectValue, unitIds }) =>
      onPatch({ [projectSlug]: projectValue, [field.name]: field.is_multi ? unitIds : unitIds[0] ?? undefined }),
  });
  return (
    <>
      <ProjectUnitsSummaryButton picker={picker} />
      {picker.browser}
    </>
  );
}
