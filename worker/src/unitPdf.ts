/**
 * Server-side renderer for the rep's single-unit one-pager (the WhatsApp bot's
 * "customer sent a unit code → send the unit sheet" lane).
 *
 * `buildUnitHtml` is a straight port of `buildUnitPdf`'s HTML in
 * src/lib/projects/unitsPdf.ts — the SAME inline styles, structure, header,
 * facts grid, chips and floor-plan block — so the worker PDF is visually
 * identical to the one a rep downloads in the app. The ONLY differences are
 * server-side:
 *   • no html2canvas / jsPDF — `renderUnitPdf` rasterizes via headless Chromium
 *     (page.setContent + page.pdf A4), so the returned bytes are a real vector
 *     A4 PDF, not a rasterized canvas slice;
 *   • the logo <img> src becomes an absolute data: URI passed in (or is dropped
 *     when unavailable);
 *   • the floor-plan <img> is embedded as a data: URI (fetched server-side).
 *
 * Fonts: the Docker image registers Amiri via fc-cache, so `font-family:Amiri`
 * in the HTML renders correctly with no @font-face.
 */

import { chromium } from 'playwright-core';
import type { ProjectView } from './lib/projectView.js';
import type { UnitView } from './lib/unitView.js';

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
  return new Date().toLocaleDateString(isAr ? 'ar-SA' : 'en-GB');
}

function place(project: ProjectView, isAr: boolean): string {
  return [project.district, project.city].filter(Boolean).join(isAr ? '، ' : ', ');
}

/** Branded chocolate header bar with the white Wassel logo (dropped if absent). */
function headerHtml(project: ProjectView, isAr: boolean, subtitle: string, logoDataUri: string | null): string {
  const loc = place(project, isAr);
  const logo = logoDataUri
    ? `<img src="${logoDataUri}" alt="" style="height:52px;width:auto;display:block" />`
    : '';
  return `
    <div style="background:${BRAND.chocolate};color:#fff;padding:20px 32px;display:flex;justify-content:space-between;align-items:center">
      ${logo}
      <div style="text-align:${isAr ? 'left' : 'right'}">
        <div style="font-size:16px;font-weight:700">${esc(project.name) || (isAr ? 'مشروع' : 'Project')}</div>
        <div style="font-size:11px;opacity:.85">${esc(loc)}</div>
        <div style="font-size:11px;opacity:.7;margin-top:2px">${esc(subtitle)}</div>
      </div>
    </div>`;
}

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

/**
 * Build the branded single-unit one-pager HTML — identical markup to
 * `buildUnitPdf` in src/lib/projects/unitsPdf.ts. Every image is guarded so a
 * missing logo/plan just omits that element.
 */
export function buildUnitHtml({
  project,
  unit,
  isAr,
  logoDataUri,
  planDataUri,
}: {
  project: ProjectView;
  unit: UnitView;
  isAr: boolean;
  logoDataUri: string | null;
  planDataUri: string | null;
}): string {
  const cur = isAr ? 'ر.س' : 'SAR';
  const sar = (n: number | null) => (n != null ? `${fmt(n)} ${cur}` : null);
  const m2 = (n: number | null) => (n != null ? `${fmt(n)} ${isAr ? 'م²' : 'm²'}` : null);

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

  return `
  <div dir="${isAr ? 'rtl' : 'ltr'}" style="width:794px;box-sizing:border-box;background:#fff;font-family:Amiri,serif;color:${BRAND.charcoal}">
    ${headerHtml(project, isAr, subtitle, logoDataUri)}
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
        planDataUri
          ? `<div style="margin-top:18px">
              <div style="font-size:11px;font-weight:700;color:${BRAND.copper};margin-bottom:6px">${isAr ? 'المخطط' : 'Floor plan'}</div>
              <img src="${planDataUri}" alt="" style="width:100%;max-height:520px;object-fit:contain;border:1px solid ${BRAND.sand}66;border-radius:8px" />
            </div>`
          : ''
      }
    </div>
  </div>`;
}

/**
 * Rasterize a branded one-pager HTML string to an A4 PDF via headless Chromium.
 * Uses the Alpine system chromium (playwright-core is a thin driver — no bundled
 * browser; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 in the image). The browser is
 * always closed in a finally so a render error never leaks a process.
 */
export async function renderUnitPdf(html: string): Promise<Buffer> {
  const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
  // Headless-container flags. NB: do NOT add `--single-process` — it crashes
  // chromium here ("Cannot use V8 Proxy resolver in single process mode" → target
  // closed). The original hang was chromium spinning on GPU/Vulkan init (the ANGLE
  // "Internal Vulkan error" spam), which `--disable-gpu` + `--disable-software-
  // rasterizer` skip entirely; dbus warnings on Alpine are harmless.
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    timeout: 30_000,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-software-rasterizer',
    ],
  });
  try {
    const page = await browser.newPage();
    // Only data: URIs are embedded (no real network), so 'load' settles at once.
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    // page.pdf() has no built-in timeout — race it so a stuck render fails loudly
    // (the lane marks the job failed) instead of hanging until the 10-min watchdog.
    const pdf = await Promise.race([
      page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('page.pdf timed out after 45s')), 45_000)),
    ]);
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch((e: unknown) => {
      console.error('[unit-pdf] browser close failed:', e instanceof Error ? e.message : String(e));
    });
  }
}
