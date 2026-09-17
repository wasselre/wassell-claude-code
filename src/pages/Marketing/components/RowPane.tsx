/**
 * One row, loaded once, shown as whichever face its open task is at.
 *
 * This is the door every surface comes through — the queue card that expands in
 * place, and the permalink a notification hands you. Both mount THIS, so
 * «الصف — اعتماد» stopped being a place you go and became a thing that renders
 * where you already are.
 *
 * It owns exactly two jobs: one `row_detail` call, and choosing the face. The
 * faces themselves (`RowDesign`, `RowApproval`) take the loaded row and nothing
 * else, which is what lets the same approval component be mounted inline and
 * standalone with no simplified copy in between.
 *
 * The WRITING face is `RowWriter` — the approved «الصف — كتابة» screen: the
 * row's three posts side by side, their reading order, one pre-send check and
 * ONE send.
 *
 * Until 2026-09-16 this pane refused to render it ("the writer's surface is the
 * writing task's own screen … a second copy is the mistake §5.1 deletes") and
 * showed the row read-only with a link into each post. That reasoning did not
 * survive contact with the row model: the writing task's subject is the ROW, not
 * a post, and `content_detail` loads tasks with `subject_table = 'mos_content'`,
 * so a row member's own screen never sees an open task and is read-only for
 * EVERYONE — the writer included. Between the two, nobody could write a row at
 * all, and `RowWriter.tsx` had been built and never mounted.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MosMonthNote, fetchMonth } from '@/lib/marketingOS/client';
import { MosRowDetail, fetchItemDetail, fetchRowDetail, rowFaceOf } from '@/lib/marketingOS/rowClient';
import { useWorkspace } from '../MarketingWorkspace';
import { LoadError, Skeleton } from './kit';
import { stageIsMine } from '../lib/stagePhase';
import { contentHref } from '../lib/contentRoute';
import { shortDate } from '../lib/format';
import MonthBriefPanel from './MonthBriefPanel';
import { ProjectAssetsTab, ProjectInfoTab } from './ProjectPanels';
import RowApproval from './RowApproval';
import RowDesign from './RowDesign';
import RowWriter from './RowWriter';
import { CaptionBlock, PostLines, PostShell } from './RowParts';

export interface RowPaneProps {
  /** Address by row, or by the task id a notification carried. */
  rowId?: string | null;
  taskId?: string | null;
  /**
   * Address ONE content item instead — a paid creative or any single item,
   * shown through the same faces as a row of one (`item_detail`). Takes
   * precedence over `rowId` / `taskId`.
   */
  contentId?: string | null;
  /** Fired after anything moved, so the list behind the pane refreshes too. */
  onChanged?: () => void | Promise<void>;
  /** The resolved-brief panel, when the caller has one to mount. */
  brief?: React.ReactNode;
}

export default function RowPane({ rowId, taskId, contentId, onChanged, brief }: RowPaneProps) {
  const { isAr, roles, projectName } = useWorkspace();
  const [detail, setDetail] = useState<MosRowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The month's notes, for the resolved brief. A separate read because the
  // notes live on the MONTH GRID, not on the records — they are written before
  // the records exist, which is the whole point of them.
  const [notes, setNotes] = useState<MosMonthNote[] | null>(null);
  const [topicBank, setTopicBank] = useState<string[]>([]);
  const [notesError, setNotesError] = useState<string | null>(null);
  /*
   * THREE TABS, always at the top: the work itself, the project's information,
   * and the project's files. The operator (2026-09-16): a writer writing a row,
   * or a designer designing it, needs the project's facts and the project's
   * files every single time — and until now they only lived on the old per-post
   * content page, one post at a time. They are the SAME two panels that page
   * rendered (`ProjectInfoTab` / `ProjectAssetsTab`), mounted here, so there is
   * one implementation of each.
   *
   * Declared above every early return (hooks rule), and reset whenever the pane
   * is pointed at a different row, so opening the next row starts on the work.
   */
  const [pane, setPane] = useState<'work' | 'info' | 'files'>('work');
  useEffect(() => { setPane('work'); }, [rowId, taskId, contentId]);

  const load = useCallback(async () => {
    if (!contentId && !rowId && !taskId) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(contentId ? await fetchItemDetail(contentId) : await fetchRowDetail({ rowId, taskId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rowId, taskId, contentId]);

  useEffect(() => { void load(); }, [load]);

  // The month behind this row. Read once per row, keyed on the batch day's
  // month — a failure is SHOWN inside the panel («do not read this as none»),
  // never swallowed into an empty brief.
  const monthKey = detail?.row.batch_day ? detail.row.batch_day.slice(0, 7) : null;
  useEffect(() => {
    if (!monthKey) return undefined;
    let alive = true;
    setNotesError(null);
    fetchMonth(monthKey)
      .then((res) => {
        if (!alive) return;
        setNotes(res.notes ?? []);
        setTopicBank(res.template?.generalTopicBank ?? []);
      })
      .catch((e: unknown) => {
        console.error('[marketing] row brief — month notes unavailable', e);
        if (alive) setNotesError(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [monthKey]);

  const changed = useCallback(async () => {
    await load();
    if (onChanged) await onChanged();
  }, [load, onChanged]);

  if (loading && !detail) return <Skeleton rows={5} />;
  if (error && !detail) return <LoadError message={error} onRetry={() => void load()} isAr={isAr} />;
  if (!detail) return null;

  const face = rowFaceOf(detail.steps, detail.task?.step_id ?? null);
  const canAct = !!detail.task && stageIsMine(roles, detail.task.role);

  /**
   * The resolved brief. An organic row reads month → organic project column →
   * row cell (D7 — a paid note never reaches it), and the Saturday general row
   * has no project column at all, so its own cell note, then the topic bank, is
   * all it gets. The caller may override with its own node.
   */
  const briefNode = brief ?? (
    <MonthBriefPanel
      notes={notes ?? []}
      coord={{
        // A paid creative reads the PAID lane's notes (D7); everything else organic.
        lane: detail.row.kind === 'paid_creative' ? 'paid' : 'organic',
        projectId: detail.row.project_id,
        batchDate: detail.row.batch_day,
        projectName: detail.row.project_id ? projectName(detail.row.project_id) : null,
      }}
      topicBank={topicBank}
      isAr={isAr}
      loading={notes === null && !notesError}
      error={notesError}
      compact
    />
  );

  // The first tab is named for what this person is actually doing at this stage.
  const workLabel = face === 'writing'
    ? (isAr ? 'الكتابة' : 'Writing')
    : face === 'design'
      ? (isAr ? 'التصميم' : 'Design')
      : face === 'writing_review' || face === 'final_approval'
        ? (isAr ? 'الاعتماد' : 'Approval')
        : (isAr ? 'العمل' : 'Work');
  const projectId = detail.row.project_id;
  const tabs: Array<{ key: 'work' | 'info' | 'files'; label: string }> = [
    { key: 'work', label: workLabel },
    { key: 'info', label: isAr ? 'معلومات المشروع' : 'Project information' },
    { key: 'files', label: isAr ? 'ملفات المشروع' : 'Project files' },
  ];
  // The Saturday general row belongs to no project by design, so its project
  // tabs say so instead of rendering an empty panel that reads as "no data".
  const noProject = (
    <div className="card">
      <div className="card-b" style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.9 }}>
        {isAr
          ? 'هذا صف عام لا يخصّ مشروعًا بعينه، فلا معلومات ولا ملفات مشروع له.'
          : 'This is a general row that belongs to no project, so it has no project information or files.'}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={pane === t.key}
            className={pane === t.key ? 'on' : ''}
            onClick={() => setPane(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* A load failure AFTER the first successful read must still be seen —
          the pane keeps rendering what it has, and says what broke. */}
      {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}

      {pane === 'info' && (projectId ? <ProjectInfoTab projectId={projectId} isAr={isAr} /> : noProject)}
      {pane === 'files' && (projectId ? <ProjectAssetsTab projectId={projectId} isAr={isAr} /> : noProject)}

      {/*
        * The work stays MOUNTED while another tab is open — hidden, never
        * unmounted. The whole point of the project tabs is to glance at a fact
        * or a file mid-draft; unmounting the writer would throw away whatever
        * the writer had typed and not yet saved, at exactly that moment.
        */}
      <div style={{ display: pane === 'work' ? 'grid' : 'none', gap: 14 }}>
      {(face === 'writing_review' || face === 'final_approval') && (
        <RowApproval detail={detail} isAr={isAr} canAct={canAct} onChanged={changed} brief={briefNode} />
      )}

      {face === 'writing' && (
        <RowWriter detail={detail} isAr={isAr} canAct={canAct} onChanged={changed} brief={briefNode} />
      )}

      {face === 'design' && (
        <RowDesign detail={detail} isAr={isAr} canAct={canAct} onChanged={changed} brief={briefNode} />
      )}

      {face === 'other' && (
        <RowReadOnly detail={detail} isAr={isAr} brief={briefNode} />
      )}
      </div>
    </div>
  );
}

/**
 * A row with no stage this pane acts on — between stages, or already through
 * its chain. Everything is shown, nothing is acted on.
 */
function RowReadOnly({
  detail, isAr, brief,
}: { detail: MosRowDetail; isAr: boolean; brief?: React.ReactNode }) {
  const batchDay = detail.row.batch_day;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="card">
        <div className="card-h">
          <h4>
            {isAr
              ? `صف ${batchDay ? shortDate(batchDay, true) : 'بلا يوم'}`
              : `Row of ${batchDay ? shortDate(batchDay, false) : 'no day'}`}
          </h4>
          <span className="r">
            {detail.task
              ? (isAr ? 'لا مرحلة تُنفَّذ هنا' : 'no stage to act on here')
              : (isAr ? 'لا مهمة مفتوحة' : 'no open task')}
          </span>
        </div>
      </div>

      {brief}

      <div
        style={{
          display: 'grid', gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        }}
      >
        {detail.members.map((m, i) => (
          <PostShell
            key={m.id}
            member={m}
            index={i}
            total={detail.members.length}
            isAr={isAr}
            right={
              <Link className="btn btn-d btn-sm" to={contentHref(m, detail.steps)}>
                {isAr ? 'افتح المنشور' : 'Open the post'}
              </Link>
            }
          >
            <PostLines member={m} isAr={isAr} />
            <CaptionBlock member={m} isAr={isAr} />
          </PostShell>
        ))}
      </div>
    </div>
  );
}
