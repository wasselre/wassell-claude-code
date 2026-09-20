import { useState, useRef, useEffect, useMemo } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { useApplyViewScope } from '@/hooks/usePermission';
import { resolveLookupLabel } from '@/lib/mirrorResolver';
import { resolveFieldDisplay, useFieldDisplayVersion } from '@/lib/recordTranslation/resolver';
import { Search, X, Plus } from 'lucide-react';

interface LookupComboboxProps {
  lookupModelId: string;
  lookupDisplayField: string;
  isMulti?: boolean;
  maxRecords?: number;
  value: string | string[] | undefined;
  onChange: (value: string | string[] | undefined) => void;
  // Cascade support (used by LocationCascadeField). Optional + backward-compatible.
  candidatePredicate?: (rec: { id: string; data: Record<string, unknown> }) => boolean; // pre-filter the dropdown candidates (e.g. children of the chosen parent)
  disabled?: boolean; // render an inert, greyed-out control (e.g. a child level before its parent is chosen)
  disableCreate?: boolean; // suppress the inline "Create:" row (you can't invent a geography record here)
  placeholder?: string; // override the default "Search <model>..." placeholder
}

export default function LookupCombobox({
  lookupModelId,
  lookupDisplayField,
  isMulti,
  maxRecords,
  value,
  onChange,
  candidatePredicate,
  disabled,
  disableCreate,
  placeholder,
}: LookupComboboxProps) {
  const { models, records, language, saveRecord } = useAppStore();
  const isAr = language === 'ar';
  // Re-render when async translations arrive (picker labels resolve).
  useFieldDisplayVersion();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const linkedModel = models.find((m) => m.id === lookupModelId);
  // Pickers respect the user's view scope on the target model — admins see
  // every record, but a Sales rep with a "records I created" view scope on
  // Clients only sees their clients in the picker. Records selected before
  // the scope tightened still display correctly because the resolution by
  // id below reads from the unfiltered store; the dropdown list is what's
  // gated.
  const allLinkedRecords = records[lookupModelId] ?? [];
  const linkedRecords = useApplyViewScope(linkedModel, allLinkedRecords);

  // The display field may be COMPUTED, not stored: either a `mirror` field on the
  // target model, or a `section_mirror` child stored as a compound `${containerId}::
  // ${childSlug}` id. Inline-create writes the typed value to the display field, which
  // is impossible for a computed field — so creation is disabled below in that case.
  const displayIsComputed =
    lookupDisplayField.includes('::') ||
    linkedModel?.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.name === lookupDisplayField)?.type === 'mirror';

  // Resolve a record's display label: the configured display field, else the
  // first human scalar in schema order, else one hop through a lookup to the
  // record it points at (so a POINTER row like our_projects — which stores only
  // a link to its master — still reads as the master's name). Empty string means
  // the record genuinely has no label; the render sites below say so in words
  // rather than printing its uuid.
  const labelFor = useMemo(
    () =>
      (rec: { id: string; data: Record<string, unknown> }): string =>
        resolveLookupLabel(rec, lookupDisplayField, {
          targetModel: linkedModel,
          allModels: models,
          allRecords: records,
        }) ?? '',
    [linkedModel, lookupDisplayField, models, records],
  );

  // Display variant of labelFor — overlay-translates the (usually Arabic) name
  // for the current UI language. Search matches BOTH the source label and the
  // translated label so typing either "مساكن" or "Masaken" finds the record.
  const displayFor = (rec: { id: string; data: Record<string, unknown> }): string =>
    resolveFieldDisplay(rec.id, lookupDisplayField, labelFor(rec), isAr ? 'ar' : 'en', { kind: 'name' });

  // Render a label, or SAY that the record has none. The id fragment is a
  // disambiguator between two unnamed rows — never a stand-in for a name.
  const renderLabel = (rec: { id: string; data: Record<string, unknown> }) => {
    const text = displayFor(rec);
    if (text.trim() !== '') return text;
    return (
      <span className="italic text-charcoal/40">
        {isAr ? 'سجل بلا اسم' : 'Unnamed record'} · {rec.id.slice(0, 8)}
      </span>
    );
  };

  // Normalize value: in multi mode always string[]; in single mode a string or undefined.
  const selectedIds = useMemo<string[]>(() => {
    if (isMulti) return Array.isArray(value) ? (value as string[]) : [];
    return typeof value === 'string' && value ? [value] : [];
  }, [value, isMulti]);

  // Resolve the currently-selected record from the UNFILTERED list so a
  // previously-saved selection still displays after view-scope tightens.
  // Only the dropdown's candidate list is scoped — once an id is picked,
  // it stays bound until the user changes it.
  // A selected record renders as selected even when its label is unresolvable —
  // gating the chip on a non-empty label used to hide a real selection behind an
  // empty-looking search box whose dropdown never opened.
  const singleSelectedRecord = !isMulti ? allLinkedRecords.find((r) => r.id === selectedIds[0]) : undefined;

  const limit = maxRecords && maxRecords > 0 ? maxRecords : 20;
  const filteredRecords = useMemo(() => {
    let base = linkedRecords.filter((r) => !selectedIds.includes(r.id));
    if (candidatePredicate) base = base.filter(candidatePredicate);
    if (!query.trim()) return base.slice(0, limit);
    const q = query.toLowerCase();
    return base
      .filter((r) => labelFor(r).toLowerCase().includes(q) || displayFor(r).toLowerCase().includes(q))
      .slice(0, limit);
    // displayFor reads the module-level translation cache; the version hook
    // above re-renders (and thus re-runs this memo's deps change via labelFor
    // identity) when new translations arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, linkedRecords, selectedIds, limit, labelFor, candidatePredicate]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const pickRecord = (recId: string) => {
    if (isMulti) {
      const next = [...selectedIds, recId];
      onChange(next);
      setQuery('');
      // keep open so the user can add more
    } else {
      onChange(recId);
      setQuery('');
      setOpen(false);
    }
  };

  const removeRecord = (recId: string) => {
    if (isMulti) {
      const next = selectedIds.filter((id) => id !== recId);
      onChange(next.length > 0 ? next : []);
    } else {
      onChange(undefined);
    }
  };

  // Inline-create: if the user types a value that doesn't match an existing
  // record, they can create a new record in the target model with the typed
  // value written to the configured display field, then auto-select it.
  const trimmedQuery = query.trim();
  const canCreate =
    !disableCreate &&
    trimmedQuery.length > 0 &&
    !!lookupDisplayField &&
    !displayIsComputed &&
    !filteredRecords.some(
      (r) =>
        labelFor(r).toLowerCase() === trimmedQuery.toLowerCase() ||
        displayFor(r).toLowerCase() === trimmedQuery.toLowerCase(),
    );

  const createAndPick = () => {
    if (!canCreate || !linkedModel) return;
    const now = new Date().toISOString();
    const newRec = {
      id: uuid(),
      model_id: lookupModelId,
      data: { [lookupDisplayField]: trimmedQuery },
      created_at: now,
      updated_at: now,
    };
    saveRecord(newRec);
    pickRecord(newRec.id);
  };

  if (!linkedModel) {
    return <div className="text-sm text-red-400">{isAr ? 'نموذج غير موجود' : 'Linked model not found'}</div>;
  }

  // ── Disabled (cascade child whose parent isn't chosen yet) ──
  if (disabled) {
    return (
      <div className="form-input flex items-center text-sm text-charcoal/30 bg-cream/40 cursor-not-allowed select-none">
        {placeholder ?? (isAr ? `بحث في ${linkedModel.label_ar}...` : `Search ${linkedModel.label_en}...`)}
      </div>
    );
  }

  const searchPlaceholder = placeholder ?? (isAr ? `بحث في ${linkedModel.label_ar}...` : `Search ${linkedModel.label_en}...`);

  // ── Multi-select mode ──
  if (isMulti) {
    // Resolve from the unfiltered list so existing selections survive a
    // view-scope tightening (same rationale as singleSelectedRecord above).
    const selectedRecords = selectedIds
      .map((id) => allLinkedRecords.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => !!r);
    return (
      <div ref={ref} className="relative">
        {selectedRecords.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {selectedRecords.map((rec) => {
              return (
                <span
                  key={rec.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-copper/10 text-copper"
                >
                  {renderLabel(rec)}
                  <button type="button" onClick={() => removeRecord(rec.id)} className="hover:opacity-70">
                    <X size={12} />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <div className="relative">
          <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/30" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={searchPlaceholder}
            className="form-input ps-8 text-sm"
          />
        </div>
        {open && (
          <div className="absolute z-20 mt-1 w-full bg-white rounded-lg border border-sand shadow-lg max-h-48 overflow-y-auto animate-[fadeIn_0.1s_ease]">
            {filteredRecords.length === 0 && !canCreate && (
              <div className="px-3 py-3 text-sm text-charcoal/30 text-center">
                {isAr ? 'لا توجد نتائج' : 'No results'}
              </div>
            )}
            {filteredRecords.map((rec) => (
              <button
                key={rec.id}
                type="button"
                onClick={() => pickRecord(rec.id)}
                className="w-full px-3 py-2 text-start hover:bg-cream transition-colors text-sm"
              >
                {renderLabel(rec)}
              </button>
            ))}
            {canCreate && (
              <button
                type="button"
                onClick={createAndPick}
                className={`w-full px-3 py-2 text-start hover:bg-cream transition-colors text-sm flex items-center gap-2 text-copper font-bold ${filteredRecords.length > 0 ? 'border-t border-sand/50' : ''}`}
              >
                <Plus size={14} />
                {isAr ? `إنشاء: "${trimmedQuery}"` : `Create: "${trimmedQuery}"`}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Single-select mode (original behavior) ──
  return (
    <div ref={ref} className="relative">
      {singleSelectedRecord ? (
        <div className="form-input flex items-center justify-between">
          <span className="text-copper font-bold">{renderLabel(singleSelectedRecord)}</span>
          <button type="button" onClick={() => onChange(undefined)} className="text-charcoal/30 hover:text-red-500">
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/30" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={searchPlaceholder}
            className="form-input ps-8 text-sm"
          />
        </div>
      )}

      {open && selectedIds.length === 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white rounded-lg border border-sand shadow-lg max-h-48 overflow-y-auto animate-[fadeIn_0.1s_ease]">
          {filteredRecords.length === 0 && !canCreate && (
            <div className="px-3 py-3 text-sm text-charcoal/30 text-center">
              {isAr ? 'لا توجد نتائج' : 'No results'}
            </div>
          )}
          {filteredRecords.map((rec) => (
            <button
              key={rec.id}
              type="button"
              onClick={() => pickRecord(rec.id)}
              className="w-full px-3 py-2 text-start hover:bg-cream transition-colors text-sm"
            >
              {renderLabel(rec)}
            </button>
          ))}
          {canCreate && (
            <button
              type="button"
              onClick={createAndPick}
              className={`w-full px-3 py-2 text-start hover:bg-cream transition-colors text-sm flex items-center gap-2 text-copper font-bold ${filteredRecords.length > 0 ? 'border-t border-sand/50' : ''}`}
            >
              <Plus size={14} />
              {isAr ? `إنشاء: "${trimmedQuery}"` : `Create: "${trimmedQuery}"`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
