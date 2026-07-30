/**
 * The writing surface — design screens 07 and 08.
 *
 * Which fields appear is driven by the content type's `field_schema`, which
 * lives in the database. That is the "one Content entity" argument made
 * concrete: a Post shows headlines and a caption, a Video shows idea/hook/
 * script, and adding a Brochure type later is a row, not a new module.
 *
 * Values live in `mos_content.data` — the one bounded JSONB column, holding
 * only creative prose that is never filtered or sorted on.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { updateContent } from '@/lib/marketingOS/client';
import { num } from '../lib/format';

interface FieldDef {
  ar: string;
  en: string;
  kind: 'short' | 'long' | 'list';
  hint_ar?: string;
  hint_en?: string;
}

/**
 * The catalogue every content type draws from. A key in a type's `field_schema`
 * that is not here simply doesn't render — unknown config degrades quietly
 * rather than crashing the tab.
 */
const FIELDS: Record<string, FieldDef> = {
  idea:              { ar: 'الفكرة', en: 'Idea', kind: 'long' },
  hook:              { ar: 'الافتتاحية', en: 'Hook', kind: 'short',
                       hint_ar: 'أول ٣ ثوانٍ', hint_en: 'first 3 seconds' },
  script:            { ar: 'النص', en: 'Script', kind: 'long' },
  voiceover:         { ar: 'نص التعليق الصوتي', en: 'Voice-over', kind: 'long' },
  duration:          { ar: 'المدة', en: 'Duration', kind: 'short' },
  aspect_ratio:      { ar: 'نسبة العرض', en: 'Aspect ratio', kind: 'short' },
  headlines:         { ar: 'العناوين المقترحة', en: 'Draft headlines', kind: 'list',
                       hint_ar: 'خيار في كل سطر', hint_en: 'one option per line' },
  approved_headline: { ar: 'العنوان المعتمد', en: 'Approved headline', kind: 'short' },
  caption:           { ar: 'الكابشن', en: 'Caption', kind: 'long' },
  hashtags:          { ar: 'الوسوم', en: 'Hashtags', kind: 'short' },
  design_brief:      { ar: 'موجز التصميم', en: 'Design brief', kind: 'long' },
  slides:            { ar: 'الشرائح', en: 'Slides', kind: 'list',
                       hint_ar: 'شريحة في كل سطر', hint_en: 'one slide per line' },
  expiry:            { ar: 'تاريخ الانتهاء', en: 'Expiry', kind: 'short' },
};

export default function WritingFields({
  contentId, schema, data, canEdit, isAr, onSaved,
}: {
  contentId: string;
  schema: string[];
  data: Record<string, unknown>;
  canEdit: boolean;
  isAr: boolean;
  onSaved: (data: Record<string, unknown>) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const key of schema) {
      const v = data[key];
      next[key] = Array.isArray(v) ? (v as string[]).join('\n') : typeof v === 'string' ? v : '';
    }
    setDraft(next);
  }, [schema, data]);

  const known = useMemo(() => schema.filter((k) => FIELDS[k]), [schema]);

  const dirty = known.some((key) => {
    const orig = data[key];
    const origStr = Array.isArray(orig)
      ? (orig as string[]).join('\n')
      : typeof orig === 'string' ? orig : '';
    return (draft[key] ?? '') !== origStr;
  });

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { ...data };
      for (const key of known) {
        const raw = draft[key] ?? '';
        payload[key] = FIELDS[key]?.kind === 'list'
          ? raw.split('\n').map((l) => l.trim()).filter(Boolean)
          : raw;
      }
      await updateContent(contentId, { data: payload });
      onSaved(payload);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (known.length === 0) {
    return (
      <div className="write" style={{ textAlign: 'center', color: 'var(--mute)', fontSize: 13 }}>
        {isAr ? 'لا حقول كتابة لهذا النوع.' : 'This type has no writing fields.'}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {known.map((key) => {
        const def = FIELDS[key];
        if (!def) return null;
        const hint = isAr ? def.hint_ar : def.hint_en;
        const value = draft[key] ?? '';
        const words = value.trim() ? value.trim().split(/\s+/).length : 0;
        return (
          <div key={key} className="write">
            <div className="doc-lbl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{isAr ? def.ar : def.en}</span>
              {hint && <span style={{ fontWeight: 400 }}>· {hint}</span>}
              {def.kind !== 'short' && value && (
                <span style={{ marginInlineStart: 'auto', fontWeight: 400 }}>
                  {isAr ? `${num(words, true)} كلمة` : `${words} words`}
                </span>
              )}
            </div>
            {def.kind === 'short' ? (
              <input
                className="inp"
                value={value}
                disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            ) : (
              <textarea
                className="inp"
                rows={def.kind === 'list' ? 5 : 7}
                value={value}
                disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            )}
          </div>
        );
      })}

      {canEdit ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
          {dirty && (
            <span style={{ fontSize: 12, color: 'var(--wait)', fontWeight: 700 }}>
              {isAr ? 'تغييرات غير محفوظة' : 'Unsaved changes'}
            </span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--mute)' }}>
          {isAr
            ? 'للقراءة فقط — هذه المرحلة ليست لدى دورك.'
            : 'Read-only — this stage does not sit with your role.'}
        </div>
      )}
    </div>
  );
}
