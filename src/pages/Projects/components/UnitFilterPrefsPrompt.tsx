/**
 * «Apply this filter to the client's preferences?» (operator, 2026-10-05).
 *
 * Shown inside a project's units window when a client is in context: a moment
 * after the rep changes the bedrooms / price / size / unit-type filter, it asks
 * whether to carry that change into the client's preferences — never applied
 * without the rep's yes. Status and floor are not client preferences and never
 * ask. Clearing a filter does not ask (clearing usually means "show me
 * everything", not "the client has no preference").
 *
 * Where the yes goes:
 *   · inside a follow-up (the qualification session is open for THIS client) →
 *     the session draft (setRepEdit), which the page's autosave persists — so
 *     the inline panel, the floating pop-up and the finder all see it;
 *   · anywhere else → a versioned save of just those fields to the client.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, SlidersHorizontal, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import * as session from '@/lib/salesProcess/qualificationSession';
import { saveClientPreferences } from '@/lib/clients/preferences';
import type { OptionView } from '@/lib/projects/projectView';

export interface UnitFilterValues {
  /** The unit-type filter's option (null = all types). */
  type: OptionView | null;
  bedMin: string; bedMax: string;
  priceMin: string; priceMax: string;
  areaMin: string; areaMax: string;
}

interface Props {
  isAr: boolean;
  clientId: string;
  filters: UnitFilterValues;
}

const ASK_AFTER_MS = 800;

const num = (s: string): number | undefined => (s ? Number(s) : undefined);
const range = (lo: string, hi: string): { min?: number; max?: number } | null => {
  const min = num(lo), max = num(hi);
  if (min === undefined && max === undefined) return null;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
};

export default function UnitFilterPrefsPrompt({ isAr, clientId, filters }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);

  const clientsModel = models.find((m) => m.name === 'clients');
  const clientRec = clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === clientId) ?? null : null;
  const unitTypeOptions = useMemo(
    () => (clientsModel?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === 'preferred_unit_type')?.options ?? []),
    [clientsModel],
  );

  // The candidate preference patch from the current filters.
  const patch = useMemo(() => {
    const p: Record<string, unknown> = {};
    const beds = range(filters.bedMin, filters.bedMax); if (beds) p.preferred_bedrooms = beds;
    const budget = range(filters.priceMin, filters.priceMax); if (budget) p.budget = budget;
    const area = range(filters.areaMin, filters.areaMax); if (area) p.preferred_area = area;
    if (filters.type) {
      // Client unit types are stored by their own option value (e.g. «شقة»); match
      // the unit's type by value or by its Arabic / English label.
      const t = filters.type;
      const hit = unitTypeOptions.find((o) => o.value === t.value || o.label_ar === t.label_ar || o.label_en === t.label_en || o.value === t.label_ar);
      if (hit) p.preferred_unit_type = [hit.value];
    }
    return p;
  }, [filters, unitTypeOptions]);

  // What the client has now (the open follow-up's draft when there is one).
  const current = (): Record<string, unknown> => {
    const snap = session.getSnapshot();
    if (snap.clientId === clientId && snap.followupId) return snap.qual.draft;
    return (clientRec?.data as Record<string, unknown> | undefined) ?? {};
  };

  // Ask a moment after the filters settle; only for fields that differ from the
  // client's preference AND from the rep's last answer for that field.
  const decided = useRef<Record<string, string>>({});
  const [ask, setAsk] = useState<Record<string, unknown> | null>(null);
  const patchKey = JSON.stringify(patch);
  useEffect(() => {
    const t = setTimeout(() => {
      const cur = current();
      const diff: Record<string, unknown> = {};
      for (const [slug, v] of Object.entries(patch)) {
        const k = JSON.stringify(v);
        if (decided.current[slug] === k) continue;
        if (JSON.stringify(cur[slug] ?? null) === k) continue;
        diff[slug] = v;
      }
      setAsk(Object.keys(diff).length ? diff : null);
    }, ASK_AFTER_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchKey]);

  if (!ask) return null;

  const fmtRange = (v: unknown, unit: string) => {
    const r = v as { min?: number; max?: number };
    const f = (n: number) => n.toLocaleString('en-US');
    if (r.min !== undefined && r.max !== undefined) return `${f(r.min)}–${f(r.max)}${unit}`;
    if (r.max !== undefined) return L(`حتى ${f(r.max)}${unit}`, `up to ${f(r.max)}${unit}`);
    return L(`من ${f(r.min!)}${unit}`, `from ${f(r.min!)}${unit}`);
  };
  const parts = Object.entries(ask).map(([slug, v]) => {
    if (slug === 'preferred_bedrooms') return `${L('الغرف', 'Bedrooms')}: ${fmtRange(v, '')}`;
    if (slug === 'budget') return `${L('الميزانية', 'Budget')}: ${fmtRange(v, L(' ر.س', ' SAR'))}`;
    if (slug === 'preferred_area') return `${L('المساحة', 'Size')}: ${fmtRange(v, L(' م²', ' m²'))}`;
    const o = unitTypeOptions.find((x) => x.value === (v as string[])[0]);
    return `${L('نوع الوحدة', 'Unit type')}: ${o ? (isAr ? o.label_ar : o.label_en) : (v as string[])[0]}`;
  });

  const remember = () => { for (const [slug, v] of Object.entries(ask)) decided.current[slug] = JSON.stringify(v); setAsk(null); };

  const apply = async () => {
    const values = ask;
    remember();
    const snap = session.getSnapshot();
    if (snap.clientId === clientId && snap.followupId) {
      for (const [slug, v] of Object.entries(values)) session.setRepEdit(slug, v);
      addToast(L('طُبّقت على تفضيلات العميل', "Applied to the client's preferences"), 'success');
      return;
    }
    if (!clientRec) { addToast(L('العميل غير محمّل — لم يُطبَّق', 'Client not loaded — not applied'), 'error'); return; }
    const res = await saveClientPreferences({
      client: clientRec,
      draft: { ...clientRec.data, ...values },
      slugs: Object.keys(values),
      saveRecord,
      expectedVersion: clientRec.version ?? null,
      isAr,
    });
    addToast(res.ok ? L('طُبّقت على تفضيلات العميل', "Applied to the client's preferences") : res.message, res.ok ? 'success' : res.tone);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-copper/40 bg-copper/5 px-3 py-2 text-xs">
      <SlidersHorizontal size={14} className="shrink-0 text-copper" />
      <span className="min-w-0 flex-1 font-semibold text-chocolate">
        {L('تطبيق هذا الفلتر على تفضيلات العميل؟', "Apply this filter to the client's preferences?")}{' '}
        <span className="font-normal text-charcoal/70">{parts.join(' · ')}</span>
      </span>
      <button type="button" onClick={() => void apply()}
        className="inline-flex items-center gap-1 rounded-md bg-copper px-2.5 py-1 font-bold text-white hover:bg-terracotta">
        <Check size={12} /> {L('طبّق', 'Apply')}
      </button>
      <button type="button" onClick={remember}
        className="inline-flex items-center gap-1 rounded-md border border-sand bg-white px-2.5 py-1 font-semibold text-charcoal/70 hover:bg-cream">
        <X size={12} /> {L('لا', 'No')}
      </button>
    </div>
  );
}
