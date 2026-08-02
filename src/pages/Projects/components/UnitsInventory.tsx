import { useMemo, useState } from 'react';
import { GitCompare, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { modelByName, fieldByCandidates } from '@/lib/projects/projectView';
import { resolveUnitView, unitsForProject, sortUnits, type UnitView, type UnitSortKey } from '@/lib/projects/unitView';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import UnitDrawer from './UnitDrawer';
import UnitCompareModal from './UnitCompareModal';

interface UnitsInventoryProps {
  projectId: string;
  projectName?: string | null;
  isAr: boolean;
}

const SAR = (n: number | null, isAr: boolean) => (n === null ? (isAr ? 'غير متوفر' : 'N/A') : `${n.toLocaleString(isAr ? 'ar-SA' : 'en-US')} ${isAr ? 'ر.س' : 'SAR'}`);

export default function UnitsInventory({ projectId, projectName, isAr }: UnitsInventoryProps) {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const unitsModel = modelByName(models, 'units');
  const statusField = fieldByCandidates(unitsModel, ['unit_status']);
  const typeField = fieldByCandidates(unitsModel, ['unit_type']);
  const floorField = fieldByCandidates(unitsModel, ['floor']);

  const translationVersion = useRecordTranslationVersion();
  const allUnits: UnitView[] = useMemo(
    () => unitsForProject({ models, records }, projectId).map((r) => resolveUnitView({ models, records }, r, { isAr, translate: getEntityFieldText })),
    // translationVersion: re-resolve unit model/notes/developer once translations hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, records, projectId, isAr, translationVersion],
  );

  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [floor, setFloor] = useState('');
  const [bedrooms, setBedrooms] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [areaMin, setAreaMin] = useState('');
  const [areaMax, setAreaMax] = useState('');
  const [sortKey, setSortKey] = useState<UnitSortKey>('cheapest');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawerUnit, setDrawerUnit] = useState<UnitView | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);

  const filtered = useMemo(() => {
    const pMin = priceMin ? Number(priceMin) : null;
    const pMax = priceMax ? Number(priceMax) : null;
    const aMin = areaMin ? Number(areaMin) : null;
    const aMax = areaMax ? Number(areaMax) : null;
    const bed = bedrooms ? Number(bedrooms) : null;
    const out = allUnits.filter((u) => {
      if (status && u.status?.value !== status) return false;
      if (type && u.type?.value !== type) return false;
      if (floor && u.floor?.value !== floor) return false;
      if (bed !== null && u.bedrooms !== bed) return false;
      if (pMin !== null && (u.totalPrice ?? Infinity) < pMin) return false;
      if (pMax !== null && (u.totalPrice ?? 0) > pMax) return false;
      if (aMin !== null && (u.area ?? Infinity) < aMin) return false;
      if (aMax !== null && (u.area ?? 0) > aMax) return false;
      return true;
    });
    return sortUnits(out, sortKey);
  }, [allUnits, status, type, floor, bedrooms, priceMin, priceMax, areaMin, areaMax, sortKey]);

  const selectedUnits = useMemo(() => filtered.filter((u) => selected.has(u.id)), [filtered, selected]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (!unitsModel) return <p className="text-sm text-charcoal/50">{isAr ? 'نموذج الوحدات غير موجود.' : 'Units model not found.'}</p>;

  const selectCls = 'form-input text-sm py-1.5';

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{isAr ? 'كل الحالات' : 'All statuses'}</option>
          {(statusField?.options ?? []).map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
        </select>
        <select className={selectCls} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">{isAr ? 'كل الأنواع' : 'All types'}</option>
          {(typeField?.options ?? []).map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
        </select>
        <select className={selectCls} value={floor} onChange={(e) => setFloor(e.target.value)}>
          <option value="">{isAr ? 'كل الطوابق' : 'All floors'}</option>
          {(floorField?.options ?? []).map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
        </select>
        <input className={`${selectCls} w-20`} type="number" value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} placeholder={isAr ? 'غرف' : 'Beds'} />
        <input className={`${selectCls} w-24`} type="number" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder={isAr ? 'سعر من' : 'Price ≥'} />
        <input className={`${selectCls} w-24`} type="number" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder={isAr ? 'سعر إلى' : 'Price ≤'} />
        <input className={`${selectCls} w-24`} type="number" value={areaMin} onChange={(e) => setAreaMin(e.target.value)} placeholder={isAr ? 'مساحة من' : 'Area ≥'} />
        <input className={`${selectCls} w-24`} type="number" value={areaMax} onChange={(e) => setAreaMax(e.target.value)} placeholder={isAr ? 'مساحة إلى' : 'Area ≤'} />
        <select className={selectCls} value={sortKey} onChange={(e) => setSortKey(e.target.value as UnitSortKey)}>
          <option value="cheapest">{isAr ? 'الأرخص' : 'Cheapest'}</option>
          <option value="largest">{isAr ? 'الأكبر مساحة' : 'Largest'}</option>
          <option value="best_per_m2">{isAr ? 'أفضل سعر متر' : 'Best price/m²'}</option>
          <option value="newest">{isAr ? 'الأحدث' : 'Newest'}</option>
        </select>
      </div>

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 bg-copper/10 rounded-lg px-3 py-2">
          <span className="text-sm text-charcoal/70">{isAr ? `${selected.size} محددة` : `${selected.size} selected`}</span>
          <Button variant="secondary" className="text-sm !py-1" onClick={() => setCompareOpen(true)} disabled={selected.size < 2}>
            <GitCompare size={14} className="inline -mt-0.5 me-1" /> {isAr ? 'مقارنة' : 'Compare'}
          </Button>
          <button onClick={() => setSelected(new Set())} className="text-charcoal/40 hover:text-charcoal ms-auto" aria-label="clear"><X size={16} /></button>
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="card p-10 text-center text-charcoal/40">{isAr ? 'لا توجد وحدات مطابقة.' : 'No matching units.'}</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-charcoal/40 text-xs border-b border-sand/50">
                <th className="p-2 w-8"></th>
                <th className="p-2 text-start">{isAr ? 'الكود' : 'Code'}</th>
                <th className="p-2 text-start">{isAr ? 'النوع' : 'Type'}</th>
                <th className="p-2 text-end">{isAr ? 'المساحة' : 'Area'}</th>
                <th className="p-2 text-center">{isAr ? 'غرف' : 'Beds'}</th>
                <th className="p-2 text-center">{isAr ? 'حمامات' : 'Baths'}</th>
                <th className="p-2 text-start">{isAr ? 'الطابق' : 'Floor'}</th>
                <th className="p-2 text-end">{isAr ? 'السعر' : 'Price'}</th>
                <th className="p-2 text-end">{isAr ? 'سعر المتر' : 'Price/m²'}</th>
                <th className="p-2 text-start">{isAr ? 'الحالة' : 'Status'}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id} className="border-b border-sand/30 hover:bg-cream/50 cursor-pointer" onClick={() => setDrawerUnit(u)}>
                  <td className="p-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} className="rounded border-sand text-copper focus:ring-copper/30" />
                  </td>
                  <td className="p-2 font-medium text-charcoal">{u.code ?? `#${u.id.slice(0, 6)}`}</td>
                  <td className="p-2 text-charcoal/70">{u.type ? (isAr ? u.type.label_ar : u.type.label_en) : '—'}</td>
                  <td className="p-2 text-end text-charcoal/70">{u.area !== null ? `${u.area} m²` : '—'}</td>
                  <td className="p-2 text-center text-charcoal/70">{u.bedrooms ?? '—'}</td>
                  <td className="p-2 text-center text-charcoal/70">{u.bathrooms ?? '—'}</td>
                  <td className="p-2 text-charcoal/70">{u.floor ? (isAr ? u.floor.label_ar : u.floor.label_en) : '—'}</td>
                  <td className="p-2 text-end font-medium text-charcoal">{SAR(u.totalPrice, isAr)}</td>
                  <td className="p-2 text-end text-charcoal/70">{u.pricePerM2 !== null ? u.pricePerM2.toLocaleString() : '—'}</td>
                  <td className="p-2">{u.status && <Badge label={isAr ? u.status.label_ar : u.status.label_en} color={u.status.color ?? undefined} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-xs text-charcoal/40">{isAr ? `${filtered.length} من ${allUnits.length} وحدة` : `${filtered.length} of ${allUnits.length} units`}</div>

      <UnitDrawer unit={drawerUnit} projectName={projectName} isAr={isAr} onClose={() => setDrawerUnit(null)} />
      <UnitCompareModal open={compareOpen} onClose={() => setCompareOpen(false)} units={selectedUnits} projectName={projectName} isAr={isAr} />
    </div>
  );
}
