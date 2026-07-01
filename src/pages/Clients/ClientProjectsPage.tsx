import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import SuggestedProjectsView from '@/pages/Followups/components/SuggestedProjectsView';
import type { AppRecord } from '@/types';

/**
 * Full-page Project Finder scoped to a CLIENT, at `/model/clients/:recordId/projects`.
 * Reached from the "Find projects" button in the Client 360 header — the SAME
 * deterministic finder the Follow-up flow uses (map view, refinement, edit-prefs,
 * saving into the client's unified options), but anchored to the client directly
 * instead of a follow-up. There is no follow-up here, so `followupId` is null; the
 * search is geo-gated for the client (client_id + their saved location_items) and
 * results save into THIS client's `client_property_options`.
 *
 * "Done" returns to the client profile.
 */
export default function ClientProjectsPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';

  const clientsModel = models.find((m) => m.name === 'clients') ?? null;
  const clientRec = useMemo<AppRecord | null>(
    () => (clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === recordId) ?? null : null),
    [clientsModel, records, recordId],
  );

  const clientName = useMemo<string | null>(() => {
    const d = clientRec?.data as Record<string, unknown> | undefined;
    if (!d) return null;
    for (const slug of ['name', 'full_name', 'client_name', 'name_ar', 'name_en']) {
      const v = d[slug];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }, [clientRec]);

  // Preferences come straight from the saved client record (the finder's own
  // "Edit preferences" panel lets the rep refine + re-run from here).
  const prefDraft = (clientRec?.data as Record<string, unknown> | undefined) ?? {};

  const onDone = () => {
    if (recordId) navigate(`/model/clients/${recordId}`);
    else navigate(-1);
  };

  // The records slow-tail can resolve AFTER first paint on a cold URL load — wait
  // for the client record so the finder snapshots the correct preferences.
  if (!clientRec) {
    return (
      <div className="flex h-full items-center justify-center text-charcoal/55">
        <Loader2 size={22} className="animate-spin text-copper" />
      </div>
    );
  }

  return (
    <SuggestedProjectsView
      key={recordId}
      isAr={isAr}
      clientsModel={clientsModel}
      clientRec={clientRec}
      prefDraft={prefDraft}
      followupDraft={{}}
      followupId={null}
      projectName={null}
      clientName={clientName}
      onDone={onDone}
    />
  );
}
