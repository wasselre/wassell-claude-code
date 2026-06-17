/**
 * Phase 7 — build the four downstream Sales-Lifecycle models as a migration.
 *
 * Offer Prices → Reservations → Financing → Ownership Transfer. These models
 * exist ONLY in Supabase (created at runtime), so per the "seed-backfill writes
 * broken lookups" lesson we create them via a SQL migration with the LIVE
 * lookup target ids — never via seedModels.ts (whose per-load uuid() lookup ids
 * would be stale in prod). Model ids are FIXED (deterministic) so reservations
 * can reference the offer_prices model id and the migration is re-runnable
 * (ON CONFLICT (id) DO NOTHING).
 *
 * Unfrozen (is_hardcoded=false → JSONB in `records`); the models_view_sync
 * trigger auto-generates v_<name> on insert. Group = the sales model group.
 *
 * Run:  node scripts/build-downstream-models.mjs   (writes the .sql; pure, no DB)
 */
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ── Live ids (verified against wassell-prod) ────────────────────────────────
const CLIENTS = '2e86f197-385f-4853-908f-b4cb7237f7d8';
const OUR_PROJECTS = '6609286a-f95a-45db-94e6-48cfa915ccbd';
const UNITS = '7ca3014d-f658-418e-9c53-2d279c97f009';
const SALES_GROUP = 'ea355303-a1b2-4070-9e06-9be271a1bcc5';
// our_projects' project_name field (fieldId::slug display spec, copied from the
// live `visits` model's project_id lookup).
const PROJECT_NAME_DISPLAY = '27ae1692-c5dd-4ee7-85e2-8b9272b05afc::project_name';

// Fixed model ids so cross-model lookups + re-runs are deterministic.
const M = {
  offer_prices: '5a1e0ffe-0000-4000-8000-000000000001',
  reservations: '5a1e0ffe-0000-4000-8000-000000000002',
  financing: '5a1e0ffe-0000-4000-8000-000000000003',
  ownership_transfer: '5a1e0ffe-0000-4000-8000-000000000004',
};

// ── Field builders ──────────────────────────────────────────────────────────
let order = 0;
function base(sectionId, name, type, label_ar, label_en, extra = {}) {
  return {
    id: randomUUID(), name, type, order: order++, width: 'half',
    label_ar, label_en, required: false, section_id: sectionId,
    show_in_table: false, ...extra,
  };
}
const text = (s, n, ar, en, x) => base(s, n, 'text', ar, en, x);
const notes = (s, n, ar, en, x) => base(s, n, 'notes', ar, en, { width: 'full', ...x });
const currency = (s, n, ar, en, x) => base(s, n, 'currency', ar, en, { show_in_table: true, ...x });
const date = (s, n, ar, en, x) => base(s, n, 'date', ar, en, x);
const datetime = (s, n, ar, en, x) => base(s, n, 'datetime', ar, en, x);
const assignee = (s, n, ar, en, x) =>
  base(s, n, 'assignee', ar, en, {
    default_dynamic: 'current_user', assignee_role_ids: [], assignee_profile_ids: [],
    assignee_user_filter_mode: 'all', lookup_display_field: null, ...x,
  });
const lookup = (s, n, ar, en, targetModel, displayField, x) =>
  base(s, n, 'lookup', ar, en, {
    is_multi: false, lookup_model_id: targetModel, lookup_display_field: displayField,
    lookup_max_records: 20, visible_when: null, ...x,
  });
const unitPicker = (s, n, ar, en, x) =>
  base(s, n, 'unit_picker', ar, en, {
    is_multi: false, unit_picker_unit_model_id: UNITS,
    unit_picker_project_link_field: 'project_id', ...x,
  });
function dropdown(s, n, ar, en, opts, x) {
  return base(s, n, 'dropdown', ar, en, {
    show_in_table: true,
    options: opts.map((o) => ({
      id: randomUUID(), value: o.value, label_ar: o.ar, label_en: o.en, color: o.color ?? '#C09B5F',
    })),
    ...x,
  });
}

function model(id, name, label_ar, label_en, sectionLabelAr, sectionLabelEn, buildFields) {
  order = 0;
  const sectionId = randomUUID();
  const fields = buildFields(sectionId);
  const clientField = fields.find((f) => f.name === 'client_id');
  return {
    id, name, label_ar, label_en,
    icon: 'database', color: '#B8734F',
    group_id: SALES_GROUP, is_system: false, is_hardcoded: false,
    card_config: { title_field_id: clientField ? clientField.id : null, shown_field_ids: [] },
    schema: {
      sections: [{
        id: sectionId, color: '#B8734F', order: 0, is_base: true,
        label_ar: sectionLabelAr, label_en: sectionLabelEn, fields,
      }],
      custom_buttons: [],
      section_selector_field_id: null,
    },
  };
}

// ── The four models ─────────────────────────────────────────────────────────
const models = [
  model(M.offer_prices, 'offer_prices', 'عروض الأسعار', 'Offer Prices', 'تفاصيل العرض', 'Offer Details', (s) => [
    lookup(s, 'client_id', 'العميل', 'Client', CLIENTS, 'client_id', { show_in_table: true }),
    lookup(s, 'project_id', 'المشروع', 'Project', OUR_PROJECTS, PROJECT_NAME_DISPLAY, { show_in_table: true }),
    unitPicker(s, 'unit_id', 'الوحدة', 'Unit'),
    currency(s, 'offer_amount', 'قيمة العرض', 'Offer Amount'),
    dropdown(s, 'offer_status', 'حالة العرض', 'Offer Status', [
      { value: 'sent', ar: 'مُرسَل', en: 'Sent', color: '#C09B5F' },
      { value: 'signed', ar: 'تم التوقيع', en: 'Signed', color: '#B8734F' },
      { value: 'accepted', ar: 'مقبول', en: 'Accepted', color: '#10B981' },
      { value: 'rejected', ar: 'مرفوض', en: 'Rejected', color: '#EF4444' },
      { value: 'expired', ar: 'منتهي', en: 'Expired', color: '#6B7280' },
    ]),
    datetime(s, 'offer_date', 'تاريخ العرض', 'Offer Date', { default_dynamic: 'now', show_in_table: true }),
    date(s, 'valid_until', 'صالح حتى', 'Valid Until'),
    assignee(s, 'sales_rep', 'ممثل المبيعات', 'Sales Rep'),
    notes(s, 'notes', 'ملاحظات', 'Notes'),
  ]),

  model(M.reservations, 'reservations', 'الحجوزات', 'Reservations', 'تفاصيل الحجز', 'Reservation Details', (s) => [
    lookup(s, 'client_id', 'العميل', 'Client', CLIENTS, 'client_id', { show_in_table: true }),
    lookup(s, 'offer_id', 'العرض', 'Offer', M.offer_prices, 'offer_amount'),
    lookup(s, 'project_id', 'المشروع', 'Project', OUR_PROJECTS, PROJECT_NAME_DISPLAY, { show_in_table: true }),
    unitPicker(s, 'unit_id', 'الوحدة', 'Unit'),
    currency(s, 'reservation_amount', 'قيمة الحجز', 'Reservation Amount'),
    dropdown(s, 'payment_status', 'حالة الدفع', 'Payment Status', [
      { value: 'pending', ar: 'قيد الانتظار', en: 'Pending', color: '#C09B5F' },
      { value: 'cheque_received', ar: 'تم استلام الشيك', en: 'Cheque Received', color: '#B8734F' },
      { value: 'paid', ar: 'مدفوع', en: 'Paid', color: '#10B981' },
    ]),
    datetime(s, 'reservation_date', 'تاريخ الحجز', 'Reservation Date', { default_dynamic: 'now', show_in_table: true }),
    assignee(s, 'sales_rep', 'ممثل المبيعات', 'Sales Rep'),
    notes(s, 'notes', 'ملاحظات', 'Notes'),
  ]),

  model(M.financing, 'financing', 'التمويل', 'Financing', 'تفاصيل التمويل', 'Financing Details', (s) => [
    lookup(s, 'client_id', 'العميل', 'Client', CLIENTS, 'client_id', { show_in_table: true }),
    lookup(s, 'project_id', 'المشروع', 'Project', OUR_PROJECTS, PROJECT_NAME_DISPLAY, { show_in_table: true }),
    dropdown(s, 'financing_status', 'حالة التمويل', 'Financing Status', [
      { value: 'documents_required', ar: 'مطلوب مستندات', en: 'Documents Required', color: '#C09B5F' },
      { value: 'bank_submitted', ar: 'تم التقديم للبنك', en: 'Submitted to Bank', color: '#8E4E3A' },
      { value: 'valuation', ar: 'التقييم', en: 'Valuation', color: '#B8734F' },
      { value: 'approval', ar: 'الموافقة', en: 'Approval', color: '#C09B5F' },
      { value: 'checks', ar: 'الشيكات', en: 'Cheques', color: '#B8734F' },
      { value: 'contract', ar: 'العقد', en: 'Contract', color: '#8E4E3A' },
      { value: 'completed', ar: 'مكتمل', en: 'Completed', color: '#10B981' },
    ]),
    text(s, 'bank_name', 'البنك', 'Bank'),
    currency(s, 'requested_amount', 'مبلغ التمويل', 'Requested Amount'),
    date(s, 'submitted_date', 'تاريخ التقديم', 'Submitted Date'),
    date(s, 'approval_date', 'تاريخ الموافقة', 'Approval Date'),
    assignee(s, 'sales_rep', 'ممثل المبيعات', 'Sales Rep'),
    notes(s, 'notes', 'ملاحظات', 'Notes'),
  ]),

  model(M.ownership_transfer, 'ownership_transfer', 'الإفراغ', 'Ownership Transfer', 'تفاصيل الإفراغ', 'Transfer Details', (s) => [
    lookup(s, 'client_id', 'العميل', 'Client', CLIENTS, 'client_id', { show_in_table: true }),
    lookup(s, 'project_id', 'المشروع', 'Project', OUR_PROJECTS, PROJECT_NAME_DISPLAY, { show_in_table: true }),
    unitPicker(s, 'unit_id', 'الوحدة', 'Unit'),
    dropdown(s, 'transfer_status', 'حالة الإفراغ', 'Transfer Status', [
      { value: 'pending', ar: 'قيد التجهيز', en: 'Pending', color: '#C09B5F' },
      { value: 'form_issued', ar: 'تم إصدار النموذج', en: 'Form Issued', color: '#B8734F' },
      { value: 'scheduled', ar: 'محدد موعد', en: 'Scheduled', color: '#8E4E3A' },
      { value: 'completed', ar: 'تم الإفراغ', en: 'Completed', color: '#10B981' },
    ]),
    text(s, 'deed_number', 'رقم الصك', 'Deed Number'),
    date(s, 'transfer_date', 'تاريخ الإفراغ', 'Transfer Date', { show_in_table: true }),
    assignee(s, 'sales_rep', 'ممثل المبيعات', 'Sales Rep'),
    notes(s, 'notes', 'ملاحظات', 'Notes'),
  ]),
];

// ── Emit migration SQL ──────────────────────────────────────────────────────
function sqlStr(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function jsonbLit(obj) { return sqlStr(JSON.stringify(obj)) + '::jsonb'; }

const rows = models.map((m) => `  (
    ${sqlStr(m.id)}, ${sqlStr(m.name)}, ${sqlStr(m.label_ar)}, ${sqlStr(m.label_en)},
    ${sqlStr(m.icon)}, ${sqlStr(m.color)}, ${sqlStr(m.group_id)}, ${m.is_system}, ${m.is_hardcoded},
    ${jsonbLit(m.schema)}, ${jsonbLit(m.card_config)}
  )`).join(',\n');

const sql = `-- Phase 7 — downstream Sales-Lifecycle models (offer_prices, reservations,
-- financing, ownership_transfer). Generated by scripts/build-downstream-models.mjs.
-- Unfrozen (is_hardcoded=false → JSONB in records); models_view_sync auto-builds
-- v_<name>. Lookups use LIVE target ids (clients ${CLIENTS}, our_projects
-- ${OUR_PROJECTS}, units ${UNITS}); fixed model ids so reservations.offer_id
-- references offer_prices and the migration is re-runnable.

INSERT INTO public.models (id, name, label_ar, label_en, icon, color, group_id, is_system, is_hardcoded, schema, card_config)
VALUES
${rows}
ON CONFLICT (id) DO NOTHING;
`;

const outPath = new URL('../supabase/migrations/2026-06-17_sales_os_downstream_models.sql', import.meta.url);
writeFileSync(outPath, sql);
console.log('Wrote', outPath.pathname);
console.log('Model ids:', JSON.stringify(M, null, 2));
