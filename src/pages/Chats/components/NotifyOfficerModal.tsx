import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, Search, UserCheck, Send, Building2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import type { AppRecord } from '@/types';
import { resolveCoveringOfficers, notifyOfficer, type CoveringOfficer } from '@/lib/officers/notifyOfficer';

/**
 * "Notify officer" — reach the project's responsible officer FROM THE OPERATIONS
 * WhatsApp line (never sales) to tell them a customer wants to visit.
 *
 * Flow: pick the project → the server resolves the covering officer(s) via the
 * developer/subset rule → a prefilled, editable Arabic message → send. The
 * message leaves on the ops number, so the reply lands in the ops inbox and the
 * sales funnel never touches it (see api/webhook/waha.ts).
 */
export default function NotifyOfficerModal({
  clientId,
  clientName,
  clientPhone,
  preferredProjectIds,
  onClose,
}: {
  clientId: string | null;
  clientName: string;
  clientPhone: string | null;
  preferredProjectIds?: string[];
  onClose: () => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const addToast = useAppStore((s) => s.addToast);

  const projectsModel = useMemo(() => models.find((m) => m.name === 'all_projects') ?? null, [models]);
  const projects = useMemo<AppRecord[]>(
    () => (projectsModel ? records[projectsModel.id] ?? [] : []),
    [projectsModel, records],
  );
  const projectName = (r: AppRecord): string => {
    const d = r.data as Record<string, unknown>;
    return (typeof d.project_name === 'string' && d.project_name) || (typeof d.name === 'string' && d.name) || '—';
  };

  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [officers, setOfficers] = useState<CoveringOfficer[] | null>(null);
  const [loadingOfficers, setLoadingOfficers] = useState(false);
  const [officerId, setOfficerId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const lastDefaultRef = useRef<string>('');

  // Prefill the project when the client has exactly one preferred project.
  useEffect(() => {
    if (projectId || !preferredProjectIds || preferredProjectIds.length !== 1) return;
    const p = projects.find((r) => r.id === preferredProjectIds[0]);
    if (p) setProjectId(p.id);
  }, [preferredProjectIds, projects, projectId]);

  const selectedProject = useMemo(() => projects.find((r) => r.id === projectId) ?? null, [projects, projectId]);

  // Resolve covering officers whenever the project changes.
  useEffect(() => {
    if (!projectId) {
      setOfficers(null);
      setOfficerId(null);
      return;
    }
    let cancelled = false;
    setLoadingOfficers(true);
    setOfficers(null);
    resolveCoveringOfficers(projectId)
      .then((list) => {
        if (cancelled) return;
        setOfficers(list);
        setOfficerId(list[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setOfficers([]);
        addToast(err instanceof Error ? err.message : String(err), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadingOfficers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, addToast]);

  // (Re)build the default message when project/officer context changes — but keep
  // the operator's manual edits (only overwrite when the box still holds our last
  // auto-fill or is empty).
  useEffect(() => {
    if (!selectedProject) return;
    const pName = projectName(selectedProject);
    const next = isAr
      ? `السلام عليكم،\nلدينا عميل${clientName ? ` (${clientName})` : ''} يرغب بزيارة مشروع «${pName}».\nنأمل التنسيق معه لتحديد موعد الزيارة.${clientPhone ? `\nرقم العميل: ${clientPhone}` : ''}\nشكراً لتعاونكم.`
      : `Hello,\nWe have a customer${clientName ? ` (${clientName})` : ''} who wants to visit «${pName}».\nPlease coordinate with them to set a visit time.${clientPhone ? `\nCustomer number: ${clientPhone}` : ''}\nThank you.`;
    setMessage((cur) => (cur === '' || cur === lastDefaultRef.current ? next : cur));
    lastDefaultRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isAr]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? projects.filter((r) => projectName(r).toLowerCase().includes(q)) : projects;
    return base.slice(0, 40);
  }, [projects, query]);

  const selectedOfficer = officers?.find((o) => o.id === officerId) ?? null;
  const canSend = !!selectedOfficer && message.trim().length > 0 && !sending;

  const send = async () => {
    if (!selectedOfficer) return;
    setSending(true);
    try {
      await notifyOfficer({
        officerPhone: selectedOfficer.phone,
        message: message.trim(),
        projectId: projectId ?? undefined,
        officerId: selectedOfficer.id,
        clientId: clientId ?? undefined,
      });
      addToast(
        isAr ? 'تم إرسال الإشعار للمسؤول من رقم العمليات' : 'Officer notified from the operations number',
        'success',
      );
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        dir={isAr ? 'rtl' : 'ltr'}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UserCheck size={18} className="text-copper" />
            <h2 className="text-lg font-bold text-chocolate">
              {isAr ? 'إشعار مسؤول المشروع' : 'Notify project officer'}
            </h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-charcoal/50 hover:bg-charcoal/5" aria-label="close">
            <X size={18} />
          </button>
        </div>

        <p className="mb-3 text-xs text-charcoal/50">
          {isAr
            ? 'اختر المشروع، وسيتم تحديد المسؤول عنه تلقائياً. تُرسل الرسالة من رقم العمليات، لا من رقم المبيعات.'
            : 'Pick the project — its officer is resolved automatically. The message is sent from the operations number, not sales.'}
        </p>

        {/* Project picker */}
        {!projectId ? (
          <div>
            <label className="mb-1 block text-sm font-medium text-charcoal">
              {isAr ? 'المشروع' : 'Project'}
            </label>
            <div className="relative mb-2">
              <Search size={14} className="absolute top-2.5 ltr:left-2.5 rtl:right-2.5 text-charcoal/40" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={isAr ? 'ابحث عن مشروع…' : 'Search a project…'}
                className="input w-full ltr:pl-8 rtl:pr-8 text-sm"
              />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-xl border border-sand">
              {filtered.length === 0 ? (
                <p className="p-3 text-center text-xs text-charcoal/40">
                  {isAr ? 'لا توجد مشاريع مطابقة' : 'No matching projects'}
                </p>
              ) : (
                filtered.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setProjectId(r.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-cream/60"
                  >
                    <Building2 size={13} className="shrink-0 text-charcoal/40" />
                    <span className="truncate">{projectName(r)}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Chosen project + change */}
            <div className="mb-3 flex items-center justify-between rounded-xl bg-cream/60 px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <Building2 size={14} className="shrink-0 text-copper" />
                <span className="truncate text-sm font-medium text-charcoal">
                  {selectedProject ? projectName(selectedProject) : '—'}
                </span>
              </div>
              <button
                onClick={() => { setProjectId(null); setQuery(''); }}
                className="text-xs font-medium text-copper hover:text-terracotta"
              >
                {isAr ? 'تغيير' : 'Change'}
              </button>
            </div>

            {/* Officer resolution */}
            {loadingOfficers ? (
              <div className="mb-3 flex items-center gap-2 text-sm text-charcoal/50">
                <Loader2 size={14} className="animate-spin" />
                {isAr ? 'جارٍ تحديد المسؤول…' : 'Resolving officer…'}
              </div>
            ) : officers && officers.length === 0 ? (
              <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                {isAr
                  ? 'لا يوجد مسؤول مرتبط بهذا المشروع. أضِف مسؤولاً في نموذج «مسؤولو المشاريع».'
                  : 'No officer is linked to this project. Add one in the Project Officers model.'}
              </div>
            ) : officers && officers.length > 0 ? (
              <div className="mb-3">
                <label className="mb-1 block text-sm font-medium text-charcoal">
                  {isAr ? 'المسؤول' : 'Officer'}
                </label>
                <div className="space-y-1.5">
                  {officers.map((o) => (
                    <label
                      key={o.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                        officerId === o.id ? 'border-copper bg-copper/5' : 'border-sand hover:bg-cream/50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="officer"
                        checked={officerId === o.id}
                        onChange={() => setOfficerId(o.id)}
                        className="accent-copper"
                      />
                      <span className="font-medium text-charcoal">{o.name || (isAr ? 'بدون اسم' : 'Unnamed')}</span>
                      <span className="text-xs text-charcoal/50" dir="ltr">{o.phone}</span>
                      {o.coverage === 'developer' && (
                        <span className="ms-auto rounded-full bg-gold/20 px-2 py-0.5 text-[10px] text-[#8a6a2f]">
                          {isAr ? 'عبر المطور' : 'via developer'}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Message */}
            {officers && officers.length > 0 && (
              <div className="mb-4">
                <label className="mb-1 block text-sm font-medium text-charcoal">
                  {isAr ? 'الرسالة' : 'Message'}
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={6}
                  dir={isAr ? 'rtl' : 'ltr'}
                  className="input w-full resize-y text-sm"
                />
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose} disabled={sending}>
                {isAr ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button onClick={send} disabled={!canSend}>
                {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                {isAr ? 'إرسال من رقم العمليات' : 'Send from ops number'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
