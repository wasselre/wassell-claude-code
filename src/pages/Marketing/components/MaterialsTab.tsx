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
 *   band 4 «المعتمد والمنشور»  = asset_links role 'final' — and ONLY these are
 *                                 offered in the Publishing tab's file picker.
 *
 * Band 1 also renders the MISSING shots: scenes with footage_status='missing'
 * appear as dashed rows carrying «إسناد تصوير» (the existing shoot-assignment
 * flow), because a shot the script needs and nobody filmed is a ROW, not an
 * absence.
 */
import { useCallback, useEffect, useState, type SVGProps } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  ASSET_KIND_LABELS, ASSET_SOURCE_LABELS, MosAsset, MosAssetLink, MosContentVersion,
  MosScene, MosShootItem, MosShootRequest, RolePerson,
  fetchAssets, fetchContentDetail, fetchContentVersions, fetchShoots,
  linkAsset, saveAsset, saveShoot, unlinkAsset,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Empty, Field, LoadError, Modal, Skeleton } from './kit';
import { IconLibrary, IconPlus, IconShoot, IconTrash } from './icons';
import { dayName, num, shortDate } from '../lib/format';
import '../styles/cd2.css';

const ROLES = ['source', 'reference', 'final'] as const;
/** The link roles, labelled by the band they land in (mapping above). */
const ROLE_LABELS: Record<string, { ar: string; en: string }> = {
  source:    { ar: 'مادة أصلية', en: 'Source material' },
  reference: { ar: 'ملف عمل',    en: 'Working file' },
  final:     { ar: 'معتمد',      en: 'Approved' },
};

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
}) {
  const addToast = useAppStore((s) => s.addToast);
  const { people, can } = useWorkspace();
  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [links, setLinks] = useState<MosAssetLink[]>([]);
  const [versions, setVersions] = useState<MosContentVersion[]>([]);
  const [fetchedScenes, setFetchedScenes] = useState<MosScene[]>([]);
  const [shootData, setShootData] = useState<{ requests: MosShootRequest[]; items: MosShootItem[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
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
  const finalRows = mine.filter((l) => l.role === 'final');

  /** One linked-asset row, band-agnostic. */
  const assetRow = (l: MosAssetLink) => {
    const a = assetById.get(l.asset_id);
    if (!a) return null;
    const usedElsewhere = links.filter(
      (x) => x.asset_id === a.id && x.content_id !== contentId,
    ).length;
    const scene = sceneTagOf(a);
    return (
      <div key={l.asset_id} className="file">
        <div className="th">
          {a.thumb_url ? <img src={a.thumb_url} alt="" /> : <IconLibrary />}
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
          {a.url && (
            <a className="btn btn-d btn-sm" href={a.url} target="_blank" rel="noreferrer">
              {isAr ? 'معاينة' : 'Preview'}
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
  };

  return (
    <div className="cd2-split">
      <div style={{ display: 'grid', gap: 20, minWidth: 0 }}>
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}

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
              {sourceRows.map(assetRow)}
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
            workingRows.map(assetRow)
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

        {/* ── band 4 — المعتمد والمنشور (role 'final') ───────────────── */}
        <div>
          <div className="lbl" style={{ marginBottom: 9 }}>
            {isAr ? 'المعتمد والمنشور' : 'Approved & published'}
          </div>
          {finalRows.length === 0 ? (
            <div className="drop">
              {isAr
                ? 'لا شيء معتمد بعد — الملفات المعتمدة تظهر هنا، وهي وحدها التي يمكن ربطها بعملية نشر.'
                : 'Nothing approved yet — approved files appear here, and only they can be attached to a publication.'}
            </div>
          ) : (
            finalRows.map(assetRow)
          )}
        </div>

        {canEdit && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => setPicking(true)}>
              <IconLibrary />
              {isAr ? 'سحب من المكتبة' : 'Pull from the library'}
            </button>
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              <IconPlus />
              {isAr ? 'إضافة مادة جديدة' : 'Add new material'}
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

      {picking && (
        <Modal
          title={isAr ? 'سحب من المكتبة' : 'Pull from the library'}
          sub={isAr ? 'اختر المادة ثم الشريط الذي تدخل فيه.' : 'Pick the material, then the band it belongs to.'}
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
                        <td style={{ width: 280 }}>
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
