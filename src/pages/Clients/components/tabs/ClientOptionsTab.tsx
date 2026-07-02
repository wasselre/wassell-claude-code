import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ListChecks, Star, ExternalLink, XCircle, RotateCcw, Loader2, Building2, MapPin,
  Wallet, Ruler, BedDouble, Bath, PackageCheck, Pencil, Check, Filter, Plus, Compass,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import {
  CLIENT_OPTION_STATUS_META, CLIENT_OPTION_SOURCE_META, CLIENT_OPTION_STATUS_ORDER,
  optionSourceUrl, setMainOption, updateOptionStatus, eliminateOption, reactivateOption,
  updateSalesNotes,
  type ClientOptionStatus, type ClientOptionSourceType, type ClientOptionData,
} from '@/lib/matching/clientOptions';
import ContactAdvertiserButton from '@/components/market/ContactAdvertiserButton';
import AddOptionModal from '../AddOptionModal';

interface Props {
  client: AppRecord;
  isAr: boolean;
  canEdit: boolean;
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
 * last). Filter by status. The preference INPUTS live on the Preferences tab and
 * are never touched here — this tab is the OUTPUT list, plus two ways to ADD to
 * it: open the client-scoped Project Finder, or manually pick a specific
 * project / unit / market listing (AddOptionModal, added_from='manual').
 */
export default function ClientOptionsTab({ client, isAr, canEdit }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const navigate = useNavigate();
  const records = useAppStore((s) => s.records);
  const models = useAppStore((s) => s.models);
  const addToast = useAppStore((s) => s.addToast);

  const modelId = useMemo(() => models.find((m) => m.name === 'client_property_options')?.id ?? null, [models]);
  const options = useMemo(
    () => (modelId ? (records[modelId] ?? []).filter((r) => r.data.client_id === client.id) : []),
    [records, modelId, client.id],
  );

  const [statusFilter, setStatusFilter] = useState<ClientOptionStatus | 'all'>('all');
  const [showEliminated, setShowEliminated] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editNotesId, setEditNotesId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [eliminateTarget, setEliminateTarget] = useState<AppRecord | null>(null);
  const [eliminateNotes, setEliminateNotes] = useState('');
  const [addOpen, setAddOpen] = useState(false);

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
    return options
      .filter((r) => {
        const s = r.data.status as ClientOptionStatus;
        if (statusFilter !== 'all') return s === statusFilter;
        if (s === 'eliminated' && !showEliminated) return false;
        return true;
      })
      .sort((a, b) => {
        const am = a.data.is_main === true ? 0 : 1;
        const bm = b.data.is_main === true ? 0 : 1;
        if (am !== bm) return am - bm;
        const ao = order(a.data.status as ClientOptionStatus);
        const bo = order(b.data.status as ClientOptionStatus);
        if (ao !== bo) return ao - bo;
        const as = typeof a.data.match_score === 'number' ? a.data.match_score : -1;
        const bs = typeof b.data.match_score === 'number' ? b.data.match_score : -1;
        return bs - as;
      });
  }, [options, statusFilter, showEliminated]);

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

  if (!modelId) {
    return <div className="rounded-2xl border border-sand/30 bg-white p-6 text-sm text-charcoal/55">{L('نموذج خيارات العميل غير محمّل.', 'Client options model not loaded.')}</div>;
  }

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-sand/30 bg-white px-4 py-3">
        <ListChecks size={16} className="text-copper" />
        <span className="text-sm font-bold text-charcoal">{L('خيارات العميل', 'Client Options')}</span>
        <span className="rounded-full bg-sand/30 px-2 py-0.5 text-[11px] font-semibold text-charcoal/70">{options.length}</span>
        <div className="flex-1" />
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
        {canEdit && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1 rounded-lg bg-copper px-2.5 py-1 text-xs font-bold text-white transition hover:bg-terracotta"
          >
            <Plus size={13} /> {L('إضافة خيار', 'Add option')}
          </button>
        )}
      </div>

      {/* Empty state */}
      {options.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-sand/30 bg-white px-6 py-12 text-center text-charcoal/55">
          <ListChecks size={26} className="text-copper/60" />
          <p className="text-sm">{L('لا توجد خيارات محفوظة لهذا العميل بعد. ابحث عن المشاريع المطابقة أو أضف خياراً تعرفه مباشرة.', 'No saved options yet. Find matching projects or add a specific option you already know.')}</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => navigate(`/model/clients/${client.id}/projects`)}
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

      {/* Option cards */}
      {visible.map((r) => {
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
      })}

      {/* Manual add-option picker */}
      {addOpen && <AddOptionModal clientId={client.id} isAr={isAr} onClose={() => setAddOpen(false)} />}

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
