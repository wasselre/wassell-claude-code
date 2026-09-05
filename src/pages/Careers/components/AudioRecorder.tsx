import { useEffect, useRef, useState, useCallback } from 'react';
import { Mic, Square, Pause, Play, RotateCcw, Upload, CheckCircle2, AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { uploadCareerFile } from '@/lib/careers/client';
import { AUDIO_MIN_SEC, AUDIO_MAX_SEC } from '@/lib/careers/form';

/**
 * Q9 — record a 1–3 minute voice note directly in the browser, or upload an
 * existing audio file. Handles mic-permission failures, a live timer, pause/
 * resume/stop/re-record, in-browser playback before submission, the min/max
 * duration guard, and a graceful upload fallback when recording is unavailable.
 *
 * The recorded/selected audio is uploaded to the private bucket as soon as it is
 * confirmed; the parent stores only the returned path + duration.
 */

export interface AudioValue {
  path: string;
  durationSec: number;
  size: number;
}

interface Props {
  submissionId: string;
  value: AudioValue | null;
  onChange: (value: AudioValue | null) => void;
}

type Stage = 'idle' | 'recording' | 'paused' | 'review' | 'uploading' | 'done';

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  const MR = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (MR && typeof MR.isTypeSupported === 'function') {
    for (const c of candidates) if (MR.isTypeSupported(c)) return c;
  }
  return '';
}

export default function AudioRecorder({ submissionId, value, onChange }: Props) {
  const recordingSupported = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof (window as unknown as { MediaRecorder?: unknown }).MediaRecorder !== 'undefined';

  const [stage, setStage] = useState<Stage>(value ? 'done' : 'idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const [reviewDuration, setReviewDuration] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const accumRef = useRef(0); // seconds accumulated across pause/resume
  const blobRef = useRef<Blob | null>(null);

  const stopTimer = () => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const cleanupPlayUrl = useCallback(() => {
    setPlayUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  // Full teardown on unmount.
  useEffect(() => () => {
    stopTimer();
    releaseStream();
    if (playUrl) URL.revokeObjectURL(playUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalize = useCallback((blob: Blob, durationSec: number) => {
    blobRef.current = blob;
    cleanupPlayUrl();
    setPlayUrl(URL.createObjectURL(blob));
    setReviewDuration(durationSec);
    setStage('review');
  }, [cleanupPlayUrl]);

  const beginRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const total = accumRef.current + (Date.now() - startedAtRef.current) / 1000;
        releaseStream();
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        finalize(blob, Math.round(total));
      };
      recorderRef.current = rec;
      accumRef.current = 0;
      startedAtRef.current = Date.now();
      rec.start();
      setElapsed(0);
      setStage('recording');
      timerRef.current = window.setInterval(() => {
        const secs = accumRef.current + (Date.now() - startedAtRef.current) / 1000;
        setElapsed(secs);
        if (secs >= AUDIO_MAX_SEC) {
          // Auto-stop at the ceiling.
          stopTimer();
          if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
        }
      }, 250);
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError('تعذّر الوصول إلى الميكروفون. يرجى السماح بالإذن أو رفع ملف صوتي بدلاً من ذلك.');
      } else if (name === 'NotFoundError') {
        setError('لم يتم العثور على ميكروفون. يمكنك رفع ملف صوتي بدلاً من ذلك.');
      } else {
        setError('حدث خطأ أثناء بدء التسجيل. يمكنك رفع ملف صوتي بدلاً من ذلك.');
      }
      releaseStream();
      setStage('idle');
    }
  };

  const pause = () => {
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') {
      rec.pause();
      accumRef.current += (Date.now() - startedAtRef.current) / 1000;
      stopTimer();
      setStage('paused');
    }
  };

  const resume = () => {
    const rec = recorderRef.current;
    if (rec && rec.state === 'paused') {
      rec.resume();
      startedAtRef.current = Date.now();
      setStage('recording');
      timerRef.current = window.setInterval(() => {
        const secs = accumRef.current + (Date.now() - startedAtRef.current) / 1000;
        setElapsed(secs);
        if (secs >= AUDIO_MAX_SEC) {
          stopTimer();
          if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
        }
      }, 250);
    }
  };

  const stop = () => {
    stopTimer();
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  };

  const reset = () => {
    stopTimer();
    releaseStream();
    cleanupPlayUrl();
    blobRef.current = null;
    chunksRef.current = [];
    setElapsed(0);
    setError(null);
    setProgress(0);
    onChange(null);
    setStage('idle');
  };

  const doUpload = async (blob: Blob, durationSec: number, ext: string) => {
    setStage('uploading');
    setProgress(0);
    setError(null);
    try {
      const result = await uploadCareerFile(
        submissionId, 'audio', blob, `recording.${ext}`, (f) => setProgress(f),
      );
      onChange({ path: result.path, durationSec, size: result.size });
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل رفع المقطع الصوتي');
      setStage('review');
    }
  };

  const confirmRecording = () => {
    if (reviewDuration < AUDIO_MIN_SEC) {
      setError('المقطع الصوتي قصير جدًا. الحد الأدنى دقيقة واحدة.');
      return;
    }
    if (!blobRef.current) return;
    const ext = (blobRef.current.type.includes('mp4') ? 'mp4' : blobRef.current.type.includes('ogg') ? 'ogg' : 'webm');
    void doUpload(blobRef.current, reviewDuration, ext);
  };

  const onFilePicked = async (file: File) => {
    setError(null);
    // Best-effort duration read (some containers report Infinity — tolerated).
    const url = URL.createObjectURL(file);
    const durationSec = await new Promise<number>((resolve) => {
      const audio = new Audio();
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const d = audio.duration;
        resolve(Number.isFinite(d) ? Math.round(d) : 0);
      };
      audio.onerror = () => resolve(0);
      audio.src = url;
    });
    URL.revokeObjectURL(url);

    if (durationSec && durationSec < AUDIO_MIN_SEC) {
      setError('المقطع الصوتي قصير جدًا. الحد الأدنى دقيقة واحدة.');
      return;
    }
    if (durationSec && durationSec > AUDIO_MAX_SEC + 5) {
      setError('المقطع الصوتي طويل جدًا. الحد الأقصى ثلاث دقائق.');
      return;
    }
    cleanupPlayUrl();
    setPlayUrl(URL.createObjectURL(file));
    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1) : 'audio';
    setStage('uploading');
    setProgress(0);
    try {
      const result = await uploadCareerFile(submissionId, 'audio', file, file.name || `audio.${ext}`, (f) => setProgress(f));
      onChange({ path: result.path, durationSec, size: result.size });
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل رفع المقطع الصوتي');
      setStage('idle');
    }
  };

  // ── Rendering ──────────────────────────────────────────────────────────────
  const box = 'rounded-2xl border p-5 text-center';
  const borderStyle = { borderColor: 'rgba(212,184,150,0.6)' };

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-start gap-2 rounded-xl px-4 py-3 text-sm text-right" style={{ background: '#8E4E3A12', color: '#8E4E3A' }}>
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {stage === 'done' && value && (
        <div className={box} style={{ ...borderStyle, background: '#10B98108' }}>
          <div className="flex items-center justify-center gap-2 mb-3" style={{ color: '#10B981' }}>
            <CheckCircle2 size={22} />
            <span className="font-bold">تم حفظ التسجيل الصوتي</span>
          </div>
          {value.durationSec > 0 && (
            <p className="text-sm mb-3" style={{ color: '#4A4E54' }} dir="ltr">{fmt(value.durationSec)}</p>
          )}
          {playUrl && <audio src={playUrl} controls className="w-full mb-3" />}
          <button type="button" onClick={reset} className="inline-flex items-center gap-2 text-sm font-bold" style={{ color: '#8E4E3A' }}>
            <RotateCcw size={16} /> إعادة التسجيل
          </button>
        </div>
      )}

      {stage === 'uploading' && (
        <div className={box} style={borderStyle}>
          <div className="flex items-center justify-center gap-2 mb-3" style={{ color: '#B8734F' }}>
            <Loader2 size={20} className="animate-spin" />
            <span className="font-bold">جارٍ رفع التسجيل…</span>
          </div>
          <div className="h-2 w-full rounded-full overflow-hidden" style={{ background: '#EAD9C2' }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(progress * 100)}%`, background: '#B8734F' }} />
          </div>
        </div>
      )}

      {(stage === 'idle') && (
        <div className={box} style={borderStyle}>
          {recordingSupported ? (
            <>
              <button
                type="button"
                onClick={beginRecording}
                className="mx-auto flex h-20 w-20 items-center justify-center rounded-full text-white shadow-lg transition-transform hover:scale-105"
                style={{ background: '#B8734F' }}
                aria-label="بدء التسجيل"
              >
                <Mic size={30} />
              </button>
              <p className="mt-3 text-sm" style={{ color: '#4A4E54' }}>اضغط للبدء بالتسجيل</p>
              <p className="mt-1 text-xs" style={{ color: '#8A8A8A' }}>من دقيقة إلى ثلاث دقائق</p>
            </>
          ) : (
            <p className="text-sm" style={{ color: '#4A4E54' }}>التسجيل المباشر غير متاح على هذا المتصفح. يمكنك رفع ملف صوتي.</p>
          )}

          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'rgba(212,184,150,0.5)' }}>
            <label className="inline-flex items-center gap-2 text-sm font-bold cursor-pointer" style={{ color: '#8E4E3A' }}>
              <Upload size={16} /> رفع ملف صوتي بدلاً من ذلك
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFilePicked(f); e.currentTarget.value = ''; }}
              />
            </label>
          </div>
        </div>
      )}

      {(stage === 'recording' || stage === 'paused') && (
        <div className={box} style={borderStyle}>
          <div className="flex items-center justify-center gap-2 mb-4">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ background: stage === 'recording' ? '#E11D48' : '#B8734F', animation: stage === 'recording' ? 'wassel-pulse 1s ease-in-out infinite' : 'none' }}
            />
            <span className="text-3xl font-bold tabular-nums" style={{ color: '#4A2C2A' }} dir="ltr">{fmt(elapsed)}</span>
            <span className="text-sm" style={{ color: '#8A8A8A' }} dir="ltr">/ {fmt(AUDIO_MAX_SEC)}</span>
          </div>
          <div className="h-1.5 w-full rounded-full overflow-hidden mb-4" style={{ background: '#EAD9C2' }}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, (elapsed / AUDIO_MAX_SEC) * 100)}%`, background: elapsed >= AUDIO_MIN_SEC ? '#10B981' : '#B8734F' }} />
          </div>
          {elapsed < AUDIO_MIN_SEC && (
            <p className="text-xs mb-3" style={{ color: '#8A8A8A' }}>سجّل دقيقة واحدة على الأقل</p>
          )}
          <div className="flex items-center justify-center gap-3">
            {stage === 'recording' ? (
              <button type="button" onClick={pause} className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold" style={{ background: '#F5EDE0', color: '#4A4E54' }}>
                <Pause size={16} /> إيقاف مؤقت
              </button>
            ) : (
              <button type="button" onClick={resume} className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold" style={{ background: '#F5EDE0', color: '#4A4E54' }}>
                <Play size={16} /> استئناف
              </button>
            )}
            <button type="button" onClick={stop} className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white" style={{ background: '#B8734F' }}>
              <Square size={16} /> إيقاف
            </button>
          </div>
        </div>
      )}

      {stage === 'review' && (
        <div className={box} style={borderStyle}>
          <p className="mb-2 text-sm font-bold" style={{ color: '#4A2C2A' }}>استمع إلى تسجيلك قبل المتابعة</p>
          {reviewDuration > 0 && <p className="text-sm mb-2" style={{ color: '#4A4E54' }} dir="ltr">{fmt(reviewDuration)}</p>}
          {playUrl && <audio src={playUrl} controls className="w-full mb-4" />}
          <div className="flex items-center justify-center gap-3">
            <button type="button" onClick={reset} className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold" style={{ background: '#F5EDE0', color: '#8E4E3A' }}>
              <Trash2 size={16} /> إعادة التسجيل
            </button>
            <button type="button" onClick={confirmRecording} className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold text-white" style={{ background: '#B8734F' }}>
              <CheckCircle2 size={16} /> استخدام هذا التسجيل
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
