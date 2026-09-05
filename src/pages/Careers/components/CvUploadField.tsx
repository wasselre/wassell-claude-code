import { useRef, useState } from 'react';
import { FileText, UploadCloud, CheckCircle2, AlertTriangle, Loader2, X, RefreshCw } from 'lucide-react';
import { uploadCareerFile } from '@/lib/careers/client';

/**
 * Q8 — CV upload (PDF / DOC / DOCX). Shows the selected filename, upload
 * progress, a success state, and lets the applicant replace or remove the file.
 * Client-side accept + size guards are convenience only; the /submit endpoint
 * re-validates the real bytes server-side.
 */

export interface CvValue {
  path: string;
  name: string;
  size: number;
  mime: string;
}

interface Props {
  submissionId: string;
  value: CvValue | null;
  onChange: (value: CvValue | null) => void;
}

const ACCEPT = '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_BYTES = 10 * 1024 * 1024;
const EXT_OK = new Set(['pdf', 'doc', 'docx']);

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ب`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} كب`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} مب`;
}

export default function CvUploadField({ submissionId, value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string>('');

  const pick = () => inputRef.current?.click();

  const onFile = async (file: File) => {
    setError(null);
    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!EXT_OK.has(ext)) {
      setError('نوع الملف غير مدعوم. يُقبل PDF أو DOC أو DOCX فقط.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('حجم الملف كبير جدًا. الحد الأقصى 10 ميجابايت.');
      return;
    }
    setPendingName(file.name);
    setUploading(true);
    setProgress(0);
    try {
      const result = await uploadCareerFile(submissionId, 'cv', file, file.name, (f) => setProgress(f));
      onChange({ path: result.path, name: file.name, size: result.size, mime: file.type });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل رفع الملف');
    } finally {
      setUploading(false);
    }
  };

  const remove = () => {
    onChange(null);
    setPendingName('');
    setError(null);
    setProgress(0);
  };

  const borderStyle = { borderColor: 'rgba(212,184,150,0.6)' };

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-start gap-2 rounded-xl px-4 py-3 text-sm text-right" style={{ background: '#8E4E3A12', color: '#8E4E3A' }}>
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.currentTarget.value = ''; }}
      />

      {value && !uploading ? (
        <div className="rounded-2xl border p-4 flex items-center gap-3" style={{ ...borderStyle, background: '#10B98108' }}>
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl" style={{ background: '#10B98118' }}>
            <FileText size={22} style={{ color: '#10B981' }} />
          </div>
          <div className="flex-1 min-w-0 text-right">
            <p className="font-bold truncate" style={{ color: '#4A2C2A' }}>{value.name}</p>
            <p className="text-xs flex items-center gap-1 justify-end" style={{ color: '#10B981' }}>
              <CheckCircle2 size={13} /> تم الرفع · {humanSize(value.size)}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" onClick={pick} className="p-2 rounded-lg" style={{ color: '#8E4E3A' }} aria-label="استبدال الملف" title="استبدال">
              <RefreshCw size={17} />
            </button>
            <button type="button" onClick={remove} className="p-2 rounded-lg" style={{ color: '#8E4E3A' }} aria-label="إزالة الملف" title="إزالة">
              <X size={18} />
            </button>
          </div>
        </div>
      ) : uploading ? (
        <div className="rounded-2xl border p-4" style={borderStyle}>
          <div className="flex items-center gap-3 mb-3">
            <Loader2 size={20} className="animate-spin" style={{ color: '#B8734F' }} />
            <span className="font-bold text-sm truncate flex-1 text-right" style={{ color: '#4A2C2A' }}>{pendingName || 'جارٍ الرفع…'}</span>
            <span className="text-sm tabular-nums" style={{ color: '#B8734F' }} dir="ltr">{Math.round(progress * 100)}%</span>
          </div>
          <div className="h-2 w-full rounded-full overflow-hidden" style={{ background: '#EAD9C2' }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(progress * 100)}%`, background: '#B8734F' }} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          className="w-full rounded-2xl border-2 border-dashed p-8 flex flex-col items-center gap-3 transition-colors hover:bg-white/50"
          style={{ borderColor: 'rgba(184,115,79,0.4)' }}
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full" style={{ background: '#B8734F14' }}>
            <UploadCloud size={26} style={{ color: '#B8734F' }} />
          </div>
          <span className="font-bold" style={{ color: '#4A2C2A' }}>اختر ملف السيرة الذاتية</span>
          <span className="text-xs" style={{ color: '#8A8A8A' }}>PDF أو DOC أو DOCX · حتى 10 ميجابايت</span>
        </button>
      )}
    </div>
  );
}
