/**
 * My work (screen 02) and Team work (screen 35) — the same query, two scopes.
 *
 * Three groups in this order: late, yours now, someone else's. The third group
 * is deliberately faded so nobody chases a task that isn't theirs. Row buttons
 * NAME the action ("Start writing", "Schedule") rather than saying "Open" —
 * the verb comes from the workflow step itself.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MosContentRow,
  MosRole,
  MosTask,
  ROLE_LABELS,
  fetchWork,
  isOverdue,
  statusLabel,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, KindCell, LoadError, PageHead, Pill, RoleChip, Skeleton } from './components/kit';
import { IconSearch } from './components/icons';
import { daysAgo, num, shortDate } from './lib/format';

/**
 * The verb for a stage. An approval stage asks you to decide; a making stage
 * asks you to make. Anything unrecognised falls back to a plain open, which is
 * honest rather than wrong.
 */
function actionLabel(row: MosContentRow, isAr: boolean): string {
  const key = row.status_key;
  if (key.includes('approve') || key.includes('review')) return isAr ? 'مراجعة' : 'Review';
  if (key.includes('write') || key.includes('script') || key.includes('caption')) {
    return isAr ? 'ابدأ الكتابة' : 'Start writing';
  }
  if (key.includes('design') || key.includes('edit') || key.includes('montage')) {
    return isAr ? 'ابدأ التنفيذ' : 'Start work';
  }
  if (key.includes('schedule') || key.includes('publish')) return isAr ? 'جدولة' : 'Schedule';
  if (key.includes('shoot') || key.includes('footage') || key.includes('material')) {
    return isAr ? 'جهّز المواد' : 'Gather material';
  }
  return isAr ? 'فتح' : 'Open';
}

export default function WorkPage({ scope }: { scope: 'mine' | 'team' }) {
  const { isAr, typeLabel, projectName, setBadge } = useWorkspace();
  const navigate = useNavigate();

  const [rows, setRows] = useState<MosContentRow[]>([]);
  const [tasks, setTasks] = useState<MosTask[]>([]);
  const [myRole, setMyRole] = useState<MosRole>('viewer');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWork(scope);
      setRows(res.content);
      setTasks(res.tasks);
      setMyRole(res.role);
      if (scope === 'mine') setBadge('mywork', res.content.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope, setBadge]);

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
  const mine = filtered.filter((r) => !isOverdue(r) && (scope === 'team' || r.owner_role === myRole));
  const others = scope === 'mine'
    ? filtered.filter((r) => !isOverdue(r) && r.owner_role !== myRole)
    : [];

  const byRole = useMemo(() => {
    const m = new Map<string, MosContentRow[]>();
    for (const r of filtered) {
      const key = r.owner_role ?? 'none';
      const list = m.get(key) ?? [];
      list.push(r);
      m.set(key, list);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [filtered]);

  const taskFor = (contentId: string): MosTask | undefined =>
    tasks.find((t) => t.content_id === contentId);

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
                            {isAr ? 'متأخر ' : 'late by '}
                            {daysAgo(r.current_task_due_at ?? r.due_at, isAr)}
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
                        {scope === 'team' || r.owner_role === myRole ? (
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

  return (
    <>
      <PageHead
        title={scope === 'mine' ? (isAr ? 'مهامي' : 'My work') : (isAr ? 'متابعة الفريق' : 'Team work')}
        sub={scope === 'mine'
          ? isAr
            ? `${roleLabel} · ${num(rows.length, true)} مفتوحة، ${num(late.length, true)} متأخرة`
            : `${roleLabel} · ${rows.length} open, ${late.length} late`
          : isAr
            ? `${num(rows.length, true)} عنصرًا مفتوحًا عبر ${num(byRole.length, true)} أدوار`
            : `${rows.length} open items across ${byRole.length} roles`}
      >
        <div className="seg">
          <button type="button" className={scope === 'mine' ? 'on' : ''} onClick={() => navigate('/m/my-work')}>
            {isAr ? 'مهامي' : 'Mine'}
          </button>
          <button type="button" className={scope === 'team' ? 'on' : ''} onClick={() => navigate('/m/team')}>
            {isAr ? 'الجميع' : 'Everyone'}
          </button>
        </div>
        <div className="search">
          <IconSearch />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isAr ? 'ابحث بالعنوان أو الرقم' : 'Search by title or ref'}
          />
        </div>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={5} />}

        {!loading && filtered.length === 0 && !error && (
          <Empty
            title={scope === 'mine'
              ? isAr ? 'لا مهام مفتوحة لديك' : 'Nothing open for you'
              : isAr ? 'لا عمل مفتوح' : 'No open work'}
            body={scope === 'mine'
              ? isAr
                ? 'حين تصل خطوة إلى دورك ستظهر هنا مباشرة، مرتبة حسب الاستحقاق.'
                : 'When a stage reaches your role it appears here, ordered by what is due first.'
              : isAr
                ? 'لا يوجد عنصر تحت الإنتاج الآن.'
                : 'Nothing is in production right now.'}
          />
        )}

        {scope === 'mine' ? (
          <>
            <Group label={isAr ? 'متأخر · ابدأ بهذا' : 'Late · start here'} tone="late" items={late} />
            <Group label={isAr ? 'مطلوب منك' : 'Yours now'} tone="now" items={mine} />
            <Group
              label={isAr ? 'بانتظار شخص آخر — لا إجراء منك' : 'Waiting on someone else — no action from you'}
              tone="idle"
              items={others}
              faded
            />
          </>
        ) : (
          <>
            <Group label={isAr ? 'متأخر' : 'Late'} tone="late" items={late} />
            {byRole.map(([roleKey, items]) => {
              const open = items.filter((r) => !isOverdue(r));
              if (open.length === 0) return null;
              const label = ROLE_LABELS[roleKey as MosRole];
              return (
                <div key={roleKey}>
                  <div className="lbl" style={{ marginBottom: 9, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <RoleChip role={roleKey as MosRole} isAr={isAr} />
                    <span style={{ color: 'var(--mute)' }}>
                      {isAr
                        ? `${num(open.length, true)} مفتوحة`
                        : `${open.length} open`}
                    </span>
                    {!label && <span>{roleKey}</span>}
                  </div>
                  <Group label="" tone="now" items={open} />
                </div>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}
