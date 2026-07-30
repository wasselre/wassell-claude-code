/**
 * Shoot requests — design screens 24 and 42.
 *
 * The backlog is DERIVED: every scene still marked "missing" is a shot somebody
 * has to go and film, whether or not anyone has raised a request for it yet.
 * That is why this page shows two things — the open requests, and the scenes
 * that nobody has asked for.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosShootItem, MosShootRequest, SHOOT_STATUS_LABELS,
  fetchShoots, saveShoot, toggleShootItem,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton } from './components/kit';
import { IconCheck, IconPlus, IconShoot } from './components/icons';
import { dateTime, num } from './lib/format';

const TONE: Record<string, 'idle' | 'now' | 'go' | 'live'> = {
  requested: 'idle',
  scheduled: 'now',
  shot: 'go',
  delivered: 'live',
  cancelled: 'idle',
};

interface MissingScene {
  id: string;
  content_id: string;
  position: number;
  visual: string | null;
}

export default function ShootsPage() {
  const { isAr, can, projectName } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);

  const [requests, setRequests] = useState<MosShootRequest[]>([]);
  const [items, setItems] = useState<MosShootItem[]>([]);
  const [missing, setMissing] = useState<MissingScene[]>([]);
  const [owners, setOwners] = useState<Array<{ id: string; ref: string | null; title: string; project_id: string | null }>>([]);
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
        id: s.id, content_id: s.content_id, position: s.position, visual: s.visual,
      })));
      setOwners(res.scene_owners);
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

  const backlogByContent = useMemo(() => {
    const m = new Map<string, MissingScene[]>();
    for (const s of backlog) {
      const list = m.get(s.content_id) ?? [];
      list.push(s);
      m.set(s.content_id, list);
    }
    return Array.from(m.entries());
  }, [backlog]);

  const setStatus = async (r: MosShootRequest, status: MosShootRequest['status']): Promise<void> => {
    try {
      const res = await saveShoot({ id: r.id, status });
      setRequests(res.requests);
      addToast(isAr ? 'حُدِّثت الحالة.' : 'Status updated.', 'success');
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

  const open = requests.filter((r) => r.status !== 'delivered' && r.status !== 'cancelled');

  return (
    <>
      <PageHead
        title={isAr ? 'طلبات التصوير' : 'Shoot requests'}
        sub={isAr
          ? `${num(open.length, true)} طلبًا مفتوحًا · ${num(backlog.length, true)} لقطة ناقصة لم تُطلب بعد`
          : `${open.length} open requests · ${backlog.length} missing shots not yet requested`}
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
            {isAr ? 'طلب تصوير' : 'New shoot request'}
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

        {requests.length > 0 && (
          <>
            <div className="lbl" style={{ marginBottom: 9 }}>{isAr ? 'الطلبات' : 'Requests'}</div>
            <div className="card" style={{ marginBottom: 22 }}>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 80 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                      <th>{isAr ? 'الطلب' : 'Request'}</th>
                      <th style={{ width: 130 }}>{isAr ? 'المشروع' : 'Project'}</th>
                      <th style={{ width: 170 }}>{isAr ? 'الموعد' : 'When'}</th>
                      <th style={{ width: 90 }}>{isAr ? 'اللقطات' : 'Shots'}</th>
                      <th style={{ width: 110 }}>{isAr ? 'الحالة' : 'Status'}</th>
                      <th style={{ width: 90 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => {
                      const rows = items.filter((i) => i.request_id === r.id);
                      const done = rows.filter((i) => i.done).length;
                      return (
                        <tr key={r.id}>
                          <td className="id">{r.ref}</td>
                          <td className="ttl">{r.title}</td>
                          <td>{r.project_id ? projectName(r.project_id) : '—'}</td>
                          <td style={{ color: 'var(--mute)' }}>
                            {r.scheduled_at ? dateTime(r.scheduled_at, isAr) : (isAr ? 'بلا موعد' : 'not scheduled')}
                          </td>
                          <td className="num">
                            {num(done, isAr)} / {num(rows.length, isAr)}
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
          </>
        )}

        {backlogByContent.length > 0 && (
          <>
            <div className="lbl" style={{ marginBottom: 9 }}>
              {isAr ? 'لقطات ناقصة لم تُطلب بعد' : 'Missing shots nobody has requested'}
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {backlogByContent.map(([contentId, scenes]) => {
                const owner = owners.find((o) => o.id === contentId);
                return (
                  <div key={contentId} className="card">
                    <div className="card-h">
                      <h4>
                        <span className="ltr" style={{ color: 'var(--mute)' }}>{owner?.ref ?? ''}</span>{' '}
                        {owner?.title ?? contentId.slice(0, 8)}
                      </h4>
                      <span className="r">
                        {isAr ? `${num(scenes.length, true)} لقطة` : `${scenes.length} shots`}
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => navigate(`/m/content/${contentId}`)}
                      >
                        {isAr ? 'العنصر' : 'Item'}
                      </button>
                      {can('manage_assets') && (
                        <button
                          type="button"
                          className="btn btn-p btn-sm"
                          onClick={() => setCreating({
                            sceneIds: scenes.map((s) => s.id),
                            projectId: owner?.project_id ?? null,
                          })}
                        >
                          <IconShoot />
                          {isAr ? 'طلب تصوير' : 'Raise request'}
                        </button>
                      )}
                    </div>
                    <div className="card-b" style={{ padding: '10px 14px' }}>
                      {scenes.map((s) => (
                        <div key={s.id} className="chk no">
                          <IconShoot />
                          <span>
                            {isAr ? `مشهد ${num(s.position, true)}` : `Scene ${s.position}`}
                            {s.visual ? ` — ${s.visual}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
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
                  {isAr ? 'تعليم اللقطة يقول للمونتير إن المادة صارت متاحة.' : 'Ticking a shot tells the editor the material exists.'}
                </span>
                {(['scheduled', 'shot', 'delivered'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`btn btn-sm${openRequest.status === s ? ' btn-p' : ''}`}
                    onClick={() => void setStatus(openRequest, s)}
                  >
                    {isAr ? SHOOT_STATUS_LABELS[s]?.ar : SHOOT_STATUS_LABELS[s]?.en}
                  </button>
                ))}
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
