/**
 * Publish control (Phase 3) — the enforced release gate. Each mapped canonical_field
 * is `released` (flows to the live market_listings column) or `held` (its scraped
 * values wait in staging). Grandfathered fields are seeded `released`.
 *
 * HOLD flips the ledger (market_listing_publish_set) — future scrapes stage that
 * field instead of writing it live. RELEASE runs the publisher
 * (market_listing_publish): a dry-run first shows how many rows would change, then
 * the release backfills the live column from staging and flips the ledger.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Lock, UploadCloud, PlusCircle } from 'lucide-react';
import { fetchPublishLedger, setPublishStatus, publishField, exampleList, type FieldStatus, type PublishLedgerRow } from '@/lib/marketAutomation/client';

export default function PublishControl({ rows, isAr }: { rows: FieldStatus[]; isAr: boolean }) {
  const [ledger, setLedger] = useState<PublishLedgerRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ platform: string; field: string; diff: number } | null>(null);

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

  // Candidate-new fields awaiting a real column (a reviewed repo-side promotion).
  const pending = useMemo(
    () => rows.filter((r) => r.authoritative_status === 'candidate_new_field'),
    [rows],
  );

  // HOLD is immediate (ledger flip). RELEASE runs a dry-run first, then confirms.
  const onToggle = async (platform: string, field: string) => {
    setError(null);
    const key = `${platform}::${field}`;
    if (statusOf(platform, field) === 'released') {
      setBusy(key);
      try { await setPublishStatus(platform, field, 'held', 'held via cockpit'); await reload(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(null); }
    } else {
      setBusy(key);
      try { const diff = await publishField(platform, field, true); setConfirm({ platform, field, diff }); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(null); }
    }
  };

  const doRelease = async () => {
    if (!confirm) return;
    const key = `${confirm.platform}::${confirm.field}`;
    setBusy(key); setError(null);
    try { await publishField(confirm.platform, confirm.field, false); setConfirm(null); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const releasedCount = fields.filter((f) => statusOf(f.platform, f.field) === 'released').length;

  return (
    <div className="space-y-4">
      {/* Pending columns: candidate-new fields awaiting a reviewed repo-side promotion. */}
      {pending.length > 0 && (
        <div className="border border-amber-200 bg-amber-50/50 rounded-xl overflow-hidden">
          <div className="flex items-start gap-2 px-4 py-3 text-[13px] text-amber-900 border-b border-amber-200/60">
            <PlusCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <b>{isAr ? `أعمدة مُعلَّقة (${pending.length})` : `Pending columns (${pending.length})`}</b>
              {' — '}
              {isAr
                ? 'حقول رُشِّحت كـ«حقل جديد» وتنتظر عمودًا حقيقيًا. الترقية عملية مُراجَعة في المستودع (هجرة على الجدول المجمّد + تعديل المستخرِج/المحوِّل)، ثم تُصدَر كأي حقل. راجع docs/market-ingest/column-promotion.md.'
                : 'Fields ruled “new field”, awaiting a real column. Promotion is a reviewed repo-side action (a frozen-table migration + an extractor/adapter change), then it’s released like any field. See docs/market-ingest/column-promotion.md.'}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase text-amber-800/50">
                <tr>
                  {[isAr ? 'المسار' : 'source path', isAr ? 'العمود المقترح' : 'proposed column', isAr ? 'النوع' : 'type', isAr ? 'أمثلة' : 'examples'].map((h) => (
                    <th key={h} className="text-start font-medium px-3 py-1.5 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.platform + r.source_path} className="border-t border-amber-200/40">
                    <td className="px-3 py-1.5 font-mono text-[12px] text-charcoal/80">{r.source_path}</td>
                    <td className="px-3 py-1.5 font-mono text-[12px] text-amber-900">{r.source_path.split('.').pop()}</td>
                    <td className="px-3 py-1.5 text-[12px] text-charcoal/55">{r.raw_data_type ?? '—'}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {exampleList(r.example_values, 3).map((ex, i) => (
                          <span key={i} className="bg-white/70 border border-amber-200 text-charcoal/60 text-[11px] px-1.5 py-0.5 rounded truncate max-w-[120px]">{ex}</span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-start gap-2 text-[13px] text-charcoal/60 bg-sand/5 border border-sand/40 rounded-xl px-4 py-3">
        <Lock className="w-4 h-4 mt-0.5 shrink-0 text-copper" />
        <div>
          {isAr
            ? 'بوابة الإصدار: الحقول «مُصدَرة» تتدفق إلى جدول الإعلانات المباشر؛ «محجوزة» تُخزَّن قيمها مؤقتًا حتى الإصدار. «حجز» يوقف الحقل فورًا؛ «إصدار» يعرض عدد الصفوف المتأثرة ثم يعيد تعبئتها.'
            : 'Release gate: “released” fields flow to the live listings table; “held” fields have their scraped values staged until you release. Hold stops a field immediately; Release shows how many rows it affects, then backfills them.'}
          <div className="mt-1 text-charcoal/45">
            {releasedCount}/{fields.length} {isAr ? 'مُصدَرة' : 'released'}
          </div>
        </div>
      </div>

      {confirm && (
        <div className="flex items-center justify-between gap-3 bg-copper/5 border border-copper/30 rounded-xl px-4 py-3">
          <div className="text-[13px] text-charcoal">
            <span className="font-mono">{confirm.field}</span> —{' '}
            {isAr ? `سيُعاد تعبئة ${confirm.diff} صفًّا إلى الجدول المباشر.` : `${confirm.diff} row(s) will be backfilled to the live table.`}
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={doRelease} disabled={busy !== null}
              className="inline-flex items-center gap-1.5 text-[12px] bg-copper text-white px-3 py-1.5 rounded-lg hover:bg-terracotta disabled:opacity-50">
              <UploadCloud className="w-3.5 h-3.5" />{isAr ? 'إصدار' : 'Release'}
            </button>
            <button onClick={() => setConfirm(null)} disabled={busy !== null}
              className="text-[12px] text-charcoal/60 px-3 py-1.5 rounded-lg hover:bg-sand/10">{isAr ? 'إلغاء' : 'Cancel'}</button>
          </div>
        </div>
      )}

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
                        onClick={() => onToggle(f.platform, f.field)}
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
