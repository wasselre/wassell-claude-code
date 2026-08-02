/**
 * Renders a Scheduled Report into an email (HTML + plain text). v1: a summary +
 * a simple table/cards per section, a "data as of" stamp, any engine warnings,
 * and a link back to the dashboard/report. No PDF. On-brand inline styles
 * (email clients require inline CSS); numbers render LTR.
 */
import type { AnalyticsResult } from '../../src/lib/analytics/types.js';

export interface ReportSection {
  title: string;
  result: AnalyticsResult;
  numberFormat?: { currency?: string | null; percent?: boolean; decimals?: number; compact?: boolean } | null;
}

export interface RenderInput {
  reportTitle: string;
  sections: ReportSection[];
  dataAsOf: string; // ISO
  link?: string | null;
  /** Bilingual W4: render language — chrome strings, direction, label side.
   *  Default 'ar' (Arabic-first company). */
  lang?: 'ar' | 'en';
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const COPPER = '#B8734F';
const CHARCOAL = '#4A4E54';
const SAND = '#D4B896';
const CREAM = '#F5EDE0';

function fmt(v: number | null | undefined, f?: ReportSection['numberFormat']): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const decimals = f?.decimals ?? (Number.isInteger(v) ? 0 : 2);
  let body: string;
  if (f?.compact && Math.abs(v) >= 1000) {
    const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    const u = units.find(([d]) => Math.abs(v) >= d);
    body = u ? `${(v / u[0]).toLocaleString('en-US', { maximumFractionDigits: 1 })}${u[1]}` : String(v);
  } else {
    body = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  if (f?.percent) return `${body}%`;
  if (f?.currency) return f.currency === 'SAR' ? `${body} ر.س` : `${body} ${f.currency}`;
  return body;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function sectionRows(r: AnalyticsResult, lang: 'ar' | 'en'): { label: string; value: number | null }[] {
  const pick = (k: { label_ar?: string | null; label_en?: string | null; raw?: string | null }) =>
    lang === 'ar' ? k.label_ar || k.label_en || k.raw : k.label_en || k.label_ar || k.raw;
  return r.rows.map((row) => ({
    label: row.keys.map(pick).filter(Boolean).join(' / ') || '—',
    value: row.value,
  }));
}

function isScalar(r: AnalyticsResult): boolean {
  return r.rows.length === 0 || (r.rows.length === 1 && r.rows[0]!.keys.length === 0);
}

export function renderReportEmail(input: RenderInput): RenderedEmail {
  const { reportTitle, sections, dataAsOf, link } = input;
  const lang: 'ar' | 'en' = input.lang === 'en' ? 'en' : 'ar';
  const isAr = lang === 'ar';
  const dir = isAr ? 'rtl' : 'ltr';
  const startAlign = isAr ? 'right' : 'left';
  const endAlign = isAr ? 'left' : 'right';
  const asOf = new Date(dataAsOf).toLocaleString(isAr ? 'ar-SA' : 'en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'medium', timeStyle: 'short' });
  const L = {
    category: isAr ? 'الفئة' : 'Category',
    value: isAr ? 'القيمة' : 'Value',
    asOf: isAr ? `البيانات حتى ${asOf} (توقيت الرياض)` : `Data as of ${asOf} (Asia/Riyadh)`,
    open: isAr ? 'فتح في وصل ↗' : 'Open in Wassel ↗',
    footer: isAr ? 'وصل — تقرير تحليلات مجدول.' : 'Wassel — scheduled analytics report.',
    signoff: isAr ? '— تقرير وصل المجدول' : '— Wassel scheduled report',
    warnings: isAr ? 'تنبيهات' : 'warnings',
  };

  const htmlParts: string[] = [];
  const textParts: string[] = [];

  for (const sec of sections) {
    htmlParts.push(`<h2 style="color:${CHARCOAL};font-size:16px;margin:24px 0 8px;">${esc(sec.title)}</h2>`);
    textParts.push(`\n## ${sec.title}`);

    if (isScalar(sec.result)) {
      const total = sec.result.rows[0]?.value ?? sec.result.total ?? null;
      htmlParts.push(`<div style="font-size:32px;font-weight:bold;color:${COPPER};" dir="ltr">${esc(fmt(total, sec.numberFormat))}</div>`);
      textParts.push(`${fmt(total, sec.numberFormat)}`);
    } else {
      const rows = sectionRows(sec.result, lang);
      const cells = rows
        .map(
          (row) =>
            `<tr><td style="padding:6px 10px;border-bottom:1px solid ${SAND}66;color:${CHARCOAL};">${esc(row.label)}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid ${SAND}66;text-align:${endAlign};font-weight:bold;color:${CHARCOAL};" dir="ltr">${esc(fmt(row.value, sec.numberFormat))}</td></tr>`,
        )
        .join('');
      htmlParts.push(
        `<table style="border-collapse:collapse;width:100%;max-width:520px;font-size:13px;">` +
          `<tr><th style="text-align:${startAlign};padding:6px 10px;border-bottom:2px solid ${COPPER};color:${COPPER};">${L.category}</th>` +
          `<th style="text-align:${endAlign};padding:6px 10px;border-bottom:2px solid ${COPPER};color:${COPPER};">${L.value}</th></tr>${cells}</table>`,
      );
      for (const row of rows) textParts.push(`  ${row.label}: ${fmt(row.value, sec.numberFormat)}`);
    }

    const warns = sec.result.warnings ?? [];
    if (warns.length > 0) {
      const w = warns.map((x) => x.code).join(', ');
      htmlParts.push(`<div style="font-size:11px;color:#b45309;margin-top:6px;">⚠ ${esc(w)}</div>`);
      textParts.push(`  (${L.warnings}: ${w})`);
    }
  }

  const linkHtml = link
    ? `<p style="margin-top:24px;"><a href="${esc(link)}" style="color:${COPPER};">${L.open}</a></p>`
    : '';
  const linkText = link ? `\n${isAr ? 'فتح في وصل' : 'Open in Wassel'}: ${link}` : '';

  const html =
    `<div dir="${dir}" style="font-family:Arial,Helvetica,sans-serif;background:${CREAM};padding:24px;color:${CHARCOAL};">` +
    `<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid ${SAND}66;border-radius:12px;padding:24px;">` +
    `<h1 style="color:${COPPER};font-size:20px;margin:0 0 4px;">${esc(reportTitle)}</h1>` +
    `<div style="font-size:12px;color:${CHARCOAL}99;">${esc(L.asOf)}</div>` +
    htmlParts.join('') +
    linkHtml +
    `<hr style="border:none;border-top:1px solid ${SAND}66;margin:24px 0 8px;">` +
    `<div style="font-size:11px;color:${CHARCOAL}80;">${L.footer}</div>` +
    `</div></div>`;

  const text =
    `${reportTitle}\n${L.asOf}\n` + textParts.join('\n') + linkText + `\n\n${L.signoff}`;

  return { subject: `${reportTitle} — ${asOf}`, html, text };
}
