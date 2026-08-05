/**
 * Performance — design screen 12, drawn in BOTH states.
 *
 * Manual state (the taken decision): a per-publication numbers table where a
 * skipped week shows «ناقص» in the alert colour and an empty cell says
 * «لم يُدخل» — NEVER a zero, because zero means "measured, and it was
 * nothing". The anti-stall rules card says out loud what keeps the weekly
 * entry from quietly dying.
 *
 * Connected state (per publication, when the snapshot history carries
 * api-source rows): dated snapshots, not running totals — the chart draws a
 * column per reading and leaves a skipped week as a VISIBLE gap, never an
 * interpolated line.
 *
 * «أين انتهى» is the one place marketing meets money: the linked campaign's
 * outcomes from the client system — clients, appointments, visits,
 * reservations and value — computed from the CRM, not from any platform.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosCampaignOutcomes, MosPublication, MosSnapshot, PLATFORM_LABELS,
  fetchCampaignOutcomes, fetchContentDetail, fetchMetricsHistory, recordMetrics,
} from '@/lib/marketingOS/client';
import { Empty, Field, Modal } from './kit';
import { dateTime, daysAgo, num, shortDate, toArabicDigits } from '../lib/format';

const DAY_MS = 86_400_000;

/** «٢١.٧ ألف» / «١.٠٤ م» — the mockup's compact figures. */
function compact(v: number | null | undefined, isAr: boolean): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const trim = (s: string): string => s.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  const abs = Math.abs(v);
  if (abs >= 1_000_000) {
    const s = trim((v / 1_000_000).toFixed(2));
    return isAr ? `${toArabicDigits(s)} م` : `${s}M`;
  }
  if (abs >= 10_000) {
    const s = trim((v / 1_000).toFixed(1));
    return isAr ? `${toArabicDigits(s)} ألف` : `${s}K`;
  }
  return num(v, isAr);
}

export default function PerformanceTab({
  publications, canEnter, isAr, campaignId,
}: {
  publications: MosPublication[];
  canEnter: boolean;
  isAr: boolean;
  /**
   * The linked campaign, for «أين انتهى». Optional for backward
   * compatibility: `undefined` = resolve from the content item (one extra
   * fetch); `null` = the item is known to have no campaign.
   */
  campaignId?: string | null;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const [entering, setEntering] = useState<MosPublication | null>(null);
  const [history, setHistory] = useState<{ pub: MosPublication; rows: MosSnapshot[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiHistories, setApiHistories] = useState<Record<string, MosSnapshot[]>>({});
  const [outcomes, setOutcomes] = useState<MosCampaignOutcomes | null>(null);
  const [outcomesState, setOutcomesState] = useState<'idle' | 'none' | 'error' | 'ready'>('idle');

  const rows = publications.filter((p) => p.status !== 'cancelled');
  const published = rows.filter((p) => p.status === 'published');
  const connectedPubs = published.filter((p) => p.latest_source === 'api');
  const firstContentId = publications[0]?.content_id ?? null;

  /* «أين انتهى» — the linked campaign's outcomes. Failures are logged AND
     surfaced as an inline line, never swallowed. */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let cid: string | null;
        if (campaignId !== undefined) {
          cid = campaignId;
        } else if (firstContentId) {
          const detail = await fetchContentDetail(firstContentId);
          cid = detail.item.campaign_id ?? null;
        } else {
          cid = null;
        }
        if (!alive) return;
        if (!cid) { setOutcomesState('none'); return; }
        const res = await fetchCampaignOutcomes(cid);
        if (!alive) return;
        setOutcomes(res.outcomes);
        setOutcomesState('ready');
      } catch (e) {
        console.error('[marketing] campaign outcomes unavailable', e);
        if (alive) setOutcomesState('error');
      }
    })();
    return () => { alive = false; };
  }, [campaignId, firstContentId]);

  /* Snapshot histories for the connected cards — only for api-source rows. */
  const apiKey = connectedPubs.map((p) => p.id).join(',');
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const p of connectedPubs) {
        try {
          const res = await fetchMetricsHistory(p.id);
          if (!alive) return;
          setApiHistories((h) => ({ ...h, [p.id]: res.snapshots }));
        } catch (e) {
          console.error('[marketing] snapshot history unavailable', e);
        }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const openHistory = async (pub: MosPublication): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetchMetricsHistory(pub.id);
      setHistory({ pub, rows: res.snapshots });
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (publications.length === 0) {
    return (
      <Empty
        title={isAr ? 'لا أرقام بعد' : 'No numbers yet'}
        body={isAr
          ? 'تظهر الأرقام بعد أن يُعلَّم صف النشر «منشور». حتى ذلك الحين لا يوجد ما يُقاس.'
          : 'Numbers appear once a publication row is marked published. Until then there is nothing to measure.'}
      />
    );
  }

  const platformLabel = (p: string): string =>
    (isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p;

  /* Header meta: «آخر إدخال قبل ٩ أيام». */
  const newestEntry = published
    .map((p) => p.latest_captured_at)
    .filter((t): t is string => !!t)
    .sort()
    .pop() ?? null;
  const missingPubs = published.filter((p) => !p.latest_captured_at);
  const stalePub = [...published]
    .filter((p) => p.latest_captured_at)
    .sort((a, b) => (a.latest_captured_at ?? '').localeCompare(b.latest_captured_at ?? ''))[0] ?? null;

  /** A metric cell: number, «لم يُدخل» for a null, «ناقص» for a missing week. */
  const metricCell = (v: number | null, state: 'ok' | 'missing' | 'unpublished') => {
    if (state === 'missing') {
      return <td className="num cd2-missing-cell">{isAr ? 'ناقص' : 'missing'}</td>;
    }
    if (state === 'unpublished') {
      return <td className="num" style={{ color: 'var(--mute)' }}>—</td>;
    }
    return v === null
      ? <td className="num" style={{ color: 'var(--mute)', fontSize: 11.5 }}>{isAr ? 'لم يُدخل' : 'not entered'}</td>
      : <td className="num">{num(v, isAr)}</td>;
  };

  return (
    <div style={{ display: 'grid', gap: 13 }}>
      {/* ── the manual weekly table — the taken decision ─────────────── */}
      <div className="card">
        <div className="card-h">
          <h4>{isAr ? 'أرقام هذا المنشور' : 'This item’s numbers'}</h4>
          <span className="tag tag-t">{isAr ? 'مُدخلة يدويًا' : 'entered by hand'}</span>
          <span className="r">
            {newestEntry
              ? isAr
                ? `آخر إدخال ${daysAgo(newestEntry, true) === 'اليوم' ? 'اليوم' : `قبل ${daysAgo(newestEntry, true)}`}`
                : `last entry ${daysAgo(newestEntry, false) === 'today' ? 'today' : `${daysAgo(newestEntry, false)} ago`}`
              : isAr ? 'لا إدخالات بعد' : 'no entries yet'}
          </span>
        </div>
        <div className="card-b" style={{ paddingTop: 6 }}>
          <div className="tbl-wrap">
            <table className="tbl" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>{isAr ? 'المنصة' : 'Platform'}</th>
                  <th className="num" style={{ width: 86 }}>{isAr ? 'المشاهدات' : 'Views'}</th>
                  <th className="num" style={{ width: 74 }}>{isAr ? 'التفاعل' : 'Engagement'}</th>
                  <th className="num" style={{ width: 68 }}>{isAr ? 'الإعجابات' : 'Likes'}</th>
                  <th className="num" style={{ width: 68 }}>{isAr ? 'التعليقات' : 'Comments'}</th>
                  <th className="num" style={{ width: 60 }}>{isAr ? 'الحفظ' : 'Saves'}</th>
                  <th className="num" style={{ width: 82 }}>{isAr ? 'الاستفسارات' : 'Enquiries'}</th>
                  <th style={{ width: 116 }}>{isAr ? 'آخر تحديث' : 'Last update'}</th>
                  <th style={{ width: 74 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const state: 'ok' | 'missing' | 'unpublished' = p.status !== 'published'
                    ? 'unpublished'
                    : p.latest_captured_at ? 'ok' : 'missing';
                  const stale = state === 'ok' && p.latest_captured_at
                    ? Date.now() - new Date(p.latest_captured_at).getTime() > 7 * DAY_MS
                    : false;
                  return (
                    <tr key={p.id} className={state === 'missing' ? 'cd2-missing-row' : undefined}>
                      <td><span className="tag">{platformLabel(p.platform)}</span></td>
                      {metricCell(p.latest_views, state)}
                      {metricCell(p.latest_engagement, state)}
                      {metricCell(p.latest_likes, state)}
                      {metricCell(p.latest_comments, state)}
                      {metricCell(p.latest_saves, state)}
                      {metricCell(p.latest_enquiries, state)}
                      <td
                        className={state === 'missing' ? 'cd2-missing-cell' : undefined}
                        style={state === 'ok'
                          ? { color: stale ? 'var(--late)' : 'var(--mute)', fontWeight: stale ? 700 : 400 }
                          : state === 'unpublished' ? { color: 'var(--mute)' } : undefined}
                      >
                        {state === 'unpublished'
                          ? isAr ? 'لم يُنشر بعد' : 'not published yet'
                          : state === 'missing'
                            ? isAr ? 'لم يُدخل' : 'never entered'
                            : shortDate(p.latest_captured_at, isAr)}
                      </td>
                      <td>
                        {p.snapshot_count > 0 && (
                          <button
                            type="button"
                            className="btn btn-d btn-sm"
                            disabled={busy}
                            onClick={() => void openHistory(p)}
                          >
                            {isAr ? 'السجل' : 'History'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {canEnter && missingPubs[0] && (
              <button type="button" className="btn btn-p btn-sm" onClick={() => setEntering(missingPubs[0] ?? null)}>
                {isAr
                  ? `أدخل أرقام ${platformLabel(missingPubs[0].platform)}`
                  : `Enter ${platformLabel(missingPubs[0].platform)} numbers`}
              </button>
            )}
            {canEnter && stalePub && (
              <button type="button" className="btn btn-sm" onClick={() => setEntering(stalePub)}>
                {isAr ? `حدّث ${platformLabel(stalePub.platform)}` : `Update ${platformLabel(stalePub.platform)}`}
              </button>
            )}
            {/* The deep link: one entry screen for EVERYTHING published and
                unentered — no hopping between records. */}
            {canEnter && (
              <button type="button" className="btn btn-sm" onClick={() => navigate('/m/numbers')}>
                {isAr ? 'أدخل الأرقام' : 'Enter the numbers'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── the anti-stall rules — verbatim, because stalling is the risk ── */}
      <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--copper) 34%, transparent)' }}>
        <div className="card-h" style={{ background: 'color-mix(in srgb, var(--copper) 7%, transparent)' }}>
          <h4>{isAr ? 'ما الذي يمنع هذا من التوقف' : 'What keeps this from stalling'}</h4>
        </div>
        <div
          className="card-b"
          style={{ fontSize: 12, lineHeight: 1.85, color: 'var(--ink-2)', display: 'grid', gap: 9 }}
        >
          <div className="rule">
            <span className="arw">←</span>
            <span>
              {isAr
                ? <>مهمة متكررة كل أحد في قائمة <b>مشرف العمليات</b> — لا تذكير في الذاكرة.</>
                : <>A recurring Sunday task in the <b>operations supervisor’s</b> queue — no reminder from memory.</>}
            </span>
          </div>
          <div className="rule">
            <span className="arw">←</span>
            <span>
              {isAr
                ? <>المهمة تفتح شاشة إدخال واحدة لكل ما نُشر ولم تُدخل أرقامه — لا تنقّل بين السجلات.</>
                : <>The task opens ONE entry screen for everything published and unentered — no hopping between records.</>}
            </span>
          </div>
          <div className="rule">
            <span className="arw">←</span>
            <span>
              {isAr
                ? <>الأرقام الناقصة تظهر <b>ناقص</b> بلون التنبيه، لا صفرًا. الصفر كذبة.</>
                : <>Missing numbers show <b>missing</b> in the alert colour, never a zero. Zero is a lie.</>}
            </span>
          </div>
          <div className="rule">
            <span className="arw">←</span>
            <span>
              {isAr
                ? <>تخطّي أسبوع يترك <b>فجوة ظاهرة</b> في الرسم البياني، لا خطًا ناعمًا يوحي بالاستمرار.</>
                : <>Skipping a week leaves a <b>visible gap</b> in the chart, not a smooth line implying continuity.</>}
            </span>
          </div>
          <div className="rule">
            <span className="arw">←</span>
            <span>
              {isAr
                ? <>تجاوز أسبوعين متتاليين يُنبّه <b>مدير التسويق</b>.</>
                : <>Two consecutive skipped weeks alert the <b>marketing manager</b>.</>}
            </span>
          </div>
        </div>
      </div>

      {/* ── the connected state — snapshots, not totals ──────────────── */}
      {connectedPubs.map((p) => {
        const snaps = (apiHistories[p.id] ?? []).filter((s) => s.views !== null);
        if (snaps.length === 0) return null;
        const first = snaps[0];
        const last = snaps[snaps.length - 1];
        const prev = snaps.length > 1 ? snaps[snaps.length - 2] : null;
        const maxViews = Math.max(...snaps.map((s) => s.views ?? 0), 1);
        const delta = prev && last && last.views !== null && prev.views !== null
          ? last.views - prev.views
          : null;
        // Honest slots: a >10-day jump between readings renders as an EMPTY
        // dashed slot — a gap, never an interpolation.
        const slots: Array<{ key: string; snap: MosSnapshot | null }> = [];
        snaps.forEach((s, i) => {
          if (i > 0) {
            const prevAt = new Date(snaps[i - 1]?.captured_at ?? s.captured_at).getTime();
            if (new Date(s.captured_at).getTime() - prevAt > 10 * DAY_MS) {
              slots.push({ key: `gap-${s.id}`, snap: null });
            }
          }
          slots.push({ key: s.id, snap: s });
        });
        return (
          <div key={p.id} className="card">
            <div className="card-h">
              <h4>{platformLabel(p.platform)}</h4>
              {p.account_handle && <span className="tag tag-t ltr">{p.account_handle}</span>}
              <span className="tag tag-t">{isAr ? 'من المنصة' : 'from the platform'}</span>
              <span className="r">
                {isAr
                  ? `${num(snaps.length, true)} لقطات · ${shortDate(first?.captured_at, true)} ← ${shortDate(last?.captured_at, true)}`
                  : `${snaps.length} snapshots · ${shortDate(first?.captured_at, false)} → ${shortDate(last?.captured_at, false)}`}
              </span>
            </div>
            <div className="card-b">
              <div className="cd2-kpi">
                <div>
                  <div className="lbl">{isAr ? 'المشاهدات' : 'Views'}</div>
                  <div className="cd2-kpi-v">{num(last?.views ?? null, isAr)}</div>
                  {delta !== null && delta > 0 && prev && (
                    <div className="cd2-kpi-d cd2-kpi-up">
                      {isAr
                        ? `+${num(delta, true)} منذ ${shortDate(prev.captured_at, true)}`
                        : `+${num(delta, false)} since ${shortDate(prev.captured_at, false)}`}
                    </div>
                  )}
                </div>
                <div>
                  <div className="lbl">{isAr ? 'التفاعل' : 'Engagement'}</div>
                  <div className="cd2-kpi-v">{num(last?.engagement ?? null, isAr)}</div>
                </div>
                <div>
                  <div className="lbl">{isAr ? 'الإعجابات' : 'Likes'}</div>
                  <div className="cd2-kpi-v">{num(last?.likes ?? null, isAr)}</div>
                </div>
                <div>
                  <div className="lbl">{isAr ? 'التعليقات' : 'Comments'}</div>
                  <div className="cd2-kpi-v">{num(last?.comments ?? null, isAr)}</div>
                </div>
                <div>
                  <div className="lbl">{isAr ? 'الحفظ' : 'Saves'}</div>
                  <div className="cd2-kpi-v">{num(last?.saves ?? null, isAr)}</div>
                </div>
                <div>
                  <div className="lbl">{isAr ? 'الاستفسارات' : 'Enquiries'}</div>
                  <div className="cd2-kpi-v">{num(last?.enquiries ?? null, isAr)}</div>
                  <div className="cd2-kpi-d">
                    {isAr ? `آخر قراءة ${shortDate(last?.captured_at, true)}` : `latest ${shortDate(last?.captured_at, false)}`}
                  </div>
                </div>
              </div>
              <div className="cd2-chart">
                <div className="lbl" style={{ marginBottom: 8 }}>
                  {isAr ? 'المشاهدات حسب اللقطة' : 'Views by snapshot'}
                </div>
                <div className="cd2-bars">
                  {slots.map((slot, i) => slot.snap === null ? (
                    <div
                      key={slot.key}
                      className="cd2-bar-gap"
                      title={isAr ? 'أسبوع بلا قراءة' : 'a week with no reading'}
                    />
                  ) : (
                    <div
                      key={slot.key}
                      className={`cd2-bar${i === slots.length - 1 ? ' cd2-last' : ''}`}
                      style={{ height: `${Math.max(6, ((slot.snap.views ?? 0) / maxViews) * 100)}%` }}
                    >
                      {i === slots.length - 1 && (
                        <span className="cd2-bar-v">{compact(slot.snap.views, isAr)}</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="cd2-bar-lbls">
                  {slots.map((slot) => (
                    <span key={`l-${slot.key}`}>
                      {slot.snap ? num(new Date(slot.snap.captured_at).getDate(), isAr) : '·'}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 11, lineHeight: 1.8 }}>
                {isAr
                  ? 'لأن كل قراءة مؤرَّخة، يمكن حساب أداء أول ٢٤ ساعة وأداء ٧ أيام، ومقارنة عنصرين عند نفس العمر بدل نفس اللحظة.'
                  : 'Because every reading is dated, first-24-hours and 7-day performance stay computable, and two items compare at the same AGE rather than the same moment.'}
              </div>
            </div>
          </div>
        );
      })}

      {/* ── «أين انتهى» — where marketing meets money ────────────────── */}
      {outcomesState === 'ready' && outcomes && (
        <div className="card">
          <div className="card-h">
            <h4>{isAr ? 'أين انتهى' : 'Where it ended up'}</h4>
            <span className="tag tag-t">{isAr ? 'تُحتسب آليًا' : 'derived'}</span>
            <span className="r">
              {isAr ? 'مرتبط بنظام العملاء، لا بالمنصات' : 'tied to the client system, not the platforms'}
            </span>
          </div>
          <div className="card-b">
            <div className="cd2-outcomes">
              <div>
                <div className="lbl">{isAr ? 'عملاء منسوبون' : 'Attributed clients'}</div>
                <div className="cd2-out-v">{num(outcomes.attributed_clients, isAr)}</div>
              </div>
              <div>
                <div className="lbl">{isAr ? 'مواعيد' : 'Appointments'}</div>
                <div className="cd2-out-v">{num(outcomes.appointments, isAr)}</div>
              </div>
              <div>
                <div className="lbl">{isAr ? 'زيارات' : 'Visits'}</div>
                <div className="cd2-out-v">{num(outcomes.visits, isAr)}</div>
              </div>
              <div>
                <div className="lbl">{isAr ? 'حجوزات' : 'Reservations'}</div>
                <div className="cd2-out-v">{num(outcomes.reservations, isAr)}</div>
              </div>
              <div>
                <div className="lbl">{isAr ? 'القيمة' : 'Value'}</div>
                <div className="cd2-out-v">{compact(outcomes.reservation_value, isAr)}</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 10 }}>
              {isAr
                ? `نافذة الإسناد ${num(outcomes.window_days, true)} يومًا · حُسبت ${shortDate(outcomes.computed_at, true)}`
                : `${outcomes.window_days}-day attribution window · computed ${shortDate(outcomes.computed_at, false)}`}
            </div>
          </div>
        </div>
      )}
      {outcomesState === 'error' && (
        <div style={{ fontSize: 12, color: 'var(--late)' }}>
          {isAr ? 'تعذّر تحميل نتائج الحملة المرتبطة.' : 'The linked campaign’s outcomes could not load.'}
        </div>
      )}

      {entering && (
        <MetricsModal
          publication={entering}
          isAr={isAr}
          onClose={() => setEntering(null)}
          onSaved={() => setEntering(null)}
        />
      )}

      {history && (
        <Modal
          title={isAr ? 'سجل القراءات' : 'Reading history'}
          sub={isAr
            ? 'كل قراءة مؤرخة ومحفوظة — لا شيء يُستبدل، ولهذا تبقى المقارنة بنفس العمر ممكنة.'
            : 'Every reading is dated and kept — nothing is overwritten, which is what keeps same-age comparison possible.'}
          onClose={() => setHistory(null)}
        >
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{isAr ? 'التاريخ' : 'Captured'}</th>
                  <th className="num">{isAr ? 'مشاهدات' : 'Views'}</th>
                  <th className="num">{isAr ? 'تفاعل' : 'Engagement'}</th>
                  <th className="num">{isAr ? 'إعجابات' : 'Likes'}</th>
                  <th className="num">{isAr ? 'تعليقات' : 'Comments'}</th>
                  <th className="num">{isAr ? 'حفظ' : 'Saves'}</th>
                  <th className="num">{isAr ? 'استفسارات' : 'Enquiries'}</th>
                  <th>{isAr ? 'المصدر' : 'Source'}</th>
                </tr>
              </thead>
              <tbody>
                {history.rows.map((s) => (
                  <tr key={s.id}>
                    <td>{dateTime(s.captured_at, isAr)}</td>
                    <td className="num">{num(s.views, isAr)}</td>
                    <td className="num">{num(s.engagement, isAr)}</td>
                    <td className="num">{num(s.likes, isAr)}</td>
                    <td className="num">{num(s.comments, isAr)}</td>
                    <td className="num">{num(s.saves, isAr)}</td>
                    <td className="num">{num(s.enquiries, isAr)}</td>
                    <td>
                      <span className="tag tag-t">
                        {s.source === 'manual' ? (isAr ? 'يدوي' : 'manual') : (isAr ? 'من المنصة' : 'from platform')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function MetricsModal({
  publication, isAr, onClose, onSaved,
}: {
  publication: MosPublication;
  isAr: boolean;
  onClose: () => void;
  onSaved: (snapshots: MosSnapshot[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [views, setViews] = useState('');
  const [engagement, setEngagement] = useState('');
  const [enquiries, setEnquiries] = useState('');
  const [likes, setLikes] = useState('');
  const [comments, setComments] = useState('');
  const [saves, setSaves] = useState('');
  const [busy, setBusy] = useState(false);

  // Empty means "not measured", which is NOT zero. Sending 0 for a blank box
  // would poison every average built on these readings.
  const parse = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await recordMetrics(publication.id, {
        views: parse(views),
        engagement: parse(engagement),
        enquiries: parse(enquiries),
        likes: parse(likes),
        comments: parse(comments),
        saves: parse(saves),
      });
      addToast(isAr ? 'سُجِّلت القراءة.' : 'Reading recorded.', 'success');
      onSaved(res.snapshots);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'إدخال أرقام' : 'Enter numbers'}
      sub={(isAr ? PLATFORM_LABELS[publication.platform]?.ar : PLATFORM_LABELS[publication.platform]?.en)
        ?? publication.platform}
      onClose={onClose}
      footer={
        <>
          <span className="note">
            {isAr
              ? 'اترك أي خانة فارغة إن لم تُقس — الفارغ ليس صفرًا.'
              : 'Leave a box empty if it was not measured — empty is not zero.'}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'تسجيل القراءة' : 'Record reading'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 13 }}>
        <Field label={isAr ? 'المشاهدات' : 'Views'}>
          <input className="inp" inputMode="numeric" value={views} onChange={(e) => setViews(e.target.value)} autoFocus />
        </Field>
        <Field label={isAr ? 'التفاعل' : 'Engagement'}>
          <input className="inp" inputMode="numeric" value={engagement} onChange={(e) => setEngagement(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الاستفسارات' : 'Enquiries'}>
          <input className="inp" inputMode="numeric" value={enquiries} onChange={(e) => setEnquiries(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الإعجابات' : 'Likes'}>
          <input className="inp" inputMode="numeric" value={likes} onChange={(e) => setLikes(e.target.value)} />
        </Field>
        <Field label={isAr ? 'التعليقات' : 'Comments'}>
          <input className="inp" inputMode="numeric" value={comments} onChange={(e) => setComments(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الحفظ' : 'Saves'}>
          <input className="inp" inputMode="numeric" value={saves} onChange={(e) => setSaves(e.target.value)} />
        </Field>
      </div>
      {publication.latest_captured_at && (
        <div style={{ fontSize: 12, color: 'var(--mute)' }}>
          {isAr ? 'آخر قراءة: ' : 'Last reading: '}
          {dateTime(publication.latest_captured_at, isAr)} ·{' '}
          {isAr ? 'مشاهدات ' : 'views '}{num(publication.latest_views, isAr)}
        </div>
      )}
    </Modal>
  );
}
