import { useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { excelFileToCsvTexts, readExcelFile } from '@/lib/excelUtils';
import {
  Upload,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Sparkles,
  X,
  Loader2,
  PlusSquare,
  Building2,
  AlertCircle,
  RotateCcw,
} from 'lucide-react';
import {
  uploadMigrationFile,
  deleteMigrationFile,
  type MigrationUpload,
} from '../../lib/client';
import { startExtractionJob, useMigrationJobs } from '../../lib/jobRunner';
import { isProjectProfileTarget } from '../../lib/types';
import type { RawTable, ProjectIntelligenceSection, MigrationStatus } from '../../lib/types';
import type { AppModel } from '@/types';

/** PROJECT-PROFILE mode extras returned alongside the table. */
export interface ProjectExtras {
  projectDocument?: string;
  projectIntelligence?: ProjectIntelligenceSection[];
}

interface StepUploadProps {
  isAr: boolean;
  recordId: string;
  /** The chosen target model — its fields are sent to extraction as a
   * "what to look for" hunt-list (extraction is model-aware). */
  model: AppModel;
  /** Persisted uploads (record.data.source_files) — survives navigation, so an
   * extraction started here can be watched/retried from any later visit. */
  sourceFiles: MigrationUpload[] | undefined;
  onSourceFiles: (files: MigrationUpload[]) => void;
  status: MigrationStatus | undefined;
  errorMessage: string | null | undefined;
  /** Excel/CSV + blank-table paths only — AI extraction completes through the
   * jobRunner (this component may be unmounted by then). */
  onTable: (table: RawTable, sourceFiles?: MigrationUpload[], extras?: ProjectExtras) => void;
}

const EXCEL_EXT = /\.(xlsx|xls|csv)$/i;
const isExcel = (f: File) => EXCEL_EXT.test(f.name) || f.type.includes('sheet') || f.type === 'text/csv';
const isCsv = (f: File) => /\.csv$/i.test(f.name) || f.type === 'text/csv';

/** Convert one Excel/CSV File into the File(s) that join the AI extraction
 * set: a .csv passes through as-is; an .xlsx/.xls becomes one CSV file per
 * non-empty sheet (Claude can't ingest raw workbooks — text it can). */
async function excelToAiFiles(f: File): Promise<File[]> {
  if (isCsv(f)) return [f];
  const base = f.name.replace(EXCEL_EXT, '');
  const sheets = await excelFileToCsvTexts(f);
  return sheets.map(
    (s) =>
      new File(
        [s.csv],
        sheets.length === 1 ? `${base}.csv` : `${base} — ${s.sheetName}.csv`,
        { type: 'text/csv' },
      ),
  );
}

/**
 * Step "upload" — two entry modes from one drop zone:
 *  (a) clean Excel/CSV → parsed client-side (no AI) → straight to review
 *      (the "start at step 5" path the user asked for).
 *  (b) PDF / screenshots / images / messy Excel → uploaded to storage, then
 *      AI-extracted by the module jobRunner — the job keeps running if the
 *      user opens another migration, and any number of migrations can extract
 *      concurrently. Excel joins this path as per-sheet CSV text.
 * An Excel-only drop asks which mode you want (direct table vs AI); Excel
 * mixed with PDFs/images goes to AI extraction together with them.
 * Also "start with a blank table" for fully manual entry.
 */
export default function StepUpload({
  isAr,
  recordId,
  model,
  sourceFiles,
  onSourceFiles,
  status,
  errorMessage,
  onTable,
}: StepUploadProps) {
  const addToast = useAppStore((s) => s.addToast);
  const job = useMigrationJobs((s) => s.jobs[recordId]);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploads = sourceFiles ?? [];
  const [busy, setBusy] = useState<'idle' | 'uploading'>('idle');
  // An Excel-only drop with nothing uploaded yet → ask the user which mode
  // they want (use the table directly vs AI extraction) before doing anything.
  const [pendingExcel, setPendingExcel] = useState<File[] | null>(null);
  // Projects target → extraction returns ONE project row (no unit table) plus
  // the Arabic marketing document for the content writers.
  const projectMode = isProjectProfileTarget(model);

  /** Fast path: parse the first Excel client-side → straight to review (no AI). */
  const useExcelDirectly = async (excels: File[]) => {
    setPendingExcel(null);
    try {
      const result = await readExcelFile(excels[0]!);
      if (excels.length > 1) {
        addToast(
          isAr
            ? `تم استخدام "${excels[0]!.name}" فقط. للجداول المتعددة استخدم الاستخراج بالذكاء.`
            : `Used only "${excels[0]!.name}". For multiple sheets, use AI extraction.`,
          'info',
        );
      }
      onTable({ headers: result.headers, rows: result.rows, source: 'excel_upload' });
    } catch {
      addToast(isAr ? 'تعذّرت قراءة الملف' : 'Could not read the file', 'error');
    }
  };

  /** Upload a mixed batch into the AI extraction set — Excel converted to
   * per-sheet CSV text so the model can read it like a PDF. */
  const addToAiSet = async (files: File[]) => {
    setPendingExcel(null);
    setBusy('uploading');
    try {
      const added: MigrationUpload[] = [];
      for (const f of files) {
        const toUpload = isExcel(f) ? await excelToAiFiles(f) : [f];
        for (const u of toUpload) {
          added.push(await uploadMigrationFile(recordId, u));
        }
      }
      onSourceFiles([...uploads, ...added]);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy('idle');
    }
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const excels = files.filter(isExcel);

    // Excel/CSV only, nothing uploaded yet → let the user pick the mode.
    // (Already in AI mode — files uploaded — Excel just joins the AI set.)
    if (excels.length === files.length && uploads.length === 0) {
      setPendingExcel(excels);
      return;
    }
    await addToAiSet(files);
  };

  const removeUpload = async (u: MigrationUpload) => {
    onSourceFiles(uploads.filter((x) => x.path !== u.path));
    try {
      await deleteMigrationFile(u.path);
    } catch {
      // Orphan left in the bucket — not worth a toast; a GC sweep can reclaim it.
    }
  };

  const startBlank = () =>
    onTable({
      headers: [isAr ? 'عمود 1' : 'Column 1', isAr ? 'عمود 2' : 'Column 2', isAr ? 'عمود 3' : 'Column 3'],
      rows: [['', '', '']],
      source: 'manual',
    });

  if (job?.kind === 'extract') {
    return (
      <div className="flex flex-col items-center justify-center text-center p-12 gap-3">
        <Loader2 size={32} className="text-copper animate-spin" />
        <div className="font-semibold text-charcoal">
          {isAr ? 'جارٍ استخراج البيانات…' : 'Extracting data…'}
        </div>
        <p className="text-sm text-charcoal/50 max-w-sm">
          {projectMode
            ? isAr
              ? 'يقرأ Claude ملفات المشروع بالكامل، يستخرج معلوماته العامة، ويكتب الوثيقة التسويقية. قد يستغرق هذا بضع دقائق.'
              : 'Claude is reading the whole project, extracting its general information, and writing the marketing document. This can take a few minutes.'
            : isAr
              ? 'يقرأ Claude ملفاتك ويحوّلها إلى جدول واحد. قد يستغرق هذا دقيقة.'
              : 'Claude is reading your files into one table. This can take a minute.'}
        </p>
        <p className="text-xs text-charcoal/40 max-w-sm">
          {isAr
            ? 'يستمر الاستخراج في الخلفية — يمكنك فتح ترحيل آخر أو بدء واحد جديد الآن.'
            : 'Extraction keeps running in the background — you can open or start another migration now.'}
        </p>
      </div>
    );
  }

  if (status === 'extracting') {
    // Record says extracting but no job runs in this tab — a reload (or
    // another tab) interrupted the run. Files are persisted, so retry is safe.
    return (
      <div className="flex flex-col items-center justify-center text-center p-12 gap-3">
        <div className="w-14 h-14 rounded-full bg-gold/15 flex items-center justify-center">
          <AlertCircle size={28} className="text-gold" />
        </div>
        <div className="font-semibold text-charcoal">
          {isAr ? 'توقّف الاستخراج' : 'Extraction was interrupted'}
        </div>
        <p className="text-sm text-charcoal/60 max-w-md">
          {isAr
            ? 'انقطع الاستخراج (غالبًا بسبب إعادة تحميل الصفحة). ملفاتك محفوظة — أعد تشغيله.'
            : 'The run was interrupted (usually a page reload). Your files are saved — run it again.'}
        </p>
        <button
          onClick={() => void startExtractionJob(recordId)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-copper text-white hover:bg-terracotta transition-colors"
        >
          <RotateCcw size={15} />
          {isAr ? 'إعادة الاستخراج' : 'Retry extraction'}
        </button>
      </div>
    );
  }

  return (
    <div className="p-5">
      {/* Extraction failed → loud banner; the persisted files below + the
          extract button double as the retry path. */}
      {status === 'failed' && errorMessage && (
        <div className="mb-3 flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-red-50 border border-red-200 text-sm text-charcoal/80">
          <AlertCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-charcoal">
              {isAr ? 'فشل الاستخراج: ' : 'Extraction failed: '}
            </span>
            {errorMessage}
          </div>
        </div>
      )}
      {/* PROJECT-PROFILE mode explainer — the projects target behaves differently. */}
      {projectMode && (
        <div className="mb-3 flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-gold/[0.08] border border-gold/30 text-sm text-charcoal/80">
          <Building2 size={18} className="text-gold shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-charcoal">
              {isAr ? 'وضع ملف المشروع: ' : 'Project profile mode: '}
            </span>
            {isAr
              ? 'سيستخرج Claude معلومات المشروع العامة بالتفصيل (صفًا واحدًا — بدون جدول وحدات)، ويبني تحليلًا شاملًا للمشروع (التموضع، الجمهور، التصميم، الأسعار…)، ويكتب وثيقة معرفية تسويقية بالعربية تُحفظ في سجل المشروع لتكون المرجع الدائم لفرق المبيعات والمحتوى والتسويق.'
              : "Claude will extract the project's general information in detail (one row — no units table), build a project intelligence briefing (positioning, audience, design, pricing…), and write an Arabic project knowledge document saved on the record as the permanent source of truth for sales, content, and marketing."}
          </div>
        </div>
      )}
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
          {isAr ? 'Excel/CSV → مباشرة أو بالذكاء' : 'Excel/CSV → direct or AI'}
        </div>
        <div className="flex items-center gap-1.5">
          <ImageIcon size={14} className="text-copper/70" />
          {isAr ? 'PDF/صور → استخراج ذكي' : 'PDF/images → AI extraction'}
        </div>
      </div>

      {/* Excel-only drop → choose the mode before anything happens. */}
      {pendingExcel && (
        <div className="mt-5 p-4 rounded-xl border border-copper/30 bg-copper/[0.03]">
          <div className="flex items-start gap-2">
            <FileSpreadsheet size={18} className="text-copper shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-charcoal">
                {isAr ? 'كيف تريد قراءة هذا الملف؟' : 'How should this file be read?'}
              </div>
              <div className="text-xs text-charcoal/50 truncate">
                {pendingExcel.map((f) => f.name).join('، ')}
              </div>
            </div>
            <button
              onClick={() => setPendingExcel(null)}
              className="text-charcoal/30 hover:text-red-500 transition-colors shrink-0"
            >
              <X size={15} />
            </button>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              onClick={() => void addToAiSet(pendingExcel)}
              disabled={busy !== 'idle'}
              className="flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles size={15} />
                {isAr ? 'استخراج بالذكاء' : 'Extract with AI'}
              </span>
              <span className="text-[11px] opacity-80">
                {isAr ? 'لملف فوضوي أو متعدد الأوراق — يُقرأ مثل PDF' : 'Messy or multi-sheet — read like a PDF'}
              </span>
            </button>
            <button
              onClick={() => void useExcelDirectly(pendingExcel)}
              className="flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg border border-sand/50 text-charcoal hover:bg-cream transition-colors"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <FileSpreadsheet size={15} />
                {isAr ? 'استخدام الجدول مباشرة' : 'Use table directly'}
              </span>
              <span className="text-[11px] text-charcoal/50">
                {isAr ? 'لجدول نظيف — بدون ذكاء، فورًا' : 'Clean sheet — no AI, instant'}
              </span>
            </button>
          </div>
        </div>
      )}

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
                ) : u.mimeType.includes('csv') || /\.csv$/i.test(u.name) ? (
                  <FileSpreadsheet size={16} className="text-copper shrink-0" />
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
            onClick={() => void startExtractionJob(recordId)}
            disabled={busy !== 'idle'}
            className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors font-medium"
          >
            <Sparkles size={16} />
            {status === 'failed'
              ? isAr ? 'إعادة الاستخراج' : 'Retry extraction'
              : isAr ? 'استخراج البيانات' : 'Extract data'}
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
