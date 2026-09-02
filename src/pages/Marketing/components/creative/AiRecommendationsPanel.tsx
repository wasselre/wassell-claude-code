/**
 * AiRecommendationsPanel — the AI image work the package PROPOSES. A
 * recommendation is a full execution-ready brief (mode, prompt, sources,
 * must-keep/must-change, the fabrication-policy line it satisfies) — but it
 * EXECUTES only after a human approves it, and only while the
 * `ai_image_execution` flag is on (contracts §0.8). Outputs land as candidates
 * (usage_rights needs_review), never as production assets — the preview shows
 * here when one completes.
 */
import type { AiRecommendation } from '@/lib/creative/contracts';
import { AI_MODE_LABELS, AI_STATUS_LABELS, pick } from './labels';

const STATUS_TONE: Record<string, string> = {
  recommended: 'p-idle',
  approved: 'p-now',
  queued: 'p-wait',
  running: 'p-wait',
  completed: 'p-go',
  failed: 'p-late',
  dismissed: 'p-idle',
};

export default function AiRecommendationsPanel({
  recs, previews, canExecute, busy, isAr, onApprove, onDismiss,
}: {
  recs: AiRecommendation[];
  previews: Record<string, string>;
  /** flags.ai_image_execution && the caller may write. */
  canExecute: boolean;
  busy: boolean;
  isAr: boolean;
  onApprove: (index: number) => void;
  onDismiss: (index: number) => void;
}) {
  if (recs.length === 0) return null;

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'مقترحات إنتاج الصور بالذكاء' : 'AI image production'}</h4>
        <span className="r">
          {canExecute
            ? (isAr ? 'التنفيذ بعد اعتمادك فقط' : 'Executes only after your approval')
            : (isAr ? 'التنفيذ معطّل — مقترحات للمصمم' : 'Execution off — proposals for the designer')}
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        {recs.map((r) => {
          const outputUrl = r.execution?.output_file_id
            ? previews[r.execution.output_file_id] ?? null
            : null;
          const actionable = r.status === 'recommended' || r.status === 'failed';
          return (
            <div key={r.index} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="tag tag-t">{pick(AI_MODE_LABELS, r.mode, isAr)}</span>
                <span className={`pill ${STATUS_TONE[r.status] ?? 'p-idle'}`}>
                  {pick(AI_STATUS_LABELS, r.status, isAr)}
                </span>
                <span className="tag ltr" style={{ fontSize: 10 }}>{r.aspect}</span>
                {(canExecute || r.status !== 'recommended') && actionable && (
                  <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
                    {canExecute && (
                      <button
                        type="button"
                        className="btn btn-go btn-sm"
                        disabled={busy}
                        onClick={() => onApprove(r.index)}
                      >
                        {isAr ? 'اعتماد التنفيذ' : 'Approve execution'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-d btn-sm"
                      disabled={busy}
                      onClick={() => onDismiss(r.index)}
                    >
                      {isAr ? 'استبعاد' : 'Dismiss'}
                    </button>
                  </span>
                )}
              </div>

              <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                <b>{isAr ? 'الأمر التنفيذي: ' : 'Prompt: '}</b>{r.prompt}
              </div>
              {r.source_file_ids.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                  {isAr ? 'المصادر: ' : 'Sources: '}
                  {r.source_file_ids.map((id) => <span key={id} className="tag ltr" style={{ marginInlineEnd: 4, fontSize: 10 }}>{id.slice(0, 8)}</span>)}
                </div>
              )}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, lineHeight: 1.8 }}>
                <span><b>{isAr ? 'يحافظ على: ' : 'Must keep: '}</b>{r.must_keep.join(isAr ? '، ' : ', ') || '—'}</span>
                <span><b>{isAr ? 'يغيّر: ' : 'Must change: '}</b>{r.must_change.join(isAr ? '، ' : ', ') || '—'}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--calm)', lineHeight: 1.8 }}>
                <b>{isAr ? 'سياسة عدم التلفيق: ' : 'Fabrication policy: '}</b>{r.policy_check}
              </div>

              {r.execution?.error && (
                <div className="notice bad" style={{ fontSize: 12 }}>{r.execution.error}</div>
              )}

              {outputUrl && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <img
                    src={outputUrl}
                    alt={isAr ? 'المخرجة المرشّحة' : 'Candidate output'}
                    style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }}
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.8 }}>
                    {isAr
                      ? 'مخرجة مرشّحة — حقوقها «تحتاج مراجعة» ولا تدخل الإنتاج إلا بترقية بشرية.'
                      : 'Candidate output — rights are “needs review”; it enters production only by human promotion.'}
                  </div>
                </div>
              )}
              {r.status === 'completed' && !outputUrl && r.execution?.output_file_id && (
                <div style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                  {isAr ? 'اكتملت — المخرجة محفوظة في ملفات المشروع.' : 'Completed — the output is saved in the project files.'}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
