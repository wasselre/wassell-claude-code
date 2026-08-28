/**
 * ContentPicker — choose an ad's creative from the Content list (mos_content
 * records) ONLY.
 *
 * Operator decision 2026-08-28: an ad's creative must be a content record —
 * the Asset-library / upload sources were removed. Linking an ad to a content
 * record is what makes the ad a PAID PLACEMENT of that content (an
 * mos_execution_ads row with content_id — see the Placements tab and the
 * derived `purpose` in mos_content_v), so every pick must go through
 * `content_id`.
 *
 * Legacy: ads created before this change may still carry a library asset in
 * their `creative` jsonb (asset_id / asset_title / …). Such a pick is still
 * RENDERED as the current value so the ad doesn't look empty, but no new
 * asset can be chosen — picking a content record (or "no content") replaces it.
 */
import { MosContentRow } from '@/lib/marketingOS/client';

/** The (legacy) asset reference stored inside an ad's `creative` jsonb. */
export interface PickedAsset {
  id: string;
  title: string;
  url: string | null;
  thumb: string | null;
}

export interface ContentPickerValue {
  contentId: string;
  /** Legacy library asset — display-only; new picks always set this to null. */
  asset: PickedAsset | null;
}

interface ContentPickerProps {
  value: ContentPickerValue;
  /** The content-list options — passed in so the parent fetches them once. */
  contentOptions: MosContentRow[];
  isAr: boolean;
  onChange: (next: ContentPickerValue) => void;
}

export default function ContentPicker({
  value, contentOptions, isAr, onChange,
}: ContentPickerProps): JSX.Element {
  // The <select> value encodes the source: c:<id> = content record,
  // a:<id> = a legacy asset pick (render-only — its option exists only while
  // it IS the current value).
  const selectValue = value.asset ? `a:${value.asset.id}` : value.contentId ? `c:${value.contentId}` : '';

  const onSelect = (v: string): void => {
    if (!v) { onChange({ contentId: '', asset: null }); return; }
    if (v.startsWith('c:')) { onChange({ contentId: v.slice(2), asset: null }); return; }
    // Re-selecting the legacy asset option is a no-op (it's already the value).
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <select className="inp" value={selectValue} onChange={(e) => onSelect(e.target.value)}>
        <option value="">{isAr ? 'بدون محتوى' : 'No content'}</option>
        {contentOptions.map((c) => (
          <option key={c.id} value={`c:${c.id}`}>{c.ref ? `${c.ref} · ${c.title}` : c.title}</option>
        ))}
        {value.asset && (
          <option value={`a:${value.asset.id}`}>
            {(isAr ? 'من المكتبة (قديم) · ' : 'Library (legacy) · ') + value.asset.title}
          </option>
        )}
      </select>

      {value.contentId !== '' && (
        <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
          {isAr
            ? 'عند الحفظ يُسجَّل هذا الإعلان كموضع مدفوع على المحتوى المختار.'
            : 'On save, this ad is recorded as a paid placement on the selected content.'}
        </span>
      )}
    </div>
  );
}
