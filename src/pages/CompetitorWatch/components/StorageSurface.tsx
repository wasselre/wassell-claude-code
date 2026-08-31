/** Storage — how much we've scraped, from where, split by kind and company. */
import { fetchStorageUsage, type StorageUsage } from '@/lib/competitorWatch/client';
import { useSurface, num, fmtBytes } from './surfaceData';

const KIND_LABEL: Record<string, { ar: string; en: string; tone: string }> = {
  video: { ar: 'فيديو', en: 'Videos', tone: 'info' },
  image: { ar: 'صور', en: 'Images', tone: 'copper' },
  thumbnail: { ar: 'مصغّرات', en: 'Thumbnails', tone: 'gold' },
};

export default function StorageSurface({ isAr }: { isAr: boolean }) {
  const { data, loading, error } = useSurface<StorageUsage>(fetchStorageUsage);

  if (loading) return <div className="cw-count">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (error) return <div className="cw-error">{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</div>;
  if (!data) return null;

  const kinds = Object.entries(data.by_kind).sort((a, b) => b[1].bytes - a[1].bytes);
  const maxKindBytes = kinds.length ? kinds[0]![1].bytes || 1 : 1;
  const maxOrgBytes = data.by_company.length ? (data.by_company[0]!.bytes || 1) : 1;

  return (
    <div className="cw-surface">
      <div className="cw-tiles">
        <div className="cw-tile">
          <div className="cw-tilek">{isAr ? 'إجمالي الوسائط' : 'Total media'}</div>
          <div className="cw-tilev">{fmtBytes(data.media_bytes)}</div>
          <div className="cw-tilesub cw-mono">{num(data.media_rows)} {isAr ? 'ملف' : 'files'}</div>
        </div>
        <div className="cw-tile">
          <div className="cw-tilek">{isAr ? 'تصاميم مرفوعة' : 'Uploaded creatives'}</div>
          <div className="cw-tilev">{fmtBytes(data.raw_asset_bytes)}</div>
          <div className="cw-tilesub">{isAr ? 'أصول خام' : 'raw ad assets'}</div>
        </div>
        <div className="cw-tile">
          <div className="cw-tilek">{isAr ? 'المخازن' : 'Buckets'}</div>
          <div className="cw-tilev">2</div>
          <div className="cw-tilesub cw-mono">marketing-assets · wassel-files</div>
        </div>
      </div>

      <div className="cw-grid2">
        <div className="cw-panel">
          <div className="cw-panelh"><h3>{isAr ? 'حسب نوع الوسيط' : 'By media type'}</h3></div>
          <div className="cw-panelb">
            {kinds.map(([kind, v]) => {
              const meta = KIND_LABEL[kind] ?? { ar: kind, en: kind, tone: 'copper' };
              return (
                <div className="cw-meter" key={kind}>
                  <span className="cw-meterlbl">{isAr ? meta.ar : meta.en}</span>
                  <span className="cw-track"><span className={`cw-fill ${meta.tone}`} style={{ width: `${Math.max(2, Math.round((v.bytes / maxKindBytes) * 100))}%` }} /></span>
                  <span className="cw-meterval cw-mono">{fmtBytes(v.bytes)} · {num(v.count)}</span>
                </div>
              );
            })}
            <p className="cw-note">{isAr ? 'الفيديو قِلّة من الملفات لكنه معظم الحجم — الجزء الثقيل في الفاتورة.' : 'Videos are few in count but the bulk of the size — the heavy part of the bill.'}</p>
          </div>
        </div>

        <div className="cw-panel">
          <div className="cw-panelh"><h3>{isAr ? 'أكثر الشركات تخزينًا' : 'Top companies by storage'}</h3></div>
          <div className="cw-panelb">
            {data.by_company.slice(0, 8).map((cco, i) => (
              <div className="cw-meter" key={i}>
                <span className="cw-meterlbl" dir="rtl">{cco.org ?? '—'}</span>
                <span className="cw-track"><span className="cw-fill copper" style={{ width: `${Math.max(2, Math.round((cco.bytes / maxOrgBytes) * 100))}%` }} /></span>
                <span className="cw-meterval cw-mono">{fmtBytes(cco.bytes)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
