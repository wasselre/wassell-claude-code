/**
 * Scene references — the compact TRIGGER under a scene's shot cell. It no longer
 * renders the references inline (that was a cramped vertical list); it opens
 * SceneReferencesModal, a proper pop-up that shows our own usable footage and
 * competitor inspiration side-by-side in a grid.
 */
import { useState } from 'react';
import { Film } from 'lucide-react';
import type { MosScene } from '@/lib/marketingOS/client';
import SceneReferencesModal from './SceneReferencesModal';

export default function SceneReferences({ scene, isAr, canEdit }: {
  scene: MosScene;
  isAr: boolean;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none',
          padding: 0, cursor: 'pointer', fontSize: 10.5, fontWeight: 700, color: 'var(--mute)',
        }}
      >
        <Film size={12} /> {isAr ? 'المراجع' : 'References'}
      </button>
      {open && <SceneReferencesModal scene={scene} isAr={isAr} canEdit={canEdit} onClose={() => setOpen(false)} />}
    </div>
  );
}
