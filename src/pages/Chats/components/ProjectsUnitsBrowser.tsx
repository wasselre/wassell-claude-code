import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Building2, Check, ExternalLink, ListPlus, Loader2,
  Map as MapIcon, MapPin, Rows3, Search, SlidersHorizontal, Send, X,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useApplyViewScope } from '@/hooks/usePermission';
import { normalizeForSearch } from '@/lib/recordSearch';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import {
  modelByName, fieldByCandidates, resolveProjectView, formatPriceRange, formatRange,
  rollupByKind, asRange, type ProjectView, type NumericRange,
} from '@/lib/projects/projectView';
import { useSignedImage } from '@/lib/projects/useSignedImage';
import { saveProjectToClient } from '@/lib/matching/saveUnitOption';
import { recordTitle } from '@/lib/documents/links';
import { normalizePhone } from '@/lib/phone';
import { chatPdfFromClient, type ChatPdfContext } from '@/lib/projects/sendPdfToChat';
import Badge from '@/components/ui/Badge';
import DualRangeSlider from '@/components/ui/DualRangeSlider';
import BaseMapView, { type MapPin as MapPinData } from '@/components/map/BaseMapView';
import { buildColoredPinIcon } from '@/lib/locationUtils';
import UnitsInventory from '@/pages/Projects/components/UnitsInventory';
import ProjectWhatsAppFlow from '@/pages/Followups/components/ProjectWhatsAppFlow';
import BulkProjectSendFlow, { type BulkRecipientInput } from '@/pages/Chats/components/BulkProjectSendFlow';
import { recordToPickedClient, resolveClientSlugs } from '@/pages/Chats/components/ClientPicker';
import type { AppModel, AppRecord } from '@/types';

/**
 * PROJECTS & UNITS BROWSER — the catalogue, inside the conversation.
 *
 * A slide-over SHEET (not a page, not a centered modal) that a rep opens from
 * the WhatsApp thread to browse every `all_projects` record and drill into that
 * project's `units` inventory while the client is still talking. It is a plain
 * overlay sibling of the conversation, so NOTHING about the chat unmounts:
 * the thread keeps its scroll position, its Realtime subscription, and the
 * composer keeps whatever the rep had typed.
 *
 * Why a side sheet rather than a centered popup (the ClientOptionsModal shape):
 *   • On desktop it takes the inline-END edge (right in LTR, left in RTL) and
 *     leaves the conversation readable behind it — the rep is answering "do you
 *     have anything in حي النرجس under 1.2M?" and needs to re-read the question
 *     while scanning the list. A centered popup hides the thread.
 *   • On a phone (where the chats page is already single-pane) it goes
 *     full-screen with its own back/close, so it degrades to exactly the
 *     full-screen surface a small viewport needs.
 *
 * NOTHING here is a new catalogue: projects resolve through the SAME pure
 * `resolveProjectView` the Projects pages use (stored rollups, never
 * recomputed), and the unit table is the SAME `UnitsInventory` component from
 * the project detail page (filters, sort, unit drawer, compare). Actions reuse
 * the existing paths too — `ProjectWhatsAppFlow` for "send this project" and
 * `saveProjectToClient` (the unified Client Property Options engine, same as the
 * Project Finder + the unit save) for "save to the client's options".
 *
 * z-index: the sheet sits at z-40, deliberately BELOW the 50/55/60 modal tiers,
 * so everything it launches (UnitsInventory's unit drawer + compare modal at
 * z-50, ProjectWhatsAppFlow at z-60) stacks correctly above it.
 */

interface Props {
  /**
   * The conversation's linked client, when there is one. Present → the rep can
   * send a project to this client or save it to their options. Absent (an
   * unlinked number) → the sheet is browse-only; nothing else changes.
   */
  clientId?: string | null;
  /**
   * The conversation's wid. Present → the units-table and single-unit PDFs can
   * be SENT to this chat's client (not just downloaded). Absent → download-only.
   */
  chatWid?: string | null;
  /** Close the sheet (the caller owns the open/closed flag). */
  onClose: () => void;
}

/** How many rows render before "show more" — keeps a 1,000-project list cheap on a phone. */
const PAGE = 60;

export default function ProjectsUnitsBrowser({ clientId, chatWid, onClose }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const projectsModel = useMemo(() => modelByName(models, 'all_projects'), [models]);
  const rawProjects = useMemo(
    () => (projectsModel ? records[projectsModel.id] ?? [] : []),
    [projectsModel, records],
  );
  // Respect the rep's view scope — the browser must never widen what they can see.
  const scopedProjects = useApplyViewScope(projectsModel ?? null, rawProjects);

  // `resolveProjectView` reads the projects themselves plus the cities /
  // districts / developers lookups. Depend on THOSE array identities rather
  // than the whole `records` map: this sheet lives on the chats page, where
  // `records` gets a new identity on every inbound WhatsApp message, and
  // re-resolving ~1,000 projects on each one would visibly jank the list.
  const lookupIds = useMemo(
    () => ({
      cities: modelByName(models, 'cities')?.id ?? '',
      districts: modelByName(models, 'districts')?.id ?? '',
      developers: modelByName(models, 'developers')?.id ?? '',
    }),
    [models],
  );
  const cityRecords = records[lookupIds.cities];
  const districtRecords = records[lookupIds.districts];
  const developerRecords = records[lookupIds.developers];

  const translationVersion = useRecordTranslationVersion();
  const views: ProjectView[] = useMemo(
    () => scopedProjects.map((r) => resolveProjectView({ models, records }, r, { isAr, translate: getEntityFieldText })),
    // translationVersion: re-resolve names/geo once translations hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopedProjects, models, isAr, translationVersion, cityRecords, districtRecords, developerRecords],
  );

  // all_projects ids that our sales portfolio (our_projects) points at. Keyed on
  // the our_projects array identity for the same reason as `views` above.
  const ourModel = useMemo(() => modelByName(models, 'our_projects'), [models]);
  const ourRecords = ourModel ? records[ourModel.id] : undefined;
  const ourProjectIds = useMemo(() => {
    const linkField = fieldByCandidates(ourModel, ['project']);
    const out = new Set<string>();
    if (!linkField) return out;
    for (const r of ourRecords ?? []) {
      const v = (r.data as Record<string, unknown>)[linkField.name];
      if (Array.isArray(v)) v.forEach((x) => { if (typeof x === 'string') out.add(x); });
      else if (typeof v === 'string' && v) out.add(v);
    }
    return out;
  }, [ourModel, ourRecords]);

  // The chat's client, resolved here so the caller only passes an id.
  const clientsModel = useMemo(() => modelByName(models, 'clients') ?? null, [models]);
  const clientRec = useMemo<AppRecord | null>(() => {
    if (!clientId || !clientsModel) return null;
    return (records[clientsModel.id] ?? []).find((r) => r.id === clientId) ?? null;
  }, [clientId, clientsModel, records]);

  // Chat send-context for the units/unit PDFs. Prefer the REAL conversation wid
  // when the sheet was opened from a chat; otherwise (opened from the Client
  // Options popup's "Browse" with no chatWid) derive the conversation from the
  // client's phone so the rep can still SEND, not just download.
  const chatPdf = useMemo<ChatPdfContext | null>(() => {
    if (chatWid) {
      return {
        chatWid,
        clientName: clientRec && clientsModel ? recordTitle(clientsModel, clientRec, isAr) : null,
        clientPhone: clientRec
          ? normalizePhone(String((clientRec.data as Record<string, unknown>).phone_number ?? '')) || null
          : null,
      };
    }
    return chatPdfFromClient(clientRec);
  }, [chatWid, clientRec, clientsModel, isAr]);

  // Recipient for a bulk send: the open conversation when we have its wid, else
  // the linked client (a new conversation is established on the first send).
  // Null → no client context, so bulk send is not offered (browse-only).
  const bulkRecipient = useMemo<BulkRecipientInput | null>(() => {
    const label = clientRec && clientsModel ? recordTitle(clientsModel, clientRec, isAr) : undefined;
    if (chatWid) return { kind: 'chat', chatWid, label };
    if (clientRec && clientsModel) {
      return { kind: 'client', client: recordToPickedClient(clientRec, resolveClientSlugs(clientsModel), isAr) };
    }
    return null;
  }, [chatWid, clientRec, clientsModel, isAr]);
  const toggleBulk = (id: string) =>
    setBulkSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // ── filters ───────────────────────────────────────────────────────────────
  // This browser is OUR-projects only — in a chat the rep is always picking
  // something of ours to send the client (no all/targeted scopes).
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [search, setSearch] = useState('');
  const [city, setCity] = useState('');
  const [district, setDistrict] = useState('');
  const [unitType, setUnitType] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const cities = useMemo(
    () => [...new Set(views.map((v) => v.city).filter((x): x is string => !!x))].sort(),
    [views],
  );
  const districts = useMemo(
    () => [...new Set(views.filter((v) => !city || v.city === city).map((v) => v.district).filter((x): x is string => !!x))].sort(),
    [views, city],
  );
  const unitTypeField = useMemo(() => fieldByCandidates(projectsModel, ['unit_types', 'unit_type']), [projectsModel]);

  // Price bounds for the range slider — spanning every visible project's range.
  const priceBounds = useMemo(() => {
    const all: number[] = [];
    for (const v of views) {
      const r = priceRangeFor(v, projectsModel);
      if (r?.min != null && Number.isFinite(r.min)) all.push(r.min);
      if (r?.max != null && Number.isFinite(r.max)) all.push(r.max);
    }
    return all.length ? { min: Math.min(...all), max: Math.max(...all) } : null;
  }, [views, projectsModel]);

  const filtered = useMemo(() => {
    // Arabic-folded search (أإآ→ا, ة→ه, ى→ي, unified digits) — the SAME folding
    // the rest of the app searches with, so «النرجس» matches «النرجس».
    const q = normalizeForSearch(search.trim());
    const pMin = priceMin ? Number(priceMin) : null;
    const pMax = priceMax ? Number(priceMax) : null;
    const out = views.filter((v) => {
      // OUR projects only — this is the send-to-client catalogue.
      if (!ourProjectIds.has(v.id)) return false;
      if (city && v.city !== city) return false;
      if (district && v.district !== district) return false;
      if (unitType && !v.unitTypes.some((u) => u.value === unitType)) return false;
      if (availableOnly && (v.availableUnits ?? 0) <= 0) return false;
      const range = priceRangeFor(v, projectsModel);
      if (pMin !== null && (range?.max ?? Infinity) < pMin) return false;
      if (pMax !== null && (range?.min ?? 0) > pMax) return false;
      if (q) {
        const hay = normalizeForSearch(
          `${v.name ?? ''} ${v.developer ?? ''} ${v.city ?? ''} ${v.district ?? ''} ${v.projectId ?? ''}`,
        );
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Sellable stock first, then alphabetical — a rep scanning for something to
    // offer wants projects that still have units at the top.
    return out.sort((a, b) => {
      const d = (b.availableUnits ?? 0) - (a.availableUnits ?? 0);
      if (d !== 0) return d;
      return (a.name ?? '').localeCompare(b.name ?? '', isAr ? 'ar' : 'en');
    });
  }, [views, ourProjectIds, city, district, unitType, availableOnly, priceMin, priceMax, search, projectsModel, isAr]);

  // Reset paging whenever the result set changes shape.
  useEffect(() => { setLimit(PAGE); }, [search, city, district, unitType, availableOnly, priceMin, priceMax]);

  // ── drill-down ────────────────────────────────────────────────────────────
  // Hold the project ID (not the resolved view) so a live record update — a
  // rollup recomputed after a unit changes — keeps the open panel current.
  const [openId, setOpenId] = useState<string | null>(null);
  const openView = useMemo(() => (openId ? views.find((v) => v.id === openId) ?? null : null), [views, openId]);
  const [sendTarget, setSendTarget] = useState<{ id: string; name: string } | null>(null);
  // Bulk send: multi-select several projects and send them to this client in
  // order (text → PDF → pictures per project, one project at a time).
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSel, setBulkSel] = useState<Set<string>>(new Set());
  const [bulkFlow, setBulkFlow] = useState(false);
  const [addState, setAddState] = useState<'idle' | 'saving' | 'added'>('idle');
  // On opening a project, reflect whether it's ALREADY a (non-eliminated) option
  // for this client, so a saved project shows "In options" instead of "Add".
  // Keyed on openId only (not records) so an unrelated inbound message can't
  // clobber the 'saving' state mid-write; addToOptions owns the post-click state.
  useEffect(() => {
    if (!clientId || !openId) { setAddState('idle'); return; }
    const m = modelByName(models, 'client_property_options');
    const rec = m
      ? (records[m.id] ?? []).find(
          (r) => r.data.client_id === clientId && r.data.source_type === 'project' && r.data.source_id === openId,
        )
      : undefined;
    const st = rec ? String(rec.data.status) : null;
    setAddState(st && st !== 'eliminated' ? 'added' : 'idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  // Esc: back to the list from a project, else close the sheet. Ignored while a
  // stacked flow owns the screen (the send flow has its own dismissal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || sendTarget) return;
      if (openId) setOpenId(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, sendTarget, onClose]);

  const addToOptions = async (v: ProjectView) => {
    if (!clientId) return;
    setAddState('saving');
    // Unified path: writes to the client's Client Property Options (same engine
    // as the Project Finder + the unit save), so it shows in the Client Options
    // tab — replacing the old preferred_projects lookup write.
    const res = await saveProjectToClient(clientId, v.raw);
    if (res.outcome === 'created') {
      setAddState('added');
      addToast(L('أُضيف المشروع إلى خيارات العميل', 'Added to the client’s options'), 'success');
    } else if (res.outcome === 'updated') {
      setAddState('added');
      addToast(L('المشروع موجود مسبقاً ضمن خيارات العميل', 'Already in the client’s options'), 'info');
    } else if (res.outcome === 'queued') {
      setAddState('added');
      addToast(L('تعذر الحفظ الآن — سيُعاد الإرسال تلقائياً', 'Saved offline — it will sync automatically'), 'info');
    } else if (res.outcome === 'eliminated_exists') {
      setAddState('idle');
      addToast(L('هذا المشروع مستبعد سابقاً لهذا العميل — أعِد تفعيله من قائمة الخيارات.', 'This project was eliminated for this client — reactivate it from the options list.'), 'error');
    } else {
      // conflict / error — the store already surfaced the Supabase failure; this
      // toast tells the rep what THEIR action did, per the fail-loudly rule.
      setAddState('idle');
      addToast(
        res.outcome === 'conflict'
          ? L('تم تعديل بطاقة العميل من مكان آخر — حدّث الصفحة وأعد المحاولة', 'The client was edited elsewhere — reload and retry')
          : L('تعذر إضافة المشروع لخيارات العميل', 'Could not add the project to the client’s options'),
        'error',
      );
    }
  };

  const BackIcon = isAr ? ArrowRight : ArrowLeft;
  const selectCls = 'form-input text-sm py-1.5';

  return (
    <div
      className="fixed inset-0 z-40 flex"
      dir={isAr ? 'rtl' : 'ltr'}
      role="dialog"
      aria-modal="true"
      aria-label={L('تصفح المشاريع والوحدات', 'Browse projects and units')}
    >
      {/* Scrim — lighter on desktop so the conversation stays legible behind it. */}
      <button
        type="button"
        onClick={onClose}
        aria-label={L('إغلاق', 'Close')}
        className="absolute inset-0 bg-charcoal/40 md:bg-charcoal/15"
      />

      {/* The sheet: full-screen on a phone, inline-end panel from md up. */}
      <div className="relative ms-auto flex h-full w-full flex-col overflow-hidden border-s border-sand/40 bg-cream shadow-2xl md:w-[600px] md:max-w-[92vw] lg:w-[680px]">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-sand/40 bg-white px-3 py-2.5">
          {openView ? (
            <button
              type="button"
              onClick={() => setOpenId(null)}
              className="shrink-0 rounded-lg p-1.5 text-charcoal/60 transition-colors hover:bg-cream hover:text-copper"
              aria-label={L('رجوع للقائمة', 'Back to the list')}
            >
              <BackIcon size={18} />
            </button>
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-copper/10">
              <Building2 size={18} className="text-copper" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-chocolate">
              {openView ? (openView.name ?? L('مشروع', 'Project')) : L('المشاريع والوحدات', 'Projects & units')}
            </h2>
            <p className="truncate text-[11px] text-charcoal/60">
              {openView
                ? [openView.district, openView.city].filter(Boolean).join(isAr ? '، ' : ', ') || L('موقع غير محدد', 'No location')
                : L('تصفّح بدون مغادرة المحادثة', 'Browse without leaving the conversation')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-charcoal/50 transition-colors hover:bg-cream hover:text-charcoal"
            aria-label={L('إغلاق', 'Close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        {!projectsModel ? (
          <div className="p-6 text-sm text-charcoal/55">{L('نموذج المشاريع غير محمّل.', 'The projects model is not loaded.')}</div>
        ) : openView ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <ProjectDetail
              v={openView}
              isAr={isAr}
              model={projectsModel}
              canAct={!!clientRec}
              addState={addState}
              chatPdf={chatPdf}
              clientId={clientRec ? clientId ?? null : null}
              onSend={() => setSendTarget({ id: openView.id, name: openView.name ?? '' })}
              onAdd={() => void addToOptions(openView)}
            />
          </div>
        ) : (
          <>
            {/* Search + view toggle + filters */}
            <div className="shrink-0 space-y-2 border-b border-sand/40 bg-white px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search size={15} className="absolute top-1/2 start-2.5 -translate-y-1/2 text-charcoal/40" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={L('ابحث باسم المشروع أو المطور أو الحي…', 'Search by project, developer, district…')}
                    className="form-input w-full ps-8 text-sm"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowFilters((f) => !f)}
                  aria-expanded={showFilters}
                  className={`shrink-0 rounded-lg border p-2 transition-colors ${
                    showFilters ? 'border-copper/40 bg-copper/10 text-copper' : 'border-sand text-charcoal/60 hover:bg-cream'
                  }`}
                  title={L('عوامل التصفية', 'Filters')}
                >
                  <SlidersHorizontal size={16} />
                </button>
              </div>

              <div className="flex items-center gap-1">
                {/* List / Map view toggle — the catalogue is always our projects. */}
                <div className="inline-flex overflow-hidden rounded-full border border-sand">
                  {(['list', 'map'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => { setViewMode(m); if (m === 'map') { setBulkMode(false); setBulkSel(new Set()); } }}
                      aria-pressed={viewMode === m}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium transition-colors ${
                        viewMode === m ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream'
                      }`}
                    >
                      {m === 'list' ? <Rows3 size={13} /> : <MapIcon size={13} />}
                      {m === 'list' ? L('قائمة', 'List') : L('خريطة', 'Map')}
                    </button>
                  ))}
                </div>
                <span className="ms-auto text-[11px] text-charcoal/50">
                  {L(`${filtered.length} مشروع`, `${filtered.length} projects`)}
                </span>
                {bulkRecipient && viewMode === 'list' && (
                  <button
                    type="button"
                    onClick={() => { setBulkMode((m) => !m); setBulkSel(new Set()); }}
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                      bulkMode ? 'bg-copper text-white' : 'bg-cream text-charcoal/70 hover:bg-sand/40'
                    }`}
                    title={L('تحديد عدة مشاريع للإرسال', 'Select several projects to send')}
                  >
                    <ListPlus size={13} className="inline -mt-0.5 me-1" />
                    {bulkMode ? L('إلغاء التحديد', 'Cancel') : L('إرسال متعدد', 'Bulk send')}
                  </button>
                )}
              </div>

              {showFilters && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <select className={selectCls} value={city} onChange={(e) => { setCity(e.target.value); setDistrict(''); }}>
                    <option value="">{L('كل المدن', 'All cities')}</option>
                    {cities.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select className={selectCls} value={district} onChange={(e) => setDistrict(e.target.value)}>
                    <option value="">{L('كل الأحياء', 'All districts')}</option>
                    {districts.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <select className={`${selectCls} col-span-2`} value={unitType} onChange={(e) => setUnitType(e.target.value)}>
                    <option value="">{L('كل أنواع الوحدات', 'All unit types')}</option>
                    {(unitTypeField?.options ?? []).map((o) => (
                      <option key={o.id} value={o.value}>{isAr ? o.label_ar : o.label_en}</option>
                    ))}
                  </select>
                  {priceBounds && priceBounds.max > priceBounds.min ? (
                    <div className="col-span-2 px-1 pt-1">
                      <DualRangeSlider
                        className="w-full"
                        isAr={isAr}
                        label={L('السعر (ر.س)', 'Price (SAR)')}
                        min={priceBounds.min}
                        max={priceBounds.max}
                        step={5000}
                        low={priceMin ? Number(priceMin) : priceBounds.min}
                        high={priceMax ? Number(priceMax) : priceBounds.max}
                        format={(n) => Math.round(n).toLocaleString('en-US')}
                        onChange={(lo, hi) => {
                          setPriceMin(lo <= priceBounds.min ? '' : String(Math.round(lo)));
                          setPriceMax(hi >= priceBounds.max ? '' : String(Math.round(hi)));
                        }}
                      />
                    </div>
                  ) : null}
                  <label className="col-span-2 flex items-center gap-2 px-1 text-sm text-charcoal/70">
                    <input
                      type="checkbox"
                      checked={availableOnly}
                      onChange={(e) => setAvailableOnly(e.target.checked)}
                      className="rounded border-sand text-copper focus:ring-copper/30"
                    />
                    {L('التي بها وحدات متاحة فقط', 'Only projects with available units')}
                  </label>
                </div>
              )}
            </div>

            {/* Results — list or map (same filtered our-projects set). */}
            {viewMode === 'map' ? (
              <div className="min-h-0 flex-1 p-3">
                <ProjectsMapPanel
                  views={filtered}
                  isAr={isAr}
                  model={projectsModel}
                  onOpen={(id) => setOpenId(id)}
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {filtered.length === 0 ? (
                  <div className="rounded-2xl border border-sand/40 bg-white p-8 text-center text-sm text-charcoal/50">
                    {L('لا توجد مشاريع مطابقة.', 'No matching projects.')}
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      {filtered.slice(0, limit).map((v) => (
                        <ProjectRow
                          key={v.id}
                          v={v}
                          isAr={isAr}
                          model={projectsModel}
                          onOpen={() => setOpenId(v.id)}
                          selectable={bulkMode}
                          selected={bulkSel.has(v.id)}
                          onToggleSelect={() => toggleBulk(v.id)}
                        />
                      ))}
                    </div>
                    {filtered.length > limit && (
                      <button
                        type="button"
                        onClick={() => setLimit((n) => n + PAGE)}
                        className="mt-3 w-full rounded-xl border border-sand bg-white py-2 text-sm font-medium text-copper transition-colors hover:bg-cream"
                      >
                        {L(`عرض المزيد (${filtered.length - limit} متبقية)`, `Show more (${filtered.length - limit} left)`)}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Bulk action bar — send the selected projects to this client in order. */}
            {bulkMode && viewMode === 'list' && (
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-sand/40 bg-white px-3 py-2.5">
                <span className="text-xs text-charcoal/60">
                  {L(`${bulkSel.size} محدد`, `${bulkSel.size} selected`)}
                </span>
                <button
                  type="button"
                  disabled={bulkSel.size === 0}
                  onClick={() => setBulkFlow(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-terracotta disabled:opacity-40"
                >
                  <Send size={14} />
                  {L(`إرسال ${bulkSel.size} مشروع`, `Send ${bulkSel.size} project${bulkSel.size === 1 ? '' : 's'}`)}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* "WhatsApp this project" — the SAME flow the Project Finder and the
          client-options cards use: reuse the stored chat_templates message or
          generate + approve one, then open the composer for this client. */}
      {sendTarget && clientRec && (
        <ProjectWhatsAppFlow
          isAr={isAr}
          projectId={sendTarget.id}
          projectName={sendTarget.name}
          clientRec={clientRec}
          onClose={() => setSendTarget(null)}
        />
      )}

      {/* Bulk send — several selected projects to this client, in order. */}
      {bulkFlow && bulkRecipient && (
        <BulkProjectSendFlow
          isAr={isAr}
          projectIds={filtered.filter((v) => bulkSel.has(v.id)).map((v) => v.id)}
          recipient={bulkRecipient}
          onClose={() => { setBulkFlow(false); setBulkMode(false); setBulkSel(new Set()); }}
        />
      )}
    </div>
  );
}

/**
 * Drop-in header chip that owns the sheet's open state — the whole feature in
 * ONE tag, so mounting it in the conversation header is a single line:
 *
 *     <ProjectsUnitsBrowserButton clientId={clientLinkId} />
 *
 * Styled like the header's other chips (client options / log interaction). Safe
 * on an unlinked chat: `clientId` is optional and the sheet just drops the
 * send / add-to-options actions.
 */
export function ProjectsUnitsBrowserButton({ clientId }: { clientId?: string | null }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-full border border-copper/30 bg-copper/5 px-2 py-0.5 font-medium text-copper transition-colors hover:bg-copper/10"
        title={
          isAr
            ? 'تصفح المشاريع والوحدات دون مغادرة المحادثة'
            : 'Browse projects and units without leaving the conversation'
        }
      >
        <Building2 size={12} />
        {isAr ? 'المشاريع والوحدات' : 'Projects & units'}
      </button>
      {open && <ProjectsUnitsBrowser clientId={clientId} onClose={() => setOpen(false)} />}
    </>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * Price to show for a project. Prefers the AVAILABLE-units range (the family a
 * customer can actually buy — see CLAUDE.md "Persisted project rollups"), and
 * falls back to the all-units range only so an internal browser still says
 * something about a fully sold/reserved project. Both are STORED rollups; this
 * never recomputes them.
 */
function priceRangeFor(v: ProjectView, model: AppModel | undefined): NumericRange | null {
  const available = asRange(rollupByKind(model, (v.raw.data ?? {}) as Record<string, unknown>, 'available_price_range'));
  return available ?? v.priceRange;
}

function isAvailablePrice(v: ProjectView, model: AppModel | undefined): boolean {
  return asRange(rollupByKind(model, (v.raw.data ?? {}) as Record<string, unknown>, 'available_price_range')) !== null;
}

/** A finite, non-zero coordinate — 0/0 and blanks mean "no location". */
function asCoord(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/**
 * MAP view for the browser — our projects plotted on the SAME shared BaseMapView
 * the Project Finder and Client Options maps use (clustering, the full-view
 * button, the layers overlay all come for free). Every pin is copper (this
 * catalogue is our-projects only), and clicking one shows a compact card with an
 * "open project" action that drills into the same ProjectDetail as a list row.
 */
function ProjectsMapPanel({
  views, isAr, model, onOpen,
}: {
  views: ProjectView[];
  isAr: boolean;
  model: AppModel | undefined;
  onOpen: (id: string) => void;
}) {
  // One copper pin icon, reused across every marker.
  const icon = useMemo(() => buildColoredPinIcon('#B8734F') as google.maps.Icon | undefined, []);

  const pins = useMemo<MapPinData[]>(() => {
    const out: MapPinData[] = [];
    for (const v of views) {
      const data = (v.raw.data ?? {}) as Record<string, unknown>;
      const lat = asCoord(data.latitude);
      const lng = asCoord(data.longitude);
      if (lat == null || lng == null) continue;
      out.push({ id: v.id, lat, lng, icon, title: v.name ?? '' });
    }
    return out;
  }, [views, icon]);

  const byId = useMemo(() => new Map(views.map((v) => [v.id, v] as const)), [views]);

  return (
    <BaseMapView
      pins={pins}
      isAr={isAr}
      heightClass="min-h-0 flex-1"
      outerClassName="flex h-full flex-col overflow-hidden rounded-xl border border-sand/40 bg-white"
      stateBoxClassName="flex h-full flex-col items-center justify-center rounded-xl border border-sand/40 bg-white"
      cardMaxWidthClass="max-w-[320px]"
      mobileGreedy
      missingCount={views.length - pins.length}
      renderSelectedCard={(id) => {
        const v = byId.get(id);
        return v ? <MapPinCard v={v} isAr={isAr} model={model} onOpen={() => onOpen(id)} /> : null;
      }}
    />
  );
}

/** Compact card shown when a map pin is clicked — the essentials plus "open". */
function MapPinCard({
  v, isAr, model, onOpen,
}: {
  v: ProjectView;
  isAr: boolean;
  model: AppModel | undefined;
  onOpen: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const img = useSignedImage(v.imageRef);
  const price = formatPriceRange(priceRangeFor(v, model), isAr);
  const place = [v.district, v.city].filter(Boolean).join(isAr ? '، ' : ', ');

  return (
    <div className="bg-white">
      {img && <img src={img} alt="" className="h-24 w-full object-cover" loading="lazy" />}
      <div className="space-y-1 p-3">
        <div className="flex items-center gap-1.5 pe-6">
          <span className="truncate text-sm font-bold text-charcoal">{v.name ?? `#${v.id.slice(0, 8)}`}</span>
          {v.status && <Badge label={isAr ? v.status.label_ar : v.status.label_en} color={v.status.color ?? undefined} />}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-charcoal/55">
          <MapPin size={11} className="shrink-0" />
          <span className="truncate">{place || L('موقع غير محدد', 'No location')}</span>
        </div>
        {v.developer && <div className="truncate text-[11px] text-charcoal/40">{v.developer}</div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-0.5 text-[11px]">
          <span className="font-semibold text-charcoal">{price ?? L('السعر غير متوفر', 'Price N/A')}</span>
          <span className={(v.availableUnits ?? 0) > 0 ? 'text-emerald-700' : 'text-charcoal/40'}>
            {L(`متاح: ${v.availableUnits ?? 0}`, `Available: ${v.availableUnits ?? 0}`)}
          </span>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="mt-1.5 w-full rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-terracotta"
        >
          {L('فتح المشروع', 'Open project')}
        </button>
      </div>
    </div>
  );
}

/** One compact project row — sized for a 600px sheet and a phone. */
function ProjectRow({
  v, isAr, model, onOpen, selectable = false, selected = false, onToggleSelect,
}: {
  v: ProjectView;
  isAr: boolean;
  model: AppModel | undefined;
  onOpen: () => void;
  /** In bulk mode the row toggles selection instead of opening. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const img = useSignedImage(v.imageRef);
  const price = formatPriceRange(priceRangeFor(v, model), isAr);
  const place = [v.district, v.city].filter(Boolean).join(isAr ? '، ' : ', ');

  return (
    <button
      type="button"
      onClick={selectable ? onToggleSelect : onOpen}
      aria-pressed={selectable ? selected : undefined}
      className={`flex w-full items-stretch gap-3 overflow-hidden rounded-xl border bg-white p-2 text-start transition-colors ${
        selectable && selected
          ? 'border-copper ring-1 ring-copper/40 bg-copper/5'
          : 'border-sand/50 hover:border-copper/40 hover:bg-cream/50'
      }`}
    >
      {selectable && (
        <span
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${
            selected ? 'border-copper bg-copper text-white' : 'border-sand bg-white text-transparent'
          }`}
        >
          <Check size={13} />
        </span>
      )}
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-copper/20 to-terracotta/20">
        {img ? (
          <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <Building2 size={20} className="text-copper/40" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-bold text-charcoal">{v.name ?? `#${v.id.slice(0, 8)}`}</span>
          {v.status && <Badge label={isAr ? v.status.label_ar : v.status.label_en} color={v.status.color ?? undefined} />}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[11px] text-charcoal/55">
          <MapPin size={11} className="shrink-0" />
          <span className="truncate">{place || L('موقع غير محدد', 'No location')}</span>
        </div>
        {v.developer && <div className="truncate text-[11px] text-charcoal/40">{v.developer}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
          <span className="font-semibold text-charcoal">{price ?? L('السعر غير متوفر', 'Price N/A')}</span>
          <span className={(v.availableUnits ?? 0) > 0 ? 'text-emerald-700' : 'text-charcoal/40'}>
            {L(`متاح: ${v.availableUnits ?? 0}`, `Available: ${v.availableUnits ?? 0}`)}
          </span>
        </div>
      </div>
    </button>
  );
}

/** The opened project: facts, rep actions, then the real units inventory. */
function ProjectDetail({
  v, isAr, model, canAct, addState, chatPdf, clientId, onSend, onAdd,
}: {
  v: ProjectView;
  isAr: boolean;
  model: AppModel | undefined;
  canAct: boolean;
  addState: 'idle' | 'saving' | 'added';
  chatPdf: ChatPdfContext | null;
  clientId: string | null;
  onSend: () => void;
  onAdd: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const img = useSignedImage(v.imageRef);
  const price = formatPriceRange(priceRangeFor(v, model), isAr);
  const availablePrice = isAvailablePrice(v, model);
  const area = formatRange(v.areaRange, L('م²', 'm²'));

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-2xl border border-sand/50 bg-white">
        {img && <img src={img} alt="" className="h-36 w-full object-cover" loading="lazy" />}
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {v.status && <Badge label={isAr ? v.status.label_ar : v.status.label_en} color={v.status.color ?? undefined} />}
            {v.construction && (
              <Badge label={isAr ? v.construction.label_ar : v.construction.label_en} color={v.construction.color ?? '#C09B5F'} />
            )}
            {v.unitTypes.slice(0, 4).map((u) => (
              <span key={u.value} className="rounded border border-sand/50 bg-cream px-1.5 py-0.5 text-[11px] text-charcoal/60">
                {isAr ? u.label_ar : u.label_en}
              </span>
            ))}
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <Fact label={L('السعر', 'Price')} value={price} isAr={isAr}
              hint={price && !availablePrice ? L('لكل الوحدات (لا يوجد متاح)', 'All units (nothing available)') : null} />
            <Fact label={L('المساحة', 'Area')} value={area} isAr={isAr} />
            <Fact label={L('المطور', 'Developer')} value={v.developer} isAr={isAr} />
            <Fact
              label={L('الوحدات', 'Units')}
              value={
                v.unitCount === null
                  ? null
                  : L(
                      `${v.unitCount} (متاح ${v.availableUnits ?? 0} · محجوز ${v.reservedUnits ?? 0} · مباع ${v.soldUnits ?? 0})`,
                      `${v.unitCount} (${v.availableUnits ?? 0} available · ${v.reservedUnits ?? 0} reserved · ${v.soldUnits ?? 0} sold)`,
                    )
              }
              isAr={isAr}
            />
          </dl>

          <div className="flex flex-wrap items-center gap-2 border-t border-sand/40 pt-2">
            {canAct && (
              <>
                <button
                  type="button"
                  onClick={onSend}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-terracotta"
                >
                  <Send size={13} />
                  {L('إرسال للعميل', 'Send to client')}
                </button>
                <button
                  type="button"
                  onClick={onAdd}
                  disabled={addState !== 'idle'}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-copper/30 bg-copper/5 px-3 py-1.5 text-xs font-medium text-copper transition-colors hover:bg-copper/10 disabled:opacity-60"
                >
                  {addState === 'saving' ? <Loader2 size={13} className="animate-spin" /> : addState === 'added' ? <Check size={13} /> : <ListPlus size={13} />}
                  {addState === 'added' ? L('ضمن الخيارات', 'In options') : L('إضافة لخيارات العميل', 'Add to options')}
                </button>
              </>
            )}
            {/* NEW TAB on purpose — the conversation must stay exactly where it is. */}
            <a
              href={`/model/all_projects/${v.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-sand px-3 py-1.5 text-xs font-medium text-charcoal/70 transition-colors hover:bg-cream"
            >
              <ExternalLink size={13} />
              {L('الملف الكامل', 'Full record')}
            </a>
          </div>
        </div>
      </div>

      {/* The project's real inventory — same component as the project page:
          filters, sort, unit drawer, and compare. Its table scrolls
          horizontally inside the sheet on narrow viewports. */}
      <div>
        <h3 className="mb-2 text-sm font-bold text-chocolate">{L('الوحدات', 'Units')}</h3>
        <UnitsInventory projectId={v.id} projectName={v.name} isAr={isAr} project={v} chatPdf={chatPdf} clientId={clientId} />
      </div>
    </div>
  );
}

function Fact({ label, value, isAr, hint }: { label: string; value: string | null; isAr: boolean; hint?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-charcoal/45">{label}</dt>
      <dd className="truncate font-medium text-charcoal" title={value ?? undefined}>
        {value ?? (isAr ? 'غير متوفر' : 'N/A')}
        {hint && <span className="ms-1 font-normal text-[10px] text-charcoal/40">{hint}</span>}
      </dd>
    </div>
  );
}
