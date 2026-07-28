/**
 * Real file upload for the raw-asset library.
 *
 * REUSES the Files subsystem rather than inventing a second storage path:
 * `uploadFile` puts the bytes in the wassel-files bucket and creates the
 * canonical `files` row (with its orphan cleanup on a failed insert), and
 * `signViewUrl` mints the short-lived URL for previews because that bucket is
 * private. mkt_raw_assets then references files.id — one file, one row, many
 * possible uses via mkt_asset_links.
 *
 * Technical metadata (dimensions, duration, orientation) is read from the
 * decoded media in the browser BEFORE upload. It is genuinely measured, so the
 * asset record carries real numbers rather than nulls waiting on a worker that
 * does not exist yet. What is NOT measured here — OCR, transcript, AI
 * description — stays `processing_status = 'not_attempted'`, which is the
 * honest state: nobody has looked, and that is different from "nothing found".
 */
import { useRef, useState } from 'react';
import { UploadCloud, X, FileWarning, CheckCircle2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { uploadFile, MAX_FILE_BYTES } from '@/lib/files/client';
import { saveAsset } from '@/lib/marketingMgmt/client';

const ASSET_TYPES = ['property_photo','property_video','drone_footage','presenter_footage',
  'developer_footage','construction_footage','floor_plan','brochure','logo','audio','voice_over',
  'testimonial','render','ai_generated','screenshot','document','music','brand_template','custom'] as const;

/** Best-effort default so the operator is not classifying every file by hand. */
function guessAssetType(mime: string, name: string): string {
  const n = name.toLowerCase();
  if (/floor|plan|مخطط/.test(n)) return 'floor_plan';
  if (/drone|جوي|درون/.test(n)) return 'drone_footage';
  if (/logo|شعار/.test(n)) return 'logo';
  if (/brochure|كتيب|بروشور/.test(n)) return 'brochure';
  if (mime.startsWith('video/')) return 'property_video';
  if (mime.startsWith('image/')) return 'property_photo';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

interface Probe { width: number | null; height: number | null; duration_ms: number | null }

/** Measure real dimensions/duration from the decoded media, never guess them. */
async function probeMedia(file: File): Promise<Probe> {
  const empty: Probe = { width: null, height: null, duration_ms: null };
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('image/')) {
      return await new Promise<Probe>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, duration_ms: null });
        img.onerror = () => resolve(empty);
        img.src = url;
      });
    }
    if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
      return await new Promise<Probe>((resolve) => {
        const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio') as HTMLVideoElement;
        el.preload = 'metadata';
        el.onloadedmetadata = () => resolve({
          width: el.videoWidth || null, height: el.videoHeight || null,
          duration_ms: Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null,
        });
        el.onerror = () => resolve(empty);
        el.src = url;
      });
    }
    return empty;
  } finally { URL.revokeObjectURL(url); }
}

const orientationOf = (w: number | null, h: number | null) =>
  w && h ? (w > h ? 'landscape' : w < h ? 'portrait' : 'square') : null;

type Status = 'queued' | 'uploading' | 'saving' | 'done' | 'failed';
interface Job { id: string; file: File; status: Status; error?: string; assetName: string }

export default function AssetUploader({ isAr, projectId, onUploaded }: {
  isAr: boolean; projectId?: string | null; onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [assetType, setAssetType] = useState<string>('');   // '' = auto-detect per file
  const [rights, setRights] = useState<string>('owned');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const patch = (id: string, p: Partial<Job>) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...p } : j)));

  const accept = (files: File[]) => {
    if (files.length === 0) return;
    setJobs(files.map((f) => ({
      id: crypto.randomUUID(), file: f, status: 'queued' as Status,
      assetName: f.name.replace(/\.[^.]+$/, ''),
    })));
  };

  const run = async () => {
    setBusy(true);
    for (const j of jobs) {
      if (j.status === 'done') continue;
      // Size is checked here too so the operator sees WHICH file is too big,
      // rather than one generic failure after a long upload.
      if (j.file.size > MAX_FILE_BYTES) {
        patch(j.id, { status: 'failed', error: isAr
          ? `الملف أكبر من ${MAX_FILE_BYTES / 1024 / 1024} ميجابايت`
          : `Larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` });
        continue;
      }
      try {
        patch(j.id, { status: 'uploading' });
        const probe = await probeMedia(j.file);
        const row = await uploadFile(j.file);          // bytes + canonical files row
        patch(j.id, { status: 'saving' });
        await saveAsset({
          file_id: row.id,
          asset_name: j.assetName.trim() || j.file.name,
          asset_type: assetType || guessAssetType(j.file.type, j.file.name),
          project_id: projectId ?? null,
          mime_type: j.file.type || null,
          size_bytes: j.file.size,
          width: probe.width, height: probe.height, duration_ms: probe.duration_ms,
          orientation: orientationOf(probe.width, probe.height),
          usage_rights: rights,
          usage_status: 'available',
          // measured metadata only; OCR/transcript/AI description untouched
          processing_status: 'not_attempted',
        });
        patch(j.id, { status: 'done' });
      } catch (e) {
        patch(j.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    }
    setBusy(false);
    onUploaded();
  };

  const done = jobs.filter((j) => j.status === 'done').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;

  return (
    <div className="mb-3 rounded-xl border border-copper/30 bg-copper/5 p-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); accept([...e.dataTransfer.files]); }}
        onClick={() => inputRef.current?.click()}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        className={`grid cursor-pointer place-items-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${
          dragging ? 'border-copper bg-copper/10' : 'border-sand/70 bg-white hover:border-copper/50'}`}
      >
        <UploadCloud className="h-6 w-6 text-copper/70" />
        <p className="text-[13px] font-medium text-charcoal">
          {isAr ? 'اسحب الملفات هنا أو اضغط للاختيار' : 'Drop files here, or click to choose'}
        </p>
        <p className="text-[11px] text-charcoal/45">
          {isAr ? `صور، فيديو، صوت، مستندات — حتى ${MAX_FILE_BYTES / 1024 / 1024} ميجابايت للملف`
                : `Images, video, audio, documents — up to ${MAX_FILE_BYTES / 1024 / 1024} MB each`}
        </p>
        <input ref={inputRef} type="file" multiple className="hidden"
          onChange={(e) => accept([...(e.target.files ?? [])])} />
      </div>

      {jobs.length > 0 && (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <select value={assetType} onChange={(e) => setAssetType(e.target.value)}
              className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px]">
              <option value="">{isAr ? 'النوع: تلقائي حسب الملف' : 'Type: auto-detect per file'}</option>
              {ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={rights} onChange={(e) => setRights(e.target.value)}
              className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px]">
              <option value="owned">{isAr ? 'حقوق: ملكنا' : 'Rights: owned'}</option>
              <option value="licensed">{isAr ? 'حقوق: مرخّصة' : 'Rights: licensed'}</option>
              <option value="developer_supplied">{isAr ? 'حقوق: من المطوّر' : 'Rights: developer supplied'}</option>
              <option value="restricted">{isAr ? 'حقوق: مقيّدة' : 'Rights: restricted'}</option>
              <option value="unknown">{isAr ? 'حقوق: غير معروفة' : 'Rights: unknown'}</option>
            </select>
            <div className="flex gap-2">
              <Button onClick={run} disabled={busy || jobs.every((j) => j.status === 'done')}>
                {busy ? (isAr ? 'جارٍ الرفع…' : 'Uploading…')
                      : (isAr ? `رفع ${jobs.length}` : `Upload ${jobs.length}`)}
              </Button>
              <Button variant="secondary" onClick={() => setJobs([])} disabled={busy}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <ul className="mt-2 space-y-1">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5">
                <span className="w-4 shrink-0">
                  {j.status === 'done' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    : j.status === 'failed' ? <FileWarning className="h-4 w-4 text-red-600" />
                    : <span className="block h-3 w-3 rounded-full border-2 border-copper/30 border-t-copper animate-spin" />}
                </span>
                <input value={j.assetName} disabled={busy || j.status === 'done'}
                  onChange={(e) => patch(j.id, { assetName: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[12.5px] text-charcoal focus:border-sand/60 focus:outline-none disabled:text-charcoal/50" />
                <span className="shrink-0 text-[10.5px] tabular-nums text-charcoal/40">
                  {(j.file.size / 1024 / 1024).toFixed(1)} MB
                </span>
                {j.error && (
                  <span className="max-w-[45%] shrink-0 truncate text-[10.5px] text-red-600" title={j.error}>
                    {j.error}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {(done > 0 || failed > 0) && (
            <p className="mt-2 text-[11.5px] text-charcoal/55">
              {isAr ? `تم ${done}` : `${done} uploaded`}
              {failed > 0 && (isAr ? ` · فشل ${failed}` : ` · ${failed} failed`)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
