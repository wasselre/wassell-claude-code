import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import BackToSettings from './components/BackToSettings';
import GeoElementsMap from './components/GeoElementsMap';
import { MapPin, Search, Loader2, ExternalLink, BadgeCheck, TriangleAlert, X, Check, ChevronLeft, ChevronRight, Map as MapIcon, List as ListIcon } from 'lucide-react';
import {
  adminListGeoElements, adminGeoFacets, adminGetGeoElement, adminUpdateGeoElement,
  adminAddGeoAlias, adminRemoveGeoAlias,
  type GeoAdminRow, type GeoAdminDetail, type GeoFacets, type GeoListFilters, type GeoUpdatePatch,
} from '@/lib/geo/adminClient';

const PAGE_SIZE = 50;
const REVIEW_STATUSES = ['approved', 'needs_review', 'rejected'] as const;
const REVIEW_COLOR: Record<string, string> = { approved: '#059669', needs_review: '#D97706', rejected: '#B91C1C' };

const triParse = (s: string): boolean | null => (s === 'true' ? true : s === 'false' ? false : null);

function Bool({ v }: { v: boolean }) {
  return v
    ? <Check size={15} className="text-emerald-600" />
    : <X size={15} className="text-charcoal/25" />;
}

/**
 * Geo Elements management module (admin). Inspect / filter / review / control the
 * geo-intelligence anchors that power client location_items + Project Finder.
 * Read+manage only — geometry is never edited here, and matching semantics,
 * geoMatch.ts and the client resolver (/api/geo-elements) are untouched.
 */
export default function GeoElementsPage() {
  const language = useAppStore((s) => s.language);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = language === 'ar';
  const canEdit = useIsAdmin(); // page is RequireAdmin; this also gates the edit controls

  const [facets, setFacets] = useState<GeoFacets | null>(null);
  const [rows, setRows] = useState<GeoAdminRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');

  // filters
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState('');
  const [city, setCity] = useState('');
  const [geometryType, setGeometryType] = useState('');
  const [reviewStatus, setReviewStatus] = useState('');
  const [isVerified, setIsVerified] = useState<string>('');
  const [isApproximate, setIsApproximate] = useState<string>('');
  const [isActive, setIsActive] = useState<string>('');
  const [isSearchable, setIsSearchable] = useState<string>('');
  const [lowConf, setLowConf] = useState(false);

  useEffect(() => { adminGeoFacets().then(setFacets).catch(() => {}); }, []);

  const filters = useMemo<GeoListFilters>(() => ({
    q: q.trim() || null, category: category || null, type: type || null, city: city || null,
    geometry_type: geometryType || null, review_status: reviewStatus || null,
    is_verified: triParse(isVerified), is_approximate: triParse(isApproximate),
    is_active: triParse(isActive), is_searchable: triParse(isSearchable),
    low_confidence: lowConf || null, limit: PAGE_SIZE, offset,
  }), [q, category, type, city, geometryType, reviewStatus, isVerified, isApproximate, isActive, isSearchable, lowConf, offset]);

  // reset to page 1 whenever a filter (other than offset) changes
  const filterKey = JSON.stringify({ ...filters, offset: 0 });
  const prevKey = useRef(filterKey);
  useEffect(() => { if (prevKey.current !== filterKey) { prevKey.current = filterKey; setOffset(0); } }, [filterKey]);

  // load (debounced on q via the effect deps)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      adminListGeoElements(filters)
        .then((res) => { if (!cancelled) { setRows(res.rows); setTotal(res.total); } })
        .catch((e) => { if (!cancelled) addToast(e instanceof Error ? e.message : 'load failed', 'error'); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [filters, addToast]);

  const resetFilters = () => {
    setQ(''); setCategory(''); setType(''); setCity(''); setGeometryType(''); setReviewStatus('');
    setIsVerified(''); setIsApproximate(''); setIsActive(''); setIsSearchable(''); setLowConf(false); setOffset(0);
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // optimistic patch of a row after an edit in the drawer
  const patchRow = (id: string, patch: Partial<GeoAdminRow>) =>
    setRows((rs) => rs.map((r) => (r.external_id === id ? { ...r, ...patch } : r)));

  const sel = (val: string, set: (v: string) => void, opts: string[], anyLabel: string) => (
    <select value={val} onChange={(e) => set(e.target.value)} className="form-input !py-1.5 text-xs">
      <option value="">{anyLabel}</option>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
  const tri = (val: string, set: (v: string) => void, label: string) => (
    <select value={val} onChange={(e) => set(e.target.value)} className="form-input !py-1.5 text-xs" title={label}>
      <option value="">{label}: {isAr ? 'الكل' : 'any'}</option>
      <option value="true">{label}: {isAr ? 'نعم' : 'yes'}</option>
      <option value="false">{label}: {isAr ? 'لا' : 'no'}</option>
    </select>
  );

  return (
    <div className="space-y-4">
      <BackToSettings className="!mb-0" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MapPin size={20} className="text-copper" />
          <h1 className="text-lg font-bold text-chocolate">{isAr ? 'عناصر الجغرافيا' : 'Geo Elements'}</h1>
          {facets && <span className="text-xs text-charcoal/40">({facets.total} {isAr ? 'عنصر' : 'anchors'})</span>}
        </div>
        <div className="inline-flex overflow-hidden rounded-lg border border-sand/50 text-xs font-bold">
          <button type="button" onClick={() => setView('list')}
            className={`inline-flex items-center gap-1 px-3 py-1.5 transition ${view === 'list' ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream'}`}>
            <ListIcon size={14} /> {isAr ? 'قائمة' : 'List'}
          </button>
          <button type="button" onClick={() => setView('map')}
            className={`inline-flex items-center gap-1 px-3 py-1.5 transition ${view === 'map' ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream'}`}>
            <MapIcon size={14} /> {isAr ? 'خريطة' : 'Map'}
          </button>
        </div>
      </div>
      <p className="text-xs text-charcoal/50 -mt-2">
        {isAr
          ? 'إدارة معالم الرياض (طرق، مترو، مولات، مستشفيات، مناطق…) التي يستخدمها اختيار موقع العميل ومحرك إيجاد المشاريع.'
          : 'Manage the Riyadh anchors (roads, metro, malls, hospitals, zones…) used by client location selection and the Project Finder.'}
      </p>

      {/* Filters */}
      <div className="card p-3 space-y-2">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute top-2.5 ltr:left-2.5 rtl:right-2.5 text-charcoal/30" />
          <input
            type="text" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={isAr ? 'بحث: الاسم العربي/الإنجليزي، المعرف، الأسماء البديلة…' : 'Search: name_ar / name_en / external_id / aliases…'}
            className="form-input ltr:pl-8 rtl:pr-8 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {sel(category, setCategory, facets?.categories ?? [], isAr ? 'الفئة' : 'category')}
          {sel(type, setType, facets?.types ?? [], isAr ? 'النوع' : 'type')}
          {sel(city, setCity, facets?.cities ?? [], isAr ? 'المدينة' : 'city')}
          {sel(geometryType, setGeometryType, facets?.geometry_types ?? [], isAr ? 'الهندسة' : 'geometry')}
          {sel(reviewStatus, setReviewStatus, facets?.review_statuses ?? [], isAr ? 'حالة المراجعة' : 'review status')}
          {tri(isVerified, setIsVerified, isAr ? 'موثّق' : 'verified')}
          {tri(isApproximate, setIsApproximate, isAr ? 'تقريبي' : 'approx')}
          {tri(isActive, setIsActive, isAr ? 'مفعّل' : 'active')}
          {tri(isSearchable, setIsSearchable, isAr ? 'قابل للبحث' : 'searchable')}
          <label className="inline-flex items-center gap-1 text-xs font-semibold text-charcoal/70 px-2">
            <input type="checkbox" checked={lowConf} onChange={(e) => setLowConf(e.target.checked)} />
            {isAr ? 'ثقة منخفضة فقط' : 'low confidence only'}
          </label>
          <button type="button" onClick={resetFilters} className="text-xs font-semibold text-copper hover:underline px-2">
            {isAr ? 'إعادة تعيين' : 'reset'}
          </button>
        </div>
      </div>

      {/* Results — list table or map */}
      {view === 'map' ? (
        <GeoElementsMap filters={filters} isAr={isAr} onSelect={(id) => setSelected(id)} />
      ) : (
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-sand/30 text-xs text-charcoal/60">
          <span>{loading ? (isAr ? 'جارٍ التحميل…' : 'Loading…') : `${total} ${isAr ? 'نتيجة' : 'results'}`}</span>
          <span className="flex items-center gap-2">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className="disabled:opacity-30"><ChevronRight className="rtl:hidden inline" size={16} /><ChevronLeft className="ltr:hidden inline" size={16} /></button>
            {isAr ? `صفحة ${page} من ${pageCount}` : `Page ${page} / ${pageCount}`}
            <button disabled={page >= pageCount} onClick={() => setOffset(offset + PAGE_SIZE)} className="disabled:opacity-30"><ChevronLeft className="rtl:hidden inline" size={16} /><ChevronRight className="ltr:hidden inline" size={16} /></button>
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs whitespace-nowrap">
            <thead className="bg-cream/60 text-charcoal/60">
              <tr className="text-start">
                {['external_id', 'name_ar', 'name_en', 'category', 'type', 'city', 'geom', 'conf', 'verif', 'approx', 'review', 'active', 'search', 'source', 'updated']
                  .map((h) => <th key={h} className="px-2 py-2 text-start font-bold">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.external_id} onClick={() => setSelected(r.external_id)} className="border-t border-sand/20 hover:bg-cream/50 cursor-pointer">
                  <td className="px-2 py-1.5 font-mono text-[11px] text-copper">{r.external_id}</td>
                  <td className="px-2 py-1.5 max-w-[160px] truncate">{r.name_ar}</td>
                  <td className="px-2 py-1.5 max-w-[160px] truncate">{r.name_en}</td>
                  <td className="px-2 py-1.5">{r.category}</td>
                  <td className="px-2 py-1.5">{r.type}</td>
                  <td className="px-2 py-1.5">{r.city}</td>
                  <td className="px-2 py-1.5">{r.geometry_type}</td>
                  <td className="px-2 py-1.5 tabular-nums">{r.confidence_score == null ? '—' : r.confidence_score.toFixed(2)}</td>
                  <td className="px-2 py-1.5">{r.is_verified ? <BadgeCheck size={14} className="text-emerald-600" /> : <span className="text-charcoal/25">—</span>}</td>
                  <td className="px-2 py-1.5">{r.is_approximate ? <TriangleAlert size={14} className="text-amber-500" /> : <span className="text-charcoal/25">—</span>}</td>
                  <td className="px-2 py-1.5"><span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ backgroundColor: `${REVIEW_COLOR[r.review_status] ?? '#6B7280'}1F`, color: REVIEW_COLOR[r.review_status] ?? '#6B7280' }}>{r.review_status}</span></td>
                  <td className="px-2 py-1.5"><Bool v={r.is_active} /></td>
                  <td className="px-2 py-1.5"><Bool v={r.is_searchable} /></td>
                  <td className="px-2 py-1.5 text-[11px] text-charcoal/50">{r.source_type}</td>
                  <td className="px-2 py-1.5 text-[11px] text-charcoal/40">{r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : '—'}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={15} className="px-3 py-8 text-center text-charcoal/40">{isAr ? 'لا توجد نتائج' : 'No results'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {selected && (
        <GeoElementDrawer
          externalId={selected}
          isAr={isAr}
          canEdit={canEdit}
          onClose={() => setSelected(null)}
          onSaved={(el) => patchRow(el.external_id, el)}
          addToast={addToast}
        />
      )}
    </div>
  );
}

// ── Detail drawer (Modal) ─────────────────────────────────────────────────────
function GeoElementDrawer({ externalId, isAr, canEdit, onClose, onSaved, addToast }: {
  externalId: string; isAr: boolean; canEdit: boolean;
  onClose: () => void; onSaved: (el: GeoAdminRow) => void;
  addToast: (m: string, t: 'success' | 'error' | 'info') => void;
}) {
  const [el, setEl] = useState<GeoAdminDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [edit, setEdit] = useState<GeoUpdatePatch>({});
  const [newAlias, setNewAlias] = useState('');
  const [newAliasLang, setNewAliasLang] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminGetGeoElement(externalId)
      .then(({ element }) => { if (!cancelled) { setEl(element); setEdit({}); } })
      .catch((e) => { if (!cancelled) addToast(e instanceof Error ? e.message : 'load failed', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [externalId, addToast]);

  const field = <K extends keyof GeoUpdatePatch>(k: K): GeoUpdatePatch[K] =>
    (k in edit ? edit[k] : (el?.[k as keyof GeoAdminDetail] as GeoUpdatePatch[K]));
  const setField = <K extends keyof GeoUpdatePatch>(k: K, v: GeoUpdatePatch[K]) => setEdit((e) => ({ ...e, [k]: v }));
  const dirty = Object.keys(edit).length > 0;

  const save = async () => {
    if (!el || !dirty) return;
    setSaving(true);
    try {
      const { element } = await adminUpdateGeoElement(el.external_id, edit);
      setEl(element); setEdit({});
      onSaved(element);
      addToast(isAr ? 'تم الحفظ' : 'Saved', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : 'save failed', 'error');
    } finally { setSaving(false); }
  };

  const addAlias = async () => {
    if (!el || !newAlias.trim()) return;
    try {
      const { aliases } = await adminAddGeoAlias(el.external_id, newAlias.trim(), newAliasLang || null);
      setEl({ ...el, aliases }); setNewAlias(''); setNewAliasLang('');
    } catch (e) { addToast(e instanceof Error ? e.message : 'alias add failed', 'error'); }
  };
  const removeAlias = async (id: string) => {
    if (!el) return;
    try { const { aliases } = await adminRemoveGeoAlias(id); setEl({ ...el, aliases }); }
    catch (e) { addToast(e instanceof Error ? e.message : 'alias remove failed', 'error'); }
  };

  const lat = el?.latitude, lng = el?.longitude;
  const gmaps = lat != null && lng != null ? `https://www.google.com/maps?q=${lat},${lng}` : null;

  return (
    <Modal open onClose={onClose} maxWidth="max-w-2xl"
      title={isAr ? `عنصر: ${externalId}` : `Geo element: ${externalId}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{isAr ? 'إغلاق' : 'Close'}</Button>
          {canEdit && <Button onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : null}{isAr ? 'حفظ التغييرات' : 'Save changes'}
          </Button>}
        </>
      }>
      {loading || !el ? (
        <div className="flex items-center justify-center py-10 text-charcoal/40"><Loader2 className="animate-spin" /></div>
      ) : (
        <div className="space-y-4 text-sm">
          {/* identity */}
          <div className="grid grid-cols-2 gap-3">
            <Labeled label={isAr ? 'الاسم العربي' : 'name_ar'}>
              {canEdit ? <input className="form-input" value={field('name_ar') ?? ''} onChange={(e) => setField('name_ar', e.target.value)} /> : <span>{el.name_ar ?? '—'}</span>}
            </Labeled>
            <Labeled label={isAr ? 'الاسم الإنجليزي' : 'name_en'}>
              {canEdit ? <input className="form-input" value={field('name_en') ?? ''} onChange={(e) => setField('name_en', e.target.value)} /> : <span>{el.name_en ?? '—'}</span>}
            </Labeled>
            <Labeled label={isAr ? 'الفئة' : 'category'}><span>{el.category}</span></Labeled>
            <Labeled label={isAr ? 'النوع' : 'type'}><span>{el.type}</span></Labeled>
            <Labeled label={isAr ? 'المدينة' : 'city'}><span>{el.city ?? '—'}</span></Labeled>
            <Labeled label={isAr ? 'الثقة' : 'confidence'}><span>{el.confidence_score == null ? '—' : el.confidence_score.toFixed(2)}{el.confidence_score != null && el.confidence_score < 0.5 ? <span className="ms-1 text-amber-600 text-xs">({isAr ? 'منخفضة' : 'low'})</span> : null}</span></Labeled>
          </div>

          {/* admin controls */}
          <div className="rounded-lg border border-sand/40 bg-cream/30 p-3 grid grid-cols-2 gap-3">
            <Labeled label={isAr ? 'حالة المراجعة' : 'review_status'}>
              {canEdit ? (
                <select className="form-input !py-1.5" value={field('review_status') ?? el.review_status} onChange={(e) => setField('review_status', e.target.value)}>
                  {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : <span>{el.review_status}</span>}
            </Labeled>
            <div className="flex items-end gap-4">
              <Toggle label={isAr ? 'مفعّل' : 'is_active'} disabled={!canEdit}
                onChange={(v) => setField('is_active', v)} val={field('is_active') ?? el.is_active} />
              <Toggle label={isAr ? 'قابل للبحث' : 'is_searchable'} disabled={!canEdit}
                onChange={(v) => setField('is_searchable', v)} val={field('is_searchable') ?? el.is_searchable} />
            </div>
            <div className="col-span-2">
              <Labeled label={isAr ? 'ملاحظات' : 'notes'}>
                {canEdit ? <textarea className="form-input min-h-[60px]" value={field('notes') ?? '' } onChange={(e) => setField('notes', e.target.value)} /> : <span className="whitespace-pre-wrap">{el.notes ?? '—'}</span>}
              </Labeled>
            </div>
          </div>

          {/* geometry + location */}
          <div className="grid grid-cols-2 gap-3">
            <Labeled label={isAr ? 'نوع الهندسة' : 'geometry_type'}><span>{el.geometry_type} · {el.geometry_summary?.postgis_type} · {el.geometry_summary?.n_points} pts</span></Labeled>
            <Labeled label={isAr ? 'الإحداثيات' : 'coordinates'}><span className="tabular-nums">{lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : '—'}</span></Labeled>
            <Labeled label={isAr ? 'المصدر' : 'source'}>
              <span className="flex items-center gap-2">
                <span>{el.source_type}</span>
                {el.source_url && <a href={el.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-copper hover:underline">{isAr ? 'الرابط' : 'link'} <ExternalLink size={11} /></a>}
              </span>
            </Labeled>
            <Labeled label={isAr ? 'خريطة' : 'map'}>
              {gmaps ? <a href={gmaps} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-copper hover:underline">{isAr ? 'افتح في خرائط جوجل' : 'Open in Google Maps'} <ExternalLink size={11} /></a> : <span>—</span>}
            </Labeled>
          </div>
          <div className="rounded-lg border border-dashed border-sand/50 bg-cream/20 px-3 py-2 text-[11px] text-charcoal/40">
            {isAr ? 'معاينة الخريطة المضمّنة — الإصدار الثاني. ' : 'Embedded map preview — v2. '}
            bbox: <span className="font-mono">{el.geometry_summary?.bbox ?? '—'}</span>
          </div>

          {/* aliases */}
          <div>
            <div className="mb-1 text-xs font-bold text-charcoal/60">{isAr ? 'الأسماء البديلة' : 'Aliases'}</div>
            <div className="flex flex-wrap gap-1.5">
              {el.aliases.length === 0 && <span className="text-xs text-charcoal/40">—</span>}
              {el.aliases.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-sand/20 px-2 py-0.5 text-xs">
                  {a.alias}{a.lang ? <span className="text-charcoal/40">·{a.lang}</span> : null}
                  {canEdit && <button onClick={() => void removeAlias(a.id)} className="hover:opacity-60"><X size={11} /></button>}
                </span>
              ))}
            </div>
            {canEdit && (
              <div className="mt-2 flex gap-2">
                <input className="form-input !py-1.5 text-xs flex-1" placeholder={isAr ? 'اسم بديل جديد…' : 'new alias…'} value={newAlias} onChange={(e) => setNewAlias(e.target.value)} />
                <select className="form-input !py-1.5 text-xs w-20" value={newAliasLang} onChange={(e) => setNewAliasLang(e.target.value)}>
                  <option value="">—</option><option value="ar">ar</option><option value="en">en</option>
                </select>
                <Button variant="secondary" onClick={() => void addAlias()} disabled={!newAlias.trim()}>{isAr ? 'إضافة' : 'Add'}</Button>
              </div>
            )}
          </div>

          {/* raw */}
          <div>
            <button onClick={() => setShowRaw((v) => !v)} className="text-xs font-semibold text-copper hover:underline">
              {showRaw ? (isAr ? 'إخفاء' : 'Hide') : (isAr ? 'عرض' : 'Show')} {isAr ? 'البيانات الخام (JSON)' : 'raw JSON'}
            </button>
            {showRaw && (
              <pre className="mt-1 max-h-60 overflow-auto rounded bg-charcoal/90 p-3 text-[10px] leading-4 text-cream">
                {JSON.stringify(el.raw ?? {}, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold text-charcoal/50">{label}</div>
      {children}
    </div>
  );
}

function Toggle({ label, val, onChange, disabled }: { label: string; val: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`inline-flex items-center gap-1.5 text-xs font-semibold ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={!!val} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
