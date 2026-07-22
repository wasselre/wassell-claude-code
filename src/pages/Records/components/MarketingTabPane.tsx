import { useEffect, useState, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import {
  fetchProjectOverview, fetchProjectContent, fetchProjectMarketers,
  fetchProviderHealth, decideAttribution, fetchCollectionStatus,
  runCollection, retryJob, setAccountCollection, setCollectionPaused, refreshProviderHealthNow,
  type OverviewData, type ContentRow, type MarketerRow, type ProviderRow, type CollectionStatusData,
} from '@/lib/marketing/client';

interface Props { projectId: string }

type SubTab = 'overview' | 'developer' | 'marketer' | 'ads' | 'collection';

const PLATFORM_LABEL: Record<string, string> = {
  tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', snapchat: 'Snapchat', x: 'X', facebook: 'Facebook',
};
const HEALTH_LABEL: Record<string, { ar: string; cls: string }> = {
  not_configured: { ar: 'غير مُهيّأ', cls: 'bg-charcoal/10 text-charcoal' },
  connected: { ar: 'متصل', cls: 'bg-green-100 text-green-800' },
  auth_failed: { ar: 'فشل المصادقة', cls: 'bg-red-100 text-red-800' },
  rate_limited: { ar: 'تجاوز الحد', cls: 'bg-amber-100 text-amber-800' },
  unavailable: { ar: 'غير متاح', cls: 'bg-red-100 text-red-800' },
  config_invalid: { ar: 'إعداد غير صالح', cls: 'bg-red-100 text-red-800' },
};

function timeAgo(iso: string | null, isAr: boolean): string {
  if (!iso) return isAr ? '—' : '—';
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  if (d < 1) return isAr ? 'اليوم' : 'today';
  if (d < 30) return isAr ? `قبل ${Math.floor(d)} يوم` : `${Math.floor(d)}d ago`;
  return isAr ? `قبل ${Math.floor(d / 30)} شهر` : `${Math.floor(d / 30)}mo ago`;
}

function Card({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="text-2xl font-bold text-copper">{value}</div>
      <div className="text-sm text-charcoal/70 mt-1">{label}</div>
      {sub && <div className="text-xs text-charcoal/40 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function MarketingTabPane({ projectId }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const isAdmin = useIsAdmin();
  const addToast = useAppStore((s) => s.addToast);
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const [sub, setSub] = useState<SubTab>('overview');
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [content, setContent] = useState<ContentRow[]>([]);
  const [marketers, setMarketers] = useState<MarketerRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [status, setStatus] = useState<CollectionStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (sub === 'overview') setOverview(await fetchProjectOverview(projectId));
      else if (sub === 'developer') setContent((await fetchProjectContent(projectId, 'developer')).rows);
      else if (sub === 'marketer') {
        setMarketers((await fetchProjectMarketers(projectId)).marketers);
        setContent((await fetchProjectContent(projectId, 'marketer')).rows);
      } else if (sub === 'collection') {
        setProviders((await fetchProviderHealth()).providers);
        setStatus(await fetchCollectionStatus(projectId));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [sub, projectId]);

  useEffect(() => { void load(); }, [load]);

  const TABS: Array<{ id: SubTab; ar: string; en: string }> = [
    { id: 'overview', ar: 'نظرة عامة', en: 'Overview' },
    { id: 'developer', ar: 'المطوّر', en: 'Developer' },
    { id: 'marketer', ar: 'المسوّقون', en: 'Marketers' },
    { id: 'ads', ar: 'الإعلانات المدفوعة', en: 'Paid Ads' },
    { id: 'collection', ar: 'حالة التجميع', en: 'Collection' },
  ];

  return (
    <div className="space-y-5">
      {/* sub-tab strip */}
      <div className="flex flex-wrap gap-1 border-b border-sand/40">
        {TABS.map((tb) => (
          <button key={tb.id} type="button" onClick={() => setSub(tb.id)}
            className={`px-3 py-2 text-sm font-bold transition-colors ${sub === tb.id ? 'text-copper border-b-2 border-copper' : 'text-charcoal/50 hover:text-charcoal'}`}>
            {isAr ? tb.ar : tb.en}
          </button>
        ))}
      </div>

      {error && <div className="card p-4 text-sm text-red-700 bg-red-50">{error}</div>}
      {loading && <div className="text-sm text-charcoal/50">{L('جارٍ التحميل…', 'Loading…')}</div>}

      {/* OVERVIEW */}
      {sub === 'overview' && overview && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card label={L('منشورات المطوّر', 'Developer posts')} value={overview.developer.posts} sub={L(`${overview.developer.this_month} هذا الشهر`, `${overview.developer.this_month} this month`)} />
            <Card label={L('فيديوهات', 'Videos')} value={overview.developer.videos} />
            <Card label={L('المسوّقون', 'Marketers')} value={overview.competitors.marketers} sub={L(`${overview.competitors.posts} منشور`, `${overview.competitors.posts} posts`)} />
            <Card label={L('بانتظار المراجعة', 'Review queue')} value={overview.review_queue} sub={L('إسناد مبدئي', 'candidate matches')} />
          </div>
          <div className="card p-4 text-xs text-charcoal/50">
            {L('محتوى غير مملوك لنا — يُجمع من مصادر عامة. تظهر المنصة ووقت التجميع لكل عنصر.',
               'Non-owned content collected from public sources. Source + collection time are shown per item.')}
          </div>
        </>
      )}

      {/* DEVELOPER / MARKETER content grid */}
      {(sub === 'developer' || sub === 'marketer') && !loading && (
        <>
          {sub === 'marketer' && marketers.length > 0 && (
            <div className="card p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-charcoal/50 text-xs border-b border-sand/40">
                  <th className="text-start p-3">{L('المسوّق', 'Marketer')}</th>
                  <th className="p-3">{L('منشورات', 'Posts')}</th>
                  <th className="p-3">{L('فيديو', 'Videos')}</th>
                  <th className="p-3">{L('صور', 'Images')}</th>
                  <th className="p-3">{L('آخر نشاط', 'Recent')}</th>
                </tr></thead>
                <tbody>
                  {marketers.map((m) => (
                    <tr key={m.org.id} className="border-b border-sand/20">
                      <td className="p-3 font-bold">{isAr ? m.org.name_ar : m.org.name_en} <span className="text-xs text-charcoal/40">({m.org.org_type})</span></td>
                      <td className="p-3 text-center">{m.posts}</td>
                      <td className="p-3 text-center">{m.videos}</td>
                      <td className="p-3 text-center">{m.images}</td>
                      <td className="p-3 text-center text-charcoal/60">{timeAgo(m.last, isAr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ContentGrid rows={content} isAr={isAr} isAdmin={isAdmin} onDecide={async (id, d) => {
            try { await decideAttribution(id, d); addToast(L('تم', 'Done'), 'success'); void load(); }
            catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); }
          }} L={L} timeAgo={timeAgo} />
          {content.length === 0 && <div className="text-sm text-charcoal/40">{L('لا يوجد محتوى مُسند بعد.', 'No attributed content yet.')}</div>}
        </>
      )}

      {/* PAID ADS — empty state (ingestion is Phase 2) */}
      {sub === 'ads' && (
        <div className="card p-6 text-sm text-charcoal/50">
          {L('تتبّع الإعلانات المدفوعة (مكتبة إعلانات ميتا) يأتي في المرحلة التالية. التغطية في السعودية أفضل جهد ممكن — واجهة ميتا الرسمية لا تُعيد الإعلانات التجارية خارج الاتحاد الأوروبي.',
             'Paid-ad tracking (Meta Ad Library) lands in the next phase. KSA coverage is best-effort — Meta\'s official API does not return commercial ads outside the EU.')}
        </div>
      )}

      {/* COLLECTION STATUS */}
      {sub === 'collection' && !loading && (
        <div className="space-y-5">
          {/* provider health */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-charcoal/70">{L('صحة المزوّدين', 'Provider health')}</h3>
              {isAdmin && (
                <button type="button" className="text-xs px-2 py-1 rounded bg-copper/10 text-copper"
                  onClick={async () => { try { setProviders((await refreshProviderHealthNow()).providers); addToast(L('تم الفحص', 'Checked'), 'success'); } catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); } }}>
                  {L('إعادة الفحص', 'Re-check')}
                </button>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {providers.map((p) => {
                const h = HEALTH_LABEL[p.health_status] ?? { ar: p.health_status, cls: 'bg-charcoal/10 text-charcoal' };
                return (
                  <div key={p.provider_key} className="card p-4">
                    <div className="flex items-center justify-between">
                      <span className="font-bold">{p.display_name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${h.cls}`}>{isAr ? h.ar : p.health_status}</span>
                    </div>
                    {p.health_detail && <div className="text-xs text-charcoal/40 mt-1">{p.health_detail}</div>}
                    <div className="text-xs text-charcoal/40 mt-1">{L('آخر فحص:', 'Checked:')} {timeAgo(p.last_checked_at, isAr)}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* per-account collection status */}
          <div>
            <h3 className="text-sm font-bold text-charcoal/70 mb-2">{L('حالة التجميع لكل حساب', 'Per-account collection')}</h3>
            {status && <AccountStatusTable status={status} isAr={isAr} isAdmin={isAdmin} L={L} timeAgo={timeAgo}
              onRun={async (acc, prov) => { try { await runCollection(acc, prov); addToast(L('تم جدولة التجميع', 'Collection queued'), 'success'); void load(); } catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); } }}
              onRetry={async (jid) => { try { await retryJob(jid); addToast(L('تمت إعادة المحاولة', 'Retried'), 'success'); void load(); } catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); } }}
              onToggle={async (acc, en) => { try { await setAccountCollection(acc, en); addToast(L('تم', 'Done'), 'success'); void load(); } catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); } }}
            />}
            {isAdmin && (
              <div className="mt-3 text-xs text-charcoal/50">
                {L('المفتاح العام للتجميع:', 'Global collection switch:')}{' '}
                <button type="button" className="underline text-copper" onClick={async () => { try { await setCollectionPaused(false); addToast(L('تم التفعيل', 'Resumed'), 'success'); } catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); } }}>{L('تفعيل', 'Resume')}</button>
                {' · '}
                <button type="button" className="underline text-copper" onClick={async () => { try { await setCollectionPaused(true); addToast(L('تم الإيقاف', 'Paused'), 'success'); } catch (e) { addToast(e instanceof Error ? e.message : 'error', 'error'); } }}>{L('إيقاف', 'Pause')}</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ContentGrid({ rows, isAr, isAdmin, onDecide, L, timeAgo: ago }: {
  rows: ContentRow[]; isAr: boolean; isAdmin: boolean;
  onDecide: (id: string, d: 'confirm' | 'reject') => void;
  L: (ar: string, en: string) => string; timeAgo: (iso: string | null, isAr: boolean) => string;
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {rows.map((r) => {
        const p = r.mkt_content_posts;
        const org = p.mkt_organizations;
        const views = p.engagement?.views;
        return (
          <div key={r.id} className="card p-0 overflow-hidden">
            <a href={p.post_url ?? '#'} target="_blank" rel="noreferrer" className="block aspect-[9/16] bg-black/90">
              {p.thumbnail_ref
                ? <img src={p.thumbnail_ref} alt="" className="w-full h-full object-cover" loading="lazy" />
                : <div className="w-full h-full flex items-center justify-center text-white/40 text-xs">{PLATFORM_LABEL[p.platform] ?? p.platform}</div>}
            </a>
            <div className="p-2.5 space-y-1">
              <div className="flex items-center gap-1.5 text-xs flex-wrap">
                <span className="px-1.5 py-0.5 rounded bg-copper/10 text-copper">{PLATFORM_LABEL[p.platform] ?? p.platform}</span>
                {org && <span className="text-charcoal/60 truncate">{isAr ? org.name_ar : org.name_en}</span>}
                {org && <span className="text-[10px] text-charcoal/40">{org.org_type === 'developer' ? L('مطوّر', 'developer') : L('مسوّق', 'marketer')}</span>}
              </div>
              {p.caption && <div className="text-[11px] text-charcoal/60 line-clamp-2" dir="rtl">{p.caption}</div>}
              <div className="flex items-center gap-2 text-[11px] text-charcoal/50">
                {typeof views === 'number' && <span>{views.toLocaleString()} {L('مشاهدة', 'views')}</span>}
                {p.published_at && <span>{new Date(p.published_at).toLocaleDateString()}</span>}
              </div>
              <div className="text-[11px] text-charcoal/35 flex items-center gap-1 flex-wrap">
                {p.post_url && <a href={p.post_url} target="_blank" rel="noreferrer" className="underline">{L('الأصل', 'source')}</a>}
                <span>· {L('جُمع', 'synced')} {ago(p.last_seen_at, isAr)}</span>
                <span>· {p.first_provider}</span>
              </div>
              <div className="text-[11px]">
                {r.review_status === 'candidate'
                  ? <span className="text-amber-700">{L('مبدئي', 'candidate')} · {Math.round((r.confidence ?? 0) * 100)}%</span>
                  : r.review_status === 'confirmed'
                    ? <span className="text-green-700">{L('مؤكَّد', 'confirmed')}</span>
                    : <span className="text-charcoal/40">{L('مقبول تلقائيًا', 'auto')} · {Math.round((r.confidence ?? 0) * 100)}%</span>}
                {r.evidence?.matched && <span className="text-charcoal/35" title={r.evidence.snippet ?? ''}> · «{r.evidence.matched}»</span>}
              </div>
              {isAdmin && r.review_status === 'candidate' && (
                <div className="flex gap-1 pt-1">
                  <button type="button" onClick={() => onDecide(r.id, 'confirm')} className="text-[11px] px-2 py-0.5 rounded bg-green-100 text-green-800">{L('تأكيد', 'Confirm')}</button>
                  <button type="button" onClick={() => onDecide(r.id, 'reject')} className="text-[11px] px-2 py-0.5 rounded bg-red-100 text-red-800">{L('رفض', 'Reject')}</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AccountStatusTable({ status, isAr, isAdmin, L, timeAgo: ago, onRun, onRetry, onToggle }: {
  status: CollectionStatusData; isAr: boolean; isAdmin: boolean;
  L: (ar: string, en: string) => string; timeAgo: (iso: string | null, isAr: boolean) => string;
  onRun: (accountId: string, provider: string) => void;
  onRetry: (jobId: string) => void;
  onToggle: (accountId: string, enabled: boolean) => void;
}) {
  // flatten accounts across linked orgs
  const accounts = status.links.flatMap((l) =>
    (l.mkt_organizations?.mkt_social_accounts ?? []).map((a) => ({ ...a, org: l.mkt_organizations })));
  const runsByAcct = new Map<string, CollectionStatusData['runs']>();
  for (const r of status.runs) {
    if (!r.source_account_id) continue;
    const arr = runsByAcct.get(r.source_account_id) ?? []; arr.push(r); runsByAcct.set(r.source_account_id, arr);
  }
  const jobsByAcct = new Map<string, CollectionStatusData['jobs']>();
  for (const j of status.jobs) {
    if (!j.social_account_id) continue;
    const arr = jobsByAcct.get(j.social_account_id) ?? []; arr.push(j); jobsByAcct.set(j.social_account_id, arr);
  }
  if (accounts.length === 0) return <div className="text-sm text-charcoal/40">{L('لا توجد حسابات مرتبطة بهذا المشروع بعد.', 'No accounts linked to this project yet.')}</div>;

  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-charcoal/50 border-b border-sand/40">
          <th className="text-start p-2.5">{L('الحساب', 'Account')}</th>
          <th className="p-2.5">{L('المزوّد', 'Provider')}</th>
          <th className="p-2.5">{L('الحالة', 'Health')}</th>
          <th className="p-2.5">{L('آخر نجاح', 'Last success')}</th>
          <th className="p-2.5">{L('آخر فشل', 'Last fail')}</th>
          <th className="p-2.5">{L('العناصر (استلام/إدراج/تحديث/تخطّي)', 'Items (rcv/ins/upd/skip)')}</th>
          <th className="p-2.5">{L('التالي', 'Next')}</th>
          {isAdmin && <th className="p-2.5">{L('إجراءات', 'Actions')}</th>}
        </tr></thead>
        <tbody>
          {accounts.map((a) => {
            const runs = (runsByAcct.get(a.id) ?? []);
            const lastOk = runs.find((r) => r.status === 'succeeded' || r.status === 'partial');
            const lastFail = runs.find((r) => r.status === 'failed');
            const jobs = jobsByAcct.get(a.id) ?? [];
            const failedJob = jobs.find((j) => j.status === 'failed');
            const queued = jobs.find((j) => j.status === 'queued' || j.status === 'running');
            return (
              <tr key={a.id} className="border-b border-sand/20 align-top">
                <td className="p-2.5 font-bold">@{a.handle}<div className="text-[10px] text-charcoal/40">{a.platform}</div></td>
                <td className="p-2.5 text-center">{a.provider ?? '—'}</td>
                <td className="p-2.5 text-center">
                  <span className={`px-1.5 py-0.5 rounded-full ${a.scrape_status === 'ok' ? 'bg-green-100 text-green-800' : a.scrape_status === 'idle' ? 'bg-charcoal/10 text-charcoal' : 'bg-red-100 text-red-800'}`}>{a.scrape_status}</span>
                  {!a.collection_enabled && <div className="text-[10px] text-charcoal/40 mt-0.5">{L('التجميع موقوف', 'collection off')}</div>}
                </td>
                <td className="p-2.5 text-center">{ago(lastOk?.started_at ?? null, isAr)}</td>
                <td className="p-2.5 text-center text-red-700">{lastFail ? ago(lastFail.started_at, isAr) : '—'}</td>
                <td className="p-2.5 text-center">{lastOk ? `${lastOk.items_received}/${lastOk.items_inserted}/${lastOk.items_updated}/${lastOk.items_skipped}` : '—'}
                  {(lastFail?.errors?.length || failedJob?.error_message) ? <div className="text-[10px] text-red-600 truncate max-w-[180px]">{failedJob?.error_message ?? JSON.stringify(lastFail?.errors?.[0])}</div> : null}
                </td>
                <td className="p-2.5 text-center">{queued ? `${queued.kind} · ${queued.status}` : (a.collection_enabled ? ago(a.last_incremental_at, isAr) : '—')}</td>
                {isAdmin && (
                  <td className="p-2.5">
                    <div className="flex flex-col gap-1 items-start">
                      <button type="button" className="text-[11px] px-2 py-0.5 rounded bg-copper/10 text-copper" onClick={() => onRun(a.id, a.provider ?? 'browserbase')}>{L('تجميع الآن', 'Run now')}</button>
                      {failedJob && <button type="button" className="text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-800" onClick={() => onRetry(failedJob.id)}>{L('أعد المحاولة', 'Retry')}</button>}
                      <button type="button" className="text-[11px] px-2 py-0.5 rounded bg-charcoal/10" onClick={() => onToggle(a.id, !a.collection_enabled)}>{a.collection_enabled ? L('إيقاف', 'Disable') : L('تفعيل', 'Enable')}</button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
