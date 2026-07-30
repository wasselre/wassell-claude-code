/**
 * Performance — design screen 12.
 *
 * Readings are APPEND-ONLY and dated. Nothing overwrites a number, so
 * first-24-hours and 7-day performance stay computable and two items can be
 * compared at the same AGE rather than at the same wall-clock date.
 *
 * A blank field saves as NULL, never 0 — the database refuses an all-empty
 * reading, because zero would mean "measured, and it was nothing".
 */
import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  MosPublication, MosSnapshot, PLATFORM_LABELS, fetchMetricsHistory, recordMetrics,
} from '@/lib/marketingOS/client';
import { Empty, Field, Modal } from './kit';
import { dateTime, num, shortDate } from '../lib/format';

export default function PerformanceTab({
  publications, canEnter, isAr,
}: {
  publications: MosPublication[];
  canEnter: boolean;
  isAr: boolean;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [entering, setEntering] = useState<MosPublication | null>(null);
  const [history, setHistory] = useState<{ pub: MosPublication; rows: MosSnapshot[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const published = publications.filter((p) => p.status === 'published');

  const totals = published.reduce(
    (a, p) => ({
      views: a.views + (p.latest_views ?? 0),
      engagement: a.engagement + (p.latest_engagement ?? 0),
      enquiries: a.enquiries + (p.latest_enquiries ?? 0),
    }),
    { views: 0, engagement: 0, enquiries: 0 },
  );

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

  if (published.length === 0) {
    return (
      <Empty
        title={isAr ? 'لا أرقام بعد' : 'No numbers yet'}
        body={isAr
          ? 'تظهر الأرقام بعد أن يُعلَّم صف النشر «منشور». حتى ذلك الحين لا يوجد ما يُقاس.'
          : 'Numbers appear once a publication row is marked published. Until then there is nothing to measure.'}
      />
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="grid g3">
        <div className="stat">
          <div className="k">{isAr ? 'المشاهدات' : 'Views'}</div>
          <div className="v">{num(totals.views, isAr)}</div>
          <div className="d">{isAr ? 'آخر قراءة لكل منصة' : 'latest reading per platform'}</div>
        </div>
        <div className="stat">
          <div className="k">{isAr ? 'التفاعل' : 'Engagement'}</div>
          <div className="v">{num(totals.engagement, isAr)}</div>
          <div className="d">
            {totals.views > 0
              ? isAr
                ? `${num(Math.round((totals.engagement / totals.views) * 1000) / 10, true)}٪ من المشاهدات`
                : `${Math.round((totals.engagement / totals.views) * 1000) / 10}% of views`
              : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="k">{isAr ? 'الاستفسارات' : 'Enquiries'}</div>
          <div className="v">{num(totals.enquiries, isAr)}</div>
          <div className="d">{isAr ? 'مُدخلة يدويًا' : 'entered by hand'}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h4>{isAr ? 'لكل منصة' : 'By platform'}</h4>
          <span className="tag tag-t">{isAr ? 'قراءات مؤرخة' : 'dated readings'}</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 130 }}>{isAr ? 'المنصة' : 'Platform'}</th>
                <th style={{ width: 150 }}>{isAr ? 'نُشر' : 'Published'}</th>
                <th className="num">{isAr ? 'مشاهدات' : 'Views'}</th>
                <th className="num">{isAr ? 'تفاعل' : 'Engagement'}</th>
                <th className="num">{isAr ? 'استفسارات' : 'Enquiries'}</th>
                <th style={{ width: 140 }}>{isAr ? 'آخر قراءة' : 'Last read'}</th>
                <th style={{ width: 170 }} />
              </tr>
            </thead>
            <tbody>
              {published.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="tag">
                      {(isAr ? PLATFORM_LABELS[p.platform]?.ar : PLATFORM_LABELS[p.platform]?.en) ?? p.platform}
                    </span>
                  </td>
                  <td style={{ color: 'var(--mute)' }}>{shortDate(p.published_at, isAr)}</td>
                  <td className="num">{num(p.latest_views, isAr)}</td>
                  <td className="num">{num(p.latest_engagement, isAr)}</td>
                  <td className="num">{num(p.latest_enquiries, isAr)}</td>
                  <td style={{ color: 'var(--mute)', fontSize: 11.5 }}>
                    {p.latest_captured_at
                      ? `${shortDate(p.latest_captured_at, isAr)} · ${num(p.snapshot_count, isAr)}`
                      : isAr ? 'لا قراءة' : 'never'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn-d btn-sm"
                        disabled={busy || p.snapshot_count === 0}
                        onClick={() => void openHistory(p)}
                      >
                        {isAr ? 'السجل' : 'History'}
                      </button>
                      {canEnter && (
                        <button type="button" className="btn btn-sm" onClick={() => setEntering(p)}>
                          {isAr ? 'إدخال أرقام' : 'Enter numbers'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

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
