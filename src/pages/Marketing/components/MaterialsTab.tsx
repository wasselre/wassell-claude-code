/**
 * Material and files — design screen 09.
 *
 * The assets attached to this item, split by the part they play: source
 * material that went in, the final export that came out, and references.
 * Linking is a row in a join table, which is why "unused assets" (screen 41)
 * can be a fact rather than a counter somebody maintains.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  ASSET_KIND_LABELS, ASSET_SOURCE_LABELS, MosAsset, MosAssetLink,
  fetchAssets, linkAsset, saveAsset, unlinkAsset,
} from '@/lib/marketingOS/client';
import { Empty, Field, LoadError, Modal, Skeleton } from './kit';
import { IconLibrary, IconPlus, IconTrash } from './icons';
import { shortDate } from '../lib/format';

const ROLES = ['source', 'final', 'reference'] as const;
const ROLE_LABELS: Record<string, { ar: string; en: string }> = {
  source:    { ar: 'مادة خام',  en: 'Source' },
  final:     { ar: 'النسخة النهائية', en: 'Final' },
  reference: { ar: 'مرجع',      en: 'Reference' },
};

export default function MaterialsTab({
  contentId, projectId, canEdit, isAr, onCount,
}: {
  contentId: string;
  projectId: string | null;
  canEdit: boolean;
  isAr: boolean;
  onCount: (n: number) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [links, setLinks] = useState<MosAssetLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAssets();
      setAssets(res.assets);
      setLinks(res.links);
      onCount(res.links.filter((l) => l.content_id === contentId).length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [contentId, onCount]);

  useEffect(() => { void load(); }, [load]);

  const mine = links.filter((l) => l.content_id === contentId);
  const assetById = new Map(assets.map((a) => [a.id, a]));

  const unlink = async (assetId: string): Promise<void> => {
    setBusy(true);
    try {
      const res = await unlinkAsset(assetId, contentId);
      setLinks((cur) => [...cur.filter((l) => l.content_id !== contentId), ...res.links]);
      onCount(res.links.length);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const link = async (assetId: string, role: string): Promise<void> => {
    setBusy(true);
    try {
      const res = await linkAsset(assetId, contentId, role);
      setLinks((cur) => [...cur.filter((l) => l.content_id !== contentId), ...res.links]);
      onCount(res.links.length);
      setPicking(false);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading && assets.length === 0) return <Skeleton rows={4} />;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}

      {ROLES.map((role) => {
        const rows = mine.filter((l) => l.role === role);
        if (rows.length === 0 && role !== 'source') return null;
        return (
          <div key={role}>
            <div className="lbl" style={{ marginBottom: 8 }}>
              {isAr ? ROLE_LABELS[role]?.ar : ROLE_LABELS[role]?.en}
            </div>
            {rows.length === 0 ? (
              <div className="drop">
                {isAr
                  ? 'لا مواد مرتبطة بعد. اربط من المكتبة أو أضف رابطًا.'
                  : 'Nothing linked yet. Link from the library or add a link.'}
              </div>
            ) : (
              rows.map((l) => {
                const a = assetById.get(l.asset_id);
                if (!a) return null;
                return (
                  <div key={l.asset_id} className="file">
                    <div className="th">
                      {a.thumb_url
                        ? <img src={a.thumb_url} alt="" />
                        : <IconLibrary />}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="nm">{a.title}</div>
                      <div className="mt">
                        <span className="ltr">{a.ref}</span> ·{' '}
                        {(isAr ? ASSET_KIND_LABELS[a.kind]?.ar : ASSET_KIND_LABELS[a.kind]?.en) ?? a.kind}
                        {' · '}
                        {(isAr ? ASSET_SOURCE_LABELS[a.source]?.ar : ASSET_SOURCE_LABELS[a.source]?.en) ?? a.source}
                        {a.shot_on && <> · {shortDate(a.shot_on, isAr)}</>}
                      </div>
                    </div>
                    <div className="rt">
                      {a.url && (
                        <a className="btn btn-sm" href={a.url} target="_blank" rel="noreferrer">
                          {isAr ? 'فتح' : 'Open'}
                        </a>
                      )}
                      {canEdit && (
                        <button
                          type="button"
                          className="btn btn-d btn-sm"
                          disabled={busy}
                          onClick={() => void unlink(a.id)}
                          aria-label={isAr ? 'إلغاء الربط' : 'Unlink'}
                        >
                          <IconTrash />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        );
      })}

      {canEdit && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={() => setPicking(true)}>
            <IconLibrary />
            {isAr ? 'ربط من المكتبة' : 'Link from library'}
          </button>
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <IconPlus />
            {isAr ? 'إضافة مادة جديدة' : 'Add new material'}
          </button>
        </div>
      )}

      {picking && (
        <Modal
          title={isAr ? 'ربط من المكتبة' : 'Link from the library'}
          sub={isAr ? 'اختر المادة ثم الدور الذي تلعبه في هذا العنصر.' : 'Pick the material, then the part it plays here.'}
          onClose={() => setPicking(false)}
          wide
        >
          {assets.length === 0 ? (
            <Empty
              title={isAr ? 'المكتبة فارغة' : 'The library is empty'}
              body={isAr ? 'أضف أول مادة من مكتبة المواد.' : 'Add the first material from the asset library.'}
            />
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  {assets
                    .filter((a) => !mine.some((l) => l.asset_id === a.id))
                    .map((a) => (
                      <tr key={a.id}>
                        <td className="id">{a.ref}</td>
                        <td className="ttl">{a.title}</td>
                        <td>
                          <span className="tag">
                            {(isAr ? ASSET_KIND_LABELS[a.kind]?.ar : ASSET_KIND_LABELS[a.kind]?.en) ?? a.kind}
                          </span>
                        </td>
                        <td style={{ width: 260 }}>
                          <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                            {ROLES.map((r) => (
                              <button
                                key={r}
                                type="button"
                                className="btn btn-sm"
                                disabled={busy}
                                onClick={() => void link(a.id, r)}
                              >
                                {isAr ? ROLE_LABELS[r]?.ar : ROLE_LABELS[r]?.en}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {adding && (
        <NewAssetModal
          isAr={isAr}
          projectId={projectId}
          onClose={() => setAdding(false)}
          onCreated={async (asset) => {
            setAssets((cur) => [asset, ...cur]);
            setAdding(false);
            await link(asset.id, 'source');
          }}
        />
      )}
    </div>
  );
}

/** Screen 23 — upload and intake. Link-first, because the bytes usually already
 *  live somewhere (Drive, the shoot folder) and copying them twice helps nobody. */
export function NewAssetModal({
  isAr, projectId, onClose, onCreated,
}: {
  isAr: boolean;
  projectId: string | null;
  onClose: () => void;
  onCreated: (asset: MosAsset) => void | Promise<void>;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<MosAsset['kind']>('photo');
  const [source, setSource] = useState<MosAsset['source']>('shoot');
  const [url, setUrl] = useState('');
  const [shotOn, setShotOn] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      addToast(isAr ? 'اكتب اسمًا للمادة.' : 'Give the material a name.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await saveAsset({
        title: title.trim(),
        kind,
        source,
        project_id: projectId,
        url: url.trim() || null,
        thumb_url: url.trim() || null,
        shot_on: shotOn || null,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      await onCreated(res.asset);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'مادة جديدة' : 'New material'}
      sub={isAr
        ? 'الرابط يكفي — لا داعي لنسخ الملف مرتين. الوسوم هي ما يجعل المادة قابلة لإعادة الاستخدام لاحقًا.'
        : 'A link is enough — no need to copy the file twice. The tags are what make it findable for reuse later.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'إضافة' : 'Add'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'الاسم' : 'Name'}>
        <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'النوع' : 'Kind'}>
          <select className="inp" value={kind} onChange={(e) => setKind(e.target.value as MosAsset['kind'])}>
            {Object.keys(ASSET_KIND_LABELS).map((k) => (
              <option key={k} value={k}>{isAr ? ASSET_KIND_LABELS[k]?.ar : ASSET_KIND_LABELS[k]?.en}</option>
            ))}
          </select>
        </Field>
        <Field label={isAr ? 'المصدر' : 'Source'}>
          <select className="inp" value={source} onChange={(e) => setSource(e.target.value as MosAsset['source'])}>
            {Object.keys(ASSET_SOURCE_LABELS).map((k) => (
              <option key={k} value={k}>{isAr ? ASSET_SOURCE_LABELS[k]?.ar : ASSET_SOURCE_LABELS[k]?.en}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={isAr ? 'الرابط' : 'Link'} hint={isAr ? 'درايف أو أي مكان' : 'Drive or anywhere'}>
        <input className="inp" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'تاريخ التصوير' : 'Shot on'}>
          <input type="date" className="inp" value={shotOn} onChange={(e) => setShotOn(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الوسوم' : 'Tags'} hint={isAr ? 'مفصولة بفاصلة' : 'comma separated'}>
          <input className="inp" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
