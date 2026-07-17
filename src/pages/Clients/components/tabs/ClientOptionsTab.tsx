import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ListChecks, Star, ExternalLink, XCircle, RotateCcw, Loader2, Building2, MapPin,
  Wallet, Ruler, BedDouble, Bath, PackageCheck, Pencil, Check, Filter, Plus, Compass, Send,
  LayoutList, Map as MapIcon, Search, ArrowUpDown, SlidersHorizontal,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  CLIENT_OPTION_STATUS_META, CLIENT_OPTION_SOURCE_META, CLIENT_OPTION_STATUS_ORDER,
  optionSourceUrl, setMainOption, updateOptionStatus, eliminateOption, reactivateOption,
  updateSalesNotes,
  type ClientOptionStatus, type ClientOptionSourceType, type ClientOptionData,
} from '@/lib/matching/clientOptions';
import { buildAssistantContext } from '@/lib/followups/assistantContext';
import ContactAdvertiserButton from '@/components/market/ContactAdvertiserButton';
import QualityBadge from '@/components/market/QualityBadge';
import AddOptionModal from '../AddOptionModal';
import ClientOptionsMapView from '../ClientOptionsMapView';
import ProjectWhatsAppFlow from '@/pages/Followups/components/ProjectWhatsAppFlow';
import ListingWhatsAppFlow from '@/components/matching/ListingWhatsAppFlow';

interface Props {
  client: AppRecord;
  isAr: boolean;
  canEdit: boolean;
  /** Opens the Project Finder scoped to this client ("find more options").
   *  Rendered as a button in the toolbar + empty state when provided. */
  onFindMore?: () => void;
}

const fmtNum = (n: number) => n.toLocaleString('en-US');

function fmtRange(v: unknown, unit: string): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return `${fmtNum(v)} ${unit}`.trim();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const min = typeof o.min === 'number' ? o.min : Number(o.min);
    const max = typeof o.max === 'number' ? o.max : Number(o.max);
    const hasMin = Number.isFinite(min);
    const hasMax = Number.isFinite(max);
    if (hasMin && hasMax) return min === max ? `${fmtNum(min)} ${unit}`.trim() : `${fmtNum(min)} – ${fmtNum(max)} ${unit}`.trim();
    if (hasMax) return `${fmtNum(max)} ${unit}`.trim();
    if (hasMin) return `${fmtNum(min)} ${unit}`.trim();
  }
  return null;
}

type OptionSortKey = 'best' | 'score' | 'price_asc' | 'price_desc' | 'area_desc' | 'newest';

const SORT_LABELS: Record<OptionSortKey, { ar: string; en: string }> = {
  best: { ar: 'الأفضل (الرئيسي ثم الحالة)', en: 'Best (main, then status)' },
  score: { ar: 'نسبة التطابق', en: 'Match score' },
  price_asc: { ar: 'السعر: من الأقل', en: 'Price: low to high' },
  price_desc: { ar: 'السعر: من الأعلى', en: 'Price: high to low' },
  area_desc: { ar: 'المساحة: الأكبر أولاً', en: 'Area: largest first' },
  newest: { ar: 'الأحدث إضافة', en: 'Newest added' },
};

/** A sortable number off a facts range ({min,max} or plain number); null when absent. */
function factRangeNum(r: AppRecord, key: 'price_range' | 'area_range', pick: 'min' | 'max'): number | null {
  const f = (r.data.facts ?? {}) as Record<string, unknown>;
  const v = f[key];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const primary = Number(o[pick]);
    if (Number.isFinite(primary) && primary > 0) return primary;
    const other = Number(o[pick === 'min' ? 'max' : 'min']);
    if (Number.isFinite(other) && other > 0) return other;
  }
  return null;
}

/** Ascending/descending compare with nulls always LAST regardless of direction. */
function cmpNullable(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * dir;
}

const UNIT_TYPE_AR: Record<string, string> = {
  apartment: 'شقة', apartments: 'شقة', flat: 'شقة', flats: 'شقة', penthouse: 'بنتهاوس',
  villa: 'فيلا', villas: 'فيلا', townhouse: 'تاون هاوس', townhouses: 'تاون هاوس',
  studio: 'استوديو', studios: 'استوديو', duplex: 'دوبلكس', duplexes: 'دوبلكس',
  floor: 'دور', floors: 'أدوار', land: 'أرض', lands: 'أرض', plot: 'أرض', plots: 'أرض',
};

/**
 * Client Options tab — the unified view of every property OPTION found for a
 * client (projects, units, market listings) in one place. Renders the saved
 * `client_property_options` records with their client-specific status, main-focus
 * flag, match score, snapshot facts, and notes, plus per-row actions (view
 * source, mark main, change status, eliminate, reactivate). Deterministic — no AI.
 *
 * Default view: active options first (eliminated hidden behind a toggle / sorted
 * last). Filter by status. A list/map toggle switches between the card list and
 * ClientOptionsMapView (same cards, opened from status-colored pins). The
 * preference INPUTS live on the Preferences tab and are never touched here —
 * this tab is the OUTPUT list, plus two ways to ADD to it: open the
 * client-scoped Project Finder, or manually pick a specific project / unit /
 * market listing (AddOptionModal, added_from='manual').
 */
export default function ClientOptionsTab({ client, isAr, canEdit, onFindMore }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const navigate = useNavigate();
  // "Find more options": hosts like ClientOptionsModal embed the finder in
  // place via onFindMore; otherwise fall back to the full-page client finder.
  const findMore = onFindMore ?? (() => navigate(`/model/clients/${client.id}/projects`));
  const records = useAppStore((s) => s.records);
  const models = useAppStore((s) => s.models);
  const addToast = useAppStore((s) => s.addToast);

  const modelId = useMemo(() => models.find((m) => m.name === 'client_property_options')?.id ?? null, [models]);
  const options = useMemo(
    () => (modelId ? (records[modelId] ?? []).filter((r) => r.data.client_id === client.id) : []),
    [records, modelId, client.id],
  );

  // Aqar ad id per market-listing option: newer saves snapshot it in
  // facts.external_id; older options fall back to the listing record in the
  // (slim, background-loaded) market_listings store slice.
  const marketModelId = useMemo(() => models.find((m) => m.name === 'market_listings')?.id ?? null, [models]);
  const externalIdBySourceId = useMemo(() => {
    const map = new Map<string, string>();
    if (!marketModelId) return map;
    const need = new Set<string>();
    for (const r of options) {
      const d = r.data as Record<string, unknown>;
      if (d.source_type !== 'market_listing') continue;
      const facts = (d.facts ?? {}) as Record<string, unknown>;
      if (typeof facts.external_id === 'string' && facts.external_id) continue;
      if (typeof d.source_id === 'string' && d.source_id) need.add(d.source_id);
    }
    if (need.size === 0) return map;
    for (const r of records[marketModelId] ?? []) {
      if (!need.has(r.id)) continue;
      const e = (r.data as Record<string, unknown>).external_id;
      if (typeof e === 'string' && e) map.set(r.id, e);
    }
    return map;
  }, [options, records, marketModelId]);

  // Listing quality (grade + score) per market-listing option: newer saves
  // snapshot it in facts.quality_grade (finder plumbing added 2026-07-02);
  // options saved before then have no grade in their snapshot, so we fall back
  // to the live listing record in the (slim) market_listings store — the DB
  // trigger keeps quality_grade/quality_score on every row and both keys ride
  // the slim store. Same fallback shape as the ad-id map above.
  const qualityBySourceId = useMemo(() => {
    const map = new Map<string, { grade: string; score: number | null }>();
    if (!marketModelId) return map;
    const need = new Set<string>();
    for (const r of options) {
      const d = r.data as Record<string, unknown>;
      if (d.source_type !== 'market_listing') continue;
      const facts = (d.facts ?? {}) as Record<string, unknown>;
      if (typeof facts.quality_grade === 'string' && facts.quality_grade) continue;
      if (typeof d.source_id === 'string' && d.source_id) need.add(d.source_id);
    }
    if (need.size === 0) return map;
    for (const r of records[marketModelId] ?? []) {
      if (!need.has(r.id)) continue;
      const data = r.data as Record<string, unknown>;
      const g = data.quality_grade;
      if (typeof g === 'string' && g) {
        const s = data.quality_score;
        map.set(r.id, { grade: g, score: typeof s === 'number' && Number.isFinite(s) ? s : null });
      }
    }
    return map;
  }, [options, records, marketModelId]);

  const [statusFilter, setStatusFilter] = useState<ClientOptionStatus | 'all'>('all');
  const [showEliminated, setShowEliminated] = useState(false);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | ClientOptionSourceType>('all');
  const [sortKey, setSortKey] = useState<OptionSortKey>('best');

  // Client preference chips — resolved by the SAME helper the finder's chips
  // use (buildAssistantContext, saved record only — no draft here), plus a
  // bedrooms chip its shared PREF_FIELDS list doesn't cover.
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const geoNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const name of ['districts', 'cities']) {
      const m = models.find((mm) => mm.name === name);
      if (!m) continue;
      for (const r of records[m.id] ?? []) {
        const dn = (r.data?.display_name ?? r.data?.name_ar ?? r.data?.name_en) as unknown;
        if (typeof dn === 'string' && dn.trim()) map[r.id] = dn.trim();
      }
    }
    return map;
  }, [models, records]);
  const prefChips = useMemo(() => {
    const ctx = buildAssistantContext({
      clientsModel,
      prefDraft: {},
      savedClientData: (client.data as Record<string, unknown>) ?? null,
      followupDraft: {},
      geoNames,
      isAr,
    });
    const chips = [...ctx.used];
    const pb = (client.data as Record<string, unknown>).preferred_bedrooms;
    let bedVal: string | null = null;
    if (typeof pb === 'number' && pb > 0) bedVal = String(pb);
    else if (pb && typeof pb === 'object' && !Array.isArray(pb)) {
      const o = pb as Record<string, unknown>;
      const mn = Number(o.min);
      const mx = Number(o.max);
      const hasMn = Number.isFinite(mn) && mn > 0;
      const hasMx = Number.isFinite(mx) && mx > 0;
      if (hasMn && hasMx) bedVal = mn === mx ? String(mn) : `${mn} – ${mx}`;
      else if (hasMn) bedVal = `${mn}+`;
      else if (hasMx) bedVal = isAr ? `حتى ${mx}` : `up to ${mx}`;
    }
    if (bedVal) chips.push({ slug: 'preferred_bedrooms', label_ar: 'الغرف', label_en: 'Bedrooms', value: bedVal });
    return chips;
  }, [clientsModel, client, geoNames, isAr]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editNotesId, setEditNotesId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [eliminateTarget, setEliminateTarget] = useState<AppRecord | null>(null);
  const [eliminateNotes, setEliminateNotes] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  // "Send to client" from an option card — the WhatsApp flow for this option.
  const [sendTarget, setSendTarget] = useState<{ sourceType: 'project' | 'market_listing'; sourceId: string; sourceName: string } | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: options.length };
    for (const r of options) {
      const s = r.data.status as string;
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [options]);

  const visible = useMemo(() => {
    const order = (s: ClientOptionStatus) => {
      const i = CLIENT_OPTION_STATUS_ORDER.indexOf(s);
      return i < 0 ? 99 : i;
    };
    const score = (r: AppRecord) => (typeof r.data.match_score === 'number' ? r.data.match_score : -1);
    const q = search.trim().toLowerCase();
    const filtered = options.filter((r) => {
      const s = r.data.status as ClientOptionStatus;
      if (statusFilter !== 'all') { if (s !== statusFilter) return false; }
      else if (s === 'eliminated' && !showEliminated) return false;
      if (sourceFilter !== 'all' && r.data.source_type !== sourceFilter) return false;
      if (q) {
        const f = (r.data.facts ?? {}) as Record<string, unknown>;
        const hay = [r.data.source_name, f.district, f.city, f.external_id]
          .filter((x): x is string => typeof x === 'string')
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sortKey === 'best') {
      return filtered.sort((a, b) => {
        const am = a.data.is_main === true ? 0 : 1;
        const bm = b.data.is_main === true ? 0 : 1;
        if (am !== bm) return am - bm;
        const ao = order(a.data.status as ClientOptionStatus);
        const bo = order(b.data.status as ClientOptionStatus);
        if (ao !== bo) return ao - bo;
        return score(b) - score(a);
      });
    }
    return filtered.sort((a, b) => {
      let c = 0;
      if (sortKey === 'score') c = score(b) - score(a);
      else if (sortKey === 'price_asc') c = cmpNullable(factRangeNum(a, 'price_range', 'min'), factRangeNum(b, 'price_range', 'min'), 1);
      else if (sortKey === 'price_desc') c = cmpNullable(factRangeNum(a, 'price_range', 'max'), factRangeNum(b, 'price_range', 'max'), -1);
      else if (sortKey === 'area_desc') c = cmpNullable(factRangeNum(a, 'area_range', 'max'), factRangeNum(b, 'area_range', 'max'), -1);
      else if (sortKey === 'newest') c = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
      if (c !== 0) return c;
      return score(b) - score(a);
    });
  }, [options, statusFilter, showEliminated, search, sourceFilter, sortKey]);

  const sourceCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of options) {
      const t = String(r.data.source_type ?? '');
      c[t] = (c[t] ?? 0) + 1;
    }
    return c;
  }, [options]);

  const eliminatedCount = counts['eliminated'] ?? 0;

  async function withBusy(id: string, fn: () => Promise<{ ok: boolean }>, okMsg: string, errMsg: string) {
    setBusyId(id);
    const res = await fn();
    setBusyId(null);
    addToast(res.ok ? okMsg : errMsg, res.ok ? 'success' : 'error');
  }

  function onToggleMain(r: AppRecord) {
    if (!canEdit) return;
    const isMain = r.data.is_main === true;
    withBusy(
      r.id,
      () => (isMain ? updateOptionStatus(r.id, 'suitable') : setMainOption(client.id, r.id)),
      isMain ? L('تم إلغاء التركيز الرئيسي.', 'Main focus cleared.') : L('تم تعيينه كخيار رئيسي.', 'Set as main option.'),
      L('تعذّر التحديث.', 'Update failed.'),
    );
  }

  function onChangeStatus(r: AppRecord, status: ClientOptionStatus) {
    if (status === r.data.status) return;
    if (status === 'eliminated') { setEliminateNotes(String(r.data.elimination_notes ?? '')); setEliminateTarget(r); return; }
    withBusy(r.id, () => updateOptionStatus(r.id, status), L('تم تحديث الحالة.', 'Status updated.'), L('تعذّر تحديث الحالة.', 'Could not update status.'));
  }

  async function confirmEliminate() {
    if (!eliminateTarget) return;
    await withBusy(eliminateTarget.id, () => eliminateOption(eliminateTarget.id, eliminateNotes.trim()), L('تم استبعاد الخيار.', 'Option eliminated.'), L('تعذّر الاستبعاد.', 'Could not eliminate.'));
    setEliminateTarget(null);
    setEliminateNotes('');
  }

  function onReactivate(r: AppRecord) {
    withBusy(r.id, () => reactivateOption(r.id), L('تمت إعادة التفعيل.', 'Reactivated.'), L('تعذّرت إعادة التفعيل.', 'Could not reactivate.'));
  }

  async function saveNotes(r: AppRecord) {
    await withBusy(r.id, () => updateSalesNotes(r.id, notesDraft.trim()), L('تم حفظ الملاحظة.', 'Note saved.'), L('تعذّر الحفظ.', 'Could not save.'));
    setEditNotesId(null);
  }

  // ONE option-card renderer shared by the list view and the map view's
  // clicked-pin panel, so the action wiring is identical in both.
  const renderOptionCard = (r: AppRecord) => {
    const d = r.data as unknown as ClientOptionData;
    const f = (d.facts ?? {}) as Record<string, unknown>;
    const isMain = d.is_main === true;
    const isEliminated = d.status === 'eliminated';
    const busy = busyId === r.id;
    const cur = L('ر.س', 'SAR');
    const city = typeof f.city === 'string' ? f.city : '';
    const district = typeof f.district === 'string' ? f.district : '';
    const unitTypes = Array.isArray(f.unit_types)
      ? (f.unit_types as unknown[]).filter((x): x is string => typeof x === 'string').map((t) => (isAr ? UNIT_TYPE_AR[t.trim().toLowerCase()] ?? t : t)).join('، ')
      : '';
    const price = fmtRange(f.price_range, cur);
    const area = fmtRange(f.area_range, L('م²', 'm²'));
    const beds = fmtRange(f.bedroom_range, '');
    const baths = fmtRange(f.bathroom_range, '');
    const avail = typeof f.available_units === 'number' ? f.available_units : null;
    const meta = CLIENT_OPTION_STATUS_META[d.status as ClientOptionStatus] ?? CLIENT_OPTION_STATUS_META.suitable;
    const srcMeta = CLIENT_OPTION_SOURCE_META[d.source_type as ClientOptionSourceType];
    const adId =
      d.source_type === 'market_listing'
        ? (typeof f.external_id === 'string' && f.external_id
            ? f.external_id
            : externalIdBySourceId.get(String(d.source_id ?? '')) ?? null)
        : null;

    return (
      <div key={r.id} className={`overflow-hidden rounded-xl border bg-white shadow-sm ${isMain ? 'border-copper/60 ring-1 ring-copper/30' : isEliminated ? 'border-red-200 opacity-80' : 'border-sand/50'}`}>
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-sand/30 px-3 py-2">
          <button
            type="button"
            onClick={() => onToggleMain(r)}
            disabled={!canEdit || busy}
            className={`shrink-0 transition disabled:opacity-50 ${isMain ? 'text-gold' : 'text-charcoal/30 hover:text-gold'}`}
            title={isMain ? L('الخيار الرئيسي — اضغط لإلغائه', 'Main option — click to clear') : L('تعيين كخيار رئيسي', 'Set as main option')}
            aria-pressed={isMain}
          >
            <Star size={18} fill={isMain ? 'currentColor' : 'none'} />
          </button>
          <Building2 size={15} className="shrink-0 text-charcoal/50" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-charcoal">{d.source_name || L('بدون اسم', 'Untitled')}</div>
            <div className="flex items-center gap-1 truncate text-[11px] text-charcoal/55">
              <MapPin size={11} className="shrink-0 text-copper" />
              {[district, city].filter(Boolean).join('، ') || L('الموقع غير محدد', 'Location not set')}
            </div>
          </div>
          {adId && (
            <span
              className="inline-flex shrink-0 items-center rounded-full border border-chocolate/25 bg-chocolate/5 px-2 py-0.5 text-[11px] font-bold text-chocolate"
              title={L('رقم الإعلان', 'Ad ID')}
            >
              @{adId}
            </span>
          )}
          {srcMeta && (
            <span className="inline-flex shrink-0 items-center rounded-full border border-sand/60 bg-cream/50 px-2 py-0.5 text-[11px] font-semibold text-charcoal/70">
              {isAr ? srcMeta.ar : srcMeta.en}
            </span>
          )}
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold"
            style={{ color: meta.color, borderColor: `${meta.color}55`, backgroundColor: `${meta.color}12` }}
          >
            {isAr ? meta.ar : meta.en}
          </span>
          {typeof d.match_score === 'number' && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-charcoal/5 px-2 py-0.5 text-[11px] font-bold text-charcoal/70">{d.match_score}%</span>
          )}
          {/* Listing quality — snapshotted into facts at save time; for
              options saved before the quality feature (2026-07-02) the
              snapshot has no grade, so fall back to the live listing record
              in the slim store. Renders nothing when neither has a grade. */}
          {d.source_type === 'market_listing' && (() => {
            const live = qualityBySourceId.get(String(d.source_id ?? ''));
            const grade = (typeof f.quality_grade === 'string' && f.quality_grade) ? f.quality_grade : live?.grade;
            const score = (typeof f.quality_score === 'number' && Number.isFinite(f.quality_score)) ? f.quality_score : live?.score;
            return <QualityBadge grade={grade} score={score} isAr={isAr} />;
          })()}
        </div>

        <div className="space-y-2.5 p-3">
          {/* Specs grid */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg bg-cream/30 p-2.5 text-xs sm:grid-cols-3">
            <Spec icon={<Wallet size={12} />} label={L('السعر', 'Price')} value={price} isAr={isAr} />
            <Spec icon={<PackageCheck size={12} />} label={L('وحدات متاحة', 'Available')} value={avail != null ? String(avail) : null} isAr={isAr} />
            <Spec icon={<Building2 size={12} />} label={L('النوع', 'Type')} value={unitTypes || null} isAr={isAr} />
            <Spec icon={<Ruler size={12} />} label={L('المساحة', 'Area')} value={area} isAr={isAr} />
            <Spec icon={<BedDouble size={12} />} label={L('الغرف', 'Bedrooms')} value={beds} isAr={isAr} />
            <Spec icon={<Bath size={12} />} label={L('دورات المياه', 'Bathrooms')} value={baths} isAr={isAr} />
          </div>

          {/* Sales notes (inline-editable) */}
          {editNotesId === r.id ? (
            <div className="space-y-1.5">
              <textarea value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} rows={2} autoFocus className="form-input w-full resize-none text-xs" placeholder={L('ملاحظات المبيعات…', 'Sales notes…')} />
              <div className="flex gap-1.5">
                <button type="button" onClick={() => saveNotes(r)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-copper px-2.5 py-1 text-[11px] font-bold text-white hover:bg-terracotta disabled:opacity-50">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {L('حفظ', 'Save')}
                </button>
                <button type="button" onClick={() => setEditNotesId(null)} className="rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[11px] font-bold text-charcoal/70 hover:bg-cream/60">{L('إلغاء', 'Cancel')}</button>
              </div>
            </div>
          ) : (
            d.sales_notes ? (
              <div className="flex items-start gap-1.5 rounded-lg bg-cream/40 px-2.5 py-1.5 text-xs text-charcoal/80">
                <span className="font-semibold text-charcoal/50">{L('ملاحظات:', 'Notes:')}</span>
                <span className="flex-1 whitespace-pre-wrap break-words">{d.sales_notes}</span>
              </div>
            ) : null
          )}

          {/* Elimination notes */}
          {isEliminated && d.elimination_notes && (
            <div className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
              <XCircle size={13} className="mt-0.5 shrink-0" />
              <span><span className="font-semibold">{L('سبب الاستبعاد: ', 'Eliminated: ')}</span>{d.elimination_notes}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <a
              href={optionSourceUrl(d.source_type as ClientOptionSourceType, d.source_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[11px] font-bold text-charcoal/75 transition hover:bg-cream/60"
            >
              <ExternalLink size={12} /> {L('عرض المصدر', 'View source')}
            </a>

            {/* Send THIS option to the client over WhatsApp — the prepared
                message if one exists, else the creation flow. Projects +
                market listings (units have no message flow). */}
            {(d.source_type === 'project' || d.source_type === 'market_listing') && (
              <button
                type="button"
                onClick={() => setSendTarget({
                  sourceType: d.source_type as 'project' | 'market_listing',
                  sourceId: d.source_id,
                  sourceName: d.source_name || '',
                })}
                className="inline-flex items-center gap-1 rounded-lg bg-copper px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-terracotta"
                title={L('إرسال هذا الخيار للعميل عبر واتساب', 'Send this option to the client over WhatsApp')}
              >
                <Send size={12} /> {L('إرسال للعميل', 'Send to client')}
              </button>
            )}

            {/* Market-listing options: contact the advertiser — opens the
                WhatsApp chat if the phone is already on the listing, else
                runs the REGA lookup and opens it when the number lands. */}
            {d.source_type === 'market_listing' && (
              <ContactAdvertiserButton listingId={d.source_id} isAr={isAr} />
            )}

            {canEdit && (
              <>
                <select
                  value={d.status}
                  onChange={(e) => onChangeStatus(r, e.target.value as ClientOptionStatus)}
                  disabled={busy}
                  className="form-input !w-auto !py-1 text-[11px] disabled:opacity-50"
                  title={L('تحديث الحالة', 'Update status')}
                >
                  {CLIENT_OPTION_STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>{isAr ? CLIENT_OPTION_STATUS_META[s].ar : CLIENT_OPTION_STATUS_META[s].en}</option>
                  ))}
                </select>

                {!isEliminated && (
                  <button type="button" onClick={() => { setNotesDraft(String(d.sales_notes ?? '')); setEditNotesId(r.id); }} className="inline-flex items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[11px] font-bold text-charcoal/75 transition hover:bg-cream/60">
                    <Pencil size={12} /> {L('ملاحظة', 'Note')}
                  </button>
                )}

                {isEliminated ? (
                  <button type="button" onClick={() => onReactivate(r)} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[11px] font-bold text-charcoal/75 transition hover:bg-cream/60 disabled:opacity-50">
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} {L('إعادة تفعيل', 'Reactivate')}
                  </button>
                ) : (
                  <button type="button" onClick={() => { setEliminateNotes(String(d.elimination_notes ?? '')); setEliminateTarget(r); }} disabled={busy} className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-bold text-red-700 transition hover:bg-red-100 disabled:opacity-50">
                    <XCircle size={12} /> {L('استبعاد', 'Eliminate')}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (!modelId) {
    return <div className="rounded-2xl border border-sand/30 bg-white p-6 text-sm text-charcoal/55">{L('نموذج خيارات العميل غير محمّل.', 'Client options model not loaded.')}</div>;
  }

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="space-y-2 rounded-2xl border border-sand/30 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
        <ListChecks size={16} className="text-copper" />
        <span className="text-sm font-bold text-charcoal">{L('خيارات العميل', 'Client Options')}</span>
        <span className="rounded-full bg-sand/30 px-2 py-0.5 text-[11px] font-semibold text-charcoal/70">{options.length}</span>
        <div className="flex-1" />
        {/* List / Map view toggle */}
        <div className="flex overflow-hidden rounded-lg border border-sand/60">
          <button
            type="button"
            onClick={() => setView('list')}
            className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold transition ${view === 'list' ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream/60'}`}
            aria-pressed={view === 'list'}
          >
            <LayoutList size={13} /> {L('قائمة', 'List')}
          </button>
          <button
            type="button"
            onClick={() => setView('map')}
            className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold transition ${view === 'map' ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream/60'}`}
            aria-pressed={view === 'map'}
          >
            <MapIcon size={13} /> {L('خريطة', 'Map')}
          </button>
        </div>
        <Filter size={14} className="text-charcoal/40" />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ClientOptionStatus | 'all')}
          className="form-input !w-auto !py-1 text-xs"
        >
          <option value="all">{L('كل الحالات', 'All statuses')} ({counts['all'] ?? 0})</option>
          {CLIENT_OPTION_STATUS_ORDER.map((s) => (
            <option key={s} value={s}>{(isAr ? CLIENT_OPTION_STATUS_META[s].ar : CLIENT_OPTION_STATUS_META[s].en)} ({counts[s] ?? 0})</option>
          ))}
        </select>
        {statusFilter === 'all' && eliminatedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowEliminated((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${showEliminated ? 'border-copper/40 bg-copper/10 text-copper' : 'border-sand/60 bg-white text-charcoal/60 hover:bg-cream/60'}`}
          >
            {showEliminated ? L('إخفاء المستبعدة', 'Hide eliminated') : L(`عرض المستبعدة (${eliminatedCount})`, `Show eliminated (${eliminatedCount})`)}
          </button>
        )}
        <button
          type="button"
          onClick={findMore}
          className="inline-flex items-center gap-1 rounded-lg bg-copper px-2.5 py-1 text-xs font-bold text-white transition hover:bg-terracotta"
        >
          <Compass size={13} /> {L('البحث عن خيارات أكثر', 'Find more options')}
        </button>
        {canEdit && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg bg-copper/10 px-2.5 py-1 text-xs font-bold text-copper transition hover:bg-copper/20"
          >
            <Plus size={13} /> {L('إضافة خيار', 'Add option')}
          </button>
        )}
        </div>

        {/* Search + source filter + sort */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search size={13} className="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-charcoal/40" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={L('بحث بالاسم أو الحي أو رقم الإعلان…', 'Search name, district, or ad id…')}
              className="form-input w-full !py-1 ps-8 text-xs"
            />
          </div>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as 'all' | ClientOptionSourceType)}
            className="form-input !w-auto !py-1 text-xs"
            title={L('نوع المصدر', 'Source type')}
          >
            <option value="all">{L('كل المصادر', 'All sources')} ({options.length})</option>
            {(Object.keys(CLIENT_OPTION_SOURCE_META) as ClientOptionSourceType[]).map((t) => (
              <option key={t} value={t}>
                {isAr ? CLIENT_OPTION_SOURCE_META[t].ar : CLIENT_OPTION_SOURCE_META[t].en} ({sourceCounts[t] ?? 0})
              </option>
            ))}
          </select>
          <ArrowUpDown size={13} className="text-charcoal/40" />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as OptionSortKey)}
            className="form-input !w-auto !py-1 text-xs"
            title={L('ترتيب الخيارات', 'Sort options')}
          >
            {(Object.keys(SORT_LABELS) as OptionSortKey[]).map((k) => (
              <option key={k} value={k}>{isAr ? SORT_LABELS[k].ar : SORT_LABELS[k].en}</option>
            ))}
          </select>
        </div>

        {/* Client preference chips — the INPUTS the options were found against.
            Read-only context; editing stays on the Preferences tab / finder. */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-sand/20 pt-2">
          <SlidersHorizontal size={12} className="text-charcoal/40" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-charcoal/45">{L('تفضيلات العميل', 'Client preferences')}</span>
          {prefChips.length === 0 && (
            <span className="text-[11px] text-charcoal/50">{L('لا توجد تفضيلات محددة', 'None set')}</span>
          )}
          {prefChips.map((p) => (
            <span key={`${p.slug}:${isAr ? p.label_ar : p.label_en}`} className="inline-flex items-center gap-1 rounded-full border border-sand/50 bg-cream/50 px-2 py-0.5 text-[11px] text-charcoal/80">
              <span className="text-charcoal/50">{isAr ? p.label_ar : p.label_en}:</span>
              <span className="font-semibold">{p.value}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Empty state */}
      {options.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-sand/30 bg-white px-6 py-12 text-center text-charcoal/55">
          <ListChecks size={26} className="text-copper/60" />
          <p className="text-sm">{L('لا توجد خيارات محفوظة لهذا العميل بعد. ابحث عن المشاريع المطابقة أو أضف خياراً تعرفه مباشرة.', 'No saved options yet. Find matching projects or add a specific option you already know.')}</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={findMore}
              className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3 py-2 text-sm font-bold text-white transition hover:bg-terracotta"
            >
              <Compass size={15} /> {L('الباحث عن المشاريع', 'Find projects')}
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-copper/10 px-3 py-2 text-sm font-bold text-copper transition hover:bg-copper/20"
              >
                <Plus size={15} /> {L('إضافة خيار يدوياً', 'Add option manually')}
              </button>
            )}
          </div>
        </div>
      )}
      {options.length > 0 && visible.length === 0 && (
        <div className="rounded-2xl border border-sand/30 bg-white px-6 py-8 text-center text-sm text-charcoal/55">{L('لا خيارات بهذا الفلتر.', 'No options match this filter.')}</div>
      )}

      {/* Map view — status-colored pins; a pin click opens the same option
          card (full actions) in a floating panel over the map. */}
      {view === 'map' && visible.length > 0 && (
        <ClientOptionsMapView options={visible} isAr={isAr} renderCard={renderOptionCard} />
      )}

      {/* Option cards (list view) */}
      {view === 'list' && visible.map((r) => renderOptionCard(r))}

      {/* Manual add-option picker */}
      {addOpen && <AddOptionModal clientId={client.id} isAr={isAr} onClose={() => setAddOpen(false)} />}

      {/* "Send to client" WhatsApp flow — stored message → chat composer;
          missing message → creation flow first (project: deterministic compose;
          listing: AI text + cleaned photos). */}
      {sendTarget && (
        sendTarget.sourceType === 'market_listing' ? (
          <ListingWhatsAppFlow
            isAr={isAr}
            listingId={sendTarget.sourceId}
            listingName={sendTarget.sourceName}
            clientRec={client}
            onClose={() => setSendTarget(null)}
          />
        ) : (
          <ProjectWhatsAppFlow
            isAr={isAr}
            projectId={sendTarget.sourceId}
            projectName={sendTarget.sourceName}
            clientRec={client}
            onClose={() => setSendTarget(null)}
          />
        )
      )}

      {/* Eliminate-with-notes modal */}
      {eliminateTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4" onMouseDown={() => busyId == null && setEliminateTarget(null)}>
          <div className="w-full max-w-md rounded-2xl bg-cream p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()} dir={isAr ? 'rtl' : 'ltr'}>
            <div className="mb-2 flex items-center gap-2 text-chocolate">
              <XCircle size={18} className="text-red-600" />
              <h3 className="text-base font-bold">{L('استبعاد الخيار', 'Eliminate option')}</h3>
            </div>
            <p className="mb-3 text-sm text-charcoal/70">{String(eliminateTarget.data.source_name ?? '')}</p>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{L('سبب الاستبعاد', 'Elimination reason')}</label>
            <textarea value={eliminateNotes} onChange={(e) => setEliminateNotes(e.target.value)} rows={3} autoFocus placeholder={L('مثال: خارج الميزانية…', 'e.g. over budget…')} className="form-input w-full resize-none" />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setEliminateTarget(null)} className="rounded-lg border border-sand/60 bg-white px-3 py-2 text-sm font-bold text-charcoal/75 transition hover:bg-cream/60">{L('إلغاء', 'Cancel')}</button>
              <button type="button" onClick={confirmEliminate} disabled={busyId != null} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50">
                {busyId != null ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />} {L('استبعاد', 'Eliminate')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Spec({ icon, label, value, isAr }: { icon: React.ReactNode; label: string; value: string | null; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  return (
    <div className="flex items-start gap-1.5">
      <span className="mt-0.5 shrink-0 text-copper">{icon}</span>
      <div className="min-w-0">
        <div className="text-charcoal/50">{label}</div>
        {value ? <div className="break-words font-medium text-charcoal/90">{value}</div> : <div className="italic text-charcoal/40">{L('غير متوفر', 'n/a')}</div>}
      </div>
    </div>
  );
}
