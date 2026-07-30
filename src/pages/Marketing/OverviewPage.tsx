/**
 * Overview — design screens 01 and 34.
 *
 * Four numbers that answer "is the machine running?", then the two lists that
 * need a decision today: what has stopped moving, and what goes out this week.
 * Not a wall of charts — the one job is spotting the bottleneck in under ten
 * seconds.
 *
 * Screen 34 is the same screen for a CEO: no queue of their own, so the
 * "waiting on you" card becomes budget, and the stalled list stays.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MosOverview,
  PLATFORM_CLASS,
  PLATFORM_LABELS,
  ROLE_LABELS,
  fetchOverview,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, PageHead, Pill, Skeleton, Stat } from './components/kit';
import NewContentModal from './components/NewContentModal';
import { IconPlus } from './components/icons';
import { daysAgo, money, num, shortDate } from './lib/format';

export default function OverviewPage() {
  const { isAr, role, can } = useWorkspace();
  const navigate = useNavigate();
  const [data, setData] = useState<MosOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchOverview());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const isCeo = role === 'ceo';
  const budget = (data?.campaigns ?? []).reduce((a, c) => a + (c.budget_total ?? 0), 0);
  const spent = (data?.campaigns ?? []).reduce((a, c) => a + (c.total_spend ?? 0), 0);
  const leads = (data?.campaigns ?? []).reduce((a, c) => a + (c.total_leads ?? 0), 0);
  const qualified = (data?.campaigns ?? []).reduce((a, c) => a + (c.total_qualified ?? 0), 0);
  const cpl = leads > 0 ? spent / leads : null;

  const videoCount = (data?.mix ?? []).filter((m) => m.content_type_key === 'video').length;
  const postCount = (data?.mix ?? []).length - videoCount;

  return (
    <>
      <PageHead
        title={isAr ? 'نظرة عامة' : 'Overview'}
        sub={
          data
            ? isAr
              ? `أسبوع ${shortDate(data.week_start, true)} — ${shortDate(data.week_end, true)}`
              : `Week of ${shortDate(data.week_start, false)}`
            : undefined
        }
      >
        <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
        {can('write_content') && (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            <IconPlus />
            {isAr ? 'محتوى جديد' : 'New content'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && !data && <Skeleton rows={6} />}

        {data && (
          <>
            <div className="grid g4" style={{ marginBottom: 18 }}>
              <Stat
                isAr={isAr}
                label={isAr ? 'تحت الإنتاج' : 'In production'}
                value={data.counts.in_production}
                detail={isAr
                  ? `${num(postCount, true)} منشور · ${num(videoCount, true)} فيديو`
                  : `${postCount} posts · ${videoCount} video`}
                meter={[{ pct: 100, color: 'var(--copper)' }]}
              />
              {isCeo ? (
                <Stat
                  isAr={isAr}
                  label={isAr ? 'الميزانية المعتمدة' : 'Approved budget'}
                  value={Math.round(budget)}
                  detail={isAr ? `${money(spent, true)} مصروفة` : `${money(spent, false)} spent`}
                  meter={[{ pct: budget > 0 ? (spent / budget) * 100 : 0, color: 'var(--copper)' }]}
                />
              ) : (
                <Stat
                  isAr={isAr}
                  label={isAr ? 'بانتظارك أنت' : 'Waiting on you'}
                  value={data.counts.waiting_on_me}
                  detail={
                    ROLE_LABELS[data.role]
                      ? isAr
                        ? `دورك: ${ROLE_LABELS[data.role].ar}`
                        : `as ${ROLE_LABELS[data.role].en}`
                      : undefined
                  }
                  meter={[{ pct: 70, color: 'var(--wait)' }]}
                />
              )}
              <Stat
                isAr={isAr}
                label={isAr ? 'يُنشر هذا الأسبوع' : 'Publishing this week'}
                value={data.counts.publishing_this_week}
                detail={isAr ? 'مجدولة على المنصات' : 'scheduled across platforms'}
                meter={[{ pct: 75, color: 'var(--go)' }, { pct: 25, color: 'var(--sand)' }]}
              />
              <Stat
                isAr={isAr}
                alert={data.counts.late > 0}
                label={isAr ? 'متأخر' : 'Late'}
                value={data.counts.late}
                detail={isAr ? 'تجاوز موعد المهمة المفتوحة' : 'past the open task’s due date'}
                meter={[{ pct: 100, color: 'var(--late)' }]}
              />
            </div>

            <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.55fr) minmax(0,1fr)' }}>
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'متوقف — لم يتحرك مؤخرًا' : 'Stalled — nothing has moved'}</h4>
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
                    <span className="r">{num(data.week.length, isAr)}</span>
                  </div>
                  <div className="card-b" style={{ padding: '10px 14px 14px' }}>
                    {data.week.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: 'var(--mute)' }}>
                        {isAr
                          ? 'لا شيء مجدول لهذا الأسبوع بعد.'
                          : 'Nothing is scheduled for this week yet.'}
                      </div>
                    ) : (
                      data.week.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`ev ${PLATFORM_CLASS[p.platform] ?? ''}`}
                          onClick={() => navigate(`/m/content/${p.content_id}`)}
                        >
                          <span>
                            {shortDate(p.scheduled_at, isAr)} ·{' '}
                            {(isAr ? PLATFORM_LABELS[p.platform]?.ar : PLATFORM_LABELS[p.platform]?.en) ?? p.platform}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>

                <div className="card">
                  <div className="card-h">
                    <h4>{isAr ? 'الإعلانات المدفوعة' : 'Paid ads'}</h4>
                    <span className="tag tag-t">{isAr ? 'مُدخلة يدويًا' : 'entered by hand'}</span>
                  </div>
                  <div className="card-b" style={{ display: 'grid', gap: 11 }}>
                    <div>
                      <div className="lbl">{isAr ? 'المصروف من الميزانية' : 'Spent of budget'}</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginTop: 4 }}>
                        <span style={{ fontFamily: 'var(--serif)', fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>
                          {num(Math.round(spent), isAr)}
                        </span>
                        <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                          {isAr ? `من ${num(Math.round(budget), true)} ر.س` : `of ${num(Math.round(budget), false)} SAR`}
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
                    {data.campaigns.length > 0 && (
                      <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
                        {data.campaigns.slice(0, 4).map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className="btn btn-d btn-sm"
                            style={{ display: 'flex', width: '100%', justifyContent: 'flex-start' }}
                            onClick={() => navigate(`/m/campaigns/${c.id}`)}
                          >
                            <span className="ltr" style={{ color: 'var(--mute)' }}>{c.ref}</span>
                            <span style={{ color: 'var(--ink)' }}>{c.name}</span>
                            <span style={{ marginInlineStart: 'auto', color: 'var(--mute)' }}>
                              {money(c.total_spend, isAr)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

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

      {creating && <NewContentModal onClose={() => setCreating(false)} />}
    </>
  );
}
