/**
 * Write video script — the «اكتب سكربت» launcher (Script Writer v2).
 *
 * Shows the AUTO-FILLED brief the server built from the content item, its
 * campaign, audience, project, existing scenes and assets — so the operator
 * sees what the writer will work from before spending a job. Only three
 * things are choosable (recipe, duration, an optional objection to answer) and
 * one is editable (the audience line). No new mandatory fields.
 *
 * Generation runs in the BACKGROUND (the Fly worker's script lane): this modal
 * enqueues and closes; a staged progress bar sits over the scenes table, and
 * the result lands as a DRAFT for human review — never straight into the
 * scenes. If a draft is already pending, the server refuses (409) and we offer
 * the two honest ways out: open that draft, or discard it and regenerate.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Field, Modal, Pill, Skeleton } from './kit';
import {
  ScriptDraftPendingError, fetchScriptBrief, fetchScriptRecipes, writeVideoScript,
  type ScriptBrief, type ScriptJobRow, type ScriptRecipe, type ScriptRecipeKey,
} from '@/lib/marketingOS/client';
import { num } from '../lib/format';

const DURATIONS = [30, 45, 60, 90];

const PURPOSE_LABELS: Record<ScriptBrief['purpose'], { ar: string; en: string }> = {
  organic: { ar: 'عضوي', en: 'Organic' },
  paid:    { ar: 'مدفوع', en: 'Paid' },
  both:    { ar: 'عضوي ومدفوع', en: 'Organic + paid' },
  unknown: { ar: 'غير محدد', en: 'Unspecified' },
};

const FUNNEL_LABELS: Record<ScriptBrief['funnel'], { ar: string; en: string }> = {
  top:    { ar: 'أعلى القمع — وعي', en: 'Top of funnel — awareness' },
  mid:    { ar: 'وسط القمع — اهتمام', en: 'Mid funnel — consideration' },
  bottom: { ar: 'أسفل القمع — قرار', en: 'Bottom of funnel — decision' },
};

function BriefRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12.5, lineHeight: 1.7, padding: '4px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ flex: '0 0 130px', color: 'var(--mute)' }}>{label}</div>
      <div style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

export default function ScriptBriefModal({
  contentId, projectName, isAr, onClose, onStarted, onOpenDraft,
}: {
  contentId: string;
  /** Display name for brief.project_id (the modal has no project lookup of its own). */
  projectName: (id: string | null) => string;
  isAr: boolean;
  onClose: () => void;
  onStarted: (job: ScriptJobRow) => void;
  /** A draft is already pending — the parent loads it and shows the review. */
  onOpenDraft: (draftId: string | null) => void;
}) {
  const [brief, setBrief] = useState<ScriptBrief | null>(null);
  const [briefWarnings, setBriefWarnings] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<ScriptRecipe[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [recipe, setRecipe] = useState<ScriptRecipeKey>('');
  const [duration, setDuration] = useState<number>(45);
  const [audience, setAudience] = useState('');
  const [objection, setObjection] = useState('');

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDraftId, setPendingDraftId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([fetchScriptBrief(contentId), fetchScriptRecipes()])
      .then(([b, r]) => {
        if (!alive) return;
        setBrief(b.brief);
        setBriefWarnings(b.warnings ?? []);
        setRecipes(r.recipes);
        const rec = b.recommended_recipe || b.brief.recipe || r.recipes[0]?.key || '';
        setRecipe(rec);
        const def = r.recipes.find((x) => x.key === rec)?.default_duration_sec ?? b.brief.duration_sec;
        setDuration(DURATIONS.includes(def) ? def : 45);
        setAudience(b.brief.audience ?? '');
      })
      .catch((e: unknown) => { if (alive) setLoadError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [contentId]);

  const pickRecipe = (key: ScriptRecipeKey): void => {
    setRecipe(key);
    const def = recipes.find((x) => x.key === key)?.default_duration_sec;
    if (def && DURATIONS.includes(def)) setDuration(def);
  };

  const start = async (regenerate = false): Promise<void> => {
    if (!recipe) return;
    setStarting(true);
    setError(null);
    try {
      const r = await writeVideoScript(contentId, {
        recipe,
        duration_sec: duration,
        audience: audience.trim() || null,
        objection: objection.trim() || null,
        regenerate,
      });
      onStarted(r.job);
      onClose();
    } catch (e) {
      if (e instanceof ScriptDraftPendingError) {
        setPendingDraftId(e.draftId);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setStarting(false);
    }
  };

  const recipeLabel = (r: ScriptRecipe): string => (isAr ? r.label_ar : r.label_en);
  const platforms = brief?.platforms?.length ? brief.platforms.join(' · ') : '—';

  return (
    <Modal
      title={isAr ? 'اكتب سكربت الفيديو' : 'Write video script'}
      sub={isAr ? 'يتعلّم من فيديوهات المنافسين ويكتب بحقائق المشروع — النتيجة مسودة تراجعها قبل اعتمادها' : "Learns from competitors' videos, grounded in the project's facts — the result is a draft you review before it's applied"}
      onClose={onClose}
      wide
      footer={
        pendingDraftId !== undefined ? (
          <>
            <button type="button" className="btn" disabled={starting} onClick={() => setPendingDraftId(undefined)}>
              {isAr ? 'رجوع' : 'Back'}
            </button>
            <button type="button" className="btn" disabled={starting} onClick={() => void start(true)}>
              {isAr ? 'تجاهل المسودة وأعد الكتابة' : 'Discard it and regenerate'}
            </button>
            <button type="button" className="btn btn-p" disabled={starting} onClick={() => { onOpenDraft(pendingDraftId); onClose(); }}>
              {isAr ? 'افتح المسودة الحالية' : 'Open the pending draft'}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</button>
            <button type="button" className="btn btn-p" onClick={() => void start(false)} disabled={starting || loading || !recipe || !!loadError}>
              {starting ? (isAr ? 'يبدأ…' : 'Starting…') : (isAr ? 'ابدأ الكتابة' : 'Start writing')}
            </button>
          </>
        )
      }
    >
      {pendingDraftId !== undefined ? (
        <div className="notice">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {isAr ? 'توجد مسودة سكربت بانتظار المراجعة' : 'A script draft is already waiting for review'}
          </div>
          {isAr
            ? 'لا تُكتب مسودة جديدة فوق مسودة لم تُراجع. افتح المسودة الحالية لاعتمادها أو رفضها، أو تجاهلها وابدأ كتابة جديدة.'
            : "A new draft isn't written over one nobody has reviewed. Open the pending draft to apply or reject it, or discard it and start fresh."}
        </div>
      ) : loading ? (
        <Skeleton rows={6} />
      ) : loadError ? (
        <div className="notice bad" role="alert">{loadError}</div>
      ) : brief && (
        <>
          {(brief.multi_project_warning || briefWarnings.length > 0) && (
            <div className="notice" style={{ marginBottom: 12 }}>
              {brief.multi_project_warning && (
                <div>
                  {isAr
                    ? `هذا المحتوى مرتبط بأكثر من مشروع (${num(brief.project_ids.length, true)}) — سيُكتب السكربت عن ${projectName(brief.project_id)} فقط.`
                    : `This item is linked to ${brief.project_ids.length} projects — the script will be about ${projectName(brief.project_id)} only.`}
                </div>
              )}
              {briefWarnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 18 }}>
            {/* Left — what the writer already knows. */}
            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'الملخّص (تلقائي)' : 'Brief (auto-filled)'}</div>
              <BriefRow label={isAr ? 'المشروع' : 'Project'}>{projectName(brief.project_id)}</BriefRow>
              <BriefRow label={isAr ? 'الحملة' : 'Campaign'}>
                {brief.campaign ? brief.campaign.name : '—'}
                {brief.campaign?.offer && <span style={{ color: 'var(--mute)' }}> · {brief.campaign.offer}</span>}
              </BriefRow>
              <BriefRow label={isAr ? 'الغرض' : 'Purpose'}>
                {(() => { const p = PURPOSE_LABELS[brief.purpose] ?? PURPOSE_LABELS.unknown; return isAr ? p.ar : p.en; })()}
                {(() => { const f = FUNNEL_LABELS[brief.funnel]; return f ? <span style={{ color: 'var(--mute)' }}> · {isAr ? f.ar : f.en}</span> : null; })()}
              </BriefRow>
              <BriefRow label={isAr ? 'المنصّات' : 'Platforms'}>{platforms}</BriefRow>
              <BriefRow label={isAr ? 'الهدف' : 'Objective'}>{brief.objective || '—'}</BriefRow>
              <BriefRow label={isAr ? 'اللغة' : 'Language'}>{brief.language === 'ar' ? (isAr ? 'العربية' : 'Arabic') : (isAr ? 'الإنجليزية' : 'English')}</BriefRow>
              <BriefRow label={isAr ? 'الدعوة للإجراء' : 'CTA'}>{brief.cta || '—'}</BriefRow>
              {brief.core_message && <BriefRow label={isAr ? 'الرسالة الأساسية' : 'Core message'}>{brief.core_message}</BriefRow>}
              {brief.idea && <BriefRow label={isAr ? 'الفكرة' : 'Idea'}>{brief.idea}</BriefRow>}
              {brief.hook && <BriefRow label={isAr ? 'الخطّاف' : 'Hook'}>{brief.hook}</BriefRow>}
              <BriefRow label={isAr ? 'المشاهد الحالية' : 'Existing scenes'}>
                {brief.existing_scenes.length === 0
                  ? (isAr ? 'لا مشاهد بعد' : 'None yet')
                  : (isAr ? `${num(brief.existing_scenes.length, true)} مشاهد — تبقى محمية عند الاعتماد إن كانت معدّلة يدوياً` : `${brief.existing_scenes.length} — manually edited ones stay protected on apply`)}
              </BriefRow>
              <BriefRow label={isAr ? 'المواد' : 'Assets'}>
                {brief.assets_summary.count === 0
                  ? (isAr ? 'لا مواد مرتبطة' : 'None linked')
                  : `${num(brief.assets_summary.count, isAr)} · ${Object.entries(brief.assets_summary.kinds).map(([k, v]) => `${k} ${num(v, isAr)}`).join(', ')}`}
              </BriefRow>
            </div>

            {/* Right — the three choices. */}
            <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
              <Field label={isAr ? 'الوصفة' : 'Recipe'} hint={isAr ? 'مقترحة تلقائياً' : 'recommended by default'}>
                <select className="fsel" value={recipe} onChange={(e) => pickRecipe(e.target.value)} style={{ width: '100%' }}>
                  {recipes.map((r) => <option key={r.key} value={r.key}>{recipeLabel(r)}</option>)}
                </select>
              </Field>
              <Field label={isAr ? 'المدة' : 'Duration'}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {DURATIONS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className="pill"
                      onClick={() => setDuration(d)}
                      style={duration === d
                        ? { background: 'var(--copper)', color: '#FFF9F2', cursor: 'pointer' }
                        : { background: 'var(--sand-2)', color: 'var(--mute)', border: '1px solid var(--line)', cursor: 'pointer' }}
                    >
                      {isAr ? `${num(d, true)} ث` : `${d}s`}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label={isAr ? 'الجمهور' : 'Audience'} hint={isAr ? 'قابل للتعديل' : 'editable'}>
                <input
                  className="inp"
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  placeholder={isAr ? 'مثال: عائلات شابة تبحث عن أول منزل في شمال الرياض' : 'e.g. young families buying their first home in north Riyadh'}
                  style={{ width: '100%' }}
                />
              </Field>
              <Field label={isAr ? 'اعتراض يجيب عنه السكربت' : 'Objection to answer'} hint={isAr ? 'اختياري' : 'optional'}>
                <input
                  className="inp"
                  value={objection}
                  onChange={(e) => setObjection(e.target.value)}
                  placeholder={isAr ? 'مثال: «السعر مرتفع مقارنة بالحي»' : 'e.g. "the price is high for the district"'}
                  style={{ width: '100%' }}
                />
              </Field>
              {brief.audience === null && brief.campaign?.audience_text && (
                <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                  {isAr ? 'جمهور الحملة: ' : 'Campaign audience: '}{brief.campaign.audience_text}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Pill tone="idle">
                  {isAr ? `~${num(recipes.find((r) => r.key === recipe)?.scene_count_hint ?? 0, true)} مشاهد` : `~${recipes.find((r) => r.key === recipe)?.scene_count_hint ?? 0} scenes`}
                </Pill>
              </div>
            </div>
          </div>

          {error && <div className="notice bad" role="alert" style={{ marginTop: 12 }}>{error}</div>}

          <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7, marginTop: 14 }}>
            {isAr
              ? 'تعمل الكتابة في الخلفية — سيظهر شريط تقدّم فوق جدول المشاهد بمراحله، ويمكنك التنقّل بين الصفحات. تصلك المسودة للمراجعة ولا يُضاف شيء إلى المشاهد قبل اعتمادك.'
              : "It writes in the background — a staged progress bar appears over the scenes table and you can move between pages. The draft comes back for review; nothing enters the scenes until you apply it."}
          </div>
        </>
      )}
    </Modal>
  );
}
