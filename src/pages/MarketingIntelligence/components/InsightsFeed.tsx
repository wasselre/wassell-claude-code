/**
 * The insight feed — what CHANGED in the competitor set, newest and most severe
 * first. Every row is produced by a deterministic rule in
 * mkt_generate_trend_insights(); none of it is model output.
 *
 * Evidence is one click away on every row, on purpose. The first live run of the
 * engine emitted 80 insights of which 66 were false (56 "new marketer" alerts
 * that were really "we imported our data on one day"). The noise floors that
 * fixed it are recorded in each insight's `evidence.rule` + thresholds, so a
 * reader who distrusts a row can check the reasoning instead of guessing.
 */
import { useState } from 'react';
import { ChevronDown, X, Building2, FolderOpen } from 'lucide-react';
import type { MIIndexInsight } from '@/lib/marketing/client';
import { SeverityPill, EmptyHint, fmtDate } from './shared';

const KIND_LABELS: Record<string, { ar: string; en: string }> = {
  posting_frequency_change: { ar: 'تغيّر وتيرة النشر', en: 'Posting frequency changed' },
  advertiser_inactive: { ar: 'توقّف النشاط', en: 'Advertiser went quiet' },
  platform_shift: { ar: 'تحوّل بين المنصات', en: 'Platform shift' },
  messaging_shift: { ar: 'تغيّر الرسالة', en: 'Messaging shift' },
  new_offer_detected: { ar: 'عرض جديد', en: 'New offer detected' },
  new_marketer: { ar: 'مسوّق جديد', en: 'New marketer' },
  price_movement: { ar: 'حركة سعرية', en: 'Price movement' },
};

function kindLabel(kind: string, isAr: boolean): string {
  const k = KIND_LABELS[kind];
  if (k) return isAr ? k.ar : k.en;
  return kind.replace(/_/g, ' ');
}

export default function InsightsFeed({
  rows, isAr, onDismiss, onOpenProject, onOpenOrganization,
}: {
  rows: MIIndexInsight[];
  isAr: boolean;
  onDismiss: (id: string) => void;
  onOpenProject: (projectId: string) => void;
  onOpenOrganization: (orgId: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyHint>
        {isAr
          ? 'لا توجد تنبيهات نشطة. القواعد تعمل على دورة العمليات — الصمت هنا يعني عدم رصد تغيّر يتجاوز الحدود المقررة، لا انعدام البيانات.'
          : 'No live insights. The rules run on the ops cadence — silence here means no change cleared the thresholds, not that there is no data.'}
      </EmptyHint>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const open = openId === r.id;
        return (
          <li key={r.id} className="rounded-xl border border-sand/50 bg-white">
            <div className="flex items-start gap-3 px-4 py-3">
              <SeverityPill severity={r.severity} isAr={isAr} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[13px] font-semibold text-charcoal">{r.title}</span>
                  <span className="text-[11px] text-charcoal/40">· {kindLabel(r.kind, isAr)}</span>
                </div>
                {r.body && <p className="mt-1 text-[12.5px] leading-relaxed text-charcoal/65">{r.body}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-charcoal/45">
                  <span>{fmtDate(r.generated_at, isAr)}</span>
                  {r.organization_id && (
                    <button
                      type="button"
                      onClick={() => onOpenOrganization(r.organization_id!)}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-copper hover:bg-copper/10"
                    >
                      <Building2 className="h-3 w-3" />
                      {r.organization_name ?? (isAr ? 'المنشأة' : 'organization')}
                    </button>
                  )}
                  {r.project_id && (
                    <button
                      type="button"
                      onClick={() => onOpenProject(r.project_id!)}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-copper hover:bg-copper/10"
                    >
                      <FolderOpen className="h-3 w-3" />
                      {r.project_name ?? (isAr ? 'المشروع' : 'project')}
                    </button>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {r.evidence && (
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : r.id)}
                    className="rounded-lg p-1.5 text-charcoal/40 hover:bg-cream hover:text-charcoal"
                    title={isAr ? 'الدليل' : 'Evidence'}
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onDismiss(r.id)}
                  className="rounded-lg p-1.5 text-charcoal/40 hover:bg-cream hover:text-charcoal"
                  title={isAr ? 'إخفاء' : 'Dismiss'}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            {open && r.evidence && (
              <div className="border-t border-sand/40 bg-cream-light px-4 py-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-charcoal/45">
                  {isAr ? 'الدليل والحدود المستخدمة' : 'Evidence & thresholds applied'}
                </div>
                <pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-white p-3 text-[11.5px] leading-relaxed text-charcoal/75">
                  {JSON.stringify(r.evidence, null, 2)}
                </pre>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
