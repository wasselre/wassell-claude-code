import { useAppStore } from '@/stores/appStore';
import type { MarketingOperationStatus, ReelStatus } from '@/types';

interface Props {
  status: MarketingOperationStatus | ReelStatus;
}

const LABELS_AR: Record<string, string> = {
  research_pending: 'بانتظار البحث',
  research_in_progress: 'جاري البحث',
  research_waiting_answers: 'بانتظار الإجابات',
  research_complete: 'اكتمل البحث',
  content_generating: 'يتم توليد المحتوى',
  ready_for_review: 'جاهز للمراجعة',
  approved: 'تمت الموافقة',
  failed: 'فشل',
  pending: 'بانتظار البدء',
  writing: 'قيد الكتابة',
  draft_ready: 'المسودة جاهزة',
  published: 'تم النشر',
};

const LABELS_EN: Record<string, string> = {
  research_pending: 'Research Pending',
  research_in_progress: 'Researching',
  research_waiting_answers: 'Awaiting Answers',
  research_complete: 'Research Done',
  content_generating: 'Generating Content',
  ready_for_review: 'Ready for Review',
  approved: 'Approved',
  failed: 'Failed',
  pending: 'Pending',
  writing: 'Writing',
  draft_ready: 'Draft Ready',
  published: 'Published',
};

const TONE: Record<string, string> = {
  research_pending: 'bg-charcoal/10 text-charcoal/70',
  research_in_progress: 'bg-copper/15 text-copper',
  research_waiting_answers: 'bg-gold/20 text-chocolate',
  research_complete: 'bg-sand/30 text-charcoal',
  content_generating: 'bg-copper/15 text-copper',
  ready_for_review: 'bg-gold/30 text-chocolate',
  approved: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  pending: 'bg-charcoal/10 text-charcoal/70',
  writing: 'bg-copper/15 text-copper',
  draft_ready: 'bg-gold/30 text-chocolate',
  published: 'bg-green-100 text-green-800',
};

export default function StatusBadge({ status }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const label = (isAr ? LABELS_AR : LABELS_EN)[status] ?? status;
  const tone = TONE[status] ?? 'bg-charcoal/10 text-charcoal';
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${tone}`}>
      {label}
    </span>
  );
}
