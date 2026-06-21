/**
 * STARTER content for record-document templates.
 *
 * These are NOT the generation engine — they are editable starting points. The
 * "New template" flow instantiates one as an ordinary wassel_doc, then the user
 * owns/edits it (branding, logo, terms, layout) in the normal Documents editor.
 * The engine always reads the live wassel_doc, never this code (per the user's
 * explicit direction: do not hardcode Offer/Reservation templates).
 *
 * `{{token}}` placeholders align with the bound model's field slugs + the
 * linked client/unit/project slugs, so they auto-fill at generation time
 * (see worker/src/runDocumentJob.ts + worker/src/documents/variables.ts).
 * Engine-resolved extras: {{today}}, {{sales_rep}}, {{client_phone}}.
 */

import type { JSONContent } from '@tiptap/core';

// ─── JSON builders ────────────────────────────────────────────────────────

type Inline = JSONContent;
const t = (text: string): Inline => ({ type: 'text', text });
const b = (text: string): Inline => ({ type: 'text', marks: [{ type: 'bold' }], text });
const h = (level: 1 | 2 | 3, ...content: Inline[]): JSONContent => ({ type: 'heading', attrs: { level }, content });
const p = (...content: Inline[]): JSONContent =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
const li = (...blocks: JSONContent[]): JSONContent => ({ type: 'listItem', content: blocks });
const bullets = (items: string[]): JSONContent => ({
  type: 'bulletList',
  content: items.map((it) => li(p(t(it)))),
});
const hr = (): JSONContent => ({ type: 'horizontalRule' });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });
const hCenter = (level: 1 | 2 | 3, text: string): JSONContent => ({
  type: 'heading',
  attrs: { level, textAlign: 'center' },
  content: [t(text)],
});
const pCenter = (...content: Inline[]): JSONContent => ({ type: 'paragraph', attrs: { textAlign: 'center' }, content });

/** A label→value row in a 2-column table; the label cell is a shaded header. */
function kvRow(label: string, valueToken: string): JSONContent {
  return {
    type: 'tableRow',
    content: [
      { type: 'tableHeader', content: [p(b(label))] },
      { type: 'tableCell', content: [p(t(valueToken))] },
    ],
  };
}
function kvTable(rows: Array<[string, string]>): JSONContent {
  return { type: 'table', content: rows.map(([label, token]) => kvRow(label, token)) };
}

const signatureBlock = (isAr: boolean): JSONContent[] =>
  isAr
    ? [hr(), p(b('توقيع العميل: '), t('____________________')), p(b('توقيع ممثل المبيعات: '), t('____________________'))]
    : [hr(), p(b('Client signature: '), t('____________________')), p(b('Sales rep signature: '), t('____________________'))];

// ─── Starter registry ───────────────────────────────────────────────────────

export interface RecordDocStarter {
  id: string;
  /** Model.name this starter is designed for (drives the New-template picker). */
  modelName: string;
  labelAr: string;
  labelEn: string;
  /** Suggested template_key for the binding. */
  templateKey: string;
  build: (isAr: boolean) => JSONContent;
}

const reservation: RecordDocStarter = {
  id: 'reservation_form',
  modelName: 'reservations',
  labelAr: 'سند حجز وحدة',
  labelEn: 'Unit Reservation',
  templateKey: 'reservation_form',
  build: (isAr) =>
    isAr
      ? doc(
          hCenter(1, 'سند حجز وحدة'),
          pCenter(b('وصل العقارية')),
          p(t('التاريخ: {{today}}')),
          hr(),
          h(2, t('بيانات الحجز')),
          kvTable([
            ['العميل', '{{client_name}}'],
            ['رقم الجوال', '{{client_phone}}'],
            ['المشروع', '{{project_name}}'],
            ['الوحدة', '{{unit_number}}'],
            ['نوع الوحدة', '{{unit_type}}'],
            ['المساحة', '{{unit_area}}'],
            ['سعر الوحدة', '{{total_price}}'],
            ['قيمة الحجز', '{{reservation_amount}}'],
            ['حالة الدفع', '{{payment_status}}'],
            ['تاريخ الحجز', '{{reservation_date}}'],
            ['ممثل المبيعات', '{{sales_rep}}'],
          ]),
          h(2, t('الشروط والأحكام')),
          bullets([
            'هذا الحجز مبدئي ولا يُعد عقد بيع نهائياً.',
            'قيمة الحجز غير مستردة في حال عدول العميل خلال المدة المتفق عليها.',
            'تخضع هذه الوثيقة لأنظمة المملكة العربية السعودية.',
          ]),
          ...signatureBlock(true),
        )
      : doc(
          hCenter(1, 'Unit Reservation'),
          pCenter(b('Wassel Real Estate')),
          p(t('Date: {{today}}')),
          hr(),
          h(2, t('Reservation Details')),
          kvTable([
            ['Client', '{{client_name}}'],
            ['Phone', '{{client_phone}}'],
            ['Project', '{{project_name}}'],
            ['Unit', '{{unit_number}}'],
            ['Unit type', '{{unit_type}}'],
            ['Area', '{{unit_area}}'],
            ['Unit price', '{{total_price}}'],
            ['Reservation amount', '{{reservation_amount}}'],
            ['Payment status', '{{payment_status}}'],
            ['Reservation date', '{{reservation_date}}'],
            ['Sales rep', '{{sales_rep}}'],
          ]),
          h(2, t('Terms & Conditions')),
          bullets([
            'This reservation is preliminary and is not a final sale contract.',
            'The reservation amount is non-refundable if the client withdraws within the agreed period.',
            'This document is governed by the laws of the Kingdom of Saudi Arabia.',
          ]),
          ...signatureBlock(false),
        ),
};

const offer: RecordDocStarter = {
  id: 'offer_letter',
  modelName: 'offer_prices',
  labelAr: 'عرض سعر',
  labelEn: 'Price Offer',
  templateKey: 'offer_letter',
  build: (isAr) =>
    isAr
      ? doc(
          hCenter(1, 'عرض سعر'),
          pCenter(b('وصل العقارية')),
          p(t('التاريخ: {{today}}')),
          hr(),
          h(2, t('بيانات العرض')),
          kvTable([
            ['العميل', '{{client_name}}'],
            ['رقم الجوال', '{{client_phone}}'],
            ['المشروع', '{{project_name}}'],
            ['الوحدة', '{{unit_number}}'],
            ['نوع الوحدة', '{{unit_type}}'],
            ['المساحة', '{{unit_area}}'],
            ['قيمة العرض', '{{offer_amount}}'],
            ['حالة العرض', '{{offer_status}}'],
            ['تاريخ العرض', '{{offer_date}}'],
            ['صالح حتى', '{{valid_until}}'],
            ['ممثل المبيعات', '{{sales_rep}}'],
          ]),
          h(2, t('ملاحظات')),
          bullets([
            'هذا العرض مبدئي وقابل للتغيير حتى توقيع العقد النهائي.',
            'الأسعار شاملة/غير شاملة الرسوم حسب الاتفاق.',
          ]),
          ...signatureBlock(true),
        )
      : doc(
          hCenter(1, 'Price Offer'),
          pCenter(b('Wassel Real Estate')),
          p(t('Date: {{today}}')),
          hr(),
          h(2, t('Offer Details')),
          kvTable([
            ['Client', '{{client_name}}'],
            ['Phone', '{{client_phone}}'],
            ['Project', '{{project_name}}'],
            ['Unit', '{{unit_number}}'],
            ['Unit type', '{{unit_type}}'],
            ['Area', '{{unit_area}}'],
            ['Offer amount', '{{offer_amount}}'],
            ['Offer status', '{{offer_status}}'],
            ['Offer date', '{{offer_date}}'],
            ['Valid until', '{{valid_until}}'],
            ['Sales rep', '{{sales_rep}}'],
          ]),
          h(2, t('Notes')),
          bullets([
            'This offer is preliminary and subject to change until the final contract is signed.',
            'Prices are inclusive/exclusive of fees as agreed.',
          ]),
          ...signatureBlock(false),
        ),
};

export const RECORD_DOC_STARTERS: RecordDocStarter[] = [reservation, offer];

/** Starters designed for a given model (by name), for the New-template picker. */
export function startersForModel(modelName: string): RecordDocStarter[] {
  return RECORD_DOC_STARTERS.filter((s) => s.modelName === modelName);
}

/** Resolve {{today}} at build time so a freshly-created template reads cleanly
 *  in the editor before any record is ever bound. (The engine re-resolves
 *  {{today}} per generation, so this is only the editor preview.) */
export function buildStarterContent(starter: RecordDocStarter, isAr: boolean): JSONContent {
  return starter.build(isAr);
}
