/**
 * Goals — the spend side's strategic layer.
 *
 * A goal is a SIMPLE, reusable objective (a name + a description) that campaigns
 * are grouped under. Every campaign serves at least one; a goal can hold many.
 * This page is the registry: create goals, edit them, deactivate the ones that
 * are done, and see at a glance how many campaigns each one carries.
 *
 * Managing goals (create/edit/deactivate) is gated by `approve_budget` — the
 * same capability that lets a role create a campaign — so anyone who can spend
 * can also name what the spend is for.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { MosGoal, deleteGoals, fetchGoals, saveGoal, successMeasureSuffix } from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton } from './components/kit';
import { IconGoals, IconPlus } from './components/icons';
import { num } from './lib/format';
import SuccessMeasuresEditor, {
  MeasureDraft, measuresToDrafts, draftsToMeasures,
} from './components/SuccessMeasuresEditor';

export default function GoalsPage() {
  const { isAr, can } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const canManage = can('approve_budget');

  const [rows, setRows] = useState<MosGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MosGoal | null>(null);
  const [creating, setCreating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  // Multi-select for bulk delete — same pattern as ContentListPage/CampaignsPage.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows((await fetchGoals()).goals);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(
    () => rows.filter((g) => showInactive || g.is_active),
    [rows, showInactive],
  );
  const inactiveCount = useMemo(() => rows.filter((g) => !g.is_active).length, [rows]);

  // Prune the selection whenever the visible set changes — a card hidden by
  // the inactive toggle must never ride invisibly into a bulk delete.
  useEffect(() => {
    setSelected((prev) => {
      const shown = new Set(visible.map((g) => g.id));
      const next = new Set([...prev].filter((id) => shown.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);

  const toggleOne = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const bulkDelete = async (): Promise<void> => {
    if (selected.size === 0 || deleting) return;
    setDeleting(true);
    try {
      const res = await deleteGoals([...selected]);
      addToast(
        isAr ? `حُذفت ${num(res.deleted, true)} من الأهداف.` : `Deleted ${res.deleted} goal(s).`,
        'success',
      );
      setRows(res.goals);
      setSelected(new Set());
      setConfirmOpen(false);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setDeleting(false);
    }
  };

  const sub = isAr
    ? `${num(rows.filter((g) => g.is_active).length, true)} هدفًا نشطًا · كل حملة تخدم هدفًا واحدًا على الأقل`
    : `${rows.filter((g) => g.is_active).length} active goals · every campaign serves at least one`;

  return (
    <>
      <PageHead title={isAr ? 'الأهداف' : 'Goals'} sub={sub}>
        {canManage && (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            <IconPlus />
            {isAr ? 'هدف جديد' : 'New goal'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={4} />}

        {!loading && rows.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا أهداف بعد' : 'No goals yet'}
            body={isAr
              ? 'الهدف يجمع الحملات تحت غاية واحدة، فيمكنك أن تسأل: أي حملات تخدم هذا الهدف؟ كل حملة جديدة تُربط بهدف واحد على الأقل.'
              : 'A goal groups campaigns under one purpose, so you can ask: which campaigns serve this goal? Every new campaign links to at least one.'}
          >
            {canManage && (
              <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
                <IconPlus />
                {isAr ? 'هدف جديد' : 'New goal'}
              </button>
            )}
          </Empty>
        )}

        {rows.length > 0 && (
          <>
            {inactiveCount > 0 && (
              <div className="filt">
                <button
                  type="button"
                  className={`fbtn${showInactive ? ' on' : ''}`}
                  onClick={() => setShowInactive((v) => !v)}
                >
                  {isAr
                    ? `المعطّلة (${num(inactiveCount, true)})`
                    : `Inactive (${inactiveCount})`}
                </button>
              </div>
            )}

            {canManage && selected.size > 0 && (
              <div
                className="card"
                style={{ padding: '10px 14px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}
              >
                <b style={{ fontSize: 12.5 }}>
                  {isAr ? `${num(selected.size, true)} محدد` : `${selected.size} selected`}
                </b>
                <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>
                  {isAr ? 'إلغاء التحديد' : 'Clear'}
                </button>
                <button
                  type="button"
                  className="btn btn-d btn-sm"
                  style={{ marginInlineStart: 'auto' }}
                  onClick={() => setConfirmOpen(true)}
                >
                  {isAr ? `حذف (${num(selected.size, true)})` : `Delete (${selected.size})`}
                </button>
              </div>
            )}

            <div className="grid" style={{ gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
              {visible.map((g) => (
                <div
                  key={g.id}
                  className="card"
                  style={{
                    padding: 16,
                    opacity: g.is_active ? 1 : 0.6,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 9,
                    ...(selected.has(g.id)
                      ? { background: 'color-mix(in srgb, var(--copper) 9%, transparent)' }
                      : undefined),
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    {canManage && (
                      <input
                        type="checkbox"
                        checked={selected.has(g.id)}
                        onChange={() => toggleOne(g.id)}
                        aria-label={isAr ? `تحديد ${g.name}` : `Select ${g.name}`}
                      />
                    )}
                    <span style={{ color: 'var(--copper)', display: 'inline-flex' }}>
                      <IconGoals style={{ width: 18, height: 18 }} />
                    </span>
                    <b style={{ fontSize: 14.5, flex: 1, minWidth: 0 }}>{g.name}</b>
                    {!g.is_active && (
                      <Pill tone="idle">{isAr ? 'معطّل' : 'Inactive'}</Pill>
                    )}
                  </div>
                  {g.description && (
                    <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                      {g.description}
                    </div>
                  )}
                  {Array.isArray(g.success_measures) && g.success_measures.length > 0 && (
                    <div style={{ display: 'grid', gap: 4 }}>
                      {g.success_measures.map((m, i) => (
                        <div key={`${m.type_key}-${i}`} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'baseline' }}>
                          <span style={{ color: 'var(--copper)' }}>{i === 0 ? '★' : '·'}</span>
                          <span style={{ color: 'var(--mute)', flex: 1, minWidth: 0 }}>
                            {isAr ? m.label_ar : m.label_en}
                          </span>
                          <b style={{ whiteSpace: 'nowrap' }}>
                            {m.threshold !== null ? num(m.threshold, isAr) : '—'}{' '}
                            <span style={{ fontWeight: 400, color: 'var(--mute)', fontSize: 11 }}>
                              {successMeasureSuffix(m.direction, m.unit, isAr)}
                            </span>
                          </b>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto', paddingTop: 4 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ fontSize: 11.5 }}
                      onClick={() => navigate(`/m/campaigns?goal=${g.id}`)}
                      title={isAr ? 'عرض حملات هذا الهدف' : 'View this goal’s campaigns'}
                    >
                      {g.campaign_count === 0
                        ? (isAr ? 'لا حملات' : 'No campaigns')
                        : isAr
                          ? `${num(g.campaign_count, true)} ${g.campaign_count === 1 ? 'حملة' : g.campaign_count === 2 ? 'حملتان' : 'حملات'}`
                          : `${g.campaign_count} campaign${g.campaign_count === 1 ? '' : 's'}`}
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ marginInlineStart: 'auto', fontSize: 11.5 }}
                        onClick={() => setEditing(g)}
                      >
                        {isAr ? 'تعديل' : 'Edit'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {(creating || editing) && (
        <GoalModal
          goal={editing}
          isAr={isAr}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={(goals) => { setRows(goals); setCreating(false); setEditing(null); }}
        />
      )}

      {confirmOpen && (
        <Modal
          title={isAr ? 'حذف الأهداف' : 'Delete goals'}
          sub={isAr
            ? `ستُحذف ${num(selected.size, true)} من الأهداف نهائيًا — لا يمكن التراجع. الحملات المرتبطة تبقى، ويُفك ربطها بالهدف فقط.`
            : `${selected.size} goal(s) will be permanently deleted — this cannot be undone. Linked campaigns survive; only the link is removed.`}
          onClose={() => { if (!deleting) setConfirmOpen(false); }}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmOpen(false)} disabled={deleting}>
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <button type="button" className="btn btn-d" onClick={() => void bulkDelete()} disabled={deleting}>
                {deleting
                  ? isAr ? 'جارٍ الحذف…' : 'Deleting…'
                  : isAr ? `حذف ${num(selected.size, true)}` : `Delete ${selected.size}`}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.8 }}>
            {[...selected]
              .map((id) => rows.find((g) => g.id === id))
              .filter((g): g is MosGoal => g !== undefined)
              .map((g) => (
                <div key={g.id}>
                  {g.name}
                  {g.campaign_count > 0 && (
                    <span style={{ fontSize: 11.5, marginInlineStart: 6 }}>
                      {isAr
                        ? `(${num(g.campaign_count, true)} ${g.campaign_count === 1 ? 'حملة مرتبطة' : 'حملات مرتبطة'})`
                        : `(${g.campaign_count} linked campaign${g.campaign_count === 1 ? '' : 's'})`}
                    </span>
                  )}
                </div>
              ))}
          </div>
        </Modal>
      )}
    </>
  );
}

function GoalModal({
  goal, isAr, onClose, onSaved,
}: {
  goal: MosGoal | null;
  isAr: boolean;
  onClose: () => void;
  onSaved: (goals: MosGoal[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const isNew = !goal;
  const [name, setName] = useState(goal?.name ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [measures, setMeasures] = useState<MeasureDraft[]>(() => measuresToDrafts(goal?.success_measures));
  const [isActive, setIsActive] = useState(goal?.is_active ?? true);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      addToast(isAr ? 'اكتب اسمًا للهدف.' : 'Give the goal a name.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await saveGoal({
        id: goal?.id,
        name: name.trim(),
        description: description.trim() || null,
        success_measures: draftsToMeasures(measures),
        is_active: isActive,
      });
      addToast(
        isNew ? (isAr ? 'أُنشئ الهدف.' : 'Goal created.') : (isAr ? 'حُفظ الهدف.' : 'Goal saved.'),
        'success',
      );
      onSaved(res.goals);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? (isAr ? 'هدف جديد' : 'New goal') : (isAr ? 'تعديل الهدف' : 'Edit goal')}
      sub={isAr
        ? 'اسم قصير وشرح موجز. الحملات تُربط بهذا الهدف من شاشة الحملة.'
        : 'A short name and a brief description. Campaigns link to it from the campaign screen.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy
              ? (isAr ? 'جارٍ الحفظ…' : 'Saving…')
              : isNew ? (isAr ? 'إنشاء الهدف' : 'Create goal') : (isAr ? 'حفظ' : 'Save')}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'الاسم' : 'Name'}>
        <input
          className="inp"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder={isAr ? 'نمو مؤهلي الرياض ٢٠٢٦' : 'Grow Riyadh qualified leads 2026'}
        />
      </Field>
      <Field label={isAr ? 'الوصف' : 'Description'} hint={isAr ? 'اختياري' : 'optional'}>
        <textarea
          className="inp"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={isAr
            ? 'ما الذي يعنيه هذا الهدف، ومتى نعتبره متحققًا.'
            : 'What this goal means, and how we know it is met.'}
        />
      </Field>
      <SuccessMeasuresEditor measures={measures} onChange={setMeasures} isAr={isAr} />
      {!isNew && (
        <Field label={isAr ? 'الحالة' : 'Status'}>
          <div className="seg" style={{ width: '100%' }}>
            <button
              type="button"
              className={isActive ? 'on' : ''}
              style={{ flex: 1, textAlign: 'center' }}
              onClick={() => setIsActive(true)}
            >
              {isAr ? 'نشط' : 'Active'}
            </button>
            <button
              type="button"
              className={!isActive ? 'on' : ''}
              style={{ flex: 1, textAlign: 'center' }}
              onClick={() => setIsActive(false)}
            >
              {isAr ? 'معطّل' : 'Inactive'}
            </button>
          </div>
        </Field>
      )}
    </Modal>
  );
}
