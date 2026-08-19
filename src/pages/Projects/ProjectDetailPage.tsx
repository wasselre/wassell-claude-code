import { useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Building2, MapPin, Pencil, Search, ExternalLink, FileText, AlertTriangle,
  CheckCircle2, Target, Eye, EyeOff, ArrowRight, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import RecordFormPage from '@/pages/Records/RecordFormPage';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import {
  resolveProjectView, modelByName, fieldByCandidates, optionsFor, optionFor,
  formatPriceRange, formatRange, asString, asFiniteNumber, type ProjectView,
} from '@/lib/projects/projectView';
import { auditProject } from '@/lib/projects/projectAi';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import { useSignedImage } from '@/lib/projects/useSignedImage';
import UnitsInventory from './components/UnitsInventory';
import MatchClientModal from './components/MatchClientModal';
import PaymentPlansTabPane from '@/pages/Records/components/PaymentPlansTabPane';

type TabKey = 'overview' | 'units' | 'payments' | 'location' | 'media' | 'sales' | 'quality';

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card p-3 text-center">
      <div className="text-lg font-bold" style={{ color: tone ?? '#4A2C2A' }}>{value}</div>
      <div className="text-[11px] text-charcoal/50 mt-0.5">{label}</div>
    </div>
  );
}

/**
 * Route usage passes NO props (reads modelName + recordId from the URL). It can
 * also be embedded as an overlay (e.g. an option's "View source" inside the
 * chat's Client Options popup) by passing `recordId` + `modelName` + `onClose`:
 * the ids then come from props and the Exit button closes the overlay. All
 * embedded behaviour is gated on `onClose`, so route usage is byte-identical.
 */
export default function ProjectDetailPage(
  { recordId: recordIdProp, modelName: modelNameProp, onClose }:
  { recordId?: string; modelName?: string; onClose?: () => void } = {},
) {
  const params = useParams();
  const recordId = recordIdProp ?? params.recordId;
  const modelName = modelNameProp ?? params.modelName;
  const embedded = !!onClose;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { models, records, language, saveRecord, addToast, recordNavContext } = useAppStore();
  const isAr = language === 'ar';

  // Two surfaces share this page: the All Projects master detail and the Our
  // Projects PORTFOLIO detail. In portfolio mode every project FACT comes from
  // the linked all_projects master; the our_projects record adds the sales layer.
  const isPortfolio = modelName === 'our_projects';
  const apModel = modelByName(models, 'all_projects');
  const ourModel = modelByName(models, 'our_projects');

  const portfolioRecord = useMemo(
    () => (isPortfolio && ourModel ? (records[ourModel.id] ?? []).find((r) => r.id === recordId) : undefined),
    [isPortfolio, ourModel, records, recordId],
  );

  // The all_projects record that drives every project fact: the routed record
  // (master mode) or the master linked via our_projects.project (portfolio mode).
  const record = useMemo(() => {
    if (!apModel) return undefined;
    if (!isPortfolio) return (records[apModel.id] ?? []).find((r) => r.id === recordId);
    const raw = portfolioRecord?.data?.project;
    const linkedId = Array.isArray(raw) ? (typeof raw[0] === 'string' ? raw[0] : null) : (typeof raw === 'string' ? raw : null);
    return linkedId ? (records[apModel.id] ?? []).find((r) => r.id === linkedId) : undefined;
  }, [apModel, isPortfolio, records, recordId, portfolioRecord]);

  const translationVersion = useRecordTranslationVersion();
  const view: ProjectView | null = useMemo(
    () => (record ? resolveProjectView({ models, records }, record, { isAr, translate: getEntityFieldText }) : null),
    // translationVersion: re-resolve name/developer once translations hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [record, models, records, isAr, translationVersion],
  );

  const [tab, setTab] = useState<TabKey>('overview');
  const [matchOpen, setMatchOpen] = useState(false);
  // Edit the all_projects master in a popup instead of navigating to its form.
  const [editMasterOpen, setEditMasterOpen] = useState(false);
  // Hook must run before any early return: resolve the hero image (main_image,
  // or the portfolio's hero_image_override) from a files.id to a signed URL.
  const heroRef = (isPortfolio ? asString(portfolioRecord?.data?.hero_image_override) : null) ?? view?.imageRef ?? null;
  const heroImage = useSignedImage(heroRef);

  // Prev/next walks the list the user was browsing: the portfolio page (or the
  // All Projects page) publishes its filtered+sorted ids into recordNavContext.
  // Deep links have no context, so fall back to the model's insertion order —
  // same contract as the generic RecordFormPage. Hooks stay ABOVE the
  // conditional returns below (React #310).
  const navModel = isPortfolio ? ourModel : apModel;
  const orderedIds = useMemo(() => {
    if (!navModel) return [];
    if (recordNavContext && recordNavContext.modelId === navModel.id) return recordNavContext.orderedIds;
    return (records[navModel.id] ?? []).map((r) => r.id);
  }, [navModel, recordNavContext, records]);
  const currentIndex = recordId ? orderedIds.indexOf(recordId) : -1;
  const prevId = currentIndex > 0 ? orderedIds[currentIndex - 1] ?? null : null;
  const nextId = currentIndex >= 0 && currentIndex < orderedIds.length - 1 ? orderedIds[currentIndex + 1] ?? null : null;

  if (searchParams.get('generic') === '1') return <RecordFormPage />;
  if (!apModel || (isPortfolio && !ourModel)) return <div className="p-8 text-charcoal/50">{isAr ? 'النموذج غير موجود' : 'Model not found'}</div>;
  // Portfolio mode: the our_projects record must exist (its master may be unlinked).
  if (isPortfolio && !portfolioRecord) {
    return (
      <div className="p-8 text-charcoal/50">
        {isAr ? 'السجل غير موجود.' : 'Record not found.'}{' '}
        <button className="text-copper underline" onClick={() => navigate('/model/our_projects')}>{isAr ? 'العودة' : 'Back'}</button>
      </div>
    );
  }
  // Master mode: the project must exist.
  if (!isPortfolio && (!record || !view)) {
    return (
      <div className="p-8 text-charcoal/50">
        {isAr ? 'المشروع غير موجود.' : 'Project not found.'}{' '}
        <button className="text-copper underline" onClick={() => navigate('/model/all_projects')}>{isAr ? 'العودة' : 'Back'}</button>
      </div>
    );
  }

  const model = apModel; // narrowed to AppModel after the guard above
  const dash = isAr ? 'غير متوفر' : 'N/A';
  const listHref = `/model/${isPortfolio ? 'our_projects' : 'all_projects'}`;
  const editHref = `${listHref}/${recordId}?generic=1`;
  const navBtn = 'p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-charcoal/40';
  const heroName = view?.name ?? asString(portfolioRecord?.data?.project_name) ?? `#${recordId?.slice(0, 8) ?? ''}`;
  const portfolioStatus = isPortfolio ? optionFor(fieldByCandidates(ourModel, ['portfolio_status']), portfolioRecord?.data?.portfolio_status) : null;
  const NoMaster = () => (
    <div className="card p-10 text-center text-charcoal/50 text-sm">
      {isAr ? 'هذا السجل غير مرتبط بمشروع رئيسي في «جميع المشاريع».' : 'This record is not linked to a master project in All Projects.'}{' '}
      <button className="text-copper underline" onClick={() => navigate(editHref)}>{isAr ? 'اربط مشروعاً' : 'Link a project'}</button>
    </div>
  );
  // Payment Plans tab shows only when the project actually has a plan menu
  // (built from its units) — no empty tab on plan-less projects.
  const hasPaymentPlans =
    Array.isArray((record?.data as Record<string, unknown> | undefined)?.payment_plan_schedule) &&
    ((record!.data as Record<string, unknown>).payment_plan_schedule as unknown[]).length > 0;
  const TABS: { key: TabKey; ar: string; en: string }[] = [
    { key: 'overview', ar: 'نظرة عامة', en: 'Overview' },
    { key: 'units', ar: 'الوحدات', en: 'Units' },
    ...(hasPaymentPlans
      ? ([{ key: 'payments', ar: 'خطط السداد', en: 'Payment Plans' }] as { key: TabKey; ar: string; en: string }[])
      : []),
    { key: 'location', ar: 'الموقع', en: 'Location' },
    { key: 'media', ar: 'الوسائط', en: 'Media' },
    { key: 'sales', ar: 'ملاحظات المبيعات', en: 'Sales Notes' },
    { key: 'quality', ar: 'جودة البيانات', en: 'Data Quality' },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Record toolbar — exit back to the list, and step through it in order. */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={embedded ? onClose : () => navigate(listHref)}
          title={
            embedded
              ? (isAr ? 'العودة إلى خيارات العميل' : 'Back to Client Options')
              : (isAr ? 'إغلاق والعودة إلى القائمة' : 'Close and return to the list')
          }
          className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm text-charcoal/50 hover:text-charcoal hover:bg-sand/30 transition-colors"
        >
          <ArrowRight size={18} className="rtl:rotate-0 ltr:rotate-180" />
          {embedded ? (isAr ? 'رجوع' : 'Back') : (isAr ? 'خروج' : 'Exit')}
        </button>
        {/* Prev/next steps through the browsed list — meaningless (and it would
            navigate away) when embedded as an overlay, so hide it there. */}
        {!embedded && (
          <div className="flex items-center gap-1">
            {currentIndex >= 0 && (
              <span className="text-xs text-charcoal/40 tabular-nums px-1">{currentIndex + 1} / {orderedIds.length}</span>
            )}
            <button
              type="button"
              onClick={() => prevId && navigate(`${listHref}/${prevId}`)}
              disabled={!prevId}
              title={isAr ? 'السجل السابق' : 'Previous record'}
              aria-label={isAr ? 'السجل السابق' : 'Previous record'}
              className={navBtn}
            >
              <ChevronLeft size={20} className="rtl:rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => nextId && navigate(`${listHref}/${nextId}`)}
              disabled={!nextId}
              title={isAr ? 'السجل التالي' : 'Next record'}
              aria-label={isAr ? 'السجل التالي' : 'Next record'}
              className={navBtn}
            >
              <ChevronRight size={20} className="rtl:rotate-180" />
            </button>
          </div>
        )}
      </div>

      {/* Hero */}
      <div className="card overflow-hidden">
        <div className="h-40 bg-gradient-to-br from-copper/25 to-terracotta/20 relative flex items-center justify-center">
          {heroImage ? (
            <img src={heroImage} alt={heroName} className="w-full h-full object-cover" />
          ) : <Building2 size={48} className="text-copper/40" />}
        </div>
        <div className="p-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              {isPortfolio && <Badge label={isAr ? 'محفظتنا' : 'Portfolio'} color="#B8734F" />}
              <h1 className="text-2xl font-bold text-charcoal">{heroName}</h1>
              {portfolioStatus && <Badge label={isAr ? portfolioStatus.label_ar : portfolioStatus.label_en} color={portfolioStatus.color ?? undefined} />}
              {view?.status && <Badge label={isAr ? view.status.label_ar : view.status.label_en} color={view.status.color ?? undefined} />}
              {view?.construction && <Badge label={isAr ? view.construction.label_ar : view.construction.label_en} color={view.construction.color ?? '#C09B5F'} />}
              {view?.isTargeted && <Badge label={isAr ? 'مستهدف' : 'Targeted'} color="#8E4E3A" />}
            </div>
            <div className="text-sm text-charcoal/60 mt-1 flex items-center gap-1">
              <MapPin size={14} /> {[view?.district, view?.city].filter(Boolean).join(isAr ? '، ' : ', ') || dash}
            </div>
            {view?.developer && <div className="text-sm text-charcoal/40 mt-0.5">{view.developer}</div>}
          </div>
          <div className="flex items-center gap-2">
            {isPortfolio && view && (
              <Button variant="ghost" onClick={() => navigate(`/model/all_projects/${view.id}`)}>
                <Building2 size={14} className="inline -mt-0.5 me-1" /> {isAr ? 'المشروع الرئيسي' : 'Master project'}
              </Button>
            )}
            {/* Portfolio mode keeps a second Edit for the portfolio-only fields
                (status, display order, pitch…) which live on the our_projects
                record, so the two Edits are labelled apart. */}
            {isPortfolio && (
              <Button variant="ghost" onClick={() => navigate(editHref)}>
                <Pencil size={14} className="inline -mt-0.5 me-1" /> {isAr ? 'تحرير المحفظة' : 'Edit portfolio'}
              </Button>
            )}
            {/* Edits the all_projects record in a popup — the project facts are
                one click away from wherever you are, with no page jump. */}
            {view && (
              <Button variant="ghost" onClick={() => setEditMasterOpen(true)}>
                <Pencil size={14} className="inline -mt-0.5 me-1" /> {isAr ? 'تحرير المشروع' : 'Edit project'}
              </Button>
            )}
            <Button variant="secondary" onClick={() => setMatchOpen(true)}>
              <Search size={14} className="inline -mt-0.5 me-1" /> {isAr ? 'مطابقة عميل' : 'Match client'}
            </Button>
          </div>
        </div>
      </div>

      {/* KPI cards */}
      {view && (
        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2">
          <Kpi label={isAr ? 'الوحدات' : 'Units'} value={view.unitCount?.toLocaleString() ?? '—'} />
          <Kpi label={isAr ? 'متاحة' : 'Available'} value={view.availableUnits?.toLocaleString() ?? '—'} tone="#10B981" />
          <Kpi label={isAr ? 'مباعة' : 'Sold'} value={view.soldUnits?.toLocaleString() ?? '—'} tone="#8B5CF6" />
          <Kpi label={isAr ? 'محجوزة' : 'Reserved'} value={view.reservedUnits?.toLocaleString() ?? '—'} tone="#3B82F6" />
          <Kpi label={isAr ? 'نطاق السعر' : 'Price range'} value={formatPriceRange(view.priceRange, isAr) ?? '—'} />
          <Kpi label={isAr ? 'نطاق المساحة' : 'Area range'} value={formatRange(view.areaRange, 'm²') ?? '—'} />
          <Kpi label={isAr ? 'متوسط سعر المتر' : 'Avg /m²'} value={avgPerM2(view, isAr)} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-sand/50 overflow-x-auto">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={`px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${tab === tb.key ? 'border-copper text-copper' : 'border-transparent text-charcoal/50 hover:text-charcoal'}`}
          >
            {isAr ? tb.ar : tb.en}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === 'overview' && (view && record ? <OverviewTab view={view} record={record} model={model} isAr={isAr} /> : <NoMaster />)}
        {tab === 'units' && (view ? <UnitsInventory projectId={view.id} projectName={view.name} isAr={isAr} /> : <NoMaster />)}
        {tab === 'payments' && (view ? <PaymentPlansTabPane projectId={view.id} /> : <NoMaster />)}
        {tab === 'location' && (view && record ? <LocationTab view={view} record={record} isAr={isAr} /> : <NoMaster />)}
        {tab === 'media' && (view && record ? <MediaTab view={view} record={record} model={model} isAr={isAr} /> : <NoMaster />)}
        {tab === 'sales' && (
          isPortfolio && portfolioRecord && ourModel ? (
            <PortfolioNotesTab
              record={portfolioRecord} model={ourModel} isAr={isAr}
              onSave={async (data) => {
                const res = await saveRecord({ ...portfolioRecord, data: { ...portfolioRecord.data, ...data } });
                addToast(res.status === 'conflict' ? (isAr ? 'تم تعديل السجل في مكان آخر — أعد التحميل' : 'Record changed elsewhere — reload') : (isAr ? 'تم الحفظ' : 'Saved'), res.status === 'conflict' ? 'error' : 'success');
              }}
            />
          ) : record ? (
            <SalesNotesTab
              record={record} model={model} isAr={isAr}
              onSave={async (data) => {
                const res = await saveRecord({ ...record, data: { ...record.data, ...data } });
                addToast(res.status === 'conflict' ? (isAr ? 'تم تعديل السجل في مكان آخر — أعد التحميل' : 'Record changed elsewhere — reload') : (isAr ? 'تم الحفظ' : 'Saved'), res.status === 'conflict' ? 'error' : 'success');
              }}
            />
          ) : <NoMaster />
        )}
        {tab === 'quality' && (view && record ? <DataQualityTab view={view} record={record} isAr={isAr} /> : <NoMaster />)}
      </div>

      <MatchClientModal open={matchOpen} onClose={() => setMatchOpen(false)} isAr={isAr} />

      {editMasterOpen && view && (
        <RecordFormModal
          modelId={model.id}
          recordId={view.id}
          onClose={() => setEditMasterOpen(false)}
          openInPageHref={`/model/all_projects/${view.id}?generic=1`}
        />
      )}
    </div>
  );
}

function avgPerM2(view: ProjectView, isAr: boolean): string {
  const ap = view.raw.data;
  const v = ap.avg_price_per_m2;
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toLocaleString(isAr ? 'ar-SA' : 'en-US')}` : '—';
}

// ── Tabs ────────────────────────────────────────────────────────────────────

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 border-b border-sand/30 text-sm">
      <span className="text-charcoal/50">{label}</span>
      <span className="text-charcoal font-medium text-end">{value}</span>
    </div>
  );
}

function Chips({ items }: { items: { value: string; label: string }[] }) {
  if (items.length === 0) return <span className="text-charcoal/40 text-sm">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((i) => <span key={i.value} className="text-xs px-1.5 py-0.5 rounded bg-cream text-charcoal/70 border border-sand/50">{i.label}</span>)}
    </div>
  );
}

/** Render a `table` field (features / guarantees / services / landmarks) as a small table. */
function ProjectTable({ field, rows, isAr }: { field: import('@/types').ModelField; rows: Record<string, unknown>[]; isAr: boolean }) {
  const cols = field.table_columns ?? [];
  if (!rows.length || !cols.length) return null;
  return (
    <div className="card p-4 md:col-span-2">
      <h3 className="font-bold text-charcoal mb-2">{isAr ? field.label_ar : field.label_en}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-charcoal/40 text-xs border-b border-sand/50">
              {cols.map((c) => <th key={c.id} className="text-start p-2 font-medium">{(isAr ? c.label_ar : c.label_en) || c.label_ar || c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-sand/30">
                {cols.map((c) => {
                  const v = row[c.name];
                  return <td key={c.id} className="p-2 text-charcoal/80">{v != null && v !== '' ? String(v) : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The table fields shown on the Overview tab (read from the all_projects record). */
function ProjectTables({ record, model, isAr }: { record: import('@/types').AppRecord; model: import('@/types').AppModel; isAr: boolean }) {
  return (
    <>
      {['features', 'guarantees', 'services'].map((slug) => {
        const f = fieldByCandidates(model, [slug]);
        const rows = Array.isArray(record.data[slug]) ? (record.data[slug] as Record<string, unknown>[]) : [];
        return f && rows.length ? <ProjectTable key={slug} field={f} rows={rows} isAr={isAr} /> : null;
      })}
    </>
  );
}

function OverviewTab({ view, record, model, isAr }: { view: ProjectView; record: import('@/types').AppRecord; model: import('@/types').AppModel; isAr: boolean }) {
  const dash = isAr ? 'غير متوفر' : 'N/A';
  const amenitiesField = fieldByCandidates(model, ['preferred_amenities']);
  const amenities = optionsFor(amenitiesField, record.data[amenitiesField?.name ?? '']).map((o) => ({ value: o.value, label: isAr ? o.label_ar : o.label_en }));
  const unitTypes = view.unitTypes.map((o) => ({ value: o.value, label: isAr ? o.label_ar : o.label_en }));
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="card p-4">
        <h3 className="font-bold text-charcoal mb-2">{isAr ? 'الهوية' : 'Identity'}</h3>
        <Fact label={isAr ? 'المطور' : 'Developer'} value={view.developer ?? dash} />
        <Fact label={isAr ? 'معرف المشروع' : 'Project ID'} value={view.projectId ?? dash} />
        <Fact label={isAr ? 'النوع' : 'Type'} value={view.projectType ? (isAr ? view.projectType.label_ar : view.projectType.label_en) : dash} />
        <Fact label={isAr ? 'الحالة' : 'Status'} value={view.status ? (isAr ? view.status.label_ar : view.status.label_en) : dash} />
        <Fact label={isAr ? 'حالة الإنشاء' : 'Construction'} value={view.construction ? (isAr ? view.construction.label_ar : view.construction.label_en) : dash} />
      </div>
      <div className="card p-4">
        <h3 className="font-bold text-charcoal mb-2">{isAr ? 'الوحدات والمرافق' : 'Units & Amenities'}</h3>
        <div className="py-1.5 border-b border-sand/30 text-sm"><span className="text-charcoal/50 block mb-1">{isAr ? 'أنواع الوحدات' : 'Unit types'}</span><Chips items={unitTypes} /></div>
        <div className="py-1.5 text-sm"><span className="text-charcoal/50 block mb-1">{isAr ? 'المرافق' : 'Amenities'}</span><Chips items={amenities} /></div>
      </div>
      <div className="card p-4 md:col-span-2">
        <h3 className="font-bold text-charcoal mb-2">{isAr ? 'روابط' : 'Links'}</h3>
        <div className="flex flex-wrap gap-3 text-sm">
          {view.brochureOurs && <a className="text-copper hover:underline inline-flex items-center gap-1" href={view.brochureOurs} target="_blank" rel="noreferrer"><FileText size={13} /> {isAr ? 'بروشورنا' : 'Our brochure'}</a>}
          {view.brochureDeveloper && <a className="text-copper hover:underline inline-flex items-center gap-1" href={view.brochureDeveloper} target="_blank" rel="noreferrer"><FileText size={13} /> {isAr ? 'بروشور المطور' : 'Developer brochure'}</a>}
          {view.locationLink && <a className="text-copper hover:underline inline-flex items-center gap-1" href={view.locationLink} target="_blank" rel="noreferrer"><MapPin size={13} /> {isAr ? 'الموقع' : 'Location'}</a>}
          {asString(record.data.project_page_url) && <a className="text-copper hover:underline inline-flex items-center gap-1" href={asString(record.data.project_page_url)!} target="_blank" rel="noreferrer"><ExternalLink size={13} /> {isAr ? 'صفحة المشروع' : 'Project page'}</a>}
          {!view.brochureOurs && !view.brochureDeveloper && !view.locationLink && <span className="text-charcoal/40">{dash}</span>}
        </div>
      </div>
      <ProjectTables record={record} model={model} isAr={isAr} />
    </div>
  );
}

function LocationTab({ view, record, isAr }: { view: ProjectView; record: import('@/types').AppRecord; isAr: boolean }) {
  const dash = isAr ? 'غير متوفر' : 'N/A';
  const landmarks = Array.isArray(record.data.nearby_landmarks) ? (record.data.nearby_landmarks as Record<string, unknown>[]) : [];
  const lat = asFiniteNumber(record.data.latitude);
  const lng = asFiniteNumber(record.data.longitude);
  // Google Maps embed (no API key needed) centered on the project with a marker.
  const embedSrc = lat !== null && lng !== null ? `https://maps.google.com/maps?q=${lat},${lng}&z=15&hl=${isAr ? 'ar' : 'en'}&output=embed` : null;
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="card p-4">
        <h3 className="font-bold text-charcoal mb-2">{isAr ? 'الموقع' : 'Location'}</h3>
        <Fact label={isAr ? 'المدينة' : 'City'} value={view.city ?? dash} />
        <Fact label={isAr ? 'الحي' : 'District'} value={view.district ?? dash} />
        {view.locationLink && <a href={view.locationLink} target="_blank" rel="noreferrer" className="text-copper hover:underline text-sm inline-flex items-center gap-1 mt-2"><ExternalLink size={13} /> {isAr ? 'فتح في خرائط Google' : 'Open in Google Maps'}</a>}
        {landmarks.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'المعالم القريبة' : 'Nearby landmarks'}</div>
            <ul className="text-sm text-charcoal/70 list-disc list-inside">
              {landmarks.slice(0, 12).map((row, i) => (
                // Skip system keys (`_row_id` — the W1 element identity) so
                // uuids never render into the landmarks list.
                <li key={i}>{Object.entries(row).filter(([k, x]) => !k.startsWith('_') && x != null && x !== '').map(([, x]) => x).join(' — ')}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="card p-1 h-80 overflow-hidden">
        {embedSrc ? (
          <iframe title="map" src={embedSrc} className="w-full h-full rounded-lg border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-charcoal/40 text-sm gap-2">
            <MapPin size={28} />
            {isAr ? 'لا توجد إحداثيات لعرض الخريطة' : 'No coordinates to show the map'}
            {view.locationLink && <a href={view.locationLink} target="_blank" rel="noreferrer" className="text-copper hover:underline">{isAr ? 'فتح في الخرائط' : 'Open in Maps'}</a>}
          </div>
        )}
      </div>
    </div>
  );
}

/** A direct video FILE (our storage or any URL ending in a video extension) —
 *  playable inline, unlike a YouTube/page link. */
const isDirectVideoUrl = (u: string): boolean => /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(u);
/** A direct image FILE — renderable inline. */
const isDirectImageUrl = (u: string): boolean => /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(u);
/** The 11-char video id from any YouTube URL shape, or null when it isn't one. */
const youTubeId = (u: string): string | null => {
  const m = u.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([\w-]{11})/i);
  return m?.[1] ?? null;
};

function MediaTab({ view, record, model, isAr }: { view: ProjectView; record: import('@/types').AppRecord; model: import('@/types').AppModel; isAr: boolean }) {
  const dash = isAr ? 'لا توجد وسائط قابلة للعرض' : 'No directly-viewable media';
  const gallery = Array.isArray(record.data.project_images)
    ? (record.data.project_images as unknown[]).filter((x): x is string => typeof x === 'string' && /^https?:\/\//i.test(x))
    : [];
  const videos = Array.isArray(record.data.project_videos)
    ? (record.data.project_videos as unknown[]).filter((x): x is string => typeof x === 'string' && /^https?:\/\//i.test(x))
    : [];
  const projectPage = asString(record.data.project_page_url);
  const heroImg = useSignedImage(view.imageRef);
  const hasAny = heroImg || gallery.length > 0 || videos.length > 0 || view.brochureOurs || view.brochureDeveloper || projectPage || view.locationLink;
  return (
    <div className="space-y-4">
      {heroImg && <img src={heroImg} alt="" className="rounded-xl border border-sand/50 max-h-80 object-cover" />}
      {gallery.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {gallery.map((u, i) => <img key={i} src={u} alt="" className="rounded-lg border border-sand/50 h-32 w-full object-cover" loading="lazy" />)}
        </div>
      )}
      {videos.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {videos.map((u, i) => {
            // A file we host (or any direct video URL) plays inline; a YouTube
            // link becomes an embedded player; a stored image renders as a
            // picture; anything else stays a plain link (it genuinely IS one).
            if (isDirectVideoUrl(u)) {
              return <video key={i} src={u} controls preload="metadata" className="rounded-lg border border-sand/50 w-full max-h-96 bg-black" />;
            }
            const yt = youTubeId(u);
            if (yt) {
              return (
                <div key={i} className="relative w-full rounded-lg overflow-hidden border border-sand/50" style={{ aspectRatio: '16 / 9' }}>
                  <iframe
                    src={`https://www.youtube.com/embed/${yt}`}
                    title={`${isAr ? 'فيديو' : 'video'} ${i + 1}`}
                    className="absolute inset-0 h-full w-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    loading="lazy"
                  />
                </div>
              );
            }
            if (isDirectImageUrl(u)) {
              return <img key={i} src={u} alt="" className="rounded-lg border border-sand/50 w-full object-cover" loading="lazy" />;
            }
            return <a key={i} href={u} target="_blank" rel="noreferrer" className="text-copper hover:underline text-sm self-center break-all">🎬 {u}</a>;
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-sm">
        {projectPage && <a className="text-copper hover:underline inline-flex items-center gap-1" href={projectPage} target="_blank" rel="noreferrer"><ExternalLink size={13} /> {isAr ? 'صفحة المشروع' : 'Project page'}</a>}
        {view.locationLink && <a className="text-copper hover:underline inline-flex items-center gap-1" href={view.locationLink} target="_blank" rel="noreferrer"><MapPin size={13} /> {isAr ? 'موقع Google Maps' : 'Google Maps'}</a>}
        {view.brochureOurs && <a className="text-copper hover:underline inline-flex items-center gap-1" href={view.brochureOurs} target="_blank" rel="noreferrer"><FileText size={13} /> {isAr ? 'بروشورنا' : 'Our brochure'}</a>}
        {view.brochureDeveloper && <a className="text-copper hover:underline inline-flex items-center gap-1" href={view.brochureDeveloper} target="_blank" rel="noreferrer"><FileText size={13} /> {isAr ? 'بروشور المطور' : 'Developer brochure'}</a>}
      </div>
      {!hasAny && (
        <div className="card p-6 text-center text-charcoal/40 text-sm">
          {dash}. <button className="text-copper underline" onClick={() => window.open(`/model/${model.name}/${record.id}?generic=1`, '_self')}>{isAr ? 'إدارة الملفات في النموذج' : 'Manage files in the form'}</button>
        </div>
      )}
    </div>
  );
}

function SalesNotesTab({ record, model, isAr, onSave }: { record: import('@/types').AppRecord; model: import('@/types').AppModel; isAr: boolean; onSave: (data: Record<string, unknown>) => Promise<void> }) {
  const priorityField = fieldByCandidates(model, ['sales_priority']);
  const exclusiveField = fieldByCandidates(model, ['exclusive_status']);
  const [priority, setPriority] = useState(asString(record.data.sales_priority) ?? '');
  const [exclusive, setExclusive] = useState(asString(record.data.exclusive_status) ?? '');
  const [targeted, setTargeted] = useState(record.data.is_targeted === true);
  const [internal, setInternal] = useState(asString(record.data.internal_sales_notes) ?? '');
  const [objection, setObjection] = useState(asString(record.data.objection_handling_notes) ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await onSave({ sales_priority: priority || null, exclusive_status: exclusive || null, is_targeted: targeted, internal_sales_notes: internal || null, objection_handling_notes: objection || null });
    } finally { setBusy(false); }
  };
  const sel = 'form-input text-sm';
  return (
    <div className="card p-4 max-w-2xl space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm"><span className="text-charcoal/60 block mb-1">{isAr ? 'أولوية المبيعات' : 'Sales priority'}</span>
          <select className={sel} value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">—</option>
            {(priorityField?.options ?? []).map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
          </select>
        </label>
        <label className="text-sm"><span className="text-charcoal/60 block mb-1">{isAr ? 'حالة الحصرية' : 'Exclusive status'}</span>
          <select className={sel} value={exclusive} onChange={(e) => setExclusive(e.target.value)}>
            <option value="">—</option>
            {(exclusiveField?.options ?? []).map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-charcoal/70">
        <input type="checkbox" checked={targeted} onChange={(e) => setTargeted(e.target.checked)} className="rounded border-sand text-copper focus:ring-copper/30" />
        <Target size={14} /> {isAr ? 'مشروع مستهدف' : 'Targeted project'}
      </label>
      <label className="text-sm block"><span className="text-charcoal/60 block mb-1">{isAr ? 'ملاحظات مبيعات داخلية' : 'Internal sales notes'}</span>
        <textarea className={sel} rows={3} value={internal} onChange={(e) => setInternal(e.target.value)} />
      </label>
      <label className="text-sm block"><span className="text-charcoal/60 block mb-1">{isAr ? 'التعامل مع الاعتراضات' : 'Objection handling'}</span>
        <textarea className={sel} rows={3} value={objection} onChange={(e) => setObjection(e.target.value)} />
      </label>
      <Button variant="primary" onClick={save} disabled={busy}>{busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}</Button>
    </div>
  );
}

function PortfolioNotesTab({ record, model, isAr, onSave }: { record: import('@/types').AppRecord; model: import('@/types').AppModel; isAr: boolean; onSave: (data: Record<string, unknown>) => Promise<void> }) {
  const statusField = fieldByCandidates(model, ['portfolio_status']);
  const priorityField = fieldByCandidates(model, ['sales_priority']);
  const exclusiveField = fieldByCandidates(model, ['exclusive_status']);
  const [status, setStatus] = useState(asString(record.data.portfolio_status) ?? '');
  const [priority, setPriority] = useState(asString(record.data.sales_priority) ?? '');
  const [exclusive, setExclusive] = useState(asString(record.data.exclusive_status) ?? '');
  const [order, setOrder] = useState(asFiniteNumber(record.data.website_display_order)?.toString() ?? '');
  const [showOnWebsite, setShowOnWebsite] = useState(record.data.show_on_website === true);
  const [pitch, setPitch] = useState(asString(record.data.sales_pitch) ?? '');
  const [objection, setObjection] = useState(asString(record.data.objection_handling_notes) ?? '');
  const [commission, setCommission] = useState(asString(record.data.commission_notes) ?? '');
  const [notes, setNotes] = useState(asString(record.data.portfolio_notes) ?? '');
  const [busy, setBusy] = useState(false);
  const sel = 'form-input text-sm';
  const save = async () => {
    setBusy(true);
    try {
      await onSave({
        portfolio_status: status || null,
        sales_priority: priority || null,
        exclusive_status: exclusive || null,
        website_display_order: order === '' ? null : Number(order),
        show_on_website: showOnWebsite,
        sales_pitch: pitch || null,
        objection_handling_notes: objection || null,
        commission_notes: commission || null,
        portfolio_notes: notes || null,
      });
    } finally { setBusy(false); }
  };
  const drop = (label: string, val: string, set: (v: string) => void, f: import('@/types').ModelField | undefined) => (
    <label className="text-sm"><span className="text-charcoal/60 block mb-1">{label}</span>
      <select className={sel} value={val} onChange={(e) => set(e.target.value)}>
        <option value="">—</option>
        {(f?.options ?? []).map((o) => <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>)}
      </select>
    </label>
  );
  const area = (label: string, val: string, set: (v: string) => void) => (
    <label className="text-sm block"><span className="text-charcoal/60 block mb-1">{label}</span>
      <textarea className={sel} rows={3} value={val} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <div className="card p-4 max-w-2xl space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {drop(isAr ? 'حالة المحفظة' : 'Portfolio status', status, setStatus, statusField)}
        {drop(isAr ? 'أولوية المبيعات' : 'Sales priority', priority, setPriority, priorityField)}
        {drop(isAr ? 'حالة الحصرية' : 'Exclusive status', exclusive, setExclusive, exclusiveField)}
      </div>
      <div className="grid grid-cols-2 gap-3 items-end">
        <label className="text-sm"><span className="text-charcoal/60 block mb-1">{isAr ? 'ترتيب العرض على الموقع' : 'Website display order'}</span>
          <input className={sel} type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-charcoal/70 pb-2">
          <input type="checkbox" checked={showOnWebsite} onChange={(e) => setShowOnWebsite(e.target.checked)} className="rounded border-sand text-copper focus:ring-copper/30" />
          {showOnWebsite ? <Eye size={14} /> : <EyeOff size={14} />} {isAr ? 'عرض على الموقع' : 'Show on website'}
        </label>
      </div>
      {area(isAr ? 'عرض البيع' : 'Sales pitch', pitch, setPitch)}
      {area(isAr ? 'التعامل مع الاعتراضات' : 'Objection handling', objection, setObjection)}
      {area(isAr ? 'ملاحظات العمولة' : 'Commission notes', commission, setCommission)}
      {area(isAr ? 'ملاحظات المحفظة' : 'Portfolio notes', notes, setNotes)}
      <p className="text-xs text-charcoal/40">{isAr ? 'صورة الغلاف البديلة تُحرَّر من النموذج الكامل.' : 'Hero image override is edited in the full form.'}</p>
      <Button variant="primary" onClick={save} disabled={busy}>{busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}</Button>
    </div>
  );
}

function DataQualityTab({ view, record, isAr }: { view: ProjectView; record: import('@/types').AppRecord; isAr: boolean }) {
  const audit = auditProject(view, isAr);
  const tone = audit.score >= 80 ? '#10B981' : audit.score >= 50 ? '#F59E0B' : '#EF4444';
  const List = ({ title, items, icon }: { title: string; items: string[]; icon: React.ReactNode }) => (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 font-bold text-charcoal mb-2 text-sm">{icon} {title}</div>
      {items.length === 0 ? <p className="text-sm text-green-600">{isAr ? 'لا شيء' : 'None'}</p> : (
        <ul className="text-sm text-charcoal/70 space-y-1">{items.map((x, i) => <li key={i} className="flex items-center gap-1.5"><span className="w-1 h-1 rounded-full bg-charcoal/40" /> {x}</li>)}</ul>
      )}
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="card p-4 text-center w-32">
          <div className="text-3xl font-bold" style={{ color: tone }}>{audit.score}</div>
          <div className="text-xs text-charcoal/50">{isAr ? 'درجة الجودة' : 'Quality score'}</div>
        </div>
        <div className="text-sm text-charcoal/60 space-y-1">
          <div>{isAr ? 'درجة الثقة المسجلة: ' : 'Recorded confidence: '}{view.dataConfidence ?? (isAr ? 'غير متوفر' : 'N/A')}</div>
          <div>{isAr ? 'آخر تحقق: ' : 'Last verified: '}{asString(record.data.last_verified_at) ?? (isAr ? 'غير متوفر' : 'N/A')}</div>
        </div>
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <List title={isAr ? 'حقول مطلوبة ناقصة' : 'Required missing'} items={audit.requiredMissing} icon={<AlertTriangle size={14} className="text-red-500" />} />
        <List title={isAr ? 'حقول اختيارية ناقصة' : 'Optional missing'} items={audit.optionalMissing} icon={<AlertTriangle size={14} className="text-amber-500" />} />
        <List title={isAr ? 'يمنع النشر على الموقع' : 'Blocks website publish'} items={audit.blockingWebsite} icon={<AlertTriangle size={14} className="text-red-500" />} />
        <List title={isAr ? 'يمنع المطابقة' : 'Blocks matching'} items={audit.blockingMatching} icon={<CheckCircle2 size={14} className="text-copper" />} />
      </div>
    </div>
  );
}
