import { useMemo, useState } from 'react';
import { ImageOff, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import ImagePreview from '@/components/ui/ImagePreview';

/**
 * One slot per selected template, showing the three phase outputs
 * (cleaned / edited / final) and the slot's status. Triggered by the
 * `generations_gallery` field type on marketing-operations records.
 *
 * Reads from `recordData.generations[templateId]`, written by the
 * orchestrator at api/marketing/generate.ts. Empty / pending slots
 * render placeholder cards with the template name + status.
 */
interface GenerationsGalleryProps {
  templateIds: string[];
  generations: Record<string, unknown>;
  isAr: boolean;
}

interface PhaseShape {
  status?: string;
  cleaned_photo?: string;
  edited_photo?: string;
  final_design?: string;
  error_message?: string;
}

const STATUS_LABELS: Record<string, { ar: string; en: string; tone: 'pending' | 'progress' | 'done' | 'error' }> = {
  pending: { ar: 'في الانتظار', en: 'Pending', tone: 'pending' },
  cleaning: { ar: 'تنظيف الصورة...', en: 'Cleaning...', tone: 'progress' },
  cleanup_failed: { ar: 'فشل التنظيف', en: 'Cleanup failed', tone: 'error' },
  editing: { ar: 'إعادة التأطير...', en: 'Re-framing...', tone: 'progress' },
  editing_failed: { ar: 'فشل التعديل', en: 'Editing failed', tone: 'error' },
  generating: { ar: 'توليد التصميم...', en: 'Generating design...', tone: 'progress' },
  generation_failed: { ar: 'فشل التوليد', en: 'Generation failed', tone: 'error' },
  complete: { ar: 'مكتمل', en: 'Complete', tone: 'done' },
};

export default function GenerationsGallery({ templateIds, generations, isAr }: GenerationsGalleryProps) {
  const { models, records } = useAppStore();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const designTemplates = useMemo(() => {
    const dt = models.find((m) => m.name === 'design_templates');
    if (!dt) return [];
    return records[dt.id] ?? [];
  }, [models, records]);

  if (templateIds.length === 0) {
    return (
      <div className="form-input bg-sand/5 text-charcoal/40 italic cursor-not-allowed">
        {isAr ? 'لا توجد توليدات — اختر قوالب وانقر "توليد التصميم"' : 'No generations yet — pick templates and click Generate'}
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {templateIds.map((tid) => {
          const tplRec = designTemplates.find((r) => r.id === tid);
          const tplName = (tplRec?.data as Record<string, unknown> | undefined)?.name;
          const name = typeof tplName === 'string' && tplName ? tplName : tid;
          const phase = (generations[tid] && typeof generations[tid] === 'object' && !Array.isArray(generations[tid]))
            ? (generations[tid] as PhaseShape)
            : {};
          const status = phase.status ?? 'pending';
          const statusInfo = STATUS_LABELS[status] ?? STATUS_LABELS.pending!;

          return (
            <div key={tid} className="border border-sand/40 rounded-xl bg-white overflow-hidden">
              <div className="flex items-center gap-2 p-3 border-b border-sand/30 bg-cream/40">
                <span className="font-bold text-sm text-charcoal flex-1 truncate">{name}</span>
                <StatusBadge tone={statusInfo.tone} label={isAr ? statusInfo.ar : statusInfo.en} />
              </div>
              {phase.error_message && (
                <div className="px-3 py-2 bg-red-50 border-b border-red-100 text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span className="flex-1">{phase.error_message}</span>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2 p-3">
                <PhaseCell
                  label={isAr ? 'مرحلة ١ — تنظيف' : 'Phase 1 — Cleaned'}
                  url={phase.cleaned_photo}
                  onPreview={setPreviewUrl}
                  isAr={isAr}
                />
                <PhaseCell
                  label={isAr ? 'مرحلة ٢ — تعديل' : 'Phase 2 — Edited'}
                  url={phase.edited_photo}
                  onPreview={setPreviewUrl}
                  isAr={isAr}
                />
                <PhaseCell
                  label={isAr ? 'مرحلة ٣ — التصميم' : 'Phase 3 — Final'}
                  url={phase.final_design}
                  onPreview={setPreviewUrl}
                  isAr={isAr}
                />
              </div>
            </div>
          );
        })}
      </div>
      {previewUrl && <ImagePreview url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </>
  );
}

function StatusBadge({ tone, label }: { tone: 'pending' | 'progress' | 'done' | 'error'; label: string }) {
  const styles: Record<typeof tone, string> = {
    pending: 'bg-sand/30 text-charcoal/60',
    progress: 'bg-blue-100 text-blue-700',
    done: 'bg-green-100 text-green-700',
    error: 'bg-red-100 text-red-700',
  };
  const Icon = tone === 'progress' ? Loader2 : tone === 'done' ? CheckCircle2 : tone === 'error' ? AlertCircle : null;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-bold ${styles[tone]}`}>
      {Icon ? <Icon size={12} className={tone === 'progress' ? 'animate-spin' : ''} /> : null}
      {label}
    </span>
  );
}

function PhaseCell({ label, url, onPreview, isAr }: { label: string; url?: string; onPreview: (url: string) => void; isAr: boolean }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-bold uppercase tracking-wide text-charcoal/40">{label}</div>
      {url ? (
        <button
          type="button"
          onClick={() => onPreview(url)}
          className="block w-full aspect-square rounded-lg overflow-hidden border border-sand/30 bg-sand/10 cursor-zoom-in hover:opacity-90 transition-opacity"
          aria-label={isAr ? 'فتح الصورة' : 'Open image'}
        >
          <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" />
        </button>
      ) : (
        <div className="w-full aspect-square rounded-lg border border-dashed border-sand/40 bg-cream/20 flex items-center justify-center text-charcoal/20">
          <ImageOff size={20} />
        </div>
      )}
    </div>
  );
}
