/**
 * New content — design screen 05.
 *
 * The type you pick decides three things at once: the workflow, the ref prefix,
 * and who gets the first task. The panel at the bottom says all three out loud
 * BEFORE you commit, because the whole promise of this module is that nothing
 * lands in nobody's queue.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosStep,
  PLATFORM_LABELS,
  PURPOSE_LABELS,
  ROLE_LABELS,
  createContent,
  fetchCampaigns,
  fetchSettings,
  savePublication,
  MosCampaign,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Field, Modal } from './kit';
import { kindIcon } from './icons';
import { num, shortDate } from '../lib/format';

const PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x'] as const;

export default function NewContentModal({
  onClose, onCreated, presetProject, presetCampaign,
}: {
  onClose: () => void;
  onCreated?: (id: string) => void;
  presetProject?: string | null;
  presetCampaign?: string | null;
}) {
  const { contentTypes, projects, isAr } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();

  const [typeKey, setTypeKey] = useState(contentTypes[0]?.key ?? '');
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState(presetProject ?? '');
  const [campaignId, setCampaignId] = useState(presetCampaign ?? '');
  const [purpose, setPurpose] = useState<'organic' | 'paid' | 'both'>('organic');
  const [publishAt, setPublishAt] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(['instagram']);
  const [steps, setSteps] = useState<MosStep[]>([]);
  const [campaigns, setCampaigns] = useState<MosCampaign[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Step counts and the first-task preview come from the live workflow, so the
    // promise the modal makes is the one the database will keep.
    void (async () => {
      try {
        const [s, c] = await Promise.all([fetchSettings(), fetchCampaigns()]);
        setSteps(s.steps);
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

  const type = contentTypes.find((t) => t.key === typeKey) ?? null;
  const typeSteps = useMemo(
    () => steps.filter((s) => s.workflow_id === type?.workflow_id).sort((a, b) => a.position - b.position),
    [steps, type],
  );
  const firstStep = typeSteps[0] ?? null;
  const dueAt = firstStep
    ? new Date(Date.now() + firstStep.due_days * 86_400_000).toISOString()
    : null;

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
        project_id: projectId || null,
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
              ? 'يُنشأ صفّ نشر كمسودة — واحد لكل منصة. الكابشن والتوقيت يُضبطان لكل منصة لاحقًا.'
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
        <Field label={isAr ? 'المشروع' : 'Project'}>
          <select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{isAr ? 'بدون' : 'None'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
            ))}
          </select>
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
              {isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en}
            </button>
          ))}
        </div>
      </div>

      <div style={{ background: 'var(--sand-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '11px 13px' }}>
        <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.9 }}>
          {firstStep ? (
            <>
              <b style={{ color: 'var(--ink)' }}>
                {isAr ? type?.label_ar : type?.label_en}
              </b>{' '}
              — {isAr ? `${num(typeSteps.length, true)} مراحل.` : `${typeSteps.length} stages.`}
              <br />
              {isAr ? 'عند الإنشاء: الرقم يبدأ بـ ' : 'On create: the ref starts with '}
              <b style={{ color: 'var(--ink)' }} className="ltr">{type?.prefix}</b>
              {isAr ? ' · المهمة الأولى ' : ' · first task '}
              <b style={{ color: 'var(--ink)' }}>«{isAr ? firstStep.label_ar : firstStep.label_en}»</b>
              {' → '}
              {isAr ? ROLE_LABELS[firstStep.role]?.ar : ROLE_LABELS[firstStep.role]?.en}
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
