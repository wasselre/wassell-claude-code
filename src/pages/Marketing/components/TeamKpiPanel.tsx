/**
 * «مهامي» › «الفريق» — the team's numbers, not its tasks (2026-09-27).
 *
 * The operator: «i need to be able to view the team tasks not the actual tasks
 * but the KPIS and how many tasks and stuff». One read per period
 * (`team_kpis` → mos_team_kpis, gated on the view_team_kpis capability):
 *
 *   • four team cards — finished, on time, open now, time to finish;
 *   • one row per person — open now (late / due today), finished, on-time
 *     rate, median time to finish, lateness strikes, work booked for the next
 *     30 days, and a 30-square strip of that booked work against the person's
 *     daily limit, so a crunch shows up before it arrives.
 *
 * A task counts for the person it was ASSIGNED to, whoever closed it
 * (operator decision). Publishing never counts. Clicking a person opens
 * «الجميع» filtered to their open tasks — only for callers who can see the
 * team board.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ROLE_LABELS, fetchTeamKpis,
  type TeamKpiDay, type TeamKpiPeriod, type TeamKpiPerson, type TeamKpis,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Empty, LoadError, Skeleton } from './kit';
import { num, pct, shortDate } from '../lib/format';
import {
  bucketLabel, dayLevel, dayTitle, fullDays, hoursLabel, onTimeRate, personName, rateTone, round1,
  sortPeople, todayLoads,
  type LoadLevel, type RateTone,
} from '../lib/teamKpis';

const ROLE_TEXT = ROLE_LABELS as Record<string, { ar: string; en: string } | undefined>;

const TONE_CLASS: Record<RateTone, string> = { good: 't-go', fair: 't-wait', poor: 't-late' };
const TONE_COLOR: Record<RateTone, string> = { good: 'var(--go)', fair: 'var(--wait)', poor: 'var(--late)' };

const LEGEND: Array<{ level: LoadLevel; ar: string; en: string }> = [
  { level: 'empty', ar: 'لا شيء محجوز', en: 'Nothing booked' },
  { level: 'light', ar: 'أقل من ٦٠٪', en: 'Under 60%' },
  { level: 'busy', ar: 'مشغول', en: 'Busy' },
  { level: 'full', ar: 'ممتلئ', en: 'Full' },
  { level: 'over', ar: 'فوق الطاقة', en: 'Over the limit' },
  { level: 'off', ar: 'عطلة', en: 'Day off' },
  { level: 'leave', ar: 'إجازة', en: 'Leave' },
];

/** A date-only string read as local noon, so no timezone shifts its day. */
const noon = (day: string): string => `${day}T12:00:00`;

export default function TeamKpiPanel({
  onOpenPerson,
}: {
  /** Opens the person's open tasks. Absent when the caller cannot see the team board. */
  onOpenPerson?: (userId: string) => void;
}) {
  const { isAr } = useWorkspace();
  const [period, setPeriod] = useState<TeamKpiPeriod>('month');
  const [data, setData] = useState<TeamKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Switching period twice quickly must never let the older answer land last.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const req = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchTeamKpis(period);
      if (req === latest.current) setData(res);
    } catch (e) {
      if (req === latest.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (req === latest.current) setLoading(false);
    }
  }, [period]);

  useEffect(() => { void load(); }, [load]);

  const people = useMemo(
    () => (Array.isArray(data?.people) ? sortPeople(data.people, isAr) : []),
    [data, isAr],
  );

  const team = data?.team ?? null;
  const teamRate = team ? onTimeRate(team) : null;
  const withDeadline = team ? team.done - team.done_no_deadline : 0;

  return (
    <div>
      <div className="tk-bar">
        <div className="seg" role="group" aria-label={isAr ? 'الفترة' : 'Period'}>
          <button type="button" className={period === 'month' ? 'on' : ''} onClick={() => setPeriod('month')}>
            {isAr ? 'هذا الشهر' : 'This month'}
          </button>
          <button type="button" className={period === 'week' ? 'on' : ''} onClick={() => setPeriod('week')}>
            {isAr ? 'آخر ٧ أيام' : 'Last 7 days'}
          </button>
        </div>
        {data && (
          <span className="tk-range">
            {isAr
              ? `من ${shortDate(noon(data.from), true)} إلى ${shortDate(noon(data.to), true)}`
              : `${shortDate(noon(data.from), false)} to ${shortDate(noon(data.to), false)}`}
          </span>
        )}
      </div>

      {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
      {loading && !data && !error && <Skeleton rows={6} />}

      {data && team && (
        <div className={loading ? 'tk-dim' : undefined} aria-busy={loading}>
          <div className="tk-stats">
            <div className="stat">
              <div className="k">{isAr ? 'أُنجزت' : 'Finished'}</div>
              <div className="v">{num(team.done, isAr)}</div>
              <div className="d">
                {team.done_late > 0
                  ? (isAr ? `منها ${num(team.done_late, true)} متأخرة` : `${num(team.done_late, false)} of them late`)
                  : (isAr ? 'لا شيء متأخر' : 'None late')}
              </div>
            </div>
            <div className={`stat${teamRate !== null && teamRate < 50 ? ' alert' : ''}`}>
              <div className="k">{isAr ? 'في الوقت' : 'On time'}</div>
              <div className="v">{pct(teamRate, isAr)}</div>
              <div className="d">
                {isAr
                  ? `${num(withDeadline - team.done_late, true)} من ${num(withDeadline, true)}`
                  : `${num(withDeadline - team.done_late, false)} of ${num(withDeadline, false)}`}
              </div>
            </div>
            <div className={`stat${team.late_now > 0 ? ' alert' : ''}`}>
              <div className="k">{isAr ? 'مهام اليوم' : 'Tasks for today'}</div>
              <div className="v">{num(team.open_today, isAr)}</div>
              <div className="d">
                {[
                  isAr ? `متأخرة ${num(team.late_now, true)}` : `${num(team.late_now, false)} late`,
                  team.open_later > 0
                    ? (isAr ? `لأيام قادمة: ${num(team.open_later, true)}` : `for coming days: ${num(team.open_later, false)}`)
                    : null,
                  team.blocked_now > 0
                    ? (isAr ? `معلّقة ${num(team.blocked_now, true)}` : `${num(team.blocked_now, false)} blocked`)
                    : null,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="stat">
              <div className="k">{isAr ? 'مدة الإنجاز' : 'Time to finish'}</div>
              <div className="v">{hoursLabel(team.median_hours, isAr)}</div>
              <div className="d">{isAr ? 'الوسيط، من التسليم إلى الإنجاز' : 'Median, hand-off to done'}</div>
            </div>
          </div>

          <div className="tk-note">
            {isAr
              ? `إنذارات التأخير في الفترة: ${num(team.strikes, true)} · مهام محجوزة للثلاثين يومًا القادمة: ${num(team.booked_items, true)}`
              : `Lateness strikes in the period: ${num(team.strikes, false)} · Tasks booked for the next 30 days: ${num(team.booked_items, false)}`}
          </div>

          {people.length === 0 ? (
            <Empty title={isAr ? 'لا مهام للفريق في هذه الفترة' : 'No team tasks in this period'} />
          ) : (
            <div className="tk-list">
              <div className="tk-row tk-head">
                <div>{isAr ? 'الشخص' : 'Person'}</div>
                <div>{isAr ? 'اليوم' : 'Today'}</div>
                <div>{isAr ? 'أُنجزت' : 'Finished'}</div>
                <div>{isAr ? 'في الوقت' : 'On time'}</div>
                <div>{isAr ? 'مدة الإنجاز' : 'Time to finish'}</div>
                <div>{isAr ? 'إنذارات' : 'Strikes'}</div>
                <div>{isAr ? 'محجوزة ٣٠ يومًا' : 'Booked, 30 days'}</div>
              </div>
              {people.map((p) => (
                <PersonRow key={p.user_id} p={p} isAr={isAr} onOpen={onOpenPerson} />
              ))}
            </div>
          )}

          <div className="tk-legend">
            <span>{isAr ? 'كل مربع يوم، من اليوم إلى ٣٠ يومًا:' : 'Each square is a day, today to 30 days out:'}</span>
            {LEGEND.map((l) => (
              <span key={l.level}>
                <span className={`tk-d lv-${l.level}`} aria-hidden="true" />
                {isAr ? l.ar : l.en}
              </span>
            ))}
          </div>
          <div className="tk-foot">
            {isAr
              ? '«اليوم»: ما حُجز للشخص اليوم مقابل حدّه اليومي. «مُسندة»: المهام المُسندة للشخص الآن، ومنها ما هو لأيام قادمة. تُحسب المهمة لمن أُسندت إليه، أيًّا كان من أغلقها. المتأخرة: ما سُجّل عليه إنذار تأخير أو أُنجز بعد موعده. مدة الإنجاز من تسليم المهمة للشخص إلى إنجازها. النشر لا يُحسب مهمة.'
              : '"Today" is the work booked for the person today against their daily limit. "Assigned" counts every task the person holds now, including those for coming days. A task counts for the person it was assigned to, whoever closed it. Late means it earned a lateness strike or was finished after its deadline. Time to finish runs from hand-off to done. Publishing does not count as a task.'}
          </div>
        </div>
      )}
    </div>
  );
}

/** «٧ من ٧» / "7 of 7" — booked units against the daily limit. */
function ofLimit(units: number, capacity: number, isAr: boolean): string {
  return isAr
    ? `${num(round1(units), true)} من ${num(capacity, true)}`
    : `${num(round1(units), false)} of ${num(capacity, false)}`;
}

function PersonRow({
  p, isAr, onOpen,
}: {
  p: TeamKpiPerson;
  isAr: boolean;
  onOpen?: (userId: string) => void;
}) {
  const name = personName(p, isAr);
  const rate = onTimeRate(p);
  const tone = rate === null ? null : rateTone(rate);
  const withDeadline = p.done - p.done_no_deadline;
  const days = fullDays(p.days);
  const roles = p.roles
    .map((r) => ROLE_TEXT[r])
    .filter((r): r is { ar: string; en: string } => Boolean(r))
    .map((r) => (isAr ? r.ar : r.en))
    .join(' · ');

  const open = onOpen ? () => onOpen(p.user_id) : undefined;
  // Today against the daily limit — the number the operator sets («٧ في اليوم»).
  const loads = todayLoads(p.days);
  const main = loads[0];
  const over = Boolean(main && (main.capacity <= 0 ? main.units > 0 : main.units > main.capacity + 1e-6));
  const lateLine = [
    p.late_now > 0 ? (isAr ? `متأخرة ${num(p.late_now, true)}` : `${num(p.late_now, false)} late`) : null,
    p.blocked_now > 0 ? (isAr ? `معلّقة ${num(p.blocked_now, true)}` : `${num(p.blocked_now, false)} blocked`) : null,
  ].filter(Boolean).join(' · ');
  const assigned = p.open_now > 0
    ? (isAr
      ? `مُسندة: ${num(p.open_now, true)}${p.open_later > 0 ? ` · لأيام قادمة: ${num(p.open_later, true)}` : ''}`
      : `Assigned: ${num(p.open_now, false)}${p.open_later > 0 ? ` · for coming days: ${num(p.open_later, false)}` : ''}`)
    : (isAr ? 'لا مهام مُسندة' : 'Nothing assigned');

  return (
    <div className={`tk-row tk-person${open ? ' click' : ''}`} onClick={open}>
      <div className="tk-name">
        {open ? (
          <button
            type="button"
            className="tk-nm"
            onClick={(e) => { e.stopPropagation(); open(); }}
          >
            {name}
          </button>
        ) : (
          <div className="tk-nm">{name}</div>
        )}
        <div className="tk-rl">
          {roles}
          {open && <span className="tk-go">{isAr ? 'عرض المهام' : 'See tasks'}</span>}
        </div>
      </div>

      <Cell
        label={isAr ? 'اليوم' : 'Today'}
        value={main ? ofLimit(main.units, main.capacity, isAr) : '—'}
        valueTone={over ? 't-late' : undefined}
        sub={assigned}
      >
        {loads.slice(1).map((l) => (
          <div key={l.bucket} className="tk-s">
            {bucketLabel(l.bucket, isAr)} {ofLimit(l.units, l.capacity, isAr)}
          </div>
        ))}
        {lateLine && <div className="tk-s t-late">{lateLine}</div>}
      </Cell>
      <Cell
        label={isAr ? 'أُنجزت' : 'Finished'}
        value={num(p.done, isAr)}
        sub={p.done_late > 0
          ? (isAr ? `منها ${num(p.done_late, true)} متأخرة` : `${num(p.done_late, false)} late`)
          : undefined}
      />
      <Cell
        label={isAr ? 'في الوقت' : 'On time'}
        value={pct(rate, isAr)}
        valueTone={tone ? TONE_CLASS[tone] : undefined}
        sub={withDeadline > 0
          ? (isAr
            ? `${num(withDeadline - p.done_late, true)} من ${num(withDeadline, true)}`
            : `${num(withDeadline - p.done_late, false)} of ${num(withDeadline, false)}`)
          : (isAr ? 'لا شيء بموعد' : 'Nothing with a deadline')}
      >
        {rate !== null && tone && (
          <div className="tk-bar2" aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, rate))}%`, background: TONE_COLOR[tone] }} />
          </div>
        )}
      </Cell>
      <Cell
        label={isAr ? 'مدة الإنجاز' : 'Time to finish'}
        value={hoursLabel(p.median_hours, isAr)}
        sub={p.median_hours === null ? undefined : (isAr ? 'الوسيط' : 'median')}
      />
      <Cell
        label={isAr ? 'إنذارات' : 'Strikes'}
        value={num(p.strikes, isAr)}
        valueTone={p.strikes >= 4 ? 't-late' : undefined}
      />
      <Cell
        label={isAr ? 'محجوزة ٣٠ يومًا' : 'Booked, 30 days'}
        value={num(p.booked_items, isAr)}
        sub={[
          days.full > 0 ? (isAr ? `أيام ممتلئة: ${num(days.full, true)}` : `Full days: ${num(days.full, false)}`) : null,
          days.over > 0 ? (isAr ? `فوق الطاقة: ${num(days.over, true)}` : `Over the limit: ${num(days.over, false)}`) : null,
        ].filter(Boolean).join(' · ') || undefined}
        subTone={days.over > 0 ? 't-late' : undefined}
      />

      <Strip days={p.days} isAr={isAr} name={name} full={days.full} over={days.over} />
    </div>
  );
}

function Cell({
  label, value, sub, valueTone, subTone, children,
}: {
  label: string;
  value: string;
  sub?: string;
  valueTone?: string;
  subTone?: string;
  children?: ReactNode;
}) {
  return (
    <div className="tk-c">
      <div className="tk-cl">{label}</div>
      <div className={`tk-v${valueTone ? ` ${valueTone}` : ''}`}>{value}</div>
      {children}
      {sub && <div className={`tk-s${subTone ? ` ${subTone}` : ''}`}>{sub}</div>}
    </div>
  );
}

function Strip({
  days, isAr, name, full, over,
}: {
  days: TeamKpiDay[];
  isAr: boolean;
  name: string;
  full: number;
  over: number;
}) {
  return (
    <div
      className="tk-strip"
      role="img"
      aria-label={isAr
        ? `حمل ${name} للثلاثين يومًا القادمة — أيام ممتلئة: ${num(full, true)}، فوق الطاقة: ${num(over, true)}`
        : `${name}'s next 30 days: ${full} full, ${over} over the limit`}
    >
      {days.map((d, i) => (
        <span
          key={d.day}
          className={`tk-d lv-${dayLevel(d)}${i === 0 ? ' today' : ''}`}
          title={dayTitle(d, isAr)}
        />
      ))}
    </div>
  );
}
