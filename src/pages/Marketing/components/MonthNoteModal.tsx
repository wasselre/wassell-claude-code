/**
 * One note on the month grid — the writer's instructions (§3.7).
 *
 * A note attaches to a COORDINATE on the plan, not to a record: the records do
 * not exist until production starts, so the row task reads these live when it
 * opens. Four coordinates, and `lane` separates two of them (decision D7):
 *
 *   month       everything, both lanes
 *   project     one project's rows in ONE lane — organic OR paid, never both
 *   row         one organic row (one day, three posts)
 *   paid_batch  one project's five creatives in one week
 *
 * Clearing the box DELETES the note. That is deliberate: the same pencil that
 * wrote it takes it back, and an empty note row would otherwise sit in the
 * brief panel as a labelled blank.
 */
import { useState } from 'react';
import { Modal } from './kit';

export interface NoteCoord {
  kind: 'month' | 'project' | 'row' | 'paid_batch';
  lane: 'organic' | 'paid' | null;
  project_id: string | null;
  batch_date: string | null;
  /** What the note is ON, in the operator's words — the modal's subtitle. */
  label: string;
}

export default function MonthNoteModal({
  coord, initial, isAr, busy, onSave, onClose,
}: {
  coord: NoteCoord;
  initial: string;
  isAr: boolean;
  busy: boolean;
  onSave: (coord: NoteCoord, body: string) => void;
  onClose: () => void;
}) {
  const [body, setBody] = useState(initial);
  const changed = body.trim() !== initial.trim();

  return (
    <Modal
      title={isAr ? 'ملاحظة للكاتب' : 'A note for the writer'}
      sub={coord.label}
      onClose={onClose}
      footer={(
        <div className="mth-row" style={{ justifyContent: 'space-between', width: '100%' }}>
          <span className="mth-tiny">
            {isAr
              ? 'لا شيء مطلوب هنا، والاعتماد لا ينتظر ملاحظة. إفراغ الصندوق يمسحها.'
              : 'Nothing here is required, and confirming never waits on a note. Emptying the box clears it.'}
          </span>
          <span className="mth-row">
            <button type="button" className="btn btn-sm btn-d" onClick={onClose} disabled={busy}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-p"
              disabled={busy || !changed}
              onClick={() => onSave(coord, body)}
            >
              {busy ? (isAr ? 'يُحفظ…' : 'Saving…') : (isAr ? 'حفظ' : 'Save')}
            </button>
          </span>
        </div>
      )}
    >
      <textarea
        className="btn"
        style={{
          width: '100%', minHeight: 150, fontWeight: 400, lineHeight: 1.9,
          whiteSpace: 'pre-wrap', alignItems: 'start', display: 'block',
        }}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={isAr
          ? 'مثال: هذا الشهر نركّز على قرب التسليم. لا تذكروا أي سعر لم يُعتمد، واذكروا الموقع في كل منشور.'
          : 'e.g. This month we lead on handover date. Quote no price that is not on the approved list, and name the location in every post.'}
      />
    </Modal>
  );
}
