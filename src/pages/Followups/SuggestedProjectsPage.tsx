import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { resolveFollowupContext } from './lib/followupContext';
import { getFinderHandoff } from '@/lib/matching/finderHandoff';
import SuggestedProjectsView from './components/SuggestedProjectsView';
import ClientPrefsFab from './components/ClientPrefsFab';
import { useQualificationDraft } from './hooks/useQualificationDraft';
import { usePreferencesAutosave } from './hooks/usePreferencesAutosave';
import type { AppRecord } from '@/types';

/**
 * Full-page Suggested Projects finder at `/model/followups/:recordId/projects`.
 * Replaces the old cramped modal — opens in the SAME tab via client-side nav from
 * the Follow-up Workspace, stays connected to the follow-up (its id drives the
 * audit log + saves into THAT client's options), and a "Done" button returns the
 * rep to the follow-up record.
 *
 * Preferences come from the in-memory hand-off the workspace set when the rep
 * pressed "Suggested Projects" (so unsaved edits are honored). On a cold load of
 * this URL the hand-off is absent and we fall back to the saved client data.
 */
export default function SuggestedProjectsPage() {
  const { recordId } = useParams();
  const navigate = useNavigate();
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';

  const followupsModel = models.find((m) => m.name === 'followups');
  const followupRec = useMemo<AppRecord | null>(
    () => (followupsModel ? (records[followupsModel.id] ?? []).find((r) => r.id === recordId) ?? null : null),
    [followupsModel, records, recordId],
  );

  const ctx = useMemo(
    () => (followupRec ? resolveFollowupContext(followupRec.data, models, records) : null),
    [followupRec, models, records],
  );

  const clientsModel = models.find((m) => m.name === 'clients') ?? null;
  const clientRec = useMemo<AppRecord | null>(
    () => (clientsModel && ctx?.clientId ? (records[clientsModel.id] ?? []).find((r) => r.id === ctx.clientId) ?? null : null),
    [clientsModel, records, ctx?.clientId],
  );

  const projectName = (ctx?.project?.project_name as string | undefined) ?? null;
  const clientName = useMemo<string | null>(() => {
    const d = clientRec?.data as Record<string, unknown> | undefined;
    if (!d) return null;
    for (const slug of ['name', 'full_name', 'client_name', 'name_ar', 'name_en']) {
      const v = d[slug];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }, [clientRec]);

  // Preferences: the workspace hand-off (unsaved edits included) → else saved client data.
  const handoff = recordId ? getFinderHandoff(recordId) : null;
  const prefDraft = handoff?.prefDraft ?? (clientRec?.data as Record<string, unknown> | undefined) ?? {};
  const followupDraft = handoff?.followupDraft ?? (followupRec?.data as Record<string, unknown> | undefined) ?? {};

  // The client's preferences on this page too (operator, 2026-10-05): the same
  // qualification session as the follow-up (it survives the navigation), saved
  // by ONE page-level autosave, edited from the floating circle or applied from
  // a units-window filter. Every change is handed to the finder (livePrefs):
  // the pop-up closing re-runs the search; a units-filter change offers it.
  const qual = useQualificationDraft({ clientId: ctx?.clientId ?? null, followupId: recordId ?? null });
  const prefSave = usePreferencesAutosave(ctx?.clientId ?? null, qual.draft);
  const [livePrefs, setLivePrefs] = useState<{ draft: Record<string, unknown>; key: number; autoSearch: boolean } | null>(null);
  const seen = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (seen.current === null) { seen.current = qual.draft; return; } // first draft = what the finder opened with
    if (seen.current === qual.draft) return;
    seen.current = qual.draft;
    setLivePrefs({ draft: qual.draft, key: Date.now(), autoSearch: false });
  }, [qual.draft]);

  const onDone = () => {
    if (recordId) navigate(`/model/followups/${recordId}`);
    else navigate(-1);
  };

  // The records slow-tail can resolve AFTER first paint on a cold URL load — wait
  // for the follow-up record so the finder snapshots the correct preferences
  // (mirrors the workspace's direct-load handling).
  if (!followupRec) {
    return (
      <div className="flex h-full items-center justify-center text-charcoal/55">
        <Loader2 size={22} className="animate-spin text-copper" />
      </div>
    );
  }

  return (
    <>
    <ClientPrefsFab
      isAr={isAr}
      clientId={ctx?.clientId ?? null}
      draft={qual.draft}
      meta={qual.meta}
      onFieldChange={qual.setPrefField}
      onApplyRepText={qual.applyRepText}
      saveState={prefSave.saveState}
      onClosed={(changed, draft) => { if (changed) setLivePrefs({ draft, key: Date.now(), autoSearch: true }); }}
    />
    <SuggestedProjectsView
      key={recordId}
      isAr={isAr}
      clientsModel={clientsModel}
      clientRec={clientRec}
      prefDraft={prefDraft}
      followupDraft={followupDraft}
      followupId={recordId ?? null}
      projectName={projectName}
      clientName={clientName}
      onDone={onDone}
      livePrefs={livePrefs}
    />
    </>
  );
}
