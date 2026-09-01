/**
 * Write video script — the in-app «اكتب سكربت» launcher. Pick a recipe and
 * start; generation runs in the BACKGROUND (the Fly worker's script lane), so
 * this modal just enqueues and closes. A progress bar then sits on top of the
 * scenes table (driven by the job status on the content page), the operator can
 * leave the page, and a bell notification fires when the scenes land in the
 * table. No waiting, no held-open request (the old synchronous path hit the
 * 23s client / 25s edge timeout).
 */
import { useState } from 'react';
import { Modal } from './kit';
import { writeVideoScript, type ScriptRecipeKey, type ScriptJobRow } from '@/lib/marketingOS/client';

const RECIPES: Array<{ key: ScriptRecipeKey; ar: string; en: string }> = [
  { key: 'walkthrough', ar: 'جولة', en: 'Walkthrough' },
  { key: 'offer', ar: 'عرض', en: 'Offer' },
  { key: 'rent_vs_own', ar: 'إيجار مقابل تملّك', en: 'Rent vs own' },
  { key: 'product_explainer', ar: 'شرح المنتج', en: 'Product explainer' },
  { key: 'launch', ar: 'إطلاق', en: 'Launch' },
];

export default function VideoScriptModal({ contentId, isAr, onClose, onStarted }: {
  contentId: string;
  isAr: boolean;
  onClose: () => void;
  onStarted: (job: ScriptJobRow) => void;
}) {
  const [recipe, setRecipe] = useState<ScriptRecipeKey>('walkthrough');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await writeVideoScript(contentId, recipe);
      onStarted(r.job);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'اكتب سكربت الفيديو' : 'Write video script'}
      sub={isAr ? 'يتعلّم من فيديوهات المنافسين ويكتب بحقائق المشروع' : "Learns from competitors' videos, grounded in the project's facts"}
      onClose={onClose}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <select className="fsel" value={recipe} onChange={(e) => setRecipe(e.target.value as ScriptRecipeKey)}>
          {RECIPES.map((r) => <option key={r.key} value={r.key}>{isAr ? r.ar : r.en}</option>)}
        </select>
        <button className="btn btn-p" onClick={start} disabled={loading}>
          {loading ? (isAr ? 'يبدأ…' : 'Starting…') : (isAr ? 'ابدأ الكتابة' : 'Start writing')}
        </button>
      </div>

      {error && <div className="notice bad" style={{ marginBottom: 10 }}>{error}</div>}

      <div style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.7 }}>
        {isAr
          ? 'تعمل الكتابة في الخلفية — لا حاجة للانتظار هنا. سيظهر شريط تقدّم فوق جدول المشاهد، ويمكنك التنقّل بين الصفحات، وسيصلك إشعار عند جاهزية السكربت وإضافة المشاهد تلقائياً.'
          : "It writes in the background — no need to wait here. A progress bar appears on top of the scenes table, you can move between pages, and you'll get a notification when the script is ready and the scenes are added automatically."}
      </div>
    </Modal>
  );
}
