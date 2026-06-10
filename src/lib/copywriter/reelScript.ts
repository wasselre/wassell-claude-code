/**
 * Structured reel-script payload — the shape the copywriter agent emits via the
 * `emit_reel_script` tool when it produces a FINAL, ready-to-film script (not a
 * hooks list or an analysis). It travels over the SSE stream as a `reel_script`
 * event, is stored on the assistant message, rendered as a table card, and
 * mapped into a prefilled `reel_scripts` ("Reels") record on "Create Reel".
 *
 * Field slugs here line up 1:1 with the `reel_scripts` model (src/data/seedModels.ts
 * + supabase/migrations/2026-06-10_reel_scripts_model.sql). Keep them in sync.
 */

export interface ReelScriptScene {
  /** Scene/segment label, e.g. "مشهد ١" or "Scene 1". */
  scene: string;
  /** Spoken voiceover line for the scene. */
  voiceover: string;
  /** Visual direction — what's on screen / how it's shot. */
  visual: string;
  /** Optional on-screen text overlay. */
  on_screen_text?: string;
  /** Optional production note for the scene. */
  notes?: string;
}

export interface ReelScript {
  title: string;
  /** all_projects record id from the agent's get_project tool, when grounded in a project. */
  project_id?: string;
  /** Project name, for display/confirmation in the card. */
  project_name?: string;
  /** 🎬 The opening hook. */
  hook: string;
  /** 🎯 Angle + psychological trigger (one line). */
  angle?: string;
  /** 📢 Closing call to action. */
  cta?: string;
  /** 2–3 alternative hooks. */
  alt_hooks?: string[];
  /** Creative-brief fields (optional — agent fills when it can). */
  reel_idea?: string;
  objective?: string;
  target_audience?: string;
  key_message?: string;
  /** 🎞️ Scene-by-scene body. */
  scenes: ReelScriptScene[];
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asString).filter((s) => s.trim() !== '') : [];

/**
 * Coerce the raw, untrusted tool input (typed `unknown` off the wire) into a
 * `ReelScript`. Lenient by design — never drops a script the agent worked to
 * produce: missing/loose fields become empty strings/arrays rather than null.
 * Returns null only when `data` isn't an object at all.
 */
export function normalizeReelScript(data: unknown): ReelScript | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const rawScenes = Array.isArray(d.scenes) ? d.scenes : [];
  const scenes: ReelScriptScene[] = rawScenes
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      scene: asString(s.scene),
      voiceover: asString(s.voiceover),
      visual: asString(s.visual),
      on_screen_text: asString(s.on_screen_text),
      notes: asString(s.notes),
    }));
  return {
    title: asString(d.title),
    project_id: asString(d.project_id) || undefined,
    project_name: asString(d.project_name) || undefined,
    hook: asString(d.hook),
    angle: asString(d.angle) || undefined,
    cta: asString(d.cta) || undefined,
    alt_hooks: asStringArray(d.alt_hooks),
    reel_idea: asString(d.reel_idea) || undefined,
    objective: asString(d.objective) || undefined,
    target_audience: asString(d.target_audience) || undefined,
    key_message: asString(d.key_message) || undefined,
    scenes,
  };
}

/**
 * Map a structured reel script onto `reel_scripts` field slugs for use as the
 * `prefill` of a new-record `RecordFormModal`. The `project` lookup gets the
 * all_projects record id (only when present); the scenes become `script_table`
 * rows keyed by column slug. Defaults `status` / `approval_status` so the form
 * opens in a sensible initial state. Nothing is saved here — the user reviews
 * and clicks Save.
 */
export function reelScriptToPrefill(rs: ReelScript): Record<string, unknown> {
  const prefill: Record<string, unknown> = {
    title: rs.title ?? '',
    status: 'draft',
    reel_idea: rs.reel_idea ?? '',
    objective: rs.objective ?? '',
    target_audience: rs.target_audience ?? '',
    key_message: rs.key_message ?? '',
    hook: rs.hook ?? '',
    angle: rs.angle ?? '',
    cta: rs.cta ?? '',
    alt_hooks: (rs.alt_hooks ?? []).join('\n'),
    script_table: (rs.scenes ?? []).map((s) => ({
      scene: s.scene ?? '',
      voiceover: s.voiceover ?? '',
      visual: s.visual ?? '',
      on_screen_text: s.on_screen_text ?? '',
      notes: s.notes ?? '',
    })),
    approval_status: 'pending',
  };
  if (rs.project_id) prefill.project = rs.project_id;
  return prefill;
}

/**
 * Compact text rendering of a script. Appended to the assistant message's
 * `content` ONLY when rebuilding the API message history, so the model stays
 * grounded in what it already produced when the user asks for a revision — the
 * UI still shows the clean table (the structured payload), never this text.
 */
export function serializeReelScriptForModel(rs: ReelScript): string {
  const lines: string[] = [];
  lines.push(`[Reel script: ${rs.title || '(untitled)'}]`);
  if (rs.project_name || rs.project_id) lines.push(`Project: ${rs.project_name || rs.project_id}`);
  if (rs.hook) lines.push(`Hook: ${rs.hook}`);
  if (rs.angle) lines.push(`Angle/Trigger: ${rs.angle}`);
  if (rs.scenes.length) {
    lines.push('Scenes:');
    rs.scenes.forEach((s, i) => {
      const parts = [`${i + 1}. ${s.scene || ''}`.trim()];
      if (s.voiceover) parts.push(`VO: ${s.voiceover}`);
      if (s.visual) parts.push(`Visual: ${s.visual}`);
      if (s.on_screen_text) parts.push(`On-screen: ${s.on_screen_text}`);
      if (s.notes) parts.push(`Note: ${s.notes}`);
      lines.push(`  ${parts.join(' | ')}`);
    });
  }
  if (rs.cta) lines.push(`CTA: ${rs.cta}`);
  if (rs.alt_hooks && rs.alt_hooks.length) lines.push(`Alt hooks: ${rs.alt_hooks.join(' / ')}`);
  return lines.join('\n');
}
