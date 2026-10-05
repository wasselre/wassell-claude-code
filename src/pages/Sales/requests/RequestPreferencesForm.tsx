/**
 * The request's fields — which ARE the client's preference fields.
 *
 * An unanswered request has no text of its own: it is built from the client's
 * saved preferences (unit type, requested districts, budget, …), the same
 * fields as the client's Preferences tab, rendered by the same schema-bound
 * DynamicField pickers and saved through the same `saveClientPreferences` path.
 * What a request cannot work without (requestReadiness.ts) is starred and
 * flagged while empty: a unit type, a district, and ONE of budget / bedrooms /
 * size (those three share one star group — any one fills it).
 *
 * Controlled: the host owns the draft (useRecordDraft on the client) and saves.
 */
import { useMemo } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import DynamicField from '@/pages/Records/components/DynamicField';
import type { AppModel, AppRecord, ModelField } from '@/types';
import { allFields, isDerivedReadOnly } from '@/pages/Clients/lib/clientView';
import { gapListText, requestPreferenceGaps, type RequestGap } from '@/lib/clients/requestReadiness';

/** The client preference fields a request is made of, in display order. */
export const REQUEST_PREF_SLUGS = [
  'preferred_unit_type',
  'location',
  'budget',
  'preferred_readiness',
  'preferred_bedrooms',
  'preferred_area',
  'preferred_amenities',
] as const;

/** Which gap each field closes (the `location` field carries the districts;
 *  budget, bedrooms and size each close the same «one of» gap). */
const GAP_OF: Partial<Record<string, RequestGap>> = {
  preferred_unit_type: 'unit_type',
  location: 'districts',
  budget: 'specs',
  preferred_bedrooms: 'specs',
  preferred_area: 'specs',
};

const FULL_WIDTH_TYPES = new Set(['location', 'multiselect']);

/** The live model fields for {@link REQUEST_PREF_SLUGS} (missing slugs skipped). */
export function requestPrefFields(clientsModel: AppModel): ModelField[] {
  const all = allFields(clientsModel);
  return REQUEST_PREF_SLUGS
    .filter((slug) => !isDerivedReadOnly(slug))
    .map((slug) => all.find((f) => f.name === slug))
    .filter((f): f is ModelField => !!f);
}

interface Props {
  client: AppRecord;
  clientsModel: AppModel;
  draft: Record<string, unknown>;
  patchDraft: (patch: Record<string, unknown>) => void;
  isAr: boolean;
  disabled?: boolean;
}

export default function RequestPreferencesForm({ client, clientsModel, draft, patchDraft, isAr, disabled }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const fields = useMemo(() => requestPrefFields(clientsModel), [clientsModel]);
  const gaps = requestPreferenceGaps(draft);

  return (
    <div className="space-y-3">
      {gaps.length > 0 ? (
        <div className="flex items-start gap-2 rounded-xl border border-[#C09B5F]/40 bg-[#C09B5F]/10 px-3 py-2.5 text-xs text-[#8E4E3A]">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>
            {L('الطلب يُبنى من تفضيلات العميل المحفوظة. أكمل أولاً: ', "The request is built from the client's saved preferences. Fill in first: ")}
            <b>{gapListText(gaps, isAr)}</b>
            {gaps.includes('districts') && (
              <span className="block text-[#8E4E3A]/80">
                {L('المكاتب تُختار حسب الأحياء — أضف حياً واحداً على الأقل من «إضافة حي».', 'Offices are matched by district — add at least one with «Add district».')}
              </span>
            )}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <CheckCircle2 size={15} className="shrink-0" />
          {L('تفضيلات العميل مكتملة — جاهزة لتكون طلباً.', "The client's preferences are complete — ready to be a request.")}
        </div>
      )}

      {/* fieldset[disabled] disables every native input inside the pickers. */}
      <fieldset disabled={disabled} className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${disabled ? 'pointer-events-none opacity-60' : ''}`}>
        {fields.map((field) => {
          const gap = GAP_OF[field.name];
          const missing = !!gap && gaps.includes(gap);
          return (
            <div key={field.id} className={FULL_WIDTH_TYPES.has(field.type) ? 'sm:col-span-2' : ''}>
              <label className={`mb-1 flex items-center gap-1 text-xs font-semibold ${missing ? 'text-terracotta' : 'text-charcoal/60'}`}>
                {isAr ? field.label_ar : field.label_en}
                {gap && <span className="text-terracotta">*</span>}
                {gap === 'specs' && (
                  <span className="text-[10px] font-normal text-charcoal/45">{L('(واحد من الميزانية / الغرف / المساحة يكفي)', '(budget, bedrooms or size — one is enough)')}</span>
                )}
              </label>
              <div className={missing ? 'rounded-lg ring-1 ring-[#C09B5F]/60' : ''}>
                <DynamicField
                  field={field}
                  value={draft[field.name]}
                  onChange={(v) => patchDraft({ [field.name]: v })}
                  recordData={draft}
                  modelId={clientsModel.id}
                  recordId={client.id}
                  onPatch={patchDraft}
                  compact /* the label above carries the name + the required star */
                />
              </div>
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}
