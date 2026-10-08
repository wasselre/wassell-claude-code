import { v4 as uuid } from 'uuid';
import { resolveProjectFacts } from '@/lib/projectMessageFacts';
import type { AppModel, AppRecord } from '@/types';

/**
 * The chat_templates record that holds a project's saved WhatsApp message —
 * upserted (never duplicated) over `savedRec` when one exists. Shared by the
 * compose step (ProjectMessageComposeStep) and the one-click send
 * (quickSendProject) so both save the message the same way: keeps the gallery,
 * links it to the all_projects id, and flags it for a fact-check on next use.
 */
export function buildProjectTemplateRecord(input: {
  chatTemplatesModelId: string;
  savedRec: AppRecord | null;
  projectId: string;
  projectName: string;
  ar: string;
  en: string;
  models: AppModel[];
  records: Record<string, AppRecord[]>;
}): AppRecord {
  const { chatTemplatesModelId, savedRec, projectId, projectName, ar, en, models, records } = input;
  const now = new Date().toISOString();
  const baseData = (savedRec?.data ?? {}) as Record<string, unknown>;
  let galleryIds = baseData.project_image_file_ids;
  if (!Array.isArray(galleryIds)) {
    const synthetic = { id: 'wa-synthetic', data: { project: projectId } } as unknown as AppRecord;
    galleryIds = resolveProjectFacts(synthetic, models, records).imageFileIds;
  }
  return {
    id: savedRec?.id ?? uuid(),
    model_id: chatTemplatesModelId,
    data: {
      media_kind: '', media_file_id: null, media_mime: null, media_size: null, media_filename: null,
      ...baseData,
      name: projectName,
      language: 'both',
      tags: Array.isArray(baseData.tags) && baseData.tags.length ? baseData.tags : ['project'],
      body_ar: ar,
      body_en: en,
      project_id: projectId,
      project_image_file_ids: galleryIds,
      fact_check_on_use: true,
    },
    created_at: savedRec?.created_at ?? now,
    updated_at: now,
  };
}
