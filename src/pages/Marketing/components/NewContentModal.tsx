/**
 * New content — design screen 05.
 *
 * The type you pick decides three things at once: the workflow, the ref prefix,
 * and who gets the first task. The panel at the bottom says all three out loud
 * BEFORE you commit — which workflow, which ref, whose queue the first task
 * lands in — because the whole promise of this module is that nothing lands
 * in nobody's queue. No silent automation.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosStep,
  PLATFORM_LABELS,
  PURPOSE_LABELS,
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

/** The ref the item will get («V-011») — the highest existing suffix + 1. */
function nextRef(prefix: string, refs: Array<string | null>): string {
  let max = 0;
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  for (const ref of refs) {
    const m = ref?.match(re);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

export default function NewContentModal({
  onClose, onCreated, presetProject, presetCampaign,
}: {
  onClose: () => void;
  onCreated?: (id: string) => void;
  presetProject?: string | null;
  presetCampaign?: string | null;
}) {
  const { contentTypes, projects, people, isAr } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();

  const [typeKey, setTypeKey] = useState(contentTypes[0]?.key ?? '');
  const [title, setTitle] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>(presetProject ? [presetProject] : []);
  const [campaignId, setCampaignId] = useState(presetCampaign ?? '');
  const [purpose, setPurpose] = useState<'organic' | 'paid' | 'both'>('organic');
  const [publishAt, setPublishAt] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(['instagram']);
  const [steps, setSteps] = useState<MosStep[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [campaigns, setCampaigns] = useState<MosCampaign[]>([]);
  const [refs, setRefs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

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
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchContentList({ content_type_key: typeKey, limit: 500 });
        if (!cancelled) setRefs(res.content.map((r) => r.ref ?? '').filter(Boolean));
      } catch (e) {
        // The preview degrades to the bare prefix; creation itself still works.
        console.error('[marketing] ref preview unavailable', e);
        if (!cancelled) setRefs([]);
      }
    })();
    return () => { cancelled = true; };
  }, [typeKey]);

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

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      addToast(isAr ? 'اكتب عنوانًا مبدئيًا.' : 'Give it a working title.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await createContent({
        title: title.trim(),
        content_type_key: typeKey,
        // Multi-project: the server derives the primary project_id from this.
        project_ids: projectIds,
        campaign_id: campaignId || null,
        purpose,
        target_publish_at: publishAt ? new Date(publishAt).toISOString() : null,
      });
      const id = res.item?.id;

      // One publication row per platform, as drafts. Never a multi-select —
      // each platform gets its own caption, its own time and its own result.
      if (id && platforms.length > 0) {
        for (const platform of platforms) {
          await savePublication(id, { platform, status: 'draft' });
        }
      }
      addToast(
        isAr ? `أُنشئ ${res.item?.ref ?? ''} وأُسندت المهمة الأولى.` : `Created ${res.item?.ref ?? ''} and assigned the first task.`,
        'success',
      );
      onClose();
      if (id) {
        if (onCreated) onCreated(id);
        else navigate(`/m/content/${id}`);
      }
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'محتوى جديد' : 'New content'}
      sub={isAr
        ? 'مسار العمل والرقم والمهمة الأولى تُحدَّد تلقائيًا من النوع الذي تختاره.'
        : 'The workflow, the reference and the first task all follow from the type you pick.'}
      onClose={onClose}
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
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الإنشاء…' : 'Creating…') : isAr ? 'إنشاء وإسناد' : 'Create and assign'}
          </button>
        </>
      }
    >
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

      <Field label={isAr ? 'العنوان المبدئي' : 'Working title'}>
        <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>

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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'الغرض' : 'Purpose'}>
          <div className="seg" style={{ width: '100%' }}>
            {(['organic', 'paid', 'both'] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={purpose === p ? 'on' : ''}
                style={{ flex: 1, textAlign: 'center' }}
                onClick={() => setPurpose(p)}
              >
                {isAr ? PURPOSE_LABELS[p]?.ar : PURPOSE_LABELS[p]?.en}
              </button>
            ))}
          </div>
        </Field>
        <Field label={isAr ? 'تاريخ النشر المستهدف' : 'Target publish date'}>
          <input type="date" className="inp" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} />
        </Field>
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 7 }}>{isAr ? 'أين سيُنشر' : 'Where it goes'}</div>
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
              <b style={{ color: 'var(--ink)', fontWeight: 700 }} className="ltr">{refPreview}</b>
              {isAr ? ' · المهمة الأولى ' : ' · first task '}
              <b style={{ color: 'var(--ink)', fontWeight: 700 }}>
                «{isAr ? firstStep.label_ar : firstStep.label_en}»
              </b>
              {isAr ? ' ← ' : ' → '}
              {firstStepPerson ?? (isAr ? ROLE_LABELS[firstStep.role]?.ar : ROLE_LABELS[firstStep.role]?.en)}
              {dueAt && <>{isAr ? '، الاستحقاق ' : ', due '}{shortDate(dueAt, isAr)}</>}
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
