/**
 * Picking the projects a campaign is for.
 *
 * Two things this replaces a plain <select multiple> to get:
 *
 *  - It offers OUR projects, not the market catalogue. all_projects holds ~980
 *    rows because it is also the competitor/market register; 49 of them are
 *    Wassel's. A campaign of ours is for a project of ours, so the other 931
 *    were noise you had to scroll past.
 *  - It is searchable, by project name AND by developer, because "which of the
 *    ten Afaq projects was it" is answered by typing, not by scrolling.
 *
 * A project that is already linked but is NOT one of ours stays visible, in its
 * own group. Filtering the list must never make an existing link vanish — the
 * link would still be in the database, and a picker that hides it would let
 * someone save the record and silently drop it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X, Check } from 'lucide-react';
import type { ProjectOption } from '@/lib/marketingMgmt/projects';

const dash = '—';

export function ProjectPicker({ options, value, onChange, isAr, disabled }: {
  /** Our projects. Anything selected but absent from this list is kept. */
  options: ProjectOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  isAr: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setQ(''); return undefined; }
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    search.current?.focus();
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const byId = useMemo(() => new Map(options.map((p) => [p.id, p])), [options]);

  /** Selected ids that are not in Our Projects. They were linked at some point
   *  and the record still says so, so they are shown rather than dropped. */
  const foreign = useMemo(() => value.filter((id) => !byId.has(id)), [value, byId]);

  const match = (p: ProjectOption, needle: string) =>
    p.name.toLowerCase().includes(needle) || (p.developer ?? '').toLowerCase().includes(needle);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((p) => match(p, needle)) : options;
  }, [options, q]);

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  const label = (id: string) => byId.get(id)?.name
    ?? (isAr ? 'مشروع خارج مشاريعنا' : 'project outside Our Projects');

  return (
    <div ref={box} className="relative">
      {value.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {value.map((id) => (
            <span key={id}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                byId.has(id) ? 'bg-copper/10 text-copper' : 'bg-amber-50 text-amber-800'}`}>
              {label(id)}
              <button type="button" disabled={disabled} onClick={() => toggle(id)}
                className="hover:opacity-60 disabled:opacity-40"
                aria-label={isAr ? 'إزالة' : 'Remove'}>
                <X className="h-3 w-3" />
              </button>
            </span>))}
        </div>
      )}

      <button type="button" disabled={disabled} onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-start text-[12.5px] text-charcoal disabled:bg-cream-light/60">
        <span className={value.length ? 'text-charcoal/70' : 'text-charcoal/35'}>
          {value.length === 0
            ? (isAr ? 'اختر المشاريع' : 'Choose projects')
            : (isAr ? `${value.length} مشروع مختار` : `${value.length} selected`)}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-charcoal/30 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-sand/60 bg-white shadow-lg">
          <div className="border-b border-sand/30 p-2">
            <div className="relative">
              <Search className={`pointer-events-none absolute top-2 h-3.5 w-3.5 text-charcoal/30 ${isAr ? 'right-2' : 'left-2'}`} />
              <input ref={search} value={q} onChange={(e) => setQ(e.target.value)}
                placeholder={isAr ? 'ابحث باسم المشروع أو المطوّر' : 'Search by project or developer'}
                className={`w-full rounded-md border border-sand/60 py-1 text-[12.5px] text-charcoal focus:border-copper focus:outline-none ${
                  isAr ? 'pe-7 ps-2' : 'ps-7 pe-2'}`} />
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {options.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-charcoal/50">
                {isAr ? 'لا توجد مشاريع في «مشاريعنا» بعد.' : 'No projects in Our Projects yet.'}
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-charcoal/50">
                {isAr ? 'لا مشروع يطابق البحث' : 'No project matches that search'}
              </p>
            ) : filtered.map((p) => {
              const on = value.includes(p.id);
              return (
                <button key={p.id} type="button" onClick={() => toggle(p.id)}
                  className={`flex w-full items-start gap-2 px-3 py-1.5 text-start hover:bg-cream-light ${on ? 'bg-copper/5' : ''}`}>
                  <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                    on ? 'border-copper bg-copper text-white' : 'border-sand'}`}>
                    {on && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] text-charcoal">{p.name}</span>
                    <span className="block truncate text-[10.5px] text-charcoal/45">
                      {p.developer ?? (isAr ? 'المطوّر غير محدد' : 'developer not set')}
                    </span>
                  </span>
                </button>);
            })}

            {foreign.length > 0 && (
              <div className="border-t border-sand/30 bg-amber-50/40">
                <p className="px-3 pt-2 text-[10.5px] text-amber-800">
                  {isAr ? 'مرتبط بالحملة لكنه ليس من «مشاريعنا»' : 'Linked to this campaign but not in Our Projects'}
                </p>
                {foreign.map((id) => (
                  <button key={id} type="button" onClick={() => toggle(id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-start hover:bg-amber-50">
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-copper bg-copper text-white">
                      <Check className="h-2.5 w-2.5" />
                    </span>
                    <span className="min-w-0 truncate text-[12px] text-charcoal/70">{label(id)}</span>
                  </button>))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-sand/30 px-3 py-1.5">
            <span className="text-[10.5px] text-charcoal/40">
              {q.trim()
                ? `${filtered.length} / ${options.length}`
                : (isAr ? `${options.length} من مشاريعنا` : `${options.length} of our projects`)}
            </span>
            <button type="button" onClick={() => setOpen(false)}
              className="text-[11.5px] font-medium text-copper hover:underline">
              {isAr ? 'تم' : 'Done'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One project as a line of text — for read-only display beside a record. The
 *  project name and its developer are proper nouns, so there is nothing here to
 *  translate; an unresolvable project renders the em dash rather than an id. */
export const projectLine = (p: ProjectOption | undefined) =>
  (p ? `${p.name}${p.developer ? ` — ${p.developer}` : ''}` : dash);
