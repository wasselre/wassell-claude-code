/**
 * POST /api/generate-deck
 *
 * Generates a Wassel-branded .pptx file by calling Claude with the
 * `wassel-general-ppt` skill (registered in Anthropic Skills API) and the
 * code_execution tool. Downloads the resulting file via the Files API,
 * uploads it to the private `wassel-decks` Supabase Storage bucket at
 *   {auth.uid()}/{record_id}/{filename}
 * and signs a 7-day URL for the browser.
 *
 * Request body:
 *   {
 *     recordId: string,                                  // a `decks` record already created by the client
 *     brief:    string,                                  // the deck description
 *     language?: 'ar' | 'en' | 'mixed',                  // hint for Claude (default 'ar')
 *     model?:    'claude-opus-4-7' | 'claude-sonnet-4-6' // default opus
 *   }
 *
 * SSE events:
 *   { type: 'status', phase: 'calling-claude' | 'downloading' | 'uploading' | 'finalizing', detail?: string }
 *   { type: 'done',   file_url: string, file_path: string, filename: string }
 *   { type: 'error',  message: string }
 *
 * The `decks` record is updated in-band:
 *   - On entry → status='generating', model_used + language stamped, error_message cleared
 *   - On success → status='ready', file_url, file_path, filename, anthropic_file_id set
 *   - On any failure → status='failed', error_message set
 *
 * Auth: Supabase JWT in `Authorization: Bearer …`. Storage upload + record
 * write happen as the user (not service role) so RLS gates them.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError } from './_lib/auth.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

interface GenerateDeckRequestBody {
  recordId: string;
  brief: string;
  language?: 'ar' | 'en' | 'mixed';
  model?: 'claude-opus-4-7' | 'claude-sonnet-4-6';
}

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const STORAGE_BUCKET = 'wassel-decks';
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const ANTHROPIC_BETAS = [
  'skills-2025-10-02',
  'code-execution-2025-08-25',
  'files-api-2025-04-14',
];

const SYSTEM_PROMPT = `You are building a Wassel Real Estate (وصل العقارية) brand-compliant PowerPoint (.pptx) per the user's brief.

Resources available to you:
- The 'wassel-general-ppt' skill is loaded — its SKILL.md spells out the brand contract (palette, Amiri font, Arabic typography rules, wording rules) and the engine API. Read it first.
- The skill's scripts/wassel_chrome.py is the engine: brand constants, size presets, and the primitives (new_presentation, blank_slide, add_rect, add_text, add_logo, add_shape_hyperlink, clean_text). Compose every slide from these primitives.
- The code_execution tool runs Python in a sandbox where the skill files are auto-mounted at /mnt/skills/.

What to do:
1. Read the brief carefully. Pick a canvas size that fits the purpose (don't default to 16:9 reflexively).
2. Compose a custom Python build script that produces a deck whose layout, sectioning, and visual approach are specific to the brief — do NOT fall back to a generic template. Variety across decks is a hard requirement.
3. Save the output to /mnt/user-data/outputs/<descriptive_slug>.pptx.
4. Reply with one short sentence summarizing what you built (e.g. "Built a 7-slide A4-portrait capability deck with mosaic project grid"). Don't paste the script — the file is what matters.

Hard rules (the engine enforces some, the rest are on you):
- Amiri font on every text element. The engine sets it on all three OOXML font slots.
- Brand palette only (COPPER #B8734F, SAND #E8D9C0, BROWN #6B4226, CREAM #F8F5E9, GOLD #D9B57F, CHARCOAL #3F3F3F, WHITE #FFFFFF). No off-palette fill or stroke.
- Arabic typography: digits → Arabic-Indic, decimals → ٫, thousands → ٬, em-dashes wrapped with RLM in Arabic context (auto via add_text).
- Wording: 'نادي' not 'نادٍ'. 'نظام وصل' not 'Wassel CRM' / 'CRM وصل'. Latin codes inside Arabic paragraphs wrapped with LRM marks.
- File MUST land at /mnt/user-data/outputs/. Anything else won't be picked up.`;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: GenerateDeckRequestBody;
    try {
      body = (await req.json()) as GenerateDeckRequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.recordId || typeof body.recordId !== 'string') {
      return jsonError(400, 'recordId must be a string');
    }
    if (!body.brief || typeof body.brief !== 'string' || body.brief.trim().length < 10) {
      return jsonError(400, 'brief must be at least 10 characters');
    }
    const model = body.model ?? 'claude-opus-4-7';
    const language = body.language ?? 'ar';
    if (!['claude-opus-4-7', 'claude-sonnet-4-6'].includes(model)) {
      return jsonError(400, `unsupported model: ${model}`);
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');
    const skillId = process.env.ANTHROPIC_WASSEL_SKILL_ID;
    if (!skillId) return jsonError(500, 'ANTHROPIC_WASSEL_SKILL_ID is not configured');

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) return jsonError(500, 'Supabase env vars missing');

    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    // One-shot lookup of the decks model id. Seed UUIDs are regenerated per
    // module load, so the value in the database is the only source of truth.
    const { data: modelRow, error: modelErr } = await supabase
      .from('models')
      .select('id')
      .eq('name', 'decks')
      .single();
    if (modelErr || !modelRow) {
      return jsonError(500, `decks model not found: ${modelErr?.message ?? 'unknown'}`);
    }
    const decksModelId = modelRow.id as string;

    const anthropic = new Anthropic({ apiKey });
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        // Read-then-write helper that preserves any other fields on the record.
        // Pass p_expected_version: null — the endpoint is the only writer
        // during a generation, so the version-conflict check is unnecessary
        // and skipping it lets us recover from a partial earlier failure.
        const updateRecord = async (patch: Record<string, unknown>) => {
          const { data: current, error: readErr } = await supabase
            .from('records')
            .select('data')
            .eq('id', body.recordId)
            .single();
          if (readErr || !current) {
            throw new Error(`failed to read decks record: ${readErr?.message ?? 'not found'}`);
          }
          const newData = { ...(current.data as Record<string, unknown>), ...patch };
          const { error: saveErr } = await supabase.rpc('record_save', {
            p_model_id: decksModelId,
            p_id: body.recordId,
            p_data: newData,
            p_created_by: user.userId,
            p_expected_version: null,
          });
          if (saveErr) {
            throw new Error(`record_save failed: ${saveErr.message}`);
          }
        };

        try {
          send({ type: 'status', phase: 'calling-claude', detail: model });
          await updateRecord({
            status: 'generating',
            model_used: model,
            language,
            error_message: null,
          });

          const userPrompt =
            `Brief:\n${body.brief.trim()}\n\n` +
            `Language hint: ${
              language === 'ar'
                ? 'Arabic preferred — default the deck to Arabic RTL with Amiri.'
                : language === 'en'
                  ? 'English preferred — Latin layout with Amiri throughout.'
                  : 'Mixed — choose per-slide based on what the content implies.'
            }`;

          // Cast to any: the SDK's beta.messages typing in 0.91.0 doesn't
          // yet expose `container.skills` or `code_execution_20250825`, but
          // the endpoint accepts both — confirmed in the Skills API docs
          // (https://platform.claude.com/docs/en/build-with-claude/skills-guide).
          const response = await (anthropic.beta.messages as unknown as {
            create: (args: Record<string, unknown>) => Promise<{ content: unknown[] }>;
          }).create({
            model,
            max_tokens: 8192,
            betas: ANTHROPIC_BETAS,
            container: {
              skills: [{ type: 'custom', skill_id: skillId, version: 'latest' }],
            },
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
            tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
          });

          // Walk the response for a code_execution_result block carrying a
          // file_id. Claude can emit multiple — pick the LAST one so a file
          // re-saved in a later iteration wins over an earlier draft.
          let outputFileId: string | null = null;
          for (const blockUntyped of response.content) {
            const block = blockUntyped as { type?: string; content?: unknown };
            if (block.type !== 'code_execution_result') continue;
            const inner = block.content;
            if (!Array.isArray(inner)) continue;
            for (const itemUntyped of inner) {
              const item = itemUntyped as { file_id?: string };
              if (item && typeof item.file_id === 'string') {
                outputFileId = item.file_id;
              }
            }
          }

          if (!outputFileId) {
            throw new Error(
              'Claude did not produce an output file. The brief may be too vague — try describing the deck more concretely (purpose, audience, slide count, language).',
            );
          }

          send({ type: 'status', phase: 'downloading' });
          const meta = await anthropic.beta.files.retrieveMetadata(outputFileId);
          const dlResponse = await anthropic.beta.files.download(outputFileId);
          const arrayBuffer = await dlResponse.arrayBuffer();
          const bytes = Buffer.from(arrayBuffer);

          send({ type: 'status', phase: 'uploading', detail: `${(bytes.length / 1024).toFixed(0)} KB` });
          const filename = (meta.filename ?? `wassel-deck-${Date.now()}.pptx`).replace(/[^\w\-. ]/g, '_');
          const path = `${user.userId}/${body.recordId}/${filename}`;

          const { error: uploadErr } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(path, bytes, {
              contentType: PPTX_MIME,
              upsert: true,
            });
          if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

          send({ type: 'status', phase: 'finalizing' });
          const { data: signed, error: signErr } = await supabase.storage
            .from(STORAGE_BUCKET)
            .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
          if (signErr || !signed) {
            throw new Error(`signed URL creation failed: ${signErr?.message ?? 'unknown'}`);
          }

          await updateRecord({
            status: 'ready',
            file_url: signed.signedUrl,
            file_path: path,
            filename,
            anthropic_file_id: outputFileId,
            error_message: null,
          });

          send({
            type: 'done',
            file_url: signed.signedUrl,
            file_path: path,
            filename,
          });
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[generate-deck] failed', message, err);
          // Best-effort: mark the record as failed so the UI can show an
          // error state on reload. If this itself fails, surface BOTH
          // problems to the SSE consumer rather than silently dropping one.
          let combined = message;
          try {
            await updateRecord({ status: 'failed', error_message: message });
          } catch (innerErr) {
            const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr);
            console.error('[generate-deck] also failed to mark record as failed:', innerMsg);
            combined = `${message} — and updating the record also failed: ${innerMsg}`;
          }
          try {
            send({ type: 'error', message: combined });
          } catch {
            // Controller already closed — nothing to do.
          }
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
