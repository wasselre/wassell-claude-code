/**
 * Scene references — the POP-UP. Opened from a scene's «المراجع» button, it
 * shows what the visual system suggested for THIS scene in a proper grid, split
 * into two honest sections:
 *
 *   • من محتوانا — our OWN footage/photos, visually indexed in the same pipeline
 *     as competitors (owner='wassel'). USABLE: open the asset and use it.
 *   • من المنافسين — competitor shots, ALWAYS reference_only: inspiration you
 *     open in a new tab, never a selectable Wassel asset.
 *   • a «فجوة» note when our library has nothing that matches.
 *
 * Accept / reject persists the decision (scene_reference_set). «اقترح مراجع»
 * asks for fresh suggestions (scene_references_suggest). When the visual system
 * is off the server answers {unavailable} — a quiet note here, not an error.
 */
import { useEffect, useState } from 'react';
import { Modal } from './kit';
import {
  MosApiError, fetchSceneReferences, setSceneReference, suggestSceneReferences,
  type MosScene, type SceneReference, type SceneReferenceStatus,
} from '@/lib/marketingOS/client';

const ms = (v: number | null): string => (v === null ? '' : `${(v / 1000).toFixed(1)}s`);

function mergeRefs(current: SceneReference[], incoming: SceneReference[]): SceneReference[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...incoming.filter((r) => r.id && !seen.has(r.id))];
}

function RefCard({ r, isAr, canEdit, busy, onStatus }: {
  r: SceneReference;
  isAr: boolean;
  canEdit: boolean;
  busy: boolean;
  onStatus: (status: SceneReferenceStatus) => void;
}) {
  const usable = r.kind === 'wassel_asset';
  const accepted = r.status === 'accepted';
  const meta = r.kind === 'competitor_shot'
    ? [r.org_name, r.platform].filter(Boolean).join(' · ')
    : (isAr ? 'من مكتبة وصل' : 'Wassel library');
  const line = usable
    ? [r.summary, r.reason].filter(Boolean).join(' — ')
    : [r.learn_element, r.reason].filter(Boolean).join(' — ');
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', borderRadius: 10,
      overflow: 'hidden', background: 'var(--card)', minWidth: 0,
    }}>
      <div style={{ position: 'relative', aspectRatio: '16 / 10', background: 'var(--sand-2)' }}>
        {r.frame_url
          ? <img src={r.frame_url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <div style={{ display: 'grid', placeItems: 'center', width: '100%', height: '100%', color: 'var(--mute)', fontSize: 11 }}>{isAr ? 'لا معاينة' : 'no preview'}</div>}
        <span className={`pill ${accepted ? 'p-go' : usable ? 'p-idle' : 'p-idle'}`} style={{ position: 'absolute', insetInlineStart: 6, top: 6, fontSize: 9.5, padding: '1px 6px' }}>
          {usable ? (isAr ? 'قابلة للاستخدام' : 'usable') : (isAr ? 'للاستلهام فقط' : 'reference only')}
        </span>
        {r.kind !== 'gap' && r.start_ms !== null && !usable && (
          <span className="mono" style={{ position: 'absolute', insetInlineEnd: 6, bottom: 6, fontSize: 9.5, background: 'rgba(0,0,0,.6)', color: '#fff', padding: '1px 5px', borderRadius: 4 }}>
            {ms(r.start_ms)}–{ms(r.end_ms)}
          </span>
        )}
      </div>
      <div style={{ padding: '7px 9px', display: 'grid', gap: 4, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--mute)', overflowWrap: 'anywhere' }}>{meta}</div>
        {line && <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{line}</div>}
        {r.adaptation_notes && <div style={{ fontSize: 11, color: 'var(--mute)' }}>{r.adaptation_notes}</div>}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2, flexWrap: 'wrap' }}>
          {r.open_url && (
            <a href={r.open_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--copper)' }}>
              {usable ? (isAr ? 'افتح المادة' : 'Open asset') : (isAr ? 'افتح الفيديو' : 'Open video')}
            </a>
          )}
          {canEdit && (
            <span style={{ display: 'inline-flex', gap: 4, marginInlineStart: 'auto' }}>
              {!accepted && (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onStatus('accepted')} style={{ fontSize: 10.5, padding: '2px 9px' }}>
                  {usable ? (isAr ? 'استخدم' : 'Use') : (isAr ? 'احفظ' : 'Keep')}
                </button>
              )}
              <button type="button" className="btn btn-d btn-sm" disabled={busy} onClick={() => onStatus('rejected')} style={{ fontSize: 10.5, padding: '2px 9px' }}>
                {isAr ? 'تجاهل' : 'Dismiss'}
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <h5 style={{ margin: 0, fontSize: 13, fontWeight: 800 }}>{title}</h5>
        {hint && <span style={{ fontSize: 11, color: 'var(--mute)' }}>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export default function SceneReferencesModal({ scene, isAr, canEdit, onClose }: {
  scene: MosScene;
  isAr: boolean;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [refs, setRefs] = useState<SceneReference[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [listUnsupported, setListUnsupported] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    fetchSceneReferences(scene.id)
      .then((r) => { if (alive) setRefs(r.references); })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof MosApiError && e.status === 400 && /unknown action/i.test(e.message)) {
          console.error('[marketing] scene_references_list not available on the API yet', e);
          setListUnsupported(true); setRefs([]);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [scene.id]);

  const suggest = async (): Promise<void> => {
    setSuggesting(true); setError(null); setUnavailable(false);
    try {
      const r = await suggestSceneReferences({ sceneId: scene.id });
      if (r.unavailable) { setUnavailable(true); return; }
      const incoming = [...r.competitor, ...r.wassel_assets, ...(r.gap ? [r.gap] : [])];
      setRefs((cur) => mergeRefs(cur ?? [], incoming));
      setListUnsupported(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  };

  const setStatus = async (ref: SceneReference, status: SceneReferenceStatus): Promise<void> => {
    setBusyId(ref.id); setError(null);
    try {
      await setSceneReference(ref.id, status);
      setRefs((cur) => (cur ?? []).map((r) => (r.id === ref.id ? { ...r, status } : r)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const visible = (refs ?? []).filter((r) => r.status !== 'rejected');
  const ours = visible.filter((r) => r.kind === 'wassel_asset');
  const competitors = visible.filter((r) => r.kind === 'competitor_shot');
  const gap = visible.find((r) => r.kind === 'gap') ?? null;
  const grid: React.CSSProperties = { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' };

  return (
    <Modal
      title={isAr ? 'مراجع المشهد' : 'Scene references'}
      sub={scene.visual ?? (isAr ? 'لقطات مقترحة لهذا المشهد' : 'Suggested shots for this scene')}
      wide
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
          {canEdit && (
            <button type="button" className="btn" disabled={suggesting} onClick={() => void suggest()}>
              {suggesting ? (isAr ? 'جارٍ الاقتراح…' : 'Suggesting…') : (isAr ? 'اقترح مراجع' : 'Suggest references')}
            </button>
          )}
          <span style={{ fontSize: 11, color: 'var(--mute)', marginInlineStart: 'auto' }}>
            {isAr ? 'محتوانا قابل للاستخدام · لقطات المنافسين للاستلهام فقط' : 'Our content is usable · competitor shots are inspiration only'}
          </span>
          <button type="button" className="btn btn-d" onClick={onClose}>{isAr ? 'إغلاق' : 'Close'}</button>
        </div>
      }
    >
      {error && <div style={{ fontSize: 12.5, color: 'var(--late)', marginBottom: 10 }} role="alert">{error}</div>}
      {unavailable && (
        <div style={{ fontSize: 12.5, color: 'var(--mute)', marginBottom: 10 }}>
          {isAr ? 'المراجع البصرية غير مفعّلة حالياً.' : 'Visual references are not enabled right now.'}
        </div>
      )}
      {loading && <div style={{ fontSize: 12.5, color: 'var(--mute)' }}>{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>}

      {!loading && (
        <>
          <Section
            title={isAr ? 'من محتوانا' : 'Our content'}
            hint={isAr ? 'مادتنا المفهرَسة بصريًا — قابلة للاستخدام' : 'our visually-indexed footage — usable'}
          >
            {ours.length > 0
              ? <div style={grid}>{ours.map((r) => <RefCard key={r.id} r={r} isAr={isAr} canEdit={canEdit} busy={busyId === r.id} onStatus={(s) => void setStatus(r, s)} />)}</div>
              : (
                <div style={{ fontSize: 12, color: 'var(--mute)', border: '1px dashed var(--line)', borderRadius: 8, padding: '10px 12px' }}>
                  {gap
                    ? (gap.reason || (isAr ? 'لا مادة مطابقة في مكتبتنا لهذا المشهد.' : 'No matching material in our library for this scene.'))
                    : (isAr ? 'لا توجد مادة من محتوانا بعد — جرّب «اقترح مراجع»، أو فهرِس محتوانا من المكتبة البصرية.' : 'No material from our content yet — try “Suggest references”, or index our content from the Visual Library.')}
                </div>
              )}
          </Section>

          <Section
            title={isAr ? 'من المنافسين' : 'From competitors'}
            hint={isAr ? 'للاستلهام فقط — لا تُستخدم كأصل من أصولنا' : 'inspiration only — never used as our asset'}
          >
            {competitors.length > 0
              ? <div style={grid}>{competitors.map((r) => <RefCard key={r.id} r={r} isAr={isAr} canEdit={canEdit} busy={busyId === r.id} onStatus={(s) => void setStatus(r, s)} />)}</div>
              : (
                <div style={{ fontSize: 12, color: 'var(--mute)' }}>
                  {listUnsupported
                    ? (isAr ? 'المراجع المحفوظة تظهر بعد «اقترح مراجع».' : 'Saved references appear after “Suggest references”.')
                    : (isAr ? 'لا لقطات منافسين مقترحة بعد.' : 'No competitor shots suggested yet.')}
                </div>
              )}
          </Section>
        </>
      )}
    </Modal>
  );
}
