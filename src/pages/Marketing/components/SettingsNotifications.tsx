/**
 * Settings → Notifications — design screen 43 («الإشعارات — لكل دور»).
 *
 * The per-role rule matrix over `notification_rules`: every row is an event,
 * the three columns are داخل التطبيق / واتساب / ملخص يومي, and every pill is
 * EDITABLE — a click toggles the rule via `notification_rule_set`,
 * optimistically. The «ملخص يومي» column is not a channel of its own: it is
 * the inapp rule with timing='digest' (one (role,event,channel) row carries
 * one timing), so turning the digest pill on turns the immediate pill off and
 * vice versa — exactly how the seed stores the screen.
 *
 * The one rule that governs the table (verbatim from the mockup): WhatsApp is
 * reserved for events that BLOCK someone else if not acted on. The CEO card
 * sits alongside for comparison — two notifications in the whole system.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosNotification, MosNotificationRule, MosPathRole, NotificationChannel,
  NotificationTiming, ROLE_LABELS, fetchNotificationRules, setNotificationRule,
} from '@/lib/marketingOS/client';
import { LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';
import { num } from '../lib/format';
import { NotificationRow, useMosNotifications } from './NotificationBell';

/* ------------------------------------------------------------------ */
/* the vocabulary — role tabs and event rows, in the mockup's order    */
/* ------------------------------------------------------------------ */

const TAB_ORDER: MosPathRole[] = ['writer', 'montage', 'ops_supervisor', 'marketing_manager', 'ceo'];

/** Roles whose pipeline includes publishing — for them «حان وقت النشر» is live. */
const PUBLISHER_ROLES: readonly MosPathRole[] = ['ops_supervisor', 'marketing_manager'];

interface EventRow {
  key: string;
  ar: string;
  en: string;
  sub_ar?: string;
  sub_en?: string;
  /** «للدور الذي ينشر فقط» — dimmed for roles that never publish. */
  publisherOnly?: boolean;
  /** The CEO comparison card's two events — rendered only on the CEO tab. */
  ceoOnly?: boolean;
}

const EVENTS: EventRow[] = [
  {
    key: 'task_assigned',
    ar: 'فُتحت لك مهمة', en: 'A task opened for you',
    sub_ar: 'اعتُمدت خطوة سابقة ودورك بدأ',
    sub_en: 'A previous step was approved and your turn began',
  },
  {
    // Separate from `task_assigned` on purpose: that one is the workflow
    // reaching your stage, this one is a person handing you something. Muting
    // the first is a reasonable thing for a busy role to want; muting the
    // second is a different decision, so they are tuned independently.
    key: 'manual_task_assigned',
    ar: 'أسند إليك شخص مهمة', en: 'Someone assigned you a task',
    sub_ar: 'مهمة يدوية خارج مسارات العمل',
    sub_en: 'A hand-assigned task, outside the workflows',
  },
  {
    key: 'changes_requested',
    ar: 'أُعيد عملك بتعديلات', en: 'Your work came back with changes',
    sub_ar: 'مع الملاحظة كاملة في نص الإشعار',
    sub_en: 'With the full note inside the notification text',
  },
  { key: 'content_approved', ar: 'اعتُمد عملك', en: 'Your work was approved' },
  { key: 'task_due_soon', ar: 'مهمتك تستحق غدًا', en: 'Your task is due tomorrow' },
  { key: 'task_overdue', ar: 'مهمتك تأخرت', en: 'Your task is late' },
  { key: 'mentioned_in_comment', ar: 'ذُكِرتَ في تعليق', en: 'You were mentioned in a comment' },
  {
    key: 'publish_due',
    ar: 'حان وقت النشر', en: 'Publish time arrived',
    sub_ar: 'للدور الذي ينشر فقط',
    sub_en: 'Only for the role that publishes',
    publisherOnly: true,
  },
  { key: 'budget_signature', ar: 'ميزانية تنتظر توقيعك', en: 'A budget awaits your signature', ceoOnly: true },
  { key: 'monthly_report_ready', ar: 'التقرير الشهري جاهز', en: 'The monthly report is ready', ceoOnly: true },
];

interface CellState { enabled: boolean; timing: NotificationTiming }

/* ------------------------------------------------------------------ */
/* one editable pill cell                                              */
/* ------------------------------------------------------------------ */

function RuleCell({
  on, label, tone, disabled, title, onClick,
}: {
  on: boolean;
  label: string;
  tone: 'go' | 'wait' | 'idle';
  disabled: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="se-rule-cell" disabled={disabled} title={title} onClick={onClick}>
      {on ? <span className={`pill p-${tone}`}>{label}</span> : <span className="mk2 mk-n">—</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* the page                                                            */
/* ------------------------------------------------------------------ */

export default function SettingsNotifications({ canManage, isAr }: { canManage: boolean; isAr: boolean }) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [tab, setTab] = useState<MosPathRole>('writer');
  const [rules, setRules] = useState<MosNotificationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  // Screen 43's «مركز الإشعارات» card — the live inbox, fetched once here.
  const centre = useMosNotifications();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchNotificationRules();
      setRules(res.rules);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const cellOf = useCallback(
    (role: string, event: string, channel: NotificationChannel): CellState => {
      const r = rules.find((x) => x.role_key === role && x.event === event && x.channel === channel);
      if (!r) return { enabled: false, timing: 'immediate' };
      return { enabled: r.enabled, timing: r.timing === 'digest' ? 'digest' : 'immediate' };
    },
    [rules],
  );

  const apply = useCallback(
    (role: string, event: string, channel: NotificationChannel, next: CellState) => {
      setRules((rs) => {
        const i = rs.findIndex((x) => x.role_key === role && x.event === event && x.channel === channel);
        const row: MosNotificationRule = {
          role_key: role, event, channel, timing: next.timing, enabled: next.enabled,
        };
        if (i === -1) return [...rs, row];
        const copy = rs.slice();
        copy[i] = row;
        return copy;
      });
    },
    [],
  );

  const setCell = async (
    role: string, event: string, channel: NotificationChannel, next: CellState,
  ): Promise<void> => {
    const prev = cellOf(role, event, channel);
    // Optimistic — the pill must flip on click, not after the round-trip.
    apply(role, event, channel, next);
    try {
      await setNotificationRule({
        role_key: role, event, channel, enabled: next.enabled, timing: next.timing,
      });
    } catch (e) {
      apply(role, event, channel, prev);
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  /* rows for the active tab — plus any event the DB knows that this file
     doesn't, appended so a new event key can never silently vanish. */
  const visibleRows = useMemo(() => {
    const base = EVENTS.filter((e) => (tab === 'ceo' ? true : !e.ceoOnly));
    const known = new Set(EVENTS.map((e) => e.key));
    const extras = [...new Set(rules.filter((r) => !known.has(r.event)).map((r) => r.event))]
      .sort()
      .map((k): EventRow => ({ key: k, ar: k, en: k }));
    return [...base, ...extras];
  }, [tab, rules]);

  const isDimmed = (e: EventRow): boolean =>
    e.publisherOnly === true && !PUBLISHER_ROLES.includes(tab);

  const activeCount = visibleRows.filter((e) => !isDimmed(e)).length;
  const tabLabel = isAr ? ROLE_LABELS[tab].ar : ROLE_LABELS[tab].en;
  const clickHint = isAr ? 'اضغط للتبديل' : 'Click to toggle';

  const openItem = (n: MosNotification): void => {
    if (!n.read_at) {
      centre.markOne(n.id).catch((e: unknown) =>
        addToast(e instanceof Error ? e.message : String(e), 'error'));
    }
    if (n.url && n.url.startsWith('/')) navigate(n.url);
  };

  const markAllClick = async (): Promise<void> => {
    setMarking(true);
    try {
      await centre.markAll();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setMarking(false);
    }
  };

  return (
    <>
      <PageHead
        title={isAr ? 'الإشعارات' : 'Notifications'}
        sub={
          isAr
            ? `${num(activeCount, true)} أحداث · ${num(3, true)} قنوات · تُضبط لكل دور على حدة`
            : `${activeCount} events · 3 channels · tuned per role`
        }
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        <div className="seg">
          {TAB_ORDER.map((r) => (
            <button
              key={r}
              type="button"
              className={tab === r ? 'on' : ''}
              onClick={() => setTab(r)}
            >
              {isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}
            </button>
          ))}
        </div>
      </PageHead>
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={6} />}
        {!loading && !error && (
          <div className="se-ntf-grid">
            {/* ── the matrix ─────────────────────────────────────────── */}
            <div className="card">
              <div className="card-h">
                <h4>
                  {isAr ? 'ما الذي يُشعِر ' : 'What notifies the '}
                  <b style={{ color: 'var(--copper)' }}>{tabLabel}</b>
                  {isAr ? '؟' : '?'}
                </h4>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'الحدث' : 'Event'}</th>
                      <th style={{ width: 110 }}>{isAr ? 'داخل التطبيق' : 'In-app'}</th>
                      <th style={{ width: 100 }}>{isAr ? 'واتساب' : 'WhatsApp'}</th>
                      <th style={{ width: 110 }}>{isAr ? 'ملخص يومي' : 'Daily digest'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((e) => {
                      const inapp = cellOf(tab, e.key, 'inapp');
                      const wa = cellOf(tab, e.key, 'whatsapp');
                      const inappOn = inapp.enabled && inapp.timing === 'immediate';
                      const digestOn = inapp.enabled && inapp.timing === 'digest';
                      const urgent = e.key === 'task_overdue';
                      return (
                        <tr key={e.key} style={isDimmed(e) ? { opacity: 0.55 } : undefined}>
                          <td>
                            <div className="ttl">{isAr ? e.ar : e.en}</div>
                            {(isAr ? e.sub_ar : e.sub_en) && (
                              <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 2 }}>
                                {isAr ? e.sub_ar : e.sub_en}
                              </div>
                            )}
                          </td>
                          <td>
                            <RuleCell
                              on={inappOn}
                              label={isAr ? 'فوري' : 'Immediate'}
                              tone={urgent ? 'wait' : 'go'}
                              disabled={!canManage}
                              title={clickHint}
                              onClick={() => void setCell(tab, e.key, 'inapp', {
                                enabled: !inappOn, timing: 'immediate',
                              })}
                            />
                          </td>
                          <td>
                            <RuleCell
                              on={wa.enabled}
                              label={urgent ? (isAr ? 'بعد يوم' : 'After a day') : (isAr ? 'فوري' : 'Immediate')}
                              tone={urgent ? 'wait' : 'go'}
                              disabled={!canManage}
                              title={clickHint}
                              onClick={() => void setCell(tab, e.key, 'whatsapp', {
                                enabled: !wa.enabled, timing: 'immediate',
                              })}
                            />
                          </td>
                          <td>
                            <RuleCell
                              on={digestOn}
                              label={e.key === 'task_due_soon'
                                ? (isAr ? '٨:٠٠ ص' : '8:00 AM')
                                : (isAr ? 'ضمن الملخص' : 'In the digest')}
                              tone="idle"
                              disabled={!canManage}
                              title={clickHint}
                              onClick={() => void setCell(tab, e.key, 'inapp', {
                                enabled: !digestOn, timing: 'digest',
                              })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div
                className="card-b"
                style={{ borderTop: '1px solid var(--line-soft)', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.9 }}
              >
                {isAr ? (
                  <>
                    <b>قاعدة واحدة تحكم الجدول:</b> واتساب لما يعطّل شخصًا آخر إن لم يُنجَز — فتح مهمة،
                    إعادة عمل، حان وقت النشر. وكل ما عداه داخل التطبيق أو في ملخص الصباح.
                    الإشعار الذي لا يستدعي فعلًا هو ضجيج، والضجيج يُطفَأ ثم لا يُشغَّل.
                  </>
                ) : (
                  <>
                    <b>One rule governs this table:</b> WhatsApp is for what blocks someone else if
                    left undone — a task opening, work coming back, publish time arriving. Everything
                    else stays in-app or in the morning digest. A notification that calls for no
                    action is noise, and noise gets switched off and never back on.
                  </>
                )}
              </div>
            </div>

            {/* ── side column: the live inbox + the CEO comparison ───── */}
            <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'مركز الإشعارات' : 'Notification centre'}</h4>
                  {centre.unread > 0 && (
                    <span className="pill p-now" style={{ marginInlineStart: 'auto' }}>
                      {num(centre.unread, isAr)}
                    </span>
                  )}
                </div>
                <div className="card-b" style={{ display: 'grid', gap: 0, padding: '6px 0' }}>
                  {centre.error && (
                    <div className="se-notif-b" style={{ padding: '10px 14px' }}>
                      {isAr ? 'تعذّر تحميل الإشعارات: ' : 'Notifications could not load: '}{centre.error}
                    </div>
                  )}
                  {!centre.error && centre.loading && (
                    <div style={{ padding: '10px 14px' }}><Skeleton rows={3} /></div>
                  )}
                  {!centre.error && !centre.loading && centre.rows.length === 0 && (
                    <div className="se-notif-b" style={{ padding: '12px 14px' }}>
                      {isAr ? 'لا إشعارات بعد.' : 'No notifications yet.'}
                    </div>
                  )}
                  {!centre.error && centre.rows.slice(0, 6).map((n) => (
                    <NotificationRow key={n.id} n={n} isAr={isAr} onOpen={openItem} />
                  ))}
                </div>
                <div className="card-b" style={{ borderTop: '1px solid var(--line-soft)', padding: '10px 14px' }}>
                  <button
                    type="button"
                    className="btn btn-d btn-sm"
                    disabled={centre.unread === 0 || marking}
                    onClick={() => void markAllClick()}
                  >
                    {isAr ? 'تعليم الكل كمقروء' : 'Mark all as read'}
                  </button>
                </div>
              </div>

              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'الرئيس التنفيذي' : 'The CEO'}</h4>
                  <span className="r">{isAr ? 'للمقارنة' : 'For comparison'}</span>
                </div>
                <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                  {isAr ? 'إشعاران فقط في المنظومة كلها:' : 'Two notifications in the whole system:'}
                  <div className="rule" style={{ marginTop: 8 }}>
                    <span className="arw">←</span>
                    <span>{isAr ? 'ميزانية تنتظر توقيعك' : 'A budget awaits your signature'}</span>
                  </div>
                  <div className="rule">
                    <span className="arw">←</span>
                    <span>{isAr ? 'التقرير الشهري جاهز' : 'The monthly report is ready'}</span>
                  </div>
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-soft)', color: 'var(--mute)' }}>
                    {isAr
                      ? 'ولا شيء عن المهام أو الاعتمادات أو التعليقات. لو أشعرناه بكل اعتماد، لأطفأ الإشعارات في أسبوع وفاتته الميزانية.'
                      : 'And nothing about tasks, approvals or comments. Had we notified him of every approval, he would have switched notifications off within a week and missed the budget.'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
