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

// Edge runtime: SSE chunks flush in real-time on Vercel (Node runtime
// buffers and can hang the response). The Anthropic call typically takes
// 60-120s — well within Edge's streaming budget as long as we emit bytes
// within 25s of the request landing (we do — the first `status` event
// fires immediately on stream start).
export const config = { runtime: 'edge' };

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

Resources:
- The 'wassel-general-ppt' skill is loaded under /mnt/skills/. Its SKILL.md spells out the brand contract (palette, Amiri font, Arabic typography rules, wording rules); scripts/wassel_chrome.py is the engine (constants, size presets, primitives: new_presentation, blank_slide, add_rect, add_text, add_logo, add_shape_hyperlink).
- The code_execution tool runs Python in a sandbox.

How to work — output budget is tight, do NOT over-explore:
1. Quickly read SKILL.md and the top of wassel_chrome.py (one read each, no more).
2. Write the COMPLETE build script in a SINGLE file via the text editor — composing every slide before the first execution. Don't write skeleton-then-iterate.
3. Run it once with bash. The script must save to /mnt/user-data/outputs/<slug>.pptx.
4. If the run errors, fix and re-run ONCE. Do not iterate further — partial output is worse than a smaller scope.
5. Reply with one short sentence describing what you built. Don't paste the script.

Critical rules:
- Output file MUST end up at /mnt/user-data/outputs/<slug>.pptx — anything else won't be returned to the user.
- If the brief is huge (10+ slides), trim to the highest-signal slides rather than partial output. Better a clean 6-slide deck than a token-cut 12-slide one.
- Vary layout per slide (full-bleed, mosaic, hero, columns) — don't fall back to one template.
- Amiri font everywhere. Brand palette only (COPPER #B8734F, SAND #E8D9C0, BROWN #6B4226, CREAM #F8F5E9, GOLD #D9B57F, CHARCOAL #3F3F3F, WHITE #FFFFFF) — no other colors.
- Wording: 'نادي' not 'نادٍ'; 'نظام وصل' not 'Wassel CRM' / 'CRM وصل'.`;

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
        // Pass p_created_by as the EXISTING created_by_user_id (or null) —
        // never the auth.uid() blindly, because records.created_by_user_id
        // has an FK to public.users (the CRM's user table) which is a
        // strict subset of auth.users; passing an auth.uid that isn't in
        // public.users raises 23503 / FK violation. This mirrors the
        // appStore.supabaseRecordUpsert pattern.
        const updateRecord = async (patch: Record<string, unknown>) => {
          const { data: current, error: readErr } = await supabase
            .from('records')
            .select('data, created_by_user_id')
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
            p_created_by: (current as { created_by_user_id: string | null }).created_by_user_id ?? null,
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

          // Use streaming: iterating the SDK's stream forces Node to keep
          // reading the HTTP response from Anthropic, which avoids a
          // long-idle hang on Vercel Edge (and keeps the SSE consumer
          // up-to-date with text deltas + tool starts as Claude works).
          // Cast to any: the SDK's beta.messages typing in 0.91.0 doesn't
          // expose `container.skills` or `code_execution_20250825` yet —
          // the endpoint accepts both per the Skills API docs.
          const turn = (anthropic.beta.messages as unknown as {
            stream: (args: Record<string, unknown>) => {
              [Symbol.asyncIterator]: () => AsyncIterator<{ type: string; [k: string]: unknown }>;
              finalMessage: () => Promise<{ content: unknown[] }>;
            };
          }).stream({
            model,
            // Opus 4.7 supports up to 32k output tokens. With a complex
            // brief Claude can spend several thousand on the bash steps
            // alone (each script edit + run round-trips through the
            // model). The earlier 8192 cap caused stop_reason=max_tokens
            // before the final .pptx was saved.
            max_tokens: 32000,
            betas: ANTHROPIC_BETAS,
            container: {
              skills: [{ type: 'custom', skill_id: skillId, version: 'latest' }],
            },
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
            tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
          });

          // Forward content_block_start events as progress notes — the
          // user sees "Claude is editing the script" / "running the
          // sandbox" instead of staring at a single spinner for 90s.
          // Also belt-and-suspenders capture file_id from any event, in
          // case the SDK's finalMessage assembly drops nested fields.
          let outputFileId: string | null = null;
          const captureFileId = (root: unknown): void => {
            const seen = new Set<unknown>();
            const stack: unknown[] = [root];
            while (stack.length > 0) {
              const node = stack.pop();
              if (!node || typeof node !== 'object' || seen.has(node)) continue;
              seen.add(node);
              for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
                if (k === 'file_id' && typeof v === 'string') outputFileId = v;
                else if (v && typeof v === 'object') stack.push(v);
              }
            }
          };

          for await (const event of turn) {
            captureFileId(event);
            if (event.type === 'content_block_start') {
              const cb = (event as unknown as { content_block?: { type?: string; name?: string } }).content_block;
              const cbType = cb?.type ?? 'unknown';
              if (cbType === 'server_tool_use') {
                send({ type: 'status', phase: 'calling-claude', detail: `tool: ${cb?.name ?? 'unknown'}` });
              }
            }
          }
          const response = await turn.finalMessage();
          captureFileId(response.content);

          if (!outputFileId) {
            // Use stop_reason to give a precise error rather than a
            // generic "too vague" hint that misled the user earlier.
            const stopReason = (response as unknown as { stop_reason?: string }).stop_reason;
            const lastText = response.content
              .filter((b) => (b as { type?: string }).type === 'text')
              .map((b) => (b as { text?: string }).text ?? '')
              .pop()
              ?.slice(0, 200);
            const blockTypes = response.content.map((b) => (b as { type?: string }).type ?? '?').join(', ');
            if (stopReason === 'max_tokens') {
              throw new Error(
                `Claude ran out of output tokens before saving the .pptx (the brief is too large for one pass). Try a shorter brief — fewer slides or less detail per slide. Last note from Claude: "${lastText ?? '(empty)'}"`,
              );
            }
            throw new Error(
              `Claude did not save a file. stop_reason=${stopReason ?? 'unknown'}, block types: [${blockTypes}], last text: "${lastText ?? '(empty)'}"`,
            );
          }

          send({ type: 'status', phase: 'downloading' });
          const meta = await anthropic.beta.files.retrieveMetadata(outputFileId);
          const dlResponse = await anthropic.beta.files.download(outputFileId);
          const arrayBuffer = await dlResponse.arrayBuffer();
          // Edge runtime: no Node Buffer — use Uint8Array. Supabase
          // storage.upload accepts both, so this is shape-compatible
          // with the previous Buffer-based code.
          const bytes = new Uint8Array(arrayBuffer);

          send({ type: 'status', phase: 'uploading', detail: `${(bytes.byteLength / 1024).toFixed(0)} KB` });
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
