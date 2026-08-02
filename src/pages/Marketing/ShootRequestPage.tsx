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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosRole, MosShootItemDetail, MosShootRequest, ROLE_LABELS, SHOOT_STATUS_LABELS,
  addShootItem, deliverShoot, fetchBootstrap, fetchShootDetail, fetchShoots,
  saveShoot, toggleShootItem,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, ReadField, Skeleton } from './components/kit';
import { IconCheck, IconShoot } from './components/icons';
import { dateTime, initial, isoDateTimeLocal, num, roleAvatarClass } from './lib/format';
import './styles/pages-remaining.css';

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

  useEffect(() => { void load(); }, [load]);

  // The copper side-note: shots piling up on OTHER projects, and the threshold
  // that will trigger the next suggestion. Informational — a failure here logs
  // (network / RLS on the list action) and the note simply doesn't render.
  useEffect(() => {
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
  }, [requestId]);

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

  return (
    <>
      <PageHead
        title={request?.title ?? (isAr ? 'طلب تصوير' : 'Shoot request')}
        crumb={
          <>
            <button type="button" onClick={() => navigate('/m/library')}>
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
