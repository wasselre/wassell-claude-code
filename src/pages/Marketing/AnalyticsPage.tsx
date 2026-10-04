/**
 * التحليلات — the paid-media deep-dive the Overview deliberately isn't.
 *
 * A date range you choose (period + prev/next, or a custom span) drives every
 * number: volume (spend / leads / qualified / impressions), the four media
 * efficiency metrics (CPM · CPC · CTR · CPL), the impressions→clicks→leads
 * funnel, daily trends, and per-platform / per-campaign breakdowns.
 *
 * Data source: every figure is DATED — the Meta daily sync
 * (mos_ad_metrics_daily, one row per ad per day) plus hand-entered days for any
 * execution the sync doesn't cover. So a period shows that period's spend,
 * leads, impressions and clicks, and the previous-period deltas are real.
 *
 * Lifetime money with no daily breakdown at all (`undated_spend`) cannot be
 * placed in any period; it is reported in a note BESIDE the figures, never
 * folded into them. Until 2026-10-04 this page showed lifetime totals for every
 * period ("the numbers are wrong for the month").
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  PaidAnalytics, PaidAnalyticsWindow, PLATFORM_LABELS, fetchPaidAnalytics,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, PageHead, Skeleton } from './components/kit';
import DateControl from './components/DateControl';
import { BarChart, Point, Sparkline, TrendChart } from './components/analyticsCharts';
import { DateSel, bucketDaily, granLabel, todayIso } from './lib/period';
import { num, pct } from './lib/format';
import './styles/analytics.css';

const PLATFORM_COLOR: Record<string, string> = {
  meta: 'var(--copper)', instagram: 'var(--copper)', facebook: 'var(--terracotta)',
  snapchat: 'var(--gold)', tiktok: 'var(--choc)', google: 'var(--go)', x: 'var(--ink-2)',
};

interface Media { cpm: number; cpc: number; ctr: number; cpl: number }

/** Period figures only — a window's spend over that window's volume. */
function media(t: Pick<PaidAnalyticsWindow['totals'], 'spend' | 'leads' | 'impressions' | 'clicks'>): Media {
  return {
    cpm: t.impressions > 0 ? (t.spend / t.impressions) * 1000 : 0,
    cpc: t.clicks > 0 ? t.spend / t.clicks : 0,
    ctr: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0,
    cpl: t.leads > 0 ? t.spend / t.leads : 0,
  };
}

/** Delta chip vs the previous equal window. `invert` = lower-is-better. */
function Delta({ cur, prev, invert, isAr }: { cur: number; prev: number; invert?: boolean; isAr: boolean }) {
  if (!prev || !Number.isFinite(prev)) return <span className="delta flat">—</span>;
  const p = Math.round(((cur - prev) / prev) * 100);
  const good = invert ? p <= 0 : p >= 0;
  return (
    <span className={`delta ${good ? 'up' : 'down'}`}>
      {p >= 0 ? '▲' : '▼'} {num(Math.abs(p), isAr)}{isAr ? '٪' : '%'}
    </span>
  );
}

export default function AnalyticsPage() {
  const { isAr } = useWorkspace();
  const [sel, setSel] = useState<DateSel>({ period: 'month', anchorIso: todayIso() });
  const [data, setData] = useState<PaidAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (s: DateSel) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchPaidAnalytics(
        s.period === 'custom'
          ? { period: 'custom', from: s.from, to: s.to }
          : { period: s.period, anchorIso: s.anchorIso },
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(sel); }, [load, sel]);

  const cur = data?.current;
  const prev = data?.previous;
  const m = useMemo(() => (cur ? media(cur.totals) : null), [cur]);
  const mPrev = useMemo(() => (prev ? media(prev.totals) : null), [prev]);
  const bk = useMemo(() => (cur ? bucketDaily(cur.daily, cur.from, cur.to, isAr) : null), [cur, isAr]);

  const t = cur?.totals;
  const hasDaily = (t?.daily_days ?? 0) > 0;
  // The period's figures, including when they are zero — never lifetime.
  const hSpend = t?.spend ?? 0;
  const hLeads = t?.leads ?? 0;
  const pSpend = prev?.totals.spend ?? 0;
  const pLeads = prev?.totals.leads ?? 0;
  const undatedSpend = t?.undated_spend ?? 0;

  const cplSeries: Point[] = bk ? bk.items.map((b) => ({ label: b.label, value: b.leads > 0 ? b.spend / b.leads : 0 })) : [];
  // Stop at the last day with activity: the days still ahead in this period
  // have no data, and plotting them as 0 reads as "cost fell to zero".
  const spark = (pick: (x: Media) => number): number[] | undefined => {
    if (!hasDaily || !bk) return undefined;
    let last = -1;
    bk.items.forEach((b, i) => { if (b.spend > 0 || b.impressions > 0) last = i; });
    return bk.items.slice(0, last + 1).map((b) => pick(media(b)));
  };

  return (
    <>
      <PageHead
        title={isAr ? 'التحليلات' : 'Analytics'}
        sub={isAr ? 'كفاءة الإنفاق الإعلاني — بالتفصيل' : 'Paid-media efficiency, in detail'}
      />
      <div className="body">
        <DateControl
          sel={sel}
          periods={['week', 'month', 'quarter', 'year']}
          isAr={isAr}
          onChange={setSel}
        />

        {error && <LoadError message={error} onRetry={() => void load(sel)} isAr={isAr} />}
        {loading && !data && <Skeleton rows={6} />}

        {cur && t && m && (
          <>
            {/* volume */}
            <div className="an-g4" style={{ marginBottom: 16 }}>
              <div className="stat">
                <div className="k">{isAr ? 'الإنفاق' : 'Spend'}</div>
                <div className="v">{num(Math.round(hSpend), isAr)}</div>
                <div className="d"><Delta cur={hSpend} prev={pSpend} isAr={isAr} /> {isAr ? 'عن السابقة' : 'vs prev'}</div>
              </div>
              <div className="stat">
                <div className="k">{isAr ? 'العملاء المحتملون' : 'Leads'}</div>
                <div className="v">{num(hLeads, isAr)}</div>
                <div className="d"><Delta cur={hLeads} prev={pLeads} isAr={isAr} /> {isAr ? 'عن السابقة' : 'vs prev'}</div>
              </div>
              <div className="stat">
                <div className="k">{isAr ? 'المؤهلون' : 'Qualified'}</div>
                <div className="v">{num(t.qualified, isAr)}</div>
                <div className="d">{hLeads > 0 ? <>{pct(Math.round((t.qualified / hLeads) * 100), isAr)} {isAr ? 'من العملاء' : 'of leads'}</> : '—'}</div>
              </div>
              <div className="stat">
                <div className="k">{isAr ? 'الظهور' : 'Impressions'}</div>
                <div className="v">{num(t.impressions, isAr)}</div>
                <div className="d">{num(t.clicks, isAr)} {isAr ? 'نقرة' : 'clicks'}</div>
              </div>
            </div>

            {/* media efficiency */}
            <div className="an-sec">
              <h4>{isAr ? 'كفاءة الوسائط المدفوعة' : 'Paid-media efficiency'}</h4>
              <span>{isAr ? 'CPM · CPC · CTR · CPL' : 'CPM · CPC · CTR · CPL'}</span>
            </div>
            <div className="an-g4" style={{ marginBottom: 6 }}>
              <MediaCard abbr="CPM" name={isAr ? 'تكلفة الألف ظهور' : 'Cost / 1k impressions'} val={m.cpm} prev={mPrev?.cpm ?? 0} unit={isAr ? 'ر.س' : 'SAR'} dec={1} invert isAr={isAr} spark={spark((x) => x.cpm)} />
              <MediaCard abbr="CPC" name={isAr ? 'تكلفة النقرة' : 'Cost / click'} val={m.cpc} prev={mPrev?.cpc ?? 0} unit={isAr ? 'ر.س' : 'SAR'} dec={2} invert isAr={isAr} spark={spark((x) => x.cpc)} />
              <MediaCard abbr="CTR" name={isAr ? 'نسبة النقر' : 'Click-through'} val={m.ctr} prev={mPrev?.ctr ?? 0} unit={isAr ? '٪' : '%'} dec={2} isAr={isAr} spark={spark((x) => x.ctr)} />
              <MediaCard
                abbr="CPL" name={isAr ? 'تكلفة العميل' : 'Cost / lead'} val={m.cpl} prev={mPrev?.cpl ?? 0} unit={isAr ? 'ر.س' : 'SAR'} dec={0} invert isAr={isAr}
                spark={spark((x) => x.cpl)}
              />
            </div>
            <div className="an-note" style={{ marginBottom: 16 }}>
              {isAr
                ? <>الأرقام يومية من مزامنة ميتا ومحصورة بالفترة المختارة. العملاء هنا هم من تحسبهم ميتا.</>
                : <>Figures are daily, from the Meta sync, and limited to the selected period. Leads here are the ones Meta counts.</>}
            </div>

            {/* media funnel */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-h"><h4>{isAr ? 'مسار الوسائط — أين يُصرف كل ريال' : 'Media funnel — where each riyal goes'}</h4></div>
              <div className="card-b">
                <div className="mfunnel">
                  <div className="mstage">
                    <div className="l">{isAr ? 'الظهور' : 'Impressions'}</div>
                    <div className="v">{num(t.impressions, isAr)}</div>
                    <div className="x">CPM {num(Number(m.cpm.toFixed(1)), isAr)} {isAr ? 'ر.س / ألف' : 'SAR / 1k'}</div>
                  </div>
                  <div className="mgap">
                    <span className="arr">←</span>
                    <div className="g">CTR <b>{num(Number(m.ctr.toFixed(2)), isAr)}{isAr ? '٪' : '%'}</b><br />CPC <b>{num(Number(m.cpc.toFixed(2)), isAr)}</b> {isAr ? 'ر.س' : 'SAR'}</div>
                  </div>
                  <div className="mstage">
                    <div className="l">{isAr ? 'النقرات' : 'Clicks'}</div>
                    <div className="v">{num(t.clicks, isAr)}</div>
                    <div className="x">{isAr ? 'من إجمالي الظهور' : 'of impressions'}</div>
                  </div>
                  <div className="mgap">
                    <span className="arr">←</span>
                    <div className="g">{isAr ? 'تحويل' : 'Conv.'} <b>{num(t.clicks > 0 ? Number(((hLeads / t.clicks) * 100).toFixed(1)) : 0, isAr)}{isAr ? '٪' : '%'}</b><br />CPL <b>{num(Math.round(m.cpl), isAr)}</b> {isAr ? 'ر.س' : 'SAR'}</div>
                  </div>
                  <div className="mstage">
                    <div className="l">{isAr ? 'العملاء' : 'Leads'}</div>
                    <div className="v">{num(hLeads, isAr)}</div>
                    <div className="x">{hLeads > 0 ? <>{num(Math.round((t.qualified / hLeads) * 100), isAr)}{isAr ? '٪ مؤهل' : '% qualified'}</> : '—'}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* daily trends */}
            <div className="an-g2" style={{ marginBottom: 16 }}>
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'الإنفاق اليومي' : 'Daily spend'}</h4><span className="an-gran">{bk ? granLabel(bk.mode, isAr) : ''}</span></div>
                <div className="card-b">
                  {hasDaily && bk
                    ? <TrendChart points={bk.items.map((b) => ({ label: b.label, value: b.spend }))} color="var(--copper)" fmt={(v) => num(Math.round(v), isAr)} />
                    : <DailyEmpty isAr={isAr} />}
                </div>
              </div>
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'تكلفة العميل عبر الزمن' : 'Cost per lead over time'}</h4><span className="r">{isAr ? 'أقل = أفضل' : 'lower is better'}</span></div>
                <div className="card-b">
                  {hasDaily && bk
                    ? <TrendChart points={cplSeries} color="var(--go)" area={false} fmt={(v) => num(Math.round(v), isAr)} />
                    : <DailyEmpty isAr={isAr} />}
                </div>
              </div>
            </div>

            {hasDaily && bk && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-h"><h4>{isAr ? 'العملاء المحتملون' : 'Leads'}</h4><span className="an-gran">{granLabel(bk.mode, isAr)}</span></div>
                <div className="card-b"><BarChart points={bk.items.map((b) => ({ label: b.label, value: b.leads }))} color="var(--gold)" fmt={(v) => num(v, isAr)} /></div>
              </div>
            )}

            {/* platform + campaign */}
            <div className="an-g2">
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'حسب المنصّة' : 'By platform'}</h4><span className="r">{isAr ? 'ضمن الفترة' : 'in range'}</span></div>
                <div className="card-b">
                  {cur.by_platform.length === 0
                    ? <div style={{ color: 'var(--mute)', fontSize: 12.5 }}>{isAr ? 'لا بيانات منصّات.' : 'No platform data.'}</div>
                    : cur.by_platform.map((p) => {
                      const maxSpend = Math.max(1, ...cur.by_platform.map((x) => x.spend));
                      const pl = PLATFORM_LABELS[p.platform];
                      const label = pl ? (isAr ? pl.ar : pl.en) : p.platform;
                      return (
                        <div key={p.platform} className="platrow">
                          <span className="pn">{label}</span>
                          <span className="track"><i style={{ width: `${(p.spend / maxSpend) * 100}%`, background: PLATFORM_COLOR[p.platform] ?? 'var(--copper)' }} /></span>
                          <span className="pv">{num(Math.round(p.spend), isAr)}</span>
                        </div>
                      );
                    })}
                </div>
              </div>

              <div className="card">
                <div className="card-h"><h4>{isAr ? 'حسب الحملة' : 'By campaign'}</h4><span className="r">{isAr ? 'الأعلى إنفاقًا' : 'top spend'}</span></div>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>{isAr ? 'الحملة' : 'Campaign'}</th>
                        <th className="n">{isAr ? 'أُنفق' : 'Spent'}</th>
                        <th className="n">CTR</th>
                        <th className="n">CPL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cur.by_campaign.filter((c) => c.spend > 0 || c.impressions > 0).map((c) => {
                        const ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0;
                        const cpl = c.leads > 0 ? c.spend / c.leads : null;
                        return (
                          <tr key={c.id}>
                            <td className="ttl">{c.name}</td>
                            <td className="n">{num(Math.round(c.spend), isAr)}</td>
                            <td className="n">{ctr > 0 ? pct(Number(ctr.toFixed(2)), isAr, 2) : '—'}</td>
                            <td className="n">{cpl !== null ? num(Math.round(cpl), isAr) : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {undatedSpend > 0 && (
              /* Beside the period, never inside it: this money has no days. */
              <div className="an-note">
                {isAr
                  ? <>{num(Math.round(undatedSpend), true)} ر.س أُنفقت على حملات قديمة بلا أرقام يومية، فلا تدخل في أي فترة ولا تظهر أعلاه.</>
                  : <>{num(Math.round(undatedSpend), false)} SAR was spent on older campaigns with no daily figures, so it belongs to no period and is not included above.</>}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}


function DailyEmpty({ isAr }: { isAr: boolean }) {
  return (
    <div style={{ padding: '18px 4px' }}>
      <Empty
        title={isAr ? 'لا أرقام يومية بعد' : 'No daily figures yet'}
        body={isAr
          ? 'تظهر السلسلة الزمنية فور إدخال الأرقام اليومية للحملات (الإنفاق والعملاء لكل يوم).'
          : 'The time series appears once daily campaign figures (spend and leads per day) are entered.'}
      />
    </div>
  );
}

/** One CPM/CPC/CTR/CPL card: value + unit, delta, optional sparkline. */
function MediaCard({
  abbr, name, val, prev, unit, dec, invert, isAr, spark,
}: {
  abbr: string; name: string; val: number; prev: number; unit: string;
  dec: number; invert?: boolean; isAr: boolean; spark?: number[];
}) {
  const shown = dec > 0 ? Number(val.toFixed(dec)) : Math.round(val);
  return (
    <div className="mcard">
      <div className="top"><span className="abbr">{abbr}</span><span className="nm">{name}</span></div>
      <div className="v">{val > 0 ? num(shown, isAr) : '—'} <small>{unit}</small></div>
      <div className="sub"><Delta cur={val} prev={prev} invert={invert} isAr={isAr} /><span>{isAr ? 'عن الفترة السابقة' : 'vs previous'}</span></div>
      {spark && spark.length > 1 && <div className="spark"><Sparkline values={spark} color="var(--gold)" /></div>}
    </div>
  );
}
