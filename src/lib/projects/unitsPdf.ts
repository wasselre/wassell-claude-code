/**
 * Client-side branded PDF builders for a project's UNITS — a filterable units
 * TABLE and a single-unit ONE-PAGER — returned as a `Blob` so the caller can
 * either download them or upload+send them over WhatsApp from a chat.
 *
 * Why client-side (jsPDF + html2canvas) and not the server `document_jobs`
 * engine: that engine stamps scalar `{{tokens}}` into one record's template and
 * has no notion of rendering a table of many CHILD records (`SKIP_TYPES` there
 * explicitly skips `table` fields). A units table is inherently many-rows, so it
 * lives here, following the exact rasterize→A4 recipe the Market-Intelligence
 * reports already use (`src/pages/MarketIntelligence/reports/pricingReportPdf.ts`).
 *
 * Everything reads from the PURE resolvers — `ProjectView` / `UnitView` — so the
 * PDF says exactly what the on-screen inventory says (localized labels, the
 * derived price/m², stored rollups). Nothing is recomputed or guessed here.
 */
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import { signViewUrls } from '@/lib/files/client';
import { isFileIdValue } from '@/pages/Records/components/useFileRowMap';
import type { ProjectView } from '@/lib/projects/projectView';
import type { UnitView } from '@/lib/projects/unitView';

const BRAND = {
  chocolate: '#4A2C2A',
  copper: '#B8734F',
  sand: '#D4B896',
  cream: '#F5EDE0',
  charcoal: '#4A4E54',
};

/** Integer with thousands separators, or an em-dash for empty/non-finite. */
const fmt = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');

/** Escape user/record text before it goes into an HTML string. */
function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const optLabel = (o: { label_ar: string; label_en: string } | null, isAr: boolean) =>
  o ? (isAr ? o.label_ar : o.label_en) : null;

const optsLabels = (arr: { label_ar: string; label_en: string }[], isAr: boolean) =>
  arr.map((o) => (isAr ? o.label_ar : o.label_en));

function today(isAr: boolean): string {
  // Normal browser code (not a workflow script) — `new Date()` is fine here.
  return new Date().toLocaleDateString(isAr ? 'ar-SA' : 'en-GB');
}

function place(project: ProjectView, isAr: boolean): string {
  return [project.district, project.city].filter(Boolean).join(isAr ? '، ' : ', ');
}

/** Branded chocolate header bar with the white Wassel logo. */
function headerHtml(project: ProjectView, isAr: boolean, subtitle: string): string {
  const loc = place(project, isAr);
  return `
    <div style="background:${BRAND.chocolate};color:#fff;padding:20px 32px;display:flex;justify-content:space-between;align-items:center">
      <img src="/assets/logo-horizontal-white.png" alt="" style="height:52px;width:auto;display:block" />
      <div style="text-align:${isAr ? 'left' : 'right'}">
        <div style="font-size:16px;font-weight:700">${esc(project.name) || (isAr ? 'مشروع' : 'Project')}</div>
        <div style="font-size:11px;opacity:.85">${esc(loc)}</div>
        <div style="font-size:11px;opacity:.7;margin-top:2px">${esc(subtitle)}</div>
      </div>
    </div>`;
}

/**
 * Wait until an image is painted-ready WITHOUT ever hanging. We deliberately do
 * NOT use `HTMLImageElement.decode()` (as some sibling report exporters do):
 * `decode()` can hang indefinitely on an already-loaded image whose tab is not
 * being painted (backgrounded tab / hidden preview pane), which would freeze PDF
 * generation forever. Resolving on load/error/timeout can only ever make the
 * canvas rasterize a hair early — never lock up.
 */
function imgReady(im: HTMLImageElement): Promise<void> {
  if (im.complete && im.naturalWidth > 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => resolve();
    im.addEventListener('load', done, { once: true });
    im.addEventListener('error', done, { once: true });
    setTimeout(done, 3000);
  });
}

/**
 * Rasterize a branded HTML string to a multi-page A4 PDF and return it as a
 * Blob. Mirrors `pricingReportPdf.ts`: settle images first so html2canvas can't
 * rasterize a gap, then slice a tall canvas across pages.
 */
async function rasterizeToPdf(html: string, orientation: 'portrait' | 'landscape'): Promise<Blob> {
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:0';
  container.innerHTML = html;
  document.body.appendChild(container);
  try {
    await Promise.all(Array.from(container.querySelectorAll('img')).map(imgReady));
    await new Promise<void>((r) => setTimeout(r, 200));
    const el = container.firstElementChild as HTMLElement;
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
    const pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
    const pageW = orientation === 'landscape' ? 297 : 210;
    const pageH = orientation === 'landscape' ? 210 : 297;
    const w = pageW;
    const h = (canvas.height * w) / canvas.width;
    // JPEG, not PNG: the pages are flat white + text on a white html2canvas
    // background (no alpha needed), and a PNG of a scale-2 multi-page canvas runs
    // to tens of MB — too big to send over WhatsApp. JPEG at q0.9 keeps Arabic
    // text crisp while cutting the file ~10×.
    const img = canvas.toDataURL('image/jpeg', 0.9);
    if (h <= pageH) {
      pdf.addImage(img, 'JPEG', 0, 0, w, h, undefined, 'FAST');
    } else {
      let pos = 0;
      let rem = h;
      while (rem > 0) {
        pdf.addImage(img, 'JPEG', 0, pos, w, h, undefined, 'FAST');
        rem -= pageH;
        if (rem > 0) {
          pdf.addPage();
          pos -= pageH;
        }
      }
    }
    return pdf.output('blob');
  } finally {
    document.body.removeChild(container);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Resolve a unit's plan-image field to a `data:` URI so html2canvas can embed it
 * without CORS taint. `planImage` is a files.id (private bucket → signed) or a
 * legacy http(s) URL. Returns null (never throws) when it can't be fetched — the
 * one-pager then renders without a plan image.
 */
async function resolvePlanDataUri(planImage: string | null): Promise<string | null> {
  if (!planImage) return null;
  let url: string | null = /^https?:\/\//i.test(planImage) ? planImage : null;
  if (!url && isFileIdValue(planImage)) {
    const map = await signViewUrls([planImage]).catch((e) => {
      console.error('[unitsPdf] failed to sign plan image url', e);
      return {} as Record<string, string>;
    });
    url = map[planImage] ?? null;
  }
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`plan image fetch ${res.status}`);
    return await blobToDataUrl(await res.blob());
  } catch (e) {
    console.error('[unitsPdf] plan image fetch failed; exporting without it', e);
    return null;
  }
}

// ─── Units TABLE ────────────────────────────────────────────────────────────

/**
 * Branded A4 landscape PDF of a project's units as a table. Pass whatever set
 * the caller wants (the current filtered view) — no cap, all rows render and
 * paginate.
 */
export async function buildUnitsTablePdf({
  project,
  units,
  isAr,
}: {
  project: ProjectView;
  units: UnitView[];
  isAr: boolean;
}): Promise<Blob> {
  const cur = isAr ? 'ر.س' : 'SAR';
  const num = (align: string) => `padding:6px 9px;text-align:${align}`;
  const th = (align: string) => `padding:7px 9px;text-align:${align};white-space:nowrap`;

  const body = units
    .map((u, i) => {
      const bg = i % 2 ? '#ffffff' : `${BRAND.cream}55`;
      const status = optLabel(u.status, isAr);
      return `<tr style="border-top:1px solid ${BRAND.sand}55;background:${bg}">
        <td style="${num(isAr ? 'right' : 'left')};font-weight:700;color:${BRAND.chocolate}">${esc(u.code) || `#${u.id.slice(0, 6)}`}</td>
        <td style="${num(isAr ? 'right' : 'left')};color:${BRAND.charcoal}99">${esc(u.developerCode) || '—'}</td>
        <td style="${num(isAr ? 'right' : 'left')}">${esc(optLabel(u.type, isAr)) || '—'}</td>
        <td style="${num(isAr ? 'left' : 'right')}">${u.area != null ? `${fmt(u.area)}` : '—'}</td>
        <td style="${num('center')}">${u.bedrooms ?? '—'}</td>
        <td style="${num('center')}">${u.bathrooms ?? '—'}</td>
        <td style="${num(isAr ? 'right' : 'left')}">${esc(optLabel(u.floor, isAr)) || '—'}</td>
        <td style="${num(isAr ? 'left' : 'right')};font-weight:700;color:${BRAND.chocolate}">${u.totalPrice != null ? fmt(u.totalPrice) : '—'}</td>
        <td style="${num(isAr ? 'left' : 'right')}">${u.pricePerM2 != null ? fmt(u.pricePerM2) : '—'}</td>
        <td style="${num(isAr ? 'right' : 'left')}">${esc(status) || '—'}</td>
      </tr>`;
    })
    .join('');

  const subtitle = isAr
    ? `${units.length} وحدة · ${today(true)}`
    : `${units.length} units · ${today(false)}`;

  const html = `
  <div dir="${isAr ? 'rtl' : 'ltr'}" style="width:1123px;box-sizing:border-box;background:#fff;font-family:Amiri,serif;color:${BRAND.charcoal}">
    ${headerHtml(project, isAr, subtitle)}
    <div style="padding:22px 32px">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;border:1px solid ${BRAND.sand}66">
        <thead><tr style="background:${BRAND.cream};color:${BRAND.chocolate};font-weight:700">
          <th style="${th(isAr ? 'right' : 'left')}">${isAr ? 'الكود' : 'Code'}</th>
          <th style="${th(isAr ? 'right' : 'left')}">${isAr ? 'رمز المطور' : 'Dev. code'}</th>
          <th style="${th(isAr ? 'right' : 'left')}">${isAr ? 'النوع' : 'Type'}</th>
          <th style="${th(isAr ? 'left' : 'right')}">${isAr ? 'المساحة (م²)' : 'Area (m²)'}</th>
          <th style="${th('center')}">${isAr ? 'غرف' : 'Beds'}</th>
          <th style="${th('center')}">${isAr ? 'حمامات' : 'Baths'}</th>
          <th style="${th(isAr ? 'right' : 'left')}">${isAr ? 'الطابق' : 'Floor'}</th>
          <th style="${th(isAr ? 'left' : 'right')}">${isAr ? `السعر (${cur})` : `Price (${cur})`}</th>
          <th style="${th(isAr ? 'left' : 'right')}">${isAr ? `سعر المتر` : 'Price/m²'}</th>
          <th style="${th(isAr ? 'right' : 'left')}">${isAr ? 'الحالة' : 'Status'}</th>
        </tr></thead>
        <tbody>${body || `<tr><td colspan="10" style="padding:14px;text-align:center;color:#999">${isAr ? 'لا توجد وحدات' : 'No units'}</td></tr>`}</tbody>
      </table>
      <div style="margin-top:14px;font-size:10.5px;color:${BRAND.charcoal}88">
        ${isAr
          ? `الأسعار بالريال السعودي (${cur}). سعر المتر محسوب من السعر الإجمالي ÷ مساحة الوحدة.`
          : `Prices in Saudi Riyal (${cur}). Price/m² is the total price ÷ unit area.`}
      </div>
    </div>
  </div>`;

  return rasterizeToPdf(html, 'landscape');
}

// ─── Single UNIT one-pager ──────────────────────────────────────────────────

function factRow(label: string, value: string | null, isAr: boolean): string {
  return `<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid ${BRAND.sand}44">
    <span style="color:${BRAND.charcoal}88">${esc(label)}</span>
    <span style="font-weight:600;color:${BRAND.charcoal};text-align:${isAr ? 'left' : 'right'}">${esc(value) || (isAr ? 'غير متوفر' : 'N/A')}</span>
  </div>`;
}

function chips(label: string, values: string[]): string {
  if (values.length === 0) return '';
  return `<div style="margin-top:10px">
    <div style="font-size:11px;font-weight:700;color:${BRAND.copper};margin-bottom:5px">${esc(label)}</div>
    <div>${values
      .map(
        (v) =>
          `<span style="display:inline-block;font-size:11px;padding:2px 8px;margin:0 2px 4px 0;border:1px solid ${BRAND.sand}88;border-radius:6px;background:${BRAND.cream}66;color:${BRAND.charcoal}">${esc(v)}</span>`,
      )
      .join('')}</div>
  </div>`;
}

/** Branded A4 portrait one-pager for a single unit (facts + floor plan). */
export async function buildUnitPdf({
  project,
  unit,
  isAr,
}: {
  project: ProjectView;
  unit: UnitView;
  isAr: boolean;
}): Promise<Blob> {
  const cur = isAr ? 'ر.س' : 'SAR';
  const sar = (n: number | null) => (n != null ? `${fmt(n)} ${cur}` : null);
  const m2 = (n: number | null) => (n != null ? `${fmt(n)} ${isAr ? 'م²' : 'm²'}` : null);

  const planUri = await resolvePlanDataUri(unit.planImage);

  const left = [
    factRow(isAr ? 'النوع' : 'Type', optLabel(unit.type, isAr), isAr),
    factRow(isAr ? 'الحالة' : 'Status', optLabel(unit.status, isAr), isAr),
    factRow(isAr ? 'غرف النوم' : 'Bedrooms', unit.bedrooms != null ? String(unit.bedrooms) : null, isAr),
    factRow(isAr ? 'دورات المياه' : 'Bathrooms', unit.bathrooms != null ? String(unit.bathrooms) : null, isAr),
    factRow(isAr ? 'الطابق' : 'Floor', optLabel(unit.floor, isAr), isAr),
    factRow(isAr ? 'المصعد' : 'Elevator', optLabel(unit.elevator, isAr), isAr),
  ].join('');

  const right = [
    factRow(isAr ? 'مساحة الوحدة' : 'Unit area', m2(unit.area), isAr),
    factRow(isAr ? 'المساحة الخاصة' : 'Private area', m2(unit.privateArea), isAr),
    factRow(isAr ? 'إجمالي المساحة' : 'Total area', m2(unit.totalArea), isAr),
    factRow(isAr ? 'مساحة الصك' : 'Deed area', m2(unit.deedArea), isAr),
    factRow(isAr ? 'رقم العمارة' : 'Building', unit.building, isAr),
    factRow(isAr ? 'البلك' : 'Block', unit.block, isAr),
  ].join('');

  const subtitle = isAr ? `بطاقة وحدة · ${today(true)}` : `Unit sheet · ${today(false)}`;

  const html = `
  <div dir="${isAr ? 'rtl' : 'ltr'}" style="width:794px;box-sizing:border-box;background:#fff;font-family:Amiri,serif;color:${BRAND.charcoal}">
    ${headerHtml(project, isAr, subtitle)}
    <div style="padding:26px 32px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:2px solid ${BRAND.copper};padding-bottom:8px;margin-bottom:14px">
        <div>
          <div style="font-size:22px;font-weight:700;color:${BRAND.chocolate}">${esc(unit.code) || `#${unit.id.slice(0, 8)}`}</div>
          ${unit.developerCode ? `<div style="font-size:12px;color:${BRAND.charcoal}99;margin-top:2px">${isAr ? 'رمز المطور' : 'Dev. code'}: ${esc(unit.developerCode)}</div>` : ''}
        </div>
        <div style="text-align:${isAr ? 'left' : 'right'}">
          <div style="font-size:20px;font-weight:700;color:${BRAND.copper}">${esc(sar(unit.totalPrice)) || (isAr ? 'السعر غير متوفر' : 'Price N/A')}</div>
          <div style="font-size:11px;color:${BRAND.charcoal}99">${isAr ? 'سعر المتر' : 'Price/m²'}: ${esc(sar(unit.pricePerM2)) || '—'}</div>
        </div>
      </div>

      <div style="display:flex;gap:26px">
        <div style="flex:1;font-size:13px">${left}</div>
        <div style="flex:1;font-size:13px">${right}</div>
      </div>

      ${chips(isAr ? 'المكونات' : 'Components', optsLabels(unit.components, isAr))}
      ${chips(isAr ? 'الواجهة' : 'Facade', optsLabels(unit.facade, isAr))}
      ${chips(isAr ? 'المواقف' : 'Parking', optsLabels(unit.parking, isAr))}

      ${
        planUri
          ? `<div style="margin-top:18px">
              <div style="font-size:11px;font-weight:700;color:${BRAND.copper};margin-bottom:6px">${isAr ? 'المخطط' : 'Floor plan'}</div>
              <img src="${planUri}" alt="" style="width:100%;max-height:520px;object-fit:contain;border:1px solid ${BRAND.sand}66;border-radius:8px" />
            </div>`
          : ''
      }
    </div>
  </div>`;

  return rasterizeToPdf(html, 'portrait');
}

// ─── Filenames ──────────────────────────────────────────────────────────────

/** ASCII-safe-ish slug for a filename; keeps Arabic out of the header line. */
function slug(s: string | null | undefined, fallback: string): string {
  const base = (s ?? '').trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-');
  return base || fallback;
}

export function unitsPdfFilename(project: ProjectView): string {
  return `wassel-units-${slug(project.projectId ?? project.name, project.id.slice(0, 8))}.pdf`;
}

export function unitPdfFilename(project: ProjectView, unit: UnitView): string {
  const proj = slug(project.projectId ?? project.name, project.id.slice(0, 8));
  return `wassel-unit-${proj}-${slug(unit.code ?? unit.id.slice(0, 8), unit.id.slice(0, 8))}.pdf`;
}
