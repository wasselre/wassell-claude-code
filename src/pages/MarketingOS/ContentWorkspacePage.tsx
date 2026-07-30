/**
 * Content workspace — design screens 6 to 10.
 *
 * Opening a content item lands here. One request fetches the item, its task
 * chain, its scenes and its workflow steps; the tabs are local state, not routes,
 * so switching tabs costs nothing. That is the direct fix for "it always
 * reloads" — the previous module refetched per tab.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, ArrowLeft } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  completeTask,
  fetchBootstrap,
  fetchContentDetail,
  isOverdue,
  statusLabel,
  MosContentRow,
  MosRole,
  MosScene,
  MosStep,
  MosTask,
  PURPOSE_LABELS,
  ROLE_LABELS,
} from '@/lib/marketingOS/client';
import StageRail from './components/StageRail';
import TaskPanel from './components/TaskPanel';
import ContentFields from './components/ContentFields';
import SceneEditor from './components/SceneEditor';
import PublishingTab from './components/PublishingTab';

type Tab = 'overview' | 'content' | 'scenes' | 'publishing' | 'tasks';

export default function ContentWorkspacePage() {
  const { contentId } = useParams<{ contentId: string }>();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);

  const [item, setItem] = useState<MosContentRow | null>(null);
  const [tasks, setTasks] = useState<MosTask[]>([]);
  const [scenes, setScenes] = useState<MosScene[]>([]);
  const [steps, setSteps] = useState<MosStep[]>([]);
  const [myRole, setMyRole] = useState<MosRole>('viewer');
  const [fieldSchema, setFieldSchema] = useState<string[]>([]);

  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!contentId) return;
    setLoading(true);
    setError(null);
    try {
      const [detail, boot] = await Promise.all([fetchContentDetail(contentId), fetchBootstrap()]);
      setItem(detail.item);
      setTasks(detail.tasks);
      setScenes(detail.scenes);
      setSteps(detail.steps);
      setMyRole(boot.role);
      // The type's field_schema decides which writing surfaces this item shows.
      const t = boot.content_types.find((c) => c.key === detail.item.content_type_key);
      setFieldSchema(Array.isArray(t?.field_schema) ? t!.field_schema : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [contentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openTask = useMemo(() => tasks.find((t) => t.status === 'open') ?? null, [tasks]);
  const openStep = useMemo(
    () => (openTask ? steps.find((s) => s.id === openTask.step_id) ?? null : null),
    [openTask, steps],
  );

  // Writing surfaces and scenes are editable only by whoever owns the open
  // step — plus the manager and admins, who carry every capability. RLS is the
  // real gate; this just avoids showing a field that will be refused on save.
  const canEditNow =
    myRole === 'administrator' ||
    myRole === 'marketing_manager' ||
    (openStep !== null && myRole === openStep.role);

  const onComplete = async (
    result: 'submitted' | 'approved' | 'changes_requested',
    note?: string,
  ) => {
    if (!openTask) return;
    setBusy(true);
    try {
      await completeTask(openTask.id, result, note);
      addToast(
        result === 'approved'
          ? isAr ? 'تم الاعتماد وفُتحت المرحلة التالية' : 'Approved — next stage opened'
          : result === 'changes_requested'
            ? isAr ? 'أُعيدت مع ملاحظة' : 'Sent back with a note'
            : isAr ? 'أُرسلت للمرحلة التالية' : 'Submitted to the next stage',
        'success',
      );
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const fmt = (v: string | null): string => {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl p-10 text-center text-sm text-charcoal/50">
        {isAr ? 'جارٍ التحميل…' : 'Loading…'}
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error ?? (isAr ? 'العنصر غير موجود.' : 'Item not found.')}
        </div>
        <button
          type="button"
          onClick={() => navigate('/marketing-management')}
          className="mt-3 text-sm text-copper underline"
        >
          {isAr ? 'العودة إلى المحتوى' : 'Back to content'}
        </button>
      </div>
    );
  }

  const late = isOverdue(item);
  const BackIcon = isAr ? ArrowRight : ArrowLeft;

  const TABS: Array<{ id: Tab; ar: string; en: string; count?: number }> = [
    { id: 'overview', ar: 'نظرة عامة', en: 'Overview' },
    { id: 'content', ar: 'المحتوى', en: 'Content' },
    { id: 'scenes', ar: 'المشاهد', en: 'Scenes', count: scenes.length },
    { id: 'publishing', ar: 'النشر', en: 'Publishing' },
    { id: 'tasks', ar: 'المهام', en: 'Tasks', count: tasks.length },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      {/* header */}
      <div>
        <button
          type="button"
          onClick={() => navigate('/marketing-management')}
          className="mb-2 flex items-center gap-1.5 text-xs text-charcoal/50 hover:text-copper"
        >
          <BackIcon className="h-3.5 w-3.5" />
          {isAr ? 'المحتوى' : 'Content'}
        </button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-mono text-xs text-charcoal/50" dir="ltr">
              {item.ref}
            </div>
            <h1 className="mt-0.5 text-2xl font-bold">{item.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-cream px-2 py-1">
                {isAr ? item.content_type_label_ar : item.content_type_label_en}
              </span>
              <span className="rounded bg-cream px-2 py-1">
                {PURPOSE_LABELS[item.purpose]
                  ? isAr
                    ? PURPOSE_LABELS[item.purpose]!.ar
                    : PURPOSE_LABELS[item.purpose]!.en
                  : item.purpose}
              </span>
              <span className="rounded bg-copper/15 px-2 py-1 font-semibold text-copper">
                {statusLabel(item, isAr)}
              </span>
              {item.owner_role && (
                <span className="text-charcoal/60">
                  {isAr ? 'لدى ' : 'with '}
                  <b>{isAr ? ROLE_LABELS[item.owner_role].ar : ROLE_LABELS[item.owner_role].en}</b>
                </span>
              )}
              {late && (
                <span className="font-bold text-red-700">
                  {isAr ? 'متأخر' : 'Overdue'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* tabs */}
        <div className="mt-4 flex gap-1 border-b border-sand">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm ${
                tab === t.id
                  ? 'border-b-2 border-copper font-bold text-copper'
                  : 'text-charcoal/55 hover:text-charcoal'
              }`}
            >
              {isAr ? t.ar : t.en}
              {t.count !== undefined && t.count > 0 && (
                <span className="ms-1.5 rounded-full bg-copper/15 px-1.5 text-[10px] font-bold text-copper">
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
        <div className="space-y-4">
          {tab === 'overview' && (
            <>
              <TaskPanel
                task={openTask}
                step={openStep}
                myRole={myRole}
                isAr={isAr}
                busy={busy}
                onComplete={(r, n) => void onComplete(r, n)}
              />

              <div className="rounded-xl border border-sand bg-white p-5">
                <h3 className="mb-3 text-xs font-bold text-charcoal/50">
                  {isAr ? 'الموجز' : 'Brief'}
                </h3>
                <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                  <Field
                    label={isAr ? 'المشروع' : 'Project'}
                    value={item.project_id ? item.project_id.slice(0, 8) : '—'}
                  />
                  <Field label={isAr ? 'الاستحقاق' : 'Due'} value={fmt(item.due_at)} />
                  <Field label={isAr ? 'النشر المستهدف' : 'Target publish'} value={fmt(item.target_publish_at)} />
                  <Field label={isAr ? 'آخر تحديث' : 'Last updated'} value={fmt(item.updated_at)} />
                </dl>
              </div>
            </>
          )}

          {tab === 'content' && (
            <ContentFields
              contentId={item.id}
              schema={fieldSchema}
              data={(item as unknown as { data?: Record<string, unknown> }).data ?? {}}
              canEdit={canEditNow}
              isAr={isAr}
              onSaved={(d) =>
                setItem((prev) =>
                  prev ? ({ ...prev, data: d } as unknown as MosContentRow) : prev,
                )
              }
            />
          )}

          {tab === 'scenes' && (
            <SceneEditor
              contentId={item.id}
              scenes={scenes}
              canEdit={canEditNow}
              isAr={isAr}
              onChange={setScenes}
            />
          )}

          {tab === 'publishing' && <PublishingTab contentId={item.id} isAr={isAr} />}

          {tab === 'tasks' && (
            <div className="overflow-hidden rounded-xl border border-sand bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-sand bg-cream/50 text-xs text-charcoal/60">
                    <th className="p-3 text-start font-semibold">{isAr ? 'المرحلة' : 'Stage'}</th>
                    <th className="p-3 text-start font-semibold">{isAr ? 'الدور' : 'Role'}</th>
                    <th className="p-3 text-start font-semibold">{isAr ? 'الجولة' : 'Round'}</th>
                    <th className="p-3 text-start font-semibold">{isAr ? 'النتيجة' : 'Result'}</th>
                    <th className="p-3 text-start font-semibold">{isAr ? 'الملاحظة' : 'Note'}</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => {
                    const st = steps.find((s) => s.id === t.step_id);
                    return (
                      <tr key={t.id} className="border-b border-sand/50 last:border-0">
                        <td className="p-3">{st ? (isAr ? st.label_ar : st.label_en) : '—'}</td>
                        <td className="p-3 text-xs">{ROLE_LABELS[t.role] ? (isAr ? ROLE_LABELS[t.role].ar : ROLE_LABELS[t.role].en) : t.role}</td>
                        <td className="p-3 text-xs">{t.round}</td>
                        <td className="p-3 text-xs">
                          {t.status === 'open' ? (
                            <span className="rounded bg-copper px-2 py-1 font-semibold text-white">
                              {isAr ? 'مفتوحة' : 'Open'}
                            </span>
                          ) : t.result === 'approved' ? (
                            <span className="text-green-700">{isAr ? 'اعتُمدت' : 'Approved'}</span>
                          ) : t.result === 'changes_requested' ? (
                            <span className="text-red-700">{isAr ? 'طُلبت تعديلات' : 'Changes requested'}</span>
                          ) : (
                            <span className="text-charcoal/55">{isAr ? 'أُرسلت' : 'Submitted'}</span>
                          )}
                        </td>
                        <td className="p-3 text-xs text-charcoal/70">{t.note ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <StageRail steps={steps} tasks={tasks} isAr={isAr} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold text-charcoal/50">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}
