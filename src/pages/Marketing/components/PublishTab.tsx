/**
 * Publishing — design screen 11, rebuilt as one CARD per publication.
 *
 * ONE ROW PER PLATFORM, never a multi-select: «V-002 خرج» is not one fact about
 * the video but three separate facts about three platforms — each publication
 * carries its own file, its own caption, its own account, its own timing and
 * its own result. The three cards deliberately read differently by state:
 * published (facts + first numbers), scheduled (who posts, manually), and
 * incomplete (the gaps named out loud — «بحاجة لموعد» يعطّل «جاهز»).
 *
 * THE FILE PICKER OFFERS ONLY APPROVED FILES — assets linked to this item with
 * role 'final' (Materials band 4). That single rule is what ends «أي نسخة
 * خرجت؟» forever, and it is enforced here in code, not by convention.
 *
 * Publishing is manual by decision (design answer 4: «النشر ليس تلقائي»). No
 * account here can publish until someone connects it, and the screen says so
 * rather than implying an automation that does not exist.
 *
 * PHONE (<760px — design screen 31): the Publish Assistant bottom sheet makes
 * the manual path NINETY SECONDS instead of ten minutes — the caption copies
 * with one tap, the approved file is one tap away, the platform opens for
 * you, and «تعليمه كمنشور» confirms with the post link through the same
 * publication_save the desktop modal uses. Desktop is unchanged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  MosAccount, MosAsset, MosPublication, PLATFORM_LABELS, PUB_STATUS_LABELS,
  fetchAssets, savePublication, publishPublication, syncPublication, pullMetrics,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Field, Modal, Pill, type Tone } from './kit';
import { IconPlus } from './icons';
import { dateTimeShort, isoDateTimeLocal, num, shortDate, toArabicDigits } from '../lib/format';
import { useAssetUrls } from '../lib/assetUrls';
import '../styles/mobile-m3.css';

const PLATFORMS = ['instagram', 'tiktok', 'snapchat', 'x', 'youtube', 'website'] as const;

/** The platforms we can post to automatically via bundle.social. */
const AUTO_PLATFORMS = new Set(['instagram', 'tiktok', 'snapchat']);

/** bundle.social's fine-grained status → a bilingual chip label + Pill tone. */
function bundleStatusChip(s: string | null): { ar: string; en: string; tone: Tone } | null {
  switch (s) {
    case 'SCHEDULED': return { ar: 'مجدول عبر API', en: 'Scheduled via API', tone: 'go' };
    case 'PROCESSING': return { ar: 'يُنشر الآن…', en: 'Publishing…', tone: 'now' };
    case 'RETRYING': return { ar: 'إعادة المحاولة…', en: 'Retrying…', tone: 'now' };
    case 'REVIEW': return { ar: 'قيد مراجعة المنصة', en: 'Under review', tone: 'wait' };
    case 'POSTED': return { ar: 'نُشر تلقائيًا', en: 'Auto-published', tone: 'live' };
    case 'ERROR': return { ar: 'فشل النشر التلقائي', en: 'Auto-publish failed', tone: 'wait' };
    default: return null;
  }
}

/** The platforms' own colours — the mockup's header dots and account badges. */
const PLATFORM_COLOR: Record<string, string> = {
  instagram: '#C13584',
  tiktok: 'var(--ink)',
  snapchat: '#C8B400',
  x: 'var(--ink)',
  youtube: '#B03A2E',
  website: 'var(--copper)',
};
const PLATFORM_INITIALS: Record<string, string> = {
  instagram: 'IG', tiktok: 'TT', snapchat: 'SC', x: 'X', youtube: 'YT', website: 'WEB',
};

/* ------------------------------------------------------------------ */
/* Phone helpers — screen 31's Publish Assistant                       */
/* ------------------------------------------------------------------ */

/** The tab bar breakpoint — the assistant exists only below it. */
function useIsPhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const onChange = (e: MediaQueryListEvent): void => setPhone(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}

/** «٧:٠٠ م» / "7:00 PM" — the mock's time-only pill shape. */
function timeShort(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = isAr ? (h < 12 ? 'ص' : 'م') : h < 12 ? 'AM' : 'PM';
  return `${num(h12, isAr)}:${isAr ? toArabicDigits(m) : m} ${suffix}`;
}

function sameLocalDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

/** «افتحي انستقرام» — the deep link the assistant's primary button opens. */
function platformLink(platform: string, handle: string | null): string | null {
  const h = (handle ?? '').replace(/^@/, '').trim();
  switch (platform) {
    case 'instagram': return h ? `https://www.instagram.com/${h}/` : 'https://www.instagram.com/';
    case 'tiktok': return h ? `https://www.tiktok.com/@${h}` : 'https://www.tiktok.com/';
    case 'snapchat': return h ? `https://www.snapchat.com/add/${h}` : 'https://www.snapchat.com/';
    case 'x': return h ? `https://x.com/${h}` : 'https://x.com/';
    case 'youtube': return 'https://www.youtube.com/';
    default: return null; // website — nothing sensible to deep-link to
  }
}

/** `asset_id`, `file_id` and `published_by_user_id` now live on MosPublication;
 *  the alias is kept only to avoid churning the many call sites below. */
type PubRow = MosPublication;

export default function PublishTab({
  contentId, publications, accounts, canEdit, isAr, onChange,
}: {
  contentId: string;
  publications: MosPublication[];
  accounts: MosAccount[];
  canEdit: boolean;
  isAr: boolean;
  onChange: (pubs: MosPublication[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const { people } = useWorkspace();
  const [editing, setEditing] = useState<MosPublication | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finalAssets, setFinalAssets] = useState<MosAsset[]>([]);
  const [allAssets, setAllAssets] = useState<MosAsset[]>([]);
  // Legacy assets keep their public URL; file-backed ones resolve to a signed one.
  const { urlFor, thumbFor } = useAssetUrls(allAssets);

  // The approved files — band 4 of the Materials tab: links with role 'final'.
  // Non-fatal on failure: the picker shows the empty-rule copy and the error
  // is logged, never swallowed.
  const loadFinals = useCallback(async () => {
    try {
      const res = await fetchAssets();
      setAllAssets(res.assets);
      const finalIds = new Set(
        res.links.filter((l) => l.content_id === contentId && l.role === 'final').map((l) => l.asset_id),
      );
      setFinalAssets(res.assets.filter((a) => finalIds.has(a.id)));
    } catch (e) {
      console.error('[marketing] approved-file list unavailable', e);
    }
  }, [contentId]);
  useEffect(() => { void loadFinals(); }, [loadFinals]);

  const nameOf = (userId: string | null | undefined): string | null => {
    if (!userId) return null;
    const u = people.find((x) => x.user_id === userId);
    if (!u) return null;
    return (isAr ? u.name_ar : u.name_en) ?? u.name_en ?? u.name_ar;
  };

  const save = async (payload: Record<string, unknown>, pickedAsset: MosAsset | null): Promise<void> => {
    setBusy(true);
    try {
      const res = await savePublication(contentId, payload);
      onChange(res.publications);
      setEditing(null);
      setAdding(false);
      addToast(isAr ? 'حُفظ' : 'Saved', 'success');
      // The file pick must not fail silently: verify the server actually kept the
      // approved-file link (by asset id) rather than assuming the save took it.
      if (pickedAsset) {
        const savedRow = (res.publications as PubRow[]).find(
          (p) => p.id === payload.id || (!payload.id && p.platform === payload.platform),
        );
        if (savedRow?.asset_id !== pickedAsset.id) {
          console.error('[marketing] publication file link not persisted', {
            picked: pickedAsset.id, saved: savedRow?.asset_id ?? null,
          });
          addToast(
            isAr
              ? 'حُفظ النشر، لكن ربط الملف المعتمد لم يُحفظ — أعِد المحاولة.'
              : 'The publication saved, but the approved-file link did not — please try again.',
            'error',
          );
        }
      }
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ── organic posting via bundle.social ───────────────────────────── */
  const [apiBusyId, setApiBusyId] = useState<string | null>(null);

  /** Post/schedule this row for real on the connected platform. */
  const publishViaApi = useCallback(async (pub: MosPublication): Promise<void> => {
    setApiBusyId(pub.id);
    try {
      const res = await publishPublication(pub.id);
      onChange(res.publications);
      addToast(isAr ? 'أُرسل للنشر عبر المنصة' : 'Handed to the platform to publish', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setApiBusyId(null);
    }
  }, [addToast, isAr, onChange]);

  /** Reconcile one row's status with bundle.social (POSTED → published + link). */
  const refreshViaApi = useCallback(async (pub: MosPublication, silent = false): Promise<void> => {
    if (!silent) setApiBusyId(pub.id);
    try {
      const res = await syncPublication(pub.id);
      onChange(res.publications);
    } catch (e) {
      if (!silent) addToast(e instanceof Error ? e.message : String(e), 'error');
      else console.error('[marketing] auto status refresh failed', e);
    } finally {
      if (!silent) setApiBusyId(null);
    }
  }, [addToast, onChange]);

  /** Pull the latest platform numbers for one published bundle post. */
  const pullNumbersFor = useCallback(async (pub: MosPublication, silent = false): Promise<void> => {
    if (!silent) setApiBusyId(pub.id);
    try {
      const res = await pullMetrics(pub.id);
      onChange(res.publications);
    } catch (e) {
      if (!silent) addToast(e instanceof Error ? e.message : String(e), 'error');
      else console.error('[marketing] auto metrics pull failed', e);
    } finally {
      if (!silent) setApiBusyId(null);
    }
  }, [addToast, onChange]);

  // On tab open, once per mount: flip any non-terminal bundle post that finished
  // publishing in the background, and pull fresh numbers for published ones — so
  // the card shows the latest status AND performance without a manual click (the
  // daily cron does the same server-side; this makes it immediate on open).
  const polledRef = useRef(false);
  useEffect(() => {
    if (polledRef.current) return;
    const pending = publications.filter(
      (p) => p.bundle_post_id && p.status !== 'published'
        && p.bundle_status !== 'POSTED' && p.bundle_status !== 'ERROR',
    );
    const published = publications.filter((p) => p.bundle_post_id && p.status === 'published');
    if (pending.length === 0 && published.length === 0) return;
    polledRef.current = true;
    void (async () => {
      for (const p of pending) { await refreshViaApi(p, true); }
      for (const p of published) { await pullNumbersFor(p, true); }
    })();
  }, [publications, refreshViaApi, pullNumbersFor]);

  const used = new Set(publications.map((p) => p.platform));
  const available = PLATFORMS.filter((p) => !used.has(p));

  const platformLabel = (p: string): string =>
    (isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p;

  /* ── screen 31 — the phone Publish Assistant ─────────────────────── */
  const isPhone = useIsPhone();
  const [assistId, setAssistId] = useState<string | null>(null);
  const [assistStage, setAssistStage] = useState<'steps' | 'confirm'>('steps');
  const [assistUrl, setAssistUrl] = useState('');
  const [assistCopied, setAssistCopied] = useState(false);
  const [assistFileDone, setAssistFileDone] = useState(false);
  const [assistBusy, setAssistBusy] = useState(false);

  /** The next scheduled slot — the assistant's target. */
  const nextDue = useMemo(() => {
    const scheduled = publications
      .filter((p) => p.status === 'scheduled' && p.scheduled_at)
      .sort((a, b) => (a.scheduled_at ?? '').localeCompare(b.scheduled_at ?? ''));
    return scheduled[0] ?? null;
  }, [publications]);

  const assistPub = assistId ? publications.find((p) => p.id === assistId) ?? null : null;

  /** Honest wording: «حان وقت النشر» only when the slot is actually here. */
  const isDue = (p: MosPublication): boolean =>
    Boolean(p.scheduled_at && new Date(p.scheduled_at).getTime() <= Date.now() + 30 * 60_000);

  const schedLabel = (p: MosPublication): string => {
    if (!p.scheduled_at) return isAr ? 'مجدول' : 'Scheduled';
    const t = sameLocalDay(p.scheduled_at, new Date().toISOString())
      ? timeShort(p.scheduled_at, isAr)
      : dateTimeShort(p.scheduled_at, isAr);
    return isAr ? `مجدول ${t}` : `Scheduled ${t}`;
  };

  /** The other slots still scheduled the same night — the confirm box's list. */
  const remainingTonight = useMemo(() => {
    if (!assistPub?.scheduled_at) return [] as MosPublication[];
    const anchor = assistPub.scheduled_at;
    return publications.filter((p) =>
      p.id !== assistPub.id && p.status === 'scheduled' && p.scheduled_at
      && sameLocalDay(p.scheduled_at, anchor));
  }, [publications, assistPub]);

  const openAssist = (pub: MosPublication): void => {
    setAssistId(pub.id);
    setAssistStage('steps');
    setAssistUrl(pub.external_url ?? '');
    setAssistCopied(false);
    setAssistFileDone(false);
  };
  const closeAssist = (): void => setAssistId(null);

  const copyCaption = async (pub: MosPublication): Promise<void> => {
    if (!pub.caption) return;
    try {
      await navigator.clipboard.writeText(pub.caption);
      setAssistCopied(true);
      addToast(isAr ? 'نُسخ الكابشن' : 'Caption copied', 'success');
    } catch (e) {
      // Clipboard access needs a secure context + user gesture; when it is
      // refused the caption is still on screen — say so instead of pretending.
      console.error('[marketing] caption copy failed', e);
      addToast(
        isAr ? 'تعذّر النسخ — انسخيه يدويًا من الصندوق' : 'Copy failed — select it from the box manually',
        'error',
      );
    }
  };

  /** «تعليمه كمنشور» — the same publication_save the desktop modal uses. */
  const markPublished = async (): Promise<void> => {
    const pub = assistPub as PubRow | null;
    if (!pub) return;
    setAssistBusy(true);
    try {
      const res = await savePublication(contentId, {
        id: pub.id,
        platform: pub.platform,
        account_id: pub.account_id,
        status: 'published',
        scheduled_at: pub.scheduled_at,
        caption: pub.caption,
        external_url: assistUrl.trim() || pub.external_url || null,
        asset_id: pub.asset_id ?? null,
        file_id: pub.file_id ?? null,
      });
      onChange(res.publications);
      addToast(isAr ? 'عُلِّم كمنشور' : 'Marked published', 'success');
      closeAssist();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setAssistBusy(false);
    }
  };

  /** The approved asset a publication carries — by asset id (the durable link),
   *  falling back to the legacy file_id key for rows saved before the switch. */
  const fileAssetOf = (pub: PubRow): MosAsset | null => {
    if (pub.asset_id) return allAssets.find((a) => a.id === pub.asset_id) ?? null;
    if (pub.file_id) return allAssets.find((a) => a.file_id === pub.file_id) ?? null;
    return null;
  };

  const igCaption = publications.find((p) => p.platform === 'instagram' && p.caption)?.caption ?? null;

  const pubCard = (pubRaw: MosPublication) => {
    const pub = pubRaw as PubRow;
    const color = PLATFORM_COLOR[pub.platform] ?? 'var(--copper)';
    const fileAsset = fileAssetOf(pub);
    const needsTime = pub.status === 'draft' && !pub.scheduled_at;
    const publisher = nameOf(pub.published_by_user_id);
    const captionDiffers = pub.platform !== 'instagram' && igCaption !== null
      && pub.caption !== null && pub.caption !== '' && pub.caption !== igCaption;

    // Organic-posting eligibility for this card.
    const isAuto = AUTO_PLATFORMS.has(pub.platform);
    const connected = pub.account_connected === true;
    const bChip = bundleStatusChip(pub.bundle_status);
    const tiktokNeedsVideo = pub.platform === 'tiktok' && fileAsset != null && fileAsset.kind !== 'video';
    const canAutoPost = canEdit && isAuto && connected && !pub.bundle_post_id
      && fileAsset != null && !tiktokNeedsVideo
      && pub.status !== 'published' && pub.status !== 'cancelled';
    const apiBusy = apiBusyId === pub.id;

    const pill = pub.status === 'published'
      ? <Pill tone="live">{isAr ? PUB_STATUS_LABELS.published?.ar : PUB_STATUS_LABELS.published?.en}</Pill>
      : pub.status === 'scheduled'
        ? <Pill tone="go">{isAr ? PUB_STATUS_LABELS.scheduled?.ar : PUB_STATUS_LABELS.scheduled?.en}</Pill>
        : pub.status === 'cancelled'
          ? <Pill tone="wait">{isAr ? PUB_STATUS_LABELS.cancelled?.ar : PUB_STATUS_LABELS.cancelled?.en}</Pill>
          : needsTime
            ? <Pill tone="idle">{isAr ? 'بحاجة لموعد' : 'Needs a time'}</Pill>
            : <Pill tone="idle">{isAr ? PUB_STATUS_LABELS.draft?.ar : PUB_STATUS_LABELS.draft?.en}</Pill>;

    const fileCell = fileAsset ? (
      <>
        <span className="ltr">{fileAsset.title}</span>{' '}
        <span className="ver" style={{ marginInlineStart: 5 }}>{isAr ? 'معتمد' : 'approved'}</span>
      </>
    ) : (
      <span style={{ color: pub.status === 'published' ? 'var(--ink-2)' : 'var(--mute)' }}>
        {isAr ? 'لم يُختر ملف' : 'No file chosen'}{' '}
        <span className="tag" style={{ marginInlineStart: 5 }}>
          {isAr ? 'معتمد فقط' : 'approved only'}
        </span>
      </span>
    );

    return (
      <div key={pub.id} className="card">
        <div
          className="card-h cd2-pub-h"
          style={pub.status === 'published'
            ? { background: `color-mix(in srgb, ${color} 7%, transparent)` }
            : pub.status === 'scheduled' ? { background: 'var(--sand-2)' } : undefined}
        >
          <span className="cd2-pdot" style={{ background: color }} />
          <h4>{platformLabel(pub.platform)}</h4>
          {(pub.account_handle || pub.account_label_ar) && (
            <span className={pub.account_handle ? 'tag ltr' : 'tag'}>
              {pub.account_handle ?? (isAr ? pub.account_label_ar : pub.account_label_en)}
            </span>
          )}
          <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 7, alignItems: 'center' }}>
            {bChip && pub.status !== 'published' && <Pill tone={bChip.tone}>{isAr ? bChip.ar : bChip.en}</Pill>}
            {pill}
            {canEdit && (
              <button type="button" className="btn btn-d btn-sm" onClick={() => setEditing(pubRaw)}>
                {isAr ? 'تعديل' : 'Edit'}
              </button>
            )}
          </span>
        </div>
        <div className="card-b cd2-pub-grid">
          <div>
            {pub.status === 'published' ? (
              <div className="fld">
                <div className="k">{isAr ? 'تاريخ النشر' : 'Published'}</div>
                <div className="v">
                  {dateTimeShort(pub.published_at, isAr)}
                  {publisher && <> · {isAr ? `بواسطة ${publisher}` : `by ${publisher}`}</>}
                </div>
              </div>
            ) : (
              <div className="fld">
                <div className="k">{isAr ? 'موعد الجدولة' : 'Scheduled for'}</div>
                <div className="v" style={needsTime ? { color: 'var(--late)' } : undefined}>
                  {pub.scheduled_at
                    ? dateTimeShort(pub.scheduled_at, isAr)
                    : isAr ? 'غير محدد — يعطّل «جاهز»' : 'not set — blocks “ready”'}
                </div>
              </div>
            )}
            <div className="fld">
              <div className="k">{isAr ? 'الملف المستخدم' : 'File used'}</div>
              <div className="v">{fileCell}</div>
            </div>
            {pub.status === 'published' && pub.external_url && (
              <div className="fld">
                <div className="k">{isAr ? 'الرابط' : 'Link'}</div>
                <div className="v ltr" style={{ color: 'var(--copper)', overflowWrap: 'anywhere' }}>
                  <a href={pub.external_url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                    {pub.external_url.replace(/^https?:\/\//, '')}
                  </a>
                </div>
              </div>
            )}
            {pub.status === 'scheduled' && (
              <div className="fld">
                <div className="k">{isAr ? 'من ينشر' : 'Who posts'}</div>
                <div className="v">
                  {pub.account_connected
                    ? isAr ? 'يدويًا — عند التذكير' : 'manually — on the reminder'
                    : isAr
                      ? `يدويًا — ${platformLabel(pub.platform)} غير مربوط`
                      : `manually — ${platformLabel(pub.platform)} is not connected`}
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="fld">
              <div className="k">
                {pub.caption
                  ? isAr ? 'الكابشن المستخدم' : 'Caption used'
                  : isAr ? 'الكابشن' : 'Caption'}
              </div>
              {pub.caption ? (
                <>
                  <div className="v" style={{ lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>{pub.caption}</div>
                  {captionDiffers && (
                    <div className="cd2-caption-diff">
                      {isAr ? 'يختلف عن انستقرام' : 'differs from Instagram'}
                    </div>
                  )}
                </>
              ) : (
                <div className="v" style={{ color: 'var(--mute)' }}>
                  {isAr ? 'لم يُكتب' : 'not written'}
                </div>
              )}
            </div>
          </div>
          <div>
            {pub.status === 'published' ? (
              <>
                <div className="fld">
                  <div className="k">{isAr ? 'آخر قراءة' : 'Latest reading'}</div>
                  {pub.latest_captured_at ? (
                    <div className="v" style={{ display: 'flex', gap: 14 }}>
                      <span>
                        <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{num(pub.latest_views, isAr)}</b>
                        <br />
                        <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'مشاهدة' : 'views'}</span>
                      </span>
                      <span>
                        <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{num(pub.latest_engagement, isAr)}</b>
                        <br />
                        <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'تفاعل' : 'engagement'}</span>
                      </span>
                      <span>
                        <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{num(pub.latest_likes, isAr)}</b>
                        <br />
                        <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'إعجاب' : 'likes'}</span>
                      </span>
                      <span>
                        <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{num(pub.latest_comments, isAr)}</b>
                        <br />
                        <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'تعليق' : 'comments'}</span>
                      </span>
                      <span>
                        <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{num(pub.latest_saves, isAr)}</b>
                        <br />
                        <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'حفظ' : 'saves'}</span>
                      </span>
                      <span>
                        <b style={{ fontFamily: 'var(--serif)', fontSize: 18 }}>{num(pub.latest_enquiries, isAr)}</b>
                        <br />
                        <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>{isAr ? 'استفسار' : 'enquiries'}</span>
                      </span>
                    </div>
                  ) : (
                    <div className="v" style={{ color: 'var(--mute)' }}>
                      {isAr ? 'لا قراءات بعد' : 'no readings yet'}
                    </div>
                  )}
                </div>
                {pub.latest_captured_at && (
                  <div style={{ fontSize: 10.5, color: 'var(--mute)', marginTop: 6 }}>
                    {isAr ? 'آخر إدخال ' : 'entered '}{shortDate(pub.latest_captured_at, isAr)}
                    {pub.latest_source === 'api' && (
                      <span className="tag" style={{ marginInlineStart: 6 }}>
                        {isAr ? 'من المنصة' : 'from platform'}
                      </span>
                    )}
                  </div>
                )}
                {pub.bundle_post_id && canEdit && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn btn-d btn-sm"
                      disabled={apiBusy}
                      onClick={() => void pullNumbersFor(pubRaw)}
                    >
                      {apiBusy ? (isAr ? 'تحديث…' : 'Pulling…') : (isAr ? 'تحديث الأرقام' : 'Pull numbers')}
                    </button>
                  </div>
                )}
              </>
            ) : pub.status === 'scheduled' ? (
              <div className="fld">
                <div className="k">{isAr ? 'النتائج' : 'Results'}</div>
                <div className="v" style={{ color: 'var(--mute)' }}>
                  {isAr ? 'بعد النشر' : 'after it goes out'}
                </div>
              </div>
            ) : (
              canEdit && (
                <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
                  <button type="button" className="btn btn-p btn-sm" onClick={() => setEditing(pubRaw)}>
                    {isAr ? 'حدد الموعد والنسخة' : 'Set the time and the file'}
                  </button>
                </div>
              )
            )}
          </div>
        </div>
        {(canAutoPost || pub.bundle_post_id || tiktokNeedsVideo) && (
          <div
            className="card-b"
            style={{
              borderTop: '1px solid var(--sand, #0001)', display: 'flex',
              gap: 10, alignItems: 'center', flexWrap: 'wrap',
            }}
          >
            {canAutoPost && (() => {
              const willSchedule = Boolean(
                pub.scheduled_at && new Date(pub.scheduled_at).getTime() > Date.now() + 60_000,
              );
              return (
                <>
                  <button
                    type="button"
                    className="btn btn-p btn-sm"
                    disabled={apiBusy}
                    onClick={() => void publishViaApi(pubRaw)}
                  >
                    {apiBusy
                      ? (isAr ? 'جارٍ الإرسال…' : 'Sending…')
                      : willSchedule
                        ? (isAr ? `جدولة على ${platformLabel(pub.platform)}` : `Schedule on ${platformLabel(pub.platform)}`)
                        : (isAr ? `انشر الآن على ${platformLabel(pub.platform)}` : `Publish now to ${platformLabel(pub.platform)}`)}
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--mute)' }}>
                    {willSchedule
                      ? (isAr ? 'ينشره النظام تلقائيًا في موعده' : 'the system posts it automatically at its time')
                      : (isAr ? 'يُنشر تلقائيًا خلال دقيقة' : 'auto-posts within a minute')}
                  </span>
                </>
              );
            })()}

            {tiktokNeedsVideo && !pub.bundle_post_id && (
              <span style={{ fontSize: 11, color: 'var(--late)' }}>
                {isAr ? 'تيك توك يقبل الفيديو فقط — اختر ملف فيديو.' : 'TikTok accepts video only — pick a video file.'}
              </span>
            )}

            {pub.bundle_post_id && pub.status !== 'published' && (
              <>
                <button
                  type="button"
                  className="btn btn-d btn-sm"
                  disabled={apiBusy}
                  onClick={() => void refreshViaApi(pubRaw)}
                >
                  {apiBusy ? (isAr ? 'تحديث…' : 'Refreshing…') : (isAr ? 'تحديث الحالة' : 'Refresh status')}
                </button>
                {pub.bundle_status === 'ERROR' && pub.bundle_error && (
                  <span style={{ fontSize: 11, color: 'var(--late)', overflowWrap: 'anywhere' }}>
                    {pub.bundle_error}
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="cd2-split">
      <div style={{ display: 'grid', gap: 13, minWidth: 0 }}>
        {/* s31 — the assistant's entry card. Phone-only, next scheduled slot. */}
        {isPhone && canEdit && nextDue && (
          <button type="button" className="m3-assist" onClick={() => openAssist(nextDue)}>
            <span className="dot" style={{ background: PLATFORM_COLOR[nextDue.platform] ?? 'var(--copper)' }} />
            <span className="t">
              <b>
                {isDue(nextDue)
                  ? isAr ? 'حان وقت النشر' : 'Time to post'
                  : isAr ? 'التالي للنشر' : 'Next up to post'}
              </b>
              <span className="s">
                {platformLabel(nextDue.platform)}
                {nextDue.account_handle && <> · <span className="ltr">{nextDue.account_handle}</span></>}
              </span>
            </span>
            <Pill tone="now">{schedLabel(nextDue)}</Pill>
          </button>
        )}

        {publications.length === 0 ? (
          <div className="card">
            <p style={{ padding: 26, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
              {isAr
                ? 'لا عمليات نشر بعد. صفّ لكل منصة — كابشنها وملفها وتوقيتها ونتيجتها.'
                : 'No publications yet. One row per platform — its caption, its file, its time, its result.'}
            </p>
          </div>
        ) : (
          publications.map(pubCard)
        )}

        {canEdit && available.length > 0 && (
          <div>
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              <IconPlus />
              {isAr ? 'إضافة نشر' : 'Add a publication'}
            </button>
          </div>
        )}

        <div className="notice">
          {isAr
            ? 'المنصات المربوطة (انستقرام، تيك توك، سناب) تنشر تلقائيًا عبر الزر — انشر الآن أو جدول في موعده. المنصات غير المربوطة (إكس، الموقع) تبقى يدوية: علّم الصف «منشور» وضع الرابط لتُدخل الأرقام لاحقًا.'
            : 'Connected platforms (Instagram, TikTok, Snapchat) auto-post from the button — publish now or schedule for the slot. Unconnected ones (X, website) stay manual: mark the row published and paste the link so the numbers can be entered later.'}
        </div>
      </div>

      {/* ── the tab's own side column — الربط بالمنصات ────────────────── */}
      <div>
        <div className="lbl" style={{ marginBottom: 11 }}>
          {isAr ? 'الربط بالمنصات' : 'Platform connections'}
        </div>
        {accounts.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
            {isAr ? 'لا حسابات معرّفة — تُدار من الإعدادات.' : 'No accounts defined — managed from Settings.'}
          </div>
        ) : (
          accounts.map((a) => (
            <div key={a.id} className="file" style={{ padding: '9px 10px' }}>
              <div
                className="cd2-acct-badge"
                style={{
                  background: PLATFORM_COLOR[a.platform] ?? 'var(--copper)',
                  color: a.platform === 'snapchat' ? '#3F3F3F' : 'var(--paper, #fff)',
                }}
              >
                {PLATFORM_INITIALS[a.platform] ?? a.platform.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="nm" style={{ fontSize: 12 }}>{platformLabel(a.platform)}</div>
                <div className="mt" style={{ fontSize: 10.5 }}>
                  {a.handle && <span className="ltr">{a.handle} · </span>}
                  {a.is_connected ? (isAr ? 'مربوط' : 'connected') : (isAr ? 'غير مربوط' : 'not connected')}
                </div>
              </div>
            </div>
          ))
        )}
        <div className="cd2-gold-note">
          {isAr ? (
            <>
              <b style={{ fontWeight: 700 }}>قبل ربط المنصة، «مجدول» تعني تذكيرًا</b> — يُنبّه النظام
              من ينشر عند الموعد، فينشر يدويًا ويؤكد. الشاشة صادقة في ذلك بدل الإيحاء بنشر تلقائي غير موجود.
            </>
          ) : (
            <>
              <b style={{ fontWeight: 700 }}>Until a platform is connected, “scheduled” means a reminder</b>{' '}
              — the system nudges whoever posts at the slot, they post manually and confirm. The screen is
              honest about that instead of implying an automation that does not exist.
            </>
          )}
        </div>
      </div>

      {(editing || adding) && (
        <PublicationModal
          publication={editing}
          accounts={accounts}
          available={available}
          finalAssets={finalAssets}
          isAr={isAr}
          busy={busy}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSave={(payload, picked) => void save(payload, picked)}
        />
      )}

      {/* ── s31 — the Publish Assistant bottom sheet (phone only) ───────── */}
      {isPhone && assistPub && (() => {
        const pub = assistPub as PubRow;
        const fileAsset = fileAssetOf(pub);
        const link = platformLink(pub.platform, pub.account_handle);
        const remainList = remainingTonight
          .map((p) => `${platformLabel(p.platform)} ${timeShort(p.scheduled_at, isAr)}`)
          .join(isAr ? '، ' : ', ');
        const check = (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
            <path d="M5 13l4 4L19 7" />
          </svg>
        );
        return (
          <>
            <button type="button" className="m3-scrim" aria-label={isAr ? 'إغلاق' : 'Close'} onClick={closeAssist} />
            <div className="m3-sheet" role="dialog" aria-modal="true">
              <div className="m3-grab" />
              {assistStage === 'steps' ? (
                <>
                  <div className="m3-sheet-title">
                    {isDue(pub)
                      ? isAr ? 'حان وقت النشر' : 'Time to post'
                      : isAr ? 'التالي للنشر' : 'Next up to post'}
                  </div>
                  <div className="m3-sheet-sub">
                    {platformLabel(pub.platform)}
                    {pub.account_handle && <> · <span className="ltr">{pub.account_handle}</span></>}
                    {pub.scheduled_at && <> · {schedLabel(pub)}</>}
                  </div>
                  <div className="m3-thumb">
                    {thumbFor(fileAsset) && <img src={thumbFor(fileAsset) ?? undefined} alt="" />}
                    <span className="lb">
                      {fileAsset ? (isAr ? 'معتمد' : 'Approved') : (isAr ? 'لا ملف معتمد' : 'No approved file')}
                    </span>
                  </div>

                  {/* ١ — the approved file row */}
                  <div className={`m3-step${assistFileDone ? ' did' : ' on2'}`}>
                    <span className="n6">{assistFileDone ? check : num(1, isAr)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="st">{isAr ? 'احفظي الملف في صورك' : 'Save the file to your photos'}</div>
                      <button
                        type="button"
                        className="m3-filebtn"
                        disabled={!urlFor(fileAsset)}
                        onClick={() => {
                          const href = urlFor(fileAsset);
                          if (!href) return;
                          window.open(href, '_blank', 'noopener');
                          setAssistFileDone(true);
                        }}
                      >
                        <span
                          className="th"
                          style={thumbFor(fileAsset) ? { backgroundImage: `url(${thumbFor(fileAsset)})` } : undefined}
                          aria-hidden
                        />
                        <span className="t">
                          <b>{fileAsset ? fileAsset.title : (isAr ? 'لا ملف معتمد بعد' : 'No approved file yet')}</b>
                          <span className="s">
                            {fileAsset
                              ? isAr ? 'معتمد — اضغطي للفتح والحفظ' : 'approved — tap to open and save'
                              : isAr ? 'الملفات المعتمدة وحدها تُنشر' : 'only approved files get published'}
                          </span>
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* ٢ — copy the caption */}
                  <div className={`m3-step${assistCopied ? ' did' : assistFileDone ? ' on2' : ''}`}>
                    <span className="n6">{assistCopied ? check : num(2, isAr)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="st">{isAr ? 'انسخي الكابشن' : 'Copy the caption'}</div>
                      {pub.caption ? (
                        <div className="m3-capbox">{pub.caption}</div>
                      ) : (
                        <div className="m3-capbox empty">
                          {isAr ? 'لم يُكتب كابشن لهذه المنصة' : 'No caption written for this platform'}
                        </div>
                      )}
                      <button
                        type="button"
                        className="m3-btn p sm2"
                        style={{ marginTop: 9 }}
                        disabled={!pub.caption}
                        onClick={() => void copyCaption(pub)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                          <rect x="9" y="9" width="12" height="12" rx="2" />
                          <path d="M5 15V5h10" />
                        </svg>
                        {isAr ? 'نسخ الكابشن' : 'Copy the caption'}
                      </button>
                    </div>
                  </div>

                  {/* ٣ — open the platform and post */}
                  <div className={`m3-step${assistCopied ? ' on2' : ''}`}>
                    <span className="n6">{num(3, isAr)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="st">
                        {isAr
                          ? `افتحي ${platformLabel(pub.platform)} وانشري`
                          : `Open ${platformLabel(pub.platform)} and post`}
                      </div>
                      <div className="sm">{isAr ? 'ثم عودي هنا بعد نشره' : 'then come back here once it is posted'}</div>
                    </div>
                  </div>

                  <div className="m3-sheet-actions">
                    <button type="button" className="m3-btn w0" onClick={closeAssist}>
                      {isAr ? 'تأجيل' : 'Postpone'}
                    </button>
                    <button
                      type="button"
                      className="m3-btn p"
                      onClick={() => {
                        if (link) window.open(link, '_blank', 'noopener');
                        setAssistStage('confirm');
                      }}
                    >
                      {link
                        ? isAr ? `افتحي ${platformLabel(pub.platform)}` : `Open ${platformLabel(pub.platform)}`
                        : isAr ? 'نُشر — للتأكيد' : 'Posted — confirm'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="m3-sheet-title">{isAr ? 'هل نُشر؟' : 'Was it posted?'}</div>
                  <div className="m3-sheet-sub">
                    {isAr ? 'على ' : 'On '}
                    {platformLabel(pub.platform)}
                    {pub.account_handle && <>{isAr ? '، ' : ', '}<span className="ltr">{pub.account_handle}</span></>}
                  </div>

                  <div className="m3-lbl">{isAr ? 'الصقي رابط المنشور' : 'Paste the post link'}</div>
                  <input
                    className="inp ltr"
                    dir="ltr"
                    inputMode="url"
                    placeholder={pub.platform === 'instagram' ? 'instagram.com/p/…' : 'https://…'}
                    value={assistUrl}
                    onChange={(e) => setAssistUrl(e.target.value)}
                  />
                  <div className="m3-note">
                    {isAr
                      ? 'اختياري، لكن بدونه لا يمكننا جمع أداء هذا المنشور لاحقًا.'
                      : 'Optional — but without it we cannot collect this post’s performance later.'}
                  </div>

                  <div className="m3-infobox">
                    {isAr ? (
                      <>
                        تعليمه كمنشور يُغلق هذا الصف وينقله إلى «منشور».{' '}
                        {remainingTonight.length > 0
                          ? <>والمتبقي الليلة: {remainList}.</>
                          : 'لا شيء آخر مجدول الليلة.'}
                      </>
                    ) : (
                      <>
                        Marking it published closes this row and moves it to “published”.{' '}
                        {remainingTonight.length > 0
                          ? <>Still scheduled tonight: {remainList}.</>
                          : 'Nothing else is scheduled tonight.'}
                      </>
                    )}
                  </div>

                  <div className="m3-sheet-actions">
                    <button type="button" className="m3-btn w0" onClick={closeAssist} disabled={assistBusy}>
                      {isAr ? 'ليس بعد' : 'Not yet'}
                    </button>
                    <button type="button" className="m3-btn g" onClick={() => void markPublished()} disabled={assistBusy}>
                      {assistBusy
                        ? isAr ? 'جارٍ الحفظ…' : 'Saving…'
                        : isAr ? 'تعليمه كمنشور' : 'Mark it published'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}

function PublicationModal({
  publication, accounts, available, finalAssets, isAr, busy, onClose, onSave,
}: {
  publication: MosPublication | null;
  accounts: MosAccount[];
  available: string[];
  /** ONLY assets linked to this item with role 'final' — the band-4 rule. */
  finalAssets: MosAsset[];
  isAr: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>, pickedAsset: MosAsset | null) => void;
}) {
  const pubRow = publication as PubRow | null;
  const [platform, setPlatform] = useState(publication?.platform ?? available[0] ?? 'instagram');
  const [accountId, setAccountId] = useState(publication?.account_id ?? '');
  const [status, setStatus] = useState(publication?.status ?? 'draft');
  const [when, setWhen] = useState(isoDateTimeLocal(publication?.scheduled_at));
  const [caption, setCaption] = useState(publication?.caption ?? '');
  const [url, setUrl] = useState(publication?.external_url ?? '');
  const [assetId, setAssetId] = useState(
    // Prefer the durable asset link; fall back to the legacy file_id match for
    // publications saved before the switch.
    () => pubRow?.asset_id
      ?? finalAssets.find((a) => a.file_id && a.file_id === pubRow?.file_id)?.id
      ?? '',
  );

  const platformAccounts = accounts.filter((a) => a.platform === platform);
  const picked = finalAssets.find((a) => a.id === assetId) ?? null;

  return (
    <Modal
      title={publication
        ? isAr ? 'تعديل النشر' : 'Edit publication'
        : isAr ? 'إضافة نشر' : 'Add a publication'}
      sub={isAr
        ? 'كل منصة صفّ مستقل — كابشن وتوقيت ونسخة ونتيجة خاصة بها.'
        : 'Each platform is its own row — its own caption, timing, file and result.'}
      onClose={onClose}
      footer={
        <>
          <span className="note">
            {isAr
              ? '«منشور» يسجّل الوقت ومَن نشر تلقائيًا.'
              : 'Marking published stamps the time and who posted it.'}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-p"
            disabled={busy}
            onClick={() => onSave({
              id: publication?.id,
              platform,
              account_id: accountId || null,
              status,
              scheduled_at: when ? new Date(when).toISOString() : null,
              caption: caption || null,
              external_url: url || null,
              asset_id: picked?.id ?? null,
              file_id: picked?.file_id ?? null,
            }, picked)}
          >
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المنصة' : 'Platform'}>
          <select
            className="inp"
            value={platform}
            disabled={Boolean(publication)}
            onChange={(e) => { setPlatform(e.target.value); setAccountId(''); }}
          >
            {(publication ? [publication.platform] : available).map((p) => (
              <option key={p} value={p}>
                {(isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p}
              </option>
            ))}
          </select>
        </Field>
        <Field label={isAr ? 'الحساب' : 'Account'}>
          <select className="inp" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{isAr ? 'بدون تحديد' : 'Not specified'}</option>
            {platformAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.handle ?? (isAr ? a.label_ar : a.label_en)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/* The band-4 rule, enforced: the picker lists ONLY approved files. */}
      <Field
        label={isAr ? 'الملف المستخدم' : 'File used'}
        hint={isAr ? 'المعتمد فقط' : 'approved files only'}
      >
        {finalAssets.length === 0 ? (
          <div className="inp" style={{ color: 'var(--mute)', fontSize: 12 }}>
            {isAr
              ? 'لا شيء معتمد بعد — الملفات المعتمدة وحدها يمكن ربطها بعملية نشر.'
              : 'Nothing approved yet — only approved files can be attached to a publication.'}
          </div>
        ) : (
          <select className="inp" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">{isAr ? 'بدون تحديد' : 'Not specified'}</option>
            {finalAssets.map((a) => (
              <option key={a.id} value={a.id}>{a.title}</option>
            ))}
          </select>
        )}
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'الحالة' : 'Status'}>
          <select
            className="inp"
            value={status}
            onChange={(e) => setStatus(e.target.value as MosPublication['status'])}
          >
            {(['draft', 'scheduled', 'published', 'cancelled'] as const).map((s) => (
              <option key={s} value={s}>
                {isAr ? PUB_STATUS_LABELS[s]?.ar : PUB_STATUS_LABELS[s]?.en}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={isAr ? 'التوقيت' : 'When'}
          hint={status === 'scheduled' ? (isAr ? 'إلزامي للمجدول' : 'required to schedule') : undefined}
        >
          <input type="datetime-local" className="inp" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      </div>

      <Field label={isAr ? 'الكابشن' : 'Caption'} hint={isAr ? 'خاص بهذه المنصة' : 'for this platform only'}>
        <textarea className="inp" rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} />
      </Field>

      <Field label={isAr ? 'رابط المنشور' : 'Post link'} hint={isAr ? 'بعد النشر' : 'after posting'}>
        <input className="inp ltr" value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" />
      </Field>
    </Modal>
  );
}
