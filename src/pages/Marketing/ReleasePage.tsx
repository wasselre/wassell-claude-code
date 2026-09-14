/**
 * The publication task — /m/releases/:releaseId (2026-09-14).
 *
 * Making a creative and putting it out are two different jobs. The CONTENT task
 * ends at the manager's final approval; a RELEASE is one finished creative, one
 * destination, one date. A creative cross-posted to three platforms has three
 * releases and therefore three of these screens — which is the whole point: the
 * single old `publish_check` step had to stand for every destination a creative
 * would ever have, so the second one had no owner and no way to be completed.
 *
 * THIS SCREEN SHOWS EXACTLY THREE SECTIONS AND NOTHING ELSE:
 *   (a) the final ready content   — the approved file(s) and the caption, READ ONLY
 *   (b) where it is going          — platform, account, date, time, timezone
 *   (c) what that platform demands — the rulebook's verdict, and the act
 *
 * No brief, no references, no revision history, no approval controls, no
 * activity feed. Those belong to the content task, which is a different job
 * done by different people at a different time. If you are about to add one of
 * them here, you are re-merging the two jobs this screen exists to separate.
 *
 * The act lives where its gate lives: the automatic «انشر الآن» sits under the
 * platform's requirements (they are what allows or refuses it), and the manual
 * «سجّل النشر» sits with the destination (the resulting link IS destination
 * fact). Nothing is ever disabled in silence — a blocked publish says which
 * requirement blocks it, in words, right beside the button.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosRelease, MosReleaseAsset, PLATFORM_LABELS, PUB_STATUS_LABELS,
  fetchRelease, markReleasePublished, publishPublication,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { LoadError, PageHead, Pill, ReadField, Skeleton, type Tone } from './components/kit';
import { IconCheck, IconSend, IconX } from './components/icons';
import { useAssetUrls } from './lib/assetUrls';
import { formatBytes } from './lib/upload';
import { dateTime, num, toArabicDigits } from './lib/format';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** The asset kinds the library models. A release row carries `kind` as free
 *  text, so an unknown one reads as a document rather than crashing a lookup. */
const ASSET_KINDS = ['photo', 'video', 'design', 'audio', 'document'] as const;
type AssetKind = (typeof ASSET_KINDS)[number];

const assetKind = (raw: string): AssetKind =>
  (ASSET_KINDS as readonly string[]).includes(raw) ? (raw as AssetKind) : 'document';

/** The shape `useAssetUrls` resolves — a release asset has no stored thumb. */
interface ResolvableReleaseAsset {
  file_id: string | null;
  url: string | null;
  thumb_url: string | null;
  kind: AssetKind;
  mime_type: string | null;
}

const resolvable = (a: MosReleaseAsset): ResolvableReleaseAsset => ({
  file_id: a.file_id,
  url: a.url,
  thumb_url: null,
  kind: assetKind(a.kind),
  mime_type: a.mime_type,
});

const isImage = (a: MosReleaseAsset): boolean => {
  const mime = (a.mime_type ?? '').toLowerCase();
  if (mime) return mime.startsWith('image/');
  const k = assetKind(a.kind);
  return k === 'photo' || k === 'design';
};

/** Supabase storage (signed and public alike) honours `?download=<name>`. */
const downloadHref = (url: string, name: string): string =>
  `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(name)}`;

const ASSET_KIND_LABELS: Record<AssetKind, { ar: string; en: string }> = {
  photo:    { ar: 'صورة',   en: 'Photo' },
  video:    { ar: 'فيديو',  en: 'Video' },
  design:   { ar: 'تصميم',  en: 'Design' },
  audio:    { ar: 'صوت',    en: 'Audio' },
  document: { ar: 'ملف',    en: 'File' },
};

/** «٢:٣٤» — a clip's runtime, for the file line. */
function runtime(seconds: number | null, isAr: boolean): string | null {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60).toString().padStart(2, '0');
  return `${num(m, isAr)}:${isAr ? toArabicDigits(s) : s}`;
}

/** The status pill's tone — a release is either out, moving, or waiting. */
function statusTone(status: string): Tone {
  if (status === 'published') return 'live';
  if (status === 'cancelled') return 'idle';
  if (status === 'scheduled') return 'go';
  return 'now';
}

const statusLabel = (status: string, isAr: boolean): string => {
  const hit = PUB_STATUS_LABELS[status];
  if (hit) return isAr ? hit.ar : hit.en;
  if (status === 'planned') return isAr ? 'مخطط' : 'Planned';
  return status;
};

const platformLabel = (platform: string, isAr: boolean): string => {
  const hit = PLATFORM_LABELS[platform];
  return hit ? (isAr ? hit.ar : hit.en) : platform;
};

/* ------------------------------------------------------------------ */
/* the page                                                           */
/* ------------------------------------------------------------------ */

export default function ReleasePage() {
  const { releaseId } = useParams<{ releaseId: string }>();
  const { isAr, can } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);

  const [release, setRelease] = useState<MosRelease | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');

  const load = useCallback(async () => {
    if (!releaseId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchRelease(releaseId);
      setRelease(res.release);
      setLinkDraft(res.release.destination.external_url ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [releaseId]);

  useEffect(() => { void load(); }, [load]);

  const assets = useMemo(() => release?.content.assets ?? [], [release]);
  const resolvableAssets = useMemo(() => assets.map(resolvable), [assets]);
  // A file we cannot resolve a URL for is stated, never rendered as a blank box.
  const { urlFor, error: urlError, retry: retryUrls } = useAssetUrls(resolvableAssets);

  const caption = release?.content.caption ?? '';

  /** Hand the release to the platform. Only offered where it can publish itself. */
  const publishNow = async (): Promise<void> => {
    if (!release) return;
    setBusy(true);
    try {
      await publishPublication(release.id);
      addToast(isAr ? 'أُرسل للنشر عبر المنصة' : 'Handed to the platform to publish', 'success');
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Record a release a PERSON published by hand, with the resulting link. */
  const recordPublished = async (): Promise<void> => {
    if (!release) return;
    setBusy(true);
    try {
      await markReleasePublished(release.id, linkDraft.trim() || null);
      addToast(isAr ? 'سُجّل النشر' : 'Recorded as published', 'success');
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyCaption = async (): Promise<void> => {
    if (!caption) return;
    try {
      await navigator.clipboard.writeText(caption);
      addToast(isAr ? 'نُسخ الكابشن' : 'Caption copied', 'success');
    } catch (e) {
      // The clipboard needs a secure context plus a user gesture. When it is
      // refused the caption is still on screen — say so instead of pretending.
      console.error('[marketing] release caption copy failed', e);
      addToast(
        isAr ? 'تعذّر النسخ — انسخه يدويًا من الصندوق' : 'Copy failed — select it from the box manually',
        'error',
      );
    }
  };

  if (!releaseId) {
    return (
      <>
        <PageHead title={isAr ? 'نشر' : 'Release'} />
        <div className="body">
          <LoadError
            message={isAr ? 'لا يوجد معرّف نشر في الرابط.' : 'The link carries no release id.'}
            onRetry={() => navigate('/m/my-work')}
            isAr={isAr}
          />
        </div>
      </>
    );
  }

  const title = release?.content.title
    ?? release?.content.ref
    ?? (isAr ? 'نشر' : 'Release');
  const dest = release?.destination;
  const req = release?.requirements;
  const published = release?.status === 'published';
  const blockers = (req?.issues ?? []).filter((i) => i.level === 'block');
  const warnings = (req?.issues ?? []).filter((i) => i.level !== 'block');
  const canPublish = can('publish');

  return (
    <>
      <PageHead
        title={title}
        crumb={
          <>
            <button type="button" onClick={() => navigate('/m/my-work')}>
              {isAr ? 'مهامي' : 'My work'}
            </button>
            <span className="sep">/</span>
            <span>{isAr ? 'نشر' : 'Release'}</span>
          </>
        }
        sub={release && dest && (
          <span
            className="chips"
            style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}
          >
            {release.content.ref && <span className="tag ltr">{release.content.ref}</span>}
            <span className="tag">{platformLabel(dest.platform, isAr)}</span>
            {dest.account_handle && <span className="tag ltr">{dest.account_handle}</span>}
            <Pill tone={statusTone(release.status)}>{statusLabel(release.status, isAr)}</Pill>
            <span className="tag">
              {release.automatable
                ? isAr ? 'تنشر المنصة تلقائيًا' : 'The platform posts it'
                : isAr ? 'نشر يدوي' : 'Published by a person'}
            </span>
          </span>
        )}
      />

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && !release && <Skeleton rows={6} />}

        {release && dest && req && (
          <div style={{ display: 'grid', gap: 16 }}>

            {/* ── (a) the final ready content ──────────────────────────── */}
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'المادة الجاهزة' : 'The finished material'}</h4>
                <span className="r">
                  {isAr
                    ? `${num(assets.length, true)} ملف معتمد`
                    : `${assets.length} approved file${assets.length === 1 ? '' : 's'}`}
                </span>
              </div>
              <div className="card-b">
                {urlError && (
                  <div className="notice bad" role="alert" style={{ marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      {isAr ? 'تعذّر فتح روابط الملفات' : 'The file links could not be opened'}
                    </div>
                    <div style={{ overflowWrap: 'anywhere' }}>{urlError}</div>
                    <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={retryUrls}>
                      {isAr ? 'إعادة المحاولة' : 'Try again'}
                    </button>
                  </div>
                )}

                {assets.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.8 }}>
                    {isAr
                      ? 'لا ملف معتمد على هذا النشر — لا يمكن النشر قبل ربط الملف النهائي.'
                      : 'This release has no approved file — nothing can go out until one is linked.'}
                  </div>
                ) : (
                  assets.map((a, i) => {
                    const url = urlFor(resolvable(a));
                    const kindLabel = isAr
                      ? ASSET_KIND_LABELS[assetKind(a.kind)].ar
                      : ASSET_KIND_LABELS[assetKind(a.kind)].en;
                    const name = `${release.content.ref ?? 'file'}-${i + 1}`;
                    const clip = runtime(a.duration_seconds, isAr);
                    return (
                      <div key={a.id} className="file">
                        <div className="th">
                          {url && isImage(a)
                            ? <img src={url} alt="" />
                            : <span style={{ fontSize: 10, fontWeight: 700 }}>{kindLabel}</span>}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="nm">
                            {isAr ? `الملف ${num(i + 1, true)}` : `File ${i + 1}`} · {kindLabel}
                          </div>
                          <div className="mt">
                            {[
                              a.aspect_ratio,
                              clip,
                              a.size_bytes ? formatBytes(a.size_bytes, isAr) : null,
                            ].filter((x): x is string => Boolean(x)).join(' · ') || '—'}
                          </div>
                        </div>
                        {url ? (
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">
                              {isAr ? 'فتح' : 'Open'}
                            </a>
                            <a className="btn btn-sm" href={downloadHref(url, name)}>
                              {isAr ? 'تنزيل' : 'Download'}
                            </a>
                          </div>
                        ) : (
                          <span className="tag" style={{ flexShrink: 0 }}>
                            {isAr ? 'الرابط غير متاح' : 'No link'}
                          </span>
                        )}
                      </div>
                    );
                  })
                )}

                <div className="lbl" style={{ margin: '14px 0 6px' }}>
                  {isAr ? 'الكابشن' : 'Caption'}
                </div>
                {caption ? (
                  <>
                    <textarea className="inp" readOnly rows={6} value={caption} />
                    <div style={{ marginTop: 8 }}>
                      <button type="button" className="btn btn-sm" onClick={() => void copyCaption()}>
                        {isAr ? 'نسخ الكابشن' : 'Copy caption'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 12.5, color: 'var(--mute)' }}>
                    {isAr ? 'بلا كابشن.' : 'No caption.'}
                  </div>
                )}
              </div>
            </div>

            {/* ── (b) where it is going ────────────────────────────────── */}
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'إلى أين يذهب' : 'Where it is going'}</h4>
              </div>
              <div className="card-b">
                <ReadField label={isAr ? 'المنصة' : 'Platform'}>
                  {platformLabel(dest.platform, isAr)}
                </ReadField>
                <ReadField label={isAr ? 'الحساب' : 'Account'}>
                  {dest.account_handle
                    ? <span className="ltr">{dest.account_handle}</span>
                    : (isAr ? 'لم يُحدَّد حساب' : 'No account chosen')}
                  {dest.account_id && (
                    <>
                      {' · '}
                      {dest.account_connected
                        ? (isAr ? 'مربوط' : 'connected')
                        : (isAr ? 'غير مربوط' : 'not connected')}
                      {dest.account_connected && !dest.account_can_publish && (
                        <> · {isAr ? 'بلا صلاحية نشر' : 'cannot publish'}</>
                      )}
                    </>
                  )}
                </ReadField>
                <ReadField label={isAr ? 'الموعد' : 'Date and time'}>
                  {dest.due_at ? dateTime(dest.due_at, isAr) : (isAr ? 'بلا موعد' : 'No slot set')}
                  {dest.timezone && <> · <span className="ltr">{dest.timezone}</span></>}
                </ReadField>

                {published ? (
                  <>
                    <ReadField label={isAr ? 'نُشر في' : 'Published at'}>
                      {dateTime(dest.published_at, isAr)}
                    </ReadField>
                    <ReadField label={isAr ? 'رابط المنشور' : 'Post link'}>
                      {dest.external_url
                        ? (
                          <a className="ltr" href={dest.external_url} target="_blank" rel="noreferrer">
                            {dest.external_url}
                          </a>
                        )
                        : (isAr ? 'بلا رابط مسجَّل' : 'No link recorded')}
                    </ReadField>
                  </>
                ) : !release.automatable && (
                  /* Nobody can publish this for us: the person posts it, pastes
                     the link, and the release — and its task — close together. */
                  <div style={{ marginTop: 14 }}>
                    <div className="lbl" style={{ marginBottom: 6 }}>
                      {isAr ? 'رابط المنشور بعد النشر' : 'The link once you have posted it'}
                    </div>
                    <input
                      className="inp ltr"
                      type="url"
                      dir="ltr"
                      placeholder="https://…"
                      value={linkDraft}
                      disabled={busy || !canPublish}
                      onChange={(e) => setLinkDraft(e.target.value)}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-p"
                        disabled={busy || !canPublish}
                        onClick={() => void recordPublished()}
                      >
                        <IconCheck />
                        {busy ? (isAr ? 'جارٍ التسجيل…' : 'Recording…') : (isAr ? 'سجّل النشر' : 'Record published')}
                      </button>
                      {!canPublish && (
                        <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                          {isAr
                            ? 'تسجيل النشر يحتاج صلاحية النشر.'
                            : 'Recording a release needs the publish permission.'}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── (c) what that platform demands ───────────────────────── */}
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'ما تطلبه المنصة' : 'What the platform requires'}</h4>
                <span className="r">
                  {req.caption_max === null
                    ? (isAr
                      ? `${num(req.caption_length, true)} حرفًا`
                      : `${req.caption_length} characters`)
                    : (isAr
                      ? `${num(req.caption_length, true)} / ${num(req.caption_max, true)} حرفًا`
                      : `${req.caption_length} / ${req.caption_max} characters`)}
                </span>
              </div>
              <div className="card-b">
                {/* The caption counter, against this platform's own ceiling. */}
                {req.caption_max !== null && (
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      marginBottom: 12,
                      color: req.caption_length > req.caption_max ? 'var(--late)' : 'var(--mute)',
                    }}
                  >
                    {req.caption_length > req.caption_max
                      ? isAr
                        ? `الكابشن أطول من حدّ ${platformLabel(dest.platform, true)} بـ ${num(req.caption_length - req.caption_max, true)} حرفًا.`
                        : `The caption is ${req.caption_length - req.caption_max} characters over ${platformLabel(dest.platform, false)}’s limit.`
                      : isAr
                        ? `يتبقّى ${num(req.caption_max - req.caption_length, true)} حرفًا من حدّ ${platformLabel(dest.platform, true)}.`
                        : `${req.caption_max - req.caption_length} characters left of ${platformLabel(dest.platform, false)}’s limit.`}
                  </div>
                )}

                {blockers.length === 0 && warnings.length === 0 ? (
                  <div className="chk ok">
                    <IconCheck />
                    <span>
                      {isAr
                        ? 'كل ما تطلبه المنصة مستوفى.'
                        : 'Everything this platform asks for is satisfied.'}
                    </span>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {blockers.map((issue, i) => (
                      <div key={`b${i}`} className="notice bad" role="alert">
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          <IconX />
                          <span>{isAr ? issue.ar : issue.en}</span>
                        </span>
                      </div>
                    ))}
                    {warnings.map((issue, i) => (
                      <div key={`w${i}`} className="notice">
                        {isAr ? issue.ar : issue.en}
                      </div>
                    ))}
                  </div>
                )}

                {/* The act that these requirements gate. Automatic destinations
                    only — a manual one is recorded with its link above. */}
                {release.automatable && !published && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-p"
                      disabled={busy || !req.ok || !canPublish}
                      onClick={() => void publishNow()}
                    >
                      <IconSend />
                      {busy ? (isAr ? 'جارٍ الإرسال…' : 'Sending…') : (isAr ? 'انشر الآن' : 'Publish now')}
                    </button>
                    {/* Never a silent disable: the reason stands beside it. */}
                    {!req.ok && (
                      <span style={{ fontSize: 11.5, color: 'var(--late)', fontWeight: 700 }}>
                        {isAr
                          ? `النشر موقوف حتى تُعالَج ${num(blockers.length, true)} من المتطلبات أعلاه.`
                          : `Publishing is held until the ${blockers.length} requirement${blockers.length === 1 ? '' : 's'} above ${blockers.length === 1 ? 'is' : 'are'} fixed.`}
                      </span>
                    )}
                    {req.ok && !canPublish && (
                      <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                        {isAr ? 'النشر يحتاج صلاحية النشر.' : 'Publishing needs the publish permission.'}
                      </span>
                    )}
                  </div>
                )}

                {published && (
                  <div style={{ fontSize: 12.5, color: 'var(--mute)', marginTop: 14 }}>
                    {isAr
                      ? 'هذا النشر خرج بالفعل — الشاشة للقراءة فقط.'
                      : 'This release is already out — the screen is read-only now.'}
                  </div>
                )}

                {dest.bundle_error && (
                  <div className="notice bad" role="alert" style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      {isAr ? 'آخر محاولة نشر آلي فشلت' : 'The last automatic publish failed'}
                    </div>
                    <div style={{ overflowWrap: 'anywhere' }}>{dest.bundle_error}</div>
                  </div>
                )}
              </div>
            </div>

          </div>
        )}
      </div>
    </>
  );
}
