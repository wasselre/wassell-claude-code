/**
 * Content — design screens 03 (table) and 04 (board).
 *
 * One library with filters, not a page per format. Type is a COLUMN, which is
 * exactly what lets carousels and stories exist without anyone building a
 * screen for them. Stage and owner are read-only here: both are derived from
 * the open task, so this list can never disagree with the task queue.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  MosContentRow,
  MosRole,
  ROLE_LABELS,
  fetchContentList,
  isOverdue,
  statusLabel,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import {
  Empty, KindCell, LoadError, PageHead, RoleChip, Skeleton, StatusPill, rowTone,
} from './components/kit';
import NewContentModal from './components/NewContentModal';
import { IconPlus, IconSearch } from './components/icons';
import { num, shortDate } from './lib/format';

const ROLES: MosRole[] = ['writer', 'montage', 'ops_supervisor', 'marketing_manager', 'ceo'];

export default function ContentListPage() {
  const { isAr, contentTypes, projects, typeLabel, projectName, can, setBadge } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [rows, setRows] = useState<MosContentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');

  const view = params.get('view') === 'board' ? 'board' : 'table';
  const typeKey = params.get('type') ?? '';
  const projectId = params.get('project') ?? '';
  const roleKey = params.get('role') ?? '';
  const openOnly = params.get('open') === '1';

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchContentList({
        content_type_key: typeKey || undefined,
        project_id: projectId || undefined,
        role: roleKey || undefined,
      });
      setRows(res.content);
      setBadge('content', res.content.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [typeKey, projectId, roleKey, setBadge]);

  useEffect(() => { void load(); }, [load]);

  // Search is client-side on a list that is already filtered server-side —
  // typing stays instant instead of firing a request per keystroke.
  const term = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    let list = rows;
    if (openOnly) list = list.filter((r) => r.status_key !== 'done' && r.status_key !== 'draft');
    if (term) {
      list = list.filter((r) =>
        r.title.toLowerCase().includes(term) || (r.ref ?? '').toLowerCase().includes(term));
    }
    return list;
  }, [rows, term, openOnly]);

  const inProduction = rows.filter((r) => r.status_key !== 'done' && r.status_key !== 'draft').length;
  const done = rows.filter((r) => r.status_key === 'done').length;

  /* Board columns are the workflow stages actually present in the data, in the
     order the items are flowing — so a workflow change reshapes the board with
     no code change. */
  const columns = useMemo(() => {
    const m = new Map<string, { label: string; items: MosContentRow[] }>();
    for (const r of filtered) {
      const key = r.status_key;
      const label = statusLabel(r, isAr);
      const col = m.get(key) ?? { label, items: [] };
      col.items.push(r);
      m.set(key, col);
    }
    return Array.from(m.entries());
  }, [filtered, isAr]);

  const activeFilters = [typeKey, projectId, roleKey].filter(Boolean).length + (openOnly ? 1 : 0);

  return (
    <>
      <PageHead
        title={isAr ? 'المحتوى' : 'Content'}
        sub={isAr
          ? `${num(rows.length, true)} عنصرًا · ${num(inProduction, true)} تحت الإنتاج · ${num(done, true)} منجز`
          : `${rows.length} items · ${inProduction} in production · ${done} done`}
      >
        {/* Types to filter this list; Enter widens the same term into a search
            across material and campaigns too (screen 44). */}
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) navigate(`/m/search?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <IconSearch />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isAr ? 'ابحث بالعنوان أو الرقم' : 'Search by title or ref'}
          />
        </form>
        <div className="seg">
          <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setParam('view', '')}>
            {isAr ? 'جدول' : 'Table'}
          </button>
          <button type="button" className={view === 'board' ? 'on' : ''} onClick={() => setParam('view', 'board')}>
            {isAr ? 'لوحة' : 'Board'}
          </button>
          <button type="button" onClick={() => navigate('/m/calendar')}>
            {isAr ? 'تقويم' : 'Calendar'}
          </button>
        </div>
        {can('write_content') && (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            <IconPlus />
            {isAr ? 'محتوى جديد' : 'New content'}
          </button>
        )}
      </PageHead>

      <div className="body">
        <div className="filt">
          <button
            type="button"
            className={`fbtn${openOnly ? ' on' : ''}`}
            onClick={() => setParam('open', openOnly ? '' : '1')}
          >
            {isAr ? 'تحت الإنتاج' : 'In production'}
            {openOnly && <span className="x">×</span>}
          </button>

          <select className="fsel" value={typeKey} onChange={(e) => setParam('type', e.target.value)}>
            <option value="">{isAr ? 'النوع: الكل' : 'Type: all'}</option>
            {contentTypes.map((t) => (
              <option key={t.id} value={t.key}>{isAr ? t.label_ar : t.label_en}</option>
            ))}
          </select>

          <select className="fsel" value={projectId} onChange={(e) => setParam('project', e.target.value)}>
            <option value="">{isAr ? 'المشروع: الكل' : 'Project: all'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
            ))}
          </select>

          <select className="fsel" value={roleKey} onChange={(e) => setParam('role', e.target.value)}>
            <option value="">{isAr ? 'لدى: أي دور' : 'With: any role'}</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>{isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}</option>
            ))}
          </select>

          {activeFilters > 0 && (
            <button type="button" className="fbtn" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              {isAr ? 'مسح التصفية' : 'Clear filters'}
              <span className="x">×</span>
            </button>
          )}

          <span style={{ marginInlineStart: 'auto', fontSize: 11.5, color: 'var(--mute)' }}>
            {isAr
              ? `${num(filtered.length, true)} من ${num(rows.length, true)}`
              : `${filtered.length} of ${rows.length}`}
          </span>
        </div>

        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={8} />}

        {!loading && filtered.length === 0 && !error && (
          <Empty
            title={rows.length === 0
              ? isAr ? 'لا يوجد محتوى بعد' : 'No content yet'
              : isAr ? 'لا نتائج لهذه التصفية' : 'Nothing matches these filters'}
            body={rows.length === 0
              ? isAr
                ? 'ابدأ بأول عنصر. اختيار النوع يحدّد مسار العمل، والرقم، ومن تصل إليه المهمة الأولى.'
                : 'Start with the first item. Picking a type sets the workflow, the reference and who gets the first task.'
              : isAr
                ? 'جرّب مسح التصفية أو تغيير كلمة البحث.'
                : 'Try clearing the filters or changing the search.'}
          >
            {rows.length === 0 && can('write_content') && (
              <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
                <IconPlus />
                {isAr ? 'محتوى جديد' : 'New content'}
              </button>
            )}
          </Empty>
        )}

        {filtered.length > 0 && view === 'table' && (
          <div className="card">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                    <th style={{ width: 84 }}>{isAr ? 'النوع' : 'Type'}</th>
                    <th>{isAr ? 'العنوان' : 'Title'}</th>
                    <th style={{ width: 130 }}>{isAr ? 'المشروع' : 'Project'}</th>
                    <th style={{ width: 150 }}>{isAr ? 'المرحلة' : 'Stage'}</th>
                    <th style={{ width: 140 }}>{isAr ? 'لدى' : 'With'}</th>
                    <th style={{ width: 96 }}>{isAr ? 'الاستحقاق' : 'Due'}</th>
                    <th style={{ width: 96 }}>{isAr ? 'النشر' : 'Publish'}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="click" onClick={() => navigate(`/m/content/${r.id}`)}>
                      <td className="id">{r.ref ?? '—'}</td>
                      <td><KindCell typeKey={r.content_type_key} label={typeLabel(r.content_type_key)} /></td>
                      <td className="ttl">{r.title}</td>
                      <td>{r.project_id ? projectName(r.project_id) : '—'}</td>
                      <td><StatusPill row={r} isAr={isAr} /></td>
                      <td><RoleChip role={r.owner_role} isAr={isAr} /></td>
                      <td style={isOverdue(r) ? { color: 'var(--late)', fontWeight: 700 } : undefined}>
                        {shortDate(r.current_task_due_at ?? r.due_at, isAr)}
                      </td>
                      <td style={{ color: r.target_publish_at ? undefined : 'var(--mute)' }}>
                        {shortDate(r.target_publish_at, isAr)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {filtered.length > 0 && view === 'board' && (
          <div className="board">
            {columns.map(([key, col]) => (
              <div key={key} className={`col${col.items.some((r) => rowTone(r) === 'now') ? ' wip' : ''}`}>
                <div className="col-h">
                  <span className="nm">{col.label}</span>
                  <span className="ct">{num(col.items.length, isAr)}</span>
                </div>
                {col.items.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="tile"
                    onClick={() => navigate(`/m/content/${r.id}`)}
                  >
                    <div className="id2">{r.ref}</div>
                    <div className="t2">{r.title}</div>
                    <div className="f2">
                      <KindCell typeKey={r.content_type_key} />
                      <RoleChip role={r.owner_role} isAr={isAr} />
                      <span
                        className="dt"
                        style={isOverdue(r) ? { color: 'var(--late)', fontWeight: 700 } : undefined}
                      >
                        {shortDate(r.current_task_due_at ?? r.due_at, isAr)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && <NewContentModal onClose={() => setCreating(false)} />}
    </>
  );
}
