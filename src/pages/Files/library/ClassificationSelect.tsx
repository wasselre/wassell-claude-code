/**
 * A subject/classification MULTISELECT dropdown — one control for "what IS this
 * file", replacing the old single-value type dropdown (+ a chip row). Shared by
 * the Library detail panel and the post-upload modal so both behave identically.
 *
 * The selected set is the file's subjects; callers derive the primary
 * document_type from it. When `onCreate` is provided, the dropdown also lets the
 * user TYPE A NEW classification and save it (e.g. "unit plan") without a
 * settings page — the created term is merged in locally and selected at once.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Plus } from 'lucide-react';
import type { FileDocumentTypeRow } from '@/types';

interface Props {
  options: FileDocumentTypeRow[];
  selected: string[];
  onToggle: (value: string) => void;
  disabled: boolean;
  isAr: boolean;
  /** Shown in the button when nothing is selected. */
  emptyLabel: string;
  /** When present, a "create new" input appears; returns the created (or reused)
   *  row so it can be shown + selected immediately. Omit for a fixed list. */
  onCreate?: (label: string) => Promise<FileDocumentTypeRow | null>;
  /** Placeholder for the create input. */
  createPlaceholder?: string;
}

export default function ClassificationSelect({
  options, selected, onToggle, disabled, isAr, emptyLabel, onCreate, createPlaceholder,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Terms created this session, merged into the list so they show + select at
  // once (the parent's `options` prop refreshes on its next load).
  const [extra, setExtra] = useState<FileDocumentTypeRow[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const all = [...options, ...extra.filter((e) => !options.some((o) => o.value === e.value))];
  const labelFor = (v: string) => {
    const o = all.find((x) => x.value === v);
    return o ? (isAr ? o.label_ar : o.label_en) : v;
  };

  const create = async () => {
    const label = newLabel.trim();
    if (!label || creating || !onCreate) return;
    setCreating(true);
    try {
      const row = await onCreate(label);
      if (row) {
        setExtra((prev) => (prev.some((e) => e.value === row.value) ? prev : [...prev, row]));
        if (!selected.includes(row.value)) onToggle(row.value);
        setNewLabel('');
      }
    } catch {
      /* onCreate surfaced the error */
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white border border-sand/40 text-sm text-charcoal text-start disabled:bg-cream/70 disabled:text-charcoal/60 focus:outline-none focus:ring-2 focus:ring-copper/30"
      >
        <span className={`truncate ${selected.length === 0 ? 'text-charcoal/45' : ''}`} dir="auto">
          {selected.length === 0 ? emptyLabel : selected.map(labelFor).join('، ')}
        </span>
        <ChevronDown size={14} className="shrink-0 text-charcoal/40" aria-hidden />
      </button>
      {open && !disabled && (
        <div className="absolute z-30 mt-1 w-full max-h-72 overflow-auto rounded-lg bg-white border border-sand/40 shadow-lg p-1">
          {all.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onToggle(o.value)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm text-charcoal hover:bg-cream text-start"
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${on ? 'bg-copper border-copper' : 'border-sand/60'}`}>
                  {on && <Check size={11} className="text-white" aria-hidden />}
                </span>
                <span className="flex-1 truncate" dir="auto">{isAr ? o.label_ar : o.label_en}</span>
              </button>
            );
          })}

          {/* Create a new classification inline — saved on add, no settings page. */}
          {onCreate && (
            <div className="mt-1 pt-1 border-t border-sand/30 flex items-center gap-1 p-1">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }}
                placeholder={createPlaceholder ?? (isAr ? 'تصنيف جديد…' : 'New classification…')}
                dir="auto"
                className="flex-1 min-w-0 px-2 py-1.5 rounded-md border border-sand/40 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
              />
              <button
                type="button"
                onClick={() => void create()}
                disabled={!newLabel.trim() || creating}
                aria-label={isAr ? 'إضافة' : 'Add'}
                className="p-1.5 rounded-md bg-copper text-white hover:bg-terracotta disabled:opacity-40 shrink-0"
              >
                {creating ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Plus size={13} aria-hidden />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
