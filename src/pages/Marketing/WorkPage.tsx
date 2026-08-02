/**
 * My work — design screen 02 (مهامي).
 *
 * The screen the writer and the editor live in. Three groups in this order:
 * late, yours today, someone else's — the third deliberately faded so nobody
 * chases a task that isn't theirs. Row buttons NAME the action («ابدئي
 * الكتابة», «جدولة»), not a generic «فتح» — the verb comes from the workflow
 * step itself.
 *
 * The «القادم إليك» band is NOT tasks: future steps for my role on in-flight
 * items, from each item's pinned path. It exists so the role can prepare
 * without their queue filling with work they cannot start yet (s36's note:
 * «قادم إليك ليست مهمة»).
 *
 * Below 760px this page becomes design screen 28's «اليوم»: the same groups
 * as full-width thumb cards — the late card red and unmissable above the fold,
 * one full-width verb button per card, and a thumb-scrolled chip filter bar
 * instead of dropdowns. Desktop rendering is untouched.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MosContentRow,
  MosRole,
  MosTask,
  MosUpcoming,
  ROLE_LABELS,
  fetchWork,
  isOverdue,
  statusLabel,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, KindCell, LoadError, PageHead, Pill, Skeleton } from './components/kit';
import { IconSearch } from './components/icons';
import { dayName, daysAgo, daysFromNow, num, shortDate } from './lib/format';
import './styles/mobile-m1.css';

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

/**
 * s28's late pill — «متأخرة يومين», with the mock's own dual forms rather
 * than the table pill's longer «استحقاق … · متأخر …» phrase.
 */
function lateBy(iso: string | null, isAr: boolean): string {
  const d = daysFromNow(iso);
  const n = d === null ? 0 : Math.max(0, -d);
  if (isAr) {
    if (n === 0) return 'متأخرة اليوم';
    if (n === 1) return 'متأخرة يومًا';
    if (n === 2) return 'متأخرة يومين';
    if (n <= 10) return `متأخرة ${num(n, true)} أيام`;
    return `متأخرة ${num(n, true)} يومًا`;
  }
  if (n === 0) return 'late today';
  return `${n} day${n === 1 ? '' : 's'} late`;
}

/**
 * The verb for a stage. An approval stage asks you to decide; a making stage
 * asks you to make. Anything unrecognised falls back to a plain open, which is
 * honest rather than wrong.
 */
function actionLabel(row: MosContentRow, isAr: boolean): string {
  const key = row.status_key;
  if (key.includes('approve') || key.includes('review')) return isAr ? 'مراجعة' : 'Review';
  if (key.includes('write') || key.includes('script') || key.includes('caption')) {
    return isAr ? 'ابدئي الكتابة' : 'Start writing';
  }
  if (key.includes('design') || key.includes('edit') || key.includes('montage')) {
    return isAr ? 'ابدئي التنفيذ' : 'Start work';
  }
  if (key.includes('schedule') || key.includes('publish')) return isAr ? 'جدولة' : 'Schedule';
  if (key.includes('shoot') || key.includes('footage') || key.includes('material')) {
    return isAr ? 'جهّزي المواد' : 'Gather material';
  }
  return isAr ? 'فتح' : 'Open';
}

export default function WorkPage() {
  const { isAr, typeLabel, projectName, setBadge, people } = useWorkspace();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const [rows, setRows] = useState<MosContentRow[]>([]);
  const [tasks, setTasks] = useState<MosTask[]>([]);
  const [upcoming, setUpcoming] = useState<MosUpcoming[]>([]);
  const [myRole, setMyRole] = useState<MosRole>('viewer');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  // s28's chip filters — a thumb bar, no dropdowns and no filter dialog.
  const [chipProject, setChipProject] = useState<string | null>(null);
  const [chipMine, setChipMine] = useState(false);
  const [chipVideo, setChipVideo] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWork('mine');
      setRows(res.content);
      setTasks(res.tasks);
      setUpcoming(res.upcoming ?? []);
      setMyRole(res.role);
      setBadge('mywork', res.content.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [setBadge]);

  useEffect(() => { void load(); }, [load]);

  const term = q.trim().toLowerCase();
  const filtered = useMemo(
    () => (term
      ? rows.filter((r) =>
          r.title.toLowerCase().includes(term) || (r.ref ?? '').toLowerCase().includes(term))
      : rows),
    [rows, term],
  );

  const late = filtered.filter((r) => isOverdue(r));
  const mine = filtered.filter((r) => !isOverdue(r) && r.owner_role === myRole);
  const others = filtered.filter((r) => !isOverdue(r) && r.owner_role !== myRole);

  const taskFor = (contentId: string): MosTask | undefined =>
    tasks.find((t) => t.content_id === contentId);

  /* ── s28 mobile: chips + card groups ─────────────────────────────────── */

  // The chip bar's project chips come from the live rows, «×»-removable when
  // active — the mock's «مينا ٥٢ ×» pattern.
  const chipProjects = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) if (r.project_id) seen.add(r.project_id);
    return [...seen];
  }, [rows]);

  const mobileRows = useMemo(
    () => rows.filter((r) =>
      (!chipProject || r.project_id === chipProject)
      && (!chipVideo || r.content_type_key === 'video')),
    [rows, chipProject, chipVideo],
  );

  // The late card is never filtered away by «لي» — it cannot be missed.
  const mLate = mobileRows.filter((r) => isOverdue(r));
  const mMine = mobileRows.filter((r) => !isOverdue(r) && r.owner_role === myRole);
  const mOthers = chipMine
    ? []
    : mobileRows.filter((r) => !isOverdue(r) && r.owner_role !== myRole);

  // «لدى سارة، ٣ أيام» — the person holding the item, else their role.
  const holderName = (r: MosContentRow): string => {
    const p = r.current_assignee_user_id
      ? people.find((x) => x.user_id === r.current_assignee_user_id)
      : undefined;
    if (p) {
      const n = (isAr ? p.name_ar : p.name_en) ?? p.name_ar ?? p.name_en ?? p.email;
      if (n) return n;
    }
    if (r.owner_role && ROLE_LABELS[r.owner_role]) {
      return isAr ? ROLE_LABELS[r.owner_role].ar : ROLE_LABELS[r.owner_role].en;
    }
    return isAr ? 'شخص آخر' : 'someone else';
  };

  // «P-022 · خطة سداد الثلاث غرف · اليوم» — the mine-card meta tail.
  const dueText = (r: MosContentRow): string => {
    const due = r.current_task_due_at ?? r.due_at;
    if (!due) return isAr ? 'بلا موعد' : 'no due date';
    return daysFromNow(due) === 0 ? (isAr ? 'اليوم' : 'today') : shortDate(due, isAr);
  };

  const isScheduleStep = (r: MosContentRow): boolean =>
    r.status_key.includes('schedule') || r.status_key.includes('publish');

  const Group = ({
    label, tone, items, faded,
  }: {
    label: string;
    tone: 'late' | 'now' | 'idle';
    items: MosContentRow[];
    faded?: boolean;
  }) => {
    if (items.length === 0) return null;
    return (
      <>
        {label && (
          <div
            className="lbl"
            style={{ marginBottom: 9, color: tone === 'late' ? 'var(--late)' : undefined }}
          >
            {label}
          </div>
        )}
        <div
          className="card"
          style={{
            marginBottom: 22,
            opacity: faded ? 0.72 : 1,
            borderColor: tone === 'late' ? 'color-mix(in srgb, var(--late) 38%, transparent)' : undefined,
          }}
        >
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                {items.map((r) => {
                  const task = taskFor(r.id);
                  const isMine = r.owner_role === myRole;
                  return (
                    <tr key={r.id} className="click" onClick={() => navigate(`/m/content/${r.id}`)}>
                      <td style={{ width: 38 }}>
                        <KindCell typeKey={r.content_type_key} />
                      </td>
                      <td>
                        <div className="ttl">{statusLabel(r, isAr)} — {r.title}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 3 }}>
                          <span className="ltr">{r.ref}</span> · {typeLabel(r.content_type_key)}
                          {r.project_id && <> · {projectName(r.project_id)}</>}
                          {task && task.round > 1 && (
                            <> · {isAr ? `الجولة ${num(task.round, true)}` : `round ${task.round}`}</>
                          )}
                        </div>
                      </td>
                      <td style={{ width: 190 }}>
                        {isOverdue(r) ? (
                          <Pill tone="late">
                            {isAr
                              ? `استحقاق ${shortDate(r.current_task_due_at ?? r.due_at, true)} · متأخر ${daysAgo(r.current_task_due_at ?? r.due_at, true)}`
                              : `due ${shortDate(r.current_task_due_at ?? r.due_at, false)} · ${daysAgo(r.current_task_due_at ?? r.due_at, false)} late`}
                          </Pill>
                        ) : (
                          <Pill tone={tone === 'idle' ? 'wait' : 'now'}>
                            {r.current_task_due_at
                              ? isAr
                                ? `الاستحقاق ${shortDate(r.current_task_due_at, true)}`
                                : `due ${shortDate(r.current_task_due_at, false)}`
                              : isAr ? 'بلا موعد' : 'no due date'}
                          </Pill>
                        )}
                      </td>
                      <td style={{ width: 130, textAlign: 'end' }}>
                        {isMine ? (
                          <span className={`btn btn-sm${faded ? ' btn-d' : ' btn-p'}`}>
                            {actionLabel(r, isAr)}
                          </span>
                        ) : (
                          <span className="btn btn-d btn-sm">{isAr ? 'عرض' : 'View'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  };

  const roleLabel = ROLE_LABELS[myRole] ? (isAr ? ROLE_LABELS[myRole].ar : ROLE_LABELS[myRole].en) : myRole;

  // s28's phone header: «اليوم» + «الخميس ٣٠ يوليو · ٤ مفتوحة، ١ متأخرة».
  const todayIso = new Date().toISOString();
  const mOpen = mMine.length + mLate.length;

  if (isMobile) {
    return (
      <>
        <PageHead
          title={isAr ? 'اليوم' : 'Today'}
          sub={isAr
            ? `${dayName(todayIso, true)} ${shortDate(todayIso, true)} · ${num(mOpen, true)} مفتوحة، ${num(mLate.length, true)} متأخرة`
            : `${dayName(todayIso, false)} ${shortDate(todayIso, false)} · ${mOpen} open, ${mLate.length} late`}
        />

        <div className="body">
          {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
          {loading && rows.length === 0 && <Skeleton rows={5} />}

          {rows.length > 0 && (
            <div className="m1-chips">
              {chipProjects.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`fbtn${chipProject === id ? ' on' : ''}`}
                  onClick={() => setChipProject((p) => (p === id ? null : id))}
                >
                  {projectName(id)}
                  {chipProject === id && <span className="x">×</span>}
                </button>
              ))}
              <button
                type="button"
                className={`fbtn${chipMine ? ' on' : ''}`}
                onClick={() => setChipMine((v) => !v)}
              >
                {isAr ? 'لي' : 'Mine'}
                {chipMine && <span className="x">×</span>}
              </button>
              <button
                type="button"
                className={`fbtn${chipVideo ? ' on' : ''}`}
                onClick={() => setChipVideo((v) => !v)}
              >
                {isAr ? 'فيديو' : 'Video'}
                {chipVideo && <span className="x">×</span>}
              </button>
            </div>
          )}

          {!loading && !error && mobileRows.length === 0 && upcoming.length === 0 && (
            <Empty
              title={isAr ? 'لا مهام مفتوحة لديك' : 'Nothing open for you'}
              body={isAr
                ? 'حين تصل خطوة إلى دورك ستظهر هنا مباشرة، مرتبة حسب الاستحقاق.'
                : 'When a stage reaches your role it appears here, ordered by what is due first.'}
            />
          )}

          {/* المتأخر بطاقة حمراء منفصلة فوق الطيّة، لا صفّ في قائمة (s28). */}
          {mLate.map((r) => {
            const task = taskFor(r.id);
            return (
              <div
                key={r.id}
                className="m1-card late2"
                style={{ marginTop: 4 }}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/m/content/${r.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/m/content/${r.id}`); }}
              >
                <span className="m1-pill late">
                  {lateBy(r.current_task_due_at ?? r.due_at, isAr)}
                </span>
                <div className="m1-t" style={{ marginTop: 9 }}>{statusLabel(r, isAr)}</div>
                <div className="m1-m">
                  <span className="ltr">{r.ref}</span> · {r.title}
                  {r.project_id && <> · {projectName(r.project_id)}</>}
                  {task && task.round > 1 && (
                    <>
                      <br />
                      {isAr ? `أُعيدت للجولة ${num(task.round, true)}` : `returned · round ${task.round}`}
                    </>
                  )}
                </div>
                {r.owner_role === myRole && (
                  <button
                    type="button"
                    className="m1-btn p sm"
                    onClick={(e) => { e.stopPropagation(); navigate(`/m/content/${r.id}`); }}
                  >
                    {actionLabel(r, isAr)}
                  </button>
                )}
              </div>
            );
          })}

          {mMine.length > 0 && (
            <div className="m1-lbl">{isAr ? 'مطلوب منكِ اليوم' : 'Yours today'}</div>
          )}
          {mMine.map((r, i) => (
            <div
              key={r.id}
              className={`m1-card${i === 0 ? ' hot' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/m/content/${r.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/m/content/${r.id}`); }}
            >
              <div className="m1-t">{statusLabel(r, isAr)}</div>
              <div className="m1-m">
                <span className="ltr">{r.ref}</span> · {r.title} · {dueText(r)}
              </div>
              <button
                type="button"
                className={`m1-btn sm${isScheduleStep(r) ? ' g' : ''}`}
                onClick={(e) => { e.stopPropagation(); navigate(`/m/content/${r.id}`); }}
              >
                {actionLabel(r, isAr)}
              </button>
            </div>
          ))}

          {/* «القادم إليك» — visible preparation, explicitly NOT tasks. */}
          {upcoming.length > 0 && (
            <>
              <div className="m1-lbl">
                {isAr ? 'القادم إليك — ليست مهامًا بعد' : 'Coming to you — not tasks yet'}
              </div>
              {upcoming.map((u) => (
                <div
                  key={`${u.content_id}:${u.step_key}`}
                  className="m1-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/m/content/${u.content_id}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/m/content/${u.content_id}`); }}
                >
                  <div className="m1-row">
                    <span className="m1-t" style={{ fontSize: 14 }}>
                      {isAr ? u.step_label_ar : u.step_label_en}
                    </span>
                    <Pill tone="idle">
                      {u.steps_away <= 1
                        ? isAr ? 'الخطوة التالية' : 'next step'
                        : isAr ? `بعد ${num(u.steps_away, true)} خطوات` : `${u.steps_away} steps away`}
                    </Pill>
                  </div>
                  <div className="m1-m">
                    <span className="ltr">{u.ref ?? ''}</span> · {u.title}
                  </div>
                </div>
              ))}
            </>
          )}

          {mOthers.length > 0 && (
            <div className="m1-lbl">{isAr ? 'بانتظار شخص آخر' : 'Waiting on someone else'}</div>
          )}
          {mOthers.map((r) => (
            <div
              key={r.id}
              className="m1-card faded"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/m/content/${r.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/m/content/${r.id}`); }}
            >
              <div className="m1-t" style={{ fontSize: 14 }}>
                <span className="ltr">{r.ref}</span>
                {' · '}
                {isAr
                  ? `لدى ${holderName(r)}، ${daysAgo(r.updated_at, true)}`
                  : `with ${holderName(r)}, ${daysAgo(r.updated_at, false)}`}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title={isAr ? 'مهامي' : 'My work'}
        sub={isAr
          ? `${roleLabel} · ${num(mine.length + late.length, true)} مفتوحة، ${num(late.length, true)} متأخرة`
          : `${roleLabel} · ${mine.length + late.length} open, ${late.length} late`}
      >
        <div className="seg">
          <button type="button" className="on">
            {isAr ? 'مهامي' : 'Mine'}
          </button>
          <button type="button" onClick={() => navigate('/m/team')}>
            {isAr ? 'الجميع' : 'Everyone'}
          </button>
        </div>
        <div className="search">
          <IconSearch />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isAr ? 'ابحث في مهامي' : 'Search my work'}
          />
        </div>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={5} />}

        {!loading && filtered.length === 0 && upcoming.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا مهام مفتوحة لديك' : 'Nothing open for you'}
            body={isAr
              ? 'حين تصل خطوة إلى دورك ستظهر هنا مباشرة، مرتبة حسب الاستحقاق.'
              : 'When a stage reaches your role it appears here, ordered by what is due first.'}
          />
        )}

        <Group label={isAr ? 'متأخر · ابدئي بهذا' : 'Late · start here'} tone="late" items={late} />
        <Group label={isAr ? 'مطلوب منكِ اليوم' : 'Yours today'} tone="now" items={mine} />

        {/* «القادم إليك» — visible preparation, explicitly NOT tasks. */}
        {upcoming.length > 0 && (
          <>
            <div className="lbl" style={{ marginBottom: 9 }}>
              {isAr ? 'القادم إليك — ليست مهامًا بعد' : 'Coming to you — not tasks yet'}
            </div>
            <div className="card" style={{ marginBottom: 22 }}>
              <div className="card-b" style={{ padding: '10px 14px 12px' }}>
                <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.8, marginBottom: 8 }}>
                  {isAr
                    ? 'خطوات قادمة لدورك في محتوى يعمل عليه غيرك الآن — تظهر هنا لتستعد، وتنتقل إلى مهامك حين تصل إليك.'
                    : 'Upcoming steps for your role on items others are working on now — shown so you can prepare; they become tasks when they reach you.'}
                </div>
                {upcoming.map((u) => (
                  <button
                    key={`${u.content_id}:${u.step_key}`}
                    type="button"
                    className="up-row"
                    onClick={() => navigate(`/m/content/${u.content_id}`)}
                  >
                    <span className="up-row-main">
                      <b className="ltr">{u.ref ?? ''}</b>
                      {' · '}
                      {u.title}
                      {' · '}
                      <span style={{ color: 'var(--ink-2)' }}>
                        {isAr ? u.step_label_ar : u.step_label_en}
                      </span>
                    </span>
                    <Pill tone="idle">
                      {u.steps_away <= 1
                        ? isAr ? 'قادم إليك · الخطوة التالية' : 'next step'
                        : isAr ? `قادم إليك · بعد ${num(u.steps_away, true)} خطوات` : `${u.steps_away} steps away`}
                    </Pill>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <Group
          label={isAr ? 'بانتظار شخص آخر — لا إجراء منكِ' : 'Waiting on someone else — no action from you'}
          tone="idle"
          items={others}
          faded
        />
      </div>
    </>
  );
}
