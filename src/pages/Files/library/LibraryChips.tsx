/**
 * Phase 3 · B5 — the active-filter chips.
 *
 * Spec §6: "Chips are removable and the active set is URL-encoded." The chips
 * are the only place the complete active filter set is visible at once — the
 * dropdowns each show their own slice, and "more filters" can be collapsed
 * over an active filter. Without this row a user can be looking at 40 files
 * out of 6,000 with no visible reason why.
 *
 * Every chip removes exactly ONE value, not the whole filter, because that is
 * what a user means by clicking the × on "Floor plan" when they also selected
 * "Brochure".
 */
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { recordTitle } from '@/lib/documents/links';
import type { FileDocumentTypeRow, LibraryFilters } from '@/types';
import {
  confidentialityLabel, documentTypeLabel, modelLabel, originLabel, ownerLabel, shortDate, statusLabel,
} from './labels';

interface Props {
  filters: LibraryFilters;
  onFilters: (next: LibraryFilters) => void;
  types: FileDocumentTypeRow[];
  /** Free text is part of what narrowed the result, so it gets a chip too —
   *  and clearing it from here clears the box. */
  q: string;
  onClearQuery: () => void;
}

interface Chip { key: string; label: string; value: string; onRemove: () => void }

export default function LibraryChips({ filters, onFilters, types, q, onClearQuery }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const users = useAppStore((s) => s.users);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const chips: Chip[] = [];

  const dropFrom = (key: keyof LibraryFilters, value: string) => () => {
    const rest = ((filters[key] as string[] | undefined) ?? []).filter((v) => v !== value);
    const out = { ...filters };
    if (rest.length) (out as Record<string, unknown>)[key] = rest;
    else delete out[key];
    onFilters(out);
  };
  const dropKey = (key: keyof LibraryFilters) => () => {
    const out = { ...filters };
    delete out[key];
    onFilters(out);
  };

  if (q.trim()) {
    chips.push({ key: `q:${q}`, label: t('files.library.chip.text'), value: q.trim(), onRemove: onClearQuery });
  }
  for (const v of filters.document_type ?? []) {
    chips.push({ key: `dt:${v}`, label: t('files.library.filter.document_type'), value: documentTypeLabel(v, types, isAr), onRemove: dropFrom('document_type', v) });
  }
  for (const v of filters.status ?? []) {
    chips.push({ key: `st:${v}`, label: t('files.library.filter.status'), value: statusLabel(v, t), onRemove: dropFrom('status', v) });
  }
  for (const v of filters.kind ?? []) {
    chips.push({ key: `kd:${v}`, label: t('files.library.filter.kind'), value: t(`files.library.kind.${v}`, { defaultValue: v }), onRemove: dropFrom('kind', v) });
  }
  for (const v of filters.origin ?? []) {
    chips.push({ key: `og:${v}`, label: t('files.library.filter.origin'), value: originLabel(v, t), onRemove: dropFrom('origin', v) });
  }
  for (const v of filters.confidentiality ?? []) {
    chips.push({ key: `cf:${v}`, label: t('files.library.filter.confidentiality'), value: confidentialityLabel(v, t), onRemove: dropFrom('confidentiality', v) });
  }
  for (const v of filters.role ?? []) {
    chips.push({ key: `rl:${v}`, label: t('files.library.filter.role'), value: documentTypeLabel(v, types, isAr), onRemove: dropFrom('role', v) });
  }
  for (const v of filters.tags ?? []) {
    chips.push({ key: `tg:${v}`, label: t('files.library.filter.tag'), value: v, onRemove: dropFrom('tags', v) });
  }
  for (const v of filters.owner_user_id ?? []) {
    chips.push({ key: `ow:${v}`, label: t('files.library.filter.owner'), value: ownerLabel(v, users, isAr), onRemove: dropFrom('owner_user_id', v) });
  }
  if (filters.linked_model) {
    chips.push({ key: 'lm', label: t('files.library.filter.linked_model'), value: modelLabel(filters.linked_model, models, isAr), onRemove: dropKey('linked_model') });
  }
  if (filters.record_id) {
    chips.push({
      key: 'rec',
      label: t('files.library.filter.record'),
      // Resolved from the store when it holds the record. When it does not —
      // a shared link into a record this caller cannot see — the id prefix is
      // a poor label but an honest one: it IS what is filtering, and the chip
      // still removes it, which is the point.
      value: (() => {
        // `records` is keyed by model id; the filter always carries the pair,
        // because a record id alone is not an identity (ids are unique only
        // PER MODEL — the same rule file_links enforces).
        const bucket = filters.model_id ? records[filters.model_id] ?? [] : [];
        const rec = bucket.find((r) => r.id === filters.record_id);
        return rec
          ? recordTitle(models.find((m) => m.id === rec.model_id), rec, isAr)
          : filters.record_id!.slice(0, 8);
      })(),
      onRemove: () => {
        const out = { ...filters };
        delete out.record_id;
        delete out.model_id;
        onFilters(out);
      },
    });
  }
  if (filters.created_from) {
    chips.push({ key: 'cf1', label: t('files.library.filter.created_from'), value: shortDate(filters.created_from, isAr), onRemove: dropKey('created_from') });
  }
  if (filters.created_to) {
    chips.push({ key: 'cf2', label: t('files.library.filter.created_to'), value: shortDate(filters.created_to, isAr), onRemove: dropKey('created_to') });
  }
  for (const flag of ['unlinked', 'expired', 'duplicate', 'include_archived'] as const) {
    if (filters[flag]) {
      chips.push({
        key: flag,
        label: t('files.library.chip.flag'),
        value: flag === 'include_archived' ? t('files.library.include_archived') : t(`files.library.health.${flag}`),
        onRemove: dropKey(flag),
      });
    }
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-1.5 ps-2.5 pe-1 py-1 rounded-lg bg-white border border-sand/40 text-xs"
        >
          <span className="text-charcoal/45">{c.label}</span>
          <span className="font-bold text-charcoal max-w-[14rem] truncate" dir="auto">{c.value}</span>
          <button
            type="button"
            onClick={c.onRemove}
            aria-label={t('files.library.chip.remove', { name: c.value })}
            className="p-0.5 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-cream"
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={() => { onFilters({}); onClearQuery(); }}
          className="px-2.5 py-1 rounded-lg text-xs font-bold text-copper hover:bg-copper/10"
        >
          {t('files.library.clear_all')}
        </button>
      )}
    </div>
  );
}
