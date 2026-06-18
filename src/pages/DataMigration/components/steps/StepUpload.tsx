import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { excelFileToCsvTexts, readExcelFile } from '@/lib/excelUtils';
import {
  Upload,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Sparkles,
  Table,
  X,
  Loader2,
  PlusSquare,
  Building2,
  AlertCircle,
  RotateCcw,
  Lock,
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
  /** Excel/CSV "use as data source" + blank-table paths only — AI extraction
   * completes through the jobRunner (this component may be unmounted by then). */
  onTable: (table: RawTable, sourceFiles?: MigrationUpload[], extras?: ProjectExtras) => void;
}

const EXCEL_EXT = /\.(xlsx|xls|csv)$/i;
const isExcel = (f: File) => EXCEL_EXT.test(f.name) || f.type.includes('sheet') || f.type === 'text/csv';
const isCsv = (f: File) => /\.csv$/i.test(f.name) || f.type === 'text/csv';

/** A persisted upload that came from a spreadsheet — analyze-Excels are stored
 * as per-sheet `.csv`, raw CSVs as themselves. Used to split `source_files`
 * back into the two fields and to render post-reload leftovers under "Excel". */
const isSpreadsheetUpload = (u: MigrationUpload) =>
  u.mimeType.includes('csv') ||
  u.mimeType.includes('sheet') ||
  EXCEL_EXT.test(u.name);

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

/** One Excel/CSV file the user added this session, with its original File kept
 * in memory (needed for the "use as data source" client-side parse) and the
 * `.csv` upload path(s) it produced in the AI set (so analyze can be undone if
 * the user flips it to "use as source", and so removal cleans up storage). */
interface ExcelItem {
  id: string;
  name: string;
  original: File;
  /** Paths of the CSV(s) this Excel produced in `source_files` (multi-sheet → many). */
  paths: string[];
  size: number;
}

/** A drop zone (documents or excel). Forgiving: the drop/pick handler routes
 * files by type, so a file dropped in the "wrong" field still lands right. */
function UploadDropZone({
  inputRef,
  accept,
  icon,
  title,
  hint,
  locked,
  uploading,
  onFiles,
}: {
  inputRef: RefObject<HTMLInputElement>;
  accept: string;
  icon: ReactNode;
  title: string;
  hint: string;
  locked: boolean;
  uploading: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <div
      onDrop={(e) => {
        e.preventDefault();
        if (locked) return;
        onFiles(Array.from(e.dataTransfer.files));
      }}
      onDragOver={(e) => e.preventDefault()}
      onClick={() => !locked && inputRef.current?.click()}
      className={`border-2 border-dashed rounded-2xl p-6 text-center transition-all ${
        locked
          ? 'border-sand/30 bg-charcoal/[0.02] cursor-not-allowed opacity-60'
          : 'border-sand/50 cursor-pointer hover:border-copper/40 hover:bg-copper/[0.02]'
      }`}
    >
      <div className="w-12 h-12 rounded-2xl bg-copper/8 flex items-center justify-center mx-auto mb-2">
        {uploading ? <Loader2 size={22} className="text-copper animate-spin" /> : icon}
      </div>
      <p className="text-sm font-bold text-charcoal mb-0.5">{title}</p>
      <p className="text-xs text-charcoal/40">{hint}</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </div>
  );
}

/**
 * Step "upload" — TWO explicit fields so Excel is never silently forced into
 * one behavior (the old single drop zone hijacked any Excel mixed with other
 * files into AI extraction, and an Excel-only drop into "use directly"):
 *
 *  1. Documents (PDF / screenshots / images) → always AI-extracted by the
 *     module jobRunner. The job keeps running if the user opens another
 *     migration, and any number of migrations can extract concurrently.
 *  2. Excel / CSV → each file gets a per-file choice (default "Analyze with AI",
 *     like every other file; or "Use as data source" — parsed client-side,
 *     straight to review, no AI). The two choices are mutually exclusive at the
 *     step level (block-mixing): "use as data source" is only available when the
 *     Excel is the SOLE file, and selecting it locks the drop zones.
 *
 * Both drop zones are forgiving — a file dropped in the "wrong" one is routed by
 * type. Also "start with a blank table" for fully manual entry.
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
  const docRef = useRef<HTMLInputElement>(null);
  const excelRef = useRef<HTMLInputElement>(null);
  const uploads = sourceFiles ?? [];
  const [busy, setBusy] = useState<'idle' | 'uploading' | 'opening'>('idle');
  // Excel/CSV files added this session — originals held in memory for the
  // "use as data source" path. (A reload drops these; their CSVs persist in
  // source_files and render below as plain analyze rows — no data lost.)
  const [excelItems, setExcelItems] = useState<ExcelItem[]>([]);
  // The one Excel the user chose to "use as data source" (block-mixing → at
  // most one, and only when it's the sole file). null = everything is analyzed.
  const [sourceIntentId, setSourceIntentId] = useState<string | null>(null);
  // Projects target → extraction returns ONE project row (no unit table) plus
  // the Arabic marketing document for the content writers.
  const projectMode = isProjectProfileTarget(model);

  // Split the persisted AI set back into the two fields. In-session excels are
  // tracked separately (with their toggle); leftover spreadsheet uploads not
  // claimed by an ExcelItem are post-reload survivors shown as plain rows.
  const docUploads = uploads.filter((u) => !isSpreadsheetUpload(u));
  const coveredPaths = new Set(excelItems.flatMap((i) => i.paths));
  const leftoverExcel = uploads.filter((u) => isSpreadsheetUpload(u) && !coveredPaths.has(u.path));
  const locked = sourceIntentId !== null;
  // "Use as data source" requires this Excel to be the only thing in the step.
  const soleExcel = (item: ExcelItem) =>
    docUploads.length === 0 &&
    leftoverExcel.length === 0 &&
    excelItems.length === 1 &&
    excelItems[0]!.id === item.id;

  /** Upload a mixed batch into the right field by type. Documents go to the AI
   * set as-is; Excel/CSV is converted to per-sheet CSV (so the model can read
   * it like a PDF) and tracked as an ExcelItem with its analyze choice. */
  const addFiles = async (files: File[]) => {
    if (locked || busy !== 'idle' || files.length === 0) return;
    const excels = files.filter(isExcel);
    const docs = files.filter((f) => !isExcel(f));
    setBusy('uploading');
    try {
      const newUploads: MigrationUpload[] = [];
      for (const f of docs) {
        newUploads.push(await uploadMigrationFile(recordId, f));
      }
      const newItems: ExcelItem[] = [];
      for (const f of excels) {
        const csvs = await excelToAiFiles(f);
        const paths: string[] = [];
        for (const c of csvs) {
          const up = await uploadMigrationFile(recordId, c);
          newUploads.push(up);
          paths.push(up.path);
        }
        newItems.push({ id: uuid(), name: f.name, original: f, paths, size: f.size });
      }
      if (newUploads.length) onSourceFiles([...uploads, ...newUploads]);
      if (newItems.length) setExcelItems((prev) => [...prev, ...newItems]);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy('idle');
    }
  };

  /** Terminal action for the chosen "use as data source" Excel: parse it
   * client-side → straight to review (no AI). Removes its CSV(s) from the AI
   * set first, since this sheet IS the table — it won't be analyzed. */
  const useAsSource = async () => {
    const item = excelItems.find((i) => i.id === sourceIntentId);
    if (!item) return;
    setBusy('opening');
    try {
      const result = await readExcelFile(item.original);
      if (item.paths.length > 1) {
        addToast(
          isAr
            ? 'يحتوي الملف على عدة أوراق — تم استخدام الورقة الأولى فقط. للبقية استخدم الاستخراج بالذكاء.'
            : 'Multi-sheet file — used the first sheet only. For the rest, use AI extraction.',
          'info',
        );
      }
      // Delete this Excel's CSV(s) from the bucket — it's the source now, not
      // analyzed. (No onSourceFiles call: onTable below passes no sourceFiles,
      // which clears source_files in one patch — a second patch here would risk
      // the version-mismatch double-save the wizard was bitten by.)
      void Promise.all(
        item.paths.map((p) =>
          // Orphan left in the bucket on failure — not worth a toast; a GC
          // sweep reclaims it. (Same posture as removeUpload below.)
          deleteMigrationFile(p).catch(() => undefined),
        ),
      );
      // Navigates to review_raw (clearing source_files) → this component
      // unmounts, so no busy reset.
      onTable({ headers: result.headers, rows: result.rows, source: 'excel_upload' });
    } catch {
      addToast(isAr ? 'تعذّرت قراءة الملف' : 'Could not read the file', 'error');
      setBusy('idle');
    }
  };

  const removeExcelItem = async (item: ExcelItem) => {
    if (sourceIntentId === item.id) setSourceIntentId(null);
    setExcelItems((prev) => prev.filter((i) => i.id !== item.id));
    onSourceFiles(uploads.filter((u) => !item.paths.includes(u.path)));
    await Promise.all(
      item.paths.map((p) => deleteMigrationFile(p).catch(() => undefined)),
    );
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

      {/* FIELD 1 — Documents (everything except Excel) → always AI-extracted. */}
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-xs font-bold text-charcoal/70 uppercase tracking-wide">
          {isAr ? '١. المستندات (غير Excel)' : '1. Documents (non-Excel)'}
        </span>
        <span className="text-[11px] text-charcoal/40">
          {isAr ? '— تُحلَّل بالذكاء دائمًا' : '— always analyzed with AI'}
        </span>
      </div>
      <UploadDropZone
        inputRef={docRef}
        accept=".pdf,image/*"
        icon={<Upload size={22} className="text-copper" />}
        title={isAr ? 'اسحب المستندات هنا أو انقر' : 'Drag documents here or click'}
        hint={isAr ? 'PDF، صور، لقطات شاشة' : 'PDF, images, screenshots'}
        locked={locked}
        uploading={busy === 'uploading'}
        onFiles={(files) => void addFiles(files)}
      />
      {docUploads.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {docUploads.map((u) => (
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
              {!locked && (
                <button
                  onClick={() => void removeUpload(u)}
                  className="text-charcoal/30 hover:text-red-500 transition-colors"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* FIELD 2 — Excel / CSV → per-file choice: analyze vs use as data source. */}
      <div className="mt-5 mb-1.5 flex items-center gap-1.5">
        <span className="text-xs font-bold text-charcoal/70 uppercase tracking-wide">
          {isAr ? '٢. ملفات Excel / CSV' : '2. Excel / CSV'}
        </span>
        <span className="text-[11px] text-charcoal/40">
          {isAr ? '— اختر: تحليل أم مصدر للبيانات' : '— choose: analyze or data source'}
        </span>
      </div>
      <UploadDropZone
        inputRef={excelRef}
        accept=".xlsx,.xls,.csv"
        icon={<FileSpreadsheet size={22} className="text-copper" />}
        title={isAr ? 'اسحب ملف Excel هنا أو انقر' : 'Drag an Excel file here or click'}
        hint={isAr ? 'xlsx، xls، csv' : 'xlsx, xls, csv'}
        locked={locked}
        uploading={busy === 'uploading'}
        onFiles={(files) => void addFiles(files)}
      />

      {/* In-session Excel files — each with its analyze / use-as-source choice. */}
      {excelItems.length > 0 && (
        <div className="mt-2.5 space-y-2">
          {excelItems.map((item) => {
            const isSource = sourceIntentId === item.id;
            const canSource = isSource || soleExcel(item);
            return (
              <div
                key={item.id}
                className={`p-2.5 rounded-lg border bg-white ${
                  isSource ? 'border-copper/50 ring-1 ring-copper/20' : 'border-sand/30'
                }`}
              >
                <div className="flex items-center gap-2">
                  <FileSpreadsheet size={16} className="text-copper shrink-0" />
                  <span className="text-sm text-charcoal truncate flex-1">{item.name}</span>
                  <span className="text-xs text-charcoal/40">{(item.size / 1024).toFixed(0)} KB</span>
                  <button
                    onClick={() => void removeExcelItem(item)}
                    className="text-charcoal/30 hover:text-red-500 transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
                {/* The choice — default "Analyze with AI". "Use as data source"
                    is disabled unless this Excel is the only file (block-mixing). */}
                <div className="mt-2 inline-flex rounded-lg border border-sand/40 overflow-hidden text-xs">
                  <button
                    onClick={() => setSourceIntentId(null)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 transition-colors ${
                      isSource
                        ? 'text-charcoal/60 hover:bg-cream'
                        : 'bg-copper text-white'
                    }`}
                  >
                    <Sparkles size={13} />
                    {isAr ? 'تحليل بالذكاء' : 'Analyze with AI'}
                  </button>
                  <button
                    onClick={() => canSource && setSourceIntentId(item.id)}
                    disabled={!canSource}
                    title={
                      canSource
                        ? undefined
                        : isAr
                          ? 'متاح فقط عندما يكون هذا الملف الوحيد — أزل بقية الملفات.'
                          : 'Available only when this is the only file — remove the others.'
                    }
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 border-s border-sand/40 transition-colors ${
                      isSource
                        ? 'bg-copper text-white'
                        : canSource
                          ? 'text-charcoal/60 hover:bg-cream'
                          : 'text-charcoal/25 cursor-not-allowed'
                    }`}
                  >
                    <Table size={13} />
                    {isAr ? 'استخدامه كمصدر للبيانات' : 'Use as data source'}
                  </button>
                </div>
                {isSource && (
                  <p className="mt-1.5 text-[11px] text-charcoal/50">
                    {isAr
                      ? 'سيُستخدم هذا الجدول كما هو — بدون ذكاء، مباشرة إلى المراجعة.'
                      : 'This sheet will be used as-is — no AI, straight to review.'}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Post-reload survivors — spreadsheet uploads with no in-memory original.
          They stay in the AI (analyze) set; "use as source" needs a re-drop. */}
      {leftoverExcel.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {leftoverExcel.map((u) => (
            <div
              key={u.path}
              className="flex items-center gap-2 p-2 rounded-lg border border-sand/30 bg-white"
            >
              <FileSpreadsheet size={16} className="text-copper shrink-0" />
              <span className="text-sm text-charcoal truncate flex-1">{u.name}</span>
              <span className="text-[10px] text-charcoal/40 px-1.5 py-0.5 rounded bg-cream">
                {isAr ? 'تحليل' : 'analyze'}
              </span>
              <span className="text-xs text-charcoal/40">{(u.size / 1024).toFixed(0)} KB</span>
              {!locked && (
                <button
                  onClick={() => void removeUpload(u)}
                  className="text-charcoal/30 hover:text-red-500 transition-colors"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Block-mixing note — a chosen data source locks the rest of the step. */}
      {locked && (
        <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-copper/[0.04] border border-copper/20 text-xs text-charcoal/60">
          <Lock size={13} className="text-copper shrink-0 mt-0.5" />
          {isAr
            ? 'هذا الملف هو مصدر بياناتك. أزل اختياره لإضافة ملفات أخرى أو تحليلها.'
            : 'This file is your data source. Clear its choice to add or analyze other files.'}
        </div>
      )}

      {/* Primary action — "use this sheet" (source) or "extract" (analyze set). */}
      {locked ? (
        <button
          onClick={() => void useAsSource()}
          disabled={busy !== 'idle'}
          className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors font-medium"
        >
          {busy === 'opening' ? <Loader2 size={16} className="animate-spin" /> : <Table size={16} />}
          {isAr ? 'استخدام هذا الجدول' : 'Use this sheet'}
        </button>
      ) : (
        uploads.length > 0 && (
          <button
            onClick={() => void startExtractionJob(recordId)}
            disabled={busy !== 'idle'}
            className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 transition-colors font-medium"
          >
            <Sparkles size={16} />
            {status === 'failed'
              ? isAr ? 'إعادة الاستخراج' : 'Retry extraction'
              : isAr ? 'استخراج البيانات' : 'Extract data'}
          </button>
        )
      )}

      {/* Start blank */}
      <button
        onClick={startBlank}
        className="mt-4 w-full flex items-center justify-center gap-2 text-sm text-charcoal/60 hover:text-copper transition-colors"
      >
        <PlusSquare size={15} />
        {isAr ? 'أو ابدأ بجدول فارغ' : 'Or start with a blank table'}
      </button>
    </div>
  );
}
