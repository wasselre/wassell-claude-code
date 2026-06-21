import { useMemo, useState } from 'react';
import { Search, UserCheck, History, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';

/** Assign a client to a process / version (+ optional experiment group). Shows history. */
export default function AssignClientModal({
  open,
  onClose,
  presetClientId,
  presetProcessId,
}: {
  open: boolean;
  onClose: () => void;
  presetClientId?: string | null;
  presetProcessId?: string | null;
}) {
  const {
    language, models, records, salesProcesses, salesProcessVersions, salesExperiments,
    clientSalesProcessAssignments, assignClientToProcess, addToast,
  } = useAppStore();
  const isAr = language === 'ar';

  const clientsModel = models.find((m) => m.name === 'clients');
  const clients: AppRecord[] = clientsModel ? records[clientsModel.id] ?? [] : [];

  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState<string | null>(presetClientId ?? null);
  const [processId, setProcessId] = useState<string>(presetProcessId ?? salesProcesses.find((p) => p.is_default)?.id ?? '');
  const [versionId, setVersionId] = useState<string>('');
  const [experimentId, setExperimentId] = useState<string>('');
  const [group, setGroup] = useState<'control' | 'variant' | ''>('');
  const [reason, setReason] = useState('');

  const processVersions = useMemo(
    () => salesProcessVersions.filter((v) => v.sales_process_id === processId).sort((a, b) => b.version_number - a.version_number),
    [salesProcessVersions, processId],
  );
  const activeVersionId = processVersions.find((v) => v.status === 'active')?.id ?? processVersions[0]?.id ?? '';
  const effectiveVersionId = versionId || activeVersionId;

  const filtered = useMemo(() => {
    if (clientId) return [];
    const q = search.trim().toLowerCase();
    const list = q
      ? clients.filter((c) =>
          String(c.data.client_name ?? '').toLowerCase().includes(q) ||
          String(c.data.phone_number ?? '').includes(q))
      : clients;
    return list.slice(0, 25);
  }, [clients, search, clientId]);

  const selectedClient = clientId ? clients.find((c) => c.id === clientId) : undefined;
  const history = useMemo(
    () => clientSalesProcessAssignments
      .filter((a) => a.client_id === clientId)
      .sort((a, b) => new Date(b.assigned_at).getTime() - new Date(a.assigned_at).getTime()),
    [clientSalesProcessAssignments, clientId],
  );

  const processName = (id: string | null | undefined) => {
    const p = salesProcesses.find((x) => x.id === id);
    return p ? (isAr ? p.name_ar : p.name_en) : (isAr ? '—' : '—');
  };

  const canAssign = clientId && processId && effectiveVersionId;

  const submit = () => {
    if (!canAssign) return;
    assignClientToProcess({
      clientId: clientId!,
      processId,
      versionId: effectiveVersionId,
      experimentId: experimentId || null,
      group: experimentId ? (group || 'control') : null,
      reason: reason.trim() || (isAr ? 'إسناد يدوي من استوديو المبيعات' : 'Manual assignment from Sales Studio'),
    });
    addToast(isAr ? 'تم إسناد العميل' : 'Client assigned', 'success');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isAr ? 'إسناد عميل إلى مسار' : 'Assign client to a process'}
      maxWidth="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
          <Button variant="primary" onClick={submit} disabled={!canAssign}>{isAr ? 'إسناد' : 'Assign'}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* client picker */}
        {!presetClientId && (
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? 'العميل' : 'Client'}</label>
            {selectedClient ? (
              <div className="flex items-center justify-between rounded-lg border border-copper/40 bg-copper/5 px-3 py-2">
                <span className="text-sm font-semibold text-charcoal">{String(selectedClient.data.client_name ?? '')}<span className="ms-2 text-xs text-charcoal/50" dir="ltr">{String(selectedClient.data.phone_number ?? '')}</span></span>
                <button type="button" onClick={() => setClientId(null)} className="rounded p-1 text-charcoal/50 hover:bg-white"><X size={14} /></button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute inset-y-0 my-auto ms-3 text-charcoal/40" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} className="form-input w-full ps-9" placeholder={isAr ? 'ابحث بالاسم أو الجوال' : 'Search by name or phone'} />
                </div>
                {filtered.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-sand/40">
                    {filtered.map((c) => (
                      <button key={c.id} type="button" onClick={() => setClientId(c.id)} className="flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-cream">
                        <span className="truncate text-charcoal">{String(c.data.client_name ?? (isAr ? 'بدون اسم' : 'Unnamed'))}</span>
                        <span className="shrink-0 text-xs text-charcoal/45" dir="ltr">{String(c.data.phone_number ?? '')}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* process + version */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? 'المسار' : 'Process'}</label>
            <select value={processId} onChange={(e) => { setProcessId(e.target.value); setVersionId(''); }} className="form-input w-full">
              {salesProcesses.filter((p) => p.status !== 'archived').map((p) => <option key={p.id} value={p.id}>{isAr ? p.name_ar : p.name_en}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? 'الإصدار' : 'Version'}</label>
            <select value={effectiveVersionId} onChange={(e) => setVersionId(e.target.value)} className="form-input w-full">
              {processVersions.map((v) => <option key={v.id} value={v.id}>v{v.version_number} ({v.status})</option>)}
            </select>
          </div>
        </div>

        {/* experiment (optional) */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? 'تجربة (اختياري)' : 'Experiment (optional)'}</label>
            <select value={experimentId} onChange={(e) => setExperimentId(e.target.value)} className="form-input w-full">
              <option value="">{isAr ? 'بدون تجربة' : 'No experiment'}</option>
              {salesExperiments.filter((e) => e.status === 'active' || e.status === 'draft').map((e) => <option key={e.id} value={e.id}>{isAr ? e.name_ar : e.name_en}</option>)}
            </select>
          </div>
          {experimentId && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? 'المجموعة' : 'Group'}</label>
              <select value={group} onChange={(e) => setGroup(e.target.value as 'control' | 'variant')} className="form-input w-full">
                <option value="control">{isAr ? 'ضابطة' : 'Control'}</option>
                <option value="variant">{isAr ? 'متغيّرة' : 'Variant'}</option>
              </select>
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? 'السبب' : 'Reason'}</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="form-input w-full" placeholder={isAr ? 'لماذا هذا الإسناد؟' : 'Why this assignment?'} />
        </div>

        {/* history */}
        {clientId && history.length > 0 && (
          <div className="rounded-xl bg-cream/60 p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold text-charcoal/60"><History size={13} /> {isAr ? 'سجل الإسناد' : 'Assignment history'}</h4>
            <ul className="space-y-1.5">
              {history.slice(0, 6).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5 truncate text-charcoal/75">
                    {a.is_active && <UserCheck size={12} className="shrink-0 text-[#10B981]" />}
                    {processName(a.sales_process_id)}{a.experiment_group ? ` · ${a.experiment_group}` : ''}
                  </span>
                  <span className="shrink-0 text-charcoal/40" dir="ltr">{new Date(a.assigned_at).toLocaleDateString(isAr ? 'ar' : 'en')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
