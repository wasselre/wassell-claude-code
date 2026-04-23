import { useState, useRef, useEffect, useMemo } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Search, X, Plus } from 'lucide-react';

interface LookupComboboxProps {
  lookupModelId: string;
  lookupDisplayField: string;
  isMulti?: boolean;
  maxRecords?: number;
  value: string | string[] | undefined;
  onChange: (value: string | string[] | undefined) => void;
}

export default function LookupCombobox({
  lookupModelId,
  lookupDisplayField,
  isMulti,
  maxRecords,
  value,
  onChange,
}: LookupComboboxProps) {
  const { models, records, language, saveRecord } = useAppStore();
  const isAr = language === 'ar';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const linkedModel = models.find((m) => m.id === lookupModelId);
  const linkedRecords = records[lookupModelId] ?? [];

  // Resolve a record's display label. Primary source is the configured display
  // field; if that's empty (record was created before the field existed, or the
  // user just hasn't filled it in), fall back to the first non-empty scalar on
  // the record in schema order, and finally to an id suffix.
  const labelFor = useMemo(() => {
    const orderedSlugs = linkedModel
      ? linkedModel.schema.sections.flatMap((s) => s.fields.map((f) => f.name))
      : [];
    return (rec: { id: string; data: Record<string, unknown> }): string => {
      const primary = rec.data[lookupDisplayField];
      if (primary !== null && primary !== undefined && String(primary).trim() !== '') {
        return String(primary);
      }
      for (const slug of orderedSlugs) {
        if (slug === lookupDisplayField) continue;
        const v = rec.data[slug];
        if (typeof v === 'string' && v.trim() !== '') return v;
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      }
      return rec.id.slice(0, 8);
    };
  }, [linkedModel, lookupDisplayField]);

  // Normalize value: in multi mode always string[]; in single mode a string or undefined.
  const selectedIds = useMemo<string[]>(() => {
    if (isMulti) return Array.isArray(value) ? (value as string[]) : [];
    return typeof value === 'string' && value ? [value] : [];
  }, [value, isMulti]);

  const singleSelectedRecord = !isMulti ? linkedRecords.find((r) => r.id === selectedIds[0]) : undefined;
  const singleDisplayValue = singleSelectedRecord ? labelFor(singleSelectedRecord) : '';

  const limit = maxRecords && maxRecords > 0 ? maxRecords : 20;
  const filteredRecords = useMemo(() => {
    const base = linkedRecords.filter((r) => !selectedIds.includes(r.id));
    if (!query.trim()) return base.slice(0, limit);
    const q = query.toLowerCase();
    return base
      .filter((r) => labelFor(r).toLowerCase().includes(q))
      .slice(0, limit);
  }, [query, linkedRecords, selectedIds, limit, labelFor]);

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
    trimmedQuery.length > 0 &&
    !!lookupDisplayField &&
    !filteredRecords.some((r) => labelFor(r).toLowerCase() === trimmedQuery.toLowerCase());

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

  // ── Multi-select mode ──
  if (isMulti) {
    const selectedRecords = selectedIds
      .map((id) => linkedRecords.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => !!r);
    return (
      <div ref={ref} className="relative">
        {selectedRecords.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {selectedRecords.map((rec) => {
              const label = labelFor(rec);
              return (
                <span
                  key={rec.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-copper/10 text-copper"
                >
                  {label}
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
            placeholder={isAr ? `بحث في ${linkedModel.label_ar}...` : `Search ${linkedModel.label_en}...`}
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
                {labelFor(rec)}
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
      {selectedIds.length > 0 && singleDisplayValue ? (
        <div className="form-input flex items-center justify-between">
          <span className="text-copper font-bold">{singleDisplayValue}</span>
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
            placeholder={isAr ? `بحث في ${linkedModel.label_ar}...` : `Search ${linkedModel.label_en}...`}
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
              {labelFor(rec)}
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
