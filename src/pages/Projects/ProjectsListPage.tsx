import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LayoutGrid, List, Map as MapIcon, Search, Plus, MapPin, Building2, Target, Globe, AlertTriangle, Send, Check, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import MapsView from '@/pages/Records/components/MapsView';
import RecordListPage from '@/pages/Records/RecordListPage';
import BulkProjectSendFlow from '@/pages/Chats/components/BulkProjectSendFlow';
import ClientPicker, { type PickedClient } from '@/pages/Chats/components/ClientPicker';
import {
  resolveProjectView,
  modelByName,
  fieldByCandidates,
  formatPriceRange,
  type ProjectView,
} from '@/lib/projects/projectView';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import { useSignedImage } from '@/lib/projects/useSignedImage';

type ViewMode = 'grid' | 'list' | 'map';
type QualityFilter = 'all' | 'missing_geo' | 'has_geo' | 'missing_image';

/** KPI tile in the summary bar. */
function Kpi({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string | number; tone?: string }) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: (tone ?? '#B8734F') + '1A', color: tone ?? '#B8734F' }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold text-charcoal leading-none">{value}</div>
        <div className="text-xs text-charcoal/50 mt-1 truncate">{label}</div>
      </div>
    </div>
  );
}

export default function ProjectsListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { models, records, language, setRecordNavContext } = useAppStore();
  const isAr = language === 'ar';

  const model = modelByName(models, 'all_projects');

  // Escape hatch to the generic table/export view (same convention as followups).
  const useGeneric = searchParams.get('generic') === '1';

  const translationVersion = useRecordTranslationVersion();
  const rawRecords = useMemo(() => (model ? records[model.id] ?? [] : []), [model, records]);
  const views: ProjectView[] = useMemo(
    () => rawRecords.map((r) => resolveProjectView({ models, records }, r, { isAr, translate: getEntityFieldText })),
    // translationVersion: re-resolve names/geo once translations hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawRecords, models, records, isAr, translationVersion],
  );

  // ── filter state ──────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>('grid');
  const [city, setCity] = useState('');
  const [district, setDistrict] = useState('');
  const [developer, setDeveloper] = useState('');
  const [status, setStatus] = useState('');
  const [construction, setConstruction] = useState('');
  const [unitType, setUnitType] = useState('');
  const [targetedOnly, setTargetedOnly] = useState(false);
  const [quality, setQuality] = useState<QualityFilter>('all');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');

  // Bulk send: select several projects → pick a client → send them in order.
  const [selectMode, setSelectMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pickClient, setPickClient] = useState(false);
  const [recipient, setRecipient] = useState<PickedClient | null>(null);
  const toggleSel = (id: string) =>
    setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // ── distinct filter option lists, derived from the data ─────────────────────
  const cities = useMemo(() => [...new Set(views.map((v) => v.city).filter((x): x is string => !!x))].sort(), [views]);
  const districts = useMemo(() => [...new Set(views.map((v) => v.district).filter((x): x is string => !!x))].sort(), [views]);
  const developers = useMemo(() => [...new Set(views.map((v) => v.developer).filter((x): x is string => !!x))].sort(), [views]);
  const statusField = fieldByCandidates(model, ['project_status']);
  const constructionField = fieldByCandidates(model, ['construction_status']);
  const unitTypesField = fieldByCandidates(model, ['unit_types', 'unit_type']);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pMin = priceMin ? Number(priceMin) : null;
    const pMax = priceMax ? Number(priceMax) : null;
    return views.filter((v) => {
      if (q) {
        const hay = `${v.name ?? ''} ${v.developer ?? ''} ${v.city ?? ''} ${v.district ?? ''} ${v.projectId ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (city && v.city !== city) return false;
      if (district && v.district !== district) return false;
      if (developer && v.developer !== developer) return false;
      if (status && v.status?.value !== status) return false;
      if (construction && v.construction?.value !== construction) return false;
      if (unitType && !v.unitTypes.some((u) => u.value === unitType)) return false;
      if (targetedOnly && !v.isTargeted) return false;
      if (quality === 'missing_geo' && v.hasGeo) return false;
      if (quality === 'has_geo' && !v.hasGeo) return false;
      if (quality === 'missing_image' && v.imageRef) return false;
      if (pMin !== null && (v.priceRange?.max ?? Infinity) < pMin) return false;
      if (pMax !== null && (v.priceRange?.min ?? 0) > pMax) return false;
      return true;
    });
  }, [views, search, city, district, developer, status, construction, unitType, targetedOnly, quality, priceMin, priceMax]);

  // KPIs reflect the FILTERED set so they stay meaningful as the user narrows.
  const kpis = useMemo(() => {
    const availableUnits = filtered.reduce((n, v) => n + (v.availableUnits ?? 0), 0);
    const targeted = filtered.filter((v) => v.isTargeted).length;
    const publicCount = filtered.filter((v) => v.isPublic).length;
    const missingGeo = filtered.filter((v) => !v.hasGeo).length;
    return { total: filtered.length, availableUnits, targeted, publicCount, missingGeo };
  }, [filtered]);

  const filteredRecords = useMemo(() => filtered.map((v) => v.raw), [filtered]);
  const selectedIds = useMemo(() => filtered.filter((v) => sel.has(v.id)).map((v) => v.id), [filtered, sel]);

  // Publish the currently-visible, sorted project ids so the detail page's
  // prev/next steps through the same order shown here.
  useEffect(() => {
    if (!model) return;
    setRecordNavContext(model.id, filtered.map((v) => v.id));
  }, [model, filtered, setRecordNavContext]);

  if (!model) {
    return <div className="p-8 text-charcoal/50">{isAr ? 'النموذج غير موجود' : 'Model not found'}</div>;
  }
  // Generic escape hatch: render the standard list page (table / export / etc.).
  if (useGeneric) return <RecordListPage />;

  const labelEn = isAr ? model.label_ar : model.label_en;

  const selectCls = 'form-input text-sm py-1.5';

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">{labelEn}</h1>
          <p className="text-sm text-charcoal/50">{isAr ? 'قاعدة بيانات المشاريع الرئيسية' : 'Master project database'}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-sand">
            {([['grid', LayoutGrid], ['list', List], ['map', MapIcon]] as const).map(([m, Icon]) => (
              <button
                key={m}
                onClick={() => setView(m)}
                className={`px-3 py-2 ${view === m ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream'}`}
                title={m}
                aria-label={m}
              >
                <Icon size={16} />
              </button>
            ))}
          </div>
          <Button
            variant={selectMode ? 'primary' : 'secondary'}
            onClick={() => { setSelectMode((m) => !m); setSel(new Set()); }}
          >
            <Send size={16} className="inline -mt-0.5 me-1" />
            {selectMode ? (isAr ? 'إلغاء' : 'Cancel') : (isAr ? 'إرسال متعدد' : 'Bulk send')}
          </Button>
          <Button variant="ghost" onClick={() => navigate('/model/all_projects?generic=1')}>
            {isAr ? 'العرض الكلاسيكي' : 'Classic view'}
          </Button>
          <Button variant="primary" onClick={() => navigate('/model/all_projects/new')}>
            <Plus size={16} className="inline -mt-0.5 me-1" />
            {isAr ? 'مشروع جديد' : 'New Project'}
          </Button>
        </div>
      </div>

      {/* Bulk-send selection strip */}
      {selectMode && (
        <div className="card p-3 flex items-center justify-between gap-3 border-copper/40 bg-copper/5">
          <span className="text-sm text-charcoal/70">
            {isAr ? `${selectedIds.length} مشروع محدد` : `${selectedIds.length} project${selectedIds.length === 1 ? '' : 's'} selected`}
          </span>
          <Button variant="primary" disabled={selectedIds.length === 0} onClick={() => setPickClient(true)}>
            <Send size={15} className="inline -mt-0.5 me-1" />
            {isAr ? 'اختيار العميل والإرسال' : 'Choose client & send'}
          </Button>
        </div>
      )}

      {/* KPI summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <Kpi icon={<Building2 size={18} />} label={isAr ? 'إجمالي المشاريع' : 'Total projects'} value={kpis.total.toLocaleString()} tone="#B8734F" />
        <Kpi icon={<LayoutGrid size={18} />} label={isAr ? 'الوحدات المتاحة' : 'Available units'} value={kpis.availableUnits.toLocaleString()} tone="#10B981" />
        <Kpi icon={<Target size={18} />} label={isAr ? 'مشاريع مستهدفة' : 'Targeted projects'} value={kpis.targeted.toLocaleString()} tone="#8E4E3A" />
        <Kpi icon={<Globe size={18} />} label={isAr ? 'مشاريع منشورة' : 'Public projects'} value={kpis.publicCount.toLocaleString()} tone="#C09B5F" />
        <Kpi icon={<AlertTriangle size={18} />} label={isAr ? 'بدون موقع جغرافي' : 'Missing geo'} value={kpis.missingGeo.toLocaleString()} tone="#EF4444" />
      </div>

      {/* Filter bar */}
      <div className="card p-4 space-y-3">
        <div className="relative">
          <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAr ? 'ابحث بالاسم أو المطور أو المدينة…' : 'Search by name, developer, city…'}
            className="form-input w-full ps-9"
          />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          <select className={selectCls} value={city} onChange={(e) => setCity(e.target.value)}>
            <option value="">{isAr ? 'كل المدن' : 'All cities'}</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className={selectCls} value={district} onChange={(e) => setDistrict(e.target.value)}>
            <option value="">{isAr ? 'كل الأحياء' : 'All districts'}</option>
            {districts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className={selectCls} value={developer} onChange={(e) => setDeveloper(e.target.value)}>
            <option value="">{isAr ? 'كل المطورين' : 'All developers'}</option>
            {developers.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{isAr ? 'كل الحالات' : 'All statuses'}</option>
            {(statusField?.options ?? []).map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
          </select>
          <select className={selectCls} value={construction} onChange={(e) => setConstruction(e.target.value)}>
            <option value="">{isAr ? 'كل مراحل الإنشاء' : 'All construction'}</option>
            {(constructionField?.options ?? []).map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
          </select>
          <select className={selectCls} value={unitType} onChange={(e) => setUnitType(e.target.value)}>
            <option value="">{isAr ? 'كل أنواع الوحدات' : 'All unit types'}</option>
            {(unitTypesField?.options ?? []).map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
          </select>
          <select className={selectCls} value={quality} onChange={(e) => setQuality(e.target.value as QualityFilter)}>
            <option value="all">{isAr ? 'كل جودة البيانات' : 'Any data quality'}</option>
            <option value="missing_geo">{isAr ? 'بدون موقع جغرافي' : 'Missing geo'}</option>
            <option value="has_geo">{isAr ? 'لديه موقع جغرافي' : 'Has geo'}</option>
            <option value="missing_image">{isAr ? 'بدون صورة' : 'Missing image'}</option>
          </select>
          <input className={selectCls} type="number" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder={isAr ? 'أدنى سعر' : 'Min price'} />
          <input className={selectCls} type="number" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder={isAr ? 'أعلى سعر' : 'Max price'} />
          <label className="flex items-center gap-2 text-sm text-charcoal/70 px-1">
            <input type="checkbox" checked={targetedOnly} onChange={(e) => setTargetedOnly(e.target.checked)} className="rounded border-sand text-copper focus:ring-copper/30" />
            {isAr ? 'المستهدفة فقط' : 'Targeted only'}
          </label>
        </div>
        <div className="text-xs text-charcoal/50">
          {isAr ? `عرض ${filtered.length} من ${views.length} مشروع` : `Showing ${filtered.length} of ${views.length} projects`}
        </div>
      </div>

      {/* Body */}
      {view === 'map' ? (
        <div className="card p-2 h-[70vh]">
          <MapsView model={model} records={filteredRecords} onCardClick={(r) => navigate(`/model/all_projects/${r.id}`)} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-16 text-center text-charcoal/40">{isAr ? 'لا توجد مشاريع مطابقة' : 'No matching projects'}</div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((v) => (
            <ProjectCard
              key={v.id}
              v={v}
              isAr={isAr}
              onOpen={() => navigate(`/model/all_projects/${v.id}`)}
              selectable={selectMode}
              selected={sel.has(v.id)}
              onToggleSelect={() => toggleSel(v.id)}
            />
          ))}
        </div>
      ) : (
        <div className="card divide-y divide-sand/40">
          {filtered.map((v) => (
            <button
              key={v.id}
              onClick={() => (selectMode ? toggleSel(v.id) : navigate(`/model/all_projects/${v.id}`))}
              aria-pressed={selectMode ? sel.has(v.id) : undefined}
              className={`w-full text-start p-3 flex items-center gap-4 transition-colors ${selectMode && sel.has(v.id) ? 'bg-copper/5' : 'hover:bg-cream/50'}`}
            >
              {selectMode && (
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${sel.has(v.id) ? 'border-copper bg-copper text-white' : 'border-sand bg-white text-transparent'}`}>
                  <Check size={13} />
                </span>
              )}
              <div className="font-bold text-charcoal flex-1 min-w-0 truncate">{v.name ?? `#${v.id.slice(0, 8)}`}</div>
              <div className="text-sm text-charcoal/50 hidden md:block w-40 truncate">{[v.district, v.city].filter(Boolean).join(isAr ? '، ' : ', ') || '—'}</div>
              <div className="text-sm text-charcoal/50 hidden lg:block w-40 truncate">{v.developer ?? '—'}</div>
              <div className="text-sm text-charcoal/70 w-44 text-end">{formatPriceRange(v.priceRange, isAr) ?? (isAr ? 'غير متوفر' : 'N/A')}</div>
              <div className="text-sm text-charcoal/50 w-20 text-end">{v.availableUnits ?? '—'}</div>
              {v.status && <Badge label={isAr ? v.status.label_ar : v.status.label_en} color={v.status.color ?? undefined} />}
            </button>
          ))}
        </div>
      )}

      {/* Pick the recipient client for the bulk send. */}
      {pickClient && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setPickClient(false); }}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]" dir={isAr ? 'rtl' : 'ltr'}>
            <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20 shrink-0">
              <h2 className="flex-1 text-base font-bold text-chocolate">{isAr ? 'إرسال إلى عميل' : 'Send to a client'}</h2>
              <button onClick={() => setPickClient(false)} className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream" aria-label={isAr ? 'إغلاق' : 'Close'}>
                <X size={16} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto">
              <ClientPicker onPick={(c) => { setRecipient(c); setPickClient(false); }} />
            </div>
          </div>
        </div>
      )}

      {/* Bulk send — the selected projects to the chosen client, in order. */}
      {recipient && selectedIds.length > 0 && (
        <BulkProjectSendFlow
          isAr={isAr}
          projectIds={selectedIds}
          recipient={{ kind: 'client', client: recipient }}
          onClose={() => { setRecipient(null); setSelectMode(false); setSel(new Set()); }}
        />
      )}
    </div>
  );
}

function ProjectCard({
  v, isAr, onOpen, selectable = false, selected = false, onToggleSelect,
}: {
  v: ProjectView;
  isAr: boolean;
  onOpen: () => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const price = formatPriceRange(v.priceRange, isAr);
  const img = useSignedImage(v.imageRef);
  return (
    <div
      className={`card overflow-hidden flex flex-col group cursor-pointer ${selectable && selected ? 'ring-2 ring-copper' : ''}`}
      onClick={selectable ? onToggleSelect : onOpen}
    >
      {/* Image / placeholder */}
      <div className="h-36 bg-gradient-to-br from-copper/20 to-terracotta/20 relative flex items-center justify-center">
        {img ? (
          <img src={img} alt={v.name ?? ''} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <Building2 size={36} className="text-copper/40" />
        )}
        {selectable && (
          <span className={`absolute top-2 ${isAr ? 'start-2' : 'end-2'} flex h-6 w-6 items-center justify-center rounded-md border shadow-sm ${selected ? 'border-copper bg-copper text-white' : 'border-sand bg-white/90 text-transparent'}`}>
            <Check size={15} />
          </span>
        )}
        <div className="absolute top-2 start-2 flex gap-1.5">
          {v.status && <Badge label={isAr ? v.status.label_ar : v.status.label_en} color={v.status.color ?? undefined} />}
        </div>
        {v.construction && (
          <div className="absolute bottom-2 start-2">
            <Badge label={isAr ? v.construction.label_ar : v.construction.label_en} color={v.construction.color ?? '#C09B5F'} />
          </div>
        )}
        {v.isTargeted && (
          <div className="absolute top-2 end-2 bg-white/90 rounded-full p-1" title={isAr ? 'مستهدف' : 'Targeted'}>
            <Target size={14} className="text-copper" />
          </div>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col">
        <div className="font-bold text-charcoal truncate">{v.name ?? `#${v.id.slice(0, 8)}`}</div>
        <div className="text-sm text-charcoal/50 flex items-center gap-1 mt-0.5">
          <MapPin size={13} className="shrink-0" />
          <span className="truncate">{[v.district, v.city].filter(Boolean).join(isAr ? '، ' : ', ') || (isAr ? 'موقع غير محدد' : 'No location')}</span>
        </div>
        {v.developer && <div className="text-xs text-charcoal/40 mt-0.5 truncate">{v.developer}</div>}

        <div className="mt-2 text-sm">
          <span className="text-charcoal/40">{isAr ? 'السعر: ' : 'Price: '}</span>
          <span className="font-semibold text-charcoal">{price ?? (isAr ? 'غير متوفر' : 'N/A')}</span>
        </div>
        <div className="text-sm">
          <span className="text-charcoal/40">{isAr ? 'وحدات متاحة: ' : 'Available: '}</span>
          <span className="font-semibold text-charcoal">{v.availableUnits ?? '—'}</span>
        </div>

        {v.unitTypes.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {v.unitTypes.slice(0, 4).map((u) => (
              <span key={u.value} className="text-[11px] px-1.5 py-0.5 rounded bg-cream text-charcoal/60 border border-sand/50">
                {isAr ? u.label_ar : u.label_en}
              </span>
            ))}
          </div>
        )}

        <div className="mt-3 pt-2 border-t border-sand/40">
          <Button variant="secondary" className="w-full !py-1.5 text-sm" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
            {isAr ? 'فتح' : 'Open'}
          </Button>
        </div>
      </div>
    </div>
  );
}
