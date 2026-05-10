/**
 * Frontend wrapper for the `project-details-ai` edge function.
 *
 * Used by ProjectDetailsBridgePage when the admin chooses "Draft with AI"
 * while creating a fresh project_details sidecar. The edge function reads
 * the project's all_projects record (RLS gates which projects the caller
 * can see), prompts Claude in Arabic, and returns strict JSON for the
 * editorial blocks.
 *
 * The returned shape is mapped 1:1 onto the project_details record's
 * fields by the bridge page before opening the standard editor — the
 * admin always reviews and edits before publishing.
 */

import { supabase } from '@/lib/supabase';

export interface ProjectDetailsAiDraft {
  hero_short_description: string;
  description: string;
  features: Array<{ icon: string; title: string; description: string }>;
  landmarks: Array<{ icon: string; name: string; distance: string }>;
}

export interface DraftResult {
  ok: true;
  draft: ProjectDetailsAiDraft;
}
export interface DraftError {
  ok: false;
  error: string;
}

export async function draftProjectDetails(projectId: string): Promise<DraftResult | DraftError> {
  if (!supabase) return { ok: false, error: 'Supabase not configured' };
  if (!projectId) return { ok: false, error: 'projectId is required' };

  try {
    // v2 endpoint — corrects CORS allow-headers to include `apikey` and
    // `x-client-info` (the supabase-js client adds these on .invoke(), and
    // missing them from the preflight allow-list silently blocked the POST
    // with "Failed to send a request to the Edge Function"). The original
    // `project-details-ai` slug was stuck in a deploy-broken state, so we
    // shipped the fix as a sibling slug rather than wait it out.
    const { data, error } = await supabase.functions.invoke('project-details-ai-v2', {
      body: { projectId },
    });
    if (error) {
      return { ok: false, error: error.message || 'AI draft failed' };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'Empty AI response' };
    }
    if ((data as { error?: string }).error) {
      return { ok: false, error: String((data as { error: string }).error) };
    }
    const d = data as ProjectDetailsAiDraft;
    return {
      ok: true,
      draft: {
        hero_short_description: typeof d.hero_short_description === 'string' ? d.hero_short_description : '',
        description: typeof d.description === 'string' ? d.description : '',
        features: Array.isArray(d.features) ? d.features : [],
        landmarks: Array.isArray(d.landmarks) ? d.landmarks : [],
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
