/**
 * Video-script lane — drains public.mos_script_jobs.
 *
 * The in-app «اكتب سكربت» button enqueues a job (recipe + content item) and
 * returns instantly; this runs the ~30–40s Anthropic write OFF the HTTP request
 * (the codebase rule shared with decks / image-chats / documents), appends the
 * generated scenes to mos_scenes (footage_status='missing', seeding the shoot
 * backlog), and fires a completion notification to the requester. The SPA shows
 * a progress bar from the job row and never has to sit and wait.
 *
 * Generation logic lives in worker/src/marketing/videoScript.ts (a copy of
 * api/_lib/marketing/videoScript.ts — keep both in sync).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import {
  generateScript, loadProjectData, loadTranscripts, buildFactsSheet, isScriptRecipe,
} from './marketing/videoScript.js';

export interface ScriptJob {
  id: string;
  contentId: string;
  recipe: string;
  requestedBy: string | null; // public.users.id (notify target)
  attempts: number;
}

export async function runScriptJob(
  { supabase, job }: { supabase: SupabaseClient; env: WorkerEnv; job: ScriptJob },
): Promise<{ scene_count: number; hooks: string[] }> {
  // 1. Resolve the linked project from the content item.
  const c = await supabase
    .from('mos_content_v')
    .select('id, project_id, title')
    .eq('id', job.contentId)
    .maybeSingle();
  if (c.error) throw new Error(`content read failed: ${c.error.message}`);
  const content = c.data as { project_id: string | null; title: string | null } | null;
  if (!content) throw new Error('content item not found');
  if (!content.project_id) throw new Error('no project linked to this content');

  // 2. Facts sheet + competitor transcripts.
  const pdata = await loadProjectData(supabase, content.project_id);
  if (!pdata) throw new Error('project not found in catalog');
  const facts = buildFactsSheet(pdata);
  if (!facts.hasFacts) throw new Error('not enough project facts to write a script');
  const transcripts = await loadTranscripts(supabase);
  const recipe = isScriptRecipe(job.recipe) ? job.recipe : 'walkthrough';

  // 3. Generate (the long call).
  const { scenes, hooks } = await generateScript(recipe, facts.sheet, transcripts);

  // 4. Append into mos_scenes after any existing scenes. Non-destructive.
  const last = await supabase
    .from('mos_scenes')
    .select('position')
    .eq('content_id', job.contentId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  let pos = (last.data as { position: number } | null)?.position ?? 0;
  const rows = scenes.map((s) => {
    pos += 1;
    return {
      content_id: job.contentId,
      position: pos,
      visual: s.visual || null,
      voiceover: s.voiceover || null,
      on_screen_text: s.on_screen_text || null,
      start_sec: s.start_sec,
      end_sec: s.end_sec,
      footage_status: 'missing',
    };
  });
  const ins = await supabase.from('mos_scenes').insert(rows);
  if (ins.error) throw new Error(`scene insert failed: ${ins.error.message}`);

  // 5. Notify the requester (in-app bell always fires; push/WhatsApp only if the
  //    role grid allows). Best-effort — a lost notification must never fail the
  //    job that already committed its scenes.
  try {
    const title = content.title ? `«${content.title}»` : '';
    await supabase.rpc('notify_emit', {
      p_workspace: 'marketing',
      p_event: 'video_script_ready',
      p_role_keys: [],
      p_user_ids: job.requestedBy ? [job.requestedBy] : [],
      p_title_ar: 'سكربت الفيديو جاهز',
      p_title_en: 'Video script ready',
      p_body_ar: `تمت كتابة ${scenes.length} مشهد${title ? ` لـ${title}` : ''}`,
      p_body_en: `${scenes.length} scenes written${content.title ? ` for “${content.title}”` : ''}`,
      p_url: `/m/content/${job.contentId}`,
    });
  } catch (e) {
    console.error('[run] video_script_ready notify failed', e);
  }

  return { scene_count: scenes.length, hooks };
}
