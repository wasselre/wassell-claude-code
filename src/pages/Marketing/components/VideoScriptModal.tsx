/**
 * Write video script — the in-app «اكتب سكربت» button's modal. Pick a recipe,
 * generate a draft (learns from competitor transcripts + the record's project),
 * review, then Apply → inserts the scenes into the record. Non-destructive:
 * nothing is written until the operator hits Apply.
 */
import { useState } from 'react';
import { Modal } from './kit';
import {
  writeVideoScript, applyVideoScript,
  type VideoScriptDraft, type ScriptRecipeKey,
} from '@/lib/marketingOS/client';

const RECIPES: Array<{ key: ScriptRecipeKey; ar: string; en: string }> = [
  { key: 'walkthrough', ar: 'جولة', en: 'Walkthrough' },
  { key: 'offer', ar: 'عرض', en: 'Offer' },
  { key: 'rent_vs_own', ar: 'إيجار مقابل تملّك', en: 'Rent vs own' },
  { key: 'product_explainer', ar: 'شرح المنتج', en: 'Product explainer' },
  { key: 'launch', ar: 'إطلاق', en: 'Launch' },
];

export default function VideoScriptModal({ contentId, isAr, onClose, onApplied }: {
  contentId: string;
  isAr: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [recipe, setRecipe] = useState<ScriptRecipeKey>('walkthrough');
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [draft, setDraft] = useState<VideoScriptDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    setDraft(null);
    try {
      const r = await writeVideoScript(contentId, recipe);
      setDraft(r.draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!draft) return;
    setApplying(true);
    setError(null);
    try {
      await applyVideoScript(contentId, draft.scenes);
      onApplied();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setApplying(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'اكتب سكربت الفيديو' : 'Write video script'}
      sub={isAr ? 'يتعلّم من فيديوهات المنافسين ويكتب بحقائق المشروع' : "Learns from competitors' videos, grounded in the project's facts"}
      onClose={onClose}
      wide
      footer={draft ? (
        <button className="btn btn-go" onClick={apply} disabled={applying}>
          {applying
            ? (isAr ? 'جارٍ الإضافة…' : 'Adding…')
            : (isAr ? `اعتماد وإضافة ${draft.scenes.length} مشهد` : `Apply ${draft.scenes.length} scenes`)}
        </button>
      ) : null}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <select className="fsel" value={recipe} onChange={(e) => setRecipe(e.target.value as ScriptRecipeKey)}>
          {RECIPES.map((r) => <option key={r.key} value={r.key}>{isAr ? r.ar : r.en}</option>)}
        </select>
        <button className="btn btn-p" onClick={generate} disabled={loading}>
          {loading ? (isAr ? 'يكتب…' : 'Writing…') : (isAr ? 'توليد' : 'Generate')}
        </button>
        {draft && <span style={{ color: 'var(--mute)', fontSize: 12 }}>{draft.project_name}</span>}
      </div>

      {error && <div className="notice bad" style={{ marginBottom: 10 }}>{error}</div>}
      {loading && (
        <div style={{ color: 'var(--mute)', padding: '18px 0', fontSize: 13 }}>
          {isAr ? 'يدرس فيديوهات المنافسين ويكتب السكربت…' : 'Studying competitor videos & writing the script…'}
        </div>
      )}

      {draft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {draft.scenes.map((s, i) => (
            <div key={i} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 4 }}>
                {isAr ? 'مشهد' : 'Scene'} {i + 1}
                {s.start_sec != null ? ` · ${s.start_sec}–${s.end_sec ?? ''}s` : ''}
              </div>
              <div style={{ fontSize: 13, marginBottom: 3 }}>
                <b>{isAr ? 'الصوت: ' : 'VO: '}</b>{s.voiceover}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                <b>{isAr ? 'اللقطة: ' : 'Visual: '}</b>{s.visual}
              </div>
              {s.on_screen_text && (
                <div style={{ fontSize: 12, color: 'var(--copper)' }}>
                  <b>{isAr ? 'على الشاشة: ' : 'On-screen: '}</b>{s.on_screen_text}
                </div>
              )}
            </div>
          ))}
          {draft.hooks.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--mute)', marginBottom: 4 }}>
                {isAr ? 'خطّافات بديلة' : 'Alternative hooks'}
              </div>
              <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {draft.hooks.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
