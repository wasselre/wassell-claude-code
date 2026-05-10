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

// Deliberately minimal — earlier versions stacked an aesthetics + workflow
// prompt on top of the skill, which made Claude RUSH the design pass
// ("compose in one shot, no iteration"). The skill's own SKILL.md is the
// source of truth for HOW to design a Wassel deck. Let it drive: just
// point Claude at the skill, anchor the save path, and stay out of the
// way. This matches how /wassel-general-ppt behaves in Claude Code.
//
// One pragmatic addition: ask Claude to use a UNIQUE timestamped filename
// per save, never overwrite. We've observed Anthropic's sandbox file
// capture lose track when the same path is overwritten across iterations
// — it apparently caches the file_id of the first write and silently
// drops subsequent overwrites from the response. Unique names sidestep that.
// File-return strategy: empirically Anthropic's automatic file_id capture
// from Skills + code_execution is unreliable for this skill — verified
// runs where the file lands on disk (rc=0, ls confirmed, 198 KB) but
// Files API has no entry. The sandbox has no outbound internet (DNS
// blocked) so we can't curl directly to Supabase. The reliable channel
// is bash stdout: we ask Claude to base64 the saved file between two
// sentinel markers in the FINAL bash call, and the endpoint extracts
// bytes from the stdout stream. Tested with 200KB+ payloads — stdout
// returns all 266k bytes intact.
const B64_MARKER_START = '===WASSEL_DECK_B64_START===';
const B64_MARKER_END = '===WASSEL_DECK_B64_END===';
const SYSTEM_PROMPT = `Build a brand-compliant PowerPoint (.pptx) for Wassel Real Estate (وصل العقارية) per the user's brief.

The 'wassel-general-ppt' skill is loaded under /mnt/skills/. Read its SKILL.md and follow the workflow it describes — design each slide fresh, vary the layout, read the engine docstring. Use the engine at scripts/wassel_chrome.py.

Save the finished file to /mnt/user-data/outputs/wassel-deck-<unix_timestamp_ms>.pptx.

REQUIRED — without this the file cannot be returned to the user:
After saving the deck, run ONE FINAL bash command that prints the file as base64 between two sentinel lines, EXACTLY like this (substitute your actual filename for <FILE>):

    echo "${B64_MARKER_START}"
    base64 -w0 /mnt/user-data/outputs/<FILE>
    echo
    echo "${B64_MARKER_END}"

Do NOT skip this step. Do NOT modify the marker strings. Use ONE single bash call so all base64 lands in the same stdout. The receiver scans bash stdouts for these exact markers and decodes the bytes between them.

Reply with one short sentence describing what you built.`;

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
    // Default to Sonnet 4.6 — Opus 4.7 currently has a known issue with
    // Skills + code_execution where the .pptx is written to the sandbox
    // (script returns 0, prints the save path) but Anthropic does NOT
    // surface a file_id, so the endpoint can't download the result. Verified
    // by side-by-side runs with the same brief: Sonnet 4.6 returns file_id,
    // Opus 4.7 returns content: [] on every bash result. Until Anthropic
    // fixes this we keep Opus selectable for future use but won't make it
    // the default.
    const model = body.model ?? 'claude-sonnet-4-6';
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

          // Track request-start time so we can fall back to "list Files
          // API for newly-created .pptx during this request" if the
          // streaming response doesn't surface file_id (some model +
          // skill + code_execution combos drop the file_id from the
          // response even though the file lands in Files API).
          const requestStartedAtMs = Date.now() - 5000; // 5s slack
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

          // PRIMARY return path: walk bash stdouts for the base64 sentinel
          // markers and extract bytes directly. This sidesteps Anthropic's
          // unreliable Files API capture entirely. If markers are present
          // and decode cleanly, we skip the Files API path below.
          let extractedBytes: Uint8Array | null = null;
          let extractedFilename: string | null = null;
          for (const block of response.content) {
            const b = block as { type?: string; content?: unknown };
            if (b.type !== 'bash_code_execution_tool_result') continue;
            const stdout = ((b.content as { stdout?: string } | undefined)?.stdout) ?? '';
            const start = stdout.indexOf(B64_MARKER_START);
            const end = stdout.indexOf(B64_MARKER_END);
            if (start === -1 || end === -1 || end <= start) continue;
            const lineEnd = stdout.indexOf('\n', start);
            if (lineEnd === -1) continue;
            const b64 = stdout.slice(lineEnd + 1, end).replace(/\s+/g, '');
            if (b64.length < 100) continue;
            try {
              const binStr = atob(b64);
              const out = new Uint8Array(binStr.length);
              for (let i = 0; i < binStr.length; i++) out[i] = binStr.charCodeAt(i);
              // Sanity-check: .pptx files start with PK\x03\x04 (zip magic)
              if (out.length >= 4 && out[0] === 0x50 && out[1] === 0x4b && out[2] === 0x03 && out[3] === 0x04) {
                extractedBytes = out;
                console.log(`[generate-deck] extracted ${out.byteLength} bytes from bash stdout via base64 markers`);
              } else {
                console.warn(`[generate-deck] base64 decoded ${out.byteLength} bytes but missing PK zip magic — discarding`);
              }
              break;
            } catch (e) {
              console.error('[generate-deck] base64 decode failed:', e);
            }
          }
          // Recover the filename Claude used (matches our prompt's pattern).
          if (extractedBytes) {
            for (const block of response.content) {
              const b = block as { type?: string; content?: unknown };
              const stdout = ((b.content as { stdout?: string } | undefined)?.stdout) ?? '';
              const m = stdout.match(/wassel-deck-\d+\.pptx/);
              if (m) { extractedFilename = m[0]; break; }
            }
          }

          if (!outputFileId && !extractedBytes) {
            // Fallback: scan Files API for any .pptx created during this
            // request window. Anthropic sometimes doesn't surface file_id
            // in the response even when the file landed in Files API.
            // We poll up to 3 times with a 2s gap between attempts — Files
            // API has indexing latency and the file may appear shortly
            // after the streaming response closes.
            console.log('[generate-deck] no file_id in response, scanning Files API');
            const scanFilesApi = async () => {
              const candidates: Array<{ id: string; filename: string; created_at: string }> = [];
              const listIter = (anthropic.beta.files as unknown as {
                list: (args: Record<string, unknown>) => AsyncIterable<{
                  id: string;
                  filename?: string;
                  created_at?: string;
                  size_bytes?: number;
                }>;
              }).list({ limit: 30 });
              for await (const f of listIter) {
                const ts = f.created_at ? new Date(f.created_at).getTime() : 0;
                if (ts >= requestStartedAtMs && (f.filename ?? '').endsWith('.pptx')) {
                  candidates.push({
                    id: f.id,
                    filename: f.filename ?? `deck-${Date.now()}.pptx`,
                    created_at: f.created_at ?? '',
                  });
                }
              }
              candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
              return candidates;
            };
            try {
              for (let attempt = 0; attempt < 3 && !outputFileId; attempt++) {
                if (attempt > 0) {
                  console.log(`[generate-deck] fallback retry ${attempt + 1}/3 after 2s`);
                  await new Promise((r) => setTimeout(r, 2000));
                }
                const candidates = await scanFilesApi();
                console.log(`[generate-deck] fallback attempt ${attempt + 1}: ${candidates.length} candidates after threshold ${requestStartedAtMs}`);
                if (candidates.length > 0 && candidates[0]) {
                  outputFileId = candidates[0].id;
                  console.log(`[generate-deck] fallback recovered file_id=${outputFileId} filename=${candidates[0].filename}`);
                  send({ type: 'status', phase: 'calling-claude', detail: 'recovered output via Files API fallback' });
                  break;
                }
              }
            } catch (listErr) {
              console.error('[generate-deck] Files API list fallback failed:', listErr);
            }
          }

          if (!outputFileId && !extractedBytes) {
            // Still nothing. Surface the most actionable error — full
            // last text (no truncation), last bash stdout (so we can
            // see the path Claude used and decide whether the file
            // was actually written), and stop_reason.
            const stopReason = (response as unknown as { stop_reason?: string }).stop_reason;
            const lastText = response.content
              .filter((b) => (b as { type?: string }).type === 'text')
              .map((b) => (b as { text?: string }).text ?? '')
              .pop();
            // Walk for the LAST bash result's stdout/stderr/return_code.
            let lastBash: { stdout?: string; stderr?: string; return_code?: number } | null = null;
            for (const b of response.content) {
              const bb = b as { type?: string; content?: { stdout?: string; stderr?: string; return_code?: number } | unknown };
              if (bb.type === 'bash_code_execution_tool_result' && bb.content && typeof bb.content === 'object') {
                lastBash = bb.content as { stdout?: string; stderr?: string; return_code?: number };
              }
            }
            if (stopReason === 'max_tokens') {
              throw new Error(
                `Claude ran out of output tokens before saving the .pptx. Try a shorter brief.\n\nLast note: ${lastText ?? '(empty)'}`,
              );
            }
            const lines: string[] = [
              `Claude finished without surfacing a file_id (Anthropic-side intermittent issue with Skills + code_execution).`,
              ``,
              `stop_reason: ${stopReason ?? 'unknown'}`,
              ``,
              `Claude's final note:`,
              lastText ?? '(empty)',
            ];
            if (lastBash) {
              lines.push(``, `Last bash result: rc=${lastBash.return_code ?? '?'}`);
              if (lastBash.stdout) lines.push(`stdout: ${lastBash.stdout.slice(0, 600)}`);
              if (lastBash.stderr) lines.push(`stderr: ${lastBash.stderr.slice(0, 600)}`);
            }
            lines.push(``, `Try clicking "إعادة المحاولة" again — this is intermittent and usually works on the second or third try.`);
            throw new Error(lines.join('\n'));
          }

          // Source the bytes — base64-from-stdout (primary) wins; otherwise
          // fall back to Anthropic Files API download.
          let bytes: Uint8Array;
          let filename: string;
          if (extractedBytes) {
            bytes = extractedBytes;
            filename = (extractedFilename ?? `wassel-deck-${Date.now()}.pptx`).replace(/[^\w\-. ]/g, '_');
            send({ type: 'status', phase: 'uploading', detail: `${(bytes.byteLength / 1024).toFixed(0)} KB (via base64 stream)` });
          } else if (outputFileId) {
            send({ type: 'status', phase: 'downloading' });
            const meta = await anthropic.beta.files.retrieveMetadata(outputFileId);
            const dlResponse = await anthropic.beta.files.download(outputFileId);
            const arrayBuffer = await dlResponse.arrayBuffer();
            bytes = new Uint8Array(arrayBuffer);
            filename = (meta.filename ?? `wassel-deck-${Date.now()}.pptx`).replace(/[^\w\-. ]/g, '_');
            send({ type: 'status', phase: 'uploading', detail: `${(bytes.byteLength / 1024).toFixed(0)} KB` });
          } else {
            throw new Error('internal: reached upload branch without bytes or file_id');
          }
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
