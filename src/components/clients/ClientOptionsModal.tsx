import { useEffect, useMemo, useState } from 'react';
import { X, ListChecks, Building2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useCanEditRecord } from '@/hooks/usePermission';
import type { AppRecord } from '@/types';
import ClientOptionsTab from '@/pages/Clients/components/tabs/ClientOptionsTab';
import SuggestedProjectsView from '@/pages/Followups/components/SuggestedProjectsView';
import ProjectsUnitsBrowser from '@/pages/Chats/components/ProjectsUnitsBrowser';
import RecordFormModal from '@/pages/Records/components/RecordFormModal';
import ProjectDetailPage from '@/pages/Projects/ProjectDetailPage';
import { optionSourceUrl } from '@/lib/matching/clientOptions';
import type { ClientOptionSourceType } from '@/lib/matching/clientOptions';
import { useIsMobile } from '@/hooks/useIsMobile';

/**
 * Client Options POPUP — the client's unified options list (ClientOptionsTab)
 * hosted in a closeable modal, with the Project Finder EMBEDDED inside the same
 * popup ("Find more options" swaps the body to SuggestedProjectsView scoped to
 * this client; its Done returns to the list). Lets any surface — the WhatsApp
 * chat, a workspace popup — review and grow a client's options without
 * navigating away from where the rep is standing.
 *
 * A third mode, `browse`, hands over to the PROJECTS & UNITS BROWSER — the
 * whole catalogue, plus each project's unit inventory, for when the rep wants
 * to look around rather than have the finder score matches against this
 * client's stated preferences. It REPLACES this modal while it is open (rather
 * than stacking on top of it) so the browser's own stacked surfaces — the unit
 * drawer, unit compare, the send-to-client flow — keep their z-order.
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
  const isMobile = useIsMobile();

  const [mode, setMode] = useState<'options' | 'finder' | 'browse'>('options');
  // A drilled-into option's SOURCE record (project / unit / market listing),
  // shown as an overlay the rep can back out of — closing it returns to the
  // options list (the "give me a back button" fix), instead of the old
  // new-tab link that stranded a mobile rep away from this popup.
  const [sourceView, setSourceView] = useState<{ sourceType: ClientOptionSourceType; sourceId: string } | null>(null);
  const sourceModelId = useMemo(() => {
    if (!sourceView) return null;
    const name =
      sourceView.sourceType === 'market_listing' ? 'market_listings' : sourceView.sourceType === 'unit' ? 'units' : 'all_projects';
    return models.find((m) => m.name === name)?.id ?? null;
  }, [sourceView, models]);

  // MOBILE-ONLY: drilling into a source stays in this popup. On the laptop we
  // keep the original new-tab "View source" link (onOpenSource left undefined,
  // so ClientOptionsTab + the finder fall back to their `target="_blank"` /
  // window.open behaviour).
  const onOpenSource = isMobile
    ? (sourceType: ClientOptionSourceType, sourceId: string) => setSourceView({ sourceType, sourceId })
    : undefined;

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
  // own Esc handler (→ back to the options list). Suppressed while a source
  // overlay is open on top (its own close/Back handles Esc).
  useEffect(() => {
    if (mode !== 'options' || sourceView) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, sourceView, onClose]);

  // Catalogue browsing takes over the screen; closing it comes back here.
  if (mode === 'browse') {
    return <ProjectsUnitsBrowser clientId={clientId} onClose={() => setMode('options')} />;
  }

  // A drilled-into option's / finder result's SOURCE opens as an overlay that
  // STACKS ON TOP of this popup (rendered as a sibling below), so closing it
  // returns to whatever the rep was looking at — the options list OR the finder
  // WITH ITS RESULTS INTACT (the finder stays mounted).
  //
  // The base popup sits at z-40 — deliberately BELOW the z-50 shared-Modal tier,
  // the SAME convention every other host in the app follows (the chat record
  // overlay, ProjectsUnitsBrowser). This matters because the embedded finder
  // spawns shared Modals from its cards — the units inventory (ProjectUnitsModal),
  // its unit compare, and the units-table PDF — all at z-50. A host ABOVE that
  // tier (the old z-55) hid them behind its own blurred backdrop, so clicking
  // "الوحدات" opened a modal that never appeared. Its own stacked popups that DO
  // need to clear it — eliminate / send-to-client — use z-60. While a source is
  // open the popup drops to z-30 so the source (project overlay z-40 /
  // RecordFormModal z-50) sits above it.
  return (
    <>
    <div
      role="dialog"
      aria-modal="true"
      className={`fixed inset-0 ${sourceView ? 'z-30' : 'z-40'} flex items-center justify-center bg-charcoal/40 p-2 sm:p-4`}
      onMouseDown={(e) => { if (e.target === e.currentTarget && mode === 'options' && !sourceView) onClose(); }}
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
              {/* Browse the whole catalogue (projects + their units) — the
                  "look around" counterpart to the finder's scored matching. */}
              <button
                type="button"
                onClick={() => setMode('browse')}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-copper/30 bg-copper/5 px-2.5 py-1 text-xs font-medium text-copper transition-colors hover:bg-copper/10"
                title={L('تصفح كل المشاريع والوحدات', 'Browse all projects & units')}
              >
                <Building2 size={13} />
                <span className="hidden sm:inline">{L('تصفح المشاريع', 'Browse projects')}</span>
              </button>
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
                <ClientOptionsTab
                  client={client}
                  isAr={isAr}
                  canEdit={canEdit}
                  onFindMore={() => setMode('finder')}
                  onOpenSource={onOpenSource}
                />
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
                defaultPrefsCollapsed
                // In the popup the rep opens the finder deliberately — let them
                // review/adjust the preferences BEFORE the search runs, instead
                // of firing one search then having to redo it (user request
                // 2026-07-19).
                editPrefsFirst
                onDone={() => setMode('options')}
                onOpenSource={onOpenSource}
              />
            )}
          </div>
        )}
      </div>
    </div>

    {/* Source overlay — stacks above the popup; close returns to it. PROJECT →
        the rich Project detail page; UNIT / MARKET LISTING → the record form. */}
    {sourceView && sourceView.sourceType === 'project' && (
      <div className="fixed inset-0 z-40 overflow-y-auto bg-cream" dir={isAr ? 'rtl' : 'ltr'}>
        <ProjectDetailPage
          recordId={sourceView.sourceId}
          modelName="all_projects"
          onClose={() => setSourceView(null)}
        />
      </div>
    )}
    {sourceView && sourceView.sourceType !== 'project' && sourceModelId && (
      <RecordFormModal
        modelId={sourceModelId}
        recordId={sourceView.sourceId}
        openInPageHref={optionSourceUrl(sourceView.sourceType, sourceView.sourceId)}
        onClose={() => setSourceView(null)}
      />
    )}
    </>
  );
}
