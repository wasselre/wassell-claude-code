/**
 * Branded A4 "market snapshot" PDF — client-side via html2canvas + jsPDF (the
 * proven pattern from src/lib/pdfGenerator.ts). Instant, offline-capable, RTL.
 *
 * HONEST BY DESIGN: every snapshot carries a methodology note (asking ≠ sold,
 * possible duplicates, indicative ranges, transaction data only where available,
 * external listings need verification) and a per-segment confidence grade.
 * Asking prices are framed "current asking market", never "market value".
 */
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import type { MarketBenchmark, BestValueListing } from '@/lib/market/types';
import { propertyTypeLabel } from '@/lib/market/propertyType';

const BRAND = { chocolate: '#4A2C2A', copper: '#B8734F', sand: '#D4B896', cream: '#F5EDE0', charcoal: '#4A4E54' };

export interface SnapshotPayload {
  isAr: boolean;
  heading: string;
  subheading?: string;
  clientName?: string;
  budget?: { budget_min: number | null; budget_max: number; p25_price: number; median_price: number; p75_price: number; position: 'below' | 'within' | 'above' } | null;
  benchmarks: MarketBenchmark[];          // asking rows (one or more districts/types)
  bestValue?: BestValueListing[];
}

const fmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));

function confLabel(g: string, isAr: boolean) {
  if (g === 'high') return isAr ? 'مرتفعة' : 'High';
  if (g === 'medium') return isAr ? 'متوسطة' : 'Medium';
  return isAr ? 'منخفضة' : 'Low';
}

function buildHtml(p: SnapshotPayload): string {
  const { isAr } = p;
  const dir = isAr ? 'rtl' : 'ltr';
  const cur = isAr ? 'ر.س' : 'SAR';
  const ppm2 = (n: number | null) => `${fmt(n)} ${cur}/${isAr ? 'م²' : 'm²'}`;

  const rows = p.benchmarks.map((b) => `
    <tr>
      <td style="padding:7px 10px;font-weight:700;color:${BRAND.chocolate}">${(isAr ? b.district_name : b.district_name_en) ?? b.district_name ?? '—'}</td>
      <td style="padding:7px 10px">${propertyTypeLabel(b.property_type, isAr)}</td>
      <td style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${b.deduped_count}</td>
      <td style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'};font-weight:700">${ppm2(b.median_price_per_sqm)}</td>
      <td style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'};color:${BRAND.charcoal}">${fmt(b.p25_price_per_sqm)}–${fmt(b.p75_price_per_sqm)}</td>
      <td style="padding:7px 10px">${confLabel(b.confidence_grade, isAr)}</td>
    </tr>`).join('');

  const budgetBlock = p.budget ? `
    <div style="margin-top:18px;padding:14px 16px;border:1px solid ${BRAND.sand};border-radius:12px;background:${BRAND.cream}">
      <div style="font-weight:700;color:${BRAND.chocolate};margin-bottom:6px">${isAr ? 'تموضع ميزانيتك في السوق' : 'Your budget vs the market'}</div>
      <div style="font-size:13px;color:${BRAND.charcoal}">
        ${isAr ? 'ميزانيتك' : 'Budget'}: <b>${fmt(p.budget.budget_max)} ${cur}</b> ·
        ${isAr ? 'نطاق السوق المعروض' : 'Asking range'}: ${fmt(p.budget.p25_price)}–${fmt(p.budget.p75_price)} ${cur}
        (${isAr ? 'المتوسط' : 'median'} ${fmt(p.budget.median_price)} ${cur})
      </div>
      <div style="margin-top:6px;font-weight:700;color:${p.budget.position === 'within' ? '#047857' : p.budget.position === 'below' ? '#b45309' : '#9f1239'}">
        ${p.budget.position === 'within' ? (isAr ? '✓ ميزانيتك ضمن النطاق السائد' : '✓ Within the prevailing range')
          : p.budget.position === 'below' ? (isAr ? '↓ ميزانيتك أقل من معظم المعروض حالياً' : '↓ Below most current asking')
          : (isAr ? '↑ ميزانيتك أعلى من معظم المعروض حالياً' : '↑ Above most current asking')}
      </div>
    </div>` : '';

  const bv = (p.bestValue && p.bestValue.length) ? `
    <div style="margin-top:18px">
      <div style="font-weight:700;color:${BRAND.chocolate};margin-bottom:6px">${isAr ? 'قوائم ذات قيمة جيدة حالياً' : 'Best-value current listings'}
        <span style="font-weight:400;font-size:11px;color:#9f1239">— ${isAr ? 'قوائم خارجية تحتاج تحقق قبل العرض' : 'external listings — verify before offering'}</span></div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:${BRAND.cream};color:${BRAND.charcoal}">
          <th style="padding:6px 10px;text-align:${isAr ? 'right' : 'left'}">${isAr ? 'الإعلان' : 'Listing'}</th>
          <th style="padding:6px 10px;text-align:${isAr ? 'left' : 'right'}">${isAr ? 'المساحة' : 'Area'}</th>
          <th style="padding:6px 10px;text-align:${isAr ? 'left' : 'right'}">ر.س/م²</th>
          <th style="padding:6px 10px;text-align:${isAr ? 'left' : 'right'}">${isAr ? 'مقابل المتوسط' : 'vs median'}</th>
        </tr></thead>
        <tbody>${p.bestValue.slice(0, 8).map((l) => `
          <tr style="border-top:1px solid ${BRAND.sand}66">
            <td style="padding:6px 10px">${(l.title || '').slice(0, 48)}</td>
            <td style="padding:6px 10px;text-align:${isAr ? 'left' : 'right'}">${fmt(l.area)} ${isAr ? 'م²' : 'm²'}</td>
            <td style="padding:6px 10px;text-align:${isAr ? 'left' : 'right'};font-weight:700">${fmt(l.price_per_sqm)}</td>
            <td style="padding:6px 10px;text-align:${isAr ? 'left' : 'right'};color:#047857">${l.vs_median_pct == null ? '—' : `${l.vs_median_pct}%`}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : '';

  return `
  <div dir="${dir}" style="width:794px;min-height:1123px;box-sizing:border-box;background:#fff;font-family:Amiri,serif;color:${BRAND.charcoal};padding:0">
    <div style="background:${BRAND.chocolate};color:#fff;padding:20px 32px;display:flex;justify-content:space-between;align-items:center">
      <img src="/assets/logo-horizontal-white.png" alt="" style="height:48px;width:auto;display:block" />
      <div style="text-align:${isAr ? 'left' : 'right'}">
        <div style="font-size:15px;font-weight:700">${isAr ? 'تقرير سوق إرشادي' : 'Indicative Market Report'}</div>
      </div>
    </div>
    <div style="padding:26px 32px">
      <h1 style="font-size:20px;color:${BRAND.chocolate};margin:0 0 4px">${p.heading}</h1>
      ${p.subheading ? `<div style="font-size:13px;color:${BRAND.charcoal}99">${p.subheading}</div>` : ''}
      ${p.clientName ? `<div style="margin-top:6px;font-size:13px">${isAr ? 'العميل' : 'Client'}: <b>${p.clientName}</b></div>` : ''}
      ${budgetBlock}
      <div style="margin-top:18px">
        <div style="font-weight:700;color:${BRAND.chocolate};margin-bottom:6px">${isAr ? 'مقارنة الأحياء (حسب الأسعار المعروضة حالياً)' : 'District comparison (current asking market)'}</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid ${BRAND.sand}66">
          <thead><tr style="background:${BRAND.cream};color:${BRAND.charcoal}">
            <th style="padding:7px 10px;text-align:${isAr ? 'right' : 'left'}">${isAr ? 'الحي' : 'District'}</th>
            <th style="padding:7px 10px;text-align:${isAr ? 'right' : 'left'}">${isAr ? 'النوع' : 'Type'}</th>
            <th style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${isAr ? 'إعلانات' : 'Listings'}</th>
            <th style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${isAr ? 'المتوسط ر.س/م²' : 'Median /m²'}</th>
            <th style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">P25–P75 /m²</th>
            <th style="padding:7px 10px;text-align:${isAr ? 'right' : 'left'}">${isAr ? 'الثقة' : 'Confidence'}</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="6" style="padding:12px;text-align:center;color:#999">${isAr ? 'لا توجد بيانات كافية' : 'Not enough data'}</td></tr>`}</tbody>
        </table>
      </div>
      ${bv}
      <div style="margin-top:22px;padding-top:12px;border-top:1px solid ${BRAND.sand};font-size:11px;color:${BRAND.charcoal}99;line-height:1.7">
        <b>${isAr ? 'منهجية' : 'Methodology'}:</b>
        ${isAr
          ? 'الأرقام مبنية على الأسعار المعروضة في السوق (وليست أسعار صفقات فعلية). قد تتضمن البيانات إعلانات مكررة أو معاد نشرها. النطاقات إرشادية وتعكس المئينات (P25–P75). تتوفر بيانات الصفقات الفعلية لبعض الشرائح فقط. القوائم الخارجية تحتاج تحقق قبل عرضها على العميل. درجة الثقة تعكس حجم العينة ومخاطر التكرار.'
          : 'Figures are based on market asking prices (not actual transaction/sold prices). Data may include duplicate or re-listed ads. Ranges are indicative and reflect percentiles (P25–P75). Transaction data is available for some segments only. External listings require verification before being offered to a client. Confidence reflects sample size and duplicate risk.'}
        <div style="margin-top:6px">${isAr ? 'تم الإنشاء بواسطة نظام وصل لذكاء السوق.' : 'Generated by the Wassel Market Intelligence system.'}</div>
      </div>
    </div>
  </div>`;
}

export async function generateMarketSnapshotPdf(payload: SnapshotPayload): Promise<void> {
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.style.top = '0';
  container.innerHTML = buildHtml(payload);
  document.body.appendChild(container);
  try {
    // Decode the logo first — html2canvas would otherwise rasterize a gap.
    await Promise.all(
      Array.from(container.querySelectorAll('img')).map((im) =>
        im.decode().catch((err) => {
          console.error('[marketSnapshotPdf] logo failed to load; exporting without it', err);
        }),
      ),
    );
    // Let the Amiri webfont settle before rasterizing.
    await new Promise<void>((r) => setTimeout(r, 400));
    const el = container.firstElementChild as HTMLElement;
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const w = 210;
    const h = (canvas.height * w) / canvas.width;
    let remaining = h;
    let position = 0;
    const img = canvas.toDataURL('image/png');
    // paginate if taller than one A4 page (297mm)
    if (h <= 297) {
      pdf.addImage(img, 'PNG', 0, 0, w, h);
    } else {
      while (remaining > 0) {
        pdf.addImage(img, 'PNG', 0, position, w, h);
        remaining -= 297;
        if (remaining > 0) { pdf.addPage(); position -= 297; }
      }
    }
    const date = (payload.benchmarks[0]?.snapshot_date) ?? 'snapshot';
    pdf.save(`wassel-market-${date}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}
