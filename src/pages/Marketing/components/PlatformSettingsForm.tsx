/**
 * Platform settings — one generic renderer for every ad platform's real
 * campaign-creation fields.
 *
 * The form is drawn entirely from the platform's schema
 * (src/lib/marketingOS/adPlatforms/): sections, fields, bilingual labels,
 * enum options, conditional visibility, and the two dependency rules the
 * real Ads Managers enforce — optimization goals filtered by objective, and
 * TikTok's goal → billing auto-fill. Adding a platform is a schema file,
 * not a component.
 */
import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { MosExecution, saveExecution } from '@/lib/marketingOS/client';
import {
  PlatformFieldDef, PlatformSchema, PlatformSection, PlatformSettings,
  autoFillAfterChange, fieldOptions, fieldVisible, settingsProgress,
} from '@/lib/marketingOS/adPlatforms';
import { Field } from './kit';
import { num } from '../lib/format';

/* ------------------------------------------------------------------ */
/* One field                                                           */
/* ------------------------------------------------------------------ */

function TagsInput({
  value, disabled, ltr, placeholder, onChange,
}: {
  value: string[];
  disabled: boolean;
  ltr?: boolean;
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  // The array is the stored truth; the text is what the human is mid-typing.
  // Splitting only on change (not on render) keeps a trailing comma visible.
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? value.join(', ');
  return (
    <input
      className={`inp${ltr ? ' ltr' : ''}`}
      value={shown}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean));
      }}
      onBlur={() => setText(null)}
    />
  );
}

function FieldControl({
  schema, field, draft, disabled, isAr, onChange,
}: {
  schema: PlatformSchema;
  field: PlatformFieldDef;
  draft: PlatformSettings;
  disabled: boolean;
  isAr: boolean;
  onChange: (key: string, value: PlatformSettings[string]) => void;
}) {
  const v = draft[field.key];
  const options = fieldOptions(schema, field, draft);

  switch (field.control) {
    case 'select': {
      const hasEmpty = options.some((o) => o.value === '');
      return (
        <select
          className="inp"
          value={typeof v === 'string' ? v : ''}
          disabled={disabled}
          onChange={(e) => onChange(field.key, e.target.value || null)}
        >
          {!hasEmpty && <option value="">{isAr ? 'غير محدد' : 'Not set'}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {(isAr ? o.ar : o.en) + (o.allowlist ? (isAr ? ' — بموافقة المنصة' : ' — needs platform approval') : '')}
            </option>
          ))}
        </select>
      );
    }
    case 'multiselect': {
      const arr = Array.isArray(v) ? v : [];
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {options.map((o) => {
            const on = arr.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                className="btn btn-sm"
                disabled={disabled}
                style={on
                  ? { background: 'var(--copper)', borderColor: 'var(--copper)', color: '#fff' }
                  : undefined}
                onClick={() => onChange(
                  field.key,
                  on ? arr.filter((x) => x !== o.value) : [...arr, o.value],
                )}
              >
                {isAr ? o.ar : o.en}
              </button>
            );
          })}
        </div>
      );
    }
    case 'tags':
      return (
        <TagsInput
          value={Array.isArray(v) ? v : []}
          disabled={disabled}
          ltr={field.ltr}
          placeholder={field.placeholder}
          onChange={(next) => onChange(field.key, next)}
        />
      );
    case 'number':
    case 'money':
      return (
        <input
          className="inp"
          inputMode="decimal"
          value={typeof v === 'number' ? String(v) : ''}
          disabled={disabled}
          placeholder={field.placeholder}
          onChange={(e) => {
            const t = e.target.value.trim();
            const n = t === '' ? null : Number(t);
            onChange(field.key, n !== null && Number.isNaN(n) ? null : n);
          }}
        />
      );
    case 'date':
      return (
        <input
          type="date"
          className="inp ltr"
          value={typeof v === 'string' ? v : ''}
          disabled={disabled}
          onChange={(e) => onChange(field.key, e.target.value || null)}
        />
      );
    case 'toggle':
      return (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: disabled ? 'default' : 'pointer' }}>
          <input
            type="checkbox"
            checked={v === true}
            disabled={disabled}
            onChange={(e) => onChange(field.key, e.target.checked)}
          />
          {v === true ? (isAr ? 'مفعّل' : 'On') : (isAr ? 'معطّل' : 'Off')}
        </label>
      );
    case 'textarea':
      return (
        <textarea
          className={`inp${field.ltr ? ' ltr' : ''}`}
          rows={3}
          value={typeof v === 'string' ? v : ''}
          disabled={disabled}
          placeholder={field.placeholder}
          maxLength={field.max}
          onChange={(e) => onChange(field.key, e.target.value || null)}
        />
      );
    case 'text':
    default:
      return (
        <input
          className={`inp${field.ltr ? ' ltr' : ''}`}
          value={typeof v === 'string' ? v : ''}
          disabled={disabled}
          placeholder={field.placeholder}
          maxLength={field.max}
          onChange={(e) => onChange(field.key, e.target.value || null)}
        />
      );
  }
}

/* ------------------------------------------------------------------ */
/* A grid of sections — reused by the ad-creative editor              */
/* ------------------------------------------------------------------ */

export function PlatformFieldsGrid({
  schema, sections, draft, disabled, isAr, onChange,
}: {
  schema: PlatformSchema;
  sections: PlatformSection[];
  draft: PlatformSettings;
  disabled: boolean;
  isAr: boolean;
  onChange: (next: PlatformSettings) => void;
}) {
  const change = (key: string, value: PlatformSettings[string]): void => {
    const next: PlatformSettings = { ...draft, [key]: value };
    Object.assign(next, autoFillAfterChange(schema, key, next));
    onChange(next);
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {sections.map((sec) => (
        <div key={sec.key}>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: 'var(--mute)',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              marginBottom: 8,
              paddingBottom: 5,
              borderBottom: '1px solid var(--line-soft)',
            }}
          >
            {isAr ? sec.ar : sec.en}
          </div>
          <div className="m4-2col">
            {sec.fields.filter((f) => fieldVisible(f, draft)).map((f) => (
              <Field
                key={f.key}
                label={(isAr ? f.ar : f.en) + (f.immutable ? (isAr ? ' 🔒' : ' 🔒') : '')}
                hint={f.immutable
                  ? (isAr ? 'لا يتغير بعد الإنشاء على المنصة' : 'fixed after creation on the platform')
                  : (isAr ? f.hint_ar : f.hint_en)}
              >
                <FieldControl
                  schema={schema}
                  field={f}
                  draft={draft}
                  disabled={disabled}
                  isAr={isAr}
                  onChange={change}
                />
              </Field>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The execution settings card (the «إعدادات المنصة» tab)              */
/* ------------------------------------------------------------------ */

export function PlatformSettingsForm({
  execution, schema, canEdit, isAr, onSaved,
}: {
  execution: MosExecution;
  schema: PlatformSchema;
  canEdit: boolean;
  isAr: boolean;
  onSaved: (settings: PlatformSettings) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [draft, setDraft] = useState<PlatformSettings>(
    (execution.platform_settings as PlatformSettings | null) ?? {},
  );
  const [busy, setBusy] = useState(false);
  const progress = settingsProgress(schema, draft);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await saveExecution(execution.campaign_id, { id: execution.id, platform_settings: draft });
      onSaved(draft);
      addToast(isAr ? 'حُفظت إعدادات المنصة.' : 'Platform settings saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'إعدادات المنصة' : 'Platform settings'}</h4>
        <span className="r">
          {isAr
            ? `${num(progress.set, true)} من ${num(progress.total, true)} حقلًا معبأ — نفس حقول مدير إعلانات المنصة`
            : `${progress.set} of ${progress.total} fields set — the platform's own Ads Manager fields`}
        </span>
      </div>
      <div className="card-b">
        <PlatformFieldsGrid
          schema={schema}
          sections={schema.sections}
          draft={draft}
          disabled={!canEdit || busy}
          isAr={isAr}
          onChange={setDraft}
        />
      </div>
      {canEdit && (
        <div className="card-b" style={{ paddingTop: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ الإعدادات' : 'Save settings'}
          </button>
          <span className="note">
            {isAr
              ? 'القيم بأسماء حقول المنصة الحقيقية — جاهزة للدفع عبر واجهاتها عند الربط.'
              : 'Values use the real platform field names — pushable through their APIs once connected.'}
          </span>
        </div>
      )}
    </div>
  );
}
