/**
 * Floating Job Center indicator — a circle at the side of the app that shows
 * a spinner + count while background jobs run (listing-message generation,
 * media fan-outs, …). Clicking it opens a panel listing every job with live
 * status/progress; finished jobs can be dismissed. Hidden when there are no
 * jobs at all.
 *
 * Also the boot-time rehydrator: once chat_templates records are loaded it
 * re-registers unfinished listing-message drafts as running jobs, so a
 * reloaded tab picks its work back up instead of orphaning it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { getJobs, subscribeJobs, dismissJob, dismissFinishedJobs, type AppJob } from '@/lib/jobs/jobCenter';
import { rehydrateListingJobs } from '@/lib/listingMessage/jobRunner';

export default function JobsIndicator() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const navigate = useNavigate();
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const rehydratedRef = useRef(false);

  useEffect(() => subscribeJobs(() => setTick((n) => n + 1)), []);

  // One-shot rehydration once the chat_templates records have loaded.
  useEffect(() => {
    if (rehydratedRef.current) return;
    const ctModel = models.find((m) => m.name === 'chat_templates');
    if (!ctModel) return;
    const rows = records[ctModel.id];
    if (!rows || rows.length === 0) return;
    rehydratedRef.current = true;
    rehydrateListingJobs();
  }, [models, records]);

  const jobs = getJobs();
  const running = useMemo(() => jobs.filter((j) => j.status === 'running'), [jobs]);
  const finished = useMemo(
    () => jobs.filter((j) => j.status !== 'running').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)),
    [jobs],
  );

  if (jobs.length === 0) return null;

  const openJob = (job: AppJob) => {
    if (!job.href) return;
    setOpen(false);
    navigate(job.href);
  };

  return (
    <div className="fixed bottom-4 start-4 z-[55]" dir={isAr ? 'rtl' : 'ltr'}>
      {/* Panel */}
      {open && (
        <>
          <div className="fixed inset-0 z-[54]" onClick={() => setOpen(false)} />
          <div className="absolute bottom-14 start-0 z-[56] w-80 max-h-[60vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-sand/30 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-bold text-chocolate">
                {isAr ? 'المهام' : 'Jobs'}
                {running.length > 0 && (
                  <span className="text-charcoal/50 font-normal ms-1">
                    {isAr ? `(${running.length} قيد التنفيذ)` : `(${running.length} running)`}
                  </span>
                )}
              </div>
              {finished.length > 0 && (
                <button
                  onClick={dismissFinishedJobs}
                  className="text-[11px] font-medium text-charcoal/50 hover:text-copper"
                  type="button"
                >
                  {isAr ? 'مسح المكتملة' : 'Clear finished'}
                </button>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              {[...running, ...finished].map((job) => (
                <JobRow key={job.id} job={job} isAr={isAr} onOpen={() => openJob(job)} />
              ))}
            </div>
          </div>
        </>
      )}

      {/* The circle */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`relative w-12 h-12 rounded-full shadow-xl border flex items-center justify-center transition-colors ${
          running.length > 0
            ? 'bg-copper text-white border-copper hover:bg-terracotta'
            : 'bg-white text-charcoal/70 border-sand/40 hover:text-copper'
        }`}
        aria-label={isAr ? 'المهام الجارية' : 'Background jobs'}
        title={isAr ? 'المهام الجارية' : 'Background jobs'}
        type="button"
      >
        {running.length > 0 ? (
          <Loader2 size={20} className="animate-spin" />
        ) : finished.some((j) => j.status === 'failed') ? (
          <AlertCircle size={20} className="text-red-500" />
        ) : (
          <CheckCircle2 size={20} className="text-green-600" />
        )}
        {running.length > 0 && (
          <span className="absolute -top-1 -end-1 min-w-[18px] h-[18px] px-1 rounded-full bg-chocolate text-white text-[10px] font-bold flex items-center justify-center">
            {running.length}
          </span>
        )}
      </button>
    </div>
  );
}

function JobRow({ job, isAr, onOpen }: { job: AppJob; isAr: boolean; onOpen: () => void }) {
  const pct =
    job.progress && job.progress.total > 0
      ? Math.round((job.progress.done / job.progress.total) * 100)
      : null;
  return (
    <div className="rounded-xl border border-sand/30 bg-cream/40 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 shrink-0">
          {job.status === 'running' ? (
            <Loader2 size={14} className="animate-spin text-copper" />
          ) : job.status === 'completed' ? (
            <CheckCircle2 size={14} className="text-green-600" />
          ) : (
            <AlertCircle size={14} className="text-red-500" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-charcoal truncate">{job.label}</div>
          {(job.detail || job.error) && (
            <div className={`text-[11px] mt-0.5 truncate ${job.status === 'failed' ? 'text-red-600' : 'text-charcoal/60'}`}>
              {job.status === 'failed' ? job.error : job.detail}
            </div>
          )}
          {pct !== null && job.status === 'running' && (
            <div className="mt-1.5 h-1 rounded-full bg-sand/40 overflow-hidden">
              <div className="h-full bg-copper transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {job.href && (
            <button
              onClick={onOpen}
              className="p-1 rounded text-charcoal/40 hover:text-copper"
              aria-label={isAr ? 'فتح' : 'Open'}
              title={isAr ? 'فتح' : 'Open'}
              type="button"
            >
              <ExternalLink size={12} />
            </button>
          )}
          {job.status !== 'running' && (
            <button
              onClick={() => dismissJob(job.id)}
              className="p-1 rounded text-charcoal/40 hover:text-red-600"
              aria-label={isAr ? 'إزالة' : 'Dismiss'}
              type="button"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
