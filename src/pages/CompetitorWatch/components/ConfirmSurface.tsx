/** Confirm links — a fast ✓/✗ review of the AI's candidate project attributions.
 *  Confirming links the post to the project (and it shows in the Library);
 *  rejecting drops that guess. The same approve/dismiss loop Files uses. */
import { useCallback, useEffect, useState } from 'react';
import { fetchAttributionQueue, reviewAttribution, type QueueItem } from '@/lib/competitorWatch/client';

export default function ConfirmSurface({ isAr }: { isAr: boolean }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAttributionQueue(30)
      .then((q) => { setItems(q.items); setRemaining(q.remaining); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  // top up when the visible batch is emptied but more remain
  useEffect(() => {
    if (!loading && !error && items.length === 0 && remaining > 0) load();
  }, [items.length, loading, error, remaining, load]);

  const decide = async (it: QueueItem, accept: boolean) => {
    setBusy(it.post_id);
    try {
      await reviewAttribution(it.post_id, it.project_id, accept);
      setItems((prev) => prev.filter((x) => x.post_id !== it.post_id));
      setRemaining((n) => Math.max(0, n - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading && items.length === 0) return <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (error) return <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>;

  return (
    <div className="cw-surface">
      <p className="cw-note" style={{ marginTop: 0 }}>
        {isAr
          ? 'أكّد الروابط التي خمّنها الذكاء: لكل منشور، هل هو عن هذا المشروع؟ «نعم» تربطه (ويظهر في المكتبة)، و«لا» تُزيل التخمين. الأقوى أولاً.'
          : "Confirm the AI's guesses: for each post, is it about this project? “Yes” links it (and it appears in the Library); “No” drops the guess. Strongest first."}
      </p>
      <div className="cw-count">{isAr ? `${remaining.toLocaleString()} بانتظار المراجعة` : `${remaining.toLocaleString()} awaiting review`}</div>

      {items.length === 0 && remaining === 0 && (
        <div className="cw-empty">{isAr ? 'لا شيء للمراجعة — تمّت مراجعة كل التخمينات 🎉' : 'Nothing to review — all caught up 🎉'}</div>
      )}

      {items.map((it) => {
        const conf = typeof it.confidence === 'number' ? Math.round(it.confidence * 100) : null;
        return (
          <div className="cw-review" key={it.post_id}>
            <div className="cw-thumb cw-rvthumb">
              {it.thumb_url
                ? <img className="cw-thumbimg" src={it.thumb_url} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>}
              {it.format && <span className="cw-fmt">{it.format}</span>}
            </div>
            <div className="cw-body">
              <div className="cw-metaline">
                <span className="cw-co" dir="rtl">{it.org_name ?? '—'}</span>
                {it.platform && <span>· {it.platform}</span>}
                {it.post_url && <a className="cw-devlink" href={it.post_url} target="_blank" rel="noreferrer" style={{ borderColor: 'transparent', padding: 0 }} title={isAr ? 'المنشور الأصلي' : 'original post'}>↗</a>}
              </div>
              {it.summary && <p className="cw-desc" dir="auto">{it.summary}</p>}
              <div className="cw-rvq">
                <span>{isAr ? 'هل هو عن' : 'Is it about'}</span>
                <a className="cw-projlink" href={`/model/all_projects/${it.project_id}`} target="_blank" rel="noreferrer">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                  <span dir="rtl">{it.project_name ?? '—'}</span>
                  <span aria-hidden="true">↗</span>
                </a>
                {conf !== null && <span className="cw-conf" title={isAr ? 'ثقة الذكاء' : "AI's confidence"}>{conf}%</span>}
                <span>؟</span>
              </div>
            </div>
            <div className="cw-rvactions">
              <button className="cw-rvbtn ok" type="button" disabled={busy === it.post_id} onClick={() => decide(it, true)}>✓ {isAr ? 'نعم' : 'Yes'}</button>
              <button className="cw-rvbtn bad" type="button" disabled={busy === it.post_id} onClick={() => decide(it, false)}>✗ {isAr ? 'لا' : 'No'}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
