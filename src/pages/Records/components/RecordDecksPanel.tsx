import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CircleDashed,
  Loader2,
  CheckCircle2,
  XCircle,
  X,
  ExternalLink,
  Presentation,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { PresentationJob, PresentationJobStatus } from '@/types';

interface RecordDecksPanelProps {
  recordId: string;
}

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

function formatDate(iso: string, isAr: boolean): string {
  return new Date(iso).toLocaleString(isAr ? 'ar-SA' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const VISIBLE_LIMIT = 3;

/**
 * Inline panel on the record form showing recent presentation jobs fired
 * against this record. Shows up to the 3 most recent; "see all" links into
 * /presentations filtered by this record (filter UI lands in a later polish
 * pass — for now it just navigates to the job list).
 */
export default function RecordDecksPanel({ recordId }: RecordDecksPanelProps): JSX.Element | null {
  const navigate = useNavigate();
  const { presentationJobs, presentationTemplates, language } = useAppStore();
  const isAr = language === 'ar';

  const jobs: PresentationJob[] = useMemo(
    () =>
      presentationJobs
        .filter((j) => j.record_id === recordId)
        .sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        ),
    [presentationJobs, recordId],
  );

  if (jobs.length === 0) return null;

  const visible = jobs.slice(0, VISIBLE_LIMIT);
  const hidden = jobs.length - visible.length;

  const templateLabel = (job: PresentationJob): string => {
    const live = presentationTemplates.find((tpl) => tpl.id === job.template_id);
    const label = live ?? job.template_snapshot;
    return isAr ? label.label_ar : label.label_en;
  };

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-charcoal flex items-center gap-2">
          <Presentation size={14} className="text-copper" />
          {isAr ? 'العروض المولّدة لهذا السجل' : 'Decks generated for this record'}
        </h3>
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => navigate('/presentations')}
            className="text-xs text-copper hover:text-terracotta"
          >
            {isAr ? `عرض الكل (${jobs.length})` : `see all (${jobs.length})`}
          </button>
        )}
      </div>
      <div className="space-y-2">
        {visible.map((job) => {
          const cfg = statusConfig(job.status, isAr);
          return (
            <button
              key={job.id}
              type="button"
              onClick={() => navigate(`/presentations/${job.id}`)}
              className="w-full flex items-center justify-between gap-3 p-3 rounded-xl border border-sand/30 hover:border-copper/40 hover:bg-cream/30 transition-all text-start"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm text-charcoal truncate">
                    {templateLabel(job)}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold shrink-0 ${cfg.className}`}
                  >
                    <cfg.Icon
                      size={10}
                      className={job.status === 'running' ? 'animate-spin' : ''}
                    />
                    {cfg.label}
                  </span>
                </div>
                <p className="text-xs text-charcoal/50 mt-0.5">
                  {formatDate(job.created_at, isAr)}
                  {(job.progress_message_ar || job.progress_message_en) && (
                    <>
                      <span className="mx-1.5">·</span>
                      <span className="italic">
                        {isAr ? job.progress_message_ar : job.progress_message_en}
                      </span>
                    </>
                  )}
                </p>
              </div>
              {job.drive_deck_url && (
                <a
                  href={job.drive_deck_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-xs text-copper hover:text-terracotta shrink-0"
                  title={isAr ? 'فتح العرض' : 'Open deck'}
                >
                  <ExternalLink size={12} />
                  {isAr ? 'فتح' : 'Open'}
                </a>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
