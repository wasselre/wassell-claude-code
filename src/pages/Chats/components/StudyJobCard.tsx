import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Loader2, Copy, ExternalLink, RefreshCw, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  enqueueClientStudy,
  fetchLatestStudyJob,
  type ClaudeJob,
} from '@/lib/claudeJobs/client';

/**
 * «توليد دراسة» — enqueues a claude_jobs client_study for this chat and shows
 * the latest job's status strip: just the button when no job has run yet,
 * a progress strip while the runner works (a full headless Claude Code
 * session, ~10–20 min), and a review card when ready (open PDF + copy the
 * WhatsApp draft). The rep always reviews before sending — nothing goes to
 * the client automatically.
 */
export default function StudyJobCard({ chatRecordId }: { chatRecordId: string }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const [job, setJob] = useState<ClaudeJob | null>(null);
  const [busy, setBusy] = useState(false);
  const jobRef = useRef<ClaudeJob | null>(null);
  jobRef.current = job;

  const refresh = useCallback(async () => {
    try {
      const j = await fetchLatestStudyJob(chatRecordId);
      setJob(j);
      // Announce the pending→ready flip once.
      const prev = jobRef.current;
      if (j && prev && prev.id === j.id && prev.status !== 'ready' && j.status === 'ready') {
        addToast(
          useAppStore.getState().language === 'ar' ? 'الدراسة جاهزة — راجعها قبل الإرسال' : 'Study ready — review before sending',
          'success',
        );
      }
    } catch (err) {
      // Table read failing is worth a console trace but not a toast loop.
      console.error('[StudyJobCard] fetch failed:', err);
    }
  }, [chatRecordId, addToast]);

  // Initial load + poll while a job is active.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const active = job && (job.status === 'pending' || job.status === 'running');
    if (!active) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [job, refresh]);

  const start = async () => {
    setBusy(true);
    try {
      await enqueueClientStudy(chatRecordId, currentUserId);
      addToast(
        isAr ? 'بدأنا الدراسة — تاخذ عادة ١٠–٢٠ دقيقة' : 'Study started — usually takes 10–20 minutes',
        'success',
      );
      await refresh();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
      console.error('[StudyJobCard] enqueue failed:', err);
    } finally {
      setBusy(false);
    }
  };

  const copyDraft = async () => {
    const draft = job?.result?.whatsapp_draft ?? '';
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      addToast(isAr ? 'نُسخت رسالة الواتساب' : 'WhatsApp draft copied', 'success');
    } catch (err) {
      addToast(isAr ? 'تعذّر النسخ' : 'Copy failed', 'error');
      console.error('[StudyJobCard] clipboard failed:', err);
    }
  };

  const active = job && (job.status === 'pending' || job.status === 'running');

  return (
    <div className="px-3 pt-2 shrink-0">
      {/* Trigger button — hidden while a job is in flight */}
      {!active && (
        <div className="flex items-center gap-2">
          <button
            onClick={start}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-full border border-copper/40 bg-copper/10 px-2.5 py-1 text-[11px] font-medium text-copper transition-colors hover:bg-copper/20 disabled:opacity-50"
            title={isAr ? 'دراسة سوق مخصصة لسؤال هذا العميل — تُنشأ بالذكاء الاصطناعي وتراجعها قبل الإرسال' : 'AI market study for this client’s question — you review before sending'}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
            {isAr ? 'توليد دراسة' : 'Generate study'}
          </button>
          {job?.status === 'failed' && (
            <span className="inline-flex items-center gap-1 text-[11px] text-red-600" title={job.error ?? undefined}>
              <AlertTriangle size={12} />
              {isAr ? 'فشلت آخر دراسة — جرّب من جديد' : 'Last study failed — try again'}
            </span>
          )}
        </div>
      )}

      {/* In-flight strip */}
      {active && (
        <div className="flex items-center gap-2 rounded-xl border border-sand bg-cream/70 px-3 py-2 text-[12px] text-charcoal/70">
          <Loader2 size={14} className="animate-spin text-copper shrink-0" />
          <span className="flex-1">
            {isAr
              ? job?.status === 'running'
                ? 'الدراسة قيد الإعداد الآن — قراءة المحادثة وتحليل السوق…'
                : 'الدراسة في الطابور — تبدأ خلال لحظات…'
              : job?.status === 'running'
                ? 'Study in progress — reading the chat and analyzing the market…'
                : 'Study queued — starting shortly…'}
          </span>
          <button onClick={() => void refresh()} className="text-charcoal/40 hover:text-copper" title={isAr ? 'تحديث' : 'Refresh'}>
            <RefreshCw size={12} />
          </button>
        </div>
      )}

      {/* Ready — review card */}
      {job?.status === 'ready' && job.result && (
        <div className="mt-2 rounded-xl border border-gold/50 bg-white px-3 py-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <FileText size={14} className="text-copper shrink-0" />
            <span className="text-[12px] font-bold text-chocolate flex-1 truncate">
              {job.result.title || (isAr ? 'الدراسة جاهزة' : 'Study ready')}
            </span>
            {job.result.pdf_signed_url && (
              <a
                href={job.result.pdf_signed_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full bg-copper px-2.5 py-1 text-[11px] font-medium text-white hover:bg-terracotta transition-colors"
              >
                <ExternalLink size={11} />
                {isAr ? 'فتح الدراسة' : 'Open study'}
              </a>
            )}
            {job.result.whatsapp_draft && (
              <button
                onClick={() => void copyDraft()}
                className="inline-flex items-center gap-1 rounded-full border border-copper/40 px-2.5 py-1 text-[11px] font-medium text-copper hover:bg-copper/10 transition-colors"
              >
                <Copy size={11} />
                {isAr ? 'نسخ رسالة الواتساب' : 'Copy WhatsApp draft'}
              </button>
            )}
          </div>
          {job.result.summary && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-charcoal/70">{job.result.summary}</p>
          )}
          {(job.result.heads_ups?.length ?? 0) > 0 && (
            <ul className="mt-1 space-y-0.5">
              {job.result.heads_ups!.map((h, i) => (
                <li key={i} className="flex items-start gap-1 text-[11px] text-[#8a6a2f]">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                  {h}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
