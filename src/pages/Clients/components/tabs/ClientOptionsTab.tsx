import { buildGeoNameMap } from '@/lib/geo/geoNameMap';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ListChecks, Star, ExternalLink, XCircle, RotateCcw, Loader2, Building2, MapPin,
  Wallet, Ruler, BedDouble, Bath, PackageCheck, Pencil, Check, Filter, Plus, Compass, Send,
  LayoutList, LayoutGrid, Map as MapIcon, Search, ArrowUpDown, SlidersHorizontal, CheckSquare, Square, Trash2,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  CLIENT_OPTION_STATUS_META, CLIENT_OPTION_SOURCE_META, CLIENT_OPTION_STATUS_ORDER,
  optionSourceUrl, setMainOption, updateOptionStatus, eliminateOption, reactivateOption,
  updateSalesNotes, deleteClientOption,
  type ClientOptionStatus, type ClientOptionSourceType, type ClientOptionData,
} from '@/lib/matching/clientOptions';
import { buildAssistantContext } from '@/lib/followups/assistantContext';
import ContactAdvertiserButton from '@/components/market/ContactAdvertiserButton';
import QualityBadge from '@/components/market/QualityBadge';
import AddOptionModal from '../AddOptionModal';
import ClientOptionsMapView from '../ClientOptionsMapView';
import ProjectWhatsAppFlow from '@/pages/Followups/components/ProjectWhatsAppFlow';
import ListingWhatsAppFlow from '@/components/matching/ListingWhatsAppFlow';
import Modal from '@/components/ui/Modal';
import UnitsInventory from '@/pages/Projects/components/UnitsInventory';

interface Props {
  client: AppRecord;
  isAr: boolean;
  canEdit: boolean;
  /** Opens the Project Finder scoped to this client ("find more options").
   *  Rendered as a button in the toolbar + empty state when provided. */
  onFindMore?: () => void;
  /** Opens an option's SOURCE record (project / unit / market listing) as an
   *  in-place overlay the host can back out of, instead of the default
   *  new-tab link. When absent, "View source" stays a `target="_blank"` link
   *  (correct for the full-page 360 on desktop; the in-chat popups pass this so
   *  the rep can return to where they were). */
  onOpenSource?: (sourceType: ClientOptionSourceType, sourceId: string) => void;
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

/** Deep-refine filter fields — all optional; empty string = no bound. */
interface OptionRefine {
  priceMin: string;
  priceMax: string;
  areaMin: string;
  areaMax: string;
  bedsMin: string;
  district: 'all' | string;
  grade: 'all' | string;
}
const REFINE_EMPTY: OptionRefine = { priceMin: '', priceMax: '', areaMin: '', areaMax: '', bedsMin: '', district: 'all', grade: 'all' };
const refineActive = (f: OptionRefine): boolean =>
  f.priceMin !== '' || f.priceMax !== '' || f.areaMin !== '' || f.areaMax !== '' || f.bedsMin !== '' || f.district !== 'all' || f.grade !== 'all';

/** A sortable number off a facts range ({min,max} or plain number); null when absent. */
function factRangeNum(r: AppRecord, key: 'price_range' | 'area_range' | 'bedroom_range', pick: 'min' | 'max'): number | null {
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
export default function ClientOptionsTab({ client, isAr, canEdit, onFindMore, onOpenSource }: Props) {
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
  // Deep refine (price / area / rooms / district / quality) — collapsible row.
  const [showRefine, setShowRefine] = useState(false);
  const [refine, setRefine] = useState<OptionRefine>(REFINE_EMPTY);
  // Multi-select for bulk actions. Selection survives filter changes; the
  // select-all toggle operates on the currently VISIBLE set.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  // When true, the eliminate-with-notes modal applies to the whole selection.
  const [bulkEliminate, setBulkEliminate] = useState(false);
  // HARD-DELETE confirm: one option (record) or the whole selection ('bulk').
  // Delete REMOVES the option row so the property can be found + added again —
  // unlike eliminate, which keeps the tombstone that blocks re-adding.
  const [deleteTarget, setDeleteTarget] = useState<AppRecord | 'bulk' | null>(null);

  // Client preference chips — resolved by the SAME helper the finder's chips
  // use (buildAssistantContext, saved record only — no draft here), plus a
  // bedrooms chip its shared PREF_FIELDS list doesn't cover.
  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  // ISSUE #8 — localized geography (was a single Arabic string per id).
  const geoNames = useMemo(() => buildGeoNameMap(models, records), [models, records]);
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
  // "Units" from a PROJECT option card — the project's inventory in a popup
  // (same UnitsInventory the finder + project page use). Holds the resolved
  // all_projects id + a display name.
  const [unitsFor, setUnitsFor] = useState<{ projectId: string; name: string } | null>(null);

  // The all_projects id a project option's units live under. Our-portfolio
  // options store the our_projects record id (their finder source_id), so we
  // follow its master `project` link; all_projects options use the id directly.
  // Mirrors ProjectUnitsModal's resolution so both surfaces agree.
  const resolveUnitsProjectId = (sourceId: string): string => {
    const our = models.find((m) => m.name === 'our_projects');
    const rec = our ? (records[our.id] ?? []).find((r) => r.id === sourceId) : null;
    const master = (rec?.data as Record<string, unknown> | undefined)?.project;
    const id = Array.isArray(master) ? master[0] : master;
    return typeof id === 'string' && id ? id : sourceId;
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: options.length };
    for (const r of options) {
      const s = r.data.status as string;
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [options]);

  // The grade an option displays: facts snapshot first, live listing fallback.
  const gradeOf = (r: AppRecord): string | null => {
    const f = (r.data.facts ?? {}) as Record<string, unknown>;
    if (typeof f.quality_grade === 'string' && f.quality_grade) return f.quality_grade;
    return qualityBySourceId.get(String(r.data.source_id ?? ''))?.grade ?? null;
  };

  // Districts present across this client's options — feeds the refine dropdown.
  const optionDistricts = useMemo(() => {
    const s = new Set<string>();
    for (const r of options) {
      const d = (r.data.facts as Record<string, unknown> | null)?.district;
      if (typeof d === 'string' && d.trim()) s.add(d.trim());
    }
    return [...s].sort((a, b) => a.localeCompare(b, 'ar'));
  }, [options]);

  const visible = useMemo(() => {
    const order = (s: ClientOptionStatus) => {
      const i = CLIENT_OPTION_STATUS_ORDER.indexOf(s);
      return i < 0 ? 99 : i;
    };
    const score = (r: AppRecord) => (typeof r.data.match_score === 'number' ? r.data.match_score : -1);
    const q = search.trim().toLowerCase();
    const num = (v: string): number | null => {
      const n = Number(v);
      return v.trim() !== '' && Number.isFinite(n) ? n : null;
    };
    const pMin = num(refine.priceMin), pMax = num(refine.priceMax);
    const aMin = num(refine.areaMin), aMax = num(refine.areaMax);
    const bMin = num(refine.bedsMin);
    // Range-overlap check vs a facts range; a bound EXCLUDES options missing
    // that fact (filtering means "show me ones that qualify").
    const passesRange = (r: AppRecord, key: 'price_range' | 'area_range', lo: number | null, hi: number | null): boolean => {
      if (lo === null && hi === null) return true;
      const rMin = factRangeNum(r, key, 'min');
      const rMax = factRangeNum(r, key, 'max');
      if (rMin === null && rMax === null) return false;
      if (lo !== null && (rMax ?? rMin)! < lo) return false;
      if (hi !== null && (rMin ?? rMax)! > hi) return false;
      return true;
    };
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
      if (!passesRange(r, 'price_range', pMin, pMax)) return false;
      if (!passesRange(r, 'area_range', aMin, aMax)) return false;
      if (bMin !== null) {
        const bh = factRangeNum(r, 'bedroom_range', 'max');
        if (bh === null || bh < bMin) return false;
      }
      if (refine.district !== 'all') {
        const d = (r.data.facts as Record<string, unknown> | null)?.district;
        if (d !== refine.district) return false;
      }
      if (refine.grade !== 'all' && gradeOf(r) !== refine.grade) return false;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, statusFilter, showEliminated, search, sourceFilter, sortKey, refine, qualityBySourceId]);

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
    if (bulkEliminate) {
      // ONE shared reason applied to every selected option.
      const notes = eliminateNotes.trim();
      setBulkEliminate(false);
      setEliminateNotes('');
      await applyBulk([...selectedIds], (id) => eliminateOption(id, notes),
        L('تم استبعاد الخيارات المحددة.', 'Selected options eliminated.'));
      return;
    }
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

  // ── Multi-select + bulk actions ──────────────────────────────────────────
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selectedIds.has(r.id));
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach((r) => next.delete(r.id));
      else visible.forEach((r) => next.add(r.id));
      return next;
    });
  };

  /** Run one write per selected id sequentially (deterministic tallying, no
   *  write storms), with live progress; toast a summary; clear the selection. */
  async function applyBulk(ids: string[], fn: (id: string) => Promise<{ ok: boolean }>, okMsg: string) {
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    let ok = 0, fail = 0;
    for (const id of ids) {
      setBulkProgress({ done: ok + fail, total: ids.length });
      const res = await fn(id);
      if (res.ok) ok += 1; else fail += 1;
    }
    setBulkBusy(false);
    setBulkProgress(null);
    addToast(
      fail > 0 ? L(`${ok} نجح، ${fail} فشل.`, `${ok} succeeded, ${fail} failed.`) : okMsg,
      fail > 0 ? 'error' : 'success',
    );
    setSelectedIds(new Set());
  }

  const optionById = (id: string) => options.find((r) => r.id === id);
  function bulkSetStatus(status: ClientOptionStatus) {
    // main_focus is single-by-invariant and eliminated needs a reason — both
    // are excluded from the bulk dropdown; guard anyway.
    if (status === 'main_focus' || status === 'eliminated') return;
    applyBulk([...selectedIds], (id) => updateOptionStatus(id, status),
      L('تم تحديث حالة الخيارات المحددة.', 'Selected options updated.'));
  }
  /** Confirmed hard-delete: one option, or every selected one. */
  function confirmDelete() {
    if (deleteTarget === 'bulk') {
      const ids = [...selectedIds];
      let ok = 0;
      for (const id of ids) if (deleteClientOption(id).ok) ok += 1;
      setSelectedIds(new Set());
      setDeleteTarget(null);
      addToast(
        ok === ids.length
          ? L(`تم حذف ${ok} خيار من قائمة العميل.`, `${ok} options removed from the client's list.`)
          : L(`تم حذف ${ok} من ${ids.length}.`, `Deleted ${ok} of ${ids.length}.`),
        ok === ids.length ? 'success' : 'error',
      );
      return;
    }
    if (!deleteTarget) return;
    const res = deleteClientOption(deleteTarget.id);
    setSelectedIds((prev) => { const n = new Set(prev); n.delete(deleteTarget.id); return n; });
    setDeleteTarget(null);
    addToast(
      res.ok ? L('تم حذف الخيار من قائمة العميل.', 'Option removed from the client’s list.')
             : L('تعذّر الحذف.', 'Could not delete.'),
      res.ok ? 'success' : 'error',
    );
  }

  function bulkReactivate() {
    const ids = [...selectedIds].filter((id) => optionById(id)?.data.status === 'eliminated');
    if (ids.length === 0) { addToast(L('لا خيارات مستبعدة ضمن التحديد.', 'No eliminated options in the selection.'), 'info'); return; }
    applyBulk(ids, (id) => reactivateOption(id), L('تمت إعادة تفعيل الخيارات المستبعدة المحددة.', 'Selected eliminated options reactivated.'));
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
      <div key={r.id} className={`overflow-hidden rounded-xl border bg-white shadow-sm ${selectedIds.has(r.id) ? 'border-copper ring-2 ring-copper/40' : isMain ? 'border-copper/60 ring-1 ring-copper/30' : isEliminated ? 'border-red-200 opacity-80' : 'border-sand/50'}`}>
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-sand/30 px-3 py-2">
          {canEdit && (
            <button
              type="button"
              onClick={() => toggleSelect(r.id)}
              className={`shrink-0 transition ${selectedIds.has(r.id) ? 'text-copper' : 'text-charcoal/30 hover:text-copper'}`}
              title={L('تحديد للإجراءات الجماعية', 'Select for bulk actions')}
              aria-pressed={selectedIds.has(r.id)}
            >
              {selectedIds.has(r.id) ? <CheckSquare size={16} /> : <Square size={16} />}
            </button>
          )}
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
            {onOpenSource ? (
              // In-place overlay (in-chat popups): the host can return here.
              <button
                type="button"
                onClick={() => onOpenSource(d.source_type as ClientOptionSourceType, d.source_id)}
                className="inline-flex items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[11px] font-bold text-charcoal/75 transition hover:bg-cream/60"
              >
                <ExternalLink size={12} /> {L('عرض المصدر', 'View source')}
              </button>
            ) : (
              <a
                href={optionSourceUrl(d.source_type as ClientOptionSourceType, d.source_id)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[11px] font-bold text-charcoal/75 transition hover:bg-cream/60"
              >
                <ExternalLink size={12} /> {L('عرض المصدر', 'View source')}
              </a>
            )}

            {/* View the project's unit inventory in a popup — same table the
                finder card and project page use. Projects only (a market
                listing / single unit has no inventory of its own). */}
            {d.source_type === 'project' && (
              <button
                type="button"
                onClick={() => setUnitsFor({ projectId: resolveUnitsProjectId(d.source_id), name: d.source_name || '' })}
                className="inline-flex items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[11px] font-bold text-charcoal/75 transition hover:bg-cream/60"
                title={L('عرض وحدات المشروع', 'View the project’s units')}
              >
                <LayoutGrid size={12} /> {L('الوحدات', 'Units')}
              </button>
            )}

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

                {/* Hard-delete: drop the option from THIS client's list so the
                    same property can be found + added again later. Never
                    touches the underlying project / unit / listing record. */}
                <button
                  type="button"
                  onClick={() => setDeleteTarget(r)}
                  disabled={busy}
                  title={L('حذف من قائمة العميل فقط — يمكن إيجاده وإضافته لاحقاً', 'Remove from this client’s list only — it can be found and re-added later')}
                  className="inline-flex items-center gap-1 rounded-lg border border-charcoal/20 bg-white px-2.5 py-1 text-[11px] font-bold text-charcoal/60 transition hover:bg-cream/60 disabled:opacity-50"
                >
                  <Trash2 size={12} /> {L('حذف', 'Delete')}
                </button>
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
          <button
            type="button"
            onClick={() => setShowRefine((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${showRefine || refineActive(refine) ? 'border-copper/40 bg-copper/10 text-copper' : 'border-sand/60 bg-white text-charcoal/60 hover:bg-cream/60'}`}
            aria-expanded={showRefine}
          >
            <SlidersHorizontal size={12} /> {L('تصفية دقيقة', 'Refine')}
            {refineActive(refine) && <span className="ms-0.5 inline-block h-1.5 w-1.5 rounded-full bg-copper" />}
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={toggleSelectAll}
              disabled={visible.length === 0}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition disabled:opacity-40 ${allVisibleSelected ? 'border-copper bg-copper text-white' : 'border-sand/60 bg-white text-charcoal/60 hover:bg-cream/60'}`}
            >
              {allVisibleSelected ? <CheckSquare size={12} /> : <Square size={12} />}
              {allVisibleSelected ? L('إلغاء التحديد', 'Clear selection') : L(`تحديد الكل (${visible.length})`, `Select all (${visible.length})`)}
            </button>
          )}
        </div>

        {/* Deep refine: price / area / rooms / district / quality */}
        {showRefine && (
          <div className="flex flex-wrap items-end gap-2 rounded-lg bg-cream/40 p-2">
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold text-charcoal/55">{L('السعر من', 'Price from')}</label>
              <input type="number" min={0} value={refine.priceMin} onChange={(e) => setRefine((f) => ({ ...f, priceMin: e.target.value }))} className="form-input !w-28 !py-1 text-xs" placeholder="1,000,000" />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold text-charcoal/55">{L('السعر إلى', 'Price to')}</label>
              <input type="number" min={0} value={refine.priceMax} onChange={(e) => setRefine((f) => ({ ...f, priceMax: e.target.value }))} className="form-input !w-28 !py-1 text-xs" placeholder="3,000,000" />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold text-charcoal/55">{L('المساحة من (م²)', 'Area from (m²)')}</label>
              <input type="number" min={0} value={refine.areaMin} onChange={(e) => setRefine((f) => ({ ...f, areaMin: e.target.value }))} className="form-input !w-24 !py-1 text-xs" />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold text-charcoal/55">{L('المساحة إلى (م²)', 'Area to (m²)')}</label>
              <input type="number" min={0} value={refine.areaMax} onChange={(e) => setRefine((f) => ({ ...f, areaMax: e.target.value }))} className="form-input !w-24 !py-1 text-xs" />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold text-charcoal/55">{L('الغرف (على الأقل)', 'Bedrooms (min)')}</label>
              <input type="number" min={0} value={refine.bedsMin} onChange={(e) => setRefine((f) => ({ ...f, bedsMin: e.target.value }))} className="form-input !w-20 !py-1 text-xs" />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold text-charcoal/55">{L('الحي', 'District')}</label>
              <select value={refine.district} onChange={(e) => setRefine((f) => ({ ...f, district: e.target.value }))} className="form-input !w-auto !py-1 text-xs">
                <option value="all">{L('كل الأحياء', 'All districts')}</option>
                {optionDistricts.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold text-charcoal/55">{L('الجودة', 'Quality')}</label>
              <select value={refine.grade} onChange={(e) => setRefine((f) => ({ ...f, grade: e.target.value }))} className="form-input !w-auto !py-1 text-xs">
                <option value="all">{L('الكل', 'All')}</option>
                {['A', 'B', 'C', 'D'].map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            {refineActive(refine) && (
              <button
                type="button"
                onClick={() => setRefine(REFINE_EMPTY)}
                className="inline-flex items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-xs font-semibold text-charcoal/60 transition hover:bg-cream/60"
              >
                <XCircle size={12} /> {L('مسح التصفية', 'Clear')}
              </button>
            )}
          </div>
        )}

        {/* Bulk-actions bar — appears with a selection */}
        {canEdit && selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-copper/40 bg-copper/5 px-3 py-2">
            <CheckSquare size={14} className="text-copper" />
            <span className="text-xs font-bold text-charcoal">
              {L(`${selectedIds.size} خيار محدد`, `${selectedIds.size} selected`)}
              {bulkProgress && <span className="ms-1 text-charcoal/60">{bulkProgress.done}/{bulkProgress.total}…</span>}
            </span>
            {bulkBusy && <Loader2 size={13} className="animate-spin text-copper" />}
            <div className="flex-1" />
            <select
              value=""
              disabled={bulkBusy}
              onChange={(e) => { if (e.target.value) bulkSetStatus(e.target.value as ClientOptionStatus); }}
              className="form-input !w-auto !py-1 text-xs disabled:opacity-50"
            >
              <option value="">{L('تغيير الحالة إلى…', 'Set status to…')}</option>
              {CLIENT_OPTION_STATUS_ORDER
                .filter((s) => s !== 'main_focus' && s !== 'eliminated')
                .map((s) => (
                  <option key={s} value={s}>{isAr ? CLIENT_OPTION_STATUS_META[s].ar : CLIENT_OPTION_STATUS_META[s].en}</option>
                ))}
            </select>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => { setEliminateNotes(''); setBulkEliminate(true); }}
              className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-bold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
            >
              <XCircle size={12} /> {L('استبعاد المحدد', 'Eliminate selected')}
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={bulkReactivate}
              className="inline-flex items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-xs font-bold text-charcoal/70 transition hover:bg-cream/60 disabled:opacity-50"
            >
              <RotateCcw size={12} /> {L('إعادة تفعيل المستبعد', 'Reactivate eliminated')}
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => setDeleteTarget('bulk')}
              title={L('يحذف الخيارات من قائمة العميل فقط — يمكن إيجادها وإضافتها لاحقاً', 'Removes the options from this client’s list only — they can be found and re-added later')}
              className="inline-flex items-center gap-1 rounded-lg border border-charcoal/25 bg-white px-2.5 py-1 text-xs font-bold text-charcoal/70 transition hover:bg-cream/60 disabled:opacity-50"
            >
              <Trash2 size={12} /> {L('حذف من القائمة', 'Delete from list')}
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => setSelectedIds(new Set())}
              className="rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-xs font-semibold text-charcoal/60 transition hover:bg-cream/60 disabled:opacity-50"
            >
              {L('مسح التحديد', 'Clear')}
            </button>
          </div>
        )}

        {/* Client preference chips — the INPUTS the options were found against.
            «تعديل التفضيلات» expands the same editable panel the Workspace
            sidebar uses (PreferenceSummary) right here, saving to the client. */}
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
          {canEdit && onFindMore && (
            <button
              type="button"
              onClick={onFindMore}
              title={L('عدّل التفضيلات (إلزامي/مفضّل ونطاقات ±) ثم ابحث', 'Edit preferences (hard/soft + ± bands) then search')}
              className="inline-flex items-center gap-1 rounded-full border border-copper/50 bg-white px-2 py-0.5 text-[11px] font-bold text-copper transition hover:bg-copper/10"
            >
              <Pencil size={11} /> {L('تعديل التفضيلات', 'Edit preferences')}
            </button>
          )}
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

      {/* Project units inventory — opened from a project option's "Units" button.
          Reuses UnitsInventory (filters, sort, unit drawer, compare, PDF). The
          shared Modal portals to body at z-50, above the z-40 client-options /
          360 hosts. */}
      {unitsFor && (
        <Modal
          open
          onClose={() => setUnitsFor(null)}
          title={isAr ? `وحدات المشروع — ${unitsFor.name}` : `Project units — ${unitsFor.name}`}
          maxWidth="max-w-6xl"
        >
          <UnitsInventory projectId={unitsFor.projectId} projectName={unitsFor.name} isAr={isAr} />
        </Modal>
      )}

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

      {/* Hard-delete confirm — spells out how it differs from eliminate. */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4" onMouseDown={() => setDeleteTarget(null)}>
          <div className="w-full max-w-md rounded-2xl bg-cream p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()} dir={isAr ? 'rtl' : 'ltr'}>
            <div className="mb-2 flex items-center gap-2 text-chocolate">
              <Trash2 size={18} className="text-charcoal/70" />
              <h3 className="text-base font-bold">
                {deleteTarget === 'bulk'
                  ? L(`حذف ${selectedIds.size} خيار من قائمة العميل`, `Delete ${selectedIds.size} options from the client’s list`)
                  : L('حذف الخيار من قائمة العميل', 'Delete option from the client’s list')}
              </h3>
            </div>
            {deleteTarget !== 'bulk' && (
              <p className="mb-2 text-sm font-semibold text-charcoal/80">{String(deleteTarget.data.source_name ?? '')}</p>
            )}
            <p className="mb-2 text-xs leading-5 text-charcoal/70">
              {L('سيُحذف من قائمة خيارات هذا العميل فقط. العقار نفسه (المشروع / الوحدة / إعلان السوق) لن يُحذف، ويمكن إيجاده في البحث وإضافته لهذا العميل مرة أخرى.',
                 'It is removed from THIS client’s options only. The property itself (project / unit / market listing) is not deleted, and it can be found in search and added to this client again.')}
            </p>
            <p className="mb-4 rounded-lg bg-white/70 px-2.5 py-1.5 text-[11px] leading-5 text-charcoal/60">
              {L('الفرق عن «استبعاد»: الاستبعاد يبقي الخيار مع سببه ويمنع إضافته مرة أخرى من البحث. الحذف يزيله تماماً حتى يظهر في عمليات البحث القادمة.',
                 'Difference from “Eliminate”: eliminating keeps the option with its reason and blocks it from being re-added by search. Deleting removes it entirely so it can appear in future searches.')}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteTarget(null)} className="rounded-lg border border-sand/60 bg-white px-3 py-2 text-sm font-bold text-charcoal/75 transition hover:bg-cream/60">{L('إلغاء', 'Cancel')}</button>
              <button type="button" onClick={confirmDelete} className="inline-flex items-center gap-1.5 rounded-lg bg-charcoal px-3.5 py-2 text-sm font-bold text-white transition hover:bg-charcoal/85">
                <Trash2 size={15} /> {L('حذف', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Eliminate-with-notes modal — single option OR the whole selection
          (one shared reason, applied to every selected option). */}
      {(eliminateTarget || bulkEliminate) && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4"
          onMouseDown={() => { if (busyId == null && !bulkBusy) { setEliminateTarget(null); setBulkEliminate(false); } }}
        >
          <div className="w-full max-w-md rounded-2xl bg-cream p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()} dir={isAr ? 'rtl' : 'ltr'}>
            <div className="mb-2 flex items-center gap-2 text-chocolate">
              <XCircle size={18} className="text-red-600" />
              <h3 className="text-base font-bold">
                {bulkEliminate
                  ? L(`استبعاد ${selectedIds.size} خيار`, `Eliminate ${selectedIds.size} options`)
                  : L('استبعاد الخيار', 'Eliminate option')}
              </h3>
            </div>
            <p className="mb-3 text-sm text-charcoal/70">
              {bulkEliminate
                ? L('سيُطبَّق نفس السبب على كل الخيارات المحددة.', 'The same reason is applied to every selected option.')
                : String(eliminateTarget?.data.source_name ?? '')}
            </p>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{L('سبب الاستبعاد', 'Elimination reason')}</label>
            <textarea value={eliminateNotes} onChange={(e) => setEliminateNotes(e.target.value)} rows={3} autoFocus placeholder={L('مثال: خارج الميزانية…', 'e.g. over budget…')} className="form-input w-full resize-none" />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => { setEliminateTarget(null); setBulkEliminate(false); }} className="rounded-lg border border-sand/60 bg-white px-3 py-2 text-sm font-bold text-charcoal/75 transition hover:bg-cream/60">{L('إلغاء', 'Cancel')}</button>
              <button type="button" onClick={confirmEliminate} disabled={busyId != null || bulkBusy} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50">
                {busyId != null || bulkBusy ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />} {L('استبعاد', 'Eliminate')}
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
