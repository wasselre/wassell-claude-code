import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { readExcelFile, mapImportedRows } from '@/lib/excelUtils';
import { findBestSimilarMatch, normalizeBasic, normalizePhone, type ExistingEntry } from '@/lib/similarity';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { Upload, FileSpreadsheet, Check, Link2, AlertTriangle, Plus, X } from 'lucide-react';
import type { AppModel, AppRecord } from '@/types';

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
  model: AppModel;
}

type Step = 'upload' | 'mapping' | 'review' | 'done';

// A row whose duplicate-check value is NOT an exact match to any existing
// record, but is close enough (per `findBestSimilarMatch`) that the user
// should decide case-by-case. Captures both sides of the comparison so the
// review UI can show them without re-deriving anything.
interface NearDuplicate {
  key: string; // stable key for the decisions map — `row-${index}`
  data: Record<string, unknown>; // the full mapped row to import (or skip)
  incomingDisplay: string; // raw incoming value of the dup-check field
  existingDisplay: string; // raw existing-record value (same field)
  score: number; // 0..1 similarity — shown as a % to the user
}

export default function ImportModal({ open, onClose, model }: ImportModalProps) {
  const { t } = useTranslation();
  const { saveRecord, addToast, language, records } = useAppStore();
  const isAr = language === 'ar';
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mappings, setMappings] = useState<Record<number, string | null>>({});
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);

  // Pending state captured when the user confirms the mapping step. We hold
  // onto it across the review step so per-row decisions can be applied without
  // re-running classification.
  const [pendingNew, setPendingNew] = useState<Record<string, unknown>[]>([]);
  const [pendingNearDuplicates, setPendingNearDuplicates] = useState<NearDuplicate[]>([]);
  const [pendingLookupRecords, setPendingLookupRecords] = useState<AppRecord[]>([]);
  const [pendingExactSkipped, setPendingExactSkipped] = useState(0);
  // Per-near-duplicate user decision — default 'skip' so the cautious path
  // wins if the user clicks confirm without touching anything.
  const [decisions, setDecisions] = useState<Record<string, 'add' | 'skip'>>({});

  // Mirror fields are derived at render time — excluded from import mapping.
  const allFields = model.schema.sections.flatMap((s) => s.fields).filter((f) => f.type !== 'mirror');

  // Mapping targets: ranges expose two entries (min/max) so users can wire the
  // two halves of a range to separate source columns.
  const mappingOptions: { key: string; value: string; label: string }[] = allFields.flatMap((f) => {
    const base = isAr ? f.label_ar : f.label_en;
    if (f.type === 'range') {
      return [
        { key: `${f.id}.min`, value: `${f.name}.min`, label: `${base} — ${t('fields.range_min')}` },
        { key: `${f.id}.max`, value: `${f.name}.max`, label: `${base} — ${t('fields.range_max')}` },
      ];
    }
    return [{ key: f.id, value: f.name, label: base }];
  });

  const handleFileSelect = async (file: File) => {
    try {
      const result = await readExcelFile(file);
      setFileName(file.name);
      setHeaders(result.headers);
      setRows(result.rows);

      // Auto-map columns by matching header names to field labels. For range
      // fields, detect a min/max marker in the header and map to the right half —
      // works whether the marker wraps the label (`Min Area`) or trails it
      // (`Area Min`). If a range field matches but the marker is missing, leave
      // the column unmapped so the user picks explicitly.
      const MIN_MARKER = /(^|[\s_(\[\-])(min|minimum|أدنى|من)([\s_)\]\-]|$)/i;
      const MAX_MARKER = /(^|[\s_(\[\-])(max|maximum|أعلى|إلى)([\s_)\]\-]|$)/i;
      const stripMarker = (s: string) => s.replace(MIN_MARKER, ' ').replace(MAX_MARKER, ' ').replace(/\s+/g, ' ').trim();
      const fieldMatches = (f: typeof allFields[number], header: string) => {
        const hl = header.toLowerCase().trim();
        return (
          f.label_ar === header ||
          f.label_en.toLowerCase() === hl ||
          f.name === hl ||
          f.label_ar.includes(header) ||
          f.label_en.toLowerCase().includes(hl)
        );
      };
      const autoMappings: Record<number, string | null> = {};
      result.headers.forEach((header, idx) => {
        let match = allFields.find((f) => fieldMatches(f, header));
        // Second pass for ranges: strip a min/max marker and retry matching.
        // Handles headers like "Min Area" where the raw header doesn't contain the field label.
        if (!match) {
          const core = stripMarker(header);
          if (core && core !== header) {
            match = allFields.find((f) => f.type === 'range' && fieldMatches(f, core));
          }
        }
        if (!match) { autoMappings[idx] = null; return; }
        if (match.type === 'range') {
          if (MIN_MARKER.test(header)) autoMappings[idx] = `${match.name}.min`;
          else if (MAX_MARKER.test(header)) autoMappings[idx] = `${match.name}.max`;
          else autoMappings[idx] = null; // ambiguous — user must pick min or max
          return;
        }
        autoMappings[idx] = match.name;
      });
      setMappings(autoMappings);
      setStep('mapping');
    } catch {
      addToast(isAr ? 'خطأ في قراءة الملف' : 'Error reading file', 'error');
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) void handleFileSelect(file);
  };

  // Classify mapped rows against existing records on the duplicate-check field.
  // Three outcomes per row:
  //   - exact match → auto-skip (counted, not queued)
  //   - similar (but not exact) → queued for the review step
  //   - new (no close match) → queued to import unconditionally
  // When no duplicate-check field is set OR no similar matches are found, we
  // bypass the review step and go straight to `done`.
  const handleImport = () => {
    const { data: mappedData, newLookupRecords } = mapImportedRows(rows, mappings, allFields, records);

    const dupFieldId = model.schema.duplicate_check_field_id ?? null;
    const dupField = dupFieldId ? allFields.find((f) => f.id === dupFieldId) : null;
    const dupSlug = dupField?.name ?? null;
    const isPhone = dupField?.type === 'phone';
    const normalize = (v: unknown): string =>
      isPhone ? normalizePhone(v) : normalizeBasic(v);

    // Build existing entries once — exact lookup set + a list for similarity.
    const exactSet = new Set<string>();
    const existingEntries: ExistingEntry[] = [];
    if (dupSlug) {
      for (const rec of records[model.id] ?? []) {
        const raw = rec.data[dupSlug];
        const key = normalize(raw);
        if (!key) continue;
        exactSet.add(key);
        existingEntries.push({
          recordId: rec.id,
          rawValue: raw === null || raw === undefined ? '' : String(raw),
          normalizedValue: key,
        });
      }
    }

    const newRecords: Record<string, unknown>[] = [];
    const nearDupes: NearDuplicate[] = [];
    let exactSkipped = 0;

    for (let i = 0; i < mappedData.length; i++) {
      const data = mappedData[i]!;
      if (Object.keys(data).length === 0) continue;

      if (!dupSlug) {
        newRecords.push(data);
        continue;
      }
      const raw = data[dupSlug];
      const key = normalize(raw);
      if (!key) {
        // Row doesn't carry the duplicate-check field — import as-is.
        newRecords.push(data);
        continue;
      }
      if (exactSet.has(key)) {
        exactSkipped++;
        continue;
      }

      const match = dupField
        ? findBestSimilarMatch(String(raw ?? ''), dupField.type, existingEntries)
        : null;

      if (match) {
        nearDupes.push({
          key: `row-${i}`,
          data,
          incomingDisplay: String(raw ?? ''),
          existingDisplay: match.rawValue,
          score: match.score,
        });
        // Treat the near-duplicate's normalized value as claimed too — if a
        // second incoming row matches the same existing record, it'll surface
        // as its own review entry rather than silently duplicating.
      } else {
        newRecords.push(data);
        exactSet.add(key); // guard against within-file exact duplicates
      }
    }

    // No near-duplicates to review → straight-through path (same UX as before).
    if (nearDupes.length === 0) {
      for (const rec of newLookupRecords) saveRecord(rec);
      for (const data of newRecords) {
        saveRecord({
          id: uuid(),
          model_id: model.id,
          data,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      finishImportToast(newRecords.length, exactSkipped, 0, newLookupRecords.length);
      setImportedCount(newRecords.length);
      setSkippedCount(exactSkipped);
      setStep('done');
      return;
    }

    // Queue for the review step.
    setPendingNew(newRecords);
    setPendingNearDuplicates(nearDupes);
    setPendingLookupRecords(newLookupRecords);
    setPendingExactSkipped(exactSkipped);
    // Default each decision to 'skip' — the conservative choice.
    const initialDecisions: Record<string, 'add' | 'skip'> = {};
    for (const nd of nearDupes) initialDecisions[nd.key] = 'skip';
    setDecisions(initialDecisions);
    setStep('review');
  };

  const finalizeImport = () => {
    for (const rec of pendingLookupRecords) saveRecord(rec);
    for (const data of pendingNew) {
      saveRecord({
        id: uuid(),
        model_id: model.id,
        data,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    let addedFromReview = 0;
    let skippedFromReview = 0;
    for (const nd of pendingNearDuplicates) {
      if (decisions[nd.key] === 'add') {
        saveRecord({
          id: uuid(),
          model_id: model.id,
          data: nd.data,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        addedFromReview++;
      } else {
        skippedFromReview++;
      }
    }
    const totalImported = pendingNew.length + addedFromReview;
    const totalSkipped = pendingExactSkipped + skippedFromReview;
    finishImportToast(totalImported, totalSkipped, 0, pendingLookupRecords.length);
    setImportedCount(totalImported);
    setSkippedCount(totalSkipped);
    setStep('done');
  };

  const finishImportToast = (
    imported: number,
    skipped: number,
    _reserved: number,
    linkedCount: number,
  ) => {
    const linkedNote = linkedCount > 0
      ? (isAr ? ` و${linkedCount} سجل مرتبط جديد` : ` (+${linkedCount} new linked records)`)
      : '';
    const skippedNote = skipped > 0
      ? (isAr ? ` (تم تخطي ${skipped} مكرر)` : ` (${skipped} duplicates skipped)`)
      : '';
    addToast(
      isAr
        ? `تم استيراد ${imported} سجل بنجاح${linkedNote}${skippedNote}`
        : `Successfully imported ${imported} records${linkedNote}${skippedNote}`,
      'success',
    );
  };

  const setAllDecisions = (choice: 'add' | 'skip') => {
    const next: Record<string, 'add' | 'skip'> = {};
    for (const nd of pendingNearDuplicates) next[nd.key] = choice;
    setDecisions(next);
  };

  const mappedCount = Object.values(mappings).filter(Boolean).length;

  // Name of the field chosen as the duplicate-check key, shown as a banner in
  // the mapping step so users know rows matching this key will be skipped.
  const dupCheckFieldName = (() => {
    const id = model.schema.duplicate_check_field_id;
    if (!id) return null;
    const f = allFields.find((x) => x.id === id);
    if (!f) return null;
    return isAr ? f.label_ar : f.label_en;
  })();

  const resetAndClose = () => {
    setStep('upload');
    setFileName('');
    setHeaders([]);
    setRows([]);
    setMappings({});
    setImportedCount(0);
    setSkippedCount(0);
    setPendingNew([]);
    setPendingNearDuplicates([]);
    setPendingLookupRecords([]);
    setPendingExactSkipped(0);
    setDecisions({});
    onClose();
  };

  const addCount = Object.values(decisions).filter((d) => d === 'add').length;

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title={isAr ? 'استيراد بيانات' : 'Import Data'}
      maxWidth="max-w-2xl"
      footer={
        step === 'mapping' ? (
          <>
            <Button variant="ghost" onClick={() => setStep('upload')}>
              {t('common.back')}
            </Button>
            <Button onClick={handleImport} disabled={mappedCount === 0}>
              <Check size={16} />
              {isAr ? `استيراد ${rows.length} سجل` : `Import ${rows.length} records`}
            </Button>
          </>
        ) : step === 'review' ? (
          <>
            <Button variant="ghost" onClick={() => setStep('mapping')}>
              {t('common.back')}
            </Button>
            <Button onClick={finalizeImport}>
              <Check size={16} />
              {isAr
                ? `تأكيد (${pendingNew.length + addCount} سجل)`
                : `Confirm (${pendingNew.length + addCount} records)`}
            </Button>
          </>
        ) : step === 'done' ? (
          <Button onClick={resetAndClose}>{t('common.close')}</Button>
        ) : undefined
      }
    >
      {/* STEP 1: Upload */}
      {step === 'upload' && (
        <div>
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-sand/50 rounded-2xl p-12 text-center cursor-pointer hover:border-copper/40 hover:bg-copper/[0.02] transition-all"
          >
            <div className="w-16 h-16 rounded-2xl bg-copper/8 flex items-center justify-center mx-auto mb-4">
              <Upload size={28} className="text-copper" />
            </div>
            <p className="text-base font-bold text-charcoal mb-1">
              {isAr ? 'اسحب الملف هنا أو انقر للتحميل' : 'Drag file here or click to upload'}
            </p>
            <p className="text-sm text-charcoal/40">
              {isAr ? 'يدعم ملفات Excel (.xlsx) و CSV' : 'Supports Excel (.xlsx) and CSV files'}
            </p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelect(file);
            }}
          />
        </div>
      )}

      {/* STEP 2: Column Mapping */}
      {step === 'mapping' && (
        <div>
          {/* File info bar */}
          <div className="flex items-center gap-3 p-4 bg-cream-light rounded-xl mb-6">
            <div className="w-10 h-10 rounded-xl bg-copper/10 flex items-center justify-center">
              <FileSpreadsheet size={20} className="text-copper" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-bold text-charcoal">{fileName}</div>
              <div className="text-xs text-charcoal/40">
                {isAr ? `تم العثور على ${rows.length} سجل` : `Found ${rows.length} records`}
              </div>
            </div>
            <button
              onClick={() => setStep('upload')}
              className="text-sm text-copper hover:text-terracotta font-bold"
            >
              {isAr ? 'تغيير الملف' : 'Change file'}
            </button>
          </div>

          {/* Duplicate-check notice — informs the user about skipped rows */}
          {dupCheckFieldName && (
            <div className="mb-4 px-4 py-2.5 rounded-xl bg-copper/[0.06] border border-copper/20 text-xs text-charcoal/70">
              {isAr
                ? `سيتم تخطي السجلات المكررة بناءً على الحقل: `
                : `Duplicates will be skipped based on field: `}
              <span className="font-bold text-copper">{dupCheckFieldName}</span>
            </div>
          )}

          {/* Mapping header */}
          <div className="flex items-center gap-2 mb-4">
            <Link2 size={18} className="text-charcoal/40" />
            <h3 className="font-bold text-charcoal">
              {isAr ? 'ربط الأعمدة' : 'Column Mapping'}
            </h3>
          </div>

          {/* Mapping grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[400px] overflow-y-auto">
            {headers.map((header, idx) => {
              const mapped = mappings[idx];
              const isMapped = !!mapped;
              return (
                <div
                  key={idx}
                  className={`p-4 rounded-xl border transition-colors ${
                    isMapped
                      ? 'border-copper/20 bg-copper/[0.02]'
                      : 'border-sand/20 bg-white'
                  }`}
                >
                  <div className="text-sm font-bold text-charcoal mb-0.5">{header}</div>
                  <select
                    value={mapped ?? '__skip__'}
                    onChange={(e) => {
                      const val = e.target.value === '__skip__' ? null : e.target.value;
                      setMappings((prev) => ({ ...prev, [idx]: val }));
                    }}
                    className="form-input text-sm py-1.5 mt-1"
                  >
                    <option value="__skip__">
                      {isAr ? 'تجاهل هذا العمود' : 'Skip this column'}
                    </option>
                    {mappingOptions.map((o) => (
                      <option key={o.key} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {isMapped && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-green-600 font-bold">
                      <Check size={12} />
                      {isAr ? 'تم الربط' : 'Mapped'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* STEP 3: Review near-duplicates */}
      {step === 'review' && (
        <div>
          <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200 mb-4">
            <AlertTriangle size={20} className="text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm text-charcoal/80 leading-relaxed">
              <div className="font-bold text-charcoal mb-1">
                {isAr
                  ? `وجدنا ${pendingNearDuplicates.length} سجل مشابه لسجلات موجودة`
                  : `Found ${pendingNearDuplicates.length} records similar to existing ones`}
              </div>
              <div className="text-xs text-charcoal/60">
                {isAr
                  ? 'اختر ما إذا كنت تريد إضافة كل منها كسجل جديد أو تخطيه. سيتم استيراد السجلات الجديدة تلقائيًا.'
                  : 'Choose whether to add each as a new record or skip it. Truly new records will be imported automatically.'}
              </div>
              {(pendingNew.length > 0 || pendingExactSkipped > 0) && (
                <div className="text-xs text-charcoal/50 mt-2">
                  {isAr
                    ? `${pendingNew.length} سجل جديد سيتم إضافته${pendingExactSkipped > 0 ? ` • ${pendingExactSkipped} مكرر تمامًا تم تخطيه` : ''}`
                    : `${pendingNew.length} new records will be added${pendingExactSkipped > 0 ? ` • ${pendingExactSkipped} exact duplicates skipped` : ''}`}
                </div>
              )}
            </div>
          </div>

          {/* Bulk action bar */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs text-charcoal/50 font-bold me-1">
              {isAr ? 'تطبيق على الكل:' : 'Apply to all:'}
            </span>
            <button
              onClick={() => setAllDecisions('add')}
              className="text-xs font-bold px-3 py-1.5 rounded-lg bg-copper/10 hover:bg-copper/20 text-copper transition-colors inline-flex items-center gap-1"
            >
              <Plus size={12} />
              {isAr ? 'إضافة الكل' : 'Add all'}
            </button>
            <button
              onClick={() => setAllDecisions('skip')}
              className="text-xs font-bold px-3 py-1.5 rounded-lg bg-charcoal/5 hover:bg-charcoal/10 text-charcoal/60 transition-colors inline-flex items-center gap-1"
            >
              <X size={12} />
              {isAr ? 'تخطي الكل' : 'Skip all'}
            </button>
          </div>

          {/* Near-duplicate rows */}
          <div className="space-y-2 max-h-[400px] overflow-y-auto pe-1">
            {pendingNearDuplicates.map((nd) => {
              const decision = decisions[nd.key] ?? 'skip';
              const pct = Math.round(nd.score * 100);
              return (
                <div
                  key={nd.key}
                  className={`p-3 rounded-xl border transition-colors ${
                    decision === 'add'
                      ? 'border-copper/40 bg-copper/[0.04]'
                      : 'border-sand/20 bg-white'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0 grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider font-bold text-charcoal/40 mb-0.5">
                          {isAr ? 'الوارد' : 'Incoming'}
                        </div>
                        <div className="text-sm font-bold text-charcoal break-all">
                          {nd.incomingDisplay || (isAr ? '(فارغ)' : '(empty)')}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider font-bold text-charcoal/40 mb-0.5 flex items-center gap-1">
                          {isAr ? 'سجل موجود' : 'Existing record'}
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-700 text-[9px] font-bold normal-case tracking-normal">
                            {pct}% {isAr ? 'تطابق' : 'match'}
                          </span>
                        </div>
                        <div className="text-sm font-bold text-charcoal/70 break-all">
                          {nd.existingDisplay || (isAr ? '(فارغ)' : '(empty)')}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => setDecisions((prev) => ({ ...prev, [nd.key]: 'add' }))}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors inline-flex items-center gap-1 ${
                          decision === 'add'
                            ? 'bg-copper text-white'
                            : 'bg-white border border-sand/40 text-charcoal/60 hover:border-copper/40 hover:text-copper'
                        }`}
                      >
                        <Plus size={12} />
                        {isAr ? 'إضافة' : 'Add'}
                      </button>
                      <button
                        onClick={() => setDecisions((prev) => ({ ...prev, [nd.key]: 'skip' }))}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors inline-flex items-center gap-1 ${
                          decision === 'skip'
                            ? 'bg-charcoal text-white'
                            : 'bg-white border border-sand/40 text-charcoal/60 hover:border-charcoal/40 hover:text-charcoal'
                        }`}
                      >
                        <X size={12} />
                        {isAr ? 'تخطي' : 'Skip'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* STEP 4: Done */}
      {step === 'done' && (
        <div className="text-center py-8">
          <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mx-auto mb-4">
            <Check size={32} className="text-green-500" />
          </div>
          <h3 className="text-xl font-bold text-charcoal mb-2">
            {isAr ? 'تم الاستيراد بنجاح!' : 'Import Complete!'}
          </h3>
          <p className="text-charcoal/50">
            {isAr
              ? `تم استيراد ${importedCount} سجل إلى ${model.label_ar}`
              : `Imported ${importedCount} records into ${model.label_en}`}
          </p>
          {skippedCount > 0 && (
            <p className="text-xs text-charcoal/40 mt-2">
              {isAr
                ? `(تم تخطي ${skippedCount} سجل مكرر)`
                : `(${skippedCount} duplicate records skipped)`}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
