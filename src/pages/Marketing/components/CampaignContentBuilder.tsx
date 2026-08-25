/**
 * The campaign content builder — simplified (operator decision 2026-08-24).
 *
 * When creating a campaign you plan its content here. Each piece needs only THREE
 * things the writer fills: a TYPE (which drives its workflow/ref), a TITLE, and
 * NOTES. Everything else is DERIVED from the campaign and no longer asked here:
 *   • PLATFORM comes from the ad campaign (its executions) — not selectable.
 *   • PROJECT comes from the parent campaign — not selectable.
 * The NOTES land in the content's `data.notes` — the same field the content
 * detail page's «الموجز» shows — so what's written here is what the writer sees.
 *
 * Self-contained + controlled: the parent holds `drafts` and does the create
 * (deriving platforms + projectIds from the campaign at that point).
 */
import { useRef, useState } from 'react';
import type { MosContentType } from '@/lib/marketingOS/client';

/** One planned content piece. `key` is local-only; the server assigns the real id. */
export interface ContentDraft {
  key: string;
  typeKey: string;
  title: string;
  notes: string;
}

const MAX_BATCH = 100;
const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.floor(Number.isFinite(v) ? v : lo)));
/** Western digits → Arabic-Indic, for the small inline counts/titles. */
const toArabic = (n: number): string => String(n).replace(/[0-9]/g, (ch) => '٠١٢٣٤٥٦٧٨٩'[Number(ch)] ?? ch);

interface CampaignContentBuilderProps {
  isAr: boolean;
  contentTypes: MosContentType[];
  drafts: ContentDraft[];
  onChange: (drafts: ContentDraft[]) => void;
}

export default function CampaignContentBuilder({
  isAr, contentTypes, drafts, onChange,
}: CampaignContentBuilderProps): JSX.Element {
  const seq = useRef(0);
  const newKey = (): string => { seq.current += 1; return `d${seq.current}`; };
  const firstType = contentTypes[0]?.key ?? '';

  // The bulk-generate template — a base title + type + count → N rows at once.
  const [tType, setTType] = useState(firstType);
  const [tHeadline, setTHeadline] = useState('');
  const [count, setCount] = useState(4);

  const rowTitle = (base: string, oneBased: number, batch: number): string => {
    const b = base.trim();
    if (b) return batch > 1 ? `${b} ${isAr ? toArabic(oneBased) : oneBased}` : b;
    return isAr ? `منشور ${toArabic(oneBased)}` : `Post ${oneBased}`;
  };
  const generate = (): void => {
    const n = clampInt(count, 1, MAX_BATCH);
    const start = drafts.length;
    const batch: ContentDraft[] = Array.from({ length: n }, (_, i) => ({
      key: newKey(), typeKey: tType || firstType, title: rowTitle(tHeadline, start + i + 1, n), notes: '',
    }));
    onChange([...drafts, ...batch]);
  };

  const add = (): void => onChange([...drafts, { key: newKey(), typeKey: tType || firstType, title: '', notes: '' }]);
  const patch = (key: string, over: Partial<ContentDraft>): void =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...over } : d)));
  const remove = (key: string): void => onChange(drafts.filter((d) => d.key !== key));

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="lbl">{isAr ? 'المحتوى' : 'Content'}</div>
      <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.8 }}>
        {isAr
          ? 'لكل قطعة: النوع، العنوان، وملاحظات. المنصة تأتي من الحملة الإعلانية والمشروع من الحملة — لا تُختار هنا.'
          : 'Per piece: type, title, notes. Platform comes from the ad campaign and project from the campaign — not chosen here.'}
      </div>

      {/* Bulk generate — a base title + type + count populate N editable rows. */}
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', padding: 11, borderRadius: 10,
        border: '1px solid var(--line, rgba(255,255,255,0.10))', background: 'var(--panel, rgba(255,255,255,0.03))',
      }}>
        <label style={{ display: 'grid', gap: 3, flex: 1, minWidth: 160 }}>
          <span className="lbl">{isAr ? 'العنوان المبدئي' : 'Base title'}</span>
          <input className="inp" value={tHeadline} placeholder={isAr ? 'عنوان يُرقَّم تلقائيًا' : 'title, auto-numbered'} onChange={(e) => setTHeadline(e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 3 }}>
          <span className="lbl">{isAr ? 'النوع' : 'Type'}</span>
          <select className="inp" style={{ minWidth: 120 }} value={tType} onChange={(e) => setTType(e.target.value)}>
            {contentTypes.map((t) => (<option key={t.key} value={t.key}>{isAr ? t.label_ar : t.label_en}</option>))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 3 }}>
          <span className="lbl">{isAr ? 'كم قطعة' : 'How many'}</span>
          <input className="inp" style={{ width: 72 }} type="number" min={1} max={MAX_BATCH} value={count} onChange={(e) => setCount(clampInt(Number(e.target.value), 1, MAX_BATCH))} />
        </label>
        <button type="button" className="fbtn on" style={{ height: 38 }} onClick={generate}>
          {isAr ? '+ توليد المحتوى' : '+ Generate content'}
        </button>
      </div>

      {drafts.length === 0 ? (
        <div style={{
          fontSize: 12, color: 'var(--mute)', padding: '10px 12px',
          border: '1px dashed var(--line)', borderRadius: 8,
        }}>
          {isAr ? 'لا محتوى بعد — أضف أول قطعة (اختياري).' : 'No content yet — add the first piece (optional).'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {drafts.map((d) => (
            <div
              key={d.key}
              style={{
                display: 'grid', gap: 8, padding: 10, borderRadius: 10,
                border: '1px solid var(--line, rgba(255,255,255,0.10))',
                background: 'var(--panel, rgba(255,255,255,0.03))',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(120px,1fr) 32px', gap: 8, alignItems: 'end' }}>
                <label style={{ display: 'grid', gap: 3 }}>
                  <span className="lbl">{isAr ? 'النوع' : 'Type'}</span>
                  <select
                    className="inp"
                    value={d.typeKey}
                    onChange={(e) => patch(d.key, { typeKey: e.target.value })}
                  >
                    {contentTypes.map((t) => (
                      <option key={t.key} value={t.key}>{isAr ? t.label_ar : t.label_en}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: 3 }}>
                  <span className="lbl">{isAr ? 'العنوان' : 'Title'}</span>
                  <input
                    className="inp"
                    value={d.title}
                    placeholder={isAr ? 'عنوان المحتوى' : 'Content title'}
                    onChange={(e) => patch(d.key, { title: e.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-d btn-sm"
                  title={isAr ? 'إزالة' : 'Remove'}
                  onClick={() => remove(d.key)}
                >
                  ✕
                </button>
              </div>
              <label style={{ display: 'grid', gap: 3 }}>
                <span className="lbl">{isAr ? 'ملاحظات' : 'Notes'}</span>
                <textarea
                  className="inp"
                  rows={2}
                  value={d.notes}
                  onChange={(e) => patch(d.key, { notes: e.target.value })}
                />
              </label>
            </div>
          ))}
        </div>
      )}

      <div>
        <button type="button" className="fbtn on" onClick={add}>
          {isAr ? '+ إضافة محتوى' : '+ Add content'}
        </button>
      </div>
    </div>
  );
}
