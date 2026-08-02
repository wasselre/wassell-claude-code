/**
 * Scenes — design screen 07, the half the Google Doc always failed at.
 *
 * The strip above the table shows REAL timing: each segment's width is its
 * scene's duration, so a 38-second script cannot quietly become 70. Columns
 * are the design's — التوقيت / الصورة / التعليق الصوتي / نص على الشاشة /
 * التصوير — and footage status stays a first-class control because every
 * scene marked missing is a shot somebody has to go and film.
 */
import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  FOOTAGE_LABELS, MosScene, deleteScene, saveScene, saveShoot,
} from '@/lib/marketingOS/client';
import { IconPlus, IconShoot, IconTrash } from './icons';
import { num, toArabicDigits } from '../lib/format';

const STATUSES: Array<MosScene['footage_status']> = ['have', 'to_make', 'missing', 'template'];
const STATUS_BG: Record<string, string> = {
  have: 'var(--go)',
  to_make: 'var(--wait)',
  missing: 'var(--late)',
  // «قالب» — the shot comes from a template (screen 07, الشعار + واتساب); the
  // mockup paints it in the same wait tone as «تُصنع».
  template: 'var(--wait)',
};
/** The strip's palette cycle — the design's warm sequence, not status colors. */
const STRIP = ['var(--choc)', 'var(--copper)', 'var(--terracotta)', 'var(--copper)', 'var(--gold)', 'var(--choc)'];

/** Seconds of a scene; scenes without timing count as 0 width until timed. */
const duration = (s: MosScene): number =>
  s.start_sec !== null && s.end_sec !== null && s.end_sec > s.start_sec
    ? s.end_sec - s.start_sec
    : 0;

const timeLabel = (s: MosScene, isAr: boolean): string => {
  if (s.start_sec === null || s.end_sec === null) return '—';
  const a = isAr ? toArabicDigits(String(s.start_sec)) : String(s.start_sec);
  const b = isAr ? toArabicDigits(String(s.end_sec)) : String(s.end_sec);
  return isAr ? `${a}–${b}ث` : `${a}–${b}s`;
};

export default function SceneTable({
  contentId, contentTitle, projectId, scenes, canEdit, canRaiseShoot = false, isAr, onChange,
}: {
  contentId: string;
  contentTitle: string;
  projectId: string | null;
  scenes: MosScene[];
  canEdit: boolean;
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
  const totalSeconds = scenes.reduce((a, s) => Math.max(a, s.end_sec ?? 0), 0);
  const timed = scenes.filter((s) => duration(s) > 0);
  const timedTotal = timed.reduce((a, s) => a + duration(s), 0);

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
            ? `${num(scenes.length, true)} مشاهد${totalSeconds > 0 ? ` · ${num(totalSeconds, true)} ثانية` : ''} · ${num(have, true)} من ${num(scenes.length, true)} لديها تصوير`
            : `${scenes.length} scenes${totalSeconds > 0 ? ` · ${totalSeconds}s` : ''} · ${have} of ${scenes.length} have footage`}
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
              ? 'لا مشاهد بعد. مشهد لكل لقطة، بتوقيته — الناقص منها هو ما يصبح طلب تصوير.'
              : 'No scenes yet. One per shot, with its timing — the missing ones are what become a shoot request.'}
          </p>
        ) : (
          <>
            {/* The truth strip: widths ARE the durations. */}
            {timedTotal > 0 && (
              <div className="timeline">
                {timed.map((s, i) => {
                  const d = duration(s);
                  const bg = STRIP[i % STRIP.length] ?? 'var(--copper)';
                  return (
                    <i
                      key={s.id}
                      style={{
                        width: `${(d / timedTotal) * 100}%`,
                        background: bg,
                        color: bg === 'var(--gold)' ? '#4A2A12' : undefined,
                      }}
                      title={s.visual ?? ''}
                    >
                      {isAr ? `${toArabicDigits(String(d))}ث` : `${d}s`}
                    </i>
                  );
                })}
              </div>
            )}

            <div className="tbl-wrap">
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>#</th>
                    <th style={{ width: 96 }}>{isAr ? 'التوقيت' : 'Timing'}</th>
                    <th style={{ width: 180 }}>{isAr ? 'الصورة' : 'The shot'}</th>
                    <th>{isAr ? 'التعليق الصوتي' : 'Voice-over'}</th>
                    <th style={{ width: 150 }}>{isAr ? 'نص على الشاشة' : 'On-screen text'}</th>
                    <th style={{ width: 168 }}>{isAr ? 'التصوير' : 'Footage'}</th>
                    {canEdit && <th style={{ width: 36 }} />}
                  </tr>
                </thead>
                <tbody>
                  {scenes.map((s) => (
                    <tr key={s.id} style={{ verticalAlign: 'top' }}>
                      <td className="id">{num(s.position, isAr)}</td>
                      <td className="num" style={{ padding: 6 }}>
                        {canEdit ? (
                          <span style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }} className="ltr">
                            <input
                              className="inp"
                              style={{ width: 34, padding: '2px 4px', fontSize: 11, textAlign: 'center' }}
                              inputMode="numeric"
                              defaultValue={s.start_sec ?? ''}
                              disabled={busy}
                              onBlur={(e) => {
                                const v = e.target.value.trim() === '' ? null : Number(e.target.value);
                                if (v !== s.start_sec) {
                                  void run(() => saveScene(contentId, { id: s.id, start_sec: v }));
                                }
                              }}
                            />
                            –
                            <input
                              className="inp"
                              style={{ width: 34, padding: '2px 4px', fontSize: 11, textAlign: 'center' }}
                              inputMode="numeric"
                              defaultValue={s.end_sec ?? ''}
                              disabled={busy}
                              onBlur={(e) => {
                                const v = e.target.value.trim() === '' ? null : Number(e.target.value);
                                if (v !== s.end_sec) {
                                  void run(() => saveScene(contentId, { id: s.id, end_sec: v }));
                                }
                              }}
                            />
                          </span>
                        ) : (
                          timeLabel(s, isAr)
                        )}
                      </td>
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
