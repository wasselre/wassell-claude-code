import { useMemo, useRef, useState, useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { resolveLookupDisplayValue } from '@/lib/mirrorResolver';
import { Search, ChevronLeft, MapPin, Check, X } from 'lucide-react';
import type { LocationLevel, ModelField } from '@/types';

interface LocationCascadeFieldProps {
  field: ModelField;
  value: unknown; // compound: single { key: id } | multi { key: id[] }
  onChange: (value: unknown) => void;
}

const LEVEL_LABELS: Record<string, { ar: string; en: string }> = {
  country: { ar: 'الدولة', en: 'Country' },
  region: { ar: 'المنطقة', en: 'Region' },
  city: { ar: 'المدينة', en: 'City' },
  district: { ar: 'الحي', en: 'District' },
};

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * ONE guided location field. It renders as a single box; clicking it opens a single
 * dropdown that STEPS through region → city → district (each with a search). You
 * pick the region, then the city (filtered to that region), then the district
 * (filtered to that city) — not three separate inputs.
 *
 * Empty fields pre-seed region/city from `location_default` (e.g. الرياض/الرياض) so
 * the user only has to pick a district; they can still go back and change region or
 * city via the breadcrumb. Nothing is written until the user actually picks.
 *
 * Single mode (`location_multi` false) stores scalars { region, city, district }.
 * Multi mode (clients) keeps region/city single (1-element arrays) and lets the
 * deepest level (district) hold many — stored as { region:[id], city:[id], district:[ids] }.
 */
export default function LocationCascadeField({ field, value, onChange }: LocationCascadeFieldProps) {
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';
  const multi = !!field.location_multi;
  const levels = field.location_levels ?? [];
  const def = field.location_default ?? {};
  const lastIdx = levels.length - 1;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [query, setQuery] = useState('');

  const compound: Record<string, string | string[]> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string | string[]>)
      : {};

  const idsOf = (key: string): string[] => {
    const v = compound[key];
    if (Array.isArray(v)) return v.filter(isStr);
    return isStr(v) ? [v] : [];
  };
  // True only when NOTHING is picked yet — the default applies in this state only,
  // so once the user picks (e.g. changes the region) the الرياض default stops
  // forcing the city.
  const isEmpty = levels.every((lv) => idsOf(lv.key).length === 0);
  // Effective ids for a level: the real selection, else (only while totally empty)
  // the default for the non-deepest levels — region/city — so the deepest (district)
  // stays an explicit choice.
  const effIds = (idx: number): string[] => {
    const lv = levels[idx];
    if (!lv) return [];
    const real = idsOf(lv.key);
    if (real.length) return real;
    if (isEmpty && idx < lastIdx && isStr(def[lv.key])) return [def[lv.key] as string];
    return [];
  };

  const levelIsMulti = (idx: number) => multi && idx === lastIdx;

  // Resolve the parent-link slug on a child level (config wins, else auto-detect the
  // child model's lookup pointing at the parent level's model).
  const parentLinkFor = useMemo(() => {
    return (level: LocationLevel, parent: LocationLevel | null): string | null => {
      if (level.parent_link_field) return level.parent_link_field;
      if (!parent) return null;
      const model = models.find((m) => m.id === level.model_id);
      const lf = model?.schema.sections
        .flatMap((s) => s.fields)
        .find((f) => f.type === 'lookup' && f.lookup_model_id === parent.model_id);
      return lf?.name ?? null;
    };
  }, [models]);

  const levelLabel = (idx: number): string => {
    const lv = levels[idx];
    if (!lv) return '';
    const known = LEVEL_LABELS[lv.key];
    if (known) return isAr ? known.ar : known.en;
    const m = models.find((mm) => mm.id === lv.model_id);
    return m ? (isAr ? m.label_ar : m.label_en) : lv.key;
  };

  const nameOf = (idx: number, id: string): string => {
    const lv = levels[idx];
    if (!lv) return id.slice(0, 8);
    const recs = records[lv.model_id] ?? [];
    const rec = recs.find((r) => r.id === id);
    if (!rec) return isAr ? 'محذوف' : 'Deleted';
    const m = models.find((mm) => mm.id === lv.model_id);
    const dv = resolveLookupDisplayValue(rec, lv.display_field, { targetModel: m, allModels: models, allRecords: records });
    return dv !== null && dv !== undefined && typeof dv !== 'object' ? String(dv) : id.slice(0, 8);
  };

  // Candidates for a level, filtered to the effective parent's children + the query.
  const candidates = useMemo(() => {
    const lv = levels[step];
    if (!lv) return [];
    let recs = records[lv.model_id] ?? [];
    if (step > 0) {
      const parent = levels[step - 1]!;
      const plf = parentLinkFor(lv, parent);
      if (plf) {
        // This level links to its parent → show only the chosen parent's children
        // (empty until a parent is picked).
        const parentIds = effIds(step - 1);
        recs = parentIds.length ? recs.filter((r) => { const pv = r.data[plf]; return isStr(pv) && parentIds.includes(pv); }) : [];
      }
      // No parent link (e.g. region under a single country) → show all candidates.
    }
    const q = query.trim().toLowerCase();
    const scored = recs
      .map((r) => ({ r, name: nameOf(step, r.id) }))
      .filter((x) => !q || x.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return scored.slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, query, records, compound, levels]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Write helper: scalar in single mode; 1-element array for region/city in multi
  // mode; full array for the deepest level in multi mode.
  const shape = (idx: number, ids: string[]): string | string[] | undefined => {
    if (!multi) return ids[0];
    if (idx === lastIdx) return ids;
    return ids.slice(0, 1);
  };

  const commit = (nextIds: Record<number, string[]>) => {
    const out: Record<string, string | string[]> = {};
    levels.forEach((lv, i) => {
      const ids = nextIds[i] ?? idsOf(lv.key);
      const s = shape(i, ids);
      if (s !== undefined && (Array.isArray(s) ? s.length : s)) out[lv.key] = s;
    });
    onChange(Object.keys(out).length ? out : undefined);
  };

  const pick = (idx: number, id: string) => {
    const nextIds: Record<number, string[]> = {};
    // Fill ancestors from their effective (real-or-default) selection so picking a
    // district also commits the defaulted region + city.
    for (let i = 0; i < idx; i++) nextIds[i] = effIds(i);
    if (levelIsMulti(idx)) {
      const cur = idsOf(levels[idx]!.key);
      nextIds[idx] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      commit(nextIds); // stay open to add more
      setQuery('');
      return;
    }
    nextIds[idx] = [id];
    for (let d = idx + 1; d < levels.length; d++) nextIds[d] = []; // prune deeper
    commit(nextIds);
    setQuery('');
    if (idx < lastIdx) setStep(idx + 1); else setOpen(false);
  };

  const openAt = () => {
    // Start at the first level the user still needs to pick (region/city are
    // satisfied by the default, so an empty field opens straight to the district).
    let s = levels.findIndex((_, i) => effIds(i).length === 0);
    if (s < 0) s = lastIdx; // all filled → let them edit the deepest
    setStep(s);
    setQuery('');
    setOpen(true);
  };

  if (levels.length === 0) {
    return <div className="text-sm text-red-400">{isAr ? 'لم يتم إعداد حقل الموقع' : 'Location field not configured'}</div>;
  }

  // ── Collapsed box: the path of chosen (or defaulted) levels ──
  const pathParts: Array<{ idx: number; text: string; isReal: boolean }> = [];
  levels.forEach((lv, idx) => {
    const real = idsOf(lv.key);
    if (real.length) {
      const text = idx === lastIdx && multi && real.length > 1
        ? `${real.length} ${isAr ? 'أحياء' : 'districts'}`
        : nameOf(idx, real[0]!);
      pathParts.push({ idx, text, isReal: true });
    } else if (idx < lastIdx && isStr(def[lv.key])) {
      pathParts.push({ idx, text: nameOf(idx, def[lv.key] as string), isReal: false });
    }
  });
  const districtChosen = idsOf(levels[lastIdx]!.key).length > 0;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openAt())}
        className="form-input flex items-center gap-2 text-start w-full"
      >
        <MapPin size={14} className="text-copper/70 shrink-0" />
        {pathParts.length === 0 ? (
          <span className="text-charcoal/40">{isAr ? 'اختر الموقع...' : 'Select location...'}</span>
        ) : (
          <span className="flex items-center flex-wrap gap-x-1 gap-y-0.5">
            {pathParts.map((p, i) => (
              <span key={p.idx} className="flex items-center gap-1">
                {i > 0 && <ChevronLeft size={12} className="text-charcoal/30" />}
                <span className={p.isReal ? 'text-charcoal font-semibold' : 'text-charcoal/45'}>{p.text}</span>
              </span>
            ))}
            {!districtChosen && (
              <span className="flex items-center gap-1 text-copper">
                <ChevronLeft size={12} className="text-charcoal/30" />
                {isAr ? `اختر ${levelLabel(lastIdx)}` : `pick ${levelLabel(lastIdx).toLowerCase()}`}
              </span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-white rounded-xl border border-sand shadow-xl overflow-hidden animate-[fadeIn_0.1s_ease]">
          {/* Breadcrumb steps — click any to (re)pick that level */}
          <div className="flex items-center flex-wrap gap-1 px-3 pt-2.5 pb-2 border-b border-sand/40">
            {levels.map((lv, idx) => {
              const sel = idsOf(lv.key);
              const eff = effIds(idx);
              const label = levelLabel(idx);
              const active = idx === step;
              const valueText = sel.length
                ? (idx === lastIdx && multi && sel.length > 1 ? `${sel.length}` : nameOf(idx, sel[0]!))
                : eff.length ? nameOf(idx, eff[0]!) : '—';
              const disabled = idx > 0 && effIds(idx - 1).length === 0;
              return (
                <button
                  key={lv.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => { setStep(idx); setQuery(''); }}
                  className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors ${
                    active ? 'bg-copper/10 text-copper font-bold' : disabled ? 'text-charcoal/25' : 'text-charcoal/60 hover:bg-cream'
                  }`}
                >
                  {idx > 0 && <ChevronLeft size={11} className="text-charcoal/25" />}
                  <span className="font-semibold">{label}:</span>
                  <span className={sel.length ? '' : 'opacity-60'}>{valueText}</span>
                </button>
              );
            })}
          </div>

          {/* Search for the active level */}
          <div className="relative px-2 pt-2">
            <Search size={14} className="absolute start-4 top-1/2 -translate-y-1/2 text-charcoal/30" />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={isAr ? `ابحث في ${levelLabel(step)}...` : `Search ${levelLabel(step).toLowerCase()}...`}
              className="form-input ps-8 text-sm"
            />
          </div>

          {/* Candidate list */}
          <div className="max-h-56 overflow-y-auto py-1">
            {candidates.length === 0 ? (
              <div className="px-3 py-3 text-sm text-charcoal/30 text-center">{isAr ? 'لا توجد نتائج' : 'No results'}</div>
            ) : (
              candidates.map(({ r, name }) => {
                const selected = idsOf(levels[step]!.key).includes(r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => pick(step, r.id)}
                    className={`w-full px-3 py-2 text-start hover:bg-cream transition-colors text-sm flex items-center justify-between ${selected ? 'text-copper font-bold' : ''}`}
                  >
                    <span>{name}</span>
                    {selected && <Check size={14} className="text-copper" />}
                  </button>
                );
              })
            )}
          </div>

          {levelIsMulti(step) && (
            <div className="flex items-center justify-between px-3 py-2 border-t border-sand/40">
              <span className="text-xs text-charcoal/40">
                {idsOf(levels[step]!.key).length} {isAr ? 'محدد' : 'selected'}
              </span>
              <button type="button" onClick={() => setOpen(false)} className="text-xs font-bold text-copper hover:underline px-2 py-1">
                {isAr ? 'تم' : 'Done'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Clear */}
      {pathParts.some((p) => p.isReal) && (
        <button
          type="button"
          onClick={() => onChange(undefined)}
          className="absolute top-1/2 -translate-y-1/2 end-2 text-charcoal/30 hover:text-red-500"
          title={isAr ? 'مسح' : 'Clear'}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
