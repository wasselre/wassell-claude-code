/** Branded A4 our-project pricing report — client-side jsPDF + html2canvas. */
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import type { PricingReportRow } from '@/lib/market/client';
import { propertyTypeLabel } from '@/lib/market/propertyType';

const BRAND = { chocolate: '#4A2C2A', copper: '#B8734F', sand: '#D4B896', cream: '#F5EDE0', charcoal: '#4A4E54' };
const fmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));

function posLabel(p: string, isAr: boolean) {
  if (p === 'below') return { t: isAr ? 'أقل من السوق' : 'Below market', c: '#047857' };
  if (p === 'premium') return { t: isAr ? 'أعلى من السوق' : 'Premium', c: '#9f1239' };
  if (p === 'fair') return { t: isAr ? 'مطابق للسوق' : 'Fair', c: BRAND.charcoal };
  return { t: isAr ? 'غير كافٍ' : 'Too thin', c: '#999' };
}

export async function generatePricingReportPdf(rows: PricingReportRow[], isAr: boolean, snapshot: string | null): Promise<void> {
  const dir = isAr ? 'rtl' : 'ltr';
  const cur = isAr ? 'ر.س' : 'SAR';
  const body = rows.map((r) => {
    const pl = posLabel(r.position, isAr);
    return `<tr style="border-top:1px solid ${BRAND.sand}66">
      <td style="padding:7px 10px;font-weight:700;color:${BRAND.chocolate}">${(isAr ? r.district_name : r.district_name_en) ?? r.district_name}</td>
      <td style="padding:7px 10px">${propertyTypeLabel(r.property_type, isAr)}</td>
      <td style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'};font-weight:700">${fmt(r.our_ppm2)}</td>
      <td style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${fmt(r.market_ppm2)}</td>
      <td style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${fmt(r.market_p25)}–${fmt(r.market_p75)}</td>
      <td style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'};color:${pl.c};font-weight:700">${r.gap_pct == null ? '—' : (r.gap_pct > 0 ? '+' : '') + r.gap_pct + '%'} · ${pl.t}</td>
      <td style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${r.client_demand}</td>
    </tr>`;
  }).join('');

  const html = `
  <div dir="${dir}" style="width:794px;box-sizing:border-box;background:#fff;font-family:Amiri,serif;color:${BRAND.charcoal}">
    <div style="background:${BRAND.chocolate};color:#fff;padding:20px 32px;display:flex;justify-content:space-between;align-items:center">
      <img src="/assets/logo-horizontal-white.png" alt="" style="height:48px;width:auto;display:block" />
      <div style="text-align:${isAr ? 'left' : 'right'}">
        <div style="font-size:15px;font-weight:700">${isAr ? 'تقرير تسعير المشاريع' : 'Project Pricing Report'}</div>
        <div style="font-size:11px;opacity:.8">${isAr ? `لقطة السوق: ${snapshot ?? '—'}` : `Market snapshot: ${snapshot ?? '—'}`}</div>
      </div>
    </div>
    <div style="padding:26px 32px">
      <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid ${BRAND.sand}66">
        <thead><tr style="background:${BRAND.cream}">
          <th style="padding:7px 10px;text-align:${isAr ? 'right' : 'left'}">${isAr ? 'الحي' : 'District'}</th>
          <th style="padding:7px 10px;text-align:${isAr ? 'right' : 'left'}">${isAr ? 'النوع' : 'Type'}</th>
          <th style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${isAr ? 'سعرنا /م²' : 'Our /m²'}</th>
          <th style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${isAr ? 'السوق /م²' : 'Market /m²'}</th>
          <th style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">P25–P75</th>
          <th style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${isAr ? 'الموضع' : 'Position'}</th>
          <th style="padding:7px 10px;text-align:${isAr ? 'left' : 'right'}">${isAr ? 'طلب' : 'Demand'}</th>
        </tr></thead>
        <tbody>${body || `<tr><td colspan="7" style="padding:12px;text-align:center;color:#999">${isAr ? 'لا توجد وحدات موثقة بحي محدد' : 'No verified units with a resolved district'}</td></tr>`}</tbody>
      </table>
      <div style="margin-top:18px;font-size:11px;color:${BRAND.charcoal}99;line-height:1.7">
        <b>${isAr ? 'منهجية' : 'Methodology'}:</b>
        ${isAr
          ? 'سعرنا/م² محسوب من وحدات مشاريعنا. سعر السوق هو متوسط الأسعار المعروضة (وليست صفقات فعلية) للحي والنوع نفسه. الموضع إرشادي. "${cur}" = ريال سعودي.'.replace('${cur}', cur)
          : 'Our /m² is computed from our project units. Market /m² is the median of current asking prices (not transactions) for the same district and type. Position is indicative.'}
      </div>
    </div>
  </div>`;

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:0';
  container.innerHTML = html;
  document.body.appendChild(container);
  try {
    // Decode the logo first — html2canvas would otherwise rasterize a gap.
    await Promise.all(
      Array.from(container.querySelectorAll('img')).map((im) =>
        im.decode().catch((err) => {
          console.error('[pricingReportPdf] logo failed to load; exporting without it', err);
        }),
      ),
    );
    await new Promise<void>((r) => setTimeout(r, 400));
    const el = container.firstElementChild as HTMLElement;
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const w = 210; const h = (canvas.height * w) / canvas.width;
    const img = canvas.toDataURL('image/png');
    if (h <= 297) pdf.addImage(img, 'PNG', 0, 0, w, h);
    else { let pos = 0, rem = h; while (rem > 0) { pdf.addImage(img, 'PNG', 0, pos, w, h); rem -= 297; if (rem > 0) { pdf.addPage(); pos -= 297; } } }
    pdf.save(`wassel-pricing-${snapshot ?? 'report'}.pdf`);
  } finally { document.body.removeChild(container); }
}
