/**
 * Frontend wrapper for the `project-details-ai-v2` edge function.
 *
 * Used by ProjectDetailsBridgePage when the admin chooses "Draft with AI"
 * while creating a fresh project_details sidecar. The edge function reads
 * the project's all_projects record (RLS gates which projects the caller
 * can see), prompts Claude in Arabic, and returns strict JSON for the
 * editorial blocks.
 *
 * Slug is `-v2` because the v1 slug got stuck in a Supabase deploy-error
 * state. The function body itself is the v4 version, with dynamic CORS
 * and per-step error reporting — see supabase/functions/project-details-ai-v2.
 */

import { supabase } from '@/lib/supabase';
import { FunctionsHttpError } from '@supabase/supabase-js';

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

// Read the function's structured error body (rather than the generic
// "Edge Function returned a non-2xx status code"). The function returns
// JSON like `{ error: "...", step: "..." }` on failure.
async function readFunctionError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json();
      if (body && typeof body === 'object') {
        const e = (body as { error?: string }).error;
        const s = (body as { step?: string }).step;
        if (e && s) return `[${s}] ${e}`;
        if (e) return e;
      }
    } catch {
      // Body wasn't JSON. Fall through.
    }
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export async function draftProjectDetails(projectId: string): Promise<DraftResult | DraftError> {
  if (!supabase) return { ok: false, error: 'Supabase not configured' };
  if (!projectId) return { ok: false, error: 'projectId is required' };

  try {
    const { data, error } = await supabase.functions.invoke('project-details-ai-v2', {
      body: { projectId },
    });
    if (error) {
      return { ok: false, error: await readFunctionError(error) };
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
    return { ok: false, error: await readFunctionError(err) };
  }
}
