import { useEffect, useMemo, useState } from 'react';
import { X, ListChecks } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useCanEditRecord } from '@/hooks/usePermission';
import type { AppRecord } from '@/types';
import ClientOptionsTab from '@/pages/Clients/components/tabs/ClientOptionsTab';
import SuggestedProjectsView from '@/pages/Followups/components/SuggestedProjectsView';

/**
 * Client Options POPUP — the client's unified options list (ClientOptionsTab)
 * hosted in a closeable modal, with the Project Finder EMBEDDED inside the same
 * popup ("Find more options" swaps the body to SuggestedProjectsView scoped to
 * this client; its Done returns to the list). Lets any surface — the WhatsApp
 * chat, a workspace popup — review and grow a client's options without
 * navigating away from where the rep is standing.
 */
export default function ClientOptionsModal({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const client = useMemo<AppRecord | null>(
    () => (clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === clientId) ?? null : null),
    [clientsModel, records, clientId],
  );
  const canEdit = useCanEditRecord(clientsModel, client);

  const [mode, setMode] = useState<'options' | 'finder'>('options');

  const clientName = useMemo(() => {
    const d = client?.data as Record<string, unknown> | undefined;
    if (!d) return null;
    for (const slug of ['name', 'full_name', 'client_name', 'name_ar', 'name_en']) {
      const v = d[slug];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }, [client]);

  // Esc closes the popup in options mode only — the embedded finder installs its
  // own Esc handler (→ back to the options list).
  useEffect(() => {
    if (mode !== 'options') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[55] flex items-center justify-center bg-charcoal/40 p-2 sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && mode === 'options') onClose(); }}
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-cream shadow-2xl">
        {mode === 'options' ? (
          <>
            <div className="flex shrink-0 items-center gap-2.5 border-b border-sand/40 bg-white px-4 py-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-copper/10">
                <ListChecks size={18} className="text-copper" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-base font-bold text-chocolate">{L('خيارات العميل', 'Client Options')}</h2>
                {clientName && <p className="truncate text-[11px] text-charcoal/60">{clientName}</p>}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-lg p-1.5 text-charcoal/50 transition-colors hover:bg-cream hover:text-charcoal"
                aria-label={L('إغلاق', 'Close')}
              >
                <X size={18} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {client ? (
                <ClientOptionsTab client={client} isAr={isAr} canEdit={canEdit} onFindMore={() => setMode('finder')} />
              ) : (
                <div className="rounded-2xl border border-sand/30 bg-white p-6 text-sm text-charcoal/55">
                  {L('العميل غير موجود أو لم يُحمَّل بعد.', 'Client not found or not loaded yet.')}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1">
            {client && (
              <SuggestedProjectsView
                key={client.id}
                isAr={isAr}
                clientsModel={clientsModel}
                clientRec={client}
                prefDraft={(client.data as Record<string, unknown>) ?? {}}
                followupDraft={{}}
                followupId={null}
                projectName={null}
                clientName={clientName}
                onDone={() => setMode('options')}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
