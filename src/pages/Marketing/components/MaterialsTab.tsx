/**
 * Material and files — design screen 09, rebuilt as the FOUR production bands.
 *
 * The bands are the production order: what came off the camera, what is being
 * worked on, what went out for review, and what got approved. Versions
 * accumulate and are never replaced; every review version keeps the note that
 * sent it back. «الملفات لا تتحرك» — nothing lives in a folder, everything
 * lives in a state.
 *
 * ROLE → BAND MAPPING (stated per the build spec):
 *   band 1 «المواد الأصلية»    = asset_links role 'source'  — library rows in.
 *   band 2 «ملفات العمل»       = asset_links role 'reference' — the working
 *                                 files (project files, VO takes, references).
 *   band 3 «نسخ المراجعة»      = mos_content_versions rows — NOT asset links.
 *   band 4 «التصميم النهائي»    = the TWO design slots (2026-09-10):
 *                                 asset_links role 'final_square'  — 1:1, the
 *                                 Instagram / Facebook feed; and 'final_vertical'
 *                                 — 9:16, stories, reels and WhatsApp status.
 *                                 The designer uploads exactly these two files
 *                                 (image or video); the manager's approval
 *                                 then hands them to the Meta ad automation.
 *                                 Legacy items may still carry one plain
 *                                 'final' link. Only final* links are offered
 *                                 in the Publishing tab's file picker.
 *
 * Band 1 also renders the MISSING shots: scenes with footage_status='missing'
 * appear as dashed rows carrying «إسناد تصوير» (the existing shoot-assignment
 * flow), because a shot the script needs and nobody filmed is a ROW, not an
 * absence.
 */
import { useCallback, useEffect, useRef, useState, type SVGProps } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  ASSET_KIND_LABELS, ASSET_SOURCE_LABELS, MosAsset, MosAssetLink, MosContentVersion,
  MosScene, MosShootItem, MosShootRequest, RolePerson,
  fetchAssets, fetchContentDetail, fetchContentVersions, fetchShoots,
  linkAsset, linkAssetFromFile, saveAsset, saveShoot, setApprovalAsset, unlinkAsset,
} from '@/lib/marketingOS/client';
import { listDocumentTypes } from '@/lib/files/library';
import type { FileDocumentTypeRow, FileRow } from '@/types/files';
import PostUploadModal from '@/pages/Files/library/PostUploadModal';
import FilePickerModal from '@/pages/Files/library/FilePickerModal';
import { formatBytes, heicToJpeg, isHeic, kindFromFile } from '../lib/upload';

/** The two design slots every creative ships with. */
type DesignSlot = 'square' | 'vertical';
const SLOT_ROLE: Record<DesignSlot, 'final_square' | 'final_vertical'> = { square: 'final_square', vertical: 'final_vertical' };
const SLOT_META: Record<DesignSlot, { ar: string; en: string; ratio: string; hintAr: string; hintEn: string }> = {
  square:   { ar: 'التصميم المربّع', en: 'Square design',   ratio: '1:1',  hintAr: 'فيد إنستقرام وفيسبوك',            hintEn: 'Instagram / Facebook feed' },
  vertical: { ar: 'التصميم الطولي',  en: 'Vertical design', ratio: '9:16', hintAr: 'ستوري وريلز وحالة واتساب',        hintEn: 'Stories, reels and WhatsApp status' },
};
import { assetErrorText, canonicalAssetFields, uploadCanonicalAsset } from '../lib/canonicalUpload';
import { useAssetUrls } from '../lib/assetUrls';
import { useWorkspace } from '../MarketingWorkspace';
import { Field, LoadError, Modal, Skeleton } from './kit';
import { IconLibrary, IconShoot, IconTrash } from './icons';
import { dayName, num, shortDate } from '../lib/format';
import '../styles/cd2.css';


/**
 * «سحب من المكتبة» — browse the unified FILES library and attach a file as
 * content material. The file is wrapped as a mos_assets material server-side
 * (approval / publishing / role bands untouched); the CONTENT record is never
 * touched. Debounced search over `business_files_search`.
 */
function FilesMaterialPicker({
  isAr, onClose, onLinked, linkFile,
}: {
  isAr: boolean;
  onClose: () => void;
  onLinked: (res: { links: MosAssetLink[]; asset: MosAsset }) => void;
  linkFile: (fileId: string, role: string) => Promise<{ links: MosAssetLink[]; asset: MosAsset }>;
}) {
  const addToast = useAppStore((s) => s.addToast);
  // The ONE shared Files picker (search + real library cards + upload), so
  // "pull from the library" looks exactly like the library. A picked (or newly
  // uploaded) file links as source material «المواد الأصلية» — the common band;
  // it can be moved to reference/final afterward. Content record untouched.
  const pick = async (fileId: string): Promise<void> => {
    try {
      onLinked(await linkFile(fileId, 'source'));
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <FilePickerModal
      open
      onClose={onClose}
      onPick={(f) => { void pick(f.id); }}
      title={isAr ? 'سحب من مكتبة الملفات' : 'Pull from the Files library'}
      sub={isAr
        ? 'اختر ملفًا أو ارفع جديدًا — يُربط كمادة أصلية، وسجل المحتوى لا يتغيّر.'
        : 'Pick or upload a file — it links as source material and the content record is untouched.'}
    />
  );
}

/** The document glyph for version rows — drawn locally; icons.tsx is not ours. */
const IconDoc = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden {...p}>
    <path d="M4 4h13l3 3v13H4z" />
    <path d="M8 12h8M8 16h5" />
  </svg>
);
const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden {...p}>
    <path d="M12 8v5M12 16.5v.5" />
    <circle cx="12" cy="12" r="9" />
  </svg>
);

/** «المشهد ٣» from an asset's tags — `scene:3` / `مشهد 3`. Absent tag = no chip. */
function sceneTagOf(asset: MosAsset): number | null {
  for (const t of asset.tags) {
    const m = /^(?:scene[:\s-]?|مشهد\s?)(\d+)$/i.exec(t.trim());
    if (m) return Number(m[1]);
  }
  return null;
}

export default function MaterialsTab({
  contentId, projectId, canEdit, isAr, onCount, scenes: scenesProp, contentTitle,
  approvalAssetId: approvalAssetIdProp,
}: {
  contentId: string;
  projectId: string | null;
  canEdit: boolean;
  isAr: boolean;
  onCount: (n: number) => void;
  /**
   * The item's scenes — drives the missing-shot rows and the coverage card.
   * Optional for backward compatibility: when absent, the tab fetches the
   * content detail itself (one extra call on open).
   */
  scenes?: MosScene[];
  /** Names the shoot request raised from a missing row. Optional; ref fallback. */
  contentTitle?: string | null;
  /** The material currently submitted for approval (mos_content.approval_asset_id). */
  approvalAssetId?: string | null;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const { people, can } = useWorkspace();
  /** Which material is submitted for approval — the manager's approval promotes
   *  it to the approved band. Seeded from the item; updated on toggle. */
  const [approvalAssetId, setApprovalAssetId] = useState<string | null>(approvalAssetIdProp ?? null);
  useEffect(() => { setApprovalAssetId(approvalAssetIdProp ?? null); }, [approvalAssetIdProp]);
  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [links, setLinks] = useState<MosAssetLink[]>([]);
  const [versions, setVersions] = useState<MosContentVersion[]>([]);
  const [fetchedScenes, setFetchedScenes] = useState<MosScene[]>([]);
  const [shootData, setShootData] = useState<{ requests: MosShootRequest[]; items: MosShootItem[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const scenes = scenesProp ?? fetchedScenes;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [assetRes, versionRes, detailRes] = await Promise.all([
        fetchAssets(),
        fetchContentVersions(contentId),
        // Scenes ride the prop when the page passes them; otherwise one
        // detail fetch keeps the missing-shot band honest.
        scenesProp ? Promise.resolve(null) : fetchContentDetail(contentId),
      ]);
      setAssets(assetRes.assets);
      setLinks(assetRes.links);
      setVersions(versionRes.versions);
      if (detailRes) setFetchedScenes(detailRes.scenes);
      onCount(assetRes.links.filter((l) => l.content_id === contentId).length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [contentId, onCount, scenesProp]);

  useEffect(() => { void load(); }, [load]);

  // Shoot schedule for the missing rows («تُصوَّر الخميس ٣٠ يوليو»). Non-fatal:
  // a failure hides the schedule line and is logged, never swallowed.
  useEffect(() => {
    let alive = true;
    fetchShoots()
      .then((res) => {
        if (!alive) return;
        setShootData({ requests: res.requests, items: res.items });
      })
      .catch((e: unknown) => { console.error('[marketing] shoot schedule unavailable', e); });
    return () => { alive = false; };
  }, [contentId]);

  const mine = links.filter((l) => l.content_id === contentId);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  // Legacy assets resolve to their stored public URL; file-backed ones sign.
  const { urlFor, thumbFor, error: urlError, retry: retryUrls } = useAssetUrls(assets);
  const missingScenes = scenes.filter((s) => s.footage_status === 'missing');

  /* Coverage buckets — have/template are covered, to_make is in flight,
     missing is nobody's yet. Same trichotomy as the mocked meter. */
  const covered = scenes.filter((s) => s.footage_status === 'have' || s.footage_status === 'template').length;
  const toMake = scenes.filter((s) => s.footage_status === 'to_make').length;
  const missing = missingScenes.length;
  const totalScenes = scenes.length;

  const canRaiseShoot = canEdit || can('assign');

  const nameOf = (userId: string | null | undefined): string | null => {
    if (!userId) return null;
    const u: RolePerson | undefined = people.find((x) => x.user_id === userId);
    if (!u) return null;
    return (isAr ? u.name_ar : u.name_en) ?? u.name_en ?? u.name_ar;
  };

  /** The schedule sentence for a missing scene, from the shoot queue. */
  const scheduleOf = (scene: MosScene): string => {
    const base = isAr
      ? `مطلوبة للمشهد ${num(scene.position, true)}`
      : `Needed for scene ${scene.position}`;
    if (!shootData) return base;
    const item = shootData.items.find((i) => i.scene_id === scene.id);
    const req = item ? shootData.requests.find((r) => r.id === item.request_id) : undefined;
    if (!req || req.status === 'cancelled') {
      return `${base} · ${isAr ? 'غير مجدولة' : 'unscheduled'}`;
    }
    if (req.scheduled_at) {
      const when = `${dayName(req.scheduled_at, isAr)} ${shortDate(req.scheduled_at, isAr)}`;
      return isAr ? `${base} · تُصوَّر ${when}` : `${base} · shooting ${when}`;
    }
    return `${base} · ${isAr ? 'طلب تصوير قائم' : 'shoot requested'}`;
  };

  const unlink = async (assetId: string): Promise<void> => {
    setBusy(true);
    try {
      const res = await unlinkAsset(assetId, contentId);
      setLinks((cur) => [...cur.filter((l) => l.content_id !== contentId), ...res.links]);
      onCount(res.links.length);
      // The server clears approval_asset_id when the submitted file is unlinked;
      // mirror it locally so the toggle state doesn't lag.
      if (approvalAssetId === assetId) setApprovalAssetId(null);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Move an attached file between «المواد الأصلية» (source) and «ملفات العمل»
   *  (reference) in place — the `asset_link` upsert re-roles the same row, so no
   *  unlink-and-re-pull. Never touches the approval band (final is earned via the
   *  manager's approval only). */
  const moveBand = async (assetId: string, role: 'source' | 'reference'): Promise<void> => {
    setBusy(true);
    try {
      const res = await linkAsset(assetId, contentId, role);
      setLinks((cur) => [...cur.filter((l) => l.content_id !== contentId), ...res.links]);
      onCount(res.links.length);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ── the two design slots ─────────────────────────────────────────── */

  const slotLinkOf = (slot: DesignSlot): MosAssetLink | null =>
    mine.find((l) => l.role === SLOT_ROLE[slot]) ?? null;

  /** approval_asset_id follows the slots: the square (feed) design, else the
   *  vertical — so the preview popup's hero and the approval promote keep
   *  pointing at a real design without anyone marking anything by hand. */
  const syncApprovalAsset = async (nextLinks: MosAssetLink[]): Promise<void> => {
    const ours = nextLinks.filter((l) => l.content_id === contentId);
    const want = ours.find((l) => l.role === 'final_square')?.asset_id
      ?? ours.find((l) => l.role === 'final_vertical')?.asset_id
      ?? null;
    if (want === approvalAssetId) return;
    const prev = approvalAssetId;
    setApprovalAssetId(want);
    try {
      await setApprovalAsset(contentId, want);
    } catch (e) {
      setApprovalAssetId(prev);
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const attachToSlot = async (assetId: string, slot: DesignSlot): Promise<void> => {
    setBusy(true);
    try {
      // One file per slot: a previous occupant becomes a plain source link so
      // nothing is lost, and the new file takes the slot.
      const prevOccupant = slotLinkOf(slot);
      if (prevOccupant && prevOccupant.asset_id !== assetId) await linkAsset(prevOccupant.asset_id, contentId, 'source');
      const res = await linkAsset(assetId, contentId, SLOT_ROLE[slot]);
      const next = [...links.filter((l) => l.content_id !== contentId), ...res.links];
      setLinks(next);
      onCount(res.links.length);
      await syncApprovalAsset(next);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const [slotUploading, setSlotUploading] = useState<{ slot: DesignSlot; frac: number } | null>(null);
  const [slotPicking, setSlotPicking] = useState<DesignSlot | null>(null);
  const slotInputs = { square: useRef<HTMLInputElement>(null), vertical: useRef<HTMLInputElement>(null) };

  /** Upload one file straight into a slot: canonical Files intake → material row → slot link. */
  const uploadToSlot = async (file: File, slot: DesignSlot): Promise<void> => {
    setBusy(true);
    setSlotUploading({ slot, frac: 0 });
    try {
      let toSend = file;
      if (isHeic(file)) {
        try { toSend = await heicToJpeg(file); } catch (convErr) { console.error('[marketing] HEIC conversion failed', file.name, convErr); }
      }
      const fileRow = await uploadCanonicalAsset(toSend, {
        onProgress: (frac) => setSlotUploading({ slot, frac }),
      });
      const kind = kindFromFile(toSend);
      const res = await saveAsset({
        title: `${contentTitle ?? ''} — ${isAr ? SLOT_META[slot].ar : SLOT_META[slot].en}`.replace(/^ — /, ''),
        kind: kind === 'photo' || kind === 'video' ? kind : 'design',
        source: 'design',
        project_id: projectId,
        shot_on: null,
        tags: [slot],
        aspect_ratio: SLOT_META[slot].ratio,
        ...canonicalAssetFields(fileRow),
        original_name: file.name,
      });
      setAssets((cur) => (cur.some((a) => a.id === res.asset.id) ? cur : [res.asset, ...cur]));
      await attachToSlot(res.asset.id, slot);
    } catch (e) {
      console.error('[marketing] slot upload failed', file.name, e);
      addToast(assetErrorText(e, isAr), 'error');
    } finally {
      setSlotUploading(null);
      setBusy(false);
    }
  };

  const clearSlot = async (slot: DesignSlot): Promise<void> => {
    const l = slotLinkOf(slot);
    if (!l) return;
    setBusy(true);
    try {
      const res = await unlinkAsset(l.asset_id, contentId);
      const next = [...links.filter((x) => x.content_id !== contentId), ...res.links];
      setLinks(next);
      onCount(res.links.length);
      if (approvalAssetId === l.asset_id) setApprovalAssetId(null);
      await syncApprovalAsset(next);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** «إسناد تصوير» — the existing shoot-assignment flow, for ONE scene. */
  const assignShoot = async (scene: MosScene): Promise<void> => {
    setBusy(true);
    try {
      const what = scene.visual ?? contentTitle ?? '';
      await saveShoot(
        {
          title: isAr ? `تصوير — ${what}`.trim() : `Shoot — ${what}`.trim(),
          project_id: projectId,
          status: 'requested',
        },
        [scene.id],
      );
      addToast(
        isAr ? 'أُنشئ طلب تصوير لهذه اللقطة.' : 'Raised a shoot request for this shot.',
        'success',
      );
      // Refresh the schedule line so the row stops claiming «غير مجدولة».
      const res = await fetchShoots();
      setShootData({ requests: res.requests, items: res.items });
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading && assets.length === 0 && versions.length === 0) return <Skeleton rows={5} />;

  const sourceRows = mine.filter((l) => l.role === 'source');
  const workingRows = mine.filter((l) => l.role === 'reference');
  // Legacy single approved file (pre-slot items) — offered for placing into a slot.
  const legacyFinalRows = mine.filter((l) => l.role === 'final');

  /** One linked-asset row. `approvable` rows (source + working files) carry the
   *  «submit for approval» toggle; the approved band never does. */
  const assetRow = (l: MosAssetLink, approvable = false) => {
    const a = assetById.get(l.asset_id);
    if (!a) return null;
    const usedElsewhere = links.filter(
      (x) => x.asset_id === a.id && x.content_id !== contentId,
    ).length;
    const scene = sceneTagOf(a);
    return (
      <div key={l.asset_id} className="file">
        <div className="th">
          {thumbFor(a) ? <img src={thumbFor(a) ?? undefined} alt="" /> : <IconLibrary />}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="nm">{a.title}</div>
          <div className="mt">
            <span className="ltr">{a.ref}</span> ·{' '}
            {(isAr ? ASSET_KIND_LABELS[a.kind]?.ar : ASSET_KIND_LABELS[a.kind]?.en) ?? a.kind}
            {' · '}
            {(isAr ? ASSET_SOURCE_LABELS[a.source]?.ar : ASSET_SOURCE_LABELS[a.source]?.en) ?? a.source}
            {a.shot_on && <> · {shortDate(a.shot_on, isAr)}</>}
            {usedElsewhere > 0 && (
              <>
                {' · '}
                {isAr
                  ? `مستخدمة في ${num(usedElsewhere, true)} ${usedElsewhere === 1 ? 'عنصر آخر' : 'عناصر أخرى'}`
                  : `used in ${usedElsewhere} other item${usedElsewhere === 1 ? '' : 's'}`}
              </>
            )}
          </div>
        </div>
        <div className="rt">
          {scene !== null && (
            <span className="tag">{isAr ? `المشهد ${num(scene, true)}` : `Scene ${scene}`}</span>
          )}
          {urlFor(a) && (
            <a className="btn btn-d btn-sm" href={urlFor(a) ?? undefined} target="_blank" rel="noreferrer">
              {isAr ? 'معاينة' : 'Preview'}
            </a>
          )}
          {approvable && canEdit && (l.role === 'source' || l.role === 'reference') && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void moveBand(a.id, l.role === 'source' ? 'reference' : 'source')}
              title={isAr
                ? 'انقل الملف بين «المواد الأصلية» و«ملفات العمل» — لا يمس الاعتماد.'
                : 'Move the file between Source material and Working files — approval is untouched.'}
            >
              {l.role === 'source'
                ? (isAr ? 'نقل إلى ملفات العمل' : 'Move to working files')
                : (isAr ? 'نقل إلى المواد الأصلية' : 'Move to source material')}
            </button>
          )}
          {approvable && canEdit && (
            <>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void attachToSlot(a.id, 'square')}
                title={isAr ? 'استخدم هذا الملف كالتصميم المربّع (1:1)' : 'Use this file as the square design (1:1)'}>
                {isAr ? 'كمربّع' : 'As square'}
              </button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void attachToSlot(a.id, 'vertical')}
                title={isAr ? 'استخدم هذا الملف كالتصميم الطولي (9:16)' : 'Use this file as the vertical design (9:16)'}>
                {isAr ? 'كطولي' : 'As vertical'}
              </button>
            </>
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
  };

  return (
    <div className="cd2-split">
      <div style={{ display: 'grid', gap: 20, minWidth: 0 }}>
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {!error && urlError && (
          <div className="notice bad" role="alert">
            <div style={{ overflowWrap: 'anywhere' }}>
              {isAr
                ? 'تعذّر تحميل بعض المعاينات — قد تظهر أيقونة بدل الصورة.'
                : 'Some previews could not be loaded — an icon may show instead of the image.'}
            </div>
            <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={retryUrls}>
              {isAr ? 'إعادة المحاولة' : 'Try again'}
            </button>
          </div>
        )}

        {/* ── the two design slots — what the manager approves and the ad runs ── */}
        <div>
          <div className="cd2-band-h">
            <div className="lbl">
              {isAr ? 'التصميم النهائي · ملفان: مربّع وطولي' : 'Final design · two files: square and vertical'}
            </div>
            <span className="tag tag-t">
              {isAr
                ? `${num((['square', 'vertical'] as DesignSlot[]).filter((k) => slotLinkOf(k)).length, true)} من ٢`
                : `${(['square', 'vertical'] as DesignSlot[]).filter((k) => slotLinkOf(k)).length} of 2`}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            {(['square', 'vertical'] as DesignSlot[]).map((slot) => {
              const l = slotLinkOf(slot);
              const a = l ? assetById.get(l.asset_id) ?? null : null;
              const up = slotUploading?.slot === slot ? slotUploading : null;
              const meta = SLOT_META[slot];
              return (
                <div key={slot} className="card" style={{ padding: 12, display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <b>{isAr ? meta.ar : meta.en}</b>
                    <span className="tag ltr">{meta.ratio}</span>
                    <span style={{ fontSize: 12, color: 'var(--mute)' }}>{isAr ? meta.hintAr : meta.hintEn}</span>
                  </div>
                  <div
                    style={{
                      aspectRatio: slot === 'square' ? '1 / 1' : '9 / 16',
                      maxHeight: 260, borderRadius: 10, background: 'var(--line)', overflow: 'hidden',
                      display: 'grid', placeItems: 'center', justifySelf: 'center', width: slot === 'square' ? 200 : 146,
                    }}
                  >
                    {a && a.kind === 'video' && urlFor(a)
                      ? <video src={urlFor(a) ?? undefined} controls style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : a && thumbFor(a)
                        ? <img src={thumbFor(a) ?? undefined} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : a
                          ? <IconLibrary />
                          : <span style={{ fontSize: 12, color: 'var(--mute)', textAlign: 'center', padding: 8 }}>
                              {up
                                ? `${isAr ? 'جارٍ الرفع' : 'Uploading'} ${Math.round(up.frac * 100)}%`
                                : isAr ? 'لا ملف بعد' : 'No file yet'}
                            </span>}
                  </div>
                  {a && (
                    <div className="mt" style={{ textAlign: 'center', overflowWrap: 'anywhere' }}>
                      {a.title}{a.size_bytes ? ` · ${formatBytes(a.size_bytes, isAr)}` : ''}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {a && urlFor(a) && (
                      <a className="btn btn-d btn-sm" href={urlFor(a) ?? undefined} target="_blank" rel="noreferrer">
                        {isAr ? 'معاينة' : 'Preview'}
                      </a>
                    )}
                    {canEdit && (
                      <>
                        <input
                          ref={slotInputs[slot]}
                          type="file"
                          accept="image/*,video/*"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (f) void uploadToSlot(f, slot);
                          }}
                        />
                        <button type="button" className={`btn btn-sm${a ? '' : ' btn-p'}`} disabled={busy} onClick={() => slotInputs[slot].current?.click()}>
                          {a ? (isAr ? 'استبدال' : 'Replace') : (isAr ? 'رفع الملف' : 'Upload')}
                        </button>
                        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setSlotPicking(slot)}>
                          <IconLibrary />
                          {isAr ? 'من المكتبة' : 'From library'}
                        </button>
                        {a && (
                          <button type="button" className="btn btn-d btn-sm" disabled={busy} onClick={() => void clearSlot(slot)} aria-label={isAr ? 'إزالة' : 'Remove'}>
                            <IconTrash />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {legacyFinalRows.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="mt" style={{ marginBottom: 6 }}>
                {isAr ? 'نسخة معتمدة سابقة — ضعها في أحد الخانتين:' : 'Previously approved file — place it in a slot:'}
              </div>
              {legacyFinalRows.map((l) => assetRow(l, true))}
            </div>
          )}
          <div className="cd2-side-note" style={{ marginTop: 8 }}>
            {isAr
              ? 'عند اعتماد المدير يُرفع المربّع لفيد إنستقرام والطولي للستوري والريلز وحالة واتساب، ويُنشأ الإعلان في ميتا تلقائيًا.'
              : 'On the manager’s approval the square goes to the Instagram feed and the vertical to stories, reels and WhatsApp status, and the Meta ad is created automatically.'}
          </div>
        </div>

        {/* ── band 1 — المواد الأصلية + اللقطات الناقصة ─────────────── */}
        <div>
          <div className="cd2-band-h">
            <div className="lbl">
              {isAr ? 'المواد الأصلية · من المكتبة، وليست نسخًا' : 'Source material · library rows, not copies'}
            </div>
            <span className="tag tag-t">
              {isAr
                ? `${num(sourceRows.length, true)} مرتبطة${missing > 0 ? ` · ${num(missing, true)} لقطات ناقصة` : ''}`
                : `${sourceRows.length} linked${missing > 0 ? ` · ${missing} shots missing` : ''}`}
            </span>
          </div>
          {sourceRows.length === 0 && missing === 0 ? (
            <div className="drop">
              {isAr
                ? 'لا مواد مرتبطة بعد. اربط من المكتبة أو أضف مادة جديدة.'
                : 'Nothing linked yet. Link from the library or add new material.'}
            </div>
          ) : (
            <>
              {sourceRows.map((l) => assetRow(l, true))}
              {/* اللقطة الناقصة صفٌّ، لا غياب. */}
              {missingScenes.map((s) => (
                <div key={s.id} className="file cd2-missing">
                  <div className="th"><IconAlert /></div>
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">
                      {s.visual ?? (isAr ? 'لقطة بلا وصف' : 'Undescribed shot')}
                    </div>
                    <div className="mt">{scheduleOf(s)}</div>
                  </div>
                  <div className="rt">
                    <span className="tag">
                      {isAr ? `المشهد ${num(s.position, true)}` : `Scene ${s.position}`}
                    </span>
                    {canRaiseShoot && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void assignShoot(s)}
                      >
                        <IconShoot />
                        {isAr ? 'إسناد تصوير' : 'Assign a shoot'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* ── band 2 — ملفات العمل (role 'reference') ────────────────── */}
        <div>
          <div className="lbl" style={{ marginBottom: 9 }}>
            {isAr ? 'ملفات العمل' : 'Working files'}
          </div>
          {workingRows.length === 0 ? (
            <div className="drop">
              {isAr
                ? 'لا ملفات عمل بعد — مشروع المونتاج والتعليق الصوتي وأمثالها تُربط هنا.'
                : 'No working files yet — the edit project, voice-over takes and the like get linked here.'}
            </div>
          ) : (
            workingRows.map((l) => assetRow(l, true))
          )}
        </div>

        {/* ── band 3 — نسخ المراجعة (content_versions, notes attached) ── */}
        <div>
          <div className="lbl" style={{ marginBottom: 9 }}>
            {isAr ? 'نسخ المراجعة · كل نسخة تحتفظ بملاحظتها' : 'Review versions · each keeps its note'}
          </div>
          {versions.length === 0 ? (
            <div className="drop">
              {isAr
                ? 'لا نسخ بعد — تُحفظ نسخة عند كل إرسال للمراجعة.'
                : 'No versions yet — one is frozen on every submit for review.'}
            </div>
          ) : (
            versions.map((v, i) => {
              const latest = i === versions.length - 1;
              const submitter = nameOf(v.submitted_by_user_id);
              const tone = v.rejected_note
                ? { pill: 'p-late', label: isAr ? 'طُلبت تعديلات' : 'Changes requested' }
                : latest
                  ? { pill: 'p-wait', label: isAr ? 'قيد المراجعة' : 'In review' }
                  : { pill: 'p-go', label: isAr ? 'أُرسلت' : 'Submitted' };
              return (
                <div key={v.id} className={`file${!v.rejected_note && latest ? ' cd2-inreview' : ''}`}>
                  <div className="th" style={v.rejected_note ? { background: 'var(--sand-2)' } : undefined}>
                    <IconDoc />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">
                      {isAr ? `النسخة ${num(v.round, true)}` : `Version ${v.round}`}
                    </div>
                    <div className="mt">
                      {submitter && <>{submitter} · </>}
                      {shortDate(v.created_at, isAr)}
                      {v.rejected_note && <> · «{v.rejected_note}»</>}
                    </div>
                  </div>
                  <div className="rt">
                    <span className="ver ltr">v{v.round}</span>
                    <span className={`pill ${tone.pill}`}>{tone.label}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {canEdit && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => setPicking(true)}>
              <IconLibrary />
              {isAr ? 'سحب من المكتبة' : 'Pull from the library'}
            </button>
          </div>
        )}
      </div>

      {/* ── the tab's own side column — coverage + provenance ─────────── */}
      <div>
        <div className="lbl" style={{ marginBottom: 11 }}>
          {isAr ? 'تغطية اللقطات' : 'Shot coverage'}
        </div>
        <div className="card" style={{ padding: '13px 14px', marginBottom: 16 }}>
          {totalScenes === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
              {isAr
                ? 'لا مشاهد بعد — التغطية تُحسب من جدول المشاهد في تبويب المحتوى.'
                : 'No scenes yet — coverage is computed from the scene table on the Content tab.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                <span className="cd2-big">{num(covered, isAr)}</span>
                <span style={{ fontSize: 12, color: 'var(--mute)' }}>
                  {isAr
                    ? `من ${num(totalScenes, true)} لقطات لديها تصوير`
                    : `of ${totalScenes} shots have footage`}
                </span>
              </div>
              <div className="meter" style={{ marginTop: 9 }}>
                {covered > 0 && <i style={{ width: `${(covered / totalScenes) * 100}%`, background: 'var(--go)' }} />}
                {toMake > 0 && <i style={{ width: `${(toMake / totalScenes) * 100}%`, background: 'var(--gold)' }} />}
                {missing > 0 && <i style={{ width: `${(missing / totalScenes) * 100}%`, background: 'var(--late)' }} />}
              </div>
              <div className="cd2-cov-legend">
                <span><b style={{ color: 'var(--go)' }}>{num(covered, isAr)}</b> {isAr ? 'متوفرة' : 'have'}</span>
                <span><b style={{ color: 'var(--wait)' }}>{num(toMake, isAr)}</b> {isAr ? 'تُصنع' : 'to make'}</span>
                <span><b style={{ color: 'var(--late)' }}>{num(missing, isAr)}</b> {isAr ? 'ناقصة' : 'missing'}</span>
              </div>
              {missing + toMake > 0 && (
                <div className="cd2-side-note">
                  {isAr
                    ? 'لا يبدأ المونتاج قبل حسم كل مشهد. هذا ما يعطّل خطوة جمع المواد.'
                    : 'The edit does not start before every scene is settled. That is what blocks the gather-material step.'}
                </div>
              )}
            </>
          )}
        </div>
        <div className="lbl" style={{ marginBottom: 9 }}>
          {isAr ? 'من أين أتت' : 'Where it came from'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.85 }}>
          {isAr ? (
            <>
              المواد الأصلية <b>إشارات إلى صفوف في المكتبة</b>، وليست ملفات مرفوعة داخل هذا السجل.
              قصّ صورة لأجل هذا الفيديو يُنشئ نسخة جديدة على المادة — وكل محتوى آخر يستخدمها يبقى على الأصل.
            </>
          ) : (
            <>
              Source material is <b>a reference to a library row</b>, not a file uploaded into this
              record. Cropping a photo for this video creates a new version on the material — every
              other item using it stays on the original.
            </>
          )}
        </div>
      </div>

      {slotPicking && (
        <FilesMaterialPicker
          isAr={isAr}
          onClose={() => setSlotPicking(null)}
          onLinked={(res) => {
            setLinks(res.links);
            setAssets((cur) => (cur.some((a) => a.id === res.asset.id) ? cur : [res.asset, ...cur]));
            onCount(res.links.filter((l) => l.content_id === contentId).length);
            void syncApprovalAsset(res.links);
            setSlotPicking(null);
          }}
          linkFile={(fileId) => linkAssetFromFile(contentId, fileId, SLOT_ROLE[slotPicking])}
        />
      )}

      {picking && (
        <FilesMaterialPicker
          isAr={isAr}
          onClose={() => setPicking(false)}
          onLinked={(res) => {
            setLinks(res.links);
            setAssets((cur) => (cur.some((a) => a.id === res.asset.id) ? cur : [res.asset, ...cur]));
            onCount(res.links.filter((l) => l.content_id === contentId).length);
            setPicking(false);
          }}
          linkFile={(fileId, role) => linkAssetFromFile(contentId, fileId, role)}
        />
      )}

    </div>
  );
}

/** Per-file overrides of the shared batch fields, keyed by `name:size`. Only
 *  touched keys are present; the rest inherit the shared source/kind/date/tags. */
type AssetOverride = {
  title?: string;
  kind?: MosAsset['kind'];
  source?: MosAsset['source'];
  shotOn?: string;
  tags?: string[];
};

/** Screen 23 — upload and intake. Upload one or MORE files directly (browser →
 *  the marketing-assets bucket, the SAME engine as the intake queue). One
 *  material row per file; shared source/date/tags apply to the whole batch,
 *  and each file can override any of them via its own «تعديل» editor. */
export function NewAssetModal({
  isAr, projectId, onClose, onCreated,
}: {
  isAr: boolean;
  projectId: string | null;
  onClose: () => void;
  /** All materials created in this batch — the caller links each as 'source'. */
  onCreated: (assets: MosAsset[]) => void | Promise<void>;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<MosAsset['kind']>('photo');
  const [source, setSource] = useState<MosAsset['source']>('shoot');
  const [shotOn, setShotOn] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  /** The files queued for upload — one material row is created per file. */
  const [files, setFiles] = useState<File[]>([]);
  /** Which file is uploading now + its 0..1 fraction + how many already done. */
  const [uploading, setUploading] = useState<{ index: number; frac: number; done: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Per-file overrides + which file's editor is open. Keyed by `name:size`. */
  const [overrides, setOverrides] = useState<Record<string, AssetOverride>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  // After upload, the SAME Files-library popup takes over (AI results,
  // classifications, link-to-record) — one upload experience everywhere.
  const [postUpload, setPostUpload] = useState<FileRow[]>([]);
  const [docTypes, setDocTypes] = useState<FileDocumentTypeRow[]>([]);
  useEffect(() => {
    let alive = true;
    listDocumentTypes().then((r) => { if (alive) setDocTypes(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const single = files.length === 1;
  const keyOf = (f: File): string => `${f.name}:${f.size}`;
  const sharedTags = tags.split(',').map((t) => t.trim()).filter(Boolean);
  const patchOverride = (key: string, patch: AssetOverride): void =>
    setOverrides((cur) => ({ ...cur, [key]: { ...cur[key], ...patch } }));
  const resetOverride = (key: string): void =>
    setOverrides((cur) => {
      if (!(key in cur)) return cur;
      const next = { ...cur };
      delete next[key];
      return next;
    });

  // Add files (click or drop), de-duped by name+size so a double-pick doesn't
  // create twins. Seeds kind (+ name, when it's the only file) from the first
  // file we ever add — same conventions as the intake queue.
  const addFiles = (list: FileList | File[] | null): void => {
    const incoming = Array.from(list ?? []);
    if (incoming.length === 0) return;
    const wasEmpty = files.length === 0;
    setFiles((cur) => {
      const seen = new Set(cur.map((f) => `${f.name}:${f.size}`));
      const merged = [...cur];
      for (const f of incoming) {
        const key = `${f.name}:${f.size}`;
        if (!seen.has(key)) { seen.add(key); merged.push(f); }
      }
      return merged;
    });
    if (wasEmpty && incoming[0]) {
      setKind(kindFromFile(incoming[0]));
      setTitle((cur) => (cur.trim() ? cur : incoming[0]!.name.replace(/\.[^.]+$/, '')));
    }
  };

  const removeFile = (idx: number): void => setFiles((cur) => cur.filter((_, i) => i !== idx));

  const submit = async (): Promise<void> => {
    if (files.length === 0) {
      addToast(isAr ? 'ارفع ملفًا واحدًا على الأقل.' : 'Add at least one file.', 'error');
      return;
    }
    setBusy(true);
    const created: MosAsset[] = [];
    const uploadedRows: FileRow[] = [];
    let failed = 0;
    try {
      for (let i = 0; i < files.length; i += 1) {
        const original = files[i];
        if (!original) continue;
        try {
          // HEIC (iPhone default) is converted first so browsers can render it;
          // a failed conversion falls back to the original — never a dropped file.
          let toSend = original;
          if (isHeic(original)) {
            try {
              toSend = await heicToJpeg(original);
            } catch (convErr) {
              console.error('[marketing] HEIC conversion failed', original.name, convErr);
            }
          }
          setUploading({ index: i, frac: 0, done: created.length });
          // Canonical intake: ONE object in the private wassel-files bucket +
          // ONE files row. Nothing is written to marketing-assets/mos/ any more.
          const fileRow = await uploadCanonicalAsset(toSend, {
            onProgress: (frac) =>
              setUploading((u) => (u ? { ...u, frac } : { index: i, frac, done: created.length })),
          });
          // A file's own override wins; otherwise the shared batch values.
          // Name: override, else the single-file name field, else the filename.
          // Kind: override, else the select for a single file, else auto-detected.
          const ov = overrides[keyOf(original)] ?? {};
          const derived = original.name.replace(/\.[^.]+$/, '');
          const fileTitle = ov.title?.trim() || (single ? (title.trim() || derived) : derived);
          const fileKind = ov.kind ?? (single ? kind : kindFromFile(toSend));
          const fileSource = ov.source ?? source;
          const fileShotOn = ov.shotOn ?? shotOn;
          const fileTags = ov.tags ?? sharedTags;
          const res = await saveAsset({
            title: fileTitle,
            kind: fileKind,
            source: fileSource,
            project_id: projectId,
            shot_on: fileShotOn || null,
            tags: fileTags,
            ...canonicalAssetFields(fileRow),
            original_name: original.name,
          });
          created.push(res.asset);
          uploadedRows.push(fileRow);
        } catch (e) {
          // One failed file must not sink the whole batch — surface it, keep going.
          // An unsupported format reports the specific reason and what to do,
          // in the reader's language, rather than a raw storage message.
          failed += 1;
          console.error('[marketing] material upload failed', original.name, e);
          addToast(assetErrorText(e, isAr), 'error');
        }
      }
      // Link + close only if at least one succeeded; otherwise keep the modal
      // open so the user can retry the failures.
      if (created.length > 0) {
        if (failed > 0) {
          addToast(
            isAr ? `أُضيفت ${created.length}، وتعذّر ${failed}.` : `${created.length} added, ${failed} failed.`,
            'info',
          );
        }
        await onCreated(created);
      }
      // Hand off to the shared Files popup for AI review + metadata + linking.
      // The add-material form is replaced by it (see the early return below);
      // dismissing it closes the whole flow.
      if (uploadedRows.length > 0) setPostUpload(uploadedRows);
    } finally {
      setUploading(null);
      setBusy(false);
    }
  };

  // Once files are up, the identical Files-library popup takes over — same AI,
  // same classifications, same link-to-record as every other upload in the app.
  if (postUpload.length > 0) {
    return (
      <PostUploadModal
        files={postUpload}
        types={docTypes}
        onDismiss={onClose}
        onApplied={onClose}
      />
    );
  }

  return (
    <Modal
      title={isAr ? 'مادة جديدة' : 'New material'}
      sub={isAr
        ? 'ارفع الملفات مباشرة — يمكنك اختيار أكثر من ملف. الوسوم هي ما يجعل المادة قابلة لإعادة الاستخدام لاحقًا.'
        : 'Upload files directly — you can choose more than one. The tags are what make them findable for reuse later.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy
              ? uploading
                ? (isAr
                    ? `جارٍ الرفع… ${uploading.done + 1}/${files.length} · ${Math.round(uploading.frac * 100)}%`
                    : `Uploading… ${uploading.done + 1}/${files.length} · ${Math.round(uploading.frac * 100)}%`)
                : (isAr ? 'جارٍ الحفظ…' : 'Saving…')
              : files.length > 1
                ? (isAr ? `إضافة ${files.length}` : `Add ${files.length}`)
                : (isAr ? 'إضافة' : 'Add')}
          </button>
        </>
      }
    >
      {/* Name applies only to a single file; a batch names each from its filename. */}
      {files.length <= 1 && (
        <Field label={isAr ? 'الاسم' : 'Name'}>
          <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
      )}

      {/* Upload zone — NOT wrapped in a <label> (Field) so the button/input
          don't trigger label-click forwarding. Drag-drop or click, multiple. */}
      <div style={{ marginBottom: 13 }}>
        <span className="lbl">
          {isAr ? 'الملفات' : 'Files'}
          <span style={{ fontWeight: 400, color: 'var(--mute)' }}>
            {' · '}{isAr ? 'ارفعها مباشرة' : 'upload directly'}
          </span>
        </span>
        <div style={{ marginTop: 6 }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              addFiles(e.target.files);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          />
          <div
            role="button"
            tabIndex={0}
            onClick={() => { if (!busy) fileInputRef.current?.click(); }}
            onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) fileInputRef.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (!busy) addFiles(e.dataTransfer.files);
            }}
            style={{
              border: `1px dashed ${dragOver ? 'var(--copper)' : 'var(--line)'}`,
              borderRadius: 10,
              padding: '18px 12px',
              textAlign: 'center',
              color: 'var(--mute)',
              cursor: busy ? 'default' : 'pointer',
              background: dragOver ? 'var(--sand-2)' : 'transparent',
              fontSize: 13,
            }}
          >
            {isAr ? 'اسحب ملفات هنا أو اضغط للاختيار' : 'Drag files here, or click to choose'}
          </div>

          {/* Queued files — one material each, with per-file progress on upload
              and a «تعديل» editor to override the shared fields for one file. */}
          {files.length > 0 && (
            <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
              {files.map((f, i) => {
                const active = uploading?.index === i;
                const done = uploading ? i < uploading.index : false;
                const rowPct = active ? Math.round((uploading?.frac ?? 0) * 100) : null;
                const k = keyOf(f);
                const ov = overrides[k] ?? {};
                const hasOv = Object.keys(ov).length > 0;
                const isEditing = editingKey === k;
                // Per-file editing only makes sense for a batch — a single file
                // uses the Name/Kind fields at the top of the modal.
                const canEditFile = files.length > 1 && !busy;
                const eff = {
                  title: ov.title ?? f.name.replace(/\.[^.]+$/, ''),
                  kind: ov.kind ?? kindFromFile(f),
                  source: ov.source ?? source,
                  shotOn: ov.shotOn ?? shotOn,
                  tags: ov.tags ?? sharedTags,
                };
                return (
                  <div key={`${k}:${i}`} style={{ display: 'grid', gap: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        border: `1px solid ${isEditing ? 'var(--copper)' : 'var(--line)'}`,
                        borderRadius: 10,
                        borderBottomLeftRadius: isEditing ? 0 : 10,
                        borderBottomRightRadius: isEditing ? 0 : 10,
                        padding: '8px 12px',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {ov.title?.trim() ? ov.title : f.name}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--mute)' }}>
                          {formatBytes(f.size, isAr)}{done ? (isAr ? ' · تم' : ' · done') : ''}
                          {hasOv && <> · <span style={{ color: 'var(--copper)', fontWeight: 700 }}>{isAr ? 'مخصّص' : 'Custom'}</span></>}
                        </div>
                        {rowPct !== null && (
                          <div style={{ height: 4, borderRadius: 4, background: 'var(--line)', marginTop: 6, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${rowPct}%`, background: 'var(--copper)', transition: 'width .15s' }} />
                          </div>
                        )}
                      </div>
                      {canEditFile && (
                        <button
                          type="button"
                          className={`btn btn-sm${isEditing ? ' btn-p' : ''}`}
                          onClick={() => setEditingKey((cur) => (cur === k ? null : k))}
                          aria-expanded={isEditing}
                        >
                          {isEditing ? (isAr ? 'إغلاق' : 'Close') : (isAr ? 'تعديل' : 'Edit')}
                        </button>
                      )}
                      {!busy && (
                        <button type="button" className="btn btn-d btn-sm" onClick={() => { removeFile(i); resetOverride(k); }}>
                          {isAr ? 'إزالة' : 'Remove'}
                        </button>
                      )}
                    </div>

                    {isEditing && canEditFile && (
                      <div
                        style={{
                          border: '1px solid var(--copper)',
                          borderTop: 'none',
                          borderBottomLeftRadius: 10,
                          borderBottomRightRadius: 10,
                          padding: '12px',
                          display: 'grid',
                          gap: 11,
                          background: 'color-mix(in srgb, var(--copper) 4%, transparent)',
                        }}
                      >
                        <div style={{ fontSize: 11, color: 'var(--mute)', lineHeight: 1.7 }}>
                          {isAr
                            ? 'يطبَّق على هذا الملف وحده. اترك الحقل ليأخذ القيمة المشتركة.'
                            : 'Applies to this file only. Leave a field to inherit the shared value.'}
                        </div>
                        <Field label={isAr ? 'الاسم' : 'Name'}>
                          <input
                            className="inp"
                            value={eff.title}
                            onChange={(e) => patchOverride(k, { title: e.target.value })}
                          />
                        </Field>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
                          <Field label={isAr ? 'النوع' : 'Kind'}>
                            <select
                              className="inp"
                              value={eff.kind}
                              onChange={(e) => patchOverride(k, { kind: e.target.value as MosAsset['kind'] })}
                            >
                              {Object.keys(ASSET_KIND_LABELS).map((kk) => (
                                <option key={kk} value={kk}>{isAr ? ASSET_KIND_LABELS[kk]?.ar : ASSET_KIND_LABELS[kk]?.en}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label={isAr ? 'المصدر' : 'Source'}>
                            <select
                              className="inp"
                              value={eff.source}
                              onChange={(e) => patchOverride(k, { source: e.target.value as MosAsset['source'] })}
                            >
                              {Object.keys(ASSET_SOURCE_LABELS).map((kk) => (
                                <option key={kk} value={kk}>{isAr ? ASSET_SOURCE_LABELS[kk]?.ar : ASSET_SOURCE_LABELS[kk]?.en}</option>
                              ))}
                            </select>
                          </Field>
                        </div>
                        <Field label={isAr ? 'تاريخ التصوير' : 'Shot on'}>
                          <input
                            type="date"
                            className="inp"
                            value={eff.shotOn}
                            onChange={(e) => patchOverride(k, { shotOn: e.target.value })}
                          />
                        </Field>
                        <div>
                          <div className="lbl" style={{ marginBottom: 7 }}>{isAr ? 'وسوم هذا الملف' : 'Tags for this file'}</div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {eff.tags.map((t) => (
                              <button
                                key={t}
                                type="button"
                                className="fbtn on"
                                onClick={() => patchOverride(k, { tags: eff.tags.filter((x) => x !== t) })}
                              >
                                {t} <span className="x">×</span>
                              </button>
                            ))}
                            <input
                              className="fbtn"
                              style={{ borderStyle: 'dashed', minWidth: 74, outline: 'none' }}
                              placeholder={isAr ? '+ وسم' : '+ tag'}
                              value={tagDraft}
                              onChange={(e) => setTagDraft(e.target.value)}
                              onBlur={() => {
                                const t = tagDraft.trim();
                                if (t) patchOverride(k, { tags: Array.from(new Set([...eff.tags, t])) });
                                setTagDraft('');
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  const t = tagDraft.trim();
                                  if (t) patchOverride(k, { tags: Array.from(new Set([...eff.tags, t])) });
                                  setTagDraft('');
                                }
                              }}
                            />
                          </div>
                        </div>
                        {hasOv && (
                          <div>
                            <button type="button" className="btn btn-d btn-sm" onClick={() => resetOverride(k)}>
                              {isAr ? 'إرجاع إلى المشترك' : 'Reset to shared'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        {files.length > 1 ? (
          <div>
            <span className="lbl">{isAr ? 'النوع' : 'Kind'}</span>
            <div style={{ marginTop: 6, padding: '9px 0', fontSize: 13, color: 'var(--mute)' }}>
              {isAr ? 'يُكتشف تلقائيًا لكل ملف' : 'auto-detected per file'}
            </div>
          </div>
        ) : (
          <Field label={isAr ? 'النوع' : 'Kind'}>
            <select className="inp" value={kind} onChange={(e) => setKind(e.target.value as MosAsset['kind'])}>
              {Object.keys(ASSET_KIND_LABELS).map((k) => (
                <option key={k} value={k}>{isAr ? ASSET_KIND_LABELS[k]?.ar : ASSET_KIND_LABELS[k]?.en}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label={isAr ? 'المصدر' : 'Source'}>
          <select className="inp" value={source} onChange={(e) => setSource(e.target.value as MosAsset['source'])}>
            {Object.keys(ASSET_SOURCE_LABELS).map((k) => (
              <option key={k} value={k}>{isAr ? ASSET_SOURCE_LABELS[k]?.ar : ASSET_SOURCE_LABELS[k]?.en}</option>
            ))}
          </select>
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'تاريخ التصوير' : 'Shot on'}>
          <input type="date" className="inp" value={shotOn} onChange={(e) => setShotOn(e.target.value)} />
        </Field>
        <Field
          label={isAr ? 'الوسوم' : 'Tags'}
          hint={isAr ? 'مفصولة بفاصلة — «مشهد ١» يربطها بمشهد' : 'comma separated — "scene:1" ties it to a scene'}
        >
          <input className="inp" value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
