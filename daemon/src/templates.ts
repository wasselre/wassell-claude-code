import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import chokidar from 'chokidar';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DaemonEnv } from './env.ts';
import type { TemplateManifest } from './types.ts';

const MANIFEST_FILENAME = 'template.json';

/** Shape written to the presentation_templates table. Matches the DB columns;
 *  Postgres fills `created_at` / `updated_at` defaults on first insert. */
interface TemplateRow {
  id: string;
  slug: string;
  label_ar: string;
  label_en: string;
  description_ar: string | null;
  description_en: string | null;
  command: string;
  icon: string;
  input_schema: TemplateManifest['inputs'];
  record_binding: TemplateManifest['record_binding'] | null;
  estimated_duration_seconds: number | null;
  is_available: boolean;
  manifest_path: string;
  manifest_synced_at: string;
}

/** Best-effort manifest validation. Throws a descriptive error on problems so
 *  the daemon log explains exactly what's wrong with a given template. */
function validateManifest(raw: unknown, path: string): TemplateManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: manifest root must be an object`);
  }
  const m = raw as Record<string, unknown>;
  const req = (k: string): string => {
    const v = m[k];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`${path}: required string field "${k}" is missing or empty`);
    }
    return v;
  };

  req('id');
  req('slug');
  req('label_ar');
  req('label_en');
  req('command');

  if (!Array.isArray(m.inputs)) {
    throw new Error(`${path}: "inputs" must be an array`);
  }
  if (m.record_binding !== undefined) {
    const rb = m.record_binding as Record<string, unknown> | null;
    if (rb !== null) {
      if (typeof rb !== 'object' || Array.isArray(rb)) {
        throw new Error(`${path}: "record_binding" must be an object, null, or omitted`);
      }
      if (typeof rb.model_slug !== 'string' || typeof rb.optional !== 'boolean') {
        throw new Error(`${path}: "record_binding" must have string model_slug and boolean optional`);
      }
    }
  }

  return raw as TemplateManifest;
}

function manifestToRow(manifest: TemplateManifest, manifestPath: string): TemplateRow {
  return {
    id: manifest.id,
    slug: manifest.slug,
    label_ar: manifest.label_ar,
    label_en: manifest.label_en,
    description_ar: manifest.description_ar ?? null,
    description_en: manifest.description_en ?? null,
    command: manifest.command,
    icon: manifest.icon ?? 'file-text',
    input_schema: manifest.inputs,
    record_binding: manifest.record_binding ?? null,
    estimated_duration_seconds: manifest.estimated_duration_seconds ?? null,
    is_available: true,
    manifest_path: manifestPath,
    manifest_synced_at: new Date().toISOString(),
  };
}

async function readManifestFromFile(manifestPath: string): Promise<TemplateManifest> {
  const raw = await readFile(manifestPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${manifestPath}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateManifest(parsed, manifestPath);
}

/**
 * Read every `<slug>/template.json` under `templatesDir`, upsert each as a
 * row in `presentation_templates`, and flip any DB rows whose manifest has
 * disappeared to `is_available = false`. Returns per-slug stats for logging.
 */
export async function syncTemplateManifests(
  supabase: SupabaseClient,
  env: DaemonEnv,
): Promise<{ synced: string[]; invalid: Array<{ path: string; error: string }>; disabled: string[] }> {
  const synced: string[] = [];
  const invalid: Array<{ path: string; error: string }> = [];

  let subfolders: string[];
  try {
    const entries = await readdir(env.templatesDir, { withFileTypes: true });
    subfolders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Templates dir doesn't exist — treat as empty. The user hasn't authored
      // any templates yet, or TEMPLATES_DIR is misconfigured. Log in the caller.
      return { synced: [], invalid: [], disabled: [] };
    }
    throw err;
  }

  const rows: TemplateRow[] = [];
  for (const slug of subfolders) {
    const manifestPath = join(env.templatesDir, slug, MANIFEST_FILENAME);
    try {
      await stat(manifestPath);
    } catch {
      // Subfolder without a template.json — skip silently. The user may still
      // be authoring the template; no point logging every such folder.
      continue;
    }
    try {
      const manifest = await readManifestFromFile(manifestPath);
      if (manifest.slug !== slug) {
        // Warn but still sync — the manifest's slug wins (folder name is just
        // for human organization). This mismatch commonly happens after a
        // folder rename; forcing symmetry would be annoying.
        console.warn(
          `[templates] folder "${slug}" holds a manifest with slug "${manifest.slug}" — syncing by manifest slug`,
        );
      }
      rows.push(manifestToRow(manifest, manifestPath));
      synced.push(manifest.slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      invalid.push({ path: manifestPath, error: msg });
      console.error(`[templates] invalid manifest: ${msg}`);
    }
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from('presentation_templates')
      .upsert(rows, { onConflict: 'id' });
    if (error) {
      throw new Error(`[templates] upsert failed: ${error.message}`);
    }
  }

  // Flip templates whose manifests are gone. Only touch daemon-authored rows
  // (manifest_path IS NOT NULL) to leave seeded rows alone if they're still
  // useful — although the daemon is expected to own the table after Phase 2,
  // this gives us a graceful deseed path.
  const activeSlugs = new Set(synced);
  const { data: existing } = await supabase
    .from('presentation_templates')
    .select('slug, manifest_path')
    .not('manifest_path', 'is', null);
  const disabled: string[] = [];
  for (const row of existing ?? []) {
    if (!activeSlugs.has(row.slug as string)) {
      disabled.push(row.slug as string);
      await supabase
        .from('presentation_templates')
        .update({ is_available: false, updated_at: new Date().toISOString() })
        .eq('slug', row.slug as string);
    }
  }

  return { synced, invalid, disabled };
}

/**
 * Watch the templates directory and resync on any .json change. Chokidar is
 * wrapped in a short debounce so a burst of file-system events (editors
 * often fire multiple writes per save) coalesces into a single sync.
 */
export function watchTemplates(
  supabase: SupabaseClient,
  env: DaemonEnv,
  onResync: (result: Awaited<ReturnType<typeof syncTemplateManifests>>) => void,
): () => Promise<void> {
  const watcher = chokidar.watch(env.templatesDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 3,
  });

  let timer: NodeJS.Timeout | null = null;
  const trigger = (reason: string): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try {
        const result = await syncTemplateManifests(supabase, env);
        console.log(
          `[templates] resync (${reason}): synced=${result.synced.length} invalid=${result.invalid.length} disabled=${result.disabled.length}`,
        );
        onResync(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[templates] resync failed: ${msg}`);
      }
    }, 500);
  };

  watcher.on('add', (p) => trigger(`add ${p}`));
  watcher.on('change', (p) => trigger(`change ${p}`));
  watcher.on('unlink', (p) => trigger(`unlink ${p}`));
  watcher.on('addDir', (p) => trigger(`addDir ${p}`));
  watcher.on('unlinkDir', (p) => trigger(`unlinkDir ${p}`));
  watcher.on('error', (err) => {
    console.error(`[templates] watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });

  return async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    await watcher.close();
  };
}
