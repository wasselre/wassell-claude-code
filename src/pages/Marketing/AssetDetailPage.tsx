/**
 * Asset detail — design screen 22 (/m/library/:assetId).
 *
 * One asset, and everything about it. The usage list is the point — this clip
 * may be inside four records, one of them a paid ad still spending. That is why
 * deleting an asset can never be a silent act, and why a crop produces a
 * VERSION instead of replacing the original.
 *
 * «الحذف ممنوع لا محذَّر منه»: an asset that is in use cannot be removed — the
 * button explains itself instead of firing a confirm dialog nobody reads. The
 * server is the authority: asset_delete answers 409 { error: 'in_use' } and
 * this screen renders that answer, offering أرشفة as the working alternative.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  ASSET_ASPECT_RATIOS, ASSET_KIND_LABELS, ASSET_SOURCE_LABELS, MosApiError, MosAsset,
  MosAssetUsage, archiveAsset, bulkAssets, deleteAsset, fetchAssetDetail, saveAsset,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, ReadField, Skeleton } from './components/kit';
import { IconLibrary, IconPlus } from './components/icons';
import { daysFromNow, num, shortDate, toArabicDigits } from './lib/format';
import { formatBytes } from './lib/upload';
import './styles/pages-remaining.css';

/**
 * iOS Safari/WebKit renders a PDF inside an `<iframe>` as a non-scrollable,
 * first-page-only frame — the file looks cut off and you can't reach the rest
 * (long-standing WebKit limitation, no CSS fixes it). On iOS we skip the iframe
 * and hand the file to the native PDF viewer (a new tab), which scrolls the
 * whole document. iPadOS 13+ masquerades as desktop Safari, so also match a
 * touch-capable "Mac".
 */
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

/** mm:ss with the screen's digit shape — Arabic-Indic in Arabic («٠٠:٢٢»). */
function mmss(seconds: number, isAr: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  const out = `${mm}:${ss}`;
  return isAr ? toArabicDigits(out) : out;
}

/** «بعد ١١ شهرًا» — the rights-expiry countdown chip. */
function expiryCountdown(iso: string, isAr: boolean): string {
  const days = daysFromNow(iso);
  if (days === null) return '';
  if (days < 0) return isAr ? 'انتهت' : 'expired';
  if (days < 31) return isAr ? `بعد ${num(days, true)} يومًا` : `in ${days} days`;
  const months = Math.round(days / 30.4);
  return isAr ? `بعد ${num(months, true)} ${months <= 10 ? 'أشهر' : 'شهرًا'}` : `in ${months} months`;
}

/** The aspect-ratio label («9:16 — عمودي») for a stored value; bare value if custom. */
function aspectLabel(value: string, isAr: boolean): string {
  const hit = ASSET_ASPECT_RATIOS.find((r) => r.value === value);
  return hit ? (isAr ? hit.ar : hit.en) : value;
}

/**
 * The public storage URL with `?download=<name>` — Supabase serves it as an
 * attachment (Content-Disposition), so «تنزيل» actually saves the file instead
 * of opening it inline (the plain `download` attribute is ignored cross-origin).
 */
function downloadHref(asset: MosAsset): string | null {
  if (!asset.url) return null;
  const name = asset.original_name || asset.title || 'file';
  const sep = asset.url.includes('?') ? '&' : '?';
  return `${asset.url}${sep}download=${encodeURIComponent(name)}`;
}

const LINK_ROLE_LABELS: Record<string, { ar: string; en: string }> = {
  source:    { ar: 'مصدر',  en: 'Source' },
  final:     { ar: 'نهائي', en: 'Final' },
  reference: { ar: 'مرجع',  en: 'Reference' },
};

export default function AssetDetailPage() {
  const { assetId } = useParams<{ assetId: string }>();
  const { isAr, can, projectName, projects, contentTypes } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);

  const [asset, setAsset] = useState<MosAsset | null>(null);
  const [usedIn, setUsedIn] = useState<MosAssetUsage[]>([]);
  const [versions, setVersions] = useState<Array<{ id: string; title: string; created_at: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The server's 409 explanation, shown in the تحذير card after a blocked delete. */
  const [blocked, setBlocked] = useState<MosAssetUsage[] | null>(null);
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!assetId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAssetDetail(assetId);
      setAsset(res.asset);
      setUsedIn(res.used_in);
      setVersions(res.versions);
      setBlocked(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  useEffect(() => { void load(); }, [load]);

  const liveAds = useMemo(() => usedIn.filter((u) => u.live_ad), [usedIn]);
  const inUse = usedIn.length > 0;

  const kindLabel = asset
    ? (isAr ? ASSET_KIND_LABELS[asset.kind]?.ar : ASSET_KIND_LABELS[asset.kind]?.en) ?? asset.kind
    : '';
  const sourceLabel = asset
    ? (isAr ? ASSET_SOURCE_LABELS[asset.source]?.ar : ASSET_SOURCE_LABELS[asset.source]?.en) ?? asset.source
    : '';

  /** The spec caption — only what is actually known: duration · size. */
  const spec = useMemo(() => {
    if (!asset) return '';
    const parts: string[] = [];
    if (asset.aspect_ratio) parts.push(asset.aspect_ratio);
    if (asset.duration_seconds != null && asset.duration_seconds > 0) parts.push(mmss(asset.duration_seconds, false));
    if (asset.size_bytes != null && asset.size_bytes > 0) parts.push(formatBytes(asset.size_bytes, false));
    return parts.join(' · ');
  }, [asset]);

  /** A PDF (public marketing-assets URL) can be shown inline instead of a
   *  placeholder icon. Only PDFs — other documents (docx/xlsx) don't render in
   *  an iframe, so they keep the placeholder + Download. */
  const isPdf = useMemo(() => {
    if (!asset || asset.kind !== 'document' || !asset.url) return false;
    return asset.mime_type === 'application/pdf'
      || /\.pdf(\?|#|$)/i.test(asset.url)
      || /\.pdf$/i.test(asset.original_name ?? '');
  }, [asset]);

  const archive = async (): Promise<void> => {
    if (!asset) return;
    setBusy(true);
    try {
      await archiveAsset(asset.id, true);
      addToast(
        isAr
          ? 'أُرشفت — خرجت من البحث والمكتبة وتبقى قابلة للاسترجاع.'
          : 'Archived — out of search and the library, always recoverable.',
        'success',
      );
      navigate('/m/library');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Delete is attempted, never pre-judged: the server is the authority on
   * in-use. A 409 in_use renders the blocked explanation in the تحذير card.
   */
  const remove = async (): Promise<void> => {
    if (!asset) return;
    setBusy(true);
    try {
      await deleteAsset(asset.id);
      addToast(isAr ? 'حُذفت المادة.' : 'Asset deleted.', 'success');
      navigate('/m/library');
    } catch (e) {
      if (e instanceof MosApiError && e.status === 409 && e.payload.error === 'in_use') {
        const list = Array.isArray(e.payload.used_in) ? (e.payload.used_in as MosAssetUsage[]) : usedIn;
        setBlocked(list);
        addToast(
          isAr
            ? 'الحذف ممنوع — المادة مستخدمة. الأرشفة هي البديل.'
            : 'Delete is blocked — the asset is in use. Archiving is the alternative.',
          'error',
        );
      } else {
        addToast(e instanceof Error ? e.message : String(e), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const addTag = async (): Promise<void> => {
    const t = tagDraft.trim();
    if (!asset || !t) { setAddingTag(false); setTagDraft(''); return; }
    setBusy(true);
    try {
      const res = await saveAsset({ id: asset.id, tags: [...asset.tags.filter((x) => x !== t), t] });
      setAsset(res.asset);
      setAddingTag(false);
      setTagDraft('');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!assetId) return null;

  return (
    <>
      <PageHead
        title={asset?.title ?? (isAr ? 'تفاصيل المادة' : 'Asset detail')}
        crumb={
          <>
            <button type="button" onClick={() => navigate('/m/library')}>
              {isAr ? 'مكتبة المواد' : 'Asset library'}
            </button>
            {asset?.project_id && (
              <>
                <span className="sep">/</span>
                <span>{projectName(asset.project_id)}</span>
              </>
            )}
            <span className="sep">/</span>
            <span>{kindLabel || (isAr ? 'مادة' : 'Asset')}</span>
          </>
        }
        sub={asset && (
          <span className="chips">
            <span className="tag">{kindLabel} · {sourceLabel}</span>
            {spec && <span className="tag ltr">{spec}</span>}
            {asset.project_id && <span className="tag">{projectName(asset.project_id)}</span>}
            {inUse ? (
              <Pill tone="go">{isAr ? `مستخدم في ${num(usedIn.length, true)}` : `Used in ${usedIn.length}`}</Pill>
            ) : (
              <span className="tag">{isAr ? 'غير مستخدمة' : 'Unused'}</span>
            )}
          </span>
        )}
      >
        {asset?.url && (
          <a className="btn" href={asset.url} target="_blank" rel="noreferrer">
            {isAr ? 'فتح الملف' : 'Open file'}
          </a>
        )}
        {asset && downloadHref(asset) && (
          <a className="btn btn-d" href={downloadHref(asset) ?? undefined}>
            {isAr ? 'تنزيل' : 'Download'}
          </a>
        )}
        {can('manage_assets') && asset && (
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            {isAr ? 'تعديل' : 'Edit'}
          </button>
        )}
        {can('manage_assets') && (
          <button type="button" className="btn" onClick={() => navigate('/m/library/upload')}>
            {isAr ? 'نسخة جديدة' : 'New version'}
          </button>
        )}
        {can('write_content') && (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            {isAr ? 'استخدام في محتوى' : 'Use in content'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && !asset && <Skeleton rows={6} />}

        {!loading && !asset && !error && (
          <Empty
            title={isAr ? 'المادة غير موجودة' : 'Asset not found'}
            body={isAr ? 'ربما حُذفت أو أُرشفت.' : 'It may have been deleted or archived.'}
          />
        )}

        {asset && (
          <div className="grid rail-end">
            {/* ── main column ─────────────────────────────────────────── */}
            <div style={{ display: 'grid', gap: 16 }}>
              {isPdf && asset.url && IS_IOS ? (
                // iOS can't scroll a PDF <iframe> (first page only). Hand the
                // whole file to the native viewer — a big tappable card so the
                // user can actually read past page one.
                <a
                  href={asset.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'grid',
                    justifyItems: 'center',
                    alignContent: 'center',
                    gap: 12,
                    width: '100%',
                    minHeight: 320,
                    padding: 28,
                    textAlign: 'center',
                    border: '1px solid var(--line)',
                    borderRadius: 11,
                    background: '#fff',
                    color: 'var(--ink)',
                    textDecoration: 'none',
                  }}
                >
                  <span
                    style={{
                      display: 'grid',
                      placeItems: 'center',
                      width: 56,
                      height: 56,
                      borderRadius: 14,
                      background: 'var(--copper, #B8734F)',
                    }}
                  >
                    <IconLibrary style={{ width: 24, height: 24, stroke: '#fff' }} />
                  </span>
                  <span style={{ fontWeight: 700, fontSize: 16 }}>
                    {isAr ? 'افتح الملف كاملاً' : 'Open the full file'}
                  </span>
                  <span style={{ fontSize: 13, opacity: 0.7, maxWidth: 280 }}>
                    {isAr
                      ? 'يفتح ملف PDF كامل في عارض النظام حيث يمكنك التمرير والتنزيل.'
                      : 'Opens the full PDF in the system viewer, where you can scroll and download.'}
                  </span>
                </a>
              ) : isPdf && asset.url ? (
                // A PDF renders inline in its own full-width viewer, not the
                // dark thumbnail box — the placeholder icon was never the file.
                <div style={{ display: 'grid', gap: 8 }}>
                  <iframe
                    src={`${asset.url}#view=FitH`}
                    title={asset.title}
                    style={{
                      width: '100%',
                      height: '78vh',
                      minHeight: 480,
                      border: '1px solid var(--line)',
                      borderRadius: 11,
                      background: '#fff',
                      display: 'block',
                    }}
                  />
                  <a
                    className="btn btn-d btn-sm"
                    href={asset.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ justifySelf: 'start' }}
                  >
                    {isAr ? 'فتح في تبويب جديد' : 'Open in a new tab'}
                  </a>
                </div>
              ) : (
                <div className="pr-preview">
                  {asset.kind === 'video' && asset.url ? (
                    <video src={asset.url} controls preload="metadata" />
                  ) : asset.kind === 'audio' && asset.url ? (
                    <audio src={asset.url} controls preload="metadata" />
                  ) : (asset.kind === 'photo' || asset.kind === 'design') && (asset.url || asset.thumb_url) ? (
                    // Click the image to open the full file in a new tab.
                    <a
                      href={asset.url ?? asset.thumb_url ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      title={isAr ? 'فتح الملف' : 'Open file'}
                    >
                      <img src={asset.url ?? asset.thumb_url ?? undefined} alt={asset.title} style={{ cursor: 'zoom-in' }} />
                    </a>
                  ) : asset.url ? (
                    // Documents (non-PDF) and anything without an inline preview:
                    // the tile itself opens the actual file.
                    <a
                      className="pr-play"
                      href={asset.url}
                      target="_blank"
                      rel="noreferrer"
                      title={isAr ? 'فتح الملف' : 'Open file'}
                      style={{ cursor: 'pointer', textDecoration: 'none' }}
                    >
                      <IconLibrary style={{ width: 17, height: 17, stroke: '#fff' }} />
                    </a>
                  ) : (
                    <div className="pr-play" aria-hidden="true">
                      {asset.kind === 'video'
                        ? <svg viewBox="0 0 24 24"><path d="M18 4L4 12l14 8z" /></svg>
                        : <IconLibrary style={{ width: 17, height: 17, stroke: '#fff' }} />}
                    </div>
                  )}
                  {spec && <span className="pr-spec">{spec}</span>}
                </div>
              )}

              {/* «مستخدم في» — the list that makes delete a non-silent act. */}
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'مستخدم في' : 'Used in'}</h4>
                  <span className="r">
                    {usedIn.length === 0
                      ? isAr ? 'لا شيء بعد' : 'nothing yet'
                      : liveAds.length > 0
                        ? isAr
                          ? `${num(usedIn.length, true)} سجلات · واحد ينفق الآن`
                          : `${usedIn.length} records · one is spending now`
                        : isAr
                          ? `${num(usedIn.length, true)} سجلات`
                          : `${usedIn.length} records`}
                  </span>
                </div>
                {usedIn.length === 0 ? (
                  <div className="card-b" style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.8 }}>
                    {isAr
                      ? 'لم يُشر إليها أي محتوى قط — تظهر ضمن «غير المستخدمة».'
                      : 'No content has ever referenced it — it appears under “Unused”.'}
                  </div>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <tbody>
                        {usedIn.map((u) => (
                          <tr key={u.content_id} className="click" onClick={() => navigate(`/m/content/${u.content_id}`)}>
                            <td style={{ width: 58 }} className="id">{u.ref ?? '—'}</td>
                            <td className="ttl">{u.title}</td>
                            <td style={{ width: 110 }}>
                              <span className="tag">
                                {(isAr ? LINK_ROLE_LABELS[u.role]?.ar : LINK_ROLE_LABELS[u.role]?.en) ?? u.role}
                              </span>
                            </td>
                            <td style={{ width: 180, fontSize: 11.5, color: 'var(--copper)', fontWeight: 700 }}>
                              {u.live_ad ? (isAr ? 'يعمل كإعلان مدفوع الآن' : 'Running as a paid ad now') : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* «النسخ» — the original is never edited; crops become versions. */}
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'النسخ' : 'Versions'}</h4>
                  <span className="r">{isAr ? 'الأصل لا يُعدَّل أبدًا' : 'the original is never edited'}</span>
                  {can('manage_assets') && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ marginInlineStart: 10 }}
                      onClick={() => navigate('/m/library/upload')}
                    >
                      {isAr ? 'إضافة نسخة' : 'Add a version'}
                    </button>
                  )}
                </div>
                <div className="card-b">
                  {versions.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.8 }}>
                      {isAr
                        ? 'لا نسخ بعد — القصّ أو إعادة القياس يُنتج نسخة هنا بدل استبدال الأصل.'
                        : 'No versions yet — a crop or resize lands here instead of replacing the original.'}
                    </div>
                  ) : (
                    versions.map((v, i) => (
                      <button
                        key={v.id}
                        type="button"
                        className="file"
                        style={{
                          width: '100%',
                          textAlign: 'start',
                          cursor: v.id === asset.id ? 'default' : 'pointer',
                          borderColor: v.id === asset.id ? 'var(--copper)' : undefined,
                          marginBottom: i === versions.length - 1 ? 0 : undefined,
                        }}
                        onClick={() => { if (v.id !== asset.id) navigate(`/m/library/${v.id}`); }}
                      >
                        <div className="th" style={{ background: 'linear-gradient(135deg,#3A2A1E,#B8734F)' }}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="#fff"><path d="M15 10l5-3v10l-5-3M3 7h12v10H3z" /></svg>
                        </div>
                        <div>
                          <div className="nm">{v.title}</div>
                          <div className="mt">{shortDate(v.created_at, isAr)}</div>
                        </div>
                        <div className="rt">
                          <span className="ver">{i === 0 ? (isAr ? 'الأصل' : 'Original') : `v${num(i + 1, false)}`}</span>
                          {i === 0 && <Pill tone="go">{isAr ? 'النسخة الرئيسية' : 'Master copy'}</Pill>}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* ── rail ────────────────────────────────────────────────── */}
            <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'التفاصيل' : 'Details'}</h4></div>
                <div className="card-b">
                  <ReadField label={isAr ? 'المشروع' : 'Project'}>
                    {asset.project_id ? projectName(asset.project_id) : '—'}
                  </ReadField>
                  {asset.shoot_request_id && (
                    <ReadField label={isAr ? 'التصوير' : 'The shoot'}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ color: 'var(--copper)', borderColor: 'transparent', padding: 0 }}
                        onClick={() => navigate(`/m/shoots/${asset.shoot_request_id}`)}
                      >
                        {isAr ? 'فتح طلب التصوير' : 'Open the shoot request'}
                      </button>
                    </ReadField>
                  )}
                  <ReadField label={isAr ? 'المقاس' : 'Aspect ratio'}>
                    {asset.aspect_ratio
                      ? <span className="ltr">{aspectLabel(asset.aspect_ratio, isAr)}</span>
                      : '—'}
                  </ReadField>
                  <ReadField label={isAr ? 'صوّرها' : 'Shot by'}>{asset.shot_by ?? '—'}</ReadField>
                  {asset.shot_on && (
                    <ReadField label={isAr ? 'صُوِّرت' : 'Shot on'}>{shortDate(asset.shot_on, isAr)}</ReadField>
                  )}
                  <ReadField label={isAr ? 'أُضيفت' : 'Added'}>{shortDate(asset.created_at, isAr)}</ReadField>
                  <ReadField label={isAr ? 'الوسوم' : 'Tags'}>
                    <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                      {asset.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                      {can('manage_assets') && !addingTag && (
                        <button type="button" className="tag tag-t" style={{ cursor: 'pointer' }} onClick={() => setAddingTag(true)}>
                          {isAr ? '+ إضافة' : '+ Add'}
                        </button>
                      )}
                      {addingTag && (
                        <input
                          className="inp"
                          style={{ padding: '3px 8px', fontSize: 11.5, width: 110 }}
                          value={tagDraft}
                          autoFocus
                          disabled={busy}
                          onChange={(e) => setTagDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void addTag(); if (e.key === 'Escape') { setAddingTag(false); setTagDraft(''); } }}
                          onBlur={() => void addTag()}
                        />
                      )}
                    </span>
                  </ReadField>
                </div>
              </div>

              {/* حقوق الاستخدام — the field a real-estate marketing team
                  actually needs, and a folder tree never had. */}
              <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--wait) 40%, transparent)' }}>
                <div className="card-h" style={{ background: 'color-mix(in srgb, var(--wait) 8%, transparent)' }}>
                  <h4>{isAr ? 'حقوق الاستخدام' : 'Usage rights'}</h4>
                  {asset.rights_expiry && (
                    <span style={{ marginInlineStart: 'auto' }}>
                      <Pill tone="wait">{isAr ? 'تنتهي' : 'Expires'}</Pill>
                    </span>
                  )}
                </div>
                <div className="card-b">
                  <ReadField label={isAr ? 'الترخيص' : 'Licence'}>{asset.usage_rights ?? '—'}</ReadField>
                  {asset.rights_expiry && (
                    <ReadField label={isAr ? 'تنتهي' : 'Expires'}>
                      <span style={{ color: 'var(--wait)', fontWeight: 700 }}>
                        {shortDate(asset.rights_expiry, isAr)} · {expiryCountdown(asset.rights_expiry, isAr)}
                      </span>
                    </ReadField>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 9, lineHeight: 1.75 }}>
                    {isAr
                      ? 'التصاميم الواردة من المطورين تحمل غالبًا قيودًا أضيق من التصوير المُكلَّف. الحقل موجود حتى لا يضطر أحد لتذكّر أيها أي.'
                      : 'Designs supplied by developers usually carry tighter restrictions than commissioned shoots. The field exists so nobody has to remember which is which.'}
                  </div>
                </div>
              </div>

              {/* تحذير — delete is forbidden, not warned about. */}
              {can('manage_assets') && (
                <div className="card">
                  <div className="card-h"><h4>{isAr ? 'تحذير' : 'Warning'}</h4></div>
                  <div className="card-b" style={{ fontSize: 12, lineHeight: 1.85, color: 'var(--ink-2)' }}>
                    {inUse
                      ? isAr
                        ? <>
                          {liveAds.length > 0
                            ? 'هذه المادة تعمل الآن داخل إعلان مدفوع. '
                            : ''}
                          حذفها سيكسر {(blocked ?? usedIn).slice(0, 3).map((u, i) => (
                            <b key={u.content_id} className="ltr">{i > 0 ? ' · ' : ''}{u.ref ?? u.title}</b>
                          ))}
                          {usedIn.length > 3 ? ` و${num(usedIn.length - 3, true)} غيرها` : ''}
                          {liveAds.length > 0 ? '، والإعلان العامل الآن.' : '.'}
                        </>
                        : <>
                          {liveAds.length > 0 ? 'This asset is inside a paid ad right now. ' : ''}
                          Deleting it would break {(blocked ?? usedIn).slice(0, 3).map((u) => u.ref ?? u.title).join(' · ')}
                          {usedIn.length > 3 ? ` and ${usedIn.length - 3} more` : ''}
                          {liveAds.length > 0 ? ', and the ad that is running.' : '.'}
                        </>
                      : isAr
                        ? 'المادة غير مستخدمة — يمكن أرشفتها، والحذف متاح فقط لمواد لم تُستخدم قط ومضى عليها عام.'
                        : 'The asset is unused — it can be archived; real delete is reserved for assets never used and a full year old.'}
                    <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void archive()}>
                        {isAr ? 'أرشفة' : 'Archive'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={inUse ? { color: 'var(--mute)', borderStyle: 'dashed' } : undefined}
                        disabled={busy}
                        onClick={() => void remove()}
                      >
                        {inUse
                          ? isAr ? 'حذف · ممنوع' : 'Delete · blocked'
                          : isAr ? 'حذف' : 'Delete'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {creating && asset && (
        <UseInContentModal
          isAr={isAr}
          asset={asset}
          contentTypes={contentTypes.filter((t) => t.is_active)}
          onClose={() => setCreating(false)}
          onCreated={(contentId) => navigate(`/m/content/${contentId}`)}
        />
      )}

      {editing && asset && (
        <EditAssetModal
          isAr={isAr}
          asset={asset}
          projects={projects}
          onClose={() => setEditing(false)}
          onSaved={(next) => { setAsset(next); setEditing(false); }}
        />
      )}
    </>
  );
}

/**
 * «تعديل المادة» — edit the asset record itself (screen 22). Kind and the file
 * bytes are fixed at upload; everything a human curates after — title, project,
 * source, the chosen aspect ratio, shot-by/on, and usage rights — is editable
 * here through the same asset_save path the upload screen writes with.
 */
function EditAssetModal({
  isAr, asset, projects, onClose, onSaved,
}: {
  isAr: boolean;
  asset: MosAsset;
  projects: Array<{ id: string; project_name?: string | null }>;
  onClose: () => void;
  onSaved: (asset: MosAsset) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [title, setTitle] = useState(asset.title);
  const [projectId, setProjectId] = useState(asset.project_id ?? '');
  const [source, setSource] = useState<MosAsset['source']>(asset.source);
  const [aspectRatio, setAspectRatio] = useState(asset.aspect_ratio ?? '');
  const [shotBy, setShotBy] = useState(asset.shot_by ?? '');
  const [shotOn, setShotOn] = useState(asset.shot_on ? asset.shot_on.slice(0, 10) : '');
  const [rightsExpiry, setRightsExpiry] = useState(asset.rights_expiry ? asset.rights_expiry.slice(0, 10) : '');
  const [usageRights, setUsageRights] = useState(asset.usage_rights ?? '');
  const [busy, setBusy] = useState(false);

  // A custom stored ratio (not one of the presets) is kept selectable so a save
  // doesn't silently drop it.
  const knownRatio = ASSET_ASPECT_RATIOS.some((r) => r.value === aspectRatio);

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      addToast(isAr ? 'العنوان مطلوب.' : 'Title is required.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await saveAsset({
        id: asset.id,
        title: title.trim(),
        project_id: projectId || null,
        source,
        aspect_ratio: aspectRatio || null,
        shot_by: shotBy.trim() || null,
        shot_on: shotOn || null,
        rights_expiry: rightsExpiry || null,
        usage_rights: usageRights.trim() || null,
      });
      addToast(isAr ? 'حُفظت التعديلات.' : 'Changes saved.', 'success');
      onSaved(res.asset);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'تعديل المادة' : 'Edit asset'}
      sub={isAr
        ? 'الملف نفسه ونوعه لا يتغيّران — عدِّل بيانات السجل.'
        : 'The file and its kind are fixed — edit the record details.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'العنوان' : 'Title'}>
        <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label={isAr ? 'المشروع' : 'Project'}>
          <select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{isAr ? 'بدون' : 'None'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
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
      <Field label={isAr ? 'المقاس (نسبة الأبعاد)' : 'Size (aspect ratio)'}>
        <select className="inp" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
          <option value="">{isAr ? 'بدون' : 'None'}</option>
          {ASSET_ASPECT_RATIOS.map((r) => (
            <option key={r.value} value={r.value}>{isAr ? r.ar : r.en}</option>
          ))}
          {aspectRatio && !knownRatio && <option value={aspectRatio}>{aspectRatio}</option>}
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label={isAr ? 'صوّرها' : 'Shot by'}>
          <input className="inp" value={shotBy} onChange={(e) => setShotBy(e.target.value)} />
        </Field>
        <Field label={isAr ? 'تاريخ التصوير' : 'Shot on'}>
          <input type="date" className="inp ltr" value={shotOn} onChange={(e) => setShotOn(e.target.value)} />
        </Field>
      </div>
      <Field label={isAr ? 'حقوق الاستخدام' : 'Usage rights'}>
        <input className="inp" value={usageRights} onChange={(e) => setUsageRights(e.target.value)} />
      </Field>
      <Field label={isAr ? 'انتهاء الحقوق' : 'Rights expiry'}>
        <input type="date" className="inp ltr" value={rightsExpiry} onChange={(e) => setRightsExpiry(e.target.value)} />
      </Field>
    </Modal>
  );
}

/**
 * «استخدام في محتوى» — the s41 flow pointed at one asset: a content item is
 * created with the asset pre-linked, then the person lands on it.
 */
function UseInContentModal({
  isAr, asset, contentTypes, onClose, onCreated,
}: {
  isAr: boolean;
  asset: MosAsset;
  contentTypes: Array<{ key: string; label_ar: string; label_en: string }>;
  onClose: () => void;
  onCreated: (contentId: string) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [typeKey, setTypeKey] = useState(contentTypes[0]?.key ?? '');
  const [title, setTitle] = useState(asset.title);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!typeKey) {
      addToast(isAr ? 'اختر نوع المحتوى.' : 'Pick a content type.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await bulkAssets([asset.id], 'create_content', {
        content_type_key: typeKey,
        title: title.trim() || asset.title,
      });
      if (!res.content_id) throw new Error(isAr ? 'لم يُنشأ المحتوى.' : 'The content was not created.');
      onCreated(res.content_id);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'استخدام في محتوى' : 'Use in content'}
      sub={isAr
        ? 'يفتح «محتوى جديد» مع هذه المادة مربوطة مسبقًا.'
        : 'Opens “New content” with this asset already linked.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            <IconPlus />
            {busy ? (isAr ? 'جارٍ…' : 'Working…') : isAr ? 'إنشاء المحتوى' : 'Create the content'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'النوع' : 'Type'}>
        <select className="inp" value={typeKey} onChange={(e) => setTypeKey(e.target.value)}>
          {contentTypes.map((t) => (
            <option key={t.key} value={t.key}>{isAr ? t.label_ar : t.label_en}</option>
          ))}
        </select>
      </Field>
      <Field label={isAr ? 'العنوان' : 'Title'}>
        <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
    </Modal>
  );
}
