/**
 * Scenes — design screen 07, the half the Google Doc always failed at.
 *
 * Columns are الصورة / التعليق الصوتي / نص على الشاشة / التصوير — footage
 * status stays a first-class control because every scene marked missing is a
 * shot somebody has to go and film. (Per-scene timing was dropped — a scene is
 * a shot, not a stopwatch entry.)
 */
import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  FOOTAGE_LABELS, MosScene, deleteScene, saveScene, saveShoot,
} from '@/lib/marketingOS/client';
import { IconPlus, IconShoot, IconTrash } from './icons';
import { Modal } from './kit';
import { num } from '../lib/format';

/**
 * The three descriptive scene columns. They hold real sentences — a voice-over
 * line, an on-screen caption — so the cell is a CLAMPED preview that opens a
 * roomy popup editor on click, never a cramped inline box you fight to type in.
 */
const CELL_FIELDS = ['visual', 'voiceover', 'on_screen_text'] as const;
type CellField = typeof CELL_FIELDS[number];
const CELL_LABELS: Record<CellField, { ar: string; en: string }> = {
  visual:         { ar: 'الصورة', en: 'The shot' },
  voiceover:      { ar: 'التعليق الصوتي', en: 'Voice-over' },
  on_screen_text: { ar: 'نص على الشاشة', en: 'On-screen text' },
};

/**
 * One editable scene cell: a clamped preview (up to 3 lines) that opens a popup
 * with a full-height textarea. Commits on Save only when the text changed, so
 * opening a cell and closing it never fires a needless write.
 */
function SceneTextCell({
  value, label, busy, isAr, onSave,
}: {
  value: string;
  label: string;
  busy: boolean;
  isAr: boolean;
  onSave: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  const openEditor = (): void => { setDraft(value); setOpen(true); };
  const commit = (): void => {
    if (draft !== value) onSave(draft);
    setOpen(false);
  };
  const placeholder = isAr ? 'اضغط للكتابة…' : 'Tap to write…';

  return (
    <>
      <div
        className="inp"
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-label={label}
        onClick={() => { if (!busy) openEditor(); }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); openEditor(); }
        }}
        style={{
          width: '100%', minHeight: 40, fontSize: 12, lineHeight: 1.7,
          cursor: busy ? 'default' : 'text', whiteSpace: 'pre-wrap',
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
          overflow: 'hidden', textAlign: isAr ? 'right' : 'left',
          color: value ? 'var(--ink)' : 'var(--mute)',
        }}
      >
        {value || placeholder}
      </div>
      {open && (
        <Modal
          title={label}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <button type="button" className="btn btn-p" onClick={commit}>
                {isAr ? 'حفظ' : 'Save'}
              </button>
            </>
          }
        >
          <textarea
            className="inp"
            autoFocus
            rows={9}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            style={{ width: '100%', fontSize: 14, lineHeight: 1.95 }}
          />
        </Modal>
      )}
    </>
  );
}

const STATUSES: Array<MosScene['footage_status']> = ['have', 'to_make', 'missing', 'template'];
const STATUS_BG: Record<string, string> = {
  have: 'var(--go)',
  to_make: 'var(--wait)',
  missing: 'var(--late)',
  // «قالب» — the shot comes from a template (screen 07, الشعار + واتساب); the
  // mockup paints it in the same wait tone as «تُصنع».
  template: 'var(--wait)',
};
/** The read state's single pill per row — screen 07's p-go / p-wait / p-late. */
const STATUS_PILL: Record<MosScene['footage_status'], string> = {
  have: 'p-go',
  to_make: 'p-wait',
  missing: 'p-late',
  template: 'p-wait',
};
export default function SceneTable({
  contentId, contentTitle, projectId, scenes, canEdit, canDelete = false, canRaiseShoot = false, isAr, onChange,
}: {
  contentId: string;
  contentTitle: string;
  projectId: string | null;
  scenes: MosScene[];
  canEdit: boolean;
  /** Deleting a scene is its own gate (`delete_records`), split from canEdit. */
  canDelete?: boolean;
  /**
   * Screen 36's ops rule: the operations supervisor may raise the shoot
   * request EARLY — before the creative approval — so filming doesn't wait
   * on the text. The fields stay locked; only this one button lights up.
   */
  canRaiseShoot?: boolean;
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
  // «لقطتان من ٥ لديها تصوير» — screen 07 counts against the shots that NEED
  // footage: a «قالب» scene is nobody's filming job, so it leaves the total.
  const needFootage = scenes.filter((s) => s.footage_status !== 'template').length;
  const haveTextAr = have === 1 ? 'لقطة' : have === 2 ? 'لقطتان' : num(have, true);

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
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'المشاهد' : 'The scenes'}</h4>
        <span className="r">
          {isAr
            ? `${num(scenes.length, true)} مشاهد · ${haveTextAr} من ${num(needFootage, true)} لديها تصوير`
            : `${scenes.length} scenes · ${have} of ${needFootage} have footage`}
        </span>
        {missing.length > 0 && (canEdit || canRaiseShoot) && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginInlineStart: 10 }}
            disabled={busy}
            onClick={() => void raiseShoot()}
          >
            <IconShoot />
            {isAr ? 'طلب تصوير للناقص' : 'Raise a shoot request'}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginInlineStart: missing.length > 0 ? 6 : 10 }}
            disabled={busy}
            onClick={() => void run(() => saveScene(contentId, { footage_status: 'missing' }))}
          >
            <IconPlus />
            {isAr ? 'إضافة مشهد' : 'Add scene'}
          </button>
        )}
      </div>

      <div className="card-b" style={{ padding: '14px 16px' }}>
        {scenes.length === 0 ? (
          <p style={{ padding: 14, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
            {isAr
              ? 'لا مشاهد بعد. مشهد لكل لقطة — الناقص منها هو ما يصبح طلب تصوير.'
              : 'No scenes yet. One per shot — the missing ones are what become a shoot request.'}
          </p>
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    {/* التعليق الصوتي and نص على الشاشة carry full sentences, so
                        they get the room — voice-over flexes to the widest, and
                        on-screen text is a generous fixed column; both open a
                        popup editor on click. */}
                    <th style={{ width: 32 }}>#</th>
                    <th style={{ width: 200 }}>{isAr ? 'الصورة' : 'The shot'}</th>
                    <th style={{ minWidth: 260 }}>{isAr ? 'التعليق الصوتي' : 'Voice-over'}</th>
                    <th style={{ width: 240 }}>{isAr ? 'نص على الشاشة' : 'On-screen text'}</th>
                    <th style={{ width: canEdit ? 168 : 104 }}>{isAr ? 'التصوير' : 'Footage'}</th>
                    {canDelete && <th style={{ width: 36 }} />}
                  </tr>
                </thead>
                <tbody>
                  {scenes.map((s) => (
                    <tr key={s.id} style={{ verticalAlign: 'top' }}>
                      <td className="id">{num(s.position, isAr)}</td>
                      {CELL_FIELDS.map((f) => (
                        <td key={f} style={{ padding: 6 }}>
                          {canEdit ? (
                            <SceneTextCell
                              value={(s[f] as string | null) ?? ''}
                              label={isAr ? CELL_LABELS[f].ar : CELL_LABELS[f].en}
                              busy={busy}
                              isAr={isAr}
                              onSave={(v) =>
                                void run(() => saveScene(contentId, { id: s.id, [f]: v || null }))}
                            />
                          ) : (
                            // Screen 07's filled state — plain text, «—» when empty.
                            (s[f] as string | null) || '—'
                          )}
                        </td>
                      ))}
                      <td style={{ padding: 6 }}>
                        {canEdit ? (
                          <div style={{ display: 'flex', gap: 4 }}>
                            {STATUSES.map((st) => (
                              <button
                                key={st}
                                type="button"
                                disabled={busy}
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
                        ) : (
                          // Screen 07: read mode shows ONE pill — never a row of
                          // disabled controls (screen 36's no-refusals rule).
                          <span className={`pill ${STATUS_PILL[s.footage_status]}`}>
                            {isAr ? FOOTAGE_LABELS[s.footage_status]?.ar : FOOTAGE_LABELS[s.footage_status]?.en}
                          </span>
                        )}
                      </td>
                      {canDelete && (
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

            {missing.length > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 10 }}>
                {isAr
                  ? `«ناقصة» هنا هي نفس البيانات التي تعطّل قائمة الاعتماد في النظرة العامة — مصدر واحد، عرضان.`
                  : '"Missing" here is the same data that blocks the approval checklist in Overview — one source, two views.'}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
