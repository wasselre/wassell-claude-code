// useQualificationDraft — React view over the app-wide qualificationSession singleton.
//
// Phase 4: the working draft now LIVES in the singleton (survives navigation + keeps
// receiving live-call extraction while the Workspace is unmounted). This hook only
// subscribes and wires the district resolver + saved-client baseline. The public API
// is UNCHANGED from Phase 3, so the Workspace / PreferenceSummary don't change.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAppStore } from '@/stores/appStore';
import { normalizeForSearch } from '@/lib/recordSearch';
import * as session from '@/lib/salesProcess/qualificationSession';
import {
  seedQualification, computeDiff, resolveDistrictInIndex,
  type DistrictIndex, type DistrictIndexEntry, type FieldMeta,
  type QualificationException, type ExtractionInput, type DiffEntry,
} from '@/lib/salesProcess/qualificationDraft';

function firstId(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v)) {
    const s = v.find((x) => typeof x === 'string' && x.trim());
    return typeof s === 'string' ? s.trim() : null;
  }
  return null;
}

export interface UseQualificationDraft {
  draft: Record<string, unknown>;
  meta: Record<string, FieldMeta>;
  exceptions: QualificationException[];
  /** Human edit — stamps rep_edited + locks the field against AI overwrite. */
  setPrefField: (slug: string, value: unknown) => void;
  /** AI evidence — runs the auto-apply reducer (called by captureController in Phase 4). */
  applyExtraction: (extraction: ExtractionInput) => void;
  /** Draft-vs-saved diff for the Phase 6 reconciliation screen. */
  diff: DiffEntry[];
  /** Re-seed from the freshly-saved client after the full-edit modal persists. */
  resetSeed: () => void;
}

export function useQualificationDraft(input: {
  clientId: string | null;
  followupId: string | null;
}): UseQualificationDraft {
  const { clientId, followupId } = input;
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const savedClientData = useMemo(() => {
    if (!clientsModel || !clientId) return null;
    return (records[clientsModel.id] ?? []).find((r) => r.id === clientId)?.data ?? null;
  }, [clientsModel, records, clientId]);

  const districtIndex = useMemo<DistrictIndex>(() => {
    const dm = models.find((m) => m.name === 'districts');
    if (!dm) return {};
    const idx: DistrictIndex = {};
    for (const r of records[dm.id] ?? []) {
      const d = r.data as Record<string, unknown>;
      const label =
        (typeof d.name_ar === 'string' && d.name_ar) ||
        (typeof d.display_name === 'string' && d.display_name) ||
        (typeof d.name_en === 'string' && d.name_en) || '';
      if (!label) continue;
      const key = normalizeForSearch(String(label));
      const cityId = firstId(d.city_id) ?? firstId(d.city) ?? null;
      (idx[key] ??= []).push({ id: r.id, label: String(label), cityId });
    }
    return idx;
  }, [models, records]);

  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  // Ensure the singleton is for THIS follow-up. Seeds once the saved client is loaded;
  // a mission change resets (see ensureSession). District scope reads the LIVE draft
  // city (rep-edited or AI-filled) at resolve time, falling back to the saved city.
  useEffect(() => {
    if (!savedClientData || !followupId) return;
    const resolveDistrict = (name: string): DistrictIndexEntry | 'ambiguous' | 'not_found' => {
      const snap = session.getSnapshot();
      const draftCity = firstId((snap.qual.draft.location as Record<string, unknown> | undefined)?.city);
      const savedCity = firstId((savedClientData.location as Record<string, unknown> | undefined)?.city);
      return resolveDistrictInIndex(name, districtIndex, draftCity ?? savedCity);
    };
    session.ensureSession({ followupId, clientId, ctx: { savedData: savedClientData, resolveDistrict } });
  }, [followupId, clientId, savedClientData, districtIndex]);

  // Trust the snapshot only when it's for THIS follow-up (prevents a one-frame leak of
  // another mission's draft before the effect above runs).
  const qual = snapshot.followupId === followupId
    ? snapshot.qual
    : seedQualification(savedClientData);

  const setPrefField = useCallback((slug: string, value: unknown) => session.setRepEdit(slug, value), []);
  const applyExtraction = useCallback((extraction: ExtractionInput) => session.applyExtractionEvent(extraction), []);

  const resetSeed = useCallback(() => {
    // Read the freshest client straight from the store — the modal's onSaved fires
    // before the memo above recomputes.
    const st = useAppStore.getState();
    const cm = st.models.find((m) => m.name === 'clients');
    const fresh = cm && clientId ? (st.records[cm.id] ?? []).find((r) => r.id === clientId)?.data ?? null : null;
    session.reseedFromSaved(fresh);
  }, [clientId]);

  const diff = useMemo(() => computeDiff(qual, savedClientData), [qual, savedClientData]);

  return { draft: qual.draft, meta: qual.meta, exceptions: qual.exceptions, setPrefField, applyExtraction, diff, resetSeed };
}
