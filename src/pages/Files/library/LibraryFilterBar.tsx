/**
 * Phase 3 · B5 — the filter bar.
 *
 * Every option here is drawn from the FACETS the search already returned, which
 * is why the bar costs nothing extra: `business_files_search` computes facet
 * counts over the WHOLE filtered set (not the page) in the same round trip as
 * the rows. Two consequences worth understanding before changing anything:
 *
 *   - An option with no matching files is not rendered. A filter that can only
 *     produce an empty screen is not a filter, it is a trap.
 *   - The counts are the CALLER's. Two people open the same view and see
 *     different numbers, because the RPC is SECURITY INVOKER and RLS is the
 *     only authority on reach. That is correct.
 *
 * The free-text box is deliberately NOT wired to the query directly — the page
 * owns a debounce. `business_files_search` measures 350–1,100 ms on production;
 * a call per keystroke would put six of them in flight for the word "brochure".
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type {
  BusinessFileFacets,
  BusinessFileSort,
  FileDocumentTypeRow,
  FileVocabDimension,
  FileVocabRow,
  LibraryFilters,
  LibraryGrouping,
  LibraryLayout,
} from '@/types';
import { LIBRARY_GROUPINGS, LIBRARY_SORTS } from '@/lib/files/libraryUrl';
import {
  confidentialityLabel, documentTypeLabel, modelLabel, originLabel, ownerLabel, statusLabel,
} from './labels';
import RecordFilterPicker from './RecordFilterPicker';

interface Props {
  /** The live text in the box — the page debounces it before searching. */
  searchInput: string;
  onSearchInput: (v: string) => void;
  filters: LibraryFilters;
  onFilters: (next: LibraryFilters) => void;
  facets: BusinessFileFacets | null;
  types: FileDocumentTypeRow[];
  /** Data-driven picklists for the metadata axes (asset_nature, …). */
  vocab: FileVocabRow[];
  sort: BusinessFileSort;
  onSort: (s: BusinessFileSort) => void;
  grouping: LibraryGrouping;
  onGrouping: (g: LibraryGrouping) => void;
  layout: LibraryLayout;
  onLayout: (l: LibraryLayout) => void;
}

/** One multi-select dropdown over a facet bucket. */
function FacetMenu({
  label,
  bucket,
  selected,
  onToggle,
  renderOption,
}: {
  label: string;
  bucket: Record<string, number>;
  selected: string[];
  onToggle: (value: string) => void;
  renderOption: (value: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A facet with a single bucket cannot narrow anything — every file already
  // matches it — so it is not offered. This is what keeps the bar honest as
  // the corpus changes rather than showing ten dead dropdowns.
  const entries = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
          selected.length
            ? 'bg-copper/10 border-copper/30 text-copper'
            : 'bg-white border-sand/40 text-charcoal/70 hover:bg-cream'
        }`}
      >
        {label}
        {selected.length > 0 && <span className="tabular-nums">({selected.length})</span>}
        <ChevronDown size={13} aria-hidden />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 min-w-[15rem] max-h-72 overflow-auto rounded-xl bg-white border border-sand/40 shadow-lg p-1 start-0">
          {entries.map(([value, count]) => {
            const on = selected.includes(value);
            return (
              <button
                key={value}
                type="button"
                onClick={() => onToggle(value)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-charcoal hover:bg-cream text-start"
              >
                <span
                  className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                    on ? 'bg-copper border-copper' : 'border-sand/60'
                  }`}
                >
                  {on && <Check size={10} className="text-white" aria-hidden />}
                </span>
                <span className="flex-1 truncate" dir="auto">{renderOption(value)}</span>
                <span className="text-charcoal/40 tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A multi-select dropdown sourced from a fixed OPTION list (value + label)
 *  rather than from facet counts. Used for the primary "Document Type", whose
 *  facet counts are deliberately not computed (the statement-timeout lesson), so
 *  its options come from the vocabulary and are always offered. */
function OptionMenu({
  label, options, selected, onToggle,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (options.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
          selected.length ? 'bg-copper/10 border-copper/30 text-copper' : 'bg-white border-sand/40 text-charcoal/70 hover:bg-cream'
        }`}
      >
        {label}
        {selected.length > 0 && <span className="tabular-nums">({selected.length})</span>}
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 min-w-[15rem] max-h-72 overflow-auto rounded-xl bg-white border border-sand/40 shadow-lg p-1 start-0">
          {options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button key={o.value} type="button" onClick={() => onToggle(o.value)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-charcoal hover:bg-cream text-start">
                <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${on ? 'bg-copper border-copper' : 'border-sand/60'}`}>
                  {on && <Check size={10} className="text-white" aria-hidden />}
                </span>
                <span className="flex-1 truncate" dir="auto">{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function LibraryFilterBar({
  searchInput, onSearchInput, filters, onFilters, facets, types, vocab,
  sort, onSort, grouping, onGrouping, layout, onLayout,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const users = useAppStore((s) => s.users);
  const models = useAppStore((s) => s.models);
  const [showMore, setShowMore] = useState(false);

  /** value → bilingual label for a metadata axis, from the vocab; falls back to
   *  the raw value so a since-deactivated term still reads. */
  const vocabLabel = (dim: FileVocabDimension, v: string) => {
    const row = vocab.find((x) => x.dimension === dim && x.value === v);
    return row ? (isAr ? row.label_ar : row.label_en) : v;
  };

  const toggleIn = (key: keyof LibraryFilters, value: string) => {
    const current = (filters[key] as string[] | undefined) ?? [];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    // An EMPTY array is not "no filter" to the RPC — it is "match nothing".
    // Removing the last value must therefore delete the key entirely.
    const out = { ...filters };
    if (next.length) (out as Record<string, unknown>)[key] = next;
    else delete out[key];
    onFilters(out);
  };

  const toggleFlag = (key: 'unlinked' | 'expired' | 'duplicate' | 'include_archived') => {
    const out = { ...filters };
    if (out[key]) delete out[key];
    else out[key] = true;
    onFilters(out);
  };

  const setScalar = (key: 'linked_model', value: string | null) => {
    const out = { ...filters };
    if (value) out[key] = value;
    else delete out[key];
    onFilters(out);
  };

  const health = facets?.health;

  return (
    <div className="space-y-3">
      {/* Free text + layout/sort/group */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[16rem] max-w-xl">
          <Search
            size={16}
            className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40 pointer-events-none"
            aria-hidden
          />
          <input
            value={searchInput}
            onChange={(e) => onSearchInput(e.target.value)}
            placeholder={t('files.library.search_placeholder')}
            dir="auto"
            className="w-full ps-9 pe-9 py-2.5 rounded-xl bg-white border border-sand/40 text-sm text-charcoal placeholder-charcoal/40 focus:outline-none focus:ring-2 focus:ring-copper/30"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => onSearchInput('')}
              aria-label={t('files.search.clear_aria')}
              className="absolute top-1/2 -translate-y-1/2 end-2 p-1 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-cream"
            >
              <X size={15} aria-hidden />
            </button>
          )}
        </div>

        <label className="sr-only" htmlFor="lib-group">{t('files.library.group_by')}</label>
        <select
          id="lib-group"
          value={grouping}
          onChange={(e) => onGrouping(e.target.value as LibraryGrouping)}
          className="px-3 py-2 rounded-xl bg-white border border-sand/40 text-xs font-bold text-charcoal/70 focus:outline-none focus:ring-2 focus:ring-copper/30"
        >
          {LIBRARY_GROUPINGS.map((g) => (
            <option key={g} value={g}>{t(`files.library.grouping.${g}`)}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="lib-sort">{t('files.library.sort_by')}</label>
        <select
          id="lib-sort"
          value={sort}
          onChange={(e) => onSort(e.target.value as BusinessFileSort)}
          className="px-3 py-2 rounded-xl bg-white border border-sand/40 text-xs font-bold text-charcoal/70 focus:outline-none focus:ring-2 focus:ring-copper/30"
        >
          {LIBRARY_SORTS.map((s) => (
            <option key={s} value={s}>{t(`files.library.sort.${s}`)}</option>
          ))}
        </select>

        <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-cream border border-sand/30">
          {(['grid', 'list'] as LibraryLayout[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => onLayout(l)}
              aria-pressed={layout === l}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                layout === l ? 'bg-white text-copper shadow-sm' : 'text-charcoal/60 hover:text-charcoal'
              }`}
            >
              {t(`files.library.layout.${l}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Facet dropdowns */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Primary "Document Type" — options from the vocabulary (no facet count). */}
        <OptionMenu
          label={t('files.library.meta.primary_category')}
          options={vocab
            .filter((v) => v.dimension === 'primary_category')
            .map((v) => ({ value: v.value, label: isAr ? v.label_ar : v.label_en }))}
          selected={filters.primary_category ?? []}
          onToggle={(v) => toggleIn('primary_category', v)}
        />
        <FacetMenu
          label={t('files.library.filter.document_type')}
          bucket={facets?.document_type ?? {}}
          selected={filters.document_type ?? []}
          onToggle={(v) => toggleIn('document_type', v)}
          renderOption={(v) => documentTypeLabel(v, types, isAr)}
        />
        <FacetMenu
          label={t('files.library.meta.secondary_types')}
          bucket={facets?.subject ?? {}}
          selected={filters.subject ?? []}
          onToggle={(v) => toggleIn('subject', v)}
          renderOption={(v) => documentTypeLabel(v, types, isAr)}
        />
        <FacetMenu
          label={t('files.library.filter.linked_model')}
          bucket={facets?.linked_model ?? {}}
          selected={filters.linked_model ? [filters.linked_model] : []}
          // `linked_model` is a SCALAR in the RPC contract, not a list, so this
          // menu behaves as single-select: picking a second model replaces the
          // first rather than silently keeping only one of them.
          onToggle={(v) => setScalar('linked_model', filters.linked_model === v ? null : v)}
          renderOption={(v) => modelLabel(v, models, isAr)}
        />
        {/* Narrow to ONE record. Follows the linked-model choice, so picking
            "Units" then searches units — and it only appears once a model is
            chosen, because "pick a record from all 40,000 across every model"
            is not a useful control. */}
        {filters.linked_model && (
          <RecordFilterPicker filters={filters} onFilters={onFilters} modelName={filters.linked_model} />
        )}
        <FacetMenu
          label={t('files.library.filter.owner')}
          bucket={facets?.owner_user_id ?? {}}
          selected={filters.owner_user_id ?? []}
          onToggle={(v) => toggleIn('owner_user_id', v)}
          renderOption={(v) => ownerLabel(v, users, isAr)}
        />
        <FacetMenu
          label={t('files.library.filter.tag')}
          bucket={facets?.tag ?? {}}
          selected={filters.tags ?? []}
          onToggle={(v) => toggleIn('tags', v)}
          renderOption={(v) => v}
        />

        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-sand/40 text-xs font-bold text-charcoal/70 hover:bg-cream"
        >
          <SlidersHorizontal size={13} aria-hidden />
          {t('files.library.more_filters')}
        </button>

        {/* Health toggles. The numbers come from the facets, so a toggle that
            would produce nothing reads as (0) instead of pretending. */}
        <div className="flex items-center gap-2">
          {(['unlinked', 'expired', 'duplicate'] as const).map((flag) => (
            <button
              key={flag}
              type="button"
              onClick={() => toggleFlag(flag)}
              aria-pressed={Boolean(filters[flag])}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
                filters[flag]
                  ? 'bg-copper/10 border-copper/30 text-copper'
                  : 'bg-white border-sand/40 text-charcoal/70 hover:bg-cream'
              }`}
            >
              {t(`files.library.health.${flag}`)}
              {health && <span className="tabular-nums text-charcoal/40">{health[flag]}</span>}
            </button>
          ))}
        </div>
      </div>

      {showMore && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-cream/60 border border-sand/30">
          <FacetMenu
            label={t('files.library.filter.kind')}
            bucket={facets?.kind ?? {}}
            selected={filters.kind ?? []}
            onToggle={(v) => toggleIn('kind', v)}
            renderOption={(v) => t(`files.library.kind.${v}`, { defaultValue: v })}
          />
          <FacetMenu
            label={t('files.library.filter.status')}
            bucket={facets?.status ?? {}}
            selected={filters.status ?? []}
            onToggle={(v) => toggleIn('status', v)}
            renderOption={(v) => statusLabel(v, t)}
          />
          <FacetMenu
            label={t('files.library.filter.origin')}
            bucket={facets?.origin ?? {}}
            selected={filters.origin ?? []}
            onToggle={(v) => toggleIn('origin', v)}
            renderOption={(v) => originLabel(v, t)}
          />
          <FacetMenu
            label={t('files.library.filter.confidentiality')}
            bucket={facets?.confidentiality ?? {}}
            selected={filters.confidentiality ?? []}
            onToggle={(v) => toggleIn('confidentiality', v)}
            renderOption={(v) => confidentialityLabel(v, t)}
          />
          <FacetMenu
            label={t('files.library.filter.role')}
            bucket={facets?.role ?? {}}
            selected={filters.role ?? []}
            onToggle={(v) => toggleIn('role', v)}
            renderOption={(v) => documentTypeLabel(v, types, isAr)}
          />
          {/* Metadata Intelligence axes (Phase B) — same facet mechanism. */}
          <FacetMenu
            label={t('files.library.meta.asset_nature')}
            bucket={facets?.asset_nature ?? {}}
            selected={filters.asset_nature ?? []}
            onToggle={(v) => toggleIn('asset_nature', v)}
            renderOption={(v) => vocabLabel('asset_nature', v)}
          />
          <FacetMenu
            label={t('files.library.meta.acquisition_source')}
            bucket={facets?.acquisition_source ?? {}}
            selected={filters.acquisition_source ?? []}
            onToggle={(v) => toggleIn('acquisition_source', v)}
            renderOption={(v) => vocabLabel('acquisition_source', v)}
          />
          <FacetMenu
            label={t('files.library.meta.usage_rights')}
            bucket={facets?.usage_rights ?? {}}
            selected={filters.usage_rights ?? []}
            onToggle={(v) => toggleIn('usage_rights', v)}
            renderOption={(v) => vocabLabel('usage_rights', v)}
          />
          <FacetMenu
            label={t('files.library.meta.production_state')}
            bucket={facets?.production_state ?? {}}
            selected={filters.production_state ?? []}
            onToggle={(v) => toggleIn('production_state', v)}
            renderOption={(v) => vocabLabel('production_state', v)}
          />
          <button
            type="button"
            onClick={() => toggleFlag('include_archived')}
            aria-pressed={Boolean(filters.include_archived)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
              filters.include_archived
                ? 'bg-copper/10 border-copper/30 text-copper'
                : 'bg-white border-sand/40 text-charcoal/70 hover:bg-cream'
            }`}
          >
            {t('files.library.include_archived')}
          </button>
        </div>
      )}
    </div>
  );
}
