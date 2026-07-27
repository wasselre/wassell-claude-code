/**
 * Approvals, Publishing and Performance — the three queue-shaped sections.
 * Grouped in one module because they share the same skeleton (a filtered list
 * of records plus one decisive action), not because they are the same feature.
 *
 * Publishing is deliberately MANUAL. No platform API publishing exists here, so
 * the UI never offers a "publish now" button it cannot honour: it gives you the
 * caption to copy and records what you actually did, including the real URL.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, MessageSquareWarning, Send, ExternalLink, Copy, BarChart3 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Section, Stat, EmptyHint, Spinner, CaveatStrip, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import {
  fetchApprovals, decideApproval, fetchPublications, savePublication,
  fetchPerformance, recordPerformance,
  type Approval, type PublicationRow, type PerfSnapshot,
} from '@/lib/marketingMgmt/client';

// ── Approvals ───────────────────────────────────────────────────────────────
export function ApprovalsTab({ isAr, onError }: { isAr: boolean; onError: (m: string) => void }) {
  const [rows, setRows] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    fetchApprovals({ status: 'pending' }).then((r) => setRows(r.approvals))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [onError]);
  useEffect(load, [load]);

  const decide = async (id: string, decision: 'approved' | 'changes_requested' | 'rejected') => {
    setBusy(true);
    try {
      await decideApproval({ approval_id: id, decision,
        requested_changes: decision === 'changes_requested' ? (note[id] ?? '') : undefined,
        comment: decision !== 'changes_requested' ? (note[id] ?? '') : undefined });
      load();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;
  return (
    <Section title={isAr ? 'طابور الاعتماد' : 'Approval queue'}
      subtitle={isAr ? 'الاعتماد يقفل النسخة نهائياً' : 'Approving locks the version permanently'}>
      {rows.length === 0 ? <EmptyHint>{isAr ? 'لا شيء بانتظار الاعتماد' : 'Nothing awaiting approval'}</EmptyHint> : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.id} className="rounded-xl border border-sand/50 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-charcoal">
                  {isAr ? 'مرحلة' : 'Stage'}: {a.stage}
                </span>
                <span className="text-[11px] text-charcoal/45">{fmtDate(a.created_at, isAr)}</span>
              </div>
              <input value={note[a.id] ?? ''} onChange={(e) => setNote({ ...note, [a.id]: e.target.value })}
                placeholder={isAr ? 'ملاحظة أو التعديلات المطلوبة…' : 'Comment or requested changes…'}
                className="mt-2 w-full rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[12.5px] focus:border-copper focus:outline-none" />
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" disabled={busy} onClick={() => decide(a.id, 'approved')}
                  className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-40">
                  <CheckCircle2 className="h-3.5 w-3.5" />{isAr ? 'اعتماد' : 'Approve'}
                </button>
                <button type="button" disabled={busy} onClick={() => decide(a.id, 'changes_requested')}
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-40">
                  <MessageSquareWarning className="h-3.5 w-3.5" />{isAr ? 'طلب تعديل' : 'Request changes'}
                </button>
                <button type="button" disabled={busy} onClick={() => decide(a.id, 'rejected')}
                  className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-[12px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-40">
                  <XCircle className="h-3.5 w-3.5" />{isAr ? 'رفض' : 'Reject'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ── Publishing (manual workflow) ────────────────────────────────────────────
export function PublishingTab({ isAr, onError }: { isAr: boolean; onError: (m: string) => void }) {
  const [rows, setRows] = useState<PublicationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    fetchPublications({ limit: 300 }).then((r) => setRows(r.publications))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [onError]);
  useEffect(load, [load]);

  const markPublished = async (p: PublicationRow) => {
    const u = (url[p.id] ?? '').trim();
    if (!u) { onError(isAr ? 'أدخل رابط المنشور أولاً' : 'Enter the published URL first'); return; }
    setBusy(true);
    try { await savePublication({ status: 'published', published_url: u }, p.id); load(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;
  const pending = rows.filter((r) => r.status !== 'published');
  const done = rows.filter((r) => r.status === 'published');

  return (
    <div className="space-y-4">
      <CaveatStrip>
        {isAr
          ? 'النشر يدوي: النظام لا ينشر تلقائياً على أي منصة. انسخ التعليق، انشر، ثم سجّل الرابط هنا.'
          : 'Publishing is manual — this system does not post to any platform automatically. Copy the caption, publish, then record the real URL here.'}
      </CaveatStrip>

      <Section title={isAr ? 'بانتظار النشر' : 'Awaiting publication'}>
        {pending.length === 0 ? <EmptyHint>{isAr ? 'لا شيء مجدول' : 'Nothing scheduled'}</EmptyHint> : (
          <ul className="space-y-2">
            {pending.map((p) => (
              <li key={p.id} className="rounded-xl border border-sand/50 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-[13px] font-medium text-charcoal">
                    {p.mkt_content_items?.content_number} · {p.mkt_content_items?.title}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-charcoal/50">
                    <span className="capitalize">{p.platform}</span><span>{p.status}</span>
                    <span>{p.scheduled_for ? fmtDate(p.scheduled_for, isAr) : '—'}</span>
                  </span>
                </div>
                {p.caption && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg bg-cream-light p-2">
                    <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12px] text-charcoal/75">{p.caption}</p>
                    <button type="button" title={isAr ? 'نسخ' : 'Copy'}
                      onClick={() => void navigator.clipboard?.writeText(p.caption ?? '')}
                      className="shrink-0 rounded p-1 text-charcoal/40 hover:text-copper">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  <input value={url[p.id] ?? ''} onChange={(e) => setUrl({ ...url, [p.id]: e.target.value })}
                    placeholder={isAr ? 'رابط المنشور بعد النشر' : 'Published URL'}
                    className="min-w-[200px] flex-1 rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[12.5px] focus:border-copper focus:outline-none" />
                  <Button onClick={() => markPublished(p)} disabled={busy}>
                    <Send className="h-4 w-4" />{isAr ? 'تم النشر' : 'Mark published'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={isAr ? 'منشور' : 'Published'} right={<span className="text-[12px] text-charcoal/45">{done.length}</span>}>
        {done.length === 0 ? <EmptyHint>—</EmptyHint> : (
          <ul className="divide-y divide-sand/40">
            {done.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2.5">
                <span className="min-w-0 truncate text-[13px] text-charcoal">{p.mkt_content_items?.title}</span>
                <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-charcoal/50">
                  <span className="capitalize">{p.platform}</span>
                  <span>{p.published_at ? fmtDate(p.published_at, isAr) : '—'}</span>
                  {p.published_url && (
                    <a href={p.published_url} target="_blank" rel="noreferrer" className="text-copper hover:underline">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ── Performance ─────────────────────────────────────────────────────────────
const ORGANIC_FIELDS = ['views','reach','impressions','likes','comments','shares','saves','link_clicks'] as const;

export function PerformanceTab({ isAr, onError }: { isAr: boolean; onError: (m: string) => void }) {
  const [pubs, setPubs] = useState<PublicationRow[]>([]);
  const [snaps, setSnaps] = useState<PerfSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<string>('');
  const [vals, setVals] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([fetchPublications({ status: 'published', limit: 300 }), fetchPerformance({ limit: 300 })])
      .then(([p, s]) => { setPubs(p.publications); setSnaps(s.snapshots); })
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [onError]);
  useEffect(load, [load]);

  const record = async () => {
    if (!target) return;
    const metrics: Record<string, number> = {};
    for (const f of ORGANIC_FIELDS) {
      const raw = (vals[f] ?? '').trim();
      if (raw !== '' && Number.isFinite(Number(raw))) metrics[f] = Number(raw);
    }
    setBusy(true);
    try {
      // Empty form = "we looked and there was nothing to read", which is a
      // different fact from "all metrics are zero" — record it as such.
      await recordPerformance({
        publication_id: target, metrics,
        collection_status: Object.keys(metrics).length === 0 ? 'not_available' : 'collected',
      });
      setVals({}); load();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;
  const withData = new Set(snaps.map((s) => s.publication_id).filter(Boolean) as string[]);
  const missing = pubs.filter((p) => !withData.has(p.id));

  return (
    <div className="space-y-4">
      <Section title={isAr ? 'تسجيل الأداء' : 'Record performance'}
        subtitle={isAr ? 'كل تسجيل لقطة جديدة — لا يُستبدل السابق' : 'Each entry is a new snapshot — nothing is overwritten'}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <select value={target} onChange={(e) => setTarget(e.target.value)}
            className="col-span-2 rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[13px] sm:col-span-3 lg:col-span-5">
            <option value="">{isAr ? '— اختر منشوراً —' : '— select a publication —'}</option>
            {pubs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.mkt_content_items?.content_number} · {p.platform} · {p.mkt_content_items?.title}
              </option>
            ))}
          </select>
          {ORGANIC_FIELDS.map((f) => (
            <input key={f} value={vals[f] ?? ''} onChange={(e) => setVals({ ...vals, [f]: e.target.value })}
              inputMode="numeric" placeholder={f}
              className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] focus:border-copper focus:outline-none" />
          ))}
        </div>
        <div className="mt-2">
          <Button onClick={record} disabled={busy || !target}>
            <BarChart3 className="h-4 w-4" />{isAr ? 'حفظ لقطة' : 'Save snapshot'}
          </Button>
        </div>
      </Section>

      {missing.length > 0 && (
        <Section title={isAr ? 'منشورات بلا بيانات أداء' : 'Published without performance data'}>
          <ul className="divide-y divide-sand/40">
            {missing.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2 text-[12.5px]">
                <span className="min-w-0 truncate text-charcoal">{p.mkt_content_items?.title}</span>
                <span className="shrink-0 text-[11px] text-amber-700">{isAr ? 'لم يُسجَّل' : 'not recorded'}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={isAr ? 'اللقطات' : 'Snapshots'} right={<span className="text-[12px] text-charcoal/45">{snaps.length}</span>}>
        {snaps.length === 0 ? <EmptyHint>{isAr ? 'لا لقطات بعد' : 'No snapshots yet'}</EmptyHint> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-sand/50 text-[11px] uppercase tracking-wide text-charcoal/45">
                  <th className="py-2 text-start font-medium">{isAr ? 'التاريخ' : 'Captured'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'المنصة' : 'Platform'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'الحالة' : 'State'}</th>
                  <th className="py-2 text-start font-medium">{isAr ? 'القيم' : 'Metrics'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-sand/30">
                {snaps.slice(0, 60).map((s) => {
                  const entries = Object.entries(s.metrics ?? {});
                  return (
                    <tr key={s.id}>
                      <td className="py-2 text-charcoal/70">{fmtDate(s.captured_at, isAr)}</td>
                      <td className="py-2 capitalize text-charcoal/60">{s.platform ?? '—'}</td>
                      <td className="py-2">
                        <span className={s.collection_status === 'collected' ? 'text-charcoal/60' : 'text-amber-700'}>
                          {s.collection_status}
                        </span>
                      </td>
                      <td className="py-2 text-charcoal/75">
                        {entries.length === 0 ? '—' : entries.map(([k, v]) => `${k}: ${v}`).join(' · ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

export function PerformanceStatRow({ snaps, isAr }: { snaps: PerfSnapshot[]; isAr: boolean }) {
  const collected = snaps.filter((s) => s.collection_status === 'collected');
  const sum = (k: string) => collected.reduce((a, s) => a + (Number(s.metrics?.[k] ?? 0) || 0), 0);
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <Stat label={isAr ? 'لقطات' : 'Snapshots'} value={snaps.length} />
      <Stat label={isAr ? 'مشاهدات' : 'Views'} value={collected.length ? sum('views') : null} />
      <Stat label={isAr ? 'إعجابات' : 'Likes'} value={collected.length ? sum('likes') : null} />
      <Stat label={isAr ? 'نقرات' : 'Clicks'} value={collected.length ? sum('link_clicks') : null} />
    </div>
  );
}
