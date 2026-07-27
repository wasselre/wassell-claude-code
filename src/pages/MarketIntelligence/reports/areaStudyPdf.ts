/**
 * Branded A4 "area study" PDF — the deterministic core of a client study.
 *
 * Every figure here is a SQL aggregate from wassell_market_area_stats. There is
 * no AI in this file, by design: the numbers a client sees must be reproducible
 * from the database alone. Written commentary (the part a human would call the
 * "analysis") is a SEPARATE, optional step — see requestAreaCommentary — so a
 * study can always be produced, and produced identically, without a model.
 *
 * Same rasterize-and-paginate pattern as marketSnapshotPdf (html2canvas + jsPDF),
 * which is the proven path for Arabic RTL + the Amiri webfont in this app.
 */
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import type { AreaStats, GeoCoverage } from '@/lib/market/client';
import { propertyTypeLabel } from '@/lib/market/propertyType';

const BRAND = { chocolate: '#4A2C2A', copper: '#B8734F', sand: '#D4B896', cream: '#F5EDE0', charcoal: '#4A4E54' };

/** The real Wassel horizontal logo, white version, for the chocolate header. */
const LOGO_WHITE = '/assets/logo-horizontal-white.png';

export interface AreaStudyPayload {
  stats: AreaStats;
  coverage: GeoCoverage | null;
  /**
   * Description of the area as the picker labelled it, e.g.
   * "شمال الدائري الشمالي (حتى 5 كم)". For a DRAWN shape this is the picker's
   * CHIP label, which truncates to three district names plus "+8" — fine in a
   * chip, meaningless in a client-facing title, so the heading below is derived
   * from the resolved districts instead and this is only used when it reads
   * cleanly (a rule, not a truncated list).
   */
  areaLabel: string;
  isAr: boolean;
  clientName?: string | null;
  budget?: { min: number | null; max: number | null } | null;
  propertyType?: string;
  bedrooms?: string;
  /** Optional AI-written commentary. Rendered in a clearly-labelled block. */
  commentary?: string | null;
}

const fmt = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : Math.round(Number(n)).toLocaleString('en-US');

const money = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
  return String(Math.round(v));
};

const confLabel = (g: string, isAr: boolean) =>
  g === 'high' ? (isAr ? 'مرتفعة' : 'High') : g === 'medium' ? (isAr ? 'متوسطة' : 'Medium') : (isAr ? 'منخفضة' : 'Low');

/**
 * The title a client should read.
 *
 * A picker chip label like "منطقة مرسومة: الازدهار، التعاون، الحمراء +8" leaks an
 * internal truncation into a document someone is meant to take seriously — "+8"
 * is not a place. So: name the districts when there are few enough to name, and
 * otherwise say plainly how many the area covers and which city, leaving the
 * full list to the districts section further down.
 */
function areaHeading(p: AreaStudyPayload): string {
  const { isAr, stats } = p;
  const ds = stats.districts ?? [];
  const label = (p.areaLabel ?? '').trim();
  const city = ds.find((d) => d.city_name)?.city_name ?? null;
  const names = ds.map((d) => (isAr ? d.district_name : (d.district_name_en || d.district_name)))
    .filter((n): n is string => !!n);

  // Decide from the RESOLVED DISTRICTS, not from what the label string looks
  // like. Sniffing for "+N" caught the drawn-shape case but would still have let
  // eleven hand-picked districts through as one "+"-joined run-on title.
  if (names.length > 4) {
    return isAr
      ? `منطقة تغطي ${names.length} حياً${city ? ` في ${city}` : ''}`
      : `An area covering ${names.length} districts${city ? ` in ${city}` : ''}`;
  }

  // Few enough to name. Prefer the picker's label when it is a RULE ("north of
  // X up to 5 km"), since that says something the district names do not — but
  // never when it carries the chip truncation.
  const truncated = /\+\s*\d+\s*$/.test(label);
  const isShapeLabel = /^منطقة مرسومة|^Drawn area|^منطقة مستثناة|^Excluded area/.test(label);
  if (label && !truncated && !isShapeLabel) return label;

  if (!names.length) return isAr ? 'المنطقة المحددة' : 'Selected area';
  return isAr ? `أحياء ${names.join('، ')}` : names.join(', ');
}

function buildHtml(p: AreaStudyPayload): string {
  const { isAr, stats } = p;
  const dir = isAr ? 'rtl' : 'ltr';
  const cur = isAr ? 'ر.س' : 'SAR';
  const end = isAr ? 'left' : 'right';
  const start = isAr ? 'right' : 'left';
  const ppm2 = stats.price_per_sqm ?? {};
  const price = stats.price ?? {};
  const our = stats.our_inventory ?? {};

  const ourPpm2 = our.median_price_per_sqm ?? null;
  const gapPct = ourPpm2 && ppm2.median ? Math.round(((ourPpm2 - ppm2.median) / ppm2.median) * 100) : null;

  const typeRows = (stats.by_type ?? []).slice(0, 10).map((t) => `
    <tr style="border-top:1px solid ${BRAND.sand}55">
      <td style="padding:6px 10px;font-weight:700;color:${BRAND.chocolate}">${propertyTypeLabel(t.property_type, isAr)}</td>
      <td style="padding:6px 10px;text-align:${end}">${fmt(t.count)}</td>
      <td style="padding:6px 10px;text-align:${end};font-weight:700">${fmt(t.median_price_per_sqm)}</td>
      <td style="padding:6px 10px;text-align:${end}">${fmt(t.p25_price_per_sqm)}–${fmt(t.p75_price_per_sqm)}</td>
      <td style="padding:6px 10px;text-align:${end}">${money(t.median_price)}</td>
      <td style="padding:6px 10px;text-align:${end}">${fmt(t.median_area)}</td>
    </tr>`).join('');

  // The bare number beside each district was unreadable — it is the count of
  // listings THAT DISTRICT contributes to the area. Spell it out.
  const districtChips = (stats.districts ?? []).slice(0, 18).map((d) => `
    <span style="display:inline-block;background:${BRAND.cream};border-radius:999px;padding:3px 10px;margin:2px;font-size:11px">
      ${(isAr ? d.district_name : (d.district_name_en || d.district_name)) ?? '—'}
      <span style="color:${BRAND.charcoal}88">·</span>
      <b>${fmt(d.count)}</b><span style="color:${BRAND.charcoal}88"> ${isAr ? 'إعلان' : 'ads'}</span>
    </span>`).join('');

  const bMax = p.budget?.max ?? null;
  const budgetPos = bMax && price.p25 != null && price.p75 != null
    ? (bMax < price.p25 ? 'below' : bMax > price.p75 ? 'above' : 'within') : null;

  const budgetBlock = budgetPos ? `
    <div style="margin-top:16px;padding:12px 14px;border:1px solid ${BRAND.sand};border-radius:12px;background:${BRAND.cream}">
      <div style="font-weight:700;color:${BRAND.chocolate};margin-bottom:5px">${isAr ? 'ميزانيتك مقابل هذه المنطقة' : 'Your budget vs this area'}</div>
      <div style="font-size:13px">
        ${isAr ? 'الميزانية' : 'Budget'}: <b>${money(bMax)} ${cur}</b> ·
        ${isAr ? 'النطاق السائد' : 'Prevailing range'}: ${money(price.p25)}–${money(price.p75)} ${cur}
        (${isAr ? 'المتوسط' : 'median'} ${money(price.median)} ${cur})
      </div>
      <div style="margin-top:5px;font-weight:700;color:${budgetPos === 'within' ? '#047857' : budgetPos === 'below' ? '#b45309' : '#9f1239'}">
        ${budgetPos === 'within' ? (isAr ? '✓ ضمن النطاق السائد في هذه المنطقة' : '✓ Within the prevailing range here')
          : budgetPos === 'below' ? (isAr ? '↓ أقل من معظم المعروض في هذه المنطقة' : '↓ Below most of what is on offer here')
          : (isAr ? '↑ أعلى من معظم المعروض في هذه المنطقة' : '↑ Above most of what is on offer here')}
      </div>
    </div>` : '';

  const ourBlock = (our.unit_count ?? 0) > 0 ? `
    <div style="margin-top:16px">
      <div style="font-weight:700;color:${BRAND.chocolate};margin-bottom:6px">${isAr ? 'مخزون وصل داخل المنطقة' : 'Wassel inventory inside this area'}</div>
      <div style="font-size:13px;line-height:1.9">
        ${isAr ? 'مشاريع' : 'Projects'}: <b>${fmt(our.project_count)}</b> ·
        ${isAr ? 'وحدات' : 'Units'}: <b>${fmt(our.unit_count)}</b> ·
        ${isAr ? 'متاحة' : 'Available'}: <b>${fmt(our.available_units)}</b> ·
        ${isAr ? 'سعرنا' : 'Our'}: <b>${fmt(ourPpm2)} ${cur}/${isAr ? 'م²' : 'm²'}</b>
        ${gapPct != null ? ` (${gapPct > 0 ? '+' : ''}${gapPct}% ${isAr ? 'مقابل السوق المعروض' : 'vs the asking market'})` : ''}
      </div>
    </div>` : '';

  // Commentary is visually separated and explicitly attributed, so a reader can
  // always tell which parts of the page are measured and which are written.
  const commentaryBlock = p.commentary ? `
    <div style="margin-top:16px;padding:12px 14px;border:1px dashed ${BRAND.sand};border-radius:12px">
      <div style="font-weight:700;color:${BRAND.chocolate};margin-bottom:5px">
        ${isAr ? 'قراءة تحليلية' : 'Analytical reading'}
        <span style="font-weight:400;font-size:10px;color:${BRAND.charcoal}88">
          — ${isAr ? 'نص تحريري مبني على الأرقام أعلاه' : 'written commentary based on the figures above'}
        </span>
      </div>
      <div style="font-size:12.5px;line-height:1.9;white-space:pre-wrap">${p.commentary.replace(/</g, '&lt;')}</div>
    </div>` : '';

  // No min-height: forcing a full A4 made a one-page study spill a blank second
  // page (the rasterized height landed a hair over 297mm).
  return `
  <div dir="${dir}" style="width:794px;box-sizing:border-box;background:#fff;font-family:Amiri,serif;color:${BRAND.charcoal};padding-bottom:22px">
    <div style="background:${BRAND.chocolate};color:#fff;padding:18px 30px;display:flex;justify-content:space-between;align-items:center">
      <img src="${LOGO_WHITE}" alt="" style="height:46px;width:auto;display:block" />
      <div style="text-align:${end}">
        <div style="font-size:15px;font-weight:700">${isAr ? 'دراسة سوق لمنطقة محددة' : 'Area Market Study'}</div>
        <div style="font-size:11px;opacity:.8">${stats.snapshot_date}</div>
      </div>
    </div>

    <div style="padding:24px 30px">
      <h1 style="font-size:19px;color:${BRAND.chocolate};margin:0 0 3px">${areaHeading(p)}</h1>
      <div style="font-size:12px;color:${BRAND.charcoal}99">
        ${isAr ? 'نوع العقار' : 'Property type'}: ${p.propertyType ? propertyTypeLabel(p.propertyType, isAr) : (isAr ? 'الكل' : 'All')}
        ${p.bedrooms && p.bedrooms !== 'all' ? ` · ${p.bedrooms} ${isAr ? 'غرف' : 'bd'}` : ''}
        · ${isAr ? 'تاريخ اللقطة' : 'Snapshot'}: ${stats.snapshot_date}
      </div>
      ${p.clientName ? `<div style="margin-top:5px;font-size:13px">${isAr ? 'العميل' : 'Client'}: <b>${p.clientName}</b></div>` : ''}

      <!-- Headline numbers -->
      <div style="margin-top:16px;display:flex;gap:10px">
        ${[
          [isAr ? 'متوسط ر.س/م²' : 'Median SAR/m²', fmt(ppm2.median)],
          [isAr ? 'النطاق السائد /م²' : 'Prevailing range /m²', `${fmt(ppm2.p25)}–${fmt(ppm2.p75)}`],
          [isAr ? 'متوسط السعر' : 'Median price', money(price.median)],
          [isAr ? 'متوسط المساحة' : 'Median area', `${fmt(stats.median_area)} ${isAr ? 'م²' : 'm²'}`],
        ].map(([label, value]) => `
          <div style="flex:1;border:1px solid ${BRAND.sand}88;border-radius:10px;padding:10px 12px">
            <div style="font-size:19px;font-weight:700;color:${BRAND.chocolate}">${value}</div>
            <div style="font-size:10.5px;color:${BRAND.charcoal}99;margin-top:2px">${label}</div>
          </div>`).join('')}
      </div>

      <div style="margin-top:8px;font-size:11px;color:${BRAND.charcoal}99">
        ${isAr ? 'عدد الإعلانات' : 'Listings'}: <b>${fmt(stats.deduped_count)}</b>
        ${isAr ? `(من ${fmt(stats.raw_count)} قبل حذف التكرار)` : `(from ${fmt(stats.raw_count)} before dedup)`} ·
        ${isAr ? 'التكرار' : 'Duplicates'}: ${Math.round((stats.duplicate_ratio ?? 0) * 100)}% ·
        ${isAr ? 'الثقة' : 'Confidence'}: <b>${confLabel(stats.confidence_grade, isAr)}</b>
      </div>

      ${budgetBlock}

      <!-- By type -->
      <div style="margin-top:16px">
        <div style="font-weight:700;color:${BRAND.chocolate};margin-bottom:6px">${isAr ? 'حسب نوع العقار' : 'By property type'}</div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid ${BRAND.sand}66">
          <thead><tr style="background:${BRAND.cream}">
            <th style="padding:6px 10px;text-align:${start}">${isAr ? 'النوع' : 'Type'}</th>
            <th style="padding:6px 10px;text-align:${end}">${isAr ? 'إعلانات' : 'Ads'}</th>
            <th style="padding:6px 10px;text-align:${end}">${isAr ? 'متوسط /م²' : 'Median /m²'}</th>
            <th style="padding:6px 10px;text-align:${end}">${isAr ? 'النطاق السائد' : 'Range'}</th>
            <th style="padding:6px 10px;text-align:${end}">${isAr ? 'متوسط السعر' : 'Median price'}</th>
            <th style="padding:6px 10px;text-align:${end}">${isAr ? 'م²' : 'm²'}</th>
          </tr></thead>
          <tbody>${typeRows || `<tr><td colspan="6" style="padding:12px;text-align:center;color:#999">${isAr ? 'لا توجد بيانات كافية' : 'Not enough data'}</td></tr>`}</tbody>
        </table>
      </div>

      ${ourBlock}

      ${districtChips ? `
      <div style="margin-top:16px">
        <div style="font-weight:700;color:${BRAND.chocolate};margin-bottom:2px">${isAr ? 'الأحياء التي تغطيها المنطقة' : 'Districts covered'}</div>
        <div style="font-size:10.5px;color:${BRAND.charcoal}99;margin-bottom:5px">
          ${isAr ? 'الرقم بجانب كل حي هو عدد الإعلانات التي يساهم بها في هذه المنطقة.' : 'The number beside each district is how many listings it contributes to this area.'}
        </div>
        <div>${districtChips}</div>
      </div>` : ''}

      ${commentaryBlock}

      <!-- Methodology -->
      <div style="margin-top:20px;padding-top:10px;border-top:1px solid ${BRAND.sand};font-size:10.5px;color:${BRAND.charcoal}99;line-height:1.75">
        <b>${isAr ? 'منهجية' : 'Methodology'}:</b>
        ${isAr
          ? `الأرقام مبنية على الأسعار المعروضة حالياً في السوق (وليست أسعار صفقات فعلية). تُحتسب المنطقة من إحداثيات الإعلانات، بنفس الطريقة التي يبحث بها النظام عن المشاريع المطابقة. «النطاق السائد» يعني أن نصف المعروض يقع بين الرقمين: ربع الإعلانات أقل من الحد الأدنى وربعها أعلى من الحد الأعلى. ${p.coverage && p.coverage.without_coordinates > 0 ? `${fmt(p.coverage.without_coordinates)} إعلاناً (${p.coverage.pct_without_coordinates}%) بلا إحداثيات ولا يمكن أن تظهر ضمن أي منطقة.` : ''} قد تتضمن البيانات إعلانات مكررة أو معاد نشرها، ونسبة التكرار مذكورة أعلاه. درجة الثقة تعكس حجم العينة ونسبة التكرار. القوائم الخارجية تحتاج تحقق قبل عرضها على العميل.`
          : `Figures are based on current asking prices (not actual transaction prices). The area is computed from listing coordinates, the same way the system searches for matching projects. "Prevailing range" means half of what is on offer sits between the two numbers: a quarter of ads are below the lower figure and a quarter above the upper. ${p.coverage && p.coverage.without_coordinates > 0 ? `${fmt(p.coverage.without_coordinates)} ads (${p.coverage.pct_without_coordinates}%) carry no coordinates and cannot appear inside any area.` : ''} Data may include duplicate or re-listed ads; the duplicate share is stated above. Confidence reflects sample size and duplicate risk. External listings require verification before being offered to a client.`}
        <div style="margin-top:5px">${isAr ? 'تم الإنشاء بواسطة نظام وصل لذكاء السوق.' : 'Generated by the Wassel Market Intelligence system.'}</div>
      </div>
    </div>
  </div>`;
}

export async function downloadAreaStudyPdf(payload: AreaStudyPayload): Promise<void> {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.innerHTML = buildHtml(payload);
  document.body.appendChild(container);
  try {
    // The logo must be DECODED before html2canvas runs, or it rasterizes an
    // empty gap where the brand mark should be. Never let a failed decode block
    // the export — a study without a logo still beats no study — but say so.
    await Promise.all(
      Array.from(container.querySelectorAll('img')).map((img) =>
        img.decode().catch((err) => {
          console.error('[areaStudyPdf] logo failed to load; exporting without it', err);
        }),
      ),
    );
    // Let the Amiri webfont settle before rasterizing (same wait as the snapshot).
    await new Promise<void>((r) => setTimeout(r, 400));
    const el = container.firstElementChild as HTMLElement;
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const w = 210;
    const h = (canvas.height * w) / canvas.width;
    const img = canvas.toDataURL('image/png');
    // 1mm of slack: a study that rasterizes to 297.4mm is one page, not two with
    // a blank sliver — which is exactly what the old exact compare produced.
    if (h <= 298) {
      pdf.addImage(img, 'PNG', 0, 0, w, h);
    } else {
      let remaining = h;
      let position = 0;
      while (remaining > 0) {
        pdf.addImage(img, 'PNG', 0, position, w, h);
        remaining -= 297;
        if (remaining > 1) { pdf.addPage(); position -= 297; } else break;
      }
    }
    pdf.save(`wassel-area-study-${payload.stats.snapshot_date}.pdf`);
  } finally {
    document.body.removeChild(container);
  }
}
