/**
 * Publish control (Phase 3, Increment 1) — the release allowlist. Each mapped
 * canonical_field is either `released` (flows to the live market_listings column)
 * or `held` (gated). Grandfathered fields — those already live before the gate —
 * are seeded `released`. Toggling writes the ledger via market_listing_publish_set.
 *
 * Increment 1 is the control plane + authority. Enforcement (the adapter/merge
 * honoring `held`), the dry-run diff, and backfill-on-release land in Increment 2
 * (market_listing_publish). Until then a release/hold records intent; the
 * grandfathered fields keep flowing exactly as before.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Lock } from 'lucide-react';
import { fetchPublishLedger, setPublishStatus, type FieldStatus, type PublishLedgerRow } from '@/lib/marketAutomation/client';

export default function PublishControl({ rows, isAr }: { rows: FieldStatus[]; isAr: boolean }) {
  const [ledger, setLedger] = useState<PublishLedgerRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => fetchPublishLedger().then(setLedger).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => { reload(); }, []);

  // Every (platform, canonical_field) that a mapping targets, plus any ledger-only rows.
  const fields = useMemo(() => {
    const map = new Map<string, { platform: string; field: string; sources: string[] }>();
    for (const r of rows) {
      if (r.authoritative_status === 'mapped_existing_field' && r.canonical_field) {
        const key = `${r.platform}::${r.canonical_field}`;
        const e = map.get(key) ?? { platform: r.platform, field: r.canonical_field, sources: [] };
        e.sources.push(r.source_path);
        map.set(key, e);
      }
    }
    for (const l of ledger) {
      const key = `${l.platform}::${l.canonical_field}`;
      if (!map.has(key)) map.set(key, { platform: l.platform, field: l.canonical_field, sources: [] });
    }
    return Array.from(map.values()).sort((a, b) => a.platform.localeCompare(b.platform) || a.field.localeCompare(b.field));
  }, [rows, ledger]);

  const ledgerOf = (platform: string, field: string) => ledger.find((l) => l.platform === platform && l.canonical_field === field);
  const statusOf = (platform: string, field: string): 'held' | 'released' => ledgerOf(platform, field)?.status ?? 'held';

  const toggle = async (platform: string, field: string) => {
    const next = statusOf(platform, field) === 'released' ? 'held' : 'released';
    setBusy(`${platform}::${field}`); setError(null);
    try {
      await setPublishStatus(platform, field, next, next === 'held' ? 'held via cockpit' : 'released via cockpit');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const releasedCount = fields.filter((f) => statusOf(f.platform, f.field) === 'released').length;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-[13px] text-charcoal/60 bg-sand/5 border border-sand/40 rounded-xl px-4 py-3">
        <Lock className="w-4 h-4 mt-0.5 shrink-0 text-copper" />
        <div>
          {isAr
            ? 'قائمة الإصدار: الحقول «مُصدَرة» تتدفق إلى جدول الإعلانات المباشر؛ «محجوزة» مُوقفة عند البوابة. الحقول المتدفقة سابقًا مُصدَرة تلقائيًا. (الإنفاذ الكامل — الفرق التجريبي وإعادة التعبئة — يأتي في الخطوة التالية.)'
            : 'Release allowlist: “released” fields flow to the live listings table; “held” fields are gated. Fields that were already live are auto-released. (Full enforcement — dry-run diff + backfill — comes in the next increment.)'}
          <div className="mt-1 text-charcoal/45">
            {releasedCount}/{fields.length} {isAr ? 'مُصدَرة' : 'released'}
          </div>
        </div>
      </div>

      {error && <div className="flex items-center gap-2 text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-sm"><AlertTriangle className="w-4 h-4" />{error}</div>}

      {fields.length === 0 ? (
        <div className="text-charcoal/40 py-10 text-center">{isAr ? 'لا حقول مطابَقة بعد. طابِق حقولًا في تبويب القرارات أولًا.' : 'No mapped fields yet. Map fields in the Decisions tab first.'}</div>
      ) : (
        <div className="overflow-x-auto border border-sand/40 rounded-xl bg-white">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase text-charcoal/40 border-b border-sand/40">
              <tr>
                {[isAr ? 'الحقل' : 'Wassell field', isAr ? 'المنصة' : 'platform', isAr ? 'مطابَق من' : 'mapped from', isAr ? 'الحالة' : 'status', isAr ? 'أُصدر' : 'released'].map((h) => (
                  <th key={h} className="text-start font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => {
                const st = statusOf(f.platform, f.field);
                const l = ledgerOf(f.platform, f.field);
                const key = `${f.platform}::${f.field}`;
                const grandfathered = l?.released_by === 'system:grandfather';
                return (
                  <tr key={key} className="border-b border-sand/20 last:border-0">
                    <td className="px-3 py-2 font-mono text-[12px] text-charcoal">{f.field}</td>
                    <td className="px-3 py-2 text-[12px] text-charcoal/60">{f.platform}</td>
                    <td className="px-3 py-2 max-w-[260px]">
                      <div className="flex flex-wrap gap-1">
                        {f.sources.slice(0, 4).map((s) => <span key={s} className="bg-sand/15 text-charcoal/60 text-[11px] px-1.5 py-0.5 rounded font-mono truncate max-w-[130px]">{s}</span>)}
                        {f.sources.length === 0 && <span className="text-charcoal/30 text-[11px]">—</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => toggle(f.platform, f.field)}
                        disabled={busy === key}
                        className={`inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full transition-colors ${st === 'released' ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'} ${busy === key ? 'opacity-50' : ''}`}
                        title={isAr ? 'اضغط للتبديل' : 'Click to toggle'}
                      >
                        {st === 'released' ? <><Check className="w-3 h-3" />{isAr ? 'مُصدَر' : 'Released'}</> : <><Lock className="w-3 h-3" />{isAr ? 'محجوز' : 'Held'}</>}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-charcoal/45 whitespace-nowrap">
                      {l?.released_at ? (grandfathered ? (isAr ? 'موروث' : 'grandfathered') : new Date(l.released_at).toLocaleDateString()) : '—'}
                      {l?.released_by && !grandfathered && <div className="text-charcoal/35">{l.released_by}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
