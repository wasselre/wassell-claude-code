/**
 * Settings → Capacity. The numbers the scheduling engine plans against.
 *
 * Four things live here, and they are the difference between a preview that
 * means something and a preview that always says yes:
 *
 *   1. Per-person daily slots per bucket — including APPROVALS, which is its
 *      own budget precisely because one marketing manager reviewing everything
 *      is the real bottleneck a production-only count never sees.
 *   2. The weekend days.
 *   3. The holidays.
 *   4. Step EFFORT — how much work a stage IS.
 *
 * The fourth is the one people get wrong. Effort is not a deadline allowance:
 * «يومان للتصميم» here means the design consumes two of the designer's working
 * days, not that they have two days in which to get around to it. The old SLA
 * grid was the second thing, and using it as the first is what made every plan
 * look comfortable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import type { LoadBucket, PersonCapacity, WorkCalendar } from '@/lib/marketingOS/scheduling';
import { DEFAULT_WORKFLOWS } from '@/lib/marketingOS/scheduling';
import {
  fetchCapacityConfig, fetchWorkloadCalendar, saveCapacityConfig,
  type MosCapacityConfig,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';
import {
  bucketLabel, personName, pickText, resolveStepEffort, resolveUserCap, stepLabel,
  weekendFromSettings, type NamedPerson, type ResolvedValue,
} from '../lib/planPresentation';
import { num } from '../lib/format';

const BUCKETS: LoadBucket[] = ['post', 'video', 'approvals'];

const WEEKDAYS: Array<{ n: number; ar: string; en: string }> = [
  { n: 0, ar: 'الأحد', en: 'Sunday' },
  { n: 1, ar: 'الاثنين', en: 'Monday' },
  { n: 2, ar: 'الثلاثاء', en: 'Tuesday' },
  { n: 3, ar: 'الأربعاء', en: 'Wednesday' },
  { n: 4, ar: 'الخميس', en: 'Thursday' },
  { n: 5, ar: 'الجمعة', en: 'Friday' },
  { n: 6, ar: 'السبت', en: 'Saturday' },
];

interface HolidayDraft { day: string; label_ar: string; label_en: string }

const capKey = (userId: string, bucket: string): string => `${userId}|${bucket}`;
const effortKey = (workflowKey: string, stepKey: string): string => `${workflowKey}|${stepKey}`;

/**
 * Self-contained route component: it reads the workspace context itself rather
 * than taking props, because the shared route-wrapper file belongs to another
 * screen's build. `manage_capacity` gates every input; everyone else reads.
 */
export default function SettingsCapacity() {
  const { isAr, can, people: directory } = useWorkspace();
  const canManage = can('manage_capacity');
  const people: NamedPerson[] = directory;
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capacityPeople, setCapacityPeople] = useState<PersonCapacity[]>([]);
  const [calendar, setCalendar] = useState<WorkCalendar | null>(null);
  const [config, setConfig] = useState<MosCapacityConfig | null>(null);

  // Only EDITED values are sent. An untouched screen writes nothing — so a
  // stage whose effort has never been tuned (and therefore shows the engine
  // seed, labelled «افتراضي») can never be written over by simply opening this
  // page.
  const [capEdits, setCapEdits] = useState<Record<string, number>>({});
  const [effortEdits, setEffortEdits] = useState<Record<string, number>>({});
  const [weekend, setWeekend] = useState<number[] | null>(null);
  const [holidays, setHolidays] = useState<HolidayDraft[] | null>(null);
  const [newHoliday, setNewHoliday] = useState<HolidayDraft>({ day: '', label_ar: '', label_en: '' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Two reads, one screen: `capacity_config` is the STORED configuration
      // (overrides, holidays with their labels, tuned effort), while the
      // workload snapshot is what the planner actually resolved from it —
      // per-person caps folded with their role fallback, plus approved leave.
      // Showing the second and editing the first is what makes an override
      // distinguishable from an inherited number.
      const today = new Date().toISOString().slice(0, 10);
      const [cfg, res] = await Promise.all([
        fetchCapacityConfig(),
        fetchWorkloadCalendar(today, today),
      ]);
      setConfig(cfg);
      setCapacityPeople(res.people);
      setCalendar(res.calendar);
      setCapEdits({});
      setEffortEdits({});
      setWeekend(null);
      setHolidays(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const effectiveWeekend = weekend
    ?? (config ? weekendFromSettings(config.settings) : null)
    ?? calendar?.weekendDays
    ?? [5];

  const effectiveHolidays: HolidayDraft[] = holidays
    ?? (config
      ? config.holidays.map((h) => ({ day: h.day, label_ar: h.label_ar ?? '', label_en: h.label_en ?? '' }))
      : (calendar?.holidays ?? []).map((d) => ({ day: d, label_ar: '', label_en: '' })));

  /** The number in the box, plus whether a human ever chose it. */
  const capOf = (p: PersonCapacity, bucket: LoadBucket): ResolvedValue => {
    const edited = capEdits[capKey(p.userId, bucket)];
    if (edited !== undefined) return { value: edited, source: 'stored' };
    return resolveUserCap(config?.user_caps ?? [], p.userId, bucket, p.caps[bucket] ?? 0);
  };

  const effortOf = (
    workflowKey: string, stepKey: string, bucket: string, seed: number,
  ): ResolvedValue => {
    const edited = effortEdits[effortKey(workflowKey, stepKey)];
    if (edited !== undefined) return { value: edited, source: 'stored' };
    return resolveStepEffort(config?.step_effort ?? [], workflowKey, stepKey, bucket, seed);
  };

  const dirty = Object.keys(capEdits).length > 0
    || Object.keys(effortEdits).length > 0
    || weekend !== null
    || holidays !== null;

  const dailyTotals = useMemo(() => {
    const t: Record<string, number> = { post: 0, video: 0, approvals: 0 };
    for (const p of capacityPeople) for (const b of BUCKETS) t[b] = (t[b] ?? 0) + capOf(p, b).value;
    return t;
    // capOf folds in capEdits and the stored overrides; recompute on any move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capacityPeople, capEdits, config]);

  const save = async (): Promise<void> => {
    if (!canManage || !dirty) return;
    setBusy(true);
    try {
      const user_caps = Object.entries(capEdits).map(([k, daily_slots]) => {
        const [user_id, bucket] = k.split('|');
        return { user_id: user_id ?? '', bucket: bucket ?? 'post', daily_slots };
      }).filter((r) => r.user_id);

      const step_effort = Object.entries(effortEdits).map(([k, working_days]) => {
        const [workflow_key, step_key] = k.split('|');
        return { workflow_key: workflow_key ?? '', step_key: step_key ?? '', bucket: '*', working_days };
      }).filter((r) => r.workflow_key && r.step_key);

      await saveCapacityConfig({
        ...(user_caps.length > 0 ? { user_caps } : {}),
        ...(step_effort.length > 0 ? { step_effort } : {}),
        ...(weekend !== null ? { weekend_days: weekend } : {}),
        ...(holidays !== null
          ? {
            holidays: holidays
              .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.day))
              .map((h) => ({
                day: h.day,
                label_ar: h.label_ar.trim() || 'إجازة',
                label_en: h.label_en.trim() || 'Holiday',
              })),
          }
          : {}),
      });
      addToast(isAr ? 'حُفظت الطاقة والتقويم.' : 'Capacity and calendar saved.', 'success');
      await load();
    } catch (e) {
      // Never swallowed: a failed save leaves the edits on screen so nothing
      // typed is lost, and the reason is shown.
      console.error('[mos] capacity_config_save failed', e);
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const Back = isAr ? IconForward : IconBack;

  return (
    <>
      <PageHead
        title={isAr ? 'الطاقة والتقويم' : 'Capacity & calendar'}
        sub={isAr
          ? 'الأرقام التي يخطّط عليها محرّك الجدولة: كم يستوعب كل شخص في اليوم، وأي الأيام أيام عمل، وكم يستغرق كل عمل فعلًا.'
          : 'The numbers the scheduling engine plans against: what each person can take in a day, which days are working days, and how much work each stage actually is.'}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        {canManage && (
          <button type="button" className="btn btn-p" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={6} />}

        {!loading && !error && (
          <>
            {!canManage && (
              <div className="notice" style={{ marginBottom: 16 }}>
                {isAr
                  ? 'العرض فقط — تعديل الطاقة يحتاج صلاحية «إدارة الطاقة».'
                  : 'Read-only — editing capacity needs the “manage capacity” capability.'}
              </div>
            )}

            {/* ── per-person daily slots ──────────────────────────────── */}
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'الطاقة اليومية لكل شخص' : 'Daily slots per person'}</h4>
                <span className="r">
                  {isAr
                    ? `المجموع اليومي: ${num(dailyTotals.post ?? 0, true)} منشور · ${num(dailyTotals.video ?? 0, true)} فيديو · ${num(dailyTotals.approvals ?? 0, true)} اعتماد`
                    : `Team per day: ${dailyTotals.post ?? 0} posts · ${dailyTotals.video ?? 0} videos · ${dailyTotals.approvals ?? 0} approvals`}
                </span>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'الشخص' : 'Person'}</th>
                      {BUCKETS.map((b) => (
                        <th key={b} className="num">{pickText(bucketLabel(b), isAr)}</th>
                      ))}
                      <th>{isAr ? 'إجازات معتمدة' : 'Approved leave'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {capacityPeople.map((p) => (
                      <tr key={p.userId}>
                        <td className="ttl">
                          <div>{personName(p.userId, people, isAr)}</div>
                          <div className="id">{p.roles.join(' · ') || '—'}</div>
                        </td>
                        {BUCKETS.map((b) => {
                          const cap = capOf(p, b);
                          return (
                            <td key={b} className="num">
                              <input
                                className="inp ltr"
                                style={{ width: 74, textAlign: 'center', padding: '6px 8px' }}
                                inputMode="numeric"
                                disabled={!canManage}
                                aria-label={`${personName(p.userId, people, isAr)} — ${pickText(bucketLabel(b), isAr)}`}
                                value={String(cap.value)}
                                onChange={(e) => {
                                  const n = Number(e.target.value.replace(/[^\d]/g, ''));
                                  setCapEdits((prev) => ({
                                    ...prev,
                                    [capKey(p.userId, b)]: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0,
                                  }));
                                }}
                              />
                              <div style={{ fontSize: 10, color: 'var(--mute)', marginTop: 3, fontWeight: 400 }}>
                                {cap.source === 'stored'
                                  ? (isAr ? 'مخصّص' : 'override')
                                  : (isAr ? 'من الدور' : 'from role')}
                              </div>
                            </td>
                          );
                        })}
                        <td style={{ color: 'var(--mute)', fontSize: 11.5 }}>
                          {p.leaves.length === 0
                            ? '—'
                            : p.leaves.map((l) => `${l.from} → ${l.to}`).join(' · ')}
                        </td>
                      </tr>
                    ))}
                    {capacityPeople.length === 0 && (
                      <tr>
                        <td colSpan={5} style={{ color: 'var(--mute)' }}>
                          {isAr ? 'لا يوجد أشخاص في أدوار التسويق بعد.' : 'Nobody holds a marketing role yet.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="card-b" style={{ borderTop: '1px solid var(--line-soft)', fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.9 }}>
                {isAr
                  ? '«من الدور» يعني أنّ الرقم موروث من طاقة الدور، و«مخصّص» يعني أنّ أحدًا حدّده لهذا الشخص تحديدًا — والكتابة في الخانة تُنشئ تخصيصًا. صفر يعني أنّ هذا الشخص لا يأخذ هذا النوع من العمل إطلاقًا. الاعتمادات ميزانية منفصلة عمدًا: مراجعات المدير لا يجوز أن تأكل من طاقة التصميم، ولو أُدمجتا لبدت كل خطة ممكنة.'
                  : '“From role” means the number is inherited from the role’s load; “override” means someone set it for this person — and typing in the box creates one. Zero means this person never takes that kind of work. Approvals are a separate budget on purpose: a manager’s reviews must not eat the design budget — folded together, every plan looks possible.'}
              </div>
            </div>

            {/* ── the working week ────────────────────────────────────── */}
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-h">
                <h4>{isAr ? 'أيام العطلة الأسبوعية' : 'Weekend days'}</h4>
                <span className="r">
                  {isAr ? 'ما عداها أيام عمل للإنتاج' : 'everything else is a production working day'}
                </span>
              </div>
              <div className="card-b">
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  {WEEKDAYS.map((w) => {
                    const on = effectiveWeekend.includes(w.n);
                    return (
                      <button
                        key={w.n}
                        type="button"
                        className={`fbtn${on ? ' on' : ''}`}
                        disabled={!canManage}
                        onClick={() => setWeekend(
                          on ? effectiveWeekend.filter((x) => x !== w.n) : [...effectiveWeekend, w.n].sort((a, b) => a - b),
                        )}
                      >
                        {isAr ? w.ar : w.en}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 10, lineHeight: 1.9 }}>
                  {isAr
                    ? 'النشر يجري طوال أيام الأسبوع؛ هذه أيام لا يُنتَج فيها. تصميم مدته يومان يبدأ الخميس يتخطّى الجمعة ولا يمتد داخلها.'
                    : 'Publishing runs every day of the week; these are days on which no production happens. A two-day design starting Thursday skips Friday rather than stretching through it.'}
                </div>
              </div>
            </div>

            {/* ── holidays ────────────────────────────────────────────── */}
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-h">
                <h4>{isAr ? 'الإجازات' : 'Holidays'}</h4>
                <span className="r">{num(effectiveHolidays.length, isAr)}</span>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'اليوم' : 'Day'}</th>
                      <th>{isAr ? 'المناسبة (عربي)' : 'Label (Arabic)'}</th>
                      <th>{isAr ? 'المناسبة (إنجليزي)' : 'Label (English)'}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {effectiveHolidays.map((h, i) => (
                      <tr key={`${h.day}-${i}`}>
                        <td className="ltr">{h.day}</td>
                        <td>{h.label_ar || '—'}</td>
                        <td>{h.label_en || '—'}</td>
                        <td style={{ width: 90 }}>
                          {canManage && (
                            <button
                              type="button"
                              className="fbtn"
                              onClick={() => setHolidays(effectiveHolidays.filter((_, j) => j !== i))}
                            >
                              {isAr ? 'حذف' : 'Remove'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {effectiveHolidays.length === 0 && (
                      <tr>
                        <td colSpan={4} style={{ color: 'var(--mute)' }}>
                          {isAr ? 'لا إجازات مسجّلة.' : 'No holidays recorded.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {canManage && (
                <div className="card-b" style={{ borderTop: '1px solid var(--line-soft)', display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    type="date"
                    className="inp ltr"
                    style={{ width: 170 }}
                    value={newHoliday.day}
                    onChange={(e) => setNewHoliday({ ...newHoliday, day: e.target.value })}
                  />
                  <input
                    className="inp"
                    style={{ flex: 1, minWidth: 140 }}
                    placeholder={isAr ? 'المناسبة بالعربية' : 'Arabic label'}
                    value={newHoliday.label_ar}
                    onChange={(e) => setNewHoliday({ ...newHoliday, label_ar: e.target.value })}
                  />
                  <input
                    className="inp"
                    style={{ flex: 1, minWidth: 140 }}
                    placeholder={isAr ? 'المناسبة بالإنجليزية' : 'English label'}
                    value={newHoliday.label_en}
                    onChange={(e) => setNewHoliday({ ...newHoliday, label_en: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!/^\d{4}-\d{2}-\d{2}$/.test(newHoliday.day)}
                    onClick={() => {
                      if (effectiveHolidays.some((h) => h.day === newHoliday.day)) {
                        addToast(isAr ? 'هذا اليوم مسجّل مسبقًا.' : 'That day is already recorded.', 'error');
                        return;
                      }
                      setHolidays([...effectiveHolidays, newHoliday].sort((a, b) => (a.day < b.day ? -1 : 1)));
                      setNewHoliday({ day: '', label_ar: '', label_en: '' });
                    }}
                  >
                    {isAr ? 'إضافة' : 'Add'}
                  </button>
                </div>
              )}
            </div>

            {/* ── step effort ─────────────────────────────────────────── */}
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-h">
                <h4>{isAr ? 'جهد كل مرحلة (أيام عمل)' : 'Effort per stage (working days)'}</h4>
                <span className="r">{isAr ? 'تقدير للعمل، لا مهلة' : 'an estimate of work, not a deadline'}</span>
              </div>
              <div className="notice" style={{ margin: '0 16px 0', borderRadius: 0, border: 0, borderBottom: '1px solid var(--line-soft)' }}>
                {isAr
                  ? 'هذا الرقم يعني: كم يومًا من أيام عمل صاحب المرحلة يستهلكها هذا العمل. لا يعني «كم يومًا أمامه ليبدأ». المهلة شيء آخر تمامًا وتُضبط في «طاقة العمل والمُهَل» — والخلط بينهما هو ما يجعل كل خطة تبدو مريحة ثم تتأخر.'
                  : 'This number means: how many of the stage owner’s working days the work consumes. It does not mean “how long they have before starting”. That allowance is a different setting (Load & SLA) — and conflating the two is what makes every plan look comfortable and then run late.'}
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'المسار' : 'Workflow'}</th>
                      <th>{isAr ? 'المرحلة' : 'Stage'}</th>
                      <th>{isAr ? 'الدور' : 'Role'}</th>
                      <th className="num">{isAr ? 'أيام عمل' : 'Working days'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.values(DEFAULT_WORKFLOWS).flatMap((wf) => wf.steps.map((s) => {
                      const key = effortKey(wf.workflowKey, s.key);
                      const edited = effortEdits[key] !== undefined;
                      const eff = effortOf(wf.workflowKey, s.key, wf.bucket, s.workingDays);
                      return (
                        <tr key={key} className={edited ? 'hl' : undefined}>
                          <td className="id">{wf.workflowKey}</td>
                          <td className="ttl">{pickText(stepLabel(s.key), isAr)}</td>
                          <td style={{ color: 'var(--mute)' }}>{s.roleKey}</td>
                          <td className="num">
                            <input
                              className="inp ltr"
                              style={{ width: 84, textAlign: 'center', padding: '6px 8px' }}
                              inputMode="decimal"
                              disabled={!canManage}
                              aria-label={`${wf.workflowKey} ${s.key}`}
                              value={String(eff.value)}
                              onChange={(e) => {
                                const n = Number(e.target.value.replace(/[^\d.]/g, ''));
                                setEffortEdits((prev) => ({
                                  ...prev,
                                  [key]: Number.isFinite(n) && n > 0 ? n : 0.25,
                                }));
                              }}
                            />
                            <div style={{ fontSize: 10, color: 'var(--mute)', marginTop: 3, fontWeight: 400 }}>
                              {eff.source === 'stored'
                                ? (isAr ? 'محفوظ' : 'stored')
                                : (isAr ? 'افتراضي' : 'default')}
                            </div>
                          </td>
                        </tr>
                      );
                    }))}
                  </tbody>
                </table>
              </div>
              <div className="card-b" style={{ borderTop: '1px solid var(--line-soft)', fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.9 }}>
                {isAr
                  ? 'الصفوف المعلَّمة «محفوظ» قيمها من قاعدة البيانات، و«افتراضي» يعني أنّ أحدًا لم يضبط هذه المرحلة بعد فيستخدم المحرّك بذرته. لا يُرسل إلا ما عدّلته أنت: الصفوف التي لم تلمسها لا تُكتب ولا تُستبدل.'
                  : 'Rows marked “stored” come from the database; “default” means nobody has tuned that stage yet, so the engine uses its seed. Only rows YOU edit are sent: untouched rows are never written and never overwrite tuned values.'}
              </div>
            </div>

            {canManage && (
              <div style={{ display: 'flex', gap: 9, justifyContent: 'flex-end', marginTop: 16 }}>
                {dirty && (
                  <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
                    {isAr ? 'تجاهل التغييرات' : 'Discard changes'}
                  </button>
                )}
                <button type="button" className="btn btn-p" disabled={!dirty || busy} onClick={() => void save()}>
                  {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
