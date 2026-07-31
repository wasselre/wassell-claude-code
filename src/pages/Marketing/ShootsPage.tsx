/**
 * Shoot requests — design screen 42.
 *
 * Three bands. Open requests, with what each one UNBLOCKS. Then the feature:
 * the auto-suggest band — the system knows every missing shot across every
 * project, so it proposes the trip when one is worth scheduling («٤ لقطات أو
 * انتظار ١٤ يومًا، أيهما أسبق») instead of waiting for someone to remember.
 * Then the completed list with its usage percentage — the only feedback loop
 * on shoot-brief quality: a shoot under 70% used deserves a sharper brief
 * next time, not blame for the photographer.
 *
 * Delivery is wired to intake: uploading a batch linked to a request marks
 * its waiting scenes covered (see UploadPage) — and the «تسليم» button here
 * does the same for hand-offs that skipped the upload page.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosShootItem, MosShootRequest, SHOOT_STATUS_LABELS,
  deliverShoot, fetchShoots, saveShoot, toggleShootItem,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton } from './components/kit';
import { IconCheck, IconPlus, IconShoot } from './components/icons';
import { dateTime, daysAgo, num, shortDate } from './lib/format';

const TONE: Record<string, 'idle' | 'now' | 'go' | 'live'> = {
  requested: 'idle',
  scheduled: 'now',
  shot: 'go',
  delivered: 'live',
  cancelled: 'idle',
};

/** The trip-worthiness threshold: shots accumulated, or days waited. */
const THRESHOLD_SHOTS = 4;
const THRESHOLD_DAYS = 14;

interface MissingScene {
  id: string;
  content_id: string;
  position: number;
  visual: string | null;
  created_at: string | null;
}

export default function ShootsPage() {
  const { isAr, can, projectName } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);

  const [requests, setRequests] = useState<MosShootRequest[]>([]);
  const [items, setItems] = useState<MosShootItem[]>([]);
  const [missing, setMissing] = useState<MissingScene[]>([]);
  const [owners, setOwners] = useState<Array<{ id: string; ref: string | null; title: string; project_id: string | null }>>([]);
  const [shootAssets, setShootAssets] = useState<Array<{ id: string; shoot_request_id: string }>>([]);
  const [assetLinks, setAssetLinks] = useState<Array<{ asset_id: string; content_id: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ sceneIds: string[]; projectId: string | null } | null>(null);
  const [openRequest, setOpenRequest] = useState<MosShootRequest | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchShoots();
      setRequests(res.requests);
      setItems(res.items);
      setMissing(res.missing_scenes.map((s) => ({
        id: s.id,
        content_id: s.content_id,
        position: s.position,
        visual: s.visual,
        created_at: s.created_at ?? null,
      })));
      setOwners(res.scene_owners);
      setShootAssets(res.shoot_assets);
      setAssetLinks(res.asset_links);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A scene already carried by a request is not backlog any more.
  const requested = useMemo(() => new Set(items.map((i) => i.scene_id).filter(Boolean)), [items]);
  const backlog = missing.filter((s) => !requested.has(s.id));

  /**
   * The auto-suggest groups: backlog by PROJECT, because a trip goes to a
   * place — the same van covers every waiting shot at مقام ١٧ regardless of
   * which video asked for it.
   */
  const suggestions = useMemo(() => {
    const byProject = new Map<string, { projectId: string | null; scenes: MissingScene[]; contentIds: Set<string> }>();
    for (const s of backlog) {
      const owner = owners.find((o) => o.id === s.content_id);
      const key = owner?.project_id ?? 'none';
      const g = byProject.get(key) ?? { projectId: owner?.project_id ?? null, scenes: [], contentIds: new Set<string>() };
      g.scenes.push(s);
      g.contentIds.add(s.content_id);
      byProject.set(key, g);
    }
    return Array.from(byProject.values())
      .map((g) => {
        const oldest = g.scenes.reduce<string | null>(
          (a, s) => (s.created_at && (!a || s.created_at < a) ? s.created_at : a),
          null,
        );
        const waitedDays = oldest
          ? Math.floor((Date.now() - new Date(oldest).getTime()) / 86_400_000)
          : 0;
        return {
          ...g,
          oldest,
          waitedDays,
          overThreshold: g.scenes.length >= THRESHOLD_SHOTS || waitedDays >= THRESHOLD_DAYS,
        };
      })
      .sort((a, b) => Number(b.overThreshold) - Number(a.overThreshold) || b.scenes.length - a.scenes.length);
  }, [backlog, owners]);

  const open = requests.filter((r) => r.status !== 'delivered' && r.status !== 'cancelled');
  const sixtyDaysAgo = Date.now() - 60 * 86_400_000;
  const completed = requests.filter(
    (r) => r.status === 'delivered'
      && new Date(r.delivered_at ?? r.created_at).getTime() >= sixtyDaysAgo,
  );

  /** Files a shoot delivered, and how many of them content actually used. */
  const usage = useCallback((requestId: string): { files: number; usedPct: number | null } => {
    const files = shootAssets.filter((a) => a.shoot_request_id === requestId);
    if (files.length === 0) return { files: 0, usedPct: null };
    const linked = new Set(assetLinks.map((l) => l.asset_id));
    const used = files.filter((f) => linked.has(f.id)).length;
    return { files: files.length, usedPct: Math.round((used / files.length) * 100) };
  }, [shootAssets, assetLinks]);

  /** How many content records an open request unblocks — the «يفكّ» column. */
  const unblocks = (requestId: string): number =>
    new Set(items.filter((i) => i.request_id === requestId && i.content_id).map((i) => i.content_id)).size;

  const setStatus = async (r: MosShootRequest, status: MosShootRequest['status']): Promise<void> => {
    try {
      // Delivered is not just a status — it flips the waiting scenes too.
      if (status === 'delivered') {
        const res = await deliverShoot(r.id);
        setRequests(res.requests);
        setItems(res.items);
        addToast(
          isAr
            ? `سُلِّم — عُلِّمت ${num(res.scenes_marked, true)} لقطة منتظرة كمتوفرة.`
            : `Delivered — ${res.scenes_marked} waiting shots marked covered.`,
          'success',
        );
      } else {
        const res = await saveShoot({ id: r.id, status });
        setRequests(res.requests);
        addToast(isAr ? 'حُدِّثت الحالة.' : 'Status updated.', 'success');
      }
      setOpenRequest(null);
      void load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const toggle = async (item: MosShootItem): Promise<void> => {
    try {
      const res = await toggleShootItem(item.id, !item.done);
      setItems((cur) => cur.map((i) => (i.id === item.id ? res.item : i)));
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <>
      <PageHead
        title={isAr ? 'طلبات التصوير' : 'Shoot requests'}
        crumb={
          <>
            <button type="button" onClick={() => navigate('/m/library')}>
              {isAr ? 'مكتبة المواد' : 'Asset library'}
            </button>
            <span className="sep">/</span>
            <span>{isAr ? 'طلبات التصوير' : 'Shoot requests'}</span>
          </>
        }
        sub={isAr
          ? `${num(open.length, true)} مفتوح · ${num(suggestions.length, true)} مقترح · ${num(backlog.length, true)} لقطة منتظرة`
          : `${open.length} open · ${suggestions.length} suggested · ${backlog.length} shots waiting`}
      >
        <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
        {can('manage_assets') && (
          <button
            type="button"
            className="btn btn-p"
            onClick={() => setCreating({ sceneIds: [], projectId: null })}
          >
            <IconPlus />
            {isAr ? 'طلب تصوير جديد' : 'New shoot request'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && requests.length === 0 && backlog.length === 0 && <Skeleton rows={5} />}

        {!loading && requests.length === 0 && backlog.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا لقطات ناقصة' : 'Nothing is missing'}
            body={isAr
              ? 'كل مشهد في كل فيديو لديه تصوير. طلبات التصوير تتولّد من المشاهد المعلَّمة «ناقصة».'
              : 'Every scene in every video has footage. Shoot requests come from scenes marked missing.'}
          />
        )}

        {/* ── المفتوحة ─────────────────────────────────────────────── */}
        {open.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-h">
              <h4>{isAr ? 'مفتوحة' : 'Open'}</h4>
              <span className="r">{num(open.length, isAr)}</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 74 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                    <th>{isAr ? 'الطلب' : 'Request'}</th>
                    <th style={{ width: 126 }}>{isAr ? 'المشروع' : 'Project'}</th>
                    <th style={{ width: 150 }}>{isAr ? 'الموعد' : 'When'}</th>
                    <th className="num" style={{ width: 80 }}>{isAr ? 'لقطات' : 'Shots'}</th>
                    <th style={{ width: 110 }}>{isAr ? 'يفكّ' : 'Unblocks'}</th>
                    <th style={{ width: 100 }}>{isAr ? 'الحالة' : 'Status'}</th>
                    <th style={{ width: 74 }} />
                  </tr>
                </thead>
                <tbody>
                  {open.map((r) => {
                    const rows = items.filter((i) => i.request_id === r.id);
                    const done = rows.filter((i) => i.done).length;
                    const freed = unblocks(r.id);
                    return (
                      <tr key={r.id} className={r.status === 'scheduled' ? 'hl' : undefined}>
                        <td className="id">{r.ref}</td>
                        <td className="ttl">{r.title}</td>
                        <td>{r.project_id ? projectName(r.project_id) : '—'}</td>
                        <td style={{ color: 'var(--mute)' }}>
                          {r.scheduled_at ? dateTime(r.scheduled_at, isAr) : (isAr ? 'بلا موعد' : 'not set')}
                        </td>
                        <td className="num">{num(done, isAr)} / {num(rows.length, isAr)}</td>
                        <td>
                          {freed > 0 ? (
                            <Pill tone="now">
                              {isAr ? `${num(freed, true)} سجلات` : `${freed} records`}
                            </Pill>
                          ) : '—'}
                        </td>
                        <td>
                          <Pill tone={TONE[r.status] ?? 'idle'}>
                            {(isAr ? SHOOT_STATUS_LABELS[r.status]?.ar : SHOOT_STATUS_LABELS[r.status]?.en) ?? r.status}
                          </Pill>
                        </td>
                        <td>
                          <button type="button" className="btn btn-sm" onClick={() => setOpenRequest(r)}>
                            {isAr ? 'فتح' : 'Open'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── مقترحة تلقائيًا — الميزة ─────────────────────────────── */}
        {suggestions.length > 0 && (
          <div
            className="card"
            style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--gold) 45%, transparent)' }}
          >
            <div className="card-h" style={{ background: 'color-mix(in srgb, var(--gold) 9%, transparent)' }}>
              <h4>{isAr ? 'مقترحة تلقائيًا' : 'Suggested automatically'}</h4>
              <span className="r">{isAr ? 'تراكمت لقطات كافية' : 'enough shots have piled up'}</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>{isAr ? 'المشروع' : 'Project'}</th>
                    <th>{isAr ? 'اللقطات المنتظرة' : 'The waiting shots'}</th>
                    <th className="num" style={{ width: 70 }}>{isAr ? 'العدد' : 'Count'}</th>
                    <th style={{ width: 130 }}>{isAr ? 'أقدم انتظار' : 'Oldest wait'}</th>
                    <th style={{ width: 150 }} />
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map((g) => (
                    <tr key={g.projectId ?? 'none'}>
                      <td className="ttl">{g.projectId ? projectName(g.projectId) : (isAr ? 'بلا مشروع' : 'No project')}</td>
                      <td style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
                        {g.scenes
                          .map((s) => s.visual || (isAr ? `مشهد ${num(s.position, true)}` : `Scene ${s.position}`))
                          .slice(0, 4)
                          .join(' · ')}
                        {g.scenes.length > 4 && ` +${num(g.scenes.length - 4, isAr)}`}
                      </td>
                      <td className="num" style={{ fontWeight: 700 }}>{num(g.scenes.length, isAr)}</td>
                      <td style={g.waitedDays >= THRESHOLD_DAYS ? { color: 'var(--wait)', fontWeight: 700 } : undefined}>
                        {g.oldest ? daysAgo(g.oldest, isAr) : '—'}
                      </td>
                      <td>
                        {can('manage_assets') && (
                          <button
                            type="button"
                            className={`btn btn-sm${g.overThreshold ? ' btn-p' : ' btn-d'}`}
                            onClick={() => setCreating({
                              sceneIds: g.scenes.map((s) => s.id),
                              projectId: g.projectId,
                            })}
                          >
                            {g.overThreshold
                              ? isAr ? 'جدولة رحلة' : 'Schedule a trip'
                              : isAr ? 'أقل من العتبة' : 'Under the threshold'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-b" style={{ borderTop: '1px solid var(--line-soft)', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.85 }}>
              {isAr
                ? <>العتبة الحالية <b>{num(THRESHOLD_SHOTS, true)} لقطات أو انتظار {num(THRESHOLD_DAYS, true)} يومًا</b>، أيهما أسبق. النظام يعرف كل لقطة ناقصة عبر كل المشاريع — لا ينتظر أن يتذكر أحد.</>
                : <>The current threshold is <b>{THRESHOLD_SHOTS} shots or {THRESHOLD_DAYS} days waiting</b>, whichever comes first. The system knows every missing shot across every project — it does not wait for someone to remember.</>}
            </div>
          </div>
        )}

        {/* ── مكتملة — ونسبة الاستخدام ─────────────────────────────── */}
        {completed.length > 0 && (
          <div className="card">
            <div className="card-h">
              <h4>{isAr ? 'مكتملة' : 'Completed'}</h4>
              <span className="r">{isAr ? 'آخر ٦٠ يومًا' : 'last 60 days'}</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 74 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                    <th>{isAr ? 'الطلب' : 'Request'}</th>
                    <th style={{ width: 126 }}>{isAr ? 'المشروع' : 'Project'}</th>
                    <th style={{ width: 110 }}>{isAr ? 'التاريخ' : 'Date'}</th>
                    <th className="num" style={{ width: 84 }}>{isAr ? 'ملفات' : 'Files'}</th>
                    <th className="num" style={{ width: 110 }}>{isAr ? 'استُخدم منها' : 'Used'}</th>
                  </tr>
                </thead>
                <tbody>
                  {completed.map((r) => {
                    const u = usage(r.id);
                    return (
                      <tr key={r.id}>
                        <td className="id">{r.ref}</td>
                        <td className="ttl">{r.title}</td>
                        <td>{r.project_id ? projectName(r.project_id) : '—'}</td>
                        <td style={{ color: 'var(--mute)' }}>{shortDate(r.delivered_at ?? r.created_at, isAr)}</td>
                        <td className="num">{u.files > 0 ? num(u.files, isAr) : '—'}</td>
                        <td
                          className="num"
                          style={u.usedPct === null
                            ? { color: 'var(--mute)' }
                            : u.usedPct >= 70
                              ? { color: 'var(--go)', fontWeight: 700 }
                              : { color: 'var(--late)', fontWeight: 700 }}
                        >
                          {u.usedPct === null ? '—' : `${num(u.usedPct, isAr)}${isAr ? '٪' : '%'}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="card-b" style={{ borderTop: '1px solid var(--line-soft)', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.85 }}>
              {isAr
                ? <>نسبة الاستخدام هي التغذية الراجعة الوحيدة على جودة موجز التصوير. أي تصوير تحت <b>٧٠٪</b> يستحق موجزًا أدق في المرة القادمة، لا لومًا للمصوّر.</>
                : <>The usage ratio is the only feedback on shoot-brief quality. Anything under <b>70%</b> deserves a sharper brief next time, not blame for the photographer.</>}
            </div>
          </div>
        )}
      </div>

      {creating && (
        <ShootModal
          isAr={isAr}
          sceneIds={creating.sceneIds}
          projectId={creating.projectId}
          onClose={() => setCreating(null)}
          onSaved={() => { setCreating(null); void load(); }}
        />
      )}

      {openRequest && (
        <Modal
          title={openRequest.title}
          sub={openRequest.ref ?? undefined}
          onClose={() => setOpenRequest(null)}
          wide
          footer={
            can('manage_assets') ? (
              <>
                <span className="note">
                  {isAr
                    ? '«تسليم» يعلّم كل اللقطات المنتظرة كمتوفرة دفعة واحدة.'
                    : '“Deliver” marks every waiting shot covered in one go.'}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => navigate(`/m/library/upload?shoot=${openRequest.id}`)}
                >
                  <IconShoot />
                  {isAr ? 'رفع ملفات هذا الطلب' : 'Upload this shoot’s files'}
                </button>
                {(['scheduled', 'shot'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`btn btn-sm${openRequest.status === s ? ' btn-p' : ''}`}
                    onClick={() => void setStatus(openRequest, s)}
                  >
                    {isAr ? SHOOT_STATUS_LABELS[s]?.ar : SHOOT_STATUS_LABELS[s]?.en}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-go btn-sm"
                  onClick={() => void setStatus(openRequest, 'delivered')}
                >
                  <IconCheck />
                  {isAr ? 'تسليم' : 'Deliver'}
                </button>
              </>
            ) : undefined
          }
        >
          {items.filter((i) => i.request_id === openRequest.id).length === 0 ? (
            <div className="drop">{isAr ? 'لا لقطات في هذا الطلب.' : 'No shots on this request.'}</div>
          ) : (
            items
              .filter((i) => i.request_id === openRequest.id)
              .map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className={`chk ${i.done ? 'ok' : 'no'}`}
                  style={{ width: '100%', textAlign: 'start', background: 'transparent', border: 0, cursor: 'pointer' }}
                  disabled={!can('manage_assets')}
                  onClick={() => void toggle(i)}
                >
                  <IconCheck />
                  <span style={{ textDecoration: i.done ? 'line-through' : undefined }}>{i.description}</span>
                </button>
              ))
          )}
        </Modal>
      )}
    </>
  );
}

function ShootModal({
  isAr, sceneIds, projectId, onClose, onSaved,
}: {
  isAr: boolean;
  sceneIds: string[];
  projectId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { projects } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(projectId ?? '');
  const [when, setWhen] = useState('');
  const [location, setLocation] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      addToast(isAr ? 'اكتب عنوانًا للطلب.' : 'Give the request a title.', 'error');
      return;
    }
    setBusy(true);
    try {
      await saveShoot(
        {
          title: title.trim(),
          project_id: project || null,
          scheduled_at: when ? new Date(when).toISOString() : null,
          location: location || null,
          note: note || null,
          status: when ? 'scheduled' : 'requested',
        },
        sceneIds,
      );
      addToast(isAr ? 'أُنشئ طلب التصوير.' : 'Shoot request raised.', 'success');
      onSaved();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'طلب تصوير' : 'Shoot request'}
      sub={sceneIds.length > 0
        ? isAr
          ? `${num(sceneIds.length, true)} لقطة ناقصة ستُنقل إلى هذا الطلب.`
          : `${sceneIds.length} missing shots will be carried onto this request.`
        : isAr
          ? 'طلب مستقل — أضف اللقطات لاحقًا من المشاهد الناقصة.'
          : 'A standalone request — add shots later from the missing scenes.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ…' : 'Working…') : isAr ? 'إنشاء الطلب' : 'Raise request'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'العنوان' : 'Title'}>
        <input className="inp" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المشروع' : 'Project'}>
          <select className="inp" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">{isAr ? 'بدون' : 'None'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
            ))}
          </select>
        </Field>
        <Field label={isAr ? 'الموعد' : 'When'}>
          <input type="datetime-local" className="inp" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
      </div>
      <Field label={isAr ? 'الموقع' : 'Location'}>
        <input className="inp" value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
      <Field label={isAr ? 'ملاحظة' : 'Note'}>
        <textarea className="inp" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
