/**
 * Platform Pulse — the organic cockpit (/m/organic).
 *
 * Paid marketing has its own cockpit (the «المدفوعة» rail group: goals,
 * campaigns, spend numbers). Organic never did — publishing was buried in a
 * per-content tab and the only numbers were per-post. This is organic's equal:
 * one place to see how each connected account (Instagram / TikTok / Snapchat) is
 * doing — followers and their growth, reach, engagement, and posting cadence.
 *
 * The growth trend is OUR OWN daily history. bundle.social deletes analytics
 * after 30 days and tells you to store them yourself, so followers/reach are
 * snapshotted daily into mos_account_metric_snapshots (by the daily cron and the
 * «تحديث الآن» button here). That means the chart STARTS today and fills in over
 * days — a brand-new install shows one point, not a year we never captured.
 *
 * Read: fetchOrganicPulse() → per-account headline (mos_account_pulse_v), the
 * ~60-day growth series, and recent published posts for the best-posts panel.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  PLATFORM_LABELS,
  fetchOrganicPulse, pullAccountMetrics, syncPlatforms,
  type MosAccountPulse, type MosAccountTrendPoint, type MosPublication,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, PageHead, Pill, Skeleton } from './components/kit';
import CoveragePanel from './components/CoveragePanel';
import { num, shortDate, dateTimeShort } from './lib/format';
import './styles/pages-remaining.css';

/** Platform accent colors — shared with NumbersPage / the calendar. */
const PLATFORM_COLORS: Record<string, string> = {
  instagram: '#C13584',
  tiktok: 'var(--ink)',
  snapchat: '#C8B400',
  x: 'var(--ink)',
  youtube: '#C4302B',
};

/** The platforms bundle.social gives us real analytics for. Others are manual. */
const BUNDLE_PLATFORMS = new Set(['instagram', 'tiktok', 'snapchat']);

/* ------------------------------------------------------------------ */
/* a tiny inline SVG sparkline — no chart dependency                    */
/* ------------------------------------------------------------------ */

function Sparkline({ points, color }: { points: number[]; color: string }) {
  const W = 220;
  const H = 44;
  const pad = 3;
  if (points.length === 0) return null;
  if (points.length === 1) {
    // One day of history — a single dot, honestly not yet a line.
    return (
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        <circle cx={W / 2} cy={H / 2} r={2.5} fill={color} />
      </svg>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const dx = (W - pad * 2) / (points.length - 1);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * dx).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${(pad + (points.length - 1) * dx).toFixed(1)},${H} L${pad},${H} Z`;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
      <path d={area} fill={color} opacity={0.09} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pad + (points.length - 1) * dx} cy={y(points[points.length - 1] ?? min)} r={2.4} fill={color} />
    </svg>
  );
}

/** A signed follower delta with a direction arrow, or a "gathering data" note. */
function Delta({ value, isAr }: { value: number | null; isAr: boolean }) {
  if (value === null || value === undefined) {
    return <span style={{ color: 'var(--mute)', fontSize: 11.5 }}>{isAr ? 'يُجمع النمو' : 'gathering'}</span>;
  }
  if (value === 0) return <span style={{ color: 'var(--mute)', fontSize: 12 }}>{isAr ? 'ثابت' : 'flat'}</span>;
  const up = value > 0;
  return (
    <span style={{ color: up ? 'var(--ok, #2e7d32)' : 'var(--bad, #b3261e)', fontSize: 12, fontWeight: 700 }}>
      {up ? '▲' : '▼'} {num(Math.abs(value), isAr)}
    </span>
  );
}

/* ------------------------------------------------------------------ */

export default function OrganicPulsePage() {
  const { isAr, can } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);

  const [pulse, setPulse] = useState<MosAccountPulse[]>([]);
  const [trends, setTrends] = useState<MosAccountTrendPoint[]>([]);
  const [posts, setPosts] = useState<MosPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchOrganicPulse();
      setPulse(r.pulse);
      setTrends(r.trends);
      setPosts(r.publications);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Snapshot every connected account's profile numbers NOW, then reload. */
  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      const { summary } = await pullAccountMetrics();
      const inserted = typeof summary.inserted === 'number' ? summary.inserted : 0;
      addToast(
        isAr
          ? (inserted > 0 ? `حُدِّثت أرقام ${num(inserted, true)} حساب من المنصات` : 'لم تُرجع المنصات أرقامًا جديدة بعد')
          : (inserted > 0 ? `Refreshed ${inserted} accounts from the platforms` : 'No new numbers from the platforms yet'),
        inserted > 0 ? 'success' : 'info',
      );
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setRefreshing(false);
    }
  }, [addToast, isAr, load]);

  /** Reconcile connection status (handles, connected flags) from bundle. */
  const syncConnections = useCallback(async () => {
    setSyncing(true);
    try {
      await syncPlatforms();
      addToast(isAr ? 'حُدِّثت حالة الربط' : 'Connection status refreshed', 'success');
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setSyncing(false);
    }
  }, [addToast, isAr, load]);

  /** Growth series per account, oldest→newest (followers, dropping nulls). */
  const trendByAccount = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const t of trends) {
      if (t.followers === null || t.followers === undefined) continue;
      const arr = m.get(t.account_id) ?? [];
      arr.push(t.followers);
      m.set(t.account_id, arr);
    }
    return m;
  }, [trends]);

  /** The organic accounts (bundle platforms first, then any manual ones). */
  const accounts = useMemo(() => {
    const rank = (p: string) => (p === 'instagram' ? 0 : p === 'tiktok' ? 1 : p === 'snapchat' ? 2 : 3);
    return [...pulse].sort((a, b) => rank(a.platform) - rank(b.platform));
  }, [pulse]);

  const anySnapshot = useMemo(() => accounts.some((a) => a.latest_captured_at), [accounts]);

  /** Top posts in the last 30 days by engagement (then views). */
  const bestPosts = useMemo(() => {
    return [...posts]
      .filter((p) => (p.latest_engagement ?? 0) > 0 || (p.latest_views ?? 0) > 0)
      .sort((a, b) =>
        (b.latest_engagement ?? 0) - (a.latest_engagement ?? 0)
        || (b.latest_views ?? 0) - (a.latest_views ?? 0))
      .slice(0, 6);
  }, [posts]);

  const label = (p: string) => (isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p;

  const engagementRate = (a: MosAccountPulse): number | null => {
    if (!a.reach_30d || a.reach_30d <= 0) return null;
    return (a.engagement_30d / a.reach_30d) * 100;
  };

  return (
    <>
      <PageHead
        title={isAr ? 'نبض المنصات' : 'Platform pulse'}
        sub={isAr
          ? 'حالة كل منصة عضوية — المتابعون ونموّهم، الوصول، التفاعل، وانتظام النشر.'
          : 'How each organic account is doing — followers and growth, reach, engagement, and posting cadence.'}
      >
        {can('manage_settings') && (
          <button type="button" className="btn btn-d" disabled={syncing} onClick={() => void syncConnections()}>
            {syncing ? (isAr ? 'جارٍ…' : 'Syncing…') : (isAr ? 'تحديث حالة الربط' : 'Sync connections')}
          </button>
        )}
        {can('enter_metrics') && (
          <button type="button" className="btn btn-p" disabled={refreshing} onClick={() => void refreshNow()}>
            {refreshing ? (isAr ? 'جارٍ السحب…' : 'Refreshing…') : (isAr ? 'تحديث الأرقام الآن' : 'Refresh numbers now')}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && pulse.length === 0 && <Skeleton rows={4} />}

        {/* Demand vs supply — the detailed coverage report. Self-hides when no
            cadence targets are configured; independent of connected accounts. */}
        {!loading && <CoveragePanel isAr={isAr} />}

        {!loading && accounts.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا حسابات بعد' : 'No accounts yet'}
            body={isAr
              ? 'أضف حسابات المنصات من الإعدادات لتظهر هنا.'
              : 'Add platform accounts in Settings and they appear here.'}
          />
        )}

        {accounts.length > 0 && (
          <>
            {/* The honest note: growth history starts now and fills over time. */}
            {!anySnapshot && (
              <div className="notice" style={{ marginBottom: 16 }}>
                {isAr
                  ? 'لم تُجمع الأرقام بعد. اضغط «تحديث الأرقام الآن» لأخذ أول لقطة — يبدأ سجلّ النمو من اليوم ويكتمل يومًا بعد يوم (المنصة لا تحتفظ بأكثر من ٣٠ يومًا، فنحن نحفظه بأنفسنا).'
                  : 'No numbers gathered yet. Hit “Refresh numbers now” to take the first snapshot — the growth history starts today and fills in day by day (the platform keeps only 30 days, so we store it ourselves).'}
              </div>
            )}

            {/* ── per-account cards ─────────────────────────────────── */}
            <div className="grid g3" style={{ marginBottom: 18 }}>
              {accounts.map((a) => {
                const color = PLATFORM_COLORS[a.platform] ?? 'var(--copper)';
                const series = trendByAccount.get(a.account_id) ?? [];
                const isBundle = BUNDLE_PLATFORMS.has(a.platform);
                const rate = engagementRate(a);
                return (
                  <div key={a.account_id} className="card">
                    <div
                      className="card-h"
                      style={{ background: `color-mix(in srgb, ${color} 7%, transparent)` }}
                    >
                      <span className="pdot" style={{ background: color }} />
                      <h4>
                        {label(a.platform)}
                        {a.handle && <> · <span className="ltr">{a.handle}</span></>}
                      </h4>
                      <span style={{ marginInlineStart: 'auto' }}>
                        {!isBundle
                          ? <Pill tone="idle">{isAr ? 'يدوي' : 'manual'}</Pill>
                          : a.is_connected
                            ? <Pill tone="live">{isAr ? 'مرتبط' : 'live'}</Pill>
                            : <Pill tone="idle">{isAr ? 'غير مرتبط' : 'not linked'}</Pill>}
                      </span>
                    </div>

                    <div className="card-b" style={{ padding: '14px 16px' }}>
                      {/* Followers — the headline, with its growth deltas. */}
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <div>
                          <div className="lbl">{isAr ? 'المتابعون' : 'Followers'}</div>
                          <div style={{ fontFamily: 'var(--serif)', fontSize: 30, lineHeight: 1.1 }}>
                            {a.followers === null ? '—' : num(a.followers, isAr)}
                          </div>
                        </div>
                        <div style={{ textAlign: isAr ? 'left' : 'right', display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? '٧ أيام' : '7d'}</div>
                          <Delta value={a.followers_delta_7d} isAr={isAr} />
                          <div style={{ fontSize: 10.5, color: 'var(--mute)', marginTop: 2 }}>{isAr ? '٣٠ يومًا' : '30d'}</div>
                          <Delta value={a.followers_delta_30d} isAr={isAr} />
                        </div>
                      </div>

                      {/* Growth sparkline. */}
                      <div style={{ margin: '10px 0 4px', minHeight: 44 }}>
                        {series.length > 0
                          ? <Sparkline points={series} color={color} />
                          : (
                            <div style={{ height: 44, display: 'flex', alignItems: 'center', fontSize: 11.5, color: 'var(--mute)' }}>
                              {isAr ? 'يبدأ منحنى النمو بعد أول لقطة' : 'growth line begins after the first snapshot'}
                            </div>
                          )}
                      </div>

                      {/* Reach / engagement / cadence. */}
                      <div className="grid g3" style={{ gap: 8, marginTop: 8 }}>
                        <div>
                          <div className="lbl">{isAr ? 'الوصول ٣٠ي' : 'Reach 30d'}</div>
                          <div style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>
                            {a.reach_30d === null ? '—' : num(a.reach_30d, isAr)}
                          </div>
                        </div>
                        <div>
                          <div className="lbl">{isAr ? 'التفاعل ٣٠ي' : 'Engage 30d'}</div>
                          <div style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>
                            {num(a.engagement_30d, isAr)}
                          </div>
                          {rate !== null && (
                            <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>
                              {isAr ? `معدل ${num(Math.round(rate * 10) / 10, true)}٪` : `${Math.round(rate * 10) / 10}% rate`}
                            </div>
                          )}
                        </div>
                        <div>
                          <div className="lbl">{isAr ? 'النشر ٧ي/٣٠ي' : 'Posts 7d/30d'}</div>
                          <div style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>
                            {num(a.posts_7d, isAr)}/{num(a.posts_30d, isAr)}
                          </div>
                          {isBundle && a.posts_7d === 0 && (
                            <div style={{ fontSize: 10.5, color: 'var(--bad, #b3261e)' }}>
                              {isAr ? 'صامتة هذا الأسبوع' : 'quiet this week'}
                            </div>
                          )}
                        </div>
                      </div>

                      {a.latest_captured_at && (
                        <div style={{ fontSize: 10.5, color: 'var(--mute)', marginTop: 10 }}>
                          {isAr ? 'آخر تحديث ' : 'Updated '}{dateTimeShort(a.latest_captured_at, isAr)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── cross-account comparison ──────────────────────────── */}
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="card-h"><h4>{isAr ? 'مقارنة الحسابات' : 'Accounts side by side'}</h4></div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'المنصة' : 'Platform'}</th>
                      <th className="num">{isAr ? 'المتابعون' : 'Followers'}</th>
                      <th className="num">{isAr ? 'نمو ٣٠ي' : 'Growth 30d'}</th>
                      <th className="num">{isAr ? 'الوصول ٣٠ي' : 'Reach 30d'}</th>
                      <th className="num">{isAr ? 'التفاعل ٣٠ي' : 'Engage 30d'}</th>
                      <th className="num">{isAr ? 'المعدل' : 'Rate'}</th>
                      <th className="num">{isAr ? 'منشورات ٣٠ي' : 'Posts 30d'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => {
                      const rate = engagementRate(a);
                      return (
                        <tr key={a.account_id}>
                          <td>
                            <span className="pdot" style={{ background: PLATFORM_COLORS[a.platform] ?? 'var(--copper)', marginInlineEnd: 6 }} />
                            {label(a.platform)}
                          </td>
                          <td className="num">{a.followers === null ? '—' : num(a.followers, isAr)}</td>
                          <td className="num"><Delta value={a.followers_delta_30d} isAr={isAr} /></td>
                          <td className="num">{a.reach_30d === null ? '—' : num(a.reach_30d, isAr)}</td>
                          <td className="num">{num(a.engagement_30d, isAr)}</td>
                          <td className="num">{rate === null ? '—' : `${Math.round(rate * 10) / 10}${isAr ? '٪' : '%'}`}</td>
                          <td className="num">{num(a.posts_30d, isAr)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── best posts (last 30 days) ─────────────────────────── */}
            <div className="card">
              <div className="card-h"><h4>{isAr ? 'أفضل المنشورات (٣٠ يومًا)' : 'Best posts (last 30 days)'}</h4></div>
              {bestPosts.length === 0 ? (
                <div className="card-b" style={{ fontSize: 12.5, color: 'var(--mute)', padding: '14px 16px' }}>
                  {isAr
                    ? 'لا أرقام منشورات بعد — تظهر هنا فور وصول أرقام أول منشور منشور خلال ٣٠ يومًا.'
                    : 'No post numbers yet — top posts appear once the first published post’s numbers land.'}
                </div>
              ) : (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{isAr ? 'المنصة' : 'Platform'}</th>
                        <th>{isAr ? 'المنشور' : 'Post'}</th>
                        <th style={{ width: 92 }}>{isAr ? 'نُشر' : 'Published'}</th>
                        <th className="num" style={{ width: 90 }}>{isAr ? 'المشاهدات' : 'Views'}</th>
                        <th className="num" style={{ width: 90 }}>{isAr ? 'التفاعل' : 'Engage'}</th>
                        <th style={{ width: 70 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {bestPosts.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <span className="pdot" style={{ background: PLATFORM_COLORS[p.platform] ?? 'var(--copper)', marginInlineEnd: 6 }} />
                            {label(p.platform)}
                          </td>
                          <td className="ttl" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p.caption || (isAr ? 'بلا نص' : 'No caption')}
                          </td>
                          <td style={{ color: 'var(--mute)' }}>
                            {p.published_at ? shortDate(p.published_at, isAr) : '—'}
                          </td>
                          <td className="num">{p.latest_views === null ? '—' : num(p.latest_views, isAr)}</td>
                          <td className="num">{p.latest_engagement === null ? '—' : num(p.latest_engagement, isAr)}</td>
                          <td>
                            {p.external_url && (
                              <a href={p.external_url} target="_blank" rel="noreferrer" className="btn btn-d btn-sm">
                                {isAr ? 'فتح' : 'Open'}
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
