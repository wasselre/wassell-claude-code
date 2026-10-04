/**
 * Overview — design screen 01 (marketing manager).
 *
 * The manager's state: four numbers that answer «هل الآلة تعمل؟», then the two
 * lists that need a decision today — what has stopped moving, and what goes out
 * this week. The one job is spotting the bottleneck in under ten seconds.
 *
 * The CEO's state (s34) was removed with the CEO role on 2026-10-04.
 */
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosOverview,
  OverviewPeriod,
  PLATFORM_CLASS,
  PLATFORM_LABELS,
  ROLE_LABELS,
  fetchOverview,
  remindContent,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { ContentThumb, Empty, LoadError, PageHead, Pill, Skeleton, Stat, ThumbSigner } from './components/kit';
import { usePreview } from './components/ContentPreviewModal';
import NewContentModal from './components/NewContentModal';
import EmptyDayOne from './components/EmptyDayOne';
import DateControl from './components/DateControl';
import { TrendChart } from './components/analyticsCharts';
import { IconPlus } from './components/icons';
import { dayLabel, daysAgo, monthOf, num, pct, shortDate, toArabicDigits } from './lib/format';
import { DateSel, bucketDaily, granLabel, todayIso } from './lib/period';
import { contentHref } from './lib/contentRoute';
import './styles/analytics.css';

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

// The CEO view (screen 34) was removed with the CEO role on 2026-10-04.
export default function OverviewPage() {
  return <ManagerOverview />;
}

/* ------------------------------------------------------------------ */
/* screen 01 — the manager's state                                     */
/* ------------------------------------------------------------------ */

function ManagerOverview() {
  const { isAr, can, people } = useWorkspace();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const addToast = useAppStore((s) => s.addToast);
  const [sel, setSel] = useState<DateSel>({ period: 'week', anchorIso: todayIso() });
  const [data, setData] = useState<MosOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (s: DateSel) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchOverview(s.period as OverviewPeriod, s.anchorIso));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(sel); }, [load, sel]);

  // ONE preview popup: a stalled item is chased by LOOKING at it, not by
  // reading its title.
  const preview = usePreview(() => { void load(sel); });

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
  /**
   * «تحت الإنتاج الآن» counts work that EXISTS, and the label says «الآن» for
   * exactly that reason. This is the number that makes «الآن» mean something: a
   * committed month also promises ad creatives that no refresh cycle has begun
   * producing — 60 of them on 2026-09-20, for a month of 150 items whose stat
   * read 90.
   */
  const productionDetail = (): string => {
    const base = isAr
      ? `${num(postCount, true)} منشور · ${num(videoCount, true)} فيديو`
      : `${postCount} posts · ${videoCount} video`;
    const coming = data?.counts.not_yet_created ?? 0;
    if (coming <= 0) return base;
    return isAr
      ? `${base} · ${num(coming, true)} لم تُنشأ بعد`
      : `${base} · ${coming} not created yet`;
  };

  // The TOTALS, not the lengths of the two capped display lists — `week`
  // shows at most 60 placements and `unscheduled` at most 20, so counting the
  // arrays reported a page size as the period's size.
  //
  // The array length is the FALLBACK, not zero: a bundle that outlives the
  // handler that feeds it should degrade to the old (short) number rather than
  // confidently claim nothing is publishing.
  const scheduledCount = data?.week_total ?? data?.week.length ?? 0;
  const unscheduledCount = data?.unscheduled_total ?? data?.unscheduled.length ?? 0;
  const publishingTotal = scheduledCount + unscheduledCount;

  // «٣ أشخاص في الإنتاج» — people holding a production role.
  const productionPeople = people.filter((p) =>
    p.roles.some((r) => r === 'writer' || r === 'montage')).length;

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
  //
  // `campaigns_any` is deliberately NOT `campaigns.length`: that list is
  // period-scoped now, so an established workspace with no open work, viewing a
  // period that happens to hold no campaign, would be shown the first-run
  // checklist. Falls back to the list only for a payload without the field.
  const anyCampaign = data?.campaigns_any ?? ((data?.campaigns ?? []).length > 0);
  if (data && inProduction === 0 && (data.mix ?? []).length === 0 && !anyCampaign) {
    return <EmptyDayOne />;
  }

  return (
    /* One signing round-trip for every preview on the overview. */
    <ThumbSigner rows={data?.stalled ?? []}>
      <PageHead
        title={isAr ? 'نظرة عامة' : 'Overview'}
        sub={data ? periodSub(data) : undefined}
      >
        <DateControl sel={sel} periods={['week', 'month', 'quarter']} isAr={isAr} onChange={setSel} showCustom={false} />
        {can('write_content') && !isMobile && (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            <IconPlus />
            {isAr ? 'محتوى جديد' : 'New content'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load(sel)} isAr={isAr} />}
        {loading && !data && <Skeleton rows={6} />}

        {/* s52 phone2 — «اللوحة تُكدَّس ولا تُختصر»: the same four numbers in
            the same order as a 2×2 card grid, then the stalled list, then what
            publishes, then the paid card. Nothing dropped, nothing squeezed. */}
        {data && isMobile && (
          <>
            <div className="m1-stats">
              <div className="m1-stat">
                <div className="lbl">{isAr ? 'تحت الإنتاج الآن' : 'In production now'}</div>
                <div className="v">{num(inProduction, isAr)}</div>
                <div className="d">{productionDetail()}</div>
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
                onClick={() => preview.open(r.id)}
              >
                <div className="m1-row">
                  <span className="m1-id ltr">{r.ref ?? '—'}</span>
                  <span className="pill p-late">{daysAgo(r.updated_at, isAr)}</span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
                  <ContentThumb row={r} size="md" />
                  <div className="t2" style={{ minWidth: 0 }}>{r.title}</div>
                </div>
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
            <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
              <OverviewPaidExtras data={data} isAr={isAr} />
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
                label={isAr ? 'تحت الإنتاج الآن' : 'In production now'}
                value={inProduction}
                detail={productionDetail()}
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
                          <th style={{ width: 52 }}>{isAr ? 'المعاينة' : 'Preview'}</th>
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
                              onClick={() => navigate(contentHref(r))}
                            >
                              <td
                                style={{ width: 52 }}
                                title={isAr ? 'معاينة' : 'Preview'}
                                onClick={(e) => { e.stopPropagation(); preview.open(r.id); }}
                              >
                                <ContentThumb row={r} size="sm" />
                              </td>
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

                <OverviewPaidExtras data={data} isAr={isAr} />

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

      {creating && <NewContentModal onClose={() => setCreating(false)} onCreatedMany={() => void load(sel)} />}

      {preview.node}
    </ThumbSigner>
  );
}

/* ------------------------------------------------------------------ */
/* shared pieces — one implementation for desktop and the s52 phone    */
/* ------------------------------------------------------------------ */

/** The «يُنشر هذا الأسبوع» rows — scheduled .ev chips + the needs-a-slot row. */
function WeekList({ data, isAr }: { data: MosOverview; isAr: boolean }) {
  const navigate = useNavigate();
  // The same totals the stat above uses — two numbers on one screen that
  // disagree are worse than one number that is merely capped.
  const publishingTotal = (data.week_total ?? data.week.length)
    + (data.unscheduled_total ?? data.unscheduled.length);
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
          // A scheduled publication is a PUBLISHING fact, so the link lands
          // on the item's placements — one resolver decides that everywhere.
          onClick={() => navigate(contentHref({ id: p.content_id }, null, { section: 'schedule' }))}
        >
          <span>
            {dayLabel(p.due_at ?? p.scheduled_at, isAr)} ·{' '}
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
          {/* Both lists are capped for display. A short list must never read as
              a complete one — CLAUDE.md's "never cap results silently". */}
          {(data.unscheduled_total ?? 0) > data.unscheduled.length && (
            <span style={{ color: 'var(--mute)' }}>
              {isAr
                ? ` + ${num((data.unscheduled_total ?? 0) - data.unscheduled.length, true)} أخرى`
                : ` + ${(data.unscheduled_total ?? 0) - data.unscheduled.length} more`}
            </span>
          )}
        </div>
      )}
      {((data.week_total ?? 0) > data.week.length || data.week_truncated) && (
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 6 }}>
          {isAr
            ? `تُعرض ${num(data.week.length, true)} من ${num(data.week_total ?? 0, true)} عملية نشر`
            : `showing ${data.week.length} of ${data.week_total ?? 0} placements`}
        </div>
      )}
    </>
  );
}

/** The «الإعلانات المدفوعة» paid-ads card — same DOM on both layouts. Numbers
 *  may be Meta-synced or hand-entered, so it no longer claims a single source. */
function PaidAdsCard({ data, isAr }: { data: MosOverview; isAr: boolean }) {
  // Spend/leads/qualified are PERIOD-SCOPED (data.paid), summed from the dated
  // daily data for the selected period — including when that is zero, which is
  // the honest answer for a month that has not spent yet. `scoped` says whether
  // the period had dated rows; lifetime is shown separately, never instead.
  const paid = data.paid ?? {
    spend: 0, leads: 0, qualified: 0, scoped: false, lifetime_spend: 0, lifetime_leads: 0,
  };
  // The campaigns list is now scoped to the period, so this budget is the
  // period's too. It used to sum every open campaign, which is how a month
  // that had spent nothing reported 6,891 of 16,001.
  const budget = (data.campaigns ?? []).reduce((a, c) => a + (c.budget_total ?? 0), 0);
  const lifetime = paid.lifetime_spend ?? 0;
  // `data.campaigns` is period-scoped, so campaigns with no start date are not
  // in it. They are counted rather than dropped in silence.
  const undated = data.campaigns_undated ?? 0;
  const spent = paid.spend;
  const leads = paid.leads;
  const qualified = paid.qualified;
  const cpl = leads > 0 ? spent / leads : null;
  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'الإعلانات المدفوعة' : 'Paid ads'}</h4>
        {/* Always the period. The header no longer flips to "to date" and
            quietly change what the big number means. */}
        <span className="r" style={{ marginInlineStart: 'auto', color: 'var(--mute)', fontSize: 11 }}>
          {isAr ? 'ضمن الفترة' : 'in period'}
        </span>
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
          {lifetime > spent && (
            /* Lifetime BESIDE the period, never instead of it. */
            <div className="lbl" style={{ marginTop: 6, color: 'var(--mute)' }}>
              {isAr
                ? `إجمالي الإنفاق حتى الآن على كل الحملات: ${num(Math.round(lifetime), true)} ر.س`
                : `All campaigns, to date: ${num(Math.round(lifetime), false)} SAR`}
            </div>
          )}
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
        {/* Excluded, not hidden: a campaign with no start date cannot be placed
            in a period, so it contributes nothing above — and saying so is the
            difference between a scoped figure and a wrong one. */}
        {undated > 0 && (
          <div style={{ fontSize: 11, color: 'var(--mute)' }}>
            {isAr
              ? `${num(undated, true)} حملة نشطة بلا تاريخ بدء — غير محسوبة هنا`
              : `${undated} active campaign${undated === 1 ? '' : 's'} with no start date — not counted here`}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Overview's paid deep-cut: a spend-over-period trend chart + a campaigns
 * table (spend / CTR / CPL), both from the period-scoped `data.paid`. Same
 * shape as the التحليلات page's building blocks, so the two never drift.
 */
function OverviewPaidExtras({ data, isAr }: { data: MosOverview; isAr: boolean }) {
  const daily = data.paid?.daily ?? [];
  const camps = (data.paid?.by_campaign ?? []).filter((c) => c.spend > 0 || c.impressions > 0);
  const bk = daily.length > 0 ? bucketDaily(daily, data.week_start, data.week_end, isAr) : null;
  return (
    <>
      <div className="card">
        <div className="card-h">
          <h4>{isAr ? 'الإنفاق عبر الفترة' : 'Spend over the period'}</h4>
          {bk && <span className="an-gran">{granLabel(bk.mode, isAr)}</span>}
        </div>
        <div className="card-b">
          {bk ? (
            <TrendChart
              points={bk.items.map((b) => ({ label: b.label, value: b.spend }))}
              color="var(--copper)"
              fmt={(v) => num(Math.round(v), isAr)}
            />
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.8, padding: '4px 2px' }}>
              {isAr
                ? 'لا أرقام يومية بعد — تظهر السلسلة الزمنية فور إدخال الأرقام اليومية للحملات.'
                : 'No daily figures yet — the time series appears once daily campaign figures are entered.'}
            </div>
          )}
        </div>
      </div>

      {camps.length > 0 && (
        <div className="card">
          <div className="card-h">
            <h4>{isAr ? 'الحملات' : 'Campaigns'}</h4>
            <span className="r">{isAr ? 'الأعلى إنفاقًا' : 'top spend'}</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? 'الحملة' : 'Campaign'}</th>
                  <th className="num">{isAr ? 'أُنفق' : 'Spent'}</th>
                  <th className="num">CTR</th>
                  <th className="num">CPL</th>
                </tr>
              </thead>
              <tbody>
                {camps.map((c) => {
                  const ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0;
                  const cpl = c.leads > 0 ? c.spend / c.leads : null;
                  return (
                    <tr key={c.id}>
                      <td className="ttl">{c.name}</td>
                      <td className="num">{num(Math.round(c.spend), isAr)}</td>
                      <td className="num">{ctr > 0 ? pct(Number(ctr.toFixed(2)), isAr, 2) : '—'}</td>
                      <td className="num">{cpl !== null ? num(Math.round(cpl), isAr) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
