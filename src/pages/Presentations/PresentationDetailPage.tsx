import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  CircleDashed,
  Loader2,
  CheckCircle2,
  XCircle,
  X,
  ExternalLink,
  RefreshCw,
  SkipForward,
  Search,
  List as ListIcon,
  Hammer,
  CheckCheck,
  Sparkles,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { usePresentationJobsPolling } from './hooks/usePresentationJobsPolling';
import type {
  PresentationJob,
  PresentationJobStatus,
  PresentationErrorCode,
  PresentationStepOutput,
  PresentationStepOutputStatus,
  PresentationStepKind,
} from '@/types';

function statusConfig(
  status: PresentationJobStatus,
  isAr: boolean,
): { label: string; className: string; Icon: typeof CircleDashed } {
  switch (status) {
    case 'queued':
      return {
        label: isAr ? 'في قائمة الانتظار' : 'Queued',
        className: 'bg-sand/40 text-charcoal/70',
        Icon: CircleDashed,
      };
    case 'running':
      return {
        label: isAr ? 'قيد التشغيل' : 'Running',
        className: 'bg-gold/30 text-chocolate',
        Icon: Loader2,
      };
    case 'completed':
      return {
        label: isAr ? 'مكتمل' : 'Completed',
        className: 'bg-green-100 text-green-700',
        Icon: CheckCircle2,
      };
    case 'failed':
      return {
        label: isAr ? 'فشل' : 'Failed',
        className: 'bg-red-100 text-red-700',
        Icon: XCircle,
      };
    case 'canceled':
      return {
        label: isAr ? 'ملغى' : 'Canceled',
        className: 'bg-charcoal/10 text-charcoal/60',
        Icon: X,
      };
  }
}

function errorMessage(code: PresentationErrorCode, isAr: boolean): string {
  switch (code) {
    case 'chrome_session_expired':
      return isAr
        ? 'انتهت جلسة paseet.ai. سجّل دخولك في Chrome ثم أعِد المحاولة.'
        : 'paseet.ai session expired. Sign in in Chrome, then retry.';
    case 'drive_upload_failed':
      return isAr
        ? 'تعذّر رفع الملفات إلى Drive. الملفات محفوظة محلياً.'
        : 'Drive upload failed. Files saved locally.';
    case 'claude_error':
      return isAr ? 'خطأ من Claude Code. حاول مرة أخرى.' : 'Claude Code error. Try again.';
    case 'timeout':
      return isAr ? 'تجاوز الوقت المسموح (30 دقيقة).' : 'Timed out after 30 minutes.';
    case 'daemon_restarted':
      return isAr ? 'أعيد تشغيل النظام أثناء التوليد.' : 'Daemon restarted during generation.';
    case 'validation_failed':
      return isAr ? 'بعض المدخلات غير صحيحة.' : 'Some inputs are invalid.';
    case 'unknown':
      return isAr ? 'خطأ غير معروف. راجع التفاصيل.' : 'Unknown error. Check details.';
  }
}

export default function PresentationDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { jobId } = useParams<{ jobId: string }>();
  const {
    presentationJobs,
    presentationTemplates,
    models,
    records,
    language,
    cancelPresentationJob,
    retryPresentationJob,
    retryPresentationStep,
    addToast,
  } = useAppStore();
  const isAr = language === 'ar';

  const job: PresentationJob | null = useMemo(
    () => presentationJobs.find((j) => j.id === jobId) ?? null,
    [presentationJobs, jobId],
  );

  const jobIds = useMemo(() => (job ? [job.id] : []), [job]);
  usePresentationJobsPolling({ jobIds, intervalMs: 1500, enabled: job !== null });

  if (!job) {
    return (
      <div>
        <button
          onClick={() => navigate('/presentations')}
          className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-charcoal mb-6"
        >
          <ArrowRight size={16} className="rtl:rotate-0 ltr:rotate-180" />
          {isAr ? 'قائمة العروض' : 'Back to presentations'}
        </button>
        <div className="card p-8 text-center text-charcoal/40">
          {isAr ? 'لم يتم العثور على العرض المطلوب.' : 'Presentation not found.'}
        </div>
      </div>
    );
  }

  const cfg = statusConfig(job.status, isAr);
  const tpl = presentationTemplates.find((x) => x.id === job.template_id) ?? job.template_snapshot;
  const templateLabel = isAr ? tpl.label_ar : tpl.label_en;

  const recordModel = job.record_model_id
    ? models.find((m) => m.id === job.record_model_id)
    : null;
  const linkedRecord = recordModel && job.record_id
    ? (records[recordModel.id] ?? []).find((r) => r.id === job.record_id) ?? null
    : null;

  const handleRetry = async (): Promise<void> => {
    const fresh = await retryPresentationJob(job.id);
    if (fresh) {
      addToast(isAr ? 'تم إعادة إضافة العرض' : 'Job re-queued', 'success');
      navigate(`/presentations/${fresh.id}`);
    }
  };

  const handleCancel = (): void => {
    cancelPresentationJob(job.id);
    addToast(isAr ? 'تم إلغاء العرض' : 'Job canceled', 'success');
  };

  return (
    <div>
      <button
        onClick={() => navigate('/presentations')}
        className="inline-flex items-center gap-2 text-sm text-charcoal/60 hover:text-charcoal mb-6"
      >
        <ArrowRight size={16} className="rtl:rotate-0 ltr:rotate-180" />
        {isAr ? 'قائمة العروض' : 'Back to presentations'}
      </button>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-charcoal">{templateLabel}</h1>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${cfg.className}`}
            >
              <cfg.Icon size={12} className={job.status === 'running' ? 'animate-spin' : ''} />
              {cfg.label}
            </span>
          </div>
          {linkedRecord && recordModel && (
            <p className="text-sm text-charcoal/50 mt-1">
              {isAr ? recordModel.label_ar : recordModel.label_en}
              <span className="mx-2">·</span>
              <button
                type="button"
                onClick={() => navigate(`/model/${recordModel.name}/${linkedRecord.id}`)}
                className="text-copper hover:text-terracotta"
              >
                {isAr ? 'فتح السجل' : 'Open record'}
              </button>
            </p>
          )}
          {job.progress_message_ar || job.progress_message_en ? (
            <p className="text-xs text-charcoal/40 mt-1">
              {isAr ? job.progress_message_ar : job.progress_message_en}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {job.status === 'queued' && (
            <Button variant="ghost" onClick={handleCancel}>
              <X size={14} />
              {t('common.cancel')}
            </Button>
          )}
          {(job.status === 'failed' || job.status === 'canceled') && (
            <Button onClick={() => void handleRetry()}>
              <RefreshCw size={14} />
              {isAr ? 'إعادة المحاولة' : 'Retry'}
            </Button>
          )}
        </div>
      </div>

      {/* Result (when completed) */}
      {job.status === 'completed' && (() => {
        const localPathEntries = Object.entries(job.result?.local_paths ?? {});
        const hasDriveUrl = !!(job.drive_deck_url || job.drive_folder_url || job.result?.drive_sheet_url);
        const driveUploadFailed = localPathEntries.length > 0 && !hasDriveUrl;
        return (
          <div className={`card p-5 mb-6 ${driveUploadFailed ? 'border-amber-300 bg-amber-50/40' : ''}`}>
            <h3 className="text-sm font-bold text-charcoal mb-3">
              {driveUploadFailed
                ? isAr ? 'فشل الرفع إلى Drive — الملفات محفوظة محلياً' : 'Drive upload failed — files saved locally'
                : isAr ? 'النتيجة' : 'Result'}
            </h3>
            {driveUploadFailed && (
              <p className="text-xs text-amber-800 mb-3">
                {isAr
                  ? 'تعذّر رفع الملفات إلى Google Drive. المسارات التالية محفوظة على الجهاز — انسخها وارفعها يدوياً.'
                  : 'Drive couldn’t accept the upload. Copy these paths from your machine and upload them by hand.'}
              </p>
            )}
            <div className="space-y-2">
              {job.drive_deck_url && (
                <a
                  href={job.drive_deck_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-copper hover:text-terracotta"
                >
                  <ExternalLink size={14} />
                  {isAr ? 'ملف العرض (PowerPoint)' : 'Deck (PowerPoint)'}
                </a>
              )}
              {job.drive_folder_url && (
                <a
                  href={job.drive_folder_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-copper hover:text-terracotta"
                >
                  <ExternalLink size={14} />
                  {isAr ? 'مجلد العرض في Drive' : 'Drive folder'}
                </a>
              )}
              {job.result?.drive_sheet_url && (
                <a
                  href={job.result.drive_sheet_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-copper hover:text-terracotta"
                >
                  <ExternalLink size={14} />
                  {isAr ? 'جدول المصادر' : 'Sources sheet'}
                </a>
              )}
              {localPathEntries.length > 0 && (
                <dl className="space-y-2 pt-2 border-t border-sand/30">
                  {localPathEntries.map(([name, path]) => (
                    <div key={name} className="flex items-start gap-3 text-xs">
                      <dt className="font-bold text-charcoal/70 uppercase tracking-wide shrink-0 pt-0.5 w-20">
                        {name}
                      </dt>
                      <dd className="flex-1 min-w-0 flex items-center gap-2">
                        <code className="flex-1 font-mono text-charcoal/80 bg-white border border-sand/40 rounded px-2 py-1 truncate" title={path}>
                          {path}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(path).then(() => {
                              addToast(isAr ? 'تم نسخ المسار' : 'Path copied', 'success');
                            }).catch(() => {
                              addToast(isAr ? 'تعذّر النسخ' : 'Copy failed', 'error');
                            });
                          }}
                          className="text-copper hover:text-terracotta text-xs font-bold shrink-0"
                        >
                          {isAr ? 'نسخ' : 'Copy'}
                        </button>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {job.result?.research_stats && (
                <p className="text-xs text-charcoal/50 pt-2 border-t border-sand/30">
                  {isAr
                    ? `${job.result.research_stats.filled}/${job.result.research_stats.total} حقل مُعبّأ · ${job.result.research_stats.gaps} ثغرة · ${job.result.research_stats.conflicts} تعارض`
                    : `filled=${job.result.research_stats.filled}/${job.result.research_stats.total} · gaps=${job.result.research_stats.gaps} · conflicts=${job.result.research_stats.conflicts}`}
                </p>
              )}
              {job.result?.warnings && job.result.warnings.length > 0 && (
                <ul className="text-xs text-amber-700 space-y-1 pt-2 border-t border-sand/30">
                  {job.result.warnings.map((w, i) => (
                    <li key={i}>⚠︎ {w}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      })()}

      {/* Error (when failed) */}
      {job.status === 'failed' && (
        <div className="card p-5 mb-6 border-red-200 bg-red-50/50">
          <h3 className="text-sm font-bold text-red-900 mb-2">
            {isAr ? 'خطأ' : 'Error'}
          </h3>
          <p className="text-sm text-red-800">
            {job.error_code
              ? errorMessage(job.error_code, isAr)
              : (job.error_message ?? (isAr ? 'خطأ غير معروف' : 'Unknown error'))}
          </p>
          {job.error_detail && (
            <details className="mt-3">
              <summary className="text-xs text-charcoal/50 cursor-pointer">
                {isAr ? 'تفاصيل فنية' : 'Technical detail'}
              </summary>
              <pre className="mt-2 text-xs font-mono text-charcoal/70 bg-white p-3 rounded-lg border border-sand/40 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                {job.error_detail}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Steps — Phase 3 per-step state. Renders only when the cloud
          worker has actually populated step_outputs (legacy daemon jobs
          carry an empty array). */}
      {job.step_outputs && job.step_outputs.length > 0 && (
        <div className="card p-5 mb-6">
          <h3 className="text-sm font-bold text-charcoal mb-3">
            {isAr ? 'الخطوات' : 'Steps'}
          </h3>
          <div className="space-y-2">
            {job.step_outputs.map((output, idx) => (
              <StepCard
                key={output.step_id}
                output={output}
                idx={idx}
                isAr={isAr}
                jobIsTerminal={
                  job.status === 'completed' ||
                  job.status === 'failed' ||
                  job.status === 'canceled'
                }
                onRetry={() => {
                  if (retryPresentationStep(job.id, output.step_id)) {
                    addToast(
                      isAr
                        ? `إعادة تشغيل الخطوة ${idx + 1}…`
                        : `Re-running step ${idx + 1}…`,
                      'success',
                    );
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Inputs */}
      <div className="card p-5">
        <h3 className="text-sm font-bold text-charcoal mb-3">
          {isAr ? 'المدخلات' : 'Inputs'}
        </h3>
        <dl className="space-y-3">
          {tpl.input_schema.map((input) => {
            const raw = job.inputs[input.name];
            const display =
              raw === null || raw === undefined || raw === ''
                ? '—'
                : typeof raw === 'string'
                  ? raw
                  : JSON.stringify(raw);
            return (
              <div key={input.name}>
                <dt className="text-xs font-bold text-charcoal/50 uppercase tracking-wide">
                  {isAr ? input.label_ar : input.label_en}
                </dt>
                <dd className="mt-1 text-sm text-charcoal whitespace-pre-wrap break-words">
                  {display}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Per-step UI helpers (Phase 3). One card per step in the template's
// pipeline, color-coded by status. Output preview is collapsed behind a
// <details> so a long agent response doesn't crowd the page.
// ────────────────────────────────────────────────────────────────────

const STEP_KIND_ICON: Record<PresentationStepKind, typeof Search> = {
  research: Search,
  outline: ListIcon,
  build: Hammer,
  review: CheckCheck,
  custom: Sparkles,
};

const STEP_KIND_LABEL: Record<PresentationStepKind, { en: string; ar: string }> = {
  research: { en: 'Research', ar: 'بحث' },
  outline: { en: 'Outline', ar: 'هيكلة' },
  build: { en: 'Build', ar: 'بناء' },
  review: { en: 'Review', ar: 'مراجعة' },
  custom: { en: 'Custom', ar: 'مخصص' },
};

function stepStatusConfig(
  status: PresentationStepOutputStatus,
  isAr: boolean,
): { label: string; className: string; Icon: typeof CircleDashed; spin?: boolean } {
  switch (status) {
    case 'pending':
      return {
        label: isAr ? 'في الانتظار' : 'Pending',
        className: 'bg-sand/30 text-charcoal/60',
        Icon: CircleDashed,
      };
    case 'running':
      return {
        label: isAr ? 'قيد التشغيل' : 'Running',
        className: 'bg-gold/30 text-chocolate',
        Icon: Loader2,
        spin: true,
      };
    case 'completed':
      return {
        label: isAr ? 'مكتمل' : 'Done',
        className: 'bg-green-100 text-green-700',
        Icon: CheckCircle2,
      };
    case 'failed':
      return {
        label: isAr ? 'فشل' : 'Failed',
        className: 'bg-red-100 text-red-700',
        Icon: XCircle,
      };
    case 'skipped':
      return {
        label: isAr ? 'مُتجاوز' : 'Skipped',
        className: 'bg-charcoal/5 text-charcoal/40',
        Icon: SkipForward,
      };
  }
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 100) / 10; // one decimal
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const sr = Math.round(s - m * 60);
  return `${m} min ${sr}s`;
}

function StepCard({
  output,
  idx,
  isAr,
  jobIsTerminal,
  onRetry,
}: {
  output: PresentationStepOutput;
  idx: number;
  isAr: boolean;
  /** Show the Retry button only when the parent job has settled. Re-running
   *  while the worker is mid-job would race against its writes. */
  jobIsTerminal: boolean;
  onRetry: () => void;
}): JSX.Element {
  const Icon = STEP_KIND_ICON[output.kind];
  const labels = STEP_KIND_LABEL[output.kind];
  const cfg = stepStatusConfig(output.status, isAr);
  const duration = formatDuration(output.duration_ms);
  // Retry available when the parent job is settled AND this step has actually
  // run (or was skipped because an earlier step blew up). 'pending' means we
  // never got there — let the user retry the upstream blocker instead.
  const canRetry = jobIsTerminal && (
    output.status === 'completed' ||
    output.status === 'failed' ||
    output.status === 'skipped'
  );

  return (
    <div className="rounded-xl border border-sand/40 bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-copper/10 text-copper text-xs font-bold shrink-0">
            {idx + 1}
          </span>
          <Icon size={14} className="text-charcoal/60 shrink-0" />
          <span className="text-sm font-bold text-charcoal truncate">
            {isAr ? labels.ar : labels.en}
          </span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${cfg.className}`}
          >
            <cfg.Icon size={10} className={cfg.spin ? 'animate-spin' : ''} />
            {cfg.label}
          </span>
          {duration && (
            <span className="text-[10px] text-charcoal/40 font-mono">{duration}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {output.drive_url && (
            <a
              href={output.drive_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-copper hover:text-terracotta inline-flex items-center gap-1"
            >
              <ExternalLink size={12} />
              {isAr ? 'افتح' : 'Open'}
            </a>
          )}
          {canRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-charcoal/70 hover:text-copper hover:bg-cream/40"
              title={
                isAr
                  ? 'إعادة تشغيل هذه الخطوة وكل ما يليها'
                  : 'Re-run this step and everything after it'
              }
            >
              <RefreshCw size={12} />
              {isAr ? 'إعادة' : 'Retry'}
            </button>
          )}
        </div>
      </div>

      {output.tool_calls && output.tool_calls.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {output.tool_calls.map((tc, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${
                tc.ok ? 'bg-charcoal/5 text-charcoal/60' : 'bg-red-50 text-red-600'
              }`}
            >
              {tc.name}
              {!tc.ok && '✗'}
            </span>
          ))}
        </div>
      )}

      {output.error && (
        <p className="mt-2 text-xs text-red-700 bg-red-50 rounded p-2">
          {output.error}
        </p>
      )}

      {output.output_text && (
        <details className="mt-2">
          <summary className="text-[10px] text-charcoal/50 cursor-pointer uppercase tracking-wide font-bold">
            {isAr ? 'النص الناتج' : 'Output'}
          </summary>
          <pre className="mt-1 text-xs font-mono text-charcoal/70 bg-cream/30 p-2 rounded whitespace-pre-wrap break-words max-h-48 overflow-auto">
            {output.output_text}
          </pre>
        </details>
      )}
    </div>
  );
}
