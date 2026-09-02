/**
 * Overview — design screens 01 (marketing manager) and 34 (CEO).
 *
 * The manager's state: four numbers that answer «هل الآلة تعمل؟», then the two
 * lists that need a decision today — what has stopped moving, and what goes out
 * this week. The one job is spotting the bottleneck in under ten seconds.
 *
 * The CEO's state (s34) is the same nav item with completely different content:
 * no queue, no stalled list — the CEO is not a production manager. Three
 * questions only: are we producing enough, at what cost, and what came back.
 * Every number here is a RESULT, not an activity.
 */
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  CeoPeriod,
  MosCeoOverview,
  MosOverview,
  OverviewPeriod,
  PLATFORM_CLASS,
  PLATFORM_LABELS,
  ROLE_LABELS,
  SUCCESS_METRIC_LABELS,
  fetchCeoOverview,
  fetchOverview,
  remindContent,
  signCampaign,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, PageHead, Pill, Skeleton, Stat } from './components/kit';
import NewContentModal from './components/NewContentModal';
import EmptyDayOne from './components/EmptyDayOne';
import { IconPlus } from './components/icons';
import { dayLabel, daysAgo, money, monthName, monthOf, num, shortDate, toArabicDigits } from './lib/format';

const QUARTER_NAMES_AR = ['الأول', 'الثاني', 'الثالث', 'الرابع'];

/**
 * The shell's phone breakpoint (mobile-shell.css). No shared matchMedia hook
 * exists in the codebase, so each mobile-aware page carries this small one.
 */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const sync = (): void => setMobile(mq.matches);
    // Both signals: emulated viewports (devtools/webviews) can resize without
    // firing the media-query change event.
    mq.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);
  return mobile;
}

export default function OverviewPage() {
  const { role } = useWorkspace();
  return role === 'ceo' ? <CeoOverview /> : <ManagerOverview />;
}

/* ------------------------------------------------------------------ */
/* screen 01 — the manager's state                                     */
/* ------------------------------------------------------------------ */

function ManagerOverview() {
  const { isAr, can, people } = useWorkspace();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const addToast = useAppStore((s) => s.addToast);
  const [period, setPeriod] = useState<OverviewPeriod>('week');
  const [data, setData] = useState<MosOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (p: OverviewPeriod) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchOverview(p));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(period); }, [load, period]);

  const remind = async (e: MouseEvent, contentId: string) => {
    e.stopPropagation();
    try {
      await remindContent(contentId);
      addToast(isAr ? 'أُرسل التذكير إلى صاحب المهمة' : 'Reminder sent to the task holder', 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const videoCount = (data?.mix ?? []).filter((m) => m.content_type_key === 'video').length;
  const postCount = (data?.mix ?? []).length - videoCount;
  const inProduction = data?.counts.in_production ?? 0;

  const scheduledCount = data?.week.length ?? 0;
  const unscheduledCount = data?.unscheduled.length ?? 0;
  const publishingTotal = scheduledCount + unscheduledCount;

  // «٣ أشخاص في الإنتاج» — people holding a production role.
  const productionPeople = people.filter((p) =>
    p.roles.some((r) => r === 'writer' || r === 'montage' || r === 'ops_supervisor')).length;

  const periodSub = (d: MosOverview): string => {
    // Years carry no thousands separator — «٢٠٢٦», never «٢,٠٢٦».
    const y = new Date(d.week_start).getFullYear();
    const year = isAr ? toArabicDigits(String(y)) : String(y);
    let range: string;
    if (d.period === 'month') {
      range = `${monthOf(d.week_start, isAr)} ${year}`;
    } else if (d.period === 'quarter') {
      const q = Math.floor(new Date(d.week_start).getMonth() / 3);
      range = isAr
        ? `الربع ${QUARTER_NAMES_AR[q] ?? ''} ${year}`
        : `Q${q + 1} ${year}`;
    } else {
      range = isAr
        ? `أسبوع ${shortDate(d.week_start, true)} – ${shortDate(d.week_end, true)} ${year}`
        : `Week of ${shortDate(d.week_start, false)} – ${shortDate(d.week_end, false)}`;
    }
    return productionPeople > 0
      ? isAr
        ? `${range} · ${num(productionPeople, true)} أشخاص في الإنتاج`
        : `${range} · ${productionPeople} in production`
      : range;
  };

  const lateDetail = (d: MosOverview): string => {
    if (d.counts.late === 0 || d.late_mix.length === 0) {
      return isAr ? 'لا شيء متأخر' : 'Nothing is late';
    }
    return d.late_mix.slice(0, 2)
      .map((m) => isAr ? `${num(m.n, true)} في ${m.label_ar}` : `${m.n} in ${m.label_en}`)
      .join(isAr ? ' · ' : ' · ');
  };

  // Day one (screen 45): zero content AND zero campaigns = the honest empty
  // state with the real-state setup checklist — never a wall of empty zeros.
  if (data && inProduction === 0 && (data.mix ?? []).length === 0
      && (data.campaigns ?? []).length === 0) {
    return <EmptyDayOne />;
  }

  return (
    <>
      <PageHead
        title={isAr ? 'نظرة عامة' : 'Overview'}
        sub={data ? periodSub(data) : undefined}
      >
        <div className="seg">
          <button type="button" className={period === 'week' ? 'on' : ''} onClick={() => setPeriod('week')}>
            {isAr ? 'هذا الأسبوع' : 'This week'}
          </button>
          <button type="button" className={period === 'month' ? 'on' : ''} onClick={() => setPeriod('month')}>
            {isAr ? 'الشهر' : 'Month'}
          </button>
          <button type="button" className={period === 'quarter' ? 'on' : ''} onClick={() => setPeriod('quarter')}>
            {isAr ? 'الربع' : 'Quarter'}
          </button>
        </div>
        {can('write_content') && !isMobile && (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            <IconPlus />
            {isAr ? 'محتوى جديد' : 'New content'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load(period)} isAr={isAr} />}
        {loading && !data && <Skeleton rows={6} />}

        {/* s52 phone2 — «اللوحة تُكدَّس ولا تُختصر»: the same four numbers in
            the same order as a 2×2 card grid, then the stalled list, then what
            publishes, then the paid card. Nothing dropped, nothing squeezed. */}
        {data && isMobile && (
          <>
            <div className="m1-stats">
              <div className="m1-stat">
                <div className="lbl">{isAr ? 'تحت الإنتاج' : 'In production'}</div>
                <div className="v">{num(inProduction, isAr)}</div>
                <div className="d">
                  {isAr
                    ? `${num(postCount, true)} منشور · ${num(videoCount, true)} فيديو`
                    : `${postCount} posts · ${videoCount} video`}
                </div>
              </div>
              <div className="m1-stat">
                <div className="lbl">{isAr ? 'بانتظارك' : 'Waiting on you'}</div>
                <div className="v">{num(data.counts.waiting_on_me, isAr)}</div>
                <div className="d">
                  {data.counts.waiting_on_me > 0 && data.waiting_oldest_at
                    ? isAr
                      ? `أقدمها ${daysAgo(data.waiting_oldest_at, true)}`
                      : `oldest ${daysAgo(data.waiting_oldest_at, false)}`
                    : isAr ? 'لا شيء بانتظارك' : 'nothing waits on you'}
                </div>
              </div>
              <div className="m1-stat">
                <div className="lbl">
                  {data.period === 'week'
                    ? isAr ? 'يُنشر هذا الأسبوع' : 'Publishing this week'
                    : isAr ? 'يُنشر في هذه الفترة' : 'Publishing this period'}
                </div>
                <div className="v">{num(publishingTotal, isAr)}</div>
                <div className="d">
                  {unscheduledCount > 0
                    ? isAr ? `${num(unscheduledCount, true)} بلا موعد` : `${unscheduledCount} unscheduled`
                    : isAr ? `${num(scheduledCount, true)} مجدولة` : `${scheduledCount} scheduled`}
                </div>
              </div>
              <div className="m1-stat late">
                <div className="lbl">{isAr ? 'متأخر' : 'Late'}</div>
                <div className="v">{num(data.counts.late, isAr)}</div>
                <div className="d">{lateDetail(data)}</div>
              </div>
            </div>

            <div className="m1-lbl" style={{ marginTop: 4 }}>
              {isAr ? 'متوقف منذ ٤٨ ساعة' : 'Stalled — nothing moved in 48h'}
            </div>
            {data.stalled.length === 0 ? (
              <div className="m1-card" style={{ cursor: 'default' }}>
                <div className="m1-m" style={{ marginTop: 0 }}>
                  {isAr
                    ? 'لا شيء متوقف — كل عنصر تحت الإنتاج تحرّك مؤخرًا.'
                    : 'Nothing is stuck — everything in production has moved recently.'}
                </div>
              </div>
            ) : data.stalled.map((r) => (
              <button
                key={r.id}
                type="button"
                className="m1-card m1-stall"
                onClick={() => navigate(`/m/content/${r.id}`)}
              >
                <div className="m1-row">
                  <span className="m1-id ltr">{r.ref ?? '—'}</span>
                  <span className="pill p-late">{daysAgo(r.updated_at, isAr)}</span>
                </div>
                <div className="t2">{r.title}</div>
                <div className="s">
                  {(isAr ? r.current_step_label_ar : r.current_step_label_en) ?? r.status_key}
                  {' · '}
                  {r.owner_role && ROLE_LABELS[r.owner_role]
                    ? isAr
                      ? `لدى ${ROLE_LABELS[r.owner_role].ar}`
                      : `with ${ROLE_LABELS[r.owner_role].en}`
                    : isAr ? 'بلا مالك' : 'no owner'}
                </div>
              </button>
            ))}

            <div className="m1-lbl">
              {data.period === 'week'
                ? isAr ? 'يُنشر هذا الأسبوع' : 'Publishing this week'
                : isAr ? 'يُنشر في هذه الفترة' : 'Publishing this period'}
            </div>
            <div className="card m1-pubcard">
              <div className="card-b" style={{ padding: '10px 14px 14px' }}>
                <WeekList data={data} isAr={isAr} />
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              <PaidAdsCard data={data} isAr={isAr} />
            </div>
            {data.campaigns.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.8, marginTop: 10 }}>
                {isAr
                  ? 'أرقام الإعلانات مُدخلة يدويًا حتى تُربط المنصات. أي رقم قد يكذب، يقول ذلك بنفسه.'
                  : 'Ad numbers are typed in by hand until the platforms are connected. Any number that could lie says so itself.'}
              </div>
            )}
          </>
        )}

        {data && !isMobile && (
          <>
            <div className="grid g4" style={{ marginBottom: 18 }}>
              <Stat
                isAr={isAr}
                label={isAr ? 'تحت الإنتاج' : 'In production'}
                value={inProduction}
                detail={isAr
                  ? `${num(postCount, true)} منشور · ${num(videoCount, true)} فيديو`
                  : `${postCount} posts · ${videoCount} video`}
                meter={[
                  { pct: inProduction > 0 ? (postCount / inProduction) * 100 : 0, color: 'var(--copper)' },
                  { pct: inProduction > 0 ? (videoCount / inProduction) * 100 : 0, color: 'var(--gold)' },
                ]}
              />
              <Stat
                isAr={isAr}
                label={isAr ? 'بانتظارك أنت' : 'Waiting on you'}
                value={data.counts.waiting_on_me}
                detail={data.counts.waiting_on_me > 0 && data.waiting_oldest_at
                  ? isAr
                    ? `أقدمها منتظر منذ ${daysAgo(data.waiting_oldest_at, true)}`
                    : `oldest waiting ${daysAgo(data.waiting_oldest_at, false)}`
                  : isAr ? 'لا شيء بانتظارك' : 'nothing waits on you'}
                meter={[{ pct: 70, color: 'var(--wait)' }]}
              />
              <Stat
                isAr={isAr}
                label={data.period === 'week'
                  ? isAr ? 'يُنشر هذا الأسبوع' : 'Publishing this week'
                  : isAr ? 'يُنشر في هذه الفترة' : 'Publishing this period'}
                value={publishingTotal}
                detail={isAr
                  ? `${num(scheduledCount, true)} مجدولة · ${num(unscheduledCount, true)} بلا موعد`
                  : `${scheduledCount} scheduled · ${unscheduledCount} unscheduled`}
                meter={[
                  { pct: publishingTotal > 0 ? (scheduledCount / publishingTotal) * 100 : 0, color: 'var(--go)' },
                  { pct: publishingTotal > 0 ? (unscheduledCount / publishingTotal) * 100 : 0, color: 'var(--sand)' },
                ]}
              />
              <Stat
                isAr={isAr}
                alert={data.counts.late > 0}
                label={isAr ? 'متأخر' : 'Late'}
                value={data.counts.late}
                detail={lateDetail(data)}
                meter={[{ pct: 100, color: 'var(--late)' }]}
              />
            </div>

            <div className="grid main-rail-155">
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'متوقف — لم يتحرك منذ ٤٨ ساعة' : 'Stalled — nothing moved in 48h'}</h4>
                  <span className="r">{isAr ? 'مرتب حسب مدة التوقف' : 'longest stalled first'}</span>
                </div>
                {data.stalled.length === 0 ? (
                  <div style={{ padding: 22 }}>
                    <Empty
                      title={isAr ? 'لا شيء متوقف' : 'Nothing is stuck'}
                      body={isAr
                        ? 'كل عنصر تحت الإنتاج تحرّك مؤخرًا. هذه هي الحالة التي تريدها.'
                        : 'Everything in production has moved recently. This is the state you want.'}
                    />
                  </div>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>{isAr ? 'الرقم' : 'Ref'}</th>
                          <th>{isAr ? 'العنوان' : 'Title'}</th>
                          <th>{isAr ? 'المرحلة' : 'Stage'}</th>
                          <th>{isAr ? 'لدى' : 'With'}</th>
                          <th className="num">{isAr ? 'متوقف' : 'Stalled'}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {data.stalled.map((r, i) => {
                          const stale = (Date.now() - new Date(r.updated_at).getTime()) / 86_400_000;
                          return (
                            <tr
                              key={r.id}
                              className={`click${i === 0 && stale > 2 ? ' hl' : ''}`}
                              onClick={() => navigate(`/m/content/${r.id}`)}
                            >
                              <td className="id">{r.ref ?? '—'}</td>
                              <td className="ttl">{r.title}</td>
                              <td>
                                <Pill tone={stale > 2 ? 'wait' : 'now'}>
                                  {(isAr ? r.current_step_label_ar : r.current_step_label_en) ?? r.status_key}
                                </Pill>
                              </td>
                              <td>
                                {r.owner_role && ROLE_LABELS[r.owner_role]
                                  ? isAr ? ROLE_LABELS[r.owner_role].ar : ROLE_LABELS[r.owner_role].en
                                  : '—'}
                              </td>
                              <td
                                className="num"
                                style={stale > 2 ? { color: 'var(--late)', fontWeight: 700 } : undefined}
                              >
                                {daysAgo(r.updated_at, isAr)}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  onClick={(e) => void remind(e, r.id)}
                                >
                                  {isAr ? 'تذكير' : 'Remind'}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
                <div className="card">
                  <div className="card-h">
                    <h4>{isAr ? 'يُنشر هذا الأسبوع' : 'Publishing this week'}</h4>
                    <span className="r">{num(publishingTotal, isAr)}</span>
                  </div>
                  <div className="card-b" style={{ padding: '10px 14px 14px' }}>
                    <WeekList data={data} isAr={isAr} />
                  </div>
                </div>

                <PaidAdsCard data={data} isAr={isAr} />

                {data.campaigns.length === 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.8 }}>
                    {isAr
                      ? 'أرقام الإعلانات مُدخلة يدويًا حتى تُربط المنصات. أي رقم قد يكذب، يقول ذلك بنفسه.'
                      : 'Ad numbers are typed in by hand until the platforms are connected. Any number that could lie says so itself.'}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {creating && <NewContentModal onClose={() => setCreating(false)} onCreatedMany={() => void load(period)} />}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* shared pieces — one implementation for desktop and the s52 phone    */
/* ------------------------------------------------------------------ */

/** The «يُنشر هذا الأسبوع» rows — scheduled .ev chips + the needs-a-slot row. */
function WeekList({ data, isAr }: { data: MosOverview; isAr: boolean }) {
  const navigate = useNavigate();
  const publishingTotal = data.week.length + data.unscheduled.length;
  if (publishingTotal === 0) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--mute)' }}>
        {isAr
          ? 'لا شيء مجدول لهذه الفترة بعد.'
          : 'Nothing is scheduled for this period yet.'}
      </div>
    );
  }
  return (
    <>
      {data.week.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`ev ${PLATFORM_CLASS[p.platform] ?? ''}`}
          onClick={() => navigate(`/m/content/${p.content_id}`)}
        >
          <span>
            {dayLabel(p.scheduled_at, isAr)} ·{' '}
            {(isAr ? PLATFORM_LABELS[p.platform]?.ar : PLATFORM_LABELS[p.platform]?.en) ?? p.platform}
            {' · '}
          </span>
          <b style={{ fontWeight: 700 }}>
            {p.ref ? `${p.ref} ` : ''}{p.title ?? ''}
          </b>
        </button>
      ))}
      {data.unscheduled.length > 0 && (
        <div className="ev due">
          <span>
            {isAr ? 'بحاجة لموعد نشر' : 'Needs a slot'}
            {' · '}
          </span>
          <b style={{ fontWeight: 700 }}>
            {data.unscheduled.map((u) => u.ref ?? u.title).join(isAr ? '، ' : ', ')}
          </b>
        </div>
      )}
    </>
  );
}

/** The «الإعلانات المدفوعة» paid-ads card — same DOM on both layouts. Numbers
 *  may be Meta-synced or hand-entered, so it no longer claims a single source. */
function PaidAdsCard({ data, isAr }: { data: MosOverview; isAr: boolean }) {
  const budget = (data.campaigns ?? []).reduce((a, c) => a + (c.budget_total ?? 0), 0);
  const spent = (data.campaigns ?? []).reduce((a, c) => a + (c.total_spend ?? 0), 0);
  const leads = (data.campaigns ?? []).reduce((a, c) => a + (c.total_leads ?? 0), 0);
  const qualified = (data.campaigns ?? []).reduce((a, c) => a + (c.total_qualified ?? 0), 0);
  const cpl = leads > 0 ? spent / leads : null;
  return (
    <div className="card">
      <div className="card-h">
        <h4>
          {isAr
            ? `الإعلانات المدفوعة — ${monthOf(data.week_start, true)}`
            : `Paid ads — ${monthOf(data.week_start, false)}`}
        </h4>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 11 }}>
        <div>
          <div className="lbl">{isAr ? 'المصروف من الميزانية' : 'Spent of budget'}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginTop: 4 }}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>
              {num(Math.round(spent), isAr)}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
              {isAr ? `من ${num(Math.round(budget), true)} ريال` : `of ${num(Math.round(budget), false)} SAR`}
            </span>
          </div>
          <div className="meter" style={{ marginTop: 8 }}>
            <i style={{ width: `${budget > 0 ? Math.min(100, (spent / budget) * 100) : 0}%`, background: 'var(--copper)' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <div>
            <div className="lbl">{isAr ? 'العملاء' : 'Leads'}</div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 20 }}>{num(leads, isAr)}</div>
          </div>
          <div>
            <div className="lbl">{isAr ? 'تكلفة العميل' : 'Cost per lead'}</div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 20 }}>
              {cpl === null ? '—' : num(Math.round(cpl), isAr)}
              {cpl !== null && (
                <span style={{ fontSize: 11, color: 'var(--mute)' }}> {isAr ? 'ر.س' : 'SAR'}</span>
              )}
            </div>
          </div>
          <div>
            <div className="lbl">{isAr ? 'المؤهلون' : 'Qualified'}</div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 20 }}>{num(qualified, isAr)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* screen 34 — the CEO's state: results, not activity                  */
/* ------------------------------------------------------------------ */

function CeoOverview() {
  const { isAr } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const [period, setPeriod] = useState<CeoPeriod>('quarter');
  const [data, setData] = useState<MosCeoOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState<string | null>(null);

  const load = useCallback(async (p: CeoPeriod) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchCeoOverview(p));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(period); }, [load, period]);

  const sign = async (campaignId: string) => {
    setSigning(campaignId);
    try {
      await signCampaign(campaignId);
      addToast(isAr ? 'وُقّعت الميزانية' : 'Budget signed', 'success');
      await load(period);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSigning(null);
    }
  };

  const now = new Date();
  const producedDelta = data && data.produced_prev > 0
    ? Math.round(((data.produced - data.produced_prev) / data.produced_prev) * 100)
    : null;
  const qualifiedPct = data && data.leads > 0
    ? Math.round((data.qualified / data.leads) * 100)
    : null;
  const costPerReservation = data && data.reservations > 0
    ? Math.round(data.spend / data.reservations)
    : null;
  const perHundred = data && data.leads > 0
    ? Math.round((data.reservations / data.leads) * 100)
    : null;

  // «مرتبة بالعائد» — reservations at the best cost first; spend without
  // return sinks to the bottom, which is exactly what the CEO is looking for.
  const campaignsByReturn = [...(data?.campaigns ?? [])].sort((a, b) => {
    if (a.cost_per_reservation !== null && b.cost_per_reservation !== null) {
      return a.cost_per_reservation - b.cost_per_reservation;
    }
    if (a.cost_per_reservation !== null) return -1;
    if (b.cost_per_reservation !== null) return 1;
    return b.spend - a.spend;
  });
  const awarenessNoReturn = campaignsByReturn.find((c) =>
    c.spend > 0 && c.reservations === 0 && c.objective === 'awareness');

  const maxMonthly = Math.max(1, ...(data?.production_by_month ?? []).map((m) => m.count));

  return (
    <>
      <PageHead
        title={isAr ? 'نظرة عامة' : 'Overview'}
        sub={isAr
          ? `الرئيس التنفيذي · ${monthName(now.getMonth(), true)} ${num(now.getFullYear(), true)} · عرض للقراءة`
          : `CEO · ${monthName(now.getMonth(), false)} ${now.getFullYear()} · read view`}
      >
        <div className="seg">
          <button type="button" className={period === 'month' ? 'on' : ''} onClick={() => setPeriod('month')}>
            {isAr ? 'الشهر' : 'Month'}
          </button>
          <button type="button" className={period === 'quarter' ? 'on' : ''} onClick={() => setPeriod('quarter')}>
            {isAr ? 'الربع' : 'Quarter'}
          </button>
          <button type="button" className={period === 'year' ? 'on' : ''} onClick={() => setPeriod('year')}>
            {isAr ? 'السنة' : 'Year'}
          </button>
        </div>
        <button type="button" className="btn btn-d" onClick={() => navigate('/m/numbers')}>
          {isAr ? 'تقرير شهري' : 'Monthly report'}
        </button>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load(period)} isAr={isAr} />}
        {loading && !data && <Skeleton rows={6} />}

        {data && (
          <>
            <div className="grid g4" style={{ marginBottom: 18 }}>
              <Stat
                isAr={isAr}
                label={isAr ? 'أُنتج ونُشر' : 'Produced & published'}
                value={data.produced}
                detail={producedDelta !== null
                  ? isAr
                    ? `مقابل ${num(data.produced_prev, true)} في الفترة السابقة · ${producedDelta >= 0 ? '+' : '−'}${num(Math.abs(producedDelta), true)}٪`
                    : `vs ${data.produced_prev} last period · ${producedDelta >= 0 ? '+' : '−'}${Math.abs(producedDelta)}%`
                  : isAr ? 'لا مقارنة بعد' : 'no comparison yet'}
                meter={[{ pct: 100, color: 'var(--go)' }]}
              />
              <Stat
                isAr={isAr}
                label={isAr ? 'الإنفاق الإعلاني' : 'Ad spend'}
                value={Math.round(data.spend)}
                detail={isAr
                  ? `من ${num(Math.round(data.committed), true)} ريال ملتزم بها`
                  : `of ${num(Math.round(data.committed), false)} SAR committed`}
                meter={[{
                  pct: data.committed > 0 ? Math.min(100, (data.spend / data.committed) * 100) : 0,
                  color: 'var(--copper)',
                }]}
              />
              <Stat
                isAr={isAr}
                label={isAr ? 'عملاء مؤهلون' : 'Qualified leads'}
                value={data.qualified}
                detail={qualifiedPct !== null
                  ? isAr
                    ? `من ${num(data.leads, true)} استفسارًا · ${num(qualifiedPct, true)}٪`
                    : `of ${data.leads} enquiries · ${qualifiedPct}%`
                  : isAr ? 'لا استفسارات بعد' : 'no enquiries yet'}
                meter={[
                  { pct: qualifiedPct ?? 0, color: 'var(--go)' },
                  { pct: qualifiedPct !== null ? 100 - qualifiedPct : 0, color: 'var(--sand)' },
                ]}
              />
              <Stat
                isAr={isAr}
                label={isAr ? 'حجوزات منسوبة' : 'Attributed reservations'}
                value={data.reservations}
                detail={isAr
                  ? `${money(data.reservation_value, true)} · تكلفة الحجز ${costPerReservation !== null ? num(costPerReservation, true) : '—'}`
                  : `${money(data.reservation_value, false)} · cost ${costPerReservation !== null ? num(costPerReservation, false) : '—'}`}
                meter={[{ pct: 100, color: 'var(--gold)' }]}
              />
            </div>

            <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', marginBottom: 16 }}>
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'من الريال إلى الحجز' : 'From riyal to reservation'}</h4>
                  <span className="r">
                    {isAr ? `${monthOf(data.period_start, true)} حتى اليوم` : `${monthOf(data.period_start, false)} to date`}
                  </span>
                </div>
                <div className="card-b">
                  <div className="funnel">
                    {([
                      { v: data.leads, label: isAr ? 'استفسار' : 'Enquiry', color: 'var(--copper)' },
                      { v: data.qualified, label: isAr ? 'مؤهل' : 'Qualified', color: 'var(--terracotta)' },
                      { v: data.appointments, label: isAr ? 'موعد' : 'Appointment', color: 'var(--gold)' },
                      { v: data.reservations, label: isAr ? 'حجز' : 'Reservation', color: 'var(--choc)' },
                    ]).map((b) => {
                      const max = Math.max(1, data.leads);
                      return (
                        <div key={b.label} className="funnel-col">
                          <div style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>{num(b.v, isAr)}</div>
                          <div style={{
                            width: '100%',
                            height: `${Math.max(3, Math.round((b.v / max) * 100))}%`,
                            background: b.color,
                            borderRadius: '5px 5px 0 0',
                          }} />
                          <div style={{ fontSize: 11, color: 'var(--mute)' }}>{b.label}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{
                    fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.85,
                    paddingTop: 11, borderTop: '1px solid var(--line-soft)',
                  }}>
                    {isAr ? (
                      <>
                        {perHundred !== null
                          ? `من كل ١٠٠ استفسار يصل ${num(perHundred, true)} إلى حجز. `
                          : ''}
                        تحسين نسبة <b>المؤهل ← الموعد</b> هو أرخص مكان للتحسين، وهو خارج التسويق — عند المبيعات.
                      </>
                    ) : (
                      <>
                        {perHundred !== null ? `${perHundred} of every 100 enquiries reach a reservation. ` : ''}
                        Improving the <b>qualified → appointment</b> rate is the cheapest place to improve,
                        and it sits outside marketing — with sales.
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'الحملات' : 'Campaigns'}</h4>
                  <span className="r">{isAr ? 'مرتبة بالعائد' : 'by return'}</span>
                </div>
                {campaignsByReturn.length === 0 ? (
                  <div style={{ padding: 22 }}>
                    <Empty
                      title={isAr ? 'لا حملات بعد' : 'No campaigns yet'}
                      body={isAr
                        ? 'حين تعمل أول حملة سيظهر عائدها هنا مرتبًا.'
                        : 'Once the first campaign runs, its return appears here.'}
                    />
                  </div>
                ) : (
                  <>
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>{isAr ? 'الحملة' : 'Campaign'}</th>
                            <th className="num">{isAr ? 'أُنفق' : 'Spent'}</th>
                            <th className="num">{isAr ? 'مؤهل' : 'Qualified'}</th>
                            <th className="num">{isAr ? 'حجز' : 'Reserv.'}</th>
                            <th className="num">{isAr ? 'تكلفة الحجز' : 'Cost / reserv.'}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {campaignsByReturn.map((c) => {
                            const ended = c.status === 'done';
                            return (
                              <tr
                                key={c.id}
                                className="click"
                                style={ended ? { opacity: 0.7 } : undefined}
                                onClick={() => navigate(`/m/campaigns/${c.id}`)}
                              >
                                <td className="ttl">
                                  {c.name}
                                  {ended && c.starts_on && (
                                    <span style={{ fontWeight: 400, color: 'var(--mute)' }}>
                                      {' · '}{monthOf(c.starts_on, isAr)}
                                    </span>
                                  )}
                                </td>
                                <td className="num" style={c.spend === 0 ? { color: 'var(--mute)' } : undefined}>
                                  {c.spend > 0 ? num(Math.round(c.spend), isAr) : '—'}
                                </td>
                                <td className="num">{num(c.qualified, isAr)}</td>
                                <td className="num">{num(c.reservations, isAr)}</td>
                                <td
                                  className="num"
                                  style={c.cost_per_reservation !== null
                                    ? { color: 'var(--go)', fontWeight: 700 }
                                    : c.spend > 0
                                      ? { color: 'var(--late)', fontWeight: 700 }
                                      : { color: 'var(--mute)' }}
                                >
                                  {c.cost_per_reservation !== null ? num(c.cost_per_reservation, isAr) : '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {awarenessNoReturn && (
                      <div className="card-b" style={{
                        borderTop: '1px solid var(--line-soft)',
                        fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.85,
                      }}>
                        {isAr ? (
                          <>
                            <b>{awarenessNoReturn.name} أنفقت {num(Math.round(awarenessNoReturn.spend), true)} ريال بلا حجز واحد.</b>{' '}
                            غرضها الوعي لا الحجوزات — لكن بعد ثلاثة أسابيع يستحق ذلك سؤالًا.
                          </>
                        ) : (
                          <>
                            <b>{awarenessNoReturn.name} spent {num(Math.round(awarenessNoReturn.spend), false)} SAR without a single reservation.</b>{' '}
                            Its purpose is awareness, not reservations — but after three weeks that deserves a question.
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="grid main-rail-14">
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'حجم الإنتاج' : 'Production volume'}</h4>
                  <span className="r">{isAr ? 'آخر ٦ أشهر' : 'last 6 months'}</span>
                </div>
                <div className="card-b">
                  <div className="prodchart">
                    {data.production_by_month.map((m, i) => {
                      const color = i >= 5 ? 'var(--terracotta)' : i >= 3 ? 'var(--copper)' : 'var(--sand)';
                      const isLast = i === data.production_by_month.length - 1;
                      return (
                        <div
                          key={m.month}
                          className="prodchart-bar"
                          style={{
                            height: `${Math.max(4, Math.round((m.count / maxMonthly) * 100))}%`,
                            background: color,
                          }}
                        >
                          {isLast && (
                            <span className="prodchart-top" style={{ color: 'var(--terracotta)' }}>
                              {num(m.count, isAr)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="prodchart-labels">
                    {data.production_by_month.map((m) => (
                      <span key={m.month}>
                        {monthName(Number(m.month.slice(5, 7)) - 1, isAr)}
                      </span>
                    ))}
                  </div>
                  <div style={{
                    fontSize: 12, color: 'var(--ink-2)', marginTop: 12,
                    paddingTop: 11, borderTop: '1px solid var(--line-soft)', lineHeight: 1.85,
                  }}>
                    {isAr
                      ? 'الإنتاج عبر الأشهر الستة الماضية بنفس الفريق — وهذا المقياس الوحيد هنا الذي يقيس النظام نفسه لا السوق.'
                      : 'Production across the last six months with the same team — the only measure here of the system itself, not the market.'}
                  </div>
                </div>
              </div>

              <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--gold) 45%, transparent)' }}>
                <div className="card-h" style={{ background: 'color-mix(in srgb, var(--gold) 10%, transparent)' }}>
                  <h4>{isAr ? 'بانتظار توقيعك' : 'Awaiting your signature'}</h4>
                  <span className="pill p-wait" style={{ marginInlineStart: 'auto' }}>
                    {num(data.pending_signature.length, isAr)}
                  </span>
                </div>
                <div className="card-b">
                  {data.pending_signature.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.8 }}>
                      {isAr
                        ? 'لا ميزانيات تنتظر التوقيع. حين تتجاوز ميزانية حملة العتبة تظهر هنا.'
                        : 'No budgets await signature. When a campaign budget crosses the threshold it appears here.'}
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 11, color: 'var(--mute)', fontWeight: 700 }}>
                        {isAr
                          ? `ميزانية فوق ${num(Math.round(data.signature_threshold / 1000), true)} ألف ريال`
                          : `Budget above ${num(data.signature_threshold, false)} SAR`}
                      </div>
                      {data.pending_signature.map((c, idx) => {
                        const target = c.success_threshold;
                        const targetCost = c.budget_total && target && target > 0
                          ? Math.round(c.budget_total / target)
                          : null;
                        const metric = c.success_metric ? SUCCESS_METRIC_LABELS[c.success_metric] : null;
                        return (
                          <div
                            key={c.id}
                            style={idx > 0
                              ? { marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--line-soft)' }
                              : undefined}
                          >
                            <div style={{ fontSize: 14.5, fontWeight: 700, marginTop: 6 }}>{c.name}</div>
                            <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
                              <div>
                                <div className="lbl">{isAr ? 'الميزانية' : 'Budget'}</div>
                                <div style={{ fontFamily: 'var(--serif)', fontSize: 21 }}>
                                  {num(Math.round(c.budget_total ?? 0), isAr)}
                                </div>
                              </div>
                              <div>
                                <div className="lbl">{isAr ? 'الهدف' : 'Target'}</div>
                                <div style={{ fontFamily: 'var(--serif)', fontSize: 21 }}>
                                  {target !== null ? num(target, isAr) : '—'}
                                </div>
                                {metric && (
                                  <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>
                                    {isAr ? metric.ar : metric.en}
                                  </div>
                                )}
                              </div>
                              <div>
                                <div className="lbl">{isAr ? 'تكلفة مستهدفة' : 'Target cost'}</div>
                                <div style={{ fontFamily: 'var(--serif)', fontSize: 21 }}>
                                  {targetCost !== null ? num(targetCost, isAr) : '—'}
                                </div>
                              </div>
                            </div>
                            {c.goal && (
                              <div style={{ fontSize: 11.5, color: 'var(--ink-2)', marginTop: 12, lineHeight: 1.8 }}>
                                {c.goal}
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: 8, marginTop: 13 }}>
                              <button
                                type="button"
                                className="btn btn-go"
                                style={{ flex: 1, justifyContent: 'center' }}
                                disabled={signing !== null}
                                onClick={() => void sign(c.id)}
                              >
                                {isAr ? 'توقيع' : 'Sign'}
                              </button>
                              <button
                                type="button"
                                className="btn"
                                style={{ flex: 1, justifyContent: 'center' }}
                                onClick={() => navigate(`/m/campaigns/${c.id}`)}
                              >
                                {isAr ? 'أسئلة' : 'Questions'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 10, lineHeight: 1.75 }}>
                        {isAr
                          ? 'هذا هو الإجراء الوحيد للرئيس التنفيذي في المنظومة كلها. عتبة الخمسين ألفًا إعداد قابل للتغيير، لا رقم مثبّت.'
                          : 'This is the CEO’s only action in the whole system. The fifty-thousand threshold is a setting, not a fixed number.'}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
