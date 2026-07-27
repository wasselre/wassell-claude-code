import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Loader2, Copy, ExternalLink, RefreshCw, AlertTriangle, X, Check, ChevronUp, ChevronDown } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  enqueueClientStudy,
  fetchLatestStudyJob,
  type ClaudeJob,
} from '@/lib/claudeJobs/client';

/**
 * «توليد دراسة» — enqueues a claude_jobs client_study for this chat and shows
 * the latest job's status strip. Rep flow:
 *  - optional NOTES box → what to focus on / avoid (fed to the Claude session);
 *  - a progress strip while the runner works (a full headless Claude Code
 *    session, ~10–20 min);
 *  - a review card when ready: open the PDF (also auto-attached to the client's
 *    files), copy the WhatsApp draft, dismiss the summary (X), or generate a
 *    fresh study. Nothing is sent to the client automatically.
 */
export default function StudyJobCard({ chatRecordId }: { chatRecordId: string }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const [job, setJob] = useState<ClaudeJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState('');
  const [summaryDismissed, setSummaryDismissed] = useState(false);
  // Collapse the whole study section to reclaim chat height. Persisted GLOBALLY
  // (one preference across all chats) so it stays how the rep left it.
  const COLLAPSE_KEY = 'wassell_study_card_collapsed';
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const setCollapsedPersist = (v: boolean) => {
    try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
    setCollapsed(v);
  };
  const jobRef = useRef<ClaudeJob | null>(null);
  jobRef.current = job;

  // Per-job "summary dismissed" flag, persisted so it stays hidden across reloads.
  const dismissKey = (id: string) => `wassell_study_summary_dismissed_${id}`;

  const refresh = useCallback(async () => {
    try {
      const j = await fetchLatestStudyJob(chatRecordId);
      setJob(j);
      if (j) {
        try {
          setSummaryDismissed(localStorage.getItem(dismissKey(j.id)) === '1');
        } catch { /* private mode — treat as not dismissed */ }
      }
      const prev = jobRef.current;
      if (j && prev && prev.id === j.id && prev.status !== 'ready' && j.status === 'ready') {
        addToast(
          useAppStore.getState().language === 'ar' ? 'الدراسة جاهزة — راجعها قبل الإرسال' : 'Study ready — review before sending',
          'success',
        );
      }
    } catch (err) {
      console.error('[StudyJobCard] fetch failed:', err);
    }
  }, [chatRecordId, addToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const active = job && (job.status === 'pending' || job.status === 'running');
    if (!active) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [job, refresh]);

  // Start a study. When a ready study already exists this is a feedback-driven
  // REGENERATE — the typed text is passed as feedback and the prior job id as
  // revision_of, so the runner tells the session to address the feedback.
  const start = async (regenerateOf?: string) => {
    setBusy(true);
    try {
      await enqueueClientStudy(chatRecordId, currentUserId, notes, regenerateOf ?? null);
      addToast(
        isAr ? 'بدأنا الدراسة — تاخذ عادة ١٠–٢٠ دقيقة' : 'Study started — usually takes 10–20 minutes',
        'success',
      );
      setNotes('');
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

  const dismissSummary = () => {
    if (!job) return;
    try { localStorage.setItem(dismissKey(job.id), '1'); } catch { /* ignore */ }
    setSummaryDismissed(true);
  };

  const active = job && (job.status === 'pending' || job.status === 'running');
  const ready = job?.status === 'ready' && !!job.result;

  // Collapsed → a slim one-line bar that reclaims the chat height; a dot marks
  // a ready study waiting behind it. Expanding restores the full section.
  if (collapsed) {
    return (
      <div className="px-3 pt-1 shrink-0">
        <button
          onClick={() => setCollapsedPersist(false)}
          className="w-full flex items-center justify-center gap-1 rounded-md border border-sand/60 bg-cream/40 py-0.5 text-[10px] text-charcoal/45 hover:text-copper hover:border-copper/40 transition-colors"
          title={isAr ? 'إظهار قسم الدراسة' : 'Show study section'}
        >
          <ChevronDown size={11} />
          {isAr ? 'الدراسة' : 'Study'}
          {ready ? <span className="text-copper font-bold">•</span> : null}
        </button>
      </div>
    );
  }

  return (
    <div className="px-3 pt-2 shrink-0">
      {/* Collapse toggle — hide the whole section for a bigger chat. */}
      <div className="flex justify-end -mt-1 -mb-0.5">
        <button
          onClick={() => setCollapsedPersist(true)}
          className="text-charcoal/30 hover:text-copper transition-colors"
          title={isAr ? 'إخفاء قسم الدراسة (لتكبير المحادثة)' : 'Hide study section for a bigger chat'}
        >
          <ChevronUp size={14} />
        </button>
      </div>
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
      {ready && job.result && (
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
          {/* Saved-to-client note */}
          {job.result.attached_file_id && (
            <p className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-charcoal/45">
              <Check size={10} className="text-green-600" />
              {isAr ? 'محفوظة في ملفات العميل' : 'Saved to the client’s files'}
            </p>
          )}
          {/* Summary — dismissable with X */}
          {job.result.summary && !summaryDismissed && (
            <div className="mt-1.5 flex items-start gap-1.5">
              <p className="flex-1 text-[11px] leading-relaxed text-charcoal/70">{job.result.summary}</p>
              <button
                onClick={dismissSummary}
                className="shrink-0 mt-0.5 text-charcoal/30 hover:text-red-500 transition-colors"
                title={isAr ? 'إزالة الملخص' : 'Remove summary'}
              >
                <X size={12} />
              </button>
            </div>
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

      {/* Instructions (first run) OR feedback → regenerate (after a study is
          ready). One always-visible field; the label, placeholder, and button
          switch on whether a ready study exists. Hidden only mid-run. */}
      {!active && (
        <div className="flex flex-col gap-1 mt-2">
          {ready && (
            <span className="text-[10.5px] font-medium text-copper">
              {isAr ? 'ملاحظاتك لتحسين الدراسة (اختياري)' : 'Your feedback to improve the study (optional)'}
            </span>
          )}
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            dir="auto"
            placeholder={ready
              ? (isAr
                  ? 'مثال: ركّز أكثر على العروض الجديدة، أضف صفحة مسافات، اجعلها صفحة واحدة…'
                  : 'e.g. Focus more on new listings, add a distances page, keep it to one page…')
              : (isAr
                  ? 'تعليمات الدراسة (اختياري) — مثال: قارن فقط بالشقق تحت مليون في الياسمين، وتجاهل العروض القديمة…'
                  : 'Study instructions (optional) — e.g. compare only apartments under 1M in Al-Yasmin, ignore old listings…')}
            className="input w-full text-[12px] leading-relaxed"
            disabled={busy}
          />
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => start(ready ? job!.id : undefined)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full border border-copper/40 bg-copper/10 px-2.5 py-1 text-[11px] font-medium text-copper transition-colors hover:bg-copper/20 disabled:opacity-50"
              title={ready
                ? (isAr ? 'إعادة توليد الدراسة مع ملاحظاتك' : 'Regenerate the study with your feedback')
                : (isAr ? 'دراسة سوق مخصصة لسؤال هذا العميل — تُنشأ بالذكاء الاصطناعي وتراجعها قبل الإرسال' : 'AI market study for this client’s question — you review before sending')}
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : ready ? <RefreshCw size={12} /> : <FileText size={12} />}
              {ready
                ? (isAr ? 'إعادة التوليد' : 'Regenerate')
                : (isAr ? 'توليد دراسة' : 'Generate study')}
            </button>
            {job?.status === 'failed' && (
              <span className="inline-flex items-center gap-1 text-[11px] text-red-600" title={job.error ?? undefined}>
                <AlertTriangle size={12} />
                {isAr ? 'فشلت آخر دراسة — جرّب من جديد' : 'Last study failed — try again'}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
