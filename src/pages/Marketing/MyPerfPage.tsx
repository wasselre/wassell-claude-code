/**
 * /m/me — the personal performance profile (surface: myperf).
 *
 * One screen per person (spec: docs/marketing-task-load-plan.md):
 *   • XP total + recent ledger + progress toward the next reward (+ claim)
 *   • today's queue: open tasks with SLA due dates, late/blocked flags
 *   • this month's late counter + every warning/deduction (with dispute box)
 *   • leave requests (+ new request)
 *   • this month's KPI bonus goals the person is a recipient of
 *
 * Discipline consequences may be in OBSERVE mode (settings.discipline_observe)
 * — then everything shows as «مراقبة فقط» and nothing punitive is real yet.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  PerfMe, PerfRatingLevel, RATING_LABELS, claimPerfReward, disputePerfDiscipline,
  fetchPerfMe, requestPerfLeave,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Skeleton } from './components/kit';
import { num } from './lib/format';

const fmtDate = (iso: string | null | undefined, isAr: boolean): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(isAr ? 'ar-SA' : 'en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

export default function MyPerfPage() {
  const { isAr } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);

  const [me, setMe] = useState<PerfMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [disputeId, setDisputeId] = useState<string | null>(null);
  const [disputeNote, setDisputeNote] = useState('');
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [lStart, setLStart] = useState('');
  const [lEnd, setLEnd] = useState('');
  const [lKind, setLKind] = useState<'annual' | 'sick' | 'other'>('annual');
  const [lNote, setLNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMe(await fetchPerfMe());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const claim = async (rewardId: string): Promise<void> => {
    setBusy(true);
    try {
      await claimPerfReward(rewardId);
      addToast(isAr ? 'أُرسل طلب المكافأة للاعتماد.' : 'Reward claim sent for approval.', 'success');
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const dispute = async (): Promise<void> => {
    if (!disputeId || !disputeNote.trim()) return;
    setBusy(true);
    try {
      await disputePerfDiscipline(disputeId, disputeNote.trim());
      addToast(isAr ? 'سُجّل اعتراضك.' : 'Your dispute was recorded.', 'success');
      setDisputeId(null);
      setDisputeNote('');
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const requestLeave = async (): Promise<void> => {
    if (!lStart || !lEnd) {
      addToast(isAr ? 'حدد بداية الإجازة ونهايتها.' : 'Pick the leave start and end.', 'error');
      return;
    }
    setBusy(true);
    try {
      await requestPerfLeave({
        start_at: new Date(lStart).toISOString(),
        end_at: new Date(lEnd).toISOString(),
        kind: lKind, note: lNote.trim() || undefined,
      });
      addToast(isAr ? 'أُرسل طلب الإجازة.' : 'Leave request sent.', 'success');
      setLeaveOpen(false);
      setLStart(''); setLEnd(''); setLNote('');
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const observe = me?.settings?.discipline_observe !== false;
  const nextReward = me?.rewards.find((r) => r.active) ?? null;
  const progress = nextReward && me ? Math.min(100, Math.round((me.xp_total / nextReward.cost_xp) * 100)) : 0;

  const levelLabel = (note: string | null): string => {
    const lv = note as PerfRatingLevel | null;
    if (lv && RATING_LABELS[lv]) return isAr ? RATING_LABELS[lv].ar : RATING_LABELS[lv].en;
    return note ?? '';
  };

  return (
    <>
      <PageHead
        title={isAr ? 'ملفي' : 'My profile'}
        sub={isAr
          ? 'نقاطك، ومهامك المفتوحة، وعدّاد التأخير هذا الشهر، وأهداف المكافآت.'
          : 'Your points, open tasks, this month\'s late counter and bonus goals.'}
      >
        <button type="button" className="btn" onClick={() => setLeaveOpen(true)}>
          {isAr ? 'طلب إجازة' : 'Request leave'}
        </button>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={6} />}

        {!loading && me && (
          <>
            {/* ── hero: XP + late counter ─────────────────────────────── */}
            <div className="grid g4" style={{ marginBottom: 18 }}>
              <div className="card"><div className="card-b">
                <div style={{ fontSize: 11, color: 'var(--mute)' }}>{isAr ? 'النقاط (XP)' : 'Points (XP)'}</div>
                <div style={{ fontSize: 26, fontWeight: 800 }}>{num(me.xp_total, isAr)}</div>
              </div></div>
              <div className="card"><div className="card-b">
                <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                  {isAr ? `تأخيرات ${me.month}` : `Late in ${me.month}`}
                </div>
                <div style={{ fontSize: 26, fontWeight: 800, color: me.late_this_month >= 3 ? 'var(--bad, #b3261e)' : undefined }}>
                  {num(me.late_this_month, isAr)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                  {me.late_this_month < 3
                    ? (isAr ? `التالي = إنذار ${num(me.late_this_month + 1, isAr)}` : `next = warning #${me.late_this_month + 1}`)
                    : (isAr ? 'التالي = خصم يوم' : 'next = a day\'s deduction')}
                </div>
              </div></div>
              <div className="card"><div className="card-b">
                <div style={{ fontSize: 11, color: 'var(--mute)' }}>{isAr ? 'مهام مفتوحة' : 'Open tasks'}</div>
                <div style={{ fontSize: 26, fontWeight: 800 }}>{num(me.open_tasks.length, isAr)}</div>
              </div></div>
              <div className="card"><div className="card-b">
                <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                  {nextReward ? (isAr ? nextReward.label_ar : nextReward.label_en) : (isAr ? 'مكافأة' : 'Reward')}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, margin: '4px 0' }}>
                  {nextReward ? `${num(me.xp_total, isAr)} / ${num(nextReward.cost_xp, isAr)}` : '—'}
                </div>
                <div style={{ height: 6, borderRadius: 4, background: 'var(--line, #eee)', overflow: 'hidden' }}>
                  <div style={{ width: `${progress}%`, height: '100%', background: 'var(--brand, #B8734F)' }} />
                </div>
                {nextReward && me.xp_total >= nextReward.cost_xp && (
                  <button type="button" className="btn btn-p btn-sm" style={{ marginTop: 8 }}
                    disabled={busy} onClick={() => void claim(nextReward.id)}>
                    {isAr ? 'المطالبة بالمكافأة' : 'Claim the reward'}
                  </button>
                )}
              </div></div>
            </div>

            {observe && (
              <div className="notice" style={{ marginBottom: 16 }}>
                {isAr
                  ? 'نظام الانضباط في وضع المراقبة — الأرقام تُسجَّل لكن لا إنذارات معتمدة ولا خصومات حتى يُفعَّل.'
                  : 'Discipline is in observe mode — numbers are recorded, but no warnings or deductions are real until it is switched on.'}
              </div>
            )}

            {/* ── open tasks ──────────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-h"><h4>{isAr ? 'مهامي المفتوحة' : 'My open tasks'}</h4></div>
              {me.open_tasks.length === 0
                ? <div className="card-b"><Empty title={isAr ? 'لا مهام مفتوحة' : 'No open tasks'} /></div>
                : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>{isAr ? 'الخطوة' : 'Step'}</th>
                          <th style={{ width: 90 }}>{isAr ? 'النوع' : 'Bucket'}</th>
                          <th style={{ width: 160 }}>{isAr ? 'الموعد' : 'Due'}</th>
                          <th style={{ width: 110 }}>{isAr ? 'الحالة' : 'State'}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {me.open_tasks.map((t) => (
                          <tr key={t.id}>
                            <td className="ttl">
                              <Link to={`/m/content/${t.subject_id}?tab=tasks`}>{t.step_key}</Link>
                            </td>
                            <td style={{ fontSize: 12 }}>
                              {t.bucket === 'video' ? (isAr ? 'فيديو' : 'Video') : (isAr ? 'منشور' : 'Post')}
                            </td>
                            <td style={{ fontSize: 12 }}>{fmtDate(t.due_at, isAr)}</td>
                            <td>
                              {t.blocked && <span className="tag">{isAr ? 'معلّقة' : 'Blocked'}</span>}
                              {t.late_flag && !t.blocked && (
                                <span className="tag" style={{ color: 'var(--bad, #b3261e)' }}>
                                  {isAr ? 'متأخرة' : 'Late'}
                                </span>
                              )}
                              {!t.blocked && !t.late_flag && <span className="tag">{isAr ? 'في الوقت' : 'On track'}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>

            {/* ── discipline ──────────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-h"><h4>{isAr ? 'الإنذارات والخصومات' : 'Warnings & deductions'}</h4></div>
              {me.discipline.length === 0
                ? <div className="card-b"><Empty title={isAr ? 'سجلّك نظيف' : 'A clean record'} /></div>
                : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th style={{ width: 90 }}>{isAr ? 'الشهر' : 'Month'}</th>
                          <th>{isAr ? 'النوع' : 'Kind'}</th>
                          <th style={{ width: 110 }}>{isAr ? 'الحالة' : 'Status'}</th>
                          <th style={{ width: 120 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {me.discipline.map((a) => (
                          <tr key={a.id}>
                            <td style={{ fontSize: 12 }}>{a.month_key}</td>
                            <td className="ttl">
                              {a.kind === 'deduction'
                                ? (isAr ? `خصم يوم (تأخير ${num(a.ordinal, isAr)})` : `Day deduction (late #${a.ordinal})`)
                                : (isAr ? `إنذار ${num(a.ordinal, isAr)}` : `Warning #${a.ordinal}`)}
                              {a.dispute_note && (
                                <div style={{ fontSize: 11, color: 'var(--mute)', fontWeight: 400 }}>
                                  {isAr ? 'اعتراضك: ' : 'Your note: '}{a.dispute_note}
                                </div>
                              )}
                            </td>
                            <td style={{ fontSize: 12 }}>
                              {a.status === 'pending' && (observe ? (isAr ? 'مراقبة' : 'observe') : (isAr ? 'معلّق' : 'pending'))}
                              {a.status === 'approved' && (isAr ? 'معتمد' : 'approved')}
                              {a.status === 'rejected' && (isAr ? 'مرفوض' : 'rejected')}
                              {a.status === 'disputed' && (isAr ? 'معترَض عليه' : 'disputed')}
                            </td>
                            <td>
                              {a.status === 'pending' && (
                                <button type="button" className="btn btn-sm" onClick={() => setDisputeId(a.id)}>
                                  {isAr ? 'اعتراض' : 'Dispute'}
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>

            {/* ── KPI bonuses + leaves + ledger ───────────────────────── */}
            <div className="grid g2" style={{ gap: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
              <div className="card">
                <div className="card-h"><h4>{isAr ? `مكافآت ${me.month}` : `${me.month} bonuses`}</h4></div>
                <div className="card-b">
                  {me.kpi_goals.length === 0
                    ? <div style={{ fontSize: 12, color: 'var(--mute)' }}>{isAr ? 'لا أهداف مكافآت لك هذا الشهر.' : 'No bonus goals include you this month.'}</div>
                    : me.kpi_goals.map((g) => (
                      <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line, #eee)' }}>
                        <div>
                          <b style={{ fontSize: 13 }}>{(isAr ? g.label_ar : g.label_en) ?? g.metric.toUpperCase()}</b>
                          <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                            {g.metric.toUpperCase()} {g.comparator === 'lte' ? '≤' : '≥'} {num(g.target, isAr)}
                            {' · '}+{num(g.bonus_pct, isAr)}%
                          </div>
                        </div>
                        <span className="tag" style={{ alignSelf: 'center', color: g.result?.hit ? 'var(--ok, #1b7f4d)' : undefined }}>
                          {g.result
                            ? g.result.hit ? (isAr ? 'محقّق ✓' : 'Hit ✓')
                              : `${isAr ? 'حاليًا' : 'now'} ${g.result.actual === null ? '—' : num(Math.round((g.result.actual + Number.EPSILON) * 1000) / 1000, isAr)}`
                            : (isAr ? 'لم يُقيَّم' : 'not evaluated')}
                        </span>
                      </div>
                    ))}
                </div>
              </div>

              <div className="card">
                <div className="card-h"><h4>{isAr ? 'إجازاتي' : 'My leaves'}</h4></div>
                <div className="card-b">
                  {me.leaves.length === 0
                    ? <div style={{ fontSize: 12, color: 'var(--mute)' }}>{isAr ? 'لا طلبات إجازة.' : 'No leave requests.'}</div>
                    : me.leaves.map((l) => (
                      <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line, #eee)', fontSize: 12 }}>
                        <span>{fmtDate(l.start_at, isAr)} ← {fmtDate(l.end_at, isAr)}</span>
                        <span className="tag">
                          {l.status === 'requested' ? (isAr ? 'معلّق' : 'pending')
                            : l.status === 'approved' ? (isAr ? 'معتمدة' : 'approved')
                              : (isAr ? 'مرفوضة' : 'rejected')}
                        </span>
                      </div>
                    ))}
                </div>
              </div>

              <div className="card">
                <div className="card-h"><h4>{isAr ? 'آخر النقاط' : 'Recent points'}</h4></div>
                <div className="card-b">
                  {me.ledger.length === 0
                    ? <div style={{ fontSize: 12, color: 'var(--mute)' }}>{isAr ? 'لا نقاط بعد — أنجز مهامك في وقتها.' : 'No points yet — close your tasks on time.'}</div>
                    : me.ledger.map((e) => (
                      <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--line, #eee)', fontSize: 12 }}>
                        <span>
                          {e.source === 'rating' && (isAr ? `تقييم: ${levelLabel(e.note)}` : `Rating: ${levelLabel(e.note)}`)}
                          {e.source === 'on_time' && (isAr ? 'إنجاز في الوقت' : 'On-time close')}
                          {e.source === 'reward_spend' && (isAr ? 'صرف مكافأة' : 'Reward spent')}
                          {e.source === 'adjustment' && (isAr ? 'تعديل تقييم' : 'Rating adjusted')}
                        </span>
                        <b style={{ color: e.points >= 0 ? 'var(--ok, #1b7f4d)' : 'var(--bad, #b3261e)' }}>
                          {e.points >= 0 ? '+' : ''}{num(e.points, isAr)}
                        </b>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {disputeId && (
        <Modal
          title={isAr ? 'اعتراض على الإشعار' : 'Dispute this notice'}
          onClose={() => setDisputeId(null)}
          footer={(
            <>
              <button type="button" className="btn btn-p" disabled={busy || !disputeNote.trim()} onClick={() => void dispute()}>
                {isAr ? 'إرسال الاعتراض' : 'Send dispute'}
              </button>
              <button type="button" className="btn" onClick={() => setDisputeId(null)}>{isAr ? 'إلغاء' : 'Cancel'}</button>
            </>
          )}
        >
          <Field label={isAr ? 'سبب الاعتراض' : 'Why this is unfair'}>
            <textarea className="inp" rows={4} value={disputeNote} onChange={(e) => setDisputeNote(e.target.value)} />
          </Field>
        </Modal>
      )}

      {leaveOpen && (
        <Modal
          title={isAr ? 'طلب إجازة' : 'Request leave'}
          sub={isAr ? 'الإجازة المعتمدة توقف عدّاد المُهَل طوال مدتها.' : 'Approved leave pauses your task clocks for its duration.'}
          onClose={() => setLeaveOpen(false)}
          footer={(
            <>
              <button type="button" className="btn btn-p" disabled={busy} onClick={() => void requestLeave()}>
                {isAr ? 'إرسال' : 'Send'}
              </button>
              <button type="button" className="btn" onClick={() => setLeaveOpen(false)}>{isAr ? 'إلغاء' : 'Cancel'}</button>
            </>
          )}
        >
          <div style={{ display: 'grid', gap: 13 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
              <Field label={isAr ? 'من' : 'From'}>
                <input className="inp ltr" type="datetime-local" value={lStart} onChange={(e) => setLStart(e.target.value)} />
              </Field>
              <Field label={isAr ? 'إلى' : 'To'}>
                <input className="inp ltr" type="datetime-local" value={lEnd} onChange={(e) => setLEnd(e.target.value)} />
              </Field>
            </div>
            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'النوع' : 'Kind'}</div>
              <div className="seg">
                <button type="button" className={lKind === 'annual' ? 'on' : ''} onClick={() => setLKind('annual')}>{isAr ? 'سنوية' : 'Annual'}</button>
                <button type="button" className={lKind === 'sick' ? 'on' : ''} onClick={() => setLKind('sick')}>{isAr ? 'مرضية' : 'Sick'}</button>
                <button type="button" className={lKind === 'other' ? 'on' : ''} onClick={() => setLKind('other')}>{isAr ? 'أخرى' : 'Other'}</button>
              </div>
            </div>
            <Field label={isAr ? 'ملاحظة (اختياري)' : 'Note (optional)'}>
              <input className="inp" value={lNote} onChange={(e) => setLNote(e.target.value)} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
