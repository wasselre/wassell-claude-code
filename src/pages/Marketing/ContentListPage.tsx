/**
 * Content — design screens 03 (table) and 04 (board), and the EN mirror s18.
 *
 * One library with filters, not a page per format. Type is a COLUMN, which is
 * exactly what lets carousels and stories exist without anyone building a
 * screen for them. Stage and owner are read-only here: both are derived from
 * the open task, so this list can never disagree with the task queue.
 *
 * The board (s04) is the same records arranged by the selected workflow's
 * stage list — EVERY step gets a column, empty ones included, so a busy
 * column is visible next to a starved one. Cards move when a task is done,
 * never by drag: the stage is a result, not an input. The most crowded
 * column is marked as the bottleneck rather than left for a human to notice.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosContentRow,
  MosRole,
  PLATFORM_LABELS,
  ROLE_LABELS,
  WorkflowDef,
  deleteContent,
  fetchContentList,
  fetchSettings,
  isOverdue,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, KindCell, LoadError, PageHead, Skeleton, StatusPill } from './components/kit';
import NewContentModal from './components/NewContentModal';
import { IconPlus, IconSearch } from './components/icons';
import { daysAgo, initial, num, roleAvatarClass, shortDate } from './lib/format';

/** content_list decorates each row with the campaign name + target platforms. */
type ListRow = MosContentRow & { campaign_name?: string | null; platforms?: string[] };

const ROLES: MosRole[] = ['writer', 'montage', 'ops_supervisor', 'marketing_manager', 'ceo'];

const platformLabel = (key: string, isAr: boolean): string =>
  PLATFORM_LABELS[key] ? (isAr ? PLATFORM_LABELS[key].ar : PLATFORM_LABELS[key].en) : key;

/** «لدى» — the mockup's avatar carries the PERSON's initial, the text the role. */
function WhoCell({ row, isAr }: { row: ListRow; isAr: boolean }) {
  const { people } = useWorkspace();
  const role = row.owner_role;
  if (!role) return <span style={{ color: 'var(--mute)' }}>—</span>;
  const roleLabel = ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;
  const person = row.current_assignee_user_id
    ? people.find((p) => p.user_id === row.current_assignee_user_id)
    : undefined;
  const personName = person
    ? (isAr ? person.name_ar ?? person.name_en : person.name_en ?? person.name_ar)
    : null;
  return (
    <div className="who">
      <span className={`av ${roleAvatarClass(role)}`}>{initial(personName ?? roleLabel)}</span>
      {roleLabel}
    </div>
  );
}

export default function ContentListPage() {
  const { isAr, contentTypes, projects, people, typeLabel, projectName, can, setBadge } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [rows, setRows] = useState<ListRow[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  // Multi-select for bulk delete (table view).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const canDelete = can('delete_records');

  const view = params.get('view') === 'board' ? 'board' : 'table';
  const typeParam = params.get('type') ?? '';
  const statusSel = params.get('status') ?? '';
  const platformSel = params.get('platform') ?? '';
  const projectId = params.get('project') ?? '';
  const roleKey = params.get('role') ?? '';
  const campaignId = params.get('campaign') ?? '';
  const moreFilters = params.get('more') === '1';
  const wfParam = params.get('wf') ?? '';

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
      const [res, settings] = await Promise.all([
        fetchContentList({ limit: 500 }),
        fetchSettings(),
      ]);
      setRows(res.content as ListRow[]);
      setWorkflows(settings.workflows);
      setBadge('content', res.content.length);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [setBadge]);

  useEffect(() => { void load(); }, [load]);

  // Search is client-side on a list that is already loaded — typing stays
  // instant instead of firing a request per keystroke.
  const term = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    const types = typeParam.split(',').filter(Boolean);
    let list = rows;
    if (types.length > 0) list = list.filter((r) => types.includes(r.content_type_key));
    if (statusSel === 'production') {
      list = list.filter((r) => r.status_key !== 'done' && r.status_key !== 'draft');
    } else if (statusSel) {
      list = list.filter((r) => r.status_key === statusSel);
    }
    if (platformSel) list = list.filter((r) => (r.platforms ?? []).includes(platformSel));
    if (projectId) list = list.filter((r) => (r.project_ids ?? []).includes(projectId));
    if (campaignId) list = list.filter((r) => r.campaign_id === campaignId);
    if (roleKey) list = list.filter((r) => r.owner_role === roleKey);
    if (term) {
      list = list.filter((r) =>
        r.title.toLowerCase().includes(term) || (r.ref ?? '').toLowerCase().includes(term));
    }
    return list;
  }, [rows, typeParam, statusSel, platformSel, projectId, campaignId, roleKey, term]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const toggleAll = (): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filtered.forEach((r) => next.delete(r.id));
      else filtered.forEach((r) => next.add(r.id));
      return next;
    });
  };
  const toggleOne = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const bulkDelete = async (): Promise<void> => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const ok = window.confirm(isAr
      ? `حذف ${ids.length} عنصرًا نهائيًا؟ لا يمكن التراجع.`
      : `Permanently delete ${ids.length} item(s)? This cannot be undone.`);
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await deleteContent(ids);
      addToast(isAr ? `حُذف ${num(res.deleted, true)} عنصرًا.` : `Deleted ${res.deleted} item(s).`, 'success');
      setSelected(new Set());
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const inProduction = rows.filter((r) => r.status_key !== 'done' && r.status_key !== 'draft').length;
  const published = rows.filter((r) => r.status_key === 'done').length;

  /** The platform filter's options are the platforms the data actually uses. */
  const platformOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const p of r.platforms ?? []) set.add(p);
    return Array.from(set);
  }, [rows]);

  /** Campaign choices come from the rows themselves — no extra fetch. */
  const campaignOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.campaign_id && r.campaign_name) m.set(r.campaign_id, r.campaign_name);
    return Array.from(m.entries());
  }, [rows]);

  const campaignName = (id: string): string =>
    campaignOptions.find(([cid]) => cid === id)?.[1] ?? id.slice(0, 8);

  /* ── Board (s04) ─────────────────────────────────────────────────────── */

  // Default board path: the video workflow («مسار الفيديو» in the mockup);
  // any ?wf= choice wins, and the first workflow is the fallback.
  const defaultWfId = useMemo(() => {
    const video = contentTypes.find((t) => t.key === 'video');
    if (video?.workflow_id && workflows.some((w) => w.id === video.workflow_id)) {
      return video.workflow_id;
    }
    return workflows[0]?.id ?? '';
  }, [contentTypes, workflows]);
  const boardWfId = workflows.some((w) => w.id === wfParam) ? wfParam : defaultWfId;
  const boardWf = workflows.find((w) => w.id === boardWfId) ?? null;

  const boardItems = useMemo(() => {
    const typeKeys = new Set(
      contentTypes.filter((t) => t.workflow_id === boardWfId).map((t) => t.key),
    );
    return rows.filter((r) =>
      typeKeys.has(r.content_type_key) && r.status_key !== 'draft' && r.status_key !== 'done');
  }, [rows, contentTypes, boardWfId]);

  // Columns = the workflow's FULL stage list, empty stages included — an empty
  // column is information, not a rendering gap.
  const boardCols = useMemo(() => {
    if (!boardWf) return [] as Array<{ key: string; label: string; items: ListRow[] }>;
    const cols = boardWf.steps.map((s) => ({
      key: s.key,
      label: isAr ? s.label_ar : s.label_en,
      items: [] as ListRow[],
    }));
    const byKey = new Map(cols.map((c) => [c.key, c]));
    const unmatched: ListRow[] = [];
    for (const r of boardItems) {
      const col = byKey.get(r.status_key);
      if (col) col.items.push(r);
      else unmatched.push(r);
    }
    // An item whose step key no longer exists in the current definition still
    // gets a home — hiding it would make the board lie by omission.
    if (unmatched.length > 0) {
      cols.push({ key: '__other', label: isAr ? 'بلا مرحلة' : 'No stage', items: unmatched });
    }
    return cols;
  }, [boardWf, boardItems, isAr]);

  // The mockup's rule: the bottleneck is computed from the volume of work in
  // progress — the busiest column is marked, not left for a human to notice.
  // Deterministic: most items wins; ties break on overdue count, then on the
  // oldest due date. A column of one is a queue, not a bottleneck.
  const bottleneckKey = useMemo(() => {
    let best: { key: string; count: number; overdue: number; oldest: number } | null = null;
    for (const c of boardCols) {
      const count = c.items.length;
      if (count < 2) continue;
      const overdue = c.items.filter((r) => isOverdue(r)).length;
      const oldest = c.items.reduce((min, r) => {
        const iso = r.current_task_due_at ?? r.due_at;
        const t = iso ? new Date(iso).getTime() : Number.NaN;
        return Number.isFinite(t) && (min === 0 || t < min) ? t : min;
      }, 0);
      if (
        !best || count > best.count
        || (count === best.count && overdue > best.overdue)
        || (count === best.count && overdue === best.overdue
          && oldest > 0 && (best.oldest === 0 || oldest < best.oldest))
      ) {
        best = { key: c.key, count, overdue, oldest };
      }
    }
    return best?.key ?? null;
  }, [boardCols]);

  // «سارة هي نقطة الاختناق» — name the holder of the bottleneck column: the
  // most frequent assignee, falling back to the most frequent role.
  const bottleneckHolder = useMemo(() => {
    if (!bottleneckKey) return null;
    const col = boardCols.find((c) => c.key === bottleneckKey);
    if (!col) return null;
    const topKey = (entries: Array<[string, number]>): string | null =>
      entries.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const byUser = new Map<string, number>();
    for (const r of col.items) {
      if (r.current_assignee_user_id) {
        byUser.set(r.current_assignee_user_id, (byUser.get(r.current_assignee_user_id) ?? 0) + 1);
      }
    }
    const topUser = topKey(Array.from(byUser.entries()));
    if (topUser) {
      const p = people.find((x) => x.user_id === topUser);
      const name = p ? (isAr ? p.name_ar ?? p.name_en : p.name_en ?? p.name_ar) : null;
      if (name) return name;
    }
    const byRole = new Map<string, number>();
    for (const r of col.items) {
      if (r.owner_role) byRole.set(r.owner_role, (byRole.get(r.owner_role) ?? 0) + 1);
    }
    const topRole = topKey(Array.from(byRole.entries()));
    if (topRole && ROLE_LABELS[topRole as MosRole]) {
      return isAr ? ROLE_LABELS[topRole as MosRole].ar : ROLE_LABELS[topRole as MosRole].en;
    }
    return null;
  }, [bottleneckKey, boardCols, people, isAr]);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.user_id, p])), [people]);

  const boardSub = boardWf
    ? isAr
      ? `${boardWf.label_ar} · ${num(boardItems.length, true)} عناصر تحت الإنتاج`
      : `${boardWf.label_en} · ${boardItems.length} items in production`
    : undefined;

  return (
    <>
      <PageHead
        title={isAr ? 'المحتوى' : 'Content'}
        sub={view === 'board'
          ? boardSub
          : isAr
            ? `${num(rows.length, true)} عنصرًا · ${num(inProduction, true)} تحت الإنتاج · ${num(published, true)} منشور`
            : `${rows.length} items · ${inProduction} in production · ${published} published`}
      >
        {view === 'table' && (
          /* Types to filter this list; Enter widens the same term into a search
             across material and campaigns too (screen 44). */
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
              placeholder={isAr ? 'ابحث بالعنوان أو الرقم' : 'Search title or ID'}
            />
          </form>
        )}
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
        {view === 'board' && workflows.length > 0 && (
          <div className="seg">
            {workflows.map((w) => (
              <button
                key={w.id}
                type="button"
                className={w.id === boardWfId ? 'on' : ''}
                onClick={() => setParam('wf', w.id)}
              >
                {isAr ? w.label_ar : w.label_en}
              </button>
            ))}
          </div>
        )}
        {can('write_content') && (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            <IconPlus />
            {isAr ? 'محتوى جديد' : 'New content'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {view === 'table' && (
          <>
            <div className="filt">
              {/* Active advanced filters read as removable chips, like the
                  mockup's «مينا ٥٢ ×». */}
              {projectId && (
                <button type="button" className="fbtn on" onClick={() => setParam('project', '')}>
                  {projectName(projectId)}
                  <span className="x">×</span>
                </button>
              )}
              {campaignId && (
                <button type="button" className="fbtn on" onClick={() => setParam('campaign', '')}>
                  {campaignName(campaignId)}
                  <span className="x">×</span>
                </button>
              )}
              {roleKey && (
                <button type="button" className="fbtn on" onClick={() => setParam('role', '')}>
                  {isAr
                    ? ROLE_LABELS[roleKey as MosRole]?.ar ?? roleKey
                    : ROLE_LABELS[roleKey as MosRole]?.en ?? roleKey}
                  <span className="x">×</span>
                </button>
              )}

              {/* One chip per type — none selected means «النوع: الكل». */}
              {contentTypes.map((t) => {
                const types = typeParam.split(',').filter(Boolean);
                const on = types.includes(t.key);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`fbtn${on ? ' on' : ''}`}
                    onClick={() => setParam('type', on
                      ? types.filter((k) => k !== t.key).join(',')
                      : [...types, t.key].join(','))}
                  >
                    {isAr ? t.label_ar : t.label_en}
                    {on && <span className="x">×</span>}
                  </button>
                );
              })}

              <select className="fsel" value={statusSel} onChange={(e) => setParam('status', e.target.value)}>
                <option value="">{isAr ? 'الحالة: الكل' : 'Status: all'}</option>
                <option value="production">{isAr ? 'تحت الإنتاج' : 'In production'}</option>
                <option value="draft">{isAr ? 'مسودة' : 'Draft'}</option>
                <option value="done">{isAr ? 'منشور' : 'Published'}</option>
              </select>

              <select className="fsel" value={platformSel} onChange={(e) => setParam('platform', e.target.value)}>
                <option value="">{isAr ? 'المنصة: أي' : 'Platform: any'}</option>
                {platformOptions.map((p) => (
                  <option key={p} value={p}>{platformLabel(p, isAr)}</option>
                ))}
              </select>

              <button
                type="button"
                className={`fbtn${moreFilters ? ' on' : ''}`}
                style={moreFilters ? undefined : { borderStyle: 'dashed' }}
                onClick={() => setParam('more', moreFilters ? '' : '1')}
              >
                {isAr ? '+ تصفية' : '+ Add filter'}
              </button>

              <span style={{ marginInlineStart: 'auto', fontSize: 11.5, color: 'var(--mute)' }}>
                {isAr
                  ? `${num(filtered.length, true)} من ${num(rows.length, true)}`
                  : `${filtered.length} of ${rows.length}`}
              </span>
            </div>

            {moreFilters && (
              <div className="filt filt-more">
                <select className="fsel" value={projectId} onChange={(e) => setParam('project', e.target.value)}>
                  <option value="">{isAr ? 'المشروع: الكل' : 'Project: all'}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
                  ))}
                </select>
                <select className="fsel" value={roleKey} onChange={(e) => setParam('role', e.target.value)}>
                  <option value="">{isAr ? 'المسؤول: أي شخص' : 'Owner: anyone'}</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}</option>
                  ))}
                </select>
                <select className="fsel" value={campaignId} onChange={(e) => setParam('campaign', e.target.value)}>
                  <option value="">{isAr ? 'الحملة: أي' : 'Campaign: any'}</option>
                  {campaignOptions.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}

        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={8} />}

        {!loading && !error && view === 'table' && filtered.length === 0 && (
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

        {view === 'table' && canDelete && selected.size > 0 && (
          <div
            className="card"
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', marginBottom: 12 }}
          >
            <span style={{ fontWeight: 700 }}>
              {isAr ? `${num(selected.size, true)} محدد` : `${selected.size} selected`}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())} disabled={deleting}>
              {isAr ? 'إلغاء التحديد' : 'Clear'}
            </button>
            <button
              type="button"
              className="btn btn-d"
              style={{ marginInlineStart: 'auto' }}
              onClick={() => void bulkDelete()}
              disabled={deleting}
            >
              {deleting
                ? isAr ? 'جارٍ الحذف…' : 'Deleting…'
                : isAr ? `حذف (${num(selected.size, true)})` : `Delete (${selected.size})`}
            </button>
          </div>
        )}

        {!loading && view === 'table' && filtered.length > 0 && (
          <div className="card">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    {canDelete && (
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={allFilteredSelected}
                          onChange={toggleAll}
                          aria-label={isAr ? 'تحديد الكل' : 'Select all'}
                        />
                      </th>
                    )}
                    <th style={{ width: 64 }}>{isAr ? 'الرقم' : 'ID'}</th>
                    <th style={{ width: 78 }}>{isAr ? 'النوع' : 'Type'}</th>
                    <th>{isAr ? 'العنوان' : 'Title'}</th>
                    <th style={{ width: 112 }}>{isAr ? 'المشروع' : 'Project'}</th>
                    <th style={{ width: 134 }}>{isAr ? 'الحملة' : 'Campaign'}</th>
                    <th style={{ width: 140 }}>{isAr ? 'المرحلة' : 'Stage'}</th>
                    <th style={{ width: 104 }}>{isAr ? 'لدى' : 'With'}</th>
                    <th style={{ width: 88 }}>{isAr ? 'الاستحقاق' : 'Due'}</th>
                    <th style={{ width: 88 }}>{isAr ? 'النشر' : 'Publish'}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr
                      key={r.id}
                      className="click"
                      style={selected.has(r.id) ? { background: 'color-mix(in srgb, var(--copper) 9%, transparent)' } : undefined}
                      onClick={() => navigate(`/m/content/${r.id}`)}
                    >
                      {canDelete && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => toggleOne(r.id)}
                            aria-label={isAr ? 'تحديد العنصر' : 'Select item'}
                          />
                        </td>
                      )}
                      <td className="id">{r.ref ?? '—'}</td>
                      <td><KindCell typeKey={r.content_type_key} label={typeLabel(r.content_type_key)} /></td>
                      <td className="ttl">{r.title}</td>
                      <td>{(() => {
                        const ids = r.project_ids ?? [];
                        if (ids.length === 0) return '—';
                        const names = ids.map((id) => projectName(id));
                        if (names.length <= 2) return names.join(isAr ? '، ' : ', ');
                        return `${names.slice(0, 2).join(isAr ? '، ' : ', ')} +${num(names.length - 2, isAr)}`;
                      })()}</td>
                      <td style={{ color: r.campaign_name ? undefined : 'var(--mute)' }}>
                        {r.campaign_name ?? '—'}
                      </td>
                      <td><StatusPill row={r} isAr={isAr} /></td>
                      <td><WhoCell row={r} isAr={isAr} /></td>
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

        {!loading && !error && view === 'board' && !boardWf && (
          <Empty
            title={isAr ? 'لا يوجد مسار عمل بعد' : 'No workflow yet'}
            body={isAr
              ? 'اللوحة ترتّب العناصر على مراحل مسار العمل. أنشئ مسارًا من الإعدادات أولًا.'
              : 'The board arranges items along a workflow’s stages. Create a workflow in Settings first.'}
          />
        )}

        {!loading && view === 'board' && boardWf && (
          <div className="board">
            {boardCols.map((col) => (
              <div key={col.key} className={`col${col.key === bottleneckKey ? ' wip' : ''}`}>
                <div className="col-h">
                  <span className="nm">{col.label}</span>
                  <span className="ct">{num(col.items.length, isAr)}</span>
                </div>
                {col.items.length === 0 && (
                  <div className="col-empty">{isAr ? 'فارغ' : 'Empty'}</div>
                )}
                {col.items.map((r) => {
                  const due = r.current_task_due_at ?? r.due_at;
                  const late = isOverdue(r);
                  const role = r.owner_role;
                  const roleLabel = role
                    ? (ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role)
                    : '';
                  const person = r.current_assignee_user_id
                    ? peopleById.get(r.current_assignee_user_id)
                    : undefined;
                  const personName = person
                    ? (isAr ? person.name_ar ?? person.name_en : person.name_en ?? person.name_ar)
                    : null;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={`tile${late ? ' late' : ''}`}
                      onClick={() => navigate(`/m/content/${r.id}`)}
                    >
                      <div className="id2">{r.ref ?? '—'}</div>
                      <div className="t2">{r.title}</div>
                      <div className="f2">
                        {role ? (
                          <span className={`av ${roleAvatarClass(role)}`} title={roleLabel}>
                            {initial(personName ?? roleLabel)}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--mute)' }}>—</span>
                        )}
                        {late && due ? (
                          <span className="pill p-late tile-latepill">{daysAgo(due, isAr)}</span>
                        ) : (
                          <span className="dt">{shortDate(due, isAr)}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
                {col.key === bottleneckKey && bottleneckHolder && (
                  <div className="col-note">
                    {isAr
                      ? `${bottleneckHolder} — نقطة الاختناق`
                      : `${bottleneckHolder} — the bottleneck`}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && <NewContentModal onClose={() => setCreating(false)} />}
    </>
  );
}
