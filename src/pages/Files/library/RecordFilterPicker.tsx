/**
 * Phase 3 · B5 — narrow the Library to ONE record.
 *
 * Spec §6 lists the filter bar as "type, project, client, tag, status, owner,
 * date, plus a free-text box", and the Project-pack view's own hint promises
 * "pick a project to narrow it". `linked_model` alone only gets you as far as
 * "attached to some project"; this is the half that gets you to *that* project.
 *
 * ── WHY IT SEARCHES THE STORE, NOT THE SERVER ─────────────────────────────
 * `business_files_search` takes `model_id` + `record_id` — it does not resolve
 * names, and it has no endpoint for "find me a project called X". The records
 * are already in the Zustand store (the app loads them at boot), so the picker
 * filters them in memory. That is a real constraint worth stating: a record the
 * store has not loaded cannot be picked here, and a record the caller cannot
 * SEE was never in the store to begin with — which is the correct behaviour,
 * just arrived at by the store's RLS rather than by this component's logic.
 *
 * Choosing a record sets BOTH `model_id` and `record_id`. `record_id` alone
 * would be wrong: record ids are only unique PER MODEL, so the pair is the
 * identity — the same rule `file_links` enforces everywhere else.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { recordTitle } from '@/lib/documents/links';
import type { LibraryFilters } from '@/types';

interface Props {
  filters: LibraryFilters;
  onFilters: (next: LibraryFilters) => void;
  /** `models.name` to search within — the linked-model filter picks this, and
   *  it defaults to projects because that is the case the spec names. */
  modelName?: string;
}

/** How many matches to render. A model can hold 40,000 records; a dropdown
 *  that tries to show them all is not a picker, it is a hang. */
const MAX_RESULTS = 30;

export default function RecordFilterPicker({ filters, onFilters, modelName = 'all_projects' }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
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

  const model = useMemo(() => models.find((m) => m.name === modelName), [models, modelName]);

  const matches = useMemo(() => {
    if (!model) return [];
    const needle = term.trim().toLowerCase();
    const out: Array<{ id: string; title: string }> = [];
    // `records` is keyed BY MODEL, so this reads one bucket rather than
    // scanning every record in the workspace.
    for (const r of records[model.id] ?? []) {
      const title = recordTitle(model, r, isAr);
      if (needle && !title.toLowerCase().includes(needle)) continue;
      out.push({ id: r.id, title });
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  }, [records, model, term, isAr]);

  // Resolve the CURRENT selection for the button label. A record the store does
  // not hold (a shared link into a record this caller cannot see) shows its id
  // prefix rather than blank — the filter is still active and still removable,
  // and pretending otherwise would be the worse failure.
  const selectedTitle = useMemo(() => {
    if (!filters.record_id) return null;
    // The model is known from the filter pair, so this is a single-bucket
    // lookup rather than a sweep over every model's records.
    const bucket = filters.model_id ? records[filters.model_id] ?? [] : [];
    const rec = bucket.find((r) => r.id === filters.record_id);
    if (!rec) return filters.record_id.slice(0, 8);
    return recordTitle(models.find((m) => m.id === rec.model_id), rec, isAr);
  }, [filters.record_id, filters.model_id, records, models, isAr]);

  // A model the workspace does not have cannot be searched, so the control is
  // not offered at all rather than rendering an empty dropdown.
  if (!model) return null;

  const pick = (recordId: string) => {
    onFilters({ ...filters, model_id: model.id, record_id: recordId });
    setOpen(false);
    setTerm('');
  };

  const clear = () => {
    const next = { ...filters };
    delete next.record_id;
    delete next.model_id;
    onFilters(next);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-bold transition-colors max-w-[16rem] ${
          selectedTitle
            ? 'bg-copper/10 border-copper/30 text-copper'
            : 'bg-white border-sand/40 text-charcoal/70 hover:bg-cream'
        }`}
      >
        <span className="truncate" dir="auto">
          {selectedTitle ?? t('files.library.filter.pick_record', {
            model: (isAr ? model.label_ar : model.label_en) || model.name,
          })}
        </span>
        {selectedTitle ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={t('files.library.chip.remove', { name: selectedTitle })}
            onClick={(e) => { e.stopPropagation(); clear(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); clear(); } }}
            className="p-0.5 rounded hover:bg-copper/20 cursor-pointer"
          >
            <X size={12} aria-hidden />
          </span>
        ) : (
          <ChevronDown size={13} aria-hidden />
        )}
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-[20rem] rounded-xl bg-white border border-sand/40 shadow-lg p-2 start-0">
          <div className="relative mb-1.5">
            <Search size={13} className="absolute top-1/2 -translate-y-1/2 start-2.5 text-charcoal/35 pointer-events-none" aria-hidden />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              autoFocus
              dir="auto"
              placeholder={t('files.library.filter.record_search')}
              className="w-full ps-8 pe-2 py-1.5 rounded-lg bg-cream/60 border border-sand/30 text-xs text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30"
            />
          </div>
          <div className="max-h-64 overflow-auto">
            {matches.length === 0 ? (
              <p className="px-2 py-3 text-xs text-charcoal/40">{t('files.library.filter.record_none')}</p>
            ) : (
              matches.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => pick(m.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-charcoal hover:bg-cream text-start"
                >
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                    filters.record_id === m.id ? 'bg-copper border-copper' : 'border-sand/60'
                  }`}>
                    {filters.record_id === m.id && <Check size={10} className="text-white" aria-hidden />}
                  </span>
                  <span className="flex-1 truncate" dir="auto">{m.title}</span>
                </button>
              ))
            )}
            {matches.length >= MAX_RESULTS && (
              <p className="px-2 pt-1.5 text-[11px] text-charcoal/35">
                {t('files.library.filter.record_more', { count: MAX_RESULTS })}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
