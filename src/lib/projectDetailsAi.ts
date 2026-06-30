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
import { resolveSlugToLibraryUrl } from '@/data/iconLibrary';

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

function resolveOrWarnSlug(value: unknown, kind: 'feature' | 'landmark'): string {
  if (typeof value !== 'string' || !value) return '';
  const url = resolveSlugToLibraryUrl(value);
  if (url) return url;
  // No silent fallback — fail loudly per CLAUDE.md "Silent Failures".
  console.error(`[projectDetailsAi] unknown ${kind} icon slug from AI: ${value}`);
  return '';
}

/**
 * Map the project's existing images (on its all_projects record) onto the
 * project_details image fields so an AI-drafted (or empty) detail page opens
 * with the real project photos already in place — no manual re-upload.
 *
 * The all_projects record carries:
 *   • `main_image`    — a single file-ID, THE project hero image
 *   • `project_images`— an array of file-IDs, the project's image library
 * The project_details sidecar exposes `hero_image_url` + `gallery_image_1..8`,
 * each holding ONE file-ID. We copy the file-IDs verbatim (NEVER invent one):
 *   • hero_image_url ← main_image (falls back to the first library image)
 *   • gallery_image_1..8 ← the remaining library images, hero filtered out so
 *     it isn't shown twice, capped at the 8 available slots.
 *
 * The public-website resolver (wassell_file_is_public_marketing) already
 * whitelists these project_details fields for public projects, so the copied
 * file-IDs render on the website with no extra grant.
 */
export function projectImagesToDetailFields(projectData: Record<string, unknown>): Record<string, string> {
  const main = typeof projectData.main_image === 'string' ? projectData.main_image.trim() : '';
  const library = Array.isArray(projectData.project_images)
    ? projectData.project_images.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];

  const hero = main || library[0] || '';
  const seen = new Set<string>();
  if (hero) seen.add(hero);

  const gallery: string[] = [];
  for (const id of library) {
    if (seen.has(id)) continue;
    seen.add(id);
    gallery.push(id);
  }

  const out: Record<string, string> = {};
  if (hero) out.hero_image_url = hero;
  gallery.slice(0, 8).forEach((id, i) => {
    out[`gallery_image_${i + 1}`] = id;
  });
  return out;
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
    // The edge function still emits short slug names (`"building"`,
    // `"metro"`, …) because Claude picks from a curated vocabulary —
    // cheaper and more deterministic than asking it to invent visuals.
    // The CRM stores image URLs now, so translate each slug to its
    // library URL before handing the draft to the form. If a slug is
    // unknown, leave it as-is and warn loudly — the form's image_icon
    // cell will render the placeholder and the editor can pick manually.
    const features = Array.isArray(d.features)
      ? d.features.map((f) => ({
          ...f,
          icon: resolveOrWarnSlug(f?.icon, 'feature'),
        }))
      : [];
    const landmarks = Array.isArray(d.landmarks)
      ? d.landmarks.map((l) => ({
          ...l,
          icon: resolveOrWarnSlug(l?.icon, 'landmark'),
        }))
      : [];
    return {
      ok: true,
      draft: {
        hero_short_description: typeof d.hero_short_description === 'string' ? d.hero_short_description : '',
        description: typeof d.description === 'string' ? d.description : '',
        features,
        landmarks,
      },
    };
  } catch (err) {
    return { ok: false, error: await readFunctionError(err) };
  }
}
