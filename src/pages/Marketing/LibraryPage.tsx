/**
 * Asset library — design screens 16, 22 and 41.
 *
 * Material is an object in its own right, not a file bolted to one post. That
 * is what makes "shot in March, used twice, never used" answerable — and screen
 * 41 (unused material) is a LEFT JOIN on the link table rather than a counter
 * anyone maintains.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  ASSET_KIND_LABELS, ASSET_SOURCE_LABELS, MosAsset, MosAssetLink,
  archiveAsset, fetchAssets, fetchContentList, MosContentRow,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, Modal, PageHead, ReadField, Skeleton } from './components/kit';
import { NewAssetModal } from './components/MaterialsTab';
import { IconLibrary, IconPlus, IconSearch, IconTrash } from './components/icons';
import { num, shortDate } from './lib/format';
import { formatBytes } from './lib/upload';

const KIND_BG: Record<string, string> = {
  photo: 'linear-gradient(135deg,#8E6A4F,#B8734F)',
  video: 'linear-gradient(135deg,#4A4E54,#6B4226)',
  design: 'linear-gradient(135deg,#7A5C86,#A6482A)',
  audio: 'linear-gradient(135deg,#3F6B52,#5A6570)',
  document: 'linear-gradient(135deg,#5A6570,#8A7F72)',
};

export default function LibraryPage() {
  const { isAr, can, projectName, projects } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);

  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [links, setLinks] = useState<MosAssetLink[]>([]);
  const [content, setContent] = useState<MosContentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState('');
  const [projectId, setProjectId] = useState('');
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [detail, setDetail] = useState<MosAsset | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [a, c] = await Promise.all([
        fetchAssets({ kind: kind || undefined, project_id: projectId || undefined }),
        fetchContentList({ limit: 500 }),
      ]);
      setAssets(a.assets);
      setLinks(a.links);
      setContent(c.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [kind, projectId]);

  useEffect(() => { void load(); }, [load]);

  const useCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of links) m.set(l.asset_id, (m.get(l.asset_id) ?? 0) + 1);
    return m;
  }, [links]);

  const term = q.trim().toLowerCase();
  const filtered = assets.filter((a) => {
    if (unusedOnly && (useCount.get(a.id) ?? 0) > 0) return false;
    if (term && !a.title.toLowerCase().includes(term) && !(a.ref ?? '').toLowerCase().includes(term)) return false;
    return true;
  });

  const unusedCount = assets.filter((a) => (useCount.get(a.id) ?? 0) === 0).length;

  const remove = async (id: string): Promise<void> => {
    try {
      await archiveAsset(id);
      setAssets((cur) => cur.filter((a) => a.id !== id));
      setDetail(null);
      addToast(isAr ? 'أُرشفت المادة.' : 'Material archived.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <>
      <PageHead
        title={isAr ? 'مكتبة المواد' : 'Asset library'}
        sub={isAr
          ? `${num(assets.length, true)} مادة · ${num(unusedCount, true)} لم تُستخدم بعد`
          : `${assets.length} items · ${unusedCount} never used`}
      >
        <div className="search">
          <IconSearch />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isAr ? 'ابحث بالاسم أو الرقم' : 'Search by name or ref'}
          />
        </div>
        <button type="button" className="btn" onClick={() => navigate('/m/shoots')}>
          {isAr ? 'طلبات التصوير' : 'Shoot requests'}
        </button>
        {can('manage_assets') && (
          <>
            {/* Links are the exception; FILES are the library. Upload is primary. */}
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              {isAr ? 'إضافة رابط' : 'Add a link'}
            </button>
            <button type="button" className="btn btn-p" onClick={() => navigate('/m/library/upload')}>
              <IconPlus />
              {isAr ? 'رفع ملفات' : 'Upload files'}
            </button>
          </>
        )}
      </PageHead>

      <div className="body">
        <div className="filt">
          <button
            type="button"
            className={`fbtn${unusedOnly ? ' on' : ''}`}
            onClick={() => setUnusedOnly((v) => !v)}
          >
            {isAr ? 'لم تُستخدم' : 'Never used'}
            {unusedOnly && <span className="x">×</span>}
          </button>
          <select className="fsel" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{isAr ? 'النوع: الكل' : 'Kind: all'}</option>
            {Object.keys(ASSET_KIND_LABELS).map((k) => (
              <option key={k} value={k}>{isAr ? ASSET_KIND_LABELS[k]?.ar : ASSET_KIND_LABELS[k]?.en}</option>
            ))}
          </select>
          <select className="fsel" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{isAr ? 'المشروع: الكل' : 'Project: all'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
            ))}
          </select>
          <span style={{ marginInlineStart: 'auto', fontSize: 11.5, color: 'var(--mute)' }}>
            {isAr
              ? `${num(filtered.length, true)} من ${num(assets.length, true)}`
              : `${filtered.length} of ${assets.length}`}
          </span>
        </div>

        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && assets.length === 0 && <Skeleton rows={5} />}

        {!loading && filtered.length === 0 && !error && (
          <Empty
            title={assets.length === 0
              ? isAr ? 'المكتبة فارغة' : 'The library is empty'
              : isAr ? 'لا نتائج' : 'Nothing matches'}
            body={assets.length === 0
              ? isAr
                ? 'المادة كائن قائم بذاته، لا ملف ملحق بمنشور واحد. هذا ما يجعل «صُوِّرت في مارس، استُخدمت مرتين» سؤالًا له جواب.'
                : 'Material is an object in its own right, not a file bolted to one post. That is what makes "shot in March, used twice" answerable.'
              : isAr ? 'جرّب تغيير التصفية.' : 'Try changing the filters.'}
          >
            {assets.length === 0 && can('manage_assets') && (
              <button type="button" className="btn btn-p" onClick={() => navigate('/m/library/upload')}>
                <IconPlus />
                {isAr ? 'رفع أول الملفات' : 'Upload the first files'}
              </button>
            )}
          </Empty>
        )}

        {filtered.length > 0 && (
          <div className="agrid">
            {filtered.map((a) => {
              const uses = useCount.get(a.id) ?? 0;
              return (
                <button key={a.id} type="button" className="ass" onClick={() => setDetail(a)}>
                  <div className="im" style={{ background: KIND_BG[a.kind] ?? 'var(--sand)' }}>
                    {a.thumb_url
                      ? <img src={a.thumb_url} alt="" />
                      : (isAr ? ASSET_KIND_LABELS[a.kind]?.ar : ASSET_KIND_LABELS[a.kind]?.en) ?? a.kind}
                    <span className="bd badge">
                      {uses === 0
                        ? isAr ? 'لم تُستخدم' : 'unused'
                        : isAr ? `استُخدمت ${num(uses, true)}` : `used ${uses}×`}
                    </span>
                  </div>
                  <div className="mt2">
                    <b>{a.title}</b>
                    <span className="ltr">{a.ref}</span>
                    {a.shot_on && <> · {shortDate(a.shot_on, isAr)}</>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {adding && (
        <NewAssetModal
          isAr={isAr}
          projectId={projectId || null}
          onClose={() => setAdding(false)}
          onCreated={(asset) => { setAssets((cur) => [asset, ...cur]); setAdding(false); }}
        />
      )}

      {detail && (
        <Modal
          title={detail.title}
          sub={detail.ref ?? undefined}
          onClose={() => setDetail(null)}
          wide
          footer={
            can('manage_assets') ? (
              <>
                <span className="note">
                  {isAr
                    ? 'الأرشفة تُخفي المادة دون كسر سجل ما استُخدم فيها.'
                    : 'Archiving hides the material without breaking the record of what used it.'}
                </span>
                <button type="button" className="btn btn-late" onClick={() => void remove(detail.id)}>
                  <IconTrash />
                  {isAr ? 'أرشفة' : 'Archive'}
                </button>
              </>
            ) : undefined
          }
        >
          {/* The preview knows the medium: video plays, audio plays, an image
              shows, a document opens. A grey block is the last resort. */}
          {detail.kind === 'video' && detail.url ? (
            <video
              src={detail.url}
              controls
              preload="metadata"
              style={{ width: '100%', maxHeight: 320, borderRadius: 10, background: '#000' }}
            />
          ) : detail.kind === 'audio' && detail.url ? (
            <div
              style={{
                borderRadius: 10, background: KIND_BG.audio, padding: '26px 16px',
                display: 'grid', gap: 12, placeItems: 'center',
              }}
            >
              <audio src={detail.url} controls style={{ width: '100%' }} />
            </div>
          ) : (
            <div
              className="im"
              style={{
                height: 180,
                borderRadius: 10,
                background: KIND_BG[detail.kind] ?? 'var(--sand)',
                display: 'grid',
                placeItems: 'center',
                color: '#fff',
                overflow: 'hidden',
              }}
            >
              {detail.thumb_url
                ? <img src={detail.thumb_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <IconLibrary style={{ width: 28, height: 28 }} />}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px' }}>
            <ReadField label={isAr ? 'النوع' : 'Kind'}>
              {(isAr ? ASSET_KIND_LABELS[detail.kind]?.ar : ASSET_KIND_LABELS[detail.kind]?.en) ?? detail.kind}
            </ReadField>
            <ReadField label={isAr ? 'المصدر' : 'Source'}>
              {(isAr ? ASSET_SOURCE_LABELS[detail.source]?.ar : ASSET_SOURCE_LABELS[detail.source]?.en) ?? detail.source}
            </ReadField>
            <ReadField label={isAr ? 'المشروع' : 'Project'}>
              {detail.project_id ? projectName(detail.project_id) : '—'}
            </ReadField>
            <ReadField label={isAr ? 'تاريخ التصوير' : 'Shot on'}>{shortDate(detail.shot_on, isAr)}</ReadField>
            <ReadField label={isAr ? 'الوسوم' : 'Tags'}>
              {detail.tags.length > 0
                ? detail.tags.map((t) => <span key={t} className="tag" style={{ marginInlineEnd: 5 }}>{t}</span>)
                : '—'}
            </ReadField>
            <ReadField label={isAr ? 'الملف' : 'The file'}>
              {detail.size_bytes ? (
                <>
                  <span className="ltr">{detail.original_name ?? ''}</span>
                  {' · '}{formatBytes(detail.size_bytes, isAr)}
                  {detail.url && (
                    <>
                      {' · '}
                      <a href={detail.url} target="_blank" rel="noreferrer">{isAr ? 'فتح' : 'Open'}</a>
                    </>
                  )}
                </>
              ) : detail.url ? (
                <a href={detail.url} target="_blank" rel="noreferrer" className="ltr">
                  {isAr ? 'رابط خارجي — فتح' : 'External link — open'}
                </a>
              ) : '—'}
            </ReadField>
            {detail.usage_rights && (
              <ReadField label={isAr ? 'حقوق الاستخدام' : 'Usage rights'}>{detail.usage_rights}</ReadField>
            )}
          </div>

          <div>
            <div className="lbl" style={{ marginBottom: 8 }}>{isAr ? 'استُخدمت في' : 'Used in'}</div>
            {links.filter((l) => l.asset_id === detail.id).length === 0 ? (
              <div className="drop">
                {isAr
                  ? 'لم تُستخدم بعد. هذه هي القائمة التي تستحق مراجعة شهرية.'
                  : 'Never used. This is the list worth reviewing monthly.'}
              </div>
            ) : (
              links
                .filter((l) => l.asset_id === detail.id)
                .map((l) => {
                  const c = content.find((x) => x.id === l.content_id);
                  return (
                    <button
                      key={l.content_id}
                      type="button"
                      className="file"
                      style={{ width: '100%', textAlign: 'start', cursor: 'pointer' }}
                      onClick={() => navigate(`/m/content/${l.content_id}`)}
                    >
                      <div className="th"><IconLibrary /></div>
                      <div>
                        <div className="nm">{c?.title ?? l.content_id.slice(0, 8)}</div>
                        <div className="mt"><span className="ltr">{c?.ref ?? ''}</span> · {l.role}</div>
                      </div>
                    </button>
                  );
                })
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
