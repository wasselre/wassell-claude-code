/**
 * New content — design screen 05.
 *
 * The type you pick decides three things at once: the workflow, the ref prefix,
 * and who gets the first task. The panel at the bottom says all three out loud
 * BEFORE you commit — which workflow, which ref, whose queue the first task
 * lands in — because the whole promise of this module is that nothing lands
 * in nobody's queue. No silent automation.
 *
 * Two modes (added 2026-09-02):
 *  - «عنصر واحد» — the original single request.
 *  - «عدة عناصر» — a batch: one row per item (title + target date), sharing the
 *    type, projects, campaign and platforms. A fill helper mints N rows from a
 *    base title, a start date and a cadence («كل 3 أيام»). Every row goes
 *    through the SAME `content_create` action as a single request — the
 *    server's row-locked ref allocator numbers them, and each opens its own
 *    first task — so a batch is exactly N ordinary requests, nothing special
 *    on the server. Creation is sequential; a failure mid-batch stops, keeps
 *    the modal open with the un-created rows, and says how many landed.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import {
  MosStep,
  PLATFORM_LABELS,
  ROLE_LABELS,
  WorkflowDef,
  createContent,
  fetchCampaigns,
  fetchContentList,
  fetchSettings,
  savePublication,
  MosCampaign,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Field, Modal } from './kit';
import { kindIcon } from './icons';
import ProjectMultiSelect from './ProjectMultiSelect';
import { num, shortDate } from '../lib/format';

const PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'linkedin'] as const;

/** Upper bound on one batch — keeps a typo («200») from opening 200 tasks. */
const MAX_BULK_ROWS = 50;

type Mode = 'single' | 'bulk';

interface BulkRow {
  id: string;
  title: string;
  publishAt: string;
}

/** Screen 05's five platform chips. LinkedIn predates PLATFORM_LABELS. */
const PLATFORM_LOCAL: Record<string, { ar: string; en: string }> = {
  linkedin: { ar: 'لينكدإن', en: 'LinkedIn' },
};
const platformLabel = (key: string, isAr: boolean): string =>
  PLATFORM_LABELS[key]
    ? (isAr ? PLATFORM_LABELS[key].ar : PLATFORM_LABELS[key].en)
    : PLATFORM_LOCAL[key]
      ? (isAr ? PLATFORM_LOCAL[key].ar : PLATFORM_LOCAL[key].en)
      : key;

/**
 * `mos_content_types.prefix` is stored WITH its dash («P-»), and the allocator
 * emits «P-137». Older rows/seeds may carry a bare «P»; normalise both to the
 * bare stem so the preview never renders «P--001» (the bug until 2026-09-02).
 */
const refStem = (prefix: string): string => prefix.replace(/-+$/, '');

/** The ref the item will get («V-011») — the highest existing suffix + 1. */
function nextRef(prefix: string, refs: Array<string | null>): string {
  const stem = refStem(prefix);
  let max = 0;
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  for (const ref of refs) {
    const m = ref?.match(re);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `${stem}-${String(max + 1).padStart(3, '0')}`;
}

/** `YYYY-MM-DD` for an <input type="date">, from a local date. */
function dateInputValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Start date + n × cadence days, or '' when there is no start date. */
function shiftDate(start: string, days: number): string {
  if (!start) return '';
  const d = new Date(`${start}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + days);
  return dateInputValue(d);
}

const emptyRow = (): BulkRow => ({ id: uuid(), title: '', publishAt: '' });

export default function NewContentModal({
  onClose, onCreated, onCreatedMany, presetProject, presetCampaign,
}: {
  onClose: () => void;
  onCreated?: (id: string) => void;
  /**
   * Called once after a batch lands (with every created id). Without it the
   * modal falls back to the content list, which is the one place all of them
   * are visible at once.
   */
  onCreatedMany?: (ids: string[]) => void;
  presetProject?: string | null;
  presetCampaign?: string | null;
}) {
  const { contentTypes, projects, people, isAr } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('single');
  const [typeKey, setTypeKey] = useState(contentTypes[0]?.key ?? '');
  const [title, setTitle] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>(presetProject ? [presetProject] : []);
  const [campaignId, setCampaignId] = useState(presetCampaign ?? '');
  const [publishAt, setPublishAt] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(['instagram']);
  const [steps, setSteps] = useState<MosStep[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [campaigns, setCampaigns] = useState<MosCampaign[]>([]);
  const [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** «3 / 10» while a batch is being created. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Bulk mode — the rows, plus the fill helper's inputs.
  const [rows, setRows] = useState<BulkRow[]>(() => [emptyRow(), emptyRow(), emptyRow()]);
  const [baseTitle, setBaseTitle] = useState('');
  const [fillCount, setFillCount] = useState(5);
  const [fillStart, setFillStart] = useState('');
  const [fillEvery, setFillEvery] = useState(3);

  useEffect(() => {
    // Step counts and the first-task preview come from the live workflow, so the
    // promise the modal makes is the one the database will keep.
    void (async () => {
      try {
        const [s, c] = await Promise.all([fetchSettings(), fetchCampaigns()]);
        setSteps(s.steps);
        setWorkflows(s.workflows);
        setCampaigns(c.campaigns);
      } catch (e) {
        // Non-fatal: the modal still creates content, it just cannot preview the
        // workflow. Surfaced rather than swallowed.
        console.error('[marketing] workflow preview unavailable', e);
        addToast(
          isAr ? 'تعذّر عرض معاينة مسار العمل.' : 'Could not load the workflow preview.',
          'error',
        );
      }
    })();
  }, [addToast, isAr]);

  // The ref preview («V-011») follows the selected type: it is the next suffix
  // on that type's prefix, computed from the existing items of the type.
  useEffect(() => {
    if (!typeKey) return;
    const picked = contentTypes.find((t) => t.key === typeKey);
    if (!picked) return;
    // Post and carousel share «P-»: the allocator counts across BOTH, so the
    // preview must too, or picking «carousel» previews a number posts already used.
    const siblings = contentTypes.filter((t) => refStem(t.prefix) === refStem(picked.prefix));
    let cancelled = false;
    void (async () => {
      try {
        const lists = await Promise.all(
          siblings.map((t) => fetchContentList({ content_type_key: t.key, limit: 500 })),
        );
        if (!cancelled) setRefs(lists.flatMap((res) => res.content.map((r) => r.ref ?? '').filter(Boolean)));
      } catch (e) {
        // The preview degrades to the bare prefix; creation itself still works.
        console.error('[marketing] ref preview unavailable', e);
        if (!cancelled) setRefs([]);
      }
    })();
    return () => { cancelled = true; };
  }, [typeKey, contentTypes]);

  const type = contentTypes.find((t) => t.key === typeKey) ?? null;
  const workflow = workflows.find((w) => w.id === type?.workflow_id) ?? null;
  const typeSteps = useMemo(
    () => steps.filter((s) => s.workflow_id === type?.workflow_id).sort((a, b) => a.position - b.position),
    [steps, type],
  );
  const firstStep = typeSteps[0] ?? null;
  const dueAt = firstStep
    ? new Date(Date.now() + firstStep.due_days * 86_400_000).toISOString()
    : null;
  const refPreview = type ? nextRef(type.prefix, refs) : null;

  // Rows that will actually be created — blank titles are skipped, not errors,
  // so an unused trailing row never blocks the batch.
  const filledRows = useMemo(() => rows.filter((r) => r.title.trim()), [rows]);

  /** «V-011 … V-020» — the span the batch will occupy if nobody else creates one meanwhile. */
  const bulkRefSpan = useMemo(() => {
    if (!type || filledRows.length === 0) return null;
    const first = nextRef(type.prefix, refs);
    if (filledRows.length === 1) return first;
    const n = Number(first.slice(first.lastIndexOf('-') + 1));
    const last = `${refStem(type.prefix)}-${String(n + filledRows.length - 1).padStart(3, '0')}`;
    return `${first} … ${last}`;
  }, [type, refs, filledRows.length]);

  // «وكل مراجعة تذهب لمدير التسويق» — stated only when the path's approval
  // steps all land on one role; a mixed-review path stays silent rather than
  // simplify a lie.
  const approvalRole = useMemo(() => {
    const approvals = typeSteps.filter((s) => s.is_approval);
    if (approvals.length === 0) return null;
    const roles = new Set(approvals.map((s) => s.role));
    return roles.size === 1 ? approvals[0]?.role ?? null : null;
  }, [typeSteps]);

  // The mockup names a person («مريم»). We name one only when the first
  // step's role has exactly ONE holder — otherwise the role label is the
  // honest answer.
  const firstStepPerson = useMemo(() => {
    if (!firstStep) return null;
    const holders = people.filter((p) => p.roles.includes(firstStep.role));
    if (holders.length !== 1) return null;
    const p = holders[0];
    if (!p) return null;
    return isAr ? p.name_ar ?? p.name_en : p.name_en ?? p.name_ar;
  }, [firstStep, people, isAr]);

  const stepCount = (workflowId: string | null): number =>
    workflowId ? steps.filter((s) => s.workflow_id === workflowId).length : 0;

  /* ── bulk row editing ─────────────────────────────────────────────── */

  const updateRow = (id: string, patch: Partial<BulkRow>): void =>
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const removeRow = (id: string): void =>
    setRows((cur) => (cur.length > 1 ? cur.filter((r) => r.id !== id) : cur));

  const addRow = (): void =>
    setRows((cur) => (cur.length >= MAX_BULK_ROWS ? cur : [...cur, emptyRow()]));

  /**
   * The fill helper: mint `fillCount` rows «base 1 … base N», dated from the
   * start date every `fillEvery` days. It REPLACES the rows — the helper is
   * for starting a batch, the per-row inputs are for finishing it.
   */
  const fillRows = (): void => {
    const count = Math.min(MAX_BULK_ROWS, Math.max(1, Math.floor(fillCount) || 1));
    const every = Math.max(0, Math.floor(fillEvery) || 0);
    const base = baseTitle.trim();
    setRows(Array.from({ length: count }, (_, i) => ({
      id: uuid(),
      title: base ? `${base} ${num(i + 1, isAr)}` : '',
      publishAt: shiftDate(fillStart, i * every),
    })));
  };

  /* ── create ───────────────────────────────────────────────────────── */

  /** One ordinary request: the item, then a draft publication row per platform. */
  const createOne = async (rowTitle: string, rowPublishAt: string): Promise<{ id: string; ref: string }> => {
    const res = await createContent({
      title: rowTitle,
      content_type_key: typeKey,
      // Multi-project: the server derives the primary project_id from this.
      project_ids: projectIds,
      campaign_id: campaignId || null,
      target_publish_at: rowPublishAt ? new Date(rowPublishAt).toISOString() : null,
    });
    const id = res.item?.id;
    if (!id) throw new Error(isAr ? 'لم يُرجع الخادم معرّف العنصر.' : 'The server returned no item id.');
    // One publication row per platform, as drafts. Never a multi-select —
    // each platform gets its own caption, its own time and its own result.
    for (const platform of platforms) {
      await savePublication(id, { platform, status: 'draft' });
    }
    return { id, ref: res.item?.ref ?? '' };
  };

  const submitSingle = async (): Promise<void> => {
    if (!title.trim()) {
      addToast(isAr ? 'اكتب عنوانًا مبدئيًا.' : 'Give it a working title.', 'error');
      return;
    }
    setBusy(true);
    try {
      const { id, ref } = await createOne(title.trim(), publishAt);
      addToast(
        isAr ? `أُنشئ ${ref} وأُسندت المهمة الأولى.` : `Created ${ref} and assigned the first task.`,
        'success',
      );
      onClose();
      if (onCreated) onCreated(id);
      else navigate(`/m/content/${id}`);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submitBulk = async (): Promise<void> => {
    const todo = rows.filter((r) => r.title.trim());
    if (todo.length === 0) {
      addToast(isAr ? 'اكتب عنوانًا لعنصر واحد على الأقل.' : 'Give at least one row a title.', 'error');
      return;
    }
    setBusy(true);
    setProgress({ done: 0, total: todo.length });
    const createdIds: string[] = [];
    let failed: { row: BulkRow; error: unknown } | null = null;
    // Sequential on purpose: the ref allocator serializes anyway, and a stop on
    // the first failure leaves a clean «N created, M left» state to retry from.
    for (const row of todo) {
      try {
        const { id } = await createOne(row.title.trim(), row.publishAt);
        createdIds.push(id);
        setProgress({ done: createdIds.length, total: todo.length });
        // Drop the row that landed so a retry after a failure never re-creates it.
        setRows((cur) => {
          const rest = cur.filter((r) => r.id !== row.id);
          return rest.length > 0 ? rest : [emptyRow()];
        });
      } catch (e) {
        failed = { row, error: e };
        break;
      }
    }
    setBusy(false);
    setProgress(null);

    if (failed) {
      const f: { row: BulkRow; error: unknown } = failed;
      const msg = f.error instanceof Error ? f.error.message : String(f.error);
      console.error('[marketing] bulk content create stopped', { created: createdIds.length, row: f.row, error: f.error });
      addToast(
        isAr
          ? `أُنشئ ${num(createdIds.length, true)} من ${num(todo.length, true)} ثم توقّف عند «${f.row.title}»: ${msg}`
          : `Created ${createdIds.length} of ${todo.length}, then stopped at “${f.row.title}”: ${msg}`,
        'error',
      );
      // The modal stays open with the un-created rows so the operator can retry.
      return;
    }

    addToast(
      isAr
        ? `أُنشئ ${num(createdIds.length, true)} عناصر وأُسندت المهمة الأولى لكلٍّ منها.`
        : `Created ${createdIds.length} items and assigned each its first task.`,
      'success',
    );
    onClose();
    if (onCreatedMany) onCreatedMany(createdIds);
    else navigate('/m/content');
  };

  const submit = mode === 'bulk' ? submitBulk : submitSingle;

  const submitLabel = busy
    ? progress
      ? isAr
        ? `جارٍ الإنشاء ${num(progress.done, true)} / ${num(progress.total, true)}…`
        : `Creating ${progress.done} / ${progress.total}…`
      : isAr ? 'جارٍ الإنشاء…' : 'Creating…'
    : mode === 'bulk'
      ? isAr
        ? `إنشاء ${num(filledRows.length, true)} وإسناد`
        : `Create ${filledRows.length} and assign`
      : isAr ? 'إنشاء وإسناد' : 'Create and assign';

  return (
    <Modal
      title={isAr ? 'محتوى جديد' : 'New content'}
      sub={isAr
        ? 'مسار العمل والرقم والمهمة الأولى تُحدَّد تلقائيًا من النوع الذي تختاره.'
        : 'The workflow, the reference and the first task all follow from the type you pick.'}
      onClose={onClose}
      wide={mode === 'bulk'}
      footer={
        <>
          <span className="note">
            {isAr
              ? 'يُنشأ صفّا نشر كمسودة — واحد لكل منصة. يمكن تغيير الكابشن والتوقيت لكل منصة لاحقًا.'
              : 'One draft publication row per platform. Caption and timing are set per platform later.'}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-p"
            onClick={() => void submit()}
            disabled={busy || (mode === 'bulk' && filledRows.length === 0)}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="seg" role="tablist" aria-label={isAr ? 'عدد العناصر' : 'How many'}>
          <button
            type="button"
            className={mode === 'single' ? 'on' : ''}
            onClick={() => setMode('single')}
            disabled={busy}
          >
            {isAr ? 'عنصر واحد' : 'One item'}
          </button>
          <button
            type="button"
            className={mode === 'bulk' ? 'on' : ''}
            onClick={() => setMode('bulk')}
            disabled={busy}
          >
            {isAr ? 'عدة عناصر' : 'Several items'}
          </button>
        </div>
        {mode === 'bulk' && (
          <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
            {isAr
              ? 'كل صف يصبح طلب محتوى مستقلًا بمهمته الأولى — يتشارك النوع والمشروع والحملة والمنصات.'
              : 'Each row becomes its own content request with its own first task — type, project, campaign and platforms are shared.'}
          </span>
        )}
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 7 }}>{isAr ? 'النوع' : 'Type'}</div>
        <div className="pick2">
          {contentTypes.map((t) => {
            const Icon = kindIcon(t.key);
            const n = stepCount(t.workflow_id);
            return (
              <button
                key={t.id}
                type="button"
                className={`p2${typeKey === t.key ? ' on' : ''}`}
                onClick={() => setTypeKey(t.key)}
              >
                <Icon />
                <div className="n4">{isAr ? t.label_ar : t.label_en}</div>
                <div className="s4">
                  {n > 0
                    ? isAr ? `${num(n, true)} مراحل` : `${n} stages`
                    : isAr ? 'بلا مسار' : 'no workflow'}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {mode === 'single' ? (
        <Field label={isAr ? 'العنوان المبدئي' : 'Working title'}>
          <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {/* Fill helper — mints the rows; the table below is where they get finished. */}
          <div style={{ background: 'var(--sand-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '11px 13px', display: 'grid', gap: 9 }}>
            <div className="lbl">{isAr ? 'تعبئة سريعة' : 'Quick fill'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.4fr 1fr auto', gap: 9, alignItems: 'end' }}>
              <Field label={isAr ? 'العنوان الأساسي' : 'Base title'} hint={isAr ? 'يُرقَّم تلقائيًا' : 'numbered automatically'}>
                <input
                  className="inp"
                  value={baseTitle}
                  onChange={(e) => setBaseTitle(e.target.value)}
                  placeholder={isAr ? 'مثال: بوست أكنان 25' : 'e.g. Aknan 25 post'}
                  autoFocus
                />
              </Field>
              <Field label={isAr ? 'العدد' : 'Count'}>
                <input
                  type="number"
                  className="inp"
                  min={1}
                  max={MAX_BULK_ROWS}
                  value={fillCount}
                  onChange={(e) => setFillCount(Number(e.target.value))}
                />
              </Field>
              <Field label={isAr ? 'أول تاريخ نشر' : 'First publish date'} hint={isAr ? 'اختياري' : 'optional'}>
                <input type="date" className="inp" value={fillStart} onChange={(e) => setFillStart(e.target.value)} />
              </Field>
              <Field label={isAr ? 'كل (أيام)' : 'Every (days)'}>
                <input
                  type="number"
                  className="inp"
                  min={0}
                  value={fillEvery}
                  onChange={(e) => setFillEvery(Number(e.target.value))}
                />
              </Field>
              <button type="button" className="btn btn-d" onClick={fillRows} disabled={busy}>
                {isAr ? 'توليد الصفوف' : 'Fill rows'}
              </button>
            </div>
          </div>

          <div>
            <div className="lbl" style={{ marginBottom: 7, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{isAr ? 'العناصر' : 'Items'}</span>
              <span style={{ color: 'var(--mute)', fontWeight: 400 }}>
                {isAr
                  ? `${num(filledRows.length, true)} من ${num(rows.length, true)} صفوف بعنوان`
                  : `${filledRows.length} of ${rows.length} rows titled`}
              </span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>#</th>
                    <th>{isAr ? 'العنوان المبدئي' : 'Working title'}</th>
                    <th style={{ width: 170 }}>{isAr ? 'تاريخ النشر المستهدف' : 'Target publish date'}</th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id}>
                      <td className="num">{num(i + 1, isAr)}</td>
                      <td>
                        <input
                          className="inp"
                          value={r.title}
                          onChange={(e) => updateRow(r.id, { title: e.target.value })}
                          disabled={busy}
                        />
                      </td>
                      <td>
                        <input
                          type="date"
                          className="inp"
                          value={r.publishAt}
                          onChange={(e) => updateRow(r.id, { publishAt: e.target.value })}
                          disabled={busy}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-d btn-sm"
                          onClick={() => removeRow(r.id)}
                          disabled={busy || rows.length <= 1}
                          aria-label={isAr ? 'حذف الصف' : 'Remove row'}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 7 }}>
              <button
                type="button"
                className="btn btn-d btn-sm"
                onClick={addRow}
                disabled={busy || rows.length >= MAX_BULK_ROWS}
              >
                {isAr ? '+ إضافة صف' : '+ Add row'}
              </button>
              {rows.length >= MAX_BULK_ROWS && (
                <span style={{ fontSize: 11.5, color: 'var(--mute)', marginInlineStart: 8 }}>
                  {isAr ? `الحد الأقصى ${num(MAX_BULK_ROWS, true)} عنصرًا في الدفعة.` : `At most ${MAX_BULK_ROWS} items per batch.`}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المشروع' : 'Project'} hint={isAr ? 'اختياري · متعدد' : 'optional · multiple'}>
          <ProjectMultiSelect
            projects={projects}
            value={projectIds}
            onChange={setProjectIds}
            isAr={isAr}
          />
        </Field>
        <Field label={isAr ? 'الحملة' : 'Campaign'} hint={isAr ? 'اختياري' : 'optional'}>
          <select className="inp" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">{isAr ? 'بدون' : 'None'}</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
      </div>

      {mode === 'single' && (
        <Field label={isAr ? 'تاريخ النشر المستهدف' : 'Target publish date'}>
          <input type="date" className="inp" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} />
        </Field>
      )}

      <div>
        {/* The organic starting point — a draft publication per platform. Whether
            the creative also runs paid is decided later, per placement. */}
        <div className="lbl" style={{ marginBottom: 7 }}>{isAr ? 'أين سيُنشر عضويًا' : 'Where it posts (organic)'}</div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {PLATFORMS.map((p) => (
            <button
              key={p}
              type="button"
              className={`fbtn${platforms.includes(p) ? ' on' : ''}`}
              onClick={() => setPlatforms((cur) =>
                cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p])}
            >
              {platformLabel(p, isAr)}
            </button>
          ))}
        </div>
      </div>

      <div style={{ background: 'var(--sand-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '11px 13px' }}>
        <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.9 }}>
          {firstStep ? (
            <>
              <b style={{ color: 'var(--ink)', fontWeight: 700 }}>
                {workflow ? (isAr ? workflow.label_ar : workflow.label_en) : isAr ? type?.label_ar : type?.label_en}
              </b>
              {' — '}
              {isAr ? `${num(typeSteps.length, true)} مراحل` : `${typeSteps.length} stages`}
              {approvalRole && (
                isAr
                  ? `، وكل مراجعة تذهب ل${ROLE_LABELS[approvalRole]?.ar ?? approvalRole}`
                  : `, every review goes to the ${ROLE_LABELS[approvalRole]?.en ?? approvalRole}`
              )}
              .
              <br />
              {isAr ? 'عند الإنشاء: ' : 'On create: '}
              <b style={{ color: 'var(--ink)', fontWeight: 700 }} className="ltr">
                {mode === 'bulk' ? (bulkRefSpan ?? refPreview) : refPreview}
              </b>
              {mode === 'bulk'
                ? isAr
                  ? ` · لكل عنصر مهمة أولى `
                  : ' · each item opens a first task '
                : isAr ? ' · المهمة الأولى ' : ' · first task '}
              <b style={{ color: 'var(--ink)', fontWeight: 700 }}>
                «{isAr ? firstStep.label_ar : firstStep.label_en}»
              </b>
              {isAr ? ' ← ' : ' → '}
              {firstStepPerson ?? (isAr ? ROLE_LABELS[firstStep.role]?.ar : ROLE_LABELS[firstStep.role]?.en)}
              {dueAt && <>{isAr ? '، الاستحقاق ' : ', due '}{shortDate(dueAt, isAr)}</>}
              {mode === 'bulk' && filledRows.length > 1 && (
                <>
                  {' '}
                  {isAr
                    ? `— أي ${num(filledRows.length, true)} مهام في قائمة الانتظار نفسها دفعة واحدة.`
                    : `— that is ${filledRows.length} tasks landing in the same queue at once.`}
                </>
              )}
            </>
          ) : (
            isAr
              ? 'هذا النوع بلا مسار عمل — سيُنشأ العنصر كمسودة بلا مهمة مفتوحة.'
              : 'This type has no workflow — the item will be created as a draft with no open task.'
          )}
        </div>
      </div>
    </Modal>
  );
}
