/**
 * The writing surfaces — design screens 7 and 8.
 *
 * Which fields appear is driven by the content type's `field_schema`, seeded in
 * the database. That is the whole "one Content entity" argument made concrete:
 * a Post shows headlines and a caption, a Video shows idea/hook/script, and
 * adding a Brochure type later is a row rather than a new module.
 *
 * Values live in `mos_content.data` — the one bounded JSONB column, holding only
 * creative prose that is never filtered or sorted on.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { updateContent } from '@/lib/marketingOS/client';

interface FieldDef {
  key: string;
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
  idea:               { key: 'idea', ar: 'الفكرة', en: 'Idea', kind: 'long' },
  hook:               { key: 'hook', ar: 'الافتتاحية', en: 'Hook', kind: 'short',
                        hint_ar: 'أول ٣ ثوانٍ', hint_en: 'first 3 seconds' },
  script:             { key: 'script', ar: 'النص', en: 'Script', kind: 'long' },
  voiceover:          { key: 'voiceover', ar: 'نص التعليق الصوتي', en: 'Voice-over', kind: 'long' },
  duration:           { key: 'duration', ar: 'المدة', en: 'Duration', kind: 'short' },
  aspect_ratio:       { key: 'aspect_ratio', ar: 'نسبة العرض', en: 'Aspect ratio', kind: 'short' },
  headlines:          { key: 'headlines', ar: 'العناوين المقترحة', en: 'Draft headlines', kind: 'list',
                        hint_ar: 'اكتب عدة خيارات — واحدًا في كل سطر',
                        hint_en: 'write several options — one per line' },
  approved_headline:  { key: 'approved_headline', ar: 'العنوان المعتمد', en: 'Approved headline', kind: 'short' },
  caption:            { key: 'caption', ar: 'الكابشن', en: 'Caption', kind: 'long' },
  hashtags:           { key: 'hashtags', ar: 'الوسوم', en: 'Hashtags', kind: 'short' },
  design_brief:       { key: 'design_brief', ar: 'موجز التصميم', en: 'Design brief', kind: 'long' },
  slides:             { key: 'slides', ar: 'الشرائح', en: 'Slides', kind: 'list',
                        hint_ar: 'شريحة في كل سطر', hint_en: 'one slide per line' },
  expiry:             { key: 'expiry', ar: 'تاريخ الانتهاء', en: 'Expiry', kind: 'short' },
};

interface Props {
  contentId: string;
  schema: string[];
  data: Record<string, unknown>;
  canEdit: boolean;
  isAr: boolean;
  onSaved: (data: Record<string, unknown>) => void;
}

export default function ContentFields({
  contentId, schema, data, canEdit, isAr, onSaved,
}: Props) {
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

  const dirty = schema.some((key) => {
    const orig = data[key];
    const origStr = Array.isArray(orig)
      ? (orig as string[]).join('\n')
      : typeof orig === 'string' ? orig : '';
    return (draft[key] ?? '') !== origStr;
  });

  const save = async () => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { ...data };
      for (const key of schema) {
        const def = FIELDS[key];
        const raw = draft[key] ?? '';
        if (def?.kind === 'list') {
          const items = raw.split('\n').map((l) => l.trim()).filter(Boolean);
          payload[key] = items;
        } else {
          payload[key] = raw;
        }
      }
      const res = await updateContent(contentId, { data: payload });
      onSaved(payload);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
      void res;
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const known = schema.filter((k) => FIELDS[k]);

  if (known.length === 0) {
    return (
      <div className="rounded-xl border border-sand bg-white p-6 text-center text-sm text-charcoal/55">
        {isAr ? 'لا توجد حقول لهذا النوع.' : 'This type has no writing fields.'}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {known.map((key) => {
        const def = FIELDS[key]!;
        const hint = isAr ? def.hint_ar : def.hint_en;
        return (
          <div key={key} className="rounded-xl border border-sand bg-white p-4">
            <label className="block text-xs font-bold text-charcoal/55">
              {isAr ? def.ar : def.en}
              {hint && <span className="ms-2 font-normal text-charcoal/40">· {hint}</span>}
            </label>
            {def.kind === 'short' ? (
              <input
                value={draft[key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                disabled={!canEdit}
                className="form-input mt-2 w-full"
              />
            ) : (
              <textarea
                value={draft[key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                disabled={!canEdit}
                rows={def.kind === 'list' ? 5 : 6}
                className="form-input mt-2 w-full leading-relaxed"
              />
            )}
          </div>
        );
      })}

      {canEdit && (
        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </Button>
          {dirty && (
            <span className="text-xs text-amber-700">
              {isAr ? 'تغييرات غير محفوظة' : 'Unsaved changes'}
            </span>
          )}
        </div>
      )}
      {!canEdit && (
        <p className="text-xs text-charcoal/50">
          {isAr
            ? 'للقراءة فقط — هذه المرحلة ليست لدى دورك.'
            : 'Read-only — this stage does not sit with your role.'}
        </p>
      )}
    </div>
  );
}
