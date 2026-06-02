import { useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { readExcelFile } from '@/lib/excelUtils';
import {
  Upload,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Sparkles,
  X,
  Loader2,
  PlusSquare,
} from 'lucide-react';
import {
  uploadMigrationFile,
  deleteMigrationFile,
  extractRawTable,
  type MigrationUpload,
} from '../../lib/client';
import type { RawTable } from '../../lib/types';

interface StepUploadProps {
  isAr: boolean;
  recordId: string;
  onTable: (table: RawTable) => void;
}

const EXCEL_EXT = /\.(xlsx|xls|csv)$/i;
const isExcel = (f: File) => EXCEL_EXT.test(f.name) || f.type.includes('sheet') || f.type === 'text/csv';

/**
 * Step "upload" — two entry modes from one drop zone:
 *  (a) clean Excel/CSV → parsed client-side (no AI) → straight to review
 *      (the "start at step 5" path the user asked for).
 *  (b) PDF / screenshots / images → uploaded to storage, then AI-extracted.
 * Also "start with a blank table" for fully manual entry.
 */
export default function StepUpload({ isAr, recordId, onTable }: StepUploadProps) {
  const addToast = useAppStore((s) => s.addToast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<MigrationUpload[]>([]);
  const [busy, setBusy] = useState<'idle' | 'uploading' | 'extracting'>('idle');

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const excels = files.filter(isExcel);
    const aiFiles = files.filter((f) => !isExcel(f));

    // Excel/CSV with no messy files → parse the first one client-side and jump
    // straight to review (no AI, no upload).
    if (excels.length > 0 && aiFiles.length === 0) {
      try {
        const result = await readExcelFile(excels[0]!);
        if (excels.length > 1) {
          addToast(
            isAr
              ? `تم استخدام "${excels[0]!.name}" فقط. ارفع ملفًا واحدًا في كل مرة.`
              : `Used only "${excels[0]!.name}". Upload one sheet at a time.`,
            'info',
          );
        }
        onTable({ headers: result.headers, rows: result.rows, source: 'excel_upload' });
      } catch {
        addToast(isAr ? 'تعذّرت قراءة الملف' : 'Could not read the file', 'error');
      }
      return;
    }

    // PDF / images → upload to storage for AI extraction.
    setBusy('uploading');
    try {
      const added: MigrationUpload[] = [];
      for (const f of aiFiles) {
        added.push(await uploadMigrationFile(recordId, f));
      }
      if (excels.length > 0) {
        addToast(
          isAr
            ? 'تم تجاهل ملفات Excel هنا — ارفعها وحدها لاستخدامها مباشرة.'
            : 'Excel files were skipped here — upload them alone to use directly.',
          'info',
        );
      }
      setUploads((prev) => [...prev, ...added]);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy('idle');
    }
  };

  const removeUpload = async (u: MigrationUpload) => {
    setUploads((prev) => prev.filter((x) => x.path !== u.path));
    try {
      await deleteMigrationFile(u.path);
    } catch {
      // Orphan left in the bucket — not worth a toast; a GC sweep can reclaim it.
    }
  };

  const runExtract = async () => {
    if (uploads.length === 0) return;
    setBusy('extracting');
    try {
      const result = await extractRawTable(uploads);
      if (result.files_skipped.length > 0) {
        addToast(
          (isAr ? 'تم تخطي: ' : 'Skipped: ') +
            result.files_skipped.map((s) => `${s.name} (${s.reason})`).join('، '),
          'info',
        );
      }
      if (result.truncated) {
        addToast(
          isAr
            ? 'البيانات كبيرة — تم استخراج جزء منها فقط. راجع وأكمل، أو قسّم الملف.'
            : 'Large input — only part was extracted. Review, or split the file and retry.',
          'info',
        );
      }
      onTable({
        headers: result.headers,
        rows: result.rows,
        notes: result.notes,
        truncated: result.truncated,
        source: 'ai_extract',
      });
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy('idle');
    }
  };

  const startBlank = () =>
    onTable({
      headers: [isAr ? 'عمود 1' : 'Column 1', isAr ? 'عمود 2' : 'Column 2', isAr ? 'عمود 3' : 'Column 3'],
      rows: [['', '', '']],
      source: 'manual',
    });

  if (busy === 'extracting') {
    return (
      <div className="flex flex-col items-center justify-center text-center p-12 gap-3">
        <Loader2 size={32} className="text-copper animate-spin" />
        <div className="font-semibold text-charcoal">
          {isAr ? 'جارٍ استخراج البيانات…' : 'Extracting data…'}
        </div>
        <p className="text-sm text-charcoal/50 max-w-sm">
          {isAr
            ? 'يقرأ Claude ملفاتك ويحوّلها إلى جدول واحد. قد يستغرق هذا دقيقة.'
            : 'Claude is reading your files into one table. This can take a minute.'}
        </p>
      </div>
    );
  }

  return (
    <div className="p-5">
      <div
        onDrop={(e) => {
          e.preventDefault();
          void handleFiles(e.dataTransfer.files);
        }}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed border-sand/50 rounded-2xl p-10 text-center cursor-pointer hover:border-copper/40 hover:bg-copper/[0.02] transition-all"
      >
        <div className="w-14 h-14 rounded-2xl bg-copper/8 flex items-center justify-center mx-auto mb-3">
          {busy === 'uploading' ? (
            <Loader2 size={26} className="text-copper animate-spin" />
          ) : (
            <Upload size={26} className="text-copper" />
          )}
        </div>
        <p className="text-base font-bold text-charcoal mb-1">
          {isAr ? 'اسحب الملفات هنا أو انقر للرفع' : 'Drag files here or click to upload'}
        </p>
        <p className="text-sm text-charcoal/40">
          {isAr ? 'Excel، CSV، PDF، صور — بأي صيغة' : 'Excel, CSV, PDF, images — any format'}
        </p>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".xlsx,.xls,.csv,.pdf,image/*"
          className="hidden"
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-charcoal/50">
        <div className="flex items-center gap-1.5">
          <FileSpreadsheet size={14} className="text-copper/70" />
          {isAr ? 'Excel/CSV → جدول مباشرة' : 'Excel/CSV → straight to table'}
        </div>
        <div className="flex items-center gap-1.5">
          <ImageIcon size={14} className="text-copper/70" />
          {isAr ? 'PDF/صور → استخراج ذكي' : 'PDF/images → AI extraction'}
        </div>
      </div>

      {/* Uploaded (AI) files awaiting extraction */}
      {uploads.length > 0 && (
        <div className="mt-5">
          <div className="text-sm font-bold text-charcoal mb-2">
            {isAr ? `${uploads.length} ملف للاستخراج` : `${uploads.length} file(s) to extract`}
          </div>
          <div className="space-y-1.5">
            {uploads.map((u) => (
              <div
                key={u.path}
                className="flex items-center gap-2 p-2 rounded-lg border border-sand/30 bg-white"
              >
                {u.mimeType.includes('pdf') ? (
                  <FileText size={16} className="text-copper shrink-0" />
                ) : (
                  <ImageIcon size={16} className="text-copper shrink-0" />
                )}
                <span className="text-sm text-charcoal truncate flex-1">{u.name}</span>
                <span className="text-xs text-charcoal/40">{(u.size / 1024).toFixed(0)} KB</span>
                <button
                  onClick={() => void removeUpload(u)}
                  className="text-charcoal/30 hover:text-red-500 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={() => void runExtract()}
            disabled={busy !== 'idle'}
            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors font-medium"
          >
            <Sparkles size={16} />
            {isAr ? 'استخراج البيانات' : 'Extract data'}
          </button>
        </div>
      )}

      {/* Start blank */}
      <button
        onClick={startBlank}
        className="mt-5 w-full flex items-center justify-center gap-2 text-sm text-charcoal/60 hover:text-copper transition-colors"
      >
        <PlusSquare size={15} />
        {isAr ? 'أو ابدأ بجدول فارغ' : 'Or start with a blank table'}
      </button>
    </div>
  );
}
