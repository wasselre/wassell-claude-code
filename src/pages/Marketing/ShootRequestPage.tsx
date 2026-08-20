/**
 * Shoot request — design screen 24 (/m/shoots/:requestId).
 *
 * The «إسناد تصوير» buttons lead HERE. The shot list is not hand-written — it
 * is assembled from every scene in every content item waiting on footage, so
 * one trip to the site unblocks three records instead of one.
 *
 * «رفع التصوير» deep-links to /m/library/upload?shoot=<id> — the existing
 * delivery wire: files arriving for this request mark its waiting scenes
 * covered and the blocked tasks open automatically.
 *
 * SITE MODE (?mode=site — design screen 30): the phone-first surface for the
 * person standing AT the location. Big tick rows, a camera button per shot,
 * and the offline queue from lib/offline.ts — ticks and captures land in
 * IndexedDB when there is no signal and drain automatically when connectivity
 * returns (online / visibilitychange / mount — the honest foreground paths,
 * nothing claimed beyond what the platform provides).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { marketingLibraryHref } from '@/lib/files/libraryUrl';
import { useAppStore } from '@/stores/appStore';
import {
  MosRole, MosShootItemDetail, MosShootRequest, ROLE_LABELS, SHOOT_STATUS_LABELS,
  addShootItem, deliverShoot, fetchBootstrap, fetchShootDetail, fetchShoots,
  saveAsset, saveShoot, toggleShootItem,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, ReadField, Skeleton } from './components/kit';
import { IconCheck, IconShoot } from './components/icons';
import { dateTime, dayName, initial, isoDateTimeLocal, num, roleAvatarClass, shortDate } from './lib/format';
import {
  DrainHandlers, OfflineQueueState, OfflineQuotaError, drain, enqueueCapture,
  enqueueTick, retryItem, startAutoDrain, subscribe,
} from './lib/offline';
import { formatBytes, isBrowserImage, kindFromFile } from './lib/upload';
import { canonicalAssetFields } from './lib/canonicalUpload';
import './styles/pages-remaining.css';
import './styles/mobile-m3.css';

const TONE: Record<string, 'idle' | 'now' | 'go' | 'live'> = {
  requested: 'idle',
  scheduled: 'now',
  shot: 'go',
  delivered: 'live',
  cancelled: 'idle',
};

/** «لقطة / لقطتان / N لقطات» — the unblock card's count pill. */
function shotCount(n: number, isAr: boolean): string {
  if (!isAr) return `${n} ${n === 1 ? 'shot' : 'shots'}`;
  if (n === 1) return 'لقطة';
  if (n === 2) return 'لقطتان';
  if (n <= 10) return `${num(n, true)} لقطات`;
  return `${num(n, true)} لقطة`;
}

export default function ShootRequestPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const [searchParams] = useSearchParams();
  /** Screen 30 — the phone-first at-the-location surface. Query-driven. */
  const siteMode = searchParams.get('mode') === 'site';
  const { isAr, can, projectName } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);

  const [request, setRequest] = useState<MosShootRequest | null>(null);
  const [items, setItems] = useState<MosShootItemDetail[]>([]);
  const [assetsCount, setAssetsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  /** The other-project backlog note (secondary — the page works without it). */
  const [otherBacklog, setOtherBacklog] = useState<{ project: string | null; n: number } | null>(null);
  const [thresholdShots, setThresholdShots] = useState(4);

  const load = useCallback(async () => {
    if (!requestId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchShootDetail(requestId);
      setRequest(res.request);
      setItems(res.items);
      setAssetsCount(res.assets_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  // Site mode fetches for itself (SiteModeView below) — skip the desktop load.
  useEffect(() => {
    if (siteMode) return;
    void load();
  }, [load, siteMode]);

  // The copper side-note: shots piling up on OTHER projects, and the threshold
  // that will trigger the next suggestion. Informational — a failure here logs
  // (network / RLS on the list action) and the note simply doesn't render.
  useEffect(() => {
    if (siteMode) return;
    let alive = true;
    void (async () => {
      try {
        const [shoots, bootstrap] = await Promise.all([fetchShoots(), fetchBootstrap()]);
        if (!alive) return;
        const t = bootstrap.settings.shoot_grouping_thresholds as { shots?: number } | undefined;
        const shots = typeof t?.shots === 'number' && t.shots > 0 ? t.shots : 4;
        setThresholdShots(shots);
        const requested = new Set(shoots.items.map((i) => i.scene_id).filter(Boolean));
        const backlog = shoots.missing_scenes.filter((s) => !requested.has(s.id));
        const byProject = new Map<string, number>();
        for (const s of backlog) {
          const owner = shoots.scene_owners.find((o) => o.id === s.content_id);
          const key = owner?.project_id ?? 'none';
          byProject.set(key, (byProject.get(key) ?? 0) + 1);
        }
        let best: { project: string | null; n: number } | null = null;
        for (const [key, n] of byProject) {
          if (n >= shots) continue; // over-threshold groups get a suggestion row, not this note
          if (!best || n > best.n) best = { project: key === 'none' ? null : key, n };
        }
        setOtherBacklog(best);
      } catch (e) {
        // Secondary info only (the shoot itself already loaded); losing the
        // note must not fail the page — but the failure is still visible here.
        console.error('[marketing] cross-project backlog note unavailable', e);
      }
    })();
    return () => { alive = false; };
  }, [requestId, siteMode]);

  /** The «يفكّ تعطّل» groups — this request's items, by content record. */
  const unblocks = useMemo(() => {
    const m = new Map<string, { ref: string | null; title: string; n: number }>();
    for (const i of items) {
      if (!i.content_id) continue;
      const g = m.get(i.content_id) ?? { ref: i.content_ref, title: i.content_title ?? '', n: 0 };
      g.n += 1;
      m.set(i.content_id, g);
    }
    return Array.from(m.entries()).map(([id, g]) => ({ content_id: id, ...g }));
  }, [items]);

  const toggle = async (item: MosShootItemDetail): Promise<void> => {
    try {
      const res = await toggleShootItem(item.id, !item.done);
      setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, done: res.item.done } : i)));
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const deliver = async (): Promise<void> => {
    if (!request) return;
    setBusy(true);
    try {
      const res = await deliverShoot(request.id);
      addToast(
        isAr
          ? `سُلِّم — عُلِّمت ${num(res.scenes_marked, true)} لقطة منتظرة كمتوفرة.`
          : `Delivered — ${res.scenes_marked} waiting shots marked covered.`,
        'success',
      );
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const assignedRole = request?.assigned_role ?? null;
  const assignedLabel = assignedRole && ROLE_LABELS[assignedRole as MosRole]
    ? (isAr ? ROLE_LABELS[assignedRole as MosRole].ar : ROLE_LABELS[assignedRole as MosRole].en)
    : assignedRole;

  if (!requestId) return null;

  if (siteMode) return <SiteModeView requestId={requestId} />;

  return (
    <>
      <PageHead
        title={request?.title ?? (isAr ? 'طلب تصوير' : 'Shoot request')}
        crumb={
          <>
            <button type="button" onClick={() => navigate(marketingLibraryHref())}>
              {isAr ? 'مكتبة المواد' : 'Asset library'}
            </button>
            <span className="sep">/</span>
            <button type="button" onClick={() => navigate('/m/shoots')}>
              {isAr ? 'التصوير' : 'Shoots'}
            </button>
            <span className="sep">/</span>
            <span className="ltr">{request?.ref ?? ''}</span>
          </>
        }
        sub={request && (
          <span className="chips">
            {request.project_id && <span className="tag">{projectName(request.project_id)}</span>}
            <Pill tone={TONE[request.status] ?? 'idle'}>
              {(isAr ? SHOOT_STATUS_LABELS[request.status]?.ar : SHOOT_STATUS_LABELS[request.status]?.en) ?? request.status}
              {request.scheduled_at && request.status === 'scheduled' && <> · {dateTime(request.scheduled_at, isAr)}</>}
            </Pill>
            {assignedLabel && (
              <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {isAr ? 'مُسند إلى ' : 'Assigned to '}
                <b style={{ color: 'var(--ink)', fontWeight: 700 }}>{assignedLabel}</b>
              </span>
            )}
            {unblocks.length > 0 && (
              <span style={{ fontSize: 11.5, color: 'var(--copper)', fontWeight: 700 }}>
                {isAr ? `يفكّ تعطّل ${num(unblocks.length, true)} سجلات` : `Unblocks ${unblocks.length} records`}
              </span>
            )}
            {assetsCount > 0 && (
              <span className="tag">
                {isAr ? `${num(assetsCount, true)} ملفات سُلِّمت` : `${assetsCount} files delivered`}
              </span>
            )}
          </span>
        )}
      >
        {can('manage_assets') && request && request.status !== 'delivered' && request.status !== 'cancelled' && (
          <>
            <button type="button" className="btn btn-d" onClick={() => setRescheduling(true)}>
              {isAr ? 'إعادة جدولة' : 'Reschedule'}
            </button>
            <button type="button" className="btn btn-go" disabled={busy} onClick={() => void deliver()}>
              <IconCheck />
              {isAr ? 'تسليم' : 'Deliver'}
            </button>
            <button
              type="button"
              className="btn btn-p"
              onClick={() => navigate(`/m/library/upload?shoot=${request.id}`)}
            >
              <IconShoot />
              {isAr ? 'رفع التصوير' : 'Upload the shoot'}
            </button>
          </>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && !request && <Skeleton rows={6} />}

        {!loading && !request && !error && (
          <Empty
            title={isAr ? 'الطلب غير موجود' : 'Request not found'}
            body={isAr ? 'ربما حُذف أو أُلغي.' : 'It may have been removed or cancelled.'}
          />
        )}

        {request && (
          <div className="grid" style={{ gridTemplateColumns: '1fr 292px', alignItems: 'start' }}>
            {/* ── قائمة اللقطات — derived, not written ────────────────── */}
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'قائمة اللقطات' : 'Shot list'}</h4>
                <span className="r">
                  {isAr
                    ? `مُجمَّعة من المشاهد المنتظرة تصويرًا · ${num(items.length, true)} لقطات`
                    : `assembled from scenes waiting on footage · ${items.length} shots`}
                </span>
                {can('manage_assets') && (
                  <button type="button" className="btn btn-sm" style={{ marginInlineStart: 10 }} onClick={() => setAdding(true)}>
                    {isAr ? 'إضافة لقطة' : 'Add a shot'}
                  </button>
                )}
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 34 }} />
                      <th>{isAr ? 'اللقطة' : 'The shot'}</th>
                      <th style={{ width: 130 }}>{isAr ? 'مطلوبة لـ' : 'Needed for'}</th>
                      <th style={{ width: 96 }}>{isAr ? 'النوع' : 'Type'}</th>
                      <th style={{ width: 140 }}>{isAr ? 'ملاحظة' : 'Note'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <button
                            type="button"
                            className={`pr-tick${i.done ? ' done' : ''}`}
                            disabled={!can('manage_assets')}
                            aria-label={i.done ? (isAr ? 'أُنجزت' : 'Done') : (isAr ? 'لم تُنجز' : 'Not done')}
                            onClick={() => void toggle(i)}
                          >
                            {i.done ? '✓' : '○'}
                          </button>
                        </td>
                        <td className="ttl" style={i.done ? { textDecoration: 'line-through', color: 'var(--mute)' } : undefined}>
                          {i.description}
                        </td>
                        <td>
                          {i.content_id ? (
                            <button
                              type="button"
                              className="btn btn-d btn-sm"
                              onClick={() => navigate(`/m/content/${i.content_id}`)}
                            >
                              <span className="id">{i.content_ref ?? '—'}</span>
                            </button>
                          ) : '—'}
                          {i.scene && (
                            <span style={{ fontSize: 11, color: 'var(--mute)', marginInlineStart: 5 }}>
                              {isAr ? `مشهد ${num(i.scene.position, true)}` : `scene ${i.scene.position}`}
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="tag">
                            {i.scene
                              ? isAr ? 'فيديو' : 'Video'
                              : i.content_id
                                ? isAr ? 'صورة' : 'Photo'
                                : isAr ? 'إضافية' : 'Extra'}
                          </span>
                        </td>
                        <td style={{ fontSize: 11, color: 'var(--mute)' }}>{i.scene?.note ?? '—'}</td>
                      </tr>
                    ))}
                    {/* The catch-all row: extras land in the library untagged
                        and show up under «غير المستخدمة». */}
                    <tr
                      className="pr-catch click"
                      onClick={() => { if (can('manage_assets')) setAdding(true); }}
                    >
                      <td style={{ textAlign: 'center', color: 'var(--mute)' }}>+</td>
                      <td className="ttl" style={{ color: 'var(--mute)' }}>
                        {isAr ? 'أي شيء آخر ما دمتِ هناك' : 'Anything else while you are there'}
                      </td>
                      <td colSpan={3} style={{ fontSize: 11, color: 'var(--mute)' }}>
                        {isAr
                          ? 'المواد الإضافية تصل للمكتبة بلا وسوم وتظهر ضمن «غير المستخدمة»'
                          : 'Extra material lands in the library untagged and shows up under “Unused”'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── rail ────────────────────────────────────────────────── */}
            <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'الرحلة' : 'The trip'}</h4></div>
                <div className="card-b">
                  <ReadField label={isAr ? 'المتى' : 'When'}>
                    {request.scheduled_at ? dateTime(request.scheduled_at, isAr) : (isAr ? 'بلا موعد بعد' : 'not set yet')}
                  </ReadField>
                  <ReadField label={isAr ? 'من' : 'Who'}>
                    {assignedLabel ? (
                      <span className="who">
                        <span className={`av ${roleAvatarClass(assignedRole)}`}>{initial(assignedLabel)}</span>
                        {assignedLabel}
                      </span>
                    ) : '—'}
                  </ReadField>
                  <ReadField label={isAr ? 'أين' : 'Where'}>{request.location ?? '—'}</ReadField>
                  {request.note && <ReadField label={isAr ? 'ملاحظة' : 'Note'}>{request.note}</ReadField>}
                </div>
              </div>

              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'يفكّ تعطّل' : 'Unblocks'}</h4>
                  <span className="r">
                    {isAr ? `${num(unblocks.length, true)} سجلات` : `${unblocks.length} records`}
                  </span>
                </div>
                <div className="card-b" style={{ display: 'grid', gap: 9, fontSize: 12 }}>
                  {unblocks.length === 0 && (
                    <span style={{ color: 'var(--mute)' }}>
                      {isAr ? 'لا سجلات مرتبطة بلقطات هذا الطلب.' : 'No records hang on this request’s shots.'}
                    </span>
                  )}
                  {unblocks.map((u) => (
                    <button
                      key={u.content_id}
                      type="button"
                      style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'transparent', border: 0, cursor: 'pointer', padding: 0, textAlign: 'start' }}
                      onClick={() => navigate(`/m/content/${u.content_id}`)}
                    >
                      <span className="id" style={{ width: 46 }}>{u.ref ?? '—'}</span>
                      <span style={{ flex: 1 }}>{u.title}</span>
                      <Pill tone="wait">{shotCount(u.n, isAr)}</Pill>
                    </button>
                  ))}
                  <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 5, paddingTop: 9, borderTop: '1px solid var(--line-soft)', lineHeight: 1.75 }}>
                    {isAr
                      ? 'عند رفع التصوير على هذا الطلب، يُعلَّم كل مشهد كمُغطّى وتُفتح المهام المنتظرة تلقائيًا.'
                      : 'When the shoot is uploaded onto this request, every scene is marked covered and the waiting tasks open automatically.'}
                  </div>
                </div>
              </div>

              {otherBacklog && otherBacklog.n > 0 && (
                <div style={{
                  background: 'color-mix(in srgb, var(--copper) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--copper) 30%, transparent)',
                  borderRadius: 9,
                  padding: '12px 13px',
                  fontSize: 12,
                  lineHeight: 1.85,
                  color: 'var(--ink-2)',
                }}>
                  <b style={{ fontWeight: 700 }}>
                    {isAr
                      ? `${shotCount(otherBacklog.n, true)} أخرى تنتظر في ${otherBacklog.project ? projectName(otherBacklog.project) : 'بلا مشروع'}.`
                      : `${otherBacklog.n} more shots are waiting at ${otherBacklog.project ? projectName(otherBacklog.project) : 'no project'}.`}
                  </b>{' '}
                  {isAr
                    ? `لا تكفي لتبرير رحلة بعد — وسيقترح النظام واحدة عند بلوغ القائمة ${num(thresholdShots, true)} لقطات.`
                    : `Not enough to justify a trip yet — the system will suggest one when the list reaches ${thresholdShots} shots.`}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {adding && request && (
        <AddShotModal
          isAr={isAr}
          requestId={request.id}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); void load(); }}
        />
      )}

      {rescheduling && request && (
        <RescheduleModal
          isAr={isAr}
          request={request}
          onClose={() => setRescheduling(false)}
          onSaved={() => { setRescheduling(false); void load(); }}
        />
      )}
    </>
  );
}

function AddShotModal({
  isAr, requestId, onClose, onAdded,
}: {
  isAr: boolean;
  requestId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!description.trim()) {
      addToast(isAr ? 'صف اللقطة أولًا.' : 'Describe the shot first.', 'error');
      return;
    }
    setBusy(true);
    try {
      await addShootItem(requestId, { description: description.trim() });
      addToast(isAr ? 'أُضيفت اللقطة.' : 'Shot added.', 'success');
      onAdded();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'إضافة لقطة' : 'Add a shot'}
      sub={isAr
        ? 'لقطة يدوية فوق المُجمَّعة تلقائيًا — «أي شيء آخر ما دمتِ هناك».'
        : 'A manual shot on top of the auto-assembled list — anything else while you are there.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ…' : 'Working…') : isAr ? 'إضافة' : 'Add'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'وصف اللقطة' : 'The shot'}>
        <input className="inp" value={description} autoFocus onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}

function RescheduleModal({
  isAr, request, onClose, onSaved,
}: {
  isAr: boolean;
  request: MosShootRequest;
  onClose: () => void;
  onSaved: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [when, setWhen] = useState(isoDateTimeLocal(request.scheduled_at));
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!when) {
      addToast(isAr ? 'اختر موعدًا.' : 'Pick a time.', 'error');
      return;
    }
    setBusy(true);
    try {
      await saveShoot({
        id: request.id,
        scheduled_at: new Date(when).toISOString(),
        status: 'scheduled',
      });
      addToast(isAr ? 'جُدولت الرحلة.' : 'Trip scheduled.', 'success');
      onSaved();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'إعادة جدولة' : 'Reschedule'}
      sub={request.title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ…' : 'Working…') : isAr ? 'حفظ الموعد' : 'Save the time'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'الموعد' : 'When'}>
        <input type="datetime-local" className="inp" value={when} onChange={(e) => setWhen(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* SITE MODE — design screen 30 (?mode=site)                          */
/* ------------------------------------------------------------------ */

/** «بلا شبكة — …» — the offline banner line, count-aware. */
function offlinePhrase(n: number, isAr: boolean): string {
  if (!isAr) {
    if (n === 0) return 'No network — what you capture is saved on the phone and uploads on Wi-Fi';
    return `No network — ${n} saved on the phone, uploading when Wi-Fi is back`;
  }
  if (n === 0) return 'بلا شبكة — ما تسجّلينه يُحفظ على الجوال ويُرفع على الواي فاي';
  if (n === 1) return 'بلا شبكة — عنصر واحد محفوظ على الجوال، سيُرفع على الواي فاي';
  if (n === 2) return 'بلا شبكة — عنصران محفوظان على الجوال، سيُرفعان على الواي فاي';
  if (n <= 10) return `بلا شبكة — ${num(n, true)} عناصر محفوظة على الجوال، ستُرفع على الواي فاي`;
  return `بلا شبكة — ${num(n, true)} عنصرًا محفوظًا على الجوال، ستُرفع على الواي فاي`;
}

/** A synced capture kept on screen with its «تم» chip after it left the queue. */
interface SyncedRow {
  id: string;
  name: string;
  size: number;
}

function SiteModeView({ requestId }: { requestId: string }) {
  const { isAr, can } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const canManage = can('manage_assets');

  const [request, setRequest] = useState<MosShootRequest | null>(null);
  const [items, setItems] = useState<MosShootItemDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<OfflineQueueState | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  /** Object-URL previews keyed by capture id (= the future asset id). */
  const [previews, setPreviews] = useState<Record<string, string>>({});
  /** shoot item id → the capture the camera button linked to it. */
  const [itemCapture, setItemCapture] = useState<Record<string, string>>({});
  const [syncedRows, setSyncedRows] = useState<SyncedRow[]>([]);
  const [unblock, setUnblock] = useState<{ scenes: number } | null>(null);

  const requestRef = useRef<MosShootRequest | null>(null);
  const handlersRef = useRef<DrainHandlers | null>(null);
  const drainingRef = useRef(false);
  const deliverSetRef = useRef<Set<string>>(new Set());
  const pendingItemRef = useRef<MosShootItemDetail | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previewsRef = useRef<Record<string, string>>({});
  const shootsCacheRef = useRef<Promise<MosShootRequest[]> | null>(null);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetchShootDetail(requestId);
      setRequest(res.request);
      setItems(res.items);
    } catch (e) {
      if (silent) {
        // A background refresh after a drain — the list on screen stays
        // usable; the failure is still visible here, never swallowed.
        console.error('[marketing] site-mode silent refresh failed', e);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [requestId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { requestRef.current = request; }, [request]);

  // Online / offline — drives the banner; the drain wiring listens on its own.
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // Object URLs must be released on unmount.
  useEffect(() => () => {
    Object.values(previewsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);

  // The offline engine: subscribe for live chips, then startAutoDrain with the
  // real handlers — ticks replay through shoot_item_toggle, captures register
  // through the same asset_save call the upload page's ?shoot= wire makes.
  useEffect(() => {
    const rightsLabel = isAr ? 'ملكية كاملة — بلا قيود' : 'Full ownership — no restrictions';

    const projectOf = async (shootReqId: string): Promise<string | null> => {
      if (shootReqId === requestId) return requestRef.current?.project_id ?? null;
      if (!shootsCacheRef.current) {
        shootsCacheRef.current = fetchShoots()
          .then((r) => r.requests)
          .catch((err: unknown) => {
            // Project attribution only — the asset still registers, untagged.
            console.error('[marketing] shoot list unavailable for project attribution', err);
            return [];
          });
      }
      const reqs = await shootsCacheRef.current;
      return reqs.find((r) => r.id === shootReqId)?.project_id ?? null;
    };

    const handlers: DrainHandlers = {
      toggleShootItem: async (shootItemId, done) => {
        await toggleShootItem(shootItemId, done);
      },
      registerAsset: async (meta) => {
        const kind = kindFromFile(new File([], meta.fileName, { type: meta.mimeType }));
        const title = meta.note?.trim() || meta.fileName.replace(/\.[^.]+$/, '');
        await saveAsset({
          title,
          kind,
          source: 'shoot',
          project_id: await projectOf(meta.shootRequestId),
          shot_on: null,
          tags: [],
          ...canonicalAssetFields(meta.fileRow),
          original_name: meta.fileName,
          usage_rights: rightsLabel,
          shoot_request_id: meta.shootRequestId,
          note: meta.note ?? null,
        });
        deliverSetRef.current.add(meta.shootRequestId);
        setSyncedRows((cur) => [...cur, { id: meta.assetId, name: title, size: meta.size }]);
      },
    };
    handlersRef.current = handlers;

    const unsub = subscribe((state) => {
      setQueue(state);
      const was = drainingRef.current;
      drainingRef.current = state.draining;
      if (was && !state.draining) {
        // A drain pass just ended: refresh the list silently, and if captures
        // landed, run the delivery wire so waiting scenes flip to covered.
        void load(true);
        const ids = Array.from(deliverSetRef.current);
        deliverSetRef.current.clear();
        if (ids.length > 0) {
          void (async () => {
            for (const id of ids) {
              try {
                const res = await deliverShoot(id);
                if (id === requestId) {
                  if (res.scenes_marked > 0) setUnblock({ scenes: res.scenes_marked });
                  void load(true);
                } else {
                  addToast(
                    isAr
                      ? `سُلِّم طلب آخر — عُلِّمت ${num(res.scenes_marked, true)} لقطة منتظرة كمتوفرة.`
                      : `Another request delivered — ${res.scenes_marked} waiting shots marked covered.`,
                    'success',
                  );
                }
              } catch (e) {
                addToast(e instanceof Error ? e.message : String(e), 'error');
              }
            }
          })();
        }
      }
    });
    const teardown = startAutoDrain(handlers);
    return () => {
      teardown();
      unsub();
    };
  }, [requestId, isAr, load, addToast]);

  /** The big tick target — offline enqueues, online hits the API directly. */
  const tickToggle = async (item: MosShootItemDetail): Promise<void> => {
    const next = !item.done;
    setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, done: next } : i)));
    if (!navigator.onLine) {
      try {
        await enqueueTick(item.id, next);
      } catch (e) {
        setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, done: item.done } : i)));
        addToast(
          e instanceof OfflineQuotaError
            ? (isAr ? e.message_ar : e.message_en)
            : e instanceof Error ? e.message : String(e),
          'error',
        );
      }
      return;
    }
    try {
      const res = await toggleShootItem(item.id, next);
      setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, done: res.item.done } : i)));
    } catch (e) {
      setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, done: item.done } : i)));
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  /** Every capture goes through the queue; online just drains it right away. */
  const onCapturePicked = async (file: File): Promise<void> => {
    const item = pendingItemRef.current;
    pendingItemRef.current = null;
    try {
      const captureId = await enqueueCapture({
        shootRequestId: requestId,
        file,
        note: item?.description,
      });
      if (isBrowserImage(file)) {
        const url = URL.createObjectURL(file);
        previewsRef.current[captureId] = url;
        setPreviews((cur) => ({ ...cur, [captureId]: url }));
      }
      if (item) setItemCapture((cur) => ({ ...cur, [item.id]: captureId }));
      if (navigator.onLine) {
        const h = handlersRef.current;
        if (h) {
          drain(h).catch((err: unknown) => {
            console.error('[marketing] drain after capture failed', err);
          });
        }
      }
    } catch (e) {
      addToast(
        e instanceof OfflineQuotaError
          ? (isAr ? e.message_ar : e.message_en)
          : e instanceof Error ? e.message : String(e),
        'error',
      );
    }
  };

  const retry = async (id: string): Promise<void> => {
    try {
      await retryItem(id);
      if (navigator.onLine) {
        const h = handlersRef.current;
        if (h) await drain(h);
      }
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const doneCount = items.filter((i) => i.done).length;
  const unblocksCount = new Set(items.map((i) => i.content_id).filter(Boolean)).size;
  const captures = queue?.captures ?? [];
  const failedTicks = (queue?.ticks ?? []).filter((t) => t.lastError);
  const queuedCount = (queue?.ticks.length ?? 0) + captures.length;
  const totalFiles = captures.length + syncedRows.length;
  const totalBytes = captures.reduce((a, c) => a + c.size, 0) + syncedRows.reduce((a, r) => a + r.size, 0);
  const draining = queue?.draining ?? false;
  const when = request?.scheduled_at ?? request?.created_at ?? null;
  const refs = Array.from(new Set(items.map((i) => i.content_ref).filter((r): r is string => Boolean(r))));

  return (
    <div className="body">
      <div className="m3-site">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && !request && <Skeleton rows={6} />}
        {!loading && !request && !error && (
          <Empty
            title={isAr ? 'الطلب غير موجود' : 'Request not found'}
            body={isAr ? 'ربما حُذف أو أُلغي.' : 'It may have been removed or cancelled.'}
          />
        )}

        {request && (
          <>
            <div className="m3-head">
              <div className="s">
                {request.ref && <span className="ltr">{request.ref}</span>}
                {when && <> · {dayName(when, isAr)} {shortDate(when, isAr)}</>}
              </div>
              <h4>{request.title}</h4>
              <div className="m3-chips">
                <span className="pill p-now">
                  {isAr
                    ? `${num(doneCount, true)} من ${num(items.length, true)} تمت`
                    : `${doneCount} of ${items.length} done`}
                </span>
                {unblocksCount > 0 && (
                  <span className="m">
                    {isAr ? `تفكّ ${num(unblocksCount, true)} سجلات` : `Unblocks ${unblocksCount} records`}
                  </span>
                )}
              </div>
            </div>

            {!online && (
              <div className="m3-offline">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                  <path d="M12 8v5M12 16.5v.5" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
                <span>{offlinePhrase(queuedCount, isAr)}</span>
              </div>
            )}

            <div className="m3-list">
              {items.map((item) => {
                const capId = itemCapture[item.id];
                const prev = capId ? previews[capId] : undefined;
                return (
                  <div key={item.id} className={`m3-chk${item.done ? ' ok2' : ''}`}>
                    <button
                      type="button"
                      className="m3-chk-main"
                      disabled={!canManage}
                      aria-label={item.done ? (isAr ? 'أُنجزت' : 'Done') : (isAr ? 'لم تُنجز' : 'Not done')}
                      onClick={() => void tickToggle(item)}
                    >
                      <span className="bx">
                        {item.done && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="tx2" style={{ display: 'block' }}>{item.description}</span>
                        <span className="mt3" style={{ display: 'block' }}>
                          {item.content_ref && <span className="ltr">{item.content_ref}</span>}
                          {item.scene && <> {isAr ? `مشهد ${num(item.scene.position, true)}` : `scene ${item.scene.position}`}</>}
                          {item.scene?.note
                            ? <> · {item.scene.note}</>
                            : !item.content_id && <>{isAr ? 'إضافية' : 'extra'}</>}
                        </span>
                      </span>
                    </button>
                    {capId ? (
                      <span
                        className="m3-thumbcell"
                        style={prev ? { backgroundImage: `url(${prev})` } : undefined}
                        aria-hidden
                      />
                    ) : canManage ? (
                      <button
                        type="button"
                        className="m3-cam"
                        aria-label={isAr ? 'صوّري هذه اللقطة' : 'Capture this shot'}
                        onClick={() => {
                          pendingItemRef.current = item;
                          inputRef.current?.click();
                        }}
                      >
                        <IconShoot />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {(totalFiles > 0 || failedTicks.length > 0) && (
              <div className="m3-card">
                <div className="m3-up-head">
                  <b>
                    {draining
                      ? isAr ? 'جارٍ الرفع' : 'Uploading'
                      : online
                        ? isAr ? 'طابور الرفع' : 'Upload queue'
                        : isAr ? 'بانتظار الاتصال' : 'Waiting for connection'}
                  </b>
                  <span className="n">
                    {request.ref && <><span className="ltr">{request.ref}</span> · </>}
                    {shotCount(totalFiles, isAr)} · {formatBytes(totalBytes, isAr)}
                  </span>
                </div>
                {totalFiles > 0 && (
                  <>
                    <div className="m3-up-head" style={{ marginTop: 9 }}>
                      <b>
                        {isAr
                          ? `${num(syncedRows.length, true)} من ${num(totalFiles, true)} ملفًا`
                          : `${syncedRows.length} of ${totalFiles} files`}
                      </b>
                    </div>
                    <div className="meter m3-up-meter" style={{ height: 5 }}>
                      <i style={{ width: `${(syncedRows.length / totalFiles) * 100}%`, background: 'var(--copper)' }} />
                    </div>
                  </>
                )}

                {syncedRows.map((r) => (
                  <div key={r.id} className="m3-file-row">
                    <span
                      className="th"
                      style={previews[r.id] ? { backgroundImage: `url(${previews[r.id]})` } : undefined}
                      aria-hidden
                    />
                    <div className="t">
                      <b>{r.name}</b>
                      <div className="m">{formatBytes(r.size, isAr)}</div>
                    </div>
                    <Pill tone="go">{isAr ? 'تم' : 'Done'}</Pill>
                  </div>
                ))}

                {captures.map((c) => {
                  const prev = previews[c.id];
                  return (
                    <div key={c.id} className="m3-file-row">
                      <span className="th" style={prev ? { backgroundImage: `url(${prev})` } : undefined} aria-hidden />
                      <div className="t">
                        <b className={c.note ? undefined : 'ltr'}>{c.note?.trim() || c.fileName}</b>
                        <div className={`m${c.status === 'failed' ? ' err' : ''}`}>
                          {formatBytes(c.size, isAr)}
                          {' · '}
                          {c.status === 'uploading'
                            ? isAr ? 'يُرفع' : 'uploading'
                            : c.status === 'failed'
                              ? c.lastError ?? (isAr ? 'فشل الرفع' : 'upload failed')
                              : isAr ? 'في الطابور' : 'queued'}
                        </div>
                      </div>
                      {c.status === 'uploading' && <Pill tone="now">{isAr ? 'يُرفع' : 'Uploading'}</Pill>}
                      {c.status === 'queued' && <Pill tone="idle">{isAr ? 'انتظار' : 'Waiting'}</Pill>}
                      {c.status === 'failed' && (
                        <button type="button" className="btn btn-sm m3-retry" onClick={() => void retry(c.id)}>
                          {isAr ? 'إعادة المحاولة' : 'Retry'}
                        </button>
                      )}
                    </div>
                  );
                })}

                {failedTicks.map((t) => (
                  <div key={t.id} className="m3-file-row">
                    <span className="th" aria-hidden />
                    <div className="t">
                      <b>{items.find((i) => i.id === t.shootItemId)?.description ?? (isAr ? 'علامة إنجاز لقطة' : 'A shot tick')}</b>
                      <div className="m err">{t.lastError}</div>
                    </div>
                    <button type="button" className="btn btn-sm m3-retry" onClick={() => void retry(t.id)}>
                      {isAr ? 'إعادة المحاولة' : 'Retry'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {unblock && (
              <div className="m3-unblock">
                <div className="h">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                  <span>
                    {refs.length === 1
                      ? isAr
                        ? <><span className="ltr">{refs[0]}</span> فُكّ تعطّله</>
                        : <><span className="ltr">{refs[0]}</span> unblocked</>
                      : isAr ? 'فُكّ التعطّل' : 'Unblocked'}
                  </span>
                </div>
                <div className="b">
                  {isAr
                    ? <>عُلِّمت <b>{num(unblock.scenes, true)}</b> لقطة منتظرة كمتوفرة، وفُتحت المهام المنتظرة تلقائيًا.</>
                    : <><b>{unblock.scenes}</b> waiting shots marked covered — the waiting tasks opened automatically.</>}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {canManage && request && request.status !== 'cancelled' && (
        <div className="m3-fix">
          <button
            type="button"
            className="m3-btn p"
            onClick={() => {
              pendingItemRef.current = null;
              inputRef.current?.click();
            }}
          >
            <IconShoot />
            {isAr ? 'صوّري شيئًا إضافيًا' : 'Shoot something extra'}
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void onCapturePicked(f);
        }}
      />
    </div>
  );
}
