import { useState } from 'react';
import { Phone, Copy, StickyNote, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Badge from '@/components/ui/Badge';
import WhatsAppIcon from '@/components/ui/WhatsAppIcon';
import ImagePreview from '@/components/ui/ImagePreview';
import { telUrl, whatsappUrl } from '@/lib/phone';
import { resolveMirror } from '@/lib/mirrorResolver';
import { formatRangeValue } from './RangeField';
import { formatFormulaValue, isFormulaErrorValue } from '@/lib/formulaEngine';
import type { ModelField, AppRecord, NoteEntry } from '@/types';

interface DynamicCellProps {
  field: ModelField;
  value: unknown;
  allRecords: Record<string, AppRecord[]>;
  recordData?: Record<string, unknown>;
}

export default function DynamicCell({ field, value, allRecords, recordData }: DynamicCellProps) {
  const { t } = useTranslation();
  const { language, addToast, models } = useAppStore();
  const isAr = language === 'ar';
  // One preview state per cell. Cheap — most cells never open it.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

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
          {latest.text.replace(/\s+/g, ' ').slice(0, 60)}
        </span>
      </span>
    );
  }

  if (value === undefined || value === null || value === '') {
    return <span className="text-charcoal/20">—</span>;
  }

  switch (field.type) {
    case 'text':
    case 'email':
    case 'number':
      return <span>{String(value)}</span>;

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

    case 'auto_id':
      return <span className="font-mono font-bold text-copper" dir="ltr">{String(value)}</span>;

    case 'image': {
      const url = String(value);
      if (!/^https?:\/\//i.test(url)) {
        return <span className="text-charcoal/30 italic text-xs">{isAr ? 'رابط غير صالح' : 'Invalid URL'}</span>;
      }
      return (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPreviewUrl(url);
            }}
            className="block cursor-zoom-in"
            aria-label={isAr ? 'فتح الصورة' : 'Open image'}
          >
            <img
              src={url}
              alt=""
              className="block w-10 h-10 rounded object-cover border border-sand/30 bg-cream/40 hover:opacity-80 transition-opacity"
              loading="lazy"
            />
          </button>
          {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
        </>
      );
    }

    case 'multi_image': {
      // Compact table-cell view: first thumbnail + a "+N" badge if there
      // are more. Click any thumbnail to preview at full size.
      const urls = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v))
        : [];
      if (urls.length === 0) {
        return <span className="text-charcoal/30 italic text-xs">—</span>;
      }
      const first = urls[0]!;
      const extra = urls.length - 1;
      return (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPreviewUrl(first);
            }}
            className="relative inline-block cursor-zoom-in"
            aria-label={isAr ? 'فتح الصور' : 'Open images'}
          >
            <img
              src={first}
              alt=""
              className="block w-10 h-10 rounded object-cover border border-sand/30 bg-cream/40 hover:opacity-80 transition-opacity"
              loading="lazy"
            />
            {extra > 0 && (
              <span className="absolute -top-1 -end-1 text-[10px] font-bold bg-copper text-white rounded-full px-1.5 py-0.5">
                +{extra}
              </span>
            )}
          </button>
          {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
        </>
      );
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
            <a
              href={wa}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              aria-label={isAr ? 'واتساب' : 'WhatsApp'}
              title={isAr ? 'واتساب' : 'WhatsApp'}
              className="text-copper hover:text-terracotta transition-colors"
            >
              <WhatsAppIcon size={14} />
            </a>
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
      return <span className="truncate max-w-xs block">{String(value)}</span>;

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

      const renderOne = (id: string) => {
        const linkedRecord = linkedRecords.find((r) => r.id === id);
        if (!linkedRecord) {
          return <span key={id} className="text-charcoal/30 italic text-xs">{isAr ? 'سجل محذوف' : 'Deleted record'}</span>;
        }
        const displayVal = linkedRecord.data[displayFieldName];
        const text = displayVal !== null && displayVal !== undefined && typeof displayVal !== 'object'
          ? String(displayVal)
          : (displayVal ? String(displayVal) : id.slice(0, 8));
        return <span key={id} className="text-copper font-bold">{text}</span>;
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
                const dv = linkedRecord.data[displayFieldName];
                return dv !== null && dv !== undefined && typeof dv !== 'object' ? String(dv) : id.slice(0, 8);
              })()} />
            ))}
          </div>
        );
      }

      // Single-select
      if (typeof value !== 'string' || !value) return <span className="text-charcoal/30">—</span>;
      return renderOne(value);
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
