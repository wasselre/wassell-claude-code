import { Phone, Copy, StickyNote, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Badge from '@/components/ui/Badge';
import WhatsAppIcon from '@/components/ui/WhatsAppIcon';
import { telUrl, whatsappUrl } from '@/lib/phone';
import { resolveMirror, resolveLookupDisplayValue } from '@/lib/mirrorResolver';
import { formatRangeValue } from './RangeField';
import { formatFormulaValue, isFormulaErrorValue } from '@/lib/formulaEngine';
import {
  ImageCell,
  MultiImageCell,
  FileCell,
  MultiFileCell,
  AttachmentCell,
} from './DriveCells';
import { VideoCell, MultiVideoCell } from './VideoField';
import { resolveDisplayText, useValueTranslationVersion } from '@/lib/valueTranslation/runtime';
import { isTranslatableField, kindForField } from '@/lib/valueTranslation/config';
import type { ModelField, AppRecord, AttachmentRef, NoteEntry, LocationLevel, TableColumn } from '@/types';

interface DynamicCellProps {
  field: ModelField;
  value: unknown;
  allRecords: Record<string, AppRecord[]>;
  recordData?: Record<string, unknown>;
}

export default function DynamicCell({ field, value, allRecords, recordData }: DynamicCellProps) {
  const { t } = useTranslation();
  const { language, addToast, models, openChatComposer } = useAppStore();
  const isAr = language === 'ar';
  const lang = isAr ? ('ar' as const) : ('en' as const);
  // Re-render when async value translations arrive (cache misses resolve).
  useValueTranslationVersion();

  // Mirror fields resolve at render time by hopping through a sibling lookup.
  // Handle BEFORE the empty check so sibling-not-selected / deleted-record states render correctly.
  if (field.type === 'mirror') {
    const res = resolveMirror(field, recordData ?? null, allRecords, models);
    if (res.status === 'target_record_missing') {
      return <span className="text-charcoal/30 italic text-xs">{isAr ? 'سجل محذوف' : 'Deleted record'}</span>;
    }
    if (res.status !== 'ok' || !res.targetField) {
      return <span className="text-charcoal/20">—</span>;
    }
    if (Array.isArray(res.value)) {
      const items = res.value as unknown[];
      if (items.length === 0) return <span className="text-charcoal/20">—</span>;
      return (
        <div className="flex flex-wrap gap-1 items-center">
          {items.map((v, i) => (
            <DynamicCell
              key={i}
              field={res.targetField!}
              value={v}
              allRecords={allRecords}
              recordData={res.targetRecord?.data}
            />
          ))}
        </div>
      );
    }
    return (
      <DynamicCell
        field={res.targetField}
        value={res.value}
        allRecords={allRecords}
        recordData={res.targetRecord?.data}
      />
    );
  }

  // Notes: render a compact count badge + most-recent-entry preview.
  // Handle before the empty check so an empty [] renders as the zero state rather than "—".
  if (field.type === 'notes') {
    const entries: NoteEntry[] = Array.isArray(value)
      ? (value as unknown[]).filter(
          (e): e is NoteEntry =>
            !!e && typeof e === 'object' && typeof (e as NoteEntry).text === 'string',
        )
      : [];
    if (entries.length === 0) {
      return <span className="text-charcoal/30 italic text-xs">{t('fields.notes_count_zero')}</span>;
    }
    const latest = entries.reduce(
      (a, b) => (a.created_at > b.created_at ? a : b),
      entries[0]!,
    );
    const countLabel =
      entries.length === 1
        ? t('fields.notes_count_one')
        : isAr && entries.length === 2
          ? t('fields.notes_count_two')
          : t('fields.notes_count_other', { count: entries.length });
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span className="inline-flex items-center gap-1 text-copper font-bold">
          <StickyNote size={12} />
          {countLabel}
        </span>
        <span className="text-charcoal/40 truncate max-w-[16rem]">
          {resolveDisplayText(latest.text, lang, { kind: 'text', field_hint: field.name })
            .replace(/\s+/g, ' ')
            .slice(0, 60)}
        </span>
      </span>
    );
  }

  if (value === undefined || value === null || value === '') {
    return <span className="text-charcoal/20">—</span>;
  }

  switch (field.type) {
    case 'text':
      return (
        <span>
          {isTranslatableField(field)
            ? resolveDisplayText(value, lang, { kind: kindForField(field), field_hint: field.name })
            : String(value)}
        </span>
      );

    case 'email':
    case 'number':
      return <span>{String(value)}</span>;

    // Read-only display of a `table` field (rows = array of {column_slug: value}).
    // Without this the default branch stringifies the array → "[object Object]".
    case 'table': {
      const cols: TableColumn[] = field.table_columns ?? [];
      const rows = Array.isArray(value)
        ? (value as unknown[]).filter(
            (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r),
          )
        : [];
      if (cols.length === 0 || rows.length === 0) {
        return <span className="text-charcoal/20">—</span>;
      }
      const renderCell = (col: TableColumn, raw: unknown) => {
        if (raw === undefined || raw === null || raw === '') {
          return <span className="text-charcoal/20">—</span>;
        }
        if (col.type === 'dropdown') {
          const opt = col.options?.find((o) => o.value === raw);
          if (opt) return <Badge label={isAr ? opt.label_ar : opt.label_en} color={opt.color} />;
        }
        return <span>{String(raw)}</span>;
      };
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-charcoal/50">
                {cols.map((c) => (
                  <th
                    key={c.id}
                    className="text-start font-bold px-2 py-1 border-b border-sand/40 whitespace-nowrap"
                  >
                    {isAr ? c.label_ar : c.label_en}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="align-top">
                  {cols.map((c) => (
                    <td key={c.id} className="px-2 py-1 border-b border-sand/20">
                      {renderCell(c, row[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'url': {
      const href = String(value);
      const safeHref = /^https?:\/\//i.test(href) ? href : `https://${href}`;
      return (
        <a
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-copper/10 hover:bg-copper/20 text-copper text-xs font-bold transition-colors"
          title={href}
          dir="ltr"
        >
          <ExternalLink size={12} />
          {isAr ? 'فتح الرابط' : 'Open link'}
        </a>
      );
    }

    case 'multi_link': {
      const links = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [];
      if (links.length === 0) return <span className="text-charcoal/20">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {links.map((link, i) => {
            const safeHref = /^https?:\/\//i.test(link) ? link : `https://${link}`;
            return (
              <a
                key={i}
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-copper/10 hover:bg-copper/20 text-copper text-xs font-bold transition-colors"
                title={link}
                dir="ltr"
              >
                <ExternalLink size={12} />
                {isAr ? 'زر' : 'Button'} {i + 1}
              </a>
            );
          })}
        </div>
      );
    }

    case 'auto_id':
      return <span className="font-mono font-bold text-copper" dir="ltr">{String(value)}</span>;

    case 'image':
      return <ImageCell fileId={String(value)} isAr={isAr} />;

    case 'multi_image': {
      const ids = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [];
      return <MultiImageCell fileIds={ids} isAr={isAr} />;
    }

    case 'video':
      return <VideoCell value={String(value)} isAr={isAr} />;

    case 'multi_video': {
      const vids = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [];
      return <MultiVideoCell values={vids} isAr={isAr} />;
    }

    case 'file':
      return <FileCell fileId={String(value)} isAr={isAr} />;

    case 'multi_file': {
      const ids = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : [];
      return <MultiFileCell fileIds={ids} isAr={isAr} />;
    }

    case 'attachment': {
      const refs: AttachmentRef[] = Array.isArray(value)
        ? value.filter(
            (r): r is AttachmentRef =>
              !!r && typeof r === 'object' && 'type' in r && 'id' in r &&
              (r.type === 'file' || r.type === 'folder') && typeof r.id === 'string',
          )
        : [];
      return <AttachmentCell refs={refs} isAr={isAr} />;
    }

    case 'template_variables': {
      // Two-level map: { [templateId]: { [varName]: { value } } }.
      // Sum across templates for the compact table-cell summary.
      const outer = (value && typeof value === 'object' && !Array.isArray(value))
        ? (value as Record<string, Record<string, { value: unknown }>>)
        : {};
      let filled = 0;
      let total = 0;
      for (const inner of Object.values(outer)) {
        if (!inner || typeof inner !== 'object') continue;
        for (const entry of Object.values(inner)) {
          total++;
          if (entry?.value !== undefined && entry?.value !== '') filled++;
        }
      }
      if (total === 0) return <span className="text-charcoal/20">—</span>;
      return (
        <span className="text-xs text-charcoal/60" dir="ltr">
          {filled}/{total} {isAr ? 'متغيرات' : 'vars'}
        </span>
      );
    }

    case 'templates_picker': {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      if (ids.length === 0) return <span className="text-charcoal/20">—</span>;
      return (
        <span className="text-xs text-charcoal/60" dir="ltr">
          {ids.length} {isAr ? 'قالب' : 'template' + (ids.length === 1 ? '' : 's')}
        </span>
      );
    }

    case 'generations_gallery': {
      // Read from recordData.generations (sibling field) for a count.
      const gens = recordData?.generations;
      const map = (gens && typeof gens === 'object' && !Array.isArray(gens))
        ? (gens as Record<string, { status?: string }>)
        : {};
      const total = Object.keys(map).length;
      if (total === 0) return <span className="text-charcoal/20">—</span>;
      const done = Object.values(map).filter((g) => g?.status === 'complete').length;
      return (
        <span className="text-xs text-charcoal/60" dir="ltr">
          {done}/{total} {isAr ? 'مكتمل' : 'done'}
        </span>
      );
    }

    case 'formula': {
      if (isFormulaErrorValue(value)) return <span className="font-mono text-red-500 text-xs">{String(value)}</span>;
      if (typeof value === 'boolean') return <span>{value ? (isAr ? 'نعم' : 'true') : (isAr ? 'لا' : 'false')}</span>;
      const locale = isAr ? 'ar-SA' : 'en-SA';
      const formatted = formatFormulaValue(value as number | string, field, locale);
      return <span dir="ltr">{formatted}</span>;
    }

    case 'phone': {
      const raw = String(value);
      const tel = telUrl(raw);
      const wa = whatsappUrl(raw);
      return (
        <span className="inline-flex items-center gap-2" dir="ltr">
          <span>{raw}</span>
          {wa && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openChatComposer({ phone: raw }); }}
              aria-label={isAr ? 'واتساب' : 'WhatsApp'}
              title={isAr ? 'واتساب' : 'WhatsApp'}
              className="text-copper hover:text-terracotta transition-colors"
            >
              <WhatsAppIcon size={14} />
            </button>
          )}
          {tel && (
            <a
              href={tel}
              onClick={(e) => e.stopPropagation()}
              aria-label={isAr ? 'اتصال' : 'Call'}
              title={isAr ? 'اتصال' : 'Call'}
              className="text-copper hover:text-terracotta transition-colors"
            >
              <Phone size={14} />
            </a>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(raw).then(
                () => addToast(isAr ? 'تم نسخ رقم الهاتف' : 'Phone number copied', 'success'),
                () => addToast(isAr ? 'تعذّر النسخ' : 'Copy failed', 'error'),
              );
            }}
            aria-label={isAr ? 'نسخ' : 'Copy'}
            title={isAr ? 'نسخ' : 'Copy'}
            className="text-copper hover:text-terracotta transition-colors"
          >
            <Copy size={14} />
          </button>
        </span>
      );
    }

    case 'textarea':
      return (
        <span className="truncate max-w-xs block">
          {isTranslatableField(field)
            ? resolveDisplayText(value, lang, { kind: 'text', field_hint: field.name })
            : String(value)}
        </span>
      );

    case 'range': {
      const str = formatRangeValue(field, value, isAr);
      if (!str) return <span className="text-charcoal/20">—</span>;
      return <span dir="ltr">{str}</span>;
    }

    case 'currency': {
      const num = Number(value);
      if (isNaN(num)) return <span>{String(value)}</span>;
      const formatted = num.toLocaleString(isAr ? 'ar-SA' : 'en-SA');
      return <span>{formatted} {isAr ? 'ر.س' : 'SAR'}</span>;
    }

    case 'date': {
      try {
        const d = new Date(String(value));
        return <span>{d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB')}</span>;
      } catch {
        return <span>{String(value)}</span>;
      }
    }

    case 'datetime': {
      try {
        const d = new Date(String(value));
        return (
          <span>
            {d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB')}{' '}
            {d.toLocaleTimeString(isAr ? 'ar-SA' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        );
      } catch {
        return <span>{String(value)}</span>;
      }
    }

    case 'checkbox':
      return <span>{value ? '✓' : '✗'}</span>;

    case 'dropdown': {
      const opt = field.options?.find((o) => o.value === value);
      if (!opt) return <span>{String(value)}</span>;
      return <Badge label={isAr ? opt.label_ar : opt.label_en} color={opt.color} />;
    }

    case 'multiselect':
    case 'section_selector': {
      const vals = Array.isArray(value) ? value as string[] : [];
      return (
        <div className="flex flex-wrap gap-1">
          {vals.map((v) => {
            const opt = field.options?.find((o) => o.value === v);
            if (!opt) return <Badge key={v} label={v} />;
            return <Badge key={v} label={isAr ? opt.label_ar : opt.label_en} color={opt.color} />;
          })}
        </div>
      );
    }

    case 'lookup': {
      if (!field.lookup_model_id || !field.lookup_display_field) {
        return <span className="text-charcoal/30">—</span>;
      }
      const linkedRecords = allRecords[field.lookup_model_id] ?? [];
      const displayFieldName = field.lookup_display_field;
      // Pass the target model + full models/records so a `mirror` display field
      // resolves through its sibling-lookup hop; non-mirror fields read raw.
      const linkedModel = models.find((m) => m.id === field.lookup_model_id);
      const displayCtx = { targetModel: linkedModel, allModels: models, allRecords };

      const renderOne = (id: string) => {
        const linkedRecord = linkedRecords.find((r) => r.id === id);
        if (!linkedRecord) {
          return <span key={id} className="text-charcoal/30 italic text-xs">{isAr ? 'سجل محذوف' : 'Deleted record'}</span>;
        }
        const displayVal = resolveLookupDisplayValue(linkedRecord, displayFieldName, displayCtx);
        const text = displayVal !== null && displayVal !== undefined && typeof displayVal !== 'object'
          ? String(displayVal)
          : (displayVal ? String(displayVal) : id.slice(0, 8));
        // Lookup display fields are almost always names (project, developer,
        // client) — overlay-translate so English mode shows "Masaken Al Aseel"
        // instead of the raw Arabic project name.
        return <span key={id} className="text-copper font-bold">{resolveDisplayText(text, lang, { kind: 'name', field_hint: displayFieldName })}</span>;
      };

      // Multi-select: chip list.
      if (field.is_multi || Array.isArray(value)) {
        const ids = Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === 'string') : [];
        if (ids.length === 0) return <span className="text-charcoal/20">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {ids.map((id) => (
              <Badge key={id} label={(() => {
                const linkedRecord = linkedRecords.find((r) => r.id === id);
                if (!linkedRecord) return isAr ? 'سجل محذوف' : 'Deleted';
                const dv = resolveLookupDisplayValue(linkedRecord, displayFieldName, displayCtx);
                const text = dv !== null && dv !== undefined && typeof dv !== 'object' ? String(dv) : id.slice(0, 8);
                return resolveDisplayText(text, lang, { kind: 'name', field_hint: displayFieldName });
              })()} />
            ))}
          </div>
        );
      }

      // Single-select
      if (typeof value !== 'string' || !value) return <span className="text-charcoal/30">—</span>;
      return renderOne(value);
    }

    case 'location': {
      // Compound value keyed by each level's role key. Resolve every populated
      // level to its display name. Single → join deepest-first ("النرجس، الرياض،
      // منطقة الرياض"); multi (client prefs) → chips of the deepest populated level.
      const levels = field.location_levels ?? [];
      const compound =
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      const idsOf = (key: string): string[] => {
        const v = compound[key];
        if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
        return typeof v === 'string' && v ? [v] : [];
      };
      const nameFor = (level: { model_id: string; display_field: string }, id: string): string => {
        const recs = allRecords[level.model_id] ?? [];
        const rec = recs.find((r) => r.id === id);
        if (!rec) return isAr ? 'محذوف' : 'Deleted';
        const m = models.find((mm) => mm.id === level.model_id);
        const dv = resolveLookupDisplayValue(rec, level.display_field, { targetModel: m, allModels: models, allRecords });
        return dv !== null && dv !== undefined && typeof dv !== 'object' ? String(dv) : id.slice(0, 8);
      };
      if (field.location_multi) {
        let deepest: LocationLevel | null = null;
        for (const lv of levels) if (idsOf(lv.key).length) deepest = lv;
        if (!deepest) return <span className="text-charcoal/20">—</span>;
        const deepestLevel = deepest;
        const ids = idsOf(deepestLevel.key);
        return (
          <div className="flex flex-wrap gap-1">
            {ids.map((id) => (
              <Badge key={id} label={nameFor(deepestLevel, id)} />
            ))}
          </div>
        );
      }
      const parts: string[] = [];
      for (let i = levels.length - 1; i >= 0; i--) {
        const lv = levels[i];
        if (!lv) continue;
        const id = idsOf(lv.key)[0];
        if (id) parts.push(nameFor(lv, id));
      }
      if (parts.length === 0) return <span className="text-charcoal/30">—</span>;
      return <span className="text-copper font-bold">{parts.join(isAr ? '، ' : ', ')}</span>;
    }

    case 'unit_picker': {
      // Stored value is unit id(s); display each as its unit_code chip,
      // resolved against the units model (configurable, defaults to `units`).
      const unitModelId = field.unit_picker_unit_model_id ?? models.find((m) => m.name === 'units')?.id ?? null;
      if (!unitModelId) return <span className="text-charcoal/20">—</span>;
      const unitRecords = allRecords[unitModelId] ?? [];
      const ids = Array.isArray(value)
        ? (value as unknown[]).filter((v): v is string => typeof v === 'string')
        : typeof value === 'string' && value
          ? [value]
          : [];
      if (ids.length === 0) return <span className="text-charcoal/20">—</span>;
      const labelFor = (id: string): string => {
        const r = unitRecords.find((x) => x.id === id);
        if (!r) return isAr ? 'محذوف' : 'Deleted';
        const v = r.data['unit_code'] ?? r.data['unit_number'];
        return v !== undefined && v !== null && v !== '' ? String(v) : id.slice(0, 8);
      };
      return (
        <div className="flex flex-wrap gap-1">
          {ids.map((id) => (
            <Badge key={id} label={labelFor(id)} />
          ))}
        </div>
      );
    }

    case 'assignee': {
      const { users } = useAppStore.getState();
      const assignedUser = users.find((u) => u.id === value);
      if (!assignedUser) return <span className="text-charcoal/30 italic text-xs">{isAr ? 'غير معيّن' : 'Unassigned'}</span>;
      return (
        <span className="flex items-center gap-1.5 text-copper font-bold">
          <span className="w-5 h-5 rounded-full bg-copper/10 flex items-center justify-center text-[10px]">
            {(isAr ? assignedUser.name_ar : assignedUser.name_en).charAt(0)}
          </span>
          {isAr ? assignedUser.name_ar : assignedUser.name_en}
        </span>
      );
    }

    default:
      return <span>{String(value)}</span>;
  }
}
