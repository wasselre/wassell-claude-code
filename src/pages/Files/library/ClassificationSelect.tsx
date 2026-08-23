/**
 * A subject/classification MULTISELECT dropdown — one control for "what IS this
 * file", replacing the old single-value type dropdown (+ a chip row). Shared by
 * the Library detail panel and the post-upload modal so both behave identically.
 *
 * The selected set is the file's subjects; callers derive the primary
 * document_type from it (first selected, or the existing primary if still
 * chosen). Dropdown style so it stays compact in narrow panels.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { FileDocumentTypeRow } from '@/types';

interface Props {
  options: FileDocumentTypeRow[];
  selected: string[];
  onToggle: (value: string) => void;
  disabled: boolean;
  isAr: boolean;
  /** Shown in the button when nothing is selected. */
  emptyLabel: string;
}

export default function ClassificationSelect({ options, selected, onToggle, disabled, isAr, emptyLabel }: Props) {
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
  const labelFor = (v: string) => {
    const o = options.find((x) => x.value === v);
    return o ? (isAr ? o.label_ar : o.label_en) : v;
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
        <div className="absolute z-30 mt-1 w-full max-h-64 overflow-auto rounded-lg bg-white border border-sand/40 shadow-lg p-1">
          {options.map((o) => {
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
        </div>
      )}
    </div>
  );
}
