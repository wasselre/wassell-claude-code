/**
 * Scenes — design screen 07.
 *
 * A real table, not prose, because the shoot list is DERIVED from it: every
 * scene marked missing is a shot somebody has to go and film. That is why
 * footage status is a first-class control here rather than a note.
 *
 * The strip on top is the running order at a glance — the thing you actually
 * check before approving a script.
 */
import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  FOOTAGE_LABELS, MosScene, deleteScene, saveScene, saveShoot,
} from '@/lib/marketingOS/client';
import { IconPlus, IconShoot, IconTrash } from './icons';
import { num } from '../lib/format';

const STATUSES: Array<MosScene['footage_status']> = ['have', 'to_make', 'missing'];
const STATUS_BG: Record<string, string> = {
  have: 'var(--go)',
  to_make: 'var(--wait)',
  missing: 'var(--late)',
};

export default function SceneTable({
  contentId, contentTitle, projectId, scenes, canEdit, isAr, onChange,
}: {
  contentId: string;
  contentTitle: string;
  projectId: string | null;
  scenes: MosScene[];
  canEdit: boolean;
  isAr: boolean;
  onChange: (scenes: MosScene[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ scenes: MosScene[] }>): Promise<void> => {
    setBusy(true);
    try {
      onChange((await fn()).scenes);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const missing = scenes.filter((s) => s.footage_status === 'missing');
  const have = scenes.filter((s) => s.footage_status === 'have').length;

  const raiseShoot = async (): Promise<void> => {
    setBusy(true);
    try {
      await saveShoot(
        {
          title: isAr ? `تصوير — ${contentTitle}` : `Shoot — ${contentTitle}`,
          project_id: projectId,
          status: 'requested',
        },
        missing.map((s) => s.id),
      );
      addToast(
        isAr
          ? `أُنشئ طلب تصوير بـ ${num(missing.length, true)} لقطات.`
          : `Raised a shoot request with ${missing.length} shots.`,
        'success',
      );
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {scenes.length > 0 && (
        <>
          <div className="timeline">
            {scenes.map((s) => (
              <i
                key={s.id}
                style={{
                  flex: 1,
                  background: STATUS_BG[s.footage_status] ?? 'var(--sand)',
                }}
                title={s.visual ?? ''}
              >
                {num(s.position, isAr)}
              </i>
            ))}
          </div>
          <div className="card-h" style={{ border: '1px solid var(--line)', borderRadius: 10, background: 'var(--paper)' }}>
            <span style={{ fontSize: 13 }}>
              <b>{num(have, isAr)}</b>
              <span style={{ color: 'var(--mute)' }}>
                {isAr
                  ? ` من ${num(scenes.length, true)} مشاهد لديها تصوير`
                  : ` of ${scenes.length} scenes have footage`}
              </span>
            </span>
            {missing.length > 0 && (
              <span className="pill p-late">
                {isAr ? `${num(missing.length, true)} ناقصة` : `${missing.length} missing`}
              </span>
            )}
            {missing.length > 0 && canEdit && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginInlineStart: 'auto' }}
                disabled={busy}
                onClick={() => void raiseShoot()}
              >
                <IconShoot />
                {isAr ? 'طلب تصوير للناقص' : 'Raise a shoot request'}
              </button>
            )}
          </div>
        </>
      )}

      <div className="card">
        {scenes.length === 0 ? (
          <p style={{ padding: 28, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
            {isAr
              ? 'لا مشاهد بعد. أضف مشهدًا لكل لقطة — الناقص منها هو ما يصبح طلب تصوير.'
              : 'No scenes yet. Add one per shot — the missing ones are what become a shoot request.'}
          </p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>{isAr ? 'الصورة' : 'Visual'}</th>
                  <th>{isAr ? 'التعليق الصوتي' : 'Voice-over'}</th>
                  <th>{isAr ? 'نص الشاشة' : 'On-screen'}</th>
                  <th style={{ width: 175 }}>{isAr ? 'التصوير' : 'Footage'}</th>
                  {canEdit && <th style={{ width: 40 }} />}
                </tr>
              </thead>
              <tbody>
                {scenes.map((s) => (
                  <tr key={s.id} style={{ verticalAlign: 'top' }}>
                    <td style={{ fontSize: 11, color: 'var(--mute)' }}>{num(s.position, isAr)}</td>
                    {(['visual', 'voiceover', 'on_screen_text'] as const).map((f) => (
                      <td key={f} style={{ padding: 6 }}>
                        <textarea
                          defaultValue={(s[f] as string | null) ?? ''}
                          disabled={!canEdit || busy}
                          rows={2}
                          className="inp"
                          style={{ fontSize: 12, padding: '4px 6px', border: '1px solid transparent', background: 'transparent' }}
                          onBlur={(e) => {
                            if (e.target.value !== ((s[f] as string | null) ?? '')) {
                              void run(() => saveScene(contentId, { id: s.id, [f]: e.target.value || null }));
                            }
                          }}
                        />
                      </td>
                    ))}
                    <td style={{ padding: 6 }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {STATUSES.map((st) => (
                          <button
                            key={st}
                            type="button"
                            disabled={!canEdit || busy}
                            onClick={() => void run(() => saveScene(contentId, { id: s.id, footage_status: st }))}
                            className="pill"
                            style={
                              s.footage_status === st
                                ? { background: STATUS_BG[st], color: '#FFF9F2', cursor: 'pointer' }
                                : { background: 'var(--sand-2)', color: 'var(--mute)', border: '1px solid var(--line)', cursor: 'pointer' }
                            }
                          >
                            {isAr ? FOOTAGE_LABELS[st]?.ar : FOOTAGE_LABELS[st]?.en}
                          </button>
                        ))}
                      </div>
                    </td>
                    {canEdit && (
                      <td style={{ padding: 6 }}>
                        <button
                          type="button"
                          className="btn btn-d btn-sm"
                          disabled={busy}
                          onClick={() => void run(() => deleteScene(contentId, s.id))}
                          aria-label={isAr ? 'حذف المشهد' : 'Delete scene'}
                        >
                          <IconTrash />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canEdit && (
        <div>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run(() => saveScene(contentId, { footage_status: 'missing' }))}
          >
            <IconPlus />
            {isAr ? 'إضافة مشهد' : 'Add scene'}
          </button>
        </div>
      )}
    </div>
  );
}
