/**
 * «البوابات» — the client's registrations in developer / marketer broker
 * portals, one row per portal, managed like the client's options.
 *
 * Two statuses per row:
 *   - our status    — what WE know (registered / another broker's / failed …).
 *                     Set by every registration run; a rep can correct it.
 *   - portal status — exactly what the PORTAL says (e.g. «جديد» / «مفتوح»),
 *                     refreshed by the daily 12:00 status check or «تحديث الحالات».
 * Each row keeps its history (runs, checks, status changes, edits) and notes.
 *
 * Data: /api/portal-registration (registrations_for / registration_update /
 * registration_add / status_check) — see api/_lib/portalRegistrations.ts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Globe, RefreshCw, Plus, Loader2, ChevronDown, ChevronUp, Pencil, Check, X, History, AlertTriangle,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import {
  fetchClientRegistrations, updateClientRegistration, addClientRegistration, requestPortalStatusCheck,
  REGISTRATION_OUR_STATUSES,
  type ClientPortalRegistration, type RegistrationPortal, type RegistrationOurStatus,
} from '@/lib/portalRegistration/client';

interface Props {
  client: AppRecord;
  isAr: boolean;
  canEdit: boolean;
}

const STATUS_META: Record<RegistrationOurStatus, { ar: string; en: string; cls: string }> = {
  not_registered: { ar: 'غير مسجّل', en: 'Not registered', cls: 'bg-charcoal/10 text-charcoal/70' },
  registering: { ar: 'جارٍ التسجيل', en: 'Registering', cls: 'bg-copper/10 text-copper' },
  registered: { ar: 'مسجّل', en: 'Registered', cls: 'bg-green-100 text-green-800' },
  already_registered: { ar: 'لدى وسيط آخر', en: "Another broker's", cls: 'bg-sky-100 text-sky-800' },
  failed: { ar: 'فشل', en: 'Failed', cls: 'bg-red-100 text-red-800' },
};

const VIA_META: Record<string, { ar: string; en: string }> = {
  auto: { ar: 'تلقائي من الإعلان', en: 'Auto from ad' },
  manual_run: { ar: 'زر التسجيل', en: 'Register button' },
  manual_entry: { ar: 'أُضيف يدوياً', en: 'Added by hand' },
  portal_sync: { ar: 'وُجد في البوابة', en: 'Found in the portal' },
};

const LIVE_CHECK = new Set(['queued', 'running', 'awaiting_input']);
const POLL_MS = 15_000;

function fmtDate(iso: string | null, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // en-GB digits in both languages: ar-SA would switch to the Hijri calendar.
  return withTime
    ? d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB');
}

export default function ClientPortalsTab({ client, isAr, canEdit }: Props) {
  const addToast = useAppStore((s) => s.addToast);
  const [rows, setRows] = useState<ClientPortalRegistration[]>([]);
  const [portals, setPortals] = useState<RegistrationPortal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ our_status: RegistrationOurStatus; portal_status: string; portal_ref: string; notes: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetchClientRegistrations(client.id);
      setRows(res.registrations);
      setPortals(res.portals);
      setLoadError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ClientPortalsTab] load failed:', msg);
      setLoadError(msg);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [client.id]);

  useEffect(() => { void load(); }, [load]);

  const portalById = useMemo(() => new Map(portals.map((p) => [p.id, p])), [portals]);
  // Portals this client is in that can check statuses automatically.
  const checkablePortals = useMemo(
    () => rows.map((r) => portalById.get(r.portal_record_id)).filter((p): p is RegistrationPortal => !!p && p.can_check_status)
      .filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i),
    [rows, portalById],
  );
  const busy = rows.some((r) => r.our_status === 'registering')
    || checkablePortals.some((p) => p.last_check && LIVE_CHECK.has(p.last_check.status));

  // While a run or a status check is live, follow it without a manual refresh.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => { void load(true); }, POLL_MS);
    return () => clearInterval(t);
  }, [busy, load]);

  const lastCheckLabel = useMemo(() => {
    const done = checkablePortals.map((p) => p.last_check).filter((c) => c && c.status === 'done' && c.finished_at) as NonNullable<RegistrationPortal['last_check']>[];
    if (!done.length) return null;
    const sorted = done.map((c) => c.finished_at!).sort();
    const latest = sorted[sorted.length - 1]!;
    return fmtDate(latest, true);
  }, [checkablePortals]);

  const checkNow = async () => {
    if (!checkablePortals.length) return;
    setChecking(true);
    try {
      for (const p of checkablePortals) await requestPortalStatusCheck(p.id);
      addToast(
        isAr
          ? `طُلب فحص الحالات (${checkablePortals.length} بوابة) — سيصلك طلب الرمز على واتساب العمليات إن احتاجت البوابة رمزاً.`
          : `Status check requested (${checkablePortals.length} portal${checkablePortals.length > 1 ? 's' : ''}) — the ops WhatsApp will ask for a code if the portal needs one.`,
        'success',
      );
      await load(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ClientPortalsTab] status check failed:', msg);
      addToast(isAr ? `تعذّر طلب فحص الحالات: ${msg}` : `Could not request the status check: ${msg}`, 'error');
    } finally {
      setChecking(false);
    }
  };

  const startEdit = (r: ClientPortalRegistration) => {
    setEditing(r.id);
    setDraft({ our_status: r.our_status, portal_status: r.portal_status ?? '', portal_ref: r.portal_ref ?? '', notes: r.notes ?? '' });
  };

  const saveEdit = async (r: ClientPortalRegistration) => {
    if (!draft) return;
    setSaving(true);
    try {
      await updateClientRegistration(r.id, {
        our_status: draft.our_status,
        portal_status: draft.portal_status,
        portal_ref: draft.portal_ref,
        notes: draft.notes,
      });
      setEditing(null);
      setDraft(null);
      await load(true);
      addToast(isAr ? 'حُفظ التعديل' : 'Saved', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ClientPortalsTab] save failed:', msg);
      addToast(isAr ? `تعذّر الحفظ: ${msg}` : `Could not save: ${msg}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggle = (id: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-charcoal/60">
        <Loader2 size={16} className="animate-spin" /> {isAr ? 'جارٍ تحميل تسجيلات البوابات…' : 'Loading portal registrations…'}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <div>{isAr ? 'تعذّر تحميل تسجيلات البوابات.' : 'Could not load the portal registrations.'}</div>
          <div className="mt-1 text-xs opacity-80">{loadError}</div>
        </div>
        <Button variant="secondary" onClick={() => void load()}>{isAr ? 'إعادة المحاولة' : 'Retry'}</Button>
      </div>
    );
  }

  const usedPortalIds = new Set(rows.map((r) => r.portal_record_id));
  const addablePortals = portals.filter((p) => p.is_active && !usedPortalIds.has(p.id));

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Globe size={18} className="text-copper" />
        <span className="text-base font-bold text-charcoal">
          {isAr ? `تسجيلات العميل في البوابات (${rows.length})` : `Portal registrations (${rows.length})`}
        </span>
        <span className="ms-auto text-xs text-charcoal/50">
          {lastCheckLabel
            ? (isAr ? `آخر فحص للحالات: ${lastCheckLabel}` : `Statuses last checked: ${lastCheckLabel}`)
            : checkablePortals.length
              ? (isAr ? 'لم تُفحص الحالات بعد' : 'Statuses not checked yet')
              : null}
        </span>
        {checkablePortals.length > 0 && (
          <Button variant="secondary" onClick={() => void checkNow()} disabled={checking}>
            {checking ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            {isAr ? 'تحديث الحالات' : 'Check statuses'}
          </Button>
        )}
        {canEdit && addablePortals.length > 0 && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus size={15} />
            {isAr ? 'تسجيل يدوي' : 'Add manually'}
          </Button>
        )}
      </div>

      {rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-sand p-6 text-center text-sm text-charcoal/60">
          {isAr
            ? 'لم يُسجَّل هذا العميل في أي بوابة بعد. يُسجَّل عملاء الإعلانات تلقائياً، ويمكن التسجيل من زر «التسجيل في البوابة» في المحادثة، أو إضافة تسجيل تمّ خارج التطبيق يدوياً.'
            : 'This client is not in any portal yet. Ad leads register automatically; you can also register from «Register in portal» in the chat, or add one made outside the app by hand.'}
        </div>
      )}

      {rows.map((r) => {
        const meta = STATUS_META[r.our_status];
        const portal = portalById.get(r.portal_record_id);
        const isEditing = editing === r.id && !!draft;
        const open = expanded.has(r.id);
        // A check stamps last_checked_at on every client it FINDS, while it runs —
        // so "not seen" = no stamp since that check was created.
        const lastCheck = portal?.last_check;
        const notSeenInLastCheck = !!lastCheck && lastCheck.status === 'done' && r.our_status === 'registered'
          && (!r.last_checked_at || new Date(r.last_checked_at).getTime() < new Date(lastCheck.created_at).getTime());
        return (
          <div key={r.id} className="rounded-xl border border-sand/40 bg-white">
            <div className="flex flex-wrap items-start gap-x-6 gap-y-2 p-3">
              <div className="min-w-[180px] flex-1">
                <div className="font-bold text-charcoal">{portal?.name ?? '—'}</div>
                <div className="text-xs text-charcoal/60">
                  {r.project_names.length ? r.project_names.join('، ') : (isAr ? 'بدون مشروع محدد' : 'No project recorded')}
                  {r.registered_as.length > 0 && r.registered_as.join() !== r.project_names.join() && (
                    <span className="text-charcoal/40"> · {isAr ? 'سُجّل تحت' : 'registered as'}: {r.registered_as.join('، ')}</span>
                  )}
                </div>
              </div>

              <div>
                <div className="text-[11px] text-charcoal/50">{isAr ? 'حالتنا' : 'Our status'}</div>
                {isEditing ? (
                  <select
                    className="mt-0.5 rounded-lg border border-sand px-2 py-1 text-sm"
                    value={draft!.our_status}
                    onChange={(e) => setDraft({ ...draft!, our_status: e.target.value as RegistrationOurStatus })}
                  >
                    {REGISTRATION_OUR_STATUSES.map((s) => (
                      <option key={s} value={s}>{isAr ? STATUS_META[s].ar : STATUS_META[s].en}</option>
                    ))}
                  </select>
                ) : (
                  <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>{isAr ? meta.ar : meta.en}</span>
                )}
              </div>

              <div>
                <div className="text-[11px] text-charcoal/50">{isAr ? 'حالة البوابة' : 'Portal status'}</div>
                {isEditing ? (
                  <input
                    className="mt-0.5 w-32 rounded-lg border border-sand px-2 py-1 text-sm"
                    value={draft!.portal_status}
                    placeholder={isAr ? 'مثل: مفتوح' : 'e.g. Open'}
                    onChange={(e) => setDraft({ ...draft!, portal_status: e.target.value })}
                  />
                ) : r.portal_status ? (
                  <div>
                    <span className="mt-0.5 inline-block rounded-full bg-gold/15 px-2 py-0.5 text-xs font-medium text-chocolate">{r.portal_status}</span>
                    {r.portal_status_changed_at && (
                      <div className="text-[11px] text-charcoal/40">{isAr ? 'منذ' : 'since'} {fmtDate(r.portal_status_changed_at)}</div>
                    )}
                  </div>
                ) : (
                  <span className="text-sm text-charcoal/40">—</span>
                )}
              </div>

              <div>
                <div className="text-[11px] text-charcoal/50">{isAr ? 'رقم البوابة' : 'Portal ref'}</div>
                {isEditing ? (
                  <input
                    className="mt-0.5 w-24 rounded-lg border border-sand px-2 py-1 text-sm"
                    value={draft!.portal_ref}
                    dir="ltr"
                    onChange={(e) => setDraft({ ...draft!, portal_ref: e.target.value })}
                  />
                ) : (
                  <span className="font-mono text-sm text-charcoal" dir="ltr">{r.portal_ref ?? '—'}</span>
                )}
              </div>

              <div>
                <div className="text-[11px] text-charcoal/50">{isAr ? 'تاريخ التسجيل' : 'Registered'}</div>
                <div className="text-sm text-charcoal">{fmtDate(r.registered_at)}</div>
                {(() => {
                  const via = r.registered_via ? VIA_META[r.registered_via] : undefined;
                  return via ? <div className="text-[11px] text-charcoal/40">{isAr ? via.ar : via.en}</div> : null;
                })()}
              </div>

              <div className="ms-auto flex items-center gap-1">
                {canEdit && !isEditing && (
                  <button type="button" className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream hover:text-charcoal" onClick={() => startEdit(r)} aria-label={isAr ? 'تعديل' : 'Edit'}>
                    <Pencil size={15} />
                  </button>
                )}
                {isEditing && (
                  <>
                    <button type="button" className="rounded-lg p-1.5 text-green-700 hover:bg-green-50" onClick={() => void saveEdit(r)} disabled={saving} aria-label={isAr ? 'حفظ' : 'Save'}>
                      {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                    </button>
                    <button type="button" className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream" onClick={() => { setEditing(null); setDraft(null); }} aria-label={isAr ? 'إلغاء' : 'Cancel'}>
                      <X size={15} />
                    </button>
                  </>
                )}
                <button type="button" className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream hover:text-charcoal" onClick={() => toggle(r.id)} aria-label={isAr ? 'السجل' : 'History'}>
                  {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                </button>
              </div>
            </div>

            {notSeenInLastCheck && (
              <div className="mx-3 mb-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
                {isAr
                  ? `لم يظهر هذا العميل ضمن عملائنا في آخر فحص لـ«${portal?.name ?? ''}» — تأكّد من تسجيله في البوابة.`
                  : `This client was not on our list in the last «${portal?.name ?? ''}» check — confirm the registration in the portal.`}
              </div>
            )}

            {isEditing ? (
              <div className="border-t border-sand/30 p-3">
                <textarea
                  className="w-full rounded-lg border border-sand px-2 py-1.5 text-sm"
                  rows={2}
                  value={draft!.notes}
                  placeholder={isAr ? 'ملاحظة على هذا التسجيل' : 'A note on this registration'}
                  onChange={(e) => setDraft({ ...draft!, notes: e.target.value })}
                />
              </div>
            ) : r.notes ? (
              <div className="border-t border-sand/30 px-3 py-2 text-sm text-charcoal/80">{r.notes}</div>
            ) : null}

            {open && (
              <div className="border-t border-dashed border-sand/50 bg-cream/40 px-3 py-2">
                <div className="mb-1 flex items-center gap-1 text-xs font-bold text-charcoal/70">
                  <History size={13} /> {isAr ? 'سجل هذا التسجيل' : 'History'}
                </div>
                {r.events.length === 0 ? (
                  <div className="text-xs text-charcoal/50">{isAr ? 'لا أحداث بعد.' : 'No events yet.'}</div>
                ) : (
                  <ul className="space-y-0.5 text-xs text-charcoal/70">
                    {r.events.map((e) => (
                      <li key={e.id}>
                        <span className="text-charcoal/40" dir="ltr">{fmtDate(e.created_at, true)}</span>
                        {' — '}
                        {isAr ? e.summary_ar : e.summary_en}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}

      {adding && (
        <AddRegistrationModal
          isAr={isAr}
          portals={addablePortals}
          onClose={() => setAdding(false)}
          onSave={async (input) => {
            await addClientRegistration({ clientId: client.id, ...input });
            setAdding(false);
            await load(true);
            addToast(isAr ? 'أُضيف التسجيل' : 'Registration added', 'success');
          }}
        />
      )}
    </div>
  );
}

function AddRegistrationModal({ isAr, portals, onClose, onSave }: {
  isAr: boolean;
  portals: RegistrationPortal[];
  onClose: () => void;
  onSave: (input: { portalId: string; ourStatus: RegistrationOurStatus; portalStatus: string; portalRef: string; projectName: string; notes: string }) => Promise<void>;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [portalId, setPortalId] = useState(portals[0]?.id ?? '');
  const [ourStatus, setOurStatus] = useState<RegistrationOurStatus>('registered');
  const [portalStatus, setPortalStatus] = useState('');
  const [portalRef, setPortalRef] = useState('');
  const [projectName, setProjectName] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!portalId) return;
    setSaving(true);
    try {
      await onSave({ portalId, ourStatus, portalStatus, portalRef, projectName, notes });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ClientPortalsTab] add failed:', msg);
      addToast(isAr ? `تعذّرت الإضافة: ${msg}` : `Could not add: ${msg}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const label = 'mb-1 block text-xs font-bold text-charcoal/70';
  const input = 'w-full rounded-lg border border-sand px-3 py-2 text-sm';
  return (
    <Modal
      open
      onClose={onClose}
      title={isAr ? 'إضافة تسجيل تمّ خارج التطبيق' : 'Add a registration made outside the app'}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
          <Button onClick={() => void submit()} disabled={saving || !portalId}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            {isAr ? 'إضافة' : 'Add'}
          </Button>
        </div>
      )}
    >
      <div className="space-y-3">
        <div>
          <label className={label}>{isAr ? 'البوابة' : 'Portal'}</label>
          <select className={input} value={portalId} onChange={(e) => setPortalId(e.target.value)}>
            {portals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>{isAr ? 'حالتنا' : 'Our status'}</label>
          <select className={input} value={ourStatus} onChange={(e) => setOurStatus(e.target.value as RegistrationOurStatus)}>
            {REGISTRATION_OUR_STATUSES.filter((s) => s !== 'registering').map((s) => (
              <option key={s} value={s}>{isAr ? STATUS_META[s].ar : STATUS_META[s].en}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={label}>{isAr ? 'حالة البوابة (كما تظهر فيها)' : 'Portal status (as the portal shows it)'}</label>
            <input className={input} value={portalStatus} onChange={(e) => setPortalStatus(e.target.value)} placeholder={isAr ? 'مثل: جديد' : 'e.g. New'} />
          </div>
          <div>
            <label className={label}>{isAr ? 'رقم العميل في البوابة' : "Client's number in the portal"}</label>
            <input className={input} value={portalRef} onChange={(e) => setPortalRef(e.target.value)} dir="ltr" placeholder="#14157" />
          </div>
        </div>
        <div>
          <label className={label}>{isAr ? 'المشروع' : 'Project'}</label>
          <input className={input} value={projectName} onChange={(e) => setProjectName(e.target.value)} />
        </div>
        <div>
          <label className={label}>{isAr ? 'ملاحظة' : 'Note'}</label>
          <textarea className={input} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}
