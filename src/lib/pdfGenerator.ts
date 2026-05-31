import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import { resolveMirror, resolveLookupDisplayValue } from './mirrorResolver';
import type { AppModel, AppRecord, ModelField, ModelView } from '@/types';
import type {
  ResearchComparisonData,
  ProjectRow,
  CellValue,
} from '@/pages/Records/components/ResearchPDFTemplate';

/** Human-readable Arabic formatting for a field value of any supported type. */
function formatValue(field: ModelField, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    return value.map((v) => formatScalar(field, v)).filter((s) => s && s !== '—').join('، ') || '—';
  }
  return formatScalar(field, value);
}

function formatScalar(field: ModelField, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (field.type) {
    case 'currency': {
      const n = Number(v);
      return isNaN(n) ? '—' : `${n.toLocaleString('ar-SA')} ر.س`;
    }
    case 'number': {
      const n = Number(v);
      return isNaN(n) ? '—' : n.toLocaleString('ar-SA');
    }
    case 'date':
    case 'datetime': {
      try {
        return new Date(String(v)).toLocaleDateString('ar-SA');
      } catch {
        return String(v);
      }
    }
    case 'dropdown': {
      const opt = field.options?.find((o) => o.value === v);
      return opt ? opt.label_ar : String(v);
    }
    case 'multiselect': {
      if (typeof v !== 'string') return String(v);
      const opt = field.options?.find((o) => o.value === v);
      return opt ? opt.label_ar : String(v);
    }
    case 'range': {
      if (typeof v === 'object' && v !== null) {
        const { min, max } = v as { min?: number; max?: number };
        const unit = field.range_unit_ar ?? '';
        const fmt = (x?: number) => (x === undefined || x === null ? '' : Number(x).toLocaleString('ar-SA'));
        if (min !== undefined && max !== undefined) return `${fmt(min)} – ${fmt(max)}${unit ? ` ${unit}` : ''}`;
        if (min !== undefined) return `≥ ${fmt(min)}${unit ? ` ${unit}` : ''}`;
        if (max !== undefined) return `≤ ${fmt(max)}${unit ? ` ${unit}` : ''}`;
        return '—';
      }
      return String(v);
    }
    case 'checkbox':
      return v ? 'نعم' : 'لا';
    case 'multi_link': {
      if (!Array.isArray(v)) return String(v);
      return (v as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0).join('، ');
    }
    default:
      return String(v);
  }
}

function resolveTargetRecord(
  lookupField: ModelField,
  id: string,
  allRecords: Record<string, AppRecord[]>,
): AppRecord | null {
  if (!lookupField.lookup_model_id) return null;
  return allRecords[lookupField.lookup_model_id]?.find((r) => r.id === id) ?? null;
}

function resolveTargetLabel(
  targetRecord: AppRecord | null,
  fallbackId: string,
  lookupField: ModelField,
  allModels: AppModel[],
  allRecords: Record<string, AppRecord[]>,
): string {
  if (!targetRecord) return 'سجل محذوف';
  const targetModel = allModels.find((m) => m.id === lookupField.lookup_model_id);
  const titleFieldId = targetModel?.card_config?.title_field_id ?? null;
  const titleField = titleFieldId
    ? targetModel?.schema.sections.flatMap((s) => s.fields).find((f) => f.id === titleFieldId)
    : null;
  const displayFieldName = titleField?.name ?? lookupField.lookup_display_field ?? null;
  if (displayFieldName) {
    // displayFieldName may name a mirror on the target model (computed at runtime).
    const v = resolveLookupDisplayValue(targetRecord, displayFieldName, { targetModel, allModels, allRecords });
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  }
  return `#${fallbackId.slice(0, 6)}`;
}

interface ColumnSpec {
  id: string; // unique key used for view.field_ids matching
  label: string; // AR display label
  /** Per-project cell value — string for most types, { text, url } for clickable URLs. */
  compute: (projectId: string, projectIndex: number) => CellValue;
  field: ModelField; // underlying field for view ordering / filtering
}

/** Coerce a raw value to the URL-cell shape if the field type is url, else a formatted string. */
function cellFor(field: ModelField, value: unknown): CellValue {
  if (field.type === 'url') {
    if (value === null || value === undefined || value === '') return '—';
    const raw = String(value);
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return { text: 'فتح الرابط', url: href };
  }
  return formatValue(field, value);
}

/**
 * Build the per-project comparison matrix from a research record. Walks the
 * research model's fields dynamically, so any user customization in the Builder
 * (different field sets, renamed slugs, different source sections) still
 * renders correctly.
 *
 * Orientation: **projects are rows, fields are columns**. Scoped by an optional
 * active view: filters column ids against view.field_ids (preserving view order)
 * and filters project ids against view.project_ids. Stale ids drop silently.
 */
function buildComparisonData(
  record: AppRecord,
  model: AppModel,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
  activeView?: ModelView | null,
): ResearchComparisonData {
  const allFields = model.schema.sections.flatMap((s) => s.fields);

  // Identify the primary project lookup — the lookup field that section_mirror and
  // regular mirror fields hop through. Prefer a field named 'project_name'; fall
  // back to the first multi-select lookup; then any lookup.
  const lookupFields = allFields.filter((f) => f.type === 'lookup' && !!f.lookup_model_id);
  const primaryLookup =
    lookupFields.find((f) => f.name === 'project_name') ??
    lookupFields.find((f) => f.is_multi) ??
    lookupFields[0] ??
    null;

  const allProjectIds: string[] = (() => {
    if (!primaryLookup) return [];
    const raw = record.data[primaryLookup.name];
    if (Array.isArray(raw)) return (raw as unknown[]).filter((v): v is string => typeof v === 'string' && !!v);
    if (typeof raw === 'string' && raw) return [raw];
    return [];
  })();

  // Apply view's project_ids filter (intersection with currently linked).
  const visibleProjectIds = (() => {
    if (!activeView?.project_ids?.length) return allProjectIds;
    const picked = new Set(activeView.project_ids);
    return allProjectIds.filter((id) => picked.has(id));
  })();

  const projectRecords = visibleProjectIds.map((id) => ({
    id,
    record: primaryLookup ? resolveTargetRecord(primaryLookup, id, allRecords) : null,
    // Keep original index in the research record so per-project mirror resolution
    // uses the right sibling value position.
    originalIndex: allProjectIds.indexOf(id),
  }));

  const projectLabels = primaryLookup
    ? projectRecords.map((p) => resolveTargetLabel(p.record, p.id, primaryLookup, allModels, allRecords))
    : [];

  // Build the full ordered column spec list by walking every field in the model.
  const columns: ColumnSpec[] = [];

  for (const f of allFields) {
    if (f.type === 'lookup') continue;
    if (f.type === 'section_selector') continue;
    if (f.type === 'notes') continue;

    if (f.type === 'mirror') {
      columns.push({
        id: f.id,
        label: f.label_ar || f.label_en,
        field: f,
        compute: (projectId) => {
          const singleData = { ...record.data };
          if (primaryLookup) singleData[primaryLookup.name] = projectId;
          const res = resolveMirror(f, singleData, allRecords, allModels);
          if (res.status !== 'ok' || !res.targetField) return '—';
          return cellFor(res.targetField, res.value);
        },
      });
      continue;
    }

    if (f.type === 'section_mirror') {
      // Resolve the source section and iterate its fields.
      const viaId = f.section_mirror_via_lookup_field_id ?? null;
      const sourceSectionId = f.section_mirror_source_section_id ?? null;
      if (!viaId || !sourceSectionId) continue;
      const sibling = allFields.find((x) => x.id === viaId);
      if (!sibling || sibling.type !== 'lookup' || !sibling.lookup_model_id) continue;
      const sourceModel = allModels.find((m) => m.id === sibling.lookup_model_id);
      if (!sourceModel) continue;
      const sourceSection = sourceModel.schema.sections.find((s) => s.id === sourceSectionId);
      if (!sourceSection) continue;

      const fieldMode = f.section_mirror_field_mode ?? 'all';
      const picked = new Set(f.section_mirror_field_names ?? []);
      const candidates = [...sourceSection.fields]
        .filter((x) => x.type !== 'section_mirror' && x.type !== 'section_selector')
        .sort((a, b) => a.order - b.order);
      const included = fieldMode === 'all' ? candidates : candidates.filter((x) => picked.has(x.name));

      for (const child of included) {
        columns.push({
          id: child.id,
          label: child.label_ar || child.label_en,
          field: child,
          compute: (projectId) => {
            const target = allRecords[sibling.lookup_model_id!]?.find((r) => r.id === projectId) ?? null;
            if (!target) return '—';
            return cellFor(child, target.data[child.name]);
          },
        });
      }
      continue;
    }

    // Scalar / text / number / dropdown / url / etc. — record-level, same across projects.
    const cell = cellFor(f, record.data[f.name]);
    if (cell === '—') continue;
    columns.push({
      id: f.id,
      label: f.label_ar || f.label_en,
      field: f,
      compute: () => cell,
    });
  }

  // Apply view's field_ids filter, preserving view order.
  const visibleColumns: ColumnSpec[] = (() => {
    if (!activeView?.field_ids?.length) return columns;
    const byId = new Map(columns.map((c) => [c.id, c]));
    const picked = activeView.field_ids.map((id) => byId.get(id)).filter((c): c is ColumnSpec => !!c);
    return picked.length > 0 ? picked : columns; // fall back if all stale
  })();

  const fieldLabels = visibleColumns.map((c) => c.label);

  const projectRows: ProjectRow[] = projectRecords.map((p, i) => ({
    label: projectLabels[i] ?? `#${p.id.slice(0, 6)}`,
    values: visibleColumns.map((c) => c.compute(p.id, p.originalIndex)),
  }));

  return {
    fieldLabels,
    projectRows,
    generatedAt: new Date().toLocaleDateString('ar-SA'),
  };
}

export async function generateResearchPDF(
  record: AppRecord,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
  activeView?: ModelView | null,
): Promise<void> {
  const model = allModels.find((m) => m.id === record.model_id);
  if (!model) return;

  const data = buildComparisonData(record, model, allRecords, allModels, activeView);
  // Landscape when we have many columns (fields are now the wide axis).
  const landscape = data.fieldLabels.length >= 3;

  const { default: React } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { default: ResearchPDFTemplate } = await import(
    '@/pages/Records/components/ResearchPDFTemplate'
  );

  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.style.top = '0';
  document.body.appendChild(container);

  const root = createRoot(container);
  const templateRef = React.createRef<HTMLDivElement>();

  await new Promise<void>((resolve) => {
    root.render(
      React.createElement(ResearchPDFTemplate, { data, landscape, ref: templateRef }),
    );
    setTimeout(resolve, 500);
  });

  const element = templateRef.current ?? (container.firstElementChild as HTMLElement);
  if (!element) {
    document.body.removeChild(container);
    return;
  }

  try {
    const canvas = await html2canvas(element as HTMLElement, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
    });

    const pdf = new jsPDF({
      orientation: landscape ? 'landscape' : 'portrait',
      unit: 'mm',
      format: 'a4',
    });

    const imgData = canvas.toDataURL('image/png');
    const pdfWidth = landscape ? 297 : 210;
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);

    // Overlay clickable link annotations on top of the rasterized image.
    // Each <a data-pdf-link="..."> in the template gets its bounding rect
    // mapped to PDF space via pdf.link — preserves clickable URLs even though
    // the rest of the page is a single bitmap.
    const templateRect = (element as HTMLElement).getBoundingClientRect();
    const linkEls = (element as HTMLElement).querySelectorAll('[data-pdf-link]');
    linkEls.forEach((el) => {
      const href = el.getAttribute('data-pdf-link');
      if (!href) return;
      const r = (el as HTMLElement).getBoundingClientRect();
      const x = ((r.left - templateRect.left) / templateRect.width) * pdfWidth;
      const y = ((r.top - templateRect.top) / templateRect.height) * pdfHeight;
      const w = (r.width / templateRect.width) * pdfWidth;
      const h = (r.height / templateRect.height) * pdfHeight;
      pdf.link(x, y, w, h, { url: href });
    });

    const first = data.projectRows[0]?.label ?? `research_${record.id.slice(0, 8)}`;
    const count = data.projectRows.length;
    const safeName = first.replace(/[\\/:*?"<>|]/g, '-').trim() || `research_${record.id.slice(0, 8)}`;
    const filename = count >= 2 ? `${safeName}-and-${count - 1}-others.pdf` : `${safeName}.pdf`;
    pdf.save(filename);
  } finally {
    root.unmount();
    document.body.removeChild(container);
  }
}
