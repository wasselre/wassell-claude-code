import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2, Loader2, AlertCircle } from 'lucide-react';
import { uploadAudio, pickAudioMime } from '@/lib/audioUpload';

/**
 * Record a spoken note, upload it to storage, and play it back. Used in the
 * Sales Valuation review screen so a manager can leave a voice note about a
 * mistake instead of (or alongside) typing one.
 *
 * `value` is the saved public audio URL (or ''). On stop the clip is uploaded
 * immediately and `onChange(url)` fires so the parent draft carries the URL;
 * the review is persisted by the parent's Save. Delete clears via onChange(null).
 *
 * Errors are surfaced (mic permission denied, upload failure) — never swallowed
 * (per CLAUDE.md "Silent Failures").
 */
export default function VoiceNoteRecorder({ value, onChange, disabled, isAr }: {
  value: string;
  onChange: (url: string | null) => void;
  disabled?: boolean;
  isAr: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const extRef = useRef<string>('.webm');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up the mic stream + timer if the component unmounts mid-recording.
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  function stopTimer() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

  async function start() {
    setError(null);
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError(isAr ? 'التسجيل الصوتي غير مدعوم في هذا المتصفح' : 'Audio recording is not supported in this browser');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // Permission denied or no mic — surface it, don't swallow.
      console.error('[VoiceNote] getUserMedia failed', e);
      setError(isAr ? 'تعذّر الوصول إلى الميكروفون — تأكد من السماح بالإذن' : 'Could not access the microphone — check the permission');
      return;
    }
    streamRef.current = stream;
    const { mimeType, ext } = pickAudioMime();
    extRef.current = ext;
    const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunksRef.current = [];
    rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data); };
    rec.onstop = () => { void finalize(); };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }

  function stop() {
    stopTimer();
    setRecording(false);
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  async function finalize() {
    const blob = new Blob(chunksRef.current, { type: recorderRef.current?.mimeType || 'audio/webm' });
    chunksRef.current = [];
    if (blob.size === 0) return;
    setUploading(true);
    setError(null);
    try {
      const url = await uploadAudio(blob, extRef.current);
      onChange(url);
    } catch (e) {
      console.error('[VoiceNote] upload failed', e);
      setError(e instanceof Error ? e.message : (isAr ? 'فشل حفظ الملاحظة الصوتية' : 'Failed to save the voice note'));
    } finally {
      setUploading(false);
    }
  }

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <div className="space-y-2">
      {value && !recording && !uploading && (
        <div className="flex items-center gap-3">
          <audio controls src={value} className="h-9 max-w-full" />
          {!disabled && (
            <button type="button" onClick={() => { setError(null); onChange(null); }}
              className="inline-flex items-center gap-1 text-xs font-semibold text-terracotta hover:underline">
              <Trash2 size={14} /> {isAr ? 'حذف' : 'Delete'}
            </button>
          )}
        </div>
      )}

      {!recording && !uploading && (
        <button type="button" disabled={disabled} onClick={start}
          className="inline-flex items-center gap-2 rounded-xl border-2 border-copper/40 px-4 py-2 text-sm font-semibold text-copper hover:bg-copper/10 disabled:opacity-50 disabled:cursor-not-allowed">
          <Mic size={16} /> {value ? (isAr ? 'تسجيل من جديد' : 'Re-record') : (isAr ? 'تسجيل ملاحظة صوتية' : 'Record voice note')}
        </button>
      )}

      {recording && (
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-charcoal">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
            <span dir="ltr" className="tabular-nums">{mmss}</span>
          </span>
          <button type="button" onClick={stop}
            className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600">
            <Square size={14} /> {isAr ? 'إيقاف' : 'Stop'}
          </button>
        </div>
      )}

      {uploading && (
        <span className="inline-flex items-center gap-2 text-sm font-medium text-charcoal/60">
          <Loader2 size={16} className="animate-spin" /> {isAr ? 'جارٍ حفظ الملاحظة الصوتية…' : 'Saving voice note…'}
        </span>
      )}

      {error && (
        <p className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600">
          <AlertCircle size={14} /> {error}
        </p>
      )}
    </div>
  );
}
