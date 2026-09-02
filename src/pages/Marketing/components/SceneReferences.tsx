/**
 * Scene references — Phase 4 of Script Writer v2, the compact slot under a
 * scene's shot cell.
 *
 * Shows what the visual system suggested for THIS scene: competitor shots
 * (always `reference_only` — inspiration you open in a new tab, never a
 * selectable Wassel asset), Wassel assets you can actually use, and a «gap»
 * note when nothing in our library matches. Accept / reject persists the
 * decision (`scene_reference_set`); «اقترح مراجع» asks for suggestions
 * (`scene_references_suggest`). When the visual system is switched off the
 * server answers `{unavailable:true}` — that is a quiet note here, not an
 * error. Collapsed by default so the scenes table stays a scenes table.
 */
import { useState } from 'react';
import {
  MosApiError, fetchSceneReferences, setSceneReference, suggestSceneReferences,
  type MosScene, type SceneReference, type SceneReferenceStatus,
} from '@/lib/marketingOS/client';
import { num } from '../lib/format';

const KIND_LABEL: Record<SceneReference['kind'], { ar: string; en: string }> = {
  competitor_shot: { ar: 'لقطة منافس', en: 'Competitor shot' },
  wassel_asset:    { ar: 'مادة وصل', en: 'Wassel asset' },
  gap:             { ar: 'فجوة', en: 'Gap' },
};

const ms = (v: number | null): string => (v === null ? '' : `${(v / 1000).toFixed(1)}s`);

function mergeRefs(current: SceneReference[], incoming: SceneReference[]): SceneReference[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...incoming.filter((r) => r.id && !seen.has(r.id))];
}

export default function SceneReferences({ scene, isAr, canEdit }: {
  scene: MosScene;
  isAr: boolean;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<SceneReference[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // `scene_references_list` is proposed, not yet in the §7 contract. Until it
  // lands the server answers 400 «unknown action» — shown as a quiet note (the
  // suggest action still returns previously-decided rows), logged, not swallowed.
  const [listUnsupported, setListUnsupported] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = (): void => {
    setLoading(true);
    setError(null);
    fetchSceneReferences(scene.id)
      .then((r) => setRefs(r.references))
      .catch((e: unknown) => {
        if (e instanceof MosApiError && e.status === 400 && /unknown action/i.test(e.message)) {
          // Exactly the "endpoint not shipped yet" case — nothing else is muted.
          console.error('[marketing] scene_references_list not available on the API yet', e);
          setListUnsupported(true);
          setRefs([]);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  };

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && refs === null && !loading) load();
  };

  const suggest = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const r = await suggestSceneReferences({ sceneId: scene.id });
      if (r.unavailable) {
        setUnavailable(true);
        return;
      }
      const incoming = [...r.competitor, ...r.wassel_assets, ...(r.gap ? [r.gap] : [])];
      setRefs((cur) => mergeRefs(cur ?? [], incoming));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const setStatus = async (ref: SceneReference, status: SceneReferenceStatus): Promise<void> => {
    setBusyId(ref.id);
    setError(null);
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
  const accepted = visible.filter((r) => r.status === 'accepted').length;

  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        onClick={toggle}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10.5, fontWeight: 700, color: 'var(--mute)' }}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} {isAr ? 'المراجع' : 'References'}
        {refs !== null && visible.length > 0 && (
          <span> · {num(visible.length, isAr)}{accepted > 0 ? ` (${isAr ? 'مقبولة' : 'accepted'} ${num(accepted, isAr)})` : ''}</span>
        )}
      </button>

      {open && (
        <div style={{ marginTop: 4, display: 'grid', gap: 5 }}>
          {error && (
            <div style={{ fontSize: 10.5, color: 'var(--late)', overflowWrap: 'anywhere' }} role="alert">{error}</div>
          )}
          {unavailable && (
            <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>
              {isAr ? 'المراجع البصرية غير مفعّلة حالياً.' : 'Visual references are not enabled right now.'}
            </div>
          )}
          {listUnsupported && (
            <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>
              {isAr ? 'المراجع المحفوظة تظهر بعد «اقترح مراجع».' : 'Saved references appear after “Suggest references”.'}
            </div>
          )}
          {refs !== null && visible.length === 0 && !unavailable && !loading && !listUnsupported && (
            <div style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'لا مراجع بعد.' : 'No references yet.'}</div>
          )}

          {visible.map((r) => (
            <div key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 10.5, lineHeight: 1.5 }}>
              {r.kind !== 'gap' && (
                r.frame_url
                  ? <img src={r.frame_url} alt="" loading="lazy" style={{ width: 56, height: 36, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--line)', flex: '0 0 auto' }} />
                  : <span style={{ width: 56, height: 36, borderRadius: 4, background: 'var(--sand-2)', border: '1px solid var(--line)', flex: '0 0 auto' }} />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className={`pill ${r.status === 'accepted' ? 'p-go' : 'p-idle'}`} style={{ fontSize: 9.5, padding: '1px 5px' }}>
                    {(() => { const k = KIND_LABEL[r.kind]; return k ? (isAr ? k.ar : k.en) : r.kind; })()}
                  </span>
                  {r.kind === 'competitor_shot' && (
                    <span style={{ color: 'var(--mute)' }}>
                      {[r.org_name, r.platform].filter(Boolean).join(' · ') || (isAr ? 'للاستلهام فقط' : 'reference only')}
                    </span>
                  )}
                  {r.kind !== 'gap' && r.start_ms !== null && (
                    <span style={{ color: 'var(--mute)' }}>{ms(r.start_ms)}–{ms(r.end_ms)}</span>
                  )}
                  {r.open_url && (
                    <a href={r.open_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--copper)', fontWeight: 700 }}>
                      {r.kind === 'wassel_asset' ? (isAr ? 'افتح المادة' : 'Open asset') : (isAr ? 'افتح الفيديو' : 'Open video')}
                    </a>
                  )}
                </div>
                <div style={{ color: 'var(--ink-2)', overflowWrap: 'anywhere' }}>
                  {r.kind === 'gap'
                    ? (r.reason || (typeof r.gap?.reason === 'string' ? r.gap.reason : (isAr ? 'لا مادة مطابقة في مكتبتنا' : 'No matching material in our library')))
                    : [r.learn_element, r.reason].filter(Boolean).join(' — ')}
                </div>
                {r.adaptation_notes && <div style={{ color: 'var(--mute)' }}>{r.adaptation_notes}</div>}
                {canEdit && r.kind !== 'gap' && (
                  <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                    {r.status !== 'accepted' && (
                      <button type="button" className="btn btn-sm" disabled={busyId === r.id} onClick={() => void setStatus(r, 'accepted')} style={{ fontSize: 10, padding: '1px 7px' }}>
                        {isAr ? 'قبول' : 'Accept'}
                      </button>
                    )}
                    <button type="button" className="btn btn-d btn-sm" disabled={busyId === r.id} onClick={() => void setStatus(r, 'rejected')} style={{ fontSize: 10, padding: '1px 7px' }}>
                      {isAr ? 'رفض' : 'Reject'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {canEdit && (
            <div>
              <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void suggest()} style={{ fontSize: 10.5 }}>
                {loading ? (isAr ? '…' : '…') : (isAr ? 'اقترح مراجع' : 'Suggest references')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
