import { useMemo, useState } from 'react';
import { Plus, Search, X, Loader2, Building2, MapPin, Check } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  saveClientOption, CLIENT_OPTION_STATUS_META, CLIENT_OPTION_SOURCE_META,
  type ClientOptionSourceType, type ClientOptionStatus,
} from '@/lib/matching/clientOptions';
import {
  modelByName, geoName, rollupByKind, asString, asFiniteNumber,
  type ProjectStoreSlices,
} from '@/lib/projects/projectView';
import type { AppModel, AppRecord } from '@/types';

interface Props {
  clientId: string;
  isAr: boolean;
  onClose: () => void;
}

const SOURCE_TABS: ClientOptionSourceType[] = ['project', 'unit', 'market_listing'];
const MAX_RESULTS = 30;

/** One row in the picker: the source record + its resolved display strings. */
interface Candidate {
  rec: AppRecord;
  name: string;
  location: string;
  price: string | null;
}

const firstId = (v: unknown): string | null =>
  Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : typeof v === 'string' && v ? v : null;

const locOf = (data: Record<string, unknown>): Record<string, unknown> =>
  data.location && typeof data.location === 'object' && !Array.isArray(data.location)
    ? (data.location as Record<string, unknown>)
    : {};

const fmtN = (n: number) => n.toLocaleString('en-US');

function fmtPrice(v: unknown, cur: string): string | null {
  const n = asFiniteNumber(v);
  if (n != null) return `${fmtN(n)} ${cur}`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const min = asFiniteNumber(o.min);
    const max = asFiniteNumber(o.max);
    if (min != null && max != null) return min === max ? `${fmtN(min)} ${cur}` : `${fmtN(min)} – ${fmtN(max)} ${cur}`;
    if (min != null || max != null) return `${fmtN((min ?? max)!)} ${cur}`;
  }
  return null;
}

const scalarRange = (v: unknown): { min: number; max: number } | undefined => {
  const n = asFiniteNumber(v);
  return n != null ? { min: n, max: n } : undefined;
};

/** Facts snapshot per source — same keys the Project Finder puts on its cards
 *  (only present values), so manual options render identically in the tab. */
function buildFacts(
  store: ProjectStoreSlices,
  sourceType: ClientOptionSourceType,
  rec: AppRecord,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v) && v.length === 0) return;
    facts[k] = v;
  };
  const data = rec.data as Record<string, unknown>;

  if (sourceType === 'project') {
    const ap = modelByName(store.models, 'all_projects');
    const loc = locOf(data);
    put('city', geoName(store, 'cities', firstId(loc.city)));
    put('district', geoName(store, 'districts', firstId(loc.district)));
    put('unit_types', Array.isArray(data.unit_types) ? data.unit_types : undefined);
    put('project_status', asString(data.project_status));
    put('price_range', rollupByKind(ap, data, 'price_range') ?? data.price_range);
    put('area_range', rollupByKind(ap, data, 'area_range') ?? data.area_range);
    put('bedroom_range', rollupByKind(ap, data, 'bedroom_range') ?? data.bedroom_range);
    put('bathroom_range', rollupByKind(ap, data, 'bathroom_range') ?? data.bathroom_range);
    put('unit_count', asFiniteNumber(rollupByKind(ap, data, 'units_count') ?? data.unit_count));
    put('available_units', asFiniteNumber(rollupByKind(ap, data, 'units_available_count') ?? data.available_units));
    const firstImage = Array.isArray(data.project_images)
      ? (data.project_images.find((x) => typeof x === 'string' && x) as string | undefined)
      : undefined;
    put('image', asString(data.main_image) ?? firstImage);
    return facts;
  }

  if (sourceType === 'market_listing') {
    const loc = locOf(data);
    put('city', geoName(store, 'cities', firstId(loc.city)));
    put('district', geoName(store, 'districts', firstId(loc.district)));
    const types = [asString(data.property_type), asString(data.listing_type), asString(data.category)].filter(Boolean);
    put('unit_types', types);
    put('price_range', scalarRange(data.price));
    put('area_range', scalarRange(data.area));
    put('bedroom_range', scalarRange(data.bedrooms));
    put('bathroom_range', scalarRange(data.bathrooms));
    put('available_units', data.is_active === true ? 1 : 0);
    put('image', asString(data.main_image_url));
    put('external_id', asString(data.external_id));
    // DB-computed listing quality — rides in the slim store, snapshotted here
    // like the finder's facts so the option card shows the same grade chip.
    put('quality_score', asFiniteNumber(data.quality_score));
    put('quality_grade', asString(data.quality_grade));
    return facts;
  }

  // unit — a single unit; geography comes from its parent project.
  const project = firstId(data.project_id);
  if (project) {
    const ap = modelByName(store.models, 'all_projects');
    const projRec = ap ? (store.records[ap.id] ?? []).find((r) => r.id === project) : undefined;
    if (projRec) {
      const loc = locOf(projRec.data as Record<string, unknown>);
      put('city', geoName(store, 'cities', firstId(loc.city)));
      put('district', geoName(store, 'districts', firstId(loc.district)));
    }
  }
  const unitType = asString(data.unit_type);
  put('unit_types', unitType ? [unitType] : undefined);
  put('price_range', scalarRange(data.total_price));
  put('area_range', scalarRange(data.unit_area));
  put('bedroom_range', scalarRange(data.bedrooms));
  put('bathroom_range', scalarRange(data.bathrooms));
  return facts;
}

/**
 * Manual "add option" picker for the Client 360 Options tab. Lets the rep add a
 * specific project / unit / market listing they already know about (e.g. one the
 * client mentioned) WITHOUT running the Project Finder. Deterministic in-store
 * search only — no AI, no server call. Saves through the same
 * `saveClientOption` engine (dedup + eliminated-guard) with added_from='manual'.
 */
export default function AddOptionModal({ clientId, isAr, onClose }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);
  const store: ProjectStoreSlices = { models, records };

  const [tab, setTab] = useState<ClientOptionSourceType>('project');
  const [query, setQuery] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  const cur = L('ر.س', 'SAR');

  const modelFor = (t: ClientOptionSourceType): AppModel | undefined =>
    modelByName(models, t === 'market_listing' ? 'market_listings' : t === 'unit' ? 'units' : 'all_projects');

  // Existing options for this client → `${source_type}:${source_id}` → status,
  // so rows the client already has show their status instead of an Add button.
  const existingByKey = useMemo(() => {
    const map: Record<string, ClientOptionStatus> = {};
    const m = modelByName(models, 'client_property_options');
    if (!m) return map;
    for (const r of records[m.id] ?? []) {
      if (r.data.client_id !== clientId) continue;
      map[`${r.data.source_type}:${r.data.source_id}`] = r.data.status as ClientOptionStatus;
    }
    return map;
  }, [models, records, clientId]);

  // Market listings are ~46k slim rows — require a query before listing any.
  const needsQuery = tab === 'market_listing' && query.trim().length < 2;

  const candidates = useMemo<Candidate[]>(() => {
    const m = modelFor(tab);
    if (!m || needsQuery) return [];
    const q = query.trim().toLowerCase();
    const ap = modelByName(models, 'all_projects');
    const projName = (id: string | null): string => {
      if (!id || !ap) return '';
      const p = (records[ap.id] ?? []).find((r) => r.id === id);
      return p ? asString((p.data as Record<string, unknown>).project_name) ?? '' : '';
    };

    const out: Candidate[] = [];
    for (const rec of records[m.id] ?? []) {
      const d = rec.data as Record<string, unknown>;
      let name = '';
      let searchable = '';
      let location = '';
      let price: string | null = null;

      if (tab === 'project') {
        name = asString(d.project_name) ?? '';
        searchable = name;
        const loc = locOf(d);
        location = [geoName(store, 'districts', firstId(loc.district)), geoName(store, 'cities', firstId(loc.city))]
          .filter(Boolean).join('، ');
        price = fmtPrice(rollupByKind(ap, d, 'price_range') ?? d.price_range, cur);
      } else if (tab === 'unit') {
        const code = asString(d.unit_code) ?? asString(d.unit_number) ?? '';
        const parent = projName(firstId(d.project_id));
        name = [parent, code].filter(Boolean).join(' — ') || L('وحدة بدون رقم', 'Unnamed unit');
        searchable = `${code} ${parent}`;
        location = asString(d.unit_model) ?? '';
        price = fmtPrice(d.total_price, cur);
      } else {
        // Market listings always lead with their Aqar ad id ("@123456 — title")
        // so the id is visible in the picker AND lands in the saved option's
        // source_name.
        const extId = asString(d.external_id);
        const base = asString(d.title) ?? asString(d.advertiser_name) ?? '';
        name = extId ? `@${extId}${base ? ` — ${base}` : ''}` : base;
        searchable = `${name} ${asString(d.advertiser_name) ?? ''}`;
        const loc = locOf(d);
        location = [geoName(store, 'districts', firstId(loc.district)), geoName(store, 'cities', firstId(loc.city))]
          .filter(Boolean).join('، ');
        price = fmtPrice(d.price, cur);
      }

      if (!name) continue;
      if (q && !searchable.toLowerCase().includes(q)) continue;
      out.push({ rec, name, location, price });
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, query, models, records, clientId, needsQuery]);

  async function onAdd(c: Candidate) {
    setSavingId(c.rec.id);
    const res = await saveClientOption({
      clientId,
      sourceType: tab,
      sourceId: c.rec.id,
      sourceName: c.name,
      facts: buildFacts(store, tab, c.rec),
      addedFrom: 'manual',
      status: 'suitable',
    });
    setSavingId(null);
    if (res.outcome === 'created' || res.outcome === 'queued') {
      setSavedIds((s) => new Set(s).add(c.rec.id));
      addToast(L('تمت إضافة الخيار للعميل.', 'Option added to the client.'), 'success');
    } else if (res.outcome === 'updated') {
      addToast(L('الخيار محفوظ مسبقاً — تم تحديث بياناته.', 'Already saved — details refreshed.'), 'success');
    } else if (res.outcome === 'eliminated_exists') {
      addToast(L('هذا الخيار مستبعد سابقاً لهذا العميل — أعد تفعيله من قائمة الخيارات.', 'This option was eliminated for this client — reactivate it from the options list.'), 'error');
    } else {
      addToast(L('تعذّرت إضافة الخيار.', 'Could not add the option.'), 'error');
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4" onMouseDown={() => savingId == null && onClose()}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-cream p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        dir={isAr ? 'rtl' : 'ltr'}
      >
        {/* Header */}
        <div className="mb-3 flex items-center gap-2">
          <Plus size={18} className="text-copper" />
          <h3 className="flex-1 text-base font-bold text-chocolate">{L('إضافة خيار للعميل', 'Add option for client')}</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-charcoal/45 transition hover:bg-white hover:text-charcoal" aria-label={L('إغلاق', 'Close')}>
            <X size={17} />
          </button>
        </div>

        {/* Source tabs */}
        <div className="mb-3 flex flex-wrap gap-1">
          {SOURCE_TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTab(t); setQuery(''); }}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${tab === t ? 'bg-copper text-white' : 'bg-white text-charcoal/70 hover:bg-cream/70'}`}
            >
              {isAr ? CLIENT_OPTION_SOURCE_META[t].ar : CLIENT_OPTION_SOURCE_META[t].en}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="mb-3 flex items-center gap-1.5 rounded-lg border border-sand/60 bg-white px-2.5 py-2">
          <Search size={14} className="shrink-0 text-charcoal/40" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            placeholder={
              tab === 'project' ? L('ابحث باسم المشروع…', 'Search by project name…')
              : tab === 'unit' ? L('ابحث برقم الوحدة أو اسم المشروع…', 'Search by unit number or project name…')
              : L('ابحث بعنوان الإعلان أو رقمه أو اسم المعلن…', 'Search by ad title, id, or advertiser…')
            }
            className="w-full bg-transparent text-sm text-charcoal placeholder:text-charcoal/35 focus:outline-none"
          />
        </div>

        {/* Results */}
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          {needsQuery && (
            <div className="px-3 py-8 text-center text-sm text-charcoal/55">
              {L('اكتب حرفين على الأقل للبحث في إعلانات السوق.', 'Type at least two characters to search market listings.')}
            </div>
          )}
          {!needsQuery && candidates.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-charcoal/55">{L('لا نتائج مطابقة.', 'No matching results.')}</div>
          )}
          {candidates.map((c) => {
            const existing = existingByKey[`${tab}:${c.rec.id}`];
            const justSaved = savedIds.has(c.rec.id);
            const busy = savingId === c.rec.id;
            return (
              <div key={c.rec.id} className="flex items-center gap-2.5 rounded-lg border border-sand/50 bg-white px-3 py-2">
                <Building2 size={15} className="shrink-0 text-charcoal/45" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-charcoal">{c.name}</div>
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-charcoal/55">
                    {c.location && (
                      <span className="inline-flex items-center gap-0.5"><MapPin size={10} className="text-copper" />{c.location}</span>
                    )}
                    {c.price && <span>{c.price}</span>}
                  </div>
                </div>
                {existing && !justSaved ? (
                  <span
                    className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-bold"
                    style={{
                      color: (CLIENT_OPTION_STATUS_META[existing] ?? CLIENT_OPTION_STATUS_META.suitable).color,
                      borderColor: `${(CLIENT_OPTION_STATUS_META[existing] ?? CLIENT_OPTION_STATUS_META.suitable).color}55`,
                      backgroundColor: `${(CLIENT_OPTION_STATUS_META[existing] ?? CLIENT_OPTION_STATUS_META.suitable).color}12`,
                    }}
                  >
                    {isAr ? (CLIENT_OPTION_STATUS_META[existing] ?? CLIENT_OPTION_STATUS_META.suitable).ar : (CLIENT_OPTION_STATUS_META[existing] ?? CLIENT_OPTION_STATUS_META.suitable).en}
                  </span>
                ) : justSaved ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-bold text-green-700">
                    <Check size={12} /> {L('أُضيف', 'Added')}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAdd(c)}
                    disabled={busy}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-copper px-2.5 py-1.5 text-[11px] font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} {L('إضافة', 'Add')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
