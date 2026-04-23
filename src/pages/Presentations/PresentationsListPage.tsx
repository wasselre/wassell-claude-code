import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Presentation as PresentationIcon,
  ExternalLink,
  CircleDashed,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  X,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { usePresentationJobsPolling } from './hooks/usePresentationJobsPolling';
import TemplatePickerModal from './components/TemplatePickerModal';
import type { PresentationJob, PresentationJobStatus } from '@/types';

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

function DaemonOfflineBanner({
  lastSeen,
  isAr,
}: {
  lastSeen: string | null;
  isAr: boolean;
}): JSX.Element | null {
  const ageMs = lastSeen ? Date.now() - new Date(lastSeen).getTime() : null;
  const offline = ageMs === null || ageMs > 60_000;
  if (!offline) return null;

  const ago = (() => {
    if (ageMs === null) return isAr ? 'لم يسبق تشغيله' : 'never seen';
    const mins = Math.floor(ageMs / 60_000);
    if (mins < 1) return isAr ? 'قبل أقل من دقيقة' : '<1 min ago';
    if (mins < 60) return isAr ? `قبل ${mins} دقيقة` : `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    return isAr ? `قبل ${hrs} ساعة` : `${hrs} h ago`;
  })();

  return (
    <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-300 bg-amber-50 mb-6">
      <AlertTriangle size={20} className="text-amber-600 shrink-0 mt-0.5" />
      <div className="flex-1 text-sm text-amber-900">
        <p className="font-bold">
          {isAr
            ? 'خدمة العروض غير مشغّلة حالياً'
            : 'Presentations daemon is not running'}
        </p>
        <p className="mt-1 text-amber-800/80">
          {isAr
            ? `الطلبات ستبقى في قائمة الانتظار حتى يتم تشغيل الخدمة على جهازك. آخر نشاط: ${ago}.`
            : `Queued jobs will stay pending until you start the daemon on your machine. Last seen: ${ago}.`}
        </p>
      </div>
    </div>
  );
}

function formatDate(iso: string, isAr: boolean): string {
  const d = new Date(iso);
  return d.toLocaleString(isAr ? 'ar-SA' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function PresentationsListPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    presentationJobs,
    presentationTemplates,
    records,
    models,
    daemonStatus,
    language,
  } = useAppStore();
  const isAr = language === 'ar';

  const [pickerOpen, setPickerOpen] = useState(false);

  usePresentationJobsPolling({ intervalMs: 3000 });

  const sortedJobs = useMemo(
    () =>
      [...presentationJobs].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [presentationJobs],
  );

  const recordLabel = (job: PresentationJob): string | null => {
    if (!job.record_id) return null;
    const untitled = isAr ? 'بدون اسم' : '(Untitled)';
    const modelId = job.record_model_id;
    const model = modelId ? models.find((m) => m.id === modelId) : null;
    if (!model) return untitled;
    const rec = (records[model.id] ?? []).find((r) => r.id === job.record_id);
    if (!rec) return untitled;
    const titleId = model.card_config.title_field_id;
    const titleField = titleId
      ? model.schema.sections.flatMap((s) => s.fields).find((f) => f.id === titleId)
      : null;
    if (titleField) {
      const v = rec.data[titleField.name];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number') return String(v);
    }
    // Don't scan other fields — lookups / section_mirrors store UUIDs that
    // look like strings but aren't human-readable. Show explicit "untitled".
    return untitled;
  };

  const templateLabel = (job: PresentationJob): string => {
    const live = presentationTemplates.find((tpl) => tpl.id === job.template_id);
    const snap = job.template_snapshot;
    const label = live ?? snap;
    return isAr ? label.label_ar : label.label_en;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-charcoal">
          {t('presentations.title')}
        </h1>
        <Button onClick={() => setPickerOpen(true)}>
          <Plus size={16} />
          {t('presentations.new')}
        </Button>
      </div>

      <DaemonOfflineBanner
        lastSeen={daemonStatus?.last_heartbeat_at ?? null}
        isAr={isAr}
      />

      {sortedJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
          <PresentationIcon size={48} className="mb-4" />
          <p className="text-lg font-bold">{t('presentations.empty_title')}</p>
          <p className="text-sm">{t('presentations.empty_hint')}</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {sortedJobs.map((job) => {
            const cfg = statusConfig(job.status, isAr);
            const rec = recordLabel(job);
            return (
              <button
                key={job.id}
                type="button"
                onClick={() => navigate(`/presentations/${job.id}`)}
                className="card p-5 flex items-center justify-between hover:border-copper/40 transition-all text-start"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <h3 className="font-bold text-charcoal truncate">{templateLabel(job)}</h3>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${cfg.className}`}
                    >
                      <cfg.Icon
                        size={12}
                        className={job.status === 'running' ? 'animate-spin' : ''}
                      />
                      {cfg.label}
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-charcoal/50">
                    {rec ? (
                      <span>{rec}</span>
                    ) : (
                      <span className="italic">{isAr ? 'بدون سجل' : 'no record'}</span>
                    )}
                    <span className="mx-2">·</span>
                    <span>{formatDate(job.created_at, isAr)}</span>
                  </div>
                  {job.progress_message_ar || job.progress_message_en ? (
                    <p className="text-xs text-charcoal/40 mt-1">
                      {isAr ? job.progress_message_ar : job.progress_message_en}
                    </p>
                  ) : null}
                </div>
                {job.drive_deck_url && (
                  <a
                    href={job.drive_deck_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="ms-4 inline-flex items-center gap-1.5 text-sm text-copper hover:text-terracotta"
                  >
                    <ExternalLink size={14} />
                    {isAr ? 'فتح' : 'Open'}
                  </a>
                )}
              </button>
            );
          })}
        </div>
      )}

      <TemplatePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onJobQueued={(jobId) => navigate(`/presentations/${jobId}`)}
      />
    </div>
  );
}
