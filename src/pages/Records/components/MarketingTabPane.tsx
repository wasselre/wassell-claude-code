import { useEffect, useState, useCallback } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import {
  fetchProjectOverview, fetchProjectContent, fetchProjectMarketers,
  fetchProviderHealth, decideAttribution,
  type OverviewData, type ContentRow, type MarketerRow, type ProviderRow,
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
      } else if (sub === 'collection') setProviders((await fetchProviderHealth()).providers);
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
              <div className="flex items-center gap-1.5 text-xs">
                <span className="px-1.5 py-0.5 rounded bg-copper/10 text-copper">{PLATFORM_LABEL[p.platform] ?? p.platform}</span>
                {org && <span className="text-charcoal/60 truncate">{isAr ? org.name_ar : org.name_en}</span>}
              </div>
              {typeof views === 'number' && <div className="text-xs text-charcoal/50">{views.toLocaleString()} {L('مشاهدة', 'views')}</div>}
              <div className="text-[11px] text-charcoal/35">
                {L('جُمع', 'synced')} {ago(p.last_seen_at, isAr)} · {p.first_provider}
                {r.review_status === 'candidate' && <span className="text-amber-700"> · {L('مبدئي', 'candidate')}</span>}
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
