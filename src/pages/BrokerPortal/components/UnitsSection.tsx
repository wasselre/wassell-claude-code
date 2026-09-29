/**
 * Units inventory for the broker page: filters, a responsive list, and a unit
 * sheet (floor plan, components, payment plans with SAR amounts, share).
 */

import { useEffect, useMemo, useState } from 'react';
import { BedDouble, Bath, Check, Copy, Maximize2, MessageCircle, Ruler, X } from 'lucide-react';
import type { PortalFile, PortalUnit, UnitStatus } from '../lib/api';
import { bi, fmtMoney, fmtNum, fmtPct, makeT } from '../lib/i18n';
import { Lightbox } from './Media';
import { flash } from '../lib/flash';

type StatusFilter = UnitStatus | 'all';
type Sort = 'price_asc' | 'price_desc' | 'area_desc' | 'number';

const STATUS_STYLE: Record<UnitStatus, string> = {
  available: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  reserved: 'bg-amber-50 text-amber-700 border-amber-200',
  sold: 'bg-rose-50 text-rose-700 border-rose-200',
  other: 'bg-cream text-charcoal/70 border-sand',
};

export function StatusPill({ unit, isAr }: { unit: PortalUnit; isAr: boolean }) {
  const t = makeT(isAr);
  const text = unit.status === 'other' ? bi(unit.status_label, isAr) : t(unit.status);
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-bold whitespace-nowrap ${STATUS_STYLE[unit.status]}`}>
      {text}
    </span>
  );
}

/** A payment schedule ("20% عند التعاقد · 10% عند إنجاز 20% · …") as one
 *  bullet per instalment. In Arabic the percent sign becomes «٪» so bidi keeps
 *  it beside its number instead of flipping it to the far side. */
export function ScheduleList({ schedule, isAr }: { schedule: string; isAr: boolean }) {
  const steps = schedule.split(/\s*[·•|]\s*|\n+/).map((s) => s.trim()).filter(Boolean);
  return (
    <ul className="mt-3 space-y-1.5">
      {steps.map((s, i) => (
        <li key={`${i}-${s}`} className="flex items-start gap-2 text-xs text-charcoal/80 leading-relaxed">
          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-copper shrink-0" />
          <span>{isAr ? s.replace(/%/g, '٪') : s}</span>
        </li>
      ))}
    </ul>
  );
}

export function unitTitle(u: PortalUnit, isAr: boolean): string {
  const t = makeT(isAr);
  const parts = [bi(u.type, isAr) || t('unit')];
  if (u.number) parts.push(`#${u.number}`);
  if (u.building) parts.push(`${t('building')} ${u.building}`);
  return parts.join(' · ');
}

function numKey(v: string | null): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

export default function UnitsSection({
  units, filesById, isAr, projectName, focusUnitIds, onClearFocus, initialUnitId, shareBaseUrl,
}: {
  units: PortalUnit[];
  filesById: Map<string, PortalFile>;
  isAr: boolean;
  projectName: string;
  /** Set when arriving from a floor plan card: show only those units. */
  focusUnitIds: string[] | null;
  onClearFocus: () => void;
  initialUnitId: string | null;
  shareBaseUrl: string;
}) {
  const t = makeT(isAr);
  const hasAvailable = units.some((u) => u.status === 'available');
  const [status, setStatus] = useState<StatusFilter>(hasAvailable ? 'available' : 'all');
  const [type, setType] = useState('');
  const [beds, setBeds] = useState('');
  const [building, setBuilding] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [sort, setSort] = useState<Sort>('price_asc');
  const [openId, setOpenId] = useState<string | null>(initialUnitId);

  const types = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of units) if (u.type) m.set(u.type.ar, bi(u.type, isAr));
    return [...m.entries()];
  }, [units, isAr]);
  const bedOptions = useMemo(
    () => [...new Set(units.map((u) => u.bedrooms).filter((b): b is number => b != null))].sort((a, b) => a - b),
    [units],
  );
  const buildings = useMemo(
    () => [...new Set(units.map((u) => u.building).filter((b): b is string => !!b))].sort((a, b) => numKey(a) - numKey(b)),
    [units],
  );
  const counts = useMemo(() => {
    const c = { all: units.length, available: 0, reserved: 0, sold: 0, other: 0 };
    for (const u of units) c[u.status]++;
    return c;
  }, [units]);

  const shown = useMemo(() => {
    const focus = focusUnitIds ? new Set(focusUnitIds) : null;
    const max = Number(maxPrice.replace(/[^\d]/g, ''));
    const list = units.filter((u) => {
      if (focus && !focus.has(u.id)) return false;
      if (status !== 'all' && u.status !== status) return false;
      if (type && u.type?.ar !== type) return false;
      if (beds && String(u.bedrooms) !== beds) return false;
      if (building && u.building !== building) return false;
      if (max > 0 && (u.price == null || u.price > max)) return false;
      return true;
    });
    const price = (u: PortalUnit) => u.price ?? Number.MAX_SAFE_INTEGER;
    list.sort((a, b) => {
      switch (sort) {
        case 'price_asc': return price(a) - price(b);
        case 'price_desc': return (b.price ?? -1) - (a.price ?? -1);
        case 'area_desc': return (b.area ?? -1) - (a.area ?? -1);
        default: return numKey(a.building) - numKey(b.building) || numKey(a.number) - numKey(b.number);
      }
    });
    return list;
  }, [units, focusUnitIds, status, type, beds, building, maxPrice, sort]);

  const openUnit = units.find((u) => u.id === openId) ?? null;
  const select = 'h-10 rounded-lg border border-sand bg-white px-3 text-sm text-charcoal focus:outline-none focus:border-copper';

  if (units.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-sand bg-white/60 py-14 text-center text-charcoal/50 text-sm">
        {t('nothingHere')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Status chips */}
      <div className="flex flex-wrap gap-2">
        {(['available', 'reserved', 'sold', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`px-3.5 py-1.5 rounded-full text-sm font-bold border transition ${
              status === s ? 'bg-chocolate text-white border-chocolate' : 'bg-white text-charcoal border-sand hover:border-copper'
            }`}
          >
            {t(s)} <span className="opacity-60 ms-1">{counts[s]}</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {types.length > 1 && (
          <select className={select} value={type} onChange={(e) => setType(e.target.value)} aria-label={t('type')}>
            <option value="">{t('anyType')}</option>
            {types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {bedOptions.length > 1 && (
          <select className={select} value={beds} onChange={(e) => setBeds(e.target.value)} aria-label={t('bedrooms')}>
            <option value="">{t('anyBedrooms')}</option>
            {bedOptions.map((b) => <option key={b} value={String(b)}>{b} {t('rooms')}</option>)}
          </select>
        )}
        {buildings.length > 1 && (
          <select className={select} value={building} onChange={(e) => setBuilding(e.target.value)} aria-label={t('building')}>
            <option value="">{t('anyBuilding')}</option>
            {buildings.map((b) => <option key={b} value={b}>{t('building')} {b}</option>)}
          </select>
        )}
        <input
          className={select}
          inputMode="numeric"
          placeholder={`${t('maxPrice')} (${t('sar')})`}
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
        />
        <select className={select} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t('sortBy')}>
          <option value="price_asc">{t('sortPriceAsc')}</option>
          <option value="price_desc">{t('sortPriceDesc')}</option>
          <option value="area_desc">{t('sortAreaDesc')}</option>
          <option value="number">{t('sortNumber')}</option>
        </select>
      </div>

      <div className="flex items-center justify-between text-sm text-charcoal/60">
        <span>{shown.length} {t('unitsShown')}</span>
        {focusUnitIds && (
          <button type="button" onClick={onClearFocus} className="inline-flex items-center gap-1 text-copper font-bold">
            <X size={14} /> {t('viewPlan')} — {t('all')}
          </button>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-sand bg-white/60 py-12 text-center text-charcoal/50 text-sm">{t('noResults')}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {shown.map((u) => {
            const plan = u.plan_file_id ? filesById.get(u.plan_file_id) : undefined;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => setOpenId(u.id)}
                className="text-start flex gap-3 p-3 rounded-2xl bg-white border border-sand/50 hover:border-copper hover:shadow-md transition"
              >
                <div className="w-24 h-24 rounded-xl bg-cream-50 border border-sand/40 overflow-hidden shrink-0 flex items-center justify-center">
                  {plan ? (
                    <img src={plan.thumb ?? plan.url} alt="" loading="lazy" className="w-full h-full object-contain" />
                  ) : (
                    <Ruler size={22} className="text-sand-dark" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-bold text-chocolate truncate">{unitTitle(u, isAr)}</div>
                    <StatusPill unit={u} isAr={isAr} />
                  </div>
                  <div className="mt-1 text-xs text-charcoal/60 truncate">
                    {[u.model && `${t('model')} ${u.model}`, bi(u.floor, isAr) && `${t('floor')} ${bi(u.floor, isAr)}`].filter(Boolean).join(' · ')}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-charcoal">
                    {u.area != null && <span className="inline-flex items-center gap-1"><Ruler size={13} className="text-copper" />{fmtNum(u.area, 1)} {t('m2')}</span>}
                    {u.bedrooms != null && <span className="inline-flex items-center gap-1"><BedDouble size={13} className="text-copper" />{u.bedrooms}</span>}
                    {u.bathrooms != null && <span className="inline-flex items-center gap-1"><Bath size={13} className="text-copper" />{u.bathrooms}</span>}
                  </div>
                  <div className="mt-2 text-base font-bold text-copper">{u.status === 'sold' ? '—' : fmtMoney(u.price, isAr)}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {openUnit && (
        <UnitSheet
          unit={openUnit}
          plan={openUnit.plan_file_id ? filesById.get(openUnit.plan_file_id) ?? null : null}
          isAr={isAr}
          projectName={projectName}
          shareUrl={`${shareBaseUrl}&u=${openUnit.id}`}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function UnitSheet({
  unit, plan, isAr, projectName, shareUrl, onClose,
}: {
  unit: PortalUnit;
  plan: PortalFile | null;
  isAr: boolean;
  projectName: string;
  shareUrl: string;
  onClose: () => void;
}) {
  const t = makeT(isAr);
  const [zoom, setZoom] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !zoom) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, onClose]);

  const shareText = [
    `${projectName} — ${unitTitle(unit, isAr)}`,
    unit.area != null ? `${t('area')}: ${fmtNum(unit.area, 1)} ${t('m2')}` : null,
    unit.bedrooms != null ? `${t('bedrooms')}: ${unit.bedrooms}` : null,
    unit.price != null && unit.status !== 'sold' ? `${t('price')}: ${fmtMoney(unit.price, isAr)}` : null,
    shareUrl,
  ].filter(Boolean).join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.error('[broker-portal] clipboard write failed:', e);
      flash(t('copyFailed'), 'error');
    }
  };

  const facts: Array<[string, string]> = [
    [t('type'), bi(unit.type, isAr)],
    [t('model'), unit.model ?? ''],
    [t('building'), unit.building ?? ''],
    [t('floor'), bi(unit.floor, isAr)],
    [t('area'), unit.area != null ? `${fmtNum(unit.area, 1)} ${t('m2')}` : ''],
    [t('bedrooms'), unit.bedrooms != null ? String(unit.bedrooms) : ''],
    [t('bathrooms'), unit.bathrooms != null ? String(unit.bathrooms) : ''],
  ].filter((f): f is [string, string] => !!f[1]);

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-end sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="w-full sm:max-w-3xl max-h-[92vh] overflow-y-auto bg-cream-light rounded-t-3xl sm:rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 bg-white/95 backdrop-blur border-b border-sand/40">
          <div className="min-w-0">
            <div className="text-xs text-charcoal/50 truncate">{projectName}</div>
            <div className="text-lg font-bold text-chocolate truncate">{unitTitle(unit, isAr)}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusPill unit={unit} isAr={isAr} />
            <button type="button" onClick={onClose} aria-label={t('close')} className="p-2 rounded-lg hover:bg-cream"><X size={18} /></button>
          </div>
        </div>

        <div className="p-5 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="rounded-2xl bg-white border border-sand/40 overflow-hidden relative min-h-[220px] flex items-center justify-center">
              {plan ? (
                <button type="button" onClick={() => setZoom(true)} className="w-full h-full group">
                  <img src={plan.url} alt={t('viewPlan')} className="w-full max-h-[360px] object-contain p-2" />
                  <span className="absolute top-2 end-2 p-1.5 rounded-lg bg-black/50 text-white opacity-80 group-hover:opacity-100"><Maximize2 size={16} /></span>
                </button>
              ) : (
                <Ruler size={36} className="text-sand-dark" />
              )}
            </div>
            <div className="space-y-4">
              <div className="rounded-2xl bg-white border border-sand/40 p-4">
                <div className="text-xs text-charcoal/50">{t('price')}</div>
                <div className="text-2xl font-bold text-copper">{unit.status === 'sold' ? '—' : fmtMoney(unit.price, isAr)}</div>
                {unit.price != null && unit.area ? (
                  <div className="text-xs text-charcoal/50 mt-1">{fmtMoney(unit.price / unit.area, isAr)} / {t('m2')}</div>
                ) : null}
              </div>
              <dl className="grid grid-cols-2 gap-2">
                {facts.map(([k, v]) => (
                  <div key={k} className="rounded-xl bg-white border border-sand/40 px-3 py-2">
                    <dt className="text-[11px] text-charcoal/50">{k}</dt>
                    <dd className="text-sm font-bold text-chocolate">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          {unit.components.length > 0 && (
            <div>
              <h4 className="text-sm font-bold text-chocolate mb-2">{t('components')}</h4>
              <div className="flex flex-wrap gap-1.5">
                {unit.components.map((c) => (
                  <span key={c.ar} className="px-2.5 py-1 rounded-full bg-white border border-sand/50 text-xs text-charcoal">{bi(c, isAr)}</span>
                ))}
              </div>
            </div>
          )}

          {unit.payment_plans.length > 0 && (
            <div>
              <h4 className="text-sm font-bold text-chocolate mb-2">{t('paymentPlans')}</h4>
              <div className="space-y-2">
                {unit.payment_plans.map((p, i) => (
                  <div key={`${p.plan}-${i}`} className="rounded-xl bg-white border border-sand/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-bold text-chocolate text-sm">{p.plan}</div>
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        <PlanChip label={t('down')} pct={p.down} price={unit.price} isAr={isAr} strong />
                        <PlanChip label={t('duringConstruction')} pct={p.before_handover} price={unit.price} isAr={isAr} />
                        <PlanChip label={t('onHandover')} pct={p.on_handover} price={unit.price} isAr={isAr} />
                        {p.after_handover ? <PlanChip label={t('afterHandover')} pct={p.after_handover} price={unit.price} isAr={isAr} /> : null}
                      </div>
                    </div>
                    {p.schedule && <ScheduleList schedule={p.schedule} isAr={isAr} />}
                  </div>
                ))}
              </div>
              {unit.price != null && <div className="mt-2 text-[11px] text-charcoal/50">{t('paymentNote')}</div>}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#25D366] text-white text-sm font-bold hover:opacity-90"
            >
              <MessageCircle size={16} /> {t('shareWhatsapp')}
            </a>
            <button type="button" onClick={copy} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-sand text-sm font-bold text-charcoal hover:border-copper">
              {copied ? <Check size={16} className="text-emerald-600" /> : <Copy size={16} />} {copied ? t('copied') : t('copyLink')}
            </button>
          </div>
        </div>
      </div>
      {zoom && plan && (
        <Lightbox
          items={[{ id: plan.id, src: plan.url, kind: 'image', caption: unitTitle(unit, isAr), download: plan.download }]}
          index={0}
          onIndex={() => undefined}
          onClose={() => setZoom(false)}
          isAr={isAr}
        />
      )}
    </div>
  );
}

function PlanChip({ label, pct, price, isAr, strong }: { label: string; pct: number | null; price: number | null; isAr: boolean; strong?: boolean }) {
  if (pct == null) return null;
  return (
    <span className={`px-2 py-1 rounded-lg border ${strong ? 'bg-copper/10 border-copper/30 text-copper' : 'bg-cream-50 border-sand/50 text-charcoal'}`}>
      {label}: <b>{fmtPct(pct, isAr)}</b>
      {price != null && pct > 0 ? <span className="opacity-70"> · {fmtMoney((price * pct) / 100, isAr)}</span> : null}
    </span>
  );
}
