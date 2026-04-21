import type { ModelField } from '@/types';

interface FieldPickerProps {
  candidates: ModelField[];
  selected: string[];
  onChange: (slugs: string[]) => void;
  isAr: boolean;
  selectAllLabel: string;
  deselectAllLabel: string;
}

export default function FieldPicker({
  candidates,
  selected,
  onChange,
  isAr,
  selectAllLabel,
  deselectAllLabel,
}: FieldPickerProps) {
  const toggle = (slug: string) => {
    onChange(selected.includes(slug) ? selected.filter((s) => s !== slug) : [...selected, slug]);
  };
  if (candidates.length === 0) {
    return (
      <p className="text-[11px] text-charcoal/30 italic">
        {isAr ? 'لا توجد حقول متاحة' : 'No fields available'}
      </p>
    );
  }
  return (
    <div>
      <div className="flex gap-2 mb-1.5">
        <button
          type="button"
          onClick={() => onChange(candidates.map((f) => f.name))}
          className="text-[11px] font-bold text-copper/70 hover:text-copper transition-colors"
        >
          {selectAllLabel}
        </button>
        <span className="text-charcoal/20">·</span>
        <button
          type="button"
          onClick={() => onChange([])}
          className="text-[11px] font-bold text-charcoal/40 hover:text-charcoal/60 transition-colors"
        >
          {deselectAllLabel}
        </button>
      </div>
      <div className="space-y-0.5 max-h-56 overflow-y-auto bg-sand/5 rounded-lg p-2">
        {candidates.map((f) => {
          const checked = selected.includes(f.name);
          return (
            <label
              key={f.id}
              className={`flex items-center gap-2.5 py-1.5 px-2 rounded-md cursor-pointer transition-colors ${
                checked ? 'bg-copper/[0.08]' : 'hover:bg-sand/15'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(f.name)}
                className="w-3.5 h-3.5 rounded border-sand/50 text-copper focus:ring-copper/20"
              />
              <span className={`text-[12px] flex-1 ${checked ? 'text-charcoal font-semibold' : 'text-charcoal/60'}`}>
                {isAr ? f.label_ar : f.label_en}
              </span>
              <span className="text-[10px] text-charcoal/25 bg-sand/10 px-1.5 py-0.5 rounded-full">
                {f.type}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
