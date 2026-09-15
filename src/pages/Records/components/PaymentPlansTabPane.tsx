import { useCallback, useMemo, useState } from 'react';
import { Download, FileText, Loader2, Send } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type { AppRecord, AppModel } from '@/types';
import { getEntityFieldText } from '@/lib/recordTranslation/store';
import { resolveProjectView, modelByName } from '@/lib/projects/projectView';
import { unitsForProject } from '@/lib/projects/unitView';
import { resolveProjectDelivery } from '@/lib/projectMessage/delivery';
import {
  resolveProjectPaymentPlans, resolveUnitPaymentPlans, composePaymentPlansMessage,
  entryDownPayment, hasAedPricing, formatPlanPriceRange, planRowTitle, paymentPlansPdfFilename,
} from '@/lib/projects/paymentPlans';
import { downloadPdf, type ChatPdfContext } from '@/lib/projects/sendPdfToChat';
import SendPaymentPlansModal from '@/pages/Chats/components/SendPaymentPlansModal';

/**
 * "Payment Plans" tab. Two modes, chosen by the host record's model:
 *
 *  • all_projects → a PROJECT OVERVIEW: the distinct payment *structures*
 *    offered across the project's units (deduped on the %-split), each with
 *    the number of units offering it and the price RANGE (AED + SAR) rolled up
 *    from those units. Answers "what payment plans does this project offer, and
 *    what do they cost".
 *
 *  • units → a UNIT DETAIL: this unit's own plan cards grouped by structure,
 *    so the same structure sold at several prices (different offers) reads as
 *    one row with its price(s), not eleven flat rows.
 *
 * The grouping itself lives in the pure `@/lib/projects/paymentPlans` — shared
 * with the branded PDF and the WhatsApp text message, so the three can never
 * disagree. Prices live per-unit (the source of truth is the `payment_plans`
 * table field on each unit); the project view aggregates live from the units
 * already in the store — same pattern as UnitsTabPane. (The project's STORED
 * menu — `payment_plan_schedule` + summary + headline %s — is a Postgres rollup
 * of the same cards, see
 * supabase/migrations/2026-09-07_project_payment_plans_rollup.sql; it gates
 * whether this tab shows at all.)
 *
 * SEND / DOWNLOAD (2026-09-15). In project mode the header carries "Download
 * PDF" always and "Send to client" whenever a client conversation is in context
 * (`chatPdf`) — the rep picks PDF or plain text in the dialog. An off-plan
 * project's «على الخارطة» + handover month rides on both, because a payment
 * plan is a conversation about timing.
 */
export default function PaymentPlansTabPane({
  record,
  model,
  projectId,
  chatPdf,
}: {
  record?: AppRecord;
  model?: AppModel;
  projectId?: string;
  /** Conversation to offer "Send to client" into. Absent → download only. */
  chatPdf?: ChatPdfContext | null;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);

  // Project-overview target id: explicit prop wins; else the record itself if
  // it's an all_projects master. Null => unit-detail mode.
  const projModeId = projectId ?? (model?.name === 'all_projects' ? record?.id ?? null : null);
  const isProject = projModeId != null;

  // For project mode: the units belonging to this project (the shared lookup
  // scan, so a Builder rename of `project_id` doesn't break it).
  const unitsOfProject = useMemo<AppRecord[]>(
    () => (projModeId ? unitsForProject({ models, records }, projModeId) : []),
    [projModeId, models, records],
  );

  /** The all_projects master — for the PDF's branded header + delivery status. */
  const projectRecord = useMemo<AppRecord | null>(() => {
    if (!projModeId) return null;
    const ap = modelByName(models, 'all_projects');
    if (!ap) return null;
    return (records[ap.id] ?? []).find((r) => r.id === projModeId) ?? null;
  }, [projModeId, models, records]);

  /** Rows in a chosen language — the UI uses the app language, the PDF/message
   *  use whichever the rep picked in the dialog. */
  const rowsFor = useCallback(
    (wantAr: boolean) =>
      isProject ? resolveProjectPaymentPlans(unitsOfProject, wantAr) : resolveUnitPaymentPlans(record, wantAr),
    [isProject, unitsOfProject, record],
  );

  const rows = useMemo(() => rowsFor(isAr), [rowsFor, isAr]);

  const delivery = useMemo(
    () => (projectRecord ? resolveProjectDelivery((projectRecord.data ?? {}) as Record<string, unknown>) : null),
    [projectRecord],
  );

  const projectViewFor = useCallback(
    (wantAr: boolean) =>
      projectRecord
        ? resolveProjectView({ models, records }, projectRecord, { isAr: wantAr, translate: getEntityFieldText })
        : null,
    [projectRecord, models, records],
  );

  const projectName = projectViewFor(isAr)?.name ?? '';

  const [sendOpen, setSendOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const buildPdfFor = useCallback(
    async (wantAr: boolean): Promise<Blob> => {
      const view = projectViewFor(wantAr);
      if (!view) throw new Error(isAr ? 'تعذّر تحديد المشروع' : 'Could not resolve the project');
      // jsPDF + html2canvas (~600 KB) load ONLY when a document is actually
      // built. A static import here would pull them into the record-form and
      // in-chat chunks for every rep who merely opens a record.
      const { buildPaymentPlansPdf } = await import('@/lib/projects/unitsPdf');
      return buildPaymentPlansPdf({
        project: view,
        rows: rowsFor(wantAr),
        isAr: wantAr,
        deliveryPhrase: wantAr ? delivery?.phrase?.ar ?? null : delivery?.phrase?.en ?? null,
      });
    },
    [projectViewFor, rowsFor, delivery, isAr],
  );

  const messageFor = useCallback(
    (wantAr: boolean) =>
      composePaymentPlansMessage({
        projectName: projectViewFor(wantAr)?.name ?? null,
        rows: rowsFor(wantAr),
        isAr: wantAr,
        deliveryPhrase: wantAr ? delivery?.phrase?.ar ?? null : delivery?.phrase?.en ?? null,
      }),
    [projectViewFor, rowsFor, delivery],
  );

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const view = projectViewFor(isAr);
      if (!view) throw new Error(isAr ? 'تعذّر تحديد المشروع' : 'Could not resolve the project');
      downloadPdf(await buildPdfFor(isAr), paymentPlansPdfFilename(view));
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDownloading(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center py-12 text-charcoal/40">
        <p className="text-sm font-bold">
          {isAr ? 'لا توجد خطط سداد لهذا السجل بعد.' : 'No payment plans on this record yet.'}
        </p>
      </div>
    );
  }

  const entryDown = entryDownPayment(rows);
  // AED column only when at least one card is priced in AED (Dubai projects);
  // Saudi projects are SAR-only and the extra "—" column is noise.
  const hasAed = hasAedPricing(rows);
  // Share actions need the master record (branded header) — project mode only.
  const canShare = isProject && projectRecord != null;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-chocolate mb-1">
            {isAr ? 'خطط السداد' : 'Payment Plans'}
          </h2>
          <p className="text-xs text-charcoal/50">
            {isProject
              ? isAr
                ? `${rows.length} خطة متاحة · أقل دفعة مقدمة ${entryDown}% · محسوبة من ${unitsOfProject.length} وحدة`
                : `${rows.length} plans available · entry down payment ${entryDown}% · rolled up from ${unitsOfProject.length} units`
              : isAr
                ? `${rows.length} خطة لهذه الوحدة · أقل دفعة مقدمة ${entryDown}%`
                : `${rows.length} plans on this unit · entry down payment ${entryDown}%`}
          </p>
          {/* Off-plan disclosure — a payment plan is a timing conversation, so
              the status sits next to it here too, not only on the sent copy. */}
          {delivery?.phrase && (
            <p className="text-xs text-charcoal/60 mt-1">
              <span className="text-charcoal/45">{isAr ? 'الحالة: ' : 'Status: '}</span>
              <span className="font-semibold">{isAr ? delivery.phrase.ar : delivery.phrase.en}</span>
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canShare && (
            <>
              {chatPdf && (
                <Button variant="primary" className="text-sm !py-1.5" onClick={() => setSendOpen(true)}>
                  <Send size={14} className="inline -mt-0.5 me-1" />
                  {isAr ? 'إرسال للعميل' : 'Send to client'}
                </Button>
              )}
              <Button variant="secondary" className="text-sm !py-1.5" disabled={downloading} onClick={() => void handleDownload()}>
                {downloading
                  ? <Loader2 size={14} className="inline -mt-0.5 me-1 animate-spin" />
                  : chatPdf ? <Download size={14} className="inline -mt-0.5 me-1" /> : <FileText size={14} className="inline -mt-0.5 me-1" />}
                {isAr ? 'تنزيل PDF' : 'Download PDF'}
              </Button>
            </>
          )}
          <span className="text-[11px] text-charcoal/40">
            {hasAed
              ? isAr ? 'الأسعار بالدرهم الإماراتي والريال السعودي' : 'Prices in AED & SAR'
              : isAr ? 'الأسعار بالريال السعودي' : 'Prices in SAR'}
          </span>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-cream/50 border-b border-sand/40">
            <tr className="text-charcoal/60">
              <th className="text-start px-4 py-2.5 text-xs font-bold uppercase tracking-wider">
                {isAr ? 'الخطة' : 'Plan'}
              </th>
              <th className="text-center px-2 py-2.5 text-xs font-bold">{isAr ? 'مقدم' : 'Down'}</th>
              <th className="text-center px-2 py-2.5 text-xs font-bold">
                {isAr ? 'أثناء الإنشاء' : 'Constr.'}
              </th>
              <th className="text-center px-2 py-2.5 text-xs font-bold">
                {isAr ? 'عند التسليم' : 'Handover'}
              </th>
              <th className="text-center px-2 py-2.5 text-xs font-bold">
                {isProject ? (isAr ? 'وحدات' : 'Units') : (isAr ? 'عروض' : 'Offers')}
              </th>
              {hasAed && (
                <th className="text-end px-4 py-2.5 text-xs font-bold">{isAr ? 'السعر (د.إ)' : 'Price (AED)'}</th>
              )}
              <th className="text-end px-4 py-2.5 text-xs font-bold">{isAr ? 'السعر (ر.س)' : 'Price (SAR)'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-sand/25 last:border-0 hover:bg-cream/20">
                <td className="px-4 py-2.5 font-medium text-charcoal">
                  {planRowTitle(r, isAr)}
                  {!r.isCash && r.name && (
                    <div className="mt-0.5 text-xs font-normal text-charcoal/70">{r.label}</div>
                  )}
                  {r.schedule && (
                    <div className="mt-0.5 text-[11px] font-normal leading-relaxed text-charcoal/55">
                      {r.schedule}
                    </div>
                  )}
                </td>
                <td className="text-center px-2 py-2.5 tabular-nums">{r.down ? `${r.down}%` : '—'}</td>
                <td className="text-center px-2 py-2.5 tabular-nums text-charcoal/70">
                  {r.during ? `${r.during}%` : '—'}
                </td>
                <td className="text-center px-2 py-2.5 tabular-nums text-charcoal/70">
                  {r.onHandover ? `${r.onHandover}%` : '—'}
                  {r.postHandover ? ` (+${r.postHandover}% ${isAr ? 'بعد' : 'post'})` : ''}
                </td>
                <td className="text-center px-2 py-2.5 tabular-nums text-charcoal/60">{r.count}</td>
                {hasAed && (
                  <td className="text-end px-4 py-2.5 tabular-nums text-charcoal whitespace-nowrap">
                    {formatPlanPriceRange(r.minAed, r.maxAed, isAr ? 'د.إ' : 'AED')}
                  </td>
                )}
                <td className="text-end px-4 py-2.5 tabular-nums text-charcoal/70 whitespace-nowrap">
                  {formatPlanPriceRange(r.minSar, r.maxSar, isAr ? 'ر.س' : 'SAR')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-charcoal/40 leading-relaxed">
        {isProject
          ? isAr
            ? 'كل صف هو هيكل سداد متاح في المشروع (نسبة المقدم/الإنشاء/التسليم). السعر نطاق محسوب من كل الوحدات المتاحة — يختلف السعر حسب الوحدة.'
            : 'Each row is a payment structure offered in this project (down / construction / handover %). The price is a range rolled up across all available units — price varies by unit.'
          : isAr
            ? 'كل صف هيكل سداد لهذه الوحدة. قد يُعرض الهيكل نفسه بعدة أسعار (عروض مختلفة) — يظهر كنطاق سعري.'
            : 'Each row is a payment structure for this unit. The same structure can be offered at several prices (different offers) — shown as a price range.'}
      </p>

      {/* Send the plans as a PDF or as a text message. Mounted only while open
          so its cached PDF blob resets per open (same as SendUnitsPdfModal). */}
      {sendOpen && canShare && (
        <SendPaymentPlansModal
          open
          onClose={() => setSendOpen(false)}
          chatWid={chatPdf?.chatWid ?? null}
          clientName={chatPdf?.clientName}
          clientPhone={chatPdf?.clientPhone}
          projectName={projectName}
          planCount={rows.length}
          buildPdfFor={buildPdfFor}
          filenameFor={(a) => {
            const v = projectViewFor(a);
            return v ? paymentPlansPdfFilename(v) : 'wassel-payment-plans.pdf';
          }}
          messageFor={messageFor}
          captionFor={(a) => {
            const n = projectViewFor(a)?.name ?? '';
            return a ? `خطط السداد — ${n}`.trim() : `Payment plans — ${n}`.trim();
          }}
        />
      )}
    </div>
  );
}
