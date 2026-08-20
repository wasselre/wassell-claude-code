/**
 * ContentPicker — choose an ad's creative from THREE sources in one control:
 *
 *   1. the Content list  (mos_content records — the workflow-produced items)
 *   2. the Asset library (mos_assets — approved/raw material)
 *   3. an upload         (new file → the library, via the shared NewAssetModal)
 *
 * The ad row keeps referencing a content record through `content_id` (a real
 * column); a library/uploaded asset is carried in the ad's `creative` jsonb
 * (asset_id / asset_title / asset_url / asset_thumb) so NO schema change is
 * needed — `creative` is exactly where ad-level creative belongs. Exactly one
 * source is active at a time: picking content clears the asset and vice-versa.
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { MosAsset, MosContentRow, fetchAssets } from '@/lib/marketingOS/client';
import { NewAssetModal } from './MaterialsTab';

/** The asset reference stored inside the ad's `creative` jsonb. */
export interface PickedAsset {
  id: string;
  title: string;
  url: string | null;
  thumb: string | null;
}

export interface ContentPickerValue {
  contentId: string;
  asset: PickedAsset | null;
}

interface ContentPickerProps {
  value: ContentPickerValue;
  /** The content-list options — passed in so the parent fetches them once. */
  contentOptions: MosContentRow[];
  isAr: boolean;
  onChange: (next: ContentPickerValue) => void;
}

const assetOf = (a: MosAsset): PickedAsset => ({
  id: a.id,
  title: a.title || a.ref || a.id,
  url: a.url ?? null,
  thumb: a.thumb_url ?? a.url ?? null,
});

export default function ContentPicker({
  value, contentOptions, isAr, onChange,
}: ContentPickerProps): JSX.Element {
  const addToast = useAppStore((s) => s.addToast);
  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetchAssets({ limit: 300 });
        setAssets(res.assets);
      } catch (e) {
        // Non-fatal: the content list + upload still work without the library.
        console.error('[marketing] asset library unavailable for picker', e);
      }
    })();
  }, []);

  // The <select> value encodes the source: c:<id> = content, a:<id> = asset.
  const selectValue = value.asset ? `a:${value.asset.id}` : value.contentId ? `c:${value.contentId}` : '';

  const onSelect = (v: string): void => {
    if (!v) { onChange({ contentId: '', asset: null }); return; }
    const [kind, id] = [v.slice(0, 1), v.slice(2)];
    if (kind === 'c') { onChange({ contentId: id, asset: null }); return; }
    const a = assets.find((x) => x.id === id);
    if (a) onChange({ contentId: '', asset: assetOf(a) });
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, alignItems: 'center' }}>
        <select className="inp" value={selectValue} onChange={(e) => onSelect(e.target.value)}>
          <option value="">{isAr ? 'بدون محتوى' : 'No content'}</option>
          <optgroup label={isAr ? 'قائمة المحتوى' : 'Content list'}>
            {contentOptions.map((c) => (
              <option key={c.id} value={`c:${c.id}`}>{c.ref ? `${c.ref} · ${c.title}` : c.title}</option>
            ))}
          </optgroup>
          <optgroup label={isAr ? 'المكتبة' : 'Library'}>
            {assets.map((a) => (
              <option key={a.id} value={`a:${a.id}`}>{a.ref ? `${a.ref} · ${a.title}` : a.title}</option>
            ))}
            {/* An asset chosen this session that isn't in the fetched page yet
                (e.g. a fresh upload) still needs to render as the current value. */}
            {value.asset && !assets.some((a) => a.id === value.asset?.id) && (
              <option value={`a:${value.asset.id}`}>{value.asset.title}</option>
            )}
          </optgroup>
        </select>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setUploading(true)}
          title={isAr ? 'رفع ملف جديد إلى المكتبة' : 'Upload a new file to the library'}
        >
          {isAr ? '+ رفع' : '+ Upload'}
        </button>
      </div>

      {/* Thumbnail of a chosen library/uploaded asset — content-list picks have
          no inline thumb here (their preview lives on the content record). */}
      {value.asset?.thumb && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <img
            src={value.asset.thumb}
            alt=""
            style={{ width: 34, height: 34, borderRadius: 6, objectFit: 'cover', border: '1px solid var(--line)' }}
          />
          <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
            {isAr ? 'من المكتبة' : 'from library'} · {value.asset.title}
          </span>
        </div>
      )}

      {uploading && (
        <NewAssetModal
          isAr={isAr}
          projectId={null}
          onClose={() => setUploading(false)}
          onCreated={(created) => {
            setUploading(false);
            const first = created[0];
            if (!first) return;
            setAssets((cur) => [...created, ...cur]);
            onChange({ contentId: '', asset: assetOf(first) });
            addToast(isAr ? 'أُضيف الملف إلى المكتبة واختير.' : 'File added to the library and selected.', 'success');
          }}
        />
      )}
    </div>
  );
}
